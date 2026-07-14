# Plugin update hygiene

## Objective

Record the plugin-loading incident from this session and add durable project rules so future work does not omit cache refresh, reinstall verification, update checks, or push status checks.

## Decisions

- Treat source state, installed plugin state, and cache state as separate checkpoints because an enabled plugin can still be stale or unavailable to the current Codex task.
- Add the preventive workflow to `AGENTS.md`, where it applies to every future implementation session, instead of relying only on historical work logs.
- Require explicit Git repository, remote, upstream, and push-status checks without claiming a push when the project has no Git metadata.

## Changes

- Added a `Plugin Update Hygiene` section to `AGENTS.md`.
- Added an `Update And Push Checks` section to `AGENTS.md`.
- Documented the incident: Codex Browser was enabled in configuration, but the current task exposed no browser tools because the installed plugin version and cache had not been refreshed after source updates.
- Documented the recovery: launch the visible desktop, update the plugin cachebuster, reinstall `codex-browser@personal`, validate the plugin, confirm the cache contents, and run the MCP smoke test.

## Verification

- Confirmed the plugin source version and installed version both equal `0.1.0+codex.20260714073911`.
- Confirmed the refreshed plugin cache contains the manifest, MCP configuration, launcher, and both skills.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run smoke:mcp` passed and enumerated 33 MCP tools successfully.
- Rechecked `A:\Project\CodexBrowser` and confirmed it has no `.git` directory, so there is no repository, branch, remote, upstream, or push target to inspect.

## Known issues

- This project is not currently a Git repository, so these documentation changes cannot be committed or pushed.
- A newly reinstalled plugin is not injected into an already-running Codex task; testing automatic tool exposure still requires a new task.

## Next steps

- Apply the new update and push checklist at the beginning and end of every future implementation session.
- If version control and remote publishing are desired, initialize or restore the project repository and configure its trusted remote in a separate authorized session.
- Open a new Codex task after plugin reinstall and confirm the `browser_*`, `paper_*`, and document tools are present before starting browser work.
