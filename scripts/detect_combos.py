#!/usr/bin/env python3
"""Combo detector for the SotDL spell archive.

Reads data/spells.json (+ optional data/spell-enrichment.json) and emits
data/spell-combos.json: a structured map of which spells stack with which, why,
and how *effectively*. Re-run after parse_spells.py / tag_spells.py.

The point is to answer build-crafting questions the per-spell tags can't:
"what do I cast together?" Tags say what a spell does in isolation; combos say
what compounds. The detector is deterministic and offline, same as the tagger:
same input -> same combos, diffable in git, no runtime model call.

## Model

Each spell is reduced to a set of **effect atoms** -- (goal, lever, magnitude,
side) -- re-derived from the rules text rather than read off the tags, so the
combo layer keeps working even as the tag vocabulary is reworked. A *goal* is a
fight-outcome you stack toward ("don't get hit"); a *lever* is one mechanical
way to push that goal ("raise Defense", "impose banes on attacks against you").

Two facts about SotDL dice drive the scoring:

1. **Boons and banes pool, and only the single highest d6 applies.** So a second
   source of banes on the same roll is worth far less than the first
   (E[max 1d6]=3.5, E[max 2d6]=4.47, E[max 3d6]=4.96). Stacking the *same*
   roll-lever diminishes hard.
2. **Flat bonuses add.** +2 Defense and +2 Defense is +4; "deal 1d6 extra" and
   "deal 2d6 extra" is +3d6. Stacking an *additive* lever is linear and good.

The consequence -- and the most effective-combo heuristic -- is that combining
*different* levers toward one goal compounds (raise your Defense AND impose banes
on attacks against you: one lifts the to-hit threshold, the other lowers their
roll, and neither hits the other's diminishing wall), while combining the same
roll-lever twice mostly wastes a casting. The detector ranks cross-lever combos
highest and tags same-roll-lever stacks as `diminishing`.

Co-activation is the other gate: a combo only pays off if you can have the
pieces up at once. Each spell gets a duration class; minute+/hour buffs are
*pre-castable* (set up before the fight, free on your combat turns), 1-round and
instant effects cost an action in the fight, and holding several concentration
spells is `fragile` (damage forces a challenge roll to keep each).
"""

import json
import re
import argparse
import itertools
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
SPELLS = ROOT / "data" / "spells.json"
ENRICH = ROOT / "data" / "spell-enrichment.json"
SCORES = ROOT / "data" / "spell-scores.json"
OUT = ROOT / "data" / "spell-combos.json"


