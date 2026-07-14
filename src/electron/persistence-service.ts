import { safeStorage, type Cookie, type CookiesSetDetails, type Session } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CredentialVaultStatus, DownloadItem, HumanAssistance, TaskItem } from "../shared/contracts";

const STATE_VERSION = 2;
const CREDENTIAL_VAULT_VERSION = 1;

export interface PersistedBrowserTab {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

export interface PersistedRuntimeState {
  version: typeof STATE_VERSION;
  savedAt: string;
  lastSafeUrl: string;
  tabs: PersistedBrowserTab[];
  activeTabId?: string;
  assistance: HumanAssistance | null;
  tasks: TaskItem[];
  downloads: DownloadItem[];
  ignoredDownloadFiles: string[];
}

export interface SessionCookieRestoreResult {
  encryptionAvailable: boolean;
  backupFound: boolean;
  restored: number;
  failed: number;
  restoredAt?: string;
  backupSource?: "current" | "previous";
}

interface StoredSessionCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: Cookie["sameSite"];
}

function parseStoredSessionCookies(value: unknown): StoredSessionCookie[] {
  if (!Array.isArray(value)) throw new Error("Session cookie backup has an invalid format.");
  return value.filter((item): item is StoredSessionCookie => {
    if (!item || typeof item !== "object") return false;
    const cookie = item as Partial<StoredSessionCookie>;
    return typeof cookie.url === "string"
      && typeof cookie.name === "string"
      && typeof cookie.value === "string";
  });
}

export interface StoredLoginCredential {
  origin: string;
  username: string;
  password: string;
  updatedAt: string;
}

interface StoredCredentialVault {
  version: typeof CREDENTIAL_VAULT_VERSION;
  credentials: StoredLoginCredential[];
}

function credentialOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isStoredLoginCredential(value: unknown): value is StoredLoginCredential {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredLoginCredential>;
  return typeof candidate.origin === "string"
    && credentialOrigin(candidate.origin) === candidate.origin
    && typeof candidate.username === "string"
    && candidate.username.length > 0
    && typeof candidate.password === "string"
    && candidate.password.length > 0
    && typeof candidate.updatedAt === "string"
    && !Number.isNaN(Date.parse(candidate.updatedAt));
}

function isTaskItem(value: unknown): value is TaskItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TaskItem>;
  const validStatuses: TaskItem["status"][] = ["queued", "running", "waiting_user", "done", "error"];
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.status === "string"
    && validStatuses.includes(candidate.status as TaskItem["status"])
    && (candidate.detail === undefined || typeof candidate.detail === "string")
    && typeof candidate.createdAt === "string"
    && !Number.isNaN(Date.parse(candidate.createdAt))
    && typeof candidate.updatedAt === "string"
    && !Number.isNaN(Date.parse(candidate.updatedAt));
}

function isDownloadItem(value: unknown): value is DownloadItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DownloadItem>;
  const validStates: DownloadItem["state"][] = ["starting", "progressing", "completed", "cancelled", "interrupted"];
  return typeof candidate.id === "string"
    && typeof candidate.fileName === "string"
    && typeof candidate.url === "string"
    && typeof candidate.state === "string"
    && validStates.includes(candidate.state as DownloadItem["state"])
    && typeof candidate.receivedBytes === "number"
    && Number.isFinite(candidate.receivedBytes)
    && typeof candidate.totalBytes === "number"
    && Number.isFinite(candidate.totalBytes)
    && (candidate.path === undefined || typeof candidate.path === "string")
    && (candidate.createdAt === undefined || (typeof candidate.createdAt === "string" && !Number.isNaN(Date.parse(candidate.createdAt))))
    && (candidate.updatedAt === undefined || (typeof candidate.updatedAt === "string" && !Number.isNaN(Date.parse(candidate.updatedAt))));
}

function isPersistedBrowserTab(value: unknown): value is PersistedBrowserTab {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedBrowserTab>;
  return typeof candidate.id === "string"
    && typeof candidate.title === "string"
    && typeof candidate.url === "string"
    && typeof candidate.createdAt === "string"
    && !Number.isNaN(Date.parse(candidate.createdAt));
}

