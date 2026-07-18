# Phase 5 High-Risk Policy And Confirmation

## Objective

Complete the deterministic high-risk action policy, one-time user confirmation, narrow temporary grants, non-replay protection, sanitized audit history, renderer controls, isolated fixtures, and plugin guidance without changing the default runtime.

## Decisions

- Policy decisions are `allow`, `allow_redacted`, `confirm`, and `deny_manual`.
- Password, OTP, CAPTCHA, Turnstile, passkey, certificate, and uncertain authentication steps remain manual.
- External effects such as sending, publishing, deletion, purchase/payment, upload, permissions, important account changes, personal-information submission, and legal acceptance require confirmation.
- Confirmations bind origin, tab, task, action category, snapshot revision, target ref, policy rule, and expiry. Approval is possible only through the Electron control center.
- Grants bind profile, origin, category, expiry, and optional tab/task. They never cover payment, account security, credentials, CAPTCHA, passkeys, file selection, or legal acceptance.
- Non-idempotent operations execute once. Browser loss while executing produces `outcome_unknown`; no automatic retry or replay occurs.

## Changes

- Added the independent `PolicyEngine`, form/page context collection in both adapters, risk categories, deterministic revalidation, and conservative ambiguity handling.
- Added confirmation and grant stores, deny-only MCP confirmation response, status/list/revoke tools, single-consumption execution IDs, stale/expiry checks, browser-loss handling, and sanitized audit events.
- Added renderer confirmation, grant, revoke, audit, expired/executing/completed/failed/outcome-unknown states and Playwright fixtures.
- Added local policy fixtures and `smoke:policy` covering ordinary actions, manual authentication, confirmation, denial, stale pages, execution once, grants, payment restrictions, stop, and sensitive-output boundaries.
- Fixed two acceptance regressions discovered in Phase 6 verification: duplicate isolated-world helper declaration and default `<button>` submit classification outside a form.

## Verification

- `npm run test:policy` passes 11 tests, including ordinary username fill beside a password field.
- `npm run smoke:policy` passes ordinary allow, confirmation required, MCP cannot approve, execute once, denial, scoped grant, payment grant rejection, stale revalidation, and stop cancellation.
- Electron `smoke:advanced` and sensitive-field regression pass with ordinary usernames allowed and sensitive submits blocked.
- Phase 5 Playwright artifacts cover ordinary/payment/delete confirmations, expired/executing/outcome-unknown states, grants, standard/minimum layouts, focus, and zero console errors.

## Known Issues

- File selection remains a user-operated native step followed by one-time upload confirmation; MCP never accepts an arbitrary local path.
- `outcome_unknown` deliberately requires user inspection and cannot be converted into an automatic retry.
- Policy classification is intentionally conservative for ambiguous external-effect submissions.

## Next Steps

- Phase 5 is accepted. Phase 6 may make external Edge the default while preserving all policy and manual-authentication boundaries.
