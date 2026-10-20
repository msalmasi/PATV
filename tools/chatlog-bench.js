#!/usr/bin/env node
// tools/chatlog-bench.js — CL2: the chat archive at volume (spec §3.12 / §3.15). Seeds SYNTHETIC rows (a Zipf vocabulary of
// made-up words - no real data) into a temp database with the archive's real DDL (chatlog.js MAIN_DDL / ARCHIVE_DDL / FTS_DDL /
// TRIGGERS), then checks the SHAPE of every query the archive's read paths use (EXPLAIN QUERY PLAN) and prints timings for
// the record. Timings vary by machine; the shapes must not:
//   history page      chat_log_room with both c bounds (CL8: chatloghist.pageSql, both directions; with the hidden NOT IN lists too)   floor -> cursor / at=    chat_log_room_ts
//   search            the FTS index with rowid bounds, chat_log by its primary key, never SCAN chat_log (CL9: chatlogsearch.ftsSql /
//                     ftsMatch - with and without the room token, the last-word prefix, one common word as a prefix and exact, the
//                     hidden set's NOT IN lists, From's fallback; the LIKE fallback's window on chat_log_room) - From itself on
//                     chat_log_who (whoSql, one key, in index order)
//   drift / dupes     primary-key ranges, chat_log_eid, chat_log_tx, chat_log_who
//   takedowns (CL6)   the owner sync's removed list on chat_log_rm (taken-down rows only) and the nightly 30-day pass on
//                     chat_log_rm_due (taken-down rows whose text is still there: purged rows leave it - CL6 fix-up)
//   purge (CL7)       the retention purge's keyset walk per class and the report's day counts on chat_log_room_ts (in index order);
//                     one delete batch of PURGE_BATCH rows is timed last (the FTS delete trigger per row)
// and it reports the room-token (rt) cost for the biggest vs the smallest room (CL9 adds the rt term only for rooms under
// RT_SHARE of the indexed rows).
//   node tools/chatlog-bench.js [--rows=2000000] [--db=<file>] [--keep]
// The node --test wrapper (test/chatlog-bench.test.js) runs it with a few thousand rows and asserts the shapes.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY = 86400000;
const KINDS = [["msg", 0.49], ["tx", 0.11], ["mic", 0.115], ["unmic", 0.115], ["join", 0.083], ["leave", 0.087]];
const ROOMS = [[0.55, 1], [0.75, 2], [0.87, 3], [0.94, 4], [0.98, 5], [1.0, 6]];
const PER_DAY = 23000;

// a small seeded PRNG (mulberry32) so runs are repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function vocabulary(rand, n = 30000) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const seen = new Set(), out = [];
  while (out.length < n) {
    const len = Math.max(1, Math.round(5 + 2 * (rand() + rand() + rand() - 1.5)));
    let w = "";
    for (let i = 0; i < len; i++) w += letters[Math.floor(rand() * 26)];
    if (!seen.has(w)) { seen.add(w); out.push(w); }
  }
  const cum = [];
  let s = 0;
  for (let i = 0; i < out.length; i++) { s += 1 / (i + 1); cum.push(s); }
  const word = () => {
    const x = rand() * s;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    return out[lo];
  };
  return { words: out, word };
}

const p = (db, fn, sql, args = []) => new Promise((resolve, reject) => db[fn](sql, args, function (e, r) { if (e) reject(e); else resolve(fn === "run" ? this : r); }));
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (e) => (e ? reject(e) : resolve())));

