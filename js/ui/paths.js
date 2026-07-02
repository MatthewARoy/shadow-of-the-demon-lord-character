// Paths tab: a searchable browser for the 165 expert & master paths, modeled
// on the Spells Archive. Every path carries its full per-level benefits —
// attribute increases, characteristic gains, magic, languages/professions, and
// talents — so this doubles as a "what do I get if I take this path?" planner.
//
// An optional Analysis layer (the ⚙ advanced toggle) evaluates each path for a
// spellcaster: a cohort-percentile Caster Rating, the concrete benefit badges
// behind it (Power, magic access, attribute picks, spell-synergy talents), and
// each path's focus tradition(s) with the governing attribute. See
// js/path-eval.js for the scoring model.

import { rules } from "../data.js";
import { analyzeAllPaths } from "../path-eval.js";
import { esc } from "./util.js";

const BOOKS = { core: "Core Rulebook", occult: "Occult Philosophy", terrible: "Terrible Beauty" };

// flags: mechanical filter chips (advanced view). All active flags must hold.
const filters = { q: "", type: "", source: "", tradition: "", sort: "", advanced: false, flags: new Set() };

const CHAR_LABEL = {
  health: "Health", power: "Power", defense: "Defense", perception: "Perception",
  size: "Size", speed: "Speed", insanity: "Insanity", corruption: "Corruption",
};

// Lazily computed once — paths never change at runtime.
let analysis = null;
function getAnalysis() {
  if (!analysis) analysis = analyzeAllPaths(rules.paths, rules.traditions);
  return analysis;
}
const evalOf = (p) => getAnalysis().get(p.name);

