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
// 1.99ahe review: someone who BOUGHT October's 🎃 board in October (a linked Camfrog login) - the October make-good keeps its clips
// in Pepe's sync for good (board kept:2026-10), so a season test's "October's clips are gone" holds only for its season board
async function octBuyer(name) {
  const u = await mkUser(name);
  await runQuery("INSERT INTO sb_owned (user_id, item, source, payer_id, price, ref, created) VALUES (?, 'season:2026-10', 'buy', ?, 600000, ?, ?)",
                 [u.userId, u.userId, "oct-" + name, Date.parse("2026-10-20T12:00:00Z")]);
  return u;
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
  const nGlobal = SB.CAT.global.clips.length;
  assert.ok(nGlobal >= 12 + 15, "the global board: voice lines + 🎛️ sound effects (1.99vu)");
  const nSeasons = SB.CAT.seasons.reduce((s, x) => s + x.clips.length, 0);
  assert.ok(SB.CAT.seasons.length >= 2 && SB.CAT.seasons.every((s) => s.clips.length === 12), "12 clips a season (🎃 Spooky, 🍂 Fireside ...)");
  assert.equal(n, nGlobal + 3 * 8 + nSeasons + 2, "global + 3 packs + every season board (past ones stay seeded) + 2 legendaries");
  const r = await call("POST", "/api/soundboards/bot/sync", null, { password: "bot", plays: [{ clip: "g-airhorn", room: "X", login: "a", paid: 1000 }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.render.length, 6, "six render jobs at a time");
  // a TTS line, or (1.99vu) a ready-made catalogue file as an audio job Pepe fetches + converts
  assert.ok(r.d.render.every((j) => j.cap && (j.kind === "tts" ? !!j.text : /^\/api\/soundboards\/bot\/src\/[a-z0-9-]+\?v=[0-9a-f]{12}$/.test(j.src))), JSON.stringify(r.d.render));
  assert.equal(r.d.clips.find((c) => c.id === "lg-gawk").status, "active", "1.99vu: a live clip is playable from the start (no WAV needed)");
  assert.ok(r.d.clips.every((c) => c.status === "render" ? !c.audio : true));
  assert.equal(r.d.clips.find((c) => c.id === "lg-gawk").text, "Gawk gawk gawk gawk gawk!", "a live clip carries its line (rendered at every play)");
  // 1.99ww: every clip carries its line (Pepe's chat caption); a sound effect is marked so it's shown by its label
  const lg = r.d.clips.find((c) => c.id === "g-letsgo");
  assert.ok(lg && /^Let's go/i.test(lg.text), JSON.stringify(lg));
  assert.equal(r.d.clips.find((c) => c.id === "sfx-crickets").group, "sfx");
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

test("Season Pass: the season board free + one free standard pack a month; legendaries numbered and limited", async (t) => {
  // inside the catalogue's first season, whatever today's date is (the board only lists the current season's clips)
  const se = SB.CAT.seasons[0];
  assert.ok(se, "the catalogue has a season");
  SB._setClock(() => se.from + 86400e3);
  t.after(() => SB._setClock(null));
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

test("🍂 Fireside Season (2026-11): the board through November - Pepe's sync, render jobs, the drawer, the store; October's board is over", async (t) => {
  // the catalogue as written (loadCatalog slices quietly - check the raw file): ids unique + id-shaped, labels / emoji / lines within
  // their limits, and every season line short enough to speak inside the 8 s 'rare' cap
  const raw = JSON.parse(fs.readFileSync(path.join(repo, "soundboards.json"), "utf8"));
  const rawAll = [...raw.global.clips, ...raw.packs.flatMap((p) => p.clips), ...raw.seasons.flatMap((s) => s.clips), ...raw.legendaries];
  assert.equal(new Set(rawAll.map((c) => c.id)).size, rawAll.length, "clip ids are unique across the catalogue");
  for (const c of raw.seasons.flatMap((s) => s.clips)) {
    assert.match(c.id, /^[a-z0-9][a-z0-9-]{1,40}$/, c.id);
    assert.ok(c.label && c.label.length <= 32, "label: " + c.id);
    assert.ok(c.emoji && c.emoji.length <= 8, "emoji (8 UTF-16 units): " + c.id);
    assert.ok(c.text && c.text.length <= 60, "a short line (the 8 s cap): " + c.id);
    assert.ok(!c.voice && !c.file && !c.rarity, "TTS in Pepe's default voice at the season default (rare, 8 s), as October: " + c.id);
  }
  // season windows never overlap (seasonNow takes the first match)
  const ses = SB.CAT.seasons;
  for (let i = 0; i < ses.length; i++) for (let j = i + 1; j < ses.length; j++) assert.ok(ses[i].to <= ses[j].from || ses[j].to <= ses[i].from, `${ses[i].id} / ${ses[j].id}`);
  const fs11 = SB.CAT.bySeason["2026-11"];
  assert.ok(fs11, "the November season is in the catalogue");
  assert.deepEqual([fs11.name, fs11.emoji, fs11.clips.length], ["Fireside Season", "🍂", 12]);
  assert.ok(fs11.clips.every((c) => /^s2611-/.test(c.id) && c.rarity === "rare"));
  // the window: UTC midnight to midnight, the end exclusive
  assert.equal(SB.seasonNow(Date.parse("2026-10-31T23:59:59Z")).id, "2026-10");
  assert.equal(SB.seasonNow(Date.parse("2026-11-01T00:00:00Z")).id, "2026-11");
  assert.equal(SB.seasonNow(Date.parse("2026-11-30T23:59:59Z")).id, "2026-11");
  assert.notEqual((SB.seasonNow(Date.parse("2026-12-15T12:00:00Z")) || {}).id, "2026-11", "November's board is over in December");

  SB._setClock(() => Date.parse("2026-11-15T12:00:00Z"));
  t.after(() => SB._setClock(null));
  assert.equal(SB.seasonNow().id, "2026-11");
  // seeded at boot like October: TTS render jobs (Pepe renders them in his default voice), 8 s cap
  const rows = await getQuery("SELECT id, kind, status, rarity, voice, text FROM sb_clips WHERE board = 'season:2026-11' ORDER BY sort");
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.kind === "tts" && r.status === "render" && r.rarity === "rare" && !r.voice && r.text), JSON.stringify(rows));
  // the render queue is oldest-first (6 at a time, other clips waiting too): bring one forward to see its job
  await runQuery("UPDATE sb_clips SET created = 0 WHERE id = 's2611-oohaah'");
  await octBuyer("kfire");          // as on a real site: an October buyer is linked (whatever ran before this test)
  let sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.deepEqual(sync.season, { id: "2026-11", name: "Fireside Season", emoji: "🍂" }, "Pepe's !sb season");
  const job = sync.render.find((j) => j.id === "s2611-oohaah");
  assert.ok(job, JSON.stringify(sync.render));
  assert.deepEqual([job.kind, job.cap, job.voice, job.src], ["tts", 8, null, null]);
  assert.match(job.text, /^Ooooh! Aaaah!/);
  assert.ok(!sync.clips.some((c) => c.board === "season:2026-10"), "October's season board leaves Pepe's pool once its season is over");
  const oct = sync.clips.filter((c) => /^s2610-/.test(c.id));
  assert.equal(oct.length, 12, "...its clips ride on only for the people who bought it (the make-good)");
  assert.ok(oct.every((c) => c.board === "kept:2026-10"), "...as their kept board, never a season board");
  assert.ok(sync.owned.kfirecf.includes("kept:2026-10") && !(sync.owned.alicecf || []).includes("kept:2026-10"), "the buyer carries it, nobody else");
  assert.ok(sync.clips.filter((c) => /^s2611-/.test(c.id)).every((c) => c.status === "render" && !c.audio), "not playable before their WAVs are up");
  // a take longer than the cap fails; a good one goes live
  let r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "s2611-moustache", data: wav(9).toString("base64") });
  assert.deepEqual([r.d.ok, r.d.status], [false, "failed"]);
  assert.match((await SB.clipStatus("s2611-moustache")).note, /too long \(9\.0 s, the cap is 8 s\)/);
  for (const c of fs11.clips) {
    r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: c.id, data: wav(2.5).toString("base64") });
    assert.equal(r.d.status, "active", c.id);
  }
  sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  const live = sync.clips.filter((c) => c.board === "season:2026-11");
  assert.equal(live.length, 12);
  assert.ok(live.every((c) => c.status === "active" && c.audio && c.text && c.price === SB.config().price_season), "playable, with the caption line");
  assert.ok(!sync.render.some((j) => /^s2611-/.test(j.id)), "nothing left to render");
  // the 🔊 drawer: a Season tab of the 12 clips - unlimited with a Season Pass, per use for everyone else
  PASS.add(U.spfan.userId);
  let board = (await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d;
  let season = board.tabs.find((x) => x.key === "season");
  assert.deepEqual([season.name, season.emoji, season.clips.length], ["Fireside Season", "🍂", 12]);
  assert.ok(season.clips.every((c) => c.free && /^s2611-/.test(c.id)));
  board = (await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d;
  season = board.tabs.find((x) => x.key === "season");
  assert.ok(season.clips.every((c) => !c.free && c.price === SB.config().price_season), "per use without the pass or the board");
  // the board: November's on sale while it's on, October's isn't any more
  assert.equal((await call("POST", "/api/soundboards/buy", U.alice, { item: "season:2026-10", ref: ref() })).status, 404);
  const b0 = await bal(U.alice);
  r = await call("POST", "/api/soundboards/buy", U.alice, { item: "season:2026-11", ref: ref() });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await bal(U.alice), b0 - SB.config().season_price);
  board = (await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d;
  assert.ok(board.tabs.find((x) => x.key === "season").clips.every((c) => c.free), "the board makes it unlimited");
  // the store: the season's own section with ▶ previews, and the copy no longer promises a board that outlives its season
  const page = await call("GET", "/soundboards", U.bob);
  assert.match(page.text, /id="sbSeasonH">[\s\S]*?🍂 Fireside Season/);
  assert.match(page.text, /Toffee apple/);
  assert.match(page.text, /data-sb-buy="season:2026-11"/);
  assert.doesNotMatch(page.text, /stays playable per use/);
  // the Season Pass note names the season board only while there is one
  let spPage = await call("GET", "/soundboards", U.spfan);
  assert.match(spPage.text, /Your 🎟️ Season Pass: the season board is unlimited/);
  // ...and between seasons (Winter Lights holds December since 1.99ahe; mid-January 2027 is the next gap), no season board anywhere
  SB._setClock(() => Date.parse("2027-01-15T12:00:00Z"));
  if (!SB.seasonNow()) {
    assert.equal((await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d.season, null);
    assert.ok(!(await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d.tabs.some((x) => x.key === "season"));
    assert.equal((await call("POST", "/api/soundboards/buy", U.bob, { item: "season:2026-11", ref: ref() })).status, 404);
    // ...and the pass holder's note stops promising one (just the free packs)
    spPage = await call("GET", "/soundboards", U.spfan);
    assert.doesNotMatch(spPage.text, /season board is unlimited/);
    assert.match(spPage.text, /Your 🎟️ Season Pass: you have \d+ free standard pack\(s\) left this month\./);
  }
});

// December 2026 (❄️ Winter Lights Season) - every check below runs on a PINNED clock (SB._setClock), never today's date
test("❄️ Winter Lights Season (2026-12): the board through December - Pepe's sync, render jobs, the drawer, the store; November's is over", async (t) => {
  t.after(() => SB._setClock(null));
  const raw = JSON.parse(fs.readFileSync(path.join(repo, "soundboards.json"), "utf8"));
  const rawWl = raw.seasons.find((s) => s.id === "2026-12");
  assert.ok(rawWl, "the December season is in soundboards.json");
  assert.deepEqual([rawWl.name, rawWl.emoji, rawWl.from, rawWl.to], ["Winter Lights Season", "❄️", "2026-12-01", "2027-01-01"]);
  for (const c of rawWl.clips) {
    assert.match(c.id, /^s2612-[a-z0-9]{2,20}$/, c.id);
    assert.ok(c.text && c.text.length <= 60, "a short line inside the 8 s 'rare' cap: " + c.id);
    assert.ok(!c.voice && !c.file && !c.rarity, "TTS in Pepe's default voice at the season default, as October / November: " + c.id);
    // inclusive of every winter holiday: no single religion's (or Santa's) bit on the board
    assert.doesNotMatch(c.text + " " + c.label, /\b(christmas|xmas|santa|claus|hanukk?ah|chanukah|kwanzaa|jesus|church|reindeer|elf|elves|sleigh)\b/i, c.id);
  }
  const wl = SB.CAT.bySeason["2026-12"];
  assert.deepEqual([wl.name, wl.emoji, wl.clips.length], ["Winter Lights Season", "❄️", 12]);
  assert.ok(wl.clips.every((c) => /^s2612-/.test(c.id) && c.rarity === "rare"));
  // the window: Dec 1 00:00 UTC up to (not including) Jan 1 00:00 UTC
  assert.equal(SB.seasonNow(Date.parse("2026-12-01T00:00:00Z")).id, "2026-12");
  assert.equal(SB.seasonNow(Date.parse("2026-12-25T12:00:00Z")).id, "2026-12");
  assert.equal(SB.seasonNow(Date.parse("2026-12-31T23:59:59Z")).id, "2026-12");
  assert.notEqual((SB.seasonNow(Date.parse("2027-01-01T00:00:00Z")) || {}).id, "2026-12", "over at midnight UTC on New Year's Day");

  SB._setClock(() => Date.parse("2026-12-15T12:00:00Z"));
  assert.equal(SB.seasonNow().id, "2026-12");
  // seeded at boot like October and November: 12 TTS render jobs in Pepe's default voice, the 8 s cap. They're handed out
  // straight away (Pepe renders them in November, after the deploy) but only play from Dec 1.
  const rows = await getQuery("SELECT id, kind, status, rarity, voice, text FROM sb_clips WHERE board = 'season:2026-12' ORDER BY sort");
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.kind === "tts" && r.status === "render" && r.rarity === "rare" && !r.voice && r.text), JSON.stringify(rows));
  await runQuery("UPDATE sb_clips SET created = 0 WHERE id = 's2612-untangle'");
  await octBuyer("kwl");            // an October buyer linked, whatever ran before this test
  let sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.deepEqual(sync.season, { id: "2026-12", name: "Winter Lights Season", emoji: "❄️" }, "Pepe's !sb season");
  const job = sync.render.find((j) => j.id === "s2612-untangle");
  assert.ok(job, JSON.stringify(sync.render));
  assert.deepEqual([job.kind, job.cap, job.voice, job.src], ["tts", 8, null, null]);
  assert.match(job.text, /^Who put the lights away in a knot\?/);
  assert.ok(!sync.clips.some((c) => c.board === "season:2026-10" || c.board === "season:2026-11"), "October's and November's season boards are out of Pepe's pool in December");
  assert.ok(!sync.clips.some((c) => /^s2611-/.test(c.id)), "November's board was never a kept one (KEPT_SEASONS) - its clips are gone");
  const oct = sync.clips.filter((c) => /^s2610-/.test(c.id));
  assert.ok(oct.length === 12 && oct.every((c) => c.board === "kept:2026-10"), "October's ride on only as its buyers' kept board");
  assert.ok(sync.clips.filter((c) => /^s2612-/.test(c.id)).every((c) => c.status === "render" && !c.audio), "not playable before their WAVs are up");
  let r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "s2612-gym", data: wav(8.5).toString("base64") });
  assert.deepEqual([r.d.ok, r.d.status], [false, "failed"], "a take over the 8 s cap fails");
  for (const c of wl.clips) {
    r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: c.id, data: wav(3).toString("base64") });
    assert.equal(r.d.status, "active", c.id);
  }
  sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  const live = sync.clips.filter((c) => c.board === "season:2026-12");
  assert.equal(live.length, 12);
  assert.ok(live.every((c) => c.status === "active" && c.audio && c.text && c.price === SB.config().price_season), "playable, with the caption line");
  assert.ok(!sync.render.some((j) => /^s2612-/.test(j.id)), "nothing left to render");
  // the 🔊 drawer: the season tab - unlimited with a Season Pass, per use without
  PASS.add(U.spfan.userId);
  let season = (await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d.tabs.find((x) => x.key === "season");
  assert.deepEqual([season.name, season.emoji, season.clips.length], ["Winter Lights Season", "❄️", 12]);
  assert.ok(season.clips.every((c) => c.free && /^s2612-/.test(c.id)));
  season = (await call("GET", "/api/rooms/sb-room/soundboard", U.r1)).d.tabs.find((x) => x.key === "season");
  assert.ok(season.clips.every((c) => !c.free && c.price === SB.config().price_season), "per use without the pass or the board");
  // the board: December's on sale in December, November's isn't
  assert.equal((await call("POST", "/api/soundboards/buy", U.r1, { item: "season:2026-11", ref: ref() })).status, 404);
  const b0 = await bal(U.r1);
  r = await call("POST", "/api/soundboards/buy", U.r1, { item: "season:2026-12", ref: ref() });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await bal(U.r1), b0 - SB.config().season_price);
  // the store: the season's own section, and the Season Pass note names the board while there is one
  const page = await call("GET", "/soundboards", U.r2);
  assert.match(page.text, /id="sbSeasonH">[\s\S]*?❄️ Winter Lights Season/);
  assert.match(page.text, /Longest night/);
  assert.match(page.text, /data-sb-buy="season:2026-12"/);
  assert.match((await call("GET", "/soundboards", U.spfan)).text, /Your 🎟️ Season Pass: the season board is unlimited/);
});

