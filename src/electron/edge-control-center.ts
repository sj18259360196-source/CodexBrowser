import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { connect } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppState, PipeResponse } from "../shared/contracts";

const projectRoot = path.resolve(process.env.CODEX_BROWSER_PROJECT_ROOT || process.cwd());
const pipeName = String(process.env.CODEX_BROWSER_PIPE_NAME || "codex-browser-v1");
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
let window: BrowserWindow | null = null;
let lastAssistanceId = "";
let lastConfirmationId = "";

function callBroker(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    const id = randomUUID();
    let buffer = "";
    const timeoutMs = ["storage.confirm_action", "runtime.restart_browser"].includes(method) ? 90_000 : 20_000;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("The Edge control center timed out.")); }, timeoutMs);
    const finish = (callback: () => void) => { clearTimeout(timer); socket.destroy(); callback(); };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.once("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as PipeResponse;
        if (!response.ok) {
          const error = new Error(response.error?.message || "The Edge broker rejected the command.");
          error.name = response.error?.code || "BROWSER_ERROR";
          finish(() => reject(error));
        } else finish(() => resolve(response.result));
      } catch (error) { finish(() => reject(error)); }
    });
  });
}

function register(channel: string, method: string, map: (...args: unknown[]) => Record<string, unknown> = () => ({})): void {
  ipcMain.handle(channel, (_event, ...args) => callBroker(method, map(...args)));
}

function showForAssistance(state: AppState): void {
  const assistance = state.assistance;
  if (!assistance || assistance.id === lastAssistanceId || assistance.status !== "waiting_user") return;
  lastAssistanceId = assistance.id;
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
  if (state.runtimeSettings.notificationsEnabled && Notification.isSupported()) {
    new Notification({ title: "Codex Browser needs your action", body: `${assistance.domain || "Current site"}: ${assistance.title}` }).show();
  }
}

function showForConfirmation(state: AppState): void {
  const confirmation = state.actionConfirmations.find((item) => item.status === "waiting_user");
  if (!confirmation || confirmation.id === lastConfirmationId) return;
  lastConfirmationId = confirmation.id;
  if (window?.isMinimized()) window.restore(); window?.show(); window?.focus();
  if (state.runtimeSettings.notificationsEnabled && Notification.isSupported()) new Notification({ title: "Codex Browser confirmation required", body: `${confirmation.origin}: ${confirmation.summary}` }).show();
}

app.whenReady().then(async () => {
  register("browser:get-state", "browser.status");
  register("browser:navigate", "browser.navigate", (url) => ({ url }));
  register("browser:back", "browser.back");
  register("browser:forward", "browser.forward");
  register("browser:reload", "browser.reload");
  register("browser:home", "browser.navigate", () => ({ url: "about:blank" }));
  register("tabs:create", "browser.tab_new", (url) => ({ url, activate: true }));
  register("tabs:select", "browser.tab_select", (tabId) => ({ tabId }));
  register("tabs:close", "browser.tab_close", (tabId) => ({ tabId }));
  register("browser:pause", "browser.pause");
  register("browser:resume", "browser.resume");
  register("browser:stop", "browser.stop");
  register("session:check", "session.check");
  register("storage:summary", "storage.summary");
  register("storage:request-action", "storage.request_action", (action, includePermissions) => ({ action, includePermissions }));
  register("storage:confirm-action", "storage.confirm_action", (confirmationId) => ({ confirmationId }));
  register("storage:session-recovery", "storage.session_recovery", (enabled) => ({ enabled }));
  register("policy:respond-confirmation", "policy.respond_confirmation", (confirmationId, response) => ({ confirmationId, response }));
  register("policy:revoke-grant", "browser.grant_revoke", (grantId) => ({ grantId }));
  register("policy:clear-audit", "policy.clear_audit");
  register("runtime:show-browser", "runtime.show_browser");
  register("runtime:restart-browser", "runtime.restart_browser");
  register("runtime:shutdown-browser", "runtime.shutdown_browser");
  register("runtime:update-settings", "runtime.update_settings", (settings) => settings as Record<string, unknown>);
  register("auth:complete", "auth.complete", (promptId) => ({ promptId, userConfirmed: true }));
  register("assistance:respond", "browser.assistance_complete", (assistanceId, outcome) => ({ assistanceId, outcome, userConfirmed: true }));
  register("dialog:respond", "browser.dialog_respond", (dialogId, accept, promptText) => ({ dialogId, accept, promptText }));
  register("tasks:clear", "tasks.clear");
  register("downloads:clear", "downloads.clear");
  ipcMain.on("browser:set-bounds", () => undefined);
  for (const channel of ["document:import", "downloads:open", "downloads:open-item", "document:open"]) {
    ipcMain.handle(channel, () => null);
  }

  window = new BrowserWindow({
    width: 1040, height: 700, minWidth: 760, minHeight: 520, show: false,
    title: "Codex Browser Control Center",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadFile(path.join(projectRoot, "dist", "renderer", "index.html"));
  const publish = async () => {
    const state = await callBroker("browser.status").catch(() => null) as AppState | null;
    if (!state || window?.isDestroyed()) return;
    window?.webContents.send("browser:state", state);
    showForAssistance(state);
    showForConfirmation(state);
  };
  await publish();
  const timer = setInterval(() => void publish(), 500);
  window.on("closed", () => { clearInterval(timer); void callBroker("runtime.control_center_closed").catch(() => undefined); window = null; app.quit(); });
});

app.on("window-all-closed", () => app.quit());
