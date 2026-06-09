# Shadow of the Demon Lord: Ledger of the Damned

A gritty, dark gothic fantasy single-page character terminal and management sheet for the *Shadow of the Demon Lord* tabletop roleplaying game.

Designed as a browser-native local-first application, the terminal combines aged parchment aesthetics, bronze double-borders, and blood-red highlights with deep rules automation, custom dice mechanics, and import/export capabilities.

---

## ⛧ Live Access (GitHub Pages)

The terminal is set up to run directly in the browser without any server requirements. Once deployed on GitHub Pages, it can be accessed at:

```
https://matthewaroy.github.io/shadow-of-the-demon-lord-character/
```

### How to Enable GitHub Pages:
1. Go to your repository settings page on GitHub.
2. In the left sidebar under the **Code and automation** section, click **Pages**.
3. Under **Build and deployment**, set the **Source** to **Deploy from a branch**.
4. Set the branch to `main` (or `master`) and select `/ (root)` as the folder.
5. Click **Save**. Within a few minutes, the terminal will be live at your repository's custom pages URL.

---

## ⛧ Features & Architecture

* **Occult Pentagram Vitals Console**: An interactive 14-node pentagram star visualizing Strength, Intellect, Willpower, Health, Agility, Level, Size, Speed, Defense, Perception, Insanity, Power, Healing Rate, Corruption, and a central Damage tracker.
* **Challenge Roll Automation**: Click on any attribute node (STR, AGI, INT, WIL) or the Perception node to roll a `1d20` check with automated modifier math, boon/bane inclusions, and logging.
* **Level & Stat Modifiers**: Enable "Stat Adjusters" to make on-the-fly modifications to core parameters. Includes automated Priest path divine protection (+1 Defense if unarmored).
* **6-Step Onboarding Character Creator**: Full fullscreen wizard guide to strain selection, path alignments, initial attribute boosts, background generation, starting gear allocations, and initial grimoire spell choices.
* **Expanded Spells Catalog**: Features **238 spells (Ranks 0–3)** spanning 42 magic traditions across all reference books.
* **Expert & Master Paths Selection**: Integrates all 41 Expert Paths and 123 Master Paths with automated Health, Power, and Talent/Feature listings.
* **Armory Registry & Gear Encumbrance**: Equipping heavy gear automatically calculates Agility penalties and half-speed reductions if Strength requirements aren't met.
* **Local-First State Sync**: No cloud login required. Your hero is preserved automatically via `localStorage` and can be exported/imported as a custom `.json` save file.

---

## ⛧ Local Development

The terminal uses a lightweight local static server for local play testing.

### Commands:
```bash
# Install local dependencies
npm install

# Start the local development server (runs serve on port 3000)
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## ⛧ Reference Materials
This application incorporates metrics, traits, and casting formulas derived from:
* *Shadow of the Demon Lord Core Rulebook*
* *Occult Philosophy Magic Supplement*
* *Terrible Beauty Faerie Guide*

*Shadow of the Demon Lord is © Schwalb Entertainment. This is an unofficial character sheet tool.*
