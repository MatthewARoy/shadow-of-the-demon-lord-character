// Spells tab: the learned grimoire with castings trackers, plus the full
// 1,100+ spell browser with filters.

import { rules, spellKey } from "../data.js";
import { compute } from "../engine.js";
import { active, save } from "../state.js";
import { rollD20, rollDamage } from "../dice.js";
import { showToast } from "./toast.js";
import { statBlockHtml } from "./statblock.js";
import { esc } from "./util.js";

// Ranks above 5 effectively never come up in play, so the Archive — and the
// theorycrafting it feeds (combos, sorting) — only ever considers spells up to
// this rank.
const MAX_RANK = 5;

const filters = { q: "", tradition: "", rank: "", type: "", source: "", sort: "", learnable: false, wishlist: false, advanced: false, tags: new Set(), role: "", archetype: "", tempo: "" };

// Efficiency = how a spell ranks among its same-rank, same-kind peers (the
// scorer's percentile). A spell may carry several score records; take its best.
// Unscored spells sort last.
function efficiencyOf(s) {
  const recs = rules.scores?.spells?.[spellKey(s.name, s.tradition)];
  if (!recs?.length) return -1;
  return Math.max(...recs.map((r) => r.percentile ?? 0));
}

const enrichFor = (s) => rules.enrichment?.[spellKey(s.name, s.tradition)];

// Human labels for the LLM build-lens dimensions.
const LENS_LABEL = {
  role: "Role", archetype: "Build", tempo: "Tempo",
  blaster: "Blaster", controller: "Controller", debuffer: "Debuffer", healer: "Healer",
  support: "Support", summoner: "Summoner", skirmisher: "Skirmisher", tank: "Tank",
  face: "Face", enabler: "Enabler", nuker: "Nuker", duelist: "Duelist",
  burst: "Burst", sustained: "Sustained", setup: "Setup", reaction: "Reaction",
  ritual: "Ritual", passive: "Passive",
};
const lensLabel = (v) => LENS_LABEL[v] || (v ? v[0].toUpperCase() + v.slice(1) : v);

export function renderSpells(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);

  el.innerHTML = `
    ${learnedPanel(char, computed)}
    ${studiesPanel(char, computed)}
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
          ${Array.from({ length: MAX_RANK + 1 }, (_, i) => `<option ${filters.rank === String(i) ? "selected" : ""}>${i}</option>`).join("")}
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
        <select id="sp-sort" title="Order the results">
          <option value="" ${filters.sort === "" ? "selected" : ""}>default order</option>
          <option value="rank" ${filters.sort === "rank" ? "selected" : ""}>rank ↑</option>
          <option value="efficiency" ${filters.sort === "efficiency" ? "selected" : ""}>efficiency ↓</option>
        </select>
        <button class="chip ${filters.learnable ? "on" : ""}" id="sp-learnable" title="Spells you could legally learn now">learnable now</button>
        <button class="chip ${filters.wishlist ? "on" : ""}" id="sp-wishlist" title="Only spells on your Future Studies list">★ studies</button>
        <button class="chip ${filters.advanced ? "on" : ""}" id="sp-advanced" title="Show the theorycrafting layer: categories, build lens, combos, and per-spell efficiency &amp; AI labels">⚙ advanced</button>
      </div>
      <p class="filter-summary" id="sp-summary" hidden></p>
      ${filters.advanced ? categoryBar() : ""}
      ${filters.advanced ? buildBar() : ""}
      ${filters.advanced ? comboBar() : ""}
      <div class="spell-grid" id="sp-results"></div>
      <p class="small dim" id="sp-more"></p>
    </div>`;

  renderResults(el, char, computed);
  wire(el, char, computed);
}

