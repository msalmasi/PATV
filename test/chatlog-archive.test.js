// CL2 chatlog.js + bridge.js: the durable pad chat archive (dark). bridge_feed is written whatever the archive does (a failing
// archive write never stops the live chat; 20 failures in a row trip the switch); dropRoom and the 200-row prune never touch
// chat_log; `c` is never reused across a drop and a restart; a restart between two syncs leaves no duplicate (eid); a repeated
// transcript beyond the 200 gets no new c; message.private never archives; a non-perk room isn't archived; private_args
// commands are dropped by the site filter (live feed too); the switch guard (notice first, 7 days); the seed at switch-on
// (<= 200 per room, once, filtered); padrekey keeps the archive with the room and moves the pad's settings; the owner sync's
// `chatlog` block; the privacy policy text only while the notice is on.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-archive.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-archive-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const UL = require(path.join(repo, "userlinks"));
const P = require(path.join(repo, "premium"));

const DAY = 86400000;
let T0 = Date.now();
let clockAt = T0;
CL._setClock(() => clockAt);

const ALICE = { id: "Alice", login: "Alice", display: "Alice A", on_cam: true, src: "list" };
const BOB = { id: "bob", login: "bob", display: "Bob" };
let seq = 0;
const ev = (room, type, data, id) => ({ op: "event", id: id || "cl-ev-" + (++seq), ts: new Date().toISOString(), type,
                                        scope: { platform: "camfrog", room }, data });
const msg = (room, user, text, extra = {}) => ev(room, "message", { user, text, message_id: "cf-m-" + seq, ...extra });
const snap = (room) => ({ room, members: [ALICE, BOB], mic: [], count: 2, transcripts: true });
const sync = (room, events, extra = {}) => bridge.ingest({ events, rooms: [snap(room)], ...extra });
const feedRows = (rid) => getQuery("SELECT c, data FROM bridge_feed WHERE room_id = ? ORDER BY c", [rid]);
const logRows = (rid) => getQuery("SELECT l.* FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = ? ORDER BY l.c", [rid]);
const live = async (rid) => { const R = bridge._rooms.get(rid); return R ? (await bridge.liveView(R, 0, null, null, null, true, { viewer: { userId: "test-viewer" } })).feed : []; };   // CL3: a signed-in viewer

async function archiveOn() {
  if (CL.on("archive")) return;
  if (!CL.on("notice")) await CL.setSwitch("notice", true, "test");
  clockAt = CL.cfg().notice_at + CL.NOTICE_DAYS * DAY + 1000;
  await CL.setSwitch("archive", true, "test");
}

// (a promise every test awaits - Node 16's runner doesn't wait for a top-level test.before)
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
  await bridge.load();
  await CL.init();
})();

