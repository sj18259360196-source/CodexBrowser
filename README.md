# Codex Browser

Codex Browser gives Codex a visible, persistent browser workspace. The normal runtime is an external Microsoft Edge with a dedicated Codex Browser profile; Electron remains the task, assistance, confirmation, download, document, storage, and settings control center.

Release status: version `1.1.0` adds the opt-in ordinary Edge extension relay and hardens Cloudflare/Turnstile and publisher-PDF compatibility while retaining the accepted 1.0.0 managed-Edge baseline. The 1.1.0 delta passed type, build, targeted regression, Edge smoke, renderer, package, and plugin validation.

The formal Windows x64 portable artifact is produced with `npm run package:win`. A standard per-user EXE installer is produced with `npm run package:installer`; it adds Start Menu and optional desktop shortcuts plus a normal uninstall entry. Both artifacts and their SHA-256 files are written under `release/`. They contain the production build, production dependencies, Electron control-center runtime, and unpacked ordinary-Edge relay extension. Node.js `22.13.0` or newer and Microsoft Edge `109` or newer are required. Release notes are in `docs/release/RELEASE_NOTES_1.1.0.md`.

## Start

```powershell
cd A:\Project\CodexBrowser
npm install
npm run build
npm start
```

You can also double-click `start-local.cmd`. When Codex calls an MCP browser tool and the local service is not running, the launcher starts the broker and managed Edge automatically. Concurrent startup requests converge on one private broker and one managed Edge instance.

With `CODEX_BROWSER_RUNTIME` unset, the runtime is `external-edge`. `edge-extension` is an opt-in ordinary-Edge relay that preserves the user's existing Profile. Microsoft Edge must already be installed; the project never downloads a browser. Startup failure is reported instead of silently falling back.

## Versions And Upgrades

- Application and MCP server: `1.1.0`
- MCP browser protocol: `1.2.0`
- Edge profile schema: `1`
- Runtime metadata schema: `3`
- Minimum supported Microsoft Edge major version: `109`
- Personal Codex plugin cachebuster: `0.1.0+codex.20260717163939`

Upgrades migrate only validated settings and sanitized security metadata. They do not rewrite the Edge profile, copy Chromium profile files, or migrate Cookie/password databases. Unknown profile schemas, malformed ownership, and failed metadata migrations preserve the original data and stop with a recovery message. Pending confirmations and temporary grants are in-memory safety capabilities and are invalid after broker/browser restart.

## Daily Use

- Codex can create and select tabs, navigate, observe pages, use bounded snapshots, operate ordinary controls, wait for changes, handle ordinary web dialogs, take redacted screenshots, download files, and import visible PDFs.
- Cloudflare, Turnstile, CAPTCHA, login, MFA, OTP, passkey, native permission, certificate, and file-selection boundaries pause only the affected tab and ask the user in the visible Edge window.
- Sending, publishing, deletion, purchase/payment, important account changes, upload, permissions, personal-information submission, and legal acceptance require a short-lived user confirmation. Codex cannot approve it.
- `browser_pause` pauses automation, `browser_resume` resumes an explicit pause, and `browser_stop` cancels pending work, assistance, and confirmations without replaying old actions.

The control center includes browser show/start, restart, and stop controls; runtime/profile status; assistance and confirmations; temporary-grant revocation; audit records; download/document state; and browser-data management.

## Profile And Data

External Edge uses one Codex Browser-owned long-lived `primary` profile below the current Windows user's local application-data area. The absolute path is intentionally not returned through MCP. Ownership metadata and an exclusive lock prevent duplicate use, and stale ownership is reclaimed only when both the recorded broker and browser processes are confirmed gone.

Edge itself manages persistent and session Cookie semantics, Local Storage, IndexedDB, Cache Storage, service workers, HTTP cache, site permissions, browser settings, passwords, and autofill. Codex Browser does not copy the Electron Chromium profile, Cookie database, password database, Local Storage, IndexedDB, or cache into Edge. The first external-Edge use therefore requires signing in again where needed.

