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
            # Ended on the "Brewmaster Potions" sidebar, and absorbed the
            # whole potion list plus the blizzard mage's intro behind it.
            ("Brewmaster", "9", "Strengthen Potion"):
                "another dose of Brewmaster’s Admixture.",
            # Ended on the "Fighter Talents" sidebar title, which heads the
            # seven talents below and so must be dropped without ending the
            # block — see test_sidebar_talents_are_kept.
            ("Fighter", "9", "Weapon Mastery"):
                "even if it is 9 or less.",
            # Ended on the all-caps header of the path-granted witch fire
            # spell, whose text belongs to spells.json.
            ("Witch", "3", "Witch Fire"):
                "which is described below.",
            ("Inquisitor", "10", "Inquisitor’s Judgment"):
                "subject to your scrutiny deal 1d6 extra damage.",
            # Each ended on the all-caps header of the path-granted spell
            # printed directly below it.
            ("Necromancer", "7", "Command Undead"):
                "which is described below.",
            ("Templar", "7", "Temple of Faith"):
                "which is described below.",
            ("Tenebrist", "10", "Shadow Form"):
                "which is described below.",
            ("Technomancer", "10", "Animate Object"):
                "which is described below.",
            ("Exorcist", "7", "Exorcist Magic"):
                "which is described below.",
            ("Spellbinder", "9", "Magic Weapon"):
                "your attack deals 1d6 extra damage.",
            ("Keeper of the Flame", "7", "Inured to Fire"):
                "to resist attacks using fire with 1 boon.",
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

    def test_sidebar_talents_are_kept(self):
        """"Fighter Talents" heads real talents, so it must not end the block.

        Treating it as a boundary — as every other path-named sidebar is
        treated — silently cost these seven.
        """
        fighter = [p for p in self.paths if p["name"] == "Fighter"][0]
        names = [t["name"] for t in fighter["levels"]["9"]["talents"]]
        for talent in ("Fight with Two Weapons", "Haft Attack",
                       "Powerful Attack", "Precise Attack", "Shield Bash",
                       "Swift Reload", "Swift Shot"):
            self.assertIn(talent, names)

    def test_no_spell_debris_parsed_as_a_talent(self):
        """Path-granted spells are printed inside the path entry.

        Eight of them leaked into the talent that grants them, and their
        own field lines became talents: "Attack" from a "Roll 20+" line,
        "Area" from temple of faith's area. Spell text belongs to
        spells.json, which parses these same blocks properly.
        """
        # The labelled fields of a spell, which are never talent names.
        SPELL_FIELDS = {"Attack", "Utility", "Area", "Target", "Duration",
                        "Requirement", "Prerequisite"}
        bad = [f"{p['name']} L{level} {t['name']}"
               for p in self.paths
               for level, entry in p["levels"].items()
               for t in entry.get("talents", [])
               if t["name"] in SPELL_FIELDS
               or re.match(r"^Roll \d+\+", t["text"])
               or re.search(r"\b(ATTACK|UTILITY)\s+\d", t["text"])]
        self.assertEqual(bad, [], f"spell debris parsed as talents: {bad}")

    def test_corpus_has_not_shrunk(self):
        """A stop heading firing too early drops paths or empties blocks.

        545, not the original 550: five spell fields that had been parsed as
        talents are gone — three "Attack" lines, temple of faith's "Area",
        and spellbound weapon's "Sacrifice", which spells.json carries.
        Lower this only alongside proof that what vanished was never a talent.
        """
        by_type = {"expert": 0, "master": 0}
        for p in self.paths:
            by_type[p["type"]] += 1
        self.assertEqual(by_type, {"expert": 46, "master": 131})
        total = sum(len(e.get("talents", []))
                    for p in self.paths for e in p["levels"].values())
        self.assertGreaterEqual(total, 545, "talents were lost")

    def test_no_talent_has_run_away(self):
        """An unterminated block absorbs the rest of the chapter.

        Strengthen Potion reached 6,084 characters by swallowing the
        brewmaster potion list; the longest real talent is under 1,400.
        """
        long = [(len(t["text"]), f"{p['name']} L{level} {t['name']}")
                for p in self.paths
                for level, entry in p["levels"].items()
                for t in entry.get("talents", [])
                if len(t["text"]) > 2000]
        self.assertEqual(long, [], f"talents that ran away: {long}")

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


