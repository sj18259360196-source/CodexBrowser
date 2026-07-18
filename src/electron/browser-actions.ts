import type { WebContents } from "electron";
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserObservation,
  BrowserWaitCondition,
  BrowserWaitResult,
  InteractivePageSnapshot,
} from "../shared/contracts";

const MAX_ACTION_TEXT = 20_000;
const CODEX_BROWSER_ISOLATED_WORLD_ID = 1_001;

export function executeIsolatedPageScript<T = unknown>(
  contents: WebContents,
  code: string,
  userGesture = false,
): Promise<T> {
  return contents.executeJavaScriptInIsolatedWorld(
    CODEX_BROWSER_ISOLATED_WORLD_ID,
    [{ code }],
    userGesture,
  ) as Promise<T>;
}

// This code runs inside the page and must redact field values before any data
// crosses into the Electron control process.
export const SENSITIVE_DOM_HELPERS_SCRIPT = String.raw`
    const compact = (value, limit = 400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
    const sensitiveElementMemory = window.__codexBrowserSensitiveElements instanceof WeakSet
      ? window.__codexBrowserSensitiveElements
      : new WeakSet();
    window.__codexBrowserSensitiveElements = sensitiveElementMemory;
    const knownSensitiveValues = window.__codexBrowserSensitiveValues instanceof Set
      ? window.__codexBrowserSensitiveValues
      : new Set();
    window.__codexBrowserSensitiveValues = knownSensitiveValues;
    const traversal = () => {
      const roots = [];
      const crossOriginFrames = [];
      const visited = new Set();
      const visit = (root) => {
        if (!root || visited.has(root)) return;
        visited.add(root);
        roots.push(root);
        let candidates = [];
        try { candidates = [...root.querySelectorAll('*')]; } catch { return; }
        for (const candidate of candidates) {
          if (candidate.shadowRoot) visit(candidate.shadowRoot);
          if (String(candidate.tagName || '').toLowerCase() !== 'iframe') continue;
          try {
            const child = candidate.contentDocument;
            if (child?.documentElement) visit(child);
            else crossOriginFrames.push(candidate);
          } catch {
            crossOriginFrames.push(candidate);
          }
        }
      };
      visit(document);
      return { roots, crossOriginFrames };
    };
    const ownerWindow = (element) => element?.ownerDocument?.defaultView || window;
    const absoluteRect = (element) => {
      const rect = element.getBoundingClientRect();
      let x = rect.x;
      let y = rect.y;
      let currentWindow = ownerWindow(element);
      while (currentWindow && currentWindow !== currentWindow.top) {
        const frame = currentWindow.frameElement;
        if (!frame) break;
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.x;
        y += frameRect.y;
        currentWindow = frame.ownerDocument?.defaultView;
      }
      return { x, y, width: rect.width, height: rect.height };
    };
    const revealElement = (element) => {
      element?.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
      let currentWindow = ownerWindow(element);
      while (currentWindow && currentWindow !== currentWindow.top) {
        const frame = currentWindow.frameElement;
        if (!frame) break;
        frame.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
        currentWindow = frame.ownerDocument?.defaultView;
      }
    };
    const isVisible = (element) => {
      const view = ownerWindow(element);
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0 && element.getAttribute('aria-hidden') !== 'true';
    };
    const identityFor = (element) => [
      element?.id,
      element?.getAttribute?.('name'),
      element?.getAttribute?.('placeholder'),
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('data-testid'),
      element?.getAttribute?.('role'),
      element?.getAttribute?.('alt'),
      element?.getAttribute?.('src'),
      element?.getAttribute?.('class'),
    ].filter(Boolean).join(' ').toLowerCase();
    const tagNameFor = (element) => String(element?.tagName || '').toLowerCase();
    const isTag = (element, tagName) => tagNameFor(element) === tagName;
    const labelledText = (element) => {
      const owner = element?.ownerDocument || document;
      const referencedIds = [
        element?.getAttribute?.('aria-labelledby'),
        element?.getAttribute?.('aria-describedby'),
      ].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
      const referenced = referencedIds.map((id) => owner.getElementById(id)?.innerText || '').join(' ');
      const labels = [...(element?.labels || [])].map((label) => label.innerText || '').join(' ');
      return compact(referenced + ' ' + labels, 1000);
    };
    const sensitiveIdentity = (value) => /password|passcode|passwd|pin(?:code)?|otp|one.?time|verification.?code|security.?code|auth(?:entication)?.?code|recovery.?code|captcha|验证码|动态口令|secret|token|credential|private.?key|api[_ -]?key|credit.?card|card.?number|cc-number|cc-csc|cvv|cvc|payment/.test(value);
    const rememberSensitiveValue = (element) => {
      const value = element && 'value' in element ? element.value : element?.textContent;
      if (typeof value === 'string' && value) knownSensitiveValues.add(value);
    };
    const sensitiveField = (element) => {
      if (!element) return false;
      if (sensitiveElementMemory.has(element)) {
        rememberSensitiveValue(element);
        return true;
      }
      const input = isTag(element, 'input') ? element : null;
      const type = String(input?.type || element.getAttribute?.('type') || '').toLowerCase();
      const autocomplete = String(input?.autocomplete || element.getAttribute?.('autocomplete') || '').toLowerCase();
      const sensitive = ['password', 'hidden', 'file'].includes(type)
        || /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/.test(autocomplete)
        || sensitiveIdentity(identityFor(element) + ' ' + labelledText(element).toLowerCase());
      if (sensitive) {
        sensitiveElementMemory.add(element);
        rememberSensitiveValue(element);
      }
      return sensitive;
    };
    const sensitiveSubmissionField = (element) => {
      const input = isTag(element, 'input') ? element : null;
      return input?.type !== 'hidden' && sensitiveField(element);
    };
    const submitControl = (element) => {
      if (isTag(element, 'input')) {
        if (['submit', 'image'].includes(element.type)) return true;
        return element.type === 'button' && /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identityFor(element) + ' ' + String(element.value || '').toLowerCase());
      }
      if (!isTag(element, 'button')) return false;
      if (element.type === 'submit') return true;
      return /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identityFor(element) + ' ' + String(element.innerText || '').toLowerCase());
    };
    const sensitiveElement = (element) => {
      if (sensitiveField(element)) return true;
      if (!submitControl(element)) return false;
      const form = element.form || element.closest?.('form');
      return Boolean(form && [...form.elements].some((field) => sensitiveSubmissionField(field)));
    };
    const sensitiveVisual = (element) => {
      if (sensitiveElement(element)) return true;
      if (isTag(element, 'iframe') && /captcha|turnstile|challenge|verify/.test(identityFor(element))) return true;
      if ((isTag(element, 'img') || isTag(element, 'canvas')) && /captcha|verification.?code|验证码/.test(identityFor(element))) return true;
      return false;
    };
    const findReferencedElement = (ref) => {
      const state = window.__codexBrowserSnapshotState;
      const element = state?.elementsByRef instanceof Map ? state.elementsByRef.get(ref) : null;
      return element?.isConnected ? element : null;
    };
    const focusedElement = () => {
      let active = document.activeElement;
      const visited = new Set();
      while (active && !visited.has(active)) {
        visited.add(active);
        if (active.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
          continue;
        }
        if (isTag(active, 'iframe')) {
          try {
            const nested = active.contentDocument?.activeElement;
            if (nested) { active = nested; continue; }
          } catch {
            return active;
          }
        }
        break;
      }
      return active;
    };
    const sensitiveValues = () => {
      for (const root of traversal().roots) {
        for (const element of root.querySelectorAll?.('input,textarea,select,[contenteditable="true"]') || []) {
          if (!sensitiveField(element)) continue;
        }
      }
      return [...knownSensitiveValues].sort((a, b) => b.length - a.length);
    };
    const redactKnownValues = (value, limit = 100000) => {
      let result = String(value || '');
      for (const secret of sensitiveValues()) result = result.split(secret).join('[Sensitive value]');
      return result.slice(0, limit);
    };
`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function preparePointerTarget(
  contents: WebContents,
  ref: string,
  probeId?: string,
): Promise<{ x: number; y: number; signature: string }> {
  return executeIsolatedPageScript(contents, `(() => {
    ${SENSITIVE_DOM_HELPERS_SCRIPT}
    const ref = ${JSON.stringify(ref)};
    const probeId = ${JSON.stringify(probeId)};
    const target = findReferencedElement(ref);
    if (!target || !target.isConnected) {
      throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
    }
    if (sensitiveElement(target)) {
      throw new Error('USER_ACTION_REQUIRED: This sensitive authentication control must be operated by the user.');
    }
    revealElement(target);
    const localRect = target.getBoundingClientRect();
    const rect = absoluteRect(target);
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('INVALID_ACTION: The referenced element has no clickable area.');
    }
    const x = Math.round(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)));
    const y = Math.round(Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
    const localX = Math.round(localRect.left + localRect.width / 2);
    const localY = Math.round(localRect.top + localRect.height / 2);
    const hit = target.ownerDocument.elementFromPoint(localX, localY);
    if (hit && hit !== target && !target.contains(hit)) {
      throw new Error('INVALID_ACTION: The referenced element is obscured by another element.');
    }
    if (probeId) {
      window.top.__codexBrowserPointerProbe = { id: probeId, hit: null, trusted: false };
      const listener = (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const actual = path[0] instanceof Element ? path[0] : event.target instanceof Element ? event.target : null;
        window.top.__codexBrowserPointerProbe = {
          id: probeId,
          hit: path.includes(target) || event.target === target || target.contains(event.target),
          trusted: event.isTrusted,
          actualTag: actual?.tagName?.toLowerCase?.() || '',
          actualId: actual?.id || '',
          actualRef: actual?.getAttribute?.('data-codex-browser-ref') || '',
        };
      };
      const eventWindow = target.ownerDocument.defaultView || window;
      eventWindow.addEventListener('click', listener, { capture: true, once: true });
      setTimeout(() => eventWindow.removeEventListener('click', listener, true), 1000);
    }
    return {
      x,
      y,
      signature: [
        innerWidth,
        innerHeight,
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
      ].join(':'),
    };
  })()`, true) as Promise<{ x: number; y: number; signature: string }>;
}

