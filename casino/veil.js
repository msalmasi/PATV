// casino/veil.js - 1.99ajw casino2 rework (the owner, 2026-11-04, asked whether incognito players should be masked at the casino tables:
// "Yes, just show them masked at the table if incognito is on."). A seat whose player is VEILED shows under a LABEL - a frog name or
// "someone" - with no avatar, no profile link and a seat id of its own, in every web-facing name a table has: the seat, the turn, the
// host, the felt's last hand, the table's log, the hand history and the fairness record (casino/service.js bjView, casino/holdem.js
// publicView, casino/routes.js history + fair, casino/people.js) - and so on Pepe's OBS board, which draws the table state Pepe polls
// (service.js roomTables -> publicView): masked at the source, every consumer gets the mask. Camfrog room lines (casino_events -> Pepe)
// and command replies to a Camfrog player keep a ROOM player's name (incognito is the website's veil: the room sees them type, and the
// pad's bridge redacts hidden names in Pepe's lines); a player who plays from the WEBSITE is their label there too (wave 2's rule: what
// the website does for a frog name reaches Camfrog under it) - maskText(T, text, {webOnly: true}). A reply to a website player is
// masked for everyone.
//
// Veiled = the pad's own veils, the rule its people list uses (padweb.js): hidden by the site's one reader rule (padweb.hiddenKey -
// quotes.isHidden, chatlogview.isHiddenLogin, hubhidden) or Pepe's incognito report on (incognito_state), for any of the seat's chat
// keys - the Camfrog login a room seat plays from, the account's linked login, its account key "u:<userId>" (lower case). Kinds:
//   incognito   a frog name (frognames.boardAliases: one per person per table per board day, never one that reads like a name at the
//               table, never another masked seat's) - or "someone" when frognames' C.2 rule says so (below)
//   out         !bridge hide or anything stricter (quotes.isBridgeOff): "someone"
//   unknown     a hidden set still loading, a check that failed, or hidden with no check saying which veil: masked for that answer only
//               ("someone"; nothing is kept), fail closed
//
// A SEAT SESSION (sat down -> left the table) keeps its mask once it has one: switching incognito OFF mid-session leaves the seat masked
// until they leave (its stack, seat and hands would otherwise tie the frog name to the name); it ends LEAVE_GRACE_MS after they left.
// Switching it ON mid-session masks the seat at once as "someone", as does sitting down within NAMED_GAP_MS of being shown named at this table (frognames C.2: a frog name
// never right after their own name). A masked seat's id is "v" + 11 hex of a keyed hash of (table, account, epoch) - never the account's
// seat hash (service.uidHash is the same for an account at every table, so a masked seat with it could be followed to the named one).
// 1.99ajw casino2 verify: the epoch moves on when a masked seat session STARTS, so a session's id (and frog name) was never shown before
// it - not on a fail-closed blip, not in place of a named result. Anything else masked shows "someone" under a random id, never a
// session's: a result from before the session (or of a person veiled while off the seats) an OLD-CONTENT id (r.ns - kept while any of
// it is shown masked, so the moment a session starts or ends changes nothing on it; a new one the next time), a seat masked without a
// session (a fail-closed blip) a blip id of its own (r.bs - that seat, that blip only).
//
// Written masked, never unmasked: the table's log lines (service.emit) and its last hand (-> casino_rounds.results: the history and
// the fairness record) are written with the labels in force (maskText {fresh}); when a seat session's mask starts, the log and the last
// hand already written are masked in place as "someone" (never the new label: a frog name on a line first shown under their name would
// tie the two - verify fix); on the way out, anything still naming a person masked now (a round from before they switched on, a line in
// the second before the mask) is "someone" too (maskText / maskRound / maskRounds), and the rounds up to a seat session's start stay
// "someone" for good (r.omr) - also once they're named again, so a session's end unmasks nothing.
//
// State: T.veil = {<userId>: {n: [names seen], w: 1 (acted from the website here), k: kind | null, m: 0|1 (seat session masked), lab, ep, nat (last shown named, ms),
// sn: 1 (shown named in this seat session), sa (last seen seated), ns / bs (the old-content / blip ids), omr (the round counter when their last seat session's
// mask started - rounds up to it stay "someone"), at}} - inside the table's own saved state (casino_tables.state, server only: never in a
// view). refresh(T) re-reads every person the table knows, at most every REFRESH_MS per table (the table page's poll, Pepe's poll, the
// lobby, the people answer); a change to a seat session's mask is saved under the casino's mutex (persist).
"use strict";
const crypto = require("crypto");
const { getQuery } = require("../dbUtils");

