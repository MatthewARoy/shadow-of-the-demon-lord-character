// The V2 effects/decisions engine.
//
// A character is a sequence of resolved decisions. compute() replays the
// ancestry and every attained level's effects in order, materializing
// decision slots; resolutions stored on the character fill the slots.
// Anything unresolved comes back as a pending decision for the UI.

import { rules, findSpell, castingsFor } from "./data.js";

export const ATTRS = ["strength", "agility", "intellect", "will"];

export function newCharacter(name = "Unnamed Soul") {
  return {
    version: 2,
    id: crypto.randomUUID(),
    name,
    ancestry: "Human",
    level: 0,
    novicePath: null,
    expertPath: null,
    masterMode: "master",        // "master" | "second-expert"
    masterPath: null,
    secondExpertPath: null,
    religion: null,
    attributeSwap: null,          // {from, to} once, at creation
    sizeChoice: null,
    decisions: {},                // slotId -> resolution
    exchanges: [],                // [{drop:{name,tradition}, gain:{name,tradition}}]
    damage: 0,
    insanityAdjust: 0,            // gameplay marks beyond computed effects
    corruptionAdjust: 0,
    expended: {},                 // spell key -> castings used
    inventory: [],                // {id, name, qty, equipped, weapon?, armor?, notes}
    coins: "",
    notes: "",
    log: [],
  };
}

// ---------------------------------------------------------------------------
// Slot materialization
// ---------------------------------------------------------------------------

function slotIdFor(sourceKey, level, effIdx, pick = 0, sub = "") {
  return `${sourceKey}:${level}:${effIdx}:${pick}${sub ? ":" + sub : ""}`;
}

// Convert a parsed expert/master path level entry into the curated effect
// vocabulary so the engine only deals with one shape.
function effectsFromParsedLevel(entry) {
  const effects = [];
  if (entry.attributes && entry.attributes.choose) {
    effects.push({ type: "attribute_choice", count: entry.attributes.choose, amount: entry.attributes.increase || 1, each: !!entry.attributes.each });
  }
  if (entry.characteristics && !entry.characteristics.raw) {
    effects.push({ type: "characteristics", ...entry.characteristics });
  }
  if (entry.languages_professions) {
    effects.push({ type: "lang_prof", text: entry.languages_professions, count: 1 });
  }
  if (entry.magic) {
    for (const grant of entry.magic.grants || []) {
      effects.push({ type: "grant_spell", spell: grant });
    }
    for (const slot of entry.magic.choices || []) {
      const opts = slot.options.map((o) => (o === "discover_tradition" ? "discover" : "learn"));
      const constraint = { traditions: slot.traditions || null, excludeDark: !!slot.exclude_dark };
      if (opts.length === 1 && opts[0] === "learn") {
        effects.push({ type: "learn_spell", count: slot.pick, ...constraint });
      } else if (opts.length === 1 && opts[0] === "discover") {
        effects.push({ type: "discover_tradition", count: slot.pick, ...constraint });
      } else {
        effects.push({ type: "magic_picks", count: slot.pick, options: opts, ...constraint });
      }
    }
    if (!entry.magic.choices && !entry.magic.grants) {
      effects.push({ type: "note", text: "Magic: " + entry.magic.raw });
    }
  }
  for (const t of entry.talents || []) {
    effects.push({ type: "talent", name: t.name, text: t.text });
  }
  return effects;
}

