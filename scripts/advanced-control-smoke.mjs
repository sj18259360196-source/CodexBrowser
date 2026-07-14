import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = "A:\\Project\\CodexBrowser";
const launcher = "C:\\Users\\22865\\plugins\\codex-browser\\scripts\\launch-mcp.mjs";
const fixtureRoot = path.join(projectRoot, "src", "renderer");
const pdfFixturePath = path.join(projectRoot, "output", "test-fixtures", "dummy.pdf");
const runtimeRoot = path.resolve(projectRoot, ".runtime");
const testId = `advanced-smoke-${process.pid}-${Date.now()}`;
const pipeName = `codex-browser-${testId}`;
const profileDir = path.join(runtimeRoot, testId);
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
env.CODEX_BROWSER_PROJECT_ROOT = projectRoot;
env.CODEX_BROWSER_PIPE_NAME = pipeName;
env.CODEX_BROWSER_USER_DATA_DIR = profileDir;
env.CODEX_BROWSER_TEST_MODE = "1";

const requiredTools = [
  "browser_tabs",
  "browser_tab_new",
  "browser_tab_select",
  "browser_tab_close",
  "browser_screenshot",
  "browser_dialogs",
  "browser_dialog_respond",
  "browser_request_assistance",
  "browser_assistance_status",
  "browser_assistance_complete",
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

function errorText(result) {
  const block = result.content?.find((item) => item.type === "text");
  return typeof block?.text === "string" ? block.text : "unknown MCP error";
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${errorText(result)}`);
  return result;
}

function requireElement(snapshot, predicate, label) {
  const element = snapshot.elements?.find(predicate);
  if (!element) throw new Error(`Snapshot did not contain ${label}.`);
  return element;
}

function tabId(tab) {
  return tab?.tabId || tab?.id;
}

function assistanceId(assistance) {
  return assistance?.assistanceId || assistance?.id;
}

function dialogId(dialog) {
  return dialog?.dialogId || dialog?.id;
}

async function waitForValue(callback, predicate, label, attempts = 40) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await callback();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}`);
}

function probePipe() {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2_000).then(() => child.kill("SIGKILL")),
  ]);
}

async function removeTestProfile() {
  const relative = path.relative(runtimeRoot, profileDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(profileDir).startsWith("advanced-smoke-")) {
    throw new Error(`Refusing to remove an unverified smoke profile path: ${profileDir}`);
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}

function inspectPng(result) {
  const image = result.content?.find((item) => item.type === "image");
  if (!image || typeof image.data !== "string") throw new Error("browser_screenshot returned no MCP image block.");
  if (image.mimeType !== "image/png") throw new Error(`Unexpected screenshot MIME type: ${image.mimeType}`);
  const encoded = image.data.includes(",") ? image.data.slice(image.data.indexOf(",") + 1) : image.data;
  const bytes = Buffer.from(encoded, "base64");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 256 || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error("browser_screenshot did not return a valid PNG payload.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 100 || height < 100) throw new Error(`Screenshot dimensions are unexpectedly small: ${width}x${height}`);
  return { bytes: bytes.length, width, height };
}

async function waitForPageText(client, value) {
  const result = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value,
    timeoutMs: 3_000,
  }));
  if (!result.satisfied) throw new Error(`Page did not show expected text: ${value}`);
}

let pdfRequestCount = 0;
const fixtureServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/visible.pdf") {
      const body = await readFile(pdfFixturePath);
      if (request.method !== "HEAD") pdfRequestCount += 1;
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"visible.pdf\"",
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const fileName = pathname === "/popup-test.html" ? "popup-test.html" : "control-test.html";
    const body = await readFile(path.join(fixtureRoot, fileName));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const address = fixtureServer.address();
if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
const fixtureUrl = `http://127.0.0.1:${address.port}/control-test.html`;
const pdfFixtureUrl = `http://127.0.0.1:${address.port}/visible.pdf`;

