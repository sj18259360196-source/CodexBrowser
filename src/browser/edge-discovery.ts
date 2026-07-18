import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MINIMUM_EDGE_MAJOR_VERSION } from "../shared/release-info.js";

export interface EdgeInstallation {
  executablePath: string;
  version: string;
  majorVersion: number;
}

export function assertSupportedEdge(installation: Pick<EdgeInstallation, "majorVersion">): void {
  if (!Number.isInteger(installation.majorVersion) || installation.majorVersion < MINIMUM_EDGE_MAJOR_VERSION) {
    throw new Error(`The installed Microsoft Edge version is not supported. Edge ${MINIMUM_EDGE_MAJOR_VERSION} or newer is required.`);
  }
}

const EDGE_ENV_KEYS = ["CODEX_BROWSER_EDGE_PATH", "EDGE_PATH"] as const;

function commonEdgePaths(environment: NodeJS.ProcessEnv): string[] {
  const roots = [environment["ProgramFiles(x86)"], environment.ProgramFiles, environment.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  return roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
}

function registryEdgePaths(): string[] {
  if (process.platform !== "win32") return [];
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
  ];
  const found: string[] = [];
  for (const key of keys) {
    const result = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) continue;
    const match = result.stdout.match(/REG_SZ\s+([^\r\n]+)/i);
    if (match?.[1]) found.push(match[1].trim());
  }
  return found;
}

function readFileVersion(executablePath: string): string {
  const literalPath = executablePath.replace(/'/g, "''");
  const command = `(Get-Item -LiteralPath '${literalPath}').VersionInfo.ProductVersion`;
  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const version = result.status === 0 ? result.stdout.trim() : "";
    if (/^\d+(?:\.\d+){1,3}$/.test(version)) return version;
  }
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const match = `${result.stdout}\n${result.stderr}`.match(/(\d+(?:\.\d+){1,3})/);
  if (match?.[1]) return match[1];
  throw new Error("Microsoft Edge was found, but its browser version could not be read.");
}

export function discoverEdge(environment: NodeJS.ProcessEnv = process.env): EdgeInstallation {
  if (process.platform !== "win32") {
    throw new Error("The external Edge runtime currently supports Windows only.");
  }
  const explicit = EDGE_ENV_KEYS.map((key) => environment[key]?.trim()).find(Boolean);
  const candidates = explicit ? [explicit] : [...commonEdgePaths(environment), ...registryEdgePaths()];
  const executablePath = candidates
    .map((candidate) => path.resolve(candidate!))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!executablePath) {
    if (explicit) throw new Error("The Edge executable specified by the environment does not exist.");
    throw new Error("Microsoft Edge was not found. Install Edge or set CODEX_BROWSER_EDGE_PATH to msedge.exe.");
  }
  const version = readFileVersion(executablePath);
  const majorVersion = Number.parseInt(version.split(".")[0] || "", 10);
  if (!Number.isFinite(majorVersion)) throw new Error("Microsoft Edge returned an invalid browser version.");
  return { executablePath, version, majorVersion };
}
