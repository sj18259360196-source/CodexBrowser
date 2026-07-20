# FontBox Per-Font Save Progress

## Objective

Ensure that saving one Windows font family only shows the in-progress label on the affected card instead of every visible font card.

## Decisions

- Keep a global import lock to prevent concurrent writes and refresh races in the FontBox library.
- Track the requested system font IDs separately so progress labels can be scoped to the actual operation.
- Keep unrelated save buttons disabled during the active import, but leave their normal labels visible.

## Changes

- Added `systemFontImportingIds` to the FontBox renderer library state.
- Derived the existing global `systemFontImporting` flag from whether that ID set is non-empty.
- Passed the active ID set through `App`, `MainContent`, the unified grid/list, and the detail panel.
- Updated system and managed-family cards to compute their own importing state from their pending system font IDs.
- Updated the detail panel so only the selected system font involved in the operation displays `保存中`.

## Verification

- `npm run typecheck` passed in `A:\Project\FontBox`.
- `npm run build` passed in `A:\Project\FontBox`.
- Playwright used two mocked Windows font families and a five-second delayed import.
- During the import, only Agency FB displayed `正在保存`; Microsoft YaHei UI retained `保存到 FontBox` while disabled by the global lock.
- Screenshot: `A:\Project\FontBox\output\playwright\font-save-single-card-progress.png`.

## Known Issues

- FontBox still serializes system-font imports; unrelated save buttons remain temporarily disabled during a write.
- There is no repository-owned automated renderer test suite yet, so this state regression is covered by the Playwright smoke artifact rather than a committed unit test.

## Next Steps

- Add component tests if FontBox adopts Vitest or another renderer test runner.
- Apply the same per-target progress pattern to future long-running asset operations where global labels would be misleading.