test("🍂 -> ❄️ midnight UTC on Dec 1 (pinned clock): Fireside off, Winter Lights on - no gap, no overlap", async (t) => {
  t.after(() => SB._setClock(null));
  const fire = SB.CAT.bySeason["2026-11"], wl = SB.CAT.bySeason["2026-12"];
  assert.equal(fire.to, wl.from, "Fireside's end is exactly Winter Lights' start (no gap, no overlap)");
  assert.equal(wl.from, Date.parse("2026-12-01T00:00:00Z"));
  // second by second across the minute either side of midnight: always exactly one season, and it switches at 00:00:00
  for (let ms = Date.parse("2026-11-30T23:59:00Z"); ms <= Date.parse("2026-12-01T00:01:00Z"); ms += 1000) {
    const on = SB.CAT.seasons.filter((s) => ms >= s.from && ms < s.to).map((s) => s.id);
    assert.deepEqual(on, [ms < wl.from ? "2026-11" : "2026-12"], new Date(ms).toISOString());
  }
  assert.equal(SB.seasonNow(Date.parse("2026-11-30T23:59:59.999Z")).id, "2026-11");

  SB._setClock(() => Date.parse("2026-11-30T23:59:00Z"));
  let sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.equal(sync.season.id, "2026-11", "Nov 30 23:59: still Fireside");
  assert.ok(!sync.clips.some((c) => c.board === "season:2026-12"), "December's clips wait (rendered, not playable)");
  let tab = (await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d.tabs.find((x) => x.key === "season");
  assert.equal(tab && tab.name, "Fireside Season");
  assert.equal((await call("POST", "/api/soundboards/buy", U.r3, { item: "season:2026-12", ref: ref() })).status, 404, "not on sale before Dec 1");

  SB._setClock(() => Date.parse("2026-12-01T00:00:00Z"));
  sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.deepEqual(sync.season, { id: "2026-12", name: "Winter Lights Season", emoji: "❄️" }, "Dec 1 00:00: Winter Lights");
  assert.ok(!sync.clips.some((c) => c.board === "season:2026-11"), "Fireside's clips leave the pool");
  assert.equal(sync.clips.filter((c) => c.board === "season:2026-12" && c.status === "active").length, 12, "all 12 play from the first second");
  tab = (await call("GET", "/api/rooms/sb-room/soundboard", U.spfan)).d.tabs.find((x) => x.key === "season");
  assert.equal(tab && tab.name, "Winter Lights Season");
  assert.equal((await call("POST", "/api/soundboards/buy", U.r3, { item: "season:2026-11", ref: ref() })).status, 404, "Fireside's board is off sale");
  assert.equal((await call("POST", "/api/soundboards/buy", U.r3, { item: "season:2026-12", ref: ref() })).status, 200);
  // the store: one season section, December's
  const page = (await call("GET", "/soundboards", U.r2)).text;
  assert.match(page, /data-sb-buy="season:2026-12"/);
  assert.doesNotMatch(page, /data-sb-buy="season:2026-11"/);
});

// Pepe picks a clip by its label (pepe_soundboard._sb_match): exact id, exact label, then the FIRST label that starts with what
// was typed, then the first that contains it - and the season board comes before the global board and the packs. In November
// "!sb go" played Gobble gobble instead of Gong. This port of his matcher (keep it in step with the bot's: december_test.py runs
// the real one over this catalogue) checks that the December clips take nothing any other clip answered to.
// SB_ORDER = the bot's _sb_pool order (1.99ahe review: "kept" - a buyer's kept past season - comes after the season, before global).
const SB_ORDER = Object.freeze({ room: 0, legend: 1, season: 2, kept: 3, global: 4, pack: 5 });
function sbPool(clipsByKind) {
  const out = [];
  for (const [kind, clips] of Object.entries(clipsByKind)) {
    assert.ok(kind in SB_ORDER, "a board kind Pepe's matcher doesn't order: " + kind);
    for (const c of clips) out.push([SB_ORDER[kind], String(c.label || ""), c]);
  }
  out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return out.map((x) => x[2]);
}
function sbMatch(pool, q) {
  q = String(q || "").trim().replace(/^@+/, "").trim().toLowerCase();
  if (!q) return null;
  for (const c of pool) if (String(c.id).toLowerCase() === q) return c;
  const labels = pool.map((c) => [String(c.label || "").toLowerCase().replace(/[^a-z0-9 ]/g, ""), c]);
  const qq = q.replace(/[^a-z0-9 ]/g, "");
  for (const [lab, c] of labels) if (lab === qq) return c;
  for (const [lab, c] of labels) if (lab.startsWith(qq)) return c;
  for (const [lab, c] of labels) if (lab.includes(qq)) return c;
  return null;                                        // (the bot's last step, difflib, only runs when nothing above matched)
}
test("❄️ Winter Lights clips shadow no other clip's short !sb prefix (the November 'go' -> Gobble gobble mistake)", () => {
  const C = SB.CAT;
  const wl = C.bySeason["2026-12"].clips;
  const others = [...C.global.clips, ...C.packs.flatMap((p) => p.clips), ...C.legendaries];
  const pastSeasons = C.seasons.filter((s) => s.id !== "2026-12").flatMap((s) => s.clips);
  // what people type for an existing clip: every prefix of 2+ letters of its label, every word of 3+ letters, the whole label
  const queries = (c) => {
    const lab = String(c.label).toLowerCase().replace(/[^a-z0-9 ]/g, "");
    const qs = new Set([lab]);
    for (let n = 2; n < lab.length; n++) qs.add(lab.slice(0, n).trim());
    for (const w of lab.split(" ")) if (w.length >= 3) qs.add(w);
    return [...qs].filter((q) => q.length >= 2);
  };
  // with or without a buyer's kept past board in the pool (1.99ahe KEPT_SEASONS: the only way a past season plays again - as board
  // "kept:<id>", ordered after the season), December changes nothing
  const keptClips = SB.KEPT_SEASONS.flatMap((id) => C.bySeason[id].clips);
  assert.ok(keptClips.length, "the kept seasons are in the catalogue");
  for (const withKept of [false, true]) {
    const base = { legend: C.legendaries, global: C.global.clips, pack: C.packs.flatMap((p) => p.clips), ...(withKept ? { kept: keptClips } : {}) };
    const before = sbPool(base), after = sbPool({ ...base, season: wl });
    for (const c of [...others, ...(withKept ? keptClips : [])]) {
      for (const q of queries(c)) {
        const was = sbMatch(before, q), now = sbMatch(after, q);
        assert.equal(now && now.id, was && was.id, `'!sb ${q}' played ${was && was.label}, with December it plays ${now && now.label}`);
      }
    }
  }
  // the November case itself: Gong answers to 'go' again in December
  const decPool = sbPool({ season: wl, global: C.global.clips, pack: C.packs.flatMap((p) => p.clips) });
  assert.equal(sbMatch(decPool, "go").id, "sfx-gong");
  assert.equal(sbMatch(sbPool({ season: C.bySeason["2026-11"].clips, global: C.global.clips }), "go").id, "s2611-gobble", "(November's shadow, for the record)");
  // (and for the record, an October buyer's kept board: the season still wins over it, it wins over global + packs - as in October)
  const kPool = (season) => sbPool({ season, kept: C.bySeason["2026-10"].clips, global: C.global.clips, pack: C.packs.flatMap((p) => p.clips) });
  assert.equal(sbMatch(kPool(C.bySeason["2026-11"].clips), "th").id, "s2611-thankful", "November: Thankful before the buyer's Thunder");
  assert.equal(sbMatch(kPool(wl), "th").id, "s2610-thunder", "December: Thunder before The GOAT (pack)");
  assert.equal(sbMatch(kPool(wl), "bo").id, "s2610-boo", "December: Boo before Booing (global)");
  // ...and every December clip answers to its own first two letters (distinct inside the season, taken by nothing else)
  const firstTwo = wl.map((c) => c.label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 2));
  assert.equal(new Set(firstTwo).size, wl.length, "distinct first two letters: " + firstTwo.join(" "));
  const taken = new Set([...others, ...pastSeasons].map((c) => String(c.label).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 2)));
  for (const c of wl) {
    assert.ok(!taken.has(firstTwo[wl.indexOf(c)]), `${c.label}: its first two letters belong to another clip`);
    assert.equal(sbMatch(decPool, firstTwo[wl.indexOf(c)]).id, c.id, `'!sb ${firstTwo[wl.indexOf(c)]}' plays ${c.label}`);
  }
  // and no December label is a !sb subcommand
  const SUBS = ["backend", "on", "off", "add", "addmic", "remove", "rm", "del", "delete", "list", "help", "room", "global", "season", "packs", "pack", "legend", "mine", "kept"];
  for (const c of wl) assert.ok(!SUBS.includes(c.label.toLowerCase().split(" ")[0]), c.label);
});

