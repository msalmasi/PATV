// PO-2 (economy policy -> site plan, "Phase 6"): the site's policy config store (policy/config.js) in MIRROR mode with the
// consumers' dual read, and its dormant post-H1 behaviour.
//   * the mirror: Pepe's pushes (policy config, capital config, PAT Routing, the funding sync) fill policy_cfg - by "pepe", via
//     "mirror", every key from its best source; a key two pushes carry is cross-checked; the diff report lists keys present on one
//     side only and values the site's checks refuse
//   * the dual read: every consumer (capital.cutoff, capital.reserve, fed.cfgNow, funding.monetary, policy.source) logs its push
//     value vs the site value on a difference, counts its checks per day, and keeps USING THE PUSH
//   * edits: refused in mirror mode, from Telegram, by a non-owner, without the step-up / CSRF / a note / the current rev (409 with
//     the saved values), while frozen or paused (423), for engine-input keys in the 03:40 UTC run window (423); a good one is one
//     new rev with its log row and admin audit row; a no-op answers unchanged; the ceiling log follows the ceiling keys
//   * post-H1 readers use policy_cfg (Pepe's push values ignored); a missing key defers the engines and alerts (never a code
//     default); a deploy migration seeds a missing key once, logged; the bot's read; the admin view; feature pause
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-config.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-config-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const CTL = require(path.join(repo, "pepecontrol"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const S = require(path.join(repo, "policy", "cfgspec"));
const SRC = require(path.join(repo, "policy", "source"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const CC = require(path.join(repo, "capital", "core"));
const FED = require(path.join(repo, "fed", "service"));
const FUND = require(path.join(repo, "funding"));
const FX = require("./fixtures/policycfg");
const OPS = require(path.join(repo, "opsalerts"));

const alerts = [];
OPS.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
let clockMs = Date.UTC(2026, 9, 20, 15, 0);                     // Tuesday 2026-10-20 15:00 UTC
PC._setClock(() => clockMs);
C._setClock(() => clockMs);
const M = FX.M;

let base, server;
const U = { owner: "u_owner", admin: "u_admin", pleb: "u_pleb" };
const NAME = { [U.owner]: "own", [U.admin]: "adm", [U.pleb]: "plb" };
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const h = await bcrypt.hash("pw-right", 4);
  await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, 'own', ?, 'Admin', 'Owner_CF'), (?, 'adm', ?, 'Admin', 'admin_cf'), (?, 'plb', ?, 'pleb', 'pleb_cf')",
                 [U.owner, h, U.admin, h, U.pleb, h]);
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1)");
  await CTL.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  require(path.join(repo, "econstore")).register(app, deps);
  SCH.register(app, deps);
  PC.register(app, deps);
  require(path.join(repo, "policy", "handover")).register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
});
test.after(() => server && server.close());

const bot = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
async function web(p, who, body, { csrf = true } = {}) {
  const headers = { "content-type": "application/json", "x-test-user": who, "X-Requested-With": "fetch", origin: base, host: new URL(base).host };
  if (csrf) headers["x-csrf-token"] = CTL.csrfToken(NAME[who]);
  const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const getJ = (p, who) => fetch(base + p, { headers: { "x-test-user": who } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const nonce = async () => (await web("/api/admin/econ/edit/nonce", U.owner, {})).body.nonce;
const pushAll = async (pol = {}, cap = {}) => {
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush(pol) })).body.ok, true);
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush(cap) })).body.ok, true);
};
const flush = async () => { await PC.flushDual(); };
async function siteOwned(on) {
  await tx(async () => { await PC.putOwner("cfg", on ? "site" : "pepe", { by: "test", handoverKey: on ? "t".repeat(64) : undefined }); });
  await PC.refresh();
}

test("the mirror: Pepe's first pushes fill policy_cfg (by pepe, via mirror) - every key, the diff report empty", async () => {
  await pushAll();
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog(), econ_cfg: {}, econ_cfg_log: [] })).body.ok, true);
  const snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(S.KEYS.filter((k) => !(k in snap.cfg)), [], "every SPEC key is mirrored");
  assert.equal(snap.own.cfg.owner, "pepe");
  assert.ok(snap.rev >= 1 && /^[0-9a-f]{64}$/.test(snap.sha));
  assert.equal(snap.cfg.house_hard_floor, 5 * M);
  assert.equal(snap.cfg.vault_ceil_cushion, false, "a 0.0 / 1.0 sink switch is a bool here (D-7)");
  assert.equal(snap.cfg.bank_insurance, 10 * M);
  assert.deepEqual(snap.cfg.pat_routes, FX.routes());
  assert.equal(snap.meta.vault_ceil_apr.src, "policy:sink.vault_ceil_apr", "the stored sink value is the best source");
  assert.equal(snap.meta.house_hard_floor.src, "policy:econ_cfg.house_hard_floor");
  assert.equal(snap.meta.layers.src, "policy:flags.layers");
  const log = await getQuery("SELECT DISTINCT actor, via FROM policy_cfg_log");
  assert.deepEqual(log, [{ actor: "pepe", via: "mirror" }]);
  const d = await PC.diffReport();
  assert.deepEqual(d.counts, { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 }, JSON.stringify(d.counts));
  assert.equal(d.empty, true);
  // the same pushes again change nothing
  const rev = snap.rev;
  await pushAll();
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev, "an unchanged push writes no rev");
});

