import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../../../worker/index.js";
import { openD1 } from "./d1-sqlite.mjs";
import { newCharacter } from "../../engine.js";
import { MAX_BODY_BYTES } from "../../sync/validate.js";

// The real Worker handler, called with native Request objects, against the
// real migration SQL in an in-memory SQLite database shaped like D1 (see
// d1-sqlite.mjs). No network, no wrangler.

const ORIGIN = "http://localhost";
const TOKENS = { ana: "invite-token-ana", ben: "invite-token-ben", cal: "invite-token-cal" };

// Computed here with node:crypto, independently of the Worker's Web Crypto
// path, the way the invite script stores it.
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function assertApiHeaders(res, label) {
  for (const [name, value] of Object.entries(API_HEADERS)) {
    assert.equal(res.headers.get(name), value, `${label}: ${name}`);
  }
  const cors = [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
  assert.deepEqual(cors, [], `${label}: no CORS headers`);
}

// A fresh database with three members: Ana and Ben active, Cal revoked.
// `call` runs one request through the Worker and checks the API headers on
// every /api response it sees.
function setup({ wrapDb = (db) => db } = {}) {
  const { DB, sqlite } = openD1();
  const addMember = sqlite.prepare(
    "INSERT INTO members (id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
  );
  addMember.run("m-ana", "Ana", sha256Hex(TOKENS.ana), 1000, null);
  addMember.run("m-ben", "Ben", sha256Hex(TOKENS.ben), 1000, null);
  addMember.run("m-cal", "Cal", sha256Hex(TOKENS.cal), 1000, 2000);
  const env = { DB: wrapDb(DB, sqlite) };

  async function call(method, path, { token, body, raw, headers = {} } = {}) {
    const init = { method, headers: new Headers(headers) };
    if (token !== undefined) init.headers.set("Authorization", `Bearer ${token}`);
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    if (init.body instanceof ReadableStream) init.duplex = "half";
    const res = await worker.fetch(new Request(ORIGIN + path, init), env, {});
    const label = `${method} ${path} → ${res.status}`;
    if (path.startsWith("/api")) assertApiHeaders(res, label);
    const text = await res.text();
    return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
  }

  const put = (token, id, baseRev, character) =>
    call("PUT", `/api/characters/${encodeURIComponent(id)}`, { token, body: { baseRev, character } });
  const del = (token, id, baseRev) =>
    call("DELETE", `/api/characters/${encodeURIComponent(id)}?baseRev=${baseRev}`, { token });
  const list = (token) => call("GET", "/api/characters", { token });
  const row = (id) => {
    const r = sqlite.prepare("SELECT * FROM characters WHERE id = ?").get(id);
    return r ? { ...r } : null;
  };
  const count = () => sqlite.prepare("SELECT COUNT(*) AS n FROM characters").get().n;

  return { env, sqlite, call, put, del, list, row, count };
}

// What the app uploads: a newCharacter() with a fixed id and a few edits.
function character(id, overrides = {}) {
  return { ...newCharacter("Syrah"), id, level: 1, ancestry: "Changeling", ...overrides };
}

// Silence the Worker's operator log while a 503 test runs.
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// --- auth ------------------------------------------------------------------

test("401 for a missing, malformed, unknown or revoked bearer token", async () => {
  const { call, count } = setup();
  const attempts = [
    {},
    { headers: { Authorization: "Basic aW52aXRl" } },
    { headers: { Authorization: "Bearer" } },
    { headers: { Authorization: "Bearer   " } },
    { headers: { Authorization: `Bearer ${TOKENS.ana} extra` } },
    { headers: { Authorization: `Bearer ${"x".repeat(600)}` } },
    { token: "not-an-invite" },
    { token: sha256Hex(TOKENS.ana) },   // the stored hash is not a token
    { token: TOKENS.cal },              // revoked
  ];
  const requests = [
    ["GET", "/api/me", undefined],
    ["GET", "/api/characters", undefined],
    ["PUT", "/api/characters/c1", { baseRev: 0, character: character("c1") }],
    ["DELETE", "/api/characters/c1?baseRev=1", undefined],
  ];
  for (const auth of attempts) {
    for (const [method, path, body] of requests) {
      const res = await call(method, path, { ...auth, body });
      assert.equal(res.status, 401, `${method} ${path} with ${JSON.stringify(auth).slice(0, 60)}`);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal(typeof res.data.error, "string");
    }
  }
  assert.equal(count(), 0, "nothing was written");
});

test("GET /api/me returns the member for a valid token (scheme is case-insensitive)", async () => {
  const { call } = setup();
  const res = await call("GET", "/api/me", { token: TOKENS.ana });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { id: "m-ana", name: "Ana" });
  const lower = await call("GET", "/api/me", { headers: { Authorization: `bearer ${TOKENS.ben}` } });
  assert.equal(lower.status, 200);
  assert.deepEqual(lower.data, { id: "m-ben", name: "Ben" });
});

