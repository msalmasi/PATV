// 1.99acf botkeys.js + botupload.js: a chunked upload's /api/bot/upload/finish replays the assembled body on its target route
// (app.handle) - the request goes through the botkeys middleware twice. Each pass keeps its own context: one bot_route_log row
// per route, each under its own family (the finish route was never logged and the target was booked under /api/bot), so the
// target's family shows on /admin/keys#scopes - and a key enforced with the observed scopes still gets its uploads through.
//   node --test test/botkeys-reentry.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botkeys-reentry-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "shared-token-for-tests";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bk = require(path.join(repo, "botkeys"));
const botupload = require(path.join(repo, "botupload"));

bk._setArgon({ t: 1, m: 64, p: 1 });
require(path.join(repo, "opsalerts")).alert = async () => ({});
botupload._setDir(path.join(tmp, "botupload"));
const ACTOR = { userId: "u-owner", username: "owner" };
let base, server, KEY, delivered = [];

test.before(async () => {
  await bk.init();
  const app = express();
  app.use((req, res, next) => (req.path.startsWith("/api/bot/upload/") || req.path === "/api/voiceclone/bot/recorded" ? next() : express.json()(req, res, next)));
  app.use(bk.middleware);
  botupload.register(app, { isBotToken: bk.isBotToken, noTimers: true });
  // the target: its own parser (skipped - req._body) and its own bot check, as voiceclone.js does
  app.post("/api/voiceclone/bot/recorded", express.json({ limit: "12mb" }), (req, res) => {
    if (!bk.isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    delivered.push(req.body.n);
    res.json({ ok: true, n: req.body.n });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  KEY = (await bk.mint("pepe", "Pepe", ACTOR)).key;
});
test.after(() => server && server.close());

const post = (p, body, key = KEY) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, key ? { "x-patv-key": key } : {}),
                                                 body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));

async function upload(n) {
  const whole = Buffer.from(JSON.stringify({ n, wav: "A".repeat(3000) }));
  const id = "up" + crypto.randomBytes(6).toString("hex");
  const target = "/api/voiceclone/bot/recorded";
  const half = Math.ceil(whole.length / 2);
  const parts = [whole.subarray(0, half), whole.subarray(half)];
  for (let seq = 0; seq < parts.length; seq++) {
    const r = await post("/api/bot/upload/chunk", { id, target, seq, total: parts.length, size: whole.length, data: parts[seq].toString("base64") });
    assert.equal(r.status, 200, JSON.stringify(r.j));
  }
  return post("/api/bot/upload/finish", { id, target, sha256: crypto.createHash("sha256").update(whole).digest("hex") });
}

test("observe: a chunked upload logs the finish route under /api/bot and the target under its own family (one row each)", async () => {
  const r = await upload(1);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j, { ok: true, n: 1 }, "the target answered through /finish, authenticated by the key alone");
  await bk.flush();
  const rows = await getQuery("SELECT method, route, family, n FROM bot_route_log WHERE caller = 'pepe' ORDER BY route");
  const by = Object.fromEntries(rows.map((x) => [x.route, x]));
  assert.ok(by["/api/bot/upload/finish"], "the finish route is logged: " + JSON.stringify(rows));
  assert.equal(by["/api/bot/upload/finish"].family, "/api/bot");
  assert.equal(by["/api/bot/upload/finish"].n, 1);
  assert.ok(by["/api/voiceclone/bot/recorded"], "the target route is logged");
  assert.equal(by["/api/voiceclone/bot/recorded"].family, "/api/voiceclone/bot", "...under its own family (not /api/bot)");
  assert.equal(by["/api/voiceclone/bot/recorded"].n, 1, "once, not twice");
  assert.equal(by["/api/bot/upload/chunk"].n, 2);
  const v = await bk.adminView();
  assert.deepEqual(v.observed.pepe.map((o) => o.family), ["/api/bot", "/api/voiceclone/bot"], "both families show on /admin/keys#scopes");
});

test("enforce with the observed scopes: the upload still goes through; without the target's family the key doesn't count there", async () => {
  await bk.setMode("pepe", "enforce", ["/api/bot", "/api/voiceclone/bot"], ACTOR, { early: true });
  let r = await upload(2);
  assert.deepEqual(r.j, { ok: true, n: 2 }, "the observed scopes cover a chunked upload");
  await bk.setMode("pepe", "enforce", ["/api/bot"], ACTOR, { early: true });
  r = await upload(3);
  assert.equal(r.status, 403, "the target's family is checked on the replay (the key alone, no password)");
  await bk.flush();
  const ref = await getQuery("SELECT family, refused FROM bot_route_log WHERE caller = 'pepe' AND route = '(refused)'");
  assert.deepEqual(ref.map((x) => x.family), ["/api/voiceclone/bot"], "the refusal names the target's family");
  assert.deepEqual(delivered, [1, 2]);
  await bk.setMode("pepe", "observe", null, ACTOR);
});
