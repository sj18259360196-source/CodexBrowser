import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type DownloadItem as ElectronDownloadJob,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import { createServer, type Server, type Socket } from "node:net";
import { promises as fs } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BROWSER_PIPE_NAME,
  type AppState,
  type AssistanceKind,
  type AuthPrompt,
  type BrowserAction,
  type BrowserDialogPrompt,
  type BrowserObservation,
  type BrowserSkill,
  type BrowserSkillRisk,
  type BrowserSkillRun,
  type BrowserSkillStatus,
  type BrowserSkillTarget,
  type BrowserTabSummary,
  type BrowserWaitCondition,
  type CredentialVaultStatus,
  type DownloadItem,
  type HumanAssistance,
  type InteractiveElementSnapshot,
  type InteractivePageSnapshot,
  type PipeRequest,
  type PipeResponse,
  type SessionHealth,
  type TaskItem,
  type TaskStatus,
} from "../shared/contracts";
import {
  captureInteractiveSnapshot,
  performReferencedAction,
  waitForBrowserCondition,
} from "./browser-actions";
import { DocumentService } from "./document-service";
import {
  BrowserSkillService,
  isLearnableBrowserSkillMethod,
  isTraceableBrowserSkillMethod,
  type BrowserSkillTraceOperationInput,
} from "./browser-skill-service";
import { PersistenceService, type PersistedBrowserTab } from "./persistence-service";

const pipeName = (process.env.CODEX_BROWSER_PIPE_NAME || DEFAULT_BROWSER_PIPE_NAME)
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^[.-]+|[.-]+$/g, "")
  .slice(0, 80) || DEFAULT_BROWSER_PIPE_NAME;
const PIPE_PATH = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
const PROFILE_ID = "primary";
const PROFILE_PARTITION = `persist:codex-browser-${PROFILE_ID}`;
const APP_ID = "com.codex.browser";
const HOME_URL = "https://www.crossref.org/";
const MAX_TABS = 8;
const MAX_TASKS = 80;
const MAX_DOWNLOADS = 80;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const STATE_SAVE_DELAY_MS = 300;
const COOKIE_SAVE_DELAY_MS = 800;
const COOKIE_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_LOGIN_RETRY_DELAY_MS = 5 * 60 * 1000;
const runtimeLogDir = path.join(process.cwd(), ".runtime");
const runtimeLogPath = path.join(runtimeLogDir, "main.log");
const userDataOverride = process.env.CODEX_BROWSER_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

function brandingPath(fileName: string): string {
  const brandingDir = app.isPackaged
    ? path.join(process.resourcesPath, "branding")
    : path.join(process.cwd(), "assets", "branding");
  return path.join(brandingDir, fileName);
}

function logRuntime(message: string, error?: unknown): void {
  try {
    mkdirSync(runtimeLogDir, { recursive: true });
    const detail = error instanceof Error ? `\n${error.stack || error.message}` : error ? `\n${String(error)}` : "";
    appendFileSync(runtimeLogPath, `[${new Date().toISOString()}] ${message}${detail}\n`, "utf8");
  } catch {
    // Logging must never prevent the browser from starting.
  }
}

logRuntime("Electron main module loaded");
process.on("uncaughtException", (error) => logRuntime("Uncaught exception", error));
process.on("unhandledRejection", (error) => logRuntime("Unhandled rejection", error));

let mainWindow: BrowserWindow | null = null;
let browserView: WebContentsView | null = null;
let browserSession: Session | null = null;
let tray: Tray | null = null;
let pipeServer: Server | null = null;
let documentService: DocumentService;
let persistenceService: PersistenceService | null = null;
let browserSkillService: BrowserSkillService | null = null;
let downloadsDir = "";
let isQuitting = false;
let shutdownInProgress = false;
let shutdownComplete = false;
const pendingDownloads: Array<{ taskId: string; tabId: string; url: string; timeout: NodeJS.Timeout }> = [];
const cancelledPendingDownloads: Array<{ taskId: string; url: string; expiresAt: number }> = [];
const activeDownloadJobs = new Map<string, ElectronDownloadJob>();
const activeProbeControllers = new Set<AbortController>();
const downloadCandidates = new Map<string, {
  url: string;
  pageUrl: string;
  tabId: string;
  source: "link" | "loaded_pdf" | "visible_pdf";
}>();
const waitingAuthTasks = new Map<string, "done" | "retry">();
const autoLoginAttempts = new Map<string, number>();
const ignoredDownloadFiles = new Set<string>();
interface LoadedPdfResponse {
  tabId: string;
  url: string;
  fileName: string;
  data: Buffer;
  capturedAt: string;
  savedDownloadId?: string;
}
const loadedPdfResponses = new Map<string, LoadedPdfResponse>();
const pendingPdfResponses = new Map<string, { tabId: string; url: string; fileName: string }>();
const failedDownloadRequests = new Map<string, { failedAt: number; reason: string }>();
interface BrowserTabRecord {
  id: string;
  view: WebContentsView;
  createdAt: string;
  lastSafeUrl: string;
}
const browserTabs = new Map<string, BrowserTabRecord>();
const snapshotRevisions = new Map<string, number>();
const latestSnapshots = new Map<string, InteractivePageSnapshot>();
const dialogTaskIds = new Map<string, string>();
let activeTabId = "";
let browserBounds = { x: 300, y: 100, width: 1100, height: 700 };
let restoredTabs: PersistedBrowserTab[] = [];
let restoredActiveTabId: string | undefined;
let lastSafeUrl = HOME_URL;
let stateSaveTimer: NodeJS.Timeout | null = null;
let cookieSaveTimer: NodeJS.Timeout | null = null;
let cookieBackupInterval: NodeJS.Timeout | null = null;
let stateSaveChain = Promise.resolve();
let cookieSaveChain = Promise.resolve();
let pipeCommandQueue = Promise.resolve();
let navigationQueue = Promise.resolve();
let operationGeneration = 0;
let lastAuthNotificationKey = "";
let lastAuthNotificationAt = 0;
let lastCookieChangeAt = 0;
let authPromptCookieBaseline = 0;
let authPromptUrlBaseline = "";

const state: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  runtimeStatus: "idle",
  currentAction: "等待任务",
  url: HOME_URL,
  title: "Codex Browser",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  profileId: PROFILE_ID,
  profileLabel: "默认研究会话",
  tabs: [],
  activeTabId: "",
  authPrompt: null,
  assistance: null,
  dialogs: [],
  sessionHealth: {
    status: "unknown",
    detail: "尚未检查当前会话",
    cookieCount: 0,
    sessionCookieCount: 0,
    encryptedBackupAvailable: false,
  },
  credentialVault: {
    encryptionAvailable: false,
    savedSiteCount: 0,
    activeSiteSaved: false,
  },
  storage: {
    taskCount: 0,
    downloadCount: 0,
    documentCount: 0,
    browserSkillCount: 0,
    browserSkillTraceCount: 0,
  },
  tasks: [],
  downloads: [],
  documents: [],
  browserSkills: [],
  browserSkillTraces: [],
  browserSkillRun: null,
};

function desktopState(): AppState {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({ ...task })),
    downloads: state.downloads.map(({ path: _path, ...download }) => ({ ...download })),
    documents: state.documents.map((document) => ({ ...document })),
    browserSkills: state.browserSkills.map((skill) => ({
      ...skill,
      trigger: {
        hosts: [...skill.trigger.hosts],
        pathPatterns: [...skill.trigger.pathPatterns],
        keywords: [...skill.trigger.keywords],
      },
      inputs: skill.inputs.map((input) => ({ ...input })),
      steps: skill.steps.map((step) => ({
        ...step,
        params: structuredClone(step.params),
        target: step.target ? { ...step.target } : undefined,
      })),
      stats: { ...skill.stats },
    })),
    browserSkillTraces: state.browserSkillTraces.map((trace) => ({ ...trace })),
    browserSkillRun: state.browserSkillRun ? { ...state.browserSkillRun } : null,
    tabs: state.tabs.map((tab) => ({ ...tab })),
    authPrompt: state.authPrompt ? { ...state.authPrompt } : null,
    assistance: state.assistance ? { ...state.assistance } : null,
    dialogs: state.dialogs.map((dialog) => ({ ...dialog })),
    sessionHealth: { ...state.sessionHealth },
    credentialVault: { ...state.credentialVault },
    storage: { ...state.storage },
  };
}