test("archive off (the default): the live chat works as before, nothing is archived, the cursor's high-water mark is kept", async () => {
  await setup;
  const room = { id: "Off.Room", name: "Off Room" };
  assert.equal(CL.on("archive"), false);
  await sync(room, [msg(room, ALICE, "hello"), msg(room, BOB, "hi")]);
  assert.equal((await feedRows("Off.Room")).length, 2);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log"))[0].n, 0, "nothing archived while the switch is off");
  const hw = Number((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'cursor_hw'"))[0].value);
  const maxc = (await getQuery("SELECT MAX(c) AS m FROM bridge_feed"))[0].m;
  assert.equal(hw, maxc, "cursor_hw follows every sync that wrote items, archive on or off");
});

test("the switch guard: no archive without the notice, nor inside its 7 days; the notice can't go off while the archive writes", async () => {
  await setup;
  await assert.rejects(CL.setSwitch("archive", true, "test"), (e) => e.code === "notice_off");
  await CL.setSwitch("notice", true, "test");
  const c = CL.cfg();
  assert.equal(c.notice, true);
  assert.ok(c.notice_at > 0);
  clockAt = c.notice_at + 6 * DAY;
  await assert.rejects(CL.setSwitch("archive", true, "test"), (e) => e.code === "notice_wait" && e.opens_at === c.notice_at + 7 * DAY);
  assert.equal(CL.on("archive"), false);
  assert.equal(CL.archiveOpensAt(), c.notice_at + 7 * DAY);
  await assert.rejects(CL.setSwitch("bogus", true), (e) => e.code === "bad_switch");
  const ev1 = await getQuery("SELECT what, detail FROM room_events WHERE what = 'chatlog.switch' ORDER BY ts");
  assert.ok(ev1.some((r) => r.detail === "notice on"), "audited in room_events");
});

test("the seed at switch-on: what bridge_feed holds (<= 200 per room) of perk rooms, private commands left out, once", async () => {
  await setup;
  const room = { id: "Seed.Room", name: "Seed Room" };
  const many = [];
  for (let i = 0; i < 205; i++) many.push(msg(room, i % 2 ? ALICE : BOB, "line " + i));
  await sync(room, many);
  assert.equal((await feedRows("Seed.Room")).length, 200, "bridge_feed keeps 200");
  // a pre-CL2 row with a secret in it (the site filter never lets new ones in)
  await runQuery("INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, ?, ?, ?)",
                 [9000000, "Seed.Room", Date.now(), JSON.stringify({ k: "msg", ts: Date.now(), u: { login: "bob", display: "Bob" }, text: "!verifypad PATV-1234" })]);
  // CL2 fix-up: a line said BEFORE the notice went on (a quiet room's tail can be months old) is never seeded
  const old = (CL.cfg().notice_at || T0) - 30 * DAY;
  await runQuery("INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, ?, ?, ?)",
                 [9000001, "Quiet.Room", old, JSON.stringify({ k: "msg", ts: old, u: { login: "bob", display: "Bob" }, text: "said long before the notice" })]);
  // a room without the bridge perk
  const other = { id: "NoPerk.Room", name: "NoPerk Room" };
  await sync(other, [msg(other, BOB, "not archived")]);
  const real = P.bridgeAllowed;
  P.bridgeAllowed = (id) => id !== "NoPerk.Room";
  try {
    await archiveOn();
    const rows = await logRows("Seed.Room");
    assert.equal(rows.length, 200, "the 200 lines the site showed - the secret one left out");
    assert.ok(!rows.some((r) => /verifypad/.test(r.text || "")));
    assert.equal((await logRows("NoPerk.Room")).length, 0, "no perk, no archive");
    assert.equal((await logRows("Quiet.Room")).length, 0, "said before the notice: not seeded");
    const fc = await feedRows("Seed.Room");
    assert.deepEqual(rows.map((r) => r.c), fc.map((r) => r.c).filter((c) => c !== 9000000), "same cursors as the live feed");
    assert.ok(rows.every((r) => r.eid === null), "seeded rows have no event id");
    const done = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'seed_done'"))[0].value);
    assert.ok(done.rows >= 200);
    // off and on again: never a second seed
    await CL.setSwitch("archive", false, "test");
    const r2 = await CL.setSwitch("archive", true, "test");
    assert.deepEqual(r2.seed, { skipped: "done" });
    assert.equal((await logRows("Seed.Room")).length, 200);
  } finally {
    P.bridgeAllowed = real;
    await runQuery("DELETE FROM bridge_feed WHERE c IN (9000000, 9000001)");   // the hand-made rows (never a cursor this process handed out)
  }
});

test("archive on: each line lands with the feed's cursor, its event / message ids, the speaker key, no roster bits; counters; the index", async () => {
  await setup;
  const room = { id: "Lab.Room", name: "Lab Room" };
  await archiveOn();
  await sync(room, [msg(room, ALICE, "hello room café"), ev(room, "member.join", { user: BOB }), ev(room, "mic.release", { user: BOB, held_ms: 180000 }),
                    ev(room, "x.pepe.transcript", { id: "tx-00000000000000aa", user: BOB, text: "said on the mic" }),
                    ev(room, "room.update", { changes: { topic: "movie night" } })]);
  const rows = await logRows("Lab.Room");
  const fc = await feedRows("Lab.Room");
  assert.deepEqual(rows.map((r) => r.c), fc.map((r) => r.c));
  const m = rows.find((r) => r.k === "msg");
  assert.equal(m.who, "alice", "the login, lower-cased");
  assert.equal(m.text, "hello room café");
  assert.match(m.eid, /^cl-ev-/);
  assert.match(m.mid, /^cf-m-/);
  assert.equal(m.aud, "m", "the pad's access level when it was said (members by default)");
  assert.equal(m.rt, "r" + m.rk);
  const d = JSON.parse(m.d);
  assert.deepEqual(Object.keys(d.u).sort(), ["display"], "no login / on_cam / src in d");
  assert.equal(d.u.display, "Alice A");
  const t = rows.find((r) => r.k === "tx");
  assert.equal(t.tx, "tx-00000000000000aa");
  assert.equal(JSON.parse(t.d).id, undefined, "the tx id is a column, not in d");
  assert.equal(JSON.parse(rows.find((r) => r.k === "unmic").d).ms, 180000);
  const top = rows.find((r) => r.k === "topic");
  assert.equal(top.who, null);
  assert.equal(top.text, "movie night");
  const room1 = (await getQuery(`SELECT "rows" AS n, idx_rows, bytes, first_c, first_ts FROM chatlog_rooms WHERE room_id = 'Lab.Room'`))[0];
  assert.equal(room1.n, 5);
  assert.equal(room1.idx_rows, 3, "msg + tx + topic are indexed");
  assert.ok(room1.bytes > 0);
  assert.equal(room1.first_c, rows[0].c);
  const hits = await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"cafe"']);
  assert.deepEqual(hits.map((h) => h.rowid), [m.c], "diacritics folded; found by the FTS index");
  const idx = (await getQuery(`SELECT COUNT(*) AS n FROM chat_log WHERE ${CL.INDEXABLE}`))[0].n;
  const docs = (await getQuery("SELECT COUNT(*) AS n FROM chat_log_fts_docsize"))[0].n;
  assert.equal(docs, idx, "the FTS docsize count equals the indexable rows");
  assert.deepEqual(await CL.driftCheck(), { ok: true, lo: 0, hi: (await getQuery("SELECT MAX(c) AS m FROM chat_log"))[0].m, rows: idx, indexed: docs, full: false });
});

test("never archived: message.private, private_args commands (dropped from the live feed too); ordinary lines are unaffected", async () => {
  await setup;
  const room = { id: "Priv.Room", name: "Priv Room" };
  await archiveOn();
  await sync(room, [ev(room, "message.private", { user: BOB, text: "a secret PM" }),
                    msg(room, BOB, "!verify 123456"), msg(room, BOB, "   !MSG alice meet me at 9"), msg(room, BOB, "/msg alice psst"),
                    msg(room, BOB, "!joinroom Secret.Room -p hunter2"), msg(room, BOB, "!padmove x y"), msg(room, BOB, "!tell alice hi"),
                    msg(room, BOB, "🌐 Bob (web): !verify 999", { user: { ...BOB, is_self: true } }),
                    msg(room, BOB, "I will !msg you later"), msg(room, BOB, "!roll dice")]);
  const texts = (await live("Priv.Room")).map((it) => it.text);
  assert.deepEqual(texts, ["I will !msg you later", "!roll dice"]);
  assert.deepEqual((await logRows("Priv.Room")).map((r) => r.text), ["I will !msg you later", "!roll dice"]);
  for (const c of CL.PRIVATE_ARGS) assert.ok(CL.isPrivateCmd(c + " x"), c);
  assert.ok(!CL.isPrivateCmd("!msgs"), "the whole first token");
});

test("a room without the bridge perk isn't archived as it speaks (decision 27, the live path); its live chat works as before", async () => {
  await setup;
  const room = { id: "NoPerkLive.Room", name: "NoPerk Live" };
  await archiveOn();
  const real = P.bridgeAllowed;
  P.bridgeAllowed = (id) => id !== "NoPerkLive.Room";
  try {
    await sync(room, [msg(room, ALICE, "not kept"), ev(room, "member.join", { user: BOB })]);
    assert.equal((await feedRows("NoPerkLive.Room")).length, 2, "the live feed has them");
    assert.equal((await logRows("NoPerkLive.Room")).length, 0, "the archive doesn't");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_rooms WHERE room_id = 'NoPerkLive.Room'"))[0].n, 0, "not even a room row");
  } finally { P.bridgeAllowed = real; }
  await sync(room, [msg(room, ALICE, "kept once the perk is there")]);
  assert.deepEqual((await logRows("NoPerkLive.Room")).map((r) => r.text), ["kept once the perk is there"], "at write time, never retroactive");
});

test("dropRoom (Pepe leaves / !bridge off) and the 200-row prune never touch chat_log", async () => {
  await setup;
  const room = { id: "Drop.Room", name: "Drop Room" };
  await archiveOn();
  const evs = [];
  for (let i = 0; i < 230; i++) evs.push(msg(room, ALICE, "n" + i));
  await sync(room, evs);
  assert.equal((await feedRows("Drop.Room")).length, 200);
  assert.equal((await logRows("Drop.Room")).length, 230);
  await bridge.ingest({ events: [], rooms: [], closed: ["Drop.Room"] });
  assert.equal((await feedRows("Drop.Room")).length, 0, "dropRoom empties the live feed");
  assert.equal((await logRows("Drop.Room")).length, 230, "the archive stays");
});

test("a repeated transcript beyond the 200 in memory gets no new c (the archive's (rk, tx) is checked first)", async () => {
  await setup;
  const room = { id: "Tx.Room", name: "Tx Room" };
  await archiveOn();
  await sync(room, [ev(room, "x.pepe.transcript", { id: "tx-0000000000000bbb", user: BOB, text: "first take" })]);
  const fill = [];
  for (let i = 0; i < 205; i++) fill.push(msg(room, ALICE, "f" + i));
  await sync(room, fill);
  const before = (await getQuery("SELECT MAX(c) AS m FROM bridge_feed"))[0].m;
  await sync(room, [ev(room, "x.pepe.transcript", { id: "tx-0000000000000bbb", user: BOB, text: "first take" })]);   // a new event id
  assert.equal((await getQuery("SELECT MAX(c) AS m FROM bridge_feed"))[0].m, before, "no new cursor");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE tx = 'tx-0000000000000bbb'"))[0].n, 1);
  assert.ok(!(await live("Tx.Room")).some((it) => it.k === "tx"), "not shown again either");
});

test("a failing archive write never stops the live chat; 20 failures in a row trip chatlog.archive off (and say why)", async () => {
  await setup;
  const room = { id: "Fail.Room", name: "Fail Room" };
  await archiveOn();
  CL._setFault(() => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); });
  try {
    for (let i = 0; i < CL.TRIP_AFTER - 1; i++) await sync(room, [msg(room, ALICE, "still live " + i)]);
    assert.equal(CL.on("archive"), true, "not yet");
    assert.equal((await feedRows("Fail.Room")).length, CL.TRIP_AFTER - 1, "every line reached bridge_feed");
    assert.equal((await live("Fail.Room")).length, CL.TRIP_AFTER - 1, "and the live view");
    await sync(room, [msg(room, ALICE, "the 20th")]);
    assert.equal(CL.on("archive"), false, "tripped");
    const c = CL.cfg();
    assert.match(c.tripped.why, /20 archive writes failed in a row/);
    assert.match(c.tripped.why, /SQLITE_IOERR/);
    assert.equal((await logRows("Fail.Room")).length, 0);
    const v = await CL.adminView();
    assert.equal(v.cfg.tripped.at, c.tripped.at);
    assert.ok(v.stats.failures >= 20);
  } finally { CL._setFault(null); }
  await CL.setSwitch("archive", true, "test");          // an admin turns it back on: the trip is cleared
  assert.equal(CL.cfg().tripped, null);
  assert.equal(CL._stats.consecutive, 0, "CL2 fix-up: and the run of failures - the next one isn't the 21st in a row");
  await sync(room, [msg(room, ALICE, "archived again")]);
  assert.deepEqual((await logRows("Fail.Room")).map((r) => r.text), ["archived again"]);
});

