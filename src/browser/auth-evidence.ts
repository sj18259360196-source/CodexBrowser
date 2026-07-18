export interface AuthResolutionBaseline {
  url: string;
  pageEvidence?: string;
}

const AUTH_URL_PATTERN = /(?:login|auth|sso|cas|shibboleth|oauth|webvpn|passport|signin)/i;

function resourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

export function hasTargetAuthResolutionEvidence(
  baseline: AuthResolutionBaseline | undefined,
  currentUrl: string,
  currentPageEvidence?: string,
): boolean {
  if (!baseline) return false;
  const baselineUrl = resourceUrl(baseline.url);
  const nextUrl = resourceUrl(currentUrl);
  const urlChanged = Boolean(baselineUrl && nextUrl && baselineUrl !== nextUrl);
  const baselineWasAuth = AUTH_URL_PATTERN.test(baseline.url);
  const currentLooksAuth = AUTH_URL_PATTERN.test(currentUrl);
  const pageChanged = Boolean(
    baseline.pageEvidence
    && currentPageEvidence
    && baseline.pageEvidence !== currentPageEvidence,
  );
  return urlChanged || (baselineWasAuth && !currentLooksAuth) || pageChanged;
}
