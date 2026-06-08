// Shadow of the Demon Lord - Gothic Character Terminal Engine

let rules = null;

// Character State Chronicle
let state = {
  name: "Unnamed Hero",
  level: 1,
  ancestry: "human",
  novicePath: "warrior",
  power: 0,
  attributes: {
    str: 10,
    agi: 10,
    int: 10,
    wil: 10
  },
  healthMod: 0, // Health bonus from paths/advancements
  damage: 0,
  insanity: 0,
  corruption: 0,
  professions: "",
  notes: "",
  inventory: [], // items: { id, name, type, specs, equipped }
  preparedSpells: [], // spell names
  expendedCastings: {}, // spellName -> count expended
  round: 1,
  actions: {
    fastTurn: false,
    slowTurn: false,
    triggered: false
  },
  boonBaneCount: 0,
  fateSuccesses: 0,
  fateFailures: 0,
  isIncapacitated: false,
  isDead: false
};

// Initial state copy for resets
const DEFAULT_STATE = JSON.parse(JSON.stringify(state));

// Onboarding Wizard Temporary State
let wizardStep = 1;
let wizardState = {
  ancestry: "human",
  level: 1,
  novicePath: "warrior",
  attributes: { str: 10, agi: 10, int: 10, wil: 10 },
  boostsRemaining: 2,
  boostedAttrs: { str: 0, agi: 0, int: 0, wil: 0 },
  professions: "Soldier",
  languages: "Common Tongue",
  background: "",
  spells: [],
  name: "Unnamed Hero",
  appearance: ""
};

const BACKGROUNDS = [
  "You spent your early life working as an apprentice to a village blacksmith, learning the craft of steel.",
  "You were born into poverty and turned to crime to survive, spending years in the shadows of the city.",
  "You studied in a secluded temple, devoted to the New God, before taking up a calling in the wider world.",
  "You served in the local militia, defending the borders against beastmen, orcs, and skinwalkers.",
  "You were captured by cultists of the Demon Lord but managed to escape, bearing scars and grim nightmares.",
  "You were an academic assistant at a major library, studying ancient history and occult philosophy before it was burned.",
  "You spent years as a guide in the wild wood, learning the tracks of creatures and avoiding dark fey paths.",
  "You were born of noble lineage but fled your family home when corruption took hold of your lineage's estate."
];

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
  fetch('ruleset_db.json')
    .then(res => res.json())
    .then(data => {
      rules = data;
      setupAncestryOptions();
      loadSavedState();
      setupEventListeners();
      
      // If name is default "Unnamed Hero" or state is fresh, trigger onboarding wizard
      const saved = localStorage.getItem("sotdl_character_state");
      if (!saved) {
        startWizard();
      } else {
        recalculateSheet();
      }
      
      addLogEntry("SYSTEM", "Gothic rules database cataloged. Character Terminal active.");
    })
    .catch(err => {
      console.error("Failed to load rules database:", err);
      // Fallback stub if load fails
      rules = {
        castings_matrix: { power_levels: { "0": [1], "1": [2,1], "2": [3,2,1], "3": [4,2,1,1] } },
        ancestries: { human: { name: "Human", base_attributes: { str:10, agi:10, int:10, wil:10 }, health:10, traits: "Languages: Common Tongue." } },
        novice_paths: { none: { name: "Level 0", health_bonus: 0, power_bonus: 0 }, warrior: { name: "Warrior", health_bonus: 5, power_bonus:0 } },
        armory_catalog: [],
        spells_sample: []
      };
      setupAncestryOptions();
      setupEventListeners();
      startWizard();
    });
});

// Setup dropdown selections
function setupAncestryOptions() {
  const select = document.getElementById("char-ancestry");
  select.innerHTML = "";
  Object.keys(rules.ancestries).forEach(key => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = rules.ancestries[key].name;
    select.appendChild(option);
  });
}

// Bind event listeners
function setupEventListeners() {
  // Navigation tabs
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      
      btn.classList.add("active");
      document.getElementById(targetTab).classList.add("active");
    });
  });

  // Basic sheet inputs
  bindInput("char-name", "name");
  bindInput("char-level", "level", "int");
  bindInput("char-power", "power", "int");
  bindInput("char-professions", "professions");
  bindInput("char-notes", "notes");

  document.getElementById("char-ancestry").addEventListener("change", (e) => {
    state.ancestry = e.target.value;
    const ancData = rules.ancestries[state.ancestry];
    
    state.attributes.str = ancData.base_attributes.str;
    state.attributes.agi = ancData.base_attributes.agi;
    state.attributes.int = ancData.base_attributes.int;
    state.attributes.wil = ancData.base_attributes.wil;
    
    state.corruption = ancData.corruption;
    state.insanity = ancData.insanity;

    recalculateSheet();
    addLogEntry("SYSTEM", `Ancestry altered to ${ancData.name}. Starting attributes restored.`);
  });

  // Roll d20 / d6 / d3 controls
  document.getElementById("roll-d20").addEventListener("click", () => rollDice(20, "d20 Check"));
  document.getElementById("roll-d6").addEventListener("click", () => rollDice(6, "d6 Roll"));
  document.getElementById("roll-d3").addEventListener("click", () => rollDice(3, "d3 Roll"));

  document.getElementById("boon-inc").addEventListener("click", () => {
    state.boonBaneCount++;
    updateBoonDisplay();
  });
  document.getElementById("bane-dec").addEventListener("click", () => {
    state.boonBaneCount--;
    updateBoonDisplay();
  });
  document.getElementById("clear-log").addEventListener("click", () => {
    document.getElementById("roll-log").innerHTML = "";
  });

  // Export / Import / Reset Character
  document.getElementById("import-file").addEventListener("change", importState);
  document.getElementById("export-btn").addEventListener("click", exportState);
  document.getElementById("reset-btn").addEventListener("click", startWizard); // Clears and starts wizard

  // Tactical Controls
  document.getElementById("heal-rate-btn").addEventListener("click", applyHealingRate);
  
  // Action Economy Bindings
  bindCheckbox("action-fast-turn", "actions", "fastTurn");
  bindCheckbox("action-slow-turn", "actions", "slowTurn");
  bindCheckbox("action-triggered", "actions", "triggered");

  document.getElementById("next-round-btn").addEventListener("click", nextRoundClock);

  // Fate Checks
  document.getElementById("roll-fate-btn").addEventListener("click", rollFateCheck);
  document.getElementById("revive-btn").addEventListener("click", forceRevive);

  // Spells lists filter
  document.getElementById("spell-search").addEventListener("input", filterSpellLibrary);
  document.getElementById("filter-tradition").addEventListener("change", filterSpellLibrary);
  document.getElementById("filter-rank").addEventListener("change", filterSpellLibrary);

  // Custom equipment forge
  document.getElementById("add-custom-item").addEventListener("click", addCustomItem);

  // Wizard Navigation
  document.getElementById("wbtn-back").addEventListener("click", prevWizardStep);
  document.getElementById("wbtn-next").addEventListener("click", nextWizardStep);
  document.getElementById("wizard-roll-background-btn").addEventListener("click", rollWizardBackground);
  document.getElementById("wizard-spell-tradition-filter").addEventListener("change", filterWizardSpellLibrary);

  document.getElementById("char-novice-path").addEventListener("change", (e) => {
    state.novicePath = e.target.value;
    const path = rules.novice_paths[state.novicePath];
    if (path) {
      state.healthMod = path.health_bonus;
      state.power = path.power_bonus;
    } else {
      state.healthMod = 0;
      state.power = 0;
    }
    recalculateSheet();
    addLogEntry("SYSTEM", `Novice Path altered to ${path ? path.name : 'None'}. Health and Power adjusted.`);
  });
}

// Bind utility
function bindInput(elementId, stateKey, type = "string") {
  const el = document.getElementById(elementId);
  el.addEventListener("input", (e) => {
    let val = e.target.value;
    if (type === "int") {
      val = parseInt(val, 10) || 0;
    }
    state[stateKey] = val;
    recalculateSheet();
  });
}

function bindCheckbox(elementId, stateParentKey, stateKey) {
  const el = document.getElementById(elementId);
  el.addEventListener("change", (e) => {
    state[stateParentKey][stateKey] = e.target.checked;
    saveStateToLocalStorage();
  });
}

