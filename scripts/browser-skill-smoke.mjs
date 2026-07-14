import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = path.join(projectRoot, "dist", "electron", "browser-skill-service.js");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-browser-skill-smoke-"));
const skillsRoot = path.join(testRoot, "browser-skills");

function requireExport(module, name) {
  const value = module[name] ?? module.default?.[name];
  if (!value) throw new Error(`Built browser skill service does not export ${name}. Run npm run build first.`);
  return value;
}

async function loadServiceClass() {
  try {
    await fs.access(servicePath);
  } catch {
    throw new Error(`Built browser skill service was not found at ${servicePath}. Run npm run build first.`);
  }
  const module = await import(`${pathToFileURL(servicePath).href}?smoke=${Date.now()}`);
  return requireExport(module, "BrowserSkillService");
}

async function expectRejected(operation, label) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, label);
}

async function persistedSkillText() {
  const names = ["skills.json", "traces.json"];
  const contents = await Promise.all(names.map((name) => fs.readFile(path.join(skillsRoot, name), "utf8")));
  return contents.join("\n");
}

async function removeTestRoot() {
  const resolved = path.resolve(testRoot);
  if (!path.basename(resolved).startsWith("codex-browser-skill-smoke-")) {
    throw new Error(`Refusing to remove an unverified smoke directory: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

const secrets = {
  query: "token-0123456789abcdef0123456789abcdef",
  navigation: "private-navigation-query-019f5ffa40a27c01",
  fill: "private-case-filter-019f5ffa40a27c01",
  password: "private-password-019f5ffa40a27c01",
  droppedParameter: "private-authorization-019f5ffa40a27c01",
  executable: "private-script-019f5ffa40a27c01",
};

const sessionId = `browser-skill-smoke-${randomUUID()}`;

try {
  const BrowserSkillService = await loadServiceClass();
  const service = new BrowserSkillService(testRoot);
  await service.initialize();
  assert.deepEqual(await service.listSkills(), [], "A new browser skill store should be empty.");

  const startedTrace = await service.startTrace(sessionId, {
    title: "Filter support requests",
    query: `Find urgent support requests ${secrets.query}`,
    url: `https://support.example.test/queues/open?token=${secrets.navigation}`,
  });
  assert.equal(startedTrace.status, "recording");
  assert.equal(startedTrace.operationCount, 0);

  const ignoredOperation = await service.recordOperation(sessionId, {
    method: "paper.download",
    label: "Domain-specific operation must not enter generic skills",
    params: { url: "https://support.example.test/not-a-paper.pdf" },
  });
  assert.equal(ignoredOperation, null, "Unknown operations should not be recorded as browser skills.");

  await service.recordOperation(sessionId, {
    method: "browser.navigate",
    label: "Open the request queue",
    params: {
      url: `https://support.example.test/queues/open?token=${secrets.navigation}`,
      authorization: secrets.droppedParameter,
      javascript: secrets.executable,
    },
    before: { url: "https://support.example.test/" },
    after: { url: `https://support.example.test/queues/open?token=${secrets.navigation}` },
    outcome: "success",
    durationMs: 120,
  });

  await service.recordOperation(sessionId, {
    method: "browser.snapshot",
    label: "Inspect the queue controls",
    params: { maxElements: 100 },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 25,
  });

  await service.recordOperation(sessionId, {
    method: "browser.act",
    label: "Fill queue search",
    params: {
      action: "fill",
      text: secrets.fill,
      authorization: secrets.droppedParameter,
      script: secrets.executable,
    },
    target: {
      tag: "input",
      role: "textbox",
      name: "Queue search",
      placeholder: "Search requests",
    },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 35,
  });

  await service.recordOperation(sessionId, {
    method: "browser.act",
    label: "Choose priority",
    params: { action: "select", value: "urgent" },
    target: { tag: "select", role: "combobox", name: "Priority" },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 20,
  });

  await service.recordOperation(sessionId, {
    method: "browser.act",
    label: "Apply filters",
    params: { action: "click" },
    target: { tag: "button", role: "button", name: "Apply filters" },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 45,
  });

  await service.recordOperation(sessionId, {
    method: "browser.wait",
    label: "Wait for matching requests",
    params: { condition: "text", value: "3 matching requests", timeoutMs: 3_000 },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 80,
  });

  await service.recordOperation(sessionId, {
    method: "browser.act",
    label: "Sensitive values must never be learned",
    params: { action: "fill", text: secrets.password },
    target: { tag: "input", role: "textbox", type: "password", name: "API password" },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "success",
    durationMs: 15,
  });

  await service.recordOperation(sessionId, {
    method: "browser.act",
    label: "Failed actions must not become replay steps",
    params: { action: "click" },
    target: { tag: "button", role: "button", name: "Unavailable view" },
    before: { url: "https://support.example.test/queues/open" },
    after: { url: "https://support.example.test/queues/open" },
    outcome: "error",
    detail: "The control was unavailable.",
    durationMs: 10,
  });

  const finalized = await service.finalizeTrace(sessionId, {
    name: "Filter support requests",
    description: "Reusable workflow for narrowing a support queue.",
  });
  assert.equal(finalized.trace.status, "learned");
  assert.ok(finalized.skill, "A generic successful trace should create a draft skill.");
  assert.equal(finalized.skill.status, "draft");
  assert.equal(finalized.skill.source, "learned");
  assert.equal(finalized.skill.sourceTraceId, finalized.trace.id);
  assert.deepEqual(
    finalized.skill.steps.map((step) => step.method),
    ["browser.navigate", "browser.act", "browser.act", "browser.act", "browser.wait"],
    "Only successful replayable browser operations should become skill steps.",
  );
  assert.ok(finalized.skill.inputs.length >= 3, "Variable form and wait values should become skill inputs.");
  assert.ok(
    finalized.skill.steps.some((step) => JSON.stringify(step.params).includes("{{input_")),
    "Learned values should be represented by input placeholders.",
  );
  assert.equal(finalized.skill.steps.some((step) => step.method.startsWith("paper.")), false);

  const storedText = await persistedSkillText();
  for (const secret of [...Object.values(secrets), sessionId]) {
    assert.equal(storedText.includes(secret), false, "Browser skill storage leaked a raw sensitive value.");
  }
  assert.ok(storedText.includes("[REDACTED]"), "Sensitive trace data should leave an explicit redaction marker.");

  const timestamp = new Date().toISOString();
  const manualSkill = {
    ...structuredClone(finalized.skill),
    id: "manual-support-filter",
    name: "Manual support filter",
    description: "Manually managed generic browser workflow.",
    status: "disabled",
    source: "manual",
    sourceTraceId: undefined,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const createdManual = await service.saveSkill(manualSkill);
  assert.equal(createdManual.version, 1);
  assert.equal((await service.getSkill(createdManual.id))?.name, "Manual support filter");

  const updatedManual = await service.saveSkill({
    ...createdManual,
    description: "Updated through browser skill CRUD.",
  });
  assert.equal(updatedManual.version, 2, "Updating a browser skill should advance its version.");
  assert.equal(updatedManual.description, "Updated through browser skill CRUD.");

  const matchableDraft = await service.saveSkill({
    ...finalized.skill,
    trigger: {
      ...finalized.skill.trigger,
      keywords: ["support", "urgent", "request"],
    },
  });
  const enabledSkill = await service.setStatus(matchableDraft.id, "enabled");
  assert.equal(enabledSkill.status, "enabled");

  const matches = await service.matchSkills(
    "Filter urgent support requests",
    "https://support.example.test/queues/open?token=must-not-affect-match",
  );
  assert.equal(matches[0]?.skill.id, enabledSkill.id, "Host, path, and task keywords should match the enabled skill.");
  assert.ok(matches[0].score >= 50, "A matching host should contribute a strong score.");
  assert.ok(matches[0].reasons.some((reason) => reason.startsWith("host:")));
  assert.deepEqual(
    await service.matchSkills("Filter urgent support requests", "https://unrelated.example.test/queues/open"),
    [],
    "A skill scoped to another host must not match.",
  );

  const firstRun = await service.recordRunResult(enabledSkill.id, true, 1_200, "2026-07-14T10:00:00.000Z");
  const secondRun = await service.recordRunResult(enabledSkill.id, false, 600, "2026-07-14T10:01:00.000Z");
  assert.deepEqual(
    {
      runCount: secondRun.stats.runCount,
      successCount: secondRun.stats.successCount,
      failureCount: secondRun.stats.failureCount,
      averageDurationMs: secondRun.stats.averageDurationMs,
    },
    { runCount: 2, successCount: 1, failureCount: 1, averageDurationMs: 900 },
  );
  assert.equal(secondRun.stats.lastSuccessAt, firstRun.stats.lastSuccessAt);

  const exportPath = path.join(testRoot, "exports", "support-filter.cbskill");
  await service.exportSkill(enabledSkill.id, exportPath);
  const exportedPayload = JSON.parse(await fs.readFile(exportPath, "utf8"));
  assert.equal(exportedPayload.format, "codex-browser-skill");
  assert.equal(service.parseSkillExport(exportedPayload).id, enabledSkill.id);

  const importedSkill = await service.importSkill(exportPath);
  assert.notEqual(importedSkill.id, enabledSkill.id);
  assert.equal(importedSkill.status, "disabled", "Imported browser skills must be disabled pending review.");
  assert.equal(importedSkill.source, "imported");
  assert.deepEqual(
    importedSkill.stats,
    { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
    "Imported skills must not inherit another user's run history.",
  );

  const countBeforeInvalidImports = (await service.listSkills()).length;
  const invalidSchemaPath = path.join(testRoot, "invalid-schema.cbskill");
  await fs.writeFile(invalidSchemaPath, JSON.stringify({ ...exportedPayload, formatVersion: 999 }), "utf8");
  await expectRejected(
    () => service.importSkill(invalidSchemaPath),
    "An unsupported browser skill export schema should be rejected.",
  );

  const executablePayload = structuredClone(exportedPayload);
  executablePayload.skill.id = "unsafe-executable-skill";
  executablePayload.skill.steps[0].method = "shell.exec";
  executablePayload.skill.steps[0].params = { command: "Write-Output unsafe" };
  const executablePath = path.join(testRoot, "unsafe-executable.cbskill");
  await fs.writeFile(executablePath, JSON.stringify(executablePayload), "utf8");
  await expectRejected(
    () => service.importSkill(executablePath),
    "An imported skill containing an executable method should be rejected.",
  );

  const sensitiveDefaultPayload = structuredClone(exportedPayload);
  sensitiveDefaultPayload.skill.id = "unsafe-sensitive-default";
  sensitiveDefaultPayload.skill.inputs[0].sensitive = true;
  sensitiveDefaultPayload.skill.inputs[0].defaultValue = secrets.password;
  const sensitiveDefaultPath = path.join(testRoot, "unsafe-sensitive-default.cbskill");
  await fs.writeFile(sensitiveDefaultPath, JSON.stringify(sensitiveDefaultPayload), "utf8");
  await expectRejected(
    () => service.importSkill(sensitiveDefaultPath),
    "An imported sensitive input with a default value should be rejected.",
  );
  assert.equal(
    (await service.listSkills()).length,
    countBeforeInvalidImports,
    "Rejected imports must not mutate browser skill storage.",
  );

  const reloadedService = new BrowserSkillService(testRoot);
  await reloadedService.initialize();
  const persistedEnabled = await reloadedService.getSkill(enabledSkill.id);
  assert.equal(persistedEnabled?.status, "enabled");
  assert.equal(persistedEnabled?.stats.runCount, 2);
  assert.equal((await reloadedService.getSkill(updatedManual.id))?.version, 2);
  assert.equal((await reloadedService.getSkill(importedSkill.id))?.source, "imported");

  await reloadedService.deleteSkill(updatedManual.id);
  assert.equal(await reloadedService.getSkill(updatedManual.id), null);
  await reloadedService.deleteSkill(enabledSkill.id);
  await reloadedService.discardTrace(finalized.trace.id);

  const finalService = new BrowserSkillService(testRoot);
  await finalService.initialize();
  assert.equal(await finalService.getSkill(updatedManual.id), null, "Deleted skills must remain deleted after reload.");
  assert.equal(await finalService.getSkill(enabledSkill.id), null, "Deleted learned skills must remain deleted after reload.");
  assert.equal((await finalService.getTrace(finalized.trace.id))?.status, "discarded");
  assert.equal((await finalService.listTraceSummaries()).some((trace) => trace.id === finalized.trace.id), false);
  assert.equal((await finalService.listTraceSummaries(true)).some((trace) => trace.id === finalized.trace.id), true);

  console.log(JSON.stringify({
    genericTraceOperations: finalized.trace.operationCount,
    learnedSteps: finalized.skill.steps.length,
    learnedInputs: finalized.skill.inputs.length,
    rawSecretsAbsent: true,
    crudPersistedAcrossReload: true,
    matchingVerified: true,
    runStats: secondRun.stats,
    importDefaultsSafe: true,
    invalidImportsRejected: 3,
  }, null, 2));
} finally {
  await removeTestRoot();
}
