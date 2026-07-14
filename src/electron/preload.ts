import { contextBridge, ipcRenderer } from "electron";
import type {
  AppState,
  BrowserTabSummary,
  CredentialVaultStatus,
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
  saveAndSubmitLogin: (promptId) => ipcRenderer.invoke("credential:save-and-submit", promptId) as Promise<CredentialVaultStatus>,
  clearSavedLogins: () => ipcRenderer.invoke("credential:clear-all") as Promise<CredentialVaultStatus>,
  respondAssistance: (assistanceId, outcome, note) => ipcRenderer.invoke(
    "assistance:respond",
    assistanceId,
    outcome,
    note,
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
};

contextBridge.exposeInMainWorld("codexBrowser", bridge);
