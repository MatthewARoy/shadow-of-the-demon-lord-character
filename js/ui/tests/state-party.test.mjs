import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// state.js is browser code: it reads and writes localStorage and raises
// toasts. A Map-backed storage and a document with no toast box (showToast
// returns early) are all it needs under node. data.js fetches over HTTP; shim
// that onto the filesystem as engine-provenance.test.mjs does, because
// isUsable() runs the real compute().
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
const { compute, newCharacter } = await import("../../engine.js");
const { validateCharacter } = await import("../../sync/validate.js");
const { hashCharacter } = await import("../../sync/hash.js");
const { isPristine } = await import("../../sync/plan.js");
const { SITE } = await import("../../site.js");
const state = await import("../../state.js");
const { renderBuilder } = await import("../builder.js");
const {
  store, load, active, addCharacter, deleteActive, removeCharacter, importCharacter,
  normalizeCharacter, setParty, viewParty, stopViewing, isViewing, viewingEntry,
  applyRemote, isUsable, makeOwnCopy,
} = state;
await loadRules();

const KEY = "sotdl_ledger_v2";
const SAMPLES = JSON.parse(await readFile(new URL("../../../data/samples.json", import.meta.url), "utf8"));
// Samples ship without id and log; this is how they sit in a roster.
const asImported = (sample) => ({ ...newCharacter(), ...structuredClone(sample) });
const stored = () => JSON.parse(memory.get(KEY));

function reset(characters = [newCharacter("Mine")]) {
  memory.clear();
  store.characters = characters;
  store.activeId = characters[0]?.id ?? null;
  store.party = [];
  store.viewingId = null;
  store.listeners = [];
}

function assertValid(c, label = "character") {
  assert.deepEqual(validateCharacter(c).errors, [], `${label} should validate`);
}

const partyEntry = (character, ownerName = "Ysolde") => ({
  id: character.id, ownerId: "m-other", ownerName, rev: 3, updatedAt: 1_000, character,
});

// Saved before exchanges, wishlist and the insanity/corruption adjustments
// existed, with a hand-edited inventory, a stray field and an export stamp.
function legacyCharacter() {
  return {
    version: 2, id: "legacy-1", name: "Old Ledger", ancestry: "Human", level: 2,
    novicePath: null, expertPath: null, masterMode: "master", masterPath: null,
    secondExpertPath: null, religion: null, attributeSwap: null, sizeChoice: null,
    decisions: {}, damage: 3, expended: {},
    inventory: [
      { id: "it-rope", name: "Rope", qty: "3" },
      { id: "it-torch", name: "Torch", qty: -2 },
      { name: "Mystery Box" },
    ],
    coins: "4 cp", notes: "", log: [],
    favouriteColour: "red",
    dataRev: "0ld0ld0ld0ld",
  };
}

// --- normalizeCharacter -------------------------------------------------------

test("normalizeCharacter repairs a legacy character so it validates, keeping its id", () => {
  const legacy = legacyCharacter();
  const before = structuredClone(legacy);
  assert.equal(validateCharacter(legacy).ok, false, "the fixture should start out invalid");

  const c = normalizeCharacter(legacy);
  assertValid(c, "normalized legacy character");
  assert.equal(c.id, "legacy-1");
  assert.deepEqual(c.exchanges, []);
  assert.deepEqual(c.wishlist, []);
  assert.equal(c.insanityAdjust, 0);
  assert.equal(c.corruptionAdjust, 0);
  assert.equal(c.fateDice, 0);
  assert.deepEqual(c.inventory.map((it) => it.qty), [3, 1, undefined]);
  assert.equal(typeof c.inventory[2].id, "string");
  assert.ok(c.inventory[2].id.length > 0);
  assert.equal("favouriteColour" in c, false);
  assert.equal("dataRev" in c, false);
  assert.deepEqual(legacy, before, "the input is not modified");
});

test("normalizeCharacter mints a new id only when asked to", () => {
  assert.notEqual(normalizeCharacter(legacyCharacter(), { keepId: false }).id, "legacy-1");
  const { id: _, ...noId } = legacyCharacter();
  const c = normalizeCharacter(noId);
  assert.equal(typeof c.id, "string");
  assert.notEqual(c.id, newCharacter().id);
  assertValid(c);
});

