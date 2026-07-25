# Combat Quick Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a character-aware Combat quick reference tab covering actions, attack options, turn economy, afflictions, and modifiers.

**Architecture:** A hand-written `data/combat.json` holds ~60 entries in a schema discriminated by `kind`. A new `js/ui/combat.js` lazy-loads that file on first visit to the tab (never at boot), exports pure filter/derive/eligibility/link functions that Node tests exercise without a DOM, and renders chip-filtered cards using the existing `.panel` / `.chip` / `.talent` CSS. Python `unittest` validates the data file against the schema; Node `node:test` validates the pure functions.

**Tech Stack:** Vanilla ES modules, no build step. Python 3 `unittest`. Node `node:test`. **Zero runtime dependencies.**

## Global Constraints

- **No new dependencies.** `package.json` has no `dependencies` and must keep none. Do not add libraries to either the Python or the JS side.
- **Fresh-clone safe.** Anything running under `npm test` may read only committed `data/*.json`. `scripts/cache/` and `*.pdf` are gitignored and absent.
- **Verbatim rules text.** Entry `text` fields reproduce the Core Rulebook wording exactly, including its typographic apostrophes (`’`). Every entry cites book and page.
- **Style.** Python: 4-space indent, `snake_case`. JS: 2-space indent, `camelCase`, double quotes.
- **Never credit Claude or Anthropic** in commit messages, PR bodies, authors, or trailers.
- **`npm test` must stay green** after every task.

### Source of truth for entry text

The gitignored PDF cache is unavailable. Read every entry's text from the committed `data/rules-index.json`, which chunks the Core Rulebook cleanly. To read a chunk:

```bash
python3 -c "
import json
d = json.load(open('data/rules-index.json'))
for c in d:
    if c['t'] == 'Shove' and c['b'] == 'core' and c['p'] == 53:
        print(c['x'])
"
```

Two chunks on p.53 are damaged and **must be reconstructed by hand** from the adjacent chunks: `Situational Banes` has the body `"Target is . . ."` and its row data is flattened into a separate chunk titled `Effect`. Task 4 covers this.

### The derive expression enum

Exactly five values, referenced by Tasks 1, 2, 4, and 5:

| `expr` | resolves to |
|---|---|
| `str_mod` | `computed.modifiers.strength` |
| `speed` | `computed.speed` |
| `half_speed` | `Math.floor(computed.speed / 2)` |
| `size` | `computed.size` |
| `reach_from_size` | `Math.max(1, Math.ceil(computed.size))` — Core p.38: "A creature's reach equals its Size rounded up to the nearest whole number." |

---

### Task 1: Data schema validator and the Actions group

Establishes `data/combat.json` and the Python validator that guards it. Later data tasks extend the validator's presence checks; the structural checks written here are final.

**Files:**
- Create: `data/combat.json`
- Create: `scripts/tests/test_combat_data.py`
- Modify: `package.json` (no change needed — `unittest discover` picks the new file up automatically; verify only)

**Interfaces:**
- Produces: `data/combat.json` with top-level keys `version` (int), `groups` (array of `{id, label, blurb}`), `entries` (array). Entry common fields: `id`, `kind`, `name`, `group`, `source: {book, page}`, `text`. Optional: `inflicts`, `requires_condition`, `removes`, `see_also` (arrays of entry ids), `derive` (array of `{label, expr}`), `requires` (array of `{type, label}`).
- Produces: group ids `actions`, `attack-options`, `turn`, `afflictions`, `modifiers`.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test_combat_data.py`:

```python
"""Schema and coverage assertions for the hand-written combat reference.

data/combat.json is hand-transcribed rather than parsed, so these tests are
the only thing standing between a typo and a broken tab. They read only
committed data and so run in a fresh clone with no PDF cache.
"""

import json
import os
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMBAT_PATH = os.path.join(REPO, "data", "combat.json")

KINDS = {"action", "attack", "option", "condition", "reference"}
BOOKS = {"core", "occult", "terrible"}
DERIVE_EXPRS = {"str_mod", "speed", "half_speed", "size", "reach_from_size"}
LINK_FIELDS = ("inflicts", "requires_condition", "removes", "see_also")
REQUIRES_TYPES = {"condition", "equipment", "free_hand", "unloaded_weapon"}

# Fields each kind must carry beyond the common set, and fields that belong
# to that kind alone.
KIND_REQUIRED = {
    "action": ("economy",),
    "attack": ("attacker", "defender", "on_success"),
    "option": ("weapon_class", "cost", "on_success"),
    "condition": (),
    "reference": (),
}
KIND_EXCLUSIVE = {
    "economy": {"action"},
    "attacker": {"attack"},
    "defender": {"attack"},
    "size_rule": {"attack"},
    "weapon_class": {"option"},
    "rows": {"reference"},
}

ACTIONS = [
    "Attack", "Cast a Utility Spell", "Concentrate", "Defend", "End an Effect",
    "Find", "Help", "Hide", "Prepare", "Reload", "Retreat", "Rush",
    "Stabilize", "Use an Item",
]


def load():
    with open(COMBAT_PATH, encoding="utf-8") as fh:
        return json.load(fh)


class TestCombatSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load()
        cls.entries = cls.data["entries"]

    def test_envelope(self):
        self.assertEqual(self.data["version"], 1)
        self.assertTrue(self.data["groups"])
        for group in self.data["groups"]:
            for field in ("id", "label", "blurb"):
                self.assertTrue(group.get(field), f"group missing {field}: {group}")

    def test_ids_are_unique(self):
        ids = [e["id"] for e in self.entries]
        dupes = {i for i in ids if ids.count(i) > 1}
        self.assertEqual(dupes, set(), f"duplicate entry ids: {sorted(dupes)}")

    def test_common_fields(self):
        group_ids = {g["id"] for g in self.data["groups"]}
        for e in self.entries:
            self.assertIn(e["kind"], KINDS, e["id"])
            self.assertTrue(e["name"], e["id"])
            self.assertIn(e["group"], group_ids, e["id"])
            self.assertIn(e["source"]["book"], BOOKS, e["id"])
            self.assertIsInstance(e["source"]["page"], int, e["id"])
            self.assertTrue(e["text"].strip(), f"empty text: {e['id']}")

    def test_kind_specific_fields(self):
        for e in self.entries:
            for field in KIND_REQUIRED[e["kind"]]:
                self.assertIn(field, e, f"{e['id']} ({e['kind']}) missing {field}")
            for field, owners in KIND_EXCLUSIVE.items():
                if field in e:
                    self.assertIn(e["kind"], owners,
                                  f"{e['id']} is {e['kind']} but carries {field}")

    def test_links_resolve(self):
        known = {e["id"] for e in self.entries}
        for e in self.entries:
            for field in LINK_FIELDS:
                for target in e.get(field, []):
                    self.assertIn(target, known,
                                  f"{e['id']}.{field} points at missing {target!r}")

    def test_derive_exprs_are_known(self):
        for e in self.entries:
            for d in e.get("derive", []):
                self.assertTrue(d["label"], e["id"])
                self.assertIn(d["expr"], DERIVE_EXPRS,
                              f"{e['id']} uses unknown derive expr {d['expr']!r}")

    def test_requires_types_are_known(self):
        for e in self.entries:
            for r in e.get("requires", []):
                self.assertIn(r["type"], REQUIRES_TYPES, e["id"])
                self.assertTrue(r["label"], e["id"])


class TestActionCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = load()["entries"]

    def test_all_fourteen_actions_present(self):
        """Core p.49. Concentrate and Defend are the two routinely missed."""
        names = {e["name"] for e in self.entries if e["kind"] == "action"
                 and e["economy"] == "action"}
        self.assertEqual(names, set(ACTIONS),
                         f"missing: {sorted(set(ACTIONS) - names)}; "
                         f"unexpected: {sorted(names - set(ACTIONS))}")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: errors — `FileNotFoundError: data/combat.json`.

- [ ] **Step 3: Create `data/combat.json` with the five groups and the fourteen actions**

Read each action's text from `data/rules-index.json` (core p.49–50). Structure:

```json
{
  "version": 1,
  "groups": [
    { "id": "actions", "label": "Actions",
      "blurb": "One action per round. What you can spend it on." },
    { "id": "attack-options", "label": "Attack Options",
      "blurb": "Trade a bane for an effect, and attack an attribute directly." },
    { "id": "turn", "label": "Turn & Economy",
      "blurb": "Fast and slow turns, triggered actions, free attacks, minor activities." },
    { "id": "afflictions", "label": "Afflictions",
      "blurb": "The nineteen conditions and what each one does to you." },
    { "id": "modifiers", "label": "Modifiers",
      "blurb": "Cover, obscurement, range bands, and the common situational banes." }
  ],
  "entries": [
    {
      "id": "action-attack",
      "kind": "action",
      "name": "Attack",
      "group": "actions",
      "economy": "action",
      "source": { "book": "core", "page": 49 },
      "text": "You use a weapon, an attack spell, or something else to harm or hinder another creature or an object. See Making Attacks for how to resolve this activity.",
      "see_also": ["charge"]
    },
    {
      "id": "action-concentrate",
      "kind": "action",
      "name": "Concentrate",
      "group": "actions",
      "economy": "action",
      "source": { "book": "core", "page": 49 },
      "text": "Some spell effects and talents require you to concentrate to keep them going. If you concentrate on an effect, the effect continues until the end of the next round, up to the maximum amount of time allowed by the spell."
    },
    {
      "id": "action-defend",
      "kind": "action",
      "name": "Defend",
      "group": "actions",
      "economy": "action",
      "source": { "book": "core", "page": 49 },
      "text": "When you defend, until the end of the round, all attack rolls are made against you with 1 bane and you make all challenge rolls to resist attacks with 1 boon. These benefits end if you are prevented from using actions, such as when you become dazed, stunned, or unconscious.",
      "see_also": ["affliction-dazed", "affliction-stunned", "affliction-unconscious"]
    }
  ]
}
```

Author all fourteen with `"economy": "action"` and ids `action-attack`, `action-cast-a-utility-spell`, `action-concentrate`, `action-defend`, `action-end-an-effect`, `action-find`, `action-help`, `action-hide`, `action-prepare`, `action-reload`, `action-retreat`, `action-rush`, `action-stabilize`, `action-use-an-item`.

Two notes while authoring:

- `see_also` targets that do not exist yet (`charge`, `affliction-dazed`, …) will fail `test_links_resolve`. Either omit those `see_also` arrays now and add them in Tasks 2–3, or author the file so links only point at entries that already exist. **Omit them now** — Tasks 2 and 3 add them once the targets land.
- `action-reload` gets `"requires": [{ "type": "unloaded_weapon", "label": "a weapon that needs reloading" }]`. `action-hide` and the rest carry no `requires`.

- [ ] **Step 4: Run test to verify it passes**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Verify the whole suite is still green and commit**

```bash
npm test
```

```bash
git add data/combat.json scripts/tests/test_combat_data.py
git commit -m "Add combat reference data schema and the action list"
```

---

### Task 2: Attack options, attribute attacks, and Charge

The heart of the user's ask: the bane-for-effect family.

**Files:**
- Modify: `data/combat.json`
- Modify: `scripts/tests/test_combat_data.py`

**Interfaces:**
- Consumes: the envelope and `entries` array from Task 1.
- Produces: entry ids `charge`, `melee-*` (5), `ranged-*` (3), and the eight attribute attacks (`attack-disarm`, `attack-distract`, `attack-escape`, `attack-feint`, `attack-grab`, `attack-knock-down`, `attack-pull`, `attack-shove`). Tasks 3 and 4 link to these.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/test_combat_data.py`, after `TestActionCoverage`:

```python
MELEE_OPTIONS = ["Driving Attack", "Guarded Attack", "Lunging Attack",
                 "Shifting Attack", "Unbalancing Attack"]
RANGED_OPTIONS = ["Called Shot", "Distant Shot", "Staggering Shot"]
ATTRIBUTE_ATTACKS = ["Disarm", "Distract", "Escape", "Feint", "Grab",
                     "Knock Down", "Pull", "Shove"]


class TestAttackCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = load()["entries"]

    def by_kind(self, kind, **match):
        return [e for e in self.entries if e["kind"] == kind
                and all(e.get(k) == v for k, v in match.items())]

    def test_melee_options_present(self):
        """Core p.51 — all five live inside one 'Melee Attack Options' chunk."""
        names = {e["name"] for e in self.by_kind("option", weapon_class="melee")}
        self.assertEqual(names, set(MELEE_OPTIONS))

    def test_ranged_options_present(self):
        """Core p.52 — all three live inside one 'Ranged Attack Options' chunk."""
        names = {e["name"] for e in self.by_kind("option", weapon_class="ranged")}
        self.assertEqual(names, set(RANGED_OPTIONS))

    def test_attribute_attacks_present(self):
        """Core p.52-53."""
        names = {e["name"] for e in self.by_kind("attack")}
        self.assertEqual(names, set(ATTRIBUTE_ATTACKS))

    def test_every_option_costs_at_least_one_bane(self):
        """The whole family is 'pay a bane, get an effect'."""
        for e in self.by_kind("option"):
            self.assertGreaterEqual(e["cost"]["banes"], 1, e["id"])

    def test_charge_exists_and_is_an_action(self):
        """Charge is described under Making Attacks (p.53), not in the p.49 list."""
        charge = [e for e in self.entries if e["id"] == "charge"]
        self.assertEqual(len(charge), 1)
        self.assertEqual(charge[0]["economy"], "action")

    def test_disarm_defends_against_the_higher_of_two(self):
        """Disarm is the one attack whose defender is a choice, not a value."""
        disarm = next(e for e in self.entries if e["id"] == "attack-disarm")
        self.assertIsInstance(disarm["defender"], list)
        self.assertEqual(len(disarm["defender"]), 2)

    def test_size_dependent_attacks_carry_a_size_rule(self):
        for entry_id in ("attack-knock-down", "attack-shove"):
            e = next(x for x in self.entries if x["id"] == entry_id)
            self.assertTrue(e["size_rule"].strip(), entry_id)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: FAIL — `test_melee_options_present` gets `set()` vs the five names; `test_charge_exists_and_is_an_action` gets `StopIteration`/length 0.

