#!/usr/bin/env node
// Build and verify the sample characters in data/samples.json by driving the
// real rules engine. The samples double as regression tests:
//
//   node scripts/build_samples.mjs           # verify samples.json + assertions
//   node scripts/build_samples.mjs --write   # regenerate samples.json
//
// The books contain no pregenerated characters, so these builds follow each
// path's printed guidance (key attributes, training-table flavor) and use
// names from the core book's name lists.

import { readFile, writeFile } from "node:fs/promises";

// data.js fetches over HTTP in the browser; shim it onto the filesystem.
globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};

const { loadRules } = await import("../js/data.js");
const { compute, newCharacter, legalTraditionsFor, legalSpellsFor } = await import("../js/engine.js");

await loadRules();

// ---------------------------------------------------------------------------
// Sample definitions. Each `script` holds ordered queues consumed as the
// resolver walks pending decisions in level order.
// ---------------------------------------------------------------------------

const SAMPLES = [
  {
    base: {
      name: "Fiona of the Tower Arcane",
      ancestry: "Human", level: 1, novicePath: "Magician",
      notes: "Sample build — studied at a great institution of magic (Magician Training 4). High Intellect per the path guidance; flame and charm magic.",
    },
    script: {
      attributes: ["intellect", "intellect", "will"],
      discoveries: ["Fire", "Enchantment"],
      magicPicks: ["discover", "learn", "learn"],
      spells: ["Flame Missile|Fire", "Control Flame|Fire", "Bewitch|Enchantment", "Distraction|Enchantment", "Choking Smoke|Fire", "Convincing Word|Enchantment"],
      langProf: ["Scribe", "Astrologer", "High Archaic", "Magic"],
    },
    expect: { health: 12, power: 1, intellect: 12, will: 11, spellCount: 7, traditionCount: 2, pending: 0 },
  },
  {
    base: {
      name: "Cormac, Voice of the Old Faith",
      ancestry: "Human", level: 3, novicePath: "Priest", religion: "Old Faith", expertPath: "Druid",
      notes: "Sample build — initiated into the Old Faith (Priest Training 2), walking the Druid's path. Traditions limited to his religion: Life, Nature, Primal.",
    },
    script: {
      attributes: ["will", "strength", "will", "strength", "agility"],
      discoveries: ["Life", "Nature", "Primal"],
      magicPicks: ["discover", "learn", "learn", "learn", "discover"],
      spells: "auto",
      langProf: ["Farmer", "Herbalist", "Dwarfish", "Initiate of the Old Faith", "Nature"],
    },
    expect: { power: 2, traditionCount: 3, pending: 0 },
  },
  {
    base: {
      name: "Grin, Guild Knife",
      ancestry: "Goblin", level: 2, novicePath: "Rogue",
      notes: "Sample build — guild-trained cutpurse (Rogue Training 2) who dabbles in magic: the Magic roguery talent grants Power and shadow tricks.",
      inventory: [
        { id: "grin-leathers", name: "Soft Leather", qty: 1, defense: "Agility+1", requirement: null, type: "Clothing", armor: true, equipped: true },
        { id: "grin-loot", name: "Mail", qty: 1, defense: "15", requirement: "Strength 13", type: "Medium Armor", armor: true, equipped: false, notes: "Stolen — for selling, not wearing" },
      ],
    },
    script: {
      attributes: ["agility", "intellect"],
      discoveries: ["Shadow", "Illusion"],
      magicPicks: ["discover", "learn"],
      spells: "auto",
      talents: ["Magic"],
      langProf: ["Thief", "Smuggler", "Pickpocket"],
    },
    // Soft Leather: Defense = Agility 13 + 1. The unequipped (and unwearable)
    // mail must affect nothing.
    expect: { power: 1, traditionCount: 2, agility: 13, defense: 14, speed: 10, pending: 0 },
  },
  {
    base: {
      name: "Torga Stonejaw",
      ancestry: "Dwarf", level: 4, novicePath: "Warrior",
      notes: "Sample build — militia veteran (Warrior Training 3). Takes Shake it Off at level 4; no magic at all.",
      inventory: [
        { id: "torga-brigandine", name: "Brigandine", qty: 1, defense: "13", requirement: "Strength 11", type: "Light Armor", armor: true, equipped: true },
      ],
    },
    script: {
      attributes: ["strength", "agility"],
      options: { "Level 4 Dwarf Benefit": 1 },
      langProf: ["Miner", "Brewer", "Militia member"],
    },
    // Brigandine replaces Agility 10 with 13; Strength 11 meets the
    // requirement exactly, so the dwarf Speed 8 is untouched.
    expect: { health: 31, power: 0, spellCount: 0, talentHas: "Shake it Off", defense: 13, speed: 8, pending: 0 },
  },
  {
    base: {
      name: "Walter the Unyielding",
      ancestry: "Human", level: 7, novicePath: "Warrior", expertPath: "Fighter", masterPath: "Dreadnaught",
      notes: "Sample build — pit fighter turned iron-clad wall (Warrior Training 1). Tests the full novice → expert → master spine with Determined at level 4.",
      inventory: [
        { id: "walter-mail", name: "Mail", qty: 1, defense: "15", requirement: "Strength 13", type: "Medium Armor", armor: true, equipped: true },
        { id: "walter-shield", name: "Large shield", qty: 1, damage: "1d3", hands: "Off", properties: "Size 1, Defensive +2", requirement: "Strength 11", weapon: true, equipped: true },
      ],
    },
    script: {
      attributes: ["strength", "agility", "strength", "will", "strength", "agility", "will"],
      options: { "Level 4 Human Benefit": 1 },
      langProf: ["Pit fighter", "Laborer", "Dark Speech", "Mercenary", "Officer"],
    },
    // Mail (15) replaces Agility 12, the shield's Defensive +2 and the
    // Warrior level 5 +1 stack on top: Defense 18. Strength 14 meets both
    // requirements; medium armor doesn't slow him.
    expect: { power: 0, spellCount: 0, talentHas: "Iron Clad", defense: 18, speed: 10, pending: 0 },
  },
];

