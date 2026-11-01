// veil.js - wave 2 WP-2 (incognito / mic-stage spec A.3-A.5, B.2, B.3, C, D; owner answers section M): the website side of the
// PRIVACY WIRE v2 - what bridge.js does with Pepe's full form (privwire.js is the switch; the route lives in bridge.js).
//
// The rule (A.4): a veiled person's REAL identity and a hidden speaker's words never go into a stored item, a stored snapshot or
// any JSON a reader serialises. A veiled live item / roster entry is page-safe:
//   u = {anon: true, display: "someone", veil: "incognito" | "hidden", alias?, hood?, id?}
// - alias / hood = the frog name of the person's chat session in this pad (frognames.js: per pad, per appearance, unlinkable);
//   absent when C.2 allows no name (seen named < 15 min ago), for an unproven mic holder (B.2) and for the release of a hold that
//   began named (B.2) - those show "someone";
// - id = an opaque, stable id of that session in this pad (HMAC(ALIAS_SECRET, room, session), cut short) - never a login, never
//   the incog_alias row id, never a hold id; only with an alias (hand-off 15's C2 and WP-4's covers match entries by it);
// - text = Pepe's redacted text (incognito: "who, not what"); a hidden line has NO text, only mask "s" | "m" | "l" (D.2);
// - ah / ahs = the hidden-set hashes, server-only like Pepe's anonymised lines (chatlogview.dress is a whitelist);
// - hold / at = the mic hold id and when a 🎙 line was said (B.3).
// The real identity hangs on the item as NON-ENUMERABLE properties (_vz {login, display, kind, h, hs, sess}, _vw = hidden words),
// so JSON.stringify can never emit it - and is stored only in side tables keyed by the row (bridge_veil for the live ring,
// bridge_rooms_veil for snapshots, chat_log_veil for the archive) that no older build reads. Invariant: EVERY veiled entry in
// R.members, R.mic and R.feed keeps anon: true - the ~10 readers of R.members / R.mic (micfollow, livecam, aigen, camclip,
// bridge-relay, stagemiccap, roomrtc, padmod, roomactivity, the summary) all skip anon entries, so a veiled person is never staged,
// never cam-opened, never named by any of them (test/veil-storage.test.js).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = new Set(["incognito", "hidden"]);
const HASH20 = /^[0-9a-f]{20}$/;
const HOLD_RE = /^hd-[0-9a-f]{8,32}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;
const HS_MAX = 32;
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const cpStr = (v, n) => {
  const s = String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("").replace(/[\uD800-\uDBFF]$/, "");
};
const plain = (v, n) => cpStr(String(v == null ? "" : v).replace(/<[^>]*>/g, ""), n);
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Define a non-enumerable, rewritable property (never serialised, never copied by Object.assign / spread). */
function hide(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
  return obj;
}
/** D.2: the bar's length - code points of the trimmed words (JS spread = Python len): s <= 24, m 25-100, l > 100. */
function bucket(words) {
  const n = [...String(words == null ? "" : words).trim()].length;
  return n <= 24 ? "s" : n <= 100 ? "m" : "l";
}
/** Pepe's priv block -> {kind, h, hs[], at (ms) | null, words} | null (none, or anything malformed: then the event isn't v2-veiled). */
function parsePriv(d) {
  const p = d && d.priv && typeof d.priv === "object" ? d.priv : null;
  if (!p || !KINDS.has(p.kind) || typeof p.h !== "string" || !HASH20.test(p.h)) return null;
  const hs = [];
  if (Array.isArray(p.hs)) {
    for (const x of p.hs) {
      if (typeof x !== "string" || !HASH20.test(x) || x === p.h || hs.includes(x)) continue;
      if (hs.length >= HS_MAX) return null;                 // more than we keep: not shown (fails closed, as bridge.anonMore)
      hs.push(x);
    }
  }
  const at = Number(p.at);
  return { kind: p.kind, h: p.h, hs, at: Number.isFinite(at) && at > 0 ? Math.round(at * 1000) : null,
           words: p.kind === "hidden" && typeof p.words === "string" ? cpStr(p.words, 490) : "" };
}
/** The real person of a v2 UserRef: {login, display, acct} | null. Accounts ("u:<id>") only where a web line may carry one. */
function realUser(u, allowAcct = false) {
  if (!u || typeof u !== "object" || u.anonymous) return null;
  const login = String(u.login || u.id || "").trim().slice(0, 70);
  if (allowAcct && ACCT_RE.test(login)) return { login, display: plain(u.display, 40) || "a PATV member", acct: true };
  if (!LOGIN_RE.test(login)) return null;
  return { login, display: plain(u.display, 40) || login };
}
const holdOf = (v) => (typeof v === "string" && HOLD_RE.test(v) ? v : null);

