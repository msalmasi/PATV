// 1.99vm: tools/remove-stray-pad.js - a stray pad's own rows go, a real person's history on it stays unless asked, PAT blocks.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remove-pad-test-"));
const sqlite3 = require("sqlite3");

function sql(file, stmts) {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(file);
    db.exec(stmts, (e) => db.close(() => (e ? rej(e) : res())));
  });
}
function all(file, q) {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
    db.all(q, (e, r) => db.close(() => (e ? rej(e) : res(r))));
  });
}
const run = (dir, ...a) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(repo, "tools", "remove-stray-pad.js"), "--id=Camfrog", "--dir=" + dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
};
const SCHEMA = `
  CREATE TABLE rooms_registry (room_id TEXT PRIMARY KEY, slug TEXT, title TEXT);
  CREATE TABLE room_events (room_id TEXT, ts INTEGER, what TEXT);
  CREATE TABLE econ_watch (day TEXT, stream TEXT, room_id TEXT, viewer_id TEXT);
  CREATE TABLE stage_slots (id TEXT, room_id TEXT);
  CREATE TABLE follows (user_id TEXT, target_kind TEXT, target_id TEXT);
  CREATE TABLE feed_kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE pepe_actions (id INTEGER, args TEXT);
  CREATE TABLE pools (key TEXT PRIMARY KEY, balance INTEGER);
  INSERT INTO rooms_registry VALUES ('Camfrog', 'camfrog', 'Camfrog'), ('DRAMA_CENTRAL', 'drama-central', 'Drama');
  INSERT INTO room_events VALUES ('Camfrog', 1, 'bridge'), ('DRAMA_CENTRAL', 2, 'front-auto');
  INSERT INTO econ_watch VALUES ('d', 'pepe:Camfrog', 'Camfrog', 'v1'), ('d', 'slot:abc', 'Camfrog', 'u1');
  INSERT INTO stage_slots VALUES ('abc', 'Camfrog');
  INSERT INTO follows VALUES ('u1', 'room', 'Camfrog');
  INSERT INTO feed_kv VALUES ('aigen_prices', '{"global":{"imagine":1},"rooms":{"Camfrog":{"imagine":1},"DRAMA_CENTRAL":{"imagine":2}}}');
  INSERT INTO pepe_actions VALUES (1, '["Camfrog","bridge_audio","on"]');`;

test("dry run lists, --apply deletes the pad's own rows (user history kept), edits the settings key, backs up, and is idempotent", async () => {
  const dir = path.join(tmp, "a"); fs.mkdirSync(dir);
  await sql(path.join(dir, "myapp.db"), SCHEMA);
  let r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /"rooms_registry: 1"/);
  assert.match(r.out, /"stage_slots: 1 \(kept\)"/);
  assert.match(r.out, /"feed_kv aigen_prices: drop rooms.Camfrog"/);
  assert.match(r.out, /dry run/);
  assert.equal((await all(path.join(dir, "myapp.db"), "SELECT COUNT(*) n FROM rooms_registry"))[0].n, 2);
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk"));
  assert.equal(r.code, 0, r.out);
  const db = path.join(dir, "myapp.db");
  assert.deepEqual((await all(db, "SELECT room_id FROM rooms_registry")).map((x) => x.room_id), ["DRAMA_CENTRAL"]);
  assert.deepEqual((await all(db, "SELECT room_id FROM room_events")).map((x) => x.room_id), ["DRAMA_CENTRAL"]);
  assert.deepEqual((await all(db, "SELECT stream FROM econ_watch")).map((x) => x.stream), ["slot:abc"], "Pepe's watch row goes, the stage slot's stays");
  assert.equal((await all(db, "SELECT COUNT(*) n FROM stage_slots"))[0].n, 1);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM follows"))[0].n, 1);
  assert.deepEqual(JSON.parse((await all(db, "SELECT value FROM feed_kv"))[0].value).rooms, { DRAMA_CENTRAL: { imagine: 2 } });
  assert.equal((await all(db, "SELECT COUNT(*) n FROM pepe_actions"))[0].n, 1, "the action audit is kept");
  assert.ok(fs.readdirSync(path.join(tmp, "bk")).some((f) => /^myapp-pre-removepad-Camfrog-/.test(f)));
  r = run(dir, "--apply", "--with-user-history", "--backup-dir=" + path.join(tmp, "bk"));
  assert.equal(r.code, 0, r.out);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM stage_slots"))[0].n, 0);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM follows"))[0].n, 0);
  r = run(dir);
  assert.match(r.out, /"delete": \[\]/, "idempotent");
});

