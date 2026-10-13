// Offline tests for 1.99ri !clonemyvoice (voiceclone.js): consent (18+, consent, typed login, one-time phrase), Pepe's recording
// (the site re-scores the transcript: phrase >= 85%, the exact code, script >= 80%, >= 30 s, alone on the mic; 3 tries a day),
// auto-approval (30+ days, level 5+, 18+, same speaker >= 95) vs staff review, the VoiceBox profile -> an UNLISTED voice with
// others' free text OFF, revocation (the voice stops, soundboard clips in it removed, unlock buyers 50% back, deletion on both
// hosts), the consent record kept, audio deleted 30 days later, one clone per person, the real-account rule.
//   NODE_PATH=G:/PATV/node_modules node --test test/voiceclone.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.VC_DIR = path.join(tmp, "vc");
process.env.SB_DIR = path.join(tmp, "sb");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const VC = require(path.join(repo, "voiceclone"));
const VS = require(path.join(repo, "voicestore"));
const SB = require(path.join(repo, "soundboards"));
const funding = require(path.join(repo, "funding"));

let T = Date.UTC(2026, 9, 11, 18, 0, 0);
VC._setClock(() => T);
let base, server;
const users = new Map();
const U = {};
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', 'pleb', 1000000, ?, ?, ?)`, [id, name, name, o.camfrog === undefined ? name + "cf" : o.camfrog, o.level == null ? 10 : o.level,
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
  return { status: r.status, d, text: raw };
}
const bot = (p, b) => call("POST", p, null, Object.assign({ password: "bot" }, b));
const WAV = (() => { const h = Buffer.alloc(44 + 3200); h.write("RIFF", 0); h.write("WAVE", 8); return h.toString("base64"); })();
const reading = (c) => `${c.phrase.replace(/Code [\d-]+\.?$/, "")} code ${c.code.split("").join(" ")} ${c.script}`;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await funding.init();
  await VS.init();
  await SB.init();
  await VC.init();
  U.vet = await mkUser("vet");
  U.newbie = await mkUser("newbie", { created: "2026-10-01 00:00:00", level: 2 });
  U.buyer = await mkUser("buyer");
  U.auto = await mkUser("CF12345678", { camfrog: "autocf" });
  U.nolink = await mkUser("nolink", { camfrog: null });
  funding.sync({ reserve: 10000000, flows: { voice_refund: "reserve" } });
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

test("!clonemyvoice start: a real, linked account only", async () => {
  assert.equal((await bot("/api/voiceclone/bot/start", { camfrog: "vetcf" })).d.ok, true);
  assert.match((await bot("/api/voiceclone/bot/start", { camfrog: "autocf" })).d.error, /link your Camfrog name/, "Pepe's auto-made CF accounts can't sign in");
  assert.equal((await call("POST", "/api/voiceclone/bot/start", null, { password: "x", camfrog: "vetcf" })).status, 403);
});

