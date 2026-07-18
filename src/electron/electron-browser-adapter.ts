import { nativeImage, type NativeImage, type Rectangle, type WebContents } from "electron";
import type {
  BrowserAction,
  BrowserDialogPrompt,
  BrowserStorageSummary,
  BrowserTabSummary,
} from "../shared/contracts";
import type {
  BrowserAdapter,
  BrowserActionPolicyContext,
  BrowserAuthSignals,
  BrowserChallengeEvidence,
  BrowserDownloadLink,
  BrowserBounds,
  BrowserDownloadRequest,
  BrowserDownloadStartResult,
  BrowserResourceProbe,
  BrowserResourceProbeResult,
  BrowserSessionSummary,
  BrowserTabList,
} from "../browser/browser-adapter";
import {
  captureBrowserObservation,
  captureInteractiveSnapshot,
  executeIsolatedPageScript,
  performReferencedAction,
  SENSITIVE_DOM_HELPERS_SCRIPT,
  waitForBrowserCondition,
} from "./browser-actions";

function fixedPageScriptError(error: unknown, fallbackMessage: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("REF_NOT_FOUND:")) {
    const translated = new Error("The element reference is missing or stale. Capture a new browser snapshot.");
    translated.name = "REF_NOT_FOUND";
    return translated;
  }
  const translated = new Error(fallbackMessage);
  translated.name = "PAGE_SCRIPT_ERROR";
  return translated;
}

async function captureManagedPage(contents: WebContents, captureRect?: Rectangle): Promise<NativeImage> {
  try {
    return await contents.capturePage(captureRect);
  } catch (error) {
    if (!(error instanceof Error) || !/display surface not available/i.test(error.message)) throw error;
  }

  const alreadyAttached = contents.debugger.isAttached();
  if (!alreadyAttached) contents.debugger.attach();
  try {
    const captured = await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      ...(captureRect ? {
        clip: {
          x: captureRect.x,
          y: captureRect.y,
          width: captureRect.width,
          height: captureRect.height,
          scale: 1,
        },
      } : {}),
    }) as { data?: string };
    if (!captured.data) throw new Error("The browser returned an empty screenshot.");
    return nativeImage.createFromBuffer(Buffer.from(captured.data, "base64"));
  } finally {
    if (!alreadyAttached && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

interface ElectronBrowserAdapterBindings {
  resolveContents(tabId: string): WebContents;
  listTabs(): BrowserTabList;
  createTab(options?: { url?: string; activate?: boolean }): BrowserTabList & { createdTabId: string };
  selectTab(tabId: string): BrowserTabList;
  closeTab(tabId: string, options?: { force?: boolean }): Promise<BrowserTabList>;
  setViewportBounds(bounds: BrowserBounds): void;
  listDialogs(tabId?: string): BrowserDialogPrompt[];
  respondDialog(tabId: string, request: { dialogId: string; accept: boolean; promptText?: string }): Promise<void>;
  dismissDialogs(tabId: string): Promise<void>;
  startDownload(tabId: string, request: BrowserDownloadRequest): Promise<BrowserDownloadStartResult>;
  verifyProtectedResource(tabId: string, request: BrowserResourceProbe): Promise<BrowserResourceProbeResult>;
  getSessionSummary(): Promise<BrowserSessionSummary>;
  flushPersistentSession(): Promise<void>;
  getStorageSummary(tabId?: string): Promise<BrowserStorageSummary>;
  clearSiteData(tabId: string, options?: { includePermissions?: boolean }): Promise<void>;
  clearAllBrowserData(): Promise<void>;
}

function safeTabLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Browser page";
    return parsed.hostname.slice(0, 253) || "Browser page";
  } catch {
    return "Browser page";
  }
}

function pageScriptError(): Error {
  const error = new Error("The page could not complete the requested browser operation.");
  error.name = "PAGE_SCRIPT_ERROR";
  return error;
}

interface SensitiveScreenshotPlan {
  rects: Rectangle[];
  fullRedaction: boolean;
  viewport: { width: number; height: number };
}

