# UI review fixes — 2026-07-02

Implements the 11 open findings from `docs/reviews/2026-07-02-ui-review.html`
(finding 12, Lookup stopword highlighting, is already fixed). Six tasks,
grouped by file locality, executed sequentially.

## Context

Ledger of the Damned is a fully static SotDL character manager: plain ES
modules, no build step, served from GitHub Pages. `js/main.js` mounts seven
tab panes (all panes stay in the DOM; switching toggles visibility), each
rendered by a module in `js/ui/` that sets `el.innerHTML` from template
strings and attaches delegated listeners once behind an `el.dataset.wired`
guard. `js/engine.js` is a pure replay engine — `compute(char)` returns all
derived stats including `provenance` maps. State lives in `js/state.js`
(localStorage roster; `save()` notifies subscribers).

## Global Constraints

- Plain ES modules, no build step, no new dependencies, no framework.
- Rendering style: template strings + `esc()` from `js/ui/util.js` for ALL
  interpolated data-derived values (names, notes, item ids). Never interpolate
  unescaped user/character data into HTML — this repo had an XSS fixed for
  exactly that.
- Event listeners: delegated, attached once behind `el.dataset.wired` guards,
  reading `active()` fresh per event. Match this pattern; do not add
  per-render listeners (they leak across re-renders).
