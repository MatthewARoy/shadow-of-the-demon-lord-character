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

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "paths.json")

BOOKS = ["core", "occult", "terrible"]
PATH_LEVELS = {3, 6, 7, 9, 10}

LEVEL_RE = re.compile(r"^Level (\d+) (?:Expert |Master )?([A-Z][\w’'\- ]+?)\s*$")
FIELDS = ("Attributes", "Characteristics", "Languages and Professions", "Magic")

FURNITURE = re.compile(
    r"^(===PAGE \d+===|\d{1,3}|Novice Paths|Expert Paths|Master Paths|"
    r"Paths|Chapter \d+:?|Terrible Beauty|Occult Philosophy|"
    r"Rusty Shackleford \(Order #\d+\))$"
)

TALENT_START = re.compile(
    r"^((?:[A-Z][\w’'!\-]*|of|the|a|an|and|with|in|for|to|from)"
    r"(?: (?:[A-Z][\w’'!\-]*|of|the|a|an|and|with|in|for|to|from))*) "
    r"(You|Your|When|Whenever|Once|While|The|This|If|At|As|Creatures|"
    r"Enemies|Attacks|Choose|Roll|Make|Add|Increase|Decrease|Gain|"
    r"Spells|A|An|All|Anytime|Any|Each|For|Whether|On|Using|Other)\b"
)

TRADITIONS = {
    "Air", "Alchemy", "Alteration", "Arcana", "Battle", "Celestial", "Chaos",
    "Conjuration", "Curse", "Death", "Demonology", "Destruction", "Divination",
    "Earth", "Enchantment", "Fey", "Fire", "Forbidden", "Illusion",
    "Invocation", "Life", "Madness", "Metal", "Nature", "Necromancy", "Order",
    "Primal", "Protection", "Rune", "Shadow", "Song", "Soul", "Spiritualism",
    "Storm", "Technomancy", "Telekinesis", "Telepathy", "Teleportation",
    "Theurgy", "Time", "Transformation", "Water",
}

NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}

# The books occasionally title a path's level headers with a different word
# than the path's own heading (core: "Level 7 Enchantment" under "Enchanter").
NAME_FIXES = {"Enchantment": "Enchanter"}


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
        if FURNITURE.match(line.strip()):
            continue
        out.append((page, line.rstrip()))
    return out


def find_level_blocks(lines):
    """Return [(index, level, name)] for path level headers."""
    headers = []
    for i, (_, line) in enumerate(lines):
        m = LEVEL_RE.match(line.strip())
        if m and int(m.group(1)) in PATH_LEVELS:
            name = m.group(2).strip()
            headers.append((i, int(m.group(1)), NAME_FIXES.get(name, name)))
    return headers


# Section headings that follow the final path of a chapter.
STOP_HEADINGS = {"Legendary Path", "Story Development", "Roll a d6", "Personality"}

# Last PDF page of path content per book; the next chapter follows.
PATH_PAGE_LIMIT = {"core": 99, "occult": 9999, "terrible": 9999}


def block_end(lines, start, headers, h_idx, path_names, book):
    """A level block runs until the next level header, a table marker, the
    next path's standalone name line, or a chapter/page boundary."""
    nxt = headers[h_idx + 1][0] if h_idx + 1 < len(headers) else len(lines)
    start_page = lines[start][0]
    limit = min(start_page + 1, PATH_PAGE_LIMIT[book])
    for j in range(start + 1, nxt):
        if lines[j][0] > limit:
            return j
        s = lines[j][1].strip()
        if re.match(r"^d\d+$", s) or s in STOP_HEADINGS:
            return j
        if s in path_names and j > start + 1:
            return j
    return nxt


def drop_clipped_duplicates(block_lines):
    """Terrible Beauty pages carry a clipped duplicate text layer; drop lines
    whose tail already appeared (same approach as parse_spells)."""
    seen = ""
    out = []
    for line in block_lines:
        probe = line[5:].strip() if len(line) > 30 else line
        if len(probe) >= 25 and probe in seen:
            continue
        out.append(line)
        seen += " " + line
    return out


