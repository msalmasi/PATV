// Owner answers 2026-10-20, (1) and (2): every switch / action that holds or moves members' PAT is a Pepe OWNER's (the Admin
// class AND the owner role on the linked chat login, read fresh - staffroles.ownerOf), like the economy writes:
//   * the auto-escrow switch (POST /api/admin/autoescrow/settings)
//   * the pad-vault admin move (POST /api/admin/padvault/nonce + /move; the website action carries site_admin = is_owner)
//   * donation promos (POST /api/admin/donpromo/create | settings | :id/edit | :id/end)
//   * found: the lotto_backend switch from the web (POST /api/lotto/admin/settings), adding / changing a redemption code
//     (POST /api/admin/redemption-codes), "pay anyway" for a welcome bonus (POST /api/admin/welcome/pay); approving a held
//     crypto payment is in test/crypto-donations.test.js
// and (2) 🔌 /admin/backends (backends.js): the hand-overs Pepe's panel used to flip, switched from the site - owner-only for
// the lotto and the stashes, Admins for GTF / polls / the cosmetic drop table / the AI judge; a same-origin fetch only; the
// wish is recorded for Pepe (POST /api/pepe/backends) and audited; the old per-feature routes record the same.
//   NODE_PATH=G:/PATV/node_modules node --test test/owner-pat-gates.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "owner-pat-gates-test-")));
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const CTL = require(path.join(repo, "pepecontrol"));

let base, server;
const U = { owner: "u_owner", admin: "u_admin", nolink: "u_nolink", staff: "u_staff", owner2: "u_owner2", mem: "u_mem" };
const NAME = { u_owner: "own", u_admin: "adm", u_nolink: "nol", u_staff: "stf", u_owner2: "own2", u_mem: "mem" };
const OWNER_RE = /owners only/;
const PAD = "DRAMA_CENTRAL";

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 1,
                  created_at TEXT, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER, email TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE redemption_codes (code TEXT PRIMARY KEY, points INTEGER, uses_allowed INTEGER, uses_remaining INTEGER, expiration_date TEXT,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const h = await bcrypt.hash("pw-right", 4);
  for (const [id, cls, cf] of [[U.owner, "Admin", "Owner_CF"], [U.admin, "Admin", "admin_cf"], [U.nolink, "Admin", null], [U.staff, "Staff", "staff_cf"],
                               [U.owner2, "Admin", "owner2_cf"], [U.mem, "pleb", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?, ?)", [id, NAME[id], NAME[id], h, cls, cf]);
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1), ('staff_cf', 'staff', 1), ('owner2_cf', 'owner', 1)");
  await CTL.init();
  await require(path.join(repo, "adminaudit")).init();
  const rooms = require(path.join(repo, "rooms"));
  await rooms.init();
  await rooms.addRoom(PAD, null, "test");
  await require(path.join(repo, "funding")).init();
  require(path.join(repo, "funding")).sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const deps = { isBotToken: (t) => t === "bot", addUser, noTimers: true };
  require(path.join(repo, "autoescrow")).register(app, deps);
  require(path.join(repo, "padfines")).register(app, deps);
  require(path.join(repo, "donationpromo")).register(app, deps);
  require(path.join(repo, "lotto", "routes")).register(app, deps);
  require(path.join(repo, "actions")).register(app, deps);
  require(path.join(repo, "stashes")).register(app, deps);
  require(path.join(repo, "gtfstore")).register(app, deps);
  require(path.join(repo, "polls")).register(app, deps);
  require(path.join(repo, "oracle")).register(app, deps);
  require(path.join(repo, "backends")).register(app, deps);
  // the handlers index.js mounts
  app.post("/api/admin/redemption-codes", addUser, (req, res) => require(path.join(repo, "staffgrant")).codesRoute(req, res));
  app.post("/api/admin/welcome/pay", addUser, (req, res) => require(path.join(repo, "welcome")).payRoute(req, res));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));      // the modules create their tables on register
});
test.after(() => { try { require(path.join(repo, "lotto", "service")).stop(); } catch (e) { /* */ } if (server) server.close(); });