const NAMED_GAP_MS = 15 * 60e3, LEAVE_GRACE_MS = 60e3, REFRESH_MS = 2000, ROW_MS = 60e3, KIND_MS = 15e3, MAX_PEOPLE = 40, MAX_NAMES = 6, NAME_MIN = 2;
// (1.99ajw casino2 verify: a name shorter than NAME_MIN is matched on its own terms - maskText; one next to a suit is a card, "K♠")
const SUITS = "♠♥♦♣♤♡♢♧";
const SOMEONE = "someone";
// the casino's own clock (service.S.hooks.now - the tests move it), the wall clock before the service has loaded
let clock = () => { try { return require("./service").S.hooks.now(); } catch (e) { return Date.now(); } };
const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const VEILED = (k) => k === "incognito" || k === "out";
const svc = () => require("./service");
const hooks = {
  /** tests only: (keys) -> kind, in place of the real read (the engine tests: nobody is veiled) */
  kind: null,
  /** a hidden set is still loading: every key reads as hidden then (fail closed) - it tells nothing about the kind */
  loading: () => {
    try { if (require("../hubhidden").loading()) return true; } catch (e) { return true; }
    try { return !require("../chatlog").hiddenReady(); } catch (e) { return true; }
  },
};

// ── who is veiled ──
const rowCache = new Map();          // userId -> {login, at}: the account's linked chat login
async function linkedLogin(uid) {
  const c = rowCache.get(uid), t = clock();
  if (c && t - c.at < ROW_MS) return c.login;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [uid]))[0];
  const login = r && r.camfrogUsername ? lc(r.camfrogUsername) : null;
  rowCache.set(uid, { login, at: t });
  if (rowCache.size > 5000) rowCache.delete(rowCache.keys().next().value);
  return login;
}
/** the chat keys of a person at a table: the login a room seat plays from, the linked login, the account key */
function keysOf(uid, p, linked) {
  const out = [];
  if (p && p.via === "room" && p.camfrog) out.push(lc(p.camfrog));
  if (linked) out.push(lc(linked));
  out.push("u:" + lc(uid));
  return [...new Set(out.filter(Boolean))];
}
/** incognito | out | unknown | null for these keys (see the top) */
async function kindOf(keys) {
  if (typeof hooks.kind === "function") return hooks.kind(keys);
  const W = require("../padweb");
  let hid = false, inc = false, bad = false;
  for (const k of keys) {
    try { if (W.hiddenKey(k)) { hid = true; break; } } catch (e) { bad = true; }
  }
  if (!hid) {
    for (const k of keys) {
      try { if (await W.incognitoOn(k)) { inc = true; break; } } catch (e) { bad = true; }
    }
  }
  if (inc) return "incognito";
  if (!hid) return bad ? "unknown" : null;
  let loading = true;
  try { loading = !!hooks.loading(); } catch (e) { loading = true; }
  if (loading) return "unknown";
  // which veil - only from a check that says so: hiddenKey also says "hidden" when a check fails (fail closed), and a failure must
  // mask this answer only, never start a seat session's mask
  return confirmed(keys) || "unknown";
}
/** out | incognito | null, from the sources hiddenKey combines (quotes' two veils, the chat's own view, hubhidden's kinds) */
function confirmed(keys) {
  let inc = false;
  for (const k of keys) {
    try { const Q = require("../quotes"); if (Q.isBridgeOff(k)) return "out"; if (Q.isIncognito(k)) inc = true; } catch (e) { /* not a confirmation */ }
    try { if (require("../chatlogview").isHiddenLogin(k)) inc = true; } catch (e) { /* not a confirmation */ }
    try {
      const H = require("../hubhidden"), h = H.hash(k);
      if (h && H.isLeftOutHash(h)) return "out";
      if (h && H.isHiddenHash(h)) inc = true;
    } catch (e) { /* not a confirmation */ }
  }
  return inc ? "incognito" : null;
}
/** the kind of the person acting now (service.act, before the command runs; a failed read = unknown) */
async function kindForActor(actor) {
  if (!actor || !actor.uid) return null;
  try { return await kindOf(keysOf(String(actor.uid), actor, await linkedLogin(String(actor.uid)))); } catch (e) { return "unknown"; }
}
const kindCache = new Map();         // userId -> {k, at}: people a stored round names whom no table in memory knows (maskRounds)
async function kindForUid(uid) {
  const c = kindCache.get(uid), t = clock();
  if (c && t - c.at < KIND_MS) return c.k;
  let k;
  try { k = await kindOf(keysOf(uid, null, await linkedLogin(uid))); } catch (e) { k = "unknown"; }
  kindCache.set(uid, { k, at: t });
  if (kindCache.size > 5000) kindCache.delete(kindCache.keys().next().value);
  return k;
}

