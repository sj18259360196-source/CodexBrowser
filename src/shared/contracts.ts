import { MCP_PROTOCOL_VERSION } from "./release-info.js";

export const BROWSER_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;

export type RuntimeStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_user"
  | "downloading"
  | "parsing"
  | "error";

export type BrowserState =
  | "READY"
  | "RUNNING"
  | "WAITING_PAGE"
  | "WAITING_USER"
  | "VERIFYING"
  | "PAUSED_BY_USER"
  | "ERROR"
  | "CLOSED";

export type BrowserTabState =
  | "READY"
  | "RUNNING"
  | "WAITING_PAGE"
  | "WAITING_USER"
  | "VERIFYING"
  | "PAUSED_BY_USER"
  | "ERROR"
  | "CLOSED";

export type TaskStatus = "queued" | "running" | "waiting_user" | "done" | "error";

export interface TaskItem {
  id: string;
  label: string;
  detail?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadItem {
  id: string;
  fileName: string;
  path?: string;
  url: string;
  receivedBytes: number;
  totalBytes: number;
  state: "starting" | "progressing" | "completed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  fileName: string;
  pages: number;
  characters: number;
  createdAt: string;
}

export interface AuthPrompt {
  id: string;
  tabId: string;
  reason: "login" | "mfa" | "captcha" | "forbidden" | "stalled";
  title: string;
  detail: string;
  url: string;
  detectedAt: string;
}

export type BrowserTabAttention = "auth" | "dialog" | "assistance" | null;

export interface BrowserTabSummary {
  id: string;
  title: string;
  url: string;
  state: BrowserTabState;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  attention: BrowserTabAttention;
  createdAt: string;
  openerTabId?: string;
}

export type AssistanceKind =
  | "credential"
  | "verification"
  | "challenge"
  | "passkey"
  | "consent"
  | "file_selection"
  | "permission"
  | "certificate"
  | "manual_action";

export type AssistanceStatus = "waiting_user" | "verifying" | "completed" | "unable" | "cancelled" | "expired";

export type AssistanceVerificationStrategy =
  | "cloudflare"
  | "captcha"
  | "authentication"
  | "mfa"
  | "passkey"
  | "protected_resource"
  | "page_change";

export interface HumanAssistance {
  id: string;
  tabId: string;
  taskId: string;
  kind: AssistanceKind;
  title: string;
  detail: string;
  url: string;
  domain?: string;
  verificationStrategy?: AssistanceVerificationStrategy;
  status: AssistanceStatus;
  note?: string;
  requestedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
}

export interface BrowserDialogPrompt {
  id: string;
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  url: string;
  sensitive: boolean;
  openedAt: string;
}

export type SessionHealthStatus = "unknown" | "checking" | "healthy" | "attention" | "unavailable";

export interface SessionHealth {
  status: SessionHealthStatus;
  detail: string;
  checkedAt?: string;
  cookieCount: number;
  sessionCookieCount: number;
  encryptedBackupAvailable: boolean;
  lastRestoredAt?: string;
}

export interface LocalStorageStatus {
  lastSavedAt?: string;
  taskCount: number;
  downloadCount: number;
  documentCount: number;
}

export interface BrowserStorageSummary {
  origin: string;
  cookieCount: number;
  sessionCookieCount: number;
  cacheBytes?: number;
  siteStorageBytes?: number;
  permissionCount?: number;
  sessionRecoveryEnabled: boolean;
  sessionRecoveryAvailable: boolean;
  sessionRecoveryExpiresAt?: string;
  checkedAt: string;
}

export interface BrowserProfileStatus {
  id: string;
  label: string;
  state: "ready" | "in_use" | "recoverable" | "resetting" | "error";
  persistent: boolean;
  browserManagedPasswords: boolean;
  syncEnabledByProject: false;
  detail: string;
  checkedAt: string;
}

export type BrowserDataAction = "clear_site" | "clear_all" | "reset_profile";

export interface BrowserDataConfirmation {
  id: string;
  action: BrowserDataAction;
  scope: string;
  title: string;
  detail: string;
  expiresAt: string;
}

export type BrowserActionCategory = "ordinary" | "authentication" | "communication" | "publication" | "deletion" | "commerce" | "payment" | "subscription" | "account_security" | "permission" | "file_upload" | "personal_information" | "legal_terms";
export type BrowserActionConfirmationStatus = "waiting_user" | "approved" | "denied" | "executing" | "completed" | "failed" | "outcome_unknown" | "expired" | "cancelled";

export interface BrowserActionConfirmation {
  id: string;
  tabId: string;
  taskId: string;
  category: BrowserActionCategory;
  origin: string;
  summary: string;
  impact: string;
  createdAt: string;
  expiresAt: string;
  snapshotRevision: number;
  targetRef: string;
  ruleId: string;
  status: BrowserActionConfirmationStatus;
  resolvedAt?: string;
}

export interface BrowserRememberedGrant {
  id: string;
  profileId: string;
  origin: string;
  category: BrowserActionCategory;
  createdAt: string;
  expiresAt: string;
  tabId?: string;
  taskId?: string;
}

export interface BrowserPolicyAuditEntry {
  id: string;
  at: string;
  origin: string;
  category: BrowserActionCategory;
  ruleId: string;
  decision: string;
  tabId: string;
  taskId?: string;
  result: string;
}

export interface BrowserRuntimeInfo {
  kind: "external-edge" | "electron-legacy";
  label: string;
  browserVersion?: string;
  connection: "starting" | "connecting" | "ready" | "reconnecting" | "stopped" | "error";
  legacy: boolean;
  detail: string;
  migrationNotice?: string;
  firstRun?: boolean;
}

export interface BrowserRuntimeSettings {
  preferredRuntime: "external-edge" | "electron-legacy";
  keepEdgeRunningOnControlCenterClose: boolean;
  sessionRecoveryEnabled: boolean;
  notificationsEnabled: boolean;
  downloadBehavior: "managed";
  documentBehavior: "import-on-request";
}

export interface AppState {
  protocolVersion: string;
  browserState: BrowserState;
  runtimeStatus: RuntimeStatus;
  currentAction: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  profileId: string;
  profileLabel: string;
  tabs: BrowserTabSummary[];
  activeTabId: string;
  authPrompt: AuthPrompt | null;
  assistance: HumanAssistance | null;
  dialogs: BrowserDialogPrompt[];
  sessionHealth: SessionHealth;
  storage: LocalStorageStatus;
  browserStorage: BrowserStorageSummary;
  profileStatus: BrowserProfileStatus;
  actionConfirmations: BrowserActionConfirmation[];
  rememberedGrants: BrowserRememberedGrant[];
  policyAudit: BrowserPolicyAuditEntry[];
  runtimeInfo: BrowserRuntimeInfo;
  runtimeSettings: BrowserRuntimeSettings;
  tasks: TaskItem[];
  downloads: DownloadItem[];
  documents: DocumentSummary[];
}

export interface BrowserObservation {
  tabId?: string;
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; hasPassword: boolean }>;
  authRequired: boolean;
  capturedAt: string;
}

