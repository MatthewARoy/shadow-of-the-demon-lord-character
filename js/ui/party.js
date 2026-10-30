// Party sync wiring: the js/sync/engine.js instance, the invite link, the
// status chip, the overflow menu's party items, and the view-only cues for
// another member's character. Nothing here runs unless SITE.syncEnabled (the
// Cloudflare build); the GitHub Pages build behaves exactly as it did.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Client state and UI").

import { SITE } from "../site.js";
import { createSync } from "../sync/engine.js";
import {
  onChange, setParty, stopViewing, isViewing, viewingEntry, applyRemote, isUsable, makeOwnCopy,
  ownCharacters, onReload, refreshFromStorage, ROSTER_KEY,
} from "../state.js";
import { showToast } from "./toast.js";

// Panels whose controls edit the character. Dice and Lookup only read it.
const LOCKED_CONTROLS = ["build", "sheet", "spells", "paths", "gear", "combat"]
  .flatMap((tab) => ["input", "select", "textarea"].map((tag) => `#tab-${tab} ${tag}`))
  .join(", ");

// Search and filter bars only change what is listed, never the character, so
// they stay usable while reading someone else's sheet.
const VIEW_SAFE_CONTROLS = [
  "sp-q", "sp-tradition", "sp-rank", "sp-type", "sp-source", "sp-sort",
  "pa-q", "pa-type", "pa-tradition", "pa-source", "pa-sort",
  "cb-q",
].map((id) => `#${id}`).join(", ");

// Coming back to the tab re-syncs, but not more often than this.
const FOCUS_SYNC_MS = 30_000;

const CHIP_LABELS = {
  synced: "Synced",
  syncing: "Syncing…",
  offline: "Offline · saved here",
  error: "Sync problem",
};

const STORED_ONLINE = "Your characters on this device will be stored online, and everyone in the party will be able to see them.";

// Controls disabled here because a party character is on screen. Ones the app
// disabled itself never enter the set, so stopping never re-enables them.
const lockedByUs = new Set();

function lockControls() {
  if (!isViewing()) {
    for (const el of lockedByUs) el.disabled = false;
    lockedByUs.clear();
    return;
  }
  for (const el of lockedByUs) {
    if (!el.isConnected) lockedByUs.delete(el);    // replaced by a re-render
  }
  for (const el of document.querySelectorAll(LOCKED_CONTROLS)) {
    if (el.disabled || el.matches(VIEW_SAFE_CONTROLS)) continue;
    el.disabled = true;
    lockedByUs.add(el);
  }
}