/** A page-safe veiled user. */
const veiledU = (kind) => ({ anon: true, display: "someone", veil: kind });

/**
 * One v2 event with a priv block -> a page-safe veiled feed item, or null (not a kind the pad shows, or malformed). The real identity
 * rides on it as _vz / _vw (non-enumerable) and what the frog-name session needs as _v2. ts = the event time (ms).
 * (cam.open / cam.close / x.pepe.challenge never get here: they aren't feed types, and Pepe sends them in today's form.)
 */
function veiledItem(ev, ts, opts = {}) {
  const d = ev && ev.data && typeof ev.data === "object" ? ev.data : {};
  const p = parsePriv(d);
  if (!p) return null;
  const T = opts.transcript || "x.pepe.transcript";
  let it = null;
  let real = null;
  let active = false, holding;
  switch (ev.type) {
    case "message": {
      real = realUser(d.user, true);
      if (!real) return null;
      it = { k: "msg", ts, u: veiledU(p.kind) };
      if (p.kind === "incognito") { const t = cpStr(d.text, 490); if (!t) return null; it.text = t; }
      else { if (!p.words) return null; it.mask = bucket(p.words); }
      const w = d.web && typeof d.web === "object" ? d.web : null;
      if (w && typeof w.job === "string" && /^w[0-9a-f]{16}$/.test(w.job)) it._job = w.job;
      active = true;
      break;
    }
    case T: {
      real = realUser(d.user);
      if (!real) return null;
      it = { k: "tx", ts, u: veiledU(p.kind) };
      if (p.kind === "incognito") { const t = cpStr(d.text, 490); if (!t) return null; it.text = t; }
      else { if (!p.words) return null; it.mask = bucket(p.words); }
      if (/^tx-[0-9a-f]{8,32}$/.test(String(d.id || ""))) it.id = String(d.id);
      const s = Number(d.said_at);
      if (Number.isFinite(s) && s > 0) it.at = Math.round(s * 1000);
      active = true;
      break;
    }
    case "mic.grab":
    case "mic.release": {
      real = realUser(d.user);
      if (!real) return null;
      it = ev.type === "mic.grab" ? { k: "mic", ts, u: veiledU(p.kind) }
        : { k: "unmic", ts, u: veiledU(p.kind), ms: Math.max(0, Math.min(864e5, Number(d.held_ms) || 0)) };
      active = true;
      holding = ev.type === "mic.grab";
      break;
    }
    case "member.join": {
      if (d.initial) return null;
      real = realUser(d.user);
      if (!real) return null;
      it = { k: "join", ts, u: veiledU(p.kind) };
      break;
    }
    case "member.leave": {
      real = realUser(d.user);
      if (!real) return null;
      it = { k: "leave", ts, u: veiledU(p.kind) };
      break;
    }
    default:
      return null;
  }
  const hold = holdOf(d.hold);
  if (hold && (it.k === "mic" || it.k === "unmic" || it.k === "tx")) it.hold = hold;
  it.ah = p.h;
  if (p.hs.length) it.ahs = p.hs.slice();
  hide(it, "_vz", { login: real.login, display: real.display, kind: p.kind, h: p.h, hs: p.hs.slice(), sess: null, ...(real.acct ? { acct: true } : {}) });
  if (p.kind === "hidden") hide(it, "_vw", p.words);
  hide(it, "_v2", { active, holding, proven: !!(d.user && d.user.proven === true), beganNamed: d.began_named === true,
                    leaving: it.k === "leave" });
  return it;
}
/** A v2 event WITHOUT priv (a named person): today's item plus the page-safe v2 extras (hold, at). */
function namedExtras(it, ev) {
  const d = ev && ev.data && typeof ev.data === "object" ? ev.data : {};
  const hold = holdOf(d.hold);
  if (hold && (it.k === "mic" || it.k === "unmic" || it.k === "tx")) it.hold = hold;
  if (it.k === "tx") { const s = Number(d.said_at); if (Number.isFinite(s) && s > 0) it.at = Math.round(s * 1000); }
  return it;
}

