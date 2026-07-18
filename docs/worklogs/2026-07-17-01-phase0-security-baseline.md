# 2026-07-17 - Phase 0 Security Baseline

## Objective

Complete the Phase 0 code boundary for sensitive-data redaction, the browser-independent adapter, explicit browser/tab states, tab-scoped `WAITING_USER` enforcement, isolated smoke profiles, and the remaining managed-dialog regressions without starting Phase 1.

## Decisions

- Keep Electron `WebContentsView` as the default runtime; no Edge launch, CDP transport, or external browser profile was added.
- Use collection-time sensitive-field classification and fixed safe names so field values never need to enter the control layer.
- Keep human-assistance enforcement tab-scoped and fail closed with `TAB_WAITING_USER` for modifying commands.
- Manage `beforeunload` through Electron's `will-prevent-unload` event and ignore the matching auto-closed CDP notification.
- Test the current Electron sensitive-dialog boundary with a supported sensitive `confirm`; Electron does not provide a usable native `window.prompt` flow.
- Keep all smoke runs on temporary profiles, unique named pipes, private fixture ports, and owned Electron processes.

## Changes

- Completed the `BrowserAdapter` contract, Electron adapter, browser/tab states, command policy, and per-tab operation generations.
- Enforced `WAITING_USER`, `VERIFYING`, and user pause as real per-tab mutation boundaries while preserving redacted reads and unrelated-tab progress.
- Completed sensitive-field redaction across snapshots, names, observations, screenshots, errors, tasks, persistence, logs, and MCP responses.
- Added or expanded sensitive-field, adapter, authentication-evidence, tab-policy, persistence, runtime-race, restart, and isolated smoke coverage.
- Hardened persisted tab, task, download, and blocked-boundary metadata with explicit allowlists.
- Added generated download names and removed page-controlled names and query-bearing URLs from exposed download metadata.
- Fixed managed `beforeunload` handling for tab close and page navigation, including dismiss/accept behavior.
- Updated the advanced dialog regression to use a fresh fixture tab and a supported sensitive dialog that must remain under user control.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, and MCP bundles.
- `npm run test:adapter`: passed, 2 tests.
- `npm run test:auth-evidence`: passed, 6 tests.
- `npm run test:tab-policy`: passed, 62 tests.
- `npm run test:persistence`: passed, 20 tests.
- `npm run test:redaction`: passed, 5 tests.
- `npm run smoke:advanced`: passed after the final `beforeunload` and sensitive-dialog fixes.
- Earlier combined-tree runs passed `smoke:runtime` and `smoke:tab-policy` after their final race and background-auth changes.
- The remaining full smoke chain and renderer Playwright pass were not rerun after the final dialog-only changes because the user requested an immediate stop after code completion.

## Known Issues

- Final Phase 0 acceptance still requires one uninterrupted run of every requested smoke command plus the two renderer Playwright viewport checks.
- Electron does not expose a usable native `window.prompt` flow; prompt values remain unsupported and no MCP or renderer input path was added.
- The repository has no usable Git metadata, so this session could not produce a Git-based diff audit.

## Next Steps

- Before declaring Phase 0 fully accepted, run the remaining required smoke commands and Playwright checks against the current tree.
- Confirm all smoke cleanup assertions pass and no temporary profile or owned Electron process remains.
- Start Phase 1 only after the user explicitly authorizes it and the Phase 0 acceptance run is complete.