async function prepareStablePointerTarget(
  contents: WebContents,
  ref: string,
  probeId?: string,
): Promise<{ x: number; y: number }> {
  let previousSignature = "";
  let stableSamples = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sample = await preparePointerTarget(contents, ref);
    stableSamples = sample.signature === previousSignature ? stableSamples + 1 : 0;
    previousSignature = sample.signature;
    if (stableSamples >= 2) {
      const ready = await preparePointerTarget(contents, ref, probeId);
      return { x: ready.x, y: ready.y };
    }
    await delay(60);
  }
  const ready = await preparePointerTarget(contents, ref, probeId);
  return { x: ready.x, y: ready.y };
}

async function readPointerProbe(
  contents: WebContents,
  probeId: string,
): Promise<{
  hit: boolean | null;
  trusted: boolean;
  actualTag?: string;
  actualId?: string;
  actualRef?: string;
} | null> {
  return executeIsolatedPageScript(contents, `(() => {
    const probe = window.__codexBrowserPointerProbe;
    return probe?.id === ${JSON.stringify(probeId)} ? probe : null;
  })()`, true) as Promise<{
    hit: boolean | null;
    trusted: boolean;
    actualTag?: string;
    actualId?: string;
    actualRef?: string;
  } | null>;
}

async function inspectPointerContext(
  contents: WebContents,
  x: number,
  y: number,
): Promise<{ currentHit: string; focused: boolean; visibility: string }> {
  return executeIsolatedPageScript(contents, `(() => {
    const hit = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    const tag = hit?.tagName?.toLowerCase?.() || '';
    const id = hit?.id ? '#' + hit.id : '';
    const ref = hit?.getAttribute?.('data-codex-browser-ref');
    return {
      currentHit: ref ? tag + '[' + ref + ']' : tag + id,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    };
  })()`, true) as Promise<{ currentHit: string; focused: boolean; visibility: string }>;
}

