# Rules-Index Parser Rework — Design

Date: 2026-07-25
Status: approved (user confirmed scope and sequencing via Q&A)

This is the first of two documents. A second spec covers the Combat quick
reference tab, which is built after this lands.

## Problem

Searching "sling" in the Lookup tab returns:

> 1d3 Off Range (medium), uses stones 5 cp C Shields (Requires Strength 9 or
> higher) Name. Damage. Hands. Properties.

The correct data already exists. `data/equipment.json` parses Sling properly
(`1d3`, Off hand, "Range (medium), uses stones", 5 cp, Common). The garbage
comes from `data/rules-index.json`, built by `scripts/parse_rules_index.py`
— a line-based prose chunker that infers document structure from typography.

That inference fails five independent ways. The initial triage claimed the
damage was confined to the equipment chapter; that was wrong, and the wrong
claim was produced by a scan that only searched for the one defect signature
already known. A broader scan finds **79 of 547 chunks (14%) affected**, with
the character-creation chapter the larger offender:

| Chapter | Affected chunks |
|---|---|
| Ch.1 Character Creation (p.6–33) | 47 |
| Ch.6 Equipment (p.100–110) | 31 |
| Ch.2 Playing the Game (p.34–53) | 1 |

Within `parse_rules_index.py` the problem is systemic rather than local. A
pipeline-wide scan (see *Parse-quality scanner*) shows the other parsers are
in far better shape, with one exception: **11 spells carry a bled section
header** — one at each tradition boundary, where the last spell of a
tradition absorbs the next tradition's "X Spells" heading. `Phasing Missile`
ends with "Celestial Spells", `Moon Bridge` with "Conjuration Spells", and so
on through all 11 boundaries. That is defect class A again, in
`parse_spells.py`.

An earlier draft of this spec asserted that spells and paths scanned clean.
That was wrong, and wrong for the same reason the original triage was wrong:
the scan used signatures derived from the defect already known. The scanner
below exists to stop that failure mode recurring.

## The five defect classes

Each was verified against the committed `data/rules-index.json` and the
extracted text in `scripts/cache/`.

### A. Cross-range and cross-book bleed

`lines_in_ranges()` (parse_rules_index.py:37) stops yielding at a range
boundary without signalling it. `chunk()` (parse_rules_index.py:71) holds
`current` open until some later line happens to look like a heading, so the
open chunk accretes across the gap.

Verified consequences:

- The chunk titled `Effect` (core p.53) absorbs the Situational Banes table
  *and* the opening prose of core p.100.
- The chunks titled `EXPLOSIVE DARTS` (core p.118) end with **Occult
  Philosophy p.6** text about traditions. Content crosses books.

### B. Table rows misread as headings and prose

`is_heading()` (parse_rules_index.py:50) accepts any short Title-Case line.
Every table row's first cell therefore becomes a section, and the rest of the
row — plus the beginning of the next table's header row — becomes its body.
This is the sling bug, and it recurs on every table page in the indexed
ranges: ancestry d20 tables, profession tables, price tables, weapon tables.

### C. `MIN_BODY` merging destroys short rules

Any body under 60 characters is merged into its predecessor
(parse_rules_index.py:33, parse_rules_index.py:89). The comment says this
targets table cells, but length does not distinguish a table cell from a
short rule.

Verified: `Dazed`, `Rush`, and `Disabled` have **zero** chunks each. Dazed is
glued to the tail of the `Compelled` chunk. Searching "dazed" cannot surface
the dazed rule as its own result.

Counting afflictions from this index rather than from the source also
produces an undercount. The source lists **19** (core p.42–43):

> Asleep, Blinded, Charmed, Compelled, Dazed, Deafened, Defenseless,
> Diseased, Fatigued, Frightened, Grabbed, **Immobilized**, Impaired,
> Poisoned, Prone, Slowed, Stunned, Surprised, Unconscious

`Immobilized` is the one most easily lost, and the Combat reference spec must
carry all 19. Separately, `Disabled`, `Dying`, and `Incapacitated` are health
states on core p.41, not afflictions — they are also merged away by this
defect, but they belong to a different group.

### D. Heading detection is both too loose and too lossy

Beyond class B, two further heading defects:

