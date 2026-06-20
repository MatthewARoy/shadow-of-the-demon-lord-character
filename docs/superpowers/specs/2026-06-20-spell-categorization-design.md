# Spell categorization for theorycrafting

## Problem

The Archive holds 1,120 spells as free text. Build-crafters want to slice them
by *mechanical effect*, not just tradition/rank: "show me every spell that
grants boons to attack rolls", "every reroll", "everything that hands me an
extra action so I know what to spend Borrowed Time's extra turn on", "all the
area lockdown". None of that is queryable today.

## The fork: LLM vs. structured metadata

The user raised two options — an LLM call, or "deep specific spell metadata".

**Recommendation: deterministic metadata tagging, generated offline, baked into
the JSON.** Not a runtime LLM call. Reasons specific to this codebase:

1. **SotDL's rules language is highly standardized.** A corpus scan shows the
   signals are dense and literal: 172 spells say "boon(s) … attack/challenge
   roll", 397 say "bane(s)", "becomes stunned/immobilized/slowed", "Nd N
   damage", "challenge roll", "extra action". Regex captures these accurately
   because the rulebook says them the same way every time. The existing
   `parse_spells.py` already extracts an `attack` block this way.
2. **The app is local-first with no server and no build step at runtime**
   (vanilla ES modules on GitHub Pages). A runtime LLM call would need an API
   key in the browser, cost money per filter, add latency, and be
   non-deterministic — all hostile to a static character tool.
3. **Determinism and auditability.** Same input → same tags, every time. A
   reviewer can read a rule and know exactly which spells it catches. Tags are
   diffable in git.

**Where an LLM still helps (optional, not built):** a *one-time enrichment*
pass for the genuinely fuzzy buckets a regex can't judge — "is this a
defensive or offensive use of fear?", thematic combo hints — whose output is
**reviewed and committed to JSON**, so it stays free and deterministic at
runtime. That layers cleanly on top of what's here and is the right place to
spend a model, not the per-query path.

## What was built

- **`scripts/tag_spells.py`** — a post-parse pass (idempotent; re-run after
  `parse_spells.py`). Each rule is `(tag, facet, matcher)`; matchers see the
  lowercased description plus the raw spell (so they can read
  `duration`/`area`/`type`). It writes a `tags: [...]` array onto every spell
  in `data/spells.json` and a taxonomy sidecar `data/spell-tags.json`
  (facets, labels, counts) that the UI reads to build its filter chips.
- **29 tags across 7 facets:** offense, control, support, mobility, utility,
  cost, timing. The buckets the request named map to `buff-attack`,
  `buff-challenge`, `reroll`, `debuff-rolls`, and `action-economy` (Borrowed
  Time lands `action-economy` + `triggered` + `self-risk`).
- **UI** (`js/ui/spells.js`): a collapsible "Categories" bar in the Archive,
  chips grouped by facet; selecting several narrows to spells with **all** of
  them (`area` + `control` = AoE lockdown). Each spell card shows its tags as
  small chips that are themselves click-to-filter, so a spell's categories are
  a jump-off to its synergy partners. Filtering is plain client-side set
  intersection over the in-memory spell list — instant, no network.

## Extending it

Add or tune a `(tag, facet, matcher)` rule in `tag_spells.py`, give it a label
in `TAG_LABELS`, re-run the script. The UI picks up the new chip automatically
from the sidecar — no front-end change needed. Run `--report` to eyeball the
distribution before committing.

## Known limits

Keyword rules trade a little precision for transparency: a tag clause inside a
spell's *drawback* sentence can over-match (e.g. a spell whose only "stunned"
is its own self-risk also gets `control`). The fix when a bucket matters is a
tighter, more anchored pattern — not a model. This is the lever the optional
LLM enrichment pass would pull for the few buckets where intent, not wording,
is what separates the hits.
