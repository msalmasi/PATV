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
