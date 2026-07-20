import type { BrowserConnection, BrowserRuntime, BrowserRuntimeState, BrowserRuntimeStatus } from "./browser-runtime";
import { EdgeBrowserAdapter } from "./edge-browser-adapter";
import { ExtensionRelayCdpTransport } from "./extension-relay-transport";
import type { ExtensionRelayServer } from "./extension-relay-server";

export class ExtensionRelayRuntime implements BrowserRuntime<EdgeBrowserAdapter> {
  private readonly relay: ExtensionRelayServer;
  private state: BrowserRuntimeState = "stopped";
  private detail = "Ordinary Edge relay is stopped";
  private readonly transport: ExtensionRelayCdpTransport;
  private readonly adapter: EdgeBrowserAdapter;

  constructor(relay: ExtensionRelayServer, downloadsDir: string) {
    this.relay = relay;
    this.transport = new ExtensionRelayCdpTransport(relay);
    this.adapter = new EdgeBrowserAdapter(this.transport, downloadsDir);
  }

  async start(): Promise<BrowserConnection<EdgeBrowserAdapter>> {
    this.state = "connecting"; this.detail = "Waiting for the ordinary Edge relay extension";
    try {
      await this.transport.connectRelay();
      await this.adapter.onConnected();
      this.state = "ready"; this.detail = "Ordinary Edge relay is connected";
      return this.connection();
    } catch (error) {
      this.state = "error"; this.detail = error instanceof Error ? error.message : "Ordinary Edge relay failed to connect"; throw error;
    }
  }
  async attach(): Promise<BrowserConnection<EdgeBrowserAdapter>> { return this.start(); }
  async status(): Promise<BrowserRuntimeStatus> {
    if (this.state === "ready" && !this.transport.isConnected()) { this.state = "connecting"; this.detail = "Ordinary Edge relay disconnected"; }
    if (this.state === "connecting" && this.transport.isConnected()) { this.state = "ready"; this.detail = "Ordinary Edge relay is connected"; }
    return { state: this.state, browserName: "Microsoft Edge", managed: false, detail: this.detail };
  }
  async show(): Promise<void> { await this.adapter.show(); }
  async shutdown(): Promise<void> { await this.transport.disconnect(); this.state = "stopped"; this.detail = "Ordinary Edge relay is stopped"; }
  private connection(): BrowserConnection<EdgeBrowserAdapter> { return { adapter: this.adapter, disconnect: () => this.transport.disconnect() }; }
}
