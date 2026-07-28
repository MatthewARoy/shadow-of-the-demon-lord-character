"""Assertions against the committed data/paths.json.

Reads generated JSON only — no PDFs, no scripts/cache — so this runs in a
fresh clone where scripts/parse_paths.py cannot.

The 2026-07 rework declared parse_paths.py clean. It was not: the scanner's
running-head list was missing "paths of magic", "story development", and the
"Expert paths" case variant, so 38 talents and 8 descriptions carried a page
running head spliced into the middle of a sentence. These guard the return of
that class.

A failure here means a defect returned. Fix the parser; do not weaken the
assertion.
"""
import json
import os
import re
import unittest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "..", "data")

# Every page running head in the three books. Matched case-insensitively:
# "Expert paths" is how core prints the verso head, and matching only the
# title-case spelling is what let it through the last time.
RUNNING_HEADS = [
    "Novice Paths", "Expert Paths", "Master Paths", "Paths of Magic",
    "Paths of Skill", "Playing the Game", "Character Creation",
    "Traditions and Spells", "Creatures of Magic", "Occult Philosophy",
    "Terrible Beauty", "Running the Game", "A Land in Shadow",
    "Tales of the Desolation",
]

# "see Chapter 6" and "(see Terrible Beauty)" are real cross-references the
# books make; only an unannounced head is a defect.
HEAD_RE = re.compile(r"(?i)(?<!see )\b(" + "|".join(RUNNING_HEADS) + r")\b")

# The story-development sidebar is titled with the path's own name and the
# running head lands on the same line: "Assassin Story Development".
STORY_DEVELOPMENT_RE = re.compile(r"(?i)\bStory Development\b")


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def texts(paths):
    """Yield (label, text) for every free-text field a running head can reach."""
    for p in paths:
        yield f"{p['name']} description", p.get("description", "")
        for level, entry in p["levels"].items():
            for talent in entry.get("talents", []):
                yield f"{p['name']} L{level} {talent['name']}", talent["text"]
            langs = entry.get("languages_professions")
            if langs:
                yield f"{p['name']} L{level} languages_professions", langs
            magic = entry.get("magic")
            if magic and "raw" in magic:
                yield f"{p['name']} L{level} magic", magic["raw"]


class TestPathsInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.paths = load("paths.json")

    def test_no_running_heads_in_text(self):
        """The reported defect: 24 'Paths of Magic' and 8 'Expert paths'."""
        bad = [f"{label}: ...{HEAD_RE.search(text).group(0)}"
               for label, text in texts(self.paths) if HEAD_RE.search(text)]
        self.assertEqual(bad, [], f"running heads in path text: {bad}")

    def test_no_story_development_sidebar_titles(self):
        """The level-9 half of the defect — 'Assassin Story Development'."""
        bad = [label for label, text in texts(self.paths)
               if STORY_DEVELOPMENT_RE.search(text)]
        self.assertEqual(bad, [], f"story-development titles in path text: {bad}")

    def test_chapter_cross_references_are_kept(self):
        """The guard must not strip 'see Chapter 6' — those are real."""
        refs = [label for label, text in texts(self.paths)
                if re.search(r"see Chapter \d", text)]
        self.assertTrue(refs, "chapter cross-references were stripped wholesale")

    def test_talents_that_abut_a_stripped_head_are_intact(self):
        """The other direction: stripping must not eat the talent with it.

        Each of these ended on a running head or a story-development sidebar
        title. The tail is the real last sentence of the talent, so a stop
        heading that fires a line early truncates it.
        """
        expected = {
            ("Assassin", "9", "Killer’s Eye"):
                "the attack deals 2d6 extra damage.",
            ("Wizard", "9", "Spell Mastery"):
                "when you complete a rest.",
            ("World-Breaker", "9", "Controlled Chaos"):
                "your Chaotic Destruction talent is triggered.",
            ("Runewright", "6", "Runescribed Technomancy"):
                "8 hours for a rank 4 or higher spell.",
            ("Thief", "9", "Trap Sense"):
                "you make the challenge roll with 1 boon.",
        }
        for (path, level, talent), tail in expected.items():
            found = [p for p in self.paths if p["name"] == path]
            self.assertTrue(found, f"path missing: {path}")
            talents = found[0]["levels"][level].get("talents", [])
            match = [t for t in talents if t["name"] == talent]
            self.assertTrue(match, f"{path} L{level} lost talent {talent}")
            self.assertTrue(
                match[0]["text"].rstrip().endswith(tail),
                f"{path} L{level} {talent} was truncated: "
                f"...{match[0]['text'][-70:]!r}",
            )

    def test_corpus_has_not_shrunk(self):
        """A stop heading firing too early drops paths or empties blocks."""
        by_type = {"expert": 0, "master": 0}
        for p in self.paths:
            by_type[p["type"]] += 1
        self.assertEqual(by_type, {"expert": 42, "master": 123})
        total = sum(len(e.get("talents", []))
                    for p in self.paths for e in p["levels"].values())
        self.assertGreaterEqual(total, 550, "talents were lost")

    def test_every_path_has_its_required_levels(self):
        for p in self.paths:
            want = {"3", "6", "9"} if p["type"] == "expert" else {"7", "10"}
            self.assertTrue(
                set(p["levels"]) >= want,
                f"{p['name']} ({p['type']}) is missing levels: "
                f"{sorted(want - set(p['levels']))}",
            )
            self.assertTrue(p.get("description", "").strip(),
                            f"{p['name']} has no description")


if __name__ == "__main__":
    unittest.main()
