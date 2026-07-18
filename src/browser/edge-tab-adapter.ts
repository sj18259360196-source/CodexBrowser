import type { CdpTransport } from "./cdp-transport";

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface EdgePrototypeTab {
  id: string;
  title: string;
  url: string;
}

export class EdgePrototypeTabAdapter {
  private readonly publicIds = new Map<string, string>();
  private readonly targetIds = new Map<string, string>();
  private nextTabId = 1;

  constructor(private readonly transport: CdpTransport) {}

  async discoverTabs(): Promise<EdgePrototypeTab[]> {
    const result = await this.transport.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return result.targetInfos
      .filter((target) => target.type === "page")
      .map((target) => this.expose(target));
  }

  async createTestTab(): Promise<EdgePrototypeTab> {
    const result = await this.transport.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const info = await this.getTargetInfo(result.targetId);
    return this.expose(info);
  }

  async navigate(tabId: string, url: string): Promise<EdgePrototypeTab> {
    const targetId = this.resolveTargetId(tabId);
    const attached = await this.transport.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    try {
      await this.transport.send("Page.enable", {}, attached.sessionId);
      const loaded = this.transport.waitForEvent("Page.loadEventFired", { sessionId: attached.sessionId, timeoutMs: 15_000 });
      const navigation = await this.transport.send<{ errorText?: string }>("Page.navigate", { url }, attached.sessionId);
      if (navigation.errorText) throw new Error("Managed Edge could not navigate to the local test page.");
      await loaded;
    } finally {
      await this.transport.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined);
    }
    return this.waitForMetadata(targetId, 10_000);
  }

  async readTab(tabId: string): Promise<EdgePrototypeTab> {
    return this.expose(await this.getTargetInfo(this.resolveTargetId(tabId)));
  }

  async closeTab(tabId: string): Promise<void> {
    const targetId = this.resolveTargetId(tabId);
    const result = await this.transport.send<{ success: boolean }>("Target.closeTarget", { targetId });
    if (!result.success) throw new Error("Managed Edge did not close the test tab.");
    this.targetIds.delete(tabId);
  }

  async show(): Promise<void> {
    const target = (await this.discoverTargets()).find((candidate) => candidate.type === "page");
    if (!target) throw new Error("Managed Edge has no visible page target.");
    const window = await this.transport.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: target.targetId });
    await this.transport.send("Browser.setWindowBounds", { windowId: window.windowId, bounds: { windowState: "normal" } });
  }

  private async discoverTargets(): Promise<TargetInfo[]> {
    return (await this.transport.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos;
  }

  private async getTargetInfo(targetId: string): Promise<TargetInfo> {
    return (await this.transport.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId })).targetInfo;
  }

  private async waitForMetadata(targetId: string, timeoutMs: number): Promise<EdgePrototypeTab> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.getTargetInfo(targetId);
    while (Date.now() < deadline) {
      last = await this.getTargetInfo(targetId);
      if (last.title && last.url && last.url !== "about:blank") return this.expose(last);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.expose(last);
  }

  private expose(target: TargetInfo): EdgePrototypeTab {
    let id = this.publicIds.get(target.targetId);
    if (!id) {
      id = `edge-tab-${this.nextTabId++}`;
      this.publicIds.set(target.targetId, id);
      this.targetIds.set(id, target.targetId);
    }
    return { id, title: target.title || "Edge page", url: target.url };
  }

  private resolveTargetId(tabId: string): string {
    const targetId = this.targetIds.get(tabId);
    if (!targetId) throw new Error("The managed Edge tab ID is missing or stale.");
    return targetId;
  }
}