/** -> {rows, plans: {name: [detail...]}, timings: {name: ms}, shapes: {name: ok}, rt: {...}} */
async function run({ rows = 2000000, dbFile = null, keep = false, log = console.log, ddl = null } = {}) {
  const sqlite3 = require("sqlite3");
  const D = ddl || require(path.join(__dirname, "..", "chatlog"));
  const dir = dbFile ? null : fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-bench-"));
  const file = dbFile || path.join(dir, "bench.db");
  const db = new sqlite3.Database(file);
  await p(db, "run", "PRAGMA journal_mode = WAL");
  await p(db, "run", "PRAGMA synchronous = NORMAL");
  for (const s of [...D.MAIN_DDL, ...D.ARCHIVE_DDL]) await p(db, "run", s);
  await p(db, "run", D.FTS_DDL);
  const rand = rng(7);
  const V = vocabulary(rand);
  const text = (target) => { const out = []; let L = 0; while (L < target) { const w = V.word(); out.push(w); L += w.length + 1; } return out.join(" "); };
  const logins = Array.from({ length: 1500 }, (_, i) => "user" + String(i).padStart(4, "0"));
  const t0 = 1760000000000;
  const t1 = Date.now();
  // rooms 1..6
  for (let rk = 1; rk <= 6; rk++) await p(db, "run", "INSERT OR IGNORE INTO chatlog_rooms (rk, room_id, created) VALUES (?, ?, ?)", [rk, "Bench.Room" + rk, t0]);
  const stmt = db.prepare("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d, mid, tx, eid) VALUES (?, ?, ?, ?, ?, ?, ?, 'p', ?, ?, ?, ?)");
  const CHUNK = 50000;
  for (let base = 0; base < rows; base += CHUNK) {
    await exec(db, "BEGIN");
    const n = Math.min(CHUNK, rows - base);
    await new Promise((resolve, reject) => {
      let left = n, failed = false;
      for (let i = 1; i <= n; i++) {
        const c = base + i;
        const r = rand();
        let k = "msg", acc = 0;
        for (const [kk, pp] of KINDS) { acc += pp; if (r <= acc) { k = kk; break; } }
        const r2 = rand();
        const rk = ROOMS.find(([pp]) => r2 <= pp)[1];
        const ts = t0 + Math.floor(c * DAY / PER_DAY);
        const who = logins[Math.floor(rand() * logins.length)];
        let tx = null, txt = null, mid = null;
        if (k === "msg") { txt = text(Math.max(3, Math.floor(-Math.log(1 - rand()) * 75))); mid = "cf-m-bench-" + c; }
        else if (k === "tx") { txt = text(Math.max(10, Math.floor(206 + 80 * (rand() + rand() - 1)))); tx = "tx-" + c.toString(16).padStart(16, "0"); }
        const d = JSON.stringify(k === "unmic" ? { u: { display: who }, ms: 120000 } : { u: { display: who } });
        stmt.run([c, rk, ts, k, who, txt, "r" + rk, d, mid, tx, "bench-ev-" + c], (e) => {
          if (failed) return;
          if (e) { failed = true; return reject(e); }
          if (--left === 0) resolve();
        });
      }
    });
    await exec(db, "COMMIT");
  }
  await new Promise((r) => stmt.finalize(() => r()));
  await p(db, "run", `INSERT INTO chat_log_fts (rowid, text, rt) SELECT c, text, rt FROM chat_log WHERE ${D.INDEXABLE}`);
  for (const [, sql] of D.TRIGGERS) await p(db, "run", sql);
  log(`seeded ${rows.toLocaleString("en-US")} rows in ${((Date.now() - t1) / 1000).toFixed(1)} s (${file})`);

  const maxc = rows, now = t0 + Math.floor(rows * DAY / PER_DAY);
  const floorTs = now - 15 * 60e3;
  const fc = (await p(db, "all", "SELECT c FROM chat_log WHERE rk = 1 AND ts >= ? ORDER BY ts LIMIT 1", [floorTs]))[0];
  const floorC = fc ? fc.c : maxc;
  const common = V.words[2], rare = V.words[Math.min(V.words.length - 1, 25000)];
  // CL8: the history pages are chatloghist.js's own query (the per-class floors as cursors in a CASE, removed / Approved-era /
  // presence rules) - newest first, oldest first, and the "start of history" probe
  const CH = require(path.join(__dirname, "..", "chatloghist"));
  const HID = Array.from({ length: 300 }, (_, i) => "user" + String(i * 5).padStart(4, "0"));
  const CS = require(path.join(__dirname, "..", "chatlogsearch"));
  const CP = require(path.join(__dirname, "..", "chatlogpurge"));
  const Q = {
    history_page: [CH.pageSql({ dir: "before" }), [1, floorC, maxc + 1, floorC, floorC, floorC, 51]],
    history_after: [CH.pageSql({ dir: "after", sys: false, approved: false }), [1, floorC, 1e15, floorC, floorC, floorC, 51]],
    // CL8 fix-up: the page with the hidden set's left-out people as NOT IN lists (300 logins + 2 more for 🎙 lines) - still both
    // cursor bounds on chat_log_room, still in index order
    history_hidden: [CH.pageSql({ dir: "before", nOut: 300, nTx: 2 }), [1, floorC, maxc + 1, floorC, floorC, floorC, ...HID, "user1498", "user1499", ...HID, 51]],
    history_more_before: ["SELECT 1 FROM chat_log WHERE rk = ? AND c >= ? AND c < ? LIMIT 1", [1, floorC, floorC]],
    history_start: ["SELECT 1 FROM chat_log WHERE rk = ? AND c < ? LIMIT 1", [1, floorC]],
    floor_cursor: ["SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [1, floorTs]],
    at_jump: ["SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [1, now - 30 * DAY]],
    // CL9: chatlogsearch.js's own query (the index drives - a CROSS JOIN -, the rowid bounded on both sides, chat_log by its
    // primary key; the room, the kinds, the per-class floors in a CASE, From's keys and the Approved era filter the joined row)
    search_room_token: [CS.ftsSql(), [CS.ftsMatch(CS.parse(`"${rare}"`), 6), 0, maxc + 1, 6, ...CS.KINDS.all, 0, 0, CS.ROWS]],
    search_post_filter: [CS.ftsSql({ approved: false }), [CS.ftsMatch(CS.parse(`"${common}"`)), 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0, CS.ROWS]],
    search_last_prefix: [CS.ftsSql({ kinds: CS.KINDS.chat }), [CS.ftsMatch(CS.parse(`${common} ${rare.slice(0, 3)}`), 6), 0, maxc + 1, 6, ...CS.KINDS.chat, 0, 0, CS.ROWS]],
    // CL9 fix-up: the most usual search - ONE common word, so its last-word prefix covers the whole doclist of every word it starts
    // (the slow shape: chatlogsearch gives it PREFIX_BUDGET_MS, then matches the word whole) - and the same word exact
    search_single_prefix: [CS.ftsSql(), [CS.ftsMatch(CS.parse(common)), 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0, CS.ROWS]],
    search_single_exact: [CS.ftsSql(), [CS.ftsMatch(CS.exactLast(CS.parse(common))), 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0, CS.ROWS]],
    // CL9 fix-up: the people the hidden set leaves out (300 logins + 2 more for 🎙 lines), filters on the joined row
    search_hidden: [CS.ftsSql({ nOut: 300, nTx: 2 }), [CS.ftsMatch(CS.parse(`"${common}"`)), 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0,
                                                     ...CS.outParams(HID, ["user1498", "user1499"]), CS.ROWS]],
    // CL9 fix-up: From = the speaker's own lines on chat_log_who (one statement per key, in index order, the whole archive), matched
    // in JS; its fallback for a speaker past the budget = the index with their keys as a filter
    search_from: [CS.whoSql(), ["user0001", 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0, CS.WHO_ROWS]],
    search_from_fts: [CS.ftsSql({ from: 2 }), [CS.ftsMatch(CS.parse(`"${common}"`)), 0, maxc + 1, 1, ...CS.KINDS.all, 0, 0, "user0001", "u:none", CS.ROWS]],
    // the LIKE fallback (no FTS5, or a CJK query): a window of the room's newest indexable rows inside the floors, on chat_log_room
    like_window: [CS.likeSql({}, 2), [1, 0, maxc + 1, ...CS.KINDS.all, 0, 0, CS.LIKE_ROWS, CS.likePat(common), CS.likePat(rare), CS.ROWS]],
    like_window_end: [CS.windowSql({}) + " LIMIT 1 OFFSET ?", [1, 0, maxc + 1, ...CS.KINDS.all, 0, 0, CS.LIKE_ROWS - 1]],
    drift_rows: [`SELECT COUNT(*) AS n FROM chat_log WHERE c > ? AND c <= ? AND ${D.INDEXABLE}`, [Math.max(0, maxc - PER_DAY), maxc]],
    drift_indexed: ["SELECT COUNT(*) AS n FROM chat_log_fts_docsize WHERE id > ? AND id <= ?", [Math.max(0, maxc - PER_DAY), maxc]],
    dupe_eids: ["SELECT eid FROM chat_log WHERE eid IN (?, ?, ?)", ["bench-ev-1", "bench-ev-2", "nope"]],
    dupe_tx: ["SELECT tx FROM chat_log WHERE rk = ? AND tx IN (?, ?)", [1, "tx-0000000000000001", "tx-nope"]],
    per_login: ["SELECT c FROM chat_log WHERE who = ? ORDER BY c LIMIT 100", ["user0001"]],
    // CL6 (chatlogmod.js): the owner sync's removed list per room, and the nightly 30-day pass - both on the partial index of
    // taken-down rows only (chat_log_rm), which stays small whatever the archive's size
    removed_list: ["SELECT ts, who FROM chat_log WHERE rk = ? AND rm_at IS NOT NULL AND k IN ('msg','tx') AND who IS NOT NULL ORDER BY rm_at DESC LIMIT 500", [1]],
    // (CL6 fix-up: the pass walks chat_log_rm_due - taken-down rows whose text is still there, in (rm_at, c) order: chatlogmod.DUE_SQL)
    takedown_pass: [require(path.join(__dirname, "..", "chatlogmod")).DUE_SQL, [0, now, 0, 0, 1000]],
    // CL7 (chatlogpurge.js): the nightly retention purge's keyset walk of a room's rows below the cutoff, per class (oldest first,
    // after (ts, c)), and the report's day counts - on chat_log_room_ts, in index order, never a scan of chat_log
    purge_scan_chat: [CP.scanSql("chat"), [1, 0, now - 30 * DAY, 0, 0, CP.PURGE_BATCH]],
    purge_scan_tx: [CP.scanSql("tx"), [1, now - 40 * DAY, now - 30 * DAY, now - 35 * DAY, 5, CP.PURGE_BATCH]],
    purge_count: [CP.countSql("tx", 2), [1, now - 31 * DAY, now - 30 * DAY, "user0001", "user0002"]],
  };
  // what each shape must use (and never: a full scan of chat_log)
  const MUST = {
    history_page: /chat_log_room\b/, history_after: /chat_log_room\b/, history_hidden: /chat_log_room\b/, history_more_before: /chat_log_room\b/, history_start: /chat_log_room\b/,
    floor_cursor: /chat_log_room_ts/, at_jump: /chat_log_room_ts/,
    search_room_token: /VIRTUAL TABLE INDEX/, search_post_filter: /VIRTUAL TABLE INDEX/, search_last_prefix: /VIRTUAL TABLE INDEX/,
    search_single_prefix: /VIRTUAL TABLE INDEX/, search_single_exact: /VIRTUAL TABLE INDEX/, search_hidden: /VIRTUAL TABLE INDEX/,
    search_from: /chat_log_who \(who=\? AND c>\? AND c<\?\)/, search_from_fts: /VIRTUAL TABLE INDEX/,
    like_window: /chat_log_room\b/, like_window_end: /chat_log_room\b/,
    drift_rows: /INTEGER PRIMARY KEY/, drift_indexed: /INTEGER PRIMARY KEY|PRIMARY KEY/, dupe_eids: /chat_log_eid/, dupe_tx: /chat_log_tx/, per_login: /chat_log_who/,
    removed_list: /chat_log_rm/, takedown_pass: /chat_log_rm_due/,
    purge_scan_chat: /chat_log_room_ts \(rk=\? AND ts>\? AND ts<\?\)/, purge_scan_tx: /chat_log_room_ts \(rk=\? AND ts>\? AND ts<\?\)/,
    purge_count: /chat_log_room_ts \(rk=\? AND ts>\? AND ts<\?\)/,
  };
  const plans = {}, timings = {}, shapes = {};
  for (const [name, [sql, args]] of Object.entries(Q)) {
    const plan = (await p(db, "all", "EXPLAIN QUERY PLAN " + sql, args)).map((r) => r.detail);
    plans[name] = plan;
    const joined = plan.join(" | ");
    // (a walk of chat_log_rm isn't a scan of the archive: that partial index holds only the taken-down rows)
    const scan = plan.some((d) => /^SCAN (chat_log|l)\b/.test(d) && !/VIRTUAL TABLE/.test(d) && !/USING (COVERING )?INDEX chat_log_rm(_due)?\b/.test(d));
    const pkJoin = !/chat_log_fts f/.test(sql) || plan.some((d) => /SEARCH l USING INTEGER PRIMARY KEY/.test(d));
    shapes[name] = MUST[name].test(joined) && !scan && pkJoin;
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const a = process.hrtime.bigint(); await p(db, "all", sql, args); best = Math.min(best, Number(process.hrtime.bigint() - a) / 1e6); }
    timings[name] = best;
    log(`${best.toFixed(2).padStart(9)} ms  ${shapes[name] ? "ok  " : "BAD "} ${name.padEnd(20)} ${joined}`);
  }
  // the room token: a common word in the biggest room (55 % of rows) vs the smallest (2 %), with and without the rt term
  const rtq = (m, rk) => p(db, "all", "SELECT l.c FROM chat_log_fts f JOIN chat_log l ON l.c = f.rowid WHERE chat_log_fts MATCH ? AND l.rk = ? ORDER BY f.rowid DESC LIMIT 200", [m, rk]);
  const time = async (fn) => { let best = Infinity; for (let i = 0; i < 3; i++) { const a = process.hrtime.bigint(); await fn(); best = Math.min(best, Number(process.hrtime.bigint() - a) / 1e6); } return best; };
  const rt = {
    big_with_token: await time(() => rtq(`rt : "r1" AND text : "${common}"`, 1)), big_post_filter: await time(() => rtq(`text : "${common}"`, 1)),
    small_with_token: await time(() => rtq(`rt : "r6" AND text : "${common}"`, 6)), small_post_filter: await time(() => rtq(`text : "${common}"`, 6)),
  };
  log(`room token, common word: biggest room ${rt.big_with_token.toFixed(2)} ms with rt / ${rt.big_post_filter.toFixed(2)} ms post-filter; ` +
      `smallest room ${rt.small_with_token.toFixed(2)} ms with rt / ${rt.small_post_filter.toFixed(2)} ms post-filter (RT_SHARE ${D.RT_SHARE})`);
  // CL7: one retention-purge batch, for the record (last: it deletes) - the biggest room's PURGE_BATCH oldest chat-class rows read
  // and deleted in ONE transaction, as chatlogpurge does it (the FTS delete trigger runs per row; the spec wants each under 200 ms)
  const batch = await p(db, "all", CP.scanSql("chat"), [1, 0, now, 0, 0, CP.PURGE_BATCH]);
  const a0 = process.hrtime.bigint();
  await exec(db, "BEGIN");
  for (let i = 0; i < batch.length; i += 400) {
    const part = batch.slice(i, i + 400).map((r) => r.c);
    await p(db, "run", `DELETE FROM chat_log WHERE rk = ? AND c IN (${part.map(() => "?").join(",")})`, [1, ...part]);
  }
  await exec(db, "COMMIT");
  const purge = { rows: batch.length, ms: Number(process.hrtime.bigint() - a0) / 1e6 };
  log(`purge batch: ${purge.rows} rows deleted in ${purge.ms.toFixed(1)} ms (one transaction, the FTS delete trigger per row)`);
  await new Promise((r) => db.close(() => r()));
  if (!keep && dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* a temp dir */ } }
  return { rows, plans, timings, shapes, rt, purge, file: keep ? file : null };
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
  // chatlog.js loads dbUtils, which opens ./myapp.db: run from a temp folder so the bench never touches a real database
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-bench-cwd-"));
  process.chdir(scratch);
  run({ rows: Math.max(1000, parseInt(args.rows, 10) || 2000000), dbFile: args.db ? path.resolve(String(args.db)) : null, keep: !!args.keep })
    .then((r) => {
      const bad = Object.entries(r.shapes).filter(([, ok]) => !ok).map(([k]) => k);
      console.log(bad.length ? `BAD query shapes: ${bad.join(", ")}` : "every query shape is as expected");
      process.exit(bad.length ? 1 : 0);
    }, (e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
