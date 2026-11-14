// Offline tests for 1.99anv's 👥 All members table (members.js, /admin/users#members):
//   * the capability (accounts.members, Admin by default): signed out 401, a member / Staff 403, an Admin 200; the card + its nav link
//     render only for someone who holds it
//   * server-side paging (50 a page), newest first by default; sort by created / last seen / level / username, both directions
//   * search by username, display name and Camfrog login (any case; % and _ literal)
//   * the filters (all / website / chat-only / banned / deleted) and the counts (total, website, chat-only, new in 7 / 30 days)
//   * chat-only = Pepe's Camfrog auto accounts + the Twitch / Discord bots' accounts nobody signed in to on the website (invites.chatOnly)
//   * the columns: sign-in methods, invited by, status badges, last seen from sessions / welcome_activity
//   * privacy: no email, IP or device in the answer; the sort indexes exist
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/members.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "members-test-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "auto_source TEXT", "invited_by TEXT", "invite_id INTEGER"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
let runQuery, getQuery, M, server, base;
const get = (p, u) => fetch(base + p, { redirect: "manual", headers: { "x-user": u || "" } });
const api = async (q, u = "adm") => { const r = await get("/api/admin/members" + (q ? "?" + q : ""), u); return { status: r.status, j: await r.json() }; };

async function mk(id, name, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, level, xp, camfrogUsername, discordId, twitchId, created_at,
                  auto_source, password_set, archived_at, invited_by, twitchLogin) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, name, o.dn === undefined ? name : o.dn, o.email === undefined ? id + "@example.com" : o.email, o.cls || "pleb", o.level || 0, o.xp || 0,
                  o.cf || null, o.discord || null, o.twitch || null, iso(NOW - (o.age == null ? 100 : o.age) * DAY), o.auto || null,
                  o.pw === undefined ? null : o.pw, o.archived || null, o.invitedBy || null, o.twitchLogin || null]);
}

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  M = require(path.join(repo, "members"));
  M._setClock(() => NOW);
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "accountdelete")).init();
  await require(path.join(repo, "invites")).init();
  // staff + plain website members
  await mk("adm", "boss", { cls: "Admin", age: 400, level: 60, pw: 1 });
  await mk("stf", "staffer", { cls: "Staff", age: 300, level: 30 });
  await mk("web1", "alice", { dn: "Alice A", age: 2, level: 7, pw: 1, invitedBy: "adm" });
  await mk("web2", "bob_100%", { age: 20, level: 3 });
  // a Google sign-up (random password), a Telegram one, a Plex one
  await mk("sso1", "gina", { email: null, pw: 0, age: 5, level: 1 });
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, proof, linked_at) VALUES ('google', 'g-1', 'sso1', 'oidc', ?)", [NOW]);
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, proof, linked_at) VALUES ('apple', 'a-1', 'sso1', 'oidc', ?)", [NOW]);
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, link_source, proof, linked_at) VALUES ('sso1', '777', 'self', 'login_widget', ?)", [NOW]).catch(async () => {
    await runQuery("INSERT INTO telegram_links (user_id, tg_id) VALUES ('sso1', '777')");
  });
  // Pepe's Camfrog auto accounts: one never signed in (chat-only), one claimed on the website (a session) - and one renamed but still auto
  await mk("cf1", "CFab12cd34", { email: "zzrandom", auto: "camfrog", cf: "froggy_login", dn: "Froggy", age: 40, level: 12 });
  await mk("cf2", "CFzz99yy88", { email: "zzrandom2", auto: "camfrog", cf: "claimed_login", age: 45, level: 2 });
  await runQuery("INSERT INTO sessions (id, user_id, created, last_seen, expires, ip, device, method) VALUES ('s-cf2', 'cf2', ?, ?, ?, '10.9.8.7', 'Chrome on Windows', 'chat')", [NOW - 3 * DAY, NOW - 3 * DAY, NOW + 80 * DAY]);
  await mk("cf3", "renamed_frog", { email: "zzrandom3", auto: "camfrog", cf: "renamed_login", age: 50 });
  // the Twitch / Discord bots' accounts: one Twitch-bot never signed in, one Discord-bot that signed in with Discord on the website
  await mk("tw1", "twitchy", { email: "nonsense", twitch: "tw-1", age: 10, level: 4 });
  await runQuery("INSERT INTO welcome_bonus (userId, state, created, source) VALUES ('tw1', 'pending', ?, 'twitch-bot')", [NOW - 10 * DAY]);
  await mk("dc1", "discordo", { email: "nonsense2", discord: "dc-1", age: 11, level: 4 });
  await runQuery("INSERT INTO welcome_bonus (userId, state, created, source) VALUES ('dc1', 'pending', ?, 'discord-bot')", [NOW - 11 * DAY]);
  await runQuery("INSERT INTO sessions (id, user_id, created, last_seen, expires, method) VALUES ('s-dc1', 'dc1', ?, ?, ?, 'discord')", [NOW - DAY, NOW - 3600e3, NOW + 89 * DAY]);
  // a Twitch-bot account made while sign-ups were invite-only (invite_shadow) whose owner signed in with Twitch before sessions (twitchLogin)
  await mk("tw2", "shadowy", { email: "nonsense3", twitch: "tw-2", age: 1, twitchLogin: "shadowy" });
  await runQuery("INSERT INTO invite_shadow (user_id, source, created) VALUES ('tw2', 'twitch-bot', ?)", [NOW - DAY]);
  // banned, deleted, archived, a deletion scheduled
  await mk("ban1", "naughty", { age: 60 });
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, at, until) VALUES ('ban1', '', 'naughty', 'spam', ?, NULL)", [NOW - DAY]);
  await mk("ban2", "was_banned", { age: 61 });
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, at, until) VALUES ('ban2', '', 'was_banned', 'spam', ?, ?)", [NOW - 9 * DAY, NOW - DAY]);
  await mk("ban3", "pad_banned", { age: 62 });
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, at, until) VALUES ('ban3', 'room-1', 'pad_banned', 'spam', ?, NULL)", [NOW - DAY]);
  await mk("del1", "deleted_7f3a", { email: null, archived: NOW - DAY, age: 200 });
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, done_at) VALUES ('del1', 'done', ?, ?, ?)", [NOW - 9 * DAY, NOW - DAY, NOW - DAY]);
  await mk("arc1", "dusty", { archived: NOW - 30 * DAY, age: 500 });
  await mk("dl2", "leaving_soon", { age: 70 });
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES ('dl2', 'scheduled', ?, ?)", [NOW - DAY, NOW + 6 * DAY]);
  // last seen: web2 via welcome_activity only, web1 via a session (newer than its welcome day)
  await runQuery("INSERT INTO welcome_activity (userId, day) VALUES ('web2', '2026-11-10')");
  await runQuery("INSERT INTO sessions (id, user_id, created, last_seen, expires, ip, method) VALUES ('s-w1', 'web1', ?, ?, ?, '203.0.113.9', 'password')", [NOW - 2 * DAY, NOW - 600e3, NOW + 89 * DAY]);
  await runQuery("INSERT INTO welcome_activity (userId, day) VALUES ('web1', '2026-11-01')");

  const express = require("express");
  const app = express();
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  M.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const names = (j) => j.rows.map((r) => r.username);
const row = (j, n) => j.rows.find((r) => r.username === n);