// --- create / update / conflict --------------------------------------------

test("PUT creates an absent character owned by the caller at rev 1", async () => {
  const { put, row } = setup();
  const c = character("c1", { dataRev: "abc123" });
  const before = Date.now();
  const res = await put(TOKENS.ana, "c1", 0, c);
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.data).sort(), ["rev", "updatedAt"]);
  assert.equal(res.data.rev, 1);
  assert.ok(res.data.updatedAt >= before && res.data.updatedAt <= after, "updatedAt is epoch ms");
  const stored = row("c1");
  assert.equal(stored.owner_id, "m-ana");
  assert.equal(stored.rev, 1);
  assert.equal(stored.updated_at, res.data.updatedAt);
  assert.equal(stored.deleted_at, null);
  assert.deepEqual(JSON.parse(stored.body), c, "body stored as sent, dataRev included");

  // Absent is absent whatever baseRev the client remembers (e.g. a row
  // removed by hand on the server): it is created fresh at rev 1.
  const recreated = await put(TOKENS.ana, "c2", 6, character("c2"));
  assert.equal(recreated.status, 200);
  assert.equal(recreated.data.rev, 1);
  assert.equal(row("c2").rev, 1);
  assert.equal(row("c2").owner_id, "m-ana");
});

test("PUT with the current baseRev updates and bumps rev", async () => {
  const { put, row } = setup();
  await put(TOKENS.ana, "c1", 0, character("c1"));
  const edited = character("c1", { level: 2, notes: "learned a thing" });
  const res = await put(TOKENS.ana, "c1", 1, edited);
  assert.equal(res.status, 200);
  assert.equal(res.data.rev, 2);
  assert.equal(row("c1").rev, 2);
  assert.deepEqual(JSON.parse(row("c1").body), edited);
  assert.equal(row("c1").updated_at, res.data.updatedAt);
});

test("a stale PUT gets 409 with the stored {rev, deleted, body} and changes nothing", async () => {
  const { put, row } = setup();
  await put(TOKENS.ana, "c1", 0, character("c1"));
  const current = character("c1", { level: 3 });
  await put(TOKENS.ana, "c1", 1, current);            // the other device's save → rev 2
  const before = row("c1");

  const res = await put(TOKENS.ana, "c1", 1, character("c1", { level: 9 }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.data, { rev: 2, deleted: false, body: current });
  assert.deepEqual(row("c1"), before, "row unchanged");

  // A future baseRev is stale too.
  assert.equal((await put(TOKENS.ana, "c1", 7, character("c1"))).status, 409);
  assert.deepEqual(row("c1"), before);
});

test("re-sending a create whose ack was lost gets 409 carrying the same body", async () => {
  const { put } = setup();
  const c = character("c1");
  await put(TOKENS.ana, "c1", 0, c);
  const retry = await put(TOKENS.ana, "c1", 0, c);
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.data.body, c, "the client can see its own write landed");
  assert.equal(retry.data.rev, 1);
});

// --- ownership ---------------------------------------------------------------

