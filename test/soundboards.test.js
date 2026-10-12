// Offline tests for 1.99rh soundboards (soundboards.js) + the voice store (voicestore.js).
//   catalogue seeding + render jobs; WAV uploads (cap checks); buying packs / the season board / legendaries (debit, routing,
//   Season Pass allowance, numbered supply, idempotent refs); pad boards (Prime Time slots, the speaker's soundboard opt-out,
//   text guard, owner-only editor); reports hide at 3; "Remove me"; the drawer; Pepe's sync; the voice store import (never
//   overwriting site edits), sync, buying an unlock with the owner's 20% likeness cut, owner bands, D12 free text default.
//   NODE_PATH=G:/PATV/node_modules node --test test/soundboards.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.SB_DIR = path.join(tmp, "sb");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SB = require(path.join(repo, "soundboards"));
const VS = require(path.join(repo, "voicestore"));
const L = require(path.join(repo, "likeness"));
const P = require(path.join(repo, "premium"));
const rooms = require(path.join(repo, "rooms"));
const funding = require(path.join(repo, "funding"));

const ROOM = { id: "Sb.Room", slug: "sb-room", title: "SB Room" };
let base, server;
const users = new Map();
const U = {};
const PASS = new Set();
const PRIME = new Map();
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, 10, '2026-01-01 00:00:00')`, [id, name, name, o.class || "pleb", o.bal == null ? 5000000 : o.bal, o.camfrog === undefined ? name + "cf" : o.camfrog]);
  const x = { userId: id, username: name, class: o.class || "pleb" };
  users.set(id, x);
  return x;
}
const bal = async (u) => (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [u.userId]))[0].points_balance;
const H = (x) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, x ? { "x-test-user": x.userId } : {});
async function call(method, url, x, body) {
  const r = await fetch(base + url, { method, headers: H(x), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null; const raw = await r.text();
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  return { status: r.status, d, text: raw };
}
function wav(secs, rate = 8000) {
  const n = Math.round(secs * rate), data = Buffer.alloc(n * 2), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
let refN = 0;
const ref = () => "ref" + String(++refN).padStart(10, "0");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE feed_voices (post_id TEXT PRIMARY KEY, room_id TEXT, media_id TEXT, logins TEXT, by_login TEXT, created INTEGER, removed_at INTEGER, removed_by TEXT)");
  await funding.init();
  await P.init();
  await L.init();
  await SB.init();
  await VS.init();
  // the tiers + the pad registry, as the other modules see them
  P.hasPass = (uid) => PASS.has(uid);
  P.passCamfrogs = async () => [...PASS].map((id) => [...users.values()].find((u) => u.userId === id)).filter(Boolean).map((u) => u.username + "cf");
  P.padPerks = (rid) => ({ soundboardSlots: PRIME.get(rid) || 0 });
  rooms.getCached = (rid) => (rid === ROOM.id ? { id: ROOM.id, slug: ROOM.slug, title: ROOM.title } : null);
  rooms.bySlug = async (slug) => (slug === ROOM.slug ? { id: ROOM.id, slug: ROOM.slug, title: ROOM.title } : null);
  rooms.canManage = async (user, rid) => !!user && rid === ROOM.id && (user.userId === U.owner.userId || user.class === "Admin");
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob", { bal: 20000000 });
  U.owner = await mkUser("owner");
  U.poor = await mkUser("poor", { bal: 10 });
  U.spfan = await mkUser("spfan");
  U.ksox = await mkUser("ksox4", { camfrog: "ksox4" });
  U.admin = await mkUser("boss", { class: "Admin" });
  for (const n of ["r1", "r2", "r3"]) U[n] = await mkUser(n);
  const app = express();
  const BIG = new Set(["/api/soundboards/bot/audio", "/api/soundboards/bot/room-clip", "/api/voices/bot/import"]);   // as index.js
  app.use((req, res, next) => (BIG.has(req.path) ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  SB.register(app, { addUser, isBotToken: (t) => t === "bot" });
  VS.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("catalogue: every clip seeded for rendering; Pepe's sync hands out render jobs, not unrendered clips' audio", async () => {
  const n = (await getQuery("SELECT COUNT(*) AS n FROM sb_clips WHERE catalog = 1"))[0].n;
  assert.equal(n, 12 + 3 * 8 + 12 + 2, "global 12 + 3 packs + the season board + 2 legendaries");
  const r = await call("POST", "/api/soundboards/bot/sync", null, { password: "bot", plays: [{ clip: "g-airhorn", room: "X", login: "a", paid: 1000 }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.render.length, 6, "six render jobs at a time");
  assert.ok(r.d.render.every((j) => j.kind === "tts" && j.text && j.cap));
  assert.ok(r.d.clips.every((c) => c.status === "render" ? !c.audio : true));
  assert.equal(r.d.clips.find((c) => c.id === "lg-gawk").text, "Gawk gawk gawk gawk gawk!", "a live clip carries its line (rendered at every play)");
  assert.equal((await call("POST", "/api/soundboards/bot/sync", null, { password: "x" })).status, 403);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sb_plays"))[0].n, 1, "plays are recorded");
});

test("audio uploads: a WAV within the cap goes live, a longer one fails; previews serve it", async () => {
  let r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "g-airhorn", data: wav(2).toString("base64") });
  assert.deepEqual([r.d.ok, r.d.status], [true, "active"]);
  r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "g-letsgo", data: wav(7).toString("base64") });
  assert.deepEqual([r.d.ok, r.d.status], [false, "failed"], "common clips are capped at 6 s");
  assert.match((await SB.clipStatus("g-letsgo")).note, /too long/);
  for (const id of ["hype-fire", "s2610-boo", "lg-gawk", "lg-founder"]) await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id, data: wav(1).toString("base64") });
  const a = await fetch(base + "/sb/audio/g-airhorn.wav");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("content-type"), "audio/wav");
  assert.equal((await fetch(base + "/sb/audio/g-letsgo.wav")).status, 404);
});

test("buying a pack: one debit, routing claims, ownership; a replayed ref charges nothing; can't buy twice", async () => {
  const b0 = await bal(U.alice);
  const r0 = ref();
  let r = await call("POST", "/api/soundboards/buy", U.alice, { item: "pack:hype", ref: r0 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await bal(U.alice), b0 - 250000);
  const claims = await getQuery("SELECT flow, amount FROM reserve_claims WHERE type LIKE 'soundboard pack:hype%'");
  assert.equal(claims.reduce((s, c) => s + c.amount, 0), -250000, "every PAT routed (Fort Knox row)");
  r = await call("POST", "/api/soundboards/buy", U.alice, { item: "pack:hype", ref: r0 });
  assert.equal(r.d.dup, true);
  assert.equal(await bal(U.alice), b0 - 250000);
  r = await call("POST", "/api/soundboards/buy", U.alice, { item: "pack:hype", ref: ref() });
  assert.equal(r.status, 409);
  r = await call("POST", "/api/soundboards/buy", U.poor, { item: "pack:drama", ref: ref() });
  assert.equal(r.status, 402);
  assert.equal(await bal(U.poor), 10);
});

test("Season Pass: the season board free + one free standard pack a month; legendaries numbered and limited", async () => {
  PASS.add(U.spfan.userId);
  let r = await call("POST", "/api/soundboards/buy", U.spfan, { item: "pack:drama", ref: ref(), allowance: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.price, 0);
  r = await call("POST", "/api/soundboards/buy", U.spfan, { item: "pack:classics", ref: ref(), allowance: true });
  assert.equal(r.status, 409, "one per month");
  r = await call("POST", "/api/soundboards/buy", U.bob, { item: "pack:classics", ref: ref(), allowance: true });
  assert.equal(r.status, 403, "no pass, no free pack");
  const board = (await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d;
  const season = board.tabs.find((t) => t.key === "season");
  assert.ok(season && season.clips.every((c) => c.free), "the season board is unlimited with a pass");
  r = await call("POST", "/api/soundboards/buy", U.bob, { item: "legend:lg-founder", ref: ref() });
  assert.equal(r.status, 200);
  assert.equal(r.d.serial, 1, "Founder #1");
  assert.equal(await bal(U.bob), 10000000);
  const g = SB.CAT.byLegend["lg-gawk"];
  assert.equal(g.price, 20000000, "the Gawk legendary is 20,000,000 PAT (the user's correction)");
});

test("pad boards: Prime Time slots, the text guard, the speaker's opt-out, owner-only editor", async () => {
  let r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_tts", label: "Welcome", text: "Welcome to the pond!" });
  assert.equal(r.status, 403, "no Prime Time, no room board");
  PRIME.set(ROOM.id, 2);
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.alice, { action: "add_tts", label: "Hi", text: "hi" });
  assert.equal(r.status, 403, "only the pad's owner");
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_tts", label: "Bad", text: "kys loser" });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_tts", label: "Welcome", text: "Welcome to the pond!", price: 500 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.slots, r.d.used, r.d.clips[0].price, r.d.clips[0].status], [2, 1, 500, "render"]);
  // a mic clip posted on the pad: refused when the speaker opted out of soundboards
  await runQuery("INSERT INTO feed_voices (post_id, room_id, media_id, logins, created) VALUES ('Post1', ?, 'm1', ' bobcf ', 1)", [ROOM.id]);
  await L.setPrefs(U.bob.userId, { soundboard: false });
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Bob", post: "/p/sb-room/posts/Post1", start: 0, end: 4 });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /opted out/);
  await L.setPrefs(U.bob.userId, { soundboard: true });
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Bob", post: "Post1", start: 1, end: 15 });
  assert.equal(r.status, 400, "10 s at most");
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Bob", post: "Post1", start: 1, end: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const mic = r.d.clips.find((c) => c.label === "Bob");
  assert.deepEqual([mic.kind, mic.subject], ["audio", "bobcf"]);
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_tts", label: "Third", text: "one more" });
  assert.equal(r.status, 409, "the board is full");
  const sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  const job = sync.render.find((j) => j.id === mic.id) || (await SB.botState()).render.find((j) => j.id === mic.id);
  // the render queue is oldest-first: the mic clip's job may come after the catalogue's
  assert.ok(!job || (job.kind === "audio" && job.src === `/api/soundboards/bot/src/${mic.id}` && job.trim_end === 5));
  // chat: !sb remove through Pepe
  r = await call("POST", "/api/soundboards/bot/room-remove", null, { password: "bot", room: ROOM.id, camfrog: "ownercf", clip: "welcome" });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/rooms/sb-room/soundboard/manage", U.owner)).d.used, 1);
  // chat: !sb addmic with Pepe's ready WAV
  r = await call("POST", "/api/soundboards/bot/room-clip", null, { password: "bot", room: ROOM.id, camfrog: "ownercf", kind: "audio", label: "Live", subject: "alicecf",
                                                                   data: wav(3).toString("base64"), secs: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.clip.status, "active");
});

test("reports hide a clip at 3; the person heard in it removes it at once", async () => {
  for (const u of [U.r1, U.r2]) assert.equal((await call("POST", "/api/soundboards/report", u, { clip: "g-airhorn", reason: "loud" })).d.hidden, false);
  assert.equal((await call("POST", "/api/soundboards/report", U.r3, { clip: "g-airhorn", reason: "loud" })).d.hidden, true);
  assert.equal((await fetch(base + "/sb/audio/g-airhorn.wav")).status, 404, "hidden: no public preview");
  const live = (await getQuery("SELECT id FROM sb_clips WHERE label = 'Live'"))[0].id;
  assert.equal((await call("POST", "/api/soundboards/remove-me", U.bob, { clip: live })).status, 403);
  assert.equal((await call("POST", "/api/soundboards/remove-me", U.alice, { clip: live })).status, 200);
  assert.equal((await SB.clipStatus(live)).status, "removed");
});

test("the store page and the drawer render", async () => {
  const page = await call("GET", "/soundboards", U.alice);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-sb-buy="pack:drama"/);
  assert.match(page.text, /soundboards\.js/);
  const d = (await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d;
  assert.ok(d.tabs.find((t) => t.key === "packs").clips.some((c) => c.id === "hype-fire" && c.free), "an owned pack plays free");
  assert.ok(!d.tabs.some((t) => t.key === "legend"), "no legendaries she doesn't own");
});

test("voice store: Pepe's import (kept as they are), sync, D12 default for new clones, buying an unlock pays the owner 20%", async () => {
  let r = await call("POST", "/api/voices/bot/import", null, { password: "bot", names: ["Pepe", "Ksox4", "Robo"],
    shop: { ksox4: { price: 1000, unlock: 250000, owner: "ksox4", royalty: 0.3 } }, unlocks: { bobcf: ["ksox4"], ghostcf: ["robo"] } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.added, r.d.unlocks], [3, 1]);
  const k = await VS.voice("ksox4");
  assert.deepEqual([k.kind, k.owner_user_id, k.price_use, k.price_unlock, k.royalty_pct, k.allow_free_text, k.listed], ["clone", U.ksox.userId, 1000, 250000, 30, 1, 1],
                   "an existing owned voice is imported as it is (free text stays on)");
  await VS.adminUpdate("ksox4", { price_use: 2000, consent_manual: true }, "test");
  await call("POST", "/api/voices/bot/import", null, { password: "bot", names: ["Pepe", "Ksox4", "Robo"], shop: { ksox4: { price: 1, owner: "x" } } });
  const k2 = await VS.voice("ksox4");
  assert.deepEqual([k2.price_use, k2.owner_login, k2.consent_manual], [2000, "ksox4", 1], "a re-import never overwrites the site's edits");
  const s = (await call("POST", "/api/voices/bot/sync", null, { password: "bot" })).d;
  assert.deepEqual(s.owned.bobcf, ["ksox4"]);
  assert.deepEqual(s.owned.ghostcf, ["robo"], "an unlock whose login has no account yet is kept by login");
  // a sample line per voice goes through the soundboard render queue
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM sb_clips WHERE board = 'sample'"))[0].n >= 3);
  // buy the unlock on the website
  const b0 = await bal(U.alice);
  r = await call("POST", "/api/voices/buy", U.alice, { voice: "ksox4", ref: ref() });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await bal(U.alice), b0 - 250000);
  assert.equal(r.d.cut, 50000, "20% of the unlock is the owner's likeness cut");
  const cut = await getQuery("SELECT subject_user_id, amount, status FROM likeness_ledger WHERE ref LIKE 'vsu-%'");
  assert.deepEqual(cut.map((c) => [c.subject_user_id, c.amount, c.status]), [[U.ksox.userId, 50000, "held"]]);
  assert.equal((await call("POST", "/api/voices/buy", U.alice, { voice: "ksox4", ref: ref() })).status, 409);
  // Pepe's !buyvoice
  r = await call("POST", "/api/voices/bot/buy", null, { password: "bot", camfrog: "spfancf", voice: "ksox4", ref: ref() });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  // the owner's controls, within the bands
  r = await call("POST", "/api/voices/mine", U.alice, { voice: "ksox4", price_use: 5 });
  assert.equal(r.status, 403);
  r = await call("POST", "/api/voices/mine", U.ksox, { voice: "ksox4", royalty_pct: 80 });
  assert.equal(r.status, 400, "a cut above 50% is refused");
  r = await call("POST", "/api/voices/mine", U.ksox, { voice: "ksox4", price_unlock: 50000 });
  assert.equal(r.status, 400, "an unlock under 100,000 is refused");
  r = await call("POST", "/api/voices/mine", U.ksox, { voice: "ksox4", royalty_pct: 45, allow_free_text: false, status: "paused" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.voice.royalty_pct, r.d.voice.allow_free_text, r.d.voice.status], [45, false, "paused"]);
  assert.ok(!(await VS.pickable()).some((v) => v.id === "ksox4"), "a paused clone isn't offered to pad boards");
  assert.equal((await call("GET", "/voices", U.alice)).status, 200);
  assert.equal((await call("GET", "/voices/mine", U.ksox)).status, 200);
});
