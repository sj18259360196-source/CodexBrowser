import assert from "node:assert/strict";
import test from "node:test";
import { hasTargetAuthResolutionEvidence } from "../src/browser/auth-evidence.ts";

test("fails closed without a target-tab baseline", () => {
  assert.equal(hasTargetAuthResolutionEvidence(undefined, "https://example.test/app", "current"), false);
});

test("ignores unrelated browser or tab activity when target evidence is unchanged", () => {
  const baseline = {
    url: "https://example.test/account",
    pageEvidence: "target-tab-fingerprint",
  };

  assert.equal(hasTargetAuthResolutionEvidence(
    baseline,
    "https://example.test/account",
    "target-tab-fingerprint",
  ), false);
});

test("accepts a target-tab page fingerprint change", () => {
  const baseline = {
    url: "https://example.test/account",
    pageEvidence: "before-user-action",
  };

  assert.equal(hasTargetAuthResolutionEvidence(
    baseline,
    "https://example.test/account",
    "after-user-action",
  ), true);
});

test("accepts a target-tab resource transition", () => {
  assert.equal(hasTargetAuthResolutionEvidence(
    { url: "https://example.test/login", pageEvidence: "same" },
    "https://example.test/library",
    "same",
  ), true);
});

test("accepts leaving an authentication origin even when resource normalization is unavailable", () => {
  assert.equal(hasTargetAuthResolutionEvidence(
    { url: "https://login.example.test/signin" },
    "about:blank",
  ), true);
});

test("malformed URLs and unchanged evidence remain blocked", () => {
  assert.equal(hasTargetAuthResolutionEvidence(
    { url: "not a URL", pageEvidence: "same" },
    "still not a URL",
    "same",
  ), false);
});