test("another member cannot PUT or DELETE your character, but can read it", async () => {
  const { put, del, list, row } = setup();
  const mine = character("c1", { name: "Ana's hero" });
  await put(TOKENS.ana, "c1", 0, mine);
  const before = row("c1");

  // Ben knows the current rev (he can read the list), so only ownership stops him.
  const theirs = await list(TOKENS.ben);
  const seen = theirs.data.characters.find((c) => c.id === "c1");
  assert.equal(seen.rev, 1);

  for (const baseRev of [seen.rev, 0, 5]) {
    const res = await put(TOKENS.ben, "c1", baseRev, character("c1", { name: "hijacked" }));
    assert.equal(res.status, 403, `PUT baseRev ${baseRev}`);
    assert.equal(typeof res.data.error, "string");
    assert.equal(res.data.body, undefined, "a 403 does not hand back a body to adopt");
    assert.deepEqual(row("c1"), before, "row unchanged after PUT");

    const gone = await del(TOKENS.ben, "c1", baseRev);
    assert.equal(gone.status, 403, `DELETE baseRev ${baseRev}`);
    assert.deepEqual(row("c1"), before, "row unchanged after DELETE");
  }

  assert.equal(theirs.status, 200);
  assert.deepEqual(seen, {
    id: "c1", ownerId: "m-ana", ownerName: "Ana", rev: 1,
    updatedAt: before.updated_at, deleted: false, body: mine,
  });
});

test("another member cannot undelete your tombstone", async () => {
  const { put, del, row } = setup();
  await put(TOKENS.ana, "c1", 0, character("c1"));
  await del(TOKENS.ana, "c1", 1);
  const before = row("c1");
  assert.equal((await put(TOKENS.ben, "c1", 2, character("c1"))).status, 403);
  assert.deepEqual(row("c1"), before);
});

// --- delete / tombstones / undelete --------------------------------------

test("DELETE soft-deletes, the list shows the tombstone, and a PUT at its rev undeletes", async () => {
  const { put, del, list, row } = setup();
  const original = character("c1");
  await put(TOKENS.ana, "c1", 0, original);

  const before = Date.now();
  const gone = await del(TOKENS.ana, "c1", 1);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data, { rev: 2 });
  const tomb = row("c1");
  assert.equal(tomb.rev, 2);
  assert.ok(tomb.deleted_at >= before, "deleted_at set");
  assert.deepEqual(JSON.parse(tomb.body), original, "body kept in storage");

  for (const token of [TOKENS.ana, TOKENS.ben]) {
    const entry = (await list(token)).data.characters.find((c) => c.id === "c1");
    assert.deepEqual(entry, {
      id: "c1", ownerId: "m-ana", ownerName: "Ana", rev: 2,
      updatedAt: tomb.updated_at, deleted: true, body: null,
    });
  }

  // Stale writes against the tombstone report it as deleted, with no body.
  const stalePut = await put(TOKENS.ana, "c1", 1, original);
  assert.equal(stalePut.status, 409);
  assert.deepEqual(stalePut.data, { rev: 2, deleted: true, body: null });
  const staleDel = await del(TOKENS.ana, "c1", 1);
  assert.equal(staleDel.status, 409);
  assert.equal(staleDel.data.deleted, true);

  const revived = character("c1", { notes: "back from the grave" });
  const undo = await put(TOKENS.ana, "c1", 2, revived);
  assert.equal(undo.status, 200);
  assert.equal(undo.data.rev, 3);
  assert.equal(row("c1").deleted_at, null);
  const entry = (await list(TOKENS.ben)).data.characters.find((c) => c.id === "c1");
  assert.equal(entry.deleted, false);
  assert.equal(entry.rev, 3);
  assert.deepEqual(entry.body, revived);
});

test("DELETE: stale → 409 with the current state, absent → 404, bad baseRev → 400", async () => {
  const { put, del, call, row } = setup();
  const current = character("c1", { level: 4 });
  await put(TOKENS.ana, "c1", 0, character("c1"));
  await put(TOKENS.ana, "c1", 1, current);
  const before = row("c1");

  const stale = await del(TOKENS.ana, "c1", 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.rev, 2);
  assert.equal(stale.data.deleted, false);
  assert.deepEqual(stale.data.body, current);
  assert.deepEqual(row("c1"), before);

  assert.equal((await del(TOKENS.ana, "nope", 1)).status, 404);

  for (const query of ["", "?baseRev=", "?baseRev=abc", "?baseRev=-1", "?baseRev=1.5", "?baseRev=1e3", "?rev=2"]) {
    const res = await call("DELETE", `/api/characters/c1${query}`, { token: TOKENS.ana });
    assert.equal(res.status, 400, `query ${JSON.stringify(query)}`);
  }
  assert.deepEqual(row("c1"), before);
});

