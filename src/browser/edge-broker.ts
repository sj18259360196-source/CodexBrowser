#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  BROWSER_PROTOCOL_VERSION,
  type AppState,
  type BrowserAction,
  type BrowserDialogPrompt,
  type BrowserTabSummary,
  type DownloadItem,
  type HumanAssistance,
  type BrowserStorageSummary,
  type BrowserProfileStatus,
  type BrowserDataAction,
  type BrowserActionConfirmation,
  type BrowserRuntimeSettings,
  type PipeRequest,
  type PipeResponse,
  type TaskItem,
  type TaskStatus,
} from "../shared/contracts";
import { sanitizeError, sanitizeSensitiveText, sanitizeUrlForExposure } from "../security/redaction";
import { DocumentService } from "../electron/document-service";
import { EdgePrototypeRuntime } from "./edge-runtime";
import { ExtensionRelayRuntime } from "./extension-relay-runtime";
import { ExtensionRelayServer } from "./extension-relay-server";
import type { BrowserRuntime } from "./browser-runtime";
import { archiveOwnedEdgeProfile, createUniqueEdgeProfile, removeArchivedEdgeProfile, removeManagedEdgeProfile, resolvePrimaryEdgeProfile } from "./edge-profile";
import type { EdgeBrowserAdapter } from "./edge-browser-adapter";
import type { BrowserChallengeEvidence } from "./browser-adapter";
import { AssistanceCoordinator } from "./assistance-coordinator";
import { detectChallenge, shouldFreezeForChallenge } from "./challenge-detector";
import { verifyChallengeResolution } from "./challenge-verifier";
import { TabStateController } from "./tab-state-policy";
import { BrowserDataConfirmationStore } from "./data-confirmation";
import { ActionAuthorizationStore } from "./action-authorization";
import { canRememberGrant, evaluatePolicy, type PolicyResult } from "./policy-engine";
import { loadRuntimeSettings, updateRuntimeSettings } from "./runtime-settings";

const projectRoot = path.resolve(process.env.CODEX_BROWSER_PROJECT_ROOT || process.cwd());
const runtimeRoot = path.resolve(process.env.CODEX_BROWSER_EDGE_RUNTIME_ROOT || path.join(projectRoot, ".runtime"));
const temporaryProfile = Boolean(process.env.CODEX_BROWSER_EDGE_PROFILE_DIR);
const preserveTemporaryProfile = process.env.CODEX_BROWSER_TEST_MODE === "1"
  && process.env.CODEX_BROWSER_PRESERVE_TEST_PROFILE === "1";
const primaryLocation = resolvePrimaryEdgeProfile(process.env);
const profileRoot = temporaryProfile ? path.join(runtimeRoot, "edge-profiles") : primaryLocation.profileRoot;
const profileDir = temporaryProfile ? path.resolve(process.env.CODEX_BROWSER_EDGE_PROFILE_DIR!) : primaryLocation.profileDir;
const firstRun = !existsSync(profileDir);
const productRoot = path.dirname(primaryLocation.profileRoot);
const dataRoot = temporaryProfile ? path.join(profileDir, "codex-browser-data") : path.join(productRoot, "data");
const downloadsDir = path.join(dataRoot, "downloads");
const libraryDir = path.join(dataRoot, "library");
const pipeName = (process.env.CODEX_BROWSER_PIPE_NAME || "codex-browser-v1")
  .trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80) || "codex-browser-v1";
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;

let pipeServer: Server | null = null;
const pipeSockets = new Set<Socket>();
let shuttingDown = false;
let controlCenterProcess: ChildProcess | null = null;
let paused = false;
let operationGeneration = 0;
let currentAction = "等待任务";
let runtimeStatus: AppState["runtimeStatus"] = "idle";
let browserStoppedByUser = false;
let recoveryInFlight: Promise<void> | null = null;
let lastRecoveryAttemptAt = 0;
const tasks: TaskItem[] = [];
const brokerCandidates = new Map<string, { tabId: string; adapterCandidateId?: string; source: "link" | "loaded_pdf" }>();
const tabStates = new TabStateController();
const assistanceCoordinator = new AssistanceCoordinator();
const assistanceBaselines = new Map<string, BrowserChallengeEvidence>();
const notifiedAssistanceIds = new Set<string>();
const dataConfirmations = new BrowserDataConfirmationStore();
const actionAuthorizations = new ActionAuthorizationStore();
const pendingConfirmedActions = new Map<string, { action: BrowserAction; task: TaskItem; policy: PolicyResult }>();
let runtimeSettings = loadRuntimeSettings(productRoot);
const extensionRelay = new ExtensionRelayServer(productRoot, Number(process.env.CODEX_BROWSER_RELAY_PORT || 32192));
if (!temporaryProfile) await extensionRelay.start();
let activeRuntimeKind: "external-edge" | "edge-extension" = "external-edge";
const createRuntime = (): BrowserRuntime<EdgeBrowserAdapter> => {
  activeRuntimeKind = runtimeSettings.preferredRuntime === "edge-extension" && !temporaryProfile ? "edge-extension" : "external-edge";
  return activeRuntimeKind === "edge-extension"
    ? new ExtensionRelayRuntime(extensionRelay, downloadsDir)
    : new EdgePrototypeRuntime({ runtimeRoot, profileRoot, profileDir, downloadsDir });
};

let runtime = createRuntime();
if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] runtime-start");
let connection = await runtime.start();
if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] runtime-ready");
let adapter: EdgeBrowserAdapter = connection.adapter;
const documentService = new DocumentService(libraryDir);
await documentService.initialize();
if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] documents-ready");

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function requireAutomation(): void {
  if (paused) throw namedError("PAUSED_BY_USER", "Codex browser control is paused by the user.");
}

function createTask(label: string, detail: string, status: TaskStatus = "running"): TaskItem {
  const now = new Date().toISOString();
  const task = { id: randomUUID(), label, detail: sanitizeSensitiveText(detail, 1_000), status, createdAt: now, updatedAt: now };
  tasks.unshift(task);
  if (tasks.length > 80) tasks.length = 80;
  return task;
}

