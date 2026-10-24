// S1 V2 (release L4; ADR 0007 D3, D5, D14, D15): chatwidget.js - v1 hosts the chat hub's widget and the mod-screen hosts.
//   - nothing without a manifest (or with a broken one), without the hub's origins, with CHAT_HUB off (or its table missing),
//     on a pad that isn't at chat_backend = 'hub', or on a Camfrog / profile pad: the page is exactly as before
//   - the mount: the hub pad id, its main room (rt-schema's padMainRoomId vectors), the slug, mode, locale, ?line=
//   - the page config: the hub's origins, the account hint, escaped for an inline script, never a ticket; the head's preconnect
//     and webfonts only on widget pages
//   - the vendored files' cache headers; /p/<slug>/mod (hub pads -> the chat moderation page, v1 pads keep the 301);
//     /admin/chat/<view> and the /admin overview card (who sees what, whatever CHAT_HUB says)
//   - a vendoring commit takes effect without a restart (manifest.json looked at again every RECHECK_MS)
//   NODE_PATH=G:/PATV/node_modules node --test test/chatwidget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatwidget-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.CHAT_GENESIS_NS;
process.env.SECRET_KEY = "test-secret";
const WS = "wss://rt-staging.publicaccess.tv", API = "https://rt-staging.publicaccess.tv";
process.env.HUB_RT_WS = WS;
process.env.HUB_RT_API = API;

const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {                     // the real schema (a staging dump + every CREATE in the source)
  const db = new (require("sqlite3").Database)(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const express = require("express");
const ejs = require("ejs");
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
let runQuery, getQuery, CW, rooms;

// ── a vendored widget in a temp directory (the export's layout: manifest.json + content-hashed files) ──
const ENTRY = "patv-chat.AbCd_-12.js";
const ENTRY_SRC = "export const x = 1;\n";
const sri = (s) => "sha384-" + crypto.createHash("sha384").update(s).digest("base64");
function widgetDir(name, { manifest, files } = {}) {
  const d = path.join(dir, name);
  fs.mkdirSync(path.join(d, "i18n"), { recursive: true });
  const f = files || { [ENTRY]: ENTRY_SRC, "patv-rt-worker.Zz9_-xYw.js": "self.x=1;\n", "i18n/de.Q1w2E3r4.json": "{}", "releases.json": "{}" };
  for (const [k, v] of Object.entries(f)) fs.writeFileSync(path.join(d, k), v);
  const m = manifest !== undefined ? manifest : { schema: 1, version: "0.1.0", entries: { chat: ENTRY, worker: "patv-rt-worker.Zz9_-xYw.js" }, sri: { [ENTRY]: sri(ENTRY_SRC) } };
  if (m !== null) fs.writeFileSync(path.join(d, "manifest.json"), typeof m === "string" ? m : JSON.stringify(m));
  return d;
}
let GOOD;

// ── people, pads, switches ──
const U = {};
const users = new Map();
async function mkUser(key, userId, cls) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [userId, key, key, cls]);
  U[key] = { userId, username: key, class: cls };
  users.set(userId, U[key]);
}
const HUB_PAD = "6f1c9a52-0b3e-4d7a-9e21-5c8b4f0a7d13";        // rt-schema golden/ids/pad-main.json's first vector
const HUB_ROOM = "a00bb223-2068-59c0-9077-feb7fad3b516";
const P = {
  hub: { id: "patv:hubpad", slug: "hub-pad" },
  v1: { id: "patv:v1pad", slug: "v1-pad" },
  cf: { id: "Frog Room", slug: "frog-room" },
  apr: { id: "patv:aprpad", slug: "apr-pad" },
};
async function setBackend(roomId, backend, hubPadId) {
  if (hubPadId) await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = ?", [hubPadId, roomId]);
  await runQuery("UPDATE pad_hub SET chat_backend = ? WHERE room_id = ?", [backend, roomId]);
}
/** CHAT_HUB as release L1's chat_switches stores it (key, value 'on' | 'off'); null = no table at all. */
async function setChatHub(v) {
  await runQuery("DROP TABLE IF EXISTS chat_switches");
  if (v === null) return;
  await runQuery("CREATE TABLE chat_switches (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, updated_by TEXT)");
  if (v !== undefined) await runQuery("INSERT INTO chat_switches (key, value) VALUES ('CHAT_HUB', ?)", [v]);
}
const reqAs = (u, query = {}) => ({ user: u || null, query });
const resWith = (lang = "en") => ({ locals: { lang } });
/** The 18+ gate (adultgate.js) on with this pad marked 18+, or both off again. */
async function setAdult(roomId, on) {
  await rooms.setPage(roomId, { adult: on }, "test");
  await require(path.join(repo, "adultgate")).setEnabled(on, U.adm, "test");
}

let base, server;
test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  rooms = require(path.join(repo, "rooms"));
  await rooms.init();
  for (const p of Object.values(P)) await runQuery("INSERT INTO rooms_registry (room_id, slug, title, created, updated) VALUES (?, ?, ?, 1, 1)", [p.id, p.slug, p.slug]);
  await runQuery("INSERT INTO pad_access (room_id, level, updated) VALUES (?, 'approved', 1)", [P.apr.id]);
  await require(path.join(repo, "padhub")).init();
  await rooms.loadCache();
  await setBackend(P.hub.id, "hub", HUB_PAD);
  await setBackend(P.cf.id, "hub");                     // a Camfrog pad forced to 'hub' (V1's form refuses it): still never mounts
  await setBackend(P.apr.id, "hub");
  await mkUser("fan", "11111111-2222-4333-8444-555555555555", "pleb");
  await mkUser("legacy", "legacy_id_1", "pleb");        // a legacy id: no hub account while CHAT_GENESIS_NS is unset
  await mkUser("asst", "21111111-2222-4333-8444-555555555555", "Assistant");
  await mkUser("staff", "31111111-2222-4333-8444-555555555555", "Staff");
  await mkUser("adm", "41111111-2222-4333-8444-555555555555", "Admin");
  // a session whose class is stale: its JWT says Admin, the database says a member (the admin pages read the database)
  await mkUser("demoted", "51111111-2222-4333-8444-555555555555", "pleb");
  U.demoted = { ...U.demoted, class: "Admin" };
  users.set(U.demoted.userId, U.demoted);
  CW = require(path.join(repo, "chatwidget"));
  GOOD = widgetDir("good");
  CW._setDir(GOOD);
  await setChatHub("on");

  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => {
    const h = req.get("x-test-user");
    req.user = h ? users.get(h) || null : undefined;
    req.flash = () => [];
    res.locals.ogBase = "http://test";
    res.locals.ogPath = req.originalUrl.split("?")[0];
    next();
  });
  const addUser = (req, res, next) => { if (req.user === undefined) req.user = null; next(); };
  app.use("/public/js/patv-chat", (req, res, next) => CW.staticFiles(GOOD)(req, res, next));
  app.use("/public", (req, res) => res.status(418).end());     // the general /public static comes after: never reached for a file there
  // index.js's order: pads (its 301s and /p/<slug>/mod), padaccess's page gate, ... the pad page (bridge.js) - and chatwidget's admin views
  require(path.join(repo, "pads")).register(app, { addUser });
  CW.register(app, { addUser });
  require(path.join(repo, "padaccess")).register(app, { addUser });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: () => false });
  app.use((req, res) => res.status(404).send("not found"));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

async function get(p, u) {
  const r = await fetch(base + p, { headers: u ? { "x-test-user": u.userId } : {}, redirect: "manual" });
  return { status: r.status, loc: r.headers.get("location"), cc: r.headers.get("cache-control"), h: r.headers, text: await r.text() };
}

