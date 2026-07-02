// Gear tab: inventory, the armory catalog, encumbrance.

import { rules } from "../data.js";
import { compute, meetsRequirement } from "../engine.js";
import { active, save } from "../state.js";
import { rollD20, rollDamage } from "../dice.js";
import { showToast } from "./toast.js";

import { esc } from "./util.js";

let catalogTab = "weapons";

export function renderGear(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);
  const str = computed.attributes.strength;
  const itemCount = char.inventory.reduce((n, it) => n + (it.qty || 1), 0);
  const encumbered = itemCount > str;
  const overloaded = itemCount > str * 2;

  el.innerHTML = `
  <div class="cols cols-2">
    <div class="panel">
      <h2 class="rubric">Possessions
        <span class="count">${itemCount} item${itemCount !== 1 ? "s" : ""} · limit ${str} (Strength)</span>
      </h2>
      ${overloaded ? `<p class="blood small"><b>Overloaded.</b> You cannot carry more than twice your Strength in items.</p>`
        : encumbered ? `<p class="blood small"><b>Encumbered.</b> You are slowed and make Strength/Agility rolls with 1 bane.</p>` : ""}
      ${inventoryTable(char, computed)}
      <div class="field-row" style="margin-top:12px">
        <input type="text" id="g-custom-name" placeholder="Add custom item…" style="flex:2">
        <input type="number" id="g-custom-qty" value="1" min="1" style="width:70px">
        <button class="btn btn-small" id="g-custom-add">Add</button>
      </div>
      <div class="field-row">
        <div class="field" style="flex:1">
          <label>coins &amp; treasure</label>
          <input type="text" id="g-coins" value="${esc(char.coins)}" placeholder="e.g. 3 gc, 14 ss, a stolen reliquary">
        </div>
      </div>
      ${wealthNote()}
    </div>

    <div class="panel">
      <h2 class="rubric">The Armory</h2>
      <div class="chip-row" style="margin-bottom:12px">
        <button class="chip ${catalogTab === "weapons" ? "on" : ""}" data-cat="weapons">Weapons</button>
        <button class="chip ${catalogTab === "armor" ? "on" : ""}" data-cat="armor">Armor</button>
        <button class="chip ${catalogTab === "gear" ? "on" : ""}" data-cat="gear">Gear</button>
      </div>
      <div id="g-catalog">${catalogTable(catalogTab)}</div>
    </div>
  </div>`;

  wire(el, char, computed);
}