// The advancement plan: which source grants effects at each level.
function levelPlan(char) {
  const plan = [];
  const novice = char.novicePath && rules.novicePathByName.get(char.novicePath);
  const expert = char.expertPath && rules.pathByName.get(char.expertPath);
  const second = char.secondExpertPath && rules.pathByName.get(char.secondExpertPath);
  const master = char.masterPath && rules.pathByName.get(char.masterPath);
  const ancestry = rules.ancestryByName.get(char.ancestry);
  const useSecond = char.masterMode === "second-expert";

  // Slot ids embed the path name so switching paths (or levels) orphans old
  // resolutions instead of corrupting or destroying them; switching back
  // restores them intact.
  const pathLevel = (p, lvl, kind) =>
    p ? { key: `${kind}[${p.name}]`, label: `${p.name} (Level ${lvl})`, effects: effectsFromParsedLevel(p.levels[lvl] || {}) } : null;

  for (let lvl = 1; lvl <= char.level; lvl++) {
    let src = null;
    switch (lvl) {
      case 1: case 2: case 5: case 8: {
        if (novice) src = { key: `novice[${novice.name}]`, label: `${novice.name} (Level ${lvl})`, effects: (novice.levels[lvl] || { effects: [] }).effects };
        else src = { key: "novice", label: "Novice path not chosen", effects: [], missing: "novice" };
        break;
      }
      case 3: case 6: case 9: {
        if (lvl === 9 && useSecond && second && expert) {
          // Level 9: choose which expert path's level 9 benefits you gain.
          src = {
            key: `expert9choice[${expert.name}|${second.name}]`, label: "Second Expert Path (Level 9)",
            effects: [{
              type: "option_choice", name: "Level 9 Benefits From Which Path?",
              options: [expert, second].map((p) => ({
                label: p.name,
                effects: effectsFromParsedLevel(p.levels["9"] || {}),
              })),
            }],
          };
        } else if (expert) {
          src = pathLevel(expert, lvl, "expert");
        } else {
          src = { key: "expert", label: "Expert path not chosen", effects: [], missing: "expert" };
        }
        break;
      }
      case 4: {
        if (ancestry) {
          const effects = [];
          const l4 = ancestry.level4 || {};
          if (l4.characteristics && Object.keys(l4.characteristics).length) {
            effects.push({ type: "characteristics", ...l4.characteristics });
          }
          if (l4.choice) effects.push({ type: "option_choice", ...l4.choice });
          src = { key: `ancestry4[${ancestry.name}]`, label: `${ancestry.name} (Level 4)`, effects };
        }
        break;
      }
      case 7: {
        if (useSecond) {
          if (second) src = { key: `second[${second.name}]`, label: `${second.name} (2nd Expert, Level 3 benefits)`, effects: effectsFromParsedLevel(second.levels["3"] || {}) };
          else src = { key: "second", label: "Second expert path not chosen", effects: [], missing: "second" };
        } else if (master) {
          src = pathLevel(master, 7, "master");
        } else {
          src = { key: "master", label: "Master path not chosen", effects: [], missing: "master" };
        }
        break;
      }
      case 10: {
        if (useSecond) {
          if (second) src = { key: `second[${second.name}]`, label: `${second.name} (2nd Expert, Level 6 benefits)`, effects: effectsFromParsedLevel(second.levels["6"] || {}) };
        } else if (master) {
          src = pathLevel(master, 10, "master");
        } else {
          src = { key: "master", label: "Master path not chosen", effects: [], missing: "master" };
        }
        break;
      }
    }
    plan.push({ level: lvl, source: src });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// compute(): replay everything
// ---------------------------------------------------------------------------

export function compute(char) {
  const ancestry = rules.ancestryByName.get(char.ancestry) || rules.curated.ancestries[0];
  const c = ancestry.creation;

  const out = {
    ancestry,
    attributes: { ...c.attributes },
    perceptionBonus: c.perception_bonus || 0,
    defenseFixed: c.defense,
    health: 0,
    healthSources: [],
    power: 0,
    speed: c.speed,
    size: char.sizeChoice || c.size,
    insanity: typeof c.insanity === "object" ? 0 : c.insanity,
    insanityNote: typeof c.insanity === "object" ? `+${c.insanity.roll} at creation` : null,
    corruption: c.corruption || 0,
    defenseBonus: 0,
    speedBonus: 0,
    provenance: { health: [], power: [], defense: [], speed: [], perception: [], corruption: [], insanity: [] },
    traits: (c.traits || []).map((t) => ({ ...t, source: ancestry.name })),
    talents: [],
    languagesProfessions: [{ text: c.languages_professions, source: ancestry.name }],
    discovered: [],            // [{tradition, source, level}]
    spells: [],                // [{spell, source, level}]
    pending: [],               // pending decision descriptors
    decisionsUsed: new Set(),
    notes: [],
    halfPathHealth: (c.flags || []).includes("half_path_health"),
    plan: null,
  };

  // --- creation: attribute choices & swap
  if (c.attribute_choice) {
    const slotId = `creation[${ancestry.name}]:0:attr:0`;
    const res = char.decisions[slotId];
    materializeAttributeChoice(out, char, slotId, c.attribute_choice.count, c.attribute_choice.amount, `${ancestry.name} creation`, res);
  }
  if (char.attributeSwap && !c.no_attribute_swap) {
    const { from, to } = char.attributeSwap;
    if (ATTRS.includes(from) && ATTRS.includes(to) && from !== to) {
      out.attributes[from] -= 1;
      out.attributes[to] += 1;
    }
  }

  addHealthSource(out, `${ancestry.name}`, null, c.health_bonus || 0);

  // --- hooks gained at any level (cantrip), discovered before replay
  const plan = levelPlan(char);
  out.plan = plan;
  const hooks = [];
  for (const { level, source } of plan) {
    if (!source) continue;
    for (const eff of source.effects) {
      if (eff.type === "hook_cantrip") hooks.push({ level, name: eff.name, text: eff.text });
    }
  }

  // --- replay levels in order
  for (const { level, source } of plan) {
    if (!source) continue;
    if (source.missing) {
      out.pending.push({ id: `choose-path:${source.missing}:${level}`, kind: "choose_path", level, which: source.missing, title: pathChoiceTitle(source.missing), origin: `Level ${level}` });
      continue;
    }
    applyEffects(out, char, source.effects, { sourceKey: `${source.key}`, label: source.label, level, hooks });
  }

  // --- derived stats
  out.attributes.strength = clampScore(out.attributes.strength);
  out.attributes.agility = clampScore(out.attributes.agility);
  out.attributes.intellect = clampScore(out.attributes.intellect);
  out.attributes.will = clampScore(out.attributes.will);

  out.health += out.attributes.strength;
  out.healingRate = Math.max(1, Math.floor(out.health / (c.healing_divisor || 4)));
  out.perception = out.attributes.intellect + out.perceptionBonus;
  // Maximum Defense: a creature's Defense cannot exceed 25.
  out.defense = Math.min(25, (out.defenseFixed ?? out.attributes.agility) + out.defenseBonus);
  out.speed = c.speed + out.speedBonus;

  applyExchanges(out, char);

  // Insanity and Corruption marked during play, on top of build effects.
  out.insanityBase = out.insanity;
  out.corruptionBase = out.corruption;
  const insAdj = char.insanityAdjust || 0;
  const corAdj = char.corruptionAdjust || 0;
  if (insAdj) out.provenance.insanity.push({ source: "Marked in play", level: null, amount: insAdj });
  if (corAdj) out.provenance.corruption.push({ source: "Marked in play", level: null, amount: corAdj });
  out.insanity = Math.max(0, out.insanity + insAdj);
  out.corruption = Math.max(0, out.corruption + corAdj);

  out.modifiers = Object.fromEntries(ATTRS.map((a) => [a, out.attributes[a] - 10]));

  // spells: attach data + castings
  out.spells = out.spells.map((s) => {
    const data = findSpell(s.name, s.tradition) || findSpell(s.name);
    const castings = data ? castingsFor(out.power, data.rank) : 0;
    return { ...s, data, castings };
  });

  return out;
}

function pathChoiceTitle(which) {
  return {
    novice: "Choose a Novice Path",
    expert: "Choose an Expert Path",
    master: "Choose a Master Path (or a second Expert Path)",
    second: "Choose your Second Expert Path",
  }[which] || "Choose a Path";
}

function clampScore(v) { return Math.max(1, Math.min(20, v)); }

function addHealthSource(out, label, level, amount) {
  if (!amount) return;
  out.health += amount;
  out.provenance.health.push({ source: label, level, amount });
}

// ---------------------------------------------------------------------------
// Effect application
// ---------------------------------------------------------------------------

function applyEffects(out, char, effects, ctx) {
  effects.forEach((eff, effIdx) => {
    const baseId = slotIdFor(ctx.sourceKey, ctx.level, effIdx);
    switch (eff.type) {
      case "characteristics": {
        applyCharacteristics(out, eff, ctx);
        break;
      }
      case "attribute_choice": {
        if (eff.each) {
          ATTRS.forEach((a) => { out.attributes[a] += eff.amount || 1; });
          out.notes.push({ text: `${ctx.label}: all four attributes increased by ${eff.amount || 1}.`, level: ctx.level });
        } else {
          materializeAttributeChoice(out, char, baseId, eff.count, eff.amount || 1, ctx.label, char.decisions[baseId], ctx.level);
        }
        break;
      }
      case "lang_prof": {
        const res = char.decisions[baseId];
        out.languagesProfessions.push({ text: eff.text, source: ctx.label, value: res?.text || null });
        if (!res?.text) {
          out.pending.push({ id: baseId, kind: "lang_prof", title: "Languages & Professions", desc: eff.text, suggest: eff.suggest || [], origin: ctx.label, level: ctx.level });
        }
        break;
      }
      case "talent": {
        out.talents.push({ name: eff.name, text: eff.text, source: ctx.label, level: ctx.level });
        break;
      }
      case "note": {
        out.notes.push({ text: `${ctx.label}: ${eff.text}`, level: ctx.level });
        break;
      }
      case "grant_spell": {
        grantSpell(out, eff.spell, null, ctx, "granted");
        break;
      }
      case "discover_tradition": {
        const count = eff.count || 1;
        for (let pick = 0; pick < count; pick++) {
          const id = slotIdFor(ctx.sourceKey, ctx.level, effIdx, pick);
          resolveDiscoverSlot(out, char, id, eff, ctx, /*forced*/ true);
        }
        break;
      }
      case "magic_picks": {
        for (let pick = 0; pick < eff.count; pick++) {
          const id = slotIdFor(ctx.sourceKey, ctx.level, effIdx, pick);
          const res = char.decisions[id];
          const pend = () => out.pending.push({
            id, kind: "magic_pick", title: "Discover a Tradition or Learn a Spell",
            constraint: eff.constraint || null, traditions: eff.traditions || null,
            excludeDark: !!eff.excludeDark,
            origin: ctx.label, level: ctx.level, maxRank: out.power,
          });
          if (res?.kind === "discover") {
            resolveDiscovery(out, char, id, res.tradition, eff, ctx);
          } else if (res?.kind === "learn" && res.spell) {
            if (!learnSpellFromResolution(out, char, id, res, ctx, { requireDiscovered: true })) pend();
          } else {
            pend();
          }
        }
        break;
      }
      case "learn_spell": {
        const count = eff.count || 1;
        for (let pick = 0; pick < count; pick++) {
          const id = slotIdFor(ctx.sourceKey, ctx.level, effIdx, pick);
          const res = char.decisions[id];
          const pend = () => out.pending.push({
            id, kind: "learn_spell", title: "Learn a Spell",
            traditions: eff.traditions || null, maxRank: eff.max_rank ?? out.power,
            excludeDark: !!eff.excludeDark,
            origin: ctx.label, level: ctx.level,
          });
          if (res?.spell) {
            if (!learnSpellFromResolution(out, char, id, res, ctx, { requireDiscovered: true })) pend();
          } else {
            pend();
          }
        }
        break;
      }
      case "talent_choice": {
        const res = char.decisions[baseId];
        const pool = rules.curated.roguery_talents;
        if (res?.talent) {
          const talent = pool.find((t) => t.name === res.talent);
          if (talent) {
            const prior = countPriorPicks(char, out, baseId, res.talent);
            out.talents.push({ name: `${talent.name}${prior > 0 ? " (2nd)" : ""}`, text: talent.text, source: ctx.label, level: ctx.level });
            const effectsToApply = prior > 0 ? talent.second_pick_effects || [] : talent.effects || [];
            applyEffects(out, char, effectsToApply, { ...ctx, sourceKey: `${ctx.sourceKey}-rt${effIdx}`, label: `${talent.name} (${ctx.label})` });
          }
        } else {
          out.pending.push({ id: baseId, kind: "talent_choice", title: "Choose a Roguery Talent", pool: pool.map((t) => ({ name: t.name, text: t.text })), origin: ctx.label, level: ctx.level });
        }
        break;
      }
      case "option_choice": {
        const res = char.decisions[baseId];
        if (res?.option != null && eff.options[res.option]) {
          const opt = eff.options[res.option];
          out.notes.push({ text: `${eff.name}: chose “${opt.label}”.`, level: ctx.level });
          applyEffects(out, char, opt.effects, { ...ctx, sourceKey: `${ctx.sourceKey}-opt${effIdx}` });
        } else {
          out.pending.push({ id: baseId, kind: "option_choice", title: eff.name, options: eff.options.map((o) => o.label), origin: ctx.label, level: ctx.level });
        }
        break;
      }
      case "hook_cantrip": {
        out.talents.push({ name: eff.name, text: eff.text, source: ctx.label, level: ctx.level });
        break;
      }
    }
  });
}

function applyCharacteristics(out, eff, ctx) {
  if (eff.health) {
    let amount = eff.health;
    const isPath = !ctx.sourceKey.startsWith("ancestry") && !ctx.sourceKey.startsWith("creation");
    if (out.halfPathHealth && isPath && amount > 0) amount = Math.floor(amount / 2);
    addHealthSource(out, ctx.label, ctx.level, amount);
  }
  if (eff.power) { out.power += eff.power; out.provenance.power.push({ source: ctx.label, level: ctx.level, amount: eff.power }); }
  if (eff.defense) { out.defenseBonus += eff.defense; out.provenance.defense.push({ source: ctx.label, level: ctx.level, amount: eff.defense }); }
  if (eff.speed) { out.speedBonus += eff.speed; out.provenance.speed.push({ source: ctx.label, level: ctx.level, amount: eff.speed }); }
  if (eff.perception) { out.perceptionBonus += eff.perception; out.provenance.perception.push({ source: ctx.label, level: ctx.level, amount: eff.perception }); }
  if (eff.corruption) { out.corruption += eff.corruption; out.provenance.corruption.push({ source: ctx.label, level: ctx.level, amount: eff.corruption }); }
  if (eff.insanity) { out.insanity += eff.insanity; out.provenance.insanity.push({ source: ctx.label, level: ctx.level, amount: eff.insanity }); }
}

function materializeAttributeChoice(out, char, slotId, count, amount, label, res, level = 0) {
  if (res?.attrs?.length === count && res.attrs.every((a) => ATTRS.includes(a)) && new Set(res.attrs).size === count) {
    for (const a of res.attrs) out.attributes[a] += amount;
  } else {
    out.pending.push({ id: slotId, kind: "attribute_choice", title: `Increase ${count === 1 ? "an Attribute" : count + " Attributes"} by ${amount}`, count, amount, origin: label, level });
  }
}

// A forced discovery slot (e.g. Magician/Priest level 1).
function resolveDiscoverSlot(out, char, id, eff, ctx, forced) {
  const res = char.decisions[id];
  if (res?.tradition) {
    resolveDiscovery(out, char, id, res.tradition, eff, ctx);
  } else {
    out.pending.push({
      id, kind: "discover", title: "Discover a Tradition",
      constraint: eff.constraint || null, traditions: eff.traditions || null,
      excludeDark: !!eff.excludeDark,
      origin: ctx.label, level: ctx.level,
    });
  }
}

// Discovery: record tradition, dark corruption, the free rank 0 spell pick,
// and the Cantrip hook's extra rank 0 pick.
function resolveDiscovery(out, char, id, traditionName, eff, ctx) {
  const trad = rules.traditionByName.get(traditionName);
  if (!trad || out.discovered.some((d) => d.tradition === traditionName)) {
    out.pending.push({ id, kind: "discover", title: "Discover a Tradition", constraint: eff.constraint || null, traditions: eff.traditions || null, origin: ctx.label, level: ctx.level, invalid: true });
    return;
  }
  out.discovered.push({ tradition: traditionName, source: ctx.label, level: ctx.level });
  if (trad.dark) {
    out.corruption += 1;
    out.provenance.corruption.push({ source: `Discovered ${traditionName} (dark magic)`, level: ctx.level, amount: 1 });
  }
  // Free rank 0 spell from the discovery (general magic rule).
  materializeRank0Pick(out, char, `${id}:rank0`, traditionName, ctx, "Discovery rank 0 spell");
  // Cantrip: extra rank 0 spell if the hook is active by this level.
  const hook = (ctx.hooks || []).find((h) => h.level <= ctx.level);
  if (hook) {
    materializeRank0Pick(out, char, `${id}:cantrip`, traditionName, ctx, "Cantrip — extra rank 0 spell");
  }
}

function materializeRank0Pick(out, char, id, traditionName, ctx, title) {
  const res = char.decisions[id];
  if (res?.spell) {
    learnSpellFromResolution(out, char, id, { spell: res.spell, tradition: traditionName }, ctx, 0);
  } else {
    out.pending.push({
      id, kind: "learn_spell", title, traditions: [traditionName], maxRank: 0,
      origin: `${traditionName} discovery (${ctx.label})`, level: ctx.level,
    });
  }
}

// A fixed spell grant (e.g. Magician's Sense Magic, Keeper of the Flame's
// create flame). Path spells live under the path's name as tradition.
function grantSpell(out, name, tradition, ctx, why) {
  const spell = findSpell(name, tradition) || findSpell(name);
  if (!spell) {
    out.notes.push({ text: `${ctx.label}: grants the “${name}” spell (not found in the archive — add manually).`, level: ctx.level });
    return;
  }
  if (out.spells.some((s) => s.name === spell.name && s.tradition === spell.tradition)) return;
  out.spells.push({ name: spell.name, tradition: spell.tradition, source: `${ctx.label} (${why})`, level: ctx.level });
}

function learnSpellFromResolution(out, char, id, res, ctx, opts = {}) {
  const spell = findSpell(res.spell, res.tradition) || findSpell(res.spell);
  if (!spell) {
    out.notes.push({ text: `Unknown spell “${res.spell}” (${ctx.label}) — pick again.`, level: ctx.level });
    return false;
  }
  // A stored pick can go stale when earlier choices change (e.g. the
  // tradition it came from is no longer discovered).
  if (opts.requireDiscovered && !out.discovered.some((d) => d.tradition === spell.tradition)) {
    return false;
  }
  if (out.spells.some((s) => s.name === spell.name && s.tradition === spell.tradition)) {
    out.notes.push({ text: `“${spell.name}” chosen twice — duplicate ignored (${ctx.label}).`, level: ctx.level });
    return true;
  }
  out.spells.push({ name: spell.name, tradition: spell.tradition, source: ctx.label, level: ctx.level, slotId: id });
  noteDarkLearning(out, spell, ctx.label);
  return true;
}

// Exchanging spells: whenever you learn a new spell you may also forget a
// known spell and learn a different one whose rank is no higher than your
// Power (Occult Philosophy's updated wording of the core rule).
function applyExchanges(out, char) {
  for (const ex of char.exchanges || []) {
    const dropIdx = out.spells.findIndex((s) => s.name === ex.drop.name && s.tradition === ex.drop.tradition);
    const gain = findSpell(ex.gain.name, ex.gain.tradition);
    const discovered = out.discovered.some((d) => d.tradition === ex.gain.tradition);
    const known = out.spells.some((s) => s.name === ex.gain.name && s.tradition === ex.gain.tradition);
    if (dropIdx === -1 || !gain || !discovered || known || gain.rank > out.power) {
      out.notes.push({ text: `Exchange of “${ex.drop.name}” for “${ex.gain.name}” is no longer legal — remove it in the Spells tab.`, level: null });
      continue;
    }
    const old = out.spells[dropIdx];
    out.spells[dropIdx] = { name: gain.name, tradition: gain.tradition, source: `Exchanged for ${old.name} (${old.source})`, level: old.level, exchanged: true };
    noteDarkLearning(out, gain, "spell exchange");
  }
}

// Learning a dark magic spell calls for a d6 roll against the number of
// dark spells known; the app can't roll it for the table, so leave a note.
function noteDarkLearning(out, spell, label) {
  const trad = rules.traditionByName.get(spell.tradition);
  if (!trad?.dark) return;
  const darkCount = out.spells.filter((s) => rules.traditionByName.get(s.tradition)?.dark).length + 1;
  out.notes.push({ text: `Learned the dark magic spell “${spell.name}” (${label}): roll a d6 — on less than ${darkCount} (your dark spells known), gain 1 Corruption. Each dark spell grants 1 boon on rolls to avoid Insanity.`, level: null });
}

function countPriorPicks(char, out, currentSlotId, talentName) {
  // Roguery talents may be taken twice; the second pick differs.
  let count = 0;
  for (const [slotId, res] of Object.entries(char.decisions)) {
    if (slotId === currentSlotId) continue;
    if (res?.talent === talentName && slotId < currentSlotId) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helpers for the UI
// ---------------------------------------------------------------------------

export function legalTraditionsFor(char, computed, slot) {
  let list = rules.traditions.map((t) => t.name);
  if (slot.constraint === "religion") {
    const religions = rules.curated.religions;
    if (char.religion && religions[char.religion]) list = religions[char.religion];
    else list = [...new Set(Object.values(religions).flat())];
  } else if (slot.traditions?.length) {
    list = slot.traditions;
  }
  const discovered = new Set(computed.discovered.map((d) => d.tradition));
  let out = list.filter((t) => !discovered.has(t));
  if (slot.excludeDark) out = out.filter((t) => !rules.traditionByName.get(t)?.dark);
  return out;
}

export function legalSpellsFor(char, computed, slot) {
  const discovered = new Set(computed.discovered.map((d) => d.tradition));
  let pool = rules.spells.filter((s) => !s.path_spell);
  if (slot.traditions?.length) {
    pool = pool.filter((s) => slot.traditions.includes(s.tradition));
    // Constrained learns still require the tradition to be discovered.
    pool = pool.filter((s) => discovered.has(s.tradition));
  } else if (slot.constraint === "religion") {
    const allowed = char.religion ? new Set(rules.curated.religions[char.religion] || []) : null;
    pool = pool.filter((s) => discovered.has(s.tradition) && (!allowed || allowed.has(s.tradition)));
  } else {
    pool = pool.filter((s) => discovered.has(s.tradition));
  }
  if (slot.excludeDark) pool = pool.filter((s) => !rules.traditionByName.get(s.tradition)?.dark);
  const maxRank = slot.maxRank ?? computed.power;
  pool = pool.filter((s) => s.rank <= maxRank);
  const known = new Set(computed.spells.map((s) => `${s.name}|${s.tradition}`.toLowerCase()));
  return pool.filter((s) => !known.has(`${s.name}|${s.tradition}`.toLowerCase()));
}

// Slot ids embed their path/ancestry names, so decisions orphaned by a
// path or level change simply stop applying — and come back if the change
// is reverted. Only the "active" decisions are shown for undo in the UI.
export function activeDecisionIds(char, computed) {
  const ids = new Set();
  const prefixes = [`creation[${char.ancestry}]`];
  for (const { source, level } of computed.plan || []) {
    if (source && !source.missing) prefixes.push(`${source.key}:${level}`);
  }
  for (const key of Object.keys(char.decisions)) {
    if (prefixes.some((pre) => key.startsWith(pre))) ids.add(key);
  }
  return ids;
}
