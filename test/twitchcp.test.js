// 1.99afh: Twitch channel-point rewards (owner decision 2026-10-26) - the site side.
//   * twitchcp.js: the allowlist (reward id or EXACT title -> fixed PAT), the cap (never above 25,000), the admin card's API
//     (econ.codes_view to look, econ.codes_manage + a Pepe owner to change, same-site fetch, audit-logged)
//   * botcredits.js chatwinner type twitch-channelpoints: the list's amount (never the caller's, never the title's),
//     not_allowlisted / over_cap / no_user (by the Twitch user id) refusals, ref idempotency, the "seen" list
//   * platform_rewards never falls back to the Reserve (no_route) - connect bonuses / redeem codes keep their own flows
//   * the bot's whole path (twitchbot/channelpoints.js + patvAuth's axios) against the real routes
//   NODE_PATH=G:/PATV/node_modules node --test test/twitchcp.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "twitchcp-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const axios = require("axios");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const BC = require(path.join(repo, "botcredits"));
const T = require(path.join(repo, "twitchcp"));
const SR = require(path.join(repo, "staffroles"));
const userlookup = require(path.join(repo, "userlookup"));
const CPB = require(path.join(repo, "twitchbot", "channelpoints"));
const patvAuth = require(path.join(repo, "twitchbot", "patvAuth"));

const BOT = "bot-token-xyz";
const TW = { ann: "1001", bob: "1002", cat: "1003" };
const INC = (left = 1000000) => ({ balance: left, week: "W", remaining: { misc: left }, budgets: { misc: left }, groups: { platform_rewards: "misc", connect_bonus: "misc", redeem_codes: "misc" } });
const live = (left) => F.sync({ reserve: 76900000, flows: { platform_rewards: "incentives" }, incentives: INC(left) });
// a sync only adds / changes routing rows, so "never routed" is a site whose state has no row for the flow
const unrouted = (sync) => { for (const k of Object.keys(F.state.flows)) delete F.state.flows[k]; F.sync(sync); };
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const log = (ref) => getQuery("SELECT * FROM bot_credit_log WHERE ref = ?", [ref]).then((r) => r[0]);
const reserveClaims = async () => (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow NOT LIKE 'incentives:%'"))[0].n;
const cp = (o) => BC.chatwinner(Object.assign({ type: "twitch-channelpoints", userId: "u1", twitch_user_id: TW.ann }, o));
async function reset(cfg) {
  await runQuery("DELETE FROM twitchcp_cfg");
  T._reset();
  if (cfg) assert.equal((await T.set(cfg, "test")).ok, true);
  await F.settle((await F.claims()).map((c) => c.claimId));
}

let base, server, who = null;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, twitchId TEXT, twitchDisplayname TEXT, twitchLogin TEXT,
                  discordId TEXT, discordUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  for (const [id, name, cls, tw, cf] of [["u1", "ann", "pleb", TW.ann, null], ["u2", "bob", "pleb", TW.bob, null], ["u3", "cat", "pleb", null, null],
                                         ["uo", "own", "Admin", null, "Owner_CF"], ["ua", "adm", "Admin", null, "admin_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, twitchId, twitchDisplayname, camfrogUsername) VALUES (?, ?, 'x', ?, ?, ?, ?)",
                   [id, name, cls, tw, tw ? name.toUpperCase() : null, cf]);
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1)");
  await F.claims();
  await T.init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const h = req.headers["x-test-user"]; who = h ? { userId: h, username: h } : null; next(); });
  const addUser = (req, res, next) => { req.user = who; next(); };
  BC.register(app, { isBotToken: (t) => t === BOT, idemBegin: null, resolveCounterparty: async () => null });
  userlookup.register(app, { isPlatformBot: (t) => t === BOT, stale: null });
  T.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

