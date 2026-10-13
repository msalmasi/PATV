// Offline tests for economy v2 E-5, verified watch-minutes (econ.js heartbeats + vwm.js daily rollup), the anti-abuse
// cases of camfrog-bot docs/ECONOMY-V2.md 7.2 / 10:
//   * multiple tabs: one counted session per account; a second tab earns nothing
//   * hidden tabs and paused players earn nothing; muted (volume 0) minutes are counted apart and never paid
//   * alt accounts: the welcome dedupe's dup_of, the 4th+ account on one browser, the 4th+ account on one network (/24)
//   * self-watching streamers: the streamer, a linked account (same Discord), the streamer's own browser / address
//   * the rollup: status 'ok' minus muted, viewer gates (age >= 7 days, level >= 2, verified), 120 per viewer per streamer
//     per day ACROSS pads, a gone streamer dropped, a closed day frozen; the bot endpoint needs the bot token
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-vwm.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-vwm-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const econ = require(path.join(repo, "econ"));
const welcome = require(path.join(repo, "welcome"));
const vwm = require(path.join(repo, "vwm"));

const DAY = 86400000;
let now = Date.UTC(2026, 9, 20, 12, 0, 0);
const TODAY = "2026-10-20";
const old = new Date(now - 60 * DAY).toISOString().replace("T", " ").slice(0, 19);
const young = new Date(now - 2 * DAY).toISOString().replace("T", " ").slice(0, 19);
let base, server;

async function mkUser(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, class, level, created_at, isEmailVerified, discordId, twitchId) VALUES (?, ?, 'pleb', ?, ?, ?, ?, NULL)`,
                 [id, id, o.level != null ? o.level : 5, o.created || old, o.verified != null ? o.verified : 1, o.discord || null]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, class TEXT DEFAULT 'pleb', camfrogUsername TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP, isEmailVerified INTEGER DEFAULT 0, discordId TEXT, twitchId TEXT)`);
  for (const id of ["st", "st2", "link", "dupe", "near", "nearip", "a1", "a2", "a3", "a4", "n1", "n2", "n3", "n4", "tabs", "hid", "mute"]) await mkUser(id);
  await mkUser("young", { created: young });
  await mkUser("low", { level: 1 });
  await mkUser("unver", { verified: 0 });
  await runQuery(`CREATE TABLE IF NOT EXISTS stage_slots (id TEXT PRIMARY KEY, userId TEXT, room_id TEXT, status TEXT, embed TEXT)`);
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, embed) VALUES ('s1', 'st', 'PAD_A', 'active', NULL), ('s2', 'st', 'PAD_B', 'active', NULL), ('s3', 'st2', 'PAD_A', 'active', NULL)");
  await welcome.ready;
  await econ.ready;
  await vwm.init();
  // "link" is the streamer's other account (same Discord); "dupe" was flagged by the welcome dedupe
  const k = welcome.hash("discord", "999");
  await runQuery("INSERT INTO welcome_keys (k, userId, kind, created) VALUES (?, 'st', 'discord', 0), (?, 'link', 'discord', 0)", [k, k]);
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of, state, created) VALUES ('dupe', 'a1', 'dup', 0)");
  // the streamer's own browser and address, as the welcome dedupe saw them
  await runQuery("INSERT INTO welcome_keys (k, userId, kind, created) VALUES (?, 'st', 'dev', 0), (?, 'st', 'ip', 0)",
                 [welcome.hash("dev", "f".repeat(32)), welcome.hash("ip", "203.0.113.77")]);
  econ._setClock(() => now);
  vwm._setClock(() => now);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? { userId: u, username: u, class: u === "st" ? "Admin" : "pleb" } : null;
    req.cookies = req.get("x-dev") ? { patv_dev: req.get("x-dev") } : {};
    next();
  };
  econ.register(app, { isBotToken: (t) => t === "bot-token", addUser, resolveRoom: async () => "PAD_A" });
  vwm.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { vwm._stop(); if (server) server.close(); });

