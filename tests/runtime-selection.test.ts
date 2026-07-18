import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConfiguredBrowserRuntime, resolveBrowserRuntime } from "../src/browser/runtime-selection.ts";
import { DEFAULT_RUNTIME_SETTINGS, loadRuntimeSettings, saveRuntimeSettings } from "../src/browser/runtime-settings.ts";

test("external Edge is the safe default and legacy values have explicit aliases", () => {
  assert.equal(getConfiguredBrowserRuntime({}), "external-edge");
  assert.equal(resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "external-edge" }).runtime, "external-edge");
  assert.equal(resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "electron-legacy" }).runtime, "electron-legacy");
  assert.match(resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "edge-prototype" }).migrationNotice || "", /deprecated/i);
  assert.match(resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "electron" }).migrationNotice || "", /deprecated/i);
  assert.throws(() => resolveBrowserRuntime({ CODEX_BROWSER_RUNTIME: "unsafe-runtime" }), /external-edge or electron-legacy/);
});

test("runtime settings persist safe values and reject unsafe or malformed settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-browser-runtime-settings-"));
  try {
    assert.deepEqual(loadRuntimeSettings(root), DEFAULT_RUNTIME_SETTINGS);
    const saved = saveRuntimeSettings({ ...DEFAULT_RUNTIME_SETTINGS, preferredRuntime: "electron-legacy", notificationsEnabled: false }, root);
    assert.equal(saved.preferredRuntime, "electron-legacy");
    assert.equal(loadRuntimeSettings(root).notificationsEnabled, false);
    const file = path.join(root, "runtime-settings.json");
    assert.doesNotMatch(readFileSync(file, "utf8"), /password|cookie|cdp|profilePath/i);
    writeFileSync(file, "{broken", "utf8");
    assert.deepEqual(loadRuntimeSettings(root), DEFAULT_RUNTIME_SETTINGS);
    writeFileSync(file, JSON.stringify({ preferredRuntime: "allow-all", notificationsEnabled: "yes", keepEdgeRunningOnControlCenterClose: "no" }), "utf8");
    assert.deepEqual(loadRuntimeSettings(root), DEFAULT_RUNTIME_SETTINGS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
