# Per-spell effectiveness scoring

## Problem

Theorycrafting needs more than "what does this spell do?" (tags) and "what
stacks with it?" (combos) — it needs "is this spell any *good*?" Concretely: how
efficient is a damage spell, a heal, a mitigation spell. The Archive had no way
to say a rank-3 damage spell is mediocre for its rank, or that one heal restores
twice what another does.

## The modelling choices

A raw expected value isn't comparable across the archive — a rank-7 spell
*should* out-damage a rank-1, so "17.5 average damage" means nothing on its own.
Three decisions (made with the user) define the metric:

1. **Comparison = rank-cohort percentile.** Each spell is scored against the
   others of the *same kind and rank*. "Top-quartile rank-3 damage spell" (~0.75)
   is the headline. This needs no assumption about target Defense or party size,
   and per-rank over/under-performers fall straight out.
2. **Caster-scaled output is measured in units of the caster's stat.** SotDL
   heals constantly read "equal to your healing rate"; rather than invent a
   stand-in character, those are valued as a **multiple of healing rate**
   (`1.0×`, `0.5×`, `2.0×`). Flat/dice heals are health points. Because the two
   live on different scales, cohorts are keyed by **(kind, _unit_, rank)** — we
   only ever percentile rate-multiples against rate-multiples.
3. **Reliability and area are flags, not multipliers.** Damage is the expected
   value *assuming it lands*; `auto` (no attack roll — reliable), `area`
   (multi-target upside) and `attack` (needs to hit) ride alongside as flags. We
   deliberately don't blend a guessed hit-chance and target-count into one
   number — the reader weighs those against their situation.

Dice are expected values: d6 = 3.5, d3 = 2, plus flat bonuses.

## What gets scored

| kind | gate (reviewed tag) | value & unit |
|------|--------------------|--------------|
| **damage** | `damage` / `auto-damage` | max parsed `Nd6(+X) damage` / `takes N damage`, expected points; excludes "extra damage" (that's an attack buff, a combo lever) and untagged self-/sacrifice damage |
| **heal** | `heal` | `equal to (half/twice) your healing rate` → rate-multiple; else `heals Nd6/N` → health points; tagged-but-unreadable → `see text` (counted, no value) |
| **mitigation** | `protection` / `defense-buff` | "half the damage" → 50 %damage; "reduce … by N" → flat; temp/`+N health` → HP buffer. (Defense bonuses are hit-*avoidance* — they live in the combo detector's `evade` goal, not here.) |

Gating on the reviewed tags means this pass inherits the tagger's accuracy
review: the defensive "takes half the damage from all sources" line isn't tagged
`damage`, so it never gets counted as offense. A spell can score in several kinds
(a drain that damages and heals records both). Coverage on the current corpus:
412 damage, 62 heal, 42 mitigation (487 spells).

## Output

`scripts/score_spells.py` writes `data/spell-scores.json`:

- `spells` — `name|tradition` → list of score records `{kind, value, unit, expr,
  flags, rank, cohort, cohort_n, percentile}`.
- `cohorts` — per `(kind, unit, rank)` summary `{n, median, max}` for context.
- `notes` — the comparison/units/reliability explainer, so the JSON is
  self-documenting.

Percentile uses the midpoint rule (ties count as half) and is suppressed in the
UI for cohorts of fewer than three (shown as "only N at this rank") so a lone
rank-10 spell isn't crowned "100th percentile" against itself.

## UI

`js/ui/spells.js` adds an effectiveness badge row to each spell card (under the
category chips): an icon per kind (⚔ damage, ✚ heal, 🛡 mitigation), the value
in its unit, the percentile, and any flags. Hovering gives the plain-English
read ("better than 82% of rank-3 damage spells (n=14)"). Loaded in `js/data.js`
like the other sidecars; absent `data/spell-scores.json`, no badge renders.

## How it composes with combos

The combo detector ranks *which* spells synergise; this scorer rates *how good
each piece is*. They're separate JSON sidecars today, but `detect_combos.py` can
read `spell-scores.json` to break ties (prefer the higher-percentile damage spell
in a showcase, or surface a combo of two individually-strong pieces) without
either script depending on the other's internals.

## Known limits

- **Damage parsing is headline-only.** It takes the largest single damage
  expression; spells with per-rank scaling, "for each additional casting", or
  conditional second hits are under-counted. A flat "takes 100 damage" object
  destroyer (Demolition) can look like a blaster — rank-cohort percentile
  contains the blast radius, but the raw value is naive.
- **Mitigation value is incoming-dependent.** "Half damage" is 50% of *whatever
  hits you*; the score reports the reduction, not absolute points prevented,
  which only a specific fight fixes.
- **Healing-rate cohorts are small**, so a percentile within them is coarse; the
  UI caveats low-n cohorts rather than overstating them.
