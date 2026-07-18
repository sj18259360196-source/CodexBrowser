# Local launcher

## Objective

Add a simple project-root script that opens the functional Codex Browser desktop locally.

## Decisions

- Reuse the existing `scripts/start-desktop.cmd` startup path so dependency installation, build checks, and Electron launch behavior remain centralized.
- Keep the new entry point at the project root so it can be run directly or opened with a double-click.

## Changes

- Added `start-local.cmd` as the project-root launcher.
- Documented the launcher in `README.md`.

## Verification

- Ran `start-local.cmd` and confirmed the Codex Browser Electron main, GPU, utility, and renderer processes started from this project.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run smoke:mcp` passed, enumerating 33 tools and reporting a healthy local session.
- `npm run smoke:runtime` was run twice and both runs reached the existing concurrent-navigation assertion with the final URL at `/slow-short` instead of `/`; desktop startup itself remained healthy.

## Known issues

- `scripts/runtime-control-smoke.mjs` assumes a deterministic arrival order for two concurrent `browser_navigate` calls. The current runtime can receive the second call first, making the assertion at line 105 fail even though both calls complete.

## Next steps

- Use `start-local.cmd` whenever the local desktop needs to be opened manually.
- Stabilize the concurrent-navigation smoke fixture separately by explicitly controlling request order before asserting the final URL.
