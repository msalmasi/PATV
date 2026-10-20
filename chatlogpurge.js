// chatlogpurge.js — CL7: the pad chat archive's retention purge (the chat-history spec §3.12 "Purge", §3.2 exp_*, §2.5 / §2.6;
// decision 15: ON from the archive's switch-on - nothing can be due before the archive is 30 days old. Train 3 review: enforced -
// until chatlog.archive is first switched on (cfg.started_at) a pass only counts, why "not_started": the live feed's lines the
// archive never kept are not deleted on a site where the archive is still dark).
//
// ONE nightly pass is the archive's nightly work (chatlogmod.start() hands its scheduling over to this module):
//   1. CL6's 30-day text removal - hidden / removed lines lose their text 30 days after they were taken down (chatlogmod.nightly:
//      the owner's and staff's appeal copy; a legal hold keeps it) - "in the same pass, whatever the mode";
//   2. per room (chatlog_rooms): the tier tracking is brought up to date first (chatlogview.reconcileNow: a downgrade's 30-day
//      grace starts now, not at someone's next view), then the DELETION cutoff per item class - now minus the longest retention
//      of the tier now and of every tier lost within the last 30 days, each lapse with its own end (chatlogview.cutoffs /
//      graceOf - CL7 fix-up: a second downgrade inside a grace never shortens the first's), in Pepe's mirrored windows
//      (premium.retention):
//        chat class  msg, join, leave, mic, unmic, topic, live, note    chat_days / chat_prime / chat_plus
//        mic class   tx (🎙 transcripts)                                 rec_days  / rec_prime  / rec_plus
//      exp_* (the expiry watermarks every read path's floors use: they only move forward) is raised to the cutoff first; then
//      the rows below it are DELETED, oldest first, in batches of PURGE_BATCH (each its own dbUtils.tx, a yield between; a batch
//      slower than BATCH_MS halves the next): chat_log (the FTS entries go by the delete trigger), the room's counters, the
//      same lines in bridge_feed and the live feed - and (CL7 fix-up) the room's bridge_feed / live lines the archive never
//      kept (from before its seed, or from while the pad lacked the 💎 bridge perk) by the same cutoffs; the archive's first line
//      (first_c / first_ts: the admin card's "Since", view().start_ts) moves up to the oldest line left; the pass ends with a
//      bounded FTS5 merge, so the deleted lines' words leave the search index's segments;
//   3. the report: what was deleted and kept (and why), and what each of the next 7 days would delete, per room - the
//      /admin/bridge "Chat archive" card (GET /api/admin/chatlog/purge; POST {action: run | recount}).
// What a pass doesn't reach (the policy, the admin card and the release notes say so): copies with their own life - a quote or chat
// clip posted to the feed (until the post goes; the speaker can remove themselves from a quote), a 🔊 mic clip post, a 🔔 mention
// alert (the inbox keeps the newest 1,000 per person); backups until they expire; the database file's free pages until SQLite
// reuses them (no secure_delete) - only a staff purge (CL6) reaches the copies.
// Fail-safes (Pepe's own, pepe_retention.py): NOTHING is deleted - and nothing permanent (exp_*, the tier tracking: the purge's
// own reconcile runs with permanent false - CL7 fix-up) moves - while a tier can't be known (premium.js not loaded; a room without
// its tier tracking, or tracking that disagrees with the tier now) or Pepe's retention report is older than REPORT_FRESH_MS,
// hasn't come since the site started, or didn't name every tier's window validly (premium.retentionAt), or the clock looks wrong
// (CL7 fix-up: it went back past the last pass, or it stepped more than CLOCK_STEP_MS against the process's monotonic clock in the
// last CLOCK_HOLD_MS - the 30-day text removal waits then too). chatlog.purge OFF = report-only: exp_* still follows the cutoff ("deleted, or hidden while purge is off" -
// lines past retention never come back into view), nothing is deleted, and the privacy policy says "deleted once deletion is
// switched on" (chatlog.policy). A pass that couldn't delete for one of those reasons is retried at the next hourly check once
// it could (CL7 fix-up: it no longer uses up the night).
// Kept whatever the mode: a legal hold's room or speaker (chatlog_holds room:<rk> | who:<login or u:id> - their purged lines,
// who "h:<hash>", too) and a line with an open report (the admins decide first: SKIP_OPEN_REPORTS). CL7 fix-up: both are read
// from the database INSIDE each batch's transaction - a hold placed or a report opened while a pass runs is honoured from the next
// batch on.
// Where each room's scan starts: chatlog_meta purge:<rk> = {chat, tx: the cutoff (ms) everything below was deleted to, kept:
// rows kept below it, full_at}; a room with kept rows (a hold released? a report decided?) - or not rescanned for FULL_EVERY_MS
// - is scanned from its start again. The pass's report is chatlog_meta purge_report; purge_pass = the last real pass (the
// scheduler: once a night in NIGHT_UTC, any hour once LATE_MS passed, the next hourly check again after a pass cut short at
// PASS_MAX_MS or one that couldn't delete). Nothing here logs a line's text.
"use strict";
const { performance } = require("perf_hooks");
const { runQuery, getQuery, tx } = require("./dbUtils");
const CL = require("./chatlog");

