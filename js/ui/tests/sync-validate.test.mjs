import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateCharacter, CHARACTER_KEYS, OPTIONAL_KEYS, MAX_BODY_BYTES, MAX_ID_LENGTH,
  MAX_NAME_LENGTH, MAX_TEXT_LENGTH, MAX_NOTES_LENGTH, MAX_INVENTORY_ITEMS, MAX_LOG_ENTRIES,
  MAX_DECISION_KEYS, MAX_DEPTH, MAX_ERRORS,
} from "../../sync/validate.js";
// Test-only: validate.js must not import the engine (it runs in the Worker),
// so the drift check between the two lives here.
import { newCharacter } from "../../engine.js";

const readJson = async (rel) => JSON.parse(await readFile(new URL(`../../../${rel}`, import.meta.url), "utf8"));
const SAMPLES = await readJson("data/samples.json");
const EQUIPMENT = await readJson("data/equipment.json");

// Samples ship without id and log (scripts/build_samples.mjs strips both);
// they only reach a roster through importCharacter, which spreads them over
// newCharacter(). Validate them as they live in the roster.
const asImported = (sample) => ({ ...newCharacter(), ...structuredClone(sample) });

// Inventory entries exactly as js/ui/gear.js builds them from the catalog.
const takeWeapon = (w) => ({ id: crypto.randomUUID(), name: w.name, qty: 1, damage: w.damage, hands: w.hands, properties: w.properties, requirement: w.requirement || null, weapon: true });
const takeArmor = (a) => ({ id: crypto.randomUUID(), name: a.name, qty: 1, defense: a.defense, type: a.type, requirement: a.requirement || null, armor: true });
const takeGear = (g) => ({ id: crypto.randomUUID(), name: g.name, qty: 1 });

function assertValid(c, label = "character") {
  const res = validateCharacter(c);
  assert.deepEqual(res.errors, [], `${label} should validate`);
  assert.equal(res.ok, true);
}

// Fails, and some error message names `path`.
function assertRejects(c, path) {
  const res = validateCharacter(c);
  assert.equal(res.ok, false, `expected a failure naming ${path}`);
  assert.ok(res.errors.some((e) => e.includes(path)), `no error names ${path}: ${JSON.stringify(res.errors)}`);
}

const withField = (patch) => ({ ...newCharacter(), ...patch });

// A decisions object whose total depth (counting decisions itself) is n.
const chain = (n) => (n <= 1 ? {} : { k: chain(n - 1) });

// A character after a few sessions: a sample build plus gear from the
// catalog, spent castings, an exchange, play marks and long notes.
function playedCharacter() {
  const base = SAMPLES.reduce((a, b) => (Object.keys(b.decisions).length > Object.keys(a.decisions).length ? b : a));
  const c = asImported(base);
  const sword = EQUIPMENT.weapons.find((w) => w.requirement);
  const dagger = EQUIPMENT.weapons.find((w) => !w.requirement);
  const mail = EQUIPMENT.armor.find((a) => a.requirement);
  c.inventory = [
    { ...takeWeapon(sword), equipped: true, notes: "Grandfather's; nicked at the hilt." },
    { ...takeWeapon(dagger), qty: 2 },
    { ...takeArmor(mail), equipped: true },
    takeGear(EQUIPMENT.gear[0]),
    { id: crypto.randomUUID(), name: "A stolen reliquary", qty: 1, notes: "Hums at night." },
  ];
  c.expended = { "flame missile|fire": 2, "control flame|fire": 0 };
  c.exchanges = [{ drop: { name: "Control Flame", tradition: "Fire" }, gain: { name: "Fire Ward", tradition: "Fire" } }];
  c.wishlist = ["fire ward|fire", "charm|enchantment"];
  c.attributeSwap = { from: "strength", to: "agility" };
  c.damage = 4;
  c.insanityAdjust = 2;
  c.corruptionAdjust = -1;
  c.coins = "3 gc, 14 ss, a stolen reliquary";
  c.notes = Array.from({ length: 40 }, (_, i) =>
    `Session ${i + 1}. The party crossed the marsh road at dusk — “never again,” said Syrah.\n`
    + "Owes the ferryman 2 ss. The cult of the Red Hand watches the old mill.\n").join("\n");
  c.log = [{ when: 1761700000000, text: "Levelled up" }, "free-form entry", 7, null, ["nested", { ok: true }]];
  c.dataRev = "abc123def456";
  return c;
}

// --- what must pass --------------------------------------------------------

test("newCharacter() passes", () => {
  assertValid(newCharacter());
  assertValid(newCharacter("A different name"));
});

test("every shipped sample passes, as importCharacter would store it", () => {
  assert.ok(SAMPLES.length > 0);
  for (const s of SAMPLES) assertValid(asImported(s), s.name);
});

