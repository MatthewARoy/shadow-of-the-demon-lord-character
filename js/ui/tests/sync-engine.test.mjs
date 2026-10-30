import test from "node:test";
import assert from "node:assert/strict";
import { createSync, SYNC_KEY, PARTY_KEY } from "../../sync/engine.js";
import { SyncNetworkError } from "../../sync/api.js";
import { hashCharacter } from "../../sync/hash.js";
import { validateCharacter } from "../../sync/validate.js";
import { newCharacter } from "../../engine.js";

// --- an in-memory party server ---------------------------------------------------
// The Worker's /api/* semantics from the spec, minus HTTP plumbing: bearer
// auth, owner + rev checks, soft deletes that keep a tombstone, 422 on an
// invalid body. Bodies are stored as JSON text, as D1 stores them, so no
// object is ever shared between a device and the server.
//
// Fault knobs: `offline` (fetch rejects before reaching the server),
// `dropNextAck` (the next write is applied, then the response is lost),
// `failWhen(call)` (reject matching calls before they reach the server).

function fakeServer() {
  const members = new Map();   // token -> {id, name}
  const rows = new Map();      // id -> {id, ownerId, rev, updatedAt, deleted, body}
  let clock = 1_000;
  const nameOf = (memberId) => [...members.values()].find((m) => m.id === memberId)?.name ?? "?";
  // A 409 re-reads the row. Soft deletes keep the body, so a tombstone's 409
  // still carries it (list() is what hides tombstone bodies).
  const view = (r) => ({ rev: r.rev, deleted: r.deleted, body: JSON.parse(r.body) });

  function handle(call, authHeader) {
    const token = /^Bearer (.+)$/.exec(authHeader ?? "")?.[1];
    const me = token && members.get(token);
    if (!me) return [401, { error: "unauthorized" }];
    const url = new URL(call.url, "http://party.test");
    if (url.pathname === "/api/me" && call.method === "GET") return [200, me];
    if (url.pathname === "/api/characters" && call.method === "GET") {
      return [200, {
        me,
        characters: [...rows.values()].map((r) => ({
          id: r.id, ownerId: r.ownerId, ownerName: nameOf(r.ownerId), rev: r.rev,
          updatedAt: r.updatedAt, deleted: r.deleted, body: r.deleted ? null : JSON.parse(r.body),
        })),
      }];
    }
    const match = /^\/api\/characters\/([^/]+)$/.exec(url.pathname);
    if (!match) return [404, { error: "not found" }];
    const id = decodeURIComponent(match[1]);
    const row = rows.get(id);
    if (call.method === "PUT") {
      const { baseRev, character } = call.body;
      const check = validateCharacter(character);
      if (!check.ok) return [422, { error: "invalid character", errors: check.errors }];
      if (character.id !== id) return [422, { error: "id mismatch" }];
      clock++;
      if (!row) {
        rows.set(id, { id, ownerId: me.id, rev: 1, updatedAt: clock, deleted: false, body: JSON.stringify(character) });
        return [200, { rev: 1, updatedAt: clock }];
      }
      if (row.ownerId !== me.id) return [403, { error: "not your character" }];
      if (row.rev !== baseRev) return [409, view(row)];
      Object.assign(row, { rev: row.rev + 1, updatedAt: clock, deleted: false, body: JSON.stringify(character) });
      return [200, { rev: row.rev, updatedAt: clock }];
    }
    if (call.method === "DELETE") {
      const baseRev = Number(url.searchParams.get("baseRev"));
      if (!row) return [404, { error: "not found" }];
      if (row.ownerId !== me.id) return [403, { error: "not your character" }];
      if (row.rev !== baseRev) return [409, view(row)];
      clock++;
      Object.assign(row, { rev: row.rev + 1, updatedAt: clock, deleted: true });
      return [200, { rev: row.rev }];
    }
    return [405, { error: "method not allowed" }];
  }

  const server = {
    members, rows, calls: [],
    offline: false, dropNextAck: false, failWhen: null,
    inFlight: 0, maxInFlight: 0,
    addMember: (token, id, name) => members.set(token, { id, name }),
    // Write a row directly, bypassing validation (a body from a newer or
    // broken client).
    plant: (id, ownerId, body, rev = 1) =>
      rows.set(id, { id, ownerId, rev, updatedAt: ++clock, deleted: false, body: JSON.stringify(body) }),
    body: (id) => JSON.parse(rows.get(id).body),
    rev: (id) => rows.get(id).rev,
    writes: () => server.calls.filter((c) => c.method !== "GET"),
    lists: () => server.calls.filter((c) => c.method === "GET" && c.url.endsWith("/characters")),
    async fetch(url, init = {}) {
      const call = {
        method: init.method ?? "GET", url, keepalive: init.keepalive,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      server.calls.push(call);
      if (server.offline || server.failWhen?.(call)) throw new TypeError("fetch failed");
      server.inFlight++;
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));   // a real async hop
        const [status, body] = handle(call, init.headers?.Authorization);
        if (server.dropNextAck && call.method !== "GET") {
          server.dropNextAck = false;
          throw new TypeError("connection reset");
        }
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      } finally {
        server.inFlight--;
      }
    },
  };
  return server;
}

