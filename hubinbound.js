// hubinbound.js — hub -> v1: the signed /internal/v1 calls into v1 (R-14's S0 slice, 1.99acm; the chat design §1.7 "Calls
// into v1", §16; seam plan §2.5, D-15 .. D-17).
//
//   GET  /internal/v1/snapshot/<topic>?cursor=     one page of the topic's current state (huboutbox.snapshot) - the hub's
//                                                  bootstrap and 10-minute repair pull. 404 while the topic's switch is off.
//   POST /internal/v1/outbox/rewind {topic, after_id}   kept hub_outbox rows of the topic above after_id are posted again
//                                                  (huboutbox.rewind) - the promotion runbook (§15.4)
//   POST /internal/v1/looks {ids, card?}           1.99ads (S1 Q5b, seam plan §12.7): the structured looks of up to 450 hub
//                                                  account ids (hublooks.call -> {v, items, missing}); 404 while the looks
//                                                  switch is off, 400 a malformed body or id, 413 over 450 ids
//
// Every request is HMAC-signed by the hub (hubsign.verifyFrom): key ids "hub-<env>-<n>" only (this site's env, HUB_V1_ENV),
// the current key HUB_V1_IN_KEY_ID / HUB_V1_IN_KEY and, during a rotation, HUB_V1_IN_PREV_KEY_ID / HUB_V1_IN_PREV_KEY. The
// signature covers the key id, the raw request target (req.originalUrl, path + query exactly as sent - seam plan D-16) and
// the raw body (parsed here, never by the site's JSON parser: index.js leaves /internal/ alone). Without a valid inbound key
// the routes don't exist (404). Refusals: missing / unknown_key / wrong_env / stale / bad_sig 401, replay 409, busy 503 +
// Retry-After; the answer never says more than the code. Answers are Cache-Control: no-store. Logs carry route, code and
// counts only - never a row.
//
// The hub reaches these routes over the tailnet (tailscale serve); the public nginx must answer 404 for /internal/
// (case-insensitively - deploy/README.md has the rule and the check). Defence in depth here, before anything is parsed or
// verified, with no log line: a target that doesn't start exactly (case-sensitively) with /internal/v1/ is a plain 404 (Express
// mounts are case-insensitive, so /Internal/v1/... would otherwise reach the verifier), and so is any request carrying
// Cloudflare's cf-ray / cf-connecting-ip headers (Cloudflare adds them; tailscale serve never does) - counted once as
// `public` on /admin/keys#seam, which then says the nginx rule is missing. Refusal warnings are rate-limited to one line per
// code per minute (the counters keep the totals).
//
// Replays (§16: a 10-minute nonce cache on every /internal request): hubsign's in-memory cache is the fast path; every
// verified request's nonce is also taken durably, INSERT-first, in hub_inbound_nonces (key_id, nonce, until = the later of
// now and its timestamp + 10 minutes) - inside the rewind's own transaction, and before a snapshot page is served - so a
// v1 restart or deploy doesn't reopen the window. huboutbox.cleanup() sweeps expired rows.
"use strict";
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const LIMIT = "64kb";
const ROUTES = ["snapshot", "rewind", "looks"];
const PREFIX = "/internal/v1/";
const NONCE_KEEP_MS = 10 * 60 * 1000;
const WARN_EVERY_MS = 60 * 1000;
const last = {};                       // route -> {at, status, code}
const refused = {};                    // code -> count
const warned = new Map();              // code -> when its last warning was written