- Visual language: reuse the CSS custom properties and class conventions
  already in `css/app.css`. Dark chrome (panels, brass small-caps labels,
  oxblood accents) everywhere except the Sheet tab's parchment `.paper` area.
  Copy tone: gothic, small-caps labels (e.g. "Unresolved Fates", "The
  Archive") — new labels must match this voice.
- All seven tab panes stay mounted and hidden in the DOM. Selectors and
  focus management must account for hidden panes (e.g. never query
  `main input` globally).
- `npm test` (data validation + `scripts/build_samples.mjs`) must pass
  after every task. Do not regenerate or edit anything in `data/`.
- Mobile means 375px viewport; the app must remain usable at that width.
- Respect `prefers-reduced-motion` for any transition you add.
- Commit messages: plain, human-authored style; NO Claude/Anthropic
  attribution, no Co-Authored-By trailers, no emoji footers.

## Task 1: Mobile header collapse and tab-strip overflow affordance

**Findings 1 + 2 (impact: high). Files: `index.html`, `css/app.css`, `js/main.js`.**

Current behavior at 375px: the masthead (`header.masthead` — title + tagline)
plus the roster controls (`#roster-select`, `+ New`, `#sample-select`,
Export, Import, and a delete `✕` button) stack to ~500px of chrome before any
content; the delete button wraps onto its own row. The tab bar (`nav.tabs`,
seven `button.tab`) overflows and clips at the viewport edge with no visual
hint that Dice and Lookup exist.

Requirements:

1. At small widths (use a media query around 720px; pick the exact breakpoint
   by testing where the current layout breaks), the header must compress to
   roughly two rows (~130–170px total):
   - Row 1: compact title + the roster `<select>` (flexible width) + a `⋯`
     overflow menu button.
   - The `⋯` menu contains: New soul, the sample picker, Export, Import, and
     Delete (destructive, styled with the existing oxblood danger treatment,
     placed last). Implement as a small popover panel (positioned under the
     button) using existing panel styling; close on outside click and Escape.
     The menu button needs `aria-expanded` and `aria-haspopup="menu"`; items
     are buttons. The sample picker inside the menu may remain a `<select>`.
   - The full-size desktop header must remain exactly as it is today at
     desktop widths.
2. The tab strip must scroll horizontally when it overflows:
   `overflow-x: auto` with hidden scrollbars (`scrollbar-width: none` +
   `::-webkit-scrollbar { display: none }`), `scroll-snap-type: x proximity`
   on the strip and snap-start on tabs, plus a right-edge fade overlay
   (gradient to the page background) that signals more content. The fade must
   not intercept taps (`pointer-events: none`). Keep the active-tab underline
   visible when scrolled to it: after a tab click, `scrollIntoView({ inline:
   "nearest" })` the active tab.
3. The delete flow must keep its existing confirm behavior (check how the ✕
   button currently confirms; preserve it inside the menu).

Verification: `npm test`; then manually reason through (or run a quick DOM
check with `npx serve` + fetch) that index.html structure is coherent. State
in your report the breakpoint you chose and why.

## Task 2: Keyboard and screen-reader reach

**Finding 3 (impact: high). Files: `js/ui/toast.js`, `js/ui/sheet.js`, `index.html`, `js/main.js`, `js/ui/spells.js`, `js/ui/paths.js`, `js/ui/lookup.js`.**

Five independent gaps; implement all:

1. **Toasts announce.** The roll-toast container (`aside.roll-toast` in
   `index.html`, managed by `js/ui/toast.js`) gets `aria-live="polite"` and
   `role="status"` so screen readers hear roll results and confirmations.
2. **Pentagram rollables are buttons.** In `js/ui/sheet.js`, `node()` renders
   `.pent-node` as a `<div>`; nodes carrying `data-roll-attr` /
   `data-roll-perception` (class `rollable`) must render as
   `<button type="button">` instead, keeping identical classes/attributes so
   the existing delegated click handler and CSS keep working. Add a CSS reset
   in `app.css` so these buttons keep the current look (no native button
   chrome; inherit font; the app's existing `:focus-visible` outline must be
   visible on them). Non-rollable nodes stay `<div>`s.
3. **Tab bar semantics.** `nav.tabs` gets `role="tablist"`; each `button.tab`
   gets `role="tab"` and `aria-selected` kept in sync where main.js toggles
   the active class. Add ArrowLeft/ArrowRight key handling on the tablist to
   move focus and activate the previous/next tab (wrap around at the ends).
   Panes get `role="tabpanel"` only if trivial — do not restructure main.js
   mounting.
4. **Clamp toggles are keyboard-reachable.** Long text blocks toggle a
   `lk-clamp`/clamp class by clicking a `<p>` (`js/ui/lookup.js` results;
   check `js/ui/spells.js` and `js/ui/paths.js` for the same pattern on spell
   and path descriptions). Give each clamped block `tabindex="0"`,
   `role="button"`, `aria-expanded` reflecting state, and make the existing
   delegated click handlers also fire on Enter/Space keydown (preventDefault
   on Space). If a pane's clamp toggle is already a real button, leave it.
5. **Spell modal focus.** The spell detail modal in `js/ui/spells.js` already
   has `role="dialog"`, `aria-modal`, and Esc-to-close. On open: remember
   `document.activeElement`, move focus to the dialog (make the dialog
   container focusable with `tabindex="-1"`). While open: trap Tab/Shift+Tab
   within the dialog's focusable elements. On close (all paths — Esc, ✕,
   backdrop): restore focus to the remembered element.

Verification: `npm test`. In your report, list each of the five items with
the file/line where you implemented it.

## Task 3: Sheet play-tracking steppers, provenance on the nodes, growing description

**Findings 4 + 5 + 10 (impact: medium/low). Files: `js/ui/sheet.js`, `css/app.css`.**

