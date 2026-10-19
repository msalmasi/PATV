// 1.99ada: the pad-vault payout recipe's percentages owned by the site (recipecfg.js, the /admin/economy 💸 card, Pepe 1.99adb):
//   * clean(): the shared vectors V1-V12 (Pepe's clean_site_cfg pins the same ones in recipe_test.py)
//   * roomvaults.sync answers recipe_cfg: null before any save, {rev, cfg, at, by} after; a read error OMITS the field
//   * GET /api/admin/econ/recipe: Admins only (econ.telemetry_policy); can_edit only for a Pepe owner; the state machine
//     not_set / pending / applied / refused / old_pepe from Pepe's reported cfg_rev / cfg_src / cfg_error
//   * POST /api/admin/econ/recipe: owner only, same-site fetch + CSRF token, single-use nonce, account password; invalid
//     values refused (nothing saved); a save = rev + one admin_audit 'recipe-cfg' row; the same values = unchanged (no rev,
//     no audit); a stale base_rev = 409 with the saved values
//   * POST /api/g/recipe/cfg (Pepe's chat write-through): bot token; by "chat:<login>", audited as the linked account (or
//     "pepe"); stale -> 409
//   * no row saved: any base_rev is accepted and the first rev continues past the newest seen (review fix: a restored table
//     left Pepe's chat write-through stuck on 409 {saved: null})
//   * the last payout day marks a capped allowance (slice + unpaid shares > allowance)
//   * the card renders: present for Admins, the form disabled for a non-owner, live for an owner (the page script itself:
//     test/admin-recipe-js.test.js)
//   NODE_PATH=G:/PATV/node_modules node --test test/recipe-cfg.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-cfg-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const ejs = require("ejs");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const RC = require(path.join(repo, "recipecfg"));
const RV = require(path.join(repo, "roomvaults"));
const P = require(path.join(repo, "pepecontrol"));
const rooms = require(path.join(repo, "rooms"));

const V = (o, g, s, p, gm, u) => ({ owner_pct: o, gang_pct: g, streamer_pct: s, people_pct: p, games_pct: gm, games_unpaid: u });
const V1 = V(0.15, 0.15, 0.25, 0.35, 0.10, 1), V2 = V(0.15, 0.15, 0.25, 0.35, 0.20, 1);
const V5x = V(0.15, 0.15, 0.25, 0.46, 0.10, 1);       // owner + gang + streamers + regulars = 101 %: refused (see V5 below)
const PEPE_CFG = { owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.1, cap_i7: 0.25, owner_days: 3, elig_days: 3,
                   vwm_ref: 600, people_ref: 20, convoy_min: 25000, min_lines: 10, min_mic: 5, games_unpaid: 1, hour: 5 };
const PLANT = "plant_based_chatting";

