import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The source-text guard in gate-coverage.test.mjs can only see call sites it
// knows to look for — it missed statblock.js entirely, and it still passed
// when the central predicate was forced open. This is the behavioural
// counterpart: render the real corpus with no consent and assert that not one
// withheld sentence reaches the output. It fails if a render site is added
// without the gate, and it fails if the gate itself is disabled.

globalThis.fetch = async (path) => {
  const text = await readFile(new URL("../../../" + path, import.meta.url), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};

const { loadRules, rules } = await import("../../data.js");
await loadRules();
const { setConsent, proseAllowed } = await import("../../consent.js");
const { spellCard } = await import("../spells.js");
const { statBlockHtml } = await import("../statblock.js");
const { levelBlock, haystack } = await import("../paths.js");

setConsent(false);

// Only sentences are interesting. Short mechanical values ("1 minute", "10")
// collide with ordinary markup and are deliberately not gated.
const SENTENCE = 25;
const sentences = (...vals) =>
  vals.flat(Infinity).filter((v) => typeof v === "string" && v.length >= SENTENCE);

const flat = (j) => (Array.isArray(j) ? j : Object.values(j).flat());
const gated = (book) => !proseAllowed(book);

function assertNoLeak(html, prose, what) {
  const leaked = prose.filter((line) => html.includes(line));
  assert.deepEqual(leaked, [], `${what} leaked ${leaked.length} withheld line(s), first: ${leaked[0]?.slice(0, 80)}`);
}

test("no withheld spell prose reaches a spell card", () => {
  const spells = flat(rules.spells).filter((s) => gated(s.source));
  assert.ok(spells.length > 100, `expected a large gated spell set, got ${spells.length}`);
  for (const s of spells) {
    const prose = sentences(s.description, s.area, s.target, s.requirement,
      (s.tables || []).map((t) => t.rows.flat()));
    assertNoLeak(spellCard(s), prose, `spell ${s.name}`);
  }
});

test("no withheld creature prose reaches a stat block", () => {
  const creatures = flat(rules.creatures).filter((c) => gated(c.book));
  assert.ok(creatures.length > 0, "expected gated creatures in the corpus");
  for (const cr of creatures) {
    const prose = sentences(cr.descriptor, cr.perception, cr.defense_line, cr.attributes,
      cr.speed, cr.traits, cr.attack_options, cr.special_attacks, cr.special_actions,
      cr.end_of_round, cr.magic);
    assertNoLeak(statBlockHtml(cr), prose, `creature ${cr.name}`);
  }
});

test("no withheld path prose reaches a level block or the search haystack", () => {
  const paths = flat(rules.paths).filter((p) => gated(p.source));
  assert.ok(paths.length > 50, `expected a large gated path set, got ${paths.length}`);
  for (const p of paths) {
    const hay = haystack(p);
    for (const [lvl, e] of Object.entries(p.levels || {})) {
      const prose = sentences(
        (e.talents || []).map((t) => [t.text, (t.tables || []).map((tb) => tb.rows.flat())]),
        (e.talents || []).flatMap((t) => (t.stat_blocks || []).map((cr) =>
          [cr.descriptor, cr.perception, cr.defense_line, cr.attributes, cr.speed,
           cr.traits, cr.attack_options, cr.special_attacks, cr.special_actions,
           cr.end_of_round, cr.magic])),
        e.magic?.raw, e.languages_professions);
      assertNoLeak(levelBlock(lvl, e, p.source), prose, `path ${p.name} level ${lvl}`);
      // The haystack is lowercased; a withheld sentence must not be matchable.
      const inHay = prose.filter((line) => hay.includes(line.toLowerCase()));
      assert.deepEqual(inHay, [], `path ${p.name} search leaked: ${inHay[0]?.slice(0, 80)}`);
    }
  }
});

test("consent lets the same corpus through, so the scan is measuring the gate", () => {
  setConsent(true);
  const s = flat(rules.spells).find((x) => x.source === "occult" && x.description?.length > SENTENCE);
  assert.ok(spellCard(s).includes(s.description), "consent should reveal spell prose");
  const cr = flat(rules.creatures).find((x) => x.book === "occult" && x.traits?.length);
  assert.ok(statBlockHtml(cr).includes(cr.traits[0]), "consent should reveal creature prose");
  setConsent(false);
});