1. **Steppers (finding 4).** Today damage/insanity/corruption adjust via six
   small text chips (`− DAMAGE`, `+ DAMAGE`, `− INSANITY`, `+ INSANITY`,
   `− CORRUPTION`, `+ CORRUPTION`) in two rows under the pentagram, with
   `HEAL 2` and `REST` chips. Replace with three grouped steppers on the
   parchment, one per tracked value:
   - Card layout: small-caps name on top (oxblood), then `−` / value / `+`
     in a row (round bordered buttons ≥34px, value ≥24px
     `font-variant-numeric: tabular-nums`), then a one-line subnote
     (Damage: "of N health"; Insanity: "of N will"; Corruption: "marks of
     darkness").
   - Buttons are real `<button>`s with `aria-label`s ("Add damage" etc.).
     Wire them to the existing damage/insanityAdjust/corruptionAdjust
     mutation handlers (same clamping rules as the current chips — find and
     preserve them, e.g. damage ≥ 0).
   - Keep `HEAL 2`/`REST` as adjacent chips below the steppers (existing
     behavior unchanged; the heal amount label must keep using the computed
     healing rate).
   - The incapacitated "DOWN" treatment on the damage circle must be
     unaffected.
2. **Provenance tooltips (finding 5).** `compute()` returns
   `computed.provenance` (per-stat arrays of `{source, level, amount}`-style
   entries — read `js/engine.js` to get the exact shapes; defense entries
   from equipped gear were added recently by `applyEquippedGear`). On the
   pentagram nodes for Defense, Health, Power, and Speed (where provenance
   exists), show a breakdown on hover AND on focus (desktop) as a styled
   tooltip: dark panel (`--panel`-style background works on parchment), rows
   of "source … amount" with a totals row. Implementation: a single
   absolutely-positioned tooltip element inside the sheet pane, populated
   from a `data-prov` lookup on mouseenter/focusin and hidden on
   mouseleave/focusout/Escape; tooltip itself `role="tooltip"` +
   `aria-describedby` wiring on the node. Touch: a tap on a node with
   provenance toggles the tooltip (but must not break the roll behavior on
   rollable nodes — only non-rollable stat nodes get tap-to-toggle; rollable
   nodes get hover/focus only). The existing "Provenance" panel below the
   sheet stays (it serves print).
3. **Growing description (finding 10).** The Sheet's notes `<textarea>`
   (`#sheet-notes`) is fixed at 4 rows with a default OS scrollbar. Make it
   auto-grow to fit content up to a max (~12 lines), then scroll with a
   thin parchment-toned scrollbar (`scrollbar-width: thin` +
   `scrollbar-color`, plus webkit equivalents). Use `field-sizing: content`
   guarded by `@supports`, with a JS scrollHeight-resize fallback wired into
   the existing input handler for the textarea. Growing must not jump the
   page scroll position.

Verification: `npm test`. Confirm in your report that the stepper mutation
paths save + re-render exactly like the old chips did (same functions), and
name the clamp rules you preserved.

## Task 4: Spells — exchange ledger and archive filter summary

**Findings 6 + 7 (impact: medium). Files: `js/ui/spells.js`, `css/app.css`.**

1. **Exchange ledger (finding 6).** Today each exchange renders as a chip
   `⇄ A → B ✕` in a wrapping row under the Grimoire, one chip per exchange
   (8 chips for the Syrah sample), each ✕ an immediate undo. Replace with a
   `<details>` disclosure:
   - Collapsed summary line: `⇄ Exchanged N times` (small-caps, dim brass),
     collapsed by default; persist open/closed per session is NOT required.
   - Expanded: one line per exchange in order: `A → B` with an `undo` button
     on the line (keep wiring to the existing exchange-undo handler and its
     confirm/undo semantics unchanged).
   - Chain folding: consecutive exchanges that form a lineage (the `gain` of
     one is the `drop` of a later one) may render as a single line
     `A → B → C → D` with one `undo last` button that undoes the most recent
     link. Fold only exact name+tradition matches. If implementing chain
     folding risks changing undo semantics, do the simple one-line-per-
     exchange version and say so in your report — correctness of undo beats
     the fancy rendering.
   - When there are no exchanges, render nothing (as today).
2. **Filter summary (finding 7).** The Archive's filter bar (search input +
   tradition/rank/type/book/sort selects + learnable/studies/advanced
   toggles) gets a summary line rendered directly beneath it, visible
   whenever at least one filter deviates from its default OR a search query
   is set:
   - `N of 1,120 spells` (count = currently rendered result count; the total
     comes from the loaded data length, not hardcoded),
   - one removable chip per active filter (`rank ≤ 1 ✕`, `Air ✕`,
     `learnable now ✕`, `"fire" ✕` for search). Clicking a chip resets that
     one filter to default and re-renders.
   - a `clear all` link that resets every filter and the search box.
   - When nothing is filtered, the line disappears entirely.
   - Reuse the module's existing `filters` state object; do not restructure
     filtering logic.

