// fastgrab.js — ⚡ Pepe's fast mic grab (!mic fastgrab) from the site (grabcard, 1.99amm). Site Admins only.
//
// The owner, 2026-11-08: "where do i set the mic relay cooldowns and adjustable grab limits on the site?". The push-to-talk clip
// limits are the Bridge page's card (/admin/bridge#pttlimits, pttlimits.js); the fast-grab switches and caps - until now chat only
// (!mic fastgrab ... [-global|-all]) and Pepe's own panel on the VM - are this card: "Fast mic grab" on /admin/pepe/rooms#fastgrab
// (views/admin/pepeRooms.ejs + public/js/admin-fastgrab.js).
//
//   Pepe   --POST /api/pepe/rooms/state {state: {..., fastgrab}}-->  the values he has now (roomctl.js keeps the state; the fastgrab
//          block is cleaned here: the global and every room he is in or that has values of its own - each field's value, room vs
//          global marks, contest active / why; the ranges, defaults and claim modes; his last changes with what he stored and
//          clamped). Every ~20 s, and 0.5 s after a change.
//   admin  --POST /api/admin/pepe/fastgrab {scope, room, set: {field: value}, reason?}-->  ONE website action kind "mic.fastgrab"
//          [scope, room, "field=value", ...] (actions.js) + one admin_audit row "pepe.fastgrab" {scope, room, set, from, action}
//          in the same transaction. Pepe (camfrog-bot pepe_fastgrabweb.py) checks the whole change, runs each field through
//          the !mic fastgrab command itself (its clamps, the contest bundle, the hook push, the save), acks with the values
//          he stored + what he clamped, and pushes his state at once.
//   admin  --GET  /api/admin/pepe/fastgrab-->  {online, at, fg, actions (the last mic.fastgrab actions + Pepe's answers), audit}
//
// Fields (the command's own words): on | contest | fair | web | chatty | blockbreak | selfunblock (on / off), claim (Pepe's modes),
// rate | shots | tries | ceiling (a whole number), breaker (3) | pause (4) | fairwait (2) (whole numbers), unblockcode (text), and -
// for a room - follow (drop the room's own value; it follows the global again).
// 1.99?? micblock (the owner, 11-08: "give me a toggle to remove this courtesy" / "I do want that in Players_Lounge (add this to the
// admin page too, a toggle plus field for whatever the unblock code is in case it changes or is different in another room)"):
// blockbreak = someone blocking Pepe's mic puts that room's mic on a 30-minute break (on by default, as before); selfunblock = when
// someone blocks Pepe's mic there he types the room's unblockcode (for a room bot that unblocks whoever types it - Players Lounge's
// is "1"; off by default). The code is checked here exactly as Pepe checks it (codeClean = pepe_fastgrabweb.unblock_code_clean):
// 1-20 printable characters, trimmed, case kept, never a leading "/" or "!" - the line can never be a Camfrog or a Pepe command. The ceiling is every room's whatever the scope. The site checks the SHAPE (a known field,
// on/off, a claim Pepe offers, the right count of whole numbers, a room Pepe reports); the RANGES are Pepe's - a number outside
// one is clamped by him and the card shows "asked -> stored".
// Guards: the Admin class (pepe.rooms_commands_audio, read from the account's row in the database - a stale sign-in can't), a
// same-site fetch (X-Requested-With: fetch + guard.sameSite), 20 changes a minute per admin, Pepe online and reporting the
// fastgrab block (an older Pepe: refused, use !mic fastgrab in a room); Pepe re-checks site_admin.
"use strict";
const { getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const guard = require("./middleware/authGuard");

const CAP = "pepe.rooms_commands_audio";
const KIND = "mic.fastgrab";
const AUDIT = "pepe.fastgrab";
const TAG = "pepe-fastgrab";
const SCOPES = ["room", "global", "all"];
const TOGGLES = ["on", "contest", "fair", "web", "chatty", "blockbreak", "selfunblock"];
const CLAIMS = ["swallow", "release", "plain"];
const ARITY = Object.freeze({ rate: 1, shots: 1, tries: 1, breaker: 3, pause: 4, fairwait: 2, ceiling: 1 });
const CAPS = Object.keys(ARITY);
const TEXTS = ["unblockcode"];
const CODE_MAX = 20;
const CODE_MD = ["*", "`", "__", "~~"];                  // (review F8: Pepe's send_chat markdown strip)
// (the card's order; Pepe applies contest first)
const FIELDS = Object.freeze(["on", "contest", "fair", "claim", "web", "chatty", ...CAPS, "blockbreak", "selfunblock", "unblockcode"]);
const FOLLOW = "follow";
const NUM_MAX = 1000000;
const ROOMS_MAX = 20;
const LAST_MAX = 8;
const RATE = { max: 20, windowMs: 60 * 1000 };
const hits = guard.limiter(RATE);
const LABEL = { on: "fast grab", contest: "contest", fair: "fair", web: "web clips", chatty: "chatty", claim: "claim",
                blockbreak: "block break", selfunblock: "self-unblock", unblockcode: "unblock code" };

class Refuse extends Error {
  constructor(status, msg, field = null) { super(msg); this.status = status; this.refuse = true; this.field = field; }
}

const own = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const int = (v) => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= NUM_MAX ? v : null);
const ints = (v, n) => {
  const a = n === 1 && !Array.isArray(v) ? [v] : v;
  if (!Array.isArray(a) || a.length !== n) return null;
  const out = a.map(int);
  return out.every((x) => x !== null) ? out : null;
};

