// Structural validation for a character body bound for (or arriving from)
// shared party storage. The Worker runs it on every PUT and the client runs it
// on every remote body before trusting it, so it imports nothing: no engine.js,
// no data.js, no DOM or Node APIs. It checks shape and size only — whether a
// path or spell name exists is the rules engine's business, and compute()
// already tolerates orphaned names.
//
// The field list mirrors engine.js newCharacter(); a test pins the two
// together so neither can drift without the other noticing.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Shared validation").

// The Worker refuses request bodies larger than this (413) before parsing, so
// the validator never sees one. Exported here so both sides share one number.
export const MAX_BODY_BYTES = 65536;

// A character's JSON in UTF-8 bytes. The PUT wraps it as {baseRev, character},
// so this leaves room for that: a character that passes validation always
// fits in a request (notes in a script of 2-4 bytes per character could
// otherwise pass the length caps and meet a 413 on every upload).
export const MAX_CHARACTER_BYTES = MAX_BODY_BYTES - 1024;

// Field caps, in UTF-16 code units (String#length). Each is far above
// anything the app writes — the longest catalog string is ~50 characters and
// slot ids ~40 — so they only ever stop junk.
export const MAX_ID_LENGTH = 100;        // character id, inventory item ids
export const MAX_NAME_LENGTH = 200;      // name, ancestry, paths, spell keys, object keys
export const MAX_TEXT_LENGTH = 5000;     // coins, item fields, strings inside decisions/log
export const MAX_NOTES_LENGTH = 50000;   // the free-prose notes field
export const MAX_INVENTORY_ITEMS = 500;
export const MAX_ITEM_FIELDS = 64;       // keys on one inventory item
export const MAX_LOG_ENTRIES = 1000;
export const MAX_DECISION_KEYS = 2000;
export const MAX_LIST_LENGTH = 1000;     // exchanges, wishlist, expended, nested arrays/objects
// Nesting depth for decisions and log: the field itself is depth 1, a
// container directly inside it depth 2, and so on. Real decisions reach 3
// ({slot: {attrs: ["will"]}}).
export const MAX_DEPTH = 8;
// A 422 lists at most this many problems, so a junk body cannot balloon the
// response.
export const MAX_ERRORS = 20;

const MASTER_MODES = new Set(["master", "second-expert"]);

// Object.hasOwn is newer than some browsers this app otherwise runs in.
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Keys and junk values get echoed into error messages; keep those short.
const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const keyPath = (base, key) => `${base}[${JSON.stringify(clip(key))}]`;

// --- reusable checks -------------------------------------------------------
// Each check is (value, path, fail) and reports through fail(path, message).

const string = (max, { nonEmpty = false } = {}) => (v, path, fail) => {
  if (typeof v !== "string") return fail(path, "must be a string");
  if (nonEmpty && !v.length) return fail(path, "must not be empty");
  if (v.length > max) fail(path, `must be at most ${max} characters`);
};

const stringOrNull = (max) => {
  const str = string(max);
  return (v, path, fail) => (v === null ? undefined : str(v, path, fail));
};

const integer = (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => (v, path, fail) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    const range = min > -Number.MAX_SAFE_INTEGER && max < Number.MAX_SAFE_INTEGER ? ` from ${min} to ${max}`
      : min > -Number.MAX_SAFE_INTEGER ? ` ≥ ${min}`
      : "";
    fail(path, `must be an integer${range}`);
  }
};

const plainObject = (v, path, fail) => {
  if (isPlainObject(v)) return true;
  fail(path, "must be an object");
  return false;
};

// Objects with a fixed shape ({from, to}, {drop, gain}, {name, tradition}).
function exactKeys(v, keys, path, fail) {
  if (!plainObject(v, path, fail)) return false;
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) fail(keyPath(path, k), "is not an allowed field");
  }
  return true;
}

// Object keys that land as own properties via JSON.parse but turn into a
// prototype swap if a later Object.assign copies them.
function checkKey(key, path, fail) {
  if (key === "__proto__") return fail(path, "uses a reserved key");
  if (key.length > MAX_NAME_LENGTH) fail(path, `key must be at most ${MAX_NAME_LENGTH} characters`);
}

// Any JSON value, bounded in depth, breadth and string length. `depth` is the
// depth of `v` itself (see MAX_DEPTH).
function checkJson(v, path, depth, fail) {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) fail(path, "must be a finite number");
    return;
  }
  if (typeof v === "string") {
    if (v.length > MAX_TEXT_LENGTH) fail(path, `must be at most ${MAX_TEXT_LENGTH} characters`);
    return;
  }
  const isArray = Array.isArray(v);
  if (!isArray && !isPlainObject(v)) return fail(path, "must be a JSON value");
  if (depth > MAX_DEPTH) return fail(path, `nests deeper than ${MAX_DEPTH} levels`);
  if (isArray) {
    if (v.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} entries`);
    v.forEach((x, i) => checkJson(x, `${path}[${i}]`, depth + 1, fail));
    return;
  }
  const keys = Object.keys(v);
  if (keys.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} keys`);
  for (const k of keys) {
    const p = keyPath(path, k);
    checkKey(k, p, fail);
    checkJson(v[k], p, depth + 1, fail);
  }
}