function redactScreenshotBitmap(
  image: NativeImage,
  plan: SensitiveScreenshotPlan,
  captureRect?: Rectangle,
): NativeImage {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  if (size.width <= 0 || size.height <= 0 || bitmap.length !== size.width * size.height * 4) {
    throw new Error("The screenshot could not be safely redacted.");
  }
  const captured = captureRect || {
    x: 0,
    y: 0,
    width: Math.max(1, plan.viewport.width),
    height: Math.max(1, plan.viewport.height),
  };
  const scaleX = size.width / Math.max(1, captured.width);
  const scaleY = size.height / Math.max(1, captured.height);
  const targets = plan.fullRedaction
    ? [captured]
    : plan.rects;
  for (const target of targets) {
    const left = Math.max(captured.x, target.x);
    const top = Math.max(captured.y, target.y);
    const right = Math.min(captured.x + captured.width, target.x + target.width);
    const bottom = Math.min(captured.y + captured.height, target.y + target.height);
    if (right <= left || bottom <= top) continue;
    const startX = Math.max(0, Math.floor((left - captured.x) * scaleX));
    const startY = Math.max(0, Math.floor((top - captured.y) * scaleY));
    const endX = Math.min(size.width, Math.ceil((right - captured.x) * scaleX));
    const endY = Math.min(size.height, Math.ceil((bottom - captured.y) * scaleY));
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * size.width + x) * 4;
        bitmap[offset] = 32;
        bitmap[offset + 1] = 32;
        bitmap[offset + 2] = 32;
        bitmap[offset + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height,
    scaleFactor: 1,
  });
}

export class ElectronWebContentsViewAdapter implements BrowserAdapter {
  readonly kind = "electron-web-contents-view";
  private readonly bindings: ElectronBrowserAdapterBindings;
  private readonly maxScreenshotBytes: number;

  constructor(
    bindings: ElectronBrowserAdapterBindings,
    maxScreenshotBytes = 8 * 1024 * 1024,
  ) {
    this.bindings = bindings;
    this.maxScreenshotBytes = maxScreenshotBytes;
  }

  async listTabs(): Promise<BrowserTabList> {
    return this.bindings.listTabs();
  }

  async createTab(options?: { url?: string; activate?: boolean }): Promise<BrowserTabList & { createdTabId: string }> {
    return this.bindings.createTab(options);
  }

  async selectTab(tabId: string): Promise<BrowserTabList> {
    return this.bindings.selectTab(tabId);
  }

  async closeTab(tabId: string, options?: { force?: boolean }): Promise<BrowserTabList> {
    return this.bindings.closeTab(tabId, options);
  }

  setViewportBounds(bounds: BrowserBounds): void {
    this.bindings.setViewportBounds(bounds);
  }

  getTabInfo(tabId: string) {
    const contents = this.bindings.resolveContents(tabId);
    const history = contents.navigationHistory;
    const url = contents.getURL();
    return {
      id: tabId,
      title: safeTabLabel(url),
      url,
      isLoading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    };
  }

  async refreshTabInfo(tabId: string) {
    return this.getTabInfo(tabId);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    await this.bindings.resolveContents(tabId).loadURL(url);
  }

  async back(tabId: string): Promise<void> {
    const history = this.bindings.resolveContents(tabId).navigationHistory;
    if (history.canGoBack()) history.goBack();
  }

  async forward(tabId: string): Promise<void> {
    const history = this.bindings.resolveContents(tabId).navigationHistory;
    if (history.canGoForward()) history.goForward();
  }

  async reload(tabId: string): Promise<void> {
    this.bindings.resolveContents(tabId).reload();
  }

  async stop(tabId: string): Promise<void> {
    this.bindings.resolveContents(tabId).stop();
  }

  async observe(tabId: string, options: { maxCharacters?: number } = {}) {
    return captureBrowserObservation(this.bindings.resolveContents(tabId), options.maxCharacters);
  }

