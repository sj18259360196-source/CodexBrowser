# Project Instructions

## Work Logs

- Every implementation session must create or update one Markdown file under `docs/worklogs/` before the final response.
- Use the filename format `YYYY-MM-DD-NN-short-title.md`, where `NN` is the sequence number for that date.
- Update `WORKLOG.md` with a link and one-line summary for every session.
- Each session log must include: objective, decisions, changes, verification, known issues, and next steps.
- Backfill relevant work when a session covers changes made before this rule existed.
- Never record passwords, cookies, authorization headers, tokens, private URLs containing credentials, or raw browser profile data.

## Verification

- Run `npm run typecheck`, `npm run build`, and the relevant smoke checks after implementation.
- Validate the personal Codex plugin after every plugin change.
- Use Playwright screenshots for renderer changes and store them under `output/playwright/`.

## Plugin Update Hygiene

- Treat the plugin source, installed plugin record, and Codex plugin cache as three separate states that must be checked after every plugin-related change.
- Before the final response for a plugin-related session:
  - Compare the version in `C:\Users\22865\plugins\codex-browser\.codex-plugin\plugin.json` with `codex plugin list`.
  - Run the plugin-creator cachebuster helper and reinstall `codex-browser@personal` when source files or plugin metadata changed.
  - Validate the personal plugin, confirm the new cache directory is populated, and run `npm run smoke:mcp`.
  - Record the installed version and verification result in the session work log.
- Remember that MCP tools are loaded when a Codex task starts. After reinstalling the plugin, state explicitly that a new task is required to pick up the refreshed tools.
- Never assume that `enabled = true` means the current task has loaded the plugin; verify that the `browser_*`, `paper_*`, and document tools are actually listed.

## Update And Push Checks

- At the start and end of each implementation session, check whether the project is a Git repository.
- For a Git-backed project, inspect the working tree, current branch, configured remotes, and upstream divergence before the final response.
- Push when the user requested publishing or the active workflow explicitly includes a push. Otherwise, report whether local commits or changes remain unpushed.
- For a project without Git metadata or a configured remote, do not claim that changes were pushed. Record the missing repository or remote in the work log and final response.
- When checking for upstream updates, fetch only from configured trusted remotes and report whether the local branch is behind, ahead, or diverged.