- [ ] **Step 3: Add the entries to `data/combat.json`**

Split `Melee Attack Options` (core p.51) and `Ranged Attack Options` (core p.52) by hand — the option names are inline bold runs, so each becomes its own entry with only its own sentence as `text`. Shape:

```json
{
  "id": "melee-shifting-attack",
  "kind": "option",
  "name": "Shifting Attack",
  "group": "attack-options",
  "weapon_class": "melee",
  "cost": { "banes": 1 },
  "on_success": "Your movement does not trigger free attacks from the target until the end of the round.",
  "source": { "book": "core", "page": 51 },
  "text": "You make the attack roll with 1 bane. On a success, your movement does not trigger free attacks from the target until the end of the round.",
  "see_also": ["free-attack"]
},
{
  "id": "melee-driving-attack",
  "kind": "option",
  "name": "Driving Attack",
  "group": "attack-options",
  "weapon_class": "melee",
  "cost": { "banes": 1 },
  "on_success": "You and the target move a number of yards equal to your Strength modifier in the same direction.",
  "source": { "book": "core", "page": 51 },
  "text": "You make the attack roll with 1 bane. On a success, you and the target move a number of yards equal to your Strength modifier in the same direction.",
  "derive": [{ "label": "You both move", "expr": "str_mod" }]
},
{
  "id": "melee-unbalancing-attack",
  "kind": "option",
  "name": "Unbalancing Attack",
  "group": "attack-options",
  "weapon_class": "melee",
  "cost": { "banes": 1 },
  "on_success": "If the target is your Size or smaller, it must make an Agility challenge roll. On a failure, the target falls prone.",
  "source": { "book": "core", "page": 51 },
  "text": "You make the attack roll with 1 bane. On a success, if the target is your Size or smaller, it must make an Agility challenge roll. On a failure, the target falls prone.",
  "derive": [{ "label": "Your Size", "expr": "size" }],
  "inflicts": ["affliction-prone"]
},
{
  "id": "melee-lunging-attack",
  "kind": "option",
  "name": "Lunging Attack",
  "group": "attack-options",
  "weapon_class": "melee",
  "cost": { "banes": 1 },
  "on_success": "Your reach increases by 1 yard for the attack.",
  "source": { "book": "core", "page": 51 },
  "text": "You can increase your reach by 1 yard, but you make the attack roll with 1 bane.",
  "derive": [{ "label": "Base reach from Size", "expr": "reach_from_size" }]
}
```

`melee-guarded-attack` and the three ranged options follow the same shape. `ranged-called-shot` and `ranged-staggering-shot` take `"cost": { "banes": 2 }`; `ranged-staggering-shot` gets `"inflicts": ["affliction-prone"]`.

Attribute attacks use `kind: "attack"`:

```json
{
  "id": "attack-shove",
  "kind": "attack",
  "name": "Shove",
  "group": "attack-options",
  "attacker": "Strength",
  "defender": "Strength",
  "on_success": "You move the target 1 yard away from you, plus a number of yards equal to your Strength modifier (minimum total distance 1 yard).",
  "size_rule": "1 bane for each point of Size the target is larger than you; 1 boon if it is smaller.",
  "source": { "book": "core", "page": 53 },
  "text": "Choose one target creature within your reach. Make a Strength attack roll against the target’s Strength. If the target is larger than you, you make this roll with 1 bane for each point of Size it is larger. You make this roll with 1 boon if the target is smaller than you. On a success, you move the target 1 yard away from you, plus a number of yards equal to your Strength modifier (minimum total distance 1 yard).",
  "derive": [
    { "label": "Push distance beyond the first yard", "expr": "str_mod" },
    { "label": "Your reach", "expr": "reach_from_size" },
    { "label": "Your Size", "expr": "size" }
  ]
},
{
  "id": "attack-disarm",
  "kind": "attack",
  "name": "Disarm",
  "group": "attack-options",
  "attacker": "Strength or Agility",
  "defender": ["Strength", "Agility"],
  "on_success": "The target drops one object it is holding.",
  "source": { "book": "core", "page": 52 },
  "text": "<verbatim text of the Disarm chunk, core p.52>"
},
{
  "id": "attack-escape",
  "kind": "attack",
  "name": "Escape",
  "group": "attack-options",
  "attacker": "Strength or Agility",
  "defender": "Strength",
  "on_success": "The grabbed affliction is removed and you can move up to half your Speed without triggering a free attack from the creature that had grabbed you.",
  "source": { "book": "core", "page": 53 },
  "text": "You can use this action if you are grabbed. Make a Strength or Agility attack roll against the Strength of the creature that has grabbed you. A success removes the grabbed affliction and lets you move up to half your Speed. This movement does not trigger free attacks from the creature that had grabbed you. (See Grabbed for information on the effects of being grabbed, and Grab for how to grab.)",
  "requires": [{ "type": "condition", "label": "you are grabbed" }],
  "requires_condition": ["affliction-grabbed"],
  "removes": ["affliction-grabbed"],
  "derive": [{ "label": "Movement on a success", "expr": "half_speed" }],
  "see_also": ["attack-grab", "free-attack"]
}
```

`attack-grab` carries `"requires": [{ "type": "free_hand", "label": "at least one free hand" }]` and `"inflicts": ["affliction-grabbed"]`. `attack-knock-down` carries `size_rule` and `"inflicts": ["affliction-prone"]`. `attack-pull` carries `"requires": [{ "type": "condition", "label": "you are grabbing the target" }]`.

Charge (core p.53) is `kind: "action"`, group `attack-options`, `economy: "action"`, id `charge`, with `"derive": [{ "label": "Move up to", "expr": "speed" }]` and `"see_also": ["attack-knock-down", "attack-shove"]`.

Finally, add the `see_also` arrays deferred from Task 1 — `action-attack` → `["charge"]`.

- [ ] **Step 4: Run test to verify it passes**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: PASS. `test_links_resolve` will fail on `affliction-prone` / `affliction-grabbed` until Task 3 — **so hold those three link arrays back to Task 3** exactly as Task 1 held its own. Add `inflicts`, `requires_condition`, and `removes` in Task 3 Step 3.

- [ ] **Step 5: Commit**

```bash
npm test
```

```bash
git add data/combat.json scripts/tests/test_combat_data.py
git commit -m "Add attack options, attribute attacks, and charge to the combat reference"
```

---

### Task 3: The nineteen afflictions

**Files:**
- Modify: `data/combat.json`
- Modify: `scripts/tests/test_combat_data.py`

**Interfaces:**
- Consumes: entry ids from Tasks 1–2.
- Produces: entry ids `affliction-<slug>` for all nineteen. Task 4 and Task 6 link to `affliction-blinded` and `affliction-prone`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/test_combat_data.py`:

```python
# Core p.42-43. Nineteen, not eighteen: Immobilized is the one routinely
# dropped from lists of these. Disabled, Dying, and Incapacitated are p.41
# health states and are deliberately not here.
AFFLICTIONS = [
    "Asleep", "Blinded", "Charmed", "Compelled", "Dazed", "Deafened",
    "Defenseless", "Diseased", "Fatigued", "Frightened", "Grabbed",
    "Immobilized", "Impaired", "Poisoned", "Prone", "Slowed", "Stunned",
    "Surprised", "Unconscious",
]


class TestAfflictionCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = load()["entries"]

    def test_all_nineteen_afflictions_present(self):
        names = {e["name"] for e in self.entries if e["kind"] == "condition"}
        self.assertEqual(names, set(AFFLICTIONS),
                         f"missing: {sorted(set(AFFLICTIONS) - names)}; "
                         f"unexpected: {sorted(names - set(AFFLICTIONS))}")

    def test_there_are_exactly_nineteen(self):
        self.assertEqual(len([e for e in self.entries if e["kind"] == "condition"]), 19)

    def test_health_states_are_not_afflictions(self):
        """Disabled/Dying/Incapacitated are p.41 health states, a separate group."""
        names = {e["name"] for e in self.entries if e["kind"] == "condition"}
        self.assertEqual(names & {"Disabled", "Dying", "Incapacitated"}, set())

    def test_afflictions_are_all_in_the_afflictions_group(self):
        for e in self.entries:
            if e["kind"] == "condition":
                self.assertEqual(e["group"], "afflictions", e["id"])

    def test_inflict_links_point_at_conditions(self):
        by_id = {e["id"]: e for e in self.entries}
        for e in self.entries:
            for field in ("inflicts", "requires_condition", "removes"):
                for target in e.get(field, []):
                    self.assertEqual(by_id[target]["kind"], "condition",
                                     f"{e['id']}.{field} -> {target} is not a condition")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: FAIL — `test_all_nineteen_afflictions_present` reports all nineteen missing.

- [ ] **Step 3: Add the nineteen conditions and restore the held-back links**

Each is `kind: "condition"`, `group: "afflictions"`, id `affliction-<kebab name>`, text read verbatim from the matching `data/rules-index.json` chunk on core p.42 or p.43. Example:

```json
{
  "id": "affliction-prone",
  "kind": "condition",
  "name": "Prone",
  "group": "afflictions",
  "source": { "book": "core", "page": 43 },
  "text": "A prone creature lies on the ground. Other creatures can move through its space. While prone, the creature can move by crawling or can use its move to stand up. The prone creature makes Strength and Agility rolls with 1 bane. Creatures that can reach the prone creature make all attack rolls against it with 1 boon, while creatures that cannot reach it make attack rolls against its Defense with 1 bane."
},
{
  "id": "affliction-grabbed",
  "kind": "condition",
  "name": "Grabbed",
  "group": "afflictions",
  "source": { "book": "core", "page": 42 },
  "text": "The effects of the affliction depend on the creature’s Size. If the grabbed creature’s Size is equal to or smaller than that of the creature grabbing it, the grabbed creature cannot move away from the creature that grabbed it until it removes the affliction. If the grabbed creature’s Size is larger than that of the creature grabbing it, whenever the grabbed creature moves, the creature grabbing it can choose to move with it (by clinging to the grabbed creature’s body) or end the grab. (See Grab for more information on how to grab, and Escape for how to escape a grab.)",
  "see_also": ["attack-grab", "attack-escape"]
}
```

Page split, so nothing is missed: **p.42** — Asleep, Blinded, Charmed, Compelled, Dazed, Deafened, Defenseless, Diseased, Fatigued, Frightened, Grabbed, Immobilized. **p.43** — Impaired, Poisoned, Prone, Slowed, Stunned, Surprised, Unconscious.

Now restore the link arrays held back from Tasks 1 and 2:

- `action-defend` → `"see_also": ["affliction-dazed", "affliction-stunned", "affliction-unconscious"]`
- `melee-unbalancing-attack`, `ranged-staggering-shot`, `attack-knock-down` → `"inflicts": ["affliction-prone"]`
- `attack-grab` → `"inflicts": ["affliction-grabbed"]`
- `attack-escape` → `"requires_condition": ["affliction-grabbed"]`, `"removes": ["affliction-grabbed"]`

- [ ] **Step 4: Run test to verify it passes**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: PASS, all classes.

- [ ] **Step 5: Commit**

```bash
npm test
```

```bash
git add data/combat.json scripts/tests/test_combat_data.py
git commit -m "Add the nineteen afflictions to the combat reference"
```

---

### Task 4: Turn economy and modifiers — completes the data file

**Files:**
- Modify: `data/combat.json`
- Modify: `scripts/tests/test_combat_data.py`

**Interfaces:**
- Produces: `free-attack`, `triggered-actions`, `minor-activities`, `fast-turns`, `slow-turns`, `anatomy-of-a-round`, `cover`, `obscurement`, `range-bands`, `situational-banes`. Task 2 links to `free-attack`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/test_combat_data.py`:

```python
class TestTurnAndModifierCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = load()["entries"]
        cls.by_id = {e["id"]: e for e in cls.entries}

    def test_turn_structure_entries_present(self):
        for entry_id in ("anatomy-of-a-round", "fast-turns", "slow-turns",
                         "triggered-actions", "free-attack", "minor-activities"):
            self.assertIn(entry_id, self.by_id)
            self.assertEqual(self.by_id[entry_id]["group"], "turn", entry_id)

    def test_free_attack_is_a_triggered_action(self):
        self.assertEqual(self.by_id["free-attack"]["economy"], "triggered")

    def test_minor_activities_are_free(self):
        self.assertEqual(self.by_id["minor-activities"]["economy"], "free")

    def test_modifier_entries_present(self):
        for entry_id in ("cover", "obscurement", "range-bands", "situational-banes"):
            self.assertIn(entry_id, self.by_id)
            self.assertEqual(self.by_id[entry_id]["group"], "modifiers", entry_id)

    def test_tabular_modifiers_carry_rows(self):
        """These four are tables in the book. The rules index flattened the
        p.53 banes table into prose; combat.json reconstructs it as rows."""
        for entry_id in ("cover", "obscurement", "range-bands", "situational-banes"):
            rows = self.by_id[entry_id].get("rows")
            self.assertTrue(rows, f"{entry_id} has no rows")
            for row in rows:
                self.assertTrue(row["label"].strip(), entry_id)
                self.assertTrue(row["effect"].strip(), entry_id)

    def test_range_bands_cover_all_six(self):
        labels = {r["label"] for r in self.by_id["range-bands"]["rows"]}
        self.assertEqual(labels, {"You", "Reach", "Short", "Medium", "Long",
                                  "Extreme", "Sight"})

    def test_cover_has_three_degrees(self):
        labels = {r["label"] for r in self.by_id["cover"]["rows"]}
        self.assertEqual(labels, {"Half covered", "Three-quarters covered",
                                  "Totally covered"})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: FAIL — `test_turn_structure_entries_present` reports `anatomy-of-a-round` not in the id map.

- [ ] **Step 3: Add the turn and modifier entries**

Turn entries are `kind: "action"` when they consume a slice of the economy (so `economy` distinguishes them) and `kind: "reference"` when they merely describe structure:

```json
{
  "id": "anatomy-of-a-round",
  "kind": "reference",
  "name": "Anatomy of a Round",
  "group": "turn",
  "source": { "book": "core", "page": 47 },
  "text": "Combat is resolved in 10-second units of time, called rounds. A round has three parts: fast turns, slow turns, and the end of the round. During each round, players who want to take a turn (fast or slow) do so in that part of the round, in any order they choose. Once a player finishes his or her turn, he or she cannot take another turn until after the end of that round. If players cannot decide who goes first, the GM might decide or have each conflicting player roll a d6, with priority going to the player who rolled the highest number. Once all the players have finished taking their turns during a part of the round, creatures under the GM’s control can take turns in that part, in any order. Once a creature finishes its turn, it cannot take another turn until after the end of that round.",
  "see_also": ["fast-turns", "slow-turns"]
},
{
  "id": "fast-turns",
  "kind": "reference",
  "name": "Fast Turns",
  "group": "turn",
  "source": { "book": "core", "page": 47 },
  "text": "A creature that takes a fast turn can either use an action or move up to its Speed. It cannot do both.",
  "derive": [{ "label": "Your Speed", "expr": "speed" }]
},
{
  "id": "free-attack",
  "kind": "action",
  "name": "Free Attack",
  "group": "turn",
  "economy": "triggered",
  "source": { "book": "core", "page": 51 },
  "text": "When a creature in your reach willingly moves out of your reach, you can use a triggered action to make an attack against that creature using a melee weapon you are wielding.",
  "derive": [{ "label": "Your reach", "expr": "reach_from_size" }],
  "see_also": ["melee-shifting-attack", "attack-escape"]
},
{
  "id": "minor-activities",
  "kind": "action",
  "name": "Minor Activities",
  "group": "turn",
  "economy": "free",
  "source": { "book": "core", "page": 51 },
  "text": "Some activities are so minor that you can just do them on your turn without using an action, triggered action, or move. Examples include dropping an item or picking one up, drawing or stowing a weapon, and opening or closing a door. As a general rule, you can perform one minor activity during a fast turn, or two during a slow turn. You might do more if you don’t move or use an action on your turn, or if your GM says you can do more."
}
```

`slow-turns` mirrors `fast-turns` (p.47, with its own `derive` on `speed`). `triggered-actions` is `kind: "action"`, `economy: "triggered"`, text from the p.50 chunk.

**Note for the validator:** `test_all_fourteen_actions_present` filters on `economy == "action"`, so `free-attack`, `triggered-actions`, and `minor-activities` do not disturb it. `charge` from Task 2 does have `economy: "action"` — it will break that assertion. Fix it by narrowing the filter to the `actions` group:

```python
    def test_all_fourteen_actions_present(self):
        """Core p.49. Concentrate and Defend are the two routinely missed.

        Filtered to the actions group: Charge (p.53) and Free Attack (p.51)
        are also actions but are not on the p.49 list.
        """
        names = {e["name"] for e in self.entries
                 if e["kind"] == "action" and e["group"] == "actions"}
```

Modifiers are `kind: "reference"` with `rows`:

```json
{
  "id": "cover",
  "kind": "reference",
  "name": "Cover",
  "group": "modifiers",
  "source": { "book": "core", "page": 52 },
  "text": "Terrain and objects on the battlefield can provide protection against attacks with ranged weapons or spells that target things at a distance.",
  "rows": [
    { "label": "Half covered",
      "effect": "An object between you and the attacker covers at least half your body: ranged attack rolls against you are made with 1 bane." },
    { "label": "Three-quarters covered",
      "effect": "An object covers at least three-quarters of your body: ranged attack rolls against you are made with 2 banes." },
    { "label": "Totally covered",
      "effect": "An object covers your body entirely: you cannot be a target for any attack or effect." }
  ]
},
{
  "id": "situational-banes",
  "kind": "reference",
  "name": "Situational Banes to Attack Rolls",
  "group": "modifiers",
  "source": { "book": "core", "page": 53 },
  "text": "One or more banes might apply to your attack rolls, based on the circumstances under which you make the attack. These are in addition to any banes or boons included in the attack. The following table summarizes the most common situations.",
  "rows": [
    { "label": "Half covered", "effect": "1 bane" },
    { "label": "Three-quarters covered", "effect": "2 banes" },
    { "label": "Totally covered", "effect": "Automatic failure" },
    { "label": "Partially obscured", "effect": "1 bane" },
    { "label": "Heavily obscured", "effect": "2 banes" },
    { "label": "Totally obscured", "effect": "3 banes — you must guess the target’s location (see Hide)." },
    { "label": "Weather, terrain", "effect": "In inclement weather or covering terrain: 1 or more banes" }
  ],
  "see_also": ["cover", "obscurement", "action-hide"]
}
```

`situational-banes` is the reconstruction described in the Global Constraints: its `text` comes from the `Situational Banes to Attack Rolls` chunk and its `rows` from the flattened `Effect` chunk on p.53. `obscurement` (p.44) gets rows for Partially / Heavily / Totally Obscured, with `"inflicts": ["affliction-blinded"]` since a totally obscured creature is blinded. `range-bands` (p.44, `Range and Distance`) gets seven rows: You, Reach, Short, Medium, Long, Extreme, Sight — with `"derive": [{ "label": "Your reach", "expr": "reach_from_size" }]`.

- [ ] **Step 4: Run test to verify it passes**

```bash
python3 -m unittest discover -s scripts/tests -t scripts/tests -k combat -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test
```

```bash
git add data/combat.json scripts/tests/test_combat_data.py
git commit -m "Add turn economy and modifier references to the combat data"
```

---

### Task 5: Pure logic module and Node tests

Everything testable without a DOM lands here. Task 6 adds the rendering on top.

**Files:**
- Create: `js/ui/combat.js`
- Create: `js/ui/tests/combat.test.mjs`

**Interfaces:**
- Produces, all named exports from `js/ui/combat.js`:
  - `filterEntries(entries, groupId, query)` → `Array` — `groupId` of `"all"` matches every group; empty/whitespace `query` matches everything; otherwise case-insensitive substring against `name` and `text`.
  - `resolveDerive(expr, computed)` → `number | null` — `null` for an unknown `expr` or a null `computed`.
  - `eligibility(entry, char, computed)` → `"available" | "unavailable" | "unknown"`.
  - `resolveLinks(entry, byId)` → `{inflicts, requires_condition, removes, see_also}` of resolved entry objects, absent targets dropped.
  - `DERIVE_EXPRS` → the frozen enum object.
- Task 6 consumes all five.

- [ ] **Step 1: Write the failing test**

