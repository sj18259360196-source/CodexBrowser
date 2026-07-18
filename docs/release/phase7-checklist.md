# Phase 7 Release Acceptance Checklist

## Baseline

- [x] Typecheck and production build pass.
- [x] Electron legacy MCP, actions, runtime, advanced, and sensitive suites pass.
- [x] External Edge Phase 1 through Phase 6 smokes pass with temporary profiles and local fixtures.
- [x] Production dependency audit reports no known vulnerabilities.

## Endurance And Recovery

- [x] Repeatable endurance smoke runs for at least 60 minutes.
- [x] Tabs are created, selected, navigated, and closed throughout the run.
- [x] Snapshot, fill, click, iframe, popup, screenshot, download, and PDF import paths remain live.
- [x] One blocked tab does not stop ordinary work in another tab.
- [x] Broker/CDP/control-center and owned Edge recovery paths are exercised.
- [x] No duplicate managed Edge, profile-lock leak, unbounded CDP sessions, deadlock, notification loop, or late action is observed.
- [x] Memory and handle samples do not show sustained unbounded growth.

## Security And Policy

- [x] Deterministic fake password, OTP, recovery code, CAPTCHA text, Cookie, token, signed URL, payment, message, profile, and CDP canaries do not appear in exposed output or logs.
- [x] Sending, publishing, upload, deletion, purchase/payment, subscription, and permission fixtures require confirmation.
- [x] Confirmation is user-only, revision-bound, single-use, stale-safe, and non-replayed after loss.
- [x] High-risk grants cannot cover payment, account deletion/security, passwords, OTP, CAPTCHA, or passkeys.

## Human And Real-Site Acceptance

- [x] Limited supervised public-site matrix covers static, search, documentation, Cookie, login/SSO entry, challenge, PDF, popup/iframe, and download categories.
- [x] No security mechanism is bypassed and no real credential or high-risk external action is used.
- [x] Local fixtures cover Cloudflare/Turnstile, CAPTCHA, login, MFA/OTP, passkey, file selection, permission, certificate, failed verification, and cross-tab continuity.
- [x] Focus and notifications are deduplicated.

## Installation And Upgrade

- [x] Clean dependency install/build and first profile creation are verified.
- [x] Edge missing/unsupported, missing/read-only directory, profile lock, stale lock, old settings, Chinese/space path, duplicate launch, and launcher-path errors are verified.
- [x] Application, MCP, protocol, profile schema, runtime metadata, plugin, and minimum Edge versions are documented and tested.
- [x] Upgrade preserves raw profile data, fails closed for stale confirmations/grants, and never copies Cookie/password databases.

## UI, Plugin, And Delivery

- [x] Renderer Playwright covers normal, first-run, connecting, error, assistance, verification, confirmation, outcome unknown, storage/reset, legacy, downloads/documents, standard/minimum/high-DPI, long Chinese text, keyboard focus, and zero console errors.
- [x] Personal plugin describes external Edge default, assistance and policy boundaries, validates, receives a cachebuster, and reinstall is attempted.
- [x] README, plan, worklog, install/use/recovery/cleanup/rollback guidance, known limitations, and release conclusion are complete.
- [x] Final cleanup finds no test process, listener, temporary profile lock, or sensitive test artifact.

## Release Verdict

Codex Browser 1.0.0 meets the routine-use release bar for ordinary browsing, controlled downloads and PDF import, tab-scoped human takeover, profile/data management, and guarded high-risk actions. The explicit `electron-legacy` rollback remains available. Real credential, MFA, passkey, certificate, permission, and native file-picker completion remains user-operated and site/device dependent; deterministic fixtures validate the coordination and safety boundary without claiming those native flows are automated.

## Formal Artifact

- [x] Windows x64 portable ZIP generated under `release/`.
- [x] Production dependencies and Electron control-center runtime included.
- [x] Archive entries and extracted startup/runtime lifecycle verified with an isolated profile.
- [x] SHA-256 checksum generated and independently matched.
- [x] Final release-smoke processes, profiles, locks, and extraction directories cleaned.
