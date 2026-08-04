# Character Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "copy link" save mechanism — the active character gzip+base64url-encoded into the page URL fragment (`#c=...`); opening such a link offers to import the character. Spec: `docs/superpowers/specs/2026-08-04-share-links-design.md`.

**Architecture:** A new pure module `js/share.js` does encode/decode with the native `CompressionStream` API (no dependencies, node-testable). `js/main.js` wires a Share button and an on-load fragment check that funnels into the existing hardened `importCharacter()` in `js/state.js`. A data-revision stamp (`data/revision.json`, generated and checked by `scripts/validate_data.py`) rides along in links and file exports so imports against a different data snapshot warn the user.

**Tech Stack:** Vanilla ES modules, `node --test` (`js/ui/tests/*.test.mjs`), Python 3 stdlib for the validator. No new dependencies.

## Global Constraints

- Static site (GitHub Pages) — no server, no build step; everything runs from checked-in files.
- No new npm or pip dependencies.
- `npm test` must pass: `python3 scripts/validate_data.py && node scripts/build_samples.mjs && python3 -m unittest discover -s scripts/tests -t scripts/tests && python3 scripts/scan_parse_quality.py && node --test "js/ui/tests/*.test.mjs"`.
- All character-JSON validation stays in `importCharacter()` (js/state.js) — do not add a second validation path.
- User-visible strings interpolated into HTML must go through `esc()` (js/ui/util.js). `showToast` escapes `label`/`detail` but NOT `total` — only pass constant glyphs as `total`.
- Never commit PDFs or `scripts/cache/`. Never credit Claude in commits.
- Repo root (all paths below relative to it): `/Users/matthew/workspace/shadow-of-demon-lord-character/.claude/worktrees/reverent-heisenberg-fee9d6`.

---

### Task 1: `js/share.js` encode/decode module

**Files:**
- Create: `js/share.js`
- Test: `js/ui/tests/share.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module; uses globals `CompressionStream`, `DecompressionStream`, `Blob`, `Response`, `btoa`/`atob`, `TextEncoder`/`TextDecoder` — all present in browsers and Node ≥ 18).
- Produces (Task 3 and 4 rely on these exact signatures):
  - `shareSupported(): boolean`
  - `encodeShare(character: object): Promise<string>` — base64url payload, no `#c=` prefix
  - `decodeShare(payload: string): Promise<string>` — the JSON text; throws `Error("This link’s character data is damaged or incomplete.")` on any malformed payload

- [ ] **Step 1: Write the failing test**

Create `js/ui/tests/share.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { shareSupported, encodeShare, decodeShare } from "../../share.js";

// A realistic character shape (fields mirror engine.js newCharacter()).
const CHARACTER = {
  id: "0000-test", version: 2, name: "Syrah", ancestry: "Changeling",
  level: 1, damage: 0, insanityAdjust: 0, corruptionAdjust: 0,
  decisions: { "creation:prof:0": { pick: 3 }, "novice[Magician]:1:3:0": { pick: 0 } },
  expended: {}, inventory: [{ id: "it-1", name: "Staff", equipped: true }],
  wishlist: [], exchanges: [], log: [], coins: "5 ss", notes: "née “Vesper”\n— naïve",
  sizeChoice: null, dataRev: "abc123def456",
};

test("shareSupported is true where CompressionStream exists (node ≥ 18)", () => {
  assert.equal(shareSupported(), true);
});

test("encode → decode round-trips a character exactly", async () => {
  const payload = await encodeShare(CHARACTER);
  assert.deepEqual(JSON.parse(await decodeShare(payload)), CHARACTER);
});

test("payload uses only base64url characters (URL-fragment safe)", async () => {
  const payload = await encodeShare(CHARACTER);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
});

test("malformed payloads reject with a clean error", async () => {
  for (const bad of [
    "!!!not-base64url!!!",                       // illegal characters
    (await encodeShare(CHARACTER)).slice(0, 10), // truncated mid-stream
    "aGVsbG8",                                   // valid base64url, not gzip
    "",                                          // empty
  ]) {
    await assert.rejects(decodeShare(bad), /damaged or incomplete/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "js/ui/tests/share.test.mjs"`
Expected: FAIL — `Cannot find module '../../share.js'`

- [ ] **Step 3: Write the implementation**

Create `js/share.js`:

