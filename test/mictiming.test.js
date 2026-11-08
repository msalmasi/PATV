// micspeed (the owner, 2026-11-08: the mic timing pads on Pepe's own panel - "Lets add this to the web panel as well"; "Give pepe a list of
// people he should yield the mic to when the yield command is active. (Admin page configurable)"; + the speed-ups a measurement found, each
// one he can turn back): the ⏱ Mic timing card on /admin/pepe/rooms#mictiming (mictiming.js, public/js/admin-mictiming.js), beside the
// Fast mic grab card and on the same path:
//   * the values Pepe has now ride his rooms state push (state.mictiming: each field, the defaults / ranges, the yield's state, his last
//     changes with what he stored and clamped), cleaned here
//   * a save = ONE website action kind "mic.timing" ["field=value", ...] (+ one admin_audit row pepe.mictiming in the same transaction);
//     Pepe checks the whole change, clamps, saves, acks with what he stored
//   * site Admins only (pepe.rooms_commands_audio, by the account's class in the database), a same-site fetch, 20 a minute
//   * the site checks the SHAPE (a known field, seconds with at most 2 decimals, whole milliseconds, on / off, a list of logins); the
//     ranges are Pepe's (he clamps, the card shows asked -> stored)
//   * PEPE_BOT_DIR=<camfrog-bot checkout>: the contract test runs the site's change through the bot's REAL pepe_micspeed
//   node --test test/mictiming.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mictiming-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const roomctl = require(path.join(repo, "roomctl"));
const MT = require(path.join(repo, "mictiming"));
const AA = require(path.join(repo, "adminaudit"));

const YW = "You_Were_Never_Here", PAD = "PepeFrog.Room";
const users = new Map([
  ["boss", { userId: "boss", username: "boss", class: "Admin" }],
  ["helper", { userId: "helper", username: "helper", class: "Staff" }],
  ["p1", { userId: "p1", username: "p1_patv", class: "pleb" }],
  ["demoted", { userId: "exadmin", username: "exadmin", class: "Admin" }],
]);

// What Pepe's _mt_state() sends (camfrog-bot pepe_micspeed.py; the contract test below checks the real one)
const vals = (o = {}) => ({ grabconfirm: 0.0, leadin: 0.0, tailout: 0.6, websettle: 2.0, talkplay: true, confirm: 200, clickretry: 300,
  ttspoll: 100, yieldlist: [], ...o });
function block(o = {}) {
  return {
    v: 1, fields: ["grabconfirm", "leadin", "tailout", "websettle", "talkplay", "confirm", "clickretry", "ttspoll", "yieldlist"],
    values: vals(),
    defaults: { grabconfirm: 0.8, leadin: 0.0, tailout: 0.9, websettle: 2.0, talkplay: true, confirm: 200, clickretry: 300, ttspoll: 100, yieldlist: [] },
    ranges: { grabconfirm: [0, 10], leadin: [0, 10], tailout: [0, 10], websettle: [0, 5], confirm: [100, 500], clickretry: [150, 1000],
              ttspoll: [50, 1000], yieldlist: [0, 20] },
    yield: { on: false, until: null, left_min: null, by: "", present: [], default_min: 60, max_min: 720 },
    last: [],
    ...o,
  };
}
const ROOMS = [{ id: YW, name: "Players Lounge" }, { id: PAD, name: "Pepe's Pad" }];
async function pepeSays(mt = block()) {
  assert.equal(await roomctl.setState({ rooms: ROOMS, ...(mt ? { mictiming: mt } : {}) }), true);
  MT._hits.reset("boss");
}
const j = (x) => JSON.parse(JSON.stringify(x));

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
  MT.register(app, { addUser });
  require(path.join(repo, "actions")).register(app, { isBotToken, addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await roomctl.init();
  await AA.init();
});
test.after(() => server.close());