test("PAT in the pad's vault, or a table the plan doesn't know, blocks --apply", async () => {
  const dir = path.join(tmp, "b"); fs.mkdirSync(dir);
  await sql(path.join(dir, "myapp.db"), SCHEMA + `
    INSERT INTO pools VALUES ('room:Camfrog', 5000);
    CREATE TABLE mystery (room TEXT); INSERT INTO mystery VALUES ('Camfrog');`);
  const r = run(dir, "--apply");
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /PAT held for this pad/);
  assert.match(r.out, /not in the plan/);
  assert.match(r.out, /REFUSED/);
  assert.equal((await all(path.join(dir, "myapp.db"), "SELECT COUNT(*) n FROM rooms_registry"))[0].n, 2, "nothing written");
});

// CL2: bridge_feed's column is room_id (the plan said `room`, which matched nothing and was swallowed - the stray pad's live feed
// stayed); the room's chat archive (chat_log by its rk - never value-scanned - chatlog_rooms, chatlog_open) and the pad's chat
// settings go; another room's stay; a legal hold on the archive blocks
const ARCHIVE = `
  CREATE TABLE bridge_feed (c INTEGER PRIMARY KEY, room_id TEXT NOT NULL, ts INTEGER, data TEXT NOT NULL);
  CREATE TABLE chatlog_rooms (rk INTEGER PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
  CREATE TABLE chat_log (c INTEGER PRIMARY KEY, rk INTEGER NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, who TEXT, text TEXT, rt TEXT NOT NULL,
                         aud TEXT NOT NULL, d TEXT NOT NULL);
  CREATE TABLE chatlog_open (id INTEGER PRIMARY KEY, rk INTEGER NOT NULL, scope TEXT NOT NULL, requested INTEGER NOT NULL, effective INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE chatlog_holds (key TEXT PRIMARY KEY, by_user TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE pad_chat_cfg (room_id TEXT PRIMARY KEY, window_s INTEGER, updated INTEGER NOT NULL);
  INSERT INTO bridge_feed VALUES (1, 'Camfrog', 1, '{"k":"msg"}'), (2, 'DRAMA_CENTRAL', 1, '{"k":"msg"}');
  INSERT INTO chatlog_rooms VALUES (1, 'Camfrog', 1), (2, 'DRAMA_CENTRAL', 1);
  INSERT INTO chat_log VALUES (10, 1, 1, 'msg', 'bob', 'stray line', 'r1', 'm', '{}'), (11, 1, 2, 'msg', 'bob', 'another', 'r1', 'm', '{}'),
                              (12, 2, 1, 'msg', 'bob', 'kept', 'r2', 'm', '{}');
  INSERT INTO chatlog_open VALUES (1, 1, 'window', 1, 2, 'pending'), (2, 2, 'window', 1, 2, 'pending');
  INSERT INTO pad_chat_cfg VALUES ('Camfrog', 60, 1), ('DRAMA_CENTRAL', 60, 1);`;

