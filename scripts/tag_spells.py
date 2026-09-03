#!/usr/bin/env python3
"""Categorize spells for theorycrafting by tagging mechanical effects.

Shadow of the Demon Lord uses very standardized rules language — "heals damage
equal to", "the target becomes stunned", "takes 2d6 damage", "1 boon on attack
rolls", "extra action". That regularity makes a deterministic, keyword-driven
tagger both accurate and auditable: no model in the loop, no API key, runs
offline, same input -> same tags.

This is a post-processing pass over data/spells.json (run it after
parse_spells.py). It is idempotent — it rewrites each spell's `tags` array, so
re-parsing the PDFs and re-tagging always converges.

Two refinements over a naive keyword match keep it honest:

  1. Anchored phrasing. Tags key on how the rulebook actually states an effect
     ("heals damage equal to", not the bare word "heal"), so a spell that only
     *mentions* healing in a trigger clause ("until it heals any damage") is
     not mistaken for a healer.

  2. Inflict-vs-negate context. A condition word is only a `control` hit when
     it is *applied* ("becomes stunned"); the same word inside a removal or
     immunity clause ("is no longer stunned", "immune to stunned") feeds
     `cure`/`protection` instead.

For the genuine exceptions that no rule can fairly resolve, a hand-curated
override file (data/spell-tag-overrides.json) adds or removes individual tags
per spell. Overrides win, and are applied last.

    python3 scripts/tag_spells.py            # rewrite tags in place
    python3 scripts/tag_spells.py --report   # tag distribution
    python3 scripts/tag_spells.py --audit heal control   # dump hits w/ context
"""

import json
import os
import re
import sys

HERE = os.path.dirname(__file__)
SPELLS = os.path.join(HERE, "..", "data", "spells.json")
OVERRIDES = os.path.join(HERE, "..", "data", "spell-tag-overrides.json")
SIDECAR = os.path.join(HERE, "..", "data", "spell-tags.json")

# Conditions/afflictions whose *application* is battlefield control.
CONTROL_CONDS = [
    "stunned",
    "immobilized",
    "slowed",
    "prone",
    "grabbed",
    "restrained",
    "paralyzed",
    "incapacitated",
    "dazed",
    "blinded",
    "deafened",
    "asleep",
    "surprised",
    "defenseless",
]
# Words just before a condition that flip it from "applied" to "not applied".
NEGATE = re.compile(
    r"(no longer|not |isn.?t|aren.?t|ends? the|end this|remov\w+|"
    r"cured? of|immune to|can.?t be|cannot be|never|protect\w* (?:from|against)|"
    r"resist\w*|ignores?|prevents?|avoids?|free(?:s|d)? (?:it|them|the)|"
    r"instead of (?:being |becoming )?)",
    re.I,
)


# A condition whose subject is the caster ("you become stunned") is a self-risk
# drawback, not control/fear inflicted on a target.
SELF_SUBJECT = re.compile(
    r"\byou (?:become|are|'re|gain|suffer|turn|fall|also become|might (?:become|be)|may (?:become|be)|could become|would become|instead become)\b[^.]{0,18}$",
    re.I,
)


def cond_applied(desc, conds, exclude_self=True):
    """True if any condition in `conds` appears in an applied (non-negated)
    context. Scans the ~48 chars before each occurrence for a negater, and —
    when exclude_self — for a caster subject so self-inflicted conditions
    (drawbacks) don't read as control over a target."""
    for c in conds:
        for m in re.finditer(r"\b" + c + r"\b", desc, re.I):
            ctx = desc[max(0, m.start() - 48) : m.start()]
            if NEGATE.search(ctx):
                continue
            if exclude_self and SELF_SUBJECT.search(ctx):
                continue
            return True
    return False


def rx(pattern):
    r = re.compile(pattern, re.I)
    return lambda d, s: bool(r.search(d))


# A rule is (tag, facet, matcher(lowered_desc, spell)->bool). Order is cosmetic
# (used for the report); membership is a set.
RULES = []

