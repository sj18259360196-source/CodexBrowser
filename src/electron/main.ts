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
  type IpcMainInvokeEvent,
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
  type AppState,
  type AssistanceKind,
  type AuthPrompt,
  type BrowserAction,
  type BrowserDialogPrompt,
  type BrowserObservation,
  type BrowserTabState,
  type BrowserTabSummary,
  type BrowserWaitCondition,
  type BrowserStorageSummary,
  type BrowserProfileStatus,
  type BrowserDataAction,
  type BrowserActionConfirmation,
  type BrowserRuntimeSettings,
  type DownloadItem,
  type HumanAssistance,
  type PipeRequest,
  type PipeResponse,
  type SessionHealth,
  type TaskItem,
  type TaskStatus,
} from "../shared/contracts";
import type { BrowserAdapter, BrowserResourceProbeResult } from "../browser/browser-adapter";
import {
  hasTargetAuthResolutionEvidence,
  type AuthResolutionBaseline,
} from "../browser/auth-evidence";
import {
  TabStateController,
  getHandleCommandMethodPolicy,
  type TabOperationGeneration,
} from "../browser/tab-state-policy";
import { detectChallenge, shouldFreezeForChallenge } from "../browser/challenge-detector";
import { BrowserDataConfirmationStore } from "../browser/data-confirmation";
import { ActionAuthorizationStore } from "../browser/action-authorization";
import { canRememberGrant, evaluatePolicy, type PolicyResult } from "../browser/policy-engine";
import { loadRuntimeSettings, resolveCodexBrowserProductRoot, updateRuntimeSettings } from "../browser/runtime-settings";
import { sanitizeError, sanitizeSensitiveText, sanitizeUrlForExposure as redactUrl } from "../security/redaction";
import { DocumentService } from "./document-service";
import { ElectronWebContentsViewAdapter } from "./electron-browser-adapter";
import { PersistenceService, type PersistedBrowserTab } from "./persistence-service";
import type { PersistedBlockedTab } from "./persistence-validation";

const pipeName = (process.env.CODEX_BROWSER_PIPE_NAME || "codex-browser-v1")
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^[.-]+|[.-]+$/g, "")
  .slice(0, 80) || "codex-browser-v1";
const PIPE_PATH = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
const PROFILE_ID = "primary";
const PROFILE_PARTITION = `persist:codex-browser-${PROFILE_ID}`;
const HOME_URL = process.env.CODEX_BROWSER_TEST_MODE === "1" ? "about:blank" : "https://www.crossref.org/";
const MAX_TABS = 8;
const MAX_TASKS = 80;
const MAX_DOWNLOADS = 80;
const STATE_SAVE_DELAY_MS = 300;
const COOKIE_SAVE_DELAY_MS = 800;
const userDataOverride = process.env.CODEX_BROWSER_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));
const runtimeLogDir = path.join(app.getPath("userData"), "logs");
const runtimeLogPath = path.join(runtimeLogDir, "main.log");

function namedError(name: string, message: string): Error { const error = new Error(message); error.name = name; return error; }

function logRuntime(message: string, error?: unknown): void {
  try {
    mkdirSync(runtimeLogDir, { recursive: true });
    const safeMessage = sanitizeSensitiveText(message) || "Runtime event";
    const safeError = error ? sanitizeError(error) : null;
    const detail = safeError ? `\n${safeError.name}: ${safeError.message}` : "";
    appendFileSync(runtimeLogPath, `[${new Date().toISOString()}] ${safeMessage}${detail}\n`, "utf8");
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
let browserAdapter: BrowserAdapter;
let downloadsDir = "";
let isQuitting = false;
let shutdownInProgress = false;
let shutdownComplete = false;
const pendingDownloads: Array<{ taskId: string; tabId: string; url: string; timeout: NodeJS.Timeout }> = [];
const cancelledPendingDownloads: Array<{ taskId: string; url: string; expiresAt: number }> = [];
const activeDownloadJobs = new Map<string, ElectronDownloadJob>();
const activeProbeControllers = new Set<AbortController>();
const dataConfirmations = new BrowserDataConfirmationStore();
const actionAuthorizations = new ActionAuthorizationStore();
const pendingConfirmedActions = new Map<string, { action: BrowserAction; taskId: string; policy: PolicyResult }>();
const downloadCandidates = new Map<string, {
  url: string;
  pageUrl: string;
  tabId: string;
  source: "link" | "loaded_pdf" | "visible_pdf";
}>();
const waitingAuthTasks = new Map<string, { tabId: string; completion: "done" | "retry" }>();
const authPrompts = new Map<string, AuthPrompt>();
const assistanceRequests = new Map<string, HumanAssistance>();
const assistanceEvidenceBaselines = new Map<string, string>();
const authPromptBaselines = new Map<string, AuthResolutionBaseline>();
const dialogEvidenceBaselines = new Map<string, string>();
const pendingDialogEvidenceByTab = new Map<string, string>();
const syntheticBeforeUnloadDialogIds = new Set<string>();
const nativeBeforeUnloadDialogTabs = new Set<string>();
type PendingBeforeUnloadAction =
  | { kind: "navigate"; url: string; generation: number }
  | { kind: "close"; generation: number }
  | { kind: "back" | "forward" | "reload"; generation: number }
  | { kind: "page_action"; action: BrowserAction; generation: number };
const pendingBeforeUnloadActions = new Map<string, PendingBeforeUnloadAction>();
const allowBeforeUnloadOnce = new Set<string>();
const pendingPageActions = new Map<string, { action: BrowserAction; generation: number }>();
const tabLoadGenerations = new Map<string, number>();
const mainFrameRequestGenerations = new Map<number, number>();
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
const tabStateController = new TabStateController();
const snapshotRevisions = new Map<string, number>();
const dialogTaskIds = new Map<string, string>();
let activeTabId = "";
let browserBounds = { x: 300, y: 100, width: 1100, height: 700 };
let restoredTabs: PersistedBrowserTab[] = [];
let restoredBlockedTabs: PersistedBlockedTab[] = [];
let restoredActiveTabId: string | undefined;
let lastSafeUrl = HOME_URL;
let stateSaveTimer: NodeJS.Timeout | null = null;
let cookieSaveTimer: NodeJS.Timeout | null = null;
let stateSaveChain = Promise.resolve();
let cookieSaveChain = Promise.resolve();
const tabCommandQueues = new Map<string, Promise<void>>();
const navigationQueues = new Map<string, Promise<void>>();
let brokerCommandQueue = Promise.resolve();
let operationGeneration = 0;
let isStopInProgress = false;
let lastAuthNotificationKey = "";
let lastAuthNotificationAt = 0;
const productRoot = resolveCodexBrowserProductRoot(process.env);
let runtimeSettings = loadRuntimeSettings(productRoot);

const state: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  browserState: "READY",
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
  storage: {
    taskCount: 0,
    downloadCount: 0,
    documentCount: 0,
  },
  browserStorage: {
    origin: "", cookieCount: 0, sessionCookieCount: 0,
    sessionRecoveryEnabled: false, sessionRecoveryAvailable: false,
    checkedAt: new Date(0).toISOString(),
  },
  profileStatus: {
    id: "electron-primary", label: "Electron legacy profile", state: "ready", persistent: true,
    browserManagedPasswords: true, syncEnabledByProject: false,
    detail: "Electron keeps its own persistent Chromium profile; Edge profile migration does not copy raw browser data.",
    checkedAt: new Date().toISOString(),
  },
  actionConfirmations: [],
  rememberedGrants: [],
  policyAudit: [],
  runtimeInfo: {
    kind: "electron-legacy",
    label: "Electron legacy runtime",
    connection: "ready",
    legacy: true,
    detail: "Legacy runtime is active for troubleshooting. It does not share the dedicated Edge profile.",
  },
  runtimeSettings: { ...runtimeSettings },
  tasks: [],
  downloads: [],
  documents: [],
};

function authPromptForTab(tabId: string): AuthPrompt | null {
  return authPrompts.get(tabId) || null;
}

function assistanceForTab(tabId: string): HumanAssistance | null {
  return assistanceRequests.get(tabId) || null;
}

function activeAssistanceForTab(tabId: string): HumanAssistance | null {
  const assistance = assistanceForTab(tabId);
  return assistance && (assistance.status === "waiting_user" || assistance.status === "verifying")
    ? assistance
    : null;
}

function tabHasActiveUserBoundary(tabId: string): boolean {
  return Boolean(authPromptForTab(tabId))
    || Boolean(activeAssistanceForTab(tabId))
    || state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.sensitive);
}

function releaseVerifiedTabBoundary(tabId: string): void {
  if (tabHasActiveUserBoundary(tabId)) {
    enterTabWaitingUser(tabId);
    return;
  }
  const current = getTabState(tabId);
  if (current === "WAITING_USER") transitionTabState(tabId, "VERIFYING");
  if (getTabState(tabId) === "VERIFYING") transitionTabState(tabId, "READY");
  else if (getTabState(tabId) === "ERROR") transitionTabState(tabId, "READY");
  else if (getTabState(tabId) !== "READY") transitionTabState(tabId, "READY");
}

function findAuthPromptById(promptId: string): AuthPrompt | null {
  return [...authPrompts.values()].find((prompt) => prompt.id === promptId) || null;
}

function findAssistanceById(assistanceId: string): HumanAssistance | null {
  return [...assistanceRequests.values()].find((assistance) => assistance.id === assistanceId) || null;
}

function syncActiveInterruptionState(): void {
  state.authPrompt = activeTabId ? authPromptForTab(activeTabId) : null;
  state.assistance = activeTabId ? assistanceForTab(activeTabId) : null;
}

function desktopState(): AppState {
  syncActiveInterruptionState();
  return {
    ...state,
    url: sanitizeUrlForExposure(state.url),
    title: sanitizeSensitiveText(state.title, 500) || "Browser page",
    currentAction: sanitizeSensitiveText(state.currentAction) || "Browser state updated",
    tasks: state.tasks.map((task) => ({ ...task, label: sanitizeSensitiveText(task.label, 300) || "Browser task", detail: sanitizeSensitiveText(task.detail) })),
    downloads: state.downloads.map(({ path: _path, ...download }) => ({ ...download, url: sanitizeUrlForExposure(download.url) })),
    documents: state.documents.map((document) => ({ ...document })),
    tabs: state.tabs.map((tab) => ({
      ...tab,
      title: ["WAITING_USER", "VERIFYING"].includes(tab.state) ? "Sensitive page" : sanitizeSensitiveText(tab.title, 300) || "Browser page",
      url: sanitizeUrlForExposure(tab.url),
    })),
    authPrompt: authPromptForExposure(state.authPrompt),
    assistance: assistanceForExposure(state.assistance),
    dialogs: dialogsForExposure(),
    sessionHealth: { ...state.sessionHealth },
    storage: { ...state.storage },
    actionConfirmations: actionAuthorizations.list(),
    rememberedGrants: actionAuthorizations.listGrants(),
    policyAudit: actionAuthorizations.auditEntries(),
  };
}

async function evaluateElectronActionPolicy(tabId: string, action: BrowserAction, taskId?: string, requestedCategory?: PolicyResult["category"], approvedConfirmation = false): Promise<{ policy: PolicyResult; origin: string }> {
  const context = await browserAdapter.getActionPolicyContext(tabId, action);
  const grants = actionAuthorizations.matchingGrants(PROFILE_ID, context.origin, tabId, taskId);
  const policy = evaluatePolicy({
    action: action.action, tabId, origin: context.origin, sanitizedUrl: context.sanitizedUrl,
    snapshotRevision: action.revision, element: context.element, form: context.form, page: context.page,
    targetOrigin: context.targetOrigin, tabState: getTabState(tabId), assistanceActive: Boolean(activeAssistanceForTab(tabId) || authPromptForTab(tabId)),
    grantCategories: grants.map((grant) => grant.category), requestedCategory, approvedConfirmation,
  });
  actionAuthorizations.recordEvaluation({ origin: context.origin, tabId, taskId }, policy);
  return { policy, origin: context.origin };
}

async function respondElectronActionConfirmation(id: string, response: "allow_once" | "allow_temporary" | "deny"): Promise<BrowserActionConfirmation> {
  actionAuthorizations.get(id);
  const pending = pendingConfirmedActions.get(id);
  if (!pending) throw namedError("CONFIRMATION_STALE", "The confirmed browser action is stale or unavailable.");
  if (response === "deny") {
    const denied = actionAuthorizations.deny(id); pendingConfirmedActions.delete(id);
    try { releaseVerifiedTabBoundary(denied.tabId); } catch {}
    updateTask(pending.taskId, "error", "用户拒绝了高风险操作"); broadcastState(); return denied;
  }
  if (response === "allow_temporary" && (!canRememberGrant(pending.policy.category) || !pending.policy.grantEligible)) {
    throw namedError("GRANT_NOT_ALLOWED", "This high-risk action cannot receive a temporary grant.");
  }
  actionAuthorizations.approve(id); const executing = actionAuthorizations.beginExecution(id);
  try { transitionTabState(executing.tabId, "VERIFYING"); } catch {}
  broadcastState(false);
  try {
    const current = await evaluateElectronActionPolicy(executing.tabId, pending.action, pending.taskId, executing.category, true);
    if (current.origin !== executing.origin || current.policy.decision !== "allow_redacted" || pending.action.revision !== executing.snapshotRevision || (!("ref" in pending.action) || pending.action.ref !== executing.targetRef)) {
      actionAuthorizations.finish(id, "failed", "Page context changed before execution");
      throw namedError("STALE_CONFIRMATION", "The page or target changed after confirmation. Capture a new snapshot and request confirmation again.");
    }
    const result = await browserAdapter.act(executing.tabId, pending.action);
    const completed = actionAuthorizations.finish(id, "completed", "Confirmed action executed once");
    pendingConfirmedActions.delete(id);
    if (response === "allow_temporary") {
      actionAuthorizations.createGrant({ profileId: PROFILE_ID, origin: executing.origin, category: executing.category, tabId: executing.tabId });
    }
    releaseVerifiedTabBoundary(executing.tabId); updateTask(pending.taskId, "done", result.description); finishRuntime("已确认的操作执行完成"); broadcastState(); return completed;
  } catch (error) {
    const current = actionAuthorizations.get(id);
    if (current.status === "executing") {
      const uncertain = !["STALE_SNAPSHOT", "REF_NOT_FOUND", "INVALID_ACTION", "STALE_CONFIRMATION"].includes((error as Error).name);
      actionAuthorizations.finish(id, uncertain ? "outcome_unknown" : "failed", uncertain ? "Execution outcome requires user review" : "Execution was rejected before a trusted action");
    }
    pendingConfirmedActions.delete(id); try { transitionTabState(executing.tabId, "ERROR"); } catch {}
    updateTask(pending.taskId, "error", ["STALE_SNAPSHOT", "REF_NOT_FOUND", "INVALID_ACTION", "STALE_CONFIRMATION"].includes((error as Error).name) ? "确认后页面发生变化，操作未执行" : "操作结果不确定，需要用户检查；系统不会自动重试"); broadcastState(); throw error;
  }
}

function sanitizeUrlForExposure(value: string): string {
  return redactUrl(value);
}

