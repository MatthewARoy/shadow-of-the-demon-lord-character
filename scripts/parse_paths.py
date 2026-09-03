#!/usr/bin/env python3
"""Parse expert and master path stat blocks from the extracted rulebooks.

Each path appears as:

    PathName              (standalone line)
    intro prose...
    [Story Development / training d6 tables]
    Level 3 PathName      (expert: levels 3, 6, 9 / master: levels 7, 10)
    Attributes ...
    Characteristics ...
    Languages and Professions ...
    Magic ...
    TalentName talent text...

Novice paths and ancestries are hand-curated in data/curated.json because
their choice structures are too bespoke to regex.

Outputs data/paths.json.
"""

import json
import os
import re
import sys
from collections import OrderedDict

import tables

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "paths.json")

BOOKS = ["core", "occult", "terrible", "dlc2"]
PATH_LEVELS = {3, 6, 7, 9, 10}

LEVEL_RE = re.compile(r"^Level (\d+) (?:Expert |Master )?([A-Z][\w’'\- ]+?)\s*$")
FIELDS = ("Attributes", "Characteristics", "Languages and Professions", "Magic")

# Page running heads. Compared case-insensitively against a whole line, the
# same treatment parse_rules_index.RUNNING_HEADS gives this class: the
# extraction emits "Expert paths" alongside "Expert Paths", and matching the
# exact spelling let that variant bleed into eight level-9 talents, just as it
# let "PLaying the Game" into seven rules-index chunk bodies. "Paths of Magic"
# heads every page of Occult Philosophy's chapter 3 and was missing outright.
RUNNING_HEADS = {
    "Paths",
    "Novice Paths",
    "Expert Paths",
    "Master Paths",
    "Paths of Magic",
    "Terrible Beauty",
    "Occult Philosophy",
}

RUNNING_HEADS_LOWER = {h.lower() for h in RUNNING_HEADS}

# The chapter titles the running heads are lifted from also appear, once each,
# as real section headings partway down the page that opens their section.
# Those mark the end of the preceding path rather than being furniture, so
# they are recognised by position: a head within the first HEAD_ZONE content
# lines of a page is furniture, the same words deeper in are a heading. Terrible
# Beauty prints its head twice per page, hence 2 rather than 1.
SECTION_HEADS_LOWER = {
    "novice paths",
    "expert paths",
    "master paths",
    "paths of magic",
    "paths of skill",
}
HEAD_ZONE = 2

FURNITURE = re.compile(
    r"^(===PAGE \d+===|\d{1,3}|Chapter \d+:?|"
    r"Rusty Shackleford \(Order #\d+\))$"
)


# Demon Lord's Companion 2 prints no textual running head at all, only a page
# number, which FURNITURE already drops. Applying the head heuristic there ate
# its one real "Master Paths" section heading, which sits two lines into p.33
# and so looked like a head, and the wardscribe's last talent ran on into the
# master-paths intro prose below it.
BOOKS_WITHOUT_RUNNING_HEADS = {"dlc2"}


def is_furniture(s, page_line_no, book=""):
    s = s.strip()
    if FURNITURE.match(s):
        return True
    if book in BOOKS_WITHOUT_RUNNING_HEADS:
        return False
    if s.lower() not in RUNNING_HEADS_LOWER:
        return False
    return page_line_no <= HEAD_ZONE or s.lower() not in SECTION_HEADS_LOWER


TALENT_START = re.compile(
    r"^((?:[A-Z][\w’'!\-]*|of|the|a|an|and|with|in|for|to|from)"
    r"(?: (?:[A-Z][\w’'!\-]*|of|the|a|an|and|with|in|for|to|from))*) "
    r"(You|Your|When|Whenever|Once|While|The|This|If|At|As|Creatures|"
    r"Enemies|Attacks|Choose|Roll|Make|Add|Increase|Decrease|Gain|"
    r"Spells|A|An|All|Anytime|Any|Each|For|Whether|On|Using|Other)\b"
)

# TALENT_START keys on a whitelist of words that commonly open rules text, so a
# talent whose text opens with anything else is missed and folded into the one
# above it — the wardscribe's sigil list lost Glyphic Protection ("Shimmering
# glyphs..."), Crippling Pain ("Lurid red light...") and Gibbering Madness
# ("Mad laughter..."). At the start of a line the whitelist is not needed to
# disambiguate: a Title-Case name followed by a fresh capitalised word is a
# talent, while a wrapped prose line reads "Strength challenge roll..." —
# capitalised word, lowercase follower. Kept deliberately narrow, because every
# loosening of it cost more than it recovered: the name must be two or more
# Title-Case words (a one-word name turns the sidebar title "Basic Sigils" into
# a talent "Basic"), must not trail off in a small word ("Make a Strength
# challenge roll..."), and must be followed by a real sentence.
TALENT_START_LOOSE = re.compile(
    r"^((?:[A-Z][\w’'!\-]+)"
    r"(?: (?:of|the|a|an|and|with|in|for|to|from|by))*"
    r"(?: [A-Z][\w’'!\-]+)+) "
    r"(?=[A-Z][a-z]\w* \w)"
)
MIN_LOOSE_TALENT_TEXT = 30

