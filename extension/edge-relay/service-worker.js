const RELAY_ORIGIN = "http://127.0.0.1:32192";
const PROTOCOL_VERSION = "1.3";
let running = false;
let eventQueue = [];
let responseQueue = [];
const attachedTabs = new Set();
const targetIdsByTab = new Map();

const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (value) => chrome.storage.local.set(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  const response = await fetch(`${RELAY_ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Relay returned ${response.status}.`);
  return value;
}

async function pair() {
  const value = await post("/pair", { protocolVersion: PROTOCOL_VERSION });
  if (!value.token) throw new Error("Relay did not return a pairing token.");
  await storageSet({ relayToken: value.token, pairedAt: new Date().toISOString() });
  ensureLoop();
  return { ok: true };
}

function queueEvent(method, params = {}, sessionId) {
  eventQueue.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  if (eventQueue.length > 1000) eventQueue = eventQueue.slice(-1000);
}

async function targets() { return chrome.debugger.getTargets(); }
async function targetById(targetId) { return (await targets()).find((target) => target.id === targetId); }
async function targetForTab(tabId) { const target = (await targets()).find((candidate) => candidate.tabId === tabId && candidate.type === "page"); if (target) targetIdsByTab.set(tabId, target.id); return target; }
const sessionForTab = (tabId) => `relay-tab-${tabId}`;
const tabForSession = (sessionId) => Number(String(sessionId || "").replace(/^relay-tab-/, ""));

function targetInfo(target) {
  return { targetId: target.id, type: target.type, title: target.title || "", url: target.url || "", attached: Boolean(target.attached) };
}

async function attachTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Relay target tab is invalid.");
  if (!attachedTabs.has(tabId)) {
    try { await chrome.debugger.attach({ tabId }, "1.3"); } catch (error) {
      if (!String(error?.message || error).includes("already attached")) throw error;
    }
    attachedTabs.add(tabId);
  }
  return sessionForTab(tabId);
}

