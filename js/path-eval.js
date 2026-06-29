// Path evaluation — scoring expert & master paths, with a spellcaster lens.
//
// "Which path is best for a caster?" has a real, grounded answer in the SotDL
// rules, and this module computes it transparently from the parsed path data
// (no LLM, no rulebook text needed). Every number a path grants is in the data;
// the only judgement call is classifying talents, which we do by keyword.
//
// ── What actually matters for a spellcaster ──────────────────────────────
//
//  • POWER is the keystone. It caps the rank of spell you can learn AND sets
//    how many castings you get (the non-linear castings table). Across all 165
//    paths only 37 grant +2 and 42 grant none, so it's the sharpest
//    differentiator. Weighted highest by far.
//  • MAGIC ACCESS — each level's "discover a tradition or learn a spell" pick
//    is a direct addition to your repertoire; a tradition opens a whole list,
//    a spell is one guaranteed pick. 44 paths grant no magic at all (the
//    martial paths) and score zero here.
//  • TALENTS are the repeatable, turn-by-turn payload. Two kinds help a caster:
//      – spell-economy: "expend the casting of a … spell" / extra castings —
//        converts your castings into extra effects or gives you more of them.
//      – spell-empowerment: "when you cast a spell … deals 1d6 extra damage" /
//        a boon to spell attacks / raising a spell's effect.
//    A path's martial talents (weapon attacks, charge, berserk) don't *reduce*
//    its casting — a gish still casts fine — so they don't subtract; we just
//    flag them so you can tell a pure caster from a hybrid.
//  • ATTRIBUTES — every attribute increase is a flexible +1 that a caster sinks
//    into their casting attribute (Intellect or Will), so attribute picks are
//    uniformly good. Expert paths give 2, master paths give 3, so this barely
//    separates paths *within* a tier — hence a modest weight.
//  • HEALTH / DEFENSE keep you alive to keep casting. Defense is almost never
//    granted by a path (3 of 165), so when it appears it's worth flagging.
//
// ── Fair comparison ──────────────────────────────────────────────────────
// A master path has two benefit tiers, an expert path three, and they grant
// different amounts — so comparing a master against an expert is apples to
// oranges. Like the spell scorer (percentile within a rank cohort), we rank
// each path's caster score as a PERCENTILE within its own type cohort
// (expert-vs-expert, master-vs-master). The headline "Caster Rating" is that
// percentile; a path in the top of its kind reads ~90+.

const CHAR_KEYS = ["power", "health", "defense", "perception", "speed", "size", "insanity", "corruption"];

// Talent classifiers. Each is a deliberately conservative regex over the
// talent text; a talent may match several (e.g. a spell that grants Defense).
const TALENT_PATTERNS = {
  // Spends or grants spell castings — the caster's core resource.
  casting: /expend (?:the|a|one|an additional) casting|(?:gain|regain)[^.]{0,40}casting|additional casting|casting of (?:a|the|one|that)\b/i,
  // Boosts what a spell does when cast.
  empower: /when you cast[^.]{0,80}(?:extra|deals?|bonus|boon|1d6)|spell deals?[^.]{0,30}extra|extra\s*\d*d?6?\s*(?:extra )?damage[^.]{0,30}spell|cast[^.]{0,40}with 1 boon|increase[^.]{0,30}(?:rank|the spell)/i,
  // Direct defensive payoff — survive to keep casting.
  defensive: /bonus to (?:your )?Defense|gain[^.]{0,12}\bDefense\b|attack rolls against you with 1 bane|challenge rolls? with 1 boon to resist/i,
  // Martial / weapon focus — marks a hybrid rather than a pure caster.
  martial: /\bmelee weapon\b|attack with a (?:melee|ranged)? ?weapon|\bcharge\b|\bberserk\b|reckless/i,
};

function classifyTalent(text) {
  const facets = [];
  for (const [facet, re] of Object.entries(TALENT_PATTERNS)) {
    if (re.test(text)) facets.push(facet);
  }
  return facets;
}

