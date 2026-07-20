import type { CdpEndpoint, CdpEvent, CdpTransport } from "./cdp-transport";
import type { ExtensionRelayServer, RelayEvent, RelayResponse } from "./extension-relay-server";

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Waiter { sessionId?: string; predicate(value: unknown): boolean; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class ExtensionRelayCdpTransport implements CdpTransport {
  private readonly relay: ExtensionRelayServer;
  private nextId = 1;
  private active = false;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly unsubscribe: () => void;

  constructor(relay: ExtensionRelayServer) {
    this.relay = relay;
    this.unsubscribe = relay.onEnvelope((responses, events) => this.handleEnvelope(responses, events));
  }

  async connect(_endpoint: CdpEndpoint): Promise<void> { await this.connectRelay(); }
  async connectRelay(): Promise<void> { await this.relay.waitForConnection(); this.active = true; }
  async disconnect(): Promise<void> {
    this.active = false;
    const error = new Error("The ordinary Edge relay control connection was closed.");
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const group of this.waiters.values()) {
      for (const waiter of group) { clearTimeout(waiter.timer); waiter.reject(error); }
    }
    this.waiters.clear();
  }
  dispose(): void { this.unsubscribe(); void this.disconnect(); }
  isConnected(): boolean { return this.active && this.relay.connected(); }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (!this.isConnected()) return Promise.reject(new Error("The ordinary Edge relay extension is not connected."));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Ordinary Edge relay timed out while running ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.relay.enqueue({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return promise;
  }

  waitForEvent<T>(method: string, options: { sessionId?: string; timeoutMs?: number; predicate?: (params: T) => boolean } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        sessionId: options.sessionId, predicate: (value) => options.predicate ? options.predicate(value as T) : true,
        resolve: resolve as (value: unknown) => void, reject,
        timer: setTimeout(() => { this.waiters.get(method)?.delete(waiter); reject(new Error(`Timed out waiting for ordinary Edge ${method}.`)); }, options.timeoutMs ?? 15_000),
      };
      const group = this.waiters.get(method) || new Set<Waiter>(); group.add(waiter); this.waiters.set(method, group);
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private handleEnvelope(responses: RelayResponse[], events: RelayEvent[]): void {
    for (const response of responses) {
      const pending = this.pending.get(response.id); if (!pending) continue;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error.message || "Ordinary Edge rejected a browser command.")); else pending.resolve(response.result);
    }
    for (const input of events) {
      if (!input?.method) continue;
      const event: CdpEvent = { method: input.method, params: input.params || {}, sessionId: input.sessionId };
      for (const listener of this.listeners) listener(event);
      const group = this.waiters.get(event.method); if (!group) continue;
      for (const waiter of [...group]) {
        if (waiter.sessionId && waiter.sessionId !== event.sessionId) continue;
        if (!waiter.predicate(event.params)) continue;
        clearTimeout(waiter.timer); group.delete(waiter); waiter.resolve(event.params);
      }
      if (!group.size) this.waiters.delete(event.method);
    }
  }
}
