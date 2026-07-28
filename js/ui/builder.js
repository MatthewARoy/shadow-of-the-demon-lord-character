// Build tab: identity, paths, the level timeline, and the decision queue.

import { rules, expertPaths, masterPaths } from "../data.js";
import { compute, legalTraditionsFor, legalSpellsFor, ATTRS, activeDecisionIds } from "../engine.js";
import { active, save } from "../state.js";
import { esc } from "./util.js";

export function renderBuilder(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);
  const pendingNow = computed.pending.filter((p) => p.kind !== "choose_path");

  el.innerHTML = `
    <div class="cols cols-2-3">
      <div>
        ${identityPanel(char, computed)}
        ${pathsPanel(char, computed)}
        ${timelinePanel(char, computed)}
      </div>
      <div>
        <div class="panel">
          <h2 class="rubric">Unresolved Fates
            <span class="count">${pendingNow.length ? `${pendingNow.length} ${pendingNow.length === 1 ? "decision awaits" : "decisions await"}` : "all is written"}</span>
          </h2>
          ${pendingNow.length ? `<div class="decisions">${pendingNow.map((p) => decisionCard(char, computed, p)).join("")}</div>`
            : `<p class="empty">Every choice has been inscribed. Increase your level, or revisit your paths, to tempt fate further.</p>`}
        </div>
        ${resolvedPanel(char, computed)}
      </div>
    </div>`;

  wireControls(el);
  wireDelegated(el);
}

/* ---------------- identity ---------------- */