async function call(p, who, body = {}, extra = {}) {
  const headers = Object.assign({ "content-type": "application/json", "x-test-user": who || "", "X-Requested-With": "fetch", origin: base,
                                  "x-csrf-token": CTL.csrfToken(NAME[who] || "") }, extra);
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  const r = await fetch(base + p, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const one = async (sql, args = []) => (await getQuery(sql, args))[0];

test("(1) the auto-escrow switch holds members' PAT: an Admin who isn't a Pepe owner gets 403, nothing changes; an owner saves it", async () => {
  const AE = require(path.join(repo, "autoescrow"));
  const before = await AE.enabled();
  for (const who of [U.admin, U.nolink]) {
    const r = await call("/api/admin/autoescrow/settings", who, { enabled: !before, note: "probe" });
    assert.equal(r.status, 403, `${NAME[who]}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, "owner_only");
    assert.match(r.body.error, OWNER_RE);
  }
  assert.equal(await AE.enabled(), before, "unchanged");
  assert.equal((await one("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'autoescrow.settings'")).n, 0);
  assert.equal((await call("/api/admin/autoescrow/settings", U.staff, { enabled: !before })).status, 403, "Staff: not even the class");
  const ok = await call("/api/admin/autoescrow/settings", U.owner, { enabled: !before, note: "owner turns it" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await AE.enabled(), !before);
  assert.equal((await one("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'autoescrow.settings' AND admin_id = ?", [U.owner])).n, 1);
  // reading stays Admins'
  assert.equal((await fetch(base + "/api/admin/autoescrow", { headers: { "x-test-user": U.admin } })).status, 200);
});

test("(1) the pad-vault admin move: owner-only before a nonce is issued, the throttled step-up, and the action Pepe claims says is_owner", async () => {
  const before = (await one("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'roomvault.admin'")).n;
  for (const who of [U.admin, U.nolink]) {
    const n = await call("/api/admin/padvault/nonce", who);
    assert.equal(n.status, 403, `nonce as ${NAME[who]}: ${JSON.stringify(n.body)}`);
    assert.match(n.body.error, OWNER_RE);
    const m = await call("/api/admin/padvault/move", who, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: "x", password: "pw-right" });
    assert.equal(m.status, 403);
    assert.match(m.body.error, OWNER_RE);
  }
  assert.equal((await one("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'roomvault.admin'")).n, before, "nothing queued");
  // the owner: a nonce, a wrong password (refused, nonce spent), then the real one
  const nonce = async (who = U.owner) => (await call("/api/admin/padvault/nonce", who)).body.nonce;
  const n1 = await nonce();
  assert.ok(n1);
  const bad = await call("/api/admin/padvault/move", U.owner, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: n1, password: "nope" });
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /Wrong password/);
  assert.equal((await call("/api/admin/padvault/move", U.owner, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: n1, password: "pw-right" })).status, 409, "single use");
  const ok = await call("/api/admin/padvault/move", U.owner, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: await nonce(), password: "pw-right" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // what Pepe claims: the owner's action says site_admin + is_owner; an Admin's (queued some other way) says neither
  const A = require(path.join(repo, "actions"));
  const idA = await A.queue(U.admin, { kind: "roomvault.admin", args: ["fine", PAD, "", "5", "k-admin-0001", "x"], tag: "padvault-admin", label: "admin" });
  const got = await fetch(base + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) }).then((r) => r.json());
  const by = Object.fromEntries(got.actions.map((x) => [x.id, x]));
  assert.equal(by[ok.body.id].kind, "roomvault.admin");
  assert.equal(by[ok.body.id].site_admin, true);
  assert.equal(by[ok.body.id].is_owner, true);
  assert.equal(by[idA].site_admin, false, "the Admin class no longer stands in for the owner check");
  assert.equal(by[idA].is_owner, false);
  // the step-up is the shared, throttled one: 5 wrong passwords in 15 minutes, then 429 even for the right one (own2)
  for (let i = 0; i < 5; i++) {
    const w = await call("/api/admin/padvault/move", U.owner2, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: await nonce(U.owner2), password: "wrong" + i });
    assert.equal(w.status, 403);
  }
  const t = await call("/api/admin/padvault/move", U.owner2, { op: "fine", from: PAD, amount: 5, reason: "probe fine", nonce: await nonce(U.owner2), password: "pw-right" });
  assert.equal(t.status, 429, JSON.stringify(t.body));
});

test("(1) donation promos: create / settings / edit / end are a Pepe owner's; reading and the per-member USD limit stay Admins'", async () => {
  const now = Date.now();
  const body = { mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 3 * 3600e3, label: "probe" };
  for (const who of [U.admin, U.nolink]) {
    for (const [p, b] of [["/api/admin/donpromo/create", body], ["/api/admin/donpromo/settings", {}], ["/api/admin/donpromo/x1/edit", { label: "x" }],
                          ["/api/admin/donpromo/x1/end", {}]]) {
      const r = await call(p, who, b);
      assert.equal(r.status, 403, `${p} as ${NAME[who]}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, OWNER_RE);
    }
  }
  assert.equal((await one("SELECT COUNT(*) AS n FROM donation_promos")).n, 0, "nothing created");
  const ok = await call("/api/admin/donpromo/create", U.owner, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call(`/api/admin/donpromo/${ok.body.promo.id}/end`, U.owner, {})).status, 200);
  assert.equal((await fetch(base + "/api/admin/donpromo", { headers: { "x-test-user": U.admin } })).status, 200, "an Admin still reads the card");
});

