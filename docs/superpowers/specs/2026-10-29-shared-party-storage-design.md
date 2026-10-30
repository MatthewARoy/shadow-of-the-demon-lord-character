# Shared party storage — design

Date: 2026-10-29. Supersedes the parked design in issue #37 (orphan branch +
shared PAT), which adversarial review broke.

## Intent

The owner's friend group wants two things (owner's words): **everyone can view
everyone else's characters**, and characters live in **persistent, non-local
storage**, not just one browser's `localStorage`. The owner also wants the app
reachable at an address **not linked to their GitHub identity**, so it can be
shared on Reddit anonymously, and hosted for **free or close to it**.

## Goals

- A character saved on one device appears on the player's other devices.
- Every party member can open every other member's characters, view-only.
- Storage is server-side, private (not publicly readable), and survives a
  cleared browser — including WebKit's 7-day script-storage eviction on iOS.
- Hosted on a free `*.workers.dev` address in a dedicated Cloudflare account,
  never the owner's work account.
- Nothing served from that address names the owner's GitHub account.

## Non-goals

- Live updates during play. Freshness is on open, on tab focus, and on demand
  ("Refresh party").
- Self-serve parties for strangers. Reddit visitors get the app exactly as it
  works today (local only); shared storage is invite-only.
- A GM role. Everyone sees the whole party the same way.
- Multiple parties/campaigns. One party per deployment.
- Editing other people's characters.

## Anti-goals (would be a failure even if it "works")

- Any credential that can reach the site deploy or the owner's other accounts
  living in a browser.
- A stale save silently erasing another device's work.
- The anonymous site leaking the GitHub username, work domain, account id or
  the workers.dev address back into the public repo (commits, PR, issues).
