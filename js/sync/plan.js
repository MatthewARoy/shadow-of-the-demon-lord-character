// The sync planner: given this device's roster, what it last agreed with the
// server (meta) and the server's current rows, decide what moves which way.
// Pure — no I/O, no clock, inputs never mutated — so every branch is a plain
// fixture test. js/sync/engine.js carries the plan out.
//
// The branch list is the spec's ("Client sync" → plan.js), plus one rule it
// implies: when the local and remote bodies are identical there is nothing to
// reconcile, whatever the revs say, so the planner adopts the server's rev.
// That is what makes a keepalive PUT whose response never arrived (the tab
// closed) settle quietly on the next open instead of prompting a conflict.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md.

import { newCharacter } from "../engine.js";
import { canonicalJson, hashCharacter } from "./hash.js";
import { validateCharacter } from "./validate.js";

// A character nobody has touched yet: newCharacter() apart from its id. The
// roster always holds at least one, so these are never uploaded — every
// device would otherwise fill the party with "Unnamed Soul"s.
export function isPristine(c) {
  if (c === null || typeof c !== "object") return false;
  const { id: _ignored, ...rest } = c;
  const { id: _fresh, ...fresh } = newCharacter();
  return canonicalJson(rest) === canonicalJson(fresh);
}

// A row body this device may trust: structurally valid, and filed under its
// own id (the Worker enforces that, but the client does not assume it).
export function bodyMatches(id, body) {
  return validateCharacter(body).ok && body.id === id;
}

const wellFormedRow = (row) =>
  row !== null && typeof row === "object"
  && typeof row.id === "string" && row.id
  && typeof row.ownerId === "string"
  && Number.isSafeInteger(row.rev);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// planSync({local, meta, remote, me, isPristine}) → {
//   creates:   [{id, baseRev: 0, character}]       local, never on the server
//   updates:   [{id, baseRev, character}]          local edits to push
//   deletes:   [{id, baseRev}]                     deleted here, push the delete
//   pulls:     [{id, rev, character}]              server is newer, local untouched
//   adds:      [{id, rev, character}]              made on another device
//   removes:   [{id}]                              deleted elsewhere / placeholder
//   conflicts: [{id, name, rev, character}]        both sides changed
//   adopts:    [{id, rev, hash}]                   same content; just record rev
//   forgets:   [id]                                meta entries with nothing left
//   foreign:   [{id, name}]                        local, but another member owns the row
//   party:     [{id, ownerId, ownerName, rev, updatedAt, character}]
// }
// `character` on creates/updates is the live local object (never mutate it);
// on pulls/adds/conflicts it is the server body, not yet validated — the
// engine checks it before applying. `rev` on a conflict is the server's.
//
// local:  the roster's own characters.
// meta:   {[id]: {rev, hash}} from the last successful sync.
// remote: the list() payload, {me, characters: [row…]}.
// me:     {id} of this member.
export function planSync({ local, meta = {}, remote, me, isPristine: pristine = isPristine }) {
  const plan = {
    creates: [], updates: [], deletes: [], pulls: [], adds: [], removes: [],
    conflicts: [], adopts: [], forgets: [], foreign: [], party: [],
  };
  const rows = Array.isArray(remote?.characters) ? remote.characters.filter(wellFormedRow) : [];
  const localById = new Map(local.map((c) => [c.id, c]));
  const own = new Map();
  const othersIds = new Set();

  for (const row of rows) {
    if (row.ownerId === me.id) {
      own.set(row.id, row);
      continue;
    }
    othersIds.add(row.id);
    if (row.deleted || !bodyMatches(row.id, row.body)) continue;
    plan.party.push({
      id: row.id, ownerId: row.ownerId, ownerName: row.ownerName,
      rev: row.rev, updatedAt: row.updatedAt, character: row.body,
    });
  }

  for (const row of own.values()) {
    const { id } = row;
    const c = localById.get(id);
    const m = has(meta, id) ? meta[id] : null;

    if (row.deleted) {
      if (!c) {
        if (m) plan.forgets.push(id);
      } else if (m) {
        // Deleted on another device. Untouched here → follow; edited here →
        // this device's edits win and bring it back.
        if (hashCharacter(c) === m.hash) plan.removes.push({ id });
        else plan.updates.push({ id, baseRev: row.rev, character: c });
      } else if (!pristine(c)) {
        // Never synced from this device (left and rejoined, say) but the
        // server holds a tombstone under the same id: undelete with our copy.
        plan.updates.push({ id, baseRev: row.rev, character: c });
      }
      continue;
    }

    if (!c) {
      if (m) plan.deletes.push({ id, baseRev: m.rev });
      else plan.adds.push({ id, rev: row.rev, character: row.body });
      continue;
    }

    const localHash = hashCharacter(c);
    if (localHash === hashCharacter(row.body)) {
      if (!m || m.rev !== row.rev || m.hash !== localHash) plan.adopts.push({ id, rev: row.rev, hash: localHash });
      continue;
    }
    if (!m) {
      plan.conflicts.push({ id, name: c.name, rev: row.rev, character: row.body });
    } else if (row.rev === m.rev) {
      if (localHash !== m.hash) plan.updates.push({ id, baseRev: m.rev, character: c });
    } else if (localHash === m.hash) {
      // The server moved on (normally rev > meta.rev; a lower rev means the
      // server was reset — either way it is not what we last saw).
      plan.pulls.push({ id, rev: row.rev, character: row.body });
    } else {
      plan.conflicts.push({ id, name: c.name, rev: row.rev, character: row.body });
    }
  }

  for (const c of local) {
    if (own.has(c.id)) continue;
    if (othersIds.has(c.id)) {
      // An id another member owns can never be written from here (the
      // Worker answers 403) — e.g. a roster left behind on a shared browser
      // by the previous member. Leave it local rather than retrying every
      // sync, but report it: its edits are not being saved online.
      if (!pristine(c)) plan.foreign.push({ id: c.id, name: c.name });
      continue;
    }
    if (!pristine(c)) plan.creates.push({ id: c.id, baseRev: 0, character: c });
  }

  for (const id of Object.keys(meta)) {
    if (!own.has(id) && !localById.has(id)) plan.forgets.push(id);
  }

  // A fresh device's lone placeholder gives way to the characters arriving
  // from the player's other devices.
  if (plan.adds.length && local.length === 1) {
    const only = local[0];
    if (pristine(only) && !has(meta, only.id) && !own.has(only.id)) plan.removes.push({ id: only.id });
  }

  return plan;
}

// The push half alone, from local state and meta, with no list() call: what
// schedule() and flush() send between full syncs. Stale guesses are safe —
// the server rejects them with 409 and the engine sorts that out.
//
// planPush({local, meta, isPristine}) → {creates, updates, deletes}, entries
// shaped as in planSync.
export function planPush({ local, meta = {}, isPristine: pristine = isPristine }) {
  const plan = { creates: [], updates: [], deletes: [] };
  const localIds = new Set();
  for (const c of local) {
    localIds.add(c.id);
    if (has(meta, c.id)) {
      if (hashCharacter(c) !== meta[c.id].hash) plan.updates.push({ id: c.id, baseRev: meta[c.id].rev, character: c });
    } else if (!pristine(c)) {
      plan.creates.push({ id: c.id, baseRev: 0, character: c });
    }
  }
  for (const id of Object.keys(meta)) {
    if (!localIds.has(id)) plan.deletes.push({ id, baseRev: meta[id].rev });
  }
  return plan;
}