// --- list ------------------------------------------------------------------

test("GET /api/characters lists every member's rows with owner names", async () => {
  const { put, list } = setup();
  await put(TOKENS.ana, "a1", 0, character("a1", { name: "First" }));
  await put(TOKENS.ana, "a2", 0, character("a2", { name: "Second" }));
  await put(TOKENS.ben, "b1", 0, character("b1", { name: "Third" }));

  const empty = await list(TOKENS.ana);
  assert.equal(empty.status, 200);
  const res = await list(TOKENS.ben);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.me, { id: "m-ben", name: "Ben" });
  assert.equal(res.data.characters.length, 3);
  const byId = Object.fromEntries(res.data.characters.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ["a1", "a2", "b1"]);
  assert.equal(byId.a1.ownerName, "Ana");
  assert.equal(byId.b1.ownerName, "Ben");
  assert.equal(byId.b1.ownerId, "m-ben");
  assert.equal(byId.a2.body.name, "Second");
  for (const entry of res.data.characters) {
    assert.deepEqual(Object.keys(entry).sort(), ["body", "deleted", "id", "ownerId", "ownerName", "rev", "updatedAt"]);
  }
});

test("GET /api/characters with no rows is an empty list", async () => {
  const { list } = setup();
  assert.deepEqual((await list(TOKENS.ana)).data, {
    me: { id: "m-ana", name: "Ana" },
    characters: [],
  });
});

test("character ids in the path are percent-decoded and must match the body", async () => {
  const { put, row, call } = setup();
  const id = "a b/c?d";
  assert.equal((await put(TOKENS.ana, id, 0, character(id))).status, 200);
  assert.equal(row(id).rev, 1);
  const malformed = await call("PUT", "/api/characters/%E0%A4%A", {
    token: TOKENS.ana, body: { baseRev: 0, character: character("x") },
  });
  assert.equal(malformed.status, 404);
});

// --- request validation ------------------------------------------------------

test("413 when the body is over MAX_BODY_BYTES, by header or by bytes actually read", async () => {
  const { call, count } = setup();
  const path = "/api/characters/c1";
  const token = TOKENS.ana;

  // Declared too large: refused before reading.
  const declared = await call("PUT", path, {
    token, raw: "{}", headers: { "Content-Length": String(MAX_BODY_BYTES + 1) },
  });
  assert.equal(declared.status, 413);

  // No Content-Length (a string body leaves it unset on a Request), counted as read.
  const big = JSON.stringify({ baseRev: 0, character: character("c1", { notes: "x".repeat(MAX_BODY_BYTES) }) });
  assert.equal((await call("PUT", path, { token, raw: big })).status, 413);

  // A Content-Length that lies low does not get past the byte count.
  assert.equal((await call("PUT", path, { token, raw: big, headers: { "Content-Length": "10" } })).status, 413);

  // Streamed in chunks with no length at all.
  const chunk = new Uint8Array(40000).fill(0x20);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  assert.equal((await call("PUT", path, { token, raw: stream })).status, 413);

  // The cap counts UTF-8 bytes, not characters: 40,000 "é" is 80,000 bytes.
  const wide = JSON.stringify({ baseRev: 0, character: character("c1", { notes: "é".repeat(40000) }) });
  assert.ok(wide.length < MAX_BODY_BYTES);
  assert.equal((await call("PUT", path, { token, raw: wide })).status, 413);

  assert.equal(count(), 0, "nothing was written");
});

