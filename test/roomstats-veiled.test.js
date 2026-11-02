// owner 11-02 (wave 2 open question 2, G:/ops/incognito-micstage-design-2026-10-27.md "M addendum 4"): Pepe's room notes naming a
// !bridge hide person - "This should be hidden server side, so admins can see through it". Pepe sends his notes as he learned them
// plus `veiled` (the bridge-hidden people the rows count or the notes name, server-only); the site masks them "someone" in every
// room's free text for EVERY viewer - signed out, members, Staff, the pad's owner (even after 90 days, even with their "Show real
// names" toggle on) - and only a PATV admin (chatlog.see_through) can reveal them: the notes' Reveal (one seethrough_log row, scope
// analytics_note) or their toggle (counted on its row). Never by a GET. v1 (the site knows nothing else of them) and v2 (the
// hidden-names job learned them from the wire: never masked twice, still revealable). Old stored notes are masked at render time.
// A person dropped from Pepe's list stays masked while the site's own sticky hidden set holds them. Fails closed.
//   node --test test/roomstats-veiled.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "rs-veiled-test-")));
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.ALIAS_SECRET = "6f".repeat(32);
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const roomstats = require(path.join(repo, "roomstats"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));

const hash = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
const DAY = 864e5;
const PAD = "Veil_Pad", OLD = "Old_Room";
const HK = "hankhidden";
const NEEDLES = [HK, "Hank Hide", "Hanky", hash(HK)];
const VEILED = [{ login: HK, names: [HK, "Hank Hide", "Hanky"] }];
let base, server;

const nums = (s) => ({ m30: s, s30: s * 10, d30: 9, m90: s * 3, s90: s * 30, d90: 30 });
function row(room, name, knowledge, extra = {}) {
  const days = {};
  for (let i = 0; i < 5; i++) days[new Date(Date.now() - i * DAY).toISOString().slice(0, 10)] = { m: 10, s: 60, k: 1, u: 3, c: 1, n: 0 };
  return Object.assign({
    room, name, first: 1780000000, last: Math.floor(Date.now() / 1000), days, how: [], hows: [], size: {}, peak: "", uniq: { d30: 5, d90: 9 },
    regulars: [{ login: "alicecf", display: "Alice", ...nums(90), last: 1790000000 }, { anon: true, h: hash(HK), ...nums(80) }],
    mic_top: [{ anon: true, h: hash(HK), s90: 9000, d90: 40 }],
    cmds: { top: [], cats: {} }, games: { days: {} }, mod: { total: {}, days: {} }, knowledge, changes: [], history: [],
  }, extra);
}
const PAD_ROW = () => row(PAD, "Veil Pad", {
  summary: "Hank Hide runs the jokes here, and hankhidden starts every argument while Alice laughs.",
  vibe: "loud", topics: [{ t: "Hank Hide's pizza", w: 3 }, { t: "football", w: 2 }], jokes: ["@hankhidden's mic"], events: ["Hanky sang on Friday"], rules: [],
}, { changes: ["new topics: Hanky's birthday"], history: [{ at: Math.floor(Date.now() / 1000) - 7200, topics: ["Hank Hide again"] },
                                                           { at: Math.floor(Date.now() / 1000) - 3600, topics: ["football"] }] });
// a room Pepe stopped syncing (a stored row from before): never sent again, its notes still name hank
const OLD_ROW = () => row(OLD, "Old Room", { summary: "Back then hankhidden and Alice ran the quiz.", topics: [], jokes: [], events: [], rules: [] });
const get = (p, user) => fetch(base + p, { headers: user ? { "x-test-user": user } : {} });
const post = (p, user, body, { fetchHdr = true } = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}),
  ...(fetchHdr ? { "x-requested-with": "fetch", origin: base } : {}) }, body: JSON.stringify(body || {}) });
const sync = (body) => fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" },
                                                            body: JSON.stringify(Object.assign({ password: "bot-token", tz: "UTC", days: 90, rooms: [] }, body)) });