TRADITIONS = {
    "Air",
    "Alchemy",
    "Alteration",
    "Arcana",
    "Battle",
    "Celestial",
    "Chaos",
    "Conjuration",
    "Curse",
    "Death",
    "Demonology",
    "Destruction",
    "Divination",
    "Earth",
    "Enchantment",
    "Fey",
    "Fire",
    "Forbidden",
    "Illusion",
    "Invocation",
    "Life",
    "Madness",
    "Metal",
    "Nature",
    "Necromancy",
    "Order",
    "Primal",
    "Protection",
    "Rune",
    "Shadow",
    "Song",
    "Soul",
    "Spiritualism",
    "Storm",
    "Technomancy",
    "Telekinesis",
    "Telepathy",
    "Teleportation",
    "Theurgy",
    "Time",
    "Transformation",
    "Water",
}

NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}

# The books occasionally title a path's level headers with a different word
# than the path's own heading (core: "Level 7 Enchantment" under "Enchanter").
NAME_FIXES = {"Enchantment": "Enchanter"}


def lines_for(book):
    """Every line of the book as (page, text, furniture?).

    Furniture is flagged rather than dropped. It used to be dropped here,
    and that is what reduced the wardscribe's sigil-duration table to
    "Spell Rank Duration Spell Rank Duration 1 minute 1 week ...": a table's
    row keys are bare numbers, which is also the shape of a page number, so
    the filter took the ranks out before anything could read them. Every
    prose consumer below skips the flagged lines; scripts/tables.py reads
    past them and bounds a table by its page instead.
    """
    path = os.path.join(CACHE, f"{book}.txt")
    page = 0
    page_line_no = 0
    out = []
    for raw in open(path):
        line = raw.rstrip("\n")
        m = re.match(r"^===PAGE (\d+)===$", line.strip())
        if m:
            page = int(m.group(1))
            page_line_no = 0
            continue
        if line.strip():
            page_line_no += 1
        out.append((page, line.rstrip(), is_furniture(line, page_line_no, book)))
    return out


def find_level_blocks(lines):
    """Return [(index, level, name)] for path level headers."""
    headers = []
    for i, (_, line, furniture) in enumerate(lines):
        if furniture:
            continue
        m = LEVEL_RE.match(line.strip())
        if m and int(m.group(1)) in PATH_LEVELS:
            name = m.group(2).strip()
            headers.append((i, int(m.group(1)), NAME_FIXES.get(name, name)))
    return headers


# Section headings that follow the final path of a chapter.
STOP_HEADINGS = {"Legendary Path", "Story Development", "Roll a d6", "Personality"}

# The story-development sidebar is titled with the path's own name, and the
# page running head lands on the same extracted line: "Assassin Story
# Development". It precedes the bare "Story Development" column header, so it
# is the real end of the block — without it the level-9 talent absorbs the
# title. Every line in the three books ending this way is a sidebar title;
# none is prose.
STORY_DEVELOPMENT_TITLE = re.compile(r"^[\w’'\- ]{1,30} Story Development$")


# A sidebar belonging to a path is titled with that path's own name:
# "Brewmaster Potions" over a potion list, "WITCH FIRE" over a path-granted
# spell, "Assassin Story Development" over a d6 table. The title is a whole
# short line with no body text after it, so it cannot be confused with a
# talent, whose name is followed on the same line by its rules
# ("Brewmaster’s Admixture You can use an action...").
PATH_SIDEBAR_TITLE = re.compile(r"^[A-Z][\w’'\-]*( [A-Z][\w’'\-]*){1,3}$")

# A path-granted spell is printed inside the path's entry as its own block:
# an all-caps name line, then the tradition/type/rank header parse_spells
# keys on ("COMMAND UNDEAD" / "NECROMANCER ATTACK 1"). Everything below that
# is spell text, and belongs to spells.json. Letting it run on appended the
# spell body to the talent that grants it and turned the spell's attack-roll
# line into a talent named "Attack".
SPELL_NAME = re.compile(r"^[A-Z][A-Z0-9’'\-, ]*$")
SPELL_HEADER = re.compile(r"^[A-Z][A-Z’'\- ]*?\s+(ATTACK|UTILITY)\s+\d+\s*$")

# Companion, construct, and alternate-form statistics printed inside path
# level blocks have no DIFFICULTY line. They are identified by an all-caps
# name followed by Size, then parsed into the same shape as creature records
# so the shared renderer can display them.
PATH_STAT_SECTIONS = {
    "ATTACK OPTIONS": "attack_options",
    "SPECIAL ATTACKS": "special_attacks",
    "SPECIAL ACTIONS": "special_actions",
    "END OF THE ROUND": "end_of_round",
    "MAGIC": "magic",
}

# The eidolon's attack block is followed by another Engineer talent with no
# printed delimiter. Stat-block actions and path talents share the same prose
# shape, so this one boundary is declared rather than guessed.
PATH_STAT_END_TALENTS = {
    ("Engineer", 7, "Eidolon"): "Spare Parts",
}