test("a body of exactly MAX_BODY_BYTES is accepted", async () => {
  const { call, row } = setup();
  const json = JSON.stringify({ baseRev: 0, character: character("c1") });
  const exact = json + " ".repeat(MAX_BODY_BYTES - json.length);
  assert.equal(new TextEncoder().encode(exact).length, MAX_BODY_BYTES);
  assert.equal((await call("PUT", "/api/characters/c1", { token: TOKENS.ana, raw: exact })).status, 200);
  assert.equal(row("c1").rev, 1);
  assert.equal((await call("PUT", "/api/characters/c2", { token: TOKENS.ana, raw: `${exact} ` })).status, 413);
});

test("400 for a body that is not JSON", async () => {
  const { call, count } = setup();
  for (const raw of ["", "{", "{baseRev: 0}", "undefined", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]) {
    const res = await call("PUT", "/api/characters/c1", { token: TOKENS.ana, raw });
    assert.equal(res.status, 400, `body ${String(raw).slice(0, 20)}`);
    assert.equal(typeof res.data.error, "string");
  }
  assert.equal(count(), 0);
});

test("422 {error, errors} for an invalid envelope or character, and nothing is written", async () => {
  const { call, put, count } = setup();
  const cases = [
    ["exchanges: [{}]", { baseRev: 0, character: character("c1", { exchanges: [{}] }) }, /^exchanges\[0\]/],
    ["unknown field", { baseRev: 0, character: { ...character("c1"), hp: 99 } }, /not a character field/],
    ["missing field", { baseRev: 0, character: (({ level, ...rest }) => rest)(character("c1")) }, /^level is missing/],
    ["id mismatch", { baseRev: 0, character: character("someone-else") }, /match the character id in the URL/],
    ["no character", { baseRev: 0 }, /character must be a JSON object/],
    ["baseRev missing", { character: character("c1") }, /^baseRev/],
    ["baseRev string", { baseRev: "1", character: character("c1") }, /^baseRev/],
    ["baseRev negative", { baseRev: -1, character: character("c1") }, /^baseRev/],
    ["baseRev fraction", { baseRev: 1.5, character: character("c1") }, /^baseRev/],
    ["body is an array", [0, character("c1")], /JSON object/],
    ["body is null", null, /JSON object/],
  ];
  for (const [label, body, pattern] of cases) {
    const res = await call("PUT", "/api/characters/c1", { token: TOKENS.ana, raw: JSON.stringify(body) });
    assert.equal(res.status, 422, label);
    assert.equal(typeof res.data.error, "string", label);
    assert.ok(Array.isArray(res.data.errors) && res.data.errors.length > 0, label);
    assert.ok(res.data.errors.some((e) => pattern.test(e)), `${label}: ${JSON.stringify(res.data.errors)}`);
  }
  assert.equal(count(), 0);

  // A valid update is still refused when the new body is invalid.
  await put(TOKENS.ana, "c1", 0, character("c1"));
  assert.equal((await put(TOKENS.ana, "c1", 1, character("c1", { level: 11 }))).status, 422);
});

// --- routing ---------------------------------------------------------------

test("404 for unknown /api paths and 405 (with Allow) for wrong methods", async () => {
  const { call } = setup();
  for (const path of ["/api", "/api/", "/api/nope", "/api/me/", "/api/characters/", "/api/characters/a/b", "/api/members"]) {
    const res = await call("GET", path, { token: TOKENS.ana });
    assert.equal(res.status, 404, path);
    assert.equal(typeof res.data.error, "string");
  }
  const wrong = [
    ["POST", "/api/me", "GET"],
    ["DELETE", "/api/me", "GET"],
    ["PUT", "/api/characters", "GET"],
    ["POST", "/api/characters", "GET"],
    ["GET", "/api/characters/c1", "PUT, DELETE"],
    ["POST", "/api/characters/c1", "PUT, DELETE"],
    ["PATCH", "/api/characters/c1", "PUT, DELETE"],
    ["HEAD", "/api/me", "GET"],
  ];
  for (const [method, path, allow] of wrong) {
    const res = await call(method, path, { token: TOKENS.ana });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get("allow"), allow);
  }
});

