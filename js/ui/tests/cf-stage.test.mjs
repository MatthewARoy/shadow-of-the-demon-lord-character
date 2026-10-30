// Cloudflare staging, anonymity scan and deploy helpers (scripts/cf/).
// Stages the real repo into a temp dir; no network, no wrangler.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  DATA_FILES, DEFAULT_LEAK_PATTERNS, deployLeakPatterns, localLeakPatternsPath,
  readLocalLeakPatterns, readLocalRepoPatterns, readDeployConfig, scanForLeaks, siteLeakPatterns, stageSite,
} from "../../../scripts/cf/stage.mjs";
import {
  findMemberSql, hashToken, insertMemberSql, listMembersSql, mintToken, reissueMemberSql,
  revokeMemberSql, sqlInt, sqlString, validateMemberName,
} from "../../../scripts/cf/sql.mjs";
import {
  AGENT_ENV, buildWranglerConfig, deployHostProblem, hostLeakPatterns, isolationProblem,
  parseAccounts, parseD1Rows, parseDatabaseId, parseDeployUrl, parseJsonOutput, suggestName,
  validateDatabaseName, validateWorkerName, wranglerEnv,
} from "../../../scripts/cf/cf.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "cf-stage-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// A made-up deploy config: nothing here is a real identifier.
const FAKE_DEPLOY = {
  workerName: "quillon-vexbard",
  siteUrl: "https://quillon-vexbard.example-sub.workers.dev",
  accountId: "0123456789abcdef0123456789abcdef",
  databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  databaseName: "test-db",
};

const staged = stageSite({ root: ROOT, outDir: join(TMP, "dist") });
const PUBLIC = staged.publicDir;

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return listFiles(full, base);
    return [full.slice(base.length + 1).split(/[\\/]/).join("/")];
  });
}

// --- staging ---------------------------------------------------------------

test("staged public/ contains none of the default leak patterns", () => {
  assert.deepEqual(staged.leaks, []);
  assert.deepEqual(scanForLeaks(PUBLIC, DEFAULT_LEAK_PATTERNS), []);
});

test("a deploy config's worker name, host and ids are scanned for, and absent", () => {
  const { patterns, leaks } = stageSite({ root: ROOT, outDir: join(TMP, "dist-deploy"), deploy: FAKE_DEPLOY });
  for (const p of [FAKE_DEPLOY.workerName, "quillon-vexbard.example-sub.workers.dev",
    FAKE_DEPLOY.accountId, FAKE_DEPLOY.databaseId]) {
    assert.ok(patterns.includes(p), `pattern ${p} scanned`);
  }
  assert.deepEqual(leaks, []);
});

test("staged js/site.js is the anonymous, sync-on variant", async () => {
  const { SITE } = await import(pathToFileURL(join(PUBLIC, "js", "site.js")).href);
  assert.equal(SITE.issueRepo, null);
  assert.equal(SITE.syncEnabled, true);
});

test("the committed js/site.js keeps sync off and names an issue repo", async () => {
  const { SITE } = await import(pathToFileURL(join(ROOT, "js", "site.js")).href);
  assert.equal(SITE.syncEnabled, false);
  assert.equal(typeof SITE.issueRepo, "string");
  assert.ok(SITE.issueRepo.length > 0);
});

test("only served files are staged: no tests, tooling, docs, worker or PDFs", () => {
  const files = listFiles(PUBLIC);
  const banned = [
    (f) => f.startsWith("js/ui/tests/"),
    (f) => /^(scripts|docs|worker|node_modules)\//.test(f),
    (f) => /\.pdf$/i.test(f),
    (f) => /(^|\/)(readme|claude)\.md$/i.test(f),
    (f) => /(^|\/)package(-lock)?\.json$/.test(f),
    (f) => /\.(py|mjs|sh|sql)$/.test(f),
    (f) => posix.basename(f).startsWith("."),
  ];
  for (const f of files) assert.ok(!banned.some((b) => b(f)), `unexpected staged file ${f}`);
  const top = new Set(files.map((f) => f.split("/")[0]));
  assert.deepEqual([...top].sort(), ["_headers", "css", "data", "index.html", "js"]);
});

