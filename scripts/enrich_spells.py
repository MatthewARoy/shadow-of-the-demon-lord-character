#!/usr/bin/env python3
"""LLM enrichment pass: deep semantic labels for spell theorycrafting.

The regex tagger in tag_spells.py is precise about *mechanics* (does this deal
damage, impose banes, grant an extra action). It cannot judge *intent* — is a
fear effect offensive or defensive, which build archetypes want a spell, what
does it combo with. That is what a model is for.

This is the "one-time enrichment" the design spec calls out: run it offline,
review the output, commit it to JSON. Runtime stays a static, deterministic,
no-API-key app — the front end only ever reads the committed file.

Each spell gets, from `claude -p`:
  role        one primary mechanical role (enum)
  archetypes  0-3 build archetypes that want it (enum)
  targeting   who it affects (enum)
  tempo       when/how it is used (enum)
  synergy     one terse sentence of build/combo guidance
  tag_add     rule-tags the model thinks are missing  (audits the tagger)
  tag_remove  rule-tags the model thinks are wrong

Output is cached per spell in data/spell-enrichment.json and the run is
resumable — already-labeled spells are skipped — so it can go in the
background and survive restarts.

    python3 scripts/enrich_spells.py --limit 20         # sample
    python3 scripts/enrich_spells.py                    # full, resumable
    python3 scripts/enrich_spells.py --shard 0/4        # one of 4 parallel workers
    python3 scripts/enrich_spells.py --merge            # fold shard files into the cache
    python3 scripts/enrich_spells.py --audit            # print tagger disagreements
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(__file__)
SPELLS = os.path.join(HERE, "..", "data", "spells.json")
OUT = os.path.join(HERE, "..", "data", "spell-enrichment.json")
TAXO = os.path.join(HERE, "..", "data", "spell-tags.json")

ROLES = ["damage", "control", "debuff", "buff", "heal", "protection", "mobility",
         "summon", "utility", "divination", "transform", "drain", "social", "anti-magic"]
ARCHETYPES = ["blaster", "controller", "debuffer", "healer", "support", "summoner",
              "skirmisher", "tank", "face", "enabler", "nuker", "duelist"]
TARGETING = ["self", "ally", "allies", "one-enemy", "several-enemies", "area-enemy",
             "area-mixed", "object", "point", "battlefield"]
TEMPO = ["burst", "sustained", "setup", "reaction", "ritual", "passive"]

# What each mechanical tag means in THIS taxonomy, so the model audits tags by
# our definitions rather than its own intuition (the noise source in v1). A tag
# is a precise *mechanical* fact, not a vibe — e.g. `triggered` means the spell
# literally begins "Triggered", not merely that it feels reactive.
TAG_GLOSS = {
    "damage": "spell deals damage to a target (not healing dice, not damage it prevents)",
    "auto-damage": "deals damage with no attack roll to dodge (a challenge-roll-for-half still counts)",
    "buff-attack": "grants boons to attack rolls, to you or an ally (not the spell's own single cast roll)",
    "buff-challenge": "grants boons to challenge rolls, to you or an ally",
    "reroll": "lets a roll be made twice / rerolled / an extra die kept",
    "debuff-rolls": "imposes banes on a target's attack or challenge rolls",
    "control": "applies a movement/action-denying affliction (stunned, immobilized, slowed, prone, grabbed, dazed, blinded, deafened, asleep)",
    "fear": "applies frightened/horrified or forces fleeing",
    "mind-control": "charms, compels, or dominates a target's actions (not summoning a 'compelled' monster)",
    "insanity": "inflicts Insanity/madness on a target (self-Insanity is self-risk, not this)",
    "heal": "restores Health to a creature on cast",
    "heal-support": "amplifies or enables healing without a direct on-cast heal",
    "cure": "removes an existing affliction/condition from a creature",
    "defense-buff": "raises Defense or Health",
    "action-economy": "grants extra actions/turns/rounds or an extra attack (NOT merely being cast as a triggered action)",
    "protection": "grants damage immunity / resistance / reduction to a creature",
    "teleport": "teleports a creature",
    "fly": "grants flight to a creature (not a flying projectile)",
    "movement": "boosts Speed or grants special movement (ignore terrain, move without provoking, etc.)",
    "summon": "conjures or creates a creature that acts",
    "concealment": "makes a creature invisible / obscured / hidden",
    "divination": "detects, senses, scrys, or reveals information",
    "transform": "changes a creature's or object's form or size",
    "sacrifice": "has a Sacrifice option",
    "corruption": "the CASTER gains Corruption",
    "self-risk": "carries a drawback/risk to the caster (self-damage, self-Insanity, an aftereffect save)",
    "triggered": "can be cast as a triggered (reactive) action — description begins 'Triggered'",
    "concentration": "duration requires concentration",
    "sustained": "has a timed duration (minutes / hours / rounds)",
    "permanent": "effect is permanent or lasts until actively undone",
    "area": "affects an area or multiple targets in a zone",
}

BATCH = 12
MODEL = "sonnet"


def spell_key(s):
    return f"{s['name']}|{s['tradition']}".lower()


def load_json(path, default):
    if os.path.exists(path):
        return json.load(open(path))
    return default


def build_prompt(batch, tag_vocab):
    items = []
    for i, s in enumerate(batch):
        items.append({
            "id": i,
            "name": s["name"], "tradition": s["tradition"], "type": s["type"],
            "rank": s["rank"], "area": s.get("area", ""), "duration": s.get("duration", ""),
            "description": s["description"], "current_tags": s.get("tags", []),
        })
    gloss = "\n".join(f"  - {t}: {TAG_GLOSS.get(t, '')}" for t in tag_vocab)
    return f"""You are labeling spells from the tabletop RPG Shadow of the Demon Lord for character-build theorycrafting. Judge each spell on intent and role, not just keywords.

