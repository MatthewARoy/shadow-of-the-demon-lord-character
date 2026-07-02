// Roll result toasts — stacked so consecutive rolls (attack, then damage)
// each stay readable for their full lifetime.

import { esc } from "./util.js";

const LIFETIME = 4000;

export function showToast(entry) {
  const box = document.getElementById("roll-toast");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `
    <span class="total">${entry.total}</span>
    <b>${esc(entry.label)}</b>
    <div class="detail">${esc(entry.detail)}${entry.crit ? " — a natural 20!" : ""}${entry.fumble ? " — a natural 1…" : ""}</div>`;
  box.appendChild(t);
  // The live region stays permanently in the accessibility tree (never
  // `hidden`) so inserted toasts are reliably announced; it's empty and
  // pointer-transparent between rolls, so nothing blocks the page.
  setTimeout(() => {
    t.remove();
  }, LIFETIME);
}
