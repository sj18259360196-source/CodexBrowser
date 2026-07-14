import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const mcpServerPath = path.join(projectRoot, "dist", "mcp", "index.mjs");

const runtimeRoot = path.join(projectRoot, ".runtime", "smoke");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pipePathFor(name) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

function probePipe(pipePath) {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPipe(pipePath, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probePipe(pipePath)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for isolated desktop pipe ${pipePath}.`);
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2_000).then(() => child.kill("SIGKILL")),
  ]);
}

export function createSmokeRuntime(prefix) {
  const safePrefix = prefix.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "runtime";
  const testId = `${safePrefix}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pipeName = `codex-browser-${testId}`;
  const profileDir = path.join(runtimeRoot, testId);
  const pipePath = pipePathFor(pipeName);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string")),
    CODEX_BROWSER_PROJECT_ROOT: projectRoot,
    CODEX_BROWSER_PIPE_NAME: pipeName,
    CODEX_BROWSER_USER_DATA_DIR: profileDir,
    CODEX_BROWSER_TEST_MODE: "1",
  };
  let desktopProcess;

  return {
    env,
    mcpServerPath,
    pipeName,
    profileDir,
    async start(options = {}) {
      const defaultExecutable = process.platform === "win32"
        ? path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe")
        : path.join(projectRoot, "node_modules", ".bin", "electron");
      const electronExecutable = options.executable || defaultExecutable;
      const args = options.args || [projectRoot];
      desktopProcess = spawn(electronExecutable, args, {
        ...options.spawnOptions,
        argv0: options.argv0,
        cwd: projectRoot,
        env,
        stdio: "ignore",
        windowsHide: true,
      });
      await waitForPipe(pipePath);
    },
    async stop() {
      await stopProcessTree(desktopProcess);
      const relative = path.relative(runtimeRoot, profileDir);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Refusing to remove an unverified smoke profile path: ${profileDir}`);
      }
      await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    },
  };
}
