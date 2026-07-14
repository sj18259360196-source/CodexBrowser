const { app, session } = require("electron");
const { promises: fs } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const userDataDir = process.env.CODEX_BROWSER_USER_DATA_DIR;
const mode = process.argv[2];
const origin = process.argv[3];

if (!userDataDir) throw new Error("CODEX_BROWSER_USER_DATA_DIR is required.");
app.setPath("userData", path.resolve(userDataDir));

app.whenReady().then(async () => {
  const { PersistenceService } = require(path.join(projectRoot, "dist", "electron", "persistence-service.js"));
  const stateDir = path.join(app.getPath("userData"), "state");
  const service = new PersistenceService(stateDir);
  await service.initialize();
  await service.loadLoginCredentials();

  if (mode === "seed") {
    if (!origin) throw new Error("A fixture origin is required.");
    await service.saveLoginCredential(origin, "fixture-user", "fixture-password");
    const encrypted = await fs.readFile(path.join(stateDir, "login-credentials.enc"));
    const containsPlaintext = encrypted.includes(Buffer.from("fixture-user"))
      || encrypted.includes(Buffer.from("fixture-password"));
    if (containsPlaintext) throw new Error("Credential vault contains plaintext fixture values.");
    const reloaded = new PersistenceService(stateDir);
    const loaded = await reloaded.loadLoginCredentials();
    const credential = reloaded.getLoginCredential(origin);
    if (loaded !== 1 || !credential || credential.username !== "fixture-user" || credential.password !== "fixture-password") {
      throw new Error("Encrypted credential vault did not round-trip the fixture login.");
    }
    process.stdout.write(JSON.stringify({ encrypted: true, savedSiteCount: loaded }));
  } else if (mode === "clear") {
    await service.clearLoginCredentials();
    process.stdout.write(JSON.stringify({ cleared: true }));
  } else if (mode === "cookie-fallback") {
    const sourceSession = session.fromPartition(`persist:cookie-source-${Date.now()}`);
    await sourceSession.cookies.set({
      url: "https://cookie-smoke.test/",
      name: "session_id",
      value: "fixture-session-value",
      secure: true,
      httpOnly: true,
    });
    await service.persistSessionCookies(sourceSession);
    await service.persistSessionCookies(sourceSession);
    await fs.writeFile(path.join(stateDir, "session-cookies.enc"), Buffer.from("corrupted-current-backup"));

    const restoredSession = session.fromPartition(`persist:cookie-restored-${Date.now()}`);
    const result = await service.restoreSessionCookies(restoredSession);
    const restored = await restoredSession.cookies.get({ name: "session_id" });
    if (result.backupSource !== "previous" || result.restored !== 1 || restored.length !== 1) {
      throw new Error("Previous encrypted session-cookie backup was not restored after current-backup corruption.");
    }
    process.stdout.write(JSON.stringify({ encryptedCookieFallback: true, backupSource: result.backupSource }));
  } else {
    throw new Error("Expected seed, clear, or cookie-fallback mode.");
  }
}).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  app.exit(1);
});
