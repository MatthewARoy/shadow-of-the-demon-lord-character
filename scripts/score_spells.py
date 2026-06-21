#!/usr/bin/env python3
"""Per-spell effectiveness scoring for the SotDL archive.

Reads data/spells.json and emits data/spell-scores.json: for each spell that has
a measurable output — damage dealt, health restored, damage mitigated — an
expected value and where it sits among its peers. Re-run after parse_spells.py /
tag_spells.py. Deterministic and offline, like the tagger and combo detector.

## What "efficient" means here (the modelling choices)

A raw number ("17.5 average damage") doesn't tell you if a spell is *good* — a
rank-7 spell should out-damage a rank-1. So the headline is a **rank-cohort
percentile**: a spell is scored against the other spells of the *same kind and
rank* (e.g. "this is a top-quartile rank-3 damage spell"). No assumptions about
target Defense or party size are needed, and per-rank over/under-performers fall
right out.

Three rules make the value comparable:

1. **Caster-scaled output is measured in units of the caster's stat**, not a
   guessed character. "Heals equal to your healing rate" is `1.0× rate`; "half
   your healing rate" is `0.5×`. Flat/dice heals are health points. Cohorts are
   therefore keyed by (kind, *unit*, rank) so we only ever compare like with
   like — rate-multiples against rate-multiples.
2. **Reliability and area are flags, not multipliers.** Damage is the expected
   value *assuming it lands*; `auto` (no attack roll — reliable) and `area`
   (multi-target upside) ride alongside as flags rather than being folded into a
   single blended number with baked-in hit-chance/target-count assumptions.
3. **Dice are expected values.** d6 = 3.5, d3 = 2, plus any flat bonus.

## Gating

Kind is gated on the reviewed tags from tag_spells.py — `damage`/`auto-damage`
for offense, `heal` for healing, `protection`/`defense-buff` for mitigation — so
this pass inherits that pass's accuracy review (e.g. defensive "takes half the
damage from all sources" is *not* counted as offense because it isn't tagged
`damage`). The regex then reads the magnitude out of the rules text.
"""

import json
import re
import argparse
import statistics
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
SPELLS = ROOT / "data" / "spells.json"
OUT = ROOT / "data" / "spell-scores.json"

DIE_EV = {3: 2.0, 6: 3.5, 20: 10.5}


def low(s):
    return (s.get("description") or "").lower()


def dice_ev(count, sides, flat=0):
    return count * DIE_EV.get(sides, (sides + 1) / 2) + flat


# --------------------------------------------------------------------------- #
# Damage. Expected damage of the spell's own attack, assuming it lands.
# --------------------------------------------------------------------------- #

DMG_DICE = re.compile(r"(\d+)d(\d+)(?:\s*\+\s*(\d+))?\s+damage")
DMG_FLAT = re.compile(r"takes?\s+(\d+)\s+damage")


def score_damage(spell):
    d = low(spell)
    tags = spell.get("tags", [])
    # Gate on the reviewed offense tags (or run open when the spell is untagged),
    # so self-/sacrifice damage and incidental "takes N damage" aren't counted.
    if tags and not ({"damage", "auto-damage"} & set(tags)):
        return None
    # Don't count "extra damage" (that's an attack *buff*, scored as a combo
    # lever, not the spell's own output) or self-/sacrifice damage to the caster.
    best = 0.0
    detail = None
    for m in DMG_DICE.finditer(d):
        pre = d[max(0, m.start() - 8):m.start()]
        if "extra" in pre:
            continue
        n, sides, flat = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        ev = dice_ev(n, sides, flat)
        if ev > best:
            best, detail = ev, f"{n}d{sides}" + (f"+{flat}" if flat else "")
    for m in DMG_FLAT.finditer(d):
        n = int(m.group(1))
        if n > best:
            best, detail = float(n), str(n)
    if best <= 0:
        return None
    tags = spell.get("tags", [])
    return {
        "kind": "damage",
        "value": round(best, 2),
        "unit": "damage",
        "expr": detail,
        "flags": {
            "auto": "auto-damage" in tags,          # no attack roll -> reliable
            "area": "area" in tags,                  # multi-target upside
            "attack": "auto-damage" not in tags and bool(spell.get("attack")),
        },
    }