// 1.99ahe review: the port above orders every board kind Pepe's sync sends (a kept past season is "kept:<id>"), in the bot's order
test("Pepe's matcher port: every board kind the sync sends has a place, in the bot's _sb_pool order (PEPE_BOT_DIR)", async (t) => {
  t.after(() => SB._setClock(null));
  await octBuyer("kport");
  SB._setClock(() => Date.parse("2026-11-15T12:00:00Z"));
  const sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  const kinds = new Set(sync.clips.map((c) => String(c.board).split(":")[0]));
  assert.ok(kinds.has("kept"), "the sync carries a kept board (an October buyer is linked)");
  for (const k of kinds) assert.ok(k in SB_ORDER, "sbPool has no place for board kind " + k);
  const bot = process.env.PEPE_BOT_DIR;
  if (!bot) return t.skip("PEPE_BOT_DIR not set - the bot's _sb_pool order isn't compared here");
  const src = fs.readFileSync(path.join(bot, "pepe_soundboard.py"), "utf8");
  const m = /def _sb_pool\([\s\S]*?\n\s*order = (\{[^}]*\})/.exec(src);
  assert.ok(m, "pepe_soundboard.py _sb_pool has an order = {...} line");
  assert.deepEqual(JSON.parse(m[1]), { ...SB_ORDER }, "the port's order = the bot's _sb_pool order");
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
                                                                   data: wav(3).toString("base64"), secs: 3, text: "I am the\nmain <b>character</b>" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.clip.status, "active");
  // 1.99ww: the mic-up's transcript is kept (one clean line) and Pepe's sync carries it - his chat caption as it plays
  const withLine = (await SB.botState()).clips.find((c) => c.id === r.d.clip.id);
  assert.equal(withLine.text, "I am the main b character /b", JSON.stringify(withLine));
  assert.equal(withLine.kind, "audio");
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

test("owner 11-02: a J-7 frog-name mic clip goes on a room board under its frog name - no answer to anyone else ever carries the login; the rules still run on the real person; a named clip is as before", async () => {
  PRIME.set(ROOM.id, 24);
  try { await runQuery("ALTER TABLE feed_voices ADD COLUMN alias TEXT"); } catch (e) { /* there */ }
  U.zq = await mkUser("zqveil");                       // Camfrog login zqveilcf - incognito when the clip was posted (J-7)
  const NEEDLE = /zqveil/i;
  await runQuery("INSERT INTO feed_voices (post_id, room_id, media_id, logins, by_login, created, alias) VALUES ('PostF', ?, 'mf', ' zqveilcf ', 'alicecf', 3, 'Mossy Newt')", [ROOM.id]);
  await runQuery("INSERT INTO feed_voices (post_id, room_id, media_id, logins, by_login, created, alias) VALUES ('PostG', ?, 'mg', ' zqveilcf ', 'alicecf', 4, 'Mossy Newt')", [ROOM.id]);
  // the speaker's opt-out still applies - and the refusal doesn't say who
  await L.setPrefs(U.zq.userId, { soundboard: false });
  let r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Croak", post: "PostF", start: 0, end: 3 });
  assert.equal(r.status, 403);
  assert.equal(r.d.error, "The person heard in that clip has opted out of being on soundboards.");
  assert.doesNotMatch(r.text, NEEDLE);
  await L.setPrefs(U.zq.userId, { soundboard: true });
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Croak", post: "/p/sb-room/posts/PostF", start: 0, end: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.doesNotMatch(r.text, NEEDLE, "the owner's editor: the frog name only");
  const frog = r.d.clips.find((c) => c.label === "Croak");
  assert.deepEqual([frog.kind, frog.subject, frog.subject_frog], ["audio", "Mossy Newt", 1]);
  assert.deepEqual((await getQuery("SELECT subject_login, subject_alias FROM sb_clips WHERE id = ?", [frog.id]))[0],
                   { subject_login: "zqveilcf", subject_alias: "Mossy Newt" }, "the login is kept server-side, for the rules");
  assert.equal((await SB.storeAudio(frog.id, wav(2))).status, "active", "Pepe rendered it (it plays from the drawer now)");
  // every page / answer anyone else gets: the drawer (signed in / out), the editor, the store
  for (const [who, url] of [[U.alice, "/api/rooms/sb-room/soundboard"], [null, "/api/rooms/sb-room/soundboard"], [U.owner, "/api/rooms/sb-room/soundboard/manage"],
                            [U.alice, "/api/soundboards"], [U.alice, "/soundboards"]]) {
    const a = await call("GET", url, who);
    assert.equal(a.status, 200, url);
    assert.doesNotMatch(a.text, NEEDLE, `${url} (${who ? who.username : "signed out"})`);
  }
  const drawer = (await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d.tabs.find((t) => t.key === "room").clips.find((c) => c.id === frog.id);
  assert.deepEqual([drawer.subject, drawer.subject_frog], ["Mossy Newt", 1], "the drawer labels it with the frog name");
  // a named clip is exactly as before: the login, no frog flag
  const named = (await call("GET", "/api/rooms/sb-room/soundboard/manage", U.owner)).d.clips.find((c) => c.label === "Bob");
  assert.deepEqual([named.subject, "subject_frog" in named], ["bobcf", false]);
  // Pepe (bot token, server to server) keeps the real login for his rules (opt-out at every play, the likeness cut, the caption)
  const bot = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d.clips.find((c) => c.id === frog.id);
  assert.deepEqual([bot.subject, bot.subject_alias], ["zqveilcf", "Mossy Newt"]);
  assert.equal((await call("POST", "/api/soundboards/bot/sync", null, { password: "nope" })).status, 403, "never without the bot token");
  // "Remove me": refused for anyone else (without saying who), works for the person heard in it
  r = await call("POST", "/api/soundboards/remove-me", U.alice, { clip: frog.id });
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.text, NEEDLE);
  r = await call("POST", "/api/soundboards/remove-me", U.zq, { clip: frog.id });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal((await SB.clipStatus(frog.id)).status, "removed");
  // the owner removes one in chat through Pepe: the answer is the label
  r = await call("POST", "/api/rooms/sb-room/soundboard/clips", U.owner, { action: "add_mic", label: "Croak again", post: "PostG", start: 0, end: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  r = await call("POST", "/api/soundboards/bot/room-remove", null, { password: "bot", room: ROOM.id, camfrog: "ownercf", clip: "croak again" });
  assert.deepEqual(r.d, { ok: true, label: "Croak again" });
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

test("1.99vu: catalogue files go to Pepe as audio jobs and replace a clip's audio without a gap; live clips never wait in 'render'", async () => {
  // every catalogue file is in the repo, named in the catalogue, with a licence / provenance entry
  const lic = JSON.parse(fs.readFileSync(path.join(repo, "data", "soundboard-sfx-licences.json"), "utf8"));
  const all = [...SB.CAT.global.clips, ...SB.CAT.packs.flatMap((p) => p.clips), ...SB.CAT.legendaries].filter((c) => c.file);
  assert.ok(all.length >= 30);
  for (const c of all) {
    assert.ok(fs.existsSync(path.join(repo, "data", "soundboard-audio", c.file)), c.file);
    assert.ok(lic.sfx[c.id] || lic.generated[c.id], "provenance for " + c.id);
    if (lic.sfx[c.id]) assert.equal(lic.sfx[c.id].licence, "CC0 1.0");
  }
  const sfx = SB.CAT.global.clips.filter((c) => c.group === "sfx").map((c) => c.id);
  assert.ok(sfx.includes("sfx-crickets") && sfx.includes("g-airhorn"), "Sound effects on the global board");

  // the bot fetches a file source with its token only
  const job = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  const cr = job.clips.find((c) => c.id === "sfx-crickets");
  assert.ok(!cr || (cr.status === "render" && !cr.audio), "not playable before its WAV is up");
  let f = await fetch(base + "/api/soundboards/bot/src/sfx-crickets", { headers: { "x-bot-token": "bot" } });
  assert.equal(f.status, 200);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), fs.readFileSync(path.join(repo, "data", "soundboard-audio", "sfx-crickets.ogg")));
  assert.equal((await fetch(base + "/api/soundboards/bot/src/sfx-crickets")).status, 403);
  let r = await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "sfx-crickets", data: wav(4.6).toString("base64") });
  assert.equal(r.d.status, "active");
  assert.equal((await SB.clipStatus("sfx-crickets")).note.slice(0, 22), "file:sfx-crickets.ogg#");
  const api = (await call("GET", "/api/soundboards", U.alice)).d;
  assert.equal(api.global.clips.find((c) => c.id === "sfx-crickets").group, "sfx");

  // a CHANGED file: the clip keeps playing its old WAV (pending) until the new one is up; the old one is kept
  const alt = fs.mkdtempSync(path.join(tmp, "audio-"));
  for (const x of fs.readdirSync(SB.AUDIO_SRC)) fs.copyFileSync(path.join(SB.AUDIO_SRC, x), path.join(alt, x));
  fs.appendFileSync(path.join(alt, "sfx-crickets.ogg"), Buffer.from("changed"));
  const was = SB.AUDIO_SRC;
  SB._setAudioSrc(alt);
  try {
    await SB._seed();
    let c = await SB.clipStatus("sfx-crickets");
    assert.deepEqual([c.status, c.pending], ["active", 1], "still playable while the new file renders");
    const sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
    assert.ok(sync.clips.some((x) => x.id === "sfx-crickets" && x.audio), "Pepe still has the old audio");
    const oldSha = c.sha;
    await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "sfx-crickets", data: wav(3.3).toString("base64") });
    c = await SB.clipStatus("sfx-crickets");
    assert.deepEqual([c.status, c.pending], ["active", 0]);
    assert.notEqual(c.sha, oldSha, "a new sha = a new ?v= for every cache");
    assert.ok(fs.existsSync(path.join(process.env.SB_DIR, ".replaced", `sfx-crickets.${oldSha.slice(0, 8)}.wav`)), "the replaced WAV is kept");
    await SB._seed();
    assert.equal((await SB.clipStatus("sfx-crickets")).pending, 0, "the same file again: nothing to do (idempotent)");
    // a refused new file never takes the old audio away
    fs.appendFileSync(path.join(alt, "sfx-crickets.ogg"), Buffer.from("again"));
    await SB._seed();
    for (let k = 0; k < 5; k++) await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "sfx-crickets", failed: "ffmpeg said no" });
    c = await SB.clipStatus("sfx-crickets");
    assert.deepEqual([c.status, c.pending], ["active", 0], "5 failures: stops asking, keeps playing");
    // a file that's gone (a bad deploy): the clip keeps its audio, no TTS render
    fs.unlinkSync(path.join(alt, "sfx-crickets.ogg"));
    await SB._seed();
    assert.equal((await SB.clipStatus("sfx-crickets")).status, "active");
  } finally { SB._setAudioSrc(was); }

  // 1.99vx: a catalogue file Pepe failed on (5 tries) is offered again at the next boot
  await runQuery("UPDATE sb_clips SET status = 'failed', tries = 5, audio = NULL WHERE id = 'sfx-tada'");
  await SB._seed();
  const tada = await SB.clipStatus("sfx-tada");
  assert.deepEqual([tada.status, tada.tries], ["render", 0]);

  // 1.99wc: ...and an hour after it failed, at Pepe's next sync, without a boot
  await runQuery("UPDATE sb_clips SET status = 'failed', tries = 5, updated = ? WHERE id = 'sfx-tada'", [Date.now() - 2 * 3600e3]);
  await runQuery("UPDATE sb_clips SET status = 'failed', tries = 5, updated = ? WHERE id = 'sfx-gong'", [Date.now() - 60e3]);
  await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" });
  assert.equal((await SB.clipStatus("sfx-tada")).status, "render", "failed an hour ago -> offered again");
  assert.equal((await SB.clipStatus("sfx-gong")).status, "failed", "failed a minute ago -> not yet");

  // 1.99we: a clip still playing its OLD audio after its new file failed 5 times is offered again (boot, and hourly)
  await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "hype-encore", data: wav(2).toString("base64") });
  await runQuery("UPDATE sb_clips SET note = 'voice: x', pending = 0, tries = 5 WHERE id = 'hype-encore'");
  await SB._seed();
  let enc = await SB.clipStatus("hype-encore");
  assert.deepEqual([enc.status, enc.pending, enc.tries], ["active", 1, 0], "boot: the old WAV plays, the file is asked for again");
  await runQuery("UPDATE sb_clips SET pending = 0, tries = 5, updated = ? WHERE id = 'hype-encore'", [Date.now() - 2 * 3600e3]);
  await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" });
  enc = await SB.clipStatus("hype-encore");
  assert.deepEqual([enc.pending, enc.tries], [1, 0], "hourly: asked for again");
  await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: "hype-encore", data: wav(2.2).toString("base64") });
  await SB._seed();
  enc = await SB.clipStatus("hype-encore");
  assert.equal(enc.pending, 0, "once the file's audio is up: done (its src noted), nothing more to ask");

  // live clips: a re-seed never puts one back in 'render'; one stuck there (the prod bug) is healed by the sync
  await runQuery("UPDATE sb_clips SET status = 'render', audio = NULL WHERE id = 'lg-gawk'");
  const healed = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.equal(healed.clips.find((c) => c.id === "lg-gawk").status, "active");
  assert.ok(!healed.render.some((j) => j.id === "lg-gawk"));
  await runQuery("UPDATE sb_clips SET status = 'render' WHERE id = 'lg-gawk'");
  await SB._seed();
  assert.equal((await SB.clipStatus("lg-gawk")).status, "active", "healed at startup too");

  // the store: the ▶ is an SVG pair (centred, not a text glyph), Sound effects listed, a live clip without a WAV gets the note
  const page = await call("GET", "/soundboards", U.alice);
  assert.match(page.text, /class="sb-play"[^>]*aria-pressed="false"><svg class="i-play"/);
  assert.match(page.text, /id="sbSfxH">🎛️ Sound effects/);
  assert.match(page.text, /sb-noprev" aria-hidden="true">🎲/);
  assert.match(page.text, /different random voice every time/);
  assert.doesNotMatch(page.text, /data-audio=""/, "no empty players");
});