// ── the table's state ──
const seated = (T, uid) => !!(T.eng && Array.isArray(T.eng.seats) && T.eng.seats.includes(uid));
function rec(T, uid) {
  if (!T.veil || typeof T.veil !== "object") T.veil = {};
  let r = T.veil[uid];
  if (!r) { r = { n: [], k: null, m: 0, lab: null, ep: 0, nat: null, sn: 0, at: clock() }; T.veil[uid] = r; prune(T); }
  return r;
}
function noteName(r, name) {
  const s = String(name == null ? "" : name).trim();
  if (!s || r.n.includes(s)) return;
  r.n.push(s);
  if (r.n.length > MAX_NAMES) r.n.splice(0, r.n.length - MAX_NAMES);
}
function prune(T) {
  const ids = Object.keys(T.veil);
  if (ids.length <= MAX_PEOPLE) return;
  // the oldest people no longer at the table and not its host go first; never someone seated
  // (1.99ajw casino2 verify: people whose old rounds stay "someone" (omr) go after everyone else - dropping them would name those again)
  const out = ids.filter((u) => !seated(T, u) && !(T.host && T.host.uid === u))
    .sort((a, b) => ((T.veil[a].omr != null) - (T.veil[b].omr != null)) || (T.veil[a].at || 0) - (T.veil[b].at || 0));
  for (const u of out.slice(0, ids.length - MAX_PEOPLE)) delete T.veil[u];
}
/** every name the table shows or has written (a frog name must never read like one of them) */
function namesAt(T) {
  const out = new Set();
  const e = T.eng || {};
  for (const v of Object.values(e.names || {})) if (v) out.add(String(v));
  for (const p of Object.values(T.players || {})) if (p && p.name) out.add(String(p.name));
  for (const r of Object.values(T.veil || {})) { for (const n of r.n || []) out.add(n); if (r.lab) out.add(r.lab); }
  if (T.host && T.host.name) out.add(String(T.host.name));
  return [...out];
}
function labelFor(T, uid, r, kind, t) {
  if (kind !== "incognito" || r.sn || (r.nat && t - r.nat < NAMED_GAP_MS)) return SOMEONE;
  try {
    const F = require("../frognames");
    const key = uid + "#" + (r.ep || 0);
    const name = F.boardAliases("casino:" + T.id, F.boardPeriod(t), [key], namesAt(T)).get(key);
    return name || SOMEONE;
  } catch (e) { return SOMEONE; }
}
/** one person's kind now -> the table's state (o.sitting: they are sitting down this moment - not in the seats yet). Returns true when a
 *  seat session's mask changed (worth saving). */
