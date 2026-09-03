"""Assertions for the boon scoring in scripts/score_spells.py.

The boon pass is the one scorer that gates on rules vocabulary rather than on
a reviewed tag, so its classifier is the only thing keeping an enemy's saving
throw out of the party-buff cohort. These tests pin that classifier against
hand-read rules text, and pin the committed data/spell-scores.json against
the shape the UI reads.

A failure here means a spell changed sides — a buff became a self-buff, or a
"must get a success on a Strength challenge roll with 1 boon" started counting
as support. Fix the classifier; do not weaken the assertion.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
DATA = os.path.join(HERE, "..", "..", "data")

import score_spells as s

SPELLS = {sp["name"]: sp for sp in json.loads(
    open(os.path.join(DATA, "spells.json")).read())}
SCORES = json.loads(open(os.path.join(DATA, "spell-scores.json")).read())

BOON_KINDS = {"buff", "self-buff", "mark"}

# Hand-read from the rules text: which side of the table the boon lands on.
ALLY = {
    "Blessing": "1 boon", "Foretell": "3 boons", "Battle Chant": "1 boon",
    "Omen": "2 boons", "Song of Inspiration": "2 boons", "Uplifting Melody": "2 boons",
    "Unlock Potential": "2 boons", "Life Surge": "1 boon", "Rune of Might": "2 boons",
    "Revelation": "2 boons", "Reading": "2 boons", "Vigilance": "1 boon",
    "Awaken Passion": "2 boons", "Bolster Attribute": "1 boon", "Shielded Minds": "3 boons",
    "Protection From Spells": "1 boon", "Dark Helmet": "2 boons", "Riddle of Steel": "2 boons",
    "Killing Urge": "1 boon", "Circle of Stones": "1 boon", "Augmented Vitality": "2 boons",
    "Resilient Beast": "1 boon", "Alter Size": "1 boon", "Chaos Unleashed": "2 boons",
}
# The enemy wears the boon; everyone attacking it benefits.
MARK = {
    "Saint Astrid’s Flame": "1 boon", "Filthy Limerick": "1 boon", "Befuddle": "1 boon",
    "Tormenting Hallucinations": "2 boons", "Perfect Target": "1 boon", "Stillness": "1 boon",
    "Scintillating Worms": "1 boon", "Primal Scream": "1 boon", "Strength of Steel": "1 boon",
    "Fugue": "1 boon",
}
SELF = {
    "Mighty Attack": "1 boon", "Empowered Magic": "1 boon", "Chameleon": "3 boons",
    "Hex": "1 boon", "Create Holy Symbol": "1 boon", "Spellbound Weapon": "1 boon",
    "Black Tongue": "1 boon", "Empty Mind": "2 boons", "Potent Magic": "2 boons",
    "Cosmic Awareness": "5 boons",
}
# No boon record at all: the boon aids whoever resists the caster, helps the
# enemy, or is a rules aside about boon dice rather than a granted boon.
NONE = [
    "Slumber", "Choking Smoke", "Drown", "Flood", "Sticky Strands", "Will-o’-wisp",
    "Randomness", "Impose Predictability", "Ravenous Maggots", "Block Magic",
    "Savage Strike", "Unreasoning Hatred",
]


class TestSwingMath(unittest.TestCase):
    def test_expected_swing_is_max_of_n_d6(self):
        for n, want in ((1, 3.5), (2, 4.4722), (3, 4.9583), (4, 5.2446)):
            self.assertAlmostEqual(s.boon_swing(n), want, places=3)

    def test_swing_has_diminishing_returns(self):
        """The whole point of scoring swing over boon count."""
        gaps = [s.boon_swing(n + 1) - s.boon_swing(n) for n in range(1, 5)]
        self.assertEqual(gaps, sorted(gaps, reverse=True))
        self.assertLess(gaps[0], s.boon_swing(1) / 3)


class TestClassification(unittest.TestCase):
    def kinds(self, name):
        return {r["kind"]: r["expr"] for r in s.score_boons(SPELLS[name])}

    def test_ally_buffs(self):
        for name, expr in ALLY.items():
            with self.subTest(spell=name):
                self.assertEqual(self.kinds(name).get("buff"), expr)

    def test_marks(self):
        for name, expr in MARK.items():
            with self.subTest(spell=name):
                self.assertEqual(self.kinds(name).get("mark"), expr)

    def test_self_buffs(self):
        for name, expr in SELF.items():
            with self.subTest(spell=name):
                self.assertEqual(self.kinds(name).get("self-buff"), expr)

    def test_enemy_and_meta_boons_are_not_scored(self):
        for name in NONE:
            with self.subTest(spell=name):
                self.assertEqual(s.score_boons(SPELLS[name]), [])

    def test_blessing_is_the_only_unlimited_target_buff_at_low_rank(self):
        """Breadth lives in flags, so the flag has to be right."""
        unlimited = [sp["name"] for sp in SPELLS.values() if sp["rank"] <= 3
                     for r in s.score_boons(sp)
                     if r["kind"] == "buff" and r["flags"]["unlimited"]]
        self.assertEqual(unlimited, ["Blessing"])

    def test_concentration_flag_tracks_the_duration_line(self):
        self.assertTrue(s.score_boons(SPELLS["Foretell"])[0]["flags"]["concentration"])
        self.assertFalse(s.score_boons(SPELLS["Blessing"])[0]["flags"]["concentration"])


class TestCommittedScores(unittest.TestCase):
    def boon_records(self):
        return [r for recs in SCORES["spells"].values() for r in recs
                if r["kind"] in BOON_KINDS]

    def test_data_is_regenerated(self):
        """data/spell-scores.json must not lag scripts/score_spells.py."""
        self.assertTrue(self.boon_records(),
                        "no boon records committed — run scripts/score_spells.py")

    def test_schema(self):
        swings = {round(s.boon_swing(n), 2) for n in range(1, 11)}
        swings.add(round(sum(s.boon_swing(n) for n in (1, 2, 3)) / 3, 2))  # 1d3 boons
        for r in self.boon_records():
            self.assertEqual(r["unit"], "boon-swing")
            # A boon count that scales with an attribute ("a number of boons
            # equal to your Will modifier") is recorded with no value so that
            # coverage stays honest, as the heal scorer does.
            if r["value"] is None:
                self.assertEqual(r["expr"], "see text")
            else:
                self.assertIn(r["value"], swings)
            self.assertEqual(
                set(r["flags"]), {"atk", "chal", "multi", "unlimited", "concentration", "area"})
            self.assertTrue(r["flags"]["atk"] or r["flags"]["chal"],
                            f"{r} boosts neither attack nor challenge rolls")

    def test_cohorts_are_per_kind_so_a_self_buff_never_outranks_on_a_buff_cohort(self):
        for r in self.boon_records():
            self.assertEqual(r["cohort"], f"{r['kind']}|boon-swing|rank{r['rank']}")
            if r["percentile"] is not None:
                self.assertGreaterEqual(r["percentile"], 0)
                self.assertLessEqual(r["percentile"], 1)

    def test_the_efficiency_sort_hole_stays_closed(self):
        """These sorted below every damage cantrip while buffs went unscored."""
        for key in ("blessing|theurgy", "battle chant|song", "rune of might|rune",
                    "foretell|divination", "revelation|theurgy", "omen|theurgy"):
            with self.subTest(spell=key):
                recs = SCORES["spells"].get(key, [])
                self.assertTrue([r for r in recs if r["kind"] in BOON_KINDS])

    def test_notes_warn_against_ranking_on_swing_alone(self):
        """Swing alone puts Foretell over Blessing; the flags carry the rest."""
        self.assertIn("boons", SCORES["notes"])
        note = SCORES["notes"]["boons"]
        self.assertIn("flags", note)


if __name__ == "__main__":
    unittest.main()