function sanitizeUrlForExposure(value: string): string {
  if (value === "about:blank") return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function sanitizeTextForExposure(value?: string): string | undefined {
  if (!value) return value;
  return value
    .replace(/https?:\/\/[^\s·]+/g, (candidate) => sanitizeUrlForExposure(candidate) || "[URL 已脱敏]")
    .replace(/\b([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^\s?&#·]*)\?[^\s·]*/gi, "$1")
    .replace(/([?&](?:token|code|ticket|assertion|session|saml|jwt|credential|password|secret|state|signature|signed|expires|api[_-]?key)=[^&\s·]*)/gi, "[参数已脱敏]");
}

function mcpState(): AppState {
  const snapshot = desktopState();
  snapshot.url = sanitizeUrlForExposure(snapshot.url);
  snapshot.currentAction = sanitizeTextForExposure(snapshot.currentAction) || snapshot.currentAction;
  snapshot.authPrompt = snapshot.authPrompt
    ? { ...snapshot.authPrompt, url: sanitizeUrlForExposure(snapshot.authPrompt.url) }
    : null;
  snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, url: sanitizeUrlForExposure(tab.url) }));
  snapshot.assistance = snapshot.assistance
    ? {
        ...snapshot.assistance,
        url: sanitizeUrlForExposure(snapshot.assistance.url),
        detail: sanitizeTextForExposure(snapshot.assistance.detail) || snapshot.assistance.detail,
        note: sanitizeTextForExposure(snapshot.assistance.note),
      }
    : null;
  snapshot.dialogs = snapshot.dialogs.map((dialog) => ({
    ...dialog,
    url: sanitizeUrlForExposure(dialog.url),
    defaultValue: dialog.sensitive ? undefined : dialog.defaultValue,
  }));
  snapshot.tasks = snapshot.tasks.map((task) => ({ ...task, detail: sanitizeTextForExposure(task.detail) }));
  snapshot.downloads = snapshot.downloads.map((download) => ({
    ...download,
    url: sanitizeResourceUrl(download.url),
  }));
  snapshot.browserSkills = [];
  snapshot.browserSkillTraces = [];
  return snapshot;
}

function authPromptForExposure(prompt: AuthPrompt | null): AuthPrompt | null {
  return prompt ? { ...prompt, url: sanitizeUrlForExposure(prompt.url) } : null;
}

function assistanceForExposure(assistance: HumanAssistance | null): HumanAssistance | null {
  if (!assistance) return null;
  return {
    ...assistance,
    url: sanitizeUrlForExposure(assistance.url),
    detail: sanitizeTextForExposure(assistance.detail) || assistance.detail,
    note: sanitizeTextForExposure(assistance.note),
  };
}

function dialogsForExposure(dialogs = state.dialogs): BrowserDialogPrompt[] {
  return dialogs.map((dialog) => ({
    ...dialog,
    url: sanitizeUrlForExposure(dialog.url),
    defaultValue: dialog.sensitive ? undefined : dialog.defaultValue,
  }));
}

function refreshStorageSummary(): void {
  state.storage.taskCount = state.tasks.length;
  state.storage.downloadCount = state.downloads.length;
  state.storage.documentCount = state.documents.length;
  state.storage.browserSkillCount = state.browserSkills.length;
  state.storage.browserSkillTraceCount = state.browserSkillTraces.length;
}

async function refreshBrowserSkillState(): Promise<void> {
  if (!browserSkillService) {
    state.browserSkills = [];
    state.browserSkillTraces = [];
    refreshStorageSummary();
    return;
  }
  const [skills, traces] = await Promise.all([
    browserSkillService.listSkills(true),
    browserSkillService.listTraceSummaries(),
  ]);
  state.browserSkills = skills;
  state.browserSkillTraces = traces;
  refreshStorageSummary();
}

function refreshCredentialVaultStatus(value = state.authPrompt?.url || state.url): CredentialVaultStatus {
  state.credentialVault = persistenceService?.credentialStatus(value) || {
    encryptionAvailable: false,
    savedSiteCount: 0,
    activeSiteSaved: false,
  };
  return { ...state.credentialVault };
}

function safeUrlForPersistence(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (/(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i.test(parsed.pathname)) {
      return null;
    }
    const queryKeys = [...parsed.searchParams.keys()];
    const hasEphemeralSignature = queryKeys.some((key) => /(?:token|ticket|assertion|saml|jwt|credential|secret|signature|signed|expires|x-amz-|api[_-]?key)/i.test(key));
    if (hasEphemeralSignature && (/\.pdf$/i.test(parsed.pathname) || /(?:assets|download|content)/i.test(parsed.hostname))) {
      return null;
    }
    for (const key of queryKeys) {
      if (/(?:token|code|ticket|assertion|session|saml|jwt|credential|password|secret|state|signature|signed|expires|api[_-]?key)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeResourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizePersistedText(value?: string): string | undefined {
  if (!value) return value;
  return value
    .replace(/https?:\/\/[^\s·]+/g, (candidate) => sanitizeResourceUrl(candidate) || "[URL 已脱敏]")
    .replace(/\b([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^\s?&#·]*)\?[^\s·]*/gi, "$1")
    .replace(/([?&](?:token|code|ticket|assertion|session|saml|jwt|credential|password|secret|state|signature|signed|expires|api[_-]?key)=[^&\s·]*)/gi, "[参数已脱敏]");
}

function tabAttention(tabId: string): BrowserTabSummary["attention"] {
  if (state.dialogs.some((dialog) => dialog.tabId === tabId)) return "dialog";
  if (state.assistance?.tabId === tabId && state.assistance.status === "waiting_user") return "assistance";
  if (state.authPrompt?.tabId === tabId) return "auth";
  return null;
}

function tabSummary(record: BrowserTabRecord): BrowserTabSummary {
  const contents = record.view.webContents;
  const history = contents.navigationHistory;
  const currentUrl = contents.getURL() || record.lastSafeUrl || HOME_URL;
  const safeUrl = safeUrlForPersistence(currentUrl);
  if (safeUrl) record.lastSafeUrl = safeUrl;
  return {
    id: record.id,
    title: contents.getTitle() || "新标签页",
    url: currentUrl,
    active: record.id === activeTabId,
    isLoading: contents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
    attention: tabAttention(record.id),
    createdAt: record.createdAt,
  };
}

function syncTabsState(): void {
  state.activeTabId = activeTabId;
  state.tabs = [...browserTabs.values()].map(tabSummary);
}

function persistedTabsPayload(): PersistedBrowserTab[] {
  return [...browserTabs.values()].map((record) => {
    const currentUrl = record.view.webContents.getURL();
    const url = safeUrlForPersistence(currentUrl) || record.lastSafeUrl || HOME_URL;
    return {
      id: record.id,
      title: (record.view.webContents.getTitle() || "新标签页").replace(/[\u0000-\u001f]/g, " ").slice(0, 300),
      url,
      createdAt: record.createdAt,
    };
  }).slice(0, MAX_TABS);
}

function runtimeStatePayload() {
  return {
    lastSafeUrl,
    tabs: persistedTabsPayload(),
    activeTabId,
    assistance: state.assistance
      ? {
          ...state.assistance,
          url: sanitizeResourceUrl(state.assistance.url),
          detail: sanitizePersistedText(state.assistance.detail) || state.assistance.detail,
          note: sanitizePersistedText(state.assistance.note),
        }
      : null,
    tasks: state.tasks.map((task) => ({ ...task, detail: sanitizePersistedText(task.detail) })),
    downloads: state.downloads.map((download) => ({
      ...download,
      url: sanitizeResourceUrl(download.url),
    })),
    ignoredDownloadFiles: [...ignoredDownloadFiles].sort(),
  };
}

function scheduleRuntimeStateSave(delay = STATE_SAVE_DELAY_MS): void {
  if (!persistenceService || isQuitting) return;
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    stateSaveChain = stateSaveChain.then(async () => {
      if (!persistenceService) return;
      const savedAt = await persistenceService.saveRuntimeState(runtimeStatePayload());
      state.storage.lastSavedAt = savedAt;
      refreshStorageSummary();
      mainWindow?.webContents.send("browser:state", desktopState());
    }).catch((error) => logRuntime("Failed to persist runtime state", error));
  }, delay);
}

function scheduleSessionCookieBackup(delay = COOKIE_SAVE_DELAY_MS): void {
  if (!persistenceService || !browserSession || !persistenceService.isEncryptionAvailable() || isQuitting) return;
  if (cookieSaveTimer) return;
  cookieSaveTimer = setTimeout(() => {
    cookieSaveTimer = null;
    cookieSaveChain = cookieSaveChain.then(async () => {
      if (!persistenceService || !browserSession) return;
      await persistenceService.persistSessionCookies(browserSession);
      state.sessionHealth.encryptedBackupAvailable = true;
      mainWindow?.webContents.send("browser:state", desktopState());
    }).catch((error) => logRuntime("Failed to persist encrypted session cookies", error));
  }, delay);
}

async function flushPersistentData(): Promise<void> {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  const targetPersistence = persistenceService;
  if (targetPersistence) {
    stateSaveChain = stateSaveChain.then(async () => {
      state.storage.lastSavedAt = await targetPersistence.saveRuntimeState(runtimeStatePayload());
    });
  }
  if (cookieSaveTimer) clearTimeout(cookieSaveTimer);
  cookieSaveTimer = null;
  const targetSession = browserSession;
  if (targetPersistence && targetSession) {
    cookieSaveChain = cookieSaveChain.then(async () => {
      await targetPersistence.persistSessionCookies(targetSession);
    });
  }
  const results = await Promise.allSettled([stateSaveChain, cookieSaveChain, targetSession?.cookies.flushStore()]);
  for (const result of results) {
    if (result.status === "rejected") logRuntime("Failed to flush persistent data during shutdown", result.reason);
  }
}

function broadcastState(persist = true): void {
  syncTabsState();
  refreshStorageSummary();
  mainWindow?.webContents.send("browser:state", desktopState());
  if (persist) scheduleRuntimeStateSave();
}

function resolveTabId(value?: unknown): string {
  const requested = typeof value === "string" ? value.trim() : "";
  const tabId = requested || activeTabId;
  if (!tabId || !browserTabs.has(tabId)) throw new Error("Browser tab was not found.");
  return tabId;
}

function exposedTabsResult(extra: Record<string, unknown> = {}) {
  syncTabsState();
  return {
    activeTabId,
    tabs: state.tabs.map((tab) => ({ ...tab, url: sanitizeUrlForExposure(tab.url) })),
    ...extra,
  };
}

function updateNavigationState(tabId = activeTabId): void {
  const record = browserTabs.get(tabId);
  if (!record) return;
  if (tabId === activeTabId) {
    const history = record.view.webContents.navigationHistory;
    state.url = record.view.webContents.getURL() || state.url;
    state.title = record.view.webContents.getTitle() || "Codex Browser";
    state.isLoading = record.view.webContents.isLoading();
    state.canGoBack = history.canGoBack();
    state.canGoForward = history.canGoForward();
    const safeUrl = safeUrlForPersistence(state.url);
    if (safeUrl) {
      lastSafeUrl = safeUrl;
      record.lastSafeUrl = safeUrl;
    }
    refreshCredentialVaultStatus(state.url);
  }
  broadcastState();
}

function activateBrowserTab(tabId: string, focus = true): BrowserTabSummary {
  const record = browserTabs.get(tabId);
  if (!record) throw new Error("Browser tab was not found.");
  if (browserView && activeTabId !== tabId) browserView.setVisible(false);
  activeTabId = tabId;
  browserView = record.view;
  record.view.setBounds(browserBounds);
  record.view.setVisible(true);
  if (focus) record.view.webContents.focus();
  updateNavigationState(tabId);
  return tabSummary(record);
}

function safeTabWebPreferences(preferences: WebPreferences = {}): WebPreferences {
  const {
    session: _session,
    partition: _partition,
    preload: _preload,
    nodeIntegration: _nodeIntegration,
    contextIsolation: _contextIsolation,
    sandbox: _sandbox,
    ...rest
  } = preferences;
  return {
    ...rest,
    partition: PROFILE_PARTITION,
    backgroundThrottling: false,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function createBrowserTab(
  initialUrl: string | undefined,
  activate = true,
  preferences: WebPreferences = {},
  requestedId?: string,
  createdAt = new Date().toISOString(),
  adoptedWebContents?: WebContents,
): BrowserTabRecord {
  if (!mainWindow) throw new Error("Browser window is not ready.");
  if (browserTabs.size >= MAX_TABS) throw new Error(`Codex Browser supports at most ${MAX_TABS} tabs.`);
  const id = requestedId && !browserTabs.has(requestedId) ? requestedId : randomUUID();
  const target = initialUrl ? (initialUrl === "about:blank" ? initialUrl : normalizeTarget(initialUrl)) : "";
  const view = adoptedWebContents
    ? new WebContentsView({ webContents: adoptedWebContents })
    : new WebContentsView({ webPreferences: safeTabWebPreferences(preferences) });
  const record: BrowserTabRecord = {
    id,
    view,
    createdAt,
    lastSafeUrl: safeUrlForPersistence(target) || HOME_URL,
  };
  browserTabs.set(id, record);
  mainWindow.contentView.addChildView(view);
  view.setBackgroundColor("#ffffff");
  view.setBounds(browserBounds);
  view.setVisible(false);
  setupBrowserEvents(record);
  setupDialogDebugger(record);
  if (activate || !activeTabId) activateBrowserTab(id);
  else broadcastState();
  if (target) {
    void view.webContents.loadURL(target).catch((error) => {
      if ((error as Error).message.includes("ERR_ABORTED") || view.webContents.isDestroyed()) return;
      logRuntime(`Initial tab ${id} failed to load`, error);
    });
  }
  return record;
}

function removeBrowserTabRecord(tabId: string): void {
  const record = browserTabs.get(tabId);
  if (!record) return;
  browserTabs.delete(tabId);
  snapshotRevisions.delete(tabId);
  latestSnapshots.delete(tabId);
  loadedPdfResponses.delete(tabId);
  for (const key of pendingPdfResponses.keys()) {
    if (key.startsWith(`${tabId}:`)) pendingPdfResponses.delete(key);
  }
  state.dialogs = state.dialogs.filter((dialog) => dialog.tabId !== tabId);
  for (const [dialogId] of dialogTaskIds) {
    if (!state.dialogs.some((dialog) => dialog.id === dialogId)) dialogTaskIds.delete(dialogId);
  }
  if (state.authPrompt?.tabId === tabId) cancelAuthPrompt("授权页面已关闭");
  if (state.assistance?.tabId === tabId && state.assistance.status === "waiting_user") {
    state.assistance = {
      ...state.assistance,
      status: "cancelled",
      note: "关联标签页已关闭",
      resolvedAt: new Date().toISOString(),
    };
  }
  if (mainWindow && !record.view.webContents.isDestroyed()) {
    mainWindow.contentView.removeChildView(record.view);
  }
}

async function closeBrowserTab(tabId: string, force = false): Promise<void> {
  const record = browserTabs.get(tabId);
  if (!record) throw new Error("Browser tab was not found.");
  const blocked = state.dialogs.some((dialog) => dialog.tabId === tabId)
    || state.authPrompt?.tabId === tabId
    || (state.assistance?.tabId === tabId && state.assistance.status === "waiting_user");
  if (blocked && !force) throw new Error("Resolve the tab's pending dialog or human action before closing it, or pass force=true.");
  if (browserTabs.size === 1) createBrowserTab(HOME_URL, false);
  const remaining = [...browserTabs.keys()].filter((candidate) => candidate !== tabId);
  if (activeTabId === tabId && remaining[0]) activateBrowserTab(remaining[0]);
  removeBrowserTabRecord(tabId);
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.close({ waitForBeforeUnload: !force });
  }
  broadcastState();
}

function createTask(label: string, detail?: string, status: TaskStatus = "running"): TaskItem {
  const now = new Date().toISOString();
  const task: TaskItem = {
    id: randomUUID(),
    label,
    detail,
    status,
    createdAt: now,
    updatedAt: now,
  };
  state.tasks = [task, ...state.tasks].slice(0, MAX_TASKS);
  broadcastState();
  return task;
}

function updateTask(taskId: string, status: TaskStatus, detail?: string): void {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return;
  }
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (detail !== undefined) {
    task.detail = detail;
  }
  broadcastState();
}

function setRuntime(status: AppState["runtimeStatus"], action: string): void {
  state.runtimeStatus = status;
  state.currentAction = action;
  broadcastState();
}

function finishRuntime(action: string): void {
  if (state.runtimeStatus === "paused") {
    state.currentAction = `${action} · Codex 控制仍暂停`;
    broadcastState();
    return;
  }
  setRuntime("idle", action);
}

function requireBrowserView(tabId?: string): WebContentsView {
  const resolvedId = tabId ? resolveTabId(tabId) : activeTabId;
  const record = resolvedId ? browserTabs.get(resolvedId) : undefined;
  if (!record) throw new Error("Browser window is not ready.");
  return record.view;
}

function requireSession(): Session {
  if (!browserSession) {
    throw new Error("Browser session is not ready.");
  }
  return browserSession;
}

function assertAutomationAllowed(): void {
  if (state.runtimeStatus === "paused") {
    const error = new Error("Codex browser control is paused by the user.");
    error.name = "PAUSED_BY_USER";
    throw error;
  }
}

function createTaskStoppedError(): Error {
  const error = new Error("The browser task was stopped by the user.");
  error.name = "TASK_STOPPED";
  return error;
}

function assertOperationCurrent(generation: number): void {
  if (generation !== operationGeneration) throw createTaskStoppedError();
}

function normalizeTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return HOME_URL;
  }
  if (trimmed === "about:blank") {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Continue with domain or search normalization.
  }
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
}

function showWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

interface LoginFormValues {
  found: boolean;
  username: string;
  password: string;
  hasCaptcha: boolean;
  hasMfa: boolean;
}

interface LoginSubmitResult {
  submitted: boolean;
  blockedByVerification: boolean;
}

async function readLoginFormValues(tabId: string): Promise<LoginFormValues> {
  const contents = requireBrowserView(tabId).webContents;
  return (await contents.executeJavaScript(`(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || element.hidden || element.hasAttribute("disabled")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const passwords = [...document.querySelectorAll('input[type="password"]')];
    const password = passwords.find(isVisible) || null;
    const scope = password?.form || password?.closest("form") || document;
    const usernameSelector = [
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[type="text"]'
    ].join(",");
    const usernames = [...scope.querySelectorAll(usernameSelector)];
    const username = usernames.find((element) => isVisible(element) && element !== password) || null;
    const text = (document.body?.innerText || "").toLowerCase();
    const hasCaptcha = Boolean(document.querySelector('[class*="captcha" i], [id*="captcha" i], img[alt*="验证码"], input[placeholder*="验证码"]')) || /验证码|captcha/.test(text);
    const hasMfa = /多因素|双重验证|二次验证|动态口令|two-factor|multi-factor|verification code|authenticator/.test(text);
    return {
      found: Boolean(username && password),
      username: username?.value || "",
      password: password?.value || "",
      hasCaptcha,
      hasMfa,
    };
  })()`, true)) as LoginFormValues;
}

async function fillAndSubmitLogin(tabId: string, username: string, password: string): Promise<LoginSubmitResult> {
  const contents = requireBrowserView(tabId).webContents;
  const payload = JSON.stringify({ username, password });
  return (await contents.executeJavaScript(`(() => {
    const credentials = ${payload};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || element.hidden || element.hasAttribute("disabled")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (document.body?.innerText || "").toLowerCase();
    const hasCaptcha = Boolean(document.querySelector('[class*="captcha" i], [id*="captcha" i], img[alt*="验证码"], input[placeholder*="验证码"]')) || /验证码|captcha/.test(text);
    const hasMfa = /多因素|双重验证|二次验证|动态口令|two-factor|multi-factor|verification code|authenticator/.test(text);
    if (hasCaptcha || hasMfa) return { submitted: false, blockedByVerification: true };
    const passwords = [...document.querySelectorAll('input[type="password"]')];
    const passwordInput = passwords.find(isVisible) || null;
    const form = passwordInput?.form || passwordInput?.closest("form") || null;
    const scope = form || document;
    const usernameSelector = [
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[type="text"]'
    ].join(",");
    const usernameInput = [...scope.querySelectorAll(usernameSelector)].find((element) => isVisible(element) && element !== passwordInput) || null;
    if (!usernameInput || !passwordInput) return { submitted: false, blockedByVerification: false };
    const setInputValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setInputValue(usernameInput, credentials.username);
    setInputValue(passwordInput, credentials.password);
    const candidates = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(isVisible);
    const explicitSubmit = candidates.find((element) => element.matches('button[type="submit"], input[type="submit"]'));
    const namedSubmit = candidates.find((element) => /登录|登陆|sign\\s*in|log\\s*in|continue|下一步|继续/i.test(element.innerText || element.value || element.getAttribute("aria-label") || ""));
    const submit = explicitSubmit || namedSubmit || null;
    if (!submit && !form) return { submitted: false, blockedByVerification: false };
    setTimeout(() => {
      if (submit) submit.click();
      else if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    }, 80);
    return { submitted: true, blockedByVerification: false };
  })()`, true)) as LoginSubmitResult;
}

function scheduleAuthenticationInspection(tabId: string, delay = 1_200): void {
  setTimeout(() => {
    const record = browserTabs.get(tabId);
    if (!record || record.view.webContents.isDestroyed() || record.view.webContents.isLoading()) return;
    void inspectForAuthentication(undefined, tabId).catch(() => undefined);
  }, delay);
}

async function tryAutoLogin(tabId: string): Promise<boolean> {
  if (!persistenceService || state.runtimeStatus === "paused") return false;
  const contents = requireBrowserView(tabId).webContents;
  const url = contents.getURL();
  const credential = persistenceService.getLoginCredential(url);
  if (!credential) return false;
  const attemptKey = `${tabId}:${credential.origin}`;
  const lastAttempt = autoLoginAttempts.get(attemptKey) || 0;
  if (Date.now() - lastAttempt < AUTO_LOGIN_RETRY_DELAY_MS) return false;
  const result = await fillAndSubmitLogin(tabId, credential.username, credential.password);
  if (!result.submitted) return false;
  autoLoginAttempts.set(attemptKey, Date.now());
  setRuntime("running", "已自动提交本机加密保存的登录信息");
  scheduleAuthenticationInspection(tabId);
  return true;
}

async function saveAndSubmitLogin(promptId?: string): Promise<CredentialVaultStatus> {
  if (!persistenceService) throw new Error("本地存储尚未初始化。");
  const prompt = state.authPrompt;
  if (!prompt || prompt.reason !== "login") throw new Error("当前页面没有可保存的登录表单。");
  if (promptId && prompt.id !== promptId) throw new Error("登录提示已过期，请重新检查当前页面。");
  const tabId = resolveTabId(prompt.tabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  const url = requireBrowserView(tabId).webContents.getURL();
  const values = await readLoginFormValues(tabId);
  if (values.hasCaptcha || values.hasMfa) throw new Error("检测到验证码或多因素验证，已停止自动提交。");
  if (!values.found || !values.username.trim() || !values.password) {
    throw new Error("请先在网页中填写用户名和密码，再点击“保存并登录”。");
  }
  const status = await persistenceService.saveLoginCredential(url, values.username, values.password);
  refreshCredentialVaultStatus(url);
  const result = await fillAndSubmitLogin(tabId, values.username, values.password);
  if (!result.submitted) throw new Error("已加密保存登录信息，但未找到可提交的登录按钮。");
  const credential = persistenceService.getLoginCredential(url);
  if (credential) autoLoginAttempts.set(`${tabId}:${credential.origin}`, Date.now());
  setRuntime("running", "登录信息已由 Windows 加密保存并提交");
  scheduleAuthenticationInspection(tabId);
  return status;
}

async function clearSavedLogins(): Promise<CredentialVaultStatus> {
  if (!persistenceService) throw new Error("本地存储尚未初始化。");
  await persistenceService.clearLoginCredentials();
  autoLoginAttempts.clear();
  const status = refreshCredentialVaultStatus();
  broadcastState(false);
  return status;
}

function setAuthPrompt(prompt: AuthPrompt, taskId?: string, completion: "done" | "retry" = "done"): void {
  const previousPrompt = state.authPrompt;
  const promptKey = `${prompt.tabId}:${prompt.reason}:${safeUrlForPersistence(prompt.url) || prompt.url.split(/[?#]/, 1)[0]}`;
  const previousPromptKey = previousPrompt
    ? `${previousPrompt.tabId}:${previousPrompt.reason}:${safeUrlForPersistence(previousPrompt.url) || previousPrompt.url.split(/[?#]/, 1)[0]}`
    : "";
  const isRepeatedPrompt = previousPromptKey === promptKey;
  if (!isRepeatedPrompt) {
    authPromptCookieBaseline = lastCookieChangeAt;
    authPromptUrlBaseline = prompt.url;
  }
  const notificationKey = promptKey;
  const now = Date.now();
  const shouldNotify = notificationKey !== lastAuthNotificationKey || now - lastAuthNotificationAt > 30_000;
  state.authPrompt = isRepeatedPrompt && previousPrompt
    ? { ...prompt, id: previousPrompt.id, detectedAt: previousPrompt.detectedAt }
    : prompt;
  refreshCredentialVaultStatus(prompt.url);
  state.sessionHealth.status = "attention";
  state.sessionHealth.detail = prompt.detail;
  state.sessionHealth.checkedAt = new Date().toISOString();
  if (taskId) {
    waitingAuthTasks.set(taskId, completion);
    updateTask(taskId, "waiting_user", prompt.detail);
  }
  setRuntime("waiting_user", "等待你完成授权");
  if (!isRepeatedPrompt) {
    showWindow();
    mainWindow?.flashFrame(true);
  }
  if (shouldNotify && Notification.isSupported()) {
    lastAuthNotificationKey = notificationKey;
    lastAuthNotificationAt = now;
    new Notification({
      title: "Codex Browser 需要你的操作",
      body: prompt.detail,
      silent: false,
    }).show();
  }
}

function clearAuthPrompt(markWaitingTasksDone = false): void {
  state.authPrompt = null;
  refreshCredentialVaultStatus(state.url);
  if (markWaitingTasksDone) {
    for (const [taskId, completion] of waitingAuthTasks) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== "waiting_user") continue;
      task.status = completion === "retry" ? "queued" : "done";
      task.detail = completion === "retry"
        ? "授权已确认，请重新发起下载"
        : task.detail ? `${task.detail} · 授权已确认` : "授权已确认";
      task.updatedAt = new Date().toISOString();
    }
  }
  waitingAuthTasks.clear();
  authPromptCookieBaseline = lastCookieChangeAt;
  authPromptUrlBaseline = "";
  mainWindow?.flashFrame(false);
  if (state.runtimeStatus === "waiting_user") {
    setRuntime("idle", "授权已处理，等待任务");
  } else {
    broadcastState();
  }
}

function cancelAuthPrompt(detail: string): void {
  state.authPrompt = null;
  refreshCredentialVaultStatus(state.url);
  for (const taskId of waitingAuthTasks.keys()) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "waiting_user") continue;
    task.status = "error";
    task.detail = task.detail ? `${task.detail} · ${detail}` : detail;
    task.updatedAt = new Date().toISOString();
  }
  waitingAuthTasks.clear();
  authPromptCookieBaseline = lastCookieChangeAt;
  authPromptUrlBaseline = "";
  mainWindow?.flashFrame(false);
  if (state.runtimeStatus === "waiting_user") {
    setRuntime("idle", detail);
  } else {
    broadcastState();
  }
}

function hasAuthResolutionEvidence(currentUrl: string): boolean {
  const baselineUrl = sanitizeResourceUrl(authPromptUrlBaseline);
  const nextUrl = sanitizeResourceUrl(currentUrl);
  const baselineWasAuth = /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i.test(authPromptUrlBaseline);
  const currentLooksAuth = /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i.test(currentUrl);
  return lastCookieChangeAt > authPromptCookieBaseline
    || Boolean(baselineUrl && nextUrl && baselineUrl !== nextUrl)
    || (baselineWasAuth && !currentLooksAuth);
}

async function updateSessionHealth(
  status: SessionHealth["status"],
  detail: string,
  checkedAt = new Date().toISOString(),
): Promise<SessionHealth> {
  let cookies: Electron.Cookie[] = [];
  try {
    cookies = await requireSession().cookies.get({});
  } catch {
    // Keep the health result useful even if Chromium is shutting down.
  }
  state.sessionHealth = {
    ...state.sessionHealth,
    status,
    detail,
    checkedAt,
    cookieCount: cookies.length,
    sessionCookieCount: cookies.filter((cookie) => cookie.session).length,
    encryptedBackupAvailable: state.sessionHealth.encryptedBackupAvailable,
  };
  broadcastState();
  return { ...state.sessionHealth };
}

async function inspectForAuthentication(taskId?: string, tabId = activeTabId): Promise<AuthPrompt | null> {
  const view = requireBrowserView(tabId);
  const url = view.webContents.getURL();
  if (!url || url === "about:blank") {
    await updateSessionHealth("unknown", "当前页面为空，尚无法判断站点授权状态");
    return null;
  }

  const result = (await view.webContents.executeJavaScript(`(() => {
    const body = (document.body?.innerText || "").slice(0, 12000);
    const lower = body.toLowerCase();
    const hasPassword = Boolean(document.querySelector('input[type="password"]'));
    const hasCaptcha = Boolean(document.querySelector('[class*="captcha" i], [id*="captcha" i], img[alt*="验证码"], input[placeholder*="验证码"]')) || /验证码|captcha/.test(lower);
    const hasMfa = /多因素|双重验证|二次验证|动态口令|two-factor|multi-factor|verification code|authenticator/.test(lower);
    const hasLoginText = /统一身份认证|校外访问|登录|sign in|log in|institutional login|access through your institution/.test(lower);
    const hasLoginControl = Boolean(document.querySelector('form input[type="email"], form input[name*="user" i], form button[type="submit"], input[autocomplete="username"]'));
    return { hasPassword, hasCaptcha, hasMfa, hasLoginText, hasLoginControl };
  })()`, true)) as {
    hasPassword: boolean;
    hasCaptcha: boolean;
    hasMfa: boolean;
    hasLoginText: boolean;
    hasLoginControl: boolean;
  };

  const urlLooksLikeAuth = /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i.test(url);
  const authDetected = result.hasPassword
    || result.hasCaptcha
    || result.hasMfa
    || (urlLooksLikeAuth && result.hasLoginText)
    || (result.hasLoginText && result.hasLoginControl);
  if (!authDetected) {
    const existingPrompt = state.authPrompt?.tabId === tabId ? state.authPrompt : null;
    if (existingPrompt?.reason === "forbidden") {
      if (taskId) setAuthPrompt(existingPrompt, taskId);
      await updateSessionHealth("attention", existingPrompt.detail);
      return existingPrompt;
    }
    if (existingPrompt?.reason === "stalled" && view.webContents.isLoading()) {
      if (taskId) setAuthPrompt(existingPrompt, taskId);
      await updateSessionHealth("attention", existingPrompt.detail);
      return existingPrompt;
    }
    if (existingPrompt) {
      if (!hasAuthResolutionEvidence(url)) {
        const unresolvedPrompt: AuthPrompt = {
          ...existingPrompt,
          detail: "登录表单已消失，但尚未检测到页面跳转或会话更新，请确认授权确实完成。",
          detectedAt: new Date().toISOString(),
        };
        setAuthPrompt(unresolvedPrompt, taskId);
        await updateSessionHealth("attention", unresolvedPrompt.detail);
        return unresolvedPrompt;
      }
      clearAuthPrompt(true);
    }
    await updateSessionHealth("healthy", "当前页面未检测到登录或授权阻断");
    return null;
  }

  const reason: AuthPrompt["reason"] = result.hasCaptcha
    ? "captcha"
    : result.hasMfa
      ? "mfa"
      : "login";
  const prompt: AuthPrompt = {
    id: state.authPrompt?.tabId === tabId ? state.authPrompt.id : randomUUID(),
    tabId,
    reason,
    title: reason === "captcha" ? "需要验证码" : reason === "mfa" ? "需要多因素验证" : "需要登录授权",
    detail: reason === "captcha"
      ? "页面正在等待验证码，请在浏览器中完成。"
      : reason === "mfa"
        ? "页面正在等待多因素验证，请在浏览器中完成。"
        : "页面需要高校或站点登录，请完成授权后任务会自动继续。",
    url,
    detectedAt: new Date().toISOString(),
  };
  setAuthPrompt(prompt, taskId);
  return prompt;
}

async function checkSessionHealth(tabId = activeTabId): Promise<SessionHealth> {
  if (tabId !== activeTabId) activateBrowserTab(resolveTabId(tabId));
  state.sessionHealth.status = "checking";
  state.sessionHealth.detail = "正在检查当前页面和本地会话";
  broadcastState(false);
  try {
    const existingPrompt = state.authPrompt?.tabId === tabId ? state.authPrompt : null;
    if (existingPrompt?.reason === "forbidden") {
      const probe = await probeProtectedResource(existingPrompt);
      if (!probe.ok) {
        setAuthPrompt({
          ...existingPrompt,
          detail: probe.detail || existingPrompt.detail,
          detectedAt: new Date().toISOString(),
        });
        return { ...state.sessionHealth };
      }
      clearAuthPrompt(true);
    }
    const prompt = await inspectForAuthentication(undefined, tabId);
    if (prompt) return { ...state.sessionHealth };
    scheduleSessionCookieBackup();
    return { ...state.sessionHealth };
  } catch (error) {
    if ((error as Error).name === "TASK_STOPPED") throw error;
    return updateSessionHealth("unavailable", `会话检查失败：${(error as Error).message}`);
  }
}

async function probeProtectedResource(prompt: AuthPrompt): Promise<{ ok: boolean; detail?: string }> {
  if (prompt.reason !== "forbidden") return { ok: true };
  const generation = operationGeneration;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  activeProbeControllers.add(controller);
  try {
    let response = await requireSession().fetch(prompt.url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    assertOperationCurrent(generation);
    if (response.status === 405) {
      response = await requireSession().fetch(prompt.url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "manual",
        signal: controller.signal,
      });
      assertOperationCurrent(generation);
    }
    const location = response.headers.get("location") || "";
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `资源仍返回 ${response.status}，授权尚未生效。` };
    }
    if (response.status >= 300 && response.status < 400 && /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|signin)/i.test(location)) {
      return { ok: false, detail: "资源仍重定向到登录页面，授权尚未生效。" };
    }
    if (prompt.title.includes("论文下载") && contentType.includes("text/html")) {
      return { ok: false, detail: "论文地址仍返回 HTML 登录页，授权尚未生效。" };
    }
    if (response.status >= 400) {
      return { ok: false, detail: `资源检查返回 ${response.status}，暂时无法确认授权。` };
    }
    return { ok: true };
  } catch (error) {
    if (generation !== operationGeneration) throw createTaskStoppedError();
    if ((error as Error).name === "AbortError") {
      return { ok: false, detail: "受保护资源检查超过 12 秒，暂时无法确认授权。" };
    }
    return { ok: false, detail: `无法验证受保护资源：${(error as Error).message}` };
  } finally {
    clearTimeout(timeout);
    activeProbeControllers.delete(controller);
  }
}

