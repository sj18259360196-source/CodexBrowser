import assert from "node:assert/strict";
import test from "node:test";
import { isVerificationProviderFrameUrl } from "../src/browser/verification-boundary.ts";

test("recognizes verification-provider iframe URLs", () => {
  for (const url of [
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/",
    "https://sub.challenges.cloudflare.com/turnstile/v0/",
    "https://newassets.hcaptcha.com/captcha/v1/frame.html",
    "https://www.google.com/recaptcha/api2/anchor",
    "https://www.recaptcha.net/recaptcha/enterprise/anchor",
  ]) assert.equal(isVerificationProviderFrameUrl(url), true, url);
});

test("does not hide ordinary cross-origin frames", () => {
  for (const url of [
    "https://example.test/frame",
    "https://www.google.com/maps/embed",
    "https://research.cloudflare.com/",
    "about:blank",
    "not a URL",
  ]) assert.equal(isVerificationProviderFrameUrl(url), false, url);
});
