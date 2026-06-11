#!/usr/bin/env python3
"""Parse the core rulebook equipment chapter into data/equipment.json.

Tables flow through the extracted text as fixed-width cell cycles:
weapons are 6 cells (Name/Damage/Hands/Properties/Price/Avail.), armor 4
(Name/Defense/Price/Avail.), gear 3 (Item/Price/Availability). Cells are
validated; a wrapped properties cell is merged into its predecessor.
"""
import json
import os
import re

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "equipment.json")

DAMAGE_RE = re.compile(r"^(—|\d+|\d+d\d+(?:\s*[+−-]\s*\d+)?)$")
HANDS = {"Off", "One", "Two", "—"}
PRICE_RE = re.compile(r"^(—|Varies|[\d,]+\s*(?:bits?|cp|ss|gc)\+?)$")
AVAIL = {"C", "U", "R", "E", "—"}
DEFENSE_RE = re.compile(r"^(Agility(?:\s*\+\s*\d+)?|\d+)$")

WEAPON_SECTIONS = [
    ("Basic Melee Weapons", None),
    ("Ranged Weapons", None),
    ("Shields (Requires Strength 9 or higher)", "Strength 9"),
    ("Military Melee Weapons (Requires Strength 11 or higher)", "Strength 11"),
    ("Swift Melee Weapons (Requires Strength or Agility 11 or higher)", "Strength or Agility 11"),
    ("Heavy Melee Weapons (Requires Strength 13 or higher)", "Strength 13"),
]

ARMOR_GROUPS = {
    "Clothing (No Strength Requirement)": None,
    "Light Armor (Requires Strength 11 or higher)": "Strength 11",
    "Medium Armor (Requires Strength 13 or higher)": "Strength 13",
    "Heavy Armor (Requires Strength 15 or higher)": "Strength 15",
}

GEAR_CATEGORIES = ["Personal Gear", "Apparel and Accessories", "Tools", "Potion"]


def text_lines():
    """Strip page furniture without eating data cells: bare numbers are only
    page/chapter numbers when adjacent to a ===PAGE=== marker (damage values
    like Dart's "1" are real cells)."""
    raw_lines = [l.rstrip("\n").strip() for l in open(os.path.join(CACHE, "core.txt"))]
    marker = [bool(re.match(r"^===PAGE \d+===$", s)) for s in raw_lines]
    out = []
    for i, s in enumerate(raw_lines):
        if not s or marker[i]:
            continue
        near_marker = any(marker[j] for j in range(max(0, i - 2), min(len(raw_lines), i + 3)))
        if near_marker and re.match(r"^(\d{1,3}|Equipment)$", s):
            continue
        out.append(s)
    return out


def find(lines, needle):
    for i, l in enumerate(lines):
        if l == needle:
            return i
    return -1


def parse_weapons(lines):
    weapons = []
    for section, requirement in WEAPON_SECTIONS:
        i = find(lines, section)
        if i < 0:
            print(f"missing weapon section: {section}")
            continue
        category = section.split(" (")[0]
        j = i + 1
        # Skip the column header cells.
        while j < len(lines) and lines[j] in ("Name", "Damage", "Hands", "Properties", "Price", "Avail."):
            j += 1
        while j + 5 < len(lines):
            cells = lines[j:j + 6]
            # Wrapped name cell ("Battleaxe, flail, ... pick, / or sword"):
            # the damage shows up one cell late.
            if not DAMAGE_RE.match(cells[1]) and j + 6 < len(lines) \
                    and DAMAGE_RE.match(cells[2]) and lines[j + 3] in HANDS:
                cells = [cells[0] + " " + cells[1]] + lines[j + 2:j + 7]
                j += 1
            if not (DAMAGE_RE.match(cells[1]) and cells[2] in HANDS):
                break
            if not (PRICE_RE.match(cells[4]) and cells[5] in AVAIL):
                # Wrapped properties cell: price/avail show up one cell late.
                if j + 6 < len(lines) and PRICE_RE.match(cells[5]) and lines[j + 6] in AVAIL:
                    cells = cells[:3] + [cells[3] + " " + cells[4], cells[5], lines[j + 6]]
                    j += 1
                else:
                    break
            name = cells[0]
            req = requirement
            m = re.search(r"\(requires ([^)]+)\+?\)", name, re.I)
            if m:
                req = m.group(1).replace("+", "").strip()
                name = re.sub(r"\s*\(requires [^)]+\)", "", name, flags=re.I)
            weapons.append({
                "name": name,
                "category": category,
                "damage": cells[1].replace(" ", ""),
                "hands": cells[2],
                "properties": "" if cells[3] == "—" else cells[3],
                "price": cells[4],
                "availability": cells[5],
                **({"requirement": req} if req else {}),
            })
            j += 6
    return weapons


def parse_armor(lines):
    armor = []
    i = find(lines, "Clothing and Armor")
    group_req = None
    group = None
    j = i + 1
    while j + 1 < len(lines):
        line = lines[j]
        if line in ("Name", "Defense", "Price", "Avail."):
            j += 1
            continue
        if line in ARMOR_GROUPS:
            group_req = ARMOR_GROUPS[line]
            group = line.split(" (")[0]
            j += 1
            continue
        if j + 3 < len(lines) and DEFENSE_RE.match(lines[j + 1]) \
                and PRICE_RE.match(lines[j + 2]) and lines[j + 3] in AVAIL:
            armor.append({
                "name": line,
                "type": group or "Clothing",
                "defense": lines[j + 1].replace(" ", ""),
                "price": lines[j + 2],
                "availability": lines[j + 3],
                **({"requirement": group_req} if group_req else {}),
            })
            j += 4
            continue
        break
    return armor


def parse_gear(lines):
    """Item/Price/Availability triples under 'Item' headers (pages 106-108)
    and the Potions table."""
    gear = []
    avail_words = {"Common", "Uncommon", "Rare", "Exotic", "Rare to exotic", "GM permission"}
    j = 0
    while j < len(lines):
        if lines[j] == "Item" and j + 2 < len(lines) and lines[j + 1] == "Price" \
                and lines[j + 2] == "Availability":
            j += 3
            while j + 2 < len(lines) and lines[j + 2] in avail_words \
                    and not lines[j].startswith("Item"):
                gear.append({"name": lines[j], "price": lines[j + 1],
                             "availability": lines[j + 2]})
                j += 3
        elif lines[j] == "Potion" and j + 2 < len(lines) and lines[j + 1] == "Price":
            j += 3
            while j + 2 < len(lines) and lines[j + 2] in avail_words:
                gear.append({"name": "Potion of " + lines[j], "price": lines[j + 1],
                             "availability": lines[j + 2], "category": "Potion"})
                j += 3
        else:
            j += 1
    return gear


def main():
    lines = text_lines()
    weapons = parse_weapons(lines)
    armor = parse_armor(lines)
    gear = parse_gear(lines)
    out = {"weapons": weapons, "armor": armor, "gear": gear}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f"{len(weapons)} weapons, {len(armor)} armor, {len(gear)} gear -> {OUT}")


if __name__ == "__main__":
    main()
