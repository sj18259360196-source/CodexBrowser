import assert from "node:assert/strict";
import test from "node:test";
import { AssistanceCoordinator } from "../src/browser/assistance-coordinator.ts";

function request(kind: "challenge" | "credential" | "passkey" = "challenge") {
  return { tabId: "tab-a", taskId: "task-a", kind, domain: "example.test", title: "User action required", detail: "Complete the visible step.", url: "https://example.test/challenge", verificationStrategy: kind === "credential" ? "authentication" as const : kind === "passkey" ? "passkey" as const : "cloudflare" as const, ttlMs: 1_000 };
}

test("deduplicates one active assistance per tab and upgrades priority", () => {
  const coordinator = new AssistanceCoordinator();
  const first = coordinator.request(request(), 1_000);
  const duplicate = coordinator.request(request(), 1_100);
  const upgrade = coordinator.request(request("passkey"), 1_200);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.assistance.id, first.assistance.id);
  assert.equal(upgrade.upgraded, true);
  assert.equal(upgrade.assistance.kind, "passkey");
});

test("expires assistance and distinguishes expired from stale IDs", () => {
  const coordinator = new AssistanceCoordinator();
  const item = coordinator.request(request(), 1_000).assistance;
  assert.throws(() => coordinator.get(item.id, 2_001), (error: unknown) => error instanceof Error && error.name === "ASSISTANCE_EXPIRED");
  assert.throws(() => coordinator.get("missing", 2_001), (error: unknown) => error instanceof Error && error.name === "ASSISTANCE_STALE");
});

test("failed verification returns to waiting and stop cancels active requests", () => {
  const coordinator = new AssistanceCoordinator();
  const item = coordinator.request(request(), 1_000).assistance;
  assert.equal(coordinator.beginVerification(item.id, 1_100).status, "verifying");
  assert.equal(coordinator.verificationFailed(item.id, "Still blocked", 1_150).status, "waiting_user");
  assert.equal(coordinator.cancelAll("Stopped", 1_200)[0].status, "cancelled");
  assert.equal(coordinator.getByTab("tab-a", 1_200), null);
});
