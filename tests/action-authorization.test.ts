import assert from "node:assert/strict";
import test from "node:test";
import { ActionAuthorizationStore } from "../src/browser/action-authorization.ts";

const policy = { decision: "confirm", category: "communication", ruleId: "communication.confirm", summary: "Send a message", impact: "Content is sent externally", grantEligible: true } as const;
const request = { tabId: "tab-a", taskId: "task-a", origin: "https://fixture.test", revision: 4, ref: "cb-e4-0-1", policy };

function errorNamed(name: string): (error: unknown) => boolean { return (error) => error instanceof Error && error.name === name; }

test("confirmation is deduplicated, expires, and is consumed once", () => {
  const store = new ActionAuthorizationStore();
  const first = store.request(request, 1_000);
  assert.equal(store.request(request, 2_000).id, first.id);
  store.approve(first.id, 3_000);
  store.beginExecution(first.id, 4_000);
  assert.throws(() => store.beginExecution(first.id, 4_001), errorNamed("CONFIRMATION_STALE"));
  store.finish(first.id, "completed", "Executed", 5_000);
  assert.equal(store.get(first.id).status, "completed");

  const expired = store.request({ ...request, ref: "cb-e4-0-2" }, 10_000);
  assert.throws(() => store.approve(expired.id, 70_001), errorNamed("CONFIRMATION_EXPIRED"));
});

test("denial and stop prevent execution", () => {
  const store = new ActionAuthorizationStore();
  const denied = store.request(request);
  store.deny(denied.id);
  assert.throws(() => store.beginExecution(denied.id), errorNamed("CONFIRMATION_STALE"));
  const stopped = store.request({ ...request, ref: "other" });
  store.cancelAll();
  assert.equal(store.get(stopped.id).status, "cancelled");
});

test("an executing non-idempotent action becomes outcome_unknown after browser loss", () => {
  const store = new ActionAuthorizationStore();
  const confirmation = store.request(request);
  store.approve(confirmation.id);
  store.beginExecution(confirmation.id);
  store.markExecutingOutcomeUnknown();
  assert.equal(store.get(confirmation.id).status, "outcome_unknown");
  assert.throws(() => store.beginExecution(confirmation.id), errorNamed("CONFIRMATION_STALE"));
  assert.match(JSON.stringify(store.auditEntries()), /outcome_unknown/);
});

test("temporary grants are bound to profile, origin, category, and expiry", () => {
  const store = new ActionAuthorizationStore();
  const grant = store.createGrant({ profileId: "primary", origin: "https://fixture.test", category: "communication", tabId: "tab-a", ttlMs: 60_000 }, 1_000);
  assert.equal(store.matchingGrants("primary", "https://fixture.test", "tab-a", undefined, 2_000).length, 1);
  assert.equal(store.matchingGrants("primary", "https://other.test", "tab-a", undefined, 2_000).length, 0);
  assert.equal(store.matchingGrants("other", "https://fixture.test", "tab-a", undefined, 2_000).length, 0);
  assert.equal(store.matchingGrants("primary", "https://fixture.test", "tab-a", undefined, 61_001).length, 0);
  assert.throws(() => store.revokeGrant(grant.id), errorNamed("GRANT_STALE"));
});

test("audit records are bounded and sanitized", () => {
  const store = new ActionAuthorizationStore();
  store.recordEvaluation({ origin: "https://fixture.test/path?token=secret", tabId: "tab-a" }, { ...policy, summary: "message body must not survive https://fixture.test/?token=secret" });
  const serialized = JSON.stringify(store.auditEntries());
  assert.doesNotMatch(serialized, /token=secret|message body must not survive/);
});
