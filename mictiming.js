// mictiming.js — ⏱ Pepe's mic timing pads, his speed-ups and the !mic yield list from the site (micspeed, 1.99??). Site Admins only.
//
// The owner, 2026-11-08: the timing pads on Pepe's own panel (grab confirm, lead-in, tail-out, the web clip settle) - "Lets add this to
// the web panel as well"; for PepeLite, his own helper that grabs the mic for him - "Give pepe a list of people he should yield the mic
// to when the yield command is active. (Admin page configurable)"; and the speed-ups a measurement of every wait between Pepe taking the
// mic and the clip's first sample found, each a setting he can turn back. The card: "Mic timing" on /admin/pepe/rooms#mictiming
// (views/admin/pepeRooms.ejs + public/js/admin-mictiming.js), beside the Fast mic grab card - the same path (fastgrab.js):
//
//   Pepe   --POST /api/pepe/rooms/state {state: {..., mictiming}}-->  the values he has now (roomctl.js keeps the state; the block is
//          cleaned here: each field's value, the defaults and ranges, the yield's state - on / minutes left / by whom / the rooms where
//          someone on the list is - and his last changes with what he stored and clamped). Every ~20 s, and 0.5 s after a change.
//   admin  --POST /api/admin/pepe/mictiming {set: {field: value}, reason?}-->  ONE website action kind "mic.timing" ["field=value", ...]
//          (actions.js) + one admin_audit row "pepe.mictiming" {set, from, action} in the same transaction. Pepe (camfrog-bot
//          pepe_micspeed.py) checks the whole change, clamps each value to its range, saves, acks with what he stored, pushes his
//          state at once. His own panel (port 8766 on the VM) writes the same settings - each side shows the other's changes.
//   admin  --GET  /api/admin/pepe/mictiming-->  {online, at, mt, actions (the last mic.timing actions + Pepe's answers), audit}
//
// Fields (all global - one mic, one set of timings): grabconfirm | leadin | tailout | websettle (seconds), talkplay (on / off - the Talk
// check runs during the clip), confirm | clickretry | ttspoll (milliseconds: the fast grab's confirm window, the hook's second-click
// wait, the TTS ready poll), yieldlist (Camfrog logins, at most 20 - !mic yield on [minutes] | off | status in a room turns it on).
// The site checks the SHAPE (a known field, a number with at most 2 decimals / a whole number, on / off, a list of logins); the RANGES are
// Pepe's - a number outside one is clamped by him and the card shows "asked -> stored".
// Guards: the Admin class (pepe.rooms_commands_audio, from the account's row in the database), a same-site fetch (X-Requested-With:
// fetch + guard.sameSite), 20 changes a minute per admin, Pepe online and reporting the block (an older Pepe: refused); Pepe re-checks
// site_admin.
"use strict";
const { getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const guard = require("./middleware/authGuard");

const CAP = "pepe.rooms_commands_audio";
const KIND = "mic.timing";
const AUDIT = "pepe.mictiming";
const TAG = "pepe-mictiming";
const SECS = ["grabconfirm", "leadin", "tailout", "websettle"];
const TOGGLES = ["talkplay"];
const MILLIS = ["confirm", "clickretry", "ttspoll"];
const LISTS = ["yieldlist"];
const FIELDS = Object.freeze([...SECS, ...TOGGLES, ...MILLIS, ...LISTS]);   // (the card's order = Pepe's pepe_micspeed.FIELDS)
const YIELD_MAX = 20;
const LOGIN_MAX = 40;
const SEC_MAX = 999;                     // (Pepe's shape: up to 3 digits; his ranges are much smaller - he clamps)
const MS_MAX = 999999;
const LAST_MAX = 8;
const ROOMS_MAX = 20;
const RATE = { max: 20, windowMs: 60 * 1000 };
const hits = guard.limiter(RATE);
const LABEL = { grabconfirm: "grab confirm", leadin: "lead-in", tailout: "tail-out", websettle: "web clip settle",
                talkplay: "Talk check during the clip", confirm: "fast-grab confirm", clickretry: "second-click retry",
                ttspoll: "TTS ready poll", yieldlist: "yield list" };
const UNIT = { grabconfirm: "s", leadin: "s", tailout: "s", websettle: "s", confirm: "ms", clickretry: "ms", ttspoll: "ms" };

class Refuse extends Error {
  constructor(status, msg, field = null) { super(msg); this.status = status; this.refuse = true; this.field = field; }
}

const own = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const num = (v, max) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max ? v : null);
const secs = (v) => { const n = num(v, SEC_MAX); return n === null ? null : Math.round(n * 100) / 100; };
const millis = (v) => { const n = num(v, MS_MAX); return n !== null && Number.isInteger(n) ? n : null; };

