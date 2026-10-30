// Roster persistence: localStorage, import/export, and (when party sync is
// on) the party members' characters this device can view but not edit.

import { newCharacter, compute } from "./engine.js";
import { rules } from "./data.js";
import { showToast } from "./ui/toast.js";
import { revMismatch } from "./share.js";
import { SITE } from "./site.js";
import {
  CHARACTER_KEYS, MAX_CHARACTER_BYTES, MAX_NOTES_LENGTH, isValidDecision, validateCharacter,
} from "./sync/validate.js";
import { isPristine } from "./sync/plan.js";

const KEY = "sotdl_ledger_v2";
export const ROSTER_KEY = KEY;

// The stored roster string this tab last read or wrote. Another tab of the
// app writes the same key; a different string means it did (see
// refreshFromStorage).
let lastRaw = null;
const reloadListeners = [];

export const store = {
  characters: [],
  activeId: null,
  // Party entries from js/sync/engine.js: {id, ownerId, ownerName, rev,
  // updatedAt, character}. Always empty when sync is off.
  party: [],
  // A party character id while viewing someone else's character, else null.
  viewingId: null,
  listeners: [],
};

// The party entry being viewed, or null. A viewingId restored by load() has
// no entry until setParty() runs, so the own character shows meanwhile.
export function viewingEntry() {
  if (store.viewingId === null) return null;
  return store.party.find((e) => e.id === store.viewingId) || null;
}

export const isViewing = () => viewingEntry() !== null;

// While viewing, every call hands out a fresh deep copy: a screen that edits
// it edits a throwaway, so nothing it does can stick, save or upload.
export function active() {
  const entry = viewingEntry();
  if (entry) return structuredClone(entry.character);
  return store.characters.find((c) => c.id === store.activeId) || null;
}

const storedCharacters = (data) => (Array.isArray(data?.characters) ? data.characters : []).filter(isPlainObject);

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      lastRaw = raw;
      store.characters = storedCharacters(data);
      store.activeId = data.activeId;
      store.viewingId = typeof data.viewingId === "string" ? data.viewingId : null;
      // Party sync uploads these, so the sync build repairs what the
      // validator would refuse (rosters saved before party sync can lack
      // fields added since, or carry junk). Normalizing is the identity on a
      // valid character, so only a roster that needed it is rewritten. The
      // GitHub Pages build never uploads and keeps the roster as it was.
      if (SITE.syncEnabled) {
        let failed = false;
        store.characters = store.characters.map((c) => {
          try {
            return normalizeCharacter(c);
          } catch (e) {
            // Never let one character cost the roster: the next save would
            // write whatever is in memory over everything stored.
            console.warn("Could not check a saved character; keeping it as stored", e);
            failed = true;
            return c;
          }
        });
        if (!failed && store.characters.length && serialize() !== raw) persist({ quiet: true });
      }
    }
  } catch (e) {
    console.warn("Failed to load saved roster", e);
  }
  if (!store.characters.length) {
    const c = newCharacter();
    store.characters.push(c);
    store.activeId = c.id;
  }
  if (!store.characters.some((c) => c.id === store.activeId)) {
    store.activeId = store.characters[0].id;
  }
}

// viewingId is written only while set, so a roster that never views a party
// character (the GitHub Pages build) stores exactly what it always has.
function serialize() {
  const record = { characters: store.characters, activeId: store.activeId };
  if (store.viewingId !== null) record.viewingId = store.viewingId;
  return JSON.stringify(record);
}

// quiet: a write nobody asked for (the boot-time repair). Its failure loses
// no change, so it raises no "changes will be lost" toast.
function persist({ quiet = false } = {}) {
  const raw = serialize();
  try {
    localStorage.setItem(KEY, raw);
    lastRaw = raw;
  } catch (e) {
    console.error("Failed to save roster", e);
    if (!quiet) showToast({ total: "✕", label: "Save failed", detail: "Browser storage is full or blocked — changes will be lost when you close this page." });
  }
}

// --- other tabs (party sync; js/ui/party.js wires these) --------------------
// Every tab of the app shares this localStorage, but each loads the roster
// into memory once. A tab that kept its boot-time copy would hand the sync
// engine a stale roster (read as deletes, or as edits over newer work) and
// write it back over the other tab's changes on its next save.

