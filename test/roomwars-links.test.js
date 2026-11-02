// Room Wars R9 (room-wars plan 2026-11-02, 1.99??): shared-regular lines on the room map (roomwars.js cleanLinks / view,
// views/roomwars.ejs, public/js/roomwars-map.js). Pepe (pepe_roomlinks.py) sends links [{a, b, score}] in the R4a push.
//   * the push: only {a, b, score} between two rooms of the map is stored - a < b, the score re-rounded to 0.05, a pair once,
//     a sanity cap per room; a planted name / count / login on a line, a self line, an unknown or bad room id, a score that
//     isn't a number in (0, 1] are dropped; an older Pepe without links = no lines
//   * the views: lines only between two DRAWN rooms (a dormant end hides it until show_dormant); each drawn room lists the
//     rooms it shares regulars with; the API carries the lines
//   * the page: the lines ride the page's JSON, the legend explains them (only when there are any), the room cards say
//     "Shares regulars with ..." - no names anywhere
//   * the map script (in a vm with a small SVG DOM): a dashed line per link, under the room boxes, thicker for more overlap,
//     titled with the two rooms and the overlap; a line to a room that isn't drawn or with a bad score is skipped; the
//     minute poll redraws them from the API
//   NODE_PATH=G:/PATV/node_modules node --test test/roomwars-links.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roomwars-links-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const RW = require(path.join(repo, "roomwars"));
const rooms = require(path.join(repo, "rooms"));

const FAM = "bd6e773c";
const LOUNGE = "You_Were_Never_Here", PAD = "PepeFrog.Room", PLANTS = "plant_based_chatting", DRAMA = "DRAMA_CENTRAL";
const LEAKS = ["sharer_one", "Sharer One", "regular_login", "u-777", "zoltar214"];
function push(revision, links, extra) {
  return Object.assign({
    password: "bot", revision, day: "2026-11-02", built_at: 1793599149, on: true,
    map: { rooms: {
      [LOUNGE]: { name: "Players__lounge", tier: "center", i30: 245032, i7: 86934, eligible: true, dormant: false, bond: 4900640, upkeep: 6954, perk_slots: 3, xy: [340, 340] },
      [PAD]: { name: "Pepe's Pad", tier: "mid", i30: 131501, i7: 92200, eligible: true, dormant: false, bond: 2630020, upkeep: 7376, perk_slots: 2, xy: [540, 340] },
      [PLANTS]: { name: "Houseplants", tier: "outer", i30: 12000, i7: 9000, eligible: true, dormant: false, bond: 500000, upkeep: 3000, perk_slots: 2, xy: [630, 200] },
      [DRAMA]: { name: "DRAMA_CENTRAL", tier: "outer", i30: 28880, i7: 0, eligible: false, dormant: true, bond: 0, upkeep: 3000, perk_slots: 2, xy: [100, 340] },
    } },
    room_control: { [LOUNGE]: { gang: FAM, bond: 5038340, bond_req: 4900640, since: 1793593920, perks: ["warehouse"], lock_until: 0, war_until: 0,
                                upkeep_unpaid: 0, neglected: false, wars: 0, upkeep_day: "2026-11-02" } },
    convoys: [], raid: null, hit: null, perks: { warehouse: "Supply Depot" }, perks_live: ["warehouse"], rules: {},
  }, links === undefined ? {} : { links }, extra || {});
}
const LINKS = [
  { a: LOUNGE, b: PAD, score: 0.15, shared: 3, who: ["sharer_one", "Sharer One"] },     // Pepe sends a < b; extra fields are planted
  { a: PAD, b: PLANTS, score: 0.45 },
  { a: LOUNGE, b: DRAMA, score: 0.3, names: "regular_login" },                           // a dormant end: stored, not drawn by default
];

let base, server, me = null;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, text: await r.text() }));
const getJ = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await rooms.addRoom(LOUNGE, "Players__lounge", "test");
  await rooms.addRoom(PAD, "Pepe's Pad", "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { if (me) req.user = { userId: me, username: me }; next(); };
  RW.register(app, { isBotToken: (t) => t === "bot", addUser });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await RW.init();
});
test.after(() => server && server.close());