test("the mirror: a key two pushes carry is written from its best source; a lasting disagreement is reported; a stale source hands over", async () => {
  const rev0 = (await PC.snapshot({ fresh: true })).rev;
  await pushAll({}, { ceil_apr: 0.25 });
  let snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.vault_ceil_apr, 0, "the capital push's 0.25 doesn't overwrite Pepe's stored sink value");
  assert.equal(snap.rev, rev0);
  let d = await PC.diffReport();
  assert.deepEqual(d.disagree, [], "just changed: pending, not a disagreement yet");
  assert.ok(d.pending.some((x) => x.key === "vault_ceil_apr"));
  clockMs += 11 * 60 * 1000;                                    // both push again past the settle window
  await pushAll({}, { ceil_apr: 0.25 });
  d = await PC.diffReport();
  const dis = d.disagree.find((x) => x.key === "vault_ceil_apr");
  assert.ok(dis, JSON.stringify(d.disagree));
  assert.equal(dis.a.path, "policy:sink.vault_ceil_apr");
  assert.equal(dis.b.path, "capital:ceil_apr");
  assert.equal(d.empty, false);
  // Pepe's policy push stops for over 25 h: the capital push decides the keys it carries
  clockMs += 26 * 3600 * 1000;
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ ceil_apr: 0.25 }) })).body.ok, true);
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.vault_ceil_apr, 0.25);
  assert.equal(snap.meta.vault_ceil_apr.src, "capital:ceil_apr");
  assert.equal(snap.rev, rev0 + 1);
  // ...until he pushes again
  await pushAll();
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.vault_ceil_apr, 0);
  assert.equal(snap.meta.vault_ceil_apr.src, "policy:sink.vault_ceil_apr");
  clockMs += 11 * 60 * 1000;
  await pushAll();
  assert.equal((await PC.diffReport()).empty, true);
});

test("the diff report: keys Pepe has that the site doesn't, values the site's checks refuse - and the mirror never refuses a push", async () => {
  const pol = FX.policyPush();
  pol.econ_cfg.brand_new_knob = 5;
  pol.sink.bank_default_days = 7.5;                            // Pepe's panel takes a float; the site's key is whole days
  pol.burn_cfg.speed = 3;
  assert.equal((await bot("/api/policy/bot/config", { cfg: pol })).body.ok, true);
  const d = await PC.diffReport();
  assert.ok(d.unknown.includes("policy:econ_cfg.brand_new_knob") && d.unknown.includes("policy:burn_cfg.speed"), JSON.stringify(d.unknown));
  assert.ok(d.invalid.some((x) => x.key === "bank_default_days" && /whole number/.test(x.error)), JSON.stringify(d.invalid));
  assert.equal((await PC.snapshot({ fresh: true })).cfg.bank_default_days, 7.5, "mirrored as Pepe has it (the report says the site would refuse it)");
  // the day's evidence keeps the worst counts
  const day = await PC.checkMirrorDay({ force: true });
  assert.ok(day.max.unknown >= 2 && day.max.invalid >= 1);
  await pushAll();
  assert.equal((await PC.diffReport()).empty, true);
});

test("the dual read: every consumer logs push vs site on a difference, counts its checks, and keeps using the push", async () => {
  PC._resetMemory();
  await runQuery("DELETE FROM policy_cfg_dualread");
  await runQuery("DELETE FROM policy_cfg_dualcheck");
  // the capital cut-off reads ceil_apr 0.25 from Pepe's capital push while the site's store (his sink value) says 0
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ ceil_apr: 0.25, staker_max: 0.5 }) })).body.ok, true);
  const c = await CC.cfg({ consumer: "capital.cutoff" });
  assert.equal(c.ceil_apr, 0.25, "mirror mode: the consumer uses the push");
  await CC.cfg({ consumer: "capital.reserve" });                // the loan terms agree
  await CC.cfg();                                               // no consumer named: no comparison
  // the Fed's numbers: Pepe's per-op econ_cfg wins today (T2) - exactly the difference the dual read shows
  const conf = await FED.cfgNow({ mintcap_total: -1, fed_floor: 7 * M });
  assert.equal(conf.cfg.fed_floor, 7 * M, "mirror mode: the per-op econ_cfg still wins");
  // the funding sync's monetary block: Pepe says the House hard floor is 4M, the store 5M
  FUND.sync({ monetary: FX.monetary({ house_hard_floor: 4 * M }) });
  assert.equal(FUND.state.monetary.house_hard_floor, 4 * M, "mirror mode: Pepe's block is used");
  await SRC.read();                                             // the engines' reader: all equal
  await flush();
  const checks = Object.fromEntries((await getQuery("SELECT consumer, checks, diffs FROM policy_cfg_dualcheck")).map((r) => [r.consumer, r]));
  assert.ok(checks["capital.cutoff"].checks >= 1 && checks["capital.cutoff"].diffs >= 1);
  assert.equal(checks["capital.reserve"].diffs, 0);
  assert.ok(checks["capital.reserve"].checks >= 1);
  assert.ok(checks["fed.cfgNow"].diffs >= 1);
  assert.ok(checks["funding.monetary"].diffs >= 1);
  assert.equal(checks["policy.source"].diffs, 0);
  assert.ok(checks["policy.source"].checks >= 1);
  assert.equal(checks.capital, undefined);
  const rows = await getQuery("SELECT consumer, key, push, site, n FROM policy_cfg_dualread ORDER BY consumer, key");
  const has = (consumer, key, push, site) => rows.some((r) => r.consumer === consumer && r.key === key && r.push === push && r.site === site);
  assert.ok(has("capital.cutoff", "ceil_apr", "0.25", "0"), JSON.stringify(rows));
  assert.ok(has("fed.cfgNow", "fed_floor", String(7 * M), String(25 * M)), JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.consumer === "fed.cfgNow" && r.key === "mintcap_total"), "-1 = -1: no difference");
  assert.ok(has("funding.monetary", "house_hard_floor", String(4 * M), String(5 * M)), JSON.stringify(rows));
  // the same difference again counts, it doesn't add a row
  await CC.cfg({ consumer: "capital.cutoff" });
  await flush();
  const n = (await getQuery("SELECT n FROM policy_cfg_dualread WHERE consumer = 'capital.cutoff' AND key = 'ceil_apr'"))[0].n;
  assert.equal(n, 2);
  // the reader of the push agrees: back in step
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true);
  FUND.sync({ monetary: FX.monetary() });
});

