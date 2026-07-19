import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const installer = path.join(projectRoot, "release", `CodexBrowser-${packageJson.version}-win-x64-setup.exe`);
const runtimeRoot = path.join(projectRoot, ".runtime");
const testRoot = path.join(runtimeRoot, `installer-smoke-${randomUUID()}`);
const installDir = path.join(testRoot, "Codex Browser");
const logPath = path.join(testRoot, "setup.log");

function assertWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing installer smoke operation outside runtime root: ${candidate}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}: ${result.stdout}\n${result.stderr}`);
}

assertWithin(testRoot, runtimeRoot);
await rm(testRoot, { recursive: true, force: true });
await mkdir(testRoot, { recursive: true });

try {
  run(installer, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOICONS", `/DIR=${installDir}`, `/LOG=${logPath}`]);
  for (const required of [
    "start-local.cmd",
    "release-manifest.json",
    "dist/electron/main.js",
    "dist/mcp/index.mjs",
    "extension/edge-relay/manifest.json",
    "node_modules/electron/dist/electron.exe",
    "scripts/check-node-version.mjs",
    "unins000.exe",
  ]) await access(path.join(installDir, required));
  run(process.execPath, [path.join(installDir, "scripts", "check-node-version.mjs")]);
  const manifest = JSON.parse(await readFile(path.join(installDir, "release-manifest.json"), "utf8"));
  if (manifest.version !== packageJson.version || manifest.platform !== "win32" || manifest.architecture !== "x64") {
    throw new Error("Installed release manifest does not match the package version and platform.");
  }
  run(path.join(installDir, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
  try {
    await access(path.join(installDir, "start-local.cmd"));
    throw new Error("The uninstaller left installed application files behind.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("left installed")) throw error;
  }
  console.log(JSON.stringify({ version: manifest.version, installed: true, nodeVersionAccepted: process.versions.node, extensionIncluded: true, uninstalled: true }, null, 2));
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
