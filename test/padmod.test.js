// Offline tests for the pad page's Manage panel (padmod.js, 1.99co): capability gating (Pepe's caps for the
// viewer's linked Camfrog login - a non-mod sees nothing, a mod only the actions Pepe listed), the
// structured action -> command line mapping (no injection: fixed command per action, checked login,
// clamped numbers, free text without leading "/" "!" or trailing "-flags"), the jobs Pepe gets (gui /
// reason / setting tags), refusals passed through, the room's web-commands switch, the settings step-up,
// and that a panel !topic is the same paid command as typing it.
//   NODE_PATH=G:/PATV/node_modules node --test test/padmod.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padmod-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const pm = require(path.join(repo, "padmod"));

const ROOM = "PepeBeta.Room";
const ADMIN_CAPS = { actions: Object.keys(pm.ACTIONS).filter((a) => a !== "topic"), on: true, topic_price: 0, roles: ["admin"], admin: true,
  settings: { chatty: false, chattydepth: "normal", greeter: true } };
const STAFF_CAPS = { actions: ["djban", "djunban", "casinoban", "nuke"], on: true, topic_price: 1000, roles: ["staff", "redlist"] };

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, avatar TEXT)`);
  const hash = await bcrypt.hash("right-pass", 4);
  for (const [id, name, cf, cls] of [["uA", "boss", "BossAdmin", "pleb"], ["uS", "stevie", "stevie", "pleb"], ["uN", "alice", "alice", "Admin"],
    ["uU", "nolink", null, "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?, ?)", [id, name, name, hash, cls, cf]);
  }
  await new Promise((r) => setTimeout(r, 150));                 // bridge tables / bridge_cmd_log are created on load
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); };
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await snapshot({ bossadmin: ADMIN_CAPS, stevie: STAFF_CAPS, "bad name!": ADMIN_CAPS, ghost: { actions: ["nuke"] } });
});
test.after(() => server.close());

function snapshot(mod, extra = {}) {
  return fetch(base + "/api/bridge/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", events: [], acks: extra.acks || [],
      rooms: [Object.assign({ room: { id: ROOM, name: "PepeBeta" }, topic: "old topic", members: [{ login: "bob", display: "Bob" }], count: 2,
        relay: true, cmds: { "!topic": 1000, "!kick": 0 }, mod }, extra.room || {})] }) }).then((r) => r.json());
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, u, body, headers) {
  const r = await fetch(base + p, { method: "POST", headers: headers || H(u), body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
}
async function live(u) { const r = await fetch(base + "/api/rooms/pepebeta/live", { headers: { "x-test-user": u } }); return r.json(); }
const act = (u, body) => { relay._hits.clear(); return post("/api/rooms/pepebeta/mod", u, body); };
const jobsNow = () => relay.takeJobs(new Set([ROOM]));

// ── the mapping (pure) ──
test("each action builds exactly its command", () => {
  const L = (a, t, x) => pm.buildModLine(a, t, x).line;
  assert.equal(L("kick", "bob"), "!kick bob");
  assert.equal(L("ban", "@Bob_1.x"), "!ban Bob_1.x");
  for (const a of ["unban", "punish", "unpunish", "blockmic", "unblockmic", "casinoban", "casinounban", "djban", "djunban", "strike"]) {
    assert.equal(L(a, "bob"), pm.ACTIONS[a] + " bob", a);
  }
  assert.equal(L("strike_appeal", "bob"), "!strike appeal bob");
  assert.equal(L("timeout", "bob", { hours: 6 }), "!timeout bob 6");
  assert.equal(L("timeout", "bob", { hours: "720" }), "!timeout bob 720");
  assert.equal(L("fine", "bob", { amount: 25000, reason: "spamming the wheel" }), "!fine bob 25000 spamming the wheel");
  assert.equal(L("fine", "bob", { amount: "1000" }), "!fine bob 1000");
  assert.equal(L("topic", "", { text: "  frogs   rule  " }), "!topic frogs rule");
});

test("no injection through targets, numbers or free text", () => {
  const E = (a, t, x) => pm.buildModLine(a, t, x);
  for (const t of ["bob -all", "-all", "!kick", "/kick", "bob\n!ban carl", "bob;rm", "", null, "a".repeat(41), "bob carl", "<b>bob</b>", { x: 1 }]) {
    assert.ok(E("kick", t).error, "target " + JSON.stringify(t) + " refused");
  }
  for (const h of [0, 721, -1, 1.5, "6h", "1e2", null, "24 -all"]) assert.ok(E("timeout", "bob", { hours: h }).error, "hours " + h);
  for (const n of [0, -5, 1.5, "1e9", "abc", 1e9 + 1, "100 -all"]) assert.ok(E("fine", "bob", { amount: n }).error, "amount " + n);
  assert.ok(E("nuke", "bob").error && E("__proto__", "bob").error && E("toString", "bob").error, "unknown actions");
  // trailing flags Pepe's dispatcher would lift off the END of a line are stripped from free text
  assert.equal(E("topic", "", { text: "hello -all" }).line, "!topic hello");
  assert.equal(E("topic", "", { text: "hello -mic -v ksox4" }).line, "!topic hello");
  assert.equal(E("topic", "", { text: "hi -global -p" }).line, "!topic hi");
  assert.equal(E("topic", "", { text: "a - b" }).line, "!topic a - b", "a dash in the middle is fine");
  assert.equal(E("topic", "", { text: "/topic sneaky" }).line, "!topic topic sneaky", "no leading slash");
  assert.equal(E("topic", "", { text: "!kick bob" }).line, "!topic kick bob", "no second command");
  assert.equal(E("topic", "", { text: "line one\n/kick bob" }).line, "!topic line one /kick bob", "one line");
  assert.equal(E("topic", "", { text: "<font color=red>hi</font>" }).line, "!topic hi", "no Camfrog markup");
  assert.ok(E("topic", "", { text: "-all" }).error, "a topic that is only a flag is empty");
  assert.equal(E("topic", "", { text: "x".repeat(500) }).line.length, "!topic ".length + pm.TOPIC_MAX, "capped like Camfrog / Pepe");
  assert.equal(E("fine", "bob", { amount: 5, reason: "rude -p" }).line, "!fine bob 5 rude");
  assert.equal(E("fine", "bob", { amount: 5, reason: "-all" }).line, "!fine bob 5");
});

test("Pepe's caps are cleaned: unknown actions, malformed logins and junk dropped", () => {
  const c = pm.cleanModCaps({ BossAdmin: ADMIN_CAPS, "bad name!": ADMIN_CAPS, ghost: { actions: ["nuke"] }, x: "junk", stevie: STAFF_CAPS });
  assert.deepEqual(Object.keys(c).sort(), ["bossadmin", "stevie"]);
  assert.deepEqual(c.stevie.actions, ["djban", "djunban", "casinoban"]);
  assert.equal(c.stevie.topicPrice, 1000);
  assert.ok(!c.stevie.admin && !c.stevie.settings);
  assert.equal(c.bossadmin.admin, true);
  assert.deepEqual(c.bossadmin.settings, { chatty: false, greeter: true, chattydepth: "normal" });
  assert.deepEqual(pm.cleanModCaps(null), {});
  assert.deepEqual(pm.cleanModCaps([1, 2]), {});
});

// ── gating ──
test("a non-mod (even a site admin) gets mod: null; a mod gets only Pepe's actions", async () => {
  assert.equal((await live("uN")).mod, null, "site Admin class grants nothing");
  assert.equal((await live("uU")).mod, null, "unlinked: nothing");
  const s = await live("uS");
  assert.deepEqual(s.mod.actions, ["djban", "djunban", "casinoban"]);
  assert.equal(s.mod.topicPrice, 1000);
  assert.ok(!s.mod.admin);
  const a = await live("uA");
  assert.equal(a.mod.admin, true);
  assert.equal(a.mod.login, "bossadmin");
});

test("the sync response tells Pepe which linked logins are watching the pad", async () => {
  await live("uA"); await live("uN"); await live("uU");
  const r = await snapshot({ bossadmin: ADMIN_CAPS, stevie: STAFF_CAPS });
  assert.ok(r.viewers && Array.isArray(r.viewers[ROOM]));
  assert.deepEqual([...r.viewers[ROOM]].sort(), ["alice", "bossadmin", "stevie"], "linked viewers only (no unlinked account)");
});

test("panel requests: non-mods and actions Pepe didn't list are refused", async () => {
  let r = await act("uN", { action: "kick", target: "bob" });
  assert.equal(r.status, 403); assert.match(r.d.error, /moderator powers/);
  r = await act("uU", { action: "kick", target: "bob" });
  assert.equal(r.status, 403); assert.match(r.d.error, /Link your Camfrog/);
  r = await act("uS", { action: "kick", target: "bob" });
  assert.equal(r.status, 403, "staff can't kick (not in their caps)");
  r = await act(null, { action: "kick", target: "bob" });
  assert.equal(r.status, 401);
  r = await post("/api/rooms/pepebeta/mod", "uA", { action: "kick", target: "bob" }, { "content-type": "application/json", "x-test-user": "uA" });
  assert.equal(r.status, 400, "no X-Requested-With: refused (no cross-site form can send it)");
  r = await post("/api/rooms/pepebeta/mod", "uA", { action: "kick", target: "bob" }, Object.assign(H("uA"), { origin: "https://evil.example" }));
  assert.equal(r.status, 400, "cross-site origin refused");
  r = await act("uA", { action: "kick", target: "bossadmin" });
  assert.equal(r.status, 400, "not yourself");
  assert.equal(jobsNow().length, 0, "nothing queued for any of those");
});

test("a mod's click becomes the exact command job; raw text in the body is ignored", async () => {
  let r = await act("uA", { action: "kick", target: "bob", args: { reason: "slurs in chat -all" }, text: "!update now", line: "!redlist add x" });
  assert.equal(r.status, 200);
  assert.equal(r.d.line, "!kick bob");
  r = await act("uS", { action: "djban", target: "carl" });
  assert.equal(r.status, 200);
  const js = jobsNow();
  const k = js.find((j) => j.gui === "kick"), d = js.find((j) => j.gui === "djban");
  assert.deepEqual({ kind: k.kind, text: k.text, camfrog: k.camfrog, gui: k.gui, reason: k.reason, room: k.room },
    { kind: "cmd", text: "!kick bob", camfrog: "BossAdmin", gui: "kick", reason: "slurs in chat", room: ROOM });
  assert.equal(d.text, "!djban carl"); assert.equal(d.camfrog, "stevie");
  assert.ok(!("reason" in d), "no reason: none sent");
});

test("Pepe's answer (or refusal) comes back to the panel; panel jobs stay out of the relay feed", async () => {
  const ok = await act("uA", { action: "ban", target: "bob" });
  const no = await act("uA", { action: "unban", target: "carl" });
  jobsNow();
  await snapshot({ bossadmin: ADMIN_CAPS, stevie: STAFF_CAPS }, { acks: [
    { id: ok.d.id, ok: true, msg: "@bossadmin 🔨 banned bob.", replies: ["@bossadmin 🔨 banned bob."] },
    { id: no.d.id, ok: false, msg: "you don't have that power in this room" }] });
  let j = await (await fetch(base + "/api/rooms/pepebeta/mod/job/" + ok.d.id, { headers: { "x-test-user": "uA" } })).json();
  assert.equal(j.done, true); assert.equal(j.success, true); assert.deepEqual(j.replies, ["@bossadmin 🔨 banned bob."]);
  j = await (await fetch(base + "/api/rooms/pepebeta/mod/job/" + no.d.id, { headers: { "x-test-user": "uA" } })).json();
  assert.equal(j.success, false); assert.match(j.msg, /don't have that power/);
  const other = await fetch(base + "/api/rooms/pepebeta/mod/job/" + ok.d.id, { headers: { "x-test-user": "uS" } });
  assert.equal(other.status, 404, "only your own jobs");
  assert.equal((await live("uA")).mine.length, 0, "panel jobs don't show in the relay box's feed");
});

test("topic: shown price = the chat price; it's the same paid !topic Pepe runs from chat", async () => {
  const r = await act("uS", { action: "topic", args: { text: "frogs -all" } });
  assert.equal(r.status, 200); assert.equal(r.d.line, "!topic frogs");
  const j = jobsNow().find((x) => x.id === r.d.id);
  assert.equal(j.text, "!topic frogs"); assert.equal(j.gui, "topic");
  const v = await live("uS");
  assert.equal(v.mod.topicPrice, v.room.cmds["!topic"], "the panel's price is the room's !topic price from Pepe");
});

test("the room's web-commands switch: off -> the panel says so and nothing runs", async () => {
  await snapshot({ bossadmin: Object.assign({}, ADMIN_CAPS, { on: false }) });
  const v = await live("uA");
  assert.equal(v.mod.on, false);
  const r = await act("uA", { action: "kick", target: "bob" });
  assert.equal(r.status, 403); assert.equal(r.d.error, "Web moderation is off in this room.");
  assert.equal(jobsNow().length, 0);
  await snapshot({ bossadmin: ADMIN_CAPS, stevie: STAFF_CAPS });
});

test("mod info: a modinfo job for mods only; Pepe's answer is sanitised", async () => {
  relay._hits.clear();
  let r = await post("/api/rooms/pepebeta/mod/info", "uN", { target: "bob" });
  assert.equal(r.status, 403);
  r = await post("/api/rooms/pepebeta/mod/info", "uA", { target: "bob -all" });
  assert.equal(r.status, 400);
  r = await post("/api/rooms/pepebeta/mod/info", "uA", { target: "bob" });
  assert.equal(r.status, 200);
  const j = jobsNow().find((x) => x.id === r.d.id);
  assert.deepEqual({ kind: j.kind, target: j.target, camfrog: j.camfrog }, { kind: "modinfo", target: "bob", camfrog: "BossAdmin" });
  await snapshot({ bossadmin: ADMIN_CAPS }, { acks: [{ id: r.d.id, ok: true, msg: "ok", info: { target: "bob", role: "everyone", strikes: 2, redlist: false,
    history: [{ ts: "2026-10-06T10:00:00<script>", type: "pepe_kick", actor: "bossadmin", details: "\u0007kicked <b>x</b>" }, { type: "evil type!" }] } }] });
  const k = await (await fetch(base + "/api/rooms/pepebeta/mod/job/" + r.d.id, { headers: { "x-test-user": "uA" } })).json();
  assert.equal(k.info.strikes, 2);
  assert.equal(k.info.history[0].ts, "2026-10-06T10:00:00");
  assert.equal(k.info.history[1].type, "event");
});

test("room settings: Pepe admins only, password every time, exact lines", async () => {
  relay._hits.clear();
  let r = await post("/api/rooms/pepebeta/mod/setting", "uS", { key: "chatty", value: "on", password: "right-pass" });
  assert.equal(r.status, 403, "staff: no");
  r = await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "chatty", value: "on -all", password: "right-pass" });
  assert.equal(r.status, 400);
  r = await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "automod", value: "clear", password: "right-pass" });
  assert.equal(r.status, 400);
  r = await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "chatty", value: "on", password: "wrong" });
  assert.equal(r.status, 403); assert.equal(r.d.error, "Wrong password.");
  assert.equal(jobsNow().length, 0);
  r = await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "chattydepth", value: "long", password: "right-pass" });
  assert.equal(r.status, 200); assert.equal(r.d.line, "!chattydepth long");
  const j = jobsNow().find((x) => x.id === r.d.id);
  assert.deepEqual({ text: j.text, setting: j.setting, gui: j.gui }, { text: "!chattydepth long", setting: "chattydepth", gui: undefined });
  for (let i = 0; i < 5; i++) await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "greeter", value: "off", password: "nope" });
  r = await post("/api/rooms/pepebeta/mod/setting", "uA", { key: "greeter", value: "off", password: "right-pass" });
  assert.equal(r.status, 429, "locked out after 5 wrong passwords");
  pm._pwFails.reset("uA");
});

test("the client JS + page wiring are in place (cache-busted)", () => {
  const page = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(page, /room-mod\.js\?v=\d+/);
  assert.match(page, /room-mod\.css\?v=\d+/);
  assert.match(page, /id="rmMod" hidden/, "the panel starts hidden: shown only when Pepe sends caps");
  const js = fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML/, "everything user-visible via textContent");
  assert.doesNotMatch(js, /\/say'/, "the panel never sends raw command text");
});