function sanitizeTextForExposure(value?: string): string | undefined {
  return sanitizeSensitiveText(value);
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
        note: undefined,
      }
    : null;
  snapshot.dialogs = snapshot.dialogs.map((dialog) => ({
    ...dialog,
    url: sanitizeUrlForExposure(dialog.url),
    defaultValue: undefined,
  }));
  snapshot.tasks = snapshot.tasks.map((task) => ({ ...task, detail: sanitizeTextForExposure(task.detail) }));
  snapshot.downloads = snapshot.downloads.map((download) => ({
    ...download,
    url: sanitizeUrlForExposure(download.url),
  }));
  return snapshot;
}

function authPromptForExposure(prompt: AuthPrompt | null): AuthPrompt | null {
  return prompt
    ? {
        ...prompt,
        title: sanitizeSensitiveText(prompt.title, 160) || "需要用户确认授权",
        detail: sanitizeSensitiveText(prompt.detail, 1_000) || "请在可见浏览器中完成当前授权步骤。",
        url: sanitizeUrlForExposure(prompt.url),
      }
    : null;
}

function assistanceForExposure(assistance: HumanAssistance | null): HumanAssistance | null {
  if (!assistance) return null;
  return {
    ...assistance,
    url: sanitizeUrlForExposure(assistance.url),
    title: sanitizeTextForExposure(assistance.title) || "需要你的协助",
    detail: sanitizeTextForExposure(assistance.detail) || assistance.detail,
    note: undefined,
  };
}

function dialogsForExposure(dialogs = state.dialogs): BrowserDialogPrompt[] {
  return dialogs.map((dialog) => ({
    ...dialog,
    url: sanitizeUrlForExposure(dialog.url),
    defaultValue: undefined,
  }));
}

function refreshStorageSummary(): void {
  state.storage.taskCount = state.tasks.length;
  state.storage.downloadCount = state.downloads.length;
  state.storage.documentCount = state.documents.length;
}

