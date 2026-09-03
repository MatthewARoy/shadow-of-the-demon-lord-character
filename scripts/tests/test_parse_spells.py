"""Focused parser regressions that do not require the extracted book cache."""
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))

import parse_spells


class TestSidebarRemoval(unittest.TestCase):
    def test_dark_magic_callout_is_spliced_out_mid_sentence(self):
        sidebar = (
            "Dark Magic, Dark Speech Casting Forbidden spells requires speaking "
            "mystic phrases in Dark Speech. If you don’t know this language, you "
            "make attack rolls using Forbidden spells with 1 bane and creatures "
            "make challenge rolls to resist your Forbidden spells with 1 boon."
        )
        parsed = parse_spells.build_spell(
            "RAVENOUS MAGGOTS", "FORBIDDEN", "ATTACK", 2,
            ["The target must", sidebar, "make a Strength challenge roll."],
            "core", 130,
        )
        self.assertEqual(parsed["description"],
                         "The target must make a Strength challenge roll.")


if __name__ == "__main__":
    unittest.main()
