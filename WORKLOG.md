# Codex Browser Work Log

- [2026-07-13 01 - Initial MVP](docs/worklogs/2026-07-13-01-initial-mvp.md): Built the visible Electron browser, persistent session, authentication alerts, PDF library, MCP server, and personal Codex plugin.
- [2026-07-13 02 - Browser actions](docs/worklogs/2026-07-13-02-browser-actions.md): Added referenced page snapshots, safe browser interaction tools, event-driven waits, and the permanent work-log workflow.
- [2026-07-14 01 - Session persistence and functional controls](docs/worklogs/2026-07-14-01-session-persistence.md): Fixed desktop IPC controls, added local state and encrypted session recovery, verified authorization checks, and expanded the MCP/plugin workflow.
- [2026-07-14 02 - Full verification run](docs/worklogs/2026-07-14-02-verification-run.md): Passed static, plugin, MCP, isolated runtime, recovery, and two-viewport Playwright checks without changing normal profile data.
- [2026-07-14 03 - Visible PDF detection](docs/worklogs/2026-07-14-03-visible-pdf-detection.md): Broadened Chromium PDF-reader detection so already visible papers can use the existing local save fallback.
- [2026-07-14 04 - PDF download loop fix](docs/worklogs/2026-07-14-04-pdf-download-loop-fix.md): Saved visible publisher PDFs without re-requesting temporary URLs, stopped repeated authorization focus, stabilized trusted control, and verified the desktop and plugin.
- [2026-07-14 05 - Local launcher](docs/worklogs/2026-07-14-05-local-launcher.md): Added a project-root script for opening the functional Codex Browser desktop locally.
- [2026-07-14 06 - Encrypted automatic login](docs/worklogs/2026-07-14-06-encrypted-auto-login.md): Added opt-in Windows-encrypted credential saving, exact-site automatic fill and submit, verification safeguards, clear controls, and isolated smoke coverage.
- [2026-07-14 07 - Cookie continuity hardening](docs/worklogs/2026-07-14-07-cookie-continuity.md): Added five-minute encrypted cookie snapshots, previous-generation recovery, and clearer local-versus-server session lifetime behavior.
- [2026-07-14 06 - Plugin reinstall and paper download](docs/worklogs/2026-07-14-06-plugin-reinstall-and-paper-download.md): Refreshed the personal plugin cache, launched and verified MCP, and downloaded the requested ACS Nano article and supporting information.
- [2026-07-14 07 - Plugin update hygiene](docs/worklogs/2026-07-14-07-update-hygiene.md): Recorded the stale plugin-cache incident and made plugin refresh, update checks, and Git push-status checks mandatory for future sessions.
- [2026-07-14 08 - GitHub publish blocked](docs/worklogs/2026-07-14-08-github-publish-blocked.md): Audited the initial publish scope; GitHub CLI is installed, but authentication and initial Git setup still block the push.
- [2026-07-14 09 - Initial GitHub publish](docs/worklogs/2026-07-14-09-initial-github-publish.md): Created the private GitHub repository, verified the complete source tree, and published the initial `main` branch.
