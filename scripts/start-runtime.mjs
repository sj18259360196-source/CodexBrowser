import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeSettings, resolveBrowserRuntime } from "../dist/browser/edge-prototype-entry.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipeName = String(process.env.CODEX_BROWSER_PIPE_NAME || "codex-browser-v1").trim().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "codex-browser-v1";
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;

function callBroker(method) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    const id = `launcher-${process.pid}-${Date.now()}`;
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Timed out waiting for Codex Browser.")); }, 2_000);
    const finish = (callback) => { clearTimeout(timer); socket.destroy(); callback(); };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params: {} })}\n`));
    socket.once("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      finish(() => response.ok ? resolve(response.result) : reject(new Error(response.error?.message || "Codex Browser rejected the launcher request.")));
    });
  });
}

const selected = process.env.CODEX_BROWSER_RUNTIME?.trim()
  ? resolveBrowserRuntime(process.env).runtime
  : loadRuntimeSettings().preferredRuntime;

if (selected === "electron-legacy") {
  const executable = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  await access(executable);
  const child = spawn(executable, [projectRoot], {
    cwd: projectRoot,
    detached: true,
    windowsHide: false,
    stdio: "ignore",
    env: { ...process.env, CODEX_BROWSER_RUNTIME: "electron-legacy" },
  });
  child.unref();
  process.exit(0);
}

try {
  await callBroker("runtime.show_control_center");
  process.exit(0);
} catch {}

const brokerEntry = path.join(projectRoot, "dist", "browser", "edge-broker.mjs");
await access(brokerEntry);
const child = spawn(process.execPath, [brokerEntry], {
  cwd: projectRoot,
  detached: true,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    CODEX_BROWSER_RUNTIME: "external-edge",
    CODEX_BROWSER_PROJECT_ROOT: projectRoot,
    CODEX_BROWSER_PIPE_NAME: pipeName,
    CODEX_BROWSER_SHOW_CONTROL_CENTER: "1",
  },
});
child.unref();

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try { await callBroker("runtime.show_control_center"); process.exit(0); } catch {}
}
throw new Error("Codex Browser could not start the external Edge runtime. Confirm that Microsoft Edge is installed, then retry or set CODEX_BROWSER_RUNTIME=electron-legacy for temporary troubleshooting.");
