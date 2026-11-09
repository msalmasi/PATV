// pttlimits.js — the 🎙 push-to-talk clip limits, one admin setting (the owner, 2026-11-08: "is there somewhere I can quickly change
// the cooldown for the push to talk (relayed mic) from bridge, and somewhere I can set the max length"). Before, they were constants
// in bridge-relay.js (CLIP_PLAY / CLIP_MAX_SECS) and Pepe's pepe_relay.py (CLIP_LIMIT / CLIP_MAX_SECS); the recorder had its own 20 s.
//
//   gap_s     the cooldown between one person's clips, seconds (0-600; default 30; 0 = none)
//   burst     clips per 10 minutes per person (1-30; default 3) - the play limit's window stays WINDOW_S
//   max_secs  a clip's longest length, seconds (3-120; default 30)
//   tail_ms   relaymic 1.99anh - the release tail: the recorder keeps going this long after the button is let go, so the word said as
//             the finger lifts is in the clip (0-1000 ms; default 400; 0 = none) - the live view's room.pttTail (room-bridge.js)
//   tail_ios  relaymic: the tail on iPhone / iPad too (0 / 1; default 0 = off - there the release stays inside the gesture until it's
//             tested on the owner's iPhone) - room.pttTailIos
//
// Where: /admin/bridge "Push-to-talk clips" (views/admin/bridge.ejs; GET / POST /api/admin/pttlimits) - site admins (pads.config, read
// from the account's class in the database), a same-origin fetch (X-Requested-With: fetch + guard.sameSite), each change an admin_audit
// row "pttlimits.save" {from, to, changed}. Stored in chatlog_meta 'ptt_limits' {gap_s, burst, max_secs, at, by} like the other
// /admin/bridge switches; cached here and clamped on the way in AND out (a hand-edited row can't break a clip).
//
// Effective at once, no restart:
//   * bridge-relay.js reads effective() (current() + Pepe's part, below) for every upload: the play limit (gap / burst per WINDOW_S),
//     the length check (+1 s for the recorder's stop), the body cap (maxBytes) and the flood guard (never below burst)
//   * every clip job carries the values it was accepted under - max_secs, gap_s, burst, window_s - and Pepe (a build that reads them)
//     re-checks with those, inside his own hard ceilings; an older Pepe keeps his 30 s / 3 per 10 min / 30 s
//   * the live view gives pages max_secs (room.pttMax): the recorder stops there and says "up to {n} s" (js.pad.ptt.upto_n)
//
// Review fix 1 - Pepe's part (effective()): an older Pepe cuts a clip to 31 s and refuses anything over 30.5 s as bad_clip, which
// counts against the member on BOTH sides (the clip never plays). So a max length over his own 30 s (OLD_PEPE) applies only while
// Pepe says he follows each clip job's limits - ptt_limits: 1 on his /api/bridge/relay/pull or /api/bridge/sync body (notePepe),
// seen in the last PEPE_TTL (his long-poll comes every 10 s; a rollback to an older build, or no Pepe, goes back to 30 s within it).
// Until then the length check, the body cap, the recorder (room.pttMax) and the job's max_secs use min(setting, 30). The cooldown and
// clips per 10 minutes apply as set: an older Pepe refusing a clip by his own 30 s / 3 per 10 min counts nothing anywhere (the
// site gives its hit back, his limiter counted none) - the card says his own numbers still apply until he follows.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const KEY = "ptt_limits";
const AUDIT = "pttlimits.save";
const WINDOW_S = 600;                                  // "per 10 minutes" (fixed: the card's words, Pepe's CLIP_LIMIT window)
const SPEC = Object.freeze({
  gap_s: Object.freeze({ def: 30, lo: 0, hi: 600, label: "Cooldown between a person's clips (seconds)" }),
  burst: Object.freeze({ def: 3, lo: 1, hi: 30, label: "Clips per 10 minutes per person" }),
  max_secs: Object.freeze({ def: 30, lo: 3, hi: 120, label: "Max clip length (seconds)" }),
  // relaymic 1.99anh: the recorder's release tail (the page only - Pepe never sees it) and whether it applies on iOS (a 0 / 1 switch:
  // true / false from the card's checkbox are taken too)
  tail_ms: Object.freeze({ def: 400, lo: 0, hi: 1000, label: "Release tail (milliseconds)" }),
  tail_ios: Object.freeze({ def: 0, lo: 0, hi: 1, label: "Release tail on iPhone / iPad (0 = off, 1 = on)", bool: true }),
});
const FIELDS = Object.freeze(Object.keys(SPEC));
const DEFAULTS = Object.freeze(Object.fromEntries(FIELDS.map((k) => [k, SPEC[k].def])));
const LIMITS = Object.freeze(Object.fromEntries(FIELDS.map((k) => [k, [SPEC[k].lo, SPEC[k].hi]])));
// The body cap: the recorder asks for 32 kbit/s Opus (4 KB a second); a browser that ignores the bitrate (Safari's AAC) runs well above
// it. BYTES_PER_SEC = 24 KB/s (192 kbit/s, 6x) for max_secs + 1 s, never below the old 600 KB, never above BYTES_CEIL: 744 KB at 30 s,
// about 2.8 MB at 120 s.
// Review fix 2 kept the cap under nginx's client_max_body_size 1m in front of publicaccess.tv and staging (botupload.js; nginx answers
// a bigger body itself with an HTML 413 - the page says "too big" for any 413). Since 2026-11-08 nginx takes 4 MB on POST
// /api/rooms/<slug>/clip only, so BYTES_CEIL is 3.5 MB - well under it - and every cap stays under PEPE's own cap for the same max
// length (pepe_relay.clip_max_bytes: 1.5 MB, 32 kB/s above ~47 s, 4 MB ceiling - 3.84 MB at 120 s): he never refuses a clip the site
// took as "too big". The upload route re-checks the body against the length its job carries (maxBytes(job's max_secs)).
const BYTES_PER_SEC = 24 * 1024;
const BYTES_FLOOR = 600 * 1024;
const BYTES_CEIL = Math.round(3.5 * 1024 * 1024);
// Review fix 1: what an older Pepe enforces on his own (pepe_relay.py CLIP_MAX_SECS / CLIP_LIMIT), and how long his word lasts
const OLD_PEPE = Object.freeze({ gap_s: 30, burst: 3, max_secs: 30 });
const PEPE_TTL = 2 * 60 * 1000;
let PEPE_AT = 0;

