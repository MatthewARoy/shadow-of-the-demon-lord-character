#!/usr/bin/env python3
"""Scan generated data/*.json for parser-defect signatures.

Reports only — never modifies data. Reads committed JSON, so it runs in a
fresh clone with no PDFs and no scripts/cache.

Every defect in the 2026-07 rework was found by an ad-hoc scan, and every
defect that was MISSED was missed because the scan only looked for
signatures already known. This script exists so that failure mode stops
recurring.

Signatures are tuned for recall; false positives are expected and absorbed
by scripts/parse_quality_baseline.json. The gate fails only on hits that are
not in that baseline.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
BASELINE = os.path.join(HERE, "parse_quality_baseline.json")

FILES = [
    "rules-index.json", "spells.json", "paths.json",
    "traditions.json", "equipment.json", "creatures.json", "curated.json",
]

MIN_LEN = 16          # below this a string carries too little signal

RUNNING_HEADS = (r"playing the game|character creation|traditions and spells|"
                 r"occult philosophy|terrible beauty")
LIGATURES = r"[ŋŊŌőŒ]|\bfi rst\b|ﬁ|ﬂ"

SIGNATURES = {
    # A trailing section/tradition header, or a running head anywhere. This is
    # the class that put "Celestial Spells" on the end of Phasing Missile and
    # Occult Philosophy prose inside a core rulebook chunk.
    # "(see Terrible Beauty)" is a legitimate cross-reference to another
    # book, not a leaked running head, so a preceding "see" excludes it.
    "bleed": lambda s: bool(
        re.search(r"\.\s+[A-Z][A-Za-z' ]{2,28} Spells$", s.strip())
        or re.search(r"(?i)(?<!see )\b(" + RUNNING_HEADS + r")\b", s)
    ),
    # Price runs, stat-table header remnants, and weapon rows — the "sling"
    # class, where a table row was chunked as if it were prose.
    "table_row": lambda s: bool(
        len(re.findall(r"\b\d+ (?:cp|ss|gc)\b", s)) > 3
        or re.search(r"(?:Name|Price|Avail)\.\s*(?:Damage|Hands|Avail|Price)", s)
        or re.search(r"\b\dd\d(?:\s*\+\s*\d)? (?:Off|One|Two)\b", s)
    ),
    # Random-table debris: repeated die columns, or a body that ends on a
    # bare die size because the next table's header was absorbed.
    "dice_table": lambda s: bool(
        len(re.findall(r"\bd20\b", s)) > 2
        or re.search(r"\b(?:d20|3d6|2d6)\s*$", s.strip())
    ),
    # Residual PDF ligature artifacts that extract_text.py should have
    # repaired. Currently clean everywhere; this guards the repair.
    "ligature": lambda s: bool(re.search(LIGATURES, s)),
}


def walk(obj, path=""):
    """Yield (path, string) for every string field worth scanning."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{path}[{i}]")
    elif isinstance(obj, str) and len(obj) >= MIN_LEN:
        yield path, obj


def scan_records(filename, records):
    hits = []
    for path, text in walk(records):
        for name, matches in SIGNATURES.items():
            if matches(text):
                hits.append({
                    "file": filename,
                    "path": path,
                    "signature": name,
                    "excerpt": text[-90:].strip(),
                })
    return hits


def scan(data_dir=DATA):
    out = {}
    for name in FILES:
        p = os.path.join(data_dir, name)
        if not os.path.exists(p):
            continue
        with open(p) as f:
            out[name] = scan_records(name, json.load(f))
    return out


def key(hit):
    """Stable identity for baselining, independent of excerpt drift."""
    return f"{hit['file']}|{hit['path']}|{hit['signature']}"


def main():
    results = scan()

    if "--update-baseline" in sys.argv:
        accepted = sorted(key(h) for hits in results.values() for h in hits)
        with open(BASELINE, "w") as f:
            json.dump({"accepted": accepted}, f, indent=1)
        print(f"baseline updated: {len(accepted)} accepted hits", file=sys.stderr)
        return 0

    baseline = set()
    if os.path.exists(BASELINE):
        with open(BASELINE) as f:
            baseline = set(json.load(f)["accepted"])

    new = []
    for name, hits in results.items():
        unbaselined = [h for h in hits if key(h) not in baseline]
        new.extend(unbaselined)
        state = "clean" if not hits else f"{len(hits)} hit(s), {len(unbaselined)} new"
        print(f"{name:<22} {state}")

    if new:
        print(f"\n{len(new)} hit(s) not in baseline:\n", file=sys.stderr)
        for h in new[:40]:
            print(f"  [{h['signature']}] {h['file']}{h['path']}", file=sys.stderr)
            print(f"      ...{h['excerpt']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