function updateTask(task: TaskItem, status: TaskStatus, detail?: string): void {
  task.status = status;
  task.detail = sanitizeSensitiveText(detail, 1_000);
  task.updatedAt = new Date().toISOString();
}

function begin(action: string, tabId?: string): number {
  requireAutomation();
  if (tabId) tabStates.assertMutationAllowed(tabId);
  runtimeStatus = "running";
  currentAction = action;
  return operationGeneration;
}

function assertGeneration(generation: number): void {
  if (generation !== operationGeneration) throw namedError("TASK_STOPPED", "The browser task was stopped before completion.");
}

function finish(action = "等待任务"): void {
  runtimeStatus = "idle";
  currentAction = action;
}

function exposeTab(tab: BrowserTabSummary): BrowserTabSummary {
  let state = tab.state;
  try { state = tabStates.get(tab.id).state; } catch {}
  return { ...tab, state, attention: assistanceCoordinator.getByTab(tab.id) ? "assistance" : tab.attention, url: sanitizeUrlForExposure(tab.url) };
}

async function syncTabStates(): Promise<void> {
  const tabs = await adapter.listTabs();
  const live = new Set(tabs.tabs.map((tab) => tab.id));
  for (const tab of tabs.tabs) {
    try { tabStates.get(tab.id); } catch { tabStates.register(tab.id); }
  }
  for (const registered of tabStates.list()) if (!live.has(registered.tabId)) tabStates.remove(registered.tabId);
}

async function startManagedEdge(reason: string): Promise<void> {
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    const now = Date.now();
    if (now - lastRecoveryAttemptAt < 2_000) throw namedError("BROWSER_RECOVERY_COOLDOWN", "The managed Edge recovery is cooling down. Retry shortly.");
    lastRecoveryAttemptAt = now;
    runtimeStatus = "running"; currentAction = reason;
    actionAuthorizations.markExecutingOutcomeUnknown("Browser connection was lost; result requires user review");
    actionAuthorizations.cancelAll("Browser restarted");
    actionAuthorizations.clearGrants();
    pendingConfirmedActions.clear();
    assistanceCoordinator.cancelAll("Browser restarted"); assistanceBaselines.clear();
    await runtime.shutdown({ graceful: true }).catch(() => undefined);
    runtime = createRuntime();
    connection = await runtime.start(); adapter = connection.adapter;
    for (const registered of tabStates.list()) tabStates.remove(registered.tabId);
    await syncTabStates();
    browserStoppedByUser = false; finish("受管 Edge 已恢复，旧页面引用已失效");
  })().finally(() => { recoveryInFlight = null; });
  return recoveryInFlight;
}

async function ensureManagedEdgeReady(): Promise<void> {
  const status = await runtime.status();
  if (status.state === "ready") return;
  if (browserStoppedByUser) throw namedError("BROWSER_STOPPED", "The managed Edge browser was stopped by the user. Start it from the control center, then retry.");
  if (status.managed) {
    try {
      runtimeStatus = "running"; currentAction = "正在重新连接受管 Edge";
      actionAuthorizations.markExecutingOutcomeUnknown("Browser connection was lost; result requires user review");
      actionAuthorizations.cancelAll("Browser reconnected");
      actionAuthorizations.clearGrants();
      pendingConfirmedActions.clear();
      assistanceCoordinator.cancelAll("Browser reconnected"); assistanceBaselines.clear();
      connection = await runtime.attach(); adapter = connection.adapter;
      await syncTabStates();
      finish("受管 Edge 已重新连接，旧页面引用已失效");
      return;
    } catch {
      // The owned process may be exiting; the bounded restart path below confirms cleanup.
    }
  }
  await startManagedEdge("正在恢复受管 Edge");
}

function safeDomain(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return "current site"; }
}

function ensureControlCenter(): void {
  if (controlCenterProcess && controlCenterProcess.exitCode === null) return;
  const executable = process.platform === "win32"
    ? path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe")
    : path.join(projectRoot, "node_modules", ".bin", "electron");
  const entry = path.join(projectRoot, "dist", "electron", "edge-control-center.js");
  controlCenterProcess = spawn(executable, [entry], {
    cwd: projectRoot, windowsHide: false, stdio: "ignore",
    env: { ...process.env, CODEX_BROWSER_PROJECT_ROOT: projectRoot, CODEX_BROWSER_PIPE_NAME: pipeName },
  });
  controlCenterProcess.once("exit", () => { controlCenterProcess = null; });
  controlCenterProcess.once("error", () => { controlCenterProcess = null; });
}

async function detectAndFreeze(tabId: string, task?: TaskItem, expectedTarget?: string): Promise<HumanAssistance | null> {
  const evidence = await adapter.collectChallengeEvidence(tabId, expectedTarget).catch(() => null);
  if (!evidence) return null;
  const detection = detectChallenge(evidence);
  if (!shouldFreezeForChallenge(detection) || !detection.assistanceKind || !detection.verificationStrategy) return null;
  const result = assistanceCoordinator.request({
    tabId, taskId: task?.id || createTask("User action required", detection.sanitizedReason, "waiting_user").id,
    kind: detection.assistanceKind, domain: safeDomain(evidence.mainFrameUrl),
    title: detection.kind === "cloudflare" ? "Complete site verification" : detection.kind === "passkey" ? "Complete passkey verification" : detection.kind === "captcha" ? "Complete CAPTCHA" : "Complete authentication",
    detail: detection.sanitizedReason, url: evidence.mainFrameUrl, verificationStrategy: detection.verificationStrategy,
  });
  if (result.created) assistanceBaselines.set(result.assistance.id, evidence);
  try { tabStates.transition(tabId, "WAITING_USER"); } catch {}
  if (task) updateTask(task, "waiting_user", result.assistance.detail);
  runtimeStatus = "waiting_user";
  currentAction = "等待用户完成浏览器操作";
  if (result.created && !notifiedAssistanceIds.has(result.assistance.id)) {
    notifiedAssistanceIds.add(result.assistance.id);
    await adapter.selectTab(tabId).catch(() => undefined);
    await adapter.show().catch(() => undefined);
    ensureControlCenter();
  }
  return result.assistance;
}

