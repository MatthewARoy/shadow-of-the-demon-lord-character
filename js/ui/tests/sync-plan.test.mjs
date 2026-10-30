import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, hashCharacter } from "../../sync/hash.js";
import { planSync, planPush, isPristine } from "../../sync/plan.js";
import { newCharacter } from "../../engine.js";

// --- fixtures -----------------------------------------------------------------

const ME = { id: "m1" };

// A non-pristine character with a fixed id.
const char = (id, patch = {}) => ({ ...newCharacter(), id, name: `Hero ${id}`, ...patch });
const pristine = (id) => ({ ...newCharacter(), id });

const row = (c, { rev = 1, ownerId = "m1", ownerName = "Ash", deleted = false, updatedAt = 1000 } = {}) => ({
  id: c.id, ownerId, ownerName, rev, updatedAt, deleted, body: deleted ? null : structuredClone(c),
});
const tomb = (id, rev, ownerId = "m1") => ({ id, ownerId, ownerName: "Ash", rev, updatedAt: 1000, deleted: true, body: null });
const remote = (...rows) => ({ me: { id: "m1", name: "Ash" }, characters: rows });
const metaOf = (c, rev) => ({ [c.id]: { rev, hash: hashCharacter(c) } });

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// Everything empty except the lists named in `expect`.
function assertPlan(plan, expect) {
  for (const key of ["creates", "updates", "deletes", "pulls", "adds", "removes", "conflicts", "adopts", "forgets", "party"]) {
    assert.deepEqual(plan[key], expect[key] ?? [], `plan.${key}`);
  }
}

// --- hash.js ------------------------------------------------------------------

test("canonicalJson sorts keys at every level and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[3,1,{"y":2,"z":1}]},"b":1}');
});

test("canonicalJson follows JSON.stringify for undefined, functions and non-finite numbers", () => {
  const value = { keep: "x", gone: undefined, fn: () => 1, arr: [undefined, NaN, Infinity, -0], date: new Date(0) };
  assert.equal(canonicalJson(value), canonicalJson(JSON.parse(JSON.stringify(value))));
  assert.equal(canonicalJson(value), '{"arr":[null,null,null,0],"date":"1970-01-01T00:00:00.000Z","keep":"x"}');
  assert.equal(canonicalJson([1, , 3]), JSON.stringify([1, , 3]));
});

test("hashCharacter ignores key order and survives a JSON round trip", () => {
  const c = char("a", { notes: "née “Vesper”\n— naïve", decisions: { "creation:prof:0": { pick: 3 } } });
  const reversed = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(hashCharacter(reversed), hashCharacter(c));
  assert.equal(hashCharacter(JSON.parse(JSON.stringify({ ...c, stray: undefined }))), hashCharacter(c));
});

test("hashCharacter is fixed-width hex, deterministic, and tells edits apart", () => {
  const c = char("a");
  assert.match(hashCharacter(c), /^[0-9a-f]{14}$/);
  assert.equal(hashCharacter(c), hashCharacter(structuredClone(c)));
  assert.notEqual(hashCharacter({ ...c, level: 1 }), hashCharacter(c));
  assert.notEqual(hashCharacter({ ...c, decisions: { x: [1, 2] } }), hashCharacter({ ...c, decisions: { x: [2, 1] } }));
});

// --- isPristine -----------------------------------------------------------------

test("isPristine: newCharacter() is pristine whatever its id or key order", () => {
  assert.equal(isPristine(newCharacter()), true);
  assert.equal(isPristine(pristine("zzz")), true);
  assert.equal(isPristine(Object.fromEntries(Object.entries(newCharacter()).reverse())), true);
});

test("isPristine: any edit, extra key or missing key makes it not pristine", () => {
  assert.equal(isPristine({ ...newCharacter(), name: "Syrah" }), false);
  assert.equal(isPristine({ ...newCharacter(), level: 1 }), false);
  assert.equal(isPristine({ ...newCharacter(), inventory: [{ id: "i", name: "Staff" }] }), false);
  assert.equal(isPristine({ ...newCharacter(), dataRev: "abc" }), false);
  const { notes: _notes, ...missing } = newCharacter();
  assert.equal(isPristine(missing), false);
  assert.equal(isPristine(null), false);
});

// --- own rows: remote live --------------------------------------------------------

test("remote live, not local, not in meta → add (made on another device)", () => {
  const a = char("a");
  const plan = planSync({ local: [], meta: {}, remote: remote(row(a, { rev: 3 })), me: ME });
  assertPlan(plan, { adds: [{ id: "a", rev: 3, character: row(a).body }] });
});

test("remote live, not local, in meta → delete with baseRev = meta.rev", () => {
  const a = char("a");
  const plan = planSync({ local: [], meta: metaOf(a, 2), remote: remote(row(a, { rev: 2 })), me: ME });
  assertPlan(plan, { deletes: [{ id: "a", baseRev: 2 }] });
});