Create `js/ui/tests/combat.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { filterEntries, resolveDerive, eligibility, resolveLinks } from "../combat.js";

const PRONE = { id: "affliction-prone", kind: "condition", name: "Prone", group: "afflictions", text: "A prone creature lies on the ground." };
const SHOVE = { id: "attack-shove", kind: "attack", name: "Shove", group: "attack-options", text: "Make a Strength attack roll against the target’s Strength." };
const ESCAPE = { id: "attack-escape", kind: "attack", name: "Escape", group: "attack-options", text: "You can use this action if you are grabbed.", requires: [{ type: "condition", label: "you are grabbed" }], removes: ["affliction-grabbed"], see_also: ["attack-grab"] };
const ENTRIES = [PRONE, SHOVE, ESCAPE];

test("filterEntries returns every entry for the all group and an empty query", () => {
  assert.equal(filterEntries(ENTRIES, "all", "").length, 3);
  assert.equal(filterEntries(ENTRIES, "all", "   ").length, 3);
});

test("filterEntries narrows by group", () => {
  assert.deepEqual(filterEntries(ENTRIES, "afflictions", "").map((e) => e.id), ["affliction-prone"]);
});

test("filterEntries matches name and text case-insensitively", () => {
  assert.deepEqual(filterEntries(ENTRIES, "all", "SHOVE").map((e) => e.id), ["attack-shove"]);
  assert.deepEqual(filterEntries(ENTRIES, "all", "lies on the ground").map((e) => e.id), ["affliction-prone"]);
});

test("filterEntries applies group and query together", () => {
  assert.equal(filterEntries(ENTRIES, "afflictions", "shove").length, 0);
});

test("resolveDerive computes each enum member", () => {
  const computed = { modifiers: { strength: 3 }, speed: 10, size: 1 };
  assert.equal(resolveDerive("str_mod", computed), 3);
  assert.equal(resolveDerive("speed", computed), 10);
  assert.equal(resolveDerive("half_speed", computed), 5);
  assert.equal(resolveDerive("size", computed), 1);
  assert.equal(resolveDerive("reach_from_size", computed), 1);
});

test("resolveDerive rounds odd speed down and fractional Size up", () => {
  assert.equal(resolveDerive("half_speed", { speed: 9 }), 4);
  // Halflings are Size 1/2; Core p.38 rounds reach up, minimum 1 yard.
  assert.equal(resolveDerive("reach_from_size", { size: 0.5 }), 1);
  assert.equal(resolveDerive("reach_from_size", { size: 2 }), 2);
});

test("resolveDerive returns null rather than throwing on bad input", () => {
  assert.equal(resolveDerive("nonsense", { speed: 10 }), null);
  assert.equal(resolveDerive("speed", null), null);
});

test("eligibility is available for an ungated entry", () => {
  assert.equal(eligibility(SHOVE, {}, { speed: 10 }), "available");
});

test("eligibility is unknown for every requirement the engine cannot answer", () => {
  for (const type of ["condition", "equipment", "free_hand", "unloaded_weapon"]) {
    const entry = { ...SHOVE, requires: [{ type, label: "x" }] };
    assert.equal(eligibility(entry, {}, { speed: 10 }), "unknown", type);
  }
});

test("eligibility is available with no character rather than unavailable", () => {
  assert.equal(eligibility(SHOVE, null, null), "available");
});

test("resolveLinks resolves present targets and drops absent ones", () => {
  const byId = new Map(ENTRIES.map((e) => [e.id, e]));
  const links = resolveLinks(ESCAPE, byId);
  // affliction-grabbed and attack-grab are not in byId, so both drop.
  assert.deepEqual(links.removes, []);
  assert.deepEqual(links.see_also, []);
  const withProne = resolveLinks({ ...ESCAPE, inflicts: ["affliction-prone"] }, byId);
  assert.deepEqual(withProne.inflicts.map((e) => e.id), ["affliction-prone"]);
});

test("resolveLinks returns all four arrays even when the entry has none", () => {
  const links = resolveLinks(PRONE, new Map());
  assert.deepEqual(Object.keys(links).sort(), ["inflicts", "removes", "requires_condition", "see_also"]);
  assert.deepEqual(links.inflicts, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test "js/ui/tests/combat.test.mjs"
```

Expected: FAIL — `Cannot find module .../js/ui/combat.js`.

- [ ] **Step 3: Write the module's pure half**

Create `js/ui/combat.js`:

```javascript
// Combat tab: a character-aware quick reference for actions, attack options,
// turn economy, afflictions, and modifiers.
//
// data/combat.json is hand-written rather than parsed (see
// docs/superpowers/specs/2026-07-25-combat-quick-reference-design.md). It is
// loaded lazily on first visit rather than in loadRules(), so a malformed
// file breaks this tab alone instead of bricking boot.

const LINK_FIELDS = ["inflicts", "requires_condition", "removes", "see_also"];

// Each expression is backed by a field compute() actually returns. Adding a
// value here without adding it to DERIVE_EXPRS in
// scripts/tests/test_combat_data.py will fail the build, which is the point.
export const DERIVE_EXPRS = Object.freeze({
  str_mod: (c) => c.modifiers?.strength ?? null,
  speed: (c) => c.speed ?? null,
  half_speed: (c) => (c.speed == null ? null : Math.floor(c.speed / 2)),
  size: (c) => c.size ?? null,
  // Core p.38: reach equals Size rounded up. Halflings are Size 1/2, so the
  // floor of 1 yard matters. Weapons can modify reach; this is the baseline.
  reach_from_size: (c) => (c.size == null ? null : Math.max(1, Math.ceil(c.size))),
});

export function filterEntries(entries, groupId, query) {
  const q = (query || "").trim().toLowerCase();
  return entries.filter((e) => {
    if (groupId && groupId !== "all" && e.group !== groupId) return false;
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.text.toLowerCase().includes(q);
  });
}

export function resolveDerive(expr, computed) {
  if (!computed) return null;
  const fn = DERIVE_EXPRS[expr];
  return fn ? fn(computed) : null;
}

// Tri-state on purpose. The app tracks damage, Insanity, and Corruption but
// not afflictions; gear.js drops a weapon's category when copying it into
// inventory; and there is no hand-slot or ammo model. So none of the four
// requirement types can be answered today and every gated entry comes back
// "unknown", which the renderer shows as a condition chip at full weight.
// Only "unavailable" de-emphasises, so nothing currently dims. This function
// is the single seam where real answers slot in once inventory carries a
// stable equipment identity and category.
export function eligibility(entry, char, computed) {
  const requires = entry.requires || [];
  if (!requires.length) return "available";
  return "unknown";
}

export function resolveLinks(entry, byId) {
  const out = {};
  for (const field of LINK_FIELDS) {
    out[field] = (entry[field] || []).map((id) => byId.get(id)).filter(Boolean);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test "js/ui/tests/combat.test.mjs"
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
npm test
```

```bash
git add js/ui/combat.js js/ui/tests/combat.test.mjs
git commit -m "Add combat reference filtering, derive, and link resolution"
```

---

### Task 6: The Combat tab — loader, renderer, and wiring

**Files:**
- Modify: `js/ui/combat.js` (append the loader and renderer)
- Modify: `index.html:34-51` (tab button and panel)
- Modify: `js/main.js:5-21` (import and route)
- Modify: `css/app.css` (three small additions)

**Interfaces:**
- Consumes: `filterEntries`, `resolveDerive`, `eligibility`, `resolveLinks` from Task 5; `data/combat.json` from Tasks 1–4.
- Consumes: `active()` from `js/state.js`, `compute()` from `js/engine.js`.
- Produces: `renderCombat(el)` — the signature every other tab renderer uses.

- [ ] **Step 1: Append the loader and renderer to `js/ui/combat.js`**

There is no unit test for this step — it is DOM rendering, and the repo has no DOM test harness. Step 3 verifies it in a browser instead.