// ── nothing changes until every piece exists ──
test("no manifest, a broken manifest or no hub origins: no widget anywhere (forPad null, no tools)", async () => {
  const opts = { roomId: P.hub.id, slug: P.hub.slug, platform: "site" };
  assert.equal((await CW.forPad(reqAs(U.fan), resWith(), opts)).state, "mount", "the control case mounts");
  const broken = {
    none: null,
    json: "{nope",
    schema: { schema: 2, entries: { chat: ENTRY }, sri: { [ENTRY]: sri(ENTRY_SRC) } },
    path: { schema: 1, entries: { chat: "../" + ENTRY }, sri: { ["../" + ENTRY]: sri(ENTRY_SRC) } },
    nosri: { schema: 1, entries: { chat: ENTRY }, sri: {} },
    badsri: { schema: 1, entries: { chat: ENTRY }, sri: { [ENTRY]: "md5-xyz" } },
    mismatch: { schema: 1, entries: { chat: ENTRY }, sri: { [ENTRY]: sri("other bytes") } },
    missing: { schema: 1, entries: { chat: "patv-chat.Gone1234.js" }, sri: { "patv-chat.Gone1234.js": sri(ENTRY_SRC) } },
  };
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    for (const [name, m] of Object.entries(broken)) {
      CW._setDir(widgetDir("bad-" + name, { manifest: m }));
      assert.equal(CW.manifest(), null, name + ": no usable manifest");
      const res = resWith();
      assert.equal(await CW.forPad(reqAs(U.fan), res, opts), null, name + ": no mount");
      assert.equal(res.locals.chatWidget, undefined, name + ": nothing for the views");
      assert.equal(CW.toolsFor(reqAs(U.fan), resWith()).state, "off", name + ": no modtools");
      assert.equal(CW.status().version, null);
    }
  } finally { console.error = orig; }
  assert.ok(errs.every((l) => /^\[chatwidget\] widget off: /.test(l)), "a reason, one line each: " + errs.join(" | "));
  assert.ok(!errs.some((l) => /no manifest/.test(l)), "no manifest at all is silent (the normal state before the first export)");
  CW._setDir(GOOD);
  assert.deepEqual(CW.status(), { version: "0.1.0", entry: ENTRY, why: null, hub: true });

  for (const [ws, api] of [["", ""], [WS, ""], ["", API], ["ws://rt.publicaccess.tv", API], [WS, "http://rt.publicaccess.tv"],
                           [WS + "/hcp/v1", API], [WS, API + "/v1"], [WS, API + "?x=1"], ["https://rt.publicaccess.tv", API], [WS, "wss://rt.publicaccess.tv"]]) {
    process.env.HUB_RT_WS = ws; process.env.HUB_RT_API = api;
    assert.equal(CW.rtConfig(), null, `refused: ${ws} | ${api}`);
    assert.equal(await CW.forPad(reqAs(U.fan), resWith(), opts), null);
    assert.equal(CW.toolsFor(reqAs(U.fan), resWith()).state, "off");
  }
  process.env.HUB_RT_WS = "ws://127.0.0.1:8090"; process.env.HUB_RT_API = "http://localhost:8090/";
  assert.deepEqual(CW.rtConfig(), { ws: "ws://127.0.0.1:8090", api: "http://localhost:8090" }, "plain schemes only to loopback (a local rooms)");
  process.env.HUB_RT_WS = WS; process.env.HUB_RT_API = API;
  assert.deepEqual(CW.rtConfig(), { ws: WS, api: API });
});

test("CHAT_HUB: a missing table, no row, 'off' or anything but exactly 'on' mounts nothing; 'on' mounts; read on every page (a rollback is the next load)", async () => {
  const opts = { roomId: P.hub.id, slug: P.hub.slug, platform: "site" };
  // exactly 'on', as release L1's chatswitches (get('CHAT_HUB') === 'on') and the hub's mirror read it - never looser than they are
  for (const v of [null, undefined, "off", "true", "1", "ON", "On", "ON ", " on", "on ", "on\n", ""]) {
    await setChatHub(v);
    const got = await CW.forPad(reqAs(U.fan), resWith(), opts);
    assert.equal(got, null, "CHAT_HUB " + JSON.stringify(v));
    assert.equal(await CW.hubOn(), false, "hubOn " + JSON.stringify(v));
    assert.equal(await require(path.join(repo, "chatswitches")).chatHubOnNow(), false, "release L1's reader agrees");
  }
  await setChatHub("on");
  assert.equal(await CW.hubOn(), true);
  assert.equal((await CW.forPad(reqAs(U.fan), resWith(), opts)).state, "mount");
  await setChatHub("off");
  assert.equal(await CW.forPad(reqAs(U.fan), resWith(), opts), null, "off -> gone on the next page, nothing cached");
  assert.equal(await CW.forPad(reqAs(null), resWith(), opts), null, "no teaser either");
  assert.equal(CW.toolsFor(reqAs(U.fan), resWith()).state, "tools", "modtools stay whatever CHAT_HUB says (D3)");
  await setChatHub("on");
});

test("mounts only for a site pad at chat_backend = 'hub' (an allow-list): never a v1 pad, a Camfrog, profile, Twitch or Discord pad", async () => {
  const at = (p, platform) => CW.forPad(reqAs(U.fan), resWith(), { roomId: p.id, slug: p.slug, platform });
  for (const [p, ok] of [["site", true], ["camfrog", false], ["profile", false], ["twitch", false], ["discord", false], ["", false], [undefined, false],
                         [null, false], ["Site", false], ["SITE ", false]]) assert.equal(CW.platformOk(p), ok, "platformOk " + JSON.stringify(p));
  assert.equal(await at(P.v1, "site"), null, "chat_backend v1");
  assert.equal(await at(P.cf, "camfrog"), null, "a Camfrog pad, even forced to hub");
  assert.equal(await at(P.cf), null, "a Camfrog pad by its id (rooms.platformOf)");
  assert.equal(await at(P.cf, "site"), null, "the registry decides too: a caller calling a Camfrog pad a site pad changes nothing");
  assert.equal(await at(P.hub, "profile"), null, "a profile pad");
  for (const pl of ["twitch", "discord"]) assert.equal(await at(P.hub, pl), null, "a " + pl + " pad");
  // padconnect's Twitch / Discord connect turns a SITE pad into one and keeps its id - and so its pad_hub row. Release L1's
  // pad_hub_site_only trigger (S1 Q4, padhub.js) moves that row back to 'v1'; the allow-list must hold without it too, so the
  // row is then forced back to 'hub' (as one written before the trigger existed would be)
  for (const pl of ["twitch", "discord"]) {
    await runQuery("UPDATE rooms_registry SET platform = ? WHERE room_id = ?", [pl, P.hub.id]);
    await rooms.loadCache();
    try {
      assert.equal(rooms.platformOf(P.hub.id), pl);
      assert.equal((await getQuery("SELECT chat_backend FROM pad_hub WHERE room_id = ?", [P.hub.id]))[0].chat_backend, "v1",
        "connected to " + pl + ": Q4's trigger moved the pad back to v1 chat");
      await setBackend(P.hub.id, "hub");
      assert.equal(await at(P.hub), null, "connected to " + pl + ": no widget (by its registry row)");
      assert.equal(await at(P.hub, "site"), null, "...whatever the caller says");
      const mod = await get("/p/hub-pad/mod", U.fan);
      assert.equal(mod.status, 301, pl + ": /p/<slug>/mod keeps the 301");
      assert.equal(mod.loc, "/p/hub-pad/settings?tab=moderation");
    } finally {
      await runQuery("UPDATE rooms_registry SET platform = NULL WHERE room_id = ?", [P.hub.id]);
      await rooms.loadCache();
      await setBackend(P.hub.id, "hub");                // a site pad again; Q4's trigger had moved it to v1 (an admin moves it back)
    }
  }
  assert.equal((await at(P.hub)).state, "mount", "a site pad again, at hub: the widget is back");
  assert.equal(await at({ id: "patv:nowhere", slug: "nowhere" }, "site"), null, "no pad_hub row");
  await setBackend(P.v1.id, "hub_read");
  assert.equal(await at(P.v1, "site"), null, "hub_read (S2) isn't hub");
  await setBackend(P.v1.id, "v1");
  const m = await at(P.hub);                            // platform from the registry id (patv: -> site)
  assert.equal(m.state, "mount");
  assert.deepEqual(m.mount, { pad: HUB_PAD, room: HUB_ROOM, slug: "hub-pad", mode: "full", theme: "dark", locale: "en", line: null });
});