// --- devices -----------------------------------------------------------------------

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => void pending.delete(id),
    pending: () => [...pending.values()].map((p) => p.ms),
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
  };
}

// Roster objects are deep-frozen, and edits replace them, as state.js would
// after a render. ESM is strict mode, so any engine write to an object that
// getLocal() handed out throws and fails the test.
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function device(server, roster = [], options = {}) {
  const dev = {
    storage: memoryStorage(),
    timers: fakeTimers(),
    roster: roster.map((c) => deepFreeze(structuredClone(c))),
    party: null,
    statuses: [],
    prompts: [],
    applied: [],
    choice: "mine",
  };
  dev.engine = createSync({
    fetch: server.fetch,
    storage: dev.storage,
    timers: dev.timers,
    now: () => 5_000,
    getLocal: () => dev.roster,
    applyLocal: ({ adds, pulls, removes }) => {
      dev.applied.push({ adds, pulls, removes });
      let next = dev.roster.filter((c) => !removes.includes(c.id));
      for (const p of pulls) next = next.map((c) => (c.id === p.id ? deepFreeze(p) : c));
      dev.roster = [...next, ...adds.map(deepFreeze)];
    },
    onParty: (entries) => {
      dev.party = entries;
    },
    resolveConflict: async (c) => {
      dev.prompts.push(c);
      return dev.choice;
    },
    onStatus: (s) => dev.statuses.push(s),
    ...options,
  });
  dev.get = (id) => dev.roster.find((c) => c.id === id);
  dev.edit = (id, patch) => {
    dev.roster = dev.roster.map((c) => (c.id === id ? deepFreeze({ ...structuredClone(c), ...patch }) : c));
  };
  dev.remove = (id) => {
    dev.roster = dev.roster.filter((c) => c.id !== id);
  };
  dev.state = () => JSON.parse(dev.storage.getItem(SYNC_KEY));
  dev.meta = () => dev.state()?.meta;
  return dev;
}

const ASH = { id: "m1", name: "Ash" };
const BO = { id: "m2", name: "Bo" };

function partyServer() {
  const server = fakeServer();
  server.addMember("tok-ash", ASH.id, ASH.name);
  server.addMember("tok-bo", BO.id, BO.name);
  return server;
}

const hero = (name, patch = {}) => ({ ...newCharacter(name), ...patch });

// Ash on two devices, both joined, holding Syrah (a) and Kell (b) at rev 1.
async function twoDevices() {
  const server = partyServer();
  const a = hero("Syrah", { level: 2, ancestry: "Changeling" });
  const b = hero("Kell");
  const d1 = device(server, [newCharacter(), a, b]);
  const d2 = device(server, [newCharacter()]);
  await d1.engine.join("tok-ash", ASH);
  await d2.engine.join("tok-ash", ASH);
  return { server, d1, d2, a, b };
}

// --- invite probe ----------------------------------------------------------------------

test("probe checks a token with /api/me without storing anything", async () => {
  const server = partyServer();
  const dev = device(server);
  assert.deepEqual(await dev.engine.probe("tok-ash"), ASH);
  assert.equal(server.calls[0].url, "/api/me");
  await assert.rejects(dev.engine.probe("tok-wrong"), /invite link is not valid/);
  server.offline = true;
  await assert.rejects(dev.engine.probe("tok-ash"), SyncNetworkError);
  assert.equal(dev.engine.isJoined(), false);
  assert.equal(dev.engine.member(), null);
  assert.equal(dev.storage.getItem(SYNC_KEY), null);
});

// --- join, add, edit, delete ---------------------------------------------------------------

test("first join uploads the non-pristine characters and records their revs", async () => {
  const server = partyServer();
  const placeholder = newCharacter();
  const a = hero("Syrah", { level: 2 });
  const b = hero("Kell");
  const d1 = device(server, [placeholder, a, b]);

  const status = await d1.engine.join("tok-ash", ASH);

  assert.equal(status.state, "synced");
  assert.deepEqual(d1.statuses.map((s) => s.state), ["syncing", "synced"]);
  assert.deepEqual([...server.rows.keys()].sort(), [a.id, b.id].sort());
  assert.deepEqual(server.body(a.id), a);
  assert.equal(server.rows.get(a.id).ownerId, ASH.id);
  assert.deepEqual(d1.state(), {
    token: "tok-ash",
    member: ASH,
    meta: { [a.id]: { rev: 1, hash: hashCharacter(a) }, [b.id]: { rev: 1, hash: hashCharacter(b) } },
  });
  assert.equal(d1.roster.length, 3, "the local roster is untouched, placeholder included");
  assert.equal(d1.engine.isJoined(), true);
  assert.deepEqual(d1.engine.member(), ASH);
});