# --------------------------------------------------------------------------- #
# Goals and levers: the synergy taxonomy.
#
# Boon/bane direction. A boon ADDS a d6 and always helps the roller; a bane
# SUBTRACTS a d6 and always hurts the roller. So whether a roll-lever is offence
# or defence depends entirely on *whose roll* carries it:
#   - DEFENCE: banes on the enemy's attack roll against you (they hit less), OR
#              boons on YOUR OWN challenge rolls (you resist effects).
#   - OFFENCE: boons on YOUR attack rolls (you hit more), OR
#              banes on the TARGET's rolls (they fail).
# The detector keys on the roll's owner, not on the word boon/bane.
#
# additive=True  -> flat bonuses that sum; stacking the same lever is GOOD.
# additive=False -> boon/bane roll-levers that pool to the highest die;
#                   stacking the same lever DIMINISHES, so prefer a cross-lever.
# --------------------------------------------------------------------------- #
GOALS = {
    "evade": {
        "label": "Don't get hit",
        "desc": "Make enemy attacks against you (or an ally) miss more often.",
        "levers": {
            "defense":        {"label": "Raise Defense",            "additive": True},
            "attacker-banes": {"label": "Banes on enemies' attacks against you", "additive": False},
            "concealment":    {"label": "Concealment / hard to target", "additive": True},
        },
    },
    "resist": {
        "label": "Shrug off effects",
        "desc": "Beat the spells, conditions and afflictions aimed at you. These make YOU roll "
                "to resist, so boons on your challenge rolls help — and cures clean up what lands.",
        "levers": {
            "resist-boons": {"label": "Boons on your challenge rolls", "additive": False},
            "cure":         {"label": "Cure / remove conditions",      "additive": True},
        },
    },
    "mitigate": {
        "label": "Take less when hit",
        "desc": "Reduce or absorb the damage that does land.",
        "levers": {
            "damage-reduction": {"label": "Reduce incoming damage", "additive": True},
            "buffer":           {"label": "Extra / temporary Health", "additive": True},
            "heal":             {"label": "In-fight healing",        "additive": True},
        },
    },
    "land-hits": {
        "label": "Land your attacks",
        "desc": "Raise your own attack accuracy, or soften a target so it's easier to hit.",
        "levers": {
            "self-attack-boons": {"label": "Boons on your attack rolls", "additive": False},
            "target-softening":  {"label": "Boons on attacks against the target", "additive": False},
        },
    },
    "boost-damage": {
        "label": "Hit harder",
        "desc": "Add to the damage of your weapon / unarmed attacks. Flat and dice bonuses add up.",
        "levers": {
            "extra-damage": {"label": "Extra weapon/unarmed damage", "additive": True},
        },
    },
    "suppress-enemy": {
        "label": "Blunt the enemy",
        "desc": "Cut an enemy's offense: banes on its own rolls, or deny its actions outright.",
        "levers": {
            "target-banes": {"label": "Banes on the target's rolls", "additive": False},
            "control":      {"label": "Stun / immobilize / slow", "additive": True},
        },
    },
}

# The unarmed/natural-weapon sub-axis the request named first: a melee-brawler
# build whose buffs all target the same attacks, so they genuinely pile up.
UNARMED_RX = re.compile(r"unarmed strike|natural weapon")


def low(s):
    return (s.get("description") or "").lower()


def nums(rx, text):
    return [int(m.group(1)) for m in re.finditer(rx, text)]


def first_dice(rx, text):
    """Sum of 'Nd6'-style magnitudes a pattern finds (extra-damage stacks)."""
    return [m.group(1) for m in re.finditer(rx, text)]


# --------------------------------------------------------------------------- #
# Effect extraction. Each returns (lever, magnitude_str) or None.
#
# Lever membership is *gated on the reviewed tags* from tag_spells.py (so we
# inherit that pass's accuracy review and its per-spell overrides) and the regex
# then supplies what the tags don't: the roll's owner — which the boon/bane tags
# can't tell apart but which decides offence vs defence (banes on the enemy's
# attack against you vs. banes on the target's own rolls; boons on your attack
# vs. boons on your challenge roll) — plus the Defense/Health magnitude and the
# extra-damage/unarmed split. If a spell is missing tags entirely (tagger not
# run, or vocabulary reworked elsewhere) the regex still stands on its own.
# Patterns are anchored on SotDL's standardized phrasing.
# --------------------------------------------------------------------------- #

def atom_defense(d):
    # "+N bonus to defense", "defense becomes N", "defense increases by N".
    # Exclude object/construct stat lines ("defense 5 and 100 health") and the
    # "defenseless" condition.
    if "defenseless" in d:
        return None
    m = re.search(r"\+?(\d+)(?:d6)?\s*bonus to (?:your |its |the target['’]?s? )?defense", d)
    if m:
        return ("defense", f"+{m.group(1)} Def")
    m = re.search(r"defense (?:score )?(?:becomes|increases? (?:by )?|equal to)\s*(\d+)?", d)
    if m and ("becomes" in m.group(0) or "increase" in m.group(0)):
        return ("defense", "Def set/up")
    return None