// ── twitchcp.js: the allowlist ──
test("defaults: 'Buy 5000 PAT' = 5,000 and 'Buy 25000 PAT' = 25,000 by exact title, cap 25,000", async () => {
  await reset();
  const c = await T.get();
  assert.deepEqual(c, { rewards: [{ id: null, title: "Buy 5000 PAT", amount: 5000 }, { id: null, title: "Buy 25000 PAT", amount: 25000 }], cap: 25000 });
  assert.equal(T.HARD_CAP, 25000);
  assert.equal(T.resolve({ id: "x", title: "Buy 5000 PAT" }, c).amount, 5000);
  assert.equal(T.resolve({ id: "x", title: "Buy 25000 PAT" }, c).amount, 25000);
  for (const title of ["Buy 500000 PAT", "buy 5000 pat", "Buy 5000 PAT ", " Buy 5000 PAT", "Buy 5000 PATV", "Buy 99999999 PAT", "Pet dog", "", null]) {
    assert.equal(T.resolve({ id: "x", title }, c), null, `never parsed from a title: ${JSON.stringify(title)}`);
  }
});

test("an entry with a reward id matches that id only (a renamed reward still pays, a copied title doesn't)", async () => {
  const c = { rewards: [{ id: "aaaa-1111", title: "Buy 5000 PAT", amount: 5000 }, { id: null, title: "Buy 25000 PAT", amount: 25000 }], cap: 25000 };
  assert.equal(T.resolve({ id: "aaaa-1111", title: "Renamed on Twitch" }, c).amount, 5000);
  assert.equal(T.resolve({ id: "bbbb-2222", title: "Buy 5000 PAT" }, c), null, "same title, another reward");
  assert.equal(T.resolve({ id: "bbbb-2222", title: "Buy 25000 PAT" }, c).amount, 25000, "title-only rows still match by title");
  assert.equal(T.resolve({ id: "aaaa-1111", title: "Buy 25000 PAT" }, c).by, "id", "the id wins");
});

test("validate: cap 0..25,000, amounts 1..25,000, an id or a title, no duplicates, at most 20 rows", () => {
  const ok = (c) => T.validate(c).ok;
  assert.equal(ok({ rewards: [], cap: 0 }), true, "cap 0 pauses everything");
  assert.equal(ok({ rewards: [{ title: "Buy 5000 PAT", amount: 5000 }], cap: 25000 }), true);
  assert.equal(ok({ rewards: [{ id: "6b1f0c1e-2a1b-4c1d-9e8f-0a1b2c3d4e5f", amount: "25000" }], cap: "5000" }), true, "numeric strings");
  assert.equal(ok({ rewards: [], cap: 25001 }), false, "the cap never passes the hard cap");
  assert.equal(ok({ rewards: [], cap: -1 }), false);
  assert.equal(ok({ rewards: [], cap: 1.5 }), false);
  assert.equal(ok({ rewards: [], cap: null }), false);
  assert.equal(ok({ rewards: [{ title: "Buy 500000 PAT", amount: 500000 }], cap: 25000 }), false, "no amount above 25,000");
  assert.equal(ok({ rewards: [{ title: "x", amount: 0 }], cap: 25000 }), false);
  assert.equal(ok({ rewards: [{ title: "x", amount: 10.5 }], cap: 25000 }), false);
  assert.equal(ok({ rewards: [{ amount: 10 }], cap: 25000 }), false, "needs an id or a title");
  assert.equal(ok({ rewards: [{ id: "has space", amount: 10 }], cap: 25000 }), false);
  assert.equal(ok({ rewards: [{ title: "x".repeat(46), amount: 10 }], cap: 25000 }), false, "Twitch titles are <= 45");
  assert.equal(ok({ rewards: [{ title: "a", amount: 1 }, { title: "a", amount: 2 }], cap: 25000 }), false, "duplicate title");
  assert.equal(ok({ rewards: [{ id: "a1", amount: 1 }, { id: "a1", amount: 2 }], cap: 25000 }), false, "duplicate id");
  assert.equal(ok({ rewards: Array.from({ length: 21 }, (_, i) => ({ title: "t" + i, amount: 1 })), cap: 25000 }), false);
  assert.deepEqual(T.validate({ rewards: [{ id: " a1 ", title: " Buy 5000 PAT ", amount: "5000" }], cap: 100 }).cfg,
                   { rewards: [{ id: "a1", title: "Buy 5000 PAT", amount: 5000 }], cap: 100 }, "trimmed when saved");
});