function safeUrlForPersistence(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
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
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function safePersistedTabTitle(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Browser page";
    return parsed.hostname.slice(0, 253) || "Browser page";
  } catch {
    return "Browser page";
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
  return sanitizeSensitiveText(value);
}

function tabAttention(tabId: string): BrowserTabSummary["attention"] {
  if (state.dialogs.some((dialog) => dialog.tabId === tabId)) return "dialog";
  if (activeAssistanceForTab(tabId)) return "assistance";
  if (authPromptForTab(tabId)) return "auth";
  return null;
}

function getTabState(tabId: string): BrowserTabSummary["state"] {
  return tabStateController.get(tabId).state;
}

function transitionTabState(tabId: string, nextState: BrowserTabSummary["state"]): void {
  tabStateController.transition(tabId, nextState);
}

function tabSummary(record: BrowserTabRecord): BrowserTabSummary {
  const info = browserAdapter.getTabInfo(record.id);
  const currentUrl = info.url || record.lastSafeUrl || HOME_URL;
  const safeUrl = safeUrlForPersistence(currentUrl);
  if (safeUrl) record.lastSafeUrl = safeUrl;
  return {
    id: record.id,
    title: ["WAITING_USER", "VERIFYING"].includes(getTabState(record.id))
      ? "Sensitive page"
      : info.title || "新标签页",
    url: currentUrl,
    state: getTabState(record.id),
    active: record.id === activeTabId,
    isLoading: info.isLoading,
    canGoBack: info.canGoBack,
    canGoForward: info.canGoForward,
    attention: tabAttention(record.id),
    createdAt: record.createdAt,
  };
}

function syncTabsState(): void {
  syncActiveInterruptionState();
  state.activeTabId = activeTabId;
  state.tabs = [...browserTabs.values()].map(tabSummary);
  state.browserState = state.runtimeStatus === "paused"
    ? "PAUSED_BY_USER"
    : activeTabId && browserTabs.has(activeTabId)
      ? getTabState(activeTabId)
      : "READY";
}

function persistedTabsPayload(): PersistedBrowserTab[] {
  return [...browserTabs.values()].map((record) => {
    const info = browserAdapter.getTabInfo(record.id);
    const currentUrl = info.url;
    const url = safeUrlForPersistence(currentUrl) || record.lastSafeUrl || HOME_URL;
    return {
      id: record.id,
      title: safePersistedTabTitle(url),
      url,
      createdAt: record.createdAt,
    };
  }).slice(0, MAX_TABS);
}

function persistedBlockedTabsPayload(): PersistedBlockedTab[] {
  const blocked: PersistedBlockedTab[] = [];
  for (const tabId of browserTabs.keys()) {
    const prompt = authPromptForTab(tabId);
    const assistance = activeAssistanceForTab(tabId);
    const dialogs = state.dialogs.filter((dialog) => dialog.tabId === tabId && dialog.sensitive);
    if (prompt) {
      blocked.push({
        tabId,
        kind: "auth",
        authReason: prompt.reason,
        requestedAt: prompt.detectedAt,
      });
    }
    if (assistance?.status === "waiting_user" || assistance?.status === "verifying") {
      blocked.push({
        tabId,
        kind: "assistance",
        requestedAt: assistance.requestedAt,
      });
    }
    for (const dialog of dialogs) {
      blocked.push({
        tabId,
        kind: "dialog",
        requestedAt: dialog.openedAt,
      });
    }
    if (
      ["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))
      && !prompt
      && !assistance
      && dialogs.length === 0
    ) {
      blocked.push({
        tabId,
        kind: "assistance",
        requestedAt: new Date().toISOString(),
      });
    }
  }
  return blocked.slice(0, MAX_TABS * 3);
}

function runtimeStatePayload() {
  return {
    lastSafeUrl,
    tabs: persistedTabsPayload(),
    activeTabId,
    blockedTabs: persistedBlockedTabsPayload(),
    assistance: null,
    tasks: state.tasks.map((task) => ({ ...task, detail: sanitizePersistedText(task.detail) })),
    downloads: state.downloads.map((download) => ({
      ...download,
      url: sanitizeUrlForExposure(download.url),
    })),
    ignoredDownloadFiles: [...ignoredDownloadFiles].sort(),
  };
}

async function persistRuntimeStateNow(): Promise<void> {
  if (!persistenceService || isQuitting) return;
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  stateSaveChain = stateSaveChain.then(async () => {
    if (!persistenceService) return;
    state.storage.lastSavedAt = await persistenceService.saveRuntimeState(runtimeStatePayload());
  });
  await stateSaveChain;
}

function persistUserBoundary(): void {
  void persistRuntimeStateNow().catch((error) => logRuntime("Failed to persist browser control boundary", error));
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
    const info = browserAdapter.getTabInfo(tabId);
    state.url = info.url || state.url;
    state.title = info.title || "Codex Browser";
    state.isLoading = info.isLoading;
    state.canGoBack = info.canGoBack;
    state.canGoForward = info.canGoForward;
    const safeUrl = safeUrlForPersistence(state.url);
    if (safeUrl) {
      lastSafeUrl = safeUrl;
      record.lastSafeUrl = safeUrl;
    }
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
  const initialState: BrowserTabState = restoredBlockedTabs.some((blocked) => blocked.tabId === id)
    ? "WAITING_USER"
    : "READY";
  tabStateController.register(id, initialState);
  mainWindow.contentView.addChildView(view);
  view.setBackgroundColor("#ffffff");
  view.setBounds(browserBounds);
  view.setVisible(false);
  setupBrowserEvents(record);
  setupDialogDebugger(record);
  if (activate || !activeTabId) activateBrowserTab(id);
  else broadcastState();
  if (target) {
    void browserAdapter.navigate(id, target).catch((error) => {
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
  tabStateController.remove(tabId);
  tabCommandQueues.delete(tabId);
  navigationQueues.delete(tabId);
  snapshotRevisions.delete(tabId);
  loadedPdfResponses.delete(tabId);
  for (const key of pendingPdfResponses.keys()) {
    if (key.startsWith(`${tabId}:`)) pendingPdfResponses.delete(key);
  }
  state.dialogs = state.dialogs.filter((dialog) => dialog.tabId !== tabId);
  pendingBeforeUnloadActions.delete(tabId);
  allowBeforeUnloadOnce.delete(tabId);
  nativeBeforeUnloadDialogTabs.delete(tabId);
  pendingPageActions.delete(tabId);
  tabLoadGenerations.delete(tabId);
  for (const dialogId of syntheticBeforeUnloadDialogIds) {
    if (!state.dialogs.some((dialog) => dialog.id === dialogId)) syntheticBeforeUnloadDialogIds.delete(dialogId);
  }
  for (const [dialogId] of dialogTaskIds) {
    if (!state.dialogs.some((dialog) => dialog.id === dialogId)) dialogTaskIds.delete(dialogId);
  }
  if (authPromptForTab(tabId)) cancelAuthPrompt(tabId, "授权页面已关闭");
  const assistance = assistanceForTab(tabId);
  if (assistance && (assistance.status === "waiting_user" || assistance.status === "verifying")) {
    assistanceEvidenceBaselines.delete(assistance.id);
    assistanceRequests.set(tabId, {
      ...assistance,
      status: "cancelled",
      note: "关联标签页已关闭",
      resolvedAt: new Date().toISOString(),
    });
    updateTask(assistance.taskId, "error", "关联标签页已关闭");
  }
  assistanceRequests.delete(tabId);
  authPromptBaselines.delete(tabId);
  if (mainWindow && !record.view.webContents.isDestroyed()) {
    mainWindow.contentView.removeChildView(record.view);
  }
}

async function closeBrowserTab(tabId: string, force = false): Promise<void> {
  const record = browserTabs.get(tabId);
  if (!record) throw new Error("Browser tab was not found.");
  const blocked = state.dialogs.some((dialog) => dialog.tabId === tabId)
    || Boolean(authPromptForTab(tabId))
    || ["waiting_user", "verifying"].includes(assistanceForTab(tabId)?.status || "");
  if (blocked && !force) throw new Error("Resolve the tab's pending dialog or human action before closing it, or pass force=true.");
  if (!force) {
    const generation = operationGeneration;
    pendingBeforeUnloadActions.set(tabId, { kind: "close", generation });
    const contents = record.view.webContents;
    let resolvePrevented: (() => void) | undefined;
    const prevented = new Promise<"prevented">((resolve) => {
      resolvePrevented = () => resolve("prevented");
    });
    const onPrevented = () => resolvePrevented?.();
    contents.once("will-prevent-unload", onPrevented);
    try {
      const outcome = await Promise.race([
        browserAdapter.navigate(tabId, "about:blank").then(() => "navigated" as const).catch((error) => {
          if (state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.type === "beforeunload")) return "prevented" as const;
          throw error;
        }),
        prevented,
      ]);
      assertOperationCurrent(generation);
      if (outcome === "prevented") return;
      await closeBrowserTab(tabId, true);
    } finally {
      contents.removeListener("will-prevent-unload", onPrevented);
    }
    return;
  }
  if (browserTabs.size === 1) createBrowserTab(HOME_URL, false);
  const remaining = [...browserTabs.keys()].filter((candidate) => candidate !== tabId);
  if (activeTabId === tabId && remaining[0]) activateBrowserTab(remaining[0]);
  removeBrowserTabRecord(tabId);
  if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false });
  broadcastState();
}

function createTask(label: string, detail?: string, status: TaskStatus = "running"): TaskItem {
  const now = new Date().toISOString();
  const task: TaskItem = {
    id: randomUUID(),
    label: sanitizeSensitiveText(label)?.slice(0, 300) || "Browser task",
    detail: sanitizeSensitiveText(detail),
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
    task.detail = sanitizeSensitiveText(detail);
  }
  broadcastState();
}

function setRuntime(status: AppState["runtimeStatus"], action: string): void {
  state.runtimeStatus = status;
  state.currentAction = sanitizeSensitiveText(action) || "Browser state updated";
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

function assertAutomationAllowed(tabId?: string, operation?: TabOperationGeneration): void {
  if (isStopInProgress) throw createTaskStoppedError();
  if (state.runtimeStatus === "paused") {
    const error = new Error("Codex browser control is paused by the user.");
    error.name = "PAUSED_BY_USER";
    throw error;
  }
  if (tabId) tabStateController.assertMutationAllowed(tabId, operation);
}

function beginTabOperation(tabId: string): void {
  const current = getTabState(tabId);
  if (current === "ERROR") transitionTabState(tabId, "READY");
  if (getTabState(tabId) === "READY" || getTabState(tabId) === "WAITING_PAGE") {
    transitionTabState(tabId, "RUNNING");
  }
}

function enterTabWaitingPage(tabId: string): void {
  const current = getTabState(tabId);
  if (current === "READY" || current === "RUNNING") transitionTabState(tabId, "WAITING_PAGE");
}

function enterTabWaitingUser(tabId: string): void {
  const current = getTabState(tabId);
  if (current === "ERROR") transitionTabState(tabId, "READY");
  const next = getTabState(tabId);
  if (next === "READY" || next === "RUNNING" || next === "WAITING_PAGE" || next === "VERIFYING") {
    transitionTabState(tabId, "WAITING_USER");
  }
}

function enterTabVerifying(tabId: string): void {
  if (getTabState(tabId) !== "WAITING_USER") {
    const error = new Error("The browser tab is not waiting for a user action.");
    error.name = "INVALID_TAB_STATE_TRANSITION";
    throw error;
  }
  transitionTabState(tabId, "VERIFYING");
}

function markTabReady(tabId: string): void {
  const current = getTabState(tabId);
  if (current === "READY") return;
  if (current === "WAITING_USER") return;
  if (current === "ERROR") {
    transitionTabState(tabId, "READY");
    return;
  }
  transitionTabState(tabId, "READY");
}

function markTabError(tabId: string): void {
  if (getTabState(tabId) !== "ERROR") transitionTabState(tabId, "ERROR");
}

function pauseCodexTabs(): void {
  for (const tabId of browserTabs.keys()) {
    if (["READY", "RUNNING", "WAITING_PAGE"].includes(getTabState(tabId))) {
      transitionTabState(tabId, "PAUSED_BY_USER");
    }
  }
}

function resumeCodexTabs(): void {
  for (const tabId of browserTabs.keys()) {
    if (getTabState(tabId) === "PAUSED_BY_USER") markTabReady(tabId);
  }
}

function restorePendingUserBoundaries(): void {
  for (const tabId of browserTabs.keys()) {
    const assistance = assistanceForTab(tabId);
    const needsUser = Boolean(authPromptForTab(tabId))
      || assistance?.status === "waiting_user"
      || assistance?.status === "verifying"
      || state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.sensitive);
    if (needsUser && getTabState(tabId) === "READY") enterTabWaitingUser(tabId);
  }
}

function createTaskStoppedError(): Error {
  const error = new Error("The browser task was stopped by the user.");
  error.name = "TASK_STOPPED";
  return error;
}

function assertOperationCurrent(generation: number): void {
  if (generation !== operationGeneration || isStopInProgress) throw createTaskStoppedError();
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

function setAuthPrompt(prompt: AuthPrompt, taskId?: string, completion: "done" | "retry" = "done"): void {
  prompt = {
    ...prompt,
    title: sanitizeSensitiveText(prompt.title, 160) || "需要用户确认授权",
    detail: sanitizeSensitiveText(prompt.detail, 1_000) || "请在可见浏览器中完成当前授权步骤。",
  };
  const previousPrompt = authPromptForTab(prompt.tabId);
  const promptKey = `${prompt.tabId}:${prompt.reason}:${safeUrlForPersistence(prompt.url) || prompt.url.split(/[?#]/, 1)[0]}`;
  const previousPromptKey = previousPrompt
    ? `${previousPrompt.tabId}:${previousPrompt.reason}:${safeUrlForPersistence(previousPrompt.url) || previousPrompt.url.split(/[?#]/, 1)[0]}`
    : "";
  const isRepeatedPrompt = previousPromptKey === promptKey;
  if (!isRepeatedPrompt) {
    const baseline: AuthResolutionBaseline = { url: prompt.url };
    authPromptBaselines.set(prompt.tabId, baseline);
    void captureAssistanceEvidence(prompt.tabId).then((pageEvidence) => {
      if (authPromptBaselines.get(prompt.tabId) === baseline) baseline.pageEvidence = pageEvidence;
    }).catch(() => undefined);
  }
  const notificationKey = promptKey;
  const now = Date.now();
  const shouldNotify = notificationKey !== lastAuthNotificationKey || now - lastAuthNotificationAt > 30_000;
  const nextPrompt = isRepeatedPrompt && previousPrompt
    ? { ...prompt, id: previousPrompt.id, detectedAt: previousPrompt.detectedAt }
    : prompt;
  authPrompts.set(prompt.tabId, nextPrompt);
  enterTabWaitingUser(prompt.tabId);
  state.sessionHealth.status = "attention";
  state.sessionHealth.detail = prompt.detail;
  state.sessionHealth.checkedAt = new Date().toISOString();
  if (taskId) {
    waitingAuthTasks.set(taskId, { tabId: prompt.tabId, completion });
    updateTask(taskId, "waiting_user", prompt.detail);
  }
  syncActiveInterruptionState();
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
  persistUserBoundary();
}

function failClosedAuthenticationCheck(
  tabId: string,
  taskId?: string,
  completion: "done" | "retry" = "done",
): AuthPrompt {
  const existing = authPromptForTab(tabId);
  const prompt: AuthPrompt = {
    id: existing?.id || randomUUID(),
    tabId,
    reason: existing?.reason || "stalled",
    title: "需要用户确认页面状态",
    detail: "暂时无法安全验证页面是否已完成授权。请确认页面稳定后再次检查；验证通过前不会恢复自动操作。",
    url: browserTabs.has(tabId) ? browserAdapter.getTabInfo(tabId).url : "",
    detectedAt: existing?.detectedAt || new Date().toISOString(),
  };
  setAuthPrompt(prompt, taskId, completion);
  return authPromptForTab(tabId) || prompt;
}

function clearAuthPrompt(tabId: string, markWaitingTasksDone = false): void {
  const prompt = authPromptForTab(tabId);
  authPrompts.delete(tabId);
  if (markWaitingTasksDone) {
    for (const [taskId, waiting] of waitingAuthTasks) {
      if (waiting.tabId !== tabId) continue;
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== "waiting_user") continue;
      task.status = waiting.completion === "retry" ? "queued" : "done";
      task.detail = waiting.completion === "retry"
        ? "授权已确认，请重新发起下载"
        : task.detail ? `${task.detail} · 授权已确认` : "授权已确认";
      task.updatedAt = new Date().toISOString();
    }
  }
  for (const [taskId, waiting] of waitingAuthTasks) {
    if (waiting.tabId === tabId) waitingAuthTasks.delete(taskId);
  }
  authPromptBaselines.delete(tabId);
  if (prompt && browserTabs.has(tabId)) {
    if (tabHasActiveUserBoundary(tabId)) enterTabWaitingUser(tabId);
    else if (getTabState(tabId) === "VERIFYING") releaseVerifiedTabBoundary(tabId);
  }
  syncActiveInterruptionState();
  if (tabId === activeTabId) mainWindow?.flashFrame(false);
  if (tabId === activeTabId && tabHasActiveUserBoundary(tabId)) {
    setRuntime("waiting_user", "授权已处理，仍在等待用户确认");
  } else if (tabId === activeTabId && state.runtimeStatus === "waiting_user") {
    setRuntime("idle", "授权已处理，等待任务");
  } else {
    broadcastState();
  }
  persistUserBoundary();
}

function cancelAuthPrompt(tabId: string, detail: string): void {
  const hadPrompt = authPrompts.delete(tabId);
  for (const [taskId, waiting] of waitingAuthTasks) {
    if (waiting.tabId !== tabId) continue;
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "waiting_user") continue;
    task.status = "error";
    task.detail = task.detail ? `${task.detail} · ${detail}` : detail;
    task.updatedAt = new Date().toISOString();
  }
  for (const [taskId, waiting] of waitingAuthTasks) {
    if (waiting.tabId === tabId) waitingAuthTasks.delete(taskId);
  }
  authPromptBaselines.delete(tabId);
  if (hadPrompt && browserTabs.has(tabId)) markTabError(tabId);
  if (browserTabs.has(tabId) && tabHasActiveUserBoundary(tabId)) enterTabWaitingUser(tabId);
  syncActiveInterruptionState();
  if (tabId === activeTabId) mainWindow?.flashFrame(false);
  if (tabId === activeTabId && tabHasActiveUserBoundary(tabId)) {
    setRuntime("waiting_user", "授权已取消，仍在等待其他用户步骤");
  } else if (tabId === activeTabId && state.runtimeStatus === "waiting_user") {
    setRuntime("idle", detail);
  } else {
    broadcastState();
  }
  persistUserBoundary();
}

async function hasAuthResolutionEvidence(tabId: string, currentUrl: string): Promise<boolean> {
  const currentPageEvidence = await captureAssistanceEvidence(tabId).catch(() => undefined);
  const baseline = authPromptBaselines.get(tabId);
  if (!baseline) {
    authPromptBaselines.set(tabId, { url: currentUrl, pageEvidence: currentPageEvidence });
    persistUserBoundary();
    return false;
  }
  const resolved = hasTargetAuthResolutionEvidence(baseline, currentUrl, currentPageEvidence);
  if (!baseline.pageEvidence && currentPageEvidence) {
    baseline.pageEvidence = currentPageEvidence;
  }
  return resolved;
}

async function updateSessionHealth(
  status: SessionHealth["status"],
  detail: string,
  checkedAt = new Date().toISOString(),
): Promise<SessionHealth> {
  detail = sanitizeSensitiveText(detail, 1_000) || "浏览器会话状态已更新";
  let summary = {
    cookieCount: state.sessionHealth.cookieCount,
    sessionCookieCount: state.sessionHealth.sessionCookieCount,
    encryptedBackupAvailable: state.sessionHealth.encryptedBackupAvailable,
  };
  try {
    summary = await browserAdapter.getSessionSummary();
  } catch {
    // Keep the health result useful even if Chromium is shutting down.
  }
  state.sessionHealth = {
    ...state.sessionHealth,
    status,
    detail,
    checkedAt,
    ...summary,
  };
  broadcastState();
  return { ...state.sessionHealth };
}

async function inspectForAuthentication(
  taskId?: string,
  tabId = activeTabId,
  allowResolution = false,
): Promise<AuthPrompt | null> {
  const inspectionGeneration = operationGeneration;
  const inspectionOperation = tabStateController.captureOperation(tabId);
  const assertInspectionCurrent = () => {
    assertOperationCurrent(inspectionGeneration);
    tabStateController.assertOperationCurrent(inspectionOperation);
  };
  assertInspectionCurrent();
  const tabInfo = browserAdapter.getTabInfo(tabId);
  const url = tabInfo.url;
  if (!url || url === "about:blank") {
    const existingPrompt = authPromptForTab(tabId);
    if (existingPrompt) {
      const unresolvedPrompt: AuthPrompt = {
        ...existingPrompt,
        detail: "目标标签页当前为空，无法验证授权是否完成。请返回目标页面并再次检查。",
        detectedAt: new Date().toISOString(),
      };
      setAuthPrompt(unresolvedPrompt, taskId);
      await updateSessionHealth("attention", unresolvedPrompt.detail);
      assertOperationCurrent(inspectionGeneration);
      return authPromptForTab(tabId) || unresolvedPrompt;
    }
    await updateSessionHealth("unknown", "当前页面为空，尚无法判断站点授权状态");
    assertInspectionCurrent();
    return null;
  }

  const [result, challengeEvidence] = await Promise.all([
    browserAdapter.inspectAuthentication(tabId),
    browserAdapter.collectChallengeEvidence(tabId).catch(() => null),
  ]);
  assertOperationCurrent(inspectionGeneration);
  const challenge = challengeEvidence ? detectChallenge(challengeEvidence) : null;
  const concurrentPrompt = authPromptForTab(tabId);
  if (concurrentPrompt && getTabState(tabId) === "WAITING_USER") return concurrentPrompt;
  tabStateController.assertOperationCurrent(inspectionOperation);

  const urlLooksLikeAuth = /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i.test(url);
  const authDetected = Boolean(challenge && shouldFreezeForChallenge(challenge)) || result.hasPassword
    || result.hasCaptcha
    || result.hasMfa
    || (urlLooksLikeAuth && result.hasLoginText)
    || (result.hasLoginText && result.hasLoginControl);
  if (!authDetected) {
    const existingPrompt = authPromptForTab(tabId);
    if (existingPrompt?.reason === "forbidden" && !allowResolution) {
      if (taskId) setAuthPrompt(existingPrompt, taskId);
      await updateSessionHealth("attention", existingPrompt.detail);
      assertOperationCurrent(inspectionGeneration);
      return existingPrompt;
    }
    if (existingPrompt?.reason === "stalled" && tabInfo.isLoading) {
      if (taskId) setAuthPrompt(existingPrompt, taskId);
      await updateSessionHealth("attention", existingPrompt.detail);
      assertOperationCurrent(inspectionGeneration);
      return existingPrompt;
    }
    if (existingPrompt) {
      const hasResolutionEvidence = allowResolution
        ? await hasAuthResolutionEvidence(tabId, url)
        : false;
      assertInspectionCurrent();
      if (!allowResolution || !hasResolutionEvidence) {
        const unresolvedPrompt: AuthPrompt = {
          ...existingPrompt,
          detail: allowResolution
            ? "登录表单已消失，但目标标签页尚未出现可验证的页面变化，请确认授权确实完成。"
            : "页面可能已完成授权。请由用户点击检查并继续，验证通过前 Codex 不会恢复该标签页。",
          detectedAt: new Date().toISOString(),
        };
        setAuthPrompt(unresolvedPrompt, taskId);
        await updateSessionHealth("attention", unresolvedPrompt.detail);
        assertOperationCurrent(inspectionGeneration);
        return unresolvedPrompt;
      }
      assertInspectionCurrent();
      clearAuthPrompt(tabId, true);
    }
    assertInspectionCurrent();
    if (["RUNNING", "WAITING_PAGE", "ERROR"].includes(getTabState(tabId))) markTabReady(tabId);
    await updateSessionHealth("healthy", "当前页面未检测到登录或授权阻断");
    assertOperationCurrent(inspectionGeneration);
    return null;
  }

  const reason: AuthPrompt["reason"] = challenge?.kind === "cloudflare" || challenge?.kind === "captcha" || result.hasCaptcha
    ? "captcha"
    : challenge?.kind === "mfa" || challenge?.kind === "otp" || challenge?.kind === "passkey" || result.hasMfa
      ? "mfa"
      : challenge?.kind === "blocked_access"
        ? "forbidden"
      : "login";
  const prompt: AuthPrompt = {
    id: authPromptForTab(tabId)?.id || randomUUID(),
    tabId,
    reason,
    title: reason === "captcha" ? "需要验证码" : reason === "mfa" ? "需要多因素验证" : "需要登录授权",
    detail: reason === "captcha"
      ? challenge?.kind === "cloudflare" ? "页面正在等待 Cloudflare 人工验证；Codex 不会点击或绕过该控件。" : "页面正在等待验证码，请在浏览器中完成。"
      : reason === "mfa"
        ? "页面正在等待多因素验证，请在浏览器中完成。"
        : "页面需要高校或站点登录，请完成授权后任务会自动继续。",
    url,
    detectedAt: new Date().toISOString(),
  };
  assertInspectionCurrent();
  setAuthPrompt(prompt, taskId);
  return prompt;
}

async function checkSessionHealth(tabId = activeTabId): Promise<SessionHealth> {
  tabId = resolveTabId(tabId);
  state.sessionHealth.status = "checking";
  state.sessionHealth.detail = "正在检查当前页面和本地会话";
  broadcastState(false);
  try {
    const existingPrompt = authPromptForTab(tabId);
    if (existingPrompt?.reason === "forbidden") {
      const probe = await browserAdapter.verifyProtectedResource(tabId, {
        url: existingPrompt.url,
        expectedPdf: existingPrompt.title.includes("论文下载"),
      });
      if (!probe.ok) {
        setAuthPrompt({
          ...existingPrompt,
          detail: probe.detail || existingPrompt.detail,
          detectedAt: new Date().toISOString(),
        });
        return { ...state.sessionHealth };
      }
      setAuthPrompt({
        ...existingPrompt,
        detail: "受保护资源已可访问。请由用户点击检查并继续，验证完成前该标签页仍保持暂停。",
        detectedAt: new Date().toISOString(),
      });
      return { ...state.sessionHealth };
    }
    const prompt = await inspectForAuthentication(undefined, tabId);
    if (prompt) return { ...state.sessionHealth };
    scheduleSessionCookieBackup();
    return { ...state.sessionHealth };
  } catch (error) {
    if ((error as Error).name === "TASK_STOPPED") throw error;
    const prompt = failClosedAuthenticationCheck(tabId);
    return updateSessionHealth("attention", prompt.detail);
  }
}

function currentOrigin(tabId = activeTabId): string {
  try {
    const value = browserAdapter.getTabInfo(tabId).url;
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch { return ""; }
}

async function electronStorageSummary(tabId = activeTabId): Promise<BrowserStorageSummary> {
  const targetSession = requireSession();
  const [cookies, cacheBytes, recovery] = await Promise.all([
    targetSession.cookies.get({}),
    targetSession.getCacheSize().catch(() => undefined),
    persistenceService?.getSessionRecoveryConfig(),
  ]);
  const summary: BrowserStorageSummary = {
    origin: currentOrigin(tabId), cookieCount: cookies.length,
    sessionCookieCount: cookies.filter((cookie) => cookie.session).length,
    cacheBytes, siteStorageBytes: undefined, permissionCount: undefined,
    sessionRecoveryEnabled: recovery?.enabled === true,
    sessionRecoveryAvailable: state.sessionHealth.encryptedBackupAvailable,
    checkedAt: new Date().toISOString(),
  };
  state.browserStorage = summary;
  return { ...summary };
}

async function clearElectronSiteData(tabId: string, includePermissions: boolean): Promise<BrowserStorageSummary> {
  const origin = currentOrigin(tabId);
  if (!origin) throw new Error("The current tab does not have a clearable website origin.");
  await requireSession().clearStorageData({
    origin,
    storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage", "shadercache"],
  });
  if (includePermissions) {
    // Electron does not expose per-origin permission deletion. The request policy remains deny-by-default.
  }
  await persistenceService?.clearSessionRecovery();
  state.sessionHealth.encryptedBackupAvailable = false;
  clearAuthPrompt(tabId);
  await browserAdapter.reload(tabId).catch(() => undefined);
  await checkSessionHealth(tabId).catch(() => undefined);
  return electronStorageSummary(tabId);
}

async function clearAllElectronData(): Promise<BrowserStorageSummary> {
  const targetSession = requireSession();
  await Promise.all([targetSession.clearStorageData(), targetSession.clearCache()]);
  await persistenceService?.clearSessionRecovery();
  state.sessionHealth.encryptedBackupAvailable = false;
  for (const tabId of browserTabs.keys()) clearAuthPrompt(tabId);
  return electronStorageSummary(activeTabId);
}

async function setElectronSessionRecovery(enabled: boolean): Promise<BrowserStorageSummary> {
  if (!persistenceService) throw new Error("Session recovery storage is unavailable.");
  const config = await persistenceService.setSessionRecoveryEnabled(enabled);
  if (config.enabled) scheduleSessionCookieBackup(0);
  else state.sessionHealth.encryptedBackupAvailable = false;
  return electronStorageSummary(activeTabId);
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
    return { ok: false, detail: "暂时无法安全验证受保护资源，请确认页面稳定后再次检查。" };
  } finally {
    clearTimeout(timeout);
    activeProbeControllers.delete(controller);
  }
}

async function completeAuthentication(promptId?: string, requestedTabId?: string): Promise<SessionHealth> {
  const generation = operationGeneration;
  const promptById = promptId ? findAuthPromptById(promptId) : null;
  if (promptId && !promptById) throw new Error("The authorization prompt is stale.");
  const requested = requestedTabId ? resolveTabId(requestedTabId) : undefined;
  if (requested && promptById && requested !== promptById.tabId) {
    throw new Error("The authorization prompt does not belong to the requested browser tab.");
  }
  const tabId = requested || promptById?.tabId || activeTabId;
  const previousPrompt = authPromptForTab(tabId);
  if (promptId && previousPrompt?.id !== promptId) throw new Error("The authorization prompt is stale.");
  if (previousPrompt) {
    enterTabVerifying(tabId);
    setRuntime("running", "正在验证用户操作");
    if (previousPrompt.reason === "forbidden") {
      const probe = await browserAdapter.verifyProtectedResource(tabId, {
        url: previousPrompt.url,
        expectedPdf: previousPrompt.title.includes("论文下载"),
      });
      assertOperationCurrent(generation);
      if (!probe.ok) {
        setAuthPrompt({
          ...previousPrompt,
          detail: probe.detail || previousPrompt.detail,
          detectedAt: new Date().toISOString(),
        });
        return { ...state.sessionHealth };
      }
    }
  }
  let prompt: AuthPrompt | null;
  try {
    prompt = await inspectForAuthentication(undefined, tabId, true);
    assertOperationCurrent(generation);
  } catch (error) {
    if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") throw createTaskStoppedError();
    prompt = failClosedAuthenticationCheck(tabId);
    await updateSessionHealth("attention", prompt.detail);
  }
  if (prompt) {
    return { ...state.sessionHealth };
  }
  clearAuthPrompt(tabId, true);
  if (activeAssistanceForTab(tabId)) {
    setRuntime("waiting_user", "授权已确认，仍在等待人工协助验证");
  } else {
    releaseVerifiedTabBoundary(tabId);
    finishRuntime("授权已确认，等待任务");
  }
  failedDownloadRequests.clear();
  scheduleSessionCookieBackup(0);
  const health = await updateSessionHealth("healthy", "授权已确认，会话已加密保存");
  await persistRuntimeStateNow();
  return health;
}

async function navigateTo(
  value: string,
  label = "打开网页",
  allowWhilePaused = false,
  requestedTabId = activeTabId,
): Promise<{ url: string; authPrompt: AuthPrompt | null }> {
  const tabId = resolveTabId(requestedTabId);
  if (!allowWhilePaused) {
    assertAutomationAllowed(tabId);
    beginTabOperation(tabId);
  } else if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))) {
    beginTabOperation(tabId);
  }
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
  const target = normalizeTarget(value);
  const generation = operationGeneration;
  const exposedTarget = sanitizeUrlForExposure(target) || "受保护页面";
  const task = createTask(label, exposedTarget, "running");
  if (authPromptForTab(tabId)) {
    cancelAuthPrompt(tabId, "已由新的导航任务取代");
    if (!allowWhilePaused) beginTabOperation(tabId);
  }
  const tabOperation = allowWhilePaused ? undefined : tabStateController.captureOperation(tabId);
  setRuntime("running", `${label}：${exposedTarget}`);

  if (browserAdapter.getTabInfo(tabId).isLoading) {
    await browserAdapter.stop(tabId);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }

  let stalled = false;
  let timeout: NodeJS.Timeout | undefined;
  pendingBeforeUnloadActions.set(tabId, { kind: "navigate", url: target, generation });
  try {
    await Promise.race([
      browserAdapter.navigate(tabId, target),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          stalled = true;
          reject(new Error("PAGE_LOAD_TIMEOUT"));
        }, 15_000);
      }),
    ]);
  } catch (error) {
    if (generation !== operationGeneration) {
      updateTask(task.id, "error", "页面导航已由用户停止");
      throw createTaskStoppedError();
    }
    if (state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.type === "beforeunload")) {
      updateTask(task.id, "done", "页面阻止离开，等待处理网页对话框");
      return { url: browserAdapter.getTabInfo(tabId).url, authPrompt: null };
    }
    pendingBeforeUnloadActions.delete(tabId);
    if (!stalled) {
      updateTask(task.id, "error", (error as Error).message);
      markTabError(tabId);
      setRuntime("error", "页面加载失败");
      throw error;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assertOperationCurrent(generation);
  if (state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.type === "beforeunload")) {
    updateTask(task.id, "done", "页面阻止离开，等待处理网页对话框");
    return { url: browserAdapter.getTabInfo(tabId).url, authPrompt: null };
  }
  pendingBeforeUnloadActions.delete(tabId);
  updateNavigationState();
  if (stalled) {
    const prompt: AuthPrompt = {
      id: randomUUID(),
      tabId,
      reason: "stalled",
      title: "页面长时间没有进展",
      detail: "页面加载超过 15 秒，请检查是否需要登录、验证码或手工操作。",
      url: browserAdapter.getTabInfo(tabId).url || target,
      detectedAt: new Date().toISOString(),
    };
    setAuthPrompt(prompt, task.id);
    return { url: prompt.url, authPrompt: prompt };
  }

  let authPrompt: AuthPrompt | null;
  try {
    authPrompt = await inspectForAuthentication(task.id, tabId);
    assertOperationCurrent(generation);
  } catch (error) {
    if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") {
      updateTask(task.id, "error", "页面导航已停止或转入用户控制");
      throw createTaskStoppedError();
    }
    authPrompt = failClosedAuthenticationCheck(tabId, task.id);
  }
  if (!authPrompt) {
    try {
      if (tabOperation) tabStateController.assertOperationCurrent(tabOperation);
    } catch (error) {
      updateTask(task.id, "error", "页面导航已停止或转入用户控制");
      throw error;
    }
    markTabReady(tabId);
    updateTask(task.id, "done", browserAdapter.getTabInfo(tabId).title || exposedTarget);
    finishRuntime("页面已就绪");
  }
  return { url: browserAdapter.getTabInfo(tabId).url, authPrompt };
}

