import { contextBridge, ipcRenderer } from "electron";
import type {
  AppState,
  BrowserTabSummary,
  DesktopBridge,
  DocumentSummary,
  HumanAssistance,
  SessionHealth,
} from "../shared/contracts";

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke("browser:get-state") as Promise<AppState>,
  subscribeState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },
  setBrowserBounds: (bounds) => ipcRenderer.send("browser:set-bounds", bounds),
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url) as Promise<void>,
  back: () => ipcRenderer.invoke("browser:back") as Promise<void>,
  forward: () => ipcRenderer.invoke("browser:forward") as Promise<void>,
  reload: () => ipcRenderer.invoke("browser:reload") as Promise<void>,
  home: () => ipcRenderer.invoke("browser:home") as Promise<void>,
  createTab: (url) => ipcRenderer.invoke("tabs:create", url) as Promise<BrowserTabSummary>,
  selectTab: (tabId) => ipcRenderer.invoke("tabs:select", tabId) as Promise<void>,
  closeTab: (tabId) => ipcRenderer.invoke("tabs:close", tabId) as Promise<void>,
  pause: () => ipcRenderer.invoke("browser:pause") as Promise<void>,
  resume: () => ipcRenderer.invoke("browser:resume") as Promise<void>,
  stop: () => ipcRenderer.invoke("browser:stop") as Promise<void>,
  checkSession: () => ipcRenderer.invoke("session:check") as Promise<SessionHealth>,
  completeAuth: (promptId) => ipcRenderer.invoke("auth:complete", promptId) as Promise<SessionHealth>,
  respondAssistance: (assistanceId, outcome) => ipcRenderer.invoke(
    "assistance:respond",
    assistanceId,
    outcome,
  ) as Promise<HumanAssistance>,
  respondDialog: (dialogId, accept, promptText) => ipcRenderer.invoke(
    "dialog:respond",
    dialogId,
    accept,
    promptText,
  ) as Promise<void>,
  clearTasks: () => ipcRenderer.invoke("tasks:clear") as Promise<void>,
  clearDownloads: () => ipcRenderer.invoke("downloads:clear") as Promise<void>,
  importPdf: () => ipcRenderer.invoke("document:import") as Promise<DocumentSummary | null>,
  openDownloads: () => ipcRenderer.invoke("downloads:open") as Promise<void>,
  openDownload: (downloadId) => ipcRenderer.invoke("downloads:open-item", downloadId) as Promise<void>,
  openDocument: (documentId) => ipcRenderer.invoke("document:open", documentId) as Promise<void>,
  refreshStorageSummary: () => ipcRenderer.invoke("storage:summary"),
  requestDataAction: (action, includePermissions) => ipcRenderer.invoke("storage:request-action", action, includePermissions),
  confirmDataAction: (confirmationId) => ipcRenderer.invoke("storage:confirm-action", confirmationId),
  setSessionRecovery: (enabled) => ipcRenderer.invoke("storage:session-recovery", enabled),
  respondActionConfirmation: (confirmationId, response) => ipcRenderer.invoke("policy:respond-confirmation", confirmationId, response),
  revokeBrowserGrant: (grantId) => ipcRenderer.invoke("policy:revoke-grant", grantId),
  clearPolicyAudit: () => ipcRenderer.invoke("policy:clear-audit"),
  showBrowser: () => ipcRenderer.invoke("runtime:show-browser"),
  restartBrowser: () => ipcRenderer.invoke("runtime:restart-browser"),
  shutdownBrowser: () => ipcRenderer.invoke("runtime:shutdown-browser"),
  updateRuntimeSettings: (settings) => ipcRenderer.invoke("runtime:update-settings", settings),
  beginEdgeRelayPairing: () => ipcRenderer.invoke("runtime:relay-begin-pairing"),
  openEdgeRelayExtensionFolder: () => ipcRenderer.invoke("runtime:relay-open-extension-folder"),
};

contextBridge.exposeInMainWorld("codexBrowser", bridge);