async function completeAuthentication(promptId?: string, requestedTabId?: string): Promise<SessionHealth> {
  const previousPrompt = state.authPrompt;
  if (promptId && previousPrompt?.id !== promptId) throw new Error("The authorization prompt is stale.");
  const tabId = requestedTabId ? resolveTabId(requestedTabId) : previousPrompt?.tabId || activeTabId;
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  if (previousPrompt) {
    const probe = await probeProtectedResource(previousPrompt);
    if (!probe.ok) {
      setAuthPrompt({
        ...previousPrompt,
        detail: probe.detail || previousPrompt.detail,
        detectedAt: new Date().toISOString(),
      });
      return { ...state.sessionHealth };
    }
    if (previousPrompt.reason === "forbidden") {
      clearAuthPrompt(true);
    }
  }
  const prompt = await inspectForAuthentication(undefined, tabId);
  if (prompt) {
    return { ...state.sessionHealth };
  }
  clearAuthPrompt(true);
  finishRuntime("授权已确认，等待任务");
  failedDownloadRequests.clear();
  scheduleSessionCookieBackup(0);
  return updateSessionHealth("healthy", "授权已确认，会话已加密保存");
}

async function navigateTo(
  value: string,
  label = "打开网页",
  allowWhilePaused = false,
  requestedTabId = activeTabId,
): Promise<{ url: string; authPrompt: AuthPrompt | null }> {
  if (!allowWhilePaused) assertAutomationAllowed();
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  const view = requireBrowserView(tabId);
  const target = normalizeTarget(value);
  const generation = operationGeneration;
  const exposedTarget = sanitizeUrlForExposure(target) || "受保护页面";
  const task = createTask(label, exposedTarget, "running");
  if (state.authPrompt || waitingAuthTasks.size > 0) {
    cancelAuthPrompt("已由新的导航任务取代");
  }
  setRuntime("running", `${label}：${exposedTarget}`);

  if (view.webContents.isLoading()) {
    view.webContents.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }

  let stalled = false;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      view.webContents.loadURL(target),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          stalled = true;
          reject(new Error("PAGE_LOAD_TIMEOUT"));
        }, 15_000);
      }),
    ]);
  } catch (error) {
    if (generation !== operationGeneration) {
      throw createTaskStoppedError();
    }
    if (!stalled) {
      updateTask(task.id, "error", (error as Error).message);
      setRuntime("error", "页面加载失败");
      throw error;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assertOperationCurrent(generation);
  updateNavigationState();
  if (stalled) {
    const prompt: AuthPrompt = {
      id: randomUUID(),
      tabId,
      reason: "stalled",
      title: "页面长时间没有进展",
      detail: "页面加载超过 15 秒，请检查是否需要登录、验证码或手工操作。",
      url: view.webContents.getURL() || target,
      detectedAt: new Date().toISOString(),
    };
    setAuthPrompt(prompt, task.id);
    return { url: prompt.url, authPrompt: prompt };
  }

  const authPrompt = await inspectForAuthentication(task.id, tabId).catch(() => null);
  assertOperationCurrent(generation);
  if (!authPrompt) {
    updateTask(task.id, "done", view.webContents.getTitle() || target);
    finishRuntime("页面已就绪");
  }
  return { url: view.webContents.getURL(), authPrompt };
}

function enqueueNavigation(
  value: string,
  label = "打开网页",
  allowWhilePaused = false,
  tabId = activeTabId,
): Promise<{ url: string; authPrompt: AuthPrompt | null }> {
  const queuedGeneration = operationGeneration;
  const run = async () => {
    assertOperationCurrent(queuedGeneration);
    return navigateTo(value, label, allowWhilePaused, tabId);
  };
  const result = navigationQueue.then(run, run);
  navigationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function observePage(maxCharacters = 30_000, requestedTabId = activeTabId): Promise<BrowserObservation> {
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  const view = requireBrowserView(tabId);
  const safeLimit = Math.min(Math.max(Math.floor(maxCharacters), 1_000), 100_000);
  const observation = (await view.webContents.executeJavaScript(`(() => {
    const limit = ${safeLimit};
    const links = [...document.querySelectorAll('a[href]')].slice(0, 120).map((anchor) => ({
      text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 240),
      href: anchor.href,
    }));
    const forms = [...document.forms].slice(0, 30).map((form) => ({
      action: form.action || location.href,
      method: (form.method || 'get').toLowerCase(),
      hasPassword: Boolean(form.querySelector('input[type="password"]')),
    }));
    const text = (document.body?.innerText || '').slice(0, limit);
    return {
      title: document.title,
      url: location.href,
      text,
      links,
      forms,
      authRequired: forms.some((form) => form.hasPassword) || /统一身份认证|校外访问|验证码|sign in|log in/i.test(text.slice(0, 6000)),
      capturedAt: new Date().toISOString(),
    };
  })()`, true)) as BrowserObservation;

  const exposedObservation: BrowserObservation = {
    ...observation,
    tabId,
    url: sanitizeUrlForExposure(observation.url),
    links: observation.links.map((link) => ({ ...link, href: sanitizeUrlForExposure(link.href) })),
    forms: observation.forms.map((form) => ({ ...form, action: sanitizeUrlForExposure(form.action) })),
  };
  createTask("读取页面结构", `${observation.title} · ${observation.text.length} 字符`, "done");
  return exposedObservation;
}

function downloadRequestKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function loadedPdfForTab(tabId: string): LoadedPdfResponse | undefined {
  const loaded = loadedPdfResponses.get(tabId);
  const currentUrl = browserTabs.get(tabId)?.view.webContents.getURL() || "";
  if (!loaded || !currentUrl) return undefined;
  if (loaded.url === currentUrl) return loaded;
  return sanitizeResourceUrl(loaded.url) === sanitizeResourceUrl(currentUrl) ? loaded : undefined;
}

function valueLooksLikePdf(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^pdf$/i.test(normalized) || /\.pdf(?:$|[/?#&])/i.test(normalized)) return true;
  try {
    const url = new URL(normalized);
    if (/\.pdf(?:$|\/)/i.test(url.pathname) || /(?:\/doi\/pdf\/|\/pdfft\/?$|\/pdf\/?$)/i.test(url.pathname)) return true;
    return [...url.searchParams.values()].some((candidate) => {
      try {
        return /\.pdf(?:$|[/?#&])/i.test(decodeURIComponent(candidate));
      } catch {
        return /\.pdf(?:$|[/?#&])/i.test(candidate);
      }
    });
  } catch {
    return false;
  }
}

function tabLooksLikePdf(tabId: string): boolean {
  const contents = browserTabs.get(tabId)?.view.webContents;
  if (!contents) return false;
  const summary = state.tabs.find((tab) => tab.id === tabId);
  const activeValues = tabId === activeTabId ? [state.url, state.title] : [];
  return [contents.getURL(), contents.getTitle(), summary?.url || "", summary?.title || "", ...activeValues]
    .some(valueLooksLikePdf);
}

async function waitForLoadedPdf(tabId: string, timeoutMs = 2_500): Promise<LoadedPdfResponse | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loaded = loadedPdfForTab(tabId);
    if (loaded) return loaded;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return loadedPdfForTab(tabId);
}

async function captureVisiblePdfWithPrint(tabId: string): Promise<LoadedPdfResponse> {
  const existing = await waitForLoadedPdf(tabId);
  if (existing) return existing;
  if (!tabLooksLikePdf(tabId)) throw new Error("The active tab is not a visible PDF.");
  const contents = requireBrowserView(tabId).webContents;
  const data = await contents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
  });
  if (data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Chromium could not export the visible PDF.");
  }
  const currentUrl = contents.getURL();
  const title = sanitizeDownloadName(contents.getTitle() || "document.pdf");
  const loaded: LoadedPdfResponse = {
    tabId,
    url: currentUrl,
    fileName: title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`,
    data,
    capturedAt: new Date().toISOString(),
  };
  loadedPdfResponses.set(tabId, loaded);
  return loaded;
}

async function saveLoadedPdf(tabId: string, existingTaskId?: string): Promise<{
  jobId: string;
  url: string;
  tabId: string;
  documentId?: string;
  reused: boolean;
}> {
  const loaded = loadedPdfForTab(tabId) || await captureVisiblePdfWithPrint(tabId);
  if (loaded.savedDownloadId) {
    const existing = state.downloads.find((download) => download.id === loaded.savedDownloadId && download.state === "completed");
    if (existing?.path && await fs.access(existing.path).then(() => true, () => false)) {
      return { jobId: existing.id, url: loaded.url, tabId, reused: true };
    }
  }

  const generation = operationGeneration;
  const task = existingTaskId
    ? state.tasks.find((candidate) => candidate.id === existingTaskId) || createTask("保存已打开的 PDF", loaded.fileName, "running")
    : createTask("保存已打开的 PDF", loaded.fileName, "running");
  updateTask(task.id, "running", "正在保存浏览器已加载的 PDF，不重新请求出版社地址");
  setRuntime("downloading", "正在保存已打开的 PDF");
  const fileName = loaded.fileName.toLowerCase().endsWith(".pdf") ? loaded.fileName : `${loaded.fileName}.pdf`;
  const savePath = uniqueDownloadPath(fileName);
  const temporaryPath = `${savePath}.part`;
  await fs.writeFile(temporaryPath, loaded.data);
  await fs.rename(temporaryPath, savePath);
  assertOperationCurrent(generation);
  const now = new Date().toISOString();
  const download: DownloadItem = {
    id: task.id,
    fileName: path.basename(savePath),
    path: savePath,
    url: loaded.url,
    receivedBytes: loaded.data.length,
    totalBytes: loaded.data.length,
    state: "completed",
    createdAt: now,
    updatedAt: now,
  };
  state.downloads = [download, ...state.downloads.filter((candidate) => candidate.id !== task.id)].slice(0, MAX_DOWNLOADS);
  loaded.savedDownloadId = task.id;
  failedDownloadRequests.delete(downloadRequestKey(loaded.url));
  broadcastState();
  updateTask(task.id, "running", `正在解析 ${download.fileName}`);
  setRuntime("parsing", `正在解析 ${download.fileName}`);
  try {
    const document = await documentService.importPdf(savePath, loaded.url);
    assertOperationCurrent(generation);
    state.documents = documentService.list();
    updateTask(task.id, "done", `${document.pages} 页 · ${document.characters} 字符 · 已复用浏览器中的 PDF`);
    finishRuntime("已保存并解析当前 PDF");
    return { jobId: task.id, url: loaded.url, tabId, documentId: document.id, reused: false };
  } catch (error) {
    if ((error as Error).name === "TASK_STOPPED") throw error;
    updateTask(task.id, "error", `PDF 已保存，但解析失败：${(error as Error).message}`);
    setRuntime("error", "PDF 已保存，但解析失败");
    throw error;
  }
}

async function findDownloadCandidates(requestedTabId = activeTabId): Promise<Array<{
  id: string;
  text: string;
  url: string;
  source: "link" | "loaded_pdf" | "visible_pdf";
}>> {
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  const view = requireBrowserView(tabId);
  const pageUrl = view.webContents.getURL();
  let rawCandidates: Array<{ text: string; url: string }> = [];
  try {
    rawCandidates = (await view.webContents.executeJavaScript(`(() => {
      const patterns = /pdf|download|full[ -]?text|全文|下载/i;
      const seen = new Set();
      return [...document.querySelectorAll('a[href]')]
        .map((anchor) => ({
          text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 240),
          url: anchor.href,
        }))
        .filter((item) => item.url && (/\\.pdf(?:$|[?#])/i.test(item.url) || patterns.test(item.text)))
        .filter((item) => {
          if (seen.has(item.url)) return false;
          seen.add(item.url);
          return true;
        })
        .slice(0, 40);
    })()`, true)) as Array<{ text: string; url: string }>;
  } catch {
    // Chromium's built-in PDF viewer may not expose a regular page DOM.
  }
  downloadCandidates.clear();
  const results: Array<{ id: string; text: string; url: string; source: "link" | "loaded_pdf" | "visible_pdf" }> = [];
  const loaded = loadedPdfForTab(tabId);
  if (loaded) {
    const id = `cb-download-${randomUUID()}`;
    downloadCandidates.set(id, { url: loaded.url, pageUrl, tabId, source: "loaded_pdf" });
    results.push({
      id,
      text: "当前浏览器中已加载的 PDF（推荐，避免重复授权）",
      url: sanitizeResourceUrl(loaded.url),
      source: "loaded_pdf",
    });
  } else if (tabLooksLikePdf(tabId)) {
    const id = `cb-download-${randomUUID()}`;
    downloadCandidates.set(id, { url: pageUrl, pageUrl, tabId, source: "visible_pdf" });
    results.push({
      id,
      text: "当前可见 PDF（将从 Chromium 阅读器导出）",
      url: sanitizeResourceUrl(pageUrl),
      source: "visible_pdf",
    });
  }
  for (const candidate of rawCandidates) {
    const id = `cb-download-${randomUUID()}`;
    downloadCandidates.set(id, { url: candidate.url, pageUrl, tabId, source: "link" });
    results.push({ id, text: candidate.text, url: sanitizeResourceUrl(candidate.url), source: "link" });
  }
  return results;
}

async function startDownload(
  url?: string,
  candidateId?: string,
  requestedTabId = activeTabId,
): Promise<{ jobId: string; url: string; tabId: string }> {
  assertAutomationAllowed();
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  let target = url;
  if (!target && candidateId) {
    const candidate = downloadCandidates.get(candidateId);
    if (!candidate || candidate.tabId !== tabId) {
      throw new Error("The download candidate is stale. Call paper_find_downloads again.");
    }
    if (candidate.source === "loaded_pdf" || candidate.source === "visible_pdf") {
      if (!loadedPdfForTab(tabId) && !tabLooksLikePdf(tabId)) {
        throw new Error("The local PDF candidate is stale. Call paper_find_downloads again.");
      }
      return saveLoadedPdf(tabId);
    }
    if (candidate.pageUrl !== requireBrowserView(tabId).webContents.getURL()) {
      throw new Error("The download candidate is stale. Call paper_find_downloads again.");
    }
    target = candidate.url;
  }
  if (!target) {
    if (loadedPdfForTab(tabId) || tabLooksLikePdf(tabId)) return saveLoadedPdf(tabId);
    const candidate = (await findDownloadCandidates(tabId))[0];
    const stored = candidate ? downloadCandidates.get(candidate.id) : undefined;
    if (stored?.source === "loaded_pdf" || stored?.source === "visible_pdf") return saveLoadedPdf(tabId);
    target = stored?.url;
  }
  if (!target) {
    throw new Error("No PDF or download link was found on the current page.");
  }
  const parsed = new URL(target);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS downloads are supported.");
  }
  const loaded = loadedPdfForTab(tabId);
  if (loaded && sanitizeResourceUrl(loaded.url) === sanitizeResourceUrl(target)) return saveLoadedPdf(tabId);
  const previousFailure = failedDownloadRequests.get(downloadRequestKey(target));
  if (previousFailure && Date.now() - previousFailure.failedAt < 60_000) {
    const error = new Error("This exact download request recently returned HTML instead of a PDF. Reopen the PDF or refresh download candidates before retrying.");
    error.name = "DOWNLOAD_RETRY_BLOCKED";
    throw error;
  }

  const task = createTask("请求下载", sanitizeUrlForExposure(target) || "受保护下载地址", "running");
  const pending = {
    taskId: task.id,
    tabId,
    url: target,
    timeout: setTimeout(() => {
      const index = pendingDownloads.findIndex((candidate) => candidate.taskId === task.id);
      if (index !== -1) {
        const [expired] = pendingDownloads.splice(index, 1);
        cancelledPendingDownloads.push({
          taskId: expired.taskId,
          url: expired.url,
          expiresAt: Date.now() + 60_000,
        });
      }
      const current = state.tasks.find((candidate) => candidate.id === task.id);
      if (current?.status === "running") {
        updateTask(task.id, "error", "浏览器没有启动预期的下载");
        if (pendingDownloads.length === 0 && activeDownloadJobs.size === 0) {
          setRuntime("error", "浏览器没有启动预期的下载");
        }
      }
    }, 20_000),
  };
  pendingDownloads.push(pending);
  setRuntime("downloading", "正在请求文件下载");
  try {
    requireSession().downloadURL(target);
  } catch (error) {
    clearTimeout(pending.timeout);
    const index = pendingDownloads.findIndex((candidate) => candidate.taskId === task.id);
    if (index !== -1) pendingDownloads.splice(index, 1);
    updateTask(task.id, "error", (error as Error).message);
    throw error;
  }
  return { jobId: task.id, url: target, tabId };
}

function sanitizeDownloadName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim().slice(0, 180) || "download.bin";
}

function uniqueDownloadPath(fileName: string): string {
  const safeName = sanitizeDownloadName(fileName);
  const extension = path.extname(safeName);
  const baseName = path.basename(safeName, extension);
  return path.join(downloadsDir, `${baseName}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`);
}

function downloadUrlsMatch(first: string, second: string): boolean {
  try {
    return new URL(first).toString() === new URL(second).toString();
  } catch {
    return first === second;
  }
}

async function readFileSignature(filePath: string, length = 5): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("ascii");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function reconcileDownloadDirectory(): Promise<void> {
  const knownPaths = new Set(
    state.downloads
      .map((download) => download.path ? path.resolve(download.path).toLowerCase() : "")
      .filter(Boolean),
  );
  const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
  const existingFileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const fileName of ignoredDownloadFiles) {
    if (!existingFileNames.has(fileName)) ignoredDownloadFiles.delete(fileName);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (ignoredDownloadFiles.has(entry.name)) continue;
    const filePath = path.join(downloadsDir, entry.name);
    if (!knownPaths.has(path.resolve(filePath).toLowerCase())) {
      const stat = await fs.stat(filePath);
      const timestamp = (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
      state.downloads.push({
        id: randomUUID(),
        fileName: entry.name,
        path: filePath,
        url: "",
        receivedBytes: stat.size,
        totalBytes: stat.size,
        state: "completed",
        createdAt: timestamp,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    if (await readFileSignature(filePath).catch(() => "") === "%PDF-") {
      await documentService.importPdf(filePath).catch((error) => logRuntime(`Failed to reconcile PDF ${entry.name}`, error));
    }
  }
  state.downloads = state.downloads
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_DOWNLOADS);
  state.documents = documentService.list();
}

function registerDownloadListener(targetSession: Session): void {
  targetSession.on("will-download", (_event, item, sourceContents) => {
    const urlChain = item.getURLChain();
    const nowMs = Date.now();
    for (let index = cancelledPendingDownloads.length - 1; index >= 0; index -= 1) {
      if (cancelledPendingDownloads[index].expiresAt <= nowMs) cancelledPendingDownloads.splice(index, 1);
    }
    const cancelledIndex = cancelledPendingDownloads.findIndex((pending) => urlChain.some((url) => downloadUrlsMatch(url, pending.url)));
    if (cancelledIndex !== -1) {
      cancelledPendingDownloads.splice(cancelledIndex, 1);
      item.cancel();
      return;
    }
    const pendingIndex = pendingDownloads.findIndex((pending) => urlChain.some((url) => downloadUrlsMatch(url, pending.url)));
    const pending = pendingIndex === -1 ? undefined : pendingDownloads.splice(pendingIndex, 1)[0];
    if (pending) clearTimeout(pending.timeout);
    const task = (pending ? state.tasks.find((candidate) => candidate.id === pending.taskId) : undefined)
      || createTask("浏览器下载", item.getURL(), "running");
    const id = task.id;
    const generation = operationGeneration;
    activeDownloadJobs.set(id, item);
    const savePath = uniqueDownloadPath(item.getFilename());
    const now = new Date().toISOString();
    const download: DownloadItem = {
      id,
      fileName: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      state: "starting",
      createdAt: now,
      updatedAt: now,
    };
    state.downloads = [download, ...state.downloads.filter((candidate) => candidate.id !== id)].slice(0, MAX_DOWNLOADS);
    item.setSavePath(savePath);
    updateTask(id, "running", download.fileName);
    broadcastState();

    item.on("updated", (_updateEvent, status) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = status;
      download.updatedAt = new Date().toISOString();
      setRuntime("downloading", `正在下载 ${download.fileName}`);
      broadcastState();
    });

    item.once("done", async (_doneEvent, status) => {
      activeDownloadJobs.delete(id);
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = status;
      download.updatedAt = new Date().toISOString();
      broadcastState();

      if (generation !== operationGeneration) {
        return;
      }

      if (status !== "completed") {
        updateTask(id, "error", `${download.fileName} · ${status}`);
        setRuntime("error", "下载未完成");
        return;
      }

      const header = await readFileSignature(savePath).catch(() => "");
      const isPdf = header === "%PDF-";
      const expectedPdf = item.getMimeType().toLowerCase().includes("pdf")
        || /\.pdf(?:$|[?#])/i.test(item.getURL())
        || download.fileName.toLowerCase().endsWith(".pdf");

      if (!isPdf) {
        if (expectedPdf || item.getMimeType().toLowerCase().includes("html")) {
          download.state = "interrupted";
          download.updatedAt = new Date().toISOString();
          await fs.unlink(savePath).catch(() => undefined);
          broadcastState();
          updateTask(id, "waiting_user", "下载返回了登录页或 HTML，而不是 PDF");
          const sourceTabId = [...browserTabs.values()].find((record) => record.view.webContents.id === sourceContents.id)?.id
            || pending?.tabId
            || activeTabId;
          if (loadedPdfForTab(sourceTabId)) {
            state.downloads = state.downloads.filter((candidate) => candidate.id !== id);
            updateTask(id, "running", "网络下载返回 HTML，改为保存浏览器中已加载的 PDF");
            broadcastState();
            await saveLoadedPdf(sourceTabId, id).catch((error) => {
              updateTask(id, "error", (error as Error).message);
              setRuntime("error", "保存已打开的 PDF 失败");
            });
            return;
          }
          const failedUrl = pending?.url || item.getURL();
          const failureKey = downloadRequestKey(failedUrl);
          const previousFailure = failedDownloadRequests.get(failureKey);
          failedDownloadRequests.set(failureKey, {
            failedAt: Date.now(),
            reason: "HTML_RESPONSE",
          });
          if (previousFailure && Date.now() - previousFailure.failedAt < 60_000) {
            updateTask(id, "error", "相同下载地址再次返回 HTML，已停止重复授权提示。请重新打开 PDF 或刷新下载候选。 ");
            finishRuntime("已阻止重复下载循环");
            return;
          }
          setAuthPrompt({
            id: randomUUID(),
            tabId: sourceTabId,
            reason: "forbidden",
            title: "论文下载需要重新授权",
            detail: "下载结果不是 PDF。请在浏览器中重新完成高校或出版社授权后再试。",
            url: item.getURL(),
            detectedAt: new Date().toISOString(),
          }, id, "retry");
          return;
        }
        updateTask(id, "done", download.fileName);
        finishRuntime("文件已下载");
        return;
      }

      if (pending?.url) failedDownloadRequests.delete(downloadRequestKey(pending.url));
      failedDownloadRequests.delete(downloadRequestKey(item.getURL()));
      updateTask(id, "running", `正在解析 ${download.fileName}`);
      setRuntime("parsing", `正在解析 ${download.fileName}`);
      try {
        const document = await documentService.importPdf(savePath, download.url);
        if (generation !== operationGeneration) {
          state.documents = documentService.list();
          broadcastState();
          return;
        }
        state.documents = documentService.list();
        updateTask(id, "done", `${document.pages} 页 · ${document.characters} 字符`);
        finishRuntime("PDF 已进入文献库");
      } catch (error) {
        if (generation !== operationGeneration) return;
        updateTask(id, "error", (error as Error).message);
        setRuntime("error", "PDF 解析失败");
      }
    });
  });
}

function normalizeAssistanceKind(value: unknown): AssistanceKind {
  const kind = String(value || "manual_action") as AssistanceKind;
  const supported: AssistanceKind[] = [
    "credential",
    "verification",
    "consent",
    "file_selection",
    "permission",
    "manual_action",
  ];
  if (!supported.includes(kind)) throw new Error("Unsupported assistance kind.");
  return kind;
}

function sanitizeAssistanceNote(value: unknown): string | undefined {
  if (value == null) return undefined;
  const note = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, 2_000);
  return note || undefined;
}

function requestHumanAssistance({
  kind,
  title,
  detail,
  tabId: requestedTabId,
  taskId,
}: {
  kind: AssistanceKind;
  title: string;
  detail: string;
  tabId?: string;
  taskId?: string;
}): HumanAssistance {
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  if (state.assistance?.status === "waiting_user") {
    const previous = state.tasks.find((task) => task.id === state.assistance?.taskId);
    if (previous) updateTask(previous.id, "error", "已由新的人工协助请求取代");
  }
  const normalizedTitle = title.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "需要你的协助";
  const normalizedDetail = detail.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 2_000) || "请在可见浏览器中完成当前步骤。";
  const task = taskId
    ? state.tasks.find((candidate) => candidate.id === taskId) || createTask(normalizedTitle, normalizedDetail, "waiting_user")
    : createTask(normalizedTitle, normalizedDetail, "waiting_user");
  updateTask(task.id, "waiting_user", normalizedDetail);
  const assistance: HumanAssistance = {
    id: randomUUID(),
    tabId,
    taskId: task.id,
    kind,
    title: normalizedTitle,
    detail: normalizedDetail,
    url: requireBrowserView(tabId).webContents.getURL(),
    status: "waiting_user",
    requestedAt: new Date().toISOString(),
  };
  state.assistance = assistance;
  setRuntime("waiting_user", `等待你的协助：${normalizedTitle}`);
  showWindow();
  mainWindow?.flashFrame(true);
  if (Notification.isSupported()) {
    new Notification({
      title: "Codex 请求你协助浏览器",
      body: normalizedDetail,
      silent: false,
    }).show();
  }
  return { ...assistance };
}

async function completeHumanAssistance(
  assistanceId: string,
  outcome: "completed" | "unable",
  note?: unknown,
): Promise<HumanAssistance> {
  const assistance = state.assistance;
  if (!assistance || assistance.id !== assistanceId) throw new Error("The assistance request is stale or missing.");
  if (assistance.status !== "waiting_user") return { ...assistance };
  if (assistance.tabId !== activeTabId) activateBrowserTab(assistance.tabId);

  if (outcome === "completed" && (assistance.kind === "credential" || assistance.kind === "verification")) {
    const prompt = await inspectForAuthentication(assistance.taskId, assistance.tabId).catch(() => null);
    if (prompt) {
      assistance.detail = "页面仍显示登录、密码或验证步骤，请完成后再交还控制。";
      broadcastState();
      return { ...assistance };
    }
  }

  assistance.status = outcome;
  assistance.note = sanitizeAssistanceNote(note);
  assistance.resolvedAt = new Date().toISOString();
  updateTask(
    assistance.taskId,
    outcome === "completed" ? "done" : "error",
    assistance.note || (outcome === "completed" ? "用户已完成手工步骤" : "用户暂时无法完成手工步骤"),
  );
  mainWindow?.flashFrame(false);
  if (state.authPrompt) {
    setRuntime("waiting_user", "人工步骤已处理，仍在等待授权确认");
  } else if (state.dialogs.some((dialog) => dialog.sensitive)) {
    setRuntime("waiting_user", "人工步骤已处理，仍有敏感网页对话框");
  } else {
    finishRuntime(outcome === "completed" ? "用户已交还浏览器控制" : "用户未能完成手工步骤");
  }
  return { ...assistance };
}

function isSensitiveDialog(message: string, defaultValue?: string): boolean {
  return /password|passcode|passwd|otp|one.?time|verification code|验证码|动态口令|secret|token/i.test(`${message} ${defaultValue || ""}`);
}

function handleDialogOpened(tabId: string, params: Record<string, unknown>): BrowserDialogPrompt | undefined {
  const type = String(params.type || "alert") as BrowserDialogPrompt["type"];
  if (!["alert", "confirm", "prompt", "beforeunload"].includes(type)) return undefined;
  const message = String(params.message || "").slice(0, 4_000);
  const defaultValue = params.defaultPrompt == null ? undefined : String(params.defaultPrompt).slice(0, 2_000);
  const existing = state.dialogs.find((candidate) => candidate.tabId === tabId);
  const dialog: BrowserDialogPrompt = {
    id: existing?.type === type && existing.message === message ? existing.id : randomUUID(),
    tabId,
    type,
    message,
    defaultValue,
    url: String(params.url || browserTabs.get(tabId)?.view.webContents.getURL() || ""),
    sensitive: isSensitiveDialog(message, defaultValue),
    openedAt: existing?.type === type && existing.message === message ? existing.openedAt : new Date().toISOString(),
  };
  state.dialogs = [dialog, ...state.dialogs.filter((candidate) => candidate.tabId !== tabId)];
  if (existing?.id === dialog.id) {
    broadcastState();
    return dialog;
  }
  const task = createTask("处理网页对话框", `${type} · ${message.slice(0, 240)}`, dialog.sensitive ? "waiting_user" : "running");
  dialogTaskIds.set(dialog.id, task.id);
  setRuntime(dialog.sensitive ? "waiting_user" : "running", dialog.sensitive ? "网页对话框需要你的输入" : "网页对话框等待处理");
  showWindow();
  if (dialog.sensitive) {
    mainWindow?.flashFrame(true);
    if (Notification.isSupported()) {
      new Notification({
        title: "网页对话框需要你的操作",
        body: message || "请在 Codex Browser 中处理当前网页对话框。",
      }).show();
    }
  }
  return dialog;
}

function handleDialogClosed(tabId: string): void {
  const closed = state.dialogs.filter((dialog) => dialog.tabId === tabId);
  if (closed.length === 0) return;
  state.dialogs = state.dialogs.filter((dialog) => dialog.tabId !== tabId);
  for (const dialog of closed) {
    const taskId = dialogTaskIds.get(dialog.id);
    if (taskId) updateTask(taskId, "done", "网页对话框已关闭");
    dialogTaskIds.delete(dialog.id);
  }
  if (!state.authPrompt && state.assistance?.status !== "waiting_user" && state.dialogs.length === 0) {
    finishRuntime("网页对话框已处理");
  } else {
    broadcastState();
  }
}

function pdfFileNameFromResponse(url: string, headers: Record<string, unknown>): string {
  const dispositionEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-disposition");
  const disposition = dispositionEntry ? String(dispositionEntry[1]) : "";
  const encodedMatch = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  let fileName = encodedMatch?.[1] || plainMatch?.[1] || "";
  if (fileName) {
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // Keep the server-provided name if it is not valid percent encoding.
    }
  }
  if (!fileName) {
    try {
      fileName = path.basename(new URL(url).pathname) || "document.pdf";
    } catch {
      fileName = "document.pdf";
    }
  }
  const safeName = sanitizeDownloadName(fileName);
  return safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`;
}

async function captureLoadedPdfResponse(record: BrowserTabRecord, requestId: string): Promise<void> {
  const key = `${record.id}:${requestId}`;
  const pending = pendingPdfResponses.get(key);
  if (!pending || !record.view.webContents.debugger.isAttached()) return;
  try {
    const result = await record.view.webContents.debugger.sendCommand("Network.getResponseBody", { requestId }) as {
      body?: string;
      base64Encoded?: boolean;
    };
    if (!result.body) return;
    let data = Buffer.from(result.body, result.base64Encoded ? "base64" : "binary");
    const headerOffset = data.subarray(0, Math.min(data.length, 1_024)).indexOf(Buffer.from("%PDF-"));
    if (headerOffset < 0) return;
    if (headerOffset > 0) data = data.subarray(headerOffset);
    if (data.length > 120 * 1024 * 1024) {
      logRuntime(`Loaded PDF in tab ${record.id} exceeds the in-memory capture limit`);
      return;
    }
    loadedPdfResponses.set(record.id, {
      tabId: record.id,
      url: pending.url,
      fileName: pending.fileName,
      data,
      capturedAt: new Date().toISOString(),
    });
    if (record.id === activeTabId) {
      state.currentAction = "PDF 已在浏览器中加载，可直接保存，无需重新授权";
      broadcastState(false);
    } else {
      broadcastState(false);
    }
  } catch (error) {
    logRuntime(`Unable to capture the loaded PDF body for tab ${record.id}`, error);
  } finally {
    pendingPdfResponses.delete(key);
  }
}

function setupDialogDebugger(record: BrowserTabRecord): void {
  const contents = record.view.webContents;
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    contents.debugger.on("message", (_event, method, params) => {
      if (method === "Page.javascriptDialogOpening") {
        logRuntime(`JavaScript dialog opening (${String((params as { type?: unknown }).type || "unknown")}) for tab ${record.id}`);
        handleDialogOpened(record.id, params as Record<string, unknown>);
      }
      if (method === "Page.javascriptDialogClosed") {
        logRuntime(`JavaScript dialog closed for tab ${record.id}`);
        handleDialogClosed(record.id);
      }
      if (method === "Network.responseReceived") {
        const payload = params as {
          requestId?: string;
          response?: { url?: string; mimeType?: string; headers?: Record<string, unknown> };
        };
        const requestId = String(payload.requestId || "");
        const responseUrl = String(payload.response?.url || "");
        const mimeType = String(payload.response?.mimeType || "").toLowerCase();
        if (requestId && responseUrl && (mimeType.includes("pdf") || /\.pdf(?:$|[?#])/i.test(responseUrl))) {
          pendingPdfResponses.set(`${record.id}:${requestId}`, {
            tabId: record.id,
            url: responseUrl,
            fileName: pdfFileNameFromResponse(responseUrl, payload.response?.headers || {}),
          });
        }
      }
      if (method === "Network.loadingFinished") {
        const requestId = String((params as { requestId?: string }).requestId || "");
        if (requestId) void captureLoadedPdfResponse(record, requestId);
      }
      if (method === "Network.loadingFailed") {
        const requestId = String((params as { requestId?: string }).requestId || "");
        if (requestId) pendingPdfResponses.delete(`${record.id}:${requestId}`);
      }
    });
    void contents.debugger.sendCommand("Page.enable").catch((error) => logRuntime(`Failed to enable Page debugger for tab ${record.id}`, error));
    void contents.debugger.sendCommand("Network.enable", {
      maxTotalBufferSize: 200 * 1024 * 1024,
      maxResourceBufferSize: 120 * 1024 * 1024,
    }).catch((error) => logRuntime(`Failed to enable Network debugger for tab ${record.id}`, error));
    contents.debugger.once("detach", (_event, reason) => logRuntime(`Debugger detached from tab ${record.id}: ${reason}`));
  } catch (error) {
    logRuntime(`Unable to attach dialog debugger to tab ${record.id}`, error);
  }
}

async function respondToBrowserDialog(
  dialogId: string,
  accept: boolean,
  promptText?: unknown,
  allowSensitive = false,
): Promise<void> {
  const dialogPrompt = state.dialogs.find((candidate) => candidate.id === dialogId);
  if (!dialogPrompt) throw new Error("The browser dialog is stale or missing.");
  if (dialogPrompt.sensitive && !allowSensitive) {
    throw Object.assign(new Error("This dialog may contain a password or verification value. The user must answer it in the desktop browser."), { name: "USER_ACTION_REQUIRED" });
  }
  const record = browserTabs.get(dialogPrompt.tabId);
  if (!record || !record.view.webContents.debugger.isAttached()) throw new Error("The dialog's browser tab is no longer available.");
  const text = promptText == null ? undefined : String(promptText).slice(0, 2_000);
  await record.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", {
    accept,
    ...(accept && dialogPrompt.type === "prompt" ? { promptText: text || "" } : {}),
  });
  handleDialogClosed(dialogPrompt.tabId);
}

function assertSnapshotRevision(tabId: string, revision?: number): void {
  if (revision == null) return;
  const current = snapshotRevisions.get(tabId);
  if (current !== revision) {
    const error = new Error("The page snapshot is stale. Capture a new browser_snapshot for this tab.");
    error.name = "STALE_SNAPSHOT";
    throw error;
  }
}

async function captureBrowserScreenshot(params: Record<string, unknown>) {
  const tabId = resolveTabId(params.tabId);
  if (tabId !== activeTabId) activateBrowserTab(tabId);
  if (state.dialogs.some((dialog) => dialog.tabId === tabId)) throw new Error("Resolve the open browser dialog before capturing a screenshot.");
  assertSnapshotRevision(tabId, params.revision == null ? undefined : Number(params.revision));
  const view = requireBrowserView(tabId);
  const scope = params.scope === "element" ? "element" : "viewport";
  const maxWidth = Math.min(Math.max(Math.floor(Number(params.maxWidth ?? 1_600)), 320), 2_048);
  const redactSensitive = params.redactSensitive !== false;
  let captureRect: Electron.Rectangle | undefined;
  if (scope === "element") {
    const ref = String(params.ref || "").trim();
    if (!ref) throw new Error("Element screenshots require a ref from browser_snapshot.");
    captureRect = await view.webContents.executeJavaScript(`(async () => {
      const element = document.querySelector('[data-codex-browser-ref="' + CSS.escape(${JSON.stringify(ref)}) + '"]');
      if (!element) throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      return {
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.max(1, Math.ceil(Math.min(rect.width, innerWidth - Math.max(0, rect.x)))),
        height: Math.max(1, Math.ceil(Math.min(rect.height, innerHeight - Math.max(0, rect.y)))),
      };
    })()`, true) as Electron.Rectangle;
  }

  const redactionToken = `cb-redaction-${randomUUID()}`;
  if (redactSensitive) {
    await view.webContents.executeJavaScript(`(() => {
      document.getElementById(${JSON.stringify(redactionToken)})?.remove();
      const root = document.createElement('div');
      root.id = ${JSON.stringify(redactionToken)};
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const candidates = [...document.querySelectorAll('input,textarea')].filter((element) => {
        const type = String(element.getAttribute('type') || '').toLowerCase();
        const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase();
        const identity = [element.id, element.getAttribute('name'), element.getAttribute('placeholder'), element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
        return ['password', 'file'].includes(type) || /one-time-code|password/.test(autocomplete) || /password|passcode|passwd|otp|one.?time|验证码|动态口令|secret|token/.test(identity);
      });
      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;background:#202421;border:1px solid #111;border-radius:3px';
        cover.style.left = rect.left + 'px'; cover.style.top = rect.top + 'px';
        cover.style.width = rect.width + 'px'; cover.style.height = rect.height + 'px';
        root.appendChild(cover);
      }
      document.documentElement.appendChild(root);
    })()`, true);
  }

  try {
    let image = await view.webContents.capturePage(captureRect);
    if (image.isEmpty()) throw new Error("The browser returned an empty screenshot.");
    let size = image.getSize();
    if (size.width > maxWidth) {
      image = image.resize({ width: maxWidth, quality: "good" });
      size = image.getSize();
    }
    let buffer = image.toPNG();
    while (buffer.length > MAX_SCREENSHOT_BYTES && size.width > 320) {
      image = image.resize({ width: Math.max(320, Math.floor(size.width * 0.8)), quality: "good" });
      size = image.getSize();
      buffer = image.toPNG();
    }
    if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("The screenshot is too large to return through MCP.");
    createTask("截取页面", `${size.width} × ${size.height}`, "done");
    return {
      data: buffer.toString("base64"),
      mimeType: "image/png",
      width: size.width,
      height: size.height,
      tabId,
      title: view.webContents.getTitle(),
      url: sanitizeUrlForExposure(view.webContents.getURL()),
      capturedAt: new Date().toISOString(),
    };
  } finally {
    if (redactSensitive && !view.webContents.isDestroyed()) {
      await view.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(redactionToken)})?.remove()`, true).catch(() => undefined);
    }
  }
}

interface BrowserCommandContext {
  clientSessionId?: string;
  recordSkillTrace?: boolean;
}

interface BrowserSkillTraceParams {
  params: Record<string, unknown>;
  inputLabels: Record<string, string>;
}

const browserSkillCommandLabels: Record<string, string> = {
  "browser.tab_new": "新建标签页",
  "browser.tab_select": "切换标签页",
  "browser.tab_close": "关闭标签页",
  "browser.navigate": "打开网页",
  "browser.act": "操作页面元素",
  "browser.wait": "等待页面条件",
  "browser.back": "后退",
  "browser.forward": "前进",
  "browser.reload": "刷新页面",
};

function cleanLocatorText(value: string | undefined, limit = 240): string | undefined {
  const cleaned = value?.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  return cleaned || undefined;
}

function browserSkillTargetFromElement(element?: InteractiveElementSnapshot): BrowserSkillTarget | undefined {
  if (!element || element.sensitive) return undefined;
  let hrefPath: string | undefined;
  if (element.href) {
    try {
      const parsed = new URL(element.href);
      hrefPath = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.pathname.slice(0, 500) : undefined;
    } catch {
      hrefPath = undefined;
    }
  }
  const target: BrowserSkillTarget = {
    tag: cleanLocatorText(element.tag, 40),
    role: cleanLocatorText(element.role, 80),
    name: cleanLocatorText(element.name),
    text: cleanLocatorText(element.text),
    type: cleanLocatorText(element.type, 40),
    placeholder: cleanLocatorText(element.placeholder),
    hrefPath,
  };
  return Object.values(target).some(Boolean) ? target : undefined;
}

function browserSkillTargetForParams(params: Record<string, unknown>): BrowserSkillTarget | undefined {
  const tabId = typeof params.tabId === "string" && browserTabs.has(params.tabId) ? params.tabId : activeTabId;
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  if (!tabId || !ref) return undefined;
  return browserSkillTargetFromElement(latestSnapshots.get(tabId)?.elements.find((element) => element.ref === ref));
}

function skillInputPlaceholder(seed: string): string {
  const name = `input_${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
  return `{{${name}}}`;
}

function normalizeBrowserSkillTraceParams(
  method: string,
  params: Record<string, unknown>,
  target?: BrowserSkillTarget,
): BrowserSkillTraceParams {
  const normalized: Record<string, unknown> = {};
  const inputLabels: Record<string, string> = {};
  if (method === "browser.navigate" || method === "browser.tab_new") {
    const raw = String(params.url || "").trim();
    try {
      const parsed = new URL(raw);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported");
      if (parsed.search || parsed.hash) {
        const placeholder = skillInputPlaceholder(`navigate:${raw}`);
        normalized.url = placeholder;
        inputLabels[placeholder.slice(2, -2)] = "目标网址";
      } else {
        normalized.url = `${parsed.origin}${parsed.pathname}`;
      }
    } catch {
      const placeholder = skillInputPlaceholder(`navigate:${raw}`);
      normalized.url = placeholder;
      inputLabels[placeholder.slice(2, -2)] = "网址或搜索内容";
    }
    if (method === "browser.tab_new" && typeof params.activate === "boolean") normalized.activate = params.activate;
  } else if (method === "browser.act") {
    const action = String(params.action || "");
    normalized.action = action;
    if (typeof params.key === "string") normalized.key = params.key.slice(0, 40);
    if (typeof params.deltaX === "number") normalized.deltaX = params.deltaX;
    if (typeof params.deltaY === "number") normalized.deltaY = params.deltaY;
    if (action === "fill" && typeof params.text === "string") {
      const placeholder = skillInputPlaceholder(`fill:${target?.role || ""}:${target?.name || target?.placeholder || "field"}`);
      normalized.text = placeholder;
      inputLabels[placeholder.slice(2, -2)] = target?.name || target?.placeholder || "填写内容";
    }
    if (action === "select" && typeof params.value === "string") {
      const placeholder = skillInputPlaceholder(`select:${target?.role || ""}:${target?.name || "option"}`);
      normalized.value = placeholder;
      inputLabels[placeholder.slice(2, -2)] = target?.name || "选择值";
    }
  } else if (method === "browser.wait") {
    normalized.condition = String(params.condition || "idle");
    if (params.value != null) normalized.value = cleanLocatorText(sanitizeTextForExposure(String(params.value)), 500);
    if (typeof params.timeoutMs === "number") normalized.timeoutMs = Math.min(Math.max(params.timeoutMs, 100), 20_000);
  }
  return { params: normalized, inputLabels };
}

function browserSkillRiskForCommand(
  method: string,
  params: Record<string, unknown>,
  target?: BrowserSkillTarget,
): BrowserSkillRisk {
  if (method !== "browser.act") return "read_only";
  const action = String(params.action || "");
  if (["hover", "focus", "scroll"].includes(action)) return "read_only";
  const identity = `${target?.role || ""} ${target?.name || ""} ${target?.text || ""}`.toLowerCase();
  if ((action === "press" && String(params.key || "").toLowerCase() === "enter")
    || /\b(?:submit|send|delete|remove|purchase|buy|checkout|publish|upload|confirm|save)\b|提交|发送|删除|购买|结算|发布|上传|确认|保存/.test(identity)) {
    return "confirmation";
  }
  return "interaction";
}

function currentBrowserSkillPage(tabId?: string): { url: string; title: string } {
  const record = browserTabs.get(tabId || activeTabId);
  if (!record || record.view.webContents.isDestroyed()) {
    return { url: sanitizeUrlForExposure(state.url), title: cleanLocatorText(state.title, 300) || "" };
  }
  return {
    url: sanitizeUrlForExposure(record.view.webContents.getURL()),
    title: cleanLocatorText(record.view.webContents.getTitle(), 300) || "",
  };
}

function normalizedMatchText(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function scoreBrowserSkillTarget(target: BrowserSkillTarget, element: InteractiveElementSnapshot): number {
  if (element.sensitive || element.disabled) return -1;
  let score = 0;
  const exact = (left?: string, right?: string) => normalizedMatchText(left) === normalizedMatchText(right);
  const includes = (left?: string, right?: string) => {
    const a = normalizedMatchText(left);
    const b = normalizedMatchText(right);
    return Boolean(a && b && (a.includes(b) || b.includes(a)));
  };
  if (target.tag && exact(target.tag, element.tag)) score += 2;
  if (target.role && exact(target.role, element.role)) score += 4;
  if (target.type && exact(target.type, element.type)) score += 2;
  if (target.name) score += exact(target.name, element.name) ? 9 : includes(target.name, element.name) ? 4 : 0;
  if (target.placeholder) score += exact(target.placeholder, element.placeholder) ? 6 : includes(target.placeholder, element.placeholder) ? 2 : 0;
  if (target.text) score += exact(target.text, element.text) ? 5 : includes(target.text, element.text) ? 2 : 0;
  if (target.hrefPath && element.href) {
    try {
      if (new URL(element.href).pathname === target.hrefPath) score += 5;
    } catch {
      // Ignore malformed page links.
    }
  }
  return score;
}

function resolveBrowserSkillElement(
  snapshot: InteractivePageSnapshot,
  target: BrowserSkillTarget,
): InteractiveElementSnapshot {
  const ranked = snapshot.elements
    .map((element) => ({ element, score: scoreBrowserSkillTarget(target, element) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 6) throw new Error("SKILL_PAGE_DRIFT: No page element matched the learned semantic target.");
  if (second && second.score === best.score) throw new Error("SKILL_PAGE_DRIFT: The learned semantic target matched multiple page elements.");
  return best.element;
}

function renderBrowserSkillValue(value: unknown, inputs: Record<string, string | number | boolean>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-z0-9_]+)\}\}$/i);
    if (exact) {
      if (!(exact[1] in inputs)) throw new Error(`Missing browser skill input: ${exact[1]}`);
      return inputs[exact[1]];
    }
    return value.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, name: string) => {
      if (!(name in inputs)) throw new Error(`Missing browser skill input: ${name}`);
      return String(inputs[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderBrowserSkillValue(item, inputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderBrowserSkillValue(item, inputs)]));
  }
  return value;
}

async function recordBrowserSkillCommand(
  request: PipeRequest,
  before: { url: string; title: string },
  target: BrowserSkillTarget | undefined,
  startedAt: number,
  outcome: "success" | "error" | "cancelled",
  detail?: string,
): Promise<void> {
  if (!browserSkillService || !request.clientSessionId || !isTraceableBrowserSkillMethod(request.method)) return;
  const rawParams = request.params || {};
  const normalized = normalizeBrowserSkillTraceParams(request.method, rawParams, target);
  const input: BrowserSkillTraceOperationInput = {
    method: request.method,
    label: browserSkillCommandLabels[request.method],
    params: normalized.params,
    inputLabels: normalized.inputLabels,
    target,
    risk: browserSkillRiskForCommand(request.method, rawParams, target),
    before,
    after: currentBrowserSkillPage(typeof rawParams.tabId === "string" ? rawParams.tabId : undefined),
    outcome,
    detail: sanitizeTextForExposure(detail),
    durationMs: Date.now() - startedAt,
    sanitized: true,
  };
  try {
    await browserSkillService.recordOperation(request.clientSessionId, input);
    await refreshBrowserSkillState();
    mainWindow?.webContents.send("browser:state", desktopState());
  } catch (error) {
    logRuntime(`Failed to record browser skill operation ${request.method}`, error);
  }
}

async function executeBrowserSkill(
  skillId: string,
  providedInputs: Record<string, string | number | boolean> = {},
  userConfirmed = false,
): Promise<BrowserSkillRun> {
  if (!browserSkillService) throw new Error("Browser skill service is not ready.");
  if (state.browserSkillRun?.status === "running") throw new Error("Another browser skill is already running.");
  const skill = await browserSkillService.getSkill(skillId);
  if (!skill) throw new Error(`Browser skill not found: ${skillId}`);
  if (skill.status !== "enabled") throw new Error("Only enabled browser skills can run.");
  if (skill.risk === "confirmation" && !userConfirmed) {
    const error = new Error("This browser skill contains confirmation-risk actions and requires explicit user confirmation for this run.");
    error.name = "USER_CONFIRMATION_REQUIRED";
    throw error;
  }
  const inputs: Record<string, string | number | boolean> = {};
  for (const definition of skill.inputs) {
    if (definition.sensitive) throw new Error("Sensitive browser skill inputs must be completed manually by the user.");
    const value = providedInputs[definition.name] ?? definition.defaultValue;
    if (value === undefined) {
      if (definition.required) throw new Error(`Missing browser skill input: ${definition.label}`);
      continue;
    }
    if (definition.type === "boolean" && typeof value !== "boolean") throw new Error(`${definition.label} must be a boolean.`);
    if (definition.type === "number" && typeof value !== "number") throw new Error(`${definition.label} must be a number.`);
    if (["text", "url"].includes(definition.type) && typeof value !== "string") throw new Error(`${definition.label} must be text.`);
    inputs[definition.name] = value;
  }

  const run: BrowserSkillRun = {
    id: randomUUID(),
    skillId: skill.id,
    skillName: skill.name,
    status: "running",
    currentStep: 0,
    totalSteps: skill.steps.length,
    detail: "准备执行",
    startedAt: new Date().toISOString(),
  };
  state.browserSkillRun = run;
  broadcastState(false);
  const startedAt = Date.now();
  const generation = operationGeneration;
  let lastDetail = "";
  try {
    for (let index = 0; index < skill.steps.length; index += 1) {
      assertOperationCurrent(generation);
      const step = skill.steps[index];
      if (!isLearnableBrowserSkillMethod(step.method)) throw new Error(`Browser skill method is not runnable: ${step.method}`);
      if (step.risk === "confirmation" && !userConfirmed) {
        const error = new Error(`Step ${index + 1} requires explicit user confirmation.`);
        error.name = "USER_CONFIRMATION_REQUIRED";
        throw error;
      }
      run.currentStep = index + 1;
      run.detail = step.label;
      setRuntime("running", `技能：${skill.name} · ${step.label}`);
      state.browserSkillRun = { ...run };
      broadcastState(false);
      const rendered = renderBrowserSkillValue(step.params, inputs) as Record<string, unknown>;
      if (["browser.navigate", "browser.wait", "browser.back", "browser.forward", "browser.reload"].includes(step.method)) {
        rendered.tabId = activeTabId;
      }
      if (step.method === "browser.act") {
        const action = String(rendered.action || "");
        if (step.target) {
          const snapshot = await captureInteractiveSnapshot(requireBrowserView(activeTabId).webContents, 300, 24_000);
          snapshotRevisions.set(activeTabId, snapshot.revision);
          latestSnapshots.set(activeTabId, snapshot);
          const element = resolveBrowserSkillElement(snapshot, step.target);
          rendered.ref = element.ref;
          rendered.revision = snapshot.revision;
        } else if (!["press", "scroll"].includes(action)) {
          throw new Error(`SKILL_PAGE_DRIFT: Step ${index + 1} has no semantic target.`);
        }
        rendered.tabId = activeTabId;
      }
      try {
        await handleCommand(step.method, rendered, { recordSkillTrace: false });
        lastDetail = step.label;
      } catch (error) {
        if (!step.continueOnFailure) throw error;
        lastDetail = `${step.label}（已跳过：${sanitizeTextForExposure((error as Error).message) || "失败"}）`;
      }
    }
    run.status = "done";
    run.detail = lastDetail ? `已完成：${lastDetail}` : "技能已完成";
    run.completedAt = new Date().toISOString();
    await browserSkillService.recordRunResult(skill.id, true, Date.now() - startedAt);
    await refreshBrowserSkillState();
    finishRuntime(`技能“${skill.name}”已完成`);
    state.browserSkillRun = { ...run };
    broadcastState(false);
    return { ...run };
  } catch (error) {
    const stopped = (error as Error).name === "TASK_STOPPED";
    run.status = stopped ? "cancelled" : "error";
    run.detail = sanitizeTextForExposure((error as Error).message) || "技能执行失败";
    run.completedAt = new Date().toISOString();
    const updated = await browserSkillService.recordRunResult(skill.id, false, Date.now() - startedAt).catch(() => null);
    if (updated && updated.stats.failureCount >= 3 && updated.stats.failureCount > updated.stats.successCount) {
      await browserSkillService.setStatus(skill.id, "stale").catch(() => undefined);
    }
    await refreshBrowserSkillState();
    state.browserSkillRun = { ...run };
    if (!stopped) setRuntime("error", `技能“${skill.name}”执行失败`);
    else broadcastState(false);
    throw error;
  }
}

async function handleCommand(
  method: string,
  params: Record<string, unknown> = {},
  context: BrowserCommandContext = {},
): Promise<unknown> {
  switch (method) {
    case "browser.capabilities":
      return {
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        capabilities: [
          "persistent-profile",
          "encrypted-session-cookie-backup",
          "local-state-recovery",
          "session-health-check",
          "visible-browser",
          "dom-observation",
          "referenced-page-snapshot",
          "safe-element-actions",
          "visual-screenshot",
          "event-driven-waits",
          "navigation",
          "multi-tab",
          "popup-capture",
          "javascript-dialog-control",
          "downloads",
          "auth-interruption",
          "pdf-ingestion",
          "document-search",
          "human-takeover",
          "human-assistance-broker",
          "browser-skill-learning",
          "browser-skill-library",
          "guarded-workflow-execution",
        ],
      };
    case "browser.status":
      return mcpState();
    case "browser.tabs":
      return exposedTabsResult();
    case "browser.tab_new": {
      const record = createBrowserTab(
        params.url ? String(params.url) : HOME_URL,
        params.activate !== false,
      );
      return exposedTabsResult({ createdTabId: record.id });
    }
    case "browser.tab_select":
      activateBrowserTab(resolveTabId(params.tabId));
      return exposedTabsResult();
    case "browser.tab_close": {
      const tabId = resolveTabId(params.tabId);
      await closeBrowserTab(tabId, params.force === true);
      return exposedTabsResult();
    }
    case "browser.navigate": {
      const tabId = resolveTabId(params.tabId);
      const result = await enqueueNavigation(String(params.url ?? ""), "打开网页", false, tabId);
      return {
        ...result,
        tabId,
        url: sanitizeUrlForExposure(result.url),
        authPrompt: authPromptForExposure(result.authPrompt),
      };
    }
    case "browser.observe":
      return observePage(Number(params.maxCharacters ?? 30_000), resolveTabId(params.tabId));
    case "browser.snapshot": {
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      const snapshot = await captureInteractiveSnapshot(
        requireBrowserView(tabId).webContents,
        Number(params.maxElements ?? 140),
        Number(params.maxTextCharacters ?? 24_000),
      );
      snapshotRevisions.set(tabId, snapshot.revision);
      latestSnapshots.set(tabId, snapshot);
      createTask("生成页面快照", `${snapshot.elements.length} 个可交互元素`, "done");
      return {
        ...snapshot,
        tabId,
        url: sanitizeUrlForExposure(snapshot.url),
        elements: snapshot.elements.map((element) => ({
          ...element,
          href: element.href ? sanitizeUrlForExposure(element.href) : undefined,
        })),
      };
    }
    case "browser.act": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      assertSnapshotRevision(tabId, params.revision == null ? undefined : Number(params.revision));
      const generation = operationGeneration;
      const action = params as unknown as BrowserAction;
      const labels: Record<BrowserAction["action"], string> = {
        click: "点击页面元素",
        double_click: "双击页面元素",
        hover: "悬停页面元素",
        fill: "填写普通字段",
        press: "发送按键",
        select: "选择选项",
        focus: "聚焦页面元素",
        check: "勾选页面选项",
        uncheck: "取消页面选项",
        scroll: "滚动页面",
      };
      const task = createTask(labels[action.action] || "执行页面动作", "ref" in action ? action.ref : "当前页面", "running");
      setRuntime("running", labels[action.action] || "执行页面动作");
      try {
        if (["click", "double_click", "hover", "check", "uncheck"].includes(action.action)) {
          showWindow();
        }
        const result = await performReferencedAction(requireBrowserView(tabId).webContents, action);
        assertOperationCurrent(generation);
        const dialogPrompt = state.dialogs.find((dialog) => dialog.tabId === tabId) || null;
        if (dialogPrompt) {
          updateTask(task.id, "done", "页面已弹出网页对话框");
          return {
            ...result,
            tabId,
            url: sanitizeUrlForExposure(result.url),
            dialog: dialogsForExposure([dialogPrompt])[0],
          };
        }
        const authPrompt = await inspectForAuthentication(task.id, tabId).catch(() => null);
        assertOperationCurrent(generation);
        if (authPrompt) {
          waitingAuthTasks.set(task.id, "done");
          updateTask(task.id, "waiting_user", authPrompt.detail);
        } else {
          updateTask(task.id, "done", result.description);
          finishRuntime("页面动作已完成");
        }
        return { ...result, tabId, url: sanitizeUrlForExposure(result.url), authPrompt: authPromptForExposure(authPrompt) };
      } catch (error) {
        if ((error as Error).name === "TASK_STOPPED") throw error;
        if ((error as Error).name === "USER_ACTION_REQUIRED") {
          const message = (error as Error).message;
          const kind: AssistanceKind = /file-upload|file upload|file picker/i.test(message)
            ? "file_selection"
            : /verification|one-time|otp|验证码|动态口令/i.test(message)
              ? "verification"
              : /password|credential|登录/i.test(message)
                ? "credential"
                : "manual_action";
          requestHumanAssistance({
            kind,
            title: kind === "file_selection" ? "请选择本地文件" : kind === "verification" ? "请完成验证" : kind === "credential" ? "请完成敏感登录步骤" : "需要你的手工操作",
            detail: message,
            tabId,
            taskId: task.id,
          });
        } else {
          updateTask(task.id, "error", (error as Error).message);
          setRuntime("error", "页面动作失败");
        }
        throw error;
      }
    }
    case "browser.wait": {
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      const generation = operationGeneration;
      const condition = String(params.condition ?? "idle") as BrowserWaitCondition;
      const task = createTask("等待页面条件", `${condition}${params.value ? ` · ${String(params.value)}` : ""}`, "running");
      setRuntime("running", "等待页面变化");
      const result = await waitForBrowserCondition(
        requireBrowserView(tabId).webContents,
        condition,
        params.value == null ? undefined : String(params.value),
        Number(params.timeoutMs ?? 10_000),
      );
      assertOperationCurrent(generation);
      const authPrompt = await inspectForAuthentication(task.id, tabId).catch(() => null);
      assertOperationCurrent(generation);
      if (authPrompt) {
        waitingAuthTasks.set(task.id, "done");
        updateTask(task.id, "waiting_user", authPrompt.detail);
      } else if (result.satisfied) {
        updateTask(task.id, "done", result.detail);
        finishRuntime("等待条件已满足");
      } else {
        updateTask(task.id, "error", result.detail);
        finishRuntime("等待条件超时");
      }
      return {
        ...result,
        detail: sanitizeTextForExposure(result.detail) || result.detail,
        title: sanitizeTextForExposure(result.title) || result.title,
        tabId,
        url: sanitizeUrlForExposure(result.url),
        authPrompt: authPromptForExposure(authPrompt),
      };
    }
    case "browser.back": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      const history = requireBrowserView(tabId).webContents.navigationHistory;
      if (history.canGoBack()) history.goBack();
      return { ok: true };
    }
    case "browser.forward": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      const history = requireBrowserView(tabId).webContents.navigationHistory;
      if (history.canGoForward()) history.goForward();
      return { ok: true };
    }
    case "browser.reload": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) activateBrowserTab(tabId);
      requireBrowserView(tabId).webContents.reload();
      return { ok: true };
    }
    case "browser.screenshot":
      return captureBrowserScreenshot(params);
    case "browser.dialogs": {
      const tabId = params.tabId ? resolveTabId(params.tabId) : undefined;
      return { dialogs: dialogsForExposure(tabId ? state.dialogs.filter((dialog) => dialog.tabId === tabId) : state.dialogs) };
    }
    case "browser.dialog_respond":
      await respondToBrowserDialog(
        String(params.dialogId || ""),
        params.accept === true,
        params.promptText,
        false,
      );
      return { handled: true, dialogs: dialogsForExposure() };
    case "browser.pause":
      setRuntime("paused", "Codex 控制已暂停");
      return { ok: true };
    case "browser.resume":
      if (state.authPrompt) {
        setRuntime("waiting_user", "Codex 控制已恢复，仍在等待授权");
      } else if (state.assistance?.status === "waiting_user") {
        setRuntime("waiting_user", "Codex 控制已恢复，仍在等待人工协助");
      } else if (state.dialogs.some((dialog) => dialog.sensitive)) {
        setRuntime("waiting_user", "Codex 控制已恢复，仍有敏感网页对话框");
      } else {
        setRuntime("idle", "Codex 控制已恢复");
      }
      return { ok: true };
    case "browser.stop":
      operationGeneration += 1;
      for (const record of browserTabs.values()) record.view.webContents.stop();
      state.isLoading = false;
      for (const pending of pendingDownloads) {
        clearTimeout(pending.timeout);
        cancelledPendingDownloads.push({
          taskId: pending.taskId,
          url: pending.url,
          expiresAt: Date.now() + 60_000,
        });
      }
      pendingDownloads.length = 0;
      for (const item of activeDownloadJobs.values()) {
        try {
          item.cancel();
        } catch {
          // A completed download can race with the stop command.
        }
      }
      activeDownloadJobs.clear();
      for (const controller of activeProbeControllers) controller.abort();
      activeProbeControllers.clear();
      for (const dialog of [...state.dialogs]) {
        const record = browserTabs.get(dialog.tabId);
        if (record?.view.webContents.debugger.isAttached()) {
          await record.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
        }
      }
      state.dialogs = [];
      dialogTaskIds.clear();
      state.authPrompt = null;
      waitingAuthTasks.clear();
      if (state.assistance?.status === "waiting_user") {
        state.assistance = {
          ...state.assistance,
          status: "cancelled",
          note: "已由用户停止",
          resolvedAt: new Date().toISOString(),
        };
      }
      for (const task of state.tasks) {
        if (task.status === "queued" || task.status === "running" || task.status === "waiting_user") {
          task.status = "error";
          task.detail = "已由用户停止";
          task.updatedAt = new Date().toISOString();
        }
      }
      mainWindow?.flashFrame(false);
      setRuntime("idle", "任务已停止");
      return { ok: true };
    case "browser_skill.list": {
      if (!browserSkillService) throw new Error("Browser skill service is not ready.");
      const includeDrafts = params.includeDrafts === true;
      const skills = (await browserSkillService.listSkills(true))
        .filter((skill) => includeDrafts || skill.status === "enabled")
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          status: skill.status,
          risk: skill.risk,
          trigger: skill.trigger,
          inputs: skill.inputs,
          stepCount: skill.steps.length,
          stats: skill.stats,
          updatedAt: skill.updatedAt,
        }));
      return { skills };
    }
    case "browser_skill.match": {
      if (!browserSkillService) throw new Error("Browser skill service is not ready.");
      const matches = await browserSkillService.matchSkills(
        String(params.query || ""),
        String(params.url || state.url || ""),
        Number(params.limit || 10),
      );
      return {
        matches: matches.map(({ skill, score, reasons }) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          risk: skill.risk,
          inputs: skill.inputs,
          stepCount: skill.steps.length,
          stats: skill.stats,
          score,
          reasons,
        })),
      };
    }
    case "browser_skill.run": {
      const rawInputs = params.inputs && typeof params.inputs === "object" && !Array.isArray(params.inputs)
        ? params.inputs as Record<string, string | number | boolean>
        : {};
      return executeBrowserSkill(String(params.skillId || ""), rawInputs, params.userConfirmed === true);
    }
    case "browser_skill.learn": {
      if (!browserSkillService) throw new Error("Browser skill service is not ready.");
      if (!context.clientSessionId) throw new Error("A browser MCP task session is required to learn a workflow.");
      const result = await browserSkillService.finalizeTrace(context.clientSessionId, {
        name: typeof params.name === "string" ? params.name : undefined,
        description: typeof params.description === "string" ? params.description : undefined,
      });
      await refreshBrowserSkillState();
      broadcastState(false);
      return result;
    }
    case "browser_skill.feedback": {
      if (!browserSkillService) throw new Error("Browser skill service is not ready.");
      const skill = await browserSkillService.recordRunResult(
        String(params.skillId || ""),
        params.outcome === "success",
        Number(params.durationMs || 0),
      );
      await refreshBrowserSkillState();
      broadcastState(false);
      return { skillId: skill.id, stats: skill.stats };
    }
    case "session.check":
      return checkSessionHealth(resolveTabId(params.tabId));
    case "auth.complete":
      return completeAuthentication(
        params.promptId ? String(params.promptId) : undefined,
        params.tabId ? String(params.tabId) : undefined,
      );
    case "auth.request_login": {
      const tabId = resolveTabId(params.tabId);
      const target = String(params.url ?? state.url ?? HOME_URL);
      showWindow();
      await enqueueNavigation(target, "打开授权页面", false, tabId);
      if (!state.authPrompt) {
        const task = createTask("等待登录授权", sanitizeUrlForExposure(target) || "授权页面", "waiting_user");
        setAuthPrompt({
          id: randomUUID(),
          tabId,
          reason: "login",
          title: "请完成登录授权",
          detail: "请在可见浏览器中完成登录，完成后点击继续。",
          url: requireBrowserView(tabId).webContents.getURL(),
          detectedAt: new Date().toISOString(),
        }, task.id);
      }
      return authPromptForExposure(state.authPrompt);
    }
    case "auth.clear":
      cancelAuthPrompt("授权提醒已清除");
      return { ok: true };
    case "browser.assistance_request":
      return assistanceForExposure(requestHumanAssistance({
        kind: normalizeAssistanceKind(params.kind),
        title: String(params.title || "需要你的协助"),
        detail: String(params.detail || "请在可见浏览器中完成当前步骤。"),
        tabId: params.tabId ? String(params.tabId) : undefined,
      }));
    case "browser.assistance_status":
      if (params.assistanceId && state.assistance?.id !== String(params.assistanceId)) return null;
      return assistanceForExposure(state.assistance);
    case "browser.assistance_complete":
      if (params.userConfirmed !== true) throw new Error("Set userConfirmed=true only after the user explicitly confirms the manual step.");
      return assistanceForExposure(await completeHumanAssistance(
        String(params.assistanceId || ""),
        params.outcome === "unable" ? "unable" : "completed",
        params.note,
      ));
    case "tasks.clear":
      state.tasks = state.tasks.filter((task) => task.status === "queued" || task.status === "running" || task.status === "waiting_user");
      broadcastState();
      return { ok: true };
    case "downloads.clear":
      for (const download of state.downloads) {
        if (download.state !== "starting" && download.state !== "progressing" && download.path && isInsideDirectory(downloadsDir, download.path)) {
          ignoredDownloadFiles.add(path.basename(download.path));
        }
      }
      state.downloads = state.downloads.filter((download) => download.state === "starting" || download.state === "progressing");
      broadcastState();
      return { ok: true };
    case "paper.find_downloads":
      return findDownloadCandidates(resolveTabId(params.tabId));
    case "paper.download": {
      const result = await startDownload(
        params.url ? String(params.url) : undefined,
        params.candidateId ? String(params.candidateId) : undefined,
        resolveTabId(params.tabId),
      );
      return { ...result, url: sanitizeResourceUrl(result.url) };
    }
    case "downloads.list":
      return mcpState().downloads;
    case "document.import": {
      const generation = operationGeneration;
      const filePath = String(params.path ?? "");
      if (!filePath) throw new Error("A PDF path is required.");
      const task = createTask("导入 PDF", path.basename(filePath), "running");
      setRuntime("parsing", "正在导入 PDF");
      try {
        const document = await documentService.importPdf(filePath);
        assertOperationCurrent(generation);
        state.documents = documentService.list();
        updateTask(task.id, "done", `${document.pages} 页 · ${document.characters} 字符`);
        finishRuntime("PDF 已进入文献库");
        return document;
      } catch (error) {
        if ((error as Error).name === "TASK_STOPPED") throw error;
        updateTask(task.id, "error", (error as Error).message);
        setRuntime("error", "PDF 导入失败");
        throw error;
      }
    }
    case "document.list":
      return documentService.list();
    case "document.read":
      return documentService.read(
        String(params.documentId ?? ""),
        Number(params.startPage ?? 1),
        params.endPage == null ? undefined : Number(params.endPage),
      );
    case "document.search":
      return documentService.search(
        String(params.query ?? ""),
        params.documentId ? String(params.documentId) : undefined,
        Number(params.limit ?? 20),
      );
    default:
      throw new Error(`Unknown browser command: ${method}`);
  }
}