test("admins only: signed out 401, a member and Staff 403, an Admin 200", async () => {
  assert.equal((await api("", "")).status, 401);
  assert.equal((await api("", "web1")).status, 403);
  assert.equal((await api("", "stf")).status, 403, "Staff don't hold accounts.members by default");
  const a = await api();
  assert.equal(a.status, 200);
  assert.equal(a.j.ok, true);
  assert.equal(a.j.account_links, true, "an Admin's names link to Account security");
});

test("newest first by default, 50 a page, paged on the server", async () => {
  const { j } = await api();
  assert.equal(j.sort, "created"); assert.equal(j.dir, "desc"); assert.equal(j.per, 50);
  const created = j.rows.map((r) => r.created);
  for (let i = 1; i < created.length; i++) assert.ok(created[i - 1] >= created[i], "newest first");
  assert.equal(j.rows[0].username, "shadowy", "1 day old");
  assert.equal(j.rows[1].username, "alice", "2 days old");
  assert.equal(j.rows[0].created, NOW - DAY);
  // 60 more accounts -> 3 pages of 50
  for (let i = 0; i < 60; i++) await mk("bulk" + i, "bulk_" + String(i).padStart(2, "0"), { age: 1000 + i, level: i % 7 });
  const p1 = (await api("page=1")).j, p2 = (await api("page=2")).j, p3 = (await api("page=3")).j;
  assert.equal(p1.total, 77, "17 accounts above + 60");
  assert.equal(p1.pages, 2);
  assert.equal(p1.rows.length, 50); assert.equal(p2.rows.length, 27);
  assert.equal(p3.page, 2, "a page past the end is the last page");
  assert.equal(new Set([...names(p1), ...names(p2)]).size, 77, "no account twice, none missing");
  assert.equal(p2.rows[p2.rows.length - 1].username, "bulk_59", "the oldest last");
  const asc = (await api("dir=asc")).j;
  assert.equal(asc.rows[0].username, "bulk_59", "oldest first the other way round");
});

