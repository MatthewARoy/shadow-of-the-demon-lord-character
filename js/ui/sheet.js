// Sheet tab: a parchment character sheet styled after the official paper
// sheet — red ink frames around an inverted pentagram of stat circles.
// Attribute circles roll; the damage circle and weapons are live too.
// Provenance and notes live below the paper.

import { compute, ATTRS } from "../engine.js";
import { active, save } from "../state.js";
import { rollD20, rollDamage } from "../dice.js";
import { showToast } from "./toast.js";

import { esc } from "./util.js";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sign = (n) => (n >= 0 ? "+" : "") + n;

// Inverted pentagram vertex positions (percent of the square console).
const STAR = {
  strength: { x: 27.6, y: 19.2 },
  intellect: { x: 72.4, y: 19.2 },
  agility: { x: 12, y: 60 },
  will: { x: 88, y: 60 },
  health: { x: 50, y: 90 },
};

export function renderSheet(el) {
  const char = active();
  if (!char) return;
  const computed = compute(char);
  const incapacitated = computed.health > 0 && char.damage >= computed.health;
  const masterName = char.masterMode === "second-expert" ? char.secondExpertPath : char.masterPath;

  el.innerHTML = `
  <div class="paper">
    <div class="paper-grid">

      <div class="pg-identity ink-box">
        <span class="ink-label">Name</span>
        <div class="ink-value" style="font-size:19px">${esc(char.name)}</div>
        <span class="ink-label" style="margin-top:8px">Description</span>
        <textarea class="ink-area" id="sheet-notes" rows="4"
          placeholder="Scars, debts, the things that haunt you…">${esc(char.notes)}</textarea>
      </div>

      <div class="pg-paths ink-box" style="text-align:center">
        <div style="display:flex;justify-content:center;margin-bottom:6px">
          <div class="pent-node pn-small" style="position:relative;transform:none;width:54px;height:54px">
            <span class="pn-label">Level</span>
            <span class="pn-value">${esc(char.level)}</span>
          </div>
        </div>
        <span class="ink-label">Ancestry</span>
        <div class="ink-value">${esc(char.ancestry)}</div>
        <span class="ink-label" style="margin-top:6px">Novice</span>
        <div class="ink-value">${esc(char.novicePath || "—")}</div>
        <span class="ink-label" style="margin-top:6px">Expert</span>
        <div class="ink-value">${esc(char.expertPath || "—")}${char.religion ? `<span class="ink-small"> · ${esc(char.religion)}</span>` : ""}</div>
        <span class="ink-label" style="margin-top:6px">${char.masterMode === "second-expert" ? "2nd Expert" : "Master"}</span>
        <div class="ink-value">${esc(masterName || "—")}</div>
      </div>

      <div class="pg-professions ink-box">
        <span class="ink-label">Professions &amp; Languages</span>
        ${computed.languagesProfessions.map((lp) => `
          <div class="ink-small" style="margin-bottom:5px"><b style="color:var(--ink-red)">${esc(lp.source)}.</b>
          ${esc(lp.value || lp.text)}</div>`).join("")}
      </div>

      <div class="pg-talents ink-box">
        <span class="ink-label">Talents</span>
        ${computed.talents.map((t) => `
          <div class="talent-ink"><b>${esc(t.name)}.</b> <span>${esc(t.text)}</span></div>`).join("") || `<div class="ink-small">None yet.</div>`}
        ${computed.traits.length ? `<span class="ink-label" style="margin-top:10px">Ancestry Traits</span>
        ${computed.traits.map((t) => `
          <div class="talent-ink"><b>${esc(t.name)}.</b> <span>${esc(t.text)}</span></div>`).join("")}` : ""}
      </div>

      <div class="pg-pentagram">
        ${pentagram(char, computed, incapacitated)}
        <div class="stepper-row">
          ${stepper("Damage", char.damage, `of ${computed.health} health`,
            `data-dmg="-1"`, `data-dmg="1"`, "Remove damage", "Add damage")}
          ${stepper("Insanity", computed.insanity + (computed.insanityNote ? "*" : ""),
            `of ${computed.attributes.will} will`,
            `data-adj="insanityAdjust:-1"`, `data-adj="insanityAdjust:1"`,
            "Remove a point of insanity", "Mark insanity gained")}
          ${stepper("Corruption", computed.corruption, "marks of darkness",
            `data-adj="corruptionAdjust:-1"`, `data-adj="corruptionAdjust:1"`,
            "Remove a point of corruption", "Mark corruption gained")}
        </div>
        <div style="display:flex;justify-content:center;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn-ink" data-heal title="Heal your healing rate">heal ${computed.healingRate}</button>
          <button class="btn-ink" data-rest title="Complete a rest (8 hours): heal your healing rate and regain all expended castings">rest</button>
        </div>
        ${incapacitated ? `<p style="text-align:center;color:var(--ink-red);font-family:var(--caps);margin:6px 0 0">Incapacitated — roll a fate die each round.</p>` : ""}
        ${computed.insanityNote ? `<p class="ink-small" style="text-align:center;margin:4px 0 0">Insanity * plus ${esc(computed.insanityNote)}</p>` : ""}
      </div>

      <div class="pg-magic ink-box">
        <span class="ink-label">Magic</span>
        ${computed.discovered.length ? `
          <div class="ink-small" style="margin-bottom:6px"><b style="color:var(--ink-red)">Traditions.</b>
            ${computed.discovered.map((d) => esc(d.tradition)).join(", ")}</div>` : `<div class="ink-small">No traditions discovered.</div>`}
        ${computed.spells.map((s) => `
          <div class="talent-ink">
            <b>${esc(s.name)}.</b>
            <span class="ink-small">${esc(s.tradition)} ${s.data ? s.data.rank : "?"} · ${s.castings} casting${s.castings !== 1 ? "s" : ""}${s.data?.attack ? ` · ${esc(s.data.attack.attribute)} attack` : ""}</span>
          </div>`).join("")}
      </div>

      <div class="pg-weapons ink-box">
        <span class="ink-label">Weapons</span>
        ${weaponsTable(char, computed)}
      </div>

      <div class="pg-equipment ink-box">
        <span class="ink-label">Equipment</span>
        ${char.inventory.length
          ? `<div class="ink-small">${char.inventory.map((it) => `${esc(it.name)}${(it.qty || 1) > 1 ? ` ×${it.qty}` : ""}`).join(" · ")}</div>`
          : `<div class="ink-small">Nothing but lint and regret.</div>`}
        ${char.coins ? `<div class="ink-small" style="margin-top:6px"><b style="color:var(--ink-red)">Coin.</b> ${esc(char.coins)}</div>` : ""}
      </div>

    </div>
  </div>

  <div class="prov-tip" id="prov-tip" role="tooltip" hidden></div>

  <div class="sheet-below">
    <div class="cols cols-2" style="margin-top:18px">
      <div class="panel">
        <h2 class="rubric">Provenance</h2>
        ${provBlock("Health", computed.provenance.health, provBase("Health", computed))}
        ${provBlock("Power", computed.provenance.power, provBase("Power", computed))}
        ${provBlock("Defense", computed.provenance.defense, provBase("Defense", computed))}
        ${provBlock("Speed", computed.provenance.speed, provBase("Speed", computed))}
        ${provBlock("Corruption", computed.provenance.corruption, provBase("Corruption", computed))}
        ${provBlock("Insanity", computed.provenance.insanity, provBase("Insanity", computed))}
        <p class="small dim" style="margin-bottom:0">Use your browser's print function for a paper copy — the dark chrome stays behind.</p>
      </div>
      <div class="panel">
        <h2 class="rubric">Marginalia</h2>
        ${computed.notes.length
          ? computed.notes.map((n) => `<p class="small dim">• ${esc(n.text)}</p>`).join("")
          : `<p class="empty">Nothing in the margins.</p>`}
      </div>
    </div>
  </div>`;

  wireSheet(el, char, computed);
}

