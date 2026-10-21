// PO-0b (economy policy -> site plan, D-6 "economy writes are owner-only"): an Admin who isn't a Pepe owner gets 403 on every
// economy write - the !econ edit (econ.cmd / econ.routes), the policy engines' mode, a burn, the backend switches (pools,
// capital, stashes, escrow, gangs), the PAT grant and the House adjust - while a Pepe owner (Admin class + the owner role on
// the linked chat login) passes the gate. Reading stays Admins'. The VPS CLIs (tools/*-backend.js) still work (the emergency
// path), and tools/policy-backend.js is read-only. Website actions of kind econ.* carry the site-computed is_owner (never
// the Admin class) to Pepe.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-owner-gates.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-gates-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const CTL = require(path.join(repo, "pepecontrol"));

let base, server;
const U = { owner: "u_owner", admin: "u_admin", nolink: "u_nolink", staff: "u_staff" };
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const h = await bcrypt.hash("pw-right", 4);
  for (const [id, name, cls, cf] of [[U.owner, "own", "Admin", "Owner_CF"], [U.admin, "adm", "Admin", "admin_cf"], [U.nolink, "nol", "Admin", null],
                                     [U.staff, "stf", "Staff", "staff_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?)", [id, name, h, cls, cf]);
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1), ('staff_cf', 'staff', 1)");
  await CTL.init();
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  require(path.join(repo, "econstore")).register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  require(path.join(repo, "burns")).register(app, deps);
  require(path.join(repo, "pools")).register(app, deps);
  require(path.join(repo, "stashes")).register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  require(path.join(repo, "escrow", "ledger")).register(app, deps);
  require(path.join(repo, "gangs")).register(app, deps);
  require(path.join(repo, "actions")).register(app, deps);
  // the PAT grant and the House adjust: the handlers index.js mounts (staffgrant.grantRoute / houseAdjustRoute)
  const SG = require(path.join(repo, "staffgrant"));
  app.post("/api/g/wheel/jackpot", addUser, (req, res) => SG.houseAdjustRoute(req, res));
  app.post("/api/admin/transfer/:username", addUser, (req, res) => SG.grantRoute(req, res));
  // owner answers 2026-10-20 (3): their step-up nonce (index.js mounts the same handler)
  app.post("/api/admin/stepup/nonce", addUser, (req, res) => require(path.join(repo, "stepup")).nonceRoute(req, res));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 200));      // the modules create their tables on register
});
test.after(() => server && server.close());

const name = { [U.owner]: "own", [U.admin]: "adm", [U.nolink]: "nol", [U.staff]: "stf" };
async function call(p, who, body = {}) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-test-user": who, "X-Requested-With": "fetch",
                                                               "x-csrf-token": CTL.csrfToken(name[who]), origin: base, host: new URL(base).host },
                                    body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const OWNER_RE = /owners only/;

test("ownerOf: the class AND Pepe's owner role on the linked login, read fresh; anything else is null", async () => {
  assert.equal((await SR.ownerOf({ userId: U.owner }, "econ.pepe_econ_cmds")).userId, U.owner, "an owner (login case doesn't matter)");
  assert.equal(await SR.ownerOf({ userId: U.admin }, "econ.pepe_econ_cmds"), null, "a Pepe admin with the Admin class");
  assert.equal(await SR.ownerOf({ userId: U.nolink }, "econ.pepe_econ_cmds"), null, "an Admin with no linked login");
  assert.equal(await SR.ownerOf({ userId: U.staff }, "econ.pepe_econ_cmds"), null, "Staff");
  assert.equal(await SR.ownerOf(null, "econ.pepe_econ_cmds"), null);
  // read fresh: a stale session claiming Admin doesn't help, a lost role is lost at once
  await runQuery("UPDATE pepe_roles SET role = 'admin' WHERE login = 'owner_cf'");
  assert.equal(await SR.ownerOf({ userId: U.owner, class: "Admin" }, "econ.pepe_econ_cmds"), null);
  await runQuery("UPDATE pepe_roles SET role = 'owner' WHERE login = 'owner_cf'");
});