test("sort by username, level and last seen, both directions", async () => {
  const u = (await api("sort=username")).j;
  assert.equal(u.dir, "asc", "names A-Z by default");
  const un = names(u);
  for (let i = 1; i < un.length; i++) assert.ok(un[i - 1].toLowerCase() <= un[i].toLowerCase(), un[i - 1] + " <= " + un[i]);
  assert.equal(un[0], "alice");
  const ud = (await api("sort=username&dir=desc")).j;
  assert.equal(ud.rows[0].username, "was_banned");
  const l = (await api("sort=level")).j;
  assert.equal(l.rows[0].username, "boss", "level 60 first");
  assert.equal(l.rows[1].username, "staffer");
  const la = (await api("sort=level&dir=asc")).j;
  assert.equal(la.rows[0].level, 0);
  const s = (await api("sort=seen")).j;
  assert.deepEqual(names(s).slice(0, 4), ["alice", "discordo", "CFzz99yy88", "bob_100%"], "the newest website activity first; never-seen last");
  assert.equal(row(s, "alice").seen, NOW - 600e3, "the session's last_seen (newer than its welcome day)");
  assert.equal(row(s, "bob_100%").seen, Date.UTC(2026, 10, 10), "a welcome_activity day when there's no session");
  assert.equal(row(s, "twitchy").seen, null);
  const sa = (await api("sort=seen&dir=asc")).j;
  assert.equal(sa.rows[0].username, "bob_100%", "the oldest seen first; never-seen still last");
  assert.equal(sa.rows[sa.rows.length - 1].seen, null);
  const bad = (await api("sort=email&dir=sideways")).j;
  assert.equal(bad.sort, "created"); assert.equal(bad.dir, "desc");
});

test("search: username, display name, Camfrog login - any case, % and _ literal", async () => {
  assert.deepEqual(names((await api("q=ALIC")).j), ["alice"]);
  assert.deepEqual(names((await api("q=" + encodeURIComponent("alice a"))).j), ["alice"], "the display name");
  assert.deepEqual(names((await api("q=FROGGY_LOG")).j), ["CFab12cd34"], "the Camfrog login");
  assert.deepEqual(names((await api("q=" + encodeURIComponent("100%"))).j), ["bob_100%"], "% is literal");
  assert.equal((await api("q=" + encodeURIComponent("b_1"))).j.rows.length, 1, "_ is literal (bob_100% only, not bulk_1x)");
  assert.equal((await api("q=" + encodeURIComponent("@alice"))).j.rows.length, 1, "a leading @ is dropped");
  assert.equal((await api("q=nobody_here")).j.total, 0);
  const longQ = "x".repeat(500);
  assert.equal((await api("q=" + longQ)).j.q.length, 64);
});

test("filters + counts: website, chat-only (Pepe's + the bots' accounts nobody signed in to), banned, deleted", async () => {
  const all = (await api()).j;
  const c = all.counts;
  assert.equal(c.total, 77);
  assert.deepEqual(names((await api("filter=chat&sort=username")).j), ["CFab12cd34", "renamed_frog", "twitchy"],
                   "the never-signed-in auto account, the renamed auto account, the Twitch-bot account");
  assert.equal(c.chat, 3);
  assert.equal(c.deleted, 1);
  assert.equal(c.website, 77 - 3 - 1);
  const web = names((await api("filter=website&page=1")).j).concat(names((await api("filter=website&page=2")).j));
  for (const n of ["CFzz99yy88", "discordo", "shadowy", "gina", "alice"]) assert.ok(web.includes(n), n + " is a website account (signed in on the website)");
  assert.ok(!web.includes("deleted_7f3a"));
  assert.deepEqual(names((await api("filter=banned")).j), ["naughty"], "a running site ban only (not an ended one, not a pad ban)");
  assert.equal(c.banned, 1);
  assert.deepEqual(names((await api("filter=deleted")).j), ["deleted_7f3a"]);
  // new in the last 7 / 30 days: shadowy (1), alice (2), gina (5) / + twitchy (10), discordo (11), bob (20)
  assert.equal(c.new7, 3);
  assert.equal(c.new30, 6);
  assert.equal((await api("filter=nonsense")).j.filter, "all");
  // the counts don't follow the filter / search
  assert.deepEqual((await api("filter=chat&q=frog")).j.counts, c);
});