// Global calculations update
function recalculateSheet() {
  const ancData = rules.ancestries[state.ancestry];
  if (!ancData) return;

  // Modifiers calculations
  const strMod = state.attributes.str - 10;
  const agiMod = state.attributes.agi - 10;
  const intMod = state.attributes.int - 10;
  const wilMod = state.attributes.wil - 10;

  // Pentagram Nodes attribute scores & modifiers
  document.getElementById("pvalue-str").textContent = state.attributes.str;
  document.getElementById("pvalue-agi").textContent = state.attributes.agi;
  document.getElementById("pvalue-int").textContent = state.attributes.int;
  document.getElementById("pvalue-wil").textContent = state.attributes.wil;

  document.getElementById("pmod-str").textContent = (strMod >= 0 ? "+" : "") + strMod;
  document.getElementById("pmod-agi").textContent = (agiMod >= 0 ? "+" : "") + agiMod;
  document.getElementById("pmod-int").textContent = (intMod >= 0 ? "+" : "") + intMod;
  document.getElementById("pmod-wil").textContent = (wilMod >= 0 ? "+" : "") + wilMod;

  // Health: Base Health (ancestry) + scaling level HP + health modifier (path benefits)
  const baseHealth = ancData.health + (ancData.health_bonus || 0);
  const healthMax = baseHealth + (state.level * 4) + state.healthMod;
  
  // Speed
  let currentSpeed = ancData.speed;
  let speedPenalty = false;
  let armorBane = false;
  let equippedArmorName = "No Armor";

  // Defense: Calculate flat defense or Agility modifier + equipped armor specs + defense modifier
  let defense = state.attributes.agi;
  
  // Check flat Defense (e.g. Clockwork is 13)
  if (ancData.defense_flat !== null) {
    defense = ancData.defense_flat;
  }

  // Parse equipped armor
  const equippedArmor = state.inventory.find(i => i.equipped && i.type === "armor");
  if (equippedArmor) {
    equippedArmorName = equippedArmor.name;
    const specs = equippedArmor.specs.toLowerCase();
    
    // Evaluate defense formulas
    if (specs.includes("agility + 1")) {
      defense = state.attributes.agi + 1;
    } else if (specs.includes("agility + 2")) {
      defense = state.attributes.agi + 2;
    } else if (specs.includes("defense set parameter: 15") || specs.includes("parameter: 15") || specs.includes("defense: 15")) {
      defense = 15;
    } else if (specs.includes("defense set parameter: 18") || specs.includes("parameter: 18") || specs.includes("defense: 18")) {
      defense = 18;
    }

    // Evaluate Strength requirements
    const strReqMatch = specs.match(/requires strength (\d+)\+/);
    if (strReqMatch) {
      const reqStr = parseInt(strReqMatch[1], 10);
      if (state.attributes.str < reqStr) {
        speedPenalty = true;
        armorBane = true;
      }
    }
  }

  // Divine Protection (+1 Defense if unarmored and Priest novice path)
  if (!equippedArmor && state.novicePath === "priest") {
    defense += 1;
  }

  // Add custom defense modifier
  defense += (state.defenseMod || 0);

  if (speedPenalty) {
    currentSpeed = Math.max(2, Math.floor(currentSpeed / 2));
  }
  document.getElementById("char-speed").value = currentSpeed;

  // Sync inputs
  document.getElementById("char-name").value = state.name;
  document.getElementById("char-level").value = state.level;
  document.getElementById("char-novice-path").value = state.novicePath || "none";
  document.getElementById("char-power").value = state.power;
  document.getElementById("char-professions").value = state.professions;
  document.getElementById("char-notes").value = state.notes;
  document.getElementById("char-ancestry").value = state.ancestry;

  // Write other Vitals & Satellites directly to the pentagram nodes
  document.getElementById("pvalue-health").textContent = healthMax;
  document.getElementById("pvalue-level").textContent = state.level;
  
  const sizeValue = state.size || ancData.size;
  document.getElementById("pvalue-size").textContent = sizeValue;
  document.getElementById("pvalue-speed").textContent = currentSpeed;
  document.getElementById("pvalue-defense").textContent = defense;
  
  const perceptionVal = state.attributes.int + (ancData.perception_mod || 0);
  document.getElementById("pvalue-perception").textContent = perceptionVal;
  
  document.getElementById("pvalue-insanity").textContent = state.insanity;
  document.getElementById("pvalue-power").textContent = state.power;
  
  const healingRate = Math.floor(healthMax / 4);
  document.getElementById("pvalue-healing-rate").textContent = healingRate;
  document.getElementById("pvalue-corruption").textContent = state.corruption;
  document.getElementById("pvalue-damage").value = state.damage;

  // Sync Quick Header
  document.getElementById("quick-name").textContent = state.name;
  document.getElementById("quick-ancestry").textContent = ancData.name;
  document.getElementById("quick-level").textContent = state.level;
  document.getElementById("quick-health").textContent = healthMax;
  document.getElementById("quick-damage").textContent = state.damage;
  document.getElementById("quick-defense").textContent = defense;
  document.getElementById("quick-power").textContent = state.power;
  document.getElementById("quick-insanity").textContent = state.insanity;
  document.getElementById("quick-corruption").textContent = state.corruption;

  // Sync Tactical Action Sheet
  document.getElementById("tactical-damage").textContent = state.damage;
  document.getElementById("tactical-health-max").textContent = healthMax;
  
  // Health Progress Bar
  const healthPercent = Math.max(0, Math.min(100, ((healthMax - state.damage) / healthMax) * 100));
  const healthBar = document.getElementById("health-bar-fill");
  healthBar.style.width = `${healthPercent}%`;
  
  if (healthPercent > 50) {
    healthBar.style.background = "linear-gradient(90deg, #6b5030 0%, var(--color-trim) 100%)";
  } else if (healthPercent > 20) {
    healthBar.style.background = "linear-gradient(90deg, var(--color-amber) 0%, #a65805 100%)";
  } else {
    healthBar.style.background = "linear-gradient(90deg, var(--color-crimson) 0%, var(--color-crimson-bright) 100%)";
  }

  // Injury state triggers
  const isInjured = state.damage >= (healthMax / 2);
  const injuredBadge = document.getElementById("tactical-injured-badge");
  if (isInjured && state.damage < healthMax) {
    injuredBadge.classList.remove("hidden");
  } else {
    injuredBadge.classList.add("hidden");
  }

  // Incapacitation Check
  if (state.damage >= healthMax && healthMax > 0) {
    triggerIncapacitation();
  } else {
    resolveIncapacitation();
  }

  // Sync Action states
  document.getElementById("action-fast-turn").checked = state.actions.fastTurn;
  document.getElementById("action-slow-turn").checked = state.actions.slowTurn;
  document.getElementById("action-triggered").checked = state.actions.triggered;
  document.getElementById("combat-round-counter").textContent = state.round;

  // Render traits
  document.getElementById("traits-container").innerHTML = `
    <strong style="color:var(--color-trim-bright); font-family:var(--font-header); display:block; margin-bottom:6px;">${ancData.name} Traits:</strong>
    <p style="font-size:12px; line-height:1.4;">${ancData.traits}</p>
    ${armorBane ? `<p style="color:var(--color-amber); font-weight:700; margin-top:8px; font-size:11px;">⚠️ HEAVY ARMOR ENCUMBRANCE: Attribute STR is below the requirement for ${equippedArmorName}! Half speed. 1 Bane applies to STR and AGI checks/attacks.</p>` : ""}
  `;

  // Render Quick Columns parchment pieces
  renderQuickEquipment();
  renderQuickTalents(ancData);
  renderQuickMagicSummary();

  // Dynamic Spells Lists
  renderCastingsMatrix();
  renderPreparedSpells();
  renderSpellsCatalog();
  renderCombatCastings();
  
  // Armory tables
  renderInventoryTable();
  renderArmoryCatalog();
  renderCombatWeapons(strMod, agiMod, armorBane);

  // Save State
  saveStateToLocalStorage();
}

// Adjust core attributes
function adjustAttribute(attr, amount) {
  if (state.isDead) return;
  state.attributes[attr] = Math.max(1, state.attributes[attr] + amount);
  recalculateSheet();
}

// Adjust damage tracker
function adjustDamage(amount) {
  if (state.isDead && amount > 0) return;
  const ancData = rules.ancestries[state.ancestry];
  const healthMax = ancData.health + (ancData.health_bonus || 0) + (state.level * 4) + state.healthMod;
  
  state.damage = Math.max(0, Math.min(healthMax, state.damage + amount));
  recalculateSheet();
}

// Apply Healing Rate
function applyHealingRate() {
  if (state.isDead) return;
  const ancData = rules.ancestries[state.ancestry];
  const healthMax = ancData.health + (ancData.health_bonus || 0) + (state.level * 4) + state.healthMod;
  const healRate = Math.max(1, Math.floor(healthMax / 4));
  
  adjustDamage(-healRate);
  addLogEntry("HEAL", `Applied healing rate. Restored ${healRate} Health.`);
}

// Render castings matrix
function renderCastingsMatrix() {
  const container = document.getElementById("castings-matrix-list");
  container.innerHTML = "";
  
  const powerLevelData = rules.castings_matrix.power_levels[state.power];
  if (!powerLevelData) {
    container.innerHTML = `<span style="font-size:11px; color:var(--text-muted)">No spell slots. Power: ${state.power}</span>`;
    return;
  }

  powerLevelData.forEach((count, rank) => {
    const item = document.createElement("div");
    item.className = "matrix-slot-item";
    item.innerHTML = `
      <span class="matrix-slot-rank">Rank ${rank}</span>
      <span class="matrix-slot-count">${count} Casts</span>
    `;
    container.appendChild(item);
  });
}

// Render Prepared Spells in Grimoire Tab
function renderPreparedSpells() {
  const container = document.getElementById("prepared-spells-list");
  container.innerHTML = "";

  if (state.preparedSpells.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: var(--text-muted)">No spells prepared.</p>`;
    return;
  }

  state.preparedSpells.forEach(spellName => {
    const spell = rules.spells_sample.find(s => s.name === spellName) || { name: spellName, tradition: "Custom", rank: 0 };
    
    const div = document.createElement("div");
    div.className = "prepared-item";
    div.innerHTML = `
      <div class="prepared-info">
        <span class="prepared-name">${spell.name}</span>
        <span class="prepared-details">${spell.tradition} • Rank ${spell.rank}</span>
      </div>
      <button class="btn-icon-del" onclick="removePreparedSpell('${spell.name}')" title="Unprepare Spell">
        Remove
      </button>
    `;
    container.appendChild(div);
  });
}