# The one path sidebar whose contents belong to the block that opened it:
# core prints the fighter's level-9 talent list under "Fighter Talents".
# Stopping there costs seven real talents, so it is not a boundary.
SIDEBAR_HOLDS_TALENTS = re.compile(r"(?i) Talents$")


def is_path_sidebar_title(s, path_name):
    """True for a sidebar heading titled with this path's own name."""
    return (
        len(s) <= 40
        and s.lower().startswith(path_name.lower() + " ")
        and bool(PATH_SIDEBAR_TITLE.match(s))
    )


def is_stop_heading(s, path_name=""):
    """True for the headings that close whatever level block is open."""
    return (
        s in STOP_HEADINGS
        or s.lower() in SECTION_HEADS_LOWER
        or bool(STORY_DEVELOPMENT_TITLE.match(s))
        or (
            bool(path_name)
            and is_path_sidebar_title(s, path_name)
            and not SIDEBAR_HOLDS_TALENTS.search(s)
        )
    )


# Last PDF page of path content per book; the next chapter follows. Without the
# dlc2 bound the tormentor's last talent ran off p.35 into the Magic chapter and
# turned its opening prose into a talent named "Shadow of the Demon".
PATH_PAGE_LIMIT = {"core": 99, "occult": 9999, "terrible": 9999, "dlc2": 35}


def starts_spell_block(lines, j, limit):
    """True when the next non-blank line is a spell's tradition/rank header."""
    while j < limit:
        if lines[j][2]:
            j += 1
            continue
        s = lines[j][1].strip()
        if s:
            return bool(SPELL_HEADER.match(s))
        j += 1
    return False


def block_end(lines, start, headers, h_idx, path_names, book):
    """A level block runs until the next level header, a table marker, the
    next path's standalone name line, or a chapter/page boundary."""
    nxt = headers[h_idx + 1][0] if h_idx + 1 < len(headers) else len(lines)
    start_page = lines[start][0]
    limit = min(start_page + 1, PATH_PAGE_LIMIT[book])
    name = headers[h_idx][2]
    catalog_captions = catalog_captions_for(name)
    texts = [t for _, t, _ in lines]
    # Compared case-insensitively: Occult Philosophy prints the blizzard mage's
    # name as "Blizzard MAge", and an exact match walked straight past it.
    names_lower = {n.lower() for n in path_names}
    for j in range(start + 1, nxt):
        if lines[j][0] > limit:
            return j
        if lines[j][2]:
            continue
        s = lines[j][1].strip()
        # A die line ends the block when it opens the story-development or
        # sample-quests sidebar printed after the path. A die line that opens
        # a table belonging to the talent above it — the farseer's d6 of
        # unspeakable revelations — does not; parse_block captures that.
        if re.match(r"^d\d+$", s) and not tables.opens_die_table(texts, j, nxt):
            return j
        if s in catalog_captions or is_stop_heading(s, name):
            return j
        if SPELL_NAME.match(s) and starts_spell_block(lines, j + 1, nxt):
            return j
        if s.lower() in names_lower and j > start + 1:
            return j
    return nxt


def drop_clipped_duplicates(block_lines):
    """Terrible Beauty pages carry a clipped duplicate text layer; drop lines
    whose tail already appeared (same approach as parse_spells)."""
    seen = ""
    out = []
    for entry in block_lines:
        line = entry[1]
        probe = line[5:].strip() if len(line) > 30 else line
        if len(probe) >= 25 and probe in seen:
            continue
        out.append(entry)
        seen += " " + line
    return out


# A talent can also start midway through a field's own line ("Magic You learn
# one spell. Primal Power Animals charmed by you..."), which the field label
# swallows whole. Nine level blocks across core, occult and dlc2 lost their
# first talent that way — Beastmaster's Primal Power, Hexer's Exacting Curse,
# Stormbringer's Powered by Storm, Cenobite's Countless Lives and Purified Soul,
# and four more. Recognised by position rather than vocabulary: at a sentence
# boundary, a Title-Case run followed by a fresh capitalised word starts a
# talent. A field's own later sentences do not fit that shape — "...tradition.
# If you have discovered both..." continues with a lowercase "you", and
# "...spell. In addition, you gain..." with a lowercase "addition".
FIELD_TALENT = re.compile(
    r"(?<=\.) ([A-Z][\w’'!\-]*"
    r"(?: (?:[A-Z][\w’'!\-]*|of|the|by|a|an|and|with|in|for|to|from)){0,3}) "
    r"(?=[A-Z][a-z])"
)


def split_field_talents(value):
    """Peel talents off the tail of a field value.

    Returns (field_value, [{"name", "text"}, ...]) in printed order.
    """
    cuts = list(FIELD_TALENT.finditer(value))
    if not cuts:
        return value, []
    talents = []
    for k, m in enumerate(cuts):
        text_end = cuts[k + 1].start() if k + 1 < len(cuts) else len(value)
        talents.append({"name": m.group(1), "text": value[m.end() : text_end].strip()})
    return value[: cuts[0].start()].strip(), talents