test("columns: sign-in methods, invited by, status badges, chat source", async () => {
  const j = (await api("sort=username&dir=asc&page=1")).j;
  const all = j.rows.concat((await api("sort=username&dir=asc&page=2")).j.rows);
  const r = (n) => all.find((x) => x.username === n);
  assert.deepEqual(r("alice").methods, ["password"]);
  assert.equal(r("alice").invited_by, "boss");
  assert.deepEqual(r("alice").status, ["invited"]);
  assert.equal(r("alice").displayname, "Alice A");
  assert.equal(r("bob_100%").displayname, null, "the same as the username -> not repeated");
  assert.deepEqual(r("gina").methods, ["google", "apple", "telegram"], "no password: an SSO sign-up's random one (password_set 0)");
  assert.deepEqual(r("CFab12cd34").methods, ["camfrog"]);
  assert.deepEqual(r("CFab12cd34").status, ["chat"]);
  assert.equal(r("CFab12cd34").chat_source, "camfrog");
  assert.equal(r("twitchy").chat_source, "twitch");
  assert.deepEqual(r("twitchy").methods, ["twitch"]);
  assert.deepEqual(r("discordo").methods, ["discord"]);
  assert.deepEqual(r("boss").status, ["admin"]);
  assert.deepEqual(r("staffer").status, ["staff"]);
  assert.deepEqual(r("naughty").status, ["banned"]);
  assert.deepEqual(r("deleted_7f3a").status, ["deleted"]);
  assert.equal(r("deleted_7f3a").gone, true);
  assert.deepEqual(r("dusty").status, ["archived"]);
  assert.deepEqual(r("leaving_soon").status, ["deleting"]);
});

test("privacy: no email, IP or device anywhere in the answer", async () => {
  for (const q of ["", "sort=seen", "filter=chat", "filter=deleted", "q=alice", "page=2"]) {
    const txt = JSON.stringify((await api(q)).j);
    assert.doesNotMatch(txt, /@example\.com|zzrandom|nonsense|203\.0\.113|10\.9\.8\.7|Chrome on Windows/, q || "default");
    assert.doesNotMatch(txt, /"(email|ip|device|userId|user_id|password_set|country|session)":/, q || "default");
  }
});

test("the sort indexes exist on users (created_at, level, username NOCASE) and the created sort uses one", async () => {
  await M.ensureIndexes();
  const idx = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'")).map((r) => r.name);
  for (const n of ["users_created_at", "users_level", "users_username_nocase"]) assert.ok(idx.includes(n), n);
  const plan = (await getQuery("EXPLAIN QUERY PLAN SELECT userId FROM users u ORDER BY u.created_at DESC LIMIT 50")).map((r) => r.detail).join(" | ");
  assert.match(plan, /users_created_at/);
});

test("the card and its nav link: only for someone who holds accounts.members", async () => {
  const ejs = require("ejs");
  const SP = require(path.join(repo, "siteperms"));
  const render = (cls) => ejs.renderFile(path.join(repo, "views", "admin", "users.ejs"),
    { title: "T", user: "x", section: "users", isAdmin: cls === "Admin", me: { userId: "x", class: cls }, errors: [], success: [],
      can: (k, u) => SP.can(u !== undefined ? u : { class: cls }, k) });
  const a = await render("Admin");
  assert.match(a, /id="members"/);
  assert.match(a, /admin-members\.js/);
  assert.match(a, /href="#members">All members</);
  const s = await render("Staff");
  assert.doesNotMatch(s, /id="members"/);
  assert.doesNotMatch(s, /href="#members"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-members.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML/, "text via textContent only");
});

test("chat-only follows invites.chatOnly for Pepe's accounts and the invite-only bots' accounts (+ the older bots' accounts)", async () => {
  const INV = require(path.join(repo, "invites"));
  const chat = new Set(names((await api("filter=chat&sort=username")).j));
  for (const [id, name] of [["cf1", "CFab12cd34"], ["cf2", "CFzz99yy88"], ["cf3", "renamed_frog"], ["web1", "alice"], ["sso1", "gina"]]) {
    assert.equal(chat.has(name), await INV.chatOnly(id), name);
  }
  // a Twitch-bot account made before sign-ups could be invite-only has no invite_shadow row: invites.chatOnly can't see it, the table can
  assert.equal(await INV.chatOnly("tw1"), false);
  assert.ok(chat.has("twitchy"));
});
