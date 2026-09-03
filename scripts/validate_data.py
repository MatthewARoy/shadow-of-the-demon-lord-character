#!/usr/bin/env python3
"""Sanity-check the generated data files against each other.

The parse_* scripts are heuristic text extractors; a small regression (a
heading absorbed into a description, a spell block skipped, a renamed key)
can slip into the committed JSON without anything crashing. This script makes
those regressions loud: it asserts the expected corpus counts and that every
cross-file reference resolves back to data/spells.json.

Runs offline against data/ only — no PDFs or cache needed — so it works in
any checkout. Wired into `npm test`; run directly with:

    python3 scripts/validate_data.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Corpus sizes as parsed from the four rulebooks. If a parser or the source
# text changes these on purpose, update them here in the same commit.
EXPECTED_SPELLS_BY_SOURCE = {"core": 331, "occult": 762, "terrible": 28,
                             "dlc2": 44}
EXPECTED_SPELL_COUNT = sum(EXPECTED_SPELLS_BY_SOURCE.values())  # 1165
EXPECTED_PATH_COUNT = 177
EXPECTED_TRADITION_COUNT = 42
EXPECTED_ANCESTRIES_BY_SOURCE = {"core": 6, "terrible": 3, "dlc2": 6}
EXPECTED_ANCESTRY_COUNT = sum(EXPECTED_ANCESTRIES_BY_SOURCE.values())

# Character slot IDs resolve positionally into these files, so an exported
# character is only exactly replayable against the same snapshot of them.
# Share links and file exports carry this stamp; the app warns on mismatch.
REVISION_FILES = ["curated.json", "spells.json", "paths.json",
                  "traditions.json", "equipment.json", "creatures.json"]

failures = []


def fail(msg):
    failures.append(msg)


def load(name):
    return json.load(open(DATA / name))


def compute_revision():
    h = hashlib.sha256()
    for name in REVISION_FILES:
        h.update(name.encode())
        h.update(b"\0")
        h.update((DATA / name).read_bytes())
    return h.hexdigest()[:12]


def check_revision():
    rev = compute_revision()
    path = DATA / "revision.json"
    if "--write-revision" in sys.argv:
        path.write_text(json.dumps({"rev": rev}) + "\n")
        print(f"wrote data/revision.json (rev {rev})")
        return
    try:
        committed = json.load(open(path)).get("rev")
    except (FileNotFoundError, json.JSONDecodeError):
        committed = None
    if committed != rev:
        fail(f"revision.json: committed stamp {committed!r} != computed {rev!r} — "
             "run: python3 scripts/validate_data.py --write-revision")


def spell_key(s):
    return f"{s['name']}|{s['tradition']}".lower()


def check_spells(spells):
    if len(spells) != EXPECTED_SPELL_COUNT:
        fail(f"spells.json: expected {EXPECTED_SPELL_COUNT} spells, got {len(spells)}")
    by_source = {}
    for s in spells:
        by_source[s.get("source")] = by_source.get(s.get("source"), 0) + 1
    for source, want in EXPECTED_SPELLS_BY_SOURCE.items():
        got = by_source.get(source, 0)
        if got != want:
            fail(f"spells.json: expected {want} {source} spells, got {got}")
    for s in spells:
        name = s.get("name") or "<unnamed>"
        for field in ("name", "tradition", "type", "description", "source"):
            if not s.get(field):
                fail(f"spells.json: {name}: missing/empty {field!r}")
        if not isinstance(s.get("rank"), int) or not (0 <= s["rank"] <= 10):
            fail(f"spells.json: {name}: bad rank {s.get('rank')!r}")
    keys = [spell_key(s) for s in spells]
    dupes = {k for k in keys if keys.count(k) > 1}
    if dupes:
        fail(f"spells.json: duplicate name|tradition keys: {sorted(dupes)}")
    return set(keys)


def check_traditions(traditions, spells):
    if len(traditions) != EXPECTED_TRADITION_COUNT:
        fail(f"traditions.json: expected {EXPECTED_TRADITION_COUNT} traditions, got {len(traditions)}")
    spell_traditions = {s["tradition"] for s in spells}
    for t in traditions:
        if t["name"] not in spell_traditions:
            fail(f"traditions.json: tradition {t['name']!r} has no spells in spells.json")
    # Spell traditions outside traditions.json must be path pseudo-traditions
    # (path-granted spells use the path name as the tradition slot).
    known = {t["name"] for t in traditions}
    for s in spells:
        if s["tradition"] not in known and not s.get("path_spell"):
            fail(f"spells.json: {s['name']}: tradition {s['tradition']!r} not in "
                 f"traditions.json and not flagged path_spell")


def check_paths(paths, spells):
    if len(paths) != EXPECTED_PATH_COUNT:
        fail(f"paths.json: expected {EXPECTED_PATH_COUNT} paths, got {len(paths)}")
    spell_names = {s["name"].lower() for s in spells}
    for p in paths:
        for level, entry in (p.get("levels") or {}).items():
            magic = entry.get("magic") if isinstance(entry, dict) else None
            for grant in (magic or {}).get("grants", []):
                if grant.lower() not in spell_names:
                    fail(f"paths.json: {p['name']} level {level}: granted spell "
                         f"{grant!r} not found in spells.json")


def check_curated(curated):
    ancestries = curated.get("ancestries") or []
    if len(ancestries) != EXPECTED_ANCESTRY_COUNT:
        fail(f"curated.json: expected {EXPECTED_ANCESTRY_COUNT} ancestries, "
             f"got {len(ancestries)}")
    names = [a.get("name") for a in ancestries]
    dupes = {name for name in names if names.count(name) > 1}
    if dupes:
        fail(f"curated.json: duplicate ancestry names: {sorted(dupes)}")
    by_source = {}
    for ancestry in ancestries:
        name = ancestry.get("name") or "<unnamed>"
        source = ancestry.get("source")
        by_source[source] = by_source.get(source, 0) + 1
        creation = ancestry.get("creation") or {}
        for field in ("attributes", "size", "speed", "languages_professions", "traits"):
            if field not in creation:
                fail(f"curated.json: {name}: creation missing {field!r}")
        if set(creation.get("attributes") or {}) != {"strength", "agility", "intellect", "will"}:
            fail(f"curated.json: {name}: incomplete starting attributes")
        if not ancestry.get("level4"):
            fail(f"curated.json: {name}: missing level 4 benefits")
    for source, want in EXPECTED_ANCESTRIES_BY_SOURCE.items():
        if by_source.get(source, 0) != want:
            fail(f"curated.json: expected {want} {source} ancestries, "
                 f"got {by_source.get(source, 0)}")


def check_scores(scores, spell_keys):
    for key in scores.get("spells", {}):
        if key not in spell_keys:
            fail(f"spell-scores.json: key {key!r} does not resolve to spells.json")


def check_enrichment(enrichment, spell_keys):
    for key in enrichment:
        if key not in spell_keys:
            fail(f"spell-enrichment.json: key {key!r} does not resolve to spells.json")
    missing = spell_keys - set(enrichment)
    if missing:
        fail(f"spell-enrichment.json: {len(missing)} spells lack enrichment "
             f"(e.g. {sorted(missing)[:3]}) — re-run enrich_spells.py")


def check_combos(combos, spell_keys):
    def member(where, m):
        key = f"{m['name']}|{m['tradition']}".lower()
        if key not in spell_keys:
            fail(f"spell-combos.json: {where}: member {key!r} does not resolve to spells.json")

    for i, combo in enumerate(combos.get("combos", [])):
        for m in combo.get("members", []):
            member(f"combos[{i}] ({combo.get('goal')})", m)
    for goal, levers in combos.get("rosters", {}).items():
        for lever, members in levers.items():
            for m in members:
                member(f"rosters[{goal}][{lever}]", m)


def check_tag_sidecar(taxonomy, spells):
    counts = {}
    for s in spells:
        for t in s.get("tags", []):
            counts[t] = counts.get(t, 0) + 1
    for entry in taxonomy.get("tags", []):
        got = counts.get(entry["id"], 0)
        if entry.get("count") != got:
            fail(f"spell-tags.json: tag {entry['id']!r} count {entry.get('count')} "
                 f"!= {got} in spells.json — re-run tag_spells.py")


def main():
    check_revision()
    curated = load("curated.json")
    check_curated(curated)
    spells = load("spells.json")
    spell_keys = check_spells(spells)
    check_traditions(load("traditions.json"), spells)
    check_paths(load("paths.json"), spells)
    check_scores(load("spell-scores.json"), spell_keys)
    check_enrichment(load("spell-enrichment.json"), spell_keys)
    check_combos(load("spell-combos.json"), spell_keys)
    check_tag_sidecar(load("spell-tags.json"), spells)

    if failures:
        for f in failures:
            print(f"✗ {f}", file=sys.stderr)
        print(f"\n{len(failures)} data validation failure(s)", file=sys.stderr)
        sys.exit(1)
    print(f"✓ data OK — {len(spells)} spells "
          f"({', '.join(f'{v} {k}' for k, v in EXPECTED_SPELLS_BY_SOURCE.items())}), "
          f"{EXPECTED_PATH_COUNT} paths, {EXPECTED_TRADITION_COUNT} traditions, "
          f"{EXPECTED_ANCESTRY_COUNT} ancestries; "
          "scores/enrichment/combos/grants all resolve")


if __name__ == "__main__":
    main()