test("normalizeCharacter keeps a fate dice count and repairs junk to a whole number ≥ 0", () => {
  const fate = (fateDice) => normalizeCharacter({ ...newCharacter(), fateDice }).fateDice;
  assert.equal(fate(2), 2);
  assert.equal(fate(2.7), 2);
  assert.equal(fate(-3), 0);
  assert.equal(fate("2"), 0);
  assert.equal(fate(Number.NaN), 0);
  assert.equal(fate(null), 0);
});

// load() re-normalizes bodies applyRemote stored verbatim; any change to a
// valid body would read as a local edit and push a spurious update.
test("normalizeCharacter is the identity on a valid character", () => {
  for (const sample of SAMPLES) {
    const c = asImported(sample);
    const n = normalizeCharacter(c);
    assert.deepEqual(n, c, sample.name);
    assert.equal(hashCharacter(n), hashCharacter(c), sample.name);
  }
  const blank = newCharacter();
  assert.deepEqual(normalizeCharacter(blank), blank);
});

test("every shipped sample validates after importCharacter", () => {
  reset();
  for (const sample of SAMPLES) {
    const c = importCharacter(JSON.stringify({ ...sample }));
    assertValid(c, sample.name);
  }
});

test("importCharacter keeps its behaviour: new id, unique name, no dataRev, unknown keys dropped", () => {
  reset();
  const first = importCharacter(JSON.stringify(legacyCharacter()));
  const second = importCharacter(JSON.stringify(legacyCharacter()));
  assert.notEqual(first.id, "legacy-1");
  assert.notEqual(first.id, second.id);
  assert.equal(first.name, "Old Ledger");
  assert.equal(second.name, "Old Ledger (2)");
  assert.equal("dataRev" in first, false);
  assert.equal("favouriteColour" in first, false);
  assertValid(first);
  assert.equal(store.activeId, second.id);
  assert.throws(() => importCharacter(JSON.stringify({ name: "No ancestry" })), /recognizable/);
});

// The committed js/site.js is the GitHub Pages build (sync off); the
// Cloudflare build stages a site.js with sync on. Run fn as that build.
function withSync(fn) {
  const was = SITE.syncEnabled;
  SITE.syncEnabled = true;
  try {
    return fn();
  } finally {
    SITE.syncEnabled = was;
  }
}

// Counts storage writes and toasts (showToast looks up #roll-toast first).
function watch(fn, { failWrites = false } = {}) {
  const { setItem } = globalThis.localStorage;
  const { getElementById } = globalThis.document;
  const seen = { writes: 0, toasts: 0 };
  globalThis.localStorage.setItem = (k, v) => {
    seen.writes++;
    if (failWrites) throw new Error("QuotaExceededError");
    setItem(k, v);
  };
  globalThis.document.getElementById = (id) => {
    if (id === "roll-toast") seen.toasts++;
    return null;
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    fn();
  } finally {
    globalThis.localStorage.setItem = setItem;
    globalThis.document.getElementById = getElementById;
    console.error = quiet;
  }
  return seen;
}

test("load() migrates a legacy roster in storage and rewrites it (sync build)", () => {
  reset([]);
  memory.set(KEY, JSON.stringify({ characters: [legacyCharacter()], activeId: "legacy-1" }));
  withSync(() => load());
  assert.equal(store.characters.length, 1);
  assertValid(store.characters[0], "loaded legacy character");
  assert.equal(store.activeId, "legacy-1");
  assertValid(stored().characters[0], "rewritten storage record");
});

// The GitHub Pages build must keep what the app before party sync kept:
// importCharacter there let unknown top-level keys and nested item fields
// through, and Export round-tripped them.
test("with sync off, load() keeps the stored roster exactly as it was and writes nothing", () => {
  reset([]);
  const kept = {
    ...legacyCharacter(),
    homebrewTrait: "Darkvision",
    inventory: [{ id: "x", name: "Bag", contents: [{ name: "coin" }] }],
    novicePath: 7,
    masterMode: "Master",
  };
  const raw = JSON.stringify({ characters: [kept], activeId: "legacy-1" });
  memory.set(KEY, raw);
  const seen = watch(() => load());
  assert.equal(seen.writes, 0);
  assert.equal(memory.get(KEY), raw);
  assert.deepEqual(store.characters, [kept]);
  assert.equal(store.activeId, "legacy-1");
});