function apply(T, uid, kind, t = clock(), o = {}) {
  const r = rec(T, uid), was = `${r.m}|${r.lab}|${r.ep}`;
  const here = seated(T, uid) || !!o.sitting;
  r.k = kind === undefined ? null : kind;
  r.at = t;
  const e = T.eng || {};
  if (e.names && e.names[uid]) noteName(r, e.names[uid]);
  if (T.players && T.players[uid] && T.players[uid].name) noteName(r, T.players[uid].name);
  if (VEILED(r.k)) {
    if (here && !r.m) {
      // 1.99ajw casino2 verify: a NEW epoch for every masked seat session - its seat id and frog name were never shown before it
      r.ep = (r.ep || 0) + 1;
      r.m = 1; r.lab = labelFor(T, uid, r, r.k, t);
      const e0 = T.eng || {};
      r.omr = Math.max(Number(r.omr) || 0, Number(T.game === "holdem" ? e0.hand_no : e0.round_no) || 0);
      // what the table already shows of them is "someone" for good - never the new label (verify fix: a frog name on a line first
      // shown under the name would tie the two): the log (a line from before they switched on, next to the masked seat's own, would
      // tie them too) and the felt's last round, under the old-content id views gave them a moment ago (veiled off the seats) - so
      // this moment changes nothing a watcher could line up with the new seat
      if (Array.isArray(T.log)) for (const l of T.log) if (l && typeof l.text === "string") l.text = maskText(T, l.text);
      if (T.last_round) T.last_round = maskRound(T, T.last_round);
    }
  } else if (r.k === null && !r.m) {
    r.nat = t;                                   // shown under their name now
    if (here) r.sn = 1;
  }
  // the masked seat session is over once they have been off the seats for LEAVE_GRACE_MS since last seen seated (the lines of their
  // leaving - "left the table", a cash-out, a new host - are written under the label first, whichever moment a refresh lands in)
  if (here) r.sa = t;
  else if (r.m) { if (t - (Number(r.sa) || 0) >= LEAVE_GRACE_MS) { r.m = 0; r.lab = null; r.sn = 0; } }   // (the next session: a new epoch)
  else r.sn = 0;                                 // a named seat session is over (C.2 goes on from nat)
  // (verify) the old-content id: kept while anything of theirs is shown masked - rounds up to omr stay masked for good - else a new one next time
  if (r.ns && r.omr == null && !state(T, uid)) delete r.ns;
  if (r.bs && (!here || r.m || !state(T, uid))) delete r.bs;                   // (a blip's seat id: this seat, this blip only)
  return was !== `${r.m}|${r.lab}|${r.ep}`;
}
/** someone acting at T (o.sitting: sitting down - the remember() of a bet / buy-in; else opening it): their name + the kind
 *  service.act read for them (actor.veil) - before any line that names them is written */
function enter(T, actor, o = {}) {
  if (!T || !actor || !actor.uid) return;
  const r = rec(T, String(actor.uid));
  noteName(r, actor.name);
  if (actor.via !== "room") r.w = 1;
  if (o.sitting && !seated(T, String(actor.uid))) delete r.bs;                // (verify: sitting down = a new seat - a new blip id)
  if (actor.veil !== undefined) apply(T, String(actor.uid), actor.veil, clock(), { sitting: !!o.sitting });
}

const fresh = new Map();             // table id -> {at, p}: the last refresh (memory only)
/** re-read every person the table knows (at most every REFRESH_MS; one at a time per table). persist(T) saves a changed seat mask. */
function refresh(T, persist) {
  if (!T || !T.id || !T.eng) return Promise.resolve(false);
  const t = clock(), f = fresh.get(T.id);
  if (f && (f.p || t - f.at < REFRESH_MS)) return f.p || Promise.resolve(false);
  const p = (async () => {
    let changed = false;
    const ids = new Set([...(T.eng.seats || []).map(String), ...Object.keys(T.veil || {})]);
    if (T.host && T.host.uid) ids.add(String(T.host.uid));
    for (const uid of ids) {
      let k;
      try { k = await kindOf(keysOf(uid, (T.players || {})[uid], await linkedLogin(uid))); } catch (e) { k = "unknown"; }
      if (apply(T, uid, k, clock())) changed = true;
    }
    if (changed && typeof persist === "function") { try { await persist(T); } catch (e) { console.error("[casino] veil save:", e.message); } }
    return changed;
  })().catch((e) => { console.error("[casino] veil:", e.message); return false; })
    .finally(() => { fresh.set(T.id, { at: clock(), p: null }); });
  fresh.set(T.id, { at: t, p });
  if (fresh.size > 500) fresh.delete(fresh.keys().next().value);
  return p;
}

