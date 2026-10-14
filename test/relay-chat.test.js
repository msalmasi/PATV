// 1.99ye: the native-feeling web chat relay (bridge-relay.js + bridge.js):
//   - a say carries the page's client id: the same cid again answers with the job it made (a retry never posts twice)
//   - several lines in a row are fine, kept in order; at most SAY_QUEUE_MAX waiting per member per room (queue_full)
//   - every refusal has a code (too_long, empty, relay_off, offline, queue_full, rate) and Pepe's acks / timeouts give one too
//   - a say is offered to Pepe ONCE (never re-offered after a lost ack - "unconfirmed" instead)
//   - Pepe's long-poll (POST /api/bridge/relay/pull) answers the moment a line is queued; /api/bridge/relay/ack applies at once
//   - the room's echo (data.web.job) settles the job and gives the page the feed cursor to swap its pending line for
//   - the pad page's long-poll (/live?wait=1) answers as soon as the viewer's job moves or a line arrives
//   node --test test/relay-chat.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-chat-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));

const ROOM = { id: "Chat.Room", name: "Chat Room" };
const SLUG = "chat-room";
let base, server, seq = 0;
const snap = (extra) => Object.assign({ room: ROOM, topic: "", members: [{ login: "alicecf", display: "Alice" }], count: 2, relay: true }, extra);
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const bot = (p, body) => post(p, null, Object.assign({ password: "bot-token" }, body));
const sync = (body) => bot("/api/bridge/sync", Object.assign({ events: [], rooms: [snap()] }, body));
const say = (u, text, cid) => post("/api/rooms/" + SLUG + "/say", u, cid ? { text, cid } : { text });
const live = (u, q = "") => fetch(base + "/api/rooms/" + SLUG + "/live" + q, { headers: H(u) }).then((r) => r.json());
const sayJobs = (cid) => [...relay._jobs.values()].filter((j) => j.kind === "say" && (!cid || j.cid === cid));
function reset() {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
}
const echo = (jobId, text) => ({ op: "event", id: "e-" + (++seq), ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room: ROOM },
  data: { user: { id: "pepefrog", login: "pepefrog", is_self: true }, text: "🌐 Alice (web): " + text, self: true,
          web: { user: { id: "alicecf", login: "alicecf", display: "Alice" }, text, job: jobId } } });

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT,
                  avatar TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, avatar) VALUES ('u1', 'alicep', 'Alice P', 'x', 'alicecf', '/public/img/a.png')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u2', 'bobp', 'Bob', 'x', 'bobcf')");
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u === "u1" ? "alicep" : "bobp" } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await sync();
});
test.after(() => server && server.close());

test("idempotent: the same client id answers with the job it made - a retry never posts twice", async () => {
  reset();
  const a = await say("u1", "hello room", "cAAAAAAAA1");
  assert.equal(a.status, 200, JSON.stringify(a.d));
  assert.equal(a.d.cid, "cAAAAAAAA1");
  const b = await say("u1", "hello room", "cAAAAAAAA1");
  assert.equal(b.status, 200);
  assert.equal(b.d.id, a.d.id, "same job");
  assert.equal(b.d.dup, true);
  assert.equal(sayJobs("cAAAAAAAA1").length, 1, "one job");
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "say");
  assert.equal(offered.length, 1, "Pepe gets it once");
  assert.equal(offered[0].cid, "cAAAAAAAA1", "with the client id");
  const c = await say("u1", "hello room", "cAAAAAAAA1");
  assert.equal(c.d.id, a.d.id, "still the same job after Pepe took it");
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "say").length, 0, "and never re-offered");
  // another member's identical cid is their own line
  const d = await say("u2", "hello room", "cAAAAAAAA1");
  assert.notEqual(d.d.id, a.d.id);
});

test("several lines in a row, in order; the 6th waiting one is refused (queue_full); a done one frees a place", async () => {
  reset();
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const r = await say("u1", "line " + i, "cORDER000" + i);
    assert.equal(r.status, 200, "line " + i + " " + JSON.stringify(r.d));
    ids.push(r.d.id);
  }
  const six = await say("u1", "line 6", "cORDER0006");
  assert.equal(six.status, 429);
  assert.equal(six.d.code, "queue_full");
  assert.equal(six.d.max, relay.SAY_QUEUE_MAX);
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "say");
  assert.deepEqual(offered.map((j) => j.text), ["line 1", "line 2", "line 3", "line 4", "line 5"], "in the order they were typed");
  relay.applyAcks([{ id: ids[0], ok: true, msg: "sent" }]);
  const again = await say("u1", "line 6", "cORDER0006");
  assert.equal(again.status, 200, "a place is free again");
  // another member isn't affected by alice's queue
  assert.equal((await say("u2", "me too", "cOTHER0001")).status, 200);
});