test("the app's entry points and every runtime data file are staged", () => {
  for (const f of ["index.html", "css/app.css", "js/main.js", "js/data.js", "js/engine.js"]) {
    assert.ok(existsSync(join(PUBLIC, f)), `${f} staged`);
  }
  for (const f of DATA_FILES) assert.ok(existsSync(join(PUBLIC, "data", f)), `data/${f} staged`);
  assert.ok(!existsSync(join(PUBLIC, "data", "spell-tag-overrides.json")), "build input not staged");
});

test("every data/*.json the staged JS names is staged (allowlist drift guard)", () => {
  const named = new Set();
  for (const f of listFiles(join(PUBLIC, "js")).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(PUBLIC, "js", f), "utf8");
    for (const m of text.matchAll(/data\/([a-z0-9-]+)\.json/g)) named.add(`${m[1]}.json`);
  }
  // loadRules() fetches its core files through a template literal, so read
  // the name array next to it as well.
  const dataJs = readFileSync(join(PUBLIC, "js", "data.js"), "utf8");
  const core = /\[([^\]]+)\]\.map\(\(f\) =>\s*fetch\(`data\/\$\{f\}\.json`/.exec(dataJs);
  assert.ok(core, "found loadRules()'s file list");
  for (const m of core[1].matchAll(/"([a-z0-9-]+)"/g)) named.add(`${m[1]}.json`);
  assert.ok(named.size >= 10, "found the app's data references");
  for (const f of named) assert.ok(DATA_FILES.includes(f), `data/${f} is fetched but not staged`);
});

test("every local file index.html references is staged", () => {
  const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
  const local = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(local.includes("js/main.js") && local.includes("css/app.css"));
  for (const ref of local) assert.ok(existsSync(join(PUBLIC, ref)), `${ref} staged`);
});

test("_headers sets a CSP for every path, plus referrer and nosniff", () => {
  const headers = readFileSync(join(PUBLIC, "_headers"), "utf8");
  assert.match(headers, /^\/\*\n/);
  const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self'",
    "img-src 'self' data:", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
    "font-src 'self' https://fonts.gstatic.com"]) {
    assert.ok(csp.includes(d), `CSP has ${d}`);
  }
  assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
});

test("restaging replaces public/ but leaves the rest of outDir alone", () => {
  const out = join(TMP, "dist-restage");
  stageSite({ root: ROOT, outDir: out });
  writeFileSync(join(out, "public", "stale.txt"), "old");
  mkdirSync(join(out, "state"), { recursive: true });
  writeFileSync(join(out, "state", "db.sqlite"), "keep me");
  stageSite({ root: ROOT, outDir: out });
  assert.ok(!existsSync(join(out, "public", "stale.txt")));
  assert.equal(readFileSync(join(out, "state", "db.sqlite"), "utf8"), "keep me");
});

test("stageSite refuses an outDir that would overwrite or recurse into the source", () => {
  assert.throws(() => stageSite({ root: ROOT, outDir: ROOT }), /contains the source/);
  assert.throws(() => stageSite({ root: ROOT, outDir: dirname(ROOT.replace(/[\\/]$/, "")) }),
    /contains the source/);
  assert.throws(() => stageSite({ root: ROOT, outDir: join(ROOT, "js", "x") }), /inside js/);
});

// --- leak scan -------------------------------------------------------------

test("scanForLeaks finds a planted string, case-insensitively, with file and line", () => {
  const dir = join(TMP, "planted");
  mkdirSync(join(dir, "deep"), { recursive: true });
  writeFileSync(join(dir, "clean.txt"), "nothing to see\n");
  const planted = DEFAULT_LEAK_PATTERNS[0].toUpperCase();
  writeFileSync(join(dir, "deep", "a.js"), `line one\nconst x = "${planted}";\n`);
  assert.deepEqual(scanForLeaks(dir, DEFAULT_LEAK_PATTERNS),
    [{ file: "deep/a.js", pattern: DEFAULT_LEAK_PATTERNS[0], line: 2 }]);
  assert.deepEqual(scanForLeaks(dir, ["", null]), [], "empty patterns never match");
});

