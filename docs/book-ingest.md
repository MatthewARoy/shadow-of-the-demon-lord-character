# Rulebook ingest procedure

Adding a rulebook is a whole-corpus parser migration. A layout quirk exposed
by the new PDF can change records from every previously ingested book, so new
record counts alone are not evidence that the ingest is safe.

## 1. Establish the before state

Start from a clean branch with `npm test` passing. Save the two high-risk
generated files outside the repository before changing a parser:

```sh
cp data/spells.json /tmp/sotdl-spells-before.json
cp data/paths.json /tmp/sotdl-paths-before.json
```

Do not update `scripts/baseline/` yet.

## 2. Register the source and its boundaries

- Add the PDF filename and stable source key to both `BOOK_FILES` and `BOOKS`
  in `scripts/extract_text.py`.
- Inspect every `parse_*.py` input list. Add the source to each parser whose
  domain the book contains; make exclusions deliberate rather than assuming
  all books have the same chapters.
- Add or update page limits and content anchors such as
  `SPELL_PAGE_LIMIT`, `PATH_PAGE_LIMIT`, `CREATURE_PAGE_LIMIT`, and the ranges
  in `parse_rules_index.py`.
- Inspect the PDF for running heads, wrapped headings, columns, embedded
  tables, and chapter transitions. If the book has no running heads, record
  it in the parser instead of relying on a head to terminate a block.

Then extract the normalized source text:

```sh
python3 scripts/extract_text.py
```

## 3. Regenerate all affected data

Run every affected parser. For spells, the deterministic downstream order is:

```sh
python3 scripts/parse_spells.py
python3 scripts/tag_spells.py
python3 scripts/score_spells.py
python3 scripts/detect_combos.py
```

Run `scripts/enrich_spells.py` when new or changed spell keys require semantic
enrichment. Regenerate paths, traditions, creatures, equipment, or the rules
index when the source contains those domains. Finally refresh the data stamp:

```sh
python3 scripts/validate_data.py --write-revision
```

## 4. Review the whole corpus

Compare every old and new record, not only rows carrying the new source key:

```sh
python3 scripts/diff_spells.py \
  --baseline /tmp/sotdl-spells-before.json \
  --current data/spells.json
python3 scripts/diff_paths.py \
  --baseline /tmp/sotdl-paths-before.json \
  --current data/paths.json
```

Added rows are expected during an ingest, so these commands will remain red
until the snapshot changes. The report is the review artifact. For a known
parser correction, repeat with narrow declarations such as
`--expect-field description --max-changed 6` or
`--expect-field talent_text --max-changed 2`; additions, removals, and every
undeclared field still fail.

Run the independent signature scan and treat each new hit as a defect until
it has been reviewed:

```sh
python3 scripts/scan_parse_quality.py
```

If a signature is a false positive, give it a `false-positive` entry and a
specific note in `scripts/parse_quality_baseline.json`. If it is a deferred
defect, file an issue and use `known-defect` with that issue number. Running
`--update-baseline` only creates `unreviewed` entries; those continue to fail.

## 5. Lock in reviewed intent

- Update `scripts/validate_data.py` source counts and the relevant
  `test_*_invariants.py` floors in the same commit as the generated data.
- Add focused regression tests for each newly encountered layout quirk.
- Run `npm test` from a clean checkout.
- Only after the diff is fully explained and the suite passes, copy the
  reviewed `data/spells.json` and `data/paths.json` into `scripts/baseline/`.
- Add an entry to `scripts/baseline/CHANGELOG.md` naming the source revision,
  accepted changes, and validation run. Re-run `npm test` so both baseline
  gates prove the committed data matches the reviewed snapshots.
