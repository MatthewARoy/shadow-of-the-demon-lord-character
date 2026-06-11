# Shadow of the Demon Lord Character Manager — V2 Design

Date: 2026-06-11
Status: Implemented in this branch (autonomous session; decisions documented rather than pre-approved)

## Problem

V1 (single `index.html` + `app.js` + `ruleset_db.json`) treats paths as flat
records: one health bonus, one power bonus, a description string, and a
features string scraped with OCR artifacts. This cannot represent how SotDL
characters actually advance:

- **Per-level benefits.** Novice paths grant benefits at levels 1/2/5/8,
  expert at 3/6/9, master at 7/10, ancestries at 4. V1 applied a single
  lump bonus regardless of level.
- **Choices.** The Magician's level 1 Magic benefit is "discover one
  tradition, then make three choices: discover another tradition or learn a
  spell" — four picks total. V1 had no concept of a choice.
- **Triggered grants.** Cantrip: every tradition discovery also grants an
  extra rank 0 spell (on top of the rank 0 spell that any discovery grants,
  so a Magician discovery nets two rank 0 spells).
- **Constraints.** Priests may only discover traditions associated with
  their religion. Many master paths constrain discovery/learning to one or
  two named traditions. Spell learning requires the tradition discovered and
  spell rank ≤ Power.
- **Bad data.** V1's castings matrix was a linear extrapolation; the real
  table is not linear (Power 3 = 4/2/1/1, not 4/3/2/1). Path text was full
  of broken ligatures ("ŋghters") and truncated mid-sentence.

## Data pipeline (scripts/)

Python scripts parse the three rulebook PDFs (kept gitignored in the repo
root) into committed JSON under `data/`:

| Script | Output | Contents |
|---|---|---|
| `extract_text.py` | `scripts/cache/*.txt` | PyMuPDF text with ligature repair (ŋ/´→fi, Ŋ→ff, Ō→fl, ő→ffi, Œ→ffl, split "fi rst" joins) |
| `parse_spells.py` | `data/spells.json` | 1,120 spells (core 331, Occult Philosophy 761, Terrible Beauty 28), ranks 0–10, with type, requirement/target/area/duration, description, parsed attack attribute/against/damage where present, source + PDF page |
| `parse_paths.py` | `data/paths.json` | 42 expert + 123 master paths with per-level attributes/characteristics/magic parsed into structured choices, talents split by name, intro descriptions |
| `parse_traditions.py` | `data/traditions.json` | 42 traditions with attribute (Intellect/Will), dark-magic flag, source, intro prose |
| `parse_equipment.py` | `data/equipment.json` | 32 weapons, 8 armor, 131 gear items from the core equipment chapter |

`data/curated.json` is hand-written from the rulebook text: the real
castings matrix, the advancement table, 9 ancestries (creation stats +
structured level 4 choices), the 4 novice paths as full effect lists,
religions, the 5 roguery talents, professions/languages/wealth tables, the
second-expert-path rule, and parser overrides (Terrible Beauty's clipped
text layer corrupts one Troll Hunter talent).

Parser safeguards worth knowing about: per-book page limits stop the last
spell/path of a chapter from absorbing the next chapter; blocks are capped
at two PDF pages; Terrible Beauty has a duplicated, clipped text layer that
is deduped line-wise; bare numbers are only stripped as page furniture when
adjacent to a page marker (Dart's damage is a bare "1").

## Engine: effects and decisions

A character is stored as **a sequence of resolved decisions**, not as
computed totals. The engine replays:

1. Ancestry creation effects (fixed attributes, optional attribute choice,
   traits).
2. For each level 1..N, the advancement table names a source (novice path,
   expert path, ancestry, master path); that source's level entry yields an
   ordered list of **effects**.

Effect vocabulary (shared by curated and parsed data):

- `characteristics` — flat stat deltas (health, power, defense, speed, …)
- `attribute_choice` — increase N distinct attributes by 1 (decision slot)
- `discover_tradition` — decision slot; resolving it grants a rank 0 spell
  pick from that tradition (general rule), fires any `hook_cantrip` for an
  extra rank 0 pick, and adds 1 Corruption if the tradition is dark
- `magic_picks` — N picks, each "discover or learn" (decision slot each)
- `learn_spell` — pick a spell from a discovered tradition with rank ≤
  Power; optional tradition constraint list
- `grant_spell` — fixed spell (Magician's Sense Magic)
- `talent` — informational; `talent_choice` — pick from a pool (roguery)
- `option_choice` — pick one of several effect bundles (ancestry level 4)
- `lang_prof` — language/profession picks recorded as text with category
  suggestions

Slots are materialized as **pending decisions**; the UI surfaces them as
cards. Decisions persist with the level and effect that created them, so
changing an earlier choice (or level) invalidates only dependent decisions.
Power-dependent validation (rank ≤ Power) uses the Power computed from all
effects up to and including the granting level.

Derived stats are recomputed from scratch on every change with a
provenance trail (each bonus knows its source), shown in the UI.

Pixie's Wee trait halves path health gains via an ancestry flag. Priest
religion constraints come from `religions` in curated data. The level 7
"second expert path instead of master path" rule is supported as a toggle:
level 7 → second path's L3 benefits, level 9 → either path's L9, level 10 →
second path's L6.

## App architecture

Zero-build vanilla ES modules (GitHub Pages serves from branch root; no
bundler):

```
index.html        app shell
css/app.css       V2 styles (dark gothic, parchment/bronze/blood accents)
js/main.js        boot, data loading, routing between tabs
js/engine.js      effects/decisions engine, derived stats
js/state.js       character store, localStorage roster, import/export
js/ui/*.js        tab views: builder, sheet, spells, gear, dice log
data/*.json       ruleset (see pipeline)
legacy/           V1 app preserved as-is
```

V1 is moved intact to `legacy/` (with its data file) and stays usable at
`/legacy/`.

## UI

Five tabs:

1. **Build** — ancestry/level/paths pickers plus the decision queue: every
   unresolved choice is a card (attribute picks, tradition discovery with
   Cantrip-spawned spell picks, spell learning filtered to legal options,
   roguery talents, ancestry level 4 options). A level timeline shows what
   each level granted and which decisions remain.
2. **Sheet** — derived characteristics with provenance, attributes with
   click-to-roll, traits/talents by source, professions/languages.
3. **Spells** — full 1,120-spell browser (tradition/rank/type/source
   filters, learnable-only toggle), learned spells with castings trackers
   sized by the real castings matrix.
4. **Gear** — weapon/armor/gear catalog, inventory with equip flags,
   encumbrance from Strength requirements.
5. **Dice** — d20/d6/d3 with boons/banes (SotDL boon rule: roll N d6 take
   highest), attribute and weapon rolls, log.

Multiple characters are kept in a localStorage roster with JSON
export/import compatible files.

## Out of scope (V2)

- Spell exchange flow on learning (noted in UI copy; manual unlearn works)
- Incantations, relics, random background/interesting-things tables
- Creature/companion stat blocks (Beastmaster's primal beast etc.)
- Non-PDF supplements (Demon Lord's Companion paths are absent on purpose)
