// Offline tests for 1.99anx's 🏳️ country on the 👥 All members table (members.js, /admin/users#members; owner 2026-11-14: "filter
// the admin user list by their last logged in country (like we have the flag in the profile)"):
//   * the rule is the profile's flag (index.js, 1.99abt), exactly: the newest session (by created - not the newest last_seen) whose
//     country is 2 characters and not XX / T1, upper-cased when it's 2 letters, else none (no fall-back past a bad newest one);
//     revoked sessions count; checked against the profile's own query for every account
//   * ?country=<CC> (any case) / none, with q, filter, sort and paging - total / pages follow it; anything else = any country
//   * countries [{cc, n}] (most first, then by code) + no_country over EVERY account, whatever the request asks
//   * admins see through a hidden flag and incognito (the owner's 2026-11-02 rule); still no IP / device / email / session detail
//   * a database without sessions (or without its country column): no country for anyone, nothing breaks
//   * the subquery searches sessions' index sessions_user; the card's picker + flag font + script
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/members-country.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "members-country-test-"));
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
const api = async (q, u = "adm") => {
  const r = await fetch(base + "/api/admin/members" + (q ? "?" + q : ""), { redirect: "manual", headers: { "x-user": u } });
  return { status: r.status, j: await r.json() };
};
/** Every row of a view (all pages). */
async function every(q) {
  const first = (await api(q)).j;
  let rows = first.rows;
  for (let p = 2; p <= first.pages; p++) rows = rows.concat((await api((q ? q + "&" : "") + "page=" + p)).j.rows);
  return { first, rows, names: rows.map((r) => r.username) };
}