test("an unreadable saved list falls back to the defaults (never to 'pay anything')", async () => {
  await runQuery("INSERT INTO twitchcp_cfg (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 [JSON.stringify({ rewards: [{ title: "Buy 500000 PAT", amount: 500000 }], cap: 999999 })]);
  T._reset();
  assert.deepEqual(await T.get(), T.validate(T.DEFAULTS).cfg);
  await reset();
});

// ── botcredits: twitch-channelpoints ──
test("an allow-listed reward pays the LIST's amount from the incentive budget - the caller's amount is ignored", async () => {
  await reset();
  live();
  const b0 = await bal("u1");
  const r = await cp({ amount: 500000, reward_id: "r-5k", reward_title: "Buy 5000 PAT", ref: "twitch-cp:ev1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.amount, 5000);
  assert.equal(await bal("u1"), b0 + 5000);
  const row = await log("twitch-cp:ev1");
  assert.deepEqual([row.outcome, row.amount, row.type, row.source], ["ok", 5000, "twitch-channelpoints", "twitch-reward:r-5k"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'incentives:platform_rewards' AND amount = 5000"))[0].n, 1);
  assert.equal(await reserveClaims(), 0, "nothing on the Reserve");
  assert.equal((await getQuery("SELECT amount FROM bonus_winners WHERE type = 'twitch-channelpoints' ORDER BY rowid DESC LIMIT 1"))[0].amount, 5000);
});

test("'Buy 500000 PAT' (the 10-24 reward) is refused not_allowlisted and nothing moves", async () => {
  await reset();
  live();
  const b0 = await bal("u1");
  const claims0 = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n;
  const r = await cp({ amount: 500000, reward_id: "r-500k", reward_title: "Buy 500000 PAT", ref: "twitch-cp:ev500" });
  assert.deepEqual([r.status, r.json.success, r.json.error], [409, false, "not_allowlisted"]);
  assert.equal(await bal("u1"), b0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n, claims0);
  assert.equal((await log("twitch-cp:ev500")).outcome, "not_allowlisted");
  // an old server.js (amount from the title, no reward fields, no ref) gets nothing either
  const old = await cp({ amount: 25000 });
  assert.deepEqual([old.status, old.json.error], [400, "unsourced"]);
  const old2 = await cp({ amount: 25000, ref: "twitch-cp:old" });
  assert.deepEqual([old2.status, old2.json.error], [409, "not_allowlisted"]);
  assert.equal(await bal("u1"), b0);
});

test("type matching can't be dodged by case: 'Twitch-ChannelPoints' takes the same path", async () => {
  await reset();
  live();
  const b0 = await bal("u1");
  const r = await BC.chatwinner({ type: "Twitch-ChannelPoints", userId: "u1", twitch_user_id: TW.ann, amount: 500000, reward_title: "Buy 500000 PAT", ref: "twitch-cp:case" });
  assert.equal(r.json.error, "not_allowlisted");
  assert.equal(await bal("u1"), b0);
});

test("a repeated EventSub delivery (same ref) pays once", async () => {
  await reset();
  live();
  const b0 = await bal("u2");
  const body = { userId: "u2", twitch_user_id: TW.bob, reward_id: "r-25k", reward_title: "Buy 25000 PAT", ref: "twitch-cp:dup1" };
  const [a, b] = await Promise.all([cp(body), cp(body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal([a, b].filter((x) => x.json.duplicate).length, 1, "one of the two is the duplicate");
  const c = await cp(body);
  assert.equal(c.json.duplicate, true);
  assert.equal(c.json.amount, 25000);
  assert.equal(await bal("u2"), b0 + 25000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bonus_winners WHERE userId = 'u2'"))[0].n, 1);
});

test("over_cap: lowering the cap pauses the bigger rewards without editing them; cap 0 pauses all", async () => {
  await reset({ rewards: [{ title: "Buy 5000 PAT", amount: 5000 }, { title: "Buy 25000 PAT", amount: 25000 }], cap: 5000 });
  live();
  const b0 = await bal("u1");
  const big = await cp({ reward_title: "Buy 25000 PAT", ref: "twitch-cp:cap1" });
  assert.deepEqual([big.status, big.json.error, big.json.cap], [409, "over_cap", 5000]);
  assert.equal((await log("twitch-cp:cap1")).outcome, "over_cap");
  assert.equal((await cp({ reward_title: "Buy 5000 PAT", ref: "twitch-cp:cap2" })).status, 200);
  await T.set({ rewards: (await T.get()).rewards, cap: 0 }, "test");
  assert.equal((await cp({ reward_title: "Buy 5000 PAT", ref: "twitch-cp:cap3" })).json.error, "over_cap");
  assert.equal(await bal("u1"), b0 + 5000);
});

test("credited by the Twitch user id: the account must be the one linked to it", async () => {
  await reset();
  live();
  const b0 = [await bal("u1"), await bal("u2"), await bal("u3")];
  // u1's account named with bob's Twitch id (a display-name mix-up) -> no_user
  const wrong = await cp({ userId: "u1", twitch_user_id: TW.bob, reward_title: "Buy 5000 PAT", ref: "twitch-cp:w1" });
  assert.deepEqual([wrong.status, wrong.json.error], [404, "no_user"]);
  const unlinked = await cp({ userId: "u3", twitch_user_id: "999", reward_title: "Buy 5000 PAT", ref: "twitch-cp:w2" });
  assert.equal(unlinked.json.error, "no_user");
  const none = await cp({ userId: "u1", twitch_user_id: undefined, reward_title: "Buy 5000 PAT", ref: "twitch-cp:w3" });
  assert.equal(none.json.error, "bad_twitch_user");
  const name = await cp({ userId: "u1", twitch_user_id: "ANN", reward_title: "Buy 5000 PAT", ref: "twitch-cp:w4" });
  assert.equal(name.json.error, "bad_twitch_user", "a name is not an id");
  assert.deepEqual([await bal("u1"), await bal("u2"), await bal("u3")], b0);
});

test("the incentive budget short -> unfunded (the 10-24 case), refused, retryable", async () => {
  await reset();
  live(1000);
  const b0 = await bal("u1");
  const r = await cp({ reward_title: "Buy 5000 PAT", ref: "twitch-cp:short" });
  assert.deepEqual([r.status, r.json.error], [409, "unfunded"]);
  assert.equal(await bal("u1"), b0);
  live();
  assert.equal((await cp({ reward_title: "Buy 5000 PAT", ref: "twitch-cp:short" })).status, 200, "a refused ref may be retried");
  assert.equal(await bal("u1"), b0 + 5000);
});

test("the rewards seen are remembered (id, title, count, last answer) - no viewer data", async () => {
  await reset();
  await runQuery("DELETE FROM twitchcp_seen");
  live();
  await cp({ reward_id: "id-500k", reward_title: "Buy 500000 PAT", ref: "twitch-cp:s1" });
  await cp({ reward_id: "id-500k", reward_title: "Buy 500000 PAT", ref: "twitch-cp:s2" });
  await cp({ reward_id: "id-5k", reward_title: "Buy 5000 PAT", ref: "twitch-cp:s3" });
  const seen = await T.seen();
  const by = Object.fromEntries(seen.map((s) => [s.reward_id, s]));
  assert.deepEqual([by["id-500k"].title, by["id-500k"].n, by["id-500k"].last_outcome], ["Buy 500000 PAT", 2, "not_allowlisted"]);
  assert.deepEqual([by["id-5k"].n, by["id-5k"].last_outcome], [1, "ok"]);
  const cols = (await getQuery("SELECT name FROM pragma_table_info('twitchcp_seen')")).map((r) => r.name);
  assert.deepEqual(cols.filter((c) => /user/i.test(c)), [], "no user columns");
});

// ── platform_rewards never falls back to the Reserve ──
test("platform rewards: not routed / routed to the Reserve / to the House -> no_route; nothing is claimed", async () => {
  await reset();
  for (const flows of [{}, { platform_rewards: "reserve" }, { platform_rewards: "jackpot" }]) {
    unrouted({ reserve: 76900000, flows, incentives: INC() });
    await runQuery("DELETE FROM jackpot_rakes");
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, amount) VALUES ('seed', 10000000)");
    const b0 = await bal("u1");
    const tag = JSON.stringify(flows);
    for (const [type, extra] of [["discord-raffle", {}], ["twitch-raffle", {}], ["discord-levelup", {}],
                                 ["twitch-channelpoints", { twitch_user_id: TW.ann, reward_title: "Buy 5000 PAT" }]]) {
      const ref = `nr:${type}:${tag}`;
      const r = await BC.chatwinner(Object.assign({ userId: "u1", type, amount: 5000, ref }, extra));
      assert.deepEqual([r.status, r.json.error], [409, "no_route"], `${type} ${tag}`);
      assert.equal((await log(ref)).outcome, "no_route");
    }
    assert.equal(await bal("u1"), b0, tag);
    assert.equal(await reserveClaims(), 0, tag + ": no Reserve claim");
    assert.equal((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t, 10000000, tag + ": the House untouched");
  }
  // a debit isn't a payout: still allowed (only what the balance covers)
  unrouted({ reserve: 0, flows: {} });
  await runQuery("UPDATE users SET points_balance = 100 WHERE userId = 'u3'");
  assert.equal((await BC.chatwinner({ userId: "u3", type: "discord-casino", amount: -40, ref: "deb:1" })).status, 200);
  assert.equal(await bal("u3"), 60);
});

test("connect bonuses and redemption codes keep their own flows (the rule is platform_rewards' only)", async () => {
  await reset();
  unrouted({ reserve: 1000000, flows: { connect_bonus: "reserve", redeem_codes: "reserve" } });
  for (const flow of ["connect_bonus", "redeem_codes"]) {
    const t = await F.takeFundsRef(flow, 100, "u3", flow);
    assert.equal(t.ok, true, flow + " still pays from where Pepe routes it");
    await t.undo();
  }
  assert.equal(F.routeOf("platform_rewards"), null, "not named by this sync");
  assert.equal(F.vaultFor("platform_rewards"), "reserve", "vaultFor's default (why botcredits asks routeOf)");
  F.sync({ reserve: 0, flows: { platform_rewards: "incentives" } });
  assert.equal(F.routeOf("platform_rewards"), "incentives");
  F.sync({ reserve: 0, flows: {} });
});

// ── the admin card's API ──
const api = (method, user, body, extra = {}) => fetch(base + "/api/admin/twitch-cp", { method,
  headers: Object.assign({ "Content-Type": "application/json", "x-test-user": user || "" }, extra), body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const F_ = { "X-Requested-With": "fetch" };

test("admin API: Admins see it; only a Pepe owner changes it (same-site fetch, validated, audit-logged)", async () => {
  await reset();
  assert.equal((await api("GET", "")).status, 401);
  assert.equal((await api("GET", "u1")).status, 403);
  const adm = await api("GET", "ua");
  assert.equal(adm.status, 200);
  assert.deepEqual([adm.body.can_edit, adm.body.hard_cap, adm.body.cfg.cap], [false, 25000, 25000]);
  const next = { rewards: [{ id: "6b1f0c1e-2a1b", title: "Buy 5000 PAT", amount: 5000 }, { title: "Buy 25000 PAT", amount: 25000 }], cap: 25000 };
  assert.equal((await api("POST", "u1", next, F_)).status, 403);
  const notOwner = await api("POST", "ua", next, F_);
  assert.equal(notOwner.status, 403);
  assert.equal(notOwner.body.error, SR.OWNER_ONLY);
  assert.equal((await api("POST", "uo", next)).status, 403, "not a fetch");
  assert.equal((await api("POST", "uo", next, Object.assign({ Origin: "https://evil.example" }, F_))).status, 403, "cross-site");
  const bad = await api("POST", "uo", { rewards: [{ title: "Buy 500000 PAT", amount: 500000 }], cap: 25000 }, F_);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /25000/);
  const big = await api("POST", "uo", { rewards: [], cap: 100000 }, F_);
  assert.equal(big.status, 400, "the cap can't pass 25,000");
  const own = await api("GET", "uo");
  assert.equal(own.body.can_edit, true);
  const ok = await api("POST", "uo", next, F_);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.cfg.rewards[0], { id: "6b1f0c1e-2a1b", title: "Buy 5000 PAT", amount: 5000 });
  T._reset();
  assert.deepEqual((await T.get()).rewards[0].id, "6b1f0c1e-2a1b", "saved");
  const audit = (await getQuery("SELECT admin_id, action, detail FROM admin_audit WHERE action = 'twitch-cp' ORDER BY at DESC LIMIT 1"))[0];
  assert.equal(audit.admin_id, "uo");
  assert.equal(JSON.parse(audit.detail).after.rewards.length, 2);
  await reset();
});

// ── the bot's whole path: twitchbot/channelpoints.js + patvAuth's axios against the real routes ──
test("bot path: a redemption is looked up by Twitch user id, paid by the list, announced; repeats and refusals behave", async () => {
  await reset();
  live();
  const saved = { BACKEND_BASE_URL: process.env.BACKEND_BASE_URL, TWITCH_BOT_TOKEN: process.env.TWITCH_BOT_TOKEN, PATV_KEY: process.env.PATV_KEY };
  process.env.BACKEND_BASE_URL = base;
  process.env.TWITCH_BOT_TOKEN = BOT;
  delete process.env.PATV_KEY;
  const http = patvAuth.install(axios.create());
  const said = [], logs = [];
  const deps = { http, base, token: BOT, say: (t) => { said.push(t); return Promise.resolve(); }, recent: new CPB.Recent(),
                 log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };
  const ev = (id, user_id, title, rid) => ({ id, user_id, user_login: "x", user_name: "Viewer" + user_id, broadcaster_user_id: "1",
                                             reward: { id: rid || "rid-" + title.replace(/\W/g, ""), title, cost: 1000 } });
  try {
    const b1 = await bal("u1");
    assert.deepEqual(await CPB.handleRedemption(ev("e-1", TW.ann, "Buy 25000 PAT"), deps), { outcome: "ok", amount: 25000 });
    assert.equal(await bal("u1"), b1 + 25000);
    assert.equal(said.pop(), "@Viewer1001 exchanged channel points for PAT 25,000!");
    assert.equal((await log("twitch-cp:e-1")).outcome, "ok");
    // the same event again: dropped by the bot; a fresh bot (restart) -> the site's duplicate, still paid once
    assert.equal((await CPB.handleRedemption(ev("e-1", TW.ann, "Buy 25000 PAT"), deps)).outcome, "duplicate");
    const fresh = Object.assign({}, deps, { recent: new CPB.Recent() });
    assert.equal((await CPB.handleRedemption(ev("e-1", TW.ann, "Buy 25000 PAT"), fresh)).outcome, "duplicate");
    assert.equal(await bal("u1"), b1 + 25000);
    assert.equal(said.length, 0, "no second announcement");
    // "Buy 500000 PAT": refused, explained in chat; "Pet dog": refused silently (the streamer's own reward)
    assert.deepEqual(await CPB.handleRedemption(ev("e-2", TW.ann, "Buy 500000 PAT"), deps), { outcome: "not_allowlisted" });
    assert.match(said.pop(), /^@Viewer1001, "Buy 500000 PAT" doesn't pay PAT, so nothing was added\. The streamer can refund/);
    assert.deepEqual(await CPB.handleRedemption(ev("e-3", TW.ann, "Pet dog"), deps), { outcome: "not_allowlisted" });
    assert.equal(said.length, 0);
    // a Twitch user with no PATV account
    assert.deepEqual(await CPB.handleRedemption(ev("e-4", "4242", "Buy 5000 PAT"), deps), { outcome: "no_user" });
    assert.match(said.pop(), /no PATV account is linked to your Twitch/);
    assert.deepEqual(await CPB.handleRedemption(ev("e-5", "4242", "Go to the dog park"), deps), { outcome: "no_user" });
    assert.equal(said.length, 0, "not about PAT: no line");
    // budget used up
    live(10);
    assert.deepEqual(await CPB.handleRedemption(ev("e-6", TW.ann, "Buy 5000 PAT"), deps), { outcome: "unfunded" });
    assert.match(said.pop(), /budget is used up/);
    // routed to the Reserve (or not routed at all): never paid by it
    F.sync({ reserve: 76900000, flows: { platform_rewards: "reserve" } });
    assert.deepEqual(await CPB.handleRedemption(ev("e-7", TW.ann, "Buy 5000 PAT"), deps), { outcome: "no_route" });
    assert.match(said.pop(), /paused right now/);
    assert.equal(await bal("u1"), b1 + 25000);
    assert.equal(logs.join("\n").includes(BOT), false, "the token is never logged");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    F.sync({ reserve: 0, flows: {} });
  }
});
