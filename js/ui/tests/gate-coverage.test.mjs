import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// A gate is only as good as its least-wrapped render site, and new prose gets
// rendered as the app grows. These tests fail when a raw prose field reaches
// the markup without passing through gatedText().

const UI_DIR = new URL("../", import.meta.url);

async function uiSources() {
  const names = (await readdir(UI_DIR)).filter((n) => n.endsWith(".js") && n !== "util.js");
  return Promise.all(names.map(async (n) => [n, await readFile(new URL(n, UI_DIR), "utf8")]));
}

test("no render site escapes a .description without the gate", async () => {
  const offenders = [];
  for (const [name, src] of await uiSources()) {
    for (const m of src.matchAll(/esc\(\s*[A-Za-z_$][\w$]*(?:\?)?\.description/g)) {
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `use gatedText(…, book) instead:\n${offenders.join("\n")}`);
});

test("no render site escapes a rules-index body without the gate", async () => {
  const offenders = [];
  for (const [name, src] of await uiSources()) {
    for (const m of src.matchAll(/esc\(\s*[A-Za-z_$][\w$]*(?:\?)?\.x\b/g)) offenders.push(`${name}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});

// Pinning tests: the engine hands prose to the sheet through these fields, so
// name them explicitly rather than trusting a regex to spot every shape.
test("the sheet gates talents, traits and notes", async () => {
  const src = await readFile(new URL("sheet.js", UI_DIR), "utf8");
  for (const call of ["gatedText(t.text, t.book)", "gatedText(n.text, n.book)"]) {
    assert.ok(src.includes(call), `sheet.js should contain ${call}`);
  }
});

test("every module that renders book prose imports the gate", async () => {
  const expected = ["spells.js", "paths.js", "builder.js", "sheet.js", "combat.js", "lookup.js"];
  for (const name of expected) {
    const src = await readFile(new URL(name, UI_DIR), "utf8");
    assert.match(src, /import \{[^}]*gatedText[^}]*\} from "\.\/util\.js"/, `${name} should import gatedText`);
  }
});

// Rules tables and path catalogs arrived after the gate did; they are rulebook
// text too, so they must not be rendered or searched raw.
test("rules tables are rendered through the gate, never raw", async () => {
  const offenders = [];
  for (const [name, src] of await uiSources()) {
    for (const m of src.matchAll(/rulesTables?\(\s*[^,)]+\)/g)) offenders.push(`${name}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `rulesTables() needs a book argument:\n${offenders.join("\n")}`);
});

test("catalog entry text is gated", async () => {
  const src = await readFile(new URL("paths.js", UI_DIR), "utf8");
  assert.ok(src.includes("gatedText(e.text, book)"), "catalog entries should be gated");
  assert.ok(!/esc\(\s*e\.text\s*\)/.test(src), "catalog entries should not be escaped raw");
});

// Area, target and requirement read as sentences lifted from the page
// ("A shapeable line, 5 yards long, … that originates from a point within
// short range"), not as numbers, so they belong behind the gate with the
// description. Duration ("1 minute") genuinely is a parameter and stays open.
test("a spell's sentence-shaped metadata is not rendered raw", async () => {
  const src = await readFile(new URL("spells.js", UI_DIR), "utf8");
  const offenders = [];
  for (const field of ["area", "target", "requirement"]) {
    for (const m of src.matchAll(new RegExp(`esc\\(\\s*s\\.${field}\\s*\\)`, "g"))) offenders.push(m[0]);
    if (src.includes(`stats.push(["${field[0].toUpperCase()}${field.slice(1)}", s.${field}])`)) {
      offenders.push(`stats.push raw s.${field}`);
    }
  }
  assert.deepEqual(offenders, [], `gate these:\n${offenders.join("\n")}`);
});
