<p align="center">
  <img src="assets/branding/icon-128.png" alt="Codex Browser icon" width="96" height="96">
</p>

# Codex Browser

Codex Browser is a visible, persistent Chromium workspace for Codex on Windows. It lets Codex work through a browser over a local MCP server while keeping login, MFA, captcha, consent, and other sensitive steps under the user's control.

> [!IMPORTANT]
> Codex Browser is early alpha software. It currently supports Windows x64 only. Preview installers are unsigned, so verify that downloads come from this repository's Releases page.

## What It Does

- Runs a visible Electron/Chromium browser with persistent tabs and site sessions.
- Exposes navigation, page inspection, safe element actions, waits, downloads, and document tools over MCP.
- Pauses for manual login, MFA, captcha, consent, file selection, and other sensitive interactions.
- Stores session recovery data and optional saved logins with Windows `safeStorage` encryption.
- Downloads PDFs into a local library with page-based reading and full-text search.
- Learns reviewed browser workflows from sanitized local task traces and runs them with guarded element matching.

## Requirements

- Windows 10 or Windows 11, x64.
- [Git](https://git-scm.com/download/win).
- [Node.js](https://nodejs.org/) `20.19` or later, or `22.12` or later. Current Node.js LTS is recommended.
- npm, which is included with Node.js.
- Codex desktop, Codex CLI, or the Codex IDE extension only if you want Codex to use the MCP tools.

## Install On Windows

Download the latest `Codex-Browser-Setup-*-x64.exe` from [GitHub Releases](https://github.com/sj18259360196-source/CodexBrowser/releases). The installer supports English and Simplified Chinese, lets you choose the installation directory, and creates Start menu and optional desktop shortcuts.

The preview installer is not code-signed. Windows SmartScreen can therefore show an unrecognized-app warning even when the file came from the official release. Check the published SHA-256 file before running it.

## Install From Source

Open PowerShell and run:

```powershell
git clone https://github.com/sj18259360196-source/CodexBrowser.git
cd CodexBrowser
npm ci
npm run build
npm start
```

The first launch creates a local browser profile under `%APPDATA%\codex-browser`. It does not use or modify your normal Chrome profile.

After the first build, you can start the desktop by running `npm start` or by double-clicking `start-local.cmd`. The launcher installs missing dependencies and builds missing output automatically.

## Connect It To Codex

The public repository does not yet publish a one-click Codex plugin. Source installations can connect directly through the included STDIO MCP server.

From the cloned repository, run:

```powershell
$repo = (Resolve-Path .).Path
codex mcp add codex-browser -- node "$repo\dist\mcp\index.mjs"
codex mcp list
```

Then restart Codex or start a new task so the MCP tools are loaded. The MCP server attempts to launch the visible desktop automatically when a browser tool is called. You can also start it first with `npm start`.

If the Codex CLI is not available on `PATH`, add the same server in **Settings > MCP servers**:

- Name: `codex-browser`
- Transport: `STDIO`
- Command: `node`
- Arguments: the absolute path to `dist\mcp\index.mjs` in your clone
- Working directory: the repository root

Save the server and restart the Codex host. See the official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) for the current configuration surfaces.

Example requests after setup:

```text
Use Codex Browser to open this website and ask me when login is required.
Find this paper through my authorized session, save the PDF, and cite the relevant pages.
Show me the current browser tabs and summarize the active page.
```

## Using The Desktop

- Use the address field and tab controls normally, or let Codex call the MCP tools.
- Complete passwords, MFA, captchas, consent prompts, and sensitive controls in the visible browser.
- Closing the window keeps the tray process and session available. Use the full exit action to stop the browser completely.
- Use the key button in the session bar to clear saved logins.
- Only access sites, accounts, and documents you are authorized to use.

Codex Browser does not bypass paywalls, DRM, captchas, institutional limits, or site access controls.

## Local Data And Privacy

Application data is stored locally under `%APPDATA%\codex-browser`:

- `state/runtime-state.json` stores sanitized task and download metadata plus the last safe page.
- `state/session-cookies.enc` stores encrypted session-cookie recovery data for the current Windows user.
- `state/login-credentials.enc` stores optional exact-site logins encrypted for the current Windows user.
- `library/downloads` stores downloads; `library/documents` and `library/index.json` store imported PDFs and extracted text.
- `browser-skills/skills.json` stores reviewed workflows; `browser-skills/traces.json` stores sanitized learning traces for up to 30 days.

Raw cookies, authorization headers, saved credentials, signed URL query parameters, and browser profile files are not returned through MCP. The desktop and MCP server communicate through a local named pipe rather than a listening web port.

## Browser Skills

Browser skills are local declarative workflows managed by Codex Browser. Successful supported MCP operations can produce a draft skill after temporary IDs, element references, query strings, filled values, and other sensitive details are removed. A user must review a draft before enabling it.

During execution, elements are resolved again from semantic features such as role, accessible name, text, placeholder, type, and link path. Missing or ambiguous targets stop the run. Confirmation-risk actions require approval, and repeated failures mark a skill stale.

Imported `.cbskill` files contain JSON-only commands. Arbitrary scripts, executable URL schemes, credentials, verification values, unknown methods, and external run statistics are rejected. Imports remain disabled until reviewed.

## MCP Tools

The server exposes tools in these groups:

- Browser state and tabs: `browser_capabilities`, `browser_status`, `browser_tabs`, `session_check`
- Navigation and inspection: `browser_navigate`, `browser_observe`, `browser_snapshot`, `browser_wait`
- Interaction and control: `browser_act`, `browser_back`, `browser_forward`, `browser_reload`, `browser_pause`, `browser_resume`, `browser_stop`
- Human handoff: `auth_request_login`, `auth_complete`, browser assistance, and dialog tools
- Workflow learning: `browser_skill_list`, `browser_skill_match`, `browser_skill_run`, `browser_skill_learn`, `browser_skill_feedback`
- Files and research: `paper_find_downloads`, `paper_download`, `downloads_list`, `document_import`, `document_list`, `document_read`, `document_search`

Use `browser_capabilities` after connecting to inspect the exact tool set and current limits.

## Build A Windows Installer

This repository can build an unpacked x64 application or an assisted NSIS installer:

```powershell
npm run package:win
npm run installer:win
npm run smoke:package
```

Artifacts are written to `release/`. The NSIS installer supports English and Simplified Chinese, allows installation-directory selection, and creates Start menu and optional desktop shortcuts.

These local artifacts are unsigned. Windows SmartScreen may warn about them. Do not distribute an installer as an official release until it has been built from a reviewed commit, tested on a clean Windows account, and preferably code-signed.

## Development

Use the renderer-only preview for layout work:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173`. The web preview does not include Electron's browser bridge, so desktop-only controls are disabled. Use `npm start` for the functional browser.

Run the project checks before opening a pull request:

```powershell
npm run typecheck
npm run build
npm run smoke:mcp
npm run smoke:actions
npm run smoke:runtime
npm run smoke:credentials
npm run smoke:advanced
npm run smoke:skills
npm run smoke:skills-runtime
```

Development history is indexed in [WORKLOG.md](WORKLOG.md). Bug reports and focused pull requests are welcome through this repository's Issues and Pull Requests pages.

## Troubleshooting

- **`node` or `npm` is not recognized:** install a supported Node.js version, then open a new PowerShell window.
- **Electron is missing:** run `npm ci` from the repository root.
- **The MCP server says the build is missing:** run `npm run build`.
- **Codex does not show the tools:** check `codex mcp list`, then restart Codex or start a new task.
- **The desktop does not start automatically:** run `npm start` once and check `.runtime\main.log` in the repository.
- **A site asks for login or verification:** complete it manually in the visible browser, then let Codex verify the session before continuing.

## Current Limitations

- Windows x64 is the only supported platform.
- Preview installers are not code-signed.
- The public repository does not yet include a distributable one-click Codex plugin; direct MCP setup is required.
- Website changes can invalidate saved browser workflows and require review or relearning.
- PDF text extraction does not provide OCR for every scanned document.

## License

Codex Browser is available under the [MIT License](LICENSE). Report suspected vulnerabilities through the process in [SECURITY.md](SECURITY.md).
