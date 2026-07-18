import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireEdgeProfile,
  archiveOwnedEdgeProfile,
  assertPathWithin,
  removeArchivedEdgeProfile,
  resolvePrimaryEdgeProfile,
} from "../src/browser/edge-profile.ts";

function temporaryRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-browser-profile-test-"));
}

test("primary profile is resolved below the supplied LOCALAPPDATA", () => {
  const localAppData = path.join("C:\\", "fixture-local-app-data");
  const location = resolvePrimaryEdgeProfile({ LOCALAPPDATA: localAppData });
  assert.equal(location.profileRoot, path.join(localAppData, "CodexBrowser", "profiles"));
  assert.equal(location.profileDir, path.join(location.profileRoot, "primary"));
});

test("profile paths must remain strict children of the managed root", () => {
  const root = temporaryRoot();
  try {
    assert.doesNotThrow(() => assertPathWithin(root, path.join(root, "primary")));
    assert.throws(() => assertPathWithin(root, root));
    assert.throws(() => assertPathWithin(root, path.dirname(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership metadata contains only the approved fields and lock is exclusive", () => {
  const root = temporaryRoot();
  const profile = path.join(root, "primary");
  try {
    const lease = acquireEdgeProfile(profile, root, "150.0.0.0");
    lease.setBrowserPid(process.pid);
    const owner = JSON.parse(readFileSync(path.join(profile, ".codex-browser-profile.json"), "utf8"));
    assert.deepEqual(Object.keys(owner).sort(), [
      "acquiredAt", "browserPid", "browserVersion", "createdAt", "instanceId", "pid", "product", "profileVersion",
    ]);
    assert.equal(owner.product, "CodexBrowser");
    assert.throws(() => acquireEdgeProfile(profile, root), /already in use/i);
    lease.release();
    assert.equal(existsSync(path.join(profile, ".codex-browser-profile.lock")), false);
    const reacquired = acquireEdgeProfile(profile, root);
    reacquired.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock is reclaimed only when both recorded processes are confirmed gone", () => {
  const root = temporaryRoot();
  const profile = path.join(root, "primary");
  try {
    const lease = acquireEdgeProfile(profile, root);
    lease.release();
    writeFileSync(path.join(profile, ".codex-browser-profile.lock"), JSON.stringify({ instanceId: "stale", pid: 2_000_000_001, browserPid: 2_000_000_002 }));
    const recovered = acquireEdgeProfile(profile, root);
    recovered.release();
    writeFileSync(path.join(profile, ".codex-browser-profile.lock"), JSON.stringify({ instanceId: "uncertain", pid: 2_000_000_001 }));
    assert.throws(() => acquireEdgeProfile(profile, root), /already in use|recovery|could not be confirmed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owned profiles can be archived and only managed archives can be removed", () => {
  const root = temporaryRoot();
  const profile = path.join(root, "primary");
  const unrelated = path.join(root, "unrelated");
  try {
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, "keep.txt"), "keep");
    const lease = acquireEdgeProfile(profile, root);
    lease.release();
    const archive = archiveOwnedEdgeProfile(profile, root);
    assert.equal(existsSync(archive), true);
    assert.equal(existsSync(profile), true);
    removeArchivedEdgeProfile(archive, root);
    assert.equal(existsSync(archive), false);
    assert.equal(readFileSync(path.join(unrelated, "keep.txt"), "utf8"), "keep");
    assert.throws(() => removeArchivedEdgeProfile(unrelated, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile ownership works under Chinese and spaced paths", () => {
  const root = path.join(temporaryRoot(), "中文 Product Data", "profiles");
  const profile = path.join(root, "primary profile");
  try {
    const lease = acquireEdgeProfile(profile, root, "150.0.0.0");
    lease.release();
    assert.equal(existsSync(path.join(profile, ".codex-browser-profile.json")), true);
  } finally {
    rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
  }
});

test("invalid or mismatched ownership is preserved and rejected", () => {
  const root = temporaryRoot();
  const profile = path.join(root, "primary");
  try {
    mkdirSync(profile, { recursive: true });
    const ownerPath = path.join(profile, ".codex-browser-profile.json");
    writeFileSync(ownerPath, JSON.stringify({ product: "CodexBrowser", profileVersion: 999 }), "utf8");
    assert.throws(() => acquireEdgeProfile(profile, root), /schema|recovery/i);
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).profileVersion, 999);
    writeFileSync(ownerPath, "{broken", "utf8");
    assert.throws(() => acquireEdgeProfile(profile, root), /invalid ownership|recovery/i);
    assert.equal(readFileSync(ownerPath, "utf8"), "{broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-directory profile root fails without deleting the root", () => {
  const root = temporaryRoot();
  const blockedRoot = path.join(root, "read-only-fixture");
  writeFileSync(blockedRoot, "preserve", "utf8");
  assert.throws(() => acquireEdgeProfile(path.join(blockedRoot, "primary"), blockedRoot));
  assert.equal(readFileSync(blockedRoot, "utf8"), "preserve");
  rmSync(root, { recursive: true, force: true });
});
