// chatloghist.js — CL8: infinite scrollback for the pad chat, the history API (the chat-history spec §2.2, §3.5 "History", §3.2
// cursor bounds, §3.11 limits). Ships DARK: nothing answers until the chatlog.history switch is on (chatlog.js; the owner turns it
// on once CL6's takedowns are live - runbook step 7).
//
//   GET /api/rooms/:slug/history?before=<c> | after=<c> | around=<c> | at=<ISO-8601 or ms>  &limit=1..100 (50) &sys=0|1 (1)
//     -> {ok, items: [feed items, projected + dressed exactly like /live's feed[]], more_before, more_after,
//         floor: {ts, reason: window | earlier | retention | off | start}, cursor (the newest c, to re-join the live poll),
//         target? (around / at: the line the page is around), next_before? / next_after? (an opaque scan position, only when a
//         request ran out of its scan budget), acts (what the line menu offers this viewer - chatlogmod.actsFor)}
//   No position = the newest page. `at` = around the first line the viewer may see at or after that time (📅 Jump to a date:
//   the day's first line); after the newest line, around the newest one. `around` = a ?line= deep link: the line must be inside
//   the viewer's view, else ONE answer for every case (404 not_found - another room's line, a removed one, a hidden person's,
//   one below the floor, none at all). The pad's owner, staff and the room's mods get a reason (`why`): floor | removed | no_line.
//   CL8 fix-up: a hidden person's line and another room's line both answer no_line, exactly like a line that doesn't exist - the
//   global cursor already leaves gaps for other rooms, so the left-out lines hide among them (a "privacy" reason told a mod the
//   exact moments a hidden person spoke, and that someone they remembered had gone hidden; "other_room" mapped other pads'
//   lines). before= / after= take a plain cursor (spec §3.5): a bound is exclusive and every page is projected, so a bound - even a
//   hidden line's c - can't show anything the viewer may not see.
//   GET  /api/rooms/:slug/history/state -> {ok, history} (the history block, with its digests `v` (the viewer's view) and `pv` (the
//        privacy state: the sticky hidden set, the redaction, this pad's takedowns)) - the offline 📜 card polls it (60 s)
//   POST /api/rooms/:slug/history/check {cs: [c, ...] (<= 3,000: the lines the page holds)} -> {ok, gone: [c...], redo: [items],
//        history} - after `pv` changed: which of the page's lines it must drop now (their speaker is hidden, a line was taken down,
//        a narrower view) and the ones whose look changed (a name redacted since, the owner's / staff's muted row of a taken-down
//        line; the owner's decision-9 change: a speaker who went incognito - now "someone" - or was shown again), dressed again.
//        Same-origin.
//
// Who: signed-in viewers who can read the pad (padaccess.full) and whose view allows history (chatlogview.view can.history:
// age-confirmed on an 18+ pad, not blocked from the whole bridge nor banned from the pad's feed, the 💎 gate - decisions 7 and 24).
// Every read asks chatlogview for the viewer's floors and turns each into a cursor once (cursorBounds: one seek on chat_log_room_ts),
// then pages on chat_log_room (rk, c) with BOTH c bounds - a page at the floor visits O(1) rows. The per-class floors (chat, 🎙,
// presence) are cursor tests in a CASE (never an OR the planner could split into rowid ranges over the whole archive); removed
// lines (but for the owner and staff), Approved-era lines (for a viewer who isn't an approved member), presence (sys=0) and - CL8
// fix-up - the people the sticky hidden set leaves out (their logins, from chatlogview's who map; !transcripts off for 🎙 lines;
// the owner's decision-9 change: the "h:<hash>" of every left-out hash too - an incognito person's lines Pepe sent anonymised - while
// an incognito-only person's lines stay, shown as "someone") and Pepe's anonymised presence stand-ins are left out in SQL too; then
// chatlogview.filter re-checks every row (the floors by time,
// the line's own aud, the sticky hidden set, !transcripts off) - the projection is the authority, the SQL only the bound. A long run
// of rows the projection still drops is scanned through in growing batches, at most SCAN_MAX rows a request; the scan position it
// then hands out is SEALED (AES-256-CTR + HMAC over the room, the viewer and the direction, an issue time, 1 h): it never names a row.
// Limits (§3.11), for viewers without full history (all but the owner, staff and - with "Room mods can read all history" - the
// room's mods): 60 requests a minute and 20,000 items a day per account (in memory - a restart forgives); /history/state and
// /history/check have a bucket of their own (20 a minute), so reading back fast never starves an open page's privacy re-check. Refusals count as
// requests; a page is never bigger than what the day has left (reserved before the read, the unused part given back). A staff
// read below the public floor (presence's 24 h included) is a coalesced chatlog_views row (chatlogview.auditRead: one row per
// reader, room and 10 minutes, widened to every span read in it). Answers are no-store + noindex; a line's text is never logged.
"use strict";
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");
const CL = require("./chatlog");