const logRows = () => getQuery("SELECT * FROM seethrough_log ORDER BY id");
const page = async (slug, user) => (await get(`/p/${slug}/analytics`, user)).text();
const noteV = (html) => (html.match(/id="raNotes" data-slug="[^"]+" data-v="([0-9a-f]+)"/) || [])[1];
const leaks = (s) => NEEDLES.filter((n) => s.includes(n));
const VIEWERS = [null, "u_mem", "u_staff", "u_owner", "u_hank"];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  for (const [id, cls] of [["u_admin", "Admin"], ["u_staff", "Staff"], ["u_owner", "pleb"], ["u_mem", "pleb"], ["u_hank", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, NULL)", [id, id, id, cls]);
  }
  await runQuery("CREATE TABLE IF NOT EXISTS room_events (room_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT)");
  await PA.init();
  for (const p of [PAD, OLD]) await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'public')", [p]);
  await PA.load();
  const realGet = rooms.get;
  rooms.get = async (id) => (String(id) === PAD ? { id: PAD, owner: { userId: "u_owner" } } : realGet(id));
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use((req, res, next) => (req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); });
  const addUser = (req, res, next) => next();
  roomstats.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await require(path.join(repo, "chatlogview")).init();
  // the pad's owner has owned it for 100 days: the boards' see-through rule (D-15) lets them reveal frog names there
  await runQuery(`INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES (?, ?, 'u_owner', ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET owner_id = excluded.owner_id, owner_since = excluded.owner_since`, [PAD, PAD, Date.now() - 100 * DAY, Date.now() - 100 * DAY]);
  // the old room was stored before (an older Pepe: no list)
  assert.equal((await sync({ rooms: [OLD_ROW()] })).status, 200);
});
test.after(() => server && server.close());

test("v1, before Pepe's list: the site knows nothing of the !bridge hide person, so his notes print them (the leak this closes)", async () => {
  assert.equal((await sync({ rooms: [PAD_ROW()] })).status, 200);
  const html = await page("veil-pad", "u_mem");
  assert.ok(html.includes("Hank Hide runs the jokes"), "today's prod: the name is printed");
});