# ---- OFFENSE -------------------------------------------------------------
# Deals damage to a target. Enumerates the *dealing* phrasings ("deals N
# damage", "takes 2d6 [extra] damage", "takes damage equal to", "for 1d6
# damage") rather than a bare "takes…damage", so healing dice ("heals 1d3
# damage") and — crucially — defensive mitigation ("takes no/half damage from
# all sources") do not read as a damage spell. The LLM tag audit surfaced this
# class (Glide, Resistance, Flame Ward were all mislabeled `damage`).
_DAMAGE = re.compile(
    r"deals?\b[^.]{0,45}\bdamage\b|dealing[^.]{0,45}\bdamage\b|inflicts?\b[^.]{0,45}\bdamage\b|"
    # Bare "Nd6 damage" counts as dealing damage — unless it's healing dice
    # ("heal 3d6 damage"), which the audit flagged (Animate Huge Corpse).
    r"(?<!heal )(?<!heals )(?<!healing )\b\d+d\d+(?:\s*\+\s*\d+)? (?:extra )?damage\b|"
    r"tak(?:es?|ing) (?:\d+(?:d\d+)?|that|the|this|any|its) (?:extra )?damage|"
    r"tak(?:es?|ing) damage equal to|tak(?:es?|ing) half the damage|tak(?:es?|ing) the attack|"
    r"for \d+d\d+(?:\s*\+\s*\d+)? damage|damage equal to its|"
    r"\bdamage\b[^.]{0,20}\bto (?:everything|each|all|the target)",
    re.I,
)
RULES += [
    ("damage", "offense", lambda d, s: bool(_DAMAGE.search(d))),
    # Damage with no attack roll — reliable/save-for-half. Needs the new damage
    # definition AND no parsed attack block.
    (
        "auto-damage",
        "offense",
        lambda d, s: bool(_DAMAGE.search(d)) and "attack" not in s,
    ),
]

# ---- SUPPORT: roll-fixing (the Borrowed-Time-adjacent enablers) ----------
RULES += [
    # Boons granted on rolls — stated either order. The reverse direction
    # requires PLURAL "rolls" ("the target makes attack rolls with 1 boon", an
    # ongoing buff) to exclude a spell's own single cast roll ("Make an attack
    # roll with 2 boons"), which is accuracy, not a granted buff.
    (
        "buff-attack",
        "support",
        rx(
            r"\bboons?\b[^.]{0,70}attack roll|attack rolls\b[^.]{0,40}\bwith \d+ boons?\b"
        ),
    ),
    (
        "buff-challenge",
        "support",
        rx(
            r"\bboons?\b[^.]{0,70}challenge roll|challenge rolls\b[^.]{0,40}\bwith \d+ boons?\b"
        ),
    ),
    (
        "reroll",
        "support",
        rx(
            r"rerolls?|roll(?:s)? (?:it |that |the (?:die|roll) )?twice|roll an additional die and use the (?:high|great)|use the (?:higher|highest|better|best) (?:of the )?result"
        ),
    ),
]

# ---- CONTROL / DEBUFF ----------------------------------------------------
RULES += [
    (
        "debuff-rolls",
        "control",
        rx(
            r"\bbanes?\b[^.]{0,70}(?:attack|challenge|roll)|(?:attack|challenge) rolls\b[^.]{0,40}\bwith \d+ banes?\b"
        ),
    ),
    ("control", "control", lambda d, s: cond_applied(d, CONTROL_CONDS)),
    (
        "fear",
        "control",
        lambda d, s: (
            cond_applied(d, ["frightened", "horrified"])
            or bool(re.search(r"\bflees?\b|must flee", d))
        ),
    ),
    # Charmed/compelled applied to a target. "compelled" alone is excluded
    # because SotDL also uses it for summoned monsters ("compelled small
    # monster"); only "becomes/is compelled" or "compelled to <verb>" counts.
    (
        "mind-control",
        "control",
        lambda d, s: (
            cond_applied(d, ["charmed"])
            or bool(
                re.search(
                    r"becomes? compelled|is compelled|compelled to (?:obey|serve|attack|move|act|fight|do|use|make)|\bdominat\w+|takes? control of (?:the|its|each|your)|control (?:the|its|each|your) (?:target|creature|action|mind|body|movement)",
                    d,
                )
            )
        ),
    ),
    # Inflicts Insanity on a target (self-Insanity is a cost, handled below).
    (
        "insanity",
        "control",
        rx(
            r"(?:target|creature|it|each \w+|they|them) (?:gains?|takes?|suffers?|marks?)\b[^.]{0,30}Insanity|spreads? (?:madness|Insanity)"
        ),
    ),
]