let clock = () => Date.now();
const now = () => clock();

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS hub_inbound_nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, until INTEGER NOT NULL,
                      PRIMARY KEY (key_id, nonce))`)
      .then(() => runQuery("CREATE INDEX IF NOT EXISTS hub_inbound_nonces_until ON hub_inbound_nonces (until)"))
      .then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Take a verified request's nonce durably (INSERT-first; an expired row is taken over). -> false = a replay. */
async function takeNonce(keyId, nonce, tsS) {
  const t = now();
  const until = Math.max(t, Number(tsS) * 1000 || 0) + NONCE_KEEP_MS;
  const r = await runQuery(`INSERT INTO hub_inbound_nonces (key_id, nonce, until) VALUES (?, ?, ?)
                            ON CONFLICT(key_id, nonce) DO UPDATE SET until = excluded.until WHERE hub_inbound_nonces.until <= ?`,
                           [String(keyId), String(nonce).toLowerCase(), until, t]);
  return !!(r && r.changes);
}
/** Expired nonces go (huboutbox.cleanup, hourly). */
async function cleanup() {
  await init();
  const r = await runQuery("DELETE FROM hub_inbound_nonces WHERE until <= ?", [now()]);
  return (r && r.changes) || 0;
}

const env = () => require("./huboutbox").hubEnv();
/** The inbound keys {id: key} (current + previous), only ids of direction hub for this env. */
function keys() {
  const S = require("./hubsign");
  const e = env();
  const out = {};
  for (const [idVar, keyVar] of [["HUB_V1_IN_KEY_ID", "HUB_V1_IN_KEY"], ["HUB_V1_IN_PREV_KEY_ID", "HUB_V1_IN_PREV_KEY"]]) {
    const id = String(process.env[idVar] || "").trim(), key = String(process.env[keyVar] || "");
    if (id && key && e && S.keyIdOk(id, "hub", e)) out[id] = key;
  }
  return out;
}
/** Is the current inbound key configured and of the right shape? */
function configured() {
  const id = String(process.env.HUB_V1_IN_KEY_ID || "").trim();
  return !!id && Object.prototype.hasOwnProperty.call(keys(), id);
}

function note(route, status, code) {
  if (ROUTES.includes(route)) last[route] = { at: now(), status, code: code || null };
  if (code) refused[code] = (refused[code] || 0) + 1;
}
/** At most one warning line per code per minute. */
function warn(code, line) {
  const t = now();
  const w = warned.get(code);
  if (w != null && t - w < WARN_EVERY_MS) return;
  warned.set(code, t);
  console.warn(line);
}

const STATUS = { missing: 401, unknown_key: 401, wrong_env: 401, stale: 401, bad_sig: 401, replay: 409, busy: 503 };
const fromPublic = (req) => !!(req.get("cf-ray") || req.get("cf-connecting-ip"));

function handler() {
  const raw = express.raw({ type: () => true, limit: LIMIT });
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // never through the public edge, and only the exact lowercase prefix: a plain 404, nothing logged or parsed
    if (!String(req.originalUrl || "").startsWith(PREFIX)) return res.status(404).end();
    if (fromPublic(req)) { refused.public = (refused.public || 0) + 1; return res.status(404).end(); }
    if (!configured()) return res.status(404).json({ ok: false, error: "not_found" });
    raw(req, res, (err) => {
      if (err) {
        const code = err.type === "entity.too.large" ? "too_large" : "bad_body";
        note(null, err.status || 400, code);
        return res.status(err.type === "entity.too.large" ? 413 : 400).json({ ok: false, error: code });
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const v = require("./hubsign").verifyFrom({ dir: "hub", env: env(), method: req.method, path: req.originalUrl, body,
                                                  headers: (n) => req.get(n), keys: keys(), now: now() });
      let u;
      try { u = new URL(req.originalUrl, "http://v1.invalid"); } catch (e) { u = null; }
      const route = u && u.pathname.startsWith("/internal/v1/snapshot/") ? "snapshot" : u && u.pathname === "/internal/v1/outbox/rewind" ? "rewind"
        : u && u.pathname === "/internal/v1/looks" ? "looks" : null;
      if (!v.ok) {
        const status = STATUS[v.error] || 401;
        note(route, status, v.error);
        if (status === 503) res.set("Retry-After", "2");
        warn(v.error, `[hubinbound] ${req.method} ${route || "other"} refused: ${v.error} (at most one line per code per minute)`);
        return res.status(status).json({ ok: false, error: v.error });
      }
      const claim = { keyId: v.keyId, nonce: req.get("X-PATV-Nonce"), ts: req.get("X-PATV-Ts") };
      serve(route, req, res, u, body, claim).catch((e) => {
        const status = e && e.status ? e.status : 500;
        note(route, status, e && e.code ? e.code : "internal");
        if (status >= 500) console.error(`[hubinbound] ${route}:`, e && e.message);
        if (status === 503) res.set("Retry-After", "2");
        res.status(status).json({ ok: false, error: e && e.code ? e.code : "internal" });
      });
    });
  };
}

const replay = () => Object.assign(new Error("replay"), { status: 409, code: "replay" });

async function serve(route, req, res, u, body, claim) {
  const ho = require("./huboutbox");
  await init();                                           // (never inside the rewind's transaction)
  if (route === "snapshot" && req.method === "GET") {
    if (!(await takeNonce(claim.keyId, claim.nonce, claim.ts))) throw replay();
    const topic = u.pathname.slice("/internal/v1/snapshot/".length);      // topics keep their slash (snapshot/privacy/changed)
    const page = await ho.snapshot(topic, u.searchParams.get("cursor"));
    if (!page) { note(route, 404, "topic_off"); return res.status(404).json({ ok: false, error: "not_found" }); }
    note(route, 200, null);
    console.log(`[hubinbound] snapshot ${topic}: ${page.rows.length} row(s)${page.complete ? ", complete" : ""}`);
    return res.json(page);
  }
  if (route === "rewind" && req.method === "POST") {
    let b;
    try { b = JSON.parse(body.toString("utf8") || "{}"); } catch (e) { throw Object.assign(new Error("bad json"), { status: 400, code: "bad_body" }); }
    // the nonce is taken in the rewind's own transaction: a rewind that fails leaves no nonce behind
    const r = await ho.rewind(String((b && b.topic) || ""), b ? b.after_id : null, {
      guard: async () => { if (!(await takeNonce(claim.keyId, claim.nonce, claim.ts))) throw replay(); },
    });
    note(route, 200, null);
    console.log(`[hubinbound] rewind ${b.topic} after ${b.after_id}: ${r.reposted} row(s) to post again`);
    return res.json(r);
  }
  if (route === "looks" && req.method === "POST") {
    if (!(await takeNonce(claim.keyId, claim.nonce, claim.ts))) throw replay();
    if (!ho.on("looks")) { note(route, 404, "looks_off"); return res.status(404).json({ ok: false, error: "not_found" }); }   // like an unknown path
    let b;
    try { b = JSON.parse(body.toString("utf8")); } catch (e) { note(route, 400, "bad_body"); return res.status(400).json({ ok: false, error: "bad_body" }); }
    const r = await require("./hublooks").call(b);
    note(route, r.status, r.status === 200 ? null : r.body.error);
    if (r.status === 200) console.log(`[hubinbound] looks: ${r.body.items.length} item(s), ${r.body.missing.length} missing`);
    return res.status(r.status).json(r.body);
  }
  note(null, 404, "no_route");
  return res.status(404).json({ ok: false, error: "not_found" });
}

/** index.js: mounts /internal/v1 (before the site's 404; the JSON parser skips /internal/). */
function register(app) {
  init().catch((e) => console.error("[hubinbound] init:", e.message));
  app.use("/internal/v1", handler());
}

/** For /admin/keys#seam. */
function status() {
  const id = String(process.env.HUB_V1_IN_KEY_ID || "").trim();
  const e = env();
  return { configured: configured(), key_id: id || null, env: e, env_ok: !id || (!!e && require("./hubsign").keyIdOk(id, "hub", e)),
           prev: !!String(process.env.HUB_V1_IN_PREV_KEY_ID || "").trim(), last: { ...last }, refused: { ...refused },
           public_hits: refused.public || 0 };
}

module.exports = { register, status, keys, configured, init, takeNonce, cleanup, NONCE_KEEP_MS,
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _reset: () => { for (const k of Object.keys(last)) delete last[k]; for (const k of Object.keys(refused)) delete refused[k]; warned.clear(); } };
