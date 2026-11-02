// wave 2 WP-2 (incognito / mic-stage spec I.3 "rollback test", I.5): the rollback floor. A DB holding privacy-wire-v2 rows -
// bridge_feed items and a bridge_rooms snapshot with veiled people, the archive's veiled chat_log rows, the side tables - is read by
// the PREVIOUS site build (119e948b = today's prod, 1.99agr's short links on 72b12510's 1.99agq + 1.99ago, WP-1's whitelisted
// projection; the track was built against 6ee3c0a1 and moved here at integration - a rollback of this deploy lands on 119e948b),
// unpacked with `git archive` into the temp dir and run in a child process (NODE_PATH = this checkout's node_modules: no worktree,
// no junction). Its live view and its
// archive projection, for a member, must hold no real identity: no vz / vw / priv, no hidden-set hash, no veiled login or display
// name, no hidden word. tools/veil-scrub.js (the scrub before a rollback PAST WP-1): a dry run changes nothing, --apply empties the
// live side tables and takes the frog-name fields out of the JSON, chat_log_veil stays.
//   node --test test/veil-rollback.test.js        (needs git and tar on PATH; skipped when the old commit isn't in this clone)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const OLD = "119e948b";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-rollback-test-"));
const dbDir = path.join(tmp, "db");
fs.mkdirSync(dbDir);
process.chdir(dbDir);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ef".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const PW = require(path.join(repo, "privwire"));

