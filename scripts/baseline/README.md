# Parser baselines

`spells.json` is a frozen copy of `data/spells.json` as it stood before the
2026-07 parser rework, after light human verification of spell content.

It exists so `scripts/diff_spells.py` can prove that a parser change alters
only what it intends to alter. Do not regenerate it to "fix" a diff — a
surprising diff is the signal it exists to produce.

Regenerating spells requires BOTH steps, in order:

    python3 scripts/parse_spells.py
    python3 scripts/tag_spells.py

Running the parser alone strips the `tags` field from all 1,120 records.