function enqueueNavigation(
  value: string,
  label = "打开网页",
  allowWhilePaused = false,
  tabId = activeTabId,
): Promise<{ url: string; authPrompt: AuthPrompt | null }> {
  const queuedGeneration = operationGeneration;
  const resolvedTabId = resolveTabId(tabId);
  const queuedTabOperation = allowWhilePaused ? undefined : tabStateController.captureOperation(resolvedTabId);
  const run = async () => {
    assertOperationCurrent(queuedGeneration);
    if (queuedTabOperation) {
      tabStateController.assertOperationCurrent(queuedTabOperation);
      assertAutomationAllowed(resolvedTabId, queuedTabOperation);
    }
    return navigateTo(value, label, allowWhilePaused, resolvedTabId);
  };
  const queue = navigationQueues.get(resolvedTabId) || Promise.resolve();
  const result = queue.then(run, run);
  navigationQueues.set(resolvedTabId, result.then(() => undefined, () => undefined));
  return result;
}

async function observePage(maxCharacters = 30_000, requestedTabId = activeTabId): Promise<BrowserObservation> {
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
  const safeLimit = Math.min(Math.max(Math.floor(maxCharacters), 1_000), 100_000);
  const observation = await browserAdapter.observe(tabId, { maxCharacters: safeLimit });

  const exposedObservation: BrowserObservation = {
    ...observation,
    title: sanitizeSensitiveText(observation.title) || "Browser page",
    text: sanitizeSensitiveText(observation.text, safeLimit) || "",
    tabId,
    url: sanitizeUrlForExposure(observation.url),
    links: observation.links.map((link) => ({ ...link, href: sanitizeUrlForExposure(link.href) })),
    forms: observation.forms.map((form) => ({ ...form, action: sanitizeUrlForExposure(form.action) })),
  };
  createTask("读取页面结构", `${exposedObservation.title} · ${exposedObservation.text.length} 字符`, "done");
  return exposedObservation;
}

function downloadRequestKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function loadedPdfForTab(tabId: string): LoadedPdfResponse | undefined {
  const loaded = loadedPdfResponses.get(tabId);
  const currentUrl = browserTabs.has(tabId) ? browserAdapter.getTabInfo(tabId).url : "";
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
  if (!browserTabs.has(tabId)) return false;
  const info = browserAdapter.getTabInfo(tabId);
  const summary = state.tabs.find((tab) => tab.id === tabId);
  const activeValues = tabId === activeTabId ? [state.url, state.title] : [];
  return [info.url, info.title, summary?.url || "", summary?.title || "", ...activeValues]
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
  const data = Buffer.from(await browserAdapter.printToPdf(tabId));
  if (data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Chromium could not export the visible PDF.");
  }
  const currentUrl = browserAdapter.getTabInfo(tabId).url;
  const loaded: LoadedPdfResponse = {
    tabId,
    url: currentUrl,
    fileName: "document.pdf",
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
  const savePath = uniqueDownloadPath(".pdf");
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
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
  const pageUrl = browserAdapter.getTabInfo(tabId).url;
  let rawCandidates: Array<{ text: string; url: string }> = [];
  try {
    rawCandidates = await browserAdapter.findDownloadLinks(tabId);
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
      url: sanitizeUrlForExposure(loaded.url),
      source: "loaded_pdf",
    });
  } else if (tabLooksLikePdf(tabId)) {
    const id = `cb-download-${randomUUID()}`;
    downloadCandidates.set(id, { url: pageUrl, pageUrl, tabId, source: "visible_pdf" });
    results.push({
      id,
      text: "当前可见 PDF（将从 Chromium 阅读器导出）",
      url: sanitizeUrlForExposure(pageUrl),
      source: "visible_pdf",
    });
  }
  for (const candidate of rawCandidates) {
    const id = `cb-download-${randomUUID()}`;
    downloadCandidates.set(id, { url: candidate.url, pageUrl, tabId, source: "link" });
    results.push({ id, text: candidate.text, url: sanitizeUrlForExposure(candidate.url), source: "link" });
  }
  return results;
}

