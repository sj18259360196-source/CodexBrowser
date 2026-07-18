import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PROFILE_SCHEMA_VERSION } from "../shared/release-info.js";

const OWNER_FILE = ".codex-browser-profile.json";
const LOCK_FILE = ".codex-browser-profile.lock";
const ACQUIRE_FILE = ".codex-browser-profile.acquire";

export interface EdgeProfileLease {
  profileDir: string;
  instanceId: string;
  browserPid?: number;
  recovered: boolean;
  setBrowserPid(pid: number): void;
  release(): void;
}

export interface EdgeProfileLocation {
  profileRoot: string;
  profileDir: string;
}

export function assertPathWithin(rootDir: string, candidate: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The Edge profile path must be a child of the managed profile directory.");
  }
}

export function resolvePrimaryEdgeProfile(environment: NodeJS.ProcessEnv = process.env): EdgeProfileLocation {
  const localAppData = environment.LOCALAPPDATA?.trim()
    ? path.resolve(environment.LOCALAPPDATA)
    : path.join(os.homedir(), "AppData", "Local");
  const profileRoot = path.join(localAppData, "CodexBrowser", "profiles");
  return { profileRoot, profileDir: path.join(profileRoot, "primary") };
}

export function createUniqueEdgeProfile(runtimeRoot: string): string {
  const profilesRoot = path.join(path.resolve(runtimeRoot), "edge-profiles");
  mkdirSync(profilesRoot, { recursive: true });
  return path.join(profilesRoot, `phase1-${Date.now()}-${randomUUID()}`);
}

function processAlive(pid: number | undefined): boolean | undefined {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return undefined;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true; }
}

function findConfirmedOwnedEdges(profileDir: string): number[] {
  if (process.platform !== "win32") return [];
  const command = "Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:CODEX_BROWSER_PROFILE,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf('--remote-debugging-port=0',[System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf('--type=',[System.StringComparison]::OrdinalIgnoreCase) -lt 0 } | Select-Object -ExpandProperty ProcessId";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, CODEX_BROWSER_PROFILE: path.resolve(profileDir) },
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Codex Browser could not verify ownership of the remaining Edge process. Close the dedicated Edge window and retry.");
  }
  return result.stdout.split(/\r?\n/).map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0);
}

function acquireGuard(profileDir: string): () => void {
  const guardPath = path.join(profileDir, ACQUIRE_FILE);
  const open = () => {
    const descriptor = openSync(guardPath, "wx");
    writeSync(descriptor, JSON.stringify({ pid: process.pid }), 0, "utf8");
    return descriptor;
  };
  let descriptor: number;
  try {
    descriptor = open();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let ownerPid: number | undefined;
    try { ownerPid = JSON.parse(readFileSync(guardPath, "utf8")).pid; } catch {}
    if (processAlive(ownerPid) !== false) throw new Error("The dedicated Edge profile is currently being acquired by another Codex Browser instance.");
    unlinkSync(guardPath);
    descriptor = open();
  }
  return () => {
    closeSync(descriptor);
    if (existsSync(guardPath)) unlinkSync(guardPath);
  };
}