// --- field-specific checks -------------------------------------------------

function checkAttributeSwap(v, path, fail) {
  if (v === null) return;
  // builder.js stores whichever dropdowns are set, so either may be "".
  if (!exactKeys(v, ["from", "to"], path, fail)) return;
  string(MAX_NAME_LENGTH)(v.from, `${path}.from`, fail);
  string(MAX_NAME_LENGTH)(v.to, `${path}.to`, fail);
}

// One slot's resolution, as builder.js writes it: {attrs: [..]}, {option},
// {text}, {kind, tradition}, {kind, spell, tradition}, {spell, tradition} or
// {talent}. builder.js reads these unguarded (attrs as an array of strings),
// so their types are pinned; any other key may hold any bounded JSON value.
const DECISION_FIELDS = {
  attrs: (v, path, fail) => {
    if (!Array.isArray(v)) return fail(path, "must be an array");
    if (v.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} entries`);
    v.forEach((x, i) => string(MAX_NAME_LENGTH)(x, `${path}[${i}]`, fail));
  },
  option: integer(0),
  text: string(MAX_TEXT_LENGTH),
  kind: string(MAX_TEXT_LENGTH),
  spell: string(MAX_TEXT_LENGTH),
  tradition: string(MAX_TEXT_LENGTH),
  talent: string(MAX_TEXT_LENGTH),
};

// `v` sits at depth 2 (see MAX_DEPTH).
function checkDecision(v, path, fail) {
  if (!plainObject(v, path, fail)) return;
  const keys = Object.keys(v);
  if (keys.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} keys`);
  for (const k of keys) {
    const p = keyPath(path, k);
    checkKey(k, p, fail);
    if (hasOwn(DECISION_FIELDS, k)) DECISION_FIELDS[k](v[k], p, fail);
    else checkJson(v[k], p, 3, fail);
  }
}

// For state.js normalizeCharacter: drop a slot value validation would refuse.
export function isValidDecision(v) {
  let ok = true;
  checkDecision(v, "decision", () => { ok = false; });
  return ok;
}

function checkDecisions(v, path, fail) {
  if (!plainObject(v, path, fail)) return;
  const keys = Object.keys(v);
  if (keys.length > MAX_DECISION_KEYS) return fail(path, `must have at most ${MAX_DECISION_KEYS} keys`);
  for (const k of keys) {
    const p = keyPath(path, k);
    checkKey(k, p, fail);
    checkDecision(v[k], p, fail);
  }
}

// [{drop: {name, tradition}, gain: {name, tradition}}] — compute() reads
// ex.drop.name unguarded, so `[{}]` must not get through.
function checkExchanges(v, path, fail) {
  if (!Array.isArray(v)) return fail(path, "must be an array");
  if (v.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} entries`);
  v.forEach((ex, i) => {
    const p = `${path}[${i}]`;
    if (!exactKeys(ex, ["drop", "gain"], p, fail)) return;
    for (const side of ["drop", "gain"]) {
      const sp = `${p}.${side}`;
      if (!exactKeys(ex[side], ["name", "tradition"], sp, fail)) continue;
      string(MAX_NAME_LENGTH)(ex[side].name, `${sp}.name`, fail);
      string(MAX_NAME_LENGTH)(ex[side].tradition, `${sp}.tradition`, fail);
    }
  });
}

function checkWishlist(v, path, fail) {
  if (!Array.isArray(v)) return fail(path, "must be an array");
  if (v.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} entries`);
  v.forEach((k, i) => string(MAX_NAME_LENGTH)(k, `${path}[${i}]`, fail));
}

// Spell key -> castings used.
function checkExpended(v, path, fail) {
  if (!plainObject(v, path, fail)) return;
  const keys = Object.keys(v);
  if (keys.length > MAX_LIST_LENGTH) return fail(path, `must have at most ${MAX_LIST_LENGTH} keys`);
  for (const k of keys) {
    const p = keyPath(path, k);
    checkKey(k, p, fail);
    integer(0)(v[k], p, fail);
  }
}

// gear.js stores {id, name, qty} plus, for catalog weapons and armor, copies
// of the catalog's string fields (damage, hands, properties, defense, type),
// `requirement` as a string or null, and `weapon`/`armor: true`; the table
// adds `equipped` and `notes`. Rather than allowlist those, any other field
// may hold a primitive — the engine reads them through String(…).
const ITEM_FIELDS = {
  id: string(MAX_ID_LENGTH, { nonEmpty: true }),
  name: string(MAX_TEXT_LENGTH),
};
const ITEM_OPTIONAL = {
  qty: integer(1),
  equipped: (v, path, fail) => {
    if (typeof v !== "boolean") fail(path, "must be true or false");
  },
  notes: string(MAX_TEXT_LENGTH),
};

function checkItemPrimitive(v, path, fail) {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) fail(path, "must be a finite number");
    return;
  }
  if (typeof v === "string") return string(MAX_TEXT_LENGTH)(v, path, fail);
  fail(path, "must be a string, number, boolean or null");
}

