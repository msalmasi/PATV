// 1.99acf the inbound text cap is 490 characters on every Camfrog path (the chat design §10.7; Pepe's BRIDGE_MAX_TEXT, bot
// 1.99abz): a chat line, a mic transcript and a web sender's own words keep 490 characters whole and cut the 491st; a quote of
// such a line keeps all 490 (quotes.js LINE_MAX).
//   node --test test/bridge-490.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-490-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const quotes = require(path.join(repo, "quotes"));
const UL = require(path.join(repo, "userlinks"));

const PEPE = { id: "pepefrog", login: "PepeFrog", display: "PepeFrog", is_self: true };
const ALICE = { id: "alice", login: "alice", display: "Alice" };
const ROOM = { id: "Long.Room", name: "Long Room" };
let seq = 0;
const ev = (type, data) => ({ op: "event", id: "long-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const text = (n, c = "a") => (c.repeat(9) + " ").repeat(Math.ceil(n / 10)).slice(0, n - 1) + "Z";

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
});

async function feed(events) {
  await bridge.ingest({ events, rooms: [{ room: ROOM, members: [PEPE, ALICE], mic: [], count: 2, transcripts: true }] });
  const R = bridge.bySlug(bridge.slugify(ROOM.name));
  return (await bridge.liveView(R, 0)).feed;
}

test("490 characters stay whole on a chat line, a transcript and a web sender's words; 491 are cut to 490", async () => {
  const t490 = text(490), t491 = text(491, "b");
  assert.equal(t490.length, 490);
  const f = await feed([
    ev("message", { user: ALICE, text: t490 }),
    ev("message", { user: ALICE, text: t491 }),
    ev("x.pepe.transcript", { id: "tx-00000000000000a1", user: ALICE, text: t490, source: "mic" }),
    ev("x.pepe.transcript", { id: "tx-00000000000000a2", user: ALICE, text: t491, source: "mic" }),
    ev("message", { user: PEPE, text: "🌐 Web (PATV web): ...", self: true, web: { user: { login: "u:acct-123456", display: "Webby" }, text: text(490, "w") } }),
    ev("message", { user: PEPE, text: "🌐 Web (PATV web): ...", self: true, web: { user: { login: "u:acct-123456", display: "Webby" }, text: text(491, "x") } }),
  ]);
  const msgs = f.filter((it) => it.k === "msg").map((it) => it.text);
  const txs = f.filter((it) => it.k === "tx").map((it) => it.text);
  assert.ok(msgs.includes(t490), "a 490-character line is kept whole");
  assert.ok(msgs.includes(t491.slice(0, 490)), "a 491-character line is cut to 490");
  assert.ok(txs.includes(t490) && txs.includes(t491.slice(0, 490)), "transcripts too");
  assert.ok(msgs.includes(text(490, "w")) && msgs.includes(text(491, "x").slice(0, 490)), "a web sender's own words too");
  assert.ok(f.every((it) => !it.text || it.text.length <= 490));
});

test("a quote of a 490-character line keeps all of it", async () => {
  const t = text(490, "q");
  const lines = await quotes.buildLines([{ k: "msg", u: { login: "alice", display: "Alice" }, text: t, ts: Date.now() }]);
  assert.equal(lines[0].text, t);
  const long = await quotes.buildLines([{ k: "msg", u: { login: "alice", display: "Alice" }, text: t + "more", ts: Date.now() }]);
  assert.equal(long[0].text.length, 490);
});

// Pepe counts with Python len() (code points): an emoji is ONE character to him and TWO UTF-16 units to String.slice
const cps = (s) => Array.from(s).length;
const loneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test("the cap counts code points like Pepe: a 490-character line with emoji stays whole; a cut never leaves half a surrogate pair", async () => {
  const astral = "🐸 " + "😀".repeat(200) + " " + "b".repeat(490 - 2 - 200 - 1);   // 490 code points, 690 UTF-16 units
  assert.equal(cps(astral), 490);
  assert.ok(astral.length > 490);
  const over = "😀".repeat(491);                                                       // 491 code points: the 491st goes
  const odd = "a" + "😀".repeat(500);                                                  // a UTF-16 cut at 490 would split a pair
  const f = await feed([
    ev("message", { user: ALICE, text: astral }),
    ev("message", { user: ALICE, text: over }),
    ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: ALICE, text: odd, source: "mic" }),
    ev("message", { user: PEPE, text: "🌐 Web (PATV web): ...", self: true, web: { user: { login: "u:acct-123456", display: "Webby" }, text: astral.replace("🐸", "🌍") } }),
  ]);
  const texts = f.filter((it) => it.text).map((it) => it.text);
  assert.ok(texts.includes(astral), "490 code points with emoji are kept whole");
  assert.ok(texts.includes("😀".repeat(490)), "491 emoji are cut to 490 emoji, not 245");
  assert.ok(texts.includes("a" + "😀".repeat(489)), "the transcript: 490 code points");
  assert.ok(texts.includes(astral.replace("🐸", "🌍")), "a web sender's words too");
  assert.ok(texts.every((t) => !loneSurrogate(t)), "nothing ends (or starts) in a lone surrogate");
  assert.ok(texts.every((t) => cps(t) <= 490));
  const q = await quotes.buildLines([{ k: "msg", u: { login: "alice", display: "Alice" }, text: astral, ts: Date.now() }]);
  assert.equal(q[0].text, astral, "a quote keeps the whole emoji line");
  const q2 = await quotes.buildLines([{ k: "msg", u: { login: "alice", display: "Alice" }, text: odd, ts: Date.now() }]);
  assert.equal(cps(q2[0].text), 490);
  assert.ok(!loneSurrogate(q2[0].text));
});
