// Offline tests for "Pepe's look" in the admin-only Pepe control panel (pepecontrol.js, 1.99bv):
// admin + CSRF gating (no step-up password), "Pepe offline" refusal, values checked against what
// Pepe reports, the pepe.look action queued for Pepe (actions.js) with the admin's site-admin flag,
// his reply shown + audited once, the rate limit, and the panel markup.
//   node --test test/pepelook.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepelook-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
delete process.env.PEPE_CONTROL_SECRET;
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pepecontrol"));
const A = require(path.join(repo, "actions"));

const LOOK = {
  costume: null, persona: "pepe", persona_name: "Pepe", persona_voice: true, voice: null, follow_costume: true,
  game_look: null, dj: false, balaclava: false, bottleservice: false, overlay_clients: 1,
  costumes: [{ id: "dracula", desc: "Count Pepecula — cape" }, { id: "gothmommy", desc: "Goth Mommy — choker" }],
  personas: [{ id: "pepe", name: "Pepe", costume: "", voice: false }, { id: "gothmommy", name: "Goth Mommy", costume: "gothmommy", voice: true }],
};
async function beat({ running = true, liveAge = 5, look = LOOK } = {}) {
  const s = Date.now() / 1000;
  await P.heartbeat({ version: "1.99bv", pepe: { pid: 1, running, live_ts: running ? s - liveAge : null, rooms: ["PepeLab"], look: running ? look : null } });
}