async function resolveTabId(value: unknown): Promise<string> {
  await syncTabStates();
  const tabs = await adapter.listTabs();
  const requested = typeof value === "string" && value ? value : tabs.activeTabId;
  if (!requested || !tabs.tabs.some((tab) => tab.id === requested)) throw namedError("TAB_NOT_FOUND", "The requested Edge tab was not found.");
  return requested;
}

function edgeProfileStatus(state: BrowserProfileStatus["state"] = "ready", detail = "Dedicated Edge profile is available."): BrowserProfileStatus {
  return {
    id: "primary", label: temporaryProfile ? "Isolated Edge test profile" : "Codex Browser Edge primary",
    state, persistent: !temporaryProfile, browserManagedPasswords: true, syncEnabledByProject: false,
    detail, checkedAt: new Date().toISOString(),
  };
}

async function edgeStorageSummary(tabId?: string): Promise<BrowserStorageSummary> {
  return adapter.getStorageSummary(tabId || (await adapter.listTabs()).activeTabId);
}

function safeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return "current-site"; }
}

function releasePolicyTab(tabId: string): void {
  const current = tabStates.get(tabId).state;
  if (current === "WAITING_USER") tabStates.transition(tabId, "VERIFYING");
  if (tabStates.get(tabId).state === "VERIFYING" || tabStates.get(tabId).state === "ERROR") tabStates.transition(tabId, "READY");
}

async function evaluateActionPolicy(tabId: string, action: BrowserAction, taskId?: string, requestedCategory?: PolicyResult["category"], approvedConfirmation = false): Promise<{ policy: PolicyResult; origin: string }> {
  const context = await adapter.getActionPolicyContext(tabId, action);
  const grants = actionAuthorizations.matchingGrants("primary", context.origin, tabId, taskId);
  const policy = evaluatePolicy({
    action: action.action, tabId, origin: context.origin, sanitizedUrl: context.sanitizedUrl,
    snapshotRevision: action.revision, element: context.element, form: context.form, page: context.page,
    targetOrigin: context.targetOrigin, tabState: tabStates.get(tabId).state,
    assistanceActive: Boolean(assistanceCoordinator.getByTab(tabId)),
    grantCategories: grants.map((grant) => grant.category), requestedCategory, approvedConfirmation,
  });
  actionAuthorizations.recordEvaluation({ origin: context.origin, tabId, taskId }, policy);
  return { policy, origin: context.origin };
}

async function respondActionConfirmation(id: string, response: "allow_once" | "allow_temporary" | "deny"): Promise<BrowserActionConfirmation> {
  actionAuthorizations.get(id);
  const pending = pendingConfirmedActions.get(id);
  if (!pending) throw namedError("CONFIRMATION_STALE", "The confirmed browser action is stale or unavailable.");
  if (response === "deny") {
    const denied = actionAuthorizations.deny(id);
    pendingConfirmedActions.delete(id);
    try { releasePolicyTab(denied.tabId); } catch {}
    updateTask(pending.task, "error", "用户拒绝了高风险操作");
    return denied;
  }
  if (response === "allow_temporary" && (!canRememberGrant(pending.policy.category) || !pending.policy.grantEligible)) {
    throw namedError("GRANT_NOT_ALLOWED", "This high-risk action cannot receive a temporary grant.");
  }
  actionAuthorizations.approve(id);
  const executing = actionAuthorizations.beginExecution(id);
  try { tabStates.transition(executing.tabId, "VERIFYING"); } catch {}
  try {
    const current = await evaluateActionPolicy(executing.tabId, pending.action, pending.task.id, executing.category, true);
    if (current.origin !== executing.origin || current.policy.decision !== "allow_redacted" || pending.action.revision !== executing.snapshotRevision || (!("ref" in pending.action) || pending.action.ref !== executing.targetRef)) {
      actionAuthorizations.finish(id, "failed", "Page context changed before execution");
      throw namedError("STALE_CONFIRMATION", "The page or target changed after confirmation. Capture a new snapshot and request confirmation again.");
    }
    const result = await adapter.act(executing.tabId, pending.action);
    const completed = actionAuthorizations.finish(id, "completed", "Confirmed action executed once");
    pendingConfirmedActions.delete(id);
    if (response === "allow_temporary") {
      actionAuthorizations.createGrant({ profileId: "primary", origin: executing.origin, category: executing.category, tabId: executing.tabId });
    }
    try { tabStates.transition(executing.tabId, "READY"); } catch {}
    updateTask(pending.task, "done", result.description);
    finish("已确认的操作执行完成");
    return completed;
  } catch (error) {
    const current = actionAuthorizations.get(id);
    if (current.status === "executing") {
      const uncertain = !["STALE_SNAPSHOT", "REF_NOT_FOUND", "INVALID_ACTION", "STALE_CONFIRMATION"].includes((error as Error).name);
      actionAuthorizations.finish(id, uncertain ? "outcome_unknown" : "failed", uncertain ? "Execution outcome requires user review" : "Execution was rejected before a trusted action");
    }
    pendingConfirmedActions.delete(id);
    try { tabStates.transition(executing.tabId, "ERROR"); } catch {}
    updateTask(pending.task, "error", uncertainActionMessage(error));
    throw error;
  }
}

function uncertainActionMessage(error: unknown): string {
  return ["STALE_SNAPSHOT", "REF_NOT_FOUND", "INVALID_ACTION", "STALE_CONFIRMATION"].includes((error as Error)?.name)
    ? "确认后页面发生变化，操作未执行"
    : "操作结果不确定，需要用户检查；系统不会自动重试";
}