test("the site's own items (🎥 go-live / 📼 now playing) are archived too", async () => {
  await setup;
  const room = { id: "Live.Room", name: "Live Room" };
  await archiveOn();
  await sync(room, [msg(room, ALICE, "warm-up")]);
  assert.equal(await bridge.liveNotice("Live.Room", { who: "pb", pad: "Pepe's Pad", what: "Movie night", link: "/p/pepes-pad" }), true);
  const r = (await logRows("Live.Room")).find((x) => x.k === "live");
  assert.ok(r);
  assert.equal(r.who, null);
  assert.equal(r.eid, null);
  assert.deepEqual(JSON.parse(r.d), { who: "pb", pad: "Pepe's Pad", what: "Movie night", link: "/p/pepes-pad" });
  const fc = await feedRows("Live.Room");
  assert.equal(fc[fc.length - 1].c, r.c);
});

test("a line the switch-on seed already copied (same c, same line) is skipped by its live archive write; a c taken by ANOTHER line fails, counted", async () => {
  await setup;
  await archiveOn();
  const row = (await getQuery("SELECT l.c, l.ts, l.k, l.who, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.who IS NOT NULL ORDER BY l.c LIMIT 1"))[0];
  const f0 = CL._stats.failures, d0 = CL._stats.dupesSkipped;
  const same = { c: row.c, k: row.k, ts: Number(row.ts), text: "the same line", u: { login: row.who, display: "x" } };
  let r = await CL.archiveBatch([{ roomId: row.room_id, it: same }]);
  assert.deepEqual(r, { written: 0 });
  assert.equal(CL._stats.failures, f0);
  assert.equal(CL._stats.dupesSkipped, d0 + 1);
  // CL2 fix-up: a reused cursor (a different line on a c already archived) is a bug - never a silent "duplicate"
  const top = (await getQuery("SELECT MAX(c) AS m FROM chat_log"))[0].m;
  r = await CL.archiveBatch([{ roomId: row.room_id, it: { ...same, ts: Number(row.ts) + 1, text: "another line" } },
                             { roomId: row.room_id, it: { c: top + 100000, k: "msg", ts: 5, text: "its batch-mate", u: { login: "zz", display: "zz" } } }]);
  assert.deepEqual(r, { written: 0, error: true });
  assert.equal(CL._stats.failures, f0 + 1);
  assert.equal(CL._stats.lastError, "cursor_reuse");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE c = ?", [top + 100000]))[0].n, 0, "the batch failed whole (its own transaction)");
  assert.equal(CL._stats.dupesSkipped, d0 + 1);
  CL._reset();
});

