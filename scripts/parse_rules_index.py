#!/usr/bin/env python3
"""Build data/rules-index.json — the table-lookup search corpus.

Chunks the gameplay rules chapters by headings: core character creation and
"Playing the Game" (afflictions, combat actions, rolls), equipment rules,
the magic-system rules, and Occult Philosophy's restated casting rules.
Setting, bestiary, adventure, and path chapters stay out (paths and spells
are already structured app data).
"""
import json
import os
import re

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "rules-index.json")

# (book, first pdf page, last pdf page)
RANGES = [
    ("core", 6, 53),      # ch1 character creation + ch2 playing the game
    ("core", 100, 118),   # ch6 equipment + ch7 magic rules (pre spell lists)
    ("occult", 6, 12),    # restated/updated casting, learning, exchanging
]

RUNNING_HEADS = {
    "Character Creation", "Playing the Game", "Equipment", "Magic",
    "Novice Paths", "Expert Paths", "Master Paths", "Traditions and Spells",
    "INtroduction", "Shadow of the Demon Lord", "Occult Philosophy",
    "Terrible Beauty",
}

SMALL_WORDS = {"of", "the", "and", "a", "an", "to", "in", "for", "with", "or", "by", "at", "on"}

MIN_BODY = 60           # below this, likely a table cell; merge into parent
MAX_BODY = 1600         # chunks larger than this get split on paragraph-ish seams


BOUNDARY = (None, None, None)


def lines_in_ranges():
    """Yield (book, page, line) per content line, and BOUNDARY between ranges.

    Without an explicit boundary the chunker holds its open chunk across the
    gap, so the last section of one range absorbs the first prose of the
    next — including across books. That is how chunks titled EXPLOSIVE DARTS
    (core p.118) came to end with Occult Philosophy p.6 text.
    """
    for book, lo, hi in RANGES:
        page = 0
        for raw in open(os.path.join(CACHE, f"{book}.txt")):
            s = raw.rstrip("\n")
            m = re.match(r"^===PAGE (\d+)===$", s.strip())
            if m:
                page = int(m.group(1))
                continue
            if lo <= page <= hi:
                yield book, page, s
        yield BOUNDARY


def is_heading(s):
    s = s.strip()
    if not s or len(s) < 4 or len(s) > 42:
        return False
    if s.endswith((".", ",", ";", ":", "?", "!", ")")):
        return False
    if s in RUNNING_HEADS or re.match(r"^\d", s) or "\t" in s:
        return False
    words = s.split()
    if len(words) > 6:
        return False
    ok = sum(1 for w in words if (w[0].isupper() or w.lower() in SMALL_WORDS or re.match(r"^d\d+$", w)))
    return ok == len(words) and any(w[0].isupper() for w in words)


def furniture(s):
    s = s.strip()
    return not s or re.match(r"^\d{1,3}$", s) or s in RUNNING_HEADS or \
        re.match(r"^Chapter \d+:?$", s) or s.startswith("Rusty Shackleford")


def chunk():
    chunks = []
    current = None
    for book, page, line in lines_in_ranges():
        if book is None:            # range/book boundary — close the open chunk
            if current:
                chunks.append(current)
                current = None
            continue
        s = line.strip()
        if furniture(s):
            continue
        if is_heading(s):
            if current:
                chunks.append(current)
            current = {"t": s, "b": book, "p": page, "x": ""}
            continue
        if current is None:
            current = {"t": "Introduction", "b": book, "p": page, "x": ""}
        current["x"] += (" " if current["x"] else "") + s
    if current:
        chunks.append(current)

    # Merge tiny chunks (mostly table cells misread as headings) into their
    # parent section; the heading text joins the body so it stays searchable.
    merged = []
    for c in chunks:
        c["x"] = re.sub(r"\s+", " ", c["x"]).strip()
        if merged and len(c["x"]) < MIN_BODY and merged[-1]["b"] == c["b"]:
            merged[-1]["x"] += f" {c['t']}: {c['x']}" if c["x"] else f" {c['t']}."
        else:
            merged.append(c)

    # Split oversized chunks at sentence seams.
    out = []
    for c in merged:
        if len(c["x"]) <= MAX_BODY:
            out.append(c)
            continue
        sentences = re.split(r"(?<=[.!?]) ", c["x"])
        part, n = "", 1
        for sent in sentences:
            if len(part) + len(sent) > MAX_BODY and part:
                out.append({"t": c["t"] + (f" ({n})" if n > 1 else ""), "b": c["b"], "p": c["p"], "x": part})
                part, n = "", n + 1
            part += (" " if part else "") + sent
        if part:
            out.append({"t": c["t"] + (f" ({n})" if n > 1 else ""), "b": c["b"], "p": c["p"], "x": part})
    return out


def main():
    chunks = chunk()
    with open(OUT, "w") as f:
        json.dump(chunks, f, ensure_ascii=False)
    size = os.path.getsize(OUT) // 1024
    print(f"{len(chunks)} chunks ({size} KB) -> {OUT}")


if __name__ == "__main__":
    main()