function translatePageError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("USER_ACTION_REQUIRED:")) {
    const translated = new Error("This sensitive authentication control must be operated by the user.");
    translated.name = "USER_ACTION_REQUIRED";
    return translated;
  }
  if (message.includes("REF_NOT_FOUND:")) {
    const translated = new Error("The element reference is missing or stale. Capture a new browser snapshot.");
    translated.name = "REF_NOT_FOUND";
    return translated;
  }
  if (message.includes("INVALID_ACTION:")) {
    const translated = new Error("The requested action is not valid for this element.");
    translated.name = "INVALID_ACTION";
    return translated;
  }
  const snapshotStage = message.match(/SNAPSHOT_STAGE:([a-z_-]+)/i)?.[1];
  if (snapshotStage) {
    const translated = new Error(`The page snapshot failed during the ${snapshotStage} stage.`);
    translated.name = "PAGE_SCRIPT_ERROR";
    return translated;
  }
  const translated = new Error("The page could not complete the requested browser operation.");
  translated.name = "PAGE_SCRIPT_ERROR";
  return translated;
}

async function assertActionTargetStillSafe(contents: WebContents, ref?: string): Promise<void> {
  try {
    await executeIsolatedPageScript(contents, `(() => {
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      const target = ${JSON.stringify(ref)} ? findReferencedElement(${JSON.stringify(ref)}) : focusedElement();
      if (!target || !target.isConnected) {
        throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
      }
      if (sensitiveElement(target)) {
        throw new Error('USER_ACTION_REQUIRED: This sensitive authentication control must be operated by the user.');
      }
    })()`, true);
  } catch (error) {
    throw translatePageError(error);
  }
}