test("edits: refused in mirror mode, by a non-owner, cross-site, without a note / the step-up / the current rev; a good one is one rev, logged and audited", async () => {
  clockMs = Date.UTC(2026, 9, 22, 2, 0);                        // Thursday 02:00 UTC: before the day's run window
  let snap = await PC.snapshot({ fresh: true });
  const body = (o) => Object.assign({ changes: { fed_floor: "30m" }, note: "raise the floor", base_rev: snap.rev }, o);
  // mirror mode: the config is Pepe's
  let r = await web("/api/admin/policy/cfg", U.owner, body({ nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "mirror");
  await siteOwned(true);
  snap = await PC.snapshot({ fresh: true });
  r = await web("/api/admin/policy/cfg", U.admin, body({ nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "owner_only");
  r = await web("/api/admin/policy/cfg", U.owner, body({ nonce: await nonce(), password: "pw-right" }), { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "cross_site");
  r = await web("/api/admin/policy/cfg", U.owner, body({ note: "", nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 400);
  r = await web("/api/admin/policy/cfg", U.owner, body({}));
  assert.equal(r.status, 409, "no nonce");
  r = await web("/api/admin/policy/cfg", U.owner, body({ nonce: await nonce(), password: "pw-wrong" }));
  assert.equal(r.status, 403);
  // a stale rev: 409 with the saved values, nothing changed
  r = await web("/api/admin/policy/cfg", U.owner, body({ base_rev: snap.rev - 1, nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale_rev");
  assert.equal(r.body.rev, snap.rev);
  assert.deepEqual(r.body.saved, { fed_floor: 25 * M });
  // invalid: the whole config is checked (Pepe's rules, his words)
  r = await web("/api/admin/policy/cfg", U.owner, body({ changes: { fed_floor: "200m" }, nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /fed_floor \(200,000,000\) can't be above fed_ceiling \(150,000,000\)/);
  // a fraction key from the web: the number is a percent
  r = await web("/api/admin/policy/cfg", U.owner, body({ changes: { fed_floor: "30m", vault_staker_max: 40 }, nonce: await nonce(), password: "pw-right" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rev, snap.rev + 1);
  assert.deepEqual(r.body.changed.map((x) => [x.key, x.new, x.applies]), [["fed_floor", 30 * M, "next_period"], ["vault_staker_max", 0.4, "now"]]);
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.fed_floor, 30 * M);
  assert.equal(snap.meta.fed_floor.by, "own (owner_cf)", "the site username + the linked chat login (plan section 8)");
  assert.equal(snap.meta.fed_floor.via, "web");
  const log = await getQuery("SELECT actor, actor_user_id, via, key, old, new, note FROM policy_cfg_log WHERE rev = ? ORDER BY id", [snap.rev]);
  assert.deepEqual(log.map((x) => [x.actor, x.actor_user_id, x.via, x.key, x.old, x.new, x.note]),
                   [["own (owner_cf)", U.owner, "web", "fed_floor", String(25 * M), String(30 * M), "raise the floor"],
                    ["own (owner_cf)", U.owner, "web", "vault_staker_max", "0.5", "0.4", "raise the floor"]]);
  assert.equal((await getJ("/api/admin/policy/cfg/log?actor=own", U.admin)).body.rows.length, 2, "the log filters by the site username");
  const aud = await getQuery("SELECT admin_id, action, detail, reason FROM admin_audit WHERE action = 'policy.cfg'");
  assert.equal(aud.length, 1);
  assert.equal(aud[0].admin_id, U.owner);
  assert.equal(aud[0].reason, "raise the floor");
  // the same values again: unchanged, no new rev
  r = await web("/api/admin/policy/cfg", U.owner, { changes: { fed_floor: "30,000,000" }, note: "again", base_rev: snap.rev, nonce: await nonce(), password: "pw-right" });
  assert.equal(r.status, 200);
  assert.equal(r.body.unchanged, true);
  assert.equal(r.body.msg, "no change (already set)");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev);
});

test("Pepe's chat (cfg/set): a Pepe owner only, never Telegram; a fraction key must spell the %; the ceiling log follows the ceiling keys", async () => {
  let snap = await PC.snapshot({ fresh: true });
  let r = await bot("/api/policy/bot/cfg/set", { actor: "Owner_CF", via: "telegram", base_rev: snap.rev, changes: { donation_rate: "600k" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "telegram");
  r = await bot("/api/policy/bot/cfg/set", { actor: "admin_cf", via: "chat", base_rev: snap.rev, changes: { donation_rate: "600k" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "owner_only");
  r = await bot("/api/policy/bot/cfg/set", { password: "nope", actor: "owner_cf", base_rev: snap.rev, changes: { donation_rate: "600k" } });
  assert.equal(r.status, 403);
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "chat", base_rev: snap.rev, changes: { VAULT_CEIL_APR: "25" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown key 'vault_ceil_apr'|add %/);
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "chat", base_rev: snap.rev, changes: { vault_ceil_apr: "25" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /add %/);
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "chat", base_rev: snap.rev, changes: { Vault_Ceil_Apr: "25%", vault_ceil_cushion: "on", vault_house_min: "6m" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.vault_ceil_apr, 0.25);
  assert.equal(snap.cfg.vault_ceil_cushion, true);
  assert.equal(snap.cfg.house_hard_floor, 6 * M, "an alias names the one key");
  assert.equal(snap.meta.vault_ceil_apr.via, "chat");
  const ceil = await getQuery("SELECT rev, ceil_apr, ceil_cushion, ceil_cushion_days, by, via FROM capital_ceil_log");
  assert.deepEqual(ceil, [{ rev: snap.rev, ceil_apr: 0.25, ceil_cushion: 1, ceil_cushion_days: 8, by: "owner_cf", via: "chat" }]);
  const aud = await getQuery("SELECT admin_id FROM admin_audit WHERE action = 'policy.cfg' ORDER BY id DESC LIMIT 1");
  assert.equal(aud[0].admin_id, "chat:owner_cf");
  // a read-only key is never a person's
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { epoch_hour: 5 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /read-only/);
  // the mirror stops while the site owns the config: Pepe's push no longer writes
  await pushAll({ econ_cfg: { donation_rate: 999 } });
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 500000);
});

test("the run window (T22): engine-input keys are frozen from 03:40 UTC until the day's runs settle; other keys aren't", async () => {
  const day = Date.UTC(2026, 9, 21);                            // Wednesday
  clockMs = day + (3 * 3600 + 50 * 60) * 1000;                  // 03:50 UTC
  let snap = await PC.snapshot({ fresh: true });
  let r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { fed_ceiling: "160m" } });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.equal(r.body.code, "run_window");
  assert.deepEqual(r.body.window.waiting, ["treasury:D2026-10-21", "monetary:D2026-10-21"]);
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { donation_rate: "600k" } });
  assert.equal(r.status, 200, "a key no engine reads applies now");
  snap = await PC.snapshot({ fresh: true });
  // Pepe ran the treasury's day; the monetary day still waits
  await pushAll({ days_done: ["D2026-10-21"] });
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { fed_ceiling: "160m" } });
  assert.equal(r.status, 423);
  assert.deepEqual(r.body.window.waiting, ["monetary:D2026-10-21"]);
  // the site recorded the monetary day missed: settled
  await C.putRun("monetary", "D2026-10-21", { state: "missed", via: "site", error: "test" });
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { fed_ceiling: "160m" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // before 03:40 nothing is frozen; a Monday waits for the epoch too
  clockMs = Date.UTC(2026, 9, 26) + (3 * 3600 + 39 * 60) * 1000;
  assert.equal((await PC.runWindow(clockMs / 1000)).open, false);
  clockMs = Date.UTC(2026, 9, 26) + (5 * 3600) * 1000;
  assert.deepEqual((await PC.runWindow(clockMs / 1000)).waiting, ["treasury:W2026-10-26", "treasury:D2026-10-26", "monetary:D2026-10-26"]);
  clockMs = Date.UTC(2026, 9, 21, 15, 0);
});

test("frozen for the hand-over or paused: every edit is 423; the pause is one audited transaction and the admins are told", async () => {
  let snap = await PC.snapshot({ fresh: true });
  alerts.length = 0;
  const res = await PC.setPause(["cfg"], true, { by: "own", auditId: U.owner, via: "admin", note: "checking a bug" });
  assert.deepEqual(res, [{ feature: "cfg", paused: true }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /cfg PAUSED by own/);
  let r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { donation_rate: "650k" } });
  assert.equal(r.status, 423);
  assert.equal(r.body.code, "paused");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'policy.feature_pause'"))[0].n, 1);
  assert.deepEqual(await PC.setPause(["cfg"], true, { by: "own" }), [{ feature: "cfg", paused: true, unchanged: true }]);
  await PC.setPause(["cfg"], false, { by: "own", auditId: U.owner, note: "fixed" });
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { donation_rate: "650k" } });
  assert.equal(r.status, 200);
  snap = await PC.snapshot({ fresh: true });
  await tx(async () => { await PC.putOwner("cfg", "cutting", { by: "test" }); });
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { donation_rate: "700k" } });
  assert.equal(r.status, 423);
  assert.equal(r.body.code, "frozen");
  await siteOwned(true);
});

test("post-H1 readers use the store - Pepe's pushed values are ignored; Fed ops ignore the per-op econ_cfg", async () => {
  await pushAll({ econ_cfg: { fed_floor: 99 * M }, consts: { HOUSE_MIN_CASH: 1 * M }, flags: { ap_on: true }, tz: "Europe/London" }, { ceil_apr: 0.4, rloan_base: 1 });
  const s = await SRC.read();
  const snap = await PC.snapshot({ fresh: true });
  assert.equal(s.from, "site");
  assert.equal(s.owner, "site");
  assert.equal(s.econ_cfg.fed_floor, snap.cfg.fed_floor);
  assert.equal(s.econ_cfg.fed_floor, 30 * M);
  assert.equal(s.consts.HOUSE_MIN_CASH, 6 * M, "the constant follows its key (house_hard_floor)");
  assert.equal(s.flags.ap_on, false);
  assert.equal(s.tz, "America/New_York");
  assert.equal((await SRC.config()).cfg.fed_floor, 30 * M);
  const c = await CC.cfg();
  assert.equal(c.ceil_apr, 0.25, "the capital knobs are the store's");
  assert.equal(c.ceil_cushion, 1);
  assert.equal(c.rloan_base, 10000);
  assert.equal(c.house_min_cash, 6 * M);
  assert.equal(c.flash.room, 3 * M, "derived state stays the push's");
  const conf = await FED.cfgNow({ mintcap_total: -1, fed_floor: 1 });
  assert.equal(conf.cfg.fed_floor, 30 * M, "the per-op econ_cfg is ignored");
  assert.equal(conf.cfg.mintcap_total, snap.cfg.mintcap_total);
});

test("post-H1 PAT Routing (D-19): the pools card changes the store directly (checked against Pepe's catalog); his pushed table is ignored", async () => {
  const ES = require(path.join(repo, "econstore"));
  // review of PO-2: the card's view carries the settings' rev; a routing edit must send it back (stale / missing: 409) with a note
  const view = await fetch(base + "/api/admin/econ/store", { headers: { "x-test-user": U.owner } }).then((x) => x.json());
  let snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(view.cfg, { owner: "site", rev: snap.rev });
  const edit = async (o) => web("/api/admin/econ/edit", U.owner, Object.assign({ op: "routes", nonce: await nonce(), password: "pw-right" }, o));
  let r = await edit({ flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], note: "more to the budget" });
  assert.equal(r.status, 409, "no base_rev: never last-writer-wins");
  assert.match(r.body.error, /rev is missing/);
  r = await edit({ flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], base_rev: snap.rev - 1, note: "more to the budget" });
  assert.equal(r.status, 409, "a stale rev");
  assert.match(r.body.error, /changed since you loaded them/);
  r = await edit({ flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], base_rev: snap.rev, note: "" });
  assert.equal(r.status, 400, "a note says why");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev, "nothing changed");
  r = await edit({ flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], base_rev: snap.rev, note: "more to the budget" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.applied, true, "applied here, not queued for Pepe");
  snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(snap.cfg.pat_routes.raffle, [["incentives", 60], ["reserve", 40]]);
  assert.deepEqual(snap.cfg.pat_routes.cmd_song, FX.routes().cmd_song, "the other flows keep their overrides");
  assert.equal(snap.meta.pat_routes.by, "own (owner_cf)");
  assert.equal((await getQuery("SELECT note FROM policy_cfg_log WHERE key = 'pat_routes' ORDER BY id DESC LIMIT 1"))[0].note, "more to the budget");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'econ.routes'").catch(() => [{ n: 0 }]))[0].n, 0);
  // Pepe's routing rules (his catalog): a payout flow can't pay stakers; a read-only flow can't change
  r = await edit({ flow: "raffle", shares: [["stakers", 100]], base_rev: snap.rev, note: "try stakers" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /raffle can't send 100% to stakers/);
  r = await edit({ flow: "wheel", shares: [["reserve", 100]], base_rev: snap.rev, note: "try the wheel" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /wheel is read-only/);
  // a reset drops the override
  r = await edit({ flow: "raffle", reset: true, base_rev: snap.rev, note: "back to the default" });
  assert.equal(r.status, 200);
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.pat_routes.raffle, undefined);
  // Pepe's pushed table is ignored now; econstore (and Pepe's pull) read the store
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: { raffle: [["reserve", 100]] } })).body.ok, true);
  assert.deepEqual((await ES.getSettings()).pat_routes, snap.cfg.pat_routes);
  assert.deepEqual((await PC.snapshot({ fresh: true })).cfg.pat_routes, snap.cfg.pat_routes);
});