const client = new Client({ name: "codex-browser-advanced-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [launcher], env });
const electronExecutable = process.platform === "win32"
  ? path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe")
  : path.join(projectRoot, "node_modules", ".bin", "electron");
const desktopProcess = spawn(electronExecutable, [projectRoot], {
  cwd: projectRoot,
  env,
  stdio: "ignore",
  windowsHide: true,
});
let controlTabId;
let popupTabId;
let pdfTabId;
let pendingAssistanceId;

try {
  await waitForValue(
    probePipe,
    (ready) => ready === true,
    `isolated desktop pipe ${pipeName}`,
    160,
  );
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const missingTools = requiredTools.filter((name) => !toolNames.has(name));
  if (missingTools.length > 0) throw new Error(`Missing advanced MCP tools: ${missingTools.join(", ")}`);

  await call(client, "browser_resume");
  const initialTabs = parseTextResult(await call(client, "browser_tabs"));
  if (!Array.isArray(initialTabs.tabs) || initialTabs.tabs.length < 1) throw new Error("browser_tabs returned no initial tab.");

  const created = parseTextResult(await call(client, "browser_tab_new", { url: fixtureUrl, activate: true }));
  controlTabId = created.createdTabId || created.activeTabId;
  if (!controlTabId || created.activeTabId !== controlTabId) throw new Error("browser_tab_new did not activate its created tab.");
  await waitForPageText(client, "Advanced browser controls");

  let snapshot = parseTextResult(await call(client, "browser_snapshot"));
  const username = requireElement(snapshot, (item) => item.name === "University username", "the username field");
  const password = requireElement(snapshot, (item) => item.name === "University password", "the password field");
  const login = requireElement(snapshot, (item) => item.name === "Sign in", "the sensitive form submit button");
  const removeAuth = requireElement(snapshot, (item) => item.name === "Remove authentication fixture", "the authentication fixture removal button");
  const checkbox = requireElement(snapshot, (item) => item.name === "Include supplementary material", "the checkbox");
  const hover = requireElement(snapshot, (item) => item.name === "Hover target", "the hover target");
  const doubleClick = requireElement(snapshot, (item) => item.name === "Double click target", "the double-click target");

  if (username.sensitive) throw new Error("A normal username field was incorrectly marked sensitive.");
  if (!password.sensitive) throw new Error("The password field was not marked sensitive.");
  if (!login.sensitive) throw new Error("The sensitive form submit button was not marked sensitive.");
  await call(client, "browser_act", { action: "fill", ref: username.ref, text: "researcher@example.edu" });
  snapshot = parseTextResult(await call(client, "browser_snapshot"));
  const filledUsername = requireElement(snapshot, (item) => item.name === "University username", "the filled username field");
  if (filledUsername.value !== "researcher@example.edu") throw new Error("Normal username filling did not persist.");
  const blockedSubmit = await client.callTool({ name: "browser_act", arguments: { action: "click", ref: login.ref } });
  if (!blockedSubmit.isError) throw new Error("Sensitive authentication submit was not blocked.");
  await call(client, "browser_resume");
  await call(client, "browser_act", { action: "click", ref: removeAuth.ref });
  await waitForPageText(client, "Authentication: resolved");

  await call(client, "browser_act", { action: "check", ref: checkbox.ref });
  await waitForPageText(client, "Checkbox: checked (trusted)");
  snapshot = parseTextResult(await call(client, "browser_snapshot"));
  if (!requireElement(snapshot, (item) => item.name === "Include supplementary material", "the checked checkbox").checked) {
    throw new Error("Check action did not update snapshot state.");
  }
  await call(client, "browser_act", { action: "uncheck", ref: checkbox.ref });
  await waitForPageText(client, "Checkbox: unchecked (trusted)");
  await call(client, "browser_act", { action: "hover", ref: hover.ref });
  await waitForPageText(client, "Hover: entered (trusted)");
  await call(client, "browser_act", { action: "double_click", ref: doubleClick.ref });
  await waitForPageText(client, "Double click: 1 (trusted)");

  const screenshotResult = await call(client, "browser_screenshot", { tabId: controlTabId });
  const screenshot = inspectPng(screenshotResult);
  const screenshotMetadata = parseTextResult(screenshotResult);
  if (screenshotMetadata.width && screenshotMetadata.width !== screenshot.width) {
    throw new Error("Screenshot metadata width did not match the PNG IHDR width.");
  }

  const documentsBefore = parseTextResult(await call(client, "document_list"));
  const pdfTabResult = parseTextResult(await call(client, "browser_tab_new", { url: pdfFixtureUrl, activate: true }));
  pdfTabId = pdfTabResult.createdTabId || pdfTabResult.activeTabId;
  if (!pdfTabId || pdfTabResult.activeTabId !== pdfTabId) throw new Error("The visible PDF tab was not activated.");
  const pdfCandidates = await waitForValue(
    async () => parseTextResult(await call(client, "paper_find_downloads", { tabId: pdfTabId })),
    (value) => Array.isArray(value) && value.some((candidate) => ["loaded_pdf", "visible_pdf"].includes(candidate.source)),
    "a local PDF download candidate",
    100,
  );
  const loadedPdfCandidate = pdfCandidates.find((candidate) => ["loaded_pdf", "visible_pdf"].includes(candidate.source));
  if (!loadedPdfCandidate?.id) throw new Error("The local PDF candidate had no opaque ID.");
  const requestsBeforeSave = pdfRequestCount;
  const savedPdf = parseTextResult(await call(client, "paper_download", {
    candidateId: loadedPdfCandidate.id,
    tabId: pdfTabId,
  }));
  if (!savedPdf.documentId) throw new Error("Saving the visible PDF did not return an imported document ID.");
  if (pdfRequestCount !== requestsBeforeSave) throw new Error("paper_download re-requested a PDF that was already loaded in the browser.");
  const downloads = parseTextResult(await call(client, "downloads_list"));
  const savedDownload = downloads.find((download) => download.id === savedPdf.jobId);
  if (savedDownload?.state !== "completed") throw new Error("The loaded PDF download did not complete synchronously.");
  const documentsAfter = parseTextResult(await call(client, "document_list"));
  if (!documentsAfter.some((document) => document.id === savedPdf.documentId)) {
    throw new Error("The saved visible PDF was not added to document_list.");
  }
  if (documentsBefore.some((document) => document.id === savedPdf.documentId)) {
    throw new Error("The visible PDF smoke did not create a new isolated document.");
  }
  const pdfStatus = parseTextResult(await call(client, "browser_status"));
  const pdfTask = pdfStatus.tasks?.find((task) => task.id === savedPdf.jobId);
  if (pdfStatus.authPrompt?.tabId === pdfTabId || pdfTask?.status !== "done" || /html|登录页|重新授权/i.test(pdfTask?.detail || "")) {
    throw new Error("Saving the visible PDF entered an HTML or authorization retry loop.");
  }
  const closedPdf = parseTextResult(await call(client, "browser_tab_close", { tabId: pdfTabId, force: true }));
  if (closedPdf.tabs.some((tab) => tabId(tab) === pdfTabId)) throw new Error("The visible PDF tab did not close after verification.");
  pdfTabId = undefined;
  if (closedPdf.activeTabId !== controlTabId) await call(client, "browser_tab_select", { tabId: controlTabId });

  await call(client, "browser_reload", { tabId: controlTabId });
  await call(client, "browser_wait", { condition: "idle", timeoutMs: 10_000, tabId: controlTabId });
  snapshot = parseTextResult(await call(client, "browser_snapshot"));
  const currentOpenPopup = requireElement(snapshot, (item) => item.name === "Open popup", "the popup button after PDF verification");
  await call(client, "browser_act", { action: "click", ref: currentOpenPopup.ref, revision: snapshot.revision });
  const popupTabs = await waitForValue(
    async () => parseTextResult(await call(client, "browser_tabs")),
    (value) => value.tabs.some((tab) => String(tab.url || "").includes("/popup-test.html")),
    "the popup tab",
  );
  const popupTab = popupTabs.tabs.find((tab) => String(tab.url || "").includes("/popup-test.html"));
  popupTabId = tabId(popupTab);
  if (!popupTabId || popupTabId === controlTabId) throw new Error("Popup did not create a distinct managed tab.");
  if (popupTabs.activeTabId !== popupTabId) await call(client, "browser_tab_select", { tabId: popupTabId });
  await waitForPageText(client, "Opener: message sent");
  const selected = parseTextResult(await call(client, "browser_tab_select", { tabId: controlTabId }));
  if (selected.activeTabId !== controlTabId) throw new Error("browser_tab_select did not activate the opener tab.");
  await waitForPageText(client, "Popup: ready from child");
  const closedPopup = parseTextResult(await call(client, "browser_tab_close", { tabId: popupTabId, force: true }));
  if (closedPopup.tabs.some((tab) => tabId(tab) === popupTabId)) throw new Error("browser_tab_close did not remove the popup tab.");
  popupTabId = undefined;
  if (closedPopup.activeTabId !== controlTabId) await call(client, "browser_tab_select", { tabId: controlTabId });

  const dialogCases = [
    { button: "Open alert", type: "alert", accept: true, result: "Alert: closed" },
    { button: "Open confirm", type: "confirm", accept: false, result: "Confirm: dismissed" },
  ];
  for (const dialogCase of dialogCases) {
    snapshot = parseTextResult(await call(client, "browser_snapshot"));
    const trigger = requireElement(snapshot, (item) => item.name === dialogCase.button, `${dialogCase.type} trigger`);
    let actionSettled = false;
    let settledActionError = null;
    const actionPromise = call(client, "browser_act", { action: "click", ref: trigger.ref })
      .then(
        () => {
          actionSettled = true;
          return null;
        },
        (error) => {
          actionSettled = true;
          settledActionError = error;
          return error;
        },
      );
    const dialogState = await waitForValue(
      async () => {
        const value = parseTextResult(await call(client, "browser_dialogs"));
        if (settledActionError) throw settledActionError;
        if (actionSettled && !value.dialogs.some((dialog) => (dialog.type || dialog.kind || dialog.dialogType) === dialogCase.type)) {
          const observation = parseTextResult(await call(client, "browser_observe", { tabId: controlTabId, maxCharacters: 4_000 }));
          const resultLine = String(observation.text || "").split(/\r?\n/).find((line) => line.startsWith(`${dialogCase.button.replace("Open ", "").replace(/^./, (letter) => letter.toUpperCase())}:`));
          throw new Error(`${dialogCase.type} trigger completed without opening a managed dialog${resultLine ? ` (${resultLine})` : ""}.`);
        }
        return value;
      },
      (value) => value.dialogs.some((dialog) => (dialog.type || dialog.kind || dialog.dialogType) === dialogCase.type),
      `${dialogCase.type} dialog`,
    );
    const pendingDialog = dialogState.dialogs.find((dialog) => (dialog.type || dialog.kind || dialog.dialogType) === dialogCase.type);
    const pendingDialogId = dialogId(pendingDialog);
    if (!pendingDialogId) throw new Error(`${dialogCase.type} dialog had no ID.`);
    const handled = parseTextResult(await call(client, "browser_dialog_respond", {
      dialogId: pendingDialogId,
      accept: dialogCase.accept,
      promptText: dialogCase.promptText,
    }));
    if (!handled.handled) throw new Error(`${dialogCase.type} dialog was not handled.`);
    const actionError = await actionPromise;
    if (actionError) throw actionError;
    await waitForPageText(client, dialogCase.result);
  }

  const assistance = parseTextResult(await call(client, "browser_request_assistance", {
    kind: "manual_action",
    title: "Advanced smoke handoff",
    detail: "Verify tab-scoped human assistance lifecycle.",
    tabId: controlTabId,
  }));
  pendingAssistanceId = assistanceId(assistance);
  if (!pendingAssistanceId) throw new Error("browser_request_assistance returned no assistance ID.");
  const assistanceStatus = parseTextResult(await call(client, "browser_assistance_status", { assistanceId: pendingAssistanceId }));
  if (!assistanceStatus || assistanceId(assistanceStatus) !== pendingAssistanceId) {
    throw new Error("browser_assistance_status did not return the pending request.");
  }
  const completedAssistance = parseTextResult(await call(client, "browser_assistance_complete", {
    assistanceId: pendingAssistanceId,
    outcome: "completed",
    note: "Advanced smoke completed the simulated handoff.",
    userConfirmed: true,
  }));
  if (assistanceId(completedAssistance) !== pendingAssistanceId) throw new Error("Completed assistance ID did not match.");
  pendingAssistanceId = undefined;
  await call(client, "browser_resume");

  console.log(JSON.stringify({
    advancedToolsPresent: requiredTools.length,
    normalUsernameAllowed: true,
    sensitiveSubmitBlocked: true,
    trustedPointerActions: ["check", "uncheck", "hover", "double_click", "click"],
    screenshot,
    popupOpenerPreserved: true,
    tabsManaged: true,
    dialogsHandled: dialogCases.map((item) => item.type),
    visiblePdfCaptured: true,
    visiblePdfSavedWithoutRerequest: true,
    visiblePdfDocumentImported: true,
    assistanceLifecycleCompleted: true,
  }, null, 2));
} finally {
  if (pendingAssistanceId) {
    await client.callTool({
      name: "browser_assistance_complete",
      arguments: { assistanceId: pendingAssistanceId, outcome: "unable", note: "Smoke cleanup", userConfirmed: true },
    }).catch(() => undefined);
  }
  if (popupTabId) {
    await client.callTool({ name: "browser_tab_close", arguments: { tabId: popupTabId, force: true } }).catch(() => undefined);
  }
  if (pdfTabId) {
    await client.callTool({ name: "browser_tab_close", arguments: { tabId: pdfTabId, force: true } }).catch(() => undefined);
  }
  if (controlTabId) {
    await client.callTool({ name: "browser_tab_close", arguments: { tabId: controlTabId, force: true } }).catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await stopProcessTree(desktopProcess);
  await new Promise((resolve) => fixtureServer.close(resolve));
  await removeTestProfile();
}
