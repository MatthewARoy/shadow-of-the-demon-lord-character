# Character share links — design

**Date:** 2026-08-04
**Status:** Approved

## Goal

A simple, transportable way to save a character: a URL you can paste into a
note, chat, or bookmark. Opening the link imports the character. No server —
the site is static (GitHub Pages).

This is the "URL-fragment share links" rung of the storage ladder agreed in
July 2026. The GitHub-issue mechanism was evaluated then and rejected (issues
are public and spam-prone, visitors lack write tokens, and a static site
cannot hold a secret for OAuth). Later rungs (roster-level backup file, Gist
sync via user-supplied PAT) remain out of scope here.

## Link format

```
<page-url>#c=<base64url(gzip(JSON.stringify(character)))>
```

- Characters measure ≤~1 KB after gzip+base64, comfortably inside URL limits.
- Compression uses the native `CompressionStream("gzip")` /
  `DecompressionStream` APIs — no dependencies.
- base64url alphabet (`-`/`_`, no padding) so the fragment never needs
  percent-encoding.

## Components

### `js/share.js` (new, pure, node-testable)

- `encodeShare(character) → Promise<string>` — serialize, gzip, base64url.
- `decodeShare(fragment) → Promise<string>` — reverse; returns the JSON
  string, which callers feed to the existing `importCharacter()` in
  `js/state.js`. All validation stays in `importCharacter` (the hardened
  path: type-snapping, unique naming, XSS-safe rendering downstream).
- Both throw on malformed input; callers surface a toast.
- Feature-detect `CompressionStream`: if absent, the Share button is hidden
  and decode shows a clear "browser too old" error.

### UI (`index.html`, `js/main.js`)

- **Share link** button beside Export in the header, plus the matching
  overflow-menu item (same pattern as Export/Import). Click → build the link
  from the active character → `navigator.clipboard.writeText` → toast
  "Link copied — opening it imports a copy of *Name*".
- **On page load**, if `location.hash` starts with `#c=`: decode and show a
  confirmation — "Import **Name** (Ancestry, level N)?" with Add / Dismiss —
  never a silent add, so stray link opens cannot pile up duplicates. On Add,
  run `importCharacter`. In both cases clear the fragment with
  `history.replaceState` so a refresh doesn't re-prompt. (A bookmark keeps
  its own fragment, so a bookmarked link keeps working as a poor man's cloud
  save.)
- Decode failures (truncated paste, wrong URL) show an error toast and clear
  the fragment.

## Data-revision stamp

Slot IDs are positional into `data/*.json`, so an exported character is only
exactly replayable against a compatible data snapshot. July's review flagged
this as a precondition for any sharing feature.

- `scripts/validate_data.py` (already in `npm test`) computes a short
  SHA-256 digest over the `data/*.json` files and writes `data/revision.json`
  (`{"rev": "<12 hex chars>"}`). The check fails when the committed stamp is
  stale, so it cannot drift silently.
- Share links **and** file exports carry `dataRev`.
- On import, a missing or matching stamp is silent; a mismatch shows a
  warning toast — "saved under a different rules version — review choices" —
  and imports anyway. The engine already treats orphaned decisions as
  recoverable, not fatal.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Malformed / truncated fragment | Error toast, fragment cleared |
| `CompressionStream` unsupported | Share button hidden; decode error toast |
| Clipboard write rejected | Fallback: show the link in a prompt/toast for manual copy |
| `dataRev` mismatch | Warning toast, import proceeds |

## Testing

Existing suite only — no new machinery:

- `js/ui/tests/share.test.mjs` under `node --test`:
  - encode → decode round-trips a real sample character to deep equality;
  - output uses only base64url characters (URL-safe, no padding);
  - malformed / truncated fragments reject with a clean error;
  - `dataRev` mismatch is detected (helper returns the comparison result).
- `scripts/validate_data.py` gains the revision-stamp check, exercised by
  `npm test`.
- Manual browser pass: copy a link, open it in a fresh profile, confirm the
  import prompt, Add, verify the character renders.
