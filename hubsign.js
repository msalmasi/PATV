// hubsign.js — the per-request HMAC of the v1 seam (R-11 / R-14, 1.99acf; the chat design §16 "Strangler seam").
//
// Every /internal/* request between v1 and the chat hub is signed over the method, path, a timestamp (±60 s), a nonce and the
// body's hash; a nonce cache refuses replays. Keys are per direction and per environment (§1.4), so a staging key fails at
// prod. A nonce is remembered until its timestamp leaves the ±60 s window (after that the timestamp check refuses the request
// anyway); only expired nonces are ever evicted, and a full cache refuses new requests ("busy", answer 503) rather than
// forgetting live nonces. The cache is memory-only: a restart reopens the window for requests captured in the last ~2 min. v1's outbound key is HUB_V1_KEY (its id HUB_V1_KEY_ID); it is never logged.
//
//   X-PATV-Key-Id   the key's id
//   X-PATV-Ts       unix seconds
//   X-PATV-Nonce    16 random bytes, hex
//   X-PATV-Sig      v1=<hex HMAC-SHA256(key, METHOD "\n" path "\n" ts "\n" nonce "\n" hex(sha256(body)))>
// path = the request path with its query string; body = the exact bytes sent ("" for none). verify() is exported for R-14's
// inbound side. docs/chat-tickets.md has the contract and the test vector (test/hubsign.test.js).
"use strict";
const crypto = require("crypto");

const SKEW_S = 60;
const NONCE_MARGIN_MS = 5 * 1000;
const NONCE_MS = 2 * SKEW_S * 1000 + NONCE_MARGIN_MS;   // the longest a nonce can matter (ts may be 60 s ahead of the receiver)
let MAX_NONCES = 100000;
const HEADERS = { id: "X-PATV-Key-Id", ts: "X-PATV-Ts", nonce: "X-PATV-Nonce", sig: "X-PATV-Sig" };

const bodyHash = (body) => crypto.createHash("sha256").update(body == null ? "" : Buffer.isBuffer(body) ? body : String(body)).digest("hex");
function base({ method, path, ts, nonce, body }) {
  return [String(method || "GET").toUpperCase(), String(path || "/"), String(ts), String(nonce), bodyHash(body)].join("\n");
}
function mac(key, s) { return crypto.createHmac("sha256", Buffer.isBuffer(key) ? key : String(key)).update(s).digest("hex"); }

/** -> the four headers. key: HUB_V1_KEY's value (a string or Buffer). ts / nonce default to now / 16 random bytes. */
function sign({ method, path, body = "", keyId, key, ts, nonce }) {
  if (!key) throw new Error("hubsign: no key");
  const t = ts == null ? Math.floor(Date.now() / 1000) : Math.floor(Number(ts));
  const n = nonce || crypto.randomBytes(16).toString("hex");
  return { [HEADERS.id]: String(keyId || ""), [HEADERS.ts]: String(t), [HEADERS.nonce]: n,
           [HEADERS.sig]: "v1=" + mac(key, base({ method, path, ts: t, nonce: n, body })) };
}

const seen = new Map();          // keyId + nonce -> expiry (ms): the request's ts + SKEW_S (+ a margin)
function sweep(t) { for (const [k, until] of seen) if (until <= t) seen.delete(k); }   // only expired entries

/**
 * Check a signed request. headers: a plain object (any case) or a getter fn(name). keys: {keyId: key}. -> {ok, keyId?, error?}
 * error: missing | unknown_key | stale | replay | bad_sig | busy (the nonce cache is full of live nonces: answer 503, retry).
 * A good request's nonce is remembered until its timestamp is out of the window.
 */
function verify({ method, path, body = "", headers, keys, now = Date.now() }) {
  const get = typeof headers === "function" ? headers : (n) => {
    const h = headers || {};
    const k = Object.keys(h).find((x) => x.toLowerCase() === n.toLowerCase());
    return k ? h[k] : undefined;
  };
  const keyId = get(HEADERS.id), ts = get(HEADERS.ts), nonce = get(HEADERS.nonce), sig = get(HEADERS.sig);
  if (!keyId || !ts || !nonce || !sig) return { ok: false, error: "missing" };
  const key = keys && Object.prototype.hasOwnProperty.call(keys, keyId) ? keys[keyId] : null;
  if (!key) return { ok: false, error: "unknown_key" };
  const t = Number(ts);
  if (!/^\d{1,12}$/.test(String(ts)) || Math.abs(Math.floor(now / 1000) - t) > SKEW_S) return { ok: false, error: "stale" };
  if (!/^[0-9a-f]{16,64}$/i.test(String(nonce))) return { ok: false, error: "missing" };
  const want = Buffer.from("v1=" + mac(key, base({ method, path, ts: t, nonce, body })));
  const got = Buffer.from(String(sig));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, error: "bad_sig" };
  const nk = keyId + "\u0001" + String(nonce).toLowerCase();
  const live = seen.get(nk);
  if (live != null && live > now) return { ok: false, error: "replay" };
  if (seen.size >= MAX_NONCES) {
    sweep(now);
    if (seen.size >= MAX_NONCES) return { ok: false, error: "busy" };   // never wipe live nonces to make room
  }
  seen.set(nk, Math.max(now, (t + SKEW_S) * 1000) + NONCE_MARGIN_MS);
  return { ok: true, keyId };
}

module.exports = { sign, verify, bodyHash, HEADERS, SKEW_S, NONCE_MS, _base: base, _reset: () => seen.clear(), _size: () => seen.size,
                   _setMax: (n) => { MAX_NONCES = n == null ? 100000 : n; } };