let exchangeOpen = null; // spell key whose exchange picker is showing
let creatureOpen = null; // `${spellKey}::${creatureName}` currently expanded

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
    <h2 class="rubric">Grimoire <span class="count">${computed.spells.length} learned · Power ${computed.power}</span>
      <button class="btn btn-small" data-rest style="float:right" title="Complete a rest: heal your healing rate and regain all expended castings">☾ rest</button></h2>
    ${sections}
    ${exchangesList(char)}
    <p class="small dim" style="margin-bottom:0">Castings refresh on a rest. Whenever you learn a new spell you may also exchange a known spell for another of rank ≤ your Power — use ⇄ on a spell above.</p>
  </div>`;
}

// The record of every swap made against this grimoire, as a collapsed
// disclosure. Consecutive exchanges that form a lineage — the gain of one is
// the drop of the next, matched on exact name + tradition — fold into one line
// (A → B → C) whose single "undo last" button pops the most recent link. That
// most-recent link is the highest array index in the run, so undoing it is the
// same splice-one-by-index mutation the loose exchanges use: undo semantics are
// unchanged, only the rendering folds.
function exchangesList(char) {
  const ex = char.exchanges;
  if (!ex?.length) return "";
  const same = (a, b) => a.name === b.name && a.tradition === b.tradition;
  // Walk the list, greedily extending a chain while each gain feeds the next
  // drop. Each run remembers its member indices in array order.
  const runs = [];
  let cur = [0];
  for (let i = 1; i < ex.length; i++) {
    if (same(ex[i - 1].gain, ex[i].drop)) cur.push(i);
    else { runs.push(cur); cur = [i]; }
  }
  runs.push(cur);
  const lines = runs.map((idxs) => {
    const first = ex[idxs[0]];
    const names = [first.drop.name, ...idxs.map((i) => ex[i].gain.name)];
    const path = names.map((n) => `<span class="lg-node">${esc(n)}</span>`).join('<span class="lg-arrow">→</span>');
    // "Undo last" removes the most recent link — the highest index in the run.
    const lastIdx = idxs[idxs.length - 1];
    const undoTitle = idxs.length > 1
      ? `Undo the most recent link — forget ${esc(ex[lastIdx].gain.name)}, relearn ${esc(ex[lastIdx].drop.name)}`
      : `Undo this exchange — forget ${esc(ex[lastIdx].gain.name)}, relearn ${esc(ex[lastIdx].drop.name)}`;
    const undoLabel = idxs.length > 1 ? "undo last" : "undo";
    return `<div class="lg-line">
      <span class="lg-path">${path}</span>
      <button class="btn btn-small" data-unexchange="${lastIdx}" title="${undoTitle}">${undoLabel}</button>
    </div>`;
  }).join("");
  const n = ex.length;
  return `<details class="ledger-log" style="margin-top:12px">
    <summary class="lg-summary">⇄ Exchanged ${n} time${n !== 1 ? "s" : ""}</summary>
    <div class="lg-lines">${lines}</div>
  </details>`;
}

// What stands between you and a wishlisted spell, given your current build.
function studyStatus(s, char, computed, known, discovered) {
  const k = spellKey(s.name, s.tradition);
  if (known.has(k)) return { cls: "learned", label: "learned ✓" };
  const reasons = [];
  if (!discovered.has(s.tradition)) reasons.push(`discover ${esc(s.tradition)}`);
  if (s.rank > computed.power) reasons.push(`Power ${s.rank} (have ${computed.power})`);
  if (!reasons.length) return { cls: "ready", label: "ready to learn" };
  return { cls: "blocked", label: "needs " + reasons.join(" · ") };
}

// Future Studies: the spells you've starred to pick up as you level. Grouped by
// rank, each row shows whether it's learnable now or what's still gating it, so
// the list doubles as a level-up shopping plan.
function studiesPanel(char, computed) {
  const wish = (char.wishlist || []).map((k) => rules.spellByKey.get(k)).filter(Boolean);
  if (!wish.length) {
    return `<div class="panel"><h2 class="rubric">Future Studies</h2>
      <p class="empty">No spells marked yet. Tap ☆ on any spell in the Archive to plan what to learn as you level up.</p></div>`;
  }
  const known = new Set(computed.spells.map((s) => spellKey(s.name, s.tradition)));
  const discovered = new Set(computed.discovered.map((d) => d.tradition));
  const ready = wish.filter((s) => studyStatus(s, char, computed, known, discovered).cls === "ready").length;
  const byRank = new Map();
  for (const s of wish.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))) {
    if (!byRank.has(s.rank)) byRank.set(s.rank, []);
    byRank.get(s.rank).push(s);
  }
  const rows = [...byRank.keys()].sort((a, b) => a - b).map((rank) => `
    <h3 class="small dim" style="font-family:var(--caps);letter-spacing:.1em;margin:12px 0 6px">RANK ${rank}</h3>
    ${byRank.get(rank).map((s) => {
      const st = studyStatus(s, char, computed, known, discovered);
      const trad = rules.traditionByName.get(s.tradition);
      return `<div class="study-row ${st.cls}">
        <button class="study-btn on" data-study="${esc(spellKey(s.name, s.tradition))}" title="Remove from Future Studies">★</button>
        <span class="study-name">${esc(s.name)}</span>
        <span class="tag ${trad ? trad.attribute.toLowerCase() : ""}">${esc(s.tradition)}${trad?.dark ? " ☠" : ""}</span>
        <span class="study-status ${st.cls}">${st.label}</span>
      </div>`;
    }).join("")}`).join("");
  const readyNote = ready ? ` · <span class="study-status ready">${ready} ready to learn</span>` : "";
  return `<div class="panel">
    <h2 class="rubric">Future Studies <span class="count">${wish.length} spell${wish.length !== 1 ? "s" : ""} planned${readyNote}</span></h2>
    ${rows}
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

// Theorycrafting categories: chips grouped by facet, drawn from the tagger's
// taxonomy sidecar. Selecting several narrows the pool to spells carrying ALL
// of them (e.g. "area" + "control" = every AoE lockdown spell).
function categoryBar() {
  const taxo = rules.spellTags;
  if (!taxo?.tags?.length) return "";
  const byFacet = new Map();
  for (const t of taxo.tags) {
    if (!byFacet.has(t.facet)) byFacet.set(t.facet, []);
    byFacet.get(t.facet).push(t);
  }
  const groups = (taxo.facets.length ? taxo.facets : [...byFacet.keys()])
    .filter((f) => byFacet.has(f))
    .map((facet) => `
      <div class="cat-group">
        <span class="cat-facet">${esc(facet)}</span>
        ${byFacet.get(facet).map((t) =>
          `<button class="chip cat ${filters.tags.has(t.id) ? "on" : ""}" data-tag="${esc(t.id)}" title="${esc(t.label)} · ${t.count} spells">${esc(t.label)}</button>`).join("")}
      </div>`).join("");
  const clear = filters.tags.size
    ? `<button class="chip cat-clear" data-tag-clear title="Clear category filters">✕ clear ${filters.tags.size}</button>` : "";
  return `<details class="cat-bar" ${filters.tags.size ? "open" : ""}>
    <summary class="cat-summary">Categories ${filters.tags.size ? `(${filters.tags.size} active)` : "— filter by mechanical effect for theorycrafting"} ${clear}</summary>
    ${groups}
  </details>`;
}

