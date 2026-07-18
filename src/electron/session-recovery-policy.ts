export const DEFAULT_SESSION_RECOVERY_TTL_MS = 8 * 60 * 60_000;
export const MIN_SESSION_RECOVERY_TTL_MS = 5 * 60_000;
export const MAX_SESSION_RECOVERY_TTL_MS = 24 * 60 * 60_000;

export interface NormalizedSessionRecoveryConfig {
  enabled: boolean;
  ttlMs: number;
  profileBinding: string;
}

export interface ValidSessionRecoveryEnvelope<T> {
  status: "valid";
  cookies: T[];
}

export type SessionRecoveryEnvelopeResult<T> = ValidSessionRecoveryEnvelope<T> | {
  status: "expired" | "invalid";
  cookies: [];
};

export function normalizeSessionRecoveryConfig(value: unknown, profileBinding: string): NormalizedSessionRecoveryConfig {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const ttl = typeof candidate.ttlMs === "number" && Number.isFinite(candidate.ttlMs)
    ? candidate.ttlMs
    : DEFAULT_SESSION_RECOVERY_TTL_MS;
  return {
    enabled: candidate.enabled === true,
    ttlMs: Math.min(MAX_SESSION_RECOVERY_TTL_MS, Math.max(MIN_SESSION_RECOVERY_TTL_MS, ttl)),
    profileBinding,
  };
}

export function validateSessionRecoveryEnvelope<T>(
  value: unknown,
  profileBinding: string,
  isCookie: (value: unknown) => value is T,
  now = Date.now(),
): SessionRecoveryEnvelopeResult<T> {
  if (!value || typeof value !== "object") return { status: "invalid", cookies: [] };
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.profileBinding !== profileBinding || typeof candidate.expiresAt !== "string") {
    return { status: "invalid", cookies: [] };
  }
  const expiresAt = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(expiresAt)) return { status: "invalid", cookies: [] };
  if (expiresAt <= now) return { status: "expired", cookies: [] };
  if (!Array.isArray(candidate.cookies)) return { status: "invalid", cookies: [] };
  return { status: "valid", cookies: candidate.cookies.filter(isCookie) };
}
