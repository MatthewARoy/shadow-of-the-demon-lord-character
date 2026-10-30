import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Same browser stand-ins as state-party.test.mjs: Map-backed storage, no
// toast box, and data.js fetches shimmed onto the filesystem so isUsable()
// can run the real compute().
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
  clear: () => memory.clear(),
};
globalThis.document = { getElementById: () => null };
globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};

const { loadRules } = await import("../../data.js");
const { newCharacter } = await import("../../engine.js");
const { validateCharacter } = await import("../../sync/validate.js");
const { encodeTransfer, decodeTransfer } = await import("../../transfer.js");
const { store, importRoster, setParty, viewParty, isViewing } = await import("../../state.js");
await loadRules();

const SAMPLES = JSON.parse(await readFile(new URL("../../../data/samples.json", import.meta.url), "utf8"));
// What another device's roster looks like: whole characters with their ids.
const roster = () => SAMPLES.map((s, i) => ({ ...newCharacter(), ...s, id: `transfer-${i}` }));

function reset(characters = [newCharacter()]) {
  memory.clear();
  store.characters = characters;
  store.activeId = characters[0]?.id ?? null;
  store.viewingId = null;
  store.party = [];
}

test("a fresh device takes the whole roster, ids kept, placeholder gone", async () => {
  reset();
  const { characters, dataRev } = await decodeTransfer(await encodeTransfer(roster()));
  const result = importRoster(characters, { dataRev });
  assert.equal(result.added.length, SAMPLES.length);
  assert.deepEqual(store.characters.map((c) => c.id), roster().map((c) => c.id));
  assert.equal(store.activeId, "transfer-0");
  for (const c of store.characters) assert.ok(validateCharacter(c).ok, c.name);
  const saved = JSON.parse(memory.get("sotdl_ledger_v2"));
  assert.equal(saved.characters.length, SAMPLES.length, "persisted");
});

test("pasting the same code twice adds nothing the second time", () => {
  reset();
  importRoster(roster());
  const before = JSON.stringify(store.characters);
  const again = importRoster(roster());
  assert.equal(again.added.length, 0);
  assert.equal(again.already, SAMPLES.length);
  assert.equal(JSON.stringify(store.characters), before);
});

test("existing characters stay; a name clash gets a suffix, not a merge", () => {
  const mine = { ...newCharacter(SAMPLES[0].name), ancestry: "Orc", level: 2 };
  reset([mine]);
  const result = importRoster(roster().slice(0, 1));
  assert.equal(result.added.length, 1);
  assert.equal(store.characters.length, 2, "my own character is not the placeholder and stays");
  assert.equal(store.characters[0], mine);
  assert.equal(store.characters[1].name, `${SAMPLES[0].name} (2)`);
});

test("blank, foreign and oversized entries are skipped and reported", () => {
  reset();
  const blank = newCharacter();
  const notACharacter = { hello: "world" };
  // Too big to sync, and normalizing cannot shrink it.
  const huge = { ...roster()[0], id: "huge", notes: "x".repeat(70_000) };
  const result = importRoster([blank, notACharacter, huge, roster()[1]]);
  assert.deepEqual(result.added.map((c) => c.id), ["transfer-1"]);
  assert.deepEqual(result.skipped.map((s) => s.why).sort(), ["blank", "could not be read", "not a character"]);
});

test("a repairable character is repaired on the way in, never stored invalid", () => {
  reset();
  const messy = { ...roster()[0], id: "messy", exchanges: [{ drop: { name: 1 } }], decisions: { "x:1:0:0": 5 }, junk: true };
  const result = importRoster([messy]);
  assert.deepEqual(result.added.map((c) => c.id), ["messy"]);
  for (const c of store.characters) assert.ok(validateCharacter(c).ok, JSON.stringify(validateCharacter(c).errors));
});

test("nothing usable leaves the roster, the placeholder and storage untouched", () => {
  reset();
  const placeholder = store.characters[0];
  const result = importRoster([newCharacter(), { nope: true }]);
  assert.equal(result.added.length, 0);
  assert.deepEqual(store.characters, [placeholder]);
  assert.equal(memory.has("sotdl_ledger_v2"), false, "no write");
});

test("an id a party member owns arrives as a copy with a new id", () => {
  reset([{ ...newCharacter("Mine"), ancestry: "Orc" }]);
  const theirs = roster()[0];
  setParty([{ id: theirs.id, ownerId: "m-2", ownerName: "Ana", rev: 1, updatedAt: 1, character: theirs }]);
  const result = importRoster([theirs]);
  assert.equal(result.added.length, 1);
  assert.notEqual(result.added[0].id, theirs.id);
});

test("importing ends party viewing and selects the first arrival", () => {
  reset([{ ...newCharacter("Mine"), ancestry: "Orc" }]);
  const theirs = { ...roster()[2], id: "party-char" };
  setParty([{ id: theirs.id, ownerId: "m-2", ownerName: "Ana", rev: 1, updatedAt: 1, character: theirs }]);
  viewParty(theirs.id);
  assert.ok(isViewing());
  importRoster([roster()[0]]);
  assert.equal(isViewing(), false);
  assert.equal(store.activeId, "transfer-0");
});