async function handlePipeRequest(request: PipeRequest): Promise<PipeResponse> {
  const before = currentBrowserSkillPage(
    typeof request.params?.tabId === "string" ? request.params.tabId : undefined,
  );
  const target = browserSkillTargetForParams(request.params || {});
  const startedAt = Date.now();
  try {
    const result = await handleCommand(request.method, request.params, {
      clientSessionId: request.clientSessionId,
      recordSkillTrace: true,
    });
    await recordBrowserSkillCommand(request, before, target, startedAt, "success");
    return { id: request.id, ok: true, result };
  } catch (error) {
    const typed = error as Error;
    await recordBrowserSkillCommand(
      request,
      before,
      target,
      startedAt,
      typed.name === "TASK_STOPPED" ? "cancelled" : "error",
      typed.message,
    );
    return {
      id: request.id,
      ok: false,
      error: {
        code: typed.name || "BROWSER_ERROR",
        message: sanitizeTextForExposure(typed.message) || "Unknown browser error",
      },
    };
  }
}

function enqueuePipeRequest(request: PipeRequest): Promise<PipeResponse> {
  if ([
    "browser.capabilities",
    "browser.status",
    "browser.pause",
    "browser.resume",
    "browser.stop",
    "browser.dialogs",
    "browser.dialog_respond",
    "browser_skill.list",
    "browser_skill.match",
  ].includes(request.method)) {
    return handlePipeRequest(request);
  }
  const queuedGeneration = operationGeneration;
  const run = () => queuedGeneration === operationGeneration
    ? handlePipeRequest(request)
    : Promise.resolve({
        id: request.id,
        ok: false,
        error: { code: "TASK_STOPPED", message: "The queued browser task was stopped before it started." },
      } satisfies PipeResponse);
  const result = pipeCommandQueue.then(
    run,
    run,
  );
  pipeCommandQueue = result.then(() => undefined, () => undefined);
  return result;
}

