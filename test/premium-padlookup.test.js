// Offline tests for 1.99od: the Prime Time pad picker. "players-lounge" typed on prod named no pad (the room is
// You_Were_Never_Here, slug you-were-never-here, title Players__lounge) and /premium just re-rendered the empty form.
// premium.padLookup now takes the slug, p/slug, a link, the Camfrog room id or the title, and a miss says so with a
// "did you mean" list - on the page, the buy/renew API, /admin/comps and the pad finder.
//   NODE_PATH=G:/PATV/node_modules node --test test/premium-padlookup.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "premium-padlookup-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const CP = require(path.join(repo, "comps"));
const PA = require(path.join(repo, "padaccess"));

const ROOM = "You_Were_Never_Here", HIDDEN = "Secret_Club";
const USERS = {};
let server, base;

async function mkUser(name, cls = "pleb") {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, 50000000)", [id, name, name, cls]);
  USERS[name] = { userId: id, username: name, class: cls };
  return USERS[name];
}
function req(method, url, { user, json } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Origin: base };
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(text); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await mkUser("fan");
  await mkUser("boss", "Admin");
  await rooms.init();
  await rooms.addRoom(ROOM, "Players__lounge", "test");
  await rooms.addRoom(HIDDEN, "Players Secret Club", "test");
  await PA.init();
  await PA.setLevel(USERS.boss, await rooms.get(HIDDEN), "approved");
  await PR.init();
  await CP.init();
  const app = express();
  app.use(express.json());
  app.use((rq, rs, next) => { rq.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((rq, rs, next) => { rs.locals.ogBase = "http://test"; next(); });
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  PR.register(app, { addUser });
  CP.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

test("padInput: slug, p/slug, /p/slug, full links (with or without a scheme), ?pad= links", () => {
  const I = PR.padInput;
  assert.equal(I("  players-lounge "), "players-lounge");
  assert.equal(I("p/you-were-never-here"), "you-were-never-here");
  assert.equal(I("/p/you-were-never-here/stage"), "you-were-never-here");
  assert.equal(I("https://publicaccess.tv/p/you-were-never-here"), "you-were-never-here");
  assert.equal(I("publicaccess.tv/p/you-were-never-here?x=1"), "you-were-never-here");
  assert.equal(I("https://publicaccess.tv/premium?pad=you-were-never-here"), "you-were-never-here");
  assert.equal(I("You_Were_Never_Here"), "You_Were_Never_Here");
  assert.equal(I(""), "");
  assert.equal(I(null), "");
});

test("padLookup resolves the slug, p/slug, a link, the room id in any case and the title (case/underscore-insensitive)", async () => {
  for (const q of ["you-were-never-here", "p/you-were-never-here", "https://publicaccess.tv/p/you-were-never-here", "You_Were_Never_Here",
                   "you_were_never_here", "YOU_WERE_NEVER_HERE", "Players__lounge", "players-lounge", "players lounge", "PLAYERS_LOUNGE", "playerslounge"]) {
    const L = await PR.padLookup(q, USERS.fan);
    assert.ok(L.pad, `"${q}" resolves`);
    assert.equal(L.pad.id, ROOM, `"${q}" -> ${ROOM}`);
  }
  assert.equal((await PR.padTarget("Players__lounge")).id, ROOM, "padTarget (internal callers) takes the title too");
});

test("a miss names what was typed and suggests near pads (slug + title), never a pad the viewer can't see", async () => {
  const L = await PR.padLookup("players-loung", USERS.fan);
  assert.equal(L.pad, null);
  assert.equal(L.query, "players-loung");
  assert.deepEqual(L.suggestions.map((s) => s.id), [ROOM]);
  assert.match(PR.padMissText(L), /^No pad called players-loung\. Did you mean Players__lounge \(p\/you-were-never-here\)\?$/);
  // a typo of the hidden (Approved) pad: staff see it suggested, a non-member doesn't, nor resolves it by title
  assert.deepEqual((await PR.padLookup("players secret clb", USERS.boss)).suggestions.map((s) => s.id), [HIDDEN]);
  const F = await PR.padLookup("players secret clb", USERS.fan);
  assert.equal(F.suggestions.some((s) => s.id === HIDDEN), false);
  assert.equal((await PR.padLookup("Players Secret Club", null)).pad, null, "no title match on a pad a signed-out viewer can't see");
  const N = await PR.padLookup("zzzzqqq", USERS.fan);
  assert.deepEqual(N.suggestions, []);
  assert.match(PR.padMissText(N), /No pad called zzzzqqq\. Try its address \(p\/name\), its link, its Camfrog room name or its title\./);
});

test("buy API: an unknown pad is a 404 with the message + suggestions; the title buys for the right pad", async () => {
  const r = await req("POST", "/api/premium/buy", { user: "fan", json: { tier: "prime_time", pad: "players-loung", months: 1, ref: "rabcdefghij1" } });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /No pad called players-loung\. Did you mean Players__lounge/);
  assert.equal(r.json.code, "E_TARGET_NOT_FOUND");
  assert.deepEqual(r.json.suggestions.map((s) => s.slug), ["you-were-never-here"]);
  const ok = await req("POST", "/api/premium/buy", { user: "fan", json: { tier: "prime_time", pad: "Players__lounge", months: 1, ref: "rabcdefghij2" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.target, ROOM);
  assert.equal(ok.json.state.pad.slug, "you-were-never-here", "the state comes back for the resolved pad");
});

test("/premium?pad=<miss> shows the notice + suggestion links and keeps what was typed; ?pad=<title> opens the pad", async () => {
  const miss = await req("GET", "/premium?pad=players-loung", { user: "fan" });
  assert.equal(miss.status, 200);
  assert.match(miss.text, /id="ptMiss" role="alert"/);
  assert.match(miss.text, /No pad called <b>players-loung<\/b>\./);
  assert.match(miss.text, /Did you mean:/);
  assert.match(miss.text, /href="\/premium\?pad=you-were-never-here"><b>Players__lounge<\/b> · p\/you-were-never-here/);
  assert.match(miss.text, /id="ptPad" name="pad"[^>]*value="players-loung"/);
  const hit = await req("GET", "/premium?pad=" + encodeURIComponent("Players__lounge"), { user: "fan" });
  assert.match(hit.text, /data-pad="you-were-never-here"/);
  assert.doesNotMatch(hit.text, /id="ptMiss"/);
  const plain = await req("GET", "/premium");
  assert.doesNotMatch(plain.text, /id="ptMiss"/, "no notice without ?pad=");
  const st = await req("GET", "/api/premium/state?pad=nothing-like-it");
  assert.equal(st.json.pad, null);
  assert.equal(st.json.pad_missing.query, "nothing-like-it");
});

test("the signed-in /premium page script parses (the buttons' handlers)", async () => {
  const hit = await req("GET", "/premium?pad=you-were-never-here", { user: "fan" });
  const scripts = [...hit.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  assert.match(hit.text, /data-buy="prime_time"/, "the pay buttons are there for a signed-in member");
});

test("pad finder API: a hit, a miss with suggestions", async () => {
  const hit = await req("GET", "/api/premium/padfind?q=" + encodeURIComponent("https://publicaccess.tv/p/you-were-never-here"), { user: "fan" });
  assert.deepEqual(hit.json.pad, { id: ROOM, slug: "you-were-never-here", title: "Players__lounge" });
  const miss = await req("GET", "/api/premium/padfind?q=player-lounge", { user: "fan" });
  assert.equal(miss.json.pad, null);
  assert.deepEqual(miss.json.suggestions.map((s) => s.id), [ROOM, "patv:lounge"], "the closest first; the house Lounge also contains 'lounge'");
  assert.match(miss.json.text, /^No pad called player-lounge\. Did you mean Players__lounge \(p\/you-were-never-here\), p\/[a-z-]*lounge\?$/);
});

test("/admin/comps: Prime Time by title works; an unknown pad says which + suggestions", async () => {
  const bad = await req("POST", "/api/admin/comps/premium", { user: "boss", json: { tier: "prime_time", pad: "players-loung", mode: "days", n: 30, reason: "testing it" } });
  assert.equal(bad.status, 404);
  assert.match(bad.json.error, /No pad called players-loung\. Did you mean Players__lounge \(p\/you-were-never-here\)\?/);
  assert.deepEqual(bad.json.suggestions.map((s) => s.slug), ["you-were-never-here"]);
  const r = await CP.compPremium(USERS.boss, { tier: "prime_time", pad: "players-lounge", mode: "days", n: 30, reason: "testing it" });
  assert.equal(r.target, ROOM);
  assert.equal(r.label, "p/you-were-never-here");
});
