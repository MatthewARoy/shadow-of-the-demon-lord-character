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

from table_manifest import is_table_caption, is_table_internal

CACHE = os.path.join(os.path.dirname(__file__), "cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "rules-index.json")

# A spell entry's header is the tradition/type/rank line that follows an
# all-caps spell name, e.g. "AIR UTILITY 0". Page numbers cannot separate the
# generic magic rules at the top of core p.116 from the spell list lower on
# the SAME page, so that range ends on content instead. Without this, 33 spell
# records leaked into the index and duplicated the Spells tab.
SPELL_LIST_START = re.compile(r"^[A-Z][A-Z’'\- ]*\s+(ATTACK|UTILITY)\s+\d+\s*$")

# (book, first pdf page, last pdf page, end anchor or None)
RANGES = [
    ("core", 6, 53, None),                 # ch1 character creation + ch2 playing the game
    ("core", 100, 118, SPELL_LIST_START),  # ch6 equipment + ch7 magic rules (pre spell lists)
    ("occult", 6, 12, None),               # restated/updated casting, learning, exchanging
]

RUNNING_HEADS = {
    "Character Creation", "Playing the Game", "Equipment", "Magic",
    "Novice Paths", "Expert Paths", "Master Paths", "Traditions and Spells",
    "INtroduction", "Shadow of the Demon Lord", "Occult Philosophy",
    "Terrible Beauty",
}

# Matched case-insensitively: the extraction emits "PLaying the Game" as well
# as "Playing the Game", and an exact-match set let the variant through into
# seven chunk bodies.
RUNNING_HEADS_LOWER = {h.lower() for h in RUNNING_HEADS}

SMALL_WORDS = {"of", "the", "and", "a", "an", "to", "in", "for", "with", "or", "by", "at", "on"}

# A heading wrapped onto a second line continues with a lowercase article or
# preposition: "Attack with" / "a Melee Weapon", "Situational Banes" / "to
# Attack Rolls". Capitalised "The Dice" is a heading in its own right, so the
# test is case-sensitive.
CONTINUATION = re.compile(r"^(a|an|the|to|of|with|or|and)\b")

MAX_BODY = 1600         # chunks larger than this get split on paragraph-ish seams


BOUNDARY = (None, None, None)


def lines_in_ranges():
    """Yield (book, page, line) per content line, and BOUNDARY between ranges.

    Without an explicit boundary the chunker holds its open chunk across the
    gap, so the last section of one range absorbs the first prose of the
    next — including across books. That is how chunks titled EXPLOSIVE DARTS
    (core p.118) came to end with Occult Philosophy p.6 text.
    """
    for book, lo, hi, end_anchor in RANGES:
        page = 0
        with open(os.path.join(CACHE, f"{book}.txt")) as f:
            for raw in f:
                s = raw.rstrip("\n")
                m = re.match(r"^===PAGE (\d+)===$", s.strip())
                if m:
                    page = int(m.group(1))
                    continue
                if lo <= page <= hi:
                    if end_anchor and end_anchor.match(s.strip()):
                        break
                    yield book, page, s
        yield BOUNDARY


def is_heading(s):
    s = s.strip()
    if not s or len(s) < 4 or len(s) > 42:
        return False
    if s.endswith((".", ",", ";", ":", "?", "!", ")")):
        return False
    if s.lower() in RUNNING_HEADS_LOWER or re.match(r"^\d", s) or "\t" in s:
        return False
    words = s.split()
    if len(words) > 6:
        return False
    ok = sum(1 for w in words if (w[0].isupper() or w.lower() in SMALL_WORDS or re.match(r"^d\d+$", w)))
    return ok == len(words) and any(w[0].isupper() for w in words)


def furniture(s):
    s = s.strip()
    return not s or re.match(r"^\d{1,3}$", s) or s.lower() in RUNNING_HEADS_LOWER or \
        re.match(r"^Chapter \d+:?$", s) or s.startswith("Rusty Shackleford")


def wrapped_heading(s, peek):
    """Return the joined heading when `peek` continues `s`, else None."""
    peek = (peek or "").strip()
    if peek and CONTINUATION.match(peek) and is_heading(peek):
        return f"{s} {peek}"
    return None


def chunk():
    chunks = []
    current = None
    open_caption = None         # caption of the table block currently open
    skip_next = False           # second line of a heading already joined
    stream = list(lines_in_ranges())
    for idx, (book, page, line) in enumerate(stream):
        if skip_next:
            skip_next = False
            continue
        if book is None:            # range/book boundary — close the open chunk
            if current:
                chunks.append(current)
                current = None
            open_caption = None
            continue
        nxt = stream[idx + 1]
        peek = nxt[2] if nxt[0] is not None else ""
        s = line.strip()
        if furniture(s):
            continue
        if is_heading(s):
            # Join a wrapped heading BEFORE testing it as a caption: the
            # Situational Banes table is captioned "Situational Banes / to
            # Attack Rolls" across two lines, so testing the first line alone
            # opened the block and left the tail as an orphan chunk.
            joined = wrapped_heading(s, peek)
            if joined:
                s = joined
                skip_next = True
                nxt2 = stream[idx + 2] if idx + 2 < len(stream) else (None, None, "")
                peek = nxt2[2] if nxt2[0] is not None else ""
            # A declared caption opens (or re-opens) a table block.
            if is_table_caption(s, peek):
                if current:
                    chunks.append(current)
                    current = None
                open_caption = s
                continue
            # Headings that belong to the open table — the column header —
            # must not close it, or the remaining rows become their body.
            if open_caption and is_table_internal(s, open_caption, peek):
                continue
            open_caption = None
            if current:
                chunks.append(current)
            current = {"t": s, "b": book, "p": page, "x": ""}
            continue
        if open_caption:            # row numbers and row text
            continue
        if current is None:
            current = {"t": "Introduction", "b": book, "p": page, "x": ""}
        current["x"] += (" " if current["x"] else "") + s
    if current:
        chunks.append(current)

    # Table cells are excluded by the manifest before headings are built, so
    # a short body no longer implies a table cell. Length-based merging used
    # to swallow real rules: "A dazed creature cannot use actions." is 36
    # characters and a complete affliction entry, and it was glued onto the
    # end of Compelled — along with Rush, Disabled, and Dying.
    merged = []
    for c in chunks:
        c["x"] = re.sub(r"\s+", " ", c["x"]).strip()
        if c["x"]:
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
