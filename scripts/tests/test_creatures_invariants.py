"""Assertions against the committed data/creatures.json.

Reads generated JSON only — no PDFs, no scripts/cache — so this runs in a
fresh clone where scripts/parse_creatures.py cannot.

Nothing closed the last stat block of a chapter: no name, no DIFFICULTY, no
prose header follows it. The wyvern absorbed the whole Paths of Magic
chapter intro on occult p.146, and the veteran picked up the first line of
the wrapped "Customizing / Creatures" sidebar heading.

A failure here means a defect returned. Fix the parser; do not weaken the
assertion.
"""
import json
import os
import re
import unittest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "..", "data")

RUNNING_HEADS = [
    "Novice Paths", "Expert Paths", "Master Paths", "Paths of Magic",
    "Paths of Skill", "Character Creation", "Playing the Game",
    "Traditions and Spells", "Story Development",
]
HEAD_RE = re.compile(r"(?i)(?<!see )\b(" + "|".join(RUNNING_HEADS) + r")\b")

LIST_FIELDS = ("traits", "attack_options", "special_attacks",
               "special_actions", "end_of_round", "magic")


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def texts(creatures):
    for c in creatures:
        for field in LIST_FIELDS:
            for i, item in enumerate(c.get(field) or []):
                yield f"{c['name']} ({field}[{i}])", item


class TestCreaturesInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.creatures = load("creatures.json")

    def test_no_chapter_bleed_in_stat_blocks(self):
        bad = [label for label, text in texts(self.creatures)
               if HEAD_RE.search(text)]
        self.assertEqual(bad, [], f"chapter bleed in stat blocks: {bad}")

    def test_no_entry_has_run_away(self):
        """An unterminated block absorbs the rest of the chapter.

        The wyvern's Instinctive Sting reached 2,128 characters this way.
        Harpy's 920-character special action is the longest legitimate item in
        the current corpus. Known shorter family-introduction leaks have exact
        assertions below; this ceiling catches a new large runaway as well.
        """
        long = [f"{label} ({len(text)} chars)"
                for label, text in texts(self.creatures) if len(text) > 950]
        self.assertEqual(long, [], f"stat-block entries that ran away: {long}")

    def test_family_introductions_do_not_bleed_into_previous_stat_block(self):
        """Narrow-column family prose still has to close the previous block."""
        previous_to_next_family = {
            "Fury": "Genie When the universe sprang",
            "Tiny Monster": "Muttering Maw Glistening trails",
            "Grim Reaper": "Incarnation of Nature In the view",
            "Specter": "Sprite Sprites dwell",
        }
        by_name = {c["name"]: c for c in self.creatures}
        for previous, leaked_intro in previous_to_next_family.items():
            joined = " ".join(text for _, text in texts([by_name[previous]]))
            self.assertNotIn(
                leaked_intro,
                joined,
                f"{previous} absorbed the {leaked_intro.split()[0]} family intro",
            )

    def test_no_wrapped_sidebar_heading_glued_on(self):
        """"Customizing" was the first line of a two-line sidebar heading."""
        bad = [label for label, text in texts(self.creatures)
               if re.search(r"\b(Customizing|Creating|Adjusting)$", text.strip())]
        self.assertEqual(bad, [], f"sidebar heading glued on: {bad}")

    def test_the_last_creature_of_each_book_is_bounded(self):
        """These are the two the chapter end could not close."""
        by_name = {(c["book"], c["name"]): c for c in self.creatures}
        wyvern = by_name[("occult", "Wyvern")]
        sting = [s for s in wyvern["special_attacks"]
                 if s.startswith("Instinctive Sting")]
        self.assertTrue(sting, "wyvern lost Instinctive Sting")
        self.assertTrue(
            sting[0].rstrip().endswith("attack with its stinger."),
            f"wyvern runs on: ...{sting[0][-90:]!r}",
        )
        veteran = by_name[("core", "Veteran")]
        self.assertEqual(
            veteran["attack_options"],
            ["Sword (melee) +2 with 1 boon (2d6 + 2)",
             "Longbow (long range) +0 with 1 boon (2d6 + 1)"],
        )

    def test_corpus_has_not_shrunk(self):
        self.assertEqual(len(self.creatures), 155)
        by_book = {}
        for c in self.creatures:
            by_book[c["book"]] = by_book.get(c["book"], 0) + 1
        self.assertEqual(by_book, {"core": 127, "occult": 28})

    def test_every_creature_has_its_stat_header(self):
        """A page limit that fires early would truncate a block's header.

        Templates carry modifier lines rather than absolute statistics, but
        those lines still populate the same display fields.
        """
        for c in self.creatures:
            for field in ("difficulty", "descriptor", "defense_line",
                          "attributes", "speed"):
                self.assertTrue(c.get(field),
                                f"{c['name']} is missing {field}")

    def test_animated_corpse_template_preserves_all_modifiers(self):
        animated = [c for c in self.creatures if c["name"] == "Animated Corpse"]
        self.assertEqual(len(animated), 2)
        core = next(c for c in animated if c["book"] == "core")
        occult = next(c for c in animated if c["book"] == "occult")

        self.assertNotIn("kind", core)
        self.assertEqual(occult.get("kind"), "template")
        self.assertEqual(occult.get("difficulty_adjustment"), -1)
        self.assertEqual(occult["defense_line"], "Insanity —; Corruption —")
        self.assertEqual(occult["attributes"], "Agility –2, Intellect —, Will +5")
        self.assertIn("Immune damage from cold", occult["traits"][0])
        self.assertEqual(occult["traits"][1],
                         "Traits and Talents The creature loses all talents.")

    def test_grim_reaper_preserves_wrapped_will_and_first_trait(self):
        grim = next(c for c in self.creatures
                    if c["book"] == "occult" and c["name"] == "Grim Reaper")
        self.assertEqual(
            grim["attributes"],
            "Strength 20 (+10), Agility 20 (+10), Intellect 20 (+10), Will 20 (+10)",
        )
        self.assertTrue(grim["traits"][0].startswith("Immune damage from cold"))


if __name__ == "__main__":
    unittest.main()