async function startDownload(
  url?: string,
  candidateId?: string,
  requestedTabId = activeTabId,
): Promise<{ jobId: string; url: string; tabId: string }> {
  const tabId = resolveTabId(requestedTabId);
  assertAutomationAllowed(tabId);
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
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
    if (candidate.pageUrl !== browserAdapter.getTabInfo(tabId).url) {
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

function uniqueDownloadPath(extension: ".pdf" | ".bin"): string {
  return path.join(downloadsDir, `download-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`);
}

function isGeneratedDownloadName(fileName: string): boolean {
  return /^download-\d{13}-[a-f0-9]{8}\.(?:pdf|bin)$/i.test(fileName);
}

async function migrateDownloadPath(filePath: string): Promise<string> {
  if (isGeneratedDownloadName(path.basename(filePath))) return filePath;
  const extension = await readFileSignature(filePath).catch(() => "") === "%PDF-" ? ".pdf" : ".bin";
  const safePath = uniqueDownloadPath(extension);
  await fs.rename(filePath, safePath);
  return safePath;
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
    let filePath = path.join(downloadsDir, entry.name);
    if (!isGeneratedDownloadName(entry.name)) {
      filePath = await migrateDownloadPath(filePath).catch(() => "");
      if (!filePath) continue;
    }
    const fileName = path.basename(filePath);
    if (ignoredDownloadFiles.has(fileName)) continue;
    if (!knownPaths.has(path.resolve(filePath).toLowerCase())) {
      const stat = await fs.stat(filePath);
      const timestamp = (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
      state.downloads.push({
        id: randomUUID(),
        fileName,
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
      await documentService.importPdf(filePath).catch((error) => logRuntime("Failed to reconcile a downloaded PDF", error));
    }
  }
  state.downloads = state.downloads
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_DOWNLOADS);
  state.documents = documentService.list();
}

function registerDownloadListener(targetSession: Session): void {
  targetSession.on("will-download", (_event, item, sourceContents) => {
    if (isStopInProgress) {
      item.cancel();
      return;
    }
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
    const isCurrentDownload = () => generation === operationGeneration && !isStopInProgress;
    activeDownloadJobs.set(id, item);
    const savePath = uniqueDownloadPath(item.getMimeType().toLowerCase() === "application/pdf" ? ".pdf" : ".bin");
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
      if (!isCurrentDownload()) return;
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = status;
      download.updatedAt = new Date().toISOString();
      setRuntime("downloading", `正在下载 ${download.fileName}`);
      broadcastState();
    });

    item.once("done", async (_doneEvent, status) => {
      activeDownloadJobs.delete(id);
      if (!isCurrentDownload()) return;
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = status;
      download.updatedAt = new Date().toISOString();
      broadcastState();

      if (status !== "completed") {
        updateTask(id, "error", `${download.fileName} · ${status}`);
        setRuntime("error", "下载未完成");
        return;
      }

      const header = await readFileSignature(savePath).catch(() => "");
      if (!isCurrentDownload()) return;
      const isPdf = header === "%PDF-";
      const expectedPdf = item.getMimeType().toLowerCase().includes("pdf")
        || /\.pdf(?:$|[?#])/i.test(item.getURL())
        || download.fileName.toLowerCase().endsWith(".pdf");

      if (!isPdf) {
        if (expectedPdf || item.getMimeType().toLowerCase().includes("html")) {
          download.state = "interrupted";
          download.updatedAt = new Date().toISOString();
          await fs.unlink(savePath).catch(() => undefined);
          if (!isCurrentDownload()) return;
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
              if (!isCurrentDownload() || (error as Error).name === "TASK_STOPPED") return;
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
        if (!isCurrentDownload()) return;
        state.documents = documentService.list();
        updateTask(id, "done", `${document.pages} 页 · ${document.characters} 字符`);
        finishRuntime("PDF 已进入文献库");
      } catch (error) {
        if (!isCurrentDownload()) return;
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

async function captureAssistanceEvidence(tabId: string): Promise<string> {
  const info = await browserAdapter.refreshTabInfo(tabId);
  const observation = await browserAdapter.observe(tabId, { maxCharacters: 24_000 });
  const payload = {
    url: sanitizeResourceUrl(info.url || observation.url),
    title: info.title || observation.title || "Browser page",
    text: observation.text,
    links: observation.links.map((link) => ({
      text: link.text,
      href: sanitizeResourceUrl(link.href),
    })),
    forms: observation.forms.map((form) => ({
      action: sanitizeResourceUrl(form.action),
      method: form.method,
      hasPassword: form.hasPassword,
    })),
    authRequired: observation.authRequired,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function requestHumanAssistance({
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
}): Promise<HumanAssistance> {
  const generation = operationGeneration;
  const tabId = resolveTabId(requestedTabId);
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
  assertOperationCurrent(generation);
  const baseline = await captureAssistanceEvidence(tabId).catch(() => undefined);
  assertOperationCurrent(generation);
  const existingAssistance = assistanceForTab(tabId);
  if (existingAssistance?.status === "waiting_user") {
    assistanceEvidenceBaselines.delete(existingAssistance.id);
    const previous = state.tasks.find((task) => task.id === existingAssistance.taskId);
    if (previous) updateTask(previous.id, "error", "已由新的人工协助请求取代");
  }
  const normalizedTitle = sanitizeSensitiveText(title, 120)?.trim() || "需要你的协助";
  const normalizedDetail = sanitizeSensitiveText(detail, 2_000)?.trim() || "请在可见浏览器中完成当前步骤。";
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
    url: browserAdapter.getTabInfo(tabId).url,
    status: "waiting_user",
    requestedAt: new Date().toISOString(),
  };
  if (baseline) assistanceEvidenceBaselines.set(assistance.id, baseline);
  assistanceRequests.set(tabId, assistance);
  syncActiveInterruptionState();
  enterTabWaitingUser(tabId);
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
  await persistRuntimeStateNow();
  return { ...assistance };
}

async function completeHumanAssistance(
  assistanceId: string,
  outcome: "completed" | "unable",
): Promise<HumanAssistance> {
  const generation = operationGeneration;
  const assistance = findAssistanceById(assistanceId);
  if (!assistance) throw new Error("The assistance request is stale or missing.");
  if (assistance.status !== "waiting_user") return { ...assistance };
  if (assistance.tabId !== activeTabId) await browserAdapter.selectTab(assistance.tabId);
  assertOperationCurrent(generation);

  if (outcome === "completed") {
    enterTabVerifying(assistance.tabId);
    assistance.status = "verifying";
    setRuntime("running", "正在验证用户完成的手工步骤");
    let prompt: AuthPrompt | null;
    try {
      prompt = await inspectForAuthentication(assistance.taskId, assistance.tabId, true);
      assertOperationCurrent(generation);
    } catch (error) {
      if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") throw createTaskStoppedError();
      prompt = failClosedAuthenticationCheck(assistance.tabId, assistance.taskId);
      assistance.status = "waiting_user";
      assistance.detail = "暂时无法验证页面状态，请确认页面稳定后再次检查。";
      enterTabWaitingUser(assistance.tabId);
      broadcastState();
      await persistRuntimeStateNow();
      return { ...assistance };
    }
    if (prompt) {
      assistance.status = "waiting_user";
      assistance.detail = "页面仍显示登录、密码或验证步骤，请完成后再交还控制。";
      broadcastState();
      await persistRuntimeStateNow();
      return { ...assistance };
    }
    if (state.dialogs.some((dialog) => dialog.tabId === assistance.tabId && dialog.sensitive)) {
      assistance.status = "waiting_user";
      assistance.detail = "页面仍有敏感对话框，请处理后再次检查。";
      enterTabWaitingUser(assistance.tabId);
      broadcastState();
      await persistRuntimeStateNow();
      return { ...assistance };
    }
    const baseline = assistanceEvidenceBaselines.get(assistance.id);
    const currentEvidence = await captureAssistanceEvidence(assistance.tabId).catch(() => undefined);
    assertOperationCurrent(generation);
    if (!baseline || !currentEvidence || baseline === currentEvidence) {
      if (!baseline && currentEvidence) assistanceEvidenceBaselines.set(assistance.id, currentEvidence);
      assistance.status = "waiting_user";
      assistance.detail = !baseline || !currentEvidence
        ? "暂时无法取得可验证的页面状态，请确认页面稳定后再次检查。"
        : "页面状态尚未发生可验证的变化，请完成手工步骤后再次检查。";
      enterTabWaitingUser(assistance.tabId);
      broadcastState();
      await persistRuntimeStateNow();
      return { ...assistance };
    }
  } else {
    markTabError(assistance.tabId);
  }

  assistance.status = outcome;
  delete assistance.note;
  assistance.resolvedAt = new Date().toISOString();
  assistanceEvidenceBaselines.delete(assistance.id);
  updateTask(
    assistance.taskId,
    outcome === "completed" ? "done" : "error",
    outcome === "completed" ? "用户已完成手工步骤" : "用户暂时无法完成手工步骤",
  );
  mainWindow?.flashFrame(false);
  if (outcome === "completed") releaseVerifiedTabBoundary(assistance.tabId);
  syncActiveInterruptionState();
  if (tabHasActiveUserBoundary(assistance.tabId)) {
    setRuntime("waiting_user", "人工步骤已处理，仍在等待其他用户确认");
  } else {
    finishRuntime(outcome === "completed" ? "用户已交还浏览器控制" : "用户未能完成手工步骤");
  }
  await persistRuntimeStateNow();
  return { ...assistance };
}

function isSensitiveDialog(message: string, defaultValue?: string): boolean {
  return /password|passcode|passwd|passkey|webauthn|\botp\b|one.?time|\bmfa\b|\b2fa\b|captcha|\bpin\b|verification.?code|security.?code|access.?code|验证码|动态口令|\bsecret\b|\btoken\b|credential/i.test(`${message} ${defaultValue || ""}`);
}

function handleDialogOpened(tabId: string, params: Record<string, unknown>): BrowserDialogPrompt | undefined {
  if (isStopInProgress) {
    void browserAdapter.dismissDialogs(tabId).catch(() => undefined);
    return undefined;
  }
  const type = String(params.type || "alert") as BrowserDialogPrompt["type"];
  if (!["alert", "confirm", "prompt", "beforeunload"].includes(type)) return undefined;
  const rawMessage = String(params.message || "").slice(0, 4_000);
  const rawDefaultValue = params.defaultPrompt == null ? undefined : String(params.defaultPrompt).slice(0, 2_000);
  const sensitive = type === "prompt" || isSensitiveDialog(rawMessage, rawDefaultValue);
  const message = sensitive
    ? "Sensitive dialog content redacted. Complete this dialog in the visible browser."
    : "Browser dialog content hidden. Review it in the visible browser.";
  const existing = state.dialogs.find((candidate) => candidate.tabId === tabId);
  const dialog: BrowserDialogPrompt = {
    id: existing?.type === type && existing.message === message ? existing.id : randomUUID(),
    tabId,
    type,
    message,
    defaultValue: undefined,
    url: String(params.url || (browserTabs.has(tabId) ? browserAdapter.getTabInfo(tabId).url : "")),
    sensitive,
    openedAt: existing?.type === type && existing.message === message ? existing.openedAt : new Date().toISOString(),
  };
  state.dialogs = [dialog, ...state.dialogs.filter((candidate) => candidate.tabId !== tabId)];
  const preDialogEvidence = pendingDialogEvidenceByTab.get(tabId);
  pendingDialogEvidenceByTab.delete(tabId);
  if (dialog.sensitive && preDialogEvidence) dialogEvidenceBaselines.set(dialog.id, preDialogEvidence);
  if (existing?.id === dialog.id) {
    broadcastState();
    return dialog;
  }
  const task = createTask("处理网页对话框", `${type} · ${message.slice(0, 240)}`, dialog.sensitive ? "waiting_user" : "running");
  dialogTaskIds.set(dialog.id, task.id);
  if (dialog.sensitive) enterTabWaitingUser(tabId);
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
  persistUserBoundary();
  return dialog;
}

async function ensureDialogVerificationBoundary(tabId: string): Promise<void> {
  if (isStopInProgress || !browserTabs.has(tabId)) return;
  const generation = operationGeneration;
  const existing = assistanceForTab(tabId);
  if (!existing || (existing.status !== "waiting_user" && existing.status !== "verifying")) {
    const title = "需要重新确认手工步骤";
    const detail = "暂时无法验证页面状态，请确认页面稳定并产生可验证变化后再次检查。";
    const task = createTask(title, detail, "waiting_user");
    const assistance: HumanAssistance = {
      id: randomUUID(),
      tabId,
      taskId: task.id,
      kind: "manual_action",
      title,
      detail,
      url: browserAdapter.getTabInfo(tabId).url,
      status: "waiting_user",
      requestedAt: new Date().toISOString(),
    };
    const baseline = await captureAssistanceEvidence(tabId).catch(() => undefined);
    if (generation !== operationGeneration || isStopInProgress) return;
    if (baseline) assistanceEvidenceBaselines.set(assistance.id, baseline);
    assistanceRequests.set(tabId, assistance);
  } else {
    existing.status = "waiting_user";
    existing.detail = "暂时无法验证页面状态，请确认页面稳定并产生可验证变化后再次检查。";
  }
  enterTabWaitingUser(tabId);
  if (tabId === activeTabId) setRuntime("waiting_user", "等待你重新确认手工步骤");
  else broadcastState();
  await persistRuntimeStateNow();
}

async function handleDialogClosed(tabId: string, accepted?: boolean): Promise<void> {
  if (isStopInProgress) return;
  const generation = operationGeneration;
  const closed = state.dialogs.filter((dialog) => dialog.tabId === tabId);
  if (closed.length === 0) return;
  const closedSensitiveDialog = closed.some((dialog) => dialog.sensitive);
  const baseline = closed
    .map((dialog) => dialogEvidenceBaselines.get(dialog.id))
    .find((value): value is string => Boolean(value));
  const closedTaskIds = closed
    .map((dialog) => dialogTaskIds.get(dialog.id))
    .filter((taskId): taskId is string => Boolean(taskId));
  const supersedeClosedDialogTasks = () => {
    for (const taskId of closedTaskIds) {
      updateTask(taskId, "error", "敏感网页对话框尚未通过验证，已转入后续用户确认");
    }
  };
  state.dialogs = state.dialogs.filter((dialog) => dialog.tabId !== tabId);
  for (const dialog of closed) {
    const taskId = dialogTaskIds.get(dialog.id);
    if (taskId) updateTask(taskId, dialog.sensitive ? "waiting_user" : "done", dialog.sensitive ? "正在验证用户处理的敏感对话框" : "网页对话框已关闭");
    dialogTaskIds.delete(dialog.id);
    dialogEvidenceBaselines.delete(dialog.id);
  }
  if (closedSensitiveDialog && browserTabs.has(tabId)) {
    if (accepted !== true) {
      supersedeClosedDialogTasks();
      await ensureDialogVerificationBoundary(tabId);
      return;
    }
    try {
      if (getTabState(tabId) === "WAITING_USER") enterTabVerifying(tabId);
      if (getTabState(tabId) !== "VERIFYING") throw new Error("DIALOG_VERIFICATION_STATE");
      if (tabId === activeTabId) setRuntime("running", "正在验证用户处理的网页对话框");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assertOperationCurrent(generation);
      if (state.dialogs.some((dialog) => dialog.tabId === tabId && dialog.sensitive)) {
        supersedeClosedDialogTasks();
        enterTabWaitingUser(tabId);
        await persistRuntimeStateNow();
        return;
      }
      const prompt = await inspectForAuthentication(undefined, tabId, true);
      assertOperationCurrent(generation);
      if (prompt) {
        supersedeClosedDialogTasks();
        await persistRuntimeStateNow();
        return;
      }
      const currentEvidence = await captureAssistanceEvidence(tabId).catch(() => undefined);
      assertOperationCurrent(generation);
      if (!baseline || !currentEvidence || baseline === currentEvidence) {
        supersedeClosedDialogTasks();
        await ensureDialogVerificationBoundary(tabId);
        return;
      }
      if (activeAssistanceForTab(tabId)) {
        supersedeClosedDialogTasks();
        enterTabWaitingUser(tabId);
        await persistRuntimeStateNow();
        return;
      }
      releaseVerifiedTabBoundary(tabId);
      for (const taskId of closedTaskIds) updateTask(taskId, "done", "敏感网页对话框已由用户处理并通过页面检查");
      mainWindow?.flashFrame(false);
      if (tabId === activeTabId) finishRuntime("网页对话框已验证");
      else broadcastState();
      await persistRuntimeStateNow();
      return;
    } catch (error) {
      if (generation !== operationGeneration || isStopInProgress || (error as Error).name === "TASK_STOPPED") return;
      supersedeClosedDialogTasks();
      await ensureDialogVerificationBoundary(tabId);
      return;
    }
  }
  const assistance = activeAssistanceForTab(tabId);
  const tabHasBlockingDialog = state.dialogs.some((dialog) => dialog.tabId === tabId);
  if (!authPromptForTab(tabId) && !["waiting_user", "verifying"].includes(assistance?.status || "") && !tabHasBlockingDialog) {
    if (getTabState(tabId) === "VERIFYING") releaseVerifiedTabBoundary(tabId);
    finishRuntime("网页对话框已处理");
  } else {
    broadcastState();
  }
}

function pdfFileNameFromResponse(_url: string, _headers: Record<string, unknown>): string {
  return "document.pdf";
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
        const type = String((params as { type?: unknown }).type || "unknown");
        logRuntime(`JavaScript dialog opening (${type}) for tab ${record.id}`);
        if (type === "beforeunload") {
          nativeBeforeUnloadDialogTabs.add(record.id);
        } else {
          handleDialogOpened(record.id, params as Record<string, unknown>);
        }
      }
      if (method === "Page.javascriptDialogClosed") {
        logRuntime(`JavaScript dialog closed for tab ${record.id}`);
        if (nativeBeforeUnloadDialogTabs.delete(record.id)) return;
        const accepted = (params as { result?: unknown }).result === true;
        void handleDialogClosed(record.id, accepted);
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
): Promise<void> {
  const dialogPrompt = state.dialogs.find((candidate) => candidate.id === dialogId);
  if (!dialogPrompt) throw new Error("The browser dialog is stale or missing.");
  if (dialogPrompt.sensitive) {
    throw Object.assign(new Error("This dialog may contain a password or verification value. The user must answer it in the desktop browser."), { name: "USER_ACTION_REQUIRED" });
  }
  const record = browserTabs.get(dialogPrompt.tabId);
  if (!record) throw new Error("The dialog's browser tab is no longer available.");
  const generation = operationGeneration;
  const tabOperation = tabStateController.captureOperation(dialogPrompt.tabId);
  const assertDialogResponseCurrent = () => {
    assertOperationCurrent(generation);
    tabStateController.assertOperationCurrent(tabOperation);
  };
  assertDialogResponseCurrent();
  if (syntheticBeforeUnloadDialogIds.delete(dialogId)) {
    const action = pendingBeforeUnloadActions.get(dialogPrompt.tabId);
    pendingBeforeUnloadActions.delete(dialogPrompt.tabId);
    if (!accept) {
      await handleDialogClosed(dialogPrompt.tabId, false);
      assertDialogResponseCurrent();
      return;
    }
    if (!action || action.generation !== generation) {
      await handleDialogClosed(dialogPrompt.tabId, false);
      assertDialogResponseCurrent();
      throw new Error("The blocked browser action is no longer available. Retry it from the page.");
    }
    await handleDialogClosed(dialogPrompt.tabId, true);
    assertDialogResponseCurrent();
    if (action.kind === "close") {
      await closeBrowserTab(dialogPrompt.tabId, true);
      assertOperationCurrent(generation);
      return;
    }
    allowBeforeUnloadOnce.add(dialogPrompt.tabId);
    try {
      if (action.kind === "navigate") await browserAdapter.navigate(dialogPrompt.tabId, action.url);
      else if (action.kind === "back") await browserAdapter.back(dialogPrompt.tabId);
      else if (action.kind === "forward") await browserAdapter.forward(dialogPrompt.tabId);
      else if (action.kind === "reload") await browserAdapter.reload(dialogPrompt.tabId);
      else if (action.kind === "page_action") await browserAdapter.act(dialogPrompt.tabId, action.action);
      assertDialogResponseCurrent();
    } finally {
      allowBeforeUnloadOnce.delete(dialogPrompt.tabId);
    }
    return;
  }
  if (!record.view.webContents.debugger.isAttached()) throw new Error("The dialog's browser tab is no longer available.");
  const text = promptText == null ? undefined : String(promptText).slice(0, 2_000);
  await record.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", {
    accept,
    ...(accept && dialogPrompt.type === "prompt" ? { promptText: text || "" } : {}),
  });
  assertDialogResponseCurrent();
  await handleDialogClosed(dialogPrompt.tabId, accept);
  assertDialogResponseCurrent();
}

async function dismissBrowserDialogs(tabId: string): Promise<void> {
  const record = browserTabs.get(tabId);
  pendingBeforeUnloadActions.delete(tabId);
  allowBeforeUnloadOnce.delete(tabId);
  for (const dialog of state.dialogs) {
    if (dialog.tabId === tabId && dialog.type === "beforeunload") syntheticBeforeUnloadDialogIds.delete(dialog.id);
  }
  if (!record || !record.view.webContents.debugger.isAttached()) return;
  await record.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false });
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
  if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
  if (state.dialogs.some((dialog) => dialog.tabId === tabId)) throw new Error("Resolve the open browser dialog before capturing a screenshot.");
  assertSnapshotRevision(tabId, params.revision == null ? undefined : Number(params.revision));
  const scope = params.scope === "element" ? "element" : "viewport";
  const maxWidth = Math.min(Math.max(Math.floor(Number(params.maxWidth ?? 1_600)), 320), 2_048);
  const screenshot = await browserAdapter.screenshot(tabId, {
    scope,
    ref: scope === "element" ? String(params.ref || "").trim() : undefined,
    maxWidth,
    // MCP cannot weaken this collection-time boundary. The input remains accepted
    // only to keep older clients schema-compatible.
    redactSensitive: true,
  });
  createTask("截取页面", `${screenshot.width} × ${screenshot.height} · ${screenshot.redactionCount} 处脱敏`, "done");
  return {
    data: Buffer.from(screenshot.bytes).toString("base64"),
    mimeType: screenshot.mimeType,
    width: screenshot.width,
    height: screenshot.height,
    redactionCount: screenshot.redactionCount,
    tabId,
    title: sanitizeSensitiveText(screenshot.title) || "Browser page",
    url: sanitizeUrlForExposure(screenshot.url),
    capturedAt: new Date().toISOString(),
  };
}

function commandTargetTabId(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "browser.dialog_respond") {
    const dialogId = String(params.dialogId || "");
    return state.dialogs.find((candidate) => candidate.id === dialogId)?.tabId;
  }
  if (method === "session.check") return resolveTabId(params.tabId);
  if (method === "auth.complete") {
    const prompt = params.promptId ? findAuthPromptById(String(params.promptId)) : null;
    return params.tabId ? resolveTabId(params.tabId) : prompt?.tabId || activeTabId;
  }
  if (method === "browser.assistance_complete") {
    return findAssistanceById(String(params.assistanceId || ""))?.tabId;
  }
  if (getHandleCommandMethodPolicy(method) !== "tab_mutation") return undefined;
  return resolveTabId(params.tabId);
}

async function handleCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const commandPolicy = getHandleCommandMethodPolicy(method);
  if (isStopInProgress) {
    if (method === "browser.stop") return { ok: true };
    if (commandPolicy !== "read") throw createTaskStoppedError();
  }
  if (commandPolicy === "tab_mutation") {
    const targetTabId = commandTargetTabId(method, params);
    if (!targetTabId) throw new Error("The browser command target tab was not found.");
    assertAutomationAllowed(targetTabId);
  } else if (commandPolicy === "browser_mutation") {
    assertAutomationAllowed();
  }
  switch (method) {
    case "browser.capabilities":
      return {
        runtime: "electron-legacy",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        adapter: browserAdapter.kind,
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
        ],
      };
    case "browser.status":
      return mcpState();
    case "browser.storage_summary":
      return electronStorageSummary(params.tabId ? resolveTabId(params.tabId) : activeTabId);
    case "browser.profile_status":
      return { ...state.profileStatus };
    case "browser.confirmation_status":
      return params.confirmationId ? actionAuthorizations.get(String(params.confirmationId)) : actionAuthorizations.list();
    case "browser.confirmation_respond":
      if (params.response !== "deny") throw namedError("TRUSTED_UI_REQUIRED", "Only the Electron control center can approve a high-risk browser action.");
      return respondElectronActionConfirmation(String(params.confirmationId || ""), "deny");
    case "browser.grants_list":
      return actionAuthorizations.listGrants();
    case "browser.grant_revoke":
      actionAuthorizations.revokeGrant(String(params.grantId || "")); broadcastState(); return { ok: true };
    case "browser.tabs":
      return browserAdapter.listTabs();
    case "browser.tab_new": {
      return browserAdapter.createTab({
        url: params.url ? String(params.url) : HOME_URL,
        activate: params.activate !== false,
      });
    }
    case "browser.tab_select":
      return browserAdapter.selectTab(resolveTabId(params.tabId));
    case "browser.tab_close": {
      const tabId = resolveTabId(params.tabId);
      return browserAdapter.closeTab(tabId, { force: params.force === true });
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
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
      const maxTextCharacters = Number(params.maxTextCharacters ?? 24_000);
      const snapshot = await browserAdapter.snapshot(tabId, {
        maxElements: Number(params.maxElements ?? 140),
        maxTextCharacters,
      });
      snapshotRevisions.set(tabId, snapshot.revision);
      createTask("生成页面快照", `${snapshot.elements.length} 个可交互元素`, "done");
      return {
        ...snapshot,
        tabId,
        title: sanitizeSensitiveText(snapshot.title) || "Browser page",
        text: sanitizeSensitiveText(snapshot.text, Math.min(Math.max(Math.floor(maxTextCharacters), 1_000), 100_000)) || "",
        url: sanitizeUrlForExposure(snapshot.url),
        elements: snapshot.elements.map((element) => ({
          ...element,
          name: element.sensitive ? (element.role === "button" ? "Sensitive action" : "Sensitive input") : sanitizeSensitiveText(element.name, 240) || element.tag,
          text: element.sensitive ? "" : sanitizeSensitiveText(element.text, 500) || "",
          placeholder: element.sensitive ? undefined : sanitizeSensitiveText(element.placeholder, 500),
          value: element.sensitive ? undefined : sanitizeSensitiveText(element.value, 500),
          href: element.sensitive ? undefined : element.href ? sanitizeUrlForExposure(element.href) : undefined,
        })),
      };
    }
    case "browser.act": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      beginTabOperation(tabId);
      const tabOperation = tabStateController.captureOperation(tabId);
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
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
      const task = createTask(labels[action.action] || "执行页面动作", "页面元素引用已隐藏", "running");
      setRuntime("running", labels[action.action] || "执行页面动作");
      try {
        const evaluated = await evaluateElectronActionPolicy(tabId, action, task.id);
        if (evaluated.policy.decision === "deny_manual") {
          updateTask(task.id, "waiting_user", evaluated.policy.summary);
          throw namedError("USER_ACTION_REQUIRED", evaluated.policy.impact);
        }
        if (evaluated.policy.decision === "confirm") {
          if (!("ref" in action) || !action.ref || action.revision == null) throw namedError("SNAPSHOT_REQUIRED", "High-risk actions require a current snapshot revision and target reference.");
          const confirmation = actionAuthorizations.request({ tabId, taskId: task.id, origin: evaluated.origin, revision: action.revision, ref: action.ref, policy: evaluated.policy });
          pendingConfirmedActions.set(confirmation.id, { action, taskId: task.id, policy: evaluated.policy });
          enterTabWaitingUser(tabId); updateTask(task.id, "waiting_user", confirmation.summary); setRuntime("waiting_user", "等待用户确认高风险操作"); showWindow(); broadcastState();
          return { confirmation };
        }
        const dialogEvidence = await captureAssistanceEvidence(tabId).catch(() => undefined);
        assertOperationCurrent(generation);
        if (dialogEvidence) pendingDialogEvidenceByTab.set(tabId, dialogEvidence);
        if (["click", "double_click", "hover", "check", "uncheck"].includes(action.action)) {
          showWindow();
        }
        pendingPageActions.set(tabId, { action, generation });
        const result = await browserAdapter.act(tabId, action);
        pendingPageActions.delete(tabId);
        pendingDialogEvidenceByTab.delete(tabId);
        assertOperationCurrent(generation);
        const dialogPrompt = state.dialogs.find((dialog) => dialog.tabId === tabId) || null;
        if (dialogPrompt) {
          updateTask(task.id, "done", "页面已弹出网页对话框");
          return {
            ...result,
            title: sanitizeSensitiveText(result.title) || "Browser page",
            description: sanitizeSensitiveText(result.description, 500) || "Browser action completed",
            tabId,
            url: sanitizeUrlForExposure(result.url),
            dialog: dialogsForExposure([dialogPrompt])[0],
          };
        }
        let authPrompt: AuthPrompt | null;
        try {
          authPrompt = await inspectForAuthentication(task.id, tabId);
          assertOperationCurrent(generation);
        } catch (error) {
          if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") throw createTaskStoppedError();
          authPrompt = failClosedAuthenticationCheck(tabId, task.id);
        }
        if (authPrompt) {
          waitingAuthTasks.set(task.id, { tabId, completion: "done" });
          updateTask(task.id, "waiting_user", authPrompt.detail);
        } else {
          tabStateController.assertOperationCurrent(tabOperation);
          markTabReady(tabId);
          updateTask(task.id, "done", result.description);
          finishRuntime("页面动作已完成");
        }
        return {
          ...result,
          title: sanitizeSensitiveText(result.title) || "Browser page",
          description: sanitizeSensitiveText(result.description, 500) || "Browser action completed",
          tabId,
          url: sanitizeUrlForExposure(result.url),
          authPrompt: authPromptForExposure(authPrompt),
        };
      } catch (error) {
        pendingPageActions.delete(tabId);
        pendingDialogEvidenceByTab.delete(tabId);
        if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") {
          updateTask(task.id, "error", "页面动作已停止或转入用户控制");
          throw createTaskStoppedError();
        }
        if ((error as Error).name === "USER_ACTION_REQUIRED") {
          const message = (error as Error).message;
          const kind: AssistanceKind = /file-upload|file upload|file picker/i.test(message)
            ? "file_selection"
            : /verification|one-time|otp|验证码|动态口令/i.test(message)
              ? "verification"
              : /password|credential|登录/i.test(message)
                ? "credential"
                : "manual_action";
          await requestHumanAssistance({
            kind,
            title: kind === "file_selection" ? "请选择本地文件" : kind === "verification" ? "请完成验证" : kind === "credential" ? "请完成敏感登录步骤" : "需要你的手工操作",
            detail: kind === "file_selection"
              ? "请选择本次任务所需的本地文件。"
              : kind === "verification"
                ? "请在可见浏览器中完成当前验证步骤。"
                : kind === "credential"
                  ? "请在可见浏览器中完成当前敏感登录步骤。"
                  : "请在可见浏览器中完成当前手工步骤。",
            tabId,
            taskId: task.id,
          });
        } else {
          updateTask(task.id, "error", (error as Error).message);
          markTabError(tabId);
          setRuntime("error", "页面动作失败");
        }
        throw error;
      }
    }
    case "browser.wait": {
      const tabId = resolveTabId(params.tabId);
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
      const generation = operationGeneration;
      const tabOperation = tabStateController.captureOperation(tabId);
      const condition = String(params.condition ?? "idle") as BrowserWaitCondition;
      const task = createTask("等待页面条件", condition, "running");
      setRuntime("running", "等待页面变化");
      const result = await browserAdapter.wait(tabId, {
        condition,
        value: params.value == null ? undefined : String(params.value),
        timeoutMs: Number(params.timeoutMs ?? 10_000),
      });
      assertOperationCurrent(generation);
      let authPrompt: AuthPrompt | null;
      try {
        authPrompt = await inspectForAuthentication(task.id, tabId);
        assertOperationCurrent(generation);
      } catch (error) {
        if (generation !== operationGeneration || (error as Error).name === "TASK_STOPPED") {
          updateTask(task.id, "error", "等待操作已停止或转入用户控制");
          throw createTaskStoppedError();
        }
        authPrompt = failClosedAuthenticationCheck(tabId, task.id);
      }
      if (authPrompt) {
        waitingAuthTasks.set(task.id, { tabId, completion: "done" });
        updateTask(task.id, "waiting_user", authPrompt.detail);
      } else if (result.satisfied) {
        try {
          tabStateController.assertOperationCurrent(tabOperation);
        } catch (error) {
          updateTask(task.id, "error", "等待操作已停止或转入用户控制");
          throw error;
        }
        if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))) markTabReady(tabId);
        updateTask(task.id, "done", result.detail);
        finishRuntime("等待条件已满足");
      } else {
        try {
          tabStateController.assertOperationCurrent(tabOperation);
        } catch (error) {
          updateTask(task.id, "error", "等待操作已停止或转入用户控制");
          throw error;
        }
        if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))) markTabError(tabId);
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
      beginTabOperation(tabId);
      const generation = operationGeneration;
      const tabOperation = tabStateController.captureOperation(tabId);
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      pendingBeforeUnloadActions.set(tabId, { kind: "back", generation });
      await browserAdapter.back(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      return { ok: true };
    }
    case "browser.forward": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      beginTabOperation(tabId);
      const generation = operationGeneration;
      const tabOperation = tabStateController.captureOperation(tabId);
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      pendingBeforeUnloadActions.set(tabId, { kind: "forward", generation });
      await browserAdapter.forward(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      return { ok: true };
    }
    case "browser.reload": {
      assertAutomationAllowed();
      const tabId = resolveTabId(params.tabId);
      beginTabOperation(tabId);
      const generation = operationGeneration;
      const tabOperation = tabStateController.captureOperation(tabId);
      if (tabId !== activeTabId) await browserAdapter.selectTab(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      pendingBeforeUnloadActions.set(tabId, { kind: "reload", generation });
      await browserAdapter.reload(tabId);
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      return { ok: true };
    }
    case "browser.screenshot":
      return captureBrowserScreenshot(params);
    case "browser.dialogs": {
      const tabId = params.tabId ? resolveTabId(params.tabId) : undefined;
      return { dialogs: dialogsForExposure(await browserAdapter.listDialogs(tabId)) };
    }
    case "browser.dialog_respond": {
      const dialogId = String(params.dialogId || "");
      const tabId = state.dialogs.find((candidate) => candidate.id === dialogId)?.tabId;
      if (!tabId) throw new Error("The browser dialog is stale or missing.");
      await browserAdapter.respondDialog(tabId, {
        dialogId,
        accept: params.accept === true,
        promptText: params.promptText == null ? undefined : String(params.promptText),
      });
      return { handled: true, dialogs: dialogsForExposure() };
    }
    case "browser.pause":
      pauseCodexTabs();
      setRuntime("paused", "Codex 控制已暂停");
      return { ok: true };
    case "browser.resume": {
      resumeCodexTabs();
      restorePendingUserBoundaries();
      const activeAssistance = assistanceForTab(activeTabId);
      if (authPromptForTab(activeTabId)) {
        setRuntime("waiting_user", "Codex 控制已恢复，仍在等待授权");
      } else if (activeAssistance?.status === "waiting_user" || activeAssistance?.status === "verifying") {
        setRuntime("waiting_user", "Codex 控制已恢复，仍在等待人工协助");
      } else if (state.dialogs.some((dialog) => dialog.tabId === activeTabId && dialog.sensitive)) {
        setRuntime("waiting_user", "Codex 控制已恢复，仍有敏感网页对话框");
      } else {
        setRuntime("idle", "Codex 控制已恢复");
      }
      return { ok: true };
    }
    case "browser.stop": {
      operationGeneration += 1;
      tabStateController.stopAll();
      actionAuthorizations.cancelAll();
      pendingConfirmedActions.clear();
      isStopInProgress = true;
      try {
        state.dialogs = [];
        dialogTaskIds.clear();
        dialogEvidenceBaselines.clear();
        pendingDialogEvidenceByTab.clear();
        syntheticBeforeUnloadDialogIds.clear();
        nativeBeforeUnloadDialogTabs.clear();
        pendingBeforeUnloadActions.clear();
        allowBeforeUnloadOnce.clear();
        pendingPageActions.clear();
        tabLoadGenerations.clear();
        mainFrameRequestGenerations.clear();
        await Promise.all([...browserTabs.keys()].map((tabId) => browserAdapter.stop(tabId).catch(() => undefined)));
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
        for (const [downloadId, item] of activeDownloadJobs) {
          try {
            item.cancel();
          } catch {
            // A completed download can race with the stop command.
          }
          const download = state.downloads.find((candidate) => candidate.id === downloadId);
          if (download && (download.state === "starting" || download.state === "progressing")) {
            download.state = "interrupted";
            download.updatedAt = new Date().toISOString();
          }
        }
        activeDownloadJobs.clear();
        for (const controller of activeProbeControllers) controller.abort();
        activeProbeControllers.clear();
        const dismissAllDialogs = () => Promise.all(
          [...browserTabs.keys()].map((tabId) => browserAdapter.dismissDialogs(tabId).catch(() => undefined)),
        );
        await dismissAllDialogs();
        await new Promise<void>((resolve) => setImmediate(resolve));
        state.dialogs = [];
        await dismissAllDialogs();
        authPrompts.clear();
        authPromptBaselines.clear();
        waitingAuthTasks.clear();
        for (const [tabId, assistance] of assistanceRequests) {
          if (assistance.status !== "waiting_user" && assistance.status !== "verifying") continue;
          assistanceEvidenceBaselines.delete(assistance.id);
          assistanceRequests.set(tabId, {
            ...assistance,
            status: "cancelled",
            note: "已由用户停止",
            resolvedAt: new Date().toISOString(),
          });
        }
        assistanceEvidenceBaselines.clear();
        syncActiveInterruptionState();
        for (const task of state.tasks) {
          if (task.status === "queued" || task.status === "running" || task.status === "waiting_user") {
            task.status = "error";
            task.detail = "已由用户停止";
            task.updatedAt = new Date().toISOString();
          }
        }
        for (const tabId of browserTabs.keys()) {
          if (getTabState(tabId) !== "READY") {
            if (getTabState(tabId) !== "ERROR") markTabError(tabId);
            markTabReady(tabId);
          }
        }
        mainWindow?.flashFrame(false);
        setRuntime("idle", "任务已停止");
        await persistRuntimeStateNow();
        return { ok: true };
      } finally {
        isStopInProgress = false;
      }
    }
    case "session.check":
      return checkSessionHealth(resolveTabId(params.tabId));
    case "auth.complete":
      if (params.userConfirmed !== true) throw new Error("Set userConfirmed=true only after the user explicitly confirms the manual step.");
      return completeAuthentication(
        params.promptId ? String(params.promptId) : undefined,
        params.tabId ? String(params.tabId) : undefined,
      );
    case "auth.request_login": {
      const tabId = resolveTabId(params.tabId);
      const target = String(params.url ?? state.url ?? HOME_URL);
      showWindow();
      await enqueueNavigation(target, "打开授权页面", false, tabId);
      if (!authPromptForTab(tabId)) {
        const task = createTask("等待登录授权", sanitizeUrlForExposure(target) || "授权页面", "waiting_user");
        setAuthPrompt({
          id: randomUUID(),
          tabId,
          reason: "login",
          title: "请完成登录授权",
          detail: "请在可见浏览器中完成登录，完成后点击继续。",
          url: browserAdapter.getTabInfo(tabId).url,
          detectedAt: new Date().toISOString(),
        }, task.id);
      }
      return authPromptForExposure(authPromptForTab(tabId));
    }
    case "auth.clear":
      cancelAuthPrompt(activeTabId, "授权提醒已清除");
      return { ok: true };
    case "browser.assistance_request":
      return assistanceForExposure(await requestHumanAssistance({
        kind: normalizeAssistanceKind(params.kind),
        title: String(params.title || "需要你的协助"),
        detail: String(params.detail || "请在可见浏览器中完成当前步骤。"),
        tabId: params.tabId ? String(params.tabId) : undefined,
      }));
    case "browser.assistance_status": {
      const assistance = params.assistanceId
        ? findAssistanceById(String(params.assistanceId))
        : assistanceForTab(activeTabId);
      return assistanceForExposure(assistance);
    }
    case "browser.assistance_complete":
      if (params.userConfirmed !== true) throw new Error("Set userConfirmed=true only after the user explicitly confirms the manual step.");
      return assistanceForExposure(await completeHumanAssistance(
        String(params.assistanceId || ""),
        params.outcome === "unable" ? "unable" : "completed",
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
      const tabId = resolveTabId(params.tabId);
      beginTabOperation(tabId);
      const generation = operationGeneration;
      const tabOperation = tabStateController.captureOperation(tabId);
      const result = await browserAdapter.startDownload(tabId, {
        url: params.url ? String(params.url) : undefined,
        candidateId: params.candidateId ? String(params.candidateId) : undefined,
      });
      assertOperationCurrent(generation);
      tabStateController.assertOperationCurrent(tabOperation);
      return { ...result, url: sanitizeUrlForExposure(result.url) };
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
  try {
    const result = await handleCommand(request.method, request.params);
    return { id: request.id, ok: true, result };
  } catch (error) {
    const safe = sanitizeError(error);
    return {
      id: request.id,
      ok: false,
      error: {
        code: safe.name,
        message: safe.message,
      },
    };
  }
}

function enqueuePipeRequest(request: PipeRequest): Promise<PipeResponse> {
  let policy;
  try {
    policy = getHandleCommandMethodPolicy(request.method);
  } catch {
    return handlePipeRequest(request);
  }

  if (request.method === "browser.dialog_respond") {
    try {
      const tabId = commandTargetTabId(request.method, request.params || {});
      if (!tabId) throw new Error("The browser command target tab was not found.");
      tabStateController.assertCommandAllowed(request.method, tabId);
    } catch (error) {
      const safe = sanitizeError(error);
      return Promise.resolve({
        id: request.id,
        ok: false,
        error: { code: safe.name, message: safe.message },
      });
    }
    return handlePipeRequest(request);
  }

  if (policy === "read" || policy === "control" || policy === "browser_mutation") {
    return handlePipeRequest(request);
  }

  if (policy === "tab_mutation" || policy === "verification") {
    let tabId: string | undefined;
    let operation: TabOperationGeneration | undefined;
    try {
      tabId = commandTargetTabId(request.method, request.params || {});
      if (!tabId) throw new Error("The browser command target tab was not found.");
      if (policy === "tab_mutation") tabStateController.assertCommandAllowed(request.method, tabId);
      operation = tabStateController.captureOperation(tabId);
    } catch (error) {
      const safe = sanitizeError(error);
      return Promise.resolve({
        id: request.id,
        ok: false,
        error: { code: safe.name, message: safe.message },
      });
    }
    const run = async () => {
      try {
        if (policy === "tab_mutation") {
          tabStateController.assertCommandAllowed(request.method, tabId, operation);
        } else if (operation) {
          tabStateController.assertOperationCurrent(operation);
        }
      } catch (error) {
        const safe = sanitizeError(error);
        return {
          id: request.id,
          ok: false,
          error: { code: safe.name, message: safe.message },
        } satisfies PipeResponse;
      }
      return handlePipeRequest(request);
    };
    const queue = tabCommandQueues.get(tabId) || Promise.resolve();
    const result = queue.then(run, run);
    tabCommandQueues.set(tabId, result.then(() => undefined, () => undefined));
    return result;
  }

  const queuedGeneration = operationGeneration;
  const run = () => queuedGeneration === operationGeneration
    ? handlePipeRequest(request)
    : Promise.resolve({
        id: request.id,
        ok: false,
        error: { code: "TASK_STOPPED", message: "The queued browser task was stopped before it started." },
      } satisfies PipeResponse);
  const result = brokerCommandQueue.then(run, run);
  brokerCommandQueue = result.then(() => undefined, () => undefined);
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
            const safe = sanitizeError(error);
            response = {
              id: "invalid",
              ok: false,
              error: { code: "INVALID_REQUEST", message: safe.message },
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
  if (contents.isLoading()) tabLoadGenerations.set(tabId, operationGeneration);
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
          const popupUrl = browserAdapter.getTabInfo(popup.id).url;
          const sourceUrl = browserAdapter.getTabInfo(tabId).url;
          if (popupUrl === "about:blank" || popupUrl === sourceUrl) {
            void browserAdapter.navigate(popup.id, url).catch((error) => {
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
    if (isStopInProgress) {
      tabLoadGenerations.delete(tabId);
      return;
    }
    tabLoadGenerations.set(tabId, operationGeneration);
    if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId)) && state.runtimeStatus !== "paused") {
      beginTabOperation(tabId);
      enterTabWaitingPage(tabId);
    }
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
    const generation = tabLoadGenerations.get(tabId);
    tabLoadGenerations.delete(tabId);
    if (generation == null || generation !== operationGeneration || isStopInProgress) return;
    const isActiveTab = tabId === activeTabId;
    if (isActiveTab) state.isLoading = false;
    updateNavigationState(tabId);
    void inspectForAuthentication(undefined, tabId).then((prompt) => {
      if (generation !== operationGeneration || isStopInProgress) return;
      if (!prompt && isActiveTab && state.runtimeStatus === "running") {
        if (tabHasActiveUserBoundary(tabId)) {
          setRuntime("waiting_user", "页面已加载，仍在等待用户确认");
        } else if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))) {
          markTabReady(tabId);
          setRuntime("idle", "页面已就绪");
        }
      }
    }).catch((error) => {
      if (generation !== operationGeneration || isStopInProgress || (error as Error).name === "TASK_STOPPED") return;
      failClosedAuthenticationCheck(tabId);
    });
  });
  contents.on("will-navigate", (_event, url) => {
    pendingBeforeUnloadActions.set(tabId, {
      kind: "navigate",
      url,
      generation: pendingPageActions.get(tabId)?.generation ?? operationGeneration,
    });
  });
  contents.on("will-prevent-unload", (event) => {
    if (allowBeforeUnloadOnce.delete(tabId)) {
      event.preventDefault();
      return;
    }
    let action = pendingBeforeUnloadActions.get(tabId);
    if (!action) {
      const pageAction = pendingPageActions.get(tabId);
      if (pageAction) {
        action = { kind: "page_action", ...pageAction };
        pendingBeforeUnloadActions.set(tabId, action);
      }
    }
    if (!action || action.generation !== operationGeneration || isStopInProgress) return;
    const dialog = handleDialogOpened(tabId, {
      type: "beforeunload",
      message: "",
      url: browserAdapter.getTabInfo(tabId).url,
    });
    if (dialog) syntheticBeforeUnloadDialogIds.add(dialog.id);
  });
  contents.on("did-navigate", () => {
    pendingBeforeUnloadActions.delete(tabId);
    updateNavigationState(tabId);
  });
  contents.on("did-navigate-in-page", () => updateNavigationState(tabId));
  contents.on("page-title-updated", () => updateNavigationState(tabId));
  contents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    const generation = tabLoadGenerations.get(tabId);
    tabLoadGenerations.delete(tabId);
    if (code === -3 || generation == null || generation !== operationGeneration || isStopInProgress) return;
    createTask("页面加载失败", `${sanitizeUrlForExposure(validatedUrl) || "Browser page"} · ${sanitizeSensitiveText(description, 500) || "Load failed"}`, "error");
    if (!["WAITING_USER", "VERIFYING"].includes(getTabState(tabId))) markTabError(tabId);
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

