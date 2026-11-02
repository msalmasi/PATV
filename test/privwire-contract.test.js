// wave 2 WP-2 (incognito / mic-stage spec A.3, I.3, I.4 fail-closed proof): the privacy wire v2 on the site, against the SHARED
// contract fixture test/fixtures/privwire-contract.json - byte-identical with camfrog-bot's ci/fixtures/privwire-contract.json
// (written by Pepe's REAL bridge builders, tools/gen_privwire_contract.py), its sha256 pinned here AND in the bot's
// privwire_contract_test.py:
//   * the pin (PEPE_BOT_DIR=<a camfrog-bot checkout> also compares the bot's copy byte for byte)
//   * dark: with the switch never on, v1 answers never advertise, /api/bridge/sync/v2 answers 409 privwire_off BEFORE anything else
//     (no acks applied, no jobs taken, nothing ingested - a v1 resend of the same batch is not deduped), and the v2 route's counter
//     stays at 0 over any number of v1 syncs; its logs never carry a body (a marker in a malformed body and in a refused one)
//   * the switch (/api/admin/privwire, chatlog.admin, same-origin): audited, G set at the first ON and never moved again; while ON
//     the v1 answer says privwire: 2
//   * every case of Pepe's scene through the REAL /api/bridge/sync/v2 -> what a member's /live shows: each fixture `expect` (frog
//     names by pattern, masks, "someone" for C.2 / B.2), the v2 snapshot's roster; and nothing of a veiled person - no login,
//     display name, hash, hidden word, priv, vz - in any answer, for a member, the pad's owner or an admin (before any reveal);
//     the leak-test pass's cases too: rejoins, cams (Pepe keeps today's form on v2 - the site keeps nothing of them), astral
//   * FTS (spec I.3): Pepe's REAL redactor output with an astral emoji right before each veiled name (the "astral" case) archived
//     through the real route - chat_log keeps "someone" whole; chat_log_fts (MATCH) holds no veiled login, display name or
//     hidden word
//   NODE_PATH=G:/PATV/node_modules node --test test/privwire-contract.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "privwire-contract.json");
// Update together with camfrog-bot's copy (ci/fixtures/privwire-contract.json) and its pin (privwire_contract_test.py PIN):
// python tools/gen_privwire_contract.py --site <this checkout> prints the new sha.
const PIN = "e1a947dbe0efb70dca0cd282cfe321b7eb4cf056d97545f4e6d1a5476e8b8ebb";
const RAW = fs.readFileSync(FIXTURE);
const FX = JSON.parse(RAW.toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privwire-contract-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ab".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));

const users = new Map();
const U = {};
let base, server;
const SLUG = "pepes-pad";
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
// what must never reach a page: the veiled people's identities, their hashes, the hidden words, the wire's own fields
const SECRETS = (() => {
  const s = new Set(["frankie", "Frankie", "hank", "Hank", "\"priv\"", "\"vz\"", "\"_vz\"", "\"vw\"", "\"ah\"", "\"ahs\"", "\"h:"]);
  for (const c of FX.cases) for (const e of c.v2) {
    const p = e.data && e.data.priv;
    if (!p) continue;
    s.add(p.h);
    for (const x of p.hs || []) s.add(x);
    if (p.words) s.add(p.words);
  }
  return [...s];
})();
function leaks(json) { return SECRETS.filter((x) => json.includes(x)); }

function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
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
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const body = (events, extra = {}) => Object.assign({ password: "bot", v: 1, protocol: "pcp/1.0", connector: "cf-pepe", session: FX.session,
                                                      events, rooms: [], closed: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra);
// the fixture's clock is a frozen 2026-11-01 12:00 UTC: replayed "now", in order (the live tail's presence floor is 24 h)
const SHIFT = Date.now() - FX.t0 * 1000 - 3600e3;
const shift = (e) => Object.assign({}, e, { ts: new Date(Date.parse(e.ts) + SHIFT).toISOString() });
const shiftSnap = (s) => JSON.parse(JSON.stringify(s));

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.adm = await mkUser("adm", "Admin", "admcf");
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  await PW.init();
  await CL.init();
  await rooms.setOwner(FX.room, "own", "test").catch(() => {});
})();

