// Damage expressions come from the catalog, the Dice tab, and — with party
// sync — another member's inventory (a viewed character's roll buttons stay
// live). An unbounded "NdS" allocated N dice, so one stored string could
// freeze or crash the viewer's tab.
import test from "node:test";
import assert from "node:assert/strict";
import { rollDamage } from "../../dice.js";

test("rollDamage rolls ordinary expressions", () => {
  const two = rollDamage("2d6+1", "Sword");
  assert.equal(two.label, "Sword");
  assert.ok(two.total >= 3 && two.total <= 13);
  assert.match(two.detail, /^2d6 \[\d,\d\] \+ 1$/);
  assert.equal(rollDamage("3").total, 3);
  assert.ok(rollDamage("100d6").total >= 100, "a large but sane pool still rolls");
  assert.ok(rollDamage("1d1000").total >= 1);
  assert.equal(rollDamage("nonsense"), null);
});

test("rollDamage refuses expressions too large to roll, quickly", () => {
  const started = Date.now();
  for (const expr of ["101d6", "1000000d6", "1d1001", "1d6+10001", "1d6-10001", "4000000000d6", "99999999999999999999d6"]) {
    assert.equal(rollDamage(expr), null, expr);
  }
  assert.ok(Date.now() - started < 1000, "no huge allocation");
});
