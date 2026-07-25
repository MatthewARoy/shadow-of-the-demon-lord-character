# Parser test fixtures

Committed excerpts of the extracted rulebook text, one page each, chosen
because each exercises a specific parser defect:

| Fixture | Exercises |
|---|---|
| `core_p26_professions.txt` | d20 profession tables misread as headings |
| `core_p53_situational_banes.txt` | the Situational Banes table; end of the ch.2 range |
| `core_p104_weapons.txt` | weapon stat tables — the reported "sling" bug |
| `core_p116_magic_to_spells.txt` | the magic-rules to spell-list transition |
| `occult_p6_intro.txt` | the start of the Occult Philosophy range |

`scripts/cache/` and the source PDFs are gitignored, so the tests cannot
regenerate these. They exist so the parser suite runs in a fresh clone.

Regenerate them only when the text extraction itself changes, using Task 4
Step 1 of `docs/superpowers/plans/2026-07-25-rules-index-parser-rework.md`.
