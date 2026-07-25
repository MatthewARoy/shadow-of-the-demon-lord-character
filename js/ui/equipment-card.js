// Equipment identity and presentation shared by the Gear armory and Lookup.
//
// The rules index deliberately no longer carries equipment table rows — the
// chunker mangled them into run-on prose, which is what made searching
// "sling" return "1d3 Off Range (medium), uses stones 5 cp C Shields...".
// Structured records from data/equipment.json are the replacement.
//
// Only identity and field extraction are shared. Gear renders a catalog
// TABLE with per-row "Take" buttons; Lookup renders search-result CARDS.
// Those are different presentations of the same records, so forcing one
// markup on both would be a rewrite of a working UI, not a de-duplication.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// data/equipment.json holds 171 records and names are NOT unique: "Bastard
// sword or warhammer" appears twice, as a Military Melee Weapon (1d6+2, 5 ss)
// and as a Heavy Melee Weapon (2d6, 1 gc). Name alone is not a key.
export function equipmentKey(item) {
  return `${item.name}|${item.category || item.type || ""}`.toLowerCase();
}

// The label/value pairs a record actually carries, in display order.
// Weapons, armor, and gear have overlapping but different field sets.
export function equipmentStats(item) {
  const pairs = [];
  if (item.damage) pairs.push(["damage", item.damage]);
  if (item.hands) pairs.push(["hands", item.hands]);
  if (item.defense) pairs.push(["defense", item.defense]);
  if (item.properties) pairs.push(["properties", item.properties]);
  if (item.price) pairs.push(["price", item.price]);
  if (item.availability) pairs.push(["avail.", item.availability]);
  return pairs;
}

export function equipmentCard(item) {
  const stats = equipmentStats(item);
  const group = item.category || item.type || "";
  return `
  <div class="talent equip-card">
    <b>${esc(item.name)}</b>
    ${group ? `<span class="src">${esc(group)}</span>` : ""}
    ${item.requirement ? `<p class="small blood">Requires ${esc(item.requirement)}</p>` : ""}
    <dl class="kv small equip-stats">
      ${stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
    </dl>
  </div>`;
}
