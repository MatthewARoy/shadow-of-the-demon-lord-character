#!/usr/bin/env python3
"""Categorize spells for theorycrafting by tagging mechanical effects.

Shadow of the Demon Lord uses very standardized rules language — "1 boon on
attack rolls", "becomes stunned", "1d6 damage", "challenge roll", "extra
action". That regularity makes a deterministic, keyword-driven tagger both
accurate and auditable: no model in the loop, no API key, runs offline, and
the same input always yields the same tags.

This is a post-processing pass over data/spells.json (run it after
parse_spells.py). It is idempotent — it rewrites the `tags` array each run, so
re-parsing the PDFs and re-tagging always converges to the same result.

Each tag belongs to a FACET (offense / control / support / mobility / utility /
cost / timing). The UI groups its filter chips by facet. Add or tune a rule
below and re-run; nothing else needs to change.

    python3 scripts/tag_spells.py            # rewrite tags in place
    python3 scripts/tag_spells.py --report   # print the tag distribution
"""
import json
import os
import re
import sys

SPELLS = os.path.join(os.path.dirname(__file__), "..", "data", "spells.json")

# A rule is (tag, facet, matcher). The matcher is given the lowercased
# description plus the raw spell dict (so it can read duration/area/type) and
# returns truthy if the tag applies. Most matchers are compiled regexes; a few
# need structure and are plain callables.

def rx(pattern):
    r = re.compile(pattern, re.I)
    return lambda desc, s: bool(r.search(desc))

# ---- OFFENSE -------------------------------------------------------------
# Does the spell deal damage, and how is it delivered.
RULES = [
    ("damage", "offense", rx(r"\b\d+d\d+\b|takes? .*damage|deals? .*damage")),
    # Damage with no attack roll to dodge — reliable chip / save-for-half.
    ("auto-damage", "offense", lambda d, s: bool(re.search(r"\d+d\d+", d)) and "attack" not in s),
    # Self/ally buff: boons on YOUR or an ally's attack rolls.
    ("buff-attack", "support", rx(r"\bboons?\b[^.]*\battack roll")),
    # The roll-fixing category: reroll, roll twice and keep the better, or a
    # flat bonus die on a challenge — the Borrowed-Time-adjacent enablers.
    ("buff-challenge", "support", rx(r"\bboons?\b[^.]*\bchallenge roll")),
    ("reroll", "support", rx(r"reroll|roll (?:the|that|it|.{0,20}?) ?twice|make the roll twice|take the (?:higher|better)")),
    # Debuff: banes on enemy rolls — the inverse buff, also build-relevant.
    ("debuff-rolls", "control", rx(r"\bbanes?\b")),
]

# ---- CONTROL / DEBUFF ----------------------------------------------------
RULES += [
    ("control", "control", rx(r"\b(stunned|immobiliz\w+|slowed|prone|grabbed|paraly\w+|restrained|incapacitat\w+|dazed|blinded|deafened)\b")),
    ("fear", "control", rx(r"\bfrightened\b|\bhorrified\b|\bflee\b")),
    ("mind-control", "control", rx(r"\bcharmed\b|\bcompelled\b|control .*(creature|target)|dominat")),
    ("insanity", "control", rx(r"\bInsanity\b|\bmadness\b|\bgains? .*Insanity")),
]

# ---- SUPPORT / DEFENSE ---------------------------------------------------
RULES += [
    ("heal", "support", rx(r"\bheals?\b|regains?\b[^.]*\bHealth\b|recover[^.]*\bHealth\b|healing rate")),
    ("cure", "support", rx(r"\b(cured?|cures|remove[sd]?|ends?)\b[^.]*\b(disease|poison|affliction|charmed|frightened|stunned|condition|effect)\b|no longer (?:stunned|frightened|charmed)")),
    ("defense-buff", "support", rx(r"bonus to Defense|Defense (?:score )?(?:increases|becomes)|\+\d[^.]*Defense|gain.{0,12}armor|Health increases by")),
    # Action economy — the Borrowed Time bucket: extra actions/turns or a
    # granted triggered action. Pure Speed bonuses live under `movement`.
    ("action-economy", "support", rx(r"extra (?:action|turn)|additional (?:action|turn)|increase the number of actions (?:you can use)?|(?:take|gain) (?:an|one|another) .{0,20}?turn|can use a triggered action to (?:make an attack|move|cast)|grant[^.]*triggered action")),
    ("protection", "support", rx(r"immun\w+ to|resist\w* (?:to )?(?:the )?damage|takes? half|reduce[sd]?[^.]*damage|cannot be (?:targeted|harmed)|invulnerab")),
]

# ---- MOBILITY ------------------------------------------------------------
RULES += [
    ("teleport", "mobility", rx(r"teleport|instantly (?:move|appear|transport)")),
    ("fly", "mobility", rx(r"\bflying\b|\bfly\b|hover|levitat")),
    ("movement", "mobility", rx(r"bonus to Speed|increase[^.]*Speed|move .* without|ignore[^.]*difficult terrain|move across (?:liquid|open)|climb|walk on")),
]

