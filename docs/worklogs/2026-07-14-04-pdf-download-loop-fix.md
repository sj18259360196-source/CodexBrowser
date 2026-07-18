# 2026-07-14 - PDF Download Loop Fix

## Objective

Stop repeated HTML downloads and authorization prompts when a publisher PDF is already visible in Chromium, while keeping Codex pointer control observable and reliable.

## Decisions

- Prefer the PDF already loaded in the active tab and save it locally without re-requesting temporary publisher URLs.
- Keep strict page freshness checks for normal links, but validate loaded and visible PDF candidates by tab state.
- Use Chromium trusted pointer input with target verification, stable coordinates, and explicit foreground activation.
- Keep a permanent 52-pixel status or blocker row so authorization and assistance changes do not resize the browser viewport.
- Preserve one unresolved authorization prompt identity and do not repeatedly focus or flash the window for the same tab, reason, and safe URL.
- Allow dialog query and response commands to bypass the serialized action queue so alert and confirm dialogs cannot deadlock browser control.

## Changes

- Added loaded-PDF tracking, Chromium PDF export fallback, local save and import, retry suppression, signed-URL sanitization, and stale-record cleanup.
- Added verified CDP mouse input, animation-frame timeout fallback, live target revalidation, stable viewport sampling, background rendering, and `Page.bringToFront` focus emulation.
- Stabilized renderer bounds updates and added a fixed status row shared by idle, authorization, assistance, and dialog states.
- Suppressed repeated authorization focus and retained the original prompt ID while the same prompt remains unresolved.
- Made `browser.dialogs` and `browser.dialog_respond` control-plane commands so supported dialogs can be handled while a click is pending.
- Expanded the isolated advanced smoke test for tabs, popup opener behavior, screenshots, trusted input, visible-PDF save, document import, dialogs, and human assistance.
- Updated the personal `codex-browser` plugin descriptions and reduced its default prompts from four to three; refreshed the official cachebuster.
- Saved the previously open paper from its visible PDF viewer and confirmed the reported ScienceDirect title is searchable in the local document library.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed for renderer, Electron, and MCP bundles.
- `npm run smoke:advanced` passed three consecutive isolated runs.
- The advanced test confirmed the visible PDF was saved and imported without another fixture request or authorization loop.
- `npm run smoke:mcp` passed with 33 tools on protocol `1.2.0`.
- Playwright passed at 1440x900 and 980x680 with no console errors, body overflow, clipped buttons, or blocker-height drift.
- Plugin validation and both Skill validations passed with the bundled Python runtime.
- The restarted desktop restored a healthy encrypted session, two tabs, and the saved document; the reported paper had one local title match and no active HTML-download loop or authorization prompt.

## Known Issues

- Electron 43 on Windows does not emit a usable CDP opening event for native `window.prompt`; alert and confirm are verified, while prompt remains a platform-specific manual case.
- The official `codex plugin add codex-browser@personal` command could not run because the packaged WindowsApps `codex.exe` is not executable from PowerShell. The plugin source and cachebuster are valid, but Codex must reload it through a new task or the app UI.
- Historical completed and failed tasks remain in local history by design; the active retry loop is gone.

## Next Steps

- Start a new Codex task after the local plugin is reloaded so the updated manifest and Skills are picked up.
- Consider a native Electron prompt bridge if automated `window.prompt` handling becomes important.
- Add content-hash deduplication for locally exported PDFs to avoid duplicate library entries across application restarts.