async function mk(id, name, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, level, xp, camfrogUsername, created_at, auto_source, password_set)
                  VALUES (?, ?, ?, ?, 'x', ?, 0, 0, ?, ?, ?, ?)`,
                 [id, name, name, o.email === undefined ? id + "@example.com" : o.email, o.cls || "pleb", o.cf || null,
                  iso(NOW - (o.age == null ? 100 : o.age) * DAY), o.auto || null, o.pw === undefined ? 1 : o.pw]);
}
let sid = 0;
/** A sign-in session: created `ago` days back, its country, last used `seen` days back (default: when created). */
async function sess(uid, country, ago, o = {}) {
  sid++;
  await runQuery(`INSERT INTO sessions (id, user_id, created, last_seen, expires, ip, country, device, method, revoked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'Firefox on Linux', 'password', ?)`,
                 ["sess-secret-" + sid, uid, NOW - ago * DAY, NOW - (o.seen == null ? ago : o.seen) * DAY, NOW + 30 * DAY,
                  "198.51.100." + sid, country, o.revoked ? NOW - DAY : null]);
}

// what each named account's country must be (the rule in the header)
const WANT = {
  a_newer: "DE",     // FR signed in 10 days ago and used a minute ago; DE signed in 2 days ago -> the newer SIGN-IN wins
  b_xx: "FR",        // the newest says XX (unknown) -> the newest known one
  c_t1: "GB",        // the newest says T1 (Tor)
  d_null: "IE",      // the newest has no country (not through the proxy)
  e_lower: "US",     // stored lower-case -> upper-cased
  f_bad: null,       // the newest is "1A" (2 characters, not letters): the profile shows no flag, and never falls back to GB
  g_long: "ES",      // the newest is "USA" (3 characters): skipped like the profile's length = 2
  h_revoked: "CA",   // a revoked session is still where they last signed in from
  i_none: null,      // no session at all
  j_onlyxx: null,    // only XX
  k_banned: "US",
  l_deleted: "DE",
  m_hidden: "NL",    // hid the flag from visitors
  n_incog: "SE",     // incognito
  CFab12cd34: null,  // Pepe's chat-only account (a session would make it a website account)
  boss: null,
};

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  M = require(path.join(repo, "members"));
  M._setClock(() => NOW);
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "accountdelete")).init();
  await require(path.join(repo, "incognito")).init();
  await mk("adm", "boss", { cls: "Admin", age: 400 });
  await mk("ua", "a_newer", { age: 30 });
  await sess("ua", "FR", 10, { seen: 0.001 });
  await sess("ua", "DE", 2);
  await mk("ub", "b_xx", { age: 31 }); await sess("ub", "FR", 9); await sess("ub", "XX", 1);
  await mk("uc", "c_t1", { age: 32 }); await sess("uc", "GB", 8); await sess("uc", "T1", 1);
  await mk("ud", "d_null", { age: 33 }); await sess("ud", "IE", 8); await sess("ud", null, 1);
  await mk("ue", "e_lower", { age: 34 }); await sess("ue", "us", 1);
  await mk("uf", "f_bad", { age: 35 }); await sess("uf", "GB", 9); await sess("uf", "1A", 1);
  await mk("ug", "g_long", { age: 36 }); await sess("ug", "ES", 9); await sess("ug", "USA", 1);
  await mk("uh", "h_revoked", { age: 37 }); await sess("uh", "CA", 1, { revoked: true });
  await mk("ui", "i_none", { age: 38 });
  await mk("uj", "j_onlyxx", { age: 39 }); await sess("uj", "XX", 1);
  await mk("uk", "k_banned", { age: 40 }); await sess("uk", "US", 3);
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, at, until) VALUES ('uk', '', 'k_banned', 'spam', ?, NULL)", [NOW - DAY]);
  await mk("ul", "l_deleted", { age: 41, email: null }); await sess("ul", "DE", 20);
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, done_at) VALUES ('ul', 'done', ?, ?, ?)", [NOW - 9 * DAY, NOW - DAY, NOW - DAY]);
  await mk("um", "m_hidden", { age: 42 }); await sess("um", "NL", 2);
  await runQuery("INSERT INTO profile_layout (user_id, layout, updated) VALUES ('um', ?, ?)", [JSON.stringify({ hidden: ["country"] }), NOW]);
  await mk("un", "n_incog", { age: 43, cf: "incog_login" }); await sess("un", "SE", 2);
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('incog_login', 1, ?)`, [NOW - DAY]);
  await mk("cf1", "CFab12cd34", { email: "zzrandom", auto: "camfrog", cf: "froggy_login", pw: null, age: 44 });
  // 55 more in the US (two pages of them), signed in on different days
  for (let i = 0; i < 55; i++) {
    const id = "us" + i;
    await mk(id, "us_" + String(i).padStart(2, "0"), { age: 200 + i });
    await sess(id, "US", 5 + i);
  }

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

const TOTAL = 16 + 55;

test("the rule: the newest sign-in's country (by created), skipping XX / T1 / none / not 2 characters; upper-cased; no fall-back past a bad one", async () => {
  const { rows, first } = await every("sort=username");
  assert.equal(first.total, TOTAL);
  const by = new Map(rows.map((r) => [r.username, r]));
  for (const [name, cc] of Object.entries(WANT)) assert.equal(by.get(name).country, cc, name);
  for (const r of rows) if (r.username.startsWith("us_")) assert.equal(r.country, "US", r.username);
  for (const r of rows) assert.ok(r.country === null || /^[A-Z]{2}$/.test(r.country), r.username + ": a code or null");
});

test("the same answer as the profile's own query (index.js) for every account", async () => {
  // the profile's flag, as index.js runs it (1.99abt) - pinned to its source below so the two can't drift apart unseen
  const PROFILE_SQL = `SELECT country FROM sessions WHERE user_id = ? AND country IS NOT NULL AND length(country) = 2
                                     AND upper(country) NOT IN ('XX', 'T1') ORDER BY created DESC LIMIT 1`;
  const flat = (s) => s.replace(/\s+/g, " ");
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.ok(flat(src).includes(flat(PROFILE_SQL)), "index.js still asks this (if the profile's rule changes, change members.js's too)");
  assert.match(src, /return r && \/\^\[A-Za-z\]\{2\}\$\/\.test\(r\.country\) \? String\(r\.country\)\.toUpperCase\(\) : null;/);
  const profile = async (uid) => {
    const r = (await getQuery(PROFILE_SQL, [String(uid)]))[0];
    return r && /^[A-Za-z]{2}$/.test(r.country) ? String(r.country).toUpperCase() : null;
  };
  const { rows } = await every("");
  const ids = new Map((await getQuery("SELECT userId, username FROM users")).map((u) => [u.username, u.userId]));
  for (const r of rows) assert.equal(r.country, await profile(ids.get(r.username)), r.username);
});