test("a realistic played character passes, before and after a JSON round-trip", () => {
  const c = playedCharacter();
  assertValid(c);
  assertValid(JSON.parse(JSON.stringify(c)), "round-tripped character");
  // And it fits the Worker's body cap with the {baseRev, character} wrapper.
  const bytes = new TextEncoder().encode(JSON.stringify({ baseRev: 3, character: c })).length;
  assert.ok(bytes < MAX_BODY_BYTES, `${bytes} bytes`);
});

test("every catalog weapon, armor and gear item, as gear.js stores it, passes", () => {
  const c = newCharacter();
  c.inventory = [
    ...EQUIPMENT.weapons.map(takeWeapon),
    ...EQUIPMENT.armor.map((a) => ({ ...takeArmor(a), equipped: true })),
    ...EQUIPMENT.gear.map(takeGear),
  ];
  assertValid(c);
});

test("the optional dataRev is accepted and validation leaves the input untouched", () => {
  const c = withField({ dataRev: "abc123" });
  const before = structuredClone(c);
  assertValid(c);
  assert.deepEqual(c, before);
  assertRejects(withField({ dataRev: 5 }), "dataRev");
});

test("attributeSwap accepts null and a half-set swap (builder.js stores either dropdown alone)", () => {
  assertValid(withField({ attributeSwap: null }));
  assertValid(withField({ attributeSwap: { from: "", to: "will" } }));
});

test("decisions exactly at the depth limit pass", () => {
  assertValid(withField({ decisions: { slot: chain(MAX_DEPTH - 1) } }));
  assertValid(withField({ decisions: chain(MAX_DEPTH) }));
  assertValid(withField({ log: [chain(MAX_DEPTH - 1)] }));
});

test("collection caps admit exactly their limit", () => {
  const items = Array.from({ length: MAX_INVENTORY_ITEMS }, (_, i) => ({ id: `it-${i}`, name: "Torch" }));
  assertValid(withField({ inventory: items }));
  assertValid(withField({ log: Array(MAX_LOG_ENTRIES).fill("x") }));
  assertValid(withField({ decisions: Object.fromEntries(Array.from({ length: MAX_DECISION_KEYS }, (_, i) => [`s${i}`, { pick: i }])) }));
  assertValid(withField({ name: "n".repeat(MAX_NAME_LENGTH), notes: "n".repeat(MAX_NOTES_LENGTH), id: "i".repeat(MAX_ID_LENGTH) }));
});

// --- the key set -----------------------------------------------------------

test("known top-level keys are exactly newCharacter()'s plus optional dataRev", () => {
  const ours = new Set([...CHARACTER_KEYS, ...OPTIONAL_KEYS]);
  const theirs = new Set([...Object.keys(newCharacter()), "dataRev"]);
  assert.deepEqual([...ours].sort(), [...theirs].sort());
  assert.deepEqual([...OPTIONAL_KEYS], ["dataRev"]);
});

test("MAX_BODY_BYTES is the Worker's 64 KiB request cap", () => {
  assert.equal(MAX_BODY_BYTES, 65536);
});