test("consent: 18+, the consent box, the typed login -> a one-time phrase with a code and a script", async () => {
  let r = await call("POST", "/api/voiceclone/consent", U.vet, { attest18: false, consent: true, typed_login: "vetcf" });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/voiceclone/consent", U.vet, { attest18: true, consent: true, typed_login: "someoneelse" });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/voiceclone/consent", U.nolink, { attest18: true, consent: true, typed_login: "x" });
  assert.equal(r.status, 403);
  r = await call("POST", "/api/voiceclone/consent", U.vet, { attest18: true, consent: true, typed_login: "VetCF" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const c = r.d.consent;
  assert.equal(c.status, "phrase");
  assert.match(c.phrase, /^I am vetcf, and I consent to PATV cloning my voice\. Code \d-\d-\d-\d\.$/);
  assert.ok(c.script.length > 200);
  const s = (await bot("/api/voiceclone/bot/sync", {})).d;
  assert.equal(s.armed.length, 1);
  assert.equal(s.armed[0].login, "vetcf");
  const page = await call("GET", "/voices/clone", U.vet);
  assert.equal(page.status, 200);
  assert.match(page.text, /voice-clone\.js/);
});

test("recording: the site re-scores the transcript; failures count against 3 tries a day", async () => {
  const id = (await bot("/api/voiceclone/bot/sync", {})).d.armed[0].id;
  const row = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [id]))[0];
  let r = await bot("/api/voiceclone/bot/recorded", { id, login: "bobcf", audio: WAV, stt_text: reading(row), single_holder: true, same_speaker: 99, secs: 40 });
  assert.equal(r.status, 403, "only the person who consented");
  r = await bot("/api/voiceclone/bot/recorded", { id, login: "vetcf", audio: WAV, stt_text: "hello there", single_holder: false, same_speaker: 99, secs: 12 });
  assert.equal(r.d.passed, false);
  assert.equal(r.d.fails.length, 5, JSON.stringify(r.d.fails));
  assert.equal(r.d.attempts_left, 2);
  r = await bot("/api/voiceclone/bot/recorded", { id, login: "vetcf", audio: WAV, stt_text: reading(row).replace(row.code.split("").join(" "), "1 1 1 1"), single_holder: true, same_speaker: 99, secs: 40 });
  assert.deepEqual(r.d.fails, ["I didn't hear the code"]);
  // a pass: the vet account (old, level 10, 18+) with the same speaker -> auto-approved
  r = await bot("/api/voiceclone/bot/recorded", { id, login: "vetcf", audio: WAV, stt_text: reading(row), single_holder: true, same_speaker: 98.5, secs: 41 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.passed, r.d.status], [true, "approved"]);
  const after = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [id]))[0];
  assert.equal(after.auto_approved, 1);
  assert.ok(after.audio && fs.existsSync(path.join(process.env.VC_DIR, after.audio)), "the consent recording is kept");
  assert.equal(VC.score(row, "I am vetcf and I consent to patv cloning my voice code four seven two nine").code_ok, row.code === "4729");
  // 1.99wm: STT spells a login's digits and an acronym out ("Foamy One One One One", "P A T V") - still the phrase
  const spelled = { phrase: "I am foamy1111, and I consent to PATV cloning my voice. Code 7-3-9-3.", code: "7393", script: "x" };
  assert.ok(VC.score(spelled, "I am Foamy One One One One, and I consent to P A T V cloning my voice. Code seven three nine three").phrase_score >= 100);
  assert.ok(VC.score(spelled, "I am somebody else, and I agree to cloning a voice").phrase_score < 85, "another phrase still fails");
});

test("a young / low-level account goes to staff review; staff approve or deny", async () => {
  T += 60000;
  let r = await call("POST", "/api/voiceclone/consent", U.newbie, { attest18: true, consent: true, typed_login: "newbiecf" });
  assert.equal(r.status, 200);
  const id = r.d.consent ? (await getQuery("SELECT id FROM voice_consents WHERE user_id = ? AND status = 'phrase'", [U.newbie.userId]))[0].id : null;
  const row = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [id]))[0];
  r = await bot("/api/voiceclone/bot/recorded", { id, login: "newbiecf", audio: WAV, stt_text: reading(row), single_holder: true, same_speaker: 99, secs: 35 });
  assert.equal(r.d.status, "review");
  const admin = { userId: "u_boss", username: "boss", class: "Admin" };
  users.set(admin.userId, admin);
  const list = await call("GET", "/api/voiceclone/admin", admin);
  assert.ok(list.d.rows.some((x) => x.id === id && x.status === "review" && x.audio));
  r = await call("POST", "/api/voiceclone/admin", admin, { id, action: "deny", reason: "not clear enough" });
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT status FROM voice_consents WHERE id = ?", [id]))[0].status, "denied");
});