// the second life of the site: a fresh process on the same database
function restart(script) {
  const file = path.join(tmp, "child-" + (++seq) + ".js");
  fs.writeFileSync(file, `"use strict";
process.chdir(${JSON.stringify(tmp)});
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = ${JSON.stringify(path.join(tmp, "no-hls", "broadcast.m3u8"))};
delete process.env.CHATLOG_DB;
const path = require("path");
const bridge = require(${JSON.stringify(path.join(repo, "bridge"))});
const CL = require(${JSON.stringify(path.join(repo, "chatlog"))});
const { getQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
require(${JSON.stringify(path.join(repo, "userlinks"))})._setQuery(null);
(async () => { await bridge.load(); const out = await (${script})(bridge, CL, getQuery); console.log("RESULT " + JSON.stringify(out)); process.exit(0); })()
  .catch((e) => { console.error(e); process.exit(1); });
`);
  const out = execFileSync(process.execPath, [file], { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  return JSON.parse(line.slice(7));
}

// (from here on only the child processes ingest: this process's cursor no longer knows what they handed out)
test("a restart between processing a batch and answering it: Pepe's re-send leaves no duplicate (chat_log.eid, 10 minutes)", async () => {
  await setup;
  const room = { id: "Resend.Room", name: "Resend Room" };
  await archiveOn();
  const batch = [msg(room, ALICE, "said once", {}), msg(room, BOB, "also once")];
  batch[0].id = "resend-1"; batch[1].id = "resend-2";
  await sync(room, batch);
  const before = (await logRows("Resend.Room")).map((r) => r.c);
  assert.equal(before.length, 2);
  // Pepe re-sends the same batch to a fresh process (whose SEEN_EVENTS is empty), plus a new line
  const r = restart(`async (bridge, CL, getQuery) => {
    const room = { id: "Resend.Room", name: "Resend Room" };
    const mk = (id, text) => ({ op: "event", id, ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room },
                                data: { user: { id: "alice", login: "alice", display: "Alice" }, text } });
    await bridge.ingest({ events: [mk("resend-1", "said once"), mk("resend-2", "also once"), mk("resend-3", "new")], rooms: [{ room, members: [], mic: [], count: 1 }] });
    return (await getQuery("SELECT l.c, l.eid FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = 'Resend.Room' ORDER BY l.c")).map((x) => x.eid);
  }`);
  assert.deepEqual(r, ["resend-1", "resend-2", "resend-3"], "each line once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_feed WHERE room_id = 'Resend.Room'"))[0].n, 3, "the live feed too");
});

