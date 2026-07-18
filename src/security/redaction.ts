const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "passcode",
  "pin(?:[-_ ]?code)?",
  "otp",
  "one[-_ ]?time[-_ ]?code",
  "verification[-_ ]?code",
  "recovery[-_ ]?code",
  "captcha",
  "csrf",
  "token",
  "secret",
  "credential",
  "hidden",
  "file(?:name|path)?",
  "api[-_ ]?key",
  "private[-_ ]?key",
  "assertion",
  "saml",
  "jwt",
  "signature",
].join("|");

const SENSITIVE_ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_KEY})\\b(\\s*(?::|=)\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`,
  "gi",
);

export function sanitizeUrlForExposure(value: string): string {
  if (value === "about:blank") return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.username = "";
    parsed.password = "";
    return `${parsed.origin}/`;
  } catch {
    return "";
  }
}

export function sanitizeSensitiveText(value?: string, maxLength = 8_000): string | undefined {
  if (!value) return value;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/https?:\/\/[^\s·]+/g, (candidate) => sanitizeUrlForExposure(candidate) || "[URL REDACTED]")
    .replace(/wss?:\/\/[^\s·]+/gi, "[URL REDACTED]")
    .replace(/\b[a-z]:\\(?:[^\\\r\n:*?"<>|]+\\)*[^\\\r\n:*?"<>|]*/gi, "[PATH REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)?\b/gi, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(/([?&](?:code|ticket|state|session|expires|x-amz-[^=]*)=)[^&\s·]*/gi, `$1${REDACTED}`)
    .slice(0, Math.max(1, maxLength));
}

export function sanitizeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error && error.name ? error.name : "BROWSER_ERROR";
  const rawMessage = error instanceof Error ? error.message : String(error || "Unknown browser error");
  return {
    name: /^[A-Z][A-Z0-9_]{1,63}$/.test(name) ? name : "BROWSER_ERROR",
    message: sanitizeSensitiveText(rawMessage) || "Unknown browser error",
  };
}
