export const BROWSER_PROTOCOL_VERSION = "1.2.0";

export type RuntimeStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_user"
  | "downloading"
  | "parsing"
  | "error";

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
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  attention: BrowserTabAttention;
  createdAt: string;
}

export type AssistanceKind =
  | "credential"
  | "verification"
  | "consent"
  | "file_selection"
  | "permission"
  | "manual_action";

export type AssistanceStatus = "waiting_user" | "completed" | "unable" | "cancelled";

export interface HumanAssistance {
  id: string;
  tabId: string;
  taskId: string;
  kind: AssistanceKind;
  title: string;
  detail: string;
  url: string;
  status: AssistanceStatus;
  note?: string;
  requestedAt: string;
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

export interface CredentialVaultStatus {
  encryptionAvailable: boolean;
  savedSiteCount: number;
  activeSiteSaved: boolean;
}

export interface LocalStorageStatus {
  lastSavedAt?: string;
  taskCount: number;
  downloadCount: number;
  documentCount: number;
}

export interface AppState {
  protocolVersion: string;
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
  credentialVault: CredentialVaultStatus;
  storage: LocalStorageStatus;
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

export type BrowserWaitCondition = "load" | "idle" | "url" | "text" | "selector";

export interface BrowserWaitResult {
  tabId?: string;
  condition: BrowserWaitCondition;
  satisfied: boolean;
  elapsedMs: number;
  detail: string;
  url: string;
  title: string;
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
  saveAndSubmitLogin(promptId?: string): Promise<CredentialVaultStatus>;
  clearSavedLogins(): Promise<CredentialVaultStatus>;
  respondAssistance(
    assistanceId: string,
    outcome: "completed" | "unable",
    note?: string,
  ): Promise<HumanAssistance>;
  respondDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
  clearTasks(): Promise<void>;
  clearDownloads(): Promise<void>;
  importPdf(): Promise<DocumentSummary | null>;
  openDownloads(): Promise<void>;
  openDownload(downloadId: string): Promise<void>;
  openDocument(documentId: string): Promise<void>;
}
