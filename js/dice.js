// SotDL dice: d20 ± the highest of N boon/bane d6s.

export const diceState = { boons: 0 }; // positive = boons, negative = banes

const log = [];
const listeners = [];

export function onRoll(fn) { listeners.push(fn); }
export function rollLog() { return log; }

function d(sides) { return 1 + Math.floor(Math.random() * sides); }

export function rollD20(label, modifier = 0, opts = {}) {
  const die = d(20);
  const boons = opts.boons ?? diceState.boons;
  const boonDice = Array.from({ length: Math.abs(boons) }, () => d(6));
  const boonValue = boonDice.length ? Math.max(...boonDice) : 0;
  const signed = boons > 0 ? boonValue : boons < 0 ? -boonValue : 0;
  const total = die + modifier + signed;
  const entry = {
    when: new Date(),
    label,
    die, modifier, boons, boonDice, boonValue: signed, total,
    crit: die === 20, fumble: die === 1,
    detail: `d20 [${die}]${modifier ? (modifier > 0 ? ` + ${modifier}` : ` − ${-modifier}`) : ""}` +
      (boons ? ` ${boons > 0 ? "+" : "−"} ${boons > 0 ? "boon" : "bane"}[${boonDice.join(",")}→${boonValue}]` : ""),
  };
  push(entry);
  if (!opts.keepBoons) diceState.boons = 0;
  return entry;
}

export function rollDamage(expr, label) {
  // e.g. "1d6+1", "2d6", "1", "3d6 + 2"
  const m = String(expr).replace(/\s/g, "").match(/^(\d+)(?:d(\d+))?(?:\+(\d+))?(?:-(\d+))?$/);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const sides = m[2] ? parseInt(m[2], 10) : 0;
  const plus = m[3] ? parseInt(m[3], 10) : 0;
  const minus = m[4] ? parseInt(m[4], 10) : 0;
  let dice = [];
  let total;
  if (sides) {
    dice = Array.from({ length: count }, () => d(sides));
    total = dice.reduce((a, b) => a + b, 0) + plus - minus;
  } else {
    total = count + plus - minus;
  }
  const entry = {
    when: new Date(), label: label || `Damage ${expr}`, total,
    detail: sides ? `${count}d${sides} [${dice.join(",")}]${plus ? ` + ${plus}` : ""}${minus ? ` − ${minus}` : ""}` : `flat ${total}`,
    damage: true,
  };
  push(entry);
  return entry;
}

export function rollPlain(sides, label) {
  const v = d(sides);
  push({ when: new Date(), label: label || `d${sides}`, total: v, detail: `d${sides} [${v}]` });
  return v;
}

function push(entry) {
  log.push(entry);
  if (log.length > 200) log.shift();
  for (const fn of listeners) fn(entry);
}
