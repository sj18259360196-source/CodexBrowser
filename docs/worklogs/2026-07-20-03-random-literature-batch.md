# Random Literature Batch

## Objective

Run a randomized ten-paper public literature download test covering discovery, download, import, extraction, and search.

## Decisions

- Randomly sample ten papers from a curated fifteen-paper arXiv corpus so the inputs vary while remaining public, stable, and reasonably sized.
- Run all papers in one isolated managed Edge profile and record each result independently so one failure does not hide the rest.
- Use paper-specific search terms to verify extracted PDF text rather than accepting a successful download alone.

## Changes

- Added `npm run smoke:literature-batch`.
- Added per-paper timing, page count, first-page character count, search-hit count, and sanitized failure reporting.

## Verification

- `npm run smoke:literature-batch`: passed, 10/10 papers with 0 failures.
- The sample covered 362 PDF pages in total; every paper produced at least 1,904 first-page characters and at least 7 paper-specific search hits.
- Selected papers: GPT-3, ResNet, InstructGPT, YOLO, XGBoost, T5, GAN, Llama 2, BERT, and *Attention Is All You Need*.
- The run used an isolated profile and zero credentials.

## Known Issues

- The test depends on public arXiv availability and can fail when the network or arXiv is unavailable.
- This does not exercise authenticated publisher or institutional proxy sessions.

## Next Steps

- Retain the batch as a release preflight and investigate any future per-paper failure using its recorded arXiv ID and sanitized error.
