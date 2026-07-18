import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAssistance } from "../src/shared/contracts.ts";
import {
  MAX_PERSISTED_DOWNLOADS,
  MAX_PERSISTED_BLOCKED_TABS,
  MAX_PERSISTED_TABS,
  MAX_PERSISTED_TASKS,
  isGeneratedPersistedDownloadName,
  isHumanAssistance,
  isPersistedBlockedTab,
  parseLegacyAssistanceBoundary,
  parsePersistedBrowserTab,
  parsePersistedBrowserTabs,
  parsePersistedBlockedTab,
  parsePersistedBlockedTabs,
  parsePersistedDownload,
  parsePersistedDownloads,
  parsePersistedTask,
  parsePersistedTasks,
  parseRuntimeBlockedTabs,
} from "../src/electron/persistence-validation.ts";

const requestedAt = new Date("2026-07-16T00:00:00.000Z").toISOString();

function assistance(status: HumanAssistance["status"]): HumanAssistance {
  return {
    id: "assistance-a",
    tabId: "tab-a",
    taskId: "task-a",
    kind: "verification",
    title: "Manual verification required",
    detail: "Complete the visible browser step, then request verification.",
    url: "https://example.test/manual-step",
    status,
    requestedAt,
  };
}

for (const status of ["waiting_user", "verifying", "completed", "unable", "cancelled", "expired"] as const) {
  test(`accepts persisted assistance status ${status}`, () => {
    assert.equal(isHumanAssistance(assistance(status)), true);
  });
}

test("rejects unknown persisted assistance statuses", () => {
  assert.equal(isHumanAssistance({ ...assistance("waiting_user"), status: "pending" }), false);
});

test("rejects malformed persisted assistance records", () => {
  assert.equal(isHumanAssistance(null), false);
  assert.equal(isHumanAssistance({ ...assistance("verifying"), requestedAt: "not-a-date" }), false);
  assert.equal(isHumanAssistance({ ...assistance("verifying"), kind: "unsupported" }), false);
  assert.equal(isHumanAssistance({ ...assistance("completed"), resolvedAt: "not-a-date" }), false);
});

test("accepts sanitized tab-scoped blocked records", () => {
  assert.equal(isPersistedBlockedTab({
    tabId: "tab-a",
    kind: "auth",
    authReason: "mfa",
    requestedAt,
  }), true);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-b", kind: "assistance", requestedAt }), true);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-c", kind: "dialog", requestedAt }), true);
});

test("rejects malformed or over-specified blocked records", () => {
  assert.equal(isPersistedBlockedTab({ tabId: "", kind: "dialog", requestedAt }), false);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-a", kind: "auth", requestedAt }), false);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-a", kind: "auth", authReason: "unknown", requestedAt }), false);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-a", kind: "dialog", authReason: "login", requestedAt }), false);
  assert.equal(isPersistedBlockedTab({ tabId: "tab-a", kind: "assistance", requestedAt: "not-a-date" }), false);
});

test("projects blocked records onto a metadata-only allowlist", () => {
  const parsed = parsePersistedBlockedTab({
    tabId: " tab-a ",
    kind: "auth",
    authReason: "login",
    requestedAt,
    detail: "must not survive",
    url: "https://example.test/private",
    token: "must not survive",
  });

  assert.deepEqual(parsed, {
    tabId: "tab-a",
    kind: "auth",
    authReason: "login",
    requestedAt,
  });
  assert.equal(JSON.stringify(parsed).includes("must not survive"), false);
});

test("projects blocked record arrays, removes duplicates, and rejects unknown tabs", () => {
  const blockedTabs = parsePersistedBlockedTabs([
    { tabId: "tab-a", kind: "auth", authReason: "login", requestedAt, detail: "secret-a" },
    { tabId: "tab-a", kind: "auth", authReason: "mfa", requestedAt, detail: "secret-b" },
    { tabId: "tab-a", kind: "assistance", requestedAt, token: "secret-c" },
    { tabId: "tab-missing", kind: "dialog", requestedAt, url: "https://example.test/private" },
  ], new Set(["tab-a"]));

  assert.deepEqual(blockedTabs, [
    { tabId: "tab-a", kind: "auth", authReason: "login", requestedAt },
    { tabId: "tab-a", kind: "assistance", requestedAt },
  ]);
  assert.doesNotMatch(JSON.stringify(blockedTabs), /secret|private/);
});