test("with sync on, load() writes only when normalizing changed something, and never toasts", () => {
  reset([]);
  const valid = SAMPLES.map(asImported);
  const raw = JSON.stringify({ characters: valid, activeId: valid[1].id });
  memory.set(KEY, raw);
  assert.equal(withSync(() => watch(() => load())).writes, 0, "a roster that needs no repair is not rewritten");
  assert.equal(memory.get(KEY), raw);

  memory.set(KEY, JSON.stringify({ characters: [legacyCharacter()], activeId: "legacy-1" }));
  assert.equal(withSync(() => watch(() => load())).writes, 1, "a repair is saved");

  memory.set(KEY, JSON.stringify({ characters: [legacyCharacter()], activeId: "legacy-1" }));
  const blocked = withSync(() => watch(() => load(), { failWrites: true }));
  assert.equal(blocked.writes, 1);
  assert.equal(blocked.toasts, 0, "no 'changes will be lost' toast at boot: nothing was changed");
  assertValid(store.characters[0], "the repaired copy is still used in memory");
});

// Normalizing must never be able to drop the roster: the next save() would
// write the fallback "Unnamed Soul" over every stored character.
test("load() keeps the roster when normalizing would need structuredClone or Object.hasOwn", () => {
  reset([]);
  const valid = SAMPLES.slice(0, 4).map(asImported);
  memory.set(KEY, JSON.stringify({ characters: valid, activeId: valid[0].id }));
  const { structuredClone: clone } = globalThis;
  const { hasOwn } = Object;
  delete globalThis.structuredClone;
  delete Object.hasOwn;
  const warn = console.warn;
  console.warn = () => {};
  try {
    withSync(() => load());
  } finally {
    globalThis.structuredClone = clone;
    Object.hasOwn = hasOwn;
    console.warn = warn;
  }
  assert.deepEqual(store.characters.map((c) => c.name), valid.map((c) => c.name));
  state.save();
  assert.deepEqual(stored().characters.map((c) => c.name), valid.map((c) => c.name));
});

// --- shapes the Build tab cannot draw -------------------------------------------

// decisions values reach builder.js's resolvedPanel/attrCard, which read
// res.attrs as an array of strings.
const BAD_DECISIONS = [
  ["creation:prof:0", null],
  ["creation:prof:0", { attrs: "will" }],
  ["creation[Human]:0:attr:0", { attrs: 5 }],
];

test("normalizeCharacter drops decision values of a shape the app never writes", () => {
  for (const [slot, value] of BAD_DECISIONS) {
    const c = normalizeCharacter({ ...newCharacter("Grief"), decisions: { [slot]: value, keep: { attrs: ["Will"] } } });
    assert.deepEqual(c.decisions, { keep: { attrs: ["Will"] } }, JSON.stringify(value));
    assertValid(c);
  }
});

test("the Build tab renders a stored character with a malformed decision instead of throwing", () => {
  const el = { innerHTML: "", dataset: {}, querySelector: () => null, addEventListener() {} };
  for (const [slot, value] of BAD_DECISIONS) {
    const c = { ...newCharacter("Grief"), decisions: { [slot]: value } };
    reset([c]);
    assert.doesNotThrow(() => renderBuilder(el), JSON.stringify(value));
    assert.ok(el.innerHTML.length > 0);
  }
});

// --- another tab ------------------------------------------------------------------