let CFG = { ...DEFAULTS }, META = { at: null, by: null }, loaded = false, ready = null, saving = Promise.resolve();

class Refuse extends Error {
  constructor(status, msg, field = null) { super(msg); this.refuse = true; this.status = status; this.field = field; }
}

/** A stored value -> its clamped whole number (a bad one -> the default). */
function clampOne(k, v) {
  const S = SPEC[k];
  if (S.bool && typeof v === "boolean") return v ? 1 : 0;          // (relaymic: tail_ios)
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return S.def;
  return Math.min(S.hi, Math.max(S.lo, Math.round(n)));
}
/** The stored row (anything) -> a clean config. */
function clean(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(FIELDS.map((k) => [k, clampOne(k, o[k])]));
}
/** What an admin sent -> {cfg, errors: {field: why}} - strict: a whole number inside the range (a form's "45" is fine), else an error. */
function validate(input, base = CFG) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const cfg = { ...base }, errors = {};
  for (const k of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const S = SPEC[k], v = src[k];
    const n = S.bool && typeof v === "boolean" ? (v ? 1 : 0)          // (relaymic: tail_ios - the card's checkbox)
      : typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < S.lo || n > S.hi) {
      errors[k] = S.bool ? `${S.label}: on or off.` : `${S.label}: a whole number from ${S.lo} to ${S.hi}.`;
    } else cfg[k] = n;
  }
  return { cfg, errors };
}

