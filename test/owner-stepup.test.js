// Owner answers 2026-10-20, (3): the password step-up NOW on the PAT grant (POST /api/admin/transfer/:username), the House
// adjust (POST /api/g/wheel/jackpot) and the direct web owner grant / removal on /admin/roles (POST /api/admin/roles/role) -
// the same throttled step-up as the /admin/economy edit (stepup.js -> econstore.stepUp): a same-origin fetch (X-Requested-With
// + an Origin / Referer naming this host), a single-use nonce (/api/admin/stepup/nonce {for}, /api/admin/roles/nonce - a Pepe
// owner's only) and the account password, 5 wrong in 15 minutes -> 429. Cross-site requests never spend the nonce.
//   NODE_PATH=G:/PATV/node_modules node --test test/owner-stepup.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "owner-stepup-test-")));
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const F = require(path.join(repo, "funding"));

let base, server;
const U = { owner: "u_owner", admin: "u_admin", nolink: "u_nolink", ann: "u_ann", owner2: "u_owner2", owner3: "u_owner3" };
const NAME = { u_owner: "own", u_admin: "adm", u_nolink: "nol", u_ann: "ann", u_owner2: "own2", u_owner3: "own3" };
const OWNER_RE = /owners only/;
const budget = (balance) => ({ balance, week: "W2026-10-19", remaining: { welcome: 0 }, budgets: { welcome: 0 }, groups: { new_account: "welcome" } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE classes (classId TEXT PRIMARY KEY, class TEXT)");
  const h = await bcrypt.hash("pw-right", 4);
  for (const [id, cls, cf] of [[U.owner, "Admin", "Owner_CF"], [U.admin, "Admin", "admin_cf"], [U.nolink, "Admin", null], [U.ann, "pleb", "ann_cf"],
                               [U.owner2, "Admin", "owner2_cf"], [U.owner3, "Admin", "owner3_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?, ?)", [id, NAME[id], NAME[id], h, cls, cf]);
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1), ('owner2_cf', 'owner', 1), ('owner3_cf', 'owner', 1)");
  await require(path.join(repo, "pepecontrol")).init();
  await require(path.join(repo, "adminaudit")).init();
  await F.claims();
  F.sync({ reserve: 1e9, flows: {}, incentives: budget(1e6) });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  // the handlers index.js mounts
  const SG = require(path.join(repo, "staffgrant"));
  app.post("/api/g/wheel/jackpot", addUser, (req, res) => SG.houseAdjustRoute(req, res));
  app.post("/api/admin/transfer/:username", addUser, (req, res) => SG.grantRoute(req, res));
  app.post("/api/admin/stepup/nonce", addUser, (req, res) => require(path.join(repo, "stepup")).nonceRoute(req, res));
  SR.register(app, { isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "adminroles")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

async function call(p, who, body = {}, extra = {}) {
  const headers = Object.assign({ "content-type": "application/json", "x-test-user": who || "", "X-Requested-With": "fetch", origin: base }, extra);
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  const r = await fetch(base + p, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM jackpot_rakes"))[0].t;
const nonce = async (who, purpose) => (await call("/api/admin/stepup/nonce", who, { for: purpose })).body.nonce;
const CROSS = [["a foreign Origin", { origin: "https://evil.example" }], ["no X-Requested-With", { "X-Requested-With": null }],
               ["no Origin or Referer at all", { origin: null }]];

test("the step-up nonce: a Pepe owner of that action only, same-origin fetch only, a known purpose", async () => {
  for (const who of [U.admin, U.nolink, U.ann]) {
    const r = await call("/api/admin/stepup/nonce", who, { for: "grant" });
    assert.equal(r.status, 403, NAME[who]);
    assert.equal(r.body.code, "owner_only");
  }
  for (const [why, extra] of CROSS) {
    const r = await call("/api/admin/stepup/nonce", U.owner, { for: "grant" }, extra);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.code, "cross_site", why);
  }
  assert.equal((await call("/api/admin/stepup/nonce", U.owner, { for: "anything" })).status, 400);
  assert.equal((await call("/api/admin/stepup/nonce", "", { for: "grant" })).status, 401);
  assert.ok(await nonce(U.owner, "grant"));
  assert.ok(await nonce(U.owner, "house"));
});

test("the PAT grant: an owner needs the nonce + password; a cross-site request is refused without spending the nonce; nothing moves until it passes", async () => {
  const b0 = await bal(U.ann);
  // an Admin who isn't an owner: 403 before any step-up (PO-0b), even with someone's nonce and the right password
  const stolen = await nonce(U.owner, "grant");
  const na = await call("/api/admin/transfer/ann", U.admin, { amount: 500, nonce: stolen, password: "pw-right" });
  assert.equal(na.status, 403);
  assert.match(na.body.message, OWNER_RE);
  // the owner: no nonce -> 409; a cross-site request -> 403 (the nonce is not spent); a wrong password -> 403 (spent)
  const none = await call("/api/admin/transfer/ann", U.owner, { amount: 500, password: "pw-right" });
  assert.equal(none.status, 409, JSON.stringify(none.body));
  assert.equal(none.body.code, "nonce");
  const n1 = await nonce(U.owner, "grant");
  for (const [why, extra] of CROSS) {
    const r = await call("/api/admin/transfer/ann", U.owner, { amount: 500, nonce: n1, password: "pw-right" }, extra);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.code, "cross_site", why);
  }
  assert.equal(await bal(U.ann), b0, "nothing moved");
  const wrong = await call("/api/admin/transfer/ann", U.owner, { amount: 500, nonce: n1, password: "pw-wrong" });
  assert.equal(wrong.status, 403, "the cross-site tries didn't spend the nonce: the password is checked now");
  assert.equal(wrong.body.code, "password");
  assert.equal((await call("/api/admin/transfer/ann", U.owner, { amount: 500, nonce: n1, password: "pw-right" })).status, 409, "single use");
  // another owner's nonce is not mine
  const other = await nonce(U.owner2, "grant");
  assert.equal((await call("/api/admin/transfer/ann", U.owner, { amount: 500, nonce: other, password: "pw-right" })).status, 409);
  assert.equal(await bal(U.ann), b0, "still nothing moved");
  const ok = await call("/api/admin/transfer/ann", U.owner, { amount: 500, nonce: await nonce(U.owner, "grant"), password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await bal(U.ann), b0 + 500);
});

test("the House adjust: the same step-up before the Fed <-> House move", async () => {
  const h0 = await house();
  const none = await call("/api/g/wheel/jackpot", U.owner, { amount: 1000, reason: "a reason long enough" });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "nonce");
  const n1 = await nonce(U.owner, "house");
  const cross = await call("/api/g/wheel/jackpot", U.owner, { amount: 1000, reason: "a reason long enough", nonce: n1, password: "pw-right" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, "cross_site");
  const wrong = await call("/api/g/wheel/jackpot", U.owner, { amount: 1000, reason: "a reason long enough", nonce: n1, password: "nope" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "password");
  assert.equal(await house(), h0, "the House didn't move");
  for (const who of [U.admin, U.nolink]) {
    const r = await call("/api/g/wheel/jackpot", who, { amount: 1000, reason: "a reason long enough", nonce: await nonce(U.owner, "house"), password: "pw-right" });
    assert.equal(r.status, 403);
    assert.match(r.body.message, OWNER_RE);
  }
  const ok = await call("/api/g/wheel/jackpot", U.owner, { amount: 1000, reason: "a reason long enough", nonce: await nonce(U.owner, "house"), password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await house(), h0 + 1000);
  assert.ok((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'house_adjust' AND admin_id = ?", [U.owner]))[0], "audited");
});

test("5 wrong passwords in 15 minutes -> 429, even with the right one (shared with every step-up)", async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call("/api/admin/transfer/ann", U.owner2, { amount: 5, nonce: await nonce(U.owner2, "grant"), password: "wrong" + i });
    assert.equal(r.status, 403, "try " + i);
  }
  const t = await call("/api/admin/transfer/ann", U.owner2, { amount: 5, nonce: await nonce(U.owner2, "grant"), password: "pw-right" });
  assert.equal(t.status, 429, JSON.stringify(t.body));
  assert.equal(t.body.code, "too_many");
  const th = await call("/api/g/wheel/jackpot", U.owner2, { amount: 5, reason: "a reason long enough", nonce: await nonce(U.owner2, "house"), password: "pw-right" });
  assert.equal(th.status, 429, "the House adjust shares the counter");
  // the roles' owner change too
  const rn = (await call("/api/admin/roles/nonce", U.owner2)).body.nonce;
  const tr = await call("/api/admin/roles/role", U.owner2, { login: "someone_cf", role: "owner", nonce: rn, password: "pw-right" });
  assert.equal(tr.status, 429);
});

test("/admin/roles: making or removing an OWNER needs the step-up; other role changes don't; non-owners are refused by Pepe's rules, never asked", async () => {
  const roleOf = (l) => SR.roleOf(l);
  const rnonce = async (who) => (await call("/api/admin/roles/nonce", who)).body.nonce;
  // grant owner without the step-up: refused, nothing changed
  const none = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "owner" });
  assert.equal(none.status, 409, JSON.stringify(none.body));
  assert.equal(none.body.code, "nonce");
  assert.equal(await roleOf("new_cf"), null);
  const n1 = await rnonce(U.owner);
  const cross = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "owner", nonce: n1, password: "pw-right" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, "cross_site");
  const wrong = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "owner", nonce: n1, password: "nope" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "password");
  assert.equal(await roleOf("new_cf"), null);
  const ok = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "owner", nonce: await rnonce(U.owner), password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await roleOf("new_cf"), "owner");
  const a = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'pepe_role' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(JSON.parse(a.detail), { login: "new_cf", from: null, to: "owner", editor_role: "owner" });
  // removing an owner (to a lower role, or none): the step-up too
  const dem = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "admin" });
  assert.equal(dem.status, 409);
  assert.equal(dem.body.code, "nonce");
  assert.equal(await roleOf("new_cf"), "owner");
  const rem = await call("/api/admin/roles/role", U.owner, { login: "new_cf", role: "none", nonce: await rnonce(U.owner), password: "pw-right" });
  assert.equal(rem.status, 200, JSON.stringify(rem.body));
  assert.equal(await roleOf("new_cf"), null);
  // a change that doesn't touch the owner role needs no password
  const st = await call("/api/admin/roles/role", U.owner, { login: "helper_cf", role: "staff" });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  // a Pepe admin (not an owner): Pepe's !role rules refuse him (403) - he is never asked for a password, and can't get a nonce
  const adm = await call("/api/admin/roles/role", U.admin, { login: "new_cf", role: "owner" });
  assert.equal(adm.status, 403);
  assert.notEqual(adm.body.code, "nonce");
  assert.equal((await call("/api/admin/roles/nonce", U.admin)).status, 403);
  assert.equal(await roleOf("new_cf"), null);
  // the class picker can't take an owner's role away (that needs the password, on /admin/roles)
  await runQuery("INSERT INTO classes (classId, class) VALUES ('c1', 'Staff'), ('c2', 'Admin'), ('c3', 'Assistant')");
  await assert.rejects(SR.classUpdate({ userId: U.owner, username: "own", class: "Admin" }, "own3", "Staff"),
                       (e) => e.status === 409 && /Admin › Roles/.test(e.message));
  assert.equal(await roleOf("owner3_cf"), "owner");
});

