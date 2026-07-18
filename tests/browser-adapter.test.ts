import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAdapter } from "../src/browser/browser-adapter";
import {
  ElectronWebContentsViewAdapter,
  type ElectronBrowserAdapterBindings,
} from "../src/electron/electron-browser-adapter";

const adapterCapabilities = [
  "listTabs",
  "createTab",
  "selectTab",
  "closeTab",
  "setViewportBounds",
  "getTabInfo",
  "refreshTabInfo",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "observe",
  "snapshot",
  "act",
  "getActionPolicyContext",
  "wait",
  "screenshot",
  "printToPdf",
  "inspectAuthentication",
  "collectChallengeEvidence",
  "listDialogs",
  "respondDialog",
  "dismissDialogs",
  "findDownloadLinks",
  "startDownload",
  "verifyProtectedResource",
  "getSessionSummary",
  "flushPersistentSession",
  "getStorageSummary",
  "clearSiteData",
  "clearAllBrowserData",
] as const satisfies readonly Exclude<keyof BrowserAdapter, "kind">[];

const tab = {
  id: "tab-a",
  title: "example.test",
  url: "https://example.test/start",
  state: "READY" as const,
  active: true,
  isLoading: false,
  canGoBack: true,
  canGoForward: true,
  attention: null,
  createdAt: "2026-07-17T00:00:00.000Z",
};

function createHarness() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const tabList = { activeTabId: tab.id, tabs: [tab] };
  let persistentSessionFlushed = false;

  const contents = {
    navigationHistory: {
      canGoBack: () => {
        record("canGoBack");
        return true;
      },
      canGoForward: () => {
        record("canGoForward");
        return true;
      },
      goBack: () => record("goBack"),
      goForward: () => record("goForward"),
    },
    getURL: () => {
      record("getURL");
      return "https://account.example.test/private?redacted=true";
    },
    isLoading: () => {
      record("isLoading");
      return false;
    },
    loadURL: async (url: string) => {
      record("loadURL", url);
    },
    reload: () => record("reload"),
    stop: () => record("stop"),
    printToPDF: async (options: unknown) => {
      record("printToPDF", options);
      return Buffer.from([1, 2, 3]);
    },
  } as unknown as ReturnType<ElectronBrowserAdapterBindings["resolveContents"]>;

  const dialog = {
    id: "dialog-a",
    tabId: tab.id,
    type: "confirm" as const,
    message: "Continue?",
    url: "https://example.test/start",
    sensitive: false,
    openedAt: "2026-07-17T00:00:00.000Z",
  };

  const bindings: ElectronBrowserAdapterBindings = {
    resolveContents: (tabId) => {
      record("resolveContents", tabId);
      return contents;
    },
    listTabs: () => {
      record("listTabs");
      return tabList;
    },
    createTab: (options) => {
      record("createTab", options);
      return { ...tabList, createdTabId: "tab-b" };
    },
    selectTab: (tabId) => {
      record("selectTab", tabId);
      return tabList;
    },
    closeTab: async (tabId, options) => {
      record("closeTab", tabId, options);
      return tabList;
    },
    setViewportBounds: (bounds) => record("setViewportBounds", bounds),
    listDialogs: (tabId) => {
      record("listDialogs", tabId);
      return [dialog];
    },
    respondDialog: async (tabId, request) => {
      record("respondDialog", tabId, request);
    },
    dismissDialogs: async (tabId) => {
      record("dismissDialogs", tabId);
    },
    startDownload: async (tabId, request) => {
      record("startDownload", tabId, request);
      return { jobId: "download-a", url: "https://example.test/file.pdf", tabId };
    },
    verifyProtectedResource: async (tabId, request) => {
      record("verifyProtectedResource", tabId, request);
      return { ok: true, status: 206 };
    },
    getSessionSummary: async () => {
      record("getSessionSummary");
      return { cookieCount: 2, sessionCookieCount: 1, encryptedBackupAvailable: true };
    },
    flushPersistentSession: async () => {
      record("flushPersistentSession");
      persistentSessionFlushed = true;
    },
    getStorageSummary: async (tabId) => {
      record("getStorageSummary", tabId);
      return { origin: "https://example.test", cookieCount: 2, sessionCookieCount: 1, cacheBytes: 100, siteStorageBytes: 200, permissionCount: 0, sessionRecoveryEnabled: false, sessionRecoveryAvailable: false, checkedAt: "2026-07-17T00:00:00.000Z" };
    },
    clearSiteData: async (tabId, options) => { record("clearSiteData", tabId, options); },
    clearAllBrowserData: async () => { record("clearAllBrowserData"); },
  };

  const adapter: BrowserAdapter = new ElectronWebContentsViewAdapter(bindings);
  return { adapter, calls, dialog, tabList, wasPersistentSessionFlushed: () => persistentSessionFlushed };
}

