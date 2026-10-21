// The Admin › Backends contract (POST /api/pepe/backends) between Pepe and the site - docs/admin-backends.md "The contract", pinned
// by the SHARED fixture test/fixtures/backends-contract.json: byte-identical in camfrog-bot (ci/fixtures/backends-contract.json),
// its sha256 pinned here AND in the bot's backends_contract_test.py. The bot's test builds each request from its real state and
// feeds each response through his real follower; this one feeds the bot's exact bodies through the real route (backends.js):
//   * the pin (PEPE_BOT_DIR=<a camfrog-bot checkout> also compares the bot's copy byte for byte)
//   * the conversation: the switches made on /admin/backends between reads (the real route, as the fixture's owner), then Pepe's
//     read -> the exact answer, and what the site kept (the reader, his results for the current wishes)
//   * the request probes: an unknown key is dropped, a result for an older wish ignored, another contract number not recorded
//   * owner answer (6): the casino's per-room switch - owner-only, same-origin, audited, refused while Pepe doesn't follow it
//     (a stale read), rooms Pepe didn't list refused, "all" = every listed room + the default; the page; the shell tool
//   * its review: a read that isn't in the contract is told no wish; a stale current Pepe vs an older build (no dead-end chat
//     command); "switch again" the same way (unacted / stuck / reached and moved since); at most 50 casino room wishes
//   NODE_PATH=G:/PATV/node_modules node --test test/backends-contract.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "backends-contract.json");
// Update together with camfrog-bot's copy (ci/fixtures/backends-contract.json) and its pin (backends_contract_test.py PIN) -
// docs/admin-backends.md "Changing the contract".
const PIN = "72d24da50071b01827f4b7bb56da9d5dcaab7becaf439fbe1b33773b714164e2";
const RAW = fs.readFileSync(FIXTURE);
const FX = JSON.parse(RAW.toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backends-contract-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const B = require(path.join(repo, "backends"));

let base, server;
const ID = {};                                   // username -> userId (the fixture's users + an Admin who isn't an owner)

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 1, created_at TEXT, archived_at INTEGER)`);
  await SR.init();
  const users = FX.site.users.concat([{ username: "adm", class: "Admin", camfrog: "adm_cf", pepe_role: "admin" }]);
  for (const u of users) {
    ID[u.username] = "u_" + u.username;
    await runQuery("INSERT INTO users (userId, username, displayname, class, camfrogUsername) VALUES (?, ?, ?, ?, ?)",
                   [ID[u.username], u.username, u.username, u.class, u.camfrog]);
    await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES (?, ?, 1)", [u.camfrog, u.pepe_role]);
  }
  await require(path.join(repo, "adminaudit")).init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  // the fixture's token is the bot token here: its requests go in exactly as Pepe sends them
  B.register(app, { addUser, isBotToken: (t) => t === FX.token });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await B.init();
});
test.after(() => { B._setClock(null); try { require(path.join(repo, "lotto", "service")).stop(); } catch (e) { /* */ } if (server) server.close(); });

async function call(p, userId, body = {}, extra = {}) {
  const headers = Object.assign({ "content-type": "application/json", "x-test-user": userId || "", "X-Requested-With": "fetch", origin: base }, extra);
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}
const pepe = (body) => fetch(base + "/api/pepe/backends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
async function kept() {
  const rd = await B.reader();
  const results = {};
  for (const [k, w] of Object.entries(await B.wants())) {
    if (w.pepe) results[k] = { want: w.want, at: w.at, ok: w.pepe.ok, state: w.pepe.state, msg: w.pepe.msg };
  }
  return { reader: { at: rd.at, version: rd.version, follows: rd.follows }, results };
}
const switchBody = (sw) => (sw.feature === "casino" ? Object.assign({ on: sw.on, scope: sw.scope }, sw.room !== undefined ? { room: sw.room } : {}) : { on: sw.on });

test("the shared fixture is the pinned version (a change on one side fails until the other is updated)", () => {
  assert.equal(sha(RAW), PIN, "test/fixtures/backends-contract.json changed: copy it to camfrog-bot's ci/fixtures/ and re-pin BOTH tests");
  assert.equal(RAW.includes(Buffer.from("\r\n")), false, "LF line ends (.gitattributes: text eol=lf)");
  assert.equal(FX.contract, B.CONTRACT, "the fixture is this contract");
  const other = process.env.PEPE_BOT_DIR;            // optional: a camfrog-bot checkout - the copies must be byte-identical
  if (other) assert.equal(sha(fs.readFileSync(path.join(other, "ci", "fixtures", "backends-contract.json"))), PIN, "the bot's copy");
});

test("the conversation: each switch, then Pepe's exact request -> the site's exact answer, and what the site keeps", async () => {
  for (const step of FX.steps) {
    for (const sw of step.switches) {
      B._setClock(() => sw.at);
      const r = await call("/api/admin/backends/" + sw.feature, ID[sw.by], switchBody(sw));
      assert.equal(r.status, sw.expect.status, `${step.name}: switch ${sw.feature}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.act, sw.expect.act, `${step.name}: switch ${sw.feature}: act`);
      if ("chat" in sw.expect) assert.equal(r.body.chat, sw.expect.chat, `${step.name}: switch ${sw.feature}: chat`);
    }
    B._setClock(() => step.clock);
    const r = await pepe(step.request);
    assert.equal(r.status, 200, step.name);
    assert.deepEqual(r.body, step.response, `${step.name}: the answer`);
    assert.deepEqual(await kept(), step.site_after, `${step.name}: what the site keeps`);
  }
  // the page shows what Pepe said for the current wishes, and the casino rows from his list
  const v = await B.view((await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [ID.boss]))[0]);
  const lotto = v.rows.find((x) => x.key === "lotto");
  assert.deepEqual([lotto.pepe.ok, lotto.pepe.state, lotto.follows, lotto.waiting], [true, "done", true, true], "his report shows; the site's live flag is the import's");
  assert.deepEqual(v.casino.rooms.map((x) => [x.room, x.live, x.want, x.pepe && x.pepe.state]), [["DRAMA_CENTRAL", false, null, null], ["PepeLab", true, true, "done"]]);
  assert.deepEqual([v.casino.default.live, v.casino.default.want, v.casino.follows, v.casino.can], [true, true, true, true]);
});

