import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createIsolatedElectronSmokeProfile,
  sleep,
  startIsolatedElectronSmoke,
} from "./lib/isolated-electron-smoke.mjs";

const suiteName = "blocked-state-restart";
const fixtureSecret = "RestartSecret-71Qx";
const pageTitleMarker = "RestartPageTitle-72Lm";
const assistanceTitleMarker = "RestartAssistanceTitle-73Np";
const assistanceDetailMarker = "RestartAssistanceDetail-74Rt";
const credentialUrlMarker = "RestartCredentialUrl-75Hs";
const forbiddenMarkers = [
  fixtureSecret,
  pageTitleMarker,
  assistanceTitleMarker,
  assistanceDetailMarker,
  credentialUrlMarker,
];

function parseTextResult(result, label) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error(`${label} returned no MCP text result.`);
  return JSON.parse(block.text);
}

function errorText(result) {
  const block = result.content?.find((item) => item.type === "text");
  return typeof block?.text === "string" ? block.text : "unknown MCP error";
}

async function call(client, name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) throw new Error(`${name} failed: ${errorText(result)}`);
  return parseTextResult(result, name);
}

async function expectError(client, name, arguments_, expectedError) {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded.`);
  const error = parseTextResult(result, `${name} error`);
  if (error.error !== expectedError) {
    throw new Error(`${name} returned ${error.error || "an untyped error"} instead of ${expectedError}.`);
  }
}

function publicTabId(tab) {
  return tab?.tabId || tab?.id;
}

function requireTab(tabs, tabId, label) {
  const tab = tabs.tabs?.find((candidate) => publicTabId(candidate) === tabId);
  if (!tab) throw new Error(`${label} was not restored with its original tab ID.`);
  return tab;
}

function assertNoFixtureMarkers(label, value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const exposed = forbiddenMarkers.find((marker) => serialized.includes(marker));
  if (exposed) throw new Error(`${label} exposed fixture-only sensitive data.`);
}

function assertSanitizedRuntimeState(state, { authTabId, assistanceTabId, credentialUrl }, label) {
  if (state.version !== 3) throw new Error(`${label} did not use runtime-state version 3.`);
  if (state.assistance !== null) throw new Error(`${label} persisted a full assistance object.`);
  assertNoFixtureMarkers(label, state);
  if (JSON.stringify(state).includes(credentialUrl)) {
    throw new Error(`${label} persisted the credential-bearing fixture URL.`);
  }

  const authBoundary = state.blockedTabs?.find((item) => item.tabId === authTabId && item.kind === "auth");
  const assistanceBoundary = state.blockedTabs?.find(
    (item) => item.tabId === assistanceTabId && item.kind === "assistance",
  );
  if (!authBoundary || !assistanceBoundary) {
    throw new Error(`${label} did not persist both tab-scoped control boundaries.`);
  }

  for (const boundary of state.blockedTabs || []) {
    const allowed = boundary.kind === "auth"
      ? new Set(["tabId", "kind", "authReason", "requestedAt"])
      : new Set(["tabId", "kind", "requestedAt"]);
    if (Object.keys(boundary).some((key) => !allowed.has(key))) {
      throw new Error(`${label} persisted non-whitelisted blocked-tab metadata.`);
    }
  }

  for (const tab of state.tabs || []) {
    if (tab.title === pageTitleMarker) throw new Error(`${label} persisted the document title.`);
    const parsed = new URL(tab.url);
    if (parsed.username || parsed.password) throw new Error(`${label} persisted URL credentials.`);
    if ([...parsed.searchParams.keys()].some((key) => /credential|password|secret|token/i.test(key))) {
      throw new Error(`${label} persisted a sensitive URL query parameter.`);
    }
  }
}

async function waitForRuntimeState(profileDir, predicate, label) {
  const statePath = path.join(profileDir, "state", "runtime-state.json");
  let lastState;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      lastState = JSON.parse(await readFile(statePath, "utf8"));
      if (predicate(lastState)) return lastState;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await sleep(100);
  }
  throw new Error(`${label} was not written to the isolated profile in time: ${JSON.stringify(lastState || {})}`);
}

const fixture = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  let body;
  if (url.pathname === "/login") {
    body = `<!doctype html>
      <html><head><meta charset="utf-8"><title>${pageTitleMarker}</title></head>
      <body>
        <main>
          <h1>Manual sign-in fixture</h1>
          <form>
            <input type="password" autocomplete="current-password" value="${fixtureSecret}">
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body></html>`;
  } else if (url.pathname === "/ordinary" || url.pathname === "/ordinary-next") {
    const message = url.pathname === "/ordinary-next"
      ? "Ordinary tab remained operational after restart"
      : "Ordinary restart fixture ready";
    body = `<!doctype html><html><head><meta charset="utf-8"><title>Ordinary fixture</title></head>
      <body><main><p>${message}</p></main></body></html>`;
  } else {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": bytes.length,
  });
  response.end(bytes);
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Restart fixture did not expose a TCP port.");
const fixtureOrigin = `http://127.0.0.1:${address.port}`;
const credentialUrl = `${fixtureOrigin}/login?credential=${credentialUrlMarker}&token=${fixtureSecret}`;

const profile = await createIsolatedElectronSmokeProfile({ suiteName });
let firstRuntime;
let secondRuntime;

try {
  firstRuntime = await startIsolatedElectronSmoke({
    suiteName,
    clientName: "codex-browser-blocked-restart-setup",
    profileDir: profile.profileDir,
  });
  const firstClient = firstRuntime.client;
  const initialTabs = await call(firstClient, "browser_tabs");
  const ordinaryTabId = publicTabId(initialTabs.tabs?.find((tab) => tab.active)) || initialTabs.activeTabId;
  if (!ordinaryTabId) throw new Error("The setup process returned no initial ordinary tab.");
  await call(firstClient, "browser_navigate", { url: `${fixtureOrigin}/ordinary`, tabId: ordinaryTabId });

  const authTab = await call(firstClient, "browser_tab_new", { url: "about:blank", activate: true });
  const authTabId = authTab.createdTabId || authTab.activeTabId;
  if (!authTabId) throw new Error("The setup process returned no authentication tab ID.");
  const authPrompt = await call(firstClient, "auth_request_login", { url: credentialUrl, tabId: authTabId });
  if (authPrompt.tabId !== authTabId) throw new Error("The authentication tab did not enter a user boundary.");
  assertNoFixtureMarkers("auth_request_login", authPrompt);

  const assistanceTab = await call(firstClient, "browser_tab_new", {
    url: `${fixtureOrigin}/ordinary`,
    activate: true,
  });
  const assistanceTabId = assistanceTab.createdTabId || assistanceTab.activeTabId;
  if (!assistanceTabId) throw new Error("The setup process returned no assistance tab ID.");
  const assistanceReady = await call(firstClient, "browser_wait", {
    condition: "text",
    value: "Ordinary restart fixture ready",
    timeoutMs: 5_000,
    tabId: assistanceTabId,
  });
  if (!assistanceReady.satisfied) throw new Error("The assistance fixture did not finish loading.");
  const assistance = await call(firstClient, "browser_request_assistance", {
    kind: "manual_action",
    title: `Restart assistance token=${assistanceTitleMarker}`,
    detail: `Complete the visible step; secret=${assistanceDetailMarker}`,
    tabId: assistanceTabId,
  });
  if (assistance.tabId !== assistanceTabId || assistance.status !== "waiting_user") {
    throw new Error("The assistance tab did not enter a user boundary.");
  }
  assertNoFixtureMarkers("browser_request_assistance", assistance);

  const firstState = await waitForRuntimeState(
    profile.profileDir,
    (state) => state.blockedTabs?.some((item) => item.tabId === authTabId && item.kind === "auth")
      && state.blockedTabs?.some((item) => item.tabId === assistanceTabId && item.kind === "assistance"),
    "The setup runtime state",
  );
  assertSanitizedRuntimeState(firstState, { authTabId, assistanceTabId, credentialUrl }, "Setup runtime state");

  const firstPipeName = firstRuntime.pipeName;
  await firstRuntime.dispose();
  firstRuntime = undefined;

  secondRuntime = await startIsolatedElectronSmoke({
    suiteName,
    clientName: "codex-browser-blocked-restart-verify",
    profileDir: profile.profileDir,
  });
  if (secondRuntime.pipeName === firstPipeName) {
    throw new Error("The restart reused its first private named pipe.");
  }

  const secondClient = secondRuntime.client;
  const restoredTabs = await call(secondClient, "browser_tabs");
  if (requireTab(restoredTabs, authTabId, "The authentication tab").state !== "WAITING_USER") {
    throw new Error("The authentication tab did not restart in WAITING_USER.");
  }
  if (requireTab(restoredTabs, assistanceTabId, "The assistance tab").state !== "WAITING_USER") {
    throw new Error("The assistance tab did not restart in WAITING_USER.");
  }

  await expectError(secondClient, "browser_reload", { tabId: authTabId }, "TAB_WAITING_USER");
  await expectError(secondClient, "browser_navigate", {
    url: `${fixtureOrigin}/ordinary-next`,
    tabId: assistanceTabId,
  }, "TAB_WAITING_USER");

  await call(secondClient, "browser_navigate", {
    url: `${fixtureOrigin}/ordinary-next`,
    tabId: ordinaryTabId,
  });
  const ordinaryReady = await call(secondClient, "browser_wait", {
    condition: "text",
    value: "Ordinary tab remained operational after restart",
    timeoutMs: 5_000,
    tabId: ordinaryTabId,
  });
  if (!ordinaryReady.satisfied) throw new Error("The ordinary tab could not work after restart.");

  const finalTabs = await call(secondClient, "browser_tabs");
  if (requireTab(finalTabs, authTabId, "The authentication tab").state !== "WAITING_USER") {
    throw new Error("Ordinary-tab work resumed the authentication tab.");
  }
  if (requireTab(finalTabs, assistanceTabId, "The assistance tab").state !== "WAITING_USER") {
    throw new Error("Ordinary-tab work resumed the assistance tab.");
  }
  if (requireTab(finalTabs, ordinaryTabId, "The ordinary tab").state !== "READY") {
    throw new Error("The ordinary tab did not remain READY after its work completed.");
  }
  assertNoFixtureMarkers("Restored browser_tabs", finalTabs);
  assertNoFixtureMarkers("Restored browser_status", await call(secondClient, "browser_status"));

  const secondState = await waitForRuntimeState(
    profile.profileDir,
    (state) => state.blockedTabs?.some((item) => item.tabId === authTabId && item.kind === "auth")
      && state.blockedTabs?.some((item) => item.tabId === assistanceTabId && item.kind === "assistance"),
    "The restored runtime state",
  );
  assertSanitizedRuntimeState(secondState, { authTabId, assistanceTabId, credentialUrl }, "Restored runtime state");

  console.log(JSON.stringify({
    reusedTemporaryProfile: true,
    uniquePrivatePipes: true,
    authBoundaryRestored: true,
    assistanceBoundaryRestored: true,
    blockedMutationsReturned: "TAB_WAITING_USER",
    ordinaryTabContinued: true,
    runtimeStateWhitelistOnly: true,
    fixtureSecretsAbsent: true,
  }, null, 2));
} finally {
  const cleanupErrors = [];
  await firstRuntime?.dispose().catch((error) => cleanupErrors.push(error));
  await secondRuntime?.dispose().catch((error) => cleanupErrors.push(error));
  await profile.dispose().catch((error) => cleanupErrors.push(error));
  fixture.closeAllConnections?.();
  await new Promise((resolve) => fixture.close(resolve));
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Blocked-state restart smoke cleanup failed.");
  }
}
