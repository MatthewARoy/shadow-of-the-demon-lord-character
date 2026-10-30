import test from "node:test";
import assert from "node:assert/strict";
import { createApi, SyncNetworkError } from "../../sync/api.js";

// A fetch that records each call and answers with the next scripted reply:
// {status, body, headers} for a Response, or an Error to reject with.
function fakeFetch(...replies) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (reply instanceof Error) return Promise.reject(reply);
    const body = typeof reply.body === "string" ? reply.body : reply.body === undefined ? null : JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status: reply.status, headers: reply.headers }));
  };
  return { fetch, calls };
}

const ok = (body) => ({ status: 200, body, headers: { "Content-Type": "application/json" } });

test("me() GETs /api/me with the bearer token and resolves {status, data}", async () => {
  const { fetch, calls } = fakeFetch(ok({ id: "m1", name: "Ash" }));
  const res = await createApi({ fetch, token: "tok-123" }).me();
  assert.deepEqual(res, { status: 200, data: { id: "m1", name: "Ash" } });
  assert.equal(calls[0].url, "/api/me");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-123");
  assert.equal(calls[0].init.body, undefined);
  assert.equal("keepalive" in calls[0].init, false);
});

test("list() GETs /api/characters", async () => {
  const payload = { me: { id: "m1", name: "Ash" }, characters: [] };
  const { fetch, calls } = fakeFetch(ok(payload));
  const res = await createApi({ fetch, token: "t" }).list();
  assert.deepEqual(res, { status: 200, data: payload });
  assert.equal(calls[0].url, "/api/characters");
  assert.equal(calls[0].init.method, "GET");
});

test("put() sends {baseRev, character} as JSON to the encoded id", async () => {
  const { fetch, calls } = fakeFetch(ok({ rev: 4, updatedAt: 1 }));
  const character = { id: "a b/c", name: "Syrah" };
  const res = await createApi({ fetch, token: "t" }).put("a b/c", 3, character);
  assert.deepEqual(res, { status: 200, data: { rev: 4, updatedAt: 1 } });
  assert.equal(calls[0].url, "/api/characters/a%20b%2Fc");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(calls[0].init.body), { baseRev: 3, character });
  assert.equal(calls[0].init.keepalive, false);
});

test("del() sends DELETE with baseRev in the query", async () => {
  const { fetch, calls } = fakeFetch(ok({ rev: 6 }));
  const res = await createApi({ fetch, token: "t" }).del("c-1", 5);
  assert.deepEqual(res, { status: 200, data: { rev: 6 } });
  assert.equal(calls[0].url, "/api/characters/c-1?baseRev=5");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.body, undefined);
});

test("keepalive is passed through to fetch on put and del", async () => {
  const { fetch, calls } = fakeFetch(ok({ rev: 1 }));
  const api = createApi({ fetch, token: "t" });
  await api.put("c-1", 0, { id: "c-1" }, { keepalive: true });
  await api.del("c-1", 1, { keepalive: true });
  assert.equal(calls[0].init.keepalive, true);
  assert.equal(calls[1].init.keepalive, true);
});

test("fetch is called synchronously, before the first await (pagehide safety)", () => {
  const { fetch, calls } = fakeFetch(ok({ rev: 1 }));
  const pending = createApi({ fetch, token: "t" }).put("c-1", 0, { id: "c-1" }, { keepalive: true });
  assert.equal(calls.length, 1);
  return pending;
});

test("a custom base prefixes every route", async () => {
  const { fetch, calls } = fakeFetch(ok({}));
  const api = createApi({ fetch, token: "t", base: "/party/api/" });
  await api.me();
  await api.list();
  await api.put("x", 0, {});
  await api.del("x", 1);
  assert.deepEqual(calls.map((c) => c.url), [
    "/party/api/me", "/party/api/characters", "/party/api/characters/x", "/party/api/characters/x?baseRev=1",
  ]);
});

test("4xx answers resolve with their status and body", async () => {
  for (const [status, body] of [
    [401, { error: "unauthorized" }],
    [403, { error: "not yours" }],
    [404, { error: "not found" }],
    [409, { rev: 7, deleted: false, body: { id: "c-1" } }],
    [413, { error: "too large" }],
    [422, { error: "invalid", errors: ["level must be an integer from 0 to 10"] }],
  ]) {
    const { fetch } = fakeFetch({ status, body });
    assert.deepEqual(await createApi({ fetch, token: "t" }).put("c-1", 1, {}), { status, data: body });
  }
});

test("a body that is empty or not JSON reads as data: null", async () => {
  const html = fakeFetch({ status: 404, body: "<!doctype html><title>Not found</title>" });
  assert.deepEqual(await createApi({ fetch: html.fetch, token: "t" }).me(), { status: 404, data: null });
  const empty = fakeFetch({ status: 200, body: "" });
  assert.deepEqual(await createApi({ fetch: empty.fetch, token: "t" }).me(), { status: 200, data: null });
});

test("5xx throws SyncNetworkError carrying the status", async () => {
  for (const status of [500, 502, 503]) {
    const { fetch } = fakeFetch({ status, body: { error: "D1 unavailable" } });
    await assert.rejects(createApi({ fetch, token: "t" }).list(), (err) => {
      assert.ok(err instanceof SyncNetworkError);
      assert.equal(err.status, status);
      assert.equal(err.retryAfter, null);
      return true;
    });
  }
});

test("429 throws SyncNetworkError with retryAfter seconds from the header", async () => {
  const { fetch } = fakeFetch({ status: 429, body: "slow down", headers: { "Retry-After": "120" } });
  await assert.rejects(createApi({ fetch, token: "t" }).list(), (err) => {
    assert.ok(err instanceof SyncNetworkError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, 120);
    return true;
  });
});

test("Retry-After as an HTTP date becomes seconds from now; absent or junk is null", async () => {
  const soon = new Date(Date.now() + 90_000).toUTCString();
  const dated = fakeFetch({ status: 503, headers: { "Retry-After": soon } });
  await assert.rejects(createApi({ fetch: dated.fetch, token: "t" }).me(), (err) => {
    assert.ok(err.retryAfter > 80 && err.retryAfter <= 90, `retryAfter ${err.retryAfter}`);
    return true;
  });
  const bare = fakeFetch({ status: 429 });
  await assert.rejects(createApi({ fetch: bare.fetch, token: "t" }).me(), (err) => err.retryAfter === null);
  const junk = fakeFetch({ status: 429, headers: { "Retry-After": "soon-ish" } });
  await assert.rejects(createApi({ fetch: junk.fetch, token: "t" }).me(), (err) => err.retryAfter === null);
});

test("a network failure throws SyncNetworkError with no status and the cause attached", async () => {
  const cause = new TypeError("fetch failed");
  const { fetch } = fakeFetch(cause);
  await assert.rejects(createApi({ fetch, token: "t" }).put("c-1", 0, {}), (err) => {
    assert.ok(err instanceof SyncNetworkError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "SyncNetworkError");
    assert.equal(err.status, null);
    assert.equal(err.retryAfter, null);
    assert.equal(err.cause, cause);
    return true;
  });
});

test("a fetch that throws synchronously is still a SyncNetworkError, not a crash", async () => {
  const fetch = () => {
    throw new TypeError("Failed to execute 'fetch'");
  };
  await assert.rejects(createApi({ fetch, token: "t" }).me(), SyncNetworkError);
});
