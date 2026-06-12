// Spells tab: the learned grimoire with castings trackers, plus the full
// 1,100+ spell browser with filters.

import { rules, spellKey } from "../data.js";
import { compute } from "../engine.js";
import { active, save } from "../state.js";
import { rollD20, rollDamage } from "../dice.js";
import { showToast } from "./toast.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const filters = { q: "", tradition: "", rank: "", type: "", source: "", learnable: false };

export function renderSpells(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);

  el.innerHTML = `
    ${learnedPanel(char, computed)}
    <div class="panel">
      <h2 class="rubric">The Archive <span class="count">${rules.spells.length} spells across ${rules.traditions.length} traditions</span></h2>
      <div class="filter-bar">
        <input type="text" id="sp-q" placeholder="Search names and descriptions…" value="${esc(filters.q)}">
        <select id="sp-tradition">
          <option value="">all traditions</option>
          ${rules.traditions.map((t) => `<option ${filters.tradition === t.name ? "selected" : ""}>${t.name}</option>`).join("")}
        </select>
        <select id="sp-rank">
          <option value="">any rank</option>
          ${Array.from({ length: 11 }, (_, i) => `<option ${filters.rank === String(i) ? "selected" : ""}>${i}</option>`).join("")}
        </select>
        <select id="sp-type">
          <option value="">attack &amp; utility</option>
          <option ${filters.type === "Attack" ? "selected" : ""}>Attack</option>
          <option ${filters.type === "Utility" ? "selected" : ""}>Utility</option>
        </select>
        <select id="sp-source">
          <option value="">all books</option>
          <option value="core" ${filters.source === "core" ? "selected" : ""}>Core</option>
          <option value="occult" ${filters.source === "occult" ? "selected" : ""}>Occult Philosophy</option>
          <option value="terrible" ${filters.source === "terrible" ? "selected" : ""}>Terrible Beauty</option>
        </select>
        <button class="chip ${filters.learnable ? "on" : ""}" id="sp-learnable" title="Spells you could legally learn now">learnable now</button>
      </div>
      <div class="spell-grid" id="sp-results"></div>
      <p class="small dim" id="sp-more"></p>
    </div>`;

  renderResults(el, char, computed);
  wire(el, char, computed);
}

let exchangeOpen = null; // spell key whose exchange picker is showing

function learnedPanel(char, computed) {
  if (!computed.spells.length) {
    return `<div class="panel"><h2 class="rubric">Grimoire</h2>
      <p class="empty">No spells learned. Tradition discoveries and spell picks await in the Build tab.</p></div>`;
  }
  const byRank = new Map();
  for (const s of computed.spells) {
    if (!s.data) continue;
    if (!byRank.has(s.data.rank)) byRank.set(s.data.rank, []);
    byRank.get(s.data.rank).push(s);
  }
  const sections = [...byRank.keys()].sort((a, b) => a - b).map((rank) => {
    const spells = byRank.get(rank);
    return `
      <h3 class="small dim" style="font-family:var(--caps);letter-spacing:.1em;margin:14px 0 8px">RANK ${rank} — ${spells[0].castings} casting${spells[0].castings !== 1 ? "s" : ""} each</h3>
      <div class="spell-grid">
        ${spells.map((s) => spellCard(s.data, { learned: true, char, computed, castings: s.castings, source: s.source, spellRec: s })).join("")}
      </div>`;
  }).join("");
  return `
  <div class="panel">
    <h2 class="rubric">Grimoire <span class="count">${computed.spells.length} learned · Power ${computed.power}</span></h2>
    ${sections}
    ${exchangesList(char)}
    <p class="small dim" style="margin-bottom:0">Castings refresh on a rest. Whenever you learn a new spell you may also exchange a known spell for another of rank ≤ your Power — use ⇄ on a spell above.</p>
  </div>`;
}

function exchangesList(char) {
  if (!char.exchanges?.length) return "";
  return `<div class="chip-row" style="margin-top:12px">
    ${char.exchanges.map((ex, i) =>
      `<button class="chip" data-unexchange="${i}" title="Undo this exchange">⇄ ${esc(ex.drop.name)} → ${esc(ex.gain.name)} ✕</button>`).join("")}
  </div>`;
}