// Banner, delete buttons and locked controls follow store.viewingId. Called
// from main.js renderRoster(), which runs after every roster change.
export function renderViewState() {
  if (!SITE.syncEnabled) return;
  const entry = viewingEntry();
  const banner = document.getElementById("view-banner");
  if (banner) {
    banner.hidden = !entry;
    if (entry) {
      document.getElementById("view-name").textContent = entry.character.name || "Unnamed Soul";
      document.getElementById("view-owner").textContent = entry.ownerName || "Another player";
    }
  }
  document.body.classList.toggle("viewing", Boolean(entry));
  for (const id of ["delete-btn", "ov-delete-btn"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = Boolean(entry);
  }
  lockControls();
}

// The token leaves the address bar before anything awaits, so it is never
// left in history, a bookmark or a screenshot of the URL — whatever happens
// to the invite next.
function takeInvite() {
  const m = location.hash.match(/^#invite=(.+)$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return m[1];
}

// main.js calls this first thing in boot(), before the rules load, so the
// token is off the address bar even if boot fails or this build has no sync.
let captured = null;
export function captureInvite() {
  captured = takeInvite() ?? captured;
}

// Conflict prompts. OK is "mine"; Cancel, or a dismissed dialog, is "theirs",
// which never destroys anything.
const CONFLICT_TEXT = {
  edit: (name) => `“${name}” was changed on another device since this one last synced.\n\n`
    + "OK keeps THIS device's version (overwriting the other).\nCancel loads the other device's version here.",
  delete: (name) => `“${name}” was deleted on this device, but changed on another device since.\n\n`
    + "OK deletes it everywhere, discarding those changes.\nCancel keeps the other device's version here.",
};

// Called from main.js boot() after the first render. Returns the engine, or
// null when sync is off.
export function setupParty({ renderRoster, renderCurrent: render, closeMenu = () => {} }) {
  const invite = captured ?? takeInvite();
  captured = null;
  if (!SITE.syncEnabled) {
    if (invite !== null) {
      showToast({ total: "✕", label: "Invite link not accepted", detail: "This copy of the app has no party sync. Open the link on the party's own site." });
    }
    return null;
  }

  // One character the app cannot draw must not stop the rest of the wiring
  // (or a sync) from running.
  const renderCurrent = () => {
    try {
      render();
    } catch (err) {
      console.error("Could not render the current character", err);
    }
  };

  const chip = document.getElementById("sync-chip");
  const refreshBtn = document.getElementById("ov-refresh-btn");
  const leaveBtn = document.getElementById("ov-leave-btn");
  let status = { state: "syncing", message: "Syncing with the party…" };
  let lastSync = 0;

  // Another tab's save: reload the roster here (ownCharacters() also checks,
  // so the engine never plans against this tab's stale copy).
  onReload(() => {
    renderRoster();
    renderCurrent();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === ROSTER_KEY) refreshFromStorage();
  });

  const engine = createSync({
    fetch: (...a) => fetch(...a),
    storage: localStorage,
    getLocal: ownCharacters,
    applyLocal: (x) => {
      applyRemote(x);
      renderRoster();
      renderCurrent();
    },
    onParty: (entries) => {
      const wasViewing = isViewing();
      setParty(entries);
      renderRoster();
      if (wasViewing || isViewing()) renderCurrent();
    },
    resolveConflict: ({ name, kind }) => Promise.resolve(confirm(
      (CONFLICT_TEXT[kind] ?? CONFLICT_TEXT.edit)(name || "Unnamed Soul"),
    ) ? "mine" : "theirs"),
    onStatus: (s) => {
      status = s;
      renderChrome();
    },
    isUsable,
  });

  const syncNow = () => {
    lastSync = Date.now();
    return engine.sync();
  };

  function renderChrome() {
    const joined = engine.isJoined();
    document.body.classList.toggle("party-joined", joined);
    if (refreshBtn) refreshBtn.hidden = !joined;
    if (leaveBtn) leaveBtn.hidden = !joined;
    if (!chip) return;
    chip.hidden = !joined;
    const label = CHIP_LABELS[status.state] ?? CHIP_LABELS.synced;
    chip.dataset.state = status.state;
    chip.querySelector(".sync-label").textContent = label;
    chip.title = status.message;
    chip.setAttribute("aria-label", `Party sync: ${label}. ${status.message}`);
  }

  async function acceptInvite(token) {
    const joined = engine.isJoined();
    const current = joined ? engine.member() : null;
    let member;
    try {
      member = await engine.probe(token);
    } catch (err) {
      showToast({ total: "✕", label: "Invite link not accepted", detail: err?.message || "The invite could not be checked." });
      if (joined) syncNow();
      return;
    }
    if (joined && current?.id === member.id) {
      // Same member: possibly a re-issued link (`cf invite` for an existing
      // name), whose new token replaces a revoked one. join() keeps what this
      // device has synced.
      lastSync = Date.now();
      try {
        await engine.join(token, member);
      } catch (err) {
        showToast({ total: "✕", label: "Could not update the invite", detail: err?.message || "Something went wrong." });
        renderChrome();
      }
      return;
    }
    const question = joined
      ? `This device is in the party as ${current?.name || "another member"}. Switch it to ${member.name}?\n\n${STORED_ONLINE}`
      : `Join the party as ${member.name}?\n\n${STORED_ONLINE}`;
    if (!confirm(question)) {
      if (joined) syncNow();
      return;
    }
    if (joined) {
      engine.leave();
      setParty([]);
      renderRoster();
      renderCurrent();
    }
    lastSync = Date.now();
    try {
      await engine.join(token, member);
    } catch (err) {
      showToast({ total: "✕", label: "Could not join the party", detail: err?.message || "Something went wrong." });
      renderChrome();
      return;
    }
    showToast({ total: "☁", label: `Joined as ${member.name}`, detail: "Party characters appear at the end of the roster list." });
  }

  // --- wiring --------------------------------------------------------------

  chip?.addEventListener("click", () => syncNow());

  const wrap = (fn) => () => { fn(); closeMenu(); };
  refreshBtn?.addEventListener("click", wrap(() => syncNow()));
  leaveBtn?.addEventListener("click", wrap(() => {
    if (!confirm("Leave the party on this device?\n\nYour characters stay here but stop syncing, and the party's characters disappear from this device.")) return;
    engine.leave();
    setParty([]);
    stopViewing();
    renderRoster();
    renderCurrent();
    showToast({ total: "✓", label: "Left the party", detail: "This device keeps its own characters." });
  }));

  document.getElementById("view-copy-btn")?.addEventListener("click", () => {
    let copy;
    try {
      copy = makeOwnCopy();
    } catch (err) {
      showToast({ total: "✕", label: "Copy failed", detail: err.message });
      return;
    }
    if (!copy) return;
    renderRoster();
    renderCurrent();
    showToast({ total: "✦", label: `${copy.name} joined your roster`, detail: "This copy is yours to change; the original stays with its owner." });
  });

  // Re-renders replace a panel's controls wholesale, so lock them as they
  // arrive. Only while viewing: otherwise this does nothing.
  const app = document.getElementById("app");
  if (app) {
    new MutationObserver(() => {
      if (isViewing()) lockControls();
    }).observe(app, { childList: true, subtree: true });
  }

  onChange(() => engine.schedule());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (engine.isJoined() && Date.now() - lastSync >= FOCUS_SYNC_MS) syncNow();
    } else {
      engine.flush({ keepalive: true });
    }
  });
  window.addEventListener("pagehide", () => engine.flush({ keepalive: true }));
  // An invite opened in a tab already showing the app only changes the
  // fragment, which reloads nothing.
  window.addEventListener("hashchange", () => {
    const token = takeInvite();
    if (token !== null) acceptInvite(token);
  });

  // The party as of the last sync, so an offline boot still shows it (and a
  // viewingId restored by load() finds its entry, or is dropped).
  setParty(engine.cachedParty());
  renderRoster();
  if (isViewing()) renderCurrent();
  renderChrome();

  if (invite !== null) acceptInvite(invite);
  else if (engine.isJoined()) syncNow();
  return engine;
}
