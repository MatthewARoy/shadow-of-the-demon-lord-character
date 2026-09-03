# Parser baselines

`spells.json` and `paths.json` are reviewed snapshots of their corresponding
files in `data/`. They let `scripts/diff_spells.py` and
`scripts/diff_paths.py` prove that a parser change alters only what it intends
to alter. Both gates run in `npm test`.

Do not regenerate a baseline merely to make a surprising diff disappear. A
re-freeze is appropriate only after the complete corpus diff has been
reviewed, invariants and parse-quality checks pass, and the accepted change is
recorded in `CHANGELOG.md` with the source revision and verification evidence.

Regenerating spells requires BOTH steps, in order:

    python3 scripts/parse_spells.py
    python3 scripts/tag_spells.py

Running the parser alone strips the `tags` field from every spell record.

For a new book or intentional parser migration, follow `docs/book-ingest.md`.
