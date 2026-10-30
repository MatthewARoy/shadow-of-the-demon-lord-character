// Cloudflare deploy tooling for shared party storage — the only way this
// repo runs wrangler.
//
//   npm run cf -- login                  sign in (isolated wrangler login)
//   npm run cf -- setup                  pick account, name worker + database, create D1
//   npm run cf -- deploy                 stage, migrate, deploy, record the site URL
//   npm run cf -- dev                    local Worker + local D1 on :8787
//   npm run cf -- invite <name> [--local]   (an existing name gets a new link)
//   npm run cf -- members [--local]
//   npm run cf -- revoke <name|id> [--local]
//
// Isolation: every wrangler call runs with XDG_CONFIG_HOME=~/.config/sotdl-cf,
// so this login never mixes with any other wrangler login on the machine, and
// with the environment's Cloudflare credentials stripped. Account, database
// and worker identifiers live in ~/.config/sotdl-cf/deploy.json, never in the
// repo. See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_LEAK_PATTERNS, REPO_ROOT, configDir, deployConfigPath, formatLeaks,
  readDeployConfig, readLocalLeakPatterns, scanForLeaks, siteLeakPatterns, stageSite,
} from "./stage.mjs";
import {
  findMemberSql, hashToken, insertMemberSql, listMembersSql, mintToken, reissueMemberSql,
  revokeMemberSql, validateMemberName,
} from "./sql.mjs";

const DIST = join(REPO_ROOT, ".cf-dist");
const STATE = join(DIST, "state");
const REMOTE_CONFIG = join(DIST, "wrangler.json");
const LOCAL_CONFIG = join(DIST, "wrangler.local.json");
const LOCAL_DB = { name: "sotdl-local", databaseName: "sotdl-local", databaseId: "local" };
const DEV_PORT = 8787;

// --- pure helpers (exported for cf-stage.test.mjs) -------------------------

// Credentials and endpoints wrangler would otherwise pick up from the shell:
// API tokens/keys (and their CF_* legacy names), account ids, auth URLs,
// profiles. All CLOUDFLARE_*, CF_* and WRANGLER_* variables are dropped, then
// only what this tool needs is set back.
const STRIPPED_ENV = /^(CLOUDFLARE_|CF_|WRANGLER_)/;

// Variables wrangler reads to decide it runs under a coding agent (its
// detect-agent table). Under an agent, a first deploy registers the account's
// workers.dev subdomain without asking, named after this project's package —
// which a GitHub search ties straight back to this repo. Without them,
// wrangler asks (deployHostProblem still checks whatever it ends up with).
export const AGENT_ENV = [
  "CLAUDECODE", "CURSOR_TRACE_ID", "CODEX_THREAD_ID", "GEMINI_CLI", "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_PROJECT_ID", "REPL_ID", "REPLIT_MODE", "AIDER_API_KEY", "AMP_CURRENT_THREAD_ID",
  "AUGMENT_AGENT", "CODEIUM_EDITOR_APP_ROOT", "CRUSH", "AGENT", "AI_AGENT", "OPENCODE",
  "OPENCODE_BIN_PATH", "OPENCODE_SERVER", "OPENCODE_APP_INFO", "OPENCODE_MODES",
  "PI_CODING_AGENT", "QWEN_CODE",
];

export function wranglerEnv(baseEnv, { configHome, accountId = null, extra = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (!STRIPPED_ENV.test(k) && !AGENT_ENV.includes(k)) env[k] = v;
  }
  env.XDG_CONFIG_HOME = configHome;
  // Without this wrangler may keep the OAuth token (or its key) in the OS
  // keychain; "false" forces the plain credential file under XDG_CONFIG_HOME.
  env.CLOUDFLARE_AUTH_USE_KEYRING = "false";
  env.WRANGLER_SEND_METRICS = "false";
  // Wrangler's cache (account choice and the like) goes beside the login,
  // not into the checkout. Local dev/D1 would otherwise fetch a request.cf
  // sample (with the machine's city and network) from Cloudflare and cache
  // it in the repo; the Worker never reads request.cf, so turn that off.
  env.WRANGLER_CACHE_DIR = join(configHome, "cache");
  env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
  // `wrangler dev` otherwise mounts its Local Explorer, an unauthenticated
  // API that runs any SQL on the dev database, on every interface it binds
  // (cmdDev binds all of them so a phone can connect).
  env.X_LOCAL_EXPLORER = "false";
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return { ...env, ...extra };
}