/** A yield list as typed (one string split on commas / spaces / new lines, or an array) -> {logins, err} - Pepe's own check
    (pepe_micspeed.yield_list_clean): lower case, trimmed, duplicates dropped, 1-40 printable characters each (no , or ;), at most
    20; "" / none = nobody. */
function listClean(v) {
  if (v == null) return { logins: [], err: null };
  let parts;
  if (Array.isArray(v)) parts = v.map((x) => String(x == null ? "" : x));
  else if (typeof v === "string") parts = v.split(/[\s,;]+/);
  else return { logins: [], err: "logins, comma-separated" };
  const out = [];
  for (const p of parts) {
    const s = String(p).trim().toLowerCase();
    if (!s) continue;
    if ((s === "none" || s === "-") && parts.length === 1) return { logins: [], err: null };
    if ([...s].length > LOGIN_MAX) return { logins: [], err: `a login is at most ${LOGIN_MAX} characters (${s.slice(0, 20)}...)` };
    if (/[\u0000-\u001f\u007f,;]/.test(s) || /[\p{C}]/u.test(s)) return { logins: [], err: "printable logins only" };
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > YIELD_MAX) return { logins: [], err: `at most ${YIELD_MAX} logins` };
  return { logins: out, err: null };
}

/** One field's value from Pepe -> its own type, or undefined (left out). */
function cleanField(k, v) {
  if (SECS.includes(k)) { const n = secs(v); return n === null ? undefined : n; }
  if (MILLIS.includes(k)) { const n = millis(v); return n === null ? undefined : n; }
  if (TOGGLES.includes(k)) return typeof v === "boolean" ? v : undefined;
  if (LISTS.includes(k)) { const c = listClean(Array.isArray(v) ? v : null); return Array.isArray(v) && !c.err ? c.logins : undefined; }
  return undefined;
}

function cleanValues(o) {
  const v = {};
  if (!o || typeof o !== "object") return v;
  for (const k of FIELDS) { const x = cleanField(k, o[k]); if (x !== undefined) v[k] = x; }
  return v;
}

function cleanYield(y) {
  const o = y && typeof y === "object" ? y : {};
  const on = o.on === true;
  const until = Number(o.until) > 0 ? Math.round(Number(o.until) * 1000) : null;
  const left = Number.isInteger(o.left_min) && o.left_min > 0 ? Math.min(o.left_min, 100000) : null;
  const present = (Array.isArray(o.present) ? o.present : []).slice(0, ROOMS_MAX).map((r) => {
    if (!r || typeof r !== "object" || !str(r.room, 128)) return null;
    const who = (Array.isArray(r.who) ? r.who : []).slice(0, YIELD_MAX).map((x) => str(x, 60)).filter(Boolean);
    const holding = (Array.isArray(r.holding) ? r.holding : []).slice(0, YIELD_MAX).map((x) => str(x, 60)).filter(Boolean);
    return { room: str(r.room, 128), name: str(r.name, 80) || str(r.room, 128), who, holding };
  }).filter(Boolean);
  return { on, until: on ? until : null, left_min: on ? left : null, by: on ? str(o.by, 60) : "", present: on ? present : [],
           default_min: Number.isInteger(o.default_min) && o.default_min > 0 ? o.default_min : 60,
           max_min: Number.isInteger(o.max_min) && o.max_min > 0 ? o.max_min : 720 };
}

