// Offline tests for 1.99bj website-action idempotency (actions.js): a form's one-time key (idem) can
// only ever queue one action, an identical action still waiting for Pepe isn't queued twice, the key
// reaches Pepe in the claim, and an existing pepe_actions table (no idem column) is migrated.
// Regression: Wattz's "Kick tricon when he mentions pokemon 1000" bounty went in from /bounties three
// times (actions 31-33 -> BT3/BT4/BT5).
//   node --test test/actions-idem.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actions-idem-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));

let base, server, actions;
test.before(async () => {
  // an OLD pepe_actions table, as on prod before 1.99bj (no idem column)
  await runQuery(`CREATE TABLE pepe_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
    site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT,
    status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`);
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'Hfddhh', 'wattz', 'x', 'watermelonfelon')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u2', 'other', 'other', 'x', 'other')");
  actions = require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 150));               // actions.js migrates the table on load
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  actions.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const BOUNTY = { kind: "cmd", cmd: "bounty", a0: "Kick tricon when he mentions pokemon", a1: "1000", a2: "by 7d", back: "/bounties" };

async function act(user, fields) {
  const r = await fetch(base + "/act", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-test-user": user },
    body: new URLSearchParams(fields).toString(),
  });
  const loc = r.headers.get("location") || "";
  return decodeURIComponent((loc.split("msg=")[1] || "").replace(/\+/g, " "));
}
const rows = (user) => getQuery("SELECT * FROM pepe_actions WHERE user_id = ? ORDER BY id", [user]);
const claim = () => fetch(base + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "bot-token" }) }).then((r) => r.json());
const ack = (results) => fetch(base + "/api/actions/ack", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "bot-token", results }) });

test("the old table gets the idem column + unique index", async () => {
  const cols = (await getQuery("PRAGMA table_info(pepe_actions)")).map((c) => c.name);
  assert.ok(cols.includes("idem"));
  const idx = await getQuery("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pepe_actions_idem'");
  assert.equal(idx.length, 1);
});

test("the same form key twice = one action", async () => {
  const m1 = await act("u1", { ...BOUNTY, idem: "key0000000000001" });
  const m2 = await act("u1", { ...BOUNTY, idem: "key0000000000001" });
  assert.match(m1, /Sent to Pepe/);
  assert.match(m2, /Already sent/);
  assert.equal((await rows("u1")).length, 1);
  const c = await claim();
  assert.equal(c.actions.length, 1);
  assert.equal(c.actions[0].idem, "key0000000000001");      // Pepe gets the key too
  await ack([{ id: c.actions[0].id, ok: true, message: "🎯 BOUNTY BT3" }]);
  // even after it's done, a resubmitted page with the same key isn't queued again
  assert.match(await act("u1", { ...BOUNTY, idem: "key0000000000001" }), /Already sent/);
  assert.equal((await rows("u1")).length, 1);
});

test("an identical action still waiting for Pepe isn't queued twice (no key: old page)", async () => {
  await runQuery("DELETE FROM pepe_actions");
  const f = { ...BOUNTY, a1: "2000" };
  assert.match(await act("u1", f), /Sent to Pepe/);
  assert.match(await act("u1", f), /Already sent/);
  assert.equal((await rows("u1")).length, 1);
  // another user, or different words, are separate actions
  assert.match(await act("u2", f), /Sent to Pepe/);
  assert.match(await act("u1", { ...f, a1: "3000" }), /Sent to Pepe/);
  assert.equal((await rows("u1")).length, 2);
  // once Pepe has answered, a NEW press (new key) is a new action - Pepe's own create guard decides
  const c = await claim();
  await ack(c.actions.map((a) => ({ id: a.id, ok: true, message: "ok" })));
  assert.match(await act("u1", { ...f, idem: "key0000000000002" }), /Sent to Pepe/);
  assert.equal((await rows("u1")).length, 3);
});

test("racing twins with one key: the unique index keeps one", async () => {
  await runQuery("DELETE FROM pepe_actions");
  const out = await Promise.allSettled([1, 2, 3].map(() => actions.queue("u1", { kind: "cmd", args: ["lotto", "quick", "1"], idem: "racekey000000001" })));
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
  assert.ok(out.filter((o) => o.status === "rejected").every((o) => o.reason.message === "duplicate"));
  assert.equal((await rows("u1")).length, 1);
});

test("a malformed key is ignored, not stored", async () => {
  await runQuery("DELETE FROM pepe_actions");
  await act("u1", { ...BOUNTY, idem: "<script>" });
  const r = await rows("u1");
  assert.equal(r.length, 1);
  assert.equal(r[0].idem, null);
});

test("the /act pages tag their forms with a key", () => {
  const p = fs.readFileSync(path.join(repo, "views", "partials", "actions.ejs"), "utf8");
  assert.match(p, /name = "idem"/);
  assert.match(p, /form\[action="\/act"\]/);
});
