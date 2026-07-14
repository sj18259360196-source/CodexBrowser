# Codex Browser

Codex Browser is a visible Electron/Chromium runtime for Codex. It keeps a persistent browser profile, pauses for human login or MFA, exposes browser and document tools over MCP, and extracts downloaded PDFs into page-located text.

## Current MVP

- Visible Chromium browser controlled through a local named pipe.
- Persistent `persist:codex-browser-primary` session for cookies, local storage, and SSO state.
- Windows-encrypted backup and restart recovery for session cookies that Chromium normally drops on exit.
- Optional Windows-encrypted login vault with exact-site autofill and automatic submission after one explicit save.
- Persistent task history, download records, last safe page, and automatic recovery of existing download files.
- Active session-health checks and verified authorization completion instead of blindly dismissing login prompts.
- Referenced interactive snapshots, safe element actions, and condition-based waits.
- Login, password, MFA, captcha, 401/403, and stalled-page alerts.
- User pause, resume, stop, and manual takeover controls.
- Download progress and automatic PDF ingestion.
- Local PDF list, page reading, and full-text search.
- Codex personal plugin with browser and paper-research skills.
- General browser contracts kept separate from paper-specific tools.

## Run

```powershell
cd A:\Project\CodexBrowser
npm install
npm run build
npm start
```

The desktop can also be launched by double-clicking `start-local.cmd` in the project root, or by running `scripts\start-desktop.cmd`. The MCP server will attempt to start the desktop automatically when Codex calls a browser tool.

For renderer-only layout development:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173` for the visual preview. The local authentication fixture is available at `http://127.0.0.1:5173/auth-test.html`.
The web preview does not have Electron's browser bridge, so desktop-only controls are visibly disabled. Use `npm start` for the functional browser.

## Saved Login

Electron keeps site cookies but does not include Chrome's password manager. When a supported login form appears, fill the username and password once and click `保存并登录` in the Codex Browser authorization bar. The credentials are encrypted for the current Windows user with Electron `safeStorage`, scoped to the exact secure login origin, and automatically filled and submitted on later visits.

Codex Browser does not auto-submit pages that show a captcha or multi-factor verification. Repeated failed submissions are throttled for five minutes. Use the key button in the session bar to clear all saved logins.

## Verify

```powershell
npm run typecheck
npm run build
npm run smoke:mcp
npm run smoke:actions
npm run smoke:runtime
```

The smoke test starts the plugin MCP launcher, lists its tools, and calls `browser_status` through the real stdio MCP transport.

## MCP Tools

- `browser_capabilities`, `browser_status`, `session_check`
- `browser_navigate`, `browser_observe`
- `browser_snapshot`, `browser_act`, `browser_wait`
- `browser_back`, `browser_forward`, `browser_reload`
- `browser_pause`, `browser_resume`, `browser_stop`
- `auth_request_login`, `auth_complete`
- `paper_find_downloads`, `paper_download` (opaque candidate IDs keep signed query parameters out of MCP output)
- `downloads_list`
- `document_import`, `document_list`, `document_read`, `document_search`

## Local Data

Chromium profile data and the PDF library live under the Electron user-data directory, currently `%APPDATA%\codex-browser`.

- `state/runtime-state.json` stores sanitized task/download metadata and the last safe page.
- `state/session-cookies.enc` stores only session cookies, encrypted for the current Windows user through Electron `safeStorage`.
- `state/login-credentials.enc` stores optional site logins encrypted for the current Windows user; plaintext credentials are never written to runtime state, logs, or MCP responses.
- `library/downloads` stores downloaded files, while `library/documents` and `library/index.json` store imported PDFs and extracted page text.

Raw cookies, authentication headers, signed URL query parameters, and browser profile files are never returned through MCP. Closing the window keeps the tray process alive; a full exit flushes Chromium storage and the local encrypted backup before shutdown.

The encrypted session-cookie backup has no short local expiry: it remains until the browser profile is cleared or the site removes/replaces the cookie. Codex Browser refreshes the backup every five minutes, saves on cookie changes and shutdown, and keeps one previous encrypted generation for corruption recovery. A university or publisher can still expire the server-side session independently; when that happens, the encrypted saved-login workflow can authenticate again automatically.

The source project is `A:\Project\CodexBrowser`. The personal Codex plugin source is `C:\Users\22865\plugins\codex-browser`, with its marketplace entry in `C:\Users\22865\.agents\plugins\marketplace.json`.

Development history is indexed in `WORKLOG.md`. Project-level `AGENTS.md` requires a new or updated Markdown work log for every implementation session.

## Next Adapters

The next implementation step is to add the actual university off-campus entry and the first publisher/database adapters. These adapters should provide login URLs, successful-session checks, DOI routing, and site-specific PDF discovery while continuing to use the same browser and document core.