async function captureSanitizedPageMetadata(contents: WebContents): Promise<{ title: string; url: string }> {
  try {
    return await executeIsolatedPageScript(contents, `(() => {
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      return {
        title: compact(redactKnownValues(document.title), 500),
        url: redactKnownValues(location.href, 8000),
      };
    })()`, true) as { title: string; url: string };
  } catch {
    return { title: "Browser page", url: "" };
  }
}

export async function captureBrowserObservation(
  contents: WebContents,
  maxCharacters = 30_000,
): Promise<BrowserObservation> {
  const textLimit = Math.min(Math.max(Math.floor(maxCharacters), 1_000), 100_000);
  try {
    return await executeIsolatedPageScript(contents, `(() => {
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      const roots = traversal().roots;
      const links = [];
      const forms = [];
      for (const root of roots) {
        for (const anchor of root.querySelectorAll?.('a[href]') || []) {
          if (links.length >= 120) break;
          links.push({
            text: compact(redactKnownValues(anchor.innerText || anchor.getAttribute('aria-label') || ''), 240),
            href: redactKnownValues(anchor.href, 8000),
          });
        }
        for (const form of root.querySelectorAll?.('form') || []) {
          if (forms.length >= 30) break;
          forms.push({
            action: redactKnownValues(form.action || form.ownerDocument?.location?.href || location.href, 8000),
            method: String(form.method || 'get').toLowerCase(),
            hasPassword: [...form.elements].some((element) => sensitiveField(element)),
          });
        }
      }
      const text = redactKnownValues(roots
        .filter((root) => root.nodeType === Node.DOCUMENT_NODE)
        .map((root) => root.body?.innerText || '')
      .join('\\n'), ${textLimit});
      return {
        title: compact(redactKnownValues(document.title), 500),
        url: redactKnownValues(location.href, 8000),
        text,
        links,
        forms,
        authRequired: forms.some((form) => form.hasPassword) || /统一身份认证|校外访问|验证码|sign in|log in/i.test(text.slice(0, 6000)),
        capturedAt: new Date().toISOString(),
      };
    })()`, true) as BrowserObservation;
  } catch (error) {
    throw translatePageError(error);
  }
}