test("refusals carry a code: too_long, empty, rate, relay_off, offline", async () => {
  reset();
  const long = await say("u1", "x".repeat(relay.SAY_MAX + 1), "cLONG00001");
  assert.equal(long.status, 400);
  assert.equal(long.d.code, "too_long");
  assert.equal(long.d.max, relay.SAY_MAX);
  assert.equal((await say("u1", "x".repeat(relay.SAY_MAX), "cLONG00002")).status, 200, "exactly the limit is fine");
  const empty = await say("u1", "   ", "cEMPTY0001");
  assert.equal(empty.d.code, "empty");
  // the sanity cap: SAY_MINUTE_MAX a minute (lines that went out don't count against the queue)
  reset();
  let last;
  for (let i = 0; i <= relay.SAY_MINUTE_MAX; i++) {
    last = await say("u2", "spam " + i, "cRATE" + String(i).padStart(5, "0"));
    for (const j of sayJobs()) if (j.state !== "done") relay.applyAcks([{ id: j.id, ok: true, msg: "sent" }]);
  }
  assert.equal(last.status, 429);
  assert.equal(last.d.code, "rate");
  // relay switched off in the room
  await sync({ rooms: [snap({ relay: false })] });
  const off = await say("u1", "hi", "cOFF000001");
  assert.equal(off.status, 403);
  assert.equal(off.d.code, "relay_off");
  await sync();
  // no such live room
  const r = await post("/api/rooms/no-such-pad/say", "u1", { text: "hi", cid: "cGONE00001" });
  assert.equal(r.status, 404);
  assert.equal(r.d.code, "offline");
  // a pad without the 💎 bridge perk (Prime Time Plus gate) says so, before anything else
  const g = relay.roomRefusal({ id: "x", relay: true }, "relay", () => true, () => true);
  assert.equal(g.status, 403);
  assert.equal(g.body.code, "gated");
  assert.match(g.body.error, /Prime Time Plus/);
});

test("Pepe's answers and the timeouts: refused (with his code), never picked up (nopepe), picked up but unconfirmed", async () => {
  reset();
  const a = await say("u1", "refused one", "cPEPE00001");
  relay.takeJobs(new Set([ROOM.id]));
  relay.applyAcks([{ id: a.d.id, ok: false, msg: "you were moderated in this room recently", code: "moderated" }]);
  let m = (await live("u1")).mine.find((x) => x.cid === "cPEPE00001");
  assert.equal(m.state, "done");
  assert.equal(m.ok, false);
  assert.equal(m.code, "moderated");
  assert.match(m.msg, /moderated/);
  const b = await say("u1", "nobody home", "cPEPE00002");
  relay._sweep(Date.now() + relay.SAY_PENDING_TTL + 1000);
  m = (await live("u1")).mine.find((x) => x.cid === "cPEPE00002");
  assert.equal(m.state, "pending", "1.99yg: no long-polling Pepe -> his 30 s sync gets SAY_PENDING_TTL_SYNC");
  await bot("/api/bridge/relay/pull", { wait: 0 });               // a long-polling Pepe now (it takes that line)
  const b2 = await say("u1", "nobody home again", "cPEPE00022");
  relay._sweep(Date.now() + relay.SAY_PENDING_TTL + 1000);
  m = (await live("u1")).mine.find((x) => x.cid === "cPEPE00022");
  assert.equal(m.ok, false);
  assert.equal(m.code, "nopepe");
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((j) => j.id === b2.d.id).length, 0, "a timed-out line is never sent later");
  assert.ok(b.d.id);
  const c = await say("u1", "lost ack", "cPEPE00003");
  relay.takeJobs(new Set([ROOM.id]));
  relay._sweep(Date.now() + relay.SAY_CLAIM_TTL + 1000);
  m = (await live("u1")).mine.find((x) => x.cid === "cPEPE00003");
  assert.equal(m.code, "unconfirmed");
  relay.applyAcks([{ id: c.d.id, ok: true, msg: "sent" }]);
  m = (await live("u1")).mine.find((x) => x.cid === "cPEPE00003");
  assert.equal(m.code, "unconfirmed", "a late ack doesn't flip a settled line");
});

