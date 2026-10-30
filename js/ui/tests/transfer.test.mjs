import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeTransfer, decodeTransfer } from "../../transfer.js";
import { encodeShare } from "../../share.js";

const SAMPLES = JSON.parse(await readFile(new URL("../../../data/samples.json", import.meta.url), "utf8"))
  .map((s, i) => ({ ...s, id: `id-${i}` }));

test("a roster round-trips with its data revision", async () => {
  const code = await encodeTransfer(SAMPLES, "abc123def456");
  assert.match(code, /^roster1:[A-Za-z0-9_-]+$/);
  const out = await decodeTransfer(code);
  assert.deepEqual(out.characters, SAMPLES);
  assert.equal(out.dataRev, "abc123def456");
});

test("the whole shipped sample roster stays a pasteable size", async () => {
  const code = await encodeTransfer(SAMPLES, "abc123def456");
  assert.ok(code.length < 8000, `transfer code is ${code.length} characters`);
});

test("whitespace and line breaks from chat apps are ignored", async () => {
  const code = await encodeTransfer(SAMPLES.slice(0, 2));
  const wrapped = `  ${code.replace(/(.{60})/g, "$1\n")}\n`;
  assert.deepEqual((await decodeTransfer(wrapped)).characters, SAMPLES.slice(0, 2));
});

test("a single-character share link, or its payload, is accepted", async () => {
  const payload = await encodeShare({ ...SAMPLES[0], dataRev: "rev-1" });
  for (const text of [`https://example.test/app/#c=${payload}`, payload]) {
    const out = await decodeTransfer(text);
    assert.equal(out.characters.length, 1);
    assert.equal(out.characters[0].name, SAMPLES[0].name);
    assert.equal(out.dataRev, "rev-1");
  }
});

test("garbage and empty input fail with a readable message", async () => {
  await assert.rejects(decodeTransfer(""), /Nothing was pasted/);
  await assert.rejects(decodeTransfer("   \n "), /Nothing was pasted/);
  for (const bad of ["hello world", "roster1:!!!", "roster1:AAAA", "https://example.test/#invite=abc"]) {
    await assert.rejects(decodeTransfer(bad), /isn't a transfer code/, bad);
  }
});

test("well-formed codes that hold no characters are refused", async () => {
  for (const value of [{ kind: "something-else" }, [1, 2, 3], { kind: "sotdl-roster", characters: "x" }]) {
    await assert.rejects(decodeTransfer(await encodeShare(value)), /holds no characters/);
  }
});