# ---- SUPPORT / DEFENSE ---------------------------------------------------
# Restores Health on cast.
_HEAL = re.compile(
    r"heals? damage equal to|heals? \d+(?:d\d+)? damage|heals? all (?:its |your |the )?damage|regains?\b[^.]{0,30}\bHealth\b|recover[^.]{0,30}\bHealth\b",
    re.I,
)
# Amplifies/enables healing without a direct on-cast heal. Must be anchored on
# the word "heal" so offensive "deals extra damage" clauses don't match.
_HEAL_SUP = re.compile(
    r"heals? (?:\d+d\d+ |\w+ )?extra damage|each time[^.]{0,30}heals[^.]{0,25}(?:damage|extra)|whenever[^.]{0,40}heals (?:damage|\d)|consume[^.]{0,40}\bheal\w*\b[^.]{0,20}damage",
    re.I,
)
RULES += [
    ("heal", "support", lambda d, s: bool(_HEAL.search(d))),
    (
        "heal-support",
        "support",
        lambda d, s: bool(_HEAL_SUP.search(d)) and not _HEAL.search(d),
    ),
    # Removes a pre-existing affliction from a creature as a benefit. The hard
    # part is the *self-escape* clause — a debuff spell describing how its own
    # inflicted affliction ends ("removes the affliction from it", "no longer
    # diseased from this effect"). So the generic singular "removes the
    # affliction" is excluded; genuine cures that phrase it that way (Exorcism)
    # are added back via the override file.
    # Plural "afflictions" is a safe cure tell: inflict-then-escape clauses
    # always reference "the affliction" (singular, the one just applied).
    (
        "cure",
        "support",
        rx(
            r"remove (?:one of |any of )?(?:the )?following (?:affliction|benefit)|remove one curse|cured? of\b|\brid (?:it|them|the target|yourself|itself) of\b|cleanse\w*|resist or remove|remov\w+[^.]{0,45}\bafflictions\b"
        ),
    ),
    (
        "defense-buff",
        "support",
        rx(
            r"bonus to Defense|Defense (?:score )?(?:becomes|increases?)|\+\d[^.]{0,12}Defense|Health (?:score )?increases? by|bonus to Health"
        ),
    ),
    # Action economy — the Borrowed Time bucket: extra actions/turns/rounds, or
    # granting an ally a triggered action/attack. Includes SotDL's core bonus-
    # turn idiom — "a fast turn and a slow turn" (you normally take one OR the
    # other), used by Accelerate/Time Dilation — and "extra round" (Halt Time).
    # Pure Speed lives under `movement`; a spell merely cast as a triggered
    # action is `triggered`; a bare "take a turn" is usually a per-turn trigger
    # (Cloud of Missiles), so none of those count here.
    (
        "action-economy",
        "support",
        rx(
            r"extra (?:action|turn|attack|round)|additional (?:action|turn|attack)|increase the number of actions|fast turn and a slow turn|(?:take|gain|get)s? (?:an|one|another)\b[^.]{0,14}\bturn|(?:you|target|creature|ally|it|they) can use a triggered action to make[^.]{0,15}attack|grant[^.]{0,25}triggered action|\bacts? (?:again|twice|an additional)\b"
        ),
    ),
    # Defensive damage mitigation. The key tell is "takes half damage FROM"
    # (a granted resistance) vs. the offensive save-for-half "taking half the
    # damage on a success", which is a damage spell and is deliberately excluded.
    (
        "protection",
        "support",
        rx(
            r"immune to[^.]{0,40}damage|\bimmunity\b|tak(?:es?|ing) (?:half|no) damage from (?!the attack|this attack|the spell|that attack)|reduce[sd]? (?:the )?damage (?:you|it|the target|they) takes?|damage (?:you|it|the target|they) takes? is (?:reduced|halved)|cannot be (?:targeted|harmed)|invulnerab"
        ),
    ),
]

# ---- MOBILITY ------------------------------------------------------------
RULES += [
    (
        "teleport",
        "mobility",
        rx(
            r"teleports?|instantly (?:move|appear|transport|travel)|vanish\w* and (?:reappear|appear)"
        ),
    ),
    # Grants flight to a creature. Anchored on a creature subject so projectile
    # flavor ("a dart flies from your hand", "flying debris") is excluded.
    (
        "fly",
        "mobility",
        rx(
            r"can fly\b|gains? a (?:fly|flying) Speed|\bfly(?:ing)? Speed\b|fly up to|fly (?:over|through|across|toward|away|into)|move by flying|(?:you|it|the target|they) (?:can )?flies?\b|levitat\w+|hover\w* (?:in (?:the )?air|above|off the ground|motionless)|(?:lift|rise|float|soar)\w*[^.]{0,18}(?:in|into) the air|takes? to the air|move(?:s)? (?:up |down )?through the air"
        ),
    ),
    (
        "movement",
        "mobility",
        rx(
            r"bonus to Speed|increase[^.]{0,18}Speed|Speed (?:score )?(?:becomes|increases?)|ignore[^.]{0,20}difficult terrain|move across (?:liquid|the surface|open)|climb\w* Speed|walk (?:on|up|across)|move up to twice|without (?:triggering|provoking) (?:a |any )?free attack"
        ),
    ),
]

