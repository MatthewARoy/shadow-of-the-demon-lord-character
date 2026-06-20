# Shadow of the Demon Lord: Ledger of the Damned

A dark gothic character manager for the *Shadow of the Demon Lord* tabletop
roleplaying game — a browser-native, local-first single-page app with a real
rules engine underneath.

## ⛧ Live Access (GitHub Pages)

```
https://matthewaroy.github.io/shadow-of-the-demon-lord-character/
```

### How to Enable GitHub Pages
1. Repository settings → **Pages**.
2. **Build and deployment** → Source: **Deploy from a branch**.
3. Branch `main`, folder `/ (root)`, then **Save**.

## ⛧ What V2 Does

V2 models a character as **a sequence of decisions**, replayed by a rules
engine — not a pile of manually-entered numbers.

* **Choice-driven builder.** Every rule that says "choose" becomes a card in
  the decision queue: attribute increases, tradition discoveries, spell
  picks, roguery talents, ancestry level 4 benefits, languages and
  professions. The Magician's level 1 "discover one tradition, then make
  three choices" yields exactly four picks — and **Cantrip** correctly grants
  a second rank 0 spell with every discovery.
* **Per-level advancement.** Novice paths grant benefits at levels 1/2/5/8,
  expert at 3/6/9, master at 7/10, ancestry at 4 — including the optional
  **second expert path** at level 7 (with the either-path level 9 choice).
* **Real constraints.** Priests discover only their religion's traditions;
  Druids choose among Life/Nature/Primal; Magisters can't pick dark magic;
  spell rank is capped by Power; dark traditions inflict Corruption on
  discovery.
* **1,120 spells** (ranks 0–10) and **42 traditions** parsed from the Core
  Rulebook, Occult Philosophy, and Terrible Beauty, with **165 expert and
  master paths** carrying their full per-level benefits.
* **Derived stats with provenance** — every point of Health, Power, and
  Defense knows where it came from.
* **Castings tracker** using the real (non-linear) castings table, a spell
  browser with learnable-now filtering, an armory with encumbrance warnings,
  and SotDL boon/bane dice with a roll ledger.
* **Summoned-creature stat blocks.** Conjuration and summoning spells carry
  their referenced creatures ("compelled small monster", "Shadow, page 246")
  as inline expandable stat blocks parsed from the bestiaries.
* **Play tracking.** Damage with healing rate, rest (heal + refresh
  castings), and Insanity/Corruption marked during play — all on the
  parchment sheet, with provenance.
* **Level 0 backgrounds.** Two starting professions per the core rules, with
  dice-roll randomization, each tradeable for a spoken or written language.
* **Local-first roster.** Multiple characters in localStorage with JSON
  export/import. No server, no build step — vanilla ES modules.

## ⛧ Local Development

```bash
npm install
npm run dev     # serves on http://localhost:3000
```

## ⛧ Data Pipeline

The ruleset under `data/` is generated from the rulebook PDFs (kept locally
in the repo root, gitignored) by the scripts in `scripts/`:

```bash
python3 scripts/extract_text.py      # PDFs -> normalized text (fixes broken ligatures)
python3 scripts/parse_spells.py      # -> data/spells.json
python3 scripts/tag_spells.py        # -> adds theorycrafting `tags`, writes data/spell-tags.json
python3 scripts/parse_paths.py       # -> data/paths.json
python3 scripts/parse_traditions.py  # -> data/traditions.json
python3 scripts/parse_equipment.py   # -> data/equipment.json
python3 scripts/parse_creatures.py   # -> data/creatures.json
python3 scripts/parse_rules_index.py # -> data/rules-index.json
```

`data/curated.json` is hand-written from the rulebook text: ancestries with
structured creation rules and level 4 choices, the four novice paths as full
effect lists, the castings matrix, the advancement table, religions, roguery
talents, professions, and starting wealth.

The design of the effects/decisions engine is documented in
[docs/superpowers/specs/2026-06-11-v2-character-manager-design.md](docs/superpowers/specs/2026-06-11-v2-character-manager-design.md).

## ⛧ Reference Materials

* *Shadow of the Demon Lord Core Rulebook*
* *Occult Philosophy*
* *Terrible Beauty*

*Shadow of the Demon Lord is © Schwalb Entertainment. This is an unofficial
character tool.*