test("?country=: a code (any case) with paging; with q, filter and sort; total and pages follow it", async () => {
  const us = await every("country=US");
  assert.equal(us.first.country, "US");
  assert.equal(us.first.total, 57, "55 + e_lower + k_banned");
  assert.equal(us.first.pages, 2);
  assert.equal(us.first.rows.length, 50);
  assert.equal(us.rows.length, 57);
  assert.equal(new Set(us.names).size, 57, "no account twice, none missing");
  for (const r of us.rows) assert.equal(r.country, "US");
  const p2 = (await api("country=US&page=2")).j;
  assert.equal(p2.rows.length, 7);
  assert.equal((await api("country=US&page=9")).j.page, 2, "a page past the end is the last page");
  const lower = (await api("country=us")).j;
  assert.equal(lower.country, "US"); assert.equal(lower.total, 57);
  const gb = (await api("country=%20gb%20")).j;
  assert.equal(gb.country, "GB", "trimmed");
  assert.deepEqual(gb.rows.map((r) => r.username), ["c_t1"], "c_t1's newest is T1 (skipped); f_bad's newest is 1A - no fall-back to its GB");
  // + search
  const q = (await api("country=US&q=us_0")).j;
  assert.equal(q.total, 10, "us_00 .. us_09 (_ is literal)");
  assert.deepEqual((await api("country=US&q=lower")).j.rows.map((r) => r.username), ["e_lower"]);
  // + filters
  assert.deepEqual((await api("country=US&filter=banned")).j.rows.map((r) => r.username), ["k_banned"]);
  assert.deepEqual((await api("country=DE&filter=deleted")).j.rows.map((r) => r.username), ["l_deleted"]);
  assert.deepEqual((await api("country=DE&filter=website")).j.rows.map((r) => r.username), ["a_newer"], "the deleted one isn't a website member");
  assert.equal((await api("country=DE")).j.total, 2);
  assert.equal((await api("country=US&filter=chat")).j.total, 0, "a chat-only account has no session, so no country");
  // + sort
  const byName = (await api("country=US&sort=username")).j;
  assert.equal(byName.rows[0].username, "e_lower");
  const oldest = (await api("country=US&dir=asc")).j;
  assert.equal(oldest.rows[0].username, "us_54");
  const seen = (await api("country=US&sort=seen")).j;
  assert.equal(seen.rows[0].username, "e_lower", "signed in a day ago");
  // a country nobody has
  const jp = (await api("country=jp")).j;
  assert.equal(jp.country, "JP"); assert.equal(jp.total, 0); assert.equal(jp.pages, 1); assert.deepEqual(jp.rows, []);
});

test("?country=none: no country on record - with the filters too", async () => {
  const none = await every("country=none");
  assert.equal(none.first.country, "none");
  assert.deepEqual(none.names.sort(), ["CFab12cd34", "boss", "f_bad", "i_none", "j_onlyxx"]);
  for (const r of none.rows) assert.equal(r.country, null);
  assert.equal((await api("country=NONE")).j.country, "none", "any case");
  assert.deepEqual((await api("country=none&filter=chat")).j.rows.map((r) => r.username), ["CFab12cd34"]);
  assert.equal((await api("country=none&q=boss")).j.total, 1);
});