test("a key missing once the site owns the config: the engines defer and the owners are alerted - never a code default; a migration seeds it once", async () => {
  alerts.length = 0;
  PC._resetMemory();
  await runQuery("DELETE FROM policy_cfg WHERE key = 'fed_ceiling'");
  PC.forget();
  await assert.rejects(SRC.read(), (e) => e.code === "E_CFG_MISSING" && e.missing.includes("fed_ceiling"));
  await SCH.loop();                                             // the scheduler's pass: deferred, nothing thrown out of it
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(alerts.some((a) => /missing 1 key/.test(a.title) && /fed_ceiling/.test(a.body)), JSON.stringify(alerts));
  await assert.rejects(PC.edit({ changes: { donation_rate: 1 }, via: "chat", actor: "owner_cf", baseRev: (await PC.snapshot({ fresh: true })).rev }),
                       (e) => e.code === "E_CFG_MISSING");
  // the boot check says it loudly too
  assert.deepEqual((await PC.bootCheck()).missing, ["fed_ceiling"]);
  // a deploy migration seeds a reviewed value - once, logged
  const mig = [{ id: "2026-10-30-test", note: "restore the ceiling", seeds: { fed_ceiling: 160 * M, fed_floor: 1 } }];
  assert.equal(await PC.applyMigrations(mig), 1, "only the missing key is seeded (fed_floor is there)");
  assert.equal(await PC.applyMigrations(mig), 0);
  const snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.cfg.fed_ceiling, 160 * M);
  assert.equal(snap.cfg.fed_floor, 30 * M);
  assert.deepEqual(await getQuery("SELECT migration, key, value FROM policy_cfg_seed"), [{ migration: "2026-10-30-test", key: "fed_ceiling", value: String(160 * M) }]);
  const lg = (await getQuery("SELECT actor, via, key, note FROM policy_cfg_log WHERE via = 'migration'"))[0];
  assert.deepEqual(lg, { actor: "migration 2026-10-30-test", via: "migration", key: "fed_ceiling", note: "restore the ceiling" });
  assert.equal((await SRC.read()).econ_cfg.fed_ceiling, 160 * M);
  await assert.rejects(PC.applyMigrations([{ id: "bad", seeds: { fed_ceiling: "lots" } }]).then(async () => {
    await runQuery("DELETE FROM policy_cfg WHERE key = 'tz'");
    PC.forget();
    return PC.applyMigrations([{ id: "bad-tz", seeds: { tz: 5 } }]);
  }), /migration bad-tz: tz must be text/);
  await PC.applyMigrations([{ id: "tz-back", seeds: { tz: "America/New_York" } }]);
});

