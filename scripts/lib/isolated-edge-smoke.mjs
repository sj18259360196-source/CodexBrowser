import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const helperDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(helperDir, "..", "..");
const runtimeRoot = path.join(projectRoot, ".runtime");
const profilesRoot = path.join(runtimeRoot, "edge-profiles");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pipePathFor = (name) => process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;

function probePipe(pipePath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    const timer = setTimeout(() => finish(false), timeoutMs);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPipe(pipePath, child, timeoutMs = 45_000, readError = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePipe(pipePath)) return;
    if (child.exitCode !== null) throw new Error(`The isolated Edge broker exited before opening its private pipe. ${readError()}`.trim());
    await sleep(100);
  }
  throw new Error(`The isolated Edge broker did not open its private pipe in time. ${readError()}`.trim());
}

function rawPipeCall(pipePath, method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const request = { id: randomUUID(), method, params };
    const socket = connect(pipePath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out calling ${method}.`)); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      const response = JSON.parse(buffer.slice(0, newline));
      if (!response.ok) {
        const error = new Error(response.error?.message || "Edge broker command failed.");
        error.name = response.error?.code || "BROWSER_ERROR";
        reject(error);
      } else resolve(response.result);
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function stopOwnedEdgeProcesses(profileDir) {
  if (process.platform !== "win32") return;
  const script = "$p=$env:CODEX_BROWSER_OWNED_PROFILE; Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, CODEX_BROWSER_OWNED_PROFILE: profileDir },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", resolve);
    child.once("exit", resolve);
  });
}

async function cleanupOwnedProfile(profileDir) {
  const exists = await access(profileDir).then(() => true, () => false);
  if (!exists) return;
  if (!isInside(profilesRoot, profileDir) || !path.basename(profileDir).startsWith("phase1-")) {
    throw new Error("Refusing to clean an unverified Edge smoke profile.");
  }
  const resolvedRoot = await realpath(profilesRoot);
  const resolvedProfile = await realpath(profileDir).catch(() => path.resolve(profileDir));
  if (!isInside(resolvedRoot, resolvedProfile)) throw new Error("Refusing to clean an Edge smoke profile outside the managed root.");
  await stopOwnedEdgeProcesses(profileDir);
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  if (await access(profileDir).then(() => true, () => false)) throw new Error("The isolated Edge smoke profile remained after cleanup.");
}

export async function startIsolatedEdgeSmoke({
  suiteName = "edge-core",
  clientName = "edge-core-smoke",
  profileDir: requestedProfileDir,
  preserveProfileOnDispose = false,
} = {}) {
  await mkdir(profilesRoot, { recursive: true });
  const profileDir = requestedProfileDir
    ? path.resolve(requestedProfileDir)
    : path.join(profilesRoot, `phase1-${Date.now()}-${randomUUID()}`);
  if (!isInside(profilesRoot, profileDir) || !path.basename(profileDir).startsWith("phase1-")) {
    throw new Error("Refusing to use an unverified Edge smoke profile.");
  }
  const pipeName = `codex-browser-${suiteName}-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}`.slice(0, 80);
  const pipePath = pipePathFor(pipeName);
  const brokerEntry = path.join(projectRoot, "dist", "browser", "edge-broker.mjs");
  const mcpEntry = path.join(projectRoot, "dist", "mcp", "index.mjs");
  await Promise.all([access(brokerEntry), access(mcpEntry)]);
  const env = {
    ...process.env,
    CODEX_BROWSER_RUNTIME: "external-edge",
    CODEX_BROWSER_TEST_MODE: "1",
    CODEX_BROWSER_PROJECT_ROOT: projectRoot,
    CODEX_BROWSER_EDGE_RUNTIME_ROOT: runtimeRoot,
    CODEX_BROWSER_EDGE_PROFILE_DIR: profileDir,
    CODEX_BROWSER_PRESERVE_TEST_PROFILE: preserveProfileOnDispose ? "1" : "0",
    CODEX_BROWSER_PIPE_NAME: pipeName,
    CODEX_BROWSER_EDGE_DEBUG: process.env.CODEX_BROWSER_EDGE_DEBUG === "1" ? "1" : "0",
  };
  const broker = spawn(process.execPath, [brokerEntry], { cwd: projectRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let brokerError = "";
  broker.stderr?.setEncoding("utf8");
  broker.stderr?.on("data", (chunk) => {
    brokerError = `${brokerError}${chunk}`.slice(-4_000);
    if (env.CODEX_BROWSER_EDGE_DEBUG === "1") process.stderr.write(chunk);
  });
  try {
    await waitForPipe(pipePath, broker, 45_000, () => brokerError.trim());
  } catch (error) {
    await rawPipeCall(pipePath, "runtime.shutdown", {}, 2_000).catch(() => undefined);
    if (broker.exitCode === null) broker.kill();
    await waitForExit(broker, 5_000);
    if (!preserveProfileOnDispose) await cleanupOwnedProfile(profileDir).catch(() => undefined);
    throw error;
  }
  const client = new Client({ name: clientName, version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env });
  await client.connect(transport);
  let disposed = false;
  return {
    client,
    broker,
    pipePath,
    profileDir,
    rawCall: (method, params, timeoutMs) => rawPipeCall(pipePath, method, params, timeoutMs),
    brokerLog: () => brokerError,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await client.close().catch(() => transport.close().catch(() => undefined));
      await rawPipeCall(pipePath, "runtime.shutdown", {}, 5_000).catch(() => undefined);
      const exited = await waitForExit(broker, 20_000);
      if (!exited && broker.exitCode === null) broker.kill();
      await waitForExit(broker, 5_000);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && await probePipe(pipePath)) await sleep(100);
      const pipeClosed = !await probePipe(pipePath);
      if (!preserveProfileOnDispose) await cleanupOwnedProfile(profileDir);
      if (!exited) throw new Error("The isolated Edge broker did not exit cleanly.");
      if (!pipeClosed) throw new Error("The isolated Edge broker pipe remained open after shutdown.");
    },
  };
}
