// 1.99yx: padfines.js - admin pad vault fines / transfers (Pepe's pepe_padfine.py moves the PAT; the site asks and records).
//   * request(): validates (pads, amount, reason, same pad), queues ONE website action roomvault.admin with the right args,
//     a pad_vault_admin_moves row + an admin_audit row; the same key twice queues once
//   * record() (Pepe's report): the row -> done, admin_audit, the owner's inbox notice (+ the receiving owner on a transfer),
//     a pad event; a repeat records nothing twice
//   * the bot route needs the bot token; the admin routes need an Admin + same-site fetch + the password step-up
//   * roomvaults keeps the new history kinds and the signed adm day field
//   NODE_PATH=G:/PATV/node_modules node --test test/padfines.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padfines-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PF = require(path.join(repo, "padfines"));
const RV = require(path.join(repo, "roomvaults"));

const DRAMA = "DRAMA_CENTRAL", PAD = "PepeFrog.Room", PLANT = "plant_based_chatting";
let admin, owner, owner2, pleb, base, server, who = null;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 1)`);
  const pw = await bcrypt.hash("hunter22", 4);
  const mk = async (id, name, cls, cf) => { await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?, ?)", [id, name, name, pw, cls, cf || null]); return { userId: id, username: name, class: cls }; };
  admin = await mk("a1", "boss", "Admin", "bosscf");
  owner = await mk("o1", "dramaqueen", "pleb", "dq");
  owner2 = await mk("o2", "pb", "pleb", "foamy1111");
  pleb = await mk("p1", "nobody", "pleb");
  await rooms.init();
  await rooms.addRoom(DRAMA, null, "test");
  await rooms.setOwner(DRAMA, "dramaqueen", "test");
  await rooms.setOwner(PLANT, "foamy1111", "test");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const h = req.headers["x-test-user"]; who = h === "admin" ? admin : h === "pleb" ? pleb : null; next(); });
  PF.register(app, { addUser: (req, res, next) => { req.user = who; next(); }, isBotToken: (t) => t === "bot-token" });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (url, body, user, extra = {}) => fetch(base + url, { method: "POST", headers: Object.assign({ "Content-Type": "application/json", "x-test-user": user || "", Host: "x" }, extra), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("request: validation", async () => {
  await assert.rejects(PF.request(admin, { op: "fine", from: "nope", amount: 5, reason: "abc" }), /No such pad/);
  await assert.rejects(PF.request(admin, { op: "fine", from: DRAMA, amount: 0, reason: "abc" }), /whole amount/);
  await assert.rejects(PF.request(admin, { op: "fine", from: DRAMA, amount: "1.5", reason: "abc" }), /whole amount/);
  await assert.rejects(PF.request(admin, { op: "fine", from: DRAMA, amount: 5, reason: "x" }), /reason/);
  await assert.rejects(PF.request(admin, { op: "transfer", from: DRAMA, to: DRAMA, amount: 5, reason: "abc" }), /same pad/);
  await assert.rejects(PF.request(admin, { op: "burn", from: DRAMA, amount: 5, reason: "abc" }), /fine or transfer/);
});

test("request: one action, one row, one audit row; the same key queues once", async () => {
  const r = await PF.request(admin, { op: "transfer", from: DRAMA, to: PAD, amount: 10000000, reason: "approved one-off move", key: "abcdefgh1234" });
  assert.equal(r.key, "web-abcdefgh1234");
  const a = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [r.id]))[0];
  assert.equal(a.kind, "roomvault.admin");
  assert.deepEqual(JSON.parse(a.args), ["transfer", DRAMA, PAD, "10000000", "abcdefgh1234", "approved one-off move"]);
  const again = await PF.request(admin, { op: "transfer", from: DRAMA, to: PAD, amount: 10000000, reason: "approved one-off move", key: "abcdefgh1234" });
  assert.equal(again.duplicate, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'roomvault.admin'"))[0].n, 1);
  const row = (await getQuery("SELECT * FROM pad_vault_admin_moves WHERE key = ?", [r.key]))[0];
  assert.equal(row.status, "queued");
  assert.equal(row.amount, 10000000);
  const au = await getQuery("SELECT * FROM admin_audit WHERE action = 'padvault-transfer-request'");
  assert.equal(au.length, 1);
  assert.equal(au[0].admin_id, admin.userId);
});

test("record: done, audited, the owners notified, idempotent", async () => {
  const mv = { key: "web-abcdefgh1234", op: "transfer", room: DRAMA, to: PLANT, amount: 10000000, reason: "approved one-off move",
               actor: "web:boss", via: "web", site_user: admin.userId, legs: [["room:" + PLANT, 10000000]], at: Date.now(), balance: 688402, to_balance: 10418565 };
  const keys = await PF.record([mv]);
  assert.deepEqual(keys, ["web-abcdefgh1234"]);
  assert.equal((await getQuery("SELECT status FROM pad_vault_admin_moves WHERE key = ?", [mv.key]))[0].status, "done");
  const n1 = await getQuery("SELECT * FROM inbox WHERE user_id = ?", [owner.userId]);
  assert.equal(n1.length, 1);
  assert.match(n1[0].title, /moved out of the pad vault/);
  assert.match(n1[0].body, /approved one-off move/);
  const n2 = await getQuery("SELECT * FROM inbox WHERE user_id = ?", [owner2.userId]);
  assert.equal(n2.length, 1);
  assert.match(n2[0].title, /moved into the pad vault/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'padvault-transfer'"))[0].n, 1);
  await PF.record([mv]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'padvault-transfer'"))[0].n, 1, "a repeat audits nothing twice");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ?", [owner.userId]))[0].n, 1);
  // a chat fine Pepe ran on his own (no queued row): recorded, the actor's account found by Camfrog login
  await PF.record([{ key: "chat-f1a2b3c4d5", op: "fine", room: DRAMA, amount: 500000, reason: "farming the vault", actor: "bosscf", via: "chat",
                     legs: [["reserve", 500000]], at: Date.now(), balance: 188402 }]);
  const au = (await getQuery("SELECT * FROM admin_audit WHERE action = 'padvault-fine'"))[0];
  assert.equal(au.admin_id, admin.userId);
  const n3 = await getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id DESC", [owner.userId]);
  assert.match(n3[0].title, /fined 500,000 PAT/);
  const list = await PF.recent(10);
  assert.equal(list.moves.length, 2);
  assert.deepEqual(list.route.shares, [["reserve", 100]]);
});

test("routes: the bot token, admins only, the password step-up", async () => {
  let r = await post("/api/g/roomvaults/admin-move", { password: "nope", moves: [] });
  assert.equal(r.status, 403);
  r = await post("/api/g/roomvaults/admin-move", { password: "bot-token", moves: [] });
  assert.equal(r.status, 200);
  r = await post("/api/admin/padvault/move", { op: "fine", from: DRAMA, amount: 5, reason: "abc" }, "pleb", { "X-Requested-With": "fetch" });
  assert.equal(r.status, 403);
  r = await post("/api/admin/padvault/move", { op: "fine", from: DRAMA, amount: 5, reason: "abc", nonce: "x", password: "hunter22" }, "admin");
  assert.equal(r.status, 403, "not a same-site fetch");
});

test("roomvaults keeps the admin kinds and the adm day field", async () => {
  await RV.sync({ on: true, rooms: [{ id: DRAMA, balance: 5, days: { "2026-10-14": { adm: -500000, in: 3 } },
    history: [{ ts: 1, kind: "fine", flow: "fine_pad", amount: -500000 }, { ts: 2, kind: "xfer_in", flow: "transfer", amount: 7 }] }] });
  const c = await RV.card(DRAMA, null, {});
  assert.deepEqual(c.history.map((h) => h.kind), ["fine", "xfer_in"]);
  const row = (await getQuery("SELECT days FROM room_vault_state WHERE room_id = ?", [DRAMA]))[0];
  assert.equal(JSON.parse(row.days)["2026-10-14"].adm, -500000);
});
