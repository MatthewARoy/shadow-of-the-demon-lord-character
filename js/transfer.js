// Roster transfer codes: every character on this device in one pasteable
// string, for moving a roster to another copy of the app (another site or
// device). Copy and paste is the carrier on purpose — a link between two
// copies would have to name the other's address in code. Pure functions over
// js/share.js's gzip + base64url, so node --test exercises them directly.

import { encodeShare, decodeShare } from "./share.js";

// base64url never contains ":", so the prefix cannot be part of a payload.
const PREFIX = "roster1:";
const KIND = "sotdl-roster";

export async function encodeTransfer(characters, dataRev = null) {
  const envelope = { kind: KIND, v: 1, characters };
  if (typeof dataRev === "string") envelope.dataRev = dataRev;
  return PREFIX + (await encodeShare(envelope));
}

// → {characters, dataRev}. Also accepts a single-character share link (or its
// bare #c= payload), so whatever a player has to hand works. Whitespace is
// ignored: chat apps and notes wrap long strings.
export async function decodeTransfer(text) {
  const compact = String(text ?? "").replace(/\s+/g, "");
  if (!compact) throw new Error("Nothing was pasted.");
  const share = compact.match(/#c=([A-Za-z0-9_-]+)$/);
  const payload = compact.startsWith(PREFIX) ? compact.slice(PREFIX.length) : (share ? share[1] : compact);
  let data;
  try {
    data = JSON.parse(await decodeShare(payload));
  } catch {
    throw new Error("That isn't a transfer code. Copy it again with ⋯ → Copy all characters.");
  }
  if (data && data.kind === KIND && Array.isArray(data.characters)) {
    return { characters: data.characters, dataRev: typeof data.dataRev === "string" ? data.dataRev : null };
  }
  // A share link carries one character with its own optional stamp.
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.ancestry === "string") {
    return { characters: [data], dataRev: typeof data.dataRev === "string" ? data.dataRev : null };
  }
  throw new Error("That code holds no characters.");
}