// wrangler prefers an existing ~/.wrangler over XDG_CONFIG_HOME (its
// "legacy home dir"), which would silently share a login with it. It also
// loads .env and .env.local from its working directory (the checkout, for
// most commands), which would put back the CLOUDFLARE_* variables
// wranglerEnv removes.
export function isolationProblem(home = homedir(), root = REPO_ROOT) {
  const legacy = join(home, ".wrangler");
  let isDir = false;
  try {
    isDir = statSync(legacy).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    return `${legacy} exists, and wrangler would use it instead of the isolated login in `
      + `${configDir(home)}. Move it aside (for example rename it to .wrangler.bak) and retry.`;
  }
  for (const name of [".env", ".env.local"]) {
    const file = join(root, name);
    if (existsSync(file)) {
      return `${file} exists, and wrangler would load Cloudflare credentials from it instead of `
        + `the isolated login in ${configDir(home)}. Move it out of the checkout and retry.`;
    }
  }
  return null;
}

// The generated wrangler config. Paths are relative to the config file in
// .cf-dist/, so the worker and migrations come straight from the repo.
export function buildWranglerConfig({ name, databaseName, databaseId }) {
  return {
    name,
    main: "../worker/index.js",
    compatibility_date: "2026-10-01",
    workers_dev: true,
    preview_urls: false,
    upload_source_maps: false,
    assets: { directory: "./public", binding: "ASSETS", run_worker_first: ["/api/*"] },
    d1_databases: [{
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: "../worker/migrations",
    }],
  };
}

// Worker names become the first label of <name>.<subdomain>.workers.dev.
// extraPatterns: more identifying strings to refuse (setup passes the
// private local list and the repo's own names).
export function validateWorkerName(name, extraPatterns = []) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name ?? "")) {
    return "Use 1-63 lowercase letters, digits and dashes (not at either end).";
  }
  const lower = name.toLowerCase();
  if ([...DEFAULT_LEAK_PATTERNS, ...extraPatterns].some((p) => typeof p === "string" && p
    && lower.includes(p.toLowerCase()))) {
    return "That name contains an identifying string the leak scan blocks.";
  }
  return null;
}

// What the public host must not contain: the owner's patterns (committed and
// local) and the repo's own names. Wrangler names an automatically registered
// workers.dev subdomain after the package or the directory, and either one,
// searched on GitHub, finds this repo.
export function hostLeakPatterns({ home = homedir(), root = REPO_ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  return [...DEFAULT_LEAK_PATTERNS, ...readLocalLeakPatterns(home), pkg, basename(root), "demon-lord"]
    .filter((p) => typeof p === "string" && p.trim() !== "");
}

// null when the deployed address is safe to hand out, else why not.
export function deployHostProblem(url, patterns) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return `"${url}" is not a URL.`;
  }
  const hits = patterns.filter((p) => host.includes(p.toLowerCase()));
  if (!hits.length) return null;
  return `The public address ${host} contains identifying strings (${hits.map((p) => `"${p}"`).join(", ")}).`;
}

export function validateDatabaseName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name ?? "")) {
    return "Use 1-63 lowercase letters, digits, dashes and underscores.";
  }
  return null;
}

// A pronounceable random name such as "tavomi-rekul", generated at run time
// so no default name is ever committed.
export function suggestName(random = Math.random) {
  const C = "bdfgklmnprstvz";
  const V = "aeiou";
  const pick = (s) => s[Math.floor(random() * s.length)];
  const word = (n) => Array.from({ length: n }, () => pick(C) + pick(V)).join("") + pick(C);
  return `${word(2)}-${word(2)}`;
}

// The JSON document in wrangler output that may be preceded by banner lines.
export function parseJsonOutput(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start < 0) throw new Error("wrangler printed no JSON");
  return JSON.parse(lines.slice(start).join("\n"));
}

// `wrangler whoami --json` → [{id, name}].
export function parseAccounts(json) {
  const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
  return accounts
    .filter((a) => a && typeof a.id === "string" && a.id)
    .map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : a.id }));
}

// `wrangler d1 create` prints a config snippet containing database_id (JSON
// or TOML depending on version).
export function parseDatabaseId(text) {
  const m = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(String(text));
  return m ? m[1] : null;
}

// The deployed workers.dev URL, from the WRANGLER_OUTPUT_FILE_PATH log
// (ND-JSON; the "deploy" entry lists its targets) or, failing that, any
// workers.dev URL in the text.
export function parseDeployUrl(text) {
  for (const line of String(text).split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const hit = (entry?.type === "deploy" && Array.isArray(entry.targets))
      ? entry.targets.find((t) => typeof t === "string" && /^https:\/\/[^/\s]+\.workers\.dev$/i.test(t))
      : null;
    if (hit) return hit;
  }
  const m = /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i.exec(String(text));
  return m ? m[0] : null;
}

