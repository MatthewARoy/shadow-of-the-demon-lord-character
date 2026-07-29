#!/usr/bin/env python3
"""Parse spell stat blocks from the extracted rulebook text.

Spell blocks look like:

    NAME
    TRADITION TYPE RANK
    Requirement ...      (optional)
    Target/Area ...      (optional)
    Duration ...         (optional)
    body text, possibly containing Triggered / Sacrifice /
    Permanence / "Attack Roll 20+" sub-entries.

Outputs data/spells.json sorted by tradition, rank, name.
"""
import json
import os
import re
import sys
from collections import OrderedDict

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "spells.json")

BOOKS = ["core", "occult", "terrible"]

HEADER_RE = re.compile(r"^([A-Z][A-Z’'\- ]*?)\s+(ATTACK|UTILITY)\s+(\d+)\s*$")

# Lines that are page furniture, not spell text.
FURNITURE = re.compile(
    r"^(===PAGE \d+===|\d{1,3}|Traditions and Spells|Magic|Chapter \d+:?|"
    r"APPENDIX.*|Terrible Beauty|Occult Philosophy|INtroduction|"
    r"Rusty Shackleford \(Order #\d+\))$"
)

# Last PDF page containing spell content, per book; the chapter that follows
# would otherwise bleed into the final spell's description.
SPELL_PAGE_LIMIT = {"core": 149, "occult": 132, "terrible": 23}

# Terrible Beauty groups spells under Title-Case section headings ("Celestial
# Spells", "Teleportation Spells", "Other Spells"); each ends the previous
# section's last spell. Core/Occult use these only outside their spell pages
# ("Learning Spells" p.112 core, the tradition lists pp.188+ occult).
SECTION_HEADING = re.compile(r"^(?:[A-Z][a-z’']+ )+Spells$")

# Path-granted spells are printed inside a path's entry in the paths chapters,
# so SPELL_PAGE_LIMIT cannot bound them — the limit sits far past those pages.
# What bounds them is the running head: once the body reaches a page headed by
# a paths chapter, it has walked out of the spell and into the next path entry.
# Without this, spellbound weapon (core p.73) ran on through the head, the
# name "Thief", and the whole thief intro on p.74.
PATH_CHAPTER_HEADS = {"novice paths", "expert paths", "master paths",
                      "paths of magic", "paths of skill"}

# The same sidebar title parse_paths stops on. The bare "Story Development"
# below is the column header two lines further down; this is the title above
# it, carrying the path's name because the running head shares its line.
STORY_DEVELOPMENT_TITLE = re.compile(r"^[\w’'\- ]{1,30} Story Development$")

# Path-granted spells use the path name as the tradition slot.
PATH_TRADITIONS = {
    "MAGICIAN", "WITCH", "TENEBRIST", "TEMPLAR", "TECHNOMANCER",
    "SPELLBINDER", "NECROMANCER", "EXORCIST", "DRUID", "BEGUILER",
}

FIELD_NAMES = ("Requirement", "Target", "Area", "Duration", "Prerequisite")

ATTACK_ROLL_RE = re.compile(
    r"[Mm]ake (?:an?|one) (Strength|Agility|Intellect|Will|Perception) "
    r"(?:attack roll|challenge roll)[^.]*?against (?:the target(?:’|')s|its|each target(?:’|')s|"
    r"that creature(?:’|')s|the creature(?:’|')s) ?(Defense|Strength|Agility|Intellect|Will|Perception)?"
)
DAMAGE_RE = re.compile(r"\b(\d+d\d+(?:\s*\+\s*\d+)?)\b")


def lines_for(book):
    path = os.path.join(CACHE, f"{book}.txt")
    page = 0
    out = []
    for raw in open(path):
        line = raw.rstrip("\n")
        m = re.match(r"^===PAGE (\d+)===$", line.strip())
        if m:
            page = int(m.group(1))
            continue
        out.append((page, line))
    return out


def collect_tradition_names(lines):
    names = set()
    for _, line in lines:
        m = HEADER_RE.match(line.strip())
        if m:
            names.add(title_case(m.group(1).strip()))
    return names