let base, server;
test.before(async () => {
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb', camfrogUsername TEXT)");
  await runQuery("INSERT INTO users VALUES ('a1', 'boss', '', 'Admin', 'BossFrog'), ('a2', 'boss2', '', 'Admin', NULL), ('s1', 'staffer', '', 'Staff', 'Stf'), ('p1', 'pleb', '', 'pleb', 'Plb')");
  await P.init();
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  P.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  A.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
test.beforeEach(async () => {
  await runQuery("DELETE FROM pepe_control_audit");
  await runQuery("DELETE FROM pepe_actions").catch(() => {});
  await beat();
});

const H = (u, csrf) => Object.assign({ "content-type": "application/json" }, u ? { "x-test-user": u } : {}, csrf ? { "x-csrf-token": csrf } : {});
async function call(p, u, body, csrf) {
  const r = await fetch(base + p, body === undefined ? { headers: H(u, csrf) } : { method: "POST", headers: H(u, csrf), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const look = (verb, value, u = "a1", name = "boss") => call("/api/pepe/control/look", u, { verb, value }, P.csrfToken(name));
const botPost = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot-token" }, body)) }).then((r) => r.json());

test("admins only, CSRF required, and NO step-up password for a look change", async () => {
  assert.equal((await call("/api/pepe/control/look", null, { verb: "costume", value: "dracula" })).status, 401);
  assert.equal((await look("costume", "dracula", "s1", "staffer")).status, 403);
  assert.equal((await look("costume", "dracula", "p1", "pleb")).status, 403);
  assert.equal((await call("/api/pepe/control/look", "a1", { verb: "costume", value: "dracula" })).status, 403, "no CSRF token");
  assert.equal((await call("/api/pepe/control/look", "a1", { verb: "costume", value: "dracula" }, P.csrfToken("boss2"))).status, 403, "another admin's token");
  const r = await look("costume", "dracula");          // no password, no nonce
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action.label, "!costume dracula");
  assert.equal((await call("/api/pepe/control/look/" + r.body.action.id, "p1")).status, 403);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions"))[0].n, 1);
});

test("queued for Pepe as pepe.look with the admin's site-admin flag; his reply is shown and audited once", async () => {
  const r = await look("costume", "gothmommy");
  const row = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [r.body.action.id]))[0];
  assert.equal(row.kind, "pepe.look");
  assert.deepEqual(JSON.parse(row.args), ["costume", "gothmommy"]);
  assert.equal(row.site_admin, 1);
  assert.equal(row.camfrog, "BossFrog");
  let a = await getQuery("SELECT action, username, result, ip_hash FROM pepe_control_audit");
  assert.ok(a.some((x) => x.action === "look" && x.username === "boss" && /!costume gothmommy/.test(x.result) && x.ip_hash));
  // Pepe claims it (normal web-action lane) and answers
  const claim = await botPost("/api/actions/claim", {});
  const got = claim.actions.find((x) => x.id === row.id);
  assert.ok(got && got.kind === "pepe.look" && got.site_admin === true && got.camfrog === "BossFrog");
  let s = await call("/api/pepe/control/look/" + row.id, "a2");
  assert.equal(s.body.action.status, "claimed");
  await botPost("/api/actions/ack", { results: [{ id: row.id, ok: true, message: "Mommy's home, chat." }] });
  s = await call("/api/pepe/control/look/" + row.id, "a1");
  assert.equal(s.body.action.status, "done");
  assert.equal(s.body.action.message, "Mommy's home, chat.");
  const v = await call("/api/pepe/control/status", "a1");
  assert.equal(v.body.looks[0].id, row.id);
  a = await getQuery("SELECT * FROM pepe_control_audit WHERE action = 'look-result'");
  assert.equal(a.length, 1, "result audited once (status + look poll both ran)");
  assert.match(a[0].result, /done: !costume gothmommy - Mommy's home/);
});

test("every control: persona, voice, link, reset; values checked against Pepe's own lists", async () => {
  for (const [verb, value, args] of [["persona", "gothmommy", ["persona", "gothmommy"]], ["persona", "off", ["persona", "off"]],
    ["voice", "off", ["voice", "off"]], ["link", "on", ["link", "on"]], ["costume", "off", ["costume", "off"]], ["reset", "", ["reset"]]]) {
    const r = await look(verb, value);
    assert.equal(r.status, 200, verb + " " + value + ": " + JSON.stringify(r.body));
    const row = (await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [r.body.action.id]))[0];
    assert.deepEqual(JSON.parse(row.args), args);
    await runQuery("UPDATE pepe_actions SET status = 'done'");   // Pepe answered (actions.js caps open ones at 6)
  }
  for (const [verb, value] of [["costume", "batman"], ["persona", "nobody"], ["voice", "maybe"], ["reset", "now"], ["restart", ""], ["costume", "DRACULA; !reloadbot"]]) {
    const r = await look(verb, value);
    assert.equal(r.status, 400, verb + " " + value);
  }
  assert.equal((await look("costume", "Dracula")).status, 200, "case-insensitive");
});

test("Pepe offline: VM silent, Pepe not running, or his live file stale -> refused + audited; the view has no look", async () => {
  await beat({ running: false });
  let r = await look("costume", "dracula");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Pepe offline/);
  const off = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(off.look, null);
  assert.equal(off.look_known.costumes.length, 2, "last known lists kept for the disabled controls");
  await beat({ liveAge: 400 });
  assert.equal((await look("costume", "dracula")).status, 409, "stale live file");
  await beat();
  await runQuery("UPDATE pepe_control_status SET at = ?", [Date.now() - 5 * 60 * 1000]);
  assert.equal((await look("costume", "dracula")).status, 409, "VM heartbeat old");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions"))[0].n, 0);
  const a = await getQuery("SELECT result FROM pepe_control_audit WHERE action = 'denied'");
  assert.ok(a.length >= 3 && a.every((x) => /Pepe offline/.test(x.result)));
  await beat();
  const v = await call("/api/pepe/control/status", "a1");
  assert.equal(v.body.look.costumes.length, 2);
});

test("rate limit: 20 look changes a minute per admin", async () => {
  let last;
  for (let i = 0; i < 21; i++) {
    last = await look(i % 2 ? "voice" : "link", i % 4 < 2 ? "on" : "off", "a2", "boss2");
    if (i < 20) assert.equal(last.status, 200, "change " + (i + 1));
    await runQuery("UPDATE pepe_actions SET status = 'done'");   // keep actions.js's per-user open cap out of it
  }
  assert.equal(last.status, 429);
  assert.match(last.body.error, /20 look changes a minute/);
  assert.equal((await look("costume", "dracula")).status, 200, "another admin isn't limited");
});

test("1.99fo avatar bases: base + the active base's modifiers, checked against Pepe's lists", async () => {
  const MODLIST = [{ id: "bow", name: "Bow", bases: ["kawaii"], slot: "side" }, { id: "headset", name: "Tiny headset", bases: ["kawaii"], slot: "ears" }];
  const BASES = [{ id: "pixel", name: "Pixel Pepe" }, { id: "kawaii", name: "Kawaii Pepe" }];
  await beat({ look: Object.assign({}, LOOK, { base: "pixel", mods: [], bases: BASES, modlist: MODLIST }) });
  let r = await look("base", "kawaii");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action.label, "!pepebase kawaii");
  let row = (await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [r.body.action.id]))[0];
  assert.deepEqual(JSON.parse(row.args), ["base", "kawaii"]);
  r = await look("mod", "bow");
  assert.equal(r.status, 400, "a kawaii modifier while Pepe is pixel");
  assert.match(r.body.error, /kawaii Pepe - switch his base first/);
  assert.equal((await look("base", "vaporwave")).status, 400, "unknown base");
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  await beat({ look: Object.assign({}, LOOK, { base: "kawaii", mods: ["bow"], bases: BASES, modlist: MODLIST }) });
  for (const v of ["bow", "Headset", "off"]) {
    r = await look("mod", v);
    assert.equal(r.status, 200, v + ": " + JSON.stringify(r.body));
    row = (await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [r.body.action.id]))[0];
    assert.deepEqual(JSON.parse(row.args), ["mod", v.toLowerCase()]);
    await runQuery("UPDATE pepe_actions SET status = 'done'");
  }
  for (const v of ["cape", "bow; !reloadbot", ""]) assert.equal((await look("mod", v)).status, 400, "mod " + JSON.stringify(v));
  // an older Pepe without the base lists: base/mod refused, everything else unchanged
  await beat();
  assert.equal((await look("base", "kawaii")).status, 400);
  assert.equal((await look("mod", "off")).status, 400);
  assert.equal((await look("costume", "dracula")).status, 200);
  // the offline fallback keeps the base lists too
  await beat({ look: Object.assign({}, LOOK, { base: "kawaii", mods: [], bases: BASES, modlist: MODLIST }) });
  await beat({ running: false });
  const known = (await call("/api/pepe/control/status", "a1")).body.look_known;
  assert.equal(known.bases.length, 2);
  assert.equal(known.modlist.length, 2);
});