test("a cross-origin preflight gets a 405 with no CORS headers", async () => {
  const { call } = setup();
  for (const path of ["/api/me", "/api/characters", "/api/characters/c1"]) {
    const res = await call("OPTIONS", path, {
      headers: {
        Origin: "https://elsewhere.example",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.equal(res.status, 405, path);   // assertApiHeaders already checked for access-control-*
  }
  const authed = await call("GET", "/api/me", { token: TOKENS.ana, headers: { Origin: "https://elsewhere.example" } });
  assert.equal(authed.status, 200);
  assert.equal(authed.headers.get("access-control-allow-origin"), null);
});

test("non-/api paths go to env.ASSETS, or 404 when there is no ASSETS binding", async () => {
  const seen = [];
  const env = {
    DB: { prepare() { throw new Error("assets must not touch the database"); } },
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response("asset body", { status: 200 }); } },
  };
  for (const path of ["/", "/index.html", "/js/main.js", "/apiary", "/API/me"]) {
    const res = await worker.fetch(new Request(ORIGIN + path), env, {});
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "asset body");
  }
  assert.deepEqual(seen, ["/", "/index.html", "/js/main.js", "/apiary", "/API/me"]);

  const bare = await worker.fetch(new Request(`${ORIGIN}/index.html`), {}, {});
  assert.equal(bare.status, 404);
  assertApiHeaders(bare, "no ASSETS");
});

// --- storage failures and races --------------------------------------------

test("D1 errors become 503 JSON without leaking the error text", async () => {
  const throwing = { DB: { prepare() { throw new Error("D1_ERROR: internal detail 42"); } } };
  const res = await quietly(() =>
    worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { Authorization: `Bearer ${TOKENS.ana}` } }), throwing, {}),
  );
  assert.equal(res.status, 503);
  assertApiHeaders(res, "503");
  const data = await res.json();
  assert.equal(typeof data.error, "string");
  assert.doesNotMatch(data.error, /internal detail/);

  // A failure after auth (the write itself) is a 503 too, and nothing lands.
  const { call, count } = setup({
    wrapDb: (db) => ({
      prepare(sql) {
        const stmt = db.prepare(sql);
        if (!/^\s*(UPDATE|INSERT)/i.test(sql)) return stmt;
        return { bind: () => ({ run: async () => { throw new Error("D1_ERROR: overloaded"); } }) };
      },
    }),
  });
  const write = await quietly(() =>
    call("PUT", "/api/characters/c1", { token: TOKENS.ana, body: { baseRev: 0, character: character("c1") } }),
  );
  assert.equal(write.status, 503);
  assert.equal(count(), 0);
});

// Two creates of the same id race: the row is absent when this request looks,
// and present by the time it inserts.
function racingInsert(ownerId, body) {
  return (db, sqlite) => {
    let raced = false;
    return {
      prepare(sql) {
        if (!raced && /INSERT INTO characters/.test(sql)) {
          raced = true;
          sqlite
            .prepare("INSERT INTO characters (id, owner_id, rev, body, updated_at) VALUES (?, ?, 1, ?, ?)")
            .run("c1", ownerId, JSON.stringify(body), 5);
        }
        return db.prepare(sql);
      },
      batch: (stmts) => db.batch(stmts),
    };
  };
}

test("losing a create race to your own other device is a 409 with the winner's body", async () => {
  const winner = character("c1", { notes: "from the other device" });
  const { put, row } = setup({ wrapDb: racingInsert("m-ana", winner) });
  const res = await put(TOKENS.ana, "c1", 0, character("c1"));
  assert.equal(res.status, 409);
  assert.equal(res.data.rev, 1);
  assert.deepEqual(res.data.body, winner);
  assert.equal(row("c1").updated_at, 5, "winner's row untouched");
});

test("losing a create race to another member is a 403, not a body to adopt", async () => {
  const winner = character("c1", { notes: "Ben's" });
  const { put, row } = setup({ wrapDb: racingInsert("m-ben", winner) });
  const res = await put(TOKENS.ana, "c1", 0, character("c1"));
  assert.equal(res.status, 403);
  assert.equal(res.data.body, undefined);
  assert.equal(row("c1").owner_id, "m-ben");
});

// --- the D1 adapter itself -------------------------------------------------
// The Worker tests are only as good as the fake; pin the D1 behaviours they
// lean on.