For each spell, produce a JSON object with EXACTLY these fields:
- "id": echo the spell's id (integer).
- "role": the single primary mechanical role. One of: {ROLES}
- "archetypes": 0 to 3 build archetypes that most want this spell. Each from: {ARCHETYPES}
- "targeting": who the spell affects. One of: {TARGETING}
- "tempo": how it fits the action economy / when you use it. One of: {TEMPO}
- "synergy": ONE concise sentence (<=160 chars) on how a build uses it or what it combos with. No fluff.
- "tag_add": mechanical tags that clearly apply per the DEFINITIONS below but are missing from current_tags. Only tags from the list. Usually [].
- "tag_remove": tags in current_tags that are WRONG per the DEFINITIONS below. Only values present in that spell's current_tags. Usually [].

The current_tags come from a regex tagger; the tags mean EXACTLY this (audit against these definitions, not your own intuition — a tag is a precise mechanical fact):
{gloss}

Audit carefully and literally: only add a tag if the spell's text clearly satisfies its definition; only remove a tag if the text clearly does NOT. Do not flag a tag just because it isn't the spell's *main* point (a damage spell that also imposes banes keeps both). When unsure, leave the tags as they are.

Hard rules: use ONLY the allowed enum/tag values; never invent values. Be precise and terse.

Output ONLY a JSON array of objects, one per spell, in the same order. No prose, no markdown fences.

Spells:
{json.dumps(items, ensure_ascii=False)}
"""


def call_claude(prompt, model):
    proc = subprocess.run(
        ["claude", "-p", prompt, "--model", model, "--output-format", "text"],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed: {proc.stderr[:300]}")
    return proc.stdout.strip()


def parse_array(text):
    """Pull a JSON array out of the model's reply, tolerating stray fences."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON array in reply: {text[:200]}")
    return json.loads(text[start:end + 1])


