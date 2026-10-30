// Play-time Health: the engine's computed Health plus any temporary bonus
// (Divine Ecstasy, Bolster Health, Alter Size, …). A bonus raises Health while
// it lasts; damage taken meanwhile stays when it ends, capped at the lower
// Health — which can leave the character incapacitated. Healing rate stays on
// the computed Health.

// Characters saved before the field existed have no bonusHealth at all.
const bonusOf = (char) => char.bonusHealth || 0;

export function totalHealth(char, computed) {
  return computed.health + bonusOf(char);
}

export function isIncapacitated(char, computed) {
  const total = totalHealth(char, computed);
  return total > 0 && char.damage >= total;
}

export function adjustDamage(char, computed, delta) {
  char.damage = Math.max(0, Math.min(totalHealth(char, computed), char.damage + delta));
}

export function adjustBonusHealth(char, computed, delta) {
  char.bonusHealth = Math.max(0, bonusOf(char) + delta);
  char.damage = Math.min(char.damage, totalHealth(char, computed));
}

// A rest outlasts any bonus, so the bonus ends before the healing rate is
// applied. Returns the damage healed.
export function restHealth(char, computed) {
  adjustBonusHealth(char, computed, -bonusOf(char));
  const healed = Math.min(char.damage, computed.healingRate);
  char.damage -= healed;
  return healed;
}

// The Oracle's level-3 talent: +10 Health for a minute.
export function hasDivineEcstasy(computed) {
  return computed.talents.some((t) => t.name === "Divine Ecstasy");
}
