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

