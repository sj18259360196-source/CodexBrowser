import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserConnection, BrowserRuntime, BrowserRuntimeState, BrowserRuntimeStatus } from "./browser-runtime";
import { assertSupportedEdge, discoverEdge, type EdgeInstallation } from "./edge-discovery";
import { acquireEdgeProfile, type EdgeProfileLease } from "./edge-profile";
import { LoopbackWebSocketCdpTransport, type CdpEndpoint, type CdpTransport } from "./cdp-transport";
import { EdgeBrowserAdapter } from "./edge-browser-adapter";

export interface EdgePrototypeRuntimeOptions {
  runtimeRoot: string;
  profileDir: string;
  profileRoot?: string;
  transport?: CdpTransport;
  environment?: NodeJS.ProcessEnv;
  downloadsDir?: string;
}

export class EdgePrototypeRuntime implements BrowserRuntime<EdgeBrowserAdapter> {
  private state: BrowserRuntimeState = "stopped";
  private detail = "";
  private installation: EdgeInstallation | null = null;
  private process: ChildProcess | null = null;
  private ownedPid: number | null = null;
  private endpoint: CdpEndpoint | null = null;
  private profileLease: EdgeProfileLease | null = null;
  private readonly transport: CdpTransport;
  private readonly adapter: EdgeBrowserAdapter;

  constructor(private readonly options: EdgePrototypeRuntimeOptions) {
    this.transport = options.transport || new LoopbackWebSocketCdpTransport();
    this.adapter = new EdgeBrowserAdapter(this.transport, options.downloadsDir || path.join(options.profileDir, "managed-downloads"));
  }

  async start(): Promise<BrowserConnection<EdgeBrowserAdapter>> {
    if (this.ownedPid) throw new Error("The managed external Edge runtime is already running.");
    this.state = "starting";
    this.detail = "Discovering Microsoft Edge";
    try {
      this.installation = discoverEdge(this.options.environment);
      assertSupportedEdge(this.installation);
      this.profileLease = acquireEdgeProfile(
        this.options.profileDir,
        this.options.profileRoot || path.join(path.resolve(this.options.runtimeRoot), "edge-profiles"),
        this.installation.version,
      );
      const discoveryFile = path.join(this.options.profileDir, "DevToolsActivePort");
      if (this.profileLease.recovered && this.profileLease.browserPid) {
        this.ownedPid = this.profileLease.browserPid;
        this.state = "connecting";
        this.detail = "Reconnecting to the existing managed Edge";
        this.endpoint = await this.waitForEndpoint(discoveryFile, undefined, this.ownedPid);
        await this.transport.connect(this.endpoint);
        await this.adapter.onConnected();
        this.state = "ready";
        this.detail = "Managed Edge is ready";
        return this.connection();
      }
      if (existsSync(discoveryFile)) unlinkSync(discoveryFile);
      const child = spawn(this.installation.executablePath, [
        `--user-data-dir=${this.options.profileDir}`,
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "about:blank",
      ], { stdio: "ignore", windowsHide: false, detached: process.platform === "win32" });
      if (!child.pid) throw new Error("Microsoft Edge did not return a managed process ID.");
      this.process = child;
      this.ownedPid = child.pid;
      this.profileLease.setBrowserPid(child.pid);
      if (process.platform === "win32") child.unref();
      child.once("exit", () => {
        this.process = null;
        this.ownedPid = null;
        this.endpoint = null;
        if (this.state !== "error") this.state = "stopped";
        void this.transport.disconnect().catch(() => undefined);
        this.profileLease?.release();
        this.profileLease = null;
      });
      child.once("error", (error) => {
        this.state = "error";
        this.detail = error.message;
      });
      this.state = "connecting";
      this.detail = "Waiting for the managed Edge debugging endpoint";
      this.endpoint = await this.waitForEndpoint(discoveryFile, child, child.pid);
      await this.transport.connect(this.endpoint);
      await this.adapter.onConnected();
      this.state = "ready";
      this.detail = "Managed Edge is ready";
      return this.connection();
    } catch (error) {
      this.state = "error";
      this.detail = error instanceof Error ? error.message : "Managed Edge failed to start.";
      if (!this.ownedPid) {
        this.profileLease?.release();
        this.profileLease = null;
      }
      throw error;
    }
  }

