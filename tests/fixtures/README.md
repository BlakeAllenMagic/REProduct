# Test fixtures

Made-up sample data the automated tests run against, so they never depend on
the real parts list (which comes from the Google Sheet and changes).

- `data/`: categories.yaml, the sample parts CSVs and datasheet records
- `linecard.json`: built from `data/` (python3 tools/build_linecard.py --data tests/fixtures/data --out tests/fixtures/linecard.json --data-version 2026-11-18T00:00:00Z)
- `sample-upstream/`: the sample "manufacturer" PDFs the sync tests download
- The matching sample datasheets by hash are in `dev-datasheets/`

Regenerate the sample PDFs with: python3 tools/make_sample_datasheets.py
