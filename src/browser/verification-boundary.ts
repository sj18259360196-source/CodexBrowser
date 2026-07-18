const RECAPTCHA_HOSTS = new Set(["www.google.com", "www.recaptcha.net"]);

/**
 * Verification-provider frames are a human-only trust boundary. Codex Browser
 * may identify their URL and render them, but must not create an isolated
 * JavaScript world inside them for snapshots or element discovery.
 */
export function isVerificationProviderFrameUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (host === "challenges.cloudflare.com" || host.endsWith(".challenges.cloudflare.com")) return true;
    if ((host === "hcaptcha.com" || host.endsWith(".hcaptcha.com")) && /(?:^|\/)captcha(?:\/|$)/.test(pathname)) return true;
    return RECAPTCHA_HOSTS.has(host) && pathname.includes("/recaptcha/");
  } catch {
    return false;
  }
}
