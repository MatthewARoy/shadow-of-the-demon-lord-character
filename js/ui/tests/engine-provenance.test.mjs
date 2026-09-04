import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// data.js fetches over HTTP in the browser; shim it onto the filesystem the
// same way scripts/build_samples.mjs does.
globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};

const { loadRules } = await import("../../data.js");
const { compute, newCharacter } = await import("../../engine.js");
await loadRules();

// The consent gate is a render-time decision, so every piece of prose the
// engine emits has to carry the book it came from. Without this the sheet
// cannot tell an Occult Philosophy talent from a core one.
function build(expertPath, ancestry = "Human") {
  const c = newCharacter("Provenance Probe");
  c.level = 3;
  c.ancestry = ancestry;
  c.novicePath = "Magician";
  c.expertPath = expertPath;
  return compute(c);
}

test("talents emitted from a supplement path carry that book", () => {
  const out = build("Ascendant");           // Occult Philosophy expert path
  const talents = out.talents.filter((t) => t.text);
  assert.ok(talents.length > 0, "expected the path to contribute talents");
  assert.ok(
    talents.some((t) => t.book === "occult"),
    `no talent carried book "occult"; saw ${JSON.stringify(talents.map((t) => t.book))}`
  );
});

test("every emitted talent carries some book tag", () => {
  const out = build("Ascendant");
  for (const t of out.talents.filter((t) => t.text)) {
    assert.ok(typeof t.book === "string" && t.book, `talent ${t.name} has no book tag`);
  }
});

test("pending decisions carrying prose carry their book too", () => {
  const out = build("Ascendant");
  for (const p of out.pending.filter((p) => p.desc || (p.pool || []).some((x) => x.text))) {
    assert.ok(typeof p.book === "string" && p.book, `pending ${p.id} has no book tag`);
  }
});

test("notes emitted from path effects carry their book", () => {
  const out = build("Ascendant");
  for (const n of out.notes.filter((n) => n.text)) {
    assert.ok(typeof n.book === "string" && n.book, `note "${n.text.slice(0, 30)}" has no book tag`);
  }
});

test("traits from a supplement ancestry carry that book", () => {
  const out = build("Ascendant", "Elf");   // Elf is Terrible Beauty
  assert.ok(out.traits.length > 0, "expected the ancestry to contribute traits");
  for (const t of out.traits.filter((t) => t.text)) {
    assert.equal(t.book, "terrible", `trait ${t.name} carried book ${t.book}`);
  }
});

test("traits from a core ancestry are not gated by accident", () => {
  const out = build("Ascendant", "Changeling");
  assert.ok(out.traits.length > 0);
  for (const t of out.traits.filter((t) => t.text)) {
    assert.equal(t.book, "core", `trait ${t.name} carried book ${t.book}`);
  }
});

// The gate fails closed, which is right for rulebook prose and wrong for text
// the app writes itself. An equipment warning or a "pick again" diagnostic is
// ours, not the publisher's, and must never be withheld — the sheet gates
// every note, so an untagged one silently disappears.
import { proseAllowed, setConsent } from "../../consent.js";

test("app-written notes stay visible to a reader who has given no consent", () => {
  setConsent(false);
  const c = newCharacter("Overburdened");
  c.level = 1;
  c.novicePath = "Magician";
  c.inventory = [{
    id: "it-1", name: "Plate", equipped: true, defense: "16",
    type: "heavy", requirement: "Strength 13",
  }];
  const out = compute(c);
  const warning = out.notes.find((n) => /requires Strength 13/.test(n.text));
  assert.ok(warning, `expected the requirement warning; saw ${JSON.stringify(out.notes.map((n) => n.text))}`);
  assert.ok(proseAllowed(warning.book), `the app's own warning was gated (book=${warning.book})`);
});

test("every emitted note carries a book the gate can judge", () => {
  setConsent(false);
  const c = newCharacter("Note Probe");
  c.level = 3;
  c.novicePath = "Magician";
  c.expertPath = "Ascendant";
  c.inventory = [{ id: "it-1", name: "Plate", equipped: true, defense: "16", type: "heavy", requirement: "Strength 13" }];
  for (const n of compute(c).notes) {
    assert.ok(typeof n.book === "string" && n.book, `note has no book: ${n.text.slice(0, 60)}`);
  }
});
