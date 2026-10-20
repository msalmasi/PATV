// CL2 decision 25: CHATLOG_DB set -> the archive's big tables (chat_log + its FTS index, indexes and triggers) live in an ATTACHED
// chatlog.db; everything else (rooms, hidden set, settings, switches) stays in myapp.db. The archive's queries read the same
// names either way, the read connections attach it read-only, and an archive that already started inside myapp.db is never
// split (the switch is refused at start and the archive stays where it is).
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-attach.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-test-"));
process.chdir(tmp);
process.env.CHATLOG_DB = path.join(tmp, "chatlog.db");
process.env.SECRET_KEY = "test-secret";
const { getQuery, runQuery } = require(path.join(repo, "dbUtils"));
const CL = require(path.join(repo, "chatlog"));
const RO = require(path.join(repo, "chatlogdb"));
const DAY = 86400000;

test.after(() => RO.close());

test("the archive tables live in the attached chatlog.db; the rest in myapp.db; writes, the index and the read connection work", async () => {
  await CL.init();
  assert.ok(fs.existsSync(path.join(tmp, "chatlog.db")));
  const where = async (schema, name) => (await getQuery(`SELECT name FROM ${schema}.sqlite_master WHERE name = ?`, [name])).length > 0;
  for (const n of ["chat_log", "chat_log_fts", "chat_log_room", "chat_log_eid", "chat_log_ai"]) {
    assert.ok(await where("chatlog", n), n + " in chatlog.db");
    assert.ok(!(await where("main", n)), n + " not in myapp.db");
  }
  for (const n of ["chatlog_rooms", "chatlog_hidden", "pad_chat_cfg", "chatlog_meta"]) assert.ok(await where("main", n), n + " in myapp.db");
  assert.equal(CL.archivePath(), path.resolve(tmp, "chatlog.db"));
  // the write path, the index and the reads use the same names
  let t = Date.now();
  CL._setClock(() => t);
  await CL.setSwitch("notice", true);
  t += 8 * DAY;
  await CL.setSwitch("archive", true);
  const P = require(path.join(repo, "premium"));
  await P.init();
  const r = await CL.archiveBatch([{ roomId: "Att.Room", it: { c: 41, k: "msg", ts: 5, text: "attached words", u: { login: "Zed", display: "Zed" } }, eid: "e41" }]);
  assert.deepEqual(r, { written: 1 });
  assert.deepEqual((await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH '\"attached\"'")).map((x) => x.rowid), [41]);
  assert.deepEqual((await RO.read("SELECT c, who FROM chat_log")).map((x) => [x.c, x.who]), [[41, "zed"]], "the read connection attaches it too");
  assert.equal((await RO.read(`SELECT "rows" AS n FROM chatlog_rooms WHERE room_id = 'Att.Room'`))[0].n, 1, "and joins myapp.db's tables");
  assert.equal((await CL.driftCheck({ full: true })).ok, true);
  assert.equal((await CL.bootCursor()), 41);
  const lines = await CL.exportLines("someone", "zed");
  assert.deepEqual(lines.map((l) => l.text), ["attached words"]);
  await runQuery("SELECT 1");
});

/** A child process in `dir` (its own myapp.db): CL.init(), then `body` (an async (CL, getQuery, runQuery) => result source). */
function childRun(dir, env, body = null) {
  const { execFileSync } = require("child_process");
  const file = path.join(dir, "child-" + Math.random().toString(36).slice(2) + ".js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(dir)});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const { getQuery, runQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
CL.init().then(async () => {
  const main = (await getQuery("SELECT 1 FROM main.sqlite_master WHERE name = 'chat_log'")).length;
  const extra = ${body || "null"};
  const more = extra ? await extra(CL, getQuery, runQuery) : null;
  console.log("RESULT " + JSON.stringify(Object.assign({ main, attached: CL.archivePath() }, more ? { more } : {})));
  process.exit(0);
}, (e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
}

test("an archive that started in myapp.db is never split: CHATLOG_DB set later is refused (logged) and the archive stays put", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-split-"));
  // first life: the archive in myapp.db, and it wrote a line there (Train 3 review: an archive that never held one moves - below)
  assert.deepEqual(childRun(dir, { CHATLOG_DB: "" }, `async (CL, getQuery, runQuery) => {
    await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created, \\"rows\\") VALUES (1, 'A.Room', 1, 1)");
    await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (7, 1, 1, 'msg', 'zed', 'kept', 'r1', 'm', '{}')");
    return 1;
  }`), { main: 1, attached: null, more: 1 }, "first life: in myapp.db");
  assert.deepEqual(childRun(dir, { CHATLOG_DB: path.join(dir, "chatlog.db") }, `async (CL, getQuery) => (await getQuery("SELECT c FROM main.chat_log")).map((x) => x.c)`),
                   { main: 1, attached: null, more: [7] }, "CHATLOG_DB set later: not split");
  assert.ok(!fs.existsSync(path.join(dir, "chatlog.db")));
  // also when only the counters say so (a purge emptied chat_log), or the archive was switched on once (cfg.started_at)
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-split2-"));
  childRun(dir2, { CHATLOG_DB: "" }, `async (CL, getQuery, runQuery) => {
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('cfg', ?)", [JSON.stringify({ notice: true, notice_at: 1, archive: false, started_at: 5 })]);
    return 1;
  }`);
  assert.deepEqual(childRun(dir2, { CHATLOG_DB: path.join(dir2, "chatlog.db") }), { main: 1, attached: null }, "switched on once: not moved");
  assert.ok(!fs.existsSync(path.join(dir2, "chatlog.db")));
});

test("Train 3 review: the EMPTY archive tables a boot without CHATLOG_DB made in myapp.db don't decide decision 25 - CHATLOG_DB set later moves them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-empty-"));
  // the deploy (CHATLOG_DB not decided yet): chat_log, its FTS index and triggers are created in myapp.db, nothing is written
  assert.deepEqual(childRun(dir, { CHATLOG_DB: "" }, `async (CL, getQuery) => (await getQuery("SELECT name FROM main.sqlite_master WHERE name IN ('chat_log_fts', 'chat_log_ai') ORDER BY name")).map((x) => x.name)`),
                   { main: 1, attached: null, more: ["chat_log_ai", "chat_log_fts"] });
  // the owner decides: CHATLOG_DB set -> the empty tables leave myapp.db and the archive lives in the attached file
  const file = path.join(dir, "chatlog.db");
  const r = childRun(dir, { CHATLOG_DB: file }, `async (CL, getQuery, runQuery) => {
    const left = (await getQuery("SELECT name FROM main.sqlite_master WHERE name GLOB 'chat_log*'")).map((x) => x.name);
    const there = (await getQuery("SELECT name FROM chatlog.sqlite_master WHERE name IN ('chat_log', 'chat_log_fts', 'chat_log_ai') ORDER BY name")).map((x) => x.name);
    await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created) VALUES (1, 'A.Room', 1)");
    await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (9, 1, 1, 'msg', 'zed', 'moved words', 'r1', 'm', '{}')");
    const fts = (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH '\\"moved\\"'")).map((x) => x.rowid);
    return { left, there, fts, err: CL.archiveError() };
  }`);
  assert.deepEqual(r, { main: 0, attached: path.resolve(file), more: { left: [], there: ["chat_log", "chat_log_ai", "chat_log_fts"], fts: [9], err: null } });
  assert.ok(fs.existsSync(file));
});

/** A child process in `dir` WITHOUT CL.init() (what tools/remove-stray-pad.js / scrub-consent-feed.js do): CL.attach(), then body. */
function toolRun(dir, env, body) {
  const { execFileSync } = require("child_process");
  const file = path.join(dir, "tool-" + Math.random().toString(36).slice(2) + ".js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(dir)});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const { getQuery, runQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
(async () => {
  const attached = await CL.attach();
  const main = (await getQuery("SELECT name FROM main.sqlite_master WHERE name GLOB 'chat_log*' ORDER BY name")).map((x) => x.name);
  const more = await (${body || "async () => null"})(CL, getQuery, runQuery);
  console.log("RESULT " + JSON.stringify({ attached, main, more }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
}

test("Train 3 review fix-up: a CHATLOG_DB that can't be opened leaves myapp.db's empty archive tables alone - the live chat and the hidden set go on, the admin page says why", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-cantopen-"));
  const all = `async (CL, getQuery) => (await getQuery("SELECT name FROM main.sqlite_master WHERE name GLOB 'chat_log*' ORDER BY name")).map((x) => x.name)`;
  const before = childRun(dir, { CHATLOG_DB: "" }, all).more;
  assert.ok(before.length >= 10, "the empty archive tables a boot without CHATLOG_DB made: " + before.join(","));
  const bad = path.join(dir, "no-such-dir", "chatlog.db");
  const r = childRun(dir, { CHATLOG_DB: bad }, `async (CL, getQuery) => ({ left: await (${all})(CL, getQuery), err: CL.archiveError(), ready: CL.hiddenReady(),
    again: await CL.init().then(() => "ok", (e) => String(e.message)) })`);
  assert.equal(r.attached, null);
  assert.deepEqual(r.more.left, before, "nothing dropped from myapp.db");
  assert.match(String(r.more.err), /can't be opened \(SQLITE_CANTOPEN\)/, "archiveError says why (the admin page)");
  assert.equal(r.more.ready, true, "the hidden set loaded");
  assert.equal(r.more.again, "ok", "init() resolves (code archive_db) - bridge.js doesn't close every pad's live chat");
  assert.ok(!fs.existsSync(path.join(dir, "no-such-dir")));
  // the path fixed: the move happens then
  const good = path.join(dir, "chatlog.db");
  assert.deepEqual(childRun(dir, { CHATLOG_DB: good }, "async (CL) => CL.archiveError()"), { main: 0, attached: path.resolve(good) }, "(no archiveError)");
});

test("Train 3 review fix-up: a tool's bare attach() never moves (nor drops) anything - even with init()'s switches unloaded and the archive switched on once", () => {
  // (a) the archive was switched on once (cfg.started_at) and holds no line: the site's own boot keeps it; a tool too
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-tool-"));
  childRun(dir, { CHATLOG_DB: "" }, `async (CL, getQuery, runQuery) => {
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('cfg', ?)", [JSON.stringify({ notice: true, notice_at: 1, archive: true, archive_at: 2, started_at: 2 })]);
    return 1;
  }`);
  const file = path.join(dir, "chatlog.db");
  const t = toolRun(dir, { CHATLOG_DB: file });
  assert.equal(t.attached, false, "not attached");
  assert.ok(t.main.includes("chat_log") && t.main.includes("chat_log_fts"), "myapp.db's archive tables stay: " + t.main.join(","));
  assert.ok(!fs.existsSync(file), "no file made");
  assert.deepEqual(childRun(dir, { CHATLOG_DB: file }), { main: 1, attached: null }, "the site's boot keeps it too (started_at)");
  // (b) a truly empty archive (never switched on): a tool still leaves it where the running site has it - only init() moves
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-tool2-"));
  childRun(dir2, { CHATLOG_DB: "" });
  const file2 = path.join(dir2, "chatlog.db");
  const t2 = toolRun(dir2, { CHATLOG_DB: file2 }, `async (CL, getQuery) => (await getQuery("SELECT COUNT(*) AS n FROM chat_log"))[0].n`);
  assert.equal(t2.attached, false);
  assert.ok(t2.main.includes("chat_log"), "a dry run writes nothing - no DROP either");
  assert.equal(t2.more, 0, "the tool reads myapp.db's (empty) chat_log - where the running site has it");
  assert.ok(!fs.existsSync(file2));
  // ... and the site's next start moves it
  assert.deepEqual(childRun(dir2, { CHATLOG_DB: file2 }), { main: 0, attached: path.resolve(file2) });
  // (c) a cfg row that can't be read: fails closed (kept)
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-tool3-"));
  childRun(dir3, { CHATLOG_DB: "" }, `async (CL, getQuery, runQuery) => { await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('cfg', '{not json')"); return 1; }`);
  assert.deepEqual(childRun(dir3, { CHATLOG_DB: path.join(dir3, "chatlog.db") }), { main: 1, attached: null }, "an unreadable cfg: kept");
});

test("CL2 fix-up: a wrong or moved CHATLOG_DB never starts a new, empty archive - the archive refuses to write and says why; the rest works", () => {
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-attach-wrong-"));
  const run = (env, body) => {
    const file = path.join(dir, "child-" + Math.random().toString(36).slice(2) + ".js");
    fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(dir)});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const { getQuery, runQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
CL.init().then(async () => { const out = await (${body})(CL, getQuery, runQuery); console.log("RESULT " + JSON.stringify(out)); process.exit(0); },
               (e) => { console.error(e); process.exit(1); });
`);
    const out = execFileSync(process.execPath, [file], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
  };
  const good = path.join(dir, "chatlog.db"), moved = path.join(dir, "moved.db"), empty = path.join(dir, "empty.db");
  // first life: the archive in chatlog.db, one room with lines counted in myapp.db
  assert.deepEqual(run({ CHATLOG_DB: good }, `async (CL, getQuery, runQuery) => {
    await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created, \\"rows\\") VALUES (1, 'A.Room', 1, 1)");
    await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (7, 1, 1, 'msg', 'zed', 'kept', 'r1', 'm', '{}')");
    return CL.archiveError();
  }`), null);
  // a path that doesn't exist: refused, and no file is created
  const r = run({ CHATLOG_DB: moved }, `async (CL, getQuery) => ({ err: CL.archiveError(), attached: CL.archivePath(), ready: CL.hiddenReady(),
    write: await CL.archiveBatch([{ roomId: "A.Room", it: { c: 8, k: "msg", ts: 2, text: "x", u: { login: "zed" } } }]),
    inMain: (await getQuery("SELECT COUNT(*) AS n FROM main.sqlite_master WHERE name = 'chat_log'"))[0].n })`);
  assert.match(r.err, /doesn't exist, but the archive has counted 1 line/);
  assert.equal(r.attached, null);
  assert.equal(r.ready, true, "the hidden set loads all the same");
  assert.equal(r.inMain, 0, "no stray archive in myapp.db either");
  assert.ok(!fs.existsSync(moved), "no new, empty archive file");
  // an existing file without the archive's lines (an empty database): refused the same way
  fs.writeFileSync(empty, "");
  const e = run({ CHATLOG_DB: empty }, "async (CL) => CL.archiveError()");
  assert.match(e, /holds no archived line/);
  // back on the right path: everything is there
  assert.deepEqual(run({ CHATLOG_DB: good }, `async (CL, getQuery) => [CL.archiveError(), (await getQuery("SELECT c FROM chat_log")).map((x) => x.c)]`), [null, [7]]);
});
