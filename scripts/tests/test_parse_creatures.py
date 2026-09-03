"""Focused unit tests for creature stat-block boundary recognition."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))

import parse_creatures
from parse_creatures import starts_a_heading


class TestCreatureParser(unittest.TestCase):
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

    def test_wrapped_final_attribute_stays_in_the_stat_header(self):
        fixture = """===PAGE 140===
137
GRIM REAPER
DIFFICULTY 1,000
Size 2 horrifying monster
Perception 20 (+10); truesight
Defense 20; Health 200; Insanity —; Corruption 10
Strength 20 (+10), Agility 20 (+10), Intellect 20 (+10), Will
20 (+10)
Speed 12
Immune damage from cold, disease, or poison
"""
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "core.txt").write_text(fixture)
            with patch.object(parse_creatures, "CACHE", tmp):
                [creature] = parse_creatures.parse_book("core")

        self.assertEqual(
            creature["attributes"],
            "Strength 20 (+10), Agility 20 (+10), Intellect 20 (+10), Will 20 (+10)",
        )
        self.assertEqual(
            creature["traits"],
            ["Immune damage from cold, disease, or poison"],
        )

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
