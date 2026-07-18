# 2026-07-16 - Phase 0 Security Baseline (Paused)

## Objective

Implement only Phase 0 of the long-lived browser migration: close sensitive-field output gaps, introduce a browser-independent adapter and explicit browser/tab states, enforce a per-tab human-assistance boundary, and isolate all automated browser tests from normal browser sessions.

The session resumed after an earlier pause and was paused again at the user's request before the final dialog/auth-evidence fixes and full verification chain were complete.

## Decisions

- Preserve Electron `WebContentsView` as the default runtime; no Edge launch, CDP transport, external profile, or other Phase 1 work was started.
- Classify and redact sensitive fields inside the page before values cross into the Electron control process.
- Keep existing MCP tool names and inputs compatible where possible; screenshot redaction is mandatory even when an older client supplies `redactSensitive=false`.
- Use explicit uppercase browser/tab states and per-tab queues/generations so one waiting tab does not freeze unrelated tabs.
- Treat renderer assistance notes as unsafe input: the UI no longer collects them and the main process ignores the compatible MCP `note` parameter.
- Do not collect sensitive JavaScript prompt text through the renderer or IPC; sensitive prompt handling remains a manual browser action.
- Make every browser smoke own a unique named pipe, temporary user-data directory, Electron process, and local fixture port.
- Do not modify the personal Codex plugin because the public tool set did not change.

## Changes

- Added `BrowserAdapter` and the Electron `WebContentsView` adapter, then routed the current browser command boundary through it without changing the runtime.
- Added browser/tab states `READY`, `RUNNING`, `WAITING_PAGE`, `WAITING_USER`, `VERIFYING`, `PAUSED_BY_USER`, and `ERROR`.
- Added a complete command policy and `TabStateController` with per-tab mutation blocking, typed `TAB_WAITING_USER`, per-tab operation generations, and global stop cancellation.
- Converted authentication prompts, assistance requests, verification baselines, command queues, and navigation queues to tab-scoped maps.
- Added collection-time classification/redaction for password, password-autocomplete, OTP, CAPTCHA, token, hidden, file, sensitive submit, iframe, shadow-root, autofill, and dynamically retyped fields.
- Changed sensitive snapshot names to fixed values and removed their value, placeholder, text, link, and page-controlled ref exposure.
- Added mandatory screenshot overlays for sensitive controls, mirrored sensitive text, CAPTCHA visuals, same-origin content, and cross-origin frames.
- Added shared URL/text/error redaction and applied it to MCP responses, desktop state, tasks, persistence inputs, runtime logs, and IPC errors.
- Removed renderer assistance-note collection and sensitive prompt input/buttons; renderer errors now pass through the shared sanitizer.
- Stopped browser action task records from storing caller-provided element refs.
- Added isolated smoke infrastructure plus sensitive-field and tab-policy end-to-end suites; existing smoke scripts now use temporary profiles and unique pipes.
- Added/expanded unit coverage for redaction, persistence validation, and the tab state/policy matrix.

## Verification

- `npm run typecheck`: passed after the latest renderer, IPC, adapter, and state changes.
- `npm run test:tab-policy`: passed, 62 tests.
- `npm run test:persistence`: passed, 7 tests.
- `npm run test:redaction`: passed, 4 tests.
- The sensitive-field subtask reported passing `npm run build`, `npm run smoke:actions`, `npm run test:redaction`, `npm run smoke:sensitive`, and `npm run test:sensitive` before the pause; the main thread has not yet rerun the complete required chain against the final combined tree.
- The sensitive smoke reported 13 protected controls, 25 screenshot redactions, dynamic monotonic classification, iframe/autofill/ref/note/state/log coverage, unique pipe closure, temporary profile deletion, and no lingering owned Electron process.
- No normal browser profile, normal browser pipe, real Cookie data, credentials, authorization data, or raw profile data was read.

## Known Issues

- Sensitive JavaScript dialogs still need a verified close-to-resume path. The renderer no longer accepts sensitive prompt text, but a native dialog closed by the user can leave its tab in `WAITING_USER` without a completion route. The fix must enter `VERIFYING`, confirm the dialog/auth block is gone, and only then resume; failure must remain blocked.
- All JavaScript `prompt` dialogs should be treated as manual to avoid heuristic false negatives that could allow MCP `promptText` to submit a credential.
- Authentication resolution evidence still uses a browser-global Cookie change timestamp. It must be scoped to the target tab/origin so another tab's Cookie change cannot satisfy verification.
- Runtime maps are tab-scoped, but persisted assistance is still the active singleton projection. Crash/restart recovery must not silently lose a blocked tab's requirement for explicit re-verification.
- The complete required build and smoke chain, renderer Playwright checks, final Phase 0 scope audit, and documentation completion remain pending.
- The repository directory has no Git metadata, so changes cannot be reviewed with `git status` or `git diff`.

## Next Steps

- Resume from the current files; do not restart or begin Phase 1.
- Fix sensitive/native prompt dialog verification without collecting prompt values in renderer, IPC, tasks, logs, or MCP.
- Scope authentication completion evidence to the target tab/origin and preserve blocked recovery semantics across persistence.
- Rerun `npm run typecheck`, `npm run build`, all required smoke commands, `smoke:sensitive`, `smoke:tab-policy`, and all Phase 0 unit tests.
- Run Playwright at 1440x900 and 980x680, save screenshots under `output/playwright/`, and inspect console errors, overflow, and overlap.
- Complete the Phase 0-only audit, update this log and `plan.md` from paused to complete, then stop before Phase 1.