function exchangePicker(char, computed, rec) {
  const known = new Set(computed.spells.map((s) => spellKey(s.name, s.tradition)));
  const discovered = new Set(computed.discovered.map((d) => d.tradition));
  const pool = rules.spells.filter((s) =>
    !s.path_spell && discovered.has(s.tradition) && s.rank <= computed.power &&
    !known.has(spellKey(s.name, s.tradition)));
  if (!pool.length) return `<p class="small blood">Nothing legal to exchange into.</p>`;
  const byTrad = new Map();
  for (const s of pool) {
    if (!byTrad.has(s.tradition)) byTrad.set(s.tradition, []);
    byTrad.get(s.tradition).push(s);
  }
  return `<select data-exchange-gain="${esc(rec.name)}|${esc(rec.tradition)}" style="max-width:100%">
    <option value="">forget ${esc(rec.name)}, learn…</option>
    ${[...byTrad.keys()].sort().map((t) => `<optgroup label="${esc(t)}">
      ${byTrad.get(t).map((s) => `<option value="${esc(s.name)}|${esc(s.tradition)}">${esc(s.name)} · rank ${s.rank}</option>`).join("")}
    </optgroup>`).join("")}
  </select>`;
}

function renderResults(el, char, computed) {
  const box = el.querySelector("#sp-results");
  const more = el.querySelector("#sp-more");
  let pool = rules.spells;
  const learnableKeys = filters.learnable ? legalNowKeys(char, computed) : null;
  const q = filters.q.trim().toLowerCase();
  pool = pool.filter((s) => {
    if (filters.tradition && s.tradition !== filters.tradition) return false;
    if (filters.rank !== "" && s.rank !== parseInt(filters.rank, 10)) return false;
    if (filters.type && s.type !== filters.type) return false;
    if (filters.source && s.source !== filters.source) return false;
    if (learnableKeys && !learnableKeys.has(spellKey(s.name, s.tradition))) return false;
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    return true;
  });
  const known = new Set(computed.spells.map((s) => spellKey(s.name, s.tradition)));
  const shown = pool.slice(0, 60);
  box.innerHTML = shown.map((s) => spellCard(s, { learned: known.has(spellKey(s.name, s.tradition)), char, computed })).join("") ||
    `<p class="empty">Nothing in the archive matches.</p>`;
  more.textContent = pool.length > shown.length ? `Showing ${shown.length} of ${pool.length} — refine the filters to see the rest.` : "";
}

function legalNowKeys(char, computed) {
  const discovered = new Set(computed.discovered.map((d) => d.tradition));
  const known = new Set(computed.spells.map((s) => spellKey(s.name, s.tradition)));
  const keys = new Set();
  for (const s of rules.spells) {
    if (s.path_spell) continue;
    if (!discovered.has(s.tradition)) continue;
    if (s.rank > computed.power) continue;
    const k = spellKey(s.name, s.tradition);
    if (!known.has(k)) keys.add(k);
  }
  return keys;
}

export function spellCard(s, opts = {}) {
  const trad = rules.traditionByName.get(s.tradition);
  const attrClass = trad ? trad.attribute.toLowerCase() : "";
  const meta = [];
  if (s.requirement) meta.push(`<b>Requirement</b> ${esc(s.requirement)}`);
  if (s.target) meta.push(`<b>Target</b> ${esc(s.target)}`);
  if (s.area) meta.push(`<b>Area</b> ${esc(s.area)}`);
  if (s.duration) meta.push(`<b>Duration</b> ${esc(s.duration)}`);
  const castingsRow = opts.learned && opts.castings != null ? castingsPips(s, opts) : "";
  const attackBtn = s.attack
    ? `<button class="btn btn-small" data-cast-roll="${esc(s.name)}|${esc(s.tradition)}" title="Roll ${esc(s.attack.attribute)} attack${s.attack.damage ? `, then ${esc(s.attack.damage)} damage` : ""}">⚔ ${esc(s.attack.attribute)} roll</button>`
    : "";
  const key = spellKey(s.name, s.tradition);
  // An exchanged-in spell carries its undo right on the card; slot-learned
  // spells offer the exchange picker (path grants like Sense Magic come from
  // talents, not learning, and offer neither).
  const exIdx = opts.spellRec?.exchanged && opts.char
    ? (opts.char.exchanges || []).findIndex((ex) => ex.gain.name === s.name && ex.gain.tradition === s.tradition)
    : -1;
  const exchangeBtn = exIdx !== -1
    ? `<button class="btn btn-small" data-unexchange="${exIdx}" title="Undo this exchange — forget ${esc(s.name)}, relearn ${esc(opts.char.exchanges[exIdx].drop.name)}">⇄ undo</button>`
    : opts.spellRec?.slotId
      ? `<button class="btn btn-small" data-exchange-open="${esc(key)}" title="Exchange this spell for another (rank ≤ Power)">⇄</button>`
      : "";
  return `
  <div class="spell-card ${opts.learned ? "learned" : ""}">
    <div class="spell-head">
      <span class="spell-name">${esc(s.name)}</span>
      <span class="spell-tags">
        <span class="tag rank">Rank ${s.rank}</span>
        <span class="tag ${s.type.toLowerCase()}">${s.type}</span>
        <span class="tag ${attrClass}">${esc(s.tradition)}${trad?.dark ? " ☠" : ""}</span>
      </span>
    </div>
    ${meta.length ? `<div class="spell-meta">${meta.join(" &nbsp;·&nbsp; ")}</div>` : ""}
    <p class="spell-desc clamp" title="Click to expand">${esc(s.description)}</p>
    ${opts.learned && exchangeOpen === key ? exchangePicker(opts.char, opts.computed, s) : ""}
    <div class="spell-foot">
      ${castingsRow || `<span class="small dim">${s.source === "core" ? "Core" : s.source === "occult" ? "Occult Philosophy" : "Terrible Beauty"} · p.${s.page}</span>`}
      <span>${exchangeBtn} ${attackBtn}</span>
    </div>
  </div>`;
}

