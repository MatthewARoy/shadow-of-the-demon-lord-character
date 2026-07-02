// Boot: load data, wire the chrome, route tabs.

import { loadRules } from "./data.js";
import { store, load, save, active, addCharacter, deleteActive, exportActive, importCharacter, onChange } from "./state.js";
import { renderBuilder } from "./ui/builder.js";
import { renderSheet } from "./ui/sheet.js";
import { renderSpells } from "./ui/spells.js";
import { renderPaths } from "./ui/paths.js";
import { renderGear } from "./ui/gear.js";
import { renderDice } from "./ui/dice.js";
import { renderLookup } from "./ui/lookup.js";
import { esc } from "./ui/util.js";

const tabs = {
  build: renderBuilder,
  sheet: renderSheet,
  spells: renderSpells,
  paths: renderPaths,
  gear: renderGear,
  dice: renderDice,
  lookup: renderLookup,
};

let current = "build";

function renderCurrent() {
  const panel = document.getElementById(`tab-${current}`);
  if (panel) tabs[current](panel);
}

function renderRoster() {
  const sel = document.getElementById("roster-select");
  sel.innerHTML = store.characters.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === store.activeId ? "selected" : ""}>${esc(c.name || "Unnamed Soul")} — L${esc(c.level)}</option>`).join("");
}

async function boot() {
  try {
    await loadRules();
  } catch (err) {
    document.getElementById("loading").textContent =
      "The archives are sealed — failed to load ruleset data. If you are viewing this from file://, serve it over http (npm run dev).";
    console.error(err);
    return;
  }
  load();
  document.getElementById("loading").remove();
  renderRoster();
  renderCurrent();

  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab[data-tab]");
    if (!btn) return;
    current = btn.dataset.tab;
    document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${current}`));
    // Keep the active tab (and its underline) in view when the strip scrolls.
    btn.scrollIntoView({ inline: "nearest", block: "nearest" });
    renderCurrent();
  });

  document.getElementById("roster-select").addEventListener("change", (e) => {
    store.activeId = e.target.value;
    save();
    renderCurrent();
  });

  // Shared roster actions, reused by the desktop bar and the ⋯ overflow menu.
  const newSoul = () => {
    const name = prompt("Name the poor soul:", "Unnamed Soul");
    if (name === null) return;
    addCharacter(name || "Unnamed Soul");
    renderRoster();
    renderCurrent();
  };
  const deleteSoul = () => {
    const c = active();
    if (!c) return;
    if (confirm(`Strike “${c.name}” from the ledger forever?`)) {
      deleteActive();
      renderRoster();
      renderCurrent();
    }
  };
  const importClick = () => document.getElementById("import-file").click();

  document.getElementById("new-char-btn").addEventListener("click", newSoul);
  document.getElementById("delete-btn").addEventListener("click", deleteSoul);
  document.getElementById("export-btn").addEventListener("click", exportActive);
  document.getElementById("import-btn").addEventListener("click", importClick);

  setupOverflowMenu({ newSoul, deleteSoul, importClick });

  document.getElementById("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      importCharacter(await file.text());
      renderRoster();
      renderCurrent();
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    e.target.value = "";
  });

  onChange(renderRoster);
  setupSamples();
}

async function setupSamples() {
  const sel = document.getElementById("sample-select");
  const ovSel = document.getElementById("ov-sample-select");
  try {
    const samples = await fetch("data/samples.json").then((r) => (r.ok ? r.json() : []));
    if (!samples.length) { sel.hidden = true; if (ovSel) ovSel.hidden = true; return; }
    for (let i = 0; i < samples.length; i++) {
      const label = `${samples[i].name} — L${samples[i].level}`;
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = label;
      sel.appendChild(o);
      if (ovSel) {
        const o2 = document.createElement("option");
        o2.value = String(i);
        o2.textContent = label;
        ovSel.appendChild(o2);
      }
    }
    const pick = (which) => {
      if (which.value === "") return;
      const sample = samples[parseInt(which.value, 10)];
      importCharacter(JSON.stringify(sample));
      sel.value = "";
      if (ovSel) ovSel.value = "";
      closeOverflowMenu();
      renderRoster();
      renderCurrent();
    };
    sel.addEventListener("change", () => pick(sel));
    if (ovSel) ovSel.addEventListener("change", () => pick(ovSel));
  } catch {
    sel.hidden = true;
    if (ovSel) ovSel.hidden = true;
  }
}

// ⋯ overflow menu: popover of roster rites for narrow layouts. Opens under
// the button; closes on outside click, Escape, or after an action fires.
function closeOverflowMenu() {
  const btn = document.getElementById("overflow-btn");
  const menu = document.getElementById("overflow-menu");
  if (!btn || !menu || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function setupOverflowMenu({ newSoul, deleteSoul, importClick }) {
  const btn = document.getElementById("overflow-btn");
  const menu = document.getElementById("overflow-menu");
  if (!btn || !menu) return;

  const open = () => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else closeOverflowMenu();
  });

  // Menu item actions reuse the shared handlers, then dismiss the popover.
  const wrap = (fn) => () => { fn(); closeOverflowMenu(); };
  document.getElementById("ov-new-btn").addEventListener("click", wrap(newSoul));
  document.getElementById("ov-export-btn").addEventListener("click", wrap(exportActive));
  document.getElementById("ov-import-btn").addEventListener("click", wrap(importClick));
  document.getElementById("ov-delete-btn").addEventListener("click", wrap(deleteSoul));

  // Outside click and Escape dismiss the popover.
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target.closest("#overflow-menu") || e.target.closest("#overflow-btn")) return;
    closeOverflowMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      closeOverflowMenu();
      btn.focus();
    }
  });
}

boot();