function identityPanel(char, computed) {
  const ancestries = rules.curated.ancestries;
  const a = computed.ancestry;
  const c = a.creation;
  return `
  <div class="panel">
    <h2 class="rubric">The Soul</h2>
    <div class="field-row">
      <div class="field" style="flex:2 1 180px">
        <label>name</label>
        <input type="text" id="b-name" value="${esc(char.name)}">
      </div>
      <div class="field">
        <label>ancestry</label>
        <select id="b-ancestry">${ancestries.map((x) => `<option ${x.name === char.ancestry ? "selected" : ""}>${x.name}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label>level</label>
        <select id="b-level">${Array.from({ length: 11 }, (_, i) =>
          `<option value="${i}" ${i === char.level ? "selected" : ""}>${i}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field-row">
      ${c.size_options ? `
      <div class="field">
        <label>size</label>
        <select id="b-size">${c.size_options.map((s) => `<option ${s === (char.sizeChoice || c.size) ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>` : ""}
      ${c.no_attribute_swap ? "" : `
      <div class="field">
        <label>adjust: +1 to</label>
        <select id="b-swap-up">
          <option value="">—</option>
          ${ATTRS.map((a) => `<option value="${a}" ${char.attributeSwap?.to === a ? "selected" : ""}>${a}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>and −1 from</label>
        <select id="b-swap-down">
          <option value="">—</option>
          ${ATTRS.filter((a) => a !== char.attributeSwap?.to).map((a) => `<option value="${a}" ${char.attributeSwap?.from === a ? "selected" : ""}>${a}</option>`).join("")}
        </select>
      </div>`}
    </div>
    <p class="small dim">${esc(c.languages_professions)}</p>
    ${a.description ? `<p class="flavor small">${esc(a.description)}</p>` : ""}
  </div>`;
}

/* ---------------- paths ---------------- */

function pathsPanel(char, computed) {
  const novices = rules.curated.novice_paths;
  const novice = rules.novicePathByName.get(char.novicePath);
  const needsReligion = novice?.requires_religion;
  const useSecond = char.masterMode === "second-expert";
  return `
  <div class="panel">
    <h2 class="rubric">The Paths</h2>
    <div class="field-row">
      <div class="field">
        <label>novice path · level 1</label>
        <select id="b-novice">
          <option value="">—</option>
          ${novices.map((p) => `<option ${p.name === char.novicePath ? "selected" : ""}>${p.name}</option>`).join("")}
        </select>
      </div>
      ${needsReligion ? `
      <div class="field">
        <label>religion</label>
        <select id="b-religion">
          <option value="">—</option>
          ${Object.keys(rules.curated.religions).map((r) => `<option ${r === char.religion ? "selected" : ""}>${r}</option>`).join("")}
        </select>
      </div>` : ""}
      <div class="field">
        <label>expert path · level 3</label>
        <select id="b-expert">
          <option value="">—</option>
          ${expertPaths().map((p) => `<option ${p.name === char.expertPath ? "selected" : ""}>${p.name}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>at level 7…</label>
        <div class="chip-row">
          <button class="chip ${!useSecond ? "on" : ""}" id="b-mode-master">master path</button>
          <button class="chip ${useSecond ? "on" : ""}" id="b-mode-second">second expert path</button>
        </div>
      </div>
      ${useSecond ? `
      <div class="field">
        <label>second expert path · level 7</label>
        <select id="b-second">
          <option value="">—</option>
          ${expertPaths().filter((p) => p.name !== char.expertPath).map((p) => `<option ${p.name === char.secondExpertPath ? "selected" : ""}>${p.name}</option>`).join("")}
        </select>
      </div>` : `
      <div class="field">
        <label>master path · level 7</label>
        <select id="b-master">
          <option value="">—</option>
          ${masterPaths().map((p) => `<option ${p.name === char.masterPath ? "selected" : ""}>${p.name}</option>`).join("")}
        </select>
      </div>`}
    </div>
    ${useSecond ? `<p class="note">Second expert path: level 7 grants its level 3 benefits, level 9 lets you pick either path's level 9 benefits, level 10 grants its level 6 benefits. If it duplicates a talent you have, the rulebook offers: +1 to an attribute and a profession, discover a tradition, or learn a spell — note it in your character notes.</p>` : ""}
    ${pathBlurb(char)}
  </div>`;
}

function pathBlurb(char) {
  const parts = [];
  const novice = rules.novicePathByName.get(char.novicePath);
  if (novice) parts.push(`<p class="flavor small"><b class="bronze">${novice.name}.</b> ${esc(novice.description)}</p>`);
  for (const name of [char.expertPath, char.masterMode === "second-expert" ? char.secondExpertPath : char.masterPath]) {
    const p = name && rules.pathByName.get(name);
    if (p?.description) parts.push(`<p class="flavor small"><b class="bronze">${p.name}.</b> ${esc(p.description.slice(0, 260))}${p.description.length > 260 ? "…" : ""}</p>`);
  }
  return parts.join("");
}

/* ---------------- timeline ---------------- */

function timelinePanel(char, computed) {
  const plan = computed.plan || [];
  const pendingByLevel = {};
  for (const p of computed.pending) pendingByLevel[p.level] = (pendingByLevel[p.level] || 0) + 1;
  const rows = [];
  rows.push(tlRow(0, "Ancestry — " + char.ancestry, levelSummary(computed, 0), char.level >= 0, pendingByLevel[0]));
  const adv = rules.curated.advancement;
  for (const { level, gain, note } of adv) {
    const planRow = plan.find((r) => r.level === level);
    const label = planRow?.source?.label || note;
    rows.push(tlRow(level, label, level <= char.level ? levelSummary(computed, level) : note, level <= char.level, pendingByLevel[level]));
  }
  return `
  <div class="panel">
    <h2 class="rubric">The Descent <span class="count">level ${char.level} of 10</span></h2>
    <div class="timeline">${rows.join("")}</div>
  </div>`;
}

function tlRow(level, title, sub, attained, pendingCount) {
  return `
  <div class="tl-row ${attained ? "attained" : "future"} ${pendingCount ? "pending-choices" : ""}">
    <div class="tl-node"><span class="pip"><span>${level}</span></span></div>
    <div class="tl-body">
      <div class="tl-title">${esc(title)} ${pendingCount ? `<span class="blood small">· ${pendingCount} unresolved</span>` : ""}</div>
      <div class="tl-sub">${sub}</div>
    </div>
  </div>`;
}

function levelSummary(computed, level) {
  const bits = [];
  for (const h of computed.provenance.health.filter((x) => x.level === level)) bits.push(`Health +${h.amount}`);
  for (const p of computed.provenance.power.filter((x) => x.level === level)) bits.push(`Power +${p.amount}`);
  for (const d of computed.provenance.defense.filter((x) => x.level === level)) bits.push(`Defense +${d.amount}`);
  for (const t of computed.talents.filter((x) => x.level === level)) bits.push(t.name);
  for (const d of computed.discovered.filter((x) => x.level === level)) bits.push(`✦ ${d.tradition}`);
  for (const s of computed.spells.filter((x) => x.level === level)) bits.push(`✷ ${s.name}`);
  return bits.length ? esc(bits.join(" · ")) : "—";
}

/* ---------------- decision cards ---------------- */

function decisionCard(char, computed, p) {
  switch (p.kind) {
    case "attribute_choice": return attrCard(char, p);
    case "discover": return discoverCard(char, computed, p);
    case "magic_pick": return magicPickCard(char, computed, p);
    case "learn_spell": return learnCard(char, computed, p);
    case "talent_choice": return talentCard(p);
    case "option_choice": return optionCard(p);
    case "lang_prof": return langProfCard(p);
    default: return "";
  }
}

const card = (p, body, extra = "") => `
  <div class="decision" data-slot="${esc(p.id)}">
    <h3>${esc(p.title)}</h3>
    <div class="origin">${esc(p.origin)}${p.level ? ` · level ${p.level}` : ""}</div>
    ${extra}
    <div class="controls">${body}</div>
  </div>`;

function attrCard(char, p) {
  const res = char.decisions[p.id];
  const chosen = new Set(res?.attrs || []);
  return card(p, ATTRS.map((a) =>
    `<button class="chip ${chosen.has(a) ? "on" : ""}" data-attr-pick="${a}">${a}</button>`).join("") +
    `<span class="small dim">pick ${p.count}</span>`);
}

function discoverCard(char, computed, p) {
  const options = legalTraditionsFor(char, computed, p);
  return card(p,
    `<select data-discover>
      <option value="">choose a tradition…</option>
      ${options.map((t) => {
        const trad = rules.traditionByName.get(t);
        return `<option value="${esc(t)}">${esc(t)}${trad?.dark ? " ☠" : ""} (${trad?.attribute})</option>`;
      }).join("")}
    </select>`,
    p.constraint === "religion" && !char.religion
      ? `<p class="desc blood">Choose your religion in The Paths panel to narrow these options.</p>`
      : `<p class="desc dim small">Discovering a tradition grants a rank 0 spell from it${hasCantrip(computed, p.level) ? " — and your Cantrip grants a second one" : ""}. Dark traditions (☠) inflict 1 Corruption.</p>`);
}

function hasCantrip(computed, level) {
  return computed.talents.some((t) => t.name === "Cantrip" && t.level <= level);
}

function magicPickCard(char, computed, p) {
  const traditions = legalTraditionsFor(char, computed, p);
  const spells = legalSpellsFor(char, computed, p);
  const cantrip = hasCantrip(computed, p.level);
  return card(p,
    `<div class="field" style="flex:1 1 180px">
      <label>discover a tradition${cantrip ? " (rank 0 spell ×2 via Cantrip)" : " (grants a rank 0 spell)"}</label>
      <select data-magic-discover>
        <option value="">—</option>
        ${traditions.map((t) => {
          const trad = rules.traditionByName.get(t);
          return `<option value="${esc(t)}">${esc(t)}${trad?.dark ? " ☠" : ""} (${trad?.attribute})</option>`;
        }).join("")}
      </select>
    </div>
    <div class="field" style="flex:1 1 200px">
      <label>…or go deeper: learn a spell (rank ≤ ${p.maxRank})</label>
      <select data-magic-learn ${spells.length ? "" : "disabled"}>
        <option value="">—</option>
        ${spellOptionGroups(spells)}
      </select>
    </div>`);
}

// Group spell options by tradition so long lists stay scannable.
function spellOptionGroups(spells) {
  const byTrad = new Map();
  for (const s of spells) {
    if (!byTrad.has(s.tradition)) byTrad.set(s.tradition, []);
    byTrad.get(s.tradition).push(s);
  }
  return [...byTrad.keys()].sort().map((t) =>
    `<optgroup label="${esc(t)}">
      ${byTrad.get(t).map((s) => `<option value="${esc(s.name)}|${esc(s.tradition)}">${esc(s.name)} · rank ${s.rank} ${s.type === "Attack" ? "⚔" : "✧"}</option>`).join("")}
    </optgroup>`).join("");
}

function learnCard(char, computed, p) {
  const spells = legalSpellsFor(char, computed, p);
  return card(p,
    spells.length
      ? `<select data-learn>
          <option value="">choose a spell…</option>
          ${spellOptionGroups(spells)}
        </select>`
      : `<p class="desc blood">No legal spells — discover a tradition first${p.traditions ? ` (requires ${p.traditions.join(" or ")})` : ""}.</p>`,
    p.maxRank === 0 ? `<p class="desc dim small">Rank 0 spells of ${esc((p.traditions || []).join(", "))}.</p>` : "");
}

function talentCard(p) {
  return card(p,
    `<select data-talent>
      <option value="">choose a talent…</option>
      ${p.pool.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("")}
    </select>`,
    `<p class="desc dim small">${p.pool.map((t) => `<b class="bronze">${esc(t.name)}.</b> ${esc(t.text.slice(0, 110))}…`).join("<br>")}</p>`);
}

function optionCard(p) {
  return card(p, p.options.map((label, i) =>
    `<button class="chip" data-option="${i}">${esc(label)}</button>`).join(""));
}

function langProfCard(p) {
  const suggestions = (p.suggest || []).flatMap((cat) => rules.curated.professions[cat] || []);
  return card(p,
    `<input type="text" data-langprof placeholder="e.g. ${esc(suggestions[0] || "Common Tongue")}" list="lp-${esc(p.id)}" style="flex:1">
     <datalist id="lp-${esc(p.id)}">${suggestions.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
     ${p.rollable ? `<button class="btn btn-small" data-langprof-roll title="Let the dice decide: d6 for the profession type, then its table">🎲</button>` : ""}
     <button class="btn btn-small btn-resolve" data-langprof-save>Inscribe</button>`,
    `<p class="desc dim small">${esc(p.desc)}</p>`);
}

/* ---------------- resolved decisions ---------------- */

function resolvedPanel(char, computed) {
  const activeIds = activeDecisionIds(char, computed);
  const entries = Object.entries(char.decisions).filter(([id]) => activeIds.has(id));
  if (!entries.length) return "";
  const lines = entries.map(([id, res]) => {
    let text = "";
    if (res.attrs) text = `Attributes: ${res.attrs.join(", ")}`;
    else if (res.kind === "discover" || (res.tradition && !res.spell)) text = `Discovered ${res.tradition}`;
    else if (res.spell) text = `Learned ${res.spell}`;
    else if (res.talent) text = `Talent: ${res.talent}`;
    else if (res.option != null) text = `Option ${res.option + 1}`;
    else if (res.text) text = res.text;
    return { id, text };
  }).filter((x) => x.text);
  if (!lines.length) return "";
  return `
  <div class="panel">
    <h2 class="rubric">Inscribed Choices <span class="count">${lines.length}</span></h2>
    <div class="chip-row">
      ${lines.map((l) => `<button class="chip" data-undo="${esc(l.id)}" title="Click to unmake this choice">${esc(l.text)} ✕</button>`).join("")}
    </div>
    <p class="small dim" style="margin-bottom:0">Click a choice to unmake it (and any choices that depended on it).</p>
  </div>`;
}

/* ---------------- events ---------------- */

function wireControls(el) {
  const char = active();
  const rerender = () => { save(); renderBuilder(el); };

  el.querySelector("#b-name")?.addEventListener("change", (e) => { char.name = e.target.value; rerender(); });
  el.querySelector("#b-ancestry")?.addEventListener("change", (e) => { char.ancestry = e.target.value; char.sizeChoice = null; rerender(); });
  el.querySelector("#b-level")?.addEventListener("change", (e) => { char.level = parseInt(e.target.value, 10); rerender(); });
  el.querySelector("#b-size")?.addEventListener("change", (e) => { char.sizeChoice = e.target.value; rerender(); });
  el.querySelector("#b-novice")?.addEventListener("change", (e) => { char.novicePath = e.target.value || null; rerender(); });
  el.querySelector("#b-religion")?.addEventListener("change", (e) => { char.religion = e.target.value || null; rerender(); });
  el.querySelector("#b-expert")?.addEventListener("change", (e) => { char.expertPath = e.target.value || null; rerender(); });
  el.querySelector("#b-master")?.addEventListener("change", (e) => { char.masterPath = e.target.value || null; rerender(); });
  el.querySelector("#b-second")?.addEventListener("change", (e) => { char.secondExpertPath = e.target.value || null; rerender(); });
  el.querySelector("#b-mode-master")?.addEventListener("click", () => { char.masterMode = "master"; rerender(); });
  el.querySelector("#b-mode-second")?.addEventListener("click", () => { char.masterMode = "second-expert"; rerender(); });

  const updateSwap = () => {
    const to = el.querySelector("#b-swap-up")?.value || "";
    const from = el.querySelector("#b-swap-down")?.value || "";
    // Keep partial picks so choosing one dropdown survives the re-render;
    // the engine only applies the swap once both sides are set.
    char.attributeSwap = to || from ? { from, to } : null;
    rerender();
  };
  el.querySelector("#b-swap-up")?.addEventListener("change", updateSwap);
  el.querySelector("#b-swap-down")?.addEventListener("change", updateSwap);
}

// Delegated listeners live on the persistent panel element — attach exactly
// once, and look the character up fresh on each event.
function wireDelegated(el) {
  if (el.dataset.wired) return;
  el.dataset.wired = "1";

  el.addEventListener("click", (e) => {
    const char = active();
    if (!char) return;
    const rerender = () => { save(); renderBuilder(el); };
    const slotEl = e.target.closest("[data-slot]");
    const undo = e.target.closest("[data-undo]");
    if (undo) {
      delete char.decisions[undo.dataset.undo];
      rerender();
      return;
    }
    if (!slotEl) return;
    const id = slotEl.dataset.slot;

    const attrBtn = e.target.closest("[data-attr-pick]");
    if (attrBtn) {
      const a = attrBtn.dataset.attrPick;
      const res = char.decisions[id] || { attrs: [] };
      const count = parseInt(slotEl.querySelector(".dim")?.textContent.replace(/\D/g, "") || "2", 10);
      if (res.attrs.includes(a)) res.attrs = res.attrs.filter((x) => x !== a);
      else { res.attrs.push(a); if (res.attrs.length > count) res.attrs.shift(); }
      char.decisions[id] = res;
      rerender();
      return;
    }
    const optBtn = e.target.closest("[data-option]");
    if (optBtn) {
      char.decisions[id] = { option: parseInt(optBtn.dataset.option, 10) };
      rerender();
      return;
    }
    if (e.target.closest("[data-langprof-roll]")) {
      const input = slotEl.querySelector("[data-langprof]");
      const cats = Object.keys(rules.curated.professions);
      const cat = cats[Math.floor(Math.random() * cats.length)];
      const pool = rules.curated.professions[cat];
      input.value = pool[Math.floor(Math.random() * pool.length)];
      return;
    }
    if (e.target.closest("[data-langprof-save]")) {
      const input = slotEl.querySelector("[data-langprof]");
      if (input?.value.trim()) {
        char.decisions[id] = { text: input.value.trim() };
        rerender();
      }
      return;
    }
  });

  el.addEventListener("change", (e) => {
    const char = active();
    if (!char) return;
    const slotEl = e.target.closest("[data-slot]");
    if (!slotEl) return;
    const id = slotEl.dataset.slot;
    if (e.target.matches("[data-discover]") && e.target.value) {
      char.decisions[id] = { kind: "discover", tradition: e.target.value };
      save(); renderBuilder(el);
    } else if (e.target.matches("[data-magic-discover]") && e.target.value) {
      char.decisions[id] = { kind: "discover", tradition: e.target.value };
      save(); renderBuilder(el);
    } else if (e.target.matches("[data-magic-learn]") && e.target.value) {
      const [name, tradition] = e.target.value.split("|");
      char.decisions[id] = { kind: "learn", spell: name, tradition };
      save(); renderBuilder(el);
    } else if (e.target.matches("[data-learn]") && e.target.value) {
      const [name, tradition] = e.target.value.split("|");
      char.decisions[id] = { spell: name, tradition };
      save(); renderBuilder(el);
    } else if (e.target.matches("[data-talent]") && e.target.value) {
      char.decisions[id] = { talent: e.target.value };
      save(); renderBuilder(el);
    }
  });
}