function castingsPips(s, opts) {
  const key = spellKey(s.name, s.tradition);
  const used = opts.char.expended[key] || 0;
  const pips = Array.from({ length: opts.castings }, (_, i) =>
    `<span class="cast-pip ${i < used ? "spent" : ""}" data-pip="${esc(key)}" data-i="${i}" title="${i < used ? "Expended — click to restore one casting" : "Click to expend one casting"}"></span>`);
  return `<span class="castings">${pips.join("")}</span>`;
}

function wire(el, char, computed) {
  const rerun = () => { renderResults(el, char, computed); };
  el.querySelector("#sp-q").addEventListener("input", (e) => { filters.q = e.target.value; rerun(); });
  el.querySelector("#sp-tradition").addEventListener("change", (e) => { filters.tradition = e.target.value; rerun(); });
  el.querySelector("#sp-rank").addEventListener("change", (e) => { filters.rank = e.target.value; rerun(); });
  el.querySelector("#sp-type").addEventListener("change", (e) => { filters.type = e.target.value; rerun(); });
  el.querySelector("#sp-source").addEventListener("change", (e) => { filters.source = e.target.value; rerun(); });
  el.querySelector("#sp-learnable").addEventListener("click", (e) => {
    filters.learnable = !filters.learnable;
    e.target.classList.toggle("on", filters.learnable);
    rerun();
  });

  // Delegated handlers attach once; state is looked up fresh per event.
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const c = active();
    if (!c) return;
    const desc = e.target.closest(".spell-desc");
    if (desc) { desc.classList.toggle("clamp"); return; }

    const exOpen = e.target.closest("[data-exchange-open]");
    if (exOpen) {
      exchangeOpen = exchangeOpen === exOpen.dataset.exchangeOpen ? null : exOpen.dataset.exchangeOpen;
      renderSpells(el);
      return;
    }
    const unex = e.target.closest("[data-unexchange]");
    if (unex) {
      c.exchanges.splice(parseInt(unex.dataset.unexchange, 10), 1);
      save(); renderSpells(el);
      return;
    }

    const pip = e.target.closest("[data-pip]");
    if (pip) {
      const key = pip.dataset.pip;
      const i = parseInt(pip.dataset.i, 10);
      const used = c.expended[key] || 0;
      // Toggle exactly one casting: spent pip restores one, unspent expends one.
      c.expended[key] = Math.max(0, i < used ? used - 1 : used + 1);
      save(); renderSpells(el);
      return;
    }

    const roll = e.target.closest("[data-cast-roll]");
    if (roll) {
      const [name, tradition] = roll.dataset.castRoll.split("|");
      const spell = rules.spellByKey.get(spellKey(name, tradition));
      if (!spell?.attack) return;
      const mods = compute(c).modifiers;
      const mod = mods[spell.attack.attribute.toLowerCase()] ?? 0;
      const entry = rollD20(`${spell.name} (${spell.attack.attribute} vs ${spell.attack.against})`, mod);
      showToast(entry);
      if (spell.attack.damage) {
        const dmg = rollDamage(spell.attack.damage, `${spell.name} damage`);
        if (dmg) showToast(dmg);
      }
    }
  });

  el.addEventListener("change", (e) => {
    const c = active();
    if (!c) return;
    const gain = e.target.closest("[data-exchange-gain]");
    if (gain && e.target.value) {
      const [dropName, dropTrad] = gain.dataset.exchangeGain.split("|");
      const [gainName, gainTrad] = e.target.value.split("|");
      c.exchanges = c.exchanges || [];
      c.exchanges.push({ drop: { name: dropName, tradition: dropTrad }, gain: { name: gainName, tradition: gainTrad } });
      exchangeOpen = null;
      save(); renderSpells(el);
    }
  });
}