test("with Pepe's list: nobody but an admin who reveals sees the hidden person - every viewer, both rooms (the old stored row too); the notes otherwise as Pepe wrote them", async () => {
  const r = await sync({ rooms: [PAD_ROW()], veiled: VEILED });
  assert.deepEqual(await r.json(), { success: true, saved: 1, removed: 0, veiled: 1 });
  assert.deepEqual((await getQuery("SELECT h, login, names, live FROM camfrog_roomstats_veiled")).map((x) => [x.h, x.login, JSON.parse(x.names), x.live]),
                   [[hash(HK), HK, [HK, "Hank Hide", "Hanky"], 1]], "stored server-only");
  for (const who of [...VIEWERS, "u_admin"]) {
    for (const slug of ["veil-pad", "old-room"]) {
      const html = await page(slug, who);
      assert.deepEqual(leaks(html), [], `${slug} for ${who}`);
    }
  }
  const mem = await page("veil-pad", "u_mem");
  assert.match(mem, /someone runs the jokes here, and someone starts every argument while Alice laughs\./);
  assert.match(mem, /someone&#39;s pizza/);
  assert.match(mem, /someone&#39;s mic/);
  assert.match(mem, /someone sang on Friday/);
  assert.match(mem, /new topics: someone&#39;s birthday/);
  assert.match(mem, /someone again/);
  assert.match(await page("old-room", "u_mem"), /Back then someone and Alice ran the quiz\./, "an old stored row is masked by the current list");
  for (const who of VIEWERS) {
    const html = await page("veil-pad", who);
    assert.doesNotMatch(html, /class="ra-hid"|id="raNotes"/, `${who}: no marks, no Reveal`);
  }
  const adm = await page("veil-pad", "u_admin");
  assert.equal((adm.match(/<span class="ra-hid" data-k="\d+">someone<\/span>/g) || []).length, 7, "an admin: each mention marked");
  assert.ok(noteV(adm), "an admin: the notes' Reveal");
  assert.equal((await logRows()).length, 0, "a page view reveals nothing and logs nothing");
  // Pepe's text is stored as he sent it (the site masks at render time)
  const stored = JSON.parse((await getQuery("SELECT data FROM camfrog_roomstats WHERE room_id = ?", [PAD]))[0].data);
  assert.match(stored.knowledge.summary, /^Hank Hide runs the jokes/);
});

test("the notes' Reveal: admins only, never by a GET or without the site's fetch headers, one log row (scope analytics_note); a pad's owner - even after 90 days - gets 403", async () => {
  const v = noteV(await page("veil-pad", "u_admin"));
  for (const [who, code] of [[null, 401], ["u_mem", 403], ["u_staff", 403], ["u_owner", 403], ["u_hank", 403]]) {
    const r = await post("/p/veil-pad/analytics/reveal-notes", who, { v });
    assert.equal(r.status, code, String(who));
    assert.deepEqual(leaks(await r.text()), [], String(who));
  }
  assert.equal((await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v }, { fetchHdr: false })).status, 403, "a form / link from elsewhere");
  assert.equal((await get("/p/veil-pad/analytics/reveal-notes?v=" + v, "u_admin")).status, 404, "no GET route");
  assert.equal((await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v: "0".repeat(24) })).status, 409, "another version of the notes");
  assert.equal((await logRows()).length, 0, "nothing logged for any of it");
  const r = await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v, reason: "report #7" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const d = await r.json();
  assert.deepEqual(d.names.map((n) => [n.k, n.text, n.login]),
                   [[0, "Hank Hide", HK], [1, HK, HK], [2, "Hank Hide", HK], [3, "@" + HK, HK], [4, "Hanky", HK], [5, "Hanky", HK], [6, "Hank Hide", HK]]);
  const rows = await logRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].user_id, rows[0].role, rows[0].scope, rows[0].room_id, JSON.parse(rows[0].logins), rows[0].reason, rows[0].ref, rows[0].ended != null],
                   ["u_admin", "admin", "analytics_note", PAD, [HK], "report #7", "notes:7", true]);
  await runQuery("DELETE FROM seethrough_log");
});

test("the toggle: an admin's shows the names in the notes too (counted on its one row); a pad owner's (90 days) reveals board rows but never the notes - and never through Pepe's list", async () => {
  assert.deepEqual(await (await post("/p/veil-pad/analytics/seethrough", "u_admin", { on: true, reason: "audit" })).json(), { ok: true, on: true });
  const adm = await page("veil-pad", "u_admin");
  assert.match(adm, /<span class="real" title="hankhidden - only you can see this">Hank Hide 🕶<\/span> runs the jokes here/);
  assert.doesNotMatch(adm, /id="raNotes"/, "no notes' Reveal while all are shown");
  let rows = await logRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].scope, rows[0].n, JSON.parse(rows[0].logins)], ["analytics_toggle", 1, [HK]], "the notes' logins on the toggle's row");
  for (const who of VIEWERS) assert.deepEqual(leaks(await page("veil-pad", who)), [], String(who) + " while the admin's toggle is on");
  await post("/p/veil-pad/analytics/seethrough", "u_admin", { on: false });
  // the pad's owner: their toggle (the boards' rule) - the notes stay masked, no marks
  assert.deepEqual(await (await post("/p/veil-pad/analytics/seethrough", "u_owner", { on: true })).json(), { ok: true, on: true });
  const own = await page("veil-pad", "u_owner");
  assert.match(own, /Real names are on for you on this pad/);
  assert.deepEqual(leaks(own), [], "the owner's toggle shows nothing of hank (the site has no other source for him)");
  assert.doesNotMatch(own, /class="ra-hid"|id="raNotes"/);
  assert.match(own, /someone runs the jokes here/);
  await post("/p/veil-pad/analytics/seethrough", "u_owner", { on: false });
  // the owner's per-row Reveal of hank's board row: Pepe's list is never a source for it ("not known to the site")
  const frog = (own.match(/<span class="anon">([^<]+)<\/span>/) || [])[1];
  assert.ok(frog);
  const rv = await post("/p/veil-pad/analytics/reveal", "u_owner", { row: frog });
  assert.deepEqual(await rv.json(), { ok: true, row: frog, real: null });
  await runQuery("DELETE FROM seethrough_log");
  await runQuery("DELETE FROM seethrough_toggle");
});