/** Pepe's mictiming block (the rooms state push) -> what the card shows, nothing else. null = no block (an older Pepe). */
function cleanState(s) {
  if (!s || typeof s !== "object" || !(Number(s.v) >= 1)) return null;
  const ranges = {};
  for (const k of [...SECS, ...MILLIS]) {
    const r = Array.isArray(s.ranges && s.ranges[k]) ? s.ranges[k] : null;
    const lo = r ? (SECS.includes(k) ? secs(r[0]) : millis(r[0])) : null, hi = r ? (SECS.includes(k) ? secs(r[1]) : millis(r[1])) : null;
    if (r && r.length === 2 && lo !== null && hi !== null) ranges[k] = [lo, hi];
  }
  const last = (Array.isArray(s.last) ? s.last : []).slice(-LAST_MAX).map((x) => {
    if (!x || typeof x !== "object") return null;
    const set = {}, clamped = {};
    for (const k of FIELDS) {
      if (own(x.set, k)) { const v = cleanField(k, x.set[k]); if (v !== undefined) set[k] = v; }
      const c = own(x.clamped, k) ? x.clamped[k] : null;
      if (c && typeof c === "object") {
        const a = cleanField(k, c.asked), st = cleanField(k, c.stored);
        if (a !== undefined && st !== undefined) clamped[k] = { asked: a, stored: st };
      }
    }
    return { id: str(x.id, 20), ts: Number(x.ts) > 0 ? Math.round(Number(x.ts) * 1000) : null, by: str(x.by, 60), set, clamped,
             msg: str(x.msg, 240) };
  }).filter(Boolean);
  return { v: 1, values: cleanValues(s.values), defaults: cleanValues(s.defaults), ranges, yield: cleanYield(s.yield), last };
}

/** The roomctl state (Pepe's last push): {online, at, mt}. */
async function pepe() {
  const v = await require("./roomctl").view();
  return { online: !!v.online, at: v.at || null, mt: v.state && v.state.mictiming ? v.state.mictiming : null };
}

/** An admin's body -> {set (normalized), args} - strict; throws Refuse(400) naming the field. */
function validate(b) {
  const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  const src = body.set && typeof body.set === "object" && !Array.isArray(body.set) ? body.set : null;
  if (!src || !Object.keys(src).length) throw new Refuse(400, "Nothing to save.", "set");
  const bad = Object.keys(src).find((k) => !FIELDS.includes(k));
  if (bad) throw new Refuse(400, `Pepe has no mic timing setting called ${str(bad, 30)}.`, str(bad, 30));
  const set = {}, args = [];
  for (const k of FIELDS) {
    if (!own(src, k)) continue;
    const v = src[k];
    let enc;
    if (SECS.includes(k)) {
      const n = secs(typeof v === "string" && /^-?\d{1,3}(\.\d{1,3})?$/.test(v.trim()) ? Number(v.trim()) : v);
      if (n === null) throw new Refuse(400, `${LABEL[k]}: seconds (e.g. 0.25).`, k);
      set[k] = n; enc = n.toFixed(2);
    } else if (MILLIS.includes(k)) {
      const n = millis(typeof v === "string" && /^-?\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : v);
      if (n === null) throw new Refuse(400, `${LABEL[k]}: whole milliseconds.`, k);
      set[k] = n; enc = String(n);
    } else if (TOGGLES.includes(k)) {
      const on = v === true || v === "on" ? true : v === false || v === "off" ? false : null;
      if (on === null) throw new Refuse(400, `${LABEL[k]}: on or off.`, k);
      set[k] = on; enc = on ? "on" : "off";
    } else {
      const c = listClean(v);
      if (c.err) throw new Refuse(400, `${LABEL[k]}: ${c.err}.`, k);
      set[k] = c.logins; enc = c.logins.join(",");
    }
    args.push(`${k}=${enc}`);
  }
  return { set, args };
}