async function resetEdgeProfile(): Promise<BrowserStorageSummary> {
  if (activeRuntimeKind === "edge-extension") throw namedError("UNAVAILABLE_IN_RELAY", "The user's ordinary Edge profile cannot be reset by Codex Browser.");
  runtimeStatus = "paused";
  paused = true;
  currentAction = "正在重置专用 Edge Profile";
  operationGeneration += 1;
  tabStates.stopAll();
  assistanceCoordinator.cancelAll("Profile reset");
  actionAuthorizations.cancelAll("Profile reset");
  actionAuthorizations.clearGrants();
  pendingConfirmedActions.clear();
  assistanceBaselines.clear();
  await runtime.shutdown({ graceful: true });
  const archivedProfile = archiveOwnedEdgeProfile(profileDir, profileRoot);
  runtime = createRuntime();
  try {
    connection = await runtime.start();
    adapter = connection.adapter;
    if (temporaryProfile) removeArchivedEdgeProfile(archivedProfile, profileRoot);
  } catch (error) {
    paused = true;
    runtimeStatus = "error";
    currentAction = "专用 Edge Profile 重置失败；旧 Profile 已安全归档，可从控制中心恢复";
    throw error;
  }
  paused = false;
  runtimeStatus = "idle";
  currentAction = "专用 Edge Profile 已重置";
  await syncTabStates();
  return edgeStorageSummary();
}

async function state(): Promise<AppState> {
  await syncTabStates();
  const tabs = await adapter.listTabs();
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId) || tabs.tabs[0];
  const dialogs = (await adapter.listDialogs()).map(exposeDialog);
  const downloads = adapter.getDownloads().map(exposeDownload);
  const documents = documentService.list();
  const browserStorage = await edgeStorageSummary(active?.id).catch(() => ({
    origin: "", cookieCount: 0, sessionCookieCount: 0, sessionRecoveryEnabled: false,
    sessionRecoveryAvailable: false, checkedAt: new Date().toISOString(),
  } satisfies BrowserStorageSummary));
  const managedStatus = await runtime.status();
  const connectionState = managedStatus.state === "ready" ? "ready"
    : managedStatus.state === "starting" ? "starting"
      : managedStatus.state === "connecting" ? "connecting"
        : managedStatus.state === "stopped" ? "stopped" : "error";
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    browserState: paused ? "PAUSED_BY_USER" : active ? tabStates.get(active.id).state : "READY",
    runtimeStatus: paused ? "paused" : runtimeStatus,
    currentAction: sanitizeSensitiveText(currentAction, 500) || "等待任务",
    url: sanitizeUrlForExposure(active?.url || ""),
    title: sanitizeSensitiveText(active?.title, 500) || "Microsoft Edge",
    isLoading: active?.isLoading || false,
    canGoBack: active?.canGoBack || false,
    canGoForward: active?.canGoForward || false,
    profileId: "primary",
    profileLabel: activeRuntimeKind === "edge-extension" ? "用户普通 Edge Profile" : temporaryProfile ? "Edge 隔离测试 Profile" : "Edge 专用长期 Profile",
    tabs: tabs.tabs.map(exposeTab),
    activeTabId: tabs.activeTabId,
    authPrompt: null,
    assistance: active ? assistanceCoordinator.getByTab(active.id) : null,
    dialogs,
    sessionHealth: {
      status: "unknown",
      detail: "Edge session health uses aggregate browser storage counts; credential inspection is disabled.",
      cookieCount: browserStorage.cookieCount,
      sessionCookieCount: browserStorage.sessionCookieCount,
      encryptedBackupAvailable: browserStorage.sessionRecoveryAvailable,
      checkedAt: browserStorage.checkedAt,
    },
    storage: { taskCount: tasks.length, downloadCount: downloads.length, documentCount: documents.length },
    browserStorage,
    profileStatus: activeRuntimeKind === "edge-extension"
      ? { id: "ordinary-edge", label: "用户普通 Edge Profile", state: extensionRelay.connected() ? "ready" : "error", persistent: true, browserManagedPasswords: true, syncEnabledByProject: false, detail: "Profile and credentials remain owned by the user's ordinary Edge.", checkedAt: new Date().toISOString() }
      : edgeProfileStatus(),
    actionConfirmations: actionAuthorizations.list(),
    rememberedGrants: actionAuthorizations.listGrants(),
    policyAudit: actionAuthorizations.auditEntries(),
    runtimeInfo: {
      kind: activeRuntimeKind,
      label: activeRuntimeKind === "edge-extension" ? "Microsoft Edge（用户 Profile 扩展中继）" : "Microsoft Edge（独立运行时）",
      browserVersion: managedStatus.browserVersion,
      connection: connectionState,
      legacy: false,
      detail: sanitizeSensitiveText(managedStatus.detail, 500) || "受管 Edge 已就绪",
      firstRun: firstRun && !temporaryProfile && activeRuntimeKind !== "edge-extension",
    },
    runtimeSettings: { ...runtimeSettings },
    edgeRelay: extensionRelay.status(),
    tasks: tasks.map((task) => ({ ...task, detail: sanitizeSensitiveText(task.detail, 1_000) })),
    downloads,
    documents,
  };
}

function exposeDialog(dialog: BrowserDialogPrompt): BrowserDialogPrompt {
  return { ...dialog, message: sanitizeSensitiveText(dialog.message, 2_000) || "Webpage dialog", defaultValue: undefined, url: sanitizeUrlForExposure(dialog.url) };
}