test("an Admin who isn't a Pepe owner gets 403 on every economy write; a Pepe owner passes the gate", async () => {
  const routes = [
    // [path, body, what the OWNER gets next (the gate passed): a status]
    ["/api/admin/econ/edit", { op: "cmd", text: "set fed_floor 50m" }, 409],             // econstore.requestEdit -> the step-up (no nonce)
    ["/api/admin/policy/mode", { engine: "treasury", mode: "dry", note: "test" }, 200],
    ["/api/admin/policy/pause", { engine: "treasury", pause: true, note: "test" }, 409],     // PO-1: -> the step-up (no nonce)
    ["/api/admin/burn", { amount: 5 }, 409],                                              // burns.request -> the nonce
    ["/api/admin/pools-backend", { on: true }, 200],
    ["/api/admin/capital-backend", { on: true }, 200],
    ["/api/admin/stash-backend", { on: true }, 200],
    ["/api/admin/escrow-backend", { on: true }, 200],
    ["/api/admin/gangs-backend", { on: true }, 200],
  ];
  for (const [p, body, next] of routes) {
    for (const who of [U.admin, U.nolink]) {
      const r = await call(p, who, body);
      assert.equal(r.status, 403, `${p} as ${name[who]}: ${JSON.stringify(r.body)}`);
      assert.match(JSON.stringify(r.body), OWNER_RE, `${p}: says it is an owner's`);
    }
    const o = await call(p, U.owner, body);
    assert.equal(o.status, next, `${p} as the owner: ${JSON.stringify(o.body)}`);
  }
  // nothing changed for the refused Admin: the policy mode was set by the owner only
  const audit = await getQuery("SELECT by FROM policy_audit");
  assert.deepEqual(audit.map((r) => r.by), ["own"]);
});

test("the econ edit / burn step-ups still work for an owner; reading stays Admins'", async () => {
  const n = (await call("/api/admin/econ/edit/nonce", U.owner)).body.nonce;
  assert.ok(n, "an owner gets a nonce");
  const ok = await call("/api/admin/econ/edit", U.owner, { op: "cmd", text: "set fed_floor 50m", nonce: n, password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const a = (await getQuery("SELECT kind, args FROM pepe_actions WHERE id = ?", [ok.body.request.id]))[0];
  assert.equal(a.kind, "econ.cmd");
  // an Admin may still read the cards
  const r = await fetch(base + "/api/admin/econ/store", { headers: { "x-test-user": U.admin } });
  assert.equal(r.status, 200);
  const pol = await fetch(base + "/api/admin/policy", { headers: { "x-test-user": U.admin } });
  assert.equal(pol.status, 200);
});

test("PO-1: pausing an engine on /admin/economy is a Pepe owner's with the password step-up; audited, and resumable", async () => {
  const C = require(path.join(repo, "policy", "core"));
  const nonce = async () => (await call("/api/admin/econ/edit/nonce", U.owner)).body.nonce;
  // PO-1 review (plan §8: step-up + CSRF + same-site fetch): a request without the fetch header, from another site, or with a
  // missing / forged / someone else's CSRF token is refused before anything else - nothing paused, the nonce not spent
  const raw = (headers, body) => fetch(base + "/api/admin/policy/pause", { method: "POST", headers: Object.assign({ "content-type": "application/json", "x-test-user": U.owner }, headers),
                                                                        body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const good = { "X-Requested-With": "fetch", "x-csrf-token": CTL.csrfToken("own"), origin: base, host: new URL(base).host };
  const n0 = await nonce();
  const body = { engine: "treasury", pause: true, note: "a forged pause", nonce: n0, password: "pw-right" };
  for (const [why, h] of [["no X-Requested-With", Object.assign({}, good, { "X-Requested-With": "" })],
                          ["cross-site origin", Object.assign({}, good, { origin: "https://evil.example" })],
                          ["no CSRF token", Object.assign({}, good, { "x-csrf-token": "" })],
                          ["a forged token", Object.assign({}, good, { "x-csrf-token": "lzz.forged" })],
                          ["another user's token", Object.assign({}, good, { "x-csrf-token": CTL.csrfToken("adm") })]]) {
    const r = await raw(h, body);
    assert.equal(r.status, 403, `${why}: ${JSON.stringify(r.body)}`);
    assert.equal((await C.engines()).treasury.paused, 0, why);
  }
  const used = await raw(good, Object.assign({}, body, { note: "the real one" }));
  assert.equal(used.status, 200, "the refused requests didn't spend the nonce: " + JSON.stringify(used.body));
  assert.equal((await C.engines()).treasury.paused, 1);
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "treasury", pause: false, nonce: await nonce(), password: "pw-right" })).status, 200);
  // the note is required for a pause; engine and pause must be named
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "treasury", pause: true, note: "", nonce: await nonce(), password: "pw-right" })).status, 400);
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "nope", pause: true, note: "why not", nonce: await nonce(), password: "pw-right" })).status, 400);
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "treasury", pause: "yes", note: "why not", nonce: await nonce(), password: "pw-right" })).status, 400);
  // a wrong password: refused, nothing paused
  const wrong = await call("/api/admin/policy/pause", U.owner, { engine: "treasury", pause: true, note: "a test pause", nonce: await nonce(), password: "pw-wrong" });
  assert.equal(wrong.status, 403);
  assert.equal((await C.engines()).treasury.paused, 0);
  // an Admin who isn't an owner: refused before the step-up even with a nonce of his own
  const an = (await call("/api/admin/econ/edit/nonce", U.admin)).body.nonce;
  assert.equal((await call("/api/admin/policy/pause", U.admin, { engine: "treasury", pause: true, note: "a test pause", nonce: an, password: "pw-right" })).status, 403);
  // the owner with the right password: paused, audited (policy_audit + admin_audit "policy.pause")
  const ok = await call("/api/admin/policy/pause", U.owner, { engine: "all", pause: true, note: "a test pause", nonce: await nonce(), password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.engines.map((x) => [x.engine, x.paused]), [["treasury", true], ["monetary", true], ["burn", true]]);
  const e = await C.engines();
  assert.deepEqual([e.treasury.paused, e.treasury.paused_by, e.treasury.pause_note, e.treasury.mode], [1, "own", "a test pause", "dry"], "the mode is unchanged");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'policy.pause' AND admin_id = ? AND reason = 'a test pause'", [U.owner]))[0].n, 3);
  assert.ok((await getQuery("SELECT 1 FROM policy_audit WHERE engine = 'burn' AND old = 'running' AND new = 'paused' AND by = 'own'"))[0]);
  // the nonce is single-use
  const n1 = await nonce();
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "burn", pause: false, nonce: n1, password: "pw-right" })).status, 200);
  assert.equal((await call("/api/admin/policy/pause", U.owner, { engine: "burn", pause: false, nonce: n1, password: "pw-right" })).status, 409);
  // resume (no note needed)
  const back = await call("/api/admin/policy/pause", U.owner, { engine: "all", pause: false, nonce: await nonce(), password: "pw-right" });
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.engines.map((x) => [x.engine, x.paused, !!x.unchanged]), [["treasury", false, false], ["monetary", false, false], ["burn", false, true]]);
  assert.equal((await C.engines()).treasury.paused, 0);
  // the card's view shows it (an Admin can read)
  const v = await fetch(base + "/api/admin/policy", { headers: { "x-test-user": U.admin } }).then((r) => r.json());
  assert.equal(v.engines.find((x) => x.engine === "treasury").paused, false);
  assert.ok(Array.isArray(v.missed) && Array.isArray(v.whitelist));
});

