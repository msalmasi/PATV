#!/usr/bin/env node
// keep-staging-tables.js - refresh-staging-db.sh's per-environment tables (1.99acf).
//
//   node deploy/keep-staging-tables.js <staging's current DB> <the fresh copy of prod>
//
// The fresh copy comes from prod, but some tables belong to the environment, not to the data. Copying prod's would hand
// staging prod's switches (a family's legacy-enforce, events = enforce, bad_key = refuse: staging Pepe, with no key minted
// on staging, refused on every bridge sync), prod's usage history (the "14 days at zero on prod AND staging" retirement
// count and the observed scopes on staging's /admin/keys would be prod's), and prod's unposted hub_outbox rows (posted to
// the staging hub once HUB_V1_URL is set there). So, in the copy, in ONE transaction:
//   KEEP   prod's rows go, staging's own come back (by the columns both tables have; a table the copy lacks is created
//          from staging's own CREATE statement first - staging can be a release ahead of prod).
//   EMPTY  hub_outbox: prod's rows go and staging's id sequence carries on (never below what the staging hub has seen -
//          its feed positions rely on monotonic ids; the hub heals from snapshots). 1.99acm: hub_hidden_h (Pepe's hidden_h
//          set as prod's Pepe reported it - staging's Pepe repopulates it on his next sync) and hub_inbound_nonces, both
//          BEFORE hub_outbox: prod's hh trigger fires on those deletes once staging's switches are back, and its rows must
//          land in the outbox before the outbox is emptied, never after. 1.99add: hub_hidden_meta (the list prod's Pepe sent
//          last - staging's Pepe is another run) and hub_hidden_held (prod's batches waiting for prod's owner) go too.
//          hub_hidden_set - the sticky hidden set - is NOT listed: the copy keeps prod's, so the people hidden on prod stay
//          hidden in the prod chat lines staging now holds (staging's Pepe adds his own on his next sync).
// If that fails, a second transaction only clears KEEP + EMPTY in the copy (staging starts with defaults: no keys, every
// switch at its safe default). Exit 0 when either worked, 1 when the copy couldn't be made safe (the caller then keeps
// staging's old DB). Prints table names and row counts only - never a row.
// CL2: the pad chat archive (chatlog.js) is KEEP too - staging keeps its own archive, switches and hidden set, and prod's chat
// never lands on staging. The archive's FTS triggers are dropped in the copy first (the site re-makes them at start), so
// replacing chat_log costs no index work per row; the index is then emptied and re-filled from staging's rows (batches).
// CL2 fix-up: so are the live feed's own tables (bridge_feed, bridge_rooms) - prod's rooms' live tails would otherwise sit in
// staging's bridge_feed (nothing drops a room staging's Pepe never bridges) and staging's first archive switch-on would SEED
// them into staging's archive. And every row the copy loses is overwritten with zeros (secure_delete): prod's chat text never
// stays behind in the copy's free pages.
// Train 3 review: when staging's archive lives in its own CHATLOG_DB (no chat_log in staging's myapp.db), the copy's chat_log and
// chat_log_fts are DROPPED (after their rows go), not left empty - else staging's next start would find chat_log in myapp.db with
// staging's own counters / started_at, keep the archive there and ignore staging's chatlog.db (a split).
"use strict";
const path = require("path");

// CL2: chatlog.js TABLES (kept in step by test/refresh-staging-keep.test.js)
const CHATLOG = ["chatlog_rooms", "chat_log", "chatlog_hidden", "chatlog_tx_hidden", "chatlog_private_ever", "chatlog_hidden_held",
                 "chatlog_hidden_names", "pad_chat_cfg", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views",
                 "chatlog_exports", "chatlog_meta",
                 "chatlog_erase_wait",                   // S1 V4 fix-up: its line ids are staging's own archive's
                 "chat_log_veil"];                       // wave 2: who is behind each veiled line + hidden words (prod's never land here)