test("the pin: the fixture is the pinned version, LF only (PEPE_BOT_DIR also compares the bot's copy)", () => {
  assert.equal(sha(RAW), PIN, "regenerate in camfrog-bot (tools/gen_privwire_contract.py) and re-pin BOTH repos");
  assert.ok(!RAW.includes(Buffer.from("\r\n")), "LF line ends (.gitattributes text eol=lf)");
  const other = process.env.PEPE_BOT_DIR;
  if (other) assert.ok(fs.readFileSync(path.join(other, "ci", "fixtures", "privwire-contract.json")).equals(RAW), "the bot's copy is byte-identical");
  assert.equal(FX.constants.privwire, 2);
  assert.equal(FX.constants.path, "/api/bridge/sync/v2");
  assert.deepEqual(FX.constants.refuse, [404, 405, 409]);
});

test("dark: the switch never on - no advert, the v2 route refuses BEFORE anything happens, its counter stays 0 over v1 syncs", async () => {
  await setup;
  assert.equal(PW.isOn(), false, "ships OFF");
  for (let i = 0; i < 25; i++) {
    const r = await call("POST", "/api/bridge/sync", { body: body([]) });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(!("privwire" in r.d), "a v1 answer never advertises while the switch is off");
  }
  assert.equal(PW.counts().calls, 0, "Pepe never called v2: the counter is 0 (the staging dark proof)");
  // a refused v2 call has no side effect at all
  let acks = 0, jobs = 0;
  const ra = relay.applyAcks, tj = relay.takeJobs;
  relay.applyAcks = (...a) => { acks++; return ra(...a); };
  relay.takeJobs = (...a) => { jobs++; return tj(...a); };
  try {
    const dark = (e) => Object.assign(shift(e), { id: e.id + "-dark" });   // (own ids: the replay below sends the fixture's)
    const joins = FX.cases.find((c) => c.name === "joins").v2.map(dark);
    const before = (await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n;
    const r = await call("POST", "/api/bridge/sync/v2", { body: body(joins, { acks: [{ id: "w0000000000000001", state: "sent" }] }) });
    assert.equal(r.status, 409);
    assert.deepEqual(r.d, { success: false, error: "privwire_off" });
    assert.equal(acks, 0, "no acks applied");
    assert.equal(jobs, 0, "no jobs taken");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n, before, "nothing ingested");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n, 0, "no identity stored");
    assert.deepEqual(PW.counts().calls, 1);
    assert.equal(PW.counts().refused, 1);
    // ... so Pepe's v1 copy of the SAME batch (same event ids) is taken, not deduped
    const v1 = FX.cases.find((c) => c.name === "joins").v1.map(dark);
    const r1 = await call("POST", "/api/bridge/sync", { body: body(v1) });
    assert.equal(r1.status, 200);
    assert.ok((await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n > before, "the v1 copy landed");
  } finally { relay.applyAcks = ra; relay.takeJobs = tj; }
});

test("the v2 route never logs a body: a malformed one and a refused one carrying a marker", async () => {
  await setup;
  const MARK = "MARKER-frankiefettuccine-" + crypto.randomBytes(6).toString("hex");
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.stack + " " + x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  try {
    const bad = await call("POST", "/api/bridge/sync/v2", { body: `{"password":"bot","events":[{"text":"${MARK}"` });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes(MARK), "the answer doesn't echo it");
    const off = await call("POST", "/api/bridge/sync/v2", { body: body([{ op: "event", id: "x1", type: "message", data: { text: MARK } }]) });
    assert.equal(off.status, 409);
  } finally { Object.assign(console, orig); }
  assert.ok(lines.some((l) => /sync v2: body refused/.test(l)), "the refusal is logged (its type and status)");
  assert.ok(!lines.some((l) => l.includes(MARK)), "no log line carries the body: " + lines.filter((l) => l.includes(MARK)).join(" | "));
});