# Two paths print their choosable options as a catalogue rather than as
# talents: a captioned sidebar of named entries, printed once at the end of
# the path instead of at each level that grants a pick. Read as talents they
# all landed on the last level — a level-9 wardscribe was credited with all
# twelve sigils outright, including the four it can only learn at level 3,
# and a lorekeeper with all eight esoteric discoveries when the path grants
# three. The captions also glued themselves onto whichever talent came last
# ("...you can choose to learn a master sigil. Basic Sigils Every wardscribe
# starts out by learning...").
#
# Declared by caption rather than detected, for the reason
# scripts/table_manifest.py declares its table regions: a catalogue entry
# and a talent are the same shape on the page, so no heuristic separates
# them. #19 records the two that were tried and reverted.
#
# Fighter's "Fighter Talents" and Thief's "Thievery Talents" print the same
# way but parse cleanly today, and their level placement is a deliberate,
# tested decision (see SIDEBAR_HOLDS_TALENTS); they stay as talents.
PATH_CATALOGS = {
    "wardscribe": ("Sigils", ("Basic Sigils", "Advanced Sigils", "Master Sigils")),
    "lorekeeper": ("Esoteric Discoveries", ("Esoteric Discoveries",)),
}


def catalog_captions_for(path_name):
    spec = PATH_CATALOGS.get(path_name.lower())
    return set(spec[1]) if spec else set()


def catalog_region_end(lines, start, path_names, book, captions):
    """A catalogue group runs to the next group, path, or chapter."""
    names_lower = {n.lower() for n in path_names}
    for j in range(start + 1, len(lines)):
        if lines[j][0] > PATH_PAGE_LIMIT[book]:
            return j
        if lines[j][2]:
            continue
        s = lines[j][1].strip()
        if (
            s in captions
            or s in STOP_HEADINGS
            or LEVEL_RE.match(s)
            or s.lower() in SECTION_HEADS_LOWER
            or s.lower() in names_lower
        ):
            return j
    return len(lines)


def parse_catalog_group(lines, start, end):
    """Split a catalogue group into its blurb and its named entries.

    Entries are recognised exactly as talents are, which is what they are
    printed as; the only difference is where they end up.
    """
    blurb = []
    entries = []
    current = None
    for j in range(start + 1, end):
        if lines[j][2]:
            continue
        line = lines[j][1].strip()
        if not line:
            continue
        tm = TALENT_START.match(line)
        if not tm:
            lm = TALENT_START_LOOSE.match(line)
            if lm and len(line) - lm.end() >= MIN_LOOSE_TALENT_TEXT:
                tm = lm
        is_continuation = bool(re.match(r"^[a-z0-9(••\-]|^or |^and ", line))
        if tm and not is_continuation:
            entries.append({"name": tm.group(1), "text": line[len(tm.group(1)) + 1 :]})
            current = entries[-1]
        elif current is None:
            blurb.append(line)
        else:
            current["text"] += " " + line
    for e in entries:
        e["text"] = re.sub(r"\s+", " ", e["text"]).strip()
    return re.sub(r"\s+", " ", " ".join(blurb)).strip(), entries


def parse_catalog(lines, path_name, path_names, book):
    """The declared option catalogue for this path, if it has one."""
    spec = PATH_CATALOGS.get(path_name.lower())
    if not spec:
        return None
    label, captions = spec
    groups = []
    for j, (_, line, furniture) in enumerate(lines):
        if furniture or line.strip() not in captions:
            continue
        end = catalog_region_end(lines, j, path_names, book, set(captions))
        blurb, entries = parse_catalog_group(lines, j, end)
        if not entries:
            continue
        group = OrderedDict(name=line.strip())
        # The blurb states when the group becomes available ("They become
        # available to a wardscribe at level 6"), which is the level the
        # entries were wrongly credited to before.
        m = re.search(r"\blevels? (\d+)", blurb)
        if m:
            group["level"] = int(m.group(1))
        if blurb:
            group["description"] = blurb
        group["entries"] = entries
        groups.append(group)
    if not groups:
        return None
    return OrderedDict(name=label, groups=groups)


def next_content(lines, j, end):
    """Index of the next line with prose on it, or end."""
    while j < end and (lines[j][2] or not lines[j][1].strip()):
        j += 1
    return j


def path_stat_name(line):
    """Display case for an all-caps embedded stat-block name."""
    small = {"a", "an", "and", "of", "or", "the"}
    words = line.strip().lower().split()
    return " ".join(w if i and w in small else w.capitalize()
                    for i, w in enumerate(words))


def is_path_stat_start(block_lines, i):
    """An all-caps name whose next content line is Size."""
    line = block_lines[i][1]
    if line in PATH_STAT_SECTIONS or not SPELL_NAME.match(line):
        return False
    i += 1
    while i < len(block_lines) and not block_lines[i][1]:
        i += 1
    return i < len(block_lines) and block_lines[i][1].startswith("Size ")


def stat_item_start(line):
    """True when a wrapped stat-block item begins on this line."""
    if TALENT_START.match(line):
        return True
    return re.match(
        r"^[A-Z][\w’'\-]*(?: [A-Z][\w’'\-]*){0,4} \(", line
    ) is not None