def atom_attacker_banes(d):
    # Defensive: banes land on the ENEMY's attack roll when it attacks you/the
    # warded target, so the attacker hits less. (The bane is on their roll.)
    if re.search(r"\battack rolls? (?:made )?against\b[^.]*?\b(\d+)\s*banes?", d) or \
       re.search(r"(\d+)\s*banes? on attack rolls? (?:made )?against", d) or \
       re.search(r"attacks? against (?:you|the target|it|them)[^.]*?with (\d+) banes?", d):
        n = nums(r"(\d+)\s*banes?", d)
        return ("attacker-banes", f"{max(n)} bane(s) on their attack" if n else "banes on their attack")
    return None


def atom_concealment(d, tags):
    if "concealment" in tags or re.search(r"invisible|total concealment|obscured by", d):
        return ("concealment", "concealment")
    return None


def atom_damage_reduction(d):
    if re.search(r"takes? half the damage[^.]*from all sources", d) or \
       re.search(r"halve[s]? (?:the |all )?damage", d) or \
       re.search(r"reduce[sd]? the damage[^.]*by", d) or \
       re.search(r"takes? no damage from", d):
        return ("damage-reduction", "reduce damage")
    return None


def atom_buffer(d):
    m = re.search(r"\+?(\d+)\s*bonus to (?:your |its |the target['’]?s? )?health", d)
    if m:
        return ("buffer", f"+{m.group(1)} Health")
    if re.search(r"gains? \d+ (?:temporary )?health|temporary health", d):
        return ("buffer", "temp Health")
    return None


def atom_heal(d, tags):
    if "heal" in tags and re.search(r"heals? (?:damage )?(?:equal to|\d)", d):
        return ("heal", "heal")
    return None


def atom_self_boons(d):
    # Your own / an ally's attack rolls gain boons for a duration (a granted
    # buff, plural "rolls"), not the spell's own single cast roll.
    if re.search(r"\battack rolls? (?:made )?with (\d+) boons?", d) and "against" not in d.split("boon")[0][-40:]:
        n = nums(r"(\d+)\s*boons?", d)
        return ("self-attack-boons", f"{max(n)} boon(s) to hit" if n else "boons to hit")
    if re.search(r"(\d+)\s*boons? on (?:your )?attack rolls", d):
        n = nums(r"(\d+)\s*boons?", d)
        return ("self-attack-boons", f"{max(n)} boon(s) to hit" if n else "boons to hit")
    return None


def atom_self_challenge_boons(d):
    # Defensive: boons on YOUR OWN challenge rolls. In SotDL you don't roll to
    # avoid an attack, but you do roll challenge rolls to resist spells,
    # conditions and afflictions — so boons here are a defensive (resist) lever,
    # the boon-side mirror of "banes on the enemy's attack".
    if re.search(r"challenge rolls? (?:made )?with (\d+) boons?", d) or \
       re.search(r"(\d+)\s*boons? on (?:your |its |the target['’]?s? )?(?:.{0,20} )?challenge rolls", d):
        n = nums(r"(\d+)\s*boons?", d)
        return ("resist-boons", f"{max(n)} boon(s) to resist" if n else "boons to resist")
    return None


def atom_target_softening(d):
    # Attacks against the target are made with boons (prone/blinded-style), which
    # helps everyone hit it.
    if re.search(r"attacks? (?:made )?against (?:it|the target|them)[^.]*?with (\d+) boons?", d):
        return ("target-softening", "boons to hit it")
    return None


def atom_extra_damage(d):
    dice = re.findall(r"(\d+d6) extra damage", d)
    flat = re.findall(r"\+(\d+) (?:bonus )?to damage", d)
    if dice or flat:
        parts = []
        if dice:
            parts.append("+" + "+".join(dice))
        if flat:
            parts.append("+" + "+".join(flat) + " dmg")
        return ("extra-damage", " ".join(parts))
    return None


