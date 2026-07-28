# Combat Quick Reference — design

**Date:** 2026-07-25
**Status:** approved
**Predecessor:** [rules-index parser rework](2026-07-25-rules-index-parser-rework-design.md)

## Problem

Shadow of the Demon Lord buries its most tactically interesting combat
material. A player who reads only the action list on core p.49 never learns
that a melee attacker can trade a bane for the effect of Disengage (Shifting
Attack, p.51), or that Knock Down and Shove swing on relative Size. The
options live in two dense prose blocks and a scattering of half-page
sidebars, so in practice nobody uses them.

The user asked for a quick reference for actions in combat, citing the Lancer
compendium at <https://compcon.app/srd/reference/reference> as a model for
content organisation — not for visual style.

## Scope

Four content groups, all four selected by the user:

1. **Actions and attack options** — the core ask.
2. **Turn structure and economy** — fast/slow turns, triggered actions, free
   attack, minor activities.
3. **Afflictions** — all nineteen.
4. **Modifiers** — cover, obscurement, situational banes, range bands.

Delivered as a new **Combat** tab, placed between Dice and Lookup.

### Out of scope

- Roll integration. Cards do not roll; the Dice tab already does that.
- Affliction *tracking*. The tab describes afflictions; it does not record
  which ones a character currently has. See "Eligibility" below for why this
  matters and what it costs.
- A new PDF parser. See "Why hand-written data" below.
- Health states (Disabled, Dying, Incapacitated, core p.41). These are a
  separate mechanic from afflictions and are not part of the four groups.

## Source material

Core rulebook pages 42–53, already chunked cleanly into the committed
`data/rules-index.json` by the predecessor work. The three-book PDF cache
(`scripts/cache/`) is gitignored and maintainer-only, so the committed index
is the working source. It covers the corpus completely:

- p.42–43 — nineteen affliction chunks, one per affliction.
- p.49–50 — the fourteen actions, each its own chunk.
- p.51 — `Melee Attack Options`, one chunk containing all five options.
- p.52 — `Ranged Attack Options`, one chunk containing all three.
- p.52–53 — the eight attribute attacks, each its own chunk, plus `Charge`.

Two chunks are still damaged and must be reconstructed by hand: the
situational-banes table on p.53 survives as a chunk titled
`Situational Banes` whose entire body is `"Target is . . ."`, with the row
data flattened into an adjacent chunk titled `Effect`. That is a
table-manifest gap left by the predecessor work, and it is a concrete
argument for the decision below.

## Why hand-written data

`data/combat.json` is hand-written, following the `data/curated.json`
precedent. It is not parser output.

The content is fixed, small (~60 entries), structured, and prose-heavy —
exactly the material that the predecessor project exists because a parser
mangled. A parser would buy nothing: the corpus does not change between
runs, and the two blocks that most need splitting (`Melee Attack Options`,
`Ranged Attack Options`) are precisely the ones a chunker cannot split
correctly, since the option names are inline bold runs rather than headings.

## Rights posture

The entry text is **verbatim** rules text, cited to book and page. This is a
deliberate, informed choice by the maintainer rather than an inherited
default: the predecessor spec flagged that this tab would add a substantial
body of all-rights-reserved prose to a public GitHub Pages site, and the
question was put explicitly.

The repo already ships 1,120 verbatim spell descriptions, so this extends an
existing posture rather than creating one. Every entry carries a book/page
citation so the reference points back at the book. `README.md` already
carries the unofficial-tool notice and the ISC declaration covers the code
rather than the rules data; none of that changes here.

## Data model — `data/combat.json`

A single file with a version, a group list, and a flat entry array.

```json
{
  "version": 1,
  "groups": [
    { "id": "actions", "label": "Actions", "blurb": "…" },
    { "id": "attack-options", "label": "Attack Options", "blurb": "…" },
    { "id": "turn", "label": "Turn & Economy", "blurb": "…" },
    { "id": "afflictions", "label": "Afflictions", "blurb": "…" },
    { "id": "modifiers", "label": "Modifiers", "blurb": "…" }
  ],
  "entries": [ … ]
}
```

### Discriminated by `kind`

A flat `cost`/`roll`/`modifier`/`effect` record does not fit this material.
Conditions have no cost, range bands have no roll, turn phases have neither,
and even the attacks are not uniform — Disarm resolves against the higher of
two target characteristics and permits alternative attacking attributes,
while Knock Down and Shove take Size-dependent boons and banes. So entries
are a discriminated union keyed on `kind`, with kind-specific required
fields.