const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, h), body: JSON.stringify(body) });
const DEV = (c) => c.repeat(32).slice(0, 32);
const nonces = new Map();
function beat(user, b = {}, h = {}) {
  const body = Object.assign({ stream: "s1", room: "pad-a", sid: "sess-" + user, playing: true, visible: true, muted: false }, b);
  const nk = user + "|" + body.sid;
  if (!("nonce" in b)) body.nonce = nonces.get(nk) || "";
  return post("/api/econ/watch/beat", body, Object.assign({ "x-test-user": user, "x-dev": DEV(user.slice(0, 1) === "a" ? "a" : user.charCodeAt(0).toString(16).slice(-1)),
                                                             "cf-connecting-ip": `10.${user.length}.${user.charCodeAt(0)}.${user.charCodeAt(user.length - 1)}` }, h))
    .then((r) => r.json().then((j) => { nonces.set(nk, j.nonce || ""); return Object.assign({ status: r.status }, j); }));
}
// `n` counted beats (30 s each) for one viewer after the arming beat
async function watch(user, n, b = {}, h = {}) {
  let pos = 0, last;
  await beat(user, Object.assign({ pos }, b), h);
  for (let i = 0; i < n; i++) {
    now += 30000; pos += 30;
    last = await beat(user, Object.assign({ pos }, b), h);
  }
  return last;
}
const row = async (viewer, stream = "slot:s1") => (await getQuery("SELECT * FROM econ_watch WHERE viewer_id = ? AND stream = ?", [viewer, stream]))[0];

test("multiple tabs: one counted session per account - the second tab earns nothing until the first goes quiet", async () => {
  await beat("tabs", { pos: 0, sid: "tab-one" });
  now += 30000;
  assert.equal((await beat("tabs", { pos: 30, sid: "tab-one" })).counted, true);
  const r = await beat("tabs", { pos: 30, sid: "tab-two" });
  assert.equal(r.counted, false); assert.equal(r.why, "another session");
  now += 30000;
  assert.equal((await beat("tabs", { pos: 60, sid: "tab-one" })).counted, true);
  assert.equal((await row("tabs")).secs, 60);
});

test("hidden tabs and paused players earn nothing; muted minutes are counted apart", async () => {
  now += 600000;
  await watch("hid", 2);
  now += 30000;
  let r = await beat("hid", { pos: 90, visible: false });
  assert.equal(r.counted, false); assert.equal(r.why, "hidden");
  now += 30000;
  r = await beat("hid", { pos: 120, playing: false });
  assert.equal(r.counted, false); assert.equal(r.why, "paused");
  assert.equal((await row("hid")).secs, 60);
  now += 600000;
  await watch("mute", 4, { muted: true });
  const m = await row("mute");
  assert.equal(m.secs, 120); assert.equal(m.muted_secs, 120);
});

test("self-watching: the streamer, a linked account, the streamer's own browser or address are 'self'", async () => {
  now += 600000;
  assert.equal((await watch("st", 2)).status, "self");
  assert.equal((await watch("link", 2)).status, "self");
  assert.equal((await watch("near", 2, {}, { "x-dev": DEV("f") })).status, "self");
  const ip = await watch("nearip", 2, {}, { "cf-connecting-ip": "203.0.113.77" });
  assert.equal(ip.status, "self");
  assert.match((await row("nearip")).reason, /network address/);
  // the streamer's own account watching ANOTHER streamer's slot is an ordinary viewer
  assert.equal((await watch("st", 2, { stream: "s3", sid: "st-other" })).status, "ok");
});

test("alt accounts: dup_of, the 4th account on one browser, the 4th account on one network", async () => {
  now += 600000;
  assert.equal((await watch("dupe", 2)).status, "alt");
  // a1..a4 share one browser (each on its own network): three count, the fourth doesn't
  const st = [];
  for (const [i, u] of ["a1", "a2", "a3", "a4"].entries()) st.push((await watch(u, 2, {}, { "cf-connecting-ip": `192.0.2${i}.5` })).status);
  assert.deepEqual(st, ["ok", "ok", "ok", "alt"]);
  // n1..n4 on one /24 (different addresses, different browsers): three count, the fourth doesn't
  const nt = [];
  for (const [i, u] of ["n1", "n2", "n3", "n4"].entries()) nt.push((await watch(u, 2, {}, { "x-dev": DEV(String(i + 1)), "cf-connecting-ip": `100.64.7.${20 + i}` })).status);
  assert.deepEqual(nt, ["ok", "ok", "ok", "alt"]);
  assert.match((await row("n4")).reason, /account 4 on one network/);
  // the rule is per stream: n4 on another streamer's slot is the first account there from that network (its s1 session
  // has gone quiet first - one counted session per account)
  now += 60000;
  assert.equal((await watch("n4", 2, { stream: "s3", sid: "n4-on-s3" }, { "x-dev": DEV("4"), "cf-connecting-ip": "100.64.7.23" })).status, "ok");
});