test("the bot's read: the whole config, or 'unchanged' at Pepe's rev AND sha; the token is required", async () => {
  const snap = await PC.snapshot({ fresh: true });
  let r = await fetch(base + "/api/policy/bot/cfg", { headers: { "x-bot-token": "bot" } }).then((x) => x.json());
  assert.equal(r.ok, true);
  assert.equal(r.rev, snap.rev);
  assert.equal(r.sha, snap.sha);
  assert.equal(r.owner, "site");
  assert.equal(r.cfg.fed_ceiling, 160 * M);
  assert.equal(r.spec_hash, PC.specHash());
  assert.ok(Array.isArray(r.log_tail) && r.log_tail.length);
  r = await fetch(base + `/api/policy/bot/cfg?have=${snap.rev}&sha=${snap.sha}`, { headers: { "x-bot-token": "bot" } }).then((x) => x.json());
  assert.equal(r.unchanged, true);
  assert.equal(r.cfg, undefined);
  assert.deepEqual((await C.meta("cfg_pepe_rev")).rev, snap.rev, "the rev Pepe has applied (shown on the card)");
  assert.deepEqual((await C.meta("cfg_pepe_rev")).sha, snap.sha);
  // review of PO-2: a rev alone is never trusted - the same rev with another sha (or none) gets the whole config
  r = await fetch(base + "/api/policy/bot/cfg?have=" + snap.rev, { headers: { "x-bot-token": "bot" } }).then((x) => x.json());
  assert.equal(r.unchanged, undefined);
  assert.equal(r.cfg.fed_ceiling, 160 * M);
  r = (await bot("/api/policy/bot/cfg", { have: snap.rev, sha: "0".repeat(64) })).body;
  assert.equal(r.unchanged, undefined);
  assert.ok(r.cfg);
  r = (await bot("/api/policy/bot/cfg", { have: snap.rev - 1 })).body;
  assert.ok(r.cfg);
  const no = await fetch(base + "/api/policy/bot/cfg");
  assert.equal(no.status, 403);
});

