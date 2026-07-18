import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startIsolatedEdgeSmoke, projectRoot } from "./lib/isolated-edge-smoke.mjs";

const pdfBytes = await readFile(path.join(projectRoot, "output", "test-fixtures", "dummy.pdf"));
let slowDownloadCancelled = false;

const childServer = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><body><button id="frame-button" onclick="document.body.dataset.clicked='yes';this.textContent='Frame clicked'">Frame action</button><input id="frame-input" placeholder="Frame input"></body></html>`);
});
await new Promise((resolve, reject) => { childServer.once("error", reject); childServer.listen(0, "127.0.0.1", resolve); });
const childAddress = childServer.address();
if (!childAddress || typeof childAddress === "string") throw new Error("Cross-origin fixture failed to bind.");

let mainOrigin = "";
const mainServer = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error(`[edge-fixture] ${request.method} ${url.pathname}`);
  if (url.pathname === "/dummy.pdf" || url.pathname === "/download.bin") {
    response.writeHead(200, {
      "content-type": url.pathname === "/download.bin" ? "application/octet-stream" : "application/pdf",
      "content-length": pdfBytes.length,
      "cache-control": "no-store",
    });
    response.end(pdfBytes);
    return;
  }
  if (url.pathname === "/slow.bin") {
    response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    let sent = 0;
    const timer = setInterval(() => {
      if (response.destroyed) { slowDownloadCancelled = true; clearInterval(timer); return; }
      response.write(Buffer.alloc(64 * 1024, 7));
      sent += 1;
      if (sent >= 80) { clearInterval(timer); response.end(); }
    }, 40);
    response.on("close", () => { if (sent < 80) slowDownloadCancelled = true; clearInterval(timer); });
    return;
  }
  if (url.pathname === "/page2") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><html><head><title>Phase 2 Page Two</title></head><body>Second page marker</body></html>");
    return;
  }
  if (url.pathname === "/popup") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><html><head><title>Phase 2 Popup</title></head><body><input placeholder='Popup input'><button onclick=\"document.body.dataset.done='yes'\">Popup action</button></body></html>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><title>Phase 2 Edge Fixture</title></head><body style="min-height:1800px">
    <form><label>Username <input id="username" name="username" placeholder="Username"></label><label>Password <input id="password" type="password" placeholder="Password"></label><button id="login" type="submit">Sign in</button></form>
    <button id="ordinary" onclick="document.getElementById('status').textContent='Clicked and ready'">Ordinary action</button><div id="status">Waiting</div>
    <select id="choice"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
    <label><input id="agree" type="checkbox"> Agree</label>
    <button id="alert" onclick="alert('ordinary alert')">Alert</button><button id="confirm" onclick="confirm('ordinary confirm')">Confirm</button>
    <button id="prompt" onclick="prompt('Display name','guest')">Prompt</button><button id="sensitive-prompt" onclick="prompt('Enter OTP token','')">Sensitive prompt</button>
    <button id="popup" onclick="window.open('${mainOrigin}/popup','phase2popup')">Open popup</button><a id="blank" target="_blank" href="${mainOrigin}/popup">Blank popup</a>
    <a id="download" href="${mainOrigin}/download.bin?token=secret-value&expires=999">Download PDF</a><a id="slow" href="${mainOrigin}/slow.bin?signature=secret">Slow download</a>
    <iframe id="same-frame" srcdoc="<button onclick=&quot;this.textContent='Same frame clicked'&quot;>Same frame action</button><input placeholder='Same frame input'>"></iframe>
    <iframe id="cross-frame" src="http://127.0.0.1:${childAddress.port}/frame"></iframe>
    <script>setTimeout(()=>{const n=document.createElement('div');n.id='delayed';n.textContent='Delayed marker';document.body.appendChild(n)},400)</script>
  </body></html>`);
});
await new Promise((resolve, reject) => { mainServer.once("error", reject); mainServer.listen(0, "127.0.0.1", resolve); });
const mainAddress = mainServer.address();
if (!mainAddress || typeof mainAddress === "string") throw new Error("Main fixture failed to bind.");
mainOrigin = `http://127.0.0.1:${mainAddress.port}`;