function fmt(k, v) {
  if (v == null) return "–";
  if (TOGGLES.includes(k)) return v ? "on" : "off";
  if (LISTS.includes(k)) return v.length ? v.join(", ") : "nobody";
  return `${v} ${UNIT[k]}`;
}

function labelOf(set) {
  return "Mic timing: " + Object.keys(set).map((k) => `${LABEL[k]} ${fmt(k, set[k])}`).join(", ");
}

/** What a change replaces (Pepe's last report) - for the audit row. */
function fromOf(mt, set) {
  const vals = (mt && mt.values) || {};
  const out = {};
  for (const k of Object.keys(set)) out[k] = own(vals, k) ? vals[k] : null;
  return out;
}

/** The card's data. */
async function view() {
  const p = await pepe();
  let actions = [], audit = [];
  try {
    actions = await getQuery(`SELECT id, username, label, status, message, code, created, updated FROM pepe_actions
                              WHERE kind = ? ORDER BY id DESC LIMIT 12`, [KIND]);
  } catch (e) { actions = []; }
  try { audit = await require("./adminaudit").recent(AUDIT, 10); } catch (e) { audit = []; }
  return { now: Date.now(), online: p.online, at: p.at, mt: p.mt, fields: FIELDS, actions,
           audit: audit.map((a) => ({ at: a.at, admin: a.admin, reason: a.reason || null, detail: a.detail || null })) };
}

/** An admin's change (`user` = the account's row from the database) -> {id, args}. */
async function request(user, body = {}) {
  if (!user || !SP.can(user, CAP)) throw new Refuse(403, "Admins only.");
  const p = await pepe();
  if (!p.online) throw new Refuse(409, "Pepe isn't reporting his rooms right now (offline?) - try again in a minute.");
  if (!p.mt) throw new Refuse(409, "This Pepe doesn't report his mic timing yet - use his own panel until his update runs.");
  const { set, args } = validate(body);
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} mic timing changes a minute.`);
  hits.hit(key);
  const reason = typeof body.reason === "string" && body.reason.trim() ? str(body.reason, 200) : null;
  const A = require("./actions"), AA = require("./adminaudit");
  await A.recentFor(user.userId, TAG, 1);          // (the actions table is ready before the transaction)
  await AA.init();
  let id;
  try {
    id = await tx(async () => {
      const aid = await A.queue(user.userId, { kind: KIND, args, tag: TAG, label: labelOf(set), dedupe: true });
      await AA.record({ userId: user.userId, username: user.username }, AUDIT, null, { set, from: fromOf(p.mt, set), action: aid }, reason);
      return aid;
    });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    if (e && e.message === "duplicate") throw new Refuse(409, "That exact change is already waiting for Pepe.");
    console.error("[mictiming] queue / audit:", e && e.message);
    throw new Refuse(500, "Couldn't queue it (or write the audit log) - nothing was changed.");
  }
  console.log(`[mictiming] ${user.username || user.userId}: ${args.join(" ")} -> action ${id}`);
  return { id, args };
}

function register(app, { addUser }) {
  const admin = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    let row = null;
    try { row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(req.user.userId)]))[0] || null; } catch (e) { row = null; }
    if (!row || !SP.can(row, CAP) || !SP.can(req.user, CAP)) return res.status(403).json({ ok: false, error: "Admins only." });
    req.mtAdmin = { userId: row.userId, username: row.username, class: row.class };
    next();
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) });
    console.error("[mictiming]", e);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/admin/pepe/mictiming", addUser, admin, async (req, res) => {
    try { res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/mictiming", addUser, admin, async (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    try { res.json({ ok: true, ...(await request(req.mtAdmin, req.body || {})) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, cleanState, cleanValues, validate, view, request, listClean, Refuse, KIND, AUDIT, TAG, FIELDS, SECS, TOGGLES,
                   MILLIS, LISTS, YIELD_MAX, LOGIN_MAX, RATE, _hits: hits };
