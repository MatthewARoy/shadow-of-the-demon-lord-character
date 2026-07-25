# Rules-Index Parser Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace typographic inference in `scripts/parse_rules_index.py` with declared document structure, so the Lookup tab stops returning mangled table rows; add a pipeline-wide parse-quality scanner; fix the same boundary-bleed defect in `parse_spells.py`.

**Architecture:** The parser currently guesses structure from line shape and gets it wrong five ways. We declare structure explicitly — boundary sentinels between ranges, content anchors for range ends, a table manifest keyed on caption text — and demote heuristics to a scanner that *reports* drift and fails the build, but never deletes. Lookup then serves gear from `equipment.json` in a separate result section rather than from reconstructed prose.

**Tech Stack:** Python 3.11 (stdlib only, `unittest`), Node 22 (stdlib only, `node:test`), vanilla ES modules. **The repo has zero runtime dependencies — do not add any.**

## Global Constraints

- **No new dependencies.** `package.json` has no `dependencies` or `devDependencies`. Use `unittest` and `node:test` from the standard libraries.
- **Never credit Claude/Anthropic** in any commit message, PR body, author, or trailer. See `CLAUDE.md`.
- **Scanners and validators report; they never modify or delete data.**
- **`scripts/cache/` and `*.pdf` are gitignored.** Anything that must run in a fresh clone reads only from committed `data/*.json` or committed fixtures.
- **Regenerating spells requires the two-step chain**: `parse_spells.py` then `tag_spells.py`. Running the parser alone silently strips the `tags` field from all 1,120 records.
- Python files use 4-space indent, `snake_case`. JS uses 2-space indent, `camelCase`, double-quoted strings.
- Commit after every task.

## Verified Starting State

Established before this plan was written — do not re-derive:

- `parse_spells.py` + `tag_spells.py` reproduces the committed `data/spells.json` **byte-for-byte** (sha256 `5d117a30ff821e6b…`, 1,120 records). The pipeline is deterministic and carries no un-reproducible hand edits.
- A baseline copy already exists at `scripts/baseline/spells.json`, uncommitted as of Task 1.
- `data/rules-index.json` has 547 chunks, 79 affected across five defect classes.
- The spells bleed is 11 records, one per tradition boundary.

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `scripts/baseline/spells.json` | Frozen human-verified spells snapshot for regression diffing | Create (Task 1) |
| `scripts/scan_parse_quality.py` | Pipeline-wide defect-signature scanner; reports, never deletes | Create (Task 2) |
| `scripts/parse_quality_baseline.json` | Known-acceptable scanner hits; gate compares against this | Create (Task 2) |
| `scripts/tests/test_scan_parse_quality.py` | Scanner unit tests | Create (Task 2) |
| `scripts/diff_spells.py` | Field-level differ, baseline vs current spells | Create (Task 3) |
| `scripts/parse_spells.py` | Spell parser — boundary-flush fix only | Modify (Task 3) |
| `scripts/fixtures/*.txt` | Committed page excerpts so parser tests run in a fresh clone | Create (Task 4) |
| `scripts/tests/test_parse_rules_index.py` | Rules-index parser unit tests | Create (Task 4), extend Tasks 5–9 |
| `scripts/table_manifest.py` | Declared table regions (pattern rules + literal entries) | Create (Task 7) |
| `scripts/parse_rules_index.py` | Rules-index chunker rework | Modify (Tasks 5–9) |
| `scripts/tests/test_rules_index_invariants.py` | Assertions against committed `data/rules-index.json` | Create (Task 10) |
| `js/ui/equipment-card.js` | Shared equipment card renderer, extracted from `gear.js` | Create (Task 11) |
| `js/ui/gear.js` | Armory catalog — consume shared renderer | Modify (Task 11) |
| `js/ui/lookup.js` | Gear result section, quotas, error handling | Modify (Task 12) |
| `js/ui/tests/lookup.test.mjs` | Lookup search-behaviour tests | Create (Task 12) |

---

### Task 1: Freeze the spells baseline

**Files:**
- Create: `scripts/baseline/spells.json` (copy of current `data/spells.json`)
- Create: `scripts/baseline/README.md`

**Interfaces:**
- Produces: a frozen 1,120-record snapshot at `scripts/baseline/spells.json` that Task 3 diffs against.

- [ ] **Step 1: Verify the working tree spells file is the committed one**

```bash
git diff --exit-code data/spells.json && echo "CLEAN"
```

Expected: prints `CLEAN`. If it does not, run `git checkout data/spells.json` first — the baseline must be the committed, human-verified state.

- [ ] **Step 2: Create the baseline copy**

```bash
mkdir -p scripts/baseline && cp data/spells.json scripts/baseline/spells.json
```

- [ ] **Step 3: Verify the copy is exact**

```bash
shasum -a 256 data/spells.json scripts/baseline/spells.json
```

Expected: both hashes are `5d117a30ff821e6bcef5381ae9e23f028efee3370d062918d025be85753e3f60`.

- [ ] **Step 4: Document why the baseline exists**

Create `scripts/baseline/README.md`:

```markdown
# Parser baselines

`spells.json` is a frozen copy of `data/spells.json` as it stood before the
2026-07 parser rework, after light human verification of spell content.

It exists so `scripts/diff_spells.py` can prove that a parser change alters
only what it intends to alter. Do not regenerate it to "fix" a diff — a
surprising diff is the signal it exists to produce.

Regenerating spells requires BOTH steps, in order:

    python3 scripts/parse_spells.py
    python3 scripts/tag_spells.py

Running the parser alone strips the `tags` field from all 1,120 records.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/baseline/
git commit -m "Freeze pre-rework spells baseline for regression diffing"
```

---

### Task 2: Parse-quality scanner

**Files:**
- Create: `scripts/scan_parse_quality.py`
- Create: `scripts/parse_quality_baseline.json`
- Create: `scripts/tests/test_scan_parse_quality.py`

**Interfaces:**
- Produces: `scan(data_dir) -> dict[str, list[Hit]]` where `Hit` is a dict with keys `file`, `path`, `signature`, `excerpt`. Tasks 9 and 10 call this. CLI exits 1 when hits are found that are absent from the baseline.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test_scan_parse_quality.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scan_parse_quality import SIGNATURES, scan_records


class TestSignatures(unittest.TestCase):
    def test_bleed_catches_trailing_tradition_header(self):
        s = "The target falls prone until the end of the round. Celestial Spells"
        self.assertTrue(SIGNATURES["bleed"](s))

    def test_bleed_catches_running_head_any_case(self):
        self.assertTrue(SIGNATURES["bleed"]("some text PLaying the Game more text"))

    def test_bleed_ignores_ordinary_prose(self):
        s = "The target falls prone until the end of the round."
        self.assertFalse(SIGNATURES["bleed"](s))

    def test_table_row_catches_price_run(self):
        s = "Axe 1 ss C Club 5 cp C Dagger 5 cp C Dart 1 cp C"
        self.assertTrue(SIGNATURES["table_row"](s))

    def test_table_row_catches_stat_header_remnant(self):
        self.assertTrue(SIGNATURES["table_row"]("Name. Damage. Hands. Properties."))

    def test_dice_table_catches_repeated_d20(self):
        self.assertTrue(SIGNATURES["dice_table"]("d20 Profession: d20 Profession: d20"))

    def test_ligature_catches_residual_artifact(self):
        self.assertTrue(SIGNATURES["ligature"]("the ŋghters advance"))

    def test_ligature_ignores_clean_text(self):
        self.assertFalse(SIGNATURES["ligature"]("the fighters advance"))

    def test_area_phrase_is_not_flagged(self):
        """Unpunctuated area/target phrases are valid data, not defects."""
        s = "A cylinder, 4 yards tall with a radius of 4 yards, centered on a point within long range"
        self.assertFalse(any(fn(s) for fn in SIGNATURES.values()))


