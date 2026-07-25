import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scan_parse_quality import SIGNATURES, key, scan_records


class TestSignatures(unittest.TestCase):
    def test_bleed_catches_trailing_tradition_header(self):
        s = "The target falls prone until the end of the round. Celestial Spells"
        self.assertTrue(SIGNATURES["bleed"](s))

    def test_bleed_catches_running_head_any_case(self):
        self.assertTrue(SIGNATURES["bleed"]("some text PLaying the Game more text"))

    def test_bleed_ignores_ordinary_prose(self):
        s = "The target falls prone until the end of the round."
        self.assertFalse(SIGNATURES["bleed"](s))

    def test_bleed_ignores_book_cross_reference(self):
        """Apocalypse legitimately says '(see Terrible Beauty)'."""
        s = "your soul goes to Elysium (see Terrible Beauty), where it remains."
        self.assertFalse(SIGNATURES["bleed"](s))

    def test_table_row_catches_price_run(self):
        s = "Axe 1 ss C Club 5 cp C Dagger 5 cp C Dart 1 cp C"
        self.assertTrue(SIGNATURES["table_row"](s))

    def test_table_row_catches_stat_header_remnant(self):
        self.assertTrue(SIGNATURES["table_row"]("Name. Damage. Hands. Properties."))

    def test_table_row_catches_weapon_stat_row(self):
        self.assertTrue(SIGNATURES["table_row"]("1d3 Off Range (medium), uses stones"))

    def test_dice_table_catches_repeated_d20(self):
        self.assertTrue(SIGNATURES["dice_table"]("d20 Profession: d20 Profession: d20"))

    def test_dice_table_catches_trailing_die_size(self):
        self.assertTrue(SIGNATURES["dice_table"]("a hero to the people in your hometown. d20"))

    def test_ligature_catches_residual_artifact(self):
        self.assertTrue(SIGNATURES["ligature"]("the ŋghters advance"))

    def test_ligature_ignores_clean_text(self):
        self.assertFalse(SIGNATURES["ligature"]("the fighters advance"))

    def test_area_phrase_is_not_flagged(self):
        """Unpunctuated area/target phrases are valid data, not defects."""
        s = "A cylinder, 4 yards tall with a radius of 4 yards, centered on a point within long range"
        self.assertFalse(any(fn(s) for fn in SIGNATURES.values()))

    def test_ordinary_rule_text_is_not_flagged(self):
        s = "A dazed creature cannot use actions. It can still move and perceive its surroundings."
        self.assertFalse(any(fn(s) for fn in SIGNATURES.values()))


class TestScanRecords(unittest.TestCase):
    def test_reports_signature_and_path(self):
        records = [{"name": "Moon Bridge", "description": "It ends here. Conjuration Spells"}]
        hits = scan_records("spells.json", records)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["signature"], "bleed")
        self.assertEqual(hits[0]["file"], "spells.json")
        self.assertIn("description", hits[0]["path"])

    def test_clean_records_produce_no_hits(self):
        records = [{"name": "Fireball", "description": "It burns the target badly."}]
        self.assertEqual(scan_records("spells.json", records), [])

    def test_short_strings_are_skipped(self):
        records = [{"name": "d20", "description": "d20 d20 d20"}]
        self.assertEqual(scan_records("x.json", records), [])

    def test_walks_nested_lists_and_dicts(self):
        records = {"weapons": [{"notes": "Axe 1 ss C Club 5 cp C Dagger 5 cp C Dart 1 cp C"}]}
        hits = scan_records("equipment.json", records)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["signature"], "table_row")


class TestBaselineKey(unittest.TestCase):
    BLED = "It ends here. Conjuration Spells"

    def test_key_is_stable_when_records_are_reordered(self):
        """A parser change that adds or removes records must not invalidate
        the baseline for hits whose content is unchanged."""
        before = scan_records("spells.json", [{"d": self.BLED}])
        after = scan_records("spells.json",
                             [{"d": "filler that matches nothing at all"},
                              {"d": self.BLED}])
        self.assertEqual(key(before[0]), key(after[-1]))

    def test_key_changes_when_content_changes(self):
        a = scan_records("spells.json", [{"d": self.BLED}])
        b = scan_records("spells.json", [{"d": "Something else. Nature Spells"}])
        self.assertNotEqual(key(a[0]), key(b[0]))

    def test_key_separates_files_and_signatures(self):
        a = scan_records("spells.json", [{"d": self.BLED}])
        b = scan_records("paths.json", [{"d": self.BLED}])
        self.assertNotEqual(key(a[0]), key(b[0]))


if __name__ == "__main__":
    unittest.main()
