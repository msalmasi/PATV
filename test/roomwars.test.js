// Room Wars on the site (roomwars.js; room-wars plan R4a / R4b / R8): Pepe's pushed copy of the room map + room control.
//   * the push route: the bot token only; idempotent by revision (same = "same", older = 409 E_STALE + the stored one, newer
//     replaces the copy and the day's history row); the feed switch off = 503; everything whitelisted - planted member /
//     crew / defender / recipient names never reach the DB, the API or a page
//   * the daily history: one row per day, a resend on a new day adds that day's row
//   * the views: held / free / not contestable, gangs by tag / name / colour (site gangs or Pepe's mirror), the pad link,
//     timers as chips, the gang slice of the last payout (pad vault recipe days), dormant rooms hidden by default
//   * the pages: /gtf/roomwars (empty and filled), /gtf/turf -> 301, /gtf/london (only seasons 2 and 4, no member names),
//     the pad card + the gang section partials, the gang page through gangs.js (mirror mode)
//   * old bot + new site: nothing pushed -> empty states, no pad card, the disband guard finds nothing
//   * admin: the switches are admins-only, same-site fetch only
//   NODE_PATH=G:/PATV/node_modules node --test test/roomwars.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roomwars-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const RW = require(path.join(repo, "roomwars"));
const G = require(path.join(repo, "gangs"));
const rooms = require(path.join(repo, "rooms"));

const FAM = "bd6e773c", FBGM = "c9e9be8d";
const LEAKS = ["zoltar214", "foamy1111", "recipient_login", "defender_login", "Raider One", "raider_one", "u-123", "secret_member", "boss_login"];
// what Pepe sends (pepe_roomwarsfeed), with identities planted where a careless feed might put them
function push(revision, o = {}) {
  return Object.assign({
    password: "bot", revision, day: o.day || "2026-11-02", built_at: 1793599149, on: true,
    map: { rooms: Object.assign({
      You_Were_Never_Here: { name: "Players__lounge", tier: "center", i30: 245032, i7: 86934, eligible: true, dormant: false, bond: 4900640, upkeep: 6954,
                             perk_slots: 3, xy: [340, 340], secret_member: "zoltar214" },
      "PepeFrog.Room": { name: "Pepe's Pad", tier: "mid", i30: 131501, i7: 92200, eligible: true, dormant: false, bond: 2630020, upkeep: 7376, perk_slots: 2, xy: [540, 340] },
      DRAMA_CENTRAL: { name: "DRAMA_CENTRAL", tier: "outer", i30: 28880, i7: 0, eligible: false, dormant: true, bond: 0, upkeep: 3000, perk_slots: 2, xy: [100, 340] },
    }, o.rooms || {}) },
    room_control: o.control || { You_Were_Never_Here: { gang: FAM, bond: 5038340, bond_req: 4900640, since: 1793593920, perks: ["gunstore", "warehouse", "fightclub"],
                                                        lock_until: 4102000000, war_until: 0, upkeep_unpaid: 0, neglected: false, wars: 0,
                                                        upkeep_day: "2026-11-02", boss_login: "foamy1111", members: ["zoltar214"] } },
    convoys: o.convoys || [{ rid: "PepeFrog.Room", gang: null, kind: "payout", amount: 65414, until: 4102000000, taken: false, defenders: 1,
                             recips: ["recipient_login"], legs: [{ uid: "u-123" }] }],
    raid: o.raid === undefined ? { rid: "You_Were_Never_Here", attacker: FBGM, defender: FAM, phase: "lobby", crew: 3, defenders: 2,
                                   names: ["Raider One", "raider_one"], defender_names: ["defender_login"] } : o.raid,
    hit: null,
    perks: { autoshop: "Getaway Garage", fightclub: "Fight Night", gunstore: "Armory", warehouse: "Supply Depot", bunker: "Bunker", dispensary: "Cool-Down" },
    perks_live: ["autoshop", "gunstore", "warehouse"],
    rules: { release_h: 72, lock_h: 72, raid_buyin: 20000, hijack_buyin: 5000, convoy_min: 25000, convoy_s: 600, slash: 0.25, hijack_take: 0.2,
             min_crew: 2, raid_lobby_s: 45, payout_convoy_min: 25000, convoy_hour: 5, evil: "<script>" },
  }, o.extra || {});
}