test("v2: the hidden-names job knows them from the wire too - masked once ('someone', never doubled), still revealable by an admin", async () => {
  const CL = require(path.join(repo, "chatlog"));
  const CV = require(path.join(repo, "chatlogview"));
  await CL.hideNow(HK, "pepe", "bridge");
  CV.noteWho(HK, "Hank Hide");
  await CV.scheduleNames();
  assert.equal(CV.redact("Hank Hide waved"), "someone waved", "the names job masks him in other text");
  const mem = await page("veil-pad", "u_mem");
  assert.deepEqual(leaks(mem), []);
  assert.match(mem, /someone runs the jokes here, and someone starts every argument while Alice laughs\./);
  const adm = await page("veil-pad", "u_admin");
  assert.equal((adm.match(/class="ra-hid"/g) || []).length, 7, "the same seven marks (the list runs first)");
  const d = await (await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v: noteV(adm) })).json();
  assert.equal(d.names.length, 7);
  assert.equal(d.names[0].text, "Hank Hide");
  await runQuery("DELETE FROM seethrough_log");
});

test("Pepe's list is the whole list: someone he drops is unmasked unless the site's own sticky hidden set still holds them (hank does: still masked)", async () => {
  await sync({ rooms: [], veiled: [...VEILED, { login: "lurkycf", names: ["lurkycf", "Lurky Lou"] }] });
  await sync({ rooms: [row("Lurk_Room", "Lurk Room", { summary: "Lurky Lou lurked.", topics: [], jokes: [], events: [], rules: [] })], veiled: [...VEILED, { login: "lurkycf", names: ["lurkycf", "Lurky Lou"] }] });
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES ('Lurk_Room', 'public')");
  await PA.load();
  assert.match(await page("lurk-room", "u_mem"), /someone lurked\./);
  const r = await sync({ rooms: [], veiled: [] });
  assert.equal((await r.json()).veiled, 0);
  assert.deepEqual((await getQuery("SELECT login, live FROM camfrog_roomstats_veiled ORDER BY login")).map((x) => [x.login, x.live]), [[HK, 0]],
                   "lurky (not hidden on the site) is gone; hank (in the site's sticky set) is kept, not live");
  assert.match(await page("lurk-room", "u_mem"), /Lurky Lou lurked\./, "un-hidden by Pepe: named again");
  for (const who of VIEWERS) assert.deepEqual(leaks(await page("veil-pad", who)), [], String(who) + ": hank still masked");
  // an older Pepe (no list in the body): the site keeps what it has
  await sync({ rooms: [PAD_ROW()] });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_roomstats_veiled"))[0].n, 1);
  await sync({ rooms: [], veiled: VEILED });
});

test("fails closed: when the list can't be read, Pepe's free text is left out (the numbers stay)", async () => {
  await runQuery("ALTER TABLE camfrog_roomstats_veiled RENAME TO camfrog_roomstats_veiled_x");
  try {
    for (const who of [null, "u_mem", "u_admin"]) {
      const html = await page("veil-pad", who);
      assert.deepEqual(leaks(html), [], String(who));
      assert.doesNotMatch(html, /runs the jokes/, "no notes");
      assert.match(html, /Regulars/, "the rest of the page");
    }
  } finally { await runQuery("ALTER TABLE camfrog_roomstats_veiled_x RENAME TO camfrog_roomstats_veiled"); }
  assert.match(await page("veil-pad", "u_mem"), /someone runs the jokes here/);
});