test("another tab's save reaches this tab's roster, which keeps its own selection", async () => {
  const first = newCharacter("First");
  const second = newCharacter("Second");
  reset([]);
  memory.set(KEY, JSON.stringify({ characters: [first, second], activeId: first.id }));
  const other = await import("../../state.js?tab=other");
  load();
  other.load();
  other.store.activeId = second.id;          // the other tab shows a different character
  let reloads = 0;
  other.onReload(() => reloads++);

  const xan = addCharacter("Xan");            // this tab
  assert.equal(other.store.characters.some((c) => c.id === xan.id), false, "not seen yet");
  assert.equal(other.refreshFromStorage(), true);
  assert.deepEqual(other.store.characters.map((c) => c.name), ["First", "Second", "Xan"]);
  assert.equal(other.store.activeId, second.id);
  assert.equal(reloads, 1);
  assert.equal(other.refreshFromStorage(), false, "nothing new since");
  assert.equal(reloads, 1);
  assert.equal(other.ownCharacters(), other.store.characters);

  other.save();                               // its next save keeps this tab's character
  assert.ok(stored().characters.some((c) => c.id === xan.id));
});

// --- viewing ------------------------------------------------------------------

test("active() while viewing is a fresh copy on every call, and edits never stick", () => {
  reset();
  const theirs = asImported(SAMPLES[0]);
  const snapshot = structuredClone(theirs);
  setParty([partyEntry(theirs)]);
  assert.equal(viewParty(theirs.id), true);
  assert.equal(isViewing(), true);

  const a = active();
  const b = active();
  assert.notEqual(a, b);
  assert.notEqual(a, store.party[0].character);
  a.name = "Defaced";
  a.level = 9;
  a.inventory.push({ id: "x", name: "Stolen", qty: 1 });
  state.save();
  assert.deepEqual(store.party[0].character, snapshot);
  assert.deepEqual(active(), snapshot);
  assert.equal(store.characters.length, 1);
  assert.equal(store.characters[0].name, "Mine");
});

test("deleteActive() refuses while viewing and the own roster is untouched", () => {
  const mine = [newCharacter("One"), newCharacter("Two")];
  reset(mine);
  const ids = mine.map((c) => c.id);
  const theirs = asImported(SAMPLES[1]);
  setParty([partyEntry(theirs)]);
  viewParty(theirs.id);
  assert.equal(deleteActive(), false);
  assert.deepEqual(store.characters.map((c) => c.id), ids);
  assert.equal(store.activeId, ids[0]);
  assert.equal(isViewing(), true);

  stopViewing();
  assert.equal(deleteActive(), true);
  assert.deepEqual(store.characters.map((c) => c.id), [ids[1]]);
});

test("viewParty() ignores an id that is not in the party", () => {
  reset();
  assert.equal(viewParty("nobody"), false);
  assert.equal(store.viewingId, null);
});

test("setParty() without the viewed entry stops viewing", () => {
  reset();
  const theirs = asImported(SAMPLES[0]);
  const other = asImported(SAMPLES[1]);
  setParty([partyEntry(theirs), partyEntry(other)]);
  viewParty(theirs.id);
  state.save();
  assert.equal(stored().viewingId, theirs.id);

  setParty([partyEntry(other)]);
  assert.equal(store.viewingId, null);
  assert.equal(viewingEntry(), null);
  assert.equal(active(), store.characters[0]);
  assert.equal("viewingId" in stored(), false);
});

test("a viewingId restored by load() waits for setParty()", () => {
  const mine = newCharacter("Mine");
  const theirs = asImported(SAMPLES[2]);
  reset([]);
  memory.set(KEY, JSON.stringify({ characters: [mine], activeId: mine.id, viewingId: theirs.id }));
  load();
  assert.equal(store.viewingId, theirs.id);
  assert.equal(isViewing(), false, "no party yet: the own character shows");
  assert.equal(active().id, mine.id);

  setParty([partyEntry(theirs)]);
  assert.equal(isViewing(), true);
  assert.equal(active().id, theirs.id);
});

test("adding, importing or removing a character ends viewing", () => {
  const theirs = asImported(SAMPLES[0]);
  for (const act of [
    () => addCharacter("Fresh"),
    () => importCharacter(JSON.stringify(SAMPLES[1])),
    () => removeCharacter("no-such-id", store.activeId),
  ]) {
    reset();
    setParty([partyEntry(theirs)]);
    viewParty(theirs.id);
    act();
    assert.equal(isViewing(), false);
    assert.equal(store.viewingId, null);
  }
});

// --- applyRemote ----------------------------------------------------------------