- Breaking the app for anyone without an invite, or when offline.
- New test infrastructure (owner's standing rule): everything is verified by
  the existing `npm test` (`node --test` + Python validators), no network.

## Decisions

Owner decided: Cloudflare Worker + D1; everyone views everyone; persistent
non-local storage; host on a non-GitHub address if cheap/free; use a
dedicated Cloudflare account.

Builder's calls (owner said "proceed independently"; flag if wrong):

1. **Per-person invite links; you can only change your own characters**,
   enforced by the server. A shared group link was the alternative; it is
   simpler but lets anyone holding it change anything and cannot cut off one
   person.
2. **One Worker serves both the static site and `/api/*`** (Workers static
   assets with `run_worker_first: ["/api/*"]`). Same origin → no CORS, and the
   app's `localStorage` is no longer shared with the owner's other
   `matthewaroy.github.io` site. Static asset requests are free and unlimited;
   only `/api/*` counts against the Workers Free quota (100k/day).
3. **D1, not KV or Durable Objects.** KV cannot reject a stale write; a Durable
   Object class must import `cloudflare:workers`, which plain Node cannot load,
   so it could not be tested by the existing suite.
4. **The GitHub Pages copy stays as is**, local-only. `js/site.js` turns sync
   off there; the staged Cloudflare copy turns it on.
5. **View-only by construction**: viewing someone else's character hands every
   screen a fresh deep copy on each `active()` call, so any edit is thrown
   away and never saved or uploaded. Disabled inputs and a banner make that
   visible; "Make my copy" imports it as your own.
6. Conflicts (the same character edited on two of *your* devices) prompt with
   `confirm()`: keep this device's version, or load the other one.

## Architecture

```
browser (https://<worker>.<sub>.workers.dev)
  index.html + js/ (unchanged app) + js/sync/*  ──fetch /api/*──▶  Worker (worker/index.js)
  localStorage: roster (source of truth for your     Bearer token      │
  own characters), party cache, sync state                              ▼
                                                                    D1 (SQLite)
```

### Server: `worker/index.js`

`export default { async fetch(request, env, ctx) }` — plain ESM, no
`cloudflare:*` imports, so `node --test` can call it with native
`Request`/`Response` and a fake `env`.

- Requests not under `/api/` → `env.ASSETS.fetch(request)` (only reached if
  `run_worker_first` routing changes; harmless).
- **Auth**: `Authorization: Bearer <token>`. SHA-256 the token (Web Crypto),
  hex-encode, `SELECT id, name FROM members WHERE token_hash = ? AND
  revoked_at IS NULL`. Missing/unknown → `401`. The plaintext token is never
  stored server-side.
- Every API response: `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. No CORS
  headers (same-origin only).
- Request body cap: 64 KiB (`413`). Malformed JSON → `400`. D1 errors →
  `503 {error}`.

Routes:

| Method & path | Behaviour |
|---|---|
| `GET /api/me` | `200 {id, name}` |
| `GET /api/characters` | `200 {me:{id,name}, characters:[{id, ownerId, ownerName, rev, updatedAt, deleted, body}]}` — all rows, including tombstones (`deleted: true`, `body: null`). Roster is derived by query; no manifest file. |
| `PUT /api/characters/:id` body `{baseRev, character}` | Validate (`422 {error, errors}`); `character.id` must equal `:id` (`422`). Row absent → INSERT owned by caller, `rev = 1` → `200 {rev, updatedAt}` (a PK race → `409`). Row owned by someone else → `403`. Otherwise `UPDATE characters SET body=?, rev=rev+1, updated_at=?, deleted_at=NULL WHERE id=? AND owner_id=? AND rev=?`; `meta.changes === 1` → `200 {rev: baseRev+1, updatedAt}`; `0` → re-read → `409 {rev, deleted, body}`. A PUT matching a tombstone's rev undeletes it. |
| `DELETE /api/characters/:id?baseRev=N` | Soft delete (`deleted_at = now, rev = rev+1, body` kept) with the same owner + rev check. Absent → `404`; not owner → `403`; stale → `409 {rev, deleted, body}`; ok → `200 {rev}`. |
| anything else under `/api/` | `404` / `405` JSON |

`updatedAt` is epoch milliseconds. Names (`ownerName`) come from `members`.

### Schema: `worker/migrations/0001_init.sql`

```sql
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES members(id),
  rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX characters_owner ON characters(owner_id);
```

### Shared validation: `js/sync/validate.js`

`validateCharacter(obj) → {ok: boolean, errors: string[]}`, imported by both
the Worker and the client. Structural, strict, no rules data:

- Plain object; every key of `newCharacter()` (engine.js) present with the
  right type; unknown top-level keys rejected (a test asserts the validator's
  key set equals `newCharacter()`'s so the two cannot drift).
- `id` non-empty string ≤ 100 chars; `name`/`coins`/`notes` strings with sane
  caps; `version === 2`; `level` integer 0–10; `damage` integer ≥ 0;
  `insanityAdjust`/`corruptionAdjust` integers; path/religion/sizeChoice fields
  string or null; `masterMode` ∈ {"master","second-expert"};
  `attributeSwap` null or `{from, to}` strings.
- `decisions`: plain object, string keys, JSON-only values, bounded depth.
- `exchanges`: array of `{drop:{name,tradition}, gain:{name,tradition}}` with
  string fields (issue #37 finding 7: `exchanges: [{}]` must fail).
- `wishlist`: array of strings. `expended`: object of string → integer ≥ 0.
- `inventory`: array of plain objects with string `id` and `name`, optional
  integer `qty ≥ 1`, optional boolean `equipped`, optional string `notes`,
  other fields primitives only (match what gear.js actually stores — check
  `rules.equipment` entries).
- `log`: array of JSON values (bounded).
- Optional `dataRev` string is allowed and preserved.

Every shipped sample in `data/samples.json` and `newCharacter()` must pass.

The client additionally runs `compute()` inside `try/catch` on every remote
body before showing it; a body that throws is skipped with a console warning
instead of crashing a render.

### Client sync: `js/sync/`

All DOM-free, with injected `fetch` / storage / clock, modelled on
`js/share.js` and `js/consent.js`.

- **`js/sync/hash.js`** — `canonicalJson(value)` (sorted keys, recursive) and
  `hashCharacter(c)` (a fast 53-bit string hash such as cyrb53 over
  `canonicalJson`, returned as a hex string). Sorted keys because key order
  drifts after a pull.
- **`js/sync/api.js`** — `createApi({fetch, token, base = "/api"})` →
  `{me(), list(), put(id, baseRev, character), del(id, baseRev)}`. Resolves to
  `{status, data}` for 2xx/4xx; throws `SyncNetworkError` on network failure,
  `5xx`, or `429` (with `retryAfter` seconds when the header is present). Body
  and `rev` always come from the same response.
- **`js/sync/plan.js`** — pure `planSync({local, meta, remote, me})` →
  `{creates, updates, deletes, pulls, adds, removes, conflicts, party}`:
  - `local`: your roster characters. `meta`: `{[id]: {rev, hash}}` from the
    last successful sync. `remote`: the `list()` payload. `me`: `{id}`.
  - Own rows (`ownerId === me.id`):
    - remote live, not local, not in meta → **add** (from another device).
    - remote live, not local, in meta → you deleted it here → **delete**
      (`baseRev = meta.rev`).
    - remote live, local, `rev === meta.rev`: local hash ≠ meta hash →
      **update**; else nothing.
    - remote live, local, `rev > meta.rev`: local unchanged since sync →
      **pull** (replace local); local changed → **conflict**.
    - remote live, local, not in meta → if bodies hash-equal, adopt rev;
      else **conflict**.
    - remote tombstone, local, in meta: local unchanged → **remove**;
      changed → **update** with `baseRev = remote.rev` (undelete; local wins).
    - remote tombstone, local, not in meta (e.g. left and rejoined on a
      device whose copy another device deleted) → **update** with
      `baseRev = remote.rev` (undelete-create), unless pristine.
  - Local, absent from remote, not pristine → **create** (`baseRev = 0`).
  - `isPristine(c)`: equals `newCharacter()` apart from `id` (name "Unnamed
    Soul"). Pristine characters are never uploaded; when an add arrives and
    the only local character is a pristine unsynced one, **remove** it.
  - Other members' live rows → **party** entries `{id, ownerId, ownerName,
    rev, updatedAt, character}` (validated; invalid ones dropped).
- **`js/sync/engine.js`** — `createSync({api, storage, now, getLocal,
  applyLocal, resolveConflict, onStatus})`: runs pull → plan → apply → push.
  - `storage` keys:
    - `sotdl_sync_v1`: `{token, member: {id, name}, meta: {[id]: {rev, hash}}}`
    - `sotdl_party_v1`: `{updatedAt, entries: [party entry…]}` (offline view)
  - Pushes run serially; `put` 409 → if the returned body hash equals what was
    sent, treat as success (lost-ack retry); otherwise ask
    `resolveConflict({name})` → `"mine"` (retry with the server's rev) or
    `"theirs"` (replace local).
  - `schedule()` debounces pushes after `save()` (~1.5 s). `flush({keepalive})`
    pushes immediately; wired to `pagehide` and `visibilitychange: hidden`
    with `fetch(..., {keepalive: true})`.
  - Status for the UI: `"off" | "syncing" | "synced" | "offline" | "error"`
    plus a message.
  - Network failure leaves meta untouched, so the next run re-plans and
    re-pushes. Nothing is lost while offline; `localStorage` stays the source
    of truth for your own characters.

### Client state and UI

- **`js/site.js`** (new, committed): `export const SITE = { issueRepo:
  "MatthewARoy/shadow-of-the-demon-lord-character", syncEnabled: false };`
  `js/ui/spells.js` reads `SITE.issueRepo`; the relabel link is omitted when
  it is null. The staged Cloudflare copy is `{issueRepo: null, syncEnabled:
  true}`.
- **`js/state.js`**: `store.party` (array of party entries), `store.viewingId`
  (null or a party character id, persisted with the roster), `active()`
  returns `structuredClone(entry.character)` while viewing, `isViewing()`,
  `viewingEntry()`. `save()` while viewing writes nothing new for the party
  character. `addCharacter`/`importCharacter`/`removeCharacter` exit view
  mode. `deleteActive()` refuses while viewing. An `applyRemote` helper adds,
  replaces or removes own characters by id, keeping ids (unlike
  `importCharacter`, which mints new ids).
- **`js/main.js`**:
  - Roster `<select>`: your characters, then `<optgroup label="Party">` with
    `"<character> — <owner>"`, value `party:<id>`. The change handler branches
    on party values *before* touching `store.activeId`.
  - View banner above the tabs while viewing: "Viewing <name> — <owner>'s
    character. Changes here are not saved." plus **Make my copy**. Inputs,
    selects and textareas inside the tab panels are disabled after each render
    while viewing (except the Dice and Lookup tabs). Delete is disabled.
  - Invite intake: `#invite=<token>` → clear the fragment on every path →
    `api.me()` with that token → `confirm("Join the party as <name>? Your
    characters on this device will be stored online and everyone in the party
    will be able to see them.")` → store the token and run the first sync.
  - Overflow menu: "Refresh party" and "Leave party on this device" (clears the
    token, meta and party cache; keeps your local roster).
  - A small status chip in the roster bar shows sync status.
  - Everything is wired only when `SITE.syncEnabled`; with it off the app is
    byte-for-byte today's behaviour.
  - Every member and character name goes through `esc()`.

### Staging, anonymity and deploy: `scripts/cf/`

- **`scripts/cf/stage.mjs`** — `stageSite({root, outDir})` copies only what the
  app serves (`index.html`, `css/`, `js/` minus `js/ui/tests/`, `data/*.json`)
  into `outDir/public`, overwrites `public/js/site.js` with the anonymous
  variant, and writes `public/_headers` with a Content-Security-Policy
  (`default-src 'self'`; Google Fonts allowed for styles and fonts;
  `connect-src 'self'`; `frame-ancestors 'none'`; `img-src 'self' data:`;
  `style-src` allows `'unsafe-inline'` only if the app needs it — verify in the
  browser). `scanForLeaks(dir, patterns)` fails on any of the committed
  `DEFAULT_LEAK_PATTERNS` (only the already-public account forms) or of the
  owner's private patterns, read from `~/.config/sotdl-cf/leak-patterns.json`
  (never committed; case-insensitive). `stage.mjs` exits non-zero on a leak.
- **`scripts/cf/cf.mjs`** — the only way wrangler is invoked. Every call sets
  `XDG_CONFIG_HOME=~/.config/sotdl-cf` (an isolated wrangler login, outside
  the repo and the worktree), strips `CLOUDFLARE_API_TOKEN`, and sets
  `CLOUDFLARE_ACCOUNT_ID` from the local config. Subcommands: `login`,
  `setup` (prompt for worker and database names, create the D1 database,
  record ids), `deploy` (stage → generate
  `wrangler.json` → apply migrations → deploy, record the site URL), `dev`
  (local `wrangler dev` with a local D1), `invite <name>` (mint a 32-byte
  token, insert its hash, print the invite link; for a name that already has
  a member, active or revoked, it asks, then gives that same member a new
  token and un-revokes it, so the member id and its characters are kept),
  `members`, `revoke <name>`.
  Local state lives in `~/.config/sotdl-cf/deploy.json` (`{accountId,
  databaseId, databaseName, workerName, siteUrl}`), never in the repo. The
  worker name becomes the first label of the public URL, so `setup` asks for
  it (no default committed anywhere); the database name is chosen there too. SQL for
  `wrangler d1 execute --command` is built by pure, tested helpers with
  single-quote escaping.
- Generated `wrangler.json` (in the gitignored `.cf-dist/`): name from
  `deploy.json`, `main` → `worker/index.js`, `compatibility_date`,
  `workers_dev: true`, `preview_urls: false`, assets `{directory: public,
  binding: "ASSETS", run_worker_first: ["/api/*"]}`, D1 binding `DB` with
  `migrations_dir` → `worker/migrations`.
- Nothing committed to the public repo, nor any commit message, PR body or
  issue comment, contains the account id, database id, worker name,
  workers.dev subdomain or site URL. `stage.mjs` also scans the staged files
  for the worker name and site URL read from `deploy.json` when it exists.

## Testing (stated before building)

All under the existing `npm test`; `package.json` gains `--experimental-sqlite`
on the `node --test` call (verified working on Node 22.11 locally, 22.23 and
24.22).

- `js/ui/tests/sync-validate.test.mjs` — every sample and `newCharacter()`
  pass; key set equals `newCharacter()`'s; `exchanges: [{}]`, wrong types,
  unknown keys, oversized strings, deep `decisions` all fail.
- `js/ui/tests/worker.test.mjs` — the real handler against a D1-shaped adapter
  over `node:sqlite` (`js/ui/tests/d1-sqlite.mjs`, not a test file itself)
  with the real migration SQL: 401 paths, create, update, stale update → 409
  with the current body, wrong owner → 403 (and the row unchanged), delete +
  undelete, tombstones in the list, 413/422/400, no CORS headers.
  Mutation-check the gate: removing `AND rev = ?` or `AND owner_id = ?` from
  the SQL must fail a test.
- `js/ui/tests/sync-plan.test.mjs` — every planner branch (including tombstone
  without meta), pristine handling,
  party filtering and validation.
- `js/ui/tests/sync-engine.test.mjs` — fake `api` + in-memory storage: first
  join uploads non-pristine characters; second device receives them with ids
  kept; lost-ack 409 is treated as success; conflict callback paths; offline
  leaves meta untouched and the retry succeeds; keepalive flush.
- `js/ui/tests/sync-api.test.mjs` — status/error mapping with a fake `fetch`.
- `js/ui/tests/cf-stage.test.mjs` — stage into a temp dir: no leak patterns in
  `public/`, anonymous `site.js` (`issueRepo: null, syncEnabled: true`), no
  tests/scripts/docs/PDFs staged; the committed `js/site.js` keeps sync off;
  SQL escaping helpers.
- `js/ui/tests/gate-coverage.test.mjs` keeps passing (new UI routes names
  through `esc()`).
- End to end before deploy: `cf.mjs dev` (local Worker + local D1), two
  invites, and two browser origins (`http://localhost:8787` and
  `http://127.0.0.1:8787` have separate storage): create on A, see it
  view-only on B, edits on B do not stick, conflict prompt across two
  sessions of the same member, offline edit re-syncs, CSP has no violations
  in the console.

## Known limits (to tell the owner)

- The public GitHub repo contains the same code, and the GitHub Pages copy
  stays up. Anyone who searches GitHub for a distinctive string from the
  anonymous site can find the repo. Only making the repo private (or moving
  the code to an unlinked repo) closes that.
- Reddit traffic raises exposure of the ungated core-rulebook text the app
  ships.
- An invite token in `localStorage` can be read by any script that runs on the
  site's origin; the CSP narrows that to the app's own files.
- Free tier: 100k API requests/day and 100k D1 row writes/day. A flood of
  junk `/api/*` requests could exhaust the day's quota and pause sync (not the
  app) until 00:00 UTC.
- Unverified until the owner signs in: whether the dedicated account
  exists, whether Workers Free asks for a card, and the workers.dev subdomain
  the first deploy registers (it becomes part of the public URL).

## File ownership (for parallel build)

| Owner | Files |
|---|---|
| Lead (before fan-out) | `package.json`, `.gitignore`, `js/site.js`, `js/ui/spells.js` relabel change, this spec |
| Server | `worker/index.js`, `worker/migrations/0001_init.sql`, `js/ui/tests/d1-sqlite.mjs`, `js/ui/tests/worker.test.mjs` |
| Sync core | `js/sync/validate.js`, `js/sync/hash.js`, `js/sync/api.js`, `js/sync/plan.js`, `js/sync/engine.js`, their tests |
| Deploy | `scripts/cf/stage.mjs`, `scripts/cf/cf.mjs`, `scripts/cf/sql.mjs`, `js/ui/tests/cf-stage.test.mjs`, README section |
| UI (after sync core) | `js/state.js`, `js/main.js`, `index.html`, `css/app.css` |