const CHATLOG_TRIGGERS = ["chat_log_ai", "chat_log_ad", "chat_log_au", "chat_log_veil_ad", "chat_log_veil_purge"];
const INDEXABLE = "text IS NOT NULL AND k IN ('msg','tx','topic') AND rm_at IS NULL AND purged IS NULL";     // chatlog.INDEXABLE
// CL2 fix-up: the pad chat's live feed (bridge.js) - the archive's seed reads bridge_feed, and its cursors must stay staging's own
// wave 2 WP-2: and its privacy wire v2 side tables (bridge_veil: the real identity / hidden words of each veiled live item;
// bridge_rooms_veil: of each veiled roster / mic entry) - real identities and hidden words must never be copied into staging
const LIVE_FEED = ["bridge_rooms", "bridge_feed", "bridge_veil", "bridge_rooms_veil"];
// wave 2 WP-2: frog-name sessions (frognames.js, no logins but prod's open sessions' keyed handles) and the see-through audit
// (seethrough.js: which logins an admin revealed) - staging's own. WP-5: + moderation evidence clips (evidence.js: whose voice, when,
// who saved it - the audio itself sits in each environment's own evidence directory and is never copied)
const VEIL = ["incog_alias", "seethrough_log", "seethrough_toggle", "evidence_clips"];
// (owner 11-02: camfrog_roomstats_veiled - Pepe's !bridge hide people, server-only - is NOT listed: like hub_hidden_set the copy keeps
//  prod's, because it is what masks those people in prod's room notes, copied along with it in camfrog_roomstats; staging's Pepe
//  replaces it on his next sync and the people he drops stay masked while the copied sticky hidden set holds them)
const KEEP = ["bot_keys", "bot_keys_settings", "bot_key_families", "hubseam_settings",          // keys + switches
              "bot_route_log", "legacy_token_use", "legacy_token_daily", "events_auth_log", "bridge_spans",   // logs
              "pad_hub",         // S1-D1: the staging hub knows staging's hub pad ids (padhub.js mints the new pads' after the copy)
              "chat_switches",   // S1 Q4 (ADR 0007 D3): staging's own CHAT_HUB (a prod value would switch the staging pilot on or off)
              "micrec_meta",     // mic retention: staging's own mic-recordings policy switch (micrec.js - staging tries it before prod)
              ...CHATLOG, ...LIVE_FEED, ...VEIL];
// hub_outbox LAST: the copy carries prod's triggers (huboutbox.init creates them on prod whatever the switches say), and with
// staging's switches already restored a DELETE of a source table (hub_hidden_h's hh trigger) would write a row of prod's
// data into the outbox just emptied - so every source table is emptied first, the outbox after them.
const EMPTY = ["hub_hidden_h", "hub_hidden_meta", "hub_hidden_held", "hub_inbound_nonces", "hub_outbox"];
// wave2 integration review (P4 / DARK-1 / T-2): prod rows that pair a frog name with the real login behind it, in tables whose other
// rows stay prod's - scrubbed in the copy (same transaction), so real identities never cross here either:
//   micfollow_excl  a VEILED exclusion (a ✕ on a cover: `vlogin` = the person, `veiled` = the frog name then) - the row goes (its
//                   stage_exclude seethrough_log row is KEEP already); by-name rows stay prod's, as before
//   feed_voices     a J-7 frog-name clip (`alias` = the frog name it was posted under): its speakers' logins are blanked (the post,
//                   titled with the frog name, stays)
//   sb_clips        owner 11-02: a frog-name clip on a room soundboard (`subject_alias` = the frog name it shows): the login behind it
//                   is blanked (the clip, labelled with the frog name, stays)
// A column the copy lacks (prod a release behind: no such rows yet) skips its step.
const SCRUB = [
  { table: "micfollow_excl", col: "vlogin", sql: "DELETE FROM main.micfollow_excl WHERE vlogin IS NOT NULL" },
  { table: "feed_voices", col: "alias", sql: "UPDATE main.feed_voices SET logins = '  ' WHERE alias IS NOT NULL AND logins IS NOT NULL AND logins <> '  '" },
  { table: "sb_clips", col: "subject_alias", sql: "UPDATE main.sb_clips SET subject_login = NULL WHERE subject_alias IS NOT NULL AND subject_login IS NOT NULL" },
];
const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const q = (n) => { if (!NAME_RE.test(n)) throw new Error("bad name " + n); return '"' + n + '"'; };

function open(sqlite3, file) {
  return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(db))); });
}
const P = (db, fn, sql, args = []) => new Promise((resolve, reject) => db[fn](sql, args, function (e, r) { if (e) reject(e); else resolve(fn === "run" ? this : r); }));
const run = (db, sql, args) => P(db, "run", sql, args);
const all = (db, sql, args) => P(db, "all", sql, args);
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (e) => (e ? reject(e) : resolve())));

async function tableSql(db, schema, t) {
  const r = (await all(db, `SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`, [t]))[0];
  return r ? r.sql : null;
}
async function columns(db, schema, t) {
  return (await all(db, `SELECT name FROM pragma_table_info(?, ?)`, [t, schema])).map((r) => r.name);
}
/** Columns staging's table has and the copy's lacks (staging deployed a release first): added to the copy, so staging's
 *  rows come back whole. (A NOT NULL column without a default is added nullable - ALTER TABLE can't add it otherwise.) */
