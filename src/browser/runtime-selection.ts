export type ConfiguredBrowserRuntime = "external-edge" | "electron-legacy";

export interface BrowserRuntimeSelection {
  runtime: ConfiguredBrowserRuntime;
  migrationNotice?: string;
}

export function resolveBrowserRuntime(environment: NodeJS.ProcessEnv = process.env): BrowserRuntimeSelection {
  const configured = environment.CODEX_BROWSER_RUNTIME?.trim().toLowerCase();
  if (!configured || configured === "external-edge") return { runtime: "external-edge" };
  if (configured === "electron-legacy") return { runtime: "electron-legacy" };
  if (configured === "edge-prototype") {
    return { runtime: "external-edge", migrationNotice: "CODEX_BROWSER_RUNTIME=edge-prototype is deprecated; use external-edge." };
  }
  if (configured === "electron") {
    return { runtime: "electron-legacy", migrationNotice: "CODEX_BROWSER_RUNTIME=electron is deprecated; use electron-legacy." };
  }
  throw new Error("CODEX_BROWSER_RUNTIME must be external-edge or electron-legacy.");
}

export function getConfiguredBrowserRuntime(environment: NodeJS.ProcessEnv = process.env): ConfiguredBrowserRuntime {
  return resolveBrowserRuntime(environment).runtime;
}