export async function captureInteractiveSnapshot(
  contents: WebContents,
  maxElements = 140,
  maxTextCharacters = 24_000,
): Promise<InteractivePageSnapshot> {
  const elementLimit = Math.min(Math.max(Math.floor(maxElements), 1), 300);
  const textLimit = Math.min(Math.max(Math.floor(maxTextCharacters), 1_000), 100_000);

  try {
    return await executeIsolatedPageScript(contents, `(() => {
    let snapshotStage = 'helpers';
    try {
    ${SENSITIVE_DOM_HELPERS_SCRIPT}
    snapshotStage = 'state';
    const elementLimit = ${elementLimit};
    const textLimit = ${textLimit};
    const stateKey = '__codexBrowserSnapshotState';
    const previousState = window[stateKey];
    const pageState = previousState && previousState.refs instanceof WeakMap
      ? previousState
      : { counter: 0, revision: 0, refs: new WeakMap() };
    if (!Number.isSafeInteger(pageState.counter) || pageState.counter < 0) pageState.counter = 0;
    if (!Number.isSafeInteger(pageState.revision) || pageState.revision < 0) pageState.revision = 0;
    pageState.revision += 1;
    pageState.elementsByRef = new Map();
    window[stateKey] = pageState;
    snapshotStage = 'roles';
    const roleFor = (element, allowExplicit = true) => {
      const explicit = String(element.getAttribute('role') || '').toLowerCase();
      const allowedRoles = new Set([
        'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'textbox', 'combobox',
        'option', 'switch', 'slider', 'spinbutton', 'searchbox', 'listbox', 'treeitem',
        'gridcell', 'row', 'cell', 'img',
      ]);
      if (allowExplicit && allowedRoles.has(explicit)) return explicit;
      const tag = tagNameFor(element);
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        if (element.type === 'checkbox') return 'checkbox';
        if (element.type === 'radio') return 'radio';
        if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
        return 'textbox';
      }
      return element.tagName.toLowerCase();
    };
    const safeNameFor = (element) => compact(redactKnownValues(
      element.getAttribute('aria-label') || labelledText(element) || element.labels?.[0]?.innerText ||
      element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') ||
      element.innerText || element.tagName.toLowerCase(),
    ), 240);

    const selector = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const seen = new Set();
    const elements = [];
    const roots = traversal().roots;
    snapshotStage = 'elements';
    for (const root of roots) {
      for (const element of root.querySelectorAll(selector)) {
        if (elements.length >= elementLimit || seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        snapshotStage = 'element_ref';
        let ref = pageState.refs.get(element);
        if (typeof ref !== 'string' || !/^cb-e\d+$/.test(ref)) {
          pageState.counter += 1;
          ref = 'cb-e' + pageState.counter;
          pageState.refs.set(element, ref);
        }
        pageState.elementsByRef.set(ref, element);
        element.setAttribute('data-codex-browser-ref', ref);
        snapshotStage = 'element_rect';
        const rect = absoluteRect(element);
        snapshotStage = 'element_classification';
        const isSensitive = sensitiveElement(element);
        const isField = sensitiveField(element);
        snapshotStage = 'element_value';
        const value = !isSensitive && 'value' in element ? compact(redactKnownValues(element.value), 500) : undefined;
        snapshotStage = 'element_result';
        elements.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role: roleFor(element, !isSensitive),
          name: isSensitive ? (isField ? 'Sensitive input' : 'Sensitive action') : safeNameFor(element),
          text: isSensitive ? '' : compact(redactKnownValues(element.innerText || ''), 500),
          type: tagNameFor(element) === 'input' ? element.type : undefined,
          href: !isSensitive && tagNameFor(element) === 'a' ? redactKnownValues(element.href, 8000) : undefined,
          placeholder: !isSensitive ? (compact(redactKnownValues(element.getAttribute('placeholder') || ''), 500) || undefined) : undefined,
          value,
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
          checked: 'checked' in element ? Boolean(element.checked) : undefined,
          sensitive: isSensitive,
          rect: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
          },
        });
      }
    }
    snapshotStage = 'focus';
    const activeElement = focusedElement();
    const focused = activeElement ? pageState.refs.get(activeElement) : undefined;
    const focusedRef = typeof focused === 'string' && pageState.elementsByRef.get(focused) === activeElement
      ? focused
      : undefined;
    snapshotStage = 'text';
    const bodyText = redactKnownValues(roots
      .filter((root) => root.nodeType === Node.DOCUMENT_NODE)
      .map((root) => root.body?.innerText || '')
      .join('\\n'), textLimit);
    snapshotStage = 'result';
    return {
      revision: pageState.revision,
      title: compact(redactKnownValues(document.title), 500),
      url: redactKnownValues(location.href, 8000),
      text: bodyText,
      elements,
      focusedRef,
      authRequired: elements.some((element) => element.sensitive) || /统一身份认证|校外访问|验证码|sign in|log in|two-factor|multi-factor/i.test(bodyText.slice(0, 8000)),
      capturedAt: new Date().toISOString(),
    };
    } catch {
      throw new Error('SNAPSHOT_STAGE:' + snapshotStage);
    }
    })()`, true) as InteractivePageSnapshot;
  } catch (error) {
    throw translatePageError(error);
  }
}