async function api(method, who, body, headers = {}) {
  const h = Object.assign({}, who ? { "x-test-user": who } : {}, body ? { "content-type": "application/json" } : {}, headers);
  const r = await fetch(base + "/api/admin/pepe/mictiming", { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const save = (body, who = "boss") => api("POST", who, body, { "x-requested-with": "fetch" });
const queued = () => getQuery("SELECT id, kind, args, label, tag, site_admin, status FROM pepe_actions WHERE kind = 'mic.timing' ORDER BY id");
const audits = () => getQuery("SELECT * FROM admin_audit WHERE action = 'pepe.mictiming' ORDER BY id");
async function settle() {
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'mic.timing' AND status IN ('pending', 'claimed')");
}

// ── what Pepe reports ──

test("Pepe's mictiming block is cleaned: the card's fields, each its own type; junk dropped; the yield's state; an older Pepe has none", () => {
  const dirty = block({ evil: "<script>", values: { ...vals({ leadin: "lots", confirm: 1.5, talkplay: "yes", yieldlist: ["Owner1", "x".repeat(41)] }), extra: 1 },
    yield: { on: true, until: 1700000600, left_min: 42, by: "Boss".repeat(30), default_min: 60, max_min: 720,
             present: [{ room: YW, name: "Players Lounge", who: ["Owner One"], holding: ["Owner One"], junk: 1 }, { name: "no room" }] },
    last: [{ id: 7, ts: 1700000000, by: "boss", set: { confirm: 100, junk: 1, leadin: "x" }, clamped: { confirm: { asked: 50, stored: 100 } }, msg: "ok" }] });
  const c = MT.cleanState(dirty);
  assert.equal(c.v, 1);
  assert.equal(c.evil, undefined);
  assert.equal(c.values.leadin, undefined, "a number that isn't one is left out");
  assert.equal(c.values.confirm, undefined, "milliseconds are whole");
  assert.equal(c.values.talkplay, undefined);
  assert.equal(c.values.yieldlist, undefined, "a list Pepe would refuse is left out");
  assert.equal(c.values.extra, undefined);
  assert.equal(c.values.tailout, 0.6);
  assert.deepEqual(c.ranges.confirm, [100, 500]);
  assert.deepEqual(c.defaults.yieldlist, []);
  assert.equal(c.defaults.grabconfirm, 0.8);
  assert.deepEqual(c.yield.present, [{ room: YW, name: "Players Lounge", who: ["Owner One"], holding: ["Owner One"] }]);
  assert.equal(c.yield.on, true); assert.equal(c.yield.left_min, 42); assert.equal(c.yield.until, 1700000600 * 1000);
  assert.equal(c.yield.by.length, 60);
  assert.deepEqual(c.last[0].set, { confirm: 100 });
  assert.deepEqual(c.last[0].clamped, { confirm: { asked: 50, stored: 100 } });
  assert.equal(c.last[0].ts, 1700000000 * 1000);
  const off = MT.cleanState(block({ yield: { on: false, present: [{ room: YW, who: ["x"] }], by: "boss", left_min: 3 } }));
  assert.deepEqual([off.yield.on, off.yield.present, off.yield.by, off.yield.left_min], [false, [], "", null], "yield off: nothing about who is where");
  assert.equal(MT.cleanState(null), null);
  assert.equal(MT.cleanState({ v: 0 }), null);
  // the rooms state keeps it (and an older Pepe's push has none)
  const s = roomctl.cleanState({ rooms: ROOMS, mictiming: block() });
  assert.ok(s.mictiming && s.mictiming.v === 1);
  assert.equal(roomctl.cleanState({ rooms: ROOMS }).mictiming, undefined);
});

test("admins only (the account's class in the database), signed in; a change needs a same-site fetch", async () => {
  await pepeSays();
  assert.equal((await api("GET", null)).status, 401);
  assert.equal((await api("GET", "p1")).status, 403);
  assert.equal((await api("GET", "helper")).status, 403, "Staff can't");
  assert.equal((await api("GET", "demoted")).status, 403, "a stale Admin sign-in: the database's class decides");
  const g = await api("GET", "boss");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.equal(g.d.online, true);
  assert.deepEqual(g.d.mt.values, vals());
  const body = { set: { leadin: 0.1 } };
  assert.equal((await api("POST", "boss", body)).status, 403, "no X-Requested-With");
  assert.equal((await api("POST", "boss", body, { "x-requested-with": "fetch", origin: "https://evil.example" })).status, 403, "another site");
  assert.equal((await save(body, "helper")).status, 403);
  assert.equal((await save(body, "p1")).status, 403);
  assert.equal((await save(body, "demoted")).status, 403);
  assert.equal((await api("POST", null, body, { "x-requested-with": "fetch" })).status, 401);
  assert.equal((await queued()).length, 0, "nothing queued");
  assert.equal((await audits()).length, 0, "nothing audited");
});

test("Pepe offline, or an older Pepe without the block -> 409, nothing queued", async () => {
  await pepeSays(null);
  let r = await save({ set: { leadin: 0.1 } });
  assert.equal(r.status, 409);
  assert.match(r.d.error, /doesn't report his mic timing/);
  await pepeSays();
  roomctl._setClock(() => Date.now() + 5 * 60e3);
  try {
    r = await save({ set: { leadin: 0.1 } });
    assert.equal(r.status, 409);
    assert.match(r.d.error, /isn't reporting/);
  } finally { roomctl._setClock(null); }
  assert.equal((await queued()).length, 0);
});

test("validation: the shape - a known field, seconds (2 decimals), whole milliseconds, on/off, a list of logins; else 400 naming it, nothing queued", async () => {
  await pepeSays();
  const bad = [
    [{}, "set"], [{ set: {} }, "set"], [{ set: [1] }, "set"], [{ set: { volume: 11 } }, "volume"], [{ set: { leadin: 0.1, probe: 3 } }, "probe"],
    [{ set: { leadin: "abc" } }, "leadin"], [{ set: { leadin: 1000 } }, "leadin"], [{ set: { leadin: "0.1234" } }, "leadin"],
    [{ set: { confirm: 1.5 } }, "confirm"], [{ set: { confirm: "fast" } }, "confirm"], [{ set: { confirm: 10000000 } }, "confirm"],
    [{ set: { talkplay: "maybe" } }, "talkplay"], [{ set: { talkplay: 1 } }, "talkplay"],
    [{ set: { yieldlist: "x".repeat(41) } }, "yieldlist"], [{ set: { yieldlist: Array.from({ length: 21 }, (_, i) => "u" + i) } }, "yieldlist"],
    [{ set: { yieldlist: 5 } }, "yieldlist"], [{ set: { yieldlist: "a\u0007b" } }, "yieldlist"],
  ];
  for (const [body, field] of bad) {
    const r = await save(body);
    assert.equal(r.status, 400, JSON.stringify(body) + " " + JSON.stringify(r.d));
    assert.equal(r.d.field, field, JSON.stringify(body));
    assert.ok(r.d.error && r.d.error.length > 5);
  }
  assert.equal((await queued()).length, 0, "nothing queued");
  // the ranges are Pepe's: 9000 ms is a fine shape - he clamps it and says so
  const ok = await save({ set: { confirm: 9000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.deepEqual(ok.d.args, ["confirm=9000"]);
  await settle();
});

test("payload: ONE action kind mic.timing [field=value...] in the card's order, site_admin, a readable label; the types the form sends", async () => {
  await pepeSays();
  await settle();
  const r = await save({ reason: "faster clips", set: { yieldlist: " Owner1, @Bob owner1 ", ttspoll: "100", confirm: 200, talkplay: "off",
    websettle: "1.5", tailout: 0.6, leadin: 0.1, grabconfirm: "0", clickretry: 250 } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const a = (await queued()).at(-1);
  assert.equal(a.id, r.d.id);
  assert.deepEqual(JSON.parse(a.args), ["grabconfirm=0.00", "leadin=0.10", "tailout=0.60", "websettle=1.50", "talkplay=off", "confirm=200",
                                         "clickretry=250", "ttspoll=100", "yieldlist=owner1,@bob"],
    "the card's order; seconds with 2 decimals; on/off; the logins cleaned (lower case, deduped)");
  assert.equal(a.site_admin, 1);
  assert.equal(a.tag, "pepe-mictiming");
  assert.match(a.label, /^Mic timing: grab confirm 0 s, lead-in 0.1 s, tail-out 0.6 s, web clip settle 1.5 s, Talk check during the clip off, fast-grab confirm 200 ms/);
  assert.ok(a.label.length <= 200, "(a long label is cut at 200 - the args carry the change)");
  await settle();
  const yl = await save({ set: { yieldlist: ["Owner1", "@bob"] } });
  assert.equal((await queued()).at(-1).label, "Mic timing: yield list owner1, @bob");
  assert.deepEqual(yl.d.args, ["yieldlist=owner1,@bob"]);
  await settle();
  const none = await save({ set: { yieldlist: "" } });
  assert.deepEqual(none.d.args, ["yieldlist="], "an empty list = nobody");
  assert.equal((await queued()).at(-1).label, "Mic timing: yield list nobody");
  await settle();
  const d1 = await save({ set: { ttspoll: 150 } });
  const d2 = await save({ set: { ttspoll: 150 } });
  assert.equal(d1.status, 200);
  assert.equal(d2.status, 409, "the same change still waiting for Pepe: refused, not queued twice");
  await settle();
});

test("audit: one admin_audit row pepe.mictiming per change - what it sets, what it replaces (Pepe's last values), the action, the reason", async () => {
  await pepeSays();
  await settle();
  const a0 = (await audits()).length, q0 = (await queued()).length;
  const r = await save({ set: { leadin: 0.15, yieldlist: "owner1" }, reason: "PepeLite" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const row = (await audits()).at(-1);
  assert.equal(row.admin_id, "boss");
  assert.equal(row.reason, "PepeLite");
  assert.deepEqual(JSON.parse(row.detail), { set: { leadin: 0.15, yieldlist: ["owner1"] }, from: { leadin: 0, yieldlist: [] }, action: r.d.id });
  await settle();
  const real = AA.record;
  AA.record = async () => { throw new Error("disk full"); };
  try {
    const x = await save({ set: { leadin: 0.2 } });
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
    last = await save({ set: { clickretry: 200 + i } });
    await settle();
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 429, JSON.stringify(last.d));
  assert.match(last.d.error, /20 mic timing changes a minute/);
  MT._hits.reset("boss");
});

test("Pepe's answer: the action's message (what he stored) and his push's last change (asked -> stored) reach the card's GET", async () => {
  await pepeSays();
  await settle();
  const r = await save({ set: { confirm: 50 } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const ack = await fetch(base + "/api/actions/ack", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", results: [{ id: r.d.id, ok: true, message: "⏱ Mic timing saved: fast-grab confirm 100 ms (asked 50, clamped)" }] }) });
  assert.equal(ack.status, 200);
  const mt = block({ values: vals({ confirm: 100 }), last: [{ id: String(r.d.id), ts: Date.now() / 1000, ok: true, by: "boss", set: { confirm: 100 },
                                                              clamped: { confirm: { asked: 50, stored: 100 } }, msg: "saved" }] });
  await pepeSays(mt);
  const g = await api("GET", "boss");
  const act = g.d.actions.find((x) => x.id === r.d.id);
  assert.equal(act.status, "done");
  assert.match(act.message, /fast-grab confirm 100 ms \(asked 50, clamped\)/);
  assert.deepEqual(g.d.mt.last.find((x) => x.id === String(r.d.id)).clamped, { confirm: { asked: 50, stored: 100 } });
  assert.equal(g.d.mt.values.confirm, 100);
  assert.ok(g.d.audit.length >= 1 && g.d.audit[0].detail && g.d.audit[0].detail.action);
});

// ── the page ──

test("the rooms page renders the card: Pepe's values, the yield, the script; an older Pepe: the note and Save off; the nav and the hub", async () => {
  const ejs = require("ejs");
  await pepeSays(block({ yield: { on: true, until: Date.now() / 1000 + 600, left_min: 10, by: "Boss", present: [], default_min: 60, max_min: 720 } }));
  const FG = require(path.join(repo, "fastgrab"));
  let html = await ejs.renderFile(path.join(repo, "views", "admin", "pepeRooms.ejs"),
    { user: "admin", title: "Admin", section: "pepe", isAdmin: true, v: await roomctl.view(), fg: await FG.view(), mt: await MT.view() });
  assert.match(html, /<section class="adm-card" id="mictiming"/);
  assert.match(html, /<section class="adm-card" id="fastgrab"/, "beside the Fast mic grab card");
  assert.match(html, /Now: grabconfirm 0 s · leadin 0 s · tailout 0.6 s · websettle 2 s · talkplay on · confirm 200 ms · clickretry 300 ms · ttspoll 100 ms · yieldlist nobody/);
  assert.match(html, /🤝 Yield is ON for 10 more min\./);
  assert.match(html, /!mic yield on \[minutes\]/);
  assert.match(html, /<script src="\/public\/js\/admin-mictiming.js\?v=1" defer><\/script>/);
  const raw = html.match(/<script type="application\/json" id="mtData">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(raw).mt.values, vals());
  assert.doesNotMatch(raw, /</, "no raw < in the embedded data");
  assert.match(html, /<button type="button" id="mtSave">Save<\/button>/);
  await pepeSays(null);
  html = await ejs.renderFile(path.join(repo, "views", "admin", "pepeRooms.ejs"), { user: "admin", title: "Admin", section: "pepe", isAdmin: true, v: await roomctl.view() });
  assert.match(html, /This Pepe doesn&#39;t report his mic timing yet/);
  assert.match(html, /id="mtSave" disabled/);
  const nav = fs.readFileSync(path.join(repo, "views", "partials", "admin-nav.ejs"), "utf8");
  assert.match(nav, /\['\/admin\/pepe\/rooms#mictiming', 'Mic timing', 'pepe.rooms_commands_audio'\]/);
  const hub = fs.readFileSync(path.join(repo, "views", "admin", "pepe.ejs"), "utf8");
  assert.match(hub, /href="\/admin\/pepe\/rooms#mictiming"/);
  await pepeSays();
});

// ── the card's script (public/js/admin-mictiming.js) ──

function card(viewData) {
  const src = fs.readFileSync(path.join(repo, "public", "js", "admin-mictiming.js"), "utf8");
  const byId = {}, posts = [];
  let view = viewData, tick = null;
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.text = ""; this.className = ""; this.value = ""; this.checked = false; this.hidden = false; }
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
  for (const id of ["mictiming", "mtRows", "mtSave", "mtUndo", "mtMsg", "mtLog", "mtOnline", "mtReason", "mtNow", "mtYield", "mtPending", "mtData"]) byId[id] = new El("div");
  byId.mtData.text = JSON.stringify(viewData);
  const document = { getElementById: (id) => byId[id] || null, createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: String(t) }), hidden: false, activeElement: null };
  const window = {};
  const fetch = (url, opts) => {
    if (opts && opts.method === "POST") { posts.push(JSON.parse(opts.body)); return Promise.resolve({ json: async () => ({ ok: true, id: 4242 }) }); }
    return Promise.resolve({ json: async () => ({ ok: true, ...view }) });
  };
  require("node:vm").runInNewContext(src, { window, document, fetch, setInterval: (fn) => { tick = fn; return 1; }, confirm: () => true, Date, JSON, Object, Array, String, Number, parseInt, parseFloat, Math });
  const rowOf = (label) => byId.mtRows.children.find((tr) => tr.children[0].textContent.startsWith(label));
  const inputs = (f) => byId.mtRows.all().filter((n) => n.getAttribute && n.getAttribute("data-mt") === f);
  return { byId, posts, doc: document, api: window.PatvMicTiming, rowOf, inputs, poll: async (v) => { if (v) view = v; tick(); for (let i = 0; i < 20; i++) await Promise.resolve(); } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("card script, pure part: the site's fields; only what changes is sent; the yield list cleaned like the site cleans it; ranges and defaults in words", () => {
  const C = card({ online: false, mt: null, actions: [] }).api;
  assert.deepEqual(j(C.FIELDS), MT.FIELDS.slice(), "the card's fields = the site's (= Pepe's: the contract test)");
  const mt = MT.cleanState(block());
  assert.equal(C.change(mt, {}), null);
  assert.deepEqual(j(C.change(mt, { leadin: 0, confirm: 250, yieldlist: [] })), { confirm: 250 }, "an edit back at Pepe's value isn't sent");
  for (const v of [" A, b  a\nC ", "none", "", "x".repeat(41), Array.from({ length: 21 }, (_, i) => "u" + i).join(",")]) {
    const site = MT.listClean(v), cardv = C.listOf(v);
    assert.deepEqual([j(cardv.logins), !!cardv.err], [site.logins, !!site.err], JSON.stringify(v));
  }
  assert.equal(C.numOf("leadin", "0.15"), 0.15); assert.equal(C.numOf("leadin", "0.155"), 0.16); assert.equal(C.numOf("leadin", "x"), null);
  assert.equal(C.numOf("confirm", "200"), 200); assert.equal(C.numOf("confirm", "2.5"), null);
  assert.equal(C.rangeText(mt, "confirm"), "100-500 ms · default 200 ms");
  assert.equal(C.rangeText(mt, "grabconfirm"), "0-10 s · default 0.8 s");
  assert.equal(C.rangeText(mt, "talkplay"), "default on");
  assert.match(C.yieldText(mt.yield), /^Yield is off - turn it on with !mic yield on \[minutes\]/);
  assert.equal(C.yieldText({ on: true, left_min: 5, by: "Boss", present: [{ room: YW, name: "Players Lounge", who: ["Owner One", "Bob"], holding: ["Bob"] }] }),
    "🤝 Yield is ON for 5 more min (by Boss). Holding back in Players Lounge: Owner One, Bob (on the mic).");
});

test("card script in a fake page: Pepe's values drawn, an edit + Save posts ONE change with only that field, Pepe's answer shows what he stored and clamped", async () => {
  await pepeSays();
  const view = (await api("GET", "boss")).d;
  const K = card(view);
  await flush();
  assert.equal(K.byId.mtRows.children.length, 9, "one row per setting");
  assert.equal(K.byId.mtOnline.textContent, "live");
  assert.equal(K.byId.mtNow.hidden, true, "the page's snapshot gives way to the table");
  assert.equal(K.inputs("tailout")[0].value, "0.6");
  assert.equal(K.inputs("talkplay")[0].value, "on");
  assert.equal(K.inputs("yieldlist")[0].value, "");
  assert.match(K.rowOf("Fast-grab confirm window").textContent, /100-500 ms · default 200 ms/);
  assert.match(K.byId.mtYield.textContent, /Yield is off/);
  K.inputs("confirm")[0].value = "50"; K.inputs("confirm")[0].fire("change");
  K.inputs("yieldlist")[0].value = "Owner1, owner1, @Bob"; K.inputs("yieldlist")[0].fire("change");
  assert.match(K.byId.mtPending.textContent, /2 change\(s\) not saved yet/);
  K.byId.mtReason.value = " PepeLite ";
  K.byId.mtSave.fire("click"); await flush();
  assert.equal(K.posts.length, 1);
  assert.deepEqual(K.posts[0], { set: { confirm: 50, yieldlist: ["owner1", "@bob"] }, reason: "PepeLite" });
  const answered = JSON.parse(JSON.stringify(view));
  answered.actions = [{ id: 4242, status: "done", username: "boss", label: "Mic timing: fast-grab confirm 50 ms, yield list owner1, @bob",
                        message: "⏱ Mic timing saved: fast-grab confirm 100 ms (asked 50, clamped) · yield list owner1, @bob" }];
  answered.mt.values.confirm = 100; answered.mt.values.yieldlist = ["owner1", "@bob"];
  answered.mt.last = [{ id: "4242", set: { confirm: 100, yieldlist: ["owner1", "@bob"] }, clamped: { confirm: { asked: 50, stored: 100 } } }];
  await K.poll(answered);
  assert.match(K.byId.mtMsg.textContent, /^✅ ⏱ Mic timing saved: fast-grab confirm 100 ms/);
  assert.match(K.byId.mtMsg.textContent, /Clamped: confirm 50 ms → 100 ms\./);
  assert.equal(K.inputs("confirm")[0].value, "100", "the card now shows what Pepe stored");
  assert.equal(K.inputs("yieldlist")[0].value, "owner1, @bob");
  assert.doesNotMatch(K.byId.mtPending.textContent, /not saved/);
  // a bad list is refused in the card and never sent
  K.inputs("yieldlist")[0].value = "x".repeat(41); K.inputs("yieldlist")[0].fire("change");
  assert.match(K.byId.mtMsg.textContent, /at most 40 characters/);
  K.byId.mtSave.fire("click"); await flush();
  assert.equal(K.posts.length, 1, "nothing sent");
  // the talk check switch
  const sel = K.inputs("talkplay")[0]; sel.value = "off"; sel.fire("change");
  K.byId.mtSave.fire("click"); await flush();
  assert.deepEqual(K.posts.at(-1).set, { talkplay: false });
  assert.doesNotMatch(K.byId.mtRows.textContent, /undefined|NaN/);
});

// ── the contract with Pepe (PEPE_BOT_DIR = a camfrog-bot checkout) ──

test("contract: the site's change through the bot's REAL pepe_micspeed - the same fields; he stores and clamps; his block cleaned here shows it; what the site refuses, he refuses", async (t) => {
  const botDir = process.env.PEPE_BOT_DIR;
  if (!botDir || !fs.existsSync(path.join(botDir, "pepe_micspeed.py"))) { t.skip("PEPE_BOT_DIR (a camfrog-bot checkout) isn't set"); return; }
  const good = [
    MT.validate({ set: { grabconfirm: 0.15, leadin: 0.1, tailout: 0.6, websettle: 9, talkplay: false, confirm: 50, clickretry: 250, ttspoll: 100,
                         yieldlist: "Owner1, @Bob" } }).args,
    MT.validate({ set: { confirm: 9999, clickretry: 10, ttspoll: 1 } }).args,
    MT.validate({ set: { yieldlist: "" } }).args,
    MT.validate({ set: { yieldlist: "owner1", talkplay: "on" } }).args,
  ];
  const badArgs = [["volume=11"], ["confirm=1.5"], ["leadin=abc"], ["talkplay=maybe"], ["confirm=200", "confirm=300"],
                   ["yieldlist=" + "x".repeat(41)], ["yieldlist=" + Array.from({ length: 21 }, (_, i) => "u" + i).join(",")]];
  const lists = [" A, b  a\nC ", "none", "", "x".repeat(41), "a;b", "@Bob", Array.from({ length: 21 }, (_, i) => "u" + i).join(",")];
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mictiming-contract-")), "contract.py");
  fs.writeFileSync(script, [
    "import json, os, sys, time",
    "bot_dir = sys.argv[1]",
    "sys.path.insert(0, bot_dir)",
    "os.chdir(bot_dir)",
    "import pepe_micspeed as MS",
    "import tables_test as tt",
    "cases = json.loads(open(sys.argv[2], encoding='utf-8').read())",
    "bot = tt.make_bot()",
    "bot.__dict__.update(_fd_room={7001: 'You_Were_Never_Here', 5008: 'PepeFrog.Room'}, _room_settings={}, _mic_holders={})",
    "names = {'You_Were_Never_Here': 'Players Lounge', 'PepeFrog.Room': \"Pepe's Pad\"}",
    "bot._rj_display_for = lambda r: names.get(r, r)",
    "bot._save_settings = lambda *a, **k: None",
    "bot._rc_push_soon = lambda delay=1.5: None",
    "bot._mg_disarm_all_soon = lambda why, pick=None: None",
    "out = {'fields': list(MS.FIELDS), 'good': [], 'bad': []}",
    "for i, args in enumerate(cases['good']):",
    "    ok, msg = bot._mt_web({'id': 100 + i, 'kind': 'mic.timing', 'site_admin': True, 'username': 'boss', 'user_id': 'boss'}, args)",
    "    out['good'].append([ok, msg])",
    "    if i == 0: out['state0'] = bot._mt_state()",
    "for args in cases['bad']:",
    "    ok, msg = bot._mt_web({'id': 1, 'kind': 'mic.timing', 'site_admin': True, 'username': 'boss'}, args)",
    "    out['bad'].append([ok, msg])",
    "ok, msg = bot._mt_web({'id': 2, 'kind': 'mic.timing', 'username': 'boss'}, cases['good'][0])",
    "out['nonadmin'] = [ok, msg]",
    "out['lists'] = [list(MS.yield_list_clean(v)) for v in cases['lists']]",
    "bot._mic_yield_until = time.time() + 600",
    "bot._mic_holders = {'owner1': {'room': 'You_Were_Never_Here', 'display': 'Owner One', 'start': 1}}",
    "out['state'] = bot._mt_state()",
    "out['settings'] = {k: bot._get_settings_dict().get(k) for k in ('audio_lead_in', 'mic_fast_confirm_ms', 'mic_talk_play', 'mic_yield_list')}",
    "sys.stdout.write('\\n' + json.dumps(out) + '\\n')",
  ].join("\n"));
  const input = script.replace(/contract\.py$/, "cases.json");
  fs.writeFileSync(input, JSON.stringify({ good, bad: badArgs, lists }));
  const raw = execFileSync(process.env.PYTHON || "python", [script, botDir, input], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 16 * 1024 * 1024 });
  const out = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual(out.fields, MT.FIELDS.slice(), "the same fields, in the same order");
  for (const [i, [ok, msg]] of out.good.entries()) assert.equal(ok, true, `${good[i].join(" ")} -> ${msg}`);
  assert.match(out.good[0][1], /web clip settle 5\.00 s \(asked 9\.0, clamped\)/);
  assert.match(out.good[0][1], /fast-grab confirm 100 ms \(asked 50, clamped\)/);
  assert.match(out.good[1][1], /fast-grab confirm 500 ms \(asked 9999, clamped\) · second-click retry 150 ms \(asked 10, clamped\) · TTS ready poll 50 ms/);
  for (const [i, [ok, msg]] of out.bad.entries()) { assert.equal(ok, false, badArgs[i].join(" ")); assert.match(msg, /^bad /); }
  assert.equal(out.nonadmin[0], false);
  for (const [i, v] of lists.entries()) {
    const site = MT.listClean(v), bot = out.lists[i] || [];
    assert.deepEqual([site.logins, !!site.err], [bot[0], !!bot[1]], `the list ${JSON.stringify(v)}: site ${JSON.stringify(site)} vs Pepe ${JSON.stringify(bot)}`);
  }
  const s0 = MT.cleanState(out.state0);
  assert.ok(s0, "his block passes the site's cleaner");
  assert.deepEqual(s0.values, { grabconfirm: 0.15, leadin: 0.1, tailout: 0.6, websettle: 5, talkplay: false, confirm: 100, clickretry: 250,
                                ttspoll: 100, yieldlist: ["owner1", "@bob"] });
  assert.deepEqual(s0.last.at(-1).clamped.confirm, { asked: 50, stored: 100 });
  assert.deepEqual(s0.ranges, MT.cleanState(block()).ranges, "the ranges the card shows = his");
  assert.deepEqual(s0.defaults, MT.cleanState(block()).defaults, "the defaults the card shows = his");
  const st = MT.cleanState(out.state);
  assert.deepEqual(st.values.yieldlist, ["owner1"]);
  assert.equal(st.values.talkplay, true);
  assert.equal(st.yield.on, true);
  assert.deepEqual(st.yield.present, [{ room: YW, name: "Players Lounge", who: ["Owner One"], holding: ["Owner One"] }]);
  assert.deepEqual(out.settings, { audio_lead_in: 0.1, mic_fast_confirm_ms: 500, mic_talk_play: true, mic_yield_list: ["owner1"] },
    "what he stored is what his own panel reads");
  assert.equal(await roomctl.setState({ rooms: ROOMS, mictiming: out.state }), true);
});
