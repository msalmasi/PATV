// grabcard (the owner, 2026-11-08: "where do i set the mic relay cooldowns and adjustable grab limits on the site?"): the push-to-talk
// clip limits are the Bridge page's card (/admin/bridge#pttlimits); Pepe's fast-grab switches and caps were chat only (!mic fastgrab ...
// [-global|-all]) and his own panel on the VM. Now: the ⚡ Fast mic grab card on /admin/pepe/rooms#fastgrab (fastgrab.js,
// public/js/admin-fastgrab.js):
//   * the values Pepe has now ride his rooms state push (state.fastgrab: the global + each room - every field, room vs global marks,
//     contest active / why, ranges / defaults / claim modes, his last changes with what he stored and clamped), cleaned here
//   * a save = ONE website action kind "mic.fastgrab" [scope, room, "field=value", ...] (+ one admin_audit row pepe.fastgrab in the
//     same transaction); Pepe checks the whole change, runs each field through !mic fastgrab itself, acks with what he stored
//   * site Admins only (pepe.rooms_commands_audio, by the account's class in the database), a same-site fetch, 20 a minute
//   * the site checks the SHAPE (a known field, on/off, a claim Pepe offers, the right count of whole numbers, a room he reports);
//     the ranges are Pepe's (he clamps, the card shows asked -> stored)
//   * PEPE_BOT_DIR=<camfrog-bot checkout>: the contract test runs the site's change through the bot's REAL pepe_fastgrabweb
//   * 1.99?? micblock (the owner, 11-08: "give me a toggle to remove this courtesy" / "I do want that in Players_Lounge (add this to
//     the admin page too, a toggle plus field for whatever the unblock code is ...)"): blockbreak (on by default) and selfunblock
//     (off by default) switches + the unblockcode text field - 1-20 printable characters, trimmed, case kept, never a leading
//     "/" or "!" (it can never be a Camfrog or a Pepe command); empty = none
//   node --test test/fastgrab.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastgrab-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const roomctl = require(path.join(repo, "roomctl"));
const FG = require(path.join(repo, "fastgrab"));
const AA = require(path.join(repo, "adminaudit"));

const YW = "You_Were_Never_Here", PAD = "PepeFrog.Room", PLANT = "plant_based_chatting";
const users = new Map([
  ["boss", { userId: "boss", username: "boss", class: "Admin" }],
  ["helper", { userId: "helper", username: "helper", class: "Staff" }],
  ["p1", { userId: "p1", username: "p1_patv", class: "pleb" }],
  ["demoted", { userId: "exadmin", username: "exadmin", class: "Admin" }],   // a sign-in from before the demotion
]);

// What Pepe's _fgw_state() sends (camfrog-bot pepe_fastgrabweb.py; the contract test below checks the real one)
const vals = (o = {}) => ({ on: false, contest: false, fair: true, claim: "swallow", web: false, chatty: false, rate: 10, shots: 12, tries: 2,
  breaker: [4, 10, 15], pause: [4, 120, 90, 300], fairwait: [500, 350], ceiling: 20, blockbreak: true, selfunblock: false, unblockcode: "", ...o });
const roomVals = (o = {}) => vals({ contest_active: false, contest_why: null, resting_min: null, ...o });
function block(o = {}) {
  return {
    v: 1, fields: ["on", "contest", "fair", "web", "chatty", "blockbreak", "selfunblock", "claim", "rate", "shots", "tries", "breaker", "pause",
                   "fairwait", "ceiling", "unblockcode"],
    claims: ["swallow", "release", "plain"],
    ranges: { rate: [[1, 60]], shots: [[1, 100]], tries: [[1, 20]], breaker: [[1, 50], [1, 120], [0, 240]], pause: [[0, 50], [10, 1800], [0, 3600], [0, 3600]],
              fairwait: [[0, 2000], [0, 2000]], ceiling: [[1, 120]] },
    defaults: { rate: 10, shots: 12, tries: 2, breaker: [4, 10, 15], pause: [4, 120, 90, 300], fairwait: [500, 350], ceiling: 20,
                on: false, contest: false, fair: true, claim: "swallow", web: false, chatty: false, blockbreak: true, selfunblock: false, unblockcode: "" },
    global: vals({ on: true }),
    rooms: [
      { id: YW, name: "Players Lounge", joined: true, values: roomVals({ on: true, contest: true, contest_active: true, fair: false, rate: 15 }),
        own: { on: "room", contest: "room", fair: "room", claim: "room", rate: "room" } },
      { id: PAD, name: "Pepe's Pad", joined: true, values: roomVals({ on: true }), own: {} },
      { id: PLANT, name: "Houseplants", joined: true, values: roomVals({ on: true, breaker: [6, 10, 15] }), own: { breaker: "mixed" } },
    ],
    last: [],
    ...o,
  };
}
const ROOMS = [{ id: YW, name: "Players Lounge" }, { id: PAD, name: "Pepe's Pad" }, { id: PLANT, name: "Houseplants" }];
async function pepeSays(fg = block()) {
  assert.equal(await roomctl.setState({ rooms: ROOMS, ...(fg ? { fastgrab: fg } : {}) }), true);
  FG._hits.reset("boss");            // (each test starts with a fresh 20-a-minute allowance)
}
const j = (x) => JSON.parse(JSON.stringify(x));   // a value from the card's vm realm, compared here

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('boss', 'boss', 'boss', 'x', 'Admin')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('helper', 'helper', 'helper', 'x', 'Staff')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('p1', 'p1_patv', 'p1', 'x', 'pleb')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('exadmin', 'exadmin', 'exadmin', 'x', 'pleb')");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  roomctl.register(app, { isBotToken, addUser });
  FG.register(app, { addUser });
  require(path.join(repo, "actions")).register(app, { isBotToken, addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await roomctl.init();
  await AA.init();
});
test.after(() => server.close());

