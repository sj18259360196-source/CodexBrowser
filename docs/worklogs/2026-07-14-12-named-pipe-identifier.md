# Named pipe identifier

## Objective

Change the local Codex Browser desktop/MCP connection identifier to `525901` without treating it as a TCP port, and keep both processes configured consistently.

## Decisions

- Treat `525901` as a Windows named-pipe identifier; it is not a TCP or UDP port and therefore is not subject to the `65535` network-port limit.
- Keep one stable pipe name so every Codex task connects to the same persistent browser desktop and profile.
- Define the fallback identifier once in shared code to prevent the Electron and MCP implementations from drifting apart.
- This identifier change does not affect whether Codex injects plugin tools when a task starts.

## Changes

- Added `DEFAULT_BROWSER_PIPE_NAME` with the value `525901` to the shared contracts module.
- Updated the Electron desktop and MCP server to use the shared default when `CODEX_BROWSER_PIPE_NAME` is not set or sanitizes to an empty value.
- Updated the personal plugin MCP configuration to pass `CODEX_BROWSER_PIPE_NAME=525901` explicitly.
- Refreshed the personal plugin version and cache after validation.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed for the renderer, Electron desktop, and MCP server.
- The plugin-creator validator passed against `C:\Users\22865\plugins\codex-browser` before and after the cachebuster update.
- The source plugin and installed plugin both report `0.1.0+codex.20260714092127`.
- The refreshed cache directory is populated and its `.mcp.json` explicitly contains `CODEX_BROWSER_PIPE_NAME=525901`.
- `npm run smoke:mcp` passed, enumerated 33 tools, and reported a healthy browser session.
- `\\.\pipe\525901` is active, `\\.\pipe\codex-browser-v1` is absent, and the runtime log records the new listener.
- The current Codex task listed the `browser_*`, `paper_*`, and `document_*` tools after reinstall, and direct `browser_capabilities` plus `browser_status` calls succeeded.
- `git fetch origin --prune` succeeded; `main` remains aligned with `origin/main` before considering the uncommitted working-tree changes.

## Known issues

- Changing the named-pipe identifier does not by itself fix a task that fails to load plugin tools during startup.
- A new Codex task remains the supported verification boundary after plugin reinstall, even though this task refreshed its tool inventory successfully.
- The repository contains unrelated existing logo, packaging, and work-log changes that were preserved.
- This session's repository changes are local and have not been committed or pushed.

## Next steps

- Start a new Codex task and confirm the refreshed plugin tools are present from the beginning of that task.
- Investigate Codex plugin startup logs separately if a new task still omits the tools; the named pipe and MCP runtime are now verified healthy.
