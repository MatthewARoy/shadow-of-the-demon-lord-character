// Shared UI helpers.

// Escape text for interpolation into innerHTML — element content and
// double-quoted attribute values.
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A random table printed inside a spell or a talent — the d6 a wild magic
// caster rolls, the sigil durations a wardscribe reads off by spell rank.
// The entry's own text ends on "...as shown on the following table", so
// without this the rules are unresolvable at the table. Rendered the same way
// in both the Spells and the Paths browsers, hence living here.
export function rulesTable(t) {
  if (!t?.rows?.length) return "";
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

export const rulesTables = (tables) => (tables || []).map(rulesTable).join("");