// ── owner decisions (spec §3.12, decision 15) and limits: each one constant ──
const REPORT_FRESH_MS = 3600e3;            // Pepe's retention report must be younger than this, or nothing is deleted
const PURGE_BATCH = 1000;                  // rows per delete transaction (each well under 200 ms: the FTS delete trigger runs per row)
const MIN_BATCH = 100;
const BATCH_MS = 200;                      // a batch slower than this halves the next one (down to MIN_BATCH)
const LOOKAHEAD_DAYS = 7;                  // the report: what each of the next 7 days would delete
const SKIP_OPEN_REPORTS = true;            // a line with an open report is kept until the admins decide it
const RUN_EVERY_MS = 20 * 3600e3;          // one pass a night ...
const NIGHT_UTC = Object.freeze([6, 10]);  // ... between these UTC hours (02:00-06:00 New York in summer) ...
const LATE_MS = 36 * 3600e3;               // ... or at any hour once the last pass is this old (restarts across the night)
const CHECK_MS = 3600e3, FIRST_CHECK_MS = 5 * 60e3;
const PASS_MAX_MS = 20 * 60e3;             // one pass stops here; the next hourly check carries on where it stopped
const FULL_EVERY_MS = 7 * 864e5;           // a room is scanned from its start again this often (a line that arrived late and old)
const REPORT_ROOMS = 200;                  // rooms listed in the report (the busiest first; the totals cover every room)
// CL7 fix-up: the wall clock's sanity check (the cutoffs come from it)
const CLOCK_STEP_MS = 3600e3;              // the wall clock moved this much more (or less) than the monotonic clock: a step ...
const CLOCK_HOLD_MS = 24 * 3600e3;         // ... and nothing is deleted for this long after it (a glitch can be put right first)
const CLOCK_SLACK_MS = 10 * 60e3;          // the last pass more than this in the future: the clock went back
const FTS_MERGE_PAGES = 500;               // the bounded FTS5 merge step after a pass that deleted lines (like CL6's nightly)
// the reasons a pass couldn't delete that the next hourly check retries (the switch off is the owner's choice: not retried)
const RETRY_WHYS = Object.freeze(["stale_report", "tier_unknown", "archive_db", "clock"]);

const DAY = 864e5;
const CLASSES = ["chat", "tx"];
const CLASS_SQL = Object.freeze({ chat: "k <> 'tx'", tx: "k = 'tx'" });
const INDEXABLE_KINDS = ["msg", "tx", "topic"];
const TIER_RANK = Object.freeze({ standard: 0, prime: 1, unlimited: 2 });
const now = () => CL.now();
const yieldNow = () => new Promise((r) => setImmediate(r));
const byteLen = (s) => (s == null ? 0 : Buffer.byteLength(String(s), "utf8"));
const indexable = (r) => r.text != null && INDEXABLE_KINDS.includes(r.k) && r.rm_at == null && r.purged == null;
/** The bytes chatlog.writeRows counted for a row (its current values: a purge already took its own share back). */
const rowBytes = (r) => byteLen(r.text) + byteLen(r.d) + byteLen(r.who) + byteLen(r.mid) + byteLen(r.tx) + byteLen(r.eid) + 48;
const zeros = (n) => Array.from({ length: n }, () => 0);
const qs = (n) => Array.from({ length: n }, () => "?").join(",");

let batchSize = PURGE_BATCH, batchMs = BATCH_MS;      // tests
let busy = null;
let onBatch = null;                                   // tests: called before each batch's transaction

// ── the queries (tools/chatlog-bench.js checks their plans: chat_log_room_ts, in index order, never a scan of chat_log) ──
/** One batch of a room's rows of one class below the cutoff, oldest first, after (ts, c) - a keyset walk of chat_log_room_ts.
 *  params: rk, fromTs, cutoff, lastTs, lastC, limit */