class TestPathTablesAndCatalogs(unittest.TestCase):
    """Tables and option catalogues printed inside a path entry (#20, #19)."""

    @classmethod
    def setUpClass(cls):
        cls.paths = {p["name"]: p for p in load("paths.json")}

    def talent(self, path, level, name):
        found = [t for t in self.paths[path]["levels"][level].get("talents", [])
                 if t["name"] == name]
        self.assertTrue(found, f"{path} L{level} lost talent {name}")
        return found[0]

    def test_draw_sigil_carries_its_duration_table(self):
        """The reported defect.

        Draw Sigil ended "...as shown on the following table. Spell Rank
        Duration Spell Rank Duration 1 minute 1 week 10 minutes 1 month ..."
        — the ranks dropped as page-number furniture, the durations run
        together in the order the two column pairs were printed. The table is
        two pairs side by side, so reading order is not rank order.
        """
        t = self.talent("Wardscribe", "3", "Draw Sigil")
        self.assertTrue(t["text"].rstrip().endswith(
            "as shown on the following table."))
        self.assertNotIn("Spell Rank", t["text"])
        self.assertEqual(len(t["tables"]), 1)
        table = t["tables"][0]
        self.assertEqual(table["columns"], ["Spell Rank", "Duration"])
        self.assertEqual(len(table["rows"]), 11)
        self.assertEqual(table["rows"][0], ["0", "1 minute"])
        self.assertEqual(table["rows"][6], ["6", "1 week"])
        self.assertEqual(table["rows"][-1], ["10", "100 years"])

    def test_farseer_revelation_table_survived_the_die_marker(self):
        """block_end stopped dead at the d6, dropping the table entirely."""
        t = self.talent("Farseer", "3", "Unspeakable Revelation")
        table = t["tables"][0]
        self.assertEqual(table["columns"], ["d6", "Effect"])
        self.assertEqual([r[0] for r in table["rows"]], list("123456"))
        self.assertIn("Insanity equal to your Will score", table["rows"][0][1])

    def test_builder_table_no_longer_splits_its_own_talent(self):
        """Magic Construction read "...1 yard on a side. Building Blocks
        Spell Rank Blocks 5+ Each block is an object with Defense 10...".
        Its prose resumes below the table and has to rejoin the talent."""
        t = self.talent("Builder", "7", "Magic Construction")
        self.assertNotIn("Building Blocks", t["text"])
        self.assertIn("each a cube 1 yard on a side. Each block is an object",
                      t["text"])
        table = t["tables"][0]
        self.assertEqual(table["caption"], "Building Blocks")
        self.assertEqual(table["columns"], ["Spell Rank", "Blocks"])
        self.assertEqual(table["rows"][-1], ["5+", "128"])

    def test_sigils_are_a_catalogue_not_level_nine_talents(self):
        """All twelve sigils were credited to level 9 outright.

        They are chosen one at a time from level 3 on, so a level-9 wardscribe
        was shown nine sigils it had not learned and four it could have had
        since level 3. Level 9 grants exactly two talents.
        """
        ward = self.paths["Wardscribe"]
        self.assertEqual([t["name"] for t in ward["levels"]["9"]["talents"]],
                         ["Hasty Sigil", "Learn Master Sigil"])
        groups = ward["catalog"]["groups"]
        self.assertEqual([(g["name"], g["level"], len(g["entries"])) for g in groups],
                         [("Basic Sigils", 3, 4),
                          ("Advanced Sigils", 6, 4),
                          ("Master Sigils", 9, 4)])
        names = [e["name"] for g in groups for e in g["entries"]]
        for sigil in ("Alarum", "Glyphic Protection", "Crippling Pain",
                      "Gibbering Madness", "Swift Transit"):
            self.assertIn(sigil, names)

    def test_lorekeeper_discoveries_are_a_catalogue(self):
        """The identical defect: eight options, three picks, all on level 9."""
        lore = self.paths["Lorekeeper"]
        self.assertEqual([t["name"] for t in lore["levels"]["9"]["talents"]],
                         ["Epiphany", "Esoteric Discovery"])
        groups = lore["catalog"]["groups"]
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]["entries"]), 8)
        self.assertIn("Lore of Tongues", [e["name"] for e in groups[0]["entries"]])

    def test_catalogue_captions_left_the_talents_they_glued_onto(self):
        """Three talents ended on a sidebar caption and its blurb (#19)."""
        self.assertEqual(
            self.talent("Wardscribe", "9", "Learn Master Sigil")["text"],
            "When you would learn a sigil, you can choose to learn a master sigil.")
        entries = {e["name"]: e["text"]
                   for g in self.paths["Wardscribe"]["catalog"]["groups"]
                   for e in g["entries"]}
        for name, caption in (("Glyphic Protection", "Advanced Sigils"),
                              ("Waves of Lethargy", "Master Sigils")):
            self.assertNotIn(caption, entries[name])

    def test_fighter_and_thief_option_lists_stay_talents(self):
        """The same printed shape, but not corrupted — left as they were.

        Moving them too would change a representation that parses cleanly and
        is asserted above in test_sidebar_talents_are_kept. Recorded here so
        the inconsistency is a decision rather than an oversight.
        """
        for path in ("Fighter", "Thief"):
            self.assertNotIn("catalog", self.paths[path])

    def test_no_catalogue_entry_is_also_a_talent(self):
        """A catalogue that failed to end its block leaves both copies."""
        for name, p in self.paths.items():
            talents = {t["name"] for e in p["levels"].values()
                       for t in e.get("talents", [])}
            entries = {e["name"] for g in p.get("catalog", {}).get("groups", [])
                       for e in g["entries"]}
            self.assertEqual(talents & entries, set(), name)


