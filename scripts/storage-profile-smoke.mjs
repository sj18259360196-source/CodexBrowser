import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const secretMarkers = ["phase4-password-secret", "phase4-otp-secret", "phase4-iframe-secret"];

function fixtureServer(label) {
  return createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const cookieNames = new Set((request.headers.cookie || "").split(";").map((part) => part.split("=")[0]?.trim()).filter(Boolean));
    if (url.pathname === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end("self.addEventListener('fetch',()=>{});");
      return;
    }
    if (url.pathname === "/cache-item") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "public,max-age=3600" });
      response.end(`${label}-cache-item`);
      return;
    }
    if (url.pathname === "/seed") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": [
          `phase4_persistent_${label}=present; Max-Age=3600; Path=/; SameSite=Lax`,
          `phase4_session_${label}=present; Path=/; SameSite=Lax`,
        ],
      });
      response.end(`<!doctype html><title>${label} seed</title><body>seeding<script>
        (async()=>{
          localStorage.setItem('phase4-${label}','present');
          await new Promise((resolve,reject)=>{const r=indexedDB.open('phase4-${label}',1);r.onupgradeneeded=()=>r.result.createObjectStore('items');r.onsuccess=()=>{const tx=r.result.transaction('items','readwrite');tx.objectStore('items').put('present','state');tx.oncomplete=resolve;tx.onerror=reject};r.onerror=reject});
          if ('caches' in window) await (await caches.open('phase4-${label}')).add('/cache-item');
          if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
          location.replace('/status');
        })().catch(()=>{document.body.textContent='seed failed'});
      </script></body>`);
      return;
    }
    if (url.pathname === "/sensitive") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>Phase 4 sensitive fixture</title><body>
        <form><input type="password" autocomplete="current-password" value="${secretMarkers[0]}">
        <input type="password" autocomplete="new-password" value="${secretMarkers[0]}">
        <input autocomplete="one-time-code" value="${secretMarkers[1]}">
        <input id="dynamic" value="${secretMarkers[0]}"><button type="submit">Sign in</button></form>
        <iframe srcdoc="<input type='password' value='${secretMarkers[2]}'>"></iframe>
        <script>document.getElementById('dynamic').type='password'</script></body>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${label} status</title><body><div id="status">checking</div><script>
      (async()=>{
        let idb=false; try { idb=await new Promise((resolve)=>{const r=indexedDB.open('phase4-${label}');r.onsuccess=()=>{if(!r.result.objectStoreNames.contains('items'))return resolve(false);const q=r.result.transaction('items').objectStore('items').get('state');q.onsuccess=()=>resolve(q.result==='present');q.onerror=()=>resolve(false)};r.onerror=()=>resolve(false)}) } catch {}
        const cache=!!(await caches.keys()).find(n=>n==='phase4-${label}');
        document.getElementById('status').textContent=JSON.stringify({persistent:${cookieNames.has(`phase4_persistent_${label}`)},session:${cookieNames.has(`phase4_session_${label}`)},local:localStorage.getItem('phase4-${label}')==='present',idb,cache,serviceWorker:(await navigator.serviceWorker.getRegistrations()).length>0});
      })();
    </script></body>`);
  });
}

async function listen(server, publicHost = "127.0.0.1") {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Storage fixture failed to bind.");
  return `http://${publicHost}:${address.port}`;
}

const serverA = fixtureServer("a");
const serverB = fixtureServer("b");
const originA = await listen(serverA);
const originB = await listen(serverB, "localhost");
let runtime;
let profileDir;
let stage = "startup";