# ---- UTILITY -------------------------------------------------------------
RULES += [
    ("summon", "utility", rx(r"\bsummon|\bconjure|appears? (?:within|in an? )|compelled .* (?:monster|creature)|create[sd]? a .* (?:that|which) (?:obey|serve|attack)")),
    ("concealment", "utility", rx(r"invisib|\bobscured\b|cannot be seen|hidden from|conceal")),
    ("divination", "utility", rx(r"\bdetect|\bsense\b|\bscry|learn (?:the|about|whether)|read .* (?:mind|thoughts)|know (?:the|whether|if)|locate|reveal")),
    ("transform", "utility", rx(r"transform|polymorph|becomes? a .* (?:size \d+|creature|monster|animal)|change .* (?:into|shape|form)|assume the (?:form|shape)")),
]

# ---- COST / RISK ---------------------------------------------------------
RULES += [
    ("sacrifice", "cost", lambda d, s: "sacrifice" in d),
    ("self-risk", "cost", rx(r"you (?:become|gain|take|are) [^.]*(stunned|Insanity|damage|injured|impaired|fatigued|cursed)|you must get a success|or you (?:become|take|gain|suffer)")),
]

# ---- TIMING --------------------------------------------------------------
# Read from the duration field + the description's leading marker. These tell a
# theorycrafter how the spell fits the action economy and the turn timeline.
def _is_triggered(d, s):
    return s.get("description", "").startswith("Triggered")

def _duration_is(*needles):
    def f(d, s):
        dur = (s.get("duration") or "").lower()
        return any(n in dur for n in needles)
    return f

RULES += [
    ("triggered", "timing", _is_triggered),
    ("concentration", "timing", _duration_is("concentration")),
    ("sustained", "timing", lambda d, s: bool((s.get("duration") or "")) and (s.get("duration") or "").lower() not in ("", "permanent") and not _duration_is("concentration")(d, s) and re.search(r"minute|hour|round|rest|day", (s.get("duration") or "").lower())),
    ("permanent", "timing", _duration_is("permanent")),
    ("area", "timing", lambda d, s: bool(s.get("area")) or bool(re.search(r"\b(sphere|cube|cone|line|each (?:creature|target) (?:in|within) (?:the|a|an|range))\b", d))),
]

# Facet order/labels for the UI's grouping (exported into the JSON sidecar so
# the front end need not hardcode the taxonomy).
FACETS = ["offense", "control", "support", "mobility", "utility", "cost", "timing"]
TAG_LABELS = {
    "damage": "Damage",
    "auto-damage": "Auto-damage (no attack roll)",
    "buff-attack": "Buff: attack rolls",
    "buff-challenge": "Buff: challenge rolls",
    "reroll": "Reroll / roll twice",
    "debuff-rolls": "Debuff: imposes banes",
    "control": "Control (stun/immobilize/etc.)",
    "fear": "Fear",
    "mind-control": "Mind control",
    "insanity": "Insanity / madness",
    "heal": "Healing",
    "cure": "Cure / remove condition",
    "defense-buff": "Defense / Health buff",
    "action-economy": "Action economy",
    "protection": "Damage protection",
    "teleport": "Teleport",
    "fly": "Flight",
    "movement": "Movement",
    "summon": "Summon / conjure",
    "concealment": "Concealment / invisibility",
    "divination": "Divination / detection",
    "transform": "Transformation",
    "sacrifice": "Sacrifice cost",
    "self-risk": "Self-risk / drawback",
    "triggered": "Triggered (reactive)",
    "concentration": "Concentration",
    "sustained": "Sustained duration",
    "permanent": "Permanent",
    "area": "Area effect",
}


def tags_for(spell):
    desc = (spell.get("description") or "").lower()
    out = []
    for tag, _facet, match in RULES:
        try:
            if match(desc, spell):
                out.append(tag)
        except Exception:  # a bad rule should not abort the whole run
            pass
    return out


def main():
    report = "--report" in sys.argv
    spells = json.load(open(SPELLS))
    counts = {}
    for s in spells:
        tags = tags_for(s)
        s["tags"] = tags
        for t in tags:
            counts[t] = counts.get(t, 0) + 1
    if report:
        for facet in FACETS:
            print(f"\n[{facet}]")
            for tag, _f, _m in RULES:
                if _f == facet:
                    print(f"  {tag:18} {counts.get(tag, 0):4}  {TAG_LABELS[tag]}")
        untagged = sum(1 for s in spells if not s["tags"])
        print(f"\n{len(spells)} spells, {untagged} untagged")
        return
    # Persist tags inline (additive field) and a small taxonomy sidecar the UI
    # reads to build its filter chips.
    with open(SPELLS, "w") as f:
        json.dump(spells, f, indent=1, ensure_ascii=False)
    taxo = {"facets": FACETS, "tags": [
        {"id": tag, "facet": facet, "label": TAG_LABELS[tag], "count": counts.get(tag, 0)}
        for tag, facet, _ in RULES
    ]}
    sidecar = os.path.join(os.path.dirname(SPELLS), "spell-tags.json")
    with open(sidecar, "w") as f:
        json.dump(taxo, f, indent=1, ensure_ascii=False)
    print(f"tagged {len(spells)} spells -> {SPELLS}; taxonomy -> {sidecar}", file=sys.stderr)


if __name__ == "__main__":
    main()
