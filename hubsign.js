// hubsign.js — the per-request HMAC of the v1 seam (R-11 / R-14, 1.99acf; the chat design §16 "Strangler seam").
//
// Every /internal/* request between v1 and the chat hub is signed over the method, path, a timestamp (±60 s), a nonce and the
// body's hash; a nonce cache refuses replays. Keys are per direction and per environment (§1.4), so a staging key fails at
// prod. A nonce is remembered until its timestamp leaves the ±60 s window (after that the timestamp check refuses the request
// anyway); only expired nonces are ever evicted, and a full cache refuses new requests ("busy", answer 503) rather than
// forgetting live nonces. This cache is memory-only (a fast path); 1.99acm: the inbound routes (hubinbound.js) also take each
// nonce durably in SQLite (hub_inbound_nonces, 10 minutes - the hub's rule), so a restart doesn't reopen the window. v1's
// outbound key is HUB_V1_KEY (its id HUB_V1_KEY_ID); it is never logged.
//
//   X-PATV-Key-Id   the key's id
//   X-PATV-Ts       unix seconds
//   X-PATV-Nonce    16 random bytes, hex
//   X-PATV-Sig      v1=<hex HMAC-SHA256(key, keyId "\n" METHOD "\n" path "\n" ts "\n" nonce "\n" hex(sha256(body)))>
// path = the request path with its query string; body = the exact bytes sent ("" for none). 1.99acm: the key id leads the
// signed string, so a captured request can't be relabelled with another id that shares its secret (staging and prod, or the
// two directions, if an operator ever reused one - huboutbox.refusal also refuses that reuse locally: key_reuse). verify() is exported for R-14's
// inbound side. docs/chat-tickets.md has the contract; the shared test vectors (test/fixtures/hubseam-sign-vectors.json,
// byte-identical in the hub repo) prove the two implementations agree.
//
// 1.99acm (R-14, seam plan D-15): key ids carry their direction and environment - "v1-<env>-<n>" signs v1 -> hub,
// "hub-<env>-<n>" signs hub -> v1 - and a receiver accepts only its own inbound direction for its own environment:
// verifyFrom() refuses anything else as wrong_env before it looks the key up, so a staging key or a key of the other
// direction fails even if a proxy were miswired. Refusal order: missing, wrong_env, unknown_key, stale, missing (nonce
// format), bad_sig, replay, busy.
"use strict";
const crypto = require("crypto");

const SKEW_S = 60;
const NONCE_MARGIN_MS = 5 * 1000;
const NONCE_MS = 2 * SKEW_S * 1000 + NONCE_MARGIN_MS;   // the longest a nonce can matter (ts may be 60 s ahead of the receiver)
let MAX_NONCES = 100000;
const HEADERS = { id: "X-PATV-Key-Id", ts: "X-PATV-Ts", nonce: "X-PATV-Nonce", sig: "X-PATV-Sig" };

const bodyHash = (body) => crypto.createHash("sha256").update(body == null ? "" : Buffer.isBuffer(body) ? body : String(body)).digest("hex");
function base({ keyId, method, path, ts, nonce, body }) {
  return [String(keyId || ""), String(method || "GET").toUpperCase(), String(path || "/"), String(ts), String(nonce), bodyHash(body)].join("\n");
}
function mac(key, s) { return crypto.createHmac("sha256", Buffer.isBuffer(key) ? key : String(key)).update(s).digest("hex"); }

/** -> the four headers. key: HUB_V1_KEY's value (a string or Buffer). ts / nonce default to now / 16 random bytes. */
function sign({ method, path, body = "", keyId, key, ts, nonce }) {
  if (!key) throw new Error("hubsign: no key");
  const t = ts == null ? Math.floor(Date.now() / 1000) : Math.floor(Number(ts));
  const n = nonce || crypto.randomBytes(16).toString("hex");
  return { [HEADERS.id]: String(keyId || ""), [HEADERS.ts]: String(t), [HEADERS.nonce]: n,
           [HEADERS.sig]: "v1=" + mac(key, base({ keyId, method, path, ts: t, nonce: n, body })) };
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
  const want = Buffer.from("v1=" + mac(key, base({ keyId, method, path, ts: t, nonce, body })));
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

// ── direction + environment (1.99acm, D-15) ──
const KEY_ID_RE = /^(v1|hub)-([a-z]+)-([A-Za-z0-9]{1,16})$/;
const ENVS = ["prod", "staging", "test", "dev"];
/** Is `id` a key id of direction `dir` ("v1" | "hub") for environment `env`? */
const keyIdOk = (id, dir, env) => { const m = KEY_ID_RE.exec(String(id || "")); return !!m && m[1] === dir && m[2] === String(env); };

/**
 * verify() for a receiver that accepts direction `dir` in environment `env` only. A key id shaped like a seam key id but of
 * the other direction or another environment -> wrong_env (before the key lookup); any other unknown id -> unknown_key.
 */
function verifyFrom({ dir, env, method, path, body = "", headers, keys, now = Date.now() }) {
  const get = typeof headers === "function" ? headers : (n) => {
    const h = headers || {};
    const k = Object.keys(h).find((x) => x.toLowerCase() === n.toLowerCase());
    return k ? h[k] : undefined;
  };
  if (!get(HEADERS.id) || !get(HEADERS.ts) || !get(HEADERS.nonce) || !get(HEADERS.sig)) return { ok: false, error: "missing" };
  const m = KEY_ID_RE.exec(String(get(HEADERS.id)));
  if (m && (m[1] !== dir || m[2] !== String(env))) return { ok: false, error: "wrong_env" };
  return verify({ method, path, body, headers: get, keys, now });
}

module.exports = { sign, verify, verifyFrom, keyIdOk, KEY_ID_RE, ENVS, bodyHash, HEADERS, SKEW_S, NONCE_MS, _base: base, _reset: () => seen.clear(), _size: () => seen.size,
                   _setMax: (n) => { MAX_NONCES = n == null ? 100000 : n; } };
