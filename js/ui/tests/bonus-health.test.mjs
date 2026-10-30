import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// data.js fetches over HTTP in the browser; shim it onto the filesystem the
// same way scripts/build_samples.mjs does. importCharacter() saves the roster,
// so give it somewhere to write.
globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const { loadRules } = await import("../../data.js");
const { compute, newCharacter } = await import("../../engine.js");
const { importCharacter } = await import("../../state.js");
const {
  totalHealth, isIncapacitated, adjustDamage, adjustBonusHealth, restHealth, hasDivineEcstasy,
} = await import("../../health.js");
await loadRules();

// A bonus to Health (Divine Ecstasy, Bolster Health, …) raises Health while it
// lasts. Damage taken meanwhile stays when it ends. Fixtures are hand-built:
// 20 Health, healing rate 5.
const COMPUTED = { health: 20, healingRate: 5 };
const char = (fields) => ({ damage: 0, bonusHealth: 0, ...fields });

test("total Health adds the bonus to computed Health", () => {
  assert.equal(totalHealth(char({ bonusHealth: 10 }), COMPUTED), 30);
});

test("a character saved before bonus Health existed counts no bonus", () => {
  assert.equal(totalHealth({ damage: 0 }, COMPUTED), 20);
});

test("damage can be marked up to the raised Health while the bonus lasts", () => {
  const c = char({ damage: 5, bonusHealth: 10 });
  adjustDamage(c, COMPUTED, 30);
  assert.equal(c.damage, 30);
});

test("without a bonus, damage still caps at computed Health", () => {
  const c = char({ damage: 18 });
  adjustDamage(c, COMPUTED, 5);
  assert.equal(c.damage, 20);
});

test("removing damage never goes below zero", () => {
  const c = char({ damage: 1 });
  adjustDamage(c, COMPUTED, -3);
  assert.equal(c.damage, 0);
});

test("ending the bonus keeps the damage taken during it", () => {
  // 20 Health, 5 damage, enter ecstasy (+10), take 8 more → 13 of 20 after.
  const c = char({ damage: 13, bonusHealth: 10 });
  adjustBonusHealth(c, COMPUTED, -10);
  assert.equal(c.bonusHealth, 0);
  assert.equal(c.damage, 13);
});

test("ending the bonus with more damage than Health caps damage and incapacitates", () => {
  const c = char({ damage: 25, bonusHealth: 10 });
  adjustBonusHealth(c, COMPUTED, -10);
  assert.equal(c.damage, 20);
  assert.equal(isIncapacitated(c, COMPUTED), true);
});

test("bonus Health never goes below zero", () => {
  const c = char({ bonusHealth: 3 });
  adjustBonusHealth(c, COMPUTED, -10);
  assert.equal(c.bonusHealth, 0);
});

test("the bonus keeps a character up at damage equal to base Health", () => {
  assert.equal(isIncapacitated(char({ damage: 20, bonusHealth: 10 }), COMPUTED), false);
  assert.equal(isIncapacitated(char({ damage: 30, bonusHealth: 10 }), COMPUTED), true);
});

test("an unbuilt character with 0 Health is not incapacitated", () => {
  assert.equal(isIncapacitated(char({ damage: 0 }), { health: 0, healingRate: 1 }), false);
});

test("a rest ends the bonus before healing", () => {
  // Bonus ends first (25 → capped 20), then the rest heals 5 → 15. Healing
  // first would leave 20.
  const c = char({ damage: 25, bonusHealth: 10 });
  const healed = restHealth(c, COMPUTED);
  assert.equal(c.bonusHealth, 0);
  assert.equal(c.damage, 15);
  assert.equal(healed, 5);
});

test("an Oracle has Divine Ecstasy from level 3", () => {
  const c = newCharacter("Ecstasy Probe");
  c.ancestry = "Human";
  c.novicePath = "Priest";
  c.expertPath = "Oracle";
  c.level = 3;
  assert.equal(hasDivineEcstasy(compute(c)), true);
  c.level = 2;
  assert.equal(hasDivineEcstasy(compute(c)), false);
});

test("importing snaps a missing or malformed bonus Health to a whole number ≥ 0", () => {
  const base = { ancestry: "Human", name: "Imported" };
  const cases = [[undefined, 0], ["ten", 0], [-4, 0], [7.9, 7], [10, 10]];
  for (const [given, want] of cases) {
    const c = importCharacter(JSON.stringify({ ...base, bonusHealth: given }));
    assert.equal(c.bonusHealth, want, `bonusHealth ${JSON.stringify(given)}`);
  }
});
