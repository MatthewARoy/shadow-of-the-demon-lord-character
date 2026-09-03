#!/usr/bin/env python3
"""Field-level diff of data/spells.json against the reviewed baseline.

data/spells.json carries light human verification, so a parser change must
be shown to alter only what it intends to alter. Exit 0 only when every
difference is declared with --expect-field; anything else is a regression.

Remember that regenerating spells takes BOTH steps:

    python3 scripts/parse_spells.py && python3 scripts/tag_spells.py

The parser alone strips the `tags` field from all 1,120 records, which this
differ will report as an unexpected change in 'tags'.
"""
import argparse
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(__file__)
BASELINE = os.path.join(HERE, "baseline", "spells.json")
CURRENT = os.path.join(HERE, "..", "data", "spells.json")


def load(path):
    with open(path) as f:
        return {(s["name"], s["tradition"]): s for s in json.load(f)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default=BASELINE,
                    help="reviewed spells JSON (default: scripts/baseline/spells.json)")
    ap.add_argument("--current", default=CURRENT,
                    help="spells JSON to check (default: data/spells.json)")
    ap.add_argument("--expect-field", action="append", default=[],
                    help="field name allowed to differ")
    ap.add_argument("--max-changed", type=int, default=None,
                    help="fail if more than this many records changed in a field")
    args = ap.parse_args()

    try:
        old, new = load(args.baseline), load(args.current)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"cannot diff spells: {exc}", file=sys.stderr)
        return 2
    added, removed = sorted(set(new) - set(old)), sorted(set(old) - set(new))
    changed = Counter()
    examples = {}

    for k in sorted(set(old) & set(new)):
        for field in sorted(set(old[k]) | set(new[k])):
            if old[k].get(field) != new[k].get(field):
                changed[field] += 1
                examples.setdefault(field, (k, old[k].get(field), new[k].get(field)))

    print(f"records: baseline {len(old)}, current {len(new)}")
    print(f"added {len(added)}, removed {len(removed)}")
    for field, n in changed.most_common():
        k, o, v = examples[field]
        print(f"\nfield '{field}': {n} record(s) differ")
        print(f"  e.g. {k[0]} / {k[1]}")
        print(f"    OLD ...{str(o)[-90:]!r}")
        print(f"    NEW ...{str(v)[-90:]!r}")

    problems = []
    if added:
        problems.append(f"{len(added)} record(s) added: {added[:5]}")
    if removed:
        problems.append(f"{len(removed)} record(s) removed: {removed[:5]}")
    for field, n in changed.items():
        if field not in args.expect_field:
            problems.append(f"unexpected change in field '{field}' ({n} records)")
        elif args.max_changed is not None and n > args.max_changed:
            problems.append(f"field '{field}' changed in {n} records, max {args.max_changed}")

    if problems:
        print("\nREGRESSION:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("\nOK — no unintended changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
