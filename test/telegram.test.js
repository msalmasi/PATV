// The Telegram bridge, site side (telegram.js, 1.99kn): linking by a one-time code sent to the bot (hashed, once,
// 10 minutes, never by username; a Telegram account linked elsewhere is refused), the access tiers (none / alerts /
// full = Season Pass; banned or archived = none), the alert fan-out (inbox notices per kind with defaults, DMs with
// the preview rule, the grace window and read-on-site cancel, the hourly cap), claim / ack (a blocked bot pauses the
// link until they write again), the "tg." strings for Pepe, and the routes (same-site user API, bot-token bot API).
//   node --test test/telegram.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token-test";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const TG = require(path.join(repo, "telegram"));
const premium = require(path.join(repo, "premium"));

let T = Date.parse("2026-10-10T15:00:00Z");
TG._setClock(() => T);
const outbox = (uid) => getQuery("SELECT * FROM telegram_outbox WHERE user_id = ? ORDER BY id", [uid]);
const settle = () => new Promise((r) => setTimeout(r, 60));     // onNotice / onDm are fire-and-forget

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 5)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER,
                  until INTEGER, PRIMARY KEY (user_id, room_id))`);
  const add = (id, u, cf, extra = {}) => runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, archived_at) VALUES (?, ?, ?, 'x', ?, ?)",
    [id, u, u.toUpperCase(), cf, extra.archived || null]);
  await add("u_alice", "alice", "alicecf");          // Season Pass
  await add("u_bob", "bob", "bobcf");                // linked, no pass -> alerts
  await add("u_carol", "carol", null);               // banned from the site
  await add("u_dan", "dan", null);
  await add("u_old", "olduser", null, { archived: 1 });
  await add("u_auto", "CFab12cd34", "autocf");       // a Pepe auto account
  await inbox.ready;
  await TG.init();
  await premium.init();
  await runQuery("INSERT INTO premium_subs (tier, target, comped, started, updated) VALUES ('season_pass', 'u_alice', 1, ?, ?)", [T, T]);
  await premium.loadCache();
  await runQuery("INSERT INTO feed_bans (user_id, room_id, reason, at, until) VALUES ('u_carol', '', 'spam', ?, NULL)", [T]);
  await TG.setMeta("bot_username", "PepeTestBot");
});

test("codes: random, hashed at rest, deep link, one live code per account, rate limited", async () => {
  const a = await TG.makeCode("u_bob");
  assert.match(a.code, /^[A-Z2-9]{10}$/);
  assert.equal(a.deepLink, `https://t.me/PepeTestBot?start=${a.code}`);
  const rows = await getQuery("SELECT * FROM telegram_codes WHERE user_id = 'u_bob'");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].code_hash, a.code, "only the hash is stored");
  const b = await TG.makeCode("u_bob");
  assert.equal((await getQuery("SELECT * FROM telegram_codes WHERE user_id = 'u_bob' AND used_at IS NULL")).length, 1, "the older code stops working");
  await assert.rejects(TG.link({ code: a.code, tg_id: "111" }), (e) => e.code === "E_CODE_INVALID", "replaced code refused");
  await assert.rejects(TG.makeCode("u_carol"), (e) => e.code === "E_BANNED", "banned: no code");
  for (let i = 0; i < 6; i++) await TG.makeCode("u_dan");
  await assert.rejects(TG.makeCode("u_dan"), (e) => e.code === "E_RATE", "6 codes an hour");
  await runQuery("DELETE FROM telegram_codes WHERE user_id = 'u_dan'");
  assert.ok(b.code);
});