- **Multi-line headings split.** `Attack with / a Melee Weapon` yields a
  chunk titled `a Melee Weapon`. Also verified: `a Ranged Weapon`,
  `to Attack Rolls`.
- **Running heads leak.** `RUNNING_HEADS` (parse_rules_index.py:24) is
  matched exactly, so the variant capitalisation `PLaying the Game` escapes
  it and appears inside 7 chunk bodies.

### E. Page-numbered range ends leak spell entries

The range `("core", 100, 118)` (parse_rules_index.py:20) is commented "pre
spell lists", but spell entries begin partway down core p.116. Verified: 30
ALL-CAPS chunks whose titles match names in `spells.json` are in the index —
while lookup.js:29 tells the user "Spells and paths live in their own tabs."

A page number cannot separate the generic magic rules at the top of p.116
from the spell list further down the same page.

## Approach

The current script infers structure from typography. The rework **declares**
the structure and demotes heuristics to drift detection.

This inversion is the core decision. An earlier draft of this design proposed
a heuristic table detector that *deleted* what it matched. Review found that
such a detector would have silently removed `Garrote`, `Holy Water`,
`Lantern`, and `Poison` — real prose sections whose special rules exist only
in the index, since `equipment.json` carries their price and availability but
not their rules text. A heuristic that deletes is a heuristic that loses data
without telling anyone.

### 1. Boundary-aware iteration (fixes A)

`lines_in_ranges()` yields explicit boundary sentinels at every range and
book discontinuity. `chunk()` flushes `current` on each sentinel.

Invariant, asserted in tests: **no chunk may span two books or a range gap.**

### 2. Anchor-terminated ranges (fixes E)

A range is a start page plus a **content end-anchor**, not an end page. The
core magic-rules range terminates at the first ALL-CAPS spell entry rather
than at p.118.

Invariant, asserted in tests: **no chunk title matches a name in
`spells.json`.**

### 3. Declarative table manifest (fixes B)

A committed manifest of table regions, keyed by caption text rather than page
number so it survives re-extraction of the PDFs. Lines inside a declared
block are excluded from chunking outright.

Captions extract cleanly from the source text — `Human Background`,
`Basic Melee Weapons`, `Lifestyle`, `Ammunition`, `Hirelings`,
`Profession Types`, `Clothing and Armor`.

The manifest has roughly **70 blocks**, not the ~40 first estimated. It stays
tractable because the ancestry tables follow a strict `<Ancestry> <Trait>`
naming pattern, so that family is covered by a **pattern rule** rather than
~45 literal entries:

| Manifest form | Covers | Approx. count |
|---|---|---|
| Pattern rule: caption begins with an ancestry name **and** the next line is a die size (`d20`, `3d6`, `2d6`, `d6`) | Ancestry d20 tables, ch.1 | ~45 blocks, 1 rule |
| Pattern rule `^\w+ Professions$` | Profession tables, p.25–26 | ~6 blocks, 1 rule |
| Literal entries | Equipment/price/gear tables, p.101–110; Interesting Things, p.27; movement & falling, p.38–39; Situational Banes, p.53 | ~20 entries |

The ancestry rule takes its name list from `data/curated.json` rather than
hardcoding it, so it stays correct if ancestries or indexed ranges change.
The trait half is deliberately **not** enumerated — the tail is irregular
(`Quirk`, `Purpose`, `Hatred`, `Odd Habit`, `Distinctive Appearance`,
`Apparent Ancestry`), and the following-die-size test identifies a table
header more reliably than any trait-name list would. Only six of the nine
ancestries (Human, Changeling, Clockwork, Dwarf, Goblin, Orc) fall inside the
currently indexed ranges.

A block ends at the next heading outside the table, or at an explicit
end-anchor where that is ambiguous.

**The heuristic detector survives as a validation warning only.** It reports
"this looks like a table row and is not in the manifest" and fails the build.
It never deletes. New corruption is surfaced, not swallowed.

### 4. Remove `MIN_BODY` merging (fixes C)

Length-based merging is deleted entirely. Table-ness is decided by the
manifest before headings are constructed, so the length proxy has no
remaining job. Short rules stand on their own.

Invariant, asserted in tests: **`Dazed`, `Rush`, `Disabled`, and `Dying`
each resolve as independent chunks.**