  async snapshot(tabId: string, options: { maxElements?: number; maxTextCharacters?: number } = {}) {
    return captureInteractiveSnapshot(
      this.bindings.resolveContents(tabId),
      options.maxElements,
      options.maxTextCharacters,
    );
  }

  async act(tabId: string, action: BrowserAction) {
    return performReferencedAction(this.bindings.resolveContents(tabId), action);
  }

  async getActionPolicyContext(tabId: string, action: BrowserAction): Promise<BrowserActionPolicyContext> {
    const contents = this.bindings.resolveContents(tabId);
    const fallbackUrl = contents.getURL();
    if (!("ref" in action) || !action.ref) {
      let origin = ""; let sanitizedUrl = "";
      try { const url = new URL(fallbackUrl); origin = url.origin; sanitizedUrl = `${url.origin}${url.pathname}`; } catch {}
      return { origin, sanitizedUrl, page: { hasPrice: false, hasCurrency: false, area: "ordinary" } };
    }
    try {
      return await executeIsolatedPageScript<BrowserActionPolicyContext>(contents, `(() => {
        ${SENSITIVE_DOM_HELPERS_SCRIPT}
        const e=findReferencedElement(${JSON.stringify(action.ref)}); if(!e) throw new Error('REF_NOT_FOUND');
        const form=e.form||e.closest('form'); const scope=e.closest('section,article,main')||form||e.parentElement;
        const surrounding=compact(scope?.innerText); const heading=compact(scope?.querySelector?.('h1,h2,h3,legend')?.innerText||form?.querySelector?.('legend')?.innerText||document.querySelector('h1,h2,h3')?.innerText,300); const areaText=(heading+' '+surrounding+' '+location.pathname).toLowerCase();
        const area=/checkout|cart|order|payment|结账|订单|支付/.test(areaText)?'checkout':/security|password|mfa|安全|密码/.test(areaText)?'security':/subscription|plan|订阅/.test(areaText)?'subscription':/account|profile|账户|个人资料/.test(areaText)?'account':/message|comment|mail|contact|消息|评论|邮件/.test(areaText)?'communication':/publish|article|post|发布|文章/.test(areaText)?'publication':/search|filter|query|搜索|筛选/.test(areaText)?'search':'ordinary';
        const formText=compact(form?.innerText,1000).toLowerCase(); const href=e.href||e.formAction||''; let targetOrigin; try{targetOrigin=new URL(href,location.href).origin}catch{}
        return {origin:location.origin,sanitizedUrl:location.origin+location.pathname,targetOrigin,element:{role:e.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox'}[e.tagName]||'textbox'),type:e.type||undefined,name:compact(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.placeholder||e.innerText||e.name||e.id||e.tagName,240),text:compact([e.getAttribute('aria-label'),e.labels?.[0]?.innerText,e.innerText].filter(Boolean).join(' ')),sensitive:sensitiveElement(e),href:href?(()=>{try{const u=new URL(href,location.href);return u.origin+u.pathname}catch{return undefined}})():undefined,isSubmit:Boolean(form)&&(e.type==='submit'||(e.tagName==='BUTTON'&&(!e.type||e.type==='submit')))},form:form?{action:(()=>{try{const u=new URL(form.action,location.href);return u.origin+u.pathname}catch{return undefined}})(),method:(form.method||'get').toLowerCase(),hasSensitiveFields:Boolean(form.querySelector('input[type=password],[autocomplete=one-time-code],[data-sensitive]')),hasPersonalInformation:/full name|address|phone|date of birth|identity|passport|姓名|住址|手机号|出生日期|身份证/.test(formText)||Boolean(form.querySelector('[autocomplete=name],[autocomplete=street-address],[autocomplete=tel]')),hasFileInput:Boolean(form.querySelector('input[type=file]')),hasSelectedFile:Boolean(form.querySelector('input[type=file]')?.files?.length)}:undefined,page:{heading,surroundingText:surrounding,hasPrice:/(?:[$€£¥]|usd|eur|gbp|cny|rmb|美元|欧元|人民币)\\s*\\d|\\d[\\d,.]*\\s*(?:usd|eur|gbp|cny|rmb|元)/i.test(surrounding),hasCurrency:/(?:[$€£¥]|usd|eur|gbp|cny|rmb|美元|欧元|人民币)/i.test(surrounding),area}};
      })()`, true);
    } catch (error) { throw fixedPageScriptError(error, "The page action context is stale or unavailable."); }
  }

