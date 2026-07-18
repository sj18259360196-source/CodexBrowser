import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_RECOVERY_TTL_MS,
  MAX_SESSION_RECOVERY_TTL_MS,
  MIN_SESSION_RECOVERY_TTL_MS,
  normalizeSessionRecoveryConfig,
  validateSessionRecoveryEnvelope,
} from "../src/electron/session-recovery-policy.ts";

const binding = "electron-primary-v1";
const isCookie = (value: unknown): value is { url: string; name: string; value: string } => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === "string" && typeof candidate.name === "string" && typeof candidate.value === "string";
};

test("session recovery defaults disabled and clamps its short-lived TTL", () => {
  assert.deepEqual(normalizeSessionRecoveryConfig(null, binding), { enabled: false, ttlMs: DEFAULT_SESSION_RECOVERY_TTL_MS, profileBinding: binding });
  assert.equal(normalizeSessionRecoveryConfig({ enabled: true, ttlMs: 1 }, binding).ttlMs, MIN_SESSION_RECOVERY_TTL_MS);
  assert.equal(normalizeSessionRecoveryConfig({ enabled: true, ttlMs: Number.MAX_SAFE_INTEGER }, binding).ttlMs, MAX_SESSION_RECOVERY_TTL_MS);
  assert.equal(normalizeSessionRecoveryConfig({ enabled: true }, binding).enabled, true);
});

test("session recovery requires the matching profile binding and a live expiry", () => {
  const expiresAt = new Date(20_000).toISOString();
  const valid = validateSessionRecoveryEnvelope({ version: 1, profileBinding: binding, expiresAt, cookies: [{ url: "https://fixture.test/", name: "fixture", value: "opaque" }] }, binding, isCookie, 10_000);
  assert.equal(valid.status, "valid");
  assert.equal(valid.cookies.length, 1);
  assert.equal(validateSessionRecoveryEnvelope({ version: 1, profileBinding: "other", expiresAt, cookies: [] }, binding, isCookie, 10_000).status, "invalid");
  assert.equal(validateSessionRecoveryEnvelope({ version: 1, profileBinding: binding, expiresAt, cookies: [] }, binding, isCookie, 20_000).status, "expired");
});

test("legacy, corrupt, and malformed recovery payloads fail closed", () => {
  assert.equal(validateSessionRecoveryEnvelope([], binding, isCookie).status, "invalid");
  assert.equal(validateSessionRecoveryEnvelope({ version: 0, profileBinding: binding, expiresAt: "bad", cookies: [] }, binding, isCookie).status, "invalid");
  const result = validateSessionRecoveryEnvelope({ version: 1, profileBinding: binding, expiresAt: new Date(Date.now() + 60_000).toISOString(), cookies: [null, {}, { url: "https://fixture.test/", name: "ok", value: "opaque" }] }, binding, isCookie);
  assert.equal(result.status, "valid");
  assert.equal(result.cookies.length, 1);
});