test("clean(): only {a, b, score} between two map rooms - ordered, re-rounded, once per pair, capped per room", () => {
  const ids = Object.keys(push(1).map.rooms);
  const st = RW.clean(push(1, [
    { a: PAD, b: LOUNGE, score: 0.149, shared: 3 },              // b < a: swapped; 0.149 -> 0.15
    { a: LOUNGE, b: PAD, score: 0.5 },                           // the same pair again (other order): dropped
    { a: PLANTS, b: PAD, score: 0.16, who: ["sharer_one"] },     // -> 0.15, the planted name gone
    { a: LOUNGE, b: LOUNGE, score: 1 },                          // a self line
    { a: LOUNGE, b: "Not_On_The_Map", score: 0.5 },              // an unknown room
    { a: "bad<id>", b: PAD, score: 0.5 },                        // a bad id
    { a: DRAMA, b: PAD, score: "0.5" },                          // not a number
    { a: DRAMA, b: PLANTS, score: 1.2 },                         // above 1
    { a: DRAMA, b: LOUNGE, score: 0 },                           // zero
    { a: DRAMA, b: LOUNGE, score: NaN },
    null, "x", 7,
    { a: DRAMA, b: LOUNGE, score: 0.333 },                       // -> 0.35
  ]));
  assert.deepEqual(st.links, [{ a: PAD, b: LOUNGE, score: 0.15 }, { a: PAD, b: PLANTS, score: 0.15 }, { a: DRAMA, b: LOUNGE, score: 0.35 }]);
  for (const l of st.links) assert.deepEqual(Object.keys(l).sort(), ["a", "b", "score"]);
  assert.ok(st.links.every((l) => ids.includes(l.a) && ids.includes(l.b) && l.a < l.b));
  assert.deepEqual(RW.clean(push(1)).links, [], "an older Pepe (no links) = no lines");
  assert.deepEqual(RW.clean(push(1, "nope")).links, []);
  // a room in at most 8 lines (a sanity cap; Pepe's own default is 4)
  const many = { revision: 2, map: { rooms: {} } };
  for (let i = 0; i < 12; i++) many.map.rooms["R" + i] = { name: "R" + i };
  many.links = Array.from({ length: 11 }, (_, i) => ({ a: "R0", b: "R" + (i + 1), score: 0.2 }));
  const capped = RW.clean(many).links;
  assert.equal(capped.length, 8);
  assert.ok(capped.every((l) => l.a === "R0"));
});

test("the push stores the lines and nothing about the people behind them; the views draw only lines between drawn rooms", async () => {
  RW._reset();
  const r = await post("/api/g/roomwars/state", push(100, LINKS));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await getQuery("SELECT data FROM roomwars_state WHERE id = 1"))[0].data;
  for (const s of LEAKS) assert.ok(!row.includes(s), "not stored: " + s);
  assert.ok(!row.includes("shared"), "no count is stored");
  assert.deepEqual(JSON.parse(row).links, [{ a: LOUNGE, b: PAD, score: 0.15 }, { a: PAD, b: PLANTS, score: 0.45 }, { a: LOUNGE, b: DRAMA, score: 0.3 }]
    .map((l) => (l.a < l.b ? l : { a: l.b, b: l.a, score: l.score })));

  const v = await RW.view();
  assert.deepEqual(v.links.map((l) => [l.a, l.b, l.score]).sort(), [[PAD, PLANTS, 0.45], [PAD, LOUNGE, 0.15]].sort(),
                   "the line to the dormant room isn't drawn");
  const pad = v.rooms.find((x) => x.id === PAD);
  assert.deepEqual(pad.shares.map((s) => [s.name, s.score]), [["Houseplants", 0.45], ["Players__lounge", 0.15]], "strongest first");
  assert.deepEqual(v.rooms.find((x) => x.id === LOUNGE).shares.map((s) => s.name), ["Pepe's Pad"]);
  const api = await getJ("/api/gtf/roomwars");
  assert.equal(api.status, 200);
  assert.deepEqual(api.body.links, v.links);
  const blob = JSON.stringify(api.body);
  for (const s of LEAKS) assert.ok(!blob.includes(s), "not in the API: " + s);

  await RW.setCfg({ show_dormant: true });
  assert.equal((await RW.view()).links.length, 3, "show_dormant draws the dormant room, and its line");
  await RW.setCfg({ show_dormant: false });
});

