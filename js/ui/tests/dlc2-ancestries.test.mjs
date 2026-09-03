import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};

const { loadRules, rules } = await import("../../data.js");
const { compute, newCharacter } = await import("../../engine.js");
await loadRules();

const BASES = {
  Ferren:    { attributes: [9, 11, 10, 9], perception: 11, defense: 11, health: 9, size: "1", speed: 10 },
  Hamadryad: { attributes: [9, 10, 9, 11], perception: 10, defense: 10, health: 9, size: "1", speed: 10 },
  Molekin:   { attributes: [11, 9, 10, 10], perception: 11, defense: 9, health: 11, size: "1/2", speed: 10 },
  Naga:      { attributes: [9, 10, 10, 11], perception: 10, defense: 10, health: 9, size: "1", speed: 8 },
  Sylph:     { attributes: [8, 11, 9, 11], perception: 10, defense: 11, health: 8, size: "1", speed: 10 },
  Yerath:    { attributes: [9, 10, 10, 9], perception: 10, defense: 12, health: 9, size: "1", speed: 10 },
};

function character(ancestry, level = 0) {
  const c = newCharacter(`${ancestry} Test`);
  c.ancestry = ancestry;
  c.level = level;
  return c;
}

test("all six DLC2 ancestries have their printed starting statistics", () => {
  const names = Object.keys(BASES);
  assert.deepEqual(
    rules.curated.ancestries.filter((a) => a.source === "dlc2").map((a) => a.name),
    names,
  );
  for (const [name, expected] of Object.entries(BASES)) {
    const out = compute(character(name));
    assert.deepEqual(Object.values(out.attributes), expected.attributes, `${name} attributes`);
    for (const field of ["perception", "defense", "health", "size", "speed"])
      assert.equal(out[field], expected[field], `${name} ${field}`);
    for (const trait of out.traits) assert.equal(trait.book, "dlc2", `${name}: ${trait.name}`);
    assert.equal(out.languagesProfessions[0].book, "dlc2", `${name} language provenance`);
  }
});

test("a naga discovers a tradition at creation", () => {
  const c = character("Naga");
  let out = compute(c);
  const pick = out.pending.find((p) => p.kind === "discover" && p.origin === "Naga");
  assert.ok(pick, "missing Naga creation tradition choice");
  c.decisions[pick.id] = { tradition: "Air" };
  out = compute(c);
  assert.deepEqual(out.discovered.map((d) => d.tradition), ["Air"]);
  assert.ok(out.pending.some((p) => p.title === "Discovery rank 0 spell"));
});

test("yerath caste choices apply their fixed creation benefits", () => {
  const cases = [
    { option: 0, attributes: [11, 10, 10, 10], perception: 10, defense: 12, profession: "laborer" },
    { option: 1, attributes: [9, 11, 10, 9], perception: 11, defense: 12, profession: "guide" },
    { option: 2, attributes: [11, 10, 10, 9], perception: 10, defense: 13, profession: "soldier" },
  ];
  for (const expected of cases) {
    const c = character("Yerath");
    let out = compute(c);
    const caste = out.pending.find((p) => p.title === "Yerath Caste");
    assert.ok(caste, "missing Yerath caste choice");
    c.decisions[caste.id] = { option: expected.option };
    out = compute(c);
    assert.deepEqual(Object.values(out.attributes), expected.attributes);
    assert.equal(out.perception, expected.perception);
    assert.equal(out.defense, expected.defense);
    assert.ok(out.languagesProfessions.some((p) => p.text.includes(expected.profession)));
  }
});

test("each DLC2 ancestry offers its printed level 4 talent", () => {
  const benefits = {
    Ferren:    { talent: "Lynx Form", health: 13 },
    Hamadryad: { talent: "Deep Roots", health: 13 },
    Molekin:   { talent: "Burrower", health: 16 },
    Naga:      { talent: "Invoke the Cosmic Egg", health: 13 },
    Sylph:     { talent: "Zephyr Form", health: 12 },
    Yerath:    { talent: "Swift Wings", health: 13, defense: 13 },
  };
  for (const [name, expected] of Object.entries(benefits)) {
    const c = character(name, 4);
    let out = compute(c);
    const choice = out.pending.find((p) => p.title === `Level 4 ${name} Benefit`);
    assert.ok(choice, `missing ${name} level 4 choice`);
    c.decisions[choice.id] = { option: 1 };
    out = compute(c);
    const gained = out.talents.find((t) => t.name === expected.talent);
    assert.ok(gained, `missing ${expected.talent}`);
    assert.equal(gained.book, "dlc2");
    assert.equal(out.health, expected.health, `${name} level 4 Health`);
    if (expected.defense) assert.equal(out.defense, expected.defense, `${name} level 4 Defense`);
  }
});
