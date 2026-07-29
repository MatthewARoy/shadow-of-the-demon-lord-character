"""Assertions against the committed data/spells.json.

Reads generated JSON only — no PDFs, no scripts/cache — so this runs in a
fresh clone where scripts/parse_spells.py cannot.

Path-granted spells are printed inside a path's entry in the paths chapters,
far below SPELL_PAGE_LIMIT, so nothing bounded them: spellbound weapon ran
off core p.73 through the "Expert Paths" running head and swallowed the
whole thief intro on p.74.

A failure here means a defect returned. Fix the parser; do not weaken the
assertion.
"""
import json
import os
import re
import unittest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "..", "data")

# The running heads of the chapters a spell block can run into.
RUNNING_HEADS = [
    "Novice Paths", "Expert Paths", "Master Paths", "Paths of Magic",
    "Paths of Skill", "Character Creation", "Playing the Game",
    "Running the Game", "Creatures of Magic", "Bestiary",
]
HEAD_RE = re.compile(r"(?i)(?<!see )\b(" + "|".join(RUNNING_HEADS) + r")\b")
STORY_DEVELOPMENT_RE = re.compile(r"(?i)\bStory Development\b")


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def texts(spells):
    for s in spells:
        for field in ("description", "requirement", "target", "area",
                      "duration", "prerequisite"):
            value = s.get(field)
            if value:
                yield f"{s['name']} ({field})", value


class TestSpellsInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spells = load("spells.json")

    def test_no_running_heads_in_spell_text(self):
        bad = [label for label, text in texts(self.spells)
               if HEAD_RE.search(text)]
        self.assertEqual(bad, [], f"running heads in spell text: {bad}")

    def test_no_story_development_sidebar_titles(self):
        bad = [label for label, text in texts(self.spells)
               if STORY_DEVELOPMENT_RE.search(text)]
        self.assertEqual(bad, [], f"story-development titles in spells: {bad}")

    def test_spellbound_weapon_is_whole_but_not_more(self):
        """The reported case, both directions.

        Sacrifice is genuinely part of the spell — paths.json used to carry
        it as a talent — so the fix must keep it while dropping the thief.
        """
        spell = [s for s in self.spells if s["name"] == "Spellbound Weapon"]
        self.assertTrue(spell, "spellbound weapon is missing")
        text = spell[0]["description"]
        self.assertIn("Sacrifice You can use a triggered action", text)
        self.assertTrue(
            text.rstrip().endswith("deal extra damage equal to your Power."),
            f"spellbound weapon runs on: ...{text[-90:]!r}",
        )

    def test_corpus_has_not_shrunk(self):
        by_source = {}
        for s in self.spells:
            by_source[s["source"]] = by_source.get(s["source"], 0) + 1
        self.assertEqual(len(self.spells), 1120)
        self.assertEqual(by_source, {"core": 331, "occult": 761, "terrible": 28})

    def test_every_spell_keeps_its_enrichment(self):
        """parse_spells.py alone strips tags; the chain is + tag_spells.py."""
        untagged = [s["name"] for s in self.spells if "tags" not in s]
        self.assertEqual(untagged, [], f"spells missing tags: {untagged[:10]}")


if __name__ == "__main__":
    unittest.main()
