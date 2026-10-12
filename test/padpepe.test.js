// Offline tests for the pad page's 🐸 Pepe submenu (padpepe.js + public/js/pad-pepe.js + room-mod.js, 1.99qr): Pepe's
// snapshot menu ({look|camroast|roast: {on, price, why}}) reaches the live view only while web commands are on; a click is
// a structured {action, target} that becomes ONE exact line queued as a relay "cmd" job tagged `pepe` (Pepe re-checks it);
// the target must be in the room and, for look / camroast, on cam; the relay box's per-account rate limit applies; the
// menu items show prices and grey out closed cams / switched-off actions.
//   NODE_PATH=G:/PATV/node_modules node --test test/padpepe.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padpepe-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const pp = require(path.join(repo, "padpepe"));

const ROOM = "PepeBeta.Room";
const MENU = { look: { on: true, price: 10000 }, camroast: { on: true, price: 15000 }, roast: { on: false, price: 5000, why: "switched off here" }, bogus: { on: true } };
let base, server;

function snapshot(extra = {}) {
  return fetch(base + "/api/bridge/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", events: [], acks: extra.acks || [],
      rooms: [Object.assign({ room: { id: ROOM, name: "PepeBeta" }, topic: "t", count: 3, relay: true,
        members: [{ login: "bob", display: "Bob", on_cam: true }, { login: "carol", display: "Carol", on_cam: false }, { login: "pepebeta", is_self: true }],
        cmds: { "!look": 10000, "!camroast": 15000, "!roast": 5000, "!topic": 1000 }, pepe: MENU }, extra.room || {})] }) }).then((r) => r.json());
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(u, body) {
  relay._hits.clear();
  const r = await fetch(base + "/api/rooms/pepebeta/pepe", { method: "POST", headers: H(u), body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
}
const jobsNow = () => relay.takeJobs(new Set([ROOM]));

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  for (const [id, name, cf] of [["uA", "alice", "alice"], ["uN", "nolink", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cf]);
  }
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); };
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await snapshot();
});
test.after(() => server.close());

test("the snapshot menu is cleaned and shown in the live view while commands are on", async () => {
  assert.deepEqual(pp.cleanMenu(MENU), { look: { on: true, price: 10000 }, camroast: { on: true, price: 15000 }, roast: { on: false, price: 5000, why: "switched off here" } });
  let d = await (await fetch(base + "/api/rooms/pepebeta/live", { headers: { "x-test-user": "uA" } })).json();
  assert.equal(d.room.pepe.look.price, 10000);
  await snapshot({ room: { cmds: {} } });
  d = await (await fetch(base + "/api/rooms/pepebeta/live", { headers: { "x-test-user": "uA" } })).json();
  assert.equal(d.room.pepe, null, "no web commands -> no menu");
  await snapshot();
});

test("lines are built from the action table only", () => {
  assert.equal(pp.buildLine("look", "@Bob").line, "!look Bob");
  assert.equal(pp.buildLine("camroast", "bob").line, "!camroast bob");
  assert.ok(pp.buildLine("nuke", "bob").error);
  for (const bad of ["-mic", "!kick", "bob -p", "", "a b", "/topic"]) assert.ok(pp.buildLine("look", bad).error, bad);
});