test("link: the code proves it, works once, expires, never steals a Telegram account; a security notice", async () => {
  const c = await TG.makeCode("u_bob");
  await assert.rejects(TG.link({ code: "NOTACODE!!", tg_id: "222" }), (e) => e.code === "E_CODE_INVALID");
  await assert.rejects(TG.link({ code: c.code, tg_id: "abc" }), (e) => e.code === "E_BAD");
  const r = await TG.link({ code: c.code.toLowerCase(), tg_id: "222", handle: "@bob_tg" });
  assert.equal(r.username, "bob"); assert.equal(r.tier, "alerts");
  const l = await TG.linkOf("u_bob");
  assert.equal(l.tg_id, "222"); assert.equal(l.handle, "bob_tg"); assert.equal(l.link_source, "self"); assert.equal(l.proof, "start_code");
  await assert.rejects(TG.link({ code: c.code, tg_id: "222" }), (e) => e.code === "E_CODE_INVALID", "once only");
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = 'u_bob' AND kind = 'system'");
  assert.equal(n.length, 1, "security notice filed");
  // expired
  const e = await TG.makeCode("u_alice");
  T += TG.CODE_TTL_MS + 1000;
  await assert.rejects(TG.link({ code: e.code, tg_id: "333" }), (x) => x.code === "E_CODE_EXPIRED");
  // a Telegram account already linked to bob can't be taken by alice
  const f = await TG.makeCode("u_alice");
  await assert.rejects(TG.link({ code: f.code, tg_id: "222" }), (x) => x.code === "E_TG_TAKEN");
  assert.equal((await TG.linkOf("u_bob")).tg_id, "222", "bob keeps it");
  const g = await TG.makeCode("u_alice");
  const ra = await TG.link({ code: g.code, tg_id: "333", handle: "alice_tg" });
  assert.equal(ra.tier, "full", "Season Pass = full");
});

test("whois: tiers, minimal fields, banned / archived / auto accounts", async () => {
  assert.deepEqual(await TG.whois({ tg_id: "999" }), { linked: false });
  const a = await TG.whois({ tg_id: "333" });
  assert.equal(a.tier, "full");
  assert.deepEqual(Object.keys(a.user).sort(), ["camfrog", "display", "username"]);
  assert.equal(a.user.camfrog, "alicecf");
  const b = await TG.whois({ tg_id: "222" });
  assert.equal(b.tier, "alerts");
  // a site ban after linking: no bridge at all
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES ('u_carol', '444', ?)", [T]);
  const c = await TG.whois({ tg_id: "444" });
  assert.equal(c.tier, "none"); assert.equal(c.user, undefined);
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES ('u_old', '555', ?)", [T]);
  assert.equal((await TG.whois({ tg_id: "555" })).tier, "none", "archived");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES ('u_auto', '666', ?)", [T]);
  assert.equal((await TG.whois({ tg_id: "666" })).user.camfrog, null, "an auto CF account never passes a Camfrog login");
});

test("alerts: inbox notices fan out by kind (defaults + switches), never for banned / unlinked", async () => {
  await inbox.add("u_bob", { kind: "tip", title: "💸 alice tipped you PAT 500", ref: "tip-1", link: "/history" });
  await inbox.add("u_bob", { kind: "staking", title: "Your stake settled", ref: "stk-1" });           // economy: opt-in
  await inbox.add("u_dan", { kind: "tip", title: "tip for dan", ref: "tip-d" });                    // not linked
  await inbox.add("u_carol", { kind: "tip", title: "tip for carol", ref: "tip-c" });                // banned
  await settle();
  let ob = await outbox("u_bob");
  assert.equal(ob.length, 1);
  assert.equal(ob[0].kind, "tip");
  assert.match(ob[0].text, /alice tipped you PAT 500/);
  assert.match(ob[0].text, /https:\/\/publicaccess\.tv\/history/);
  assert.equal((await outbox("u_dan")).length, 0);
  assert.equal((await outbox("u_carol")).length, 0);
  await TG.setPrefs("u_bob", { staking: true, tip: false, bogus: true });
  const p = await TG.prefs("u_bob");
  assert.equal(p.find((k) => k.key === "staking").on, true);
  assert.equal(p.find((k) => k.key === "tip").on, false);
  assert.ok(!p.find((k) => k.key === "bogus"));
  await inbox.add("u_bob", { kind: "staking", title: "Monday epoch: you earned PAT 1,200", ref: "stk-2" });
  await inbox.add("u_bob", { kind: "tip", title: "another tip", ref: "tip-2" });
  await inbox.add("u_bob", { kind: "staking", title: "Monday epoch: you earned PAT 1,200", ref: "stk-2" });   // duplicate notice
  await settle();
  ob = await outbox("u_bob");
  assert.deepEqual(ob.map((o) => o.kind), ["tip", "staking"]);
  assert.equal(TG.DEFAULT_ON.has("dm") && TG.DEFAULT_ON.has("mention") && !TG.DEFAULT_ON.has("staking"), true);
  assert.equal((await TG.prefs("u_alice")).find((k) => k.key === "golive" || k.key === "follow").on, true);
});

