// botkeys.js — per-caller bot keys: the shared bot token split per caller (R-11, 1.99acf; docs/bot-keys.md).
//
// Six callers shared one secret, the site's TWITCH_BOT_TOKEN (Pepe as the body `password` and X-Bot-Token, the Discord bot,
// the selfbot, the Twitch bot, ops alerts, chattip; the Discord bot also has DISCORD_BOT_TOKEN, which isPlatformBot takes).
// Now each caller can have its own key, sent as
//   X-PATV-Key: <caller>.<secret>          caller ^[a-z][a-z0-9-]{1,31}$, secret = 32 random bytes as base64url (43 chars)
// The middleware below resolves it once per request (argon2id, behind a SHA-256 tag prefilter and a 10-minute cache - when a
// cache entry runs out and nothing changed the key, the row is re-checked instead of running argon2 again) and keeps the
// caller in an AsyncLocalStorage request context - the mechanism dbUtils.tx already uses - so isBotToken() / isPlatformBot()
// (index.js wraps these; ~170 call sites) answer true for a key caller with no call-site edits. With a resolved key the body
// password is ignored.
//
//   observe (every new key, 7 days): every route is allowed; (caller, method, route pattern, route family) is counted in
//            bot_route_log at the end of each request. The observed families become the key's scopes (/admin/keys).
//   enforce: outside the key's scopes the key counts for nothing on that request: it is logged as refused (bot_route_log) with
//            an ops alert (source botkeys-scope, one per caller and family a day) and the request is judged on its legacy
//            credentials, like a request without the header. Once the family's legacy-enforce switch is on (nothing else could
//            authenticate it there) it gets 403 {error:"scope"} before routing (the handler never runs).
//   A request re-entered through app.handle (botupload.js's /api/bot/upload/finish replays the assembled body on its target
//   route) gets a context of its own: each route is logged under its own family and the target's family is scope-checked.
//   legacy:  the shared tokens still work. Every request they authenticate is counted in legacy_token_use {route, caller_hint}
//            (+ a per-day row in legacy_token_daily) - the list of what still has to move. A route family's legacy-enforce
//            switch (bot_key_families) refuses them there. The legacy branch is deleted after 14 days at zero on prod AND
//            staging (a later release).
//
// Settings (bot_keys_settings, /admin/keys): enabled (true: the header is read at all - off = legacy only, the kill switch),
// bad_key (fallback: a header that doesn't resolve is ignored and the request judged on its legacy credentials, counted with
// hint "badkey:<caller>"; refuse: 401 {error:"key"}), events (the /events bus: observe | enforce, eventsauth.js), control_get
// (allow | refuse: the VM supervisor's old GET claim of /api/pepe/control/pending - pepecontrol.js; the claim is a POST since
// the R-11 review, and the GET stays allowed until an owner refuses it here once the route log shows no GET left).
// Alerts never carry a request path, and a header naming a caller that has no row raises none (anyone can send one): a known
// caller's wrong / revoked / expired secret alerts once a day per caller (source botkeys); unknown callers are only counted,
// with at most one summary alert a day (source botkeys-unknown).
//
// Writes stay off the hot path: counters build up in memory and one dbUtils.tx flushes them every 30 s (and when the process
// starts stopping). A crash loses at most 30 s of counts - fine for usage counters. Secrets are returned once by mint / rotate,
// never stored raw, never logged, never put in an error.
"use strict";
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { runQuery, getQuery, tx } = require("./dbUtils");

const als = new AsyncLocalStorage();
const CALLER_RE = /^[a-z][a-z0-9-]{1,31}$/;
const HEADER_RE = /^([a-z][a-z0-9-]{1,31})\.([A-Za-z0-9_-]{43})$/;
const FAMILY_RE = /^\/[a-z0-9._~@-]{1,40}(\/[a-z0-9._~@-]{1,40}){0,2}$/;
const DAY = 86400000;
const CACHE_MS = 10 * 60 * 1000;         // a verified header is trusted this long (per-caller generations end it early)
const ROW_MS = 30 * 1000;                // a caller's row (or "no such caller") is cached this long
const FLUSH_MS = 30 * 1000;
const OBSERVE_DAYS = 7;
const GRACE_MAX_H = 72, GRACE_DEFAULT_H = 24;
const KEEP_DAYS = 90;                    // legacy_token_daily / events_auth_log rows
const TOKENS = { shared: "TWITCH_BOT_TOKEN", discord: "DISCORD_BOT_TOKEN" };
const DEFAULTS = { enabled: "true", bad_key: "fallback", events: "observe", control_get: "allow" };
let ARGON = { t: 2, m: 19456, p: 1 };    // OWASP's argon2id minimum (19 MiB, 2 passes); pure JS (@noble/hashes), ~0.25 s

let clock = () => Date.now();
const now = () => clock();
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const tagOf = (secret) => sha256(secret).slice(0, 16);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const str = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
const stats = { argon: 0, revalidated: 0, resolved: 0, unresolved: 0, unknown: 0, refused: 0, legacy: 0, flushes: 0 };

class Refuse extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; this.refuse = true; } }

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error("[botkeys] " + msg);
}