/* ---------------- pentagram console ---------------- */

function pentagram(char, computed, incapacitated) {
  const m = computed.modifiers;
  // Star path: connect every second vertex of the inverted pentagram.
  const order = ["strength", "will", "agility", "intellect", "health"];
  const pts = order.map((k) => STAR[k]);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ") + " Z";
  // modifier circles tucked toward the center from each attribute vertex
  const modPos = (k) => ({ x: STAR[k].x + (50 - STAR[k].x) * 0.36, y: STAR[k].y + (50 - STAR[k].y) * 0.36 });

  const nodes = [];
  for (const a of ATTRS) {
    const p = a === "health" ? null : STAR[a];
    if (!p) continue;
    nodes.push(node("pn-med rollable", p, cap(a), computed.attributes[a], null, `data-roll-attr="${a}"`, `Roll ${cap(a)}`));
    nodes.push(node("pn-mod", modPos(a), null, sign(m[a])));
  }
  nodes.push(node("pn-med", STAR.health, "Health", computed.health, null, provAttr("Health", computed)));
  nodes.push(node("pn-mod", { x: 50, y: 73.5 }, "Healing", computed.healingRate));
  nodes.push(node(`pn-large pn-damage`, { x: 50, y: 50 }, "Damage", char.damage, incapacitated ? "DOWN" : null));
  // satellites, mirroring the paper sheet's outer circles
  nodes.push(node("pn-small", { x: 10.5, y: 25 }, "Size", computed.size));
  nodes.push(node("pn-small", { x: 5.5, y: 41 }, "Speed", computed.speed, null, provAttr("Speed", computed)));
  nodes.push(node("pn-small", { x: 89.5, y: 9 }, "Power", computed.power, null, provAttr("Power", computed)));
  nodes.push(node("pn-small rollable", { x: 94, y: 26.5 }, "Perception", computed.perception, null, `data-roll-perception="1"`, "Roll Perception"));
  nodes.push(node("pn-small", { x: 96, y: 43.5 }, "Insanity", computed.insanity + (computed.insanityNote ? "*" : "")));
  nodes.push(node("pn-small", { x: 16.5, y: 84 }, "Defense", computed.defense, null, provAttr("Defense", computed)));
  nodes.push(node("pn-small", { x: 83.5, y: 84 }, "Corruption", computed.corruption));

  return `
  <div class="pentagram-wrap">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(142,31,31,.5)" stroke-width="1.1"/>
      <circle cx="50" cy="50" r="42.5" fill="none" stroke="rgba(142,31,31,.35)" stroke-width=".55"/>
      <path d="${path}" fill="rgba(142,31,31,.04)" stroke="rgba(142,31,31,.55)" stroke-width="1.1" stroke-linejoin="round"/>
    </svg>
    ${nodes.join("")}
  </div>`;
}