# ---- UTILITY -------------------------------------------------------------
RULES += [
    (
        "summon",
        "utility",
        rx(
            r"\bsummons?\b|\bconjures?\b|\b(?:appears?|materializes?)\b[^.]{0,40}(?:within|in an? |on a solid)|compelled[^.]{0,20}(?:monster|creature)|creates? an? [^.]{0,40}(?:that|which) (?:obey|serve|attack|fight|act)"
        ),
    ),
    # Concealment of a creature. "invisible" is anchored to a creature subject
    # so "an invisible field of force" (a shield) isn't read as hiding you.
    (
        "concealment",
        "utility",
        rx(
            r"(?:become[s]?|turn[s]?|render[s]?|are|is|gains? )\w* ?invisib\w+|invisible to|invisibility|becomes? (?:obscured|hidden|indistinct)|cannot be seen|hidden from|conceal\w+ (?:you|it|the target|yourself|itself)|heavily obscured"
        ),
    ),
    # Detection/scrying. Bare "sense(s)"/"reveal" are dropped — they match
    # flavor ("reveal bone", "cut off from its senses"). Anchored on the action.
    (
        "divination",
        "utility",
        rx(
            r"\bdetects?\b|sense the (?:presence|location|direction|number)|\bscry\w*|learn (?:the|about|whether|if)|read[^.]{0,15}(?:mind|thoughts|memor)|know (?:the (?:exact|location|number|name|direction)|whether|if)|locate the|pinpoint|see (?:the )?(?:aura|invisible)|see through (?:walls|illusions|the)|see into (?:the )?(?:mind|future|past|veil)|detect the presence|discern the"
        ),
    ),
    (
        "transform",
        "utility",
        rx(
            r"transform\w*|polymorph\w*|becomes? an? [^.]{0,30}(?:size \d+|creature|monster|animal|beast)|change (?:its|your|the target.?s)[^.]{0,15}(?:shape|form)|assume the (?:form|shape) of"
        ),
    ),
]

# ---- COST / RISK ---------------------------------------------------------
RULES += [
    ("sacrifice", "cost", lambda d, s: "sacrifice" in d),
    (
        "corruption",
        "cost",
        rx(r"you (?:gain|mark|take)\b[^.]{0,18}Corruption|gain \d+ Corruption"),
    ),
    (
        "self-risk",
        "cost",
        rx(
            r"you (?:take|gain|suffer|mark)\b[^.]{0,18}(?:\d+d\d+ damage|\d+ damage|Insanity|Corruption)|you must get a success|or you (?:become|take|gain|suffer|are)\b|you (?:become|are) (?:stunned|impaired|fatigued|injured|cursed)"
        ),
    ),
]


# ---- TIMING --------------------------------------------------------------
def _is_triggered(d, s):
    return s.get("description", "").startswith("Triggered")


def _dur(*needles):
    def f(d, s):
        dur = (s.get("duration") or "").lower()
        return any(n in dur for n in needles)

    return f


# Permanence is sometimes a Duration field ("Permanent") and sometimes only
# stated in prose: an effect that persists until actively undone ("until you
# use an action to restore it" — Shrink Object) or one declared permanent.
_PERM_PROSE = re.compile(
    r"\bpermanent(?:ly)?\b|becomes? permanent|"
    r"until you (?:use an action to )?(?:restore|dismiss|end|reverse|release|undo|cancel) (?:it|the|this|its)|"
    r"until (?:it is |the \w+ is )?(?:dispelled|removed)",
    re.I,
)


def _permanent(d, s):
    return "permanent" in (s.get("duration") or "").lower() or bool(
        _PERM_PROSE.search(d)
    )


# A timed duration stated inline in the description, for the many spells whose
# Duration field the parser didn't capture (the audit's biggest "missing"
# signal was `sustained`). "for the duration" implies a (missing) timed field.
_INLINE_DUR = re.compile(
    r"\bfor (?:1|one|\d+|the next) (?:minute|hour|round|day)|for the duration|"
    r"lasts? (?:for )?(?:1|one|\d+) (?:minute|hour|round|day)|"
    r"until (?:the (?:start|end) of|you complete a rest|the end of the (?:round|encounter)|the spell ends)",
    re.I,
)


def _sustained(d, s):
    dur = (s.get("duration") or "").lower()
    if dur:
        if dur == "permanent" or "concentration" in dur:
            return False
        return bool(re.search(r"minute|hour|round|rest|day", dur))
    # No Duration field: read a timed duration from the prose, unless permanent.
    return bool(_INLINE_DUR.search(d)) and not _PERM_PROSE.search(d)


