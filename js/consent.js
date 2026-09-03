// Rulebook-content consent gate.
//
// The app ships the full parsed corpus, but the prose from the supplements is
// only rendered once the reader affirms they own those books. Provenance is
// already on the data (`source` on spells/paths/traditions, `book` on
// creatures and combat entries), so the gate is a render-time predicate: the
// engine and path scoring keep seeing complete data, and only display is
// withheld. See js/ui/util.js gatedText() for the render-site helper.
//
// No DOM access here, so node --test can exercise it directly; main.js
// hydrates the flag from localStorage at boot.

export const GATED_BOOKS = new Set(["occult", "dlc2", "terrible"]);

// Allowlist, so a book added to the corpus later is gated until someone says
// otherwise rather than leaking on the day its parser lands.
export const UNGATED_BOOKS = new Set(["core"]);

let consented = false;

export function consentGranted() {
  return consented;
}

export function setConsent(value) {
  consented = value === true;
}

// Fail closed: anything whose provenance the parser did not record is treated
// as gated rather than assumed to be core.
export function proseAllowed(book) {
  if (consented) return true;
  return UNGATED_BOOKS.has(book);
}
