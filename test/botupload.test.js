// Offline tests for 1.99vk botupload.js - Pepe's big uploads in chunks under nginx's 1m body limit: chunking + reassembly
// into the target route (its own bot check and answer), a sha256 / size mismatch refused, a retried chunk idempotent (a
// different slice under the same number refused), an abandoned upload expiring, finish delivering once, targets limited to
// the list and capped at their route's limit, bot-only; and !clonemyvoice end to end with a 3 MB recording - one POST is
// refused by the (simulated) nginx limit, the chunked one passes and stores the WAV byte for byte.
//   node --test test/botupload.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botupload-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.VC_DIR = path.join(tmp, "vc");
process.env.SB_DIR = path.join(tmp, "sb");
process.env.BOTUPLOAD_DIR = path.join(tmp, "bu");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BU = require(path.join(repo, "botupload"));
const VC = require(path.join(repo, "voiceclone"));
const VS = require(path.join(repo, "voicestore"));
const SB = require(path.join(repo, "soundboards"));
const funding = require(path.join(repo, "funding"));

let T = Date.UTC(2026, 9, 13, 18, 0, 0);
BU._setClock(() => T);
VC._setClock(() => T);
let base, server;
const users = new Map();
const NGINX_MAX = 1024 * 1024;          // client_max_body_size 1m
const seen = [];                         // what the fake target got