async function addMissingColumns(db, t) {
  const have = new Set(await columns(db, "main", t));
  const want = await all(db, `SELECT name, type, "notnull" AS nn, dflt_value AS dflt FROM pragma_table_info(?, 'old')`, [t]);
  for (const c of want) {
    if (have.has(c.name) || !NAME_RE.test(c.name)) continue;
    const type = /^[A-Za-z ]{0,30}$/.test(String(c.type || "")) ? String(c.type || "") : "";
    const dflt = c.dflt != null && /^('[^']*'|-?\d+(\.\d+)?|NULL)$/i.test(String(c.dflt)) ? " DEFAULT " + c.dflt : "";
    await run(db, `ALTER TABLE main.${q(t)} ADD COLUMN ${q(c.name)} ${type}${dflt && c.nn ? " NOT NULL" : ""}${dflt}`);
  }
}
async function seqOf(db, schema, t) {
  try { const r = (await all(db, `SELECT seq FROM ${schema}.sqlite_sequence WHERE name = ?`, [t]))[0]; return r ? Number(r.seq) || 0 : 0; }
  catch (e) { return 0; }                                                    // no AUTOINCREMENT table there yet
}

/** CL2: the archive's FTS triggers out of the copy (chatlog.js re-makes them at start, after its FTS5 self-test). */
async function dropChatlogTriggers(db) {
  for (const t of CHATLOG_TRIGGERS) await run(db, `DROP TRIGGER IF EXISTS main.${q(t)}`);
}
/** CL2: the archive's FTS index of the copy emptied and re-filled from the chat_log rows it now has (staging's), in batches.
 *  A copy without the index gets staging's own CREATE statement. -> {table, reindexed} | null (no index on either side) */
async function reindexChatlog(db) {
  const inCopy = await tableSql(db, "main", "chat_log_fts");
  const inOld = await tableSql(db, "old", "chat_log_fts").catch(() => null);
  if (!inCopy && !inOld) return null;
  // Train 3 review: the copy's chat_log went (staging's archive lives in CHATLOG_DB, keep() below) - its index goes with it
  if (inCopy && !(await tableSql(db, "main", "chat_log"))) {
    await run(db, "INSERT INTO main.chat_log_fts (chat_log_fts) VALUES ('delete-all')");
    await run(db, "DROP TABLE main.chat_log_fts");
    return { table: "chat_log_fts", dropped: true };
  }
  if (!inCopy) await exec(db, inOld);                                       // unqualified CREATE VIRTUAL TABLE: lands in main
  await run(db, "INSERT INTO main.chat_log_fts (chat_log_fts) VALUES ('delete-all')");
  let n = 0;
  if (await tableSql(db, "main", "chat_log")) {
    for (let after = 0; ;) {
      const rows = await all(db, `SELECT c, text, rt FROM main.chat_log WHERE c > ? AND ${INDEXABLE} ORDER BY c LIMIT 5000`, [after]);
      if (!rows.length) break;
      for (const r of rows) await run(db, "INSERT INTO main.chat_log_fts (rowid, text, rt) VALUES (?, ?, ?)", [r.c, r.text, r.rt]);
      n += rows.length;
      after = rows[rows.length - 1].c;
    }
  }
  return { table: "chat_log_fts", reindexed: n };
}

/** wave2 integration review: prod's frog-name <-> login pairings out of the copy (SCRUB, above). -> [{table, scrubbed}] */
async function scrub(db) {
  const out = [];
  for (const s of SCRUB) {
    if (!(await tableSql(db, "main", s.table)) || !(await columns(db, "main", s.table)).includes(s.col)) continue;
    const r = await run(db, s.sql);
    out.push({ table: s.table, scrubbed: r.changes || 0 });
  }
  return out;
}