function isHumanAssistance(value: unknown): value is HumanAssistance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HumanAssistance>;
  const kinds: HumanAssistance["kind"][] = [
    "credential",
    "verification",
    "consent",
    "file_selection",
    "permission",
    "manual_action",
  ];
  const statuses: HumanAssistance["status"][] = ["waiting_user", "completed", "unable", "cancelled"];
  return typeof candidate.id === "string"
    && typeof candidate.tabId === "string"
    && typeof candidate.taskId === "string"
    && typeof candidate.kind === "string"
    && kinds.includes(candidate.kind as HumanAssistance["kind"])
    && typeof candidate.title === "string"
    && typeof candidate.detail === "string"
    && typeof candidate.url === "string"
    && typeof candidate.status === "string"
    && statuses.includes(candidate.status as HumanAssistance["status"])
    && (candidate.note === undefined || typeof candidate.note === "string")
    && typeof candidate.requestedAt === "string"
    && !Number.isNaN(Date.parse(candidate.requestedAt))
    && (candidate.resolvedAt === undefined
      || (typeof candidate.resolvedAt === "string" && !Number.isNaN(Date.parse(candidate.resolvedAt))));
}

function buildCookieUrl(cookie: Cookie): string | null {
  const host = cookie.domain?.replace(/^\./, "").trim();
  if (!host) return null;
  const protocol = cookie.secure ? "https:" : "http:";
  const cookiePath = cookie.path?.startsWith("/") ? cookie.path : "/";
  return `${protocol}//${host}${cookiePath}`;
}

function toStoredCookie(cookie: Cookie): StoredSessionCookie | null {
  const url = buildCookieUrl(cookie);
  if (!url) return null;
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
}