const parse = (result) => {
  const item = result.content?.find((entry) => entry.type === "text");
  if (!item) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(item.text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (client, name, args = {}) => parse(await client.callTool({ name, arguments: args }));
const waitForText = (client, tabId, value) => call(client, "browser_wait", { tabId, condition: "text", value, timeoutMs: 8_000 });
const observeStatus = async (client, tabId) => {
  await waitForText(client, tabId, "persistent");
  const observed = await call(client, "browser_observe", { tabId, maxCharacters: 5_000 });
  const match = observed.text.match(/\{[^{}]+\}/);
  if (!match) throw new Error("Storage status fixture did not report a state object.");
  return JSON.parse(match[0]);
};
const navigate = async (client, tabId, url) => call(client, "browser_navigate", { tabId, url });

try {
  stage = "first start";
  runtime = await startIsolatedEdgeSmoke({ suiteName: "storage-a", clientName: "storage-profile-smoke", preserveProfileOnDispose: true });
  profileDir = runtime.profileDir;
  let tabs = await call(runtime.client, "browser_tabs");
  const tabId = tabs.activeTabId;
  await navigate(runtime.client, tabId, `${originA}/seed`);
  const seededA = await observeStatus(runtime.client, tabId);
  if (!seededA.persistent || !seededA.local || !seededA.idb || !seededA.cache || !seededA.serviceWorker) throw new Error("Origin A storage was not initialized.");
  await runtime.dispose();

  stage = "profile restart";
  runtime = await startIsolatedEdgeSmoke({ suiteName: "storage-b", clientName: "storage-profile-smoke", profileDir, preserveProfileOnDispose: true });
  tabs = await call(runtime.client, "browser_tabs");
  const restartedTab = tabs.activeTabId;
  await navigate(runtime.client, restartedTab, `${originA}/status`);
  const restartedA = await observeStatus(runtime.client, restartedTab);
  if (!restartedA.persistent || !restartedA.local || !restartedA.idb || !restartedA.cache) {
    throw new Error(`Persistent browser storage did not survive a normal restart: ${JSON.stringify({ persistent: restartedA.persistent, local: restartedA.local, idb: restartedA.idb, cache: restartedA.cache })}`);
  }

  await navigate(runtime.client, restartedTab, `${originB}/seed`);
  const seededB = await observeStatus(runtime.client, restartedTab);
  if (!seededB.persistent || !seededB.local || !seededB.idb) throw new Error("Origin B storage was not initialized.");
  await navigate(runtime.client, restartedTab, `${originA}/status`);
  stage = "current-site clear";
  const siteConfirmation = await runtime.rawCall("storage.request_action", { action: "clear_site", tabId: restartedTab, includePermissions: true });
  await runtime.rawCall("storage.confirm_action", { confirmationId: siteConfirmation.id });
  const clearedA = await observeStatus(runtime.client, restartedTab);
  if (clearedA.persistent || clearedA.local || clearedA.idb || clearedA.cache || clearedA.serviceWorker) throw new Error("Current-site clearing left managed site data behind.");
  let staleRejected = false;
  try { await runtime.rawCall("storage.confirm_action", { confirmationId: siteConfirmation.id }); } catch (error) { staleRejected = error.name === "CONFIRMATION_STALE"; }
  if (!staleRejected) throw new Error("A browser data confirmation was reusable.");
  await navigate(runtime.client, restartedTab, `${originB}/status`);
  const unaffectedB = await observeStatus(runtime.client, restartedTab);
  if (!unaffectedB.persistent || !unaffectedB.local || !unaffectedB.idb) throw new Error("Current-site clearing affected another origin.");

  stage = "all-data clear";
  const allConfirmation = await runtime.rawCall("storage.request_action", { action: "clear_all" });
  await runtime.rawCall("storage.confirm_action", { confirmationId: allConfirmation.id }, 90_000);
  await navigate(runtime.client, restartedTab, `${originB}/status`);
  const clearedB = await observeStatus(runtime.client, restartedTab);
  if (clearedB.persistent || clearedB.local || clearedB.idb || clearedB.cache || clearedB.serviceWorker) throw new Error("All-data clearing left managed site data behind.");

  stage = "sensitive fields";
  await navigate(runtime.client, restartedTab, `${originA}/sensitive`);
  const snapshot = await call(runtime.client, "browser_snapshot", { tabId: restartedTab, maxElements: 80, maxTextCharacters: 8_000 });
  const serializedSnapshot = JSON.stringify(snapshot);
  if (secretMarkers.some((secret) => serializedSnapshot.includes(secret))) throw new Error("A sensitive field value leaked through the snapshot.");
  const sensitive = snapshot.elements.filter((element) => element.sensitive);
  if (sensitive.length < 5 || sensitive.some((element) => element.value)) throw new Error("Autofill-like sensitive fields were not conservatively classified.");
  const screenshotResult = await runtime.client.callTool({ name: "browser_screenshot", arguments: { tabId: restartedTab, scope: "viewport", maxWidth: 1200 } });
  const screenshotMeta = parse({ ...screenshotResult, content: screenshotResult.content.filter((item) => item.type === "text") });
  if (screenshotMeta.redactionCount < 5) throw new Error("Sensitive screenshot redaction did not cover all fixture fields.");

  const profileStatus = await call(runtime.client, "browser_profile_status");
  const storageSummary = await call(runtime.client, "browser_storage_summary", { tabId: restartedTab });
  const publicOutput = JSON.stringify({ profileStatus, storageSummary });
  if (profileDir && publicOutput.includes(profileDir)) throw new Error("A profile path leaked through MCP.");
  if (secretMarkers.some((secret) => publicOutput.includes(secret))) throw new Error("Sensitive fixture data leaked through MCP.");
  if (Object.keys(storageSummary).some((key) => /cookieNames|cookieValues|password/i.test(key))) throw new Error("Storage summary exposed a forbidden field.");

  stage = "profile reset";
  const resetConfirmation = await runtime.rawCall("storage.request_action", { action: "reset_profile" });
  await runtime.rawCall("storage.confirm_action", { confirmationId: resetConfirmation.id }, 60_000);
  const resetTabs = await call(runtime.client, "browser_tabs");
  const resetTab = resetTabs.activeTabId;
  await navigate(runtime.client, resetTab, `${originA}/status`);
  const resetA = await observeStatus(runtime.client, resetTab);
  if (resetA.persistent || resetA.local || resetA.idb || resetA.cache || resetA.serviceWorker) throw new Error("Profile reset retained prior website data.");

  console.log(JSON.stringify({
    persistentRestart: true,
    sessionCookieNormalSemantics: typeof restartedA.session === "boolean",
    currentSiteClear: true,
    otherOriginUnaffected: true,
    allDataClear: true,
    sensitiveSnapshotAndScreenshot: true,
    confirmationOneTime: true,
    profileReset: true,
  }, null, 2));
} catch (error) {
  throw new Error(`Phase 4 storage smoke failed during ${stage}: ${error instanceof Error ? error.message : "unknown error"}`);
} finally {
  if (runtime) await runtime.dispose().catch(() => undefined);
  if (profileDir) {
    const cleanupRuntime = await startIsolatedEdgeSmoke({ suiteName: "storage-cleanup", clientName: "storage-profile-cleanup", profileDir }).catch(() => null);
    await cleanupRuntime?.dispose().catch(() => undefined);
  }
  await Promise.all([
    new Promise((resolve) => serverA.close(resolve)),
    new Promise((resolve) => serverB.close(resolve)),
  ]);
}
