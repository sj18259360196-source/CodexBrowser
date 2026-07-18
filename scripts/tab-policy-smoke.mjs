import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  projectRoot,
  sleep,
  startIsolatedElectronSmoke,
} from "./lib/isolated-electron-smoke.mjs";

const fixturePath = path.join(projectRoot, "src", "renderer", "tab-policy-test.html");
const fixtureBody = await readFile(fixturePath);
const sensitiveFixtureValue = "fixture-only-sensitive-value";
const backgroundAuthFixtureBody = Buffer.from(`<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Background authentication boundary</title></head>
  <body>
    <main>
      <h1>Complete multi-factor verification</h1>
      <form>
        <label>Password <input type="password" autocomplete="current-password"></label>
        <label>Verification code <input type="text" autocomplete="one-time-code"></label>
        <label>CAPTCHA <input type="text" name="captcha"></label>
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`);

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

function parseErrorResult(result, toolName) {
  if (!result.isError) throw new Error(`${toolName} unexpectedly succeeded.`);
  const error = parseTextResult(result);
  if (typeof error.error !== "string") throw new Error(`${toolName} returned no typed MCP error.`);
  return error;
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

function publicTabId(tab) {
  return tab?.tabId || tab?.id;
}

function requireTab(tabsResult, expectedTabId) {
  const tab = tabsResult.tabs?.find((candidate) => publicTabId(candidate) === expectedTabId);
  if (!tab) throw new Error(`browser_tabs did not contain tab ${expectedTabId}.`);
  return tab;
}

async function waitForTabState(client, tabId, expectedState, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = parseTextResult(await call(client, "browser_tabs"));
    if (requireTab(latest, tabId).state === expectedState) return latest;
    await sleep(80);
  }
  const actualState = latest ? requireTab(latest, tabId).state : "unknown";
  throw new Error(`Tab ${tabId} remained ${actualState} instead of entering ${expectedState}.`);
}

function assertNoSensitiveFixtureValue(value, label) {
  if (JSON.stringify(value).includes(sensitiveFixtureValue)) {
    throw new Error(`${label} exposed the fixture's sensitive field value.`);
  }
}

async function waitForPromise(promise, label, timeoutMs = 4_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function respondHtml(response, body = fixtureBody) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  response.end(body);
}

function respondAfter(response, milliseconds, callback) {
  const timeout = setTimeout(() => {
    if (!response.destroyed) callback();
  }, milliseconds);
  response.once("close", () => clearTimeout(timeout));
}

let authCompletionSignalled = false;
let queuedAfterWaitingRequests = 0;
let queuedAfterStopRequests = 0;
let resolveDelayedAuthStarted;
let resolveSlowStopStarted;
const delayedAuthStarted = new Promise((resolve) => {
  resolveDelayedAuthStarted = resolve;
});
const slowStopStarted = new Promise((resolve) => {
  resolveSlowStopStarted = resolve;
});