function safeIpcHandle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, async (event, ...args: Args) => {
    try {
      return await listener(event, ...args);
    } catch (error) {
      const safe = sanitizeError(error);
      const sanitizedError = new Error(safe.message);
      sanitizedError.name = safe.name;
      throw sanitizedError;
    }
  });
}

function setupIpc(): void {
  safeIpcHandle("browser:get-state", () => desktopState());
  ipcMain.on("browser:set-bounds", (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (!browserView) return;
    browserAdapter.setViewportBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  });
  safeIpcHandle("browser:navigate", (_event, url: string) => enqueueNavigation(url, "手动打开网页", true, activeTabId));
  safeIpcHandle("browser:back", () => {
    const generation = operationGeneration;
    assertOperationCurrent(generation);
    pendingBeforeUnloadActions.set(activeTabId, { kind: "back", generation });
    return browserAdapter.back(activeTabId);
  });
  safeIpcHandle("browser:forward", () => {
    const generation = operationGeneration;
    assertOperationCurrent(generation);
    pendingBeforeUnloadActions.set(activeTabId, { kind: "forward", generation });
    return browserAdapter.forward(activeTabId);
  });
  safeIpcHandle("browser:reload", () => {
    const generation = operationGeneration;
    assertOperationCurrent(generation);
    pendingBeforeUnloadActions.set(activeTabId, { kind: "reload", generation });
    return browserAdapter.reload(activeTabId);
  });
  safeIpcHandle("browser:home", () => enqueueNavigation(HOME_URL, "打开主页", true, activeTabId));
  safeIpcHandle("tabs:create", async (_event, url?: string) => {
    const result = await browserAdapter.createTab({ url: url || HOME_URL, activate: true });
    return result.tabs.find((tab) => tab.id === result.createdTabId);
  });
  safeIpcHandle("tabs:select", (_event, tabId: string) => browserAdapter.selectTab(resolveTabId(tabId)));
  safeIpcHandle("tabs:close", async (_event, tabId: string) => browserAdapter.closeTab(resolveTabId(tabId), { force: false }));
  safeIpcHandle("browser:pause", () => handleCommand("browser.pause"));
  safeIpcHandle("browser:resume", () => handleCommand("browser.resume"));
  safeIpcHandle("browser:stop", () => handleCommand("browser.stop"));
  safeIpcHandle("session:check", () => handleCommand("session.check") as Promise<SessionHealth>);
  safeIpcHandle("storage:summary", () => electronStorageSummary(activeTabId));
  safeIpcHandle("storage:request-action", (_event, action: BrowserDataAction, includePermissions?: boolean) => {
    const scope = action === "clear_site" ? currentOrigin(activeTabId) : action === "reset_profile" ? "primary" : "all-sites";
    if (action === "clear_site" && !scope) throw new Error("The current page does not have a clearable website origin.");
    return dataConfirmations.request(action, scope, includePermissions === true);
  });
  safeIpcHandle("storage:confirm-action", async (_event, confirmationId: string) => {
    const confirmation = dataConfirmations.consume(confirmationId);
    if (confirmation.action === "reset_profile") throw new Error("Dedicated Edge profile reset is available in the Edge prototype control center.");
    const wasPaused = state.runtimeStatus === "paused";
    if (!wasPaused) await handleCommand("browser.pause");
    try {
      if (confirmation.action === "clear_all") {
        actionAuthorizations.cancelAll("All browser data cleared");
        actionAuthorizations.clearGrants();
        pendingConfirmedActions.clear();
      }
      const result = confirmation.action === "clear_site"
        ? await clearElectronSiteData(activeTabId, confirmation.includePermissions)
        : await clearAllElectronData();
      return result;
    } finally {
      if (!wasPaused) await handleCommand("browser.resume");
    }
  });
  safeIpcHandle("storage:session-recovery", (_event, enabled: boolean) => setElectronSessionRecovery(enabled));
  safeIpcHandle("policy:respond-confirmation", (_event, confirmationId: string, response: "allow_once" | "allow_temporary" | "deny") => respondElectronActionConfirmation(confirmationId, response));
  safeIpcHandle("policy:revoke-grant", (_event, grantId: string) => { actionAuthorizations.revokeGrant(grantId); broadcastState(); });
  safeIpcHandle("policy:clear-audit", () => { actionAuthorizations.clearAudit(); broadcastState(); });
  safeIpcHandle("runtime:show-browser", () => { mainWindow?.show(); mainWindow?.focus(); });
  safeIpcHandle("runtime:restart-browser", () => { app.relaunch(); app.exit(0); });
  safeIpcHandle("runtime:shutdown-browser", () => app.quit());
  safeIpcHandle("runtime:update-settings", (_event, patch: Partial<BrowserRuntimeSettings>) => {
    runtimeSettings = updateRuntimeSettings(runtimeSettings, patch, productRoot);
    state.runtimeSettings = { ...runtimeSettings };
    broadcastState();
    return { ...runtimeSettings };
  });
  safeIpcHandle("auth:complete", (_event, promptId?: string) => handleCommand("auth.complete", { promptId, userConfirmed: true }) as Promise<SessionHealth>);
  safeIpcHandle(
    "assistance:respond",
    async (_event, assistanceId: string, outcome: "completed" | "unable") => assistanceForExposure(
      await completeHumanAssistance(assistanceId, outcome),
    ),
  );
  safeIpcHandle(
    "dialog:respond",
    (_event, dialogId: string, accept: boolean, promptText?: string) => respondToBrowserDialog(dialogId, accept, promptText),
  );
  safeIpcHandle("tasks:clear", () => handleCommand("tasks.clear"));
  safeIpcHandle("downloads:clear", () => handleCommand("downloads.clear"));
  safeIpcHandle("downloads:open", async () => {
    const error = await shell.openPath(downloadsDir);
    if (error) throw new Error(error);
  });
  safeIpcHandle("downloads:open-item", async (_event, downloadId: string) => {
    const download = state.downloads.find((candidate) => candidate.id === downloadId);
    if (!download?.path) throw new Error("找不到这条下载记录对应的本地文件。");
    if (!isInsideDirectory(downloadsDir, download.path)) throw new Error("下载记录指向了下载目录之外的文件。");
    await fs.access(download.path);
    const error = await shell.openPath(download.path);
    if (error) throw new Error(error);
  });
  safeIpcHandle("document:import", async () => {
    if (!mainWindow) return null;
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入 PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return handleCommand("document.import", { path: selection.filePaths[0] });
  });
  safeIpcHandle("document:open", async (_event, documentId: string) => {
    const filePath = documentService.getFilePath(documentId);
    await fs.access(filePath);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });
}