def parse_block(lines, start, end, book):
    """Split a level block into labelled fields and talents."""
    fields = {}
    talents = []
    current = None     # ("field", name) or ("talent", idx)
    block_lines = [lines[j][1].strip() for j in range(start + 1, end)]
    if book == "terrible":
        block_lines = drop_clipped_duplicates(block_lines)
    for line in block_lines:
        if not line:
            continue
        matched_field = None
        for f in FIELDS:
            # Field values start uppercase; a lowercase follower means a
            # wrapped line that merely begins with the field word
            # ("...with Life / Magic to heal this thrall...").
            if line.startswith(f + " ") and line[len(f) + 1:len(f) + 2].isupper():
                matched_field = f
                break
        if matched_field:
            rest = line[len(matched_field) + 1:]
            # Talents named "Magic Mask", "Magic Wand", etc. would otherwise
            # be swallowed by the Magic field.
            tm = TALENT_START.match(rest)
            if matched_field == "Magic" and tm and not rest.startswith(
                    ("You", "Your", "Make", "Choose", "Increase", "Learn", "Whenever", "When")):
                talents.append({"name": "Magic " + tm.group(1),
                                "text": rest[len(tm.group(1)) + 1:]})
                current = ("talent", len(talents) - 1)
                continue
            fields[matched_field] = rest
            current = ("field", matched_field)
            continue
        tm = TALENT_START.match(line)
        is_continuation = bool(re.match(r"^[a-z0-9(••\-]|^or |^and ", line))
        if tm and not is_continuation:
            talents.append({"name": tm.group(1), "text": line[len(tm.group(1)) + 1:]})
            current = ("talent", len(talents) - 1)
            continue
        # Continuation of whatever came last.
        if current and current[0] == "field":
            fields[current[1]] += " " + line
        elif current and current[0] == "talent":
            talents[current[1]]["text"] += " " + line
        # else: stray prose before first field; ignore.
    for t in talents:
        t["text"] = re.sub(r"\s+", " ", t["text"]).replace("•", "\n•").strip()
    fields = {k: re.sub(r"\s+", " ", v).strip() for k, v in fields.items()}
    # A few blocks omit the "Characteristics" label and the values get glued
    # onto Attributes ("Increase each by 1 Health +2"); split them apart.
    if "Attributes" in fields and "Characteristics" not in fields:
        m = re.search(r"\b(Health|Power|Speed|Defense)\s*[+\u2212\u2013-]", fields["Attributes"])
        if m:
            fields["Characteristics"] = fields["Attributes"][m.start():]
            fields["Attributes"] = fields["Attributes"][:m.start()].strip()
    return fields, talents


def parse_attributes(text):
    if not text:
        return None
    m = re.search(r"[Ii]ncrease (one|two|three|four)(?: attributes?(?: of your choice)?)? by 1", text)
    if m:
        return {"choose": NUMBER_WORDS[m.group(1)], "increase": 1}
    m = re.search(r"[Cc]hoose (one|two|three|four) attributes? and increase (?:each|it) by 1", text)
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


def parse_magic(text):
    """Turn a Magic line into structured choice slots."""
    if not text:
        return None
    t = text.strip()
    result = {"raw": t}
    # Constrained to two traditions: "discover the X or Y tradition or
    # learn one X or Y spell"
    m = re.search(r"discover the (\w+) or (\w+) tradition or (?:you )?learn one", t)
    if m and m.group(1) in TRADITIONS and m.group(2) in TRADITIONS:
        result["choices"] = [{"pick": 1, "options": ["discover_tradition", "learn_spell"],
                              "traditions": [m.group(1), m.group(2)]}]
        return result
    # Tradition-constrained variants: "discover the X tradition or learn one X spell"
    m = re.search(r"discover the (\w+) tradition or learn (?:one|a) (\w+) spell", t)
    if m and m.group(1) in TRADITIONS:
        result["choices"] = [{"pick": 1, "options": ["discover_tradition", "learn_spell"],
                              "traditions": [m.group(1)]}]
        return result
    m = re.search(r"[Mm]ake (one|two|three|four) choices?", t)
    if m:
        result["choices"] = [{"pick": NUMBER_WORDS[m.group(1)],
                              "options": ["discover_tradition", "learn_spell"]}]
        return result
    if re.search(r"discover (?:a|one) tradition or learn (?:one|a) spell", t):
        result["choices"] = [{"pick": 1, "options": ["discover_tradition", "learn_spell"]}]
        return result
    m = re.search(r"discover the (\w+) tradition", t)
    if m and m.group(1) in TRADITIONS:
        result["choices"] = [{"pick": 1, "options": ["discover_tradition"], "traditions": [m.group(1)]}]
        return result
    if re.search(r"discover (?:a|one) tradition", t):
        result["choices"] = [{"pick": 1, "options": ["discover_tradition"]}]
        return result
    # "You learn one Alchemy spell" / "learn one spell from the X tradition"
    m = re.search(r"[Ll]earn (one|two|three) (\w+) spells?", t)
    if m and m.group(2) in TRADITIONS:
        result["choices"] = [{"pick": NUMBER_WORDS[m.group(1)], "options": ["learn_spell"],
                              "traditions": [m.group(2)]}]
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
    name_idx = None
    for j in range(first_header_idx - 1, max(first_header_idx - 120, -1), -1):
        if lines[j][1].strip().lower() == name.lower():
            name_idx = j
            break
    if name_idx is None:
        return ""
    parts = []
    j = name_idx + 1
    while j < first_header_idx:
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
        fields, talents = parse_block(lines, i, end, book)
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
        first_idx = next(i for i, (idx, lv, nm) in enumerate(find_level_blocks(lines))
                         if nm.lower() == key)
        header_line_idx = find_level_blocks(lines)[first_idx][0]
        p["description"] = gather_intro(lines, p["name"], header_line_idx)
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
        p["name"].lower() for p in all_paths
        if set(p["levels"]) >= ({"3", "6", "9"} if p["type"] == "expert" else {"7", "10"})
    }
    def is_clipped(p):
        want = {"3", "6", "9"} if p["type"] == "expert" else {"7", "10"}
        if set(p["levels"]) >= want:
            return False
        return any(c.startswith(p["name"].lower()) and c != p["name"].lower()
                   for c in complete)
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