const runtime = await startIsolatedEdgeSmoke();
const { client } = runtime;
const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
const expectError = async (name, args, expected) => {
  try { await call(name, args); } catch (error) { if (error.name === expected) return; throw error; }
  throw new Error(`${name} did not return ${expected}.`);
};
const findElement = (snapshot, predicate, label) => {
  const element = snapshot.elements.find(predicate);
  if (!element) throw new Error(`Snapshot did not contain ${label}.`);
  return element;
};

const results = {};
try {
  const initialTabs = await call("browser_tabs");
  const tabId = initialTabs.activeTabId;
  await call("browser_navigate", { tabId, url: `${mainOrigin}/` });
  await call("browser_wait", { tabId, condition: "text", value: "Delayed marker", timeoutMs: 3000 });
  let snapshot = await call("browser_snapshot", { tabId, maxElements: 100, maxTextCharacters: 10000 });
  const username = findElement(snapshot, (e) => e.placeholder === "Username", "username field");
  const password = findElement(snapshot, (e) => e.type === "password", "password field");
  const login = findElement(snapshot, (e) => e.name === "Sensitive action", "sensitive login submit");
  const ordinary = findElement(snapshot, (e) => e.name.includes("Ordinary action"), "ordinary button");
  const choice = findElement(snapshot, (e) => e.tag === "select", "select");
  const agree = findElement(snapshot, (e) => e.type === "checkbox", "checkbox");
  const frameInput = findElement(snapshot, (e) => e.placeholder === "Same frame input", "same-origin iframe input");
  const crossInput = findElement(snapshot, (e) => e.placeholder === "Frame input", "cross-origin iframe input");
  await call("browser_act", { tabId, action: "fill", ref: username.ref, text: "phase2-user", revision: snapshot.revision });
  await call("browser_act", { tabId, action: "press", ref: username.ref, key: "End", revision: snapshot.revision });
  await call("browser_act", { tabId, action: "click", ref: ordinary.ref, revision: snapshot.revision });
  await call("browser_wait", { tabId, condition: "text", value: "Clicked and ready", timeoutMs: 2000 });
  await call("browser_act", { tabId, action: "select", ref: choice.ref, value: "beta", revision: snapshot.revision });
  await call("browser_act", { tabId, action: "check", ref: agree.ref, revision: snapshot.revision });
  await call("browser_act", { tabId, action: "uncheck", ref: agree.ref, revision: snapshot.revision });
  await call("browser_act", { tabId, action: "scroll", deltaY: 300, revision: snapshot.revision });
  await call("browser_act", { tabId, action: "fill", ref: frameInput.ref, text: "same-frame", revision: snapshot.revision });
  await call("browser_act", { tabId, action: "fill", ref: crossInput.ref, text: "cross-frame", revision: snapshot.revision });
  snapshot = await call("browser_snapshot", { tabId, maxElements: 100, maxTextCharacters: 10000 });
  if (findElement(snapshot, (e) => e.tag === "select", "updated select").value !== "beta") throw new Error("Select action did not update the page value.");
  if (findElement(snapshot, (e) => e.type === "checkbox", "updated checkbox").checked !== false) throw new Error("Check/uncheck actions did not update the page state.");
  await expectError("browser_act", { tabId, action: "fill", ref: findElement(snapshot, (e) => e.type === "password", "updated password").ref, text: "must-not-enter", revision: snapshot.revision }, "USER_ACTION_REQUIRED");
  await expectError("browser_act", { tabId, action: "click", ref: findElement(snapshot, (e) => e.name === "Sensitive action", "updated login").ref, revision: snapshot.revision }, "USER_ACTION_REQUIRED");
  const screenshot = await client.callTool({ name: "browser_screenshot", arguments: { tabId, scope: "viewport", maxWidth: 1200 } });
  const screenshotMeta = parse({ ...screenshot, content: screenshot.content.filter((item) => item.type === "text") });
  if (!screenshot.content.some((item) => item.type === "image") || screenshotMeta.redactionCount < 1) throw new Error("Sensitive screenshot redaction was not applied.");
  const elementScreenshot = await client.callTool({ name: "browser_screenshot", arguments: { tabId, scope: "element", ref: findElement(snapshot, (e) => e.placeholder === "Username", "element screenshot field").ref, maxWidth: 600 } });
  if (!elementScreenshot.content.some((item) => item.type === "image")) throw new Error("Element screenshot was not returned.");

  const alertButton = findElement(snapshot, (e) => e.name === "Alert", "alert button");
  await call("browser_act", { tabId, action: "click", ref: alertButton.ref, revision: snapshot.revision });
  const alertDialog = (await call("browser_dialogs", { tabId })).dialogs[0];
  if (!alertDialog || alertDialog.type !== "alert") throw new Error("Alert dialog was not reported.");
  await call("browser_dialog_respond", { dialogId: alertDialog.id, accept: true });
  snapshot = await call("browser_snapshot", { tabId });
  const confirmButton = findElement(snapshot, (e) => e.name === "Confirm", "confirm button");
  await call("browser_act", { tabId, action: "click", ref: confirmButton.ref, revision: snapshot.revision });
  const confirmDialog = (await call("browser_dialogs", { tabId })).dialogs[0];
  await call("browser_dialog_respond", { dialogId: confirmDialog.id, accept: false });

  snapshot = await call("browser_snapshot", { tabId });
  await call("browser_act", { tabId, action: "click", ref: findElement(snapshot, (e) => e.name === "Prompt", "prompt button").ref, revision: snapshot.revision });
  const promptDialog = (await call("browser_dialogs", { tabId })).dialogs[0];
  if (!promptDialog || promptDialog.type !== "prompt" || promptDialog.sensitive) throw new Error("Ordinary prompt was not reported correctly.");
  await call("browser_dialog_respond", { dialogId: promptDialog.id, accept: true, promptText: "phase2" });
  snapshot = await call("browser_snapshot", { tabId });
  await call("browser_act", { tabId, action: "click", ref: findElement(snapshot, (e) => e.name === "Sensitive prompt", "sensitive prompt button").ref, revision: snapshot.revision });
  const sensitivePrompt = (await call("browser_dialogs", { tabId })).dialogs[0];
  if (!sensitivePrompt?.sensitive) throw new Error("Sensitive prompt was not classified.");
  await expectError("browser_dialog_respond", { dialogId: sensitivePrompt.id, accept: true, promptText: "must-not-enter" }, "USER_ACTION_REQUIRED");
  await call("browser_dialog_respond", { dialogId: sensitivePrompt.id, accept: false });

  snapshot = await call("browser_snapshot", { tabId });
  const popupButton = findElement(snapshot, (e) => e.name.includes("Open popup"), "popup button");
  await call("browser_act", { tabId, action: "click", ref: popupButton.ref, revision: snapshot.revision });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const popupTabs = await call("browser_tabs");
  const popup = popupTabs.tabs.find((tab) => tab.title.includes("Phase 2 Popup"));
  if (!popup || popup.openerTabId !== tabId) throw new Error("Popup opener relationship was not retained.");
  await call("browser_tab_select", { tabId: popup.id });
  const popupSnapshot = await call("browser_snapshot", { tabId: popup.id });
  const popupInput = findElement(popupSnapshot, (e) => e.placeholder === "Popup input", "popup input");
  await call("browser_act", { tabId: popup.id, action: "fill", ref: popupInput.ref, text: "popup", revision: popupSnapshot.revision });
  await call("browser_tab_close", { tabId: popup.id });
  await call("browser_tab_select", { tabId });

  snapshot = await call("browser_snapshot", { tabId });
  await call("browser_act", { tabId, action: "click", ref: findElement(snapshot, (e) => e.text === "Blank popup", "target blank link").ref, revision: snapshot.revision });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const blankTabs = await call("browser_tabs");
  const blankPopup = blankTabs.tabs.find((candidate) => candidate.id !== tabId && candidate.title.includes("Phase 2 Popup"));
  if (!blankPopup || blankPopup.openerTabId !== tabId) throw new Error("target=_blank popup was not registered with its opener.");
  await call("browser_tab_close", { tabId: blankPopup.id });
  await call("browser_tab_select", { tabId });

  await call("browser_navigate", { tabId, url: `${mainOrigin}/page2` });
  await call("browser_wait", { tabId, condition: "url_contains", value: "/page2", timeoutMs: 2000 });
  await call("browser_back", { tabId });
  await call("browser_forward", { tabId });
  await call("browser_reload", { tabId });
  await call("browser_navigate", { tabId, url: `${mainOrigin}/` });
  const staleSnapshot = await call("browser_snapshot", { tabId });
  await runtime.rawCall("runtime.reconnect");
  await expectError("browser_act", { tabId, action: "click", ref: staleSnapshot.elements[0].ref, revision: staleSnapshot.revision }, "STALE_SNAPSHOT");

  const waitPromise = client.callTool({ name: "browser_wait", arguments: { tabId, condition: "text", value: "never-arrives", timeoutMs: 10000 } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await call("browser_stop");
  const cancelledWait = parse(await waitPromise);
  if (cancelledWait.status !== "cancelled") throw new Error("Wait cancellation was not reported.");

  await call("browser_navigate", { tabId, url: `${mainOrigin}/` });
  const candidates = await call("paper_find_downloads", { tabId });
  if (!candidates.length || candidates.some((candidate) => /secret-value|expires=|token=/.test(JSON.stringify(candidate)))) throw new Error("Download candidates exposed signed query data.");
  const pdfCandidate = candidates.find((candidate) => candidate.text.includes("Download PDF"));
  const downloaded = await call("paper_download", { tabId, candidateId: pdfCandidate.id });
  if (!downloaded.documentId) throw new Error("Downloaded PDF was not imported.");
  const documents = await call("document_list");
  await call("document_read", { documentId: downloaded.documentId, startPage: 1, endPage: 1 });
  await call("document_search", { documentId: downloaded.documentId, query: "Dummy" });

  await call("browser_navigate", { tabId, url: `${mainOrigin}/dummy.pdf?token=visible-secret` });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const visibleCandidates = await call("paper_find_downloads", { tabId });
  const visible = visibleCandidates.find((candidate) => candidate.source === "loaded_pdf");
  if (!visible) throw new Error("Visible PDF was not captured from the loaded response.");
  const visibleDownload = await call("paper_download", { tabId, candidateId: visible.id });
  if (!visibleDownload.documentId) throw new Error("Visible PDF was not saved and imported.");

  await call("browser_navigate", { tabId, url: `${mainOrigin}/` });
  const slowCandidates = await call("paper_find_downloads", { tabId });
  const slow = slowCandidates.find((candidate) => candidate.text.includes("Slow download"));
  const slowPromise = client.callTool({ name: "paper_download", arguments: { tabId, candidateId: slow.id } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await call("browser_stop");
  await slowPromise;
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (!slowDownloadCancelled) throw new Error("Stopping the task did not cancel the associated download.");

  results.tabs = true;
  results.navigation = true;
  results.snapshotAndStaleRefs = true;
  results.actionsAndSensitiveBlocking = true;
  results.iframes = true;
  results.popup = true;
  results.dialogs = true;
  results.screenshotRedaction = screenshotMeta.redactionCount;
  results.waitAndCancellation = true;
  results.downloadAndCancellation = true;
  results.pdfImport = documents.length;
  results.reconnectInvalidatedRefs = true;
  console.log(JSON.stringify(results, null, 2));
} finally {
  await runtime.dispose();
  await new Promise((resolve) => mainServer.close(resolve));
  await new Promise((resolve) => childServer.close(resolve));
}
