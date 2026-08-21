// Lookup tab: instant rules search over the pre-chunked rulebook index,
// plus structured equipment results. Pure client-side lexical scoring —
// works offline at the table.
//
// Equipment comes from data/equipment.json rather than the rules index. The
// index no longer carries equipment table rows at all: the chunker turned
// each row into a run-on section, which is why searching "sling" used to
// return "1d3 Off Range (medium), uses stones 5 cp C Shields...".

import { rules as ruleData, BOOKS } from "../data.js";
import { equipmentCard, equipmentKey } from "./equipment-card.js";
import { esc } from "./util.js";

// Separate quotas rather than one merged ranking. The prose scorer and a
// gear scorer cannot be compared directly — a corrupt "Sling" chunk and a
// "Sling" gear record both scored 26 from title bonuses alone, so the winner
// would have come down to an arbitrary projection detail. Splitting the
// buckets dissolves the tie instead of tuning around it, and reads better.
const GEAR_QUOTA = 5;
const RULES_QUOTA = 15;



const QUICK = [
  "afflictions", "boons and banes", "challenge roll", "attack roll", "charge",
  "hide", "triggered actions", "fate roll", "rest", "healing rate",
  "insanity", "corruption", "concentrate", "carrying limits", "incantation",
];

let index = null;       // [{t, b, p, x}]
let loading = null;
let indexError = null;
let query = "";

export function renderLookup(el) {
  el.innerHTML = `
  <div class="panel">
    <h2 class="rubric">Rules Lookup <span class="count" id="lk-count">${index ? `${index.length} sections indexed` : "loading the law…"}</span></h2>
    <div class="filter-bar">
      <input type="text" id="lk-q" placeholder="frightened, charge, fate roll, carrying limits…" value="${esc(query)}" autocomplete="off">
    </div>
    <div class="chip-row" id="lk-chips" style="margin-bottom:14px">
      ${QUICK.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}
    </div>
    <div id="lk-results"></div>
    <p class="small dim" style="margin-top:14px">Indexed: character &amp; gameplay rules, equipment, and magic-system chapters. Spells and paths live in their own tabs.</p>
  </div>`;

  const input = el.querySelector("#lk-q");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = input.value; runSearch(el); }, 120);
  });
  el.querySelector("#lk-chips").addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]")?.dataset.q;
    if (!q) return;
    query = q;
    input.value = q;
    runSearch(el);
  });
  const results = el.querySelector("#lk-results");
  const toggleBody = (body) => {
    const clamped = body.classList.toggle("lk-clamp");
    // Only long bodies are exposed as role="button"; short paragraphs stay
    // plain <p>, so don't stamp aria-expanded on a non-interactive element.
    if (body.hasAttribute("role")) body.setAttribute("aria-expanded", clamped ? "false" : "true");
  };
  results.addEventListener("click", (e) => {
    const body = e.target.closest(".lk-body");
    if (body) toggleBody(body);
  });
  // Keyboard reach for the clamp toggles: Enter/Space fire the same toggle,
  // Space also preventing the page from scrolling.
  results.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const body = e.target.closest(".lk-body[role='button']");
    if (!body) return;
    e.preventDefault();
    toggleBody(body);
  });

  ensureIndex().then(() => {
    const count = el.querySelector("#lk-count");
    if (count) count.textContent = `${index.length} sections indexed`;
    if (query) runSearch(el);
  });
  if (query) runSearch(el);
  input.focus();
}

