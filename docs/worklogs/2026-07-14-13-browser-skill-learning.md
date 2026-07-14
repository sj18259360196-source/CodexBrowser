# Browser-Native Skill Learning

## Objective

Add a browser-native learning system that records reusable task operations, creates reviewable local workflow drafts, manages them in the desktop UI, and executes enabled workflows with guarded semantic element matching. Keep the model generic so research downloads are only one possible use case rather than a hard-coded domain.

## Decisions

- Browser skills are local dynamic data, not Codex prompt skills. They become available immediately through generic MCP tools.
- Skills contain JSON-only declarative browser commands. Arbitrary scripts, executable URL schemes, unknown methods, sensitive inputs, credentials, and verification values are rejected.
- Record task operations under a one-way client-session hash. Remove raw fill/select values, query strings, tab IDs, snapshot revisions, and temporary element refs before persistence.
- Re-resolve element targets from role, accessible name, text, placeholder, type, and link path on every run. Stop when no unique target is available.
- Promote Enter, save, submit, send, delete, purchase, publish, upload, and similar operations to confirmation risk regardless of imported metadata.
- Keep `browser_status` compact. Skill definitions are loaded only through dedicated list or match tools so a large library does not increase routine status latency.

## Changes

- Added `BrowserSkillService` with strict schema validation, atomic JSON persistence, trace retention, deterministic draft generation, matching, run statistics, import, export, CRUD, and stale-skill handling.
- Added protocol 1.3 browser-skill contracts, desktop bridge methods, storage counts, and per-MCP-client session IDs.
- Added operation tracing around the common pipe command entry point and a guarded skill runner for generic navigation, actions, waits, history, reload, and new-tab steps.
- Added `browser_skill_list`, `browser_skill_match`, `browser_skill_run`, `browser_skill_learn`, and `browser_skill_feedback` MCP tools.
- Added a responsive browser-skill management drawer with Skills, Learning, and Runs views; editing, enable/disable, inputs, confirmation, import, export, delete, trace promotion, discard, and run statistics.
- Added isolated service and real-runtime smoke tests using a generic support-queue workflow rather than paper-specific behavior.
- Updated README documentation and plugin metadata for local workflow learning.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, and MCP bundles.
- `npm run smoke:skills`: passed generic trace learning, three parameter types, persistence reload, matching, statistics, safe import defaults, and three malicious/invalid import rejections.
- `npm run smoke:skills-runtime`: passed real MCP matching and four-step semantic execution; the learned draft contained four replayable steps and no raw filled value.
- `npm run smoke:mcp`: passed with 38 tools, including all five browser-skill tools, under an isolated profile and named pipe.
- `npm run smoke:actions`, `npm run smoke:runtime`, and `npm run smoke:advanced`: passed after the common command tracing changes.
- Playwright desktop and 720 px narrow views passed with zero console errors. Final screenshots are `output/playwright/browser-skills-desktop-final.png` and `output/playwright/browser-skills-learning-narrow-final.png`.
- Personal plugin source and refreshed cache both passed `validate_plugin.py`.
- Source, installed record, and populated cache agree on `0.1.0+codex.20260714112144`; `codex-browser@personal` is installed and enabled.
- The current Codex task still exposes the 33 tools loaded when it started and therefore does not show the five new skill tools. A new task is required to load the refreshed 38-tool plugin surface.
- After fetching the trusted `origin`, local `main` is 0 behind and 0 ahead of `origin/main`. The working tree still contains uncommitted changes from this and earlier sessions; no commit or push was requested.

## Known Issues

- Draft generation currently generalizes one successful trace. Repeated-trace alignment, branch inference, and shared-variable inference are not implemented yet.
- Automatic task grouping uses the MCP client session. `browser_skill_learn` finalizes it explicitly, while the UI can also promote an in-progress trace with recorded operations.
- Conservative semantic matching intentionally stops on ambiguous or missing targets instead of attempting a risky fallback.
- The current editor changes metadata, triggers, status, and risk; fine-grained step reordering and branch editing remain future work.
- The packaged WindowsApps `codex.exe` was not executable from PowerShell, so plugin listing and installation used the current `@openai/codex` CLI through `npx` against the same local configuration.

## Next Steps

- Align repeated successful traces to merge equivalent steps and infer shared inputs without storing raw values.
- Add an advanced visual step editor with reorder, verification, retry, and optional branch controls.
- Add confidence decay based on site drift and more granular per-step success metrics.
- Start a new Codex task before testing the refreshed browser-skill MCP tools interactively.