function toSetDetails(cookie: StoredSessionCookie): CookiesSetDetails {
  const details: CookiesSetDetails = {
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (cookie.domain) details.domain = cookie.domain;
  if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
  return details;
}

export class PersistenceService {
  private readonly statePath: string;
  private readonly cookieBackupPath: string;
  private readonly previousCookieBackupPath: string;
  private readonly credentialVaultPath: string;
  private readonly loginCredentials = new Map<string, StoredLoginCredential>();

  constructor(private readonly dataDir: string) {
    this.statePath = path.join(dataDir, "runtime-state.json");
    this.cookieBackupPath = path.join(dataDir, "session-cookies.enc");
    this.previousCookieBackupPath = path.join(dataDir, "session-cookies.previous.enc");
    this.credentialVaultPath = path.join(dataDir, "login-credentials.enc");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  async loadRuntimeState(defaultUrl: string): Promise<PersistedRuntimeState> {
    await this.initialize();
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedRuntimeState>;
      const savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString();
      return {
        version: STATE_VERSION,
        savedAt,
        lastSafeUrl: typeof parsed.lastSafeUrl === "string" ? parsed.lastSafeUrl : defaultUrl,
        tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter(isPersistedBrowserTab) : [],
        activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined,
        assistance: isHumanAssistance(parsed.assistance) ? parsed.assistance : null,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTaskItem) : [],
        downloads: Array.isArray(parsed.downloads)
          ? parsed.downloads.filter(isDownloadItem).map((download) => ({
              ...download,
              createdAt: download.createdAt || savedAt,
              updatedAt: download.updatedAt || savedAt,
            }))
          : [],
        ignoredDownloadFiles: Array.isArray(parsed.ignoredDownloadFiles)
          ? parsed.ignoredDownloadFiles.filter((value): value is string => typeof value === "string" && path.basename(value) === value)
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backupPath = `${this.statePath}.invalid-${Date.now()}`;
        await fs.rename(this.statePath, backupPath).catch(() => undefined);
      }
      return {
        version: STATE_VERSION,
        savedAt: new Date(0).toISOString(),
        lastSafeUrl: defaultUrl,
        tabs: [],
        activeTabId: undefined,
        assistance: null,
        tasks: [],
        downloads: [],
        ignoredDownloadFiles: [],
      };
    }
  }

  async saveRuntimeState(state: Omit<PersistedRuntimeState, "version" | "savedAt">): Promise<string> {
    await this.initialize();
    const savedAt = new Date().toISOString();
    await this.atomicWrite(this.statePath, Buffer.from(JSON.stringify({
      version: STATE_VERSION,
      savedAt,
      ...state,
    }, null, 2), "utf8"));
    return savedAt;
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async loadLoginCredentials(): Promise<number> {
    this.loginCredentials.clear();
    if (!this.isEncryptionAvailable()) return 0;
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(this.credentialVaultPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    try {
      const decrypted = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(decrypted) as Partial<StoredCredentialVault>;
      const credentials = parsed.version === CREDENTIAL_VAULT_VERSION && Array.isArray(parsed.credentials)
        ? parsed.credentials.filter(isStoredLoginCredential)
        : [];
      for (const credential of credentials) this.loginCredentials.set(credential.origin, credential);
      return this.loginCredentials.size;
    } catch {
      const backupPath = `${this.credentialVaultPath}.invalid-${Date.now()}`;
      await fs.rename(this.credentialVaultPath, backupPath).catch(() => undefined);
      return 0;
    }
  }

  credentialStatus(value: string): CredentialVaultStatus {
    const origin = credentialOrigin(value);
    return {
      encryptionAvailable: this.isEncryptionAvailable(),
      savedSiteCount: this.loginCredentials.size,
      activeSiteSaved: Boolean(origin && this.loginCredentials.has(origin)),
    };
  }

  getLoginCredential(value: string): StoredLoginCredential | null {
    const origin = credentialOrigin(value);
    const credential = origin ? this.loginCredentials.get(origin) : undefined;
    return credential ? { ...credential } : null;
  }

  async saveLoginCredential(value: string, username: string, password: string): Promise<CredentialVaultStatus> {
    if (!this.isEncryptionAvailable()) throw new Error("Windows encryption is unavailable.");
    const origin = credentialOrigin(value);
    if (!origin) throw new Error("Login credentials can only be saved for secure HTTPS pages.");
    if (!username.trim() || !password) throw new Error("Username and password are required.");
    this.loginCredentials.set(origin, {
      origin,
      username,
      password,
      updatedAt: new Date().toISOString(),
    });
    await this.persistLoginCredentials();
    return this.credentialStatus(value);
  }

  async clearLoginCredentials(value?: string): Promise<CredentialVaultStatus> {
    if (value) {
      const origin = credentialOrigin(value);
      if (origin) this.loginCredentials.delete(origin);
    } else {
      this.loginCredentials.clear();
    }
    if (this.loginCredentials.size === 0) {
      await fs.rm(this.credentialVaultPath, { force: true });
    } else {
      await this.persistLoginCredentials();
    }
    return this.credentialStatus(value || "");
  }

  async persistSessionCookies(targetSession: Session): Promise<number> {
    if (!this.isEncryptionAvailable()) return 0;
    const cookies = await targetSession.cookies.get({});
    const sessionCookies = cookies
      .filter((cookie) => cookie.session)
      .map(toStoredCookie)
      .filter((cookie): cookie is StoredSessionCookie => cookie !== null);
    const encrypted = safeStorage.encryptString(JSON.stringify(sessionCookies));
    await fs.copyFile(this.cookieBackupPath, this.previousCookieBackupPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await this.atomicWrite(this.cookieBackupPath, encrypted);
    await targetSession.cookies.flushStore();
    return sessionCookies.length;
  }

  async restoreSessionCookies(targetSession: Session): Promise<SessionCookieRestoreResult> {
    if (!this.isEncryptionAvailable()) {
      return { encryptionAvailable: false, backupFound: false, restored: 0, failed: 0 };
    }
    let backupFound = false;
    let backupSource: SessionCookieRestoreResult["backupSource"];
    let parsed: StoredSessionCookie[] | null = null;
    for (const candidate of [
      { path: this.cookieBackupPath, source: "current" as const },
      { path: this.previousCookieBackupPath, source: "previous" as const },
    ]) {
      let encrypted: Buffer;
      try {
        encrypted = await fs.readFile(candidate.path);
        backupFound = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const decrypted = safeStorage.decryptString(encrypted);
        parsed = parseStoredSessionCookies(JSON.parse(decrypted) as unknown);
        backupSource = candidate.source;
        break;
      } catch {
        const invalidPath = `${candidate.path}.invalid-${Date.now()}`;
        await fs.rename(candidate.path, invalidPath).catch(() => undefined);
      }
    }
    if (!parsed) return { encryptionAvailable: true, backupFound, restored: 0, failed: 0 };

    let restored = 0;
    let failed = 0;
    for (const cookie of parsed) {
      try {
        await targetSession.cookies.set(toSetDetails(cookie));
        restored += 1;
      } catch {
        failed += 1;
      }
    }
    const restoredAt = new Date().toISOString();
    await targetSession.cookies.flushStore();
    return { encryptionAvailable: true, backupFound: true, restored, failed, restoredAt, backupSource };
  }

  private async persistLoginCredentials(): Promise<void> {
    const payload: StoredCredentialVault = {
      version: CREDENTIAL_VAULT_VERSION,
      credentials: [...this.loginCredentials.values()],
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(payload));
    await this.atomicWrite(this.credentialVaultPath, encrypted);
  }

  private async atomicWrite(targetPath: string, contents: Buffer): Promise<void> {
    const temporaryPath = `${targetPath}.tmp`;
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, targetPath);
  }
}
