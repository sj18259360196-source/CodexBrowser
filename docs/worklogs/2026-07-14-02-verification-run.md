# 2026-07-14 - Full Verification Run

## Objective

Run the complete static, plugin, MCP, runtime-control, and renderer verification chain against the latest Codex Browser build while preserving the normal Chromium profile and its university-login state.

## Decisions

- Run Electron smoke tests with `CODEX_BROWSER_USER_DATA_DIR` pointing only to `A:\Project\CodexBrowser\.runtime\smoke-profile`.
- Stop the normal Electron root process only while the isolated named-pipe tests run; keep the Vite preview available throughout.
- Delete only the verified isolated profile after the tests, then restart Electron without an environment override.
- Use the real stdio MCP launcher for all smoke checks and the Playwright CLI for browser-rendered layout checks.
- Do not expose cookie values, signed query strings, authorization data, or raw profile contents in the verification record.

## Changes

- Refreshed the generated `dist` bundles through the normal build command.
- Added current Playwright screenshots at 1440x900 and 980x680 under `output/playwright/`.
- Added this verification log and updated the work-log index.
- No application source, plugin source, marketplace configuration, normal profile data, downloads, or document records were modified by hand.

## Verification

- `Get-Command npx`: passed; PowerShell resolved the installed Node.js launcher.
- `npx --version`: passed with version `11.12.1`.
- `npm run typecheck`: passed.
- `npm run build`: passed for the renderer, Electron main/preload, and MCP bundles.
- `npm audit --omit=dev`: passed with zero production vulnerabilities.
- Personal plugin validation: passed for `C:\Users\22865\plugins\codex-browser`.
- `npm run smoke:mcp`: passed through the real plugin launcher with 23 tools, protocol `1.1.0`, healthy isolated session state, and encrypted backup availability.
- `npm run smoke:actions`: passed for referenced input, keyboard delivery, selection, clicking, dynamic waits, scrolling, and blocking automated password entry.
- `npm run smoke:runtime`: passed for 403 prompt retention, navigation cancellation, serialized navigation, sensitive-query redaction, opaque download candidates, concurrent download matching, and late-download cancellation.
- Playwright at 1440x900 and 980x680: zero console errors and warnings, no page overflow, no toolbar/footer overlap, and no unintended control truncation.
- Screenshots:
  - `output/playwright/codexbrowser-1440x900.png`
  - `output/playwright/codexbrowser-980x680.png`
- Isolated cleanup: the smoke Electron process stopped and `.runtime\smoke-profile` was removed after path verification.
- Normal environment recovery: Electron restarted with `%APPDATA%\codex-browser`, no process referenced the isolated profile, and Vite remained available on port 5173.
- Final normal-profile MCP check: `runtimeStatus` was `idle`, the page was Crossref, `authPrompt` was null, session health was healthy, no tasks were present, and the encrypted session backup remained available.

## Known Issues

- The bundled Playwright shell wrapper has CRLF line endings that fail when invoked through WSL, so this Windows run used the equivalent `npx --package @playwright/cli playwright-cli` command.
- `npm audit --omit=dev` covers production dependencies only.
- Plugin validation confirms structure and configuration, but this run did not reinstall the plugin through the inaccessible WindowsApps `codex.exe` PowerShell entry point.
- Institution-specific off-campus login and publisher PDF flows still require configured adapters and real authorized-site test cases.

## Next Steps

- Add a repeatable desktop IPC regression script for every visible toolbar, session, task, download, and document control.
- Add the first university profile adapter and run a credential-free login-boundary test followed by a user-authorized end-to-end test.
- Add publisher-specific PDF discovery fixtures and validate the full download-to-document pipeline.