// ── what the views use (synchronous) ──
/** the person's state when they're masked now (a masked seat session, veiled while not seated, or unknown), else null */
function state(T, uid) {
  const r = T && T.veil ? T.veil[uid] : null;
  if (!r) return null;
  return r.m || VEILED(r.k) || r.k === "unknown" ? r : null;
}
const masked = (T, uid) => !!state(T, uid);
function label(T, uid) { const r = state(T, uid); return r ? (r.m && r.lab ? r.lab : SOMEONE) : null; }
// (keyed: frognames' ALIAS_SECRET - someone who knows an account id can't work out its masked seat; a random key if that can't be read)
const SEAT_KEY_FALLBACK = crypto.randomBytes(32);
function vseat(T, uid, ep) {
  let key = SEAT_KEY_FALLBACK;
  try { key = require("../frognames").secret(); } catch (e) { key = SEAT_KEY_FALLBACK; }
  return "v" + crypto.createHmac("sha256", key).update(`patv/casino-seat/v1\0${T.id}\0${uid}\0${ep || 0}`).digest("hex").slice(0, 11);
}
/** 1.99ajw casino2 verify: random ids (never a session's keyed id) for what is masked outside a seat session - r.ns: a result of someone
 *  shown under their name before (kept while it is in use - apply); r.bs: a seat masked without a session (a fail-closed blip; kept
 *  while that lasts, a new one each time they sit) - never the same as r.ns, so a seat can't be lined up with a result first shown named */
const rid = (r, f) => { if (!r[f] || !/^[0-9a-f]{11}$/.test(r[f])) r[f] = crypto.randomBytes(6).toString("hex").slice(0, 11); return "v" + r[f]; };
const oldId = (r) => rid(r, "ns");
/** the seat id a view shows for uid: the account's seat hash, a masked seat session's own, else (masked outside a session) a random one */
function seatOf(T, uid) {
  const r = state(T, uid);
  if (!r) return svc().uidHash(uid);
  return r.m ? vseat(T, uid, r.ep) : seated(T, uid) ? rid(r, "bs") : oldId(r);
}
const nameOf = (T, uid, real) => label(T, uid) || real;
const hostName = (T) => (T && T.host ? nameOf(T, T.host.uid, T.host.name) : null);
/** a name as a Camfrog room line gives it: a masked person's label only when they play from the website here */
const camName = (T, uid, real) => (T && T.veil && T.veil[uid] && T.veil[uid].w ? nameOf(T, uid, real) : real);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** [real name, what it reads as] for everyone masked now (webOnly: only those who play from the website here), longest name first.
 *  fresh (a line / reply being written now): their label in force; else (text already written - in place or on the way out): "someone" */
