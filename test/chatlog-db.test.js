// CL2 chatlogdb.js (the archive's read-only side connections) + chatlog.js index health. The read connection sees what the shared
// connection committed and can't write; a search statement past its budget is interrupted on ITS connection ("too_broad"), one
// runs at a time with SEARCH_QUEUE waiting and the next is refused ("busy"); the incremental drift check finds a hole in the
// FTS index and the repair fills it (and removes a stale entry), an entry whose text is gone makes the repair re-fill the index;
// never FTS5 'rebuild' (a removed line would come back).
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-db.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-db-test-")));
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CL = require(path.join(repo, "chatlog"));
const RO = require(path.join(repo, "chatlogdb"));

const SLOW = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 500000000) SELECT COUNT(*) AS n FROM r";
const ins = (c, text, k = "msg") => runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, 1, ?, ?, 'bob', ?, 'r1', 'm', '{}')", [c, c, k, text]);
const ftsIds = async () => (await getQuery("SELECT id FROM chat_log_fts_docsize ORDER BY id")).map((r) => r.id);
const match = async (w) => (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ? ORDER BY rowid", ['"' + w + '"'])).map((r) => r.rowid);

// (a promise every test awaits - Node 16's runner doesn't wait for a top-level test.before)
const setup = (async () => {
  await CL.init();
  await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created) VALUES (1, 'Db.Room', 1)");
})();
test.after(() => RO.close());

test("the read connection sees committed rows and can't write", async () => {
  await setup;
  await ins(1, "first line");
  assert.deepEqual((await RO.read("SELECT c, text FROM chat_log ORDER BY c")).map((r) => r.text), ["first line"]);
  await assert.rejects(RO.read("INSERT INTO chat_log (c, rk, ts, k, rt, aud, d) VALUES (2, 1, 1, 'msg', 'r1', 'm', '{}')"), /readonly|read-only/i);
});

test("search: a statement past its budget is interrupted (too_broad) without touching the shared connection", async () => {
  await setup;
  const t0 = Date.now();
  await assert.rejects(RO.search(SLOW, [], { budgetMs: 60 }), (e) => e.code === "too_broad");
  assert.ok(Date.now() - t0 < 5000, "stopped early");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log"))[0].n, 1, "the shared connection is fine");
  assert.deepEqual(await RO.search("SELECT 1 AS one", []), [{ one: 1 }], "the connection is usable again");
});

test("search: one statement at a time, SEARCH_QUEUE waiting, the next is busy", async () => {
  await setup;
  const running = RO.search(SLOW, [], { budgetMs: 300 }).catch((e) => e.code);
  const queued = [];
  for (let i = 0; i < RO.SEARCH_QUEUE; i++) queued.push(RO.search("SELECT ? AS i", [i]));
  await assert.rejects(RO.search("SELECT 1", []), (e) => e.code === "busy");
  assert.equal(await running, "too_broad");
  assert.deepEqual((await Promise.all(queued)).map((r) => r[0].i), [0, 1, 2, 3]);
});

test("index health: the drift check finds a hole and a stale entry; the repair fixes both; the high-water mark moves", async () => {
  await setup;
  await ins(2, "second line");
  await ins(3, "third line");
  assert.deepEqual(await ftsIds(), [1, 2, 3]);
  // a hole (a row written while the trigger was missing) and a stale entry (a removal written while it was missing)
  await runQuery("DROP TRIGGER chat_log_ai");
  await runQuery("DROP TRIGGER chat_log_au");
  await ins(4, "fourth line hole");
  await runQuery("UPDATE chat_log SET rm_at = 5, rm_by = 'self' WHERE c = 2");
  assert.deepEqual(await ftsIds(), [1, 2, 3], "the index missed both");
  const d = await CL.driftCheck({ full: true });
  assert.equal(d.ok, false);
  assert.equal(d.rows, 3);                       // 1, 3, 4 are indexable now
  assert.equal(d.indexed, 3);                    // 1, 2, 3 are in the index: same count, different rows
  // equal counts can hide a swap: the repair compares the rows themselves
  await new Promise((r) => setTimeout(r, 50));
  while (CL._fts.repairing) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await ftsIds(), [1, 3, 4]);
  assert.deepEqual(await match("hole"), [4]);
  assert.deepEqual(await match("second"), [], "the removed line left the index");
  assert.ok(CL._fts.lastRepair && CL._fts.lastRepair.added === 1 && CL._fts.lastRepair.removed === 1);
  await CL.init();                               // (the triggers come back at the next start)
});

test("index health: an entry whose text is gone can't be removed surgically -> the whole index is re-filled (never 'rebuild')", async () => {
  await setup;
  // put the triggers back the way init() makes them, then purge a line while they're missing
  await runQuery(CL.TRIGGERS[0][1]); await runQuery(CL.TRIGGERS[2][1]);
  await runQuery("DROP TRIGGER chat_log_au");
  await runQuery("UPDATE chat_log SET text = NULL, purged = 1 WHERE c = 3");
  await runQuery(CL.TRIGGERS[2][1]);
  const r = await CL.repair(0, 10);
  assert.equal(r.full, true);
  assert.deepEqual(await ftsIds(), [1, 4]);
  assert.deepEqual(await match("third"), []);
  assert.deepEqual(await match("first"), [1]);
  const d = await CL.driftCheck({ full: true });
  assert.equal(d.ok, true);
  assert.equal(CL._fts.hw, 4);
  assert.equal(CL.ftsPartial(), false);
});

test("CL2 fix-up: lines written while a repair runs never look like stale entries (each batch reads inside its own transaction - no needless re-fill)", async () => {
  await setup;
  await CL.init();                                     // the triggers as init() makes them
  await runQuery("DROP TRIGGER chat_log_ai");
  await ins(20, "a gapword to repair");
  await CL.init();
  const writes = [];
  const rep = CL.repair(0, 100000);
  for (let c = 21; c <= 60; c++) writes.push(ins(c, "written during the repair " + c));
  const r = await rep;
  await Promise.all(writes);
  assert.equal(r.full, false, "never re-filled for a line committed between two reads");
  const d = await CL.driftCheck({ full: true });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(await match("gapword"), [20]);
});

test("CL2 fix-up: the drift check counts in ONE statement (one read snapshot)", () => {
  const src = fs.readFileSync(path.join(repo, "chatlog.js"), "utf8");
  const body = src.slice(src.indexOf("async function driftCheck"), src.indexOf("const yieldNow"));
  assert.equal((body.match(/roQuery\(/g) || []).length, 1, "a single read");
});