function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", [KEY]))[0];
      let v = null;
      try { v = r ? JSON.parse(r.value) : null; } catch (e) { v = null; }
      CFG = clean(v);
      META = { at: v && Number.isFinite(Number(v.at)) && Number(v.at) > 0 ? Math.floor(Number(v.at)) : null,
               by: v && typeof v.by === "string" ? v.by.slice(0, 60) : null };
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** The limits as set (the card's values): {gap_s, burst, max_secs, tail_ms, tail_ios, window_s}. Synchronous; the defaults until the row is read. */
function current() {
  if (!loaded) init().catch(() => {});
  return { ...CFG, window_s: WINDOW_S };
}

/** Review fix 1: Pepe's /api/bridge/relay/pull or /api/bridge/sync body - ptt_limits: 1 (or true) = he follows each clip job's limits.
 *  The latest such call counts (`now` for the tests); a call without it changes nothing (PEPE_TTL lets it lapse). */
function notePepe(body, now = Date.now()) {
  if (body && typeof body === "object" && (body.ptt_limits === 1 || body.ptt_limits === true)) PEPE_AT = Number(now) || Date.now();
}
/** Review fix 1: Pepe said he follows the job's limits within PEPE_TTL. */
function pepeFollows(now = Date.now()) { return PEPE_AT > 0 && now - PEPE_AT < PEPE_TTL; }
/** The limits in force for an upload now (every upload, the live view and the job's fields ask): current(), with the max length kept
 *  to an older Pepe's 30 s until Pepe says he follows the job's limits (review fix 1). + pepe: whether he does. */
function effective(now = Date.now()) {
  const L = current(), pepe = pepeFollows(now);
  return { ...L, max_secs: pepe ? L.max_secs : Math.min(L.max_secs, OLD_PEPE.max_secs), pepe };
}

/** The body cap for a clip up to `maxSecs` long (bytes) - the length in force by default. */
function maxBytes(maxSecs = effective().max_secs) {
  const s = Number.isFinite(Number(maxSecs)) ? Math.max(0, Number(maxSecs)) : DEFAULTS.max_secs;
  return Math.min(BYTES_CEIL, Math.max(BYTES_FLOOR, Math.ceil((s + 1) * BYTES_PER_SEC)));
}

/** The card's data: the values, the defaults and ranges, who changed them last and the recent changes. */
async function view() {
  await init();
  let audit = [];
  try { audit = await require("./adminaudit").recent(AUDIT, 8); } catch (e) { audit = []; }
  const pepe = pepeFollows();
  return { cfg: { ...CFG }, defaults: { ...DEFAULTS }, limits: LIMITS, window_s: WINDOW_S, at: META.at, by: META.by,
           // review fix 1: whether Pepe follows them (and since when he last said so) + what an older Pepe enforces on his own
           pepe: { follows: pepe, at: PEPE_AT || null, old: { ...OLD_PEPE } }, max_secs_now: effective().max_secs,
           max_bytes: maxBytes(), audit: audit.map((a) => ({ at: a.at, admin: a.admin, reason: a.reason || null, to: a.detail && a.detail.to ? a.detail.to : null })) };
}

/** Save (body: some of gap_s / burst / max_secs / tail_ms / tail_ios, or reset: true; reason optional) as `user` ({userId, username}). Throws Refuse. */
async function save(user, body = {}) {
  await init();
  const task = saving.then(async () => {
    const b = body && typeof body === "object" ? body : {};
    let next;
    if (b.reset === true) next = { ...DEFAULTS };
    else {
      if (!FIELDS.some((k) => Object.prototype.hasOwnProperty.call(b, k))) throw new Refuse(400, "Nothing to save.");
      const { cfg, errors } = validate(b, CFG);
      const bad = FIELDS.find((k) => errors[k]);
      if (bad) throw new Refuse(400, errors[bad], bad);
      next = cfg;
    }
    const from = { ...CFG }, changed = {};
    for (const k of FIELDS) if (next[k] !== from[k]) changed[k] = [from[k], next[k]];
    if (!Object.keys(changed).length) return { cfg: { ...CFG }, changed, unchanged: true };
    const at = Date.now(), by = user && user.username ? String(user.username).slice(0, 60) : null;
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [KEY, JSON.stringify({ ...next, at, by })]);
    CFG = { ...next };
    META = { at, by };
    loaded = true;
    try {
      await require("./adminaudit").record(user || { userId: "system" }, AUDIT, null, { action: b.reset === true ? "reset" : "save", from, to: next, changed },
        typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 200) : null);
    } catch (e) { console.error("[pttlimits] audit:", e.message); }
    console.log(`[pttlimits] push-to-talk clips: cooldown ${next.gap_s}s, ${next.burst} per ${WINDOW_S / 60} min, up to ${next.max_secs}s, ` +
                `release tail ${next.tail_ms} ms${next.tail_ios ? " (iOS too)" : ""} (${by || "?"})`);
    return { cfg: { ...CFG }, changed };
  });
  saving = task.catch(() => {});
  return task;
}

/** GET / POST /api/admin/pttlimits (site admins: pads.config by the class in the database; POST: a same-origin fetch). */
function register(app, { addUser }) {
  init().catch((e) => console.error("[pttlimits] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const admin = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    let row = null;
    try { row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(req.user.userId)]))[0] || null; } catch (e) { row = null; }
    if (!row || !SP.can(row, "pads.config")) return res.status(403).json({ ok: false, error: "Site admins only." });
    req.pttAdmin = { userId: row.userId, username: row.username };
    next();
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) });
    console.error("[pttlimits]", e);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/admin/pttlimits", addUser, admin, async (req, res) => {
    try { res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pttlimits", addUser, admin, json, async (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    try { const out = await save(req.pttAdmin, req.body || {}); res.json({ ok: true, ...out, view: await view() }); }
    catch (e) { fail(res, e); }
  });
}

module.exports = { init, current, effective, notePepe, pepeFollows, maxBytes, view, save, validate, clean, register, SPEC, FIELDS, DEFAULTS,
                   LIMITS, WINDOW_S, BYTES_PER_SEC, BYTES_FLOOR, BYTES_CEIL, OLD_PEPE, PEPE_TTL, AUDIT, KEY,
                   _reset: () => { CFG = { ...DEFAULTS }; META = { at: null, by: null }; loaded = false; ready = null; saving = Promise.resolve(); PEPE_AT = 0; } };
