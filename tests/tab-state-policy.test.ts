import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserTabState } from "../src/shared/contracts.ts";
import {
  HANDLE_COMMAND_METHOD_POLICY,
  TabStatePolicyError,
  TabStateController,
  getHandleCommandMethodPolicy,
  isMutationBlockingTabState,
  type HandleCommandMethodPolicy,
  type TabStatePolicyErrorName,
} from "../src/browser/tab-state-policy.ts";

function hasErrorName(expectedName: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.name === expectedName;
}

function hasPolicyError(expectedCode: TabStatePolicyErrorName): (error: unknown) => boolean {
  return (error) => error instanceof TabStatePolicyError
    && error.name === expectedCode
    && error.code === expectedCode;
}

const browserTabStates = [
  "READY",
  "RUNNING",
  "WAITING_PAGE",
  "WAITING_USER",
  "VERIFYING",
  "PAUSED_BY_USER",
  "ERROR",
  "CLOSED",
] as const satisfies readonly BrowserTabState[];

const expectedTransitions = {
  READY: ["RUNNING", "WAITING_PAGE", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"],
  RUNNING: ["READY", "WAITING_PAGE", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"],
  WAITING_PAGE: ["READY", "RUNNING", "WAITING_USER", "PAUSED_BY_USER", "ERROR", "CLOSED"],
  WAITING_USER: ["VERIFYING", "ERROR", "CLOSED"],
  VERIFYING: ["READY", "WAITING_USER", "ERROR", "CLOSED"],
  PAUSED_BY_USER: ["READY", "ERROR", "CLOSED"],
  ERROR: ["READY", "CLOSED"],
  CLOSED: [],
} as const satisfies Record<BrowserTabState, readonly BrowserTabState[]>;

for (const from of browserTabStates) {
  for (const to of browserTabStates) {
    if (from === to) continue;
    const allowed = expectedTransitions[from].includes(to as never);
    test(`${allowed ? "allows" : "rejects"} tab state transition ${from} -> ${to}`, () => {
      const controller = new TabStateController();
      controller.register("tab-a", from);
      if (allowed) {
        assert.equal(controller.transition("tab-a", to).state, to);
        assert.equal(controller.get("tab-a").state, to);
      } else {
        assert.throws(
          () => controller.transition("tab-a", to),
          hasErrorName("INVALID_TAB_STATE_TRANSITION"),
        );
      }
    });
  }
}

test("transitioning to the current state is an idempotent no-op", () => {
  const controller = new TabStateController();
  const initial = controller.register("tab-a", "WAITING_USER");
  const next = controller.transition("tab-a", "WAITING_USER");

  assert.deepEqual(next, initial);
});

test("only human-wait, verification, and user-pause states block mutations", () => {
  const expectedBlockingStates = new Set<BrowserTabState>([
    "WAITING_USER",
    "VERIFYING",
    "PAUSED_BY_USER",
    "CLOSED",
  ]);
  for (const state of browserTabStates) {
    assert.equal(isMutationBlockingTabState(state), expectedBlockingStates.has(state), state);
  }
});

const expectedMethodsByPolicy = {
  read: [
    "browser.capabilities",
    "browser.status",
    "browser.storage_summary",
    "browser.profile_status",
    "browser.tabs",
    "browser.observe",
    "browser.snapshot",
    "browser.wait",
    "browser.screenshot",
    "browser.dialogs",
    "browser.assistance_status",
    "browser.confirmation_status",
    "browser.grants_list",
    "paper.find_downloads",
    "downloads.list",
    "document.list",
    "document.read",
    "document.search",
  ],
  tab_mutation: [
    "browser.tab_close",
    "browser.navigate",
    "browser.act",
    "browser.back",
    "browser.forward",
    "browser.reload",
    "browser.dialog_respond",
    "auth.request_login",
    "paper.download",
  ],
  browser_mutation: ["browser.tab_new"],
  control: [
    "browser.tab_select",
    "browser.pause",
    "browser.resume",
    "browser.stop",
    "auth.clear",
    "browser.assistance_request",
    "browser.confirmation_respond",
  ],
  verification: ["session.check", "auth.complete", "browser.assistance_complete"],
  local_mutation: ["tasks.clear", "downloads.clear", "document.import", "browser.grant_revoke"],
} as const satisfies Record<HandleCommandMethodPolicy, readonly string[]>;

for (const [policy, methods] of Object.entries(expectedMethodsByPolicy)) {
  test(`classifies all ${policy} handleCommand methods`, () => {
    for (const method of methods) {
      assert.equal(getHandleCommandMethodPolicy(method), policy);
    }
  });
}

test("the command classification fixture covers the complete handleCommand policy table", () => {
  const expectedMethods = Object.values(expectedMethodsByPolicy).flat().sort();
  assert.deepEqual(Object.keys(HANDLE_COMMAND_METHOD_POLICY).sort(), expectedMethods);
});

const mutationBlockingCases = [
  { state: "WAITING_USER", error: "TAB_WAITING_USER" },
  { state: "VERIFYING", error: "TAB_VERIFYING" },
  { state: "PAUSED_BY_USER", error: "PAUSED_BY_USER" },
  { state: "CLOSED", error: "TAB_CLOSED" },
] as const satisfies ReadonlyArray<{
  state: BrowserTabState;
  error: TabStatePolicyErrorName;
}>;

for (const { state, error } of mutationBlockingCases) {
  test(`${state} rejects every tab mutation while preserving reads and verification`, () => {
    const controller = new TabStateController();
    controller.register("tab-a", state);

    for (const method of expectedMethodsByPolicy.tab_mutation) {
      assert.throws(
        () => controller.assertCommandAllowed(method, "tab-a"),
        hasPolicyError(error),
        method,
      );
    }
    for (const method of expectedMethodsByPolicy.read) {
      assert.equal(controller.assertCommandAllowed(method, "tab-a"), "read", method);
    }
    for (const method of expectedMethodsByPolicy.verification) {
      assert.equal(controller.assertCommandAllowed(method, "tab-a"), "verification", method);
    }
  });
}

test("WAITING_USER blocks only its own tab and preserves another tab's queued generation", () => {
  const controller = new TabStateController();
  controller.register("tab-a", "RUNNING");
  controller.register("tab-b", "RUNNING");
  const tabAOperation = controller.captureOperation("tab-a");
  const tabBOperation = controller.captureOperation("tab-b");

  controller.transition("tab-a", "WAITING_USER");

  assert.throws(() => controller.assertOperationCurrent(tabAOperation), hasPolicyError("TASK_STOPPED"));
  assert.doesNotThrow(() => controller.assertOperationCurrent(tabBOperation));
  assert.equal(
    controller.assertCommandAllowed("browser.navigate", "tab-b", tabBOperation),
    "tab_mutation",
  );
  assert.equal(controller.assertCommandAllowed("browser.tab_new"), "browser_mutation");
});

test("entering WAITING_USER rejects an older queued mutation with TAB_WAITING_USER", () => {
  const controller = new TabStateController();
  controller.register("tab-a", "RUNNING");
  const queuedOperation = controller.captureOperation("tab-a");

  controller.transition("tab-a", "WAITING_USER");

  assert.throws(
    () => controller.assertOperationCurrent(queuedOperation),
    hasPolicyError("TASK_STOPPED"),
  );
  assert.throws(
    () => controller.assertCommandAllowed("browser.act", "tab-a", queuedOperation),
    hasPolicyError("TAB_WAITING_USER"),
  );
});

test("blocked-state verification transitions do not repeatedly advance the tab generation", () => {
  const controller = new TabStateController();
  const initial = controller.register("tab-a", "RUNNING");

  const waiting = controller.transition("tab-a", "WAITING_USER");
  const verificationOperation = controller.captureOperation("tab-a");
  const verifying = controller.transition("tab-a", "VERIFYING");
  const retry = controller.transition("tab-a", "WAITING_USER");

  assert.equal(waiting.generation, initial.generation + 1);
  assert.equal(verifying.generation, waiting.generation);
  assert.equal(retry.generation, waiting.generation);
  assert.doesNotThrow(() => controller.assertOperationCurrent(verificationOperation));
});

test("a new blocked boundary invalidates operations captured after a verified resume", () => {
  const controller = new TabStateController();
  controller.register("tab-a", "RUNNING");
  controller.transition("tab-a", "WAITING_USER");
  controller.transition("tab-a", "VERIFYING");
  controller.transition("tab-a", "READY");
  const resumedOperation = controller.captureOperation("tab-a");

  controller.transition("tab-a", "PAUSED_BY_USER");

  assert.throws(
    () => controller.assertOperationCurrent(resumedOperation),
    hasPolicyError("TASK_STOPPED"),
  );
});

test("an operation generation cannot be reused for another tab", () => {
  const controller = new TabStateController();
  controller.register("tab-a");
  controller.register("tab-b");
  const tabAOperation = controller.captureOperation("tab-a");

  assert.throws(
    () => controller.assertCommandAllowed("browser.navigate", "tab-b", tabAOperation),
    hasPolicyError("TASK_STOPPED"),
  );
});

test("global stop cancels queued operations for every tab", () => {
  const controller = new TabStateController();
  controller.register("tab-a");
  controller.register("tab-b");
  const tabAOperation = controller.captureOperation("tab-a");
  const tabBOperation = controller.captureOperation("tab-b");

  assert.equal(controller.stopAll(), 1);
  assert.equal(controller.getGlobalStopGeneration(), 1);
  assert.throws(
    () => controller.assertOperationCurrent(tabAOperation),
    hasPolicyError("TASK_STOPPED"),
  );
  assert.throws(
    () => controller.assertOperationCurrent(tabBOperation),
    hasPolicyError("TASK_STOPPED"),
  );

  const nextOperation = controller.captureOperation("tab-b");
  assert.doesNotThrow(() => controller.assertOperationCurrent(nextOperation));
});

test("removing and re-registering a tab invalidates operation tokens from the old tab", () => {
  const controller = new TabStateController();
  controller.register("tab-a");
  const oldOperation = controller.captureOperation("tab-a");
  assert.equal(controller.remove("tab-a"), true);
  controller.register("tab-a");

  assert.throws(
    () => controller.assertOperationCurrent(oldOperation),
    hasPolicyError("TASK_STOPPED"),
  );
});

test("unknown commands and tab mutations without a target fail closed", () => {
  const controller = new TabStateController();
  controller.register("tab-a");

  assert.throws(
    () => controller.assertCommandAllowed("browser.unsupported"),
    hasErrorName("UNKNOWN_BROWSER_COMMAND"),
  );
  assert.throws(
    () => controller.assertCommandAllowed("browser.navigate"),
    hasErrorName("TAB_ID_REQUIRED"),
  );
});