// Tradition class drives the attribute color (reusing the spell tag palette).
function tradTag(f) {
  const cls = f.attribute ? f.attribute.toLowerCase() : "";
  const attr = f.attribute ? ` · ${f.attribute}` : "";
  return `<span class="tag ${cls}" title="Focus tradition${f.attribute ? ` — governed by ${f.attribute}` : ""}">${esc(f.name)}${attr}${f.dark ? " ☠" : ""}</span>`;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// "+1 to 2 attributes of your choice" / "+1 to each attribute".
function attrText(a) {
  if (!a) return null;
  const inc = a.increase ?? 1;
  if (a.each) return `+${inc} to each attribute`;
  return `+${inc} to ${a.choose} attribute${a.choose !== 1 ? "s" : ""} of your choice`;
}

// ["Health +2", "Power +1"] from the characteristics map.
function charBits(c) {
  if (!c) return [];
  return Object.entries(c).map(([k, v]) => `${CHAR_LABEL[k] || k} ${v >= 0 ? "+" : ""}${v}`);
}

// One level entry → a labeled block of benefit chips plus its talents.
function levelBlock(level, e) {
  const chips = [];
  const attr = attrText(e.attributes);
  if (attr) chips.push(attr);
  for (const b of charBits(e.characteristics)) chips.push(b);
  if (e.magic?.raw) chips.push(e.magic.raw);
  if (e.languages_professions) chips.push(e.languages_professions);
  const chipRow = chips.length
    ? `<div class="path-gains">${chips.map((c) => `<span class="path-gain">${esc(c)}</span>`).join("")}</div>`
    : "";
  const talents = (e.talents || []).map((t) => `
    <div class="talent">
      <b>${esc(t.name)}</b>
      <p class="path-talent clamp" title="Click to expand">${esc(t.text)}</p>
    </div>`).join("");
  return `
    <div class="path-level">
      <span class="path-lvl-pip">Level ${level}</span>
      ${chipRow}
      ${talents ? `<div class="talent-list">${talents}</div>` : ""}
    </div>`;
}

// The analysis strip shown on cards in advanced view: the Caster Rating plus
// the concrete benefits behind it, each with a tooltip explaining the value.
function analysisStrip(p) {
  const a = evalOf(p);
  if (!a) return "";
  const g = a.agg;
  const pct = Math.round(a.casterPct * 100);
  const badges = [];
  badges.push(`<span class="path-rating tier-${a.tier}" title="Caster value vs other ${p.type} paths — weighs Power, magic access, spell-synergy talents and attribute picks (see path-eval.js)">Caster ${a.tier} · ${ordinal(pct)} pct</span>`);
  if (g.power) badges.push(`<span class="path-stat power" title="Power caps the rank of spell you can learn and sets how many castings you get — the rarest, highest-impact caster stat">⚡ Power +${g.power}</span>`);
  if (g.magicPicks) badges.push(`<span class="path-stat magic" title="${g.traditionOptions} pick(s) can discover a tradition, ${g.spellOptions} can learn a spell — direct repertoire additions">✦ magic ×${g.magicPicks}</span>`);
  const spellTalents = g.casting + g.empower;
  if (spellTalents) badges.push(`<span class="path-stat talent" title="${g.casting} spell-economy (expend/grant castings) + ${g.empower} spell-empowering talent(s)">🜂 spell talents ×${spellTalents}</span>`);
  if (g.attrPicks) badges.push(`<span class="path-stat attr" title="Flexible +1 attribute increases — a caster sinks these into Intellect or Will">◈ attributes ×${g.attrPicks}</span>`);
  if (g.health) badges.push(`<span class="path-stat hp" title="Total Health gained across the path's levels">♥ Health +${g.health}</span>`);
  if (g.defense) badges.push(`<span class="path-stat def" title="Defense from a path is rare (3 of 165) — direct survivability">🛡 Defense +${g.defense}</span>`);
  if (g.martial) badges.push(`<span class="path-stat martial" title="${g.martial} weapon/melee talent(s) — this is a hybrid (gish) rather than a pure caster">⚔ martial ×${g.martial}</span>`);
  return `<div class="path-analysis">${badges.join("")}</div>`;
}

function pathCard(p) {
  const levels = Object.keys(p.levels).sort((a, b) => +a - +b);
  const a = evalOf(p);
  const focusTags = (a?.focus || []).map(tradTag).join("");
  return `
  <div class="spell-card path-card">
    <div class="spell-head">
      <span class="spell-name">${esc(p.name)}</span>
      <span class="spell-tags">
        <span class="tag rank">${p.type === "expert" ? "Expert" : "Master"}</span>
        <span class="tag">${BOOKS[p.source] || p.source}</span>
      </span>
    </div>
    ${focusTags ? `<div class="spell-tags path-focus">${focusTags}</div>` : ""}
    ${filters.advanced ? analysisStrip(p) : ""}
    <p class="spell-desc clamp" title="Click to expand">${esc(p.description)}</p>
    ${levels.map((lvl) => levelBlock(lvl, p.levels[lvl])).join("")}
    <div class="spell-foot">
      <span class="small dim">${BOOKS[p.source] || p.source} · p.${p.page}</span>
    </div>
  </div>`;
}

// Build the haystack a path is searched against: name, description, focus
// tradition names, and every talent name + text.
function haystack(p) {
  const parts = [p.name, p.description];
  for (const f of evalOf(p)?.focus || []) parts.push(f.name);
  for (const e of Object.values(p.levels)) {
    if (e.magic?.raw) parts.push(e.magic.raw);
    for (const t of e.talents || []) parts.push(t.name, t.text);
  }
  return parts.join(" ").toLowerCase();
}

// Mechanical filter chips (advanced view). Each tests the path's analysis.
const FLAG_DEFS = [
  ["power", "grants Power", (a) => a.agg.power > 0],
  ["power2", "+2 Power", (a) => a.agg.power >= 2],
  ["tradition", "grants a tradition", (a) => a.agg.traditionOptions > 0],
  ["casting", "spell-economy talent", (a) => a.agg.casting > 0],
  ["empower", "spell-empowering talent", (a) => a.agg.empower > 0],
  ["defense", "grants Defense", (a) => a.agg.defense > 0],
  ["nomartial", "no martial talents", (a) => a.agg.martial === 0],
];
const FLAG_TEST = new Map(FLAG_DEFS.map(([id, , test]) => [id, test]));

function flagBar() {
  const chips = FLAG_DEFS.map(([id, label]) =>
    `<button class="chip cat ${filters.flags.has(id) ? "on" : ""}" data-flag="${id}">${esc(label)}</button>`).join("");
  const active = FLAG_DEFS.filter(([id]) => filters.flags.has(id)).length;
  const clear = active
    ? `<button class="chip cat-clear" data-flag-clear>✕ clear ${active}</button>` : "";
  return `<details class="cat-bar" open>
    <summary class="cat-summary">Path analysis — filter by caster value <span class="small dim">(Power, magic access, spell-synergy talents)</span> ${clear}</summary>
    <div class="cat-group">${chips}</div>
  </details>`;
}

// Traditions that are actually a focus of some path — keeps the dropdown clean.
function focusTraditionNames() {
  const set = new Set();
  for (const p of rules.paths) for (const f of evalOf(p)?.focus || []) set.add(f.name);
  return [...set].sort();
}

export function renderPaths(el) {
  const expert = rules.paths.filter((p) => p.type === "expert").length;
  const master = rules.paths.filter((p) => p.type === "master").length;
  const trads = focusTraditionNames();
  el.innerHTML = `
    <div class="panel">
      <h2 class="rubric">The Paths <span class="count">${expert} expert · ${master} master paths</span></h2>
      <div class="filter-bar">
        <input type="text" id="pa-q" placeholder="Search names, descriptions, traditions, and talents…" value="${esc(filters.q)}">
        <select id="pa-type">
          <option value="">expert &amp; master</option>
          <option value="expert" ${filters.type === "expert" ? "selected" : ""}>Expert (level 3)</option>
          <option value="master" ${filters.type === "master" ? "selected" : ""}>Master (level 7)</option>
        </select>
        <select id="pa-tradition" title="Show paths that empower a tradition">
          <option value="">any tradition focus</option>
          ${trads.map((t) => `<option ${filters.tradition === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <select id="pa-source">
          <option value="">all books</option>
          <option value="core" ${filters.source === "core" ? "selected" : ""}>Core</option>
          <option value="occult" ${filters.source === "occult" ? "selected" : ""}>Occult Philosophy</option>
          <option value="terrible" ${filters.source === "terrible" ? "selected" : ""}>Terrible Beauty</option>
        </select>
        <select id="pa-sort" title="Order the results">
          <option value="" ${filters.sort === "" ? "selected" : ""}>name ↑</option>
          <option value="caster" ${filters.sort === "caster" ? "selected" : ""}>caster rating ↓</option>
          <option value="power" ${filters.sort === "power" ? "selected" : ""}>Power ↓</option>
          <option value="attr" ${filters.sort === "attr" ? "selected" : ""}>attribute picks ↓</option>
          <option value="health" ${filters.sort === "health" ? "selected" : ""}>Health ↓</option>
          <option value="type" ${filters.sort === "type" ? "selected" : ""}>type then name</option>
          <option value="source" ${filters.sort === "source" ? "selected" : ""}>book then name</option>
        </select>
        <button class="chip ${filters.flags.has("caster") ? "on" : ""}" id="pa-caster" title="Show only paths with caster payoff (Power, magic, or spell-synergy talents) and rank them by Caster Rating">⚡ caster picks</button>
        <button class="chip ${filters.advanced ? "on" : ""}" id="pa-advanced" title="Show the analysis layer: Caster Rating and the benefit badges behind it">⚙ analysis</button>
      </div>
      ${filters.advanced ? flagBar() : ""}
      <div class="spell-grid" id="pa-results"></div>
      <p class="small dim" id="pa-more"></p>
    </div>`;
  renderResults(el);
  wire(el);
}

// "caster picks" is a derived lens: a path has caster payoff if it grants
// Power, any magic, or any spell-synergy talent. Martial-only paths fall out.
const hasCasterPayoff = (a) => a.agg.power > 0 || a.agg.magicPicks > 0 || (a.agg.casting + a.agg.empower) > 0;

function renderResults(el) {
  const box = el.querySelector("#pa-results");
  const more = el.querySelector("#pa-more");
  const q = filters.q.trim().toLowerCase();
  const casterLens = filters.flags.has("caster");
  let pool = rules.paths.filter((p) => {
    const a = evalOf(p);
    if (filters.type && p.type !== filters.type) return false;
    if (filters.source && p.source !== filters.source) return false;
    if (filters.tradition && !(a?.focus || []).some((f) => f.name === filters.tradition)) return false;
    if (casterLens && !hasCasterPayoff(a)) return false;
    for (const id of filters.flags) {
      const test = FLAG_TEST.get(id);
      if (test && !test(a)) return false;
    }
    if (q && !haystack(p).includes(q)) return false;
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  const ev = (p) => evalOf(p);
  // A caster lens implies ranking by caster value unless the user picked a sort.
  const sort = filters.sort || (casterLens ? "caster" : "");
  const sorters = {
    caster: (a, b) => ev(b).casterRaw - ev(a).casterRaw || byName(a, b),
    power: (a, b) => ev(b).agg.power - ev(a).agg.power || ev(b).casterRaw - ev(a).casterRaw || byName(a, b),
    attr: (a, b) => ev(b).agg.attrPicks - ev(a).agg.attrPicks || ev(b).statRaw - ev(a).statRaw || byName(a, b),
    health: (a, b) => ev(b).agg.health - ev(a).agg.health || byName(a, b),
    type: (a, b) => a.type.localeCompare(b.type) || byName(a, b),
    source: (a, b) => a.source.localeCompare(b.source) || byName(a, b),
  };
  pool = [...pool].sort(sorters[sort] || byName);
  box.innerHTML = pool.map(pathCard).join("") || `<p class="empty">No path matches your search.</p>`;
  more.textContent = pool.length
    ? `${pool.length} path${pool.length !== 1 ? "s" : ""} shown${filters.advanced && (sort === "caster" || casterLens) ? " · ranked by Caster Rating" : ""}.`
    : "";
}

function wire(el) {
  const rerun = () => renderResults(el);
  el.querySelector("#pa-q").addEventListener("input", (e) => { filters.q = e.target.value; rerun(); });
  el.querySelector("#pa-type").addEventListener("change", (e) => { filters.type = e.target.value; rerun(); });
  el.querySelector("#pa-tradition").addEventListener("change", (e) => { filters.tradition = e.target.value; rerun(); });
  el.querySelector("#pa-source").addEventListener("change", (e) => { filters.source = e.target.value; rerun(); });
  el.querySelector("#pa-sort").addEventListener("change", (e) => { filters.sort = e.target.value; rerun(); });
  el.querySelector("#pa-caster").addEventListener("click", (e) => {
    filters.flags.has("caster") ? filters.flags.delete("caster") : filters.flags.add("caster");
    e.target.classList.toggle("on", filters.flags.has("caster"));
    rerun();
  });
  el.querySelector("#pa-advanced").addEventListener("click", () => {
    filters.advanced = !filters.advanced;
    renderPaths(el); // toggles the flag bar + card badges — full re-render
  });

  // Delegated once: clamp toggles, plus the advanced-view filter chips.
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const flag = e.target.closest("[data-flag]");
    if (flag) {
      const id = flag.dataset.flag;
      filters.flags.has(id) ? filters.flags.delete(id) : filters.flags.add(id);
      renderPaths(el);
      return;
    }
    if (e.target.closest("[data-flag-clear]")) {
      for (const [id] of FLAG_DEFS) filters.flags.delete(id);
      renderPaths(el);
      return;
    }
    const clamp = e.target.closest(".spell-desc, .path-talent");
    if (clamp) clamp.classList.toggle("clamp");
  });
}