test("remote live, local, rev === meta.rev: local edited → update; untouched → nothing", () => {
  const a = char("a");
  const edited = { ...a, level: 2 };
  const meta = metaOf(a, 4);
  assertPlan(planSync({ local: [edited], meta, remote: remote(row(a, { rev: 4 })), me: ME }),
    { updates: [{ id: "a", baseRev: 4, character: edited }] });
  assertPlan(planSync({ local: [a], meta, remote: remote(row(a, { rev: 4 })), me: ME }), {});
});

test("remote live, local, rev > meta.rev: local untouched → pull", () => {
  const a = char("a");
  const theirs = { ...a, level: 5 };
  const plan = planSync({ local: [a], meta: metaOf(a, 1), remote: remote(row(theirs, { rev: 2 })), me: ME });
  assertPlan(plan, { pulls: [{ id: "a", rev: 2, character: theirs }] });
});

test("remote live, local, rev > meta.rev: local edited too → conflict carrying the server's rev and body", () => {
  const a = char("a");
  const mine = { ...a, level: 3 };
  const theirs = { ...a, level: 5 };
  const plan = planSync({ local: [mine], meta: metaOf(a, 1), remote: remote(row(theirs, { rev: 2 })), me: ME });
  assertPlan(plan, { conflicts: [{ id: "a", name: "Hero a", rev: 2, character: theirs }] });
});

test("remote live, local, rev > meta.rev, both edited to the same body → adopt (a lost keepalive ack)", () => {
  const a = char("a");
  const sent = { ...a, level: 3 };
  const plan = planSync({ local: [sent], meta: metaOf(a, 1), remote: remote(row(sent, { rev: 2 })), me: ME });
  assertPlan(plan, { adopts: [{ id: "a", rev: 2, hash: hashCharacter(sent) }] });
});

test("remote live, local, not in meta: same body → adopt rev; different → conflict", () => {
  const a = char("a");
  assertPlan(planSync({ local: [a], meta: {}, remote: remote(row(a, { rev: 7 })), me: ME }),
    { adopts: [{ id: "a", rev: 7, hash: hashCharacter(a) }] });
  const theirs = { ...a, notes: "other device" };
  assertPlan(planSync({ local: [a], meta: {}, remote: remote(row(theirs, { rev: 7 })), me: ME }),
    { conflicts: [{ id: "a", name: "Hero a", rev: 7, character: theirs }] });
});

test("bodies equal up to key order count as unchanged (key order drifts after a pull)", () => {
  const a = char("a");
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const r = { ...row(a, { rev: 4 }), body: reordered };
  assertPlan(planSync({ local: [a], meta: metaOf(reordered, 4), remote: remote(r), me: ME }), {});
});

// --- own rows: tombstones -------------------------------------------------------------

test("remote tombstone, local, in meta: untouched → remove", () => {
  const a = char("a");
  const plan = planSync({ local: [a], meta: metaOf(a, 2), remote: remote(tomb("a", 3)), me: ME });
  assertPlan(plan, { removes: [{ id: "a" }] });
});

test("remote tombstone, local, in meta: edited here → update with baseRev = remote.rev (undelete)", () => {
  const a = char("a");
  const edited = { ...a, damage: 4 };
  const plan = planSync({ local: [edited], meta: metaOf(a, 2), remote: remote(tomb("a", 3)), me: ME });
  assertPlan(plan, { updates: [{ id: "a", baseRev: 3, character: edited }] });
});

test("remote tombstone, local, not in meta → update with baseRev = remote.rev (undelete-create)", () => {
  const a = char("a");
  const plan = planSync({ local: [a], meta: {}, remote: remote(tomb("a", 5)), me: ME });
  assertPlan(plan, { updates: [{ id: "a", baseRev: 5, character: a }] });
});

test("remote tombstone, local pristine, not in meta → nothing", () => {
  const p = pristine("a");
  assertPlan(planSync({ local: [p], meta: {}, remote: remote(tomb("a", 5)), me: ME }), {});
});

test("remote tombstone, not local: in meta → forget the meta entry; not in meta → nothing", () => {
  const a = char("a");
  assertPlan(planSync({ local: [], meta: metaOf(a, 2), remote: remote(tomb("a", 3)), me: ME }), { forgets: ["a"] });
  assertPlan(planSync({ local: [], meta: {}, remote: remote(tomb("a", 3)), me: ME }), {});
});

// --- local only ---------------------------------------------------------------------------

test("local, absent from remote, not pristine → create with baseRev 0", () => {
  const a = char("a");
  assertPlan(planSync({ local: [a], meta: {}, remote: remote(), me: ME }),
    { creates: [{ id: "a", baseRev: 0, character: a }] });
});

test("local, absent from remote but in meta (server reset) → create again", () => {
  const a = char("a");
  assertPlan(planSync({ local: [a], meta: metaOf(a, 9), remote: remote(), me: ME }),
    { creates: [{ id: "a", baseRev: 0, character: a }] });
});

test("pristine characters are never uploaded", () => {
  assertPlan(planSync({ local: [pristine("p")], meta: {}, remote: remote(), me: ME }), {});
});

test("a meta entry with nothing local or remote is forgotten", () => {
  const a = char("a");
  assertPlan(planSync({ local: [], meta: metaOf(a, 2), remote: remote(), me: ME }), { forgets: ["a"] });
});

