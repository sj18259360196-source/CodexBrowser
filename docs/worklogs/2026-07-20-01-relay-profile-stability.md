# Relay And Profile Stability

## Objective

Reduce intermittent startup and reconnect failures in the recently added ordinary Edge relay and managed Edge profile recovery paths.

## Decisions

- Keep profile recovery fail-closed when ownership cannot be verified.
- Try both Windows PowerShell and PowerShell 7 for the Windows process ownership query.
- Make OS process probes injectable so lock recovery tests do not depend on local WMI or process state.
- Keep the fixed relay port required by the unpacked extension, but make a failed server start retryable after the port becomes available.

## Changes

- Added dual PowerShell executable fallback for owned Edge process discovery.
- Added deterministic process-probe coverage for stale locks and confirmed owned Edge recovery.
- Fixed the relay server so a failed listen attempt does not leave it permanently stuck in a false started state.
- Reject pending CDP event waits immediately when the relay disconnects.
- Restore the relay runtime status to ready when the extension reconnects.
- Added a complete deterministic `npm run test:unit` command that uses the adapter's required compile-first test path.

## Verification

- `npm run typecheck`: passed.
- `npm run test:unit`: passed, including 2 adapter tests, 165 core tests, and 2 launcher tests.
- `npm run build`: passed.
- `npm run smoke:mcp`: passed with all 39 MCP tools available.
- `npm run smoke:edge`: passed against Microsoft Edge 150.0.4078.65, including reconnect, duplicate-profile rejection, endpoint cleanup, and profile-lock release.
- `npm run smoke:broker-recovery`: passed, including existing Edge reattachment, page rediscovery, duplicate-process prevention, and stale broker ownership replacement.
- `npm run test:edge-relay`: passed, including retry after a port collision and immediate cancellation of pending waits on disconnect.

## Known Issues

- The ordinary Edge extension still requires its fixed localhost port and visible user pairing.
- Live ordinary-profile extension approval cannot be automated because Edge requires user consent.

## Next Steps

- Monitor ordinary Edge relay reconnect behavior during normal use and capture the exact control-center error if another failure remains.