test("the switch: admins only, same-origin, audited; G set at the first ON and sticky; the v1 answer then advertises privwire: 2", async () => {
  await setup;
  assert.equal((await call("POST", "/api/admin/privwire", { user: U.mem, body: { on: true } })).status, 403, "members can't");
  assert.equal((await call("POST", "/api/admin/privwire", { user: U.adm, body: { on: true }, headers: { "x-requested-with": "" } })).status, 403, "fetch only");
  const r = await call("POST", "/api/admin/privwire", { user: U.adm, body: { on: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.state.on, true);
  const g = r.d.state.g_at;
  assert.ok(g > 0, "G is set");
  const a = await getQuery("SELECT action, admin_name FROM admin_audit WHERE action = 'privwire.switch'");
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_name, "adm");
  const v1 = await call("POST", "/api/bridge/sync", { body: body([]) });
  assert.equal(v1.d.privwire, 2, "the advert");
  // off and on again: G stays where the first ON put it
  await call("POST", "/api/admin/privwire", { user: U.adm, body: { on: false } });
  assert.ok(!("privwire" in (await call("POST", "/api/bridge/sync", { body: body([]) })).d), "off: no advert");
  const again = await call("POST", "/api/admin/privwire", { user: U.adm, body: { on: true } });
  assert.equal(again.d.state.g_at, g, "G is sticky");
  const st = await call("GET", "/api/admin/privwire", { user: U.adm });
  assert.equal(st.status, 200);
  // review fix (A-compat-9): calls are PEPE's calls only (the bot token checked) - the malformed body above is a probe, not a call
  assert.ok(st.d.counts.calls >= 2, JSON.stringify(st.d.counts));
  assert.ok(st.d.counts.probes >= 1, "the malformed body counted as a probe");
  const c0 = PW.counts();
  const junk = await call("POST", "/api/bridge/sync/v2", { body: { password: "not-the-bot", events: [], rooms: [] } });
  assert.equal(junk.status, 403);
  const bad = await call("POST", "/api/bridge/sync/v2", { body: "{not json" });
  assert.equal(bad.status, 400);
  const c1 = PW.counts();
  assert.equal(c1.calls, c0.calls, "a crawler / probe never moves the call count (the dark proof)");
  assert.equal(c1.refused, c0.refused);
  assert.equal(c1.err, c0.err);
  assert.equal(c1.probes, c0.probes + 2, "they count as probes");
});

const KINDS = { "member.join": "join", "member.leave": "leave", message: "msg", "x.pepe.transcript": "tx", "mic.grab": "mic", "mic.release": "unmic" };
test("every case of Pepe's scene through the real /api/bridge/sync/v2: a member sees what the fixture expects - and nothing of who", async () => {
  await setup;
  assert.equal(PW.isOn(), true);
  const R0 = () => bridge._rooms.get(FX.room);
  const shown = [];                                                   // [{expect, c}]
  for (const c of FX.cases) {
    const before = R0() ? R0().feed.length : 0;
    const snap = c.name === "hold_incognito_grab" ? [shiftSnap(FX.snapshot.v2)] : [];
    const r = await call("POST", "/api/bridge/sync/v2", { body: body(c.v2.map(shift), { rooms: snap }) });
    assert.equal(r.status, 200, c.name + ": " + r.text.slice(0, 300));
    assert.equal(r.d.privwire, 2, "the v2 answer keeps the advert");
    const R = R0();
    assert.ok(R, "the room");
    const added = R.feed.slice(before);
    const exp = c.expect.filter(Boolean);
    assert.equal(added.length, exp.length, c.name + ": one live item per shown event (" + added.map((x) => x.k).join(",") + ")");
    added.forEach((it, i) => shown.push({ name: c.name, expect: exp[i], c: it.c }));
    for (const it of added) {
      assert.ok(!JSON.stringify(it).match(/"_?vz"|"vw"|frankie|hank/i), c.name + ": a stored item never holds an identity");
      if (it.u && it.u.veil) assert.equal(it.u.anon, true, "invariant: a veiled item is anon");
    }
  }
  const R = R0();
  for (const e of [...R.members, ...R.mic]) if (e.veil) assert.equal(e.anon, true, "invariant: a veiled roster / mic entry is anon");
  // bridge_feed keeps a veiled line's hidden-set hashes server-only (ah / ahs, exactly like Pepe's anonymised lines - dress drops
  // them); nothing else of who, and never a hidden word, a priv block or an identity
  const stored = (await getQuery("SELECT data FROM bridge_feed")).map((r) => { const o = JSON.parse(r.data); delete o.ah; delete o.ahs; return o; });
  const json = JSON.stringify(stored) + JSON.stringify((await getQuery("SELECT snap FROM bridge_rooms")).map((r) => JSON.parse(r.snap)));
  assert.deepEqual(leaks(json), [], "bridge_feed / bridge_rooms JSON hold no identity or word");
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n > 0, "the identities are in bridge_veil");
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM bridge_rooms_veil"))[0].n === 1, "and the roster's in bridge_rooms_veil");
  // what each role's page gets
  for (const viewer of [U.mem, U.own, U.adm]) {
    const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: viewer });
    assert.equal(lv.status, 200, lv.text.slice(0, 300));
    const by = new Map(lv.d.feed.map((x) => [x.c, x]));
    for (const s of shown) {
      const o = by.get(s.c), e = s.expect;
      assert.ok(o, `${s.name}: line ${s.c} shown to ${viewer.username}`);
      assert.equal(o.k, e.k, s.name);
      if (e.named) {
        assert.ok(!o.u.anon, s.name + ": named");
        assert.equal(o.u.display, e.named, s.name);
        // 1.99?? S1 (owner Q5): a named !transcripts off bar - the name, the bar, no words
        if (e.mask) { assert.equal(o.mask, e.mask, s.name + ": the bar"); assert.ok(!("text" in o) && !("id" in o), s.name + ": a bar never carries words or the 🎙 id"); }
        if (viewer === U.mem && e.mask) assert.ok(!o.rv, s.name + ": no reveal flag for a member");
      } else {
        assert.equal(o.u.anon, true, s.name + ": veiled");
        assert.equal(o.u.display, "someone", s.name);
        assert.equal(o.u.veil, e.veil, s.name + ": the level tag");
        if (e.alias) assert.match(o.u.alias || "", ALIAS_RE, s.name + ": a frog name");
        else assert.ok(!o.u.alias && o.u.hood == null && !o.u.id, s.name + ": 'someone' (C.2 / B.2) - no name, hood or id");
        if (e.alias) assert.match(String(o.u.id || ""), /^v-[A-Za-z0-9_-]{12}$/, s.name + ": the opaque session id");
        if (e.mask) { assert.equal(o.mask, e.mask, s.name + ": the bar"); assert.ok(!("text" in o), s.name + ": a bar never carries words"); }
        if (e.hold && e.alias) assert.match(String(o.hold || ""), /^hd-/, s.name + ": the hold (B.3)");   // ("someone": dropped, below)
        if (!e.alias) assert.ok(!o.hold, s.name + ": no hold beside 'someone'");
        if (viewer === U.mem) assert.ok(!o.rv, s.name + ": no reveal flag for a member");
      }
      if (e.text != null) assert.equal(o.text, e.text, s.name + ": the words");
      assert.equal(o.txh === 1, e.txh === true, s.name + ": the 'transcript hidden' tag (1.99?? S1) only on a !transcripts off bar not hidden");
    }
    // the frog names: one per session - frankie's lines share theirs, hank's another; hoods differ
    // (1.99?? transcripts bar: expect.as = the frog name's own level - frankie's !transcripts off 🎙 bar carries his INCOGNITO name)
    const fr = shown.filter((s) => s.expect && (s.expect.as || s.expect.veil) === "incognito" && s.expect.alias).map((s) => by.get(s.c).u);
    const hk = shown.filter((s) => s.expect && (s.expect.as || s.expect.veil) === "hidden" && s.expect.alias).map((s) => by.get(s.c).u);
    assert.equal(new Set(fr.map((u) => u.alias)).size, 1, "frankie keeps one frog name");
    assert.equal(new Set(hk.map((u) => u.alias)).size, 1, "hank keeps one frog name");
    assert.notEqual(fr[0].alias, hk[0].alias);
    assert.notEqual(fr[0].alias.split(" ")[0], hk[0].alias.split(" ")[0], "distinct adjectives (C.4)");
    assert.notEqual(fr[0].hood, hk[0].hood, "distinct hoods");
    // the roster: the v2 snapshot's veiled members as frog names, never on_cam, count = everyone
    const vm = lv.d.members.filter((m) => m.veil);
    assert.equal(vm.length, 2, "frankie + hank listed (J-3: hidden people are in the roster)");
    for (const m of vm) { assert.equal(m.anon, true); assert.ok(!("on_cam" in m)); assert.ok(!m.login); }
    assert.equal(lv.d.room.count, 6, "count = everyone in the room");
    assert.deepEqual(leaks(lv.text), [], `nothing of a veiled person reaches ${viewer.username}'s /live: ` + leaks(lv.text).join(", "));
  }
  // the owner and the admin get the member view plus rv flags - nothing more
  const own = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.adm });
  assert.ok(own.d.feed.some((o) => o.rv === 1), "an admin's items say they may be revealed");
  // 1.99?? transcripts bar: every txbar_* bar is revealable by an admin, never by a member; its words reach no page (SECRETS)
  const bars = shown.filter((x) => /^txbar_/.test(x.name) && x.expect && x.expect.mask);
  assert.equal(bars.length, 3, "tina's, frankie's and hank's !transcripts off bars");
  const byA = new Map(own.d.feed.map((x) => [x.c, x]));
  for (const b of bars) assert.equal(byA.get(b.c).rv, 1, b.name + ": an admin may reveal it");
  for (const b of bars) assert.ok(R.feed.find((it) => it.c === b.c).tm === 1, b.name + ": stamped tm (server-only)");
});