/** 1.99?? micblock: a room's unblock code -> {code, err} - Pepe's own check (pepe_fastgrabweb.unblock_code_clean): trimmed; "" / none /
    off = no code; else 1-CODE_MAX printable characters (no control, format or separator character but a plain space) that never start
    with "/" or "!" - and (review F8) nothing his chat layer would change: no * or `, no __ or ~~ (send_chat's markdown strip sends "*1*"
    as "1"), no word starting with "-" (a chat flag: "1 -global" sets "1" for every room). */
function codeClean(v) {
  if (v != null && typeof v !== "string") return { code: "", err: "text" };
  const s = String(v == null ? "" : v).trim();
  if (["", "none", "off", "-"].includes(s.toLowerCase())) return { code: "", err: null };
  if ([...s].length > CODE_MAX) return { code: "", err: `at most ${CODE_MAX} characters` };
  if (/[\p{C}\p{Z}]/u.test(s.replace(/ /g, ""))) return { code: "", err: "printable characters only" };
  if (s[0] === "/" || s[0] === "!") return { code: "", err: "it can't start with / or ! (that would be a command)" };
  if (CODE_MD.some((m) => s.includes(m))) return { code: "", err: "no * or ` and no __ or ~~ (the chat would strip them)" };
  if (s.split(/\s+/).some((w) => w.startsWith("-"))) return { code: "", err: "no word may start with - (that is a chat flag)" };
  return { code: s, err: null };
}

/** One room's (or the global's) values from Pepe -> only the fields the card shows, each its own type (a bad one = left out). */
function cleanValues(o, room) {
  if (!o || typeof o !== "object") return null;
  const v = {};
  for (const k of TOGGLES) if (typeof o[k] === "boolean") v[k] = o[k];
  if (typeof o.claim === "string" && /^[a-z]{1,12}$/.test(o.claim)) v.claim = o.claim;
  for (const k of TEXTS) {
    const c = typeof o[k] === "string" ? codeClean(o[k]) : null;
    if (c && !c.err) v[k] = c.code;
  }
  for (const k of CAPS) {
    const n = ints(o[k], ARITY[k]);
    if (n) v[k] = ARITY[k] === 1 ? n[0] : n;
  }
  if (room) {
    if (typeof o.contest_active === "boolean") v.contest_active = o.contest_active;
    v.contest_why = typeof o.contest_why === "string" && o.contest_why.trim() ? str(o.contest_why, 160) : null;
    const r = int(o.resting_min);
    v.resting_min = r !== null && r > 0 ? r : null;
  }
  return v;
}