function inventoryTable(char, computed) {
  if (!char.inventory.length) return `<p class="empty">Nothing but lint and regret.</p>`;
  const str = computed.attributes.strength;
  return `
  <table class="ledger">
    <thead><tr><th></th><th>Item</th><th>Qty</th><th>Notes</th><th></th></tr></thead>
    <tbody>
      ${char.inventory.map((it) => {
        const reqWarn = it.requirement ? requirementUnmet(it.requirement, computed) : null;
        return `
        <tr>
          <td><input type="checkbox" data-equip="${esc(it.id)}" ${it.equipped ? "checked" : ""} title="Equipped"></td>
          <td>
            <span class="parch">${esc(it.name)}</span>
            ${it.damage ? `<button class="btn btn-small" data-weapon-roll="${esc(it.id)}" title="Attack roll, then damage">⚔ ${esc(it.damage)}</button>` : ""}
            ${it.defense ? `<span class="small dim"> · Defense ${esc(it.defense)}</span>` : ""}
            ${reqWarn ? `<div class="warn">requires ${esc(it.requirement)} — ${reqWarn}</div>` : ""}
            ${it.properties ? `<div class="small dim">${esc(it.properties)}</div>` : ""}
          </td>
          <td><input type="number" value="${esc(it.qty || 1)}" min="1" style="width:58px" data-qty="${esc(it.id)}"></td>
          <td><input type="text" value="${esc(it.notes || "")}" data-notes="${esc(it.id)}" style="width:100%"></td>
          <td><button class="btn btn-small btn-danger" data-drop="${esc(it.id)}">✕</button></td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function requirementUnmet(req, computed) {
  // e.g. "Strength 11", "Strength or Agility 11", "Strength 13"
  return meetsRequirement(req, computed.attributes) ? null : "1 bane on attacks / slowed in armor";
}

function catalogTable(tab) {
  if (tab === "weapons") {
    return `
    <table class="ledger">
      <thead><tr><th>Weapon</th><th>Dmg</th><th>Hands</th><th>Properties</th><th>Price</th><th></th></tr></thead>
      <tbody>${rules.equipment.weapons.map((w, i) => `
        <tr>
          <td>${esc(w.name)}<div class="small dim">${esc(w.category)}${w.requirement ? ` · req ${esc(w.requirement)}` : ""}</div></td>
          <td>${esc(w.damage)}</td><td>${esc(w.hands)}</td>
          <td class="small">${esc(w.properties)}</td><td class="small">${esc(w.price)}</td>
          <td><button class="btn btn-small" data-take="w:${i}">Take</button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  }
  if (tab === "armor") {
    return `
    <table class="ledger">
      <thead><tr><th>Armor</th><th>Defense</th><th>Price</th><th></th></tr></thead>
      <tbody>${rules.equipment.armor.map((a, i) => `
        <tr>
          <td>${esc(a.name)}<div class="small dim">${esc(a.type)}${a.requirement ? ` · req ${esc(a.requirement)}` : ""}</div></td>
          <td>${esc(a.defense)}</td><td class="small">${esc(a.price)}</td>
          <td><button class="btn btn-small" data-take="a:${i}">Take</button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  }
  return `
  <table class="ledger">
    <thead><tr><th>Item</th><th>Price</th><th>Avail.</th><th></th></tr></thead>
    <tbody>${rules.equipment.gear.map((g, i) => `
      <tr>
        <td>${esc(g.name)}</td><td class="small">${esc(g.price)}</td><td class="small">${esc(g.availability)}</td>
        <td><button class="btn btn-small" data-take="g:${i}">Take</button></td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function wealthNote() {
  return `<details style="margin-top:12px"><summary class="small dim" style="cursor:pointer">Starting wealth packages (roll 3d6)</summary>
    <dl class="kv small" style="margin-top:8px">
      ${rules.curated.wealth.map((w) => `<dt>${esc(w.roll)} ${esc(w.lifestyle)}</dt><dd>${esc(w.equipment)}</dd>`).join("")}
    </dl></details>`;
}

function wire(el, char, computed) {
  el.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    catalogTab = b.dataset.cat;
    renderGear(el);
  }));

  el.querySelector("#g-custom-add")?.addEventListener("click", () => {
    const name = el.querySelector("#g-custom-name").value.trim();
    const qty = parseInt(el.querySelector("#g-custom-qty").value, 10) || 1;
    if (!name) return;
    char.inventory.push({ id: crypto.randomUUID(), name, qty });
    save(); renderGear(el);
  });
  el.querySelector("#g-coins")?.addEventListener("change", (e) => { char.coins = e.target.value; save(); });

  // Delegated handlers attach once; state is looked up fresh per event.
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const char = active();
    if (!char) return;
    const computed = compute(char);
    const take = e.target.closest("[data-take]");
    if (take) {
      const [kind, idx] = take.dataset.take.split(":");
      const i = parseInt(idx, 10);
      if (kind === "w") {
        const w = rules.equipment.weapons[i];
        char.inventory.push({ id: crypto.randomUUID(), name: w.name, qty: 1, damage: w.damage, hands: w.hands, properties: w.properties, requirement: w.requirement || null, weapon: true });
      } else if (kind === "a") {
        const a = rules.equipment.armor[i];
        char.inventory.push({ id: crypto.randomUUID(), name: a.name, qty: 1, defense: a.defense, type: a.type, requirement: a.requirement || null, armor: true });
      } else {
        const g = rules.equipment.gear[i];
        char.inventory.push({ id: crypto.randomUUID(), name: g.name, qty: 1 });
      }
      save(); renderGear(el);
      return;
    }
    const drop = e.target.closest("[data-drop]");
    if (drop) {
      char.inventory = char.inventory.filter((it) => it.id !== drop.dataset.drop);
      save(); renderGear(el);
      return;
    }
    const wr = e.target.closest("[data-weapon-roll]");
    if (wr) {
      const it = char.inventory.find((x) => x.id === wr.dataset.weaponRoll);
      if (!it) return;
      const finesse = /finesse/i.test(it.properties || "");
      const strMod = computed.modifiers.strength, agiMod = computed.modifiers.agility;
      const mod = finesse ? Math.max(strMod, agiMod) : strMod;
      const unmet = it.requirement ? requirementUnmet(it.requirement, computed) : null;
      const entry = rollD20(`${it.name} attack${unmet ? " (unmet req: add 1 bane!)" : ""}`, mod);
      showToast(entry);
      if (it.damage && it.damage !== "—") {
        const dmg = rollDamage(it.damage, `${it.name} damage`);
        if (dmg) showToast(dmg);
      }
    }
  });

  el.addEventListener("change", (e) => {
    const char = active();
    if (!char) return;
    const equip = e.target.closest("[data-equip]");
    if (equip) {
      const it = char.inventory.find((x) => x.id === equip.dataset.equip);
      if (it) { it.equipped = equip.checked; save(); }
      return;
    }
    const qty = e.target.closest("[data-qty]");
    if (qty) {
      const it = char.inventory.find((x) => x.id === qty.dataset.qty);
      if (it) { it.qty = Math.max(1, parseInt(qty.value, 10) || 1); save(); renderGear(el); }
      return;
    }
    const notes = e.target.closest("[data-notes]");
    if (notes) {
      const it = char.inventory.find((x) => x.id === notes.dataset.notes);
      if (it) { it.notes = notes.value; save(); }
    }
  });
}
