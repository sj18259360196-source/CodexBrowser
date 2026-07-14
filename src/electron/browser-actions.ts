import type { WebContents } from "electron";
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserWaitCondition,
  BrowserWaitResult,
  InteractivePageSnapshot,
} from "../shared/contracts";

const MAX_ACTION_TEXT = 20_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function preparePointerTarget(
  contents: WebContents,
  ref: string,
  probeId?: string,
): Promise<{ x: number; y: number; signature: string }> {
  return contents.executeJavaScript(`(() => {
    const ref = ${JSON.stringify(ref)};
    const probeId = ${JSON.stringify(probeId)};
    const target = document.querySelector('[data-codex-browser-ref="' + CSS.escape(ref) + '"]');
    if (!target || !target.isConnected) {
      throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
    }
    target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('INVALID_ACTION: The referenced element has no clickable area.');
    }
    const x = Math.round(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)));
    const y = Math.round(Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== target && !target.contains(hit)) {
      throw new Error('INVALID_ACTION: The referenced element is obscured by another element.');
    }
    if (probeId) {
      window.__codexBrowserPointerProbe = { id: probeId, hit: null, trusted: false };
      const listener = (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const actual = path[0] instanceof Element ? path[0] : event.target instanceof Element ? event.target : null;
        window.__codexBrowserPointerProbe = {
          id: probeId,
          hit: path.includes(target) || event.target === target || target.contains(event.target),
          trusted: event.isTrusted,
          actualTag: actual?.tagName?.toLowerCase?.() || '',
          actualId: actual?.id || '',
          actualRef: actual?.getAttribute?.('data-codex-browser-ref') || '',
        };
      };
      window.addEventListener('click', listener, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', listener, true), 1000);
    }
    return {
      x,
      y,
      signature: [
        innerWidth,
        innerHeight,
        Math.round(rect.left),
        Math.round(rect.top),
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
  return contents.executeJavaScript(`(() => {
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
  return contents.executeJavaScript(`(() => {
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
    const translated = new Error(message.split("USER_ACTION_REQUIRED:").slice(1).join("USER_ACTION_REQUIRED:").trim());
    translated.name = "USER_ACTION_REQUIRED";
    return translated;
  }
  if (message.includes("REF_NOT_FOUND:")) {
    const translated = new Error(message.split("REF_NOT_FOUND:").slice(1).join("REF_NOT_FOUND:").trim());
    translated.name = "REF_NOT_FOUND";
    return translated;
  }
  if (message.includes("INVALID_ACTION:")) {
    const translated = new Error(message.split("INVALID_ACTION:").slice(1).join("INVALID_ACTION:").trim());
    translated.name = "INVALID_ACTION";
    return translated;
  }
  return error instanceof Error ? error : new Error(message);
}

export async function captureInteractiveSnapshot(
  contents: WebContents,
  maxElements = 140,
  maxTextCharacters = 24_000,
): Promise<InteractivePageSnapshot> {
  const elementLimit = Math.min(Math.max(Math.floor(maxElements), 1), 300);
  const textLimit = Math.min(Math.max(Math.floor(maxTextCharacters), 1_000), 100_000);

  return contents.executeJavaScript(`(() => {
    const elementLimit = ${elementLimit};
    const textLimit = ${textLimit};
    const stateKey = '__codexBrowserSnapshotState';
    const pageState = window[stateKey] || { counter: 0, revision: 0 };
    pageState.revision += 1;
    window[stateKey] = pageState;

    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0 && element.getAttribute('aria-hidden') !== 'true';
    };
    const labelledText = (element) => {
      const ids = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      return ids.map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
    };
    const compact = (value, limit = 400) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    const sensitiveField = (element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const type = (input?.type || '').toLowerCase();
      const autocomplete = (input?.autocomplete || '').toLowerCase();
      const identity = [element.id, element.getAttribute('name'), element.getAttribute('placeholder'), element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
      return ['password', 'hidden', 'file'].includes(type) ||
        /current-password|new-password|one-time-code/.test(autocomplete) ||
        /password|passcode|passwd|otp|one.?time|verification.?code|验证码|动态口令|secret|token/.test(identity);
    };
    const sensitiveSubmissionField = (element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      return input?.type !== 'hidden' && sensitiveField(element);
    };
    const submitControl = (element) => {
      if (element instanceof HTMLInputElement) {
        if (['submit', 'image'].includes(element.type)) return true;
        const identity = [element.id, element.name, element.value, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
        return element.type === 'button' && /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identity);
      }
      if (!(element instanceof HTMLButtonElement)) return false;
      if (element.type === 'submit') return true;
      const identity = [element.id, element.name, element.value, element.innerText, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
      return /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identity);
    };
    const sensitive = (element) => {
      if (sensitiveField(element)) return true;
      if (!submitControl(element)) return false;
      const form = element.closest('form');
      return Boolean(form && [...form.querySelectorAll('input, textarea, select')].some((field) => sensitiveSubmissionField(field)));
    };
    const roleFor = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      if (element instanceof HTMLAnchorElement) return 'link';
      if (element instanceof HTMLButtonElement) return 'button';
      if (element instanceof HTMLSelectElement) return 'combobox';
      if (element instanceof HTMLTextAreaElement) return 'textbox';
      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') return 'checkbox';
        if (element.type === 'radio') return 'radio';
        if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
        return 'textbox';
      }
      return element.tagName.toLowerCase();
    };
    const nameFor = (element) => compact(
      element.getAttribute('aria-label') ||
      labelledText(element) ||
      element.labels?.[0]?.innerText ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      (element instanceof HTMLInputElement ? element.value : '') ||
      element.tagName.toLowerCase(),
      240,
    );

    const selector = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const seen = new Set();
    const elements = [];
    for (const element of document.querySelectorAll(selector)) {
      if (elements.length >= elementLimit || seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      let ref = element.getAttribute('data-codex-browser-ref');
      if (!ref) {
        pageState.counter += 1;
        ref = 'cb-e' + pageState.counter;
        element.setAttribute('data-codex-browser-ref', ref);
      }
      const rect = element.getBoundingClientRect();
      const isSensitive = sensitive(element);
      const value = !isSensitive && 'value' in element ? compact(element.value, 500) : undefined;
      elements.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        name: nameFor(element),
        text: compact(element.innerText || '', 500),
        type: element instanceof HTMLInputElement ? element.type : undefined,
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
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
    const focused = document.activeElement?.getAttribute?.('data-codex-browser-ref') || undefined;
    const bodyText = (document.body?.innerText || '').slice(0, textLimit);
    return {
      revision: pageState.revision,
      title: document.title,
      url: location.href,
      text: bodyText,
      elements,
      focusedRef: focused,
      authRequired: elements.some((element) => element.sensitive) || /统一身份认证|校外访问|验证码|sign in|log in|two-factor|multi-factor/i.test(bodyText.slice(0, 8000)),
      capturedAt: new Date().toISOString(),
    };
  })()`, true) as Promise<InteractivePageSnapshot>;
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
    const result = (await contents.executeJavaScript(`(async () => {
      const action = ${JSON.stringify(action)};
      const compact = (value, limit = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
      const element = action.ref
        ? document.querySelector('[data-codex-browser-ref="' + CSS.escape(action.ref) + '"]')
        : document.activeElement;
      if (action.action !== 'scroll' && !element) {
        throw new Error('REF_NOT_FOUND: Element reference is missing or stale. Capture a new browser snapshot.');
      }
      const sensitiveField = (target) => {
        if (!target) return false;
        const input = target instanceof HTMLInputElement ? target : null;
        const type = (input?.type || '').toLowerCase();
        const autocomplete = (input?.autocomplete || '').toLowerCase();
        const identity = [target.id, target.getAttribute('name'), target.getAttribute('placeholder'), target.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
        return ['password', 'hidden', 'file'].includes(type) ||
          /current-password|new-password|one-time-code/.test(autocomplete) ||
          /password|passcode|passwd|otp|one.?time|verification.?code|验证码|动态口令|secret|token/.test(identity);
      };
      const sensitiveSubmissionField = (target) => {
        const input = target instanceof HTMLInputElement ? target : null;
        return input?.type !== 'hidden' && sensitiveField(target);
      };
      const submitControl = (target) => {
        if (target instanceof HTMLInputElement) {
          if (['submit', 'image'].includes(target.type)) return true;
          const identity = [target.id, target.name, target.value, target.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
          return target.type === 'button' && /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identity);
        }
        if (!(target instanceof HTMLButtonElement)) return false;
        if (target.type === 'submit') return true;
        const identity = [target.id, target.name, target.value, target.innerText, target.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
        return /(?:^|[^a-z])(login|log.?in|sign.?in|submit|continue|verify|authenticate)(?:[^a-z]|$)|登录|登入|认证|验证|确认/.test(identity);
      };
      const sensitive = (target) => {
        if (!target) return false;
        if (sensitiveField(target)) return true;
        if (!submitControl(target)) return false;
        const form = target.closest?.('form');
        return Boolean(form && [...form.querySelectorAll('input, textarea, select')].some((field) => sensitiveSubmissionField(field)));
      };
      const describe = (target) => compact(
        target?.getAttribute?.('aria-label') || target?.labels?.[0]?.innerText || target?.getAttribute?.('placeholder') || target?.innerText || target?.getAttribute?.('name') || target?.tagName || 'page'
      );
      const reveal = (target) => {
        target?.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
      };
      const highlight = (target) => {
        target?.animate?.([
          { outline: '3px solid rgba(38, 128, 95, .9)', outlineOffset: '2px' },
          { outline: '3px solid rgba(38, 128, 95, 0)', outlineOffset: '5px' }
        ], { duration: 900, easing: 'ease-out' });
      };
      const pointerPosition = async (target) => {
        reveal(target);
        await Promise.race([
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        if (!target.isConnected) {
          throw new Error('REF_NOT_FOUND: Element reference became stale after scrolling. Capture a new browser snapshot.');
        }
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          throw new Error('INVALID_ACTION: The referenced element has no clickable area.');
        }
        const x = Math.round(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)));
        const y = Math.round(Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
        const hit = document.elementFromPoint(x, y);
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
      if (sensitive(element)) {
        throw new Error('USER_ACTION_REQUIRED: This element belongs to a password, verification, hidden, file-upload, or other sensitive authentication form. The user must operate it manually.');
      }
      if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
        throw new Error('INVALID_ACTION: The referenced element is disabled.');
      }

      const elementDescription = describe(element);
      reveal(element);
      highlight(element);
      if (['click', 'double_click', 'hover'].includes(action.action)) {
        return {
          description: elementDescription,
          keyInput: false,
          pointerInput: { kind: action.action, ...await pointerPosition(element) },
        };
      } else if (action.action === 'check' || action.action === 'uncheck') {
        const desired = action.action === 'check';
        const nativeCheckable = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
        const roleCheckable = element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'radio';
        if (!nativeCheckable && !roleCheckable) {
          throw new Error('INVALID_ACTION: The referenced element is not a checkbox or radio control.');
        }
        if (!desired && ((element instanceof HTMLInputElement && element.type === 'radio') || element.getAttribute('role') === 'radio')) {
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
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          if (element instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(element.type)) {
            throw new Error('INVALID_ACTION: This element cannot be filled as text.');
          }
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          setter?.call(element, action.text);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (element.isContentEditable) {
          element.textContent = action.text;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        } else {
          throw new Error('INVALID_ACTION: The referenced element is not a text field.');
        }
      } else if (action.action === 'select') {
        if (!(element instanceof HTMLSelectElement)) {
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
        window.__codexBrowserKeyProbe = { expected: action.key, seen: false };
        document.addEventListener('keydown', (event) => {
          if (window.__codexBrowserKeyProbe && event.key === window.__codexBrowserKeyProbe.expected) {
            window.__codexBrowserKeyProbe.seen = true;
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
      const checked = await contents.executeJavaScript(`(() => {
        const action = ${JSON.stringify(action)};
        const target = document.querySelector('[data-codex-browser-ref="' + CSS.escape(action.ref) + '"]');
        if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) return target.checked;
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
      contents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key.length === 1) {
        contents.sendInputEvent({ type: "char", keyCode: key });
      }
      contents.sendInputEvent({ type: "keyUp", keyCode: key });
      await delay(80);
      await contents.executeJavaScript(`(() => {
        const probe = window.__codexBrowserKeyProbe;
        if (probe?.seen) return true;
        const action = ${JSON.stringify(action)};
        const target = action.ref
          ? document.querySelector('[data-codex-browser-ref="' + CSS.escape(action.ref) + '"]')
          : document.activeElement;
        if (!target) return false;
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
  const url = contents.getURL();
  return {
    action: action.action,
    ref: "ref" in action ? action.ref : undefined,
    description,
    url,
    title: contents.getTitle(),
    navigated: url !== urlBefore,
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
    detail = satisfied ? `URL contains ${value}.` : `URL did not contain ${value} before timeout.`;
  } else if (condition === "text" || condition === "selector") {
    if (!value) throw new Error(`A ${condition} value is required.`);
    satisfied = await waitForDomCondition(contents, condition, value, timeout);
    detail = satisfied ? `${condition} condition matched.` : `${condition} condition did not match before timeout.`;
  }

  return {
    condition,
    satisfied,
    elapsedMs: Date.now() - startedAt,
    detail,
    url: contents.getURL(),
    title: contents.getTitle(),
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
      return await contents.executeJavaScript(`new Promise((resolve) => {
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
      })`, true) as Promise<boolean>;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) throw translatePageError(error);
      await delay(120);
    }
  }
  return false;
}