Verification: `npm test`. Report the exact default values of each filter you
treat as "inactive".

## Task 5: Gear — named equip toggle with consequences, armory navigation, encumbrance meter

**Finding 8 (impact: medium). Files: `js/ui/gear.js`, `css/app.css`.**

1. **Equipped column.** The possessions table's first column is a bare
   checkbox with no header. Give the column a header ("Equipped", small-caps
   like the other headers) and replace the bare checkbox with a labeled
   toggle: keep an `<input type="checkbox">` for semantics/wiring (existing
   delegated handler), styled as the app's aesthetic allows — a plain
   checkbox with a label is acceptable; a styled switch is optional polish.
2. **Effect line.** For armor items, show what equipping does, derived from
   the item's parsed `defense` value: fixed values → `Defense 13 — replaces
   Agility`; `Agility+N` values → `Defense = Agility + N`. For weapons with a
   `Defensive +N` property → `Defense +N`. Unequipped items show `stowed`
   (dim). Items with an unmet Strength requirement show the existing warning
   treatment — keep it, and if the engine now applies a Speed penalty for
   unmet requirements (check `applyEquippedGear` in `js/engine.js`), reflect
   that in the effect line (e.g. `Speed −2 — Strength 13 required`).
   Read the actual parsing/penalty logic from the engine rather than
   reimplementing it; if the engine exports a helper, use it, otherwise
   derive the display from the same item fields the engine reads.
3. **Armory navigation.** The armory's Weapons/Armor/Gear category buttons
   must stick to the top of the armory panel while its list scrolls: give
   the armory list a max-height (viewport-relative, e.g. `70vh`) with
   `overflow-y: auto` and make the category tab row `position: sticky; top: 0`
   with an opaque background so rows don't bleed through. Desktop only if
   mobile makes it awkward — state what you chose.
4. **Encumbrance meter.** The "N items · limit M (Strength)" line gets a
   small meter under it: a thin bar filled N/M (existing brass gradient
   language), `role="meter"` with `aria-valuenow/max`, turning oxblood when
   over the limit. Overflow (N > M) must render full + oxblood, not break.

Verification: `npm test`. In your report, paste the effect-line strings you
render for: Brigandine (defense "13", req Str 11), Soft Leather
("Agility+1"), Large shield ("Defensive +2"), and any item whose requirement
the character fails.

## Task 6: Dice tab merge and sample-import courtesy

**Findings 9 + 11 (impact: low). Files: `js/ui/dice.js`, `js/main.js`, `css/app.css`.**

1. **Dice layout (finding 9).** Merge the two floating panels ("The Casting
   of Lots" roller and "The Ledger of Lots" history) into one panel with a
   two-column interior on desktop (roller left, ledger right) that stacks on
   mobile. The most recent roll renders emphasized at the top of the ledger
   (larger value + its boon/bane breakdown, which the roll entries already
   carry). Keep the existing empty-state line ("The dice are silent.").
   Add Enter-to-roll on the damage-expression input if not already wired.
2. **Sample-import toast (finding 11).** Loading a sample from the header's
   sample `<select>` (handler in `js/main.js`) currently appends a roster
   entry silently every time. After a sample import: show a toast via the
   existing `js/ui/toast.js` API — `"<Name> joined the roster"` — with an
   Undo affordance that removes that just-added character and restores the
   previously active one (check what the toast API supports; if it has no
   action-button support, add a minimal optional-action parameter to it
   without changing existing call sites). Also: if the roster already
   contains a character with the same name, the import gets ` (2)`, ` (3)`,
   … appended to keep the roster select legible. Number by counting
   name-collisions, and apply the same numbering in the regular file-import
   path if it shares the code path naturally — do not fork the logic.
   The select must reset to its placeholder after a pick (verify it already
   does; keep it).

Verification: `npm test`. Report how Undo restores state (which character
becomes active) and what happens if the user switches characters before
pressing Undo (Undo must then still remove the right character — or
disappear; state your choice).
