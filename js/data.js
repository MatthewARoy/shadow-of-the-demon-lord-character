// Loads and indexes the ruleset JSON produced by scripts/.

export const rules = {
  curated: null,
  spells: [],
  spellTags: { facets: [], tags: [] },  // theorycrafting taxonomy (data/spell-tags.json)
  enrichment: {},                       // spellKey -> LLM labels (data/spell-enrichment.json)
  combos: null,                         // detected spell synergies (data/spell-combos.json)
  scores: {},                           // spellKey -> effectiveness scores (data/spell-scores.json)
  paths: [],
  traditions: [],
  equipment: { weapons: [], armor: [], gear: [] },
  creatures: [],
  // indexes
  spellByKey: new Map(),     // "name|tradition" lowercased
  spellsByTradition: new Map(),
  pathByName: new Map(),
  traditionByName: new Map(),
  ancestryByName: new Map(),
  novicePathByName: new Map(),
  creaturesByBookPage: new Map(),  // "book|page" -> [creature]
  summonsBySpell: new Map(),       // spellKey -> [creature]
};

export async function loadRules() {
  const [curated, spells, paths, traditions, equipment, creatures] = await Promise.all(
    ["curated", "spells", "paths", "traditions", "equipment", "creatures"].map((f) =>
      fetch(`data/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`failed to load data/${f}.json`);
        return r.json();
      })
    )
  );
  rules.curated = curated;
  rules.spells = spells;
  // The spell-tags taxonomy is optional: if the tagger has not been run the
  // browser simply shows no category chips rather than failing to load.
  rules.spellTags = await fetch("data/spell-tags.json")
    .then((r) => (r.ok ? r.json() : { facets: [], tags: [] }))
    .catch(() => ({ facets: [], tags: [] }));
  // Optional LLM enrichment (role/archetype/tempo/synergy). Absent or partial
  // is fine — the browser only decorates the spells it has labels for.
  rules.enrichment = await fetch("data/spell-enrichment.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  // Optional combo detector output (scripts/detect_combos.py). Absent -> the
  // Archive simply shows no Combos panel.
  rules.combos = await fetch("data/spell-combos.json")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  // Optional per-spell effectiveness scores (scripts/score_spells.py). Absent ->
  // cards simply show no efficiency badge.
  rules.scores = await fetch("data/spell-scores.json")
    .then((r) => (r.ok ? r.json() : { spells: {} }))
    .catch(() => ({ spells: {} }));
  rules.paths = paths;
  rules.traditions = traditions;
  rules.equipment = equipment;
  rules.creatures = creatures;

  // Apply hand-curated overrides to parsed paths (OCR fixes).
  for (const [name, override] of Object.entries(curated.path_overrides || {})) {
    const p = paths.find((x) => x.name === name);
    if (p && override.levels) {
      for (const [lvl, entry] of Object.entries(override.levels)) {
        p.levels[lvl] = { ...p.levels[lvl], ...entry };
      }
    }
  }

  for (const s of spells) {
    rules.spellByKey.set(spellKey(s.name, s.tradition), s);
    if (!s.path_spell) {
      if (!rules.spellsByTradition.has(s.tradition)) rules.spellsByTradition.set(s.tradition, []);
      rules.spellsByTradition.get(s.tradition).push(s);
    }
  }
  for (const p of paths) rules.pathByName.set(p.name, p);
  for (const t of traditions) rules.traditionByName.set(t.name, t);
  for (const a of curated.ancestries) rules.ancestryByName.set(a.name, a);
  for (const n of curated.novice_paths) rules.novicePathByName.set(n.name, n);
  for (const cr of creatures) {
    const k = `${cr.book}|${cr.page}`;
    if (!rules.creaturesByBookPage.has(k)) rules.creaturesByBookPage.set(k, []);
    rules.creaturesByBookPage.get(k).push(cr);
  }
  for (const s of spells) {
    const found = resolveSummons(s);
    if (found.length) rules.summonsBySpell.set(spellKey(s.name, s.tradition), found);
  }
  return rules;
}

// Spells cite creatures by printed page: "(Shadow, page 246)" → core book,
// bare "page 136" → the spell's own book. Stat blocks sometimes start a page
// after the cited one, so search ±1 page and prefer creatures whose name is
// actually mentioned in the description; with no name hit, only the exact
// page counts (it may be a rules reference, not a creature).
// Core conjurations carry no page refs at all ("One compelled small monster
// appears"), so "compelled <creature>" mentions also resolve.
function resolveSummons(spell) {
  const desc = spell.description || "";
  const lower = desc.toLowerCase();
  const out = [];
  for (const m of desc.matchAll(/(Shadow, page|see page|page)\s+(\d+)/g)) {
    const book = m[1] === "Shadow, page" ? "core" : spell.source === "core" ? "core" : "occult";
    const page = parseInt(m[2], 10);
    const near = [page - 1, page, page + 1]
      .flatMap((p) => rules.creaturesByBookPage.get(`${book}|${p}`) || []);
    const partOf = (cr) =>
      cr.name.toLowerCase().split(" ").some((w) => w.length > 3 && lower.includes(w));
    let hits = near.filter((cr) => lower.includes(cr.name.toLowerCase()));
    // No full-name mention: try name fragments ("demon" → Huge/Large/Medium
    // Demon) across the window, then fall back to everything on the exact
    // page. Citations can be a page off from where the block's header lands.
    if (!hits.length) hits = near.filter(partOf);
    if (!hits.length) hits = rules.creaturesByBookPage.get(`${book}|${page}`) || [];
    for (const cr of hits) {
      if (!out.includes(cr)) out.push(cr);
    }
  }
  for (const cr of rules.creatures) {
    if (out.some((c) => c.name === cr.name)) continue;
    const n = cr.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "one compelled small monster", "becomes a Size 2 wind genie"
    if (new RegExp(`(compelled (?:[a-z]+ )?|becomes? an? (?:size \\d+ )?)${n}s?\\b`).test(lower)) out.push(cr);
  }
  return out;
}

export function spellKey(name, tradition) {
  return `${name}|${tradition}`.toLowerCase();
}

export function findSpell(name, tradition) {
  if (tradition) return rules.spellByKey.get(spellKey(name, tradition));
  const lower = name.toLowerCase();
  return rules.spells.find((s) => s.name.toLowerCase() === lower);
}

export function castingsFor(power, rank) {
  const table = rules.curated.castings;
  const row = table[Math.max(0, Math.min(power, table.length - 1))];
  return row[rank] ?? 0;
}

export function expertPaths() {
  return rules.paths.filter((p) => p.type === "expert");
}
export function masterPaths() {
  return rules.paths.filter((p) => p.type === "master");
}