Passwords and autofill remain entirely Edge-managed. Password, OTP, token, hidden, and file values are excluded from snapshots, screenshots, errors, logs, task records, and MCP. Cookie values, Cookie names, Authorization, Set-Cookie, signed query values, CDP endpoints, target/session IDs, and raw profile files are never returned to Codex.

The control center can, after explicit user confirmation:

- clear the current site's Cookie and site storage without affecting other origins;
- clear all Codex Browser browsing data and permissions while retaining downloads and imported documents;
- reset the dedicated Edge profile through a bounded archive-and-recreate flow.

Current-site permission reset is disabled because the tested Edge CDP version does not provide a reliable origin-scoped reset. Clearing all data resets permissions globally. External Edge uses normal browser session behavior. Optional encrypted, profile-bound, TTL-limited session recovery remains available only for the legacy Electron runtime and is disabled by default.

## Ordinary Edge Extension Relay

The optional `edge-extension` runtime operates tabs in the user's ordinary Edge Profile, retaining its existing site sessions, extensions, history, and browser reputation. It does not read or copy Profile files.

1. Open `edge://extensions` in ordinary Microsoft Edge and enable **Developer mode**.
2. Choose **Load unpacked** and select `extension/edge-relay` from this project. The control center can open this directory.
3. In Codex Browser runtime settings, click **Open pairing**. The window is valid for two minutes.
4. Click the extension icon in Edge and choose **Connect local Codex Browser**.
5. Select `edge-extension` as the preferred runtime and restart the browser runtime.

Pairing accepts only a `chrome-extension://` origin during the explicit short-lived window. The extension stores the random bearer token; Codex Browser stores only its SHA-256 hash. Communication is limited to `127.0.0.1`. The extension requests Edge's visible `debugger`, tabs, storage, downloads, and alarms permissions. All actions still pass through Codex Browser's sensitive-field, challenge, and high-risk confirmation policy.

## Legacy Fallback

The Electron page runtime is retained for controlled troubleshooting:

```powershell
$env:CODEX_BROWSER_RUNTIME = "electron-legacy"
npm start
```

Or run `npm run start:legacy`. The control center clearly labels this mode as legacy. It has its own Chromium profile and does not share or overwrite the external Edge profile. Login state is not expected to match. To return to the normal runtime, remove `CODEX_BROWSER_RUNTIME` and restart.

Compatibility aliases `edge-prototype` and `electron` are temporarily accepted with migration notices. New scripts and configuration should use `external-edge` and `electron-legacy`.

## MCP Tools

The 39-tool MCP surface includes:

- runtime, tab, navigation, observation, snapshot, action, wait, screenshot, dialog, pause/resume/stop, session, and assistance tools;
- read-only storage/profile status;
- confirmation status, deny-only MCP response, temporary-grant listing and revocation;
- managed download discovery and download state;
- PDF import, document list/read/search.

There is no raw CDP, arbitrary JavaScript, Cookie export, password listing, storage dump, policy bypass, or global allow-all tool.

## Settings

Persisted settings cover the preferred runtime, whether Edge remains running when the control center closes, session recovery, notifications, managed-download behavior, PDF import behavior, grants, storage clearing, and profile reset. Invalid settings fail back to safe defaults. There is no setting to disable sensitive-field protection or high-risk confirmation globally.

## Troubleshooting

