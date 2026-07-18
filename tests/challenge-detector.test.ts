import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserChallengeEvidence } from "../src/browser/browser-adapter.ts";
import { detectChallenge } from "../src/browser/challenge-detector.ts";

function evidence(overrides: Partial<BrowserChallengeEvidence> = {}): BrowserChallengeEvidence {
  return {
    tabId: "tab-a", mainFrameUrl: "https://example.test/resource", frameUrls: [], title: "Example",
    visibleText: "Ordinary page", domMarkers: [], iframeOrigins: [], scriptUrls: [], responseHeaderNames: [],
    refreshCount: 0, unchangedMs: 0, ...overrides,
  };
}

const cases: Array<[string, Partial<BrowserChallengeEvidence>, string, string]> = [
  ["Cloudflare 403", { mainFrameStatus: 403, title: "Just a moment...", scriptUrls: ["https://example.test/cdn-cgi/challenge-platform/x.js"], responseHeaderNames: ["cf-ray"] }, "cloudflare", "confirmed"],
  ["Cloudflare 200", { mainFrameStatus: 200, title: "Checking your browser", domMarkers: ["cloudflare-challenge challenge-form"] }, "cloudflare", "confirmed"],
  ["Turnstile frame", { frameUrls: ["https://challenges.cloudflare.com/turnstile/v0/"], domMarkers: ["cf-turnstile"] }, "cloudflare", "confirmed"],
  ["reCAPTCHA", { frameUrls: ["https://www.google.com/recaptcha/api2/anchor"], domMarkers: ["g-recaptcha"] }, "captcha", "confirmed"],
  ["hCaptcha", { scriptUrls: ["https://js.hcaptcha.com/1/api.js"], domMarkers: ["h-captcha"] }, "captcha", "confirmed"],
  ["login", { mainFrameUrl: "https://example.test/login", visibleText: "Sign in", domMarkers: ["type-password input-password"] }, "login", "authentication"],
  ["MFA", { visibleText: "Multi-factor verification code", domMarkers: ["input-mfa"] }, "mfa", "authentication"],
  ["OTP", { visibleText: "Enter one-time code", domMarkers: ["autocomplete-one-time-code input-otp"] }, "otp", "authentication"],
  ["Passkey", { visibleText: "Use a passkey", domMarkers: ["webauthn publickeycredential"] }, "passkey", "authentication"],
];

for (const [name, input, kind, confidence] of cases) {
  test(`detects ${name}`, () => {
    const actual = detectChallenge(evidence(input));
    assert.equal(actual.kind, kind);
    assert.equal(actual.confidence, confidence);
    assert.ok(actual.matchedSignalTypes.length > 0);
    assert.doesNotMatch(JSON.stringify(actual), /secret-value|cookie|authorization/i);
  });
}

test("ordinary 403 is blocked access, not Cloudflare", () => {
  const actual = detectChallenge(evidence({ mainFrameStatus: 403, visibleText: "Access denied" }));
  assert.equal(actual.kind, "blocked_access");
  assert.notEqual(actual.kind, "cloudflare");
});

test("ordinary checkbox and discussion text do not become CAPTCHA or authentication", () => {
  const actual = detectChallenge(evidence({ visibleText: "This article discusses passwords, MFA and CAPTCHA design.", domMarkers: ["input-checkbox newsletter"] }));
  assert.equal(actual.confidence, "none");
});

test("an ordinary slow page is not a challenge", () => {
  const actual = detectChallenge(evidence({ unchangedMs: 60_000, visibleText: "Loading report data" }));
  assert.equal(actual.confidence, "none");
});
