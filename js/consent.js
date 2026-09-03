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

// --- persistence -----------------------------------------------------------
// The storage is a parameter so node --test can exercise this, and so a
// browser with storage blocked degrades to "not consented" instead of
// throwing during boot.

export const CONSENT_KEY = "sotdl_book_consent_v1";

const defaultStorage = () => (typeof localStorage === "undefined" ? null : localStorage);

export function hydrateConsent(storage = defaultStorage()) {
  let stored = null;
  try {
    stored = storage?.getItem(CONSENT_KEY) ?? null;
  } catch {
    stored = null;   // private mode, blocked cookies, storage quota
  }
  setConsent(stored === "granted");
}

export function persistConsent(value, storage = defaultStorage()) {
  setConsent(value);
  try {
    if (value) storage?.setItem(CONSENT_KEY, "granted");
    else storage?.removeItem(CONSENT_KEY);
  } catch {
    // A reader who cannot persist the grant still gets it for this session.
  }
}