def append_stat_item(items, line):
    if not items or stat_item_start(line):
        items.append(line)
    else:
        items[-1] += " " + line


def parse_path_stat_block(block_lines, start, end, lines, book):
    """Parse one NAME + Size embedded block into creature-shaped data."""
    name = path_stat_name(block_lines[start][1])
    page = lines[block_lines[start][0]][0]
    block = OrderedDict(
        name=name,
        book=book,
        page=page,
        descriptor=None,
        perception=None,
        defense_line=None,
        attributes=None,
        speed=None,
        traits=[],
        attack_options=[],
        special_attacks=[],
        special_actions=[],
        end_of_round=[],
        magic=[],
    )
    section = None
    items = block["traits"]
    for _, line in block_lines[start + 1:end]:
        if not line:
            continue
        if line in PATH_STAT_SECTIONS:
            section = PATH_STAT_SECTIONS[line]
            items = block[section]
            continue
        if section is None:
            if line.startswith("Size "):
                block["descriptor"] = line[5:]
            elif line.startswith("Perception "):
                block["perception"] = line[11:]
            elif line.startswith("Defense "):
                block["defense_line"] = line
            elif line.startswith("Strength "):
                block["attributes"] = line
            elif line.startswith("Speed "):
                block["speed"] = line[6:]
                section = "traits"
                items = block["traits"]
            continue
        append_stat_item(items, line)
    return block


def extract_path_stat_blocks(block_lines, lines, book, path_name, level):
    """Remove embedded stat-block spans and return their structured records."""
    removed = set()
    blocks = []
    i = 0
    while i < len(block_lines):
        if not is_path_stat_start(block_lines, i):
            i += 1
            continue
        name = path_stat_name(block_lines[i][1])
        stop_talent = PATH_STAT_END_TALENTS.get((path_name, level, name))
        j = i + 1
        while j < len(block_lines):
            if is_path_stat_start(block_lines, j):
                break
            if stop_talent and block_lines[j][1].startswith(stop_talent + " "):
                break
            j += 1
        blocks.append(parse_path_stat_block(block_lines, i, j, lines, book))
        removed.update(range(i, j))
        i = j
    clean = [entry for k, entry in enumerate(block_lines) if k not in removed]
    return clean, blocks


def attach_path_stat_blocks(talents, blocks, path_name, level):
    """Attach each block to the talent that names or describes granting it."""
    for block in blocks:
        target = block["name"].lower()
        scored = []
        for i, talent in enumerate(talents):
            talent_name = talent["name"].lower()
            text = talent["text"].lower()
            if talent_name == target:
                score = 3
            elif target in talent_name:
                score = 2
            elif target in text:
                score = 1
            else:
                score = 0
            if score:
                scored.append((score, -i, talent))
        if not scored:
            raise ValueError(
                f"{path_name} L{level}: no granting talent found for {block['name']}"
            )
        owner = max(scored, key=lambda candidate: candidate[:2])[2]
        owner.setdefault("stat_blocks", []).append(block)