test("a second device of the same member receives them with ids kept, replacing its placeholder", async () => {
  const { server, d1, d2, a, b } = await twoDevices();
  assert.deepEqual(d2.roster.map((c) => c.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(d2.get(a.id), a);
  assert.deepEqual(d2.applied.length, 1);
  assert.equal(d2.applied[0].removes.length, 1, "the pristine placeholder went");
  assert.deepEqual(d2.meta()[a.id], d1.meta()[a.id]);
  assert.equal(server.writes().length, 2, "only device 1's two creates were written");
  assert.deepEqual(d2.prompts, []);
});

test("a debounced edit on device 1 reaches device 2 on its next sync", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { level: 3 });
  d1.engine.schedule();
  d1.engine.schedule();
  assert.deepEqual(d1.timers.pending(), [1500], "two saves, one pending push");
  const callsBefore = server.calls.length;
  assert.equal(server.calls.length, callsBefore, "nothing sent before the debounce fires");

  d1.timers.runAll();
  assert.equal((await d1.engine.idle()).state, "synced");
  const sent = server.calls.slice(callsBefore);
  assert.deepEqual(sent.map((c) => c.method), ["PUT"], "a push pass sends no list()");
  assert.equal(sent[0].body.baseRev, 1);
  assert.equal(server.body(a.id).level, 3);
  assert.equal(d1.meta()[a.id].rev, 2);

  await d2.engine.sync();
  assert.equal(d2.get(a.id).level, 3);
  assert.equal(d2.meta()[a.id].rev, 2);
  assert.deepEqual(d2.prompts, []);
});

test("an edit made while its upload is in flight is still pushed afterwards", async () => {
  const { server, d1, a } = await twoDevices();
  d1.edit(a.id, { level: 3 });
  const pending = d1.engine.flush();
  d1.edit(a.id, { level: 4 });          // the PUT carrying level 3 is already on its way
  await pending;
  assert.equal(server.body(a.id).level, 3);
  assert.equal(d1.meta()[a.id].hash, hashCharacter(server.body(a.id)), "meta records what was sent");
  await d1.engine.flush();
  assert.equal(server.body(a.id).level, 4);
});

test("a delete on device 1 tombstones the row and removes it on device 2", async () => {
  const { server, d1, d2, b } = await twoDevices();
  d1.remove(b.id);
  assert.equal((await d1.engine.flush()).state, "synced");
  assert.equal(server.rows.get(b.id).deleted, true);
  assert.equal(d1.meta()[b.id], undefined);

  await d2.engine.sync();
  assert.equal(d2.get(b.id), undefined);
  assert.equal(d2.meta()[b.id], undefined);
  const writes = server.writes().length;
  await d1.engine.sync();
  await d2.engine.sync();
  assert.equal(server.writes().length, writes, "a settled party writes nothing more");
});

test("a character deleted on one device but edited on the other comes back with the edits", async () => {
  const { server, d1, d2, b } = await twoDevices();
  d1.remove(b.id);
  await d1.engine.flush();
  d2.edit(b.id, { notes: "kept going" });
  await d2.engine.sync();
  assert.equal(server.rows.get(b.id).deleted, false);
  assert.equal(server.body(b.id).notes, "kept going");
  assert.deepEqual(d2.prompts, []);
  await d1.engine.sync();
  assert.equal(d1.get(b.id).notes, "kept going");
});

test("a push that meets a tombstone brings the character back, even when the bodies match", async () => {
  // Device 2 rejoins while offline (meta empty), so its first contact is a
  // push pass: create at baseRev 0 against a tombstone whose kept body is
  // identical. The tombstone's rev must not be adopted as "already synced".
  const { server, d1, d2, b } = await twoDevices();
  d1.remove(b.id);
  await d1.engine.flush();
  d2.engine.leave();
  server.offline = true;
  assert.equal((await d2.engine.join("tok-ash", ASH)).state, "offline");
  server.offline = false;
  assert.equal((await d2.engine.flush()).state, "synced");
  assert.equal(server.rows.get(b.id).deleted, false);
  assert.equal(d2.meta()[b.id].rev, server.rev(b.id));
  await d2.engine.sync();
  assert.ok(d2.get(b.id), "still in the roster after the next full sync");
});

// --- conflicts --------------------------------------------------------------------------------

test("concurrent edits: 'mine' overwrites the server with this device's version", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { notes: "from d1" });
  d2.edit(a.id, { notes: "from d2" });
  await d1.engine.flush();
  d2.choice = "mine";
  assert.equal((await d2.engine.flush()).state, "synced");
  assert.deepEqual(d2.prompts, [{ id: a.id, name: "Syrah", kind: "edit" }]);
  assert.equal(server.body(a.id).notes, "from d2");
  assert.equal(server.rev(a.id), 3);
  assert.equal(d2.meta()[a.id].rev, 3);
  await d1.engine.sync();
  assert.equal(d1.get(a.id).notes, "from d2");
  assert.deepEqual(d1.prompts, []);
});

test("concurrent edits: 'theirs' replaces this device's copy with the server's", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { notes: "from d1" });
  d2.edit(a.id, { notes: "from d2" });
  await d1.engine.flush();
  d2.choice = "theirs";
  await d2.engine.flush();
  assert.equal(d2.prompts.length, 1);
  assert.equal(d2.get(a.id).notes, "from d1");
  assert.equal(server.body(a.id).notes, "from d1");
  assert.deepEqual(d2.meta()[a.id], { rev: 2, hash: hashCharacter(server.body(a.id)) });
  const writes = server.writes().length;
  await d2.engine.flush();
  assert.equal(server.writes().length, writes, "nothing left to push");
});

