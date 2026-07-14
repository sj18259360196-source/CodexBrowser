# Encrypted automatic login

## Objective

Stop repeatedly asking the user to type the same institutional login by securely saving an explicitly approved login and automatically submitting it on later visits.

## Decisions

- Use Electron `safeStorage` so login credentials are encrypted for the current Windows user and never stored in plaintext.
- Scope each credential to the exact HTTPS origin. Loopback HTTP is accepted only so the local smoke fixture can exercise the same code path.
- Require one explicit `保存并登录` action before a site is enrolled; do not silently capture arbitrary password submissions.
- Skip automatic submission when captcha or multi-factor text or controls are detected.
- Limit automatic login to one attempt per tab and origin every five minutes to avoid retry loops after invalid credentials.
- Expose only encryption availability, saved-site count, and current-site status to the renderer and MCP state. Never expose origins, usernames, or passwords.

## Changes

- Added an encrypted login vault to `PersistenceService`, including load, save, lookup, status, and clear operations.
- Added login-form discovery, framework-compatible value setting, automatic submit, verification blocking, and retry throttling in the Electron main process.
- Added desktop IPC methods for explicit save-and-submit and clearing all saved logins.
- Added `保存并登录` to the authorization bar and a key icon in the session bar for clearing saved logins.
- Added `smoke:credentials`, which uses an isolated user-data directory and fake credentials to verify encrypted round-trip, absence of plaintext, automatic fill, automatic click, and prompt clearance.
- Updated the web preview to show the login authorization state by default and added two Playwright screenshots.
- Documented the saved-login workflow and encrypted file location in `README.md`.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed, including the standalone bundled persistence service used by the credential smoke fixture.
- `npm run smoke:credentials` passed with encrypted round-trip, automatic fill, automatic submit, cleared authorization prompt, and one saved fixture site.
- `npm run smoke:mcp` passed on the restarted normal desktop with 33 tools, idle runtime state, a healthy session, and the new credential-vault status.
- Playwright preview snapshots and console inspection passed at 1440x900 and 980x680 with no console errors or warnings.
- Screenshots: `output/playwright/credential-login-1440x900.png` and `output/playwright/credential-login-980x680.png`.
- The normal desktop was restarted after a session-health check and returned the new credential-vault state while preserving the existing healthy session.

## Known issues

- Existing credentials cannot be recovered retroactively. The user must fill the form once more and click `保存并登录` to enroll that login.
- The current form matcher targets pages that show username and password together. Multi-step username-first login flows still require a dedicated adapter.

## Next steps

- On the next institutional login prompt, fill the two fields once and use `保存并登录` instead of the site's login button.
- Add a site-specific adapter only if the ECNU provider changes to a multi-step form or introduces additional consent screens.