def parse_block(lines, start, end, book, path_name="", level=None):
    """Split a level block into labelled fields and talents."""
    fields = {}
    talents = []
    current = None  # ("field", name) or ("talent", idx)
    texts = [t for _, t, _ in lines]
    pages = [p for p, _, _ in lines]

    def stop_table(k):
        s = texts[k].strip()
        return bool(LEVEL_RE.match(s)) or is_stop_heading(s, path_name)

    block_lines = [
        (j, lines[j][1].strip()) for j in range(start + 1, end) if not lines[j][2]
    ]
    if book == "terrible":
        block_lines = drop_clipped_duplicates(block_lines)
    block_lines, stat_blocks = extract_path_stat_blocks(
        block_lines, lines, book, path_name, level
    )
    # A caption sits on the line above its table ("Building Blocks"); it is
    # held here until the table below it is captured, rather than joining the
    # talent's prose the way "Building Blocks Spell Rank Blocks 5+" used to.
    caption = None
    resume = start
    for j, line in block_lines:
        if j < resume:
            continue
        if not line:
            continue
        if tables.opens_table(texts, j, end):
            table, after = tables.capture(texts, pages, j, end, stop_table, caption)
            caption = None
            if table:
                if current and current[0] == "talent":
                    talents[current[1]].setdefault("tables", []).append(table)
                else:
                    print(
                        f"{path_name}: table with no talent to attach to",
                        file=sys.stderr,
                    )
                resume = after
                continue
        if len(line) <= tables.CELL_MAX and tables.opens_table(
            texts, next_content(lines, j + 1, end), end
        ):
            caption = line
            continue
        # "Fighter Talents" heads the talents that follow, so it does not end
        # the block — but it is still a heading, and left in place it glued
        # itself to the end of Weapon Mastery.
        if path_name and is_path_sidebar_title(line, path_name):
            continue
        matched_field = None
        for f in FIELDS:
            # Field values start uppercase; a lowercase follower means a
            # wrapped line that merely begins with the field word
            # ("...with Life / Magic to heal this thrall...").
            if line.startswith(f + " ") and line[len(f) + 1 : len(f) + 2].isupper():
                matched_field = f
                break
        if matched_field:
            rest = line[len(matched_field) + 1 :]
            # Talents named "Magic Mask", "Magic Wand", etc. would otherwise
            # be swallowed by the Magic field.
            tm = TALENT_START.match(rest)
            if (
                matched_field == "Magic"
                and tm
                and not rest.startswith(
                    (
                        "You",
                        "Your",
                        "Make",
                        "Choose",
                        "Increase",
                        "Learn",
                        "Whenever",
                        "When",
                    )
                )
            ):
                talents.append(
                    {
                        "name": "Magic " + tm.group(1),
                        "text": rest[len(tm.group(1)) + 1 :],
                    }
                )
                current = ("talent", len(talents) - 1)
                continue
            fields[matched_field] = rest
            current = ("field", matched_field)
            continue
        tm = TALENT_START.match(line)
        if not tm:
            lm = TALENT_START_LOOSE.match(line)
            if lm and len(line) - lm.end() >= MIN_LOOSE_TALENT_TEXT:
                tm = lm
        is_continuation = bool(re.match(r"^[a-z0-9(••\-]|^or |^and ", line))
        if tm and not is_continuation:
            talents.append({"name": tm.group(1), "text": line[len(tm.group(1)) + 1 :]})
            current = ("talent", len(talents) - 1)
            continue
        # Continuation of whatever came last.
        if current and current[0] == "field":
            fields[current[1]] += " " + line
        elif current and current[0] == "talent":
            talents[current[1]]["text"] += " " + line
        # else: stray prose before first field; ignore.
    fields = {k: re.sub(r"\s+", " ", v).strip() for k, v in fields.items()}
    # Recover talents the fields absorbed. They were printed above the talents
    # parsed normally, so they go in front.
    for f in FIELDS:
        if f not in fields:
            continue
        fields[f], recovered = split_field_talents(fields[f])
        talents[:0] = recovered
    for t in talents:
        t["text"] = re.sub(r"\s+", " ", t["text"]).replace("•", "\n•").strip()
    # A few blocks omit the "Characteristics" label and the values get glued
    # onto Attributes ("Increase each by 1 Health +2"); split them apart.
    if "Attributes" in fields and "Characteristics" not in fields:
        m = re.search(
            r"\b(Health|Power|Speed|Defense)\s*[+\u2212\u2013-]", fields["Attributes"]
        )
        if m:
            fields["Characteristics"] = fields["Attributes"][m.start() :]
            fields["Attributes"] = fields["Attributes"][: m.start()].strip()
    attach_path_stat_blocks(talents, stat_blocks, path_name, level)
    return fields, talents


def parse_attributes(text):
    if not text:
        return None
    m = re.search(
        r"[Ii]ncrease (one|two|three|four)(?: attributes?(?: of your choice)?)? by 1",
        text,
    )
    if m:
        return {"choose": NUMBER_WORDS[m.group(1)], "increase": 1}
    m = re.search(
        r"[Cc]hoose (one|two|three|four) attributes? and increase (?:each|it) by 1",
        text,
    )
    if m:
        return {"choose": NUMBER_WORDS[m.group(1)], "increase": 1}
    if re.search(r"[Ii]ncrease each by 1", text):
        return {"choose": 4, "increase": 1, "each": True}
    return {"raw": text}


def parse_characteristics(text):
    if not text:
        return None
    out = {}
    for name, val in re.findall(
        r"(Health|Power|Speed|Defense|Perception|Insanity|Corruption|Healing Rate|Size)\s*([+−–-]\s*\d+)",
        text,
    ):
        key = name.lower().replace(" ", "_")
        out[key] = int(val.replace("−", "-").replace("–", "-").replace(" ", ""))
    if not out:
        return {"raw": text}
    return out


# A path can both offer a choice and hand over a specific spell, in that
# order: the spellbinder's level 3 reads "You either discover a new tradition
# or learn one spell from a tradition you have already discovered. In
# addition, you learn the spellbound weapon spell, described below." Every
# choice rule below returns as soon as it matches, so the grant clause was
# never reached and a spellbinder never received the spell its whole path is
# built around — Invest Power and Magic Weapon both key off "the target weapon
# of your spellbound weapon spell". The clause is read separately for that
# reason.
#
# Deliberately narrow. The preserver's level 3 also says "you learn the life
# sense spell", but inside a bulleted choice of two benefits, each granting a
# different spell; recording either one would hand the character a spell it
# may not have chosen. A bullet in the Magic line means the grant is an option
# rather than a given, and those stay as raw text for the player to read.
IN_ADDITION_GRANT = re.compile(
    r"In addition, (?:you )?learn the ([\w ’']+?) spell\b")


def parse_grant(text):
    """The spell a Magic line hands over outright, if it hands over one."""
    if "•" in text:
        return None
    m = IN_ADDITION_GRANT.search(text)
    return m.group(1).strip() if m else None