test("soundboard patience defaults to 150 seconds and saved admin settings win", async () => {
  assert.equal(SB.config().start_within, 150);
  await SB.setConfig({ start_within: 210 }, "test");
  assert.equal(SB.config().start_within, 210);
  assert.equal(JSON.parse((await getQuery("SELECT value FROM sb_config WHERE key = 'start_within'"))[0].value), 210);
  await SB.setConfig({ start_within: 150 }, "test");
});

test("drawer consumes existing relay snapshots for waiting, playback and failure", async () => {
  const vm = require("node:vm"), nodes = [];
  const make = (tag) => {
    const e = { tag, children: [], attrs: {}, listeners: {}, textContent: "", className: "",
      style: { setProperty() {} }, appendChild(x) { this.children.push(x); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(k, f) { this.listeners[k] = f; }, querySelectorAll() { return []; } };
    e.classList = { contains(c) { return e.className.split(" ").includes(c); }, toggle(c, on) {
      e.className = e.className.split(" ").filter(x => x !== c).concat(on ? [c] : []).join(" ");
    } };
    nodes.push(e); return e;
  };
  const host = make("div"); host.attrs["data-slug"] = "sb-room";
  const window = {}, calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/pad-soundboard.js"), "utf8"), {
    window, document: { getElementById: () => host, createElement: make, createTextNode: t => ({ textContent: t }) },
    setTimeout() {}, clearTimeout() {}, fetch: async url => {
      calls.push(url);
      return { json: async () => url.endsWith("/say") ? { ok: true, id: "job" } :
        { ok: true, on: true, tabs: [{ key: "global", name: "Global", emoji: "", clips: [{ id: "clip", label: "Bell", free: true }] }] } };
    }
  });
  nodes.find(x => x.className.includes("sbd-toggle")).listeners.click();
  await new Promise(setImmediate);
  nodes.find(x => x.className.startsWith("sbd-b ")).listeners.click();
  await new Promise(setImmediate);
  const status = nodes.find(x => x.attrs["role"] === "status");
  assert.equal(status.textContent, "Queued for playback.");
  window.PATVSoundboard.update([{ id: "other", state: "playing" }]);
  assert.equal(status.textContent, "Queued for playback.");
  window.PATVSoundboard.update([{ id: "job", state: "waiting" }]);
  assert.equal(status.textContent, "Waiting for the mic…");
  window.PATVSoundboard.update([{ id: "job", state: "playing" }]);
  assert.equal(status.textContent, "Playing on the mic now.");
  window.PATVSoundboard.update([{ id: "job", state: "done", ok: false, msg: "the mic stayed busy" }]);
  assert.equal(status.textContent, "the mic stayed busy");
  assert.match(status.className, /bad/);
  assert.equal(calls.length, 2, "no separate status polling channel");
});

