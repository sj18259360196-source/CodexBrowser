import { createServer } from "node:http";
import { sleep, startIsolatedElectronSmoke } from "./lib/isolated-electron-smoke.mjs";

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

function respondAfter(response, milliseconds, callback) {
  setTimeout(() => {
    if (!response.destroyed) callback();
  }, milliseconds);
}

function deferredSignal() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForSignal(signal, message, timeoutMs = 5_000) {
  let timeout;
  try {
    await Promise.race([
      signal,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertStopRaceResult(label, result) {
  if (!result.isError) return;
  const failure = parseTextResult(result);
  if (failure.error !== "TASK_STOPPED") {
    throw new Error(`${label} returned ${String(failure.error || "an unknown error")} during stop.`);
  }
}

async function assertNoStoppedWorkRemains(client, label) {
  const [status, tabList] = await Promise.all([
    client.callTool({ name: "browser_status", arguments: {} }).then(parseTextResult),
    client.callTool({ name: "browser_tabs", arguments: {} }).then(parseTextResult),
  ]);
  const tabs = Array.isArray(tabList) ? tabList : tabList.tabs;
  if (!Array.isArray(tabs)) throw new Error(`${label} returned an invalid tab list.`);
  if (status.authPrompt) throw new Error(`${label} left an active authorization prompt.`);
  if (status.assistance && ["waiting_user", "verifying"].includes(status.assistance.status)) {
    throw new Error(`${label} left an active assistance request.`);
  }
  if (status.runtimeStatus === "waiting_user") throw new Error(`${label} left the runtime waiting for the user.`);
  if (tabs.some((tab) => tab.state === "WAITING_USER" || tab.state === "VERIFYING" || tab.attention)) {
    throw new Error(`${label} left a tab-scoped user boundary.`);
  }
  if (status.tasks.some((task) => ["queued", "running", "waiting_user"].includes(task.status))) {
    throw new Error(`${label} left active or queued task work.`);
  }
}

const delayedForbiddenStarted = deferredSignal();
const slowForbiddenProbeStarted = deferredSignal();

const fixture = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/forbidden-delayed") {
    delayedForbiddenStarted.resolve();
    respondAfter(response, 650, () => {
      response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Delayed forbidden</title><main>Access denied</main>");
    });
    return;
  }
  if (url.pathname === "/forbidden-probe-slow") {
    if (request.method === "HEAD") {
      slowForbiddenProbeStarted.resolve();
      respondAfter(response, 8_000, () => {
        response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        response.end();
      });
      return;
    }
    response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Forbidden probe</title><main>Access denied</main>");
    return;
  }
  if (url.pathname === "/forbidden") {
    response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Forbidden</title><main>Access denied</main>");
    return;
  }
  if (url.pathname === "/slow") {
    respondAfter(response, 8_000, () => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Slow page</title><main>Finished</main>");
    });
    return;
  }
  if (url.pathname === "/slow-short") {
    respondAfter(response, 450, () => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>First navigation</title><main>First</main>");
    });
    return;
  }
  if (url.pathname.startsWith("/download/")) {
    const fileName = url.pathname.split("/").pop() || "fixture.bin";
    const delay = fileName.startsWith("slow") ? 700 : fileName.startsWith("late") ? 1_200 : 0;
    respondAfter(response, delay, () => {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": "18",
      });
      response.end("codex-browser-test");
    });
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <title>Runtime fixture</title>
    <main>
      <a href="/download/fast.bin?sig=secret&token=hidden">Download PDF</a>
      <p>Runtime fixture ready</p>
    </main>`);
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Runtime fixture did not expose a TCP port.");
const fixtureOrigin = `http://127.0.0.1:${address.port}`;

let runtime;