  async wait(tabId: string, request: Parameters<BrowserAdapter["wait"]>[1]) {
    return waitForBrowserCondition(
      this.bindings.resolveContents(tabId),
      request.condition,
      request.value,
      request.timeoutMs,
    );
  }

  async screenshot(tabId: string, request: Parameters<BrowserAdapter["screenshot"]>[1]) {
    const contents = this.bindings.resolveContents(tabId);
    const maxWidth = Math.min(Math.max(Math.floor(request.maxWidth), 320), 2_048);
    let captureRect: Rectangle | undefined;
    if (request.scope === "element") {
      if (!request.ref) throw new Error("Element screenshots require a ref from browser_snapshot.");
      try {
        captureRect = await executeIsolatedPageScript<Rectangle>(contents, `(async () => {
          ${SENSITIVE_DOM_HELPERS_SCRIPT}
          const element = findReferencedElement(${JSON.stringify(request.ref)});
          if (!element) throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
          revealElement(element);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const rect = absoluteRect(element);
          return {
            x: Math.max(0, Math.floor(rect.x)),
            y: Math.max(0, Math.floor(rect.y)),
            width: Math.max(1, Math.ceil(Math.min(rect.width, innerWidth - Math.max(0, rect.x)))),
            height: Math.max(1, Math.ceil(Math.min(rect.height, innerHeight - Math.max(0, rect.y)))),
          };
        })()`, true) as Rectangle;
      } catch (error) {
        throw fixedPageScriptError(error, "The page could not prepare the requested screenshot.");
      }
    }

    const redactionPlanScript = `(() => {
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      const candidates = new Set();
      let hasSensitiveField = false;
      const visited = traversal();
      const secrets = sensitiveValues();
      for (const candidateRoot of visited.roots) {
        for (const element of candidateRoot.querySelectorAll?.('input,textarea,select,[contenteditable="true"],button,img,canvas,iframe') || []) {
          if (!sensitiveVisual(element)) continue;
          candidates.add(element);
          if (sensitiveElement(element)) hasSensitiveField = true;
        }
      }
      for (const frame of visited.crossOriginFrames) candidates.add(frame);
      const rects = [...candidates]
        .map((element) => absoluteRect(element))
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        rects,
        fullRedaction: hasSensitiveField || secrets.length > 0,
        viewport: { width: innerWidth, height: innerHeight },
      };
    })()`;
    let redactionPlan: SensitiveScreenshotPlan;
    try {
      redactionPlan = await executeIsolatedPageScript<SensitiveScreenshotPlan>(contents, redactionPlanScript, true);
    } catch (error) {
      throw fixedPageScriptError(error, "The page could not prepare safe screenshot redaction.");
    }

    let image = await captureManagedPage(contents, captureRect);
    if (image.isEmpty()) throw new Error("The browser returned an empty screenshot.");
    const postCapturePlan = await executeIsolatedPageScript<SensitiveScreenshotPlan>(contents, redactionPlanScript, true).catch(() => ({
      rects: [],
      fullRedaction: true,
      viewport: redactionPlan.viewport,
    }));
    redactionPlan = {
      rects: [...redactionPlan.rects, ...postCapturePlan.rects],
      fullRedaction: redactionPlan.fullRedaction || postCapturePlan.fullRedaction,
      viewport: redactionPlan.viewport,
    };
    try {
      image = redactScreenshotBitmap(image, redactionPlan, captureRect);
    } catch {
      const error = new Error("The screenshot could not be safely redacted.");
      error.name = "SCREENSHOT_REDACTION_ERROR";
      throw error;
    }
    let size = image.getSize();
    if (size.width > maxWidth) {
      image = image.resize({ width: maxWidth, quality: "good" });
      size = image.getSize();
    }
    let buffer = image.toPNG();
    while (buffer.length > this.maxScreenshotBytes && size.width > 320) {
      image = image.resize({ width: Math.max(320, Math.floor(size.width * 0.8)), quality: "good" });
      size = image.getSize();
      buffer = image.toPNG();
    }
    if (buffer.length > this.maxScreenshotBytes) throw new Error("The screenshot is too large to return through MCP.");
    const metadata = await executeIsolatedPageScript<{ title: string; url: string }>(contents, `(() => {
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      return { title: compact(redactKnownValues(document.title), 500), url: redactKnownValues(location.href, 8000) };
    })()`, true).catch(() => ({ title: "Browser page", url: "" }));
    return {
      bytes: buffer,
      mimeType: "image/png" as const,
      width: size.width,
      height: size.height,
      redactionCount: Math.max(1, redactionPlan.rects.length),
      title: metadata.title,
      url: metadata.url,
    };
  }

