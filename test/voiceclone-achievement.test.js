// Offline tests for 1.99wn: the 🦜 Voice of the Pond achievement (cf_voice_clone) for cloning your voice with !clonemyvoice.
// Awarded once when a consent goes ACTIVE (Pepe reports the VoiceBox profile made) - with XP, PAT and an announcement in Pepe's
// achievement feed; never on review / denied / failed recordings / a failed creation. Voices cloned before (a consent already
// active, or a pre-consent clone the voice store has as the person's own) get it QUIETLY, once. Revoking keeps it.
//   NODE_PATH=G:/PATV/node_modules node --test test/voiceclone-achievement.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.VC_DIR = path.join(tmp, "vc");
process.env.SB_DIR = path.join(tmp, "sb");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const VC = require(path.join(repo, "voiceclone"));
const VS = require(path.join(repo, "voicestore"));
const SB = require(path.join(repo, "soundboards"));
const funding = require(path.join(repo, "funding"));
let A;                                   // required once the old clones exist (it seeds + backfills on load)

let T = Date.UTC(2026, 9, 13, 18, 0, 0);
VC._setClock(() => T);
let base, server;
const users = new Map();
const U = {};
const xp = [];
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', 'pleb', 0, ?, ?, ?)`, [id, name, name, o.camfrog === undefined ? name + "cf" : o.camfrog, o.level == null ? 10 : o.level,
                  o.created || "2026-01-01 00:00:00"]);
  const x = { userId: id, username: name, class: "pleb" };
  users.set(id, x);
  return x;
}
const H = (x) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, x ? { "x-test-user": x.userId } : {});
async function call(method, url, x, body) {
  const r = await fetch(base + url, { method, headers: H(x), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const raw = await r.text();
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  return { status: r.status, d };
}
const bot = (p, b) => call("POST", p, null, Object.assign({ password: "bot" }, b));
const WAV = (() => { const h = Buffer.alloc(44 + 3200); h.write("RIFF", 0); h.write("WAVE", 8); return h.toString("base64"); })();
const reading = (c) => `${c.phrase.replace(/Code [\d-]+\.?$/, "")} code ${c.code.split("").join(" ")} ${c.script}`;
const has = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId = 'cf_voice_clone'", [u.userId])).length;
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? AND badgeId = 'cf_voice_clone'", [u.userId])).length;
const paid = async (u) => (await getQuery("SELECT points FROM transactions WHERE userId = ? AND type LIKE '%Voice of the Pond%'", [u.userId])).map((r) => r.points);
const xpFor = (u) => xp.filter((x) => x.userId === u.userId).map((x) => x.amount);

/** consent -> a passing (or failing) recording; returns the consent id */
async function consentAndRecord(u, { pass = true } = {}) {
  T += 60000;
  const r = await call("POST", "/api/voiceclone/consent", u, { attest18: true, consent: true, typed_login: u.username + "cf" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const row = (await getQuery("SELECT * FROM voice_consents WHERE user_id = ? AND status = 'phrase'", [u.userId]))[0];
  const rec = await bot("/api/voiceclone/bot/recorded", { id: row.id, login: u.username + "cf", audio: WAV, stt_text: pass ? reading(row) : "hello there",
                                                         single_holder: true, same_speaker: 99, secs: pass ? 40 : 10 });
  assert.equal(rec.status, 200, JSON.stringify(rec.d));
  return row.id;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  casino_banned INTEGER DEFAULT 0, archived_at INTEGER, discordId TEXT, email TEXT, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await funding.init();
  await VS.init();
  await SB.init();
  await VC.init();
  // ── cloned BEFORE the achievement existed ──
  U.consented = await mkUser("consented");          // a !clonemyvoice consent already active
  await runQuery(`INSERT INTO voice_consents (user_id, login, status, terms_version, voice_id, created) VALUES (?, 'consentedcf', 'active', 1, 'consentedcf', ?)`,
                 [U.consented.userId, T]);
  U.oldowner = await mkUser("oldowner");            // a pre-consent clone the store has as theirs (owner_user_id)
  await runQuery(`INSERT INTO voices (id, display, kind, owner_user_id, owner_login, status, created, updated) VALUES ('oldowner', 'OldOwner', 'clone', ?, 'oldownercf', 'active', ?, ?)`,
                 [U.oldowner.userId, T, T]);
  U.bylogin = await mkUser("bylogin");              // ... imported by Pepe with only the owner login
  await runQuery(`INSERT INTO voices (id, display, kind, owner_login, status, created, updated) VALUES ('bylogin', 'ByLogin', 'clone', 'bylogincf', 'active', ?, ?)`, [T, T]);
  U.revokedold = await mkUser("revokedold");        // a pre-consent clone already revoked -> nothing
  await runQuery(`INSERT INTO voices (id, display, kind, owner_user_id, owner_login, status, created, updated) VALUES ('revokedold', 'R', 'clone', ?, 'revokedoldcf', 'revoked', ?, ?)`,
                 [U.revokedold.userId, T, T]);
  U.stockfan = await mkUser("stockfan");            // owns nothing of their own (a stock voice) -> nothing
  await runQuery(`INSERT INTO voices (id, display, kind, status, created, updated) VALUES ('stocky', 'Stocky', 'stock', 'active', ?, ?)`, [T, T]);
  U.vet = await mkUser("vet");
  U.newbie = await mkUser("newbie", { created: "2026-10-10 00:00:00", level: 2 });
  U.flop = await mkUser("flop");
  U.vbfail = await mkUser("vbfail");
  funding.sync({ reserve: 10000000, flows: { voice_refund: "reserve" } });
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  const app = express();
  app.use((req, res, next) => (req.path === "/api/voiceclone/bot/recorded" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  VC.register(app, { addUser, isBotToken: (t) => t === "bot" });
  VS.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("catalog: 🦜 Voice of the Pond (web side, one-off, uncommon 5,000 XP / 50,000 PAT) with badge art and an en name", () => {
  const a = A.list().find((x) => x.id === "cf_voice_clone");
  assert.deepEqual([a.name, a.emoji, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side], ["Voice of the Pond", "🦜", "voice_cloned", 1, 5000, 50000, "uncommon", "web"]);
  assert.match(a.desc, /!clonemyvoice/);
  assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["ach.n.cf_voice_clone"], a.name);
  assert.equal(en["ach.d.cf_voice_clone"], a.desc);
});

test("backfill: voices cloned before get it QUIETLY (badge only: no XP, PAT or announcement), once; revoked / stock voices don't", async () => {
  const r = await A.voiceBackfill();
  assert.equal(r.done, true);
  for (const u of [U.consented, U.oldowner, U.bylogin]) {
    assert.equal(await has(u), 1, u.username);
    assert.equal(await feedFor(u), 0, "no announcement: " + u.username);
    assert.deepEqual(await paid(u), [], "no PAT: " + u.username);
    assert.deepEqual(xpFor(u), [], "no XP: " + u.username);
  }
  for (const u of [U.revokedold, U.stockfan, U.vet]) assert.equal(await has(u), 0, u.username);
  const meta = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = 'voiceclone_backfill'"))[0].v);
  assert.equal(meta.given, 3);
  // idempotent: run again (and forced), and an unrelated website check - still nothing loud, nothing doubled
  assert.equal((await A.voiceBackfill()).done, true);
  assert.equal((await A.voiceBackfill({ force: true })).given, 0);
  for (const u of [U.consented, U.oldowner, U.bylogin]) {
    await A.checkWeb(u.userId);
    assert.equal(await feedFor(u), 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_badges WHERE userId = ? AND badgeId = 'cf_voice_clone'", [u.userId]))[0].n, 1);
  }
});

test("not on a failed recording, staff review or a denial", async () => {
  await consentAndRecord(U.flop, { pass: false });
  await A.checkWeb(U.flop.userId);
  assert.equal(await has(U.flop), 0, "failed recording");
  const id = await consentAndRecord(U.newbie);
  assert.equal((await getQuery("SELECT status FROM voice_consents WHERE id = ?", [id]))[0].status, "review");
  await A.checkWeb(U.newbie.userId);
  assert.equal(await has(U.newbie), 0, "in review");
  const admin = { userId: "u_boss", username: "boss", class: "Admin" };
  users.set(admin.userId, admin);
  assert.equal((await call("POST", "/api/voiceclone/admin", admin, { id, action: "deny", reason: "no" })).status, 200);
  await A.checkWeb(U.newbie.userId);
  assert.equal(await has(U.newbie), 0, "denied");
});

test("not when approved but the VoiceBox profile failed (no voice yet)", async () => {
  const id = await consentAndRecord(U.vbfail);
  assert.equal((await getQuery("SELECT status FROM voice_consents WHERE id = ?", [id]))[0].status, "approved");
  await VC.createFailed({ id, why: "host down" });
  await A.checkWeb(U.vbfail.userId);
  assert.equal(await has(U.vbfail), 0);
});

test("ACTIVE (Pepe made the profile): awarded once with XP + PAT, queued for Pepe to announce", async () => {
  const id = await consentAndRecord(U.vet);
  assert.equal((await getQuery("SELECT status FROM voice_consents WHERE id = ?", [id]))[0].status, "approved");
  assert.equal(await has(U.vet), 0, "approved isn't active yet");
  const r = await bot("/api/voiceclone/bot/created", { id, name: "vetcf", profile_id: "p-vet" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  await A.checkWeb(U.vet.userId);        // the poke from created() is fire-and-forget; this waits for it
  assert.equal(await has(U.vet), 1);
  assert.equal(await feedFor(U.vet), 1, "announced");
  assert.deepEqual(xpFor(U.vet), [5000]);
  assert.deepEqual(await paid(U.vet), [50000], "PAT from the achievements budget");
  const f = (await A.feed()).find((x) => x.badgeId === "cf_voice_clone");
  assert.deepEqual([f.name, f.emoji, f.camfrogUsername], ["Voice of the Pond", "🦜", "vetcf"]);
  await A.checkWeb(U.vet.userId);
  assert.equal(await feedFor(U.vet), 1, "once");
  assert.deepEqual(xpFor(U.vet), [5000]);
});

test("revoking the voice keeps the achievement (achievements are for keeps); no second award", async () => {
  const r = await call("POST", "/api/voiceclone/revoke", U.vet, {});
  assert.equal(r.status, 200, JSON.stringify(r.d));
  await A.checkWeb(U.vet.userId);
  assert.equal(await has(U.vet), 1);
  assert.equal(await feedFor(U.vet), 1);
  assert.deepEqual(xpFor(U.vet), [5000]);
  assert.deepEqual(await paid(U.vet), [50000]);
});
