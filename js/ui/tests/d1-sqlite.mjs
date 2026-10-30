// A D1-shaped database over node:sqlite, so worker.test.mjs can run the real
// Worker handler against the real migration SQL with no network and no
// wrangler. A helper, not a test file (no ".test." in the name), and it needs
// `node --experimental-sqlite` on Node 22.
//
// It copies the parts of the D1 client API the Worker relies on, including
// the ones that are easy to get wrong in a fake:
// - prepare() is lazy: bad SQL rejects from first()/all()/run(), not prepare().
// - bind() returns a new statement; the unbound one stays reusable.
// - undefined, objects and other unsupported values are refused at bind().
// - a wrong number of bindings throws (node:sqlite would quietly bind NULL).
// - constraint violations throw, with SQLite's "UNIQUE constraint failed: …".
// - foreign keys are enforced (D1 always runs with foreign_keys = ON).
// - rows are plain objects and "no row" is null.
// - batch() runs every statement in one transaction, rolled back on any error.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export const MIGRATIONS_DIR = new URL("../../../worker/migrations/", import.meta.url);

// A fresh in-memory database with every migration applied in file-name
// order. `DB` is what the Worker sees as env.DB; `sqlite` is the raw
// DatabaseSync for tests to seed and inspect rows directly.
export function openD1({ migrationsDir = MIGRATIONS_DIR } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
  return { DB: new D1Database(sqlite), sqlite };
}

// Module-private hook so batch() can run statements synchronously inside its
// transaction without exposing that on the public statement API.
const EXECUTE = Symbol("execute");

// D1 accepts null, numbers, strings, booleans (stored as 1/0) and binary.
function toSqlite(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value bound to a statement`);
}

// D1 only supports anonymous (?) and ordered (?NNN) parameters. Count them,
// skipping quoted strings and comments, so a missing bind fails loudly.
function parameterCount(sql) {
  let anonymous = 0;
  let highest = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = sql.indexOf(ch, i + 1);
      i = end === -1 ? sql.length : end;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (ch === "?") {
      const digits = /^\d+/.exec(sql.slice(i + 1));
      if (digits) {
        highest = Math.max(highest, Number(digits[0]));
        i += digits[0].length;
      } else {
        anonymous++;
      }
    }
  }
  return Math.max(anonymous, highest);
}

const plain = (row) => (row == null ? null : { ...row });
const READS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;

class D1PreparedStatement {
  #sqlite;
  #sql;
  #params;

  constructor(sqlite, sql, params = []) {
    this.#sqlite = sqlite;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values) {
    return new D1PreparedStatement(this.#sqlite, this.#sql, values.map(toSqlite));
  }

  // Synchronous core shared by the async methods and batch(). `mode` is
  // "first", "all", "run" or "batch" (all() for reads, run() for writes).
  [EXECUTE](mode) {
    if (mode === "batch") mode = READS_ROWS.test(this.#sql) ? "all" : "run";
    const statement = this.#sqlite.prepare(this.#sql);
    const expected = parameterCount(this.#sql);
    if (expected !== this.#params.length) {
      throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query (expected ${expected}, got ${this.#params.length})`);
    }
    if (mode === "first") return plain(statement.get(...this.#params));
    if (mode === "all") {
      const results = statement.all(...this.#params).map(plain);
      return {
        results,
        success: true,
        meta: { duration: 0, changes: 0, last_row_id: 0, changed_db: false, rows_read: results.length, rows_written: 0 },
      };
    }
    const { changes, lastInsertRowid } = statement.run(...this.#params);
    return {
      success: true,
      meta: {
        duration: 0,
        changes: Number(changes),
        last_row_id: Number(lastInsertRowid),
        changed_db: Number(changes) > 0,
        rows_read: 0,
        rows_written: Number(changes),
      },
    };
  }

  // D1's first(column) returns that column of the first row.
  async first(column) {
    const row = this[EXECUTE]("first");
    if (column === undefined || row === null) return row;
    if (!Object.hasOwn(row, column)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found: ${column}`);
    return row[column];
  }

  async all() {
    return this[EXECUTE]("all");
  }

  async run() {
    return this[EXECUTE]("run");
  }
}

class D1Database {
  #sqlite;

  constructor(sqlite) {
    this.#sqlite = sqlite;
  }

  prepare(sql) {
    return new D1PreparedStatement(this.#sqlite, sql);
  }

  // One transaction for the whole list: either every statement lands or none
  // does, and the error that stopped it is rethrown.
  async batch(statements) {
    this.#sqlite.exec("BEGIN");
    try {
      const results = statements.map((s) => s[EXECUTE]("batch"));
      this.#sqlite.exec("COMMIT");
      return results;
    } catch (err) {
      this.#sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}