test("a conflict found by the planner uses the same callback, both ways", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { level: 4 });
  await d1.engine.flush();
  d2.edit(a.id, { level: 5 });
  d2.choice = "theirs";
  await d2.engine.sync();
  assert.deepEqual(d2.prompts, [{ id: a.id, name: "Syrah", kind: "edit" }]);
  assert.equal(d2.get(a.id).level, 4);
  assert.equal(server.rev(a.id), 2);

  d1.edit(a.id, { level: 6 });
  await d1.engine.flush();
  d2.edit(a.id, { level: 7 });
  d2.choice = "mine";
  await d2.engine.sync();
  assert.equal(d2.prompts.length, 2);
  assert.equal(server.body(a.id).level, 7);
  assert.equal(server.rev(a.id), 4);
  assert.equal(d2.meta()[a.id].rev, 4);
});

test("delete here vs edit there: 'theirs' restores it, 'mine' deletes it anyway", async () => {
  const { server, d1, d2, a, b } = await twoDevices();
  d2.edit(b.id, { notes: "edited on d2" });
  await d2.engine.flush();
  d1.remove(b.id);
  d1.choice = "theirs";
  await d1.engine.flush();
  // The prompt must say this device's side is a deletion: "keep mine" deletes.
  assert.deepEqual(d1.prompts, [{ id: b.id, name: "Kell", kind: "delete" }]);
  assert.equal(d1.get(b.id).notes, "edited on d2");
  assert.equal(server.rows.get(b.id).deleted, false);

  d2.edit(a.id, { notes: "edited on d2" });
  await d2.engine.flush();
  d1.remove(a.id);
  d1.choice = "mine";
  await d1.engine.flush();
  assert.equal(server.rows.get(a.id).deleted, true);
  assert.equal(d1.meta()[a.id], undefined);
});

test("a pull planned before a conflict prompt is dropped if the character is edited during it", async () => {
  const { server, d1, d2, a, b } = await twoDevices();
  d1.edit(a.id, { notes: "d1 a" });
  d1.edit(b.id, { notes: "d1 b" });
  await d1.engine.flush();
  d2.edit(a.id, { notes: "d2 a" });
  // While the player is answering about a, they also edit b on this device.
  d2.engine = createSync({
    fetch: server.fetch, storage: d2.storage, timers: d2.timers,
    getLocal: () => d2.roster,
    applyLocal: ({ adds, pulls, removes }) => {
      let next = d2.roster.filter((c) => !removes.includes(c.id));
      for (const p of pulls) next = next.map((c) => (c.id === p.id ? deepFreeze(p) : c));
      d2.roster = [...next, ...adds.map(deepFreeze)];
    },
    resolveConflict: async () => {
      d2.edit(b.id, { notes: "d2 b, typed during the prompt" });
      return "theirs";
    },
  });
  await d2.engine.sync();
  assert.equal(d2.get(a.id).notes, "d1 a", "the answered conflict was applied");
  assert.equal(d2.get(b.id).notes, "d2 b, typed during the prompt", "the stale pull did not overwrite it");
  assert.equal(server.body(b.id).notes, "d1 b");
});

test("an add the roster declines stays out of meta, so it is never mistaken for a delete", async () => {
  const { server, a } = await twoDevices();
  const picky = device(server, [], { applyLocal: () => {} });
  await picky.engine.join("tok-ash", ASH);
  assert.deepEqual(picky.meta(), {});
  await picky.engine.sync();
  assert.equal(server.writes().filter((c) => c.method === "DELETE").length, 0);
  assert.equal(server.rows.get(a.id).deleted, false);
});

test("an undecided conflict changes nothing and is asked again next time", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { notes: "from d1" });
  d2.edit(a.id, { notes: "from d2" });
  await d1.engine.flush();
  d2.choice = null;
  const meta = d2.meta();
  await d2.engine.flush();
  assert.deepEqual(d2.meta(), meta);
  assert.equal(d2.get(a.id).notes, "from d2");
  assert.equal(server.body(a.id).notes, "from d1");
  await d2.engine.sync();
  assert.equal(d2.prompts.length, 2);
});

// --- lost acks and offline ----------------------------------------------------------------------------

test("lost ack: the retry's 409 carries our own body, so it counts as success", async () => {
  const { server, d1, a } = await twoDevices();
  d1.edit(a.id, { damage: 2 });
  server.dropNextAck = true;
  assert.equal((await d1.engine.flush()).state, "offline");
  assert.equal(server.body(a.id).damage, 2, "the write landed");
  assert.equal(d1.meta()[a.id].rev, 1, "but meta did not move");

  assert.equal((await d1.engine.flush()).state, "synced");
  const last = server.calls.at(-1);
  assert.equal(last.method, "PUT");
  assert.equal(last.body.baseRev, 1, "the retry was stale and drew a 409");
  assert.equal(server.rev(a.id), 2, "no second write");
  assert.deepEqual(d1.meta()[a.id], { rev: 2, hash: hashCharacter(d1.get(a.id)) });
  assert.deepEqual(d1.prompts, []);
});