test("deployLeakPatterns: worker name, site host and ids; tolerant of gaps", () => {
  assert.deepEqual(deployLeakPatterns(null), []);
  assert.deepEqual(deployLeakPatterns({ workerName: "abc", siteUrl: null }), ["abc"]);
  assert.ok(deployLeakPatterns(FAKE_DEPLOY).includes("quillon-vexbard.example-sub.workers.dev"));
});

test("the deploy tooling and this test name no account", () => {
  const sources = [
    ...["stage.mjs", "cf.mjs", "sql.mjs"].map((f) => join(ROOT, "scripts", "cf", f)),
    fileURLToPath(import.meta.url),
  ];
  for (const file of sources) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const p of DEFAULT_LEAK_PATTERNS) assert.ok(!text.includes(p), `${file} contains a leak pattern`);
  }
});

// The committed list is itself published with the repo, so it may only hold
// forms that are already public (the GitHub account and the surname in its
// commits). Anything private lives in the local leak-patterns.json.
test("the committed default leak patterns are only the already-public account forms", () => {
  assert.deepEqual(DEFAULT_LEAK_PATTERNS, ["matthew" + "aroy", "github.com/" + "matthew", "shackle" + "ford"]);
});

test("private leak patterns come from a local file outside the repo and join every scan", () => {
  const home = join(TMP, "home-private");
  assert.deepEqual(readLocalLeakPatterns(home), [], "no file, no patterns");
  assert.ok(localLeakPatternsPath(home).startsWith(join(home, ".config", "sotdl-cf")));
  mkdirSync(dirname(localLeakPatternsPath(home)), { recursive: true });
  writeFileSync(localLeakPatternsPath(home), JSON.stringify(["Zq-Private-Word", "", 7, "  "]));
  assert.deepEqual(readLocalLeakPatterns(home), ["Zq-Private-Word"]);

  const patterns = siteLeakPatterns(FAKE_DEPLOY, home);
  for (const p of [...DEFAULT_LEAK_PATTERNS, "Zq-Private-Word", FAKE_DEPLOY.workerName, FAKE_DEPLOY.accountId, home]) {
    assert.ok(patterns.includes(p), `site scans include ${p}`);
  }
  assert.ok(validateWorkerName("party-zq-private-word-x", readLocalLeakPatterns(home)),
    "a worker name holding a private pattern is refused");
  assert.equal(validateWorkerName("party-zq-x", readLocalLeakPatterns(home)), null);

  writeFileSync(localLeakPatternsPath(home), JSON.stringify({ not: "a list" }));
  assert.throws(() => readLocalLeakPatterns(home), /array of strings/, "a malformed file fails loudly");
});

// The owner's private patterns must not be committed either (the spec once
// named the hosting account), nor may the deploy's own identifiers (worker
// name, ids, public host). Only meaningful where the local files exist.
test("no committed file contains a private leak pattern or a deploy identifier", (t) => {
  const patterns = [
    ...readLocalLeakPatterns(), ...readLocalRepoPatterns(), ...deployLeakPatterns(readDeployConfig()),
  ].map((p) => p.toLowerCase());
  if (!patterns.length) {
    t.skip(`no private patterns or deploy config beside ${localLeakPatternsPath()}`);
    return;
  }
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, f), "utf8").toLowerCase();
    } catch {
      continue;
    }
    // Report the pattern's position, not the pattern: test output is shared.
    patterns.forEach((p, i) => { if (text.includes(p)) hits.push(`${f} (private pattern #${i + 1})`); });
  }
  assert.deepEqual(hits, []);
});

// --- SQL helpers -----------------------------------------------------------

test("sqlString doubles single quotes and rejects NUL and non-strings", () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  assert.equal(sqlString(""), "''");
  assert.throws(() => sqlString("a\u0000b"), /NUL/);
  assert.throws(() => sqlString(42), TypeError);
  assert.throws(() => sqlString(null), TypeError);
});

