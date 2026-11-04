// 1.99?? roompm: Pepe's private answers in a pad's chat ("room PMs", roompm.js + bridge-relay.js + bridge.js liveView). The owner,
// 2026-11-04: "if i do !spin in the bridge, i don't get the acknowledgement or results if pepe is set to send them via PM".
//   - a TYPED command's private answers (the job's ack replies, final and late) become rows of THAT account in THAT pad - only its own
//     /live answers carry them (?rpm=), never another account's, another pad's, a signed-out view, the homepage panel or an embed
//   - Manage-panel / 🐸 Pepe-menu / setting / say jobs never make rows; a late ack after the job's JOB_TTL still finds its account
//   - re-sent acks add nothing; bounds: KEEP a pad, TTL, TEXT_MAX, RATE a minute, MAX_KEYS
//   - the account's waiting long-poll wakes on a new row, another viewer's doesn't
//   - the text is never in the pad's feed, any database table (chat archive, search, the command log, Telegram's outbox...) or liveFor
//   - the site's own "!commands" answer is a row too; the switch (off = {on: 0}, rows cleared); account deletion forgets them
//   node --test test/roompm.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roompm-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const RPM = require(path.join(repo, "roompm"));

const ROOM = { id: "Pm.Room", name: "Pm Room" };
const ROOM2 = { id: "Other.Room", name: "Other Room" };
const SLUG = "pm-room", SLUG2 = "other-room";
const SECRET = "ZEBRA-7741-private";
let base, server;
const members = [{ login: "alicecf", display: "Alice" }, { login: "bobcf", display: "Bob" }, { login: "pepefrog", display: "PepeFrog", is_self: true }];
const snap = (R, extra) => Object.assign({ room: R, topic: "", members, count: 3, relay: true, cmds: { "!spin": 5000, "!balance": 0, "!help": 0 } }, extra);
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const bot = (p, body) => post(p, null, Object.assign({ password: "bot-token" }, body));
const sync = () => bot("/api/bridge/sync", { events: [], rooms: [snap(ROOM), snap(ROOM2)] });
const say = (u, text, slug = SLUG) => post("/api/rooms/" + slug + "/say", u, { text });
const live = (u, q = "", slug = SLUG, opts = {}) => fetch(base + "/api/rooms/" + slug + "/live" + q, Object.assign({ headers: H(u) }, opts)).then((r) => r.json());
const ack = (acks) => bot("/api/bridge/relay/ack", { acks });
const pepeTs = () => Math.floor(Date.now() / 1000);
function reset() { relay._jobs.clear(); relay._hits.clear(); relay._cids.clear(); RPM._reset(); }
async function cmd(u, text, slug = SLUG) {
  relay._hits.clear();
  const r = await say(u, text, slug);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT,
                  avatar TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'alicep', 'Alice P', 'x', 'alicecf')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u2', 'bobp', 'Bob', 'x', 'bobcf')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES ('u9', 'adminp', 'Admin', 'x', NULL, 'Admin')");
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use((req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? { userId: u, username: { u1: "alicep", u2: "bobp", u9: "adminp" }[u] || u, class: u === "u9" ? "Admin" : "pleb" } : null;
    next();
  });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await sync();
  await RPM.init();
});
test.after(() => server && server.close());