// ── tables ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS bot_keys (
        caller TEXT PRIMARY KEY, hash TEXT NOT NULL, tag TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe','enforce')),
        label TEXT, created_at INTEGER NOT NULL, created_by TEXT, observe_since INTEGER NOT NULL,
        enforced_at INTEGER, rotated_at INTEGER, last_used_at INTEGER,
        prev_hash TEXT, prev_tag TEXT, prev_until INTEGER,
        revoked_at INTEGER, revoked_by TEXT, revoked_why TEXT)`);
      // keyed by family too: the "(refused)" / "(unmatched)" pseudo-routes keep one row per family
      await runQuery(`CREATE TABLE IF NOT EXISTS bot_route_log (
        caller TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, family TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, first_at INTEGER, last_at INTEGER, refused_at INTEGER,
        PRIMARY KEY (caller, method, route, family))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS legacy_token_use (
        route TEXT NOT NULL, caller_hint TEXT NOT NULL, family TEXT NOT NULL, token TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, first_at INTEGER, last_at INTEGER,
        PRIMARY KEY (route, caller_hint))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS legacy_token_daily (
        day TEXT NOT NULL, token TEXT NOT NULL, caller_hint TEXT NOT NULL, family TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL,
        PRIMARY KEY (day, token, caller_hint, family))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS bot_key_families (
        family TEXT PRIMARY KEY, legacy_enforce INTEGER NOT NULL DEFAULT 0, updated INTEGER, actor TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS bot_keys_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      await reloadConfig();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── settings + the per-family legacy switches (cached; refreshed on every flush and after a change) ──
let SETTINGS = { enabled: true, bad_key: "fallback", events: "observe", control_get: "allow" };
const FAMILIES = new Map();               // family -> legacy_enforce (only rows that exist)
function parseSettings(raw) {
  const v = { ...DEFAULTS, ...raw };
  return { enabled: v.enabled !== "false", bad_key: v.bad_key === "refuse" ? "refuse" : "fallback",
           events: v.events === "enforce" ? "enforce" : "observe", control_get: v.control_get === "refuse" ? "refuse" : "allow" };
}
async function reloadConfig() {
  const raw = {};
  for (const r of await getQuery("SELECT key, value FROM bot_keys_settings")) raw[r.key] = r.value;
  SETTINGS = parseSettings(raw);
  FAMILIES.clear();
  for (const r of await getQuery("SELECT family, legacy_enforce FROM bot_key_families")) FAMILIES.set(r.family, !!r.legacy_enforce);
}
const settings = () => ({ ...SETTINGS });

/** The route family of a path: "/api/<x>" (+ "/bot" when that is the third segment: /api/soundboards/bot), else the first
 *  segment ("/events", "/healthz", "/u"). Lower-cased, query stripped. Scopes are lists of these. */
function family(p) {
  const seg = String(p || "/").split("?")[0].toLowerCase().split("/").filter(Boolean).map((s) => s.slice(0, 40));
  if (!seg.length) return "/";
  if (seg[0] !== "api" || seg.length === 1) return "/" + seg[0];
  if (seg[2] === "bot") return "/" + seg.slice(0, 3).join("/");
  return "/" + seg.slice(0, 2).join("/");
}
const familyEnforced = (fam) => FAMILIES.get(fam) === true;

// ── argon2id (PHC strings) ──
const b64 = (u8) => Buffer.from(u8).toString("base64").replace(/=+$/, "");
async function phcHash(secret, P = ARGON) {
  const { argon2idAsync } = require("@noble/hashes/argon2");
  const salt = crypto.randomBytes(16);
  const h = await argon2idAsync(String(secret), salt, { t: P.t, m: P.m, p: P.p, dkLen: 32 });
  return `$argon2id$v=19$m=${P.m},t=${P.t},p=${P.p}$${b64(salt)}$${b64(h)}`;
}
function phcParse(s) {
  const m = /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,64})\$([A-Za-z0-9+/]{22,128})$/.exec(String(s || ""));
  if (!m) return null;
  const P = { m: +m[1], t: +m[2], p: +m[3] };
  if (P.m < 8 || P.m > 262144 || P.t < 1 || P.t > 10 || P.p < 1 || P.p > 4) return null;   // a tampered row can't burn the CPU
  return { ...P, salt: Buffer.from(m[4], "base64"), hash: Buffer.from(m[5], "base64") };
}
async function phcVerify(phc, secret) {
  const p = phcParse(phc);
  if (!p) return false;
  stats.argon++;
  const { argon2idAsync } = require("@noble/hashes/argon2");
  const h = Buffer.from(await argon2idAsync(String(secret), p.salt, { t: p.t, m: p.m, p: p.p, dkLen: p.hash.length }));
  return h.length === p.hash.length && crypto.timingSafeEqual(h, p.hash);
}

// ── resolving a header ──
const gens = new Map();                   // caller -> generation (bumped on mint / rotate / revoke / mode / scopes)
const genOf = (caller) => gens.get(caller) || 0;
function bump(caller) { gens.set(caller, genOf(caller) + 1); rows.delete(caller); }
const verified = new Map();               // sha256(header) -> {caller, gen, until, mode, scopes, since}
const inflight = new Map();               // sha256(header) -> Promise
const rows = new Map();                   // caller -> {row, at, gen}
const parseScopes = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; } };

async function rowOf(caller) {
  const hit = rows.get(caller);
  if (hit && hit.gen === genOf(caller) && now() - hit.at < ROW_MS) return hit.row;
  await init();
  const row = (await getQuery("SELECT * FROM bot_keys WHERE caller = ?", [caller]))[0] || null;
  if (rows.size > 1000) rows.clear();
  rows.set(caller, { row, at: now(), gen: genOf(caller) });
  return row;
}

