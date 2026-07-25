"""Assertions against the committed data/rules-index.json.

These read generated JSON only — no PDFs, no scripts/cache — so they run in
a fresh clone where the parser itself cannot. Each guards one defect class
from the 2026-07 rework.

A failure here means a defect returned. Fix the parser; do not weaken the
assertion.
"""
import json
import os
import re
import unittest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "..", "data")

# Core p.42-43. Immobilized is the one most easily lost from this list.
AFFLICTIONS = [
    "Asleep", "Blinded", "Charmed", "Compelled", "Dazed", "Deafened",
    "Defenseless", "Diseased", "Fatigued", "Frightened", "Grabbed",
    "Immobilized", "Impaired", "Poisoned", "Prone", "Slowed", "Stunned",
    "Surprised", "Unconscious",
]


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


class TestRulesIndexInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = load("rules-index.json")
        cls.titles = {c["t"] for c in cls.index}

    def test_no_table_row_wreckage(self):
        """Defect B — the reported 'sling' result and its siblings."""
        bad = [c["t"] for c in self.index
               if re.search(r"\b\dd\d(?:\s*\+\s*\d)? (?:Off|One|Two)\b", c["x"])
               or "Name. Damage. Hands." in c["x"]
               or len(re.findall(r"\b\d+ (?:cp|ss|gc)\b", c["x"])) > 3]
        self.assertEqual(bad, [], f"table rows still in the index: {bad}")

    def test_no_spell_entries_from_the_spell_list(self):
        """Defect E."""
        spells = {s["name"].lower() for s in load("spells.json")}
        bad = sorted({c["t"] for c in self.index
                      if c["p"] >= 111 and c["t"].lower() in spells})
        self.assertEqual(bad, [], f"spell entries leaked into the index: {bad}")

    def test_no_cross_book_bleed(self):
        """Defect A — core chunks carrying Occult Philosophy prose."""
        marker = "the inexhaustible wellspring that flows through all things"
        bad = [c["t"] for c in self.index if c["b"] == "core" and marker in c["x"]]
        self.assertEqual(bad, [], f"cross-book bleed: {bad}")

    def test_no_running_head_furniture_in_bodies(self):
        """Defect D — the variant capitalisation only ever appears as furniture."""
        bad = sorted({c["t"] for c in self.index if "PLaying the Game" in c["x"]})
        self.assertEqual(bad, [], f"running-head furniture in bodies: {bad}")

    def test_no_orphan_heading_fragments(self):
        """Defect D — 'a Melee Weapon' was the tail of a wrapped heading."""
        bad = sorted({c["t"] for c in self.index
                      if c["t"].split()[0] in
                      {"a", "an", "the", "to", "of", "with", "or", "and"}})
        self.assertEqual(bad, [], f"orphaned heading fragments: {bad}")

    def test_all_nineteen_afflictions_present(self):
        """Defect C."""
        missing = [a for a in AFFLICTIONS if a not in self.titles]
        self.assertEqual(missing, [], f"missing afflictions: {missing}")

    def test_short_rules_present(self):
        """Defect C — these were merged into their predecessor by length."""
        for t in ("Dazed", "Rush", "Disabled", "Dying"):
            self.assertIn(t, self.titles, f"{t} is missing")

    def test_prose_sections_retained(self):
        """Guards the table manifest against over-deletion.

        equipment.json carries price and availability for Garrote, Holy
        Water, and Lantern but NOT their rules text, which lives only here.
        """
        for t in ("Improvised Weapons", "Special Materials", "Living Expenses",
                  "Melee Attack Options", "Ranged Attack Options", "Cover",
                  "Garrote", "Holy Water", "Lantern"):
            self.assertIn(t, self.titles, f"over-deleted: {t}")

    def test_combat_actions_are_searchable(self):
        """The rules the Combat reference will be built from."""
        for t in ("Charge", "Disarm", "Feint", "Grab", "Knock Down", "Shove",
                  "Retreat", "Prepare", "Defend", "Concentrate"):
            self.assertIn(t, self.titles, f"missing combat action: {t}")

    def test_every_chunk_has_required_fields_and_a_body(self):
        for c in self.index:
            for f in ("t", "b", "p", "x"):
                self.assertIn(f, c, f"chunk missing field {f}: {c.get('t')}")
            self.assertTrue(c["x"].strip(), f"empty body: {c['t']}")
            self.assertIn(c["b"], ("core", "occult", "terrible"))


if __name__ == "__main__":
    unittest.main()