test("CL2: the stray room's live feed (room_id), its chat archive and the pad's chat settings go; others stay", async () => {
  const dir = path.join(tmp, "c"); fs.mkdirSync(dir);
  const db = path.join(dir, "myapp.db");
  await sql(db, SCHEMA + ARCHIVE);
  let r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /"bridge_feed: 1"/, "the room_id column is found now");
  assert.match(r.out, /"chat_log: 2"/);
  assert.match(r.out, /"chatlog_rooms: 1"/);
  assert.match(r.out, /"chatlog_open: 1"/);
  assert.match(r.out, /"pad_chat_cfg: 1"/);
  assert.ok(r.out.indexOf('"chat_log: 2"') < r.out.indexOf('"chatlog_rooms: 1"'), "the archive's rows before the room they hang off");
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual((await all(db, "SELECT room_id FROM bridge_feed")).map((x) => x.room_id), ["DRAMA_CENTRAL"]);
  assert.deepEqual((await all(db, "SELECT c FROM chat_log")).map((x) => x.c), [12]);
  assert.deepEqual((await all(db, "SELECT room_id FROM chatlog_rooms")).map((x) => x.room_id), ["DRAMA_CENTRAL"]);
  assert.deepEqual((await all(db, "SELECT rk FROM chatlog_open")).map((x) => x.rk), [2]);
  assert.deepEqual((await all(db, "SELECT room_id FROM pad_chat_cfg")).map((x) => x.room_id), ["DRAMA_CENTRAL"]);
  r = run(dir);
  assert.match(r.out, /"delete": \[\]/, "idempotent");
});

test("CL2: a legal hold on the room's chat archive blocks --apply", async () => {
  const dir = path.join(tmp, "d"); fs.mkdirSync(dir);
  const db = path.join(dir, "myapp.db");
  await sql(db, SCHEMA + ARCHIVE + "INSERT INTO chatlog_holds VALUES ('room:1', 'u_staff', 'a legal order', 1);");
  const r = run(dir, "--apply");
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /a legal hold on this room's chat archive/);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM chat_log"))[0].n, 3, "nothing written");
});

// CL2 fix-up: a per-person legal hold (CL6 "who:<login or u:id>") on anyone whose lines are in the stray room's archive blocks too -
// their purged lines included (speaker "h:" + the login's hash); a hold on someone who never spoke there doesn't
test("CL2 fix-up: a legal hold on a person whose lines are in the room's chat archive blocks --apply; one on a stranger doesn't", async () => {
  const hashOf = require(path.join(repo, "chatlog")).hash;
  const dir = path.join(tmp, "e"); fs.mkdirSync(dir);
  const db = path.join(dir, "myapp.db");
  await sql(db, SCHEMA + ARCHIVE + "INSERT INTO chatlog_holds VALUES ('who:bob', 'u_staff', 'a legal order', 1);");
  let r = run(dir, "--apply");
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /a legal hold on a person whose lines are in this room's chat archive/);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM chat_log"))[0].n, 3, "nothing written");
  // a purged line keeps only the hash of its speaker
  const dir2 = path.join(tmp, "f"); fs.mkdirSync(dir2);
  const db2 = path.join(dir2, "myapp.db");
  await sql(db2, SCHEMA + ARCHIVE + `UPDATE chat_log SET who = 'h:${hashOf("carol")}' WHERE c = 11; INSERT INTO chatlog_holds VALUES ('who:Carol', 'u_staff', 'held', 1);`);
  r = run(dir2, "--apply");
  assert.equal(r.code, 3, r.out);
  // a stranger's hold: no block
  const dir3 = path.join(tmp, "g"); fs.mkdirSync(dir3);
  const db3 = path.join(dir3, "myapp.db");
  await sql(db3, SCHEMA + ARCHIVE + "INSERT INTO chatlog_holds VALUES ('who:nobody_here', 'u_staff', 'held', 1);");
  r = run(dir3, "--apply", "--backup-dir=" + path.join(tmp, "bk3"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual((await all(db3, "SELECT c FROM chat_log")).map((x) => x.c), [12]);
});
