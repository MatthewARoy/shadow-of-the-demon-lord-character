#!/usr/bin/env python3
"""Build data/traditions.json.

Attribute/dark-magic assignments hand-verified against the "Traditions by
Attribute" tables (core p.112, Occult Philosophy p.7, extracted positionally
with pdfplumber to resolve the two-column layout). Descriptions are pulled
from each tradition's intro prose in Occult Philosophy chapter 1.
"""
import json
import os
import re

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "traditions.json")

INTELLECT = [
    "Alchemy", "Arcana", "Battle", "Conjuration", "Curse", "Demonology",
    "Divination", "Enchantment", "Fey", "Forbidden", "Illusion", "Invocation",
    "Madness", "Necromancy", "Protection", "Rune", "Shadow", "Technomancy",
    "Telepathy", "Teleportation", "Time",
]
WILL = [
    "Air", "Alteration", "Celestial", "Chaos", "Death", "Destruction",
    "Earth", "Fire", "Life", "Metal", "Nature", "Order", "Primal", "Song",
    "Soul", "Spiritualism", "Storm", "Telekinesis", "Theurgy",
    "Transformation", "Water",
]
DARK = {"Curse", "Death", "Demonology", "Forbidden", "Madness", "Necromancy"}

# Traditions introduced outside the core rulebook.
SOURCES = {
    "Alchemy": "occult", "Death": "occult", "Demonology": "occult",
    "Fey": "terrible", "Invocation": "occult", "Madness": "occult",
    "Metal": "occult", "Order": "occult", "Soul": "occult",
    "Spiritualism": "occult", "Telekinesis": "occult", "Telepathy": "occult",
}

SPELL_NAME_RE = re.compile(r"^[A-Z][A-Z’'\-, ]*$")


def extract_descriptions():
    """Each tradition's intro: a standalone name line in Occult Philosophy
    chapter 1, followed by prose until the first all-caps spell name."""
    names = set(INTELLECT + WILL)
    descs = {}
    page = 0
    lines = []
    for raw in open(os.path.join(CACHE, "occult.txt")):
        l = raw.rstrip("\n")
        m = re.match(r"^===PAGE (\d+)===$", l.strip())
        if m:
            page = int(m.group(1))
            continue
        lines.append((page, l))
    i = 0
    while i < len(lines):
        pg, line = lines[i]
        s = line.strip()
        # Tradition intros live in chapter 1, after the front matter tables.
        if pg >= 13 and s in names and s not in descs:
            parts = []
            j = i + 1
            while j < len(lines) and len(parts) < 60:
                t = lines[j][1].strip()
                if (SPELL_NAME_RE.match(t) and len(t) > 3) or t in names:
                    break
                if t and not re.match(r"^(\d{1,3}|Traditions and Spells)$", t):
                    parts.append(t)
                j += 1
            text = re.sub(r"\s+", " ", " ".join(parts)).strip()
            if len(text) > 120:
                descs[s] = text
        i += 1
    return descs


def main():
    descs = extract_descriptions()
    out = []
    for name in sorted(INTELLECT + WILL):
        out.append({
            "name": name,
            "attribute": "Intellect" if name in INTELLECT else "Will",
            "dark": name in DARK,
            "source": SOURCES.get(name, "core"),
            "description": descs.get(name, ""),
        })
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    missing = [t["name"] for t in out if not t["description"]]
    print(f"{len(out)} traditions -> {OUT}; missing descriptions: {missing}")


if __name__ == "__main__":
    main()
