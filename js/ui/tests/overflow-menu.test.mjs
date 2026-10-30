import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// On desktop the ⋯ menu holds only the items with no button of their own.
// With all of them hidden (no CompressionStream, no Book Text consent, not in
// a party) it would open empty, so main.js marks body.overflow-empty and the
// desktop stylesheet drops the button. main.js boots on import and there is
// no DOM under node, so this pins the wiring: the rule's place in the
// stylesheet, the item list against the markup, and the observer that keeps
// the class current.

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
const [css, main, html] = await Promise.all([read("css/app.css"), read("js/main.js"), read("index.html")]);

// The first `@media <query> { … }` block, braces balanced.
function mediaBlock(source, query) {
  const start = source.indexOf(`@media ${query} {`);
  assert.notEqual(start, -1, `no @media ${query} block`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced @media ${query} block`);
}

const RULE = /body\.overflow-empty \.roster-overflow\s*\{\s*display:\s*none;\s*\}/;
const desktop = mediaBlock(css, "(min-width: 721px)");

test("the desktop stylesheet hides an empty ⋯ menu, and only on desktop", () => {
  assert.match(desktop, RULE);
  assert.equal(css.match(new RegExp(RULE.source, "g")).length, 1, "the phone layout keeps its ⋯ button");
});

test("main.js checks exactly the menu items desktop shows, and keeps the class current", () => {
  const list = main.match(/const DESKTOP_MENU_ITEMS = (\[[^\]]*\]);/);
  assert.ok(list, "main.js names the desktop menu items");
  const checked = JSON.parse(list[1].replace(/,\s*\]$/, "]"));
  // Every ⋯ button, less the ones the desktop rule hides (they have a
  // desktop button of their own).
  const buttons = [...html.matchAll(/<button id="(ov-[\w-]+)" class="ov-item/g)].map((m) => m[1]);
  const hiddenOnDesktop = new Set([...desktop.matchAll(/#(ov-[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...checked].sort(), buttons.filter((id) => !hiddenOnDesktop.has(id)).sort());
  assert.match(main, /classList\.toggle\("overflow-empty"/);
  assert.match(main, /\.observe\(menu, \{[^}]*attributeFilter: \["hidden"\][^}]*\}\)/);
  assert.match(main, /\.observe\(menu, \{[^}]*subtree: true[^}]*\}\)/);
});
