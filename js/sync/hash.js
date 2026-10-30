// Content hashes for party sync. The planner compares a hash of a live roster
// object against a hash of a JSON-parsed server body, so the canonical form
// must not depend on key order (it drifts after a pull) and must agree with
// what JSON.stringify would put on the wire. Synchronous and dependency-free,
// so it runs the same in the browser, the Worker and node --test.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Client sync").

// JSON.stringify with object keys sorted at every level. Mirrors its rules
// exactly: undefined and function values drop out of objects and become null
// in arrays, non-finite numbers become null, toJSON() is honoured. A value
// that JSON cannot represent at the top level reads as "null".
export function canonicalJson(value) {
  if (value !== null && typeof value === "object" && typeof value.toJSON === "function") {
    return canonicalJson(value.toJSON());
  }
  if (Array.isArray(value)) {
    // Array.from, not map: map skips holes in a sparse array.
    return `[${Array.from(value, (v) => (skipped(v) ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => !skipped(value[k])).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return skipped(value) ? "null" : JSON.stringify(value);
}

const skipped = (v) => v === undefined || typeof v === "function" || typeof v === "symbol";

// cyrb53 (public domain, bryc): a fast 53-bit string hash. Not cryptographic —
// it only has to tell "same content" from "edited", and a collision costs one
// skipped upload that the next edit repairs.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// 14 lowercase hex digits (53 bits), fixed width so stored hashes compare as
// plain strings.
export function hashCharacter(c) {
  return cyrb53(canonicalJson(c)).toString(16).padStart(14, "0");
}