def parse_book(book):
    lines = lines_for(book)
    tradition_names = collect_tradition_names(lines)
    spells = []
    i = 0
    n = len(lines)
    while i < n:
        page, line = lines[i]
        m = HEADER_RE.match(line.strip())
        if not m:
            i += 1
            continue
        tradition, sptype, rank = m.group(1).strip(), m.group(2), int(m.group(3))
        # The spell name is the nearest preceding non-empty, non-furniture line.
        name = None
        for j in range(i - 1, max(i - 6, -1), -1):
            cand = lines[j][1].strip().rstrip("\t").strip()
            if not cand or FURNITURE.match(cand):
                continue
            # Names are fully uppercase.
            if cand == cand.upper() and re.match(r"^[A-Z][A-Z’'\-, ]*$", cand):
                name = cand
            break
        if not name:
            i += 1
            continue
        # Collect the body until the next spell header (peeking one line
        # ahead, since the next header is preceded by its own name line).
        body_lines = []
        j = i + 1
        limit = SPELL_PAGE_LIMIT[book]
        while j < n:
            if lines[j][0] > limit or lines[j][0] > page + 1:
                break
            nxt = lines[j][1].strip()
            if HEADER_RE.match(nxt):
                # Drop the name line we already consumed into body.
                if body_lines and body_lines[-1].strip() == body_lines[-1].strip().upper() \
                   and re.match(r"^[A-Z][A-Z’'\-, ]*$", body_lines[-1].strip()):
                    body_lines.pop()
                break
            # Section boundaries that end the last spell of a block: a new
            # tradition's intro, a path level entry, a random table, a
            # Title-Case section heading ("Celestial Spells"), or an
            # all-caps heading that is not the next spell's name.
            if nxt in tradition_names or re.match(r"^Level \d+ ", nxt) \
               or re.match(r"^d\d+$", nxt) or nxt == "Story Development" \
               or SECTION_HEADING.match(nxt) \
               or nxt.lower() in PATH_CHAPTER_HEADS \
               or STORY_DEVELOPMENT_TITLE.match(nxt):
                break
            if re.match(r"^[A-Z][A-Z’'\-, ]+$", nxt) and not FURNITURE.match(nxt):
                follower = lines[j + 1][1].strip() if j + 1 < n else ""
                if not HEADER_RE.match(follower):
                    break
            body_lines.append(lines[j][1])
            j += 1
        spell = build_spell(name, tradition, sptype, rank, body_lines, book, page)
        spells.append(spell)
        i = j if j > i else i + 1
    return spells


def clean_body(body_lines):
    out = []
    for line in body_lines:
        s = line.strip()
        if not s or FURNITURE.match(s):
            continue
        out.append(s)
    return out


def build_spell(name, tradition, sptype, rank, body_lines, book, page):
    body = clean_body(body_lines)
    if book == "terrible":
        body = drop_clipped_duplicates(body)
    fields = {}
    # Leading labelled fields, with lowercase-led continuation lines.
    idx = 0
    current = None
    while idx < len(body):
        line = body[idx]
        matched = None
        for f in FIELD_NAMES:
            if line.startswith(f + " "):
                matched = f
                break
        if matched:
            fields[matched.lower()] = line[len(matched) + 1:]
            current = matched.lower()
            idx += 1
            continue
        if current and (re.match(r"^[a-z0-9(]", line) or line.startswith("or ")):
            fields[current] += " " + line
            idx += 1
            continue
        break
    desc = " ".join(body[idx:])
    desc = re.sub(r"\s+", " ", desc).strip()
    # Tab markers from extraction become noise; drop them.
    desc = desc.replace("\t", " ")
    desc = re.sub(r" {2,}", " ", desc)

    spell = OrderedDict()
    spell["name"] = title_case(name)
    spell["tradition"] = title_case(tradition)
    spell["type"] = sptype.capitalize()
    spell["rank"] = rank
    if tradition in PATH_TRADITIONS:
        spell["path_spell"] = True
    for f in ("requirement", "target", "area", "duration"):
        if f in fields:
            spell[f] = re.sub(r"\s+", " ", fields[f]).strip()
    spell["description"] = desc
    m = ATTACK_ROLL_RE.search(desc)
    if m:
        spell["attack"] = {"attribute": m.group(1), "against": m.group(2) or "Defense"}
        dm = DAMAGE_RE.search(desc)
        if dm:
            spell["attack"]["damage"] = dm.group(1).replace(" ", "")
    spell["source"] = book
    spell["page"] = page
    return spell


def drop_clipped_duplicates(body):
    """Some Terrible Beauty pages carry a clipped duplicate text layer.

    Duplicate lines repeat earlier text verbatim except for a few characters
    clipped from the start of the line. Drop any line whose tail (past the
    clipped lead word) already appeared.
    """
    seen = ""
    out = []
    for line in body:
        probe = line[5:].strip() if len(line) > 30 else line
        if len(probe) >= 25 and probe in seen:
            continue
        out.append(line)
        seen += " " + line
    return out


def title_case(s):
    small = {"of", "the", "a", "an", "and", "or", "to", "in", "on", "with", "for"}
    words = s.lower().split()
    out = []
    for k, w in enumerate(words):
        if k > 0 and w in small:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def main():
    all_spells = []
    seen = {}
    for book in BOOKS:
        for sp in parse_book(book):
            key = (sp["name"].lower(), sp["tradition"].lower())
            if key in seen:
                continue
            seen[key] = True
            all_spells.append(sp)
    all_spells.sort(key=lambda s: (s["tradition"], s["rank"], s["name"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(all_spells, f, indent=1, ensure_ascii=False)
    by_book = {}
    for s in all_spells:
        by_book[s["source"]] = by_book.get(s["source"], 0) + 1
    print(f"{len(all_spells)} spells -> {OUT}  {by_book}", file=sys.stderr)


if __name__ == "__main__":
    main()
