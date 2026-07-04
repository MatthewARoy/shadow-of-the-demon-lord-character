// Dice tab: tray with boons/banes and the roll ledger.

import { diceState, rollD20, rollPlain, rollDamage, rollLog, onRoll } from "../dice.js";
import { compute, ATTRS } from "../engine.js";
import { active } from "../state.js";
import { showToast } from "./toast.js";
import { esc } from "./util.js";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

let wired = false;

export function renderDice(el) {
  const char = active();
  const computed = char ? compute(char) : null;

  const log = rollLog();
  // Newest roll gets pride of place atop the ledger; the rest scroll below it.
  const latest = log.length ? log[log.length - 1] : null;
  const rest = log.slice(0, -1);

  el.innerHTML = `
  <div class="panel dice-panel">
    <div class="dice-grid">
      <div class="dice-caster">
        <h2 class="rubric">The Casting of Lots</h2>
        <div class="dice-tray">
          <button class="die-btn" data-die="20">d20</button>
          <button class="die-btn" data-die="6">d6</button>
          <button class="die-btn" data-die="3">d3</button>
          <div class="bb-control">
            <button class="btn btn-small" id="dice-bane">bane −</button>
            <span class="num ${diceState.boons > 0 ? "boon" : diceState.boons < 0 ? "bane" : ""}" id="dice-bb">${diceState.boons > 0 ? "+" + diceState.boons : diceState.boons}</span>
            <button class="btn btn-small" id="dice-boon">+ boon</button>
          </div>
          <span class="small dim">boons/banes: roll that many d6, take the highest, add or subtract</span>
        </div>
        ${computed ? `
        <hr class="rule">
        <div class="chip-row">
          ${ATTRS.map((a) => `<button class="chip" data-attr="${a}">${cap(a)} ${computed.modifiers[a] >= 0 ? "+" : ""}${computed.modifiers[a]}</button>`).join("")}
          <button class="chip" data-perception>Perception ${computed.perception - 10 >= 0 ? "+" : ""}${computed.perception - 10}</button>
        </div>` : ""}
        <hr class="rule">
        <div class="field-row">
          <input type="text" id="dice-expr" placeholder="damage expression, e.g. 2d6+1" style="flex:1">
          <button class="btn" id="dice-expr-roll">Roll</button>
        </div>
      </div>
      <div class="dice-ledger">
        <h2 class="rubric">The Ledger of Lots <span class="count">${log.length} entries</span></h2>
        ${latest ? featuredEntry(latest) : ""}
        <div class="log" id="dice-log">
          ${rest.map(logEntry).join("") || (latest ? "" : `<p class="empty">The dice are silent.</p>`)}
        </div>
      </div>
    </div>
  </div>`;

  el.querySelectorAll("[data-die]").forEach((b) => b.addEventListener("click", () => {
    const sides = parseInt(b.dataset.die, 10);
    if (sides === 20) showToast(rollD20("d20"));
    else rollPlain(sides);
    renderDice(el);
  }));
  el.querySelector("#dice-boon").addEventListener("click", () => { diceState.boons++; renderDice(el); });
  el.querySelector("#dice-bane").addEventListener("click", () => { diceState.boons--; renderDice(el); });
  el.querySelectorAll("[data-attr]").forEach((b) => b.addEventListener("click", () => {
    showToast(rollD20(`${cap(b.dataset.attr)} challenge`, computed.modifiers[b.dataset.attr]));
    renderDice(el);
  }));
  el.querySelector("[data-perception]")?.addEventListener("click", () => {
    showToast(rollD20("Perception challenge", computed.perception - 10));
    renderDice(el);
  });
  const rollExpr = () => {
    const expr = el.querySelector("#dice-expr").value.trim();
    if (!expr) return;
    const entry = rollDamage(expr);
    if (entry) { showToast(entry); renderDice(el); }
  };
  el.querySelector("#dice-expr-roll").addEventListener("click", rollExpr);
  // Enter in the damage-expression field rolls it, matching the Roll button.
  el.querySelector("#dice-expr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); rollExpr(); }
  });

  if (!wired) {
    wired = true;
    onRoll(() => {
      const log = document.querySelector("#dice-log");
      if (log && el.closest(".active")) renderDice(el);
    });
  }
}

function logEntry(e) {
  return `
  <div class="log-entry ${e.crit ? "crit" : ""} ${e.fumble ? "fumble" : ""}">
    <span class="total">${e.total}</span> <b>${esc(e.label)}</b>
    <span class="dim small"> — ${esc(e.detail)}</span>
    <div class="when">${e.when.toLocaleTimeString()}</div>
  </div>`;
}

// The most recent roll, emphasized: an oversized total plus its full
// boon/bane (or damage) breakdown, which the entry's detail already carries.
function featuredEntry(e) {
  return `
  <div class="log-entry featured ${e.crit ? "crit" : ""} ${e.fumble ? "fumble" : ""}">
    <span class="total">${e.total}</span>
    <div class="featured-body">
      <b>${esc(e.label)}</b>
      <div class="dim small">${esc(e.detail)}${e.crit ? " — a natural 20!" : ""}${e.fumble ? " — a natural 1…" : ""}</div>
      <div class="when">${e.when.toLocaleTimeString()}</div>
    </div>
  </div>`;
}