test("sqlInt accepts only safe integers", () => {
  assert.equal(sqlInt(1700000000000), "1700000000000");
  for (const bad of [1.5, NaN, Infinity, "1", 2 ** 60]) assert.throws(() => sqlInt(bad), TypeError);
});

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  const migration = join(ROOT, "worker", "migrations", "0001_init.sql");
  if (existsSync(migration)) {
    db.exec(readFileSync(migration, "utf8"));
  } else {
    db.exec(`CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  }
  return db;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

test("an adversarial member name stays inside its literal (executed against SQLite)", () => {
  const db = memoryDb();
  const evil = "x'); DROP TABLE members; --";
  // exec() runs every statement in the string, so an injected DROP would run.
  db.exec(insertMemberSql({ id: "m1", name: evil, tokenHash: HASH_A, createdAt: 1 }));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes("members"), "members table survived");
  assert.deepEqual(db.prepare("SELECT id, name, token_hash FROM members").all().map((r) => ({ ...r })),
    [{ id: "m1", name: evil, token_hash: HASH_A }]);
  db.exec(revokeMemberSql(evil, 5));
  assert.equal(db.prepare("SELECT revoked_at FROM members WHERE id = 'm1'").get().revoked_at, 5);
});

test("invites refuse a second active member with the same name; revoked names can be reused", () => {
  const db = memoryDb();
  // RETURNING rows are how cf.mjs learns what happened.
  const run = (sql) => db.prepare(sql).all().length;
  assert.equal(run(insertMemberSql({ id: "m1", name: "Sam", tokenHash: HASH_A, createdAt: 1 })), 1);
  assert.equal(run(insertMemberSql({ id: "m2", name: "Sam", tokenHash: HASH_B, createdAt: 2 })), 0);
  assert.equal(run(revokeMemberSql("Sam", 3)), 1);
  assert.equal(run(revokeMemberSql("Sam", 4)), 0, "already revoked");
  assert.equal(run(insertMemberSql({ id: "m3", name: "Sam", tokenHash: HASH_C, createdAt: 5 })), 1);
  assert.equal(run(revokeMemberSql("m3", 6)), 1, "revoke by id");
  const rows = db.prepare(listMembersSql()).all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: "m1", name: "Sam", created_at: 1, revoked_at: 3 },
    { id: "m3", name: "Sam", created_at: 5, revoked_at: 6 },
  ]);
});

// cf.mjs invite: a name that already has a member row (active or revoked)
// gets a new link for that same member, so its characters stay its own.
test("re-inviting a member name issues a new token for the same member id", () => {
  const db = memoryDb();
  const rows = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  const member = (id) => ({ ...db.prepare("SELECT id, name, token_hash, revoked_at FROM members WHERE id = ?").get(id) });
  db.exec(insertMemberSql({ id: "m1", name: "Sam", tokenHash: HASH_A, createdAt: 1 }));
  db.exec("INSERT INTO characters (id, owner_id, rev, body, updated_at) VALUES ('c1', 'm1', 1, '{}', 1)");

  assert.deepEqual(rows(findMemberSql("Sam")), [{ id: "m1", name: "Sam", created_at: 1, revoked_at: null }]);
  assert.deepEqual(rows(reissueMemberSql({ name: "Sam", tokenHash: HASH_B })), [{ id: "m1", name: "Sam" }]);
  assert.deepEqual(member("m1"), { id: "m1", name: "Sam", token_hash: HASH_B, revoked_at: null });

  // Revoked, then invited again: un-revoked, same id, new token.
  db.exec(revokeMemberSql("Sam", 2));
  assert.equal(rows(findMemberSql("Sam"))[0].revoked_at, 2, "the lookup sees revoked members too");
  assert.deepEqual(rows(reissueMemberSql({ name: "Sam", tokenHash: HASH_C })), [{ id: "m1", name: "Sam" }]);
  assert.deepEqual(member("m1"), { id: "m1", name: "Sam", token_hash: HASH_C, revoked_at: null });
  assert.equal(rows("SELECT id FROM members").length, 1, "no second member row");
  assert.deepEqual(rows(`SELECT m.id, m.revoked_at FROM characters c JOIN members m ON m.id = c.owner_id`),
    [{ id: "m1", revoked_at: null }], "the character is still owned by an active member");

  assert.deepEqual(rows(findMemberSql("Nobody")), []);
  assert.deepEqual(rows(reissueMemberSql({ name: "Nobody", tokenHash: HASH_A })), [], "unknown name: nothing");
  assert.deepEqual(rows(reissueMemberSql({ name: "sam", tokenHash: HASH_A })), [], "names match exactly");
  assert.equal(member("m1").token_hash, HASH_C);
  assert.throws(() => reissueMemberSql({ name: "Sam", tokenHash: "abc" }), /tokenHash/);
});

test("a re-invite picks the most recently created member with that name", () => {
  const db = memoryDb();
  const run = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  // Two revoked rows under one name, as the pre-reissue invite flow left them.
  db.exec(insertMemberSql({ id: "old", name: "Sam", tokenHash: HASH_A, createdAt: 1 }));
  db.exec(revokeMemberSql("old", 2));
  db.exec(insertMemberSql({ id: "new", name: "Sam", tokenHash: HASH_B, createdAt: 3 }));
  db.exec(revokeMemberSql("new", 4));
  assert.equal(run(findMemberSql("Sam"))[0].id, "new");
  assert.deepEqual(run(reissueMemberSql({ name: "Sam", tokenHash: HASH_C })), [{ id: "new", name: "Sam" }]);
  assert.deepEqual(run("SELECT id, token_hash, revoked_at FROM members ORDER BY id"), [
    { id: "new", token_hash: HASH_C, revoked_at: null },
    { id: "old", token_hash: HASH_A, revoked_at: 2 },
  ]);
});

test("an adversarial member name stays inside its literal through lookup and re-invite", () => {
  const db = memoryDb();
  const evil = "x'); DROP TABLE members; UPDATE members SET revoked_at = NULL; --";
  db.exec(insertMemberSql({ id: "m1", name: evil, tokenHash: HASH_A, createdAt: 1 }));
  db.exec(insertMemberSql({ id: "m2", name: "Bystander", tokenHash: HASH_B, createdAt: 2 }));
  db.exec(revokeMemberSql("m2", 3));
  // exec() runs every statement in the string, so an injected one would run.
  db.exec(findMemberSql(evil));
  db.exec(reissueMemberSql({ name: evil, tokenHash: HASH_C }));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes("members"), "members table survived");
  assert.deepEqual(db.prepare("SELECT id, name, token_hash, revoked_at FROM members ORDER BY id").all().map((r) => ({ ...r })), [
    { id: "m1", name: evil, token_hash: HASH_C, revoked_at: null },
    { id: "m2", name: "Bystander", token_hash: HASH_B, revoked_at: 3 },
  ]);
  assert.deepEqual(db.prepare(findMemberSql(evil)).all().map((r) => r.id), ["m1"]);
});

test("insertMemberSql validates the hash and timestamp", () => {
  const ok = { id: "m1", name: "Sam", tokenHash: HASH_A, createdAt: 1 };
  assert.throws(() => insertMemberSql({ ...ok, tokenHash: "abc" }), /tokenHash/);
  assert.throws(() => insertMemberSql({ ...ok, tokenHash: HASH_A.toUpperCase() }), /tokenHash/);
  assert.throws(() => insertMemberSql({ ...ok, createdAt: "1" }), TypeError);
  assert.throws(() => revokeMemberSql("Sam", 1.5), TypeError);
});

test("validateMemberName trims and rejects empty, long and control-character names", () => {
  assert.equal(validateMemberName("  Sam  "), "Sam");
  for (const bad of ["", "   ", "x".repeat(41), "a\nb", "a\u0000b", undefined]) {
    assert.throws(() => validateMemberName(bad));
  }
});

test("hashToken is SHA-256 hex (known vector); mintToken is 32 random base64url bytes", async () => {
  assert.equal(await hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const a = mintToken();
  const b = mintToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, b);
});

// --- cf.mjs helpers --------------------------------------------------------

test("wranglerEnv isolates the login and strips ambient Cloudflare credentials", () => {
  const base = {
    PATH: "/usr/bin", HOME: "/home/x",
    CLOUDFLARE_API_TOKEN: "t", CF_API_TOKEN: "t", CLOUDFLARE_API_KEY: "k", CF_API_KEY: "k",
    CLOUDFLARE_EMAIL: "e", CLOUDFLARE_ACCOUNT_ID: "other", CF_ACCOUNT_ID: "other",
    WRANGLER_AUTH_URL: "u", CLOUDFLARE_AUTH_USE_KEYRING: "true",
  };
  const env = wranglerEnv(base, { configHome: "/cfg" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.XDG_CONFIG_HOME, "/cfg");
  assert.equal(env.CLOUDFLARE_AUTH_USE_KEYRING, "false");
  assert.equal(env.CLOUDFLARE_CF_FETCH_ENABLED, "false");
  assert.equal(env.WRANGLER_CACHE_DIR, join("/cfg", "cache"));
  for (const k of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY",
    "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "WRANGLER_AUTH_URL"]) {
    assert.ok(!(k in env), `${k} stripped`);
  }
  const withAccount = wranglerEnv(base, { configHome: "/cfg", accountId: "acc" });
  assert.equal(withAccount.CLOUDFLARE_ACCOUNT_ID, "acc");
  assert.equal(base.CLOUDFLARE_API_TOKEN, "t", "input env not mutated");
});

// Under a coding agent, wrangler registers the account's workers.dev
// subdomain on a first deploy without asking, named after this project.
test("wranglerEnv hides the coding-agent markers wrangler looks for", () => {
  const base = { PATH: "/usr/bin", CLAUDECODE: "1", CURSOR_TRACE_ID: "x", CODEX_THREAD_ID: "x", GEMINI_CLI: "1" };
  const env = wranglerEnv(base, { configHome: "/cfg" });
  for (const k of ["CLAUDECODE", "CURSOR_TRACE_ID", "CODEX_THREAD_ID", "GEMINI_CLI"]) {
    assert.ok(AGENT_ENV.includes(k), `${k} listed`);
    assert.ok(!(k in env), `${k} stripped`);
  }
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(base.CLAUDECODE, "1", "input env not mutated");
});

// wrangler dev otherwise mounts its Local Explorer (an unauthenticated SQL
// API on the dev database) on every interface the dev server binds.
test("wranglerEnv turns wrangler's Local Explorer off, whatever the shell says", () => {
  assert.equal(wranglerEnv({}, { configHome: "/cfg" }).X_LOCAL_EXPLORER, "false");
  assert.equal(wranglerEnv({ X_LOCAL_EXPLORER: "true" }, { configHome: "/cfg" }).X_LOCAL_EXPLORER, "false");
});

test("isolationProblem flags a legacy ~/.wrangler directory", () => {
  const home = join(TMP, "home");
  const root = join(TMP, "root-clean");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  assert.equal(isolationProblem(home, root), null);
  mkdirSync(join(home, ".wrangler"));
  assert.match(isolationProblem(home, root), /\.wrangler/);
});

// wrangler loads .env / .env.local from its working directory, refilling the
// CLOUDFLARE_* variables wranglerEnv just removed.
test("isolationProblem flags a .env or .env.local in the checkout", () => {
  const home = join(TMP, "home-env");
  mkdirSync(home, { recursive: true });
  for (const name of [".env", ".env.local"]) {
    const root = join(TMP, `root${name}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name), "CLOUDFLARE_API_TOKEN=x\n");
    assert.match(isolationProblem(home, root) ?? "", new RegExp(name.replace(".", "\\.")));
  }
});