test("the admin view: every key with its value, unit, bounds, applies and last change; the change log filters; Admins read, owners edit", async () => {
  const r = await getJ("/api/admin/policy/cfg", U.admin);
  assert.equal(r.status, 200);
  const v = r.body;
  assert.equal(v.keys.length, S.KEYS.length);
  for (const k of v.keys) {
    assert.ok(k.present, k.key);
    assert.ok(k.unit && ["now", "next_period"].includes(k.applies) && typeof k.engine_input === "boolean", k.key);
    assert.ok(k.shown !== null && k.last && k.last.by && k.last.via && k.last.ts, k.key);
    if (["int", "cap", "pct", "num"].includes(k.kind)) assert.ok(Number.isFinite(k.min) && Number.isFinite(k.max), k.key + " bounds");
  }
  const vc = v.keys.find((k) => k.key === "vault_ceil_apr");
  assert.equal(vc.shown, "25%");
  assert.equal(vc.unit, "fraction");
  assert.equal(v.can_edit, false, "an Admin who isn't a Pepe owner reads only");
  assert.equal((await getJ("/api/admin/policy/cfg", U.owner)).body.can_edit, true);
  assert.ok(v.dual && Array.isArray(v.dual.checks));
  assert.ok(v.diff && v.diff.counts);
  const lg = (await getJ("/api/admin/policy/cfg/log?key=vault_ceil_apr", U.admin)).body.rows;
  assert.ok(lg.length >= 2 && lg.every((x) => x.key === "vault_ceil_apr"));
  assert.equal((await getJ("/api/admin/policy/cfg/log?via=chat", U.admin)).body.rows.every((x) => x.via === "chat"), true);
  assert.equal((await fetch(base + "/api/admin/policy/cfg").then((x) => x.status)), 401);
});