test("the rollup: ok minus muted, gated viewers only, 120 per viewer per streamer per day across pads", async () => {
  now += 600000;
  for (const u of ["young", "low", "unver"]) await watch(u, 4, {}, { "cf-connecting-ip": "172.16.9." + u.length });
  // a1 also watches st on PAD_B: 150 + 30 = 180 min across the two pads -> 120, shared 150:30
  await runQuery("UPDATE econ_watch SET secs = 150 * 60 WHERE viewer_id = 'a1' AND stream = 'slot:s1'");
  await runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status) VALUES (?, 'slot:s2', 'PAD_B', 'st', 'a1', 1800, 0, 60, 'ok')`, [TODAY]);
  const r = await vwm.daily(TODAY);
  assert.equal(r.ok, true); assert.equal(r.final, false);
  const A = r.rows.find((x) => x.room === "PAD_A" && x.streamer === "st");
  const B = r.rows.find((x) => x.room === "PAD_B" && x.streamer === "st");
  // PAD_A ok viewers of st: tabs 1, hid 1, a1 150->100, a2 1, a3 1, n1 1, n2 1, n3 1 (mute: all muted -> 0)
  assert.equal(A.vwm, 1 + 1 + 100 + 1 + 1 + 1 + 1 + 1);
  assert.equal(B.vwm, 20);
  assert.equal(A.viewers, 8);
  assert.equal(A.muted_min, 2);
  assert.equal(A.gate_min, 6);                                     // young, low, unverified: 2 min each
  assert.equal(A.self_min, 1 + 1 + 1 + 1);                         // st, link, near, nearip
  assert.equal(A.alt_min, 1 + 1 + 1);                              // dupe, a4, n4
  assert.equal(Math.round(A.cap_min + B.cap_min), 60);
  // the recipe reads the same numbers
  assert.deepEqual(await vwm.forRoom("PAD_B", TODAY), [{ userId: "st", vwm: 20, viewers: 1 }]);
  // st2's slot: st (as a viewer) and n4 count
  const C = r.rows.find((x) => x.room === "PAD_A" && x.streamer === "st2");
  assert.equal(C.vwm, 2); assert.equal(C.viewers, 2);
});

test("a closed day is frozen; a streamer whose account is gone is not paid", async () => {
  now += DAY;                                                      // the 20th is over
  await runQuery("DELETE FROM users WHERE userId = 'st2'");
  let r = await vwm.daily(TODAY);
  assert.equal(r.final, true);
  assert.equal(r.rows.some((x) => x.streamer === "st2"), false);
  const before = r.rows.find((x) => x.room === "PAD_A").vwm;
  await runQuery("UPDATE econ_watch SET secs = secs + 6000 WHERE viewer_id = 'a2'");   // a late write can't change a frozen day
  r = await vwm.daily(TODAY);
  assert.equal(r.rows.find((x) => x.room === "PAD_A").vwm, before);
});

test("the bot endpoint needs the bot token; the admin view is staff only", async () => {
  assert.equal((await post("/api/g/vwm/daily", { day: TODAY })).status, 403);
  const j = await (await post("/api/g/vwm/daily", { password: "bot-token", day: TODAY, rooms: ["PAD_B"] })).json();
  assert.equal(j.ok, true); assert.deepEqual(j.rows.map((x) => [x.room, x.streamer, x.vwm]), [["PAD_B", "st", 20]]);
  assert.equal((await fetch(base + "/api/admin/econ/vwm?day=" + TODAY, { headers: { "x-test-user": "a1" } })).status, 403);
});
