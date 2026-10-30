// Shared party storage: one Worker serves the static app (Workers static
// assets) and the /api/* routes, backed by a D1 database bound as env.DB.
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Server" and "Schema").
//
// Plain ESM with no cloudflare:* imports and only globals Node 22 also has
// (Request, Response, URL, TextEncoder/TextDecoder, crypto.subtle), so
// js/ui/tests/worker.test.mjs runs this exact handler under node --test
// against a D1-shaped adapter over node:sqlite.
//
// Every member can read every character; only a character's owner can change
// it. Both rules, and the stale-write check, live in the WHERE clauses of the
// UPDATE statements below rather than in a JavaScript pre-check, so a race
// between two requests cannot slip past them.

import { validateCharacter, MAX_BODY_BYTES } from "../js/sync/validate.js";

const API_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

// Invite tokens are 32 random bytes, so anything far longer is junk; refuse
// it without hashing or querying.
const MAX_TOKEN_LENGTH = 512;

// No Access-Control-* headers anywhere: the app calls the API from its own
// origin, and a cross-origin preflight should fail (it gets a 405).
function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });
}

const fail = (status, message, extra) => json(status, { error: message }, extra);

// --- auth ------------------------------------------------------------------
// The database stores only SHA-256(token) in hex; the token itself never
// reaches storage.

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The member behind `Authorization: Bearer <token>`, or null when the header
// is missing or malformed, or the token is unknown or revoked.
async function authenticate(request, db) {
  const match = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
  return db
    .prepare("SELECT id, name FROM members WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(match[1]))
    .first();
}

// --- request bodies --------------------------------------------------------

// The body as bytes, or null when it is over `max`. A declared Content-Length
// is checked first so an honest oversized upload is refused unread; the
// stream is then counted as it arrives, because the header can be absent
// (chunked uploads) or wrong.
async function readCapped(request, max) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// --- rows ------------------------------------------------------------------

// Bodies are written only by this Worker, from JSON.stringify of a validated
// character, so a parse failure means someone edited the row by hand; hand
// the client null (its validator drops it) rather than failing the request.
function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A tombstone keeps its body in storage but reports body: null, both in the
// list and in a 409.
function rowState(row) {
  const deleted = row.deleted_at !== null;
  return { rev: row.rev, deleted, body: deleted ? null : parseBody(row.body) };
}

const readRow = (db, id) =>
  db.prepare("SELECT owner_id, rev, body, deleted_at FROM characters WHERE id = ?").bind(id).first();

const notOwner = () => fail(403, "That character belongs to another party member.");

// The write was refused; send back exactly {rev, deleted, body} as stored now,
// body and rev from the same row, so the client can decide without another
// round trip.
const conflict = (row) => json(409, rowState(row));

// --- routes ----------------------------------------------------------------

async function getMe({ member }) {
  return json(200, { id: member.id, name: member.name });
}

async function listCharacters({ db, member }) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.owner_id, m.name AS owner_name, c.rev, c.updated_at, c.deleted_at, c.body
         FROM characters c JOIN members m ON m.id = c.owner_id
        ORDER BY c.id`,
    )
    .all();
  const characters = results.map((row) => {
    const { rev, deleted, body } = rowState(row);
    return { id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, rev, updatedAt: row.updated_at, deleted, body };
  });
  return json(200, { me: { id: member.id, name: member.name }, characters });
}

// PUT {baseRev, character}. The UPDATE runs first and carries the whole gate
// (owner + rev); only when it touches nothing do we read the row to say why:
// absent → create it, someone else's → 403, otherwise stale → 409. A PUT whose
// baseRev matches a tombstone's rev clears deleted_at, undeleting it.
async function putCharacter({ request, db, member, id }) {
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (!bytes) return fail(413, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(400, "Request body is not valid JSON.");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return json(422, { error: "Character rejected.", errors: ["body must be a JSON object {baseRev, character}"] });
  }
  const { baseRev, character } = payload;
  const errors = [];
  if (!Number.isSafeInteger(baseRev) || baseRev < 0) errors.push("baseRev must be an integer ≥ 0");
  const check = validateCharacter(character);
  errors.push(...check.errors);
  if (check.ok && character.id !== id) errors.push("id must match the character id in the URL");
  if (errors.length) return json(422, { error: "Character rejected.", errors });

  const body = JSON.stringify(character);
  const now = Date.now();
  const updated = await db
    .prepare(
      `UPDATE characters SET body = ?, rev = rev + 1, updated_at = ?, deleted_at = NULL
        WHERE id = ? AND owner_id = ? AND rev = ?`,
    )
    .bind(body, now, id, member.id, baseRev)
    .run();
  if (updated.meta.changes === 1) return json(200, { rev: baseRev + 1, updatedAt: now });

  let row = await readRow(db, id);
  if (!row) {
    // New character. DO NOTHING on the primary key, rather than catching
    // "UNIQUE constraint failed", covers two first uploads racing: the loser
    // inserts nothing and falls through to 403/409 below.
    const inserted = await db
      .prepare(
        `INSERT INTO characters (id, owner_id, rev, body, updated_at, deleted_at)
         VALUES (?, ?, 1, ?, ?, NULL) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(id, member.id, body, now)
      .run();
    if (inserted.meta.changes === 1) return json(200, { rev: 1, updatedAt: now });
    row = await readRow(db, id);
    if (!row) throw new Error("character row vanished during a create race");
  }
  return row.owner_id === member.id ? conflict(row) : notOwner();
}

