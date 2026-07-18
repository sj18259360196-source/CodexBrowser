import { randomUUID } from "node:crypto";
import type { ActionRiskCategory, PolicyDecision, PolicyResult } from "./policy-engine";

export type ActionConfirmationStatus = "waiting_user" | "approved" | "denied" | "executing" | "completed" | "failed" | "outcome_unknown" | "expired" | "cancelled";

export interface ActionConfirmation {
  id: string;
  tabId: string;
  taskId: string;
  category: ActionRiskCategory;
  origin: string;
  summary: string;
  impact: string;
  createdAt: string;
  expiresAt: string;
  snapshotRevision: number;
  targetRef: string;
  ruleId: string;
  status: ActionConfirmationStatus;
  resolvedAt?: string;
}

export interface RememberedGrant {
  id: string;
  profileId: string;
  origin: string;
  category: ActionRiskCategory;
  createdAt: string;
  expiresAt: string;
  tabId?: string;
  taskId?: string;
}

export interface PolicyAuditEntry {
  id: string;
  at: string;
  origin: string;
  category: ActionRiskCategory;
  ruleId: string;
  decision: PolicyDecision | "approved" | "denied" | "expired" | "executed" | "failed" | "outcome_unknown" | "grant_created" | "grant_used" | "grant_revoked";
  tabId: string;
  taskId?: string;
  result: string;
}

interface StoredConfirmation extends ActionConfirmation { consumed: boolean; }

