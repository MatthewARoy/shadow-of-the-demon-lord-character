# Parser baseline changelog

## 2026-09-03 — `45077c5d2e084d253de09f5241e4a536a9d71a2d`

Re-froze `spells.json` at 1,165 records and introduced `paths.json` at 177
records after reviewing the complete current corpus and running `npm test`
(179 Python tests and 69 Node tests).

This snapshot folds in the reviewed parser and data changes from:

- `a8aaa51` — Demon Lord's Companion 2 spells and paths
- `adf7ae8` — spell text around embedded tables
- `f0ca4a7` — structured spell and talent tables
- `d7b969f` — table-to-prose boundaries
- `0f7850e` — Spellbinder's path-granted spell
- `f8aabeb` — remaining spell extraction and scoring corrections
- `ad4fce6` — path companion stat blocks

Future entries must name the reviewed source revision, explain the accepted
corpus changes, and record the validation run used before the re-freeze.
