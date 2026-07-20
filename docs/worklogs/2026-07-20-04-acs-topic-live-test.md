# ACS Topic Live Test

## Objective

Test real ACS Publications and Environmental Science & Technology papers related to the user's Cu(II)-H2O2-HCO3-, peroxymonocarbonate, Cu(III), and pollutant oxidation research.

## Decisions

- Use the connected ordinary Edge profile so the test reflects the user's real ACS and institutional-access session.
- Use one temporary tab and close it after testing, preserving existing ACS tabs and authorization state.
- Treat abstract access, PDF/SI discovery, full-text authorization, managed download, and local document extraction as separate outcomes.

## Changes

- No production code changed.
- Recorded a ten-paper live ACS/EST compatibility matrix and six-document local extraction check.

## Verification

- Ten relevant ACS pages opened successfully and exposed readable titles and abstracts.
- Six recent EST/EST Letters papers exposed an explicit main PDF candidate and SI PDF candidate.
- The older ES&T Cu(I) kinetics paper exposed SI; IECR, Inorganic Chemistry, and JACS pages remained abstract-readable but did not expose a main PDF candidate in the bounded candidate scan.
- Direct access to the Yang 2019 main PDF returned the article access page with institution, ACS login, and purchase options rather than PDF bytes.
- ACS recognized `EAST CHINA NORMAL UNIVERSITY`, but the tested article still displayed `Purchase Access`; the session did not prove full-text entitlement.
- Relay-mode `paper_download` correctly returned `UNAVAILABLE_IN_RELAY` instead of claiming a managed download.
- Six already-imported topic papers passed page-one extraction and paper-specific search: Yang 2019, Perumpully 2026, Park 2024, Ferrer 2025, Bakhmutova-Albert 2010, and Richardson 2000.

## Known Issues

- Ordinary Edge relay mode intentionally cannot place Edge-owned downloads into the managed document library.
- ACS SI links are visible and free, but the tested page layout caused the safe click boundary to report the off-screen SI file link as covered.
- Full-text ACS testing requires a working institutional entitlement or a switch to the dedicated external Edge runtime after that profile is authorized.
- The broad link heuristic returns citation, image, and navigation downloads alongside paper PDFs on ACS pages.

## Next Steps

- Improve ACS candidate ranking so exact `PDF` and `_si_*.pdf` links rank ahead of citation/image downloads.
- Add a relay-safe visible-download workflow or a clear handoff that opens the exact PDF/SI link in ordinary Edge without claiming managed import.
- Re-test one EST main PDF after the user confirms institutional full-text access in the visible browser.