export interface InteractiveElementSnapshot {
  ref: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  type?: string;
  href?: string;
  placeholder?: string;
  value?: string;
  disabled: boolean;
  checked?: boolean;
  sensitive: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface InteractivePageSnapshot {
  tabId?: string;
  revision: number;
  title: string;
  url: string;
  text: string;
  elements: InteractiveElementSnapshot[];
  focusedRef?: string;
  authRequired: boolean;
  capturedAt: string;
}

export type BrowserAction =
  | { action: "click"; ref: string; tabId?: string; revision?: number }
  | { action: "double_click"; ref: string; tabId?: string; revision?: number }
  | { action: "hover"; ref: string; tabId?: string; revision?: number }
  | { action: "fill"; ref: string; text: string; tabId?: string; revision?: number }
  | { action: "press"; ref?: string; key: string; tabId?: string; revision?: number }
  | { action: "select"; ref: string; value: string; tabId?: string; revision?: number }
  | { action: "focus"; ref: string; tabId?: string; revision?: number }
  | { action: "check"; ref: string; tabId?: string; revision?: number }
  | { action: "uncheck"; ref: string; tabId?: string; revision?: number }
  | { action: "scroll"; deltaX?: number; deltaY?: number; tabId?: string; revision?: number };

export interface BrowserActionResult {
  action: BrowserAction["action"];
  tabId?: string;
  ref?: string;
  description: string;
  url: string;
  title: string;
  navigated: boolean;
}

export type BrowserWaitCondition =
  | "load"
  | "idle"
  | "url"
  | "text"
  | "selector"
  | "text_gone"
  | "url_changed"
  | "url_contains"
  | "element_visible"
  | "element_gone"
  | "download"
  | "dialog";

export interface BrowserWaitResult {
  tabId?: string;
  condition: BrowserWaitCondition;
  satisfied: boolean;
  elapsedMs: number;
  detail: string;
  url: string;
  title: string;
  status?: "satisfied" | "timeout" | "cancelled";
}

export interface PipeRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface PipeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface DesktopBridge {
  getState(): Promise<AppState>;
  subscribeState(listener: (state: AppState) => void): () => void;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  home(): Promise<void>;
  createTab(url?: string): Promise<BrowserTabSummary>;
  selectTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  checkSession(): Promise<SessionHealth>;
  completeAuth(promptId?: string): Promise<SessionHealth>;
  respondAssistance(
    assistanceId: string,
    outcome: "completed" | "unable",
  ): Promise<HumanAssistance>;
  respondDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
  clearTasks(): Promise<void>;
  clearDownloads(): Promise<void>;
  importPdf(): Promise<DocumentSummary | null>;
  openDownloads(): Promise<void>;
  openDownload(downloadId: string): Promise<void>;
  openDocument(documentId: string): Promise<void>;
  refreshStorageSummary(): Promise<BrowserStorageSummary>;
  requestDataAction(action: BrowserDataAction, includePermissions?: boolean): Promise<BrowserDataConfirmation>;
  confirmDataAction(confirmationId: string): Promise<BrowserStorageSummary>;
  setSessionRecovery(enabled: boolean): Promise<BrowserStorageSummary>;
  respondActionConfirmation(confirmationId: string, response: "allow_once" | "allow_temporary" | "deny"): Promise<BrowserActionConfirmation>;
  revokeBrowserGrant(grantId: string): Promise<void>;
  clearPolicyAudit(): Promise<void>;
  showBrowser(): Promise<void>;
  restartBrowser(): Promise<void>;
  shutdownBrowser(): Promise<void>;
  updateRuntimeSettings(settings: Partial<BrowserRuntimeSettings>): Promise<BrowserRuntimeSettings>;
}