  async attach(): Promise<BrowserConnection<EdgeBrowserAdapter>> {
    if (!this.ownedPid || !this.endpoint || !this.isProcessAlive(this.ownedPid)) {
      throw new Error("There is no Edge process confirmed as managed by this runtime.");
    }
    if (this.transport.isConnected()) return this.connection();
    this.state = "connecting";
    this.detail = "Reconnecting to managed Edge";
    try {
      await this.transport.connect(this.endpoint);
      await this.adapter.onConnected();
      this.state = "ready";
      this.detail = "Managed Edge is ready";
      return this.connection();
    } catch (error) {
      this.state = "error";
      this.detail = error instanceof Error ? error.message : "Managed Edge reconnect failed.";
      throw error;
    }
  }

  async status(): Promise<BrowserRuntimeStatus> {
    if (this.ownedPid && !this.isProcessAlive(this.ownedPid)) {
      this.process = null;
      this.ownedPid = null;
      this.endpoint = null;
      this.profileLease?.release();
      this.profileLease = null;
      this.state = "stopped";
      this.detail = "Managed Edge exited";
    }
    let state = this.state;
    if (state === "ready") {
      if (!this.transport.isConnected()) {
        state = "connecting";
      } else {
        try {
          await this.transport.send("Browser.getVersion");
        } catch {
          state = "connecting";
        }
      }
    }
    return {
      state,
      browserName: this.installation ? "Microsoft Edge" : undefined,
      browserVersion: this.installation?.version,
      managed: Boolean(this.ownedPid),
      detail: state === "connecting" ? "Reconnecting to managed Edge" : this.detail || undefined,
    };
  }

  async show(): Promise<void> {
    if (this.state !== "ready") throw new Error("Managed Edge is not ready to show.");
    await this.adapter.show();
  }

  async shutdown(options: { graceful: boolean }): Promise<void> {
    const child = this.process;
    const ownedPid = this.ownedPid;
    const endpoint = this.endpoint;
    if (!ownedPid) {
      await this.transport.disconnect();
      this.profileLease?.release();
      this.profileLease = null;
      this.state = "stopped";
      return;
    }
    if (!options.graceful) throw new Error("Codex Browser only permits graceful shutdown of its confirmed managed Edge process.");
    const exited = child ? this.waitForProcessExit(child, 30_000) : this.waitForPidExit(ownedPid, 30_000);
    try {
      await this.transport.send("Browser.close");
    } catch (error) {
      if (this.isProcessAlive(ownedPid)) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (this.isProcessAlive(ownedPid)) throw error;
      }
    }
    await exited;
    if (this.isProcessAlive(ownedPid)) throw new Error("Managed Edge did not exit cleanly.");
    this.process = null;
    this.ownedPid = null;
    this.endpoint = null;
    await this.transport.disconnect();
    await this.confirmEndpointGone(endpoint);
    this.profileLease?.release();
    this.profileLease = null;
    this.state = "stopped";
    this.detail = "Managed Edge stopped";
  }

  private connection(): BrowserConnection<EdgeBrowserAdapter> {
    return { adapter: this.adapter, disconnect: () => this.transport.disconnect() };
  }

  private async waitForEndpoint(discoveryFile: string, child?: ChildProcess, ownedPid?: number): Promise<CdpEndpoint> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child?.exitCode !== null && child) throw new Error("Microsoft Edge exited before CDP became ready.");
      if (ownedPid && !this.isProcessAlive(ownedPid)) throw new Error("Microsoft Edge exited before CDP became ready.");
      if (existsSync(discoveryFile)) {
        const [portLine, browserPath] = readFileSync(discoveryFile, "utf8").trim().split(/\r?\n/);
        const port = Number.parseInt(portLine || "", 10);
        if (Number.isInteger(port) && port > 0 && port <= 65_535 && browserPath?.startsWith("/devtools/browser/")) {
          return { host: "127.0.0.1", port, browserPath };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the managed Edge debugging endpoint.");
  }

  private waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Managed Edge did not exit after a graceful close request.")), timeoutMs);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Managed Edge did not exit after a graceful close request.");
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private async confirmEndpointGone(endpoint: CdpEndpoint | null): Promise<void> {
    if (!endpoint) return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://${endpoint.host}:${endpoint.port}/json/version`, { signal: AbortSignal.timeout(500) });
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The managed Edge debugging endpoint remained available after browser exit.");
  }
}