// ── the opaque session id ──
function opaqueId(roomId, sess) {
  let key;
  try { key = require("./frognames").secret(); } catch (e) { return null; }
  return "v-" + crypto.createHmac("sha256", key).update("patv/veil-id/v1\0" + String(roomId) + "\0" + String(sess)).digest("base64url").slice(0, 12);
}

// ── frog-name sessions (frognames.js) ──
/** The room's roster names (logins + display names) - a frog name never equals one (C.4). */
function avoidOf(R) {
  const out = [];
  for (const u of [...(R.members || []), ...(R.mic || [])]) {
    if (!u || u.anon) continue;
    if (u.login) out.push(u.login);
    if (u.display) out.push(u.display);
  }
  return out;
}
/** Per room: hold id -> the name its grab got (a release / its 🎙 line reuse it: the session can't end during a hold). */
const HOLDS = new Map();
const HOLDS_MAX = 200;
function holdName(roomId, hold, v) {
  let m = HOLDS.get(roomId);
  if (v === undefined) return m ? m.get(hold) : undefined;
  if (!m) { m = new Map(); HOLDS.set(roomId, m); }
  m.delete(hold);
  m.set(hold, v);
  while (m.size > HOLDS_MAX) m.delete(m.keys().next().value);
  return v;
}
/**
 * A veiled item's frog name: sets u.alias / u.hood / u.id (or leaves "someone"), and _vz.sess. B.2: an unproven holder or the release
 * of a hold begun named -> no name (the session is still sighted - they're there). A hold's release / 🎙 line reuse its grab's name.
 */
async function nameItem(R, it) {
  const FN = require("./frognames");
  const vz = it._vz, v2 = it._v2 || {};
  if (!vz) return it;
  const roomId = R.id;
  let view = null;
  try {
    if (v2.leaving) {
      view = FN.current(roomId, vz.login);
      await FN.left(roomId, vz.login, it.ts);
    } else {
      view = await FN.sight(roomId, vz.login, { t: it.ts, active: !!v2.active, holding: v2.holding, avoidNames: avoidOf(R) });
    }
  } catch (e) { view = null; console.error("[veil] frog name:", e && e.code ? e.code : "error"); }
  let named = view && view.alias ? view : null;
  if (it.hold) {
    const was = holdName(roomId, it.hold);
    if (it.k === "mic") holdName(roomId, it.hold, named && v2.proven ? named : null);
    else if (was !== undefined) named = was;                 // the grab's verdict (a name, or "someone") for the whole hold
  }
  if ((it.k === "mic" || it.k === "unmic") && (!v2.proven || v2.beganNamed)) named = null;
  if (named) {
    it.u.alias = named.alias;
    if (named.hood != null) it.u.hood = named.hood;
    const id = opaqueId(roomId, named.session);
    if (id) it.u.id = id;
  }
  if (view && view.session != null) vz.sess = view.session;
  return it;
}
/** A NAMED sighting of a login in a pad (C.2: no frog name for them there for 15 minutes) - and their open session, if any, ends
 *  (their level is back to normal). Cheap: an HMAC; the session check is in memory. */