// 1.99alk saycool (the owner, 2026-11-07: "For the soundboard / say, the cooldown is too aggressive. Also it counts failed grabs to
// the cooldown."): Pepe's per-person limits loosened (45 s -> 15 s, 6 -> 12 per 10 min, the same clip 3 min -> 60 s) - the room's
// flood guard (12 s, 20 per 10 min) unchanged; the drawer's ring follows the setting and comes off when a clip never played.
test("1.99alk saycool: the soundboard's per-person defaults are loosened, the room's flood guard stays, Pepe's sync + the drawer carry them", async () => {
  const c = SB.config();
  assert.deepEqual([c.cd_user_gap, c.cd_user_burst, c.cd_user_window, c.cd_clip_room], [15, 12, 600, 60], "per person: 15 s, 12 per 10 min; the same clip per room: 60 s");
  assert.deepEqual([c.cd_room_gap, c.cd_room_burst, c.cd_room_window], [12, 20, 600], "the room's flood guard: one per 12 s, 20 per 10 min (unchanged)");
  assert.deepEqual([c.cd_legend_user, c.cd_legend_room, c.queue_max, c.start_within], [600, 300, 3, 150], "legendaries, the queue, the start window unchanged");
  const sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.equal(sync.cfg.cd_user_gap, 15, "Pepe's sync hands him the 15 s");
  const drawer = (await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d;
  assert.equal(drawer.gap, 15, "the drawer gets the per-person gap (its ring was a hard-coded 45 s)");
  await SB.setConfig({ cd_user_gap: 20 }, "test");
  assert.equal((await call("GET", "/api/rooms/sb-room/soundboard", U.alice)).d.gap, 20, "a saved admin value wins in the drawer too");
  await SB.setConfig({ cd_user_gap: 15 }, "test");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["sb.how"], /one play every 15 s per person, the same clip once a minute per room/, "the store's copy says the new limits");
  assert.doesNotMatch(en["sb.how"], /45 s|3 min/);
});

