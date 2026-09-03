#!/usr/bin/env python3
"""Semantic diff of data/paths.json against its reviewed baseline.

The path parser is vulnerable to failures that leave record counts intact:
lost first talents, truncated talent prose, and malformed magic choices. This
tool compares every path and every level, then exits successfully only when
all changed field categories were declared with --expect-field.
"""
import argparse
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(__file__)
BASELINE = os.path.join(HERE, "baseline", "paths.json")
CURRENT = os.path.join(HERE, "..", "data", "paths.json")


def load(path):
    with open(path) as f:
        records = json.load(f)
    keyed = {record["name"]: record for record in records}
    if len(keyed) != len(records):
        raise ValueError(f"duplicate path name in {path}")
    return keyed


def diff(old, new):
    """Return added names, removed names, and field-level change records."""
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changes = []

    def record(field, path, level, detail, before, after):
        changes.append({
            "field": field,
            "path": path,
            "level": level,
            "detail": detail,
            "old": before,
            "new": after,
        })

    for name in sorted(set(old) & set(new)):
        before_path, after_path = old[name], new[name]
        top_fields = (set(before_path) | set(after_path)) - {"name", "levels"}
        for field in sorted(top_fields):
            if before_path.get(field) != after_path.get(field):
                record(field, name, None, field,
                       before_path.get(field), after_path.get(field))

        before_levels = before_path.get("levels", {})
        after_levels = after_path.get("levels", {})
        for level in sorted(set(before_levels) | set(after_levels), key=int):
            if level not in before_levels or level not in after_levels:
                record("levels", name, level, "level presence",
                       before_levels.get(level), after_levels.get(level))
                continue

            before_level, after_level = before_levels[level], after_levels[level]
            level_fields = (set(before_level) | set(after_level)) - {"talents", "magic"}
            for field in sorted(level_fields):
                if before_level.get(field) != after_level.get(field):
                    record(field, name, level, field,
                           before_level.get(field), after_level.get(field))

            before_magic = before_level.get("magic", {}) or {}
            after_magic = after_level.get("magic", {}) or {}
            for field in sorted(set(before_magic) | set(after_magic)):
                if before_magic.get(field) != after_magic.get(field):
                    record(f"magic.{field}", name, level, field,
                           before_magic.get(field), after_magic.get(field))

            before_talents = before_level.get("talents", [])
            after_talents = after_level.get("talents", [])
            before_names = [talent.get("name") for talent in before_talents]
            after_names = [talent.get("name") for talent in after_talents]
            if before_names != after_names:
                record("talent_names", name, level, "ordered talent names",
                       before_names, after_names)

            before_by_name = {talent.get("name"): talent for talent in before_talents}
            after_by_name = {talent.get("name"): talent for talent in after_talents}
            for talent_name in sorted(set(before_by_name) & set(after_by_name)):
                before_talent = before_by_name[talent_name]
                after_talent = after_by_name[talent_name]
                if before_talent.get("text") != after_talent.get("text"):
                    record("talent_text", name, level, talent_name,
                           before_talent.get("text"), after_talent.get("text"))
                before_fields = {
                    k: v for k, v in before_talent.items()
                    if k not in {"name", "text"}
                }
                after_fields = {
                    k: v for k, v in after_talent.items()
                    if k not in {"name", "text"}
                }
                if before_fields != after_fields:
                    record("talent_fields", name, level, talent_name,
                           before_fields, after_fields)

    return added, removed, changes


def regression_problems(added, removed, changes, expected_fields,
                        max_changed=None):
    counts = Counter(change["field"] for change in changes)
    problems = []
    if added:
        problems.append(f"{len(added)} path(s) added: {added[:5]}")
    if removed:
        problems.append(f"{len(removed)} path(s) removed: {removed[:5]}")
    for field, count in counts.items():
        if field not in expected_fields:
            problems.append(f"unexpected change in field '{field}' ({count} values)")
        elif max_changed is not None and count > max_changed:
            problems.append(
                f"field '{field}' changed in {count} values, max {max_changed}"
            )
    return problems


def preview(value):
    text = str(value)
    return f"len={len(value)} ...{text[-90:]!r}" if isinstance(value, str) \
        else f"...{text[-90:]!r}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default=BASELINE,
                    help="reviewed paths JSON (default: scripts/baseline/paths.json)")
    ap.add_argument("--current", default=CURRENT,
                    help="paths JSON to check (default: data/paths.json)")
    ap.add_argument("--expect-field", action="append", default=[],
                    help="field category allowed to differ")
    ap.add_argument("--max-changed", type=int, default=None,
                    help="fail if an expected field changes in more values")
    args = ap.parse_args()

    try:
        old, new = load(args.baseline), load(args.current)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"cannot diff paths: {exc}", file=sys.stderr)
        return 2

    added, removed, changes = diff(old, new)
    counts = Counter(change["field"] for change in changes)
    examples = {}
    for change in changes:
        examples.setdefault(change["field"], change)

    print(f"records: baseline {len(old)}, current {len(new)}")
    print(f"added {len(added)}, removed {len(removed)}")
    for field, count in counts.most_common():
        example = examples[field]
        where = example["path"]
        if example["level"] is not None:
            where += f" / level {example['level']}"
        if example["detail"] != field:
            where += f" / {example['detail']}"
        print(f"\nfield '{field}': {count} value(s) differ")
        print(f"  e.g. {where}")
        print(f"    OLD {preview(example['old'])}")
        print(f"    NEW {preview(example['new'])}")

    problems = regression_problems(
        added, removed, changes, set(args.expect_field), args.max_changed
    )
    if problems:
        print("\nREGRESSION:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("\nOK — no unintended changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
