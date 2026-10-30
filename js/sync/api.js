// HTTP client for the party Worker's /api/* routes. fetch is a parameter so
// node --test can drive it with a fake; nothing here touches the DOM.
//
// Every call resolves to {status, data} for 2xx and 4xx responses — those are
// answers the sync engine acts on (401 revoked, 403 not yours, 409 stale,
// 422 invalid). Anything that means "try again later" throws
// SyncNetworkError instead: no connection, a 5xx, or a 429. `data` is the
// parsed JSON body, or null when the body is empty or not JSON (an HTML error
// page from something in between), so callers check its shape.
//
// See docs/superpowers/specs/2026-10-29-shared-party-storage-design.md
// ("Client sync").

export class SyncNetworkError extends Error {
  // status: the HTTP status, or null when no response arrived at all.
  // retryAfter: seconds from a Retry-After header, or null.
  constructor(message, { status = null, retryAfter = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SyncNetworkError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Retry-After is either delta-seconds or an HTTP date.
function parseRetryAfter(header) {
  if (header == null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

export function createApi({ fetch, token, base = "/api" }) {
  const root = base.replace(/\/+$/, "");
  const charUrl = (id) => `${root}/characters/${encodeURIComponent(id)}`;

  // Not an async function on purpose: fetch() must be called before the
  // first await, so a keepalive request issued from a pagehide handler is
  // already on its way when the page goes.
  function request(method, url, { body, keepalive } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (keepalive !== undefined) init.keepalive = keepalive;
    let pending;
    try {
      pending = Promise.resolve(fetch(url, init));
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then(readResponse, (err) => {
      throw new SyncNetworkError("Could not reach the party server.", { cause: err });
    });
  }

  async function readResponse(res) {
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseRetryAfter(res.headers?.get?.("Retry-After") ?? null);
      const message = res.status === 429
        ? "The party server is busy."
        : `The party server is unavailable (HTTP ${res.status}).`;
      throw new SyncNetworkError(message, { status: res.status, retryAfter });
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      // The connection dropped mid-body: same as never getting an answer.
      throw new SyncNetworkError("The connection to the party server dropped.", { status: res.status, cause: err });
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  return {
    me: () => request("GET", `${root}/me`),
    list: () => request("GET", `${root}/characters`),
    put: (id, baseRev, character, { keepalive = false } = {}) =>
      request("PUT", charUrl(id), { body: { baseRev, character }, keepalive }),
    del: (id, baseRev, { keepalive = false } = {}) =>
      request("DELETE", `${charUrl(id)}?baseRev=${encodeURIComponent(baseRev)}`, { keepalive }),
  };
}