test("econ.* website actions reach Pepe with the site-computed is_owner (never the Admin class) + the linked login", async () => {
  const A = require(path.join(repo, "actions"));
  const idO = await A.queue(U.owner, { kind: "econ.cmd", args: ["get"], tag: "econ-admin", label: "owner" });
  const idA = await A.queue(U.admin, { kind: "econ.cmd", args: ["get"], tag: "econ-admin", label: "admin" });
  const idB = await A.queue(U.admin, { kind: "econ.burn", args: ["5", "x", "k0000000001"], tag: "econ-burn", label: "burn" });
  const idC = await A.queue(U.admin, { kind: "cmd", args: ["wager", "x"], tag: "x", label: "not econ" });
  // the site's escrow.override says "admin" for both Admins (that's what the row stores, as before)
  assert.equal((await getQuery("SELECT site_admin FROM pepe_actions WHERE id = ?", [idA]))[0].site_admin, 1);
  const got = await fetch(base + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) })
    .then((r) => r.json());
  const by = Object.fromEntries(got.actions.map((x) => [x.id, x]));
  assert.equal(by[idO].is_owner, true);
  assert.equal(by[idO].site_admin, true, "an owner's econ action still runs on a Pepe before PO-0c");
  assert.equal(by[idO].login, "owner_cf");
  assert.equal(by[idA].is_owner, false);
  assert.equal(by[idA].site_admin, false, "the Admin class no longer stands in for Pepe's owner check");
  assert.equal(by[idA].login, "admin_cf");
  assert.equal(by[idB].site_admin, false, "a burn too");
  assert.equal(by[idC].site_admin, true, "other kinds keep site_admin (escrow.override) as before");
  assert.equal(by[idC].is_owner, false);
  // an owner whose link changed since the action was queued: not the login Pepe would act as -> not an owner's action
  const idD = await A.queue(U.owner, { kind: "econ.cmd", args: ["status"], tag: "econ-admin", label: "relinked" });
  await runQuery("UPDATE users SET camfrogUsername = 'someone_else' WHERE userId = ?", [U.owner]);
  try {
    const g2 = await fetch(base + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) })
      .then((r) => r.json());
    const d = g2.actions.find((x) => x.id === idD);
    assert.equal(d.is_owner, false);
    assert.equal(d.site_admin, false);
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = 'Owner_CF' WHERE userId = ?", [U.owner]);
  }
  // the review of PO-0b: relinked from one OWNER login to ANOTHER owner login - still an owner's account, but not the login the
  // action was queued as (Pepe would act as owner_cf): not an owner's action
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner2_cf', 'owner', 1)");
  const idE = await A.queue(U.owner, { kind: "econ.cmd", args: ["status"], tag: "econ-admin", label: "relinked to another owner" });
  await runQuery("UPDATE users SET camfrogUsername = 'owner2_cf' WHERE userId = ?", [U.owner]);
  try {
    assert.equal((await SR.ownerOf({ userId: U.owner }, "econ.pepe_econ_cmds")).userId, U.owner, "the account is still an owner (by its new login)");
    const g3 = await fetch(base + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) })
      .then((r) => r.json());
    const e = g3.actions.find((x) => x.id === idE);
    assert.ok(e, "claimed");
    assert.equal(String(e.camfrog).toLowerCase(), "owner_cf", "queued as owner_cf");
    assert.equal(e.is_owner, false, "the login it was queued as isn't the account's login any more");
    assert.equal(e.site_admin, false);
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = 'Owner_CF' WHERE userId = ?", [U.owner]);
    await runQuery("DELETE FROM pepe_roles WHERE login = 'owner2_cf'");
  }
});