test("lost ack: the next full sync adopts the rev without a prompt or a write", async () => {
  const { server, d1, a } = await twoDevices();
  d1.edit(a.id, { damage: 3 });
  server.dropNextAck = true;
  await d1.engine.flush();
  const writes = server.writes().length;
  assert.equal((await d1.engine.sync()).state, "synced");
  assert.equal(server.writes().length, writes);
  assert.equal(d1.meta()[a.id].rev, 2);
  assert.deepEqual(d1.prompts, []);
});

test("offline: meta is left byte-for-byte untouched and the retry succeeds", async () => {
  const { server, d1, a, b } = await twoDevices();
  d1.edit(a.id, { level: 7 });
  d1.remove(b.id);
  const before = d1.storage.getItem(SYNC_KEY);
  server.offline = true;
  const offline = await d1.engine.sync();
  assert.equal(offline.state, "offline");
  assert.match(offline.message, /kept on this device/);
  assert.equal((await d1.engine.flush()).state, "offline");
  assert.equal(d1.storage.getItem(SYNC_KEY), before);
  assert.equal(server.body(a.id).level, 2);
  assert.equal(server.rows.get(b.id).deleted, false);

  server.offline = false;
  assert.equal((await d1.engine.sync()).state, "synced");
  assert.equal(server.body(a.id).level, 7);
  assert.equal(server.rows.get(b.id).deleted, true);
});

test("a failure mid-pass keeps the pushes that landed and stops the rest", async () => {
  const { server, d1, a, b } = await twoDevices();
  d1.edit(a.id, { level: 8 });
  d1.remove(b.id);
  server.failWhen = (call) => call.method === "DELETE";
  assert.equal((await d1.engine.flush()).state, "offline");
  assert.equal(d1.meta()[a.id].rev, 2, "the PUT landed and was recorded");
  assert.equal(d1.meta()[b.id].rev, 1, "the DELETE did not");
  server.failWhen = null;
  await d1.engine.flush();
  assert.equal(d1.meta()[b.id], undefined);
  assert.equal(server.rows.get(b.id).deleted, true);
});

test("a 5xx or 429 reads as offline, not as an error", async () => {
  const { d1 } = await twoDevices();
  const busy = device({ fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }) });
  busy.storage.setItem(SYNC_KEY, d1.storage.getItem(SYNC_KEY));
  const s = await busy.engine.sync();
  assert.equal(s.state, "offline");
  assert.match(s.message, /busy/);
  const down = device({ fetch: async () => new Response("{}", { status: 503 }) });
  down.storage.setItem(SYNC_KEY, d1.storage.getItem(SYNC_KEY));
  assert.match((await down.engine.sync()).message, /unavailable/);
});

test("a revoked invite reports an error and leaves meta alone", async () => {
  const { server, d1 } = await twoDevices();
  const before = d1.storage.getItem(SYNC_KEY);
  server.members.delete("tok-ash");
  const s = await d1.engine.sync();
  assert.equal(s.state, "error");
  assert.match(s.message, /no longer valid/);
  assert.equal(d1.storage.getItem(SYNC_KEY), before);
});

// --- the party -------------------------------------------------------------------------------------------

test("another member's characters arrive as party entries, are cached, and never join the roster", async () => {
  const { server, d1, a } = await twoDevices();
  const rogue = hero("Bo's rogue");
  const mage = hero("Bo's mage");
  const bo = device(server, [rogue, mage]);
  await bo.engine.join("tok-bo", BO);
  await d1.engine.sync();

  assert.deepEqual(d1.party.map((e) => e.character.name).sort(), ["Bo's mage", "Bo's rogue"]);
  const entry = d1.party.find((e) => e.id === rogue.id);
  assert.deepEqual(entry, {
    id: rogue.id, ownerId: BO.id, ownerName: "Bo", rev: 1,
    updatedAt: server.rows.get(rogue.id).updatedAt, character: rogue,
  });
  assert.deepEqual(JSON.parse(d1.storage.getItem(PARTY_KEY)), { updatedAt: 5_000, entries: d1.party });
  assert.deepEqual(d1.engine.cachedParty(), d1.party);
  assert.equal(d1.get(rogue.id), undefined);
  assert.deepEqual(bo.party.map((e) => e.id).sort(), [a.id, d1.roster.find((c) => c.name === "Kell").id].sort());
});

test("an invalid party body is skipped, and so is one isUsable rejects or throws on", async () => {
  const server = partyServer();
  const good = hero("Fine");
  const unusable = hero("Needs newer data");
  const explodes = hero("Explodes");
  server.plant(good.id, BO.id, good);
  server.plant(unusable.id, BO.id, unusable);
  server.plant(explodes.id, BO.id, explodes);
  const junk = { ...hero("Broken"), level: 99 };
  server.plant(junk.id, BO.id, junk);
  const dev = device(server, [], {
    isUsable: (c) => {
      if (c.name === "Explodes") throw new Error("compute() blew up");
      return c.name !== "Needs newer data";
    },
  });
  await dev.engine.join("tok-ash", ASH);
  assert.deepEqual(dev.party.map((e) => e.id), [good.id]);
  assert.deepEqual(dev.engine.cachedParty().map((e) => e.id), [good.id]);
});