export function acquireEdgeProfile(profileDir: string, profileRoot: string, browserVersion = "unknown"): EdgeProfileLease {
  assertPathWithin(profileRoot, profileDir);
  mkdirSync(profileDir, { recursive: true });
  const releaseGuard = acquireGuard(profileDir);
  try {
  const ownerPath = path.join(profileDir, OWNER_FILE);
  if (existsSync(ownerPath)) {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { product?: string; profileVersion?: number };
      if (owner.product !== "CodexBrowser") throw new Error("The profile ownership metadata is not recognized.");
      if (owner.profileVersion !== PROFILE_SCHEMA_VERSION) throw new Error("The profile schema is not supported by this Codex Browser release. The original profile was preserved.");
    } catch (error) {
      throw new Error(`The dedicated Edge profile has invalid ownership metadata. Use the control center recovery option. ${(error as Error).message}`);
    }
  }
  const lockPath = path.join(profileDir, LOCK_FILE);
  let descriptor: number;
  let recoveredBrowserPid: number | undefined;
  try {
    descriptor = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let lock: { pid?: number; browserPid?: number } = {};
      try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch {
        throw new Error("The dedicated Edge profile lock is unreadable. Close the managed Edge window and use profile recovery before retrying.");
      }
      const brokerAlive = processAlive(lock.pid);
      const browserAlive = processAlive(lock.browserPid);
      if (brokerAlive === false) {
        const ownedEdges = findConfirmedOwnedEdges(profileDir);
        if (ownedEdges.length === 1) {
          recoveredBrowserPid = ownedEdges[0];
          unlinkSync(lockPath);
          descriptor = openSync(lockPath, "wx");
        } else if (ownedEdges.length === 0 && browserAlive === false) {
          unlinkSync(lockPath);
          descriptor = openSync(lockPath, "wx");
        } else if (ownedEdges.length > 1) {
          throw new Error("More than one Edge browser process claims the dedicated profile. Close those dedicated Edge windows before retrying.");
        } else {
          throw new Error("The Codex Browser control service stopped, but the remaining browser process could not be confirmed as owned. Close that dedicated Edge window, then retry.");
        }
      } else {
        throw new Error("The dedicated Codex Browser Edge profile is already in use. Show the existing control center or close the managed browser before retrying.");
      }
    } else {
      throw error;
    }
  }
  const instanceId = randomUUID();
  const now = new Date().toISOString();
  const owner = { product: "CodexBrowser", profileVersion: PROFILE_SCHEMA_VERSION, instanceId, pid: process.pid, browserVersion, createdAt: now, acquiredAt: now, browserPid: recoveredBrowserPid };
  const writeLease = () => {
    writeFileSync(ownerPath, JSON.stringify(owner, null, 2), "utf8");
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, JSON.stringify({ instanceId, pid: process.pid, browserPid: owner.browserPid, browserVersion, acquiredAt: now }), 0, "utf8");
  };
  writeLease();
  let released = false;
  releaseGuard();
  return {
    profileDir, instanceId, browserPid: recoveredBrowserPid, recovered: Boolean(recoveredBrowserPid),
    setBrowserPid(pid) { if (released) throw new Error("The Edge profile lease is already released."); owner.browserPid = pid; writeLease(); },
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    },
  };
  } catch (error) {
    releaseGuard();
    throw error;
  }
}

export function assertOwnedEdgeProfile(profileDir: string, profileRoot: string): void {
  assertPathWithin(profileRoot, profileDir);
  const ownerPath = path.join(profileDir, OWNER_FILE);
  if (!existsSync(ownerPath)) throw new Error("The selected directory is not an initialized Codex Browser profile.");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { product?: string; profileVersion?: number };
  if (owner.product !== "CodexBrowser" || owner.profileVersion !== PROFILE_SCHEMA_VERSION) throw new Error("The selected directory is not owned by this Codex Browser profile schema.");
}

export function archiveOwnedEdgeProfile(profileDir: string, profileRoot: string): string {
  assertOwnedEdgeProfile(profileDir, profileRoot);
  if (existsSync(path.join(profileDir, LOCK_FILE))) throw new Error("The dedicated Edge profile is still locked and cannot be reset.");
  const backupsRoot = path.join(profileRoot, "_backups");
  mkdirSync(backupsRoot, { recursive: true });
  const destination = path.join(backupsRoot, `${path.basename(profileDir)}-${Date.now()}-${randomUUID()}`);
  assertPathWithin(backupsRoot, destination);
  renameSync(profileDir, destination);
  mkdirSync(profileDir, { recursive: true });
  return destination;
}

export function removeArchivedEdgeProfile(archiveDir: string, profileRoot: string): void {
  const backupsRoot = path.join(path.resolve(profileRoot), "_backups");
  assertPathWithin(backupsRoot, archiveDir);
  rmSync(archiveDir as PathLike, { recursive: true, force: true });
}

export function removeManagedEdgeProfile(profileDir: string, runtimeRoot: string): void {
  const profilesRoot = path.join(path.resolve(runtimeRoot), "edge-profiles");
  assertPathWithin(profilesRoot, profileDir);
  if (!path.basename(profileDir).startsWith("phase1-")) throw new Error("Refusing to remove an Edge profile without the isolated-test prefix.");
  rmSync(profileDir as PathLike, { recursive: true, force: true });
}
