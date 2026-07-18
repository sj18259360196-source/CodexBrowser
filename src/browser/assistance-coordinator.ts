import { randomUUID } from "node:crypto";
import type { AssistanceKind, AssistanceVerificationStrategy, HumanAssistance } from "../shared/contracts";

const ACTIVE = new Set(["waiting_user", "verifying"]);
const PRIORITY: Record<AssistanceKind, number> = {
  manual_action: 1, consent: 2, permission: 3, file_selection: 4, certificate: 5,
  challenge: 6, credential: 7, verification: 8, passkey: 9,
};

export interface AssistanceRequest {
  tabId: string;
  taskId: string;
  kind: AssistanceKind;
  domain: string;
  title: string;
  detail: string;
  url: string;
  verificationStrategy: AssistanceVerificationStrategy;
  note?: string;
  ttlMs?: number;
}

function assistanceError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

export class AssistanceCoordinator {
  private readonly byTab = new Map<string, HumanAssistance>();
  private readonly byId = new Map<string, HumanAssistance>();

  request(input: AssistanceRequest, now = Date.now()): { assistance: HumanAssistance; created: boolean; upgraded: boolean } {
    this.expire(now);
    const current = this.byTab.get(input.tabId);
    if (current && ACTIVE.has(current.status)) {
      const upgraded = PRIORITY[input.kind] > PRIORITY[current.kind];
      if (upgraded) {
        current.kind = input.kind;
        current.title = input.title;
        current.detail = input.detail;
        current.verificationStrategy = input.verificationStrategy;
      }
      return { assistance: { ...current }, created: false, upgraded };
    }
    const requestedAt = new Date(now).toISOString();
    const assistance: HumanAssistance = {
      id: randomUUID(), tabId: input.tabId, taskId: input.taskId, kind: input.kind,
      domain: input.domain, title: input.title, detail: input.detail, url: input.url,
      verificationStrategy: input.verificationStrategy, status: "waiting_user",
      note: input.note, requestedAt, expiresAt: new Date(now + Math.max(1_000, input.ttlMs ?? 15 * 60_000)).toISOString(),
    };
    this.byTab.set(input.tabId, assistance);
    this.byId.set(assistance.id, assistance);
    return { assistance: { ...assistance }, created: true, upgraded: false };
  }

  getByTab(tabId: string, now = Date.now()): HumanAssistance | null {
    this.expire(now);
    const value = this.byTab.get(tabId);
    return value ? { ...value } : null;
  }

  get(id: string, now = Date.now()): HumanAssistance {
    this.expire(now);
    const value = this.byId.get(id);
    if (!value) throw assistanceError("ASSISTANCE_STALE", "The assistance request is stale or missing.");
    if (value.status === "expired") throw assistanceError("ASSISTANCE_EXPIRED", "The assistance request has expired.");
    return { ...value };
  }

  beginVerification(id: string, now = Date.now()): HumanAssistance {
    const value = this.mutable(id, now);
    if (value.status !== "waiting_user") throw assistanceError("ASSISTANCE_STALE", "The assistance request is no longer waiting for the user.");
    value.status = "verifying";
    return { ...value };
  }

  verificationFailed(id: string, detail: string, now = Date.now()): HumanAssistance {
    const value = this.mutable(id, now);
    if (value.status !== "verifying") throw assistanceError("ASSISTANCE_STALE", "The assistance verification is stale.");
    value.status = "waiting_user";
    value.detail = detail;
    return { ...value };
  }

  resolve(id: string, status: "completed" | "unable" | "cancelled", note?: string, now = Date.now()): HumanAssistance {
    const value = this.mutable(id, now);
    if (!ACTIVE.has(value.status)) throw assistanceError("ASSISTANCE_STALE", "The assistance request is already resolved.");
    value.status = status;
    value.note = note;
    value.resolvedAt = new Date(now).toISOString();
    if (this.byTab.get(value.tabId)?.id === value.id) this.byTab.delete(value.tabId);
    return { ...value };
  }

  cancelAll(note = "The browser task was stopped.", now = Date.now()): HumanAssistance[] {
    return [...this.byId.values()].filter((value) => ACTIVE.has(value.status)).map((value) => this.resolve(value.id, "cancelled", note, now));
  }

  private mutable(id: string, now = Date.now()): HumanAssistance {
    this.expire(now);
    const value = this.byId.get(id);
    if (!value) throw assistanceError("ASSISTANCE_STALE", "The assistance request is stale or missing.");
    if (value.status === "expired") throw assistanceError("ASSISTANCE_EXPIRED", "The assistance request has expired.");
    return value;
  }

  private expire(now: number): void {
    for (const value of this.byId.values()) {
      if (!ACTIVE.has(value.status) || !value.expiresAt || Date.parse(value.expiresAt) > now) continue;
      value.status = "expired";
      value.resolvedAt = new Date(now).toISOString();
      if (this.byTab.get(value.tabId)?.id === value.id) this.byTab.delete(value.tabId);
    }
  }
}
