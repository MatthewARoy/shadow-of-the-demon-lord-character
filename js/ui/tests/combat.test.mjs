import test from "node:test";
import assert from "node:assert/strict";
import { filterEntries, resolveDerive, eligibility, resolveLinks } from "../combat.js";

const PRONE = { id: "affliction-prone", kind: "condition", name: "Prone", group: "afflictions", text: "A prone creature lies on the ground." };
const SHOVE = { id: "attack-shove", kind: "attack", name: "Shove", group: "attack-options", text: "Make a Strength attack roll against the target’s Strength." };
const ESCAPE = { id: "attack-escape", kind: "attack", name: "Escape", group: "attack-options", text: "You can use this action if you are grabbed.", requires: [{ type: "condition", label: "you are grabbed" }], removes: ["affliction-grabbed"], see_also: ["attack-grab"] };
const ENTRIES = [PRONE, SHOVE, ESCAPE];

test("filterEntries returns every entry for the all group and an empty query", () => {
  assert.equal(filterEntries(ENTRIES, "all", "").length, 3);
  assert.equal(filterEntries(ENTRIES, "all", "   ").length, 3);
});

test("filterEntries narrows by group", () => {
  assert.deepEqual(filterEntries(ENTRIES, "afflictions", "").map((e) => e.id), ["affliction-prone"]);
});

test("filterEntries matches name and text case-insensitively", () => {
  assert.deepEqual(filterEntries(ENTRIES, "all", "SHOVE").map((e) => e.id), ["attack-shove"]);
  assert.deepEqual(filterEntries(ENTRIES, "all", "lies on the ground").map((e) => e.id), ["affliction-prone"]);
});

test("filterEntries applies group and query together", () => {
  assert.equal(filterEntries(ENTRIES, "afflictions", "shove").length, 0);
});

test("resolveDerive computes each enum member", () => {
  const computed = { modifiers: { strength: 3 }, speed: 10, size: 1 };
  assert.equal(resolveDerive("str_mod", computed), 3);
  assert.equal(resolveDerive("speed", computed), 10);
  assert.equal(resolveDerive("half_speed", computed), 5);
  assert.equal(resolveDerive("size", computed), 1);
  assert.equal(resolveDerive("reach_from_size", computed), 1);
});

test("resolveDerive rounds odd speed down and fractional Size up", () => {
  assert.equal(resolveDerive("half_speed", { speed: 9 }), 4);
  // Halflings are Size 1/2; Core p.38 rounds reach up, so the 1-yard floor matters.
  assert.equal(resolveDerive("reach_from_size", { size: 0.5 }), 1);
  assert.equal(resolveDerive("reach_from_size", { size: 2 }), 2);
});

test("resolveDerive keeps a zero Strength modifier distinct from a missing one", () => {
  assert.equal(resolveDerive("str_mod", { modifiers: { strength: 0 } }), 0);
  assert.equal(resolveDerive("str_mod", { modifiers: {} }), null);
});

test("resolveDerive returns null rather than throwing on bad input", () => {
  assert.equal(resolveDerive("nonsense", { speed: 10 }), null);
  assert.equal(resolveDerive("speed", null), null);
});

test("eligibility is available for an ungated entry", () => {
  assert.equal(eligibility(SHOVE, {}, { speed: 10 }), "available");
});

test("eligibility is unknown for every requirement the engine cannot answer", () => {
  for (const type of ["condition", "equipment", "free_hand", "unloaded_weapon"]) {
    const entry = { ...SHOVE, requires: [{ type, label: "x" }] };
    assert.equal(eligibility(entry, {}, { speed: 10 }), "unknown", type);
  }
});

test("eligibility is available with no character rather than unavailable", () => {
  assert.equal(eligibility(SHOVE, null, null), "available");
});

test("resolveLinks resolves present targets and drops absent ones", () => {
  const byId = new Map(ENTRIES.map((e) => [e.id, e]));
  const links = resolveLinks(ESCAPE, byId);
  // affliction-grabbed and attack-grab are not in byId, so both drop.
  assert.deepEqual(links.removes, []);
  assert.deepEqual(links.see_also, []);
  const withProne = resolveLinks({ ...ESCAPE, inflicts: ["affliction-prone"] }, byId);
  assert.deepEqual(withProne.inflicts.map((e) => e.id), ["affliction-prone"]);
});

test("resolveLinks returns all four arrays even when the entry has none", () => {
  const links = resolveLinks(PRONE, new Map());
  assert.deepEqual(Object.keys(links).sort(), ["inflicts", "removes", "requires_condition", "see_also"]);
  assert.deepEqual(links.inflicts, []);
});
