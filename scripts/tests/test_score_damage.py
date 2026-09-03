"""Regression tests for offensive damage classification."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))

import score_spells as scorer

DATA = os.path.join(HERE, "..", "..", "data")


def spell(description):
    return {"description": description, "tags": ["damage"]}


class TestDamageSubjects(unittest.TestCase):
    def test_creature_damage_is_scored(self):
        result = scorer.score_damage(spell("The target takes 3d6 damage."))
        self.assertEqual(result["value"], 10.5)
        self.assertEqual(result["expr"], "3d6")

    def test_object_and_structure_damage_is_not_offensive_output(self):
        for description in (
            "Each object in the area takes 4d6 damage.",
            "The structure takes 100 damage. If the damage destroys the object, it collapses.",
        ):
            with self.subTest(description=description):
                self.assertIsNone(scorer.score_damage(spell(description)))

    def test_caster_self_damage_is_not_offensive_output(self):
        self.assertIsNone(scorer.score_damage(
            spell("You take 10d6 damage when you cast the spell.")))

    def test_self_cost_does_not_hide_real_damage(self):
        result = scorer.score_damage(spell(
            "You take 8 damage. The target takes 8d6 damage."))
        self.assertEqual(result["value"], 28.0)
        self.assertEqual(result["expr"], "8d6")


class TestCommittedDamageScores(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(DATA, "spell-scores.json")) as f:
            cls.scores = json.load(f)["spells"]

    def damage(self, key):
        return [record for record in self.scores.get(key, [])
                if record["kind"] == "damage"]

    def test_larger_object_damage_does_not_win(self):
        record = self.damage("catastrophic outburst|telekinesis")[0]
        self.assertEqual((record["value"], record["expr"]), (70.0, "20d6"))

    def test_structure_collapse_damage_does_not_win(self):
        record = self.damage("earthquake|earth")[0]
        self.assertEqual((record["value"], record["expr"]), (3.5, "1d6"))

    def test_caster_cost_only_spell_has_no_damage_score(self):
        self.assertEqual(self.damage("call greater demon|demonology"), [])

    def test_real_damage_survives_alongside_caster_cost(self):
        record = self.damage("purge chaos|order")[0]
        self.assertEqual((record["value"], record["expr"]), (10.5, "3d6"))


if __name__ == "__main__":
    unittest.main()