def parse_magic(text):
    """Turn a Magic line into structured choice slots."""
    if not text:
        return None
    t = text.strip()
    result = {"raw": t}
    granted = parse_grant(t)
    if granted:
        # Attached before the choice rules run, since each of them returns.
        result["grants"] = [granted]
    # Constrained to two traditions: "discover the X or Y tradition or
    # learn one X or Y spell"
    m = re.search(r"discover the (\w+) or (\w+) tradition or (?:you )?learn one", t)
    if m and m.group(1) in TRADITIONS and m.group(2) in TRADITIONS:
        result["choices"] = [
            {
                "pick": 1,
                "options": ["discover_tradition", "learn_spell"],
                "traditions": [m.group(1), m.group(2)],
            }
        ]
        return result
    # Constrained to three traditions: "discover the X, Y, or Z tradition,
    # or learn one spell from one of those traditions"
    m = re.search(
        r"discover the (\w+), (\w+), or (\w+) tradition,? or (?:you )?learn", t, re.I
    )
    if m and all(g.capitalize() in TRADITIONS for g in m.groups()):
        result["choices"] = [
            {
                "pick": 1,
                "options": ["discover_tradition", "learn_spell"],
                "traditions": [g.capitalize() for g in m.groups()],
            }
        ]
        return result
    # Either of two named traditions, as Demon Lord's Companion 2 phrases it:
    # "You discover the Curse tradition or the Spiritualism tradition. If you
    # have discovered both traditions already, you instead learn one spell from
    # either tradition." (Wangateur, Wardscribe)
    m = re.search(r"discover the (\w+) tradition or the (\w+) tradition", t)
    if m and m.group(1) in TRADITIONS and m.group(2) in TRADITIONS:
        options = ["discover_tradition"]
        if re.search(r"instead learn one spell", t):
            options.append("learn_spell")
        result["choices"] = [
            {"pick": 1, "options": options, "traditions": [m.group(1), m.group(2)]}
        ]
        return result
    # Tradition-constrained variants: "discover the X tradition or learn one X
    # spell", plus the ", or you learn one X spell" wording of the same offer —
    # without the comma and the "you", 44 occult master paths and 6 dlc2 paths
    # fell through to the discover-only rule below and silently lost the option
    # to learn a spell instead.
    m = re.search(
        r"discover the (\w+) tradition,? or (?:you )?learn (?:one|a) (\w+) spell", t
    )
    if m and m.group(1) in TRADITIONS:
        result["choices"] = [
            {
                "pick": 1,
                "options": ["discover_tradition", "learn_spell"],
                "traditions": [m.group(1)],
            }
        ]
        return result
    # "You discover two traditions and learn one spell."
    m = re.search(
        r"discover (one|two|three) traditions? and learn (one|two) spells?", t, re.I
    )
    if m:
        result["choices"] = [
            {"pick": NUMBER_WORDS[m.group(1)], "options": ["discover_tradition"]},
            {"pick": NUMBER_WORDS[m.group(2)], "options": ["learn_spell"]},
        ]
        return result
    # "discover a new tradition other than a dark magic tradition or learn
    # one spell other than a dark magic spell"
    if re.search(
        r"discover a new tradition other than a dark magic tradition or (?:you )?learn",
        t,
        re.I,
    ):
        result["choices"] = [
            {
                "pick": 1,
                "options": ["discover_tradition", "learn_spell"],
                "exclude_dark": True,
            }
        ]
        return result
    m = re.search(r"[Mm]ake (one|two|three|four) choices?", t)
    if m:
        result["choices"] = [
            {
                "pick": NUMBER_WORDS[m.group(1)],
                "options": ["discover_tradition", "learn_spell"],
            }
        ]
        return result
    if re.search(
        r"discover (?:a|one|a new|another) tradition or (?:you )?learn (?:one|a) spell",
        t,
    ):
        result["choices"] = [
            {"pick": 1, "options": ["discover_tradition", "learn_spell"]}
        ]
        return result
    m = re.search(r"discover the (\w+) tradition", t)
    if m and m.group(1) in TRADITIONS:
        result["choices"] = [
            {"pick": 1, "options": ["discover_tradition"], "traditions": [m.group(1)]}
        ]
        return result
    if re.search(r"discover (?:a|one) tradition", t):
        result["choices"] = [{"pick": 1, "options": ["discover_tradition"]}]
        return result
    # "You learn one Alchemy spell" / "learn one spell from the X tradition"
    m = re.search(r"[Ll]earn (one|two|three) (\w+) spells?", t)
    if m and m.group(2) in TRADITIONS:
        result["choices"] = [
            {
                "pick": NUMBER_WORDS[m.group(1)],
                "options": ["learn_spell"],
                "traditions": [m.group(2)],
            }
        ]
        return result
    m = re.search(r"[Ll]earn (one|two|three) spells?(?: from the (\w+) tradition)?", t)
    if m:
        slot = {"pick": NUMBER_WORDS[m.group(1)], "options": ["learn_spell"]}
        if m.group(2) and m.group(2) in TRADITIONS:
            slot["traditions"] = [m.group(2)]
        result["choices"] = [slot]
        return result
    # "You learn the create flame spell" — a specific spell grant.
    m = re.search(r"[Yy]ou learn the ([\w ’']+?) spell", t)
    if m:
        result["grants"] = [m.group(1).strip()]
        return result
    return result