let base, server;
const audits = () => getQuery("SELECT * FROM admin_audit WHERE action = 'recipe-cfg' ORDER BY id");
const H = (u, extra = {}) => Object.assign({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra);
const get = (p, u) => fetch(base + p, { headers: H(u) }).then(async (r) => ({ status: r.status, j: await r.json(), cc: r.headers.get("cache-control") }));
const post = (p, u, body, extra) => fetch(base + p, { method: "POST", headers: H(u, extra), body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, j: await r.json() }));
const NAMES = { own: "boss", adm: "admin2", stf: "staffer", mem: "member" };
const csrf = (u) => ({ "x-csrf-token": P.csrfToken(NAMES[u]) });
const nonceFor = async (u) => (await post("/api/admin/econ/edit/nonce", u, {}, csrf(u))).j.nonce;
const PW = { own: "owner-pass-1", adm: "admin-pass-1" };
async function webSave(u, body, o = {}) {
  const nonce = o.nonce !== undefined ? o.nonce : await nonceFor(u);
  return post("/api/admin/econ/recipe", u, Object.assign({ nonce, password: PW[u] }, body), o.headers || csrf(u));
}
const sync = (recipe, rooms_ = []) => post("/api/g/roomvaults/sync", null, { password: "bot-token", on: true, cap: 50000000, recipe, rooms: rooms_ });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, archived_at INTEGER)`);
  const hash = (s) => bcrypt.hashSync(s, 4);
  for (const [id, cls, cf, pw] of [["own", "Admin", "BossFrog", hash(PW.own)], ["adm", "Admin", "plainadmin", hash(PW.adm)], ["stf", "Staff", null, "x"], ["mem", "pleb", null, "x"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?)", [id, NAMES[id], pw, cls, cf]);
  }
  const SR = require(path.join(repo, "staffroles"));
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('bossfrog', 'owner', 1), ('plainadmin', 'admin', 1)");
  await require(path.join(repo, "adminaudit")).init();
  await rooms.init();
  await RV.init();
  await RC.init();
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const isBotToken = (t) => t === "bot-token";
  RV.register(app, { addUser, isBotToken });
  RC.register(app, { addUser, isBotToken });
  require(path.join(repo, "econstore")).register(app, { addUser, isBotToken });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("clean(): the shared vectors V1-V12 (identical to Pepe's clean_site_cfg)", () => {
  const ok = (c, warn) => {
    const r = RC.clean(c);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.warnings.length, warn ? 1 : 0, JSON.stringify(r.warnings));
    if (warn) assert.match(r.warnings[0], warn);
    return r;
  };
  const no = (c, re) => { const r = RC.clean(c); assert.equal(r.ok, false); assert.equal(r.cfg, null); assert.ok(r.errors.some((e) => re.test(e)), JSON.stringify(r.errors)); return r; };
  assert.deepEqual(ok(V1).cfg, V1, "V1: the defaults, no warning");
  ok(V2, /add up to 110%/);                                                    // V2
  ok(V(0.15, 0.15, 0.25, 0.35, 0.60, 1), /add up to 150%/);                     // V3
  no(V(0.15, 0.15, 0.25, 0.35, 0.61, 1), /more than 150%/);                     // V4
  // V5: the contract's table says "refused: paid 101 %", but .15 + .15 + .25 + .36 is 91 % paid (101 % with games) - under
  // rule B.4 (paid <= 100, all five <= 150) that's ok with the 101 % warning. The paid > 100 refusal it meant is V5x.
  ok(V(0.15, 0.15, 0.25, 0.36, 0.10, 1), /add up to 101%/);                     // V5 as written
  no(V5x, /regulars can't be more than 100%/);                                  // V5x: 15 + 15 + 25 + 46 = 101 % paid
  no(V(0.30, 0.30, 0.25, 0.46, 0.50, 1), /regulars can't be more than 100%/);   // both sums over: both reasons
  assert.equal(RC.clean(V(0.30, 0.30, 0.25, 0.46, 0.50, 1)).errors.length, 2);
  no(V(0.155, 0.15, 0.25, 0.35, 0.10, 1), /owner_pct must be a whole percent/);  // V6
  no(V(-0.01, 0.15, 0.25, 0.35, 0.10, 1), /owner_pct must be a number from 0 to 1/);   // V7
  no(V(1.01, 0.15, 0.25, 0.35, 0.10, 1), /owner_pct must be a number from 0 to 1/);
  no(V("0.15", 0.15, 0.25, 0.35, 0.10, 1), /owner_pct must be a number from 0 to 1/);  // V8
  no(V(true, 0.15, 0.25, 0.35, 0.10, 1), /owner_pct must be a number from 0 to 1/);
  const partial = Object.assign({}, V1); delete partial.games_unpaid;
  no(partial, /missing games_unpaid/);                                          // V9: the full set is required
  no(V(0.15, 0.15, 0.25, 0.35, 0.10, 2), /games_unpaid must be 0 or 1/);        // V10
  assert.equal(ok(V(0.15, 0.15, 0.25, 0.35, 0.10, true)).cfg.games_unpaid, 1, "V10: true -> 1");
  assert.equal(ok(V(0.15, 0.15, 0.25, 0.35, 0.10, false)).cfg.games_unpaid, 0);
  ok(V(0, 0, 0, 0, 0, 0), /100% of each day's budget is never assigned/);       // V11
  const v12 = ok(V(0.29, 0.15, 0.25, 0.21, 0.10, 1));                           // V12: 0.29 * 100 = 28.999... is still 29
  assert.equal(v12.cfg.owner_pct, 0.29);
  assert.equal(ok(V(0.1 + 0.2, 0.15, 0.15, 0.3, 0.1, 1)).cfg.owner_pct, 0.3, "normalized to 2 decimals");
  assert.equal(RC.clean(null).ok, false);
  assert.equal(RC.clean([1, 2]).ok, false);
});

test("roomvaults.sync: recipe_cfg null before any save; a read error omits the field", async () => {
  const r = await sync({ on: true, cfg: PEPE_CFG, cfg_rev: null, cfg_src: "local", cfg_applied_at: null, cfg_error: null });
  assert.equal(r.status, 200);
  assert.ok("recipe_cfg" in r.j, "the field is there");
  assert.equal(r.j.recipe_cfg, null, "never saved on the website");
  assert.deepEqual(Object.keys(r.j.settings), []);
  const orig = RC.forPepe;
  RC.forPepe = async () => { throw new Error("disk on fire"); };
  try {
    const e = await sync({ on: true, cfg: PEPE_CFG, cfg_rev: null, cfg_src: "local" });
    assert.equal(e.status, 200, "the sync itself still works");
    assert.ok(!("recipe_cfg" in e.j), "omitted, never null, so Pepe changes nothing");
  } finally { RC.forPepe = orig; }
});

test("GET /api/admin/econ/recipe: Admins only; can_edit only for a Pepe owner; not_set at first", async () => {
  assert.equal((await get("/api/admin/econ/recipe", "")).status, 401);
  assert.equal((await get("/api/admin/econ/recipe", "mem")).status, 403);
  assert.equal((await get("/api/admin/econ/recipe", "stf")).status, 403, "Staff don't hold econ.telemetry_policy");
  const a = await get("/api/admin/econ/recipe", "adm");
  assert.equal(a.status, 200);
  assert.equal(a.cc, "no-store");
  assert.equal(a.j.can_edit, false, "an Admin who isn't a Pepe owner");
  assert.equal(a.j.state, "not_set");
  assert.equal(a.j.saved, null);
  assert.deepEqual(a.j.defaults, V1);
  assert.deepEqual(a.j.limits, { paid_max: 1, sum_max: 1.5, sum_warn: 1 });
  assert.equal(a.j.pepe.cfg.games_pct, 0.1);
  assert.equal(a.j.pepe.cfg_src, "local");
  assert.equal(a.j.pepe.on, true);
  assert.equal((await get("/api/admin/econ/recipe", "own")).j.can_edit, true, "Admin + Pepe role owner");
});

test("POST /api/admin/econ/recipe refusals: owner only, CSRF + same-site fetch, single-use nonce, password, the rules", async () => {
  let r = await webSave("adm", { base_rev: null, cfg: V2 });
  assert.equal(r.status, 403); assert.equal(r.j.code, "owner_only", "a plain Admin can look, not save");
  r = await webSave("own", { base_rev: null, cfg: V2 }, { headers: {} });
  assert.equal(r.status, 403); assert.equal(r.j.code, "cross_site", "no x-csrf-token");
  r = await webSave("own", { base_rev: null, cfg: V2 }, { headers: Object.assign({ origin: "https://evil.example" }, csrf("own")) });
  assert.equal(r.status, 403); assert.equal(r.j.code, "cross_site", "another site");
  r = await webSave("own", { base_rev: null, cfg: V2 }, { headers: Object.assign({ "x-requested-with": "" }, csrf("own")) });
  assert.equal(r.status, 403, "not a fetch");
  r = await webSave("own", { base_rev: null, cfg: V2 }, { headers: { "x-csrf-token": P.csrfToken("admin2") } });
  assert.equal(r.status, 403, "someone else's CSRF token");
  const n = await nonceFor("own");
  r = await webSave("own", { base_rev: null, cfg: V2, password: "wrong" }, { nonce: n });
  assert.equal(r.status, 403); assert.match(r.j.error, /Wrong password/);
  r = await webSave("own", { base_rev: null, cfg: V2 }, { nonce: n });
  assert.equal(r.status, 409, "the nonce was used up by the wrong-password try"); assert.match(r.j.error, /already used or has expired/);
  r = await webSave("own", { base_rev: null, cfg: V2 }, { nonce: await nonceFor("adm") });
  assert.equal(r.status, 409, "another admin's nonce");
  r = await webSave("own", { base_rev: null, cfg: V5x });
  assert.equal(r.status, 400); assert.equal(r.j.code, "invalid");
  assert.match(r.j.errors[0], /can't be more than 100%/);
  r = await webSave("own", { base_rev: "x", cfg: V2 });
  assert.equal(r.status, 400, "a junk base_rev");
  assert.equal(await RC.read(), null, "nothing saved");
  assert.equal((await audits()).length, 0, "nothing audited");
});

test("POST /api/admin/econ/recipe: a save is rev 1 + one audit row; the same values are unchanged; a stale base_rev is 409", async () => {
  let r = await webSave("own", { base_rev: null, cfg: V2, note: "bump games to 20%" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.saved.rev, 1);
  assert.deepEqual(r.j.saved.cfg, V2);
  assert.equal(r.j.saved.by, "boss");
  assert.match(r.j.warnings[0], /110%/);
  let a = await audits();
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].admin_id, a[0].admin_name, a[0].reason], ["own", "boss", "bump games to 20%"]);
  const d = JSON.parse(a[0].detail);
  assert.equal(d.rev, 1); assert.equal(d.via, "web");
  assert.deepEqual(d.changed, ["games_pct"], "a first save is compared with Pepe's reported values");
  assert.equal(d.from.games_pct, 0.1); assert.deepEqual(d.to, V2);
  assert.match(d.warnings[0], /110%/);
  // the same values again: nothing new
  r = await webSave("own", { base_rev: 1, cfg: Object.assign({}, V2, { games_unpaid: true }) });
  assert.equal(r.status, 200); assert.equal(r.j.unchanged, true); assert.equal(r.j.saved.rev, 1);
  assert.equal((await audits()).length, 1, "no audit row for an unchanged save");
  // a stale base_rev: the saved values come back
  r = await webSave("own", { base_rev: 0, cfg: V(0.15, 0.15, 0.25, 0.35, 0.30, 0) });
  assert.equal(r.status, 409); assert.equal(r.j.code, "stale");
  assert.equal(r.j.saved.rev, 1); assert.deepEqual(r.j.saved.cfg, V2);
  r = await webSave("own", { base_rev: null, cfg: V(0.15, 0.15, 0.25, 0.35, 0.30, 0) });
  assert.equal(r.status, 409, "null = 'nothing saved yet' doesn't match rev 1");
  // the sync hands it to Pepe
  const s = await sync({ on: true, cfg: PEPE_CFG, cfg_rev: null, cfg_src: "local" });
  assert.deepEqual(Object.keys(s.j.recipe_cfg).sort(), ["at", "by", "cfg", "rev"]);
  assert.deepEqual([s.j.recipe_cfg.rev, s.j.recipe_cfg.by], [1, "boss"]);
  assert.deepEqual(s.j.recipe_cfg.cfg, V2);
  assert.equal((await get("/api/admin/econ/recipe", "adm")).j.state, "pending", "Pepe still reports his local values");
});

test("POST /api/g/recipe/cfg: Pepe's chat write-through (bot token, chat:<login>, the linked account audited, stale = 409)", async () => {
  await runQuery("DELETE FROM recipe_cfg");          // a fresh website: nothing saved yet
  const before = (await audits()).length;
  const chat = (body) => post("/api/g/recipe/cfg", null, Object.assign({ password: "bot-token", via: "chat" }, body));
  assert.equal((await post("/api/g/recipe/cfg", null, { actor: "BossFrog", base_rev: null, cfg: V2 })).status, 403, "no bot token");
  assert.equal((await chat({ password: "nope", actor: "BossFrog", base_rev: null, cfg: V2 })).status, 403);
  let r = await chat({ actor: "BossFrog", base_rev: null, cfg: V2 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.saved.rev, r.j.saved.by], [1, "chat:bossfrog"]);
  let a = (await audits()).slice(before);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].admin_name, a[0].admin_id], ["chat:bossfrog", "own"], "the chat login's linked PATV account");
  assert.equal(JSON.parse(a[0].detail).via, "chat");
  r = await chat({ actor: "BossFrog", base_rev: null, cfg: V1 });
  assert.equal(r.status, 409); assert.equal(r.j.code, "stale"); assert.equal(r.j.saved.rev, 1);
  r = await chat({ actor: "BossFrog", base_rev: 1, cfg: V5x });
  assert.equal(r.status, 400); assert.equal(r.j.code, "invalid");
  r = await chat({ actor: "nolink_cf", base_rev: 1, cfg: V(0.15, 0.15, 0.25, 0.35, 0.20, 0) });
  assert.equal(r.status, 200);
  assert.equal(r.j.saved.rev, 2);
  a = (await audits()).slice(before);
  assert.deepEqual([a[1].admin_name, a[1].admin_id], ["chat:nolink_cf", "pepe"], "no linked account -> pepe");
  assert.deepEqual(JSON.parse(a[1].detail).changed, ["games_unpaid"]);
  r = await chat({ actor: "BossFrog", base_rev: 2, cfg: V(0.15, 0.15, 0.25, 0.35, 0.20, 0) });
  assert.equal(r.j.unchanged, true);
});

test("the state machine: pending / applied / refused / old_pepe from what Pepe reports", async () => {
  // saved rev 2 = .15 .15 .25 .35 .20, unpaid off (the chat test above)
  const S2 = V(0.15, 0.15, 0.25, 0.35, 0.20, 0);
  const cfgOf = (o) => Object.assign({}, PEPE_CFG, o);
  const st = async () => (await get("/api/admin/econ/recipe", "adm")).j;
  await sync({ on: true, cfg: cfgOf({ games_pct: 0.2, games_unpaid: 1 }), cfg_rev: 1, cfg_src: "site", cfg_applied_at: 1760885040, cfg_error: null });
  assert.equal((await st()).state, "pending", "saved rev 2, Pepe applies rev 1");
  await sync({ on: true, cfg: cfgOf(S2), cfg_rev: 2, cfg_src: "site", cfg_applied_at: 1760885340, cfg_error: null });
  let j = await st();
  assert.equal(j.state, "applied", "rev 2 with the same values");
  assert.deepEqual([j.pepe.cfg_rev, j.pepe.cfg_src, j.pepe.cfg_applied_at], [2, "site", 1760885340]);
  await sync({ on: true, cfg: cfgOf(S2), cfg_rev: 2, cfg_src: "site" , cfg_error: null, cfg_applied_at: 1 });
  await sync({ on: true, cfg: cfgOf({ games_pct: 0.25 }), cfg_rev: 2, cfg_src: "site", cfg_error: null });
  assert.equal((await st()).state, "pending", "the right rev but other values");
  await sync({ on: true, cfg: cfgOf({ games_pct: 0.2, games_unpaid: 1 }), cfg_rev: 1, cfg_src: "site",
               cfg_error: { rev: 2, errors: ["owner + gang + streamers + regulars can't be more than 100%"] } });
  j = await st();
  assert.equal(j.state, "refused");
  assert.deepEqual(j.pepe.cfg_error, { rev: 2, errors: ["owner + gang + streamers + regulars can't be more than 100%"] });
  await sync({ on: true, cfg: { owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.1 } });   // a Pepe before 1.99adb
  j = await st();
  assert.equal(j.state, "old_pepe");
  assert.equal(j.pepe.cfg_rev, null);
  // the pure function, every branch
  const saved = { rev: 3, cfg: V1 };
  assert.equal(RC.state(null, null), "not_set");
  assert.equal(RC.state(saved, null), "pending", "Pepe never synced a recipe");
  assert.equal(RC.state(saved, { cfg: V1, cfg_rev: 3, cfg_src: "site", cfg_error: { rev: 3, errors: [] } }), "refused");
  assert.equal(RC.state(saved, { cfg: V1 }), "old_pepe");
  assert.equal(RC.state(saved, { cfg: V1, cfg_rev: null, cfg_src: "local" }), "pending");
  assert.equal(RC.state(saved, { cfg: Object.assign({}, V1, { games_pct: 0.1000000001 }), cfg_rev: 3, cfg_src: "site" }), "applied", "compared as whole percents");
  assert.equal(RC.state(saved, { cfg: V1, cfg_rev: 2, cfg_src: "site", cfg_error: { rev: 2, errors: [] } }), "pending", "an older rev's refusal");
});

test("GET: the change log and the biggest vaults' last payout day (slice + unpaid shares = allowance)", async () => {
  await sync({ on: true, cfg: PEPE_CFG, cfg_rev: 2, cfg_src: "site" }, [
    { id: PLANT, balance: 11120000, days: {}, history: [],
      recipe: { epochs: [{ day: "2026-10-18", B: 1112080, games_allow: 722852, games_base: 111208, games_from_unpaid: 611644, paid: 300000, stays: 812080 }],
                games: { day: "2026-10-18", allow: 722852, used: 109461 } } },
    { id: "DRAMA_CENTRAL", balance: 500000, days: {}, history: [],
      recipe: { epochs: [{ day: "2026-10-18", B: 50000, games_allow: 5000, paid: 1000, stays: 49000 }], games: { day: "2026-10-17", allow: 5000, used: 10 } } },
    // slices over 100 %: Pepe capped the allowance at B - paid, below slice + unpaid shares (his figure before the cap)
    { id: "Capped.Room", balance: 100000, days: {}, history: [],
      recipe: { epochs: [{ day: "2026-10-18", B: 10000, games_allow: 2000, games_base: 6000, games_from_unpaid: 3000, paid: 8000, stays: 2000 }] } }]);
  const j = (await get("/api/admin/econ/recipe", "adm")).j;
  assert.equal(j.last.length, 3);
  assert.deepEqual(j.last[0], { room: PLANT, title: j.last[0].title, day: "2026-10-18", B: 1112080, games_base: 111208, games_from_unpaid: 611644,
                                games_allow: 722852, capped: false, used: 109461 });
  assert.deepEqual([j.last[1].games_base, j.last[1].games_from_unpaid, j.last[1].used, j.last[1].capped], [5000, 0, null, false],
                   "an older Pepe's day: the allowance was the slice; a games record of another day isn't that day's use");
  assert.deepEqual([j.last[2].games_base, j.last[2].games_from_unpaid, j.last[2].games_allow, j.last[2].capped], [6000, 3000, 2000, true],
                   "slice + unpaid shares > allowance: marked capped (the card doesn't show a sum that doesn't add up)");
  assert.ok(j.log.length >= 3, "the change log (web + chat)");
  assert.equal(j.log[0].detail.via, "chat");
  assert.ok(Array.isArray(j.pepe_keys) && j.pepe_keys.includes("cap_i7") && j.pepe_keys.includes("hour"));
  assert.equal(j.pepe.cfg.hour, 5);
});

test("the card renders: Admins see it, a non-owner's form is disabled, an owner's is live, Staff get no form", async () => {
  const file = path.join(repo, "views", "partials", "econ-recipe.ejs");
  const html = (isAdmin, canEdit) => ejs.renderFile(file, { isAdmin, canEdit, me: { username: "boss" }, pepeCtlCsrf: P.csrfToken });
  const owner = await html(true, true);
  assert.match(owner, /id="recipe-cfg"/);
  assert.match(owner, /Pad-vault payout recipe/);
  for (const id of ["rcfgOwner", "rcfgGang", "rcfgStreamers", "rcfgPeople", "rcfgGames", "rcfgUnpaid", "rcfgNote", "rcfgSave", "rcfgDefaults", "rcfgPw", "rcfgLast", "rcfgLog", "rcfgOther"]) {
    assert.match(owner, new RegExp(`id="${id}"`), id);
  }
  assert.match(owner, /data-edit="1"/);
  assert.match(owner, /data-csrf="[a-z0-9]+\.[A-Za-z0-9_-]+"/);
  assert.doesNotMatch(owner, /disabled/);
  assert.doesNotMatch(owner, /id="rcfgNotOwner"/);
  assert.match(owner, /admin-recipe\.js/);
  const plain = await html(true, false);
  assert.match(plain, /id="rcfgNotOwner"/);
  assert.match(plain, /Only a Pepe owner can change the payout recipe/);
  assert.match(plain, /id="rcfgGames" min="0" max="100" step="1" required disabled/);
  assert.match(plain, /id="rcfgSave" disabled/);
  const staff = await html(false, false);
  assert.match(staff, /id="recipe-cfg"/);
  assert.doesNotMatch(staff, /id="rcfgForm"/);
  assert.doesNotMatch(staff, /admin-recipe\.js/);
  assert.match(staff, /Admins only\./);
  // placed right after the Activity -> pad vaults card on /admin/economy
  const page = fs.readFileSync(path.join(repo, "views", "admin", "economy.ejs"), "utf8");
  assert.ok(page.indexOf("econ-activity-pads") < page.indexOf("econ-recipe") && page.indexOf("econ-recipe") < page.indexOf("econ-pools"));
  // the E-0 telemetry dry run still uses econ.js RECIPE's fixed numbers - its help says so rather than claiming it follows the card
  const tel = (page.match(/id="econ-telemetry"[\s\S]*?<\/p>/) || [""])[0];
  const E = require(path.join(repo, "econ")).RECIPE;
  assert.match(tel, new RegExp(`${E.rate * 100}%/day, owner ${E.owner * 100} / gang ${E.gang * 100} / streamers ${E.streamers * 100} / participants ${E.participants * 100} / games ${E.games * 100}`),
               "the numbers the dry run really uses (econ.js RECIPE)");
  assert.match(tel, /doesn't follow the payout recipe card above/);
  // the page script's endpoints
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-recipe.js"), "utf8");
  for (const ep of ["/api/admin/econ/recipe", "/api/admin/econ/edit/nonce"]) assert.ok(js.includes("'" + ep + "'"), ep);
  assert.ok(js.includes("'X-Requested-With': 'fetch'") && js.includes("'x-csrf-token': csrf"));
});

test("i18n: every new string is in en.json and passes the catalog rules the translation sync enforces; no money words", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const chk = require(path.join(repo, "i18n-check"));
  const partial = fs.readFileSync(path.join(repo, "views", "partials", "econ-recipe.ejs"), "utf8");
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-recipe.js"), "utf8");
  const keys = new Set([...partial.matchAll(/\bt\('([a-z0-9_.]+)'/g)].map((m) => m[1]).concat([...js.matchAll(/_t\('(js\.[a-z0-9_.]+)'/g)].map((m) => m[1]))
    .concat(["owner.recipe_games_unpaid", "owner.rc_games_unpaid", "owners.earn.games_unpaid"]));
  assert.ok(keys.size > 60, "the card's strings: " + keys.size);
  for (const k of keys) {
    assert.ok(k in en, k + " is in en.json");
    assert.deepEqual(chk.check(k, en[k], en[k]), [], k);
    assert.doesNotMatch(en[k], /\bmoney\b/i, k + ": PAT is points");
    assert.equal(en[k], en[k].trim(), k + ": no leading / trailing space (the translation sync trims every value it writes)");
  }
  // /economy's pad-vault card is plain English (not in the catalog): no half-translated sentence pieces for it
  assert.ok(!("economy.recipe_games_unpaid" in en) && !("economy.recipe_rest_unpaid" in en));
  assert.doesNotMatch(en["adm.rcfg.help"], /05:00/, "the payout hour is Pepe's live one (the status row), never hard-coded in the help");
});

test("no row saved: any base_rev is accepted (Pepe can hold a site rev after a restore) and the first rev continues past it", async () => {
  // the website's row is gone (a database restored to before the first save) while Pepe still reports site rev 2 applied
  await runQuery("DELETE FROM recipe_cfg");
  const chat = (body) => post("/api/g/recipe/cfg", null, Object.assign({ password: "bot-token", via: "chat", actor: "BossFrog" }, body));
  const before = (await audits()).length;
  let r = await chat({ base_rev: 7, cfg: V2 });
  assert.equal(r.status, 200, "was 409 {saved: null} - nothing Pepe could apply, so every chat retry was stuck: " + JSON.stringify(r.j));
  assert.equal(r.j.saved.rev, 8, "past the base_rev Pepe sent: a rev he applied is never handed out again");
  assert.equal((await audits()).length, before + 1, "audited like any save");
  // the same from the web card (it sends base_rev null when nothing is saved): past the rev Pepe reports applied (2)
  await runQuery("DELETE FROM recipe_cfg");
  r = await webSave("own", { base_rev: null, cfg: V1 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.saved.rev, 3);
  // with a row saved the rev check still guards it
  r = await chat({ base_rev: 7, cfg: V2 });
  assert.equal(r.status, 409); assert.equal(r.j.code, "stale"); assert.equal(r.j.saved.rev, 3);
  r = await webSave("own", { base_rev: null, cfg: V2 });
  assert.equal(r.status, 409, "null = 'nothing saved yet' still doesn't match a saved row");
  r = await chat({ base_rev: Number.MAX_SAFE_INTEGER + 2, cfg: V2 });
  assert.equal(r.status, 400, "an unsafe integer isn't a revision");
  assert.equal((await RC.read()).rev, 3);
});