test("review of the owner answers: parallel wrong passwords can't beat the throttle - each attempt is counted before the compare; at most 5 open nonces per account", async () => {
  // a stolen session firing guesses in parallel: the nonce check is bypassed here (every nonce valid) to look at the throttle alone
  const ES = require(path.join(repo, "econstore"));
  const ctl = require(path.join(repo, "pepecontrol"));
  const me = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", ["u_ann"]))[0];
  const oTake = ctl.takeNonce;
  ctl.takeNonce = () => true;
  let out;
  try {
    out = await Promise.all(Array.from({ length: 20 }, (x, i) => ES.stepUp(me, { nonce: "n" + i, password: "guess-" + i }).then(() => "ok", (e) => `${e.status}:${e.code}`)));
  } finally { ctl.takeNonce = oTake; }
  const counts = {};
  for (const c of out) counts[c] = (counts[c] || 0) + 1;
  assert.deepEqual(counts, { "403:password": 5, "429:too_many": 15 }, "only 5 guesses ever reach bcrypt: " + JSON.stringify(counts));
  // the right password now: still 429 until the window ends
  ctl.takeNonce = () => true;
  try { await assert.rejects(ES.stepUp(me, { nonce: "x", password: "pw-right" }), (e) => e.status === 429); } finally { ctl.takeNonce = oTake; }
  // the nonce cap: a 6th open nonce retires the account's oldest; another account's are untouched
  const who = { userId: U.owner3, username: NAME[U.owner3] };
  const other = ctl.issueNonce({ userId: U.owner2, username: NAME[U.owner2] });
  const ns = Array.from({ length: 7 }, () => ctl.issueNonce(who));
  assert.equal(ctl.takeNonce(who, ns[0]), false, "the oldest was retired");
  assert.equal(ctl.takeNonce(who, ns[1]), false);
  for (const n of ns.slice(2)) assert.equal(ctl.takeNonce(who, n), true, "the newest five are open");
  assert.equal(ctl.takeNonce({ userId: U.owner2, username: NAME[U.owner2] }, other), true, "per account");
});
