// Stage the static site for the Cloudflare Worker, and scan it for anything
// that would tie the anonymous address back to the owner.
//
//   node scripts/cf/stage.mjs [outDir]     (default: .cf-dist)
//
// Copies only what the browser loads into <outDir>/public, swaps in the
// anonymous js/site.js, writes _headers (CSP and friends), then scans every
// staged file. Exits non-zero on any hit. cf.mjs calls stageSite() before
// every dev run and deploy. See
// docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Staging, anonymity and deploy").

import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- what gets served ------------------------------------------------------

// Data files the app fetches at runtime: js/data.js loadRules() (curated,
// spells, paths, traditions, equipment, creatures, then the optional
// spell-tags/enrichment/combos/scores and revision), js/main.js (samples),
// js/ui/combat.js (combat), js/ui/lookup.js (rules-index). Build inputs such
// as spell-tag-overrides.json stay home. An allowlist, so a new data file is
// not published until someone adds it here (cf-stage.test.mjs checks every
// data/*.json the staged JS names is present).
export const DATA_FILES = [
  "curated", "spells", "paths", "traditions", "equipment", "creatures",
  "spell-tags", "spell-enrichment", "spell-combos", "spell-scores", "revision",
  "samples", "combat", "rules-index",
].map((name) => `${name}.json`);

export const ANON_SITE_JS = `// Per-deployment settings: the Cloudflare build, written by
// scripts/cf/stage.mjs. It names no issue repo (the spell relabel link is
// hidden) and turns party sync on.
export const SITE = { issueRepo: null, syncEnabled: true };
`;

// style-src needs 'unsafe-inline' because the UI templates render style=""
// attributes (spells, sheet, gear, combat, lookup, builder, dice); the
// element.style writes in sheet.js are CSSOM and not governed by CSP. Fonts
// come from Google Fonts (index.html). img-src data: covers the inline SVG
// backgrounds in app.css. Only /api/* reaches the Worker, which sets its own
// headers; these apply to the static files.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const HEADERS_FILE = `/*
  Content-Security-Policy: ${CSP}
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`;

// --- leak patterns ---------------------------------------------------------

// Matched case-insensitively, so one entry covers every capitalisation of the
// GitHub account. Each is split so this file never contains the strings it
// hunts for. This list is published with the repo, so it holds only forms
// that are already public; private ones (other account names, a work
// domain, …) go in the local file below and are merged into every scan.
export const DEFAULT_LEAK_PATTERNS = [
  "matthew" + "aroy",
  "github.com/" + "matthew",
  "shackle" + "ford",
];

// ~/.config/sotdl-cf/leak-patterns.json: a JSON array of strings, kept
// beside deploy.json and never committed. Its own file, so that `setup`
// rewriting deploy.json cannot drop it.
export function localLeakPatternsPath(home = homedir()) {
  return join(configDir(home), "leak-patterns.json");
}

// The private patterns, or [] when the file does not exist. A file that is
// there but malformed throws: silently scanning without it would pass.
export function readLocalLeakPatterns(home = homedir()) {
  return readPatternFile(localLeakPatternsPath(home));
}

// ~/.config/sotdl-cf/repo-patterns.json: strings that may be served, and may
// even be part of the public address (the hosting account's own handle), but
// must never be committed to the public repository, which would tie the two
// together. Same format as leak-patterns.json.
export function localRepoPatternsPath(home = homedir()) {
  return join(configDir(home), "repo-patterns.json");
}

export function readLocalRepoPatterns(home = homedir()) {
  return readPatternFile(localRepoPatternsPath(home));
}

function readPatternFile(path) {
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${path} must be a JSON array of strings.`);
  return list.filter((p) => typeof p === "string" && p.trim() !== "");
}

// Everything a scan of served files looks for: the committed defaults, the
// private local list, the deploy config's identifiers and the home
// directory path (which would name the local user if a bundler ever inlined
// an absolute path).
export function siteLeakPatterns(deploy, home = homedir()) {
  return [...DEFAULT_LEAK_PATTERNS, ...readLocalLeakPatterns(home), ...deployLeakPatterns(deploy), home];
}