test("d1-sqlite: first/all/run shapes, null for no row, plain-object rows", async () => {
  const { DB } = openD1();
  const ins = await DB.prepare("INSERT INTO members (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind("m1", "One", "h1", 1).run();
  assert.equal(ins.success, true);
  assert.equal(ins.meta.changes, 1);
  assert.equal(typeof ins.meta.last_row_id, "number");
  assert.equal(ins.meta.rows_written, 1);

  const row = await DB.prepare("SELECT id, name FROM members WHERE id = ?").bind("m1").first();
  assert.deepEqual(row, { id: "m1", name: "One" });
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(await DB.prepare("SELECT id FROM members WHERE id = ?").bind("zz").first(), null);
  assert.equal(await DB.prepare("SELECT name FROM members WHERE id = ?").bind("m1").first("name"), "One");

  const all = await DB.prepare("SELECT id FROM members").all();
  assert.equal(all.success, true);
  assert.deepEqual(all.results, [{ id: "m1" }]);
  assert.equal(typeof all.meta, "object");

  const noop = await DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind("x", "zz").run();
  assert.equal(noop.meta.changes, 0);
});

test("d1-sqlite: bind returns a new statement; bad SQL and bad bindings reject", async () => {
  const { DB } = openD1();
  const base = DB.prepare("SELECT ? AS v");
  const one = base.bind(1);
  const two = base.bind(2);
  assert.notEqual(one, base);
  assert.equal(await one.first("v"), 1);
  assert.equal(await two.first("v"), 2);

  const broken = DB.prepare("SELEKT nonsense");   // lazy, like D1: no throw here
  await assert.rejects(broken.all());
  await assert.rejects(DB.prepare("SELECT ? AS a, ? AS b").bind(1).first(), /Wrong number of parameter bindings/);
  await assert.rejects(DB.prepare("SELECT ? AS a").bind(1, 2).first(), /Wrong number of parameter bindings/);
  assert.throws(() => DB.prepare("SELECT ?").bind(undefined), /D1_TYPE_ERROR/);
  assert.throws(() => DB.prepare("SELECT ?").bind({}), /D1_TYPE_ERROR/);
  assert.equal(await DB.prepare("SELECT ? AS t").bind(true).first("t"), 1);
  assert.equal(await DB.prepare("SELECT '?' AS q, ? AS v").bind(7).first("v"), 7, "? inside a string is not a parameter");
});

test("d1-sqlite: constraint violations throw; foreign keys are enforced", async () => {
  const { DB } = openD1();
  const add = DB.prepare("INSERT INTO members (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)");
  await add.bind("m1", "One", "h1", 1).run();
  await assert.rejects(add.bind("m1", "Again", "h2", 1).run(), /UNIQUE constraint failed: members\.id/);
  await assert.rejects(add.bind("m2", "Two", "h1", 1).run(), /UNIQUE constraint failed: members\.token_hash/);
  await assert.rejects(
    DB.prepare("INSERT INTO characters (id, owner_id, rev, body, updated_at) VALUES (?, ?, 1, '{}', 1)").bind("c1", "ghost").run(),
    /FOREIGN KEY constraint failed/,
  );
});

test("d1-sqlite: batch runs in one transaction and rolls back on any error", async () => {
  const { DB, sqlite } = openD1();
  const add = DB.prepare("INSERT INTO members (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)");
  const ok = await DB.batch([add.bind("m1", "One", "h1", 1), add.bind("m2", "Two", "h2", 1), DB.prepare("SELECT id FROM members ORDER BY id")]);
  assert.equal(ok.length, 3);
  assert.equal(ok[0].meta.changes, 1);
  assert.deepEqual(ok[2].results, [{ id: "m1" }, { id: "m2" }]);

  await assert.rejects(
    DB.batch([add.bind("m3", "Three", "h3", 1), add.bind("m1", "Dup", "h4", 1)]),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(
    sqlite.prepare("SELECT id FROM members ORDER BY id").all().map((r) => r.id),
    ["m1", "m2"],
    "the first insert of the failed batch was rolled back",
  );
  sqlite.exec("BEGIN");   // throws if the failed batch left its transaction open
  sqlite.exec("ROLLBACK");
});
