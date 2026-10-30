// Party sync engine: pull → plan → apply → push against the Worker's /api/*.
//
// localStorage stays the source of truth for this player's own characters;
// the server is a copy that other devices and party members read. Nothing
// here touches the DOM — the roster, the clock, timers, storage and fetch are
// all parameters, so node --test drives the whole engine against an in-memory
// server. js/main.js owns the wiring (when to sync, what to render).
//
// Two kinds of run share one single-flight loop, so they never overlap:
//   full  (sync())             list() → planSync → applyLocal → pushes → party
//   push  (schedule(), flush()) planPush from local + meta → pushes, no list()
// A request made while a run is in flight marks a rerun and gets the running
// promise, which settles once every queued run has finished.
//
// meta ({[id]: {rev, hash}}) only moves on a definite answer: a 2xx, a 409
// the engine resolved, or a pull/add that landed in the roster. A network
// failure leaves it untouched, so the next run re-plans and re-sends.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Client sync").

import { createApi, SyncNetworkError } from "./api.js";
import { planSync, planPush, isPristine, bodyMatches } from "./plan.js";
import { hashCharacter } from "./hash.js";
import { validateCharacter } from "./validate.js";

export { SyncNetworkError };

export const SYNC_KEY = "sotdl_sync_v1";    // {token, member: {id, name}, meta}
export const PARTY_KEY = "sotdl_party_v1";  // {updatedAt, entries: [party entry…]}

// "Keep mine" retries with the server's rev; if another device keeps winning
// the race, give up for this run rather than ping-pong forever.
const MAX_ATTEMPTS = 3;

class AuthLost extends Error {}

// The engine never mutates roster objects. A JSON round trip is both the
// defensive copy and exactly what the wire carries, so the hash recorded in
// meta is the hash of what the server received.
const snapshot = (c) => JSON.parse(JSON.stringify(c));

const isMember = (m) =>
  m !== null && typeof m === "object" && typeof m.id === "string" && m.id && typeof m.name === "string";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const label = (name, id) => `“${typeof name === "string" && name ? name : id}”`;

const defaultStorage = () => (typeof localStorage === "undefined" ? null : localStorage);

