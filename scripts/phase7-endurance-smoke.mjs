import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const durationMinutes = Math.max(1, Number.parseInt(process.env.CODEX_BROWSER_ENDURANCE_MINUTES || "60", 10));
const durationMs = durationMinutes * 60_000;
const intervalMs = Math.max(250, Number.parseInt(process.env.CODEX_BROWSER_ENDURANCE_INTERVAL_MS || "2000", 10));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "ascii");

let origin = "";
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/small.bin") {
    const bytes = Buffer.from("phase7-local-download\n", "ascii");
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
    response.end(bytes); return;
  }
  if (url.pathname === "/dummy.pdf") {
    response.writeHead(200, { "content-type": "application/pdf", "content-length": pdfBytes.length, "cache-control": "no-store" });
    response.end(pdfBytes); return;
  }
  if (url.pathname === "/blocked") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Verify you are human</title><body><div class='cf-turnstile'>Local challenge fixture</div><script src='https://challenges.cloudflare.com/turnstile/v0/api.js'></script></body>");
    return;
  }
  if (url.pathname === "/popup") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Endurance popup</title><body><button>Popup ready</button></body>"); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><title>Phase 7 Endurance ${url.pathname}</title></head><body style="min-height:1400px">
    <input id="query" placeholder="Endurance query"><button id="tick" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);this.textContent='Tick '+this.dataset.count">Tick</button>
    <select><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
    <iframe srcdoc="<input placeholder='Frame endurance'><button>Frame action</button>"></iframe>
    <button id="popup" onclick="window.open('${origin}/popup','endurance-popup')">Open popup</button>
    <a href="${origin}/small.bin">Small download</a><a href="${origin}/dummy.pdf">Dummy PDF</a><p>Local endurance fixture</p>
  </body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("The endurance fixture failed to bind.");
origin = `http://127.0.0.1:${address.port}`;

const runtime = await startIsolatedEdgeSmoke({ suiteName: "phase7-endurance", clientName: "phase7-endurance-smoke" });
const lockPath = path.join(runtime.profileDir, ".codex-browser-profile.lock");
const parse = (result) => {
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(block.text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
const samples = [];
const diagnostics = [];

async function loadFixture(tabId, pathname) {
  await call("browser_navigate", { tabId, url: `${origin}${pathname}` });
  const waited = await call("browser_wait", { tabId, condition: "text", value: "Local endurance fixture", timeoutMs: 5_000 });
  if (!waited.satisfied) throw new Error("The endurance fixture did not become ready.");
}

async function sampleResources(label) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const pids = [runtime.broker.pid, lock.browserPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (process.platform !== "win32" || pids.length === 0) return;
  const command = `Get-Process -Id ${pids.join(",")} -ErrorAction Stop | Select-Object Id,WorkingSet64,HandleCount | ConvertTo-Json -Compress`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || "Resource sampling failed.")));
  });
  const entries = [JSON.parse(output)].flat();
  samples.push({ label, workingSet: entries.reduce((sum, item) => sum + Number(item.WorkingSet64 || 0), 0), handles: entries.reduce((sum, item) => sum + Number(item.HandleCount || 0), 0) });
}

