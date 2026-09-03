#!/usr/bin/env python3
"""Capture the random tables the books print *inside* a spell or a talent.

A table printed mid-entry arrives from the PDF as one cell per line, so a
parser that treats every line as prose flattens it into gibberish. The
wardscribe's sigil-duration table became

    ... as shown on the following table. Spell Rank Duration Spell Rank
    Duration 1 minute 1 week 10 minutes 1 month ...

— the ranks gone (dropped as page-number furniture), the durations run
together in column order. A player cannot resolve the talent from that.

Two shapes are captured, and only two, because only these two have a row
boundary that can be trusted:

**Die-keyed.** A die size on its own line, a one-word column label, then rows
opened by a die result. The row text is prose and wraps freely, so the key
line is the boundary:

    d6            <- die
    Effect        <- label
    1             <- row key
    The creature becomes a monster (Shadow, page 246) of its Size and
    uses the statistics of its new form...
    2
    ...

**Rank-keyed.** A run of declared column headers, then short cells in printed
(row-major) order. There is no key/text distinction to lean on — in the
builder's table both columns are bare numbers — so the header run fixes the
column count and the cells are chunked by it:

    Spell Rank    Duration      Spell Rank    Duration     <- two column pairs
    0             1 minute      6             1 week
    1             10 minutes    7             1 month

A repeated header run means the printer split one logical table into
side-by-side pairs; the period of the repeat gives the real column count and
each chunk unfolds back into one row per pair.

What is deliberately *not* captured: tables whose rows are keyed by prose
rather than by a number, where both columns wrap over several lines —
`Creation`'s material/duration table and `Brew Longevity Potion`'s age
categories. There is no line-level signal that separates a row key from its
own wrapped text there, and guessing at one produces worse data than leaving
the flattened prose alone. Those stay as they are.

Every capture is validated before it is returned, and a table that fails
validation is refused outright rather than emitted half-built: a silently
truncated table reads as complete and is worse than none.
"""

import re
import sys

# A die size on its own line: "d6", "d20", "3d6", "1d20".
DIE = re.compile(r"^\d*d\d+$")

# A row key is a die result or a rank: "1", "16–17", "5+".
ROW_KEY = re.compile(r"^\d+(?:\s*[–—-]\s*\d+)?\+?$")

# Cells in a rank-keyed table are short by construction ("10 minutes",
# "128"). The first line longer than this ends the table — which is how the
# builder's talent resumes its own prose below its table.
CELL_MAX = 34

# Column headers of the rank-keyed tables, declared rather than detected.
# The header run and a table's caption are both short Title-Case lines, so
# a shape test cannot tell "Building Blocks" (caption) from "Spell Rank"
# (header); the manifest can. Same reasoning as scripts/table_manifest.py.
COLUMN_HEADERS = {"Spell Rank", "Duration", "Blocks"}


def _die_max(die):
    """Highest result the die line can roll: 3d6 -> 18, d20 -> 20."""
    count, _, size = die.partition("d")
    return int(count or 1) * int(size)


def _key_high(key):
    """Upper bound of a row key: "16–17" -> 17, "5+" -> 5."""
    return int(re.findall(r"\d+", key)[-1])


def _next(lines, pages, j, end, page, stop):
    """Skip blank lines. Returns (index, whether it is still table content).

    A table is read from raw lines, furniture included, because once page
    numbers have been filtered out a row key is indistinguishable from the
    page number that filtered it. The page itself is the filter instead: no
    table in the corpus straddles a page break, so the first line printed on
    another page is past the end of the table — and that is also where the
    running head and the page number live.

    The other end is the entry's own prose resuming below its table. The
    extraction marks the first line of every paragraph with a leading tab —
    1727 of them across the four books — so a tab-led line is a new
    paragraph, never the continuation of a row. Without that test, into the
    void's sixth row read "3d6 tiny demons A demon that emerges from the hole
    acts according to its nature...".
    """
    while j < end and not lines[j].strip():
        j += 1
    if j >= end or pages[j] != page or lines[j].startswith("\t") or stop(j):
        return j, False
    return j, True


