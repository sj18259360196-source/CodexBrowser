import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  BrowserSkill,
  BrowserSkillInput,
  BrowserSkillRisk,
  BrowserSkillStatus,
  BrowserSkillStep,
  BrowserSkillTarget,
  BrowserSkillTraceStatus,
  BrowserSkillTraceSummary,
} from "../shared/contracts";

const STORE_VERSION = 1;
const EXPORT_FORMAT = "codex-browser-skill";
const EXPORT_VERSION = 1;
const MAX_SKILLS = 500;
const MAX_TRACES = 200;
const MAX_OPERATIONS_PER_TRACE = 500;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const REDACTED_VALUE = "[REDACTED]";
const INPUT_PLACEHOLDER_PATTERN = /\{\{(input_[a-z0-9_]{1,64})\}\}/gi;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{2,64}$/;

export const LEARNABLE_BROWSER_SKILL_METHODS = Object.freeze([
  "browser.tab_new",
  "browser.navigate",
  "browser.act",
  "browser.wait",
  "browser.back",
  "browser.forward",
  "browser.reload",
] as const);

export const TRACEABLE_BROWSER_SKILL_METHODS = Object.freeze([
  ...LEARNABLE_BROWSER_SKILL_METHODS,
  "browser.tab_select",
  "browser.tab_close",
  "browser.observe",
  "browser.snapshot",
  "browser.screenshot",
  "browser.dialog_respond",
  "browser.pause",
  "browser.resume",
  "browser.assistance_request",
  "browser.assistance_complete",
] as const);

const learnableMethodSet = new Set<string>(LEARNABLE_BROWSER_SKILL_METHODS);
const traceableMethodSet = new Set<string>(TRACEABLE_BROWSER_SKILL_METHODS);
const statusValues: BrowserSkillStatus[] = ["draft", "enabled", "disabled", "stale"];
const traceStatusValues: BrowserSkillTraceStatus[] = ["recording", "ready", "learned", "discarded"];
const riskValues: BrowserSkillRisk[] = ["read_only", "interaction", "confirmation"];

const methodParameterKeys: Readonly<Record<string, ReadonlySet<string>>> = {
  "browser.tab_new": new Set(["url", "activate"]),
  "browser.navigate": new Set(["url"]),
  "browser.act": new Set(["action", "text", "key", "value", "deltaX", "deltaY"]),
  "browser.wait": new Set(["condition", "value", "timeoutMs"]),
  "browser.back": new Set(),
  "browser.forward": new Set(),
  "browser.reload": new Set(),
  "browser.tab_select": new Set(),
  "browser.tab_close": new Set(["force"]),
  "browser.observe": new Set(["maxCharacters"]),
  "browser.snapshot": new Set(["maxElements", "maxTextCharacters"]),
  "browser.screenshot": new Set(["scope", "maxWidth", "redactSensitive"]),
  "browser.dialog_respond": new Set(["accept"]),
  "browser.pause": new Set(),
  "browser.resume": new Set(),
  "browser.assistance_request": new Set(["kind", "title", "detail"]),
  "browser.assistance_complete": new Set(["outcome", "note", "userConfirmed"]),
};

const sensitiveKeyPattern = /(?:password|passwd|passcode|otp|one.?time|verification.?code|auth(?:orization)?|cookie|token|secret|credential|session.?key|api.?key)/i;
const sensitiveTargetPattern = /(?:password|passwd|passcode|otp|one.?time|verification|验证码|校验码|口令|密码|令牌|密钥)/i;
const executableKeyPattern = /(?:javascript|script|source.?code|expression|callback|function|shell|powershell|command.?line|executable)/i;
const confirmationTargetPattern = /(?:delete|remove|erase|submit|send|publish|purchase|pay|confirm|upload|save|删除|移除|提交|发送|发布|购买|支付|确认|上传|保存)/i;

export type BrowserSkillTraceOutcome = "success" | "error" | "cancelled";

export interface BrowserSkillTracePageState {
  url?: string;
  title?: string;
}

export interface BrowserSkillTraceOperationInput {
  method: string;
  label?: string;
  params?: Record<string, unknown>;
  target?: BrowserSkillTarget;
  risk?: BrowserSkillRisk;
  before?: BrowserSkillTracePageState;
  after?: BrowserSkillTracePageState;
  outcome?: BrowserSkillTraceOutcome;
  detail?: string;
  durationMs?: number;
  occurredAt?: string;
  inputLabels?: Record<string, string>;
  sanitized?: boolean;
}

export interface BrowserSkillTraceOperation {
  id: string;
  method: string;
  label: string;
  params: Record<string, unknown>;
  target?: BrowserSkillTarget;
  risk: BrowserSkillRisk;
  before?: BrowserSkillTracePageState;
  after?: BrowserSkillTracePageState;
  outcome: BrowserSkillTraceOutcome;
  detail?: string;
  durationMs: number;
  occurredAt: string;
  inputLabels: Record<string, string>;
  learnable: boolean;
}

export interface BrowserSkillTrace {
  schemaVersion: 1;
  id: string;
  clientSessionKey: string;
  title: string;
  query?: string;
  host?: string;
  status: BrowserSkillTraceStatus;
  operations: BrowserSkillTraceOperation[];
  startedAt: string;
  updatedAt: string;
  draftSkillId?: string;
}

export interface BrowserSkillTraceStartOptions {
  title?: string;
  query?: string;
  url?: string;
  forceNew?: boolean;
}