test("limits persisted blocked metadata to the browser tab capacity", () => {
  const candidates = Array.from({ length: MAX_PERSISTED_BLOCKED_TABS + 8 }, (_, index) => ({
    tabId: `tab-${index}`,
    kind: "dialog",
    requestedAt,
  }));

  assert.equal(parsePersistedBlockedTabs(candidates).length, MAX_PERSISTED_BLOCKED_TABS);
});

test("migrates only unresolved version 2 assistance into metadata", () => {
  const legacy = {
    ...assistance("verifying"),
    title: "secret title",
    detail: "secret detail",
    url: "https://user:password@example.test/private?token=secret",
    note: "secret note",
  };
  const boundary = parseLegacyAssistanceBoundary(legacy);

  assert.deepEqual(boundary, { tabId: "tab-a", kind: "assistance", requestedAt });
  assert.doesNotMatch(JSON.stringify(boundary), /secret|password|private|example/);
  assert.equal(parseLegacyAssistanceBoundary(assistance("waiting_user"))?.kind, "assistance");
  assert.equal(parseLegacyAssistanceBoundary(assistance("completed")), null);
  assert.equal(parseLegacyAssistanceBoundary(assistance("unable")), null);
  assert.equal(parseLegacyAssistanceBoundary(assistance("cancelled")), null);
});

test("rejects malformed legacy assistance instead of restoring an unverified boundary", () => {
  assert.equal(parseLegacyAssistanceBoundary({ ...assistance("waiting_user"), tabId: "" }), null);
  assert.equal(parseLegacyAssistanceBoundary({ ...assistance("waiting_user"), requestedAt: "not-a-date" }), null);
  assert.equal(parseLegacyAssistanceBoundary({ ...assistance("waiting_user"), kind: "unsupported" }), null);
});

test("migrates unresolved version 2 assistance only for a restored tab", () => {
  const legacy = {
    ...assistance("waiting_user"),
    detail: "legacy-secret-detail",
    note: "legacy-secret-note",
  };
  const migrated = parseRuntimeBlockedTabs({ version: 2, assistance: legacy }, new Set(["tab-a"]));

  assert.deepEqual(migrated, [{ tabId: "tab-a", kind: "assistance", requestedAt }]);
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-secret/);
  assert.deepEqual(parseRuntimeBlockedTabs({ version: 2, assistance: legacy }, new Set(["tab-b"])), []);
});

test("does not treat a version 3 legacy assistance payload as a blocked boundary", () => {
  const blockedTabs = parseRuntimeBlockedTabs({
    version: 3,
    blockedTabs: [{
      tabId: "tab-a",
      kind: "dialog",
      requestedAt,
      detail: "must be stripped",
    }],
    assistance: {
      ...assistance("waiting_user"),
      detail: "must be ignored",
    },
  }, new Set(["tab-a"]));

  assert.deepEqual(blockedTabs, [{ tabId: "tab-a", kind: "dialog", requestedAt }]);
  assert.doesNotMatch(JSON.stringify(blockedTabs), /stripped|ignored/);
});