/** Pepe's fastgrab block (the rooms state push) -> what the card shows, nothing else. null = no block (an older Pepe). */
function cleanState(s) {
  if (!s || typeof s !== "object" || !(Number(s.v) >= 1)) return null;
  const claims = (Array.isArray(s.claims) ? s.claims : []).map((c) => str(c, 12)).filter((c) => /^[a-z]{1,12}$/.test(c)).slice(0, 6);
  const ranges = {}, defaults = {};
  for (const k of CAPS) {
    const r = Array.isArray(s.ranges && s.ranges[k]) ? s.ranges[k] : null;
    const rr = r && r.length === ARITY[k] ? r.map((p) => ints(p, 2)) : null;
    if (rr && rr.every(Boolean)) ranges[k] = rr;
    const d = ints(s.defaults && s.defaults[k], ARITY[k]);
    if (d) defaults[k] = ARITY[k] === 1 ? d[0] : d;
  }
  for (const k of TOGGLES) if (s.defaults && typeof s.defaults[k] === "boolean") defaults[k] = s.defaults[k];
  if (s.defaults && typeof s.defaults.claim === "string") defaults.claim = str(s.defaults.claim, 12);
  for (const k of TEXTS) {
    const c = s.defaults && typeof s.defaults[k] === "string" ? codeClean(s.defaults[k]) : null;
    if (c && !c.err) defaults[k] = c.code;
  }
  const rooms = (Array.isArray(s.rooms) ? s.rooms : []).slice(0, 3 * ROOMS_MAX).map((r) => {
    const id = r && typeof r === "object" ? str(r.id, 128) : "";
    const values = id ? cleanValues(r.values, true) : null;
    if (!values) return null;
    const ownMarks = {};
    for (const k of FIELDS) if (k !== "ceiling" && r.own && (r.own[k] === "room" || r.own[k] === "mixed")) ownMarks[k] = r.own[k];
    return { id, name: str(r.name, 80) || id, joined: r.joined !== false, values, own: ownMarks };
  }).filter(Boolean).slice(0, ROOMS_MAX);
  const last = (Array.isArray(s.last) ? s.last : []).slice(-LAST_MAX).map((x) => {
    if (!x || typeof x !== "object") return null;
    const set = {}, clamped = {};
    for (const k of FIELDS) {
      if (!own(x.set, k)) continue;
      const val = x.set[k];
      if (TEXTS.includes(k)) {
        const c = typeof val === "string" ? codeClean(val) : null;
        if (c && !c.err) set[k] = c.code;
      } else if (TOGGLES.includes(k) ? typeof val === "boolean" : k === "claim" ? typeof val === "string" : !!ints(val, ARITY[k])) {
        set[k] = k === "claim" ? str(val, 12) : val;
      }
      const c = own(x.clamped, k) ? x.clamped[k] : null;
      const asked = c && ints(c.asked, ARITY[k]), stored = c && ints(c.stored, ARITY[k]);
      if (asked && stored) clamped[k] = { asked, stored };
    }
    return { id: str(x.id, 20), ts: Number(x.ts) > 0 ? Math.round(Number(x.ts) * 1000) : null, by: str(x.by, 60),
             scope: SCOPES.includes(x.scope) ? x.scope : null, room: x.room ? str(x.room, 128) : null, set, clamped,
             followed: (Array.isArray(x.followed) ? x.followed : []).filter((k) => FIELDS.includes(k)), msg: str(x.msg, 240) };
  }).filter(Boolean);
  return { v: 1, claims: claims.length ? claims : CLAIMS.slice(), ranges, defaults, global: cleanValues(s.global, false) || {}, rooms, last };
}