RULES += [
    ("triggered", "timing", _is_triggered),
    ("concentration", "timing", _dur("concentration")),
    ("sustained", "timing", _sustained),
    ("permanent", "timing", _permanent),
    (
        "area",
        "timing",
        lambda d, s: (
            bool(s.get("area"))
            or bool(
                re.search(
                    r"\b(?:sphere|cube|cone|line|cylinder)\b[^.]{0,30}(?:radius|yard|long|tall)|each (?:creature|target|enemy) (?:in|within) (?:the area|range|\d+ yard)",
                    d,
                )
            )
        ),
    ),
]

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
    "insanity": "Inflicts Insanity",
    "heal": "Healing",
    "heal-support": "Healing support / amplifier",
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
    "corruption": "Corruption cost",
    "self-risk": "Self-risk / drawback",
    "triggered": "Triggered (reactive)",
    "concentration": "Concentration",
    "sustained": "Sustained duration",
    "permanent": "Permanent",
    "area": "Area effect",
}


def load_overrides():
    if not os.path.exists(OVERRIDES):
        return {}
    raw = json.load(open(OVERRIDES))
    # Drop schema/comment keys (anything starting with "$" or "_").
    return {k: v for k, v in raw.items() if not k.startswith(("$", "_"))}


def taggable_text(spell):
    """The spell's rules text, table rows included.

    A spell whose effect *is* its table says nothing about damage or fear in
    its description — bewilder's confused creature "claw[s] at itself, taking
    1d6 damage" only in row 4. While the table was flattened into the
    description the keyword rules saw that text by accident; now that it is
    structured they have to be handed it deliberately.
    """
    parts = [spell.get("description") or ""]
    for table in spell.get("tables") or []:
        for row in table["rows"]:
            parts.extend(row)
    return " ".join(parts).lower()


def rule_tags(spell):
    desc = taggable_text(spell)
    out = []
    for tag, _facet, match in RULES:
        try:
            if match(desc, spell):
                out.append(tag)
        except Exception as e:
            print(
                f"tag rule {tag!r} failed on {spell.get('name')!r}: {e!r}",
                file=sys.stderr,
            )
    return out


def apply_overrides(tags, key, overrides):
    ov = overrides.get(key)
    if not ov:
        return tags
    s = set(tags)
    for t in ov.get("remove", []):
        s.discard(t)
    for t in ov.get("add", []):
        s.add(t)
    # Preserve rule order, then any added tags not in RULES order.
    order = [t for t, _, _ in RULES]
    return sorted(s, key=lambda t: order.index(t) if t in order else 999)


def spell_key(s):
    return f"{s['name']}|{s['tradition']}".lower()


def main():
    args = sys.argv[1:]
    spells = json.load(open(SPELLS))
    overrides = load_overrides()

    if args and args[0] == "--audit":
        wanted = set(args[1:])
        for s in spells:
            tags = set(rule_tags(s))
            for t in tags & wanted:
                print(f"[{t}] {s['name']} ({s['tradition']} R{s['rank']})")
                print(f"      {s['description'][:150]}")
        return

    counts, applied_overrides = {}, 0
    for s in spells:
        base = rule_tags(s)
        final = apply_overrides(base, spell_key(s), overrides)
        if final != base:
            applied_overrides += 1
        s["tags"] = final
        for t in final:
            counts[t] = counts.get(t, 0) + 1

    if "--report" in args:
        for facet in FACETS:
            print(f"\n[{facet}]")
            for tag, f, _ in RULES:
                if f == facet:
                    print(f"  {tag:16} {counts.get(tag, 0):4}  {TAG_LABELS[tag]}")
        untagged = sum(1 for s in spells if not s["tags"])
        print(
            f"\n{len(spells)} spells · {untagged} untagged · {applied_overrides} overridden · {len(overrides)} override entries"
        )
        return

    with open(SPELLS, "w") as f:
        json.dump(spells, f, indent=1, ensure_ascii=False)
    taxo = {
        "facets": FACETS,
        "tags": [
            {
                "id": tag,
                "facet": facet,
                "label": TAG_LABELS[tag],
                "count": counts.get(tag, 0),
            }
            for tag, facet, _ in RULES
        ],
    }
    with open(SIDECAR, "w") as f:
        json.dump(taxo, f, indent=1, ensure_ascii=False)
    print(
        f"tagged {len(spells)} spells ({applied_overrides} via overrides) -> {SPELLS}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
