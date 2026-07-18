import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseName = `CodexBrowser-${version}-win-x64`;
const runtimeRoot = path.join(projectRoot, ".runtime");
const stageRoot = path.join(runtimeRoot, "release-stage");
const appRoot = path.join(stageRoot, releaseName);
const releaseRoot = path.join(projectRoot, "release");
const archivePath = path.join(releaseRoot, `${releaseName}.zip`);
const checksumPath = `${archivePath}.sha256`;

function assertWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing release operation outside the bounded staging directory: ${candidate}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
}

async function copy(relativePath) {
  const source = path.join(projectRoot, relativePath);
  const destination = path.join(appRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

assertWithin(stageRoot, runtimeRoot);
await rm(stageRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });

for (const file of ["package.json", "package-lock.json"]) await copy(file);

run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm ci --omit=dev --ignore-scripts --no-audit --no-fund"], {
  cwd: appRoot,
});

for (const file of [
  "dist",
  "README.md",
  "start-local.cmd",
  "scripts/start-desktop.cmd",
  "scripts/start-runtime.mjs",
  "docs/release/RELEASE_NOTES_1.0.0.md",
]) await copy(file);

const electronSource = path.join(projectRoot, "node_modules", "electron", "dist");
const electronDestination = path.join(appRoot, "node_modules", "electron", "dist");
await mkdir(path.dirname(electronDestination), { recursive: true });
await cp(electronSource, electronDestination, { recursive: true, force: true });
await writeFile(
  path.join(appRoot, "node_modules", "electron", "package.json"),
  `${JSON.stringify({ name: "electron", version: packageJson.devDependencies.electron }, null, 2)}\n`,
  "utf8",
);

const manifest = {
  product: "Codex Browser",
  version,
  platform: "win32",
  architecture: "x64",
  defaultRuntime: "external-edge",
  minimumNodeVersion: "22.13.0",
  minimumEdgeMajorVersion: 109,
  mcpProtocolVersion: "1.2.0",
  profileSchemaVersion: 1,
  runtimeMetadataVersion: 3,
  distribution: "portable",
};
await writeFile(path.join(appRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

await rm(archivePath, { force: true });
await rm(checksumPath, { force: true });
run("tar.exe", ["-a", "-c", "-f", archivePath, "-C", stageRoot, releaseName]);

const archive = await readFile(archivePath);
const checksum = createHash("sha256").update(archive).digest("hex");
await writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`, "ascii");

const listing = spawnSync("tar.exe", ["-tf", archivePath], { encoding: "utf8", windowsHide: true });
if (listing.status !== 0) throw new Error("The release archive could not be read after creation.");
for (const required of [
  `${releaseName}/start-local.cmd`,
  `${releaseName}/dist/electron/main.js`,
  `${releaseName}/dist/mcp/index.mjs`,
  `${releaseName}/node_modules/electron/dist/electron.exe`,
  `${releaseName}/release-manifest.json`,
]) {
  if (!listing.stdout.split(/\r?\n/).includes(required)) throw new Error(`Release archive is missing ${required}.`);
}

const size = (await stat(archivePath)).size;
await rm(stageRoot, { recursive: true, force: true });
console.log(JSON.stringify({ archive: archivePath, checksum, bytes: size }, null, 2));