test("feature pause from the admin card: a Pepe owner with the step-up and a note; from the shell with no role", async () => {
  let r = await web("/api/admin/policy/pause", U.admin, { feature: "cfg", pause: true, note: "nope", nonce: await nonce(), password: "pw-right" });
  assert.equal(r.status, 403);
  r = await web("/api/admin/policy/pause", U.owner, { feature: "nope", pause: true, note: "a bad one" });
  assert.equal(r.status, 400);
  r = await web("/api/admin/policy/pause", U.owner, { feature: "cfg", pause: true, note: "x" });
  assert.equal(r.status, 400, "a pause says why");
  r = await web("/api/admin/policy/pause", U.owner, { feature: "cfg", pause: true, note: "the web edit misbehaves", nonce: await nonce(), password: "pw-right" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.features, [{ feature: "cfg", paused: true }]);
  assert.equal((await PC.ownership()).cfg.paused, 1);
  r = await web("/api/admin/policy/pause", U.owner, { feature: "cfg", pause: false, nonce: await nonce(), password: "pw-right" });
  assert.equal(r.status, 200);
  assert.equal((await PC.ownership()).cfg.paused, 0);
  // the shell: tools/policy-backend.js pause cfg (status reads the store)
  const { spawnSync } = require("child_process");
  const run = (...a) => spawnSync(process.execPath, [path.join(repo, "tools", "policy-backend.js"), ...a], { cwd: tmp, encoding: "utf8", env: Object.assign({}, process.env, { NODE_PATH: process.env.NODE_PATH || "" }) });
  let x = run("--actor=boss", "pause", "cfg", "--note", "shell test");
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, /cfg: PAUSED by boss/);
  assert.match(x.stdout, /feature {2}cfg {9}site/);
  PC.forget();
  assert.equal((await PC.ownership()).cfg.paused, 1);
  x = run("--actor=boss", "resume", "features");
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, /cfg: resumed by boss/);
  assert.match(x.stdout, /budget: already running/);
  x = run("preflight");
  assert.match(x.stdout, /PASS {2}every config key present \(policy_cfg\): 112 keys/);
  assert.match(x.stdout, /PASS {2}no feature paused/);
});

test("review of PO-2: the admin reads are an Admin's; the web edit is same-site; a feature pause needs the step-up; Telegram never edits", async () => {
  // a signed-in non-Admin reads neither the settings nor their log
  assert.equal((await getJ("/api/admin/policy/cfg", U.pleb)).status, 403);
  assert.equal((await getJ("/api/admin/policy/cfg/log", U.pleb)).status, 403);
  // the web edit is a same-site fetch: the CSRF token alone isn't enough
  const snap = await PC.snapshot({ fresh: true });
  const raw = async (headers) => {
    const body = { changes: { donation_rate: "610k" }, note: "same-site check", base_rev: snap.rev, nonce: await nonce(), password: "pw-right" };
    const r = await fetch(base + "/api/admin/policy/cfg", { method: "POST", body: JSON.stringify(body),
      headers: Object.assign({ "content-type": "application/json", "x-test-user": U.owner, "x-csrf-token": CTL.csrfToken("own") }, headers) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let r = await raw({ origin: base, host: new URL(base).host });
  assert.equal(r.status, 403, "no X-Requested-With: fetch");
  assert.equal(r.body.code, "cross_site");
  r = await raw({ "X-Requested-With": "fetch", origin: "https://elsewhere.example", host: new URL(base).host });
  assert.equal(r.status, 403, "another site's origin");
  assert.equal(r.body.code, "cross_site");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev, "nothing changed");
  // pausing a FEATURE takes the password step-up like an engine's
  r = await web("/api/admin/policy/pause", U.owner, { feature: "cfg", pause: true, note: "a good reason" });
  assert.equal(r.status, 409, "no nonce");
  r = await web("/api/admin/policy/pause", U.owner, { feature: "cfg", pause: true, note: "a good reason", nonce: await nonce(), password: "pw-wrong" });
  assert.equal(r.status, 403, "a wrong password");
  assert.equal((await PC.ownership()).cfg.paused, 0);
  // the store itself refuses Telegram (not only the route)
  await assert.rejects(PC.edit({ changes: { donation_rate: "620k" }, via: "telegram", actor: "owner_cf", baseRev: snap.rev }), (e) => e.status === 403 && e.code === "telegram");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev);
});

test("review of PO-2: Pepe's route is the chat path - via is chat (the % rule, the log); naming web / cli is refused", async () => {
  clockMs = Date.UTC(2026, 9, 22, 2, 0);                        // before the day's run window (the ceiling feeds the cut-off)
  let snap = await PC.snapshot({ fresh: true });
  let r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "web", base_rev: snap.rev, changes: { vault_ceil_apr: "30" } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "bad_via");
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "cli", base_rev: snap.rev, changes: { donation_rate: "630k" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "bad_via");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev, "nothing changed");
  // via left out = chat: a bare number for a fraction key is still refused, the % passes and is logged as chat
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { vault_ceil_apr: "30" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /add %/);
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "chat", base_rev: snap.rev, changes: { vault_ceil_apr: "30%" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  snap = await PC.snapshot({ fresh: true });
  assert.equal(snap.meta.vault_ceil_apr.via, "chat");
  const aud = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'policy.cfg' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(JSON.parse(aud.detail).via, "chat");
  r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", base_rev: snap.rev, changes: { vault_ceil_apr: "25%" } });
  assert.equal(r.status, 200);
});