// Build lens: filter by the LLM's judgment labels — primary role, the build
// archetype that wants the spell, and tempo. Each is single-select (click an
// active chip to clear). Only values actually present in the enrichment are
// shown, so it stays sensible even while a run is only partway done.
function buildBar() {
  const enr = rules.enrichment || {};
  const keys = Object.keys(enr);
  if (!keys.length) return "";
  const tally = (pick) => {
    const m = new Map();
    for (const k of keys) for (const v of pick(enr[k])) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const dims = [
    ["role", filters.role, tally((e) => (e.role ? [e.role] : []))],
    ["archetype", filters.archetype, tally((e) => e.archetypes || [])],
    ["tempo", filters.tempo, tally((e) => (e.tempo ? [e.tempo] : []))],
  ];
  const groups = dims.map(([dim, active, vals]) => `
      <div class="cat-group">
        <span class="cat-facet">${esc(LENS_LABEL[dim])}</span>
        ${vals.map(([v, n]) =>
          `<button class="chip cat ${active === v ? "on" : ""}" data-lens="${dim}:${esc(v)}" title="${n} spells">${esc(lensLabel(v))}</button>`).join("")}
      </div>`).join("");
  const active = [filters.role, filters.archetype, filters.tempo].filter(Boolean).length;
  const clear = active ? `<button class="chip cat-clear" data-lens-clear>✕ clear ${active}</button>` : "";
  const coverage = keys.length < rules.spells.length
    ? `<span class="small dim"> · ${keys.length}/${rules.spells.length} labeled</span>` : "";
  return `<details class="cat-bar" ${active ? "open" : ""}>
    <summary class="cat-summary">Build lens ${active ? `(${active} active)` : "— filter by role, build archetype & tempo (AI-labeled)"}${coverage} ${clear}</summary>
    ${groups}
  </details>`;
}

// Combos: what stacks with what, from scripts/detect_combos.py. The detector
// groups spells by fight-goal and lever and ranks the pairings; this panel
// renders them with a synergy badge and the why. Each member spell is a button
// that searches the Archive for it, so a combo is a jump-off to the cards.
const COMBO_TYPE = {
  compounding: { label: "compounds", title: "Different levers on one goal — they multiply, dodging each other's diminishing returns." },
  additive:    { label: "stacks",    title: "Flat bonuses that add together — pile them on." },
  diminishing: { label: "diminishes", title: "Same roll-lever: boons/banes pool to the highest die, so extra sources barely help." },
};

function comboMember(m) {
  const mag = m.magnitude ? ` <span class="dim">${esc(m.magnitude)}</span>` : "";
  // A star when the piece is also individually strong for its rank (top third),
  // from the per-spell scorer; the title spells out the percentile.
  const star = m.quality != null && m.quality >= 0.66 ? `<span class="combo-star">★</span>` : "";
  const qtip = m.quality != null
    ? ` · ${ordinal(Math.round(m.quality * 100))} pct ${m.strength?.kind || ""} for its rank` : "";
  return `<button class="chip combo-member" data-find="${esc(m.name)}" title="Find ${esc(m.name)} (${esc(m.tradition)}, rank ${m.rank}) in the Archive${esc(qtip)}">${esc(m.name)}${mag}${star}</button>`;
}

function comboBar() {
  const data = rules.combos;
  if (!data?.combos?.length) return "";
  // A combo only counts if every piece is castable in a realistic game (rank ≤
  // MAX_RANK) — drop any that lean on a high-rank spell that never gets cast.
  const combos = data.combos.filter((c) => c.members.every((m) => (m.rank ?? 0) <= MAX_RANK));
  if (!combos.length) return "";
  const byGoal = new Map();
  for (const c of combos) {
    if (!byGoal.has(c.goal)) byGoal.set(c.goal, []);
    byGoal.get(c.goal).push(c);
  }
  const sections = [...byGoal.entries()].map(([goal, list]) => {
    const g = data.goals[goal] || { label: goal, desc: "" };
    const rows = list.map((c) => {
      const t = COMBO_TYPE[c.type] || { label: c.type, title: "" };
      const flags = [
        c.all_precastable ? `<span class="combo-flag precast" title="Every piece lasts minutes+, so you can cast them before the fight — no action cost once combat starts">pre-cast</span>` : "",
        c.fragile ? `<span class="combo-flag fragile" title="Needs 2+ concentration spells up at once — taking damage forces a challenge roll to keep each">fragile</span>` : "",
      ].join("");
      const more = Object.entries(c.alternatives || {})
        .map(([lever, n]) => n > 1 ? `${n} ${esc(lever)}` : null).filter(Boolean).join(" · ");
      return `<div class="combo-row">
        <div class="combo-head">
          <span class="combo-type ${esc(c.type)}" title="${esc(t.title)}">${esc(t.label)}</span>
          ${c.members.map(comboMember).join("")}
          ${flags}
        </div>
        <p class="combo-why">${esc(c.rationale)}${more ? ` <span class="dim">— ${more} to choose from</span>` : ""}</p>
      </div>`;
    }).join("");
    return `<div class="combo-goal">
      <div class="cat-facet">${esc(g.label)} <span class="small dim">${esc(g.desc)}</span></div>
      ${rows}
    </div>`;
  }).join("");
  const n = combos.length;
  return `<details class="cat-bar combo-bar" open>
    <summary class="cat-summary">Combos — what stacks with what <span class="small dim">(${n} synergies; cross-lever combos compound, same roll-lever diminishes)</span></summary>
    ${sections}
  </details>`;
}

function renderResults(el, char, computed) {
  const box = el.querySelector("#sp-results");
  const more = el.querySelector("#sp-more");
  let pool = rules.spells;
  const learnableKeys = filters.learnable ? legalNowKeys(char, computed) : null;
  const wishKeys = filters.wishlist ? new Set(char.wishlist || []) : null;
  const q = filters.q.trim().toLowerCase();
  pool = pool.filter((s) => {
    if (s.rank > MAX_RANK) return false;
    if (wishKeys && !wishKeys.has(spellKey(s.name, s.tradition))) return false;
    if (filters.tradition && s.tradition !== filters.tradition) return false;
    if (filters.rank !== "" && s.rank !== parseInt(filters.rank, 10)) return false;
    if (filters.type && s.type !== filters.type) return false;
    if (filters.source && s.source !== filters.source) return false;
    if (filters.tags.size) {
      const have = new Set(s.tags || []);
      for (const t of filters.tags) if (!have.has(t)) return false;
    }
    if (filters.role || filters.archetype || filters.tempo) {
      const e = enrichFor(s);
      if (!e) return false;
      if (filters.role && e.role !== filters.role) return false;
      if (filters.archetype && !(e.archetypes || []).includes(filters.archetype)) return false;
      if (filters.tempo && e.tempo !== filters.tempo) return false;
    }
    if (learnableKeys && !learnableKeys.has(spellKey(s.name, s.tradition))) return false;
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    return true;
  });
  if (filters.sort === "efficiency") {
    pool = [...pool].sort((a, b) => efficiencyOf(b) - efficiencyOf(a) || a.name.localeCompare(b.name));
  } else if (filters.sort === "rank") {
    pool = [...pool].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }
  const known = new Set(computed.spells.map((s) => spellKey(s.name, s.tradition)));
  const shown = pool.slice(0, 60);
  box.innerHTML = shown.map((s) => spellCard(s, { learned: known.has(spellKey(s.name, s.tradition)), char, computed })).join("") ||
    `<p class="empty">Nothing in the archive matches.</p>`;
  more.textContent = pool.length > shown.length ? `Showing ${shown.length} of ${pool.length} — refine the filters to see the rest.` : "";
  renderFilterSummary(el, pool.length);
}

// The active-filter chips that appear beneath the filter bar. Each entry is a
// filter whose current value deviates from its default (the "inactive" value in
// the `filters` object): a search query, a chosen select value, an engaged
// toggle, a picked category/lens. `advanced` is a display toggle for the
// theorycrafting layer, not a result filter, so it is deliberately excluded.
function activeFilterChips() {
  const chips = [];
  const q = filters.q.trim();
  if (q) chips.push({ key: "q", label: `"${esc(q)}"` });
  if (filters.tradition) chips.push({ key: "tradition", label: esc(filters.tradition) });
  if (filters.rank !== "") chips.push({ key: "rank", label: `rank ${esc(filters.rank)}` });
  if (filters.type) chips.push({ key: "type", label: esc(filters.type) });
  if (filters.source) {
    const book = { core: "Core", occult: "Occult Philosophy", terrible: "Terrible Beauty" }[filters.source] || filters.source;
    chips.push({ key: "source", label: esc(book) });
  }
  if (filters.sort) {
    const order = { rank: "rank ↑", efficiency: "efficiency ↓" }[filters.sort] || filters.sort;
    chips.push({ key: "sort", label: esc(order) });
  }
  if (filters.learnable) chips.push({ key: "learnable", label: "learnable now" });
  if (filters.wishlist) chips.push({ key: "wishlist", label: "★ studies" });
  if (filters.role) chips.push({ key: "role", label: esc(lensLabel(filters.role)) });
  if (filters.archetype) chips.push({ key: "archetype", label: esc(lensLabel(filters.archetype)) });
  if (filters.tempo) chips.push({ key: "tempo", label: esc(lensLabel(filters.tempo)) });
  for (const t of filters.tags) chips.push({ key: "tag", value: t, label: esc(tagLabel(t)) });
  return chips;
}

// Reset a single filter to its default (its "inactive" value). Category tags
// are keyed individually via the chip's data-value; everything else clears the
// named field. Mirrors the defaults declared on the `filters` object.
function resetFilter(key, value) {
  switch (key) {
    case "q": filters.q = ""; break;
    case "tradition": filters.tradition = ""; break;
    case "rank": filters.rank = ""; break;
    case "type": filters.type = ""; break;
    case "source": filters.source = ""; break;
    case "sort": filters.sort = ""; break;
    case "learnable": filters.learnable = false; break;
    case "wishlist": filters.wishlist = false; break;
    case "role": filters.role = ""; break;
    case "archetype": filters.archetype = ""; break;
    case "tempo": filters.tempo = ""; break;
    case "tag": filters.tags.delete(value); break;
  }
}

// Reset every filter and the search box to defaults in one stroke.
function clearAllFilters() {
  filters.q = filters.tradition = filters.rank = filters.type = filters.source = filters.sort = "";
  filters.role = filters.archetype = filters.tempo = "";
  filters.learnable = filters.wishlist = false;
  filters.tags.clear();
}

function renderFilterSummary(el, count) {
  const box = el.querySelector("#sp-summary");
  if (!box) return;
  const chips = activeFilterChips();
  if (!chips.length) { box.hidden = true; box.innerHTML = ""; return; }
  const total = rules.spells.length;
  const chipHtml = chips.map((c) =>
    `<button class="chip fs-chip" data-filter-reset="${esc(c.key)}"${c.value != null ? ` data-filter-value="${esc(c.value)}"` : ""} title="Remove this filter">${c.label} ✕</button>`).join("");
  box.hidden = false;
  box.innerHTML =
    `<span class="fs-count">${count.toLocaleString()} of ${total.toLocaleString()} spells</span>` +
    `<span class="fs-chips">${chipHtml}</span>` +
    `<button class="fs-clear" data-filter-clear>clear all</button>`;
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

// id -> human label, built once from the taxonomy sidecar.
let tagLabelMap = null;
function tagLabel(id) {
  if (!tagLabelMap) {
    tagLabelMap = new Map((rules.spellTags?.tags || []).map((t) => [t.id, t.label]));
  }
  return tagLabelMap.get(id) || id;
}

// Category chips on a card — clicking one adds it to the active filter, so a
// spell's tags double as a jump-off point for finding its synergy partners.
function tagChips(s) {
  if (!s.tags?.length) return "";
  return `<div class="spell-cats">${s.tags.map((t) =>
    `<button class="cat-tag ${filters.tags.has(t) ? "on" : ""}" data-tag="${esc(t)}" title="Filter by: ${esc(tagLabel(t))}">${esc(tagLabel(t))}</button>`).join("")}</div>`;
}

// Effectiveness badges (score_spells.py): expected output + where it sits among
// same-rank, same-kind peers (percentile), with reliability/area as flags.
const SCORE_ICON = { damage: "⚔", heal: "✚", mitigation: "🛡" };
const UNIT_LABEL = {
  damage: "avg dmg", health: "HP", "healing-rate": "× rate",
  "%damage": "% reduced", "damage-reduced": "less/hit", "temp-health": "HP buffer",
};
function scoreBadge(s) {
  const recs = rules.scores?.spells?.[spellKey(s.name, s.tradition)];
  if (!recs?.length) return "";
  const badges = recs.map((sc) => {
    const icon = SCORE_ICON[sc.kind] || "•";
    const pct = sc.percentile != null && sc.cohort_n > 2
      ? `<b>${ordinal(Math.round(sc.percentile * 100))}</b> pct` : "";
    const val = sc.value != null
      ? `${sc.unit === "healing-rate" ? sc.value + "×" : sc.value} <span class="dim">${UNIT_LABEL[sc.unit] || sc.unit}</span>`
      : `<span class="dim">see text</span>`;
    const flags = Object.entries(sc.flags || {}).filter(([, on]) => on)
      .map(([f]) => `<span class="score-flag">${f}</span>`).join("");
    const tip = `Rank ${sc.rank} ${sc.kind}: ${sc.expr || ""}` +
      (pct ? ` — better than ${Math.round(sc.percentile * 100)}% of rank-${sc.rank} ${sc.kind} spells (n=${sc.cohort_n})` : ` (only ${sc.cohort_n} at this rank)`);
    return `<span class="score-badge ${sc.kind}" title="${esc(tip)}">${icon} ${val}${pct ? " · " + pct : ""}${flags}</span>`;
  }).join("");
  return `<div class="spell-scores">${badges}</div>`;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// AI build-lens block: role/build/tempo as click-to-filter badges plus the
// one-line synergy note. Only shown for spells the enrichment pass has reached.
function enrichBlock(s) {
  const e = enrichFor(s);
  if (!e) return "";
  const badge = (dim, v) =>
    `<button class="lens-badge ${dim}" data-lens="${dim}:${esc(v)}" title="Filter by ${esc(LENS_LABEL[dim])}: ${esc(lensLabel(v))}">${esc(lensLabel(v))}</button>`;
  const badges = [
    e.role ? badge("role", e.role) : "",
    ...(e.archetypes || []).map((a) => badge("archetype", a)),
    e.tempo ? badge("tempo", e.tempo) : "",
  ].join("");
  return `<div class="spell-lens">
    <div class="lens-badges">${badges}</div>
    ${e.synergy ? `<p class="lens-synergy">${esc(e.synergy)}</p>` : ""}
  </div>`;
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
  const summons = rules.summonsBySpell.get(key) || [];
  const summonBtns = summons.map((cr) =>
    `<button class="chip ${creatureOpen === key + "::" + cr.name ? "on" : ""}" data-creature="${esc(key)}::${esc(cr.name)}" title="View the ${esc(cr.name)} stat block (${cr.book === "core" ? "Core" : "Occult Philosophy"} p.${cr.page})">☠ ${esc(cr.name)}</button>`).join(" ");
  const openCreature = summons.find((cr) => creatureOpen === key + "::" + cr.name);
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
    ${filters.advanced ? tagChips(s) : ""}
    ${filters.advanced ? scoreBadge(s) : ""}
    ${filters.advanced ? enrichBlock(s) : ""}
    <p class="spell-desc clamp" title="Click to expand" tabindex="0" role="button" aria-expanded="false">${esc(s.description)}</p>
    ${summonBtns ? `<div class="chip-row" style="margin:4px 0 6px">${summonBtns}</div>` : ""}
    ${openCreature ? statBlockHtml(openCreature) : ""}
    ${opts.learned && exchangeOpen === key ? exchangePicker(opts.char, opts.computed, s) : ""}
    <div class="spell-foot">
      ${castingsRow || `<span class="small dim">${s.source === "core" ? "Core" : s.source === "occult" ? "Occult Philosophy" : "Terrible Beauty"} · p.${s.page}</span>`}
      <span>${infoBtn(s)} ${opts.learned ? "" : studyBtn(s, opts.char)} ${exchangeBtn} ${attackBtn}</span>
    </div>
  </div>`;
}

// ---- Spell detail popup -------------------------------------------------
// A small ⓘ on every card opens a focused popup gathering everything the data
// pipeline knows about one spell — parsed stats, theorycrafting categories,
// effectiveness scores and AI build-lens labels — in one place, regardless of
// the Archive's advanced toggle. The popup also carries a "relabel" action
// that opens a prefilled GitHub issue: spells are occasionally mislabeled
// (e.g. Evoke Gale is typed Attack when it is really utility / crowd control),
// and this gives players a one-click way to report the correction.

const GH_REPO = "MatthewARoy/shadow-of-the-demon-lord-character";

function infoBtn(s) {
  return `<button class="btn btn-small spell-info-btn" data-info="${esc(spellKey(s.name, s.tradition))}" title="Detailed info — tags, stats & relabel">ⓘ</button>`;
}

// Build a GitHub "new issue" URL prefilled with the spell's current labels, so
// the report names exactly what looks wrong. Works from the static page with no
// API token: the user's own browser session authors the issue.
function relabelIssueUrl(s) {
  const cats = (s.tags || []).map(tagLabel).join(", ") || "none";
  const e = enrichFor(s);
  const lens = e
    ? `role=${e.role || "—"}, build=${(e.archetypes || []).join("/") || "—"}, tempo=${e.tempo || "—"}`
    : "none";
  const src = s.source === "core" ? "Core Rulebook" : s.source === "occult" ? "Occult Philosophy" : "Terrible Beauty";
  const title = `Relabel: ${s.name} (${s.tradition})`;
  const body = [
    `**Spell:** ${s.name}`,
    `**Tradition:** ${s.tradition}`,
    `**Rank:** ${s.rank}`,
    `**Current type:** ${s.type}`,
    `**Current categories:** ${cats}`,
    `**Current build lens:** ${lens}`,
    `**Source:** ${src}, p.${s.page}`,
    ``,
    `### Suggested correction`,
    `<!-- Describe what this spell should be labeled as and why, e.g.`,
    `"Evoke Gale is typed Attack but is really Utility / crowd control." -->`,
    ``,
  ].join("\n");
  return `https://github.com/${GH_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// Static (non-interactive) build-lens badges for the popup — the filtering
// variant in enrichBlock() relies on the Archive's delegated handlers, which
// don't reach the popup since it lives outside the tab element.
function lensStatic(s) {
  const e = enrichFor(s);
  if (!e) return "";
  const badge = (dim, v) => `<span class="lens-badge ${dim}">${esc(lensLabel(v))}</span>`;
  const badges = [
    e.role ? badge("role", e.role) : "",
    ...(e.archetypes || []).map((a) => badge("archetype", a)),
    e.tempo ? badge("tempo", e.tempo) : "",
  ].join("");
  if (!badges && !e.synergy) return "";
  return `<div class="spell-lens"><div class="lens-badges">${badges}</div>${e.synergy ? `<p class="lens-synergy">${esc(e.synergy)}</p>` : ""}</div>`;
}

function spellModalHtml(s) {
  const trad = rules.traditionByName.get(s.tradition);
  const attrClass = trad ? trad.attribute.toLowerCase() : "";
  const stats = [];
  if (s.requirement) stats.push(["Requirement", s.requirement]);
  if (s.target) stats.push(["Target", s.target]);
  if (s.area) stats.push(["Area", s.area]);
  if (s.duration) stats.push(["Duration", s.duration]);
  if (s.attack) {
    const a = s.attack;
    stats.push(["Attack", `${a.attribute} vs ${a.against}${a.damage ? ` · ${a.damage} damage` : ""}`]);
  }
  const statRows = stats.map(([k, v]) =>
    `<div class="sm-stat"><span class="sm-k">${esc(k)}</span><span class="sm-v">${esc(v)}</span></div>`).join("");
  const cats = s.tags?.length
    ? `<div class="sm-section"><h4>Categories</h4><div class="spell-cats">${
        s.tags.map((t) => `<span class="cat-tag">${esc(tagLabel(t))}</span>`).join("")}</div></div>`
    : "";
  const scores = scoreBadge(s);
  const scoreSec = scores ? `<div class="sm-section"><h4>Effectiveness</h4>${scores}</div>` : "";
  const lens = lensStatic(s);
  const lensSec = lens ? `<div class="sm-section"><h4>Build lens</h4>${lens}</div>` : "";
  const src = s.source === "core" ? "Core Rulebook" : s.source === "occult" ? "Occult Philosophy" : "Terrible Beauty";
  return `
  <div class="spell-modal-box" role="dialog" aria-modal="true" aria-label="${esc(s.name)} details" tabindex="-1">
    <button class="sm-close" data-modal-close title="Close (Esc)">✕</button>
    <div class="sm-head">
      <span class="spell-name">${esc(s.name)}</span>
      <span class="spell-tags">
        <span class="tag rank">Rank ${s.rank}</span>
        <span class="tag ${s.type.toLowerCase()}">${esc(s.type)}</span>
        <span class="tag ${attrClass}">${esc(s.tradition)}${trad?.dark ? " ☠" : ""}</span>
      </span>
    </div>
    ${statRows ? `<div class="sm-stats">${statRows}</div>` : ""}
    ${cats}
    ${scoreSec}
    ${lensSec}
    <div class="sm-section"><h4>Description</h4><p class="sm-desc">${esc(s.description)}</p></div>
    <div class="sm-foot">
      <span class="small dim">${src} · p.${s.page}</span>
      <a class="btn btn-small btn-resolve" href="${relabelIssueUrl(s)}" target="_blank" rel="noopener"
         title="Open a prefilled GitHub issue to suggest a corrected label for this spell">⚑ Relabel…</a>
    </div>
  </div>`;
}

let modalEl = null;
let modalReturnFocus = null; // element focused before the modal opened

// The elements the focus trap cycles through, in DOM order.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
}

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement("div");
  modalEl.className = "spell-modal";
  modalEl.hidden = true;
  // Backdrop click or the ✕ closes; the relabel link (an <a>) opens normally.
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl || e.target.closest("[data-modal-close]")) closeSpellModal();
  });
  document.addEventListener("keydown", (e) => {
    if (modalEl.hidden) return;
    if (e.key === "Escape") { closeSpellModal(); return; }
    if (e.key !== "Tab") return;
    // Trap Tab/Shift+Tab within the dialog's focusable elements, wrapping.
    const box = modalEl.querySelector(".spell-modal-box");
    if (!box) return;
    const items = focusablesIn(box);
    if (!items.length) { e.preventDefault(); box.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const activeInside = box.contains(document.activeElement) ? document.activeElement : null;
    if (e.shiftKey && (activeInside === first || activeInside === box || !activeInside)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (activeInside === last || activeInside === box || !activeInside)) {
      e.preventDefault(); first.focus();
    }
  });
  document.body.appendChild(modalEl);
  return modalEl;
}
function closeSpellModal() {
  if (!modalEl || modalEl.hidden) return;
  modalEl.hidden = true;
  // Restore focus to whatever opened the modal (the ⓘ button), on every close
  // path — Esc, ✕, or backdrop click all funnel through here.
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && typeof back.focus === "function") back.focus();
}
function openSpellModal(key) {
  const s = rules.spellByKey.get(key);
  if (!s) return;
  const m = ensureModal();
  // Remember what to return focus to before the dialog steals it.
  modalReturnFocus = document.activeElement;
  m.innerHTML = spellModalHtml(s);
  m.hidden = false;
  // Move focus into the dialog so keyboard users land inside it.
  m.querySelector(".spell-modal-box")?.focus();
}

// Star toggle: add/remove a spell from the character's Future Studies list.
function studyBtn(s, char) {
  const on = (char?.wishlist || []).includes(spellKey(s.name, s.tradition));
  return `<button class="study-btn ${on ? "on" : ""}" data-study="${esc(spellKey(s.name, s.tradition))}" title="${on ? "Remove from Future Studies" : "Mark as interested — add to Future Studies"}">${on ? "★" : "☆"}</button>`;
}

function castingsPips(s, opts) {
  const key = spellKey(s.name, s.tradition);
  const used = opts.char.expended[key] || 0;
  const pips = Array.from({ length: opts.castings }, (_, i) =>
    `<span class="cast-pip ${i < used ? "spent" : ""}" data-pip="${esc(key)}" data-i="${i}" title="${i < used ? "Expended — click to restore one casting" : "Click to expend one casting"}"></span>`);
  return `<span class="castings">${pips.join("")}</span>`;
}

// Toggle a clamped description block and keep aria-expanded in step (clamped =
// collapsed = expanded false). Shared by click and keyboard handlers.
function toggleClamp(node) {
  const clamped = node.classList.toggle("clamp");
  if (node.hasAttribute("role")) node.setAttribute("aria-expanded", clamped ? "false" : "true");
}

function wire(el, char, computed) {
  const rerun = () => { renderResults(el, char, computed); };
  el.querySelector("#sp-q").addEventListener("input", (e) => { filters.q = e.target.value; rerun(); });
  el.querySelector("#sp-tradition").addEventListener("change", (e) => { filters.tradition = e.target.value; rerun(); });
  el.querySelector("#sp-rank").addEventListener("change", (e) => { filters.rank = e.target.value; rerun(); });
  el.querySelector("#sp-type").addEventListener("change", (e) => { filters.type = e.target.value; rerun(); });
  el.querySelector("#sp-source").addEventListener("change", (e) => { filters.source = e.target.value; rerun(); });
  el.querySelector("#sp-sort").addEventListener("change", (e) => { filters.sort = e.target.value; rerun(); });
  el.querySelector("#sp-advanced").addEventListener("click", () => {
    filters.advanced = !filters.advanced;
    renderSpells(el);  // toggles whole panels + card decorations, so full re-render
  });
  el.querySelector("#sp-learnable").addEventListener("click", (e) => {
    filters.learnable = !filters.learnable;
    e.target.classList.toggle("on", filters.learnable);
    rerun();
  });
  el.querySelector("#sp-wishlist").addEventListener("click", (e) => {
    filters.wishlist = !filters.wishlist;
    e.target.classList.toggle("on", filters.wishlist);
    rerun();
  });

  // Delegated handlers attach once; state is looked up fresh per event.
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", (e) => {
    const c = active();
    if (!c) return;
    const info = e.target.closest("[data-info]");
    if (info) {
      e.preventDefault();
      openSpellModal(info.dataset.info);
      return;
    }
    const find = e.target.closest("[data-find]");
    if (find) {
      e.preventDefault();
      // Jump from a combo to its spell: clear filters that would hide it, set
      // the search to its name, and scroll the results into view.
      filters.q = find.dataset.find;
      filters.tradition = filters.rank = filters.type = filters.source = "";
      filters.role = filters.archetype = filters.tempo = "";
      filters.tags.clear();
      filters.learnable = false;
      renderSpells(el);
      el.querySelector("#sp-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // Filter-summary chips: each removes one active filter; "clear all" resets
    // every filter and the search box. Full re-render so the filter-bar
    // controls (selects, toggle chips) resync to the new state.
    const fsReset = e.target.closest("[data-filter-reset]");
    if (fsReset) {
      e.preventDefault();
      resetFilter(fsReset.dataset.filterReset, fsReset.dataset.filterValue);
      renderSpells(el);
      return;
    }
    if (e.target.closest("[data-filter-clear]")) {
      e.preventDefault();
      clearAllFilters();
      renderSpells(el);
      return;
    }

    const tagChip = e.target.closest("[data-tag]");
    if (tagChip) {
      const t = tagChip.dataset.tag;
      filters.tags.has(t) ? filters.tags.delete(t) : filters.tags.add(t);
      renderSpells(el);
      return;
    }
    if (e.target.closest("[data-tag-clear]")) {
      e.preventDefault();
      filters.tags.clear();
      renderSpells(el);
      return;
    }
    const lens = e.target.closest("[data-lens]");
    if (lens) {
      e.preventDefault();
      const [dim, val] = lens.dataset.lens.split(":");
      filters[dim] = filters[dim] === val ? "" : val;  // single-select toggle
      renderSpells(el);
      return;
    }
    if (e.target.closest("[data-lens-clear]")) {
      e.preventDefault();
      filters.role = filters.archetype = filters.tempo = "";
      renderSpells(el);
      return;
    }
    const study = e.target.closest("[data-study]");
    if (study) {
      const key = study.dataset.study;
      c.wishlist = c.wishlist || [];
      const i = c.wishlist.indexOf(key);
      i === -1 ? c.wishlist.push(key) : c.wishlist.splice(i, 1);
      save();
      renderSpells(el);
      return;
    }

    const desc = e.target.closest(".spell-desc");
    if (desc) { toggleClamp(desc); return; }

    const crBtn = e.target.closest("[data-creature]");
    if (crBtn) {
      creatureOpen = creatureOpen === crBtn.dataset.creature ? null : crBtn.dataset.creature;
      renderSpells(el);
      return;
    }
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

    const rest = e.target.closest("[data-rest]");
    if (rest) {
      const comp = compute(c);
      const healed = Math.min(c.damage, comp.healingRate);
      c.damage -= healed;
      c.expended = {};
      save(); renderSpells(el);
      showToast({ total: "☾", label: "Rest completed", detail: `Healed ${healed} damage and regained all castings.` });
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

  // Keyboard reach for the clamp toggle on spell descriptions: Enter/Space
  // expand/collapse, Space also preventing the page from scrolling.
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const desc = e.target.closest(".spell-desc[role='button']");
    if (!desc) return;
    e.preventDefault();
    toggleClamp(desc);
  });
}