function attachPipeSocket(socket: Socket): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        void (async () => {
          let response: PipeResponse;
          try {
            response = await enqueuePipeRequest(JSON.parse(line) as PipeRequest);
          } catch (error) {
            response = {
              id: "invalid",
              ok: false,
              error: { code: "INVALID_REQUEST", message: (error as Error).message },
            };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        })();
      }
      newline = buffer.indexOf("\n");
    }
  });
}

async function startPipeServer(): Promise<void> {
  if (process.platform !== "win32") {
    await fs.unlink(PIPE_PATH).catch(() => undefined);
  }
  pipeServer = createServer(attachPipeSocket);
  await new Promise<void>((resolve, reject) => {
    pipeServer?.once("error", reject);
    pipeServer?.listen(PIPE_PATH, () => resolve());
  });
  logRuntime(`Named pipe listening at ${PIPE_PATH}`);
}

function setupBrowserEvents(record: BrowserTabRecord): void {
  const { view, id: tabId } = record;
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (browserTabs.size >= MAX_TABS) {
      createTask("弹出页面被阻止", `已达到 ${MAX_TABS} 个标签页上限`, "error");
      return { action: "deny" };
    }
    return {
      action: "allow",
      createWindow: (options) => {
        const guest = (options as BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
        if (!guest) throw new Error("Electron did not provide the popup guest WebContents.");
        const popup = createBrowserTab(
          undefined,
          true,
          options.webPreferences,
          undefined,
          new Date().toISOString(),
          guest,
        );
        setImmediate(() => {
          if (popup.view.webContents.getURL() === "about:blank" || popup.view.webContents.getURL() === contents.getURL()) {
            void popup.view.webContents.loadURL(url).catch((error) => {
              if (!(error as Error).message.includes("ERR_ABORTED")) logRuntime(`Popup tab ${popup.id} failed to load`, error);
            });
          }
        });
        createTask("接管弹出页面", sanitizeUrlForExposure(url) || "新页面", "done");
        return popup.view.webContents;
      },
    };
  });
  contents.on("did-start-loading", () => {
    if (tabId === activeTabId) {
      state.isLoading = true;
      if (state.runtimeStatus !== "paused" && state.runtimeStatus !== "waiting_user") {
        setRuntime("running", "页面加载中");
      } else {
        broadcastState();
      }
    } else {
      broadcastState();
    }
  });
  contents.on("did-stop-loading", () => {
    if (tabId !== activeTabId) {
      updateNavigationState(tabId);
      return;
    }
    state.isLoading = false;
    updateNavigationState(tabId);
    void (async () => {
      if (await tryAutoLogin(tabId)) return;
      const prompt = await inspectForAuthentication(undefined, tabId);
      if (!prompt && state.runtimeStatus === "running") setRuntime("idle", "页面已就绪");
    })().catch(() => undefined);
  });
  contents.on("did-navigate", () => updateNavigationState(tabId));
  contents.on("did-navigate-in-page", () => updateNavigationState(tabId));
  contents.on("page-title-updated", () => updateNavigationState(tabId));
  contents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    createTask("页面加载失败", `${validatedUrl} · ${description}`, "error");
    if (tabId === activeTabId) setRuntime("error", "页面加载失败");
  });
  contents.on("destroyed", () => {
    if (!browserTabs.has(tabId)) return;
    const wasActive = activeTabId === tabId;
    removeBrowserTabRecord(tabId);
    if (wasActive) {
      const next = browserTabs.keys().next().value as string | undefined;
      if (next) activateBrowserTab(next, false);
      else if (!isQuitting && mainWindow) createBrowserTab(HOME_URL, true);
    } else {
      broadcastState();
    }
  });
}

