// The consent prompt for supplement prose.
//
// The predicate and its persistence live in js/consent.js (DOM-free, so
// node --test can reach them); this module is the browser half: the modal,
// the delegated click on gated placeholders, and the re-render afterwards.

import { consentGranted, persistConsent, GATED_BOOKS } from "../consent.js";
import { esc } from "./util.js";

const BOOK_TITLES = {
  occult: "Occult Philosophy",
  dlc2: "Demon Lord’s Companion 2",
  terrible: "Terrible Beauty",
};

const titles = () => [...GATED_BOOKS].map((b) => BOOK_TITLES[b] || b);

let el = null;
let returnFocus = null;
let onGrant = () => {};

function boxHtml() {
  const list = titles().map((t) => `<em>${esc(t)}</em>`).join(", ");
  return `
  <div class="consent-box" role="dialog" aria-modal="true" aria-labelledby="consent-h" tabindex="-1">
    <h2 id="consent-h" class="rubric">Whose books are these?</h2>
    <p>The text withheld here is from ${list}. This app carries the rules it needs
       to build a character, but the wording belongs to its publisher.</p>
    <p class="small dim">Confirm you own these books and their text will be shown. You are
       responsible for your use of this content. You can withdraw this at any time from the
       ⋯ menu.</p>
    <div class="consent-actions">
      <button class="btn" data-consent-cancel>Not now</button>
      <button class="btn btn-resolve" data-consent-accept>I own these books</button>
    </div>
  </div>`;
}

function ensureEl() {
  if (el) return el;
  el = document.createElement("div");
  el.className = "consent-modal";
  el.hidden = true;
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-consent-cancel]")) close();
    else if (e.target.closest("[data-consent-accept]")) accept();
  });
  document.addEventListener("keydown", (e) => {
    if (el.hidden) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the dialog, matching the spell modal's trap.
    const box = el.querySelector(".consent-box");
    const items = [...box.querySelectorAll("button")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const inside = box.contains(document.activeElement) ? document.activeElement : null;
    if (e.shiftKey && (inside === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (inside === last || !inside)) { e.preventDefault(); first.focus(); }
  });
  document.body.appendChild(el);
  return el;
}

export function openConsentPrompt(trigger) {
  const m = ensureEl();
  returnFocus = trigger || document.activeElement;
  m.innerHTML = boxHtml();
  m.hidden = false;
  m.querySelector("[data-consent-accept]")?.focus();
}

function close() {
  if (!el || el.hidden) return;
  el.hidden = true;
  const back = returnFocus;
  returnFocus = null;
  if (back && typeof back.focus === "function") back.focus();
}

function accept() {
  persistConsent(true);
  close();
  onGrant();
}

// Withdrawing is deliberately not a modal — it is a menu action.
export function withdrawConsent() {
  persistConsent(false);
  onGrant();
}

export function consentIsGranted() {
  return consentGranted();
}

// One delegated listener covers every gated placeholder, present and future —
// the tabs re-render constantly, so per-element handlers would leak.
export function wireConsentGate(rerender) {
  onGrant = rerender || (() => {});
  document.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-consent-gate]");
    if (hit) openConsentPrompt(hit);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const hit = e.target.closest?.("[data-consent-gate]");
    if (hit) { e.preventDefault(); openConsentPrompt(hit); }
  });
}
