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


class TestBoundaryFlush(unittest.TestCase):
    def test_iterator_emits_a_sentinel_between_ranges(self):
        seq = list(p.lines_in_ranges())
        self.assertIn((None, None, None), seq,
                      "no boundary sentinel emitted between ranges")

    def test_sentinel_count_matches_range_count(self):
        seq = list(p.lines_in_ranges())
        sentinels = sum(1 for item in seq if item == (None, None, None))
        self.assertEqual(sentinels, len(p.RANGES),
                         "expected one sentinel per configured range")

    def test_no_chunk_spans_two_books(self):
        """A core chunk must not carry Occult Philosophy prose."""
        occult_marker = "the inexhaustible wellspring that flows through all things"
        offenders = [c["t"] for c in p.chunk()
                     if c["b"] == "core" and occult_marker in c["x"]]
        self.assertEqual(offenders, [], f"core chunks carrying occult text: {offenders}")

    def test_no_chunk_spans_a_range_gap(self):
        """The ch.2 range ends at p.53; ch.6 starts at p.100."""
        marker = "Swords to pistols"
        offenders = [c["t"] for c in p.chunk() if c["p"] <= 53 and marker in c["x"]]
        self.assertEqual(offenders, [], f"chunks bridging the p.53/p.100 gap: {offenders}")


if __name__ == "__main__":
    unittest.main()
