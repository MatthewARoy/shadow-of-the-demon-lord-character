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
        """Core p.49. Concentrate and Defend are the two routinely missed.

        Filtered to the actions group: Charge (p.53) and Free Attack (p.51)
        are also actions but are not on the p.49 list.
        """
        names = {e["name"] for e in self.entries
                 if e["kind"] == "action" and e["group"] == "actions"}
        self.assertEqual(names, set(ACTIONS),
                         f"missing: {sorted(set(ACTIONS) - names)}; "
                         f"unexpected: {sorted(names - set(ACTIONS))}")


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
        """Core p.51 - all five live inside one 'Melee Attack Options' chunk."""
        names = {e["name"] for e in self.by_kind("option", weapon_class="melee")}
        self.assertEqual(names, set(MELEE_OPTIONS))

    def test_ranged_options_present(self):
        """Core p.52 - all three live inside one 'Ranged Attack Options' chunk."""
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

    def test_range_bands_cover_all_seven(self):
        labels = {r["label"] for r in self.by_id["range-bands"]["rows"]}
        self.assertEqual(labels, {"You", "Reach", "Short", "Medium", "Long",
                                  "Extreme", "Sight"})

    def test_cover_has_three_degrees(self):
        labels = {r["label"] for r in self.by_id["cover"]["rows"]}
        self.assertEqual(labels, {"Half covered", "Three-quarters covered",
                                  "Totally covered"})


if __name__ == "__main__":
    unittest.main()