// Backstop for whatever subdomain the account has: the address is checked
// before it is recorded or printed as live.
test("deployHostProblem refuses a public address naming the owner or the repo", () => {
  const home = join(TMP, "home-host");
  mkdirSync(dirname(localLeakPatternsPath(home)), { recursive: true });
  writeFileSync(localLeakPatternsPath(home), JSON.stringify(["zqprivate"]));
  const patterns = hostLeakPatterns({ home });
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;
  for (const p of [...DEFAULT_LEAK_PATTERNS, "zqprivate", pkg, "demon-lord"]) {
    assert.ok(patterns.includes(p), `host patterns include ${p}`);
  }
  assert.equal(deployHostProblem("https://quillon-vexbard.tavomi-rekul.workers.dev", patterns), null);
  for (const host of [`quillon-vexbard.${pkg}`, "quillon-vexbard.zqprivate", "quillon-vexbard.my-demon-lord-site",
    `quillon-vexbard.${DEFAULT_LEAK_PATTERNS[0].toUpperCase()}`]) {
    assert.match(deployHostProblem(`https://${host}.workers.dev`, patterns) ?? "", /identif/, host);
  }
  assert.ok(deployHostProblem("not a url", patterns));
});

test("the generated wrangler config points back into the repo from .cf-dist/", () => {
  const config = buildWranglerConfig({ name: "w", databaseName: "d", databaseId: "id" });
  const dist = join(ROOT, ".cf-dist");
  assert.ok(existsSync(join(dist, config.main)), "main resolves to worker/index.js");
  assert.equal(join(dist, config.main), join(ROOT, "worker", "index.js"));
  assert.equal(join(dist, config.assets.directory), join(dist, "public"));
  assert.equal(join(dist, config.d1_databases[0].migrations_dir), join(ROOT, "worker", "migrations"));
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.upload_source_maps, false, "source maps carry absolute local paths");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*"]);
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.d1_databases[0],
    { binding: "DB", database_name: "d", database_id: "id", migrations_dir: "../worker/migrations" });
});