function scanSql(cls) {
  return `SELECT c, ts, k, who, text, d, mid, tx, eid, rm_at, purged FROM chat_log
          WHERE rk = ? AND ts >= ? AND ts < ? AND (ts > ? OR c > ?) AND ${CLASS_SQL[cls]} ORDER BY ts, c LIMIT ?`;
}
/** How many of a room's rows of one class lie in [from, to) - leaving out nKeep held speakers. params: rk, from, to, ...keys */
function countSql(cls, nKeep = 0) {
  return `SELECT COUNT(*) AS n FROM chat_log WHERE rk = ? AND ts >= ? AND ts < ? AND ${CLASS_SQL[cls]}` +
         (nKeep ? ` AND (who IS NULL OR who NOT IN (${qs(nKeep)}))` : "");
}
async function roQuery(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);      // no read connection (tests / tools): the shared one
    throw e;
  }
}
const tableThere = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]).catch(() => [])).length > 0;
async function metaPut(key, value) {
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
}
async function metaJson(key) {
  try { const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", [key]))[0]; return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}

// ── the wall clock's sanity check (CL7 fix-up) ──
// The cutoffs are "now minus the window": a clock stepped forward (an NTP glitch, a VM restored with the wrong time) would delete
// lines inside retention, and Pepe's freshness check uses the same clock. Within the process the monotonic clock is the witness:
// a step of more than CLOCK_STEP_MS holds deletion for CLOCK_HOLD_MS (either way - a step back that is put right steps forward).
// A clock behind the last pass (it went back) deletes nothing in that pass and re-bases the schedule (dueAt).
let wallNow = () => Date.now(), monoNow = () => performance.now();       // tests
let clockRef = { w: wallNow(), m: monoNow() }, clockHeldUntil = 0, clockStep = null;
function clockTick() {
  const w = wallNow(), m = monoNow();
  const drift = (w - clockRef.w) - (m - clockRef.m);
  if (Math.abs(drift) > CLOCK_STEP_MS) {
    clockHeldUntil = m + CLOCK_HOLD_MS;
    clockStep = { at: w, ms: Math.round(drift) };
    console.warn(`[chatlogpurge] the wall clock stepped ${Math.round(drift / 60e3)} min against the monotonic clock: nothing is deleted for ${CLOCK_HOLD_MS / 3600e3} h`);
  }
  clockRef = { w, m };
}
/** -> null (the clock looks right) | "clock" (it stepped lately) | "clock_back" (behind the last pass) */
function clockWhy(t, last) {
  clockTick();
  if (monoNow() < clockHeldUntil) return "clock";
  if (last && Number(last.at) > t + CLOCK_SLACK_MS) return "clock_back";
  return null;
}

// ── the fail-safes ──
/** Pepe's retention report: {at (ms) | null, fresh}. Fresh = younger than REPORT_FRESH_MS (this process saw it; premium.js counts
 *  only a report naming every tier's window with a valid value). */
function reportAge(t = now()) {
  let at = null;
  try { at = require("./premium").retentionAt(); } catch (e) { at = null; }
  at = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : null;
  return { at, fresh: at != null && t - at < REPORT_FRESH_MS };
}
/** What a pass would do now: {mode: delete | report, why: null | switch_off | not_started | tier_unknown | stale_report | clock |
 *  clock_back | archive_db, report_at, permanent: exp_* and the tier tracking may move, clock_step: the last step seen {at, ms} | null}. */
async function modeNow(t = now(), last = undefined) {
  const fresh = reportAge(t);
  const out = { mode: "delete", why: null, report_at: fresh.at, permanent: false, clock_step: null };
  if (CL.archiveError && CL.archiveError()) return Object.assign(out, { mode: "report", why: "archive_db" });
  if (last === undefined) last = await metaJson("purge_pass");
  const clock = clockWhy(t, last);
  out.clock_step = clockStep;
  let premiumOk = false;
  try { premiumOk = await require("./chatlogview").ensurePremium(); } catch (e) { premiumOk = false; }
  out.permanent = premiumOk && fresh.fresh && !clock;
  if (!CL.on("purge")) return Object.assign(out, { mode: "report", why: "switch_off" });
  // Train 3 review (decision 15: "ON from the archive's switch-on"): nothing is deleted - not even the live feed's lines the
  // archive never kept (pruneFeed) - before chatlog.archive was first switched on (cfg.started_at): the switch defaults on, so on
  // a site where the archive ships dark the nightly pass would otherwise delete bridge_feed lines past retention for every room a
  // chat view gave a chatlog_rooms row. Counting (and exp_*, which only hides) go on as in report mode.
  if (!CL.cfg().started_at) return Object.assign(out, { mode: "report", why: "not_started" });
  if (!premiumOk) return Object.assign(out, { mode: "report", why: "tier_unknown" });
  if (!fresh.fresh) return Object.assign(out, { mode: "report", why: "stale_report" });
  if (clock) return Object.assign(out, { mode: "report", why: clock });
  return out;
}
/** What is kept below a cutoff, for the REPORT's counts: {rooms: Set(rk), who: Set(lower key and "h:<hash>" of each)} - a snapshot
 *  (the deletion itself reads the live holds per batch: liveKeep). */
async function keepers() {
  const CLM = require("./chatlogmod");
  await CLM.init();
  await CLM.loadHolds();
  const who = new Set();
  for (const k of CLM.heldWho()) { who.add(String(k).toLowerCase()); who.add("h:" + CL.hash(k)); }
  return { rooms: new Set([...CLM.heldRooms()].map(Number)), who };
}
const HASHES = new Map();
const hashOf = (w) => { let h = HASHES.get(w); if (!h) { h = CL.hash(w); HASHES.set(w, h); if (HASHES.size > 5000) HASHES.delete(HASHES.keys().next().value); } return h; };
/** CL7 fix-up: what keeps a batch's rows, read INSIDE its transaction (writes outside wait at dbUtils' gate while it is open): the
 *  legal holds as they are now (chatlog_holds: the room; a speaker - their login / u:<id>, and the "h:<hash>" lines they said
 *  incognito or that staff purged) and the open reports on these lines. A failed read fails the batch (nothing deleted).
 *  -> {room: the room is held, who: Set, reported: Set(c)} */
async function liveKeep(rk, cs) {
  let room = false;
  const who = new Set();
  for (const r of await getQuery("SELECT key FROM chatlog_holds")) {
    const k = String(r.key || "");
    if (k.startsWith("room:")) { if (Number(k.slice(5)) === Number(rk)) room = true; }
    else if (k.startsWith("who:")) { const w = k.slice(4).trim().toLowerCase(); if (w) { who.add(w); who.add("h:" + hashOf(w)); } }
  }
  const reported = new Set();
  if (SKIP_OPEN_REPORTS && !room) {
    for (let i = 0; i < cs.length; i += 400) {
      const part = cs.slice(i, i + 400);
      for (const r of await getQuery(`SELECT DISTINCT c FROM chatlog_reports WHERE state = 'open' AND c IN (${qs(part.length)})`, part)) reported.add(Number(r.c));
    }
  }
  return { room, who, reported };
}
const keptWhy = (L, c, who) => (who != null && L.who.has(String(who).toLowerCase()) ? "held" : L.reported.has(Number(c)) ? "reported" : null);

// ── one room ──
function liveCs(roomId) {
  try {
    const R = require("./bridge")._rooms.get(String(roomId));
    return new Set(R && Array.isArray(R.feed) ? R.feed.map((it) => Number(it.c)) : []);
  } catch (e) { return new Set(); }
}
/** Delete one class of a room's rows in [from, cut) - batches, oldest first; held / reported rows stay (counted).
 *  -> {deleted, held, reported, done (false = the pass's time ran out), heldRoom (a room hold came in: stopped)} */
async function purgeClass(rk, cls, from, cut, st, live, dropped) {
  const out = { deleted: 0, held: 0, reported: 0, done: true, heldRoom: false };
  const sql = scanSql(cls);
  let lastTs = Math.max(0, Math.floor(from)), lastC = 0;
  for (;;) {
    if (Date.now() - st.started > PASS_MAX_MS) { out.done = false; break; }
    if (onBatch) await onBatch({ rk, cls, batch: st.batches });
    const size = st.size, t0 = Date.now();
    let n = 0, last = null, gone = [], kept = { held: 0, reported: 0 }, heldRoom = false;
    await tx(async () => {
      const rows = await getQuery(sql, [rk, lastTs, cut, lastTs, lastC, size]);
      n = rows.length;
      if (!n) return;
      last = rows[n - 1];
      const L = await liveKeep(rk, rows.map((r) => Number(r.c)));
      if (L.room) { heldRoom = true; return; }
      let idx = 0, bytes = 0;
      gone = []; kept = { held: 0, reported: 0 };
      for (const r of rows) {
        const why = keptWhy(L, r.c, r.who);
        if (why) { kept[why]++; continue; }
        gone.push(Number(r.c));
        if (indexable(r)) idx++;
        bytes += rowBytes(r);
      }
      if (!gone.length) return;
      for (let i = 0; i < gone.length; i += 400) {
        const part = gone.slice(i, i + 400), q = qs(part.length);
        await runQuery(`DELETE FROM chat_log WHERE rk = ? AND c IN (${q})`, [rk, ...part]);
        if (st.hasFeed) await runQuery(`DELETE FROM bridge_feed WHERE c IN (${q})`, part);
      }
      await runQuery(`UPDATE chatlog_rooms SET "rows" = MAX(0, "rows" - ?), idx_rows = MAX(0, idx_rows - ?), bytes = MAX(0, bytes - ?) WHERE rk = ?`,
                     [gone.length, idx, bytes, rk]);
    });
    st.batches++;
    if (heldRoom) { out.heldRoom = true; break; }
    if (!n) break;
    lastTs = Number(last.ts); lastC = Number(last.c);
    out.deleted += gone.length; out.held += kept.held; out.reported += kept.reported;
    for (const c of gone) if (live.has(c)) dropped.push(c);
    if (Date.now() - t0 > batchMs) st.size = Math.max(Math.min(MIN_BATCH, st.size), Math.floor(st.size / 2));
    if (n < size) break;
    await yieldNow();
  }
  return out;
}
/** CL7 fix-up: the room's bridge_feed lines past the cutoffs that the archive never kept (from before its seed, from while the pad
 *  lacked the 💎 bridge perk) - the archived ones went with their chat_log rows. Holds and open reports keep theirs, like above.
 *  -> {deleted, cs (the deleted cursors), heldRoom} */
async function pruneFeed(roomId, rk, cut) {
  const out = { deleted: 0, cs: [], heldRoom: false };
  const top = Math.max(Number(cut.chat) || 0, Number(cut.tx) || 0);
  if (!(top > 0)) return out;
  let lastC = 0;
  for (;;) {
    let n = 0, heldRoom = false;
    const gone = [];
    await tx(async () => {
      const rows = await getQuery("SELECT c, ts, data FROM bridge_feed WHERE room_id = ? AND c > ? AND ts < ? ORDER BY c LIMIT ?",
                                  [String(roomId), lastC, Math.floor(top), PURGE_BATCH]);
      n = rows.length;
      if (!n) return;
      lastC = Number(rows[n - 1].c);
      const L = await liveKeep(rk, rows.map((r) => Number(r.c)));
      if (L.room) { heldRoom = true; return; }
      for (const r of rows) {
        let it = null;
        try { it = JSON.parse(r.data); } catch (e) { it = null; }
        const cls = it && it.k === "tx" ? "tx" : "chat";
        if (!(cut[cls] > 0 && Number(r.ts) < cut[cls])) continue;
        // (the speaker key the archive would have kept for it: a login, or "h:<hash>" for a line Pepe sent anonymised)
        let who = null;
        try { who = it ? CL.rowOf({ it: Object.assign({}, it, { c: Number(r.c) }) }, rk, "m").who : null; } catch (e) { who = null; }
        if (keptWhy(L, r.c, who)) continue;
        gone.push(Number(r.c));
      }
      for (let i = 0; i < gone.length; i += 400) {
        const part = gone.slice(i, i + 400);
        await runQuery(`DELETE FROM bridge_feed WHERE room_id = ? AND c IN (${qs(part.length)})`, [String(roomId), ...part]);
      }
    });
    if (heldRoom) { out.heldRoom = true; break; }
    out.deleted += gone.length;
    out.cs.push(...gone);
    if (n < PURGE_BATCH) break;
    await yieldNow();
  }
  return out;
}
/** CL7 fix-up: the archive's first line after a purge - first_c / first_ts follow the oldest line left (null when none is: the
 *  next line written sets them). */
async function moveFirst(roomId, rk) {
  let f = null;
  await tx(async () => {
    f = (await getQuery("SELECT c, ts FROM chat_log WHERE rk = ? ORDER BY c LIMIT 1", [rk]))[0] || null;
    await runQuery("UPDATE chatlog_rooms SET first_c = ?, first_ts = ? WHERE rk = ?", [f ? Number(f.c) : null, f ? Number(f.ts) : null, rk]);
  });
  try { require("./chatlogview").noteFirst(roomId, f ? f.ts : null); } catch (e) { /* the cached row re-reads it */ }
}
/** Rows of a room in [from, to) per class (read connection), held speakers left out unless keys is null. */
async function countRange(rk, cls, from, to, keys) {
  if (!(to > from)) return 0;
  const k = keys || [];
  return Number(((await roQuery(countSql(cls, k.length), [rk, Math.floor(from), Math.floor(to), ...k]))[0] || {}).n) || 0;
}
/** The next LOOKAHEAD_DAYS days: [n per day] - what each day's cutoff (the graces ending inside them included) adds. */
async function lookahead(rk, T, t, cut, keys) {
  const CV = require("./chatlogview");
  const out = [];
  let prev = { chat: cut.chat, tx: cut.tx };
  for (let i = 1; i <= LOOKAHEAD_DAYS; i++) {
    const next = CV.cutoffs(T, t + i * DAY);
    let n = 0;
    for (const cls of CLASSES) if (next[cls] > prev[cls]) n += await countRange(rk, cls, prev[cls], next[cls], keys);
    out.push(n);
    prev = { chat: Math.max(prev.chat, next.chat), tx: Math.max(prev.tx, next.tx) };
  }
  return out;
}

async function purgeRoom(r, ctx) {
  const { t, K, marks, st, mode } = ctx;
  const CV = require("./chatlogview");
  const rk = Number(r.rk), id = String(r.room_id);
  const res = { room_id: id, rk, tier: null, del_tier: null, grace_until: null, lapsed: [], cut: null, deleted: 0, feed_deleted: 0,
                kept: { held: 0, reported: 0 }, due: 0, held_room: K.rooms.has(rk), unknown: false, ahead: zeros(LOOKAHEAD_DAYS) };
  const permanent = !!mode.permanent && !ctx.dry;
  // the tier: tracked now (a downgrade's grace starts at this moment) - unknown = nothing happens to this room. CL7 fix-up: while
  // the pass may move nothing permanent (a stale report, a clock problem, a recount) its reconcile moves no exp_* and no tracking
  let T = null, tier = null;
  if (mode.why !== "tier_unknown") {
    await CV.reconcileNow(id, { permanent });
    T = CV.tierOf(id);
    tier = CV.padTier(id);
  }
  if (!T || !tier || T.tier !== tier) { res.unknown = true; return res; }
  res.tier = T.tier;
  // every lapse still in its grace (CL7 fix-up: each with its own end), highest tier first
  const g = CV.graceOf(T, t);
  res.lapsed = g.map((e) => ({ tier: e.tier, until: e.until }));
  res.del_tier = g.length ? g[0].tier : T.tier;
  res.grace_until = g.length ? Math.max(...g.map((e) => e.until)) : null;
  const cut = CV.cutoffs(T, t);
  res.cut = cut;
  // exp_* first: the lines below the cutoff are out of everyone's view for good before any of them is deleted
  if (permanent) await CV.raiseExp(id, cut);
  // CL7 fix-up: whether the archive holds lines here is asked of chat_log itself (chat_log_room) - never the rows counter, which
  // nothing checks for drift (a counter at 0 would skip the room for good)
  const has = (await getQuery("SELECT 1 FROM chat_log WHERE rk = ? LIMIT 1", [rk])).length > 0;
  const deleting = mode.mode === "delete" && !ctx.dry;
  const live = deleting ? liveCs(id) : null, dropped = [];
  const M = marks.get(rk) || { chat: 0, tx: 0, kept: 0, full_at: 0 };
  let keys = res.held_room ? null : [...K.who];
  if (has && deleting && !res.held_room) {
    const full = Number(M.kept) > 0 || t - (Number(M.full_at) || 0) >= FULL_EVERY_MS;
    let done = true, kept = 0, heldNow = false;
    for (const cls of CLASSES) {
      if (!(cut[cls] > 0)) continue;                           // kept for good
      const from = full ? 0 : Number(M[cls]) || 0;
      if (!(cut[cls] > from)) continue;
      const x = await purgeClass(rk, cls, from, cut[cls], st, live, dropped);
      res.deleted += x.deleted; res.kept.held += x.held; res.kept.reported += x.reported;
      kept += x.held + x.reported;
      if (x.heldRoom) { heldNow = true; break; }               // a room hold came in during the pass: its rows stay (rescanned later)
      if (x.done) M[cls] = Math.max(Number(M[cls]) || 0, cut[cls]);
      else { done = false; break; }
    }
    if (heldNow) kept = Math.max(kept, 1);
    M.kept = kept;
    if (full && done && !heldNow) M.full_at = t;
    await metaPut("purge:" + rk, JSON.stringify({ chat: Number(M.chat) || 0, tx: Number(M.tx) || 0, kept: M.kept, full_at: Number(M.full_at) || 0 }));
    res.due = kept;                                             // what stays below the cutoff (held / reported)
    res.partial = !done;
    if (res.deleted) {
      await moveFirst(id, rk);
      try { CV.noteGone(id); } catch (e) { /* open pages re-check at their next load */ }
    }
    if (heldNow) {
      // the room's hold came in while this pass worked on it: what is left below the cutoffs stays, all of it held
      res.held_room = true;
      keys = null;
      res.due = await countBelow(rk, cut, { kept: 1 }, null);
      res.kept = { held: res.due, reported: 0 };
    }
  } else if (has) {
    // report-only (the switch off, a stale report, a dry recount) or a held room: what a pass would delete now
    res.due = await countBelow(rk, cut, M, keys);
    if (res.held_room) res.kept.held = res.due;
  }
  // CL7 fix-up: then the room's live-feed copies the archive never kept, by the same cutoffs (holds and open reports kept)
  if (deleting && !res.held_room) {
    const fd = await pruneFeed(id, rk, cut);
    res.feed_deleted = fd.deleted;
    for (const c of fd.cs) if (live.has(c)) dropped.push(c);
    if (fd.heldRoom) res.held_room = true;
  }
  if (dropped.length) await dropLive(id, dropped);
  if (has) res.ahead = await lookahead(rk, T, t, cut, keys);
  return res;
}
/** What lies below the cutoffs from the room's marks (a room with kept rows: from its start). */
async function countBelow(rk, cut, M, keys) {
  let n = 0;
  for (const cls of CLASSES) {
    if (!(cut[cls] > 0)) continue;
    const from = Number(M.kept) > 0 ? 0 : Number(M[cls]) || 0;
    n += await countRange(rk, cls, from, cut[cls], keys);
  }
  return n;
}
/** The deleted lines leave the live feed (R.feed) - CL7 fix-up: never through the takedown ring (`removed`), which keeps the last
 *  200 moderator / author takedowns for open pages; these lines are below every viewer's floor (exp_* / the tier's window). */
async function dropLive(roomId, cs) {
  try { await require("./bridge").takeDown(roomId, cs, { db: false, ring: false }); } catch (e) { console.error("[chatlogpurge] live drop:", e.message); }
}

// ── the pass ──
/** One pass. opts.dry = count only (no text removal, no exp_*, no deletion); opts.manual = asked from the admin card.
 *  -> the report (also stored: chatlog_meta purge_report; a real pass also purge_pass) | {busy: true} */
function run(opts = {}) {
  if (busy) return Promise.resolve({ busy: true });
  busy = pass(opts).finally(() => { busy = null; });
  return busy;
}
async function pass({ dry = false, manual = false, by = null } = {}) {
  const started = Date.now();
  const t = now();
  const out = { at: t, dry: !!dry, manual: !!manual, by: by ? String(by).slice(0, 40) : null, mode: "report", why: null, report_at: null, partial: false,
                error: null, failed: false, deleted: 0, feed_deleted: 0, kept: { held: 0, reported: 0 }, due: 0, blanked: 0, blanked_held: 0, blanked_reported: 0,
                views: 0, batches: 0, batch_size: batchSize, merged: false, ahead: zeros(LOOKAHEAD_DAYS), rooms: [], rooms_total: 0, unknown: 0, ms: 0 };
  try {
    await CL.init();
    const CV = require("./chatlogview");
    await CV.init();
    const mode = await modeNow(t);
    Object.assign(out, { mode: dry ? "report" : mode.mode, why: dry && !mode.why ? "dry" : mode.why, report_at: mode.report_at });
    if (mode.why === "archive_db") return finish(out, started);
    // 1. CL6's 30-day text removal of hidden / removed lines - whatever the purge switch says (CL7 fix-up: but not on a clock that
    //    looks wrong - "30 days ago" comes from it too)
    if (!dry && mode.why !== "clock" && mode.why !== "clock_back") {
      try {
        const n = await require("./chatlogmod").nightly({ t });
        out.blanked = Number(n.purged) || 0; out.blanked_held = Number(n.skipped_held) || 0; out.views = Number(n.views) || 0;
        out.blanked_reported = Number(n.skipped_reported) || 0;              // CL6 fix-up: kept while a report on them is open
      } catch (e) { out.error = "the 30-day text removal: " + String(e && e.message).slice(0, 160); console.error("[chatlogpurge] takedown pass:", e.message); }
    }
    // 2. the rooms
    const K = await keepers();
    const marks = new Map();
    for (const m of await getQuery("SELECT key, value FROM chatlog_meta WHERE key LIKE 'purge:%'")) {
      try { const v = JSON.parse(m.value); if (v && typeof v === "object") marks.set(Number(String(m.key).slice(6)), v); } catch (e) { /* a fresh scan */ }
    }
    const st = { started, size: batchSize, batches: 0, hasFeed: await tableThere("bridge_feed") };
    const rooms = await getQuery("SELECT rk, room_id FROM chatlog_rooms ORDER BY rk");
    const all = [];
    for (const r of rooms) {
      if (Date.now() - started > PASS_MAX_MS) { out.partial = true; break; }
      let res;
      try { res = await purgeRoom(r, { t, K, marks, st, mode, dry }); } catch (e) {
        out.error = out.error || "room " + r.rk + ": " + String(e && e.message).slice(0, 160);
        console.error(`[chatlogpurge] room ${r.rk}:`, e.message);
        continue;
      }
      all.push(res);
      if (res.partial) out.partial = true;
      await yieldNow();
    }
    for (const res of all) {
      out.deleted += res.deleted; out.feed_deleted += res.feed_deleted; out.kept.held += res.kept.held; out.kept.reported += res.kept.reported; out.due += res.due;
      if (res.unknown) out.unknown++;
      res.ahead.forEach((n, i) => { out.ahead[i] += n; });
    }
    // CL7 fix-up: the deleted lines' words leave the search index's segments (a bounded FTS5 merge step, like CL6's nightly)
    if (out.deleted) {
      try { await tx(() => runQuery(`INSERT INTO chat_log_fts (chat_log_fts, rank) VALUES ('merge', ${FTS_MERGE_PAGES})`)); out.merged = true; }
      catch (e) { /* no index (search's fallback) */ }
    }
    const weight = (x) => x.deleted + x.feed_deleted + x.due + x.ahead.reduce((a, b) => a + b, 0);
    const listed = all.filter((x) => weight(x) > 0 || x.unknown || x.held_room || x.grace_until);
    out.rooms_total = listed.length;
    out.rooms = listed.sort((a, b) => weight(b) - weight(a)).slice(0, REPORT_ROOMS);
    out.batches = st.batches; out.batch_size = st.size;
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200);
    out.failed = true;                                      // the rooms weren't done: the next hourly check tries again
    console.error("[chatlogpurge] pass:", e.message);
  }
  return finish(out, started);
}
async function finish(out, started) {
  out.ms = Date.now() - started;
  // CL7 fix-up: a pass that couldn't delete (Pepe's report stale, tiers unknown, the archive unreadable, the clock stepped) or
  // failed before the rooms were done doesn't use up the night - the next hourly check tries again once it could delete
  out.retry = !out.dry && (out.failed || (out.mode !== "delete" && RETRY_WHYS.includes(out.why)));
  try {
    await metaPut("purge_report", JSON.stringify(out));
    if (!out.dry) await metaPut("purge_pass", JSON.stringify({ at: out.at, partial: !!out.partial, error: !!out.error, retry: !!out.retry, mode: out.mode, why: out.why || null }));
  } catch (e) { console.error("[chatlogpurge] report:", e.message); }
  if (!out.dry && (out.deleted || out.feed_deleted || out.blanked)) {
    // counts only - never a line, never a name
    console.log(`[chatlogpurge] ${out.deleted} line(s) past retention deleted (+${out.feed_deleted} never archived), ${out.kept.held} kept by a legal hold,` +
                ` ${out.kept.reported} by an open report; ${out.blanked} hidden line(s) blanked after 30 days (${out.ms} ms, ${out.batches} batch(es))`);
    try { await require("./rooms").event(null, "chatlog.purge", out.by || "system", `deleted ${out.deleted}, blanked ${out.blanked}` + (out.partial ? " (continues)" : "")); }
    catch (e) { /* audit is best effort */ }
  } else if (!out.dry && out.mode !== "delete" && out.why && out.why !== "switch_off" && out.why !== "not_started") {
    console.log(`[chatlogpurge] nothing deleted: ${out.why}` + (out.retry ? " (the next hourly check tries again)" : ""));
  }
  return out;
}

// ── the schedule ──
/** Is a pass due at t (ms), after the last real pass {at, partial, retry}? */
function dueAt(t, last) {
  if (!last || !(Number(last.at) > 0)) return true;
  const age = t - Number(last.at);
  if (age < -CHECK_MS) return true;                           // CL7 fix-up: the last pass lies in the future - the clock went back:
                                                              // a pass (deleting nothing: clock_back) re-bases the schedule
  if (age < 0) return false;
  if (last.partial || last.retry) return age >= CHECK_MS - 60e3;   // cut short / couldn't delete: the next hourly check
  if (age >= LATE_MS) return true;
  const h = new Date(t).getUTCHours();
  return age >= RUN_EVERY_MS && h >= NIGHT_UTC[0] && h < NIGHT_UTC[1];
}
/** The hourly check: a pass when one is due. A retry of a pass that couldn't delete runs only once it could (or when the night's
 *  schedule is due anyway) - a long Pepe outage doesn't cost an hourly report pass. -> the report | null (nothing ran) */
async function checkNow() {
  await CL.init();
  const t = now();
  const last = await metaJson("purge_pass");
  if (!dueAt(t, last)) return null;
  if (last && last.retry && !last.partial && !dueAt(t, Object.assign({}, last, { retry: false }))) {
    const m = await modeNow(t, last);
    if (m.mode !== "delete") return null;
  }
  return run();
}
let timer = null;
/** The hourly check (idempotent; chatlogmod.start() and register() call it). */
function start() {
  if (timer) return;
  const check = async () => {
    try { await checkNow(); } catch (e) { console.error("[chatlogpurge] nightly:", e.message); }
  };
  const first = setTimeout(check, FIRST_CHECK_MS);
  if (first.unref) first.unref();
  timer = setInterval(check, CHECK_MS);
  if (timer.unref) timer.unref();
}

// ── the admin card ──
async function adminView() {
  await CL.init();
  const t = now();
  const last = await metaJson("purge_pass");
  const mode = await modeNow(t, last);
  const report = await metaJson("purge_report");
  if (report && Array.isArray(report.rooms)) {
    let R = null;
    try { R = require("./rooms"); } catch (e) { R = null; }
    for (const x of report.rooms) {
      const reg = R ? R.getCached(x.room_id) : null;
      x.title = reg ? reg.title || null : null;
      x.slug = reg ? reg.slug || null : null;
    }
  }
  return { report, busy: !!busy, mode, switch: CL.on("purge"), last_pass: last, next_ok: dueAt(t, last),
           rules: { batch: PURGE_BATCH, fresh_min: Math.round(REPORT_FRESH_MS / 60e3), lookahead: LOOKAHEAD_DAYS, night_utc: NIGHT_UTC, grace_days: 30,
                    open_reports_kept: SKIP_OPEN_REPORTS, clock_hold_h: CLOCK_HOLD_MS / 3600e3 } };
}
function register(app, { addUser }) {
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  start();
  const can = (req) => SP.can(req.user, "chatlog.admin");
  app.get("/api/admin/chatlog/purge", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { res.json({ ok: true, ...(await adminView()) }); } catch (e) { console.error("[chatlogpurge] admin:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/chatlog/purge", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const action = String((req.body || {}).action || "");
    if (action !== "run" && action !== "recount") return res.status(400).json({ ok: false, error: "run or recount" });
    if (busy) return res.status(409).json({ ok: false, error: "A pass is running - wait for it to finish.", code: "busy" });
    const by = req.user.username || null;
    run({ dry: action === "recount", manual: true, by }).catch((e) => console.error("[chatlogpurge] manual pass:", e.message));
    try { await require("./rooms").event(null, "chatlog.purge", by, action === "run" ? "pass started by hand" : "recount"); } catch (e) { /* audit */ }
    res.json({ ok: true, started: true });
  });
}

module.exports = {
  run, start, register, adminView, modeNow, reportAge, dueAt, checkNow, scanSql, countSql, keepers, liveKeep,
  REPORT_FRESH_MS, PURGE_BATCH, MIN_BATCH, BATCH_MS, LOOKAHEAD_DAYS, SKIP_OPEN_REPORTS, RUN_EVERY_MS, NIGHT_UTC, LATE_MS, CHECK_MS, PASS_MAX_MS, FULL_EVERY_MS,
  CLOCK_STEP_MS, CLOCK_HOLD_MS, CLOCK_SLACK_MS, RETRY_WHYS,
  busy: () => !!busy,
  _setBatch: (n, ms) => { batchSize = n > 0 ? Math.floor(n) : PURGE_BATCH; batchMs = ms != null ? ms : BATCH_MS; },
  _onBatch: (f) => { onBatch = typeof f === "function" ? f : null; },
  /** tests: the clocks the sanity check compares ({wall, mono} functions; none = the real ones) and a clean slate */
  _setClockSource: ({ wall = null, mono = null } = {}) => {
    wallNow = wall || (() => Date.now()); monoNow = mono || (() => performance.now());
    clockRef = { w: wallNow(), m: monoNow() }; clockHeldUntil = 0; clockStep = null;
  },
};