function exposeDownload(download: DownloadItem): DownloadItem {
  return { ...download, path: undefined, url: sanitizeUrlForExposure(download.url) };
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  const browserDependent = method.startsWith("browser.") && ![
    "browser.capabilities", "browser.status", "browser.profile_status", "browser.confirmation_status",
    "browser.confirmation_respond", "browser.grants_list", "browser.grant_revoke",
  ].includes(method);
  if (browserDependent) await ensureManagedEdgeReady();
  switch (method) {
    case "browser.capabilities":
      return { runtime: activeRuntimeKind, visible: true, tabs: true, snapshots: true, actions: true, waits: true, screenshots: true, dialogs: true, downloads: activeRuntimeKind !== "edge-extension", documents: true };
    case "browser.status":
      return state();
    case "browser.storage_summary":
      return edgeStorageSummary(params.tabId ? await resolveTabId(params.tabId) : undefined);
    case "browser.profile_status":
      return edgeProfileStatus();
    case "runtime.show_browser":
      if ((await runtime.status()).state !== "ready") await startManagedEdge("正在启动受管 Edge");
      await runtime.show(); return { ok: true };
    case "runtime.show_control_center":
      ensureControlCenter(); return { ok: true };
    case "runtime.restart_browser": {
      operationGeneration += 1;
      assistanceCoordinator.cancelAll("Browser restarted");
      actionAuthorizations.cancelAll("Browser restarted");
      pendingConfirmedActions.clear();
      runtimeStatus = "running"; currentAction = "正在重启受管 Edge";
      await runtime.shutdown({ graceful: true });
      runtime = createRuntime();
      connection = await runtime.start(); adapter = connection.adapter;
      await syncTabStates(); finish("受管 Edge 已重启");
      browserStoppedByUser = false;
      return state();
    }
    case "runtime.shutdown_browser":
      operationGeneration += 1;
      actionAuthorizations.cancelAll("Browser stopped"); pendingConfirmedActions.clear();
      await runtime.shutdown({ graceful: true }); runtimeStatus = "idle"; currentAction = "受管 Edge 已停止";
      browserStoppedByUser = true;
      return { ok: true };
    case "runtime.settings":
      return { ...runtimeSettings };
    case "runtime.relay_status":
      return extensionRelay.status();
    case "runtime.relay_begin_pairing":
      return extensionRelay.beginPairing();
    case "runtime.test_diagnostics":
      if (process.env.CODEX_BROWSER_TEST_MODE !== "1") throw namedError("TEST_MODE_REQUIRED", "Runtime diagnostics are available only to isolated release tests.");
      return adapter.diagnostics();
    case "runtime.update_settings":
      runtimeSettings = updateRuntimeSettings(runtimeSettings, params as Partial<BrowserRuntimeSettings>, productRoot);
      return { ...runtimeSettings };
    case "runtime.control_center_closed":
      if (!runtimeSettings.keepEdgeRunningOnControlCenterClose) setImmediate(() => void shutdown());
      return { ok: true };
    case "browser.tabs": {
      const result = await adapter.listTabs();
      return { activeTabId: result.activeTabId, tabs: result.tabs.map(exposeTab) };
    }
    case "browser.tab_new": {
      requireAutomation();
      const result = await adapter.createTab({ url: params.url ? String(params.url) : "about:blank", activate: params.activate !== false });
      await syncTabStates();
      return { activeTabId: result.activeTabId, createdTabId: result.createdTabId, tabs: result.tabs.map(exposeTab) };
    }
    case "browser.tab_select": {
      const result = await adapter.selectTab(await resolveTabId(params.tabId));
      return { activeTabId: result.activeTabId, tabs: result.tabs.map(exposeTab) };
    }
    case "browser.tab_close": {
      requireAutomation();
      const tabId = await resolveTabId(params.tabId);
      tabStates.assertMutationAllowed(tabId);
      const result = await adapter.closeTab(tabId, { force: params.force === true });
      tabStates.remove(tabId);
      return { activeTabId: result.activeTabId, tabs: result.tabs.map(exposeTab) };
    }
    case "browser.navigate": {
      const tabId = await resolveTabId(params.tabId);
      const generation = begin("打开网页", tabId);
      const task = createTask("打开网页", sanitizeUrlForExposure(String(params.url || "")) || "受保护页面");
      try {
        await adapter.navigate(tabId, String(params.url || ""));
        assertGeneration(generation);
        const info = await adapter.refreshTabInfo(tabId);
        const assistance = await detectAndFreeze(tabId, task, String(params.url || ""));
        if (assistance) return { tabId, url: sanitizeUrlForExposure(info.url), assistance };
        updateTask(task, "done", info.title);
        finish("页面已就绪");
        return { tabId, url: sanitizeUrlForExposure(info.url), authPrompt: null };
      } catch (error) {
        if (error instanceof Error && error.name === "NAVIGATION_RESPONSE_TIMEOUT") {
          const assistance = await detectAndFreeze(tabId, task, String(params.url || ""));
          if (assistance) {
            const info = await adapter.refreshTabInfo(tabId).catch(() => adapter.getTabInfo(tabId));
            return { tabId, url: sanitizeUrlForExposure(info.url), assistance };
          }
        }
        updateTask(task, "error", (error as Error).message);
        throw error;
      }
    }
    case "browser.observe": {
      const tabId = await resolveTabId(params.tabId);
      const result = await adapter.observe(tabId, { maxCharacters: Number(params.maxCharacters || 30_000) });
      await detectAndFreeze(tabId);
      return { ...result, title: sanitizeSensitiveText(result.title, 500), text: sanitizeSensitiveText(result.text, 100_000), url: sanitizeUrlForExposure(result.url), links: result.links.map((link) => ({ text: sanitizeSensitiveText(link.text, 500) || "", href: sanitizeUrlForExposure(link.href) })), forms: result.forms.map((form) => ({ ...form, action: sanitizeUrlForExposure(form.action) })) };
    }
    case "browser.snapshot": {
      const tabId = await resolveTabId(params.tabId);
      const result = await adapter.snapshot(tabId, { maxElements: Number(params.maxElements || 140), maxTextCharacters: Number(params.maxTextCharacters || 24_000) });
      await detectAndFreeze(tabId);
      return { ...result, title: sanitizeSensitiveText(result.title, 500), text: sanitizeSensitiveText(result.text, 100_000), url: sanitizeUrlForExposure(result.url), elements: result.elements.map((element) => ({ ...element, href: element.href ? sanitizeUrlForExposure(element.href) : undefined, value: element.sensitive ? undefined : sanitizeSensitiveText(element.value, 500), name: element.sensitive ? (element.role === "button" ? "Sensitive action" : "Sensitive input") : sanitizeSensitiveText(element.name, 240), text: element.sensitive ? "" : sanitizeSensitiveText(element.text, 500), placeholder: element.sensitive ? undefined : sanitizeSensitiveText(element.placeholder, 500) })) };
    }
    case "browser.act": {
      const tabId = await resolveTabId(params.tabId);
      const generation = begin("执行页面动作", tabId);
      const task = createTask("执行页面动作", "页面元素引用已隐藏");
      try {
        const evaluated = await evaluateActionPolicy(tabId, params as unknown as BrowserAction, task.id);
        if (evaluated.policy.decision === "deny_manual") {
          updateTask(task, "waiting_user", evaluated.policy.summary);
          throw namedError("USER_ACTION_REQUIRED", evaluated.policy.impact);
        }
        if (evaluated.policy.decision === "confirm") {
          const action = params as unknown as BrowserAction;
          if (!("ref" in action) || !action.ref || action.revision == null) throw namedError("SNAPSHOT_REQUIRED", "High-risk actions require a current snapshot revision and target reference.");
          const confirmation = actionAuthorizations.request({ tabId, taskId: task.id, origin: evaluated.origin, revision: action.revision, ref: action.ref, policy: evaluated.policy });
          pendingConfirmedActions.set(confirmation.id, { action, task, policy: evaluated.policy });
          try { tabStates.transition(tabId, "WAITING_USER"); } catch {}
          updateTask(task, "waiting_user", confirmation.summary);
          runtimeStatus = "waiting_user"; currentAction = "等待用户确认高风险操作";
          await adapter.selectTab(tabId).catch(() => undefined); await adapter.show().catch(() => undefined); ensureControlCenter();
          return { confirmation };
        }
        const result = await adapter.act(tabId, params as unknown as BrowserAction);
        assertGeneration(generation);
        updateTask(task, "done", result.description);
        finish("页面动作已完成");
        return { ...result, ref: undefined, url: sanitizeUrlForExposure(result.url), title: sanitizeSensitiveText(result.title, 500) };
      } catch (error) {
        updateTask(task, "error", (error as Error).message);
        throw error;
      }
    }
    case "browser.wait": {
      const tabId = await resolveTabId(params.tabId);
      const generation = begin("等待页面条件");
      const result = await adapter.wait(tabId, { condition: params.condition as never, value: params.value == null ? undefined : String(params.value), timeoutMs: Number(params.timeoutMs || 10_000) });
      if (result.status !== "cancelled") assertGeneration(generation);
      finish(result.satisfied ? "等待条件已满足" : result.status === "cancelled" ? "等待已取消" : "等待条件超时");
      return { ...result, url: sanitizeUrlForExposure(result.url), title: sanitizeSensitiveText(result.title, 500) };
    }
    case "browser.back":
    case "browser.forward":
    case "browser.reload": {
      const tabId = await resolveTabId(params.tabId);
      const generation = begin(method, tabId);
      if (method === "browser.back") await adapter.back(tabId);
      else if (method === "browser.forward") await adapter.forward(tabId);
      else await adapter.reload(tabId);
      assertGeneration(generation);
      finish("页面已就绪");
      return { ok: true };
    }
    case "browser.screenshot": {
      const tabId = await resolveTabId(params.tabId);
      const screenshot = await adapter.screenshot(tabId, { scope: params.scope === "element" ? "element" : "viewport", ref: params.ref ? String(params.ref) : undefined, maxWidth: Number(params.maxWidth || 1600), redactSensitive: true });
      return { data: Buffer.from(screenshot.bytes).toString("base64"), mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height, redactionCount: screenshot.redactionCount, title: sanitizeSensitiveText(screenshot.title, 500), url: sanitizeUrlForExposure(screenshot.url) };
    }
    case "browser.dialogs":
      return { dialogs: (await adapter.listDialogs(params.tabId ? await resolveTabId(params.tabId) : undefined)).map(exposeDialog) };
    case "browser.dialog_respond": {
      const dialogs = await adapter.listDialogs();
      const dialog = dialogs.find((candidate) => candidate.id === String(params.dialogId || ""));
      if (!dialog) throw namedError("STALE_DIALOG", "The browser dialog is stale or missing.");
      await adapter.respondDialog(dialog.tabId, { dialogId: dialog.id, accept: params.accept === true, promptText: params.promptText == null ? undefined : String(params.promptText) });
      return { handled: true, dialogs: (await adapter.listDialogs()).map(exposeDialog) };
    }
    case "browser.pause":
      paused = true;
      runtimeStatus = "paused";
      currentAction = "Codex 控制已暂停";
      return { ok: true };
    case "browser.resume":
      paused = false;
      finish("Codex 控制已恢复");
      return { ok: true };
    case "browser.stop": {
      operationGeneration += 1;
      tabStates.stopAll();
      assistanceCoordinator.cancelAll();
      actionAuthorizations.cancelAll();
      pendingConfirmedActions.clear();
      assistanceBaselines.clear();
      const tabs = await adapter.listTabs();
      await Promise.all(tabs.tabs.map((tab) => adapter.stop(tab.id).catch(() => undefined)));
      for (const tab of tabs.tabs) {
        try {
          const current = tabStates.get(tab.id).state;
          if (current === "WAITING_USER" || current === "VERIFYING") tabStates.transition(tab.id, "ERROR");
          if (tabStates.get(tab.id).state === "ERROR") tabStates.transition(tab.id, "READY");
        } catch {}
      }
      for (const task of tasks) if (["queued", "running", "waiting_user"].includes(task.status)) updateTask(task, "error", "已由用户停止");
      finish("任务已停止");
      return { ok: true };
    }
    case "paper.find_downloads": {
      const tabId = await resolveTabId(params.tabId);
      brokerCandidates.clear();
      const results: Array<{ id: string; text: string; url: string; source: "link" | "loaded_pdf" }> = [];
      if (adapter.getLoadedPdf(tabId)) {
        const id = `cb-download-${randomUUID()}`;
        brokerCandidates.set(id, { tabId, source: "loaded_pdf" });
        results.push({ id, text: "当前浏览器中已加载的 PDF", url: sanitizeUrlForExposure(adapter.getTabInfo(tabId).url), source: "loaded_pdf" });
      }
      for (const link of await adapter.findDownloadLinks(tabId).catch(() => [])) {
        const id = `cb-download-${randomUUID()}`;
        brokerCandidates.set(id, { tabId, adapterCandidateId: link.url, source: "link" });
        results.push({ id, text: sanitizeSensitiveText(link.text, 500) || "Download", url: sanitizeUrlForExposure(adapter.getTabInfo(tabId).url), source: "link" });
      }
      return results;
    }
    case "paper.download": {
      if (activeRuntimeKind === "edge-extension") throw namedError("UNAVAILABLE_IN_RELAY", "Managed download and PDF import are unavailable in ordinary Edge relay mode. Use Edge's visible download UI or switch to external-edge.");
      const tabId = await resolveTabId(params.tabId);
      const generation = begin("下载文件");
      const task = createTask("下载文件", "受管 Edge 下载");
      const candidate = params.candidateId ? brokerCandidates.get(String(params.candidateId)) : undefined;
      if (params.candidateId && (!candidate || candidate.tabId !== tabId)) throw new Error("The download candidate is stale. Call paper_find_downloads again.");
      const result = await adapter.startDownload(tabId, { url: params.url ? String(params.url) : undefined, candidateId: candidate?.adapterCandidateId });
      const filePath = await adapter.waitForDownload(result.jobId);
      assertGeneration(generation);
      if (!filePath) throw new Error("The managed Edge download did not complete.");
      let documentId: string | undefined;
      const signature = (await fs.readFile(filePath)).subarray(0, 5).toString("ascii");
      if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error(`[edge-broker] download-signature=${signature}`);
      if (signature === "%PDF-") {
        runtimeStatus = "parsing";
        const document = await documentService.importPdf(filePath, result.url);
        assertGeneration(generation);
        documentId = document.id;
      }
      updateTask(task, "done", documentId ? "PDF 已保存并导入" : "下载已完成");
      finish("下载已完成");
      return { ...result, documentId, url: sanitizeUrlForExposure(result.url) };
    }
    case "downloads.list":
      return adapter.getDownloads().map(exposeDownload);
    case "document.import": {
      const generation = begin("导入 PDF");
      const document = await documentService.importPdf(String(params.path || ""));
      assertGeneration(generation);
      finish("PDF 已进入文献库");
      return document;
    }
    case "document.list":
      return documentService.list();
    case "document.read":
      return documentService.read(String(params.documentId || ""), Number(params.startPage || 1), params.endPage == null ? undefined : Number(params.endPage));
    case "document.search":
      return documentService.search(String(params.query || ""), params.documentId ? String(params.documentId) : undefined, Number(params.limit || 20));
    case "session.check": {
      const tabId = await resolveTabId(params.tabId);
      const assistance = await detectAndFreeze(tabId);
      const summary = await edgeStorageSummary(tabId);
      return { status: assistance ? "attention" : "healthy", detail: assistance ? assistance.detail : "No challenge or authentication boundary is currently detected.", cookieCount: summary.cookieCount, sessionCookieCount: summary.sessionCookieCount, encryptedBackupAvailable: false, checkedAt: summary.checkedAt };
    }
    case "storage.summary":
      return edgeStorageSummary(params.tabId ? await resolveTabId(params.tabId) : undefined);
    case "storage.request_action": {
      if (activeRuntimeKind === "edge-extension") throw namedError("UNAVAILABLE_IN_RELAY", "Codex Browser cannot clear or reset the user's ordinary Edge profile. Use Edge settings directly.");
      const action = String(params.action || "") as BrowserDataAction;
      if (!["clear_site", "clear_all", "reset_profile"].includes(action)) throw namedError("INVALID_DATA_ACTION", "Unsupported browser data action.");
      const tabId = action === "clear_site" ? await resolveTabId(params.tabId) : undefined;
      const scope = action === "clear_site" ? safeDomain(adapter.getTabInfo(tabId!).url) : action === "reset_profile" ? "primary" : "all-sites";
      return dataConfirmations.request(action, scope, params.includePermissions === true);
    }
    case "storage.confirm_action": {
      const confirmation = dataConfirmations.consume(String(params.confirmationId || ""));
      paused = true;
      runtimeStatus = "paused";
      currentAction = "正在处理浏览器数据";
      try {
        if (confirmation.action === "clear_site") {
          const tabs = await adapter.listTabs();
          const tab = tabs.tabs.find((candidate) => safeDomain(candidate.url) === confirmation.scope);
          if (!tab) throw namedError("CONFIRMATION_STALE", "The confirmed website is no longer open.");
          await adapter.clearSiteData(tab.id, { includePermissions: confirmation.includePermissions });
          await adapter.reload(tab.id).catch(() => undefined);
          return edgeStorageSummary(tab.id);
        }
        if (confirmation.action === "clear_all") {
          actionAuthorizations.cancelAll("All browser data cleared");
          actionAuthorizations.clearGrants();
          pendingConfirmedActions.clear();
          await adapter.clearAllBrowserData();
          return edgeStorageSummary();
        }
        return resetEdgeProfile();
      } finally {
        paused = false;
        if (runtimeStatus === "paused") runtimeStatus = "idle";
        currentAction = "浏览器数据操作已完成";
      }
    }
    case "storage.session_recovery":
      if (params.enabled === true) throw namedError("UNSUPPORTED_SESSION_RECOVERY", "External Edge uses normal browser session semantics and does not enable custom session Cookie recovery.");
      return edgeStorageSummary();
    case "browser.confirmation_status":
      return params.confirmationId ? actionAuthorizations.get(String(params.confirmationId)) : actionAuthorizations.list();
    case "browser.confirmation_respond":
      if (params.response !== "deny") throw namedError("TRUSTED_UI_REQUIRED", "Only the Electron control center can approve a high-risk browser action.");
      return respondActionConfirmation(String(params.confirmationId || ""), "deny");
    case "browser.grants_list":
      return actionAuthorizations.listGrants();
    case "browser.grant_revoke":
      actionAuthorizations.revokeGrant(String(params.grantId || "")); return { ok: true };
    case "policy.respond_confirmation":
      return respondActionConfirmation(String(params.confirmationId || ""), String(params.response || "deny") as "allow_once" | "allow_temporary" | "deny");
    case "policy.clear_audit":
      actionAuthorizations.clearAudit(); return { ok: true };
    case "auth.request_login": {
      const tabId = await resolveTabId(params.tabId);
      const generation = begin("打开登录页面", tabId);
      await adapter.navigate(tabId, String(params.url || ""));
      assertGeneration(generation);
      const task = createTask("Complete authentication", "Authentication must be completed in the visible Edge window.", "waiting_user");
      return detectAndFreeze(tabId, task, String(params.url || ""));
    }
    case "browser.assistance_request": {
      const tabId = await resolveTabId(params.tabId);
      const evidence = await adapter.collectChallengeEvidence(tabId);
      const safeTitle = sanitizeSensitiveText(String(params.title || "User action required"), 120) || "User action required";
      const safeDetail = sanitizeSensitiveText(String(params.detail || "Complete the step in the visible browser."), 1_000) || "Complete the step in the visible browser.";
      const task = createTask(safeTitle, safeDetail, "waiting_user");
      const requested = assistanceCoordinator.request({
        tabId, taskId: task.id, kind: String(params.kind || "manual_action") as never,
        domain: safeDomain(evidence.mainFrameUrl), title: safeTitle, detail: safeDetail,
        url: evidence.mainFrameUrl, verificationStrategy: "page_change",
      });
      if (requested.created) assistanceBaselines.set(requested.assistance.id, evidence);
      try { tabStates.transition(tabId, "WAITING_USER"); } catch {}
      await adapter.selectTab(tabId); await adapter.show();
      ensureControlCenter();
      return requested.assistance;
    }
    case "browser.assistance_status": {
      if (params.assistanceId) return assistanceCoordinator.get(String(params.assistanceId));
      const tabId = await resolveTabId(params.tabId);
      return assistanceCoordinator.getByTab(tabId);
    }
    case "auth.complete":
    case "browser.assistance_complete": {
      if (params.userConfirmed !== true) throw namedError("USER_CONFIRMATION_REQUIRED", "Explicit user confirmation is required before verification.");
      const requestedId = String(params.assistanceId || "");
      let assistance = requestedId ? assistanceCoordinator.get(requestedId) : assistanceCoordinator.getByTab(await resolveTabId(params.tabId));
      if (!assistance) throw namedError("ASSISTANCE_STALE", "The assistance request is stale or missing.");
      if (params.outcome === "unable") {
        const resolved = assistanceCoordinator.resolve(assistance.id, "unable");
        try { tabStates.transition(assistance.tabId, "ERROR"); } catch {}
        return resolved;
      }
      assistance = assistanceCoordinator.beginVerification(assistance.id);
      tabStates.transition(assistance.tabId, "VERIFYING");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = assistanceBaselines.get(assistance.id);
      const after = await adapter.collectChallengeEvidence(assistance.tabId);
      if (!before) {
        const waiting = assistanceCoordinator.verificationFailed(assistance.id, "A fresh page baseline is required before control can resume.");
        tabStates.transition(assistance.tabId, "WAITING_USER");
        return waiting;
      }
      const probe = assistance.verificationStrategy === "protected_resource"
        ? await adapter.verifyProtectedResource(assistance.tabId, { url: before.expectedTarget || before.mainFrameUrl, timeoutMs: 10_000 })
        : undefined;
      const verification = verifyChallengeResolution(assistance, before, after, probe);
      if (!verification.success) {
        const waiting = assistanceCoordinator.verificationFailed(assistance.id, verification.sanitizedReason);
        tabStates.transition(assistance.tabId, "WAITING_USER");
        return { ...waiting, verification };
      }
      const completed = assistanceCoordinator.resolve(assistance.id, "completed");
      tabStates.transition(assistance.tabId, "READY");
      assistanceBaselines.delete(assistance.id);
      finish("用户操作已验证，等待任务");
      return { ...completed, verification };
    }
    case "runtime.shutdown":
      setImmediate(() => void shutdown());
      return { ok: true };
    case "runtime.reconnect": {
      await connection.disconnect();
      await runtime.attach();
      return { ok: true };
    }
    default:
      throw namedError("UNKNOWN_BROWSER_COMMAND", `Unknown browser command: ${method}`);
  }
}

