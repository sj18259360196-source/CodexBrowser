export interface CdpEndpoint {
  host: "127.0.0.1";
  port: number;
  browserPath: string;
}

export interface CdpTransport {
  connect(endpoint: CdpEndpoint): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  waitForEvent<T>(method: string, options?: {
    sessionId?: string;
    timeoutMs?: number;
    predicate?: (params: T) => boolean;
  }): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  sessionId?: string;
  predicate(params: unknown): boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class LoopbackWebSocketCdpTransport implements CdpTransport {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly waiters = new Map<string, Set<EventWaiter>>();
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();

  async connect(endpoint: CdpEndpoint): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (endpoint.host !== "127.0.0.1" || endpoint.port < 1 || endpoint.port > 65_535) {
      throw new Error("Refusing to connect to a non-loopback or invalid CDP endpoint.");
    }
    if (!endpoint.browserPath.startsWith("/devtools/browser/")) {
      throw new Error("The Edge debugging discovery file contained an invalid browser endpoint.");
    }
    const socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}${endpoint.browserPath}`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out while connecting to managed Edge.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to managed Edge.")); }, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.handleClose());
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.handleClose();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.close(1000, "control reconnect");
    });
    this.handleClose();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("The managed Edge control connection is not ready.");
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Managed Edge timed out while running ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  waitForEvent<T>(method: string, options: {
    sessionId?: string;
    timeoutMs?: number;
    predicate?: (params: T) => boolean;
  } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId: options.sessionId,
        predicate: (params) => options.predicate ? options.predicate(params as T) : true,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.waiters.get(method)?.delete(waiter);
          reject(new Error(`Timed out waiting for the managed Edge ${method} event.`));
        }, options.timeoutMs ?? 15_000),
      };
      const group = this.waiters.get(method) || new Set<EventWaiter>();
      group.add(waiter);
      this.waiters.set(method, group);
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private handleMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string }; sessionId?: string };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Managed Edge rejected a browser command."));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const event: CdpEvent = {
      method: message.method,
      params: message.params && typeof message.params === "object"
        ? message.params as Record<string, unknown>
        : {},
      sessionId: message.sessionId,
    };
    for (const listener of this.eventListeners) listener(event);
    const group = this.waiters.get(message.method);
    if (!group) return;
    for (const waiter of [...group]) {
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      if (!waiter.predicate(message.params)) continue;
      clearTimeout(waiter.timer);
      group.delete(waiter);
      waiter.resolve(message.params);
    }
    if (group.size === 0) this.waiters.delete(message.method);
  }

  private handleClose(): void {
    const error = new Error("The managed Edge control connection was closed.");
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const group of this.waiters.values()) {
      for (const waiter of group) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}
