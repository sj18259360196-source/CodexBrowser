import type {
  BrowserAction,
  BrowserActionResult,
  BrowserDialogPrompt,
  BrowserObservation,
  BrowserTabSummary,
  BrowserWaitCondition,
  BrowserWaitResult,
  BrowserStorageSummary,
  InteractivePageSnapshot,
} from "../shared/contracts";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabList {
  activeTabId: string;
  tabs: BrowserTabSummary[];
}

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserScreenshotRequest {
  scope: "viewport" | "element";
  ref?: string;
  maxWidth: number;
  // Kept for compatibility. Implementations must never disable sensitive redaction.
  redactSensitive?: boolean;
}

export interface BrowserScreenshot {
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
  redactionCount: number;
  title: string;
  url: string;
}

export interface BrowserAuthSignals {
  hasPassword: boolean;
  hasCaptcha: boolean;
  hasMfa: boolean;
  hasLoginText: boolean;
  hasLoginControl: boolean;
}

export interface BrowserDownloadLink {
  text: string;
  url: string;
}

export interface BrowserSessionSummary {
  cookieCount: number;
  sessionCookieCount: number;
  encryptedBackupAvailable: boolean;
}

export interface BrowserResourceProbe {
  url: string;
  expectedPdf?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  stopGeneration?: number;
}

export interface BrowserResourceProbeResult {
  ok: boolean;
  status?: number;
  redirectedToLogin?: boolean;
  returnedHtml?: boolean;
  unauthorized?: boolean;
  challengeLikely?: boolean;
  evidenceTypes?: string[];
  detail?: string;
}

export interface BrowserActionPolicyContext {
  origin: string;
  sanitizedUrl: string;
  element?: {
    role: string;
    type?: string;
    name: string;
    text?: string;
    sensitive: boolean;
    href?: string;
    isSubmit: boolean;
  };
  form?: {
    action?: string;
    method?: string;
    hasSensitiveFields: boolean;
    hasPersonalInformation: boolean;
    hasFileInput: boolean;
    hasSelectedFile: boolean;
  };
  page: {
    heading?: string;
    surroundingText?: string;
    hasPrice: boolean;
    hasCurrency: boolean;
    area: "ordinary" | "search" | "account" | "security" | "subscription" | "checkout" | "communication" | "publication";
  };
  targetOrigin?: string;
}

export interface BrowserChallengeEvidence {
  tabId: string;
  mainFrameUrl: string;
  frameUrls: string[];
  title: string;
  visibleText: string;
  domMarkers: string[];
  iframeOrigins: string[];
  scriptUrls: string[];
  mainFrameStatus?: number;
  responseHeaderNames: string[];
  refreshCount: number;
  unchangedMs: number;
  expectedTarget?: string;
}

export interface BrowserDownloadRequest {
  url?: string;
  candidateId?: string;
}

export interface BrowserDownloadStartResult {
  jobId: string;
  url: string;
  tabId: string;
  documentId?: string;
  reused?: boolean;
}

export interface BrowserAdapter {
  readonly kind: string;

  listTabs(): Promise<BrowserTabList>;
  createTab(options?: { url?: string; activate?: boolean }): Promise<BrowserTabList & { createdTabId: string }>;
  selectTab(tabId: string): Promise<BrowserTabList>;
  closeTab(tabId: string, options?: { force?: boolean }): Promise<BrowserTabList>;
  setViewportBounds(bounds: BrowserBounds): void;
  getTabInfo(tabId: string): BrowserTabInfo;
  refreshTabInfo(tabId: string): Promise<BrowserTabInfo>;

  navigate(tabId: string, url: string): Promise<void>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;

  observe(tabId: string, options?: { maxCharacters?: number }): Promise<BrowserObservation>;
  snapshot(tabId: string, options?: { maxElements?: number; maxTextCharacters?: number }): Promise<InteractivePageSnapshot>;
  getActionPolicyContext(tabId: string, action: BrowserAction): Promise<BrowserActionPolicyContext>;
  act(tabId: string, action: BrowserAction): Promise<BrowserActionResult>;
  wait(tabId: string, request: {
    condition: BrowserWaitCondition;
    value?: string;
    timeoutMs?: number;
  }): Promise<BrowserWaitResult>;
  screenshot(tabId: string, request: BrowserScreenshotRequest): Promise<BrowserScreenshot>;
  printToPdf(tabId: string): Promise<Uint8Array>;

  inspectAuthentication(tabId: string): Promise<BrowserAuthSignals>;
  collectChallengeEvidence(tabId: string, expectedTarget?: string): Promise<BrowserChallengeEvidence>;
  listDialogs(tabId?: string): Promise<BrowserDialogPrompt[]>;
  respondDialog(tabId: string, request: { dialogId: string; accept: boolean; promptText?: string }): Promise<void>;
  dismissDialogs(tabId: string): Promise<void>;
  findDownloadLinks(tabId: string): Promise<BrowserDownloadLink[]>;
  startDownload(tabId: string, request: BrowserDownloadRequest): Promise<BrowserDownloadStartResult>;
  verifyProtectedResource(tabId: string, request: BrowserResourceProbe): Promise<BrowserResourceProbeResult>;
  getSessionSummary(): Promise<BrowserSessionSummary>;
  flushPersistentSession(): Promise<void>;
  getStorageSummary(tabId?: string): Promise<BrowserStorageSummary>;
  clearSiteData(tabId: string, options?: { includePermissions?: boolean }): Promise<void>;
  clearAllBrowserData(): Promise<void>;
}