const D = 864e5;
const hash = (l) => crypto.createHash("sha256").update("pepe-hidden:" + String(l).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Roll.Room", name: "Roll Room" }, SLUG = "roll-room";
const real = (login, display) => ({ id: login, login, display });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
let seq = 0;
const ev = (type, data) => ({ op: "event", id: "rb-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const SECRET = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide", "the rollback secret words", hash("frankiefettuccine"), hash("hankhidden"),
                "\"vz\"", "\"vw\"", "\"priv\""];

function oldTree() {
  const have = spawnSync("git", ["cat-file", "-e", OLD + "^{commit}"], { cwd: repo });
  if (have.status !== 0) return null;
  const dir = path.join(tmp, "old");
  fs.mkdirSync(dir);
  const top = execFileSync("git", ["ls-tree", "--name-only", OLD], { cwd: repo, encoding: "utf8" }).split(/\r?\n/).filter(Boolean)
    .filter((n) => !["public", "test", "docs", "deploy", "tools", "node_modules"].includes(n));
  // (relative paths, run from inside the target: GNU tar reads "C:\..." as a remote host)
  fs.writeFileSync(path.join(dir, "old.tar"), execFileSync("git", ["archive", "--format=tar", OLD, "--", ...top], { cwd: repo, maxBuffer: 512 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", "old.tar"], { cwd: dir });
  fs.unlinkSync(path.join(dir, "old.tar"));
  return dir;
}

test("the previous build (pre-WP-2) reads a DB holding v2 rows and serialises no identity; veil-scrub dry run / apply", async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('id-mem', 'mem', 'mem', 'x', 'pleb', 'memcf')");
  await require(path.join(repo, "inbox")).ready;
  await rooms.init();
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: "id-adm", username: "adm" });
  const snap = { room: ROOM, count: 3, transcripts: true,
                 members: [real("alicecf", "Alice"), Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine") }),
                           Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden") })],
                 mic: [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true })] };
  await bridge.ingest({ rooms: [snap], bridge_hidden_h: [hash("hankhidden")], incog_hidden_h: [hash("frankiefettuccine")], events: [
    ev("message", { user: real("alicecf", "Alice"), text: "a named line" }),
    ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "an incognito line", priv: priv("incognito", "frankiefettuccine") }),
    ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: "the rollback secret words" }) }),
    ev("mic.grab", { user: Object.assign(real("frankiefettuccine", "Frankie Fett"), { proven: true }), hold: "hd-00000000aaaa", priv: priv("incognito", "frankiefettuccine") }),
    ev("member.join", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden") }),
  ] }, { v2: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n >= 3, "v2 rows stored");
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM chat_log_veil"))[0].n >= 3, "and archived");

  const dir = oldTree();
  if (!dir) console.log("(the old commit isn't in this clone - the old-build half is skipped)");
  else {
    const script = `
      process.env.SECRET_KEY = "test-secret"; process.env.HLS_PLAYLIST_PATH = ${JSON.stringify(process.env.HLS_PLAYLIST_PATH)};
      delete process.env.CHATLOG_DB; delete process.env.STAGING;
      const path = require("path"), OLD = ${JSON.stringify(dir)};
      require(path.join(OLD, "terms"))._setRequired(false);
      const bridge = require(path.join(OLD, "bridge")), CV = require(path.join(OLD, "chatlogview")), { getQuery } = require(path.join(OLD, "dbUtils"));
      (async () => {
        await require(path.join(OLD, "rooms")).init();
        await bridge.load();
        const R = bridge.bySlug(${JSON.stringify(SLUG)});
        const viewer = { userId: "id-mem", class: "pleb" };
        const lv = R ? await bridge.liveView(R, 0, "id-mem", "memcf", "mem", true, { viewer }) : { missing: true };
        await CV.init();
        const V = await CV.view(${JSON.stringify(ROOM.id)}, viewer);
        const rows = await getQuery("SELECT * FROM chat_log ORDER BY c");
        const hist = CV.dress(CV.filter(rows.map(CV.itemOf), { view: V, jc: null }).items, { view: V });
        process.stdout.write("@@OUT@@" + JSON.stringify({ lv, hist, n: rows.length }) + "@@END@@");
        process.exit(0);
      })().catch((e) => { console.error("OLD BUILD FAILED", e && e.stack); process.exit(3); });`;
    const r = spawnSync(process.execPath, ["-e", script], { cwd: dbDir, env: Object.assign({}, process.env, { NODE_PATH: path.join(repo, "node_modules") }),
                                                         encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const m = /@@OUT@@([\s\S]*)@@END@@/.exec(r.stdout || "");
    assert.ok(m, "the old build ran: " + String(r.stderr || "").slice(-1500));
    const out = JSON.parse(m[1]);
    assert.ok(!out.lv.missing, "the old build found the room");
    assert.ok(out.lv.feed.length >= 2 && out.hist.length >= 2, "and showed its lines");
    const json = m[1];
    assert.deepEqual(SECRET.filter((x) => json.includes(x)), [], "the old build serialises no identity, hash or hidden word");
    assert.ok(out.lv.feed.some((o) => o.text === "a named line"), "named lines as before");
  }

  // veil-scrub: a dry run changes nothing; --apply empties the live side tables and the frog-name fields; chat_log_veil stays
  const S = require(path.join(repo, "tools", "veil-scrub"));
  const sqlite3 = require("sqlite3");
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(path.join(dbDir, "myapp.db"), (e) => (e ? rej(e) : res(d))); });
  try {
    const dry = await S.scrub(db);
    assert.ok(dry.bridge_veil >= 3 && dry.feed_items >= 2 && dry.room_snaps === 1, JSON.stringify(dry));
    assert.ok((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n >= 3, "a dry run deletes nothing");
    const done = await S.scrub(db, { apply: true });
    assert.equal(done.bridge_veil, dry.bridge_veil);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n, 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_rooms_veil"))[0].n, 0);
    const feed = (await getQuery("SELECT data FROM bridge_feed")).map((x) => x.data).join("\n");
    assert.ok(!/"alias"|"hood"|"veil"/.test(feed), "no frog-name field left in bridge_feed");
    assert.ok((await getQuery("SELECT COUNT(*) AS n FROM chat_log_veil"))[0].n >= 3, "chat_log_veil stays");
  } finally { db.close(); }
});