async function emulateBrowserCommand(command) {
  const { method, params = {} } = command;
  if (method === "Target.setDiscoverTargets" || method === "Browser.setDownloadBehavior") return {};
  if (method === "Target.getTargets") return { targetInfos: (await targets()).filter((t) => t.type === "page").map(targetInfo) };
  if (method === "Target.getTargetInfo") {
    const target = await targetById(String(params.targetId || "")); if (!target) throw new Error("Relay target was not found.");
    return { targetInfo: targetInfo(target) };
  }
  if (method === "Target.createTarget") {
    const tab = await chrome.tabs.create({ url: String(params.url || "about:blank"), active: true });
    for (let index = 0; index < 20; index += 1) { const target = await targetForTab(tab.id); if (target) return { targetId: target.id }; await sleep(50); }
    throw new Error("Ordinary Edge did not register the new tab target.");
  }
  if (method === "Target.attachToTarget") {
    const target = await targetById(String(params.targetId || "")); if (!target?.tabId) throw new Error("Relay target tab was not found.");
    return { sessionId: await attachTab(target.tabId) };
  }
  if (method === "Target.activateTarget") {
    const target = await targetById(String(params.targetId || "")); if (!target?.tabId) throw new Error("Relay target tab was not found.");
    const tab = await chrome.tabs.update(target.tabId, { active: true }); if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  if (method === "Target.closeTarget") {
    const target = await targetById(String(params.targetId || "")); if (!target?.tabId) return { success: false };
    await chrome.tabs.remove(target.tabId); return { success: true };
  }
  if (method === "Browser.getVersion") return { product: "Microsoft Edge", protocolVersion: PROTOCOL_VERSION, userAgent: navigator.userAgent };
  if (method === "Browser.getWindowForTarget") {
    const target = await targetById(String(params.targetId || "")); if (!target?.tabId) throw new Error("Relay target tab was not found.");
    const tab = await chrome.tabs.get(target.tabId); return { windowId: tab.windowId };
  }
  if (method === "Browser.setWindowBounds") { await chrome.windows.update(Number(params.windowId), params.bounds || {}); return {}; }
  if (method === "Storage.getCookies") return { cookies: [] };
  if (method === "Storage.getUsageAndQuota") return { usage: 0, quota: 0, usageBreakdown: [] };
  if (method === "Storage.clearCookies" || method === "Storage.clearDataForOrigin" || method === "Browser.resetPermissions") {
    throw new Error("Browsing-data changes are unavailable in ordinary Edge relay mode.");
  }
  if (method === "Browser.cancelDownload") return {};
  return null;
}

async function execute(command) {
  const emulated = await emulateBrowserCommand(command);
  if (emulated !== null) return emulated;
  const tabId = tabForSession(command.sessionId);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Relay command is missing a valid tab session.");
  await attachTab(tabId);
  return chrome.debugger.sendCommand({ tabId }, command.method, command.params || {});
}

async function processCommands(commands) {
  for (const command of Array.isArray(commands) ? commands.slice(0, 100) : []) {
    try { responseQueue.push({ id: command.id, result: await execute(command) }); }
    catch (error) { responseQueue.push({ id: command.id, error: { message: String(error?.message || error).slice(0, 500) } }); }
  }
}

async function exchangeLoop() {
  if (running) return; running = true;
  let backoff = 500;
  try {
    while (true) {
      const { relayToken } = await storageGet(["relayToken"]);
      if (!relayToken) return;
      const responses = responseQueue.splice(0, 200); const events = eventQueue.splice(0, 500);
      try {
        const value = await post("/exchange", { token: relayToken, responses, events, protocolVersion: PROTOCOL_VERSION });
        await storageSet({ relayConnectedAt: new Date().toISOString(), relayError: "" });
        backoff = 500; await processCommands(value.commands);
      } catch (error) {
        responseQueue.unshift(...responses); eventQueue.unshift(...events);
        const message = String(error?.message || error).slice(0, 300);
        await storageSet({ relayError: message });
        if (/pairing is invalid/i.test(message)) { await chrome.storage.local.remove("relayToken"); return; }
        await sleep(backoff); backoff = Math.min(backoff * 2, 10_000);
      }
    }
  } finally { running = false; }
}

function ensureLoop() { void exchangeLoop(); }
chrome.runtime.onInstalled.addListener(ensureLoop);
chrome.runtime.onStartup.addListener(ensureLoop);
chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(ensureLoop);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "pair") { pair().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) })); return true; }
  if (message?.type === "status") { storageGet(["relayToken", "relayConnectedAt", "relayError"]).then((state) => sendResponse({ ok: true, paired: Boolean(state.relayToken), connectedAt: state.relayConnectedAt || "", error: state.relayError || "" })); return true; }
  if (message?.type === "disconnect") { chrome.storage.local.remove(["relayToken", "relayConnectedAt", "relayError"]).then(() => sendResponse({ ok: true })); return true; }
});

chrome.debugger.onEvent.addListener((source, method, params) => { if (source.tabId) queueEvent(method, params || {}, sessionForTab(source.tabId)); });
chrome.debugger.onDetach.addListener((source, reason) => { if (source.tabId) { attachedTabs.delete(source.tabId); queueEvent("Inspector.detached", { reason }, sessionForTab(source.tabId)); } });
chrome.tabs.onCreated.addListener(async (tab) => { const target = await targetForTab(tab.id); if (target) queueEvent("Target.targetCreated", { targetInfo: targetInfo(target) }); });
chrome.tabs.onUpdated.addListener(async (tabId) => { const target = await targetForTab(tabId); if (target) queueEvent("Target.targetInfoChanged", { targetInfo: targetInfo(target) }); });
chrome.tabs.onRemoved.addListener((tabId) => { attachedTabs.delete(tabId); const targetId = targetIdsByTab.get(tabId); targetIdsByTab.delete(tabId); if (targetId) queueEvent("Target.targetDestroyed", { targetId }); });
ensureLoop();
