// Lookup tab: instant rules search over the pre-chunked rulebook index.
// Pure client-side lexical scoring — works offline at the table.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const BOOKS = { core: "Core Rulebook", occult: "Occult Philosophy", terrible: "Terrible Beauty" };

const QUICK = [
  "afflictions", "boons and banes", "challenge roll", "attack roll", "charge",
  "hide", "triggered actions", "fate roll", "rest", "healing rate",
  "insanity", "corruption", "concentrate", "carrying limits", "incantation",
];

let index = null;       // [{t, b, p, x}]
let loading = null;
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
  el.querySelector("#lk-results").addEventListener("click", (e) => {
    const body = e.target.closest(".lk-body");
    if (body) body.classList.toggle("lk-clamp");
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
      .then((r) => r.json())
      .then((data) => {
        index = data.map((c) => ({ ...c, tl: c.t.toLowerCase(), xl: c.x.toLowerCase() }));
        return index;
      });
  }
  return loading;
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9’']+/).filter((w) => w.length > 1);
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

function runSearch(el) {
  const box = el.querySelector("#lk-results");
  if (!box) return;
  const q = query.trim();
  if (!q) { box.innerHTML = `<p class="empty">Ask, and the law shall answer.</p>`; return; }
  if (!index) { box.innerHTML = `<p class="empty">Loading the index…</p>`; return; }
  const terms = tokenize(q);
  const phrase = q.toLowerCase().trim();
  const hits = index
    .map((c) => ({ c, s: score(c, terms, phrase) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20);
  if (!hits.length) {
    box.innerHTML = `<p class="empty">Nothing in the law speaks of “${esc(q)}”.</p>`;
    return;
  }
  box.innerHTML = hits.map(({ c }) => {
    const win = snippetWindow(c, terms);
    return `
    <div class="talent" style="margin-bottom:14px">
      <b>${highlight(esc(c.t), terms)}</b>
      <span class="src">${BOOKS[c.b]} · p.${c.p}</span>
      <p class="lk-body ${c.x.length > 460 ? "lk-clamp" : ""}" data-full="${esc(c.x)}">${highlight(esc(win), terms)}</p>
    </div>`;
  }).join("");
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
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}