def atom_target_banes(d):
    # Offensive: banes on the TARGET's own rolls (attack or challenge), reducing
    # its offense. Excludes the defensive "against you" form handled above.
    if atom_attacker_banes(d):
        return None
    if re.search(r"(?:makes|with) (?:.*?)?(\d+)\s*banes? on (?:its )?(?:attack|challenge) rolls", d) or \
       re.search(r"(\d+)\s*banes? on (?:all )?(?:its )?(?:attack|challenge) rolls", d) or \
       re.search(r"(?:attack|challenge) rolls? (?:made )?with (\d+) banes?", d):
        n = nums(r"(\d+)\s*banes?", d)
        return ("target-banes", f"{max(n)} bane(s) on its rolls" if n else "banes on its rolls")
    return None


def atom_control(d, tags):
    if "control" in tags:
        return ("control", "control")
    return None


# --------------------------------------------------------------------------- #
# Duration / co-activation classing.
# --------------------------------------------------------------------------- #

def duration_class(spell):
    dur = (spell.get("duration") or "").strip().lower()
    tags = spell.get("tags", [])
    if "triggered" in tags:
        return "triggered"
    if not dur:
        return "instant"
    if "concentration" in dur:
        return "concentration"
    if "permanent" in dur:
        return "permanent"
    if dur.startswith("1 round") or dur == "1 round":
        return "round"
    if re.search(r"minute|hour|day|rest|week|month|year", dur):
        return "sustained"
    return "instant"


def precastable(dclass):
    # Minute+ buffs you can put up before the fight; free on your combat turns.
    return dclass in ("sustained", "permanent")


def has(tags, *want):
    """True if the spell carries any of these reviewed tags, or carries no tags
    at all (so the detector still works on un-tagged input)."""
    return (not tags) or any(t in tags for t in want)


def effects(spell):
    d = low(spell)
    tags = spell.get("tags", [])
    atoms = []

    def add(goal, lever, mag):
        atoms.append({"goal": goal, "lever": lever, "magnitude": mag})

    # evade -------------------------------------------------------------------
    if has(tags, "defense-buff"):
        r = atom_defense(d)
        if r:
            add("evade", *r)
    if has(tags, "debuff-rolls"):
        r = atom_attacker_banes(d)   # defensive: banes on the enemy's attack
        if r:
            add("evade", *r)
    if has(tags, "concealment"):
        r = atom_concealment(d, tags)
        if r:
            add("evade", *r)

    # resist (boons on YOUR challenge rolls = the boon-side of defence) --------
    if has(tags, "buff-challenge"):
        r = atom_self_challenge_boons(d)
        if r:
            add("resist", *r)
    if "cure" in tags:
        add("resist", "cure", "cure")

    # mitigate ----------------------------------------------------------------
    # protection/heal map 1:1 to reviewed tags; trust them directly (the regex is
    # only a fallback when the spell is untagged).
    if "protection" in tags or (not tags and atom_damage_reduction(d)):
        add("mitigate", "damage-reduction", "reduce damage")
    if has(tags, "defense-buff"):
        r = atom_buffer(d)
        if r:
            add("mitigate", *r)
    if "heal" in tags or (not tags and atom_heal(d, tags)):
        add("mitigate", "heal", "heal")

    # land-hits ---------------------------------------------------------------
    if has(tags, "buff-attack"):
        r = atom_self_boons(d)
        if r:
            add("land-hits", *r)
    r = atom_target_softening(d)
    if r:
        add("land-hits", *r)

    # boost-damage (no precise tag; the regex is the gate) --------------------
    r = atom_extra_damage(d)
    if r:
        add("boost-damage", *r)

    # suppress-enemy ----------------------------------------------------------
    if has(tags, "debuff-rolls"):
        r = atom_target_banes(d)     # offensive: banes on the target's rolls
        if r:
            add("suppress-enemy", *r)
    if has(tags, "control"):
        r = atom_control(d, tags)
        if r:
            add("suppress-enemy", *r)

    return atoms


# --------------------------------------------------------------------------- #
# Build combos.
# --------------------------------------------------------------------------- #