test("panel markup: Pepe's look section for admins only, thumbnails exist for every costume", async () => {
  const file = path.join(repo, "views", "partials", "pepe-control.ejs");
  const html = await ejs.renderFile(file, { me: { username: "boss", class: "Admin" }, pepeCtlCsrf: P.csrfToken });
  assert.match(html, /Pepe's look/);
  assert.match(html, /id="plCostumes"/);
  assert.match(html, /Pepe offline/);
  assert.match(html, /\/api\/pepe\/control\/look/);
  assert.equal((await ejs.renderFile(file, { me: { username: "pleb", class: "pleb" }, pepeCtlCsrf: P.csrfToken })).trim(), "");
  const dir = path.join(repo, "public", "img", "pepe-looks");
  for (const id of ["pepe", "dolly", "dracula", "frankenstein", "mummy", "freddy", "jason", "pennywise", "werewolf", "pinhead", "pedro", "flirty", "gothmommy"]) {
    assert.ok(fs.existsSync(path.join(dir, id + ".png")), id + ".png");
  }
  // 1.99fo: the base picker + extras grid, with a thumbnail per base and per kawaii modifier
  assert.match(html, /id="plBases"/);
  assert.match(html, /id="plMods"/);
  for (const id of ["base-pixel", "base-kawaii", "mod-bow", "mod-flowercrown", "mod-catears", "mod-strawberryhat", "mod-sparkles", "mod-headset"]) {
    assert.ok(fs.existsSync(path.join(dir, id + ".png")), id + ".png");
  }
});