  async printToPdf(tabId: string): Promise<Uint8Array> {
    return this.bindings.resolveContents(tabId).printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
  }

  async inspectAuthentication(tabId: string) {
    const contents = this.bindings.resolveContents(tabId);
    try {
      return await executeIsolatedPageScript<BrowserAuthSignals>(contents, `(() => {
        ${SENSITIVE_DOM_HELPERS_SCRIPT}
        const roots = traversal().roots;
        const body = roots
          .filter((root) => root.nodeType === Node.DOCUMENT_NODE)
          .map((root) => root.body?.innerText || '')
          .join('\\n')
          .slice(0, 12000);
        const lower = body.toLowerCase();
        const fields = roots.flatMap((root) => [...(root.querySelectorAll?.('input,textarea,[contenteditable="true"]') || [])]);
        const hasPassword = fields.some((element) => {
          const type = String(element.type || element.getAttribute?.('type') || '').toLowerCase();
          const autocomplete = String(element.autocomplete || element.getAttribute?.('autocomplete') || '').toLowerCase();
          return type === 'password' || /current-password|new-password/.test(autocomplete) || /password|passcode|passwd|credential/.test(identityFor(element));
        });
        const hasCaptcha = fields.some((element) => /captcha|验证码/.test(identityFor(element)))
          || roots.some((root) => Boolean(root.querySelector?.('[class*="captcha" i], [id*="captcha" i], img[alt*="验证码"], iframe[src*="captcha" i], iframe[src*="turnstile" i]')))
          || /验证码|captcha/.test(lower);
        const hasMfa = fields.some((element) => /one-time-code/.test(String(element.autocomplete || '').toLowerCase()) || /otp|one.?time|verification.?code|动态口令/.test(identityFor(element)))
          || /多因素|双重验证|二次验证|动态口令|two-factor|multi-factor|verification code|authenticator/.test(lower);
        const hasLoginText = /统一身份认证|校外访问|登录|sign in|log in|institutional login|access through your institution/.test(lower);
        const hasLoginControl = roots.some((root) => Boolean(root.querySelector?.('form input[type="email"], form input[name*="user" i], form button[type="submit"], input[autocomplete="username"]')));
        return { hasPassword, hasCaptcha, hasMfa, hasLoginText, hasLoginControl };
      })()`, true);
    } catch {
      throw pageScriptError();
    }
  }