test("an invalid country is any country (like a bad sort / filter): the answer says country \"\"", async () => {
  for (const v of ["USA", "XX", "xx", "T1", "1A", "U", "%20", "none2", "U%25", "US'%20OR%201=1--", "%C3%A9%C3%A9"]) {
    const j = (await api("country=" + v)).j;
    assert.equal(j.ok, true, v);
    assert.equal(j.country, "", v);
    assert.equal(j.total, TOTAL, v);
  }
  const twice = (await api("country=US&country=FR")).j;
  assert.equal(twice.country, ""); assert.equal(twice.total, TOTAL);
  const obj = (await api("country[a]=US")).j;
  assert.equal(obj.country, ""); assert.equal(obj.total, TOTAL);
  assert.equal(M.options({ country: " de " }).country, "DE");
  assert.equal(M.options({ country: ["US"] }).country, "", "a repeated param (an array) is any country");
  assert.equal(M.options({}).country, "");
});

test("countries + no_country: every account's, most first then by code - the request doesn't change them", async () => {
  const want = [{ cc: "US", n: 57 }, { cc: "DE", n: 2 }, { cc: "CA", n: 1 }, { cc: "ES", n: 1 }, { cc: "FR", n: 1 }, { cc: "GB", n: 1 },
                { cc: "IE", n: 1 }, { cc: "NL", n: 1 }, { cc: "SE", n: 1 }];
  const j = (await api()).j;
  assert.deepEqual(j.countries, want);
  assert.equal(j.no_country, 5);
  assert.equal(j.countries.reduce((s, c) => s + c.n, 0) + j.no_country, j.counts.total, "every account once");
  for (const q of ["country=US", "country=none", "filter=chat", "q=zzz", "country=DE&filter=deleted&page=3&sort=level"]) {
    const o = (await api(q)).j;
    assert.deepEqual(o.countries, want, q);
    assert.equal(o.no_country, 5, q);
  }
  assert.deepEqual(await M.countries({ at: NOW }), { countries: want, no_country: 5 });
});

test("admins see through: a flag hidden from visitors and an incognito member still show (owner, 2026-11-02)", async () => {
  const PL = require(path.join(repo, "profilelayout"));
  assert.equal(PL.stateOf(await PL.get("um"), "country"), "hidden", "m_hidden really hid the flag");
  assert.equal((await require(path.join(repo, "incognito")).stateOf("un")).on, true, "n_incog really is incognito");
  assert.deepEqual((await api("country=NL")).j.rows.map((r) => [r.username, r.country]), [["m_hidden", "NL"]]);
  assert.deepEqual((await api("country=SE")).j.rows.map((r) => [r.username, r.country]), [["n_incog", "SE"]]);
  // the gate is unchanged: only accounts.members holders
  assert.equal((await api("country=NL", "um")).status, 403);
  assert.equal((await api("country=NL", "")).status, 401);
});

test("privacy: the country code is the one session detail - no IP, device, session id, times or email", async () => {
  for (const q of ["", "country=US", "country=US&page=2", "country=none", "country=NL", "sort=seen", "filter=deleted&country=DE"]) {
    const j = (await api(q)).j;
    const txt = JSON.stringify(j);
    assert.doesNotMatch(txt, /198\.51\.100|Firefox on Linux|sess-secret|@example\.com|zzrandom|incog_login/, q || "default");
    assert.doesNotMatch(txt, /"(email|ip|device|device_key|userId|user_id|session|session_id|sessions|sid|last_seen|revoked_at|method|password_set|camfrogUsername)":/, q || "default");
    for (const r of j.rows) {
      assert.ok(r.country === null || /^[A-Z]{2}$/.test(r.country), "a 2-letter code or null");
      assert.deepEqual(Object.keys(r).sort(), ["chat_source", "country", "created", "displayname", "gone", "invited_by", "level", "methods", "seen", "status", "username"]);
    }
    for (const c of j.countries) assert.deepEqual(Object.keys(c).sort(), ["cc", "n"]);
  }
});