# --------------------------------------------------------------------------- #
# Healing. Caster-scaled -> healing-rate units; otherwise health points.
# --------------------------------------------------------------------------- #

RATE_MULT = [
    (re.compile(r"(?:equal to )?twice (?:your|its) healing rate"), 2.0),
    (re.compile(r"(?:equal to )?(?:half|one-?half) (?:your|its) healing rate"), 0.5),
    (re.compile(r"(?:equal to )?(?:your|its) healing rate"), 1.0),
]
HEAL_DICE = re.compile(r"(?:heals?|regains?|restores?)\s+(?:damage equal to\s+)?(\d+)d(\d+)(?:\s*\+\s*(\d+))?")
HEAL_FLAT = re.compile(r"(?:heals?|regains?|restores?)\s+(?:damage equal to\s+)?(\d+)\s+(?:damage|health)")


def score_heal(spell):
    d = low(spell)
    tags = spell.get("tags", [])
    # Gate on the reviewed `heal` tag (or run open when untagged). Without this,
    # every "heals … " trigger phrase would mark a spell as a healer.
    if tags and "heal" not in tags:
        return None
    for rx, mult in RATE_MULT:
        if rx.search(d):
            return {"kind": "heal", "value": mult, "unit": "healing-rate",
                    "expr": f"{mult:g}× rate", "flags": {"area": "area" in spell.get("tags", [])}}
    best = 0.0
    detail = None
    for m in HEAL_DICE.finditer(d):
        n, sides, flat = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        ev = dice_ev(n, sides, flat)
        if ev > best:
            best, detail = ev, f"{n}d{sides}" + (f"+{flat}" if flat else "")
    for m in HEAL_FLAT.finditer(d):
        n = int(m.group(1))
        if n > best:
            best, detail = float(n), str(n)
    if best <= 0:
        if "heal" in tags:
            # Tagged heal whose amount we can't read (e.g. "regains all its
            # health"); record it with unknown magnitude so coverage is honest.
            return {"kind": "heal", "value": None, "unit": "health", "expr": "see text",
                    "flags": {"area": "area" in tags}}
        return None  # untagged and no parseable heal amount -> not a healer
    return {"kind": "heal", "value": round(best, 2), "unit": "health", "expr": detail,
            "flags": {"area": "area" in spell.get("tags", [])}}


# --------------------------------------------------------------------------- #
# Mitigation. What the spell stops from landing.
#   "half damage from all sources"   -> 50% reduction      (unit %damage)
#   "+N bonus to health" / temp HP   -> N health buffer     (unit temp-health)
# Defense bonuses live in the combo detector's `evade` goal (hit-avoidance),
# not here — this is the take-less-when-hit axis.
# --------------------------------------------------------------------------- #

def score_mitigation(spell):
    d = low(spell)
    tags = spell.get("tags", [])
    if "protection" in tags:
        if re.search(r"takes? half the damage|halve[s]? (?:the |all )?damage", d):
            return {"kind": "mitigation", "value": 50, "unit": "%damage", "expr": "half damage",
                    "flags": {"all_sources": "from all sources" in d}}
        m = re.search(r"reduce[sd]? the damage[^.]*by (\d+)", d)
        if m:
            return {"kind": "mitigation", "value": int(m.group(1)), "unit": "damage-reduced",
                    "expr": f"-{m.group(1)}/hit", "flags": {}}
        if re.search(r"takes? no damage", d):
            return {"kind": "mitigation", "value": 100, "unit": "%damage", "expr": "immune (conditional)", "flags": {}}
    if "defense-buff" in tags:
        m = re.search(r"\+?(\d+)\s*bonus to (?:your |its |the target['’]?s? )?health", d)
        if m:
            return {"kind": "mitigation", "value": int(m.group(1)), "unit": "temp-health",
                    "expr": f"+{m.group(1)} HP buffer", "flags": {}}
    return None


