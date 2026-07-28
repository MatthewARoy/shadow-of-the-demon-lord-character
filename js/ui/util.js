// Shared UI helpers.

// Escape text for interpolation into innerHTML — element content and
// double-quoted attribute values.
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