test("the page: the lines ride the page's JSON, the legend explains them, the cards name the rooms - never a person", async () => {
  RW._reset();
  const page = await get("/gtf/roomwars");
  assert.equal(page.status, 200);
  const data = JSON.parse(page.text.match(/<script type="application\/json" id="rwData">([^<]*)<\/script>/)[1]);
  assert.deepEqual(data.links.map((l) => [l.a, l.b, l.score]).sort(), [[PAD, PLANTS, 0.45], [PAD, LOUNGE, 0.15]].sort());
  assert.match(page.text, /id="rwLinksNote"/);
  assert.match(page.text, /A dashed line between two rooms means they share regulars/);
  assert.match(page.text, /never who, and only when at least 3 people are shared/);
  assert.match(page.text, /Shares regulars with Houseplants \(45%\), Players__lounge \(15%\)\./);
  assert.match(page.text, /Shares regulars with Pepe&#39;s Pad \(15%\)\./, "names are escaped");
  for (const s of LEAKS) assert.ok(!page.text.includes(s), "not on the page: " + s);
  assert.doesNotMatch(page.text, /\brw\.(?:[a-z_]+\.)*[a-z_]+\b(?![.\w-]*\.(?:js|css))/, "no raw i18n keys");

  // an older Pepe (no links): no legend line, no card line, an empty list for the script
  await post("/api/g/roomwars/state", push(101));
  RW._reset();
  const plain = await get("/gtf/roomwars");
  assert.doesNotMatch(plain.text, /rwLinksNote|Shares regulars with/);
  assert.deepEqual(JSON.parse(plain.text.match(/id="rwData">([^<]*)<\/script>/)[1]).links, []);
  assert.deepEqual((await getJ("/api/gtf/roomwars")).body.links, []);
});

// ── the map script in a vm: a small SVG DOM ──
const SRC = fs.readFileSync(path.join(repo, "public", "js", "roomwars-map.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
function node(name) {
  let own = "";
  const n = { name, attrs: {}, children: [], style: {}, parent: null,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; } };
  Object.defineProperty(n, "textContent", { get() { return own + n.children.map((c) => c.textContent).join(""); }, set(v) { own = String(v); n.children = []; } });
  return n;
}
const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
function boot(data, apiAnswer) {
  const box = node("div");
  box.clientWidth = 680;
  box.attrs = { "data-revision": String(data.revision || 1), "data-api": "/api/gtf/roomwars" };
  const dataEl = node("script");
  dataEl.textContent = JSON.stringify(data);
  const timers = [];
  const doc = { hidden: false, getElementById: (id) => ({ rwMap: box, rwData: dataEl, rwNew: { hidden: true } })[id] || null,
                createElementNS: (ns, name) => node(name), addEventListener() {} };
  const fetch = () => Promise.resolve({ json: () => Promise.resolve(apiAnswer) });
  const __t = (k, d, v) => String(en[k] != null ? en[k] : d).replace(/\{(\w+)\}/g, (m, x) => (v && v[x] != null ? v[x] : m));
  vm.runInNewContext(SRC, { window: { __t, addEventListener() {} }, document: doc, fetch, setInterval: (f) => timers.push(f), setTimeout, clearTimeout, console, Object, Math, Number, String, JSON, Array });
  return { box, poll: timers[0] };
}
const lines = (box) => all(box).filter((n) => n.name === "line" && n.attrs.class === "link");
const ROOMS = [
  { id: LOUNGE, name: "Players__lounge", tier: "center", xy: [340, 340], state: "held", bond: 4900640, held: { tag: "FAM", color: "hsl(1, 62%, 46%)", ink: "#ffffff" } },
  { id: PAD, name: "Pepe's Pad", tier: "mid", xy: [540, 340], state: "free", bond: 2630020 },
  { id: PLANTS, name: "Houseplants", tier: "outer", xy: [630, 200], state: "free", bond: 500000 },
];

test("the map script draws a dashed line per link, under the boxes, thicker for more overlap, titled without a person", async () => {
  const { box, poll } = boot({ revision: 7, rooms: ROOMS, links: [{ a: PAD, b: LOUNGE, score: 0.15 }, { a: PAD, b: PLANTS, score: 1 },
                                                                    { a: LOUNGE, b: DRAMA, score: 0.5 }, { a: PAD, b: PLANTS, score: 3 }] },
                             { ok: true, live: true, revision: 8, rooms: ROOMS.map((r) => Object.assign({}, r, { held: null })), links: [{ a: LOUNGE, b: PLANTS, score: 0.6 }] });
  const ls = lines(box);
  assert.equal(ls.length, 2, "a line to a room that isn't drawn, or with a score above 1, is skipped");
  const thin = ls.find((l) => /Players__lounge/.test(l.textContent)), thick = ls.find((l) => /Houseplants/.test(l.textContent));
  assert.ok(thin && thick);
  assert.deepEqual(["x1", "y1", "x2", "y2"].map((k) => thin.getAttribute(k)), ["540", "340", "340", "340"], "centre to centre");
  assert.deepEqual(["x1", "x2"].map((k) => thick.getAttribute(k)), ["540", "612"], "to the box centre the map clamps to the edge");
  assert.ok(Number(thick.getAttribute("stroke-width")) > Number(thin.getAttribute("stroke-width")), "a bigger overlap is thicker");
  assert.equal(thin.textContent, "Pepe's Pad and Players__lounge share regulars (15% overlap)");
  assert.equal(thin.getAttribute("aria-label"), thin.textContent);
  const svg = box.children[0];
  const order = svg.children.map((c) => (c.attrs.class === "links" ? "links" : c.name));
  assert.ok(order.indexOf("links") < order.indexOf("g") || order.indexOf("links") < order.indexOf("a"), "the lines sit under the room boxes");
  // the minute poll redraws them from the API
  poll();
  await new Promise((r) => setTimeout(r, 20));
  const after = lines(box);
  assert.equal(after.length, 1);
  assert.equal(after[0].textContent, "Players__lounge and Houseplants share regulars (60% overlap)");
  // an older page / API without links: no lines, no errors
  assert.equal(lines(boot({ revision: 1, rooms: ROOMS }, { ok: false }).box).length, 0);
});
