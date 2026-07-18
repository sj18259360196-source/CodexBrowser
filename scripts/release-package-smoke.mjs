import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

const projectRoot = path.resolve(".");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseName = `CodexBrowser-${packageJson.version}-win-x64`;
const archivePath = path.join(projectRoot, "release", `${releaseName}.zip`);
const testRoot = path.join(projectRoot, ".runtime", `release-package-smoke-${randomUUID()}`);
const extractedRoot = path.join(testRoot, releaseName);
const profileDir = path.join(projectRoot, ".runtime", "edge-profiles", `phase1-release-${randomUUID()}`);
const profileLock = path.join(profileDir, ".codex-browser-profile.lock");
const localAppData = path.join(projectRoot, ".runtime", `release-localappdata-${randomUUID()}`);
const pipeName = `codex-browser-release-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;

function rawCall(method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    const id = randomUUID();
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out calling ${method}.`)); }, timeoutMs);
    const finish = (callback) => { clearTimeout(timer); socket.destroy(); callback(); };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.once("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      finish(() => response.ok ? resolve(response.result) : reject(new Error(response.error?.message || "Broker call failed.")));
    });
  });
}

function probePipe(timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const relative = path.relative(path.join(projectRoot, ".runtime"), testRoot);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to use an unbounded release smoke directory.");

await access(archivePath);
await mkdir(testRoot, { recursive: true });
const extraction = spawnSync("tar.exe", ["-xf", archivePath, "-C", testRoot], { stdio: "inherit", windowsHide: true });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error("The formal release archive could not be extracted.");

const manifest = JSON.parse(await readFile(path.join(extractedRoot, "release-manifest.json"), "utf8"));
if (manifest.version !== packageJson.version || manifest.defaultRuntime !== "external-edge") {
  throw new Error("The release manifest does not match the expected version or default runtime.");
}

const mcpEntry = path.join(extractedRoot, "dist", "mcp", "index.mjs");
const brokerEntry = path.join(extractedRoot, "dist", "browser", "edge-broker.mjs");
await Promise.all([access(mcpEntry), access(brokerEntry)]);
await mkdir(profileDir, { recursive: true });
await mkdir(localAppData, { recursive: true });
const env = { ...process.env };
delete env.CODEX_BROWSER_RUNTIME;
Object.assign(env, {
  LOCALAPPDATA: localAppData,
  CODEX_BROWSER_PROJECT_ROOT: extractedRoot,
  CODEX_BROWSER_EDGE_RUNTIME_ROOT: path.join(projectRoot, ".runtime"),
  CODEX_BROWSER_EDGE_PROFILE_DIR: profileDir,
  CODEX_BROWSER_PIPE_NAME: pipeName,
  CODEX_BROWSER_TEST_MODE: "1",
  CODEX_BROWSER_AUTOSTART_TEST: "1",
  CODEX_BROWSER_EDGE_DEBUG: "1",
});

const broker = spawn(process.execPath, [brokerEntry], {
  cwd: extractedRoot,
  env,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let brokerError = "";
broker.stderr.setEncoding("utf8");
broker.stderr.on("data", (chunk) => {
  brokerError = `${brokerError}${chunk}`.slice(-4_000);
  process.stderr.write(chunk);
});
let primaryError;
try {
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline && !await probePipe()) {
    if (broker.exitCode !== null) throw new Error(`The packaged broker exited before opening its pipe. ${brokerError}`.trim());
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!await probePipe()) throw new Error(`The packaged broker did not open its pipe. ${brokerError}`.trim());
  const capabilities = await rawCall("browser.capabilities");
  const status = await rawCall("browser.status");
  if (capabilities.runtime !== "external-edge") throw new Error("The formal package did not default to external-edge.");
  if (status.runtimeInfo?.connection !== "ready") throw new Error("The formal package did not reach a ready Edge runtime.");
  const serialized = JSON.stringify({ capabilities, status });
  if (serialized.includes(profileDir) || /devtools|websocket|127\.0\.0\.1:\d+/i.test(serialized)) {
    throw new Error("The formal package exposed a profile path or CDP endpoint.");
  }
  console.log(JSON.stringify({
    version: manifest.version,
    runtime: capabilities.runtime,
    connection: status.runtimeInfo.connection,
    edgeVersion: status.runtimeInfo.browserVersion,
    isolatedProfile: true,
    packagedBroker: true,
    packagedMcpPresent: true,
  }, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
} catch (error) {
  primaryError = error;
  console.error(`[release-package-smoke] primary: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await rawCall("runtime.shutdown").catch(() => undefined);
  const shutdownDeadline = Date.now() + 45_000;
  while (Date.now() < shutdownDeadline) {
    const pipeOpen = await probePipe();
    const lockPresent = await access(profileLock).then(() => true, () => false);
    if (!pipeOpen && !lockPresent && broker.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (await probePipe()) throw new Error("The packaged broker pipe remained open after shutdown.");
  if (await access(profileLock).then(() => true, () => false)) throw new Error(`The packaged Edge profile lock remained after shutdown. ${brokerError}`.trim());
  if (broker.exitCode === null) {
    broker.kill();
    throw new Error(`The packaged broker process remained after shutdown. ${brokerError}`.trim());
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const removeOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
  await rm(profileDir, removeOptions);
  await rm(localAppData, removeOptions);
  await rm(testRoot, removeOptions);
  if (await Promise.all([testRoot, profileDir, localAppData].map((target) => access(target).then(() => true, () => false))).then((values) => values.some(Boolean))) {
    throw new Error("A release package smoke directory remained after cleanup.");
  }
}
if (primaryError) throw primaryError;