function namedSeen(roomId, login, t) {
  if (!login || /^u:/i.test(String(login))) return;
  try {
    const FN = require("./frognames");
    FN.named(roomId, login, t);
    if (FN.current(roomId, login)) FN.off(login, roomId, t).catch(() => {});
  } catch (e) { /* frog names unavailable: nothing to note */ }
}

// ── snapshots ──
/**
 * Pepe's v2 snapshot members[] / mic[] -> page-safe entries (veiled: anon + veil + frog name, never on_cam; real identity as _vz),
 * named entries through `clean` (bridge.cleanUser / cleanMic). Sightings: every veiled member is sighted (frognames.sight, quiet),
 * named members newly in the roster are noted named, veiled members gone since the last snapshot have left.
 */
async function snapshotEntries(R, list, clean, { mic = false, max = 400 } = {}) {
  const out = [];
  for (const u of (Array.isArray(list) ? list : []).slice(0, max)) {
    const p = u && typeof u === "object" ? parsePriv({ priv: u.priv }) : null;
    if (!p) { const c = clean(u); if (c) out.push(c); continue; }
    const real = realUser(u);
    if (!real) continue;
    const e = veiledU(p.kind);
    if (!mic) {
      if (u.on_mic) e.on_mic = true;
      if (u.src === "list" || u.src === "seen") e.src = u.src;
    }
    hide(e, "_vz", { login: real.login, display: real.display, kind: p.kind, h: p.h, hs: p.hs.slice(), sess: null,
                     ...(mic ? { proven: u.proven === true, since: Number(u.since) > 0 ? Math.round(Number(u.since) * 1000) : null } : {}) });
    out.push(e);
  }
  return out;
}
/** Frog names for a snapshot's veiled entries (members first, then holders - one session per person) + left / named bookkeeping. */
async function nameSnapshot(R, now) {
  const FN = require("./frognames");
  const prev = R._veilSeen || new Set();
  const seen = new Set();
  const named = new Set();
  const avoid = avoidOf(R);
  for (const e of [...(R.members || []), ...(R.mic || [])]) {
    if (!e) continue;
    if (!e.anon && e.login) { named.add(lower(e.login)); continue; }
    const vz = e._vz;
    if (!vz) continue;
    const low = lower(vz.login);
    let view = null;
    try { view = await FN.sight(R.id, vz.login, { t: now, active: false, avoidNames: avoid }); } catch (err) { view = null; }
    seen.add(low);
    const isMic = (R.mic || []).includes(e);
    if (view && view.alias && !(isMic && vz.proven !== true)) {
      e.alias = view.alias;
      if (view.hood != null) e.hood = view.hood;
      const id = opaqueId(R.id, view.session);
      if (id) e.id = id;
    }
    if (view && view.session != null) vz.sess = view.session;
  }
  for (const low of prev) if (!seen.has(low)) FN.left(R.id, low, now).catch(() => {});
  const prevNamed = R._namedSeen || new Set();
  for (const low of named) if (!prevNamed.has(low)) namedSeen(R.id, low, now);
  hide(R, "_veilSeen", seen);
  hide(R, "_namedSeen", named);
}

