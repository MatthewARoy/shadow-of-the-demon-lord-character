#!/usr/bin/env python3
"""Per-spell effectiveness scoring for the SotDL archive.

Reads data/spells.json and emits data/spell-scores.json: for each spell that has
a measurable output — damage dealt, health restored, damage mitigated, boons
granted — an expected value and where it sits among its peers. Re-run after
parse_spells.py / tag_spells.py. Deterministic and offline, like the tagger and
combo detector.

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

# A spell's *offensive* output is damage dealt to creatures. The rules text also
# states damage dealt to objects/structures ("objects … take 4d6 damage",
# "Objects in the area take 120 damage instead") and damage the caster pays
# ("You take 18 damage") — none of which is the spell's attack. We read the
# clause around each match and drop it when the thing taking the damage isn't a
# creature, so the `max` below can't be hijacked by a structure-collapse number.
_OBJ_SUBJ = re.compile(r"\b(?:object|structure|building|wall|door|bridge|gate|barrier|statue)s?\b")
_CREATURE_SUBJ = re.compile(r"\b(?:creatures?|targets?|everything|anything|enem(?:y|ies)|"
                            r"all(?:y|ies)|monsters?|characters?|demons?|undead|victims?)\b")
# Damage that only happens once a structure/object is destroyed is collateral,
# not the spell's own line (e.g. Earthquake's "everything inside or under it").
_DESTRUCT = re.compile(r"destroyed by (?:this|the) damage|destroys the object|"
                       r"collapses?,? and|when (?:it|the structure|the building) collapses|"
                       r"(?:object|structure) destroyed")
# Self-/sacrifice damage the caster pays ("You take 10d6 damage"). Checked on a
# short window ending at the match so it drops only that number, not a real
# attack stated in the same sentence ("You take 8 damage and … deal 8d6 damage").
# "take" (not "takes"): when *you* are the subject the verb is "you take"; the
# plural "you takes" only appears when you're an object ("each creature other
# than you takes …"), which is the target's damage, not the caster's cost.
_SELF_TAKE = re.compile(r"\byou\s+take\s+\d")


def _clause(description, start, end):
    """Return the clause containing a damage match."""
    begin = max(description.rfind(". ", 0, start),
                description.rfind("; ", 0, start),
                description.rfind("• ", 0, start),
                description.rfind(": ", 0, start)) + 1
    return description[begin:end]


def _is_creature_damage(description, start, end):
    if _SELF_TAKE.search(description[max(0, start - 16):end]):
        return False
    clause = _clause(description, start, end)
    if (_DESTRUCT.search(clause)
            or _DESTRUCT.search(description[end:end + 50])):
        return False
    if _OBJ_SUBJ.search(clause) and not _CREATURE_SUBJ.search(clause):
        return False
    return True


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
        if not _is_creature_damage(d, m.start(), m.end()):
            continue
        n, sides, flat = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        ev = dice_ev(n, sides, flat)
        if ev > best:
            best, detail = ev, f"{n}d{sides}" + (f"+{flat}" if flat else "")
    for m in DMG_FLAT.finditer(d):
        if not _is_creature_damage(d, m.start(), m.end()):
            continue
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


# --------------------------------------------------------------------------- #
# Boons. What the spell adds to a d20 roll, and whose roll it is.
#
# A boon is a d6 added to the roll, keeping the highest across all boon dice, so
# the expected swing is E[max(n d6)]: 1 boon is +3.50, but a 2nd adds only +0.97
# and a 3rd +0.49. Scoring the *swing* rather than the boon count is what stops
# "3 boons on one ally" outranking "1 boon on the whole party" — the count says
# the former is 3x better, the dice say it is 1.4x better on a single roll and
# worse the moment a second ally exists.
#
# Three kinds, kept apart because they answer different questions and must not
# share a cohort:
#   buff       boons handed to somebody else            (Blessing, Foretell)
#   self-buff  boons on the caster's own rolls          (Mighty Attack)
#   mark       the target grants boons to anyone
#              attacking it — a party buff worn by
#              the enemy                                (Saint Astrid's Flame)
#
# Breadth and upkeep ride along as flags, never folded into the number, exactly
# as `area` does for damage: one boon on five allies and one boon on yourself
# have the same swing and very different worth, and only the reader knows the
# party size. `multi`/`unlimited` say how many can receive it, `concentration`
# says whether holding it costs an action every round (core p49).
#
# Unlike the other kinds this gates on the rules keyword rather than a tag:
# "boon" is unambiguous mechanical vocabulary, whereas the reviewed buff-attack
# / buff-challenge tags reach only 125 of the 243 spells whose text mentions one.
# --------------------------------------------------------------------------- #

BOON_RX = re.compile(r"\b(?P<n>\d+|1d3|a number of)\s+boons?\b")

# A boon aiding whoever resists the spell being cast is the enemy's benefit.
# "to resist a spell's effect" (generic) stays in; "to resist your/that spell"
# and every "must get a success on ... with 1 boon" saving throw drops out.
BOON_RESIST = re.compile(r"must get a success on|to resist (?:your|that|this)\b")

BOON_SELF = re.compile(
    r"\byou (?:make|gain|receive|can make|impose|roll)\b"
    r"|grants? you \d+ boons?"
    r"|granting you \d+ boons?"
    r"|on your (?:attack|challenge|perception) rolls")

# The enemy carries the boon: everyone attacking it benefits.
BOON_MARK = re.compile(
    r"grants?\s+\d+\s+boons?\s+(?:on|to)[^.]*?(?:to attack it|against it"
    r"|against an affected target|against the target)"
    r"|attack rolls against it are made with \d+ boons?"
    r"|creatures? (?:make|attacking)[^.]*?against it[^.]*?\d+ boons?"
    r"|creatures? attacking the target[^.]*?\d+ boons?"
    r"|granting any creature that attacks[^.]*?\d+ boons?")

# Somebody else makes the roll.
BOON_OTHER = re.compile(
    r"\b(?:the |each |a )?targets? makes?\b"
    r"|\bit makes\b"
    r"|\bthe creature makes\b"
    r"|you (?:can )?grant (?:the|that|any|it)\b"
    r"|grant the triggering creature"
    r"|chosen creatures"
    r"|creatures? (?:in|within) the area makes?"
    r"|a creature that wears"
    r"|creatures? you choose"
    r"|rolls? made by creatures")
BOON_OTHER_WEAK = re.compile(r"\bthe target\b|\beach target\b")
# On an Attack spell the "other" is the enemy, so only an explicit hand-off counts.
BOON_GRANT = re.compile(r"you (?:can )?grant\b|grant the triggering creature")

BOON_ATK = re.compile(r"attack rolls?")
BOON_CHAL = re.compile(r"challenge rolls?|perception rolls?|rolls to resist")


def boon_swing(n):
    """Expected addition to a d20 from n boons: E[max(n d6)]."""
    return sum(k * ((k / 6) ** n - ((k - 1) / 6) ** n) for k in range(1, 7))


def clauses(text):
    """Sentences, bullet items, and conjoined independent clauses.

    Bullets because several spells list benefits that way; ", and " / "; "
    because one sentence often pairs a boon for you with a bane for everyone
    resisting you, and the resist guard must judge only the boon's own half.
    """
    for part in re.split(r"(?<=[.!?])\s+|\s*•\s*", text):
        part = part.strip()
        for seg in re.split(r",\s+and\s+|;\s+", part):
            seg = seg.strip()
            if seg:
                yield seg, part


def boon_count(token):
    """Boons named in the text -> (swing, expression). None swing = unreadable."""
    if token == "1d3":                      # Consequence: 1d3 boons
        return sum(boon_swing(n) for n in (1, 2, 3)) / 3, "1d3 boons"
    if token == "a number of":              # scales with an attribute or Size
        return None, "see text"             # same convention as the heal scorer
    n = int(token)
    return (boon_swing(n), f"{n} boon" + ("s" if n != 1 else "")) if 1 <= n <= 10 else (None, None)


def score_boons(spell):
    """Zero or more of buff / self-buff / mark, keeping the best of each kind."""
    desc = spell.get("description") or ""
    is_attack = spell.get("type") == "Attack"
    tgt = (spell.get("target") or spell.get("area") or "").lower()
    tags = spell.get("tags", [])
    dur = (spell.get("duration") or "").lower()

    # Description-level fallback for clauses that just say "the roll".
    doc_atk, doc_chal = bool(BOON_ATK.search(desc.lower())), bool(BOON_CHAL.search(desc.lower()))

    best = {}
    for clause, parent in clauses(desc):
        c = clause.lower()
        m = BOON_RX.search(c)
        if not m or BOON_RESIST.search(c):
            continue
        if re.search(r"boons? or banes?", c):   # Randomness, Impose Predictability
            continue

        # Whose roll is it? Read the boon's own segment first; a segment that
        # names no subject ("...and makes all Perception rolls with 2 boons")
        # inherits the sentence that introduced one ("A creature that wears...").
        subj = c
        if not (BOON_SELF.search(c) or BOON_MARK.search(c)
                or BOON_OTHER.search(c) or BOON_OTHER_WEAK.search(c)):
            ctx = parent.lower()
            if BOON_RESIST.search(ctx):
                continue
            subj = ctx

        if BOON_SELF.search(subj):
            kind = "self-buff"
        elif BOON_MARK.search(subj):
            kind = "mark"
        elif BOON_OTHER.search(subj) or BOON_OTHER_WEAK.search(subj):
            if is_attack and not BOON_GRANT.search(subj):
                continue                        # the "other" is the enemy
            kind = "buff"
        elif not is_attack and "creature" in tgt:
            kind = "buff"                       # unattributed boon on a touched ally
        else:
            continue

        swing, expr = boon_count(m.group("n"))
        if expr is None:
            continue
        atk, chal = bool(BOON_ATK.search(c)), bool(BOON_CHAL.search(c))
        if not atk and not chal:
            atk, chal = doc_atk, doc_chal

        rec = {
            "kind": kind,
            "value": round(swing, 2) if swing is not None else None,
            "unit": "boon-swing",
            "expr": expr,
            "flags": {
                "atk": atk,
                "chal": chal,
                "multi": bool(tgt.startswith("any number")
                              or re.search(r"up to |each |eight points", tgt)
                              or spell.get("area")
                              or "creatures you choose" in c
                              or "chosen creatures" in c) if kind != "self-buff" else False,
                "unlimited": tgt.startswith("any number"),
                "concentration": "concentration" in dur or "concentration" in tags,
                "area": "area" in tags,
            },
        }
        prev = best.get(kind)
        if prev is None or (rec["value"] or 0) > (prev["value"] or 0):
            best[kind] = rec
        elif prev["value"] == rec["value"]:     # same magnitude, wider coverage
            prev["flags"]["atk"] |= rec["flags"]["atk"]
            prev["flags"]["chal"] |= rec["flags"]["chal"]
    return list(best.values())


def score_spell(spell):
    # A spell can do several things; keep each measurable output.
    out = []
    for fn in (score_damage, score_heal, score_mitigation):
        r = fn(spell)
        if r:
            out.append(r)
    out.extend(score_boons(spell))
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
                     "of the caster's healing rate; %damage is reduction; temp-health is a buffer; "
                     "boon-swing is the expected addition to a d20, E[max(n d6)] — 1 boon 3.50, "
                     "2 boons 4.47, 3 boons 4.96.",
            "boons": "buff = boons given to someone else, self-buff = boons on your own rolls, "
                     "mark = the target grants boons to anyone attacking it. Breadth (multi, "
                     "unlimited) and upkeep (concentration) are flags, not multipliers: one boon "
                     "on five allies and one on yourself score the same swing, and only the reader "
                     "knows the party size. Rank a support spell on swing AND flags, never swing "
                     "alone, or Foretell's 3 boons on one ally will outrank Blessing's 1 on everyone.",
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
    for kind in ("damage", "heal", "mitigation", "buff", "self-buff", "mark"):
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
