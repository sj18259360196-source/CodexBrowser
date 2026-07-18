import type { AuthPrompt, DownloadItem, HumanAssistance, TaskItem } from "../shared/contracts";

export interface ParsedPersistedBrowserTab {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

export interface PersistedBlockedTab {
  tabId: string;
  kind: "auth" | "assistance" | "dialog";
  authReason?: AuthPrompt["reason"];
  requestedAt: string;
}

export const MAX_PERSISTED_BLOCKED_TABS = 24;
export const MAX_PERSISTED_TABS = 8;
export const MAX_PERSISTED_TASKS = 80;
export const MAX_PERSISTED_DOWNLOADS = 80;

const MAX_ID_LENGTH = 200;
const MAX_TAB_TITLE_LENGTH = 300;
const MAX_TASK_LABEL_LENGTH = 300;
const MAX_TASK_DETAIL_LENGTH = 16_384;
const MAX_URL_LENGTH = 8_192;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_PATH_LENGTH = 32_768;

const ASSISTANCE_KINDS = new Set<HumanAssistance["kind"]>([
  "credential",
  "verification",
  "challenge",
  "passkey",
  "consent",
  "file_selection",
  "permission",
  "certificate",
  "manual_action",
]);

const ASSISTANCE_STATUSES = new Set<HumanAssistance["status"]>([
  "waiting_user",
  "verifying",
  "completed",
  "unable",
  "cancelled",
  "expired",
]);

const AUTH_REASONS = new Set<AuthPrompt["reason"]>([
  "login",
  "mfa",
  "captcha",
  "forbidden",
  "stalled",
]);

const TASK_STATUSES = new Set<TaskItem["status"]>([
  "queued",
  "running",
  "waiting_user",
  "done",
  "error",
]);

const DOWNLOAD_STATES = new Set<DownloadItem["state"]>([
  "starting",
  "progressing",
  "completed",
  "cancelled",
  "interrupted",
]);

function parseBoundedString(value: unknown, maxLength: number, requireNonEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  if (requireNonEmpty && value.trim().length === 0) return null;
  return value;
}

function parseIdentifier(value: unknown): string | null {
  const parsed = parseBoundedString(value, MAX_ID_LENGTH, true);
  return parsed?.trim() || null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isGeneratedPersistedDownloadName(value: unknown): value is string {
  return typeof value === "string" && /^download-\d{13}-[a-f0-9]{8}\.(?:pdf|bin)$/i.test(value);
}

export function parsePersistedBrowserTab(value: unknown): ParsedPersistedBrowserTab | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = parseIdentifier(candidate.id);
  const title = parseBoundedString(candidate.title, MAX_TAB_TITLE_LENGTH);
  const url = parseBoundedString(candidate.url, MAX_URL_LENGTH);
  const createdAt = parseTimestamp(candidate.createdAt);
  if (id === null || title === null || url === null || createdAt === null) return null;
  return { id, title, url, createdAt };
}

export function parsePersistedBrowserTabs(value: unknown): ParsedPersistedBrowserTab[] {
  if (!Array.isArray(value)) return [];
  const result: ParsedPersistedBrowserTab[] = [];
  for (const candidate of value) {
    const parsed = parsePersistedBrowserTab(candidate);
    if (parsed) result.push(parsed);
    if (result.length >= MAX_PERSISTED_TABS) break;
  }
  return result;
}

export function parsePersistedTask(value: unknown): TaskItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = parseIdentifier(candidate.id);
  const label = parseBoundedString(candidate.label, MAX_TASK_LABEL_LENGTH);
  const detail = candidate.detail === undefined
    ? undefined
    : parseBoundedString(candidate.detail, MAX_TASK_DETAIL_LENGTH);
  const status = typeof candidate.status === "string"
    && TASK_STATUSES.has(candidate.status as TaskItem["status"])
    ? candidate.status as TaskItem["status"]
    : null;
  const createdAt = parseTimestamp(candidate.createdAt);
  const updatedAt = parseTimestamp(candidate.updatedAt);
  if (
    id === null
    || label === null
    || detail === null
    || status === null
    || createdAt === null
    || updatedAt === null
  ) return null;
  return {
    id,
    label,
    ...(detail === undefined ? {} : { detail }),
    status,
    createdAt,
    updatedAt,
  };
}

export function parsePersistedTasks(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) return [];
  const result: TaskItem[] = [];
  for (const candidate of value) {
    const parsed = parsePersistedTask(candidate);
    if (parsed) result.push(parsed);
    if (result.length >= MAX_PERSISTED_TASKS) break;
  }
  return result;
}

export function parsePersistedDownload(value: unknown, fallbackTimestamp: string): DownloadItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = parseIdentifier(candidate.id);
  const fileName = isGeneratedPersistedDownloadName(candidate.fileName) ? candidate.fileName : null;
  const downloadPath = candidate.path === undefined
    ? undefined
    : parseBoundedString(candidate.path, MAX_PATH_LENGTH);
  const url = parseBoundedString(candidate.url, MAX_URL_LENGTH);
  const receivedBytes = parseByteCount(candidate.receivedBytes);
  const totalBytes = parseByteCount(candidate.totalBytes);
  const state = typeof candidate.state === "string"
    && DOWNLOAD_STATES.has(candidate.state as DownloadItem["state"])
    ? candidate.state as DownloadItem["state"]
    : null;
  const fallback = parseTimestamp(fallbackTimestamp);
  const createdAt = candidate.createdAt === undefined ? fallback : parseTimestamp(candidate.createdAt);
  const updatedAt = candidate.updatedAt === undefined ? fallback : parseTimestamp(candidate.updatedAt);
  if (
    id === null
    || fileName === null
    || downloadPath === null
    || url === null
    || receivedBytes === null
    || totalBytes === null
    || state === null
    || createdAt === null
    || updatedAt === null
  ) return null;
  if (downloadPath !== undefined) {
    const pathFileName = downloadPath.replace(/\\/g, "/").split("/").pop();
    if (pathFileName !== fileName) return null;
  }
  return {
    id,
    fileName,
    ...(downloadPath === undefined ? {} : { path: downloadPath }),
    url,
    receivedBytes,
    totalBytes,
    state,
    createdAt,
    updatedAt,
  };
}