def gather_intro(lines, name, first_header_idx):
    """Collect path intro prose: backwards from the level header to the
    standalone path-name line."""
    # The path's name appears twice: once titling the intro, and again titling
    # the story-development sidebar. Elsewhere the sidebar's copy shares its
    # line with the running head ("Assassin Story Development"), but Demon
    # Lord's Companion 2 has no running head, so its sidebar title is a bare
    # name line indistinguishable from the intro's — and being the nearer of
    # the two, it won the search and left the wardscribe with no description.
    # The sidebar copy is the one followed by the table, not by prose.
    name_idx = None
    for j in range(first_header_idx - 1, max(first_header_idx - 120, -1), -1):
        if lines[j][2] or lines[j][1].strip().lower() != name.lower():
            continue
        k = j + 1
        while k < first_header_idx and (lines[k][2] or not lines[k][1].strip()):
            k += 1
        nxt = lines[k][1].strip() if k < first_header_idx else ""
        if (
            re.match(r"^d\d+$", nxt)
            or "Story Development" in nxt
            or nxt.endswith("Training")
        ):
            continue
        name_idx = j
        break
    if name_idx is None:
        return ""
    parts = []
    j = name_idx + 1
    while j < first_header_idx:
        if lines[j][2]:
            j += 1
            continue
        s = lines[j][1].strip()
        # Stop at training/story tables.
        if re.match(r"^d\d+$", s) or "Story Development" in s or s.endswith("Training"):
            break
        parts.append(s)
        j += 1
    intro = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return intro


def parse_book(book):
    lines = lines_for(book)
    headers = find_level_blocks(lines)
    path_names = {nm for _, _, nm in headers}
    paths = OrderedDict()
    for h_idx, (i, level, name) in enumerate(headers):
        end = block_end(lines, i, headers, h_idx, path_names, book)
        fields, talents = parse_block(lines, i, end, book, name, level)
        key = name.lower()
        if key not in paths:
            paths[key] = OrderedDict(
                name=name, levels={}, source=book, page=lines[i][0]
            )
        entry = OrderedDict()
        attrs = parse_attributes(fields.get("Attributes"))
        chars = parse_characteristics(fields.get("Characteristics"))
        if attrs:
            entry["attributes"] = attrs
        if chars:
            entry["characteristics"] = chars
        if "Languages and Professions" in fields:
            entry["languages_professions"] = fields["Languages and Professions"]
        magic = parse_magic(fields.get("Magic"))
        if magic:
            entry["magic"] = magic
        if talents:
            entry["talents"] = talents
        paths[key]["levels"][str(level)] = entry
    # Classify and attach intros.
    out = []
    for key, p in paths.items():
        lvls = set(int(l) for l in p["levels"])
        if 3 in lvls:
            p["type"] = "expert"
        elif 7 in lvls or 10 in lvls:
            p["type"] = "master"
        else:
            continue  # novice/ancestry fragments; hand-curated elsewhere
        first_idx = next(
            i
            for i, (idx, lv, nm) in enumerate(find_level_blocks(lines))
            if nm.lower() == key
        )
        header_line_idx = find_level_blocks(lines)[first_idx][0]
        p["description"] = gather_intro(lines, p["name"], header_line_idx)
        catalog = parse_catalog(lines, p["name"], path_names, book)
        if catalog:
            p["catalog"] = catalog
        out.append(p)
    return out


def main():
    all_paths = []
    seen = set()
    for book in BOOKS:
        for p in parse_book(book):
            if p["name"].lower() in seen:
                print(f"duplicate skipped: {p['name']} ({book})", file=sys.stderr)
                continue
            seen.add(p["name"].lower())
            all_paths.append(p)
    # Drop clipped-text-layer duplicates: a path missing required levels whose
    # name is a prefix of a complete path from the same book (e.g. "Troll H").
    complete = {
        p["name"].lower()
        for p in all_paths
        if set(p["levels"])
        >= ({"3", "6", "9"} if p["type"] == "expert" else {"7", "10"})
    }

    def is_clipped(p):
        want = {"3", "6", "9"} if p["type"] == "expert" else {"7", "10"}
        if set(p["levels"]) >= want:
            return False
        return any(
            c.startswith(p["name"].lower()) and c != p["name"].lower() for c in complete
        )

    dropped = [p["name"] for p in all_paths if is_clipped(p)]
    if dropped:
        print(f"clipped duplicates dropped: {dropped}", file=sys.stderr)
    all_paths = [p for p in all_paths if not is_clipped(p)]
    all_paths.sort(key=lambda p: (p["type"], p["name"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(all_paths, f, indent=1, ensure_ascii=False)
    counts = {}
    for p in all_paths:
        counts[p["type"]] = counts.get(p["type"], 0) + 1
    print(f"{len(all_paths)} paths -> {OUT}  {counts}", file=sys.stderr)


if __name__ == "__main__":
    main()
