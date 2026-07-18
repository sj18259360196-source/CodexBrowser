import type { AssistanceKind, AssistanceVerificationStrategy } from "../shared/contracts";
import type { BrowserChallengeEvidence } from "./browser-adapter";

export type ChallengeConfidence = "none" | "suspected" | "confirmed" | "blocked_access" | "authentication";
export type ChallengeKind = "cloudflare" | "captcha" | "login" | "mfa" | "otp" | "passkey" | "blocked_access" | "none";

export interface ChallengeDetection {
  kind: ChallengeKind;
  assistanceKind?: AssistanceKind;
  confidence: ChallengeConfidence;
  score: number;
  matchedSignalTypes: string[];
  sanitizedReason: string;
  verificationStrategy?: AssistanceVerificationStrategy;
  affectedTabId: string;
}

export const CHALLENGE_SCORE_THRESHOLDS = Object.freeze({ suspected: 35, confirmed: 70 });

const LOGIN_URL = /(?:^|[/.?_-])(login|signin|sign-in|sso|cas|oauth|authorize|shibboleth)(?:[/.?&_-]|$)/i;
const LOGIN_TEXT = /\b(sign in|log in|continue with|single sign.on)\b|登录|统一身份认证/i;
const MFA_TEXT = /\b(mfa|2fa|multi.factor|verification code|security code|one.time)\b|多因素|动态口令/i;
const OTP_MARKER = /otp|one.?time|verification.?code|autocomplete-one-time-code/i;
const CAPTCHA_MARKER = /recaptcha|g-recaptcha|hcaptcha|h-captcha|captcha-image|captcha-input/i;
const CAPTCHA_TEXT = /\bcaptcha\b|请输入验证码|图形验证码/i;
const PASSKEY_MARKER = /webauthn|publickeycredential|passkey/i;
const CLOUDFLARE_STRONG = /cdn-cgi\/challenge-platform|challenges\.cloudflare\.com|cf-turnstile|turnstile/i;
const CLOUDFLARE_TEXT = /just a moment|attention required|verify you are human|checking your browser/i;

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function domainOnly(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return "the current site"; }
}

function result(
  evidence: BrowserChallengeEvidence,
  kind: ChallengeKind,
  confidence: ChallengeConfidence,
  score: number,
  matched: string[],
  reason: string,
  assistanceKind?: AssistanceKind,
  verificationStrategy?: AssistanceVerificationStrategy,
): ChallengeDetection {
  return {
    kind,
    assistanceKind,
    confidence,
    score,
    matchedSignalTypes: unique(matched),
    sanitizedReason: `${domainOnly(evidence.mainFrameUrl)}: ${reason}`,
    verificationStrategy,
    affectedTabId: evidence.tabId,
  };
}

