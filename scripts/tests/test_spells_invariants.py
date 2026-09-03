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
DARK_MAGIC_SIDEBAR_RE = re.compile(r"(?i)\bDark Magic, Dark Speech\b")


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

    def test_no_dark_magic_sidebar_text(self):
        bad = [label for label, text in texts(self.spells)
               if DARK_MAGIC_SIDEBAR_RE.search(text)]
        self.assertEqual(bad, [], f"dark-magic sidebar in spells: {bad}")

    def test_sidebar_splice_preserves_surrounding_spell_text(self):
        by_name = {spell["name"]: spell for spell in self.spells}
        self.assertIn("target must make a Strength challenge roll",
                      by_name["Ravenous Maggots"]["description"])
        self.assertIn("If the target remains alive, it is compelled",
                      by_name["Hook the Soul"]["description"])

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
        self.assertEqual(len(self.spells), 1165)
        self.assertEqual(by_source, {"core": 331, "occult": 762,
                                     "terrible": 28, "dlc2": 44})

    def test_every_spell_keeps_its_enrichment(self):
        """parse_spells.py alone strips tags; the chain is + tag_spells.py."""
        untagged = [s["name"] for s in self.spells if "tags" not in s]
        self.assertEqual(untagged, [], f"spells missing tags: {untagged[:10]}")


if __name__ == "__main__":
    unittest.main()


class TestSpellTables(unittest.TestCase):
    """The random tables printed inside a spell (#20).

    Before capture, eight of these were dropped whole at the "d6" marker —
    strange changes, whose entire effect is its table, stored a description
    ending "...consult the following table." and then jumped to its Attack
    Roll entry. Three more were flattened into the description instead:
    bewilder and query the void ran their rows together as prose, and wild
    magic kept only its caption ("...Roll a d20 to see what happens. Wild
    Magic").
    """

    @classmethod
    def setUpClass(cls):
        cls.spells = {s["name"]: s for s in load("spells.json")}

    def table_of(self, name):
        spell = self.spells.get(name)
        self.assertIsNotNone(spell, f"spell missing: {name}")
        self.assertIn("tables", spell, f"{name} lost its table")
        self.assertEqual(len(spell["tables"]), 1)
        return spell["tables"][0]

    def test_every_captured_table_is_whole(self):
        """A die-keyed table's rows cover its die, end to end.

        A row missing from the middle, or a table truncated at the last row,
        is the failure this class of parse produces and the one a reader
        cannot see: the table still looks complete.
        """
        expected = {
            "Scintillating Worms": ("d6", 6),
            "Wild Magic": ("d20", 9),           # nine ranged rows spanning 1–20
            "Strange Changes": ("d6", 6),
            "Chaos Vortex": ("d6", 6),
            "Scintillating Barrier": ("d6", 6),
            "Query the Void": ("3d6", 7),       # ranged rows spanning 3–18
            "Call Greater Demon": ("d6", 3),      # 1 / 2–5 / 6
            "Into the Void": ("d6", 6),
            "Call Titanic Demon": ("d6", 3),
            "Bewilder": ("1d6", 6),
            "Open the Underworld’s Gates": ("d6", 6),
        }
        for name, (die, rows) in expected.items():
            table = self.table_of(name)
            self.assertEqual(table["columns"][0], die, name)
            self.assertEqual(len(table["rows"]), rows, f"{name} row count")
            count, _, size = die.partition("d")
            low = int(count or 1)
            high = low * int(size)
            self.assertEqual(int(re.findall(r"\d+", table["rows"][0][0])[0]), low,
                             f"{name} does not start at {low}")
            self.assertEqual(int(re.findall(r"\d+", table["rows"][-1][0])[-1]), high,
                             f"{name} does not reach {high}")
            for key, text in table["rows"]:
                self.assertTrue(text.strip(), f"{name} row {key} has no text")

    def test_prose_below_a_table_is_not_a_row(self):
        """The paragraph a spell resumes with sits directly under the table.

        Into the void's sixth row read "3d6 tiny demons A demon that emerges
        from the hole acts according to its nature..." until the extraction's
        leading-tab paragraph marker became a table boundary. The prose is not
        lost — it belongs to the description.
        """
        rows = dict(self.table_of("Into the Void")["rows"])
        self.assertEqual(rows["6"], "3d6 tiny demons")
        for name in ("Into the Void", "Call Greater Demon", "Call Titanic Demon"):
            self.assertIn("acts according to its nature",
                          self.spells[name]["description"], name)

    def test_strange_changes_effects_are_readable(self):
        """The clearest loss: a player could not resolve the spell at all."""
        rows = dict(self.table_of("Strange Changes")["rows"])
        self.assertIn("becomes a monster", rows["1"])
        self.assertIn("horrifying trait", rows["2"])
        self.assertIn("teleports", rows["5"])

    def test_no_table_row_absorbed_the_next_spells_name(self):
        """A spell's all-caps name sits directly below the last row.

        Scintillating worms' sixth outcome ended "...3 boons until the end of
        its turn. STRANGE CHANGES" before the stop test looked at position.
        """
        for name, s in self.spells.items():
            for table in s.get("tables", []):
                for row in table["rows"]:
                    for cell in row:
                        self.assertFalse(
                            len(cell) > 3 and cell == cell.upper() and cell != cell.lower(),
                            f"{name}: all-caps debris in a table cell: {cell!r}")

    def test_captions_left_the_description(self):
        """Wild magic's description ended on its own table's caption."""
        self.assertTrue(
            self.spells["Wild Magic"]["description"].rstrip().endswith(
                "Roll a d20 to see what happens."))
        self.assertEqual(self.table_of("Wild Magic").get("caption"), "Wild Magic")
        self.assertEqual(self.table_of("Bewilder").get("caption"), "Bewilder Effects")

    def test_flattened_table_prose_is_gone_from_descriptions(self):
        """Bewilder and query the void ran their rows together as prose."""
        self.assertNotIn("Bewilder Effects", self.spells["Bewilder"]["description"])
        self.assertNotIn("16–17", self.spells["Query the Void"]["description"])

    def test_table_text_still_reaches_the_tagger(self):
        """Bewilder only mentions damage and fear inside its table.

        While the table was flattened the keyword rules saw that text by
        accident. tag_spells.taggable_text() now hands it to them on purpose;
        without it the spell silently loses three true tags.
        """
        tags = set(self.spells["Bewilder"]["tags"])
        self.assertTrue({"damage", "auto-damage", "fear"} <= tags, sorted(tags))

    def test_prose_keyed_tables_are_left_alone(self):
        """Out of scope, deliberately, and recorded so it stays a decision.

        Creation's materials and brew longevity potion's age categories are
        keyed by prose, not by a number, and both columns wrap over several
        lines — there is no line-level row boundary to key on. Their text
        stays flattened in the description rather than being guessed at.
        """
        for name in ("Creation", "Brew Longevity Potion"):
            self.assertNotIn("tables", self.spells[name])
        self.assertIn("Fog or vapor", self.spells["Creation"]["description"])