// ---------------------------------------------------------------------------
// Auto-resolver
// ---------------------------------------------------------------------------

function resolveAll(spec) {
  const char = { ...newCharacter(spec.base.name), ...spec.base };
  const q = {
    attributes: [...(spec.script.attributes || [])].filter((a) => ["strength", "agility", "intellect", "will"].includes(a)),
    discoveries: [...(spec.script.discoveries || [])],
    magicPicks: [...(spec.script.magicPicks || [])],
    spells: spec.script.spells === "auto" ? "auto" : [...(spec.script.spells || [])],
    talents: [...(spec.script.talents || [])],
    langProf: [...(spec.script.langProf || [])],
  };

  for (let round = 0; round < 30; round++) {
    const out = compute(char);
    const pending = out.pending
      .filter((p) => p.kind !== "choose_path")
      .sort((a, b) => (a.level - b.level) || a.id.localeCompare(b.id));
    if (!pending.length) return { char, out };
    let progressed = false;
    for (const p of pending) {
      const res = resolveOne(char, out, p, q);
      if (res) {
        char.decisions[p.id] = res;
        progressed = true;
        break; // recompute — resolutions can spawn new slots
      }
    }
    if (!progressed) {
      throw new Error(`${spec.base.name}: stuck with pending ${pending.map((p) => p.kind + "@" + p.id).join(", ")}`);
    }
  }
  throw new Error(`${spec.base.name}: did not converge`);
}

function resolveOne(char, out, p, q) {
  switch (p.kind) {
    case "attribute_choice": {
      const attrs = [];
      for (const a of q.attributes) {
        if (attrs.length < p.count && !attrs.includes(a)) attrs.push(a);
      }
      if (attrs.length < p.count) {
        for (const a of ["strength", "agility", "intellect", "will"]) {
          if (attrs.length < p.count && !attrs.includes(a)) attrs.push(a);
        }
      }
      q.attributes = q.attributes.filter((a) => !attrs.includes(a) || q.attributes.indexOf(a) !== q.attributes.lastIndexOf(a));
      for (const a of attrs) {
        const i = q.attributes.indexOf(a);
        if (i !== -1) q.attributes.splice(i, 1);
      }
      return { attrs };
    }
    case "discover": {
      const legal = legalTraditionsFor(char, out, p);
      const want = q.discoveries.find((t) => legal.includes(t)) || legal[0];
      if (!want) return null;
      q.discoveries = q.discoveries.filter((t) => t !== want);
      return { kind: "discover", tradition: want };
    }
    case "magic_pick": {
      const action = q.magicPicks.shift() || "learn";
      if (action === "discover") {
        const legal = legalTraditionsFor(char, out, p);
        const want = q.discoveries.find((t) => legal.includes(t)) || legal[0];
        if (want) {
          q.discoveries = q.discoveries.filter((t) => t !== want);
          return { kind: "discover", tradition: want };
        }
      }
      const spell = pickSpell(char, out, p, q);
      return spell ? { kind: "learn", ...spell } : null;
    }
    case "learn_spell": {
      const spell = pickSpell(char, out, p, q);
      return spell || null;
    }
    case "talent_choice": {
      const want = q.talents.shift() || p.pool[0].name;
      return { talent: want };
    }
    case "option_choice": {
      const idx = (qOptions(char, p) ?? 0);
      return { option: idx };
    }
    case "lang_prof": {
      return { text: q.langProf.shift() || "Common Tongue" };
    }
  }
  return null;

  function qOptions(char, p) {
    const spec = SAMPLES.find((s) => s.base.name === char.name);
    return spec?.script.options?.[p.title];
  }
}