export async function performReferencedAction(contents: WebContents, action: BrowserAction): Promise<BrowserActionResult> {
  const supportedActions: BrowserAction["action"][] = [
    "click",
    "double_click",
    "hover",
    "check",
    "uncheck",
    "fill",
    "press",
    "select",
    "focus",
    "scroll",
  ];
  if (!action || !supportedActions.includes(action.action)) {
    const error = new Error("Unsupported browser action.");
    error.name = "INVALID_ACTION";
    throw error;
  }
  if (action.action !== "scroll" && action.action !== "press" && !("ref" in action && action.ref)) {
    const error = new Error("This action requires an element reference from browser_snapshot.");
    error.name = "INVALID_ACTION";
    throw error;
  }
  if (action.action === "fill" && typeof action.text !== "string") {
    const error = new Error("Fill requires text.");
    error.name = "INVALID_ACTION";
    throw error;
  }
  if (action.action === "select" && typeof action.value !== "string") {
    const error = new Error("Select requires an option value.");
    error.name = "INVALID_ACTION";
    throw error;
  }
  if (action.action === "press" && typeof action.key !== "string") {
    const error = new Error("Press requires a keyboard key.");
    error.name = "INVALID_ACTION";
    throw error;
  }
  if (action.action === "fill" && action.text.length > MAX_ACTION_TEXT) {
    throw new Error(`Fill text is limited to ${MAX_ACTION_TEXT} characters.`);
  }

  const urlBefore = contents.getURL();
  let description = "page";

  try {
    if (["click", "double_click", "hover", "check", "uncheck"].includes(action.action) && contents.debugger.isAttached()) {
      await contents.debugger.sendCommand("Page.bringToFront").catch(() => undefined);
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    }
    const result = (await executeIsolatedPageScript(contents, `(async () => {
      const action = ${JSON.stringify(action)};
      ${SENSITIVE_DOM_HELPERS_SCRIPT}
      const element = action.ref
        ? findReferencedElement(action.ref)
        : focusedElement();
      if (action.action !== 'scroll' && !element) {
        throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
      }
      const describe = (target) => compact(redactKnownValues(
        target?.getAttribute?.('aria-label') || target?.labels?.[0]?.innerText || target?.getAttribute?.('placeholder') || target?.innerText || target?.getAttribute?.('name') || target?.tagName || 'page'
      ), 240);
      const highlight = (target) => {
        target?.animate?.([
          { outline: '3px solid rgba(38, 128, 95, .9)', outlineOffset: '2px' },
          { outline: '3px solid rgba(38, 128, 95, 0)', outlineOffset: '5px' }
        ], { duration: 900, easing: 'ease-out' });
      };
      const pointerPosition = async (target) => {
        revealElement(target);
        await Promise.race([
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        if (!target.isConnected) {
          throw new Error('REF_NOT_FOUND: Element reference became stale after scrolling. Capture a new browser snapshot.');
        }
        if (sensitiveElement(target)) {
          throw new Error('USER_ACTION_REQUIRED: This sensitive authentication control must be operated by the user.');
        }
        const localRect = target.getBoundingClientRect();
        const rect = absoluteRect(target);
        if (rect.width <= 0 || rect.height <= 0) {
          throw new Error('INVALID_ACTION: The referenced element has no clickable area.');
        }
        const x = Math.round(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)));
        const y = Math.round(Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
        const hit = target.ownerDocument.elementFromPoint(localRect.left + localRect.width / 2, localRect.top + localRect.height / 2);
        if (hit && hit !== target && !target.contains(hit)) {
          throw new Error('INVALID_ACTION: The referenced element is obscured by another element.');
        }
        return { x, y };
      };

      if (action.action === 'scroll') {
        const root = document.scrollingElement || document.documentElement;
        root.scrollLeft += Number(action.deltaX || 0);
        root.scrollTop += Number(action.deltaY || 0);
        window.dispatchEvent(new Event('scroll'));
        return { description: 'page at ' + Math.round(root.scrollLeft) + ',' + Math.round(root.scrollTop), keyInput: false };
      }
      if (sensitiveElement(element)) {
        throw new Error('USER_ACTION_REQUIRED: This sensitive authentication control must be operated by the user.');
      }
      if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
        throw new Error('INVALID_ACTION: The referenced element is disabled.');
      }

      const elementDescription = describe(element);
      revealElement(element);
      highlight(element);
      if (['click', 'double_click', 'hover'].includes(action.action)) {
        return {
          description: elementDescription,
          keyInput: false,
          pointerInput: { kind: action.action, ...await pointerPosition(element) },
        };
      } else if (action.action === 'check' || action.action === 'uncheck') {
        const desired = action.action === 'check';
        const nativeCheckable = tagNameFor(element) === 'input' && ['checkbox', 'radio'].includes(element.type);
        const roleCheckable = element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'radio';
        if (!nativeCheckable && !roleCheckable) {
          throw new Error('INVALID_ACTION: The referenced element is not a checkbox or radio control.');
        }
        if (!desired && ((tagNameFor(element) === 'input' && element.type === 'radio') || element.getAttribute('role') === 'radio')) {
          throw new Error('INVALID_ACTION: Radio controls cannot be unchecked directly.');
        }
        const checked = nativeCheckable ? Boolean(element.checked) : element.getAttribute('aria-checked') === 'true';
        return {
          description: elementDescription,
          keyInput: false,
          checkState: desired,
          pointerInput: checked === desired ? undefined : { kind: 'click', ...await pointerPosition(element) },
        };
      } else if (action.action === 'focus') {
        element.focus();
      } else if (action.action === 'fill') {
        if (['input', 'textarea'].includes(tagNameFor(element))) {
          if (tagNameFor(element) === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(element.type)) {
            throw new Error('INVALID_ACTION: This element cannot be filled as text.');
          }
          let prototype = Object.getPrototypeOf(element);
          let setter;
          while (prototype && !setter) {
            setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            prototype = Object.getPrototypeOf(prototype);
          }
          setter?.call(element, action.text);
          const InputEventConstructor = ownerWindow(element).InputEvent || InputEvent;
          element.dispatchEvent(new InputEventConstructor('input', { bubbles: true, inputType: 'insertText', data: null }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (element.isContentEditable) {
          element.textContent = action.text;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        } else {
          throw new Error('INVALID_ACTION: The referenced element is not a text field.');
        }
      } else if (action.action === 'select') {
        if (tagNameFor(element) !== 'select') {
          throw new Error('INVALID_ACTION: The referenced element is not a select field.');
        }
        if (![...element.options].some((option) => option.value === action.value)) {
          throw new Error('INVALID_ACTION: The requested select value does not exist.');
        }
        element.value = action.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (action.action === 'press') {
        element.focus?.();
        window.top.__codexBrowserKeyProbe = { expected: action.key, seen: false };
        element.ownerDocument.addEventListener('keydown', (event) => {
          if (window.top.__codexBrowserKeyProbe && event.key === window.top.__codexBrowserKeyProbe.expected) {
            window.top.__codexBrowserKeyProbe.seen = true;
          }
        }, { capture: true, once: true });
        return { description: elementDescription, keyInput: true };
      } else {
        throw new Error('INVALID_ACTION: Unsupported browser action.');
      }
      return { description: elementDescription, keyInput: false };
    })()`, true)) as { description: string; keyInput: boolean };
    description = result.description || description;

    const pointerResult = result as {
      description: string;
      keyInput: boolean;
      pointerInput?: { kind: "click" | "double_click" | "hover"; x: number; y: number };
      checkState?: boolean;
    };
    if (pointerResult.pointerInput) {
      const { kind } = pointerResult.pointerInput;
      const pointerRef = "ref" in action ? action.ref : undefined;
      if (!pointerRef) throw new Error("Pointer actions require an element reference.");
      contents.focus();
      await delay(80);
      const maxAttempts = kind === "hover" ? 1 : 2;
      let pointerDelivered = kind === "hover";
      let deliveryDetail = "no event observed";
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const probeId = kind === "hover"
          ? undefined
          : `cb-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const { x, y } = await prepareStablePointerTarget(contents, pointerRef, probeId);
        contents.focus();
        const dispatchMouse = async (
          type: "mouseMoved" | "mousePressed" | "mouseReleased",
          clickCount = 0,
        ): Promise<void> => {
          if (contents.debugger.isAttached()) {
            await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: type === "mouseMoved" ? "none" : "left",
              clickCount,
              pointerType: "mouse",
            });
            return;
          }
          const fallbackType = type === "mouseMoved"
            ? "mouseMove"
            : type === "mousePressed" ? "mouseDown" : "mouseUp";
          contents.sendInputEvent({
            type: fallbackType,
            x,
            y,
            ...(type === "mouseMoved" ? {} : { button: "left", clickCount }),
          });
        };
        await dispatchMouse("mouseMoved");
        if (kind === "hover") break;
        await dispatchMouse("mousePressed", 1);
        await delay(25);
        await dispatchMouse("mouseReleased", 1);
        if (kind === "double_click") {
          await delay(70);
          await dispatchMouse("mousePressed", 2);
          await delay(25);
          await dispatchMouse("mouseReleased", 2);
        }
        await delay(80);
        try {
          const probe = await readPointerProbe(contents, probeId!);
          pointerDelivered = probe?.hit === true && probe.trusted;
          const context = await inspectPointerContext(contents, x, y);
          const actual = probe?.actualTag
            ? `${probe.actualTag}${probe.actualId ? `#${probe.actualId}` : ""}${probe.actualRef ? `[${probe.actualRef}]` : ""}`
            : "none";
          deliveryDetail = `event=${probe?.hit == null ? "none" : probe.hit ? "target" : actual}; current=${context.currentHit || "none"}; focused=${context.focused}; visibility=${context.visibility}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Execution context was destroyed|Inspected target navigated|ERR_ABORTED/i.test(message)) {
            pointerDelivered = true;
          } else {
            throw error;
          }
        }
        if (pointerDelivered) break;
        await delay(80);
      }
      if (!pointerDelivered) {
        const error = new Error(`The trusted pointer event did not reach the referenced element (${deliveryDetail}).`);
        error.name = "INVALID_ACTION";
        throw error;
      }
      await delay(90);
    }

    if (typeof pointerResult.checkState === "boolean") {
      const checked = await executeIsolatedPageScript(contents, `(() => {
        ${SENSITIVE_DOM_HELPERS_SCRIPT}
        const action = ${JSON.stringify(action)};
        const target = findReferencedElement(action.ref);
        if (tagNameFor(target) === 'input' && ['checkbox', 'radio'].includes(target.type)) return target.checked;
        if (target?.getAttribute('role') === 'checkbox' || target?.getAttribute('role') === 'radio') {
          return target.getAttribute('aria-checked') === 'true';
        }
        return null;
      })()`, true) as boolean | null;
      if (checked !== pointerResult.checkState) {
        const error = new Error(`The referenced control did not become ${pointerResult.checkState ? "checked" : "unchecked"}.`);
        error.name = "INVALID_ACTION";
        throw error;
      }
    }

    if (action.action === "press" && result.keyInput) {
      const key = action.key.trim();
      if (!key || key.length > 40) {
        throw new Error("Invalid keyboard key.");
      }
      contents.focus();
      await delay(40);
      await assertActionTargetStillSafe(contents, action.ref);
      contents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key.length === 1) {
        contents.sendInputEvent({ type: "char", keyCode: key });
      }
      contents.sendInputEvent({ type: "keyUp", keyCode: key });
      await delay(80);
      await executeIsolatedPageScript(contents, `(() => {
        ${SENSITIVE_DOM_HELPERS_SCRIPT}
        const probe = window.__codexBrowserKeyProbe;
        if (probe?.seen) return true;
        const action = ${JSON.stringify(action)};
        const target = action.ref
          ? findReferencedElement(action.ref)
          : focusedElement();
        if (!target) return false;
        if (sensitiveElement(target)) return false;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, code: action.key, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, code: action.key, bubbles: true, cancelable: true }));
        return false;
      })()`, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["click", "double_click"].includes(action.action) && /Execution context was destroyed|Inspected target navigated|ERR_ABORTED/i.test(message)) {
      description = "clicked element";
    } else {
      throw translatePageError(error);
    }
  }

  await delay(220);
  if (contents.isLoading()) {
    await waitForLoadStop(contents, 10_000);
  }
  const metadata = await captureSanitizedPageMetadata(contents);
  return {
    action: action.action,
    ref: "ref" in action ? action.ref : undefined,
    description,
    url: metadata.url,
    title: metadata.title,
    navigated: metadata.url ? metadata.url !== urlBefore : contents.getURL() !== urlBefore,
  };
}

