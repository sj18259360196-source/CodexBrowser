# Literature Download Verification

## Objective

Thoroughly verify the browser's literature discovery, PDF download, import, reading, search, cancellation, challenge, and restart behavior using deterministic fixtures and a real public paper.

## Decisions

- Use isolated Edge profiles for every test so normal sessions and browser data are untouched.
- Keep public acceptance read-only and credential-free.
- Add a reusable arXiv smoke test instead of relying only on a synthetic dummy PDF.

## Changes

- Added `npm run smoke:literature`.
- Added a real-paper workflow that opens an arXiv abstract, discovers its PDF candidate, downloads and imports the PDF, reads page one, and searches extracted text.

## Verification

- `npm run typecheck`: passed.
- `npm run test:unit`: passed, including 2 adapter tests, 165 core tests, and 2 launcher tests.
- Deterministic Edge core PDF/download flow: passed.
- Advanced visible-PDF save-without-rerequest flow: passed.
- Challenge and blocked-state restart flows: passed.
- Public W3C PDF view and download/import flows: passed.
- Real arXiv literature workflow: passed for *Attention Is All You Need*. The PDF candidate was discovered, downloaded, imported, and read with 2,870 extracted first-page characters; searching for `transformer` returned 7 hits.

## Known Issues

- Publisher-specific authentication, institutional proxies, and anti-bot systems still require supervised site-by-site testing with the user's authorized session.
- Ordinary Edge extension relay mode intentionally delegates downloads to Edge and does not import them into the managed document library.

## Next Steps

- Use the new smoke before releases and add publisher-specific supervised fixtures when a repeatable failure is observed.