// Rows from `wrangler d1 execute --json`: [{results, success, meta}]. The
// membership SQL uses RETURNING, so rows say what changed both locally and
// remotely (local output has no change count).
export function parseD1Rows(json) {
  const first = Array.isArray(json) ? json[0] : json;
  if (!first || first.success === false) throw new Error("the D1 command did not succeed");
  if (!Array.isArray(first.results)) throw new Error("the D1 command returned no result rows");
  return first.results;
}

// --- wrangler --------------------------------------------------------------

// The one place wrangler is spawned. No shell, so `--command <sql>` reaches
// wrangler as a single argument. stdio is inherited (interactive prompts
// work) unless capture is set, in which case stdout is collected and stderr
// is shown as it arrives.
function wrangler(args, { cwd = REPO_ROOT, capture = false, accountId, extraEnv = {} } = {}) {
  const problem = isolationProblem();
  if (problem) throw new Error(problem);
  const configHome = ensureConfigDir();
  const env = wranglerEnv(process.env, {
    configHome,
    accountId: accountId === undefined ? readDeployConfig()?.accountId : accountId,
    extra: extraEnv,
  });
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["-y", "wrangler@4", ...args], {
      cwd,
      env,
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => process.stderr.write(d));
    }
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout }));
  });
}

async function wranglerOk(args, opts) {
  const result = await wrangler(args, opts);
  if (result.code !== 0) {
    if (opts?.capture && result.stdout) process.stdout.write(result.stdout);
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${result.code})`);
  }
  return result;
}

// --- local state -----------------------------------------------------------

function ensureConfigDir() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function saveDeployConfig(deploy) {
  ensureConfigDir();
  writeFileSync(deployConfigPath(), JSON.stringify(deploy, null, 2) + "\n", { mode: 0o600 });
}

function requireDeploy() {
  const deploy = readDeployConfig();
  if (!deploy?.accountId || !deploy?.databaseId || !deploy?.workerName) {
    throw new Error("No deploy config yet. Run: npm run cf -- setup");
  }
  return deploy;
}

function writeConfig(path, config) {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// Stage the site and refuse to continue on any identifying string.
function stageOrDie(deploy) {
  const { publicDir, leaks } = stageSite({
    root: REPO_ROOT,
    outDir: DIST,
    deploy,
    extraPatterns: [...readLocalLeakPatterns(), homedir()],
  });
  if (leaks.length) {
    throw new Error(`The staged site contains identifying strings:\n${formatLeaks(leaks)}`);
  }
  console.log(`Staged ${publicDir}`);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askName(label, suggestion, validate) {
  for (;;) {
    const answer = (await ask(`${label} [${suggestion}]: `)) || suggestion;
    const problem = validate(answer);
    if (!problem) return answer;
    console.log(problem);
  }
}

// --- commands --------------------------------------------------------------

async function cmdLogin(rest) {
  console.log("Sign in with the Cloudflare account that will host the party, not a work "
    + "account. To use a private browser window, add --browser=false and open the "
    + "printed link there.");
  await wranglerOk(["login", ...rest], { cwd: ensureConfigDir(), accountId: null });
}

async function cmdSetup() {
  const existing = readDeployConfig();
  if (existing?.databaseId) {
    console.log(`Already set up (worker "${existing.workerName}", database `
      + `"${existing.databaseName}"). To start over, delete ${deployConfigPath()}.`);
    return;
  }

  const who = await wrangler(["whoami", "--json"], {
    cwd: ensureConfigDir(), capture: true, accountId: null,
  });
  if (who.code !== 0) throw new Error("Not signed in. Run: npm run cf -- login");
  const accounts = parseAccounts(parseJsonOutput(who.stdout));
  if (accounts.length === 0) throw new Error("This login has no Cloudflare accounts.");

  let account;
  if (accounts.length === 1) {
    account = accounts[0];
    const ok = await ask(`Use account "${account.name}"? [y/N]: `);
    if (!/^y(es)?$/i.test(ok)) throw new Error("Setup cancelled.");
  } else {
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
    for (;;) {
      const n = Number(await ask(`Account to use (1-${accounts.length}): `));
      if (Number.isInteger(n) && n >= 1 && n <= accounts.length) {
        account = accounts[n - 1];
        break;
      }
    }
  }

  console.log("The worker name becomes the first part of the public address "
    + "(<worker>.<subdomain>.workers.dev). Pick something that does not identify you.");
  // A name that already occurs in the site's files would make every deploy's
  // leak scan fail, so check it against a throwaway staged copy.
  const scratch = mkdtempSync(join(tmpdir(), "sotdl-stage-"));
  let workerName;
  try {
    const { publicDir } = stageSite({ root: REPO_ROOT, outDir: scratch });
    const refused = hostLeakPatterns();
    workerName = await askName("Worker name", suggestName(), (name) => validateWorkerName(name, refused)
      ?? (scanForLeaks(publicDir, [name]).length
        ? "That name already appears in the site's files; the leak scan would block every deploy."
        : null));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const databaseName = await askName("Database name", suggestName(), validateDatabaseName);

  const created = await wranglerOk(["d1", "create", databaseName], {
    cwd: ensureConfigDir(), capture: true, accountId: account.id,
  });
  process.stdout.write(created.stdout);
  const databaseId = parseDatabaseId(created.stdout);
  if (!databaseId) throw new Error("Could not find database_id in the wrangler output above.");

  saveDeployConfig({ accountId: account.id, databaseId, databaseName, workerName, siteUrl: null });
  console.log(`Saved ${deployConfigPath()}. Next: npm run cf -- deploy`);
}

async function cmdDeploy() {
  const deploy = requireDeploy();
  stageOrDie(deploy);
  const config = buildWranglerConfig({
    name: deploy.workerName, databaseName: deploy.databaseName, databaseId: deploy.databaseId,
  });
  writeConfig(REMOTE_CONFIG, config);

  // The Worker bundle is code we upload too: build it locally (a dry run
  // needs no login) and scan it with the same patterns before anything
  // leaves the machine. The dry run also writes a README naming the worker
  // and a source map whose sourceRoot is this checkout's absolute path;
  // neither is uploaded (upload_source_maps is false), so skip both.
  const bundleDir = join(DIST, "bundle");
  rmSync(bundleDir, { recursive: true, force: true });
  await wranglerOk(["deploy", "--dry-run", "--outdir", bundleDir, "--config", REMOTE_CONFIG]);
  const bundleLeaks = scanForLeaks(bundleDir, siteLeakPatterns(deploy))
    .filter((l) => l.file !== "README.md" && !l.file.endsWith(".map"));
  if (bundleLeaks.length) {
    throw new Error(`The Worker bundle contains identifying strings:\n${formatLeaks(bundleLeaks)}`);
  }

  await wranglerOk(["d1", "migrations", "apply", deploy.databaseName, "--remote",
    "--config", REMOTE_CONFIG]);

  // Inherit stdio so wrangler can ask to register a workers.dev subdomain on
  // a first deploy (wranglerEnv hides the coding-agent markers that would
  // make it pick one silently); read the URL from its machine-readable
  // output file.
  const outputFile = join(ensureConfigDir(), "deploy-output.ndjson");
  rmSync(outputFile, { force: true });
  try {
    await wranglerOk(["deploy", "--config", REMOTE_CONFIG], {
      extraEnv: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
    });
    const url = existsSync(outputFile) ? parseDeployUrl(readFileSync(outputFile, "utf8")) : null;
    const problem = url && deployHostProblem(url, hostLeakPatterns());
    if (problem) {
      throw new Error(`${problem}\nIt is NOT recorded as the site address, and no invite will use it. `
        + "Before sharing anything: change the account's workers.dev subdomain in the Cloudflare "
        + "dashboard (Workers & Pages), delete this worker there, then run deploy again.");
    }
    if (url) {
      saveDeployConfig({ ...deploy, siteUrl: url });
      console.log(`\nLive at ${url} (recorded in ${deployConfigPath()}).`);
    } else {
      console.log("\nDeployed, but no workers.dev URL was found in wrangler's output. "
        + `Add it as "siteUrl" in ${deployConfigPath()} so invite links use it.`);
    }
  } finally {
    rmSync(outputFile, { force: true });
  }
}

// Local config, and the local database migrated, for dev and --local admin.
async function prepareLocal({ restage }) {
  if (restage || !existsSync(join(DIST, "public", "index.html"))) stageOrDie(readDeployConfig());
  writeConfig(LOCAL_CONFIG, buildWranglerConfig(LOCAL_DB));
  await wranglerOk(["d1", "migrations", "apply", LOCAL_DB.databaseName, "--local",
    "--persist-to", STATE, "--config", LOCAL_CONFIG], { accountId: null });
}

async function cmdDev() {
  await prepareLocal({ restage: true });
  console.log(`Serving on http://localhost:${DEV_PORT} (and http://127.0.0.1:${DEV_PORT}, `
    + "which has separate browser storage). Invite with: npm run cf -- invite <name> --local");
  await wranglerOk(["dev", "--config", LOCAL_CONFIG, "--local", "--persist-to", STATE,
    "--port", String(DEV_PORT), "--ip", "0.0.0.0"], { accountId: null });
}

