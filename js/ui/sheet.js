// Sheet tab: derived statistics with provenance, rollable attributes,
// traits and talents.

import { compute, ATTRS } from "../engine.js";
import { active, save } from "../state.js";
import { rollD20, diceState } from "../dice.js";
import { showToast } from "./toast.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderSheet(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);
  const m = computed.modifiers;
  const dmgPct = computed.health ? Math.min(100, (char.damage / computed.health) * 100) : 0;
  const incapacitated = char.damage >= computed.health;

  el.innerHTML = `
  <div class="cols cols-3-2">
    <div>
      <div class="panel">
        <h2 class="rubric">${esc(char.name)} <span class="count">${esc(char.ancestry)}${char.novicePath ? " · " + esc(char.novicePath) : ""}${char.expertPath ? " · " + esc(char.expertPath) : ""}${(char.masterMode === "second-expert" ? char.secondExpertPath : char.masterPath) ? " · " + esc(char.masterMode === "second-expert" ? char.secondExpertPath : char.masterPath) : ""} — level ${char.level}</span></h2>
        <div class="attr-grid">
          ${ATTRS.map((a) => `
          <div class="attr-card" data-roll-attr="${a}" title="Roll a ${cap(a)} challenge">
            <div class="label">${a}</div>
            <div class="score">${computed.attributes[a]}</div>
            <div class="mod">${m[a] >= 0 ? "+" : ""}${m[a]}</div>
            <div class="hint">click to roll</div>
          </div>`).join("")}
        </div>

        <div class="char-grid">
          ${charCell("Health", computed.health)}
          ${charCell("Damage", char.damage, char.damage > 0 ? "hurt" : "")}
          ${charCell("Healing Rate", computed.healingRate)}
          ${charCell("Defense", computed.defense)}
          ${charCell("Perception", computed.perception, "", `<small>(${m.intellect + computed.perceptionBonus >= 0 ? "+" : ""}${computed.perception - 10})</small>`)}
          ${charCell("Power", computed.power)}
          ${charCell("Speed", computed.speed)}
          ${charCell("Size", computed.size)}
          ${charCell("Insanity", computed.insanity + (computed.insanityNote ? "*" : ""))}
          ${charCell("Corruption", computed.corruption)}
        </div>
        ${computed.insanityNote ? `<p class="small dim">* plus ${computed.insanityNote}</p>` : ""}

        <div class="damage-bar">
          <button class="btn btn-small" data-dmg="-1">−</button>
          <div class="damage-track"><div class="damage-fill" style="width:${dmgPct}%"></div></div>
          <button class="btn btn-small" data-dmg="1">+</button>
          <button class="btn btn-small" data-heal title="Heal your healing rate (${computed.healingRate})">Heal ${computed.healingRate}</button>
        </div>
        ${incapacitated ? `<p class="blood" style="margin:8px 0 0"><b>Incapacitated.</b> Damage equals Health — you fall and must roll a fate die each round.</p>` : ""}
      </div>

      <div class="panel">
        <h2 class="rubric">Talents <span class="count">${computed.talents.length}</span></h2>
        <div class="talent-list">
          ${computed.talents.map((t) => `
          <div class="talent"><b>${esc(t.name)}</b><span class="src">${esc(t.source)}</span>
            <p>${esc(t.text)}</p></div>`).join("") || `<p class="empty">None yet.</p>`}
        </div>
      </div>

      <div class="panel">
        <h2 class="rubric">Ancestry Traits</h2>
        <div class="talent-list">
          ${computed.traits.map((t) => `
          <div class="talent"><b>${esc(t.name)}</b><span class="src">${esc(t.source)}</span>
            <p>${esc(t.text)}</p></div>`).join("") || `<p class="empty">None.</p>`}
        </div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2 class="rubric">Provenance</h2>
        ${provBlock("Health", computed.provenance.health, computed.attributes.strength ? [{ source: "Strength score", amount: computed.attributes.strength }] : [])}
        ${provBlock("Power", computed.provenance.power)}
        ${provBlock("Defense", computed.provenance.defense, computed.defenseFixed != null ? [{ source: "Fixed (ancestry)", amount: computed.defenseFixed }] : [{ source: "Agility score", amount: computed.attributes.agility }])}
        ${provBlock("Speed", computed.provenance.speed, [{ source: "Ancestry base", amount: computed.ancestry.creation.speed }])}
        ${provBlock("Corruption", computed.provenance.corruption)}
      </div>

      <div class="panel">
        <h2 class="rubric">Languages &amp; Professions</h2>
        <dl class="kv">
          ${computed.languagesProfessions.map((lp) => `
            <dt>${esc(lp.source)}</dt>
            <dd>${esc(lp.value || lp.text)}</dd>`).join("")}
        </dl>
      </div>

      <div class="panel">
        <h2 class="rubric">Traditions Discovered <span class="count">${computed.discovered.length}</span></h2>
        ${computed.discovered.length ? `<div class="chip-row">${computed.discovered.map((d) => `<span class="chip on" title="${esc(d.source)}">${esc(d.tradition)}</span>`).join("")}</div>` : `<p class="empty">No magic flows through this soul.</p>`}
      </div>

      ${computed.notes.length ? `
      <div class="panel">
        <h2 class="rubric">Marginalia</h2>
        ${computed.notes.map((n) => `<p class="small dim">• ${esc(n.text)}</p>`).join("")}
      </div>` : ""}

      <div class="panel">
        <h2 class="rubric">Notes</h2>
        <textarea id="sheet-notes" rows="6" style="width:100%" placeholder="Background, interesting things, debts owed to dark powers…">${esc(char.notes)}</textarea>
      </div>
    </div>
  </div>`;

  el.querySelectorAll("[data-roll-attr]").forEach((card) => {
    card.addEventListener("click", () => {
      const a = card.dataset.rollAttr;
      const entry = rollD20(`${cap(a)} challenge`, computed.modifiers[a]);
      showToast(entry);
    });
  });
  el.querySelectorAll("[data-dmg]").forEach((b) => b.addEventListener("click", () => {
    char.damage = Math.max(0, Math.min(computed.health, char.damage + parseInt(b.dataset.dmg, 10)));
    save(); renderSheet(el);
  }));
  el.querySelector("[data-heal]")?.addEventListener("click", () => {
    char.damage = Math.max(0, char.damage - computed.healingRate);
    save(); renderSheet(el);
  });
  el.querySelector("#sheet-notes")?.addEventListener("change", (e) => { char.notes = e.target.value; save(); });
}

function charCell(label, value, cls = "", extra = "") {
  return `<div class="char-cell ${cls}"><div class="label">${label}</div><div class="value">${value}${extra}</div></div>`;
}

function provBlock(name, list, base = []) {
  const rows = [...base, ...list];
  if (!rows.length) return "";
  return `<p class="prov"><b>${name}:</b> ${rows.map((r) =>
    `${r.source} ${r.amount >= 0 ? "+" : ""}${r.amount}`).join(" · ")}</p>`;
}