test("DM alerts: preview rule, one per conversation per gap, due after the grace, dropped once read", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
                  joined_at INTEGER NOT NULL DEFAULT 0, last_read_id INTEGER NOT NULL DEFAULT 0, cleared_id INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
                  left_at INTEGER, PRIMARY KEY (conversation_id, user_id))`);
  await runQuery("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES ('c1', 'u_alice'), ('c2', 'u_alice')");
  await runQuery("DELETE FROM telegram_outbox");
  TG.onDm("u_alice", { conversationId: "c1", messageId: 10, from: "Bob", text: "are you coming tonight?" });
  TG.onDm("u_alice", { conversationId: "c1", messageId: 11, from: "Bob", text: "hello??" });     // same 10-minute bucket
  TG.onDm("u_alice", { conversationId: "c2", messageId: 20, from: "Pepe", text: "ribbit" });
  // 1.99py: onDm is fire-and-forget - wait for its rows (up to 5 s) instead of a fixed 60 ms (flaky on a busy machine)
  const until = async (n) => { let r = []; for (const end = Date.now() + 5000; Date.now() < end; await settle()) { r = await outbox("u_alice"); if (r.length >= n) break; } return r; };
  const ob = await until(2);
  assert.equal(ob.length, 2);
  const c1 = ob.find((o) => o.ref.startsWith("dm:c1:"));
  assert.match(c1.text, /New message from Bob/);
  assert.match(c1.text, /are you coming tonight/, "the first message of the burst");
  assert.equal(c1.due_at, T + TG.DM_GRACE_MS);
  assert.equal((await TG.claim({})).filter((a) => a.chat_id === "333").length, 0, "not before the grace window");
  await runQuery("UPDATE conversation_members SET last_read_id = 10 WHERE conversation_id = 'c1' AND user_id = 'u_alice'");   // read on the site
  T += TG.DM_GRACE_MS + 1;
  const got = await TG.claim({});
  const mine = got.filter((a) => a.chat_id === "333");
  assert.equal(mine.length, 1, "the read one is dropped");
  assert.match(mine[0].text, /ribbit/);
  // previews off: who, not what
  await runQuery("CREATE TABLE IF NOT EXISTS dm_prefs (user_id TEXT PRIMARY KEY, who TEXT NOT NULL DEFAULT 'everyone', alert_preview INTEGER NOT NULL DEFAULT 1, updated INTEGER)");
  await runQuery("INSERT OR REPLACE INTO dm_prefs (user_id, who, alert_preview) VALUES ('u_alice', 'everyone', 0)");
  T += TG.DM_GAP_MS;
  const had = (await outbox("u_alice")).length;
  TG.onDm("u_alice", { conversationId: "c1", messageId: 12, from: "Bob", text: "secret stuff" });
  const last = (await until(had + 1)).pop();
  assert.doesNotMatch(last.text, /secret stuff/);
  assert.match(last.text, /New message from Bob/);
});

test("claim / ack: once each, blocked pauses until they write, retries, hourly cap", async () => {
  await runQuery("DELETE FROM telegram_outbox");
  T += 3600e3;
  assert.equal(await TG.queue("u_bob", { kind: "staking", text: "one", ref: "r1" }), true);
  assert.equal(await TG.queue("u_bob", { kind: "staking", text: "one again", ref: "r1" }), false, "same ref once");
  const a = await TG.claim({});
  assert.equal(a.length, 1); assert.equal(a[0].chat_id, "222");
  assert.equal((await TG.claim({})).length, 0, "claimed: not handed out twice");
  await TG.ack({ failed: [{ id: a[0].id, blocked: true }] });
  assert.equal((await TG.linkOf("u_bob")).paused, 1);
  assert.equal((await TG.claim({})).length, 0, "paused");
  await TG.whois({ tg_id: "222", seen: true });
  const b = await TG.claim({});
  assert.equal(b.length, 1, "resumed after they wrote to the bot");
  await TG.ack({ sent: [b[0].id] });
  assert.ok((await getQuery("SELECT sent_at FROM telegram_outbox WHERE id = ?", [b[0].id]))[0].sent_at);
  T += 3600e3;
  let n = 0;
  for (let i = 0; i < TG.HOUR_MAX + 5; i++) n += (await TG.queue("u_bob", { kind: "staking", text: "x" + i, ref: "cap" + i })) ? 1 : 0;
  assert.equal(n, TG.HOUR_MAX);
});

test("unlink (site and Telegram side) drops the link and what's waiting", async () => {
  assert.equal(await TG.unlinkTg("222"), true);
  assert.equal(await TG.linkOf("u_bob"), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM telegram_outbox WHERE user_id = 'u_bob' AND sent_at IS NULL"))[0].n, 0);
  assert.deepEqual(await TG.whois({ tg_id: "222" }), { linked: false });
});

test("strings: the tg. keys for Pepe, English filled in", () => {
  const s = TG.strings("de");
  assert.ok(s.s["tg.welcome"]);
  assert.ok(Object.keys(s.s).every((k) => k.startsWith("tg.")));
  assert.equal(TG.strings("xx").lang, "en");
});

test("routes: page, same-site user API, bot API needs the bot token", async () => {
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const isBotToken = (t) => t === process.env.TWITCH_BOT_TOKEN;
  TG.register(app, { isBotToken, addUser });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, user, hdr = {}) => {
    const h = { "X-Requested-With": "fetch", ...hdr };
    if (user) h["x-test-user"] = user;
    if (body) h["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) { d = txt; }
    return { status: r.status, d };
  };
  try {
    assert.equal((await call("GET", "/settings/telegram", null, null)).status, 302);
    const page = await call("GET", "/settings/telegram", null, "u_dan");
    assert.equal(page.status, 200);
    assert.match(page.d, /id="tgBoot"/);
    assert.equal((await call("GET", "/api/telegram", null, null)).status, 401);
    assert.equal((await call("POST", "/api/telegram/code", {}, "u_dan", { Origin: "https://evil.example" })).status, 403);
    const code = await call("POST", "/api/telegram/code", {}, "u_dan");
    assert.equal(code.status, 200); assert.match(code.d.code, /^[A-Z2-9]{10}$/);
    assert.equal((await call("POST", "/api/telegram/link", { code: code.d.code, tg_id: "777" })).status, 403, "bot token required");
    const ln = await call("POST", "/api/telegram/link", { password: "bot-token-test", code: code.d.code, tg_id: "777", handle: "dan_tg" });
    assert.equal(ln.status, 200); assert.equal(ln.d.username, "dan"); assert.equal(ln.d.tier, "alerts");
    const bad = await call("POST", "/api/telegram/link", { password: "bot-token-test", code: code.d.code, tg_id: "777" });
    assert.equal(bad.status, 404); assert.equal(bad.d.code, "E_CODE_INVALID");
    const who = await call("POST", "/api/telegram/whois", { password: "bot-token-test", tg_id: "777" });
    assert.equal(who.d.user.username, "dan");
    const st = await call("GET", "/api/telegram", null, "u_dan");
    assert.equal(st.d.linked, true); assert.equal(st.d.handle, "dan_tg"); assert.equal(st.d.pass, false);
    const pr = await call("POST", "/api/telegram/prefs", { on: { lotto: true } }, "u_dan");
    assert.equal(pr.d.prefs.find((k) => k.key === "lotto").on, true);
    const tst = await call("POST", "/api/telegram/test", {}, "u_dan");
    assert.equal(tst.d.queued, true);
    const cl = await call("POST", "/api/telegram/outbox/claim", { password: "bot-token-test" });
    assert.ok(cl.d.alerts.some((a) => a.chat_id === "777"));
    assert.equal((await call("POST", "/api/telegram/hello", { password: "nope", bot_username: "X_bot" })).status, 403);
    assert.equal((await call("POST", "/api/telegram/hello", { password: "bot-token-test", bot_username: "PepeFrogBot" })).status, 200);
    assert.equal(await TG.botUsername(), "PepeFrogBot");
    const un = await call("POST", "/api/telegram/unlink", {}, "u_dan");
    assert.equal(un.d.linked, false);
  } finally { server.close(); }
});