test("cachedParty re-checks what it reads back and is empty when not joined", async () => {
  const server = partyServer();
  const dev = device(server);
  assert.deepEqual(dev.engine.cachedParty(), []);
  await dev.engine.join("tok-ash", ASH);
  const good = hero("Fine");
  dev.storage.setItem(PARTY_KEY, JSON.stringify({
    updatedAt: 1,
    entries: [
      { id: good.id, ownerId: BO.id, ownerName: "Bo", rev: 1, updatedAt: 1, character: good },
      { id: "tampered", ownerId: BO.id, ownerName: "Bo", rev: 1, updatedAt: 1, character: { id: "tampered" } },
      null,
    ],
  }));
  assert.deepEqual(dev.engine.cachedParty().map((e) => e.id), [good.id]);
  dev.storage.setItem(PARTY_KEY, "not json");
  assert.deepEqual(dev.engine.cachedParty(), []);
});

test("an own body that fails validation or isUsable is not added, with a warning", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const server = partyServer();
  const bad = { ...hero("Bad exchange"), exchanges: [{}] };
  const newer = hero("From a newer app");
  const fine = hero("Fine");
  server.plant(bad.id, ASH.id, bad);
  server.plant(newer.id, ASH.id, newer);
  server.plant(fine.id, ASH.id, fine);
  const dev = device(server, [], { isUsable: (c) => c.name !== "From a newer app" });
  await dev.engine.join("tok-ash", ASH);
  assert.deepEqual(dev.roster.map((c) => c.id), [fine.id]);
  assert.deepEqual(Object.keys(dev.meta()), [fine.id]);
  const warned = warn.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(warned, new RegExp(bad.id));
  assert.match(warned, new RegExp(newer.id));
  assert.equal(server.writes().length, 0, "skipping never deletes the server copy");
});

test("the placeholder stays when every arriving character is skipped", async (t) => {
  t.mock.method(console, "warn", () => {});
  const server = partyServer();
  const bad = { ...hero("Bad exchange"), exchanges: [{}] };
  server.plant(bad.id, ASH.id, bad);
  const placeholder = newCharacter();
  const dev = device(server, [placeholder]);
  await dev.engine.join("tok-ash", ASH);
  assert.deepEqual(dev.roster.map((c) => c.id), [placeholder.id]);
});

test("a local character the validator rejects is not uploaded; the rest still are", async (t) => {
  t.mock.method(console, "warn", () => {});
  const server = partyServer();
  const broken = { ...hero("Legacy"), level: 12 };
  const fine = hero("Fine");
  const dev = device(server, [broken, fine]);
  const s = await dev.engine.join("tok-ash", ASH);
  assert.equal(s.state, "error");
  assert.match(s.message, /Legacy/);
  assert.deepEqual([...server.rows.keys()], [fine.id]);
});

test("a roster left behind by another member is never pushed (no 403 loop)", async () => {
  const server = partyServer();
  const bos = hero("Bo's rogue");
  const bo = device(server, [bos]);
  await bo.engine.join("tok-bo", BO);
  const shared = device(server, [bos]);
  await shared.engine.join("tok-ash", ASH);
  shared.edit(bos.id, { notes: "scribbled" });
  await shared.engine.flush();
  await shared.engine.sync();
  assert.equal(server.writes().filter((c) => c.url.includes(bos.id)).length, 1, "only Bo's own create");
  assert.equal(server.body(bos.id).notes, "");
});

// A roster character whose server row another member owns can never be
// saved from here (the Worker answers 403). That must show as a sync problem,
// not "Synced": e.g. a player re-invited under a new member id, whose old id
// still owns their characters, or a roster left behind on a shared browser.
test("a local character owned by another member is reported, not silently left unsynced", async () => {
  const server = partyServer();
  const syrah = hero("Syrah");
  const first = device(server, [syrah]);
  await first.engine.join("tok-ash", ASH);
  const dev = device(server, [newCharacter(), syrah]);

  const joined = await dev.engine.join("tok-bo", BO);
  assert.equal(joined.state, "error");
  assert.match(joined.message, /Syrah/);
  assert.match(joined.message, /another party member/);

  dev.edit(syrah.id, { level: 4 });
  const pushed = await dev.engine.flush();
  assert.equal(pushed.state, "error", "a push pass that skips it says so too");
  assert.match(pushed.message, /Syrah/);
  assert.equal(server.writes().filter((c) => c.url.includes(syrah.id)).length, 1, "only the owner's create");
  assert.equal(server.body(syrah.id).level, syrah.level, "the edit stayed local");
});