// Pull the raw, additive benefits out of one path.
function aggregate(path, traditionNames) {
  const a = {
    power: 0, health: 0, defense: 0, perception: 0, speed: 0, size: 0,
    attrPicks: 0,        // flexible +1 attribute increases, summed
    magicPicks: 0,       // number of "discover/learn" choices granted
    traditionOptions: 0, // picks that can discover a tradition (breadth)
    spellOptions: 0,     // picks that can learn a spell
    talents: 0,
    casting: 0, empower: 0, defensive: 0, martial: 0,
    focus: new Set(),    // tradition names this path empowers
  };
  for (const e of Object.values(path.levels)) {
    for (const k of CHAR_KEYS) a[k] = (a[k] || 0) + (e.characteristics?.[k] || 0);
    if (e.attributes) a.attrPicks += e.attributes.each ? 4 : (e.attributes.choose || 0);
    const m = e.magic;
    if (m) {
      for (const ch of m.choices || []) {
        a.magicPicks += 1;
        const opts = ch.options || [];
        if (opts.includes("discover_tradition")) a.traditionOptions += 1;
        if (opts.includes("learn_spell")) a.spellOptions += 1;
        for (const tn of ch.traditions || []) a.focus.add(tn);
      }
      // Tradition focus is also named in prose ("discover the Fire tradition");
      // match against the known tradition list to stay clean.
      const raw = m.raw || "";
      for (const tn of traditionNames) {
        if (new RegExp(`\\b${tn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(raw)) a.focus.add(tn);
      }
    }
    for (const t of e.talents || []) {
      a.talents += 1;
      for (const f of classifyTalent(t.text || "")) a[f] += 1;
    }
  }
  return a;
}

// The caster score. Weights are documented at the top of the file; they reflect
// how much each benefit moves a spellcaster's effectiveness in play.
function casterScore(a) {
  return (
    a.power * 14 +              // gates spell rank AND castings — the rarest, biggest lever
    a.magicPicks * 4 +          // each guaranteed repertoire addition
    a.traditionOptions * 1.5 +  // a tradition opens a whole list — breadth premium
    a.casting * 6 +             // spell-economy talents: repeatable casting value
    a.empower * 5 +             // spell-empowerment talents
    a.attrPicks * 2 +           // flexible +1s into the casting attribute
    a.defensive * 2.5 +         // survive to keep casting
    a.health * 0.4 +
    a.defense * 3               // rare direct survivability
  );
}

// Raw "attributes & survivability" value, independent of the caster lens —
// answers "best attributes/stats" for any build.
function statScore(a) {
  return a.attrPicks * 3 + a.power * 4 + a.health * 0.5 + a.defense * 3 +
    a.perception * 1.5 + a.speed * 0.5;
}

function percentileRanks(items, valueOf) {
  // Fraction of the cohort scoring strictly lower — matches the spell scorer.
  const vals = items.map(valueOf);
  return items.map((_, i) => {
    const v = vals[i];
    const lower = vals.filter((x) => x < v).length;
    return items.length > 1 ? lower / (items.length - 1) : 1;
  });
}

const TIERS = [
  [0.85, "S"], [0.65, "A"], [0.4, "B"], [0.15, "C"], [0, "D"],
];
function tierOf(pct) {
  for (const [floor, label] of TIERS) if (pct >= floor) return label;
  return "D";
}

// Analyze every path once. Returns Map(path.name -> analysis), where each
// analysis carries the raw aggregate, the caster/stat scores, their
// within-cohort percentiles, a quick tier letter, and resolved focus
// traditions (with governing attribute + dark flag) for display.
export function analyzeAllPaths(paths, traditions) {
  const traditionNames = traditions.map((t) => t.name)
    // longest first so "Demonology" matches before "Demon"-like fragments
    .sort((a, b) => b.length - a.length);
  const byName = new Map(traditions.map((t) => [t.name, t]));

  const analyses = paths.map((p) => {
    const agg = aggregate(p, traditionNames);
    return {
      name: p.name,
      type: p.type,
      agg,
      casterRaw: casterScore(agg),
      statRaw: statScore(agg),
      casterTalents: agg.casting + agg.empower,
      martialTalents: agg.martial,
      focus: [...agg.focus].map((n) => {
        const t = byName.get(n);
        return { name: n, attribute: t?.attribute || null, dark: !!t?.dark };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  // Percentiles within each type cohort.
  for (const type of ["expert", "master"]) {
    const cohort = analyses.filter((x) => x.type === type);
    const cp = percentileRanks(cohort, (x) => x.casterRaw);
    const sp = percentileRanks(cohort, (x) => x.statRaw);
    cohort.forEach((x, i) => {
      x.casterPct = cp[i];
      x.statPct = sp[i];
      x.tier = tierOf(cp[i]);
    });
  }

  return new Map(analyses.map((x) => [x.name, x]));
}