async function api(method, who, body, headers = {}) {
  const h = Object.assign({}, who ? { "x-test-user": who } : {}, body ? { "content-type": "application/json" } : {}, headers);
  const r = await fetch(base + "/api/admin/pepe/fastgrab", { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const save = (body, who = "boss") => api("POST", who, body, { "x-requested-with": "fetch" });
const queued = () => getQuery("SELECT id, kind, args, label, tag, site_admin, status FROM pepe_actions WHERE kind = 'mic.fastgrab' ORDER BY id");
const audits = () => getQuery("SELECT * FROM admin_audit WHERE action = 'pepe.fastgrab' ORDER BY id");
async function settle() {          // every queued change answered (so the next test isn't "busy")
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'mic.fastgrab' AND status IN ('pending', 'claimed')");
}

// ── what Pepe reports ──

test("Pepe's fastgrab block is cleaned: the card's fields, each its own type; junk and unknown keys dropped; an older Pepe has none", () => {
  const dirty = block({ evil: "<script>", rooms: [
    { id: YW, name: "Players Lounge".repeat(20), values: { ...roomVals({ rate: "lots", breaker: [1, 2], claim: "<b>", on: "yes" }), extra: 1 },
      own: { rate: "room", ceiling: "room", junk: "room", fair: "sure" }, sneaky: true },
    { id: "", values: roomVals() }, { id: "X" }, ...Array.from({ length: 30 }, (_, i) => ({ id: "R" + i, values: roomVals() })),
  ], last: [{ id: 7, ts: 1700000000, by: "boss", scope: "room", room: YW, set: { rate: 60, junk: 1, fair: "no" },
              clamped: { rate: { asked: [999], stored: [60] }, fair: { asked: [1], stored: [2] } }, followed: ["rate", "evil"], msg: "ok" }] });
  const c = FG.cleanState(dirty);
  assert.equal(c.v, 1);
  assert.equal(c.evil, undefined);
  assert.equal(c.rooms.length, 20, "at most 20 rooms; a room needs an id and values");
  const y = c.rooms[0];
  assert.equal(y.name.length, 80);
  assert.equal(y.values.rate, undefined, "a number that isn't one is left out");
  assert.equal(y.values.breaker, undefined, "...and the wrong count");
  assert.equal(y.values.claim, undefined);
  assert.equal(y.values.on, undefined);
  assert.equal(y.values.extra, undefined);
  assert.deepEqual(y.own, { rate: "room" }, "own marks: known fields (never the ceiling), room / mixed only");
  assert.equal(y.sneaky, undefined);
  assert.deepEqual(c.last[0].set, { rate: 60 });
  assert.deepEqual(c.last[0].clamped, { rate: { asked: [999], stored: [60] } });
  assert.deepEqual(c.last[0].followed, ["rate"]);
  assert.equal(c.last[0].ts, 1700000000 * 1000);
  assert.deepEqual(c.ranges.breaker, [[1, 50], [1, 120], [0, 240]]);
  assert.deepEqual(c.defaults.pause, [4, 120, 90, 300]);
  assert.equal(FG.cleanState(null), null);
  assert.equal(FG.cleanState({ v: 0 }), null);
  assert.equal(roomctl.cleanState({ rooms: [] }).fastgrab, undefined, "an older Pepe: no fastgrab key at all");
  assert.deepEqual(roomctl.cleanState({ rooms: [], fastgrab: block() }).fastgrab.global, vals({ on: true }));
  assert.ok(require(path.join(repo, "weberrors")).NO_PAT_KINDS.includes("mic.fastgrab"), "an E_INTERNAL there says to check the page, not the balance");
  assert.equal(require(path.join(repo, "actionttl")).TTL_DEFAULTS["mic.fastgrab"], 15, "a change Pepe never got to expires in 15 minutes (like room.ctl)");
});

// ── who may ──

test("admins only (the account's class in the database), signed in; a change needs a same-site fetch", async () => {
  await pepeSays();
  assert.equal((await api("GET", null)).status, 401);
  assert.equal((await api("GET", "p1")).status, 403);
  assert.equal((await api("GET", "helper")).status, 403, "Staff can't");
  assert.equal((await api("GET", "demoted")).status, 403, "a stale Admin sign-in: the database's class decides");
  const g = await api("GET", "boss");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.equal(g.d.online, true);
  assert.deepEqual(g.d.fg.global, vals({ on: true }));
  assert.deepEqual(g.d.fg.rooms.map((r) => r.id), [YW, PAD, PLANT]);
  const body = { scope: "room", room: YW, set: { rate: 20 } };
  assert.equal((await api("POST", "boss", body)).status, 403, "no X-Requested-With");
  assert.equal((await api("POST", "boss", body, { "x-requested-with": "fetch", origin: "https://evil.example" })).status, 403, "another site");
  assert.equal((await save(body, "helper")).status, 403);
  assert.equal((await save(body, "p1")).status, 403);
  assert.equal((await save(body, "demoted")).status, 403);
  assert.equal((await api("POST", null, body, { "x-requested-with": "fetch" })).status, 401);
  assert.equal((await queued()).length, 0, "nothing queued");
  assert.equal((await audits()).length, 0, "nothing audited");
});

test("Pepe offline, or an older Pepe without the fastgrab block -> 409, nothing queued", async () => {
  await pepeSays(null);
  let r = await save({ scope: "global", set: { rate: 20 } });
  assert.equal(r.status, 409);
  assert.match(r.d.error, /!mic fastgrab/);
  await pepeSays();
  roomctl._setClock(() => Date.now() + 5 * 60e3);
  try {
    r = await save({ scope: "global", set: { rate: 20 } });
    assert.equal(r.status, 409);
    assert.match(r.d.error, /isn't reporting/);
  } finally { roomctl._setClock(null); }
  assert.equal((await queued()).length, 0);
});

test("validation: the shape - a known field, on/off, a claim Pepe offers, the right count of whole numbers, a room he reports; else 400 / 404 naming it, nothing queued or audited", async () => {
  await pepeSays();
  const bad = [
    [{ scope: "everywhere", set: { rate: 1 } }, 400, "scope"], [{ set: { rate: 1 } }, 400, "scope"],
    [{ scope: "room", set: { rate: 1 } }, 400, "room"], [{ scope: "room", room: "Nowhere", set: { rate: 1 } }, 404, "room"],
    [{ scope: "global" }, 400, "set"], [{ scope: "global", set: {} }, 400, "set"], [{ scope: "global", set: [1] }, 400, "set"],
    [{ scope: "global", set: { volume: 11 } }, 400, "volume"], [{ scope: "global", set: { rate: 1, probe: 3 } }, 400, "probe"],
    [{ scope: "global", set: { inline: "on" } }, 400, "inline"],
    [{ scope: "global", set: { fair: "maybe" } }, 400, "fair"], [{ scope: "global", set: { on: 1 } }, 400, "on"],
    [{ scope: "global", set: { claim: "grab" } }, 400, "claim"], [{ scope: "global", set: { rate: "abc" } }, 400, "rate"],
    [{ scope: "global", set: { rate: 1.5 } }, 400, "rate"], [{ scope: "global", set: { rate: [1, 2] } }, 400, "rate"],
    [{ scope: "global", set: { breaker: [1, 2] } }, 400, "breaker"], [{ scope: "global", set: { breaker: "1,2,3,4" } }, 400, "breaker"],
    [{ scope: "global", set: { fairwait: 500 } }, 400, "fairwait"], [{ scope: "global", set: { rate: 10000000 } }, 400, "rate"],
    [{ scope: "global", set: { rate: "follow" } }, 400, "rate"], [{ scope: "room", room: YW, set: { ceiling: "follow" } }, 400, "ceiling"],
    [{ scope: "all", set: { fair: null } }, 400, "fair"],
  ];
  for (const [body, status, field] of bad) {
    const r = await save(body);
    assert.equal(r.status, status, JSON.stringify(body) + " " + JSON.stringify(r.d));
    assert.equal(r.d.field, field, JSON.stringify(body));
    assert.ok(r.d.error && r.d.error.length > 5, "a reason the card can show");
  }
  assert.equal((await queued()).length, 0, "nothing queued");
  assert.equal((await audits()).length, 0, "nothing audited");
  // the ranges are Pepe's: 999 is a fine shape - he clamps it and says so
  const ok = await save({ scope: "global", set: { rate: 999 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.deepEqual(ok.d.args, ["global", "", "rate=999"]);
  await settle();
});

test("payload: ONE action kind mic.fastgrab [scope, room, field=value...] in the card's order, site_admin, a readable label; the types the form sends", async () => {
  await pepeSays();
  await settle();
  const n0 = (await queued()).length;
  const r = await save({ scope: "room", room: "you_were_never_here", reason: "fights in Players",
    set: { breaker: "6, 20, 30", rate: "20", claim: "RELEASE", on: "off", fair: true, pause: [3, 60, "45", 200], fairwait: "800,600", ceiling: 40, contest: false, web: "on", chatty: false, shots: 30, tries: "4" } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const rows = await queued();
  assert.equal(rows.length, n0 + 1, "one change = one action");
  const a = rows.at(-1);
  assert.equal(a.id, r.d.id);
  assert.deepEqual(JSON.parse(a.args), ["room", YW, "on=off", "contest=off", "fair=on", "claim=release", "web=on", "chatty=off", "rate=20", "shots=30",
                                         "tries=4", "breaker=6,20,30", "pause=3,60,45,200", "fairwait=800,600", "ceiling=40"],
    "the room by Pepe's own id; the fields in the card's order; on/off; numbers comma-joined");
  assert.equal(a.site_admin, 1, "Pepe re-checks it: an Admin's");
  assert.equal(a.tag, "pepe-fastgrab");
  assert.match(a.label, /^Fast grab \(Players Lounge\): fast grab off, contest off, fair on, claim release, web clips on/);
  assert.ok(a.label.length <= 200);
  // follow: a room's own value dropped (Pepe's own word for it)
  await settle();
  const f = await save({ scope: "room", room: YW, set: { rate: "follow", fair: null } });
  assert.equal(f.status, 200, JSON.stringify(f.d));
  assert.deepEqual(f.d.args, ["room", YW, "fair=follow", "rate=follow"]);
  await settle();
  const all = await save({ scope: "all", room: YW, set: { tries: 3 } });
  assert.deepEqual(all.d.args, ["all", "", "tries=3"], "every room: no room");
  await settle();
  // the same change still waiting for Pepe: refused, not queued twice
  const d1 = await save({ scope: "global", set: { shots: 9 } });
  const d2 = await save({ scope: "global", set: { shots: 9 } });
  assert.equal(d1.status, 200);
  assert.equal(d2.status, 409);
  await settle();
});

test("micblock: block break + self-unblock switches and the unblock code - cleaned from Pepe's push, validated (never a command), sent in the card's order", async () => {
  // Pepe's push: the three new fields, each its own type; a code that could be a command (or too long) is left out
  const c = FG.cleanState(block({ rooms: [
    { id: YW, name: "Players Lounge", joined: true, values: roomVals({ blockbreak: false, selfunblock: true, unblockcode: "1" }),
      own: { blockbreak: "room", selfunblock: "room", unblockcode: "room" } },
    { id: PAD, name: "Pepe's Pad", joined: true, values: roomVals({ blockbreak: "no", selfunblock: 1, unblockcode: "/kick bob" }), own: {} },
    { id: PLANT, name: "Houseplants", joined: true, values: roomVals({ unblockcode: "x".repeat(21) }), own: {} },
  ], last: [{ id: 9, ts: 1700000000, by: "boss", scope: "room", room: YW, set: { selfunblock: true, unblockcode: "1", blockbreak: "off" }, followed: [] }] }));
  assert.ok(FG.FIELDS.includes("blockbreak") && FG.FIELDS.includes("selfunblock") && FG.FIELDS.includes("unblockcode"), "the card's fields");
  assert.deepEqual(c.defaults.blockbreak, true); assert.deepEqual(c.defaults.selfunblock, false); assert.equal(c.defaults.unblockcode, "");
  const y = c.rooms.find((r) => r.id === YW), pad = c.rooms.find((r) => r.id === PAD), pl = c.rooms.find((r) => r.id === PLANT);
  assert.equal(y.values.blockbreak, false); assert.equal(y.values.selfunblock, true); assert.equal(y.values.unblockcode, "1");
  assert.deepEqual(y.own, { blockbreak: "room", selfunblock: "room", unblockcode: "room" });
  assert.equal(pad.values.blockbreak, undefined); assert.equal(pad.values.selfunblock, undefined);
  assert.equal(pad.values.unblockcode, undefined, "a code that could be a command never reaches the card");
  assert.equal(pl.values.unblockcode, undefined, "...nor one over 20 characters");
  assert.deepEqual(c.last[0].set, { selfunblock: true, unblockcode: "1" }, "his last change: only well-typed values");
  assert.equal(c.global.blockbreak, true);
  // the admin's change: validated - the code is checked here like Pepe checks it
  await pepeSays();
  await settle();
  const n0 = (await queued()).length;
  const bad = [
    [{ unblockcode: "/unblockmic pepefrog" }], [{ unblockcode: "!sb ribbit" }], [{ unblockcode: "  /kick bob" }], [{ unblockcode: "x".repeat(21) }],
    [{ unblockcode: "1\n/kick bob" }], [{ unblockcode: "a\tb" }], [{ unblockcode: "\u200bx" }], [{ unblockcode: 1 }], [{ unblockcode: ["1"] }],
    [{ selfunblock: "maybe" }], [{ blockbreak: 0 }],
  ];
  for (const [set] of bad) {
    const r = await save({ scope: "room", room: YW, set });
    assert.equal(r.status, 400, JSON.stringify(set) + " " + JSON.stringify(r.d));
    assert.equal(r.d.field, Object.keys(set)[0], JSON.stringify(set));
    assert.ok(r.d.error && r.d.error.length > 5);
  }
  assert.equal((await queued()).length, n0, "nothing queued");
  const r = await save({ scope: "room", room: YW, set: { unblockcode: "  Ok 1 ", selfunblock: "on", blockbreak: false, rate: 15 } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.args, ["room", YW, "rate=15", "blockbreak=off", "selfunblock=on", "unblockcode=Ok 1"], "trimmed, case kept, in the card's order");
  const a = (await queued()).at(-1);
  assert.match(a.label, /block break off, self-unblock on, unblock code "Ok 1"/);
  await settle();
  const none = await save({ scope: "global", set: { unblockcode: "" } });
  assert.deepEqual(none.d.args, ["global", "", "unblockcode="], "empty = no code");
  await settle();
  const fol = await save({ scope: "room", room: YW, set: { unblockcode: "follow", selfunblock: null } });
  assert.deepEqual(fol.d.args, ["room", YW, "selfunblock=follow", "unblockcode=follow"]);
  await settle();
  assert.equal(FG.codeClean("  Unblock Me ").code, "Unblock Me");
  assert.equal(FG.codeClean("none").code, ""); assert.equal(FG.codeClean("none").err, null);
  assert.ok(FG.codeClean("!x").err && FG.codeClean("/x").err && FG.codeClean("x".repeat(21)).err && FG.codeClean("a\u0007").err);
  assert.equal(FG.codeClean("é😀1").code, "é😀1", "any printable character");
});

test("audit: one admin_audit row pepe.fastgrab per change - scope, room, what it sets, what it replaces (Pepe's last values), the action id, the reason; no audit = no change", async () => {
  await pepeSays();
  await settle();
  const a0 = (await audits()).length, q0 = (await queued()).length;
  const r = await save({ scope: "room", room: YW, set: { rate: 25, fair: true, breaker: [5, 8, 12], ceiling: 50 }, reason: "fights" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const rows = await audits();
  assert.equal(rows.length, a0 + 1);
  const row = rows.at(-1);
  assert.equal(row.admin_id, "boss");
  assert.equal(row.admin_name, "boss");
  assert.equal(row.reason, "fights");
  const d = JSON.parse(row.detail);
  assert.deepEqual(d, { scope: "room", room: YW, set: { fair: true, rate: 25, breaker: [5, 8, 12], ceiling: 50 },
                        from: { fair: false, rate: 15, breaker: [4, 10, 15], ceiling: 20 }, action: r.d.id });
  await settle();
  // an audit row that can't be written: nothing is queued either (one transaction)
  const real = AA.record;
  AA.record = async () => { throw new Error("disk full"); };
  try {
    const x = await save({ scope: "global", set: { rate: 26 } });
    assert.equal(x.status, 500);
    assert.match(x.d.error, /nothing was changed/);
  } finally { AA.record = real; }
  assert.equal((await queued()).length, q0 + 1, "the failed one left no action behind");
  assert.equal((await audits()).length, a0 + 1);
});

test("20 changes a minute per admin, then 429", async () => {
  await pepeSays();
  await settle();
  let last = null;
  for (let i = 0; i < 21; i++) {
    last = await save({ scope: "global", set: { rate: 30 + i } });
    await settle();
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 429, JSON.stringify(last.d));
  assert.match(last.d.error, /20 fast-grab changes a minute/);
  FG._hits.reset("boss");
});

test("Pepe's answer: the action's message (what he stored) and his state push's last change (asked -> stored) reach the card's GET", async () => {
  await pepeSays();
  await settle();
  const r = await save({ scope: "room", room: YW, set: { rate: 999 } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const ack = await fetch(base + "/api/actions/ack", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", results: [{ id: r.d.id, ok: true, message: "⚡ Fast grab saved for Players Lounge only: rate 60/min (asked 999, clamped)" }] }) });
  assert.equal(ack.status, 200);
  const fg = block();
  fg.rooms[0].values.rate = 60;
  fg.last = [{ id: String(r.d.id), ts: Date.now() / 1000, ok: true, by: "boss", scope: "room", room: YW, set: { rate: 60 },
               clamped: { rate: { asked: [999], stored: [60] } }, followed: [], msg: "saved" }];
  await pepeSays(fg);
  const g = await api("GET", "boss");
  const act = g.d.actions.find((x) => x.id === r.d.id);
  assert.equal(act.status, "done");
  assert.match(act.message, /rate 60\/min \(asked 999, clamped\)/);
  const last = g.d.fg.last.find((x) => x.id === String(r.d.id));
  assert.deepEqual(last.clamped, { rate: { asked: [999], stored: [60] } });
  assert.equal(g.d.fg.rooms[0].values.rate, 60, "the card shows the value Pepe stored");
  assert.ok(g.d.audit.length >= 1 && g.d.audit[0].detail && g.d.audit[0].detail.action, "the card's audit list");
});

// ── the page ──

test("the rooms page renders the card: Pepe's current values, the rooms (room vs global), the push-to-talk pointer, the script; an older Pepe: the note and Save off", async () => {
  const ejs = require("ejs");
  await pepeSays();
  const render = async () => ejs.renderFile(path.join(repo, "views", "admin", "pepeRooms.ejs"),
    { user: "admin", title: "Admin", section: "pepe", isAdmin: true, v: await roomctl.view(), fg: await FG.view() });
  let html = await render();
  assert.match(html, /<section class="adm-card" id="fastgrab"/);
  assert.match(html, /href="\/admin\/bridge#pttlimits"/, "the pointer to the push-to-talk clip limits");
  assert.match(html, /<option value="room:You_Were_Never_Here">Players Lounge \(You_Were_Never_Here\)<\/option>/);
  assert.match(html, /<option value="room:PepeFrog.Room">Pepe&#39;s Pad \(PepeFrog.Room\)<\/option>/);
  assert.match(html, /<option value="global">Global default/);
  assert.match(html, /Global now: on on · contest off · fair on · claim swallow · web off · chatty off · rate 10 · shots 12 · tries 2 · breaker 4\/10\/15 · pause 4\/120\/90\/300 · fairwait 500\/350 · ceiling 20 · blockbreak on · selfunblock off · unblockcode none/);
  assert.match(html, /<b>Players Lounge<\/b> \(You_Were_Never_Here\): on on · contest on · fair off · claim swallow · rate 15 \(its own\)/);
  assert.match(html, /<b>Pepe&#39;s Pad<\/b> \(PepeFrog.Room\): follows the global/);
  assert.match(html, /<script src="\/public\/js\/admin-fastgrab.js\?v=2" defer><\/script>/, "(1.99?? micblock: v2 - the new rows)");
  assert.match(html, /Block break/, "micblock: the card explains the block break and the self-unblock");
  assert.match(html, /unblock code/i);
  const rawData = html.match(/<script type="application\/json" id="fgData">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(rawData).fg.global, vals({ on: true }), "the card's data: Pepe's values");
  assert.doesNotMatch(rawData, /</, "no raw < in the embedded data");
  assert.match(html, /<button type="button" id="fgSave">Save<\/button>/);
  // the rooms page itself still renders as before (golive test's locals: no fg) - and an older Pepe: the note, Save disabled
  await pepeSays(null);
  html = await ejs.renderFile(path.join(repo, "views", "admin", "pepeRooms.ejs"), { user: "admin", title: "Admin", section: "pepe", isAdmin: true, v: await roomctl.view() });
  assert.match(html, /This Pepe doesn&#39;t report his fast-grab settings yet - use !mic fastgrab/);
  assert.match(html, /id="fgSave" disabled/);
  // the nav and the Pepe hub point at it (and at the push-to-talk card)
  const nav = fs.readFileSync(path.join(repo, "views", "partials", "admin-nav.ejs"), "utf8");
  assert.match(nav, /\['\/admin\/pepe\/rooms#fastgrab', 'Fast mic grab', 'pepe.rooms_commands_audio'\]/);
  const hub = fs.readFileSync(path.join(repo, "views", "admin", "pepe.ejs"), "utf8");
  assert.match(hub, /href="\/admin\/pepe\/rooms#fastgrab"/);
  assert.match(hub, /href="\/admin\/bridge#pttlimits"/);
  await pepeSays();
});

// ── the card's script (public/js/admin-fastgrab.js) ──

function card(viewData) {
  const src = fs.readFileSync(path.join(repo, "public", "js", "admin-fastgrab.js"), "utf8");
  const byId = {}, posts = [];
  let view = viewData, tick = null;
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.text = ""; this.className = ""; this.value = ""; this.checked = false; this.hidden = false; }
    // a select takes only a value one of its options has (else "", like a browser's)
    get value() { return this._value; }
    set value(v) {
      const s = String(v);
      this._value = this.tagName === "SELECT" && this.children.length && !this.children.some((o) => o.value === s) ? "" : s;
    }
    set textContent(v) { this.children = []; this.text = String(v); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    fire(k) { (this.listeners[k] || []).forEach((fn) => fn({ target: this, preventDefault() {} })); }
    all() { return this.children.flatMap((c) => (c instanceof El ? [c, ...c.all()] : [])); }
    contains(n) { return n === this || this.all().includes(n); }
    querySelectorAll(sel) { return this.all().filter((n) => n.tagName === sel.toUpperCase()); }
  }
  for (const id of ["fastgrab", "fgWhere", "fgAll", "fgAllL", "fgRows", "fgContest", "fgSave", "fgUndo", "fgMsg", "fgLog", "fgOnline", "fgReason", "fgNow", "fgRoomsNow", "fgData"]) byId[id] = new El(id === "fgWhere" ? "select" : "div");
  byId.fgData.text = JSON.stringify(viewData);
  // activeElement: the box the admin is in (a test sets it, as focus would)
  const document = { getElementById: (id) => byId[id] || null, createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: String(t) }), hidden: false, activeElement: null };
  const window = {};
  const fetch = (url, opts) => {
    if (opts && opts.method === "POST") { posts.push(JSON.parse(opts.body)); return Promise.resolve({ json: async () => ({ ok: true, id: 4242 }) }); }
    return Promise.resolve({ json: async () => ({ ok: true, ...view }) });
  };
  require("node:vm").runInNewContext(src, { window, document, fetch, setInterval: (fn) => { tick = fn; return 1; }, confirm: () => true, Date, JSON, Object, Array, String, Number, parseInt, Math });
  const rowOf = (label) => byId.fgRows.children.find((tr) => tr.children[0].textContent.startsWith(label));
  const inputs = (f) => byId.fgRows.all().filter((n) => n.getAttribute && n.getAttribute("data-fg") === f);
  return { byId, posts, doc: document, api: window.PatvFastGrab, rowOf, inputs, poll: async (v) => { if (v) view = v; tick(); for (let i = 0; i < 20; i++) await Promise.resolve(); } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("card script, pure part: only the fields you changed are sent; contest on/off mirrors the command's bundle; follow; where", () => {
  const C = card({ online: false, fg: null, actions: [] }).api;
  assert.deepEqual(j(C.FIELDS), FG.FIELDS.slice(), "the card's fields = the site's (= Pepe's: the contract test)");
  assert.deepEqual(j(C.ARITY), { ...FG.ARITY });
  const fg = FG.cleanState(block());
  const G = { scope: "global", room: "" }, ALL = { scope: "all", room: "" }, R = (id) => ({ scope: "room", room: id });
  assert.equal(C.change(fg, G, {}, {}), null, "nothing changed");
  assert.deepEqual(j(C.change(fg, G, { rate: 10, shots: 20, breaker: [4, 10, 15], fair: false }, {})), { fair: false, shots: 20 }, "an edit back at Pepe's value isn't sent");
  assert.deepEqual(j(C.change(fg, R(YW), { rate: 30 }, { rate: true, claim: true })), { claim: "follow", rate: "follow" }, "follow wins over an edit");
  assert.deepEqual(j(C.implied(true)), { on: true, fair: false, claim: "swallow" }, "contest on = fast grab on + fair off + claim swallow");
  assert.deepEqual(j(C.implied(false)), { fair: true }, "contest off = fair on");
  // (review) Pepe applies contest FIRST, then the change's own on / fair / claim: a bundle field set back to Pepe's value is still sent
  assert.deepEqual(j(C.change(fg, R(PAD), { contest: true, fair: true }, {})), { contest: true, fair: true }, "Pad: contest on, fair kept on");
  assert.deepEqual(j(C.change(fg, R(PAD), { contest: true, fair: false, claim: "swallow" }, {})), { contest: true }, "...what the bundle sets anyway isn't");
  assert.equal(C.change(fg, R(PAD), { contest: false }, {}), null, "contest set back: nothing (no stray fast grab on)");
  assert.equal(C.shown(vals({ fair: true }), { contest: true }, "fair"), false, "the card shows the bundle");
  assert.equal(C.shown(vals({ fair: true }), { contest: true, fair: true }, "fair"), true, "...unless the admin set it");
  // (review) every room (-all): the global's own value still clears the rooms that have their own - an edit, or the row's box
  assert.deepEqual(j(C.change(fg, ALL, { rate: 10 }, {})), { rate: 10 }, "Players Lounge has its own rate: -all 10 clears it");
  assert.equal(C.change(fg, ALL, { shots: 12 }, {}), null, "no room has its own shots: nothing to do");
  assert.deepEqual(j(C.change(fg, ALL, { rate: 10, fair: true }, {})), { fair: true, rate: 10 }, "every room to the value shown (the global's)");
  assert.deepEqual(j(C.change(fg, ALL, { contest: false }, {})), { contest: false }, "...contest too (Players Lounge has its own; its bundle: fair on)");
  assert.equal(C.shown(C.current(fg, ALL), { contest: false }, "fair"), true);
  assert.equal(C.change(fg, G, {}, { rate: true }), null, "(follow is a room's: not for the global or every room)");
  assert.equal(C.change(fg, ALL, {}, { rate: true }), null);
  assert.deepEqual(j(C.overriders(fg, "rate").map((r) => r.id)), [YW]);
  assert.deepEqual(j(C.overriders(fg, "ceiling")), []);
  assert.equal(C.ownList(fg, "breaker"), "Houseplants 6 / 10 / 15 (partly)");
  assert.deepEqual(j(C.whereOf("room:PepeFrog.Room", true)), { scope: "room", room: PAD }, "a room ignores every room");
  assert.deepEqual(j(C.whereOf("global", true)), { scope: "all", room: "" });
  assert.deepEqual(j(C.whereOf("global", false)), { scope: "global", room: "" });
  assert.equal(C.num("12"), 12); assert.equal(C.num("-3"), -3); assert.equal(C.num("1.5"), null); assert.equal(C.num(""), null);
  assert.equal(C.sourceOf(fg, { scope: "room", room: YW }, "rate"), "room");
  assert.equal(C.sourceOf(fg, { scope: "room", room: PLANT }, "breaker"), "mixed");
  assert.equal(C.sourceOf(fg, { scope: "room", room: PAD }, "rate"), "global");
  assert.equal(C.sourceOf(fg, { scope: "room", room: YW }, "ceiling"), "every room");
  assert.equal(C.rangeText(fg, "breaker"), "1-50 / 1-120 / 0-240 · default 4 / 10 / 15");
  assert.equal(C.current(fg, { scope: "room", room: YW }).rate, 15);
  assert.equal(C.current(fg, { scope: "global", room: "" }).rate, 10);
});

test("card script in a fake page: Pepe's values drawn (room vs global), an edit + Save posts ONE change with only that field, Pepe's answer shows what he stored and clamped", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  const K = card(view);
  await flush();
  assert.equal(K.byId.fgRows.children.length, 16, "one row per setting (1.99?? micblock: + block break, self-unblock, unblock code)");
  assert.equal(K.byId.fgOnline.textContent, "live");
  assert.equal(K.byId.fgNow.hidden, true, "the page's snapshot gives way to the table");
  assert.equal(K.inputs("rate")[0].value, "10", "the global's rate (Where: global default)");
  assert.equal(K.inputs("on")[0].value, "on");
  assert.match(K.rowOf("Ceiling").textContent, /every room/);
  // a room: its own values, marked; follow offered where it has its own
  K.byId.fgWhere.value = "room:" + YW; K.byId.fgWhere.fire("change");
  assert.equal(K.inputs("rate")[0].value, "15");
  assert.match(K.rowOf("Rate").textContent, /this room's own/);
  assert.match(K.rowOf("Rate").textContent, /follow the global/);
  assert.match(K.rowOf("Shots").textContent, /global/);
  assert.doesNotMatch(K.rowOf("Shots").textContent, /follow the global/);
  assert.match(K.byId.fgContest.textContent, /Contest is active here/);
  // edit the rate, then the breaker's rest, then save
  K.inputs("rate")[0].value = "999"; K.inputs("rate")[0].fire("change");
  const br = K.inputs("breaker"); br[2].value = "30"; br[2].fire("change");
  assert.match(K.byId.fgContest.textContent, /2 change\(s\) not saved yet/);
  K.byId.fgReason.value = " fights ";
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 1);
  assert.deepEqual(K.posts[0], { scope: "room", room: YW, set: { rate: 999, breaker: [4, 10, 30] }, reason: "fights" });
  // Pepe answers: the action done + his push's last change for it
  const answered = JSON.parse(JSON.stringify(view));
  answered.actions = [{ id: 4242, status: "done", username: "boss", label: "Fast grab (Players Lounge): rate 999, breaker 4/10/30", message: "⚡ Fast grab saved for Players Lounge only: rate 60/min (asked 999, clamped) · breaker 4 in 10 min -> rest 30 min" }];
  answered.fg.rooms[0].values.rate = 60; answered.fg.rooms[0].values.breaker = [4, 10, 30];
  answered.fg.last = [{ id: "4242", set: { rate: 60, breaker: [4, 10, 30] }, clamped: { rate: { asked: [999], stored: [60] } }, followed: [] }];
  await K.poll(answered);
  assert.match(K.byId.fgMsg.textContent, /^✅ ⚡ Fast grab saved for Players Lounge only: rate 60\/min/);
  assert.match(K.byId.fgMsg.textContent, /Clamped: rate 999 → 60\./);
  assert.equal(K.inputs("rate")[0].value, "60", "the card now shows what Pepe stored");
  assert.doesNotMatch(K.byId.fgContest.textContent, /not saved/);
  // contest off in the card mirrors the command: fair goes back on (shown; Pepe's contest off sets it - his answer names it)
  const sel = K.inputs("contest")[0]; sel.value = "off"; sel.fire("change");
  assert.equal(K.inputs("fair")[0].value, "on");
  assert.match(K.byId.fgContest.textContent, /contest off also sets fair on/i);
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts[1].set, { contest: false });
  // follow: the room's own rate dropped
  await K.poll(answered);
  const fol = K.rowOf("Rate").all().find((n) => n.getAttribute("data-follow") === "rate");
  fol.checked = true; fol.fire("change");
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1).set.rate, "follow");
  assert.doesNotMatch(K.byId.fgRows.textContent, /undefined|NaN/);
});

test("card script (micblock): the unblock code is a text box - a good code + the switch post ONE change (trimmed, case kept); a code that could be a command is refused in the card and never sent", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  const K = card(view);
  await flush();
  K.byId.fgWhere.value = "room:" + YW; K.byId.fgWhere.fire("change");
  const box = K.inputs("unblockcode")[0];
  assert.ok(box, "the unblock code's box");
  assert.equal(box.tagName, "INPUT");
  assert.equal(box.value, "", "no code yet");
  assert.match(K.rowOf("Unblock code").textContent, /never starting with \/ or !/);
  assert.match(K.rowOf("Block break").textContent, /30-minute break/);
  assert.match(K.rowOf("Self-unblock").textContent, /types the room's unblock code/);
  assert.equal(K.inputs("blockbreak")[0].value, "on", "the block break: on by default");
  assert.equal(K.inputs("selfunblock")[0].value, "off", "self-unblock: off by default");
  box.value = "/kick bob"; box.fire("change");
  assert.match(K.byId.fgMsg.textContent, /can't start with \/ or !/);
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 0, "a code that could be a command is never sent");
  box.value = "  Ok 1 "; box.fire("change");
  K.inputs("selfunblock")[0].value = "on"; K.inputs("selfunblock")[0].fire("change");
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 1);
  assert.deepEqual(K.posts[0].set, { selfunblock: true, unblockcode: "Ok 1" });
  assert.doesNotMatch(K.byId.fgRows.textContent, /undefined|NaN/);
});

// ── the card's script: the review's cases (grabcard review) ──

const pick = (K, f, v) => { const s = K.inputs(f)[0]; s.value = v; s.fire("change"); return s; };
const typeIn = (inp, v) => { inp.value = v; inp.fire("change"); };
const goTo = (K, sel) => { K.byId.fgWhere.value = sel; K.byId.fgWhere.fire("change"); };

test("card script (review): contest's bundle - an on / fair / claim set back after contest changed it is still sent (Pepe applies contest first); contest set back sends nothing", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  // Pepe's Pad: fast grab on, fair on, contest off. Contest on shows fair off; the admin puts fair back on
  let K = card(view); await flush();
  goTo(K, "room:" + PAD);
  pick(K, "contest", "on");
  assert.equal(K.inputs("fair")[0].value, "off", "the card shows the bundle's fair off");
  pick(K, "fair", "on");
  assert.equal(K.inputs("fair")[0].value, "on");
  assert.equal(K.rowOf("Fairness wait").className, "fg-edited", "fair is still an edit (it differs from what contest on would store)");
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 1);
  assert.deepEqual(K.posts[0].set, { contest: true, fair: true }, "fair on is sent: Pepe's contest on alone would store fair off");
  // fast grab off in the room; contest on, then back off: nothing to send (no stray fast grab on)
  const off = JSON.parse(JSON.stringify(view));
  off.fg.rooms.find((r) => r.id === PAD).values.on = false;
  K = card(off); await flush();
  goTo(K, "room:" + PAD);
  pick(K, "contest", "on");
  assert.equal(K.inputs("on")[0].value, "on", "contest on shows fast grab on");
  pick(K, "contest", "off");
  assert.equal(K.inputs("on")[0].value, "off", "...and set back, Pepe's own off again");
  assert.equal(K.rowOf("Fast grab").className, "");
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 0, "nothing sent");
  assert.match(K.byId.fgMsg.textContent, /Nothing changed/);
});

test("card script (review): every room (-all) - the rooms with their own value are named per row, and the global's own value can be pushed to them (the row's box, or typed)", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  let K = card(view); await flush();
  // Where = the global: each row names the rooms that keep their own (the page's snapshot is hidden by the table)
  assert.match(K.rowOf("Rate").textContent, /Rooms with their own \(not changed by the global\): Players Lounge 15/);
  assert.match(K.rowOf("Breaker").textContent, /Houseplants 6 \/ 10 \/ 15 \(partly\)/);
  assert.doesNotMatch(K.rowOf("Shots").textContent, /their own/, "no room has its own shots");
  assert.doesNotMatch(K.rowOf("Ceiling").textContent, /their own/, "the ceiling is every room's");
  // every room: the box sets every room to the value shown - here the global's own 10 (Players Lounge's 15 cleared)
  K.byId.fgAll.checked = true; K.byId.fgAll.fire("change");
  const every = K.rowOf("Rate").all().find((n) => n.getAttribute("data-every") === "rate");
  assert.ok(every, "the rate row offers it (Players Lounge has its own)");
  assert.match(K.rowOf("Rate").textContent, /clears their own: Players Lounge 15/);
  assert.equal(K.rowOf("Shots").all().find((n) => n.getAttribute("data-every")), undefined, "...shots doesn't (nobody has their own)");
  every.checked = true; every.fire("change");
  const fairEvery = K.rowOf("Fairness wait").all().find((n) => n.getAttribute("data-every") === "fair");
  fairEvery.checked = true; fairEvery.fire("change");
  assert.match(K.byId.fgContest.textContent, /2 change\(s\) not saved yet/);
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1), { scope: "all", room: "", set: { fair: true, rate: 10 } }, "rate=10 + fair=on -all");
  // typed: another value, then the global's again - still a change (it clears Players Lounge's own); shots back at 12 is none
  K = card(view); await flush();
  K.byId.fgAll.checked = true; K.byId.fgAll.fire("change");
  typeIn(K.inputs("rate")[0], "11"); typeIn(K.inputs("rate")[0], "10");
  typeIn(K.inputs("shots")[0], "13"); typeIn(K.inputs("shots")[0], "12");
  assert.equal(K.rowOf("Rate").all().find((n) => n.getAttribute("data-every") === "rate").checked, true, "the typed global value = the row's box");
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1).set, { rate: 10 });
  // the box on contest is a contest edit: its bundle shows (fair on everywhere), unticked it all goes back
  K = card(view); await flush();
  K.byId.fgAll.checked = true; K.byId.fgAll.fire("change");
  const ce = K.rowOf("Contest").all().find((n) => n.getAttribute("data-every") === "contest");
  ce.checked = true; ce.fire("change");
  assert.match(K.byId.fgContest.textContent, /Contest off also sets fair on/);
  assert.equal(K.inputs("fair")[0].value, "on");
  ce.checked = false; ce.fire("change");
  assert.doesNotMatch(K.byId.fgContest.textContent, /not saved|also sets/);
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 0);
});

test("card script (review): the picked room drops out of Pepe's list - the card says so and drops its edits; nothing goes to the global (or every room)", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  const K = card(view); await flush();
  K.byId.fgAll.checked = true;                     // ticked earlier (hidden while a room is picked)
  goTo(K, "room:" + PAD);
  typeIn(K.inputs("rate")[0], "20");
  const gone = JSON.parse(JSON.stringify(view));
  gone.fg.rooms = gone.fg.rooms.filter((r) => r.id !== PAD);   // Pepe restarted / left the Pad
  await K.poll(gone);
  assert.equal(K.byId.fgWhere.value, "global");
  assert.match(K.byId.fgMsg.textContent, /no longer reports Pepe's Pad/);
  assert.match(K.byId.fgMsg.textContent, /unsaved changes for it were dropped/);
  assert.equal(K.byId.fgAll.checked, false, "every room unticked");
  assert.equal(K.inputs("rate")[0].value, "10", "the rows show the global now");
  assert.doesNotMatch(K.byId.fgContest.textContent, /not saved/);
  K.byId.fgSave.fire("click"); await flush();
  assert.equal(K.posts.length, 0, "the Pad's rate 20 never reaches the global");
});

test("card script (review): an edit never rebuilds the rows (the box the admin moves to stays); Pepe's answer keeps the edits made after Save and waits for the admin to leave a box", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  const K = card(view); await flush();
  goTo(K, "room:" + YW);
  // the 4 boxes of the contested pause: box 1 changed as the admin moves to box 2
  const p = K.inputs("pause");
  p[0].value = "3"; K.doc.activeElement = p[1]; p[0].fire("change");
  assert.ok(K.inputs("pause")[1] === p[1], "box 2 is still the box the admin is in");
  assert.equal(K.rowOf("Contested pause").className, "fg-edited");
  assert.match(K.byId.fgContest.textContent, /1 change\(s\) not saved yet/);
  const c = K.inputs("contest")[0]; K.doc.activeElement = c; c.value = "off"; c.fire("change");
  assert.ok(K.inputs("contest")[0] === c, "a select keeps its node (and focus) too");
  assert.equal(K.inputs("fair")[0].value, "on", "the bundle shows in place");
  assert.equal(K.rowOf("Fairness wait").className, "fg-edited");
  K.doc.activeElement = null;
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1).set, { contest: false, pause: [3, 120, 90, 300] });
  // while Pepe answers, the admin edits the shots and is still in the box
  const shots = K.inputs("shots")[0];
  typeIn(shots, "30"); K.doc.activeElement = shots;
  const answered = JSON.parse(JSON.stringify(view));
  const y = answered.fg.rooms.find((r) => r.id === YW).values;
  Object.assign(y, { contest: false, contest_active: false, fair: true, pause: [3, 120, 90, 300] });
  answered.actions = [{ id: 4242, status: "done", username: "boss", label: "Fast grab (Players Lounge): contest off, pause 3/120/90/300",
                        message: "⚡ Fast grab saved for Players Lounge only: contest off (with it: fair on) · pause 3 lost in 120 s" }];
  answered.fg.last = [{ id: "4242", set: { contest: false, fair: true, pause: [3, 120, 90, 300] }, clamped: {}, followed: [] }];
  await K.poll(answered);
  assert.match(K.byId.fgMsg.textContent, /^✅ .*with it: fair on/);
  assert.ok(K.inputs("shots")[0] === shots, "no redraw under the box being typed in");
  assert.equal(shots.value, "30");
  assert.match(K.byId.fgContest.textContent, /1 change\(s\) not saved yet/, "the shots edit survived the answer; the saved ones are done");
  // the admin leaves the box: the next poll redraws with what Pepe stored, the shots edit still there
  K.doc.activeElement = null;
  await K.poll(answered);
  assert.ok(K.inputs("shots")[0] !== shots, "redrawn now");
  assert.equal(K.inputs("shots")[0].value, "30");
  assert.equal(K.inputs("contest")[0].value, "off");
  assert.equal(K.rowOf("Contested pause").className, "");
  K.byId.fgSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1).set, { shots: 30 }, "the edit made after the first Save");
});

