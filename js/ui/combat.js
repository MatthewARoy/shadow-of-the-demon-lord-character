// Combat tab: a character-aware quick reference for actions, attack options,
// turn economy, afflictions, and modifiers.
//
// data/combat.json is hand-written rather than parsed (see
// docs/superpowers/specs/2026-07-25-combat-quick-reference-design.md). It is
// loaded lazily on first visit rather than in loadRules(), so a malformed
// file breaks this tab alone instead of bricking boot.

import { active } from "../state.js";
import { compute } from "../engine.js";
import { BOOKS } from "../data.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const LINK_LABELS = [
  ["inflicts", "inflicts"],
  ["requires_condition", "needs"],
  ["removes", "removes"],
  ["see_also", "see"],
];

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

// ---------------------------------------------------------------------------
// Loading and rendering
// ---------------------------------------------------------------------------

let data = null;      // {version, groups, entries}
let byId = new Map();
let loading = null;
let dataError = null;
// Session-scoped, exactly as lookup.js keeps its query: these survive tab
// switches and reset on reload.
let group = "all";
let query = "";

function ensureData() {
  if (data) return Promise.resolve(data);
  if (!loading) {
    loading = fetch("data/combat.json")
      .then((r) => {
        if (!r.ok) throw new Error(`combat.json: ${r.status}`);
        return r.json();
      })
      .then((json) => {
        data = json;
        byId = new Map(json.entries.map((e) => [e.id, e]));
        dataError = null;
        return data;
      })
      .catch((err) => {
        loading = null;            // allow a retry
        dataError = err;
        throw err;
      });
  }
  return loading;
}

// compute() dereferences char.ancestry on its first statement and throws on
// null, so the no-character path must never reach it. Unlike every other tab,
// this one still renders its full content — a reference that shows nothing
// without a character is useless. It just omits the derived values.
function computedFor(char) {
  if (!char) return null;
  try {
    return compute(char);
  } catch (err) {
    console.error("combat: compute() failed, falling back to no-derive mode", err);
    return null;
  }
}

export function renderCombat(el) {
  const computed = computedFor(active());

  el.innerHTML = `
  <div class="panel">
    <h2 class="rubric">Combat Reference <span class="count" id="cb-count"></span></h2>
    <div class="filter-bar">
      <label class="sr-only" for="cb-q">Filter combat entries</label>
      <input type="text" id="cb-q" placeholder="shove, prone, bane, triggered…" value="${esc(query)}" autocomplete="off">
    </div>
    <div class="chip-row" id="cb-groups" style="margin-bottom:14px"></div>
    <div id="cb-results" aria-live="polite"></div>
  </div>`;

  const input = el.querySelector("#cb-q");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = input.value; paint(el, computed); }, 120);
  });
  el.querySelector("#cb-groups").addEventListener("click", (e) => {
    const g = e.target.closest("[data-group]")?.dataset.group;
    if (!g) return;
    group = g;
    paint(el, computed);
  });
  el.querySelector("#cb-results").addEventListener("click", (e) => {
    const link = e.target.closest("[data-goto]");
    if (!link) return;
    const target = byId.get(link.dataset.goto);
    if (!target) return;
    group = target.group;
    query = target.name;
    input.value = target.name;
    paint(el, computed);
  });

  paint(el, computed);
  ensureData().then(() => paint(el, computed)).catch(() => paint(el, computed));
}

function paint(el, computed) {
  const groups = el.querySelector("#cb-groups");
  const box = el.querySelector("#cb-results");
  const count = el.querySelector("#cb-count");
  if (!box) return;

  if (dataError) {
    groups.innerHTML = "";
    count.textContent = "";
    box.innerHTML = `<p class="empty">The war-book is unreachable — ${esc(dataError.message)}.
      <button class="btn btn-small" id="cb-retry">Try again</button></p>`;
    el.querySelector("#cb-retry").addEventListener("click", () => {
      dataError = null;
      ensureData().then(() => paint(el, computed)).catch(() => paint(el, computed));
    });
    return;
  }
  if (!data) {
    count.textContent = "mustering…";
    box.innerHTML = `<p class="empty">Mustering the war-book…</p>`;
    return;
  }

  const all = [{ id: "all", label: "All", blurb: "" }, ...data.groups];
  groups.innerHTML = all.map((g) =>
    `<button class="chip ${g.id === group ? "on" : ""}" data-group="${esc(g.id)}"
       aria-pressed="${g.id === group}"${g.blurb ? ` title="${esc(g.blurb)}"` : ""}>${esc(g.label)}</button>`).join("");

  const hits = filterEntries(data.entries, group, query);
  count.textContent = `${hits.length} of ${data.entries.length}`;
  if (!hits.length) {
    box.innerHTML = `<p class="empty">Nothing in the war-book speaks of “${esc(query)}”.</p>`;
    return;
  }
  box.innerHTML = hits.map((e) => card(e, computed)).join("");
}

function card(entry, computed) {
  const links = resolveLinks(entry, byId);
  const state = eligibility(entry, active(), computed);

  const chips = [];
  if (entry.cost?.banes) {
    chips.push(`<span class="chip dark cb-static">${entry.cost.banes} bane${entry.cost.banes > 1 ? "s" : ""}</span>`);
  }
  if (entry.economy && entry.economy !== "action") {
    chips.push(`<span class="chip cb-static">${esc(entry.economy)}</span>`);
  }
  for (const r of entry.requires || []) {
    chips.push(`<span class="chip cb-static dim" title="The app cannot verify this — it does not track afflictions, hands, or ammunition.">requires: ${esc(r.label)}</span>`);
  }
  for (const d of entry.derive || []) {
    const value = resolveDerive(d.expr, computed);
    if (value === null) continue;
    chips.push(`<span class="chip cb-derived">${esc(d.label)}: ${esc(value)}</span>`);
  }
  for (const [field, label] of LINK_LABELS) {
    for (const target of links[field]) {
      chips.push(`<button class="chip cat" data-goto="${esc(target.id)}">${label} ${esc(target.name)}</button>`);
    }
  }

  const rows = entry.rows ? `
    <table class="cb-rows">
      <tbody>${entry.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.effect)}</td></tr>`).join("")}</tbody>
    </table>` : "";

  const defender = Array.isArray(entry.defender)
    ? `the higher of ${entry.defender.map(esc).join(" or ")}`
    : esc(entry.defender || "");
  const roll = entry.attacker
    ? `<p class="small dim cb-roll">${esc(entry.attacker)} attack roll vs ${defender}</p>` : "";
  const sizeRule = entry.size_rule ? `<p class="small dim">Size: ${esc(entry.size_rule)}</p>` : "";

  return `
  <div class="talent cb-card ${state === "unavailable" ? "cb-dim" : ""}" style="margin-bottom:14px">
    <b>${esc(entry.name)}</b>
    <span class="src">${BOOKS[entry.source.book]} · p.${entry.source.page}</span>
    ${roll}
    <p>${esc(entry.text)}</p>
    ${sizeRule}
    ${rows}
    ${chips.length ? `<div class="chip-row" style="margin-top:6px">${chips.join("")}</div>` : ""}
  </div>`;
}
