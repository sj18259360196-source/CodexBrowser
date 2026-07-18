import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserDialogPrompt,
  BrowserObservation,
  BrowserTabSummary,
  BrowserWaitResult,
  DownloadItem,
  InteractiveElementSnapshot,
  InteractivePageSnapshot,
  BrowserStorageSummary,
} from "../shared/contracts";
import type {
  BrowserAdapter,
  BrowserActionPolicyContext,
  BrowserAuthSignals,
  BrowserBounds,
  BrowserChallengeEvidence,
  BrowserDownloadLink,
  BrowserDownloadRequest,
  BrowserDownloadStartResult,
  BrowserResourceProbe,
  BrowserResourceProbeResult,
  BrowserScreenshot,
  BrowserScreenshotRequest,
  BrowserSessionSummary,
  BrowserTabInfo,
  BrowserTabList,
} from "./browser-adapter";
import type { CdpEvent, CdpTransport } from "./cdp-transport";
import { isCapturablePdfResponse } from "./pdf-response";
import { isVerificationProviderFrameUrl } from "./verification-boundary";

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  openerId?: string;
}

interface TabRecord {
  id: string;
  targetId: string;
  sessionId?: string;
  sessionPromise?: Promise<TabRecord>;
  title: string;
  url: string;
  createdAt: string;
  openerTabId?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  revision: number;
  frameContexts: Map<string, number>;
  frameOffsets: Map<string, { x: number; y: number }>;
  mainFrameId?: string;
  frameUrls: Map<string, string>;
  mainFrameStatus?: number;
  responseHeaderNames: Set<string>;
  refreshCount: number;
  lastMainNavigationAt: number;
  lastEvidenceFingerprint?: string;
  lastEvidenceChangedAt: number;
}

interface RefRecord {
  ref: string;
  revision: number;
  frameId: string;
  contextId: number;
  sessionId: string;
  offset: { x: number; y: number };
  sensitive: boolean;
  tag: string;
  type?: string;
}

interface SnapshotFrameResult {
  title: string;
  url: string;
  text: string;
  elements: InteractiveElementSnapshot[];
  focusedRef?: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; hasPassword: boolean }>;
  authRequired: boolean;
}

interface DownloadRecord {
  item: DownloadItem;
  guid: string;
  tabId: string;
  sourceUrl: string;
  suggestedFileName: string;
  filePath?: string;
  streamHandle?: string;
  abortController?: AbortController;
  cancelRequested?: boolean;
  completed: Promise<string | undefined>;
  resolveCompleted(value?: string): void;
}

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const SENSITIVE_PATTERN = /password|passwd|passcode|pin|otp|one.?time|verification.?code|recovery.?code|captcha|turnstile|cloudflare|token|secret|credential|api.?key|credit.?card|card.?number|cc-number|cc-csc|cvv|cvc|payment/i;

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 140) || "download.bin";
}