```js
// Character share links: gzip + base64url payloads for the URL fragment
// (#c=<payload>). Pure functions with no DOM access so node --test can
// exercise them directly; the same globals exist in browsers and Node ≥ 18.

// btoa/atob work on binary strings, so convert in chunks (spread would
// overflow the argument limit on large arrays; characters are ~1 KB, but
// stay safe).
const CHUNK = 0x8000;

function toBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function shareSupported() {
  return typeof CompressionStream !== "undefined"
    && typeof DecompressionStream !== "undefined";
}

export async function encodeShare(character) {
  const bytes = new TextEncoder().encode(JSON.stringify(character));
  return toBase64url(await pipe(bytes, new CompressionStream("gzip")));
}

export async function decodeShare(payload) {
  let bytes;
  try {
    bytes = await pipe(fromBase64url(payload), new DecompressionStream("gzip"));
  } catch {
    throw new Error("This link’s character data is damaged or incomplete.");
  }
  return new TextDecoder().decode(bytes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "js/ui/tests/share.test.mjs"`
Expected: PASS (4 tests). Note: the truncated-payload case must reject — gzip streams carry a trailing CRC, so a cut stream errors rather than silently returning partial JSON. If it resolves instead, the `pipe` error handling is wrong; do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add js/share.js js/ui/tests/share.test.mjs
git commit -m "Add gzip+base64url share-link encoding"
```

---

### Task 2: Data-revision stamp (`data/revision.json`)

**Files:**
- Modify: `scripts/validate_data.py` (add imports near line 15, new constants/functions after line 27, call in `main()` at line 140)
- Modify: `js/data.js` (`rules` literal at lines 3–23, `loadRules()` around line 55)
- Create (generated): `data/revision.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `data/revision.json` — `{"rev": "<12 lowercase hex chars>"}`
  - `rules.dataRev: string | null` on the exported `rules` object in `js/data.js` (Tasks 3 and 4 read this)
  - `python3 scripts/validate_data.py --write-revision` regenerates the stamp; without the flag the script fails if the stamp is stale/missing.

The stamp covers only the six files that character slot IDs resolve into positionally (`curated`, `spells`, `paths`, `traditions`, `equipment`, `creatures`) — NOT `samples.json` (rewritten by `build_samples.mjs` on every `npm test`) and not the spell sidecars (scores/tags/enrichment/combos), which don't affect replay.

- [ ] **Step 1: Add the revision check to `scripts/validate_data.py`**

Add `import hashlib` next to the existing `import json` (line 15). After the `EXPECTED_TRADITION_COUNT` constant (line 27), add:

```python
# Character slot IDs resolve positionally into these files, so an exported
# character is only exactly replayable against the same snapshot of them.
# Share links and file exports carry this stamp; the app warns on mismatch.
REVISION_FILES = ["curated.json", "spells.json", "paths.json",
                  "traditions.json", "equipment.json", "creatures.json"]


def compute_revision():
    h = hashlib.sha256()
    for name in REVISION_FILES:
        h.update(name.encode())
        h.update(b"\0")
        h.update((DATA / name).read_bytes())
    return h.hexdigest()[:12]


def check_revision():
    rev = compute_revision()
    path = DATA / "revision.json"
    if "--write-revision" in sys.argv:
        path.write_text(json.dumps({"rev": rev}) + "\n")
        print(f"wrote data/revision.json (rev {rev})")
        return
    try:
        committed = json.load(open(path)).get("rev")
    except (FileNotFoundError, json.JSONDecodeError):
        committed = None
    if committed != rev:
        fail(f"revision.json: committed stamp {committed!r} != computed {rev!r} — "
             "run: python3 scripts/validate_data.py --write-revision")
```

In `main()` (line 140), add `check_revision()` as the first line, before `spells = load("spells.json")`.

- [ ] **Step 2: Verify it fails while the stamp is missing**

Run: `python3 scripts/validate_data.py`
Expected: exit 1 with `✗ revision.json: committed stamp None != computed '...'`

- [ ] **Step 3: Generate the stamp, verify the check passes**

Run: `python3 scripts/validate_data.py --write-revision && python3 scripts/validate_data.py`
Expected: `wrote data/revision.json (rev …)` then the normal `✓ data OK …` line.

- [ ] **Step 4: Expose the stamp to the app in `js/data.js`**

Add to the `rules` object literal (after `creatures: [],` at line 13):

```js
  dataRev: null,             // data/revision.json stamp; exports/links carry it
```