class TestMagicGrants(unittest.TestCase):
    """A Magic line can offer a choice *and* hand over a named spell."""

    @classmethod
    def setUpClass(cls):
        cls.paths = {p["name"]: p for p in load("paths.json")}
        cls.spells = {s["name"].lower() for s in load("spells.json")}

    def test_spellbinder_receives_the_spell_its_path_is_built_around(self):
        """Every choice rule in parse_magic returns as soon as it matches, so
        the "In addition, you learn the spellbound weapon spell" clause was
        never reached. A spellbinder never got the spell, while both its
        talents key off "the target weapon of your spellbound weapon spell".
        """
        magic = self.paths["Spellbinder"]["levels"]["3"]["magic"]
        self.assertEqual(magic.get("grants"), ["spellbound weapon"])
        # The choice on the same line has to survive alongside the grant.
        self.assertEqual(magic["choices"],
                         [{"pick": 1,
                           "options": ["discover_tradition", "learn_spell"]}])

    def test_an_optional_grant_is_not_recorded_as_a_given(self):
        """The preserver picks one of two benefits, each granting a different
        spell. Recording either hands the character a spell it may not have
        chosen, so a bulleted Magic line grants nothing outright."""
        magic = self.paths["Preserver"]["levels"]["3"]["magic"]
        self.assertIn("you learn the life sense spell", magic["raw"])
        self.assertNotIn("grants", magic)

    def test_every_granted_spell_resolves(self):
        """A grant naming a spell that is not in the archive is a dead end —
        the engine can only leave the player a note to add it by hand."""
        for name, p in self.paths.items():
            for level, entry in p["levels"].items():
                for grant in (entry.get("magic") or {}).get("grants", []):
                    self.assertIn(grant.lower(), self.spells,
                                  f"{name} L{level} grants unknown spell {grant!r}")