### 5. Heading reconstruction and normalisation (fixes D)

- Join a heading candidate with a following continuation fragment, so
  `Attack with` + `a Melee Weapon` becomes one heading.
- Compare `RUNNING_HEADS` case-insensitively.

Invariant, asserted in tests: **no chunk title begins with a lowercase
article or preposition** (`a`, `an`, `the`, `to`, `of`, `with`).

## Lookup: structured gear results

With table rows removed from the index, gear must remain findable. It returns
as structured data rather than reconstructed prose.

`ensureIndex()` in `js/ui/lookup.js` additionally reads `rules.equipment`
from `js/data.js` and projects weapons, armor, and gear into searchable
records carrying their real fields.

Design decisions, each responding to a specific defect found in review:

- **Separate result sections with per-kind quotas** — roughly top 5
  Equipment and top 15 Rules — rather than one merged ranking. The existing
  scorer (lookup.js:76) gives both a corrupt `Sling` prose chunk and a
  projected `Sling` gear record 26 points from title bonuses alone; the
  winner would depend on an unspecified projection detail. Quotas dissolve
  the tie rather than tuning around it, and the split is more scannable.
- **Identity is `name + category`.** `data/equipment.json` holds 171 records
  including a genuine duplicate: `Bastard sword or warhammer` appears twice
  with different stats. Name alone is not a key.
- **The equipment card renderer is extracted from `js/ui/gear.js` and
  shared.** Gear already renders these same fields (gear.js:92);
  reimplementing the markup in Lookup would duplicate it.
- **The citation line is guarded.** lookup.js:110 renders
  `BOOKS[c.b] · p.${c.p}` unconditionally; equipment records have neither
  field.
- **`ensureIndex()` gains `response.ok` and error handling.** It has none
  today (lookup.js:59); a failed fetch currently leaves the tab in a
  permanent "Loading the index…" state.

Accepted cost: `lookup.js` gains a dependency on `data.js` and is no longer
self-contained. The alternative — copying equipment data into the index — is
how this bug arose. Equipment is already fetched at boot, so this adds no
network request.

## Parse-quality scanner

Every defect in this document was found by an ad-hoc scan, and every *missed*
defect was missed because the scan only looked for signatures already known.
`scripts/scan_parse_quality.py` makes that scanning a committed, reusable
tool covering the whole pipeline rather than throwaway one-liners covering
one file.

It reads the committed `data/*.json` — no PDFs, no `scripts/cache/`, so it
runs in a fresh clone — walks every string field over 15 characters, and
reports matches grouped by file and signature. **It never modifies data.**

| Signature | Catches |
|---|---|
| `bleed` | trailing section/tradition headers, running heads in any capitalisation, chunks spanning books |
| `table_row` | price runs, damage/hands/availability rows, `Name. Damage. Hands.` header remnants |
| `dice_table` | 3+ `d20` tokens, or a body ending in a bare die size |
| `orphan_heading` | titles starting with a lowercase article or preposition |
| `cross_dataset` | a record's title matching a name in a different dataset (spells leaking into the rules index) |
| `ligature` | residual PDF artifacts (`ŋ`, `Ŋ`, `Ō`, `ő`, `Œ`, `fi rst`) that `extract_text.py` should have repaired |

Two design rules, both learned from the defects above:

- **Report, never delete.** Same principle as the table manifest. A scanner
  that prunes is a scanner that loses data silently.
- **Signatures are tuned for recall, and false positives are expected.** The
  prototype flags 112 `area` and 40 `target` fields as "truncated" that are
  simply unpunctuated phrases (`A cylinder, 4 yards tall…`). The scanner
  carries a **committed baseline** of known-acceptable hits; `npm test`
  fails only on hits *not* in the baseline. That keeps it useful as a
  regression gate without demanding a perfect signature set.

Current baseline, from the prototype:

| File | Records | State |
|---|---|---|
| `rules-index.json` | 547 | all five defect classes present — this rework's target |
| `spells.json` | 1,120 | 11 bled tradition headers |
| `paths.json` | 165 | clean |
| `creatures.json` | 155 | clean |
| `traditions.json` | 42 | clean |
| `equipment.json` | 171 | clean |
| `curated.json` | 52 | clean |

No ligature artifacts anywhere — `extract_text.py`'s repair is sound.