test("the request probes: unknown keys dropped, a result for an older wish ignored, another contract number not recorded", async () => {
  const snap = {
    reader: await getQuery("SELECT * FROM backend_reader"),
    wants: await getQuery("SELECT feature, pepe_at, pepe_ok, pepe_msg, pepe_state FROM backend_wants"),
  };
  const restore = async () => {
    await runQuery("DELETE FROM backend_reader");
    for (const r of snap.reader) await runQuery("INSERT INTO backend_reader (id, at, version, follows, casino) VALUES (?, ?, ?, ?, ?)", [r.id, r.at, r.version, r.follows, r.casino]);
    for (const w of snap.wants) {
      await runQuery("UPDATE backend_wants SET pepe_at = ?, pepe_ok = ?, pepe_msg = ?, pepe_state = ? WHERE feature = ?", [w.pepe_at, w.pepe_ok, w.pepe_msg, w.pepe_state, w.feature]);
    }
  };
  for (const p of FX.probes.requests) {
    await restore();
    B._setClock(() => p.clock);
    const r = await pepe(p.request);
    assert.equal(r.status, 200, p.name);
    assert.equal(r.body.contract, B.CONTRACT, p.name);
    const k = await kept();
    assert.deepEqual(k.reader, p.site_after.reader, `${p.name}: the reader`);
    for (const [key, res] of Object.entries(p.site_after.results)) assert.deepEqual(k.results[key], res, `${p.name}: ${key}`);
    assert.equal(k.results.warp, undefined, p.name);
  }
  await restore();
  // the bot token is required; a body that isn't an object only reads
  assert.equal((await pepe({ password: "nope", contract: 1, follows: ["lotto"] })).status, 403);
  B._setClock(() => FX.steps[FX.steps.length - 1].clock + 1000);
  assert.equal((await pepe({ password: FX.token, contract: 1, follows: "lotto" })).status, 200);
  assert.deepEqual((await kept()).reader, FX.steps[FX.steps.length - 1].site_after.reader, "follows that isn't a list: not a reader");
});