async function respond(request: PipeRequest): Promise<PipeResponse> {
  if (!request?.id || !request.method) return { id: request?.id || "invalid", ok: false, error: { code: "INVALID_REQUEST", message: "A request ID and method are required." } };
  try {
    return { id: request.id, ok: true, result: await handle(request.method, request.params || {}) };
  } catch (error) {
    const safe = sanitizeError(error);
    return { id: request.id, ok: false, error: { code: safe.name, message: safe.message } };
  }
}

function attachSocket(socket: Socket): void {
  pipeSockets.add(socket);
  socket.once("close", () => pipeSockets.delete(socket));
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void respond(JSON.parse(line) as PipeRequest).then((response) => socket.end(`${JSON.stringify(response)}\n`));
      newline = buffer.indexOf("\n");
    }
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error(`[edge-broker] shutdown-start sockets=${pipeSockets.size}`);
  const serverClosed = new Promise<void>((resolve) => pipeServer?.close(() => resolve()) || resolve());
  for (const socket of pipeSockets) socket.destroy();
  await serverClosed;
  if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] shutdown-pipe-closed");
  await runtime.shutdown({ graceful: true }).catch((error) => {
    if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") {
      const safe = sanitizeError(error);
      console.error(`[edge-broker] shutdown-error ${safe.name}: ${safe.message}`);
    }
  });
  await extensionRelay.stop().catch(() => undefined);
  if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] shutdown-edge-finished");
  if (controlCenterProcess && controlCenterProcess.exitCode === null) controlCenterProcess.kill();
  if (temporaryProfile && !preserveTemporaryProfile) removeManagedEdgeProfile(profileDir, runtimeRoot);
  process.exitCode = 0;
}

if (process.platform !== "win32") await fs.unlink(pipePath).catch(() => undefined);
pipeServer = createServer(attachSocket);
await new Promise<void>((resolve, reject) => {
  pipeServer?.once("error", reject);
  pipeServer?.listen(pipePath, () => resolve());
});
if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error("[edge-broker] pipe-ready");
if (process.env.CODEX_BROWSER_SHOW_CONTROL_CENTER === "1") ensureControlCenter();
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", () => void shutdown());
process.on("unhandledRejection", () => void shutdown());