// Pasting a roster (state.js importRoster) re-ids anything another member
// owns. The party list only shows live rows, so the engine says which ids
// are taken, tombstones included: a pasted id that matches one could never
// be uploaded.
test("foreignIds() holds every id another member owns, tombstones included, as a copy", async () => {
  const server = partyServer();
  const retired = hero("Bo's retired rogue");
  const rogue = hero("Bo's rogue");
  const bo = device(server, [retired, rogue]);
  await bo.engine.join("tok-bo", BO);
  bo.remove(retired.id);
  await bo.engine.sync();
  assert.equal(server.rows.get(retired.id).deleted, true);

  const syrah = hero("Syrah");
  const ash = device(server, [syrah]);
  assert.equal(ash.engine.foreignIds().size, 0, "nothing known before joining");
  await ash.engine.join("tok-ash", ASH);
  assert.deepEqual(ash.party.map((e) => e.id), [rogue.id], "the tombstone is not a party entry");
  const ids = ash.engine.foreignIds();
  assert.deepEqual([...ids].sort(), [retired.id, rogue.id].sort());
  ids.clear();
  assert.equal(ash.engine.foreignIds().size, 2, "callers get a copy");
  ash.engine.leave();
  assert.equal(ash.engine.foreignIds().size, 0);
});

// --- two tabs of the app ------------------------------------------------------------------------
// Tabs share one localStorage: the roster (js/state.js) and the sync meta
// (SYNC_KEY) alike. The engine re-reads meta on every run, so the roster it
// plans against must be the shared one too, not a tab's boot-time copy.

const ROSTER = "sotdl_ledger_v2";
let tabCount = 0;

// One js/state.js module instance per tab (a distinct URL is a distinct
// instance; what it imports is shared, as in a browser).
async function twoTabs(characters) {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.document ??= { getElementById: () => null };
  storage.setItem(ROSTER, JSON.stringify({ characters, activeId: characters[0].id }));
  const n = ++tabCount;
  const tabs = [await import(`../../state.js?tab=${n}a`), await import(`../../state.js?tab=${n}b`)];
  const server = partyServer();
  for (const tab of tabs) tab.load();
  const [a, b] = tabs.map((tab) => {
    const t = { state: tab, prompts: [] };
    // As js/ui/party.js wires the engine to state.js.
    t.engine = createSync({
      fetch: server.fetch,
      storage,
      timers: fakeTimers(),
      now: () => 5_000,
      getLocal: tab.ownCharacters,
      applyLocal: (x) => tab.applyRemote(x),
      resolveConflict: async (c) => {
        t.prompts.push(c);
        return "mine";
      },
    });
    return t;
  });
  return { server, storage, a, b, stored: () => JSON.parse(storage.getItem(ROSTER)).characters };
}

test("two tabs: closing a tab that never saw a character does not delete it", async () => {
  const syrah = hero("Syrah");
  const { server, storage, a, b, stored } = await twoTabs([syrah]);
  await a.engine.join("tok-ash", ASH);
  const phone = device(server, [newCharacter()]);
  await phone.engine.join("tok-ash", ASH);

  const xan = a.state.addCharacter("Xan");          // tab A only; tab B was opened before
  await a.engine.flush();
  assert.equal(server.rows.get(xan.id).deleted, false);

  const before = server.calls.length;
  b.engine.flush({ keepalive: true });                // tab B closes (pagehide)
  await b.engine.idle();
  assert.deepEqual(server.calls.slice(before).filter((c) => c.method === "DELETE").map((c) => c.url), []);
  assert.equal(server.rows.get(xan.id).deleted, false);
  await phone.engine.sync();
  assert.ok(phone.get(xan.id), "the phone keeps it");

  // Tab B's own next save keeps tab A's character.
  b.state.save();
  assert.ok(stored().some((c) => c.id === xan.id));
  assert.ok(JSON.parse(storage.getItem(SYNC_KEY)).meta[xan.id]);
});

test("two tabs: a stale tab's focus sync does not overwrite another device's edit", async () => {
  const syrah = hero("Syrah", { level: 2 });
  const { server, a, b, stored } = await twoTabs([syrah]);
  await a.engine.join("tok-ash", ASH);
  const phone = device(server, [newCharacter()]);
  await phone.engine.join("tok-ash", ASH);
  phone.edit(syrah.id, { level: 5, notes: "phone's work" });
  await phone.engine.flush();
  await a.engine.sync();                              // tab A pulls it; shared meta now at rev 2
  assert.equal(a.state.store.characters.find((c) => c.id === syrah.id).notes, "phone's work");

  const before = server.calls.length;
  assert.equal((await b.engine.sync()).state, "synced");   // tab B, untouched since boot, gets focus
  assert.deepEqual(server.calls.slice(before).filter((c) => c.method !== "GET"), [], "tab B writes nothing");
  assert.deepEqual(b.prompts, []);
  assert.equal(server.body(syrah.id).notes, "phone's work");

  b.state.save();
  assert.equal(stored().find((c) => c.id === syrah.id).notes, "phone's work", "tab B's save keeps it");
  await phone.engine.sync();
  assert.equal(phone.get(syrah.id).notes, "phone's work");
});

// --- keepalive, single flight, leave ------------------------------------------------------------------------------