def score_spell(spell):
    # A spell can do several things; keep each measurable output.
    out = []
    for fn in (score_damage, score_heal, score_mitigation):
        r = fn(spell)
        if r:
            out.append(r)
    return out


# --------------------------------------------------------------------------- #
# Cohort percentiles: compare like with like — (kind, unit, rank).
# --------------------------------------------------------------------------- #

def percentile(value, peers):
    """Fraction of peers (same value counts as half) at or below `value`."""
    if not peers or value is None:
        return None
    below = sum(1 for p in peers if p < value)
    equal = sum(1 for p in peers if p == value)
    return round((below + 0.5 * equal) / len(peers), 3)


def build(spells):
    raw = {}  # key -> [score dicts]
    cohorts = defaultdict(list)  # (kind, unit, rank) -> [values]
    for s in spells:
        scores = score_spell(s)
        if not scores:
            continue
        # Lowercased to match spellKey() in js/data.js and the enrichment sidecar.
        key = f"{s['name']}|{s['tradition']}".lower()
        for sc in scores:
            sc["rank"] = s["rank"]
            if sc["value"] is not None:
                cohorts[(sc["kind"], sc["unit"], s["rank"])].append(sc["value"])
        raw[key] = scores

    cohort_summary = {}
    for (kind, unit, rank), vals in cohorts.items():
        cohort_summary[f"{kind}|{unit}|{rank}"] = {
            "n": len(vals),
            "median": round(statistics.median(vals), 2),
            "max": round(max(vals), 2),
        }

    out = {}
    for key, scores in raw.items():
        for sc in scores:
            peers = cohorts[(sc["kind"], sc["unit"], sc["rank"])]
            sc["cohort"] = f"{sc['kind']}|{sc['unit']}|rank{sc['rank']}"
            sc["cohort_n"] = len(peers)
            sc["percentile"] = percentile(sc["value"], peers)
        out[key] = scores

    return {
        "spells": out,
        "cohorts": cohort_summary,
        "notes": {
            "comparison": "percentile is within the spell's (kind, unit, rank) cohort — a "
                          "top-quartile rank-3 damage spell scores ~0.75. Compares like with like.",
            "units": "damage/health are expected points (d6=3.5, d3=2); healing-rate is a multiple "
                     "of the caster's healing rate; %damage is reduction; temp-health is a buffer.",
            "reliability": "Damage is the expected value assuming it lands. `auto` = no attack roll "
                           "(reliable); `area` = multi-target upside; `attack` = needs to hit. These "
                           "are flags, not folded into the number.",
        },
    }


def report(data):
    sp = data["spells"]
    by_kind = defaultdict(int)
    for scores in sp.values():
        for sc in scores:
            by_kind[sc["kind"]] += 1
    print(f"{len(sp)} spells scored — " + ", ".join(f"{k}: {n}" for k, n in sorted(by_kind.items())))
    for kind in ("damage", "heal", "mitigation"):
        rows = [(k.split("|")[0], sc) for k, scores in sp.items() for sc in scores
                if sc["kind"] == kind and sc["value"] is not None]
        rows.sort(key=lambda r: (r[1]["percentile"] or 0), reverse=True)
        print(f"\n  top {kind}:")
        for name, sc in rows[:6]:
            flags = ",".join(f for f, on in sc.get("flags", {}).items() if on)
            pct = f"{int(sc['percentile']*100)}th" if sc["percentile"] is not None else "—"
            print(f"    {pct:>5} pct  rank {sc['rank']}  {sc['value']}{sc['unit']!s:>14}  "
                  f"{name}{(' ['+flags+']') if flags else ''}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="print a summary, don't write")
    args = ap.parse_args()

    spells = json.loads(SPELLS.read_text())
    data = build(spells)
    if args.report:
        report(data)
        return
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['spells'])} spells scored")
    report(data)


if __name__ == "__main__":
    main()
