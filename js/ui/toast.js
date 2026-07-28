// Roll result toasts — stacked so consecutive rolls (attack, then damage)
// each stay readable for their full lifetime.

import { esc } from "./util.js";

const LIFETIME = 4000;
// Courtesy toasts that offer an Undo (or other) action linger longer so the
// action stays reachable.
const ACTION_LIFETIME = 8000;

// `entry` carries the roll fields (total, label, detail, crit, fumble).
// `opts.action`, when present, appends a button: { label, onClick }. The
// button dismisses the toast when pressed and invokes onClick. Existing
// call sites pass no opts and render exactly as before.
export function showToast(entry, opts = {}) {
  const box = document.getElementById("roll-toast");
  if (!box) return;
  const action = opts.action;
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `
    <span class="total">${entry.total}</span>
    <b>${esc(entry.label)}</b>
    <div class="detail">${esc(entry.detail)}${entry.crit ? " — a natural 20!" : ""}${entry.fumble ? " — a natural 1…" : ""}</div>
    ${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ""}`;
  box.appendChild(t);
  if (action) {
    t.querySelector(".toast-action").addEventListener("click", () => {
      t.remove();
      action.onClick();
    });
  }
  // The live region stays permanently in the accessibility tree (never
  // `hidden`) so inserted toasts are reliably announced; it's empty and
  // pointer-transparent between rolls, so nothing blocks the page.
  setTimeout(() => {
    t.remove();
  }, action ? ACTION_LIFETIME : LIFETIME);
}