```javascript
import { active } from "../state.js";
import { compute } from "../engine.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const BOOKS = { core: "Core Rulebook", occult: "Occult Philosophy", terrible: "Terrible Beauty" };

let data = null;      // {version, groups, entries}
let byId = new Map();
let loading = null;
let dataError = null;
// Session-scoped, exactly as lookup.js keeps its query: these survive tab
// switches and reset on reload.
let group = "all";
let query = "";

function ensureData() {
  if (data) return Promise.resolve(data);
  if (!loading) {
    loading = fetch("data/combat.json")
      .then((r) => {
        if (!r.ok) throw new Error(`combat.json: ${r.status}`);
        return r.json();
      })
      .then((json) => {
        data = json;
        byId = new Map(json.entries.map((e) => [e.id, e]));
        dataError = null;
        return data;
      })
      .catch((err) => {
        loading = null;            // allow a retry
        dataError = err;
        throw err;
      });
  }
  return loading;
}

// compute() dereferences char.ancestry on its first statement and throws on
// null, so the no-character path must never reach it. Unlike every other tab,
// this one still renders its full content — a reference that shows nothing
// without a character is useless. It just omits the derived values.
function computedFor(char) {
  if (!char) return null;
  try {
    return compute(char);
  } catch (err) {
    console.error("combat: compute() failed, falling back to no-derive mode", err);
    return null;
  }
}

export function renderCombat(el) {
  const char = active();
  const computed = computedFor(char);

  el.innerHTML = `
  <div class="panel">
    <h2 class="rubric">Combat Reference <span class="count" id="cb-count"></span></h2>
    <div class="filter-bar">
      <label class="sr-only" for="cb-q">Filter combat entries</label>
      <input type="text" id="cb-q" placeholder="shove, prone, bane, triggered…" value="${esc(query)}" autocomplete="off">
    </div>
    <div class="chip-row" id="cb-groups" style="margin-bottom:14px"></div>
    <div id="cb-results" aria-live="polite"></div>
  </div>`;

  const input = el.querySelector("#cb-q");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = input.value; paint(el, computed); }, 120);
  });
  el.querySelector("#cb-groups").addEventListener("click", (e) => {
    const g = e.target.closest("[data-group]")?.dataset.group;
    if (!g) return;
    group = g;
    paint(el, computed);
  });
  el.querySelector("#cb-results").addEventListener("click", (e) => {
    const link = e.target.closest("[data-goto]");
    if (!link) return;
    const target = byId.get(link.dataset.goto);
    if (!target) return;
    group = target.group;
    query = target.name;
    el.querySelector("#cb-q").value = target.name;
    paint(el, computed);
  });

  paint(el, computed);
  ensureData().then(() => paint(el, computed)).catch(() => paint(el, computed));
}

function paint(el, computed) {
  const groups = el.querySelector("#cb-groups");
  const box = el.querySelector("#cb-results");
  const count = el.querySelector("#cb-count");
  if (!box) return;

  if (dataError) {
    groups.innerHTML = "";
    count.textContent = "";
    box.innerHTML = `<p class="empty">The war-book is unreachable — ${esc(dataError.message)}.
      <button class="btn btn-small" id="cb-retry">Try again</button></p>`;
    el.querySelector("#cb-retry").addEventListener("click", () => {
      dataError = null;
      ensureData().then(() => paint(el, computed)).catch(() => paint(el, computed));
    });
    return;
  }
  if (!data) {
    count.textContent = "mustering…";
    box.innerHTML = `<p class="empty">Mustering the war-book…</p>`;
    return;
  }

  const all = [{ id: "all", label: "All", blurb: "" }, ...data.groups];
  groups.innerHTML = all.map((g) =>
    `<button class="chip ${g.id === group ? "on" : ""}" data-group="${esc(g.id)}"
       aria-pressed="${g.id === group}"${g.blurb ? ` title="${esc(g.blurb)}"` : ""}>${esc(g.label)}</button>`).join("");

  const hits = filterEntries(data.entries, group, query);
  count.textContent = `${hits.length} of ${data.entries.length}`;
  if (!hits.length) {
    box.innerHTML = `<p class="empty">Nothing in the war-book speaks of “${esc(query)}”.</p>`;
    return;
  }
  box.innerHTML = hits.map((e) => card(e, computed)).join("");
}

function card(entry, computed) {
  const links = resolveLinks(entry, byId);
  const state = eligibility(entry, active(), computed);

  const chips = [];
  if (entry.cost?.banes) {
    chips.push(`<span class="chip dark cb-static">${entry.cost.banes} bane${entry.cost.banes > 1 ? "s" : ""}</span>`);
  }
  if (entry.economy && entry.economy !== "action") {
    chips.push(`<span class="chip cb-static">${esc(entry.economy)}</span>`);
  }
  for (const r of entry.requires || []) {
    chips.push(`<span class="chip cb-static dim" title="The app cannot verify this — it does not track afflictions, hands, or ammunition.">requires: ${esc(r.label)}</span>`);
  }
  for (const d of entry.derive || []) {
    const value = resolveDerive(d.expr, computed);
    if (value === null) continue;
    chips.push(`<span class="chip cb-derived">${esc(d.label)}: ${esc(value)}</span>`);
  }
  for (const [field, label] of [["inflicts", "inflicts"], ["requires_condition", "needs"], ["removes", "removes"], ["see_also", "see"]]) {
    for (const target of links[field]) {
      chips.push(`<button class="chip cat" data-goto="${esc(target.id)}">${label} ${esc(target.name)}</button>`);
    }
  }

  const rows = entry.rows ? `
    <table class="cb-rows">
      ${entry.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.effect)}</td></tr>`).join("")}
    </table>` : "";

  const defender = Array.isArray(entry.defender)
    ? `the higher of ${entry.defender.map(esc).join(" or ")}`
    : esc(entry.defender || "");
  const roll = entry.attacker
    ? `<p class="small dim cb-roll">${esc(entry.attacker)} attack roll vs ${defender}</p>` : "";
  const sizeRule = entry.size_rule ? `<p class="small dim">Size: ${esc(entry.size_rule)}</p>` : "";

  return `
  <div class="talent cb-card ${state === "unavailable" ? "cb-dim" : ""}" style="margin-bottom:14px">
    <b>${esc(entry.name)}</b>
    <span class="src">${BOOKS[entry.source.book]} · p.${entry.source.page}</span>
    ${roll}
    <p>${esc(entry.text)}</p>
    ${sizeRule}
    ${rows}
    ${chips.length ? `<div class="chip-row" style="margin-top:6px">${chips.join("")}</div>` : ""}
  </div>`;
}
```

- [ ] **Step 2: Wire the tab into the page**

In `index.html`, add between the Dice and Lookup buttons (line 40–41):

```html
  <button class="tab" data-tab="combat">Combat</button>
```

and between the dice and lookup panels (line 50–51):

```html
  <section id="tab-combat" class="tab-panel"></section>
```

In `js/main.js`, add the import after line 10 and the route after line 19:

```javascript
import { renderCombat } from "./ui/combat.js";
```

```javascript
  combat: renderCombat,
