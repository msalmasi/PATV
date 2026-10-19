// stkfix B2 + B3 on the web relay (bridge-relay.js sayLine, POST /api/rooms/:slug/say):
//   B3 stickers only from packs the member owns - the same rule as DMs, posts and comments (refused with code "sticker")
//   B2 Camfrog can't show PATV art: the line Pepe gets reads "[sticker: Happy Pepe]", never the raw [sticker:pack/id] token -
//      and that line (not the typed one) is what the length limit (SAY_MAX) and the text filter judge
//   B3 "!" command lines too; a failed check is a 503, never an unhandled rejection
//   NODE_PATH=G:/PATV/node_modules node --test test/stkfix-relay.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stkfix-relay-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const STK = require(path.join(repo, "stickers"));
const cap = require(path.join(repo, "actorcap"));

const ROOM = { id: "Chat.Room", name: "Chat Room" };
const SLUG = "chat-room";
let base, server;
const snap = (extra) => Object.assign({ room: ROOM, topic: "", members: [{ login: "alicecf", display: "Alice" }], count: 2, relay: true }, extra);
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const sync = (body) => post("/api/bridge/sync", null, Object.assign({ password: "bot-token", events: [], rooms: [snap()] }, body));
const say = (u, text, cid) => post("/api/rooms/" + SLUG + "/say", u, { text, cid });
const offered = () => relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "say");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT,
                  avatar TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'alicep', 'Alice P', 'x', 'alicecf')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u2', 'bobp', 'Bob', 'x', 'bobcf')");
  // u3: a PATV account with no chat login (verified by Telegram) - its lines go through accountRefusal, the text filter
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u3', 'webcara', 'Cara', 'x', NULL)");
  await runQuery("CREATE TABLE IF NOT EXISTS telegram_links (user_id TEXT PRIMARY KEY, tg_id TEXT NOT NULL UNIQUE, link_source TEXT NOT NULL DEFAULT 'self', linked_at INTEGER)");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id) VALUES ('u3', '7')");
  await STK.init();
  await STK.grantComp("u1", "pixelpepe", "test");
  await STK.grantComp("u3", "pixelpepe", "test");
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: { u1: "alicep", u2: "bobp", u3: "webcara" }[u] } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await sync();
});
test.after(() => server && server.close());

test("B2: an owner's sticker goes to Camfrog as '[sticker: Happy Pepe]' - never the raw token", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  const r = await say("u1", "hi room [sticker:pixelpepe/happy]", "cSTKFIX001");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const jobs = offered();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].text, "hi room [sticker: Happy Pepe]");
  assert.doesNotMatch(jobs[0].text, /\[sticker:[a-z0-9]+\//);
  // a line with no sticker (or a made-up token) is untouched
  assert.equal((await say("u1", "plain [sticker:fake/x]", "cSTKFIX002")).status, 200);
  assert.equal(offered()[0].text, "plain [sticker:fake/x]");
});

test("B3: a sticker from a pack you don't own is refused (code 'sticker'), like in DMs and posts - nothing is queued", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  const r = await say("u2", "look [sticker:pixelpepe/happy]", "cSTKFIX003");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "sticker");
  assert.match(r.d.error, /don't have the Pixel Pepe sticker pack/);
  assert.equal(offered().length, 0);
  const many = await say("u1", "[sticker:pixelpepe/sad]".repeat(STK.MAX_PER_TEXT + 1), "cSTKFIX004");     // 299 characters: under SAY_MAX
  assert.equal(many.status, 400);
  assert.equal(many.d.code, "sticker");
});