test("owner answer (6): the casino switch is a Pepe owner's, same-origin, audited; refused while Pepe doesn't follow it or for a room he didn't list", async () => {
  const last = FX.steps[FX.steps.length - 1];
  B._setClock(() => last.clock + 60000);              // Pepe's read (third_read) is fresh
  // an Admin who isn't a Pepe owner: 403 owner_only, nothing written
  const before = (await getQuery("SELECT COUNT(*) AS n FROM backend_wants"))[0].n;
  const no = await call("/api/admin/backends/casino", ID.adm, { on: false, scope: "room", room: "PepeLab" });
  assert.deepEqual([no.status, no.body.code], [403, "owner_only"]);
  for (const [why, extra] of [["foreign origin", { origin: "https://evil.example" }], ["no fetch header", { "X-Requested-With": null }], ["no origin", { origin: null }]]) {
    const r = await call("/api/admin/backends/casino", ID.boss, { on: false, scope: "room", room: "PepeLab" }, extra);
    assert.deepEqual([r.status, r.body.code], [403, "cross_site"], why);
  }
  assert.equal((await call("/api/admin/backends/casino", ID.boss, { on: "no", scope: "room", room: "PepeLab" })).status, 400);
  assert.equal((await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "everything" })).status, 400);
  const unk = await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "room", room: "NoSuchRoom" });
  assert.deepEqual([unk.status, unk.body.code], [404, "unknown_room"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM backend_wants"))[0].n, before, "nothing written");
  // a room Pepe listed: the wish (act: he follows it), the audit row
  const ok = await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "room", room: "DRAMA_CENTRAL" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.feature, ok.body.scope, ok.body.room, ok.body.want, ok.body.act], ["casino", "room", "DRAMA_CENTRAL", true, true]);
  const a = (await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(a.admin_id, ID.boss);
  assert.deepEqual(JSON.parse(a.detail), { feature: "casino", scope: "room", room: "DRAMA_CENTRAL", want: true, was: null, via: "web", pepe_follows: true });
  // all: every listed room + the default, one transaction, one audit row
  const all = await call("/api/admin/backends/casino", ID.boss, { on: false, scope: "all" });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.rooms, ["DRAMA_CENTRAL", "PepeLab"]);
  const W = await B.wants();
  assert.deepEqual(["casino", "casino:DRAMA_CENTRAL", "casino:PepeLab"].map((k) => [W[k].want, W[k].act, W[k].pepe]), [[false, true, null], [false, true, null], [false, true, null]],
                   "a new wish clears Pepe's old report");
  const aa = JSON.parse((await getQuery("SELECT detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1"))[0].detail);
  assert.deepEqual([aa.scope, aa.rooms, aa.want], ["all", ["DRAMA_CENTRAL", "PepeLab"], false]);
  // Pepe answers with them per room (a read in this contract; the old body is told no wish at all - the hardening below)
  const r = await pepe(last.request);
  assert.deepEqual(Object.keys(r.body.casino.rooms), ["DRAMA_CENTRAL", "PepeLab"]);
  assert.deepEqual([r.body.casino.default.want, r.body.casino.rooms.PepeLab.want], [false, false]);
  const old = await pepe({ password: FX.token });
  assert.deepEqual([old.body.casino.default.want, old.body.casino.rooms, old.body.features.lotto.want, old.body.features.lotto.act],
                   [null, {}, null, false], "a read that isn't in this contract: no wish at all");
  // the page: the casino section, buttons for an owner while Pepe follows; an Admin sees the rows, no buttons
  const html = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.boss } })).text();
  assert.match(html, /id="casino"/);
  assert.match(html, /data-casino="PepeLab"/);
  assert.match(html, /data-bkc="room" data-room="PepeLab" data-on="1"/);
  assert.match(html, /data-bkc="all"/);
  assert.match(html, /data-casino="\*default"/);
  const html2 = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.adm } })).text();
  assert.match(html2, /data-casino="PepeLab"/);
  assert.doesNotMatch(html2, /data-bkc=/);
  // Pepe stops reading: after 15 minutes the casino switch would change nothing - refused, nothing written. He is a current Pepe
  // whose read is only stale (down, or can't reach the site): told so - not the chat command an older build has (review of 6)
  B._setClock(() => last.clock + 60000 + B.READER_FRESH_MS + 1000);
  const stale = await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "default" });
  assert.deepEqual([stale.status, stale.body.code], [409, "pepe_not_following"]);
  assert.match(stale.body.error, /hasn't read these switches since .* UTC \(Pepe 1\.99zz\) - check that he is running/);
  assert.match(stale.body.error, /!casino backend off/);
  assert.doesNotMatch(stale.body.error, /!casino backend on\|off/);
  assert.equal((await B.wants()).casino.want, false);
  const html3 = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.boss } })).text();
  assert.doesNotMatch(html3, /data-bkc=/, "no casino button while Pepe doesn't follow it");
  assert.match(html3, /check that he is running and can reach publicaccess\.tv/);
  assert.doesNotMatch(html3, /<code>!casino backend on\|off<\/code>/);
  // an older build (it never read in this contract, or its read doesn't follow the casino): the chat command it has
  const rd0 = (await getQuery("SELECT at, version, follows, casino FROM backend_reader WHERE id = 1"))[0];
  await runQuery("UPDATE backend_reader SET follows = ? WHERE id = 1", [JSON.stringify(["lotto"])]);
  const older = await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "default" });
  assert.equal(older.status, 409);
  assert.match(older.body.error, /a Pepe owner runs !casino backend on\|off in that room/);
  const html4 = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.boss } })).text();
  assert.match(html4, /<code>!casino backend on\|off<\/code>/);
  await runQuery("UPDATE backend_reader SET follows = ? WHERE id = 1", [rd0.follows]);
});