test("!spin from the web, answered privately: the 'spinning' ack and the result show to that account only, on that pad only", async () => {
  reset();
  const id = await cmd("u1", "!spin");
  const j = relay._jobs.get(id);
  assert.ok(j && j.kind === "cmd" && j.userId === "u1");
  // Pepe's ack: the command ran (nothing private yet), then the wheel's two lines as late replies
  await ack([{ id, ok: true, msg: "done", ts: pepeTs(), replies: [] }]);
  await ack([{ id, ok: true, msg: "", ts: pepeTs(), replies: ["Spinning the wheel for PAT 5000, good luck! (PAT 12,345)"], late: true }]);
  await ack([{ id, ok: true, msg: "", ts: pepeTs(), replies: ["You won **PAT 2,500** and gained 10 XP. " + SECRET], late: true }]);
  const a = await live("u1", "?rpm=0");
  assert.equal(a.rpm.on, 1);
  assert.deepEqual(a.rpm.rows.map((r) => r.text), ["Spinning the wheel for PAT 5000, good luck! (PAT 12,345)", "You won PAT 2,500 and gained 10 XP. " + SECRET],
    "both lines, oldest first, markdown markers stripped like the Camfrog PM");
  assert.ok(a.rpm.rows.every((r) => r.cmd === "!spin" && r.id > 0 && r.ts > 0));
  assert.ok(a.rpm.rows[0].id < a.rpm.rows[1].id && a.rpm.v === a.rpm.rows[1].id, "ids ascend; v = the newest");
  assert.ok(a.rpm.u && a.rpm.u.self === true && a.rpm.u.login === "pepefrog", "drawn as Pepe's line");
  assert.ok(a.rpm.rows[0].ts % 1000 === 999, "Pepe's clock, the end of his second (sorts after the command's echo)");
  // the cursor: nothing again after the newest
  assert.deepEqual((await live("u1", "?rpm=" + a.rpm.v)).rpm.rows, []);
  // nobody else
  const b = await live("u2", "?rpm=0");
  assert.equal(b.rpm.on, 1);
  assert.deepEqual(b.rpm.rows, [], "another account on the same pad: nothing");
  assert.doesNotMatch(JSON.stringify(b), new RegExp(SECRET));
  assert.deepEqual((await live("u1", "?rpm=0", SLUG2)).rpm.rows, [], "the same account on another pad: nothing");
  const noParam = await live("u1", "");
  assert.equal(noParam.rpm, undefined, "a page that doesn't ask (homepage panel, older page) gets no rpm block");
  const out = await live(null, "?rpm=0");
  assert.equal(out.rpm, undefined, "signed out: none");
  assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET));
  // the homepage's view of the room never carries it
  const home = await bridge.liveFor(SLUG, { userId: "u1" });
  assert.doesNotMatch(JSON.stringify(home || {}), new RegExp(SECRET));
  // a bad cursor is ignored (no block, like no param)
  assert.equal((await live("u1", "?rpm=abc")).rpm, undefined);
});

test("only typed commands: Manage-panel, Pepe-menu, setting and say jobs never make private rows", async () => {
  reset();
  const base0 = { roomId: ROOM.id, userId: "u1", username: "alicep", camfrog: "alicecf" };
  const jobs = [
    relay.newJob(Object.assign({ kind: "cmd", text: "!kick bob", gui: "kick" }, base0)),
    relay.newJob(Object.assign({ kind: "cmd", text: "!roast bobcf", pepe: "roast" }, base0)),
    relay.newJob(Object.assign({ kind: "cmd", text: "!chatty on", setting: "chatty" }, base0)),
    relay.newJob(Object.assign({ kind: "say", text: "hello" }, base0)),
  ];
  relay.applyAcks(jobs.map((j) => ({ id: j.id, ok: true, msg: "x", ts: pepeTs(), replies: ["panel answer " + SECRET] })));
  relay.applyAcks(jobs.map((j) => ({ id: j.id, ok: true, msg: "", ts: pepeTs(), replies: ["late " + SECRET], late: true })));
  assert.deepEqual(RPM.since("u1", ROOM.id, 0).rows, []);
  assert.equal(RPM.state().rows, 0);
  // an ack for a job nobody made: nothing
  relay.applyAcks([{ id: "wdeadbeefdeadbeef", ok: true, msg: "", ts: pepeTs(), replies: ["who?"], late: true }]);
  assert.equal(RPM.state().rows, 0);
});

test("a late answer after the job left memory still reaches its account (origins); re-sent acks add nothing", async () => {
  reset();
  const id = await cmd("u1", "!balance -p");
  const fin = { id, ok: true, msg: "answered privately", ts: pepeTs(), replies: ["Your balance: PAT 12,345"] };
  relay.applyAcks([fin]);
  relay.applyAcks([fin]);                                    // the post went through, its answer was lost: Pepe sends it again
  assert.equal(RPM.since("u1", ROOM.id, 0).rows.length, 1, "a re-sent final ack adds nothing");
  relay._jobs.delete(id);                                    // JOB_TTL passed
  const late = { id, ok: true, msg: "", ts: pepeTs(), replies: ["(your heist paid out)"], late: true };
  relay.applyAcks([late]);
  relay.applyAcks([late]);
  assert.deepEqual(RPM.since("u1", ROOM.id, 0).rows.map((r) => r.text), ["Your balance: PAT 12,345", "(your heist paid out)"]);
  assert.deepEqual(RPM.since("u2", ROOM.id, 0).rows, []);
});

test("a late reply that beats its command's result (an older Pepe's race) is kept for the command list, not dropped", () => {
  reset();
  const j = relay.newJob({ kind: "cmd", roomId: ROOM.id, userId: "u1", username: "alicep", camfrog: "alicecf", text: "!spin" });
  relay.applyAcks([{ id: j.id, ok: true, msg: "", ts: pepeTs(), replies: ["early result"], late: true }]);
  relay.applyAcks([{ id: j.id, ok: true, msg: "done", ts: pepeTs(), replies: ["the ack"] }]);
  const m = relay.mineFor("u1", ROOM.id).find((x) => x.id === j.id);
  assert.deepEqual(m.replies, ["the ack", "early result"]);
});