// ── the contract with Pepe (PEPE_BOT_DIR = a camfrog-bot checkout) ──

test("contract: the site's change through the bot's REAL pepe_fastgrabweb - the same fields; it stores and clamps; his state block cleaned here shows it; what the site refuses, he refuses", async (t) => {
  const botDir = process.env.PEPE_BOT_DIR;
  if (!botDir || !fs.existsSync(path.join(botDir, "pepe_fastgrabweb.py"))) { t.skip("PEPE_BOT_DIR (a camfrog-bot checkout) isn't set"); return; }
  await pepeSays();
  const good = [
    FG.validate({ scope: "room", room: YW, set: { rate: 999, fair: false, breaker: [0, 999, 999], claim: "release" } }, FG.cleanState(block())).args,
    FG.validate({ scope: "global", set: { tries: 4, web: true } }, FG.cleanState(block())).args,
    FG.validate({ scope: "room", room: YW, set: { rate: "follow" } }, FG.cleanState(block())).args,
    FG.validate({ scope: "all", set: { contest: true } }, FG.cleanState(block())).args,
    // 1.99?? micblock: the block break off + the self-unblock with its code (trimmed, case kept) in Pepe's Pad only
    FG.validate({ scope: "room", room: PAD, set: { blockbreak: false, selfunblock: true, unblockcode: " Ok 1 " } }, FG.cleanState(block())).args,
  ];
  const badArgs = [["room", YW, "volume=11"], ["room", YW, "rate=1.5"], ["global", "", "rate=follow"], ["room", YW, "breaker=1,2"],
                   ["room", YW, "unblockcode=/kick bob"], ["room", YW, "unblockcode=!sb x"], ["room", YW, "unblockcode=" + "x".repeat(21)],
                   ["room", YW, "selfunblock=maybe"]];
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fastgrab-contract-")), "contract.py");
  fs.writeFileSync(script, [
    "import json, os, sys",
    "bot_dir = sys.argv[1]",
    "sys.path.insert(0, bot_dir)",
    "os.chdir(bot_dir)",
    "import pepe_fastgrabweb as FW",
    "import tables_test as tt",
    "cases = json.loads(open(sys.argv[2], encoding='utf-8').read())",
    "bot = tt.make_bot()",
    "bot.__dict__.pop('_here', None)",
    "bot.__dict__.update(_fd_room={7001: 'You_Were_Never_Here', 5008: 'PepeFrog.Room', 6384: 'plant_based_chatting'}, _room_settings={}, _current_room=None)",
    "names = {'You_Were_Never_Here': 'Players Lounge', 'PepeFrog.Room': \"Pepe's Pad\", 'plant_based_chatting': 'Houseplants'}",
    "bot._rj_display_for = lambda r: names.get(r, r)",
    "bot._save_settings = lambda *a, **k: None",
    "bot._rc_push_soon = lambda delay=1.5: None",
    "bot._mg_fair_push = lambda why: None",
    "bot._mg_disarm_all_soon = lambda why, pick=None: None",
    "bot.script = None",
    "out = {'fields': list(FW.FIELDS), 'arity': FW.ARITY, 'claims': list(FW.CLAIMS), 'good': [], 'bad': []}",
    "for i, args in enumerate(cases['good']):",
    "    ok, msg = bot._fgw_web({'id': 100 + i, 'kind': 'mic.fastgrab', 'site_admin': True, 'username': 'boss', 'user_id': 'boss'}, args)",
    "    out['good'].append([ok, msg])",
    "for args in cases['bad']:",
    "    ok, msg = bot._fgw_web({'id': 1, 'kind': 'mic.fastgrab', 'site_admin': True, 'username': 'boss'}, args)",
    "    out['bad'].append([ok, msg])",
    "ok, msg = bot._fgw_web({'id': 2, 'kind': 'mic.fastgrab', 'username': 'boss'}, cases['good'][0])",
    "out['nonadmin'] = [ok, msg]",
    "out['state'] = bot._fgw_state()",
    "sys.stdout.write('\\n' + json.dumps(out) + '\\n')",
  ].join("\n"));
  const input = script.replace(/contract\.py$/, "cases.json");
  fs.writeFileSync(input, JSON.stringify({ good, bad: badArgs }));
  const raw = execFileSync(process.env.PYTHON || "python", [script, botDir, input], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 16 * 1024 * 1024 });
  const out = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual(out.fields.slice().sort(), FG.FIELDS.slice().sort(), "the same fields");
  assert.deepEqual(out.arity, FG.ARITY, "the same number counts");
  assert.deepEqual(out.claims, FG.CLAIMS);
  for (const [i, [ok, msg]] of out.good.entries()) assert.equal(ok, true, `${good[i].join(" ")} -> ${msg}`);
  assert.match(out.good[0][1], /Players Lounge only: .*rate 60\/min \(asked 999, clamped\)/);
  for (const [i, [ok, msg]] of out.bad.entries()) { assert.equal(ok, false, badArgs[i].join(" ")); assert.match(msg, /^bad /); }
  assert.equal(out.nonadmin[0], false);
  // his state, cleaned by the site: the stored values and the clamps of the first change
  const st = FG.cleanState(out.state);
  assert.ok(st, "his block passes the site's cleaner");
  const y = st.rooms.find((r) => r.id === YW);
  assert.equal(y.name, "Players Lounge");
  assert.equal(y.values.rate, 10, "the follow (3rd change) put the rate back on the global");
  assert.equal(y.values.fair, false);
  assert.equal(y.values.claim, "swallow", "contest on -all = claim swallow in every room (the room's own release cleared, like the command)");
  assert.deepEqual(y.values.breaker, [1, 120, 240], "clamped");
  assert.equal(st.global.tries, 4); assert.equal(st.global.web, true);
  assert.equal(st.global.contest, true, "all: contest on everywhere");
  const first = st.last.find((x) => x.id === "100");
  assert.deepEqual(first.clamped.rate, { asked: [999], stored: [60] });
  assert.deepEqual(first.clamped.breaker, { asked: [0, 999, 999], stored: [1, 120, 240] });
  assert.deepEqual(st.ranges, FG.cleanState(block()).ranges, "the ranges the card shows = his");
  // micblock: Pepe's Pad's own block break off, self-unblock on with its code; the others keep the defaults
  const pad = st.rooms.find((r) => r.id === PAD);
  assert.equal(pad.values.blockbreak, false); assert.equal(pad.values.selfunblock, true); assert.equal(pad.values.unblockcode, "Ok 1");
  assert.deepEqual(pad.own, { blockbreak: "room", selfunblock: "room", unblockcode: "room" });
  assert.equal(y.values.blockbreak, true); assert.equal(y.values.selfunblock, false); assert.equal(y.values.unblockcode, "");
  assert.equal(st.defaults.blockbreak, true); assert.equal(st.defaults.selfunblock, false); assert.equal(st.defaults.unblockcode, "");
  assert.match(out.good[4][1], /Pepe's Pad only: .*block break off .*unblock code 'Ok 1' .*self-unblock on/);
  // and the whole block fits the rooms state push
  assert.equal(await roomctl.setState({ rooms: ROOMS, fastgrab: out.state }), true);
  assert.ok(JSON.stringify(roomctl.cleanState({ rooms: ROOMS, fastgrab: out.state })).length < 64 * 1024);
});