test("the profile: an UNLISTED clone with others' free text OFF, owned by the person; one per person", async () => {
  const s = (await bot("/api/voiceclone/bot/sync", {})).d;
  assert.equal(s.create.length, 1);
  const job = s.create[0];
  assert.equal(job.name, "vetcf");
  const a = await fetch(base + job.audio, { headers: { "x-bot-token": "bot" } });
  assert.equal(a.status, 200, "Pepe fetches the consent recording for the sample");
  assert.equal((await fetch(base + job.audio)).status, 403);
  const r = await bot("/api/voiceclone/bot/created", { id: job.id, name: "vetcf", profile_id: "p-vet" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const v = await VS.voice("vetcf");
  assert.deepEqual([v.kind, v.owner_user_id, v.listed, v.allow_free_text, v.allow_soundboard, v.royalty_pct, v.status, v.consent_id],
                   ["clone", U.vet.userId, 0, 0, 1, 30, "active", job.id]);
  assert.match((await bot("/api/voiceclone/bot/start", { camfrog: "vetcf" })).d.error, /one per person/);
});

test("revocation: stops at once, soundboard clips in it removed, buyers 50% back, deleted on both hosts, record kept, audio gone after 30 days", async () => {
  await runQuery("UPDATE voices SET listed = 1, price_unlock = 200000 WHERE id = 'vetcf'");
  const buy = await call("POST", "/api/voices/buy", U.buyer, { voice: "vetcf", ref: "ref0000000001" });
  assert.equal(buy.status, 200, JSON.stringify(buy.d));
  await runQuery(`INSERT INTO sb_clips (id, board, label, kind, voice, text, rarity, status, created) VALUES ('r-vet', 'room:X', 'Vet line', 'tts', 'vetcf', 'hi', 'epic', 'active', 1)`);
  let r = await call("POST", "/api/voiceclone/revoke", U.vet, {});
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.refunds, 1);
  assert.equal((await VS.voice("vetcf")).status, "revoked");
  assert.equal((await getQuery("SELECT status FROM sb_clips WHERE id = 'r-vet'"))[0].status, "removed");
  const refund = await getQuery("SELECT points, type FROM transactions WHERE userId = ? AND type LIKE '%half your unlock back%'", [U.buyer.userId]);
  assert.deepEqual(refund.map((x) => x.points), [100000], "50% of the unlock, from the Reserve");
  r = await call("POST", "/api/voiceclone/revoke", U.vet, {});
  assert.equal(r.status, 404, "nothing left to revoke");
  let s = (await bot("/api/voiceclone/bot/sync", {})).d;
  assert.deepEqual(s.delete.map((d) => [d.name, d.profile_id]), [["vetcf", "p-vet"]]);
  await bot("/api/voiceclone/bot/deleted", { id: s.delete[0].id, hosts: ["primary"] });
  s = (await bot("/api/voiceclone/bot/sync", {})).d;
  assert.deepEqual(s.delete[0].done, ["primary"], "still waiting for the fallback host");
  await bot("/api/voiceclone/bot/deleted", { id: s.delete[0].id, hosts: ["fallback"] });
  assert.equal((await bot("/api/voiceclone/bot/sync", {})).d.delete.length, 0);
  const rec = await call("GET", "/api/voiceclone/record", U.vet);
  assert.ok(rec.d.records.some((x) => x.status === "revoked" && x.revoked_at && x.terms_version === VC.TERMS_VERSION), "the consent record stays");
  const file = (await getQuery("SELECT audio FROM voice_consents WHERE user_id = ? AND status = 'revoked'", [U.vet.userId]))[0].audio;
  assert.ok(fs.existsSync(path.join(process.env.VC_DIR, file)));
  T += 31 * 86400000;
  assert.ok((await VC.sweep()) >= 1);
  assert.ok(!fs.existsSync(path.join(process.env.VC_DIR, file)), "the recording is deleted 30 days after the revocation");
});