// Runs one SQL statement against the remote or local database and returns
// its result rows.
async function d1(sql, local) {
  const args = local
    ? ["d1", "execute", LOCAL_DB.databaseName, "--local", "--persist-to", STATE,
      "--config", LOCAL_CONFIG]
    : ["d1", "execute", requireDeploy().databaseName, "--remote"];
  if (local) await prepareLocal({ restage: false });
  // Remote runs outside the repo with no config: wrangler finds the database
  // by name in the account from deploy.json.
  const cwd = local ? REPO_ROOT : ensureConfigDir();
  const result = await wranglerOk([...args, "--json", "--command", sql], {
    cwd, capture: true, ...(local ? { accountId: null } : {}),
  });
  return parseD1Rows(parseJsonOutput(result.stdout));
}

// A name that already has a member (active or revoked) gets a new link for
// that same member: the id, and so every character it owns, stays. Minting a
// new member instead would leave those characters with the old id, where the
// player's devices could no longer save them.
async function cmdInvite(name, local) {
  const memberName = validateMemberName(name);
  const base = local ? `http://localhost:${DEV_PORT}` : requireDeploy().siteUrl;
  if (!base) throw new Error("No site URL recorded yet. Run: npm run cf -- deploy");
  const token = mintToken();
  const tokenHash = await hashToken(token);
  const [existing] = await d1(findMemberSql(memberName), local);
  if (existing) {
    const ok = await ask(`Issue a new link for existing member ${memberName}? `
      + "Their old link stops working. [y/N] ");
    if (!/^y(es)?$/i.test(ok)) {
      console.log("No new link issued.");
      return;
    }
    const reissued = await d1(reissueMemberSql({ name: memberName, tokenHash }), local);
    if (reissued.length !== 1) throw new Error(`Could not issue a new link for "${memberName}".`);
  } else {
    const inserted = await d1(insertMemberSql({
      id: randomUUID(), name: memberName, tokenHash, createdAt: Date.now(),
    }), local);
    if (inserted.length !== 1) {
      throw new Error(`A member called "${memberName}" was added meanwhile. Run invite again.`);
    }
  }
  // The token exists only in this link: it is printed here and nowhere else.
  console.log(`\nInvite for ${memberName} (send it privately; it works until revoked):\n`);
  console.log(`  ${base.replace(/\/+$/, "")}/#invite=${token}\n`);
}

