#!/usr/bin/env python3
"""Parse creature stat blocks from the SotDL rulebook texts.

Spell descriptions reference creatures by printed page ("Shadow, page 246",
"see page 136"); this script walks scripts/cache/{core,occult}.txt, finds
every NAME + DIFFICULTY stat block, and emits data/creatures.json with
printed page numbers so the app can resolve those references.

Stat block shape in the text (sections optional):
    NAME            (all caps, DIFFICULTY on the following line)
    DIFFICULTY 50
    Size 1 horrifying faerie (devil)
    Perception 13 (+3); truesight
    Defense 11; Health 53; Insanity —; Corruption 7
    Strength 13 (+3), Agility 11 (+1), Intellect 11 (+1), Will 13 (+3)
    Speed 10; flier (swoop)
    <trait lines>
    ATTACK OPTIONS / SPECIAL ATTACKS / SPECIAL ACTIONS /
    END OF THE ROUND / MAGIC
"""
import json
import os
import re

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "creatures.json")
BOOKS = ["core", "occult"]

SECTIONS = {
    "ATTACK OPTIONS": "attack_options",
    "SPECIAL ATTACKS": "special_attacks",
    "SPECIAL ACTIONS": "special_actions",
    "END OF THE ROUND": "end_of_round",
    "MAGIC": "magic",
}
STAT_LINE = re.compile(
    r"^(Size |Perception \d|Defense |Strength [\d+–-]|Speed [\d+–-])")
PAGE_MARK = re.compile(r"^===PAGE (\d+)===$")
DIFF = re.compile(r"^DIFFICULTY ([\d,]+|STEP)\s*$")
# A stat block name: an all-caps line (allowing digits, commas, apostrophes,
# hyphens) — "LASH CRAWLER", "MOB OF MEDIUM MONSTERS", "VAPOR, KILLING".
NAME = re.compile(r"^[A-Z][A-Z0-9 ,'’\-]{2,40}\s*$")
FOOTER_NUM = re.compile(r"^\d{1,3}$")
# Prose header of the next creature: a short Title Case line.
PROSE_HEADER = re.compile(r"^[A-Z][a-z’']+( [A-Za-z’'][a-z’']+){0,3}$")

# Last PDF page holding stat blocks, per book, mirroring SPELL_PAGE_LIMIT in
# parse_spells and PATH_PAGE_LIMIT in parse_paths. The chapter that follows
# has nothing that ends a block — no name, no DIFFICULTY, no prose header —
# so the final creature absorbs it: the wyvern's Instinctive Sting ran on
# through the whole Paths of Magic chapter intro on occult p.146.
CREATURE_PAGE_LIMIT = {"core": 263, "occult": 145}