// Reloads the roster when another tab has written it since this tab last
// read or wrote it; true if it did. This tab keeps its own selection while
// that character still exists. Nothing is written.
export function refreshFromStorage() {
  let raw;
  let data;
  try {
    raw = localStorage.getItem(KEY);
    if (raw === null || raw === lastRaw) return false;
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  lastRaw = raw;
  store.characters = storedCharacters(data);
  if (!store.characters.length) store.characters.push(newCharacter());
  if (!store.characters.some((c) => c.id === store.activeId)) {
    store.activeId = store.characters.some((c) => c.id === data.activeId) ? data.activeId : store.characters[0].id;
  }
  for (const fn of reloadListeners) {
    try {
      fn();
    } catch (e) {
      console.error("Roster reload listener failed", e);
    }
  }
  return true;
}

// fn runs after refreshFromStorage() reloads (to re-render). Unlike
// onChange listeners it does not mean "this tab changed something".
export function onReload(fn) { reloadListeners.push(fn); }

// The sync engine's getLocal: this player's characters as stored now.
export function ownCharacters() {
  refreshFromStorage();
  return store.characters;
}

export function save() {
  persist();
  for (const fn of store.listeners) fn();
}

export function onChange(fn) { store.listeners.push(fn); }

export function addCharacter(name) {
  const c = newCharacter(name);
  store.characters.push(c);
  store.activeId = c.id;
  store.viewingId = null;
  save();
  return c;
}

// Refuses (false) while viewing: the character on screen is not in the roster.
export function deleteActive() {
  if (isViewing()) return false;
  store.characters = store.characters.filter((c) => c.id !== store.activeId);
  if (!store.characters.length) store.characters.push(newCharacter());
  store.activeId = store.characters[0].id;
  save();
  return true;
}

// Remove a specific character by id and make `restoreId` active (falls back to
// the first survivor if that id is gone). Powers the sample-import Undo, which
// must target the just-added soul even if the user has since switched away.
export function removeCharacter(id, restoreId) {
  store.characters = store.characters.filter((c) => c.id !== id);
  if (!store.characters.length) store.characters.push(newCharacter());
  store.activeId = store.characters.some((c) => c.id === restoreId)
    ? restoreId
    : store.characters[0].id;
  store.viewingId = null;
  save();
}

export function exportActive() {
  const c = active();
  if (!c) return;
  const stamped = rules.dataRev ? { ...c, dataRev: rules.dataRev } : c;
  const blob = new Blob([JSON.stringify(stamped, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(c.name || "character").replace(/[^\w\- ]+/g, "").trim() || "character"}.sotdl.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const MASTER_MODES = ["master", "second-expert"];

// A character coerced to the shape js/sync/validate.js accepts: every field
// newCharacter() has (missing ones take its defaults), nothing else (dataRev
// included), and a malformed field — which would otherwise crash rendering on
// every reload — snapped back to its default. Values that are already valid
// pass through untouched, so a synced body normalizes to itself and its hash
// does not move. Returns a new object; `src` is not modified.
export function normalizeCharacter(src, { keepId = true } = {}) {
  const fresh = newCharacter();
  const c = {};
  for (const k of CHARACTER_KEYS) {
    // A JSON round trip, not structuredClone: these values came from JSON,
    // and load() must not depend on an API some supported browsers lack.
    c[k] = hasOwn(src, k) ? JSON.parse(JSON.stringify(src[k]) ?? "null") : fresh[k];
  }
  c.version = 2;
  if (!keepId || typeof c.id !== "string" || !c.id) c.id = crypto.randomUUID();

  for (const k of ["decisions", "expended"]) {
    if (!isPlainObject(c[k])) c[k] = {};
  }
  for (const k of ["inventory", "wishlist", "exchanges", "log"]) {
    if (!Array.isArray(c[k])) c[k] = [];
  }
  for (const k of ["damage", "bonusHealth", "level", "insanityAdjust", "corruptionAdjust"]) {
    if (!Number.isFinite(c[k])) c[k] = fresh[k];
  }
  c.level = Math.max(0, Math.min(10, Math.trunc(c.level)));
  c.damage = Math.max(0, Math.trunc(c.damage));
  c.bonusHealth = Math.max(0, Math.trunc(c.bonusHealth));
  c.insanityAdjust = Math.trunc(c.insanityAdjust);
  c.corruptionAdjust = Math.trunc(c.corruptionAdjust);
  for (const k of ["name", "ancestry", "coins", "notes"]) {
    if (typeof c[k] !== "string") c[k] = fresh[k];
  }
  for (const k of ["novicePath", "expertPath", "masterPath", "secondExpertPath", "religion", "sizeChoice"]) {
    if (typeof c[k] !== "string") c[k] = null;
  }
  if (!MASTER_MODES.includes(c.masterMode)) c.masterMode = fresh.masterMode;
  const swap = c.attributeSwap;
  c.attributeSwap = isPlainObject(swap)
    ? { from: typeof swap.from === "string" ? swap.from : "", to: typeof swap.to === "string" ? swap.to : "" }
    : null;

  // compute() reads ex.drop.name unguarded: a half-formed exchange goes.
  const side = (s) => isPlainObject(s) && typeof s.name === "string" && typeof s.tradition === "string";
  c.exchanges = c.exchanges
    .filter((ex) => isPlainObject(ex) && side(ex.drop) && side(ex.gain))
    .map(({ drop, gain }) => ({
      drop: { name: drop.name, tradition: drop.tradition },
      gain: { name: gain.name, tradition: gain.tradition },
    }));
  c.wishlist = c.wishlist.filter((k) => typeof k === "string");
  // builder.js draws each resolution; a shape it never writes would crash it.
  for (const [k, v] of Object.entries(c.decisions)) {
    if (!isValidDecision(v)) delete c.decisions[k];
  }
  for (const [k, n] of Object.entries(c.expended)) {
    if (Number.isFinite(n)) c.expended[k] = Math.max(0, Math.trunc(n));
    else delete c.expended[k];
  }

  c.inventory = c.inventory.filter(isPlainObject);
  for (const it of c.inventory) {
    if (typeof it.id !== "string" || !it.id) it.id = crypto.randomUUID();
    if (typeof it.name !== "string") it.name = it.name == null ? "" : String(it.name);
    // Imported JSON can carry "3" or -2; gear.js's own clamp, applied here.
    if (hasOwn(it, "qty")) it.qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (hasOwn(it, "equipped") && typeof it.equipped !== "boolean") it.equipped = Boolean(it.equipped);
    if (hasOwn(it, "notes") && typeof it.notes !== "string") it.notes = it.notes == null ? "" : String(it.notes);
    for (const [k, v] of Object.entries(it)) {
      if (v !== null && typeof v === "object") delete it[k];
    }
  }
  return c;
}

export function importCharacter(json) {
  const data = JSON.parse(json);
  if (!isPlainObject(data) || typeof data.ancestry !== "string" || !data.ancestry.trim()) {
    throw new Error("Not a recognizable character file.");
  }
  const c = normalizeCharacter(data, { keepId: false });
  c.name = uniqueName(c.name);
  // Exports carry the data-revision stamp of the snapshot they were built
  // against (slot IDs resolve positionally into data/*.json). A mismatch is
  // survivable — the engine keeps orphaned decisions recoverable — but the
  // player should re-check their choices.
  if (revMismatch(data.dataRev, rules.dataRev)) {
    showToast({
      total: "⚠",
      label: "Different rules version",
      detail: `${c.name} was saved under another data revision — review their choices, some may have shifted.`,
    });
  }
  store.characters.push(c);
  store.activeId = c.id;
  store.viewingId = null;
  save();
  return c;
}

// A whole roster from a transfer code (js/transfer.js). Unlike
// importCharacter, ids are kept, so pasting the same code twice adds nothing
// the second time, and a character already here is skipped rather than
// copied. (The exception: an arrival whose id another member owns gets a new
// id, so pasting it again adds it again.) An untouched placeholder (the blank soul a fresh device starts
// with) gives way to the arrivals. foreignIds: ids another party member owns
// beyond the live ones in store.party (the sync engine's foreignIds()).
// Arrivals are staged and the roster changes only once all are checked, so
// one unreadable entry cannot leave half a paste behind. Returns {added,
// already, skipped}.
export function importRoster(characters, { dataRev = null, foreignIds = new Set() } = {}) {
  const result = { added: [], already: 0, skipped: [] };
  const placeholder = store.characters.length === 1 && isPristine(store.characters[0]) ? store.characters[0] : null;
  // An id a party member owns cannot be this player's too; it arrives as a copy.
  const othersIds = new Set([...store.party.map((e) => e.id), ...foreignIds]);
  const ids = new Set(store.characters.map((c) => c.id));
  // The placeholder is about to go, so its name is free.
  const names = new Set(store.characters.filter((c) => c !== placeholder).map((c) => c.name));
  for (const data of Array.isArray(characters) ? characters : []) {
    const name = typeof data?.name === "string" && data.name ? data.name : "Unnamed Soul";
    if (!isPlainObject(data) || typeof data.ancestry !== "string" || !data.ancestry.trim()) {
      result.skipped.push({ name, why: "not a character" });
      continue;
    }
    if (ids.has(data.id)) {
      result.already++;
      continue;
    }
    let c;
    let why;
    try {
      c = normalizeCharacter(data, { keepId: !othersIds.has(data.id) });
      why = isPristine(c) ? "blank" : unfit(c);
    } catch {
      why = "could not be read";   // e.g. a field nested too deep to copy
    }
    if (why) {
      result.skipped.push({ name, why });
      continue;
    }
    c.name = uniqueName(c.name, names);
    names.add(c.name);
    ids.add(c.id);
    result.added.push(c);
  }
  if (!result.added.length) return result;
  store.characters = [...store.characters.filter((c) => c !== placeholder), ...result.added];
  store.activeId = result.added[0].id;
  store.viewingId = null;
  if (revMismatch(dataRev, rules.dataRev)) {
    showToast({
      total: "⚠",
      label: "Different rules version",
      detail: "These characters were saved under another data revision — review their choices, some may have shifted.",
    });
  }
  save();
  return result;
}

// Why a normalized arrival cannot join the roster, or null. Only the party
// site uploads, so only there must it pass the sync validator; the GitHub
// Pages copy takes what Import would.
function unfit(c) {
  if (SITE.syncEnabled && !validateCharacter(c).ok) {
    const bytes = new TextEncoder().encode(JSON.stringify(c)).length;
    return bytes > MAX_CHARACTER_BYTES || c.notes.length > MAX_NOTES_LENGTH ? "too large to store online" : "could not be read";
  }
  return isUsable(c) ? null : "could not be read";
}

// Keep the roster select legible: if a character with this exact name already
// exists, append " (2)", " (3)", … Counts collisions against the base name so
// re-importing the same soul climbs the numbering rather than stacking suffixes.
// `taken` defaults to the roster's names.
function uniqueName(name, taken = new Set(store.characters.map((c) => c.name))) {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- party (js/ui/party.js wires these to js/sync/engine.js) ---------------

// The party as of the last sync. Viewing ends if the viewed entry is gone
// (deleted by its owner, or this device left the party).
export function setParty(entries) {
  store.party = Array.isArray(entries) ? entries : [];
  if (store.viewingId !== null && !viewingEntry()) {
    store.viewingId = null;
    persist();
  }
}

// Callers save() afterwards, as with a change of store.activeId.
export function viewParty(id) {
  if (!store.party.some((e) => e.id === id)) return false;
  store.viewingId = id;
  return true;
}

export function stopViewing() {
  store.viewingId = null;
}

// The engine's applyLocal: own characters arriving from this player's other
// devices. Unlike importCharacter, ids are kept, and bodies are stored exactly
// as received — the engine records the hash of what it handed over, so a
// normalized copy would read as a local edit on the next sync.
export function applyRemote({ adds = [], pulls = [], removes = [] } = {}) {
  const ids = new Set(store.characters.map((c) => c.id));
  let firstAdded = null;
  for (const body of adds) {
    if (ids.has(body.id)) continue;
    store.characters.push(structuredClone(body));
    ids.add(body.id);
    firstAdded ??= body.id;
  }
  for (const body of pulls) {
    const i = store.characters.findIndex((c) => c.id === body.id);
    if (i !== -1) store.characters[i] = structuredClone(body);
  }
  const gone = new Set(removes.map((r) => (typeof r === "string" ? r : r?.id)));
  if (gone.size) store.characters = store.characters.filter((c) => !gone.has(c.id));
  if (!store.characters.length) store.characters.push(newCharacter());
  if (!store.characters.some((c) => c.id === store.activeId)) {
    store.activeId = firstAdded !== null && !gone.has(firstAdded) ? firstAdded : store.characters[0].id;
  }
  save();
}

// The engine's isUsable: a body this app's rules engine can render. A body
// that passes validation can still trip compute() (say, a spell pick that is
// a number), and that must be skipped rather than crash every render.
export function isUsable(c) {
  try {
    compute(c);
    return true;
  } catch {
    return false;
  }
}

// "Make my copy": the viewed party character becomes an own character with a
// new id, and viewing ends.
export function makeOwnCopy() {
  const entry = viewingEntry();
  if (!entry) return null;
  return importCharacter(JSON.stringify(entry.character));
}