test("the casino's emergency path from the shell (tools/casino-backend.js): status, a room / the default / all, audited as cli", async () => {
  const last = FX.steps[FX.steps.length - 1];
  // the tool runs in another process on the same database: Pepe's read must be fresh by the real clock there
  B._setClock(null);
  await pepe(last.request);
  const tool = path.join(repo, "tools", "casino-backend.js");
  const run = (...args) => execFileSync(process.execPath, [tool, ...args, "--dir=" + tmp], { encoding: "utf8", env: process.env, stdio: "pipe" });
  const st = run();
  assert.match(st, /Pepe follows the casino switches/);
  assert.match(st, /PepeLab/);
  assert.throws(() => run("room", "PepeLab", "on"), /--actor/, "who is changing it");
  const out = run("--actor=ops", "room", "PepeLab", "on");
  assert.match(out, /casino in PepeLab: the site's casino/);
  let W = await B.wants();
  assert.deepEqual([W["casino:PepeLab"].want, W["casino:PepeLab"].by, W["casino:PepeLab"].via, W["casino:PepeLab"].act], [true, "ops (cli)", "cli", true]);
  const a = (await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(a.admin_id, "cli:ops");
  assert.equal(JSON.parse(a.detail).via, "cli");
  run("--actor=ops", "default", "on");
  run("--actor=ops", "all", "off");
  W = await B.wants();
  assert.deepEqual(["casino", "casino:PepeLab", "casino:DRAMA_CENTRAL"].map((k) => W[k].want), [false, false, false]);
  assert.throws(() => run("--actor=ops", "room", "Nowhere", "on"), /hasn't reported that room/);
  // no database there: exit 2, nothing opened
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "backends-contract-nodb-"));
  let code = 0;
  try { execFileSync(process.execPath, [tool, "--dir=" + empty], { encoding: "utf8", stdio: "pipe" }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
  assert.equal(fs.existsSync(path.join(empty, "myapp.db")), false);
});

test("review of owner answer (6): a wish Pepe won't act on as it stands is offered again, the same way (hand-overs and the casino)", async () => {
  const last = FX.steps[FX.steps.length - 1];
  B._setClock(null);
  await pepe(last.request);                                   // a fresh read of this build: he follows every switch
  const boss = async () => B.view((await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [ID.boss]))[0]);
  let v = await boss();
  const row = (k) => v.rows.find((x) => x.key === k);
  // the stashes' wish was made before Pepe followed it (act false): he leaves it alone - offered again, the same way
  assert.deepEqual([row("stashes").want, row("stashes").act, row("stashes").live, row("stashes").again], [true, false, false, "unacted"]);
  // the lotto: he reported it done, and it isn't on the site now (changed another way since): offered again
  assert.deepEqual([row("lotto").pepe && row("lotto").pepe.state, row("lotto").live, row("lotto").again], ["done", false, "moved"]);
  assert.equal(row("gtf").again, null, "never switched here: nothing to offer");
  let html = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.boss } })).text();
  assert.match(html, /data-bk="stashes" data-on="1" data-again="1"/);
  assert.match(html, /data-bk="lotto" data-on="1" data-again="1"/);
  assert.match(html, /data-again="unacted"/);
  assert.match(html, /data-again="moved"/);
  assert.match(html, /Switch again: move to publicaccess\.tv/);
  assert.doesNotMatch(html, /UTC UTC/, "a time names its zone once");
  assert.match(html, /Pepe reads these switches \(last read [^)]*UTC, Pepe 1\.99zz\)/);
  // an Admin who isn't a Pepe owner sees why, but gets no button on an owner row
  const htmlA = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.adm } })).text();
  assert.match(htmlA, /data-again="unacted"/);
  assert.doesNotMatch(htmlA, /data-bk="stashes"[^>]*data-again="1"/);
  // the same-direction switch: a new wish (act: true now), audited; the offer is gone
  const again = await call("/api/admin/backends/stashes", ID.boss, { on: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.want, again.body.act, again.body.chat], [true, true, null]);
  const au = JSON.parse((await getQuery("SELECT detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1"))[0].detail);
  assert.deepEqual([au.feature, au.want, au.was, au.pepe_follows], ["stashes", true, true, true]);
  v = await boss();
  assert.equal(row("stashes").again, null);
  // given up after a day (stuck): offered again; on its way (trying): nothing to offer
  const W = await B.wants();
  await pepe(Object.assign({}, last.request, { results: { lotto: { want: true, at: W.lotto.at, ok: false, state: "stuck", msg: "not reached in 24 h" } } }));
  v = await boss();
  assert.equal(row("lotto").again, "stuck");
  await pepe(Object.assign({}, last.request, { results: { lotto: { want: true, at: W.lotto.at, ok: false, state: "trying", msg: "too close to the draw" } } }));
  v = await boss();
  assert.equal(row("lotto").again, null);
  // the casino: a room Pepe reached once that plays elsewhere now (e.g. an owner's chat switch while the site was down)
  const Wc = (await B.wants())["casino:PepeLab"];
  assert.equal(Wc.want, false);
  await pepe(Object.assign({}, last.request, { results: { "casino:PepeLab": { want: false, at: Wc.at, ok: true, state: "done", msg: "on Pepe (the old engines)" } } }));
  v = await boss();
  const pl = v.casino.rooms.find((x) => x.room === "PepeLab");
  assert.deepEqual([pl.want, pl.live, pl.again], [false, true, "moved"]);
  html = await (await fetch(base + "/admin/backends", { headers: { "x-test-user": ID.boss } })).text();
  assert.match(html, /data-bkc="room" data-room="PepeLab" data-on="0" data-again="1"/);
  assert.match(html, /Switch again: Pepe&#39;s tables|Switch again: Pepe's tables/);
  const ca = await call("/api/admin/backends/casino", ID.boss, { on: false, scope: "room", room: "PepeLab" });
  assert.deepEqual([ca.status, ca.body.want, ca.body.act], [200, false, true]);
  v = await boss();
  assert.equal(v.casino.rooms.find((x) => x.room === "PepeLab").again, null, "a new wish: his report for the old one is cleared");
  // Pepe not following (a stale read): no offer anywhere - a new wish would be act: false again
  await pepe(Object.assign({}, last.request, { results: { lotto: { want: true, at: W.lotto.at, ok: false, state: "stuck", msg: "x" } } }));
  B._setClock(() => Date.now() + B.READER_FRESH_MS + 1000);
  try {
    v = await boss();
    assert.ok(v.rows.every((x) => x.again === null) && v.casino.rooms.every((x) => x.again === null) && v.casino.default.again === null);
  } finally { B._setClock(null); }
  assert.equal(B.againOf({ want: true, act: true, pepe: { state: "blocked" } }, false, true), null, "blocked: switching again won't help");
  assert.equal(B.againOf({ want: true, act: false, pepe: null }, true, true), null, "already there: nothing to offer");
  assert.equal(B.againOf({ want: true, act: false, pepe: null }, null, true), null, "where it plays unknown: nothing to offer");
});