test("the list never reaches a page or an answer: no veiled names, login or hash in any view model, sync answer or error", async () => {
  const r = (await getQuery("SELECT data FROM camfrog_roomstats WHERE room_id = ?", [PAD]))[0];
  const a = await roomstats.forRoom(Object.assign(JSON.parse(r.data), { updated: Date.now() }), "veil-pad", { userId: "u_mem" });
  assert.deepEqual(leaks(JSON.stringify(a)), [], "a member's view model");
  const owner = await roomstats.forRoom(Object.assign(JSON.parse(r.data), { updated: Date.now() }), "veil-pad", { userId: "u_owner" }, { see: { role: "owner", on: true }, reveal: true });
  // (the boards' own see-through may name hank to a 90-day owner by now - v2's names job knows him from the wire; Pepe's notes never)
  assert.deepEqual(leaks(JSON.stringify([owner.know, owner.changes, owner.history, owner.notesHidden])), [], "an owner's notes, toggle on");
  assert.equal(owner.noteLogins.length, 0);
  const adm = await roomstats.forRoom(Object.assign(JSON.parse(r.data), { updated: Date.now() }), "veil-pad", { userId: "u_admin" }, { see: { role: "admin", on: false } });
  assert.deepEqual(leaks(JSON.stringify(adm)), [], "an admin's view model before a reveal");
  assert.ok(adm.notesHidden && adm.notesHidden.n === 7);
  const bad = await sync({ password: "nope", veiled: VEILED });
  assert.equal(bad.status, 403);
  assert.deepEqual(leaks(await bad.text()), []);
});

// ── review fixes (owner 11-02) ──
const bare = (knowledge) => Object.assign({ summary: "", vibe: "", topics: [], jokes: [], events: [], rules: [] }, knowledge);

test("review (T1): Pepe's vibe and house norms are masked too - every viewer ('Hanky': a name only Pepe's list knows)", async () => {
  await sync({ rooms: [row(PAD, "Veil Pad", bare({ summary: "A quiet night.", vibe: "Hanky's crowd", rules: ["never talk over Hanky"] }))], veiled: VEILED });
  for (const who of [null, "u_mem", "u_admin"]) assert.deepEqual(leaks(await page("veil-pad", who)), [], String(who));
  const mem = await page("veil-pad", "u_mem");
  assert.match(mem, /<span class="vibe">✨ someone&#39;s crowd<\/span>/, "the vibe");
  assert.match(mem, /<li>never talk over someone<\/li>/, "the house norms");
  assert.equal(((await page("veil-pad", "u_admin")).match(/class="ra-hid"/g) || []).length, 2, "an admin: both marked");
});

test("review (T2): an admin's marked and revealed notes are escaped - Pepe's text is room chat, never markup (a revealed name too)", async () => {
  const BO = { login: "bojocf", names: ["bojocf", "Bo&Jo<3"] };
  await sync({ rooms: [row(PAD, "Veil Pad", bare({ summary: "Hanky posted <img src=x onerror=alert(1)> & left; Bo&Jo<3 laughed <b>loud</b> & long." }))],
               veiled: [...VEILED, BO] });
  const mark = await page("veil-pad", "u_admin");
  assert.doesNotMatch(mark, /<img src=x|<b>loud/, "mark mode: raw markup must not reach the page (before, between and after the marks)");
  assert.match(mark, /<span class="ra-hid" data-k="0">someone<\/span> posted &lt;img src=x onerror=alert\(1\)&gt; &amp; left; <span class="ra-hid" data-k="1">someone<\/span> laughed &lt;b&gt;loud&lt;\/b&gt; &amp; long\./);
  assert.deepEqual(await (await post("/p/veil-pad/analytics/seethrough", "u_admin", { on: true, reason: "audit" })).json(), { ok: true, on: true });
  try {
    const rev = await page("veil-pad", "u_admin");
    assert.doesNotMatch(rev, /<img src=x|<b>loud|Bo&Jo<3/, "reveal mode: neither Pepe's text nor a revealed name is raw markup");
    assert.match(rev, /<span class="real" title="hankhidden - only you can see this">Hanky 🕶<\/span> posted &lt;img src=x onerror=alert\(1\)&gt; &amp; left; <span class="real" title="bojocf - only you can see this">Bo&amp;Jo&lt;3 🕶<\/span> laughed &lt;b&gt;loud&lt;\/b&gt; &amp; long\./);
  } finally {
    await post("/p/veil-pad/analytics/seethrough", "u_admin", { on: false });
    await runQuery("DELETE FROM seethrough_log");
    await runQuery("DELETE FROM seethrough_toggle");
  }
  const mem = await page("veil-pad", "u_mem");
  assert.match(mem, /someone posted &lt;img src=x onerror=alert\(1\)&gt; &amp; left; someone laughed &lt;b&gt;loud&lt;\/b&gt; &amp; long\./,
               "a member: plain text, escaped as before");
  await sync({ rooms: [], veiled: VEILED });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_roomstats_veiled WHERE login = 'bojocf'"))[0].n, 0);
});

test("review (T6): the notes' Reveal logs BEFORE it answers - when the log row can't be written, no names (500)", async () => {
  await sync({ rooms: [PAD_ROW()], veiled: VEILED });
  const v = noteV(await page("veil-pad", "u_admin"));
  assert.ok(v);
  await runQuery("ALTER TABLE seethrough_log RENAME TO seethrough_log_x");
  let r, body;
  try {
    r = await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v });
    body = await r.text();
  } finally { await runQuery("ALTER TABLE seethrough_log_x RENAME TO seethrough_log"); }
  assert.equal(r.status, 500);
  assert.deepEqual(leaks(body), [], "no names without their log row");
  assert.equal((await logRows()).length, 0);
  assert.equal((await post("/p/veil-pad/analytics/reveal-notes", "u_admin", { v })).status, 200, "the log back: the Reveal works again");
  assert.equal((await logRows()).length, 1);
  await runQuery("DELETE FROM seethrough_log");
});