def printed_offset(lines):
    """Median (pdf page − printed footer number) over the whole book."""
    offsets = []
    page = None
    for ln in lines:
        m = PAGE_MARK.match(ln)
        if m:
            page = int(m.group(1))
        elif page and FOOTER_NUM.match(ln.strip()):
            n = int(ln.strip())
            if 0 < page - n < 6:           # plausible footer, not dice text
                offsets.append(page - n)
    offsets.sort()
    return offsets[len(offsets) // 2] if offsets else 0


def parse_book(book):
    path = os.path.join(CACHE, f"{book}.txt")
    with open(path) as f:
        lines = [ln.rstrip() for ln in f]
    off = printed_offset(lines)
    creatures = []
    pdf_page = 0
    i = 0
    while i < len(lines):
        ln = lines[i].strip()
        m = PAGE_MARK.match(ln)
        if m:
            pdf_page = int(m.group(1))
            i += 1
            continue
        # A block starts at a NAME line whose next non-blank line is DIFFICULTY.
        name = None
        if NAME.match(ln) and ln not in SECTIONS:
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and DIFF.match(lines[j].strip()):
                name = ln.strip()
                diff = DIFF.match(lines[j].strip()).group(1)
                i = j + 1
        if name is None:
            i += 1
            continue
        cr = {"name": title_case(name), "book": book, "page": pdf_page - off,
              "difficulty": diff, "descriptor": None, "perception": None,
              "defense_line": None, "attributes": None, "speed": None,
              "traits": [], "attack_options": [], "special_attacks": [],
              "special_actions": [], "end_of_round": [], "magic": []}
        section = None     # None => stat header area, then traits
        items = cr["traits"]
        while i < len(lines):
            raw = lines[i]
            s = raw.strip()
            i += 1
            if not s:
                continue
            if PAGE_MARK.match(s):
                pdf_page = int(PAGE_MARK.match(s).group(1))
                if pdf_page > CREATURE_PAGE_LIMIT[book]:
                    break
                continue
            if FOOTER_NUM.match(s) or s in ("Bestiary", "Creatures of Magic"):
                continue                    # page furniture
            if s in SECTIONS:
                section = SECTIONS[s]
                items = cr[section]
                continue
            # Next stat block begins → step back and close this one.
            nxt = lines[i].strip() if i < len(lines) else ""
            if NAME.match(s) and s not in SECTIONS and DIFF.match(nxt):
                i -= 1
                break
            if DIFF.match(s):               # name on the line before last
                i -= 2
                break
            if section is None:
                if s.startswith("Size "):
                    cr["descriptor"] = s[5:]
                elif s.startswith("Perception "):
                    cr["perception"] = s[11:]
                elif s.startswith("Defense "):
                    cr["defense_line"] = s
                elif s.startswith("Strength "):
                    cr["attributes"] = s
                elif s.startswith("Speed "):
                    cr["speed"] = s[6:]
                    section = "traits"
                elif cr["descriptor"] is None and not STAT_LINE.match(s):
                    cr["descriptor"] = s    # template blocks lead with prose
                else:
                    append_item(cr["traits"], s, True)
                continue
            # Prose header of the next creature ends the block.
            if starts_a_heading(lines, i, s):
                i -= 1
                break
            append_item(items, s, new_item_start(s))
        creatures.append(cr)
    return creatures


def next_nonblank(lines, i, count):
    """The next `count` non-blank stripped lines from index i."""
    out = []
    while i < len(lines) and len(out) < count:
        s = lines[i].strip()
        if s:
            out.append(s)
        i += 1
    return out


def next_stat_block_name(lines, i, limit=100):
    """The first NAME + DIFFICULTY block within `limit` content lines."""
    seen = 0
    while i < len(lines) and seen < limit:
        s = lines[i].strip()
        i += 1
        if not s:
            continue
        seen += 1
        if NAME.match(s) and s not in SECTIONS:
            j = i
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and DIFF.match(lines[j].strip()):
                return title_case(s)
    return None


def heading_matches_stat_block(heading, stat_block_name):
    """A family heading names all or part of its first stat block.

    "Genie" introduces EARTH GENIE, while "Incarnation / of Nature" and
    "Muttering Maw" repeat the complete name. Matching the words keeps stat
    lines such as "Immune frightened" from becoming false boundaries merely
    because another creature appears later on the page.
    """
    def words(value):
        out = set()
        for word in re.findall(r"[A-Za-z’']+", value.lower()):
            if word in {"a", "an", "and", "of", "or", "the"}:
                continue
            if word.endswith("ies"):
                word = word[:-3] + "y"
            elif word.endswith("s") and not word.endswith("ss"):
                word = word[:-1]
            out.add(word)
        return out

    heading_words = words(heading)
    return bool(heading_words) and heading_words <= words(stat_block_name)


def starts_a_heading(lines, i, s):
    """True when `s` opens a sidebar or the next creature's prose entry.

    The heading may wrap onto a second line — core p.264 prints
    "Customizing" and "Creatures" separately — and testing only the
    immediate follower for prose left "Customizing" glued to the end of the
    veteran's last attack option.
    """
    if len(s) > 32 or STAT_LINE.match(s) or not PROSE_HEADER.match(s):
        return False
    following = next_nonblank(lines, i, 2)
    if not following:
        return False
    if len(following[0]) > 40:
        return True
    # A wrapped heading: a second short line, then the prose. Test the joined
    # title so connector-led continuations such as "of Nature" are accepted.
    joined = f"{s} {following[0]}"
    if (len(following) == 2 and len(following[0]) <= 32
            and PROSE_HEADER.match(joined) and len(following[1]) > 40):
        return True

    # Narrow PDF columns can keep every introductory prose line below the old
    # 40-character threshold. In that case, confirm the candidate against the
    # first actual stat block that follows. A family heading can be the whole
    # name ("Sprite") or a shared family suffix ("Genie" → EARTH GENIE).
    stat_block_name = next_stat_block_name(lines, i)
    candidates = [s]
    if len(following[0]) <= 32 and PROSE_HEADER.match(joined):
        candidates.insert(0, joined)
    return bool(stat_block_name) and any(
        heading_matches_stat_block(candidate, stat_block_name)
        for candidate in candidates
    )


def new_item_start(s):
    """Heuristic: items open with a Title Case name run ("Radiant Sword
    (melee) …", "Two Attacks The angel…")."""
    return re.match(
        r"^[A-Z][a-zA-Z’']*( [A-Z][a-zA-Z’']*){0,4}( \(|—| [A-Z]| \+|\d)",
        s) is not None


def append_item(items, s, start_new):
    if start_new or not items:
        items.append(s)
    else:
        items[-1] += " " + s


def title_case(name):
    small = {"of", "the", "a", "an", "and", "or"}
    words = name.lower().split()
    return " ".join(w if w in small and k else w.capitalize()
                    for k, w in enumerate(words))


def main():
    out = []
    for book in BOOKS:
        got = parse_book(book)
        print(f"{book}: {len(got)} stat blocks")
        out.extend(got)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f"wrote {len(out)} -> {OUT}")


if __name__ == "__main__":
    main()
