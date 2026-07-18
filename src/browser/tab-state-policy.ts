import type { BrowserTabState } from "../shared/contracts";

export type HandleCommandMethodPolicy =
  | "read"
  | "tab_mutation"
  | "browser_mutation"
  | "control"
  | "verification"
  | "local_mutation";

export const HANDLE_COMMAND_METHOD_POLICY = {
  "browser.capabilities": "read",
  "browser.status": "read",
  "browser.storage_summary": "read",
  "browser.profile_status": "read",
  "browser.confirmation_status": "read",
  "browser.confirmation_respond": "control",
  "browser.grants_list": "read",
  "browser.grant_revoke": "local_mutation",
  "browser.tabs": "read",
  "browser.tab_new": "browser_mutation",
  "browser.tab_select": "control",
  "browser.tab_close": "tab_mutation",
  "browser.navigate": "tab_mutation",
  "browser.observe": "read",
  "browser.snapshot": "read",
  "browser.act": "tab_mutation",
  "browser.wait": "read",
  "browser.back": "tab_mutation",
  "browser.forward": "tab_mutation",
  "browser.reload": "tab_mutation",
  "browser.screenshot": "read",
  "browser.dialogs": "read",
  "browser.dialog_respond": "tab_mutation",
  "browser.pause": "control",
  "browser.resume": "control",
  "browser.stop": "control",
  "session.check": "verification",
  "auth.complete": "verification",
  "auth.request_login": "tab_mutation",
  "auth.clear": "control",
  "browser.assistance_request": "control",
  "browser.assistance_status": "read",
  "browser.assistance_complete": "verification",
  "tasks.clear": "local_mutation",
  "downloads.clear": "local_mutation",
  "paper.find_downloads": "read",
  "paper.download": "tab_mutation",
  "downloads.list": "read",
  "document.import": "local_mutation",
  "document.list": "read",
  "document.read": "read",
  "document.search": "read",
} as const satisfies Record<string, HandleCommandMethodPolicy>;

export type HandleCommandMethod = keyof typeof HANDLE_COMMAND_METHOD_POLICY;

export interface TabStateSnapshot {
  tabId: string;
  state: BrowserTabState;
  generation: number;
}

export interface TabOperationGeneration {
  tabId: string;
  tabGeneration: number;
  globalStopGeneration: number;
}

export type TabStatePolicyErrorName = "TAB_WAITING_USER" | "TAB_VERIFYING" | "TAB_CLOSED" | "PAUSED_BY_USER" | "TASK_STOPPED";

export class TabStatePolicyError extends Error {
  readonly code: TabStatePolicyErrorName;