test("bounds: 20 a pad, 24 hours, 800 characters, 30 a minute, at most MAX_KEYS pairs", () => {
  reset();
  let t = Date.now();
  RPM._setClock(() => t);
  try {
    for (let i = 0; i < 25; i++) { RPM.addLocal("u1", ROOM.id, "line " + i, "!help"); t += 2500; }
    const s = RPM.since("u1", ROOM.id, 0);
    assert.equal(s.rows.length, RPM.KEEP);
    assert.equal(s.rows[0].text, "line 5", "the newest 20 kept");
    // rate: 30 a minute per account per pad
    RPM._reset(); t += 120e3;
    let n = 0;
    for (let i = 0; i < 40; i++) n += RPM.addLocal("u1", ROOM.id, "burst " + i, "!help");
    assert.equal(n, RPM.RATE);
    t += 61e3;
    assert.equal(RPM.addLocal("u1", ROOM.id, "after a minute", "!help"), 1);
    // 800 characters (code points)
    RPM._reset();
    RPM.addLocal("u1", ROOM.id, "😀".repeat(900), "!help");
    assert.equal(Array.from(RPM.since("u1", ROOM.id, 0).rows[0].text).length, RPM.TEXT_MAX);
    // control / bidi characters go; an empty answer is no row
    RPM.addLocal("u1", ROOM.id, "a‮b\u0007c", "!help");
    assert.equal(RPM.since("u1", ROOM.id, 0).rows[1].text, "a b c");
    assert.equal(RPM.addLocal("u1", ROOM.id, "  \u0000 ", "!help"), 0);
    // 24 hours
    t += RPM.TTL + 1000;
    assert.deepEqual(RPM.since("u1", ROOM.id, 0).rows, [], "older than a day: gone from the answer");
    RPM._sweep();
    assert.equal(RPM.state().rows, 0, "and from memory");
    // MAX_KEYS: the oldest pairs go first
    for (let i = 0; i <= RPM.MAX_KEYS; i++) RPM.addLocal("acct" + i, ROOM.id, "x", "!help");
    assert.equal(RPM.state().keys, RPM.MAX_KEYS);
    assert.deepEqual(RPM.since("acct0", ROOM.id, 0).rows, [], "the oldest pair was dropped");
    assert.equal(RPM.since("acct" + RPM.MAX_KEYS, ROOM.id, 0).rows.length, 1);
  } finally { RPM._setClock(null); RPM._reset(); }
});

test("the account's waiting long-poll wakes on a new private row; another viewer's doesn't", async () => {
  reset();
  const id = await cmd("u1", "!spin");
  const a0 = await live("u1", "?rpm=0"), b0 = await live("u2", "?rpm=0");
  const q = (d) => `?after=${d.cursor}&wait=1&v=${d.ver}&mv=${d.mver}&rpm=${d.rpm.v}&rs=${d.rs}`;
  const ac = new AbortController();
  let bobDone = false;
  const bob = live("u2", q(b0), SLUG, { signal: ac.signal }).then(() => { bobDone = true; }, () => {});
  const t0 = Date.now();
  const alice = live("u1", q(a0));
  await new Promise((r) => setTimeout(r, 100));
  await ack([{ id, ok: true, msg: "", ts: pepeTs(), replies: ["You won PAT 100"], late: true }]);
  const a1 = await alice;
  assert.ok(Date.now() - t0 < 5000, "answered at once, not after the 20 s long-poll");
  assert.deepEqual(a1.rpm.rows.map((r) => r.text), ["You won PAT 100"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bobDone, false, "another viewer's long-poll is still waiting (it learned nothing)");
  ac.abort();
  await bob;
});

test("the private text never reaches the pad's feed, any database table, or the command log", async () => {
  reset();
  const id = await cmd("u1", "!balance -p");
  await ack([{ id, ok: true, msg: "answered privately", ts: pepeTs(), replies: ["balance " + SECRET] }]);
  await ack([{ id, ok: true, msg: "", ts: pepeTs(), replies: ["late " + SECRET], late: true }]);
  assert.equal(RPM.since("u1", ROOM.id, 0).rows.length, 2);
  await new Promise((r) => setTimeout(r, 200));              // the command log's write is async
  const R = bridge._rooms.get(ROOM.id);
  assert.doesNotMatch(JSON.stringify(R.feed || []), new RegExp(SECRET), "not a line of the pad's feed");
  const tables = await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'");
  assert.ok(tables.length > 0);
  for (const { name } of tables) {
    const rows = await getQuery(`SELECT * FROM "${name.replace(/"/g, '""')}"`).catch(() => []);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET), `not in table ${name}`);
  }
  const log = await getQuery("SELECT result FROM bridge_cmd_log WHERE job = ?", [id]);
  assert.equal(log[0].result, "answered privately");
});