function pairsOf(T, webOnly, fresh) {
  const out = [];
  if (!T || !T.veil) return out;
  for (const [uid, r] of Object.entries(T.veil)) {
    if (webOnly && !r.w) continue;
    const cur = label(T, uid);
    if (!cur) continue;
    const lab = fresh ? cur : SOMEONE;
    const names = new Set(r.n || []);
    if (T.eng && T.eng.names && T.eng.names[uid]) names.add(String(T.eng.names[uid]));
    if (T.players && T.players[uid] && T.players[uid].name) names.add(String(T.players[uid].name));
    if (T.host && T.host.uid === uid && T.host.name) names.add(String(T.host.name));
    for (const n of names) {
      const s = n.trim();
      if (s && lc(s) !== lc(lab) && lc(s) !== lc(cur)) out.push([s, lab]);      // (verify: a one-character name too - maskText)
    }
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}
/** a text with every masked person's names masked (the chat's own redaction boundaries, chatlogview.redact). o.fresh: a line / reply
 *  being written now - their label in force; else (already written: in place, on the way out) "someone" (1.99ajw casino2 verify: a frog
 *  name never lands on a line first shown under the name). o.webOnly: only the masked people who play from the website (a Camfrog room
 *  line / a reply to a Camfrog player - see the top). A one-character name (verify) is matched as written, as a word of its own, never
 *  next to a card's suit ("K♠"). */
function maskText(T, text, o) {
  if (typeof text !== "string" || !text) return text;
  return maskWith(text, pairsOf(T, !!(o && o.webOnly), !!(o && o.fresh)));
}
/** 1.99?? casmask: a text with each [name, label] pair's name masked as maskText does (longest first; a one-character name as written,
 *  never next to a card's suit) - also what tables.js masks Pepe's own tables' log with */
function maskWith(text, pairs) {
  if (typeof text !== "string" || !text || !Array.isArray(pairs) || !pairs.length) return text;
  pairs = pairs.filter((p) => Array.isArray(p) && typeof p[0] === "string" && p[0].trim()).map(([n, l]) => [n.trim(), String(l || SOMEONE)])
    .sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return text;
  const map = new Map(), one = new Map();
  for (const [n, l] of pairs) {
    if (Array.from(n).length < NAME_MIN) { if (!one.has(n)) one.set(n, l); } else if (!map.has(lc(n))) map.set(lc(n), l);
  }
  let out = text;
  const long = pairs.filter(([n]) => Array.from(n).length >= NAME_MIN);
  if (long.length) {
    const re = new RegExp("(?<![\\p{L}\\p{N}_])(?:" + long.map(([n]) => esc(n)).join("|") + ")(?![\\p{L}\\p{N}_])", "giu");
    out = out.replace(re, (m) => map.get(lc(m)) || SOMEONE);
  }
  if (one.size) {
    const re1 = new RegExp("(?<![\\p{L}\\p{N}_" + SUITS + "])(?:" + [...one.keys()].map(esc).join("|") + ")(?![\\p{L}\\p{N}_" + SUITS + "])", "gu");
    out = out.replace(re1, (m) => one.get(m) || SOMEONE);
  }
  return out;
}
/** a log entry list as a view shows it */
const maskLog = (T, log) => (Array.isArray(log) ? log.map((l) => (l && typeof l.text === "string" ? Object.assign({}, l, { text: maskText(T, l.text) }) : l)) : log);

/** which known person an entry of a hand names UNDER THEIR NAME (by the account's seat hash, else - an older entry with no seat id - by
 *  name), or null. 1.99ajw casino2 verify: an entry written masked (a session's id, an old-content id) is never matched - it stays as written. */
function whoOf(T, x, ids) {
  const H = svc().uidHash;
  if (x.seat) { for (const uid of ids) if (x.seat === H(uid)) return uid; return null; }
  const n = lc(x.name);
  if (!n) return null;
  for (const uid of ids) if ((T.veil[uid].n || []).some((v) => lc(v) === n)) return uid;
  return null;
}
const roundNo = (lr) => { const v = lr ? (lr.round_no != null ? lr.round_no : lr.hand_no) : null; return v == null || !Number.isFinite(Number(v)) ? null : Number(v); };
/** a hand's summary (last_round: winners / shown / players; a stored round's results) with every entry that still names a person who is
 *  masked now - or a round up to their last seat session's start (omr) - as "someone" under their old-content id (a copy). 1.99ajw casino2
 *  verify: never their label or a session's seat id - a result first shown under the name must not tie to the masked seat. */
function maskRound(T, lr) {
  if (!lr || typeof lr !== "object" || !T || !T.veil) return lr;
  const n = roundNo(lr);
  const ids = Object.keys(T.veil).filter((u) => masked(T, u) || (T.veil[u].omr != null && (n == null || n <= T.veil[u].omr)));
  if (!ids.length) return lr;
  const out = Object.assign({}, lr);
  for (const f of ["winners", "shown", "players"]) {
    if (!Array.isArray(lr[f])) continue;
    out[f] = lr[f].map((x) => {
      if (!x || typeof x !== "object") return x;
      const uid = whoOf(T, x, ids);
      return uid ? Object.assign({}, x, { name: SOMEONE, seat: oldId(T.veil[uid]) }) : x;
    });
  }
  return out;
}
// 1.99?? casmask (the 1.99ajw verifier's gap c): a table that is no longer in memory (closed and past its linger, or closed before a
// restart - boot loads only the open ones) is masked by its SAVED state (casino_tables.state - its veil: the names each person was
// shown under, the rounds up to their last masked seat session's start (omr) and the old-content ids (ns)) with each person's kind
// read NOW - never by the current veil alone, so a round first shown under the name stays "someone" for good there too. The table's
// row can't be read (a failed query, a state that doesn't parse, no row for rounds that exist): every entry of those rounds is
// "someone" (fail closed). Memory only, a minute per table (the old-content ids stay steady meanwhile).
const savedCache = new Map();        // table id -> {at, T}
async function savedTable(tableId) {
  const id = String(tableId), c = savedCache.get(id), t = clock();
  if (c && t - c.at < ROW_MS) return c.T;
  const row = (await getQuery("SELECT state FROM casino_tables WHERE id = ?", [id]))[0];
  if (!row) throw new Error("no saved table");
  const st = JSON.parse(row.state);
  if (!st || typeof st !== "object") throw new Error("a saved table that doesn't parse");
  const veil = {};
  for (const [uid, r] of Object.entries(st.veil && typeof st.veil === "object" ? st.veil : {})) {
    if (!r || typeof r !== "object") continue;
    // the session's mask is over (the table is closed: what it showed masked was written masked); the kind is read per answer
    veil[uid] = { n: Array.isArray(r.n) ? r.n.map(String) : [], k: null, m: 0, lab: null, ep: Number(r.ep) || 0, w: r.w ? 1 : 0, at: Number(r.at) || 0 };
    if (r.omr != null && Number.isFinite(Number(r.omr))) veil[uid].omr = Number(r.omr);
    if (typeof r.ns === "string" && /^[0-9a-f]{11}$/.test(r.ns)) veil[uid].ns = r.ns;
  }
  const e = st.eng && typeof st.eng === "object" ? st.eng : {};
  const T = { id, game: st.game, saved: true, veil, eng: { seats: [], names: Object.assign({}, e.names || {}) }, players: st.players || {},
              host: st.host || null };
  savedCache.set(id, { at: t, T });
  if (savedCache.size > 500) savedCache.delete(savedCache.keys().next().value);
  return T;
}
/** a stored round's summary with every entry "someone" (no seat id) - a table whose saved state can't be read */
function scrubRound(res) {
  const out = Object.assign({}, res);
  for (const f of ["winners", "shown", "players"]) {
    if (Array.isArray(res[f])) out[f] = res[f].map((x) => (x && typeof x === "object" ? Object.assign({}, x, { name: SOMEONE, seat: null }) : x));
  }
  return out;
}

/** stored rounds (the history, the fairness record): rows [{results, players}] - players = casino_rounds.players (server only:
 *  [{uid, name}]). The table's own state first (in memory, else its saved state - casmask gap c), then anyone else a round names who
 *  is veiled now. */
async function maskRounds(tableId, rows) {
  let T = (() => { try { return svc().getTable(tableId); } catch (e) { return null; } })();
  if (!T && rows.some((row) => row && row.results && typeof row.results === "object")) {
    try {
      T = await savedTable(tableId);
      for (const uid of Object.keys(T.veil)) T.veil[uid].k = await kindForUid(uid);
    } catch (e) {
      return rows.map((row) => Object.assign({}, row, { results: row.results && typeof row.results === "object" ? scrubRound(row.results) : row.results }));
    }
  }
  const H = svc().uidHash;
  const kinds = new Map();
  for (const row of rows) {
    for (const p of Array.isArray(row.players) ? row.players : []) {
      const uid = p && p.uid ? String(p.uid) : null;
      if (!uid || kinds.has(uid) || (T && T.veil && T.veil[uid])) continue;
      kinds.set(uid, await kindForUid(uid));
    }
  }
  return rows.map((row) => {
    let res = row.results;
    if (!res || typeof res !== "object") return Object.assign({}, row, { results: res });
    if (T) res = maskRound(T, res);
    const rules = (Array.isArray(row.players) ? row.players : []).filter((p) => p && p.uid && kinds.get(String(p.uid)))
      .map((p) => ({ h: H(String(p.uid)), n: lc(p.name) }));
    if (rules.length) {
      res = Object.assign({}, res);
      for (const f of ["winners", "shown", "players"]) {
        if (!Array.isArray(res[f])) continue;
        res[f] = res[f].map((x) => {
          if (!x || typeof x !== "object") return x;
          const hit = rules.some((r) => (x.seat ? x.seat === r.h : lc(x.name) === r.n && r.n));
          return hit ? Object.assign({}, x, { name: SOMEONE, seat: null }) : x;
        });
      }
    }
    return Object.assign({}, row, { results: res });
  });
}

module.exports = { SOMEONE, NAMED_GAP_MS, LEAVE_GRACE_MS, REFRESH_MS, MAX_PEOPLE, kindOf, kindForActor, keysOf, enter, apply, refresh, state, masked, label, seatOf,
  nameOf, hostName, camName, maskText, maskWith, maskLog, maskRound, maskRounds, _hooks: hooks,
  _setClock: (f) => { clock = f || (() => { try { return require("./service").S.hooks.now(); } catch (e) { return Date.now(); } }); },
  _reset: () => { fresh.clear(); rowCache.clear(); kindCache.clear(); savedCache.clear(); } };