test("review (T8): the length rules - a login from 2 characters, any other name from 3 (a 2-character nickname is left alone)", async () => {
  const KZ = { login: "kz", names: ["kz", "Kat", "Hidz", "Jo"] };
  await sync({ rooms: [row(PAD, "Veil Pad", bare({ summary: "Kat and Hidz argued while kz watched and Jo laughed." }))], veiled: [...VEILED, KZ] });
  assert.match(await page("veil-pad", "u_mem"), /someone and someone argued while someone watched and Jo laughed\./);
  await sync({ rooms: [PAD_ROW()], veiled: VEILED });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_roomstats_veiled WHERE login = 'kz'"))[0].n, 0);
});

test("review (T8): fails closed while the site's sticky hidden set can't answer - someone Pepe drops stays masked, their row kept", async () => {
  const LZ = { login: "lurky2cf", names: ["lurky2cf", "Lurky Two"] };
  await sync({ rooms: [row("Lurk_Room", "Lurk Room", bare({ summary: "Lurky Two lurked." }))], veiled: [...VEILED, LZ] });
  assert.match(await page("lurk-room", "u_mem"), /someone lurked\./);
  const CV = require(path.join(repo, "chatlogview"));
  const real = CV.isHiddenLogin;
  CV.isHiddenLogin = () => { throw new Error("not loaded yet"); };
  try {
    await sync({ rooms: [], veiled: VEILED });
    assert.deepEqual((await getQuery("SELECT live FROM camfrog_roomstats_veiled WHERE login = 'lurky2cf'")).map((x) => x.live), [0], "kept, not live");
    assert.match(await page("lurk-room", "u_mem"), /someone lurked\./, "still masked");
  } finally { CV.isHiddenLogin = real; }
  await sync({ rooms: [], veiled: VEILED });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_roomstats_veiled WHERE login = 'lurky2cf'"))[0].n, 0, "the set answers (not hidden): gone");
  assert.match(await page("lurk-room", "u_mem"), /Lurky Two lurked\./);
});