test("Pepe's long-poll answers the moment a line is queued; acks apply at once; the echo settles it with the feed cursor", async () => {
  reset();
  assert.equal((await bot("/api/bridge/relay/pull", { password: "nope", wait: 1 })).status, 403);
  const t0 = Date.now();
  const pull = bot("/api/bridge/relay/pull", { wait: 8 });
  await new Promise((r) => setTimeout(r, 200));
  const s = await say("u1", "fast one", "cFAST00001");
  const p = await pull;
  const dt = Date.now() - t0;
  assert.equal(p.status, 200);
  assert.deepEqual(p.d.jobs.map((j) => j.id), [s.d.id], "the line, right away");
  assert.ok(dt < 2000, "answered at once, not after the wait: " + dt + " ms");
  assert.equal(p.d.jobs[0].cid, "cFAST00001");
  // nothing queued: the pull waits, then answers empty
  const t1 = Date.now();
  const idle = await bot("/api/bridge/relay/pull", { wait: 0.3 });
  assert.deepEqual(idle.d.jobs, []);
  assert.ok(Date.now() - t1 >= 250, "it waited");
  // the ack route
  await bot("/api/bridge/relay/ack", { acks: [{ id: s.d.id, ok: true, msg: "sent", t: { wait: 12, send: 40 } }] });
  let m = (await live("u1")).mine.find((x) => x.cid === "cFAST00001");
  assert.equal(m.state, "done");
  assert.equal(m.ok, true);
  assert.equal(m.c, undefined, "not echoed yet");
  // the room's echo names the job -> c = its feed cursor; the feed shows it as alice's line, once
  const before = (await live("u1")).cursor;
  await sync({ events: [echo(s.d.id, "fast one")] });
  const v = await live("u1", "?after=" + before);
  m = v.mine.find((x) => x.cid === "cFAST00001");
  const line = v.feed.find((x) => x.k === "msg" && x.text === "fast one");
  assert.ok(line && m.c === line.c, "the echo's cursor: " + JSON.stringify(m));
  assert.ok(line.u.web, "shown as the sender's web line");
  assert.ok(!("_job" in line), "the job id stays server-side");
  const lat = relay.latency().pop();
  assert.equal(lat.via, "pull");
  assert.ok(lat.claim >= 0 && lat.ack >= lat.claim && lat.echo >= lat.ack, JSON.stringify(lat));
  assert.deepEqual(lat.pepe, { wait: 12, send: 40 });
  // a second echo of the same job (a re-sent batch with a new event id) doesn't move it
  await sync({ events: [echo(s.d.id, "fast one")] });
  assert.equal((await live("u1")).mine.find((x) => x.cid === "cFAST00001").c, m.c);
});

test("the pad page's long-poll: held while nothing changes, answered when the viewer's line moves on; `me` for pending lines", async () => {
  reset();
  const first = await live("u1");
  assert.ok(first.me && first.me.display === "Alice P" && first.me.patv.username === "alicep" && first.me.web, JSON.stringify(first.me));
  assert.equal(first.me.patv.avatar, "/public/img/a.png");
  const q = "?after=" + first.cursor + "&wait=1&v=" + first.ver + "&mv=" + first.mver;
  const t0 = Date.now();
  const held = live("u1", q);
  let settled = false; held.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(settled, false, "nothing new: still waiting");
  await say("u1", "wake up", "cWAKE00001");
  const d = await held;
  assert.ok(Date.now() - t0 < 3000, "answered right after the say");
  assert.equal(d.lp, true);
  assert.ok(d.mine.some((x) => x.cid === "cWAKE00001"), "with the new line's state");
  assert.ok(!d.me, "`me` only on the first view (or ?me=1)");
  assert.ok((await live("u1", "?after=" + d.cursor + "&me=1")).me, "?me=1 asks for it");
  // a stale version answers at once
  const t1 = Date.now();
  const now = await live("u1", "?after=" + d.cursor + "&wait=1&v=" + (d.ver + 99) + "&mv=" + d.mver);
  assert.ok(Date.now() - t1 < 1500 && now.lp, "a version the page hasn't seen: at once");
  // another viewer's line doesn't wake alice (her versions are unchanged) - but a room line does
  const v2 = await live("u1");
  const q2 = "?after=" + v2.cursor + "&wait=1&v=" + v2.ver + "&mv=" + v2.mver;
  let done2 = false;
  const held2 = live("u1", q2).then((x) => { done2 = true; return x; });
  await say("u2", "bob talks", "cBOB000001");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done2, false, "bob's queued line doesn't answer alice's poll");
  await sync({ events: [{ op: "event", id: "e-" + (++seq), ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room: ROOM },
                         data: { user: { id: "carol", login: "carol", display: "Carol" }, text: "hi from the room" } }], rooms: [] });
  const got = await held2;
  assert.ok(got.feed.some((x) => x.text === "hi from the room"), "a room line answers it");
});
