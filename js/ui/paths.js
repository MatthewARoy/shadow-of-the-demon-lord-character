// Paths tab: a searchable browser for the 165 expert & master paths, modeled
// on the Spells Archive. Every path carries its full per-level benefits —
// attribute increases, characteristic gains, magic, languages/professions, and
// talents — so this doubles as a "what do I get if I take this path?" planner.

import { rules } from "../data.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const BOOKS = { core: "Core Rulebook", occult: "Occult Philosophy", terrible: "Terrible Beauty" };

const filters = { q: "", type: "", source: "", sort: "" };

const CHAR_LABEL = {
  health: "Health", power: "Power", defense: "Defense", perception: "Perception",
  size: "Size", speed: "Speed", insanity: "Insanity", corruption: "Corruption",
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

function pathCard(p) {
  const levels = Object.keys(p.levels).sort((a, b) => +a - +b);
  return `
  <div class="spell-card path-card">
    <div class="spell-head">
      <span class="spell-name">${esc(p.name)}</span>
      <span class="spell-tags">
        <span class="tag rank">${p.type === "expert" ? "Expert" : "Master"}</span>
        <span class="tag">${BOOKS[p.source] || p.source}</span>
      </span>
    </div>
    <p class="spell-desc clamp" title="Click to expand">${esc(p.description)}</p>
    ${levels.map((lvl) => levelBlock(lvl, p.levels[lvl])).join("")}
    <div class="spell-foot">
      <span class="small dim">${BOOKS[p.source] || p.source} · p.${p.page}</span>
    </div>
  </div>`;
}

// Build the haystack a path is searched against: name, description, and every
// talent name + text, so a search for "summon" or a talent name finds it.
function haystack(p) {
  const parts = [p.name, p.description];
  for (const e of Object.values(p.levels)) {
    if (e.magic?.raw) parts.push(e.magic.raw);
    for (const t of e.talents || []) parts.push(t.name, t.text);
  }
  return parts.join(" ").toLowerCase();
}

export function renderPaths(el) {
  const expert = rules.paths.filter((p) => p.type === "expert").length;
  const master = rules.paths.filter((p) => p.type === "master").length;
  el.innerHTML = `
    <div class="panel">
      <h2 class="rubric">The Paths <span class="count">${expert} expert · ${master} master paths</span></h2>
      <div class="filter-bar">
        <input type="text" id="pa-q" placeholder="Search names, descriptions, and talents…" value="${esc(filters.q)}">
        <select id="pa-type">
          <option value="">expert &amp; master</option>
          <option value="expert" ${filters.type === "expert" ? "selected" : ""}>Expert (level 3)</option>
          <option value="master" ${filters.type === "master" ? "selected" : ""}>Master (level 7)</option>
        </select>
        <select id="pa-source">
          <option value="">all books</option>
          <option value="core" ${filters.source === "core" ? "selected" : ""}>Core</option>
          <option value="occult" ${filters.source === "occult" ? "selected" : ""}>Occult Philosophy</option>
          <option value="terrible" ${filters.source === "terrible" ? "selected" : ""}>Terrible Beauty</option>
        </select>
        <select id="pa-sort" title="Order the results">
          <option value="" ${filters.sort === "" ? "selected" : ""}>name ↑</option>
          <option value="type" ${filters.sort === "type" ? "selected" : ""}>type then name</option>
          <option value="source" ${filters.sort === "source" ? "selected" : ""}>book then name</option>
        </select>
      </div>
      <div class="spell-grid" id="pa-results"></div>
      <p class="small dim" id="pa-more"></p>
    </div>`;
  renderResults(el);
  wire(el);
}

function renderResults(el) {
  const box = el.querySelector("#pa-results");
  const more = el.querySelector("#pa-more");
  const q = filters.q.trim().toLowerCase();
  let pool = rules.paths.filter((p) => {
    if (filters.type && p.type !== filters.type) return false;
    if (filters.source && p.source !== filters.source) return false;
    if (q && !haystack(p).includes(q)) return false;
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (filters.sort === "type") {
    // expert before master, then alphabetical
    pool = [...pool].sort((a, b) => a.type.localeCompare(b.type) || byName(a, b));
  } else if (filters.sort === "source") {
    pool = [...pool].sort((a, b) => a.source.localeCompare(b.source) || byName(a, b));
  } else {
    pool = [...pool].sort(byName);
  }
  box.innerHTML = pool.map(pathCard).join("") || `<p class="empty">No path matches your search.</p>`;
  more.textContent = pool.length
    ? `${pool.length} path${pool.length !== 1 ? "s" : ""} shown.`
    : "";
}

function wire(el) {
  const rerun = () => renderResults(el);
  el.querySelector("#pa-q").addEventListener("input", (e) => { filters.q = e.target.value; rerun(); });
  el.querySelector("#pa-type").addEventListener("change", (e) => { filters.type = e.target.value; rerun(); });
  el.querySelector("#pa-source").addEventListener("change", (e) => { filters.source = e.target.value; rerun(); });
  el.querySelector("#pa-sort").addEventListener("change", (e) => { filters.sort = e.target.value; rerun(); });

  // Delegated once: click a clamped description or talent to expand it.
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const clamp = e.target.closest(".spell-desc, .path-talent");
    if (clamp) clamp.classList.toggle("clamp");
  });
}
