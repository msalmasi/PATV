// 1.99ol: the casino FRONT END switch per game (casino_settings bj_front / hm_front, set on /admin/games):
//   * "auto" (the default) follows the engine flag (bj_enabled / hm_enabled) - the pre-1.99ol behaviour,
//   * "patv" / "pepe" pick /casino/<game> or Pepe's tables (/blackjack, /poker) whatever the engine flag says,
//   * the page that isn't chosen redirects to the chosen one, an admin can still open it with ?preview=1,
//     a table's own page always opens, and the homepage's "tables" link follows (lobby path).
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-front.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-front-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const svc = require(path.join(repo, "casino", "service"));

const set = async (kv) => { for (const [k, v] of Object.entries(kv)) await svc.setSetting(k, v, "test"); return svc.loadSettings(true); };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('a1', 'boss', 'Boss', 'x', 'Admin')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('u1', 'ann', 'Ann', 'x', 'pleb')");
  await svc.boot({ tick: false });
});
test.after(() => svc.stop());

test("front end: auto follows the engine flag; patv / pepe override it; the values are checked", async () => {
  let st = await svc.loadSettings(true);
  assert.equal(st.bj_front, "auto");
  assert.equal(st.hm_front, "auto");
  assert.equal(svc.frontOf(st, "bj"), "pepe", "prod default: engine off -> Pepe's tables");
  st = await set({ bj_enabled: "1" });
  assert.equal(svc.frontOf(st, "bj"), "patv", "auto + engine on -> the PATV casino");
  assert.equal(svc.frontPath(st, "bj"), "/casino/blackjack");
  assert.equal(svc.frontPath(st, "holdem"), "/poker");
  assert.equal(svc.frontPath(st, "lobby"), "/tables", "mixed -> Pepe's lobby");
  st = await set({ bj_front: "pepe" });
  assert.equal(svc.frontPath(st, "bj"), "/blackjack", "pepe wins over the engine flag");
  assert.equal(st.bj_enabled, true, "the engine flag is untouched");
  st = await set({ bj_front: "patv", hm_front: "patv" });
  assert.equal(st.hm_enabled, false);
  assert.equal(svc.frontPath(st, "holdem"), "/casino/holdem", "patv wins over an engine that's off");
  assert.equal(svc.frontPath(st, "lobby"), "/casino/blackjack", "both PATV -> the PATV lobby");
  await assert.rejects(svc.setSetting("bj_front", "maybe", "test"), /auto, patv or pepe/);
  await set({ bj_front: "auto", hm_front: "auto", bj_enabled: "0" });
});

test("HTTP: the page that isn't chosen redirects; ?preview=1 lets an admin in; the settings API takes the keys", async () => {
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  const tables = require(path.join(repo, "tables"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.path; res.locals.t = (k) => k; next(); });
  const users = { a1: { userId: "a1", username: "boss" }, u1: { userId: "u1", username: "ann" } };
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); };
  tables.register(app, { isBotToken: (p) => p === "tok", addUser });
  routes.register(app, { isBotToken: (p) => p === "tok", addUser });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const J = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {});
  const go = async (url, uid) => {
    const r = await fetch(base + url, { headers: uid ? { "x-test-user": uid } : {}, redirect: "manual" });
    return r.status === 302 ? r.headers.get("location") : r.status;
  };
  const post = async (body, uid) => { const r = await fetch(base + "/api/casino/admin/settings", { method: "POST", headers: J(uid), body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  try {
    // only an Admin (or Pepe) can change it
    assert.equal((await post({ key: "bj_front", value: "patv" }, "u1")).status, 403);
    let r = await post({ key: "bj_front", value: "nope" }, "a1");
    assert.equal(r.status, 400);
    // default (auto, engines off): Pepe's pages; /casino/<game> goes there
    assert.equal(await go("/casino/blackjack"), "/blackjack");
    assert.equal(await go("/casino/holdem"), "/poker");
    assert.equal(await go("/blackjack"), 200);
    // blackjack -> the PATV casino (engine still off): /blackjack goes to /casino/blackjack, which now opens
    r = await post({ key: "bj_front", value: "patv" }, "a1");
    assert.ok(r.j.ok && r.j.settings.bj_front === "patv" && r.j.settings.bj_enabled === false, JSON.stringify(r.j));
    assert.equal(await go("/blackjack"), "/casino/blackjack");
    assert.equal(await go("/bj"), "/casino/blackjack");
    assert.equal(await go("/casino/blackjack"), 200);
    assert.equal(await go("/poker"), 200, "hold'em still on Pepe's tables");
    assert.equal(await go("/tables"), 200, "mixed: Pepe's lobby stays");
    // an admin can still open Pepe's page with ?preview=1; a member can't
    assert.equal(await go("/blackjack?preview=1", "a1"), 200);
    assert.equal(await go("/blackjack?preview=1", "u1"), "/casino/blackjack");
    // both PATV: Pepe's lobby goes to the PATV lobby; a Pepe table's own page still opens
    await post({ key: "hm_front", value: "patv" }, "a1");
    assert.equal(await go("/poker"), "/casino/holdem");
    assert.equal(await go("/tables"), "/casino/blackjack");
    assert.equal(await go("/casino/t/abcdef12"), 200);
    // back to Pepe's tables while the engine is ON: the PATV lobby redirects, an admin previews it
    await post({ key: "bj_enabled", value: "1" }, "a1");
    await post({ key: "bj_front", value: "pepe" }, "a1");
    assert.equal(await go("/casino/blackjack"), "/blackjack");
    assert.equal(await go("/casino/blackjack?preview=1", "a1"), 200);
    assert.equal(await go("/casino/blackjack?preview=1", "u1"), "/blackjack");
    assert.equal(await go("/blackjack"), 200);
    // the navbar helpers app.locals.casinoOn / casinoPath read the same (cached) settings
    await svc.loadSettings(true);
    assert.equal(app.locals.casinoOn("bj"), false);
    assert.equal(app.locals.casinoOn("holdem"), true);
    assert.equal(app.locals.casinoPath("bj"), "/blackjack");
    assert.equal(app.locals.casinoPath("lobby"), "/tables");
  } finally {
    server.close();
    await set({ bj_front: "auto", hm_front: "auto", bj_enabled: "0" });
  }
});
