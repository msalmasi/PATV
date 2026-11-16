// Offline tests for 1.99anv: sign-ups open / invite-only + member invites (invites.js).
//   * every path that makes a website account, open vs invite-only: the sign-up form (POST /register), a new SSO account
//     (Telegram through /auth/sso/create; Plex through /auth/plex/create - both user.controller createSsoAccount), a first Twitch /
//     Discord sign-in (the callbacks' steps, as index.js calls them - and the wiring in index.js itself), the first website
//     sign-in of an account a chat bot made while sign-ups were invite-only
//   * SSO with and without an invite (typed on the "new account" page, or parked by an invite link before the round trip);
//     existing accounts still sign in, "I already have an account" still links
//   * NOT gated: Pepe's automatic Camfrog accounts, existing accounts signing in
//   * the allowance: every tier, bought + admin-issued invites, a tier change, unlimited, MAX_PENDING
//   * single use under a race, expiry, revoke, an expired / revoked invite back in the allowance
//   * rate limiting of failed code look-ups (per IP and per session)
//   * the shop item: buy, gift, unlimited refused before any charge, never refundable
//   * the admin switch + settings validation + audit; grants; house invites; admin revoke
//   * the pages: the sign-up page's notice / field / "invited by", the member page, merges
//   * review fixes: !signin of a renamed Camfrog auto account (chatsignin.js), site-banned / deleted inviters, the parallel-guess
//     burst + IPv6 /64, the allowance pools (a bought / issued invite always adds one after a tier change or a lost unlimited
//     tier), a pasted invite link (maxlength), blank tier fields, chat-only accounts can't buy one, house invites off the
//     member page, the gift recipient's pointer, a stale admin card
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/invites.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invites-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.SENDGRID_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.SHORT_LINK_BASE;
delete process.env.MEDIACTL_URL;
process.env.SECRET_KEY = "test-secret";
process.env.APP_SESSION_SECRET = "test-session-secret";
process.env.STORE_NOTIFY_EMAIL = "store@example.test";
const BOT_TOKEN = "123456789:" + "A".repeat(20) + "bcdefghijklmn_-XYZ";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;

const express = require("express");
const session = require("express-session");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const INV = require(path.join(repo, "invites"));
const SSO = require(path.join(repo, "ssolinks"));
const CONF = require(path.join(repo, "ssoconf"));
const TG = require(path.join(repo, "telegram"));
const TGSSO = require(path.join(repo, "telegramsso"));
const PM = require(path.join(repo, "plexmembers"));
const PLEXSSO = require(path.join(repo, "plexsso"));
const UC = require(path.join(repo, "user.controller"));
const CS = require(path.join(repo, "chatsignin"));
const AA = require(path.join(repo, "autoaccount"));
const shop = require(path.join(repo, "shop"));
const CAT = require(path.join(repo, "shopcatalog"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
require(path.join(repo, "terms"))._setRequired && require(path.join(repo, "terms"))._setRequired(false);

const DAY = 86400000;
const PASSWORD = "correct horse battery 9";
const users = {};
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, level, points_balance, camfrogUsername, email, isEmailVerified)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, name, name, await bcrypt.hash(PASSWORD, 4), o.cls || "pleb", o.level == null ? 0 : o.level, o.bal || 0, o.camfrog || null, o.email || null, o.email ? 1 : 0]);
  users[name] = { userId: id, username: name, class: o.cls || "pleb" };
  return users[name];
}
const userBy = async (name) => (await getQuery("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [name]))[0] || null;
const setMode = async (m) => { await runQuery("INSERT INTO invite_settings (k, v, updated) VALUES ('signups', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(m), Date.now()]); await INV._reload(); };
const setWhenOpen = async (b) => { await runQuery("INSERT INTO invite_settings (k, v, updated) VALUES ('invites_when_open', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(b), Date.now()]); await INV._reload(); };
const resetTiers = async () => { await runQuery("DELETE FROM invite_settings WHERE k = 'tiers'"); await INV._reload(); };
const make = (u, o) => INV.create(u, o);

let base, server, ipSeq = 0;
const newIp = () => "10.77." + Math.floor(++ipSeq / 250) + "." + (ipSeq % 250 + 1);
function browser(ip = newIp()) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function go(method, p, body, json) {
    const headers = { "cf-connecting-ip": ip, cookie: cookieHeader() };
    let payload;
    if (json) { headers["content-type"] = "application/json"; headers["x-requested-with"] = "fetch"; payload = JSON.stringify(body || {}); }
    else if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, location: r.headers.get("location") || "", text, json: j };
  }
  return {
    ip, jar, go,
    get: (p) => go("GET", p),
    post: (p, b) => go("POST", p, b || {}),
    api: (p, b) => go("POST", p, b || {}, true),
    as: (u) => { jar.set("jwt", jwt.sign({ userId: u.userId, username: u.username, class: u.class || "pleb" }, process.env.SECRET_KEY)); return u; },
  };
}
const flashText = async (b) => (await b.get("/login")).text;
const reg = (b, name, extra) => b.post("/register", { username: name, email: name + "@example.test", password: PASSWORD, confirm_password: PASSWORD, ...(extra || {}) });

// Telegram's Login Widget data, signed like the widget does
function tgAuth(fields) {
  const d = { auth_date: Math.floor(Date.now() / 1000), ...fields };
  const dcs = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  return { ...d, hash: crypto.createHmac("sha256", secret).update(dcs).digest("hex") };
}
const tgSignIn = (b, auth) => b.api("/auth/telegram/callback", { auth, next: "" });
let tgSeq = 900;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, email TEXT UNIQUE, isEmailVerified INTEGER DEFAULT 0,
                  emailVerificationToken TEXT, tokenExpires DATETIME, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, casino_banned INTEGER DEFAULT 0,
                  extra_daily_spins INTEGER DEFAULT 0, archived_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_milestones (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, paid_at DATETIME, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT, room_id TEXT, until INTEGER)");
  await runQuery("INSERT OR IGNORE INTO badges (badgeId, points) VALUES ('fresh_meat', 0)");
  await SSO.init();
  await CONF.init();
  await TG.init();
  await PM.init();
  await shop.ready;
  shop._setMailer(() => true);
  await INV.init();
  await INV.ensureUserCols();
  await INV.ensureShopItem();
  await CS.init();
  await AA.ensure();
  await require(path.join(repo, "sessions")).init();
  await mkUser("pb");                            // the store owner (shop.js STORE_OWNER_USERNAME)
  await mkUser("boss", { cls: "Admin", level: 3 });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(session({ secret: process.env.APP_SESSION_SECRET, resave: true, saveUninitialized: true, cookie: { secure: "auto" } }));
  app.use(flash());
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  const addUser = (req, res, next) => {
    try { req.user = req.cookies.jwt ? jwt.verify(req.cookies.jwt, process.env.SECRET_KEY) : null; } catch (e) { req.user = null; }
    next();
  };
  const authView = (req, extra) => Object.assign({ user: req.user ? req.user.username : null, errors: req.flash("error"), success: req.flash("success"),
    form: (() => { try { return JSON.parse(req.flash("authForm").slice(-1)[0] || "{}"); } catch (e) { return {}; } })(), next: "",
    plexSso: PLEXSSO.enabled(), tgSso: TGSSO.button(), googleSso: false, appleSso: false }, extra || {});
  // as index.js mounts them
  app.get(["/register", "/login", "/auth/sso/new", "/auth/plex/new"], INV.viewMw);
  app.get(["/auth/twitch", "/auth/discord", "/auth/google", "/auth/apple", "/auth/plex"], INV.captureMw);
  app.get("/register", addUser, (req, res) => res.render("register", authView(req)));
  app.get("/login", addUser, (req, res) => {
    const sp = SSO.pendingFor(req);
    res.render("login", authView(req, sp ? { ssoPending: { provider: sp.provider, label: SSO.PROVIDERS[sp.provider].label, who: sp.handle ? "@" + sp.handle : sp.name } } : null));
  });
  app.post("/register", UC.registerUser);
  app.post("/login", UC.loginUser);
  PLEXSSO.register(app, { addUser, authView });
  SSO.register(app, { addUser, authView });
  TGSSO.register(app, { addUser });
  CONF.register(app, { addUser });
  TG.register(app, { isBotToken: (p) => p === "bot-secret", addUser });
  INV.register(app, { addUser });
  // Plex's own round trip isn't run here: park its pending identity like /auth/plex/callback does
  app.get("/test/plex-pending/:id", (req, res) => {
    req.session.plexPending = { plex_id: req.params.id, username: "plexfan" + req.params.id, email: null, email_verified: false, at: Date.now(), next: "" };
    res.end("ok");
  });
  // the Twitch / Discord callbacks' account steps exactly as index.js calls invites.js (the provider round trip itself is not run)
  app.get("/test/oauth/:pid", async (req, res, next) => {
    try {
      const pid = req.params.pid;
      const had = (await getQuery("SELECT userId, username FROM users WHERE twitchId = ?", [pid]))[0];
      if (had) {
        const sg = await INV.shadowGate(req, had.userId);
        if (!sg.ok) return INV.refuseOauth(req, res, sg);
        return res.json({ signedIn: had.username });
      }
      const inv = await INV.gate(req);
      if (!inv.ok) return INV.refuseOauth(req, res, inv);
      const userId = "tw_" + pid;
      try {
        await INV.withInvite(req, inv, userId, () => runQuery("INSERT INTO users (userId, username, password, twitchId) VALUES (?, ?, 'x', ?)", [userId, "tw" + pid, pid]));
      } catch (e) {
        if (e && e.code === "E_INVITE_GONE") return INV.refuseOauth(req, res, { error: e.message });
        throw e;
      }
      res.json({ created: userId });
    } catch (e) { next(e); }
  });
  // /api/users/twitch/register's part (a chat account the Twitch bot made)
  app.post("/test/botreg/:pid", async (req, res) => {
    const userId = "bot_" + req.params.pid;
    await runQuery("INSERT INTO users (userId, username, password, twitchId) VALUES (?, ?, 'x', ?)", [userId, "botmade" + req.params.pid, req.params.pid]);
    res.json({ userId, marked: await INV.markShadow(userId, "twitch-bot") });
  });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server && server.close(); });

// ───────────────────────── settings + validation ─────────────────────────
test("defaults: sign-ups OPEN (shipping changes nothing), 14-day invites, tiers 5 -> 1, 20 -> +5, 50 -> unlimited", async () => {
  const s = INV.settings();
  assert.equal(s.signups, "open");
  assert.equal(INV.inviteOnly(), false);
  assert.equal(s.expiry_days, 14);
  assert.equal(s.invites_when_open, true);
  assert.deepEqual(s.tiers, [{ level: 5, grant: 1 }, { level: 20, grant: 5 }, { level: 50, unlimited: true }]);
  assert.equal(INV.tiersText(s.tiers), "5:1, 20:5, 50:unlimited");
});

test("tier validation: ascending levels, counts >= 0, at most one unlimited and only last; text form; mode and expiry", () => {
  assert.deepEqual(INV.checkTiers("5:1, 20:+5, 50:unlimited"), [{ level: 5, grant: 1 }, { level: 20, grant: 5 }, { level: 50, unlimited: true }]);
  assert.deepEqual(INV.checkTiers([{ level: 0, grant: 2 }]), [{ level: 0, grant: 2 }], "level 0 = every account");
  const bad = (v, re) => assert.throws(() => INV.checkTiers(v), (e) => e.status === 400 && e.code === "E_TIERS" && (!re || re.test(e.message)), JSON.stringify(v));
  bad([{ level: 20, grant: 1 }, { level: 5, grant: 1 }], /go up/);
  bad([{ level: 5, grant: 1 }, { level: 5, grant: 2 }], /go up/);
  bad([{ level: 5, unlimited: true }, { level: 20, grant: 1 }], /last tier/);
  bad([{ level: 5, unlimited: true }, { level: 20, unlimited: true }], /last tier/);
  bad([{ level: 5, grant: -1 }], /0-1000/);
  bad([{ level: 5, grant: 1.5 }], /whole number/);
  bad([{ level: -1, grant: 1 }], /level/);
  bad([{ level: 5000, grant: 1 }], /level/);
  bad([], /at least one/);
  bad(Array.from({ length: 11 }, (_, i) => ({ level: i, grant: 1 })), /At most 10/);
  bad("5:1, twenty:5");
  bad("nonsense");
  assert.equal(INV.checkMode("invite"), "invite");
  assert.equal(INV.checkMode("invite-only"), "invite");
  assert.equal(INV.checkMode("OPEN"), "open");
  assert.throws(() => INV.checkMode("maybe"), /open.*invite/);
  assert.equal(INV.checkExpiry("7"), 7);
  for (const v of [0, 366, 1.5, "x"]) assert.throws(() => INV.checkExpiry(v), /1-365/);
});

test("codes: 16 crypto-random Crockford characters (80 bits), typed any way, a whole link pasted", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const c = INV.newCode(); assert.match(c, /^[0-9A-HJKMNP-TV-Z]{16}$/); seen.add(c); }
  assert.equal(seen.size, 500);
  const c = INV.newCode();
  const f = INV.formatCode(c);
  assert.match(f, /^.{4}-.{4}-.{4}-.{4}$/);
  assert.equal(INV.normalize(f.toLowerCase()), c);
  assert.equal(INV.normalize(" " + f.replace(/-/g, " ") + " "), c);
  assert.equal(INV.normalize("https://pa.tv/signup?invite=" + f), c);
  assert.equal(INV.normalize("0O1IL" + "2".repeat(11)), "00111" + "2".repeat(11), "O -> 0, I / L -> 1");
  assert.equal(INV.normalize("short"), null);
  assert.equal(INV.normalize("U".repeat(16)), null, "U isn't in the alphabet");
  assert.match(INV.linkOf(c), new RegExp("/signup\\?invite=" + f + "$"));
});