test("flush({keepalive}) has the request on the wire before it returns", async () => {
  const { server, d1, a } = await twoDevices();
  d1.edit(a.id, { level: 9 });
  const n = server.calls.length;
  const pending = d1.engine.flush({ keepalive: true });
  assert.equal(server.calls.length, n + 1, "sent synchronously");
  assert.equal(server.calls.at(-1).method, "PUT");
  assert.equal(server.calls.at(-1).keepalive, true);
  await pending;
  assert.equal(server.body(a.id).level, 9);

  d1.edit(a.id, { level: 10 });
  d1.engine.schedule();
  d1.timers.runAll();
  await d1.engine.idle();
  assert.equal(server.calls.at(-1).keepalive, false, "ordinary pushes are not keepalive");
});

test("a keepalive flush never prompts; the conflict waits for the next sync", async () => {
  const { server, d1, d2, a } = await twoDevices();
  d1.edit(a.id, { notes: "from d1" });
  await d1.engine.flush();
  d2.edit(a.id, { notes: "from d2" });
  const meta = d2.meta();
  await d2.engine.flush({ keepalive: true });
  assert.deepEqual(d2.prompts, []);
  assert.deepEqual(d2.meta(), meta);
  assert.equal(server.body(a.id).notes, "from d1");
  d2.choice = "mine";
  await d2.engine.sync();
  assert.equal(d2.prompts.length, 1);
  assert.equal(server.body(a.id).notes, "from d2");
});

test("flush cancels a pending debounce", async () => {
  const { d1, a } = await twoDevices();
  d1.edit(a.id, { level: 1 });
  d1.engine.schedule();
  await d1.engine.flush();
  assert.deepEqual(d1.timers.pending(), []);
});

test("single flight: overlapping requests share one run plus one rerun", async () => {
  const { server, d1, a } = await twoDevices();
  server.maxInFlight = 0;
  const lists = server.lists().length;
  d1.edit(a.id, { level: 5 });
  const p1 = d1.engine.sync();
  const p2 = d1.engine.sync();
  d1.edit(a.id, { level: 6 });
  const p3 = d1.engine.flush();
  const p4 = d1.engine.sync();
  assert.equal(p2, p1);
  assert.equal(p3, p1);
  assert.equal(p4, p1);
  assert.equal((await p1).state, "synced");
  assert.equal(server.maxInFlight, 1, "never two requests at once");
  assert.equal(server.lists().length - lists, 2, "the first run and a single rerun");
  assert.equal(server.body(a.id).level, 6);
  const p5 = d1.engine.sync();
  assert.notEqual(p5, p1, "a request after the run settles starts a new one");
  await p5;
});

test("leave() forgets the token, meta and party cache but keeps the roster", async () => {
  const { server, d1 } = await twoDevices();
  const bo = device(server, [hero("Bo's rogue")]);
  await bo.engine.join("tok-bo", BO);
  await d1.engine.sync();
  const roster = d1.roster;
  d1.engine.leave();
  assert.equal(d1.storage.getItem(SYNC_KEY), null);
  assert.equal(d1.storage.getItem(PARTY_KEY), null);
  assert.equal(d1.engine.isJoined(), false);
  assert.equal(d1.engine.member(), null);
  assert.deepEqual(d1.engine.cachedParty(), []);
  assert.equal(d1.statuses.at(-1).state, "off");
  assert.equal(d1.roster, roster);
  const calls = server.calls.length;
  d1.engine.schedule();
  assert.deepEqual(d1.timers.pending(), []);
  assert.equal((await d1.engine.sync()).state, "off");
  assert.equal(server.calls.length, calls);
});

test("leave() during a run stops it from writing sync state back", async () => {
  const { d1, a } = await twoDevices();
  d1.edit(a.id, { level: 4 });
  const running = d1.engine.sync();
  d1.engine.leave();
  await running;
  assert.equal(d1.storage.getItem(SYNC_KEY), null);
  assert.equal(d1.storage.getItem(PARTY_KEY), null);
  assert.equal(d1.statuses.at(-1).state, "off");
});

// `cf invite <name>` for an existing member re-issues their link: same member
// id, new token. Opening it on a device still holding the old (now revoked)
// token must store the new one without forgetting what this device has
// synced, or every unsynced edit would come back as a conflict.
test("joining with a re-issued link for the same member keeps this device's sync state", async () => {
  const { server, d1, a } = await twoDevices();
  server.members.delete("tok-ash");
  server.addMember("tok-ash-2", ASH.id, ASH.name);
  d1.edit(a.id, { notes: "while the old link was dead" });
  assert.equal((await d1.engine.flush()).state, "error", "the old token is refused");

  const status = await d1.engine.join("tok-ash-2", ASH);
  assert.equal(status.state, "synced");
  assert.deepEqual(d1.prompts, []);
  assert.equal(server.body(a.id).notes, "while the old link was dead");
  assert.equal(d1.state().token, "tok-ash-2");
  assert.deepEqual(d1.engine.member(), ASH);
});

test("join() refuses an empty token", async () => {
  const dev = device(partyServer());
  await assert.rejects(dev.engine.join("", ASH), TypeError);
  assert.equal(dev.engine.isJoined(), false);
});