try {
  const initial = await call("browser_tabs");
  let workingTabs = [initial.activeTabId];
  await loadFixture(workingTabs[0], "/one");
  const secondTab = (await call("browser_tab_new", { url: "about:blank", activate: false })).createdTabId;
  await loadFixture(secondTab, "/two"); workingTabs.push(secondTab);
  const blockedTab = (await call("browser_tab_new", { url: "about:blank", activate: false })).createdTabId;
  await call("browser_navigate", { tabId: blockedTab, url: `${origin}/blocked` });
  const blockedStatus = await call("browser_status");
  if (blockedStatus.tabs.find((tab) => tab.id === blockedTab)?.state !== "WAITING_USER") throw new Error("The endurance blocked tab did not freeze.");

  const startedAt = Date.now();
  let iteration = 0; let reconnects = 0; let browserRecoveries = 0; let popups = 0; let screenshots = 0; let downloads = 0; let pdfImports = 0;
  await sampleResources("start");
  while (Date.now() - startedAt < durationMs) {
    const tabId = workingTabs[iteration % workingTabs.length];
    if (iteration > 0 && iteration % 15 === 0) await loadFixture(tabId, `/loop-${iteration % 7}`);
    let snapshot = await call("browser_snapshot", { tabId, maxElements: 40, maxTextCharacters: 4_000 });
    const query = snapshot.elements.find((element) => element.placeholder === "Endurance query");
    const tick = snapshot.elements.find((element) => element.name.startsWith("Tick"));
    const frame = snapshot.elements.find((element) => element.placeholder === "Frame endurance");
    if (!query || !tick || !frame) {
      let pathname = "unavailable";
      try { pathname = new URL(snapshot.url).pathname; } catch {}
      throw new Error(`The endurance interactive fixture became incomplete (iteration=${iteration}, query=${Boolean(query)}, tick=${Boolean(tick)}, frame=${Boolean(frame)}, path=${pathname}, title=${snapshot.title}).`);
    }
    await call("browser_act", { tabId, action: "fill", ref: query.ref, text: `loop-${iteration}`, revision: snapshot.revision });
    await call("browser_act", { tabId, action: "click", ref: tick.ref, revision: snapshot.revision });
    await call("browser_act", { tabId, action: "fill", ref: frame.ref, text: `frame-${iteration}`, revision: snapshot.revision });

    if (iteration % 20 === 0) {
      const shot = await runtime.client.callTool({ name: "browser_screenshot", arguments: { tabId, scope: "viewport", maxWidth: 900 } });
      if (!shot.content?.some((item) => item.type === "image")) throw new Error("The endurance screenshot was missing.");
      screenshots += 1;
    }
    if (iteration % 30 === 0) {
      snapshot = await call("browser_snapshot", { tabId, maxElements: 40 });
      const popup = snapshot.elements.find((element) => element.name === "Open popup");
      await call("browser_act", { tabId, action: "click", ref: popup.ref, revision: snapshot.revision });
      await sleep(150);
      const listed = await call("browser_tabs");
      const opened = listed.tabs.find((tab) => tab.openerTabId === tabId);
      if (!opened) throw new Error("The endurance popup was not discovered.");
      await call("browser_tab_close", { tabId: opened.id, force: true });
      popups += 1;
    }
    if (iteration % 45 === 0) {
      const candidates = await call("paper_find_downloads", { tabId });
      const download = candidates.find((item) => item.text.includes("Small download"));
      if (download) { await call("paper_download", { tabId, candidateId: download.id }); downloads += 1; }
    }
    if (iteration % 90 === 0) {
      const candidates = await call("paper_find_downloads", { tabId });
      const pdf = candidates.find((item) => item.text.includes("Dummy PDF"));
      if (!pdf) throw new Error("The endurance PDF candidate disappeared.");
      const imported = await call("paper_download", { tabId, candidateId: pdf.id });
      if (!imported.documentId) throw new Error("The endurance PDF was not imported.");
      pdfImports += 1;
    }
    if (iteration > 0 && iteration % 60 === 0) {
      await runtime.rawCall("runtime.reconnect"); reconnects += 1;
      const tabs = await call("browser_tabs");
      workingTabs = tabs.tabs.filter((tab) => tab.state !== "WAITING_USER" && tab.url.startsWith(origin)).map((tab) => tab.id).slice(0, 2);
      while (workingTabs.length < 2) {
        const replacement = (await call("browser_tab_new", { url: "about:blank", activate: false })).createdTabId;
        await loadFixture(replacement, `/reconnect-${workingTabs.length}`); workingTabs.push(replacement);
      }
    }
    if (iteration > 0 && iteration % 120 === 0) {
      const before = JSON.parse(await readFile(lockPath, "utf8"));
      process.kill(before.browserPid);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) { try { process.kill(before.browserPid, 0); await sleep(100); } catch { break; } }
      const tabs = await call("browser_tabs");
      const after = JSON.parse(await readFile(lockPath, "utf8"));
      if (!after.browserPid || after.browserPid === before.browserPid) throw new Error("Owned Edge recovery did not replace the exited process.");
      workingTabs = tabs.tabs
        .filter((tab) => tab.state !== "WAITING_USER" && tab.url.startsWith(origin) && tab.url !== `${origin}/blocked`)
        .map((tab) => tab.id)
        .slice(0, 2);
      while (workingTabs.length < 2) workingTabs.push((await call("browser_tab_new", { url: "about:blank", activate: false })).createdTabId);
      for (let index = 0; index < workingTabs.length; index += 1) await loadFixture(workingTabs[index], `/recovered-${index}`);
      browserRecoveries += 1;
    }
    if (iteration % 30 === 0) {
      const diagnostic = await runtime.rawCall("runtime.test_diagnostics");
      diagnostics.push(diagnostic);
      if (diagnostic.attachedPageSessions > diagnostic.tabs || diagnostic.activeDownloads > 1) throw new Error("The endurance diagnostics found accumulating sessions or downloads.");
    }
    if (iteration % 30 === 0) await sampleResources(`iteration-${iteration}`);
    if (iteration > 0 && iteration % 75 === 0) {
      const closed = workingTabs.pop();
      if (closed) await call("browser_tab_close", { tabId: closed, force: true });
      const replacement = (await call("browser_tab_new", { url: "about:blank", activate: false })).createdTabId;
      await loadFixture(replacement, `/replacement-${iteration}`); workingTabs.push(replacement);
    }
    iteration += 1;
    await sleep(Math.min(intervalMs, Math.max(0, durationMs - (Date.now() - startedAt))));
  }
  await sampleResources("end");
  const first = samples[0]; const last = samples.at(-1);
  if (first && last && (last.workingSet > first.workingSet * 3 || last.handles > first.handles * 2 + 600)) throw new Error("The endurance run showed obvious sustained resource growth.");
  console.log(JSON.stringify({ durationMinutes, iterations: iteration, workingTabs: workingTabs.length, blockedTabContinued: true, reconnects, browserRecoveries, popups, screenshots, downloads, pdfImports, maxAttachedPageSessions: Math.max(...diagnostics.map((item) => item.attachedPageSessions), 0), resources: samples.map((sample) => ({ label: sample.label, workingSetMiB: Math.round(sample.workingSet / 1024 / 1024), handles: sample.handles })) }, null, 2));
} finally {
  await runtime.dispose();
  await new Promise((resolve) => server.close(resolve));
}