export interface BrowserSkillDraftOptions {
  name?: string;
  description?: string;
}

export interface BrowserSkillFinalization {
  trace: BrowserSkillTraceSummary;
  skill: BrowserSkill | null;
}

export interface BrowserSkillMatch {
  skill: BrowserSkill;
  score: number;
  reasons: string[];
}

interface SkillStore {
  version: typeof STORE_VERSION;
  savedAt: string;
  skills: BrowserSkill[];
}

interface TraceStore {
  version: typeof STORE_VERSION;
  savedAt: string;
  traces: BrowserSkillTrace[];
}

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(3).max(65).regex(IDENTIFIER_PATTERN);
const riskSchema = z.enum(["read_only", "interaction", "confirmation"]);

const targetSchema = z.object({
  tag: z.string().trim().min(1).max(40).optional(),
  role: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(300).optional(),
  text: z.string().trim().min(1).max(500).optional(),
  type: z.string().trim().min(1).max(80).optional(),
  placeholder: z.string().trim().min(1).max(300).optional(),
  hrefPath: z.string().trim().min(1).max(1_000).optional(),
}).strict();

function jsonSafetyError(value: unknown): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 5_000) return "JSON value has too many entries.";
    if (current.depth > 10) return "JSON value is nested too deeply.";
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "JSON numbers must be finite.";
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 200) return "JSON arrays are too large.";
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object") return "Value is not JSON serializable.";
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return "JSON objects must be plain objects.";
    const entries = Object.entries(current.value as Record<string, unknown>);
    if (entries.length > 200) return "JSON objects have too many entries.";
    for (const [key, item] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key)) return "JSON object contains a reserved key.";
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return null;
}

const paramsSchema = z.record(z.unknown()).superRefine((value, context) => {
  const error = jsonSafetyError(value);
  if (error) context.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

const inputSchema = z.object({
  name: identifierSchema,
  label: z.string().trim().min(1).max(160),
  type: z.enum(["text", "url", "number", "boolean"]),
  required: z.boolean(),
  sensitive: z.boolean(),
  defaultValue: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]).optional(),
}).strict().superRefine((value, context) => {
  if (value.sensitive && value.defaultValue !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Sensitive inputs cannot have default values." });
  }
});

const triggerSchema = z.object({
  hosts: z.array(z.string().trim().min(1).max(253)).max(40),
  pathPatterns: z.array(z.string().trim().min(1).max(1_000).refine((value) => value.startsWith("/"), "Path patterns must start with /." )).max(40),
  keywords: z.array(z.string().trim().min(1).max(120)).max(40),
}).strict();

const statsSchema = z.object({
  runCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  averageDurationMs: z.number().finite().min(0),
  lastRunAt: timestampSchema.optional(),
  lastSuccessAt: timestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.successCount + value.failureCount !== value.runCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill run counters are inconsistent." });
  }
});

const stepSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  method: z.string().refine((value) => learnableMethodSet.has(value), "Unsupported browser skill method."),
  params: paramsSchema,
  target: targetSchema.optional(),
  risk: riskSchema,
  continueOnFailure: z.boolean().optional(),
}).strict().superRefine((step, context) => {
  const error = validateMethodParams(step.method, step.params, step.target);
  if (error) context.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

const skillSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(3).max(120).regex(/^[a-z0-9][a-z0-9._-]+$/i),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  status: z.enum(["draft", "enabled", "disabled", "stale"]),
  risk: riskSchema,
  trigger: triggerSchema,
  inputs: z.array(inputSchema).max(100),
  steps: z.array(stepSchema).min(1).max(300),
  stats: statsSchema,
  source: z.enum(["learned", "manual", "imported"]),
  sourceTraceId: z.string().trim().min(1).max(120).optional(),
  version: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((skill, context) => {
  const inputNames = new Set(skill.inputs.map((input) => input.name));
  if (inputNames.size !== skill.inputs.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill input names must be unique." });
  }
  if (skill.inputs.some((input) => input.sensitive)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Sensitive inputs cannot be stored or replayed by browser skills." });
  }
  const stepIds = new Set(skill.steps.map((step) => step.id));
  if (stepIds.size !== skill.steps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill step IDs must be unique." });
  }
  const referenced = collectPlaceholders(skill.steps.map((step) => step.params));
  for (const name of referenced) {
    if (!inputNames.has(name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Step references undeclared input ${name}.` });
    }
  }
  for (const name of inputNames) {
    if (!referenced.has(name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Input ${name} is not used by any step.` });
    }
  }
});

const pageStateSchema = z.object({
  url: z.string().max(4_000).optional(),
  title: z.string().max(500).optional(),
}).strict();

const traceOperationSchema = z.object({
  id: z.string().min(1).max(120),
  method: z.string().refine((value) => traceableMethodSet.has(value), "Unsupported trace method."),
  label: z.string().min(1).max(200),
  params: paramsSchema,
  target: targetSchema.optional(),
  risk: riskSchema,
  before: pageStateSchema.optional(),
  after: pageStateSchema.optional(),
  outcome: z.enum(["success", "error", "cancelled"]),
  detail: z.string().max(1_000).optional(),
  durationMs: z.number().finite().min(0).max(24 * 60 * 60 * 1_000),
  occurredAt: timestampSchema,
  inputLabels: z.record(z.string().min(1).max(160)),
  learnable: z.boolean(),
}).strict();

const traceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(120),
  clientSessionKey: z.string().regex(/^session-[a-f0-9]{24}$/),
  title: z.string().min(1).max(160),
  query: z.string().max(1_000).optional(),
  host: z.string().max(253).optional(),
  status: z.enum(["recording", "ready", "learned", "discarded"]),
  operations: z.array(traceOperationSchema).max(MAX_OPERATIONS_PER_TRACE),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  draftSkillId: z.string().min(1).max(120).optional(),
}).strict();

const skillStoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  savedAt: timestampSchema,
  skills: z.array(skillSchema).max(MAX_SKILLS),
}).strict();

const traceStoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  savedAt: timestampSchema,
  traces: z.array(traceSchema).max(MAX_TRACES),
}).strict();

const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_VERSION),
  exportedAt: timestampSchema,
  skill: skillSchema,
}).strict();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!trimmed) return undefined;
  return redactObviousSecrets(trimmed).slice(0, maximum);
}

function redactObviousSecrets(value: string): string {
  return value
    .replace(/\b(?:bearer\s+)?[a-z0-9_-]{24,}\.[a-z0-9._-]{12,}\b/gi, REDACTED_VALUE)
    .replace(/\b(?:sk|pk|api|token|secret)[-_][a-z0-9_-]{16,}\b/gi, REDACTED_VALUE);
}

function sanitizeUrl(value: unknown): string | undefined {
  const text = cleanText(value, 4_000);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => segment.length > 96 || /^[a-f0-9_-]{48,}$/i.test(segment) ? ":redacted" : segment)
      .join("/");
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hostFromUrl(value: unknown): string | undefined {
  const sanitized = sanitizeUrl(value);
  if (!sanitized) return undefined;
  try {
    return new URL(sanitized).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function sanitizeTarget(value: BrowserSkillTarget | undefined): BrowserSkillTarget | undefined {
  if (!value) return undefined;
  const target: BrowserSkillTarget = {};
  const assign = (key: keyof BrowserSkillTarget, maximum: number) => {
    const cleaned = cleanText(value[key], maximum);
    if (cleaned) target[key] = cleaned;
  };
  assign("tag", 40);
  assign("role", 80);
  assign("name", 300);
  assign("text", 500);
  assign("type", 80);
  assign("placeholder", 300);
  const hrefPath = cleanText(value.hrefPath, 1_000);
  if (hrefPath?.startsWith("/")) target.hrefPath = hrefPath.split(/[?#]/, 1)[0];
  return Object.keys(target).length > 0 ? target : undefined;
}

function targetIsSensitive(target: BrowserSkillTarget | undefined): boolean {
  if (!target) return false;
  return target.type?.toLowerCase() === "password"
    || [target.name, target.text, target.placeholder, target.role].some((value) => value && sensitiveTargetPattern.test(value));
}

function sanitizeJsonValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (sensitiveKeyPattern.test(key)) return REDACTED_VALUE;
  if (executableKeyPattern.test(key)) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return redactObviousSecrets(value).slice(0, 10_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeJsonValue(item, "", depth + 1)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 100)) {
    if (["__proto__", "prototype", "constructor"].includes(nestedKey)) continue;
    const sanitized = sanitizeJsonValue(nestedValue, nestedKey, depth + 1);
    if (sanitized !== undefined) result[nestedKey] = sanitized;
  }
  return result;
}

function normalizeParams(method: string, raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = methodParameterKeys[method];
  if (!allowed) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!allowed.has(key)) continue;
    const sanitized = sanitizeJsonValue(value, key);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function validateMethodParams(method: string, params: Record<string, unknown>, target?: BrowserSkillTarget): string | null {
  const allowed = methodParameterKeys[method];
  if (!allowed) return `Method ${method} is not permitted.`;
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) return `Parameter ${key} is not permitted for ${method}.`;
    if (sensitiveKeyPattern.test(key) || executableKeyPattern.test(key)) return `Parameter ${key} is not permitted in a browser skill.`;
  }
  if (method === "browser.navigate" || method === "browser.tab_new") {
    const url = params.url;
    if (url !== undefined && typeof url !== "string") return `${method} url must be a string.`;
    if (typeof url === "string" && /^(?:javascript|data|file|vbscript):/i.test(url.trim())) return "Executable or local URL schemes are not permitted.";
    if (method === "browser.navigate" && (typeof url !== "string" || !url.trim())) return "browser.navigate requires url.";
  }
  if (method === "browser.act") {
    const actions = ["click", "double_click", "hover", "fill", "press", "select", "focus", "check", "uncheck", "scroll"];
    if (typeof params.action !== "string" || !actions.includes(params.action)) return "browser.act has an invalid action.";
    if (!["press", "scroll"].includes(params.action) && !target) return `browser.act ${params.action} requires a semantic target.`;
    if (params.action === "fill" && typeof params.text !== "string") return "browser.act fill requires text.";
    if (params.action === "select" && typeof params.value !== "string") return "browser.act select requires value.";
    if (params.action === "press" && typeof params.key !== "string") return "browser.act press requires key.";
  }
  if (method === "browser.wait") {
    const conditions = ["load", "idle", "url", "text", "selector"];
    if (typeof params.condition !== "string" || !conditions.includes(params.condition)) return "browser.wait has an invalid condition.";
    if (["url", "text", "selector"].includes(params.condition) && typeof params.value !== "string") return `browser.wait ${params.condition} requires value.`;
  }
  return null;
}

