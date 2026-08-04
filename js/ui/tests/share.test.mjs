import test from "node:test";
import assert from "node:assert/strict";
import { shareSupported, encodeShare, decodeShare, revMismatch } from "../../share.js";

// A realistic character shape (fields mirror engine.js newCharacter()).
const CHARACTER = {
  id: "0000-test", version: 2, name: "Syrah", ancestry: "Changeling",
  level: 1, damage: 0, insanityAdjust: 0, corruptionAdjust: 0,
  decisions: { "creation:prof:0": { pick: 3 }, "novice[Magician]:1:3:0": { pick: 0 } },
  expended: {}, inventory: [{ id: "it-1", name: "Staff", equipped: true }],
  wishlist: [], exchanges: [], log: [], coins: "5 ss", notes: "née “Vesper”\n— naïve",
  sizeChoice: null, dataRev: "abc123def456",
};

test("shareSupported is true where CompressionStream exists (node ≥ 18)", () => {
  assert.equal(shareSupported(), true);
});

test("encode → decode round-trips a character exactly", async () => {
  const payload = await encodeShare(CHARACTER);
  assert.deepEqual(JSON.parse(await decodeShare(payload)), CHARACTER);
});

test("payload uses only base64url characters (URL-fragment safe)", async () => {
  const payload = await encodeShare(CHARACTER);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
});

test("malformed payloads reject with a clean error", async () => {
  for (const bad of [
    "!!!not-base64url!!!",                       // illegal characters
    (await encodeShare(CHARACTER)).slice(0, 10), // truncated mid-stream
    "aGVsbG8",                                   // valid base64url, not gzip
    "",                                          // empty
  ]) {
    await assert.rejects(decodeShare(bad), /damaged or incomplete/);
  }
});

test("revMismatch: true when both stamps are known and disagree", () => {
  assert.equal(revMismatch("abc123", "def456"), true);
});

test("revMismatch: false when stamps are equal", () => {
  assert.equal(revMismatch("abc123", "abc123"), false);
});

test("revMismatch: false when theirs is undefined or null", () => {
  assert.equal(revMismatch(undefined, "abc123"), false);
  assert.equal(revMismatch(null, "abc123"), false);
});

test("revMismatch: false when ours is null", () => {
  assert.equal(revMismatch("abc123", null), false);
});