export function parsePersistedDownloads(value: unknown, fallbackTimestamp: string): DownloadItem[] {
  if (!Array.isArray(value)) return [];
  const result: DownloadItem[] = [];
  for (const candidate of value) {
    const parsed = parsePersistedDownload(candidate, fallbackTimestamp);
    if (parsed) result.push(parsed);
    if (result.length >= MAX_PERSISTED_DOWNLOADS) break;
  }
  return result;
}

export function parsePersistedBlockedTab(value: unknown): PersistedBlockedTab | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PersistedBlockedTab>;
  const tabId = typeof candidate.tabId === "string" ? candidate.tabId.trim() : "";
  const requestedAt = typeof candidate.requestedAt === "string"
    && candidate.requestedAt.length <= 64
    && !Number.isNaN(Date.parse(candidate.requestedAt))
    ? new Date(candidate.requestedAt).toISOString()
    : null;
  const validKind = candidate.kind === "auth" || candidate.kind === "assistance" || candidate.kind === "dialog";
  const validAuthReason = candidate.kind === "auth"
    ? typeof candidate.authReason === "string" && AUTH_REASONS.has(candidate.authReason as AuthPrompt["reason"])
    : candidate.authReason === undefined;
  const valid = tabId.length > 0
    && tabId.length <= 200
    && validKind
    && validAuthReason
    && requestedAt !== null;
  if (!valid) return null;
  return {
    tabId,
    kind: candidate.kind!,
    ...(candidate.kind === "auth" ? { authReason: candidate.authReason as AuthPrompt["reason"] } : {}),
    requestedAt,
  };
}

export function parsePersistedBlockedTabs(
  value: unknown,
  validTabIds?: ReadonlySet<string>,
): PersistedBlockedTab[] {
  if (!Array.isArray(value)) return [];
  const normalizedValidTabIds = validTabIds
    ? new Set([...validTabIds].map((tabId) => tabId.trim()).filter(Boolean))
    : null;
  const seen = new Set<string>();
  const result: PersistedBlockedTab[] = [];
  for (const candidate of value) {
    const parsed = parsePersistedBlockedTab(candidate);
    if (!parsed || (normalizedValidTabIds && !normalizedValidTabIds.has(parsed.tabId))) continue;
    const key = JSON.stringify([parsed.tabId, parsed.kind]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(parsed);
    if (result.length >= MAX_PERSISTED_BLOCKED_TABS) break;
  }
  return result;
}

export function isPersistedBlockedTab(value: unknown): value is PersistedBlockedTab {
  return parsePersistedBlockedTab(value) !== null;
}

export function isHumanAssistance(value: unknown): value is HumanAssistance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HumanAssistance>;
  return typeof candidate.id === "string"
    && typeof candidate.tabId === "string"
    && typeof candidate.taskId === "string"
    && typeof candidate.kind === "string"
    && ASSISTANCE_KINDS.has(candidate.kind as HumanAssistance["kind"])
    && typeof candidate.title === "string"
    && typeof candidate.detail === "string"
    && typeof candidate.url === "string"
    && (candidate.domain === undefined || typeof candidate.domain === "string")
    && (candidate.verificationStrategy === undefined || typeof candidate.verificationStrategy === "string")
    && typeof candidate.status === "string"
    && ASSISTANCE_STATUSES.has(candidate.status as HumanAssistance["status"])
    && (candidate.note === undefined || typeof candidate.note === "string")
    && typeof candidate.requestedAt === "string"
    && !Number.isNaN(Date.parse(candidate.requestedAt))
    && (candidate.expiresAt === undefined || (typeof candidate.expiresAt === "string" && !Number.isNaN(Date.parse(candidate.expiresAt))))
    && (candidate.resolvedAt === undefined
      || (typeof candidate.resolvedAt === "string" && !Number.isNaN(Date.parse(candidate.resolvedAt))));
}

export function parseLegacyAssistanceBoundary(value: unknown): PersistedBlockedTab | null {
  if (!isHumanAssistance(value)) return null;
  if (value.status !== "waiting_user" && value.status !== "verifying") return null;
  return parsePersistedBlockedTab({
    tabId: value.tabId,
    kind: "assistance",
    requestedAt: value.requestedAt,
  });
}

export function parseRuntimeBlockedTabs(
  value: { version?: unknown; blockedTabs?: unknown; assistance?: unknown },
  validTabIds: ReadonlySet<string>,
): PersistedBlockedTab[] {
  const normalizedValidTabIds = new Set([...validTabIds].map((tabId) => tabId.trim()).filter(Boolean));
  const blockedTabs = parsePersistedBlockedTabs(value.blockedTabs, normalizedValidTabIds);
  if (value.version !== 2 || blockedTabs.length >= MAX_PERSISTED_BLOCKED_TABS) return blockedTabs;
  const legacyBoundary = parseLegacyAssistanceBoundary(value.assistance);
  if (
    legacyBoundary
    && normalizedValidTabIds.has(legacyBoundary.tabId)
    && !blockedTabs.some((item) => item.tabId === legacyBoundary.tabId && item.kind === "assistance")
  ) {
    blockedTabs.push(legacyBoundary);
  }
  return blockedTabs;
}