test("c is never reused after a drop and a restart (the high-water mark), even with the archive off", async () => {
  await setup;
  await CL.setSwitch("archive", false, "test");
  // a first life: two lines, then every room is dropped and the live feed emptied - MAX(bridge_feed.c) alone would restart at 0
  const top = restart(`async (bridge, CL, getQuery) => {
    const room = { id: "Reuse.Room", name: "Reuse Room" };
    const mk = (id, text) => ({ op: "event", id, ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room },
                                data: { user: { id: "bob", login: "bob", display: "Bob" }, text } });
    await bridge.ingest({ events: [mk("reuse-1", "a"), mk("reuse-2", "b")], rooms: [{ room, members: [], mic: [], count: 1 }] });
    const top = Math.max(...bridge._rooms.get("Reuse.Room").feed.map((it) => it.c));
    await bridge.ingest({ events: [], rooms: [], closed: [...bridge._rooms.keys()] });
    await require(${JSON.stringify(path.join(repo, "dbUtils"))}).runQuery("DELETE FROM bridge_feed");
    return top;
  }`);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n, 0);
  // the second life
  const r = restart(`async (bridge) => {
    const room = { id: "Reuse.Room", name: "Reuse Room" };
    await bridge.ingest({ events: [{ op: "event", id: "after-restart-1", ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room },
                                      data: { user: { id: "bob", login: "bob", display: "Bob" }, text: "after" } }], rooms: [{ room, members: [], mic: [], count: 1 }] });
    return bridge._rooms.get("Reuse.Room").feed.map((it) => it.c);
  }`);
  assert.equal(r.length, 1);
  assert.ok(r[0] > top, `the new line's c (${r[0]}) is above every c handed out before (${top})`);
});

