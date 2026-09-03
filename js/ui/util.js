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

// A random table printed inside a spell or a talent — the d6 a wild magic
// caster rolls, the sigil durations a wardscribe reads off by spell rank.
// The entry's own text ends on "...as shown on the following table", so
// without this the rules are unresolvable at the table. Rendered the same way
// in both the Spells and the Paths browsers, hence living here.
//
// The rows are rulebook text like any other, so they take the same gate as
// the prose they belong to.
export function rulesTable(t, book) {
  if (!t?.rows?.length) return "";
  if (!proseAllowed(book)) return "";
  const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = t.rows
    .map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="rules-table-wrap">
    <table class="rules-table">
      ${t.caption ? `<caption>${esc(t.caption)}</caption>` : ""}
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

export const rulesTables = (tables, book) => (tables || []).map((t) => rulesTable(t, book)).join("");

// The flattened text of a set of tables, for search. Empty when gated, so a
// withheld table cannot be found by a phrase only it contains.
export const tablesSearchText = (tables, book) =>
  proseAllowed(book) ? (tables || []).flatMap((tb) => tb.rows.flat()).join(" ") : "";
