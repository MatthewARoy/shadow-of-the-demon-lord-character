import test from "node:test";
import assert from "node:assert/strict";

import { statBlockHtml } from "../statblock.js";
import { haystack } from "../paths.js";
import { setConsent } from "../../consent.js";

// A summoned creature's stat block is rulebook prose like any other. It
// reaches the page two ways: the summon buttons on a spell card, and the
// <details> block attached to a path talent. Both were ungated.
const OCCULT_SPIRIT = {
  name: "Raven Spirit", book: "occult", page: 163,
  descriptor: "1/2 spirit", perception: "14 (+4)",
  defense_line: "Defense 13; Health 16; Insanity —; Corruption 0",
  attributes: "Strength 8 (–2), Agility 13 (+3), Intellect 8 (–2), Will 11 (+1)",
  speed: "10; flier (swoop)",
  traits: ["Immune damage from disease or poison"],
  attack_options: ["Talons (melee) +3 with 1 boon (1d6 + 1)"],
  special_attacks: ["Shriek of the outer dark"], special_actions: [], end_of_round: [], magic: [],
};
const CORE_BEAST = { ...OCCULT_SPIRIT, name: "Wolf", book: "core", page: 200 };

const PROSE_OF = (cr) => [
  cr.descriptor, cr.perception, cr.defense_line, cr.attributes, cr.speed,
  ...cr.traits, ...cr.attack_options, ...cr.special_attacks,
];

test.beforeEach(() => setConsent(false));

test("a supplement stat block leaks none of its prose while gated", () => {
  const html = statBlockHtml(OCCULT_SPIRIT);
  for (const line of PROSE_OF(OCCULT_SPIRIT)) {
    assert.ok(!html.includes(line), `leaked: ${line}`);
  }
});

test("a gated stat block still names itself and cites its page", () => {
  const html = statBlockHtml(OCCULT_SPIRIT);
  assert.match(html, /Raven Spirit/, "the name is a label, not prose");
  assert.match(html, /163/, "the citation tells the reader which book to own");
  assert.match(html, /data-consent-gate/, "and offers the way to unlock it");
});

test("a core stat block is untouched by the gate", () => {
  const html = statBlockHtml(CORE_BEAST);
  for (const line of PROSE_OF(CORE_BEAST)) {
    assert.ok(html.includes(line), `core stat block should show: ${line}`);
  }
});

test("consent restores the whole supplement stat block", () => {
  setConsent(true);
  const html = statBlockHtml(OCCULT_SPIRIT);
  for (const line of PROSE_OF(OCCULT_SPIRIT)) {
    assert.ok(html.includes(line), `should be shown after consent: ${line}`);
  }
});

test("a stat block with no provenance fails closed", () => {
  const { book, ...orphan } = OCCULT_SPIRIT;
  const html = statBlockHtml(orphan);
  assert.ok(!html.includes(orphan.defense_line), "unknown provenance must not render prose");
});

// The search haystack is the second leak: a phrase unique to a withheld stat
// block must not surface the path that carries it.
const pathWith = (cr) => ({
  name: "Spiritcaller", source: cr.book, description: "An animal-spirit guide.",
  levels: { 6: { talents: [{ name: "Spirit Guide", text: "You forge a bond.", stat_blocks: [cr] }] } },
});

test("gated stat block prose is not searchable", () => {
  const text = haystack(pathWith(OCCULT_SPIRIT));
  assert.ok(!text.includes("talons (melee)"), "attack line leaked into the haystack");
  assert.ok(!text.includes("shriek of the outer dark"), "special attack leaked into the haystack");
  assert.ok(text.includes("raven spirit"), "the creature's name stays findable");
});

test("core stat block prose stays searchable", () => {
  const text = haystack(pathWith(CORE_BEAST));
  assert.ok(text.includes("talons (melee)"), "core stat blocks must remain searchable");
});

test("consent makes gated stat block prose searchable again", () => {
  setConsent(true);
  assert.ok(haystack(pathWith(OCCULT_SPIRIT)).includes("talons (melee)"));
});