function namedError(name: string, message: string): Error { const error = new Error(message); error.name = name; return error; }
function safe(value: string, max = 300): string { return value.replace(/https?:\/\/\S+/gi, "[url]").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

export class ActionAuthorizationStore {
  private readonly confirmations = new Map<string, StoredConfirmation>();
  private readonly grants = new Map<string, RememberedGrant>();
  private readonly audit: PolicyAuditEntry[] = [];

  recordEvaluation(input: { origin: string; tabId: string; taskId?: string }, result: PolicyResult): void {
    this.append(input.origin, result.category, result.ruleId, result.decision, input.tabId, input.taskId, "Policy evaluated");
    if (result.ruleId === "grant.scoped") this.append(input.origin, result.category, result.ruleId, "grant_used", input.tabId, input.taskId, "Temporary user grant used");
  }

  request(input: { tabId: string; taskId: string; origin: string; revision: number; ref: string; policy: PolicyResult }, now = Date.now()): ActionConfirmation {
    const existing = [...this.confirmations.values()].find((item) => item.tabId === input.tabId && item.status === "waiting_user" && item.targetRef === input.ref && item.snapshotRevision === input.revision);
    if (existing) return this.expose(existing);
    const createdAt = new Date(now).toISOString();
    const item: StoredConfirmation = {
      id: randomUUID(), tabId: input.tabId, taskId: input.taskId, category: input.policy.category,
      origin: input.origin, summary: safe(input.policy.summary), impact: safe(input.policy.impact),
      createdAt, expiresAt: new Date(now + 60_000).toISOString(), snapshotRevision: input.revision,
      targetRef: input.ref, ruleId: input.policy.ruleId, status: "waiting_user", consumed: false,
    };
    this.confirmations.set(item.id, item);
    this.append(item.origin, item.category, item.ruleId, "confirm", item.tabId, item.taskId, "Confirmation requested");
    return this.expose(item);
  }

  get(id: string, now = Date.now()): ActionConfirmation {
    const item = this.require(id);
    this.expire(item, now);
    return this.expose(item);
  }

  list(now = Date.now()): ActionConfirmation[] {
    for (const item of this.confirmations.values()) this.expire(item, now);
    return [...this.confirmations.values()].map((item) => this.expose(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  approve(id: string, now = Date.now()): ActionConfirmation {
    const item = this.requireActive(id, now);
    item.status = "approved";
    item.resolvedAt = new Date(now).toISOString();
    this.append(item.origin, item.category, item.ruleId, "approved", item.tabId, item.taskId, "User approved once");
    return this.expose(item);
  }

  deny(id: string, now = Date.now()): ActionConfirmation {
    const item = this.requireActive(id, now);
    item.consumed = true; item.status = "denied"; item.resolvedAt = new Date(now).toISOString();
    this.append(item.origin, item.category, item.ruleId, "denied", item.tabId, item.taskId, "User denied operation");
    return this.expose(item);
  }

  beginExecution(id: string, now = Date.now()): ActionConfirmation {
    const item = this.require(id);
    if (item.consumed || item.status !== "approved") throw namedError("CONFIRMATION_STALE", "The action confirmation is stale or already consumed.");
    if (Date.parse(item.expiresAt) <= now) { this.expire(item, now); throw namedError("CONFIRMATION_EXPIRED", "The action confirmation has expired."); }
    item.consumed = true; item.status = "executing";
    return this.expose(item);
  }

  finish(id: string, status: "completed" | "failed" | "outcome_unknown", result: string, now = Date.now()): ActionConfirmation {
    const item = this.require(id);
    if (item.status !== "executing") throw namedError("CONFIRMATION_STALE", "The action confirmation is not executing.");
    item.status = status; item.resolvedAt = new Date(now).toISOString();
    this.append(item.origin, item.category, item.ruleId, status === "completed" ? "executed" : status, item.tabId, item.taskId, safe(result));
    return this.expose(item);
  }

  cancelAll(reason = "Task stopped", now = Date.now()): void {
    for (const item of this.confirmations.values()) if (["waiting_user", "approved"].includes(item.status)) { item.status = "cancelled"; item.consumed = true; item.resolvedAt = new Date(now).toISOString(); }
    this.grants.clear();
    void reason;
  }

  markExecutingOutcomeUnknown(reason = "Browser connection was lost", now = Date.now()): void {
    for (const item of this.confirmations.values()) {
      if (item.status !== "executing") continue;
      item.status = "outcome_unknown";
      item.resolvedAt = new Date(now).toISOString();
      this.append(item.origin, item.category, item.ruleId, "outcome_unknown", item.tabId, item.taskId, reason);
    }
  }

  createGrant(input: { profileId: string; origin: string; category: ActionRiskCategory; tabId?: string; taskId?: string; ttlMs?: number }, now = Date.now()): RememberedGrant {
    const ttl = Math.min(30 * 60_000, Math.max(60_000, input.ttlMs || 10 * 60_000));
    const grant: RememberedGrant = { id: randomUUID(), profileId: input.profileId, origin: input.origin, category: input.category, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(), tabId: input.tabId, taskId: input.taskId };
    this.grants.set(grant.id, grant);
    this.append(grant.origin, grant.category, "grant.scoped", "grant_created", grant.tabId || "all-tabs", grant.taskId, "Temporary user grant created");
    return { ...grant };
  }

  matchingGrants(profileId: string, origin: string, tabId?: string, taskId?: string, now = Date.now()): RememberedGrant[] {
    const result: RememberedGrant[] = [];
    for (const [id, grant] of this.grants) {
      if (Date.parse(grant.expiresAt) <= now) { this.grants.delete(id); continue; }
      if (grant.profileId === profileId && grant.origin === origin && (!grant.tabId || grant.tabId === tabId) && (!grant.taskId || grant.taskId === taskId)) result.push({ ...grant });
    }
    return result;
  }

  listGrants(now = Date.now()): RememberedGrant[] { this.matchingGrants("__cleanup__", "__cleanup__", undefined, undefined, now); return [...this.grants.values()].map((grant) => ({ ...grant })); }
  revokeGrant(id: string): void { const grant = this.grants.get(id); if (!grant) throw namedError("GRANT_STALE", "The temporary grant is stale or missing."); this.grants.delete(id); this.append(grant.origin, grant.category, "grant.scoped", "grant_revoked", grant.tabId || "all-tabs", grant.taskId, "Temporary grant revoked"); }
  clearGrants(): void { this.grants.clear(); }
  auditEntries(): PolicyAuditEntry[] { return this.audit.map((entry) => ({ ...entry })); }
  clearAudit(): void { this.audit.length = 0; }

  private require(id: string): StoredConfirmation { const item = this.confirmations.get(id); if (!item) throw namedError("CONFIRMATION_STALE", "The action confirmation is stale or missing."); return item; }
  private requireActive(id: string, now: number): StoredConfirmation { const item = this.require(id); this.expire(item, now); if (item.status === "expired") throw namedError("CONFIRMATION_EXPIRED", "The action confirmation has expired."); if (item.consumed || item.status !== "waiting_user") throw namedError("CONFIRMATION_STALE", "The action confirmation is stale or already resolved."); return item; }
  private expire(item: StoredConfirmation, now: number): void { if (["waiting_user", "approved"].includes(item.status) && Date.parse(item.expiresAt) <= now) { item.status = "expired"; item.consumed = true; item.resolvedAt = new Date(now).toISOString(); this.append(item.origin, item.category, item.ruleId, "expired", item.tabId, item.taskId, "Confirmation expired"); } }
  private expose(item: StoredConfirmation): ActionConfirmation { const { consumed: _consumed, ...confirmation } = item; return { ...confirmation }; }
  private append(origin: string, category: ActionRiskCategory, ruleId: string, decision: PolicyAuditEntry["decision"], tabId: string, taskId: string | undefined, result: string): void { this.audit.unshift({ id: randomUUID(), at: new Date().toISOString(), origin: safe(origin, 200), category, ruleId, decision, tabId, taskId, result: safe(result) }); if (this.audit.length > 300) this.audit.length = 300; }
}
