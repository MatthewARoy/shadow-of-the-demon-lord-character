"""Unit tests for scripts/tables.py.

These run on synthetic line lists rather than the corpus, so they cover what
the data-level invariants cannot see: the cases the module *refuses*. A
refusal costs a table; a bad acceptance produces a table that looks complete
and is wrong, which is the failure a reader has no way to detect.
"""

import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))

import tables


def cap(lines, j=0, pages=None, stop=None, caption=None):
    """capture() over a one-page block with no external stop condition."""
    pages = pages if pages is not None else [1] * len(lines)
    return tables.capture(
        lines, pages, j, len(lines), stop or (lambda k: False), caption
    )


class TestDieKeyedTables(unittest.TestCase):
    def test_rows_are_bounded_by_the_key_line(self):
        table, after = cap(
            [
                "d6",
                "Effect",
                "1",
                "The creature becomes a monster",
                "2",
                "It gains the horrifying trait",
                "3",
                "Its Size increases by 1d6",
                "4",
                "Its Size becomes 1/2",
                "5",
                "It teleports away",
                "6",
                "It gains a +20 bonus",
                "to its Health",
            ]
        )
        self.assertEqual(table["columns"], ["d6", "Effect"])
        self.assertEqual(len(table["rows"]), 6)
        self.assertEqual(table["rows"][-1], ["6", "It gains a +20 bonus to its Health"])
        self.assertEqual(after, 15)

    def test_ranged_keys_span_the_die(self):
        table, _ = cap(["3d6", "Response", "3", "a", "4–17", "b", "18", "c"])
        self.assertEqual([r[0] for r in table["rows"]], ["3", "4–17", "18"])

    def test_a_bare_die_in_prose_is_not_a_table(self):
        """Spell bodies quote dice constantly ("gain 1d3 Corruption")."""
        table, after = cap(
            ["1d3", "Corruption is gained by the target.", "More prose."]
        )
        self.assertIsNone(table)
        self.assertEqual(after, 0)

    def test_keys_beyond_the_die_are_refused(self):
        """A page number read as a row key: 122 cannot come off a d6."""
        table, _ = cap(["d6", "Effect", "1", "a", "2", "b", "122", "Paths of Magic"])
        self.assertIsNone(table)

    def test_out_of_order_keys_are_refused(self):
        table, _ = cap(["d6", "Effect", "1", "a", "5", "b", "2", "c"])
        self.assertIsNone(table)

    def test_a_page_break_ends_the_table(self):
        lines = ["d6", "Effect", "1", "a", "2", "b", "31", "Level 6 Wardscribe"]
        table, _ = cap(lines, pages=[31, 31, 31, 31, 31, 31, 32, 32])
        self.assertEqual([r[0] for r in table["rows"]], ["1", "2"])

    def test_a_tab_led_paragraph_ends_the_table(self):
        """The extraction marks every paragraph opening with a leading tab."""
        table, after = cap(
            [
                "d6",
                "Effect",
                "1",
                "1 titanic demon",
                "2",
                "3d6 tiny demons",
                "\t A demon that emerges from the hole acts according to its nature.",
            ]
        )
        self.assertEqual(table["rows"][-1], ["2", "3d6 tiny demons"])
        self.assertEqual(after, 6)


class TestRankKeyedTables(unittest.TestCase):
    def test_a_single_column_pair_chunks_by_two(self):
        table, after = cap(
            [
                "Spell Rank",
                "Blocks",
                "0",
                "1",
                "1",
                "8",
                "2",
                "16",
                "5+",
                "128",
                "Each block is an object with Defense 10 and Health 20.",
            ],
            caption="Building Blocks",
        )
        self.assertEqual(table["caption"], "Building Blocks")
        self.assertEqual(table["columns"], ["Spell Rank", "Blocks"])
        self.assertEqual(
            table["rows"], [["0", "1"], ["1", "8"], ["2", "16"], ["5+", "128"]]
        )
        # The talent's own prose resumes at the first line too long to be a cell.
        self.assertEqual(after, 10)

    def test_side_by_side_pairs_unfold_and_sort(self):
        """Printed 0/6, 1/7, 2/8 — reading order is not rank order."""
        table, _ = cap(
            [
                "Spell Rank",
                "Duration",
                "Spell Rank",
                "Duration",
                "0",
                "1 minute",
                "6",
                "1 week",
                "1",
                "10 minutes",
                "7",
                "1 month",
                "2",
                "1 hour",
                "8",
                "1 year",
                "3",
                "4 hours",
            ]
        )
        self.assertEqual(table["columns"], ["Spell Rank", "Duration"])
        self.assertEqual(
            [r[0] for r in table["rows"]], ["0", "1", "2", "3", "6", "7", "8"]
        )
        self.assertEqual(dict(table["rows"])["6"], "1 week")

    def test_a_shifted_run_is_refused(self):
        """Every row must open on a rank; a swallowed line shifts them all."""
        table, _ = cap(["Spell Rank", "Blocks", "0", "1", "oops", "8", "2", "16"])
        self.assertIsNone(table)

    def test_one_header_is_not_a_table(self):
        table, _ = cap(["Duration", "1 hour or until expended", "0", "1"])
        self.assertIsNone(table)