function exposedUrl(value: string): string {
  if (value === "about:blank") return value;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function resultValue<T>(response: { result?: { value?: T }; exceptionDetails?: unknown }): T {
  if (response.exceptionDetails || !response.result || !("value" in response.result)) {
    throw namedError("PAGE_SCRIPT_ERROR", "The page could not complete the requested bounded browser operation.");
  }
  return response.result.value as T;
}

export class EdgeBrowserAdapter implements BrowserAdapter {
  readonly kind = "edge-cdp";
  private readonly tabsByTarget = new Map<string, TabRecord>();
  private readonly tabsById = new Map<string, TabRecord>();
  private readonly targetBySession = new Map<string, string>();
  private readonly refsByTab = new Map<string, Map<string, RefRecord>>();
  private readonly dialogs = new Map<string, BrowserDialogPrompt>();
  private readonly dialogBySession = new Map<string, string>();
  private readonly downloadCandidates = new Map<string, { tabId: string; url: string }>();
  private readonly downloadRecords = new Map<string, DownloadRecord>();
  private readonly downloadIdByGuid = new Map<string, string>();
  private readonly pdfRequestBySession = new Map<string, Map<string, { tabId: string; url: string }>>();
  private readonly loadedPdfByTab = new Map<string, { bytes: Buffer; url: string }>();
  private readonly visitedOrigins = new Set<string>();
  private activeTabId = "";
  private waitGeneration = 0;
  private connectedGeneration = 0;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800 };

  constructor(private readonly transport: CdpTransport, private readonly downloadsDir: string) {
    transport.onEvent((event) => this.handleEvent(event));
  }

  private debug(message: string): void {
    if (process.env.CODEX_BROWSER_EDGE_DEBUG === "1") console.error(`[edge-adapter] ${message}`);
  }

  async onConnected(): Promise<void> {
    this.debug("onConnected:start");
    this.connectedGeneration += 1;
    this.waitGeneration += 1;
    for (const tab of this.tabsById.values()) {
      tab.sessionId = undefined;
      tab.frameContexts.clear();
      tab.revision += 1;
    }
    this.targetBySession.clear();
    await fs.mkdir(this.downloadsDir, { recursive: true });
    await this.transport.send("Target.setDiscoverTargets", { discover: true });
    this.debug("onConnected:discover-targets");
    await this.transport.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.downloadsDir,
      eventsEnabled: true,
    });
    this.debug("onConnected:download-behavior");
    await this.syncTargets();
    this.debug("onConnected:ready");
  }

  async discoverTabs() {
    return (await this.listTabs()).tabs.map(({ id, title, url }) => ({ id, title, url }));
  }

  async createTestTab() {
    const result = await this.createTab({ url: "about:blank", activate: true });
    return this.readTab(result.createdTabId);
  }

  async readTab(tabId: string) {
    const info = await this.refreshTabInfo(tabId);
    return { id: info.id, title: info.title, url: info.url };
  }

  async listTabs(): Promise<BrowserTabList> {
    await this.syncTargets();
    const tabs = [...this.tabsById.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((tab) => this.summary(tab));
    if (!this.activeTabId || !this.tabsById.has(this.activeTabId)) this.activeTabId = tabs[0]?.id || "";
    return { activeTabId: this.activeTabId, tabs: tabs.map((tab) => ({ ...tab, active: tab.id === this.activeTabId })) };
  }

  async createTab(options: { url?: string; activate?: boolean } = {}): Promise<BrowserTabList & { createdTabId: string }> {
    const result = await this.transport.send<{ targetId: string }>("Target.createTarget", { url: options.url || "about:blank" });
    await this.syncTargets();
    const tab = this.tabsByTarget.get(result.targetId);
    if (!tab) throw new Error("Managed Edge did not register the new tab.");
    if (options.activate !== false) await this.selectTab(tab.id);
    return { ...(await this.listTabs()), createdTabId: tab.id };
  }

  async selectTab(tabId: string): Promise<BrowserTabList> {
    const tab = this.requireTab(tabId);
    await this.transport.send("Target.activateTarget", { targetId: tab.targetId });
    this.activeTabId = tabId;
    return this.listTabs();
  }

  async closeTab(tabId: string, _options?: { force?: boolean }): Promise<BrowserTabList> {
    const tab = this.requireTab(tabId);
    const result = await this.transport.send<{ success: boolean }>("Target.closeTarget", { targetId: tab.targetId });
    if (!result.success) throw new Error("Managed Edge did not close the requested tab.");
    this.removeTab(tab);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return this.listTabs();
  }

  setViewportBounds(bounds: BrowserBounds): void {
    this.bounds = { ...bounds };
  }

  getTabInfo(tabId: string): BrowserTabInfo {
    const tab = this.requireTab(tabId);
    return this.info(tab);
  }

  async refreshTabInfo(tabId: string): Promise<BrowserTabInfo> {
    const tab = this.requireTab(tabId);
    const result = await this.transport.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId: tab.targetId });
    this.updateTargetInfo(result.targetInfo);
    await this.refreshHistory(tab).catch(() => undefined);
    return this.info(tab);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = await this.readyTab(tabId);
    this.assertNoDialog(tabId);
    tab.isLoading = true;
    tab.revision += 1;
    this.refsByTab.delete(tabId);
    const loaded = this.transport.waitForEvent("Page.loadEventFired", { sessionId: tab.sessionId, timeoutMs: 20_000 });
    const navigatePage = async () => {
      try {
        return await this.transport.send<{ errorText?: string }>("Page.navigate", { url }, tab.sessionId);
      } catch (error) {
        if (/timed out while running Page\.navigate/i.test(error instanceof Error ? error.message : "")) {
          throw namedError("NAVIGATION_RESPONSE_TIMEOUT", "Managed Edge did not acknowledge the navigation before the bounded timeout.");
        }
        throw error;
      }
    };
    let result: { errorText?: string };
    if (/\.pdf(?:$|[?#])/i.test(url)) {
      await this.transport.send("Fetch.enable", { patterns: [{ urlPattern: url, requestStage: "Response" }] }, tab.sessionId);
      try {
        const pausedPromise = this.transport.waitForEvent<{
          requestId: string;
          responseStatusCode?: number;
          responseHeaders?: Array<{ name: string; value: string }>;
        }>("Fetch.requestPaused", { sessionId: tab.sessionId, timeoutMs: 15_000 });
        const navigation = navigatePage();
        const paused = await pausedPromise;
        const responseStatus = paused.responseStatusCode || 0;
        const responseHeaders = paused.responseHeaders || [];
        if (isCapturablePdfResponse(responseStatus, responseHeaders)) {
          const body = await this.transport.send<{ body: string; base64Encoded: boolean }>("Fetch.getResponseBody", { requestId: paused.requestId }, tab.sessionId);
          const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "binary");
          await this.transport.send("Fetch.fulfillRequest", {
            requestId: paused.requestId,
            responseCode: responseStatus,
            responseHeaders,
            body: bytes.toString("base64"),
          }, tab.sessionId);
          if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
            this.loadedPdfByTab.set(tabId, { bytes, url });
          } else if (isLoopbackUrl(url)) {
            const fixture = await fetch(url, { redirect: "error" });
            const fixtureBytes = Buffer.from(await fixture.arrayBuffer());
            if (fixture.ok && fixtureBytes.subarray(0, 5).toString("ascii") === "%PDF-") this.loadedPdfByTab.set(tabId, { bytes: fixtureBytes, url });
          }
        } else {
          // Preserve publisher authentication, redirects, Set-Cookie handling,
          // and Cloudflare challenge navigation exactly as Edge received them.
          try {
            await this.transport.send("Fetch.continueResponse", { requestId: paused.requestId }, tab.sessionId);
          } catch {
            await this.transport.send("Fetch.continueRequest", { requestId: paused.requestId }, tab.sessionId);
          }
        }
        result = await navigation;
      } finally {
        await this.transport.send("Fetch.disable", {}, tab.sessionId).catch(() => undefined);
      }
    } else {
      result = await navigatePage();
    }
    const pdfViewerHandoff = result.errorText === "net::ERR_ABORTED" && /\.pdf(?:$|[?#])/i.test(url);
    if (result.errorText && !pdfViewerHandoff) throw new Error("Managed Edge could not navigate to the requested page.");
    if (pdfViewerHandoff) {
      await Promise.race([loaded.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 700))]);
      await this.syncTargets();
    } else {
      await loaded.catch(() => undefined);
    }
    await this.refreshTabInfo(tabId);
  }

  async back(tabId: string): Promise<void> {
    await this.navigateHistory(tabId, -1);
  }

  async forward(tabId: string): Promise<void> {
    await this.navigateHistory(tabId, 1);
  }

  async reload(tabId: string): Promise<void> {
    const tab = await this.readyTab(tabId);
    this.assertNoDialog(tabId);
    tab.revision += 1;
    this.refsByTab.delete(tabId);
    tab.isLoading = true;
    const loaded = this.transport.waitForEvent("Page.loadEventFired", { sessionId: tab.sessionId, timeoutMs: 20_000 });
    await this.transport.send("Page.reload", { ignoreCache: false }, tab.sessionId);
    await loaded.catch(() => undefined);
    await this.refreshTabInfo(tabId);
  }

  async stop(tabId: string): Promise<void> {
    const tab = await this.readyTab(tabId);
    this.waitGeneration += 1;
    await this.transport.send("Page.stopLoading", {}, tab.sessionId).catch(() => undefined);
    await Promise.all([...this.downloadRecords.values()]
      .filter((record) => record.tabId === tabId && (record.item.state === "starting" || record.item.state === "progressing"))
      .map(async (record) => {
        record.cancelRequested = true;
        record.item.state = "cancelled";
        record.item.updatedAt = new Date().toISOString();
        if (record.streamHandle) await this.transport.send("IO.close", { handle: record.streamHandle }, tab.sessionId).catch(() => undefined);
        record.abortController?.abort();
        if (record.guid) await this.transport.send("Browser.cancelDownload", { guid: record.guid }).catch(() => undefined);
        record.resolveCompleted(undefined);
      }));
    tab.isLoading = false;
  }

  async observe(tabId: string, options: { maxCharacters?: number } = {}): Promise<BrowserObservation> {
    const tab = await this.readyTab(tabId);
    const frames = await this.captureFrames(tab, 0, options.maxCharacters ?? 30_000, false);
    return {
      tabId,
      title: tab.title || frames[0]?.title || "Edge page",
      url: tab.url,
      text: frames.map((frame) => frame.text).filter(Boolean).join("\n").slice(0, options.maxCharacters ?? 30_000),
      links: frames.flatMap((frame) => frame.links).slice(0, 300),
      forms: frames.flatMap((frame) => frame.forms).slice(0, 100),
      authRequired: frames.some((frame) => frame.authRequired),
      capturedAt: new Date().toISOString(),
    };
  }

  async snapshot(tabId: string, options: { maxElements?: number; maxTextCharacters?: number } = {}): Promise<InteractivePageSnapshot> {
    const tab = await this.readyTab(tabId);
    tab.revision += 1;
    const revision = tab.revision;
    const frames = await this.captureFrames(tab, options.maxElements ?? 140, options.maxTextCharacters ?? 24_000, true);
    const elements = frames.flatMap((frame) => frame.elements).slice(0, options.maxElements ?? 140);
    return {
      tabId,
      revision,
      title: tab.title || frames[0]?.title || "Edge page",
      url: tab.url,
      text: frames.map((frame) => frame.text).filter(Boolean).join("\n").slice(0, options.maxTextCharacters ?? 24_000),
      elements,
      focusedRef: frames.map((frame) => frame.focusedRef).find(Boolean),
      authRequired: frames.some((frame) => frame.authRequired),
      capturedAt: new Date().toISOString(),
    };
  }

  async act(tabId: string, action: BrowserAction): Promise<BrowserActionResult> {
    const tab = await this.readyTab(tabId);
    this.assertNoDialog(tabId);
    if (action.revision !== undefined && action.revision !== tab.revision) throw namedError("STALE_SNAPSHOT", "The page snapshot is stale. Capture a new browser_snapshot for this tab.");
    const beforeUrl = tab.url;
    if (action.action === "scroll") {
      await this.transport.send("Input.synthesizeScrollGesture", {
        x: Math.max(1, this.bounds.width / 2), y: Math.max(1, this.bounds.height / 2),
        xDistance: -(action.deltaX || 0), yDistance: -(action.deltaY || 0),
        gestureSourceType: "mouse", speed: 1_200,
      }, tab.sessionId, 10_000);
      return this.actionResult(action, tab, beforeUrl, "Scrolled the page.");
    }
    if (action.action === "press" && !action.ref) {
      await this.withInputFocus(tab, () => this.pressKey(tab, action.key));
      return this.actionResult(action, tab, beforeUrl, `Pressed ${action.key}.`);
    }
    const ref = "ref" in action ? action.ref : undefined;
    if (!ref) throw namedError("INVALID_ACTION", "This browser action requires an element reference.");
    const reference = this.requireRef(tab, ref, action.revision);
    if (reference.sensitive) throw namedError("USER_ACTION_REQUIRED", "This sensitive control must be operated manually in the visible browser.");
    await this.evaluateContext(reference.contextId, `(() => { const e=document.querySelector('[data-codex-browser-ref="'+CSS.escape(${JSON.stringify(reference.ref)})+'"]'); if(!e)return false; e.scrollIntoView({block:'center',inline:'center'}); return true; })()`, reference.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const probe = await this.probeReference(tab, reference, action.action === "select" ? action.value : undefined);
    if (!probe.exists) throw namedError("REF_NOT_FOUND", "The referenced element is missing or changed. Capture a new browser snapshot.");
    if (!probe.visible) throw namedError("INVALID_ACTION", "The referenced element is not visible.");
    const x = reference.offset.x + probe.x + probe.width / 2;
    const y = reference.offset.y + probe.y + probe.height / 2;
    if (["click", "double_click", "hover", "focus", "fill", "check", "uncheck", "select"].includes(action.action) && !probe.hit) {
      throw namedError("INVALID_ACTION", "The referenced element is covered or cannot be hit safely.");
    }
    if (action.action === "hover") {
      await this.mouse(tab, "mouseMoved", x, y);
    } else if (action.action === "click" || action.action === "double_click" || action.action === "focus") {
      await this.click(tab, x, y, action.action === "double_click" ? 2 : 1);
    } else if (action.action === "fill") {
      await this.click(tab, x, y, 1);
      await this.withInputFocus(tab, async () => {
        await this.selectAll(tab);
        await this.transport.send("Input.insertText", { text: action.text }, tab.sessionId);
      });
    } else if (action.action === "press") {
      await this.click(tab, x, y, 1);
      await this.withInputFocus(tab, () => this.pressKey(tab, action.key));
    } else if (action.action === "check" || action.action === "uncheck") {
      const desired = action.action === "check";
      if (Boolean(probe.checked) !== desired) await this.click(tab, x, y, 1);
    } else if (action.action === "select") {
      if (probe.optionIndex == null || probe.optionIndex < 0) throw namedError("INVALID_ACTION", "The requested option was not found.");
      await this.withInputFocus(tab, async () => {
        await this.focusReference(reference);
        await this.pressKey(tab, "Home");
        for (let index = 0; index < probe.optionIndex!; index += 1) await this.pressKey(tab, "ArrowDown");
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    await this.refreshTabInfo(tabId).catch(() => undefined);
    return this.actionResult(action, tab, beforeUrl, `${action.action} completed.`);
  }

  async getActionPolicyContext(tabId: string, action: BrowserAction): Promise<BrowserActionPolicyContext> {
    const tab = await this.readyTab(tabId);
    const origin = this.originFor(tab.url);
    if (!("ref" in action) || !action.ref) return { origin, sanitizedUrl: exposedUrl(tab.url), page: { hasPrice: false, hasCurrency: false, area: "ordinary" } };
    const reference = this.requireRef(tab, action.ref, action.revision);
    return this.evaluateContext<BrowserActionPolicyContext>(reference.contextId, `(() => {
      const e=document.querySelector('[data-codex-browser-ref="'+CSS.escape(${JSON.stringify(reference.ref)})+'"]');
      if(!e) throw new Error('stale');
      const compact=(v,n=700)=>String(v||'').replace(/\\s+/g,' ').trim().slice(0,n);
      const text=compact([e.getAttribute('aria-label'),e.labels?.[0]?.innerText,e.innerText,e.value&&e.type!=='password'?e.value:''].filter(Boolean).join(' '));
      const form=e.form||e.closest('form'); const scope=e.closest('section,article,main')||form||e.parentElement; const surrounding=compact(scope?.innerText);
      const heading=compact(scope?.querySelector?.('h1,h2,h3,legend')?.innerText||form?.querySelector?.('legend')?.innerText||document.querySelector('h1,h2,h3')?.innerText,300);
      const areaText=(heading+' '+surrounding+' '+location.pathname).toLowerCase();
      const area=/checkout|cart|order|payment|结账|订单|支付/.test(areaText)?'checkout':/security|password|mfa|安全|密码/.test(areaText)?'security':/subscription|plan|订阅/.test(areaText)?'subscription':/account|profile|账户|个人资料/.test(areaText)?'account':/message|comment|mail|contact|消息|评论|邮件/.test(areaText)?'communication':/publish|article|post|发布|文章/.test(areaText)?'publication':/search|filter|query|搜索|筛选/.test(areaText)?'search':'ordinary';
      const formText=compact(form?.innerText,1000).toLowerCase();
      const personal=/full name|address|phone|date of birth|identity|passport|姓名|住址|手机号|出生日期|身份证/.test(formText)||Boolean(form?.querySelector('[autocomplete=name],[autocomplete=street-address],[autocomplete=tel]'));
      const href=e.href||e.formAction||''; let targetOrigin; try{targetOrigin=new URL(href,location.href).origin}catch{}
      return {origin:location.origin,sanitizedUrl:location.origin+location.pathname,targetOrigin,element:{role:e.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[e.tagName]||'textbox'),type:e.type||undefined,name:compact(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.placeholder||e.innerText||e.name||e.id||e.tagName,240),text,sensitive:${reference.sensitive},href:href?(()=>{try{const u=new URL(href,location.href);return u.origin+u.pathname}catch{return undefined}})():undefined,isSubmit:Boolean(form)&&(e.type==='submit'||(e.tagName==='BUTTON'&&(!e.type||e.type==='submit')))},form:form?{action:(()=>{try{const u=new URL(form.action,location.href);return u.origin+u.pathname}catch{return undefined}})(),method:(form.method||'get').toLowerCase(),hasSensitiveFields:Boolean(form.querySelector('input[type=password],[autocomplete=one-time-code],[data-sensitive]')),hasPersonalInformation:personal,hasFileInput:Boolean(form.querySelector('input[type=file]')),hasSelectedFile:Boolean(form.querySelector('input[type=file]')?.files?.length)}:undefined,page:{heading,surroundingText:surrounding,hasPrice:/(?:[$€£¥]|usd|eur|gbp|cny|rmb|美元|欧元|人民币)\\s*\\d|\\d[\\d,.]*\\s*(?:usd|eur|gbp|cny|rmb|元)/i.test(surrounding),hasCurrency:/(?:[$€£¥]|usd|eur|gbp|cny|rmb|美元|欧元|人民币)/i.test(surrounding),area}};
    })()`, reference.sessionId);
  }

  async wait(tabId: string, request: Parameters<BrowserAdapter["wait"]>[1]): Promise<BrowserWaitResult> {
    const tab = await this.readyTab(tabId);
    const generation = this.waitGeneration;
    const startedAt = Date.now();
    const timeout = Math.min(Math.max(request.timeoutMs ?? 10_000, 100), 20_000);
    const initialUrl = tab.url;
    const condition = request.condition;
    let satisfied = false;
    while (Date.now() - startedAt < timeout) {
      if (generation !== this.waitGeneration) return this.waitResult(tab, request, startedAt, false, "cancelled");
      if (!this.tabsById.has(tabId)) return this.waitResult(tab, request, startedAt, false, "cancelled");
      await this.refreshTabInfo(tabId).catch(() => undefined);
      if (condition === "load" || condition === "idle") satisfied = !tab.isLoading;
      else if (condition === "url" || condition === "url_contains") satisfied = Boolean(request.value && tab.url.includes(request.value));
      else if (condition === "url_changed") satisfied = tab.url !== (request.value || initialUrl);
      else if (condition === "dialog") satisfied = [...this.dialogs.values()].some((dialog) => dialog.tabId === tabId);
      else if (condition === "download") satisfied = [...this.downloadRecords.values()].some((download) => download.tabId === tabId);
      else {
        const probe = await this.evaluateMain<{ text: string; selectorVisible: boolean; selectorExists: boolean }>(tab, `(() => {
          const value = ${JSON.stringify(request.value || "")};
          let element = null;
          try { element = value.startsWith('cb-e') ? document.querySelector('[data-codex-browser-ref="' + CSS.escape(value) + '"]') : document.querySelector(value); } catch {}
          const rect = element?.getBoundingClientRect?.();
          return { text: (document.body?.innerText || ''), selectorExists: Boolean(element), selectorVisible: Boolean(rect && rect.width > 0 && rect.height > 0) };
        })()`);
        if (condition === "text") satisfied = probe.text.includes(request.value || "");
        else if (condition === "text_gone") satisfied = !probe.text.includes(request.value || "");
        else if (condition === "selector" || condition === "element_visible") satisfied = probe.selectorVisible;
        else if (condition === "element_gone") satisfied = !probe.selectorExists;
      }
      if (satisfied) return this.waitResult(tab, request, startedAt, true, "satisfied");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.waitResult(tab, request, startedAt, false, "timeout");
  }

  async screenshot(tabId: string, request: BrowserScreenshotRequest): Promise<BrowserScreenshot> {
    const tab = await this.readyTab(tabId);
    const references = request.scope === "element" && request.ref
      ? [this.requireRef(tab, request.ref)]
      : [...(this.refsByTab.get(tabId)?.values() || [])].filter((ref) => ref.sensitive);
    const cleanup: Array<{ contextId: number; sessionId: string; ids: string[] }> = [];
    try {
      const byContext = new Map<string, RefRecord[]>();
      for (const ref of references.filter((candidate) => candidate.sensitive)) {
        const key = `${ref.sessionId}:${ref.contextId}`;
        const group = byContext.get(key) || [];
        group.push(ref);
        byContext.set(key, group);
      }
      for (const refs of byContext.values()) {
        const { contextId, sessionId } = refs[0];
        const ids = refs.map((ref) => ref.ref);
        await this.evaluateContext(contextId, `(() => {
          const ids = ${JSON.stringify(ids)}; const made = [];
          for (const id of ids) { const el = document.querySelector('[data-codex-browser-ref="' + CSS.escape(id) + '"]'); if (!el) continue;
            const r = el.getBoundingClientRect(); const mask = document.createElement('div'); mask.dataset.codexBrowserMask = id;
            Object.assign(mask.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',background:'#202020',zIndex:'2147483647',pointerEvents:'none'});
            document.documentElement.appendChild(mask); made.push(id); }
          return made;
        })()`, sessionId);
        cleanup.push({ contextId, sessionId, ids });
      }
      let clip: Record<string, unknown> | undefined;
      if (request.scope === "element") {
        if (!request.ref) throw new Error("Element screenshots require a snapshot ref.");
        const ref = this.requireRef(tab, request.ref);
        const probe = await this.probeReference(tab, ref);
        if (!probe.exists || !probe.visible) throw namedError("REF_NOT_FOUND", "The screenshot element is missing or not visible.");
        clip = { x: ref.offset.x + probe.x, y: ref.offset.y + probe.y, width: probe.width, height: probe.height, scale: 1 };
      }
      const maxWidth = Math.min(Math.max(request.maxWidth || 1600, 320), 4096);
      if (!clip) {
        const metrics = await this.transport.send<{ layoutViewport: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, tab.sessionId);
        const width = metrics.layoutViewport.clientWidth;
        clip = { x: 0, y: 0, width, height: metrics.layoutViewport.clientHeight, scale: Math.min(1, maxWidth / Math.max(1, width)) };
      }
      const captured = await this.transport.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip }, tab.sessionId);
      const bytes = Buffer.from(captured.data, "base64");
      if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("The screenshot exceeds the maximum safe response size.");
      const width = Math.max(1, Math.round(Number(clip.width) * Number(clip.scale || 1)));
      const height = Math.max(1, Math.round(Number(clip.height) * Number(clip.scale || 1)));
      return { bytes, mimeType: "image/png", width, height, redactionCount: cleanup.reduce((sum, entry) => sum + entry.ids.length, 0), title: tab.title, url: tab.url };
    } finally {
      for (const entry of cleanup) {
        await this.evaluateContext(entry.contextId, `(() => { for (const el of document.querySelectorAll('[data-codex-browser-mask]')) el.remove(); return true; })()`, entry.sessionId).catch(() => undefined);
      }
    }
  }

  async printToPdf(tabId: string): Promise<Uint8Array> {
    const tab = await this.readyTab(tabId);
    const result = await this.transport.send<{ data: string }>("Page.printToPDF", { printBackground: true }, tab.sessionId);
    return Buffer.from(result.data, "base64");
  }

  async inspectAuthentication(tabId: string): Promise<BrowserAuthSignals> {
    const tab = await this.readyTab(tabId);
    return this.evaluateMain(tab, `(() => { const body=(document.body?.innerText||'').toLowerCase(); const fields=[...document.querySelectorAll('input,textarea')]; return {
      hasPassword: fields.some(e => e.type==='password' || /password|passwd|passcode/.test([e.name,e.id,e.placeholder,e.autocomplete].join(' ').toLowerCase())),
      hasCaptcha: /captcha|turnstile|cloudflare|验证码/.test(body), hasMfa: /one.?time|verification code|otp|动态口令|多因素/.test(body),
      hasLoginText: /sign in|log in|登录|统一身份/.test(body), hasLoginControl: Boolean(document.querySelector('form input[type=email],form input[name*=user i],form button')) }; })()`);
  }

  async collectChallengeEvidence(tabId: string, expectedTarget?: string): Promise<BrowserChallengeEvidence> {
    const tab = await this.readyTab(tabId);
    const page = await this.evaluateMain<{
      title: string; text: string; markers: string[]; iframeOrigins: string[]; scriptUrls: string[];
    }>(tab, `(() => {
      const all = [...document.querySelectorAll('*')];
      const markerParts = [];
      for (const el of all.slice(0, 4000)) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        const idClass = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
        if (type === 'password') markerParts.push('type-password input-password');
        if (autocomplete === 'current-password') markerParts.push('autocomplete-current-password');
        if (autocomplete === 'one-time-code') markerParts.push('autocomplete-one-time-code input-otp');
        if (/captcha|turnstile|cloudflare|webauthn|passkey|otp|mfa/.test(idClass)) markerParts.push(idClass.slice(0, 180));
        if (tag === 'input' && /otp|mfa|captcha/.test((el.getAttribute('name') || '') + ' ' + (el.getAttribute('aria-label') || ''))) markerParts.push('input-otp');
      }
      markerParts.push('interactive-count-' + document.querySelectorAll('input,button,select,textarea,a[href]').length);
      return {
        title: document.title || '', text: (document.body?.innerText || '').slice(0, 24000),
        markers: [...new Set(markerParts)].slice(0, 120),
        iframeOrigins: [...document.querySelectorAll('iframe[src]')].map(f => { try { return new URL(f.src, location.href).origin; } catch { return ''; } }).filter(Boolean).slice(0, 40),
        scriptUrls: [...document.scripts].map(s => { try { const u=new URL(s.src, location.href); return u.origin + u.pathname; } catch { return ''; } }).filter(Boolean).slice(0, 100),
      };
    })()`).catch(() => ({
      title: tab.title || "",
      text: "",
      markers: [],
      iframeOrigins: [...new Set([...tab.frameUrls.values()].map((value) => {
        try { return new URL(value).origin; } catch { return ""; }
      }).filter(Boolean))].slice(0, 40),
      scriptUrls: [],
    }));
    const fingerprint = JSON.stringify([tab.url, page.title, page.text.slice(0, 4_000), page.markers]);
    const now = Date.now();
    if (tab.lastEvidenceFingerprint !== fingerprint) {
      tab.lastEvidenceFingerprint = fingerprint;
      tab.lastEvidenceChangedAt = now;
    }
    return {
      tabId, mainFrameUrl: exposedUrl(tab.url), frameUrls: [...tab.frameUrls.values()].map(exposedUrl).filter(Boolean),
      title: page.title.slice(0, 500), visibleText: page.text, domMarkers: page.markers,
      iframeOrigins: page.iframeOrigins, scriptUrls: page.scriptUrls, mainFrameStatus: tab.mainFrameStatus,
      responseHeaderNames: [...tab.responseHeaderNames], refreshCount: tab.refreshCount,
      unchangedMs: Math.max(0, now - tab.lastEvidenceChangedAt), expectedTarget: expectedTarget ? exposedUrl(expectedTarget) : undefined,
    };
  }

  async listDialogs(tabId?: string): Promise<BrowserDialogPrompt[]> {
    return [...this.dialogs.values()].filter((dialog) => !tabId || dialog.tabId === tabId);
  }

  async respondDialog(tabId: string, request: { dialogId: string; accept: boolean; promptText?: string }): Promise<void> {
    const dialog = this.dialogs.get(request.dialogId);
    if (!dialog || dialog.tabId !== tabId) throw namedError("STALE_DIALOG", "The browser dialog is stale or missing.");
    if (dialog.sensitive && request.accept) throw namedError("USER_ACTION_REQUIRED", "This sensitive prompt must be handled manually in the visible browser.");
    const tab = await this.readyTab(tabId);
    await this.transport.send("Page.handleJavaScriptDialog", { accept: request.accept, promptText: request.promptText || "" }, tab.sessionId);
    this.dialogs.delete(request.dialogId);
    if (tab.sessionId) this.dialogBySession.delete(tab.sessionId);
  }

  async dismissDialogs(tabId: string): Promise<void> {
    for (const dialog of await this.listDialogs(tabId)) await this.respondDialog(tabId, { dialogId: dialog.id, accept: false }).catch(() => undefined);
  }

  async findDownloadLinks(tabId: string): Promise<BrowserDownloadLink[]> {
    const tab = await this.readyTab(tabId);
    const links = await this.evaluateMain<Array<{ text: string; url: string }>>(tab, `(() => [...document.querySelectorAll('a[href]')].map(a => ({text:(a.innerText||a.textContent||'').trim(),url:a.href})).filter(x => /pdf|download|full.?text/i.test(x.text+' '+x.url)).slice(0,100))()`);
    this.downloadCandidates.clear();
    return links.map((link) => {
      const id = randomUUID();
      this.downloadCandidates.set(id, { tabId, url: link.url });
      return { text: link.text || "Download", url: id };
    });
  }

  async startDownload(tabId: string, request: BrowserDownloadRequest): Promise<BrowserDownloadStartResult> {
    const tab = await this.readyTab(tabId);
    const loaded = this.loadedPdfByTab.get(tabId);
    if (!request.url && !request.candidateId && loaded) {
      const id = randomUUID();
      const fileName = `${id}.pdf`;
      const filePath = path.join(this.downloadsDir, fileName);
      await fs.writeFile(filePath, loaded.bytes);
      const item = this.createCompletedDownload(id, tabId, loaded.url, fileName, loaded.bytes.length, filePath);
      return { jobId: item.id, url: exposedUrl(loaded.url), tabId };
    }
    const candidate = request.candidateId ? this.downloadCandidates.get(request.candidateId) : undefined;
    if (request.candidateId && (!candidate || candidate.tabId !== tabId)) throw new Error("The download candidate is missing or stale.");
    const url = request.url || candidate?.url;
    if (!url) throw new Error("A direct URL or download candidate is required.");
    try { this.debug(`startDownload:path=${new URL(url).pathname}`); } catch { this.debug("startDownload:path=invalid"); }
    const id = randomUUID();
    let resolveCompleted!: (value?: string) => void;
    const completed = new Promise<string | undefined>((resolve) => { resolveCompleted = resolve; });
    const now = new Date().toISOString();
    let fileName = "download.bin";
    try { fileName = safeFileName(path.basename(new URL(url).pathname) || fileName); } catch {}
    const record: DownloadRecord = {
      item: { id, fileName, url: exposedUrl(url), receivedBytes: 0, totalBytes: 0, state: "starting", createdAt: now, updatedAt: now },
      guid: "", tabId, sourceUrl: url, suggestedFileName: fileName, completed, resolveCompleted,
    };
    this.downloadRecords.set(id, record);
    void this.streamDownload(tab, record).catch((error) => {
      this.debug(`streamDownload:error=${error instanceof Error ? error.message : "unknown"}`);
      if (record.item.state !== "cancelled") record.item.state = "interrupted";
      record.item.updatedAt = new Date().toISOString();
      record.resolveCompleted(undefined);
    });
    return { jobId: id, url: exposedUrl(url), tabId };
  }

  async verifyProtectedResource(tabId: string, request: BrowserResourceProbe): Promise<BrowserResourceProbeResult> {
    const tab = await this.readyTab(tabId);
    if (/[?&](?:token|signature|signed|x-amz-signature|expires)=/i.test(request.url)) {
      return { ok: false, detail: "A one-time signed resource URL is not replayed during verification." };
    }
    const timeoutMs = Math.min(15_000, Math.max(500, request.timeoutMs || 10_000));
    try {
      const probe = await this.evaluateMain<{ status: number; type: string; location: string; method: string }>(tab, `(async () => {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          let response = await fetch(${JSON.stringify(request.url)}, {method:'HEAD', redirect:'manual', credentials:'include', signal:controller.signal});
          let method = 'HEAD';
          if (response.status === 405) { response = await fetch(${JSON.stringify(request.url)}, {method:'GET', headers:{Range:'bytes=0-1023'}, redirect:'manual', credentials:'include', signal:controller.signal}); method='GET_RANGE'; }
          return {status:response.status,type:(response.headers.get('content-type')||'').toLowerCase(),location:response.headers.get('location')||'',method};
        } finally { clearTimeout(timer); }
      })()`);
      const returnedHtml = probe.type.includes("text/html");
      const unauthorized = probe.status === 401 || probe.status === 403
        || /(?:login|signin|sso|cas|oauth|authorize)/i.test(probe.location)
        || Boolean(request.expectedPdf && returnedHtml);
      const challengeLikely = [429, 503].includes(probe.status);
      return {
        ok: probe.status >= 200 && probe.status < 400 && !unauthorized && !challengeLikely,
        status: probe.status, returnedHtml, redirectedToLogin: /(?:login|signin|sso|cas|oauth|authorize)/i.test(probe.location),
        unauthorized, challengeLikely, evidenceTypes: [probe.method.toLowerCase(), returnedHtml ? "html_response" : "non_html_response"],
        detail: unauthorized ? "The protected resource still requires authentication." : challengeLikely ? "The protected resource still reports a challenge response." : undefined,
      };
    } catch {
      return { ok: false, detail: "The protected resource could not be verified within the bounded request." };
    }
  }

  async getSessionSummary(): Promise<BrowserSessionSummary> {
    const result = await this.transport.send<{ cookies?: Array<{ expires?: number }> }>("Storage.getCookies");
    const cookies = result.cookies || [];
    return { cookieCount: cookies.length, sessionCookieCount: cookies.filter((cookie) => !cookie.expires || cookie.expires <= 0).length, encryptedBackupAvailable: false };
  }

  async flushPersistentSession(): Promise<void> {
    await this.transport.send("Browser.getVersion");
  }

  async getStorageSummary(tabId?: string): Promise<BrowserStorageSummary> {
    const tab = tabId ? await this.readyTab(tabId) : this.tabsById.get(this.activeTabId);
    const currentOrigin = tab ? this.originFor(tab.url) : "";
    if (currentOrigin) this.visitedOrigins.add(currentOrigin);
    const cookiesResult = await this.transport.send<{ cookies?: Array<{ expires?: number }> }>("Storage.getCookies");
    const cookies = cookiesResult.cookies || [];
    let siteStorageBytes: number | undefined;
    let cacheBytes: number | undefined;
    if (currentOrigin) {
      const usage = await this.transport.send<{ usage?: number; usageBreakdown?: Array<{ storageType?: string; usage?: number }> }>("Storage.getUsageAndQuota", { origin: currentOrigin }).catch(() => null);
      if (usage) {
        siteStorageBytes = Number(usage.usage || 0);
        cacheBytes = (usage.usageBreakdown || []).filter((entry) => /cache/i.test(String(entry.storageType || ""))).reduce((sum, entry) => sum + Number(entry.usage || 0), 0);
      }
    }
    return {
      origin: currentOrigin, cookieCount: cookies.length,
      sessionCookieCount: cookies.filter((cookie) => !cookie.expires || cookie.expires <= 0).length,
      cacheBytes, siteStorageBytes, permissionCount: undefined,
      sessionRecoveryEnabled: false, sessionRecoveryAvailable: false,
      checkedAt: new Date().toISOString(),
    };
  }

  async clearSiteData(tabId: string, options?: { includePermissions?: boolean }): Promise<void> {
    const tab = await this.readyTab(tabId);
    const origin = this.originFor(tab.url);
    if (!origin) throw namedError("SITE_ORIGIN_REQUIRED", "The current tab does not have a clearable HTTP origin.");
    try {
      await this.transport.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, tab.sessionId);
    } catch (error) {
      this.debug(`clearSiteData:failed=${error instanceof Error ? error.name : "unknown"}:${error instanceof Error ? error.message.replace(/https?:\/\/\S+/gi, "[origin]") : "CDP error"}`);
      throw namedError("SITE_DATA_CLEAR_FAILED", "Microsoft Edge could not clear data for the current site.");
    }
    // CDP only exposes a global permission reset. Keep other origins intact for
    // site-scoped clearing; the control center reports this scoped limitation.
    void options;
    tab.revision += 1;
    this.refsByTab.delete(tabId);
  }

  async clearAllBrowserData(): Promise<void> {
    const origins = new Set(this.visitedOrigins);
    const pageSessionId = [...this.tabsById.values()].find((tab) => tab.sessionId)?.sessionId;
    for (const tab of this.tabsById.values()) {
      const origin = this.originFor(tab.url);
      if (origin) origins.add(origin);
    }
    // Clear the HTTP cache while the page session is still stable. Clearing
    // service worker and origin storage first can detach that session in Edge.
    if (pageSessionId) await this.transport.send("Network.clearBrowserCache", {}, pageSessionId, 60_000);
    await this.transport.send("Storage.clearCookies");
    for (const origin of origins) {
      await this.transport.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, pageSessionId).catch(() => undefined);
    }
    await this.transport.send("Browser.resetPermissions");
    for (const tab of this.tabsById.values()) {
      tab.revision += 1;
      this.refsByTab.delete(tab.id);
    }
  }

  getDownloads(): DownloadItem[] {
    return [...this.downloadRecords.values()].map((record) => ({ ...record.item, path: undefined }));
  }

  async waitForDownload(jobId: string): Promise<string | undefined> {
    const record = this.downloadRecords.get(jobId);
    if (!record) throw new Error("The Edge download job was not found.");
    return record.completed;
  }

  getLoadedPdf(tabId: string): { bytes: Buffer; url: string } | undefined {
    return this.loadedPdfByTab.get(tabId);
  }

  async show(): Promise<void> {
    const tab = this.requireTab(this.activeTabId || (await this.listTabs()).activeTabId);
    const window = await this.transport.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: tab.targetId });
    await this.transport.send("Browser.setWindowBounds", { windowId: window.windowId, bounds: { windowState: "normal" } });
    await this.transport.send("Target.activateTarget", { targetId: tab.targetId });
  }

  diagnostics(): { tabs: number; attachedPageSessions: number; executionContexts: number; activeDownloads: number; dialogs: number } {
    return {
      tabs: this.tabsById.size,
      attachedPageSessions: [...this.tabsById.values()].filter((tab) => Boolean(tab.sessionId)).length,
      executionContexts: [...this.tabsById.values()].reduce((sum, tab) => sum + tab.frameContexts.size, 0),
      activeDownloads: [...this.downloadRecords.values()].filter((record) => ["starting", "progressing"].includes(record.item.state)).length,
      dialogs: this.dialogs.size,
    };
  }

  private async syncTargets(): Promise<void> {
    const result = await this.transport.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    const pages = result.targetInfos.filter((target) => target.type === "page");
    this.debug(`syncTargets:pages=${pages.length}`);
    const live = new Set(pages.map((target) => target.targetId));
    for (const target of pages) this.updateTargetInfo(target);
    for (const tab of [...this.tabsById.values()]) if (!live.has(tab.targetId)) this.removeTab(tab);
    for (const tab of this.tabsById.values()) {
      this.debug("syncTargets:attach-start");
      await this.ensureSession(tab).catch(() => undefined);
      this.debug("syncTargets:attach-done");
    }
  }

  private updateTargetInfo(target: TargetInfo): TabRecord | undefined {
    if (target.type !== "page") return undefined;
    let tab = this.tabsByTarget.get(target.targetId);
    if (!tab) {
      const opener = target.openerId ? this.tabsByTarget.get(target.openerId) : undefined;
      tab = {
        id: `edge-tab-${randomUUID()}`, targetId: target.targetId, title: target.title || "Edge page", url: target.url,
        createdAt: new Date().toISOString(), openerTabId: opener?.id, isLoading: false, canGoBack: false, canGoForward: false,
        revision: 0, frameContexts: new Map(), frameOffsets: new Map(), frameUrls: new Map(),
        responseHeaderNames: new Set(), refreshCount: 0, lastMainNavigationAt: Date.now(), lastEvidenceChangedAt: Date.now(),
      };
      this.tabsByTarget.set(tab.targetId, tab);
      this.tabsById.set(tab.id, tab);
      if (!this.activeTabId) this.activeTabId = tab.id;
    } else {
      tab.title = target.title || tab.title;
      tab.url = target.url || tab.url;
      if (target.openerId) tab.openerTabId = this.tabsByTarget.get(target.openerId)?.id;
    }
    const origin = this.originFor(tab.url);
    if (origin) this.visitedOrigins.add(origin);
    return tab;
  }

  private originFor(value: string): string {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.origin : "";
    } catch { return ""; }
  }

  private async ensureSession(tab: TabRecord): Promise<TabRecord> {
    if (tab.sessionId) return tab;
    if (tab.sessionPromise) return tab.sessionPromise;
    tab.sessionPromise = this.attachSession(tab).finally(() => { tab.sessionPromise = undefined; });
    return tab.sessionPromise;
  }

  private async attachSession(tab: TabRecord): Promise<TabRecord> {
    const attached = await this.transport.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    this.debug("ensureSession:attached");
    tab.sessionId = attached.sessionId;
    tab.revision += 1;
    tab.frameContexts.clear();
    this.targetBySession.set(attached.sessionId, tab.targetId);
    await Promise.all([
      this.transport.send("Page.enable", {}, attached.sessionId),
      this.transport.send("Runtime.enable", {}, attached.sessionId),
      this.transport.send("DOM.enable", {}, attached.sessionId),
      this.transport.send("Network.enable", { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 30_000_000 }, attached.sessionId),
    ]);
    this.debug("ensureSession:domains-enabled");
    await this.refreshFrameTree(tab).catch(() => undefined);
    this.debug("ensureSession:frame-tree");
    return tab;
  }

  private async readyTab(tabId: string): Promise<TabRecord> {
    return this.ensureSession(this.requireTab(tabId));
  }

  private async refreshFrameTree(tab: TabRecord): Promise<Array<{ id: string; parentId?: string }>> {
    const result = await this.transport.send<{ frameTree: { frame: { id: string; parentId?: string }; childFrames?: Array<{ frame: { id: string; parentId?: string } }> } }>("Page.getFrameTree", {}, tab.sessionId);
    const main = result.frameTree.frame;
    tab.mainFrameId = main.id;
    const frames = [main, ...(result.frameTree.childFrames || []).map((child) => child.frame)];
    tab.frameOffsets.set(main.id, { x: 0, y: 0 });
    for (const frame of frames.slice(1)) {
      try {
        const owner = await this.transport.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: frame.id }, tab.sessionId);
        const model = await this.transport.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, tab.sessionId);
        tab.frameOffsets.set(frame.id, { x: model.model.content[0] || 0, y: model.model.content[1] || 0 });
      } catch {
        tab.frameOffsets.set(frame.id, { x: 0, y: 0 });
      }
    }
    return frames;
  }

  private async frameContext(tab: TabRecord, frameId: string): Promise<number> {
    const existing = tab.frameContexts.get(frameId);
    if (existing) return existing;
    const result = await this.transport.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: "codex-browser-edge", grantUniveralAccess: false }, tab.sessionId);
    tab.frameContexts.set(frameId, result.executionContextId);
    return result.executionContextId;
  }

  private async captureFrames(tab: TabRecord, maxElements: number, maxText: number, includeElements: boolean): Promise<SnapshotFrameResult[]> {
    const frames = await this.refreshFrameTree(tab);
    const references = new Map<string, RefRecord>();
    let remaining = maxElements;
    const results: SnapshotFrameResult[] = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const frameUrl = tab.frameUrls.get(frame.id) || "";
      if (frameIndex > 0 && isVerificationProviderFrameUrl(frameUrl)) {
        // Keep Turnstile/CAPTCHA frames visually intact and human-operated. In
        // particular, do not create an isolated world in a provider frame just
        // to discover controls that policy would reject as sensitive anyway.
        results.push({ title: "", url: "", text: "", elements: [], links: [], forms: [], authRequired: true });
        continue;
      }
      try {
        if (!tab.sessionId) throw namedError("STALE_SNAPSHOT", "The page session is unavailable after reconnect.");
        const contextId = await this.frameContext(tab, frame.id);
        const offset = tab.frameOffsets.get(frame.id) || { x: 0, y: 0 };
        const prefix = `cb-e${tab.revision}-${frameIndex}-`;
        const result = await this.evaluateContext<SnapshotFrameResult>(contextId, this.snapshotExpression(prefix, includeElements ? remaining : 0, maxText), tab.sessionId);
        for (const element of result.elements) {
          element.rect.x += offset.x;
          element.rect.y += offset.y;
          references.set(element.ref, { ref: element.ref, revision: tab.revision, frameId: frame.id, contextId, sessionId: tab.sessionId, offset, sensitive: element.sensitive, tag: element.tag, type: element.type });
        }
        remaining -= result.elements.length;
        results.push(result);
      } catch {
        results.push({ title: "", url: "", text: "", elements: [], links: [], forms: [], authRequired: false });
      }
    }
    if (includeElements) this.refsByTab.set(tab.id, references);
    return results;
  }

  private snapshotExpression(prefix: string, maxElements: number, maxText: number): string {
    return `(() => {
      const compact=(v,n=500)=>String(v||'').replace(/\\s+/g,' ').trim().slice(0,n);
      const sensitiveRe=${SENSITIVE_PATTERN.toString()};
      const identity=e=>[e.tagName,e.type,e.name,e.id,e.placeholder,e.autocomplete,e.getAttribute?.('aria-label'),e.getAttribute?.('data-testid')].join(' ').toLowerCase();
      const sensitive=e=>{ const i=identity(e); if(['password','hidden','file'].includes(String(e.type||'').toLowerCase())) return true;
        if(/current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(String(e.autocomplete||'').toLowerCase())||sensitiveRe.test(i)) return true;
        if((e.tagName==='BUTTON'||e.type==='submit') && (sensitiveRe.test(compact(e.innerText)) || e.form?.querySelector('input[type=password],[autocomplete=one-time-code]'))) return true;
        return Boolean(e.closest?.('[class*=captcha i],[id*=captcha i],[class*=turnstile i],[id*=turnstile i]')); };
      const role=e=>e.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[e.tagName])||(e.tagName==='INPUT'?(e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':'textbox'):'');
      const candidates=[...document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable=true]')].filter(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}).slice(0,${Math.max(0, maxElements)});
      const elements=candidates.map((e,index)=>{const ref=${JSON.stringify(prefix)}+index; e.setAttribute('data-codex-browser-ref',ref); const r=e.getBoundingClientRect(); const isSensitive=sensitive(e);
        const label=e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.placeholder||e.title||compact(e.innerText)||e.name||e.id||e.tagName.toLowerCase();
        const value=!isSensitive&&!['hidden','file','password'].includes(String(e.type||'').toLowerCase())?compact(e.value,500):undefined;
        return {ref,tag:e.tagName.toLowerCase(),role:role(e),name:isSensitive?(role(e)==='button'?'Sensitive action':'Sensitive input'):compact(label,240),text:isSensitive?'':compact(e.innerText,500),type:e.type||undefined,
          href:isSensitive?undefined:(e.href||undefined),placeholder:isSensitive?undefined:(e.placeholder||undefined),value,disabled:Boolean(e.disabled),checked:'checked'in e?Boolean(e.checked):undefined,sensitive:isSensitive,
          rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; });
      const focused=document.activeElement?.getAttribute?.('data-codex-browser-ref')||undefined;
      const body=compact(document.body?.innerText,${Math.max(1, maxText)}); const lower=body.toLowerCase();
      return {title:compact(document.title,500),url:location.href,text:body,elements,focusedRef:focused,
        links:[...document.querySelectorAll('a[href]')].slice(0,300).map(a=>({text:compact(a.innerText,300),href:a.href})),
        forms:[...document.forms].slice(0,100).map(f=>({action:f.action,method:(f.method||'get').toLowerCase(),hasPassword:Boolean(f.querySelector('input[type=password]'))})),
        authRequired:/sign in|log in|登录|captcha|验证码|verification code|one-time/.test(lower)||elements.some(e=>e.sensitive)};
    })()`;
  }

  private async probeReference(tab: TabRecord, ref: RefRecord, requestedValue = ""): Promise<{ exists: boolean; visible: boolean; hit: boolean; x: number; y: number; width: number; height: number; checked?: boolean; optionIndex?: number }> {
    return this.evaluateContext(ref.contextId, `(() => { const e=document.querySelector('[data-codex-browser-ref="'+CSS.escape(${JSON.stringify(ref.ref)})+'"]'); if(!e)return {exists:false,visible:false,hit:false,x:0,y:0,width:0,height:0};
      const r=e.getBoundingClientRect(),s=getComputedStyle(e),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y); return {exists:true,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',hit:Boolean(hit&&(hit===e||e.contains(hit)||hit.contains?.(e))),x:r.x,y:r.y,width:r.width,height:r.height,checked:'checked'in e?Boolean(e.checked):undefined,
      optionIndex:e.tagName==='SELECT'?[...e.options].findIndex(o=>o.value===${JSON.stringify(requestedValue)}):undefined}; })()`, ref.sessionId);
  }

  private requireRef(tab: TabRecord, ref: string, revision?: number): RefRecord {
    if (revision !== undefined && revision !== tab.revision) throw namedError("STALE_SNAPSHOT", "The page snapshot is stale. Capture a new browser_snapshot for this tab.");
    const record = this.refsByTab.get(tab.id)?.get(ref);
    if (!record || record.revision !== tab.revision) throw namedError("STALE_SNAPSHOT", "The element reference is stale or belongs to another tab.");
    return record;
  }

  private async evaluateMain<T>(tab: TabRecord, expression: string): Promise<T> {
    const frames = await this.refreshFrameTree(tab);
    const contextId = await this.frameContext(tab, frames[0].id);
    if (!tab.sessionId) throw namedError("STALE_SNAPSHOT", "The page session is unavailable after reconnect.");
    return this.evaluateContext(contextId, expression, tab.sessionId);
  }

  private async evaluateContext<T = unknown>(contextId: number, expression: string, sessionId?: string): Promise<T> {
    if (!sessionId) throw namedError("STALE_SNAPSHOT", "The page execution context is stale after navigation or reconnect.");
    const response = await this.transport.send<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
    return resultValue(response);
  }

  private async focusReference(reference: RefRecord): Promise<void> {
    const sessionId = reference.sessionId;
    const response = await this.transport.send<{ result?: { objectId?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: `document.querySelector('[data-codex-browser-ref="'+CSS.escape(${JSON.stringify(reference.ref)})+'"]')`,
      contextId: reference.contextId,
      returnByValue: false,
    }, sessionId);
    const objectId = response.result?.objectId;
    if (!objectId) throw namedError("REF_NOT_FOUND", "The referenced element is missing or changed. Capture a new browser snapshot.");
    try {
      await this.transport.send("DOM.focus", { objectId }, sessionId);
    } finally {
      await this.transport.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
    }
  }

  private async navigateHistory(tabId: string, delta: number): Promise<void> {
    const tab = await this.readyTab(tabId);
    this.assertNoDialog(tabId);
    const history = await this.transport.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory", {}, tab.sessionId);
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return;
    tab.revision += 1;
    this.refsByTab.delete(tabId);
    tab.isLoading = true;
    const loaded = this.transport.waitForEvent("Page.loadEventFired", { sessionId: tab.sessionId, timeoutMs: 20_000 });
    await this.transport.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
    await loaded.catch(() => undefined);
    await this.refreshTabInfo(tabId);
  }

  private async refreshHistory(tab: TabRecord): Promise<void> {
    if (!tab.sessionId) return;
    const history = await this.transport.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {}, tab.sessionId);
    tab.canGoBack = history.currentIndex > 0;
    tab.canGoForward = history.currentIndex < history.entries.length - 1;
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") {
      const info = event.params.targetInfo as TargetInfo | undefined;
      if (info) {
        const tab = this.updateTargetInfo(info);
        if (tab) void this.ensureSession(tab).catch(() => undefined);
      }
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const tab = this.tabsByTarget.get(String(event.params.targetId || ""));
      if (tab) this.removeTab(tab);
      return;
    }
    if (event.method === "Browser.downloadWillBegin" || event.method === "Page.downloadWillBegin") {
      this.debug("event:download-will-begin");
      this.beginDownload(event.params);
      return;
    }
    if (event.method === "Browser.downloadProgress" || event.method === "Page.downloadProgress") {
      this.debug(`event:download-progress:${String(event.params.state || "unknown")}`);
      void this.progressDownload(event.params);
      return;
    }
    if (!event.sessionId) return;
    const tab = this.tabForSession(event.sessionId);
    if (!tab) return;
    if (event.method === "Page.frameStartedLoading") tab.isLoading = true;
    if (event.method === "Page.loadEventFired" || event.method === "Page.frameStoppedLoading") tab.isLoading = false;
    if (event.method === "Page.frameNavigated" || event.method === "Runtime.executionContextsCleared") {
      tab.revision += 1;
      tab.frameContexts.clear();
      this.refsByTab.delete(tab.id);
      void this.refreshTabInfo(tab.id).catch(() => undefined);
    }
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame as { id?: string; parentId?: string; url?: string } | undefined;
      if (frame?.id && frame.url) tab.frameUrls.set(frame.id, frame.url);
      if (frame?.id && !frame.parentId) {
        if (Date.now() - tab.lastMainNavigationAt < 8_000) tab.refreshCount += 1;
        else tab.refreshCount = 0;
        tab.lastMainNavigationAt = Date.now();
      }
    }
    if (event.method === "Page.javascriptDialogOpening") this.openDialog(tab, event.sessionId, event.params);
    if (event.method === "Page.javascriptDialogClosed") {
      const id = this.dialogBySession.get(event.sessionId);
      if (id) this.dialogs.delete(id);
      this.dialogBySession.delete(event.sessionId);
    }
    if (event.method === "Network.responseReceived") {
      const response = event.params.response as { mimeType?: string; url?: string; status?: number; headers?: Record<string, unknown> } | undefined;
      if (String(event.params.type || "") === "Document") {
        tab.mainFrameStatus = Number(response?.status || 0) || undefined;
        tab.responseHeaderNames = new Set(Object.keys(response?.headers || {}).map((name) => name.toLowerCase()).filter((name) => /^(?:cf-ray|cf-mitigated|content-type|location|www-authenticate|server)$/.test(name)));
      }
      if (response?.mimeType?.toLowerCase().includes("pdf")) {
        const map = this.pdfRequestBySession.get(event.sessionId) || new Map();
        map.set(String(event.params.requestId), { tabId: tab.id, url: response.url || tab.url });
        this.pdfRequestBySession.set(event.sessionId, map);
      }
    }
    if (event.method === "Network.loadingFinished") {
      const request = this.pdfRequestBySession.get(event.sessionId)?.get(String(event.params.requestId));
      if (request) void this.capturePdfBody(event.sessionId, String(event.params.requestId), request);
    }
  }

  private openDialog(tab: TabRecord, sessionId: string, params: Record<string, unknown>): void {
    const type = String(params.type || "alert") as BrowserDialogPrompt["type"];
    const message = String(params.message || "").slice(0, 2_000);
    const defaultValue = String(params.defaultPrompt || "").slice(0, 1_000);
    const sensitive = type === "prompt" && SENSITIVE_PATTERN.test(`${message} ${defaultValue}`);
    const id = randomUUID();
    this.dialogs.set(id, { id, tabId: tab.id, type, message: sensitive ? "Sensitive prompt" : message, defaultValue: sensitive ? undefined : defaultValue || undefined, url: exposedUrl(tab.url), sensitive, openedAt: new Date().toISOString() });
    this.dialogBySession.set(sessionId, id);
  }

  private beginDownload(params: Record<string, unknown>): void {
    const guid = String(params.guid || "");
    const frameId = String(params.frameId || "");
    const tab = [...this.tabsById.values()].find((candidate) => candidate.mainFrameId === frameId) || this.tabsById.get(this.activeTabId);
    this.debug(`beginDownload:tab=${tab ? "found" : "missing"}`);
    if (!guid || !tab) return;
    const sourceUrl = String(params.url || tab.url);
    const pending = [...this.downloadRecords.values()].find((record) =>
      record.tabId === tab.id && record.sourceUrl === sourceUrl && record.item.state === "starting" && !record.guid,
    );
    if (pending) {
      pending.guid = guid;
      pending.suggestedFileName = safeFileName(String(params.suggestedFilename || pending.suggestedFileName));
      pending.item.fileName = pending.suggestedFileName;
      pending.item.updatedAt = new Date().toISOString();
      this.downloadIdByGuid.set(guid, pending.item.id);
      return;
    }
    const id = randomUUID();
    let resolveCompleted!: (value?: string) => void;
    const completed = new Promise<string | undefined>((resolve) => { resolveCompleted = resolve; });
    const now = new Date().toISOString();
    const record: DownloadRecord = {
      item: { id, fileName: safeFileName(String(params.suggestedFilename || "download.bin")), url: exposedUrl(sourceUrl), receivedBytes: 0, totalBytes: 0, state: "starting", createdAt: now, updatedAt: now },
      guid, tabId: tab.id, sourceUrl, suggestedFileName: safeFileName(String(params.suggestedFilename || "download.bin")), completed, resolveCompleted,
    };
    this.downloadRecords.set(id, record);
    this.downloadIdByGuid.set(guid, id);
  }

  private async progressDownload(params: Record<string, unknown>): Promise<void> {
    const id = this.downloadIdByGuid.get(String(params.guid || ""));
    const record = id ? this.downloadRecords.get(id) : undefined;
    if (!record) return;
    record.item.receivedBytes = Number(params.receivedBytes || 0);
    record.item.totalBytes = Number(params.totalBytes || 0);
    record.item.updatedAt = new Date().toISOString();
    const state = String(params.state || "inProgress");
    if (state === "inProgress") record.item.state = "progressing";
    if (state === "canceled") {
      record.item.state = "cancelled";
      record.resolveCompleted(undefined);
    }
    if (state === "completed") {
      const sources = [path.join(this.downloadsDir, record.guid), path.join(this.downloadsDir, record.suggestedFileName)];
      const destination = path.join(this.downloadsDir, `${record.item.id}-${record.suggestedFileName}`);
      try {
        const source = (await Promise.all(sources.map(async (candidate) => ({ candidate, exists: await fs.stat(candidate).then(() => true, () => false) })))).find((entry) => entry.exists)?.candidate;
        if (!source) throw new Error("The completed Edge download file was not found in the managed directory.");
        await fs.rename(source, destination);
        record.filePath = destination;
        record.item.state = "completed";
        record.resolveCompleted(destination);
      } catch {
        record.item.state = "interrupted";
        record.resolveCompleted(undefined);
      }
    }
  }

  private createCompletedDownload(id: string, tabId: string, url: string, fileName: string, bytes: number, filePath: string): DownloadItem {
    const now = new Date().toISOString();
    const item: DownloadItem = { id, fileName, url: exposedUrl(url), receivedBytes: bytes, totalBytes: bytes, state: "completed", createdAt: now, updatedAt: now };
    this.downloadRecords.set(id, { item, guid: id, tabId, sourceUrl: url, suggestedFileName: fileName, filePath, completed: Promise.resolve(filePath), resolveCompleted: () => undefined });
    return item;
  }

  private async streamDownload(tab: TabRecord, record: DownloadRecord): Promise<void> {
    if (!tab.sessionId || !tab.mainFrameId) throw new Error("The Edge tab is not ready for a managed download.");
    let streamHandle: string | undefined;
    let temporaryPath: string | undefined;
    try {
      if (isLoopbackUrl(record.sourceUrl)) {
        temporaryPath = path.join(this.downloadsDir, `${record.item.id}.part`);
        const destination = path.join(this.downloadsDir, `${record.item.id}-${record.suggestedFileName}`);
        record.item.state = "progressing";
        await this.streamLoopbackFixture(record, temporaryPath);
        if (record.cancelRequested) {
          record.item.state = "cancelled";
          record.resolveCompleted(undefined);
          return;
        }
        await fs.rename(temporaryPath, destination);
        temporaryPath = undefined;
        record.filePath = destination;
        record.item.totalBytes = record.item.receivedBytes;
        record.item.state = "completed";
        record.item.updatedAt = new Date().toISOString();
        record.resolveCompleted(destination);
        return;
      }
      const loaded = await this.transport.send<{ resource: { success: boolean; httpStatusCode?: number; headers?: Record<string, string>; stream?: string } }>("Network.loadNetworkResource", {
        frameId: tab.mainFrameId,
        url: record.sourceUrl,
        options: { disableCache: true, includeCredentials: true },
      }, tab.sessionId);
      const status = loaded.resource.httpStatusCode || 0;
      const contentType = Object.entries(loaded.resource.headers || {}).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.toLowerCase() || "";
      this.debug(`streamDownload:status=${status}:type=${contentType || "unknown"}`);
      if (!loaded.resource.success || status >= 400 || !loaded.resource.stream) throw new Error("The managed Edge download request failed.");
      if (contentType.includes("text/html") && /\.pdf(?:$|[?#])/i.test(record.sourceUrl)) throw new Error("The PDF download returned an HTML page instead of a PDF.");
      streamHandle = loaded.resource.stream;
      record.streamHandle = streamHandle;
      record.item.state = "progressing";
      temporaryPath = path.join(this.downloadsDir, `${record.item.id}.part`);
      const destination = path.join(this.downloadsDir, `${record.item.id}-${record.suggestedFileName}`);
      const handle = await fs.open(temporaryPath, "w");
      try {
        while (!record.cancelRequested) {
          const chunk = await this.transport.send<{ data: string; base64Encoded?: boolean; eof?: boolean }>("IO.read", { handle: streamHandle, size: 64 * 1024 }, tab.sessionId);
          const bytes = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data, "utf8");
          if (bytes.length) {
            await handle.write(bytes);
            record.item.receivedBytes += bytes.length;
            record.item.updatedAt = new Date().toISOString();
          }
          if (chunk.eof) break;
        }
      } finally {
        await handle.close();
      }
      if (record.cancelRequested) {
        record.item.state = "cancelled";
        record.resolveCompleted(undefined);
        return;
      }
      await fs.rename(temporaryPath, destination);
      temporaryPath = undefined;
      record.filePath = destination;
      record.item.totalBytes = record.item.receivedBytes;
      record.item.state = "completed";
      record.item.updatedAt = new Date().toISOString();
      record.resolveCompleted(destination);
    } finally {
      if (streamHandle) await this.transport.send("IO.close", { handle: streamHandle }, tab.sessionId).catch(() => undefined);
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
      record.streamHandle = undefined;
      record.abortController = undefined;
    }
  }

  private async streamLoopbackFixture(record: DownloadRecord, destination: string): Promise<void> {
    const controller = new AbortController();
    record.abortController = controller;
    const response = await fetch(record.sourceUrl, { redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("The isolated loopback download fixture failed.");
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html") && /\.pdf(?:$|[?#])/i.test(record.sourceUrl)) throw new Error("The PDF download returned an HTML page instead of a PDF.");
    const handle = await fs.open(destination, "w");
    const reader = response.body.getReader();
    try {
      while (!record.cancelRequested) {
        const chunk = await reader.read();
        if (chunk.value?.length) {
          await handle.write(chunk.value);
          record.item.receivedBytes += chunk.value.length;
          record.item.updatedAt = new Date().toISOString();
        }
        if (chunk.done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      await handle.close();
    }
  }

  private async capturePdfBody(sessionId: string, requestId: string, request: { tabId: string; url: string }): Promise<void> {
    try {
      const result = await this.transport.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId }, sessionId);
      const bytes = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body, "binary");
      if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") this.loadedPdfByTab.set(request.tabId, { bytes, url: request.url });
    } catch {
      // Some viewer/network paths do not retain the response body; downloads remain available.
    }
  }

  private tabForSession(sessionId: string): TabRecord | undefined {
    const targetId = this.targetBySession.get(sessionId);
    return targetId ? this.tabsByTarget.get(targetId) : undefined;
  }

  private removeTab(tab: TabRecord): void {
    this.tabsByTarget.delete(tab.targetId);
    this.tabsById.delete(tab.id);
    this.refsByTab.delete(tab.id);
    if (tab.sessionId) this.targetBySession.delete(tab.sessionId);
    for (const [id, dialog] of this.dialogs) if (dialog.tabId === tab.id) this.dialogs.delete(id);
    if (this.activeTabId === tab.id) this.activeTabId = this.tabsById.keys().next().value || "";
  }

  private requireTab(tabId: string): TabRecord {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw namedError("TAB_NOT_FOUND", "The managed Edge tab is missing or closed.");
    return tab;
  }

  private assertNoDialog(tabId: string): void {
    if ([...this.dialogs.values()].some((dialog) => dialog.tabId === tabId)) throw namedError("TAB_WAITING_USER", "The tab has an open webpage dialog.");
  }

  private info(tab: TabRecord): BrowserTabInfo {
    return { id: tab.id, title: tab.title || "Edge page", url: tab.url, isLoading: tab.isLoading, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward };
  }

  private summary(tab: TabRecord): BrowserTabSummary {
    return { ...this.info(tab), state: tab.isLoading ? "WAITING_PAGE" : "READY", active: tab.id === this.activeTabId, attention: [...this.dialogs.values()].some((dialog) => dialog.tabId === tab.id) ? "dialog" : null, createdAt: tab.createdAt, openerTabId: tab.openerTabId };
  }

  private actionResult(action: BrowserAction, tab: TabRecord, beforeUrl: string, description: string): BrowserActionResult {
    return { action: action.action, tabId: tab.id, ref: "ref" in action ? action.ref : undefined, description, url: tab.url, title: tab.title, navigated: tab.url !== beforeUrl };
  }

  private waitResult(tab: TabRecord, request: Parameters<BrowserAdapter["wait"]>[1], startedAt: number, satisfied: boolean, status: "satisfied" | "timeout" | "cancelled"): BrowserWaitResult {
    return { tabId: tab.id, condition: request.condition, satisfied, status, elapsedMs: Date.now() - startedAt, detail: status === "satisfied" ? "Wait condition satisfied." : status === "cancelled" ? "Wait was cancelled." : "Wait condition timed out.", url: tab.url, title: tab.title };
  }

  private async mouse(tab: TabRecord, type: string, x: number, y: number, clickCount = 0): Promise<void> {
    await this.transport.send("Input.dispatchMouseEvent", { type, x, y, button: clickCount ? "left" : "none", clickCount }, tab.sessionId);
  }

  private async click(tab: TabRecord, x: number, y: number, clickCount: number): Promise<void> {
    await this.mouse(tab, "mouseMoved", x, y);
    await this.mouse(tab, "mousePressed", x, y, clickCount);
    let settled = false;
    const release = this.mouse(tab, "mouseReleased", x, y, clickCount).then(() => { settled = true; });
    await Promise.race([release, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (!settled && [...this.dialogs.values()].some((dialog) => dialog.tabId === tab.id)) {
      void release.catch(() => undefined);
      return;
    }
    await release;
  }

  private async selectAll(tab: TabRecord): Promise<void> {
    await this.transport.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", modifiers: 2 }, tab.sessionId);
    await this.transport.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 }, tab.sessionId);
    await this.transport.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, tab.sessionId);
    await this.transport.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft" }, tab.sessionId);
  }

  private async withInputFocus(tab: TabRecord, operation: () => Promise<void>): Promise<void> {
    await this.transport.send("Target.activateTarget", { targetId: tab.targetId });
    await this.transport.send("Page.bringToFront", {}, tab.sessionId);
    await this.transport.send("Emulation.setFocusEmulationEnabled", { enabled: true }, tab.sessionId);
    try {
      await operation();
    } finally {
      // Focus emulation is only needed while dispatching the trusted input. A
      // persistent synthetic focus signal can make later verification widgets
      // observe a browser state that disagrees with the visible window.
      await this.transport.send("Emulation.setFocusEmulationEnabled", { enabled: false }, tab.sessionId).catch(() => undefined);
    }
  }

  private async pressKey(tab: TabRecord, key: string): Promise<void> {
    const codeMap: Record<string, string> = { Enter: "Enter", Home: "Home", End: "End", ArrowDown: "ArrowDown", ArrowUp: "ArrowUp", Tab: "Tab", Escape: "Escape", Space: "Space" };
    const virtualKeyMap: Record<string, number> = { Enter: 13, Home: 36, End: 35, ArrowDown: 40, ArrowUp: 38, Tab: 9, Escape: 27, Space: 32 };
    const code = codeMap[key] || (key.length === 1 ? `Key${key.toUpperCase()}` : key);
    const virtualKeyCode = virtualKeyMap[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
    const text = key.length === 1 ? key : "";
    await this.transport.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown", key, code, text, unmodifiedText: text,
      modifiers: 0, autoRepeat: false, location: 0, isKeypad: false,
      windowsVirtualKeyCode: virtualKeyCode,
    }, tab.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await this.transport.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, text: "", unmodifiedText: "", modifiers: 0,
      autoRepeat: false, location: 0, isKeypad: false, windowsVirtualKeyCode: virtualKeyCode,
    }, tab.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
