export type BrowserRuntimeState = "stopped" | "starting" | "connecting" | "ready" | "error";

export interface BrowserRuntimeStatus {
  state: BrowserRuntimeState;
  browserName?: string;
  browserVersion?: string;
  managed: boolean;
  detail?: string;
}

export interface BrowserConnection<TAdapter> {
  adapter: TAdapter;
  disconnect(): Promise<void>;
}

export interface BrowserRuntime<TAdapter> {
  start(): Promise<BrowserConnection<TAdapter>>;
  attach(): Promise<BrowserConnection<TAdapter>>;
  status(): Promise<BrowserRuntimeStatus>;
  show(): Promise<void>;
  shutdown(options: { graceful: boolean }): Promise<void>;
}