test("the mount: compact mode, the page's locale, ?line= passed through only as a positive integer", async () => {
  const opts = { roomId: P.hub.id, slug: "Hub-Pad", platform: "site" };
  const m = (q, lang, extra = {}) => CW.forPad(reqAs(U.fan, q), resWith(lang), { ...opts, ...extra }).then((x) => x.mount);
  assert.equal((await m({}, "en", { mode: "compact" })).mode, "compact");
  assert.equal((await m({}, "en", { mode: "weird" })).mode, "full");
  assert.equal((await m({}, "pt-BR")).locale, "pt-BR");
  assert.equal((await m({}, "zh-TW")).locale, "zh-TW");
  assert.equal((await m({}, "x\"><script>")).locale, "en");
  assert.equal((await m({})).slug, "hub-pad", "lower-cased");
  assert.equal((await m({}, "en", { slug: "under_score" })).slug, null, "a slug the widget would refuse isn't passed");
  for (const [line, want] of [["42", "42"], ["9007199254740991", "9007199254740991"], ["0", null], ["-1", null], ["1e3", null], ["abc", null],
                              ["9007199254740993", null], ["12345678901234567", null], [["1", "2"], null], [" 7", null]]) {
    assert.equal((await m({ line })).line, want, "line " + JSON.stringify(line));
  }
});

test("signed out: the 'Sign in to chat' teaser (no widget download); behind the 18+ gate: its card; no hub account id: a note", async () => {
  const opts = { roomId: P.hub.id, slug: P.hub.slug, platform: "site" };
  const out = await CW.forPad(reqAs(null), resWith(), opts);
  assert.deepEqual(out, { state: "signin", next: "/p/hub-pad" }, "no head, no boot: nothing loads");
  assert.deepEqual(await CW.forPad(reqAs(null, { line: "42" }), resWith(), opts), { state: "signin", next: "/p/hub-pad?line=42" }, "the way back keeps the line");
  assert.deepEqual(await CW.forPad(reqAs(null, { line: "4x" }), resWith(), opts), { state: "signin", next: "/p/hub-pad" }, "...a valid one only");
  // padaccess decides, read by forPad itself (no caller passes it): the 18+ gate (switch on, an 18+ pad) ...
  await setAdult(P.hub.id, true);
  try {
    assert.deepEqual(await CW.forPad(reqAs(null), resWith(), opts), { state: "gate", gate: "signin", next: "/p/hub-pad" });
    assert.deepEqual(await CW.forPad(reqAs(U.fan, { line: "7" }), resWith(), opts), { state: "gate", gate: "confirm", next: "/p/hub-pad?line=7" });
    assert.equal((await CW.forPad(reqAs(U.staff), resWith(), opts)).state, "mount", "site staff are exempt from the 18+ gate");
  } finally { await setAdult(P.hub.id, false); }
  assert.equal((await CW.forPad(reqAs(U.fan), resWith(), opts)).state, "mount", "the switch off again: the chat");
  // ... and the pad's level: an Approved pad's outsider gets nothing (padaccess.full), staff are inside every Approved pad
  const apr = { roomId: P.apr.id, slug: P.apr.slug, platform: "site" };
  assert.equal(await CW.forPad(reqAs(U.fan), resWith(), apr), null, "a viewer padaccess keeps out gets nothing");
  assert.equal((await CW.forPad(reqAs(U.staff), resWith(), apr)).state, "mount");
  assert.deepEqual(await CW.forPad(reqAs(U.legacy), resWith(), opts), { state: "unavailable" });
  process.env.CHAT_GENESIS_NS = "8c6f2a52-1b3e-4d7a-9e21-5c8b4f0a7d13";
  try {
    const m = await CW.forPad(reqAs(U.legacy), resWith(), opts);
    assert.equal(m.state, "mount", "with the namespace a legacy id has its uuidv5");
    assert.equal(JSON.parse(m.boot.configJson).acct, require("uuid").v5("legacy_id_1", process.env.CHAT_GENESIS_NS));
  } finally { delete process.env.CHAT_GENESIS_NS; }
  const res = resWith();
  await CW.forPad(reqAs(U.fan), res, opts);
  assert.equal(res.locals.chatWidget.state, "mount", "res.locals.chatWidget is what the views read");
});

test("the page config: the hub's origins, the image base and the account hint - never a ticket; escaped for an inline script", async () => {
  const m = await CW.forPad(reqAs(U.fan), resWith(), { roomId: P.hub.id, slug: P.hub.slug, platform: "site" });
  assert.deepEqual(JSON.parse(m.boot.configJson), { ws: WS, api: API, assets: "/public/img/", acct: U.fan.userId });
  assert.doesNotMatch(m.boot.configJson, /token|ticket|kid|sid/i);
  assert.equal(m.boot.script, "/public/js/patv-chat/" + ENTRY);
  assert.equal(m.boot.integrity, sri(ENTRY_SRC));
  assert.deepEqual(m.head, { preconnect: [API], fonts: CW.FONTS_HREF }, "one preconnect when the socket and REST share a host");
  process.env.HUB_RT_WS = "wss://ws.publicaccess.tv";
  try {
    const m2 = await CW.forPad(reqAs(U.fan), resWith(), { roomId: P.hub.id, slug: P.hub.slug, platform: "site" });
    assert.deepEqual(m2.head.preconnect, [API, "https://ws.publicaccess.tv"], "the socket's host too when it differs");
  } finally { process.env.HUB_RT_WS = WS; }
  const evil = { a: "</script><script>alert(1)</script>", b: "x" + LS + "y" + PS + "z" };
  const s = CW.escJson(evil);
  assert.doesNotMatch(s, /</, "no '<' (no </script> break-out)");
  assert.ok(!s.includes(LS) && !s.includes(PS), "no raw line / paragraph separators");
  assert.deepEqual(JSON.parse(s), evil, "still the same JSON");
});