- **Edge not installed or unsupported:** install/update Microsoft Edge, retry, or explicitly use `electron-legacy` for short-term troubleshooting.
- **Profile in use:** show the existing control center/managed Edge or close that dedicated Edge window. Codex Browser will not delete an uncertain lock or profile.
- **Connection or broker loss:** retry the browser operation. The broker reattaches the same managed Edge when possible or performs one bounded managed restart. Old snapshot revisions and refs become stale.
- **Edge relay is disconnected:** confirm ordinary Edge is running and the extension is enabled. If its popup reports an invalid pairing, reopen pairing in the control center and pair again.
- **Turnstile shows a generic failure:** reload once with automatic page translation and content-blocking extensions disabled. Codex Browser does not inspect or automate verification-provider iframes; complete the visible challenge manually.
- **Edge closed or crashed:** the next browser operation performs bounded recovery. Executing non-idempotent actions become `outcome_unknown` and are never replayed.
- **Storage/profile operation failed:** retry from the control center. Maintenance operations have longer bounded timeouts than page actions.
- **Legacy unavailable:** return to the default external Edge runtime by unsetting the environment variable.

Errors never include the private CDP endpoint, profile path, Cookie/token material, or signed URL query values.

## Uninstall And Data Removal

1. Stop active tasks and close the managed Edge from the control center.
2. Use **Clear all Codex Browser browsing data** to sign out of sites while retaining managed downloads and imported documents, or **Reset dedicated browser profile** for a fresh owned Edge profile.
3. Remove the application directory only after the browser and broker have exited.
4. Remove the Codex Browser product-data directory under the current Windows user's local application-data area only when the user also wants to delete the dedicated Edge profile and settings.
5. Managed downloads and the local document library are separate data sets and must be removed explicitly if they should not be retained.

Never delete a computed profile path while a lock exists, and never point cleanup at the user's ordinary Edge profile. The control center's bounded clear/reset flows are the preferred path.

## Known Limits

- Real login, MFA, passkey, certificate, file-picker, and browser permission flows remain user-operated and site-dependent; local fixtures verify detection, freezing, failed verification, and safe resume semantics.
- Cloudflare and Turnstile are detected and handed to the user, never solved. A public challenge demo may be unavailable or time out depending on the network and provider.
- Complex deeply nested iframes and unusual shadow DOM are best-effort beyond the supported main frame and one-level iframe boundary.
- The tested Edge CDP version cannot reliably clear permissions for one origin, so current-site permission reset is disabled; clear-all can reset permissions.
- In `edge-extension` mode, clearing the user's ordinary Edge browsing data/Profile and managed PDF download import are intentionally unavailable. Use Edge's own download UI or switch to `external-edge` for project-managed downloads.
- Personal-plugin source validation is independent from Codex CLI reinstall. On systems where the packaged WindowsApps `codex.exe` cannot be executed from PowerShell, restart/reload the Codex app to pick up the validated cachebuster.
- `electron-legacy` remains a troubleshooting fallback with separate profile/login state and no automatic failover.
- The supervised public-site matrix is intentionally read-only and credential-free. Real MFA, passkey, certificate, permission, and native file-picker completion was not recorded against a real account/device; those flows remain visible user actions backed by deterministic local coordination tests.

## Verify

```powershell
npm run typecheck
npm run build
npm run smoke:mcp
npm run smoke:actions
npm run smoke:runtime
npm run smoke:advanced
npm run smoke:edge
npm run smoke:edge-core
npm run smoke:challenge
npm run smoke:storage
npm run smoke:policy
npm run smoke:default-runtime
npm run smoke:stability
npm run smoke:broker-recovery
npm run smoke:endurance
npm run smoke:canary
npm run smoke:public-sites
npm audit --omit=dev
```

All deterministic Edge smokes use unique temporary profiles, local fixtures, and unique private transports. `smoke:default-runtime` leaves `CODEX_BROWSER_RUNTIME` unset and proves that MCP auto-starts `external-edge`, recovers after an owned Edge exit, and invalidates old refs. `smoke:stability` runs for 30 minutes by default. `smoke:endurance` runs for 60 minutes by default; shorter durations are development preflights only. `smoke:canary` uses synthetic secrets and fails on exposure. `smoke:public-sites` is a supervised, network-dependent, read-only compatibility check and does not replace local deterministic fixtures.

Renderer Playwright artifacts are stored under `output/playwright/`. Development history is indexed in `WORKLOG.md`; each implementation session has a detailed log under `docs/worklogs/`.
