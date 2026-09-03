import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from diff_paths import diff, regression_problems


def path(name="Wizard", text="Original talent text", choices=None):
    if choices is None:
        choices = [{"pick": 1, "options": ["learn_spell"]}]
    return {
        "name": name,
        "source": "core",
        "page": 60,
        "type": "novice",
        "description": "A path.",
        "levels": {
            "2": {
                "characteristics": {"health": 2},
                "magic": {"raw": "You learn one spell.", "choices": choices},
                "talents": [{"name": "Academic", "text": text}],
            }
        },
    }


class TestDiffPaths(unittest.TestCase):
    def compare(self, before, after):
        return diff({before["name"]: before}, {after["name"]: after})

    def test_clean_snapshot_has_no_differences(self):
        added, removed, changes = self.compare(path(), path())
        self.assertEqual((added, removed, changes), ([], [], []))

    def test_reports_talent_names_and_same_length_text_changes(self):
        before, after = path(text="abcd"), path(text="wxyz")
        after["levels"]["2"]["talents"].append(
            {"name": "New Talent", "text": "Text"}
        )

        _, _, changes = self.compare(before, after)
        fields = [change["field"] for change in changes]

        self.assertIn("talent_names", fields)
        self.assertIn("talent_text", fields)
        text_change = next(c for c in changes if c["field"] == "talent_text")
        self.assertEqual(text_change["level"], "2")
        self.assertEqual(text_change["detail"], "Academic")

    def test_reports_level_values_and_magic_choices_separately(self):
        before, after = path(), path(choices=[{
            "pick": 1,
            "options": ["discover_tradition", "learn_spell"],
        }])
        after["levels"]["2"]["characteristics"]["health"] = 3

        _, _, changes = self.compare(before, after)
        self.assertEqual(
            {change["field"] for change in changes},
            {"characteristics", "magic.choices"},
        )

    def test_reports_path_and_level_presence(self):
        old = {"Wizard": path()}
        new = {"Mage": path(name="Mage"), "Wizard": path()}
        new["Wizard"]["levels"]["5"] = {"talents": []}

        added, removed, changes = diff(old, new)

        self.assertEqual(added, ["Mage"])
        self.assertEqual(removed, [])
        self.assertEqual([c["field"] for c in changes], ["levels"])

    def test_expected_fields_are_allowed_but_record_changes_are_not(self):
        before, after = path(), path(text="Changed")
        _, _, changes = self.compare(before, after)

        self.assertEqual(
            regression_problems([], [], changes, {"talent_text"}), []
        )
        self.assertTrue(regression_problems([], [], changes, set()))
        self.assertTrue(regression_problems(["Mage"], [], [], set()))

    def test_max_changed_applies_to_expected_fields(self):
        change = {
            "field": "talent_text", "path": "Wizard", "level": "2",
            "detail": "Academic", "old": "a", "new": "b",
        }
        problems = regression_problems(
            [], [], [change, dict(change)], {"talent_text"}, max_changed=1
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("max 1", problems[0])


if __name__ == "__main__":
    unittest.main()