In `loadRules()`, after the `rules.scores` fetch (ends line 55), add:

```js
  // Data-revision stamp for exports/share links. Optional: absent -> exports
  // simply carry no stamp and imports never warn.
  rules.dataRev = await fetch("data/revision.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && typeof j.rev === "string" ? j.rev : null))
    .catch(() => null);
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green, including the new revision check (and `build_samples.mjs` must NOT dirty the stamp — `git status` shows only the files you edited plus `data/revision.json`).

- [ ] **Step 6: Commit**

```bash
git add scripts/validate_data.py js/data.js data/revision.json
git commit -m "Stamp the data snapshot with a checked revision hash"
```

---

### Task 3: Share button — copy link to clipboard, stamp exports

**Files:**
- Modify: `index.html` (roster bar line 27, overflow menu line 44)
- Modify: `js/main.js` (imports lines 3–5, handlers around line 117, `setupOverflowMenu` lines 208–229)
- Modify: `js/state.js` (imports lines 3–4, `exportActive` line 81)

**Interfaces:**
- Consumes: `shareSupported`/`encodeShare` from `js/share.js` (Task 1), `rules.dataRev` (Task 2), existing `active()`/`showToast`.
- Produces: header button `#share-btn`, overflow item `#ov-share-btn`, and file exports / link payloads that carry a top-level `dataRev` string (Task 4 reads it back in `importCharacter`).

- [ ] **Step 1: Add the buttons to `index.html`**

After the Export button (line 27), before the Import button:

```html
    <button id="share-btn" class="btn btn-ghost" title="Copy a link that carries this character">Link</button>
```

In the overflow menu, after `ov-export-btn` (line 44):

```html
        <button id="ov-share-btn" class="ov-item" type="button">Copy Link</button>
```

- [ ] **Step 2: Stamp file exports in `js/state.js`**

Add to the imports (data.js has no local imports, so no cycle):

```js
import { rules } from "./data.js";
```

In `exportActive()` (line 81), change the blob line to include the stamp:

```js
  const blob = new Blob([JSON.stringify({ ...c, dataRev: rules.dataRev }, null, 2)], { type: "application/json" });
```

- [ ] **Step 3: Wire the copy-link flow in `js/main.js`**

Add to the imports at the top:

```js
import { rules } from "./data.js";          // extend the existing line 3 import
import { shareSupported, encodeShare } from "./share.js";
```

(Line 3 currently reads `import { loadRules } from "./data.js";` — make it `import { loadRules, rules } from "./data.js";`.)

In `boot()`, next to the other shared roster actions (after `importClick`, line 117):

```js
  // Copy a self-contained share link: the whole character rides in the URL
  // fragment, so the link works with no server and no account.
  const shareLink = async () => {
    const c = active();
    if (!c) return;
    const payload = await encodeShare({ ...c, dataRev: rules.dataRev });
    const url = `${location.href.split("#")[0]}#c=${payload}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast({ total: "🔗", label: "Link copied", detail: `Opening it imports a copy of ${c.name || "this soul"}.` });
    } catch {
      // Clipboard access denied (permissions, non-secure context): let the
      // user copy by hand instead of failing silently.
      prompt("Copy this share link:", url);
    }
  };
```

After the existing button wiring (line 122), add:

```js
  if (shareSupported()) {
    document.getElementById("share-btn").addEventListener("click", shareLink);
  } else {
    // Pre-2023 browsers lack CompressionStream: hide rather than break.
    document.getElementById("share-btn").hidden = true;
    document.getElementById("ov-share-btn").hidden = true;
  }
```

Change the `setupOverflowMenu` call (line 124) and signature (line 208) to pass `shareLink` through:

```js
  setupOverflowMenu({ newSoul, deleteSoul, importClick, shareLink });