test("1.99alk saycool: the drawer's cooldown ring follows the setting and comes off when the clip never played (no cooldown for a failed grab)", async () => {
  const vm = require("node:vm");
  const run = (drawerData) => {
    const nodes = [];
    const make = (tag) => {
      const e = { tag, children: [], attrs: {}, listeners: {}, textContent: "", className: "", disabled: false,
        style: { setProperty() {} }, appendChild(x) { this.children.push(x); },
        setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(k, f) { this.listeners[k] = f; },
        querySelectorAll(sel) { return sel === ".sbd-b" ? nodes.filter((x) => x.className.startsWith("sbd-b ")) : []; } };
      e.classList = { contains(c) { return e.className.split(" ").includes(c); }, toggle(c, on) {
        e.className = e.className.split(" ").filter((x) => x && x !== c).concat(on ? [c] : []).join(" ");
      } };
      nodes.push(e); return e;
    };
    const host = make("div"); host.attrs["data-slug"] = "sb-room";
    const window = {}, posts = [];
    vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/pad-soundboard.js"), "utf8"), {
      window, Date, document: { getElementById: () => host, createElement: make, createTextNode: (t) => ({ textContent: t }) },
      setTimeout() {}, clearTimeout() {}, fetch: async (url) => {
        if (url.endsWith("/say")) posts.push(url);
        return { json: async () => url.endsWith("/say") ? { ok: true, id: "job" + posts.length } : drawerData };
      }
    });
    const D = {
      window, posts, nodes,
      async open() { nodes.find((x) => x.className.includes("sbd-toggle")).listeners.click(); await new Promise(setImmediate); },
      async play() { nodes.find((x) => x.className.startsWith("sbd-b ")).listeners.click(); await new Promise(setImmediate); },
      grid: () => nodes.find((x) => x.className.startsWith("sbd-grid")),
      toggle: () => nodes.find((x) => x.className.includes("sbd-toggle")),
      status: () => nodes.find((x) => x.attrs.role === "status"),
      btn: () => nodes.find((x) => x.className.startsWith("sbd-b ")),
    };
    return D;
  };
  const data = { ok: true, on: true, gap: 15, tabs: [{ key: "global", name: "Global", emoji: "", clips: [{ id: "clip", label: "Bell", free: true }] }] };

  // the ring is the setting's 15 s, not 45
  let d = run(data);
  await d.open(); await d.play();
  assert.equal(d.toggle().attrs["data-cd"], "15", "the ring counts down the per-person gap the site hands it");
  assert.ok(d.grid().classList.contains("cooling") && d.btn().disabled, "...and the buttons wait it out");

  // a failed grab: done, not ok, never played -> the ring comes off at once, the message says so
  d.window.PATVSoundboard.update([{ id: "job1", state: "waiting" }]);
  d.window.PATVSoundboard.update([{ id: "job1", state: "done", ok: false,
    msg: "Pepe couldn't get the mic (someone else took the mic) - refunded. No cooldown - try again." }]);
  assert.ok(!d.grid().classList.contains("cooling") && !d.btn().disabled && d.toggle().attrs["data-cd"] == null,
    "a clip that never got the mic leaves no cooldown on the drawer");
  assert.match(d.status().textContent, /couldn't get the mic.*No cooldown - try again/);
  assert.match(d.status().className, /bad/);
  await d.play();
  assert.equal(d.posts.length, 2, "...so the same person can ask again right away");

  // an older Pepe's failure without a message: the drawer's own words
  d.window.PATVSoundboard.update([{ id: "job2", state: "done", ok: false, msg: "" }]);
  assert.equal(d.status().textContent, "Pepe couldn't get the mic - no cooldown, try again.");
  assert.ok(!d.grid().classList.contains("cooling"));

  // Pepe refused it before queueing (his own cooldown / a switch): a typed answer, never played -> no ring either
  await d.play();
  d.window.PATVSoundboard.update([{ id: "job3", state: "done", ok: true, msg: "answered privately" }]);
  assert.ok(!d.grid().classList.contains("cooling"), "nothing played: no cooldown shown");

  // a clip that PLAYED keeps its cooldown
  d = run(data);
  await d.open(); await d.play();
  d.window.PATVSoundboard.update([{ id: "job1", state: "playing" }]);
  d.window.PATVSoundboard.update([{ id: "job1", state: "done", ok: true, msg: "played" }]);
  assert.ok(d.grid().classList.contains("cooling") && d.btn().disabled, "a clip that played keeps the per-person cooldown");
  // an error mid-clip (it started) is not a failed grab: the cooldown stands
  d = run(data);
  await d.open(); await d.play();
  d.window.PATVSoundboard.update([{ id: "job1", state: "playing" }]);
  d.window.PATVSoundboard.update([{ id: "job1", state: "done", ok: false, msg: "Pepe couldn't play it - try again" }]);
  assert.ok(d.grid().classList.contains("cooling"), "a clip that started keeps its cooldown");

  // an older site answer without `gap`: the new default
  d = run({ ...data, gap: undefined });
  await d.open(); await d.play();
  assert.equal(d.toggle().attrs["data-cd"], "15", "no gap in the answer: 15 s");
  assert.match(fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8"), /pad-soundboard\.js\?v=6/, "the drawer's cache-buster moved on");
});

