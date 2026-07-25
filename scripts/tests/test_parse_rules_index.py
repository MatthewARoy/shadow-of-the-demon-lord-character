import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
FIXTURES = os.path.join(HERE, "..", "fixtures")

import parse_rules_index as p


def load_fixture(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return f.read()


class TestFixtures(unittest.TestCase):
    def test_all_fixtures_present_and_page_marked(self):
        names = [n for n in os.listdir(FIXTURES) if n.endswith(".txt")]
        self.assertEqual(len(names), 5, f"expected 5 fixtures, found {names}")
        for name in names:
            text = load_fixture(name)
            self.assertTrue(text.startswith("===PAGE "), f"{name} lacks a page marker")
            self.assertGreater(len(text), 500, f"{name} looks truncated")

    def test_weapons_fixture_contains_the_sling_row(self):
        self.assertIn("Sling", load_fixture("core_p104_weapons.txt"))

    def test_professions_fixture_contains_a_dice_table(self):
        self.assertIn("d20", load_fixture("core_p26_professions.txt"))


class TestIsHeading(unittest.TestCase):
    def test_accepts_a_real_heading(self):
        self.assertTrue(p.is_heading("Melee Attack Options"))

    def test_rejects_a_sentence(self):
        self.assertFalse(p.is_heading("You make the attack roll with 1 bane."))

    def test_rejects_running_head_in_any_case(self):
        self.assertFalse(p.is_heading("Playing the Game"))
        self.assertFalse(p.is_heading("PLaying the Game"))


if __name__ == "__main__":
    unittest.main()