/** The roomctl state (Pepe's last push): {online, at, fg}. */
async function pepe() {
  const v = await require("./roomctl").view();
  return { online: !!v.online, at: v.at || null, fg: v.state && v.state.fastgrab ? v.state.fastgrab : null };
}

/** An admin's body -> {scope, room, set (normalized), args} - strict; throws Refuse(400 / 404) naming the field. */
function validate(b, fg) {
  const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  const scope = String(body.scope || "").toLowerCase();
  if (!SCOPES.includes(scope)) throw new Refuse(400, "Where: a room, the global default or every room?", "scope");
  let room = "";
  if (scope === "room") {
    room = str(body.room, 128);
    const known = (fg && fg.rooms || []).find((r) => r.id === room) || (fg && fg.rooms || []).find((r) => r.id.toLowerCase() === room.toLowerCase());
    if (!room) throw new Refuse(400, "Which room?", "room");
    if (!known) throw new Refuse(404, "Pepe doesn't report that room - reload the page.", "room");
    room = known.id;
  }
  const src = body.set && typeof body.set === "object" && !Array.isArray(body.set) ? body.set : null;
  if (!src) throw new Refuse(400, "Nothing to save.", "set");
  const keys = Object.keys(src);
  if (!keys.length) throw new Refuse(400, "Nothing to save.", "set");
  const bad = keys.find((k) => !FIELDS.includes(k));
  if (bad) throw new Refuse(400, `Pepe has no fast-grab setting called ${str(bad, 30)}.`, str(bad, 30));
  const claims = fg && Array.isArray(fg.claims) && fg.claims.length ? fg.claims : CLAIMS;
  const set = {}, args = [scope, room];
  for (const k of FIELDS) {
    if (!own(src, k)) continue;
    const v = src[k];
    let enc;
    if (v === FOLLOW || v === null) {
      if (k === "ceiling") throw new Refuse(400, "The ceiling is every room's - there's no global to follow.", k);
      if (scope !== "room") throw new Refuse(400, "Follow the global is for one room's own value.", k);
      set[k] = FOLLOW; enc = FOLLOW;
    } else if (TEXTS.includes(k)) {
      const c = codeClean(v);
      if (c.err) throw new Refuse(400, `${LABEL[k]}: ${c.err === "text" ? "text" : c.err}.`, k);
      set[k] = c.code; enc = c.code;
    } else if (TOGGLES.includes(k)) {
      const on = v === true || v === "on" ? true : v === false || v === "off" ? false : null;
      if (on === null) throw new Refuse(400, `${LABEL[k]}: on or off.`, k);
      set[k] = on; enc = on ? "on" : "off";
    } else if (k === "claim") {
      const c = String(v || "").toLowerCase();
      if (!claims.includes(c)) throw new Refuse(400, `claim: ${claims.join(", ")}.`, k);
      set[k] = c; enc = c;
    } else {
      const raw = typeof v === "string" ? v.split(",").map((p) => p.trim()) : Array.isArray(v) ? v : [v];
      const nums = raw.map((p) => (typeof p === "string" && /^-?\d{1,7}$/.test(p) ? Number(p) : p));
      const n = ints(nums, ARITY[k]);
      if (!n) throw new Refuse(400, `${k}: ${ARITY[k] === 1 ? "a whole number" : ARITY[k] + " whole numbers"}.`, k);
      set[k] = ARITY[k] === 1 ? n[0] : n; enc = n.join(",");
    }
    args.push(`${k}=${enc}`);
  }
  return { scope, room, set, args };
}

/** What a change replaces (Pepe's last report) - for the audit row. */
function fromOf(fg, scope, room, set) {
  const vals = scope === "room" ? ((fg.rooms || []).find((r) => r.id === room) || {}).values || {} : fg.global || {};
  const out = {};
  for (const k of Object.keys(set)) out[k] = k === "ceiling" ? (fg.global || {}).ceiling ?? vals.ceiling ?? null : own(vals, k) ? vals[k] : null;
  return out;
}

