# 2026-07-16 - Long-Lived Browser Plan

## Objective

Define a detailed implementation plan for evolving Codex Browser into a long-lived, general-purpose browser that uses an independent Edge/Chromium process, minimizes routine human control, and requests verified assistance for Cloudflare, authentication, and other sensitive boundaries.

## Decisions

- Use a visible external Edge/Chromium process with a dedicated persistent profile.
- Keep a bounded local MCP broker between Codex and CDP; never expose raw CDP to Codex.
- Prefer a private CDP pipe and allow an ephemeral loopback endpoint only as a documented fallback.
- Preserve normal browser ownership of passwords, cookies, storage, permissions, and updates.
- Freeze automation per tab during human assistance and verify success before resuming.
- Detect Cloudflare and similar challenges through scored network, frame, DOM, title, URL, and progress signals without attempting automated solving.
- Migrate incrementally behind a browser-adapter boundary rather than replacing the working runtime in one step.

## Changes

- Added `plan.md` with the target architecture, security boundaries, state machines, Cloudflare strategy, password and Cookie policies, MCP contracts, recovery model, migration phases, test strategy, acceptance criteria, risks, defaults, and first implementation slice.
- Added this session work log.
- Updated `WORKLOG.md` with the planning-session entry.

## Verification

- Reviewed the plan against the current Electron, MCP, persistence, browser-action, and human-assistance architecture.
- Confirmed that the plan explicitly addresses the current sensitive-input snapshot fallback and the absence of a hard `waiting_user` automation gate.
- `npm run typecheck`: passed.
- `npm run build`: passed for the renderer, Electron, and MCP bundles.
- `npm run smoke:mcp`: passed and reported 33 tools.
- `npm run smoke:runtime`: passed all seven runtime-control checks.
- `npm run smoke:advanced`: passed tool availability, sensitive-submit blocking, trusted pointer input, screenshots, popups, tabs, dialogs, visible-PDF handling, and assistance lifecycle checks.
- `npm run smoke:actions`: did not complete because its launcher connected to the already-running normal desktop session on a ScienceDirect page instead of an isolated fixture session; the snapshot therefore did not contain the expected `Research topic` field. The more comprehensive isolated advanced smoke covered the referenced-action paths successfully.

## Known Issues

- The preferred CDP pipe must be validated against the installed Edge version and the selected Node CDP client on Windows before it becomes a committed implementation dependency.
- A loopback CDP fallback is not a strong boundary against other local processes and requires explicit documentation and deployment hardening.
- Real Cloudflare behavior cannot be made deterministic in automated tests; local fixtures will validate detection and state handling without attempting to bypass the service.
- The repository directory currently has no Git metadata, so change review must use direct file inspection rather than Git diffs.
- `scripts/browser-action-smoke.mjs` is not self-isolating: unlike the advanced smoke, it does not create a unique pipe and temporary profile, so it can attach to and navigate the normal desktop session when one is running.

## Next Steps

- Implement the first slice defined in `plan.md`: sensitive-input regression protection, adapter and tab-state contracts, per-tab assistance enforcement, and an isolated external Edge launch/CDP prototype.
- Validate the CDP transport choice before porting the existing interaction and download surface.