test("1.99ahe October make-good: whoever BOUGHT the 🎃 Spooky Season board keeps its clips after 1 Nov (drawer + Pepe's sync); nobody else does", async (t) => {
  assert.deepEqual([...SB.KEPT_SEASONS], ["2026-10"], "only October's store copy promised a board that outlives its season");
  const kbuy = await mkUser("kbuy"), kcomp = await mkUser("kcomp"), kpass = await mkUser("kpass"), knone = await mkUser("knone");
  const late = await mkUser("klate");
  PASS.add(kpass.userId);
  const oct = SB.CAT.bySeason["2026-10"];
  assert.deepEqual([oct.name, oct.emoji, oct.clips.length], ["Spooky Season", "🎃", 12]);
  for (const c of oct.clips) await call("POST", "/api/soundboards/bot/audio", null, { password: "bot", id: c.id, data: wav(2).toString("base64") });
  // October: kbuy buys the board (600,000), kcomp is comped it, kpass has the Season Pass
  SB._setClock(() => Date.parse("2026-10-15T12:00:00Z"));
  t.after(() => SB._setClock(null));
  const b0 = await bal(kbuy);
  let r = await call("POST", "/api/soundboards/buy", kbuy, { item: "season:2026-10", ref: ref() });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await bal(kbuy), b0 - 600000, "the board was 600,000 PAT");
  assert.equal((await SB.grantComp(kcomp.userId, "season:2026-10", "boss")).already, false);
  let sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
  assert.ok(sync.clips.filter((c) => /^s2610-/.test(c.id)).every((c) => c.board === "season:2026-10"), "in season: the ordinary season board");
  assert.deepEqual(sync.kept_seasons, [], "nothing kept while the season is on");
  // a row dated after the season's end can't exist through the store; one forced in by hand never qualifies
  await runQuery("INSERT INTO sb_owned (user_id, item, source, payer_id, price, ref, created) VALUES (?, 'season:2026-10', 'buy', ?, 600000, 'k-late', ?)",
                 [late.userId, late.userId, Date.parse("2026-11-02T00:00:00Z")]);

  // November (and for good): only kbuy
  for (const when of ["2026-11-15T12:00:00Z", "2027-06-01T12:00:00Z"]) {
    SB._setClock(() => Date.parse(when));
    const tabsOf = async (u) => (await call("GET", "/api/rooms/sb-room/soundboard", u)).d.tabs;
    const mine = (await tabsOf(kbuy)).find((x) => x.key === "kept:2026-10");
    assert.ok(mine, when + ": the buyer's drawer has the October tab");
    assert.deepEqual([mine.name, mine.emoji, mine.clips.length], ["Spooky Season", "🎃", 12]);
    assert.ok(mine.clips.every((c) => c.free && /^s2610-/.test(c.id)), "yours, unlimited");
    for (const u of [knone, kcomp, kpass, late, U.admin]) {
      assert.ok(!(await tabsOf(u)).some((x) => String(x.key).startsWith("kept:") || x.clips.some((c) => /^s2610-/.test(c.id))),
                `${when}: no October clips for ${u.username}`);
    }
    assert.equal((await call("POST", "/api/soundboards/buy", knone, { item: "season:2026-10", ref: ref() })).status, 404, "October's board isn't sold again");
    sync = (await call("POST", "/api/soundboards/bot/sync", null, { password: "bot" })).d;
    const k = sync.clips.filter((c) => /^s2610-/.test(c.id));
    assert.equal(k.length, 12, when + ": Pepe gets October's clips");
    assert.ok(k.every((c) => c.board === "kept:2026-10" && c.status === "active" && c.audio), "...as board kept:2026-10 (a Pepe without kept support skips it)");
    assert.ok(!sync.clips.some((c) => c.board === "season:2026-10"), "never as an ordinary season board");
    assert.deepEqual(sync.kept_seasons, [{ id: "kept:2026-10", name: "Spooky Season", emoji: "🎃" }]);
    assert.ok(sync.owned.kbuycf.includes("kept:2026-10"), "the buyer carries kept:2026-10");
    for (const n of ["kcompcf", "kpasscf", "knonecf", "klatecf", "bosscf"]) assert.ok(!(sync.owned[n] || []).includes("kept:2026-10"), "not " + n);
    assert.ok(sync.sp.includes("kpasscf"), "the pass holder is still a pass holder");
    assert.deepEqual([...(await SB.keptFor(kbuy.userId))], ["kept:2026-10"]);
    assert.equal((await SB.keptFor(kcomp.userId)).size + (await SB.keptFor(late.userId)).size + (await SB.keptFor(kpass.userId)).size, 0);
  }
  // Season Pass holders: unchanged - the current season free, October not at all
  SB._setClock(() => Date.parse("2026-11-15T12:00:00Z"));
  const pt = (await call("GET", "/api/rooms/sb-room/soundboard", kpass)).d.tabs;
  assert.ok(pt.find((x) => x.key === "season").clips.every((c) => c.free && /^s2611-/.test(c.id)), "the pass: Fireside unlimited, as before");
  const bt = (await call("GET", "/api/rooms/sb-room/soundboard", kbuy)).d.tabs;
  assert.ok(bt.find((x) => x.key === "season").clips.every((c) => !c.free), "October's board doesn't make Fireside free");
  // no refund: the buyer's balance didn't move after the purchase
  assert.equal(await bal(kbuy), b0 - 600000, "no PAT refund");
});
