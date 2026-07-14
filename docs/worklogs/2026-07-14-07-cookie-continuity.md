# Cookie continuity hardening

## Objective

Keep institutional and publisher sessions available across desktop and Windows restarts, and reduce avoidable reauthentication caused by a missed or damaged local cookie backup.

## Decisions

- Keep the existing encrypted session-cookie snapshot without imposing a local time-to-live. The file remains until the profile is cleared or site cookie changes replace its contents.
- Refresh the encrypted snapshot every five minutes in addition to cookie-change and shutdown saves.
- Preserve one previous encrypted generation before replacing the current snapshot.
- Restore the previous generation only when the current backup is missing, unreadable, or fails authenticated Windows decryption. A valid empty current snapshot still represents an intentional logged-out state.
- Do not alter cookie values or invent expiration dates. Server-side session expiry remains authoritative and is handled by the encrypted automatic-login workflow.

## Changes

- Added `session-cookies.previous.enc` rotation in `PersistenceService`.
- Added current-then-previous restore fallback with invalid backup quarantine.
- Added the restore source to the internal restore result and startup status text.
- Added a five-minute periodic session-cookie backup timer and shutdown cleanup.
- Expanded the isolated credential smoke fixture to corrupt the current cookie backup and verify recovery from the previous encrypted generation.
- Documented local retention and server-side expiry behavior in `README.md`.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run smoke:credentials` passed with encrypted credential round-trip, previous-generation cookie recovery, automatic fill, automatic submit, cleared authorization prompt, and no isolated user-data leftovers.
- Before implementation, the normal desktop had already restored 55 encrypted session cookies after restart and reported a healthy session, confirming that restart restoration was functioning.

## Known issues

- A publisher or university can invalidate a session on its server regardless of the local cookie backup. Codex Browser cannot safely extend that server-controlled lifetime.
- The saved-login vault currently has no enrolled real site, so the next expired institutional session still requires one final manual fill followed by `保存并登录`.

## Next steps

- Enroll the ECNU login once when it next appears so server-side expiry can be recovered automatically.
- Add a provider-specific keepalive only if the institution documents a supported refresh endpoint; do not generate background requests against arbitrary protected pages.