function ensureIndex() {
  if (index) return Promise.resolve(index);
  if (!loading) {
    loading = fetch("data/rules-index.json")
      .then((r) => {
        if (!r.ok) throw new Error(`rules-index.json: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        index = data.map((c) => ({ ...c, tl: c.t.toLowerCase(), xl: c.x.toLowerCase() }));
        indexError = null;
        return index;
      })
      .catch((err) => {
        // Without this the tab sat on "loading the law…" forever.
        loading = null;              // allow a retry
        indexError = err;
        throw err;
      });
  }
  return loading;
}

// Function words would dominate scoring and highlight inside other words
// ("and" in "hands") — drop them unless the whole query is made of them.
const STOPWORDS = new Set(["and", "or", "the", "of", "to", "an", "in", "on", "at", "with", "for", "you", "your", "is", "are"]);

function tokenize(s) {
  const words = s.toLowerCase().split(/[^a-z0-9’']+/).filter((w) => w.length > 1);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  return meaningful.length ? meaningful : words;
}

function score(chunk, terms, phrase) {
  let s = 0;
  let present = 0;
  for (const t of terms) {
    let body = 0;
    let i = -1;
    while ((i = chunk.xl.indexOf(t, i + 1)) !== -1 && body < 5) body++;
    const title = chunk.tl.includes(t) ? 4 : 0;
    if (body || title) present++;
    s += Math.min(body, 5) + title;
  }
  if (present === terms.length && terms.length > 1) s += 6;
  if (phrase && (chunk.xl.includes(phrase) || chunk.tl.includes(phrase))) s += 10;
  if (chunk.tl === phrase) s += 12;
  return present ? s : 0;
}

// Gear records are a dozen words; prose chunks are up to 1,600 characters.
// Term-frequency scoring would let prose win every time, so gear is scored
// on where the term appears rather than how often.
export function scoreGear(item, terms, phrase) {
  const name = item.name.toLowerCase();
  const blob = [item.category, item.type, item.properties, item.requirement]
    .filter(Boolean).join(" ").toLowerCase();
  let s = 0;
  let present = 0;
  for (const t of terms) {
    const inName = name.includes(t);
    const inBlob = blob.includes(t);
    if (inName || inBlob) present++;
    s += (inName ? 6 : 0) + (inBlob ? 2 : 0);
  }
  // Every term must land, or "knock down" would surface unrelated weapons.
  if (present !== terms.length) return 0;
  if (name === phrase) s += 20;
  else if (name.startsWith(phrase)) s += 8;
  return s;
}

export function searchAll(index, gear, query) {
  const q = (query || "").trim();
  if (!q) return { rules: [], gear: [] };
  const terms = tokenize(q);
  const phrase = q.toLowerCase();
  if (!terms.length) return { rules: [], gear: [] };

  const ruleHits = index
    .map((c) => ({ c, s: score(withLower(c), terms, phrase) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, RULES_QUOTA)
    .map((h) => h.c);

  const seen = new Set();
  const gearHits = gear
    .map((item) => ({ item, s: scoreGear(item, terms, phrase) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .filter((h) => {
      // name+category, so both "Bastard sword or warhammer" variants survive
      const k = equipmentKey(h.item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, GEAR_QUOTA)
    .map((h) => h.item);

  return { rules: ruleHits, gear: gearHits };
}

function withLower(c) {
  return c.tl ? c : { ...c, tl: c.t.toLowerCase(), xl: c.x.toLowerCase() };
}

function allGear() {
  const e = (ruleData && ruleData.equipment) || {};
  return [...(e.weapons || []), ...(e.armor || []), ...(e.gear || [])];
}

function runSearch(el) {
  const box = el.querySelector("#lk-results");
  if (!box) return;
  const q = query.trim();
  if (!q) { box.innerHTML = `<p class="empty">Ask, and the law shall answer.</p>`; return; }
  if (indexError) {
    box.innerHTML = `<p class="empty">The archives are unreachable — ${esc(indexError.message)}.
      <button class="btn btn-small" id="lk-retry">Try again</button></p>`;
    el.querySelector("#lk-retry")?.addEventListener("click", () => {
      indexError = null;
      ensureIndex().then(() => runSearch(el)).catch(() => runSearch(el));
    });
    return;
  }
  if (!index) { box.innerHTML = `<p class="empty">Loading the index…</p>`; return; }

  const terms = tokenize(q);
  const { rules: ruleHits, gear: gearHits } = searchAll(index, allGear(), q);
  if (!ruleHits.length && !gearHits.length) {
    box.innerHTML = `<p class="empty">Nothing in the law speaks of “${esc(q)}”.</p>`;
    return;
  }

  const gearSection = gearHits.length ? `
    <h3 class="rubric small">Equipment</h3>
    ${gearHits.map((item) => equipmentCard(item)).join("")}` : "";

  const rulesSection = ruleHits.length ? `
    ${gearHits.length ? `<h3 class="rubric small" style="margin-top:18px">Rules</h3>` : ""}
    ${ruleHits.map((c) => {
      const win = snippetWindow(c, terms);
      // Only long bodies clamp, and only those are interactive: expose them as
      // keyboard-reachable toggle buttons (collapsed = aria-expanded false).
      const clamped = c.x.length > 460;
      const toggle = clamped ? ` tabindex="0" role="button" aria-expanded="false"` : "";
      // Equipment records have no book or page; guard the citation.
      const cite = c.b && c.p ? `<span class="src">${BOOKS[c.b]} · p.${c.p}</span>` : "";
      return `
      <div class="talent" style="margin-bottom:14px">
        <b>${highlight(esc(c.t), terms)}</b>
        ${cite}
        <p class="lk-body ${clamped ? "lk-clamp" : ""}"${toggle}>${highlight(esc(win), terms)}</p>
      </div>`;
    }).join("")}` : "";

  box.innerHTML = gearSection + rulesSection;
}

// Show the area around the first match for long chunks.
function snippetWindow(c, terms) {
  if (c.x.length <= 460) return c.x;
  let first = -1;
  for (const t of terms) {
    const i = c.xl.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first <= 200) return c.x;
  const start = Math.max(0, first - 160);
  return "… " + c.x.slice(start);
}

function highlight(escaped, terms) {
  let out = escaped;
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}