function checkInventory(v, path, fail) {
  if (!Array.isArray(v)) return fail(path, "must be an array");
  if (v.length > MAX_INVENTORY_ITEMS) return fail(path, `must have at most ${MAX_INVENTORY_ITEMS} items`);
  v.forEach((it, i) => {
    const p = `${path}[${i}]`;
    if (!plainObject(it, p, fail)) return;
    const keys = Object.keys(it);
    if (keys.length > MAX_ITEM_FIELDS) return fail(p, `must have at most ${MAX_ITEM_FIELDS} fields`);
    for (const [k, check] of Object.entries(ITEM_FIELDS)) {
      if (!hasOwn(it, k)) fail(`${p}.${k}`, "is missing");
      else check(it[k], `${p}.${k}`, fail);
    }
    for (const k of keys) {
      if (hasOwn(ITEM_FIELDS, k)) continue;
      const kp = hasOwn(ITEM_OPTIONAL, k) ? `${p}.${k}` : keyPath(p, k);
      checkKey(k, kp, fail);
      (hasOwn(ITEM_OPTIONAL, k) ? ITEM_OPTIONAL[k] : checkItemPrimitive)(it[k], kp, fail);
    }
  });
}

function checkLog(v, path, fail) {
  if (!Array.isArray(v)) return fail(path, "must be an array");
  if (v.length > MAX_LOG_ENTRIES) return fail(path, `must have at most ${MAX_LOG_ENTRIES} entries`);
  v.forEach((x, i) => checkJson(x, `${path}[${i}]`, 2, fail));
}

// --- the character ---------------------------------------------------------
// Same keys, same order, as newCharacter().

const FIELDS = {
  version: (v, path, fail) => {
    if (v !== 2) fail(path, "must be 2");
  },
  id: string(MAX_ID_LENGTH, { nonEmpty: true }),
  name: string(MAX_NAME_LENGTH),
  ancestry: string(MAX_NAME_LENGTH),
  level: integer(0, 10),
  novicePath: stringOrNull(MAX_NAME_LENGTH),
  expertPath: stringOrNull(MAX_NAME_LENGTH),
  masterMode: (v, path, fail) => {
    if (!MASTER_MODES.has(v)) fail(path, `must be "master" or "second-expert"`);
  },
  masterPath: stringOrNull(MAX_NAME_LENGTH),
  secondExpertPath: stringOrNull(MAX_NAME_LENGTH),
  religion: stringOrNull(MAX_NAME_LENGTH),
  attributeSwap: checkAttributeSwap,
  sizeChoice: stringOrNull(MAX_NAME_LENGTH),
  decisions: checkDecisions,
  exchanges: checkExchanges,
  wishlist: checkWishlist,
  damage: integer(0),
  bonusHealth: integer(0),
  insanityAdjust: integer(),
  corruptionAdjust: integer(),
  fateDice: integer(0),
  expended: checkExpended,
  inventory: checkInventory,
  coins: string(MAX_TEXT_LENGTH),
  notes: string(MAX_NOTES_LENGTH),
  log: checkLog,
};

// Present-but-optional: exports and share links stamp the data revision.
const OPTIONAL = {
  dataRev: string(MAX_NAME_LENGTH),
};

// Character fields added after party sync shipped. Bodies stored before the
// field existed, and uploads from a tab still running the older app, lack
// them; normalizeCharacter() fills them in. Present, they are checked like
// any other field. Add a field here whenever one is added to FIELDS.
const ADDED_LATER = new Set(["bonusHealth"]);

export const CHARACTER_KEYS = Object.freeze(Object.keys(FIELDS));
export const OPTIONAL_KEYS = Object.freeze(Object.keys(OPTIONAL));
export const ADDED_LATER_KEYS = Object.freeze([...ADDED_LATER]);

export function validateCharacter(obj) {
  const errors = [];
  let dropped = 0;
  const fail = (path, message) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path} ${message}`);
    else dropped++;
  };

  if (!isPlainObject(obj)) {
    return { ok: false, errors: ["character must be a JSON object"] };
  }
  for (const k of Object.keys(obj)) {
    if (!hasOwn(FIELDS, k) && !hasOwn(OPTIONAL, k)) {
      fail(JSON.stringify(clip(k)), "is not a character field");
    }
  }
  for (const [k, check] of Object.entries(FIELDS)) {
    if (hasOwn(obj, k)) check(obj[k], k, fail);
    else if (!ADDED_LATER.has(k)) fail(k, "is missing");
  }
  for (const [k, check] of Object.entries(OPTIONAL)) {
    if (hasOwn(obj, k)) check(obj[k], k, fail);
  }

  if (!errors.length) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj)).length;
    if (bytes > MAX_CHARACTER_BYTES) {
      fail("character", `is ${bytes} bytes as JSON; at most ${MAX_CHARACTER_BYTES} fit in an upload (shorten the notes)`);
    }
  }

  if (dropped) errors.push(`…and ${dropped} more`);
  return { ok: errors.length === 0, errors };
}
