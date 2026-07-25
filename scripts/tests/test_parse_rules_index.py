import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
FIXTURES = os.path.join(HERE, "..", "fixtures")

import parse_rules_index as p

# scripts/cache/ and the source PDFs are gitignored, so chunk() cannot run in
# a fresh clone or anywhere extract_text.py has not been run. Tests that
# exercise the parser against the real corpus are skipped there.
#
# Defect coverage does not depend on this: every defect class is also
# asserted against the committed data/rules-index.json in
# test_rules_index_invariants.py, which reads generated JSON only and runs
# everywhere.
HAS_CACHE = os.path.exists(os.path.join(HERE, "..", "cache", "core.txt"))
needs_cache = unittest.skipUnless(
    HAS_CACHE, "scripts/cache is gitignored; run scripts/extract_text.py with the PDFs")


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


@needs_cache
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


@needs_cache
class TestAnchorTerminatedRanges(unittest.TestCase):
    def test_no_spell_entries_leak_from_the_spell_list(self):
        """Defect E: spell entries begin partway down core p.116.

        Scoped to the magic chapter on purpose. Several rules sections
        elsewhere legitimately share a name with a spell — Illumination and
        Invisibility (p.44), Reincarnation (p.41) — and must not be removed.
        """
        import json
        data = os.path.join(HERE, "..", "..", "data", "spells.json")
        with open(data) as f:
            spell_names = {s["name"].lower() for s in json.load(f)}
        offenders = sorted({c["t"] for c in p.chunk()
                            if c["p"] >= 111 and c["t"].lower() in spell_names})
        self.assertEqual(offenders, [], f"spell entries in the rules index: {offenders}")

    def test_magic_rules_before_the_spell_list_are_retained(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertIn("Casting a Spell", titles,
                      "the anchor cut too early and removed magic rules")

    def test_rules_sections_sharing_a_spell_name_survive(self):
        """Guards the assertion above against becoming an over-deletion."""
        titles = {c["t"] for c in p.chunk()}
        for t in ("Illumination", "Invisibility", "Reincarnation"):
            self.assertIn(t, titles, f"over-deleted the rules section {t}")


@needs_cache
class TestTableManifest(unittest.TestCase):
    def test_weapon_rows_are_not_sections(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Sling", "Trident", "Whip", "Blowgun", "Crossbow"):
            self.assertNotIn(t, titles, f"table row {t} chunked as a section")

    def test_no_chunk_carries_a_weapon_stat_row(self):
        """The reported bug: searching 'sling' returned a run-on table row."""
        offenders = [c["t"] for c in p.chunk()
                     if "uses stones" in c["x"] or "Name. Damage. Hands." in c["x"]]
        self.assertEqual(offenders, [], f"weapon stat rows still present: {offenders}")

    def test_ancestry_random_tables_are_excluded(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Human Background", "Human Personality", "Dwarf Age", "Goblin Build"):
            self.assertNotIn(t, titles, f"ancestry table {t} chunked as a section")

    def test_profession_tables_are_excluded(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Academic Professions", "Wilderness Professions"):
            self.assertNotIn(t, titles)

    def test_equipment_prose_sections_are_retained(self):
        """These carry rules text that exists ONLY in the index.

        equipment.json holds price and availability for Garrote, Holy Water,
        and Lantern but not their rules, so over-deleting here loses data
        with no other home.
        """
        titles = {c["t"] for c in p.chunk()}
        for t in ("Improvised Weapons", "Special Materials", "Living Expenses"):
            self.assertIn(t, titles, f"manifest over-deleted: lost {t}")

    def test_price_and_damage_tables_are_excluded(self):
        chunks = p.chunk()
        for c in chunks:
            self.assertNotEqual(c["x"].strip(), "Off One 1d3 Two 1d6",
                                "improvised weapon damage table retained")
            self.assertNotRegex(c["x"], r"^Rank \d+ \d+ gc",
                                "incantation price table retained")

    def test_incantations_rules_section_survives(self):
        """'Incantations' captions a price table AND a rules section.

        Matching the caption on text alone would delete the rules section,
        so the table test requires table furniture on the following line.
        """
        titles = {c["t"] for c in p.chunk()}
        self.assertIn("Incantations", titles)
        body = next(c["x"] for c in p.chunk() if c["t"] == "Incantations")
        self.assertGreater(len(body), 80, "kept the table, dropped the prose")

    def test_combat_rules_sections_are_retained(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Melee Attack Options", "Ranged Attack Options", "Cover"):
            self.assertIn(t, titles, f"manifest over-deleted: lost {t}")


# Core p.42-43. Immobilized is the one most easily lost from this list.
AFFLICTIONS = [
    "Asleep", "Blinded", "Charmed", "Compelled", "Dazed", "Deafened",
    "Defenseless", "Diseased", "Fatigued", "Frightened", "Grabbed",
    "Immobilized", "Impaired", "Poisoned", "Prone", "Slowed", "Stunned",
    "Surprised", "Unconscious",
]


@needs_cache
class TestShortRulesSurvive(unittest.TestCase):
    def test_short_rules_are_independent_chunks(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Dazed", "Rush", "Disabled", "Dying"):
            self.assertIn(t, titles, f"{t} was merged away by length")

    def test_all_nineteen_afflictions_resolve(self):
        titles = {c["t"] for c in p.chunk()}
        missing = [a for a in AFFLICTIONS if a not in titles]
        self.assertEqual(missing, [], f"missing afflictions: {missing}")
        self.assertEqual(len(AFFLICTIONS), 19)

    def test_dazed_is_not_glued_onto_compelled(self):
        compelled = [c for c in p.chunk() if c["t"] == "Compelled"]
        self.assertEqual(len(compelled), 1)
        self.assertNotIn("Dazed", compelled[0]["x"])


@needs_cache
class TestHeadingReconstruction(unittest.TestCase):
    def test_multiline_headings_are_joined(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertIn("Attack with a Melee Weapon", titles)
        self.assertIn("Attack with a Ranged Weapon", titles)

    def test_no_orphan_fragment_titles(self):
        """A wrapped heading's tail starts lowercase.

        Case matters: "The Dice" and "The Game Master" are legitimate
        headings, while "a Melee Weapon" and "to Attack Rolls" are the
        second halves of headings the extraction split across two lines.
        """
        bad = sorted({c["t"] for c in p.chunk()
                      if c["t"].split()[0] in {"a", "an", "the", "to", "of", "with", "or", "and"}})
        self.assertEqual(bad, [], f"orphaned heading fragments: {bad}")

    def test_running_head_furniture_does_not_leak_into_bodies(self):
        """Only the variant capitalisation indicates furniture.

        "While playing the game, keep track of what your character does" is
        ordinary prose and must not be flagged. The extraction's "PLaying
        the Game" is a page header that escaped the exact-match filter.
        """
        bad = sorted({c["t"] for c in p.chunk() if "PLaying the Game" in c["x"]})
        self.assertEqual(bad, [], f"chunks carrying running-head furniture: {bad}")

    def test_running_head_variant_is_not_a_chunk_title(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertNotIn("PLaying the Game", titles)


if __name__ == "__main__":
    unittest.main()