async function cmdMembers(local) {
  const rows = await d1(listMembersSql(), local);
  if (rows.length === 0) {
    console.log("No members yet. Invite with: npm run cf -- invite <name>");
    return;
  }
  const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "?");
  for (const m of rows) {
    const status = m.revoked_at == null ? "active" : `revoked ${day(m.revoked_at)}`;
    console.log(`  ${String(m.name).padEnd(24)} ${status.padEnd(20)} joined ${day(m.created_at)}  ${m.id}`);
  }
}

async function cmdRevoke(nameOrId, local) {
  if (!nameOrId) throw new Error("Usage: npm run cf -- revoke <name|id> [--local]");
  const revoked = await d1(revokeMemberSql(nameOrId.trim(), Date.now()), local);
  if (revoked.length === 0) {
    console.log(`No active member matches "${nameOrId}".`);
    return;
  }
  for (const m of revoked) console.log(`Revoked ${m.name} (${m.id}).`);
  console.log("Their invite link no longer works; their characters stay visible to the party. "
    + "To let them back in, invite the same name again.");
}

const USAGE = `Usage: npm run cf -- <command>

  login                      sign in to Cloudflare (isolated wrangler login)
  setup                      choose account, worker and database names; create the database
  deploy                     stage, scan, migrate and deploy; record the site URL
  dev                        run the Worker and a local database on :${DEV_PORT}
  invite <name> [--local]    add a member (or re-issue an existing one's link) and print it
  members [--local]          list members
  revoke <name|id> [--local] cut off a member's link

Local state: ${deployConfigPath()}`;

async function main(argv) {
  const [command, ...rest] = argv;
  const local = rest.includes("--local");
  const words = rest.filter((a) => !a.startsWith("--")).join(" ");
  switch (command) {
    case "login": return cmdLogin(rest);
    case "setup": return cmdSetup();
    case "deploy": return cmdDeploy();
    case "dev": return cmdDev();
    case "invite": return cmdInvite(words, local);
    case "members": return cmdMembers(local);
    case "revoke": return cmdRevoke(words, local);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return undefined;
    default:
      console.error(USAGE);
      process.exitCode = 1;
      return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