export function detectChallenge(evidence: BrowserChallengeEvidence): ChallengeDetection {
  const markers = evidence.domMarkers.join(" ");
  const frames = evidence.frameUrls.join(" ");
  const scripts = evidence.scriptUrls.join(" ");
  const text = `${evidence.title}\n${evidence.visibleText}`.slice(0, 30_000);
  const urls = `${evidence.mainFrameUrl} ${frames} ${scripts}`;
  const headers = new Set(evidence.responseHeaderNames.map((name) => name.toLowerCase()));
  const status = evidence.mainFrameStatus;

  const cfSignals: string[] = [];
  let cfScore = 0;
  if (CLOUDFLARE_STRONG.test(urls)) { cfScore += 75; cfSignals.push("cloudflare_provider_resource"); }
  if (/cf-turnstile|cloudflare-challenge|challenge-form/i.test(markers)) { cfScore += 75; cfSignals.push("cloudflare_dom"); }
  if (headers.has("cf-mitigated")) { cfScore += 75; cfSignals.push("cf_mitigated_header"); }
  if (headers.has("cf-ray")) { cfScore += 15; cfSignals.push("cf_ray_header"); }
  if (CLOUDFLARE_TEXT.test(text)) { cfScore += 25; cfSignals.push("cloudflare_page_copy"); }
  if ([403, 429, 503].includes(status || 0)) { cfScore += 15; cfSignals.push("blocking_http_status"); }
  if (evidence.refreshCount >= 3) { cfScore += 10; cfSignals.push("refresh_loop"); }
  if (evidence.unchangedMs >= 15_000) { cfScore += 5; cfSignals.push("stalled_challenge_page"); }
  if (cfScore >= CHALLENGE_SCORE_THRESHOLDS.confirmed) {
    return result(evidence, "cloudflare", "confirmed", cfScore, cfSignals, "Cloudflare verification requires user action.", "challenge", "cloudflare");
  }

  const passkeySignals: string[] = [];
  let passkeyScore = 0;
  if (PASSKEY_MARKER.test(`${markers} ${scripts}`)) { passkeyScore += 80; passkeySignals.push("webauthn_marker"); }
  if (/passkey|security key/i.test(text)) { passkeyScore += 25; passkeySignals.push("passkey_page_copy"); }
  if (passkeyScore >= CHALLENGE_SCORE_THRESHOLDS.confirmed) {
    return result(evidence, "passkey", "authentication", passkeyScore, passkeySignals, "A passkey or system authentication prompt requires user action.", "passkey", "passkey");
  }

  const mfaSignals: string[] = [];
  let mfaScore = 0;
  if (/input-(?:otp|mfa)|autocomplete-one-time-code/i.test(markers)) { mfaScore += 80; mfaSignals.push("explicit_otp_control"); }
  if (OTP_MARKER.test(markers)) { mfaScore += 65; mfaSignals.push("otp_control"); }
  if (MFA_TEXT.test(text)) { mfaScore += 25; mfaSignals.push("mfa_page_copy"); }
  if (mfaScore >= CHALLENGE_SCORE_THRESHOLDS.confirmed) {
    const kind = /otp|one.?time/i.test(markers) ? "otp" : "mfa";
    return result(evidence, kind, "authentication", mfaScore, mfaSignals, "Multi-factor verification requires user input.", "verification", "mfa");
  }

  const captchaSignals: string[] = [];
  let captchaScore = 0;
  if (CAPTCHA_MARKER.test(`${markers} ${frames} ${scripts}`)) { captchaScore += 80; captchaSignals.push("captcha_provider_or_control"); }
  if (CAPTCHA_TEXT.test(text)) { captchaScore += 20; captchaSignals.push("captcha_page_copy"); }
  if (captchaScore >= CHALLENGE_SCORE_THRESHOLDS.confirmed) {
    return result(evidence, "captcha", "confirmed", captchaScore, captchaSignals, "A CAPTCHA requires manual completion.", "challenge", "captcha");
  }

  const loginSignals: string[] = [];
  let loginScore = 0;
  if (/input-password|type-password|autocomplete-current-password/i.test(markers)) { loginScore += 55; loginSignals.push("password_control"); }
  if (LOGIN_URL.test(evidence.mainFrameUrl)) { loginScore += 35; loginSignals.push("login_url"); }
  if (LOGIN_TEXT.test(text)) { loginScore += 25; loginSignals.push("login_page_copy"); }
  const interactiveCount = Number(markers.match(/interactive-count-(\d+)/i)?.[1] || 0);
  if (interactiveCount > 8 && !LOGIN_URL.test(evidence.mainFrameUrl)) { loginScore -= 25; loginSignals.push("mixed_interactive_page"); }
  if (loginScore >= CHALLENGE_SCORE_THRESHOLDS.confirmed) {
    return result(evidence, "login", "authentication", loginScore, loginSignals, "Authentication requires credentials in the visible browser.", "credential", "authentication");
  }

  if (status === 401 || status === 403) {
    return result(evidence, "blocked_access", "blocked_access", 55, ["unauthorized_http_status"], "The protected resource is not currently authorized.", "credential", "protected_resource");
  }

  const suspected = Math.max(cfScore, captchaScore, loginScore, mfaScore, passkeyScore);
  if (suspected >= CHALLENGE_SCORE_THRESHOLDS.suspected) {
    return result(evidence, "none", "suspected", suspected, [...cfSignals, ...captchaSignals, ...loginSignals, ...mfaSignals, ...passkeySignals], "Possible user-interaction boundary; more evidence is required.");
  }
  return result(evidence, "none", "none", suspected, [], "No challenge or authentication boundary detected.");
}

export function shouldFreezeForChallenge(detection: ChallengeDetection): boolean {
  return detection.confidence === "confirmed"
    || detection.confidence === "blocked_access"
    || detection.confidence === "authentication";
}