test("review of the owner answers (CF9 / CF18): an edit without base_rev is refused like a stale one; the capital reader throws E_CFG_MISSING for a missing knob (never DEFAULT_CFG)", async () => {
  clockMs = Date.UTC(2026, 9, 22, 2, 0);                        // before the day's run window
  await siteOwned(true);
  const snap = await PC.snapshot({ fresh: true });
  for (const baseRev of [undefined, null]) {
    await assert.rejects(PC.edit({ changes: { donation_rate: "640k" }, via: "chat", actor: "owner_cf", baseRev }),
                         (e) => e.status === 409 && e.code === "stale_rev" && e.extra && e.extra.rev === snap.rev, `base_rev ${baseRev}`);
  }
  const r = await bot("/api/policy/bot/cfg/set", { actor: "owner_cf", via: "chat", changes: { donation_rate: "640k" } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "stale_rev");
  assert.equal((await PC.snapshot({ fresh: true })).rev, snap.rev, "nothing changed - never last-writer-wins");
  // a capital knob missing from the store once the site owns it: the cut-off's reader defers, never DEFAULT_CFG's value
  const row = (await getQuery("SELECT * FROM policy_cfg WHERE key = 'vault_ceil_apr'"))[0];
  assert.ok(row);
  await runQuery("DELETE FROM policy_cfg WHERE key = 'vault_ceil_apr'");
  PC.forget();
  try {
    await assert.rejects(CC.cfg({ consumer: "capital.cutoff" }), (e) => e.code === "E_CFG_MISSING" && e.missing.includes("vault_ceil_apr"));
  } finally {
    await runQuery("INSERT INTO policy_cfg (key, value, rev, updated, by, via, src) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [row.key, row.value, row.rev, row.updated, row.by, row.via, row.src]);
    PC.forget();
  }
  assert.equal((await CC.cfg({ consumer: "capital.cutoff" })).ceil_apr, snap.cfg.vault_ceil_apr, "back: the store's value");
});

test("the Phase 4b switches (D-1): shown read-only from Pepe's push - none pushed yet / a malformed block reads unknown, never a guess", async () => {
  const keep = await C.meta("cfg");
  const view = async () => (await getJ("/api/admin/policy/cfg", U.admin)).body.phase4b;
  try {
    const noBlock = Object.assign({}, keep);
    delete noBlock.phase4b;
    await C.setMeta("cfg", noBlock);
    let p4 = await view();
    assert.equal(p4.owner, "pepe");
    assert.equal(p4.readonly, true);
    assert.equal(p4.pushed, false, "an older Pepe's push has no block");
    assert.deepEqual(p4.rows.map((r) => r.key), PC.PHASE4B.map((x) => x[0]));
    assert.ok(p4.rows.every((r) => r.on === null && r.live === null && r.present === false && /^!econ [a-z]+ on\|off$/.test(r.cmd)));
    // reverify of 1.99adw (S2 / S4): `at` is the push's own time (seconds) in ms - a push stored 2 days ago reads 2 days ago
    const pushAt = Math.floor(Date.now() / 1000) - 2 * 86400 + 0.4;
    await C.setMeta("cfg", Object.assign({}, keep, { at: pushAt, phase4b: { econ_room_vaults: { on: "yes", live: 1 }, econ_convoys: [true],
                                                                econ_vwm: { on: true, live: false }, econ_bogus: { on: true } } }));
    p4 = await view();
    const by = (k) => p4.rows.find((r) => r.key === k);
    assert.equal(p4.pushed, true);
    assert.equal(p4.at, Math.round(pushAt * 1000), "as of his push, in ms (never the read's clock, never seconds)");
    assert.deepEqual([by("econ_room_vaults").present, by("econ_room_vaults").on, by("econ_room_vaults").live], [true, null, null], "not booleans: unknown");
    assert.deepEqual([by("econ_convoys").present, by("econ_convoys").on], [false, null], "a malformed entry: not there");
    assert.deepEqual([by("econ_vwm").on, by("econ_vwm").live], [true, false]);
    assert.equal(p4.rows.some((r) => r.key === "econ_bogus"), false, "only the known switches");
    await C.setMeta("cfg", Object.assign({}, keep, { phase4b: [1, 2] }));
    assert.equal((await view()).pushed, false, "an array is no block");
    const noAt = Object.assign({}, keep, { phase4b: { econ_vwm: { on: true, live: true } } });
    delete noAt.at;
    await C.setMeta("cfg", noAt);
    p4 = await view();
    assert.deepEqual([p4.pushed, p4.at], [true, null], "a push without its time: shown, `at` unknown (null) - never now");
    const snap = await PC.snapshot({ fresh: true });
    assert.equal(Object.keys(snap.cfg).some((k) => /^econ_/.test(k)), false, "never in the config store");
  } finally {
    await C.setMeta("cfg", keep);
  }
});
