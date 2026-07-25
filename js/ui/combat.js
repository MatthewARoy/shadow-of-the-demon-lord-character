// Combat tab: a character-aware quick reference for actions, attack options,
// turn economy, afflictions, and modifiers.
//
// data/combat.json is hand-written rather than parsed (see
// docs/superpowers/specs/2026-07-25-combat-quick-reference-design.md). It is
// loaded lazily on first visit rather than in loadRules(), so a malformed
// file breaks this tab alone instead of bricking boot.

const LINK_FIELDS = ["inflicts", "requires_condition", "removes", "see_also"];

// Each expression is backed by a field compute() actually returns. Adding a
// value here without adding it to DERIVE_EXPRS in
// scripts/tests/test_combat_data.py will fail the build, which is the point.
export const DERIVE_EXPRS = Object.freeze({
  str_mod: (c) => c.modifiers?.strength ?? null,
  speed: (c) => c.speed ?? null,
  half_speed: (c) => (c.speed == null ? null : Math.floor(c.speed / 2)),
  size: (c) => c.size ?? null,
  // Core p.38: reach equals Size rounded up. Halflings are Size 1/2, so the
  // floor of 1 yard matters. Weapons can modify reach; this is the baseline.
  reach_from_size: (c) => (c.size == null ? null : Math.max(1, Math.ceil(c.size))),
});

export function filterEntries(entries, groupId, query) {
  const q = (query || "").trim().toLowerCase();
  return entries.filter((e) => {
    if (groupId && groupId !== "all" && e.group !== groupId) return false;
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.text.toLowerCase().includes(q);
  });
}

export function resolveDerive(expr, computed) {
  if (!computed) return null;
  const fn = DERIVE_EXPRS[expr];
  return fn ? fn(computed) : null;
}

// Tri-state on purpose. The app tracks damage, Insanity, and Corruption but
// not afflictions; gear.js drops a weapon's category when copying it into
// inventory; and there is no hand-slot or ammo model. So none of the four
// requirement types can be answered today and every gated entry comes back
// "unknown", which the renderer shows as a condition chip at full weight.
// Only "unavailable" de-emphasises, so nothing currently dims. This function
// is the single seam where real answers slot in once inventory carries a
// stable equipment identity and category — it is not broken, it is waiting.
export function eligibility(entry, char, computed) {
  const requires = entry.requires || [];
  if (!requires.length) return "available";
  return "unknown";
}

export function resolveLinks(entry, byId) {
  const out = {};
  for (const field of LINK_FIELDS) {
    out[field] = (entry[field] || []).map((id) => byId.get(id)).filter(Boolean);
  }
  return out;
}