test("review of owner answer (6): at most 50 casino room wishes are kept - the oldest dropped (audited); Pepe is answered the 50 newest", async () => {
  const last = FX.steps[FX.steps.length - 1];
  B._setClock(null);
  const rooms = Array.from({ length: 50 }, (_, i) => ({ room: "R" + String(i).padStart(2, "0"), name: "R" + i, joined: true, on: false }));
  await pepe(Object.assign({}, last.request, { casino: { default: false, rooms } }));
  const before = Object.keys(await B.wants()).filter((k) => k.startsWith("casino:")).map((k) => k.slice(7)).sort();
  assert.deepEqual(before, ["DRAMA_CENTRAL", "PepeLab"]);
  const all = await call("/api/admin/backends/casino", ID.boss, { on: true, scope: "all" });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.rooms.length, 50);
  assert.deepEqual([...all.body.pruned].sort(), before, "the two switched longest ago are dropped");
  const keys = Object.keys(await B.wants()).filter((k) => k.startsWith("casino:"));
  assert.equal(keys.length, B.CASINO_MAX_ROOMS);
  const a = JSON.parse((await getQuery("SELECT detail FROM admin_audit WHERE action = 'backend_switch' ORDER BY id DESC LIMIT 1"))[0].detail);
  assert.deepEqual([a.scope, a.rooms.length, [...a.pruned].sort()], ["all", 50, before]);
  // a database from before the cap (55 room wishes): Pepe is answered the 50 most recently switched, by room id
  for (let i = 0; i < 5; i++) {
    await runQuery("INSERT INTO backend_wants (feature, want, by, via, at, act) VALUES (?, 1, 'old', 'web', ?, 1)", ["casino:OLD" + i, 1000 + i]);
  }
  const r = await pepe(Object.assign({}, last.request, { casino: { default: true, rooms } }));
  const got = Object.keys(r.body.casino.rooms);
  assert.equal(got.length, 50);
  assert.ok(!got.some((k) => k.startsWith("OLD")), "the oldest are left out");
  assert.deepEqual(got, [...got].sort(), "by room id");
  for (let i = 0; i < 5; i++) await runQuery("DELETE FROM backend_wants WHERE feature = ?", ["casino:OLD" + i]);
});