// Identifiers from the local deploy config that must never be served: the
// worker name (first label of the public URL), the site's host, and the
// account and database ids.
export function deployLeakPatterns(deploy) {
  if (!deploy || typeof deploy !== "object") return [];
  const out = [deploy.workerName, deploy.accountId, deploy.databaseId];
  if (typeof deploy.siteUrl === "string" && deploy.siteUrl) {
    try {
      out.push(new URL(deploy.siteUrl).host);
    } catch {
      out.push(deploy.siteUrl);
    }
  }
  return out.filter((p) => typeof p === "string" && p.trim() !== "");
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Every occurrence of any pattern (case-insensitive substring) in any file
// under dir, as [{file, pattern, line}] with file relative to dir (forward
// slashes) and a 1-based line number.
export function scanForLeaks(dir, patterns) {
  const wanted = [...new Set(patterns.filter((p) => typeof p === "string" && p !== ""))];
  const lowered = wanted.map((p) => p.toLowerCase());
  const hits = [];
  for (const file of walk(dir).sort()) {
    const rel = relative(dir, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").toLowerCase().split("\n");
    lines.forEach((text, i) => {
      lowered.forEach((p, k) => {
        if (text.includes(p)) hits.push({ file: rel, pattern: wanted[k], line: i + 1 });
      });
    });
  }
  return hits;
}

// --- staging ---------------------------------------------------------------

// Copies the site into <outDir>/public (replacing any previous copy; the rest
// of outDir, such as the local D1 state, is left alone) and scans it.
// Returns {publicDir, patterns, leaks}; callers refuse to go on when leaks
// is non-empty.
export function stageSite({ root = REPO_ROOT, outDir, deploy = null, extraPatterns = [] }) {
  if (!outDir) throw new Error("stageSite: outDir is required");
  const src = resolve(root);
  const out = resolve(outDir);
  const publicDir = join(out, "public");

  // Never let the output land on or inside what is being copied.
  const inside = (p, parent) => p === parent || p.startsWith(parent + sep);
  if (inside(src, out)) throw new Error(`stageSite: ${out} contains the source tree`);
  for (const served of ["index.html", "css", "js", "data"]) {
    if (inside(publicDir, join(src, served))) {
      throw new Error(`stageSite: ${publicDir} is inside ${served}/`);
    }
  }

  rmSync(publicDir, { recursive: true, force: true });
  mkdirSync(join(publicDir, "data"), { recursive: true });

  copyFileSync(join(src, "index.html"), join(publicDir, "index.html"));
  const testsDir = join(src, "js", "ui", "tests");
  const keep = (p) => !basename(p).startsWith(".") && resolve(p) !== testsDir;
  cpSync(join(src, "css"), join(publicDir, "css"), { recursive: true, filter: keep });
  cpSync(join(src, "js"), join(publicDir, "js"), { recursive: true, filter: keep });
  for (const f of DATA_FILES) copyFileSync(join(src, "data", f), join(publicDir, "data", f));

  writeFileSync(join(publicDir, "js", "site.js"), ANON_SITE_JS);
  writeFileSync(join(publicDir, "_headers"), HEADERS_FILE);

  const patterns = [...DEFAULT_LEAK_PATTERNS, ...deployLeakPatterns(deploy), ...extraPatterns];
  return { publicDir, patterns, leaks: scanForLeaks(publicDir, patterns) };
}

// --- local deploy config ---------------------------------------------------
// Lives outside the repo so no id or name can be committed by accident.

export function configDir(home = homedir()) {
  return join(home, ".config", "sotdl-cf");
}

export function deployConfigPath(home = homedir()) {
  return join(configDir(home), "deploy.json");
}

export function readDeployConfig(home = homedir()) {
  const path = deployConfigPath(home);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function formatLeaks(leaks) {
  return leaks.map((l) => `  ${l.file}:${l.line} contains "${l.pattern}"`).join("\n");
}

// --- CLI -------------------------------------------------------------------

async function main(argv) {
  const outDir = resolve(argv[0] ?? join(REPO_ROOT, ".cf-dist"));
  const { publicDir, leaks } = stageSite({
    root: REPO_ROOT,
    outDir,
    deploy: readDeployConfig(),
    extraPatterns: [...readLocalLeakPatterns(), homedir()],
  });
  if (leaks.length) {
    console.error(`Staged ${publicDir}, but it contains identifying strings:\n${formatLeaks(leaks)}`);
    process.exit(1);
  }
  console.log(`Staged ${publicDir} (no leaks found).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
