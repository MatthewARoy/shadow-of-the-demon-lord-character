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