**Fields common to every entry:**

| field | type | notes |
|---|---|---|
| `id` | string | stable kebab-case slug, unique across the file |
| `kind` | enum | `action` \| `attack` \| `option` \| `condition` \| `reference` |
| `name` | string | display name |
| `group` | string | one of the `groups[].id` values |
| `source` | object | `{ "book": "core", "page": 51 }` |
| `text` | string | verbatim rules text, non-empty |

**Optional typed cross-links**, each an array of entry IDs:

| field | meaning |
|---|---|
| `inflicts` | this entry imposes an affliction (Unbalancing Attack → `prone`) |
| `requires_condition` | this entry presupposes an affliction (Escape → `grabbed`) |
| `removes` | this entry ends an affliction (Escape → `grabbed`) |
| `see_also` | untyped relation (Charge → `attack`) |

**Kind-specific fields:**

| kind | required | optional |
|---|---|---|
| `action` | `economy`: `action` \| `minor` \| `triggered` \| `free` | — |
| `attack` | `attacker` (attribute), `defender` (characteristic, or an array meaning "the higher of"), `on_success` | `cost`, `size_rule` |
| `option` | `weapon_class`: `melee` \| `ranged`, `cost`, `on_success` | — |
| `condition` | — | — |
| `reference` | — | `rows`: `[{label, effect}]` |

`cost` is an object, e.g. `{ "banes": 1 }`, so that a future
boon-granting option does not need a schema change.

`rows` carries the tabular references — cover, obscurement, range bands, and
the reconstructed situational-banes table — as structured rows rather than a
flattened prose blob.

### Link resolution when a target is missing

The renderer resolves link IDs through a `Map` built at load. An ID with no
matching entry is **dropped silently from the rendered output** — a dangling
chip at the table is worse than a missing one.

Silence at runtime is paired with noise at build time: a Python test asserts
that every ID in every link array resolves. A missing target therefore fails
`npm test` rather than degrading quietly in a browser.

## Character-aware layer

The tab resolves against the loaded character, but it does **not** interpolate
computed values into the verbatim text. Mangling quoted rules text to inject
a number is both a fidelity problem and a rendering problem.

Instead an entry may carry:

```json
"derive": [{ "label": "Push distance", "expr": "str_mod" }]
```

`expr` is drawn from a closed enum, each backed by a field that
`compute(char)` actually returns:

| expr | source |
|---|---|
| `str_mod` | `computed.modifiers.strength` (engine.js:304) |
| `speed` | `computed.speed` |
| `half_speed` | `Math.floor(computed.speed / 2)` |
| `size` | `computed.size` |
| `reach_from_size` | derived from `computed.size` per core p.38 |

Shove keeps its printed wording and gains a separate chip reading
`For you: 1 + 3 = 4 yards`. The computed part is visibly the computed part.

A test asserts every `expr` appearing in `combat.json` is in the enum, so a
typo fails the build instead of rendering blank.

`reach_from_size` is labelled as size-derived in the UI, because weapons can
modify reach and the app has no weapon-reach model. It is presented as the
baseline, not as an assertion about the character's current weapon.

### Eligibility — tri-state, and currently inert

`eligibility(entry, char, computed)` returns `available`, `unavailable`, or
`unknown`. Entries may carry typed `requires` clauses:

| type | example | answerable today? |
|---|---|---|
| `condition` | Escape requires you are grabbed | **no** — afflictions are not tracked |
| `equipment` | ranged options require a ranged weapon | **no** — see below |
| `free_hand` | Grab requires a free hand | **no** — no hand-slot model |
| `unloaded_weapon` | Reload requires a spent weapon | **no** — no ammo state |

**Only `unavailable` de-emphasises an entry.** `unknown` renders a condition
chip — `requires: you are grabbed` — and leaves the entry at full weight.

Being explicit about the consequence: **under the engine as it stands, no
entry in this corpus is provably unavailable, so nothing dims.** The
resolver ships anyway, because it is the single seam where real answers slot
in, and because a documented tri-state contract is what stops a later
contributor from reaching for a guess.

The blocker for the `equipment` type specifically: `js/ui/gear.js` copies
weapons into `char.inventory` without their `category` field (gear.js:167),
so "does this character have a ranged weapon equipped?" is not answerable
from stored state. Extending inventory with a stable equipment identity plus
category is a prerequisite for real availability and is worth costing
separately. It is not part of this work.

## Rendering and failure modes

### Lazy load