test("(1) the lotto_backend switch from the web is a Pepe owner's (the pot); price stays Admins'; the bot token is unchanged", async () => {
  const svc = require(path.join(repo, "lotto", "service"));
  await svc.ensure();
  for (const who of [U.admin, U.nolink]) {
    const r = await call("/api/lotto/admin/settings", who, { key: "lotto_backend", value: "1" });
    assert.equal(r.status, 403, `${NAME[who]}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, OWNER_RE);
  }
  assert.equal((await svc.loadSettings(true)).lotto_backend, false);
  assert.equal((await call("/api/lotto/admin/settings", U.admin, { key: "price", value: 1500 })).status, 200, "price: an Admin");
  const ok = await call("/api/lotto/admin/settings", U.owner, { key: "lotto_backend", value: "0" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bot = await fetch(base + "/api/lotto/admin/settings", { method: "POST", headers: { "content-type": "application/json" },
                                                               body: JSON.stringify({ password: "bot", key: "lotto_backend", value: "0" }) });
  assert.equal(bot.status, 200);
});

test("(1) a redemption code (PAT members redeem) is a Pepe owner's to add or change; 'pay anyway' for a welcome bonus too", async () => {
  for (const who of [U.admin, U.nolink]) {
    const r = await call("/api/admin/redemption-codes", who, { code: "FREEPAT", points: 1000000, uses_allowed: 5 });
    assert.equal(r.status, 403, `${NAME[who]}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, OWNER_RE);
    const w = await call("/api/admin/welcome/pay", who, { userId: U.mem });
    assert.equal(w.status, 403, `welcome as ${NAME[who]}: ${JSON.stringify(w.body)}`);
    assert.match(w.body.error, OWNER_RE);
  }
  assert.equal((await one("SELECT COUNT(*) AS n FROM redemption_codes")).n, 0, "no code written");
  const ok = await call("/api/admin/redemption-codes", U.owner, { code: "FREEPAT", points: 1000, uses_allowed: 5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await one("SELECT points FROM redemption_codes WHERE code = 'FREEPAT'")).points, 1000);
  // the owner passes the gate: welcome.payout answers (nothing pending for this member)
  const w = await call("/api/admin/welcome/pay", U.owner, { userId: U.mem });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.why, "not pending");
  // Staff / members: not even the class (the old answers)
  assert.equal((await call("/api/admin/redemption-codes", U.staff, { code: "X", points: 1, uses_allowed: 1 })).status, 302);
});

