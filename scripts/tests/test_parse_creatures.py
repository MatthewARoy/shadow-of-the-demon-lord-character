"""Focused unit tests for creature stat-block boundary recognition."""
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))

from parse_creatures import starts_a_heading


class TestCreatureHeadings(unittest.TestCase):
    def test_narrow_family_intro_matches_its_first_stat_block(self):
        lines = [
            "Genie",
            "When the universe sprang into",
            "existence eons ago, it brought with it",
            "bodiless entities, awakened",
            "EARTH GENIE",
            "DIFFICULTY 100",
        ]
        self.assertTrue(starts_a_heading(lines, 1, lines[0]))

    def test_connector_led_wrapped_heading_matches(self):
        lines = [
            "Incarnation",
            "of Nature",
            "In the view of many druids, the world",
            "is a living organism, a being on which",
            "INCARNATION OF NATURE",
            "DIFFICULTY 1,000",
        ]
        self.assertTrue(starts_a_heading(lines, 1, lines[0]))

    def test_stat_line_does_not_become_a_heading(self):
        lines = [
            "Immune frightened",
            "ATTACK OPTIONS",
            "Fist (melee) +6 with 2 boons (2d6 + 6)",
            "BOGGART",
            "DIFFICULTY 25",
        ]
        self.assertFalse(starts_a_heading(lines, 1, lines[0]))

    def test_existing_wide_prose_heading_still_matches(self):
        lines = [
            "Customizing",
            "Creatures",
            "You can modify creatures by changing their statistics and traits.",
        ]
        self.assertTrue(starts_a_heading(lines, 1, lines[0]))


if __name__ == "__main__":
    unittest.main()
