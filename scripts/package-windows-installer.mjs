import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const versionInfo = `${version}.0`;
const portableName = `CodexBrowser-${version}-win-x64`;
const outputBaseFilename = `CodexBrowser-${version}-win-x64-setup`;
const runtimeRoot = path.join(projectRoot, ".runtime");
const stageRoot = path.join(runtimeRoot, "installer-stage");
const sourceDir = path.join(stageRoot, portableName);
const releaseRoot = path.join(projectRoot, "release");
const portableArchive = path.join(releaseRoot, `${portableName}.zip`);
const installerPath = path.join(releaseRoot, `${outputBaseFilename}.exe`);
const checksumPath = `${installerPath}.sha256`;
const innoCandidates = [
  process.env.ISCC_PATH,
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
].filter(Boolean);

function assertWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing installer operation outside the bounded staging directory: ${candidate}`);
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

async function findIscc() {
  for (const candidate of innoCandidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error("Inno Setup 6 was not found. Install JRSoftware.InnoSetup with winget or set ISCC_PATH.");
}

assertWithin(stageRoot, runtimeRoot);
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });

try {
  run("tar.exe", ["-xf", portableArchive, "-C", stageRoot]);
  if (!(await stat(path.join(sourceDir, "release-manifest.json"))).isFile()) {
    throw new Error("The portable archive did not extract to the expected versioned directory.");
  }
  await rm(installerPath, { force: true });
  await rm(checksumPath, { force: true });
  const iscc = await findIscc();
  run(iscc, [
    "/Qp",
    `/DMyAppVersion=${version}`,
    `/DMyAppVersionInfo=${versionInfo}`,
    `/DSourceDir=${sourceDir}`,
    `/DOutputDir=${releaseRoot}`,
    `/DOutputBaseFilename=${outputBaseFilename}`,
    path.join(projectRoot, "installer", "codex-browser.iss"),
  ]);
  const installer = await readFile(installerPath);
  const checksum = createHash("sha256").update(installer).digest("hex");
  await writeFile(checksumPath, `${checksum}  ${path.basename(installerPath)}\n`, "ascii");
  console.log(JSON.stringify({ installer: installerPath, checksum, bytes: installer.length }, null, 2));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