// ── storage ──
/** The bridge_veil row of a live item: {vz, vw} JSON / words, or null for a named item. */
function veilRow(it) {
  const vz = it && it._vz;
  if (!vz) return null;
  return { vz: JSON.stringify(vz), vw: typeof it._vw === "string" ? it._vw : null };
}
/** bridge_rooms_veil's data for a room: the veiled entries' identities by index. */
function roomVeilData(R) {
  const pick = (list) => (list || []).map((e, i) => (e && e._vz ? [i, e._vz] : null)).filter(Boolean);
  const m = pick(R.members), c = pick(R.mic);
  return m.length || c.length ? JSON.stringify({ members: m, mic: c }) : null;
}
/** At boot: re-attach the identities of a room's veiled entries (by index, only onto anon + veil entries). */
function attachRoomVeil(R, data) {
  let o = null;
  try { o = JSON.parse(data || "null"); } catch (e) { o = null; }
  if (!o || typeof o !== "object") return 0;
  let n = 0;
  for (const [key, list] of [["members", R.members], ["mic", R.mic]]) {
    for (const pair of Array.isArray(o[key]) ? o[key] : []) {
      const e = Array.isArray(pair) ? (list || [])[pair[0]] : null;
      if (e && e.anon && e.veil && pair[1] && typeof pair[1] === "object") { hide(e, "_vz", pair[1]); n++; }
    }
  }
  return n;
}
/** At boot: re-attach the identities of a room's veiled live items from bridge_veil. */
async function attachFeedVeil(R) {
  const cs = (R.feed || []).filter((it) => it && it.u && it.u.anon && it.u.veil).map((it) => Number(it.c));
  if (!cs.length) return 0;
  const by = new Map();
  for (let i = 0; i < cs.length; i += 400) {
    const part = cs.slice(i, i + 400);
    for (const r of await getQuery(`SELECT c, vz, vw FROM bridge_veil WHERE c IN (${part.map(() => "?").join(",")})`, part)) by.set(Number(r.c), r);
  }
  let n = 0;
  for (const it of R.feed) {
    const r = it && by.get(Number(it.c));
    if (!r) continue;
    try { hide(it, "_vz", JSON.parse(r.vz)); } catch (e) { continue; }
    if (r.vw != null) hide(it, "_vw", String(r.vw));
    n++;
  }
  return n;
}

/** Forget-me / account deletion (A.4.8): every trace of these logins in the live side tables. -> {feed: [c...], rooms: n}. The
 *  caller turns those feed items into "left out" (their hash is left out by the same request). */
async function forgetLogins(logins) {
  const set = new Set((Array.isArray(logins) ? logins : [logins]).map(lower).filter(Boolean));
  if (!set.size) return { feed: [], rooms: 0 };
  const cs = [];
  for (const r of await getQuery("SELECT c, vz FROM bridge_veil")) {
    let vz = null;
    try { vz = JSON.parse(r.vz); } catch (e) { vz = null; }
    if (vz && set.has(lower(vz.login))) cs.push(Number(r.c));
  }
  for (let i = 0; i < cs.length; i += 400) {
    const part = cs.slice(i, i + 400);
    await runQuery(`DELETE FROM bridge_veil WHERE c IN (${part.map(() => "?").join(",")})`, part);
  }
  let rooms = 0;
  for (const r of await getQuery("SELECT id, data FROM bridge_rooms_veil")) {
    let o = null;
    try { o = JSON.parse(r.data); } catch (e) { o = null; }
    if (!o) continue;
    let changed = false;
    for (const key of ["members", "mic"]) {
      const before = Array.isArray(o[key]) ? o[key] : [];
      o[key] = before.filter((p) => !(Array.isArray(p) && p[1] && set.has(lower(p[1].login))));
      if (o[key].length !== before.length) changed = true;
    }
    if (changed) { await runQuery("UPDATE bridge_rooms_veil SET data = ? WHERE id = ?", [JSON.stringify(o), r.id]); rooms++; }
  }
  return { feed: cs, rooms };
}

module.exports = { KINDS, hide, bucket, parsePriv, realUser, veiledItem, namedExtras, opaqueId, nameItem, namedSeen, snapshotEntries,
                   nameSnapshot, veilRow, roomVeilData, attachRoomVeil, attachFeedVeil, forgetLogins, avoidOf,
                   _holds: HOLDS };