test("projects persisted tabs onto a bounded allowlist", () => {
  const parsed = parsePersistedBrowserTab({
    id: " tab-a ",
    title: "Example",
    url: "https://example.test/",
    createdAt: requestedAt,
    token: "must-not-survive",
    authorization: "must-not-survive",
    unknown: { nested: "must-not-survive" },
  });

  assert.deepEqual(parsed, {
    id: "tab-a",
    title: "Example",
    url: "https://example.test/",
    createdAt: requestedAt,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive|token|authorization|unknown/);
  assert.equal(parsePersistedBrowserTab({
    id: "tab-a",
    title: "x".repeat(301),
    url: "https://example.test/",
    createdAt: requestedAt,
  }), null);
});

test("projects persisted tasks without retaining caller-supplied fields", () => {
  const parsed = parsePersistedTask({
    id: "task-a",
    label: "Open page",
    detail: "Public status only",
    status: "done",
    createdAt: requestedAt,
    updatedAt: requestedAt,
    token: "must-not-survive",
    authorization: "must-not-survive",
    result: { private: "must-not-survive" },
  });

  assert.deepEqual(parsed, {
    id: "task-a",
    label: "Open page",
    detail: "Public status only",
    status: "done",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive|token|authorization|result/);
  assert.equal(parsePersistedTask({
    id: "task-a",
    label: "x".repeat(301),
    status: "done",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  }), null);
});

test("projects persisted downloads and fills legacy timestamps", () => {
  const generatedFileName = "download-1720000000000-a1b2c3d4.pdf";
  const parsed = parsePersistedDownload({
    id: "download-a",
    fileName: generatedFileName,
    path: `A:\\Downloads\\${generatedFileName}`,
    url: "https://example.test/report.pdf",
    receivedBytes: 100,
    totalBytes: 200,
    state: "progressing",
    token: "must-not-survive",
    authorization: "must-not-survive",
    headers: { private: "must-not-survive" },
  }, requestedAt);

  assert.deepEqual(parsed, {
    id: "download-a",
    fileName: generatedFileName,
    path: `A:\\Downloads\\${generatedFileName}`,
    url: "https://example.test/report.pdf",
    receivedBytes: 100,
    totalBytes: 200,
    state: "progressing",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive|token|authorization|headers/);
  assert.equal(parsePersistedDownload({
    id: "download-a",
    fileName: generatedFileName,
    url: "https://example.test/report.pdf",
    receivedBytes: -1,
    totalBytes: 200,
    state: "progressing",
  }, requestedAt), null);
  assert.equal(isGeneratedPersistedDownloadName("report.pdf"), false);
  assert.equal(parsePersistedDownload({
    id: "download-a",
    fileName: "secret-value.pdf",
    path: "A:\\Downloads\\secret-value.pdf",
    url: "https://example.test/report.pdf",
    receivedBytes: 100,
    totalBytes: 100,
    state: "completed",
  }, requestedAt), null);
  assert.equal(parsePersistedDownload({
    id: "download-a",
    fileName: generatedFileName,
    path: "A:\\Downloads\\download-1720000000000-deadbeef.pdf",
    url: "https://example.test/report.pdf",
    receivedBytes: 100,
    totalBytes: 100,
    state: "completed",
  }, requestedAt), null);
});

test("limits persisted tab, task, and download collections", () => {
  const tabs = Array.from({ length: MAX_PERSISTED_TABS + 3 }, (_, index) => ({
    id: `tab-${index}`,
    title: `Tab ${index}`,
    url: `https://example.test/${index}`,
    createdAt: requestedAt,
  }));
  const tasks = Array.from({ length: MAX_PERSISTED_TASKS + 3 }, (_, index) => ({
    id: `task-${index}`,
    label: `Task ${index}`,
    status: "done",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  }));
  const downloads = Array.from({ length: MAX_PERSISTED_DOWNLOADS + 3 }, (_, index) => ({
    id: `download-${index}`,
    fileName: `download-1720000000000-${index.toString(16).padStart(8, "0")}.pdf`,
    url: `https://example.test/report-${index}.pdf`,
    receivedBytes: 100,
    totalBytes: 100,
    state: "completed",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  }));

  assert.equal(parsePersistedBrowserTabs(tabs).length, MAX_PERSISTED_TABS);
  assert.equal(parsePersistedTasks(tasks).length, MAX_PERSISTED_TASKS);
  assert.equal(parsePersistedDownloads(downloads, requestedAt).length, MAX_PERSISTED_DOWNLOADS);
});
