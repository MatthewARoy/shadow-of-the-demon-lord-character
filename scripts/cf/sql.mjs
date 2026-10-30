// SQL and token helpers for the party-membership commands in cf.mjs.
//
// `wrangler d1 execute --command` takes literal SQL with no bound parameters,
// so every value that reaches it goes through sqlString()/sqlInt() here.
// Pure functions (plus Web Crypto), so node --test can execute the output
// against node:sqlite with the real migration. See
// docs/superpowers/specs/2026-10-29-shared-party-storage-design.md.

// --- literals --------------------------------------------------------------

// A single-quoted SQLite string literal. Doubling ' is the only escape SQLite
// has inside '...'; NUL is refused because SQLite (and the argv that carries
// the command to wrangler) would cut the string there.
export function sqlString(value) {
  if (typeof value !== "string") throw new TypeError("sqlString: expected a string");
  if (value.includes("\u0000")) throw new Error("sqlString: NUL is not allowed");
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlInt(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("sqlInt: expected a safe integer");
  return String(value);
}

// --- members ---------------------------------------------------------------

export const MEMBER_NAME_MAX = 40;

// Member names show up in every party member's roster, so keep them short and
// printable. Returns the trimmed name or throws with a message for the CLI.
export function validateMemberName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("A member name is required.");
  if (trimmed.length > MEMBER_NAME_MAX) {
    throw new Error(`Member names are at most ${MEMBER_NAME_MAX} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("Member names cannot contain control characters.");
  }
  return trimmed;
}

function checkTokenHash(fn, tokenHash) {
  if (!/^[0-9a-f]{64}$/.test(tokenHash ?? "")) {
    throw new Error(`${fn}: tokenHash must be 64 lowercase hex characters`);
  }
}

// The member row a name refers to: the most recently created one with exactly
// this name, active or revoked (at most one row). cf.mjs invite uses it to
// choose between adding a member and re-issuing an existing member's link.
const newestNamed = (n) =>
  `SELECT id FROM members WHERE name = ${n} ORDER BY created_at DESC, rowid DESC LIMIT 1`;

export function findMemberSql(name) {
  const n = sqlString(name);
  return `SELECT id, name, created_at, revoked_at FROM members WHERE id = (${newestNamed(n)});`;
}

// One INSERT statement. It inserts nothing when an active member already
// has this name, so two people never appear under the same label. (cf.mjs
// only inserts a name no member row has; for a known name it re-issues.)
// RETURNING reports what happened as rows, because local
// `wrangler d1 execute --json` output carries no change count.
export function insertMemberSql({ id, name, tokenHash, createdAt }) {
  checkTokenHash("insertMemberSql", tokenHash);
  const n = sqlString(name);
  return "INSERT INTO members (id, name, token_hash, created_at) "
    + `SELECT ${sqlString(id)}, ${n}, ${sqlString(tokenHash)}, ${sqlInt(createdAt)} `
    + `WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = ${n} AND revoked_at IS NULL) `
    + "RETURNING id;";
}

// Revokes the active member whose name or id matches, returning the revoked
// rows. Their characters stay in the party; only the token stops working.
export function revokeMemberSql(nameOrId, now) {
  const v = sqlString(nameOrId);
  return `UPDATE members SET revoked_at = ${sqlInt(now)} `
    + `WHERE (name = ${v} OR id = ${v}) AND revoked_at IS NULL RETURNING id, name;`;
}

// A new invite link for an existing member: the member row findMemberSql
// picks gets a new token hash and is un-revoked. Its id is kept, and with it
// every character it owns; the old link stops working. Returns that row.
export function reissueMemberSql({ name, tokenHash }) {
  checkTokenHash("reissueMemberSql", tokenHash);
  return `UPDATE members SET token_hash = ${sqlString(tokenHash)}, revoked_at = NULL `
    + `WHERE id = (${newestNamed(sqlString(name))}) RETURNING id, name;`;
}

export function listMembersSql() {
  return "SELECT id, name, created_at, revoked_at FROM members ORDER BY created_at, name;";
}

// --- tokens ----------------------------------------------------------------

// 32 random bytes, base64url: the invite secret. Only its hash is stored.
export function mintToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

// SHA-256 of the UTF-8 token, lowercase hex — the same digest the Worker
// computes from the Authorization header (worker/index.js).
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