test("padMainRoomId = uuidv5(NS_PAD_MAIN, hub_pad_id): rt-schema's golden vectors (golden/ids/pad-main.json)", () => {
  assert.equal(CW.NS_PAD_MAIN, "a38452d6-3527-4dab-bfd9-8c94d9dd47a3");
  for (const [pad, room] of [["6f1c9a52-0b3e-4d7a-9e21-5c8b4f0a7d13", "a00bb223-2068-59c0-9077-feb7fad3b516"],
                             ["00000000-0000-4000-8000-000000000000", "190fc876-3f9a-5f2e-a1a5-2b6cf85936f3"],
                             ["ffffffff-ffff-4fff-bfff-ffffffffffff", "87737389-62c2-5158-be5b-a1f36e2fb4c0"],
                             ["c0ffee00-1234-4abc-9def-0123456789ab", "80df8d63-44d7-5b0f-806f-68fac26ae164"]]) {
    assert.equal(CW.padMainRoomId(pad), room, pad);
    assert.equal(CW.padMainRoomId(pad.toUpperCase()), room, "case-insensitive");
  }
  assert.equal(require("uuid").v5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2", "RFC 9562's DNS vector");
  assert.throws(() => CW.padMainRoomId("not-a-uuid"));
});

// ── the views ──
const ROOM = { id: P.hub.id, name: "Hub Pad", slug: P.hub.slug, count: 0, live: false, topic: "", platform: "site", siteOnly: true, bridged: false, description: "", owner: null };
const roomPage = (locals) => ejs.renderFile(path.join(repo, "views", "room.ejs"), { user: "fan", signedIn: true, linked: false, room: ROOM, initial: null, stage: {},
  latest: [], padTabs: { tabs: ["live", "about"], initial: "live", active: false, camfrog: false, posts: [] }, ...locals });

test("room.ejs: the hub pad's Live tab gets <patv-chat>, its config and script once, the head its preconnect + webfonts; else nothing", async () => {
  const before = await roomPage({});
  for (const s of ["patv-chat", "patv-modtools", "rt-staging", "Nunito", "Comic+Neue"]) assert.ok(!before.includes(s), "no " + s + " without the widget");
  const res = resWith();
  await CW.forPad(reqAs(U.fan, { line: "77" }), res, { roomId: P.hub.id, slug: P.hub.slug, platform: "site" });
  const html = await roomPage({ chatWidget: res.locals.chatWidget });
  assert.equal((html.match(/<patv-chat /g) || []).length, 1);
  assert.match(html, new RegExp(`<patv-chat pad="${HUB_PAD}" room="${HUB_ROOM}" slug="hub-pad" mode="full" theme="dark" locale="en" line="77"`));
  assert.equal((html.match(/id="patv-chat-config"/g) || []).length, 1, "one config per page");
  assert.equal((html.match(/<script type="module" src="\/public\/js\/patv-chat\//g) || []).length, 1, "one module script per page");
  assert.ok(html.includes(`integrity="${sri(ENTRY_SRC)}"`));
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(head.includes(`<link rel="preconnect" href="${API}" crossorigin>`), "the preconnect is in the head (D5)");
  assert.ok(head.includes(`<link href="${CW.FONTS_HREF.replace(/&/g, "&amp;")}" rel="stylesheet">`), "the webfonts are in the head (D14)");
  assert.ok(html.indexOf("<patv-chat ") > html.indexOf('id="padPanel-live"'), "on the Live tab");
  const cfg = html.slice(html.indexOf('id="patv-chat-config">') + 22, html.indexOf("</script>", html.indexOf('id="patv-chat-config">')));
  assert.deepEqual(JSON.parse(cfg), { ws: WS, api: API, assets: "/public/img/", acct: U.fan.userId });

  const teaser = await roomPage({ chatWidget: await CW.forPad(reqAs(null), resWith(), { roomId: P.hub.id, slug: P.hub.slug, platform: "site" }), signedIn: false, user: null });
  assert.ok(!teaser.includes("<patv-chat") && !teaser.includes("patv-chat-config") && !teaser.includes("rt-staging"), "signed out: no widget, no preconnect");
  assert.match(teaser, /data-hub-chat="signin"[\s\S]*Sign in to chat[\s\S]*href="\/login\?next=%2Fp%2Fhub-pad"/);
  const gated = await roomPage({ chatWidget: { state: "gate", gate: "confirm", next: "/p/hub-pad" } });
  assert.match(gated, /data-adult-gate="confirm"/);
  assert.ok(!gated.includes("<patv-chat"));
  const none = await roomPage({ chatWidget: { state: "unavailable" } });
  assert.match(none, /data-hub-chat="unavailable"/);
  // a Camfrog pad's page never reaches the site branch's mount, even if handed one
  const cf = await roomPage({ room: { ...ROOM, platform: "camfrog", siteOnly: false, bridged: true, camfrogName: "Frog Room" }, initial: null, liveOpen: false,
                              padTabs: { tabs: ["live", "about"], initial: "live", active: false, camfrog: true, posts: [] }, chatWidget: res.locals.chatWidget });
  assert.ok(!cf.includes("<patv-chat "), "the mount is the site-pad branch's only");
});

const homePage = (locals) => ejs.renderFile(path.join(repo, "views", "home.ejs"), { username: "fan", me: null, mine: null, S: {}, rooms: [],
  room: { id: P.hub.id, name: "Hub Pad", slug: P.hub.slug, count: 0, live: false, topic: "" }, roomLive: { room: {}, feed: [] }, roomGate: "ok",
  stage: { active: false }, top: [], tops: [], story: { rooms: [], caps: [], room: null, signed: false, compose: false }, hot: null, banner: null,
  roomOnStage: false, stageAdmin: null, frontInfo: null, pepeHere: false, slots: [], nextUp: null, staff: false, ...locals });

test("home.ejs: the panel's hub pad gets the compact <patv-chat> instead of the bridge's live room (no poller, no room-bridge.js)", async () => {
  const before = await homePage({});
  assert.ok(before.includes('id="lrInit"') && before.includes('id="lrFeed"'), "the control: the live room and its poller");
  assert.ok(!before.includes("patv-chat"));
  const res = resWith();
  await CW.forPad(reqAs(U.fan), res, { roomId: P.hub.id, slug: P.hub.slug, mode: "compact" });
  const html = await homePage({ chatWidget: res.locals.chatWidget });
  assert.match(html, /<patv-chat pad="[^"]+" room="[^"]+" slug="hub-pad" mode="compact"/);
  assert.ok(!html.includes('id="lrInit"') && !html.includes('id="lrFeed"') && !html.includes("room-bridge.js"), "the v1 live room isn't drawn or polled");
  assert.ok(html.slice(0, html.indexOf("</head>")).includes(`rel="preconnect" href="${API}"`));
  const gated = await homePage({ roomGate: "confirm", chatWidget: res.locals.chatWidget });
  assert.ok(!gated.includes("<patv-chat") && /data-adult-gate="confirm"/.test(gated), "the 18+ card comes first");
  const teaser = await homePage({ username: null, roomLive: null, chatWidget: { state: "signin", next: "/p/hub-pad" } });
  assert.match(teaser, /data-hub-chat="signin"/);
  assert.ok(!teaser.includes("<patv-chat") && !teaser.includes('id="lrInit"'));
});

test("the text styles' webfonts: FONTS_HREF + the layout's own link cover every registry webfont, valid weights only", () => {
  const reg = JSON.parse(fs.readFileSync(path.join(repo, "chat-text-styles.json"), "utf8"));
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  const fams = (href) => [...href.matchAll(/family=([^&:"]+)/g)].map((m) => decodeURIComponent(m[1].replace(/\+/g, " ")));
  const layoutFams = fams(/https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/.exec(layout)[0]);
  const ours = fams(CW.FONTS_HREF);
  const want = Object.values(reg.fonts).map((f) => f.webfont).filter(Boolean);
  for (const w of want) assert.ok(layoutFams.includes(w) || ours.includes(w), w + " is loaded on widget pages");
  for (const f of ours) assert.ok(want.includes(f), f + " is a registry webfont");
  assert.ok(!ours.some((f) => layoutFams.includes(f)), "nothing loaded twice");
  assert.match(CW.FONTS_HREF, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Comic\+Neue:wght@400;700&family=Nunito:wght@400;700&display=swap$/);
});

// ── the vendored files ──
test("/public/js/patv-chat/: hashed files immutable, manifest.json / releases.json / unhashed files revalidated, nosniff on all", async () => {
  fs.writeFileSync(path.join(GOOD, "plain.js"), "x");
  for (const [f, cc] of [[ENTRY, "public, max-age=31536000, immutable"], ["patv-rt-worker.Zz9_-xYw.js", "public, max-age=31536000, immutable"],
                         ["i18n/de.Q1w2E3r4.json", "public, max-age=31536000, immutable"], ["manifest.json", "no-cache"], ["releases.json", "no-cache"],
                         ["plain.js", "no-cache"]]) {
    const r = await get("/public/js/patv-chat/" + f);
    assert.equal(r.status, 200, f);
    assert.equal(r.cc, cc, f);
    assert.equal(r.h.get("x-content-type-options"), "nosniff", f);
  }
  assert.match((await get("/public/js/patv-chat/" + ENTRY)).h.get("content-type"), /javascript/);
  assert.equal((await get("/public/js/patv-chat/nope.Abcdefgh.js")).status, 418, "a miss falls through (to the general /public, then a 404)");
  assert.equal((await get("/public/js/patv-chat/")).status, 418, "no directory index");
  assert.equal((await get("/public/js/patv-chat/..%2fmanifest.json")).status, 418, "no traversal");
});

// ── /p/<slug>/mod ──
test("/p/<slug>/mod: a v1 pad, a Camfrog pad or no widget keeps the 301 to the settings' Moderation tab; a hub pad needs a sign-in", async () => {
  assert.equal((await get("/p/v1-pad/mod", U.fan)).loc, "/p/v1-pad/settings?tab=moderation");
  assert.equal((await get("/p/v1-pad/mod?x=1", U.fan)).loc, "/p/v1-pad/settings?x=1&tab=moderation", "the query kept, as before");
  assert.equal((await get("/p/frog-room/mod", U.fan)).status, 301, "a Camfrog pad");
  assert.equal((await get("/p/no-such-pad/mod", U.fan)).status, 301, "an unknown slug: the settings hub decides");
  const out = await get("/p/hub-pad/mod");
  assert.equal(out.status, 302);
  assert.equal(out.loc, "/login?next=%2Fp%2Fhub-pad%2Fmod");
  // signed out: sign in first for EVERY slug while the widget is installed - the answer never tells a visitor which pads are on
  // the hub (the address comes back here after the sign-in, and routes by the pad then)
  for (const sl of ["v1-pad", "frog-room", "apr-pad", "no-such-pad"]) {
    const r = await get("/p/" + sl + "/mod");
    assert.equal(r.status, 302, sl);
    assert.equal(r.loc, "/login?next=" + encodeURIComponent("/p/" + sl + "/mod"), sl);
  }
  assert.equal((await get("/p/hub-pad/mod?view=bans")).loc, "/login?next=%2Fp%2Fhub-pad%2Fmod%3Fview%3Dbans", "a pad view kept");
  assert.equal((await get("/p/hub-pad/mod?view=%22%3E%3Cx")).loc, "/login?next=%2Fp%2Fhub-pad%2Fmod", "...only a pad view");
  assert.equal((await get("/p/a%22b%3C/mod")).loc, "/login?next=" + encodeURIComponent("/p/a%22b%3C/mod"), "the slug encoded");
  CW._setDir(widgetDir("nomanifest-mod", { manifest: null }));
  try {
    assert.equal((await get("/p/hub-pad/mod", U.fan)).loc, "/p/hub-pad/settings?tab=moderation", "no widget: the 301");
    assert.equal((await get("/p/hub-pad/mod")).status, 301, "no widget: the 301 signed out too, as before");
  } finally { CW._setDir(GOOD); }
  process.env.HUB_RT_API = "";
  try { assert.equal((await get("/p/hub-pad/mod", U.fan)).status, 301, "no hub origins: the 301"); }
  finally { process.env.HUB_RT_API = API; }
  assert.equal((await get("/p/apr-pad/mod", U.fan)).status, 301, "an Approved pad's outsider: the 301 (the settings hub refuses them)");
});

test("/p/<slug>/mod of a hub pad: the chat moderation page - <patv-modtools> per view, whatever CHAT_HUB says", async () => {
  for (const sw of ["on", "off", null]) {
    await setChatHub(sw);
    const r = await get("/p/hub-pad/mod", U.fan);
    assert.equal(r.status, 200, "CHAT_HUB " + sw);
    assert.equal(r.cc, "private, no-store");
    assert.equal(r.h.get("x-robots-tag"), "noindex");
    assert.match(r.text, new RegExp(`<patv-modtools view="reports" pad="${HUB_PAD}" locale="en" theme="dark"></patv-modtools>`));
    assert.equal((r.text.match(/id="patv-chat-config"/g) || []).length, 1);
    assert.ok(r.text.slice(0, r.text.indexOf("</head>")).includes(`rel="preconnect" href="${API}"`));
    assert.ok(r.text.includes('href="/p/hub-pad/settings?tab=moderation"'), "Feed moderation →");
    for (const v of CW.PAD_VIEWS) assert.ok(r.text.includes(`href="?view=${v}"`), "tab " + v);
  }
  await setChatHub("on");
  for (const v of CW.PAD_VIEWS) assert.match((await get("/p/hub-pad/mod?view=" + v, U.fan)).text, new RegExp(`<patv-modtools view="${v}" pad=`));
  assert.match((await get("/p/hub-pad/mod?view=audit", U.fan)).text, /<patv-modtools view="reports"/, "admin-only views aren't pad views");
  assert.match((await get("/p/hub-pad/mod?view=%22%3E%3Cx", U.fan)).text, /<patv-modtools view="reports"/);
  const legacy = await get("/p/hub-pad/mod", U.legacy);
  assert.equal(legacy.status, 200);
  assert.ok(!legacy.text.includes("<patv-modtools") && !legacy.text.includes("patv-chat-config"), "no hub account: no widget");
  assert.match(legacy.text, /data-chat-tools="no_account"/);
  assert.equal((await get("/p/apr-pad/mod", U.staff)).status, 200, "staff are inside every Approved pad");
});

test("/p/<slug>/mod of an 18+ hub pad: padaccess's 18+ gate - its card instead of the tools, for a viewer whose age isn't confirmed", async () => {
  await setAdult(P.hub.id, true);
  try {
    const r = await get("/p/hub-pad/mod?view=bans", U.fan);
    assert.equal(r.status, 200);
    assert.equal(r.cc, "private, no-store");
    assert.match(r.text, /data-adult-gate="confirm"/);
    assert.match(r.text, /href="\/confirm-age\?next=%2Fp%2Fhub-pad%2Fmod%3Fview%3Dbans"/, "the way back is this view");
    assert.ok(!r.text.includes("<patv-modtools") && !r.text.includes("patv-chat-config") && !r.text.includes("rt-staging"), "no tools, no config, no preconnect");
    assert.match((await get("/p/hub-pad/mod", U.staff)).text, /<patv-modtools view="reports"/, "site staff are exempt from the 18+ gate");
    await rooms.setPage(P.apr.id, { adult: true }, "test");
    try { assert.equal((await get("/p/apr-pad/mod", U.fan)).status, 301, "an 18+ Approved pad's outsider: the 301, not the 18+ card"); }
    finally { await rooms.setPage(P.apr.id, { adult: false }, "test"); }
  } finally { await setAdult(P.hub.id, false); }
  assert.match((await get("/p/hub-pad/mod", U.fan)).text, /<patv-modtools view="reports"/, "the gate off again: the tools");
});

test("a pad_hub row whose hub_pad_id isn't a uuid is no hub pad: no mount, nothing logged, /p/<slug>/mod keeps the 301", async () => {
  const opts = { roomId: P.hub.id, slug: P.hub.slug, platform: "site" };
  const errs = [];
  const orig = console.error;
  await runQuery("UPDATE pad_hub SET hub_pad_id = 'not-a-uuid' WHERE room_id = ?", [P.hub.id]);
  console.error = (...a) => errs.push(a.join(" "));
  try {
    assert.equal(await CW.padRow(P.hub.id), null);
    assert.equal(await CW.forPad(reqAs(U.fan), resWith(), opts), null);
    const r = await get("/p/hub-pad/mod", U.fan);
    assert.equal(r.status, 301, "the settings hub, not a page with an id the widget refuses");
    assert.equal(r.loc, "/p/hub-pad/settings?tab=moderation");
  } finally {
    console.error = orig;
    await runQuery("UPDATE pad_hub SET hub_pad_id = ? WHERE room_id = ?", [HUB_PAD, P.hub.id]);
  }
  assert.deepEqual(errs, [], "refused as no hub row, not as a failed mount check");
  assert.equal((await CW.padRow(P.hub.id)).hubPadId, HUB_PAD);
});

// ── the admin shell ──
test("/admin/chat/<view>: reports / held / mod log / bans for Assistants up, audit / switches for Admins; nothing else", async () => {
  const st = async (v, u) => (await get("/admin/chat/" + v, u)).status;
  assert.equal((await get("/admin/chat/reports")).loc, "/login?next=%2Fadmin%2Fchat%2Freports");
  for (const v of ["reports", "held", "modlog", "bans", "audit", "switches"]) {
    assert.equal(await st(v, U.fan), 403, "a member: " + v);
    assert.equal(await st(v, U.asst), ["audit", "switches"].includes(v) ? 403 : 200, "an Assistant: " + v);
    assert.equal(await st(v, U.staff), ["audit", "switches"].includes(v) ? 403 : 200, "Staff: " + v);
    assert.equal(await st(v, U.adm), 200, "an Admin: " + v);
  }
  assert.equal(await st("bogus", U.adm), 404, "unknown views fall through");
  assert.equal(await st("", U.adm), 404);
  for (const v of ["reports", "audit"]) assert.equal(await st(v, U.demoted), 403, "the class is the database's, not the session's: " + v);
  const r = await get("/admin/chat/held", U.asst);
  assert.equal(r.cc, "no-store");
  assert.equal(r.h.get("x-robots-tag"), "noindex");
  assert.match(r.text, /data-chat-widget="0\.1\.0">Chat widget 0\.1\.0/, "the footer names the vendored version (chatwidget.status)");
  assert.match(r.text, /<patv-modtools view="held" locale="en" theme="dark"><\/patv-modtools>/);
  assert.ok(!/pad="/.test(r.text.slice(r.text.indexOf("<patv-modtools"), r.text.indexOf("</patv-modtools>"))), "the site-wide queues: no pad");
  assert.ok(r.text.includes('href="/admin/chat/reports"') && !r.text.includes('href="/admin/chat/audit"'), "the view links the viewer can open");
  await setChatHub("off");
  assert.match((await get("/admin/chat/reports", U.adm)).text, /<patv-modtools view="reports"/, "whatever CHAT_HUB says");
  await setChatHub("on");
  assert.match((await get("/admin/chat/switches", U.adm)).text, /href="\/admin\/chat"/, "the switches view points at the break-glass page");
  CW._setDir(widgetDir("nomanifest-admin", { manifest: null }));
  try {
    const off = await get("/admin/chat/reports", U.adm);
    assert.equal(off.status, 200);
    assert.match(off.text, /data-chat-tools="not_installed"/);
    assert.ok(!off.text.includes("<patv-modtools") && !off.text.includes("data-chat-widget"));
    assert.ok(!off.text.includes("can't be used"), "no manifest at all: no reason to show");
  } finally { CW._setDir(GOOD); }
  CW._setDir(widgetDir("badsri-admin", { manifest: { schema: 1, entries: { chat: ENTRY }, sri: { [ENTRY]: sri("other bytes") } } }));
  const orig = console.error;
  console.error = () => {};
  try {
    const bad = await get("/admin/chat/reports", U.adm);
    assert.match(bad.text, /data-chat-tools="not_installed">The chat widget's export in public\/js\/patv-chat\/ can't be used \(the tab entry doesn&#39;t match its SRI\), so the widget is off\.</, "a broken export says why");
  } finally { console.error = orig; CW._setDir(GOOD); }
});

test("the admin views' X-Robots-Tag and the overview card read the database's class too (a stale session gets neither)", async () => {
  const req = { user: U.demoted }, res = { locals: {} };
  await new Promise((r) => CW.overviewCard()(req, res, r));
  assert.equal(res.locals.chatWidget, undefined, "the JWT says Admin, the database a member: no card");
  for (const v of Object.keys(CW.ADMIN_VIEWS)) assert.equal((await get("/admin/chat/" + v, U.adm)).h.get("x-robots-tag"), "noindex", v);
});

test("chat capabilities: release L1's siteperms keys (chat.mod_queue Assistant, chat.audit Admin) with their overrides; one view map", async () => {
  const SP = require(path.join(repo, "siteperms"));
  await SP.init();
  assert.equal(CW.ADMIN_VIEWS, require(path.join(repo, "adminchat")).MOD_VIEWS, "the views' capabilities are release L1's map (one source)");
  for (const k of ["chat.mod_queue", "chat.audit"]) {
    const want = k === "chat.audit" ? { pleb: false, Assistant: false, Staff: false, Admin: true } : { pleb: false, Assistant: true, Staff: true, Admin: true };
    for (const [cls, ok] of Object.entries(want)) assert.equal(CW.canChat({ class: cls }, k), ok, `${k} ${cls}`);
  }
  // siteperms decides, overrides included: the queue raised to Staff
  await runQuery("INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES ('chat.mod_queue', 'staff', ?, 'test', 100)", [Date.now()]);
  await SP.reload();
  try {
    assert.equal(CW.canChat({ class: "Assistant" }, "chat.mod_queue"), false, "raised to Staff: an Assistant is out");
    assert.equal(CW.canChat({ class: "Staff" }, "chat.mod_queue"), true);
    assert.equal((await get("/admin/chat/reports", U.asst)).status, 403, "...of the page too");
  } finally {
    await runQuery("DELETE FROM site_perms WHERE key = 'chat.mod_queue'");
    await SP.reload();
  }
  assert.equal(CW.canChat({ class: "Assistant" }, "chat.mod_queue"), true);
  assert.equal(CW.canChat({ class: "Admin" }, "chat.breakglass"), false, "only the two keys these pages use");
  assert.equal(CW.canChat({ class: "Admin" }, "__proto__"), false);
  assert.equal(CW.canChat(null, "chat.mod_queue"), false);
});

test("the /admin overview: the chat reports card for chat.mod_queue holders while the widget is installed", async () => {
  const run = async (u) => {
    const req = { user: u }, res = { locals: {} };
    await new Promise((r) => CW.overviewCard()(req, res, r));
    return res.locals.chatWidget || null;
  };
  assert.equal(await run(U.fan), null, "a member");
  assert.equal(await run(null), null, "signed out");
  const tools = await run(U.asst);
  assert.equal(tools.state, "tools");
  const render = (cw) => ejs.renderFile(path.join(repo, "views", "admin", "overview.ejs"), { title: "Admin · Overview", user: "asst", isAdmin: false,
    me: U.asst, ov: { alerts: [] }, errors: [], success: [], chatWidget: cw });
  const html = await render(tools);
  assert.match(html, /id="chatReports"[\s\S]*<patv-modtools view="reports" mode="card" locale="en" theme="dark"><\/patv-modtools>/);
  assert.ok(html.includes('href="/admin/chat/reports"'));
  assert.equal((html.match(/id="patv-chat-config"/g) || []).length, 1);
  const without = await render(undefined);
  assert.ok(!without.includes("chatReports") && !without.includes("patv-modtools"));
  CW._setDir(widgetDir("nomanifest-ov", { manifest: null }));
  try { assert.equal(await run(U.adm), null, "no widget: no card"); } finally { CW._setDir(GOOD); }
});

// ── the pad page itself (bridge.js /p/:slug - the call site, at route level) ──
const livePanel = (html) => { const i = html.indexOf('id="padPanel-live"'); return html.slice(html.lastIndexOf("<section", i), html.indexOf(">", i) + 1); };
const tabsInit = (html) => { const m = /PATVPadTabs\.init\((\{[\s\S]*?\})\);/.exec(html); return m ? JSON.parse(m[1]) : null; };

test("/p/<slug> of a hub pad: <patv-chat> on the Live tab; a ?line= link opens Live (the widget's own links carry no ?tab=)", async () => {
  const r = await get("/p/hub-pad", U.fan);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`<patv-chat pad="${HUB_PAD}" room="${HUB_ROOM}" slug="hub-pad" mode="full"`));
  assert.ok(r.text.indexOf("<patv-chat ") > r.text.indexOf('id="padPanel-live"') && r.text.indexOf("<patv-chat ") < r.text.indexOf('id="padPanel-about"'), "in the Live panel");
  assert.match(r.text, /id="padTab-feed"/, "the pad has a Feed tab - a site pad opens on it by default");
  assert.match(livePanel(r.text), / hidden>$/, "no ?line=: the Feed opens, as before");
  assert.equal(tabsInit(r.text).lineLive, true, "the browser gets lineLive too (pad-tabs.js)");
  assert.match(r.text, /pad-tabs\.js\?v=8/, "cache-busted");
  const deep = await get("/p/hub-pad?line=42", U.fan);
  assert.match(deep.text, /<patv-chat [^>]*line="42"/);
  assert.doesNotMatch(livePanel(deep.text), / hidden>$/, "?line= opens Live, where the line is");
  assert.match(deep.text, /id="padTab-live"[^>]*aria-selected="true"/);
  assert.match(livePanel(await get("/p/hub-pad?line=42&tab=about", U.fan).then((x) => x.text)), / hidden>$/, "an explicit ?tab= still wins");
  assert.match(livePanel(await get("/p/hub-pad?line=abc", U.fan).then((x) => x.text)), / hidden>$/, "not a line: as before");
  const out = await get("/p/hub-pad?line=42");
  assert.doesNotMatch(livePanel(out.text), / hidden>$/, "signed out: Live, with the sign-in card");
  assert.match(out.text, /data-hub-chat="signin"[\s\S]*href="\/login\?next=%2Fp%2Fhub-pad%3Fline%3D42"/, "...whose way back keeps the line");
});

test("/p/<slug>: a ?line= changes nothing on a pad without the hub's widget (a v1 pad, CHAT_HUB off) - nothing changes before the switches", async () => {
  const v1 = await get("/p/v1-pad?line=42", U.fan);
  assert.equal(v1.status, 200);
  assert.ok(!v1.text.includes("<patv-chat") && !v1.text.includes("patv-chat-config"));
  assert.match(livePanel(v1.text), / hidden>$/, "a v1 pad: the Feed, as before");
  assert.equal(tabsInit(v1.text).lineLive, undefined, "no lineLive in the page");
  await setChatHub("off");
  try {
    const off = await get("/p/hub-pad?line=42", U.fan);
    assert.ok(!off.text.includes("<patv-chat"), "CHAT_HUB off: no widget");
    assert.match(livePanel(off.text), / hidden>$/);
    assert.equal(tabsInit(off.text).lineLive, undefined);
  } finally { await setChatHub("on"); }
});

test("/p/<slug> of a hub 18+ pad: the 18+ card, never the chat, for a viewer the gate stops (forPad reads padaccess itself)", async () => {
  await setAdult(P.hub.id, true);
  try {
    for (const u of [U.fan, null]) {
      const r = await get("/p/hub-pad", u);
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes("<patv-chat") && !r.text.includes("patv-chat-config") && !r.text.includes("rt-staging"), (u ? "unconfirmed" : "signed out") + ": no chat, no config, no preconnect");
      assert.match(r.text, new RegExp(`data-adult-gate="${u ? "confirm" : "signin"}"`));
    }
    assert.match((await get("/p/hub-pad", U.staff)).text, /<patv-chat pad=/, "site staff are exempt");
  } finally { await setAdult(P.hub.id, false); }
  assert.match((await get("/p/hub-pad", U.fan)).text, /<patv-chat pad=/);
});

// ── the admin nav's Chat group (V2 owns its moderation links) and the admin home ──
const navOf = (locals) => ejs.renderFile(path.join(repo, "views", "partials", "admin-nav.ejs"), { section: "overview", ...locals });

test("adminNavLinks: /admin/chat/<view> for every view, with release L1's capability (all registered)", () => {
  const core = require(path.join(repo, "siteperms-core"));
  assert.deepEqual(CW.adminNavLinks(), [["/admin/chat/reports", "Reports", "chat.mod_queue"], ["/admin/chat/held", "Held", "chat.mod_queue"],
    ["/admin/chat/modlog", "Mod log", "chat.mod_queue"], ["/admin/chat/bans", "Bans", "chat.mod_queue"],
    ["/admin/chat/audit", "Audit (admin reads)", "chat.audit"], ["/admin/chat/switches", "Retention & switches", "chat.audit"]]);
  for (const [, , k] of CW.adminNavLinks()) assert.ok(core.capOf(k), "registered: " + k);
  const app = { locals: {}, get() {} };
  CW.register(app, {});
  assert.equal(app.locals.chatAdminNav, CW.adminNavLinks, "every view gets it through app.locals");
});

test("the admin nav: the chat links join the Chat group, open it to their capabilities and link it to the first page the viewer may use", async () => {
  // stand-in capabilities (registered on every branch) for chat.mod_queue (Assistants up) and chat.audit (Admins)
  const links = () => [["/admin/chat/reports", "Reports", "banner.review"], ["/admin/chat/audit", "Audit (admin reads)", "admin.sensitive_overview"]];
  const group = (html) => { const i = html.indexOf("💬"); return i < 0 ? null : html.slice(html.lastIndexOf("<li", i), html.indexOf("</li>", i)); };
  assert.equal(group(await navOf({ me: { class: "Assistant" } })), null, "no chat links (a test render, or before L1 without its entry): as before");
  const asst = await navOf({ me: { class: "Assistant" }, chatAdminNav: links });
  assert.match(group(asst), /href="\/admin\/chat\/reports"/, "an Assistant: the group, at the queue");
  const adm = await navOf({ me: { class: "Admin" }, chatAdminNav: links });
  assert.ok(group(adm), "an Admin: the group");
  assert.equal(group(await navOf({ me: { class: "pleb" }, chatAdminNav: links })), null, "a member: none");
  const onPage = await navOf({ me: { class: "Assistant" }, section: "chat", chatAdminNav: links });
  const sub = onPage.slice(onPage.indexOf('class="adm-subbar"'));
  assert.match(sub, /href="\/admin\/chat\/reports">Reports</, "on a chat page: the views the viewer may open");
  assert.doesNotMatch(sub, /\/admin\/chat\/audit/, "...not the others");
  assert.doesNotMatch(onPage, /href="#/, "no bare anchors: they would resolve against /admin/chat/<view>");
});

test("with release L1 (its keys and its Chat entry): Assistants reach the queue from the nav and get an admin home; Admins keep /admin/chat", async () => {
  const SP = require(path.join(repo, "siteperms"));
  const nav = (cls, section = "overview") => navOf({ me: { class: cls }, section, chatAdminNav: CW.adminNavLinks });
  const group = (html) => { const i = html.indexOf("💬"); return i < 0 ? null : html.slice(html.lastIndexOf("<li", i), html.indexOf("</li>", i)); };
  assert.match(group(await nav("Assistant")), /href="\/admin\/chat\/reports"/, "an Assistant: the group links to the queue");
  assert.match(group(await nav("Staff")), /href="\/admin\/chat\/reports"/);
  assert.match(group(await nav("Admin")), /href="\/admin\/chat"/, "an Admin: the break-glass page first");
  const asstChat = await nav("Assistant", "chat");
  const sub = asstChat.slice(asstChat.indexOf('class="adm-subbar"'));
  for (const v of ["reports", "held", "modlog", "bans"]) assert.match(sub, new RegExp(`href="/admin/chat/${v}"`), v);
  assert.doesNotMatch(sub, /\/admin\/chat\/(audit|switches)|\/admin\/chat#/, "no audit / switches, none of the break-glass anchors");
  const admChat = await nav("Admin", "chat");
  const admSub = admChat.slice(admChat.indexOf('class="adm-subbar"'));
  assert.match(admSub, /href="\/admin\/chat#hub"/, "L1's anchors as full paths (they work from a view's page)");
  assert.match(admSub, /href="\/admin\/chat\/audit"/);
  assert.doesNotMatch(admChat, /href="#/);
  assert.ok(SP.AREA_PAGES.some((p) => p[0] === "/admin/chat/reports" && p[1][0] === "chat.mod_queue"), "AREA_PAGES: the queue is an admin home");
  assert.equal(SP.areaHome({ class: "Assistant" }) !== null, true);
  const r = await get("/admin/chat/reports", U.asst);
  assert.match(r.text, /class="adm-subbar"[\s\S]*href="\/admin\/chat\/held"/, "the page's own nav, through app.locals");
});

test("AREA_PAGES: the chat queue is an admin home (release L1's chat.mod_queue; no unknown key, ever)", () => {
  const SP = require(path.join(repo, "siteperms"));
  const core = require(path.join(repo, "siteperms-core"));
  for (const [, keys] of SP.AREA_PAGES) for (const k of keys) assert.ok(core.capOf(k), "registered: " + k);
  assert.ok(SP.AREA_PAGES.some((p) => p[0] === "/admin/chat/reports" && p[1].length === 1 && p[1][0] === "chat.mod_queue"));
});

test("register() reads the manifest at start-up: a bad export is logged when the site starts, not on a first page", () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    CW._setDir(widgetDir("bad-boot", { manifest: "{nope" }));
    CW._reset();
    CW.register({ locals: {}, get() {} }, {});
    assert.deepEqual(errs, ["[chatwidget] widget off: manifest.json isn't JSON"]);
  } finally { console.error = orig; CW._setDir(GOOD); CW._reset(); }
});

test("a vendoring commit takes effect without a restart: manifest.json is looked at again every RECHECK_MS (v1's updater restarts nothing for public/)", async () => {
  let t = 1e12;
  const d = path.join(dir, "live-export");
  fs.mkdirSync(d, { recursive: true });
  const logs = [], errs = [];
  const ol = console.log, oe = console.error;
  const write = (name, text) => fs.writeFileSync(path.join(d, name), text);
  const man = (version, entry, src) => JSON.stringify({ schema: 1, version, entries: { chat: entry }, sri: { [entry]: sri(src) } });
  const E1 = "patv-chat.Vv111111.js", S1 = "export const v = 1;\n", E2 = "patv-chat.Ww222222.js", S2 = "export const v = 2;\n";
  const opts = { roomId: P.hub.id, slug: P.hub.slug, platform: "site" };
  CW._setNow(() => t);
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  try {
    CW._setDir(d);
    assert.equal(CW.manifest(), null, "no export yet");
    // the first vendoring commit, pulled: git writes manifest.json before the patv-chat.<h>.js it names (path order)
    write("manifest.json", man("0.2.0", E1, S1));
    assert.equal(CW.manifest(), null, "within RECHECK_MS: the cached answer");
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest(), null, "the manifest is there, its entry not yet");
    write(E1, S1);
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest().script, CW.URL_BASE + E1, "the same manifest is verified again while it can't be used: on now");
    assert.equal((await CW.forPad(reqAs(U.fan), resWith(), opts)).boot.integrity, sri(S1));
    // the next export: a new entry and manifest (the export keeps the old files a while, then prunes them)
    write(E2, S2);
    write("manifest.json", man("0.3.0", E2, S2));
    t += CW.RECHECK_MS - 1;
    assert.equal(CW.manifest().entry, E1, "not before RECHECK_MS");
    t += 1;
    assert.equal(CW.manifest().entry, E2, "the new entry, no restart");
    const m = await CW.forPad(reqAs(U.fan), resWith(), opts);
    assert.equal(m.boot.script, CW.URL_BASE + E2);
    assert.equal(m.boot.integrity, sri(S2), "...with its own SRI");
    assert.equal(CW.status().version, "0.3.0");
    fs.unlinkSync(path.join(d, E1));
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest().entry, E2, "the old file pruned: nothing names it");
    // a broken export turns the widget off (one line), a fixed one back on
    write("manifest.json", JSON.stringify({ schema: 1, version: "0.3.1", entries: { chat: E2 }, sri: { [E2]: sri("other bytes") } }));
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest(), null, "a manifest whose entry doesn't match its SRI: off");
    assert.equal(await CW.forPad(reqAs(U.fan), resWith(), opts), null);
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest(), null, "still off (said once)");
    write("manifest.json", man("0.3.2", E2, S2));
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest().version, "0.3.2");
    // the widget taken out (the vendored directory emptied): off
    fs.unlinkSync(path.join(d, "manifest.json"));
    t += CW.RECHECK_MS;
    assert.equal(CW.manifest(), null);
    assert.equal(CW.toolsFor(reqAs(U.fan), resWith()).state, "off");
  } finally {
    console.log = ol; console.error = oe;
    CW._setNow(null);
    CW._setDir(GOOD);
  }
  assert.deepEqual(errs, ["[chatwidget] widget off: the tab entry named in the manifest is missing",
                          "[chatwidget] widget off: the tab entry doesn't match its SRI", "[chatwidget] widget off: no manifest"], "a line per change, the reason only");
  assert.deepEqual(logs, ["[chatwidget] widget 0.2.0 in use", "[chatwidget] widget 0.3.0 in use", "[chatwidget] widget 0.3.2 in use"]);
});

test("the manifest is cached between looks: one read of manifest.json per RECHECK_MS, the entry's bytes hashed only when it changed", () => {
  let t = 2e12;
  const reads = [];
  const orig = fs.readFileSync;
  CW._setNow(() => t);
  CW._setDir(GOOD);
  fs.readFileSync = function (p) { reads.push(path.basename(String(p))); return orig.apply(fs, arguments); };
  try {
    assert.ok(CW.manifest());
    assert.deepEqual(reads, ["manifest.json", ENTRY], "the first look verifies the entry");
    reads.length = 0;
    for (let i = 0; i < 5; i++) CW.manifest();
    assert.deepEqual(reads, [], "cached within RECHECK_MS");
    t += CW.RECHECK_MS;
    assert.ok(CW.manifest());
    assert.deepEqual(reads, ["manifest.json"], "unchanged: the manifest read, the entry not hashed again");
  } finally { fs.readFileSync = orig; CW._setNow(null); CW._setDir(GOOD); }
});

test("pad-hub-chat.ejs: the cards' way back is a local path only (anything else becomes /)", async () => {
  const card = (cw, tag) => ejs.renderFile(path.join(repo, "views", "partials", "pad-hub-chat.ejs"), { cw, tag });
  for (const tag of ["section", "div"]) {
    assert.match(await card({ state: "signin", next: "/p/hub-pad?line=4" }, tag), /href="\/login\?next=%2Fp%2Fhub-pad%3Fline%3D4"/, tag);
    for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "p/hub-pad", "", null, 7]) {
      assert.match(await card({ state: "signin", next: bad }, tag), /href="\/login\?next=%2F"/, tag + " " + JSON.stringify(bad));
      assert.match(await card({ state: "gate", gate: "confirm", next: bad }, tag), /href="\/confirm-age\?next=%2F"/, tag + " gate " + JSON.stringify(bad));
    }
  }
});

test("home.js: the panel's pad gets forPad's compact mount - S1's panel (the bridge's Camfrog rooms) never does; a hub site pad there would", async () => {
  const bridge = require(path.join(repo, "bridge"));
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { const h = req.get("x-test-user"); req.user = h ? users.get(h) || null : null; req.flash = () => []; res.locals.ogBase = "http://test"; next(); });
  // what home.js hands home.ejs (the view itself needs the whole site's tables; test 'home.ejs: ...' renders it)
  app.response.render = function (view, data) {
    const cw = this.locals.chatWidget;
    return this.json({ view, room: data.room ? data.room.id : null, cw: cw ? { state: cw.state, mode: cw.mount ? cw.mount.mode : null, pad: cw.mount ? cw.mount.pad : null } : null });
  };
  require(path.join(repo, "home")).register(app, { addUser: (req, res, next) => next(), xpForNextLevel: () => 100 });
  const srv = app.listen(0);
  const at = async (u) => (await fetch("http://127.0.0.1:" + srv.address().port + "/", { headers: u ? { "x-test-user": u.userId } : {} })).json();
  const orig = bridge.summary;
  const row = (p, name) => ({ id: p.id, slug: p.slug, name, title: name, live: true, count: 2, micCount: 0, topic: "" });
  try {
    bridge.summary = async () => [row(P.cf, "Frog Room")];
    let r = await at(U.fan);
    assert.equal(r.view, "home");
    assert.equal(r.room, P.cf.id);
    assert.equal(r.cw, null, "a Camfrog room - even one whose pad_hub row says 'hub' - never mounts (S1: site pads only)");
    bridge.summary = async () => [row(P.hub, "Hub Pad")];
    r = await at(U.fan);
    assert.equal(r.room, P.hub.id);
    assert.deepEqual(r.cw, { state: "mount", mode: "compact", pad: HUB_PAD }, "a hub site pad in the panel (D14's 'Lounge chat' card lever): the compact mount");
    assert.deepEqual((await at(null)).cw, { state: "signin", mode: null, pad: null }, "signed out: the teaser");
  } finally {
    bridge.summary = orig;
    await new Promise((res) => srv.close(res));
  }
});

test("?line=: the browser's tab choice (pad-tabs.js lineRequested) and the server's mount (lineOf, Express's query parser) agree", () => {
  const T = require(path.join(repo, "public", "js", "pad-tabs"));
  const qs = require("qs");
  for (const q of ["?line=42", "?x=1&line=9007199254740991", "?line=7#c", "?line=9007199254740992", "?line=9999999999999999", "?line=12345678901234567",
                   "?line=1&line=2", "?line=1&line=", "?line", "?line=", "?line=0", "?line=-1", "?line=4x", "?line=%34%32", "?lin%65=5", "?line[]=4",
                   "?line=+7", "?headline=4", "?line=%zz", ""]) {
    const parsed = qs.parse(q.replace(/^\?/, "").replace(/#.*$/, ""));
    assert.equal(T.lineRequested(q), CW.lineOf({ query: parsed }) !== null, "agree on " + JSON.stringify(q));
  }
});

test("the walkers that scan public/js leave the vendored widget (the platform repo's build) alone", () => {
  for (const f of ["pads-copy.test.js", "i18n.test.js"]) {
    assert.match(fs.readFileSync(path.join(__dirname, f), "utf8"), /"public", "js", "patv-chat"/, f);
  }
});