function node(cls, pos, label, value, sub, attrs = "", title = "") {
  // Rollable nodes are real buttons so they're keyboard-reachable and announce
  // their action; static nodes stay <div>s. The `rollable` class only ever rides
  // along with a data-roll-* attribute, so keying off it is safe.
  const rollable = /\brollable\b/.test(cls);
  const tag = rollable ? "button" : "div";
  const typeAttr = rollable ? `type="button"` : "";
  // A static node carrying provenance still needs keyboard focus so the
  // breakdown appears on focus for desktop keyboard users (buttons already
  // focus themselves).
  const focusAttr = !rollable && /\bdata-prov=/.test(attrs) ? `tabindex="0"` : "";
  return `
  <${tag} class="pent-node ${cls}" style="left:${pos.x}%;top:${pos.y}%" ${typeAttr} ${focusAttr} ${attrs} ${title ? `title="${esc(title)}"` : ""}>
    ${label ? `<span class="pn-label">${esc(label)}</span>` : ""}
    <span class="pn-value">${esc(value)}</span>
    ${sub ? `<span class="pn-sub">${esc(sub)}</span>` : ""}
  </${tag}>`;
}

/* ---------------- play-tracking steppers ---------------- */

// A grouped stepper card: small-caps name, − value + row of real buttons, and
// a one-line subnote. The buttons carry the same data-dmg / data-adj hooks the
// old chips used, so the existing mutation handlers (with their clamp rules)
// drive them unchanged.
function stepper(name, value, sub, minusAttr, plusAttr, minusLabel, plusLabel) {
  return `
  <div class="stepper">
    <span class="stepper-name">${esc(name)}</span>
    <div class="stepper-controls">
      <button type="button" class="stepper-btn" ${minusAttr} aria-label="${esc(minusLabel)}">−</button>
      <span class="stepper-value">${esc(value)}</span>
      <button type="button" class="stepper-btn" ${plusAttr} aria-label="${esc(plusLabel)}">+</button>
    </div>
    <span class="stepper-sub">${esc(sub)}</span>
  </div>`;
}

/* ---------------- weapons ---------------- */

function weaponModifier(it, computed) {
  const finesse = /finesse/i.test(it.properties || "");
  const { strength, agility } = computed.modifiers;
  return finesse ? Math.max(strength, agility) : strength;
}