function collectPlaceholders(values: unknown[]): Set<string> {
  const placeholders = new Set<string>();
  const pending = [...values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
      for (const match of value.matchAll(INPUT_PLACEHOLDER_PATTERN)) placeholders.add(match[1].toLowerCase());
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value as Record<string, unknown>));
    }
  }
  return placeholders;
}

function sessionKey(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || normalized.length > 2_000) throw new Error("A valid client session ID is required.");
  return `session-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function deterministicInputName(traceId: string, operationIndex: number, key: string): string {
  const digest = createHash("sha256").update(`${traceId}:${operationIndex}:${key}`).digest("hex").slice(0, 8);
  return `input_${digest}`;
}

function containsInputPlaceholder(value: unknown): boolean {
  return collectPlaceholders([value]).size > 0;
}

function parameterizeRawValues(
  traceId: string,
  operationIndex: number,
  method: string,
  params: Record<string, unknown>,
  target: BrowserSkillTarget | undefined,
  inputLabels: Record<string, string>,
): { params: Record<string, unknown>; learnable: boolean } {
  const normalized = { ...params };
  const sensitive = targetIsSensitive(target);
  const parameterize = (key: string, fallbackLabel: string) => {
    const value = normalized[key];
    if (typeof value !== "string" || !value || containsInputPlaceholder(value)) return;
    if (value === REDACTED_VALUE) return;
    if (sensitive) {
      normalized[key] = REDACTED_VALUE;
      return;
    }
    const name = deterministicInputName(traceId, operationIndex, key);
    normalized[key] = `{{${name}}}`;
    inputLabels[name] ||= cleanText(target?.name || target?.placeholder || fallbackLabel, 160) || fallbackLabel;
  };

  if (method === "browser.act" && normalized.action === "fill") parameterize("text", "Text");
  if (method === "browser.act" && normalized.action === "select") parameterize("value", "Selection");
  if (method === "browser.wait" && ["text", "url"].includes(String(normalized.condition))) parameterize("value", "Expected value");
  if ((method === "browser.navigate" || method === "browser.tab_new") && typeof normalized.url === "string") {
    const safeUrl = sanitizeUrl(normalized.url);
    if (safeUrl) normalized.url = safeUrl;
    else parameterize("url", "Destination");
  }
  return { params: normalized, learnable: !sensitive };
}

function sanitizePageState(value: BrowserSkillTracePageState | undefined): BrowserSkillTracePageState | undefined {
  if (!value) return undefined;
  const url = sanitizeUrl(value.url);
  const title = cleanText(value.title, 500);
  return url || title ? { url, title } : undefined;
}

function inferRisk(method: string, params: Record<string, unknown>, target?: BrowserSkillTarget): BrowserSkillRisk {
  if (method === "browser.act") {
    if (["hover", "focus", "scroll"].includes(String(params.action))) return "read_only";
    if (params.action === "press" && String(params.key || "").toLowerCase() === "enter") return "confirmation";
    const targetDescription = [target?.name, target?.text, target?.placeholder].filter(Boolean).join(" ");
    if (confirmationTargetPattern.test(targetDescription)) return "confirmation";
    return "interaction";
  }
  if (method === "browser.dialog_respond" || method === "browser.assistance_complete") return "confirmation";
  return "read_only";
}

function maxRisk(...risks: BrowserSkillRisk[]): BrowserSkillRisk {
  const rank: Record<BrowserSkillRisk, number> = { read_only: 0, interaction: 1, confirmation: 2 };
  return risks.reduce((highest, risk) => rank[risk] > rank[highest] ? risk : highest, "read_only");
}

function defaultOperationLabel(method: string, params: Record<string, unknown>, target?: BrowserSkillTarget): string {
  const action = typeof params.action === "string" ? ` ${params.action.replace(/_/g, " ")}` : "";
  const targetName = target?.name || target?.text || target?.placeholder;
  return `${method.replace(/^browser\./, "").replace(/[._]/g, " ")}${action}${targetName ? `: ${targetName}` : ""}`.slice(0, 200);
}

function toTraceSummary(trace: BrowserSkillTrace): BrowserSkillTraceSummary {
  return {
    id: trace.id,
    title: trace.title,
    host: trace.host,
    status: trace.status,
    operationCount: trace.operations.length,
    startedAt: trace.startedAt,
    updatedAt: trace.updatedAt,
    draftSkillId: trace.draftSkillId,
  };
}

function generalizedPath(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname || "/";
    const generalized = pathname.split("/").map((segment) => {
      if (/^\d+$/.test(segment)) return "*";
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(segment)) return "*";
      if (/^[a-f0-9_-]{24,}$/i.test(segment)) return "*";
      return segment;
    }).join("/");
    return generalized || "/";
  } catch {
    return undefined;
  }
}

function keywordsFromText(...values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of value.toLowerCase().split(/[\s,.;:!?()[\]{}<>/\\|，。；：！？（）【】《》]+/u)) {
      const cleaned = token.trim().slice(0, 120);
      if (cleaned.length < 2 || /^(?:the|and|for|with|from|this|that|browser|workflow|task)$/i.test(cleaned)) continue;
      seen.add(cleaned);
      if (seen.size >= 20) return [...seen];
    }
  }
  return [...seen];
}

function inputTypeFor(name: string, occurrences: Array<{ key: string; label?: string }>): BrowserSkillInput["type"] {
  const text = `${name} ${occurrences.map((item) => `${item.key} ${item.label || ""}`).join(" ")}`;
  return /(?:url|uri|link|网址|链接)/i.test(text) ? "url" : "text";
}

function humanizeInputName(name: string): string {
  const text = name.replace(/^input_/, "").replace(/_/g, " ").trim();
  return text ? `Input ${text}` : "Input";
}

function collectInputOccurrences(operations: BrowserSkillTraceOperation[]): Map<string, Array<{ key: string; label?: string }>> {
  const result = new Map<string, Array<{ key: string; label?: string }>>();
  for (const operation of operations) {
    for (const [key, value] of Object.entries(operation.params)) {
      for (const name of collectPlaceholders([value])) {
        const entries = result.get(name) || [];
        entries.push({ key, label: operation.inputLabels[name] });
        result.set(name, entries);
      }
    }
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function globMatches(pattern: string, pathname: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(pathname);
}

export function isTraceableBrowserSkillMethod(method: string): boolean {
  return traceableMethodSet.has(method);
}

export function isLearnableBrowserSkillMethod(method: string): boolean {
  return learnableMethodSet.has(method);
}

export class BrowserSkillService {
  private readonly rootDir: string;
  private readonly skillsPath: string;
  private readonly tracesPath: string;
  private readonly skills = new Map<string, BrowserSkill>();
  private readonly traces = new Map<string, BrowserSkillTrace>();
  private initialization: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, "browser-skills");
    this.skillsPath = path.join(this.rootDir, "skills.json");
    this.tracesPath = path.join(this.rootDir, "traces.json");
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.loadStores().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async listSkills(includeDrafts = true): Promise<BrowserSkill[]> {
    await this.awaitReads();
    return [...this.skills.values()]
      .filter((skill) => includeDrafts || skill.status !== "draft")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
      .map(clone);
  }

  async getSkill(id: string): Promise<BrowserSkill | null> {
    await this.awaitReads();
    const skill = this.skills.get(id);
    return skill ? clone(skill) : null;
  }

  async saveSkill(value: BrowserSkill): Promise<BrowserSkill> {
    return this.mutate(async () => {
      const parsed = this.parseAndNormalizeSkill(value);
      const existing = this.skills.get(parsed.id);
      const now = nowIso();
      const saved = this.parseAndNormalizeSkill({
        ...parsed,
        createdAt: existing?.createdAt || parsed.createdAt,
        updatedAt: now,
        version: existing ? existing.version + 1 : parsed.version,
      });
      if (!existing && this.skills.size >= MAX_SKILLS) throw new Error(`At most ${MAX_SKILLS} browser skills can be stored.`);
      this.skills.set(saved.id, saved);
      await this.persistSkills();
      return clone(saved);
    });
  }

  async setStatus(id: string, status: BrowserSkillStatus): Promise<BrowserSkill> {
    if (!statusValues.includes(status)) throw new Error(`Invalid browser skill status: ${status}`);
    return this.mutate(async () => {
      const skill = this.requireSkill(id);
      const updated = this.parseAndNormalizeSkill({
        ...skill,
        status,
        version: skill.version + 1,
        updatedAt: nowIso(),
      });
      this.skills.set(id, updated);
      await this.persistSkills();
      return clone(updated);
    });
  }

  async deleteSkill(id: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.skills.delete(id)) throw new Error(`Browser skill not found: ${id}`);
      for (const trace of this.traces.values()) {
        if (trace.draftSkillId !== id) continue;
        trace.draftSkillId = undefined;
        if (trace.status === "learned") trace.status = "ready";
        trace.updatedAt = nowIso();
      }
      await Promise.all([this.persistSkills(), this.persistTraces()]);
    });
  }

  async importSkill(sourcePath: string): Promise<BrowserSkill> {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error("Browser skill import must be a JSON file no larger than 2 MB.");
    const raw = await fs.readFile(sourcePath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Browser skill import is not valid JSON.");
    }
    const imported = this.parseSkillExport(parsedJson);
    return this.mutate(async () => {
      if (this.skills.size >= MAX_SKILLS) throw new Error(`At most ${MAX_SKILLS} browser skills can be stored.`);
      const now = nowIso();
      const contentHash = createHash("sha256").update(stableStringify(imported)).digest("hex").slice(0, 20);
      let id = `imported-${contentHash}`;
      let suffix = 2;
      while (this.skills.has(id)) id = `imported-${contentHash}-${suffix++}`;
      const skill = this.parseAndNormalizeSkill({
        ...imported,
        id,
        status: "disabled",
        source: "imported",
        sourceTraceId: undefined,
        stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.skills.set(skill.id, skill);
      await this.persistSkills();
      return clone(skill);
    });
  }

  async exportSkill(id: string, destinationPath: string): Promise<string> {
    await this.awaitReads();
    const skill = this.requireSkill(id);
    const payload = {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_VERSION,
      exportedAt: nowIso(),
      skill,
    };
    exportSchema.parse(payload);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await this.atomicWrite(destinationPath, `${JSON.stringify(payload, null, 2)}\n`);
    return destinationPath;
  }

  parseSkillExport(value: unknown): BrowserSkill {
    const candidate = value && typeof value === "object" && "format" in value
      ? exportSchema.parse(value).skill
      : skillSchema.parse(value);
    return this.parseAndNormalizeSkill(candidate);
  }

  async startTrace(sessionId: string, options: BrowserSkillTraceStartOptions = {}): Promise<BrowserSkillTraceSummary> {
    return this.mutate(async () => {
      const key = sessionKey(sessionId);
      const existing = this.latestTraceForSession(key, "recording");
      if (existing && !options.forceNew) return toTraceSummary(existing);
      if (existing) {
        existing.status = "ready";
        existing.updatedAt = nowIso();
      }
      const timestamp = nowIso();
      const url = sanitizeUrl(options.url);
      const trace: BrowserSkillTrace = {
        schemaVersion: 1,
        id: `trace-${randomUUID()}`,
        clientSessionKey: key,
        title: cleanText(options.title, 160) || "Browser workflow",
        query: cleanText(options.query, 1_000),
        host: hostFromUrl(url),
        status: "recording",
        operations: [],
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      this.traces.set(trace.id, trace);
      this.pruneTraces();
      await this.persistTraces();
      return toTraceSummary(trace);
    });
  }

  async recordOperation(sessionId: string, input: BrowserSkillTraceOperationInput): Promise<BrowserSkillTraceSummary | null> {
    if (!isTraceableBrowserSkillMethod(input.method)) return null;
    return this.mutate(async () => {
      const key = sessionKey(sessionId);
      let trace = this.latestTraceForSession(key, "recording");
      if (!trace) {
        const timestamp = nowIso();
        trace = {
          schemaVersion: 1,
          id: `trace-${randomUUID()}`,
          clientSessionKey: key,
          title: cleanText(input.label, 160) || "Browser workflow",
          host: hostFromUrl(input.before?.url || input.after?.url),
          status: "recording",
          operations: [],
          startedAt: timestamp,
          updatedAt: timestamp,
        };
        this.traces.set(trace.id, trace);
      }
      if (trace.operations.length >= MAX_OPERATIONS_PER_TRACE) throw new Error(`A browser skill trace cannot exceed ${MAX_OPERATIONS_PER_TRACE} operations.`);
      const operation = this.sanitizeOperation(trace, input);
      trace.operations.push(operation);
      trace.host ||= hostFromUrl(operation.before?.url || operation.after?.url);
      trace.updatedAt = operation.occurredAt;
      this.pruneTraces();
      await this.persistTraces();
      return toTraceSummary(trace);
    });
  }

  async finalizeTrace(sessionId: string, options: BrowserSkillDraftOptions = {}): Promise<BrowserSkillFinalization> {
    return this.mutate(async () => {
      const key = sessionKey(sessionId);
      const trace = this.latestTraceForSession(key, "recording");
      if (!trace) throw new Error("No recording browser skill trace exists for this client session.");
      trace.status = "ready";
      trace.updatedAt = nowIso();
      const skill = this.createSkillFromTraceUnlocked(trace, options);
      if (skill) {
        this.skills.set(skill.id, skill);
        trace.status = "learned";
        trace.draftSkillId = skill.id;
      }
      await Promise.all([this.persistSkills(), this.persistTraces()]);
      return { trace: toTraceSummary(trace), skill: skill ? clone(skill) : null };
    });
  }

  async createSkillFromTrace(traceId: string, options: BrowserSkillDraftOptions = {}): Promise<BrowserSkill> {
    return this.mutate(async () => {
      const trace = this.traces.get(traceId);
      if (!trace) throw new Error(`Browser skill trace not found: ${traceId}`);
      if (trace.status === "discarded") throw new Error("A discarded trace cannot be converted into a browser skill.");
      const existing = trace.draftSkillId ? this.skills.get(trace.draftSkillId) : undefined;
      if (existing) return clone(existing);
      const skill = this.createSkillFromTraceUnlocked(trace, options);
      if (!skill) throw new Error("The trace has no successful, replayable browser operations.");
      this.skills.set(skill.id, skill);
      trace.status = "learned";
      trace.draftSkillId = skill.id;
      trace.updatedAt = nowIso();
      await Promise.all([this.persistSkills(), this.persistTraces()]);
      return clone(skill);
    });
  }

  async listTraceSummaries(includeDiscarded = false): Promise<BrowserSkillTraceSummary[]> {
    await this.awaitReads();
    return [...this.traces.values()]
      .filter((trace) => includeDiscarded || trace.status !== "discarded")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((trace) => clone(toTraceSummary(trace)));
  }

  async getTrace(traceId: string): Promise<BrowserSkillTrace | null> {
    await this.awaitReads();
    const trace = this.traces.get(traceId);
    return trace ? clone(trace) : null;
  }

  async discardTrace(traceId: string): Promise<void> {
    await this.mutate(async () => {
      const trace = this.traces.get(traceId);
      if (!trace) throw new Error(`Browser skill trace not found: ${traceId}`);
      trace.status = "discarded";
      trace.updatedAt = nowIso();
      await this.persistTraces();
    });
  }

  async matchSkills(query = "", url = "", limit = 10): Promise<BrowserSkillMatch[]> {
    await this.awaitReads();
    const normalizedQuery = query.trim().toLowerCase();
    const parsedUrl = sanitizeUrl(url);
    const host = hostFromUrl(parsedUrl);
    const pathname = parsedUrl ? new URL(parsedUrl).pathname : undefined;
    const matches: BrowserSkillMatch[] = [];
    for (const skill of this.skills.values()) {
      if (skill.status !== "enabled") continue;
      const reasons: string[] = [];
      let score = 0;
      const hostMatches = host && skill.trigger.hosts.some((candidate) => {
        const normalized = candidate.toLowerCase();
        return normalized.startsWith("*.")
          ? host === normalized.slice(2) || host.endsWith(`.${normalized.slice(2)}`)
          : host === normalized;
      });
      if (host && skill.trigger.hosts.length > 0 && !hostMatches) continue;
      if (hostMatches) {
        score += 50;
        reasons.push(`host:${host}`);
      }
      const pathMatches = pathname && skill.trigger.pathPatterns.some((pattern) => globMatches(pattern, pathname));
      if (pathname && skill.trigger.pathPatterns.length > 0 && !pathMatches) continue;
      if (pathMatches) {
        score += 25;
        reasons.push(`path:${pathname}`);
      }
      for (const keyword of skill.trigger.keywords) {
        if (normalizedQuery && normalizedQuery.includes(keyword.toLowerCase())) {
          score += 10;
          reasons.push(`keyword:${keyword}`);
        }
      }
      if (score === 0 && skill.trigger.hosts.length + skill.trigger.pathPatterns.length + skill.trigger.keywords.length > 0) continue;
      if (skill.stats.runCount > 0) score += Math.round((skill.stats.successCount / skill.stats.runCount) * 10);
      matches.push({ skill: clone(skill), score, reasons });
    }
    return matches
      .sort((left, right) => right.score - left.score
        || right.skill.stats.successCount - left.skill.stats.successCount
        || right.skill.updatedAt.localeCompare(left.skill.updatedAt)
        || left.skill.id.localeCompare(right.skill.id))
      .slice(0, Math.max(1, Math.min(50, Math.floor(limit) || 10)));
  }

  async recordRunResult(id: string, success: boolean, durationMs: number, completedAt = nowIso()): Promise<BrowserSkill> {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1_000) throw new Error("Browser skill duration is invalid.");
    if (Number.isNaN(Date.parse(completedAt))) throw new Error("Browser skill completion time is invalid.");
    return this.mutate(async () => {
      const skill = this.requireSkill(id);
      const previousRuns = skill.stats.runCount;
      const runCount = previousRuns + 1;
      const updated = this.parseAndNormalizeSkill({
        ...skill,
        stats: {
          runCount,
          successCount: skill.stats.successCount + (success ? 1 : 0),
          failureCount: skill.stats.failureCount + (success ? 0 : 1),
          averageDurationMs: ((skill.stats.averageDurationMs * previousRuns) + durationMs) / runCount,
          lastRunAt: new Date(completedAt).toISOString(),
          lastSuccessAt: success ? new Date(completedAt).toISOString() : skill.stats.lastSuccessAt,
        },
        updatedAt: nowIso(),
      });
      this.skills.set(id, updated);
      await this.persistSkills();
      return clone(updated);
    });
  }

  private async loadStores(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const [skillStore, traceStore] = await Promise.all([
      this.readStore(this.skillsPath, skillStoreSchema, { version: STORE_VERSION, savedAt: nowIso(), skills: [] }),
      this.readStore(this.tracesPath, traceStoreSchema, { version: STORE_VERSION, savedAt: nowIso(), traces: [] }),
    ]);
    this.skills.clear();
    for (const skill of skillStore.skills) this.skills.set(skill.id, this.parseAndNormalizeSkill(skill));
    this.traces.clear();
    for (const trace of traceStore.traces) this.traces.set(trace.id, trace as BrowserSkillTrace);
    this.pruneTraces();
  }

  private async readStore<T>(targetPath: string, schema: z.ZodType<T>, empty: T): Promise<T> {
    try {
      const raw = await fs.readFile(targetPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES * 4) throw new Error("Store file is too large.");
      return schema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      await fs.rename(targetPath, `${targetPath}.invalid-${Date.now()}`).catch(() => undefined);
      return empty;
    }
  }

  private parseAndNormalizeSkill(value: unknown): BrowserSkill {
    const parsed = skillSchema.parse(value) as BrowserSkill;
    const steps = parsed.steps.map((step) => {
      const inferred = inferRisk(step.method, step.params, step.target);
      return { ...step, risk: maxRisk(step.risk, inferred) };
    });
    const inputRisk: BrowserSkillRisk = parsed.inputs.some((input) => input.sensitive) ? "confirmation" : "read_only";
    const normalized = {
      ...parsed,
      risk: maxRisk(parsed.risk, inputRisk, ...steps.map((step) => step.risk)),
      trigger: {
        hosts: [...new Set(parsed.trigger.hosts.map((host) => host.toLowerCase()))],
        pathPatterns: [...new Set(parsed.trigger.pathPatterns)],
        keywords: [...new Set(parsed.trigger.keywords.map((keyword) => keyword.toLowerCase()))],
      },
      steps,
    };
    return skillSchema.parse(normalized) as BrowserSkill;
  }

  private sanitizeOperation(trace: BrowserSkillTrace, input: BrowserSkillTraceOperationInput): BrowserSkillTraceOperation {
    const target = sanitizeTarget(input.target);
    const normalizedParams = normalizeParams(input.method, input.params);
    const labels: Record<string, string> = {};
    for (const [name, label] of Object.entries(input.inputLabels || {})) {
      const normalizedName = name.toLowerCase();
      const cleaned = cleanText(label, 160);
      if (IDENTIFIER_PATTERN.test(normalizedName) && normalizedName.startsWith("input_") && cleaned) labels[normalizedName] = cleaned;
    }
    const parameterized = parameterizeRawValues(trace.id, trace.operations.length, input.method, normalizedParams, target, labels);
    const inferredRisk = inferRisk(input.method, parameterized.params, target);
    const requestedRisk = input.risk && riskValues.includes(input.risk) ? input.risk : "read_only";
    const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt))
      ? new Date(input.occurredAt).toISOString()
      : nowIso();
    const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.min(24 * 60 * 60 * 1_000, Number(input.durationMs))) : 0;
    const outcome: BrowserSkillTraceOutcome = ["success", "error", "cancelled"].includes(String(input.outcome))
      ? input.outcome as BrowserSkillTraceOutcome
      : "success";
    const operation: BrowserSkillTraceOperation = {
      id: `operation-${String(trace.operations.length + 1).padStart(4, "0")}`,
      method: input.method,
      label: cleanText(input.label, 200) || defaultOperationLabel(input.method, parameterized.params, target),
      params: parameterized.params,
      target,
      risk: maxRisk(requestedRisk, inferredRisk),
      before: sanitizePageState(input.before),
      after: sanitizePageState(input.after),
      outcome,
      detail: cleanText(input.detail, 1_000),
      durationMs,
      occurredAt,
      inputLabels: labels,
      learnable: learnableMethodSet.has(input.method)
        && parameterized.learnable
        && validateMethodParams(input.method, parameterized.params, target) === null
        && !Object.values(parameterized.params).includes(REDACTED_VALUE),
    };
    return traceOperationSchema.parse(operation) as BrowserSkillTraceOperation;
  }

  private createSkillFromTraceUnlocked(trace: BrowserSkillTrace, options: BrowserSkillDraftOptions): BrowserSkill | null {
    const existingId = trace.draftSkillId || `learned-${createHash("sha256").update(trace.id).digest("hex").slice(0, 24)}`;
    const existing = this.skills.get(existingId);
    if (existing) {
      if (existing.sourceTraceId !== trace.id) throw new Error(`Browser skill ID collision: ${existingId}`);
      return existing;
    }
    const replayable = trace.operations.filter((operation) => operation.learnable && operation.outcome === "success");
    if (replayable.length === 0) return null;
    const steps: BrowserSkillStep[] = replayable.map((operation, index) => ({
      id: `step-${String(index + 1).padStart(3, "0")}`,
      label: operation.label,
      method: operation.method,
      params: clone(operation.params),
      target: operation.target ? clone(operation.target) : undefined,
      risk: operation.risk,
    }));
    const occurrences = collectInputOccurrences(replayable);
    const inputs: BrowserSkillInput[] = [...occurrences.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entries]) => ({
        name,
        label: entries.find((entry) => entry.label)?.label || humanizeInputName(name),
        type: inputTypeFor(name, entries),
        required: true,
        sensitive: false,
      }));
    const urls = replayable.flatMap((operation) => [operation.before?.url, operation.after?.url]).filter((value): value is string => Boolean(value));
    const hosts = [...new Set(urls.map(hostFromUrl).filter((value): value is string => Boolean(value)))].sort();
    const paths = [...new Set(urls.map(generalizedPath).filter((value): value is string => Boolean(value)))].sort();
    const timestamp = nowIso();
    const skill: BrowserSkill = {
      schemaVersion: 1,
      id: existingId,
      name: cleanText(options.name, 120) || trace.title,
      description: cleanText(options.description, 2_000) || `Learned from ${steps.length} successful browser operation${steps.length === 1 ? "" : "s"}.`,
      status: "draft",
      risk: maxRisk(...steps.map((step) => step.risk)),
      trigger: {
        hosts,
        pathPatterns: paths,
        keywords: keywordsFromText(trace.query, trace.title),
      },
      inputs,
      steps,
      stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
      source: "learned",
      sourceTraceId: trace.id,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.parseAndNormalizeSkill(skill);
  }

  private latestTraceForSession(key: string, status: BrowserSkillTraceStatus): BrowserSkillTrace | undefined {
    return [...this.traces.values()]
      .filter((trace) => trace.clientSessionKey === key && trace.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  private pruneTraces(): void {
    const cutoff = Date.now() - TRACE_RETENTION_MS;
    const ordered = [...this.traces.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const trace of ordered) {
      if (trace.status !== "recording" && Date.parse(trace.updatedAt) < cutoff) this.traces.delete(trace.id);
    }
    const remaining = [...this.traces.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const trace of remaining.slice(MAX_TRACES)) {
      if (trace.status !== "recording") this.traces.delete(trace.id);
    }
  }

  private requireSkill(id: string): BrowserSkill {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Browser skill not found: ${id}`);
    return skill;
  }

  private async awaitReads(): Promise<void> {
    await this.initialize();
    await this.mutationQueue;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const pending = this.mutationQueue.then(operation, operation);
    this.mutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async persistSkills(): Promise<void> {
    const store: SkillStore = {
      version: STORE_VERSION,
      savedAt: nowIso(),
      skills: [...this.skills.values()],
    };
    skillStoreSchema.parse(store);
    await this.atomicWrite(this.skillsPath, `${JSON.stringify(store, null, 2)}\n`);
  }

  private async persistTraces(): Promise<void> {
    const store: TraceStore = {
      version: STORE_VERSION,
      savedAt: nowIso(),
      traces: [...this.traces.values()],
    };
    traceStoreSchema.parse(store);
    await this.atomicWrite(this.tracesPath, `${JSON.stringify(store, null, 2)}\n`);
  }

  private async atomicWrite(targetPath: string, contents: string): Promise<void> {
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, targetPath);
  }
}
