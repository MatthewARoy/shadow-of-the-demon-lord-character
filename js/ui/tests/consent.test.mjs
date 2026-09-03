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

test("GATED_BOOKS names exactly the three supplements", () => {
  assert.deepEqual([...GATED_BOOKS].sort(), ["dlc2", "occult", "terrible"]);
});