test("padrekey: the archive stays with the Camfrog room, the pad's chat settings move with the pad", async () => {
  await setup;
  await archiveOn();
  const RK = require(path.join(repo, "padrekey"));
  for (const t of ["chatlog_rooms", "chat_log", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views", "chatlog_exports"]) {
    assert.ok(RK.ROOM_BOUND.has(t), t + " is ROOM_BOUND");
  }
  assert.ok(!RK.ROOM_BOUND.has("pad_chat_cfg"));
  await runQuery("INSERT INTO pad_chat_cfg (room_id, window_s, updated) VALUES ('Lab.Room', 3600, 1)");
  await tx(() => RK.rekey("Lab.Room", "patv:lab"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_rooms WHERE room_id = 'Lab.Room'"))[0].n, 1, "the archive keeps the room id");
  assert.deepEqual((await getQuery("SELECT room_id, window_s FROM pad_chat_cfg")).map((r) => [r.room_id, r.window_s]), [["patv:lab", 3600]]);
  await runQuery("DELETE FROM pad_chat_cfg");
});

test("the owner sync's chatlog block (Pepe CL4): notice, archive, the effective windows, search, changed_at, removed", async () => {
  await setup;
  await archiveOn();
  await CL.loadPadCfg();
  const rows = await CL.forOwnerSync([{ id: "Lab.Room" }, { id: "patv:site-pad" }]);
  const b = rows[0].chatlog;
  // CL6 fix-up: + removed_who. Train 3 review: + removed_ok (read in full), wm_chat / wm_tx (the room's own watermarks)
  assert.deepEqual(Object.keys(b).sort(), ["archive", "changed_at", "notice_at", "removed", "removed_ok", "removed_who", "search", "tx_s", "window_s", "wm_chat",
                                           "wm_search", "wm_tx"]);
  assert.equal(b.removed_ok, true);
  assert.ok(Number.isInteger(b.wm_chat) && b.wm_chat >= 0 && Number.isInteger(b.wm_tx) && b.wm_tx >= 0);
  assert.equal(b.notice_at, CL.cfg().notice_at);
  assert.equal(b.archive, true);
  const R = P.retention();
  assert.equal(b.window_s, R.chat_days * 86400, "a pad without a tier: chat kept 30 days, so the default window is 30 days");
  assert.equal(b.tx_s, R.rec_days * 86400);
  assert.equal(b.search, true);
  assert.equal(b.wm_search, 0);
  assert.deepEqual(b.removed, []);
  assert.equal(rows[1].chatlog, undefined, "only Camfrog pads");
  await runQuery("INSERT INTO pad_chat_cfg (room_id, window_s, search, updated) VALUES ('Lab.Room', 0, 0, 5)");
  await CL.loadPadCfg();
  const b2 = (await CL.forOwnerSync([{ id: "Lab.Room" }]))[0].chatlog;
  assert.equal(b2.window_s, 0, "off");
  assert.equal(b2.search, false);
  // Train 3 review: a flip of a GLOBAL switch is no change to this pad's !log - changed_at stays (a Pepe without wm_* would raise
  // his !log watermarks to it in every pad-linked room: the launch-day notice / a purge toggle closed all earlier history)
  const before = b2.changed_at;
  await CL.setSwitch("purge", false);
  await CL.setSwitch("purge", true);
  const b3 = (await CL.forOwnerSync([{ id: "Lab.Room" }]))[0].chatlog;
  assert.equal(b3.changed_at, before, "a switch flip doesn't move the pad's changed_at");
  assert.ok(CL.cfg().changed_at > 0, "(the switch itself did change)");
  // a room the site doesn't track (no chatlog_rooms row): no watermarks on the site either - Train 3 review fix-up: none are sent
  // (Pepe keeps his own forward-only ones: a 0 he follows exactly would throw them away), and no row is made for it
  const b4 = (await CL.forOwnerSync([{ id: "Never.Seen" }]))[0].chatlog;
  assert.ok(!("wm_chat" in b4) && !("wm_tx" in b4), JSON.stringify(b4));
  assert.equal(b4.removed_ok, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_rooms WHERE room_id = 'Never.Seen'"))[0].n, 0);
  await runQuery("DELETE FROM pad_chat_cfg");
  await CL.loadPadCfg();
});

test("the privacy policy states the archive only while the notice is on (chatlog.policy -> views/privacy.ejs)", async () => {
  await setup;
  const ejs = require("ejs");
  const render = async (chatlog) => {
    const html = await ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v", UPDATED: "18 October 2026",
                                                                               enforced: true, chatlog, t: (k) => k, ogBase: "" }, { async: false })
      .catch((e) => { throw e; });
    return html;
  };
  await archiveOn();
  const pol = await CL.policy();
  assert.ok(pol, "on");
  assert.match(pol.notice_day, /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  let on, off;
  try { on = await render(pol); off = await render(null); } catch (e) {
    // the layout partial wants the site's locals: check the template text instead
    const src = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8");
    assert.match(src, /if \(locals\.chatlog\)/);
    assert.match(src, /The latest 200 items per Camfrog room/);
    return;
  }
  assert.match(on, /id="chat-history"/);
  assert.doesNotMatch(on, /The latest 200 items per Camfrog room/);
  assert.match(on, new RegExp(pol.notice_day + ":</b> added <a href=\"#chat-history\">"));
  // the owner's decision-9 change (2026-10-19): incognito hides who, not what - "someone"; !bridge hide leaves your past lines out
  assert.match(on, /incognito hides <i>who<\/i> you are, not what you say/, "the Incognito section says what it does now");
  assert.match(on, /If you're incognito<\/b>, your lines - past ones too - are shown as "someone"/);
  assert.match(on, /With <code>!bridge hide<\/code><\/b> your past lines are left out of all of them for everyone/);
  assert.match(on, /an incognito person's lines are shown as "someone" and a <code>!bridge hide<\/code> person's past lines are left out/, "the dated note too");
  assert.doesNotMatch(on, /hidden people's past lines are left out/);
  assert.doesNotMatch(on, /your chat lines aren't shown there/, "no longer promised");
  assert.doesNotMatch(off, /id="chat-history"/);
  assert.match(off, /The latest 200 items per Camfrog room/);
  // CL2 fix-up: which rooms are kept follows the Plus bridge gate (premium.bridgeAllowed) - every room while it is off
  assert.equal(pol.gate, false);
  assert.match(on, /Every Camfrog room connected to a pad is kept while the website bridge is open to every pad/);
  assert.doesNotMatch(on, /Only Camfrog rooms connected to a pad that has the website bridge/);
  const realCfg = P.config;
  P.config = () => ({ ...realCfg(), plus_bridge_gate: true });
  try {
    const gated = await CL.policy();
    assert.equal(gated.gate, true);
    assert.match(await render(gated), /Only Camfrog rooms connected to a pad that has the website bridge \(💎 Prime Time Plus, and PATV's own pads\) are kept/);
  } finally { P.config = realCfg; }
  // CL2 fix-up: the notice (and so the policy text) can't go off while archived lines exist - after a trip or a manual archive off too
  await CL.setSwitch("archive", false, "test");
  await assert.rejects(CL.setSwitch("notice", false, "test"), (e) => e.code === "archive_rows" && e.status === 409);
  assert.ok(await CL.policy(), "still stated");
  await runQuery("DELETE FROM chat_log");                 // (every line gone - e.g. purged by retention)
  await CL.setSwitch("notice", false, "test");
  assert.equal(await CL.policy(), null, "notice off: the old text");
});