  async collectChallengeEvidence(tabId: string, expectedTarget?: string): Promise<BrowserChallengeEvidence> {
    const contents = this.bindings.resolveContents(tabId);
    try {
      const evidence = await executeIsolatedPageScript<Omit<BrowserChallengeEvidence, "tabId" | "mainFrameUrl" | "refreshCount" | "unchangedMs" | "expectedTarget" | "responseHeaderNames">>(contents, `(() => {
        const markers=[];
        for (const el of [...document.querySelectorAll('*')].slice(0,4000)) {
          const type=(el.getAttribute('type')||'').toLowerCase();
          const ac=(el.getAttribute('autocomplete')||'').toLowerCase();
          const identity=((el.id||'')+' '+(typeof el.className==='string'?el.className:'')+' '+(el.getAttribute('name')||'')).toLowerCase();
          if(type==='password') markers.push('type-password input-password');
          if(ac==='current-password') markers.push('autocomplete-current-password');
          if(ac==='one-time-code') markers.push('autocomplete-one-time-code input-otp');
          if(/captcha|turnstile|cloudflare|webauthn|passkey|otp|mfa/.test(identity)) markers.push(identity.slice(0,180));
        }
        markers.push('interactive-count-'+document.querySelectorAll('input,button,select,textarea,a[href]').length);
        return { title:document.title||'', visibleText:(document.body?.innerText||'').slice(0,24000), domMarkers:[...new Set(markers)].slice(0,120),
          frameUrls:[...document.querySelectorAll('iframe[src]')].map(f=>f.src).slice(0,40),
          iframeOrigins:[...document.querySelectorAll('iframe[src]')].map(f=>{try{return new URL(f.src,location.href).origin}catch{return''}}).filter(Boolean).slice(0,40),
          scriptUrls:[...document.scripts].map(s=>{try{const u=new URL(s.src,location.href);return u.origin+u.pathname}catch{return''}}).filter(Boolean).slice(0,100) };
      })()`, true);
      return { ...evidence, tabId, mainFrameUrl: contents.getURL(), responseHeaderNames: [], refreshCount: 0, unchangedMs: 0, expectedTarget };
    } catch {
      throw pageScriptError();
    }
  }

  async listDialogs(tabId?: string): Promise<BrowserDialogPrompt[]> {
    return this.bindings.listDialogs(tabId);
  }

  async respondDialog(tabId: string, request: { dialogId: string; accept: boolean; promptText?: string }): Promise<void> {
    return this.bindings.respondDialog(tabId, request);
  }

  async dismissDialogs(tabId: string): Promise<void> {
    return this.bindings.dismissDialogs(tabId);
  }

  async findDownloadLinks(tabId: string) {
    const contents = this.bindings.resolveContents(tabId);
    try {
      return await executeIsolatedPageScript<BrowserDownloadLink[]>(contents, `(() => {
        ${SENSITIVE_DOM_HELPERS_SCRIPT}
        const patterns = /pdf|download|full[ -]?text|全文|下载/i;
        const seen = new Set();
        const results = [];
        for (const root of traversal().roots) {
          for (const anchor of root.querySelectorAll?.('a[href]') || []) {
            const text = compact(redactKnownValues(anchor.innerText || anchor.getAttribute('aria-label') || ''), 240);
            if (!anchor.href || (!/\\.pdf(?:$|[?#])/i.test(anchor.href) && !patterns.test(text)) || seen.has(anchor.href)) continue;
            seen.add(anchor.href);
            results.push({ text, url: redactKnownValues(anchor.href, 8000) });
            if (results.length >= 40) return results;
          }
        }
        return results;
      })()`, true);
    } catch {
      throw pageScriptError();
    }
  }

  async startDownload(tabId: string, request: BrowserDownloadRequest): Promise<BrowserDownloadStartResult> {
    return this.bindings.startDownload(tabId, request);
  }

  async verifyProtectedResource(tabId: string, request: BrowserResourceProbe): Promise<BrowserResourceProbeResult> {
    return this.bindings.verifyProtectedResource(tabId, request);
  }

  async getSessionSummary(): Promise<BrowserSessionSummary> {
    return this.bindings.getSessionSummary();
  }

  async flushPersistentSession(): Promise<void> {
    return this.bindings.flushPersistentSession();
  }

  async getStorageSummary(tabId?: string): Promise<BrowserStorageSummary> {
    return this.bindings.getStorageSummary(tabId);
  }

  async clearSiteData(tabId: string, options?: { includePermissions?: boolean }): Promise<void> {
    return this.bindings.clearSiteData(tabId, options);
  }

  async clearAllBrowserData(): Promise<void> {
    return this.bindings.clearAllBrowserData();
  }
}

export type { ElectronBrowserAdapterBindings };
