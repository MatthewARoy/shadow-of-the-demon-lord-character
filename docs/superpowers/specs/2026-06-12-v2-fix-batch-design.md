# V2 Fix Batch — Design

Date: 2026-06-12
Status: approved (user confirmed scope choices via Q&A)

Bug list triage for the V2 character manager ("Ledger of the Damned"), with
rules verified against the gitignored source PDFs (core, Occult Philosophy,
Terrible Beauty).

## Scope decisions made with the user

- **Spell exchange undo**: undo worked in testing; the problem is
  discoverability. Add an explicit undo affordance on the exchanged spell's
  card; keep the chip list.
- **Rations**: app data matches the core book (1 cp / week, Common). No change.
- **Summon spells**: parse referenced bestiary stat blocks into data and show
  them inline on spell cards ("view creature" toggle).
- **Level 0 professions**: implement the core rule (two starting professions,
  each tradeable for a language) **plus** in-app random rolling on the d6
  type / d20 profession tables. This also resolves the changeling language
  complaint (trade a profession for a language).

## Work items

### 1. Remove legacy V1
Delete `legacy/`, the "V1 ↗" tab link in `index.html`, and the README mention.

### 2. Corruption & insanity tracking
- `newCharacter()` gains `insanityAdjust: 0`, `corruptionAdjust: 0`.
  Existing saves lack the fields — all reads default with `|| 0`.
- `compute()` adds the adjustments after effect replay; totals clamp at 0.
  Nonzero adjustments get a provenance entry ("Marked in play").
- Sheet tab: second `btn-ink` row under the pentagram: `− insanity +` and
  `− corruption +`. Circles stay display-only.
- Insanity provenance block added next to the existing Corruption one.

### 3. Damage circle
- Node moves from (50, 47) to the pentagram center (50, 50); the decorative
  skull glyph sits behind the opaque circle (effectively replaced).
- "Damage" label renders inside the circle (static positioning for this node
  only), so it no longer collides with the star lines. "DOWN" sub remains.
- Remove click/shift-click on the circle; the −/+/heal buttons are the only
  mutators.

### 4. Casting pips toggle one casting
Click unspent pip → `used + 1`; click spent pip → `used − 1`. Never jumps.

### 5. Exchange undo on the card
Exchanged-in spells (`spellRec.exchanged`) show an "undo exchange ✕" button on
the card (in place of ⇄), reverting that exchange. Chip list stays.

### 6. Rest
`rest` button on the Sheet (next to heal) and in the Grimoire header:
heals healing rate + clears all `expended` castings, per the core Resting rule
(8-hour rest; castings refresh after a rest with 1 minute of meditation).
Toast/feedback confirms what happened. 24-hour variant = press heal again.

### 7. Stacking roll toasts
`#roll-toast` becomes a container; each roll appends a toast that auto-expires
independently (~4 s). Attack + damage rolls both stay readable.

### 8. Level 0 starting professions
- Engine: two creation slots `creation:prof:0` / `creation:prof:1`
  (ancestry-independent — they survive ancestry switches), kind `lang_prof`,
  title "Starting Profession", suggestions from all six profession tables.
  Card text cites the trade rule (profession ⇄ speak another language / read a
  language you speak).
- `activeDecisionIds()` adds the `creation:prof` prefix.
- Human's "either speak one additional language or add a random profession"
  becomes a third creation slot (detected via the ancestry text containing
  "either").
- Decision card for these slots gets a 🎲 roll button: d6 → category
  (academic/common/criminal/martial/religious/wilderness), then a uniform pick
  from that category's curated list, filling the input (re-rollable before
  Inscribe).

### 9. Summon creature stat blocks
- `scripts/parse_creatures.py` parses stat blocks from the core bestiary
  chapter and Occult Philosophy's creature appendix into `data/creatures.json`:
  `{name, book, page, difficulty, descriptor, perception, defense, health,
  insanity, corruption, attributes{}, speed, traits[], attack_options[],
  special_attacks[], special_actions[], end_of_round[], magic[]}`.
- Loader (`data.js`) indexes creatures by `(book, page)` and name. Spell
  descriptions are scanned for page references: `Shadow, page N` → core;
  `(see) page N` in an occult-sourced spell → occult. Refs to pages with no
  parsed creature get no link (e.g. magic-chapter cross-references).
- Spell cards with resolved creatures render a "view creature" toggle per
  creature that expands the stat block inline.
- Same copyright posture as `spells.json` / `rules-index.json` (full text
  already shipped; colophon disclaims).

### 10. Rations
No change.

## Testing
- `npm` has no test runner; `scripts/build_samples.mjs` is the existing
  harness — keep it green (sample builds may legitimately gain new pending
  level-0 profession decisions; update samples/harness expectations
  accordingly).
- Manual verification via local preview: pips, exchange undo, rest, toasts,
  damage controls, profession rolls, creature toggles, and a changeling
  build's language trade.