export async function waitForBrowserCondition(
  contents: WebContents,
  condition: BrowserWaitCondition,
  value: string | undefined,
  timeoutMs = 10_000,
): Promise<BrowserWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.min(Math.max(Math.floor(timeoutMs), 100), 20_000);
  let satisfied = false;
  let detail = "";

  if (condition === "load" || condition === "idle") {
    if (contents.isLoading()) {
      satisfied = await waitForLoadStop(contents, timeout);
    } else {
      if (condition === "idle") await delay(Math.min(300, timeout));
      satisfied = true;
    }
    detail = satisfied ? "Page loading is complete." : "Timed out while waiting for page loading to finish.";
  } else if (condition === "url") {
    if (!value) throw new Error("A URL substring is required.");
    satisfied = await waitForUrl(contents, value, timeout);
    detail = satisfied ? "URL condition matched." : "URL condition did not match before timeout.";
  } else if (condition === "text" || condition === "selector") {
    if (!value) throw new Error(`A ${condition} value is required.`);
    satisfied = await waitForDomCondition(contents, condition, value, timeout);
    detail = satisfied ? `${condition} condition matched.` : `${condition} condition did not match before timeout.`;
  }

  const metadata = await captureSanitizedPageMetadata(contents);
  return {
    condition,
    satisfied,
    elapsedMs: Date.now() - startedAt,
    detail,
    url: metadata.url,
    title: metadata.title,
  };
}

