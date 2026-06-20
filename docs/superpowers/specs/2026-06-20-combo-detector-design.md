# Spell combo detector

## Problem

The tag taxonomy answers "what does this spell do?" in isolation. Build-crafters
ask a different question: "what do I cast *together*?" Tags can't say that —
`buff-attack` lists 86 spells but doesn't tell you that two of them on the same
attack mostly waste a casting, while a `defense-buff` plus a defensive
`debuff-rolls` compound into something far better than either alone. The request
was for a detector that finds spells that stack — buffs to unarmed attacks, buffs
to attacks generally, damage mitigation, defense — and, crucially, flags which
combos are *actually* effective rather than merely co-taggable.

## The two dice facts that decide everything

SotDL resolves boons and banes in a way that makes "stacking" mean two opposite
things depending on the lever:

1. **Boons and banes pool, and only the single highest d6 applies.** Net them
   first (they cancel 1:1), then roll that many d6 and take the highest. So the
   marginal value of each additional boon/bane *on the same roll* collapses:
   E[max 1d6] = 3.5, E[max 2d6] ≈ 4.47, E[max 3d6] ≈ 4.96. The first bane is
   worth ~3.5; the second adds ~1; the third ~0.5.
2. **Flat bonuses add.** +2 Defense and +2 Defense is +4. "Deal 1d6 extra" and
   "deal 2d6 extra" is +3d6.

The consequence is the whole heuristic. Stacking the *same roll-lever* (more
banes, more boons) **diminishes**. Stacking the *same flat lever* (Defense,
extra damage) is **linear** and good. And combining *different levers toward one
goal* **compounds**: raise your Defense *and* impose banes on attacks against you
and you lift the to-hit threshold while lowering the attacker's roll — two
independent reductions of the same hit chance, neither hitting the other's
diminishing wall. That last case is the request's own example ("banes +
increased defense"), and it is the detector's highest-scored shape.

## Model: goals, levers, atoms

Each spell is reduced to **effect atoms** — `(goal, lever, magnitude)` — where a
*goal* is a fight outcome you stack toward and a *lever* is one mechanical way to
push it:

| goal | levers | additive? |
|------|--------|-----------|
| **evade** (don't get hit) | raise Defense · banes on attacks vs you · concealment | Def/conceal add; banes pool |
| **mitigate** (take less when hit) | reduce incoming damage · extra/temp Health · in-fight heal | add |
| **land-hits** (your accuracy) | boons on your attacks · soften the target | pool |
| **boost-damage** | extra weapon/unarmed damage | add |
| **suppress-enemy** | banes on its rolls · stun/immobilize/slow | banes pool; control denies actions |

Plus the **unarmed/natural-weapon** sub-axis the request named first: a brawler's
extra-damage buffs (Beast Within, Stone Gauntlet, Impervious, the Primal "Favor"
line…) all target the same attacks and all *add*, so they genuinely pile onto one
punch — the cleanest additive stack in the game.

## Extraction: tag-gated, regex-directed

Lever membership is **gated on the reviewed tags** from `tag_spells.py`, so the
detector inherits that pass's accuracy review and per-spell overrides rather than
re-litigating 1,120 spells. Regex then supplies only what tags can't:

- **Bane direction.** `debuff-rolls` lumps "banes on attack rolls made *against*
  you" (defensive → `evade`) with "banes on *its* rolls" (offensive →
  `suppress-enemy`). The detector reads the surrounding grammar to split them —
  the one distinction that most changes which combos are valid.
- **Magnitude.** `+N Defense`, `Nd6 extra`, bane/boon counts — pulled from the
  text for display and so showcases prefer the bigger source.
- **The unarmed split** (`unarmed strike|natural weapon` × extra-damage vs.
  boons).

Where a tag maps 1:1 to a lever (`protection`, `heal`, `control`, `concealment`)
the tag *is* the membership. If a spell carries no tags at all (tagger not run,
or — per the parallel re-tagging effort — vocabulary reworked), the regex stands
on its own, so the combo layer degrades gracefully instead of emptying out.

## Co-activation gate

A combo only pays off if the pieces can be up at once. Each spell gets a
**duration class** from its `duration` string: `instant` / `round` /
`sustained` (minute+) / `concentration` / `permanent` / `triggered`. From that:

- **Pre-castable** = sustained or permanent: cast before the fight, so it costs
  no action economy once combat starts. A combo of all-pre-castable pieces is
  the practical ideal and scores higher.
- **Fragile** = needs 2+ concentration spells held simultaneously: taking damage
  forces a challenge roll to keep each, so these are flagged and penalized.
- In-combat castings beyond the first cost actions and dock the score.

## Output and scoring

`scripts/detect_combos.py` writes `data/spell-combos.json`:

- `goals` — the taxonomy (labels, descriptions, levers, `additive` flags).
- `rosters` — every member spell per goal/lever (the browsable "all spells that
  buff X" lists), plus the unarmed damage/accuracy rosters.
- `combos` — ranked synergies, each typed:
  - **compounding** — two different levers on one goal (highest base score, +
    bonus when the showcase pair shares a tradition so one caster can run both, +
    when all pre-castable).
  - **additive** — several sources of one flat lever (good; pile them on).
  - **diminishing** — several sources of one roll-lever (shown but penalized,
    with the "pool to the highest die" explanation so the user knows to spend the
    casting on a different lever instead).
- `notes` — the dice-math explainer, so the JSON is self-documenting.

Showcase pairs prefer same-tradition, pre-castable, low-rank representatives so
the example is one a real build reaches rather than a rank-10 capstone, and never
pair a spell with itself.

## UI

`js/ui/spells.js` gains a collapsible **Combos** panel in the Archive (alongside
Categories and Build lens), grouped by goal. Each combo shows a synergy badge
(compounds / stacks / diminishes, color-coded), its member spells as buttons,
and `pre-cast` / `fragile` flags. Clicking a member searches the Archive for that
spell, so a combo is a jump-off to the cards. The panel is optional: absent
`data/spell-combos.json`, it simply doesn't render. Loading is wired in
`js/data.js` exactly like the tags and enrichment sidecars.

## Extending it

Add a goal or lever in `GOALS` (set `additive` correctly — it decides
diminishing vs. additive), write an `atom_*` matcher, gate it on the relevant
reviewed tag in `effects()`, re-run. `--report` prints the roster sizes and the
top combos for eyeballing precision. The taxonomy and dice notes ship inside the
JSON, so the front end needs no change to pick up a new goal.

## Known limits

The detector reasons about *whether* effects stack and *how their math
combines*, not exact end-state numbers — it won't tell you "this build caps an
ogre's hit chance at 12%". It also can't see beyond a single roll: it knows two
bane sources pool, but not table-specific cancellation against an enemy's own
boons. And like the tagger, where intent rather than wording separates a hit
(offensive vs. defensive fear), the gate leans on the reviewed tag; a genuine
miss is a `spell-tag-overrides.json` fix upstream, not a combo-script patch.