test("a look on an open cam queues one tagged cmd job; Pepe gets the pepe tag", async () => {
  jobsNow();
  const r = await post("uA", { action: "look", target: "bob" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.line, "!look bob");
  assert.equal(r.d.price, 10000);
  const js = jobsNow();
  assert.equal(js.length, 1);
  assert.deepEqual([js[0].kind, js[0].text, js[0].pepe, js[0].camfrog], ["cmd", "!look bob", "look", "alice"]);
  // the job reads back (and only for its owner)
  const own = await (await fetch(base + "/api/rooms/pepebeta/pepe/job/" + r.d.id, { headers: { "x-test-user": "uA" } })).json();
  assert.equal(own.ok, true);
  assert.equal(own.line, "!look bob");
  const other = await fetch(base + "/api/rooms/pepebeta/pepe/job/" + r.d.id, { headers: { "x-test-user": "uN" } });
  assert.equal(other.status, 404);
  // Pepe's late public answer lands in the job's replies
  await snapshot({ acks: [{ id: r.d.id, ok: true, msg: "" }] });
  await snapshot({ acks: [{ id: r.d.id, ok: true, msg: "", replies: ["@Bob nice lamp"], late: true }] });
  const done = await (await fetch(base + "/api/rooms/pepebeta/pepe/job/" + r.d.id, { headers: { "x-test-user": "uA" } })).json();
  assert.deepEqual(done.replies, ["@Bob nice lamp"]);
  // a menu job doesn't show in the relay box's own list
  assert.equal(relay.mineFor("uA", ROOM).filter((m) => m.id === r.d.id).length, 0);
});

test("refusals: closed cam, not in the room, switched off, unlinked, signed out, Pepe himself, rate limit", async () => {
  jobsNow();
  let r = await post("uA", { action: "look", target: "carol" });
  assert.equal(r.status, 409); assert.match(r.d.error, /cam isn't open/);
  r = await post("uA", { action: "camroast", target: "carol" });
  assert.equal(r.status, 409);
  r = await post("uA", { action: "look", target: "dave" });
  assert.equal(r.status, 404);
  r = await post("uA", { action: "roast", target: "carol" });
  assert.equal(r.status, 403); assert.match(r.d.error, /switched off/);
  r = await post("uA", { action: "look", target: "pepebeta" });
  assert.equal(r.status, 400);
  r = await post("uN", { action: "look", target: "bob" });
  assert.equal(r.status, 403); assert.match(r.d.error, /Link your Camfrog/);
  r = await post(null, { action: "look", target: "bob" });
  assert.equal(r.status, 401);
  const bad = await fetch(base + "/api/rooms/pepebeta/pepe", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "uA" }, body: "{}" });
  assert.equal(bad.status, 400, "no X-Requested-With -> refused");
  assert.equal(jobsNow().length, 0, "nothing queued by any refusal");
  // the relay box's per-account limit is shared
  relay._hits.clear();
  const first = await fetch(base + "/api/rooms/pepebeta/pepe", { method: "POST", headers: H("uA"), body: JSON.stringify({ action: "look", target: "bob" }) });
  const second = await fetch(base + "/api/rooms/pepebeta/pepe", { method: "POST", headers: H("uA"), body: JSON.stringify({ action: "camroast", target: "bob" }) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  jobsNow();
});

function loadClient() {
  const win = { __t: null, PATVRoom: {} };
  const ctx = { window: win, document: { createElement: () => ({}) }, setTimeout, fetch: () => Promise.reject(new Error("no")) };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-pepe.js"), "utf8"), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), ctx);
  return win.PATVRoom;
}

test("client: the submenu items show prices and grey out closed cams / switched-off actions", () => {
  const P = loadClient();
  const J = (x) => JSON.parse(JSON.stringify(x));         // across the vm realm
  const menu = pp.cleanMenu(MENU);
  const on = P.pepe.items(menu, { login: "bob", on_cam: true });
  assert.deepEqual(J(on.map((i) => [i.action, i.price, i.disabled])), [["look", 10000, false], ["camroast", 15000, false], ["roast", 5000, true]]);
  const off = P.pepe.items(menu, { login: "carol", on_cam: false });
  assert.deepEqual(J(off.map((i) => i.disabled)), [true, true, true]);
  assert.match(off[0].note, /cam is closed/);
  assert.equal(P.pepe.items(menu, { login: "pepe", self: true }).length, 0);
  assert.equal(P.pepe.items(null, { login: "bob" }).length, 0);
  // the ⋯ menu offers "🐸 Pepe ▸" to signed-in viewers when Pepe offers the menu here
  const items = P._modMenuItems(null, { login: "bob", on_cam: true }, { signed: true, pepe: menu });
  assert.ok(items.some((i) => i.kind === "pepe"));
  assert.ok(!P._modMenuItems(null, { login: "bob" }, { signed: true, pepe: null }).some((i) => i.kind === "pepe"));
  assert.ok(!P._modMenuItems(null, { login: "bob" }, { signed: false, pepe: menu }).some((i) => i.kind === "pepe"), "signed out: nothing");
});