function waitForLoadStop(contents: WebContents, timeoutMs: number): Promise<boolean> {
  if (!contents.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      contents.removeListener("did-stop-loading", onStop);
      resolve(value);
    };
    const onStop = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    contents.once("did-stop-loading", onStop);
  });
}

function waitForUrl(contents: WebContents, expected: string, timeoutMs: number): Promise<boolean> {
  if (contents.getURL().includes(expected)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      contents.removeListener("did-navigate", check);
      contents.removeListener("did-navigate-in-page", check);
      resolve(value);
    };
    const check = () => {
      if (contents.getURL().includes(expected)) finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    contents.on("did-navigate", check);
    contents.on("did-navigate-in-page", check);
  });
}

async function waitForDomCondition(
  contents: WebContents,
  condition: "text" | "selector",
  value: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      return await executeIsolatedPageScript<boolean>(contents, `new Promise((resolve) => {
        const condition = ${JSON.stringify(condition)};
        const value = ${JSON.stringify(value)};
        const timeout = ${Math.min(remaining, 20_000)};
        const matches = () => {
          if (condition === 'text') return (document.body?.innerText || '').includes(value);
          try { return Boolean(document.querySelector(value)); } catch { return false; }
        };
        if (matches()) { resolve(true); return; }
        const observer = new MutationObserver(() => {
          if (matches()) { observer.disconnect(); clearTimeout(timer); resolve(true); }
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
      })`, true);
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) throw translatePageError(error);
      await delay(120);
    }
  }
  return false;
}
