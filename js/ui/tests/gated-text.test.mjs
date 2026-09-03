import test from "node:test";
import assert from "node:assert/strict";
import { gatedText, searchableText, esc } from "../util.js";
import { setConsent } from "../../consent.js";

const PROSE = 'Verbatim <rulebook> prose & "flavour".';

test.beforeEach(() => setConsent(false));

test("core prose renders escaped, exactly as esc() would", () => {
  assert.equal(gatedText(PROSE, "core"), esc(PROSE));
});

test("gated prose never reaches the markup", () => {
  const html = gatedText(PROSE, "occult");
  assert.ok(!html.includes("Verbatim"), "raw prose leaked into the gated render");
  assert.ok(!html.includes("flavour"), "raw prose leaked into the gated render");
});

test("gated prose renders a labelled placeholder the reader can act on", () => {
  const html = gatedText(PROSE, "occult");
  assert.match(html, /data-consent-gate/, "placeholder should be targetable for the consent prompt");
});

test("consent turns gated prose back into ordinary escaped text", () => {
  setConsent(true);
  assert.equal(gatedText(PROSE, "occult"), esc(PROSE));
});

test("gated prose stays escaped once revealed (no XSS regression)", () => {
  setConsent(true);
  assert.ok(!gatedText('<img src=x onerror="alert(1)">', "occult").includes("<img"));
});

test("unknown provenance is gated like a supplement", () => {
  assert.ok(!gatedText(PROSE, undefined).includes("Verbatim"));
});

test("searchableText hides gated prose from the matcher", () => {
  assert.equal(searchableText(PROSE, "occult"), "");
  assert.equal(searchableText(PROSE, "core"), PROSE);
  setConsent(true);
  assert.equal(searchableText(PROSE, "occult"), PROSE);
});
