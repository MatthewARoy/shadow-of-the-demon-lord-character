#!/usr/bin/env python3
"""Declared table regions in the indexed rulebook ranges.

The chunker cannot tell a table row from a heading — every row's first cell
looks like a short Title-Case line, which is why searching "sling" used to
return a run-on weapon row. Rather than guess, we declare where the tables
are and skip them. Their content already exists, properly structured, in
data/equipment.json and data/curated.json.

Blocks are keyed on caption TEXT, not page number, so they survive
re-extraction of the PDFs.

A block opens at a declared caption and stays open across the table's
internal furniture — the die-size line, the column header, row numbers and
row text — closing only at the next real heading. Source shape:

    Human Background     <- caption, opens the block
    d20                  <- die size
    Background           <- column header (caption's trait word)
    1                    <- row number
    You died and ...     <- row text
    ...
    Human Personality    <- next caption, re-opens

The heuristic detector in scripts/scan_parse_quality.py reports table debris
that this manifest does not cover. It reports; it never deletes. A heuristic
that deletes loses data silently — an earlier draft of this design would
have removed Garrote, Holy Water, Lantern, and Poison, whose rules text
lives only in the index.
"""
import json
import os
import re

DATA = os.path.join(os.path.dirname(__file__), "..", "data")

# The die-size line that follows a random table's caption.
DIE_LINE = re.compile(r"^(?:d20|d12|d10|d8|d6|3d6|2d6)$")

# Column headers used by the equipment stat tables.
COLUMN_HEADERS = {
    "Name", "Name.", "Damage", "Damage.", "Hands", "Hands.", "Properties",
    "Properties.", "Price", "Price.", "Avail", "Avail.", "Availability",
    "Item", "Item.", "Defense", "Defense.", "Profession", "Table",
    "Animal", "Service", "Cost", "Spell Rank",
}

# Literal captions of the equipment, price, and reference tables.
TABLE_CAPTIONS = {
    # ch.1 character creation
    "Profession Types", "Interesting Thing Tables", "Interesting Things",
    "Interesting Things Table 1", "Interesting Things Table 2",
    "Interesting Things Table 3", "Ancestry Tables", "Wealth",
    # ch.2 playing the game
    "Movement by Pace", "Falling Damage", "Situational Banes",
    # ch.6 equipment
    "Lifestyle", "Clothing and Armor", "Ammunition", "Armor Descriptions",
    "Basic Melee Weapons", "Ranged Weapons", "Shields",
    "Military Melee Weapons", "Swift Melee Weapons", "Heavy Melee Weapons",
    "Clothing and Accessories", "Personal Gear", "Tools",
    "Food and Accommodations", "Food & Accommodations",
    "Animals and Animal Gear", "Hirelings", "Apparel and Accessories",
    "Adventuring Gear", "Other Commodities", "Prices",
    # ch.7 magic
    "Castings", "Potions", "Relics",
}


def _ancestry_names():
    with open(os.path.join(DATA, "curated.json")) as f:
        return {a["name"] for a in json.load(f)["ancestries"]}


ANCESTRIES = _ancestry_names()

# Trait tables are captioned "<Ancestry> <Trait>". The trait half is
# deliberately NOT enumerated: the tail is irregular (Quirk, Purpose, Hatred,
# Odd Habit, Distinctive Appearance, Apparent Ancestry), and "followed by a
# die size" identifies a table header far more reliably than a name list.
ANCESTRY_CAPTION = re.compile(r"^(%s)\s+\S" % "|".join(sorted(ANCESTRIES)))

PROFESSION_CAPTION = re.compile(r"^[A-Z][a-z]+ Professions$")


def is_table_caption(caption, next_line=""):
    """True when `caption` opens a declared table block."""
    caption, next_line = caption.strip(), (next_line or "").strip()
    if caption in TABLE_CAPTIONS:
        return True
    if PROFESSION_CAPTION.match(caption):
        return True
    if ANCESTRY_CAPTION.match(caption) and DIE_LINE.match(next_line):
        return True
    return False


# A real section heading is followed by its body prose; a table cell is
# followed by another cell. "Improvised Weapons" is followed by "You can also
# attack with objects you find around you...", while the weapon-name cell
# "Club" is followed by "1d6". This length test is what lets a block contain
# heading-shaped row cells without swallowing the section that follows it.
BODY_PROSE_MIN = 50


def is_table_internal(line, open_caption, next_line=""):
    """True for a heading-shaped line that belongs to an already-open table.

    Without this, every row cell closes the block: the column header ("Human
    Background" is followed by "d20" then a bare "Background") and every
    weapon name ("Club", "Sling", "Trident") would each open a section.
    """
    s = line.strip()
    if not s or DIE_LINE.match(s) or re.match(r"^\d{1,3}$", s):
        return True
    if s in COLUMN_HEADERS:
        return True
    # The column header repeats the caption's trait word: "Human Background"
    # is followed by a bare "Background".
    if open_caption:
        tail = open_caption.split()
        if len(tail) > 1 and s == " ".join(tail[1:]):
            return True
    # A row cell: no body prose follows it.
    return len((next_line or "").strip()) < BODY_PROSE_MIN
