import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const runtimeRoot = path.join(projectRoot, ".runtime", "credential-smoke");
const runId = randomUUID();
const userDataDir = path.join(runtimeRoot, runId);
const pipeName = `codex-browser-credential-${runId}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;

const fixture = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>机构登录测试</title></head>
      <body>
        <main>
          <h1>高校统一身份认证</h1>
          <form>
            <label>用户名<input name="username" autocomplete="username"></label>
            <label>密码<input name="password" type="password" autocomplete="current-password"></label>
            <button type="button" id="login">登录</button>
          </form>
        </main>
        <script>
          document.getElementById("login").addEventListener("click", () => {
            const username = document.querySelector('[name="username"]').value;
            const password = document.querySelector('[name="password"]').value;
            if (username !== "fixture-user" || password !== "fixture-password") return;
            document.cookie = "credential_smoke=active; path=/; SameSite=Lax";
            document.querySelector("main").innerHTML = "<h1>授权完成</h1>";
            document.title = "高校授权已完成";
          });
        </script>
      </body>
    </html>`);
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pipeRequest(method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Pipe request timed out: ${method}`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline));
      if (!response.ok) reject(new Error(response.error?.message || `Pipe request failed: ${method}`));
      else resolve(response.result);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForPipe() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await pipeRequest("browser.status", {}, 1_000);
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError || new Error("Credential smoke desktop did not open its pipe.");
}

await fs.mkdir(userDataDir, { recursive: true });
await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Credential fixture did not bind a TCP port.");
const origin = `http://127.0.0.1:${address.port}`;
const env = {
  ...process.env,
  CODEX_BROWSER_PIPE_NAME: pipeName,
  CODEX_BROWSER_USER_DATA_DIR: userDataDir,
};

let desktop;
try {
  const seeded = await execFileAsync(electronPath, [path.join(projectRoot, "scripts", "credential-vault-fixture.cjs"), "seed", origin], {
    cwd: projectRoot,
    env,
    windowsHide: true,
  });
  const seedResult = JSON.parse(seeded.stdout || "{}");
  if (!seedResult.encrypted || seedResult.savedSiteCount !== 1) throw new Error("Credential fixture was not encrypted and restored.");
  const cookieFallback = await execFileAsync(electronPath, [path.join(projectRoot, "scripts", "credential-vault-fixture.cjs"), "cookie-fallback"], {
    cwd: projectRoot,
    env,
    windowsHide: true,
  });
  const cookieFallbackResult = JSON.parse(cookieFallback.stdout || "{}");
  if (!cookieFallbackResult.encryptedCookieFallback || cookieFallbackResult.backupSource !== "previous") {
    throw new Error("Encrypted session-cookie backup fallback did not pass.");
  }

  desktop = spawn(electronPath, ["."], {
    cwd: projectRoot,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  await waitForPipe();
  await pipeRequest("browser.navigate", { url: `${origin}/login` }, 20_000).catch(() => undefined);

  let status;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    status = await pipeRequest("browser.status");
    if (status.title === "高校授权已完成" && !status.authPrompt) break;
    await sleep(200);
  }
  if (status?.title !== "高校授权已完成") throw new Error("Saved login was not automatically filled and submitted.");
  if (status.credentialVault?.savedSiteCount !== 1) throw new Error("Credential vault status did not report the saved fixture site.");

  process.stdout.write(`${JSON.stringify({
    encryptedRoundTrip: true,
    cookieBackupFallback: true,
    autoFilled: true,
    autoSubmitted: true,
    authPromptCleared: !status.authPrompt,
    savedSiteCount: status.credentialVault.savedSiteCount,
  }, null, 2)}\n`);
} finally {
  if (desktop && !desktop.killed) desktop.kill();
  await new Promise((resolve) => fixture.close(resolve));
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedUserData = path.resolve(userDataDir);
  if (resolvedUserData.startsWith(`${resolvedRuntimeRoot}${path.sep}`)) {
    await sleep(500);
    await fs.rm(resolvedUserData, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => undefined);
  }
}