test("Electron adapter exposes the complete controlled BrowserAdapter capability surface", () => {
  const { adapter } = createHarness();
  const methods = Object.getOwnPropertyNames(ElectronWebContentsViewAdapter.prototype)
    .filter((name) => name !== "constructor")
    .sort();

  assert.equal(adapter.kind, "electron-web-contents-view");
  assert.deepEqual(methods, [...adapterCapabilities].sort());
  for (const capability of adapterCapabilities) {
    assert.equal(typeof adapter[capability], "function", capability);
  }
});

test("Electron adapter delegates tab, navigation, dialog, download, and session operations", async () => {
  const harness = createHarness();
  const { adapter, calls, dialog, tabList } = harness;

  assert.deepEqual(await adapter.listTabs(), tabList);
  assert.equal((await adapter.createTab({ url: "https://example.test/new", activate: false })).createdTabId, "tab-b");
  assert.deepEqual(await adapter.selectTab(tab.id), tabList);
  assert.deepEqual(await adapter.closeTab(tab.id, { force: true }), tabList);
  adapter.setViewportBounds({ x: 10, y: 20, width: 900, height: 600 });

  const info = adapter.getTabInfo(tab.id);
  assert.deepEqual(info, {
    id: tab.id,
    title: "account.example.test",
    url: "https://account.example.test/private?redacted=true",
    isLoading: false,
    canGoBack: true,
    canGoForward: true,
  });
  assert.deepEqual(await adapter.refreshTabInfo(tab.id), info);

  await adapter.navigate(tab.id, "https://example.test/next");
  await adapter.back(tab.id);
  await adapter.forward(tab.id);
  await adapter.reload(tab.id);
  await adapter.stop(tab.id);
  assert.deepEqual([...await adapter.printToPdf(tab.id)], [1, 2, 3]);

  assert.deepEqual(await adapter.listDialogs(tab.id), [dialog]);
  await adapter.respondDialog(tab.id, { dialogId: dialog.id, accept: true, promptText: "approved" });
  await adapter.dismissDialogs(tab.id);
  assert.deepEqual(
    await adapter.startDownload(tab.id, { candidateId: "candidate-a" }),
    { jobId: "download-a", url: "https://example.test/file.pdf", tabId: tab.id },
  );
  assert.deepEqual(
    await adapter.verifyProtectedResource(tab.id, { url: "https://example.test/file.pdf", expectedPdf: true }),
    { ok: true, status: 206 },
  );
  assert.deepEqual(
    await adapter.getSessionSummary(),
    { cookieCount: 2, sessionCookieCount: 1, encryptedBackupAvailable: true },
  );
  await adapter.flushPersistentSession();
  assert.equal(harness.wasPersistentSessionFlushed(), true);

  const callNames = calls.map((call) => call.name);
  for (const expected of [
    "listTabs",
    "createTab",
    "selectTab",
    "closeTab",
    "setViewportBounds",
    "loadURL",
    "goBack",
    "goForward",
    "reload",
    "stop",
    "printToPDF",
    "listDialogs",
    "respondDialog",
    "dismissDialogs",
    "startDownload",
    "verifyProtectedResource",
    "getSessionSummary",
    "flushPersistentSession",
  ]) {
    assert.ok(callNames.includes(expected), `${expected} was not delegated`);
  }
  assert.ok(!callNames.includes("executeJavaScript"));
  assert.ok(!callNames.includes("sendCommand"));
});