test("wrangler output parsers", () => {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(parseDatabaseId(`Created your new D1 database.\n\n{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "x",\n      "database_id": "${id}"\n    }\n  ]\n}`), id);
  assert.equal(parseDatabaseId(`[[d1_databases]]\nbinding = "DB"\ndatabase_id = "${id}"`), id);
  assert.equal(parseDatabaseId("no id here"), null);

  const ndjson = [
    JSON.stringify({ type: "wrangler-session", version: 1 }),
    JSON.stringify({ type: "deploy", targets: ["https://w.sub.workers.dev", "schedule: x"] }),
  ].join("\n");
  assert.equal(parseDeployUrl(ndjson), "https://w.sub.workers.dev");
  assert.equal(parseDeployUrl("Deployed w triggers\n  https://w.sub.workers.dev\n"), "https://w.sub.workers.dev");
  assert.equal(parseDeployUrl("nothing"), null);

  assert.deepEqual(parseJsonOutput("banner line\n[\n {\"a\": 1}\n]\n"), [{ a: 1 }]);
  assert.throws(() => parseJsonOutput("no json"));

  assert.deepEqual(parseAccounts({ loggedIn: true, accounts: [{ name: "A", id: "1" }, { id: "2" }, {}] }),
    [{ id: "1", name: "A" }, { id: "2", name: "2" }]);
  assert.deepEqual(parseAccounts({}), []);

  // Shape of local `wrangler d1 execute --json` output (no change count).
  assert.deepEqual(parseD1Rows([{ results: [{ id: "m1" }], success: true, meta: { duration: 0 } }]),
    [{ id: "m1" }]);
  assert.deepEqual(parseD1Rows([{ results: [], success: true, meta: {} }]), []);
  assert.throws(() => parseD1Rows([{ success: false }]));
  assert.throws(() => parseD1Rows([{ success: true }]));
});

test("worker and database name rules; suggestions always pass them", () => {
  assert.equal(validateWorkerName("party-sheet-2"), null);
  for (const bad of ["", "Party", "-x", "x-", "a_b", "x".repeat(64), DEFAULT_LEAK_PATTERNS[0]]) {
    assert.ok(validateWorkerName(bad), `rejects ${bad}`);
  }
  assert.equal(validateDatabaseName("party_db-1"), null);
  assert.ok(validateDatabaseName("Bad Name"));
  for (let i = 0; i < 20; i++) {
    const name = suggestName();
    assert.equal(validateWorkerName(name), null, name);
    assert.equal(validateDatabaseName(name), null, name);
  }
});
