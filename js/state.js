// Roster persistence: localStorage, import/export.

import { newCharacter } from "./engine.js";

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
  localStorage.setItem(KEY, JSON.stringify({ characters: store.characters, activeId: store.activeId }));
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

export function importCharacter(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== "object" || !data.ancestry) {
    throw new Error("Not a recognizable character file.");
  }
  const fresh = newCharacter();
  const c = { ...fresh, ...data, id: crypto.randomUUID(), version: 2 };
  store.characters.push(c);
  store.activeId = c.id;
  save();
  return c;
}