def load_scores():
    """key -> {percentile, kind, value, unit} for the spell's best-scored output.
    Optional: if score_spells.py hasn't been run, combos just skip the quality
    signal. 'Best' = highest percentile among records with a real cohort (n>=3)."""
    if not SCORES.exists():
        return {}
    data = json.loads(SCORES.read_text())
    out = {}
    for k, recs in data.get("spells", {}).items():
        ranked = [r for r in recs if r.get("percentile") is not None and r.get("cohort_n", 0) >= 3]
        if not ranked:
            continue
        best = max(ranked, key=lambda r: r["percentile"])
        out[k] = {"percentile": best["percentile"], "kind": best["kind"],
                  "value": best["value"], "unit": best["unit"]}
    return out


def key(s):
    return f"{s['name']}|{s['tradition']}".lower()


_SCORES = {}  # key -> best score record; populated by build()


def short(s, atom, dclass):
    m = {
        "name": s["name"],
        "tradition": s["tradition"],
        "rank": s["rank"],
        "lever": atom["lever"],
        "magnitude": atom["magnitude"],
        "duration": dclass,
        "precast": precastable(dclass),
    }
    sc = _SCORES.get(f"{s['name']}|{s['tradition']}".lower())
    if sc:
        # The piece's individual strength for its rank (0..1), so showcases can
        # prefer combos built from spells that are good on their own merits.
        m["quality"] = sc["percentile"]
        m["strength"] = {"kind": sc["kind"], "value": sc["value"], "unit": sc["unit"]}
    return m


def _q(m):
    return m.get("quality") or 0.0


def _spellid(m):
    return (m["name"], m["tradition"])


def pick_pair(lever_a, lever_b):
    """Choose one spell from each lever for the showcase, never the same spell.
    Prefer a same-tradition pair (one caster can run both), then pre-castable,
    then the most accessible (lowest rank) so the example is one a real build
    reaches, not a rank-10 capstone."""
    best = None
    for ma in lever_a:
        for mb in lever_b:
            if _spellid(ma) == _spellid(mb):
                continue
            rank = (
                0 if ma["tradition"] == mb["tradition"] else 1,   # same-tradition first
                0 if (ma["precast"] and mb["precast"]) else 1,    # precastable first
                -round(_q(ma) + _q(mb), 3),                       # individually-stronger first
                ma["rank"] + mb["rank"],                          # accessible first
            )
            if best is None or rank < best[0]:
                best = (rank, ma, mb)
    return (best[1], best[2]) if best else (None, None)


