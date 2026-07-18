import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const helperDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(helperDir, "..", "..");

const smokeProfilesRoot = path.join(projectRoot, ".runtime", "smoke-profiles");
const defaultPipeName = "codex-browser-v1";

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeSuiteName(value) {
  const normalized = String(value || "smoke")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return normalized || "smoke";
}

function pipePathFor(pipeName) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
}

function electronExecutableForProject() {
  if (process.platform === "win32") {
    return path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
  }
  if (process.platform === "darwin") {
    return path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(projectRoot, "node_modules", "electron", "dist", "electron");
}

function stringEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
}

function probePipe(pipePath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function processExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (processExited(child)) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited) => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForPipe(pipePath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePipe(pipePath)) return;
    if (processExited(child)) {
      throw new Error("The isolated Electron smoke process exited before opening its private pipe.");
    }
    await sleep(100);
  }
  throw new Error("The isolated Electron smoke process did not open its private pipe in time.");
}

async function waitForPipeClosed(pipePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await probePipe(pipePath)) return true;
    await sleep(100);
  }
  return !await probePipe(pipePath);
}

async function stopProcessTree(child) {
  if (!child?.pid || processExited(child)) return;

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
  } else {
    child.kill("SIGTERM");
    if (!await waitForChildExit(child, 2_000)) child.kill("SIGKILL");
  }

  if (!await waitForChildExit(child, 5_000)) {
    throw new Error("The isolated Electron smoke process did not exit during cleanup.");
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeProfile(profileDir, suiteName) {
  if (!isInside(smokeProfilesRoot, profileDir) || !path.basename(profileDir).startsWith(`${suiteName}-`)) {
    throw new Error("Refusing to remove an unverified Electron smoke profile.");
  }

  const resolvedRoot = await realpath(smokeProfilesRoot);
  const resolvedProfile = await realpath(profileDir).catch(() => path.resolve(profileDir));
  if (!isInside(resolvedRoot, resolvedProfile)) {
    throw new Error("Refusing to remove an Electron smoke profile outside the isolated profile root.");
  }

  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  const remains = await access(profileDir).then(() => true, () => false);
  if (remains) throw new Error("The isolated Electron smoke profile remained after cleanup.");
}

async function assertReusableProfile(profileDir, suiteName) {
  if (!isInside(smokeProfilesRoot, profileDir) || !path.basename(profileDir).startsWith(`${suiteName}-`)) {
    throw new Error("Refusing to reuse an unverified Electron smoke profile.");
  }

  const resolvedRoot = await realpath(smokeProfilesRoot);
  const resolvedProfile = await realpath(profileDir);
  if (!isInside(resolvedRoot, resolvedProfile)) {
    throw new Error("Refusing to reuse an Electron smoke profile outside the isolated profile root.");
  }
}

export async function createIsolatedElectronSmokeProfile({ suiteName }) {
  const safeName = safeSuiteName(suiteName);
  await mkdir(smokeProfilesRoot, { recursive: true });
  const profileDir = await mkdtemp(path.join(smokeProfilesRoot, `${safeName}-`));
  let disposed = false;

  return {
    profileDir,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await removeProfile(profileDir, safeName);
    },
  };
}

async function closeClient(client, transport, connected) {
  if (!connected) {
    await transport.close().catch(() => undefined);
    return;
  }
  let timeout;
  let outcome;
  try {
    outcome = await Promise.race([
      client.close().then(() => "closed"),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 4_000);
      }),
    ]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (outcome === "timeout") {
    await transport.close().catch(() => undefined);
    throw new Error("The isolated MCP client did not close in time.");
  }
}

export async function startIsolatedElectronSmoke({
  suiteName,
  clientName,
  startupTimeoutMs = 20_000,
  profileDir: requestedProfileDir,
}) {
  const safeName = safeSuiteName(suiteName);
  await mkdir(smokeProfilesRoot, { recursive: true });
  const ownsProfile = !requestedProfileDir;
  const profileDir = requestedProfileDir
    ? path.resolve(requestedProfileDir)
    : await mkdtemp(path.join(smokeProfilesRoot, `${safeName}-`));
  if (!ownsProfile) await assertReusableProfile(profileDir, safeName);
  const pipeName = `codex-browser-${safeName}-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 16)}`.slice(0, 80);
  if (!pipeName || pipeName === defaultPipeName) {
    await removeProfile(profileDir, safeName);
    throw new Error("The smoke test did not create a private named pipe.");
  }
  const pipePath = pipePathFor(pipeName);
  const electronExecutable = electronExecutableForProject();
  const mcpEntry = path.join(projectRoot, "dist", "mcp", "index.mjs");

  const baseEnv = stringEnvironment();
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  delete baseEnv.VITE_DEV_SERVER_URL;
  const isolatedEnv = {
    ...baseEnv,
    CODEX_BROWSER_PROJECT_ROOT: projectRoot,
    CODEX_BROWSER_PIPE_NAME: pipeName,
    CODEX_BROWSER_USER_DATA_DIR: profileDir,
    CODEX_BROWSER_TEST_MODE: "1",
    CODEX_BROWSER_RUNTIME: "electron-legacy",
  };

  await Promise.all([access(electronExecutable), access(mcpEntry)]).catch(async () => {
    if (ownsProfile) await removeProfile(profileDir, safeName);
    throw new Error("Build Codex Browser before running isolated Electron smoke tests.");
  });

  const desktopProcess = spawn(electronExecutable, [projectRoot], {
    cwd: projectRoot,
    env: isolatedEnv,
    stdio: "ignore",
    windowsHide: true,
  });
  const desktopSpawnFailure = new Promise((_resolve, reject) => {
    desktopProcess.once("error", () => {
      reject(new Error("The isolated Electron smoke process could not be started."));
    });
  });
  const client = new Client({ name: clientName, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: isolatedEnv,
  });
  let connected = false;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors = [];
    await closeClient(client, transport, connected).catch((error) => errors.push(error));
    connected = false;
    await stopProcessTree(desktopProcess).catch((error) => errors.push(error));
    if (!await waitForPipeClosed(pipePath)) {
      errors.push(new Error("The isolated Electron smoke pipe remained active after cleanup."));
    }
    if (ownsProfile) await removeProfile(profileDir, safeName).catch((error) => errors.push(error));
    if (!processExited(desktopProcess)) {
      errors.push(new Error("The isolated Electron smoke process remained active after cleanup."));
    }
    if (await probePipe(pipePath)) {
      errors.push(new Error("The isolated Electron smoke pipe was reachable after cleanup."));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Isolated Electron smoke cleanup failed.");
    }
  };

  try {
    await Promise.race([
      waitForPipe(pipePath, desktopProcess, startupTimeoutMs),
      desktopSpawnFailure,
    ]);
    await client.connect(transport);
    connected = true;
    return { client, dispose, projectRoot, profileDir, pipeName };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Isolated Electron smoke startup and cleanup failed.");
    }
    throw error;
  }
}
