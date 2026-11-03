// 1.99?? (privacy controls S6): THE PRIVACY SWITCHBOARD v3 on the website (G:/ops/privacy-controls-spec-2026-11-02.md section 4.3 +
// section 5 "S6"; the owner's answers, section 8 - Q20 a control turns OFF from a room line too, Pepe's side). On a temp DB with the
// real routes:
//   switch    privacystate.js: off by default (the routes 404, no advert, Pepe's bridge / tx reports ignored); on only with privacy
//             wire v2 (409); the sync answer says privstate: 1 only while both are on; effective() also needs Pepe's word (exactly 1,
//             fresh); /api/admin/privacyv3 is chatlog.admin (Staff 403), audited; the bot reads the same names (PEPE_BOT_DIR)
//   report    Pepe's kind "bridge" / "tx" items on the incognito report: linked logins only, an audit row, ONE inbox notice per real
//             change (none for a re-send, a stale one or changed: false); the full lists heal; the report's answer is unchanged
//             while the switch is off
//   request   POST /api/privacy/state queues privacy.bridge [hide|show] / privacy.tx [off|on] (linked login, rate limit, bad input);
//             GET says "waiting" until Pepe reports a change newer than the request
//   page      /settings/privacy: the "On the website" card only while in effect; the master shows the bridge, the sub-switches the
//             privacy switch (greyed + on while the bridge is off); switch off -> the page is byte-identical to the S4 head's view
//   dark      the !privacy card on /help and a room-typed !privacy kept out of the archive only while advertised
//   node --test test/privm-s6.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s6-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const PW = require(path.join(repo, "privwire"));
const PS = require(path.join(repo, "privacystate"));
const INC = require(path.join(repo, "incognito"));
const CL = require(path.join(repo, "chatlog"));
const HELP = require(path.join(repo, "help"));
const BASE = process.env.PRIVM_S6_BASE_REV || "09b25406";   // (the S4 head as rebased onto 1.99ahz; was fc5282bf on 1.99ahx, ba36ab81 on 1.99aht, 4f33f528 before)

const users = new Map();
const U = {};
let base, server;
let T = Date.now();
PS._setClock(() => T);

function call(method, url, { user = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {});
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls, camfrogUsername: camfrog };
  users.set(uid, u);
  return u;
}
const report = (body) => call("POST", "/api/privacy/incognito/sync", { body: Object.assign({ password: "bot", caps: ["memory"] }, body) });
const bsync = (extra) => call("POST", "/api/bridge/sync", { body: Object.assign({ password: "bot", events: [], rooms: [], hidden_h: [] }, extra || {}) });
const inboxOf = async (u) => getQuery("SELECT kind, title, body, ref FROM inbox WHERE user_id = ? ORDER BY id", [u.userId]);
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.bob = await mkUser("bob", "pleb", "Bob123");
  U.none = await mkUser("nolink", "pleb", null);
  U.staff = await mkUser("helper", "Staff", "helpercf");
  U.adm = await mkUser("adm", "Admin", "admcf");
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  INC.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "actions")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  PS.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  await PS.init();
  await PW.init();
})();