def build(spells, scores=None):
    global _SCORES
    _SCORES = scores or {}
    # goal -> lever -> [member dicts]
    members = defaultdict(lambda: defaultdict(list))
    unarmed = {"damage": [], "accuracy": []}

    for s in spells:
        dclass = duration_class(s)
        d = low(s)
        for atom in effects(s):
            members[atom["goal"]][atom["lever"]].append(short(s, atom, dclass))
        if UNARMED_RX.search(d):
            ed = atom_extra_damage(d)
            if ed:
                unarmed["damage"].append(short(s, {"lever": "extra-damage", "magnitude": ed[1]}, dclass))
            sb = atom_self_boons(d)
            if sb:
                unarmed["accuracy"].append(short(s, {"lever": "self-attack-boons", "magnitude": sb[1]}, dclass))

    combos = []

    def feasibility(parts):
        conc = sum(1 for p in parts if p["duration"] == "concentration")
        all_precast = all(p["precast"] for p in parts)
        combat_actions = sum(1 for p in parts if not p["precast"])
        return {
            "fragile": conc >= 2,
            "all_precastable": all_precast,
            "combat_castings": combat_actions,
        }

    # --- Cross-lever combos within each goal (the compounding ones) --------- #
    for goal, gdef in GOALS.items():
        lev = members[goal]
        present = [l for l in gdef["levers"] if lev.get(l)]
        for a, b in itertools.combinations(present, 2):
            pa, pb = pick_pair(lev[a], lev[b])
            if not pa:
                continue  # only the same spell sits in both levers
            feas = feasibility([pa, pb])
            same_trad = pa["tradition"] == pb["tradition"]
            score = 60
            score += 25  # cross-lever: orthogonal, compounds
            score += 10 if same_trad else 0  # one caster can run both
            if feas["all_precastable"]:
                score += 15
            score -= 20 if feas["fragile"] else 0
            score -= 5 * max(0, feas["combat_castings"] - 1)
            # Reward pairs whose pieces are individually strong for their rank.
            scored = [m for m in (pa, pb) if m.get("quality") is not None]
            avg_q = sum(_q(m) for m in scored) / len(scored) if scored else None
            score += round(15 * avg_q) if avg_q is not None else 0
            strong = avg_q is not None and avg_q >= 0.66
            combos.append({
                "goal": goal,
                "type": "compounding",
                "levers": [a, b],
                "members": [pa, pb],
                "alternatives": {a: len(lev[a]), b: len(lev[b])},
                "score": score,
                "fragile": feas["fragile"],
                "all_precastable": feas["all_precastable"],
                "same_tradition": same_trad,
                "rationale": (
                    f"{gdef['levers'][a]['label']} + {gdef['levers'][b]['label']}: "
                    f"two different levers on “{gdef['label'].lower()}”, so they "
                    f"compound instead of fighting each other's diminishing returns."
                    + (" Both pieces are also strong for their rank." if strong else "")
                ),
            })

    # --- Same-lever stacks: additive = good, roll-pool = diminishing -------- #
    for goal, gdef in GOALS.items():
        for lever, ldef in gdef["levers"].items():
            roster = members[goal].get(lever, [])
            if len(roster) < 2:
                continue
            additive = ldef["additive"]
            top = sorted(roster, key=lambda m: (m["precast"], _q(m), m["rank"]), reverse=True)[:3]
            feas = feasibility(top)
            scored = [m for m in top if m.get("quality") is not None]
            avg_q = sum(_q(m) for m in scored) / len(scored) if scored else None
            combos.append({
                "goal": goal,
                "type": "additive" if additive else "diminishing",
                "levers": [lever],
                "members": top,
                "alternatives": {lever: len(roster)},
                "score": (70 if additive else 35) + (10 if feas["all_precastable"] else 0)
                         + (round(15 * avg_q) if avg_q is not None else 0),
                "fragile": feas["fragile"],
                "all_precastable": feas["all_precastable"],
                "rationale": (
                    f"Multiple sources of {ldef['label'].lower()}. These are flat "
                    f"bonuses, so they add up — pile them on."
                    if additive else
                    f"Multiple sources of {ldef['label'].lower()}. Boons/banes pool to "
                    f"the single highest die, so each extra source after the first "
                    f"barely moves the needle — spend the casting on a different "
                    f"lever instead."
                ),
            })

    # --- The unarmed brawler stack ----------------------------------------- #
    if unarmed["damage"]:
        dmg = sorted(unarmed["damage"], key=lambda m: (m["precast"], m["rank"]), reverse=True)
        combos.append({
            "goal": "boost-damage",
            "type": "additive",
            "levers": ["unarmed-damage"],
            "members": dmg[:4],
            "alternatives": {"unarmed-damage": len(dmg)},
            "score": 85,
            "fragile": False,
            "all_precastable": all(m["precast"] for m in dmg[:4]),
            "rationale": (
                "Every one of these adds extra damage to unarmed/natural-weapon "
                "attacks, and extra-damage dice add together — a brawler can "
                "layer them all onto the same punch."
            ),
        })
        if unarmed["accuracy"]:
            acc = sorted(unarmed["accuracy"], key=lambda m: m["rank"], reverse=True)[0]
            # A damage source that isn't the accuracy spell itself.
            best_dmg = next((m for m in dmg if _spellid(m) != _spellid(acc)), None)
        if unarmed["accuracy"] and best_dmg:
            combos.append({
                "goal": "boost-damage",
                "type": "compounding",
                "levers": ["unarmed-accuracy", "unarmed-damage"],
                "members": [acc, best_dmg],
                "alternatives": {"unarmed-damage": len(dmg), "unarmed-accuracy": len(unarmed["accuracy"])},
                "score": 90,
                "fragile": False,
                "all_precastable": acc["precast"] and best_dmg["precast"],
                "rationale": (
                    "Boons to land the unarmed strike plus stacked extra damage on "
                    "it: accuracy and damage on the same attack, the brawler's core."
                ),
            })

    # Dedupe: the same pair of spells can fill two different lever-role pairings
    # within a goal (e.g. a spell that both reduces damage and heals). Keep the
    # best-scored instance per (goal, member set).
    combos.sort(key=lambda c: c["score"], reverse=True)
    seen = set()
    deduped = []
    for c in combos:
        sig = (c["goal"], frozenset(_spellid(m) for m in c["members"]))
        if sig in seen:
            continue
        seen.add(sig)
        deduped.append(c)
    combos = deduped

    rosters = {
        goal: {lever: members[goal].get(lever, []) for lever in gdef["levers"] if members[goal].get(lever)}
        for goal, gdef in GOALS.items()
    }
    rosters["_unarmed"] = unarmed

    return {
        "goals": {g: {"label": d["label"], "desc": d["desc"],
                      "levers": {l: ld for l, ld in d["levers"].items()}}
                  for g, d in GOALS.items()},
        "combos": combos,
        "rosters": rosters,
        "notes": {
            "direction": "A boon adds a d6 and helps the roller; a bane subtracts a d6 and "
                         "hurts the roller. Offence vs defence is about whose roll carries it: "
                         "defence = banes on the enemy's attack against you, or boons on your own "
                         "challenge rolls (to resist effects); offence = boons on your attack "
                         "rolls, or banes on the target's rolls.",
            "boons_banes": "Boons and banes on one roll pool together and only the single "
                           "highest d6 applies (E[max]: 1d6=3.5, 2d6=4.47, 3d6=4.96). Stacking "
                           "the same roll-lever diminishes fast.",
            "flat_bonuses": "Flat Defense bonuses and extra-damage dice add together, so "
                            "stacking the same flat lever is linear and worth it.",
            "compounding": "The strongest combos pair different levers toward one goal (e.g. "
                           "raise Defense AND impose banes on the enemy's attack against you): "
                           "each avoids the other's diminishing returns.",
            "precast": "Minute+/hour buffs can be cast before the fight, so they cost no action "
                       "economy once combat starts. Holding 2+ concentration spells is fragile: "
                       "taking damage forces a challenge roll to keep each.",
            "quality": "Where a member has a measurable output, its `quality` is that spell's "
                       "rank-cohort percentile from score_spells.py (0..1). Showcases prefer "
                       "pairs built from individually-strong pieces, and combos of strong pieces "
                       "score higher.",
        },
    }


def report(data):
    print(f"{len(data['combos'])} combos\n")
    for g, gd in data["goals"].items():
        rosters = data["rosters"].get(g, {})
        tot = sum(len(v) for v in rosters.values())
        print(f"[{g}] {gd['label']} — {tot} spell-levers")
        for lever, ld in gd["levers"].items():
            print(f"    {len(rosters.get(lever, [])):3d}  {lever}")
    u = data["rosters"]["_unarmed"]
    print(f"[unarmed] damage={len(u['damage'])} accuracy={len(u['accuracy'])}")
    print("\nTop combos:")
    for c in data["combos"][:12]:
        names = " + ".join(m["name"] for m in c["members"])
        flags = []
        if c["all_precastable"]:
            flags.append("precast")
        if c["fragile"]:
            flags.append("FRAGILE")
        tag = f" ({', '.join(flags)})" if flags else ""
        print(f"  {c['score']:3d} [{c['type']:>11}] {c['goal']}: {names}{tag}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="print a summary, don't write")
    args = ap.parse_args()

    spells = json.loads(SPELLS.read_text())
    data = build(spells, load_scores())

    if args.report:
        report(data)
        return

    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['combos'])} combos")
    report(data)


if __name__ == "__main__":
    main()