function pickSpell(char, out, p, q) {
  const legal = legalSpellsFor(char, out, p);
  if (!legal.length) return null;
  if (q.spells !== "auto") {
    for (let i = 0; i < q.spells.length; i++) {
      const [name, tradition] = q.spells[i].split("|");
      const hit = legal.find((s) => s.name === name && s.tradition === tradition);
      if (hit) {
        q.spells.splice(i, 1);
        return { spell: hit.name, tradition: hit.tradition };
      }
    }
  }
  return { spell: legal[0].name, tradition: legal[0].tradition };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function check(name, expect, out) {
  const fails = [];
  const got = {
    health: out.health, power: out.power, defense: out.defense, speed: out.speed,
    strength: out.attributes.strength, agility: out.attributes.agility,
    intellect: out.attributes.intellect, will: out.attributes.will,
    spellCount: out.spells.length, traditionCount: out.discovered.length,
    pending: out.pending.filter((p) => p.kind !== "choose_path").length,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (k === "talentHas") {
      if (!out.talents.some((t) => t.name.includes(v))) fails.push(`missing talent ${v}`);
    } else if (got[k] !== v) {
      fails.push(`${k}: expected ${v}, got ${got[k]}`);
    }
  }
  return fails;
}

// ---------------------------------------------------------------------------
// Equipped-gear engine checks (core p. 35, 101, 103). These cover rule
// corners the user-facing samples shouldn't model — e.g. wearing armor whose
// Strength requirement is unmet — and never touch samples.json.
// ---------------------------------------------------------------------------

const GEAR_CHECKS = [
  {
    name: "heavy armor with unmet Strength requirement",
    // Defense 17 still replaces Agility 10; Speed 10 loses 2 for heavy
    // armor and 2 more for the unmet requirement.
    inventory: [
      { id: "t1", name: "Plate and Mail", qty: 1, defense: "17", requirement: "Strength 15", type: "Heavy Armor", armor: true, equipped: true },
    ],
    expect: { defense: 17, speed: 6 },
  },
  {
    name: "Agility-based armor stacks with a shield",
    inventory: [
      { id: "t1", name: "Soft Leather", qty: 1, defense: "Agility+1", type: "Clothing", armor: true, equipped: true },
      { id: "t2", name: "Small shield", qty: 1, damage: "1", hands: "Off", properties: "Defensive +1", requirement: "Strength 9", weapon: true, equipped: true },
    ],
    expect: { defense: 12, speed: 10 },
  },
  {
    name: "unequipped armor is ignored",
    inventory: [
      { id: "t1", name: "Mail", qty: 1, defense: "15", requirement: "Strength 13", type: "Medium Armor", armor: true, equipped: false },
    ],
    expect: { defense: 10, speed: 10 },
  },
];

// ---------------------------------------------------------------------------

const write = process.argv.includes("--write");
const samples = [];
let failed = 0;

for (const gc of GEAR_CHECKS) {
  const char = Object.assign(newCharacter("Gear Check"), { inventory: gc.inventory });
  const fails = check(gc.name, gc.expect, compute(char));
  if (fails.length) {
    failed++;
    console.error(`✗ gear: ${gc.name}\n   ${fails.join("\n   ")}`);
  } else {
    console.log(`✓ gear: ${gc.name}`);
  }
}

for (const spec of SAMPLES) {
  const { char, out } = resolveAll(spec);
  const fails = check(spec.base.name, spec.expect, out);
  const summary = `health ${out.health} · power ${out.power} · defense ${out.defense} · ${out.spells.length} spells · ${out.discovered.length} traditions · ${out.talents.length} talents`;
  if (fails.length) {
    failed++;
    console.error(`✗ ${spec.base.name} — ${summary}\n   ${fails.join("\n   ")}`);
  } else {
    console.log(`✓ ${spec.base.name} — ${summary}`);
  }
  delete char.id;
  delete char.log;
  samples.push(char);
}

if (write) {
  const outPath = new URL("../data/samples.json", import.meta.url);
  await writeFile(outPath, JSON.stringify(samples, null, 1));
  console.log(`\nwrote ${samples.length} samples -> data/samples.json`);
} else {
  // Verify the committed file matches what the engine produces today.
  try {
    const committed = JSON.parse(await readFile(new URL("../data/samples.json", import.meta.url), "utf8"));
    const fresh = JSON.stringify(samples);
    if (JSON.stringify(committed) !== fresh) {
      console.error("\n✗ data/samples.json is stale — run with --write to regenerate");
      failed++;
    } else {
      console.log("\ndata/samples.json is in sync with the engine");
    }
  } catch {
    console.error("\n✗ data/samples.json missing — run with --write");
    failed++;
  }
}

process.exit(failed ? 1 : 0);