let base, server, me = null;
const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, h), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (p) => fetch(base + p, { redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text(), loc: r.headers.get("location") }));
const getJ = (p, h = {}) => fetch(base + p, { headers: h }).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("INSERT INTO users (userId, username, password, class) VALUES ('u-admin', 'boss', 'x', 'Admin'), ('u-pleb', 'pleb', 'x', 'pleb')");
  await rooms.addRoom("You_Were_Never_Here", "Players__lounge", "test");
  await rooms.addRoom("PepeFrog.Room", "Pepe's Pad", "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { if (me) req.user = { userId: me, username: me }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  RW.register(app, deps);
  G.register(app, deps);
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await RW.init();
  await G.init();
});
test.after(() => server && server.close());

test("old bot + new site: nothing pushed -> empty states, no pad card, no gang rooms, the disband guard finds nothing", async () => {
  RW._reset();
  const page = await get("/gtf/roomwars");
  assert.equal(page.status, 200);
  assert.match(page.text, /The room map fills in as soon as Pepe reports in/);
  assert.match(page.text, /HOW IT WORKS/);
  assert.match(page.text, /!claim &lt;room&gt;/);
  const api = await getJ("/api/gtf/roomwars");
  assert.equal(api.body.live, false);
  assert.equal(await RW.forPad("You_Were_Never_Here"), null);
  assert.equal(await RW.forGang(FAM), null);
  assert.deepEqual(await RW.heldBy(FAM), []);
  assert.doesNotMatch(page.text, /rw\.[a-z_]+\.[a-z_]+|rw\.[a-z_]+(?=["<\s])/, "no raw i18n keys");
});

test("the push route: bot token only; the payload is whitelisted (no identities stored)", async () => {
  assert.equal((await post("/api/g/roomwars/state", Object.assign(push(100), { password: "nope" }))).status, 403);
  assert.equal((await post("/api/g/roomwars/state", Object.assign(push(100), { password: undefined }))).status, 403);
  assert.equal((await post("/api/g/roomwars/state", { password: "bot", revision: "x" })).status, 400);
  assert.equal((await post("/api/g/roomwars/state", { password: "bot", revision: -5 })).status, 400);
  const r = await post("/api/g/roomwars/state", push(100));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, revision: 100 });
  const row = (await getQuery("SELECT data FROM roomwars_state WHERE id = 1"))[0].data;
  for (const s of LEAKS) assert.ok(!row.includes(s), "not stored: " + s);
  assert.ok(!row.includes("<script>"), "an unknown rules key is dropped");
  const st = JSON.parse(row);
  assert.deepEqual(Object.keys(st.room_control.You_Were_Never_Here).sort(),
                   ["bond", "bond_req", "exposed_at", "gang", "lock_until", "neglected", "perks", "release_at", "since", "upkeep_day", "upkeep_unpaid", "war_until", "wars"]);
  assert.deepEqual(st.raid, { rid: "You_Were_Never_Here", attacker: FBGM, defender: FAM, phase: "lobby", crew: 3, defenders: 2 });
  assert.deepEqual(Object.keys(st.convoys[0]).sort(), ["amount", "defenders", "gang", "kind", "rid", "taken", "until"]);
  // odd rows are dropped, never fatal
  const odd = RW.clean({ revision: 5, map: { rooms: { "bad<id>": { name: "x" }, ok: null, fine: { name: "<b>Fine</b>", tier: "weird", xy: [9999, -5] } } },
                         room_control: { a: { gang: "not a gid!" }, b: "x", fine: { gang: FAM, perks: ["BAD", "gunstore", "gunstore"] } } });
  assert.deepEqual(Object.keys(odd.map.rooms), ["fine"]);
  assert.equal(odd.map.rooms.fine.tier, "outer");
  assert.deepEqual(odd.map.rooms.fine.xy, [680, 0]);
  assert.ok(!odd.map.rooms.fine.name.includes("<"));
  assert.deepEqual(Object.keys(odd.room_control), ["fine"]);
  assert.deepEqual(odd.room_control.fine.perks, ["gunstore"]);
});

test("idempotent by revision: same = same (only its seen time moves), older = 409 with the stored one, newer replaces; one history row per day", async () => {
  const u0 = (await getQuery("SELECT updated FROM roomwars_state WHERE id = 1"))[0].updated;
  const again = await post("/api/g/roomwars/state", push(100));
  assert.deepEqual(again.body, { ok: true, revision: 100, same: true });
  assert.equal((await getQuery("SELECT updated FROM roomwars_state WHERE id = 1"))[0].updated, u0, "a resend writes nothing");
  const old = await post("/api/g/roomwars/state", push(99));
  assert.equal(old.status, 409);
  assert.equal(old.body.code, "E_STALE");
  assert.equal(old.body.revision, 100);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM roomwars_history"))[0].n, 1);
  // a resend on the next day: that day gets its row (same revision, same data)
  await post("/api/g/roomwars/state", push(100, { day: "2026-11-03" }));
  const h = await getQuery("SELECT day, revision FROM roomwars_history ORDER BY day");
  assert.deepEqual(h.map((x) => [x.day, x.revision]), [["2026-11-02", 100], ["2026-11-03", 100]]);
  // a newer revision the same day replaces that day's row
  const nw = await post("/api/g/roomwars/state", push(101, { day: "2026-11-03" }));
  assert.deepEqual(nw.body, { ok: true, revision: 101 });
  assert.equal((await getQuery("SELECT revision FROM roomwars_history WHERE day = '2026-11-03'"))[0].revision, 101);
  assert.equal((await getQuery("SELECT revision FROM roomwars_history WHERE day = '2026-11-02'"))[0].revision, 100, "an earlier day keeps its row");
  // "may be out of date" follows Pepe's last push (a resend counts), not the last change
  const t0 = Date.now();
  RW._setClock(() => t0 + 4 * 3600e3);
  RW._reset();
  assert.equal((await RW.view()).stale, true, "4 h without a word -> stale");
  await post("/api/g/roomwars/state", push(101, { day: "2026-11-03" }));
  assert.equal((await RW.view()).stale, false, "a resend of the same revision -> fresh again");
  assert.equal((await getQuery("SELECT revision FROM roomwars_state WHERE id = 1"))[0].revision, 101);
  RW._setClock(null);
  RW._reset();
  const hist = await getJ("/api/gtf/roomwars/history?days=7");
  assert.equal(hist.body.days.length, 2);
  assert.equal(hist.body.days[0].day, "2026-11-03");
  assert.deepEqual(hist.body.days[0].rooms.You_Were_Never_Here, { gang: FAM, bond: 5038340, tag: null });
});

test("the feed switch off -> 503 and nothing stored; back on -> accepted", async () => {
  await RW.setCfg({ feed_on: false });
  const r = await post("/api/g/roomwars/state", push(150));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "E_OFF");
  assert.equal((await RW.latest()).revision, 101);
  await RW.setCfg({ feed_on: true });
});