def opens_die_table(lines, j, end):
    """True when lines[j] is the die line of a die-keyed table.

    All three of die / label / first key are required. Spell bodies quote
    dice constantly ("gain 1d3 Corruption"), and equipment and falling-damage
    tables put bare dice expressions in their cells; only this full shape is
    a table opening.
    """
    if j + 2 >= end or not DIE.match(lines[j].strip()):
        return False
    label = lines[j + 1].strip()
    if not label or len(label) > CELL_MAX or ROW_KEY.match(label) or DIE.match(label):
        return False
    return bool(ROW_KEY.match(lines[j + 2].strip()))


def opens_column_table(lines, j, end):
    """True when lines[j] starts the header run of a rank-keyed table."""
    return (
        j + 1 < end
        and lines[j].strip() in COLUMN_HEADERS
        and lines[j + 1].strip() in COLUMN_HEADERS
    )


def _capture_die_table(lines, pages, j, end, stop, caption):
    die = lines[j].strip()
    label = lines[j + 1].strip()
    rows = []
    k = j + 2
    while True:
        k, ok = _next(lines, pages, k, end, pages[j], stop)
        if not ok:
            break
        s = lines[k].strip()
        if ROW_KEY.match(s):
            rows.append([s, []])
        elif rows:
            rows[-1][1].append(s)
        else:
            break
        k += 1
    if len(rows) < 2 or any(not text for _, text in rows):
        return None, j
    keys = [_key_high(key) for key, _ in rows]
    if keys != sorted(keys) or keys[-1] > _die_max(die):
        return None, j
    if keys[-1] != _die_max(die):
        print(
            f"table {caption or label!r}: {die} rows stop at {keys[-1]}",
            file=sys.stderr,
        )
    table = {
        "columns": [die, label],
        "rows": [[key, " ".join(text)] for key, text in rows],
    }
    if caption:
        table["caption"] = caption
    return table, k


def _period(headers):
    """Length of the repeating unit in a header run, or its full length."""
    for p in range(1, len(headers)):
        if len(headers) % p == 0 and headers == headers[:p] * (len(headers) // p):
            return p
    return len(headers)


def _capture_column_table(lines, pages, j, end, stop, caption):
    headers = []
    k = j
    while k < end and lines[k].strip() in COLUMN_HEADERS:
        headers.append(lines[k].strip())
        k += 1
    period = _period(headers)
    width = len(headers)
    cells = []
    while True:
        k, ok = _next(lines, pages, k, end, pages[j], stop)
        if not ok:
            break
        s = lines[k].strip()
        if len(s) > CELL_MAX:
            break
        cells.append(s)
        k += 1
    if not cells or len(cells) % period:
        return None, j
    rows = []
    for i in range(0, len(cells), width):
        chunk = cells[i : i + width]
        for g in range(0, len(chunk), period):
            row = chunk[g : g + period]
            if len(row) == period:
                rows.append(row)
    # Every row opens on a rank. A run that swallowed a stray line fails
    # here, which is the point: refuse rather than emit a shifted table.
    if len(rows) < 2 or not all(ROW_KEY.match(r[0]) for r in rows):
        return None, j
    # Side-by-side pairs are printed column-major (0, 6, 1, 7, ...); reading
    # order is not rank order, so restore it.
    if width > period and all(r[0].isdigit() for r in rows):
        rows.sort(key=lambda r: int(r[0]))
    table = {"columns": headers[:period], "rows": rows}
    if caption:
        table["caption"] = caption
    return table, k


def capture(lines, pages, j, end, stop, caption=None):
    """Read the table opening at lines[j].

    Returns (table, index_after_the_table), or (None, j) when the lines do
    not form a table this module is willing to vouch for. `lines` is a list
    of raw strings and `pages` the page each was printed on.
    """
    if opens_die_table(lines, j, end):
        return _capture_die_table(lines, pages, j, end, stop, caption)
    if opens_column_table(lines, j, end):
        return _capture_column_table(lines, pages, j, end, stop, caption)
    return None, j


def opens_table(lines, j, end):
    return opens_die_table(lines, j, end) or opens_column_table(lines, j, end)