test("validate.js imports nothing, so the Worker can load it", async () => {
  const src = await readFile(new URL("../../sync/validate.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(/);
});

// --- what must fail --------------------------------------------------------

test("exchanges: [{}] fails (issue #37 finding 7)", () => {
  assertRejects(withField({ exchanges: [{}] }), "exchanges[0].drop");
  assertRejects(withField({ exchanges: [{}] }), "exchanges[0].gain");
});

test("exchanges with a missing or mistyped side field fail", () => {
  const ok = { name: "Fire Ward", tradition: "Fire" };
  assertRejects(withField({ exchanges: [{ drop: { name: "Charm" }, gain: ok }] }), "exchanges[0].drop.tradition");
  assertRejects(withField({ exchanges: [{ drop: ok, gain: { name: 3, tradition: "Fire" } }] }), "exchanges[0].gain.name");
  assertRejects(withField({ exchanges: [{ drop: ok, gain: null }] }), "exchanges[0].gain");
  assertRejects(withField({ exchanges: [null] }), "exchanges[0]");
  assertRejects(withField({ exchanges: [{ drop: ok, gain: ok, extra: 1 }] }), "exchanges[0][\"extra\"]");
});

test("each wrong type fails with a message naming the field", () => {
  const item = { id: "it-1", name: "Rope" };
  const cases = [
    ["version", { version: 1 }],
    ["version", { version: "2" }],
    ["id", { id: "" }],
    ["id", { id: 42 }],
    ["name", { name: null }],
    ["ancestry", { ancestry: 3 }],
    ["level", { level: 11 }],
    ["level", { level: -1 }],
    ["level", { level: 1.5 }],
    ["level", { level: "1" }],
    ["novicePath", { novicePath: 3 }],
    ["expertPath", { expertPath: {} }],
    ["masterPath", { masterPath: false }],
    ["secondExpertPath", { secondExpertPath: [] }],
    ["religion", { religion: 0 }],
    ["sizeChoice", { sizeChoice: {} }],
    ["masterMode", { masterMode: "grandmaster" }],
    ["masterMode", { masterMode: null }],
    ["attributeSwap", { attributeSwap: "strength" }],
    ["attributeSwap.from", { attributeSwap: { from: 1, to: "will" } }],
    ["attributeSwap.to", { attributeSwap: { from: "will" } }],
    ["attributeSwap", { attributeSwap: { from: "a", to: "b", extra: "c" } }],
    ["decisions", { decisions: [] }],
    ["decisions", { decisions: null }],
    ["decisions", { decisions: "x" }],
    ["exchanges", { exchanges: {} }],
    ["wishlist", { wishlist: "fire ward|fire" }],
    ["wishlist[0]", { wishlist: [1] }],
    ["damage", { damage: -1 }],
    ["damage", { damage: 1.5 }],
    ["damage", { damage: "0" }],
    ["insanityAdjust", { insanityAdjust: "2" }],
    ["corruptionAdjust", { corruptionAdjust: Number.NaN }],
    ["expended", { expended: [] }],
    ["expended[\"a|b\"]", { expended: { "a|b": -1 } }],
    ["expended[\"a|b\"]", { expended: { "a|b": "1" } }],
    ["inventory", { inventory: {} }],
    ["inventory[0]", { inventory: ["Rope"] }],
    ["inventory[0].id", { inventory: [{ name: "Rope" }] }],
    ["inventory[0].id", { inventory: [{ id: "", name: "Rope" }] }],
    ["inventory[0].name", { inventory: [{ id: "it-1" }] }],
    ["inventory[0].qty", { inventory: [{ ...item, qty: 0 }] }],
    ["inventory[0].qty", { inventory: [{ ...item, qty: "2" }] }],
    ["inventory[0].qty", { inventory: [{ ...item, qty: 1.5 }] }],
    ["inventory[0].equipped", { inventory: [{ ...item, equipped: "yes" }] }],
    ["inventory[0].notes", { inventory: [{ ...item, notes: 5 }] }],
    ["inventory[0][\"damage\"]", { inventory: [{ ...item, damage: { dice: "1d6" } }] }],
    ["inventory[0][\"tags\"]", { inventory: [{ ...item, tags: ["a"] }] }],
    ["coins", { coins: 12 }],
    ["notes", { notes: null }],
    ["log", { log: {} }],
    ["log[0]", { log: [Number.POSITIVE_INFINITY] }],
    ["decisions[\"s\"][\"v\"]", { decisions: { s: { v: undefined } } }],
  ];
  for (const [path, patch] of cases) assertRejects(withField(patch), path);
});

test("an unknown top-level key fails, naming the key", () => {
  assertRejects(withField({ isAdmin: true }), "isAdmin");
  assertRejects(withField({ ownerId: "someone-else" }), "ownerId");
});

test("a __proto__ key from JSON.parse is rejected, at the top and inside decisions", () => {
  const base = JSON.stringify(newCharacter()).slice(0, -1);
  assertRejects(JSON.parse(`${base},"__proto__":{"x":1}}`), "__proto__");
  const c = newCharacter();
  c.decisions = JSON.parse('{"__proto__":{"pick":1}}');
  assertRejects(c, "decisions[\"__proto__\"]");
});

test("a missing field fails, naming it", () => {
  for (const k of CHARACTER_KEYS) {
    const c = newCharacter();
    delete c[k];
    assertRejects(c, `${k} is missing`);
  }
});

test("a non-object root fails", () => {
  for (const bad of [null, undefined, [], [newCharacter()], "character", 2, true, new Date(), new Map()]) {
    const res = validateCharacter(bad);
    assert.equal(res.ok, false, `${Object.prototype.toString.call(bad)} should fail`);
    assert.ok(res.errors.length > 0);
  }
});

test("oversized strings fail", () => {
  assertRejects(withField({ name: "n".repeat(MAX_NAME_LENGTH + 1) }), "name");
  assertRejects(withField({ id: "i".repeat(MAX_ID_LENGTH + 1) }), "id");
  assertRejects(withField({ notes: "n".repeat(MAX_NOTES_LENGTH + 1) }), "notes");
  assertRejects(withField({ coins: "c".repeat(MAX_TEXT_LENGTH + 1) }), "coins");
  assertRejects(withField({ novicePath: "p".repeat(MAX_NAME_LENGTH + 1) }), "novicePath");
  assertRejects(withField({ decisions: { s: { text: "t".repeat(MAX_TEXT_LENGTH + 1) } } }), "decisions[\"s\"][\"text\"]");
  assertRejects(withField({ decisions: { ["k".repeat(MAX_NAME_LENGTH + 1)]: {} } }), "decisions[");
  assertRejects(withField({ inventory: [{ id: "it-1", name: "Rope", notes: "n".repeat(MAX_TEXT_LENGTH + 1) }] }), "inventory[0].notes");
  assertRejects(withField({ log: ["l".repeat(MAX_TEXT_LENGTH + 1)] }), "log[0]");
});

test("decisions or log nested past the depth limit fail", () => {
  assertRejects(withField({ decisions: chain(MAX_DEPTH + 1) }), "decisions");
  assertRejects(withField({ decisions: chain(200) }), "nests deeper");
  assertRejects(withField({ log: [chain(MAX_DEPTH)] }), "log[0]");
});

test("collections past their caps fail", () => {
  const items = Array.from({ length: MAX_INVENTORY_ITEMS + 1 }, (_, i) => ({ id: `it-${i}`, name: "Torch" }));
  assertRejects(withField({ inventory: items }), "inventory");
  assertRejects(withField({ log: Array(MAX_LOG_ENTRIES + 1).fill("x") }), "log");
  const many = Object.fromEntries(Array.from({ length: MAX_DECISION_KEYS + 1 }, (_, i) => [`s${i}`, {}]));
  assertRejects(withField({ decisions: many }), "decisions");
});

test("the error list is capped", () => {
  const junk = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`junk${i}`, i]));
  const res = validateCharacter({ ...newCharacter(), ...junk });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, MAX_ERRORS + 1);
  assert.match(res.errors.at(-1), /and 80 more/);
});