class TestScanRecords(unittest.TestCase):
    def test_reports_signature_and_path(self):
        records = [{"name": "Moon Bridge", "description": "It ends. Conjuration Spells"}]
        hits = scan_records("spells.json", records)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["signature"], "bleed")
        self.assertEqual(hits[0]["file"], "spells.json")
        self.assertIn("description", hits[0]["path"])

    def test_clean_records_produce_no_hits(self):
        records = [{"name": "Fireball", "description": "It burns the target."}]
        self.assertEqual(scan_records("spells.json", records), [])

    def test_short_strings_are_skipped(self):
        records = [{"name": "d20", "description": "d20 d20 d20"}]
        self.assertEqual(scan_records("x.json", records), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest discover -s scripts/tests -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scan_parse_quality'`

- [ ] **Step 3: Implement the scanner**

Create `scripts/scan_parse_quality.py`:

```python
#!/usr/bin/env python3
"""Scan generated data/*.json for parser-defect signatures.

Reports only — never modifies data. Reads committed JSON, so it runs in a
fresh clone with no PDFs and no scripts/cache.

Signatures are tuned for recall; false positives are expected and absorbed
by scripts/parse_quality_baseline.json. The gate fails only on hits that are
not in that baseline.
"""
import json
import os
import re
import sys

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
BASELINE = os.path.join(os.path.dirname(__file__), "parse_quality_baseline.json")

FILES = [
    "rules-index.json", "spells.json", "paths.json",
    "traditions.json", "equipment.json", "creatures.json", "curated.json",
]

MIN_LEN = 16          # below this a string carries too little signal

RUNNING_HEADS = r"playing the game|character creation|traditions and spells|occult philosophy|terrible beauty"
LIGATURES = r"[ŋŊŌőŒ]|\bfi rst\b|ﬁ|ﬂ"

SIGNATURES = {
    # A trailing section/tradition header, or a running head anywhere.
    "bleed": lambda s: bool(
        re.search(r"\.\s+[A-Z][A-Za-z' ]{2,28} Spells$", s.strip())
        or re.search(r"(?i)\b(" + RUNNING_HEADS + r")\b", s)
    ),
    # Price runs and stat-table header remnants.
    "table_row": lambda s: bool(
        len(re.findall(r"\b\d+ (?:cp|ss|gc)\b", s)) > 3
        or re.search(r"(?:Name|Price|Avail)\.\s*(?:Damage|Hands|Avail|Price)", s)
        or re.search(r"\b\dd\d(?:\s*\+\s*\d)? (?:Off|One|Two)\b", s)
    ),
    # Random-table debris.
    "dice_table": lambda s: bool(
        len(re.findall(r"\bd20\b", s)) > 2
        or re.search(r"\b(?:d20|3d6|2d6)\s*$", s.strip())
    ),
    # Residual PDF ligature artifacts extract_text.py should have repaired.
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
    baseline = set()
    if os.path.exists(BASELINE):
        with open(BASELINE) as f:
            baseline = set(json.load(f)["accepted"])

    if "--update-baseline" in sys.argv:
        accepted = sorted(key(h) for hits in results.values() for h in hits)
        with open(BASELINE, "w") as f:
            json.dump({"accepted": accepted}, f, indent=1)
        print(f"baseline updated: {len(accepted)} accepted hits", file=sys.stderr)
        return 0

    new = []
    for name, hits in results.items():
        total = len(hits)
        unbaselined = [h for h in hits if key(h) not in baseline]
        new.extend(unbaselined)
        state = "clean" if not total else f"{total} hit(s), {len(unbaselined)} new"
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s scripts/tests -v`
Expected: 12 tests PASS.

- [ ] **Step 5: Record the current baseline**

```bash
python3 scripts/scan_parse_quality.py --update-baseline
python3 scripts/scan_parse_quality.py
```

Expected: the second command exits 0 and prints one line per file.

- [ ] **Step 6: Confirm the 11 spell bleeds are captured in the baseline**

```bash
python3 -c "
import json
b=json.load(open('scripts/parse_quality_baseline.json'))['accepted']
n=[k for k in b if k.startswith('spells.json') and k.endswith('bleed')]
print(f'spell bleed hits baselined: {len(n)}'); assert len(n)==11, n
print('OK')"
```

Expected: `spell bleed hits baselined: 11` then `OK`. These are removed from the baseline in Task 3 once fixed.

- [ ] **Step 7: Commit**

```bash
git add scripts/scan_parse_quality.py scripts/parse_quality_baseline.json scripts/tests/
git commit -m "Add pipeline-wide parse-quality scanner with baselined hits"
```

---

### Task 3: Fix the `parse_spells.py` boundary bleed

The break test at `parse_spells.py:123` compares a line against `tradition_names`, which holds bare names like `Celestial`. The actual boundary line in the source is `Celestial Spells`, so it never matches and the heading is absorbed into the preceding spell's description.

**Files:**
- Create: `scripts/diff_spells.py`
- Modify: `scripts/parse_spells.py:123`
- Modify: `scripts/parse_quality_baseline.json`

**Interfaces:**
- Consumes: `scripts/baseline/spells.json` from Task 1; `scan()` from Task 2.
- Produces: `scripts/diff_spells.py` CLI printing a field-level diff and exiting 1 on any change outside an allowlist.

- [ ] **Step 1: Write the differ**

Create `scripts/diff_spells.py`:

```python
#!/usr/bin/env python3
"""Field-level diff of data/spells.json against the frozen baseline.

Exit 0 only when every difference is an intended one. Intended changes are
declared with --expect-field; anything else is a regression.
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
    ap.add_argument("--expect-field", action="append", default=[],
                    help="field name allowed to differ")
    ap.add_argument("--max-changed", type=int, default=None,
                    help="fail if more than this many records changed")
    args = ap.parse_args()

    old, new = load(BASELINE), load(CURRENT)
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
```

- [ ] **Step 2: Verify the differ reports no change against an untouched tree**

```bash
python3 scripts/diff_spells.py
```

Expected: `records: baseline 1120, current 1120`, `added 0, removed 0`, then `OK — no unintended changes`.

- [ ] **Step 3: Apply the parser fix**

In `scripts/parse_spells.py`, replace the section-boundary test (currently line 123):

```python
            if nxt in tradition_names or re.match(r"^Level \d+ ", nxt) \
               or re.match(r"^d\d+$", nxt) or nxt == "Story Development":
                break
```

with:

```python
            # A tradition's section heading reads "<Tradition> Spells", while
            # tradition_names holds the bare name, so strip the suffix before
            # testing. Without this the heading bleeds into the previous
            # spell's description — one defect per tradition boundary.
            heading = re.sub(r"\s+Spells$", "", nxt)
            if nxt in tradition_names or heading in tradition_names \
               or re.match(r"^Level \d+ ", nxt) \
               or re.match(r"^d\d+$", nxt) or nxt == "Story Development":
                break
```

- [ ] **Step 4: Regenerate spells using BOTH pipeline steps**

```bash
python3 scripts/parse_spells.py && python3 scripts/tag_spells.py
```

Expected: `1120 spells -> …` then `tagged 1120 spells (8 via overrides) -> …`.

Running only the first command strips `tags` from every record and the next step will fail.

- [ ] **Step 5: Verify only the intended field changed**

```bash
python3 scripts/diff_spells.py --expect-field description --max-changed 11
```

Expected: `added 0, removed 0`; `field 'description': 11 record(s) differ`; `OK — no unintended changes`.

If the count is not 11, or any other field appears, stop — the fix has a side effect.

- [ ] **Step 6: Verify the bleeds are gone**

```bash
python3 -c "
import json,re
sp=json.load(open('data/spells.json'))
bad=[s['name'] for s in sp if re.search(r'\s[A-Z][A-Za-z\' ]* Spells$', (s.get('description') or '').strip())]
print('remaining bled descriptions:', bad); assert not bad
print('OK')"
```

Expected: `remaining bled descriptions: []` then `OK`.

- [ ] **Step 7: Drop the now-fixed hits from the scanner baseline**

```bash
python3 scripts/scan_parse_quality.py --update-baseline
python3 -c "
import json
b=json.load(open('scripts/parse_quality_baseline.json'))['accepted']
n=[k for k in b if k.startswith('spells.json') and k.endswith('bleed')]
print(f'spell bleed hits remaining: {len(n)}'); assert not n
print('OK')"
```

Expected: `spell bleed hits remaining: 0` then `OK`.

- [ ] **Step 8: Commit**

```bash
git add scripts/parse_spells.py scripts/diff_spells.py scripts/parse_quality_baseline.json data/spells.json
git commit -m "Fix tradition-header bleed into final spell of each tradition

collect_tradition_names() yields bare names ('Celestial') but the section
heading in the source reads 'Celestial Spells', so the boundary test never
matched and the heading was absorbed into the preceding spell's
description. Affected 11 spells, one per tradition boundary.

Adds scripts/diff_spells.py, which proves the regenerated file differs from
the frozen baseline only in the 11 intended descriptions."
```

---

### Task 4: Test fixtures and the rules-index test harness

**Files:**
- Create: `scripts/fixtures/core_p26_professions.txt`
- Create: `scripts/fixtures/core_p53_situational_banes.txt`
- Create: `scripts/fixtures/core_p104_weapons.txt`
- Create: `scripts/fixtures/core_p116_magic_to_spells.txt`
- Create: `scripts/fixtures/occult_p6_intro.txt`
- Create: `scripts/fixtures/README.md`
- Create: `scripts/tests/test_parse_rules_index.py`

**Interfaces:**
- Produces: `load_fixture(name) -> str` and `chunk_fixture(name, **kw) -> list[dict]` helpers used by Tasks 5–9.

- [ ] **Step 1: Extract the fixture pages**

Fixtures must contain the `===PAGE N===` markers so the parser sees real page structure.

```bash
mkdir -p scripts/fixtures
python3 - <<'PY'
import re, os
FIX = "scripts/fixtures"
WANT = [
    ("core", 26, "core_p26_professions.txt"),
    ("core", 53, "core_p53_situational_banes.txt"),
    ("core", 104, "core_p104_weapons.txt"),
    ("core", 116, "core_p116_magic_to_spells.txt"),
    ("occult", 6, "occult_p6_intro.txt"),
]
for book, page, out in WANT:
    txt = open(f"scripts/cache/{book}.txt").read()
    parts = re.split(r"===PAGE (\d+)===", txt)
    pm = {int(parts[i]): parts[i + 1] for i in range(1, len(parts) - 1, 2)}
    with open(os.path.join(FIX, out), "w") as f:
        f.write(f"===PAGE {page}===\n{pm[page]}")
    print(f"{out}: {len(pm[page])} chars")
PY
```

Expected: five files written, each a few thousand characters.

This step requires `scripts/cache/`, which is gitignored — it runs once, by a maintainer who has the PDFs. The resulting fixtures are committed so everyone else can run the tests.

- [ ] **Step 2: Document the fixtures**

Create `scripts/fixtures/README.md`:

```markdown
# Parser test fixtures

Committed excerpts of the extracted rulebook text, one page each, chosen
because each exercises a specific parser defect:

| Fixture | Exercises |
|---|---|
| `core_p26_professions.txt` | d20 profession tables misread as headings |
| `core_p53_situational_banes.txt` | the Situational Banes table; end of the ch.2 range |
| `core_p104_weapons.txt` | weapon stat tables — the reported "sling" bug |
| `core_p116_magic_to_spells.txt` | the magic-rules to spell-list transition |
| `occult_p6_intro.txt` | the start of the Occult Philosophy range |

`scripts/cache/` and the source PDFs are gitignored, so tests cannot
regenerate these. They exist so the parser suite runs in a fresh clone.
Regenerate them only with Task 4 Step 1 of the rework plan, and only when
the extraction changes.
```

- [ ] **Step 3: Write the harness and its first tests**

Create `scripts/tests/test_parse_rules_index.py`:

```python
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
FIXTURES = os.path.join(HERE, "..", "fixtures")

import parse_rules_index as p


def load_fixture(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return f.read()


def lines_from(text, book="core"):
    """Mimic lines_in_ranges() output for a fixture string."""
    import re
    page = 0
    for raw in text.split("\n"):
        s = raw.rstrip()
        m = re.match(r"^===PAGE (\d+)===$", s.strip())
        if m:
            page = int(m.group(1))
            continue
        yield book, page, s


class TestFixtures(unittest.TestCase):
    def test_all_fixtures_present_and_page_marked(self):
        for name in os.listdir(FIXTURES):
            if not name.endswith(".txt"):
                continue
            text = load_fixture(name)
            self.assertTrue(text.startswith("===PAGE "), f"{name} lacks a page marker")
            self.assertGreater(len(text), 500, f"{name} looks truncated")

    def test_weapons_fixture_contains_the_sling_row(self):
        self.assertIn("Sling", load_fixture("core_p104_weapons.txt"))


class TestIsHeading(unittest.TestCase):
    def test_accepts_a_real_heading(self):
        self.assertTrue(p.is_heading("Melee Attack Options"))

    def test_rejects_running_head_in_any_case(self):
        self.assertFalse(p.is_heading("PLaying the Game"))
        self.assertFalse(p.is_heading("Playing the Game"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest discover -s scripts/tests -v`

Expected: the fixture tests PASS; `test_rejects_running_head_in_any_case` FAILS on the `PLaying the Game` case — `RUNNING_HEADS` is matched exactly today. That failure is fixed in Task 9; leave it failing and note it.

- [ ] **Step 5: Commit**

```bash
git add scripts/fixtures/ scripts/tests/test_parse_rules_index.py
git commit -m "Add committed parser fixtures and rules-index test harness"
```

---

### Task 5: Boundary-aware iteration (defect A)

Fixes chunks spanning range gaps and books — the `Effect` chunk absorbing core p.100, and `EXPLOSIVE DARTS` absorbing Occult Philosophy p.6.

**Files:**
- Modify: `scripts/parse_rules_index.py:37-47` (`lines_in_ranges`), `:71-97` (`chunk`)
- Modify: `scripts/tests/test_parse_rules_index.py`

**Interfaces:**
- Produces: `lines_in_ranges()` yields `(book, page, line)` for content and the sentinel `(None, None, None)` at every range/book discontinuity. `chunk()` flushes its open chunk on each sentinel.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/test_parse_rules_index.py`:

```python
class TestBoundaryFlush(unittest.TestCase):
    def test_iterator_emits_a_sentinel_between_ranges(self):
        seq = list(p.lines_in_ranges())
        self.assertIn((None, None, None), seq,
                      "no boundary sentinel emitted between ranges")

    def test_sentinel_count_matches_range_count(self):
        seq = list(p.lines_in_ranges())
        sentinels = sum(1 for item in seq if item == (None, None, None))
        self.assertEqual(sentinels, len(p.RANGES),
                         "expected one sentinel per configured range")

    def test_no_chunk_spans_two_books(self):
        """A chunk from one book must not contain another book's prose."""
        chunks = p.chunk()
        occult_marker = "the inexhaustible wellspring that flows through all things"
        offenders = [c["t"] for c in chunks
                     if c["b"] == "core" and occult_marker in c["x"]]
        self.assertEqual(offenders, [], f"core chunks carrying occult text: {offenders}")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index.TestBoundaryFlush -v`
Expected: all three FAIL — no sentinel exists, and `EXPLOSIVE DARTS` carries occult text.

- [ ] **Step 3: Emit sentinels from the iterator**

Replace `lines_in_ranges` in `scripts/parse_rules_index.py`:

```python
BOUNDARY = (None, None, None)


def lines_in_ranges():
    """Yield (book, page, line) per content line, and BOUNDARY between ranges.

    Without an explicit boundary the chunker holds its open chunk across the
    gap, so the last section of one range absorbs the first prose of the
    next — including across books.
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
```

- [ ] **Step 4: Flush the open chunk on each sentinel**

In `chunk()`, replace the loop head:

```python
    for book, page, line in lines_in_ranges():
        s = line.strip()
        if furniture(s):
            continue
```

with:

```python
    for book, page, line in lines_in_ranges():
        if book is None:            # range/book boundary — close the open chunk
            if current:
                chunks.append(current)
                current = None
            continue
        s = line.strip()
        if furniture(s):
            continue
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index -v`
Expected: the three `TestBoundaryFlush` tests PASS. `test_rejects_running_head_in_any_case` still fails (Task 9).

- [ ] **Step 6: Commit**

```bash
git add scripts/parse_rules_index.py scripts/tests/test_parse_rules_index.py
git commit -m "Flush rules-index chunks at range and book boundaries"
```

---

### Task 6: Anchor-terminated ranges (defect E)

30 spell entries currently sit in the rules index because the range ends at page 118 while spell entries begin partway down page 116.

**Files:**
- Modify: `scripts/parse_rules_index.py:17-22` (`RANGES`), `lines_in_ranges`
- Modify: `scripts/tests/test_parse_rules_index.py`

**Interfaces:**
- Produces: `RANGES` entries become `(book, first_page, last_page, end_anchor_or_None)`. `end_anchor` is a compiled regex; iteration for that range stops at the first matching line.

- [ ] **Step 1: Write the failing test**

```python
class TestAnchorTerminatedRanges(unittest.TestCase):
    def test_no_chunk_title_matches_a_known_spell(self):
        import json
        here = os.path.dirname(__file__)
        with open(os.path.join(here, "..", "..", "data", "spells.json")) as f:
            spell_names = {s["name"].lower() for s in json.load(f)}
        offenders = sorted({c["t"] for c in p.chunk()
                            if c["t"].lower() in spell_names})
        self.assertEqual(offenders, [], f"spell entries in the rules index: {offenders}")

    def test_magic_rules_before_the_spell_list_are_retained(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertIn("Casting Spells", titles,
                      "the anchor cut too early and removed magic rules")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index.TestAnchorTerminatedRanges -v`
Expected: the first test FAILS listing ~30 spell names.

- [ ] **Step 3: Add the anchor to the range table**

```python
# A spell entry's header line is the tradition/type/rank line that follows an
# all-caps spell name, e.g. "AIR UTILITY 0". Page numbers cannot separate the
# generic magic rules at the top of core p.116 from the spell list lower on
# the same page, so this range ends on content instead.
SPELL_LIST_START = re.compile(r"^[A-Z][A-Z’'\- ]*\s+(ATTACK|UTILITY)\s+\d+\s*$")

# (book, first pdf page, last pdf page, end anchor or None)
RANGES = [
    ("core", 6, 53, None),         # ch1 character creation + ch2 playing the game
    ("core", 100, 118, SPELL_LIST_START),   # ch6 equipment + ch7 magic rules
    ("occult", 6, 12, None),       # restated/updated casting, learning, exchanging
]
```

- [ ] **Step 4: Honour the anchor during iteration**

In `lines_in_ranges`, change the unpack and add the stop test:

```python
    for book, lo, hi, end_anchor in RANGES:
        page = 0
        for raw in open(os.path.join(CACHE, f"{book}.txt")):
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
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index -v`
Expected: both `TestAnchorTerminatedRanges` tests PASS.

If `test_magic_rules_before_the_spell_list_are_retained` fails, the anchor matched too early — print the first matching line with:
`python3 -c "import sys;sys.path.insert(0,'scripts');import parse_rules_index as p;print([c['t'] for c in p.chunk()][-12:])"`

- [ ] **Step 6: Commit**

```bash
git add scripts/parse_rules_index.py scripts/tests/test_parse_rules_index.py
git commit -m "End the magic-rules range on a content anchor, not a page number

Spell entries begin partway down core p.116, so a page-numbered end leaked
30 spell records into the rules index — duplicating the Spells tab."
```

---

### Task 7: Declarative table manifest (defect B)

The reported "sling" bug and its ~70 siblings.

**Files:**
- Create: `scripts/table_manifest.py`
- Modify: `scripts/parse_rules_index.py` (`chunk`)
- Modify: `scripts/tests/test_parse_rules_index.py`

**Interfaces:**
- Produces: `in_table_block(book, line, prev_line, next_line, state) -> bool` and `TABLE_CAPTIONS`. `chunk()` skips lines inside a declared block. `unmanifested_table_rows(chunks) -> list[dict]` reports drift for Task 10.

- [ ] **Step 1: Write the failing test**

```python
class TestTableManifest(unittest.TestCase):
    def test_sling_is_not_a_section(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertNotIn("Sling", titles)
        self.assertNotIn("Trident", titles)
        self.assertNotIn("Whip", titles)

    def test_no_chunk_carries_a_weapon_stat_row(self):
        offenders = [c["t"] for c in p.chunk()
                     if "uses stones" in c["x"] or "Name. Damage. Hands." in c["x"]]
        self.assertEqual(offenders, [])

    def test_ancestry_random_tables_are_excluded(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Human Background", "Human Personality", "Dwarf Age", "Goblin Build"):
            self.assertNotIn(t, titles)

    def test_equipment_prose_sections_are_retained(self):
        """These have rules text that exists ONLY in the index."""
        titles = {c["t"] for c in p.chunk()}
        for t in ("Improvised Weapons", "Special Materials", "Living Expenses"):
            self.assertIn(t, titles, f"manifest over-deleted: lost {t}")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index.TestTableManifest -v`
Expected: the first three FAIL; the fourth PASSES (nothing is deleted yet).

- [ ] **Step 3: Write the manifest**

Create `scripts/table_manifest.py`:

```python
#!/usr/bin/env python3
"""Declared table regions in the indexed rulebook ranges.

The chunker cannot tell a table row from a heading — every row's first cell
looks like a short Title-Case line. Rather than guess, we declare where the
tables are and skip them; the structured data in data/equipment.json and
data/curated.json already carries their content.

Blocks are keyed on caption TEXT, not page number, so they survive
re-extraction of the PDFs.

A block starts at its caption and ends at the first line that is a heading
NOT itself part of the table (tracked by the caller's state machine).
"""
import json
import os
import re

DATA = os.path.join(os.path.dirname(__file__), "..", "data")

# Die-size line that follows a random table's caption.
DIE_LINE = re.compile(r"^(?:d20|d12|d10|d8|d6|3d6|2d6)$")

# Literal captions of the equipment/price/reference tables.
TABLE_CAPTIONS = {
    # ch.1
    "Profession Types", "Interesting Thing Tables",
    "Interesting Things Table 1", "Interesting Things Table 2",
    "Interesting Things Table 3", "Wealth",
    # ch.2
    "Movement by Pace", "Falling Damage", "Situational Banes",
    # ch.6
    "Lifestyle", "Clothing and Armor", "Ammunition",
    "Basic Melee Weapons", "Ranged Weapons", "Shields",
    "Military Melee Weapons", "Swift Melee Weapons", "Heavy Melee Weapons",
    "Clothing and Accessories", "Personal Gear", "Tools",
    "Food & Accommodations", "Animals and Animal Gear", "Hirelings",
    # ch.7
    "Castings", "Potion",
}

# Caption patterns. Each takes (caption, next_line) and returns True for a
# table header. The ancestry rule reads its name list from curated.json so it
# stays correct as ancestries or ranges change; the trait half is deliberately
# not enumerated, because the tail is irregular (Quirk, Purpose, Hatred, Odd
# Habit, Distinctive Appearance, Apparent Ancestry) and "followed by a die
# size" identifies a table header far more reliably than any name list.


def _ancestry_names():
    with open(os.path.join(DATA, "curated.json")) as f:
        return {a["name"] for a in json.load(f)["ancestries"]}


ANCESTRIES = _ancestry_names()


def is_table_caption(caption, next_line):
    caption, next_line = caption.strip(), (next_line or "").strip()
    if caption in TABLE_CAPTIONS:
        return True
    # "<Ancestry> <Trait>" immediately followed by a die size.
    first = caption.split()[0] if caption.split() else ""
    if first in ANCESTRIES and DIE_LINE.match(next_line):
        return True
    # "<Something> Professions"
    if re.match(r"^[A-Z][a-z]+ Professions$", caption):
        return True
    return False
```

- [ ] **Step 4: Skip declared blocks in `chunk()`**

In `scripts/parse_rules_index.py`, add the import and the state machine. Replace the heading branch inside `chunk()`:

```python
        if is_heading(s):
            if current:
                chunks.append(current)
            current = {"t": s, "b": book, "p": page, "x": ""}
            continue
```

with:

```python
        if is_heading(s):
            # A declared table caption opens a block: skip lines until the
            # next heading that is not itself part of a table.
            if is_table_caption(s, peek):
                if current:
                    chunks.append(current)
                    current = None
                in_table = True
                continue
            in_table = False
            if current:
                chunks.append(current)
            current = {"t": s, "b": book, "p": page, "x": ""}
            continue
        if in_table:
            continue
```

Add `from table_manifest import is_table_caption` at the top, initialise `in_table = False` alongside `current = None`, and materialise the line stream so `peek` is available:

```python
    stream = list(lines_in_ranges())
    for idx, (book, page, line) in enumerate(stream):
        peek = stream[idx + 1][2] if idx + 1 < len(stream) and stream[idx + 1][0] else ""
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index -v`
Expected: all four `TestTableManifest` tests PASS — including `test_equipment_prose_sections_are_retained`, which proves the manifest did not over-delete.

- [ ] **Step 6: Commit**

```bash
git add scripts/table_manifest.py scripts/parse_rules_index.py scripts/tests/test_parse_rules_index.py
git commit -m "Declare table regions instead of inferring them

Every table row's first cell looked like a heading, so each row became a
section whose body was the rest of its row plus the next table's header —
the reported 'sling' result. Captions are declared by text, not page, so
they survive re-extraction."
```

---

### Task 8: Remove `MIN_BODY` merging (defect C)

Recovers `Dazed`, `Rush`, `Disabled`, and `Dying`, which are currently glued onto their predecessors.

**Files:**
- Modify: `scripts/parse_rules_index.py:33` and `:89-97`
- Modify: `scripts/tests/test_parse_rules_index.py`

- [ ] **Step 1: Write the failing test**

```python
AFFLICTIONS = [
    "Asleep", "Blinded", "Charmed", "Compelled", "Dazed", "Deafened",
    "Defenseless", "Diseased", "Fatigued", "Frightened", "Grabbed",
    "Immobilized", "Impaired", "Poisoned", "Prone", "Slowed", "Stunned",
    "Surprised", "Unconscious",
]


class TestShortRulesSurvive(unittest.TestCase):
    def test_short_rules_are_independent_chunks(self):
        titles = {c["t"] for c in p.chunk()}
        for t in ("Dazed", "Rush", "Disabled", "Dying"):
            self.assertIn(t, titles, f"{t} was merged away by length")

    def test_all_nineteen_afflictions_resolve(self):
        titles = {c["t"] for c in p.chunk()}
        missing = [a for a in AFFLICTIONS if a not in titles]
        self.assertEqual(missing, [], f"missing afflictions: {missing}")

    def test_dazed_is_not_inside_compelled(self):
        compelled = [c for c in p.chunk() if c["t"] == "Compelled"]
        self.assertEqual(len(compelled), 1)
        self.assertNotIn("Dazed", compelled[0]["x"])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index.TestShortRulesSurvive -v`
Expected: all three FAIL. `Dazed`, `Rush`, `Disabled` do not exist as chunks.

- [ ] **Step 3: Delete the length-based merge**

Remove the `MIN_BODY` constant (line 33) and replace the merge block:

```python
    # Merge tiny chunks (mostly table cells misread as headings) into their
    # parent section; the heading text joins the body so it stays searchable.
    merged = []
    for c in chunks:
        c["x"] = re.sub(r"\s+", " ", c["x"]).strip()
        if merged and len(c["x"]) < MIN_BODY and merged[-1]["b"] == c["b"]:
            merged[-1]["x"] += f" {c['t']}: {c['x']}" if c["x"] else f" {c['t']}."
        else:
            merged.append(c)
```

with:

```python
    # Table cells are excluded by the manifest before headings are built, so
    # a short body no longer implies a table cell. Length-based merging used
    # to swallow real rules — "Dazed: A dazed creature cannot use actions."
    # is 41 characters and a complete affliction entry.
    merged = []
    for c in chunks:
        c["x"] = re.sub(r"\s+", " ", c["x"]).strip()
        if c["x"]:
            merged.append(c)
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index -v`
Expected: all three `TestShortRulesSurvive` tests PASS, and every earlier test still passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/parse_rules_index.py scripts/tests/test_parse_rules_index.py
git commit -m "Stop merging short chunks into their predecessor

MIN_BODY treated any body under 60 characters as a table cell, deleting
Dazed, Rush, and Disabled as independent rules. Table cells are now handled
by the manifest, so the length proxy has no remaining job."
```

---

### Task 9: Heading reconstruction and normalisation (defect D)

**Files:**
- Modify: `scripts/parse_rules_index.py` (`is_heading`, `furniture`, `chunk`)
- Modify: `scripts/tests/test_parse_rules_index.py`

- [ ] **Step 1: Write the failing test**

```python
class TestHeadingReconstruction(unittest.TestCase):
    def test_multiline_headings_are_joined(self):
        titles = {c["t"] for c in p.chunk()}
        self.assertIn("Attack with a Melee Weapon", titles)
        self.assertIn("Attack with a Ranged Weapon", titles)

    def test_no_orphan_fragment_titles(self):
        bad = [c["t"] for c in p.chunk()
               if c["t"].split()[0].lower() in {"a", "an", "the", "to", "of", "with"}]
        self.assertEqual(bad, [], f"orphaned heading fragments: {bad}")

    def test_running_heads_do_not_leak_into_bodies(self):
        import re
        bad = [c["t"] for c in p.chunk()
               if re.search(r"(?i)\bplaying the game\b", c["x"])]
        self.assertEqual(bad, [], f"chunks carrying a running head: {bad}")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest scripts.tests.test_parse_rules_index.TestHeadingReconstruction -v`
Expected: all three FAIL — titles `a Melee Weapon` and `to Attack Rolls` exist, and `PLaying the Game` appears in 7 bodies.

- [ ] **Step 3: Normalise running heads case-insensitively**

```python
RUNNING_HEADS_LOWER = {h.lower() for h in RUNNING_HEADS}


def furniture(s):
    s = s.strip()
    return not s or re.match(r"^\d{1,3}$", s) or s.lower() in RUNNING_HEADS_LOWER or \
        re.match(r"^Chapter \d+:?$", s) or s.startswith("Rusty Shackleford")
```

And in `is_heading`, replace `if s in RUNNING_HEADS` with `if s.lower() in RUNNING_HEADS_LOWER`.

- [ ] **Step 4: Join continuation fragments**

A heading whose next line is also a heading candidate *and* begins with a lowercase article or preposition is a wrapped heading. Add before the heading branch in `chunk()`:

```python
CONTINUATION = re.compile(r"^(a|an|the|to|of|with|and|or|from)\b", re.I)


def join_wrapped_heading(s, peek):
    """'Attack with' + 'a Melee Weapon' is one heading split across lines."""
    peek = (peek or "").strip()
    if peek and CONTINUATION.match(peek) and is_heading_shape(peek):
        return f"{s} {peek}"
    return None
```

`is_heading_shape` is `is_heading` without the lowercase-start rejection — extract the shape test so both can use it. In `chunk()`, when a heading is detected:

```python
        if is_heading(s):
            joined = join_wrapped_heading(s, peek)
            if joined:
                s = joined
                skip_next = True
```

and honour `skip_next` at the top of the loop body.

- [ ] **Step 5: Run to verify the tests pass**

Run: `python3 -m unittest discover -s scripts/tests -v`
Expected: every test in the suite passes, including `test_rejects_running_head_in_any_case` from Task 4.

- [ ] **Step 6: Commit**

```bash
git add scripts/parse_rules_index.py scripts/tests/test_parse_rules_index.py
git commit -m "Join wrapped headings and normalise running heads by case

'Attack with / a Melee Weapon' produced a chunk titled 'a Melee Weapon';
'PLaying the Game' escaped the exact-match furniture set and leaked into
seven chunk bodies."
```

---

### Task 10: Regenerate the index and lock in invariants

**Files:**
- Modify: `data/rules-index.json` (regenerated)
- Create: `scripts/tests/test_rules_index_invariants.py`
- Modify: `package.json:6`
- Modify: `scripts/parse_quality_baseline.json`

**Interfaces:**
- Consumes: everything from Tasks 5–9.
- Produces: `npm test` runs the sample build, both Python suites, and the scanner gate.

- [ ] **Step 1: Regenerate the index**

```bash
python3 scripts/parse_rules_index.py
```

Expected: a chunk count and file size. The count will differ from 547 — table rows are gone, short rules are back.

- [ ] **Step 2: Write the invariant suite**

Create `scripts/tests/test_rules_index_invariants.py`. These run against committed JSON, so they work in a fresh clone with no PDFs:

```python
import json
import os
import re
import unittest

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "..", "data")

AFFLICTIONS = [
    "Asleep", "Blinded", "Charmed", "Compelled", "Dazed", "Deafened",
    "Defenseless", "Diseased", "Fatigued", "Frightened", "Grabbed",
    "Immobilized", "Impaired", "Poisoned", "Prone", "Slowed", "Stunned",
    "Surprised", "Unconscious",
]


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


class TestRulesIndexInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = load("rules-index.json")
        cls.titles = {c["t"] for c in cls.index}

    def test_no_table_row_wreckage(self):
        """The reported sling bug and its siblings."""
        bad = [c["t"] for c in self.index
               if re.search(r"\b\dd\d(?:\s*\+\s*\d)? (?:Off|One|Two)\b", c["x"])
               or "Name. Damage. Hands." in c["x"]
               or len(re.findall(r"\b\d+ (?:cp|ss|gc)\b", c["x"])) > 3]
        self.assertEqual(bad, [], f"table rows still in the index: {bad}")

    def test_no_spell_entries(self):
        spells = {s["name"].lower() for s in load("spells.json")}
        bad = sorted({c["t"] for c in self.index if c["t"].lower() in spells})
        self.assertEqual(bad, [])

    def test_no_cross_book_bleed(self):
        marker = "the inexhaustible wellspring that flows through all things"
        bad = [c["t"] for c in self.index if c["b"] == "core" and marker in c["x"]]
        self.assertEqual(bad, [])

    def test_no_running_head_in_any_body(self):
        bad = [c["t"] for c in self.index
               if re.search(r"(?i)\b(playing the game|character creation)\b", c["x"])]
        self.assertEqual(bad, [])

    def test_no_orphan_heading_fragments(self):
        bad = [c["t"] for c in self.index
               if c["t"].split()[0].lower() in {"a", "an", "the", "to", "of", "with"}]
        self.assertEqual(bad, [])

    def test_all_nineteen_afflictions_present(self):
        missing = [a for a in AFFLICTIONS if a not in self.titles]
        self.assertEqual(missing, [], f"missing: {missing}")

    def test_short_rules_present(self):
        for t in ("Dazed", "Rush", "Disabled", "Dying"):
            self.assertIn(t, self.titles)

    def test_prose_sections_retained(self):
        for t in ("Improvised Weapons", "Special Materials", "Living Expenses",
                  "Melee Attack Options", "Ranged Attack Options"):
            self.assertIn(t, self.titles, f"over-deleted: {t}")

    def test_every_chunk_has_required_fields(self):
        for c in self.index:
            for f in ("t", "b", "p", "x"):
                self.assertIn(f, c)
            self.assertTrue(c["x"].strip(), f"empty body: {c['t']}")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the invariants**

Run: `python3 -m unittest scripts.tests.test_rules_index_invariants -v`
Expected: all nine PASS. Any failure means a defect survived — fix the parser, do not weaken the assertion.

- [ ] **Step 4: Refresh the scanner baseline and confirm the index is clean**

```bash
python3 scripts/scan_parse_quality.py --update-baseline
python3 -c "
import json
b=json.load(open('scripts/parse_quality_baseline.json'))['accepted']
n=[k for k in b if k.startswith('rules-index.json')]
print(f'rules-index hits remaining: {len(n)}')
for k in n[:10]: print('  ', k)"
```

Expected: substantially fewer than the pre-rework count. Any remainder must be a justified false positive — inspect each before accepting.

- [ ] **Step 5: Wire everything into `npm test`**

In `package.json`, replace the `test` script:

```json
"test": "node scripts/build_samples.mjs && python3 -m unittest discover -s scripts/tests -t . -v && python3 scripts/scan_parse_quality.py && node --test js/ui/tests/"
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: samples build, all Python tests pass, the scanner exits 0. The `node --test` portion reports no test files until Task 12 — that is expected and does not fail the run.

- [ ] **Step 7: Commit**

```bash
git add data/rules-index.json scripts/tests/ scripts/parse_quality_baseline.json package.json
git commit -m "Regenerate rules index and lock in parser invariants

Nine assertions run against the committed JSON, so they work in a fresh
clone without the gitignored PDFs. npm test now covers the sample build,
both parser suites, and the parse-quality gate."
```

---

### Task 11: Extract the shared equipment card renderer

`js/ui/gear.js` already renders weapon/armor/gear stats in its Armory catalog. Lookup needs the same markup; duplicating it is how `equipment.json` and `rules-index.json` diverged in the first place.

**Files:**
- Create: `js/ui/equipment-card.js`
- Modify: `js/ui/gear.js` (catalog rendering)

**Interfaces:**
- Produces: `equipmentCard(item, opts)` returning an HTML string, and `equipmentKey(item)` returning `"<name>|<category-or-type>"`. Task 12 consumes both.

- [ ] **Step 1: Read the current catalog renderer**

Run: `grep -n "catalog\|weapons\|armor" js/ui/gear.js | head -30` and read the surrounding block. Reproduce its markup and class names exactly — this is a refactor, not a redesign.

- [ ] **Step 2: Create the shared module**

Create `js/ui/equipment-card.js`:

```javascript
// Shared renderer for equipment stat cards, used by the Gear armory and by
// Lookup search results. Equipment records live in data/equipment.json; the
// rules index deliberately no longer carries their table rows.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// data/equipment.json holds 171 records across weapons/armor/gear, and names
// are NOT unique — "Bastard sword or warhammer" appears twice with different
// stats. Identity is name + category/type.
export function equipmentKey(item) {
  return `${item.name}|${item.category || item.type || ""}`.toLowerCase();
}

export function equipmentCard(item, opts = {}) {
  const stats = [];
  if (item.damage) stats.push(["damage", item.damage]);
  if (item.hands) stats.push(["hands", item.hands]);
  if (item.defense) stats.push(["defense", item.defense]);
  if (item.properties) stats.push(["properties", item.properties]);
  if (item.price) stats.push(["price", item.price]);
  if (item.availability) stats.push(["avail.", item.availability]);

  return `
  <div class="talent equip-card">
    <b>${esc(item.name)}</b>
    <span class="src">${esc(item.category || item.type || "")}</span>
    ${item.requirement ? `<p class="small blood">Requires ${esc(item.requirement)}</p>` : ""}
    <dl class="equip-stats">
      ${stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
    </dl>
    ${opts.footer || ""}
  </div>`;
}
```

- [ ] **Step 3: Consume it from `gear.js`**

Add `import { equipmentCard } from "./equipment-card.js";` and replace the catalog's inline card markup with a call to `equipmentCard(item, { footer: addButtonHtml })`, keeping the existing "add to inventory" button as the `footer`.

- [ ] **Step 4: Verify the Gear tab is visually unchanged**

Start the preview and confirm the Armory renders as before, including the add buttons and the requirement lines.

```bash
npm run dev
```

Then open the Gear tab, switch between Weapons / Armor / Gear, and add an item to inventory.

- [ ] **Step 5: Commit**

```bash
git add js/ui/equipment-card.js js/ui/gear.js
git commit -m "Extract shared equipment card renderer from the Gear armory"
```

---

### Task 12: Lookup gear results, quotas, and error handling

**Files:**
- Modify: `js/ui/lookup.js` (`ensureIndex`, `runSearch`, rendering)
- Create: `js/ui/tests/lookup.test.mjs`

**Interfaces:**
- Consumes: `equipmentCard`, `equipmentKey` from Task 11; `rules.equipment` from `js/data.js`.
- Produces: `scoreGear(item, terms, phrase)` and `searchAll(index, gear, query) -> {rules, gear}`, both exported for tests.

- [ ] **Step 1: Write the failing test**

Create `js/ui/tests/lookup.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAll } from "../lookup.js";

const GEAR = [
  { name: "Sling", category: "Ranged Weapons", damage: "1d3", hands: "Off",
    properties: "Range (medium), uses stones", price: "5 cp", availability: "C" },
  { name: "Bastard sword or warhammer", category: "Heavy Melee Weapons",
    damage: "2d6", hands: "One", price: "1 gc", availability: "R" },
  { name: "Bastard sword or warhammer", category: "Military Melee Weapons",
    damage: "1d6+2", hands: "One", price: "5 ss", availability: "U" },
];

const RULES = [
  { t: "Dazed", b: "core", p: 42, x: "A dazed creature cannot use actions." },
  { t: "Improvised Weapons", b: "core", p: 105,
    x: "You can also attack with objects you find around you, such as a frying pan." },
];

test("sling returns a gear result", () => {
  const { gear } = searchAll(RULES, GEAR, "sling");
  assert.equal(gear.length, 1);
  assert.equal(gear[0].name, "Sling");
  assert.equal(gear[0].damage, "1d3");
});

test("both duplicate-named weapons survive as distinct results", () => {
  const { gear } = searchAll(RULES, GEAR, "bastard sword");
  assert.equal(gear.length, 2);
  assert.notEqual(gear[0].category, gear[1].category);
});

test("dazed returns the rule, not a gear card", () => {
  const { rules, gear } = searchAll(RULES, GEAR, "dazed");
  assert.equal(gear.length, 0);
  assert.equal(rules[0].t, "Dazed");
});

test("gear and rules are returned in separate buckets", () => {
  const res = searchAll(RULES, GEAR, "weapons");
  assert.ok(Array.isArray(res.rules));
  assert.ok(Array.isArray(res.gear));
});

test("an empty query returns nothing rather than everything", () => {
  const { rules, gear } = searchAll(RULES, GEAR, "   ");
  assert.equal(rules.length, 0);
  assert.equal(gear.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test js/ui/tests/`
Expected: FAIL — `searchAll` is not exported.

- [ ] **Step 3: Implement gear scoring and split search**

In `js/ui/lookup.js`, add the import and export the two functions. Gear records are short, so term-frequency scoring would always lose to long prose — score them on name and field matches instead, and keep the buckets separate:

```javascript
import { rules as ruleData } from "../data.js";
import { equipmentCard, equipmentKey } from "./equipment-card.js";

const GEAR_QUOTA = 5;
const RULES_QUOTA = 15;

export function scoreGear(item, terms, phrase) {
  const name = item.name.toLowerCase();
  const blob = [item.category, item.type, item.properties, item.requirement]
    .filter(Boolean).join(" ").toLowerCase();
  let s = 0, present = 0;
  for (const t of terms) {
    const inName = name.includes(t);
    const inBlob = blob.includes(t);
    if (inName || inBlob) present++;
    s += (inName ? 6 : 0) + (inBlob ? 2 : 0);
  }
  if (present !== terms.length) return 0;   // gear must match every term
  if (name === phrase) s += 20;
  else if (name.startsWith(phrase)) s += 8;
  return s;
}

export function searchAll(index, gear, query) {
  const q = (query || "").trim();
  if (!q) return { rules: [], gear: [] };
  const terms = tokenize(q);
  const phrase = q.toLowerCase();
  if (!terms.length) return { rules: [], gear: [] };

  const ruleHits = index
    .map((c) => ({ c, s: score(withLower(c), terms, phrase) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, RULES_QUOTA)
    .map((h) => h.c);

  const seen = new Set();
  const gearHits = gear
    .map((item) => ({ item, s: scoreGear(item, terms, phrase) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .filter((h) => {
      const k = equipmentKey(h.item);          // name+category: keeps both
      if (seen.has(k)) return false;           // Bastard sword variants
      seen.add(k);
      return true;
    })
    .slice(0, GEAR_QUOTA)
    .map((h) => h.item);

  return { rules: ruleHits, gear: gearHits };
}

function withLower(c) {
  return c.tl ? c : { ...c, tl: c.t.toLowerCase(), xl: c.x.toLowerCase() };
}

function allGear() {
  const e = ruleData.equipment || {};
  return [...(e.weapons || []), ...(e.armor || []), ...(e.gear || [])];
}
```

- [ ] **Step 4: Render the two sections and guard the citation**

In `runSearch`, render an Equipment section above Rules when `gear.length`, using `equipmentCard`. Guard the rules citation, which currently assumes `c.b` and `c.p` always exist:

```javascript
    const cite = c.b && c.p ? `<span class="src">${BOOKS[c.b]} · p.${c.p}</span>` : "";
```

- [ ] **Step 5: Add fetch error handling**

`ensureIndex` currently has none, so a failed fetch leaves the tab reading "Loading the law…" forever:

```javascript
function ensureIndex() {
  if (index) return Promise.resolve(index);
  if (!loading) {
    loading = fetch("data/rules-index.json")
      .then((r) => {
        if (!r.ok) throw new Error(`rules-index.json: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        index = data.map((c) => ({ ...c, tl: c.t.toLowerCase(), xl: c.x.toLowerCase() }));
        return index;
      })
      .catch((err) => {
        loading = null;              // allow a retry on the next render
        indexError = err;
        throw err;
      });
  }
  return loading;
}
```

Declare `let indexError = null;` beside `let index = null;`, and in `renderLookup` show the error state instead of a permanent loading message when `indexError` is set.

- [ ] **Step 6: Run the tests**

Run: `node --test js/ui/tests/`
Expected: all five PASS.

- [ ] **Step 7: Verify in the browser**

```bash
npm run dev
```

Open the Lookup tab and confirm: searching `sling` shows an Equipment card with damage `1d3`, hands `Off`, "Range (medium), uses stones", 5 cp, C — and **not** the old run-on text. Searching `dazed` returns the dazed rule as its own result. Searching `bastard sword` shows two distinct cards.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: sample build, Python suites, scanner gate, and JS tests all pass.

- [ ] **Step 9: Commit**

```bash
git add js/ui/lookup.js js/ui/tests/
git commit -m "Serve equipment from structured data in Lookup

Gear and rules are scored separately with per-kind quotas: a projected gear
record and a prose chunk both scored 26 on a title match, so one merged
ranking would have been decided by an arbitrary projection detail.
Identity is name+category, keeping both 'Bastard sword or warhammer'
variants. Adds the fetch error state ensureIndex never had."
```

---

## Self-Review

**Spec coverage.** Each spec section maps to a task: boundary-aware iteration → Task 5; anchor-terminated ranges → Task 6; table manifest → Task 7; `MIN_BODY` removal → Task 8; heading reconstruction → Task 9; parse-quality scanner → Task 2; `parse_spells.py` fix → Task 3; Lookup gear results, quotas, shared renderer, error handling → Tasks 11–12; fixtures and invariants → Tasks 4 and 10.

**Deliberately deferred**, matching the spec's out-of-scope section: the Combat quick reference tab (its own spec), and ARIA/tab-semantics remediation of pre-existing markup. New markup added in Tasks 11–12 uses semantic elements, but the existing tab bar is not retrofitted.

**Ordering rationale.** Task 1 freezes the baseline before anything can regenerate data. Task 2 builds the scanner before any parser change, so every later task has a regression gate. Task 3 is deliberately early: it is the smallest real fix, and it proves the whole baseline-diff-regenerate workflow on 11 records before the same workflow is trusted on the much larger rules-index rework.

**Known interaction.** Task 7's `chunk()` rewrite materialises the line stream into a list to provide `peek`. Task 9's wrapped-heading join depends on that same `peek`, so Task 7 must land first. Both are noted in their steps.