function setupIpc(): void {
  ipcMain.handle("browser:get-state", () => desktopState());
  ipcMain.on("browser:set-bounds", (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (!browserView) return;
    browserBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    browserView.setBounds(browserBounds);
  });
  ipcMain.handle("browser:navigate", (_event, url: string) => enqueueNavigation(url, "手动打开网页", true, activeTabId));
  ipcMain.handle("browser:back", () => {
    const history = requireBrowserView().webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
  });
  ipcMain.handle("browser:forward", () => {
    const history = requireBrowserView().webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
  });
  ipcMain.handle("browser:reload", () => requireBrowserView().webContents.reload());
  ipcMain.handle("browser:home", () => enqueueNavigation(HOME_URL, "打开主页", true, activeTabId));
  ipcMain.handle("tabs:create", (_event, url?: string) => {
    const record = createBrowserTab(url || HOME_URL, true);
    return tabSummary(record);
  });
  ipcMain.handle("tabs:select", (_event, tabId: string) => {
    activateBrowserTab(resolveTabId(tabId));
  });
  ipcMain.handle("tabs:close", async (_event, tabId: string) => closeBrowserTab(resolveTabId(tabId), false));
  ipcMain.handle("browser:pause", () => handleCommand("browser.pause"));
  ipcMain.handle("browser:resume", () => handleCommand("browser.resume"));
  ipcMain.handle("browser:stop", () => handleCommand("browser.stop"));
  ipcMain.handle("session:check", () => handleCommand("session.check") as Promise<SessionHealth>);
  ipcMain.handle("auth:complete", (_event, promptId?: string) => handleCommand("auth.complete", { promptId }) as Promise<SessionHealth>);
  ipcMain.handle("credential:save-and-submit", (_event, promptId?: string) => saveAndSubmitLogin(promptId));
  ipcMain.handle("credential:clear-all", () => clearSavedLogins());
  ipcMain.handle(
    "assistance:respond",
    (_event, assistanceId: string, outcome: "completed" | "unable", note?: string) => completeHumanAssistance(assistanceId, outcome, note),
  );
  ipcMain.handle(
    "dialog:respond",
    (_event, dialogId: string, accept: boolean, promptText?: string) => respondToBrowserDialog(dialogId, accept, promptText, true),
  );
  ipcMain.handle("tasks:clear", () => handleCommand("tasks.clear"));
  ipcMain.handle("downloads:clear", () => handleCommand("downloads.clear"));
  ipcMain.handle("downloads:open", async () => {
    const error = await shell.openPath(downloadsDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle("downloads:open-item", async (_event, downloadId: string) => {
    const download = state.downloads.find((candidate) => candidate.id === downloadId);
    if (!download?.path) throw new Error("找不到这条下载记录对应的本地文件。");
    if (!isInsideDirectory(downloadsDir, download.path)) throw new Error("下载记录指向了下载目录之外的文件。");
    await fs.access(download.path);
    const error = await shell.openPath(download.path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("document:import", async () => {
    if (!mainWindow) return null;
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入 PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return handleCommand("document.import", { path: selection.filePaths[0] });
  });
  ipcMain.handle("document:open", async (_event, documentId: string) => {
    const filePath = documentService.getFilePath(documentId);
    await fs.access(filePath);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle("browser-skill:save", async (_event, skill: BrowserSkill) => {
    if (!browserSkillService) throw new Error("Browser skill service is not ready.");
    const saved = await browserSkillService.saveSkill(skill);
    await refreshBrowserSkillState();
    broadcastState(false);
    return saved;
  });
  ipcMain.handle("browser-skill:set-status", async (_event, skillId: string, status: BrowserSkillStatus) => {
    if (!browserSkillService) throw new Error("Browser skill service is not ready.");
    const saved = await browserSkillService.setStatus(skillId, status);
    await refreshBrowserSkillState();
    broadcastState(false);
    return saved;
  });
  ipcMain.handle("browser-skill:delete", async (_event, skillId: string) => {
    if (!browserSkillService) throw new Error("Browser skill service is not ready.");
    if (state.browserSkillRun?.status === "running" && state.browserSkillRun.skillId === skillId) {
      throw new Error("A running browser skill cannot be deleted.");
    }
    await browserSkillService.deleteSkill(skillId);
    await refreshBrowserSkillState();
    broadcastState(false);
  });
  ipcMain.handle("browser-skill:import", async () => {
    if (!mainWindow || !browserSkillService) return null;
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入浏览器技能",
      properties: ["openFile"],
      filters: [
        { name: "Codex Browser Skill", extensions: ["cbskill", "json"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const imported = await browserSkillService.importSkill(selection.filePaths[0]);
    await refreshBrowserSkillState();
    broadcastState(false);
    return imported;
  });
  ipcMain.handle("browser-skill:export", async (_event, skillId: string) => {
    if (!mainWindow || !browserSkillService) return false;
    const skill = await browserSkillService.getSkill(skillId);
    if (!skill) throw new Error(`Browser skill not found: ${skillId}`);
    const safeName = skill.name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/[. ]+$/g, "").slice(0, 80) || "browser-skill";
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "导出浏览器技能",
      defaultPath: `${safeName}.cbskill`,
      filters: [{ name: "Codex Browser Skill", extensions: ["cbskill"] }],
    });
    if (selection.canceled || !selection.filePath) return false;
    await browserSkillService.exportSkill(skillId, selection.filePath);
    return true;
  });
  ipcMain.handle("browser-skill:create-from-trace", async (_event, traceId: string) => {
    if (!browserSkillService) throw new Error("Browser skill service is not ready.");
    const skill = await browserSkillService.createSkillFromTrace(traceId);
    await refreshBrowserSkillState();
    broadcastState(false);
    return skill;
  });
  ipcMain.handle("browser-skill:discard-trace", async (_event, traceId: string) => {
    if (!browserSkillService) throw new Error("Browser skill service is not ready.");
    await browserSkillService.discardTrace(traceId);
    await refreshBrowserSkillState();
    broadcastState(false);
  });
  ipcMain.handle(
    "browser-skill:run",
    (_event, skillId: string, inputs?: Record<string, string | number | boolean>, userConfirmed?: boolean) => (
      executeBrowserSkill(skillId, inputs || {}, userConfirmed === true)
    ),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(brandingPath("tray.png"));
  if (icon.isEmpty()) throw new Error("Codex Browser tray icon could not be loaded.");
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Codex Browser");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 Codex Browser", click: showWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("double-click", showWindow);
}

async function restoreRuntimeState(): Promise<void> {
  if (!persistenceService) return;
  const persisted = await persistenceService.loadRuntimeState(HOME_URL);
  ignoredDownloadFiles.clear();
  for (const fileName of persisted.ignoredDownloadFiles) ignoredDownloadFiles.add(fileName);
  const interruptedAt = new Date().toISOString();
  state.tasks = persisted.tasks.slice(0, MAX_TASKS).map((task) => {
    const restoredTask = { ...task, detail: sanitizePersistedText(task.detail) };
    if (task.status !== "running" && task.status !== "waiting_user" && task.status !== "queued") {
      return restoredTask;
    }
    return {
      ...restoredTask,
      status: "error" as const,
      detail: restoredTask.detail ? `${restoredTask.detail} · 上次退出时中断` : "上次退出时中断",
      updatedAt: interruptedAt,
    };
  });
  let keptHtmlDownloadFailure = false;
  state.tasks = state.tasks.filter((task) => {
    if (!/下载结果不是 PDF|下载返回了登录页或 HTML/.test(task.detail || "")) return true;
    if (keptHtmlDownloadFailure) return false;
    keptHtmlDownloadFailure = true;
    return true;
  });
  const restoredDownloads = persisted.downloads.slice(0, MAX_DOWNLOADS).map((download) => {
    const filePath = download.path && isInsideDirectory(downloadsDir, download.path)
      ? path.resolve(download.path)
      : undefined;
    const restored = {
      ...download,
      path: filePath,
      url: sanitizeResourceUrl(download.url),
    };
    if (restored.state !== "starting" && restored.state !== "progressing") return restored;
    return { ...restored, state: "interrupted" as const, updatedAt: interruptedAt };
  }).filter((download) => download.path !== undefined);
  state.downloads = [];
  for (const download of restoredDownloads) {
    if (!download.path || !await fs.access(download.path).then(() => true, () => false)) continue;
    state.downloads.push(download);
  }
  restoredTabs = persisted.tabs
    .map((tab) => ({ ...tab, url: safeUrlForPersistence(tab.url) || "" }))
    .filter((tab) => Boolean(tab.url))
    .slice(0, MAX_TABS);
  restoredActiveTabId = restoredTabs.some((tab) => tab.id === persisted.activeTabId)
    ? persisted.activeTabId
    : restoredTabs[0]?.id;
  state.assistance = persisted.assistance
    ? persisted.assistance.status === "waiting_user"
      ? {
          ...persisted.assistance,
          status: "cancelled",
          note: "应用上次退出时人工协助仍未完成",
          resolvedAt: interruptedAt,
        }
      : persisted.assistance
    : null;
  lastSafeUrl = safeUrlForPersistence(persisted.lastSafeUrl) || HOME_URL;
  state.url = lastSafeUrl;
  if (persisted.savedAt !== new Date(0).toISOString()) {
    state.storage.lastSavedAt = persisted.savedAt;
  }
  refreshStorageSummary();
}

async function createApplication(): Promise<void> {
  logRuntime("Creating desktop application");
  Menu.setApplicationMenu(null);
  app.setAppUserModelId(APP_ID);
  const libraryDir = path.join(app.getPath("userData"), "library");
  downloadsDir = path.join(libraryDir, "downloads");
  persistenceService = new PersistenceService(path.join(app.getPath("userData"), "state"));
  await persistenceService.initialize();
  browserSkillService = new BrowserSkillService(app.getPath("userData"));
  await browserSkillService.initialize();
  await refreshBrowserSkillState();
  logRuntime(`Browser skill library initialized with ${state.browserSkills.length} skill(s)`);
  const savedCredentialCount = await persistenceService.loadLoginCredentials();
  refreshCredentialVaultStatus();
  logRuntime(`Loaded ${savedCredentialCount} encrypted login credential site(s)`);
  await restoreRuntimeState();
  await fs.mkdir(downloadsDir, { recursive: true });
  documentService = new DocumentService(libraryDir);
  await documentService.initialize();
  logRuntime("Document library initialized");
  state.documents = documentService.list();
  await reconcileDownloadDirectory();
  refreshStorageSummary();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#f2f4f3",
    title: "Codex Browser",
    icon: brandingPath("icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  logRuntime("Main window created");
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("focus", () => mainWindow?.flashFrame(false));
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const targetSession = session.fromPartition(PROFILE_PARTITION, { cache: true });
  browserSession = targetSession;
  const restoreResult = await persistenceService.restoreSessionCookies(targetSession);
  const restoredCookies = await targetSession.cookies.get({});
  state.sessionHealth = {
    status: restoreResult.encryptionAvailable ? "unknown" : "unavailable",
    detail: !restoreResult.encryptionAvailable
      ? "系统加密不可用，当前只能依赖 Chromium 自身的持久 Cookie"
      : restoreResult.restored > 0
        ? `已恢复 ${restoreResult.restored} 个加密会话 Cookie${restoreResult.backupSource === "previous" ? "（来自上一代备份）" : ""}`
        : "加密会话保存已启用",
    checkedAt: new Date().toISOString(),
    cookieCount: restoredCookies.length,
    sessionCookieCount: restoredCookies.filter((cookie) => cookie.session).length,
    encryptedBackupAvailable: restoreResult.backupFound,
    lastRestoredAt: restoreResult.restoredAt,
  };
  targetSession.cookies.on("changed", () => {
    lastCookieChangeAt = Date.now();
    scheduleSessionCookieBackup();
  });
  scheduleSessionCookieBackup(0);
  cookieBackupInterval = setInterval(() => scheduleSessionCookieBackup(0), COOKIE_BACKUP_INTERVAL_MS);
  cookieBackupInterval.unref();
  registerDownloadListener(targetSession);
  targetSession.webRequest.onCompleted((details) => {
    if (details.resourceType === "mainFrame" && (details.statusCode === 401 || details.statusCode === 403)) {
      const tabId = [...browserTabs.values()].find((record) => record.view.webContents.id === details.webContentsId)?.id;
      if (!tabId) return;
      setAuthPrompt({
        id: randomUUID(),
        tabId,
        reason: "forbidden",
        title: "站点要求重新授权",
        detail: `访问返回 ${details.statusCode}，请检查高校登录状态。`,
        url: details.url,
        detectedAt: new Date().toISOString(),
      });
    }
  });

  const tabSpecs = restoredTabs.length > 0
    ? restoredTabs
    : [{ id: randomUUID(), title: "Codex Browser", url: lastSafeUrl, createdAt: new Date().toISOString() }];
  for (const tab of tabSpecs) {
    createBrowserTab(tab.url, false, {}, tab.id, tab.createdAt);
  }
  const initialTabId = restoredActiveTabId && browserTabs.has(restoredActiveTabId)
    ? restoredActiveTabId
    : browserTabs.keys().next().value as string | undefined;
  if (!initialTabId) throw new Error("Codex Browser could not create its initial tab.");
  activateBrowserTab(initialTabId, false);
  logRuntime(`Created ${browserTabs.size} browser tab(s)`);
  setupIpc();
  await startPipeServer();

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    await mainWindow.loadURL(devServer);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  logRuntime("Renderer loaded");
  updateNavigationState(initialTabId);
  createTray();
  logRuntime("Desktop application ready");
  broadcastState();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(createApplication).catch((error) => {
    logRuntime("Desktop application failed to start", error);
    dialog.showErrorBox("Codex Browser failed to start", (error as Error).stack || (error as Error).message);
    app.quit();
  });
}

app.on("activate", showWindow);
app.on("window-all-closed", () => {
  // The tray process remains alive so session cookies and MCP access stay available.
});
app.on("before-quit", (event) => {
  isQuitting = true;
  if (cookieBackupInterval) clearInterval(cookieBackupInterval);
  cookieBackupInterval = null;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  pipeServer?.close();
  void flushPersistentData().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