function labelOf(scope, room, fg, set) {
  const where = scope === "room" ? (((fg.rooms || []).find((r) => r.id === room) || {}).name || room) : scope === "all" ? "every room" : "global";
  const parts = Object.keys(set).map((k) => {
    const v = set[k];
    if (TEXTS.includes(k) && v !== FOLLOW) return v ? `${LABEL[k]} "${v}"` : `${LABEL[k]} none`;
    return v === FOLLOW ? `${k} follows global` : typeof v === "boolean" ? `${LABEL[k]} ${v ? "on" : "off"}` : `${k} ${Array.isArray(v) ? v.join("/") : v}`;
  });
  return `Fast grab (${where}): ${parts.join(", ")}`;
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
  return { now: Date.now(), online: p.online, at: p.at, fg: p.fg, fields: FIELDS, arity: ARITY,
           actions, audit: audit.map((a) => ({ at: a.at, admin: a.admin, reason: a.reason || null, detail: a.detail || null })) };
}

/** An admin's change (`user` = the account's row from the database) -> {id, args}. */
async function request(user, body = {}) {
  if (!user || !SP.can(user, CAP)) throw new Refuse(403, "Admins only.");
  const p = await pepe();
  if (!p.online) throw new Refuse(409, "Pepe isn't reporting his rooms right now (offline?) - try again in a minute.");
  if (!p.fg) throw new Refuse(409, "This Pepe doesn't report his fast-grab settings yet - use !mic fastgrab in a room (or his own panel) until he does.");
  const { scope, room, set, args } = validate(body, p.fg);
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} fast-grab changes a minute.`);
  hits.hit(key);
  const reason = typeof body.reason === "string" && body.reason.trim() ? str(body.reason, 200) : null;
  const A = require("./actions"), AA = require("./adminaudit");
  await A.recentFor(user.userId, TAG, 1);          // (the actions table is ready before the transaction)
  await AA.init();
  let id;
  try {
    id = await tx(async () => {
      const aid = await A.queue(user.userId, { kind: KIND, args, tag: TAG, label: labelOf(scope, room, p.fg, set), dedupe: true });
      await AA.record({ userId: user.userId, username: user.username }, AUDIT, null,
        { scope, room: room || null, set, from: fromOf(p.fg, scope, room, set), action: aid }, reason);
      return aid;
    });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    if (e && e.message === "duplicate") throw new Refuse(409, "That exact change is already waiting for Pepe.");
    console.error("[fastgrab] queue / audit:", e && e.message);
    throw new Refuse(500, "Couldn't queue it (or write the audit log) - nothing was changed.");
  }
  console.log(`[fastgrab] ${user.username || user.userId}: ${args.join(" ")} -> action ${id}`);
  return { id, args };
}

function register(app, { addUser }) {
  const admin = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    let row = null;
    try { row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(req.user.userId)]))[0] || null; } catch (e) { row = null; }
    if (!row || !SP.can(row, CAP) || !SP.can(req.user, CAP)) return res.status(403).json({ ok: false, error: "Admins only." });
    req.fgAdmin = { userId: row.userId, username: row.username, class: row.class };
    next();
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) });
    console.error("[fastgrab]", e);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/api/admin/pepe/fastgrab", addUser, admin, async (req, res) => {
    try { res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/fastgrab", addUser, admin, async (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    try { res.json({ ok: true, ...(await request(req.fgAdmin, req.body || {})) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, cleanState, cleanValues, validate, view, request, Refuse, KIND, AUDIT, TAG, FIELDS, TOGGLES, CAPS, ARITY,
                   CLAIMS, SCOPES, FOLLOW, RATE, TEXTS, CODE_MAX, codeClean, _hits: hits };
