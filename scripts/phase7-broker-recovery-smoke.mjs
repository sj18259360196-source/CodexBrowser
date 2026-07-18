import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { discoverEdge } from "../dist/browser/edge-prototype-entry.mjs";
import { PROFILE_SCHEMA_VERSION } from "../src/shared/release-info.js";
import { projectRoot, startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profilesRoot = path.join(projectRoot, ".runtime", "edge-profiles");
const profileDir = path.join(profilesRoot, `phase1-broker-recovery-${Date.now()}-${randomUUID()}`);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><title>Broker recovery fixture</title><button>Recovery action</button>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Broker recovery fixture failed to bind.");
const fixtureUrl = `http://127.0.0.1:${address.port}/`;

function ownedBrowserPids({ includeChildren = false } = {}) {
  const ownershipFilter = includeChildren
    ? ""
    : " -and $_.CommandLine.IndexOf('--remote-debugging-port=0',[System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf('--type=',[System.StringComparison]::OrdinalIgnoreCase) -lt 0";
  const command = `Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:CODEX_BROWSER_PROFILE,[System.StringComparison]::OrdinalIgnoreCase) -ge 0${ownershipFilter} } | Select-Object -ExpandProperty ProcessId`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, CODEX_BROWSER_PROFILE: profileDir }, encoding: "utf8", windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Broker recovery smoke could not inspect the isolated Edge process.");
  return result.stdout.split(/\r?\n/).map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0);
}

function ownedBrowserTreePids(rootPid) {
  if (!rootPid) return [];
  const command = "Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true,
  });
  const processes = result.stdout.split(/\r?\n/).map((line) => line.trim().split(",").map(Number)).filter(([pid, parentPid]) => pid > 0 && parentPid >= 0);
  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of processes) {
      if (tree.has(parentPid) && !tree.has(pid)) { tree.add(pid); changed = true; }
    }
  }
  return [...tree];
}

async function cleanupOwnedProcesses(recordedPids = []) {
  if (process.platform === "win32") {
    for (const pid of recordedPids) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    }
    const command = "$p=$env:CODEX_BROWSER_PROFILE; Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    const stopped = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, CODEX_BROWSER_PROFILE: profileDir }, encoding: "utf8", windowsHide: true,
    });
    if (stopped.error || stopped.status !== 0) throw new Error("Broker recovery cleanup could not inspect the isolated Edge process.");
  } else {
    for (const pid of recordedPids) { try { process.kill(pid); } catch {} }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const matching = ownedBrowserPids({ includeChildren: true });
    const recordedAlive = recordedPids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!matching.length && !recordedAlive) return;
    await sleep(100);
  }
  throw new Error("Broker recovery cleanup could not stop every Edge process owned by the isolated profile.");
}

const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};

let runtime;
let browserPid;
try {
  await mkdir(profileDir, { recursive: true });
  const edge = discoverEdge(process.env);
  const launched = spawn(edge.executablePath, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    fixtureUrl,
  ], { stdio: "ignore", windowsHide: false, detached: process.platform === "win32" });
  launched.unref();
  const endpointFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !await access(endpointFile).then(() => true, () => false)) await sleep(100);
  if (!await access(endpointFile).then(() => true, () => false)) throw new Error("The recovery fixture Edge did not publish its private endpoint.");
  let pids = ownedBrowserPids();
  if (pids.length !== 1) throw new Error(`The recovery fixture found ${pids.length} managed Edge browser processes before broker start.`);
  browserPid = pids[0];
  const now = new Date().toISOString();
  await writeFile(path.join(profileDir, ".codex-browser-profile.json"), JSON.stringify({ product: "CodexBrowser", profileVersion: PROFILE_SCHEMA_VERSION, instanceId: "previous-broker", pid: 2_000_000_001, browserVersion: edge.version, createdAt: now, acquiredAt: now, browserPid }, null, 2), "utf8");
  await writeFile(path.join(profileDir, ".codex-browser-profile.lock"), JSON.stringify({ instanceId: "previous-broker", pid: 2_000_000_001, browserPid, browserVersion: edge.version, acquiredAt: now }), "utf8");

  runtime = await startIsolatedEdgeSmoke({ suiteName: "phase7-broker-recovery", clientName: "phase7-broker-recovery", profileDir, preserveProfileOnDispose: true });
  const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
  const recoveredLock = JSON.parse(await readFile(path.join(profileDir, ".codex-browser-profile.lock"), "utf8"));
  pids = ownedBrowserPids();
  if (recoveredLock.browserPid !== browserPid || pids.length !== 1 || pids[0] !== browserPid) throw new Error("Broker recovery did not retain exactly one existing managed Edge process.");
  const tabs = await call("browser_tabs");
  const recoveredTab = tabs.tabs.find((tab) => tab.url === fixtureUrl);
  if (!recoveredTab) throw new Error("Broker recovery did not rediscover the existing page.");
  const snapshot = await call("browser_snapshot", { tabId: recoveredTab.id, maxElements: 20 });
  if (!snapshot.elements.some((element) => element.name === "Recovery action")) throw new Error("The recovered page was not operable.");
  console.log(JSON.stringify({ existingManagedEdgeReattached: true, pageRediscovered: true, duplicateEdgeProcesses: 0, staleBrokerOwnershipReplaced: true }, null, 2));
} finally {
  const recordedPids = ownedBrowserTreePids(browserPid);
  let disposeError;
  if (runtime) {
    try { await runtime.dispose(); } catch (error) { disposeError = error; }
  }
  const gracefulProcessesExited = ownedBrowserPids({ includeChildren: true }).length === 0;
  const profileLockReleased = !await access(path.join(profileDir, ".codex-browser-profile.lock")).then(() => true, () => false);
  let cleanupError;
  try {
    await cleanupOwnedProcesses(recordedPids);
    if (path.resolve(profileDir).startsWith(path.resolve(profilesRoot) + path.sep) && path.basename(profileDir).startsWith("phase1-")) {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    if (await access(profileDir).then(() => true, () => false)) throw new Error("Broker recovery smoke left its isolated profile behind.");
  } catch (error) {
    cleanupError = error;
  }
  await new Promise((resolve) => server.close(resolve));
  if (cleanupError) throw cleanupError;
  if (disposeError) throw disposeError;
  if (!gracefulProcessesExited) throw new Error("Broker recovery shutdown left Edge processes owned by the isolated profile running.");
  if (!profileLockReleased) throw new Error("Broker recovery smoke did not release the isolated profile lock.");
}
