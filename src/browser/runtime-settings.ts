import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserRuntimeSettings } from "../shared/contracts";

const SETTINGS_FILE = "runtime-settings.json";

export const DEFAULT_RUNTIME_SETTINGS: BrowserRuntimeSettings = {
  preferredRuntime: "external-edge",
  keepEdgeRunningOnControlCenterClose: true,
  sessionRecoveryEnabled: false,
  notificationsEnabled: true,
  downloadBehavior: "managed",
  documentBehavior: "import-on-request",
};

export function resolveCodexBrowserProductRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA?.trim()
    ? path.resolve(environment.LOCALAPPDATA)
    : path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "CodexBrowser");
}

function validated(value: unknown): BrowserRuntimeSettings {
  const input = value && typeof value === "object" ? value as Partial<BrowserRuntimeSettings> : {};
  return {
    preferredRuntime: input.preferredRuntime === "electron-legacy" || input.preferredRuntime === "edge-extension" ? input.preferredRuntime : "external-edge",
    keepEdgeRunningOnControlCenterClose: input.keepEdgeRunningOnControlCenterClose !== false,
    sessionRecoveryEnabled: input.sessionRecoveryEnabled === true,
    notificationsEnabled: input.notificationsEnabled !== false,
    downloadBehavior: "managed",
    documentBehavior: "import-on-request",
  };
}

export function loadRuntimeSettings(productRoot = resolveCodexBrowserProductRoot()): BrowserRuntimeSettings {
  const file = path.join(productRoot, SETTINGS_FILE);
  if (!existsSync(file)) return { ...DEFAULT_RUNTIME_SETTINGS };
  try { return validated(JSON.parse(readFileSync(file, "utf8"))); } catch { return { ...DEFAULT_RUNTIME_SETTINGS }; }
}

export function saveRuntimeSettings(settings: BrowserRuntimeSettings, productRoot = resolveCodexBrowserProductRoot()): BrowserRuntimeSettings {
  const safe = validated(settings);
  mkdirSync(productRoot, { recursive: true });
  const file = path.join(productRoot, SETTINGS_FILE);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
  return safe;
}

export function updateRuntimeSettings(current: BrowserRuntimeSettings, patch: Partial<BrowserRuntimeSettings>, productRoot?: string): BrowserRuntimeSettings {
  return saveRuntimeSettings({ ...current, ...patch }, productRoot);
}