/** X-PATV-Key value -> {caller, mode, scopes, since} or null (unknown / revoked / wrong secret / malformed). Never throws. */
async function resolve(header) {
  return (await check(header)).key;
}

/**
 * The header's verdict -> {key: {caller, mode, scopes, since, ...}} or {key: null, why}: why = malformed | unknown (no such
 * caller - anyone can send that) | revoked | wrong (a live caller; a secret that doesn't verify, or a grace secret past its
 * time) | error. Never throws.
 * 1.99acf: an expired cache entry that nothing in this process changed (same generation) is re-checked against the row (a
 * 30 s cached SELECT) - the same stored hash and tag, not revoked, a grace secret still in its window - and extended without
 * running argon2 again (Pepe's audio chunks would stall behind a ~0.25 s verify every 10 minutes). argon2 runs only when the
 * stored secret changed.
 */
async function check(header) {
  const m = HEADER_RE.exec(String(header || "").trim());
  if (!m) return { key: null, why: "malformed" };
  const [, caller, secret] = m;
  const hk = sha256(m[0]);
  const hit = verified.get(hk);
  const t = now();
  if (hit && hit.caller === caller && hit.gen === genOf(caller) && t < hit.until) return { key: hit };
  if (inflight.has(hk)) return inflight.get(hk);
  const stale = hit && hit.caller === caller && hit.gen === genOf(caller) ? hit : null;
  if (hit) verified.delete(hk);
  const p = (async () => {
    try {
      const gen = genOf(caller);
      const row = await rowOf(caller);
      if (!row) return { key: null, why: "unknown" };
      if (row.revoked_at) return { key: null, why: "revoked" };
      const tag = tagOf(secret);
      let until = 0, slot = null;
      if (stale && stale.tag === tag) {            // re-check the row instead of argon2 (the same stored secret was verified)
        if (stale.slot === "cur" && row.tag === tag && sha256(row.hash) === stale.hv) { until = t + CACHE_MS; slot = "cur"; }
        else if (stale.slot === "prev" && row.prev_tag === tag && sha256(row.prev_hash) === stale.hv && Number(row.prev_until) > t) {
          until = Math.min(t + CACHE_MS, Number(row.prev_until)); slot = "prev";
        }
        if (until) stats.revalidated++;
      }
      if (!until) {
        if (row.tag === tag && await phcVerify(row.hash, secret)) { until = t + CACHE_MS; slot = "cur"; }
        else if (row.prev_tag === tag && Number(row.prev_until) > t && await phcVerify(row.prev_hash, secret)) {
          until = Math.min(t + CACHE_MS, Number(row.prev_until)); slot = "prev";
        }
      }
      if (!until) return { key: null, why: "wrong" };
      const out = { caller, gen, until, mode: row.mode === "enforce" ? "enforce" : "observe", scopes: parseScopes(row.scopes),
                    since: Number(row.observe_since) || t, slot, tag, hv: sha256(slot === "cur" ? row.hash : row.prev_hash) };
      if (gen === genOf(caller)) {                 // nothing changed the key while we verified
        if (verified.size > 2000) verified.clear();
        verified.set(hk, out);
      }
      return { key: out };
    } catch (e) {
      warnOnce("verify", "a key couldn't be verified (" + (e && e.message) + ") - treated as unresolved");
      return { key: null, why: "error" };
    } finally {
      inflight.delete(hk);
    }
  })();
  inflight.set(hk, p);
  return p;
}