`data/combat.json` is **not** added to `loadRules()` in `js/data.js`. A
malformed file there would brick boot for every tab. Instead the module
follows the `ensureIndex()` pattern from `js/ui/lookup.js:77`: module-level
`data` / `loading` / `error`, fetched on first visit to the tab, with an
explicit error state carrying a retry button.

### No character loaded

`compute(char)` dereferences `char.ancestry` on its first statement
(engine.js:175) and throws on null. Every other tab sidesteps this with
`if (!char) return;` and renders nothing.

A reference tab that renders nothing without a character is useless, so this
is an explicit new branch: **the tab renders its full content with no
character loaded**, and simply omits the `derive` chips. `compute()` is never
called with a null character.

The `compute()` call is additionally wrapped in `try`/`catch`. A character
that throws for any other reason degrades the tab to no-derive mode with a
small notice, rather than blanking it.

## UI

**Interaction: chips and search, both.** A group chip row (the five groups
plus All) is the browsable spine — the user's ask was partly that they did
not know these options existed, which a search box alone does not solve. A
filter input narrows within the active group, using the same 120 ms debounce
as Lookup and matching on name and text.

**Cards** reuse the existing `.talent` shape — left rule, small-caps bold
title, `.src` citation — so a Combat result reads the same as a Lookup
result. Cost renders as a red `.chip.dark` (`1 bane`), `derive` as a bronze
chip, `requires` as a dim chip, and links as chips that switch the active
group and filter to the target entry.

**State: module-level, session-scoped.** The active group and query live in
module-level `let`, exactly as Lookup's `query` does. They survive tab
switches and reset on reload. No localStorage schema change; the app already
resets to the Build tab on reload (main.js:23), so persisting the Combat
filter would be half-persistent anyway.

## Accessibility

New markup meets the bar the predecessor spec set:

- Group and filter chips are `<button>` with `aria-pressed`, since they are
  toggles rather than tabs.
- The filter input carries a visually-hidden `<label>`.
- The results region is `aria-live="polite"` and announces a result count.
- Any expand affordance is a real `<button>`.

Two retrofits deliberately deferred in part one are also included, scoped
tightly:

- The tab bar (`index.html:34`) gains `role="tablist"` / `role="tab"` /
  `role="tabpanel"`, `aria-selected`, `aria-controls`, a roving `tabindex`,
  and arrow-key plus Home/End handling.
- Lookup's expand affordance (`lookup.js:64`) becomes a keyboard-operable
  button with `aria-expanded`, rather than a click handler on a paragraph.

## Testing

Both suites join the existing `npm test` chain. No new dependencies —
Python `unittest` and Node `node:test`, as the repo already uses.

**`scripts/tests/test_combat_data.py`** — reads only committed
`data/combat.json`, so it runs in a fresh clone with no PDF cache:

- Every entry has the common required fields; `id` values are unique.
- Every entry satisfies its kind's required fields, and carries no fields
  belonging to another kind.
- All nineteen afflictions are present by name, **including Immobilized**,
  which is the one routinely dropped from lists of them.
- All fourteen p.49 actions are present, **including Concentrate and
  Defend**, which are the two routinely missed.
- All five melee options, all three ranged options, and all eight attribute
  attacks are present by name.
- Every link ID in `inflicts` / `requires_condition` / `removes` /
  `see_also` resolves to an existing entry.
- Every `derive[].expr` is in the closed enum.
- Every entry cites a known book and a page; no `text` is empty.

**`js/ui/tests/combat.test.mjs`** — pure exported functions, no DOM:

- `filterEntries(entries, group, query)` — group filtering, case-insensitive
  text matching, empty query returns the group intact.
- `resolveDerive(expr, computed)` — each enum member; unknown expr returns
  null rather than throwing.
- `eligibility(entry, char, computed)` — returns `unknown` for each
  unanswerable `requires` type, `available` for an ungated entry.
- `resolveLinks(entry, byId)` — resolves present targets, drops absent ones.

## Risks

**The data file is hand-transcribed.** Nineteen afflictions, fourteen
actions, sixteen attacks and options, plus references — transcription errors
are the realistic failure mode, not architectural ones. The presence
assertions catch omissions; they cannot catch a mistyped number inside a
`text` field. The mitigation is that the source is committed and diffable:
every entry's text can be checked against the `data/rules-index.json` chunk
at the cited page.

**The eligibility layer ships inert.** It is deliberate and documented above,
but a future reader may find a tri-state resolver that only ever returns two
of its three states and assume it is broken. The code comment must say why.