### Folded-in fix: `parse_spells.py` boundary bleed

The 11 bled tradition headers are the same defect class as A and the fix is
the same shape — flush at the boundary rather than letting the block run on.
It is included here rather than deferred: it is small, it is verified by the
scanner this work already adds, and splitting one defect class across two
projects would be arbitrary. Regenerating `data/spells.json` is required, so
this step needs the gitignored PDFs.

Asserted after the fix: **no spell description ends with a tradition name or
the word "Spells".**

## Verification

`scripts/cache/` and `*.pdf` are both gitignored, so **no test can regenerate
the index from source in a fresh clone.** The test strategy is shaped around
that constraint rather than assuming it away.

**Committed fixtures.** Small excerpts of exactly the problem pages —
core p.26, p.53, p.104, p.116, and Occult Philosophy p.6 — land under
`scripts/fixtures/`. Parser unit tests run against these from a fresh clone.
Excerpts are kept to the minimum needed to exercise each defect.

**Golden output per defect class**, so each of the five regresses
independently rather than as one opaque pass/fail.

**Invariant assertions against the committed `data/rules-index.json`**, which
hold regardless of whether the source text is available:

| Assertion | Defect guarded |
|---|---|
| No chunk spans two books or a range gap | A |
| No chunk matches the table-row signature | B |
| `Dazed`, `Rush`, `Disabled`, `Dying` exist independently | C |
| All 19 named affliction titles resolve as their own chunk | C |
| No chunk title starts with a lowercase article/preposition | D |
| No chunk body contains a running head in any capitalisation | D |
| No chunk title matches a name in `spells.json` | E |

**Search-behaviour tests**: `sling` returns a gear card; `dazed` returns the
dazed rule; `5 cp` does not flood the result list with ties (the tokenizer at
lookup.js:72 drops single-character tokens, so this query degrades to `cp`).

All of the above is wired into `npm test`, which currently runs only
`scripts/build_samples.mjs`.

## Scope boundaries

**In scope:** `scripts/parse_rules_index.py` rework, the table manifest,
`scripts/scan_parse_quality.py` and its baseline, the `parse_spells.py`
boundary-flush fix, `js/ui/lookup.js` gear results and error handling,
extraction of a shared equipment card renderer from `js/ui/gear.js`, fixtures
and tests, and regeneration of `data/rules-index.json` and
`data/spells.json`.

**Out of scope, deliberately:**

- Other parsers, with one exception. `parse_paths.py`,
  `parse_traditions.py`, `parse_equipment.py`, and `parse_creatures.py` scan
  clean and are not touched. `parse_spells.py` gets the small boundary-flush
  fix for its 11 bled tradition headers, described above.
- The Combat quick reference tab — its own spec, built after this.
- ARIA/tab-semantics remediation. Review noted the existing tab bar
  (index.html:34) uses plain buttons without `tablist`/`tab`/`tabpanel`
  roles, and that Lookup's expand affordance (lookup.js:45) is a clickable
  paragraph and so not keyboard-operable. Both are real, both predate this
  work, and both are logged as follow-ups rather than folded in here. The
  one exception: any *new* markup this work introduces meets the bar.

## Risks

**This is a rewrite, not a patch.** Four of the six functions in
`parse_rules_index.py` change substantially. That is proportionate to five
defect classes over 14% of the corpus, but it is materially larger than the
reported symptom implies.

**The manifest is hand-maintained.** ~70 blocks against a fixed three-book
corpus, written once. The rejected alternative — a pure heuristic detector
that deletes — is faster to build but will silently eat prose at some point
with no signal. The validation warning is the mitigation: drift fails the
build rather than corrupting data quietly.

**Regenerating `data/rules-index.json` requires the gitignored PDFs**, which
only the maintainer holds. Contributors can run the invariant assertions and
the fixture-based unit tests, but not a full regeneration. This is
pre-existing for every parser in the repo and is not made worse here.

## Rights note

The source books are marked all rights reserved; the repo carries an
unofficial-tool notice (README.md) and declares ISC at the package level,
which covers the code rather than the rules data. This work does not change
that posture — it corrects the fidelity of data already shipped — but the
Combat reference spec proposes new verbatim rules text and should address the
question explicitly rather than inherit it silently.
