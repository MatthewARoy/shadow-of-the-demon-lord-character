# Shadow of the Demon Lord Character Manager

A character manager for the *Shadow of the Demon Lord* tabletop RPG. It runs
entirely in the browser, keeps your characters on your own machine, and has a
real rules engine underneath rather than a set of blank fields you fill in by
hand.

## Live demo

**[matthewaroy.github.io/shadow-of-the-demon-lord-character](https://matthewaroy.github.io/shadow-of-the-demon-lord-character/)**

To enable GitHub Pages for your own fork: open the repository settings, go to
**Pages**, set the source to **Deploy from a branch**, choose branch `main` and
folder `/ (root)`, and save.

## Features

* Choice-driven builder: every "choose" in the rules becomes a card in a
  decision queue (attribute increases, tradition discoveries, spell picks,
  roguery talents, ancestry benefits, languages and professions).
* Per-level advancement for novice, expert, and master paths, including the
  optional second expert path and its either-path level 9 choice.
* Enforces the actual rules: religion-locked traditions, Power-capped spell
  rank, no dark magic for Magisters, Corruption on dark discoveries.
* 1,165 spells and 42 traditions parsed from the Core Rulebook, Occult
  Philosophy, Terrible Beauty, and Demon Lord's Companion 2, plus the four
  novice paths and 177 expert and master paths with their full per-level
  benefits.
* Derived stats with provenance: every point of Health, Power, and Defense
  knows where it came from.
* Castings tracker built on the real castings table.
* Spell browser with learnable-now filtering, sort by efficiency, and an
  advanced view for category and build-lens filters, combos, and per-spell
  scores.
* Future Studies wishlist that flags which starred spells are ready to learn as
  you level up.
* Summoned-creature stat blocks shown inline on conjuration and summoning
  spells, parsed from the bestiaries.
* Play tracking on a parchment sheet: damage and healing rate, rests that
  refresh castings, and Insanity and Corruption marked during play.
* Armory with encumbrance warnings, plus a boon/bane dice roller with a roll
  history.
* Level 0 backgrounds with two starting professions, dice randomization, and
  the option to trade a profession for a language.
* Local-first roster: multiple characters in localStorage with JSON export and
  import. No server, no build step, just vanilla ES modules.
* Supplement text sits behind a consent gate: names, ranks and numbers are
  always shown, but prose from *Occult Philosophy*, *Terrible Beauty* and
  *Demon Lord's Companion 2* is withheld until you confirm you own those
  books. Core Rulebook material is not gated, so the builder works fully on
  first open. Withdraw the confirmation any time from the ⋯ menu.

## Local development

```bash
npm install
npm run dev     # serves on http://localhost:3000
```

## Data pipeline

The ruleset under `data/` is generated from the rulebook PDFs, which live in the
repo root and are gitignored. The Python dependencies (PyMuPDF) come from
`requirements.txt`:

```bash
pip install -r requirements.txt
```

The stages run in dependency order, and `scripts/rebuild_data.sh` runs them all:

```bash
python3 scripts/extract_text.py      # PDFs -> normalized text (fixes broken ligatures)
python3 scripts/parse_spells.py      # -> data/spells.json
python3 scripts/tag_spells.py        # -> adds theorycrafting tags (+ data/spell-tags.json); applies data/spell-tag-overrides.json
python3 scripts/enrich_spells.py     # -> data/spell-enrichment.json (LLM build-lens labels via claude -p; resumable, shardable)
python3 scripts/score_spells.py      # -> data/spell-scores.json (per-spell damage/heal/mitigation efficiency as rank-cohort percentiles)
python3 scripts/detect_combos.py     # -> data/spell-combos.json (which spells stack, by fight-goal/lever, with effectiveness scoring); reads spell-scores.json, so run score_spells.py first
python3 scripts/parse_paths.py       # -> data/paths.json
python3 scripts/parse_traditions.py  # -> data/traditions.json
python3 scripts/parse_equipment.py   # -> data/equipment.json
python3 scripts/parse_creatures.py   # -> data/creatures.json
python3 scripts/parse_rules_index.py # -> data/rules-index.json
```

`scripts/tables.py` is a module rather than a stage: `parse_spells.py` and
`parse_paths.py` both call it to capture the random tables the books print
*inside* an entry (a spell's `tables`, a talent's `tables`). It captures only
tables whose rows are keyed by a die result or a rank, and refuses anything it
cannot validate rather than emit a half-built table — see its docstring for
what is deliberately left flattened.

`parse_paths.py` also gives a path a `catalog` where the book prints its
options as a sidebar list rather than as talents (the wardscribe's sigils, the
lorekeeper's esoteric discoveries), grouped, with the level each group unlocks.

After regenerating, verify the result:

```bash
npm test    # data counts and cross-file integrity, then sample-character regression
```

`data/curated.json` is hand-written from the rulebook text. It holds 15
ancestries with their creation rules and level 4 choices, the four novice paths
as full effect lists, the castings matrix, the advancement table, religions,
roguery talents, professions, and starting wealth.

The design of the effects/decisions engine is documented in the
[character manager design spec](docs/superpowers/specs/2026-06-11-v2-character-manager-design.md).

## Reference materials

* *Shadow of the Demon Lord Core Rulebook*
* *Occult Philosophy*
* *Terrible Beauty*
* *Demon Lord's Companion 2*

## Shared party storage (Cloudflare)

An optional second copy of the app, hosted on a free Cloudflare Workers
address (`<worker>.<subdomain>.workers.dev`), where an invited party's
characters are stored server-side in Cloudflare D1. Everyone in the party can
open everyone else's characters (view-only, with **Make my copy** to import
one), and your own characters follow you across devices. Visitors without an
invite get the app exactly as it is on GitHub Pages: local only. The GitHub
Pages copy is unchanged and never syncs. The design is in
[the shared party storage spec](docs/superpowers/specs/2026-10-29-shared-party-storage-design.md).

Everything goes through `scripts/cf/cf.mjs` (`npm run cf -- <command>`), which
fetches wrangler on demand with `npx wrangler@4`; nothing is installed into
the repo. Use a Cloudflare account set aside for this, not a work account.

### One-time setup

```bash
npm run cf -- login     # sign in; opens the browser
npm run cf -- setup     # choose the account, name the worker and database, create the database
npm run cf -- deploy    # stage, scan, migrate and deploy; prints the site address
```

- **login** keeps its own wrangler login in `~/.config/sotdl-cf`, separate from
  any other wrangler login on the machine, and ignores `CLOUDFLARE_*` / `CF_*` /
  `WRANGLER_*` variables in your shell. It refuses to run while a `~/.wrangler`
  directory exists, because wrangler would use that login instead. To sign in
  from a private window, run `npm run cf -- login --browser=false` and open the
  printed link there. It also refuses while the checkout has a `.env` or
  `.env.local`, which wrangler would read credentials from.
- **setup** asks you to pick the account (it lists them when the login can see
  more than one) and to name the worker and the database. The worker name
  becomes the first part of the public address, so choose something that does
  not identify you; a random name is suggested. The answers, the account id and
  the database id are saved to `~/.config/sotdl-cf/deploy.json`, outside the
  repo. Never commit them or paste them into issues, pull requests or commit
  messages. To start over, delete that file (the database stays in the account).
- **deploy** copies only what the browser loads (`index.html`, `css/`, `js/`
  without tests, the runtime `data/*.json`) into the gitignored `.cf-dist/public`,
  swaps in a `js/site.js` that turns sync on and names no GitHub repo, and adds
  a `_headers` file with a Content-Security-Policy. It then scans the staged
  files and the built Worker for identifying strings (the owner's public
  account names, the worker name, the site's host, the account and database
  ids, your home directory path, and any private strings you list in
  `~/.config/sotdl-cf/leak-patterns.json`, a JSON array that is never
  committed) and stops on any hit. It applies database migrations, deploys,
  and records the site address in `deploy.json`. The first deploy may ask you
  to register the account's workers.dev subdomain, which also becomes part of
  the public address: choose it with the same care. (Wrangler picks one
  without asking when it thinks a coding agent is running it; `cf.mjs` hides
  those signals from wrangler so it asks.) If the deployed address contains an
  identifying string anyway (your names, the repo or package name), deploy
  stops without recording it: change the subdomain in the Cloudflare
  dashboard and delete the worker before sharing anything. Run
  `npm run cf -- deploy` again after every change you want live.
  `node scripts/cf/stage.mjs` runs the staging and scan on their own.

### Members

```bash
npm run cf -- invite Sam     # prints <your-site>/#invite=<token>; for an existing Sam, a new link
npm run cf -- members        # names, active or revoked, ids
npm run cf -- revoke Sam     # or the id shown by `members`
```

Each invite link is printed once, in your terminal; the database keeps only a
hash of its token. Send it privately: whoever opens it joins as that member
and can change that member's characters. Opening the link asks the player to
confirm before anything is uploaded. A player can forget the link on one
device with **Leave party on this device** (their characters stay in that
browser). If a link leaks or is lost, run `invite` again with the same name:
after you confirm, it prints a new link for that same member (their
characters stay theirs) and the old link stops working. Opening the new link
on a device that is already in the party just swaps in the new link. Revoking stops the
link working; the member's characters stay visible to the party, and inviting
the same name again lets them back in with a new link. Two active members
cannot share a name.

### Local development

```bash
npm run cf -- dev                      # Worker + local database on port 8787
npm run cf -- invite Tester --local    # http://localhost:8787/#invite=...
npm run cf -- members --local
```

No login is needed. The local database lives in `.cf-dist/state` (gitignored).
The dev server listens on all network interfaces so a phone on the same
network can reach it, which also lets anyone on that network use the dev
party's API; wrangler's Local Explorer (a database console) is turned off. `http://localhost:8787` and `http://127.0.0.1:8787` keep
separate browser storage, so they behave like two devices.

### Known limits

- **The public repo is a trail back.** It contains the same code, and the
  GitHub Pages copy stays up, so anyone who searches GitHub for a distinctive
  string from the Cloudflare site can find the repo. Only making the repo
  private (or moving the code to an unlinked repo) closes that.
- **Wider sharing means wider exposure** of the core-rulebook text the app
  ships ungated.
- **Invite tokens live in the browser's `localStorage`**, where any script
  running on the site's origin could read them. The Content-Security-Policy
  narrows that to the app's own files.
- **Free tier quotas**: 100,000 API requests and 100,000 database row writes per
  day. A flood of junk `/api/*` requests could use up the day's quota and pause
  sync (not the app) until 00:00 UTC.
- **Unverified until first sign-in**: whether the free Workers plan asks for a
  card, and which workers.dev subdomain the first deploy registers.

*Shadow of the Demon Lord is © Schwalb Entertainment. This is an unofficial
character tool.*