test("the view: holders by gang (Pepe's mirror), colours, pad links, chips, the slice, dormant hidden; no identities", async () => {
  await G.putMirror({ gangs: { [FAM]: { name: "The Family", tag: "FAM", boss: "foamy1111", members: ["foamy1111", "zoltar214"], treasury: 2189455, rep: 1 },
                               [FBGM]: { name: "FBGM", tag: "FBGM", boss: "x_boss", members: ["x_boss"], treasury: 0, rep: 1 } } });
  // the pad vault's recipe days (roomvaults.js) - the slice of the last payout
  await require(path.join(repo, "roomvaults")).init();
  await runQuery("INSERT INTO room_vault_state (room_id, balance, days, history, updated, recipe) VALUES (?, 1, '{}', '[]', 1, ?)",
                 ["You_Were_Never_Here", JSON.stringify({ epochs: [{ day: "2026-11-01", gang: 0 }, { day: "2026-11-02", gang: 17250 }], games: null })]);
  RW._reset();
  const v = await RW.view();
  assert.equal(v.live, true);
  assert.deepEqual(v.rooms.map((r) => r.id), ["You_Were_Never_Here", "PepeFrog.Room"], "centre first; the dormant room hidden (decision 5 default)");
  assert.equal(v.all.length, 3);
  const pl = v.rooms[0];
  assert.equal(pl.state, "held");
  assert.equal(pl.held.tag, "FAM");
  assert.equal(pl.held.name, "The Family");
  assert.equal(pl.held.href, "/gtf/gangs/FAM");
  assert.equal(pl.held.color, RW.gangColor(FAM).bg);
  assert.match(pl.held.color, /^hsl\(\d+, 62%, 46%\)$/);
  assert.ok(pl.held.locked_until, "locked after the claim");
  assert.deepEqual(pl.held.perks.map((p) => [p.key, p.live]), [["gunstore", true], ["warehouse", true], ["fightclub", false]]);
  assert.deepEqual(pl.held.slice, { day: "2026-11-02", amount: 17250 });
  assert.ok(pl.pad && /^\/p\//.test(pl.pad.href), "a pad link");
  assert.equal(pl.raid.attacker.tag, "FBGM");
  assert.equal(v.rooms[1].state, "free");
  assert.equal(v.rooms[1].convoy.amount, 65414);
  assert.equal(v.rules.release_h, 72);
  const api = await getJ("/api/gtf/roomwars");
  const blob = JSON.stringify(api.body);
  for (const s of LEAKS) assert.ok(!blob.includes(s), "not in the API: " + s);
  await RW.setCfg({ show_dormant: true });
  assert.equal((await RW.view()).rooms.length, 3, "the switch shows dormant rooms");
  await RW.setCfg({ show_dormant: false, show_slice: false });
  assert.equal((await RW.view()).rooms[0].held.slice, null, "show_slice off: no slice");
  await RW.setCfg({ show_slice: true });
  // the ink is readable on the gang colour (WCAG: the better of white / near-black)
  for (const g of [FAM, FBGM, "aaaa1111", "zz99"]) assert.match(RW.gangColor(g).ink, /^#(ffffff|0b0b0b)$/);
});

test("the pages: the map page, /gtf/turf, the pad card, the gang section and the gang page - no identities anywhere", async () => {
  const page = await get("/gtf/roomwars");
  assert.equal(page.status, 200);
  for (const s of ["Players__lounge", "Pepe&#39;s Pad", "[FAM]", "The Family", "5,038,340", "Raid under way", "65,414", "id=\"rwData\"",
                   "/public/js/roomwars-map.js?v=1", "Fight Night", "not active yet", "17,250"]) assert.ok(page.text.includes(s), "page has " + s);
  assert.ok(!page.text.includes("DRAMA_CENTRAL"), "the dormant room is not drawn");
  for (const s of LEAKS) assert.ok(!page.text.includes(s), "not on the page: " + s);
  assert.doesNotMatch(page.text, /\brw\.(?:[a-z_]+\.)*[a-z_]+\b(?![.\w-]*\.(?:js|css))/, "no raw i18n keys");
  assert.match(page.text, /@media \(max-width: 600px\)/, "phone layout");
  const data = JSON.parse(page.text.match(/<script type="application\/json" id="rwData">([^<]*)<\/script>/)[1]);
  assert.equal(data.revision, 101);
  assert.deepEqual(Object.keys(data.rooms[0]).sort(), ["bond", "convoy", "held", "href", "id", "name", "raid", "state", "tier", "xy"]);
  const turf = await get("/gtf/turf");
  assert.equal(turf.status, 301);
  assert.equal(turf.loc, "/gtf/roomwars");

  const t = require(path.join(repo, "i18n-core.js"))(JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8")));
  const card = await ejs.renderFile(path.join(repo, "views/partials/pad-roomwar-card.ejs"), { rw: await RW.forPad("You_Were_Never_Here"), i18nT: t });
  for (const s of ["Room Wars", "[FAM]", "The Family", "5,038,340", "Supply Depot", "17,250", "games allowance", "/gtf/roomwars#room-You_Were_Never_Here"]) assert.ok(card.includes(s), "card has " + s);
  const free = await ejs.renderFile(path.join(repo, "views/partials/pad-roomwar-card.ejs"), { rw: await RW.forPad("PepeFrog.Room"), i18nT: t });
  assert.match(free, /<code>!claim Pepe&#39;s Pad<\/code>/);
  assert.match(free, /2,630,020/);
  // RW-SITE-4: Room Wars switched off in chat (Pepe pushes on: false) - no claim invitation Pepe would refuse, the "switched
  // off" line instead (as the map page's banner); a held room says so too
  const offFree = await ejs.renderFile(path.join(repo, "views/partials/pad-roomwar-card.ejs"),
                                       { rw: Object.assign({}, await RW.forPad("PepeFrog.Room"), { on: false }), i18nT: t });
  assert.doesNotMatch(offFree, /!claim/, "off: no claim command");
  assert.doesNotMatch(offFree, /Bond to claim/, "off: no bond to claim");
  assert.match(offFree, /Room Wars is switched off in chat right now/);
  const offHeld = await ejs.renderFile(path.join(repo, "views/partials/pad-roomwar-card.ejs"),
                                       { rw: Object.assign({}, await RW.forPad("You_Were_Never_Here"), { on: false }), i18nT: t });
  assert.match(offHeld, /\[FAM\]/);
  assert.match(offHeld, /Room Wars is switched off in chat right now/);
  assert.doesNotMatch(card + free, /switched off in chat/, "on: no off line");
  assert.equal(await RW.forPad("No_Such.Room"), null);
  for (const s of LEAKS) assert.ok(!(card + free).includes(s), "not on the card: " + s);

  const section = await ejs.renderFile(path.join(repo, "views/partials/gang-rooms.ejs"), { rw: await RW.forGang(FAM), i18nT: t });
  assert.match(section, /ROOMS HELD/);
  assert.match(section, /Players__lounge/);
  assert.match(section, /5,038,340 PAT locked in bonds/);
  const none = await ejs.renderFile(path.join(repo, "views/partials/gang-rooms.ejs"), { rw: await RW.forGang(FBGM), i18nT: t });
  assert.match(none, /No rooms right now/);
  assert.equal((await ejs.renderFile(path.join(repo, "views/partials/gang-rooms.ejs"), { rw: null, i18nT: t })).trim(), "", "nothing before Pepe's first push");

  const gp = await get("/gtf/gangs/FAM");
  assert.equal(gp.status, 200);
  assert.match(gp.text, /ROOMS HELD/);
  assert.match(gp.text, /Players__lounge/);
  // the pad page passes padRoomWar and room.ejs includes the card
  assert.match(fs.readFileSync(path.join(repo, "bridge.js"), "utf8"), /padRoomWar: await require\("\.\/roomwars"\)\.forPad\(R\.id\)/);
  assert.match(fs.readFileSync(path.join(repo, "views/room.ejs"), "utf8"), /include\('partials\/pad-roomwar-card'/);
});

test("the disband guard reads the latest copy (and its switch)", async () => {
  assert.deepEqual(await RW.heldBy(FAM), [{ id: "You_Were_Never_Here", name: "Players__lounge" }]);
  assert.deepEqual(await RW.heldBy(FBGM), []);
  await RW.setCfg({ disband_guard: false });
  assert.deepEqual(await RW.heldBy(FAM), []);
  await RW.setCfg({ disband_guard: true });
  // RW-SITE-5: only a copy Pepe is still confirming counts - the feed switched off (the copy frozen) or no push for 40 min
  // (Pepe backing off after a blip) and a room released in chat since would refuse the disband here; Pepe's guard decides
  await RW.setCfg({ feed_on: false });
  assert.deepEqual(await RW.heldBy(FAM), [], "feed off: the frozen copy doesn't refuse a disband");
  await RW.setCfg({ feed_on: true });
  assert.equal((await RW.heldBy(FAM)).length, 1, "feed back on: guarded");
  RW._reset();
  const seen0 = (await RW.latest()).seen;                 // Pepe's last push (an earlier test's clock may have set it ahead)
  RW._setClock(() => seen0 + 41 * 60e3);
  try {
    assert.deepEqual(await RW.heldBy(FAM), [], "no push for 40+ min: the guard stands aside");
    await post("/api/g/roomwars/state", push(101, { day: "2026-11-03" }));       // Pepe's 30-min resend: seen moves
    assert.equal((await RW.heldBy(FAM)).length, 1, "a resend confirms the copy: guarded again");
  } finally { RW._setClock(null); RW._reset(); }
  await post("/api/g/roomwars/state", push(102, { control: {} }));
  assert.deepEqual(await RW.heldBy(FAM), [], "released in the next push -> free to disband");
});

test("/gtf/london: only the seasons with a record (4 then 2), the final maps, no member names", async () => {
  const a = await RW.london();
  assert.deepEqual(a.seasons.map((s) => s.season), [4, 2]);
  const s4 = a.seasons[0];
  assert.equal(s4.winner.tag, "FAM");
  assert.equal(s4.pot, 2234749);
  assert.equal(s4.areas.length, 10);
  assert.equal(s4.areas.filter((x) => x.owner).length, 7);
  assert.equal(s4.held[0].n, 7);
  const page = await get("/gtf/london");
  assert.equal(page.status, 200);
  for (const s of ["Turf Wars: London", "Season 4", "Season 2", "2,234,749", "5,000,000", "Mayfair", "Canary Wharf", "[FAM]", "24,205",
                   "season-2-london.html", "No standings were saved for this season", "seasons that left a saved record: 2, 4"]) assert.ok(page.text.includes(s), "london has " + s);
  assert.ok(!/Season [13]\b/.test(page.text), "no season 1 or 3");
  for (const s of ["foamy1111", "tricon", "zoltar214", "dark_temptation", "members"]) assert.ok(!page.text.includes(s), "no member names: " + s);
  const raw = fs.readFileSync(path.join(repo, "data/turf-london.json"), "utf8");
  for (const s of ["foamy1111", "tricon", "zoltar214", "\"members\""]) assert.ok(!raw.includes(s), "the archive data holds no members: " + s);
  assert.doesNotMatch(page.text, /\brw\.ldn\.[a-z_]+/, "no raw i18n keys");
});

test("admin: the switches are admins-only and same-site fetch only", async () => {
  me = null;
  assert.equal((await getJ("/api/admin/roomwars-cfg")).status, 401);
  me = "u-pleb";
  assert.equal((await getJ("/api/admin/roomwars-cfg")).status, 403);
  me = "u-admin";
  const g = await getJ("/api/admin/roomwars-cfg");
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.cfg, { feed_on: true, disband_guard: true, show_slice: true, show_dormant: false });
  assert.equal(g.body.feed.revision, 102);
  assert.equal((await post("/api/admin/roomwars-cfg", { show_dormant: true })).status, 403, "no X-Requested-With: refused");
  const bad = await post("/api/admin/roomwars-cfg", { show_dormant: "yes" }, { "X-Requested-With": "fetch", origin: base });
  assert.equal(bad.status, 400);
  const ok = await post("/api/admin/roomwars-cfg", { show_dormant: true }, { "X-Requested-With": "fetch", origin: base });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.cfg.show_dormant, true);
  await RW.setCfg({ show_dormant: false });
  me = null;
  // the card is on /admin/games, never on the public page
  assert.match(fs.readFileSync(path.join(repo, "views/admin/games.ejs"), "utf8"), /admin-roomwars/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views/roomwars.ejs"), "utf8"), /admin-roomwars|roomwars-cfg/);
});

test("R2 site copy: /economy teaches Room Wars (no 'coming later'), the fight rake's real split; help's footer links the room map", async () => {
  const t = require(path.join(repo, "i18n-core.js"))(JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8")));
  const html = await ejs.renderFile(path.join(repo, "views/economy.ejs"), { user: null, treasury: null, roomVaults: null, ogBase: "http://t", i18nT: t },
                                    { views: [path.join(repo, "views")] });
  for (const s of ["Coming later", "room turf wars", "this season's map", "Fight Club turf business", "old turf businesses"]) {
    assert.ok(!html.includes(s), "stale London copy gone: " + s);
  }
  assert.match(html, /id="room-wars"/);
  assert.match(html, /<a href="\/gtf\/roomwars">the live room map<\/a>/);
  assert.match(html, /<a href="\/gtf\/london">Turf Wars: London<\/a>/);
  assert.match(html, /<code>!room claim<\/code>/);
  assert.match(html, /60% to the vault of the pad the fight was in/);
  assert.match(html, /now go to the vault of the pad where the game was played/);
  assert.doesNotMatch(html, /economy\.(gtf|fees)\.[a-z_]+/, "no raw i18n keys");
  const help = fs.readFileSync(path.join(repo, "views/help.ejs"), "utf8");
  assert.ok(!help.includes("pepe.publicaccess.tv/turfwars"), "help's footer no longer sends people to the frozen London guide");
  assert.match(help, /<a href="\/gtf\/roomwars"><%- t\('help\.foot\.turfwars'\) %><\/a>/);
  assert.equal(t("help.foot.turfwars"), "Room Wars map");
});

test("the GTF links point at the site pages", async () => {
  const gtf = require(path.join(repo, "gtf"));
  assert.equal(gtf.LINKS.turfMap, "/gtf/roomwars");
  assert.equal(gtf.LINKS.turfArchive, "/gtf/london");
  assert.equal(gtf.LINKS.turfGuide, "/gtf/roomwars#how");
});