const fixtureServer = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (url.pathname === "/__tab_policy_signal") {
    if (request.method === "POST") {
      authCompletionSignalled = true;
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const body = Buffer.from(JSON.stringify({ complete: authCompletionSignalled }));
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
    response.end(body);
    return;
  }

  if (url.pathname === "/auth-delayed") {
    resolveDelayedAuthStarted();
    respondAfter(response, 650, () => respondHtml(response));
    return;
  }

  if (url.pathname === "/slow-stop") {
    resolveSlowStopStarted();
    respondAfter(response, 8_000, () => respondHtml(response));
    return;
  }

  if (url.pathname === "/queued-after-waiting") {
    queuedAfterWaitingRequests += 1;
    respondHtml(response);
    return;
  }

  if (url.pathname === "/queued-after-stop") {
    queuedAfterStopRequests += 1;
    respondHtml(response);
    return;
  }

  if (url.pathname === "/background-auth") {
    respondHtml(response, backgroundAuthFixtureBody);
    return;
  }

  if (url.pathname === "/ordinary" || url.pathname === "/ordinary-next") {
    respondHtml(response);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const address = fixtureServer.address();
if (!address || typeof address === "string") throw new Error("Tab policy fixture did not expose a TCP port.");
const fixtureOrigin = `http://127.0.0.1:${address.port}`;

let runtime;

try {
  runtime = await startIsolatedElectronSmoke({
    suiteName: "tab-policy-smoke",
    clientName: "codex-browser-tab-policy-smoke",
  });
  const { client } = runtime;

  const initialTabs = parseTextResult(await call(client, "browser_tabs"));
  const authTabId = publicTabId(initialTabs.tabs?.find((tab) => tab.active)) || initialTabs.activeTabId;
  if (!authTabId) throw new Error("browser_tabs returned no active tab for the policy fixture.");

  const authNavigationPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/auth-delayed`, tabId: authTabId },
  });
  await waitForPromise(delayedAuthStarted, "the delayed authentication request");
  const queuedAfterWaitingPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/queued-after-waiting`, tabId: authTabId },
  });

  const [authNavigationResult, queuedAfterWaitingResult] = await Promise.all([
    authNavigationPromise,
    queuedAfterWaitingPromise,
  ]);
  if (authNavigationResult.isError) {
    throw new Error(`Authentication navigation failed: ${errorText(authNavigationResult)}`);
  }
  const authNavigation = parseTextResult(authNavigationResult);
  if (authNavigation.authPrompt?.tabId !== authTabId) {
    throw new Error("Sensitive login navigation did not create a tab-scoped authorization prompt.");
  }
  const queuedWaitingError = parseErrorResult(queuedAfterWaitingResult, "queued waiting-tab navigation");
  if (queuedWaitingError.error !== "TAB_WAITING_USER") {
    throw new Error(`Queued waiting-tab navigation returned ${queuedWaitingError.error} instead of TAB_WAITING_USER.`);
  }
  if (queuedAfterWaitingRequests !== 0) {
    throw new Error("A queued mutation reached the fixture after its tab entered WAITING_USER.");
  }

  const waitingSnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: authTabId }));
  const sensitiveInput = requireElement(
    waitingSnapshot,
    (element) => element.type === "password",
    "the password input on the waiting tab",
  );
  const sensitiveSubmit = requireElement(
    waitingSnapshot,
    (element) => element.role === "button" && element.sensitive,
    "the sensitive login submit action",
  );
  if (!sensitiveInput.sensitive || sensitiveInput.name !== "Sensitive input" || sensitiveInput.value !== undefined) {
    throw new Error("The waiting-tab password input was not returned with a fixed redacted identity.");
  }
  if (sensitiveSubmit.name !== "Sensitive action") {
    throw new Error("The login submit button was not returned with a fixed redacted identity.");
  }

  const waitingObservation = parseTextResult(await call(client, "browser_observe", {
    tabId: authTabId,
    maxCharacters: 8_000,
  }));
  const waitingStatus = parseTextResult(await call(client, "browser_status"));
  const waitingTabs = parseTextResult(await call(client, "browser_tabs"));
  assertNoSensitiveFixtureValue(waitingSnapshot, "browser_snapshot");
  assertNoSensitiveFixtureValue(waitingObservation, "browser_observe");
  assertNoSensitiveFixtureValue(waitingStatus, "browser_status");
  assertNoSensitiveFixtureValue(waitingTabs, "browser_tabs");
  if (requireTab(waitingTabs, authTabId).state !== "WAITING_USER") {
    throw new Error("The authentication tab did not enter WAITING_USER.");
  }

  const blockedNavigate = await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/ordinary`, tabId: authTabId },
  });
  const blockedNavigateError = parseErrorResult(blockedNavigate, "waiting-tab navigation");
  if (blockedNavigateError.error !== "TAB_WAITING_USER") {
    throw new Error(`Waiting-tab navigation returned ${blockedNavigateError.error} instead of TAB_WAITING_USER.`);
  }
  const blockedAction = await client.callTool({
    name: "browser_act",
    arguments: {
      action: "click",
      ref: sensitiveSubmit.ref,
      revision: waitingSnapshot.revision,
      tabId: authTabId,
    },
  });
  const blockedActionError = parseErrorResult(blockedAction, "waiting-tab page action");
  if (blockedActionError.error !== "TAB_WAITING_USER") {
    throw new Error(`Waiting-tab action returned ${blockedActionError.error} instead of TAB_WAITING_USER.`);
  }

  const ordinaryCreated = parseTextResult(await call(client, "browser_tab_new", {
    url: `${fixtureOrigin}/ordinary`,
    activate: true,
  }));
  const ordinaryTabId = ordinaryCreated.createdTabId || ordinaryCreated.activeTabId;
  if (!ordinaryTabId || ordinaryTabId === authTabId) {
    throw new Error("browser_tab_new did not create an independent ordinary tab.");
  }
  const ordinaryReady = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Ordinary tab workspace",
    timeoutMs: 5_000,
    tabId: ordinaryTabId,
  }));
  if (!ordinaryReady.satisfied) throw new Error("The ordinary tab did not finish loading.");

  let ordinarySnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: ordinaryTabId }));
  const ordinaryInput = requireElement(
    ordinarySnapshot,
    (element) => element.name === "Research query",
    "the ordinary research input",
  );
  const ordinaryAction = requireElement(
    ordinarySnapshot,
    (element) => element.name === "Run ordinary action",
    "the ordinary action button",
  );
  await call(client, "browser_act", {
    action: "fill",
    ref: ordinaryInput.ref,
    text: "independent-tab",
    revision: ordinarySnapshot.revision,
    tabId: ordinaryTabId,
  });
  ordinarySnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: ordinaryTabId }));
  const currentOrdinaryAction = requireElement(
    ordinarySnapshot,
    (element) => element.name === "Run ordinary action",
    "the refreshed ordinary action button",
  );
  await call(client, "browser_act", {
    action: "click",
    ref: currentOrdinaryAction.ref,
    revision: ordinarySnapshot.revision,
    tabId: ordinaryTabId,
  });
  const ordinaryActionResult = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Ordinary action: independent-tab",
    timeoutMs: 3_000,
    tabId: ordinaryTabId,
  }));
  if (!ordinaryActionResult.satisfied) throw new Error("The independent tab action did not complete.");
  await call(client, "browser_navigate", {
    url: `${fixtureOrigin}/ordinary-next`,
    tabId: ordinaryTabId,
  });
  const ordinaryNext = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Ordinary tab next page",
    timeoutMs: 3_000,
    tabId: ordinaryTabId,
  }));
  if (!ordinaryNext.satisfied) throw new Error("The independent tab navigation did not complete.");
  const crossTabState = parseTextResult(await call(client, "browser_tabs"));
  if (requireTab(crossTabState, authTabId).state !== "WAITING_USER") {
    throw new Error("Ordinary-tab work incorrectly resumed the blocked authentication tab.");
  }
  if (requireTab(crossTabState, ordinaryTabId).state !== "READY") {
    throw new Error("The independent ordinary tab did not remain READY.");
  }

  const failedVerification = parseTextResult(await call(client, "auth_complete", { tabId: authTabId, userConfirmed: true }));
  if (failedVerification.status !== "attention") {
    throw new Error("auth_complete did not report attention while the login form remained visible.");
  }
  const failedVerificationTabs = parseTextResult(await call(client, "browser_tabs"));
  if (requireTab(failedVerificationTabs, authTabId).state !== "WAITING_USER") {
    throw new Error("Failed authentication verification did not return the tab to WAITING_USER.");
  }
  const stillBlocked = await client.callTool({
    name: "browser_reload",
    arguments: { tabId: authTabId },
  });
  if (parseErrorResult(stillBlocked, "post-verification waiting-tab reload").error !== "TAB_WAITING_USER") {
    throw new Error("The tab resumed mutations after a failed auth_complete verification.");
  }

  const signalResponse = await fetch(`${fixtureOrigin}/__tab_policy_signal`, { method: "POST" });
  if (!signalResponse.ok) throw new Error("The local test service did not accept the completion signal.");
  const completionVisible = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Visible completion evidence: confirmed by the local test service",
    timeoutMs: 5_000,
    tabId: authTabId,
  }));
  if (!completionVisible.satisfied) throw new Error("The authentication page did not expose completion evidence.");
  const completionObservation = parseTextResult(await call(client, "browser_observe", { tabId: authTabId }));
  assertNoSensitiveFixtureValue(completionObservation, "post-completion browser_observe");
  if (!completionObservation.text.includes("Visible completion evidence")) {
    throw new Error("The completion evidence was not available through redacted observation.");
  }

  const successfulVerification = parseTextResult(await call(client, "auth_complete", { tabId: authTabId, userConfirmed: true }));
  if (successfulVerification.status !== "healthy") {
    throw new Error("auth_complete did not verify the page after non-sensitive completion evidence appeared.");
  }
  const resumedTabs = parseTextResult(await call(client, "browser_tabs"));
  if (requireTab(resumedTabs, authTabId).state !== "READY") {
    throw new Error("The verified authentication tab did not return to READY.");
  }

  let resumedSnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: authTabId }));
  const resumedInput = requireElement(
    resumedSnapshot,
    (element) => element.name === "Post-verification note",
    "the post-verification input",
  );
  await call(client, "browser_act", {
    action: "fill",
    ref: resumedInput.ref,
    text: "accepted",
    revision: resumedSnapshot.revision,
    tabId: authTabId,
  });
  resumedSnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: authTabId }));
  const resumedAction = requireElement(
    resumedSnapshot,
    (element) => element.name === "Record verified note",
    "the post-verification action",
  );
  await call(client, "browser_act", {
    action: "click",
    ref: resumedAction.ref,
    revision: resumedSnapshot.revision,
    tabId: authTabId,
  });
  const resumedMutation = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Mutation after verification: accepted",
    timeoutMs: 3_000,
    tabId: authTabId,
  }));
  if (!resumedMutation.satisfied) throw new Error("The verified tab did not accept a new mutation.");

  const selectedOrdinary = parseTextResult(await call(client, "browser_tab_select", { tabId: ordinaryTabId }));
  if (selectedOrdinary.activeTabId !== ordinaryTabId) {
    throw new Error("The ordinary tab could not be selected before the background authentication check.");
  }
  const backgroundCreated = parseTextResult(await call(client, "browser_tab_new", {
    url: `${fixtureOrigin}/background-auth`,
    activate: false,
  }));
  const backgroundAuthTabId = backgroundCreated.createdTabId;
  if (!backgroundAuthTabId || backgroundAuthTabId === ordinaryTabId || backgroundAuthTabId === authTabId) {
    throw new Error("browser_tab_new did not create an independent background authentication tab.");
  }
  if (backgroundCreated.activeTabId !== ordinaryTabId) {
    throw new Error("Creating the background authentication tab unexpectedly changed the active tab.");
  }

  const backgroundWaitingTabs = await waitForTabState(client, backgroundAuthTabId, "WAITING_USER");
  if (backgroundWaitingTabs.activeTabId !== ordinaryTabId) {
    throw new Error("Automatic authentication detection activated the background tab.");
  }

  let ordinaryBackgroundSnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: ordinaryTabId }));
  const ordinaryBackgroundInput = requireElement(
    ordinaryBackgroundSnapshot,
    (element) => element.name === "Research query",
    "the foreground research input during background authentication",
  );
  await call(client, "browser_act", {
    action: "fill",
    ref: ordinaryBackgroundInput.ref,
    text: "background-independent",
    revision: ordinaryBackgroundSnapshot.revision,
    tabId: ordinaryTabId,
  });
  ordinaryBackgroundSnapshot = parseTextResult(await call(client, "browser_snapshot", { tabId: ordinaryTabId }));
  const ordinaryBackgroundAction = requireElement(
    ordinaryBackgroundSnapshot,
    (element) => element.name === "Run ordinary action",
    "the foreground action during background authentication",
  );
  await call(client, "browser_act", {
    action: "click",
    ref: ordinaryBackgroundAction.ref,
    revision: ordinaryBackgroundSnapshot.revision,
    tabId: ordinaryTabId,
  });
  const foregroundMutation = parseTextResult(await call(client, "browser_wait", {
    condition: "text",
    value: "Ordinary action: background-independent",
    timeoutMs: 3_000,
    tabId: ordinaryTabId,
  }));
  if (!foregroundMutation.satisfied) {
    throw new Error("The foreground ordinary tab was frozen by background authentication.");
  }

  const blockedBackgroundReload = await client.callTool({
    name: "browser_reload",
    arguments: { tabId: backgroundAuthTabId },
  });
  if (parseErrorResult(blockedBackgroundReload, "background waiting-tab reload").error !== "TAB_WAITING_USER") {
    throw new Error("The background authentication tab accepted a reload while WAITING_USER.");
  }
  const blockedBackgroundAction = await client.callTool({
    name: "browser_act",
    arguments: {
      action: "click",
      ref: "background-auth-submit",
      tabId: backgroundAuthTabId,
    },
  });
  if (parseErrorResult(blockedBackgroundAction, "background waiting-tab action").error !== "TAB_WAITING_USER") {
    throw new Error("The background authentication tab accepted a page action while WAITING_USER.");
  }
  const blockedBackgroundNavigate = await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/ordinary`, tabId: backgroundAuthTabId },
  });
  if (parseErrorResult(blockedBackgroundNavigate, "background waiting-tab navigation").error !== "TAB_WAITING_USER") {
    throw new Error("The background authentication tab accepted a navigation while WAITING_USER.");
  }
  const postBackgroundPolicyTabs = parseTextResult(await call(client, "browser_tabs"));
  if (postBackgroundPolicyTabs.activeTabId !== ordinaryTabId) {
    throw new Error("Blocked background-tab operations changed the active tab.");
  }
  if (requireTab(postBackgroundPolicyTabs, backgroundAuthTabId).state !== "WAITING_USER") {
    throw new Error("Blocked operations moved the background authentication tab out of WAITING_USER.");
  }
  if (requireTab(postBackgroundPolicyTabs, ordinaryTabId).state !== "READY") {
    throw new Error("The foreground ordinary tab did not remain READY.");
  }

  const slowStopPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/slow-stop`, tabId: ordinaryTabId },
  });
  await waitForPromise(slowStopStarted, "the slow stop-cancellation request");
  const queuedAfterStopPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/queued-after-stop`, tabId: ordinaryTabId },
  });
  await sleep(120);
  await call(client, "browser_stop");
  const [stoppedActiveResult, stoppedQueuedResult] = await Promise.all([
    slowStopPromise,
    queuedAfterStopPromise,
  ]);
  if (parseErrorResult(stoppedActiveResult, "stopped active navigation").error !== "TASK_STOPPED") {
    throw new Error("browser_stop did not cancel the active navigation with TASK_STOPPED.");
  }
  if (parseErrorResult(stoppedQueuedResult, "stopped queued navigation").error !== "TASK_STOPPED") {
    throw new Error("browser_stop did not cancel the queued navigation with TASK_STOPPED.");
  }
  if (queuedAfterStopRequests !== 0) {
    throw new Error("A queued mutation reached the fixture after browser_stop.");
  }

  console.log(JSON.stringify({
    waitingUserMutationError: "TAB_WAITING_USER",
    waitingUserReadsRedacted: true,
    waitingUserQueuedMutationBlocked: true,
    independentTabContinued: true,
    failedVerificationStayedBlocked: true,
    verifiedResumeAcceptedMutation: true,
    backgroundAuthenticationBlockedIndependently: true,
    browserStopCancelledQueuedMutation: true,
  }, null, 2));
} finally {
  let disposeError;
  try {
    await runtime?.dispose();
  } catch (error) {
    disposeError = error;
  }
  fixtureServer.closeAllConnections?.();
  await new Promise((resolve) => fixtureServer.close(resolve));
  if (disposeError) throw disposeError;
}