// --- decision values -------------------------------------------------------
// builder.js reads each slot's value as an object, and `attrs` as an array of
// strings (resolvedPanel joins it, attrCard spreads it into a Set). Shapes it
// cannot draw passed compute() and crashed the Build tab, so they must not
// reach the party (or, through Make my copy, a roster).

test("decision values builder.js cannot draw fail, naming the slot", () => {
  const cases = [
    ['decisions["creation:prof:0"]', { "creation:prof:0": null }],
    ['decisions["creation:prof:0"]', { "creation:prof:0": "Strength" }],
    ['decisions["creation:prof:0"]', { "creation:prof:0": ["Strength"] }],
    ['decisions["creation:prof:0"]["attrs"]', { "creation:prof:0": { attrs: "will" } }],
    ['decisions["creation[Human]:0:attr:0"]["attrs"]', { "creation[Human]:0:attr:0": { attrs: 5 } }],
    ['decisions["s"]["attrs"][0]', { s: { attrs: [5] } }],
    ['decisions["s"]["option"]', { s: { option: "1" } }],
    ['decisions["s"]["option"]', { s: { option: -1 } }],
    ['decisions["s"]["spell"]', { s: { spell: 5, tradition: "Fire" } }],
    ['decisions["s"]["tradition"]', { s: { kind: "discover", tradition: null } }],
    ['decisions["s"]["talent"]', { s: { talent: {} } }],
    ['decisions["s"]["text"]', { s: { text: ["x"] } }],
    ['decisions["s"]["kind"]', { s: { kind: 1 } }],
  ];
  for (const [path, decisions] of cases) assertRejects(withField({ decisions }), path);
});

test("every decision shape builder.js writes passes", () => {
  assertValid(withField({
    decisions: {
      a: { attrs: [] },
      b: { attrs: ["Strength", "Will"] },
      c: { option: 0 },
      d: { text: "Common Tongue" },
      e: { kind: "discover", tradition: "Fire" },
      f: { kind: "learn", spell: "Flame Missile", tradition: "Fire" },
      g: { spell: "Flame Missile", tradition: "Fire" },
      h: { talent: "Cantrip" },
    },
  }));
});

// --- the request cap ------------------------------------------------------
// The Worker refuses a request over MAX_BODY_BYTES (UTF-8 bytes) with 413,
// before validating; a character the validator passes must fit in one.

test("a character too large to upload fails validation instead of meeting a 413", () => {
  const notes = "é".repeat(34_000);                   // 34,000 characters, 68,000 bytes
  assert.ok(notes.length <= MAX_NOTES_LENGTH);
  const res = validateCharacter(withField({ notes }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /bytes/.test(e)), JSON.stringify(res.errors));

  // Every character the validator accepts fits the Worker's request cap.
  for (const c of [withField({ notes: "é".repeat(30_000) }), withField({ notes: "n".repeat(MAX_NOTES_LENGTH) })]) {
    assertValid(c);
    const wire = new TextEncoder().encode(JSON.stringify({ baseRev: Number.MAX_SAFE_INTEGER, character: c }));
    assert.ok(wire.length <= MAX_BODY_BYTES, `${wire.length} bytes`);
  }
});
