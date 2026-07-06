# Shadow of the Demon Lord Character Manager

A character manager for the *Shadow of the Demon Lord* tabletop RPG. It runs
entirely in the browser, keeps your characters on your own machine, and has a
real rules engine underneath rather than a set of blank fields you fill in by
hand.

## Live demo

```
https://matthewaroy.github.io/shadow-of-the-demon-lord-character/
```

To enable GitHub Pages for your own fork: open the repository settings, go to
**Pages**, set the source to **Deploy from a branch**, choose branch `main` and
folder `/ (root)`, and save.

## Features

* Choice-driven builder: every "choose" in the rules becomes a card in a
  decision queue (attribute increases, tradition discoveries, spell picks,
  roguery talents, ancestry benefits, languages and professions).
* Per-level advancement for novice, expert, and master paths, including the
  optional second expert path and its either-path level 9 choice.
* Enforces the actual rules: religion-locked traditions, Power-capped spell
  rank, no dark magic for Magisters, Corruption on dark discoveries.
* 1,120 spells and 42 traditions parsed from the Core Rulebook, Occult
  Philosophy, and Terrible Beauty, plus the four novice paths and 165 expert
  and master paths with their full per-level benefits.
* Derived stats with provenance: every point of Health, Power, and Defense
  knows where it came from.
* Castings tracker built on the real castings table.
* Spell browser with learnable-now filtering, sort by efficiency, and an
  advanced view for category and build-lens filters, combos, and per-spell
  scores.
* Future Studies wishlist that flags which starred spells are ready to learn as
  you level up.
* Summoned-creature stat blocks shown inline on conjuration and summoning
  spells, parsed from the bestiaries.
* Play tracking on a parchment sheet: damage and healing rate, rests that
  refresh castings, and Insanity and Corruption marked during play.
* Armory with encumbrance warnings, plus a boon/bane dice roller with a roll
  history.
* Level 0 backgrounds with two starting professions, dice randomization, and
  the option to trade a profession for a language.
* Local-first roster: multiple characters in localStorage with JSON export and
  import. No server, no build step, just vanilla ES modules.

## Local development

```bash
npm install
npm run dev     # serves on http://localhost:3000
```

## Data pipeline

The ruleset under `data/` is generated from the rulebook PDFs, which live in the
repo root and are gitignored. The Python dependencies (PyMuPDF) come from
`requirements.txt`:

```bash
pip install -r requirements.txt
```

The stages run in dependency order, and `scripts/rebuild_data.sh` runs them all:

```bash
python3 scripts/extract_text.py      # PDFs -> normalized text (fixes broken ligatures)
python3 scripts/parse_spells.py      # -> data/spells.json
python3 scripts/tag_spells.py        # -> adds theorycrafting tags (+ data/spell-tags.json); applies data/spell-tag-overrides.json
python3 scripts/enrich_spells.py     # -> data/spell-enrichment.json (LLM build-lens labels via claude -p; resumable, shardable)
python3 scripts/score_spells.py      # -> data/spell-scores.json (per-spell damage/heal/mitigation efficiency as rank-cohort percentiles)
python3 scripts/detect_combos.py     # -> data/spell-combos.json (which spells stack, by fight-goal/lever, with effectiveness scoring); reads spell-scores.json, so run score_spells.py first
python3 scripts/parse_paths.py       # -> data/paths.json
python3 scripts/parse_traditions.py  # -> data/traditions.json
python3 scripts/parse_equipment.py   # -> data/equipment.json
python3 scripts/parse_creatures.py   # -> data/creatures.json
python3 scripts/parse_rules_index.py # -> data/rules-index.json
```

After regenerating, verify the result:

```bash
npm test    # data counts and cross-file integrity, then sample-character regression
```

`data/curated.json` is hand-written from the rulebook text. It holds the
ancestries with their creation rules and level 4 choices, the four novice paths
as full effect lists, the castings matrix, the advancement table, religions,
roguery talents, professions, and starting wealth.

The design of the effects/decisions engine is documented in
[docs/superpowers/specs/2026-06-11-v2-character-manager-design.md](docs/superpowers/specs/2026-06-11-v2-character-manager-design.md).

## Reference materials

* *Shadow of the Demon Lord Core Rulebook*
* *Occult Philosophy*
* *Terrible Beauty*

*Shadow of the Demon Lord is © Schwalb Entertainment. This is an unofficial
character tool.*
