// chatlogdb.js — CL2: the chat archive's read-only side connections (spec §3.4).
//
// The site has ONE shared write connection (dbUtils.js) - every module, the ledger, DMs and Pepe's syncs go through it. A slow
// archive read on it would hold all of them up, and interrupt() on it would kill unrelated statements. So the archive's reads
// get their own connections to the same file (sqlite3.OPEN_READONLY, sqlitecfg.tune with wal: false - the pattern of
// fix-orphan-transactions.js); WAL lets them read while the shared connection writes:
//   read     history pages, export pages, admin counts, the FTS drift check (queued by node-sqlite3, one at a time)
//   search   search statements, ONE AT A TIME with a queue of SEARCH_QUEUE behind it (beyond that: code "busy" -> 429), each
//            with a time budget: a timer calls interrupt() on THIS connection and the statement fails with code "too_broad"
//            ("Too broad - add a word.").
// With the archive in an attached chatlog.db (CHATLOG_DB, chatlog.js), each connection attaches it too - read-only, like the
// connection itself - so the archive's queries read the same names either way. Writes never go through here.
//   read(sql, params)                     -> rows
//   search(sql, params, {budgetMs})       -> rows | throws {code: "busy" | "too_broad"}
//   close()                               (shutdown; tests)
// Errors carry code "unavailable" when no connection can be opened (no database file yet - a test, a tool).
"use strict";
const fs = require("fs");
const path = require("path");

const SEARCH_QUEUE = 4;            // statements waiting behind the running one
const SEARCH_BUDGET_MS = 400;      // per search statement

const conns = { read: null, search: null };
let searchRunning = false;
const searchQueue = [];

const coded = (code, message) => Object.assign(new Error(message || code), { code });

function dbFile() { return path.resolve(process.env.CHATLOG_MAIN_DB || "myapp.db"); }

function open(which) {
  if (conns[which]) return conns[which];
  conns[which] = (async () => {
    const sqlite3 = require("sqlite3");
    const file = dbFile();
    if (!fs.existsSync(file)) throw coded("unavailable", "no database file");
    const db = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(coded("unavailable", e.message)) : resolve(d)));
    });
    await require("./sqlitecfg").tune(db, { label: "chatlog-" + which, wal: false });
    let archive = null;
    try { archive = require("./chatlog").archivePath(); } catch (e) { archive = null; }
    if (archive) {
      await new Promise((resolve, reject) => db.run("ATTACH DATABASE ? AS chatlog", [archive], (e) => (e ? reject(coded("unavailable", e.message)) : resolve())));
    }
    db.on("error", () => { conns[which] = null; });
    return db;
  })().catch((e) => { conns[which] = null; throw e.code ? e : coded("unavailable", e.message); });
  return conns[which];
}

const all = (db, sql, params) => new Promise((resolve, reject) => db.all(sql, params || [], (e, r) => (e ? reject(e) : resolve(r))));

/** A read on the read connection. -> rows */
async function read(sql, params = []) {
  const db = await open("read");
  return all(db, sql, params);
}

/** One search statement at a time, SEARCH_QUEUE waiting, each with its budget. -> rows | throws {code: busy | too_broad} */
function search(sql, params = [], { budgetMs = SEARCH_BUDGET_MS } = {}) {
  if (searchRunning && searchQueue.length >= SEARCH_QUEUE) return Promise.reject(coded("busy", "the search connection is busy"));
  return new Promise((resolve, reject) => {
    searchQueue.push({ sql, params, budgetMs, resolve, reject });
    pump();
  });
}
function pump() {
  if (searchRunning || !searchQueue.length) return;
  const job = searchQueue.shift();
  searchRunning = true;
  (async () => {
    const db = await open("search");
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { db.interrupt(); } catch (e) { /* closed */ } }, Math.max(1, job.budgetMs));
    try {
      return await all(db, job.sql, job.params);
    } catch (e) {
      if (timedOut || /interrupt/i.test(String(e && e.message))) throw coded("too_broad", "the statement ran out of time");
      throw e;
    } finally { clearTimeout(t); }
  })().then(job.resolve, job.reject).finally(() => { searchRunning = false; pump(); });
}

/** Close both connections (the shutdown hook; tests). */
async function close() {
  for (const k of Object.keys(conns)) {
    const p = conns[k];
    conns[k] = null;
    if (!p) continue;
    try { const db = await p; await new Promise((r) => db.close(() => r())); } catch (e) { /* never opened */ }
  }
}
try { require("./shutdown").onExit((done) => { close().then(done, done); }); } catch (e) { /* no graceful stop (tools) */ }

module.exports = { read, search, close, SEARCH_QUEUE, SEARCH_BUDGET_MS, _state: () => ({ running: searchRunning, queued: searchQueue.length }) };