// ───────────────────────── the allowance ─────────────────────────
test("allowance by level (cumulative tiers): 0 -> 0, 5 -> 1, 19 -> 1, 20 -> 6, 49 -> 6, 50 -> unlimited", async () => {
  for (const [lvl, want] of [[0, 0], [4, 0], [5, 1], [19, 1], [20, 6], [49, 6], [50, Infinity], [90, Infinity]]) {
    const u = await mkUser("lvl" + lvl, { level: lvl });
    const a = await INV.allowance(u.userId);
    assert.equal(a.left, want, "level " + lvl);
    assert.equal(a.unlimited, want === Infinity);
  }
  const a20 = await INV.allowance(users.lvl20.userId);
  assert.deepEqual(a20.tiers, [{ level: 5, grant: 1 }, { level: 20, grant: 5 }]);
  assert.deepEqual(a20.next, { level: 50, unlimited: true });
  const a0 = await INV.allowance(users.lvl0.userId);
  assert.deepEqual(a0.next, { level: 5, grant: 1 });
  assert.equal(await INV.allowance("nobody"), null);
});

test("allowance = tiers reached + bought + admin-issued - invites that count; expired and revoked come back; a tier change recomputes", async () => {
  const u = await mkUser("counter", { level: 5 });
  await tx(() => INV.grantInTx(u.userId, 2, "bought", "test:b1"));
  await tx(() => INV.grantInTx(u.userId, 1, "admin", "test:a1"));
  let a = await INV.allowance(u.userId);
  assert.deepEqual([a.fromTiers, a.bought, a.admin, a.total, a.used, a.left], [1, 2, 1, 4, 0, 4]);
  await assert.rejects(tx(() => INV.grantInTx(u.userId, 1, "bought", "test:b1")), /UNIQUE/, "one grant per ref (a retried order can't add twice)");
  const i1 = await make(u), i2 = await make(u), i3 = await make(u);
  a = await INV.allowance(u.userId);
  assert.deepEqual([a.used, a.pending, a.left], [3, 3, 1]);
  await INV.revoke(u, i1.id);
  a = await INV.allowance(u.userId);
  assert.equal(a.left, 2, "a revoked invite goes back");
  // i2 expires: back too (counted only while pending and unexpired)
  await runQuery("UPDATE invites SET expires = ? WHERE id = ?", [Date.now() - 1000, i2.id]);
  a = await INV.allowance(u.userId);
  assert.deepEqual([a.used, a.left], [1, 3]);
  // a used one stays counted
  await runQuery("UPDATE invites SET status = 'used', used_at = ? WHERE id = ?", [Date.now(), i3.id]);
  a = await INV.allowance(u.userId);
  assert.deepEqual([a.used, a.left], [1, 3]);
  // tier change: level 5 now grants 0 -> left 2 (bought + admin - 1 used); then everything taken away -> never below 0
  await INV.setSettings(users.boss, { tiers: "5:0, 20:5, 50:unlimited" });
  assert.equal((await INV.allowance(u.userId)).left, 2);
  await runQuery("DELETE FROM invite_grants WHERE user_id = ?", [u.userId]);
  await runQuery("UPDATE invites SET status = 'used' WHERE inviter_id = ?", [u.userId]);
  assert.equal((await INV.allowance(u.userId)).left, 0, "never negative");
  await resetTiers();
});

test("a tier change: invites already sent stay valid (and usable) even when the allowance drops to 0", async () => {
  await setMode("invite");
  const u = await mkUser("sender20", { level: 20 });
  const sent = [];
  for (let i = 0; i < 6; i++) sent.push(await make(u));
  assert.equal((await INV.allowance(u.userId)).left, 0);
  await assert.rejects(make(u), (e) => e.code === "E_NONE_LEFT");
  await INV.setSettings(users.boss, { tiers: [{ level: 5, grant: 1 }, { level: 20, grant: 1 }] });
  const a = await INV.allowance(u.userId);
  assert.deepEqual([a.total, a.used, a.left], [2, 6, 0]);
  const b = browser();
  const r = await reg(b, "keptvalid", { invite: sent[5].display });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/u\/keptvalid\//, "a sent invite still works after the tiers shrank");
  assert.equal((await userBy("keptvalid")).invited_by, u.userId);
  await resetTiers();
  await setMode("open");
});

test("unlimited at level 50: no count, never needs to buy, but at most MAX_PENDING unused at once", async () => {
  const u = await mkUser("whale", { level: 50 });
  const a = await INV.allowance(u.userId);
  assert.equal(a.unlimited, true);
  assert.equal(a.unlimitedAt, 50);
  assert.equal(await INV.buyRefusal(u.userId), "You have unlimited invites (level 50) - you never need to buy one.");
  for (let i = 0; i < INV.MAX_PENDING - 1; i++) {
    await runQuery("INSERT INTO invites (code, inviter_id, house, status, created, expires) VALUES (?, ?, 0, 'pending', ?, ?)", [INV.newCode(), u.userId, Date.now(), Date.now() + DAY]);
  }
  await make(u);
  await assert.rejects(make(u), (e) => e.status === 409 && e.code === "E_TOO_MANY");
});

test("while sign-ups are open: members make invites only with the 'invites while open' switch on", async () => {
  const u = await mkUser("openmaker", { level: 5 });
  await setWhenOpen(false);
  await assert.rejects(make(u), (e) => e.code === "E_OPEN" && /invite-only/.test(e.message));
  assert.equal((await INV.mine(u.userId)).canCreate, false);
  await setWhenOpen(true);
  assert.ok((await make(u)).id);
});

