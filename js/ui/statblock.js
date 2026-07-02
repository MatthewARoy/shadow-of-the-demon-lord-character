// Renders a parsed creature stat block, parchment-style.

import { esc } from "./util.js";

const SECTIONS = [
  ["attack_options", "Attack Options"],
  ["special_attacks", "Special Attacks"],
  ["special_actions", "Special Actions"],
  ["end_of_round", "End of the Round"],
  ["magic", "Magic"],
];

export function statBlockHtml(cr) {
  const head = [
    cr.descriptor ? `Size ${esc(cr.descriptor)}` : null,
    cr.perception ? `Perception ${esc(cr.perception)}` : null,
    cr.defense_line ? esc(cr.defense_line) : null,
    cr.attributes ? esc(cr.attributes) : null,
    cr.speed ? `Speed ${esc(cr.speed)}` : null,
  ].filter(Boolean);
  return `
  <div class="statblock">
    <div class="sb-head">
      <b>${esc(cr.name)}</b>
      <span class="sb-diff">Difficulty ${esc(cr.difficulty)}</span>
      <span class="small dim">${cr.book === "core" ? "Core Rulebook" : "Occult Philosophy"} · p.${cr.page}</span>
    </div>
    ${head.map((h) => `<div class="sb-line">${h}</div>`).join("")}
    ${cr.traits.map((t) => `<p class="sb-item">${esc(t)}</p>`).join("")}
    ${SECTIONS.map(([k, label]) => cr[k]?.length ? `
      <div class="sb-section">${label}</div>
      ${cr[k].map((t) => `<p class="sb-item">${esc(t)}</p>`).join("")}` : "").join("")}
  </div>`;
}
