// Roster persistence: localStorage, import/export.

import { newCharacter } from "./engine.js";
import { showToast } from "./ui/toast.js";

const KEY = "sotdl_ledger_v2";

export const store = {
  characters: [],
  activeId: null,
  listeners: [],
};

export function active() {
  return store.characters.find((c) => c.id === store.activeId) || null;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      store.characters = data.characters || [];
      store.activeId = data.activeId;
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

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ characters: store.characters, activeId: store.activeId }));
  } catch (e) {
    console.error("Failed to save roster", e);
    showToast({ total: "✕", label: "Save failed", detail: "Browser storage is full or blocked — changes will be lost when you close this page." });
  }
  for (const fn of store.listeners) fn();
}

export function onChange(fn) { store.listeners.push(fn); }

export function addCharacter(name) {
  const c = newCharacter(name);
  store.characters.push(c);
  store.activeId = c.id;
  save();
  return c;
}

export function deleteActive() {
  store.characters = store.characters.filter((c) => c.id !== store.activeId);
  if (!store.characters.length) store.characters.push(newCharacter());
  store.activeId = store.characters[0].id;
  save();
}

export function exportActive() {
  const c = active();
  if (!c) return;
  const blob = new Blob([JSON.stringify(c, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(c.name || "character").replace(/[^\w\- ]+/g, "").trim() || "character"}.sotdl.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export function importCharacter(json) {
  const data = JSON.parse(json);
  if (!isPlainObject(data) || typeof data.ancestry !== "string" || !data.ancestry.trim()) {
    throw new Error("Not a recognizable character file.");
  }
  const fresh = newCharacter();
  const c = { ...fresh, ...data, id: crypto.randomUUID(), version: 2 };
  // A malformed field saved into the roster would crash rendering on every
  // reload — snap anything of the wrong type back to its default.
  for (const k of ["decisions", "expended"]) {
    if (!isPlainObject(c[k])) c[k] = {};
  }
  for (const k of ["inventory", "wishlist", "exchanges", "log"]) {
    if (!Array.isArray(c[k])) c[k] = [];
  }
  c.inventory = c.inventory.filter(isPlainObject);
  for (const it of c.inventory) {
    if (typeof it.id !== "string" || !it.id) it.id = crypto.randomUUID();
  }
  for (const k of ["damage", "level", "insanityAdjust", "corruptionAdjust"]) {
    if (!Number.isFinite(c[k])) c[k] = fresh[k];
  }
  c.level = Math.max(0, Math.min(10, Math.trunc(c.level)));
  c.damage = Math.max(0, Math.trunc(c.damage));
  for (const k of ["name", "coins", "notes"]) {
    if (typeof c[k] !== "string") c[k] = fresh[k];
  }
  if (typeof c.sizeChoice !== "string") c.sizeChoice = null;
  store.characters.push(c);
  store.activeId = c.id;
  save();
  return c;
}
