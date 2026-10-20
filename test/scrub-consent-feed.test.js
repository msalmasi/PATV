// 1.99wp: tools/scrub-consent-feed.js - the consent READINGS by the login leave the room feed (by content), everything else
// stays; other tables are only reported; the legal consent record is never looked at; backup first; idempotent.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-consent-test-"));
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
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(repo, "tools", "scrub-consent-feed.js"), "--dir=" + dir, "--login=alice1234", "--room=Lab.Room", "--codes=4321,5678",
    "--since=2026-10-12T00:00:00Z", "--until=2026-10-14T00:00:00Z", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
};
const T = Date.parse("2026-10-13T06:07:34Z");
const item = (login, text, room = "Lab.Room", k = "tx") => JSON.stringify({ k, ts: T, u: { login, display: login }, text });
const esc = (s) => s.replace(/'/g, "''");
const READ1 = "I am ALICE ONE, and I consent to PA TV cloning my voice. Code 4321 A little frog";
const READ2 = "I am fond of code four three two one";
const TALK = "then I have your consent to clone your voice, new feature";
const SCHEMA = `
  CREATE TABLE bridge_feed (c INTEGER PRIMARY KEY, room_id TEXT NOT NULL, ts INTEGER, data TEXT NOT NULL);
  CREATE TABLE quotes (id INTEGER PRIMARY KEY, body TEXT);
  CREATE TABLE voice_consents (id INTEGER PRIMARY KEY, login TEXT, stt_text TEXT);
  CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER);
  INSERT INTO bridge_feed VALUES (1, 'Lab.Room', ${T}, '${esc(item("alice1234", READ1))}');
  INSERT INTO bridge_feed VALUES (2, 'Lab.Room', ${T}, '${esc(item("alice1234", READ2))}');
  INSERT INTO bridge_feed VALUES (3, 'Lab.Room', ${T}, '${esc(item("alice1234", TALK))}');
  INSERT INTO bridge_feed VALUES (4, 'Lab.Room', ${T}, '${esc(item("bob", READ1))}');
  INSERT INTO bridge_feed VALUES (5, 'Lab.Room', ${T}, '${esc(item("alice1234", READ1, "Lab.Room", "msg"))}');
  INSERT INTO bridge_feed VALUES (6, 'Other.Room', ${T}, '${esc(item("alice1234", READ1, "Other.Room"))}');
  INSERT INTO bridge_feed VALUES (7, 'Lab.Room', ${Date.parse("2026-10-01T00:00:00Z")}, '${esc(item("alice1234", READ1))}');
  INSERT INTO quotes VALUES (1, '${esc("alice1234: " + READ1)}'), (2, 'bob: hi');
  INSERT INTO voice_consents VALUES (1, 'alice1234', '${esc(READ1)}');`;

test("dry run lists; --apply backs up and removes only the login's readings in the room's feed; idempotent", async () => {
  const dir = path.join(tmp, "a"); fs.mkdirSync(dir);
  const db = path.join(dir, "myapp.db");
  await sql(db, SCHEMA);
  let r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /bridge_feed {2}delete {2}c=1 .*LIVE/);
  assert.match(r.out, /bridge_feed {2}delete {2}c=2 /);
  assert.doesNotMatch(r.out, /c=[34567] /);
  assert.match(r.out, /REPORT ONLY {2}quotes\.body rowid=1/);
  assert.doesNotMatch(r.out, /voice_consents/);
  assert.match(r.out, /dry run/);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM bridge_feed"))[0].n, 7);
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /backup: /);
  assert.match(r.out, /deleted 2 bridge_feed row\(s\)/);
  assert.match(r.out, /restart the site/);
  assert.deepEqual((await all(db, "SELECT c FROM bridge_feed ORDER BY c")).map((x) => x.c), [3, 4, 5, 6, 7]);
  assert.equal((await all(db, "SELECT COUNT(*) n FROM quotes"))[0].n, 2, "reported tables untouched");
  assert.equal((await all(db, "SELECT COUNT(*) n FROM voice_consents"))[0].n, 1, "the legal record untouched");
  const bk = fs.readdirSync(path.join(tmp, "bk"));
  assert.equal(bk.length, 1);
  assert.equal((await all(path.join(tmp, "bk", bk[0]), "SELECT COUNT(*) n FROM bridge_feed"))[0].n, 7, "the backup is the original");
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk"));
  assert.match(r.out, /bridge_feed: nothing to remove/);
  assert.equal(fs.readdirSync(path.join(tmp, "bk")).length, 1, "no new backup when there is nothing to do");
});