test("a local character whose id another member owns is never created (shared browser)", () => {
  const theirs = char("t");
  const plan = planSync({ local: [theirs], meta: {}, remote: remote(row(theirs, { ownerId: "m2", ownerName: "Bo" })), me: ME });
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.party.map((e) => e.id), ["t"]);
});

// --- the pristine placeholder ---------------------------------------------------------------

test("an arriving add removes the lone pristine, unsynced placeholder", () => {
  const p = pristine("p");
  const a = char("a");
  const plan = planSync({ local: [p], meta: {}, remote: remote(row(a)), me: ME });
  assertPlan(plan, { adds: [{ id: "a", rev: 1, character: row(a).body }], removes: [{ id: "p" }] });
});

test("the placeholder stays when nothing arrives, or when it is not alone", () => {
  const p = pristine("p");
  const b = char("b");
  assertPlan(planSync({ local: [p], meta: {}, remote: remote(), me: ME }), {});
  const plan = planSync({ local: [p, b], meta: {}, remote: remote(row(char("a"))), me: ME });
  assert.deepEqual(plan.removes, []);
  assert.deepEqual(plan.creates.map((c) => c.id), ["b"]);
});

test("a lone character that is not pristine is never removed by an add", () => {
  const b = char("b");
  const plan = planSync({ local: [b], meta: {}, remote: remote(row(char("a"))), me: ME });
  assert.deepEqual(plan.removes, []);
  assert.deepEqual(plan.creates.map((c) => c.id), ["b"]);
});

test("planSync uses an injected isPristine", () => {
  const a = char("a");
  const plan = planSync({ local: [a], meta: {}, remote: remote(), me: ME, isPristine: () => true });
  assertPlan(plan, {});
});

// --- party ----------------------------------------------------------------------------------------

test("other members' live rows become party entries; their tombstones do not", () => {
  const t = char("t", { name: "Bo's rogue" });
  const plan = planSync({
    local: [], meta: {}, me: ME,
    remote: remote(row(t, { ownerId: "m2", ownerName: "Bo", rev: 4, updatedAt: 1234 }), tomb("u", 2, "m2")),
  });
  assertPlan(plan, {
    party: [{ id: "t", ownerId: "m2", ownerName: "Bo", rev: 4, updatedAt: 1234, character: row(t).body }],
  });
});

test("party entries whose body fails validation or names another id are dropped", () => {
  const good = char("good");
  const badLevel = { ...row(char("bad"), { ownerId: "m2" }), body: { ...char("bad"), level: 99 } };
  const exchanges = { ...row(char("ex"), { ownerId: "m2" }), body: { ...char("ex"), exchanges: [{}] } };
  const wrongId = { ...row(char("w"), { ownerId: "m2" }), body: char("someone-else") };
  const plan = planSync({
    local: [], meta: {}, me: ME,
    remote: remote(row(good, { ownerId: "m2" }), badLevel, exchanges, wrongId),
  });
  assert.deepEqual(plan.party.map((e) => e.id), ["good"]);
});

test("own rows never appear in the party", () => {
  const a = char("a");
  const plan = planSync({ local: [a], meta: metaOf(a, 1), remote: remote(row(a)), me: ME });
  assert.deepEqual(plan.party, []);
});

test("malformed rows are ignored rather than crashing the plan", () => {
  const plan = planSync({
    local: [], meta: {}, me: ME,
    remote: remote(null, { id: 5 }, { id: "x", ownerId: "m1" }, { id: "y", ownerId: "m1", rev: "2" }),
  });
  assertPlan(plan, {});
  assertPlan(planSync({ local: [], meta: {}, remote: null, me: ME }), {});
});

test("planSync never mutates its inputs", () => {
  const a = char("a");
  const b = char("b", { level: 2 });
  const p = pristine("p");
  const local = deepFreeze([{ ...a, level: 1 }, b, p]);
  const meta = deepFreeze({ ...metaOf(a, 1), ghost: { rev: 1, hash: "0" } });
  const r = deepFreeze(remote(row(a, { rev: 2 }), row(char("c")), tomb("d", 2), row(char("t"), { ownerId: "m2" })));
  assert.doesNotThrow(() => planSync({ local, meta, remote: r, me: ME }));
});

// --- planPush ------------------------------------------------------------------------------------

test("planPush: edited → update at meta.rev, new → create, gone → delete, pristine and untouched → nothing", () => {
  const a = char("a");
  const editedA = { ...a, level: 4 };
  const same = char("s");
  const fresh = char("n");
  const gone = char("g");
  const plan = planPush({
    local: deepFreeze([editedA, same, fresh, pristine("p")]),
    meta: { ...metaOf(a, 3), ...metaOf(same, 1), ...metaOf(gone, 6) },
  });
  assert.deepEqual(plan, {
    creates: [{ id: "n", baseRev: 0, character: fresh }],
    updates: [{ id: "a", baseRev: 3, character: editedA }],
    deletes: [{ id: "g", baseRev: 6 }],
  });
});
