// Renders a parsed creature stat block, parchment-style.

import { esc, gatedText } from "./util.js";
import { proseAllowed } from "../consent.js";
import { bookName } from "../data.js";

const SECTIONS = [
  ["attack_options", "Attack Options"],
  ["special_attacks", "Special Attacks"],
  ["special_actions", "Special Actions"],
  ["end_of_round", "End of the Round"],
  ["magic", "Magic"],
];

export function statBlockHtml(cr) {
  const template = cr.kind === "template";
  const adjustment = cr.difficulty_adjustment;
  const difficulty = template && Number.isFinite(adjustment)
    ? `Difficulty ${adjustment < 0 ? "−" : "+"}${Math.abs(adjustment)} step`
    : cr.difficulty ? `Difficulty ${esc(cr.difficulty)}` : null;
  // A creature's lines are rulebook prose. Withheld, the block keeps its name
  // and citation — those are labels, and they tell the reader which book to
  // own — and offers the consent prompt in place of the body.
  const open = proseAllowed(cr.book);
  const head = !open ? [] : [
    cr.descriptor ? template ? esc(cr.descriptor) : `Size ${esc(cr.descriptor)}` : null,
    cr.perception ? `Perception ${esc(cr.perception)}` : null,
    cr.defense_line ? esc(cr.defense_line) : null,
    cr.attributes ? esc(cr.attributes) : null,
    cr.speed ? `Speed ${esc(cr.speed)}` : null,
  ].filter(Boolean);
  return `
  <div class="statblock">
    <div class="sb-head">
      <b>${esc(cr.name)}</b>
      ${difficulty ? `<span class="sb-diff">${template ? "Template · " : ""}${difficulty}</span>` : ""}
      <span class="small dim">${bookName(cr.book)} · p.${cr.page}</span>
    </div>
    ${head.map((h) => `<div class="sb-line">${h}</div>`).join("")}
    ${!open ? `<p class="sb-item">${gatedText("", cr.book)}</p>` : `
    ${cr.traits.map((t) => `<p class="sb-item">${esc(t)}</p>`).join("")}
    ${SECTIONS.map(([k, label]) => cr[k]?.length ? `
      <div class="sb-section">${label}</div>
      ${cr[k].map((t) => `<p class="sb-item">${esc(t)}</p>`).join("")}` : "").join("")}`}
  </div>`;
}