// Render spell codex catalog
function renderSpellsCatalog() {
  const container = document.getElementById("spells-library-container");
  container.innerHTML = "";

  const searchText = document.getElementById("spell-search").value.toLowerCase();
  const filterTrad = document.getElementById("filter-tradition").value;
  const filterRank = document.getElementById("filter-rank").value;

  // Traditions filters populate
  const traditionSelect = document.getElementById("filter-tradition");
  if (traditionSelect.options.length <= 1) {
    const traditions = [...new Set(rules.spells_sample.map(s => s.tradition))].sort();
    traditions.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      traditionSelect.appendChild(opt);
    });
  }

  // Get current Power limitations
  const castingsRow = rules.castings_matrix.power_levels[state.power];
  const maxRankAllowed = castingsRow ? castingsRow.length - 1 : 0;

  const filteredSpells = rules.spells_sample.filter(spell => {
    const matchesSearch = spell.name.toLowerCase().includes(searchText) || spell.desc.toLowerCase().includes(searchText);
    const matchesTradition = !filterTrad || spell.tradition === filterTrad;
    const matchesRank = !filterRank || spell.rank.toString() === filterRank;
    return matchesSearch && matchesTradition && matchesRank;
  });

  if (filteredSpells.length === 0) {
    container.innerHTML = `<p style="grid-column: 1/-1; text-align:center; padding:20px; color:var(--text-muted)">No matching scrolls found in registry.</p>`;
    return;
  }

  filteredSpells.forEach(spell => {
    const isPrepared = state.preparedSpells.includes(spell.name);
    const exceedsRankLimit = spell.rank > maxRankAllowed;
    
    const card = document.createElement("div");
    card.className = "spell-item-card";
    card.innerHTML = `
      <div class="spell-card-header">
        <span class="spell-card-name">${spell.name}</span>
        <div class="spell-card-meta">
          <span class="spell-badge badge-tradition">${spell.tradition}</span>
          <span class="spell-badge badge-rank">Rank ${spell.rank}</span>
        </div>
      </div>
      <p class="spell-card-desc">${spell.desc}</p>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
        ${exceedsRankLimit ? `<span style="font-size:10px; color:var(--color-crimson-bright)">⚠️ Exceeds Power Limit (Max Rank: ${maxRankAllowed})</span>` : "<span></span>"}
        <button class="spell-action-btn ${isPrepared ? 'btn-remove' : ''}" 
                ${exceedsRankLimit ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}
                onclick="${isPrepared ? `removePreparedSpell('${spell.name}')` : `addPreparedSpell('${spell.name}', ${spell.rank})`}">
          ${isPrepared ? 'Unprepare' : 'Prepare Spell'}
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

// Add Spell to prepared lists
function addPreparedSpell(name, rank) {
  if (state.isDead) return;
  const castingsRow = rules.castings_matrix.power_levels[state.power];
  const maxRankAllowed = castingsRow ? castingsRow.length - 1 : 0;
  
  if (rank > maxRankAllowed) {
    addLogEntry("WARNING", `Spell preparation failed: Rank ${rank} exceeds maximum rank allowable by Power index (${maxRankAllowed}).`);
    return;
  }

  if (!state.preparedSpells.includes(name)) {
    state.preparedSpells.push(name);
    recalculateSheet();
    addLogEntry("MAGIC", `Prepared spell: [${name}].`);
  }
}

// Remove prepared spells
function removePreparedSpell(name) {
  state.preparedSpells = state.preparedSpells.filter(n => n !== name);
  delete state.expendedCastings[name];
  recalculateSheet();
  addLogEntry("MAGIC", `Unprepared spell: [${name}].`);
}

function filterSpellLibrary() {
  renderSpellsCatalog();
}

// Render Inventory Equipment Table
function renderInventoryTable() {
  const tbody = document.getElementById("inventory-tbody");
  tbody.innerHTML = "";

  if (state.inventory.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">
          Armory empty. Procure weapons and armor from catalog below.
        </td>
      </tr>
    `;
    return;
  }

  state.inventory.forEach(item => {
    const isEquipped = item.equipped;
    
    // Check Str req warnings
    let warningMsg = "";
    if (item.type === "armor") {
      const strReqMatch = item.specs.toLowerCase().match(/requires strength (\d+)\+/);
      if (strReqMatch) {
        const reqStr = parseInt(strReqMatch[1], 10);
        if (state.attributes.str < reqStr) {
          warningMsg = `<span class="armory-warning">⚠️ Requires Strength ${reqStr}+ (Strength Deficient!)</span>`;
        }
      }
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${item.name}</strong>${warningMsg}</td>
      <td><span class="badge">${item.type}</span></td>
      <td style="color:var(--text-secondary); font-size:11px;">${item.specs}</td>
      <td>
        <div class="item-action-wrapper">
          <button class="toggle-switch-btn ${isEquipped ? 'equipped' : ''}" onclick="toggleEquipItem('${item.id}')">
            ${isEquipped ? 'Equipped' : 'Equip'}
          </button>
          <button class="btn-icon-del" onclick="deleteInventoryItem('${item.id}')" title="Discard Item">
            Discard
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Render Armory Catalog
function renderArmoryCatalog() {
  const container = document.getElementById("armory-catalog-container");
  container.innerHTML = "";

  rules.armory_catalog.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "spell-item-card";
    card.innerHTML = `
      <div class="spell-card-header">
        <span class="spell-card-name">${item.name}</span>
        <span class="spell-badge" style="background:rgba(0,0,0,0.3); border: 1px solid var(--color-trim-dim);">${item.type}</span>
      </div>
      <p class="spell-card-desc" style="font-size: 11px;">${item.specs}</p>
      <button class="spell-action-btn" style="margin-top:8px; border-color:var(--color-trim); color:var(--text-primary)" 
              onclick="acquireCatalogItem(${index})">
        Acquire Item
      </button>
    `;
    container.appendChild(card);
  });
}

// Acquire Item
function acquireCatalogItem(index) {
  if (state.isDead) return;
  const catalogItem = rules.armory_catalog[index];
  if (!catalogItem) return;

  const newItem = {
    id: "item_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    name: catalogItem.name,
    type: catalogItem.type,
    specs: catalogItem.specs,
    equipped: false
  };

  state.inventory.push(newItem);
  recalculateSheet();
  addLogEntry("ARMORY", `Acquired gear: ${newItem.name}`);
}

// Delete inventory item
function deleteInventoryItem(id) {
  const item = state.inventory.find(i => i.id === id);
  const name = item ? item.name : "Unknown Item";
  state.inventory = state.inventory.filter(i => i.id !== id);
  recalculateSheet();
  addLogEntry("ARMORY", `Discarded gear: ${name}`);
}

// Toggle equip state
function toggleEquipItem(id) {
  if (state.isDead) return;
  const targetItem = state.inventory.find(i => i.id === id);
  if (!targetItem) return;

  // Single armor constraint enforcement
  if (!targetItem.equipped && targetItem.type === "armor") {
    state.inventory.forEach(item => {
      if (item.type === "armor") item.equipped = false;
    });
  }

  targetItem.equipped = !targetItem.equipped;
  recalculateSheet();
  addLogEntry("ARMORY", `${targetItem.name} ${targetItem.equipped ? 'equipped' : 'unequipped'}.`);
}

// Add Custom Item
function addCustomItem() {
  if (state.isDead) return;
  const nameInput = document.getElementById("custom-item-name");
  const typeSelect = document.getElementById("custom-item-type");
  const specsInput = document.getElementById("custom-item-specs");

  const name = nameInput.value.trim();
  const type = typeSelect.value;
  const specs = specsInput.value.trim() || "No descriptors.";

  if (!name) {
    addLogEntry("WARNING", "Gear creation failed: item name is empty.");
    return;
  }

  const newItem = {
    id: "item_" + Date.now(),
    name: name,
    type: type,
    specs: specs,
    equipped: false
  };

  state.inventory.push(newItem);
  nameInput.value = "";
  specsInput.value = "";
  
  recalculateSheet();
  addLogEntry("ARMORY", `Forged custom gear: ${newItem.name}`);
}

// Render weapons on tactical sheets
function renderCombatWeapons(strMod, agiMod, armorBane) {
  const container = document.getElementById("combat-weapons-list");
  container.innerHTML = "";

  const equippedWeapons = state.inventory.filter(i => i.equipped && i.type === "weapon");

  if (equippedWeapons.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: var(--text-muted)">No weapons equipped. Access the Armory to equip weaponry.</p>`;
    return;
  }

  equippedWeapons.forEach(weapon => {
    const specs = weapon.specs.toLowerCase();
    
    // Check properties
    const isFinesse = specs.includes("finesse");
    
    let strActiveVal = strMod;
    let agiActiveVal = agiMod;

    // Apply armor bane penalty if needed
    if (armorBane) {
      // Show stats with banner banes
      strActiveVal = strMod;
      agiActiveVal = agiMod;
    }

    // Parse damage formula
    let damageExpr = "1d6";
    const dmgMatch = specs.match(/damage: (\d+d\d+(\+\d+)?)/);
    if (dmgMatch) {
      damageExpr = dmgMatch[1];
    } else {
      const simpleDmg = specs.match(/(\d+d\d+(\+\d+)?)/);
      if (simpleDmg) damageExpr = simpleDmg[1];
    }

    const card = document.createElement("div");
    card.className = "prepared-item";
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    card.style.gap = "8px";
    
    card.innerHTML = `
      <div class="flex-between">
        <div>
          <strong style="font-family:var(--font-header); font-size: 13px;">${weapon.name}</strong>
          <span style="font-size: 10px; color:var(--text-secondary); display:block;">${weapon.specs}</span>
        </div>
        <span class="badge" style="color:var(--color-trim-bright)">Dmg: ${damageExpr}</span>
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
        <button class="dice-btn" style="padding:6px; font-size:11px;" onclick="rollWeaponAttack('${weapon.name}', 'Strength', ${strMod}, '${damageExpr}', ${armorBane})">
          STR Attack (${strMod >= 0 ? "+" : ""}${strMod})
        </button>
        <button class="dice-btn" style="padding:6px; font-size:11px;" onclick="rollWeaponAttack('${weapon.name}', 'Agility', ${agiMod}, '${damageExpr}', ${armorBane})">
          AGI Attack (${agiMod >= 0 ? "+" : ""}${agiMod})
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

// Execute Weapon Attack Check
function rollWeaponAttack(weaponName, attrName, attrMod, damageExpr, armorBane) {
  if (state.isDead) return;
  
  let netBoons = state.boonBaneCount;
  let penaltyNote = "";

  // Apply armor banes
  if (armorBane && (attrName === "Strength" || attrName === "Agility")) {
    netBoons -= 1;
    penaltyNote = " (-1 Bane from heavy armor requirements mismatch)";
  }

  // Roll Attack d20
  const d20Roll = Math.floor(Math.random() * 20) + 1;
  let boonRolls = [];
  let highestBoonVal = 0;
  
  if (netBoons !== 0) {
    const count = Math.abs(netBoons);
    for (let i = 0; i < count; i++) {
      boonRolls.push(Math.floor(Math.random() * 6) + 1);
    }
    highestBoonVal = Math.max(...boonRolls);
  }

  const modifierAdd = attrMod;
  const boonAdjustment = netBoons > 0 ? highestBoonVal : (netBoons < 0 ? -highestBoonVal : 0);
  const finalTotal = d20Roll + modifierAdd + boonAdjustment;

  // Roll Damage
  const damageResult = rollParsedDamage(damageExpr);

  // Write log entries
  const time = getTimestamp();
  const logContainer = document.getElementById("roll-log");
  const entry = document.createElement("div");
  entry.className = `log-entry ${netBoons > 0 ? 'log-green' : (netBoons < 0 ? 'log-bane' : '')}`;
  
  let mathStr = `1d20 (${d20Roll}) + ${attrName} Mod (${attrMod >= 0 ? "+" : ""}${attrMod})`;
  if (netBoons > 0) mathStr += ` + Boon [${boonRolls.join(",")}] (highest: +${highestBoonVal})`;
  if (netBoons < 0) mathStr += ` - Bane [${boonRolls.join(",")}] (highest: -${highestBoonVal})`;
  
  entry.innerHTML = `
    <div class="log-header">
      <span>ATTACK: ${weaponName.toUpperCase()}</span>
      <span>${time}</span>
    </div>
    <div class="log-expr">${mathStr}${penaltyNote}</div>
    <div class="log-result">Attack Roll: <strong>${finalTotal}</strong></div>
    <div class="log-expr" style="margin-top:4px; border-top:1px solid rgba(128,107,80,0.1); padding-top:4px;">
      Damage (${damageExpr}): <strong>${damageResult.total}</strong> [rolls: ${damageResult.rolls.join("+")}${damageResult.plusValue ? '+' + damageResult.plusValue : ''}]
    </div>
  `;
  
  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;

  addLogEntry("COMBAT", `Attacked with ${weaponName}. Roll: ${finalTotal}. Damage: ${damageResult.total}`);
}

// Execute Attribute check
function rollAttributeCheck(attrLabel, attrKey) {
  if (state.isDead) return;
  
  const attrVal = state.attributes[attrKey];
  const modifier = attrVal - 10;
  
  let netBoons = state.boonBaneCount;
  let penaltyNote = "";
  
  // Apply heavy armor checks
  const equippedArmor = state.inventory.find(i => i.equipped && i.type === "armor");
  if (equippedArmor && (attrKey === "str" || attrKey === "agi")) {
    const specs = equippedArmor.specs.toLowerCase();
    const strReqMatch = specs.match(/requires strength (\d+)\+/);
    if (strReqMatch) {
      const reqStr = parseInt(strReqMatch[1], 10);
      if (state.attributes.str < reqStr) {
        netBoons -= 1;
        penaltyNote = " (-1 Bane from armor Strength requirements)";
      }
    }
  }

  // Roll d20
  const d20Roll = Math.floor(Math.random() * 20) + 1;
  let boonRolls = [];
  let highestBoonVal = 0;
  
  if (netBoons !== 0) {
    const count = Math.abs(netBoons);
    for (let i = 0; i < count; i++) {
      boonRolls.push(Math.floor(Math.random() * 6) + 1);
    }
    highestBoonVal = Math.max(...boonRolls);
  }

  const boonAdjustment = netBoons > 0 ? highestBoonVal : (netBoons < 0 ? -highestBoonVal : 0);
  const finalTotal = d20Roll + modifier + boonAdjustment;

  const time = getTimestamp();
  const logContainer = document.getElementById("roll-log");
  const entry = document.createElement("div");
  entry.className = `log-entry ${netBoons > 0 ? 'log-green' : (netBoons < 0 ? 'log-bane' : '')}`;
  
  let mathStr = `1d20 (${d20Roll}) + ${attrLabel} Mod (${modifier >= 0 ? "+" : ""}${modifier})`;
  if (netBoons > 0) mathStr += ` + Boon [${boonRolls.join(",")}] (highest: +${highestBoonVal})`;
  if (netBoons < 0) mathStr += ` - Bane [${boonRolls.join(",")}] (highest: -${highestBoonVal})`;
  
  entry.innerHTML = `
    <div class="log-header">
      <span>CHALLENGE: ${attrLabel.toUpperCase()}</span>
      <span>${time}</span>
    </div>
    <div class="log-expr">${mathStr}${penaltyNote}</div>
    <div class="log-result">Total: <strong>${finalTotal}</strong> ${finalTotal >= 10 ? '<span class="text-green">[SUCCESS]</span>' : '<span class="text-red">[FAILURE]</span>'}</div>
  `;
  
  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;
}

// Roll parsed damage codes
function rollParsedDamage(expr) {
  expr = expr.replace(/\s+/g, "").toLowerCase();
  const match = expr.match(/(\d+)d(\d+)(\+(\d+))?/);
  if (!match) {
    return { total: 0, rolls: [0], plusValue: 0 };
  }

  const diceCount = parseInt(match[1], 10);
  const diceSides = parseInt(match[2], 10);
  const plusValue = match[4] ? parseInt(match[4], 10) : 0;

  let rolls = [];
  let total = 0;

  for (let i = 0; i < diceCount; i++) {
    const r = Math.floor(Math.random() * diceSides) + 1;
    rolls.push(r);
    total += r;
  }

  total += plusValue;
  return { total, rolls, plusValue };
}

// Roll generic dice
function rollDice(sides, label) {
  if (state.isDead) return;
  const roll = Math.floor(Math.random() * sides) + 1;
  const time = getTimestamp();
  
  const logContainer = document.getElementById("roll-log");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `
    <div class="log-header">
      <span>ROLL: ${label.toUpperCase()}</span>
      <span>${time}</span>
    </div>
    <div class="log-expr">1d${sides} (${roll})</div>
    <div class="log-result">Rolled: <strong>${roll}</strong></div>
  `;
  
  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;
}

// Render spell castings expended bubble matrix
function renderCombatCastings() {
  const container = document.getElementById("combat-castings-container");
  container.innerHTML = "";

  if (state.preparedSpells.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: var(--text-muted)">Prepare spells in Grimoire to populate castings checks.</p>`;
    return;
  }

  // Group prepared spells by rank
  const groupedSpells = {};
  state.preparedSpells.forEach(spellName => {
    const spell = rules.spells_sample.find(s => s.name === spellName) || { name: spellName, tradition: "Custom", rank: 0, desc: "No description available." };
    if (!groupedSpells[spell.rank]) {
      groupedSpells[spell.rank] = [];
    }
    groupedSpells[spell.rank].push(spell);
  });

  const castingsRow = rules.castings_matrix.power_levels[state.power];
  
  Object.keys(groupedSpells).sort().forEach(rankStr => {
    const rank = parseInt(rankStr, 10);
    const spells = groupedSpells[rank];
    const totalCastings = castingsRow && castingsRow[rank] !== undefined ? castingsRow[rank] : 1;

    const rankDiv = document.createElement("div");
    rankDiv.className = "combat-rank-group";
    rankDiv.innerHTML = `<div class="combat-rank-title">Rank ${rank} Spells (Max Casts: ${totalCastings} per spell)</div>`;

    const spellList = document.createElement("div");
    spellList.className = "prepared-panel-list";
    spellList.style.marginTop = "8px";

    spells.forEach(spell => {
      const expendedCount = state.expendedCastings[spell.name] || 0;
      
      const spellItem = document.createElement("div");
      spellItem.className = "prepared-item";
      spellItem.style.flexDirection = "column";
      spellItem.style.alignItems = "stretch";
      spellItem.style.gap = "6px";

      let tickBubblesHtml = "";
      for (let i = 1; i <= totalCastings; i++) {
        const isExpended = i <= expendedCount;
        tickBubblesHtml += `<div class="casting-bubble ${isExpended ? 'expended' : ''}" onclick="toggleSpellCasting('${spell.name}', ${i}, ${totalCastings})"></div>`;
      }

      spellItem.innerHTML = `
        <div class="flex-between">
          <div style="cursor:pointer;" onclick="displaySpellDescription('${spell.name}')" title="Scroll Details">
            <strong>${spell.name}</strong>
            <span style="font-size:10px; color:var(--text-secondary); display:block;">${spell.tradition} • click for details</span>
          </div>
          <div class="castings-expend-slots">${tickBubblesHtml}</div>
        </div>
      `;
      spellList.appendChild(spellItem);
    });

    rankDiv.appendChild(spellList);
    container.appendChild(rankDiv);
  });
}

function toggleSpellCasting(spellName, index, totalCastings) {
  if (state.isDead) return;
  const currentExpended = state.expendedCastings[spellName] || 0;

  if (currentExpended >= index) {
    state.expendedCastings[spellName] = index - 1;
    addLogEntry("MAGIC", `Restored cast slot for [${spellName}]. Remaining: ${totalCastings - (index - 1)}`);
  } else {
    state.expendedCastings[spellName] = index;
    addLogEntry("MAGIC", `Cast spell: [${spellName}]. Remaining: ${totalCastings - index}`);
    displaySpellDescription(spellName);
  }
  recalculateSheet();
}

function displaySpellDescription(name) {
  const spell = rules.spells_sample.find(s => s.name === name);
  if (!spell) return;

  const time = getTimestamp();
  const logContainer = document.getElementById("roll-log");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.style.borderLeftColor = "var(--color-purple)";
  
  entry.innerHTML = `
    <div class="log-header">
      <span>SPELL: ${spell.name.toUpperCase()}</span>
      <span>${time}</span>
    </div>
    <div class="log-expr">Tradition: ${spell.tradition} | Rank ${spell.rank}</div>
    <div class="log-result" style="font-size:11px; font-weight:normal; line-height:1.4;">${spell.desc}</div>
  `;
  
  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;
}

function updateBoonDisplay() {
  const label = document.getElementById("boon-display");
  if (state.boonBaneCount > 0) {
    label.textContent = `+${state.boonBaneCount} Boon${state.boonBaneCount > 1 ? 's' : ''}`;
    label.className = "boon-count text-green";
  } else if (state.boonBaneCount < 0) {
    label.textContent = `${state.boonBaneCount} Bane${state.boonBaneCount < -1 ? 's' : ''}`;
    label.className = "boon-count text-orange";
  } else {
    label.textContent = "0";
    label.className = "boon-count";
  }
}

function nextRoundClock() {
  if (state.isDead) return;
  state.round++;
  
  state.actions.fastTurn = false;
  state.actions.slowTurn = false;
  state.actions.triggered = false;
  
  recalculateSheet();
  addLogEntry("SYSTEM", `Advanced to Combat Round ${state.round}. Action trackers refreshed.`);
}

// Incapacitation Track mechanics
function triggerIncapacitation() {
  if (state.isIncapacitated || state.isDead) return;
  state.isIncapacitated = true;
  
  const overlay = document.getElementById("incapacitated-overlay");
  overlay.classList.remove("hidden");
  
  state.fateSuccesses = 0;
  state.fateFailures = 0;
  updateFateVisualTracks();
  
  document.getElementById("fate-roll-result-text").textContent = "Press button to roll fate check (1d6).";
  document.getElementById("roll-fate-btn").classList.remove("hidden");
  document.getElementById("revive-btn").classList.add("hidden");

  addLogEntry("DANGER", "CRITICAL INJURY: Collapse. Fate loop engaged.");
}

function resolveIncapacitation() {
  state.isIncapacitated = false;
  document.getElementById("incapacitated-overlay").classList.add("hidden");
}

function rollFateCheck() {
  if (state.isDead || !state.isIncapacitated) return;

  const roll = Math.floor(Math.random() * 6) + 1;
  let resultText = "";
  
  if (roll === 6) {
    resultText = "Critical Reboot! Rolled 6. You heal 1 damage, stabilize, and regain consciousness!";
    state.damage -= 1;
    state.isIncapacitated = false;
    setTimeout(() => {
      resolveIncapacitation();
      recalculateSheet();
    }, 1500);
  } else if (roll === 1) {
    state.fateFailures++;
    resultText = `Failing! Rolled 1. Dying Track failure marked (${state.fateFailures}/3).`;
    if (state.fateFailures >= 3) {
      triggerDeath();
      resultText = "SLAYED: 3 failures reached. Character deceased.";
    }
  } else {
    state.fateSuccesses++;
    resultText = `Holding on. Rolled ${roll}. Stabilize Track success marked (${state.fateSuccesses}/3).`;
    if (state.fateSuccesses >= 3) {
      state.isIncapacitated = false;
      resultText = "Stabilized! 3 successes marked. You are stable but Disabled.";
      setTimeout(() => {
        resolveIncapacitation();
        recalculateSheet();
      }, 1500);
    }
  }

  document.getElementById("fate-roll-result-text").textContent = resultText;
  updateFateVisualTracks();
  addLogEntry("FATE", `Fate roll check: ${roll}. ${resultText}`);
}

function updateFateVisualTracks() {
  for (let i = 1; i <= 3; i++) {
    const succBubble = document.getElementById(`fate-success-${i}`);
    const failBubble = document.getElementById(`fate-fail-${i}`);
    
    if (i <= state.fateSuccesses) {
      succBubble.className = "fate-bubble active-fate-success";
    } else {
      succBubble.className = "fate-bubble";
    }

    if (i <= state.fateFailures) {
      failBubble.className = "fate-bubble active-fate-failure";
    } else {
      failBubble.className = "fate-bubble";
    }
  }
}

function triggerDeath() {
  state.isDead = true;
  state.name = `DEAD: ${state.name}`;
  document.getElementById("roll-fate-btn").classList.add("hidden");
  document.getElementById("revive-btn").classList.remove("hidden");
  
  addLogEntry("DEATH", "CHARACTER DECEASED. CORE SAVED. REBOOT AND RESURRECT IN WIZARD.");
}

function forceRevive() {
  state.isDead = false;
  state.isIncapacitated = false;
  state.damage = 0;
  state.fateSuccesses = 0;
  state.fateFailures = 0;
  
  if (state.name.startsWith("DEAD: ")) {
    state.name = state.name.replace("DEAD: ", "");
  }
  
  resolveIncapacitation();
  recalculateSheet();
  addLogEntry("SYSTEM", "Character manually resurrected. Health reset.");
}

// Log logs
function addLogEntry(source, message) {
  const time = getTimestamp();
  const logContainer = document.getElementById("roll-log");
  if (!logContainer) return;

  const entry = document.createElement("div");
  entry.className = "log-entry";
  
  if (source === "ERROR" || source === "DANGER" || source === "DEATH") {
    entry.className += " log-red";
  } else if (source === "SYSTEM" || source === "MAGIC") {
    entry.className += " log-green";
  } else if (source === "ARMORY") {
    entry.className += " log-bane";
  } else if (source === "HEAL" || source === "FATE") {
    entry.className += " log-green";
  }

  entry.innerHTML = `
    <div class="log-header">
      <span>${source}</span>
      <span>${time}</span>
    </div>
    <div class="log-result" style="font-size: 11px; font-weight: normal; color: var(--text-primary);">${message}</div>
  `;

  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;
}

function getTimestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

// LocalStorage State Preservation
function saveStateToLocalStorage() {
  localStorage.setItem("sotdl_character_state", JSON.stringify(state));
}

function loadSavedState() {
  const saved = localStorage.getItem("sotdl_character_state");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      state = Object.assign({}, DEFAULT_STATE, parsed);
      updateBoonDisplay();
    } catch (e) {
      console.error("Failed to load saved state:", e);
    }
  }
}

// Export Character JSON
function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  
  const safeName = state.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  a.download = `sotdl_${safeName}_hero.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  addLogEntry("SYSTEM", "Character chronicle saved.");
}

// Import Character JSON
function importState(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const parsed = JSON.parse(evt.target.result);
      state = Object.assign({}, DEFAULT_STATE, parsed);
      
      // Close wizard if open
      document.getElementById("wizard-overlay").classList.add("hidden");
      
      recalculateSheet();
      updateBoonDisplay();
      addLogEntry("SYSTEM", "Character chronicle loaded.");
    } catch (err) {
      addLogEntry("ERROR", "Failed to decode state package.");
    }
  };
  reader.readAsText(file);
}

// ==========================================
// CHARACTER CREATION ONBOARDING WIZARD LOGIC
// ==========================================

function startWizard() {
  // Reset wizard temporary state
  wizardStep = 1;
  wizardState = {
    ancestry: "human",
    level: 1,
    novicePath: "warrior",
    attributes: { str: 10, agi: 10, int: 10, wil: 10 },
    boostsRemaining: 2,
    boostedAttrs: { str: 0, agi: 0, int: 0, wil: 0 },
    professions: "Hunter",
    languages: "Common Tongue",
    background: "You spent years as a guide in the wild wood, learning the tracks of creatures.",
    spells: [],
    name: "Unnamed Hero",
    appearance: ""
  };

  // Render lists in wizard DOM
  renderWizardAncestryChoices();
  renderWizardNovicePaths();
  setupWizardSpellFilters();
  
  // Show Wizard container
  document.getElementById("wizard-overlay").classList.remove("hidden");
  renderWizardStep(1);
}

function renderWizardStep(step) {
  wizardStep = step;
  
  // Hide all step sections
  for (let i = 1; i <= 6; i++) {
    document.getElementById(`wstep-${i}`).classList.add("hidden");
    document.getElementById(`step-mark-${i}`).classList.remove("active");
  }
  
  // Show current step section
  document.getElementById(`wstep-${step}`).classList.remove("hidden");
  document.getElementById(`step-mark-${step}`).classList.add("active");
  
  // Back & Next Buttons states
  const backBtn = document.getElementById("wbtn-back");
  const nextBtn = document.getElementById("wbtn-next");
  
  backBtn.disabled = step === 1;
  backBtn.className = step === 1 ? "term-btn-action btn-secondary" : "term-btn-action";
  
  if (step === 6) {
    nextBtn.textContent = "Forge Character";
    nextBtn.className = "term-btn-action btn-danger";
  } else {
    nextBtn.textContent = "Next";
    nextBtn.className = "term-btn-action";
  }

  // Pre-action calculations per step transition
  if (step === 3) {
    calculateWizardAttributeBoosts();
    renderWizardAttributeMatrix();
  } else if (step === 5) {
    renderWizardSpellLibrary();
  } else if (step === 6) {
    renderWizardFinalSummary();
  }
}

function prevWizardStep() {
  if (wizardStep > 1) {
    renderWizardStep(wizardStep - 1);
  }
}

function nextWizardStep() {
  // Custom validation steps
  if (wizardStep === 1) {
    if (!wizardState.ancestry) return;
  } else if (wizardStep === 3) {
    if (wizardState.boostsRemaining > 0) {
      alert(`Please allocate your remaining ${wizardState.boostsRemaining} attribute boosts before proceeding.`);
      return;
    }
  } else if (wizardStep === 5) {
    // Spells validation: check magic limits
    const pathData = rules.novice_paths[wizardState.novicePath];
    const pathLimit = wizardState.level === 1 ? (wizardState.novicePath === "magician" ? 3 : (wizardState.novicePath === "priest" ? 2 : 0)) : 0;
    if (wizardState.spells.length < pathLimit && pathLimit > 0) {
      if (!confirm(`You have selected only ${wizardState.spells.length}/${pathLimit} starting spells. Proceed anyway?`)) {
        return;
      }
    }
  } else if (wizardStep === 6) {
    // Conclude Forge
    finalizeWizardCharacter();
    return;
  }
  
  renderWizardStep(wizardStep + 1);
}

function jumpToWizardStep(step) {
  // Allow skipping backwards or jumping only if steps completed
  if (step < wizardStep) {
    renderWizardStep(step);
  }
}

// Render Step 1 Ancestries cards
function renderWizardAncestryChoices() {
  const container = document.getElementById("wizard-ancestry-list");
  container.innerHTML = "";
  
  Object.keys(rules.ancestries).forEach(key => {
    const anc = rules.ancestries[key];
    const isSelected = wizardState.ancestry === key;
    
    const card = document.createElement("div");
    card.className = `wizard-ancestry-card ${isSelected ? 'selected' : ''}`;
    card.onclick = () => selectWizardAncestry(key);
    card.innerHTML = `
      <div class="wizard-ancestry-name">${anc.name}</div>
      <div style="font-size:11px; color:var(--text-secondary)">Health: ${anc.health + (anc.health_bonus || 0)} | Speed: ${anc.speed}</div>
    `;
    container.appendChild(card);
  });
  
  updateWizardAncestryDetails();
}

function selectWizardAncestry(key) {
  wizardState.ancestry = key;
  
  // Set starting values from ancestry
  const anc = rules.ancestries[key];
  wizardState.attributes.str = anc.base_attributes.str;
  wizardState.attributes.agi = anc.base_attributes.agi;
  wizardState.attributes.int = anc.base_attributes.int;
  wizardState.attributes.wil = anc.base_attributes.wil;
  
  renderWizardAncestryChoices();
}

function updateWizardAncestryDetails() {
  const details = document.getElementById("wizard-ancestry-details");
  const anc = rules.ancestries[wizardState.ancestry];
  
  if (!anc) {
    details.classList.add("hidden");
    return;
  }
  
  details.classList.remove("hidden");
  details.innerHTML = `
    <strong style="font-family:var(--font-header); font-size:14px; color:var(--color-trim-bright); display:block; margin-bottom:6px;">${anc.name} Starting Characteristics</strong>
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-bottom:8px; font-family:var(--font-mono); font-size:12px;">
      <div>STR: ${anc.base_attributes.str}</div>
      <div>AGI: ${anc.base_attributes.agi}</div>
      <div>INT: ${anc.base_attributes.int}</div>
      <div>WIL: ${anc.base_attributes.wil}</div>
    </div>
    <div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">
      <strong>Base Health:</strong> ${anc.health + (anc.health_bonus || 0)} | <strong>Speed:</strong> ${anc.speed} yards | <strong>Size:</strong> ${anc.size}
    </div>
    <div style="font-size:12px; line-height:1.4;">
      <strong>Traits:</strong> ${anc.traits}
    </div>
  `;
}

// Render Step 2 Novice Paths cards
function renderWizardNovicePaths() {
  const container = document.getElementById("wizard-path-list");
  container.innerHTML = "";
  
  // Bind levels selection trigger
  const lvlSelect = document.getElementById("wizard-level-select");
  lvlSelect.onchange = (e) => {
    wizardState.level = parseInt(e.target.value, 10);
    if (wizardState.level === 0) {
      wizardState.novicePath = "none";
      document.getElementById("wizard-path-selection-section").classList.add("hidden");
    } else {
      document.getElementById("wizard-path-selection-section").classList.remove("hidden");
      if (wizardState.novicePath === "none") wizardState.novicePath = "warrior";
    }
    renderWizardNovicePaths();
  };
  
  wizardState.level = parseInt(lvlSelect.value, 10);
  if (wizardState.level === 0) {
    document.getElementById("wizard-path-selection-section").classList.add("hidden");
    wizardState.novicePath = "none";
    updateWizardPathDetails();
    return;
  }
  
  document.getElementById("wizard-path-selection-section").classList.remove("hidden");
  
  Object.keys(rules.novice_paths).forEach(key => {
    if (key === "none") return; // Skip Level 0 in list
    const path = rules.novice_paths[key];
    const isSelected = wizardState.novicePath === key;
    
    const card = document.createElement("div");
    card.className = `wizard-path-card ${isSelected ? 'selected' : ''}`;
    card.onclick = () => selectWizardPath(key);
    card.innerHTML = `
      <div class="wizard-path-name">${path.name}</div>
      <div style="font-size:11px; color:var(--text-secondary)">Health Boost: +${path.health_bonus}</div>
    `;
    container.appendChild(card);
  });
  
  updateWizardPathDetails();
}

function selectWizardPath(key) {
  wizardState.novicePath = key;
  renderWizardNovicePaths();
}

function updateWizardPathDetails() {
  const details = document.getElementById("wizard-path-details");
  const path = rules.novice_paths[wizardState.novicePath];
  
  if (!path) {
    details.classList.add("hidden");
    return;
  }
  
  details.classList.remove("hidden");
  details.innerHTML = `
    <strong style="font-family:var(--font-header); font-size:13px; color:var(--color-trim-bright); display:block; margin-bottom:4px;">${path.name} Training Details</strong>
    <p style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">${path.description}</p>
    <div style="font-size:11px; line-height:1.4;">
      <strong>Benefits:</strong> Health +${path.health_bonus} | Power +${path.power_bonus} | Attribute Increases: +1 to ${path.attributes_boosts} scores.
    </div>
    <div style="font-size:11px; margin-top:4px;">
      <strong>Training Traits:</strong> ${path.features}
    </div>
  `;
}

// Calculate starting attribute boosts allowed
function calculateWizardAttributeBoosts() {
  const path = rules.novice_paths[wizardState.novicePath];
  const isHuman = wizardState.ancestry === "human";
  
  // Base Path boosts + Human starting bonus of +1
  const pathBoostsVal = path ? path.attributes_boosts : 0;
  const totalBoostsAllowed = pathBoostsVal + (isHuman ? 1 : 0);
  
  // Calculate spent
  const spent = wizardState.boostedAttrs.str + wizardState.boostedAttrs.agi + wizardState.boostedAttrs.int + wizardState.boostedAttrs.wil;
  wizardState.boostsRemaining = Math.max(0, totalBoostsAllowed - spent);
}

// Render Step 3 Boost adjustments
function renderWizardAttributeMatrix() {
  const container = document.getElementById("wizard-attr-cards");
  container.innerHTML = "";
  
  const attrLabels = {
    str: "Strength (STR)",
    agi: "Agility (AGI)",
    int: "Intellect (INT)",
    wil: "Willpower (WIL)"
  };
  
  Object.keys(attrLabels).forEach(key => {
    const baseVal = wizardState.attributes[key];
    const boostVal = wizardState.boostedAttrs[key];
    const finalVal = baseVal + boostVal;
    
    const card = document.createElement("div");
    card.className = "attribute-card";
    card.style.background = "rgba(0,0,0,0.3)";
    card.innerHTML = `
      <span class="attribute-name">${attrLabels[key]}</span>
      <div class="attribute-value-wrapper">
        <button class="attribute-btn" onclick="adjustWizardAttributeBoost('${key}', -1)">-</button>
        <span class="attribute-input-value">${finalVal}</span>
        <button class="attribute-btn" onclick="adjustWizardAttributeBoost('${key}', 1)">+</button>
      </div>
      <span class="attribute-mod" style="font-size:10px;">Base: ${baseVal} | Boost: +${boostVal}</span>
    `;
    container.appendChild(card);
  });
  
  // Update instructions and rules panel
  const tracker = document.getElementById("wizard-boosts-tracker");
  const path = rules.novice_paths[wizardState.novicePath];
  const isHuman = wizardState.ancestry === "human";
  
  document.getElementById("wizard-boosts-instruction").innerHTML = `
    Ancestry starting attributes: <strong>STR: ${wizardState.attributes.str}, AGI: ${wizardState.attributes.agi}, INT: ${wizardState.attributes.int}, WIL: ${wizardState.attributes.wil}</strong>.<br>
    ${isHuman ? "Human: choose +1 score. " : ""}${wizardState.level > 0 ? `${path.name} path: choose +1 to ${path.attributes_boosts} scores.` : ""}
  `;
  
  tracker.innerHTML = `
    <div style="font-size:14px; font-weight:700; margin-bottom:8px; color:var(--color-crimson-bright)">Remaining points: ${wizardState.boostsRemaining}</div>
    <ul style="padding-left:14px; margin-top:4px; font-size:11px;">
      <li>Enforce distributing boosts across core statistics.</li>
      <li>Each increase adds +1 to the selected attribute score.</li>
    </ul>
  `;
}

function adjustWizardAttributeBoost(attr, amt) {
  const currentBoost = wizardState.boostedAttrs[attr];
  
  if (amt > 0) {
    if (wizardState.boostsRemaining > 0) {
      // SotDL Novice Path boosts: increase different attribute scores by 1.
      // So max path boost to any single attribute is 1. (Except humans can combine human boost and path boost, so max 2 for human).
      const maxAllowedBoost = wizardState.ancestry === "human" ? 2 : 1;
      if (currentBoost < maxAllowedBoost) {
        wizardState.boostedAttrs[attr]++;
      } else {
        alert(`Maximum boost to single attributes is limited to +${maxAllowedBoost}.`);
      }
    }
  } else {
    if (currentBoost > 0) {
      wizardState.boostedAttrs[attr]--;
    }
  }
  
  calculateWizardAttributeBoosts();
  renderWizardAttributeMatrix();
}

// Step 4: Background Roll
function rollWizardBackground() {
  const idx = Math.floor(Math.random() * BACKGROUNDS.length);
  document.getElementById("wizard-background-text").value = BACKGROUNDS[idx];
  wizardState.background = BACKGROUNDS[idx];
}

// Step 5: Spell selections Filter
function setupWizardSpellFilters() {
  const filter = document.getElementById("wizard-spell-tradition-filter");
  filter.innerHTML = "<option value=''>All traditions</option>";
  
  const traditions = [...new Set(rules.spells_sample.map(s => s.tradition))].sort();
  traditions.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    filter.appendChild(opt);
  });
}

function filterWizardSpellLibrary() {
  renderWizardSpellLibrary();
}

function renderWizardSpellLibrary() {
  const container = document.getElementById("wizard-spell-registry-list");
  container.innerHTML = "";
  
  const filterTrad = document.getElementById("wizard-spell-tradition-filter").value;
  
  // Power limits
  const path = rules.novice_paths[wizardState.novicePath];
  const powerVal = path ? path.power_bonus : 0;
  
  // If Level 0, power is 0. If level 1 Priest/Magician, power is 1.
  const pathLimit = wizardState.level === 1 ? (wizardState.novicePath === "magician" ? 3 : (wizardState.novicePath === "priest" ? 2 : 0)) : 0;
  
  document.getElementById("wizard-spell-count-tracker").textContent = `Spell Slots Allocation: ${wizardState.spells.length} / ${pathLimit}`;
  
  if (pathLimit === 0) {
    container.innerHTML = `<p style="text-align:center; padding:20px; color:var(--text-muted)">Your novice path (${wizardState.novicePath === "none" ? "Level 0" : path.name}) does not grant magic spells at creation.</p>`;
    return;
  }
  
  const filtered = rules.spells_sample.filter(spell => {
    // Only show rank <= power
    const matchesRank = spell.rank <= powerVal;
    const matchesTradition = !filterTrad || spell.tradition === filterTrad;
    return matchesRank && matchesTradition;
  });
  
  filtered.forEach(spell => {
    const isSelected = wizardState.spells.includes(spell.name);
    
    const card = document.createElement("div");
    card.className = "spell-item-card";
    card.style.background = "rgba(0,0,0,0.3)";
    card.innerHTML = `
      <div class="spell-card-header">
        <span class="spell-card-name" style="font-size:13px;">${spell.name}</span>
        <div class="spell-card-meta">
          <span class="spell-badge badge-tradition">${spell.tradition}</span>
          <span class="spell-badge badge-rank">Rank ${spell.rank}</span>
        </div>
      </div>
      <p class="spell-card-desc" style="font-size:11px;">${spell.desc}</p>
      <button class="spell-action-btn ${isSelected ? 'btn-remove' : ''}" style="margin-top:4px;" 
              onclick="toggleWizardSpell('${spell.name}', ${pathLimit})">
        ${isSelected ? 'Remove' : 'Select Spell'}
      </button>
    `;
    container.appendChild(card);
  });
}

function toggleWizardSpell(name, limit) {
  const idx = wizardState.spells.indexOf(name);
  if (idx >= 0) {
    wizardState.spells.splice(idx, 1);
  } else {
    if (wizardState.spells.length < limit) {
      wizardState.spells.push(name);
    } else {
      alert(`Starting spell selection limit reached (${limit}). Remove a spell first.`);
    }
  }
  renderWizardSpellLibrary();
}

// Step 6: Final Review summary
function renderWizardFinalSummary() {
  const summary = document.getElementById("wizard-finalize-summary");
  const path = rules.novice_paths[wizardState.novicePath];
  const anc = rules.ancestries[wizardState.ancestry];
  
  const finalStr = wizardState.attributes.str + wizardState.boostedAttrs.str;
  const finalAgi = wizardState.attributes.agi + wizardState.boostedAttrs.agi;
  const finalInt = wizardState.attributes.int + wizardState.boostedAttrs.int;
  const finalWil = wizardState.attributes.wil + wizardState.boostedAttrs.wil;
  
  const baseHealth = anc.health + (anc.health_bonus || 0);
  const healthMax = baseHealth + (wizardState.level * 4) + path.health_bonus;
  
  let defense = finalAgi;
  if (anc.defense_flat !== null) defense = anc.defense_flat;
  
  summary.innerHTML = `
    <div style="grid-column: span 2;">
      <strong>Strain (Ancestry):</strong> ${anc.name}<br>
      <strong>Level:</strong> ${wizardState.level} | <strong>Path:</strong> ${path.name}<br>
      <strong>Power:</strong> ${path.power_bonus} | <strong>Size:</strong> ${anc.size} | <strong>Speed:</strong> ${anc.speed}
    </div>
    <div style="grid-column: span 2;">
      <strong>Max Health:</strong> ${healthMax}<br>
      <strong>Defense:</strong> ${defense}<br>
      <strong>Corruption:</strong> ${anc.corruption} | <strong>Insanity:</strong> ${anc.insanity}<br>
    </div>
    <div style="grid-column: span 4; border-top: 1px solid var(--color-trim-dim); padding-top: 8px; margin-top:4px;">
      <strong>Attributes:</strong> STR: ${finalStr} | AGI: ${finalAgi} | INT: ${finalInt} | WIL: ${finalWil}<br>
      <strong>Professions:</strong> ${document.getElementById("wizard-professions").value || "None"}<br>
      <strong>Spellbook:</strong> ${wizardState.spells.join(", ") || "None"}
    </div>
  `;
}

// Finalize Wizard & Forge Character
function finalizeWizardCharacter() {
  const path = rules.novice_paths[wizardState.novicePath];
  const anc = rules.ancestries[wizardState.ancestry];
  
  // Set main state
  state.name = document.getElementById("wizard-char-name").value.trim() || "Unnamed Hero";
  state.ancestry = wizardState.ancestry;
  state.level = wizardState.level;
  state.novicePath = wizardState.novicePath;
  state.power = path.power_bonus;
  
  // Final attributes (base + boosts)
  state.attributes.str = wizardState.attributes.str + wizardState.boostedAttrs.str;
  state.attributes.agi = wizardState.attributes.agi + wizardState.boostedAttrs.agi;
  state.attributes.int = wizardState.attributes.int + wizardState.boostedAttrs.int;
  state.attributes.wil = wizardState.attributes.wil + wizardState.boostedAttrs.wil;
  
  state.healthMod = path.health_bonus;
  state.damage = 0;
  state.insanity = anc.insanity;
  state.corruption = anc.corruption;
  
  state.professions = document.getElementById("wizard-professions").value.trim() + "\nLanguages: " + document.getElementById("wizard-languages").value.trim();
  state.notes = "Background: " + (document.getElementById("wizard-background-text").value || "None") + "\nAppearance: " + (document.getElementById("wizard-appearance").value || "No descriptions.");
  
  // Spells
  state.preparedSpells = wizardState.spells;
  state.expendedCastings = {};
  
  // Starting Gear pack allocations based on path
  state.inventory = [];
  
  // Automated starter equipment packages
  if (state.novicePath === "warrior") {
    state.inventory.push({ id: "gear_1", name: "Sword / Battleaxe", type: "weapon", specs: "Damage: 1d6+2 • One Handed • Requires Strength 11+", equipped: true });
    state.inventory.push({ id: "gear_2", name: "Soft Leather Armor", type: "armor", specs: "Defense Base Value: Agility + 1", equipped: true });
  } else if (state.novicePath === "rogue") {
    state.inventory.push({ id: "gear_1", name: "Dagger / Knife", type: "weapon", specs: "Damage: 1d3 • Off Hand • Finesse, Thrown", equipped: true });
    state.inventory.push({ id: "gear_2", name: "Soft Leather Armor", type: "armor", specs: "Defense Base Value: Agility + 1", equipped: true });
  } else if (state.novicePath === "magician") {
    state.inventory.push({ id: "gear_1", name: "Staff", type: "weapon", specs: "Damage: 1d6+1 • Two Handed • Finesse", equipped: true });
  } else if (state.novicePath === "priest") {
    state.inventory.push({ id: "gear_1", name: "Club", type: "weapon", specs: "Damage: 1d6 • One Handed", equipped: true });
    state.inventory.push({ id: "gear_2", name: "Soft Leather Armor", type: "armor", specs: "Defense Base Value: Agility + 1", equipped: true });
  } else {
    // level 0 none
    state.inventory.push({ id: "gear_1", name: "Dagger / Knife", type: "weapon", specs: "Damage: 1d3 • Off Hand • Finesse, Thrown", equipped: true });
  }
  
  // Clean logs
  document.getElementById("roll-log").innerHTML = "";
  
  // Recalculate and close
  recalculateSheet();
  document.getElementById("wizard-overlay").classList.add("hidden");
  
  addLogEntry("SYSTEM", `Character ${state.name} forged. Welcome to the dying lands.`);
}

// Render quick equipment list
function renderQuickEquipment() {
  const container = document.getElementById("quick-equipment-list");
  if (!container) return;
  container.innerHTML = "";
  
  const equipped = state.inventory.filter(i => i.equipped);
  if (equipped.length === 0) {
    container.innerHTML = `<p style="font-size: 11px; color: var(--text-muted); text-align: center;">No equipment equipped.</p>`;
    return;
  }
  
  equipped.forEach(item => {
    const div = document.createElement("div");
    div.className = "quick-eq-item equipped";
    div.innerHTML = `
      <div>
        <span class="quick-eq-name">${item.name}</span>
        <span class="quick-eq-specs" style="display:block; font-size:10px; color:var(--text-secondary);">${item.specs}</span>
      </div>
      <span class="badge" style="font-size: 8px;">${item.type.toUpperCase()}</span>
    `;
    container.appendChild(div);
  });
}

// Render quick talents list
function renderQuickTalents(ancData) {
  const container = document.getElementById("quick-traits-list");
  if (!container) return;
  container.innerHTML = "";
  
  // 1. Ancestry Traits
  const ancDiv = document.createElement("div");
  ancDiv.style.marginBottom = "12px";
  ancDiv.innerHTML = `
    <strong style="color:var(--color-trim-bright); font-family:var(--font-header); display:block; margin-bottom:4px; font-size:11px;">${ancData.name} Ancestry:</strong>
    <p style="font-size:11px; line-height:1.4; color:var(--text-secondary);">${ancData.traits}</p>
  `;
  container.appendChild(ancDiv);
  
  // 2. Novice Path Features
  const path = rules.novice_paths[state.novicePath];
  if (path && state.novicePath !== "none") {
    const pathDiv = document.createElement("div");
    pathDiv.style.marginBottom = "12px";
    pathDiv.innerHTML = `
      <strong style="color:var(--color-trim-bright); font-family:var(--font-header); display:block; margin-bottom:4px; font-size:11px;">${path.name} Novice Path:</strong>
      <p style="font-size:11px; line-height:1.4; color:var(--text-secondary);">${path.features}</p>
    `;
    container.appendChild(pathDiv);
  }
}

// Render quick magic summary
function renderQuickMagicSummary() {
  const container = document.getElementById("quick-magic-summary");
  if (!container) return;
  container.innerHTML = "";
  
  const powerLevelData = rules.castings_matrix.power_levels[state.power];
  if (!powerLevelData) {
    container.innerHTML = `<p style="font-size: 11px; color: var(--text-muted); text-align: center;">No magical talent (Power 0).</p>`;
    return;
  }
  
  // Castings slots by Rank
  const castingsDiv = document.createElement("div");
  castingsDiv.style.display = "grid";
  castingsDiv.style.gridTemplateColumns = "repeat(auto-fit, minmax(80px, 1fr))";
  castingsDiv.style.gap = "6px";
  castingsDiv.style.marginBottom = "10px";
  
  powerLevelData.forEach((count, rank) => {
    const div = document.createElement("div");
    div.className = "quick-spell-slot";
    div.innerHTML = `
      <span style="font-weight:bold; font-size:10px; color:var(--color-trim-bright);">Rank ${rank}</span>
      <span style="font-size:10px; color:var(--text-secondary);">${count} Casts</span>
    `;
    castingsDiv.appendChild(div);
  });
  container.appendChild(castingsDiv);
  
  // List prepared spells
  if (state.preparedSpells.length === 0) {
    const p = document.createElement("p");
    p.style.fontSize = "11px";
    p.style.color = "var(--text-muted)";
    p.style.textAlign = "center";
    p.textContent = "No spells prepared in Grimoire.";
    container.appendChild(p);
    return;
  }
  
  const listDiv = document.createElement("div");
  listDiv.style.display = "flex";
  listDiv.style.flexDirection = "column";
  listDiv.style.gap = "4px";
  
  state.preparedSpells.forEach(spellName => {
    const spell = rules.spells_sample.find(s => s.name === spellName) || { name: spellName, tradition: "Custom", rank: 0 };
    const expended = state.expendedCastings[spellName] || 0;
    const maxCasts = powerLevelData[spell.rank] !== undefined ? powerLevelData[spell.rank] : 1;
    const remaining = Math.max(0, maxCasts - expended);
    
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.justifyContent = "space-between";
    div.style.alignItems = "center";
    div.style.background = "rgba(0,0,0,0.15)";
    div.style.padding = "4px 8px";
    div.style.fontSize = "11px";
    div.innerHTML = `
      <span><strong style="color:var(--text-primary);">${spell.name}</strong> <span style="font-size:9px; color:var(--text-muted);">(${spell.tradition})</span></span>
      <span style="font-size:10px; color:${remaining === 0 ? 'var(--color-crimson-bright)' : 'var(--color-trim-bright)'}; font-family:var(--font-mono);">${remaining} / ${maxCasts} left</span>
    `;
    listDiv.appendChild(div);
  });
  container.appendChild(listDiv);
}

// Adjust Health modifier
function adjustHealthMod(amount) {
  if (state.isDead) return;
  state.healthMod = (state.healthMod || 0) + amount;
  recalculateSheet();
}

// Adjust Level
function adjustLevel(amount) {
  if (state.isDead) return;
  state.level = Math.max(0, Math.min(10, state.level + amount));
  recalculateSheet();
}

// Adjust Size
function adjustSize(amount) {
  if (state.isDead) return;
  const anc = rules.ancestries[state.ancestry];
  if (!anc) return;
  const baseSize = parseSizeString(anc.size);
  
  let sizeNum = parseFloat(state.size) || baseSize;
  sizeNum = Math.max(0.125, sizeNum + amount);
  state.size = sizeNum.toString();
  recalculateSheet();
}

// Adjust Insanity
function adjustInsanity(amount) {
  if (state.isDead) return;
  state.insanity = Math.max(0, state.insanity + amount);
  recalculateSheet();
}

// Adjust Corruption
function adjustCorruption(amount) {
  if (state.isDead) return;
  state.corruption = Math.max(0, state.corruption + amount);
  recalculateSheet();
}

// Adjust Power
function adjustPower(amount) {
  if (state.isDead) return;
  state.power = Math.max(0, Math.min(10, state.power + amount));
  recalculateSheet();
}

// Adjust Defense modifier
function adjustDefense(amount) {
  if (state.isDead) return;
  state.defenseMod = (state.defenseMod || 0) + amount;
  recalculateSheet();
}

// Helper: parse fractions or numbers from size strings
function parseSizeString(str) {
  if (!str) return 1;
  if (str.includes('/')) {
    const parts = str.split('/');
    return parseFloat(parts[0]) / parseFloat(parts[1]);
  }
  return parseFloat(str) || 1;
}

// Toggle Edit Mode on Pentagram
function toggleEditMode() {
  const container = document.querySelector(".pentagram-container");
  if (container) {
    container.classList.toggle("edit-mode");
  }
}

// Perception Challenge Roll
function rollPerceptionCheck() {
  if (state.isDead) return;
  
  const ancData = rules.ancestries[state.ancestry];
  const baseIntellect = state.attributes.int;
  const intMod = baseIntellect - 10;
  const percMod = (ancData ? ancData.perception_mod : 0);
  const totalMod = intMod + percMod;
  
  let netBoons = state.boonBaneCount;
  
  // Roll d20
  const d20Roll = Math.floor(Math.random() * 20) + 1;
  let boonRolls = [];
  let highestBoonVal = 0;
  
  if (netBoons !== 0) {
    const count = Math.abs(netBoons);
    for (let i = 0; i < count; i++) {
      boonRolls.push(Math.floor(Math.random() * 6) + 1);
    }
    highestBoonVal = Math.max(...boonRolls);
  }
  
  const boonAdjustment = netBoons > 0 ? highestBoonVal : (netBoons < 0 ? -highestBoonVal : 0);
  const finalTotal = d20Roll + totalMod + boonAdjustment;
  
  const time = getTimestamp();
  const logContainer = document.getElementById("roll-log");
  const entry = document.createElement("div");
  entry.className = `log-entry ${netBoons > 0 ? 'log-green' : (netBoons < 0 ? 'log-bane' : '')}`;
  
  let mathStr = `1d20 (${d20Roll}) + Intellect Mod (${intMod >= 0 ? "+" : ""}${intMod}) + Perception Mod (+${percMod})`;
  if (netBoons > 0) mathStr += ` + Boon [${boonRolls.join(",")}] (highest: +${highestBoonVal})`;
  if (netBoons < 0) mathStr += ` - Bane [${boonRolls.join(",")}] (highest: -${highestBoonVal})`;
  
  entry.innerHTML = `
    <div class="log-header">
      <span>CHALLENGE: PERCEPTION</span>
      <span>${time}</span>
    </div>
    <div class="log-expr">${mathStr}</div>
    <div class="log-result">Total: <strong>${finalTotal}</strong> ${finalTotal >= 10 ? '<span class="text-green">[SUCCESS]</span>' : '<span class="text-red">[FAILURE]</span>'}</div>
  `;
  
  logContainer.insertBefore(entry, logContainer.firstChild);
  logContainer.scrollTop = 0;
}

