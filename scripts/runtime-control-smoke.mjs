import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = "C:\\Users\\22865\\plugins\\codex-browser\\scripts\\launch-mcp.mjs";
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
env.CODEX_BROWSER_PROJECT_ROOT = "A:\\Project\\CodexBrowser";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

const fixture = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1:5174");
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
  fixture.listen(5174, "127.0.0.1", resolve);
});

const client = new Client({ name: "codex-browser-runtime-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [launcher], env });

try {
  await client.connect(transport);
  await client.callTool({ name: "browser_resume", arguments: {} });
  await client.callTool({ name: "browser_stop", arguments: {} });

  const forbiddenNavigation = parseTextResult(await client.callTool({
    name: "browser_navigate",
    arguments: { url: "http://127.0.0.1:5174/forbidden?token=must-not-leak" },
  }));
  if (forbiddenNavigation.authPrompt?.reason !== "forbidden") throw new Error("Main-frame 403 did not create a forbidden prompt.");
  if (JSON.stringify(forbiddenNavigation).includes("must-not-leak")) throw new Error("Navigation response leaked a sensitive query value.");
  const forbiddenHealth = parseTextResult(await client.callTool({ name: "session_check", arguments: {} }));
  if (forbiddenHealth.status !== "attention") throw new Error("A 403 resource was incorrectly reported healthy.");

  await client.callTool({ name: "browser_navigate", arguments: { url: "http://127.0.0.1:5174/" } });
  const slowNavigationPromise = client.callTool({
    name: "browser_navigate",
    arguments: { url: "http://127.0.0.1:5174/slow?sig=must-not-leak" },
  });
  await sleep(250);
  await client.callTool({ name: "browser_stop", arguments: {} });
  const stoppedNavigation = await slowNavigationPromise;
  if (!stoppedNavigation.isError) throw new Error("Stopping a slow navigation did not cancel its MCP call.");
  if (JSON.stringify(stoppedNavigation).includes("must-not-leak")) throw new Error("Stopped navigation error leaked a sensitive query value.");

  const [firstNavigation, secondNavigation] = await Promise.all([
    client.callTool({ name: "browser_navigate", arguments: { url: "http://127.0.0.1:5174/slow-short?sig=first-secret" } }),
    client.callTool({ name: "browser_navigate", arguments: { url: "http://127.0.0.1:5174/?token=second-secret" } }),
  ]);
  if (firstNavigation.isError || secondNavigation.isError) throw new Error("Queued navigation failed.");
  const queuedStatus = parseTextResult(await client.callTool({ name: "browser_status", arguments: {} }));
  if (queuedStatus.url !== "http://127.0.0.1:5174/") throw new Error(`Unexpected final queued URL: ${queuedStatus.url}`);
  if (queuedStatus.tasks.some((task) => task.status === "running")) throw new Error("Queued navigation left a running task.");
  if (JSON.stringify(queuedStatus).includes("first-secret") || JSON.stringify(queuedStatus).includes("second-secret")) {
    throw new Error("Browser status leaked a sensitive query value.");
  }

  const observation = parseTextResult(await client.callTool({ name: "browser_observe", arguments: {} }));
  if (observation.links.some((link) => link.href.includes("?"))) throw new Error("Observation exposed link query parameters.");
  const candidates = parseTextResult(await client.callTool({ name: "paper_find_downloads", arguments: {} }));
  if (!candidates[0]?.id || candidates[0].url.includes("?")) throw new Error("Download candidates were not opaque and sanitized.");

  const [slowJob, fastJob] = await Promise.all([
    client.callTool({ name: "paper_download", arguments: { url: "http://127.0.0.1:5174/download/slow.bin?sig=slow-secret" } }),
    client.callTool({ name: "paper_download", arguments: { url: "http://127.0.0.1:5174/download/fast.bin?sig=fast-secret" } }),
  ]).then((results) => results.map(parseTextResult));

  let downloads = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    downloads = parseTextResult(await client.callTool({ name: "downloads_list", arguments: {} }));
    if (downloads.some((item) => item.id === slowJob.jobId) && downloads.some((item) => item.id === fastJob.jobId)) break;
    await sleep(200);
  }
  const slowDownload = downloads.find((item) => item.id === slowJob.jobId);
  const fastDownload = downloads.find((item) => item.id === fastJob.jobId);
  if (!slowDownload?.url.endsWith("/download/slow.bin")) throw new Error("Slow download was linked to the wrong task.");
  if (!fastDownload?.url.endsWith("/download/fast.bin")) throw new Error("Fast download was linked to the wrong task.");

  const lateJob = parseTextResult(await client.callTool({
    name: "paper_download",
    arguments: { url: "http://127.0.0.1:5174/download/late.bin?sig=late-secret" },
  }));
  await client.callTool({ name: "browser_stop", arguments: {} });
  await sleep(1_800);
  downloads = parseTextResult(await client.callTool({ name: "downloads_list", arguments: {} }));
  if (downloads.some((item) => item.id === lateJob.jobId)) throw new Error("A stopped pending download started after cancellation.");

  console.log(JSON.stringify({
    forbiddenPromptPreserved: true,
    slowNavigationStopped: true,
    queuedNavigationSerialized: true,
    sensitiveQueriesRedacted: true,
    opaqueDownloadCandidates: true,
    downloadJobsMatchedByUrl: true,
    lateDownloadCancelled: true,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixture.close(resolve));
}