// ── the page sizes and limits (spec §2.2, §3.11): each one constant ──
const PAGE = 50;                   // "scrolling to the top loads older lines, 50 at a time"
const LIMIT_MAX = 100;
const PER_MIN = 60;                // requests a minute per account (viewers without full history)
const AUX_PER_MIN = 20;            // /history/state + /history/check a minute per account - their own bucket: reading back fast never
                                   // starves an open page's privacy re-check (one per change, + its retries; the offline card's 1 a minute)
const DAY_ITEMS = 20000;           // items a day per account (viewers without full history)
const SCAN_MAX = 5000;             // rows one request scans past what the projection leaves out
const BATCH_MAX = 500;
const POS_TTL = 3600e3;            // a scan position (next_before / next_after) is good this long
const CHECK_MAX = 3000;            // the lines one re-check may ask about (the page keeps at most 3,000 nodes)
const HIDDEN_SQL_MAX = 2000;       // hidden logins left out in SQL per list (past it only the projection drops them: more rows walked)
const C_MAX = 1e15;                // "no bound" for a cursor (the feed cursor never gets near it)
const MOVED_MS = 10 * 60e3;        // owner change: /history/check draws again the "someone" lines of a speaker whose kind moved this lately
const PRESENCE = Object.freeze(["join", "leave", "mic", "unmic"]);
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const KEY_ENC = crypto.createHash("sha256").update("chat-hist-enc:" + SECRET).digest();
const KEY_MAC = crypto.createHash("sha256").update("chat-hist-mac:" + SECRET).digest();

const limits = { perMin: PER_MIN, auxPerMin: AUX_PER_MIN, dayItems: DAY_ITEMS, scanMax: SCAN_MAX };
class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.refuse = true; Object.assign(this, extra || {}); }
}
/** The one answer for a line a viewer can't see; the pad's owner, staff and the room's mods get the reason (floor | removed |
 *  no_line - never "privacy" or "other room": those answer no_line, like a line that doesn't exist). */
const notFound = (V, why) => new Refuse(404, "That line isn't available.", "not_found", V && V.exempt && why ? { why } : null);

async function roRead(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);          // no read connection (tests / tools): the shared one
    throw e;
  }
}

// ── positions: a plain feed cursor, or the sealed scan position an earlier answer handed out (this room, viewer, direction) ──
const posMac = (roomId, userId, dir, buf) => crypto.createHmac("sha256", KEY_MAC)
  .update("chat-hist:" + String(roomId) + "|" + String(userId) + "|" + dir + "|").update(buf).digest().slice(0, 16);