```

In `css/app.css`, append:

```css
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.chip.cb-static { cursor: default; }
.chip.cb-static:hover { border-color: var(--line-bright); color: inherit; }
.chip.cb-derived { border-color: var(--bronze); color: var(--bronze-bright); }
.cb-dim { opacity: .45; }
.cb-roll { margin: 2px 0 0; font-family: var(--caps); }
.cb-rows { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 14px; }
.cb-rows th { text-align: left; font-family: var(--caps); color: var(--bronze); font-weight: 400; padding: 2px 10px 2px 0; vertical-align: top; white-space: nowrap; }
.cb-rows td { padding: 2px 0; vertical-align: top; }
```

- [ ] **Step 3: Verify in the browser**

Start the dev server and check the tab renders, filters, and survives a missing character.

```bash
npm run dev
```

Confirm, with the browser preview tools: the Combat tab appears between Dice and Lookup; group chips switch content and show `aria-pressed`; typing `shove` narrows to one card; Shove's card shows a bronze derive chip with a real number when a character is loaded; deleting every character leaves the tab rendering full content with no derive chips and **no console error**; the console is otherwise clean.

- [ ] **Step 4: Verify the whole suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/ui/combat.js js/main.js index.html css/app.css
git commit -m "Add the Combat quick reference tab"
```

---

### Task 7: Accessibility retrofits

Two items the parser-rework spec logged as follow-ups rather than folding in.

**Files:**
- Modify: `index.html:34-51`
- Modify: `js/main.js:50-57`
- Modify: `js/ui/lookup.js:43-66`, `js/ui/lookup.js:213-223`

**Interfaces:**
- Consumes: the `#tab-combat` panel added in Task 6.
- Produces: no new exports. The `data-tab` attribute contract is unchanged, so `renderCurrent()` still routes on it.

- [ ] **Step 1: Give the tab bar real tab semantics**

In `index.html`, the nav becomes:

```html
<nav class="tabs" id="tabs" role="tablist" aria-label="Character sections">
  <button class="tab active" data-tab="build" role="tab" id="tabbtn-build" aria-controls="tab-build" aria-selected="true" tabindex="0">Build</button>
  <button class="tab" data-tab="sheet" role="tab" id="tabbtn-sheet" aria-controls="tab-sheet" aria-selected="false" tabindex="-1">Sheet</button>
  <button class="tab" data-tab="spells" role="tab" id="tabbtn-spells" aria-controls="tab-spells" aria-selected="false" tabindex="-1">Spells</button>
  <button class="tab" data-tab="paths" role="tab" id="tabbtn-paths" aria-controls="tab-paths" aria-selected="false" tabindex="-1">Paths</button>
  <button class="tab" data-tab="gear" role="tab" id="tabbtn-gear" aria-controls="tab-gear" aria-selected="false" tabindex="-1">Gear</button>
  <button class="tab" data-tab="dice" role="tab" id="tabbtn-dice" aria-controls="tab-dice" aria-selected="false" tabindex="-1">Dice</button>
  <button class="tab" data-tab="combat" role="tab" id="tabbtn-combat" aria-controls="tab-combat" aria-selected="false" tabindex="-1">Combat</button>
  <button class="tab" data-tab="lookup" role="tab" id="tabbtn-lookup" aria-controls="tab-lookup" aria-selected="false" tabindex="-1">Lookup</button>
</nav>
```

and each panel gains its labelling, e.g.:

```html
  <section id="tab-build" class="tab-panel active" role="tabpanel" aria-labelledby="tabbtn-build" tabindex="0"></section>
```

Repeat for `sheet`, `spells`, `paths`, `gear`, `dice`, `combat`, `lookup`.

- [ ] **Step 2: Add roving tabindex and arrow-key handling**

In `js/main.js`, replace the tab click listener (lines 50–57) with:

```javascript
  function selectTab(btn) {
    if (!btn) return;
    current = btn.dataset.tab;
    document.querySelectorAll(".tab[data-tab]").forEach((t) => {
      const on = t === btn;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${current}`));
    renderCurrent();
  }

  const tabBar = document.getElementById("tabs");
  tabBar.addEventListener("click", (e) => selectTab(e.target.closest(".tab[data-tab]")));
  // Roving tabindex: one stop on the bar, arrows move within it. Without this
  // the bar had role-less buttons and tabbed through all eight.
  tabBar.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    if (!(e.key in keys)) return;
    const all = [...tabBar.querySelectorAll(".tab[data-tab]")];
    const i = all.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const step = keys[e.key];
    const next = step === "first" ? all[0]
      : step === "last" ? all[all.length - 1]
      : all[(i + step + all.length) % all.length];
    next.focus();
    selectTab(next);
  });
```

- [ ] **Step 3: Make Lookup's expander keyboard-operable**

In `js/ui/lookup.js`, the result body currently expands via a click handler on a `<p>`. Replace the body markup (lines 213–223) so long chunks get a real button:

```javascript
    ${ruleHits.map((c) => {
      const win = snippetWindow(c, terms);
      const clamped = c.x.length > 460;
      const cite = c.b && c.p ? `<span class="src">${BOOKS[c.b]} · p.${c.p}</span>` : "";
      return `
      <div class="talent" style="margin-bottom:14px">
        <b>${highlight(esc(c.t), terms)}</b>
        ${cite}
        <p class="lk-body ${clamped ? "lk-clamp" : ""}" data-full="${esc(c.x)}">${highlight(esc(win), terms)}</p>
        ${clamped ? `<button class="btn btn-small lk-more" aria-expanded="false">Show more</button>` : ""}
      </div>`;
    }).join("")}
```

and replace the results click handler (lines 63–66) with:

```javascript
  el.querySelector("#lk-results").addEventListener("click", (e) => {
    const btn = e.target.closest(".lk-more");
    if (!btn) return;
    const body = btn.parentElement.querySelector(".lk-body");
    const open = body.classList.toggle("lk-clamp") === false;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Show less" : "Show more";
  });
```

- [ ] **Step 4: Verify**

```bash
npm test
```

Then with the dev server running: Tab into the tab bar — it takes **one** stop, not eight. Left/Right arrows move between tabs and switch panels; Home and End jump to the ends. On the Lookup tab, search `hide` and confirm the "Show more" button is reachable by keyboard, toggles the clamp, and flips its `aria-expanded` and label.

- [ ] **Step 5: Commit**

```bash
git add index.html js/main.js js/ui/lookup.js
git commit -m "Give the tab bar tab semantics and make Lookup's expander keyboard-operable"
```

---

## Self-review notes

**Spec coverage.** Data model → Tasks 1–4. Rights posture (verbatim + citation) → enforced by `test_common_fields` and the per-entry `source`. Derive layer → Tasks 2, 4, 5. Tri-state eligibility → Task 5. Lazy load and error state → Task 6 Step 1. No-character branch → Task 6 `computedFor`. Chips-and-search interaction → Task 6 `paint`. Module-scoped state → Task 6 module `let`s. Accessibility, new and retrofit → Tasks 6 and 7. Both test suites → Tasks 1–5, both already inside `npm test`'s existing globs.

**Known ordering hazard.** `test_links_resolve` is written in Task 1 but link targets land across Tasks 2–4, so link arrays are deliberately deferred to the task that creates their target. Each data task's Step 3 says which arrays it restores. Task 4 Step 3 also amends `test_all_fourteen_actions_present` once `charge` makes the unfiltered `economy == "action"` set wrong.