test("the PAT grant and the House adjust: an Admin who isn't a Pepe owner gets 403 before anything moves; an owner passes", async () => {
  // the routes index.js mounts (staffgrant.grantRoute / houseAdjustRoute), called over HTTP
  const rakes = async () => (await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes"))[0].n;
  const txs = async () => (await getQuery("SELECT COUNT(*) AS n FROM transactions"))[0].n;
  const r0 = await rakes(), t0 = await txs();
  for (const who of [U.admin, U.nolink]) {
    const h = await call("/api/g/wheel/jackpot", who, { amount: 500, reason: "a reason long enough" });
    assert.equal(h.status, 403, `house adjust as ${name[who]}: ${JSON.stringify(h.body)}`);
    assert.match(h.body.message, OWNER_RE);
    const g = await call("/api/admin/transfer/stf", who, { amount: 500 });
    assert.equal(g.status, 403, `PAT grant as ${name[who]}: ${JSON.stringify(g.body)}`);
    assert.match(g.body.message, OWNER_RE);
  }
  // Staff: not even the class (as before)
  assert.equal((await call("/api/g/wheel/jackpot", U.staff, { amount: 500, reason: "a reason long enough" })).body.message, "Admins only.");
  assert.equal(await rakes(), r0, "the House didn't move");
  assert.equal(await txs(), t0, "nobody was paid");
  // the owner passes the gate: the next answer is the password step-up (owner answers 2026-10-20), then staffgrant's own input
  // check (nothing moves on a bad amount)
  const nonce = async (purpose) => (await call("/api/admin/stepup/nonce", U.owner, { for: purpose })).body.nonce;
  assert.equal((await call("/api/g/wheel/jackpot", U.owner, { amount: "abc", reason: "a reason long enough" })).status, 409, "no nonce: the step-up");
  const ho = await call("/api/g/wheel/jackpot", U.owner, { amount: "abc", reason: "a reason long enough", nonce: await nonce("house"), password: "pw-right" });
  assert.equal(ho.status, 400, JSON.stringify(ho.body));
  assert.match(ho.body.message, /whole number/);
  const go = await call("/api/admin/transfer/stf", U.owner, { amount: "abc", nonce: await nonce("grant"), password: "pw-right" });
  assert.equal(go.status, 400, JSON.stringify(go.body));
  assert.match(go.body.message, /whole number/);
  // ...and a real one goes through to the move (an unknown account: 404 from staffgrant, not the gate)
  assert.equal((await call("/api/admin/transfer/nobody_here", U.owner, { amount: 5, nonce: await nonce("grant"), password: "pw-right" })).status, 404);
});

test("the VPS CLIs stay the emergency path (no role needed); tools/policy-backend.js is read-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-gates-cli-"));
  const env = Object.assign({}, process.env, { NODE_PATH: process.env.NODE_PATH || path.join(repo, "node_modules") });
  delete env.STAGING;
  const run = (args) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 60000 });
  const esc = run([path.join(repo, "tools", "escrow-backend.js"), "--actor=test", "on"]);
  assert.equal(esc.status, 0, esc.stderr);
  assert.match(esc.stdout, /escrow backend ledger enabled by test/);
  const fed = run([path.join(repo, "tools", "fed-backend.js"), "--actor=test", "on"]);
  assert.equal(fed.status, 0, fed.stderr);
  assert.match(fed.stdout, /fed events backend enabled by test/);
  const pol = run([path.join(repo, "tools", "policy-backend.js"), "status"]);
  assert.equal(pol.status, 0, pol.stderr);
  assert.match(pol.stdout, /engine {3}treasury/);
  const pre = run([path.join(repo, "tools", "policy-backend.js"), "preflight"]);
  assert.equal(pre.status, 1, "an empty site isn't ready: FAIL lines and exit 1");
  assert.match(pre.stdout, /FAIL {2}Pepe's policy push: never received/);
  assert.match(pre.stdout, /PASS {2}no policy run in 'moving'/);
  // read-only: it created no table of its own (the escrow / fed CLIs made theirs above)
  const tables = spawnSync(process.execPath, ["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.all("SELECT name FROM sqlite_master WHERE type='table'",(e,r)=>{console.log(JSON.stringify(r.map(x=>x.name)));d.close();});`],
                           { cwd: dir, env, encoding: "utf8" });
  const names = JSON.parse(tables.stdout.trim());
  assert.ok(!names.includes("policy_engines") && !names.includes("pepe_roles_pending"), "the policy CLI created nothing: " + names.join(","));
  assert.match(pol.stdout, /stashes {2}0 closed stash\(es\) with no account to pay/);
  // PO-1 review: the kill switch never reports PAUSED while writing nowhere. From the WRONG directory (no myapp.db) every
  // command stops with exit 2 and creates no database there; --dir points it at the site's folder
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "owner-gates-nodb-"));
  const inEmpty = (args) => spawnSync(process.execPath, args, { cwd: empty, env, encoding: "utf8", timeout: 60000 });
  for (const args of [["--actor=ops", "pause", "all", "--note", "probe wrong cwd"], ["--actor=ops", "resume", "all"], ["status"], ["preflight"]]) {
    const r = inEmpty([path.join(repo, "tools", "policy-backend.js"), ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /no myapp\.db in .* - run it in the site directory/);
    assert.doesNotMatch(r.stdout, /PAUSED/);
  }
  assert.deepEqual(fs.readdirSync(empty), [], "no database was created there");
  const viaDir = inEmpty([path.join(repo, "tools", "policy-backend.js"), `--dir=${dir}`, "status"]);
  assert.equal(viaDir.status, 0, viaDir.stderr);
  assert.match(viaDir.stdout, /engine {3}treasury/);
  // ...and a database that isn't the site's (no users / policy_engines table): pause / resume refuse it, nothing written
  const notSite = run([path.join(repo, "tools", "policy-backend.js"), "--actor=ops", "pause", "treasury", "--note", "not the site db"]);
  assert.equal(notSite.status, 2, notSite.stdout + notSite.stderr);
  assert.match(notSite.stderr, /has no users \/ policy_engines table - is this the site's database\? Nothing was paused or resumed/);
  const names2 = JSON.parse(spawnSync(process.execPath, ["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.all("SELECT name FROM sqlite_master WHERE type='table'",(e,r)=>{console.log(JSON.stringify(r.map(x=>x.name)));d.close();});`],
                                      { cwd: dir, env, encoding: "utf8" }).stdout.trim());
  assert.ok(!names2.includes("policy_engines"), "nothing created: " + names2.join(","));
  // the site's database: its users (an Admin the alert goes to) and the policy tables (the site creates them at start)
  const mk = spawnSync(process.execPath, ["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.run("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, class TEXT, camfrogUsername TEXT)",()=>{d.run("INSERT INTO users VALUES ('ua','boss','Admin','boss_cf')",()=>d.close());});`],
                       { cwd: dir, env, encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const init = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(repo, "policy", "core"))}).init().then(()=>process.exit(0),(e)=>{console.error(e.message);process.exit(1);})`],
                         { cwd: dir, env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  // PO-1 (T3): the shell's pause / resume - who and why required; one transaction (flag + policy_audit + admin_audit)
  const noWho = run([path.join(repo, "tools", "policy-backend.js"), "pause", "treasury", "--note", "shell test"]);
  assert.equal(noWho.status, 1);
  assert.match(noWho.stderr, /--actor=/);
  const noWhy = run([path.join(repo, "tools", "policy-backend.js"), "--actor=ops", "pause", "treasury"]);
  assert.equal(noWhy.status, 1);
  assert.match(noWhy.stderr, /say why/);
  const badEng = run([path.join(repo, "tools", "policy-backend.js"), "--actor=ops", "pause", "everything", "--note", "x y z"]);
  assert.equal(badEng.status, 1);
  const pz = run([path.join(repo, "tools", "policy-backend.js"), "--actor=ops", "pause", "treasury", "--note", "site misbehaving at 04:00"]);
  assert.equal(pz.status, 0, pz.stderr);
  assert.match(pz.stdout, /treasury: PAUSED by ops/);
  assert.match(pz.stdout, /engine {3}treasury +off +.*PAUSED by ops \(cli\).*\(site misbehaving at 04:00\)/);
  const pre2 = run([path.join(repo, "tools", "policy-backend.js"), "preflight"]);
  assert.match(pre2.stdout, /FAIL {2}no policy engine paused: treasury by ops \(cli\)/);
  const rz = run([path.join(repo, "tools", "policy-backend.js"), "--actor=ops", "resume", "all"]);
  assert.equal(rz.status, 0, rz.stderr);
  assert.match(rz.stdout, /treasury: resumed by ops/);
  assert.match(rz.stdout, /monetary: already running - nothing changed/);
  const q = (sqlText) => JSON.parse(spawnSync(process.execPath, ["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.all(${JSON.stringify(sqlText)},(e,r)=>{console.log(JSON.stringify(e?String(e):r));d.close();});`],
                                              { cwd: dir, env, encoding: "utf8" }).stdout.trim());
  assert.deepEqual(q("SELECT by, via, old, new, note FROM policy_audit ORDER BY id"), [
    { by: "ops (cli)", via: "cli", old: "running", new: "paused", note: "site misbehaving at 04:00" },
    { by: "ops (cli)", via: "cli", old: "paused", new: "running", note: null }]);
  assert.deepEqual(q("SELECT admin_id, action FROM admin_audit ORDER BY id"), [{ admin_id: "cli:ops", action: "policy.pause" }, { admin_id: "cli:ops", action: "policy.resume" }]);
  // the review of PO-0b: the pools / stashes / capital / gangs switches have a shell path too (tools/money-backend.js)
  const st0 = run([path.join(repo, "tools", "money-backend.js")]);
  assert.equal(st0.status, 0, st0.stderr);
  assert.match(st0.stdout, /gangs {4}enabled=default \(off\) live=false/);
  for (const f of ["pools", "stashes", "capital", "gangs"]) {
    const on = run([path.join(repo, "tools", "money-backend.js"), "--actor=test", f, "on"]);
    assert.equal(on.status, 0, f + ": " + on.stderr);
    assert.match(on.stdout, new RegExp(`${f} backend enabled by test`));
    assert.match(on.stdout, new RegExp(`${f.padEnd(8)} enabled=true live=false {2}last switched by test \\(cli\\)`));
  }
  const off = run([path.join(repo, "tools", "money-backend.js"), "--actor=test", "gangs", "off"]);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /gangs {4}enabled=false/);
  const anon = run([path.join(repo, "tools", "money-backend.js"), "gangs", "on"]);
  assert.equal(anon.status, 1, "say who");
  assert.match(anon.stderr, /--actor=/);
  // once the site owns it, the shell refuses it like the web (the way back is the rollback from Pepe)
  const sql = (q) => spawnSync(process.execPath, ["-e", `const s=require("sqlite3");const d=new s.Database("myapp.db");d.run(${JSON.stringify(q)},(e)=>{if(e)console.error(e.message);d.close();});`],
                               { cwd: dir, env, encoding: "utf8" });
  sql("INSERT INTO gangs_meta (key, value) VALUES ('live', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const live = run([path.join(repo, "tools", "money-backend.js"), "--actor=test", "gangs", "off"]);
  assert.equal(live.status, 1);
  assert.match(live.stderr, /the site owns gangs now - roll back from Pepe/);
});