```

```js
function setupOverflowMenu({ newSoul, deleteSoul, importClick, shareLink }) {
```

and inside it, after the `ov-export-btn` line (line 227):

```js
  document.getElementById("ov-share-btn").addEventListener("click", wrap(shareLink));
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev` (serves on :3000; or use the Claude browser preview).
- Click **Link** → toast "Link copied", clipboard holds `http://localhost:3000/#c=<payload>`; payload is a few hundred chars for a fresh character.
- Open the ⋯ overflow menu → **Copy Link** present and working, menu closes after.
- Click **Export** → downloaded JSON ends with a `"dataRev": "<12 hex>"` field.
- Console shows no errors.

- [ ] **Step 5: Run the suite (regression)**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add index.html js/main.js js/state.js
git commit -m "Add a share-link button that carries the character in the URL"
```

---

### Task 4: Import on link open — confirm, warn on revision mismatch

**Files:**
- Modify: `js/main.js` (`boot()` end, around line 140)
- Modify: `js/state.js` (`importCharacter`, lines 91–124)

**Interfaces:**
- Consumes: `decodeShare`/`shareSupported` (Task 1), `rules.dataRev` (Task 2), payload `dataRev` field (Task 3), existing `importCharacter`/`showToast`/`renderRoster`/`renderCurrent`.
- Produces: nothing further; this completes the feature.

- [ ] **Step 1: Teach `importCharacter` the revision stamp**

In `js/state.js` `importCharacter()`, after `c.name = uniqueName(c.name);` (line 119) and before `store.characters.push(c);`, add:

```js
  // Exports carry the data-revision stamp of the snapshot they were built
  // against (slot IDs resolve positionally into data/*.json). A mismatch is
  // survivable — the engine keeps orphaned decisions recoverable — but the
  // player should re-check their choices.
  if (typeof c.dataRev === "string" && rules.dataRev && c.dataRev !== rules.dataRev) {
    showToast({
      total: "⚠",
      label: "Different rules version",
      detail: `${c.name} was saved under another data revision — review their choices, some may have shifted.`,
    });
  }
  delete c.dataRev;
```

(`rules` is already imported from Task 3 Step 2. The `delete` keeps roster entries free of a stale stamp — exports re-stamp with the current revision.)

- [ ] **Step 2: Handle `#c=` fragments on load in `js/main.js`**

Add to the imports from `./share.js`: `decodeShare` (the line becomes `import { shareSupported, encodeShare, decodeShare } from "./share.js";`).

Add this function after `boot()` (before `setupSamples`, line 143):

```js
// A #c=<payload> fragment is a share link: offer to import the character it
// carries. Confirmation (never a silent add) keeps stray link opens from
// piling up duplicates; clearing the fragment keeps refresh from re-asking —
// the sender's bookmark retains its own copy of the URL.
async function maybeImportFromLink() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (!m) return;
  const clear = () => history.replaceState(null, "", location.pathname + location.search);
  if (!shareSupported()) {
    clear();
    showToast({ total: "✕", label: "Cannot open share link", detail: "This browser is too old to decode share links (no CompressionStream)." });
    return;
  }
  let json, preview;
  try {
    json = await decodeShare(m[1]);
    preview = JSON.parse(json);
    if (typeof preview?.ancestry !== "string" || !preview.ancestry.trim()) {
      throw new Error("not a character");
    }
  } catch {
    clear();
    showToast({ total: "✕", label: "Broken share link", detail: "This link’s character data is damaged or incomplete." });
    return;
  }
  clear();
  const name = preview.name || "Unnamed Soul";
  const level = Number.isFinite(preview.level) ? preview.level : 0;
  if (!confirm(`Import “${name}” (${preview.ancestry}, level ${level}) from this link?`)) return;
  try {
    importCharacter(json);
    renderRoster();
    renderCurrent();
  } catch (err) {
    showToast({ total: "✕", label: "Import failed", detail: err.message });
  }
}
```

At the end of `boot()`, after `setupSamples();` (line 140), add:

```js
  maybeImportFromLink();
```

- [ ] **Step 3: Verify in the browser**

With `npm run dev` still up:
- Copy a link for a character, open it in a new tab → confirm dialog names the character, ancestry, and level; **OK** adds a copy (unique-named if a clone exists) and selects it; the `#c=` fragment is gone from the address bar; refresh does NOT re-prompt.
- Open the same link and **Cancel** → nothing added, fragment cleared.
- Open `http://localhost:3000/#c=garbage` → "Broken share link" toast, fragment cleared, app usable.
- Hand-edit `data/revision.json`'s rev, reload, import a previously copied link → "Different rules version" warning toast appears, import still lands. Restore the real stamp afterwards (`python3 scripts/validate_data.py --write-revision`).

- [ ] **Step 4: Run the suite (regression)**

Run: `npm test`
Expected: all green (restore the revision stamp first if Step 3 left it edited).

- [ ] **Step 5: Commit**

```bash
git add js/main.js js/state.js
git commit -m "Import characters from share links with confirm and revision warning"
```
