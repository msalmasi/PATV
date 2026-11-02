// wave 2 WP-5 (incognito / mic-stage spec I.5): tools/evidence-purge.js - the rollback tool for moderation evidence clips (a site rolled back
// past WP-5 runs no sweep). Dry run by default (counts only); --apply deletes file then row for clips past their 30 days, --all every clip;
// a clip under its own hold or a chat legal hold is kept unless --include-held. Prints counts, never a row.
//   node --test test/evidence-purge.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3");

const repo = path.resolve(__dirname, "..");
const T = require(path.join(repo, "tools", "evidence-purge"));
const P = (db, fn, sql, args = []) => new Promise((resolve, reject) => db[fn](sql, args, function (e, r) { if (e) reject(e); else resolve(fn === "run" ? this : r); }));
const D = 864e5;

test("dry run counts; --apply takes expired unheld clips (file then row); holds are kept; --all takes the rest; --include-held the held ones", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-purge-test-"));
  const dir = path.join(tmp, "store");
  const db = new sqlite3.Database(path.join(tmp, "myapp.db"));
  await P(db, "run", `CREATE TABLE evidence_clips (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, rk INTEGER, c INTEGER, tx TEXT, subject_login TEXT NOT NULL, veil TEXT NOT NULL,
                      said_at INTEGER NOT NULL, secs REAL, bytes INTEGER, sha256 TEXT, file TEXT NOT NULL, by_user TEXT NOT NULL, role TEXT NOT NULL, via TEXT NOT NULL,
                      reason TEXT, st_id INTEGER, created INTEGER NOT NULL, expires_at INTEGER NOT NULL, hold_at INTEGER, hold_by TEXT, hold_why TEXT, subject_gone_at INTEGER)`);
  await P(db, "run", "CREATE TABLE chatlog_holds (key TEXT PRIMARY KEY, by_user TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL)");
  await P(db, "run", "CREATE TABLE users (userId TEXT PRIMARY KEY, camfrogUsername TEXT)");
  const t = Date.now();
  const mk = async (id, login, exp, hold = null) => {
    const file = crypto.randomBytes(16).toString("hex") + ".m4a";
    fs.mkdirSync(path.join(dir, file.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(dir, file.slice(0, 2), file), "x");
    await P(db, "run", `INSERT INTO evidence_clips (id, room_id, subject_login, veil, said_at, file, by_user, role, via, created, expires_at, hold_at)
                        VALUES (?, 'R.Room', ?, 'hidden', ?, ?, 'u1', 'admin', 'web', ?, ?, ?)`, [id, login, t, file, t - 31 * D, exp, hold]);
    return path.join(dir, file.slice(0, 2), file);
  };
  const fOld = await mk("ev0000000000000001", "alice", t - D);
  const fHeld = await mk("ev0000000000000002", "bob", t - D, t);
  const fWho = await mk("ev0000000000000003", "carol", t - D);
  const fNew = await mk("ev0000000000000004", "dave", t + 10 * D);
  await P(db, "run", "INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:carol', 'u1', 'order', ?)", [t]);
  const dry = await T.purge(db, { dir });
  assert.deepEqual([dry.clips, dry.due, dry.held, dry.deleted], [4, 3, 2, 0], "dry run: counts only");
  assert.ok([fOld, fHeld, fWho, fNew].every((f) => fs.existsSync(f)), "nothing touched");
  const a = await T.purge(db, { dir, apply: true });
  assert.equal(a.deleted, 1);
  assert.ok(!fs.existsSync(fOld) && fs.existsSync(fHeld) && fs.existsSync(fWho) && fs.existsSync(fNew));
  const all = await T.purge(db, { dir, apply: true, all: true });
  assert.equal(all.deleted, 1, "--all: the fresh one; the held ones stay");
  assert.ok(!fs.existsSync(fNew) && fs.existsSync(fHeld) && fs.existsSync(fWho));
  const inc = await T.purge(db, { dir, apply: true, all: true, includeHeld: true });
  assert.equal(inc.deleted, 2);
  assert.equal((await P(db, "all", "SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, 0);
  db.close();
});

test("review fix R5: the rollback step is written down where operators look (deploy/README.md), the tool points at it", () => {
  const readme = fs.readFileSync(path.join(repo, "deploy", "README.md"), "utf8");
  const i = readme.indexOf("## Rolling the site back past wave 2 WP-5");
  assert.ok(i > 0, "deploy/README.md has the section");
  const sec = readme.slice(i, readme.indexOf("\n## ", i + 5));
  assert.match(sec, /turn evidence clips off/, "switch off first");
  assert.match(sec, /cp \/home\/PATV\/tools\/evidence-purge\.js /, "copy the tool out (the older build doesn't have it)");
  assert.match(sec, /node tools\/evidence-purge\.js myapp\.db --all --apply/, "purge every clip before the rollback");
  assert.match(sec, /--include-held/, "what happens to held clips");
  assert.match(sec, /refresh-staging-db\.sh|refresh staging/, "the staging refresh after such a rollback");
  assert.match(fs.readFileSync(path.join(repo, "tools", "evidence-purge.js"), "utf8").slice(0, 800), /deploy\/README\.md "Rolling the site back past wave 2 WP-5"/);
});

test("a database without the table: nothing to do", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-purge-test-"));
  const db = new sqlite3.Database(path.join(tmp, "myapp.db"));
  const r = await T.purge(db, { dir: tmp, apply: true, all: true });
  assert.deepEqual([r.clips, r.deleted], [0, 0]);
  db.close();
});
