import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const durationMinutes = Math.max(1, Number.parseInt(process.env.CODEX_BROWSER_STABILITY_MINUTES || "30", 10));
const durationMs = durationMinutes * 60_000;
const intervalMs = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><title>Phase 6 Stability ${url.pathname}</title></head><body><button id="tick" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);this.textContent='Tick '+this.dataset.count">Tick</button><p>Local stability fixture</p></body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("The stability fixture failed to bind.");
const origin = `http://127.0.0.1:${address.port}`;

const runtime = await startIsolatedEdgeSmoke({ suiteName: "phase6-stability", clientName: "phase6-stability-smoke" });
const lockPath = path.join(runtime.profileDir, ".codex-browser-profile.lock");
const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
const resourceSamples = [];

function isConnectionLoss(error) {
  return error instanceof Error
    && ["BROWSER_ERROR", "BROWSER_RECOVERY_COOLDOWN"].includes(error.name)
    && /connection|recovery|closed|cooling down/i.test(error.message);
}

async function waitForRecoveredTabs() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await call("browser_tabs"); } catch (error) {
      if (!isConnectionLoss(error)) throw error;
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("The managed Edge recovery did not become ready in time.");
}

async function sampleResources(label) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const pids = [runtime.broker.pid, lock.browserPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (process.platform !== "win32" || pids.length === 0) return;
  const command = `Get-Process -Id ${pids.join(",")} -ErrorAction Stop | Select-Object Id,WorkingSet64,HandleCount | ConvertTo-Json -Compress`;
  const { spawn } = await import("node:child_process");
  const output = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || "Resource sampling failed.")));
  });
  const entries = [JSON.parse(output)].flat();
  resourceSamples.push({ label, totalWorkingSet: entries.reduce((sum, item) => sum + Number(item.WorkingSet64 || 0), 0), totalHandles: entries.reduce((sum, item) => sum + Number(item.HandleCount || 0), 0) });
}

try {
  const firstTabs = await call("browser_tabs");
  let tabIds = [firstTabs.activeTabId];
  for (const pathname of ["/two", "/three"]) tabIds.push((await call("browser_tab_new", { url: `${origin}${pathname}`, activate: false })).createdTabId);
  await call("browser_navigate", { tabId: tabIds[0], url: `${origin}/one` });
  await sampleResources("start");
  const startedAt = Date.now();
  let iteration = 0; let recovered = false; let transientRecoveries = 0;
  while (Date.now() - startedAt < durationMs) {
    const tabId = tabIds[iteration % tabIds.length];
    try {
      const snapshot = await call("browser_snapshot", { tabId, maxElements: 20, maxTextCharacters: 2_000 });
      const button = snapshot.elements.find((element) => element.name.startsWith("Tick"));
      if (!button) throw new Error("The stability fixture button disappeared.");
      await call("browser_act", { tabId, action: "click", ref: button.ref, revision: snapshot.revision });
      if (iteration > 0 && iteration % 12 === 0) await call("browser_navigate", { tabId, url: `${origin}/loop-${iteration % 5}` });
    } catch (error) {
      if (!isConnectionLoss(error) || transientRecoveries >= 3) throw error;
      const recoveredTabs = await waitForRecoveredTabs();
      tabIds = recoveredTabs.tabs.filter((tab) => tab.url.startsWith(origin)).map((tab) => tab.id).slice(0, 3);
      while (tabIds.length < 3) tabIds.push((await call("browser_tab_new", { url: `${origin}/transient-${tabIds.length}`, activate: false })).createdTabId);
      transientRecoveries += 1;
      iteration += 1;
      continue;
    }
    if (!recovered && Date.now() - startedAt >= durationMs / 2) {
      const before = JSON.parse(await readFile(lockPath, "utf8"));
      process.kill(before.browserPid);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { try { process.kill(before.browserPid, 0); await sleep(100); } catch { break; } }
      const recoveredTabs = await waitForRecoveredTabs();
      const after = JSON.parse(await readFile(lockPath, "utf8"));
      if (!after.browserPid || after.browserPid === before.browserPid) throw new Error("The managed Edge recovery did not replace the exited process.");
      tabIds = recoveredTabs.tabs.map((tab) => tab.id);
      while (tabIds.length < 3) tabIds.push((await call("browser_tab_new", { url: `${origin}/recovered-${tabIds.length}`, activate: false })).createdTabId);
      for (let index = 0; index < tabIds.length; index += 1) await call("browser_navigate", { tabId: tabIds[index], url: `${origin}/recovered-${index}` });
      recovered = true;
    }
    if (iteration % 60 === 0) await sampleResources(`minute-${Math.floor((Date.now() - startedAt) / 60_000)}`);
    iteration += 1;
    await sleep(Math.min(intervalMs, Math.max(0, durationMs - (Date.now() - startedAt))));
  }
  await sampleResources("end");
  const first = resourceSamples[0]; const last = resourceSamples.at(-1);
  if (first && last && (last.totalWorkingSet > first.totalWorkingSet * 3 || last.totalHandles > first.totalHandles * 2 + 500)) {
    throw new Error("The isolated runtime showed obvious sustained resource growth.");
  }
  console.log(JSON.stringify({ durationMinutes, iterations: iteration, tabs: tabIds.length, recoveredAfterOwnedExit: recovered, transientRecoveries, resourceSamples: resourceSamples.map((sample) => ({ label: sample.label, workingSetMiB: Math.round(sample.totalWorkingSet / 1024 / 1024), handles: sample.totalHandles })) }, null, 2));
} finally {
  await runtime.dispose();
  await new Promise((resolve) => server.close(resolve));
}
