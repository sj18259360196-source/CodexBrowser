import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDataConfirmationStore } from "../src/browser/data-confirmation.ts";

function errorNamed(name: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.name === name;
}

test("browser data confirmation is scoped to the requested action", () => {
  const store = new BrowserDataConfirmationStore();
  const requested = store.request("clear_site", "fixture.test", true, 1_000);
  assert.equal(requested.action, "clear_site");
  assert.equal(requested.scope, "fixture.test");
  assert.deepEqual(store.consume(requested.id, 2_000), {
    action: "clear_site",
    scope: "fixture.test",
    includePermissions: true,
  });
});

test("unknown and reused confirmations are rejected", () => {
  const store = new BrowserDataConfirmationStore();
  assert.throws(() => store.consume("missing"), errorNamed("CONFIRMATION_STALE"));
  const requested = store.request("clear_all", "all-sites");
  store.consume(requested.id);
  assert.throws(() => store.consume(requested.id), errorNamed("CONFIRMATION_STALE"));
});

test("expired confirmations are rejected", () => {
  const store = new BrowserDataConfirmationStore();
  const requested = store.request("reset_profile", "primary", false, 1_000);
  assert.throws(() => store.consume(requested.id, 61_000), errorNamed("CONFIRMATION_EXPIRED"));
  assert.throws(() => store.consume(requested.id, 61_001), errorNamed("CONFIRMATION_STALE"));
});
