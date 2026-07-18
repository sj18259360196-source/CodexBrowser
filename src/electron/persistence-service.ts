import { safeStorage, type Cookie, type CookiesSetDetails, type Session } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DownloadItem, HumanAssistance, TaskItem } from "../shared/contracts";
import {
  parsePersistedBrowserTabs,
  parsePersistedBlockedTabs,
  parsePersistedDownloads,
  parsePersistedTasks,
  parseRuntimeBlockedTabs,
  isGeneratedPersistedDownloadName,
  type PersistedBlockedTab,
} from "./persistence-validation";
import { normalizeSessionRecoveryConfig, validateSessionRecoveryEnvelope } from "./session-recovery-policy";
import { RUNTIME_METADATA_VERSION } from "../shared/release-info.js";

const STATE_VERSION = RUNTIME_METADATA_VERSION;

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
  blockedTabs: PersistedBlockedTab[];
  // Kept to read version 2 state. New writes store tab-scoped blockedTabs instead.
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
}

export interface SessionRecoveryConfig {
  enabled: boolean;
  ttlMs: number;
  profileBinding: string;
}

interface StoredSessionRecovery {
  version: 1;
  profileBinding: string;
  savedAt: string;
  expiresAt: string;
  cookies: StoredSessionCookie[];
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
  private readonly recoveryConfigPath: string;

  constructor(private readonly dataDir: string, private readonly profileBinding = "electron-primary-v1") {
    this.statePath = path.join(dataDir, "runtime-state.json");
    this.cookieBackupPath = path.join(dataDir, "session-cookies.enc");
    this.recoveryConfigPath = path.join(dataDir, "session-recovery.json");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  async loadRuntimeState(defaultUrl: string): Promise<PersistedRuntimeState> {
    await this.initialize();
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Omit<PersistedRuntimeState, "version">> & { version?: unknown };
      const savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString();
      const tabs = parsePersistedBrowserTabs(parsed.tabs);
      const validTabIds = new Set(tabs.map((tab) => tab.id));
      const blockedTabs = parseRuntimeBlockedTabs(parsed, validTabIds);
      return {
        version: STATE_VERSION,
        savedAt,
        lastSafeUrl: typeof parsed.lastSafeUrl === "string" ? parsed.lastSafeUrl : defaultUrl,
        tabs,
        activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined,
        blockedTabs,
        assistance: null,
        tasks: parsePersistedTasks(parsed.tasks),
        downloads: parsePersistedDownloads(parsed.downloads, savedAt),
        ignoredDownloadFiles: Array.isArray(parsed.ignoredDownloadFiles)
          ? parsed.ignoredDownloadFiles.filter(isGeneratedPersistedDownloadName)
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
        blockedTabs: [],
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
    const validTabIds = new Set(state.tabs.map((tab) => tab.id));
    const blockedTabs = parsePersistedBlockedTabs(state.blockedTabs, validTabIds);
    const tasks = parsePersistedTasks(state.tasks);
    const downloads = parsePersistedDownloads(state.downloads, savedAt);
    const ignoredDownloadFiles = state.ignoredDownloadFiles.filter(isGeneratedPersistedDownloadName);
    await this.atomicWrite(this.statePath, Buffer.from(JSON.stringify({
      version: STATE_VERSION,
      savedAt,
      ...state,
      blockedTabs,
      assistance: null,
      tasks,
      downloads,
      ignoredDownloadFiles,
    }, null, 2), "utf8"));
    return savedAt;
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async getSessionRecoveryConfig(): Promise<SessionRecoveryConfig> {
    try {
      return normalizeSessionRecoveryConfig(JSON.parse(await fs.readFile(this.recoveryConfigPath, "utf8")), this.profileBinding);
    } catch {
      return normalizeSessionRecoveryConfig(null, this.profileBinding);
    }
  }

  async setSessionRecoveryEnabled(enabled: boolean): Promise<SessionRecoveryConfig> {
    const current = await this.getSessionRecoveryConfig();
    const next = { ...current, enabled, profileBinding: this.profileBinding };
    await this.atomicWrite(this.recoveryConfigPath, Buffer.from(JSON.stringify(next, null, 2), "utf8"));
    if (!enabled) await this.clearSessionRecovery();
    return next;
  }

  async clearSessionRecovery(): Promise<void> {
    await fs.unlink(this.cookieBackupPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async persistSessionCookies(targetSession: Session): Promise<number> {
    const config = await this.getSessionRecoveryConfig();
    if (!config.enabled || !this.isEncryptionAvailable()) {
      await this.clearSessionRecovery();
      return 0;
    }
    const cookies = await targetSession.cookies.get({});
    const sessionCookies = cookies
      .filter((cookie) => cookie.session)
      .map(toStoredCookie)
      .filter((cookie): cookie is StoredSessionCookie => cookie !== null);
    const savedAt = new Date();
    const payload: StoredSessionRecovery = {
      version: 1, profileBinding: config.profileBinding, savedAt: savedAt.toISOString(),
      expiresAt: new Date(savedAt.getTime() + config.ttlMs).toISOString(), cookies: sessionCookies,
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(payload));
    await this.atomicWrite(this.cookieBackupPath, encrypted);
    await targetSession.cookies.flushStore();
    return sessionCookies.length;
  }

  async restoreSessionCookies(targetSession: Session): Promise<SessionCookieRestoreResult> {
    if (!this.isEncryptionAvailable()) {
      return { encryptionAvailable: false, backupFound: false, restored: 0, failed: 0 };
    }
    const config = await this.getSessionRecoveryConfig();
    if (!config.enabled) {
      await this.clearSessionRecovery();
      return { encryptionAvailable: true, backupFound: false, restored: 0, failed: 0 };
    }
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(this.cookieBackupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { encryptionAvailable: true, backupFound: false, restored: 0, failed: 0 };
      }
      throw error;
    }

    let parsed: StoredSessionCookie[];
    try {
      const decrypted = safeStorage.decryptString(encrypted);
      const candidate = validateSessionRecoveryEnvelope(JSON.parse(decrypted), config.profileBinding, (item): item is StoredSessionCookie => {
        if (!item || typeof item !== "object") return false;
        const cookie = item as Partial<StoredSessionCookie>;
        return typeof cookie.url === "string"
          && typeof cookie.name === "string"
          && typeof cookie.value === "string";
      });
      if (candidate.status !== "valid") {
        await this.clearSessionRecovery();
        return { encryptionAvailable: true, backupFound: false, restored: 0, failed: 0 };
      }
      parsed = candidate.cookies;
    } catch {
      const backupPath = `${this.cookieBackupPath}.invalid-${Date.now()}`;
      await fs.rename(this.cookieBackupPath, backupPath).catch(() => undefined);
      return { encryptionAvailable: true, backupFound: false, restored: 0, failed: 0 };
    }

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
    return { encryptionAvailable: true, backupFound: true, restored, failed, restoredAt };
  }

  private async atomicWrite(targetPath: string, contents: Buffer): Promise<void> {
    const temporaryPath = `${targetPath}.tmp`;
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, targetPath);
  }
}