// ── the request context ──
/** The live request context this code runs in, if any (one whose request has finished counts as none). */
function ctxNow() {
  const c = als.getStore();
  return c && c.live ? c : null;
}
function routeOf(req) {
  if (!req) return "(no request)";
  const r = req.route;
  if (!r || r.path == null) return null;
  const p = Array.isArray(r.path) ? r.path.join("|") : String(r.path);
  return ((req.baseUrl || "") + p).slice(0, 200);
}
/** "python-requests/2", "axios/1", "curl", "pepe-vm-control/1", "browser" - never the raw string. */
function uaFamily(ua) {
  const s = String(ua || "").trim();
  if (!s) return "-";
  if (/^mozilla\//i.test(s)) return "browser";
  const m = /^([A-Za-z][A-Za-z0-9._-]{0,30})(?:\/(\d+))?/.exec(s);
  if (!m) return "other";
  const name = m[1].toLowerCase();
  if (name === "curl") return "curl";
  return m[2] ? name + "/" + m[2] : name;
}
/** token | client family | address. tag (a key that didn't count on this request: "badkey:<caller>" / "scope:<caller>")
 *  replaces the token name. */
function hintOf(req, tokenName, tag) {
  if (!req) return [tag || tokenName, "-", "-"].join("|");
  let addr = "?";
  try { addr = require("./middleware/authGuard").clientAddr(req).ip; } catch (e) { addr = "?"; }
  let ua = "";
  try { ua = req.get("user-agent"); } catch (e) { ua = ""; }
  return [tag || tokenName, uaFamily(ua), String(addr).slice(0, 64)].join("|").slice(0, 200);
}

// ── counters (in memory, flushed every FLUSH_MS) ──
let routeHits = new Map(), legacyHits = new Map(), legacyDaily = new Map(), usedAt = new Map();
const flushers = [];                      // {fn: async (runQuery) => void, pending: () => bool}, run inside the flush transaction (eventsauth.js)
function hitRoute(caller, method, route, fam, refused) {
  const k = caller + "\u0001" + method + "\u0001" + route + "\u0001" + fam;
  const t = now();
  let h = routeHits.get(k);
  if (!h) { h = { caller, method, route, family: fam, n: 0, refused: 0, first: t, last: t, refusedAt: null }; routeHits.set(k, h); }
  if (refused) { h.refused++; h.refusedAt = t; } else h.n++;
  h.last = t;
  usedAt.set(caller, t);
}
function hitLegacy(route, hint, fam, token, refused) {
  const t = now();
  const k = route + "\u0001" + hint;
  let h = legacyHits.get(k);
  if (!h) { h = { route, hint, family: fam, token, n: 0, refused: 0, first: t, last: t }; legacyHits.set(k, h); }
  if (refused) h.refused++; else h.n++;
  h.last = t;
  const dk = dayOf(t) + "\u0001" + token + "\u0001" + hint + "\u0001" + fam;
  legacyDaily.set(dk, (legacyDaily.get(dk) || 0) + 1);
  stats.legacy++;
}

/** The request's route as seen from a token check: "METHOD /pattern". */
function legacyRoute(ctx) {
  if (!ctx || !ctx.req) return "(no request)";
  const r = routeOf(ctx.req);
  return (ctx.req.method || "GET") + " " + (r || "(unrouted) " + ctx.family);
}

/** A legacy token matched: allowed unless its family's legacy-enforce switch is on. Counted once per request. */
function legacyUse(tokenName) {
  const ctx = ctxNow();
  const fam = ctx ? ctx.family : "(none)";
  const refused = familyEnforced(fam);
  if (!ctx || !ctx.legacyCounted) {
    if (ctx) ctx.legacyCounted = true;
    hitLegacy(legacyRoute(ctx), hintOf(ctx && ctx.req, tokenName, ctx && ctx.hint), fam, tokenName, refused);
  }
  return !refused;
}

/** isBotToken (index.js wraps it): a resolved key caller, else the shared token (counted). */
function isBotToken(token) {
  const ctx = ctxNow();
  if (ctx && ctx.caller) return true;
  const expected = process.env[TOKENS.shared];
  if (!(typeof expected === "string" && expected.length > 0 && token === expected)) return false;
  return legacyUse("shared");
}
/** isPlatformBot: isBotToken, else the Discord bot's own shared token (counted as token=discord). */
function isPlatformBot(token) {
  if (isBotToken(token)) return true;
  const d = process.env[TOKENS.discord];
  if (!(typeof d === "string" && d.length > 0 && token === d)) return false;
  return legacyUse("discord");
}
/** {caller, mode, scopes} of the request's resolved key, or null (eventsauth.js, whoami). */
function current() {
  const ctx = ctxNow();
  return ctx && ctx.caller ? { caller: ctx.caller, mode: ctx.mode, scopes: ctx.scopes.slice(), since: ctx.since } : null;
}

// ── alerts (never awaited; at most one per ref a day; never a request path or a caller name nobody minted) ──
const alerted = new Set();
function alertOnce(ref, title, body, source = "botkeys") {
  const day = dayOf(now());
  const k = ref + ":" + day;
  if (alerted.has(k)) return;
  if (alerted.size > 500) alerted.clear();
  alerted.add(k);
  try {
    Promise.resolve(require("./opsalerts").alert({ source, ref: k, title, body }))
      .catch((e) => console.error("[botkeys] alert:", e.message));
  } catch (e) { console.error("[botkeys] alert:", e.message); }
}
/** A family for an alert's text: only a well-formed one (the path is the sender's to choose). */
const famText = (f) => (FAMILY_RE.test(String(f)) ? f : "(an unrecognised path)");

// headers naming a caller with no row: counted per day; the day's total is one summary alert after it ends
let unknownDay = { day: null, n: 0 };
function rollUnknown(t = now()) {
  const d = dayOf(t);
  if (unknownDay.day === d) return;
  const prev = unknownDay;
  unknownDay = { day: d, n: 0 };
  if (prev.day && prev.n > 0) {
    alertOnce(`unknown:${prev.day}`, `${prev.n} bot key header(s) for unknown callers on ${prev.day}`,
      `Requests sent X-PATV-Key naming a caller that has no key on this site (${prev.n} on ${prev.day}). They were judged on ` +
      `their legacy credentials (or refused with bad_key = refuse). A bot sending a key minted on the other environment shows up here.`,
      "botkeys-unknown");
  }
}

// ── the middleware (index.js, right after the body parsers) ──
/** The key's verdict for this request: "go" (carry on in the context) or "done" (a refusal was sent). v = check()'s answer. */
function judge(v, c, req, res, hdr) {
  const r = v && v.key;
  if (r) {
    stats.resolved++;
    if (r.mode === "enforce" && !r.scopes.includes(c.family)) {
      // outside its scopes the key counts for nothing here: logged as refused, then the legacy credentials decide - unless the
      // family's legacy-enforce switch is on (nothing else could authenticate it): then 403 before routing
      stats.refused++;
      hitRoute(r.caller, req.method || "GET", "(refused)", c.family, true);
      const hard = familyEnforced(c.family);
      alertOnce(`scope:${r.caller}:${c.family}`, `Bot key "${r.caller}" used outside its scopes on ${famText(c.family)}`,
        `The key is in enforce mode and ${famText(c.family)} isn't in its scopes (a ${req.method} request). ` +
        (hard ? "The family refuses the shared tokens, so it was refused (403). " : "It was judged on its legacy credentials instead. ") +
        `Grant the family on /admin/keys#scopes if the caller needs it.`, "botkeys-scope");
      if (hard) {
        res.set("Cache-Control", "no-store");
        res.status(403).json({ ok: false, error: "scope" });
        return "done";
      }
      c.hint = "scope:" + r.caller;
      return "go";
    }
    Object.assign(c, { caller: r.caller, mode: r.mode, scopes: r.scopes, since: r.since });
    return "go";
  }
  stats.unresolved++;
  const m = /^([a-z][a-z0-9-]{1,31})\./.exec(String(hdr).trim());
  const who = m ? m[1] : "?";
  const why = (v && v.why) || "malformed";
  if (why === "revoked" || why === "wrong") {            // a caller that exists: its own secret is wrong, revoked or past its grace
    alertOnce(`badkey:${who}`, `Bot key "${who}" didn't resolve`,
      `A request sent X-PATV-Key for "${who}" with a secret that is ${why === "revoked" ? "revoked" : "wrong or past its rotation grace"} ` +
      `(a ${req.method} request on ${famText(c.family)}). ` +
      (SETTINGS.bad_key === "refuse" ? "It was refused (401)." : "It was judged on its legacy credentials (bad_key = fallback)."));
  } else {
    stats.unknown++;
    rollUnknown();
    unknownDay.n++;
  }
  if (SETTINGS.bad_key === "refuse") {
    res.set("Cache-Control", "no-store");
    res.status(401).json({ ok: false, error: "key" });
    return "done";
  }
  c.hint = "badkey:" + who;
  return "go";
}

function middleware(req, res, next) {
  let c = null, hdr = null;
  try {
    c = { req, live: true, caller: null, mode: null, scopes: [], since: null, legacyCounted: false, hint: null, route: null,
          family: family(req.path) };
    // re-entered for the same request (botupload.js: app.handle on the target route): the outer context keeps the route it
    // matched (req.route changes below), this one logs and scope-checks the target
    const outer = req._bkCtx && req._bkCtx.live ? req._bkCtx : null;
    if (outer && outer.route == null) outer.route = routeOf(req) || "(unmatched)";
    req._bkCtx = c;
    const ctx = c;
    const end = () => {
      if (!ctx.live) return;
      ctx.live = false;
      try { if (ctx.caller) hitRoute(ctx.caller, req.method || "GET", ctx.route || routeOf(req) || "(unmatched)", ctx.family, false); }
      catch (e) { warnOnce("finish", "route log: " + e.message); }
      ctx.req = null;                      // a timer the request started can't keep it alive (or act as its caller)
    };
    res.once("finish", end);
    res.once("close", end);
    hdr = SETTINGS.enabled ? req.get("x-patv-key") : null;
  } catch (e) {
    warnOnce("mw", "middleware: " + e.message + " (the request goes on as before)");
    return next();                         // fail open to today's behaviour (no context: the legacy checks alone)
  }
  if (!hdr) return als.run(c, next);
  // next() runs exactly once, after the verdict (and never inside the promise chain's error path)
  const failOpen = (e) => { warnOnce("mw-async", "middleware: " + (e && e.message) + " (the request goes on as before)"); return res.headersSent ? "done" : "go"; };
  check(hdr)
    .then((v) => { try { return judge(v, c, req, res, hdr); } catch (e) { return failOpen(e); } }, failOpen)
    .then((verdict) => { if (verdict === "go") als.run(c, next); })
    .catch((e) => console.error("[botkeys] middleware:", e && e.message));
}

// ── flushing ──
let flushing = null, lastPurgeDay = null;
async function flush() {
  if (flushing) return flushing;
  rollUnknown();
  const R = routeHits, L = legacyHits, D = legacyDaily, U = usedAt;
  routeHits = new Map(); legacyHits = new Map(); legacyDaily = new Map(); usedAt = new Map();
  const purge = dayOf(now()) !== lastPurgeDay;
  flushing = (async () => {
    await init();
    if (R.size || L.size || D.size || U.size || flushers.some((f) => f.pending()) || purge) {
      await tx(async () => {
        for (const h of R.values()) {
          await runQuery(`INSERT INTO bot_route_log (caller, method, route, family, n, refused, first_at, last_at, refused_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(caller, method, route, family) DO UPDATE SET n = n + excluded.n, refused = refused + excluded.refused,
                          last_at = MAX(COALESCE(last_at, 0), excluded.last_at),
                          refused_at = NULLIF(MAX(COALESCE(refused_at, 0), COALESCE(excluded.refused_at, 0)), 0)`,
                         [h.caller, h.method, h.route, h.family, h.n, h.refused, h.first, h.last, h.refusedAt]);
        }
        for (const h of L.values()) {
          await runQuery(`INSERT INTO legacy_token_use (route, caller_hint, family, token, n, refused, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(route, caller_hint) DO UPDATE SET n = n + excluded.n, refused = refused + excluded.refused,
                          family = excluded.family, token = excluded.token, last_at = MAX(COALESCE(last_at, 0), excluded.last_at)`,
                         [h.route, h.hint, h.family, h.token, h.n, h.refused, h.first, h.last]);
        }
        for (const [k, n] of D) {
          const [day, token, hint, fam] = k.split("\u0001");
          await runQuery(`INSERT INTO legacy_token_daily (day, token, caller_hint, family, n) VALUES (?, ?, ?, ?, ?)
                          ON CONFLICT(day, token, caller_hint, family) DO UPDATE SET n = n + excluded.n`, [day, token, hint, fam, n]);
        }
        for (const [caller, t] of U) {
          await runQuery("UPDATE bot_keys SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE caller = ?", [t, caller]);
        }
        for (const f of flushers) await f.fn(runQuery, purge);
        if (purge) {
          await runQuery("DELETE FROM legacy_token_daily WHERE day < ?", [dayOf(now() - KEEP_DAYS * DAY)]);
          lastPurgeDay = dayOf(now());
        }
      });
      stats.flushes++;
    }
    await reloadConfig();
  })().catch((e) => { console.error("[botkeys] flush:", e.message); }).finally(() => { flushing = null; });
  return flushing;
}
/** Run fn(runQuery, purgeDay) inside each flush transaction - only when pending() says it has something (or once a day). */
function onFlush(fn, pending = () => true) { flushers.push({ fn, pending }); }

let timer = null;
function start() {
  init().catch((e) => console.error("[botkeys] init:", e.message));
  if (timer) return;
  timer = setInterval(() => { flush(); }, FLUSH_MS);
  if (timer.unref) timer.unref();
  try { require("./shutdown").onDrain(() => { flush(); }); } catch (e) { /* no graceful stop */ }
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// ── management (/admin/keys; owners only - adminkeys.js gates it) ──
const audit = (actor, action, detail, reason) => require("./adminaudit").record(actor, action, null, detail, reason || null);
const callerOf = (v) => {
  const c = String(v == null ? "" : v).trim().toLowerCase();
  if (!CALLER_RE.test(c)) throw new Refuse(400, "bad_caller", "A caller is 2-32 characters: a-z, 0-9 and '-', starting with a letter.");
  return c;
};
const newSecret = () => crypto.randomBytes(32).toString("base64url");

/** A new key for a caller with no live key (a revoked caller gets a fresh one: observe again, scopes kept). -> {caller, key} */
async function mint(caller, label, actor) {
  await init();
  const c = callerOf(caller);
  const secret = newSecret();
  const hash = await phcHash(secret);                  // outside the transaction (it takes a moment)
  const t = now();
  await tx(async () => {
    const row = (await getQuery("SELECT caller, revoked_at FROM bot_keys WHERE caller = ?", [c]))[0];
    if (row && !row.revoked_at) throw new Refuse(409, "exists", "That caller already has a live key - rotate it instead.");
    const by = str(actor && actor.username, 80);
    if (row) {
      await runQuery(`UPDATE bot_keys SET hash = ?, tag = ?, mode = 'observe', label = ?, created_at = ?, created_by = ?, observe_since = ?,
                      enforced_at = NULL, rotated_at = NULL, prev_hash = NULL, prev_tag = NULL, prev_until = NULL,
                      revoked_at = NULL, revoked_by = NULL, revoked_why = NULL WHERE caller = ?`, [hash, tagOf(secret), str(label, 80), t, by, t, c]);
    } else {
      await runQuery(`INSERT INTO bot_keys (caller, hash, tag, scopes, mode, label, created_at, created_by, observe_since)
                      VALUES (?, ?, ?, '[]', 'observe', ?, ?, ?, ?)`, [c, hash, tagOf(secret), str(label, 80), t, by, t]);
    }
    await audit(actor, "botkeys.mint", { caller: c, label: str(label, 80), again: !!row });
  });
  bump(c);
  return { caller: c, key: c + "." + secret };
}

/** A new secret; the old one keeps working for grace_h hours (0-72, default 24). -> {caller, key, prev_until} */
async function rotate(caller, graceH, actor) {
  await init();
  const c = callerOf(caller);
  let g = graceH == null || graceH === "" ? GRACE_DEFAULT_H : Number(graceH);
  if (!Number.isFinite(g) || g < 0) g = GRACE_DEFAULT_H;
  g = Math.min(GRACE_MAX_H, g);
  const secret = newSecret();
  const hash = await phcHash(secret);
  const t = now();
  const until = g > 0 ? t + Math.round(g * 3600e3) : null;
  await tx(async () => {
    const row = (await getQuery("SELECT * FROM bot_keys WHERE caller = ?", [c]))[0];
    if (!row || row.revoked_at) throw new Refuse(404, "revoked", "That caller has no live key - mint one.");
    await runQuery(`UPDATE bot_keys SET hash = ?, tag = ?, rotated_at = ?, prev_hash = ?, prev_tag = ?, prev_until = ? WHERE caller = ?`,
                   [hash, tagOf(secret), t, until ? row.hash : null, until ? row.tag : null, until, c]);
    await audit(actor, "botkeys.rotate", { caller: c, grace_h: g });
  });
  bump(c);
  return { caller: c, key: c + "." + secret, prev_until: until };
}

async function revoke(caller, why, actor) {
  await init();
  const c = callerOf(caller);
  const reason = String(why == null ? "" : why).trim().slice(0, 200);
  if (reason.length < 3) throw new Refuse(400, "reason", "Give a reason.");
  await tx(async () => {
    const row = (await getQuery("SELECT caller, revoked_at FROM bot_keys WHERE caller = ?", [c]))[0];
    if (!row || row.revoked_at) throw new Refuse(404, "revoked", "That caller has no live key.");
    await runQuery(`UPDATE bot_keys SET revoked_at = ?, revoked_by = ?, revoked_why = ?, prev_hash = NULL, prev_tag = NULL, prev_until = NULL
                    WHERE caller = ?`, [now(), str(actor && actor.username, 80), reason, c]);
    await audit(actor, "botkeys.revoke", { caller: c }, reason);
  });
  bump(c);
  return { caller: c };
}

const cleanScopes = (list) => {
  const out = [];
  for (const s of Array.isArray(list) ? list.slice(0, 300) : []) {
    const f = String(s == null ? "" : s).trim().toLowerCase();
    if (!FAMILY_RE.test(f)) throw new Refuse(400, "bad_scope", "Not a route family: " + f.slice(0, 60));
    if (!out.includes(f)) out.push(f);
  }
  return out.sort();
};

/** observe | enforce with the reviewed scopes. Enforcing before OBSERVE_DAYS of observation needs early = true. */
async function setMode(caller, mode, scopes, actor, { early = false } = {}) {
  await init();
  const c = callerOf(caller);
  if (mode !== "observe" && mode !== "enforce") throw new Refuse(400, "bad_mode", "mode is observe or enforce");
  const list = scopes == null ? null : cleanScopes(scopes);
  await tx(async () => {
    const row = (await getQuery("SELECT * FROM bot_keys WHERE caller = ?", [c]))[0];
    if (!row || row.revoked_at) throw new Refuse(404, "revoked", "That caller has no live key.");
    if (mode === "enforce" && !early && now() - Number(row.observe_since) < OBSERVE_DAYS * DAY) {
      throw new Refuse(409, "too_early", `Observe for ${OBSERVE_DAYS} days first (or confirm enforcing early).`);
    }
    const sc = list == null ? parseScopes(row.scopes) : list;
    await runQuery("UPDATE bot_keys SET mode = ?, scopes = ?, enforced_at = ? WHERE caller = ?",
                   [mode, JSON.stringify(sc), mode === "enforce" ? (row.mode === "enforce" ? row.enforced_at : now()) : null, c]);
    await audit(actor, "botkeys.mode", { caller: c, mode, scopes: sc, early: !!early });
  });
  bump(c);
  return { caller: c, mode };
}

/** Add one family to a key's scopes (a family a key in enforce was refused on). */
async function grant(caller, fam, actor) {
  await init();
  const c = callerOf(caller);
  const f = cleanScopes([fam])[0];
  if (!f) throw new Refuse(400, "bad_scope", "Pick a route family.");
  await tx(async () => {
    const row = (await getQuery("SELECT scopes, revoked_at FROM bot_keys WHERE caller = ?", [c]))[0];
    if (!row || row.revoked_at) throw new Refuse(404, "revoked", "That caller has no live key.");
    const sc = parseScopes(row.scopes);
    if (!sc.includes(f)) sc.push(f);
    await runQuery("UPDATE bot_keys SET scopes = ? WHERE caller = ?", [JSON.stringify(sc.sort()), c]);
    await audit(actor, "botkeys.grant", { caller: c, family: f });
  });
  bump(c);
  return { caller: c, family: f };
}

/** A route family's legacy-enforce switch: on = the shared tokens are refused there (key callers are unaffected). */
async function setFamily(fam, legacyEnforce, actor) {
  await init();
  const f = String(fam == null ? "" : fam).trim().toLowerCase();
  if (!FAMILY_RE.test(f)) throw new Refuse(400, "bad_scope", "Not a route family.");
  const on = legacyEnforce === true || legacyEnforce === "true" || legacyEnforce === 1;
  await tx(async () => {
    await runQuery(`INSERT INTO bot_key_families (family, legacy_enforce, updated, actor) VALUES (?, ?, ?, ?)
                    ON CONFLICT(family) DO UPDATE SET legacy_enforce = excluded.legacy_enforce, updated = excluded.updated, actor = excluded.actor`,
                   [f, on ? 1 : 0, now(), str(actor && actor.username, 80)]);
    await audit(actor, "botkeys.family", { family: f, legacy_enforce: on });
  });
  FAMILIES.set(f, on);
  return { family: f, legacy_enforce: on };
}

async function setSettings(patch, actor) {
  await init();
  const p = patch || {};
  const next = {};
  if ("enabled" in p) next.enabled = p.enabled === true || p.enabled === "true" ? "true" : "false";
  if ("bad_key" in p) next.bad_key = p.bad_key === "refuse" ? "refuse" : "fallback";
  if ("events" in p) next.events = p.events === "enforce" ? "enforce" : "observe";
  if ("control_get" in p) next.control_get = p.control_get === "refuse" ? "refuse" : "allow";
  if (!Object.keys(next).length) throw new Refuse(400, "nothing", "Nothing to change.");
  await tx(async () => {
    for (const [k, v] of Object.entries(next)) {
      await runQuery(`INSERT INTO bot_keys_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                     [k, v, now(), str(actor && actor.username, 80)]);
    }
    await audit(actor, "botkeys.settings", next);
  });
  await reloadConfig();
  return settings();
}

// ── reads for /admin/keys (never hash / tag / prev_*) ──
function keyView(r, t) {
  return { caller: r.caller, mode: r.mode, scopes: parseScopes(r.scopes), label: r.label, created_at: r.created_at, created_by: r.created_by,
           observe_since: r.observe_since, observed_days: Math.max(0, Math.floor((t - Number(r.observe_since)) / DAY)),
           enforced_at: r.enforced_at, rotated_at: r.rotated_at, last_used_at: r.last_used_at,
           grace_until: r.prev_until && Number(r.prev_until) > t ? Number(r.prev_until) : null,
           revoked_at: r.revoked_at, revoked_by: r.revoked_by, revoked_why: r.revoked_why };
}
/** Days since the last legacy use of one shared token (prod / staging each read their own), null = never seen. */
function zeroDays(daily, token, t) {
  const last = daily.filter((r) => r.token === token && r.n > 0).map((r) => r.day).sort().pop();
  if (!last) return null;
  return Math.max(0, Math.floor((Date.parse(dayOf(t) + "T00:00:00Z") - Date.parse(last + "T00:00:00Z")) / DAY));
}
async function adminView() {
  await init();
  await flush();
  const t = now();
  const keys = (await getQuery("SELECT * FROM bot_keys ORDER BY caller")).map((r) => keyView(r, t));
  const routes = await getQuery("SELECT caller, method, route, family, n, refused, first_at, last_at, refused_at FROM bot_route_log ORDER BY caller, family, route LIMIT 2000");
  const legacy = await getQuery("SELECT route, caller_hint, family, token, n, refused, first_at, last_at FROM legacy_token_use ORDER BY last_at DESC LIMIT 1000");
  const daily = await getQuery("SELECT day, token, caller_hint, family, n FROM legacy_token_daily WHERE day >= ? ORDER BY day", [dayOf(t - KEEP_DAYS * DAY)]);
  const fams = await getQuery("SELECT family, legacy_enforce, updated, actor FROM bot_key_families");
  const since14 = dayOf(t - 13 * DAY);
  const famMap = new Map();
  const F = (f) => { if (!famMap.has(f)) famMap.set(f, { family: f, legacy14: 0, legacy_last: null, keys: 0, legacy_enforce: false }); return famMap.get(f); };
  for (const r of legacy) { const x = F(r.family); x.legacy_last = Math.max(x.legacy_last || 0, Number(r.last_at) || 0) || null; }
  for (const r of routes) F(r.family).keys += Number(r.n) || 0;
  for (const r of fams) F(r.family).legacy_enforce = !!r.legacy_enforce;
  for (const r of daily) if (r.day >= since14 && r.family) F(r.family).legacy14 += Number(r.n) || 0;   // the last 14 days
  const families = [...famMap.values()].sort((a, b) => a.family.localeCompare(b.family));
  const observed = {};
  for (const r of routes) {
    const o = observed[r.caller] = observed[r.caller] || {};
    const f = o[r.family] = o[r.family] || { family: r.family, n: 0, refused: 0 };
    f.n += Number(r.n) || 0; f.refused += Number(r.refused) || 0;
  }
  return {
    settings: settings(), keys, routes, legacy, families,
    observed: Object.fromEntries(Object.entries(observed).map(([c, o]) => [c, Object.values(o).sort((a, b) => a.family.localeCompare(b.family))])),
    retire: { shared: { zero_days: zeroDays(daily, "shared", t) }, discord: { zero_days: zeroDays(daily, "discord", t) } },
    observe_days: OBSERVE_DAYS, grace_max_h: GRACE_MAX_H, grace_default_h: GRACE_DEFAULT_H,
    stats: { ...stats }, now: t,
  };
}
/** Keys in enforce refused within the last `ms` (the admin Overview alert). */
async function recentRefusals(ms = 3600e3) {
  try {
    await init();
    return (await getQuery(`SELECT l.caller, l.family, l.refused_at FROM bot_route_log l JOIN bot_keys k ON k.caller = l.caller
                            WHERE k.mode = 'enforce' AND k.revoked_at IS NULL AND l.refused_at > ? ORDER BY l.refused_at DESC LIMIT 20`, [now() - ms]));
  } catch (e) { return []; }
}

function register(app) {
  init().catch((e) => console.error("[botkeys] init:", e.message));
  // who this key is - Pepe's admin-panel Test button and ops checks. A key only (never the legacy token).
  app.get("/api/botkeys/whoami", (req, res) => {
    res.set("Cache-Control", "no-store");
    const k = current();
    if (!k) return res.status(401).json({ ok: false, error: "key" });
    res.json({ ok: true, caller: k.caller, mode: k.mode, scopes: k.scopes, observe_days: Math.max(0, Math.floor((now() - Number(k.since || now())) / DAY)) });
  });
}

module.exports = {
  init, start, stop, register, middleware, isBotToken, isPlatformBot, current, family, uaFamily, settings, setSettings, resolve, check,
  mint, rotate, revoke, setMode, grant, setFamily, adminView, recentRefusals, flush, onFlush, Refuse,
  CALLER_RE, HEADER_RE, FAMILY_RE, OBSERVE_DAYS, GRACE_MAX_H, GRACE_DEFAULT_H, CACHE_MS, FLUSH_MS,
  _stats: stats, _setClock: (f) => { clock = f || (() => Date.now()); }, _setArgon: (p) => { ARGON = p ? { ...ARGON, ...p } : { t: 2, m: 19456, p: 1 }; },
  _reset: () => { verified.clear(); inflight.clear(); rows.clear(); gens.clear(); routeHits.clear(); legacyHits.clear(); legacyDaily.clear(); usedAt.clear(); alerted.clear(); unknownDay = { day: null, n: 0 }; },
  _phcHash: phcHash, _phcVerify: phcVerify, _tagOf: tagOf, _reloadConfig: reloadConfig,
};