test("applyRemote add keeps the id and stores the body as received", () => {
  const mine = newCharacter("Mine");
  reset([mine]);
  const body = { ...asImported(SAMPLES[0]), id: "remote-1", dataRev: "keepme" };
  applyRemote({ adds: [body] });
  const got = store.characters.find((c) => c.id === "remote-1");
  assert.ok(got, "added with its own id");
  assert.notEqual(got, body, "a copy, not the engine's object");
  assert.deepEqual(got, body, "not normalized");
  assert.equal(store.activeId, mine.id, "the active character stays active");
  assert.equal(stored().characters.length, 2, "saved");

  applyRemote({ adds: [{ ...body, name: "Duplicate" }] });
  assert.equal(store.characters.filter((c) => c.id === "remote-1").length, 1, "an id already local is skipped");
  assert.equal(store.characters.find((c) => c.id === "remote-1").name, body.name);
});

test("applyRemote pull replaces the character in place", () => {
  const a = newCharacter("A");
  const b = { ...asImported(SAMPLES[0]), id: "b" };
  const c = newCharacter("C");
  reset([a, b, c]);
  const newer = { ...structuredClone(b), name: "B, revised", level: 4 };
  applyRemote({ pulls: [newer] });
  assert.deepEqual(store.characters.map((x) => x.id), [a.id, "b", c.id]);
  assert.equal(store.characters[1].name, "B, revised");
  assert.notEqual(store.characters[1], newer);
});

test("applyRemote removing the active character repoints activeId", () => {
  const a = newCharacter("A");
  const b = newCharacter("B");
  reset([a, b]);
  const arriving = { ...asImported(SAMPLES[0]), id: "arriving" };
  applyRemote({ adds: [arriving], removes: [a.id] });
  assert.deepEqual(store.characters.map((x) => x.id), [b.id, "arriving"]);
  assert.equal(store.activeId, "arriving", "the first added character takes over");

  applyRemote({ removes: ["arriving"] });
  assert.equal(store.activeId, b.id, "with nothing added, the first remaining one");
});

test("applyRemote removing everything leaves one pristine character", () => {
  const a = newCharacter("A");
  reset([a]);
  applyRemote({ removes: [a.id] });
  assert.equal(store.characters.length, 1);
  assert.equal(isPristine(store.characters[0]), true);
  assert.equal(store.activeId, store.characters[0].id);
});

// --- make my copy ------------------------------------------------------------------

test("makeOwnCopy() imports the viewed character under a new id and stops viewing", () => {
  const mine = newCharacter("Mine");
  reset([mine]);
  const theirs = asImported(SAMPLES[3]);
  setParty([partyEntry(theirs)]);
  viewParty(theirs.id);

  const copy = makeOwnCopy();
  assert.ok(copy);
  assert.notEqual(copy.id, theirs.id);
  assert.equal(isViewing(), false);
  assert.equal(store.activeId, copy.id);
  assert.equal(active(), store.characters.find((c) => c.id === copy.id));
  assert.equal(copy.name, theirs.name);
  assert.deepEqual(copy.decisions, theirs.decisions);
  assertValid(copy);
  assert.equal(store.party[0].character.id, theirs.id, "the party entry is untouched");
  assert.equal(makeOwnCopy(), null, "nothing to copy when not viewing");
});

// --- isUsable ------------------------------------------------------------------------

test("isUsable is true for every sample", () => {
  for (const sample of SAMPLES) assert.equal(isUsable(asImported(sample)), true, sample.name);
});

// A body compute() throws on (a spell pick that is a number) must be skipped,
// whatever the validator says about it.
test("isUsable is false for a body compute() throws on", () => {
  let body = null;
  for (const sample of SAMPLES) {
    const key = Object.keys(sample.decisions).find((k) => typeof sample.decisions[k]?.spell === "string");
    if (!key) continue;
    body = asImported(sample);
    body.decisions[key] = { ...body.decisions[key], spell: 5 };
    break;
  }
  assert.ok(body, "expected a sample with a spell pick");
  // The validator now refuses this shape too; isUsable stays as the second
  // line for whatever compute() trips on that validation cannot see.
  assert.equal(validateCharacter(body).ok, false);
  assert.throws(() => compute(body));
  assert.equal(isUsable(body), false);
});
