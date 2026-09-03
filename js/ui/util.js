// Shared UI helpers.

import { proseAllowed } from "../consent.js";

// Escape text for interpolation into innerHTML — element content and
// double-quoted attribute values.
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- Rulebook-content consent gate -----------------------------------------
// Prose from the supplements is withheld until the reader affirms they own
// those books. `book` is the provenance already carried on the data (`source`
// on spells/paths/traditions, `book` on creatures and combat entries).
// Render helper: returns escaped HTML — either the prose itself, or a
// placeholder the reader can click to open the consent prompt.
export const gatedText = (text, book) =>
  proseAllowed(book)
    ? esc(text)
    : `<span class="gated" data-consent-gate role="button" tabindex="0" title="Confirm you own this book to read its text">Text withheld — tap to confirm you own this book</span>`;

// Search helper: gated prose must not be matchable either, or the gate leaks
// through result snippets and hit counts.
export const searchableText = (text, book) => (proseAllowed(book) ? String(text ?? "") : "");