/** Keep staging's own rows of the per-environment tables in the copy. -> [{table, kept | cleared}] */
async function keep(db) {
  const out = [];
  await exec(db, "BEGIN IMMEDIATE");
  try {
    await dropChatlogTriggers(db);                                           // CL2: before chat_log's rows are replaced
    for (const t of KEEP) {
      const inCopy = await tableSql(db, "main", t);
      const inOld = await tableSql(db, "old", t);
      if (inCopy) await run(db, `DELETE FROM main.${q(t)}`);
      // Train 3 review: staging's chat archive lives in its CHATLOG_DB (no chat_log in its myapp.db) - prod's emptied chat_log must
      // not stay in the copy: at staging's next start counters / started_at would say "the archive is in myapp.db" and staging's
      // own chatlog.db would be ignored (a split). The copy mirrors staging's layout: the table goes (its indexes with it)
      if (!inOld && inCopy && t === "chat_log") { await run(db, "DROP TABLE main.chat_log"); out.push({ table: t, kept: 0, dropped: true }); continue; }
      if (!inOld) { out.push({ table: t, kept: 0 }); continue; }
      if (!inCopy) await exec(db, inOld);                                    // unqualified CREATE: lands in main
      else await addMissingColumns(db, t);                                   // staging a release ahead: its newer columns too
      const mine = await columns(db, "main", t);
      const theirs = new Set(await columns(db, "old", t));
      const cols = mine.filter((c) => theirs.has(c)).map(q).join(", ");
      if (!cols) { out.push({ table: t, kept: 0 }); continue; }
      const r = await run(db, `INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM old.${q(t)}`);
      out.push({ table: t, kept: r.changes || 0 });
    }
    const fts = await reindexChatlog(db);                                    // CL2: the index follows staging's own rows
    if (fts) out.push(fts);
    out.push(...(await scrub(db)));                                          // wave2: no frog-name <-> login pairing of prod's
    for (const t of EMPTY) {
      let inCopy = await tableSql(db, "main", t);
      const inOld = await tableSql(db, "old", t);
      if (!inCopy && inOld) { await exec(db, inOld); inCopy = inOld; }
      if (!inCopy) { out.push({ table: t, cleared: 0 }); continue; }
      const r = await run(db, `DELETE FROM main.${q(t)}`);
      let floor = Math.max(await seqOf(db, "main", t), await seqOf(db, "old", t));
      if (inOld) { const m = (await all(db, `SELECT MAX(rowid) AS m FROM old.${q(t)}`))[0]; floor = Math.max(floor, Number(m && m.m) || 0); }
      if (/AUTOINCREMENT/i.test(inCopy) && floor > 0) {
        const u = await run(db, "UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?", [floor, t]);
        if (!u.changes) await run(db, "INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)", [t, floor]);
      }
      out.push({ table: t, cleared: r.changes || 0, next_id_after: floor });
    }
    await exec(db, "COMMIT");
  } catch (e) {
    await exec(db, "ROLLBACK").catch(() => {});
    throw e;
  }
  return out;
}

/** The fallback: prod's rows of every per-environment table go (staging starts with defaults). */
async function clearOnly(db) {
  const out = [];
  await exec(db, "BEGIN IMMEDIATE");
  try {
    await dropChatlogTriggers(db);                                           // CL2: prod's chat_log goes without per-row index work
    for (const t of [...KEEP, ...EMPTY]) {
      if (!(await tableSql(db, "main", t))) continue;
      const r = await run(db, `DELETE FROM main.${q(t)}`);
      out.push({ table: t, cleared: r.changes || 0 });
    }
    if (await tableSql(db, "main", "chat_log_fts")) await run(db, "INSERT INTO main.chat_log_fts (chat_log_fts) VALUES ('delete-all')");
    out.push(...(await scrub(db)));                                          // wave2: the fallback scrubs them too
    await exec(db, "COMMIT");
  } catch (e) {
    await exec(db, "ROLLBACK").catch(() => {});
    throw e;
  }
  return out;
}

/** -> {mode: "kept" | "cleared", tables} (throws when the copy couldn't be made safe). */
async function main(oldFile, newFile, sqlite3 = require("sqlite3")) {
  const db = await open(sqlite3, newFile);
  try {
    await run(db, "PRAGMA busy_timeout = 10000");
    // CL2 fix-up: what the copy deletes (prod's rows of KEEP / EMPTY, prod's FTS entries) is overwritten, not left in free pages
    await all(db, "PRAGMA main.secure_delete = ON");
    let res;
    try {
      await run(db, "ATTACH DATABASE ? AS old", [oldFile]);
      res = { mode: "kept", tables: await keep(db) };
    } catch (e) {
      console.error("keeping staging's own tables failed (" + e.message + ") - clearing prod's instead");
      res = { mode: "cleared", tables: await clearOnly(db) };
    } finally {
      await run(db, "DETACH DATABASE old").catch(() => {});
    }
    await all(db, "PRAGMA main.journal_mode = DELETE");                     // the copy is moved next: no -wal beside it
    return res;
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

if (require.main === module) {
  const [oldFile, newFile] = process.argv.slice(2);
  if (!oldFile || !newFile) { console.error("usage: node keep-staging-tables.js <staging's current DB> <the fresh copy>"); process.exit(2); }
  main(path.resolve(oldFile), path.resolve(newFile)).then((r) => {
    const parts = r.tables.map((x) => x.table + " " + (x.dropped ? "dropped" : x.kept != null ? x.kept : x.reindexed != null ? "reindexed " + x.reindexed : x.scrubbed != null ? "scrubbed " + x.scrubbed : "-" + x.cleared));
    console.log((r.mode === "kept" ? "kept staging's own tables: " : "cleared prod's per-environment tables: ") + parts.join(", "));
  }, (e) => { console.error("the per-environment tables couldn't be made safe: " + e.message); process.exit(1); });
}

module.exports = { main, keep, clearOnly, scrub, KEEP, EMPTY, SCRUB, CHATLOG, CHATLOG_TRIGGERS, INDEXABLE, LIVE_FEED };
