// Character share links: gzip + base64url payloads for the URL fragment
// (#c=<payload>). Pure functions with no DOM access so node --test can
// exercise them directly; the same globals exist in browsers and Node ≥ 18.

// btoa/atob work on binary strings, so convert in chunks (spread would
// overflow the argument limit on large arrays; characters are ~1 KB, but
// stay safe).
const CHUNK = 0x8000;

function toBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function shareSupported() {
  return typeof CompressionStream !== "undefined"
    && typeof DecompressionStream !== "undefined";
}

export async function encodeShare(character) {
  const bytes = new TextEncoder().encode(JSON.stringify(character));
  return toBase64url(await pipe(bytes, new CompressionStream("gzip")));
}

// Thrown by decodeShare when the payload inflates past its maxBytes.
export class TooLargeError extends Error {
  constructor() {
    super("That code is too large.");
  }
}

// Inflate chunk by chunk, giving up (and cancelling the rest) as soon as the
// output passes maxBytes: a few KB of gzip can expand to gigabytes.
async function inflate(bytes, maxBytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// maxBytes caps the inflated size (js/transfer.js sets one for pasted codes);
// share links pass none and decode as they always have.
export async function decodeShare(payload, maxBytes = Infinity) {
  let bytes;
  try {
    bytes = await inflate(fromBase64url(payload), maxBytes);
  } catch (err) {
    if (err instanceof TooLargeError) throw err;
    throw new Error("This link’s character data is damaged or incomplete.");
  }
  return new TextDecoder().decode(bytes);
}

// True when both stamps are known and disagree — the "warn the importer"
// case. Missing stamps (old exports, absent revision.json) never warn.
export function revMismatch(theirs, ours) {
  return typeof theirs === "string" && typeof ours === "string" && theirs !== ours;
}