test("the site's own !commands answer is a private row too; the composer still gets it", async () => {
  reset();
  relay._hits.clear();
  const r = await say("u1", "!commands");
  assert.equal(r.status, 200);
  assert.ok(r.d.local && /private answers show in this chat, only to you/.test(r.d.reply));
  const rows = RPM.since("u1", ROOM.id, 0).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cmd, "!commands");
  assert.equal(rows[0].text, r.d.reply);
  assert.deepEqual(RPM.since("u2", ROOM.id, 0).rows, []);
});

test("the switch: off = {on: 0} and every kept row cleared; admins only; on again", async () => {
  reset();
  RPM.addLocal("u1", ROOM.id, "kept " + SECRET, "!help");
  assert.equal((await fetch(base + "/api/admin/roompm", { headers: H("u1") })).status, 403, "not for members");
  const g = await (await fetch(base + "/api/admin/roompm", { headers: H("u9") })).json();
  assert.equal(g.state.on, true, "on by default (no row)");
  let p = await fetch(base + "/api/admin/roompm", { method: "POST", headers: Object.assign(H("u9"), { origin: base }), body: JSON.stringify({ on: false }) });
  assert.equal(p.status, 200, await p.clone().text());
  assert.equal(RPM.on(), false);
  assert.equal(RPM.state().rows, 0, "cleared");
  assert.deepEqual((await live("u1", "?rpm=0")).rpm, { on: 0 });
  const id = await cmd("u1", "!balance -p");
  await ack([{ id, ok: true, msg: "answered privately", ts: pepeTs(), replies: ["while off"] }]);
  assert.equal(RPM.state().rows, 0, "no rows while off");
  const audit = await getQuery("SELECT action, detail FROM admin_audit WHERE action = 'roompm.switch'");
  assert.equal(audit.length, 1);
  p = await fetch(base + "/api/admin/roompm", { method: "POST", headers: Object.assign(H("u9"), { origin: base }), body: JSON.stringify({ on: true }) });
  assert.equal(p.status, 200);
  assert.equal(RPM.on(), true);
  assert.equal((await live("u1", "?rpm=0")).rpm.on, 1);
});

test("forgetting an account (deletion) drops its rows everywhere; the wiring", () => {
  reset();
  RPM.addLocal("u1", ROOM.id, "a", "!help");
  RPM.addLocal("u1", ROOM2.id, "b", "!help");
  RPM.addLocal("u2", ROOM.id, "c", "!help");
  RPM.noteJob({ id: "wjob1", kind: "cmd", userId: "u1", roomId: ROOM.id, text: "!spin" });
  assert.equal(RPM.forgetUser("u1"), 2);
  assert.deepEqual(RPM.since("u1", ROOM.id, 0).rows, []);
  assert.deepEqual(RPM.since("u1", ROOM2.id, 0).rows, []);
  assert.equal(RPM.since("u2", ROOM.id, 0).rows.length, 1);
  assert.equal(RPM._origins.has("wjob1"), false);
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /require\("\.\/roompm"\)\.forgetUser\(uid\)/);
  const br = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.match(br, /program: true, rpm: 0 \}\)/, "the pad page's first render carries the viewer's rows (a reload shows them)");
  assert.match(br, /initial\.rpm\.rows\.length\) res\.set\("Cache-Control", "private, no-store"\)/, "and is never kept by a cache then");
});

test("liveView: the rpm block only with opts.rpm and a signed-in viewer", async () => {
  reset();
  RPM.addLocal("u1", ROOM.id, "hi", "!help");
  const R = bridge._rooms.get(ROOM.id);
  const v = await bridge.liveView(R, 0, "u1", "alicecf", "alicep", true, { viewer: { userId: "u1" }, program: true, rpm: 0 });
  assert.equal(v.rpm.rows.length, 1);
  const w = await bridge.liveView(R, 0, "u1", "alicecf", "alicep", true, { viewer: { userId: "u1" } });
  assert.equal(w.rpm, undefined);
  const x = await bridge.liveView(R, 0, null, null, null, true, { viewer: null, rpm: 0 });
  assert.equal(x.rpm, undefined);
});