  constructor(code: TabStatePolicyErrorName, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

const ALLOWED_TRANSITIONS: Record<BrowserTabState, ReadonlySet<BrowserTabState>> = {
  READY: new Set(["RUNNING", "WAITING_PAGE", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"]),
  RUNNING: new Set(["READY", "WAITING_PAGE", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"]),
  WAITING_PAGE: new Set(["READY", "RUNNING", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"]),
  WAITING_USER: new Set(["VERIFYING", "ERROR", "CLOSED"]),
  VERIFYING: new Set(["READY", "WAITING_USER", "ERROR", "CLOSED"]),
  PAUSED_BY_USER: new Set(["READY", "ERROR", "CLOSED"]),
  ERROR: new Set(["READY", "CLOSED"]),
  CLOSED: new Set(),
};

const MUTATION_BLOCKING_STATES = new Set<BrowserTabState>([
  "WAITING_USER",
  "VERIFYING",
  "PAUSED_BY_USER",
  "CLOSED",
]);

function requiredTabId(tabId: string): string {
  const normalized = tabId.trim();
  if (!normalized) {
    const error = new Error("A non-empty browser tab ID is required.");
    error.name = "TAB_ID_REQUIRED";
    throw error;
  }
  return normalized;
}

function unknownTabError(tabId: string): Error {
  const error = new Error(`Browser tab ${tabId} is not registered.`);
  error.name = "TAB_NOT_FOUND";
  return error;
}

export function getHandleCommandMethodPolicy(method: string): HandleCommandMethodPolicy {
  if (Object.prototype.hasOwnProperty.call(HANDLE_COMMAND_METHOD_POLICY, method)) {
    return HANDLE_COMMAND_METHOD_POLICY[method as HandleCommandMethod];
  }
  const error = new Error(`Unknown browser command: ${method}`);
  error.name = "UNKNOWN_BROWSER_COMMAND";
  throw error;
}

export function isMutationBlockingTabState(state: BrowserTabState): boolean {
  return MUTATION_BLOCKING_STATES.has(state);
}

export class TabStateController {
  private readonly tabs = new Map<string, TabStateSnapshot>();
  private readonly removedGenerations = new Map<string, number>();
  private globalStopGeneration = 0;

  register(tabId: string, state: BrowserTabState = "READY"): TabStateSnapshot {
    const normalized = requiredTabId(tabId);
    if (this.tabs.has(normalized)) {
      const error = new Error(`Browser tab ${normalized} is already registered.`);
      error.name = "TAB_ALREADY_REGISTERED";
      throw error;
    }
    const snapshot: TabStateSnapshot = {
      tabId: normalized,
      state,
      generation: (this.removedGenerations.get(normalized) ?? -1) + 1,
    };
    this.tabs.set(normalized, snapshot);
    return { ...snapshot };
  }

  remove(tabId: string): boolean {
    const normalized = requiredTabId(tabId);
    const snapshot = this.tabs.get(normalized);
    if (!snapshot) return false;
    this.removedGenerations.set(normalized, snapshot.generation);
    return this.tabs.delete(normalized);
  }

  get(tabId: string): TabStateSnapshot {
    const normalized = requiredTabId(tabId);
    const snapshot = this.tabs.get(normalized);
    if (!snapshot) throw unknownTabError(normalized);
    return { ...snapshot };
  }

  list(): TabStateSnapshot[] {
    return [...this.tabs.values()].map((snapshot) => ({ ...snapshot }));
  }

  transition(tabId: string, nextState: BrowserTabState): TabStateSnapshot {
    const normalized = requiredTabId(tabId);
    const current = this.tabs.get(normalized);
    if (!current) throw unknownTabError(normalized);
    if (current.state === nextState) return { ...current };
    if (!ALLOWED_TRANSITIONS[current.state].has(nextState)) {
      const error = new Error(`Invalid browser tab state transition: ${current.state} -> ${nextState}.`);
      error.name = "INVALID_TAB_STATE_TRANSITION";
      throw error;
    }

    const wasBlocked = isMutationBlockingTabState(current.state);
    const becomesBlocked = isMutationBlockingTabState(nextState);
    current.state = nextState;
    if ((!wasBlocked && becomesBlocked) || nextState === "CLOSED") current.generation += 1;
    return { ...current };
  }

  captureOperation(tabId: string): TabOperationGeneration {
    const snapshot = this.get(tabId);
    return {
      tabId: snapshot.tabId,
      tabGeneration: snapshot.generation,
      globalStopGeneration: this.globalStopGeneration,
    };
  }

  assertOperationCurrent(operation: TabOperationGeneration): void {
    const current = this.tabs.get(operation.tabId);
    if (
      !current
      || current.generation !== operation.tabGeneration
      || this.globalStopGeneration !== operation.globalStopGeneration
    ) {
      throw new TabStatePolicyError("TASK_STOPPED", "The queued browser task was stopped before it started.");
    }
  }

  assertMutationAllowed(tabId: string, operation?: TabOperationGeneration): void {
    const snapshot = this.get(tabId);
    if (snapshot.state === "WAITING_USER") {
      throw new TabStatePolicyError(
        "TAB_WAITING_USER",
        "The browser tab is waiting for the user to complete a required action.",
      );
    }
    if (snapshot.state === "VERIFYING") {
      throw new TabStatePolicyError("TAB_VERIFYING", "The browser tab is verifying a completed user action.");
    }
    if (snapshot.state === "CLOSED") {
      throw new TabStatePolicyError("TAB_CLOSED", "The browser tab is closed.");
    }
    if (snapshot.state === "PAUSED_BY_USER") {
      throw new TabStatePolicyError("PAUSED_BY_USER", "Codex control for this browser tab is paused by the user.");
    }
    if (operation) this.assertOperationCurrent(operation);
  }

  assertCommandAllowed(
    method: string,
    tabId?: string,
    operation?: TabOperationGeneration,
  ): HandleCommandMethodPolicy {
    const policy = getHandleCommandMethodPolicy(method);
    if (policy === "tab_mutation") {
      const targetTabId = requiredTabId(tabId || "");
      if (operation && operation.tabId !== targetTabId) {
        throw new TabStatePolicyError("TASK_STOPPED", "The queued browser task no longer targets this tab.");
      }
      this.assertMutationAllowed(targetTabId, operation);
    } else if (operation) {
      this.assertOperationCurrent(operation);
    }
    return policy;
  }

  stopAll(): number {
    this.globalStopGeneration += 1;
    return this.globalStopGeneration;
  }

  getGlobalStopGeneration(): number {
    return this.globalStopGeneration;
  }
}
