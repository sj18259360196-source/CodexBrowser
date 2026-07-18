import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RelayCommand { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
export interface RelayResponse { id: number; result?: unknown; error?: { message?: string } }
export interface RelayEvent { method: string; params?: Record<string, unknown>; sessionId?: string }
export interface ExtensionRelayStatus { paired: boolean; connected: boolean; pairingWindowOpen: boolean; port: number }

interface AuthRecord { extensionId: string; tokenHash: string }
interface ExchangeBody { token?: string; responses?: RelayResponse[]; events?: RelayEvent[] }

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function tokenHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function extensionIdFromOrigin(origin: string): string {
  const match = origin.match(/^chrome-extension:\/\/([a-p]{32})$/i);
  return match?.[1]?.toLowerCase() || "";
}

export class ExtensionRelayServer {
  private readonly productRoot: string;
  readonly port: number;
  private server: Server | null = null;
  private readonly commandQueue: RelayCommand[] = [];
  private readonly responseListeners = new Set<(responses: RelayResponse[], events: RelayEvent[]) => void>();
  private waitingResponse: ServerResponse | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private pairingUntil = 0;
  private lastSeenAt = 0;
  private auth: AuthRecord | null = null;

  constructor(productRoot: string, port = 32192) {
    this.productRoot = productRoot;
    this.port = port;
    this.auth = this.loadAuth();
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => { this.server!.removeListener("error", reject); resolve(); });
    });
  }

  async stop(): Promise<void> {
    this.flushWaiting([]);
    const server = this.server; this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beginPairing(ttlMs = 120_000): ExtensionRelayStatus {
    this.pairingUntil = Date.now() + Math.max(30_000, Math.min(ttlMs, 300_000));
    return this.status();
  }

  status(): ExtensionRelayStatus {
    return { paired: Boolean(this.auth), connected: this.connected(), pairingWindowOpen: Date.now() < this.pairingUntil, port: this.port };
  }

  connected(): boolean { return Boolean(this.auth) && Date.now() - this.lastSeenAt < 30_000; }

  async waitForConnection(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The ordinary Edge relay extension is not connected. Pair or enable it in Edge, then retry.");
  }

  enqueue(command: RelayCommand): void {
    this.commandQueue.push(command);
    if (this.commandQueue.length > 500) this.commandQueue.shift();
    if (this.waitingResponse) this.flushWaiting(this.takeCommands());
  }

  onEnvelope(listener: (responses: RelayResponse[], events: RelayEvent[]) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = String(request.headers.origin || "");
    const extensionId = extensionIdFromOrigin(origin);
    this.cors(response, origin, Boolean(extensionId));
    if (request.method === "OPTIONS") { response.writeHead(extensionId ? 204 : 403).end(); return; }
    if (request.method !== "POST" || !extensionId) { this.json(response, 403, { error: "Extension origin required." }); return; }
    try {
      const body = await this.readJson(request);
      if (request.url === "/pair") { this.handlePair(extensionId, response); return; }
      if (request.url === "/exchange") { this.handleExchange(extensionId, body as ExchangeBody, response); return; }
      this.json(response, 404, { error: "Unknown relay endpoint." });
    } catch {
      this.json(response, 400, { error: "Invalid relay request." });
    }
  }

  private handlePair(extensionId: string, response: ServerResponse): void {
    if (Date.now() >= this.pairingUntil) { this.json(response, 403, { error: "Open pairing from the Codex Browser control center first." }); return; }
    const token = randomBytes(32).toString("base64url");
    this.auth = { extensionId, tokenHash: tokenHash(token) };
    this.saveAuth(this.auth);
    this.pairingUntil = 0;
    this.json(response, 200, { token });
  }

  private handleExchange(extensionId: string, body: ExchangeBody, response: ServerResponse): void {
    if (!this.authorized(extensionId, body.token || "")) { this.json(response, 401, { error: "Relay pairing is invalid." }); return; }
    this.lastSeenAt = Date.now();
    const responses = Array.isArray(body.responses) ? body.responses.slice(0, 200) : [];
    const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    if (responses.length || events.length) for (const listener of this.responseListeners) listener(responses, events);
    const commands = this.takeCommands();
    if (commands.length) { this.json(response, 200, { commands }); return; }
    this.flushWaiting([]);
    this.waitingResponse = response;
    this.waitingTimer = setTimeout(() => this.flushWaiting([]), 15_000);
  }

  private authorized(extensionId: string, token: string): boolean {
    if (!this.auth || this.auth.extensionId !== extensionId || !token) return false;
    const actual = Buffer.from(tokenHash(token), "hex");
    const expected = Buffer.from(this.auth.tokenHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private takeCommands(): RelayCommand[] { return this.commandQueue.splice(0, 100); }
  private flushWaiting(commands: RelayCommand[]): void {
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    this.waitingTimer = null;
    const response = this.waitingResponse; this.waitingResponse = null;
    if (response && !response.writableEnded) this.json(response, 200, { commands });
  }

  private cors(response: ServerResponse, origin: string, allowed: boolean): void {
    if (allowed) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  private readJson(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) { request.destroy(); reject(new Error("too large")); } else chunks.push(chunk); });
      request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { reject(error); } });
      request.on("error", reject);
    });
  }

  private authPath(): string { return path.join(this.productRoot, "edge-relay-auth.json"); }
  private loadAuth(): AuthRecord | null {
    try {
      if (!existsSync(this.authPath())) return null;
      const value = JSON.parse(readFileSync(this.authPath(), "utf8")) as AuthRecord;
      return /^[a-p]{32}$/.test(value.extensionId) && /^[a-f0-9]{64}$/.test(value.tokenHash) ? value : null;
    } catch { return null; }
  }
  private saveAuth(auth: AuthRecord): void {
    mkdirSync(this.productRoot, { recursive: true });
    const file = this.authPath(); const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, "utf8"); renameSync(temporary, file);
  }
}
