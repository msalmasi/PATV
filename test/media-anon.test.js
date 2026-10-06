// Offline test for 1.99cb: POST /api/media/anon (Pepe's incognito backfill) and the anon flag on
// POST /api/media.   node --test test/media-anon.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-anon-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const express = require("express");
const { getQuery } = require(path.join(repo, "dbUtils"));
const media = require(path.join(repo, "media"));

let base, server;
const TOKEN = "bot-token";
const post = async (url, body, token = TOKEN) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
                                      body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
};
const row = async (id) => (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

test.before(async () => {
  await media.ready;
  const app = express();
  app.use((req, res, next) => (req.path === "/api/media" ? next() : express.json()(req, res, next)));
  media.register(app, { isBotToken: (t) => t === TOKEN, addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("upload: anon blanks the subject, a normal upload keeps it", async () => {
  assert.equal((await post("/api/media", { id: "aa000001", ct: "image/jpeg", image: img, subject: "bob", by: "alice", anon: true })).status, 200);
  assert.equal((await post("/api/media", { id: "aa000002", ct: "image/jpeg", image: img, subject: "carol", by: "alice" })).status, 200);
  const a = await row("aa000001"), b = await row("aa000002");
  assert.equal(a.anon, 1); assert.equal(a.subject, "");
  assert.equal(b.anon, 0); assert.equal(b.subject, "carol");
});

test("anon backfill: bot-only, marks subject / requester, ignores junk ids", async () => {
  assert.equal((await post("/api/media/anon", { items: [{ id: "aa000002", subject: true }] }, "nope")).status, 403);
  assert.equal((await row("aa000002")).subject, "carol");
  await post("/api/media", { id: "aa000003", ct: "image/jpeg", image: img, subject: "dave", by: "erin" });
  const r = await post("/api/media/anon", { items: [{ id: "aa000002", subject: true }, { id: "aa000003", by: true },
                                                    { id: "../x", subject: true }, { id: "aa000002" }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.marked, 2);
  const a = await row("aa000002"), b = await row("aa000003");
  assert.equal(a.anon, 1); assert.equal(a.subject, ""); assert.equal(a.by_user, "alice");
  assert.equal(b.anon, 0); assert.equal(b.subject, "dave"); assert.equal(b.by_user, "someone");
});
