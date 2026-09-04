import test from "node:test";
import assert from "node:assert/strict";
import { proseAllowed, setConsent, consentGranted, GATED_BOOKS } from "../../consent.js";

// Every test starts from the un-consented default; setConsent is module state,
// not localStorage, so these run under node with no DOM.
test.beforeEach(() => setConsent(false));

test("core prose is always readable, with or without consent", () => {
  assert.equal(proseAllowed("core"), true);
  setConsent(true);
  assert.equal(proseAllowed("core"), true);
});

test("supplement prose is withheld until consent is given", () => {
  for (const book of ["occult", "dlc2", "terrible"]) {
    assert.equal(proseAllowed(book), false, `${book} should be gated`);
  }
});

test("consent reveals every gated book at once", () => {
  setConsent(true);
  for (const book of ["occult", "dlc2", "terrible"]) {
    assert.equal(proseAllowed(book), true, `${book} should be readable`);
  }
});

test("withdrawing consent re-gates the supplements", () => {
  setConsent(true);
  setConsent(false);
  assert.equal(proseAllowed("occult"), false);
});

// Fail closed: an entry whose provenance the parser did not record must not
// leak on the assumption that it is core.
test("unknown or missing provenance is gated, not assumed core", () => {
  for (const book of [undefined, null, "", "unheard-of-tome", 7]) {
    assert.equal(proseAllowed(book), false, `${String(book)} should be gated`);
  }
});

test("consentGranted reports the current flag", () => {
  assert.equal(consentGranted(), false);
  setConsent(true);
  assert.equal(consentGranted(), true);
});

// Text the app writes itself — equipment warnings, "pick again" diagnostics —
// is nobody's copyright and must never be withheld.
test("app-authored text is never gated", () => {
  setConsent(false);
  assert.equal(proseAllowed("app"), true);
});

test("GATED_BOOKS names exactly the three supplements", () => {
  assert.deepEqual([...GATED_BOOKS].sort(), ["dlc2", "occult", "terrible"]);
});

// --- persistence -----------------------------------------------------------
// Storage is injected so this runs under node, and so a browser that blocks
// localStorage degrades to "not consented" rather than throwing on boot.
import { hydrateConsent, persistConsent, CONSENT_KEY } from "../../consent.js";

const fakeStore = (initial = {}) => {
  const map = { ...initial };
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
    _map: map,
  };
};

test("hydrateConsent restores a previously granted consent", () => {
  setConsent(false);
  hydrateConsent(fakeStore({ [CONSENT_KEY]: "granted" }));
  assert.equal(consentGranted(), true);
});

test("hydrateConsent leaves consent off when nothing is stored", () => {
  setConsent(true);
  hydrateConsent(fakeStore());
  assert.equal(consentGranted(), false);
});

test("hydrateConsent treats an unrecognised stored value as no consent", () => {
  setConsent(true);
  hydrateConsent(fakeStore({ [CONSENT_KEY]: "maybe" }));
  assert.equal(consentGranted(), false);
});

test("a storage that throws leaves the reader un-consented rather than crashing", () => {
  setConsent(true);
  const hostile = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => hydrateConsent(hostile));
  assert.equal(consentGranted(), false);
  assert.doesNotThrow(() => persistConsent(true, hostile));
});

test("persistConsent writes the grant and clears it on withdrawal", () => {
  const store = fakeStore();
  persistConsent(true, store);
  assert.equal(store.getItem(CONSENT_KEY), "granted");
  assert.equal(consentGranted(), true);
  persistConsent(false, store);
  assert.equal(store.getItem(CONSENT_KEY), null);
  assert.equal(consentGranted(), false);
});
