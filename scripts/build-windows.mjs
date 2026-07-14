import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windows packaging must run on Windows.");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderCli = path.join(projectRoot, "node_modules", "electron-builder", "cli.js");
const unpackedDir = path.join(projectRoot, "release", "win-unpacked");
const packagedExecutable = path.join(unpackedDir, "Codex Browser.exe");
const packagedAsar = path.join(unpackedDir, "resources", "app.asar");
const mode = process.argv[2];

if (!new Set(["dir", "installer"]).has(mode)) {
  throw new Error("Usage: node scripts/build-windows.mjs <dir|installer>");
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builderCli, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function stablePackageSignature() {
  const [executable, asar] = await Promise.all([stat(packagedExecutable), stat(packagedAsar)]);
  if (executable.size <= 0 || asar.size <= 0) throw new Error("Packaged files are empty.");
  return `${executable.size}:${executable.mtimeMs}|${asar.size}:${asar.mtimeMs}`;
}

async function waitForStablePackage(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature;
  while (Date.now() < deadline) {
    try {
      const signature = await stablePackageSignature();
      if (signature === previousSignature) return;
      previousSignature = signature;
    } catch {
      previousSignature = undefined;
    }
    await sleep(750);
  }
  throw new Error(`The unpacked application did not stabilize: ${unpackedDir}`);
}

const directoryBuild = await runBuilder(["--win", "dir", "--x64"]);
try {
  await waitForStablePackage();
} catch (error) {
  throw new Error(`Windows directory packaging failed with exit code ${directoryBuild.code}: ${error.message}`);
}

if (directoryBuild.code !== 0) {
  console.warn(`electron-builder exited with code ${directoryBuild.code}, but the unpacked application completed and passed stability checks.`);
}

if (mode === "installer") {
  const installerBuild = await runBuilder(["--prepackaged", unpackedDir, "--win", "nsis", "--x64"]);
  if (installerBuild.code !== 0) {
    throw new Error(`NSIS packaging failed with exit code ${installerBuild.code}${installerBuild.signal ? ` (${installerBuild.signal})` : ""}.`);
  }
}