test("v2 extras on named lines: a named hold and its 🎙 line carry the same hold id; the said time rides", async () => {
  await setup;
  const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.mem });
  const bx = lv.d.feed.filter((o) => o.u && o.u.login === "bxdude180" && (o.k === "mic" || o.k === "unmic" || o.k === "tx"));
  assert.equal(new Set(bx.map((o) => o.hold)).size, 1, "one hold id across grab, release and 🎙 line");
  const tx = bx.find((o) => o.k === "tx");
  assert.ok(tx && tx.at > 0, "the said time");
});

test("FTS (spec I.3): the astral case - Pepe's redactor output, an emoji right before each veiled name - archived: 'someone' whole, no veiled name or hidden word in chat_log_fts", async () => {
  await setup;
  assert.equal(PW.isOn(), true);
  // the archive on (its notice 8 days back), then the case again under fresh event ids (the replay above ran with the archive off)
  CL._setClock(() => Date.now() - 8 * 864e5);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  await CL.setSwitch("archive", true, "test");
  const c = FX.cases.find((x) => x.name === "astral");
  assert.ok(c, "the fixture has the astral case");
  const evs = c.v2.map((e) => Object.assign(shift(e), { id: e.id + "-fts",
    data: Object.assign({}, e.data, e.data.message_id ? { message_id: e.data.message_id + "-fts" } : {}) }));
  const r = await call("POST", "/api/bridge/sync/v2", { body: body(evs) });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  await new Promise((res) => setTimeout(res, 80));
  const want = c.expect.filter((e) => e && e.text != null).map((e) => e.text);
  assert.ok(want.length === 2 && want.every((t) => t.startsWith("\u{1F600}someone")), "the fixture's redacted texts");
  const someone = (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"someone"'])).map((h) => h.rowid);
  for (const t of want) {
    const row = (await getQuery("SELECT c, text FROM chat_log WHERE text = ?", [t]))[0];
    assert.ok(row, "archived whole (no fragment, no broken surrogate): " + t);
    assert.ok(someone.includes(row.c), "its 'someone' is a whole token in the index");
  }
  const hidden = c.v2.find((e) => e.data.priv && e.data.priv.kind === "hidden");
  const veilRow = (await getQuery("SELECT c, words FROM chat_log_veil WHERE words = ?", [hidden.data.priv.words]))[0];
  assert.ok(veilRow, "the hidden line's words live in chat_log_veil");
  assert.equal((await getQuery("SELECT text FROM chat_log WHERE c = ?", [veilRow.c]))[0].text, null, "...its chat_log text is NULL");
  for (const tok of ["frankie", "Frankie", "hank", "Hank", "psst"]) {
    assert.deepEqual(await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"' + tok + '"']), [], "never indexed: " + tok);
  }
});