export function createSync({
  fetch = (...args) => globalThis.fetch(...args),
  storage = defaultStorage(),
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  getLocal,
  applyLocal,
  onParty = () => {},
  resolveConflict = async () => null,
  onStatus = () => {},
  isUsable = () => true,
  base = "/api",
  debounceMs = 1500,
}) {
  // Called bare (not as timers.setTimeout) so the browser's own functions
  // keep their expected `this`.
  const { setTimeout: setTimer, clearTimeout: clearTimer } = timers;

  let epoch = 0;          // bumped by join()/leave(); a run from an older epoch stops writing
  let running = null;     // the in-flight loop's promise
  let wantFull = false;
  let wantPush = null;    // {keepalive} when a push run is queued
  let timer = null;       // schedule()'s debounce
  let blocked = new Set(); // ids another member owns (from list() or a 403): never pushed
  let lastStatus = { state: "off", message: "Not in a party on this device." };

  // --- storage ---------------------------------------------------------------
  // Blocked or full storage degrades to "not joined" / "no cache", never a
  // throw during boot (same stance as js/consent.js).

  function readJson(key) {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      storage?.setItem(key, JSON.stringify(value));
      return Boolean(storage);
    } catch (err) {
      console.warn(`Party sync: could not save ${key}`, err);
      return false;
    }
  }

  function removeKey(key) {
    try {
      storage?.removeItem(key);
    } catch {
      // Nothing to do: the next read fails the same way and reads as empty.
    }
  }

  // Meta lives in a null-prototype object: character ids are any string up
  // to 100 characters, "__proto__" included.
  function readState() {
    const s = readJson(SYNC_KEY);
    if (!s || typeof s !== "object" || typeof s.token !== "string" || !s.token) return null;
    const meta = Object.create(null);
    if (s.meta && typeof s.meta === "object") {
      for (const [id, m] of Object.entries(s.meta)) {
        if (m && Number.isSafeInteger(m.rev) && typeof m.hash === "string") meta[id] = { rev: m.rev, hash: m.hash };
      }
    }
    return { token: s.token, member: isMember(s.member) ? { id: s.member.id, name: s.member.name } : null, meta };
  }

  // --- callbacks ---------------------------------------------------------------

  function setStatus(state, message) {
    lastStatus = { state, message };
    try {
      onStatus({ ...lastStatus });
    } catch (err) {
      console.error("Party sync: onStatus failed", err);
    }
    return lastStatus;
  }

  function usable(body) {
    try {
      return Boolean(isUsable(body));
    } catch {
      return false;   // e.g. compute() throws on it: skip rather than crash a render
    }
  }

  // An own-row body about to enter the roster.
  function acceptable(id, body) {
    if (!bodyMatches(id, body)) {
      const why = validateCharacter(body).errors[0] ?? "its id does not match";
      console.warn(`Party sync: skipping character ${id} from the server: ${why}`);
      return false;
    }
    if (!usable(body)) {
      console.warn(`Party sync: skipping character ${id} from the server: this version of the app cannot open it`);
      return false;
    }
    return true;
  }

  // kind: "edit" (both sides changed it) or "delete" (deleted here, changed
  // on another device: "mine" deletes it everywhere).
  async function ask(ctx, id, name, kind) {
    // No prompts during a keepalive flush: browsers suppress dialogs while a
    // page unloads, and a dismissed one must not read as "theirs". The
    // conflict stays unresolved (meta untouched) and comes back next sync.
    if (ctx.keepalive) return null;
    try {
      return await resolveConflict({ id, name, kind });
    } catch (err) {
      console.warn("Party sync: conflict prompt failed", err);
      return null;
    }
  }

  // --- one run's context ---------------------------------------------------------

  function newContext(gen, state, keepalive) {
    const ctx = {
      api: createApi({ fetch, token: state.token, base }),
      token: state.token,
      member: state.member,
      meta: state.meta,
      keepalive,
      problems: [],
      alive: () => epoch === gen,
      persist() {
        if (ctx.alive()) writeJson(SYNC_KEY, { token: ctx.token, member: ctx.member, meta: ctx.meta });
      },
    };
    return ctx;
  }

  // Record {rev, hash} for ids that really are in the roster now, hashing the
  // stored copy so an applyLocal that normalizes a body does not read as a
  // local edit next time. An id applyLocal declined stays out of meta — with
  // meta claiming it, the next plan would read its absence as a delete.
  function stamp(ctx, revs) {
    const stored = new Map(getLocal().map((c) => [c.id, c]));
    for (const [id, rev] of revs) {
      if (stored.has(id)) ctx.meta[id] = { rev, hash: hashCharacter(stored.get(id)) };
    }
    return stored;
  }

  // The server's copy wins (a "theirs" answer to a push-time 409).
  async function takeTheirs(ctx, id, rev, body) {
    if (!acceptable(id, body)) {
      ctx.problems.push(`The other version of ${label(body?.name, id)} could not be loaded.`);
      return;
    }
    const present = getLocal().some((c) => c.id === id);
    const copy = snapshot(body);
    await applyLocal({ adds: present ? [] : [copy], pulls: present ? [copy] : [], removes: [] });
    if (!ctx.alive()) return;
    stamp(ctx, [[id, rev]]);
    ctx.persist();
  }

  // --- pushes -------------------------------------------------------------------
  // Each op re-reads the roster at send time: the plan may be a few awaits
  // old, and the newest local state is what should go up.

  async function pushPut(ctx, id, baseRev) {
    if (blocked.has(id)) return;
    const current = getLocal().find((c) => c.id === id);
    if (!current) return;                       // deleted since the plan; re-planned next run
    const body = snapshot(current);
    const check = validateCharacter(body);
    if (!check.ok) {
      console.warn(`Party sync: not uploading ${id}:`, check.errors);
      ctx.problems.push(`${label(body.name, id)} cannot be uploaded (${check.errors[0]}).`);
      return;
    }
    const hash = hashCharacter(body);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // fetch() is reached with no await before it, so flush() from a
      // pagehide handler has the request on the wire before returning.
      const res = await ctx.api.put(id, baseRev, body, { keepalive: ctx.keepalive });
      if (!ctx.alive()) return;
      const d = res.data;
      if (res.status === 200 && Number.isSafeInteger(d?.rev)) {
        ctx.meta[id] = { rev: d.rev, hash };
        ctx.persist();
        return;
      }
      if (res.status === 401) throw new AuthLost();
      if (res.status === 409 && Number.isSafeInteger(d?.rev)) {
        // Deleted on another device while edited here: this device's edits
        // win and bring it back (the planner's tombstone rule). Checked before
        // the hash so a tombstone's rev is never adopted for a live character.
        if (d.deleted) {
          baseRev = d.rev;
          continue;
        }
        // Our own earlier write whose answer was lost: the server already has
        // exactly this body.
        if (hashCharacter(d.body) === hash) {
          ctx.meta[id] = { rev: d.rev, hash };
          ctx.persist();
          return;
        }
        const choice = await ask(ctx, id, body.name, "edit");
        if (!ctx.alive()) return;
        if (choice === "mine") {
          baseRev = d.rev;
          continue;
        }
        if (choice === "theirs") await takeTheirs(ctx, id, d.rev, d.body);
        return;                                 // undecided: ask again next sync
      }
      if (res.status === 403) blocked.add(id);
      console.warn(`Party sync: upload of ${id} refused (HTTP ${res.status})`, d);
      ctx.problems.push(`${label(body.name, id)} was not uploaded (${refusal(res)}).`);
      return;
    }
    ctx.problems.push(`${label(body.name, id)} keeps changing on another device; it will be retried.`);
  }

  async function pushDel(ctx, id, baseRev) {
    if (getLocal().some((c) => c.id === id)) return;   // back in the roster since the plan
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await ctx.api.del(id, baseRev, { keepalive: ctx.keepalive });
      if (!ctx.alive()) return;
      const d = res.data;
      if (res.status === 200 || res.status === 404) {
        delete ctx.meta[id];
        ctx.persist();
        return;
      }
      if (res.status === 401) throw new AuthLost();
      if (res.status === 409 && Number.isSafeInteger(d?.rev)) {
        if (d.deleted) {                          // another device deleted it too
          delete ctx.meta[id];
          ctx.persist();
          return;
        }
        // Edited on another device after this one last synced. Deleting it
        // anyway would silently throw that work away, so ask.
        const choice = await ask(ctx, id, d.body?.name, "delete");
        if (!ctx.alive()) return;
        if (choice === "mine") {
          baseRev = d.rev;
          continue;
        }
        if (choice === "theirs") await takeTheirs(ctx, id, d.rev, d.body);
        return;
      }
      console.warn(`Party sync: delete of ${id} refused (HTTP ${res.status})`, d);
      ctx.problems.push(`A deleted character was not removed from the party (${refusal(res)}).`);
      return;
    }
    ctx.problems.push("A deleted character keeps changing on another device; it will be retried.");
  }

  const refusal = (res) => (typeof res.data?.error === "string" ? res.data.error : `HTTP ${res.status}`);

  // A roster character this device can never save (another member owns its
  // row): the status must not read "Synced" while its edits stay local.
  const foreign = (ctx, id, name) =>
    ctx.problems.push(`${label(name, id)} belongs to another party member and is not being saved online.`);

  // Serially, stopping at the first network or auth failure; returns it.
  async function runPushes(ctx, ops) {
    for (const op of ops) {
      if (!ctx.alive()) return null;
      try {
        if (op.kind === "put") await pushPut(ctx, op.id, op.baseRev);
        else await pushDel(ctx, op.id, op.baseRev);
      } catch (err) {
        if (err instanceof SyncNetworkError || err instanceof AuthLost) return err;
        throw err;
      }
    }
    return null;
  }

  const puts = (list) => list.map(({ id, baseRev }) => ({ kind: "put", id, baseRev }));
  const dels = (list) => list.map(({ id, baseRev }) => ({ kind: "del", id, baseRev }));

  function finish(ctx, err) {
    if (err instanceof AuthLost) return authLost();
    if (err instanceof SyncNetworkError) return offline(err);
    if (ctx.problems.length) {
      const more = ctx.problems.length > 1 ? ` (+${ctx.problems.length - 1} more)` : "";
      return setStatus("error", `${ctx.problems[0]}${more}`);
    }
    return setStatus("synced", "Synced with the party.");
  }

  const authLost = () =>
    setStatus("error", "This device's party invite is no longer valid. Ask for a new invite link.");

  function offline(err) {
    const kept = "Changes are kept on this device and will sync later.";
    if (err.status === 429) return setStatus("offline", `The party server is busy. ${kept}`);
    if (err.status) return setStatus("offline", `The party server is unavailable. ${kept}`);
    return setStatus("offline", `Offline. ${kept}`);
  }

  // --- the two kinds of run --------------------------------------------------------

  async function fullSync(gen) {
    const state = readState();
    if (!state) return setStatus("off", "Not in a party on this device.");
    const ctx = newContext(gen, state, false);
    setStatus("syncing", "Syncing with the party…");

    let res;
    try {
      res = await ctx.api.list();
    } catch (err) {
      if (!ctx.alive()) return lastStatus;
      if (err instanceof SyncNetworkError) return offline(err);
      throw err;
    }
    if (!ctx.alive()) return lastStatus;
    if (res.status === 401) return authLost();
    if (res.status !== 200 || !Array.isArray(res.data?.characters)) {
      return setStatus("error", `Unexpected answer from the party server (HTTP ${res.status}).`);
    }
    if (isMember(res.data.me)) ctx.member = { id: res.data.me.id, name: res.data.me.name };
    if (!ctx.member) return setStatus("error", "The party server did not say who this device belongs to.");
    const me = ctx.member;

    const rows = res.data.characters;
    blocked = new Set(rows.filter((r) => r && r.ownerId !== me.id && typeof r.id === "string").map((r) => r.id));
    const plan = planSync({ local: getLocal(), meta: ctx.meta, remote: res.data, me });
    const party = plan.party.filter((e) => usable(e.character));

    for (const f of plan.foreign) foreign(ctx, f.id, f.name);
    for (const a of plan.adopts) ctx.meta[a.id] = { rev: a.rev, hash: a.hash };
    for (const id of plan.forgets) delete ctx.meta[id];
    ctx.persist();

    // Ask about every conflict first, then touch the roster once.
    const updates = [...plan.updates];
    const theirs = [];
    for (const k of plan.conflicts) {
      const choice = await ask(ctx, k.id, k.name, "edit");
      if (!ctx.alive()) return lastStatus;
      if (choice === "mine") updates.push({ id: k.id, baseRev: k.rev });
      else if (choice === "theirs") theirs.push(k);
    }

    await applyIncoming(ctx, plan, theirs);
    if (!ctx.alive()) return lastStatus;

    const err = await runPushes(ctx, [...puts(plan.creates), ...puts(updates), ...dels(plan.deletes)]);
    if (!ctx.alive()) return lastStatus;

    // The list() answer is good even when a push failed afterwards.
    try {
      onParty(party);
    } catch (e) {
      console.error("Party sync: onParty failed", e);
    }
    writeJson(PARTY_KEY, { updatedAt: now(), entries: party });
    return finish(ctx, err);
  }

  // adds, pulls and removes from the plan plus "theirs" conflict answers, in
  // one applyLocal call. The plan may predate a conflict prompt, so each
  // entry is re-checked against the roster as it is now.
  async function applyIncoming(ctx, plan, theirs) {
    const current = new Map(getLocal().map((c) => [c.id, c]));
    const unchanged = (id) =>
      current.has(id) && has(ctx.meta, id) && hashCharacter(current.get(id)) === ctx.meta[id].hash;
    const out = { adds: [], pulls: [], removes: [] };
    const revs = [];

    for (const a of plan.adds) {
      if (current.has(a.id) || !acceptable(a.id, a.character)) continue;
      out.adds.push(snapshot(a.character));
      revs.push([a.id, a.rev]);
    }
    for (const p of plan.pulls) {
      if (!unchanged(p.id) || !acceptable(p.id, p.character)) continue;   // edited meanwhile: a conflict next run
      out.pulls.push(snapshot(p.character));
      revs.push([p.id, p.rev]);
    }
    for (const k of theirs) {
      if (!acceptable(k.id, k.character)) {
        ctx.problems.push(`The other version of ${label(k.name, k.id)} could not be loaded.`);
        continue;
      }
      (current.has(k.id) ? out.pulls : out.adds).push(snapshot(k.character));
      revs.push([k.id, k.rev]);
    }
    for (const { id } of plan.removes) {
      const c = current.get(id);
      if (!c) continue;
      // Not in meta means the pristine placeholder, which only gives way to
      // characters that actually arrive (not ones skipped above).
      if (has(ctx.meta, id) ? unchanged(id) : isPristine(c) && out.adds.length) out.removes.push(id);
    }
    if (!out.adds.length && !out.pulls.length && !out.removes.length) return;

    await applyLocal(out);
    if (!ctx.alive()) return;
    const stored = stamp(ctx, revs);
    for (const id of out.removes) {
      if (!stored.has(id)) delete ctx.meta[id];
    }
    ctx.persist();
  }

  async function pushPass(gen, { keepalive }) {
    const state = readState();
    if (!state) return lastStatus;
    const ctx = newContext(gen, state, keepalive);
    const local = getLocal();
    const plan = planPush({ local, meta: ctx.meta });
    const planned = [...puts(plan.creates), ...puts(plan.updates), ...dels(plan.deletes)];
    const ops = planned.filter((op) => !blocked.has(op.id));
    for (const op of planned) {
      if (op.kind === "put" && blocked.has(op.id)) foreign(ctx, op.id, local.find((c) => c.id === op.id)?.name);
    }
    if (!ops.length) return ctx.problems.length ? finish(ctx, null) : lastStatus;
    setStatus("syncing", "Saving to the party…");
    const err = await runPushes(ctx, ops);
    if (!ctx.alive()) return lastStatus;
    return finish(ctx, err);
  }

  // --- single flight ---------------------------------------------------------------

  async function loop() {
    let result = lastStatus;
    while (wantFull || wantPush) {
      const gen = epoch;
      let run;
      if (wantFull) {
        wantFull = false;
        wantPush = null;          // a full run pushes too
        run = fullSync(gen);
      } else {
        const opts = wantPush;
        wantPush = null;
        run = pushPass(gen, opts);
      }
      try {
        result = await run;
      } catch (err) {
        console.error("Party sync failed", err);
        result = epoch === gen ? setStatus("error", `Sync failed: ${err?.message ?? err}`) : lastStatus;
      }
    }
    // Cleared here, in the same tick the loop sees nothing queued, so a
    // request can never attach to a loop that has already decided to stop.
    // (The loop always awaits at least once, so `running` is assigned by then.)
    running = null;
    return result;
  }

  function request(kind, keepalive = false) {
    if (kind === "full") wantFull = true;
    else wantPush = { keepalive: keepalive || wantPush?.keepalive === true };
    if (!running) running = loop();
    return running;
  }

  // Full pull → plan → apply → push. Never rejects: resolves the final
  // {state, message} (also reported through onStatus).
  function sync() {
    if (!readState()) return Promise.resolve(setStatus("off", "Not in a party on this device."));
    return request("full");
  }

  // --- public API ----------------------------------------------------------------------

  return {
    // Check an invite token with /api/me before storing anything.
    // Resolves {id, name}; rejects on a bad token (or SyncNetworkError).
    async probe(token) {
      const res = await createApi({ fetch, token, base }).me();
      if (res.status === 401) {
        throw new Error("This invite link is not valid. It may have been revoked or copied incompletely.");
      }
      if (res.status !== 200 || !isMember(res.data)) {
        throw new Error(`Could not check the invite (HTTP ${res.status}).`);
      }
      return { id: res.data.id, name: res.data.name };
    },

    // Store the token and run the first sync. Resolves like sync(); rejects
    // only when there is no token or storage will not keep it. A new token
    // for the member this device is already in the party as (a re-issued
    // invite) keeps meta: the rows it describes are still that member's.
    async join(token, member) {
      if (typeof token !== "string" || !token) throw new TypeError("join() needs an invite token");
      const prior = readState();
      const same = isMember(member) && prior?.member?.id === member.id;
      epoch++;
      wantFull = false;
      wantPush = null;
      blocked = new Set();
      const saved = writeJson(SYNC_KEY, {
        token,
        member: isMember(member) ? { id: member.id, name: member.name } : null,
        meta: same ? prior.meta : {},
      });
      if (!saved) throw new Error("This browser would not save the invite (storage is full or blocked).");
      removeKey(PARTY_KEY);
      return sync();
    },

    // Forget the token, sync state and party cache. The roster is untouched.
    leave() {
      epoch++;
      wantFull = false;
      wantPush = null;
      blocked = new Set();
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      removeKey(SYNC_KEY);
      removeKey(PARTY_KEY);
      setStatus("off", "Not in a party on this device.");
    },

    isJoined: () => readState() !== null,

    member: () => readState()?.member ?? null,

    // The party as of the last good sync, for an offline boot. Re-checked on
    // the way out: the cache is plain localStorage, and isUsable may have
    // changed with the app.
    cachedParty() {
      if (!readState()) return [];
      const cache = readJson(PARTY_KEY);
      if (!cache || !Array.isArray(cache.entries)) return [];
      return cache.entries.filter((e) =>
        e !== null && typeof e === "object" && bodyMatches(e.id, e.character) && usable(e.character));
    },

    sync,

    // After a local save: push in debounceMs, restarting the wait on each call.
    schedule() {
      if (!readState()) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        request("push");
      }, debounceMs);
    },

    // Push now. With {keepalive: true} (pagehide, visibilitychange → hidden)
    // the first request is already sent when this returns, and conflicts are
    // left for the next sync instead of prompting.
    flush({ keepalive = false } = {}) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (!readState()) return Promise.resolve(lastStatus);
      return request("push", keepalive);
    },

    // Settles when no run is in flight (tests, and a UI that wants to wait).
    idle: () => running ?? Promise.resolve(lastStatus),
  };
}