function weaponsTable(char, computed) {
  const weapons = char.inventory.filter((it) => it.damage);
  if (!weapons.length) return `<div class="ink-small">No weapons carried — fists and prayers (add some in the Gear tab).</div>`;
  return `
  <table class="ink-table">
    <thead><tr><th>Weapon</th><th>Modifier</th><th>Damage</th><th></th></tr></thead>
    <tbody>
      ${weapons.map((it) => `
      <tr>
        <td>${esc(it.name)}${it.equipped ? "" : ` <span class="ink-small">(stowed)</span>`}
          ${it.properties ? `<div class="ink-small">${esc(it.properties)}</div>` : ""}</td>
        <td>${sign(weaponModifier(it, computed))}</td>
        <td>${esc(it.damage)}</td>
        <td><button class="btn-ink" data-weapon-roll="${esc(it.id)}">roll</button></td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

/* ---------------- provenance ---------------- */

// The non-engine "base" rows that lead each stat's breakdown — the replacement
// or starting value the engine's provenance deltas build on. Shared by the
// print block and the node tooltips so the two never drift.
function provBase(name, computed) {
  switch (name) {
    case "Health":
      return [{ source: "Strength score", amount: computed.attributes.strength }];
    case "Defense":
      return computed.armor ? [{ source: `${computed.armor.name} (armor)`, amount: computed.armor.base }]
        : computed.defenseFixed != null ? [{ source: "Fixed (ancestry)", amount: computed.defenseFixed }]
        : [{ source: "Agility score", amount: computed.attributes.agility }];
    case "Speed":
      return [{ source: "Ancestry base", amount: computed.ancestry.creation.speed }];
    default:
      return [];
  }
}

// The final computed value for a stat — the authoritative "Total" a tooltip
// shows. It reflects clamps (e.g. Defense caps at 25) the row sum may not.
function provTotal(name, computed) {
  return { Health: computed.health, Power: computed.power, Defense: computed.defense, Speed: computed.speed }[name];
}

function provBlock(name, list, base = []) {
  const rows = [...base, ...list];
  if (!rows.length) return "";
  return `<p class="prov"><b>${esc(name)}:</b> ${rows.map((r) =>
    `${esc(r.source)} ${r.amount >= 0 ? "+" : ""}${esc(r.amount)}`).join(" · ")}</p>`;
}

// A data-prov="…" attribute carrying a JSON breakdown for the hover/focus/tap
// tooltip. Rows come straight from the same base + engine provenance the print
// block uses; the total is the authoritative computed stat. Empty when there's
// nothing to explain. esc() keeps user-derived sources (armor names) safe once
// the value is read back and re-inserted as text by the tooltip.
function provAttr(name, computed) {
  const rows = [...provBase(name, computed), ...(computed.provenance[name.toLowerCase()] || [])];
  if (!rows.length) return "";
  const payload = { name, total: provTotal(name, computed), rows: rows.map((r) => ({ source: r.source, amount: r.amount })) };
  return `data-prov="${esc(JSON.stringify(payload))}"`;
}

/* ---------------- events ---------------- */

function wireSheet(el, char, computed) {
  wireProvTooltip(el);
  el.querySelectorAll("[data-roll-attr]").forEach((n) => n.addEventListener("click", () => {
    const a = n.dataset.rollAttr;
    showToast(rollD20(`${cap(a)} challenge`, computed.modifiers[a]));
  }));
  el.querySelector("[data-roll-perception]")?.addEventListener("click", () => {
    showToast(rollD20("Perception challenge", computed.perception - 10));
  });
  el.querySelectorAll("[data-dmg]").forEach((b) => b.addEventListener("click", () => {
    char.damage = Math.max(0, Math.min(computed.health, char.damage + parseInt(b.dataset.dmg, 10)));
    save(); renderSheet(el);
  }));
  el.querySelector("[data-heal]")?.addEventListener("click", () => {
    char.damage = Math.max(0, char.damage - computed.healingRate);
    save(); renderSheet(el);
  });
  el.querySelector("[data-rest]")?.addEventListener("click", () => {
    const healed = Math.min(char.damage, computed.healingRate);
    char.damage -= healed;
    char.expended = {};
    save(); renderSheet(el);
    showToast({ total: "☾", label: "Rest completed", detail: `Healed ${healed} damage and regained all castings. A full 24-hour rest heals double — press heal once more.` });
  });
  el.querySelectorAll("[data-adj]").forEach((b) => b.addEventListener("click", () => {
    const [field, delta] = b.dataset.adj.split(":");
    const base = field === "insanityAdjust" ? computed.insanityBase : computed.corruptionBase;
    char[field] = Math.max(-base, (char[field] || 0) + parseInt(delta, 10));
    save(); renderSheet(el);
  }));
  el.querySelectorAll("[data-weapon-roll]").forEach((b) => b.addEventListener("click", () => {
    const it = char.inventory.find((x) => x.id === b.dataset.weaponRoll);
    if (!it) return;
    showToast(rollD20(`${it.name} attack`, weaponModifier(it, computed)));
    if (it.damage && it.damage !== "—") {
      const dmg = rollDamage(it.damage, `${it.name} damage`);
      if (dmg) showToast(dmg);
    }
  }));
  const notes = el.querySelector("#sheet-notes");
  if (notes) {
    notes.addEventListener("change", (e) => { char.notes = e.target.value; save(); });
    // Auto-grow fallback for browsers without field-sizing: content. Also runs
    // once now so loaded/imported notes open at their full height.
    notes.addEventListener("input", () => autoSizeNotes(notes));
    autoSizeNotes(notes);
  }
}

// Grow the notes area to fit its content up to the CSS max-height, then let it
// scroll. Skipped where field-sizing already does the work. Reads/writes only
// this element's own height, so it never nudges the page's scroll position.
function autoSizeNotes(ta) {
  if (CSS.supports?.("field-sizing", "content")) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

/* ---------------- provenance tooltip ---------------- */

// A single tooltip element (#prov-tip) shows a stat's breakdown on hover/focus,
// and toggles on tap for non-rollable stat nodes (rollable nodes keep their
// roll-on-click and only respond to hover/focus). Listeners are delegated on
// the sheet pane and attached once — the pane's innerHTML is replaced each
// render but these survive because they live on the pane itself.
function wireProvTooltip(el) {
  if (el.dataset.provWired) return;
  el.dataset.provWired = "1";

  const tipFor = () => el.querySelector("#prov-tip");
  let current = null; // the node whose tooltip is showing (for tap-toggle)

  const hide = () => {
    const tip = tipFor();
    if (tip) { tip.hidden = true; tip.innerHTML = ""; }
    if (current) { current.removeAttribute("aria-describedby"); current = null; }
  };

  const show = (node) => {
    const tip = tipFor();
    if (!tip || !node?.dataset.prov) return;
    let data;
    try { data = JSON.parse(node.dataset.prov); } catch { return; }
    tip.innerHTML = provTipHTML(data);
    node.setAttribute("aria-describedby", "prov-tip");
    tip.hidden = false;
    positionTip(tip, node);
    current = node;
  };

  // Hover + keyboard focus (desktop): show on enter/focus, hide on leave/blur.
  el.addEventListener("mouseover", (e) => {
    const node = e.target.closest?.("[data-prov]");
    if (node) show(node);
  });
  el.addEventListener("mouseout", (e) => {
    const node = e.target.closest?.("[data-prov]");
    // Ignore moves within the same node.
    if (node && node !== e.relatedTarget?.closest?.("[data-prov]")) hide();
  });
  el.addEventListener("focusin", (e) => {
    const node = e.target.closest?.("[data-prov]");
    if (node) show(node);
  });
  el.addEventListener("focusout", (e) => {
    if (e.target.closest?.("[data-prov]")) hide();
  });
  // Touch: a tap on a NON-rollable stat node toggles its tooltip. We gate on
  // pointerType so desktop mouse clicks (which already got a hover tooltip)
  // don't immediately toggle it back off. Rollable nodes are never intercepted,
  // so their roll-on-click stays untouched.
  let touchToggled = false;
  el.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    const node = e.target.closest?.("[data-prov]");
    if (!node || node.classList.contains("rollable")) return;
    if (current === node) hide(); else show(node);
    touchToggled = true;
  });
  // Swallow the click a touch tap synthesizes so it can't re-trigger anything.
  el.addEventListener("click", (e) => {
    if (!touchToggled) return;
    touchToggled = false;
    const node = e.target.closest?.("[data-prov]");
    if (node && !node.classList.contains("rollable")) { e.stopPropagation(); e.preventDefault(); }
  });
  // A tap anywhere off an open tooltip's node dismisses it.
  document.addEventListener("pointerdown", (e) => {
    if (current && !e.target.closest?.("[data-prov]") && !e.target.closest?.("#prov-tip")) hide();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) { const n = current; hide(); n.blur?.(); }
  });
}

function provTipHTML(data) {
  const rows = data.rows.map((r) =>
    `<div class="prov-tip-row"><span>${esc(r.source)}</span><span>${r.amount >= 0 ? "+" : ""}${esc(r.amount)}</span></div>`).join("");
  return `<div class="prov-tip-title">${esc(data.name)}</div>${rows}
    <div class="prov-tip-row prov-tip-total"><span>Total</span><span>${esc(data.total)}</span></div>`;
}

// Place the fixed-position tooltip centered above the node, flipping below and
// clamping to the viewport so it never spills off-screen.
function positionTip(tip, node) {
  const n = node.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  let left = n.left + n.width / 2 - t.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
  let top = n.top - t.height - gap;
  if (top < 6) top = n.bottom + gap; // flip below when it would clip the top

  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