test("(2) /admin/backends: the lotto and stashes switches are a Pepe owner's; nothing moves on the site; the wish is recorded and audited", async () => {
  const svc = require(path.join(repo, "lotto", "service"));
  const ST = require(path.join(repo, "stashes"));
  for (const key of ["lotto", "stashes"]) {
    for (const who of [U.admin, U.nolink]) {
      const r = await call("/api/admin/backends/" + key, who, { on: true });
      assert.equal(r.status, 403, `${key} as ${NAME[who]}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "owner_only");
      assert.match(r.body.error, OWNER_RE);
    }
    assert.equal((await call("/api/admin/backends/" + key, U.staff, { on: true })).body.code, "admin_only");
  }
  assert.equal((await one("SELECT COUNT(*) AS n FROM backend_wants")).n, 0, "no wish recorded");
  assert.equal((await one("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'backend_switch'")).n, 0);
  assert.equal(await ST.enabled(), false);
  // the owner: the lotto's wish only (Pepe's cutover moves the pot - lotto_backend is untouched)
  const lo = await call("/api/admin/backends/lotto", U.owner, { on: true });
  assert.equal(lo.status, 200, JSON.stringify(lo.body));
  assert.deepEqual([lo.body.want, lo.body.live, lo.body.pepe], [true, false, true]);
  assert.equal((await svc.loadSettings(true)).lotto_backend, false, "nothing moved on the site");
  const st = await call("/api/admin/backends/stashes", U.owner, { on: true });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(await ST.enabled(), true, "the site takes the stashes' hand-over now (stash_meta.enabled)");
  const a = await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id");
  assert.deepEqual(a.map((r) => [r.admin_id, JSON.parse(r.detail).feature, JSON.parse(r.detail).want, JSON.parse(r.detail).was]),
                   [[U.owner, "lotto", true, null], [U.owner, "stashes", true, null]]);
  // once the site owns the stashes there is nothing to switch (the import is for good)
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('imported', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ at: 1 })]);
  assert.equal(await ST.live(), true);
  const no = await call("/api/admin/backends/stashes", U.owner, { on: false });
  assert.equal(no.status, 409, JSON.stringify(no.body));
  assert.equal(no.body.code, "E_LIVE");
  assert.equal(await ST.enabled(), true);
  assert.equal((await one("SELECT want FROM backend_wants WHERE feature = 'stashes'")).want, 1, "the refused switch recorded nothing");
  await runQuery("DELETE FROM stash_meta WHERE key = 'imported'");
  // Pepe reads the wishes (bot token)
  assert.equal((await fetch(base + "/api/pepe/backends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "no" }) })).status, 403);
  const b = await fetch(base + "/api/pepe/backends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) }).then((r) => r.json());
  assert.equal(b.ok, true);
  assert.deepEqual(Object.keys(b.features).sort(), ["aijudge", "cosdrops", "gtf", "lotto", "polls", "stashes"]);
  assert.equal(b.features.lotto.want, true);
  assert.equal(b.features.lotto.live, false);
  assert.equal(b.features.lotto.by, "own");
  assert.equal(b.features.gtf.want, null, "never switched here");
});

test("(2) /admin/backends: GTF / polls / the drop table / the AI judge stay Admins'; same-origin fetch only; the old routes record too", async () => {
  const G = require(path.join(repo, "gtfstore"));
  const P = require(path.join(repo, "polls"));
  const O = require(path.join(repo, "oracle"));
  const C = require(path.join(repo, "cosmetics"));
  // cross-site / no fetch header / no Origin at all: refused before anything else
  for (const [why, extra] of [["foreign origin", { origin: "https://evil.example" }], ["no fetch header", { "X-Requested-With": null }],
                              ["no origin", { origin: null }]]) {
    const r = await call("/api/admin/backends/gtf", U.admin, { on: true }, extra);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.code, "cross_site", why);
  }
  assert.equal(await G.enabled(), false, "nothing switched");
  assert.equal((await call("/api/admin/backends/gtf", U.admin, { on: "yes" })).status, 400, "on must be true / false");
  assert.equal((await call("/api/admin/backends/nope", U.admin, { on: true })).status, 404);
  for (const [key, read] of [["gtf", () => G.enabled()], ["polls", () => P.backendEnabled()], ["cosdrops", () => C.dropEnabled()], ["aijudge", () => O.enabled()]]) {
    const r = await call("/api/admin/backends/" + key, U.admin, { on: true });
    assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    assert.equal(await read(), true, key + " site switch on");
    const off = await call("/api/admin/backends/" + key, U.admin, { on: false });
    assert.equal(off.status, 200);
    assert.equal(await read(), false, key + " off again");
  }
  // the drop table: while the site owns it only Pepe releases it - off records the wish, the site switch is untouched
  await C.setDropMeta("enabled", true);
  await C.setDropMeta("live", true);
  const cd = await call("/api/admin/backends/cosdrops", U.admin, { on: false });
  assert.equal(cd.status, 200, JSON.stringify(cd.body));
  assert.deepEqual([cd.body.want, cd.body.live, cd.body.pepe], [false, true, true]);
  assert.equal(await C.dropEnabled(), true);
  await C.setDropMeta("live", false);
  const rows = await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'backend_switch' AND admin_id = ? ORDER BY id", [U.admin]);
  assert.equal(rows.length, 9);
  assert.deepEqual(JSON.parse(rows[1].detail), { feature: "gtf", want: false, was: true, live: false, via: "web" });
  // the old per-feature route (unchanged rules: Admins) writes the same wish + audit row
  const legacy = await call("/api/admin/gtf-backend", U.admin, { on: true });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  const w = await one("SELECT want, by, via FROM backend_wants WHERE feature = 'gtf'");
  assert.deepEqual([w.want, w.by, w.via], [1, "adm", "web-legacy"]);
  const last = await one("SELECT detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(last.detail).via, "web-legacy");
});

test("(2) the /admin/backends page and its JSON: Admins see every row (owner rows locked for a non-owner); others are sent away", async () => {
  const j = await fetch(base + "/api/admin/backends", { headers: { "x-test-user": U.admin } }).then((r) => r.json());
  assert.equal(j.ok, true);
  assert.deepEqual(j.rows.map((r) => [r.key, r.owner, r.can]), [["lotto", true, false], ["stashes", true, false], ["gtf", false, true],
                                                                  ["polls", false, true], ["cosdrops", false, true], ["aijudge", false, true]]);
  assert.deepEqual(j.status.map((r) => r.key), ["pools", "capital", "escrow", "gangs", "achievements"]);
  const jo = await fetch(base + "/api/admin/backends", { headers: { "x-test-user": U.owner } }).then((r) => r.json());
  assert.ok(jo.owner && jo.rows.every((r) => r.can), "an owner can switch every row");
  assert.equal((await fetch(base + "/api/admin/backends", { headers: { "x-test-user": U.staff } })).status, 403);
  const page = await fetch(base + "/admin/backends", { headers: { "x-test-user": U.admin }, redirect: "manual" });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-backend="lotto"/);
  assert.match(html, /data-bk="gtf"/, "an Admin gets the GTF buttons");
  assert.doesNotMatch(html, /data-bk="lotto"/, "...but not the lotto's");
  assert.match(html, /href="\/admin\/backends"/, "in the admin nav");
  assert.match(html, /data-status="pools"/);
  const html2 = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": U.owner } })).text();
  assert.match(html2, /data-bk="lotto"/);
  const st = await fetch(base + "/admin/backends", { headers: { "x-test-user": U.staff }, redirect: "manual" });
  assert.equal(st.status, 302);
  assert.equal((await fetch(base + "/admin/backends", { redirect: "manual" })).status, 302);
});