test("a database without sessions, or without its country column: no country for anyone, the filter offers nothing", async () => {
  const check = async (why) => {
    M._resetSchema();
    const j = (await api()).j;
    assert.equal(j.ok, true, why);
    assert.deepEqual(j.countries, [], why);
    assert.equal(j.no_country, TOTAL, why);
    assert.ok(j.rows.every((r) => r.country === null), why);
    assert.equal((await api("country=none")).j.total, TOTAL, why + ": nobody has a country");
    assert.equal((await api("country=US")).j.total, 0, why);
    assert.equal(await M._countryCol(), "NULL", why);
  };
  await runQuery("ALTER TABLE sessions RENAME TO sessions_away");
  try {
    await check("no sessions table");
    await runQuery("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER, expires INTEGER NOT NULL)");
    await runQuery("INSERT INTO sessions (id, user_id, created, expires) VALUES ('x1', 'ua', ?, ?)", [NOW, NOW + DAY]);
    await check("a sessions table without country");
    await runQuery("DROP TABLE sessions");
  } finally {
    await runQuery("ALTER TABLE sessions_away RENAME TO sessions");
    M._resetSchema();
  }
  assert.equal((await api("country=US")).j.total, 57, "back again");
});

test("the country subquery searches sessions' user index (sessions_user) - for the page, the filter and the list", async () => {
  M._resetSchema();
  const col = await M._countryCol();
  assert.notEqual(col, "NULL");
  assert.doesNotMatch(col, /'US'|\?/, "no value in the SQL: the code is bound");
  for (const [sql, args] of [[`SELECT u.userId, ${col} AS c FROM users u ORDER BY u.created_at DESC LIMIT 50`, []],
                             [`SELECT COUNT(*) AS n FROM users u WHERE ${col} = ?`, ["US"]],
                             [`SELECT cc, COUNT(*) AS n FROM (SELECT ${col} AS cc FROM users u) GROUP BY cc`, []]]) {
    const plan = (await getQuery("EXPLAIN QUERY PLAN " + sql, args)).map((r) => r.detail).join(" | ");
    assert.match(plan, /SEARCH s USING (COVERING )?INDEX sessions_user \(user_id=\?\)/, plan);
    assert.doesNotMatch(plan, /SCAN s\b/, "never a scan of sessions per account: " + plan);
  }
});

test("the card: a country picker beside the search, the flag font, the new script; the script writes no HTML", async () => {
  const ejs = require("ejs");
  const SP = require(path.join(repo, "siteperms"));
  const html = await ejs.renderFile(path.join(repo, "views", "admin", "users.ejs"),
    { title: "T", user: "x", section: "users", isAdmin: true, me: { userId: "x", class: "Admin" }, errors: [], success: [],
      can: (k, u) => SP.can(u !== undefined ? u : { class: "Admin" }, k) });
  assert.match(html, /<label for="mmCountry" class="mm-sr">Country they last signed in from<\/label>/);
  assert.match(html, /<select id="mmCountry"><option value="">Any country<\/option><option value="none">No country on record<\/option><\/select>/);
  assert.match(html, /@font-face \{ font-family: "Twemoji Country Flags"; src: url\("\/public\/fonts\/twemoji-flags\/TwemojiCountryFlags\.woff2"\)/);
  assert.ok(fs.existsSync(path.join(repo, "public", "fonts", "twemoji-flags", "TwemojiCountryFlags.woff2")));
  assert.match(html, /\.mm \.mm-flag \{ font-family: "Twemoji Country Flags"/);
  assert.match(html, /\.mm #mmCountry \{[^}]*font-family: "Twemoji Country Flags"/);
  assert.match(html, /The <b>flag<\/b> after a name is the country they last signed in from/);
  assert.match(html, /admin-members\.js\?v=2/);
  const staff = await ejs.renderFile(path.join(repo, "views", "admin", "users.ejs"),
    { title: "T", user: "x", section: "users", isAdmin: false, me: { userId: "x", class: "Staff" }, errors: [], success: [],
      can: (k, u) => SP.can(u !== undefined ? u : { class: "Staff" }, k) });
  assert.doesNotMatch(staff, /mmCountry/, "no picker without accounts.members");
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-members.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(js, /qs\.set\('country', st\.country\)/, "the picker asks the server");
  assert.match(js, /p\.set\('mc', st\.country\)/, "the address keeps it");
  assert.match(js, /flag\.setAttribute\('aria-label', cn\)/, "the flag is named for screen readers");
  assert.match(js, /new Intl\.DisplayNames\(/);
});