test("B2: the length limit judges the line as it goes out - '[sticker: Name]' is longer than the token, and Pepe would cut it short", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  const tok = "[sticker:pixelpepe/lol]";
  const stand = "[sticker: " + STK.CAT.byId.pixelpepe.byId.lol.name + "]";      // "[sticker: Crying laughing]"
  assert.ok(stand.length > tok.length, "the stand-in is longer: " + stand);
  // 300 characters as typed (the composer's limit), more than 300 written out: refused, nothing queued
  const over = tok.repeat(STK.MAX_PER_TEXT) + "x".repeat(relay.SAY_MAX - tok.length * STK.MAX_PER_TEXT);
  assert.equal(over.length, relay.SAY_MAX);
  const r = await say("u1", over, "cSTKFIX005");
  assert.equal(r.status, 400, JSON.stringify(r.d));
  assert.equal(r.d.code, "too_long");
  assert.equal(r.d.max, relay.SAY_MAX);
  assert.match(r.d.error, /stickers are written out/);
  assert.equal(offered().length, 0);
  // exactly SAY_MAX written out still goes, whole
  const n = 10, pad = "y".repeat(relay.SAY_MAX - stand.length * n), fits = tok.repeat(n) + pad;
  const ok = await say("u1", fits, "cSTKFIX006");
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  const job = offered()[0];
  assert.equal(job.text, stand.repeat(n) + pad);
  assert.equal(job.text.length, relay.SAY_MAX);
});

test("B2 / B3: a '!' command line - stickers only from owned packs, and Camfrog gets '[sticker: Name]', never the raw token", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  await sync({ rooms: [snap({ cmds: { "!8ball": 0 } })] });
  const no = await say("u2", "!8ball will it rain [sticker:pixelpepe/happy]");
  assert.equal(no.status, 403, JSON.stringify(no.d));
  assert.equal(no.d.code, "sticker");
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "cmd").length, 0, "nothing queued");
  const yes = await say("u1", "!8ball will it rain [sticker:pixelpepe/happy]");
  assert.equal(yes.status, 200, JSON.stringify(yes.d));
  const cmd = relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "cmd");
  assert.equal(cmd.length, 1);
  assert.equal(cmd[0].text, "!8ball will it rain [sticker: Happy Pepe]");
  await sync();
});

test("B2: the text filter judges the line as it goes out - a sticker NAME it catches is refused (pack names from members, later)", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  cap.note({ actor_cap: 1 });                             // a Pepe that relays for accounts with no chat login
  const ok = await say("u3", "hello [sticker:pixelpepe/happy]", "cSTKFIX007");
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.equal(offered()[0].text, "hello [sticker: Happy Pepe]");
  relay._jobs.clear(); relay._hits.clear();
  const f = path.join(tmp, "evil-names.json");
  fs.writeFileSync(f, JSON.stringify({ packs: [{ id: "pixelpepe", name: "Pixel Pepe", stickers: [{ id: "happy", name: "kys" }] }] }));
  STK._setCatalog(STK.loadCatalog(f));
  try {
    const r = await say("u3", "hello [sticker:pixelpepe/happy]", "cSTKFIX008");
    assert.equal(r.status, 400, JSON.stringify(r.d));
    assert.equal(r.d.code, "account");
    assert.match(r.d.error, /Pepe won't relay that/);
    assert.equal(offered().length, 0);
  } finally { STK._setCatalog(); }
});

test("B3: a failed sticker check (the database busy) answers 503 'busy' - never an unhandled rejection - and queues nothing", async () => {
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  const real = STK.validate;
  STK.validate = async () => { throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }); };
  try {
    const r = await fetch(base + "/api/rooms/" + SLUG + "/say", { method: "POST", headers: H("u1"), signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ text: "hi [sticker:pixelpepe/happy]", cid: "cSTKFIX009" }) });
    assert.equal(r.status, 503);
    const d = await r.json();
    assert.equal(d.code, "busy");
    assert.equal(offered().length, 0);
    // a "!" line too
    await sync({ rooms: [snap({ cmds: { "!8ball": 0 } })] });
    const c = await fetch(base + "/api/rooms/" + SLUG + "/say", { method: "POST", headers: H("u1"), signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ text: "!8ball [sticker:pixelpepe/happy]" }) });
    assert.equal(c.status, 503);
    assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "cmd").length, 0);
  } finally { STK.validate = real; await sync(); }
});
