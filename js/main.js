// Boot: load data, wire the chrome, route tabs.

import { loadRules } from "./data.js";
import { store, load, save, active, addCharacter, deleteActive, exportActive, importCharacter, onChange } from "./state.js";
import { renderBuilder } from "./ui/builder.js";
import { renderSheet } from "./ui/sheet.js";
import { renderSpells } from "./ui/spells.js";
import { renderGear } from "./ui/gear.js";
import { renderDice } from "./ui/dice.js";
import { renderLookup } from "./ui/lookup.js";

const tabs = {
  build: renderBuilder,
  sheet: renderSheet,
  spells: renderSpells,
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
    `<option value="${c.id}" ${c.id === store.activeId ? "selected" : ""}>${(c.name || "Unnamed Soul").replace(/[&<>"]/g, "")} — L${c.level}</option>`).join("");
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
    renderCurrent();
  });

  document.getElementById("roster-select").addEventListener("change", (e) => {
    store.activeId = e.target.value;
    save();
    renderCurrent();
  });
  document.getElementById("new-char-btn").addEventListener("click", () => {
    const name = prompt("Name the poor soul:", "Unnamed Soul");
    if (name === null) return;
    addCharacter(name || "Unnamed Soul");
    renderRoster();
    renderCurrent();
  });
  document.getElementById("delete-btn").addEventListener("click", () => {
    const c = active();
    if (!c) return;
    if (confirm(`Strike “${c.name}” from the ledger forever?`)) {
      deleteActive();
      renderRoster();
      renderCurrent();
    }
  });
  document.getElementById("export-btn").addEventListener("click", exportActive);
  document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-file").click());
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
  try {
    const samples = await fetch("data/samples.json").then((r) => (r.ok ? r.json() : []));
    if (!samples.length) { sel.hidden = true; return; }
    for (let i = 0; i < samples.length; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${samples[i].name} — L${samples[i].level}`;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      if (sel.value === "") return;
      const sample = samples[parseInt(sel.value, 10)];
      importCharacter(JSON.stringify(sample));
      sel.value = "";
      renderRoster();
      renderCurrent();
    });
  } catch {
    sel.hidden = true;
  }
}

boot();