def clean(rec, spell, tag_set):
    """Coerce one record to the schema, dropping anything off-enum."""
    cur = set(spell.get("tags", []))
    role = rec.get("role")
    return {
        "role": role if role in ROLES else "utility",
        "archetypes": [a for a in (rec.get("archetypes") or []) if a in ARCHETYPES][:3],
        "targeting": rec.get("targeting") if rec.get("targeting") in TARGETING else "one-enemy",
        "tempo": rec.get("tempo") if rec.get("tempo") in TEMPO else "sustained",
        "synergy": str(rec.get("synergy", ""))[:200],
        "tag_add": [t for t in (rec.get("tag_add") or []) if t in tag_set and t not in cur],
        "tag_remove": [t for t in (rec.get("tag_remove") or []) if t in cur],
    }


def main():
    args = sys.argv[1:]
    spells = json.load(open(SPELLS))
    cache = load_json(OUT, {})
    tag_vocab = [t["id"] for t in load_json(TAXO, {"tags": []})["tags"]]
    tag_set = set(tag_vocab)

    if "--audit" in args:
        for s in spells:
            e = cache.get(spell_key(s))
            if e and (e.get("tag_add") or e.get("tag_remove")):
                print(f"{s['name']} ({s['tradition']} R{s['rank']})  "
                      f"+{e.get('tag_add')}  -{e.get('tag_remove')}")
        return

    if "--merge" in args:
        # Fold every shard file (and any prior cache) into one sorted cache.
        merged = dict(cache)
        shards = [f for f in os.listdir(os.path.dirname(OUT)) if f.startswith(".enrich-shard-")]
        for sf in shards:
            merged.update(load_json(os.path.join(os.path.dirname(OUT), sf), {}))
        with open(OUT, "w") as f:
            json.dump(merged, f, indent=1, ensure_ascii=False, sort_keys=True)
        for sf in shards:
            os.remove(os.path.join(os.path.dirname(OUT), sf))
        print(f"merged {len(shards)} shard(s) -> {len(merged)} spells in {OUT}", file=sys.stderr)
        return

    limit = None
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    model = args[args.index("--model") + 1] if "--model" in args else MODEL

    # Sharded run: a worker writes to its own file so parallel workers never
    # race on one JSON. `--shard I/N` takes every Nth not-yet-done spell.
    shard_i = shard_n = None
    out_path, shard_cache = OUT, cache
    if "--shard" in args:
        shard_i, shard_n = (int(x) for x in args[args.index("--shard") + 1].split("/"))
        out_path = os.path.join(os.path.dirname(OUT), f".enrich-shard-{shard_i}-of-{shard_n}.json")
        shard_cache = load_json(out_path, {})

    done_keys = set(cache) | set(shard_cache)
    todo = [s for s in spells if spell_key(s) not in done_keys]
    if shard_n:
        todo = todo[shard_i::shard_n]
    if limit is not None:
        todo = todo[:limit]
    target = shard_cache if shard_n else cache
    print(f"{len(done_keys)} done · {len(todo)} to enrich · model={model}"
          + (f" · shard {shard_i}/{shard_n}" if shard_n else ""), file=sys.stderr)

    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        try:
            reply = call_claude(build_prompt(batch, tag_vocab), model)
            recs = parse_array(reply)
            by_id = {r.get("id"): r for r in recs if isinstance(r, dict)}
            for j, s in enumerate(batch):
                rec = by_id.get(j)
                if rec is None:
                    continue
                target[spell_key(s)] = clean(rec, s, tag_set)
        except Exception as e:
            print(f"  batch {i}-{i+len(batch)} failed: {e}", file=sys.stderr)
            continue
        # Persist after every batch so the run is crash-safe / resumable.
        with open(out_path, "w") as f:
            json.dump(target, f, indent=1, ensure_ascii=False, sort_keys=True)
        print(f"  {min(i + BATCH, len(todo))}/{len(todo)} done", file=sys.stderr)

    print(f"wrote {len(target)} spells -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
