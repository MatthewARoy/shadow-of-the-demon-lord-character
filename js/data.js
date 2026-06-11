// Loads and indexes the ruleset JSON produced by scripts/.

export const rules = {
  curated: null,
  spells: [],
  paths: [],
  traditions: [],
  equipment: { weapons: [], armor: [], gear: [] },
  // indexes
  spellByKey: new Map(),     // "name|tradition" lowercased
  spellsByTradition: new Map(),
  pathByName: new Map(),
  traditionByName: new Map(),
  ancestryByName: new Map(),
  novicePathByName: new Map(),
};

export async function loadRules() {
  const [curated, spells, paths, traditions, equipment] = await Promise.all(
    ["curated", "spells", "paths", "traditions", "equipment"].map((f) =>
      fetch(`data/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`failed to load data/${f}.json`);
        return r.json();
      })
    )
  );
  rules.curated = curated;
  rules.spells = spells;
  rules.paths = paths;
  rules.traditions = traditions;
  rules.equipment = equipment;

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
  return rules;
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
