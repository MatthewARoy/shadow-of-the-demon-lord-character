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
- **31 tags across 7 facets:** offense, control, support, mobility, utility,
  cost, timing. The buckets the request named map to `buff-attack`,
  `buff-challenge`, `reroll`, `debuff-rolls`, and `action-economy` (Borrowed
  Time lands `action-economy` + `triggered` + `self-risk`).
- **UI** (`js/ui/spells.js`): a collapsible "Categories" bar in the Archive,
  chips grouped by facet; selecting several narrows to spells with **all** of
  them (`area` + `control` = AoE lockdown). Each spell card shows its tags as
  small chips that are themselves click-to-filter, so a spell's categories are
  a jump-off to its synergy partners. Filtering is plain client-side set
  intersection over the in-memory spell list — instant, no network.

## Accuracy review

A full pass over every tag's hits surfaced — and fixed — five recurring ways a
naive keyword match misreads SotDL's prose. Each fix is a sharper rule, so it
scales to all 1,120 spells rather than patching one entry:

1. **Mention ≠ effect.** "until it heals any damage" is a *trigger*, not a
   heal. Effect tags now anchor on the rulebook's actual phrasing ("heals
   damage equal to", "takes/deals … damage") instead of a bare verb. This is
   what fixed the original Stone-Blades-as-a-healer problem.
2. **Inflict vs. negate.** A condition word is `control` only when *applied*
   ("becomes stunned"); inside a removal/immunity clause ("is no longer
   stunned", "removing the … afflictions") it feeds `cure`/`protection`. A
   shared `cond_applied`/`NEGATE` helper enforces this.
3. **Self vs. target.** "*you* become stunned" is a self-risk drawback, not
   control over a target — so Borrowed Time no longer reads as a control
   spell. `cond_applied` skips caster-subject occurrences.
4. **Overloaded words.** "compelled small monster" is a *summon*, not mind
   control; "a dart flies from your hand" is a projectile, not flight; "takes
   half the damage **from** all sources" is defensive resistance while "taking
   half the damage on a success" is the offensive save-for-half. Rules now
   anchor on the surrounding grammar that disambiguates these.
5. **Either-order phrasing.** Boons/banes are stated both "1 boon on attack
   rolls" and "makes attack rolls with 1 boon"; the reverse form (which the
   first cut missed entirely) is matched, but only in the *plural* "rolls" so a
   spell's own single cast roll ("Make an attack roll with 2 boons") isn't
   mistaken for a granted buff.

Net effect on the noisier buckets: `heal` 81→62 (genuine healers; demon/object
heals excluded), `protection` 169→64 (save-for-half removed), `mind-control`
96→55 (summons removed), `cure` precision restored, and the roll buffs/debuffs
re-discovered the dominant "makes … rolls with N boons/banes" phrasing. 33 of
1,120 spells remain untagged — these are genuinely uncategorizable utility
(Mend repairs objects, Produce Water, Legerdemain), deliberately not force-fit.

## Per-spell overrides

`data/spell-tag-overrides.json` is the hand-curated escape hatch for the
genuine exceptions no fair rule can resolve — applied last, always winning.
Keyed by `"name|tradition"`, each entry carries `add[]`, `remove[]`, and a
`note` explaining why. It is deliberately small (single digits): if many
spells need the same override, that is a signal to fix the *rule* instead.
Current entries cover, e.g., heals that target a summoned demon (Minor Demon),
and cures phrased exactly like a self-escape (Exorcism). The tagger reports how
many spells were touched by overrides each run.

## Extending it

Add or tune a `(tag, facet, matcher)` rule in `tag_spells.py`, give it a label
in `TAG_LABELS`, re-run. The UI picks up the new chip automatically from the
sidecar — no front-end change. Workflow: `--report` for the distribution,
`--audit <tag> [<tag>…]` to dump a tag's hits with the matching description so
you can eyeball precision, then a per-spell override only for the true
one-offs.

## Known limits

Keyword rules trade a sliver of recall for transparency and determinism: where
intent rather than wording separates the hits (is this fear used offensively or
defensively?), a rule can't always tell. The levers, in order of preference,
are a tighter pattern, then a per-spell override, then — for a whole fuzzy
bucket — the optional one-time LLM enrichment pass described above, whose output
is reviewed and committed so runtime stays deterministic and free.
