// pvpcfg.js (1.99yc): the duel / brawl knobs Pepe reads (POST /api/pvp/cfg) and admins set on /admin/games#pvp.
//   NODE_PATH=G:/PATV/node_modules node --test test/pvpcfg.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvpcfg-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const pvpcfg = require(path.join(repo, "pvpcfg"));

let base, server;
const STREAK = { streak_min_stake: 10000, streak_min_acct_days: 14, streak_min_level: 5, streak_min_sheet_games: 10, streak_max_gap: 12, streak_repeat_hours: 0 };   // 1.99aco: the win-streak anti-farming knobs (pepe_pvpstreak.py)
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, class TEXT DEFAULT 'pleb')`);
  await runQuery("INSERT INTO users (userId, username, class) VALUES ('u_adm', 'adm', 'Admin'), ('u_joe', 'joe', 'pleb')");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { req.user = req.get("x-user") ? { userId: req.get("x-user"), username: req.get("x-user").slice(2) } : null; next(); };
  pvpcfg.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, j: await r.json() }));

test("defaults match Pepe's (pepe_pvp.PVP_CFG_DEFAULTS) and clean() clamps like his", async () => {
  pvpcfg._reset();
  assert.deepEqual(await pvpcfg.get(), { accept_quiet_secs: 15, replace_max: 3, replace_window_secs: 120, ...STREAK });
  assert.deepEqual(pvpcfg.clean({ accept_quiet_secs: 9999, replace_max: 0, replace_window_secs: "x" }),
    { accept_quiet_secs: 300, replace_max: 1, replace_window_secs: 120, ...STREAK });
  // 1.99aco: the win-streak knobs clamp the same way; the stake floor never goes under 1,000 (no free streak rings)
  assert.deepEqual(pvpcfg.clean({ streak_min_stake: 0, streak_min_acct_days: -1, streak_max_gap: 999, streak_min_level: "x" }),
    { accept_quiet_secs: 15, replace_max: 3, replace_window_secs: 120, ...STREAK, streak_min_stake: 1000, streak_min_acct_days: 0, streak_max_gap: 60 });
  assert.deepEqual(pvpcfg.clean({ accept_quiet_secs: 0 }).accept_quiet_secs, 0, "0 = off is allowed");
  const botFile = path.join(repo, "camfrog-bot", "pepe_pvp.py");
  const py = fs.existsSync(botFile) ? fs.readFileSync(botFile, "utf8").match(/PVP_CFG_DEFAULTS = (\{[^}]*\})/) : null;
  if (py) assert.deepEqual(JSON.parse(py[1]), pvpcfg.DEFAULTS, "the bot's defaults are the same (when the bot repo sits next to this one)");
});

test("Pepe reads them with the bot token only", async () => {
  assert.equal((await post("/api/pvp/cfg", { password: "nope" })).status, 403);
  const r = await post("/api/pvp/cfg", { password: "bot-token" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { ok: true, accept_quiet_secs: 15, replace_max: 3, replace_window_secs: 120, ...STREAK });
});

test("admins set them (same-site fetch), clamped; nobody else can", async () => {
  const fetchH = { "X-Requested-With": "fetch" };
  assert.equal((await post("/api/admin/pvp-cfg", { replace_max: 5 }, fetchH)).status, 401);
  assert.equal((await post("/api/admin/pvp-cfg", { replace_max: 5 }, { ...fetchH, "x-user": "u_joe" })).status, 403);
  assert.equal((await post("/api/admin/pvp-cfg", { replace_max: 5 }, { "x-user": "u_adm" })).status, 403, "not a same-site fetch");
  const r = await post("/api/admin/pvp-cfg", { accept_quiet_secs: 30, replace_max: 50, replace_window_secs: 10 }, { ...fetchH, "x-user": "u_adm" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.cfg, { accept_quiet_secs: 30, replace_max: 20, replace_window_secs: 30, ...STREAK });
  pvpcfg._reset();
  assert.deepEqual((await post("/api/pvp/cfg", { password: "bot-token" })).j,
    { ok: true, accept_quiet_secs: 30, replace_max: 20, replace_window_secs: 30, ...STREAK }, "stored, and Pepe gets the new values");
  // 1.99aco: the streak knobs; a knob the request leaves out keeps its saved value (it used to fall back to the default)
  const r2 = await post("/api/admin/pvp-cfg", { streak_min_stake: 25000, streak_min_acct_days: 30, streak_max_gap: 4 }, { ...fetchH, "x-user": "u_adm" });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.j.cfg, { accept_quiet_secs: 30, replace_max: 20, replace_window_secs: 30, ...STREAK, streak_min_stake: 25000, streak_min_acct_days: 30, streak_max_gap: 4 });
  pvpcfg._reset();
  const p2 = (await post("/api/pvp/cfg", { password: "bot-token" })).j;
  assert.deepEqual([p2.streak_min_stake, p2.streak_min_acct_days, p2.streak_min_level, p2.streak_max_gap, p2.replace_max], [25000, 30, 5, 4, 20], "Pepe gets them");
  const g = await fetch(base + "/api/admin/pvp-cfg", { headers: { "x-user": "u_adm" } }).then((x) => x.json());
  assert.equal(g.ok, true);
  assert.deepEqual(g.limits.replace_max, [1, 20]);
  assert.deepEqual(g.limits.streak_min_stake, [1000, 10000000]);
  assert.equal(g.defaults.streak_min_stake, 10000);
});

test("the card lives on /admin/games#pvp, never on a public page", () => {
  const games = fs.readFileSync(path.join(repo, "views/admin/games.ejs"), "utf8");
  assert.ok(games.includes("admin-pvpcfg"));
  const part = fs.readFileSync(path.join(repo, "views/partials/admin-pvpcfg.ejs"), "utf8");
  assert.ok(part.includes('id="pvp"') && part.includes("admin-pvpcfg.js"));
  for (const f of fs.readdirSync(path.join(repo, "views"))) {
    if (!f.endsWith(".ejs")) continue;
    assert.ok(!fs.readFileSync(path.join(repo, "views", f), "utf8").includes("admin-pvpcfg"), `${f} doesn't carry the card`);
  }
});