async function call(url, body) {
  const raw = JSON.stringify(body);
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, sent: Buffer.byteLength(raw) };
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Pepe's side (frida-bot _backend_post_chunked): the whole JSON body in 384 KB slices, then finish. */
async function chunked(target, payload, { id = crypto.randomBytes(8).toString("hex"), slice = 384 * 1024, skip = [], shaOf } = {}) {
  const raw = Buffer.from(JSON.stringify(Object.assign({}, payload, { password: "bot" })));
  const total = Math.ceil(raw.length / slice);
  const answers = [];
  for (let i = 0; i < total; i++) {
    if (skip.includes(i)) continue;
    const r = await call("/api/bot/upload/chunk", { password: "bot", id, target, seq: i, total, size: raw.length,
                                                     data: raw.subarray(i * slice, (i + 1) * slice).toString("base64") });
    assert.ok(r.sent < NGINX_MAX, "every chunk fits under nginx's limit");
    answers.push(r);
  }
  const fin = await call("/api/bot/upload/finish", { password: "bot", id, target, sha256: shaOf ? shaOf(raw) : sha(raw) });
  return { id, raw, total, answers, fin };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await funding.init();
  await VS.init();
  await SB.init();
  await VC.init();
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES ('u_vet', 'vet', 'vet', 'x', 'pleb', 0, 'vetcf', 10, '2026-01-01 00:00:00')`);
  users.set("u_vet", { userId: "u_vet", username: "vet", class: "pleb" });
  const app = express();
  // nginx in front: client_max_body_size 1m
  app.use((req, res, next) => (Number(req.get("content-length") || 0) > NGINX_MAX ? res.status(413).send("413 Request Entity Too Large") : next()));
  // like index.js: the big routes (and the chunk route) parse their own bodies, everything else gets the 100 KB parser
  const own = new Set(["/api/voiceclone/bot/recorded", "/api/bot/upload/chunk", "/api/bridge/micclip"]);
  app.use((req, res, next) => (own.has(req.path) ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  BU.register(app, { isBotToken: (t) => t === "bot", noTimers: true });
  VC.register(app, { addUser, isBotToken: (t) => t === "bot" });
  VS.register(app, { addUser, isBotToken: (t) => t === "bot" });
  // a stand-in target (micclip's limit and its bot check): echoes what arrived
  app.post("/api/bridge/micclip", express.json({ limit: "9mb" }), (req, res) => {
    if ((req.body || {}).password !== "bot") return res.status(403).json({ ok: false });
    seen.push(req.body);
    res.json({ ok: true, got: Buffer.from(String(req.body.data || ""), "base64").length, via: req.botUpload ? "chunks" : "post" });
  });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("a body over nginx's limit: one POST gets 413, the chunks reassemble into the target route", async () => {
  const blob = crypto.randomBytes(2 * 1024 * 1024 + 123);       // ~2.7 MB of base64
  const one = await call("/api/bridge/micclip", { password: "bot", id: "x", data: blob.toString("base64") });
  assert.equal(one.status, 413, "nginx refuses the single POST");
  const r = await chunked("/api/bridge/micclip", { id: "x", data: blob.toString("base64") });
  assert.ok(r.total >= 7);
  assert.ok(r.answers.every((a) => a.status === 200 && a.d.ok));
  assert.equal(r.answers[r.answers.length - 1].d.have, r.total);
  assert.equal(r.fin.status, 200, JSON.stringify(r.fin.d));
  assert.deepEqual(r.fin.d, { ok: true, got: blob.length, via: "chunks" }, "the target's own answer comes back from finish");
  assert.equal(seen[seen.length - 1].data, blob.toString("base64"), "byte for byte");
  // delivered: the slices are gone, a retried finish doesn't apply it twice
  assert.ok(!fs.existsSync(path.join(process.env.BOTUPLOAD_DIR, r.id, "p0")));
  const again = await call("/api/bot/upload/finish", { password: "bot", id: r.id, target: "/api/bridge/micclip", sha256: sha(r.raw) });
  assert.equal(again.status, 409);
  assert.equal(again.d.delivered, true);
  assert.equal(seen.length, 1);
  // and a small body still goes in one POST
  const small = await call("/api/bridge/micclip", { password: "bot", data: "AAAA" });
  assert.equal(small.d.via, "post");
});

test("a sha256 mismatch is refused and the upload thrown away", async () => {
  const n = seen.length;
  const r = await chunked("/api/bridge/micclip", { data: crypto.randomBytes(900 * 1024).toString("base64") }, { shaOf: () => "0".repeat(64) });
  assert.equal(r.fin.status, 400);
  assert.equal(r.fin.d.code, "E_SHA");
  assert.equal(seen.length, n, "nothing reached the target");
  const later = await call("/api/bot/upload/finish", { password: "bot", id: r.id, target: "/api/bridge/micclip", sha256: sha(r.raw) });
  assert.equal(later.status, 404, "gone - send it again");
});

test("a retried chunk is idempotent; a different slice under the same number is refused; a missing one blocks finish", async () => {
  const raw = Buffer.from(JSON.stringify({ password: "bot", data: crypto.randomBytes(600 * 1024).toString("base64") }));
  const id = "retry-" + crypto.randomBytes(4).toString("hex"), slice = 384 * 1024, total = Math.ceil(raw.length / slice);
  const part = (i) => raw.subarray(i * slice, (i + 1) * slice).toString("base64");
  const send = (i, data) => call("/api/bot/upload/chunk", { password: "bot", id, target: "/api/bridge/micclip", seq: i, total, size: raw.length, data: data || part(i) });
  assert.equal((await send(0)).d.have, 1);
  const dup = await send(0);
  assert.equal(dup.status, 200);
  assert.equal(dup.d.dup, true);
  assert.equal(dup.d.have, 1);
  assert.equal((await send(0, Buffer.from("something else").toString("base64"))).status, 409);
  const early = await call("/api/bot/upload/finish", { password: "bot", id, target: "/api/bridge/micclip", sha256: sha(raw) });
  assert.equal(early.status, 409);
  assert.deepEqual(early.d.missing, [1, 2].filter((i) => i < total));
  for (let i = 1; i < total; i++) await send(i);
  await send(1);                                                    // a late retry of a slice
  const fin = await call("/api/bot/upload/finish", { password: "bot", id, target: "/api/bridge/micclip", sha256: sha(raw) });
  assert.equal(fin.status, 200);
  assert.equal(fin.d.via, "chunks");
  // the same id with another target / size is refused
  const other = await call("/api/bot/upload/chunk", { password: "bot", id: "mixup-123", target: "/api/bridge/micclip", seq: 0, total: 2, size: 600000, data: part(0) });
  assert.equal(other.status, 200);
  assert.equal((await call("/api/bot/upload/chunk", { password: "bot", id: "mixup-123", target: "/api/bridge/micclip", seq: 1, total: 3, size: 900000, data: part(1) })).status, 409);
});

test("an abandoned upload expires", async () => {
  BU.sweep(T + 100 * BU.TTL);                                        // a clean slate (earlier tests' markers)
  const id = "abandoned-1";
  const r = await call("/api/bot/upload/chunk", { password: "bot", id, target: "/api/bridge/micclip", seq: 0, total: 2, size: 500000, data: Buffer.alloc(1000, 1).toString("base64") });
  assert.equal(r.status, 200);
  assert.equal(BU.sweep(T + BU.TTL - 1000), 0, "still in time");
  assert.ok(fs.existsSync(path.join(process.env.BOTUPLOAD_DIR, id)));
  assert.ok(BU.sweep(T + BU.TTL + 1000) >= 1);
  assert.ok(!fs.existsSync(path.join(process.env.BOTUPLOAD_DIR, id)));
  const fin = await call("/api/bot/upload/finish", { password: "bot", id, target: "/api/bridge/micclip", sha256: "0".repeat(64) });
  assert.equal(fin.status, 404);
});

test("bot-only, listed targets only, capped at the route's own limit, chunk size bounded", async () => {
  const c = (b) => call("/api/bot/upload/chunk", Object.assign({ password: "bot", id: "guard-001", target: "/api/bridge/micclip", seq: 0, total: 1, size: 10, data: "AAAA" }, b));
  assert.equal((await c({ password: "nope" })).status, 403);
  assert.equal((await call("/api/bot/upload/finish", { password: "nope", id: "guard-001", target: "/api/bridge/micclip", sha256: "0".repeat(64) })).status, 403);
  const t = await c({ target: "/api/bonus/chatwinner" });
  assert.equal(t.status, 400);
  assert.equal(t.d.code, "E_TARGET");
  assert.equal((await c({ target: "/api/users/camfrog/register" })).status, 400);
  assert.equal((await c({ size: 9 * 1024 * 1024 + 1, total: 30 })).status, 413, "over micclip's 9 MB");
  assert.equal((await c({ id: "../../etc" })).status, 400);
  assert.equal((await c({ data: "not base64!" })).status, 400);
  assert.equal((await c({ seq: 5 })).status, 400);
  assert.equal((await c({ data: Buffer.alloc(BU.CHUNK_MAX + 1).toString("base64"), size: 2 * BU.CHUNK_MAX, total: 2 })).status, 400, "a slice is at most 512 KB");
  assert.ok(BU.TARGETS["/api/voiceclone/bot/recorded"] >= 12 * 1024 * 1024);
});

test("!clonemyvoice end to end: a 3 MB consent recording is refused in one POST and passes in chunks", async () => {
  let r = await call("/api/voiceclone/bot/start", { password: "bot", camfrog: "vetcf" });
  assert.equal(r.d.ok, true);
  const fetchU = (url, body) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "u_vet", "x-requested-with": "fetch", origin: base },
                                                    body: JSON.stringify(body) }).then((x) => x.json());
  const cons = await fetchU("/api/voiceclone/consent", { attest18: true, consent: true, typed_login: "vetcf" });
  assert.equal(cons.ok, true, JSON.stringify(cons));
  const id = (await call("/api/voiceclone/bot/sync", { password: "bot" })).d.armed[0].id;
  const row = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [id]))[0];
  const text = `${row.phrase.replace(/Code [\d-]+\.?$/, "")} code ${row.code.split("").join(" ")} ${row.script}`;
  const wav = Buffer.alloc(3 * 1024 * 1024);                                  // 3 MB: ~98 s of 16 kHz mono
  wav.write("RIFF", 0); wav.write("WAVE", 8);
  crypto.randomBytes(wav.length - 44).copy(wav, 44);
  const body = { id, login: "vetcf", audio: wav.toString("base64"), stt_text: text, single_holder: true, same_speaker: 99, secs: 59.5 };
  const one = await call("/api/voiceclone/bot/recorded", Object.assign({ password: "bot" }, body));
  assert.equal(one.status, 413, "the prod failure: nginx answers 413");
  const c = await chunked("/api/voiceclone/bot/recorded", body);
  assert.equal(c.fin.status, 200, JSON.stringify(c.fin.d));
  assert.equal(c.fin.d.ok, true);
  assert.equal(c.fin.d.passed, true, JSON.stringify(c.fin.d));
  const after = (await getQuery("SELECT * FROM voice_consents WHERE id = ?", [id]))[0];
  assert.ok(after.audio, "the consent audio is stored");
  assert.ok(fs.readFileSync(path.join(process.env.VC_DIR, after.audio)).equals(wav), "byte for byte");
});