// DELETE ?baseRev=N: a soft delete (the body stays, deleted_at is set, rev
// bumps) behind the same owner + rev gate as PUT.
async function deleteCharacter({ url, db, member, id }) {
  const raw = url.searchParams.get("baseRev");
  if (raw === null || !/^\d{1,15}$/.test(raw)) {
    return fail(400, "baseRev must be given as an integer ≥ 0, e.g. ?baseRev=3.");
  }
  const baseRev = Number(raw);
  const now = Date.now();
  const updated = await db
    .prepare(
      `UPDATE characters SET deleted_at = ?, updated_at = ?, rev = rev + 1
        WHERE id = ? AND owner_id = ? AND rev = ?`,
    )
    .bind(now, now, id, member.id, baseRev)
    .run();
  if (updated.meta.changes === 1) return json(200, { rev: baseRev + 1 });

  const row = await readRow(db, id);
  if (!row) return fail(404, "No such character.");
  return row.owner_id === member.id ? conflict(row) : notOwner();
}

// Path → {method: handler}, plus the character id for /api/characters/:id.
// null for anything that is not a route.
function route(pathname) {
  if (pathname === "/api/me") return { handlers: { GET: getMe } };
  if (pathname === "/api/characters") return { handlers: { GET: listCharacters } };
  const match = /^\/api\/characters\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;   // malformed %-escape
  }
  return { id, handlers: { PUT: putCharacter, DELETE: deleteCharacter } };
}

async function handleApi(request, url, env) {
  const found = route(url.pathname);
  if (!found) return fail(404, "Not found.");
  const handler = Object.hasOwn(found.handlers, request.method) ? found.handlers[request.method] : null;
  if (!handler) {
    return fail(405, "Method not allowed.", { Allow: Object.keys(found.handlers).join(", ") });
  }
  const db = env.DB;
  const member = await authenticate(request, db);
  if (!member) {
    return fail(401, "This device is not in the party (missing, unknown or revoked invite).", {
      "WWW-Authenticate": "Bearer",
    });
  }
  return handler({ request, url, db, member, id: found.id });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      // Static assets are served before the Worker runs (run_worker_first
      // covers only /api/*), so this is reached only if that routing changes.
      return env?.ASSETS ? env.ASSETS.fetch(request) : fail(404, "Not found.");
    }
    try {
      return await handleApi(request, url, env);
    } catch (err) {
      // In practice a D1 error (overloaded, quota, outage). Log it for the
      // operator; the client only learns to retry later.
      console.error("api request failed:", err?.message ?? err);
      return fail(503, "Party storage is unavailable right now. Try again shortly.");
    }
  },
};