/** -> "h1.<base64url(iv | sealed fixed-width [c, issued s] | mac)>" - the same length whatever the c. dir: "b" | "a". */
function sealPos(roomId, userId, c, dir, t = Date.now()) {
  const d = dir === "a" ? "a" : "b";
  const iv = crypto.randomBytes(16);
  const ci = crypto.createCipheriv("aes-256-ctr", KEY_ENC, iv);
  const plain = String(Math.max(0, Math.floor(Number(c) || 0))).padStart(16, "0") + "." + String(Math.floor(t / 1000)).padStart(12, "0");
  const head = Buffer.concat([iv, ci.update(plain, "utf8"), ci.final()]);
  return "h1." + Buffer.concat([head, posMac(roomId, userId, d, head)]).toString("base64url");
}
/** -> the cursor | throws 400 bad_cursor (forged, another room's / viewer's / direction's, expired, garbage). */
function openPos(tok, roomId, userId, dir, t = Date.now()) {
  const bad = () => new Refuse(400, "That position isn't valid - reload the page.", "bad_cursor");
  const s = String(tok == null ? "" : tok);
  if (s.length > 120 || !/^h1\.[A-Za-z0-9_-]{40,}$/.test(s)) throw bad();
  const raw = Buffer.from(s.slice(3), "base64url");
  if (raw.length !== 16 + 29 + 16) throw bad();
  const head = raw.slice(0, raw.length - 16), mac = raw.slice(raw.length - 16);
  if (!crypto.timingSafeEqual(mac, posMac(roomId, userId, dir === "a" ? "a" : "b", head))) throw bad();
  let m = null;
  try {
    const de = crypto.createDecipheriv("aes-256-ctr", KEY_ENC, head.slice(0, 16));
    m = /^(\d{16})\.(\d{12})$/.exec(Buffer.concat([de.update(head.slice(16)), de.final()]).toString("utf8"));
  } catch (e) { m = null; }
  if (!m || !(Number(m[1]) > 0)) throw bad();
  const issued = Number(m[2]) * 1000;
  if (issued > t + 60e3 || t - issued > POS_TTL) throw bad();
  return Number(m[1]);
}
/** before= / after=: a plain cursor (spec §3.5) or a sealed scan position. dir: "b" (before) | "a" (after). */
function readPos(v, roomId, userId, dir) {
  const s = String(v == null ? "" : v);
  if (/^\d{1,15}$/.test(s) && Number(s) > 0) return Number(s);
  if (/^h1\./.test(s)) return openPos(s, roomId, userId, dir);
  throw new Refuse(400, "That position isn't valid - reload the page.", "bad_cursor");
}
const intOf = (v) => (/^\d{1,15}$/.test(String(v == null ? "" : v)) && Number(v) > 0 ? Number(v) : null);
/** `at`: ms since 1970 or an ISO-8601 date / time. -> ms | null */
function timeOf(v) {
  const s = String(v == null ? "" : v).trim().slice(0, 40);
  if (/^\d{9,15}$/.test(s)) return Number(s);
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ── the people the projection leaves out, as logins the SQL can skip (CL8 fix-up) ──
// The sticky hidden set holds hashes; chatlogview's who map knows the login behind each hash it has seen. A login whose lines the
// projection would leave out (asked of chatlogview.filter itself, so a change to its rules carries over) goes into the page query's
// NOT IN - their rows are then never walked, so a page can't run out of its scan budget on a hidden person's long run (an empty
// page that still says "more" would have told the reader at least SCAN_MAX hidden lines sat there). Rebuilt when the hidden set
// changes (chatlogview.hiddenVer) and, at most once a minute, when the who map grew.
let HX = { key: null, at: 0, size: -1, out: [], tx: [] };
function hiddenLogins() {
  const CV = require("./chatlogview");
  const W = CV._who;
  const key = CV.hiddenVer(), t = Date.now();
  if (HX.key === key && (W.size === HX.size || t - HX.at < 60e3)) return HX;
  const probe = { floor: { chat: 0, tx: 0, presence: 0 }, now: t, role: "staff", signed: true, inside: true, aud: "p" };
  const leftOut = (login, k) => CV.filter([{ k, c: 1, ts: t, aud: "p", u: { login, display: login } }], { view: probe, jc: null }).left.privacy === 1;
  const out = new Set(), tx = new Set();
  let ready = true;
  try { ready = CL.hiddenReady ? !!CL.hiddenReady() : true; } catch (e) { ready = false; }
  if (ready) {
    for (const h of CL.hiddenHashes()) { const l = W.get(h); if (l && out.size < HIDDEN_SQL_MAX && leftOut(l, "msg")) out.add(l); }
    let txn = 0;
    try { txn = Number(CL.hiddenCount().tx) || 0; } catch (e) { txn = 0; }
    if (txn > 0) for (const [h, l] of W) { if (tx.size >= HIDDEN_SQL_MAX) break; if (!out.has(l) && CL.isTxHiddenHash(h) && leftOut(l, "tx")) tx.add(l); }
    // the owner's decision-9 change: an incognito person's lines Pepe sent anonymised are archived as who "h:<hash>" - once that hash
    // is left out (!bridge hide, forget-me) they are left out in SQL too (no who map needed: the hash is the key). Their own cap.
    let nh = 0;
    for (const h of CL.hiddenHashes()) { if (nh >= HIDDEN_SQL_MAX) break; if (CL.isLeftOutHash(h)) { out.add("h:" + h); nh++; } }
    let nt = 0;
    if (txn > 0 && CL.txHiddenHashes) for (const h of CL.txHiddenHashes()) { if (nt >= HIDDEN_SQL_MAX) break; if (!out.has("h:" + h)) { tx.add("h:" + h); nt++; } }
  }
  HX = { key, at: t, size: W.size, out: [...out], tx: [...tx] };
  return HX;
}

/**
 * The page query (spec §3.2): chat_log_room (rk, c) with both c bounds; the per-class floors as cursors in a CASE; removed lines
 * (keepRemoved false), Approved-era lines (approved false), presence (sys false) left out in SQL too; and (CL8 fix-up) the people
 * the hidden set leaves out - nOut logins for every kind, nTx more for 🎙 lines only - and Pepe's anonymised presence stand-ins
 * (a presence row without a login), as a CASE again (never an OR). Newest first for "before", oldest first for "after".
 * Params: [rk, lo, hi, c_tx, c_presence, c_chat, ...out + tx (when nOut + nTx), ...out (when nOut), limit].
 */
function pageSql({ dir = "before", sys = true, keepRemoved = false, approved = true, nOut = 0, nTx = 0 } = {}) {
  const qs = (n) => new Array(n).fill("?").join(",");
  return "SELECT * FROM chat_log WHERE rk = ? AND c >= ? AND c < ?" +
    " AND (CASE WHEN k = 'tx' THEN c >= ? WHEN k IN ('join','leave','mic','unmic') THEN c >= ? ELSE c >= ? END)" +
    " AND (CASE WHEN who IS NULL THEN k NOT IN ('join','leave','mic','unmic')" +
    (nOut + nTx > 0 ? " WHEN k = 'tx' THEN who NOT IN (" + qs(nOut + nTx) + ")" : "") +
    (nOut > 0 ? " ELSE who NOT IN (" + qs(nOut) + ") END)" : " ELSE 1 END)") +
    (keepRemoved ? "" : " AND rm_at IS NULL AND purged IS NULL") +
    (approved ? "" : " AND aud <> 'a'") +
    (sys ? "" : " AND k NOT IN ('join','leave','mic','unmic')") +
    " ORDER BY c " + (dir === "after" ? "ASC" : "DESC") + " LIMIT ?";
}

/** The scan state for one viewer's view (cursor bounds once, the page queries, the hidden logins). */
async function scanner(V, sys) {
  const CV = require("./chatlogview");
  const cb0 = await CV.cursorBounds(V.rk, V.floor);
  const cb = { tx: cb0.tx == null ? C_MAX : cb0.tx, presence: !sys || cb0.presence == null ? C_MAX : cb0.presence, chat: cb0.chat == null ? C_MAX : cb0.chat };
  const X = hiddenLogins();
  const o = { sys, keepRemoved: V.role === "owner" || V.role === "staff", approved: !!V.inside, nOut: X.out.length, nTx: X.tx.length };
  const hp = [...(o.nOut + o.nTx ? [...X.out, ...X.tx] : []), ...X.out];
  return { rk: V.rk, V, cb, cb0, hp, cmin: Math.min(cb.tx, cb.presence, cb.chat),
           sql: { before: pageSql(Object.assign({ dir: "before" }, o)), after: pageSql(Object.assign({ dir: "after" }, o)) } };
}

/**
 * Walk from `from` (exclusive) in `dir` until `need` items the viewer may see are found (+1 to know there are more), the rows run
 * out, or the scan budget is spent. -> {items (scan order), more, next (the last scanned c when the budget ran out, else null)}
 */
async function scan(S, dir, from, need) {
  const CV = require("./chatlogview");
  const out = [];
  let pos = from, scanned = 0, exhausted = false, batch = Math.min(BATCH_MAX, need + 26);
  for (;;) {
    if (out.length > need || scanned >= limits.scanMax) break;
    const lo = dir === "after" ? Math.max(S.cmin, pos + 1) : S.cmin;
    const hi = dir === "after" ? C_MAX : pos;
    if (lo >= hi) { exhausted = true; break; }
    const rows = await roRead(S.sql[dir], [S.rk, lo, hi, S.cb.tx, S.cb.presence, S.cb.chat, ...(S.hp || []), batch]);
    scanned += rows.length;
    if (!rows.length) { exhausted = true; break; }
    const items = rows.map(CV.itemOf);
    const keep = new Set(CV.filter(items, { view: S.V, jc: null }).items);
    for (const it of items) {
      pos = it.c;
      if (keep.has(it)) { out.push(it); if (out.length > need) break; }
    }
    if (out.length > need) break;
    if (rows.length < batch) { exhausted = true; break; }
    batch = Math.min(BATCH_MAX, batch * 2);
  }
  return { items: out.slice(0, need), more: out.length > need || !exhausted, next: !exhausted && out.length <= need ? pos : null };
}

/** Dressed exactly like /live's feed[] (bridge.liveView): names, avatars, styles and flair at read time, the viewer's own lines
 *  (own, when the line menu is on), the owner's / staff's muted rows saying who hid a line. */
async function dress(roomId, items, V, viewer, login, acts) {
  if (!items.length) return [];
  const CV = require("./chatlogview"), B = require("./bridge");
  const L = await B.resolveNames(items.map((it) => it.u).filter(Boolean));
  let rmNames = null;
  if (items.some((it) => it.rm_at != null && !it.purged)) { try { rmNames = await require("./chatlogmod").rmNames(items); } catch (e) { rmNames = null; } }
  const dressed = CV.dress(items, { view: V, lookup: (u) => L.get(B.nameKey(u.login)), rmNames });
  let F = null;
  try { F = await require("./padflair").byUsername(roomId); } catch (e) { F = null; }
  const own = new Set(acts ? ["u:" + String(viewer.userId).toLowerCase(), login ? String(login).toLowerCase() : null].filter(Boolean) : []);
  // the owner's decision-9 change: the viewer's own lines shown as "someone" (they are incognito) are still theirs - by the speaker
  // hash dress keeps off the wire (_sh, not enumerable)
  const ownH = new Set([...own].map((k) => CV.hashOf(k)));
  return dressed.map((it) => {
    if (!it.u) return it;
    const o = Object.assign({}, it, { u: B.withPatv(it.u, L, F) });
    if (own.size && (it.k === "msg" || it.k === "tx") && !it.removed &&
        ((it.u.login && own.has(String(it.u.login).toLowerCase())) || (it._sh && ownH.has(it._sh)))) o.own = 1;
    return o;
  });
}

// ── the limits (viewers without full history) ──
let HIT = null, HIT_AUX = null;
const DAY = new Map();             // userId -> {d: UTC day number, n: items served (or reserved by a request in flight)}
/** 60 requests a minute: every request counts, a refused one too. */
function rateCheck(userId, aux = false) {
  const G = require("./middleware/authGuard");
  if (!HIT) HIT = G.limiter({ max: limits.perMin, windowMs: 60e3 });
  if (!HIT_AUX) HIT_AUX = G.limiter({ max: limits.auxPerMin, windowMs: 60e3 });
  const L = aux ? HIT_AUX : HIT;
  const wait = L.blocked(userId);
  if (wait) throw new Refuse(429, "Slow down - try again in a minute.", "rate", { retry: wait });
  L.hit(userId);
}
function dayOf(userId) {
  const d = Math.floor(Date.now() / 864e5);
  let cur = DAY.get(userId);
  if (!cur || cur.d !== d) {
    cur = { d, n: 0 };
    DAY.set(userId, cur);
    if (DAY.size > 50000) DAY.delete(DAY.keys().next().value);
  }
  return cur;
}
const dayLeft = (userId) => Math.max(0, limits.dayItems - dayOf(userId).n);
const take = (userId, n) => { if (n > 0) dayOf(userId).n += n; };
const giveBack = (userId, n) => { if (n > 0) { const cur = dayOf(userId); cur.n = Math.max(0, cur.n - n); } };
const dailyRefusal = () => new Refuse(429, "You've read a lot of chat history today - try again tomorrow.", "daily");

/** Full history: the owner, staff (chatlog.read_all) and - with "Room mods can read all history" - the room's mods. */
const fullHistory = (V) => V.role === "owner" || V.role === "staff" || (V.role === "mod" && !!V.mods_all);

/** The pad, the viewer and their view - the gates every route shares. -> {roomId, V, login, user, full, uid} | throws Refuse. */
async function gate(user, slug) {
  if (!CL.on("history")) throw new Refuse(404, "Earlier chat isn't available here yet.", "off");
  if (!user || !user.userId) throw new Refuse(401, "Sign in to scroll back through earlier chat.", "signin");
  await CL.init();
  const R = await require("./roomsweb").resolveRoom(String(slug || "").slice(0, 128)).catch(() => null);
  if (!R || !R.id) throw notFound(null);
  const roomId = R.id;
  let platform = "camfrog";
  try { platform = require("./rooms").platformOf(roomId); } catch (e) { platform = "camfrog"; }
  if (platform !== "camfrog") throw notFound(null);                     // a pad with no Camfrog room has no chat archive
  const PA = require("./padaccess");
  await PA.init();
  if (!PA.full(user, roomId)) throw notFound(null);
  // the room's Camfrog mods: Pepe sends their caps for the viewers noteViewer records (spec §3.2)
  const pm = require("./padmod");
  let login = null;
  try { login = await pm.linkedLogin(user.userId); } catch (e) { login = null; }
  if (login) { try { pm.noteViewer(roomId, login); } catch (e) { /* no mod caps this time */ } }
  const V = await require("./chatlogview").view(roomId, user);
  return { roomId, V, login, user, full: fullHistory(V), uid: String(user.userId) };
}
function actsOf(V, user) { try { return require("./chatlogmod").actsFor(V, user); } catch (e) { return null; } }
/** The history block (chatlogview.historyBlock: the viewer's floors and switches, `v` and `pv`) + the line menu. */
function block(V, acts) {
  const h = require("./chatlogview").historyBlock(V);
  return acts ? Object.assign(h, { acts }) : h;
}

/** One history page for a viewer. q = the query string. -> the answer | throws Refuse. */
async function page(user, slug, q = {}) {
  const G = await gate(user, slug);
  const { roomId, V, login, uid } = G;
  if (!G.full) rateCheck(uid);                                       // CL8 fix-up: before the refusals below - they count too
  if (!V.can.history) throw new Refuse(403, "Earlier chat on this pad isn't available to you.", "no_history");
  const asked = ["before", "after", "around", "at"].filter((k) => q[k] != null && q[k] !== "");
  if (asked.length > 1) throw new Refuse(400, "Ask for one position at a time.", "bad_query");
  const n = Math.floor(Number(q.limit));
  let limit = Number.isFinite(n) && q.limit != null && q.limit !== "" ? Math.min(LIMIT_MAX, Math.max(1, n)) : PAGE;
  // CL8 fix-up: never more than the day has left - reserved now (nothing awaits between the check and the reservation, so two
  // requests in flight can't both take the last of it), the unused part given back below
  if (!G.full) {
    const left = dayLeft(uid);
    if (left <= 0) throw dailyRefusal();
    limit = Math.min(limit, left);
    take(uid, limit);
  }
  let served = 0;
  try {
    const out = await read(G, q, limit);
    served = out.items.length;
    return out;
  } finally { if (!G.full) giveBack(uid, limit - served); }
}
async function read(G, q, limit) {
  const { roomId, V, login } = G;
  const CV = require("./chatlogview");
  let sys = String(q.sys == null ? "1" : q.sys) !== "0";
  const acts = actsOf(V, G.user);
  let raw = [], moreB = false, moreA = false, target = null, nextB = null, nextA = null;
  const rk = V.rk;
  let S = null;
  if (q.around != null && q.around !== "") {
    // a deep link: the line itself must be inside this viewer's view (one not_found for every other case)
    const c = intOf(q.around);
    const row = c && rk != null ? (await roRead("SELECT * FROM chat_log WHERE c = ?", [c]))[0] : null;
    if (!row || Number(row.rk) !== Number(rk)) throw notFound(V, "no_line");            // none, or another room's: alike
    const it = CV.itemOf(row);
    const f = CV.filter([it], { view: V, jc: null });
    // a hidden person's line: no_line too (never "privacy" - see the header); a removed one (a mod: the owner and staff see it)
    if (!f.items.length) throw notFound(V, f.left.removed ? "removed" : f.left.privacy ? "no_line" : "floor");
    if (PRESENCE.includes(it.k)) sys = true;              // the line asked for always comes with its page
    S = await scanner(V, sys);
    const half = Math.ceil(limit / 2);
    const b = await scan(S, "before", it.c, half - 1), a = await scan(S, "after", it.c, limit - half);
    raw = [...b.items.reverse(), it, ...a.items];
    moreB = b.more; moreA = a.more; nextB = b.next; nextA = a.next; target = it.c;
  } else if (rk != null) {
    S = await scanner(V, sys);
    if (S.cmin >= C_MAX) { /* nothing at or after any floor: an empty page */ }
    else if (q.at != null && q.at !== "") {
      const ts = timeOf(q.at);
      if (ts == null) throw new Refuse(400, "Pick a date.", "bad_at");
      const seek = (await roRead("SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [rk, Math.max(0, Math.floor(ts))]))[0];
      let first = seek ? (await scan(S, "after", Number(seek.c) - 1, 1)).items[0] : null;
      if (!first) first = (await scan(S, "before", C_MAX, 1)).items[0] || null;     // after the newest line: around the newest one
      if (first) {
        const half = Math.ceil(limit / 2);
        const b = await scan(S, "before", first.c, half - 1), a = await scan(S, "after", first.c, limit - half);
        raw = [...b.items.reverse(), first, ...a.items];
        moreB = b.more; moreA = a.more; nextB = b.next; nextA = a.next; target = first.c;
      }
    } else if (q.after != null && q.after !== "") {
      const pos = readPos(q.after, roomId, G.uid, "a");
      const a = await scan(S, "after", pos, limit);
      raw = a.items; moreA = a.more; nextA = a.next;
      moreB = (await scan(S, "before", raw.length ? raw[0].c : pos + 1, 0)).more;
    } else {
      const pos = q.before != null && q.before !== "" ? readPos(q.before, roomId, G.uid, "b") : C_MAX;
      const b = await scan(S, "before", pos, limit);
      raw = b.items.reverse(); moreB = b.more; nextB = b.next;
      moreA = pos >= C_MAX ? false : (await scan(S, "after", raw.length ? raw[raw.length - 1].c : pos - 1, 0)).more;
    }
  } else {
    // positions are still checked when the room has no archive yet (a bad one is a 400 either way)
    if (q.before != null && q.before !== "") readPos(q.before, roomId, G.uid, "b");
    if (q.after != null && q.after !== "") readPos(q.after, roomId, G.uid, "a");
    if (q.at != null && q.at !== "" && timeOf(q.at) == null) throw new Refuse(400, "Pick a date.", "bad_at");
  }
  // the end marker: why history stops here - "start" when the archive holds nothing older in this room at all
  let reason = V.why ? V.why.chat : "start";
  if (!moreB && reason !== "off" && rk != null) {
    const cc = S && S.cb0 && S.cb0.chat != null ? S.cb0.chat : C_MAX;
    if (!(await roRead("SELECT 1 FROM chat_log WHERE rk = ? AND c < ? LIMIT 1", [rk, cc])).length) reason = "start";
  }
  if (rk == null) reason = reason === "off" ? "off" : "start";
  // a staff read below the public floor (CL8 fix-up: presence's 24 h too): audited - one row per reader, room and 10 minutes,
  // widened to every span read in it
  if (V.audit) {
    const below = raw.filter((it) => Number(it.ts) < CV.pubFloor(V, it.k));
    if (below.length) CV.auditRead(V, roomId, "history", Number(below[0].ts), Number(below[below.length - 1].ts)).catch(() => {});
  }
  let cursor = 0;
  try { cursor = require("./bridge").cursorNow(); } catch (e) { cursor = 0; }
  const out = { ok: true, items: await dress(roomId, raw, V, G.user, login, acts), more_before: !!moreB, more_after: !!moreA,
                floor: { ts: V.floor.chat, reason }, cursor, acts: acts || null };
  if (target != null) out.target = target;
  if (moreB && nextB != null) out.next_before = sealPos(roomId, G.uid, nextB, "b");
  if (moreA && nextA != null) out.next_after = sealPos(roomId, G.uid, nextA, "a");
  return out;
}

/** The history block for a page that polls (the offline 📜 card): its `v` / `pv` tell it to reload or re-check. */
async function state(user, slug) {
  const G = await gate(user, slug);
  if (!G.full) rateCheck(G.uid, true);
  return { ok: true, history: block(G.V, G.V.can.history ? actsOf(G.V, user) : null) };
}

/**
 * The lines a page holds, checked again after its `pv` changed (CL8 fix-up: the sticky hidden set grew, a name is redacted now,
 * a line was taken down - open pages drop or re-dress what they already show, scrollback's lines included). -> {ok, gone, redo,
 * history}: gone = the c's no longer inside this viewer's view (another room's or unknown ones too); redo = lines still shown whose
 * look changed (a name redacted since, a taken-down line the owner / staff see muted), dressed like /history's items. Redone lines
 * count toward the day's items; past what is left they go into `gone` (never shown un-redacted).
 */
async function check(user, slug, body = {}) {
  const list = body && Array.isArray(body.cs) ? body.cs : null;
  if (!list || list.length > CHECK_MAX) throw new Refuse(400, "Ask about at most 3,000 lines.", "bad_query");
  const cs = [...new Set(list.map(intOf).filter(Boolean))];
  const G = await gate(user, slug);
  if (!G.full) rateCheck(G.uid, true);
  const V = G.V, CV = require("./chatlogview");
  const acts = V.can.history ? actsOf(V, user) : null;
  const out = { ok: true, gone: [], redo: [], history: block(V, acts) };
  if (!V.can.history || V.rk == null) { out.gone = cs; return out; }
  const rows = new Map();
  for (let i = 0; i < cs.length; i += 500) {
    const part = cs.slice(i, i + 500);
    for (const r of await roRead(`SELECT * FROM chat_log WHERE c IN (${part.map(() => "?").join(",")})`, part)) rows.set(Number(r.c), r);
  }
  const items = [];
  for (const c of cs) { const r = rows.get(c); if (r && Number(r.rk) === Number(V.rk)) items.push(CV.itemOf(r)); }
  const keep = CV.filter(items, { view: V, jc: null }).items;
  const kept = new Set(keep.map((it) => Number(it.c)));
  out.gone = cs.filter((c) => !kept.has(c));
  const red = (s) => typeof s === "string" && CV.redact(s) !== s;
  // the owner's decision-9 change: a NAMED line shown as "someone" now whose speaker went incognito lately (from shown - the page
  // may still show their name) is drawn again; one un-hidden since keeps its "someone" until the page loads it again (never a name
  // late). Review 2 fix-up: never a line that was "someone" before and after (Pepe's anonymised "h:" rows, a speaker who was hidden
  // already) - this answer would otherwise pick out, from any c's asked about, exactly the "someone" lines of whoever moved
  let changed = keep.filter((it) => it.rm_at != null || it.purged || red(it.text) || (it.k === "live" && (red(it.who) || red(it.what))) ||
                                     (CV.privacyOf(it) === "anon" && CV.namedToAnonLately(it, MOVED_MS)));
  if (!G.full) {
    const left = dayLeft(G.uid);
    if (changed.length > left) { for (const it of changed.slice(left)) out.gone.push(Number(it.c)); changed = changed.slice(0, left); }
    take(G.uid, changed.length);
  }
  out.redo = await dress(G.roomId, changed, V, user, G.login, acts);
  return out;
}

/** The pad page's offline 📜 Chat history card (bridge.js /p/:slug while its Camfrog room is offline, or for the owner and staff of
 *  a pad without the 💎 bridge perk): the viewer's history block when they may scroll back and - CL8 fix-up - can see at least one
 *  archived line here (under "Off", or with nothing inside their floors, there is nothing to show: no card). -> {history} | null.
 *  Never throws. */
async function offlineCard(roomId, user) {
  try {
    if (!CL.on("history") || !user || !user.userId || !roomId) return null;
    await CL.init();
    const PA = require("./padaccess");
    await PA.init();
    if (!PA.full(user, roomId)) return null;
    const CV = require("./chatlogview");
    const V = await CV.view(roomId, user);
    if (!V.can.history || V.rk == null) return null;
    const S = await scanner(V, true);
    if (S.cmin >= C_MAX || !(await scan(S, "before", C_MAX, 1)).items.length) return null;
    return { history: block(V, actsOf(V, user)) };
  } catch (e) { console.error("[chatloghist] offline card:", e.message); return null; }
}

function register(app, { addUser }) {
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  const fail = (res, e) => {
    if (e && e.refuse) {
      if (e.retry) res.set("Retry-After", String(e.retry));
      return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || undefined, ...(e.why ? { why: e.why } : {}) });
    }
    console.error("[chatloghist]", e && e.message);
    return res.status(500).json({ ok: false, error: "Couldn't load earlier messages - try again." });
  };
  app.get("/api/rooms/:slug/history", addUser, async (req, res) => {
    head(res);
    try { res.json(await page(req.user, req.params.slug, req.query || {})); } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/history/state", addUser, async (req, res) => {
    head(res);
    try { res.json(await state(req.user, req.params.slug)); } catch (e) { fail(res, e); }
  });
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "64kb" });
  app.post("/api/rooms/:slug/history/check", addUser, json, async (req, res) => {
    head(res);
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page.", code: "origin" });
    try { res.json(await check(req.user, req.params.slug, req.body || {})); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, page, state, check, offlineCard, pageSql, scan, scanner, sealPos, openPos, readPos, timeOf, Refuse, hiddenLogins, fullHistory,
  dress,                                          // CL9: search results are dressed exactly like history's items
  PAGE, LIMIT_MAX, PER_MIN, AUX_PER_MIN, DAY_ITEMS, SCAN_MAX, BATCH_MAX, POS_TTL, CHECK_MAX, HIDDEN_SQL_MAX, PRESENCE,
  _setLimits: (o) => { Object.assign(limits, o || {}); HIT = null; HIT_AUX = null; },
  _reset: () => { Object.assign(limits, { perMin: PER_MIN, auxPerMin: AUX_PER_MIN, dayItems: DAY_ITEMS, scanMax: SCAN_MAX }); HIT = null; HIT_AUX = null; DAY.clear(); HX = { key: null, at: 0, size: -1, out: [], tx: [] }; },
  _day: (userId) => (DAY.get(String(userId)) || { n: 0 }).n,
};