try {
  runtime = await startIsolatedElectronSmoke({
    suiteName: "runtime-control-smoke",
    clientName: "codex-browser-runtime-smoke",
  });
  const { client } = runtime;
  await client.callTool({ name: "browser_resume", arguments: {} });
  await client.callTool({ name: "browser_stop", arguments: {} });

  const forbiddenNavigation = parseTextResult(await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/forbidden?token=must-not-leak` },
  }));
  if (forbiddenNavigation.authPrompt?.reason !== "forbidden") throw new Error("Main-frame 403 did not create a forbidden prompt.");
  if (JSON.stringify(forbiddenNavigation).includes("must-not-leak")) throw new Error("Navigation response leaked a sensitive query value.");
  const forbiddenHealth = parseTextResult(await client.callTool({ name: "session_check", arguments: {} }));
  if (forbiddenHealth.status !== "attention") throw new Error("A 403 resource was incorrectly reported healthy.");

  await client.callTool({ name: "browser_stop", arguments: {} });
  await client.callTool({ name: "browser_navigate", arguments: { url: `${fixtureOrigin}/` } });
  const delayedForbiddenNavigation = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/forbidden-delayed` },
  });
  await waitForSignal(
    delayedForbiddenStarted.promise,
    "The delayed main-frame 403 request did not reach the fixture.",
  );
  await client.callTool({ name: "browser_stop", arguments: {} });
  await delayedForbiddenNavigation;
  await sleep(900);
  await assertNoStoppedWorkRemains(client, "A delayed main-frame 403 after browser_stop");

  const slowProbeNavigation = parseTextResult(await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/forbidden-probe-slow` },
  }));
  if (slowProbeNavigation.authPrompt?.reason !== "forbidden") {
    throw new Error("The slow session probe fixture did not create a forbidden prompt.");
  }
  const sessionCheckRace = client.callTool({ name: "session_check", arguments: {} });
  await waitForSignal(
    slowForbiddenProbeStarted.promise,
    "session_check did not start its protected-resource probe.",
  );
  const assistanceRace = client.callTool({
    name: "browser_request_assistance",
    arguments: {
      kind: "manual_action",
      title: "Runtime stop race",
      detail: "Complete the visible test step.",
    },
  });
  await Promise.race([assistanceRace.then(() => undefined), sleep(50)]);
  const stopRace = client.callTool({ name: "browser_stop", arguments: {} });
  const [sessionCheckResult, assistanceResult, stopResult] = await Promise.all([
    sessionCheckRace,
    assistanceRace,
    stopRace,
  ]);
  assertStopRaceResult("session_check", sessionCheckResult);
  assertStopRaceResult("browser_request_assistance", assistanceResult);
  if (stopResult.isError) throw new Error("browser_stop failed during the control-boundary race.");
  await sleep(150);
  await assertNoStoppedWorkRemains(client, "Concurrent assistance and session checks stopped by the user");

  await client.callTool({ name: "browser_navigate", arguments: { url: `${fixtureOrigin}/` } });
  const slowNavigationPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/slow?sig=must-not-leak` },
  });
  await sleep(250);
  await client.callTool({ name: "browser_stop", arguments: {} });
  const stoppedNavigation = await slowNavigationPromise;
  if (!stoppedNavigation.isError) throw new Error("Stopping a slow navigation did not cancel its MCP call.");
  if (JSON.stringify(stoppedNavigation).includes("must-not-leak")) throw new Error("Stopped navigation error leaked a sensitive query value.");

  const [firstNavigation, secondNavigation] = await Promise.all([
    client.callTool({ name: "browser_navigate", arguments: { url: `${fixtureOrigin}/slow-short?sig=first-secret` } }),
    client.callTool({ name: "browser_navigate", arguments: { url: `${fixtureOrigin}/?token=second-secret` } }),
  ]);
  if (firstNavigation.isError || secondNavigation.isError) throw new Error("Queued navigation failed.");
  const queuedStatus = parseTextResult(await client.callTool({ name: "browser_status", arguments: {} }));
  if (queuedStatus.url !== `${fixtureOrigin}/`) throw new Error(`Unexpected final queued URL: ${queuedStatus.url}`);
  if (queuedStatus.tasks.some((task) => task.status === "running")) throw new Error("Queued navigation left a running task.");
  if (JSON.stringify(queuedStatus).includes("first-secret") || JSON.stringify(queuedStatus).includes("second-secret")) {
    throw new Error("Browser status leaked a sensitive query value.");
  }

  const observation = parseTextResult(await client.callTool({ name: "browser_observe", arguments: {} }));
  if (observation.links.some((link) => link.href.includes("?"))) throw new Error("Observation exposed link query parameters.");
  const candidates = parseTextResult(await client.callTool({ name: "paper_find_downloads", arguments: {} }));
  if (!candidates[0]?.id || candidates[0].url.includes("?")) throw new Error("Download candidates were not opaque and sanitized.");

  const [slowJob, fastJob] = await Promise.all([
    client.callTool({ name: "paper_download", arguments: { url: `${fixtureOrigin}/download/slow.bin?sig=slow-secret` } }),
    client.callTool({ name: "paper_download", arguments: { url: `${fixtureOrigin}/download/fast.bin?sig=fast-secret` } }),
  ]).then((results) => results.map(parseTextResult));

  let downloads = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    downloads = parseTextResult(await client.callTool({ name: "downloads_list", arguments: {} }));
    if (downloads.some((item) => item.id === slowJob.jobId) && downloads.some((item) => item.id === fastJob.jobId)) break;
    await sleep(200);
  }
  const slowDownload = downloads.find((item) => item.id === slowJob.jobId);
  const fastDownload = downloads.find((item) => item.id === fastJob.jobId);
  if (!slowDownload || !fastDownload || slowDownload.id === fastDownload.id) {
    throw new Error("Concurrent downloads were not linked to their distinct task IDs.");
  }
  if (slowDownload.url !== `${fixtureOrigin}/` || fastDownload.url !== `${fixtureOrigin}/`) {
    throw new Error("Download state exposed more than the source origin.");
  }

  const lateJob = parseTextResult(await client.callTool({
    name: "paper_download",
    arguments: { url: `${fixtureOrigin}/download/late.bin?sig=late-secret` },
  }));
  await client.callTool({ name: "browser_stop", arguments: {} });
  await sleep(1_800);
  downloads = parseTextResult(await client.callTool({ name: "downloads_list", arguments: {} }));
  if (downloads.some((item) => item.id === lateJob.jobId)) throw new Error("A stopped pending download started after cancellation.");

  console.log(JSON.stringify({
    forbiddenPromptPreserved: true,
    delayedForbiddenIgnoredAfterStop: true,
    stopClearedConcurrentUserBoundaries: true,
    slowNavigationStopped: true,
    queuedNavigationSerialized: true,
    sensitiveQueriesRedacted: true,
    opaqueDownloadCandidates: true,
    downloadJobsMatchedWithoutPathExposure: true,
    lateDownloadCancelled: true,
  }, null, 2));
} finally {
  let disposeError;
  try {
    await runtime?.dispose();
  } catch (error) {
    disposeError = error;
  }
  await new Promise((resolve) => fixture.close(resolve));
  if (disposeError) throw disposeError;
}
