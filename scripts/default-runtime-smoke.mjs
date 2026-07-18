import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverEdge, getConfiguredBrowserRuntime, resolveBrowserRuntime } from "../dist/browser/edge-prototype-entry.mjs";

const projectRoot = path.resolve(".");
const runtimeRoot = path.join(projectRoot, ".runtime");
const profilesRoot = path.join(runtimeRoot, "edge-profiles");
const profileDir = path.join(profilesRoot, `phase1-default-${Date.now()}-${randomUUID()}`);
const localAppData = path.join(runtimeRoot, `default-runtime-localappdata-${randomUUID()}`);
const pipeName = `codex-browser-default-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
const mcpEntry = path.join(projectRoot, "dist", "mcp", "index.mjs");
const profileLock = path.join(profileDir, ".codex-browser-profile.lock");

const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><html><head><title>Phase 6 Recovery Fixture</title></head><body><button>Recovery target</button></body></html>");
});
await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
const fixtureAddress = fixture.address();
if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("Phase 6 fixture failed to bind.");
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

function rawCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath); const id = randomUUID(); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out calling ${method}.`)); }, 10_000);
    socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`)); socket.once("error", reject);
    socket.on("data", (chunk) => { buffer += chunk; const newline = buffer.indexOf("\n"); if (newline < 0) return; clearTimeout(timer); socket.destroy(); const response = JSON.parse(buffer.slice(0, newline)); if (response.ok) resolve(response.result); else { const error = new Error(response.error?.message || "Broker call failed."); error.name = response.error?.code; reject(error); } });
  });
}

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) throw new Error(value.message || "MCP call failed.");
  return value;
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The isolated managed Edge process did not exit in time.");
}

await mkdir(profilesRoot, { recursive: true });
await mkdir(localAppData, { recursive: true });
await access(mcpEntry);
const edge = discoverEdge(process.env);
const env = { ...process.env };
delete env.CODEX_BROWSER_RUNTIME;
Object.assign(env, {
  LOCALAPPDATA: localAppData,
  CODEX_BROWSER_EDGE_PATH: edge.executablePath,
  CODEX_BROWSER_PROJECT_ROOT: projectRoot,
  CODEX_BROWSER_EDGE_RUNTIME_ROOT: runtimeRoot,
  CODEX_BROWSER_EDGE_PROFILE_DIR: profileDir,
  CODEX_BROWSER_PIPE_NAME: pipeName,
  CODEX_BROWSER_TEST_MODE: "1",
  CODEX_BROWSER_AUTOSTART_TEST: "1",
});

const client = new Client({ name: "default-runtime-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env });
try {
  if (getConfiguredBrowserRuntime({}) !== "external-edge") throw new Error("Unset runtime did not resolve to external-edge.");
  if (resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "edge-prototype" }).runtime !== "external-edge") throw new Error("Legacy Edge alias was not migrated.");
  if (resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "electron" }).runtime !== "electron-legacy") throw new Error("Legacy Electron alias was not migrated.");
  await client.connect(transport);
  const capabilities = parse(await client.callTool({ name: "browser_capabilities", arguments: {} }));
  if (capabilities.runtime !== "external-edge") throw new Error("MCP did not auto-start the external Edge runtime by default.");
  const status = parse(await client.callTool({ name: "browser_status", arguments: {} }));
  if (status.runtimeInfo?.kind !== "external-edge" || status.runtimeInfo?.connection !== "ready") throw new Error("Default external Edge did not report ready runtime state.");
  if (status.runtimeInfo?.browserVersion !== edge.version) throw new Error("Default runtime did not report the discovered Edge version.");
  const serialized = JSON.stringify(status);
  if (serialized.includes(profileDir) || /devtools|websocket|127\.0\.0\.1:\d+/i.test(serialized)) throw new Error("Default runtime status exposed a profile path or CDP endpoint.");

  const initialTabs = parse(await client.callTool({ name: "browser_tabs", arguments: {} }));
  const tabId = initialTabs.activeTabId;
  await client.callTool({ name: "browser_navigate", arguments: { tabId, url: fixtureUrl } });
  const snapshot = parse(await client.callTool({ name: "browser_snapshot", arguments: { tabId } }));
  const target = snapshot.elements.find((element) => element.name === "Recovery target");
  if (!target) throw new Error("Recovery fixture target was not observed.");
  const lock = JSON.parse(await readFile(profileLock, "utf8"));
  if (!Number.isInteger(lock.browserPid) || lock.browserPid <= 0) throw new Error("Managed Edge ownership did not record its browser process.");
  process.kill(lock.browserPid);
  await waitForProcessExit(lock.browserPid);
  const recoveredTabs = parse(await client.callTool({ name: "browser_tabs", arguments: {} }));
  const recoveredStatus = parse(await client.callTool({ name: "browser_status", arguments: {} }));
  if (recoveredStatus.runtimeInfo?.connection !== "ready") throw new Error("The managed Edge runtime did not recover after an owned browser exit.");
  const recoveredLock = JSON.parse(await readFile(profileLock, "utf8"));
  if (!Number.isInteger(recoveredLock.browserPid) || recoveredLock.browserPid <= 0 || recoveredLock.browserPid === lock.browserPid) throw new Error("Recovery did not create exactly one replacement managed Edge process.");
  process.kill(recoveredLock.browserPid, 0);
  try {
    parse(await client.callTool({ name: "browser_act", arguments: { tabId, action: "click", ref: target.ref, revision: snapshot.revision } }));
    throw new Error("A pre-recovery page reference remained usable.");
  } catch (error) {
    if ((error instanceof Error) && error.message === "A pre-recovery page reference remained usable.") throw error;
  }
  console.log(JSON.stringify({ defaultRuntime: capabilities.runtime, edgeVersion: edge.version, autoStarted: true, profileIsolated: true, aliasesSupported: true, recoveredAfterOwnedExit: true, oldReferencesInvalidated: true, recoveredTabCount: recoveredTabs.tabs.length }, null, 2));
} finally {
  await client.close().catch(() => transport.close().catch(() => undefined));
  await rawCall("runtime.shutdown").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await rm(localAppData, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => fixture.close(resolve));
}