function createTray(): void {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#12634a"/><path d="M9 8h14v3H12v10h11v3H9z" fill="white"/><path d="M15 13h8v3h-8zm0 5h6v3h-6z" fill="#b7e3d2"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
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
  for (const fileName of persisted.ignoredDownloadFiles) {
    if (path.basename(fileName) !== fileName) continue;
    const existingPath = path.join(downloadsDir, fileName);
    if (!await fs.access(existingPath).then(() => true, () => false)) continue;
    const safePath = await migrateDownloadPath(existingPath).catch(() => "");
    if (safePath) ignoredDownloadFiles.add(path.basename(safePath));
  }
  const interruptedAt = new Date().toISOString();
  state.tasks = persisted.tasks.slice(0, MAX_TASKS).map((task) => {
    const restoredTask = {
      ...task,
      label: sanitizePersistedText(task.label)?.slice(0, 300) || "Browser task",
      detail: sanitizePersistedText(task.detail),
    };
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
  state.downloads = [];
  for (const download of persisted.downloads.slice(0, MAX_DOWNLOADS)) {
    let filePath = download.path && isInsideDirectory(downloadsDir, download.path)
      ? path.resolve(download.path)
      : undefined;
    if (!filePath || !await fs.access(filePath).then(() => true, () => false)) continue;
    filePath = await migrateDownloadPath(filePath).catch(() => "");
    if (!filePath) continue;
    const restored = {
      ...download,
      fileName: path.basename(filePath),
      path: filePath,
      url: sanitizeUrlForExposure(download.url),
    };
    state.downloads.push(
      restored.state === "starting" || restored.state === "progressing"
        ? { ...restored, state: "interrupted" as const, updatedAt: interruptedAt }
        : restored,
    );
  }
  restoredTabs = persisted.tabs
    .map((tab) => ({ ...tab, url: safeUrlForPersistence(tab.url) || "" }))
    .filter((tab) => Boolean(tab.url))
    .slice(0, MAX_TABS);
  const restoredTabIds = new Set(restoredTabs.map((tab) => tab.id));
  const restoredBoundaryKeys = new Set<string>();
  restoredBlockedTabs = persisted.blockedTabs.filter((blocked) => {
    if (!restoredTabIds.has(blocked.tabId)) return false;
    const key = `${blocked.tabId}:${blocked.kind}`;
    if (restoredBoundaryKeys.has(key)) return false;
    restoredBoundaryKeys.add(key);
    return true;
  }).slice(0, MAX_TABS * 3);
  restoredActiveTabId = restoredTabs.some((tab) => tab.id === persisted.activeTabId)
    ? persisted.activeTabId
    : restoredTabs[0]?.id;
  state.assistance = null;
  lastSafeUrl = safeUrlForPersistence(persisted.lastSafeUrl) || HOME_URL;
  state.url = lastSafeUrl;
  if (persisted.savedAt !== new Date(0).toISOString()) {
    state.storage.lastSavedAt = persisted.savedAt;
  }
  refreshStorageSummary();
}

function rebuildRestoredUserBoundaries(): void {
  const grouped = new Map<string, PersistedBlockedTab[]>();
  for (const blocked of restoredBlockedTabs) {
    if (!browserTabs.has(blocked.tabId)) continue;
    const existing = grouped.get(blocked.tabId) || [];
    existing.push(blocked);
    grouped.set(blocked.tabId, existing);
  }
  for (const [tabId, blocked] of grouped) {
    const record = browserTabs.get(tabId);
    if (!record) continue;
    const auth = blocked.find((candidate) => candidate.kind === "auth");
    if (auth) {
      const reason: AuthPrompt["reason"] = auth.authReason === "captcha"
        ? "captcha"
        : auth.authReason === "mfa"
          ? "mfa"
          : "login";
      authPrompts.set(tabId, {
        id: randomUUID(),
        tabId,
        reason,
        title: reason === "captcha" ? "需要重新确认验证码步骤" : reason === "mfa" ? "需要重新确认多因素验证" : "需要重新确认登录授权",
        detail: "浏览器上次退出时该标签页仍处于人工控制边界。请在可见页面中确认状态并点击检查；验证通过前不会恢复自动操作。",
        url: record.lastSafeUrl,
        detectedAt: auth.requestedAt,
      });
    }
    const manual = blocked.find((candidate) => candidate.kind === "assistance" || candidate.kind === "dialog");
    if (manual) {
      const title = "需要重新确认人工步骤";
      const detail = "浏览器上次退出时该标签页仍在等待用户操作。请确认页面状态并产生可验证变化后再次检查。";
      const task = createTask(title, detail, "waiting_user");
      assistanceRequests.set(tabId, {
        id: randomUUID(),
        tabId,
        taskId: task.id,
        kind: "manual_action",
        title,
        detail,
        url: record.lastSafeUrl,
        status: "waiting_user",
        requestedAt: manual.requestedAt,
      });
    }
  }
  syncActiveInterruptionState();
}

async function createApplication(): Promise<void> {
  logRuntime("Creating desktop application");
  Menu.setApplicationMenu(null);
  app.setAppUserModelId("local.codex.browser");
  const libraryDir = path.join(app.getPath("userData"), "library");
  downloadsDir = path.join(libraryDir, "downloads");
  persistenceService = new PersistenceService(path.join(app.getPath("userData"), "state"));
  await persistenceService.initialize();
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

  browserAdapter = new ElectronWebContentsViewAdapter({
    resolveContents: (tabId) => requireBrowserView(tabId).webContents,
    listTabs: () => exposedTabsResult(),
    createTab: (options) => {
      const record = createBrowserTab(options?.url || HOME_URL, options?.activate !== false);
      return { ...exposedTabsResult(), createdTabId: record.id };
    },
    selectTab: (tabId) => {
      activateBrowserTab(tabId);
      return exposedTabsResult();
    },
    closeTab: async (tabId, options) => {
      await closeBrowserTab(tabId, options?.force === true);
      return exposedTabsResult();
    },
    setViewportBounds: (bounds) => {
      browserBounds = bounds;
      browserView?.setBounds(bounds);
    },
    listDialogs: (tabId) => tabId ? state.dialogs.filter((item) => item.tabId === tabId) : [...state.dialogs],
    respondDialog: (_tabId, request) => respondToBrowserDialog(
      request.dialogId,
      request.accept,
      request.promptText,
    ),
    dismissDialogs: dismissBrowserDialogs,
    startDownload: (tabId, request) => startDownload(request.url, request.candidateId, tabId),
    verifyProtectedResource: async (tabId, request): Promise<BrowserResourceProbeResult> => {
      const result = await probeProtectedResource({
        id: "adapter-probe",
        tabId,
        reason: "forbidden",
        title: request.expectedPdf ? "论文下载" : "受保护资源",
        detail: "受保护资源检查",
        url: request.url,
        detectedAt: new Date().toISOString(),
      });
      return { ok: result.ok, detail: result.detail };
    },
    getSessionSummary: async () => {
      const cookies = await requireSession().cookies.get({});
      return {
        cookieCount: cookies.length,
        sessionCookieCount: cookies.filter((cookie) => cookie.session).length,
        encryptedBackupAvailable: state.sessionHealth.encryptedBackupAvailable,
      };
    },
    flushPersistentSession: flushPersistentData,
    getStorageSummary: electronStorageSummary,
    clearSiteData: (tabId, options) => clearElectronSiteData(tabId, options?.includePermissions === true).then(() => undefined),
    clearAllBrowserData: () => clearAllElectronData().then(() => undefined),
  });

  const targetSession = session.fromPartition(PROFILE_PARTITION, { cache: true });
  browserSession = targetSession;
  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
    const tabId = [...browserTabs.values()].find((record) => record.view.webContents.id === webContents.id)?.id;
    if (!tabId) return;
    void requestHumanAssistance({
      kind: "permission",
      title: "网站请求敏感权限",
      detail: `${sanitizeUrlForExposure(webContents.getURL()) || "当前网站"} 请求 ${String(permission).slice(0, 80)} 权限。Codex 不会静默授予，请在浏览器原生界面中决定。`,
      tabId,
    }).catch(() => undefined);
  });
  const restoreResult = await persistenceService.restoreSessionCookies(targetSession);
  const restoredCookies = await targetSession.cookies.get({});
  state.sessionHealth = {
    status: restoreResult.encryptionAvailable ? "unknown" : "unavailable",
    detail: !restoreResult.encryptionAvailable
      ? "系统加密不可用，当前只能依赖 Chromium 自身的持久 Cookie"
      : restoreResult.restored > 0
        ? `已恢复 ${restoreResult.restored} 个加密会话 Cookie`
        : "加密会话保存已启用",
    checkedAt: new Date().toISOString(),
    cookieCount: restoredCookies.length,
    sessionCookieCount: restoredCookies.filter((cookie) => cookie.session).length,
    encryptedBackupAvailable: restoreResult.backupFound,
    lastRestoredAt: restoreResult.restoredAt,
  };
  targetSession.cookies.on("changed", () => {
    scheduleSessionCookieBackup();
  });
  scheduleSessionCookieBackup(0);
  registerDownloadListener(targetSession);
  targetSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === "mainFrame" && !isStopInProgress) {
      mainFrameRequestGenerations.set(details.id, operationGeneration);
    }
    callback({});
  });
  targetSession.webRequest.onCompleted((details) => {
    const requestGeneration = mainFrameRequestGenerations.get(details.id);
    mainFrameRequestGenerations.delete(details.id);
    if (
      requestGeneration === operationGeneration
      && !isStopInProgress
      && details.resourceType === "mainFrame"
      && (details.statusCode === 401 || details.statusCode === 403)
    ) {
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
  targetSession.webRequest.onErrorOccurred((details) => {
    mainFrameRequestGenerations.delete(details.id);
  });

  const tabSpecs = restoredTabs.length > 0
    ? restoredTabs
    : [{ id: randomUUID(), title: "Codex Browser", url: lastSafeUrl, createdAt: new Date().toISOString() }];
  for (const tab of tabSpecs) {
    createBrowserTab(tab.url, false, {}, tab.id, tab.createdAt);
  }
  rebuildRestoredUserBoundaries();
  restoredBlockedTabs = [];
  const initialTabId = restoredActiveTabId && browserTabs.has(restoredActiveTabId)
    ? restoredActiveTabId
    : browserTabs.keys().next().value as string | undefined;
  if (!initialTabId) throw new Error("Codex Browser could not create its initial tab.");
  activateBrowserTab(initialTabId, false);
  const initialAssistance = assistanceForTab(initialTabId);
  if (
    authPromptForTab(initialTabId)
    || initialAssistance?.status === "waiting_user"
    || initialAssistance?.status === "verifying"
  ) {
    state.runtimeStatus = "waiting_user";
    state.currentAction = "等待用户重新确认上次中断的人工步骤";
  }
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
    const safe = sanitizeError(error);
    dialog.showErrorBox("Codex Browser failed to start", `${safe.name}: ${safe.message}`);
    app.quit();
  });
}

app.on("activate", showWindow);
app.on("window-all-closed", () => {
  // The tray process remains alive so session cookies and MCP access stay available.
});
app.on("before-quit", (event) => {
  isQuitting = true;
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