// ── the switch ──
test("switch: off by default - routes 404, no advert, reports ignored; on only with privacy wire v2; admins only; Pepe's word", async () => {
  await setup;
  assert.equal(PS.isOn(), false);
  assert.equal((await call("GET", "/api/privacy/state", { user: U.bob })).status, 404, "off: GET 404");
  assert.equal((await call("POST", "/api/privacy/state", { user: U.bob, body: { kind: "bridge", on: true } })).status, 404, "off: POST 404");
  let r = await bsync({ privstate: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.privstate, undefined, "switch off: no advert (whatever Pepe's body says)");
  r = await report({ items: [{ login: "bob123", kind: "bridge", on: true, via: "chat", changed: true, ts: T }], full_bridge: ["bob123"], full_tx: [] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.privstate, undefined, "switch off: the report's answer carries nothing new");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM privacy_state"))[0].n, 0, "switch off: Pepe's bridge / tx reports are ignored");
  assert.equal((await inboxOf(U.bob)).length, 0, "...and nobody is told");
  await assert.rejects(PS.setOn(true, ADM()), (e) => e.status === 409 && e.code === "privwire_off");
  await PW.setOn(true, ADM());
  r = await bsync({});
  assert.equal(r.d.privwire, 2);
  assert.equal(r.d.privstate, undefined, "privacy wire alone: no advert");
  assert.equal((await call("POST", "/api/admin/privacyv3", { user: U.mem, body: { on: true } })).status, 403);
  assert.equal((await call("POST", "/api/admin/privacyv3", { user: U.staff, body: { on: true } })).status, 403, "staff can't flip it");
  assert.equal((await call("GET", "/api/admin/privacyv3", { user: U.staff })).status, 403);
  const on = await call("POST", "/api/admin/privacyv3", { user: U.adm, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.d.state.on, true);
  assert.equal((await getQuery("SELECT action FROM admin_audit WHERE action = 'privacyv3.switch'")).length, 1, "audited");
  r = await bsync({});
  assert.equal(r.d.privstate, 1, "the advert while both are on");
  PS.noteBot({}, T);
  assert.equal(PS.effective(T), false, "no word from Pepe: not in effect");
  assert.equal((await call("GET", "/api/privacy/state", { user: U.bob })).status, 404, "...the routes still 404");
  PS.noteBot({ privstate: true }, T);
  assert.equal(PS.effective(T), false, "only privstate: 1 exactly");
  r = await bsync({ privstate: 1 });
  assert.equal(PS.effective(), true, "Pepe's sync body says privstate: 1 -> in effect");
  assert.equal(PS.effective(Date.now() + PS.BOT_FRESH_MS + 1), false, "...while his word is fresh");
  if (process.env.PEPE_BOT_DIR) {
    const b = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_bridge.py"), "utf8");
    assert.ok(b.includes('rj.get("privstate")') && b.includes('payload["privstate"] = 1'), "Pepe reads privstate and says privstate: 1");
    const w = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_webact.py"), "utf8");
    assert.ok(w.includes('"privacy.bridge", "privacy.tx"'), "Pepe takes privacy.bridge / privacy.tx");
    const s = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_privstate.py"), "utf8");
    assert.ok(s.includes('PV3_KINDS = ("bridge", "tx")') && s.includes('"full_bridge"') && s.includes('"full_tx"'), "the same kinds / lists");
    assert.ok(s.includes('ARGS') || s.includes('"hide", "show"'), "...and the same action words");
  }
});

// ── Pepe's report ──
test("report: linked logins only, one audit row and ONE inbox notice per real change; the full lists heal", async () => {
  await setup;
  PS.noteBot({ privstate: 1 });
  const t0 = Date.now();
  let r = await report({ items: [{ login: "bob123", kind: "bridge", on: true, via: "chat", changed: true, ts: t0 },
                                 { login: "bob123", kind: "tx", on: true, via: "web", changed: true, ts: t0 + 1 },
                                 { login: "strangercf", kind: "bridge", on: true, via: "chat", changed: true, ts: t0 },
                                 { login: "Bobby Display", kind: "tx", on: true, via: "chat", changed: true, ts: t0 },
                                 { login: "bob123", kind: "memory?", on: true, ts: t0 }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.privstate, { applied: 2, ignored: 2 }, "two linked, one unlinked, one not a login");
  const rows = await getQuery(`SELECT login, kind, "on" AS "on", via FROM privacy_state ORDER BY kind`);
  assert.deepEqual(rows.map((x) => [x.login, x.kind, x.on, x.via]), [["bob123", "bridge", 1, "chat"], ["bob123", "tx", 1, "web"]]);
  let ib = await inboxOf(U.bob);
  assert.equal(ib.length, 2, "one notice per change");
  assert.ok(ib[0].title.includes("hidden on the website") && ib[0].body.includes("with !bridge in chat") && ib[0].kind === "system", ib[0].title);
  assert.ok(ib[1].title.includes("Mic transcripts off") && ib[1].body.includes("from Settings → Privacy"), ib[1].body);
  assert.ok(!ib.some((n) => /strangercf|Bobby/.test(n.body)), "nobody else is named");
  r = await report({ items: [{ login: "bob123", kind: "bridge", on: true, via: "chat", changed: true, ts: t0 }] });
  assert.equal((await inboxOf(U.bob)).length, 2, "a re-sent report: no second notice");
  r = await report({ items: [{ login: "bob123", kind: "bridge", on: false, via: "chat", changed: true, ts: t0 - 5000 }] });
  assert.equal((await getQuery(`SELECT "on" AS "on" FROM privacy_state WHERE login = 'bob123' AND kind = 'bridge'`))[0].on, 1, "a stale report changes nothing");
  r = await report({ items: [{ login: "bob123", kind: "tx", on: false, via: "ident", changed: false, ts: t0 + 10 }] });
  assert.equal((await getQuery(`SELECT "on" AS "on" FROM privacy_state WHERE login = 'bob123' AND kind = 'tx'`))[0].on, 0, "changed: false still updates");
  assert.equal((await inboxOf(U.bob)).length, 2, "...without a notice");
  const audit = await getQuery("SELECT ev, kind FROM privacy_state_log WHERE user_id = ? ORDER BY id", [U.bob.userId]);
  assert.ok(audit.length >= 3 && audit.every((a) => a.ev === "applied"), "every applied change is audited");
  // the heal
  await runQuery(`INSERT INTO privacy_state (login, kind, "on", updated, reported, via) VALUES ('memcf', 'tx', 1, 1, 1, 'chat')`);
  r = await report({ full_bridge: ["bob123", "strangercf"], full_tx: [] });
  const after = await getQuery(`SELECT login, kind, "on" AS "on" FROM privacy_state ORDER BY login, kind`);
  assert.deepEqual(after.map((x) => [x.login, x.kind, x.on]), [["bob123", "bridge", 1], ["bob123", "tx", 0], ["memcf", "tx", 0]],
                   "full lists: listed linked logins on, the rest off, unlinked never stored");
  const sum = await PS.adminSummary();
  assert.equal(sum.bridge.all, 2, "admins see how many (never who)");
  assert.equal(sum.bridge.linked, 1);
});

test("live cam: a real change of a linked login's switch files one notice - only while the switchboard v3 is in effect", async () => {
  await setup;
  const LC = require(path.join(repo, "livecam"));
  await LC.init();
  const n0 = (await inboxOf(U.bob)).length;
  PS.noteBot({});                                          // not in effect
  await LC.setOptout("bob123", true, { via: "chat", ts: Date.now() });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await inboxOf(U.bob)).length, n0, "not in effect: no notice (as today)");
  PS.noteBot({ privstate: 1 });
  await LC.setOptout("bob123", true, { via: "chat", ts: Date.now() + 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await inboxOf(U.bob)).length, n0, "no real change: no notice");
  await LC.setOptout("bob123", false, { via: "web", ts: Date.now() + 2 });
  await new Promise((r) => setTimeout(r, 30));
  let ib = await inboxOf(U.bob);
  assert.equal(ib.length, n0 + 1, "a real change: one notice");
  assert.ok(ib[ib.length - 1].title.includes("watched on the website again") && ib[ib.length - 1].body.includes("from Settings → Privacy"), ib[ib.length - 1].body);
  await LC.setOptout("bob123", true, { via: "chat", ts: Date.now() + 3 });
  await new Promise((r) => setTimeout(r, 30));
  ib = await inboxOf(U.bob);
  assert.ok(ib[ib.length - 1].title.includes("hidden from the website") && ib[ib.length - 1].body.includes("with !livecam in chat"));
  await LC.setOptout("strangercf", true, { via: "chat", ts: Date.now() + 4 });
  await LC.setOptout("bob123", false, { via: "web", ts: Date.now() + 5 });
  await new Promise((r) => setTimeout(r, 30));
});

// ── the member's request ──
test("request: queues Pepe's action, linked login only, rate-limited; GET waits for Pepe's newer report", async () => {
  await setup;
  PS.noteBot({ privstate: 1 });
  assert.equal((await call("POST", "/api/privacy/state", { user: U.none, body: { kind: "bridge", on: true } })).status, 409, "unlinked");
  assert.equal((await call("POST", "/api/privacy/state", { user: U.bob, body: { kind: "chat", on: true } })).status, 400, "bad kind");
  assert.equal((await call("POST", "/api/privacy/state", { user: U.bob, body: { kind: "tx", on: "yes" } })).status, 400, "bad on");
  assert.equal((await call("POST", "/api/privacy/state", { body: { kind: "tx", on: true } })).status, 401, "signed out");
  const r = await call("POST", "/api/privacy/state", { user: U.mem, body: { kind: "tx", on: true } });
  assert.equal(r.status, 200, r.text);
  const a = (await getQuery("SELECT kind, args, camfrog FROM pepe_actions WHERE id = ?", [r.d.id]))[0];
  assert.deepEqual([a.kind, JSON.parse(a.args)], ["privacy.tx", ["off"]], "privacy.tx [off]");
  const r2 = await call("POST", "/api/privacy/state", { user: U.mem, body: { kind: "bridge", on: false } });
  const a2 = (await getQuery("SELECT kind, args FROM pepe_actions WHERE id = ?", [r2.d.id]))[0];
  assert.deepEqual([a2.kind, JSON.parse(a2.args)], ["privacy.bridge", ["show"]], "privacy.bridge [show]");
  let g = await call("GET", "/api/privacy/state", { user: U.mem });
  assert.equal(g.status, 200, g.text);
  assert.equal(g.d.linked, true);
  assert.equal(g.d.login, "memcf");
  assert.ok(g.d.tx.waiting && g.d.tx.waiting.want === true, "tx: waiting for Pepe");
  assert.ok(g.d.bridge.waiting && g.d.bridge.waiting.want === false, "bridge: waiting for Pepe");
  await report({ items: [{ login: "memcf", kind: "tx", on: true, via: "web", changed: true, ts: Date.now() + 1000 }] });
  g = await call("GET", "/api/privacy/state", { user: U.mem });
  assert.equal(g.d.tx.waiting, null, "Pepe's newer report ends the wait");
  assert.equal(g.d.tx.on, true);
  assert.ok(g.d.bridge.waiting, "...per kind");
  assert.ok(g.d.incognito && "on" in g.d.incognito && g.d.livecam && "off" in g.d.livecam, "the card also gets incognito + live cam");
  // the rate limit: RATE_MAX requests an hour
  for (let i = 0; i < PS.RATE_MAX; i++) await call("POST", "/api/privacy/state", { user: U.adm, body: { kind: "tx", on: i % 2 === 0 } });
  const lim = await call("POST", "/api/privacy/state", { user: U.adm, body: { kind: "tx", on: true } });
  assert.equal(lim.status, 429, lim.text);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM privacy_state_log WHERE user_id = ? AND ev = 'refused'", [U.adm.userId]))[0].n, 1, "a refusal is audited");
});

// ── the page ──
function pageLocals(extra) {
  const tFn = require(path.join(repo, "i18n")).tFor ? null : null;
  void tFn;
  return Object.assign({ user: "bob", st: { linked: true, login: "bob123", account: false, on: false, updated: null, reported: null, waiting: null, failed: null, log: [] },
                         lc: { linked: true, login: "bob123", off: false }, oa: null, gh: null, pf: null, slChat: false, slOk: false, mf: null, micrecOn: false,
                         mem: null, pwOn: true, ogBase: "http://test" }, extra || {});
}
const render = (src, locals) => ejs.render(src, locals, { filename: path.join(repo, "views", "privacy-settings.ejs") });

test("page: the On the website card only while in effect; master = the bridge, sub-switches greyed + on while hidden", async () => {
  await setup;
  const src = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
  const off = render(src, pageLocals());
  assert.ok(!off.includes('id="web"') && !off.includes("privacy-web.js"), "no card without pv3");
  const P = { effective: true, linked: true, login: "bob123", bridge: { on: false, waiting: null }, tx: { on: true, waiting: null },
              incognito: { on: false, waiting: null }, livecam: { off: false }, log: [{ at: Date.now(), kind: "tx", ev: "applied", on: 1, via: "chat" }] };
  const on = render(src, pageLocals({ pv3: P }));
  assert.ok(on.includes('id="web"') && on.includes("privacy-web.js?v=1") && on.includes("Show me on the website (bridge)"), "the card");
  assert.ok(/id="pvWebBridge" checked/.test(on), "master checked = shown");
  assert.ok(/id="pvWebTx" checked/.test(on) && !/id="pvWebInc" checked/.test(on), "sub-switches = the privacy switch");
  assert.ok(/id="pvWebForced" hidden/.test(on), "the 'on because the bridge is off' note hidden while shown");
  assert.ok(on.includes("Pepe switched your mic transcripts off"), "the card's log");
  const hid = render(src, pageLocals({ pv3: Object.assign({}, P, { bridge: { on: true, waiting: null }, tx: { on: false } }) }));
  assert.ok(!/id="pvWebBridge" checked/.test(hid), "hidden: master unchecked");
  for (const id of ["pvWebInc", "pvWebTx", "pvWebCam"]) assert.ok(new RegExp(`id="${id}" checked\\s+disabled`).test(hid), id + " on + greyed while the bridge is off");
  assert.ok(/id="pvWebForced">/.test(hid) && hid.includes("On because the bridge is off"), "the note shows");
  const wait = render(src, pageLocals({ pv3: Object.assign({}, P, { bridge: { on: false, waiting: { want: true } } }) }));
  assert.ok(wait.includes('data-wait-bridge="1"') && /id="pvWebBridge" checked\s+disabled/.test(wait) && wait.includes("Waiting for Pepe"), "waiting");
  const unl = render(src, pageLocals({ pv3: Object.assign({}, P, { linked: false }) }));
  assert.ok(unl.includes("Link your Camfrog name first") && !unl.includes('id="pvWebBridge"'), "unlinked: no switches");
  // the route renders it only while in effect
  PS.noteBot({ privstate: 1 });
  const pg = await call("GET", "/settings/privacy", { user: U.bob });
  assert.equal(pg.status, 200);
  assert.ok(pg.text.includes('id="web"'), "the live page has the card while in effect");
  PS.noteBot({});
  const pg2 = await call("GET", "/settings/privacy", { user: U.bob });
  assert.ok(!pg2.text.includes('id="web"') && !pg2.text.includes("privacy-web.js"), "...and not without Pepe's word");
  // the client
  const js = fs.readFileSync(path.join(repo, "public", "js", "privacy-web.js"), "utf8");
  assert.ok(js.includes("kind: 'bridge', on: hide") && js.includes("kind: 'tx', on: off") && js.includes("/api/privacy/incognito") && js.includes("/api/privacy/livecam"),
            "the client posts each switch to its owner");
});

test("page golden: with the switch off the page is byte-identical to the S4 head's view", async () => {
  let baseSrc = null;
  try { baseSrc = execFileSync("git", ["-C", repo, "show", `${BASE}:views/privacy-settings.ejs`], { encoding: "utf8" }); } catch (e) { baseSrc = null; }
  if (!baseSrc) return;                                    // no base revision in this checkout
  // (1.99?? privacy controls, landed on 1.99aht: line endings aside - `git show` gives the blob's LF, a Windows checkout with
  // core.autocrlf the working file's CRLF; the page's HTML is what's compared)
  baseSrc = baseSrc.replace(/\r\n/g, "\n");
  const now = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8").replace(/\r\n/g, "\n");
  for (const extra of [{}, { mem: { capable: true, linked: true, login: "bob123", on: false, since: null, reported: null, waiting: null, failed: null, log: [] } },
                       { st: { linked: false, login: null, account: false, on: null, log: [] }, lc: { linked: false } }, { pv3: null }]) {
    assert.equal(render(now, pageLocals(extra)), render(baseSrc, pageLocals(extra)), "same HTML: " + Object.keys(extra).join(","));
  }
});

// ── dark extras ──
test("dark: the !privacy card on /help and a room-typed !privacy kept out of the archive only while advertised", async () => {
  await setup;
  const entries = [{ id: "incognito", title: "!incognito" }, { id: "privacy", title: "!privacy" }, { id: "remember", title: "!remember" }];
  await PS.setOn(false, ADM());
  assert.deepEqual(HELP.withoutDarkCards(entries).map((e) => e.id), ["incognito", "remember"], "switch off: no privacy card");
  assert.equal(CL.isPrivateCmd("!privacy"), false, "switch off: a room-typed !privacy is ordinary chat (as today)");
  assert.equal(CL.PRIVATE_ARGS.includes("!privacy"), false, "...not on the static floor");
  await PS.setOn(true, ADM());
  assert.deepEqual(HELP.withoutDarkCards(entries).map((e) => e.id), ["incognito", "privacy", "remember"], "advertised: the card shows");
  assert.equal(CL.isPrivateCmd("  !PRIVACY please"), true, "advertised: kept out");
  assert.equal(CL.isPrivateCmd("my !privacy"), false, "...the first word only");
  assert.equal(CL.isPrivateCmd("!incognito on"), true, "the floor as before");
  // the switch off: everything stops at once (the routes too)
  await PS.setOn(false, ADM());
  PS.noteBot({ privstate: 1 });
  assert.equal(PS.effective(), false);
  assert.equal((await call("GET", "/api/privacy/state", { user: U.bob })).status, 404);
  const r = await report({ items: [{ login: "bob123", kind: "tx", on: true, via: "chat", changed: true, ts: Date.now() + 99999 }] });
  assert.equal(r.d.privstate, undefined);
  assert.equal((await getQuery(`SELECT "on" AS "on" FROM privacy_state WHERE login = 'bob123' AND kind = 'tx'`))[0].on, 0, "a report after the switch went off changes nothing");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'privacyv3.switch'"))[0].n, 4, "every flip audited");
});

test("the account's rows: deleted with it, in Download my data, the audit follows a merge; actions expire like incognito's", () => {
  const del = fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8");
  assert.ok(del.includes('["privacy_state_log", "user_id", "uid"], ["privacy_state", "login", "login"]'), "account deletion");
  const exp = fs.readFileSync(path.join(repo, "accountexport.js"), "utf8");
  assert.ok(exp.includes('rows("privacy_state", "login = ?", [login])') && exp.includes('rows("privacy_state_log", "user_id = ?", [uid])'), "Download my data");
  const mg = fs.readFileSync(path.join(repo, "accountMerge.js"), "utf8");
  assert.ok(mg.includes('"privacy_state_log.user_id": M()'), "merge");
  const ttl = fs.readFileSync(path.join(repo, "actionttl.js"), "utf8");
  assert.ok(/"privacy\.bridge": 15/.test(ttl) && /"privacy\.tx": 15/.test(ttl), "15-minute expiry, like privacy.incognito");
});
