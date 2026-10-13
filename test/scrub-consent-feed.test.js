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

test("refuses without the login / room / window", () => {
  const dir = path.join(tmp, "b"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "myapp.db"), "");
  let out = "";
  try { execFileSync(process.execPath, [path.join(repo, "tools", "scrub-consent-feed.js"), "--dir=" + dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { out = String(e.stderr); assert.equal(e.status, 2); }
  assert.match(out, /required/);
});