// CL2: the pad chat archive - the same readings are BLANKED there (text + speaker gone, purged = 1, the index follows by
// trigger); the row (and its cursor) stays; other lines, other rooms and other people are untouched; its FTS shadow tables
// are never value-scanned
test("CL2: the readings in chat_log are blanked (text, speaker, index); everything else stays", async () => {
  const dir = path.join(tmp, "c"); fs.mkdirSync(dir);
  const db = path.join(dir, "myapp.db");
  const d = (who) => esc(JSON.stringify({ u: { display: who } }));
  await sql(db, SCHEMA + `
    CREATE TABLE chatlog_rooms (rk INTEGER PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, "rows" INTEGER NOT NULL DEFAULT 0, idx_rows INTEGER NOT NULL DEFAULT 0,
                                bytes INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE chat_log (c INTEGER PRIMARY KEY, rk INTEGER NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, who TEXT, text TEXT, rt TEXT NOT NULL,
                           aud TEXT NOT NULL, d TEXT NOT NULL, rm_at INTEGER, purged INTEGER);
    CREATE VIRTUAL TABLE chat_log_fts USING fts5(text, rt, content = 'chat_log', content_rowid = 'c', tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER chat_log_ai AFTER INSERT ON chat_log WHEN new.text IS NOT NULL AND new.k IN ('msg','tx','topic') AND new.rm_at IS NULL AND new.purged IS NULL BEGIN
      INSERT INTO chat_log_fts (rowid, text, rt) VALUES (new.c, new.text, new.rt); END;
    CREATE TRIGGER chat_log_au AFTER UPDATE OF text, rt, rm_at, purged ON chat_log BEGIN
      INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt) SELECT 'delete', old.c, old.text, old.rt
        WHERE old.text IS NOT NULL AND old.k IN ('msg','tx','topic') AND old.rm_at IS NULL AND old.purged IS NULL;
      INSERT INTO chat_log_fts (rowid, text, rt) SELECT new.c, new.text, new.rt
        WHERE new.text IS NOT NULL AND new.k IN ('msg','tx','topic') AND new.rm_at IS NULL AND new.purged IS NULL; END;
    INSERT INTO chatlog_rooms (rk, room_id, "rows", idx_rows, bytes, created) VALUES (1, 'Lab.Room', 4, 4, 5000, 1), (2, 'Other.Room', 1, 1, 1000, 1);
    INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES
      (101, 1, ${T}, 'tx', 'alice1234', '${esc(READ1)}', 'r1', 'm', '${d("Alice")}'),
      (102, 1, ${T}, 'tx', 'alice1234', '${esc(TALK)}', 'r1', 'm', '${d("Alice")}'),
      (103, 1, ${T}, 'tx', 'bob', '${esc(READ1)}', 'r1', 'm', '${d("Bob")}'),
      (104, 2, ${T}, 'tx', 'alice1234', '${esc(READ1)}', 'r2', 'm', '${d("Alice")}'),
      (105, 1, ${T}, 'msg', 'alice1234', '${esc(READ2)}', 'r1', 'm', '${d("Alice")}');`);
  let r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /chat_log {5}blank {3}c=101 /);
  assert.doesNotMatch(r.out, /c=10[2-5] /);
  assert.doesNotMatch(r.out, /REPORT ONLY {2}chat_log/, "the archive and its index are never value-scanned");
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk2"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /blanked 1 chat_log row\(s\)/);
  const rows = await all(db, "SELECT c, text, d, purged FROM chat_log ORDER BY c");
  assert.deepEqual(rows[0], { c: 101, text: null, d: '{"u":{}}', purged: 1 });
  assert.ok(rows.slice(1).every((x) => x.text && x.purged === null), "the rest untouched");
  assert.deepEqual((await all(db, "SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH '\"consent\"' ORDER BY rowid")).map((x) => x.rowid), [102, 103, 104],
                   "the blanked line left the index");
  // CL2 fix-up: the room's counters follow (one indexed line less, its text's bytes and the speaker's display gone)
  const cnt = await all(db, `SELECT rk, "rows" AS n, idx_rows, bytes FROM chatlog_rooms ORDER BY rk`);
  assert.equal(cnt[0].n, 4, "the row stays");
  assert.equal(cnt[0].idx_rows, 3);
  assert.equal(cnt[0].bytes, 5000 - Buffer.byteLength(READ1, "utf8") - (Buffer.byteLength(JSON.stringify({ u: { display: "Alice" } })) - Buffer.byteLength('{"u":{}}')));
  assert.deepEqual([cnt[1].idx_rows, cnt[1].bytes], [1, 1000], "the other room untouched");
  r = run(dir, "--apply", "--backup-dir=" + path.join(tmp, "bk2"));
  assert.match(r.out, /chat_log: nothing to blank/, "idempotent");
});

test("refuses without the login / room / window", () => {
  const dir = path.join(tmp, "b"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "myapp.db"), "");
  let out = "";
  try { execFileSync(process.execPath, [path.join(repo, "tools", "scrub-consent-feed.js"), "--dir=" + dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { out = String(e.stderr); assert.equal(e.status, 2); }
  assert.match(out, /required/);
});