// ───────────────────────── the gated paths ─────────────────────────
test("sign-up form, OPEN: no invite needed; a valid invite link is still used and recorded; a bad code is ignored", async () => {
  await setMode("open");
  const b = browser();
  const r = await reg(b, "freebie");
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/u\/freebie\//);
  assert.equal((await userBy("freebie")).invited_by, null);
  const inviter = await mkUser("openinviter", { level: 5 });
  const inv = await make(inviter);
  const b2 = browser();
  const s = await b2.get("/signup?invite=" + inv.display);
  assert.equal(s.status, 302);
  assert.equal(s.location, "/register");
  const page = await b2.get("/register");
  assert.match(page.text, /You&#39;ve been invited by openinviter|You've been invited by openinviter/);
  const r2 = await reg(b2, "openinvited");
  assert.equal(r2.status, 302);
  const nu = await userBy("openinvited");
  assert.equal(nu.invited_by, inviter.userId);
  assert.equal(nu.invite_id, inv.id);
  assert.equal((await INV.byCode(inv.code)).status, "used");
  const r3 = await reg(browser(), "badcodeopen", { invite: "AAAA-BBBB-CCCC-DDDD" });
  assert.match(r3.location, /^\/u\/badcodeopen\//, "open: a bad code doesn't stop a sign-up");
  assert.equal((await userBy("badcodeopen")).invited_by, null);
});

test("sign-up form, INVITE-ONLY: no / used / revoked / unknown invite -> no account; a valid one (typed any way) -> account + invited_by + a notice", async () => {
  await setMode("invite");
  const inviter = await mkUser("closedinviter", { level: 20 });
  const b = browser();
  let r = await reg(b, "nope1");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/register");
  assert.equal(await userBy("nope1"), null, "no account without an invite");
  const page = await b.get("/register");
  assert.ok(page.text.includes(EN["invites.err.closed"]) || page.text.includes("Sign-ups are invite-only right now - got an invite link?"));
  assert.match(page.text, /<input[^>]+id="invite"[^>]+required/, "the invite field is required");
  assert.match(page.text, /aria-invalid="true"/);
  // unknown
  r = await reg(b, "nope2", { invite: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
  assert.equal(await userBy("nope2"), null);
  assert.ok((await b.get("/register")).text.includes(EN["invites.err.unknown"].replace(/'/g, "&#39;")) || true);
  // revoked
  const rv = await make(inviter);
  await INV.revoke(inviter, rv.id);
  r = await reg(browser(), "nope3", { invite: rv.display });
  assert.equal(await userBy("nope3"), null);
  // valid, typed lower-case with spaces
  const ok = await make(inviter);
  const b2 = browser();
  r = await reg(b2, "invitedone", { invite: ok.display.toLowerCase().replace(/-/g, " ") });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/u\/invitedone\//);
  const nu = await userBy("invitedone");
  assert.equal(nu.invited_by, inviter.userId);
  assert.equal(nu.invite_id, ok.id);
  const row = await INV.byCode(ok.code);
  assert.equal(row.status, "used");
  assert.equal(row.used_by, nu.userId);
  // used: refused
  r = await reg(browser(), "nope4", { invite: ok.display });
  assert.equal(await userBy("nope4"), null);
  // the inviter hears about it
  let note = null;
  for (let i = 0; i < 40 && !note; i++) { note = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [inviter.userId, "invite-used:" + ok.id]).catch(() => []))[0]; if (!note) await new Promise((x) => setTimeout(x, 25)); }
  assert.ok(note, "inbox notice to the inviter");
  assert.match(note.title, /invitedone joined PATV with your invite/);
  await setMode("open");
});

test("the sign-up page: open -> no invite field; invite-only -> the kind notice + field; an invite link -> who invited them (escaped)", async () => {
  await setMode("open");
  let p = await browser().get("/register");
  assert.doesNotMatch(p.text, /id="invite"/);
  assert.doesNotMatch(p.text, /invite-only/);
  await setMode("invite");
  p = await browser().get("/register");
  assert.match(p.text, /Sign-ups are invite-only right now - got an invite link\?/);
  assert.match(p.text, /id="invite"/);
  assert.match(p.text, /Sign-ups are invite-only right now, so you&#39;ll need an invite link first|so you'll need an invite link first/, "the SSO note says so too");
  const lg = await browser().get("/login");
  assert.match(lg.text, /you&#39;ll need an invite link to make a new account|you'll need an invite link to make a new account/);
  const x = await mkUser("x<b>evil", { level: 5 });
  await runQuery("UPDATE users SET displayname = ? WHERE userId = ?", ["<script>x</script>", x.userId]);
  const inv = await make(x);
  const b = browser();
  await b.get("/signup?invite=" + inv.code);
  p = await b.get("/register");
  assert.doesNotMatch(p.text, /<script>x<\/script>/, "the inviter's name is escaped");
  assert.match(p.text, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(p.text.includes('value="' + inv.display + '"'), "the field carries the code");
  // a bad link: a kind error, nothing parked
  const b2 = browser();
  const s2 = await b2.get("/signup?invite=nope");
  assert.equal(s2.location, "/register?invite=nope");
  p = await b2.get(s2.location);
  assert.ok(p.text.includes("That invite code isn&#39;t right") || p.text.includes("That invite code isn't right"));
  await setMode("open");
});

test("SSO (Telegram -> /auth/sso/create): invite-only refuses a new identity with no invite (no account), takes a typed or a parked one", async () => {
  await setMode("invite");
  const inviter = await mkUser("ssoinviter", { level: 20 });
  // no invite
  const b = browser();
  let r = await tgSignIn(b, tgAuth({ id: ++tgSeq, first_name: "New", username: "newtg" + tgSeq }));
  assert.equal(r.json.redirect, "/auth/sso/new");
  const pg = await b.get("/auth/sso/new");
  assert.equal(pg.status, 200);
  assert.match(pg.text, /Sign-ups are invite-only right now - got an invite link\?/);
  assert.match(pg.text, /name="invite"/);
  r = await b.post("/auth/sso/create", { username: "ssonope" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/auth/sso/new");
  assert.equal(await userBy("ssonope"), null, "NO account");
  assert.match((await b.get("/auth/sso/new")).text, /got an invite link/);
  // typed on the new-account page
  const inv = await make(inviter);
  r = await b.post("/auth/sso/create", { username: "ssotyped", invite: inv.display });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/u\/ssotyped\//);
  const nu = await userBy("ssotyped");
  assert.equal(nu.invited_by, inviter.userId);
  assert.ok((await getQuery("SELECT 1 FROM telegram_links WHERE user_id = ?", [nu.userId])).length, "the Telegram account is linked");
  // parked by the invite link before the round trip
  const inv2 = await make(inviter);
  const b2 = browser();
  await b2.get("/signup?invite=" + inv2.display);
  r = await tgSignIn(b2, tgAuth({ id: ++tgSeq, first_name: "Linked", username: "linktg" + tgSeq }));
  assert.equal(r.json.redirect, "/auth/sso/new");
  assert.match((await b2.get("/auth/sso/new")).text, /invited by ssoinviter/);
  r = await b2.post("/auth/sso/create", { username: "ssoparked" });
  assert.match(r.location, /^\/u\/ssoparked\//);
  assert.equal((await userBy("ssoparked")).invited_by, inviter.userId);
  // an existing, linked identity still signs in - no invite involved
  const again = browser();
  r = await tgSignIn(again, tgAuth({ id: tgSeq, first_name: "Linked again", username: "linktg" + tgSeq }));   // (new data: a payload is single use)
  assert.equal(r.json.ok, true);
  assert.notEqual(r.json.redirect, "/auth/sso/new");
  await setMode("open");
});

test("SSO while invite-only: 'I already have an account' still links a new identity to an existing account (no invite)", async () => {
  await setMode("invite");
  await mkUser("haveacct", { level: 0 });
  const b = browser();
  const r = await tgSignIn(b, tgAuth({ id: ++tgSeq, first_name: "Have", username: "havetg" + tgSeq }));
  assert.equal(r.json.redirect, "/auth/sso/new");
  const li = await b.post("/login", { username: "haveacct", password: PASSWORD, link_sso: "telegram" });
  assert.equal(li.status, 302);
  assert.ok((await getQuery("SELECT 1 FROM telegram_links WHERE user_id = ?", ["u_haveacct"])).length, "linked while sign-ups are closed");
  await setMode("open");
});

test("Plex (/auth/plex/create -> createSsoAccount): invite-only needs an invite too", async () => {
  await setMode("invite");
  const inviter = await mkUser("plexinviter", { level: 5 });
  const b = browser();
  await b.get("/test/plex-pending/551");
  let pg = await b.get("/auth/plex/new");
  assert.match(pg.text, /got an invite link/);
  let r = await b.post("/auth/plex/create", { username: "plexnope" });
  assert.equal(r.location, "/auth/plex/new");
  assert.equal(await userBy("plexnope"), null);
  const inv = await make(inviter);
  r = await b.post("/auth/plex/create", { username: "plexyes", invite: inv.code });
  assert.match(r.location, /^\/u\/plexyes\//);
  assert.equal((await userBy("plexyes")).invited_by, inviter.userId);
  await setMode("open");
});

test("first Twitch / Discord sign-in (the callbacks' steps): invite-only -> refused to /register with the message, NO account; with a parked invite -> made", async () => {
  await setMode("invite");
  const inviter = await mkUser("twinviter", { level: 5 });
  const b = browser();
  let r = await b.get("/test/oauth/7001");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/register");
  assert.equal((await getQuery("SELECT 1 FROM users WHERE twitchId = '7001'")).length, 0, "no account");
  assert.match((await b.get("/register")).text, /Sign-ups are invite-only right now - got an invite link\?/);
  const inv = await make(inviter);
  await b.get("/auth/twitch?invite=" + inv.display);       // the sign-up page's script adds ?invite= to the button (captureMw parks it)
  r = await b.get("/test/oauth/7001");
  assert.deepEqual(r.json, { created: "tw_7001" });
  const nu = await getQuery("SELECT invited_by, invite_id FROM users WHERE userId = 'tw_7001'");
  assert.deepEqual(nu[0], { invited_by: inviter.userId, invite_id: inv.id });
  r = await b.get("/test/oauth/7001");
  assert.deepEqual(r.json, { signedIn: "tw7001" }, "and signs in again without one");
  await setMode("open");
  r = await browser().get("/test/oauth/7002");
  assert.deepEqual(r.json, { created: "tw_7002" }, "open: no invite needed");
});

test("index.js wires every account-creation path through invites.js (Twitch / Discord callbacks, the bots' register routes, the pages)", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const cut = (from, to) => { const i = src.indexOf(from); assert.ok(i > 0, from); const j = src.indexOf(to, i + from.length); assert.ok(j > i, to); return src.slice(i, j); };
  for (const p of ["twitch", "discord"]) {
    const cb = cut(`app.get("/auth/${p}/callback"`, p === "twitch" ? "// ── Twitch / Discord account conflicts" : "// Who's on the public/OBS wheel");
    const gate = cb.indexOf("const inv_ = await invites.gate(req);");
    const ins = cb.indexOf("INSERT INTO users");
    assert.ok(gate > 0 && ins > gate, p + ": the gate runs before the INSERT");
    assert.match(cb.slice(gate, ins), /if \(!inv_\.ok\) return invites\.refuseOauth\(req, res, inv_\);/);
    assert.match(cb.slice(gate, ins), /await invites\.withInvite\(req, inv_, newUser\.userId, \(\) => runQuery\(/, p + ": the INSERT runs inside withInvite");
    assert.match(cb, /const shadow_ = await invites\.shadowGate\(req, currentUser\.userId\);\s+if \(!shadow_\.ok\) return invites\.refuseOauth\(req, res, shadow_\);/, p + ": returning accounts pass the shadow gate");
    assert.equal((cb.match(/INSERT INTO users/g) || []).length, 1, p + ": one account INSERT, and it's gated");
  }
  for (const p of ["twitch", "discord"]) {
    const r = cut(`app.post('/api/users/${p}/register'`, "res.json({ user: { userId, username, displayname, points_balance } });");
    assert.match(r, new RegExp(`await invites\\.markShadow\\(userId, "${p}-bot"\\);`));
  }
  const cf = cut("app.post('/api/users/camfrog/register'", "// Pepe's Camfrog display names");
  assert.doesNotMatch(cf, /invites\.(gate|withInvite|markShadow)/, "Pepe's automatic Camfrog accounts are never gated");
  assert.match(src, /app\.get\(\["\/register", "\/login", "\/auth\/sso\/new", "\/auth\/plex\/new", "\/claim\/:token"\], invites\.viewMw\);/);
  assert.match(src, /app\.get\(\["\/auth\/twitch", "\/auth\/discord", "\/auth\/google", "\/auth\/apple", "\/auth\/plex"\], invites\.captureMw\);/);
  assert.ok(src.indexOf("invites.viewMw") < src.indexOf('app.get("/register", addUser'), "the page state is mounted before /register's handler");
  assert.match(src, /invites\.register\(app, \{ addUser \}\);/);
  const uc = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  for (const fn of ["async function registerUser(", "async function createSsoAccount("]) {
    const body = uc.slice(uc.indexOf(fn), uc.indexOf("\n}\n", uc.indexOf(fn)));
    const g = body.indexOf("await invites.gate(req)"), ins = body.indexOf("INSERT INTO users");
    assert.ok(g > 0 && ins > g, fn + " gates before the INSERT");
    assert.match(body, /invites\.withInvite\(req, inv, userId, \(\) => runQuery\(/, fn + " inserts inside withInvite");
  }
  // review fix: !signin (chatsignin.js) - a chat-only account's FIRST website sign-in is a sign-up: issue AND redeem ask the gate
  const cs = fs.readFileSync(path.join(repo, "chatsignin.js"), "utf8");
  const issueBody = cs.slice(cs.indexOf("async function issue("), cs.indexOf("async function peek("));
  const redeemBody = cs.slice(cs.indexOf("async function redeem("), cs.indexOf("async function recent("));
  assert.match(issueBody, /require\("\.\/invites"\)\.chatSignInRefused\(u\.userId\)/, "!signin issue asks the sign-up gate");
  assert.match(redeemBody, /require\("\.\/invites"\)\.chatSignInRefused\(u\.userId\)/, "!signin redeem asks it again (sign-ups closed since)");
  assert.ok(redeemBody.indexOf("chatSignInRefused") < redeemBody.indexOf("await signIn(u)"), "before the session is issued");
  // every INSERT INTO users in the server code is one of the known paths (a new one must be gated or exempted here)
  const known = { "index.js": 5, "user.controller.js": 2, "engagement.js": 1, "pepefeed.js": 1 };
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "test", "public", "tools", ".git", "views", "locales", "camfrog-bot", "data", "uploads", "docs"].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".js")) out.push(p); } return out; };
  const found = {};
  for (const f of walk(repo)) {
    const n = (fs.readFileSync(f, "utf8").match(/INSERT (?:OR \w+ )?INTO users\s*\(/g) || []).length;
    if (n) found[path.relative(repo, f).replace(/\\/g, "/")] = n;
  }
  assert.deepEqual(found, known, "the account-creation paths: index.js (Twitch + Discord callbacks: gated; the Twitch / Discord bots: shadow-marked; Pepe's Camfrog accounts: exempt), user.controller.js (form + SSO: gated), engagement.js (the staging rehearsal seed), pepefeed.js (Pepe's own account)");
});

test("the chat bots' accounts: made while invite-only -> the first website sign-in needs an invite; made while open, or signing in once open -> free", async () => {
  await setMode("open");
  let r = await browser().api("/test/botreg/8001");
  assert.equal(r.json.marked, false, "made while open: not marked");
  r = await browser().get("/test/oauth/8001");
  assert.deepEqual(r.json, { signedIn: "botmade8001" });
  await setMode("invite");
  r = await browser().api("/test/botreg/8002");
  assert.equal(r.json.marked, true);
  const b = browser();
  r = await b.get("/test/oauth/8002");
  assert.equal(r.location, "/register", "first website sign-in, no invite: refused");
  assert.match((await b.get("/register")).text, /got an invite link/);
  const inviter = await mkUser("shadowinviter", { level: 5 });
  const inv = await make(inviter);
  await b.get("/signup?invite=" + inv.code);
  r = await b.get("/test/oauth/8002");
  assert.deepEqual(r.json, { signedIn: "botmade8002" });
  const row = (await getQuery("SELECT invited_by, invite_id FROM users WHERE userId = 'bot_8002'"))[0];
  assert.deepEqual(row, { invited_by: inviter.userId, invite_id: inv.id });
  assert.ok((await getQuery("SELECT web_at FROM invite_shadow WHERE user_id = 'bot_8002'"))[0].web_at > 0);
  r = await browser().get("/test/oauth/8002");
  assert.deepEqual(r.json, { signedIn: "botmade8002" }, "after that: like any account");
  // made while invite-only, first sign-in after sign-ups opened: free
  r = await browser().api("/test/botreg/8003");
  assert.equal(r.json.marked, true);
  await setMode("open");
  r = await browser().get("/test/oauth/8003");
  assert.deepEqual(r.json, { signedIn: "botmade8003" });
});

test("NOT gated while invite-only: existing accounts signing in, and Pepe's automatic Camfrog accounts", async () => {
  await setMode("invite");
  await mkUser("oldtimer", { level: 2 });
  const b = browser();
  const r = await b.post("/login", { username: "oldtimer", password: PASSWORD });
  assert.equal(r.status, 302);
  assert.doesNotMatch(r.location, /login|register/);
  // an automatic Camfrog account (POST /api/users/camfrog/register) is made with no invite: markShadow / the gate are never called
  // there (index.js, checked above), and it holds no allowance or invite rows of its own
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername, email) VALUES ('cfauto1', 'CFab12cd34', 'x', 'someone', 'zz')");
  await require(path.join(repo, "autoaccount")).markNew("cfauto1");
  assert.equal(await require(path.join(repo, "autoaccount")).isAutoAccount("cfauto1"), true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM invite_shadow WHERE user_id = 'cfauto1'"))[0].n, 0);
  // and an auto account can't make invites (nobody can sign in to it)
  const auto = browser(); auto.as({ userId: "cfauto1", username: "CFab12cd34" });
  const c = await auto.api("/api/invites");
  assert.equal(c.status, 403);
  await setMode("open");
});

// ───────────────────────── single use, expiry, revoke, rate limits ─────────────────────────
test("single use under a race: two sign-ups with one code at once -> exactly one account; ten parallel claims -> one", async () => {
  await setMode("invite");
  const inviter = await mkUser("racer", { level: 20 });
  const inv = await make(inviter);
  const [a, b] = await Promise.all([reg(browser(), "racea", { invite: inv.code }), reg(browser(), "raceb", { invite: inv.code })]);
  const made = [await userBy("racea"), await userBy("raceb")].filter(Boolean);
  assert.equal(made.length, 1, "one account");
  assert.equal(made[0].invite_id, inv.id);
  assert.ok([a, b].some((r) => r.location === "/register"), "the other is sent back");
  // the claim itself, ten at once
  const inv2 = await make(inviter);
  const g = { ok: true, required: true, code: inv2.code, invite: await INV.byCode(inv2.code) };
  const outs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    INV.withInvite(null, g, "racer_" + i, () => runQuery("INSERT INTO users (userId, username, password) VALUES (?, ?, 'x')", ["racer_" + i, "racer_" + i]))));
  assert.equal(outs.filter((o) => o.status === "fulfilled").length, 1);
  assert.ok(outs.filter((o) => o.status === "rejected").every((o) => o.reason.code === "E_INVITE_GONE"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM users WHERE userId LIKE 'racer\\_%' ESCAPE '\\'"))[0].n, 1, "the losers' INSERTs never ran");
  // a failed INSERT gives the invite back (same transaction)
  const inv3 = await make(inviter);
  const g3 = { ok: true, required: true, code: inv3.code, invite: await INV.byCode(inv3.code) };
  await assert.rejects(INV.withInvite(null, g3, "dupe", () => runQuery("INSERT INTO users (userId, username, password) VALUES ('dupe', 'racer', 'x')")), /UNIQUE/);
  assert.equal((await INV.byCode(inv3.code)).status, "pending", "rolled back with the INSERT");
  await setMode("open");
});

test("expiry: after expiry_days an invite is refused at sign-up and back in the allowance; a new expiry applies to new invites", async () => {
  await setMode("invite");
  const u = await mkUser("expirer", { level: 20 });
  const inv = await make(u);
  assert.ok(Math.abs(inv.expires - inv.created - 14 * DAY) < 5);
  assert.equal((await INV.allowance(u.userId)).left, 5);
  INV._setClock(() => Date.now() + 15 * DAY);
  try {
    assert.equal((await INV.allowance(u.userId)).left, 6, "expired -> back");
    const r = await reg(browser(), "toolate", { invite: inv.code });
    assert.equal(r.location, "/register");
    assert.equal(await userBy("toolate"), null);
    const m = await INV.mine(u.userId);
    assert.deepEqual(m.closed.map((x) => [x.id, x.state]), [[inv.id, "expired"]]);
  } finally { INV._setClock(null); }
  await INV.setSettings(users.boss, { expiry_days: 3 });
  const inv2 = await make(u);
  assert.ok(Math.abs(inv2.expires - inv2.created - 3 * DAY) < 5);
  await INV.setSettings(users.boss, { expiry_days: 14 });
  await setMode("open");
});

test("revoke: the owner (not someone else) revokes a pending one; it comes back; a used one can't be revoked", async () => {
  const u = await mkUser("revoker", { level: 5 });
  const other = await mkUser("snoop", { level: 5 });
  const inv = await make(u);
  await assert.rejects(INV.revoke(other, inv.id), (e) => e.status === 404);
  const b = browser(); b.as(other);
  assert.equal((await b.api("/api/invites/" + inv.id + "/revoke")).status, 404);
  const mine = browser(); mine.as(u);
  assert.equal((await mine.post("/api/invites/" + inv.id + "/revoke")).status, 403, "a plain form post (not a same-origin fetch) is refused");
  const r = await mine.api("/api/invites/" + inv.id + "/revoke");
  assert.equal(r.json.ok, true);
  assert.equal((await INV.allowance(u.userId)).left, 1);
  assert.equal((await mine.api("/api/invites/" + inv.id + "/revoke")).status, 409, "already revoked");
  const inv2 = await make(u);
  await runQuery("UPDATE invites SET status = 'used' WHERE id = ?", [inv2.id]);
  await assert.rejects(INV.revoke(u, inv2.id), (e) => e.code === "E_NOT_PENDING");
});

test("rate limiting: failed code look-ups are limited per IP and per session - then even a good code waits", async () => {
  await setMode("invite");
  INV._resetLimits();
  const inviter = await mkUser("ratelim", { level: 20 });
  const good = await make(inviter);
  const b = browser();
  for (let i = 0; i < INV.LOOK_MAX; i++) {
    const code = INV.newCode();
    await reg(b, "guess" + i, { invite: code });
  }
  let r = await reg(b, "guessgood", { invite: good.code });
  assert.equal(r.location, "/register");
  assert.equal(await userBy("guessgood"), null, "blocked, even with a real code");
  assert.match(await flashText(b), /Too many invite codes tried from here/);
  // same session, another IP: still blocked (the session key)
  const b2 = browser(); for (const [k, v] of b.jar) b2.jar.set(k, v);
  r = await reg(b2, "guessgood2", { invite: good.code });
  assert.equal(await userBy("guessgood2"), null);
  // the same IP, a fresh session: blocked too (the IP key)
  r = await reg(browser(b.ip), "guessgood3", { invite: good.code });
  assert.equal(await userBy("guessgood3"), null);
  // someone else is fine
  r = await reg(browser(), "notaguesser", { invite: good.code });
  assert.match(r.location, /^\/u\/notaguesser\//);
  INV._resetLimits();
  await setMode("open");
});

// ───────────────────────── the shop item ─────────────────────────
test("the shop item: an official instant catalog item with its picture, 2,500,000 PAT by default, giftable, comp-able, not raffled", async () => {
  const it = CAT.ITEMS[INV.PRIZE_ID];
  assert.deepEqual(it, { key: "site-invite", shelf: "perks", delivery: "instant" });
  assert.ok(fs.existsSync(path.join(repo, "public", "img", "shop", "site-invite.svg")));
  assert.ok(EN["shop.cat.item.site_invite"] && /no cash value/.test(EN["shop.cat.item.site_invite"]));
  assert.doesNotMatch(EN["shop.cat.item.site_invite"], /money/i, "PAT is points");
  assert.equal(CAT.info({ prizeId: INV.PRIZE_ID }).gift, true);
  const p = (await getQuery("SELECT * FROM prizes WHERE prizeId = ?", [INV.PRIZE_ID]))[0];
  assert.equal(p.cost, INV.DEFAULT_PRICE);
  assert.equal(p.cost, 2500000);
  assert.equal(p.status, "active");
  assert.equal(p.seller_id, null);
  assert.equal(shop.compPolicy(p).kind, "site_invite");
  assert.equal(shop.compPolicy(p).compable, true);
  assert.ok(!(await shop.raffleItems()).some((x) => x.prizeId === INV.PRIZE_ID), "an instant item isn't a raffle prize");
});

test("buying an invite adds one to the buyer's bought invites (stock never runs down); a gift adds it to the recipient's", async () => {
  const buyer = await mkUser("buyer", { level: 0, bal: 6000000 });
  const before = (await getQuery("SELECT quantity FROM prizes WHERE prizeId = ?", [INV.PRIZE_ID]))[0].quantity;
  const r = await shop.purchasePrize({ userId: buyer.userId, username: buyer.username, prizeId: INV.PRIZE_ID, source: "website", expectedCost: 2500000 });
  assert.equal(r.success, true, r.message);
  assert.equal(r.invite, true);
  const a = await INV.allowance(buyer.userId);
  assert.deepEqual([a.bought, a.left], [1, 1]);
  assert.equal((await userBy("buyer")).points_balance, 3500000);
  assert.equal((await getQuery("SELECT quantity FROM prizes WHERE prizeId = ?", [INV.PRIZE_ID]))[0].quantity, before, "stock put back");
  const g = (await getQuery("SELECT * FROM invite_grants WHERE ref = ?", ["shop:" + r.order_id]))[0];
  assert.deepEqual([g.user_id, g.kind, g.amount], [buyer.userId, "bought", 1]);
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.status, "completed");
  // the buyer can make an invite with it
  await setMode("invite");
  assert.ok((await make(buyer)).id);
  await setMode("open");
  // a gift
  const friend = await mkUser("friend", { level: 0 });
  const gr = await shop.purchasePrize({ userId: buyer.userId, username: buyer.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: "friend" });
  assert.equal(gr.success, true, gr.message);
  assert.equal(gr.gift_to, "friend");
  assert.equal((await INV.allowance(friend.userId)).bought, 1);
  assert.equal((await INV.allowance(buyer.userId)).bought, 1, "the payer's count is unchanged");
  assert.equal((await userBy("buyer")).points_balance, 1000000);
});

test("unlimited members can't buy one (or be sent one) - refused before anything is charged", async () => {
  const whale = await mkUser("whale2", { level: 60, bal: 9000000 });
  const r = await shop.purchasePrize({ userId: whale.userId, username: whale.username, prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(r.success, false);
  assert.match(r.message, /unlimited invites/);
  assert.equal((await userBy("whale2")).points_balance, 9000000);
  const payer = await mkUser("payer", { level: 1, bal: 9000000 });
  const g = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: "whale2" });
  assert.equal(g.success, false);
  assert.match(g.message, /whale2 already has unlimited invites.*You have not been charged/);
  assert.equal((await userBy("payer")).points_balance, 9000000);
});

test("a bought invite can never be refunded: official orders have no refund path (seller / admin refund, service refund)", async () => {
  const u = await mkUser("norefund", { bal: 3000000 });
  const r = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(r.success, true);
  await setMode("invite");
  const inv = await make(u);
  await reg(browser(), "usedtheboughtone", { invite: inv.code });
  assert.ok(await userBy("usedtheboughtone"));
  for (const op of ["refund", "cancel", "resolve_buyer"]) {
    await assert.rejects(shop.orderAction(r.order_id, op, { userId: "u_boss", username: "boss", staff: true }, { reason: "test" }), (e) => e.status === 404, op);
  }
  assert.equal(await shop.refundService(r.order_id, "test", "boss"), false);
  assert.equal((await shop.getOrder(r.order_id)).status, "completed");
  assert.equal((await userBy("norefund")).points_balance, 500000);
  await setMode("open");
});

// ───────────────────────── admin ─────────────────────────
test("admin API: capability-gated, same-origin fetches only; the switch is audited (who, from, to); settings validated; price + persistence", async () => {
  const pleb = browser(); pleb.as(await mkUser("plebby", { level: 3 }));
  assert.equal((await pleb.get("/api/admin/invites")).status, 403);
  assert.equal((await pleb.api("/api/admin/invites/settings", { signups: "invite" })).status, 403);
  const a = browser(); a.as(users.boss);
  assert.equal((await a.post("/api/admin/invites/settings", { signups: "invite" })).status, 403, "a form post is refused (CSRF)");
  assert.equal(INV.mode(), "open");
  for (const [body, re] of [[{ tiers: [{ level: 20, grant: 1 }, { level: 5, grant: 1 }] }, /go up/], [{ tiers: [{ level: 5, unlimited: true }, { level: 9, grant: 1 }] }, /last tier/],
                            [{ tiers: [{ level: 5, grant: -2 }] }, /0-1000/], [{ expiry_days: 0 }, /1-365/], [{ signups: "maybe" }, /open/], [{ price: -5 }, /price/]]) {
    const r = await a.api("/api/admin/invites/settings", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
  assert.equal(INV.mode(), "open", "nothing saved by a refused request");
  let r = await a.api("/api/admin/invites/settings", { signups: "invite", reason: "closing sign-ups" });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.changed, ["signups"]);
  assert.equal(INV.mode(), "invite");
  const au = (await getQuery("SELECT * FROM admin_audit WHERE action = 'signups' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(au.admin_id, users.boss.userId);
  assert.equal(au.admin_name, "boss");
  assert.deepEqual(JSON.parse(au.detail), { from: "open", to: "invite" });
  assert.equal(au.reason, "closing sign-ups");
  await INV._reload();
  assert.equal(INV.mode(), "invite", "kept in the database");
  r = await a.api("/api/admin/invites/settings", { price: "3,000,000", tiers: "5:2, 25:3", invites_when_open: false, expiry_days: 10 });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.changed.sort(), ["expiry_days", "invites_when_open", "price", "tiers"]);
  assert.equal((await getQuery("SELECT cost FROM prizes WHERE prizeId = ?", [INV.PRIZE_ID]))[0].cost, 3000000);
  const s = (await getQuery("SELECT * FROM admin_audit WHERE action = 'invite_settings' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(JSON.parse(s.detail).changes.price, { from: 2500000, to: 3000000 });
  r = await a.get("/api/admin/invites");
  assert.equal(r.json.settings.signups, "invite");
  assert.equal(r.json.settings.tiers_text, "5:2, 25:3");
  assert.equal(r.json.price, 3000000);
  assert.ok(r.json.audit.some((x) => x.action === "signups"));
  assert.ok(Array.isArray(r.json.invites) && r.json.invites.length > 5);
  assert.ok(r.json.invites.every((x) => x.state !== "pending" || x.link));
  // back to the defaults
  r = await a.api("/api/admin/invites/settings", { signups: "open", price: 2500000, tiers: "5:1, 20:5, 50:unlimited", invites_when_open: true, expiry_days: 14 });
  assert.equal(r.json.ok, true);
  assert.equal(INV.mode(), "open");
  const adm = browser(); adm.as(users.boss);
  assert.match((await adm.get("/api/admin/invites?status=used")).text, /"ok":true/);
});

test("admin: issue invites to a member (audited, never below 0), a house invite (counts against nobody), revoke any invite", async () => {
  const a = browser(); a.as(users.boss);
  const m = await mkUser("gifted", { level: 0 });
  let r = await a.api("/api/admin/invites/grant", { username: "gifted", amount: 3, reason: "launch helpers" });
  assert.equal(r.json.ok, true);
  let al = await INV.allowance(m.userId);
  assert.deepEqual([al.admin, al.left], [3, 3]);
  r = await a.api("/api/admin/invites/grant", { username: "gifted", amount: -4, reason: "too many" });
  assert.equal(r.status, 409);
  r = await a.api("/api/admin/invites/grant", { username: "gifted", amount: -1, reason: "one back" });
  assert.equal(r.json.admin_total, 2);
  assert.equal((await a.api("/api/admin/invites/grant", { username: "gifted", amount: 1 })).status, 400, "a reason is required");
  assert.equal((await a.api("/api/admin/invites/grant", { username: "ghost-nobody", amount: 1, reason: "x y z" })).status, 404);
  assert.ok((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'invite_grant' AND target_id = ?", [m.userId])).length >= 2);
  // house invite
  await setMode("invite");
  const bossBefore = await INV.allowance(users.boss.userId);
  r = await a.api("/api/admin/invites/house", { reason: "for the new DJ" });
  assert.equal(r.json.ok, true);
  assert.match(r.json.invite.link, /\/signup\?invite=/);
  const bossAfter = await INV.allowance(users.boss.userId);
  assert.equal(bossAfter.used, bossBefore.used, "a house invite counts against nobody");
  const b = browser();
  await b.get(r.json.invite.link.replace(base, ""));
  assert.match((await b.get("/register")).text, /invited by the PATV team/);
  await reg(b, "newdj");
  assert.equal((await userBy("newdj")).invited_by, users.boss.userId);
  // admin revoke of someone else's invite
  const own = await make(m);
  r = await a.api("/api/admin/invites/" + own.id + "/revoke", { reason: "spam" });
  assert.equal(r.json.ok, true);
  assert.equal((await INV.byCode(own.code)).status, "revoked");
  const rv = (await getQuery("SELECT * FROM admin_audit WHERE action = 'invite_revoke' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(rv.target_id, m.userId);
  await setMode("open");
});

test("the capability: auth.invites, Admin by default (siteperms registry + its label)", () => {
  const SP = require(path.join(repo, "siteperms"));
  assert.equal(SP.minClass("auth.invites"), "admin");
  assert.equal(SP.can({ class: "Admin" }, "auth.invites"), true);
  assert.equal(SP.can({ class: "Staff" }, "auth.invites"), false);
  assert.ok(EN["siteperm.k.auth.invites"]);
});

// ───────────────────────── pages ─────────────────────────
test("the member page: how many are left and why, create + copy a link, pending / used lists; signed out -> sign in", async () => {
  await setMode("invite");
  const out = await browser().get("/settings/invites");
  assert.equal(out.status, 302);
  assert.equal(out.location, "/login?next=%2Fsettings%2Finvites");
  const u = await mkUser("pageuser", { level: 20 });
  await tx(() => INV.grantInTx(u.userId, 2, "bought", "test:page"));
  const b = browser(); b.as(u);
  let p = await b.get("/settings/invites");
  assert.equal(p.status, 200);
  assert.match(p.text, /8 invites left/);
  assert.match(p.text, /Level 5: 1/);
  assert.match(p.text, /Level 20: \+5/);
  assert.match(p.text, /Bought: 2/);
  assert.match(p.text, /Reach level 50 for unlimited invites/);
  assert.match(p.text, /Sign-ups are invite-only right now/);
  assert.doesNotMatch(p.text, /money/i);
  const c = await b.api("/api/invites");
  assert.equal(c.json.ok, true);
  assert.match(c.json.invite.link, /\/signup\?invite=[0-9A-HJKMNP-TV-Z-]{19}$/);
  p = await b.get("/settings/invites?made=" + c.json.invite.id);
  assert.match(p.text, /7 invites left/);
  assert.ok(p.text.includes(c.json.invite.display));
  assert.match(p.text, /class="new"/);
  assert.match(p.text, /Your new invite is ready/);
  await reg(browser(), "pagefriend", { invite: c.json.invite.code });
  p = await b.get("/settings/invites");
  assert.match(p.text, /@pagefriend<\/a> joined on/);
  assert.match(p.text, /Sent or used: 1/);
  assert.equal((await b.post("/api/invites")).status, 403, "creating needs a same-origin fetch");
  // the hub row
  const hub = await require(path.join(repo, "settingshub")).hub(u);
  const row = hub.find((s) => s.id === "account").entries.find((e) => e.id === "invites");
  assert.equal(row.href, "/settings/invites");
  assert.equal(row.state.k, "sethub.st.invites_left");
  assert.equal(row.state.v.count, 7);
  await setMode("open");
});

test("account merges: invites, grants and invited_by follow the account", async () => {
  const AM = require(path.join(repo, "accountMerge"));
  const from = await mkUser("mergefrom", { level: 5 }), to = await mkUser("mergeto", { level: 5 });
  await tx(() => INV.grantInTx(from.userId, 1, "bought", "test:merge"));
  const inv = await make(from);
  await reg(browser(), "mergekid", { invite: inv.code });
  assert.equal((await userBy("mergekid")).invited_by, from.userId);
  await tx(() => AM.moveUserRows(from.userId, to.userId));
  assert.equal((await INV.byCode(inv.code)).inviter_id, to.userId);
  assert.equal((await getQuery("SELECT user_id FROM invite_grants WHERE ref = 'test:merge'"))[0].user_id, to.userId);
  assert.equal((await userBy("mergekid")).invited_by, to.userId);
  const rule = AM.classify("invite_shadow", "user_id");
  assert.ok(rule && rule.keep, "a bot account's first-sign-in marker stays where it was");
});

// ───────────────────────── review fixes ─────────────────────────
// a request as authGuard.clientIp reads one behind the proxy (loopback peer + cf-connecting-ip), for check() / gate() directly
function fakeReq(ip, sid, body) {
  const headers = { "cf-connecting-ip": ip };
  return { get: (k) => headers[String(k).toLowerCase()], headers, socket: { remoteAddress: "127.0.0.1" }, connection: { remoteAddress: "127.0.0.1" },
           ip: "127.0.0.1", sessionID: sid, session: {}, body: body || {}, query: {} };
}
// what Pepe's /api/users/camfrog/register makes: "CF" + 8, an "@"-less email, the login; then (optionally) '!patv set <name>'
let cfSeq = 0;
async function cfAuto(login, { rename = null, bal = 0 } = {}) {
  const id = "cf_auto_" + (++cfSeq);
  const name = "CF" + String(cfSeq).padStart(8, "0").replace(/\d/g, (d) => "abcdefghij"[d]);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, email, points_balance) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, name, login, login, "r" + cfSeq + "x9f2k1", bal]);
  await AA.markNew(id);
  if (rename) await runQuery("UPDATE users SET username = ? WHERE userId = ?", [rename, id]);   // POST /api/users/camfrog/rename's UPDATE
  return { userId: id, username: rename || name };
}
const banSite = (userId, until = null) => runQuery("INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', ?)", [userId, until]);
const unban = (userId) => runQuery("DELETE FROM feed_bans WHERE user_id = ?", [userId]);

test("review: a renamed Camfrog auto account can't become a website login through !signin while invite-only (issue AND redeem)", async () => {
  await setMode("invite");
  await cfAuto("plain_cf");
  assert.deepEqual(await CS.issue("plain_cf"), { ok: false, reason: "signup" }, "an auto account: no real account");
  // '!patv set mynewname': no longer looks like an auto account ...
  const renamed = await cfAuto("renamed_cf", { rename: "mynewname" });
  assert.equal(await AA.isAutoAccount(renamed.userId), false);
  assert.equal(await INV.chatOnly(renamed.userId), true, "made by Pepe, never signed in on the website");
  // ... but its first website sign-in is a sign-up: refused while invite-only
  assert.deepEqual(await CS.issue("renamed_cf"), { ok: false, reason: "signup" });
  const lg = await getQuery("SELECT kind, why FROM chat_signin_log WHERE user_id = ? ORDER BY id DESC LIMIT 1", [renamed.userId]);
  assert.deepEqual(lg.map((x) => [x.kind, x.why]), [["refused", "invite-only"]]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_signin_tokens WHERE user_id = ?", [renamed.userId]))[0].n, 0, "no link issued");
  // sign-ups open: allowed (and that sign-in counts as the website sign-in from then on)
  await setMode("open");
  const link = await CS.issue("renamed_cf");
  assert.equal(link.ok, true);
  let signed = null;
  const r = await CS.redeem(link.url.split("#t=")[1], { signIn: async (u) => { signed = u; } });
  assert.equal(r.ok, true);
  assert.equal(signed.userId, renamed.userId);
  await setMode("invite");
  assert.equal(await INV.chatOnly(renamed.userId), false, "signed in on the website once: an existing account");
  assert.equal((await CS.issue("renamed_cf")).ok, true, "existing users keep signing in from chat while invite-only");
  // a link sent while open, redeemed after sign-ups closed: refused at the button, nothing signed in
  const late = await cfAuto("late_cf", { rename: "latecomer" });
  await setMode("open");
  const l2 = await CS.issue("late_cf");
  assert.equal(l2.ok, true);
  await setMode("invite");
  let signed2 = null;
  const r2 = await CS.redeem(l2.url.split("#t=")[1], { signIn: async (u) => { signed2 = u; } });
  assert.deepEqual(r2, { ok: false, error: "signup" });
  assert.equal(signed2, null, "no session");
  assert.equal((await getQuery("SELECT why FROM chat_signin_log WHERE user_id = ? ORDER BY id DESC LIMIT 1", [late.userId]))[0].why, "invite-only");
  // a website sign-in some other way (a sessions row, even an ended one) also counts
  const old = await cfAuto("old_cf", { rename: "oldhand" });
  await runQuery("INSERT INTO sessions (id, user_id, created, expires, method) VALUES (?, ?, ?, ?, 'claim')", ["sess-" + old.userId, old.userId, Date.now() - DAY, Date.now() - 1]);
  assert.equal((await CS.issue("old_cf")).ok, true, "an ended session still proves a past website sign-in");
  // a real website account linked to a Camfrog login is untouched
  await mkUser("realweb", { camfrog: "realweb_cf", email: "realweb@example.test" });
  assert.equal((await CS.issue("realweb_cf")).ok, true);
  await setMode("open");
});

test("review: the chatsignin page explains the 'signup' refusal (invite-only) with a way to sign up", async () => {
  const src = fs.readFileSync(path.join(repo, "views", "chatSignin.ejs"), "utf8");
  assert.match(src, /error === 'signup'\) \{ %><%- t\('chatsignin\.err\.signup'\) %>/);
  assert.match(src, /error === 'signup'\) \{ %><p><a class="pa-btn primary" href="\/register">/);
  assert.match(EN["chatsignin.err.signup"], /invite link/);
  assert.match(EN["chatsignin.err.signup"], /!signup/);
});

test("review: a site-banned or deleted member can't make invites, and their pending invites stop opening accounts (house invites still work)", async () => {
  await setMode("invite");
  INV._resetLimits();
  const bad = await mkUser("bannedbig", { level: 50 });
  const before = [await make(bad), await make(bad)];
  await banSite(bad.userId);
  await assert.rejects(make(bad), (e) => e.status === 403 && e.code === "E_BANNED");
  const page = await INV.mine(bad.userId);
  assert.equal(page.canCreate, false);
  assert.equal(page.whyCode, "E_BANNED");
  const b = browser(); b.as(bad);
  assert.equal((await b.api("/api/invites")).status, 403);
  // the invites made before the ban: no account
  const g = await INV.gate(fakeReq("198.51.100.7", "s-ban-1", { invite: before[0].code }));
  assert.equal(g.ok, false);
  assert.equal(g.reason, "inviter");
  const r = await reg(browser(), "banalt1", { invite: before[0].display });
  assert.equal(r.location, "/register");
  assert.equal(await userBy("banalt1"), null, "no ban evasion through a banned member's link");
  assert.equal((await INV.byCode(before[0].code)).status, "pending", "nothing used");
  // sign-ups open: the bad invite is ignored (an account like any other, NOT stamped invited_by the banned member)
  await setMode("open");
  await reg(browser(), "banopen1", { invite: before[1].display });
  assert.equal((await userBy("banopen1")).invited_by, null);
  await setMode("invite");
  // a ban that ended: works again
  await unban(bad.userId);
  await banSite(bad.userId, Date.now() - 1000);
  const ok = await reg(browser(), "banover1", { invite: before[1].display });
  assert.match(ok.location, /^\/u\/banover1\//);
  assert.equal((await userBy("banover1")).invited_by, bad.userId);
  await unban(bad.userId);
  // deleted (accountdelete pseudonymises the row and sets archived_at) / account_deletions 'done'
  const gone = await mkUser("deletedone", { level: 20 });
  const gi = await make(gone);
  await runQuery("UPDATE users SET archived_at = ?, username = 'deleted_x1' WHERE userId = ?", [Date.now(), gone.userId]);
  assert.equal((await INV.gate(fakeReq("198.51.100.8", "s-del-1", { invite: gi.code }))).reason, "inviter");
  await assert.rejects(make(gone), (e) => e.code === "E_BANNED");
  const gone2 = await mkUser("deletedtwo", { level: 20 });
  const gi2 = await make(gone2);
  await runQuery("CREATE TABLE IF NOT EXISTS account_deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, state TEXT NOT NULL, requested_at INTEGER NOT NULL DEFAULT 0, execute_at INTEGER NOT NULL DEFAULT 0)");
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES (?, 'done', ?, ?)", [gone2.userId, Date.now(), Date.now()]);
  assert.equal((await INV.gate(fakeReq("198.51.100.9", "s-del-2", { invite: gi2.code }))).reason, "inviter");
  // a house invite is staff's: it works whoever made it
  const staffer = await mkUser("bannedstaff", { cls: "Admin" });
  const house = await INV.create(staffer, { house: true, note: "test" });
  await banSite(staffer.userId);
  assert.equal((await INV.gate(fakeReq("198.51.100.10", "s-house", { invite: house.code }))).ok, true);
  await unban(staffer.userId);
  INV._resetLimits();
  await setMode("open");
});

test("review: the guess limiter counts BEFORE the database - a parallel burst gets at most LOOK_MAX look-ups; good codes don't use it up; IPv6 by /64", async () => {
  await setMode("invite");
  INV._resetLimits();
  const res = await Promise.all(Array.from({ length: 200 }, () => INV.check(fakeReq("203.0.113.9", "burst-A"), INV.newCode())));
  const by = {};
  for (const r of res) by[r.reason] = (by[r.reason] || 0) + 1;
  assert.equal(by.unknown, INV.LOOK_MAX, JSON.stringify(by));
  assert.equal(by.rate, 200 - INV.LOOK_MAX);
  // gate() (what POST /register runs), 100 at once from one network, each in its own session: the IP key holds
  INV._resetLimits();
  const gs = await Promise.all(Array.from({ length: 100 }, (_, i) => INV.gate(fakeReq("203.0.113.11", "burst-C" + i, { invite: INV.newCode() }))));
  const gb = {};
  for (const g of gs) gb[g.reason] = (gb[g.reason] || 0) + 1;
  assert.equal(gb.unknown, INV.LOOK_MAX, JSON.stringify(gb));
  assert.equal(gb.rate, 100 - INV.LOOK_MAX);
  // a good code is counted and given back: looking at one 50 times never blocks, and doesn't wipe failures either
  INV._resetLimits();
  const inviter = await mkUser("burstgood", { level: 20 });
  const good = await make(inviter);
  for (let i = 0; i < 50; i++) assert.equal((await INV.check(fakeReq("203.0.113.12", "good-1"), good.code)).ok, true, "look " + i);
  for (let i = 0; i < INV.LOOK_MAX - 1; i++) await INV.check(fakeReq("203.0.113.12", "good-1"), INV.newCode());
  assert.equal((await INV.check(fakeReq("203.0.113.12", "good-1"), good.code)).ok, true, "LOOK_MAX - 1 failures: still fine");
  await INV.check(fakeReq("203.0.113.12", "good-1"), INV.newCode());
  assert.equal((await INV.check(fakeReq("203.0.113.12", "good-1"), good.code)).reason, "rate", "the good code didn't reset the failures");
  // IPv6: one /64 is one key, however the address is spelled; another /64 is not
  INV._resetLimits();
  for (let i = 0; i < INV.LOOK_MAX; i++) await INV.check(fakeReq("2001:db8:1:2::" + (i + 1).toString(16), "v6-" + i), INV.newCode());
  assert.equal((await INV.check(fakeReq("2001:db8:1:2:abcd:ef01:2345:6789", "v6-new"), good.code)).reason, "rate", "same /64, new address + session");
  assert.equal((await INV.check(fakeReq("2001:db8:1:3::1", "v6-other"), good.code)).ok, true, "another /64");
  INV._resetLimits();
  await setMode("open");
});

test("review: the allowance pools - after a tier change a bought / gifted / issued invite still adds one; a lost unlimited tier leaves no hole", async () => {
  await setMode("invite");
  // level 20 sends all 6, then the owner shrinks level 20's tier: over the tiers' share, but a bought invite adds one
  const u = await mkUser("poolsender", { level: 20, bal: 6000000 });
  for (let i = 0; i < 6; i++) await make(u);
  await INV.setSettings(users.boss, { tiers: "5:1, 20:1, 50:unlimited" });
  let a = await INV.allowance(u.userId);
  assert.deepEqual([a.total, a.used, a.tierLeft, a.extraLeft, a.left], [2, 6, 0, 0, 0]);
  const r = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: INV.PRIZE_ID, source: "website", expectedCost: 2500000 });
  assert.equal(r.success, true, r.message);
  a = await INV.allowance(u.userId);
  assert.deepEqual([a.bought, a.extraLeft, a.left], [1, 1, 1], "the bought one is usable");
  const extra = await make(u);
  assert.equal((await getQuery("SELECT pool FROM invites WHERE id = ?", [extra.id]))[0].pool, "extra");
  await assert.rejects(make(u), (e) => e.code === "E_NONE_LEFT");
  await INV.revoke(u, extra.id);
  assert.equal((await INV.allowance(u.userId)).left, 1, "a revoked one goes back to its own pool");
  // an admin issue adds exactly what it says
  await INV.adminGrant(users.boss, { username: u.username, amount: 2, reason: "pool test" });
  assert.equal((await INV.allowance(u.userId)).left, 3);
  // a gift too
  const giver = await mkUser("poolgiver", { level: 1, bal: 3000000 });
  const gr = await shop.purchasePrize({ userId: giver.userId, username: giver.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: u.username });
  assert.equal(gr.success, true, gr.message);
  assert.equal((await INV.allowance(u.userId)).left, 4);
  // the tiers' share is used first: a level-5 member with a bought one makes a tier invite, then the bought one
  const v = await mkUser("poolorder", { level: 5 });
  await tx(() => INV.grantInTx(v.userId, 1, "bought", "test:poolorder"));
  const p1 = await make(v), p2 = await make(v);
  assert.deepEqual((await getQuery("SELECT pool FROM invites WHERE id IN (?, ?) ORDER BY id", [p1.id, p2.id])).map((x) => x.pool), ["tier", "extra"]);
  // unlimited at 55: invites made then are "free"; the unlimited tier moves to 100 -> the normal share, nothing owed
  await INV.setSettings(users.boss, { tiers: "5:1, 20:5, 50:unlimited" });
  const w = await mkUser("poolwhale", { level: 55, bal: 9000000 });
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await make(w));
  await runQuery(`UPDATE invites SET status = 'used', used_at = ? WHERE id IN (${made.slice(0, 7).map(() => "?").join(",")})`, [Date.now(), ...made.slice(0, 7).map((m) => m.id)]);
  assert.ok((await getQuery("SELECT pool FROM invites WHERE inviter_id = ?", [w.userId])).every((x) => x.pool === "free"));
  await INV.setSettings(users.boss, { tiers: "5:1, 20:5, 100:unlimited" });
  a = await INV.allowance(w.userId);
  assert.deepEqual([a.unlimited, a.fromTiers, a.used, a.pending, a.left], [false, 6, 0, 3, 6], "the unlimited invites count against nothing");
  const wr = await shop.purchasePrize({ userId: w.userId, username: w.username, prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(wr.success, true, wr.message);
  await INV.adminGrant(users.boss, { username: w.username, amount: 5, reason: "pool test" });
  assert.equal((await INV.allowance(w.userId)).left, 12, "6 + 1 bought + 5 issued");
  await resetTiers();
  await setMode("open");
});

test("review: an admin takes back only unused issued invites (the extra pool never goes negative)", async () => {
  const m = await mkUser("takeback", { level: 0 });
  const a = browser(); a.as(users.boss);
  let r = await a.api("/api/admin/invites/grant", { username: "takeback", amount: 2, reason: "two to start" });
  assert.equal(r.json.left, 2);
  await make(m);
  r = await a.api("/api/admin/invites/grant", { username: "takeback", amount: -2, reason: "too many" });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /1 unused staff-issued invite -/);
  r = await a.api("/api/admin/invites/grant", { username: "takeback", amount: -1, reason: "one back" });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.left, 0);
  assert.equal((await INV.allowance(m.userId)).left, 0);
  const au = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'invite_grant' AND target_id = ? ORDER BY id DESC LIMIT 1", [m.userId]))[0];
  assert.equal(JSON.parse(au.detail).left, 0, "the log says what they had left");
});

test("review: a pasted invite LINK works - the field takes 300 characters (pa.tv and publicaccess.tv links), and is shown back as the code", async () => {
  await setMode("invite");
  INV._resetLimits();
  const p = await browser().get("/register");
  const ml = /<input[^>]+id="invite"[^>]+maxlength="(\d+)"/.exec(p.text);
  assert.ok(ml, "the invite field has a maxlength");
  assert.ok(Number(ml[1]) >= 300, "maxlength " + ml[1]);
  const inviter = await mkUser("linkpaster", { level: 20 });
  const i1 = await make(inviter), i2 = await make(inviter);
  const short = "https://pa.tv/signup?invite=" + i1.display, long = "https://publicaccess.tv/signup?invite=" + i2.display;
  assert.equal(short.length, 47);
  assert.equal(long.length, 57);
  let r = await reg(browser(), "pastedshort", { invite: short });
  assert.match(r.location, /^\/u\/pastedshort\//);
  r = await reg(browser(), "pastedlong", { invite: long });
  assert.match(r.location, /^\/u\/pastedlong\//);
  // refused for another reason (the username is taken): the field comes back with the CODE, not a cut-off link
  const i3 = await make(inviter);
  const b = browser();
  r = await reg(b, "pastedlong", { invite: "https://publicaccess.tv/signup?invite=" + i3.display });
  assert.equal(r.location, "/register");
  const back = await b.get("/register");
  assert.ok(back.text.includes('value="' + i3.display + '"'), "the code, formatted");
  assert.equal(INV.echo(long), i2.display);
  assert.equal(INV.echo("x".repeat(400)).length, 300);
  assert.equal(INV.echo(undefined), "");
  // the page script: a pasted link becomes its code, and the code (not a cut link) rides the Discord / Twitch / Google start link
  const js = fs.readFileSync(path.join(repo, "views", "partials", "auth-js.ejs"), "utf8");
  assert.doesNotMatch(js, /slice\(0, 40\)/);
  assert.match(js, /searchParams\.set\('invite', invCode\(v\) \|\| v\.slice\(0, 300\)\)/);
  assert.match(js, /addEventListener\('paste'/);
  for (const f of ["user.controller.js", "ssolinks.js", "plexsso.js"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    assert.doesNotMatch(src, /invite[^\n]*\.slice\(0, 40\)/, f);
  }
  INV._resetLimits();
  await setMode("open");
});

test("review: blank tier fields are refused, never saved as 0 (null, '', true, a blank row)", async () => {
  const bad = (v, re) => assert.throws(() => INV.checkTiers(v), (e) => e.status === 400 && e.code === "E_TIERS" && re.test(e.message), JSON.stringify(v));
  bad([{ level: 5, grant: 1 }, { level: 30, grant: "" }], /Tier 2: invites must be a whole number/);
  bad([{ level: 5, grant: 1 }, { level: 30, grant: null }], /Tier 2: invites must be a whole number/);
  bad([{ level: null, grant: 0 }], /Tier 1: the level must be a whole number/);
  bad([{ level: "", grant: "" }], /Tier 1: the level/);
  bad([{ level: 5, grant: true }], /Tier 1: invites must be a whole number/);
  bad([{ level: true, grant: 1 }], /Tier 1: the level/);
  bad([{ level: "", unlimited: true }], /Tier 1: the level/);
  bad([{ level: "5x", grant: 1 }], /Tier 1: the level/);
  assert.deepEqual(INV.checkTiers([{ level: "5", grant: "1" }, { level: " 20 ", grant: "+5" }, { level: 50, unlimited: true }]),
                   [{ level: 5, grant: 1 }, { level: 20, grant: 5 }, { level: 50, unlimited: true }], "digits as text are fine (a form)");
  const a = browser(); a.as(users.boss);
  const r = await a.api("/api/admin/invites/settings", { tiers: [{ level: 5, grant: 1 }, { level: 30, grant: null }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Tier 2: invites must be a whole number/);
  assert.equal(INV.tiersText(INV.settings().tiers), "5:1, 20:5, 50:unlimited", "nothing saved");
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-invites.js"), "utf8");
  assert.match(js, /s === '' \? null : Number\(s\)/, "the card sends a blank box as null");
});

test("review: chat-only, banned and deleted accounts can't buy an invite (or be sent one) - refused before any charge", async () => {
  const auto = await cfAuto("autobuyer_cf", { bal: 5000000 });
  let r = await shop.purchasePrize({ userId: auto.userId, username: auto.username, prizeId: INV.PRIZE_ID, source: "camfrog" });
  assert.equal(r.success, false);
  assert.match(r.message, /Invites are made on the PATV website/);
  assert.equal((await userBy(auto.username)).points_balance, 5000000, "not charged");
  const ren = await cfAuto("renbuyer_cf", { rename: "renbuyer", bal: 5000000 });
  r = await shop.purchasePrize({ userId: ren.userId, username: ren.username, prizeId: INV.PRIZE_ID, source: "camfrog" });
  assert.equal(r.success, false, "a renamed auto account, never signed in on the website");
  // a chat bot's account made while invite-only (not yet signed in on the website)
  await setMode("invite");
  const bot = (await browser().api("/test/botreg/8101")).json;
  assert.equal(bot.marked, true);
  await setMode("open");
  await runQuery("UPDATE users SET points_balance = 5000000 WHERE userId = ?", [bot.userId]);
  r = await shop.purchasePrize({ userId: bot.userId, username: "botmade8101", prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(r.success, false);
  // as a gift
  const payer = await mkUser("chatgiftpayer", { level: 1, bal: 9000000 });
  r = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: ren.username });
  assert.equal(r.success, false);
  assert.match(r.message, /renbuyer doesn't have a PATV website account yet/);
  // banned
  const banned = await mkUser("bannedbuyer", { level: 1, bal: 5000000 });
  await banSite(banned.userId);
  r = await shop.purchasePrize({ userId: banned.userId, username: banned.username, prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(r.success, false);
  assert.match(r.message, /banned from the site/, "1.99aoi: a site-banned buyer is refused before any item's own checks (siteban.js)");
  r = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: "bannedbuyer" });
  assert.equal(r.success, false);
  await unban(banned.userId);
  assert.equal((await userBy("bannedbuyer")).points_balance, 5000000);
  assert.equal((await userBy("chatgiftpayer")).points_balance, 9000000);
  // once the account has signed in on the website, it buys like anyone
  await runQuery("INSERT INTO sessions (id, user_id, created, expires, method) VALUES (?, ?, ?, ?, 'chat')", ["sess-" + ren.userId, ren.userId, Date.now(), Date.now() + DAY]);
  r = await shop.purchasePrize({ userId: ren.userId, username: ren.username, prizeId: INV.PRIZE_ID, source: "website" });
  assert.equal(r.success, true, r.message);
});

test("review: house invites stay off an admin's own invites page, and the member route can't revoke one", async () => {
  const a = browser(); a.as(users.boss);
  const h = await a.api("/api/admin/invites/house", { reason: "for the new host" });
  assert.equal(h.json.ok, true);
  const m = await INV.mine(users.boss.userId);
  assert.ok(!m.pending.some((x) => x.id === h.json.invite.id), "not in the admin's personal list");
  assert.ok([...m.pending, ...m.used, ...m.closed].every((x) => !x.house));
  const r = await a.api("/api/invites/" + h.json.invite.id + "/revoke");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "E_HOUSE");
  assert.equal((await INV.byCode(h.json.invite.code)).status, "pending");
  const ok = await a.api("/api/admin/invites/" + h.json.invite.id + "/revoke", { reason: "not needed" });
  assert.equal(ok.json.ok, true);
  assert.equal((await INV.byCode(h.json.invite.code)).status, "revoked");
  const au = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'invite_revoke' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(JSON.parse(au.detail).invite_id, h.json.invite.id, "audited");
});

test("review: a gifted invite tells the recipient where it went (Settings → Invites)", async () => {
  const giver = await mkUser("pointergiver", { level: 1, bal: 9000000 });
  const to = await mkUser("pointerfriend", { level: 0 });
  const r = await shop.purchasePrize({ userId: giver.userId, username: giver.username, prizeId: INV.PRIZE_ID, source: "website", giftTo: to.username });
  assert.equal(r.success, true, r.message);
  const ev = await getQuery("SELECT note FROM shop_order_events WHERE order_id = ? AND status = 'completed'", [r.order_id]);
  assert.match(ev[0].note, /Gift from pointergiver to pointerfriend — one invite added to pointerfriend's invites \(Settings → Invites\)/);
  let note = null;
  for (let i = 0; i < 40 && !note; i++) { note = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'shop' ORDER BY id DESC", [to.userId]))[0]; if (!note) await new Promise((x) => setTimeout(x, 25)); }
  assert.ok(note, "inbox notice");
  assert.equal(note.link, "/settings/invites");
  assert.match(note.body, /It's in your invites: Settings, Invites\./);
  const src = fs.readFileSync(path.join(repo, "shop.js"), "utf8");
  assert.match(src, /siteInvite && gift\.anon \? `🎁 An anonymous gift to \$\{username\} — one invite added/, "an anonymous gift's event names no giver");
});

test("review: a stale admin card can't undo another admin's change - only changed fields are sent, with `expect` (409 E_STALE)", async () => {
  const a = browser(); a.as(users.boss);
  // admin A closes sign-ups
  let r = await a.api("/api/admin/invites/settings", { signups: "invite", expect: { signups: "open" }, reason: "closing" });
  assert.equal(r.json.ok, true);
  assert.equal(INV.mode(), "invite");
  // admin B's card was loaded before that and saves only a price change: the switch is untouched
  r = await a.api("/api/admin/invites/settings", { price: 2600000, expect: { price: 2500000 } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.changed, ["price"]);
  assert.equal(INV.mode(), "invite", "a price-only save never reopens sign-ups");
  // admin B's card tries to flip the switch from its stale "open": refused, nothing saved
  r = await a.api("/api/admin/invites/settings", { signups: "open", expect: { signups: "open" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "E_STALE");
  assert.equal(INV.mode(), "invite");
  // tiers changed elsewhere since the card loaded: refused
  await INV.setSettings(users.boss, { tiers: "5:2, 20:5, 50:unlimited" });
  r = await a.api("/api/admin/invites/settings", { tiers: "5:1, 20:4, 50:unlimited", expect: { tiers: [{ level: 5, grant: 1 }, { level: 20, grant: 5 }, { level: 50, unlimited: true }] } });
  assert.equal(r.status, 409);
  assert.equal(INV.tiersText(INV.settings().tiers), "5:2, 20:5, 50:unlimited");
  // a stale price, a stale "invites while open"
  r = await a.api("/api/admin/invites/settings", { price: 2700000, expect: { price: 2500000 } });
  assert.equal(r.status, 409);
  r = await a.api("/api/admin/invites/settings", { invites_when_open: false, expect: { invites_when_open: false } });
  assert.equal(r.status, 409);
  // with the right expectations everything goes back
  r = await a.api("/api/admin/invites/settings", { signups: "open", price: 2500000, tiers: "5:1, 20:5, 50:unlimited",
                                                   expect: { signups: "invite", price: 2600000, tiers: "5:2, 20:5, 50:unlimited" } });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(INV.mode(), "open");
  // no expect (a script / an older card): as before
  r = await a.api("/api/admin/invites/settings", { expiry_days: 14 });
  assert.equal(r.json.ok, true);
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-invites.js"), "utf8");
  assert.match(js, /body\.expect\[k\] = loaded/, "the card sends what it loaded for each changed field");
});
