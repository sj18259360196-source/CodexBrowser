import path from "node:path";
import { fileURLToPath } from "node:url";

export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_MINOR = 13;

export function isSupportedNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value).trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(isSupportedNodeVersion(process.versions.node) ? 0 : 1);
}
