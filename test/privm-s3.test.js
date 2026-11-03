// 1.99aid (privacy controls S3): LIVE CAM OFF -> A NAMED TILE WITH THE DEFAULT COVER (G:/ops/privacy-controls-spec-2026-11-02.md section 5
// "S3", the 2.2 table, 6.2 wording; the owner's answers, section 8: Q1 incognito + live cam off = the peek hood, Q14 the other cam
// opt-outs get the same named cover tile). micfollow_cfg withheld_cover (dark, admin-set on /stage/admin). On a temp DB with the real
// mic-stage engine, livecam, camaccess, stage bans, stageleave, the cover module and the capture engine:
//   switch    off by default (prod and staging), auto-listed on /stage/admin; off = today's CUT for every cam opt-out (a golden
//             recorded from the build before - test/fixtures/privm-s3-golden.json)
//   tile      a mic holder with !livecam off / "Pads may put my cam on their stage" off / cam access followers or request is a NAMED
//             card in state "withheld" with their stage cover (stagecover.coverOf) and "cam off" on the page (never why) - no relay
//             want, no still, no warm keep; alone on the mic it is not "Someone is speaking"; a live tile whose person turns live cam
//             off becomes that card in place (no cut); the switch going off cuts it at once
//   rules     every other stage rule still keeps them off (each case fails on a naive early return at the live-cam check): private,
//             excluded, banned, "Take me off this Stage", blocked_owner, the DM block with the owner, ended_by, the DF-11 notice gate
//   veiled    incognito + live cam off -> the peek hood, bridge off -> the shadow hood; coverOf never called for them
//   pins      still refused
//   captures  a withheld card is drawn with its name and cover without camRefusal, counts as a name card and stays postable
//             (recheck, storykeep's card consent); switch off: camRefusal decides, as before
//   text      the one courtesy notice and Settings say !livecam off stops the cam (cover picture instead) only while on
//   node --test test/privm-s3.test.js       (PRIVM_S3_GOLDEN_WRITE=1 re-records the golden from the build it runs on)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s3-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const bridge = require(path.join(repo, "bridge"));
const rooms = require(path.join(repo, "rooms"));
const stage = require(path.join(repo, "mainstage"));
const PA = require(path.join(repo, "padaccess"));
const relay = require(path.join(repo, "bridge-relay"));
const CA = require(path.join(repo, "camaccess"));
const CV = require(path.join(repo, "camviewers"));
const stories = require(path.join(repo, "stories"));
const premium = require(path.join(repo, "premium"));
const MF = require(path.join(repo, "micfollow"));
const core = require(path.join(repo, "micfollow-core"));
const GOLDEN = process.env.PRIVM_S3_GOLDEN || path.join(repo, "test", "fixtures", "privm-s3-golden.json");
const BASE = process.env.PRIVM_S3_BASE_REV || "c3ba0971";   // (the round 4 head on 1.99aib - the build before S3)

W.enabled = () => true;
let T = Date.now();
LC._setClock(() => T);
stage._setClock(() => T);
MF._setClock(() => T);
MF._setBoot(0);
LC._setKick(() => {});
relay.padFull = async () => true;
let PRIV = new Set();
stories.privateLogins = async (ls) => new Set(ls.map((l) => String(l).toLowerCase()).filter((l) => PRIV.has(l)));
premium.bridgeAllowed = () => true;
CV.noteViewers = () => Promise.resolve(0);

const ROOM = { id: "S3.Room", name: "S3 Room" };
const ADMIN = { userId: "u_admin", username: "admin", class: "Admin" };
const STAFF = { userId: "u_staff", username: "staffer", class: "Staff" };
const PEOPLE = ["alice", "bob", "carl", "dana"];
let R = null;
const MEMBERS = () => [
  { login: "alice", display: "Alice W", on_cam: true }, { login: "bob", display: "Bob", on_cam: true }, { login: "carl", display: "Carl", on_cam: true },
  { login: "dana", display: "Dana", on_cam: true }, { login: "erin", display: "Erin", on_cam: true },
  { anon: true, display: "someone", on_cam: true }, { login: "pepe", display: "Pepe", self: true, on_cam: true }];
function room(holders, extra) {
  R = bridge._rooms.get(ROOM.id);
  const mic = (holders || []).map((h) => (typeof h === "string" ? { login: h, display: h, proven: true } : h));
  Object.assign(R, { updated: T, cams: true, livecams: true, members: MEMBERS(), mic }, extra || {});
  return R;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (!fn() && Date.now() < end) await settle(); }
async function step(holders, extra) {
  room(holders, extra); MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle();
  room(holders, extra); MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle();
  return MF._pads.get(ROOM.id).state;
}
const P = () => MF._pads.get(ROOM.id);
const tiles = () => P().state.tiles.map((x) => x.login);
const tile = (l) => P().state.tiles.find((x) => x.login === l) || null;
const tileOn = (l) => tiles().includes(l);
const EXACT = new Set();
const bot = (extra) => LC.forBot(Object.assign({ cap: true, mf: 1,
  live: [...EXACT].filter((l) => LC._sessions.has(LC.keyOf(ROOM.id, l))).map((l) => ({ room: ROOM.id, login: l, state: "live", exact: true })) }, extra || {}), T);
function up(...logins) { LC.noteSync(logins.map((l) => ({ name: LC.pathFor(ROOM.id, l), ready: true, readers: [] })), T); for (const l of logins) EXACT.add(l); }
async function at(sec, holders, extra) { T += sec * 1000; await bot(); return step(holders, extra); }
async function onStage(logins) { await step(logins); await at(3, logins); up(...logins); await at(1, logins); }
async function plainPad() { await MF.setPad(ROOM.id, { on: true, layout: "auto", default_view: "first", max_people: 4, max_live: 4, keep_recent: 0 }, "test"); }
async function reset() {
  for (const Q of MF._pads.values()) { Q.state = core.newState(); Q.stills.clear(); Q.spans.clear(); }
  for (const S of [...LC._sessions.values()]) LC._sessions.delete(S.key);
  EXACT.clear();
  T += 10 * 60 * 1000;
  PRIV = new Set();
  for (const l of PEOPLE) await MF.unexclude(ROOM.id, l);
  await bot();
}
/** The site's knobs for a test (cfg), the rest as the suite set them. */
async function knobs(extra) { await MF.setCfg(ADMIN, Object.assign({ enabled: true, cold_open: true, reason: "test" }, extra || {})); }
const ownLive = (l) => { const S = LC._sessions.get(LC.keyOf(ROOM.id, l)); return !!(S && !S.ended && S.holds.has("mf:" + ROOM.id)); };
/** !livecam off / on (the website switch) - newer wins in livecam, so each call is stamped later than the last */
let OPT_N = 0;
const optout = (l, off) => LC.setOptout(l, off, { ts: T + (++OPT_N) });
const wantOf = async () => ((await bot()).want || []).map((w) => w.login);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["u_admin", "admin", "Admin", null], ["u_staff", "staffer", "Staff", null], ["u_owner", "padowner", "pleb", null],
                                     ["u_alice", "alice_patv", "pleb", "alice"], ["u_bob", "bob_patv", "pleb", "bob"], ["u_v1", "viewer1", "pleb", "viewer1"],
                                     ["u_v2", "viewer2", "pleb", null], ["u_v3", "viewer3", "pleb", "viewer3"], ["pepe-bot", "Pepe", "Bot", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));                         // (its pepe_actions table: the courtesy PM's queue)
  for (let i = 0; i < 50 && !(await getQuery("SELECT 1 AS x FROM sqlite_master WHERE name = 'pepe_actions'")).length; i++) await settle();
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "alice", login: "alice", display: "Alice W" }], count: 1, cams: true, livecams: true, mic: [] }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await rooms.setOwner(ROOM.id, "padowner", "test");
  await stage.init();
  await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true } });
  await CA.init();
  for (const l of [...PEOPLE, "erin"]) await CA.setMode(l, "everyone");
  await MF._ready();
  for (const l of [...PEOPLE, "erin"]) await MF._noticed(ROOM.id, l, 1);
  await MF.setKill(STAFF, true, "test");
  await knobs();
  await plainPad();
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? { userId: u, username: u, class: u === "u_admin" ? "Admin" : u === "u_staff" ? "Staff" : "pleb" } : null;
    next();
  };
  MF.register(app, { addUser, bySlug: (s) => bridge.bySlug(s), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, body, u) {
  const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(p, u) {
  const r = await fetch(base + p, { headers: H(u) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}

// ── the cam opt-outs (Q14) - set and undone ──
const OPTS = {
  livecam: [async () => optout("alice", true), async () => optout("alice", false)],
  mf: [async () => MF.setOptout("alice", true), async () => MF.setOptout("alice", false)],
  followers: [async () => CA.setMode("alice", "followers"), async () => CA.setMode("alice", "everyone")],
  request: [async () => CA.setMode("alice", "request"), async () => CA.setMode("alice", "everyone")],
};

/** The scripted scenario the golden records (switch off): bob on the stage live, then alice - with one cam opt-out - holds the mic
 *  alone while bob's tile hands over. Each step: the tiles, the neutral strip, a member's program, Pepe's want list, the stills. */
async function scenario(kind) {
  await reset(); await plainPad();
  const [on, off] = OPTS[kind];
  await on();
  const out = [];
  try {
    await onStage(["bob"]);
    for (let i = 0; i < 8; i++) {
      up("bob");
      await at(3, ["alice"]);
      const snap = MF.snapshot(ROOM.id);
      const v = await MF.viewFor(snap, R, "u_v1", null);
      out.push({ tiles: P().state.tiles.map((x) => [x.login, x.video || null, x.why || null]), neutral: snap.neutral || null,
                 src: v.src.map((s) => [s.kind, s.id, s.video, s.why || null, s.watch, s.avatar || null]),
                 want: (await wantOf()).sort(), stills: [...P().stills.keys()].sort(), kept: [...P().state.kept.keys()].sort() });
    }
  } finally { await off(); await settle(); }
  return out;
}

if (process.env.PRIVM_S3_GOLDEN_WRITE === "1") {
  test("record the switches-off golden from THIS build", async () => {
    const out = {};
    for (const k of Object.keys(OPTS)) out[k] = await scenario(k);
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n{") + "\n");
  });
} else {

// ── the switch ──
test("switch: micfollow_cfg withheld_cover is dark (off on prod and staging), a /stage/admin knob; off = the build before for every cam opt-out (golden)", async () => {
  assert.deepEqual(core.FIELDS.withheld_cover, { def: false, bool: true }, "dark - not a STAGING default");
  assert.equal(MF.cfg().withheld_cover, false, "a saved row that never named it reads off");
  assert.equal(MF.withheldCover(), false);
  const view = await MF.adminView(ADMIN);
  assert.ok(view.fields && view.fields.withheld_cover && view.fields.withheld_cover.bool === true, "auto-listed with the other knobs");
  assert.equal(view.cfg.withheld_cover, false);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(OPTS).sort());
  for (const k of Object.keys(OPTS)) {
    const got = await scenario(k);
    assert.equal(JSON.stringify(got), JSON.stringify(golden[k]), k + ": the switch off is today's CUT, step by step");
    // (what the golden says, in words)
    assert.ok(got.every((s) => !s.tiles.some((x) => x[0] === "alice")), k + ": never a tile");
    assert.ok(got.some((s) => s.neutral === "someone"), k + ": 'Someone is speaking' over bob's tile");
  }
});

// ── the withheld tile ──
test("on: a mic holder with a cam opt-out (live cam off, the mic-stage switch off, followers, request - Q14) is a NAMED card with their cover, 'cam off' - no relay, still or warm keep; alone on the mic it isn't 'Someone is speaking'", async () => {
  const SC = require(path.join(repo, "stagecover"));
  await SC.init();
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  await runQuery("INSERT OR REPLACE INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES ('alice', 4242, 1)");
  SC.invalidate();
  const gtf = SC.gtfUrl(4242, {});
  const asked = [], cov0 = SC.coverOf;
  SC.coverOf = (l) => { asked.push(String(l)); return cov0(l); };
  // stills and warm keep on - so a still / a kept relay WOULD happen to a cam the stage may show
  await knobs({ withheld_cover: true, stills: true, warm_keep_s: 180, warm_max: 3 });
  try {
    for (const kind of Object.keys(OPTS)) {
      await reset(); await plainPad();
      const [on, off] = OPTS[kind];
      await on();
      try {
        await onStage(["bob"]);
        assert.ok(ownLive("bob"), kind + ": set up");
        asked.length = 0;
        let sawSpeaking = false;
        for (let i = 0; i < 8; i++) {
          up("bob");
          await at(3, ["alice"]);
          if (MF.snapshot(ROOM.id).neutral) sawSpeaking = true;
          assert.ok(!ownLive("alice") && !LC._sessions.has(LC.keyOf(ROOM.id, "alice")), kind + ": never a relay of hers");
          assert.ok(!(await wantOf()).includes("alice"), kind + ": never in Pepe's want list");
          assert.ok(!P().stills.has("alice") && !P().state.kept.has("alice"), kind + ": never a still or a kept relay");
        }
        assert.equal(sawSpeaking, false, kind + ": never 'Someone is speaking' - she is shown");
        const x = tile("alice");
        assert.ok(x, kind + ": her tile: " + JSON.stringify(tiles()));
        assert.deepEqual([x.video, x.why], ["card", "withheld"], kind);
        assert.equal(MF.stillWanted(ROOM.id, "alice"), false, kind + ": no still job would be handed to Pepe");
        for (const uid of ["u_v1", "u_v2", "u_owner", "u_admin"]) {
          const s = (await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null)).src.find((e) => e.id === "alice");
          assert.ok(s, kind + " " + uid);
          assert.deepEqual([s.kind, s.name, s.video, s.why, s.watch], ["cam", "alice", "card", "off_cam", "ok"], kind + " " + uid + ": named, 'cam off' - never why");
          assert.deepEqual([s.avatar, s.ck], [gtf, "gtf"], kind + " " + uid + ": her stage cover");
        }
        assert.ok(asked.includes("alice"), kind + ": the picture is stagecover.coverOf's");
        const cap = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null, T, "capture")).src.find((e) => e.id === "alice");
        assert.equal(cap.why, "withheld", kind + ": a capture's program says withheld (stagemiccap's marker)");
        // the tile routes have no cam to give
        const w = await post(`/api/rooms/${R.slug}/micfollow/watch`, { login: "alice" }, "u_v1");
        assert.deepEqual([w.d.state, w.d.whep], ["ended", undefined], kind + ": no ticket");
        assert.equal((await get(`/api/rooms/${R.slug}/micfollow/still/alice`, "u_v1")).d.state, "none", kind + ": no still");
        // she lets go: off after the plain hand-over like a cam-off card, and no relay kept warm
        for (let i = 0; i < 10 && tileOn("alice"); i++) { up("bob"); await at(3, []); }
        assert.equal(tileOn("alice"), false, kind + ": left");
        assert.ok(!P().state.kept.has("alice") && !LC._sessions.has(LC.keyOf(ROOM.id, "alice")), kind + ": nothing kept");
        const sp = (await getQuery("SELECT video_secs FROM micfollow_spans WHERE login = 'alice' ORDER BY id DESC LIMIT 1"))[0];
        assert.ok(sp && Number(sp.video_secs) === 0, kind + ": her span (the privacy record) - no video");
      } finally { await off(); await settle(); }
    }
    // a lone holder: nobody else on the stage - her card, not the neutral card
    await reset(); await plainPad();
    await optout("alice", true);
    try {
      await step(["alice"]); await at(3, ["alice"]); await at(3, ["alice"]);
      assert.deepEqual(tiles(), ["alice"]);
      assert.equal(MF.snapshot(ROOM.id).neutral, null);
      assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).speaking, null, "not 'Someone is speaking'");
    } finally { await optout("alice", false); }
  } finally {
    SC.coverOf = cov0;
    await knobs({ withheld_cover: false, warm_keep_s: 0 });
    await runQuery("DELETE FROM cosmetic_avatar_seeds"); SC.invalidate();
  }
});

test("on: a LIVE tile whose person turns !livecam off becomes their withheld card in place - the relay let go, no cut; back on: the cam again. The switch off cuts it at once", async () => {
  await knobs({ withheld_cover: true });
  try {
    await reset(); await plainPad();
    await onStage(["alice", "bob"]);
    assert.ok(ownLive("alice") && tile("alice").video === "live", "set up");
    const spans0 = (await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans WHERE login = 'alice'"))[0].n;
    await optout("alice", true);
    await settle(); await MF._idle();
    assert.ok(tileOn("alice"), "still on the stage - the cam stops, not the appearance");
    assert.deepEqual([tile("alice").video, tile("alice").why], ["card", "withheld"]);
    assert.equal(ownLive("alice"), false, "the relay is let go");
    up("bob"); await at(1, ["alice", "bob"]);
    assert.deepEqual([tile("alice").video, tile("alice").why], ["card", "withheld"], "and stays the card");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans WHERE login = 'alice'"))[0].n, spans0, "the same span - no cut");
    assert.equal((await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = 'alice' ORDER BY id DESC LIMIT 1"))[0].end_reason, null, "still open");
    // live cam on again: her cam
    await optout("alice", false);
    await MF.recheck("alice");
    up("bob"); await at(1, ["alice", "bob"]);
    up("alice", "bob"); await at(1, ["alice", "bob"]);
    assert.equal(tile("alice").video, "live", "the cam again");
    // a hold livecam refuses "opted_out" (a race: she switched it off while it was on its way) - the card, not a cut
    const A = core.holdDone(P().state, "alice", false, "opted_out", MF.cfg(), T);
    assert.ok(!A.some((a) => a.a === "span_close"), "no cut");
    assert.deepEqual([tile("alice").video, tile("alice").why], ["card", "withheld"]);
    // the switch off: today's CUT at once
    await optout("alice", true);
    await settle();
    assert.equal(tile("alice").why, "withheld");
    await knobs({ withheld_cover: false });
    assert.equal(tileOn("alice"), false, "switch off: cut at once (opted_out)");
    assert.equal((await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = 'alice' ORDER BY id DESC LIMIT 1"))[0].end_reason, "cut:opted_out");
  } finally { await optout("alice", false); await knobs({ withheld_cover: false }); }
});

// ── every other rule still runs (spec review: no early return at the live-cam check) ──
test("on: every other stage rule still keeps a live-cam-off holder OFF - private, excluded, banned, 'Take me off this Stage', blocked_owner, the DM block, ended_by, the DF-11 notice gate (each fails on a naive early return); lifted: her named card", async () => {
  const SL = require(path.join(repo, "stageleave"));
  SL._setClock(() => T);
  await SL.init();
  const cool0 = LC.cooling;
  const CASES = [
    ["private", async () => { PRIV.add("alice"); await MF.recheck("alice", { refresh: true }); }, async () => { PRIV.delete("alice"); await MF.recheck("alice", { refresh: true }); }],
    ["excluded", async () => MF.excludeFor(ROOM.id, "alice", 60, "owner", "test"), async () => MF.unexclude(ROOM.id, "alice")],
    ["banned", async () => { await stage.ban("alice_patv", "test", "admin"); await MF.recheck("alice", { refresh: true }); },
               async () => { await stage.unban("u_alice", "admin"); await MF.recheck("alice", { refresh: true }); }],
    ["Take me off this Stage", async () => SL.leave({ roomId: ROOM.id, login: "alice", userId: "u_alice", via: "web" }, T),
                               async () => { await runQuery("DELETE FROM stage_leave"); await SL.load(T); }],
    ["blocked_owner", async () => { assert.equal((await CV.block("alice", "padowner")).ok, true); }, async () => CV.unblock("alice", "padowner")],
    ["the DM block with the owner", async () => { await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_alice', 'u_owner', ?)", [T]); await MF.recheck("alice", { refresh: true }); },
                                    async () => { await runQuery("DELETE FROM dm_blocks"); await MF.recheck("alice", { refresh: true }); }],
    ["ended_by", async () => { LC.cooling = (rid, l, t) => String(l).toLowerCase() === "alice" || cool0(rid, l, t); }, async () => { LC.cooling = cool0; }],
    ["the DF-11 notice gate", async () => MF._noticed(ROOM.id, "alice", null), async () => MF._noticed(ROOM.id, "alice", 1)],
  ];
  await knobs({ withheld_cover: true });
  await optout("alice", true);
  try {
    const shown = [];                                             // (every case is checked - a regression names each rule it broke)
    for (const [name, on, off] of CASES) {
      await reset(); await plainPad();
      await on();
      try {
        await step(["alice"]);
        for (let i = 0; i < 6; i++) { await at(3, ["alice"]); for (let k = 0; k < 3; k++) await settle(); }
        const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
        if (tileOn("alice") || v.src.some((s) => s.id === "alice")) shown.push(name);
      } finally { await off(); await settle(); }
      // lifted: the only thing that kept her off was that rule - now her card (the notice gate: notice_lead_s after the notice)
      if (name === "the DF-11 notice gate") T += 121 * 1000;
      for (let i = 0; i < 12 && !tileOn("alice"); i++) { await at(3, ["alice"]); for (let k = 0; k < 3; k++) await settle(); }
      assert.ok(tileOn("alice"), name + ": lifted - her card");
      assert.equal(tile("alice").why, "withheld", name);
    }
    assert.deepEqual(shown, [], "no tile, as today, in each of these (a naive early return at the live-cam check puts her card up): " + shown.join(", "));
  } finally { LC.cooling = cool0; await optout("alice", false); await knobs({ withheld_cover: false }); }
});

test("on: the DF-11 notice gate's one courtesy notice says !livecam off stops the CAM (cover picture instead), fits 300 characters with the link; off: today's text", async () => {
  const pm = async () => (await getQuery("SELECT args FROM pepe_actions WHERE kind = 'notify' ORDER BY id DESC LIMIT 1")).map((r) => JSON.parse(r.args)[1])[0];
  // (1.99?? privacy controls round 5: someone who has live cam off when they're told gets the _wh text - test "round 5: someone who
  // ALREADY keeps their cam off" below; this one is about everyone else: their cam can show, so the notice says how to stop it)
  const told = async (on, opt = true) => {
    await knobs({ withheld_cover: on });
    await reset(); await plainPad();
    await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
    await MF._noticed(ROOM.id, "dana", null);
    if (opt) await optout("dana", true);
    try {
      await step(["dana"]); await at(3, ["dana"]);
      for (let i = 0; i < 10; i++) await settle();
      assert.equal(tileOn("dana"), false, "not before the notice's lead time");
      return await pm();
    } finally { if (opt) await optout("dana", false); await MF._noticed(ROOM.id, "dana", 1); }
  };
  try {
    const off = await told(false);
    assert.ok(off == null, "switch off: a live-cam-off holder is never noticed (they never reach the stage) - " + off);
    const on = await told(true, false);
    assert.ok(on, "switch on: told once");
    assert.match(on, /Yours can show in ~2 min\. Cover picture instead: !livecam off https:\/\/publicaccess\.tv\/p\//);
    assert.ok(on.length <= 300, String(on.length));
    // the texts themselves: _wc only while on; the PM fits with the link for ordinary names, like today's
    const T0 = require(path.join(repo, "i18n")).tFor("en");
    for (const [room0, pad0, slug] of [["Players__Lounge", "Players Lounge", "players-lounge"], ["R".repeat(40), "P".repeat(40), "s".repeat(40)]]) {
      const s = MF.pmText(T0, "mf.notice.pm_once_wc", room0, pad0, 2, "https://publicaccess.tv/p/" + slug);
      assert.ok(s.length <= 300 && s.includes("!livecam off"), s);
      if (room0.length < 16) assert.match(s, /https:\/\/publicaccess\.tv\/p\//, "the link fits with ordinary names");
    }
    // (every locale i18n-sync gives the key keeps the opt-out within 300 characters - pmText sends English otherwise)
    const I18N = require(path.join(repo, "i18n")), dir = path.join(repo, "locales");
    for (const f of fs.readdirSync(dir).filter((x) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(x))) {
      if (typeof JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["mf.notice.pm_once_wc"] !== "string") continue;
      const s = MF.pmText(I18N.tFor(f.replace(/\.json$/, "")), "mf.notice.pm_once_wc", "R".repeat(60), "P".repeat(60), 2, "https://publicaccess.tv/p/" + "s".repeat(60), T0);
      assert.ok(s.length <= 300 && s.includes("!livecam off"), f);
    }
    assert.match(T0("mf.notice.once_body_wc", { room: "R", pad: "P", n: 2 }), /To stop your cam on every pad: Settings → Privacy, or !livecam off - mic stages then show you with your cover picture instead\.$/);
    assert.match(T0("mf.notice.once_body", { room: "R", pad: "P", n: 2 }), /To stop it on every pad: Settings → Privacy, or !livecam off\.$/, "today's body unchanged");
  } finally { await knobs({ withheld_cover: false }); }
});

// 1.99?? (privacy controls round 5, the round-4 review): with withheld_cover on, a cam opt-out passes the DF-11 notice gate, so they
// get the one courtesy notice - which said their cam can show and ended "Cover picture instead: !livecam off". Someone who ALREADY keeps
// their cam off mic stages gets wording that fits: the stage shows them with their cover picture, never their cam (_wh; one PM, one
// inbox row). Everyone else, and the switch off, as before
test("round 5: someone who ALREADY keeps their cam off mic stages (live cam off, the mic-stage switch off, followers, on request) is told the stage shows their cover picture, never their cam; everyone else as before", async () => {
  const pmOf = async () => (await getQuery("SELECT args FROM pepe_actions WHERE kind = 'notify' ORDER BY id DESC LIMIT 1")).map((r) => JSON.parse(r.args)[1])[0];
  const T0 = require(path.join(repo, "i18n")).tFor("en");
  const told = async (who, on, how) => {
    await knobs({ withheld_cover: on });
    await reset(); await plainPad();
    const set = { livecam: () => optout(who, true), mf: () => MF.setOptout(who, true), followers: () => CA.setMode(who, "followers"),
                  request: () => CA.setMode(who, "request"), none: async () => {} }[how];
    const unset = { livecam: () => optout(who, false), mf: () => MF.setOptout(who, false), followers: () => CA.setMode(who, "everyone"),
                    request: () => CA.setMode(who, "everyone"), none: async () => {} }[how];
    await set();
    await MF._idle(); for (let i = 0; i < 3; i++) await settle();      // (a recheck the switch started reads the notice rows first)
    await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
    await runQuery("DELETE FROM inbox WHERE kind = 'stage'");
    await MF._noticed(ROOM.id, who, null);
    try {
      await step([who]); await at(3, [who]);
      for (let i = 0; i < 10; i++) await settle();
      const ib = (await getQuery("SELECT title, body FROM inbox WHERE kind = 'stage' ORDER BY id DESC LIMIT 1"))[0] || null;
      return { pm: await pmOf(), ib };
    } finally { await unset(); await MF._noticed(ROOM.id, who, 1); }
  };
  const WH = /Other pads with mic follows do too\. Your cam stays off: you can show in ~2 min with your cover picture\. https:\/\/publicaccess\.tv\/p\//;
  try {
    for (const how of ["livecam", "mf", "followers", "request"]) {
      const r = await told("dana", true, how);
      assert.ok(r.pm, how + ": told once");
      assert.match(r.pm, WH, how + ": their cam stays off, the cover picture - with the link");
      assert.ok(!r.pm.includes("!livecam off") && !r.pm.includes("cam too") && !r.pm.includes("Yours can show") && r.pm.length <= 300, how + ": " + r.pm);
    }
    // a real account: the PM and ONE inbox row, with its own title and body
    const b = await told("bob", true, "livecam");
    assert.match(b.pm, WH, "bob's PM");
    assert.ok(b.ib, "bob's inbox row");
    assert.equal(b.ib.title, T0("mf.notice.once_title_wh", { pad: "S3 Room" }));
    assert.equal(b.ib.title, "🎙 Pads on PATV may show your cover picture while you hold the mic");
    assert.match(b.ib.body, /Your settings keep your cam off mic stages, so in about 2 minutes you can show there by name with your cover picture \(Settings → Stage cover\), or as a hooded frog while you're incognito - never your cam\. This is the only notice you'll get about it: if you change those settings, your cam can show too\.$/);
    assert.ok(!b.ib.body.includes("Your cam can show") && !b.ib.body.includes("!livecam off"), "never that their cam can show");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE kind = 'stage'"))[0].n, 1, "one inbox row");
    // nobody opted out, switch on: the _wc text (their cam can show; how to stop it); switch off: today's
    const n = await told("dana", true, "none");
    assert.match(n.pm, /Yours can show in ~2 min\. Cover picture instead: !livecam off/);
    const o = await told("dana", false, "none");
    assert.match(o.pm, /Yours can show in ~2 min\. Stop it everywhere: !livecam off/);
    const ob = await told("bob", false, "none");
    assert.equal(ob.ib.title, T0("mf.notice.once_title", { pad: "S3 Room" }), "switch off: today's title");
    // the PM fits 300 with the link for ordinary names; long names drop the link, never past 300, never an "!livecam off" tacked on
    for (const [room0, pad0, slug] of [["Players__Lounge", "Players Lounge", "players-lounge"], ["R".repeat(40), "P".repeat(40), "s".repeat(40)], ["R".repeat(60), "P".repeat(60), "s".repeat(60)]]) {
      const s = MF.pmText(T0, "mf.notice.pm_once_wh", room0, pad0, 2, "https://publicaccess.tv/p/" + slug);
      assert.ok(s.length <= 300 && !s.includes("!livecam off") && s.endsWith(slug.length < 16 ? "/p/" + slug : "cover picture."), s);
    }
    const I18N = require(path.join(repo, "i18n")), dir = path.join(repo, "locales");
    for (const f of fs.readdirSync(dir).filter((x) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(x))) {
      if (typeof JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["mf.notice.pm_once_wh"] !== "string") continue;
      const s = MF.pmText(I18N.tFor(f.replace(/\.json$/, "")), "mf.notice.pm_once_wh", "R".repeat(60), "P".repeat(60), 2, "https://publicaccess.tv/p/" + "s".repeat(60), T0);
      assert.ok(s.length <= 300, f);
    }
  } finally { await knobs({ withheld_cover: false }); }
});

// 1.99?? (privacy controls round 5): /privacy says "PATV administrators or staff using ghost mode" everywhere (round 4); Settings' cam-reveal
// sentences (cam_reveal on: lc.st_off_rv, lc.what_told_rv) match - ghost mode is locked to Staff and up (Admin and Staff, siteperms-core)
test("round 5: Settings' cam-reveal sentences name PATV administrators or staff as ghosts, never staff alone (as /privacy does)", async () => {
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.ok(EN["lc.st_off_rv"].includes("never who, unless they're PATV administrators or staff using ghost mode."), "lc.st_off_rv");
  assert.ok(EN["lc.what_told_rv"].includes("(never who), unless they're a PATV administrator or staff member using ghost mode."), "lc.what_told_rv");
  assert.deepEqual(Object.keys(EN).filter((k) => /staff in (👻 )?ghost mode/.test(EN[k])), [], "en.json: no sentence names only staff as ghosts");
  const pv = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8");
  assert.ok(!/staff in ghost mode/.test(pv) && (pv.match(/PATV administrators or staff using ghost mode/g) || []).length >= 4, "/privacy: administrators or staff (round 4)");
  const SPC = require(path.join(repo, "siteperms-core"));
  const g = SPC.CAPS.find((c) => c[0] === "ghost.mode");
  assert.ok(g && g[2] === "staff", "ghost.mode: Staff and up (" + JSON.stringify(g) + ")");
});

// ── veiled people never get the cover ──
test("on: incognito + live cam off is the PEEK hood under the frog name, !bridge hide the SHADOW hood - never their cover (coverOf never asked about them)", async () => {
  const SC = require(path.join(repo, "stagecover"));
  const asked = [], cov0 = SC.coverOf;
  SC.coverOf = (l) => { asked.push(String(l)); return cov0(l); };
  const REF1 = "anon-0a1b2c3d";
  await knobs({ withheld_cover: true, covers: true });
  await optout("erin", true);
  try {
    for (const veil of ["incognito", "hidden"]) {
      await reset(); await plainPad();
      MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s3" + veil, veil, alias: "Soggy Bullfrog", hood: 3, login: "erin", display: "Erin" } : null));
      asked.length = 0;
      const A = { anon: true, display: "someone", ref: REF1 };
      await step([A]); await at(3, [A]); await at(3, [A]);
      const c = P().state.tiles.find((x) => x.cover);
      assert.ok(c, veil + ": the hooded cover");
      assert.ok(!tileOn("erin"), veil + ": never her named card");
      const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
      const s = v.src.find((e) => e.kind === "cover");
      assert.deepEqual([s.veil, s.name, s.hood, s.avatar, s.ck], [veil, "Soggy Bullfrog", 3, undefined, undefined], veil + ": the " + (veil === "hidden" ? "shadow" : "peek") + " hood");
      assert.ok(!JSON.stringify(v).includes("erin") && !JSON.stringify(v).includes("/media/cover/"), veil + ": no login, no cover");
      assert.ok(!asked.includes("erin"), veil + ": coverOf never asked about her");
    }
  } finally { SC.coverOf = cov0; MF.setVeilSource(null); await optout("erin", false); await knobs({ withheld_cover: false, covers: false }); }
});

test("on: pins stay refused for a cam opt-out (a pin keys by the real cam)", async () => {
  await knobs({ withheld_cover: true });
  const pinIt = (login) => MF.pinPut({ userId: "u_owner", username: "padowner" }, ROOM.id, login, T).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, code: e.code }));
  try {
    await reset(); await plainPad();
    await optout("carl", true);
    await at(1, []);                                              // (a running stage: a fresh sync, Pepe's poll)
    assert.deepEqual(await pinIt("carl"), { ok: false, code: "opted_out" });
    await optout("carl", false);
    await CA.setMode("carl", "followers");
    await at(1, []);
    assert.deepEqual(await pinIt("carl"), { ok: false, code: "mode_closed" });
    await CA.setMode("carl", "everyone");
    await at(1, []);
    assert.equal((await pinIt("carl")).ok, true, "(the same pin with no cam opt-out: pinned - the refusals above are the opt-outs')");
    await MF.unpin(ROOM.id, "carl", "test", "test");
  } finally { await CA.setMode("carl", "everyone"); await knobs({ withheld_cover: false }); }
});

// ── captures ──
test("captures: a withheld card is drawn with its name and cover WITHOUT camRefusal, counts as a name card and stays postable (recheck, storykeep's card consent); switch off: camRefusal decides, as before", async () => {
  const SM = require(path.join(repo, "stagemiccap"));
  const { tileFor, defaults } = SM._test;
  let ON = true;
  const calls = [];
  const HID = new Set();
  SM.configure({
    withheldOn: () => ON,
    camRefusal: async (l, u) => { calls.push(l); return { code: "opted_out" }; },
    hidden: (l) => HID.has(l),
    privateLogins: async (ls) => new Set(ls.filter((l) => PRIV.has(String(l).toLowerCase()))),
    camBlocked: async (l, u) => l === "alice" && u === "u_v3",
    cover: async (u) => ({ buf: Buffer.from("<svg/>"), k: "gtf" }),
    exact: () => { throw new Error("never asked about a withheld cam's relay"); },
    camPath: () => { throw new Error("never its relay path"); },
    still: () => { throw new Error("never its still"); },
  });
  const E = { kind: "cam", id: "alice", name: "alice_patv", video: "card", why: "withheld", watch: "ok", avatar: "/media/cover/a/4242.0123456789abcdef0123.svg", pos: 0 };
  const RR = { id: ROOM.id };
  try {
    let t = await tileFor(E, RR, { userId: "u_v1" });
    assert.deepEqual([t.login, t.mode, t.name, t.withheld, !!(t.cover && t.cover.buf)], ["alice", "card", "alice_patv", true, true], "her name and cover");
    assert.deepEqual(calls, [], "camRefusal never asked");
    // still the name card's own rules: hidden, private, her cam blocks of this viewer
    HID.add("alice");
    assert.equal((await tileFor(E, RR, { userId: "u_v1" })).mode, "blank", "hidden: blank");
    HID.delete("alice"); PRIV.add("alice");
    assert.equal((await tileFor(E, RR, { userId: "u_v1" })).mode, "blank", "private: blank");
    PRIV.delete("alice");
    assert.equal((await tileFor(E, RR, { userId: "u_v3" })).mode, "blank", "she blocked this viewer from her cam: blank");
    // the recheck before a save / post: a name card asks cardConsent (postable); a cam drawn still asks the cam's rules
    assert.equal(await SM.cardConsent("alice", "u_v1"), true);
    assert.equal(await SM.consent("alice", "u_v1"), false, "a cam drawn: her live cam off refuses it, as before");
    assert.deepEqual(calls, ["alice"]);
    // the switch off: the program never says withheld - and if it did, camRefusal decides (blank), and a name card asks consent()
    ON = false; calls.length = 0;
    t = await tileFor(E, RR, { userId: "u_v1" });
    assert.equal(t.mode, "blank", "off: camRefusal refuses - blank, as before");
    assert.deepEqual(calls, ["alice"], "off: camRefusal asked");
    assert.equal(await SM.cardConsent("alice", "u_v1"), false, "off: cardConsent = consent");
  } finally { SM.configure(defaults); }
});

test("captures end to end: the capture program of a withheld tile -> its card in the frame, in `cards`, the recheck passes", async () => {
  const SM = require(path.join(repo, "stagemiccap"));
  const { tilesFor, defaults } = SM._test;
  await knobs({ withheld_cover: true });
  await optout("alice", true);
  try {
    await reset(); await plainPad();
    await step(["alice"]); await at(3, ["alice"]); await at(3, ["alice"]);
    assert.equal(tile("alice").why, "withheld", "set up");
    const prog = await bridge.stageProgramFor(ROOM.id, "u_v1");
    const e = prog.src.find((s) => s.id === "alice");
    assert.deepEqual([e.video, e.why, e.watch], ["card", "withheld", "ok"], "the capture surface");
    let refusals = 0;
    SM.configure({ camRefusal: async (l, u, o) => { refusals++; return defaults.camRefusal(l, u, o); },
                   privateLogins: async (ls) => new Set(ls.map((l) => String(l).toLowerCase()).filter((l) => PRIV.has(l))) });
    const ts = await tilesFor(prog, { id: ROOM.id }, { userId: "u_v1" }, { covers: false });
    const a = ts.find((x) => x.id === "alice");
    assert.deepEqual([a.login, a.mode, a.withheld], ["alice", "card", true]);
    assert.equal(refusals, 0, "camRefusal never asked");
    // the recheck: people [] + cards [alice] -> postable while she keeps live cam off
    SM.configure({ account: async () => ({ userId: "u_v1" }), resolveRoom: async () => ({ id: ROOM.id }), config: () => ({ stagecap_mic: true }), killed: () => null,
                   roomOff: () => null, eligibility: () => null, bridgeOk: () => true, full: async () => true, block: async () => null, clipSwitch: () => true,
                   people: async () => [], cards: async () => ["alice"], veiledPeople: async () => [] });
    assert.equal(await SM.recheck({ id: "c" + "0".repeat(20), user_id: "u_v1", room_id: ROOM.id, kind: "snap" }), null, "postable");
    PRIV.add("alice");
    assert.ok(await SM.recheck({ id: "c" + "0".repeat(20), user_id: "u_v1", room_id: ROOM.id, kind: "snap" }), "...not once she keeps her activity private");
    PRIV.delete("alice");
  } finally { SM.configure(defaults); await optout("alice", false); await knobs({ withheld_cover: false }); }
});

test("storykeep: a name card (role card) asks stagemiccap.cardConsent - a withheld card stays keepable; a cam drawn asks consent", async () => {
  const keep = require(path.join(repo, "storykeep"));
  const SM = require(path.join(repo, "stagemiccap"));
  const c0 = SM.consent, cc0 = SM.cardConsent, SR = require(path.join(repo, "storyreact")), lb0 = SR.loginsBlocked;
  const asked = [];
  SM.consent = async (l) => { asked.push("consent:" + l); return false; };
  SM.cardConsent = async (l) => { asked.push("card:" + l); return true; };
  SR.loginsBlocked = async () => new Set();
  try {
    const why = await keep._micPeopleWhy({ people: [{ login: "alice", role: "card" }], capturedAt: 0 }, ["u_v1"], new Map(), { owners: false });
    assert.equal(why, null, "a name card: keepable");
    assert.deepEqual(asked, ["card:alice"]);
    asked.length = 0;
    assert.equal(await keep._micPeopleWhy({ people: [{ login: "alice", role: "cam" }], capturedAt: 0 }, ["u_v1"], new Map(), { owners: false }), "person", "a cam: consent");
    assert.deepEqual(asked, ["consent:alice"]);
  } finally { SM.consent = c0; SM.cardConsent = cc0; SR.loginsBlocked = lb0; }
});

// ── Settings ──
test("Settings: the mic-stage switch's hint and the unlinked note say 'cover picture instead' only while on; off = the page as the build before", async () => {
  const ejs = require("ejs");
  const file = path.join(repo, "views", "privacy-settings.ejs");
  const render = (src, locals) => ejs.render(src, locals, { filename: file });
  const L = (extra) => Object.assign({ user: "bob", st: { linked: true, login: "bob123", account: false, on: false, updated: null, reported: null, waiting: null, failed: null, log: [] },
                                       lc: { linked: true, login: "bob123", off: false }, oa: null, gh: null, pf: null, slChat: false, slOk: false, mf: null, micrecOn: false,
                                       mem: null, pwOn: true, ogBase: "http://test" }, extra || {});
  const mfL = (wc) => ({ linked: true, login: "bob123", auto: true, spans: [], ...(wc ? { wc: true } : {}) });
  const now = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const on = render(now, L({ mf: mfL(true) }));
  assert.ok(on.includes("Off keeps ▶ Live, but mic stages show your cover picture instead of your cam."), "on: the hint");
  const onU = render(now, L({ lc: { linked: false }, mf: { linked: false, login: null, auto: true, spans: [], wc: true } }));
  assert.ok(onU.includes("!livecam off in Camfrog stops all live video of your cam; mic stages show your cover picture instead."), "on: the unlinked note");
  // MF.privacyState says wc only while on
  assert.equal((await MF.privacyState("u_alice")).wc, undefined);
  await knobs({ withheld_cover: true });
  try { assert.equal((await MF.privacyState("u_alice")).wc, true); assert.equal((await MF.privacyState("u_v2")).wc, true, "unlinked too"); }
  finally { await knobs({ withheld_cover: false }); }
  // off: byte for byte the build before
  let baseSrc = null;
  try { baseSrc = execFileSync("git", ["-C", repo, "show", `${BASE}:views/privacy-settings.ejs`], { encoding: "utf8" }); } catch (e) { baseSrc = null; }
  if (!baseSrc) return;
  baseSrc = baseSrc.replace(/\r\n/g, "\n");
  for (const extra of [{ mf: mfL(false) }, { lc: { linked: false }, mf: { linked: false, login: null, auto: true, spans: [] } }, {}]) {
    assert.equal(render(now, L(extra)), render(baseSrc, L(extra)), "same HTML: " + JSON.stringify(extra));
  }
});

// 1.99?? (privacy controls round 5, spec 6.1 / 6.2 / 6.4): the cover picture in the Settings Live cam card, the /privacy livecam sentence
// and Pepe's !livecam help card (as /help shows it) - only while withheld_cover is on (privacycopy wcover); and the ghosts in Settings'
// cam-reveal sentences are PATV administrators or staff (ghost mode is locked to Staff and up), as /privacy says. Off: byte for byte the
// round-4 head (608655e9)
const BASE5 = process.env.PRIVM_R5_BASE_REV || "608655e9";
test("round 5: the cover picture in Settings' Live cam card, /privacy's livecam sentence and the !livecam card only while withheld_cover is on; the ghosts are administrators or staff; off = the round-4 head", async () => {
  const ejs = require("ejs");
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const show = (git) => { try { return execFileSync("git", ["-C", repo, "show", `${BASE5}:${git}`], { encoding: "utf8" }).replace(/\r\n/g, "\n"); } catch (e) { return null; } };
  // ── Settings → Privacy, the Live cam card ──
  const sfile = path.join(repo, "views", "privacy-settings.ejs");
  const srender = (src, locals) => ejs.render(src, locals, { filename: sfile });
  const L = (extra) => Object.assign({ user: "bob", st: { linked: true, login: "bob123", account: false, on: false, updated: null, reported: null, waiting: null, failed: null, log: [] },
                                       lc: { linked: true, login: "bob123", off: true }, oa: null, gh: null, pf: null, slChat: false, slOk: false, mf: null, micrecOn: false,
                                       mem: null, pwOn: true, ogBase: "http://test" }, extra || {});
  const mfL = (wc) => ({ linked: true, login: "bob123", auto: true, spans: [], ...(wc ? { wc: true } : {}) });
  const snow = fs.readFileSync(sfile, "utf8").replace(/\r\n/g, "\n");
  const ov = (k) => "I.s['js.lc.st_off'] = " + JSON.stringify(EN[k]);
  for (const [extra, key] of [[{ mf: mfL(true) }, "lc.st_off_wc"], [{ mf: mfL(true), crvOn: true }, "lc.st_off_rv_wc"], [{ mf: mfL(false), crvOn: true }, "lc.st_off_rv"],
                              [{ mf: mfL(false) }, "lc.st_off"]]) {
    const h = srender(snow, L(extra));
    assert.ok(h.includes(EN[key].replace(/'/g, "&#39;")) || h.includes(EN[key]), JSON.stringify(extra) + ": " + key);
    assert.equal(h.includes(ov(key)), key !== "lc.st_off", JSON.stringify(extra) + ": the client's OFF line follows (" + key + ")");
    for (const k of ["lc.st_off", "lc.st_off_wc", "lc.st_off_rv", "lc.st_off_rv_wc"].filter((x) => x !== key)) assert.ok(!h.includes(EN[k]), JSON.stringify(extra) + ": not " + k);
  }
  assert.ok(srender(snow, L({ lc: { linked: true, login: "bob123", off: false }, mf: mfL(true) })).includes(ov("lc.st_off_wc")),
            "on, the cam on now: switching it off in the page says the cover picture too");
  for (const k of ["lc.st_off_wc", "lc.st_off_rv_wc"]) assert.ok(EN[k].includes("pads' mic stages show your cover picture instead"), k);
  assert.equal(EN["lc.st_off_wc"], EN["lc.st_off"].replace("snapshots or clips.", "snapshots or clips; pads' mic stages show your cover picture instead."), "lc.st_off_wc = lc.st_off + the cover");
  assert.equal(EN["lc.st_off_rv_wc"], EN["lc.st_off_rv"].replace("snapshots or clips.", "snapshots or clips; pads' mic stages show your cover picture instead."), "lc.st_off_rv_wc = lc.st_off_rv + the cover");
  const sbase = show("views/privacy-settings.ejs");
  if (sbase) {
    for (const extra of [{}, { mf: mfL(false) }, { crvOn: true }, { mf: mfL(false), crvOn: true }, { lc: { linked: true, login: "bob123", off: false }, mf: mfL(false) },
                         { lc: { linked: false }, mf: { linked: false, login: null, auto: true, spans: [] } }]) {
      assert.equal(srender(snow, L(extra)), srender(sbase, L(extra)), "Settings, same HTML as " + BASE5 + ": " + JSON.stringify(extra));
    }
  }
  // ── /privacy, the Live cams sentence ──
  const pfile = path.join(repo, "views", "privacy.ejs");
  const pnow = fs.readFileSync(pfile, "utf8").replace(/\r\n/g, "\n");
  const L0 = { user: null, title: "Privacy Policy", VERSION: "x", UPDATED: "1 November 2026", enforced: false, chatlog: null, hubErasure: null, micrec: null,
               memory: null, privwire: null, evidence: null, policyDates: {}, ogBase: "http://test" };
  const prender = (src, v) => ejs.render(src, Object.assign({}, L0, v), { filename: pfile });
  const IC1 = { on: true, on_at: null, on_day: null };
  const SENT = "keep your cam off the website: pads' mic stages show your cover picture (or a hooded frog) instead.";
  for (const ic of [null, IC1]) {
    const on = prender(pnow, { incogcam: ic, wcover: { on: true } }), off = prender(pnow, { incogcam: ic, wcover: null });
    assert.ok(on.includes(SENT), (ic ? "incognito cams" : "plain") + ": the cover sentence");
    assert.ok(!off.includes("cover picture (or a hooded frog)") && off.includes("keep your cam off the website."), (ic ? "incognito cams" : "plain") + ": off - today's sentence");
  }
  const pbase = show("views/privacy.ejs");
  if (pbase) for (const v of [{}, { incogcam: IC1 }, { wcover: null }, { wcover: undefined, incogcam: IC1 }]) assert.equal(prender(pnow, v), prender(pbase, v), "/privacy, same page as " + BASE5 + ": " + JSON.stringify(v));
  // ── the copy flags and Pepe's !livecam card on /help ──
  const PCm = require(path.join(repo, "privacycopy")), HELP = require(path.join(repo, "help"));
  await knobs({ withheld_cover: false });
  assert.equal((await PCm.load()).wcover, null, "off: no copy");
  assert.equal(PCm.flags().wcover, false);
  const card = { id: "livecam", summary: "S", details: "Can you see it? it also keeps your cam off pads' automatic mic stages (a pad can show whoever holds the mic on its own stage). Yes.",
                 pc: { wcover: { swap: [["it also keeps your cam off pads' automatic mic stages (a pad can show whoever holds the mic on its own stage).", "COVER."]] } } };
  assert.equal(HELP.withPrivacyCopy([card])[0], card, "off: the very same card");
  await knobs({ withheld_cover: true });
  try {
    assert.deepEqual((await PCm.load()).wcover, { on: true, on_at: null, on_day: null }, "on: the copy (/privacy reads it)");
    assert.equal(PCm.flags().wcover, true);
    assert.equal(HELP.withPrivacyCopy([card])[0].details, "Can you see it? COVER. Yes.", "on: the wcover slice is made");
    const bot = process.env.PEPE_BOT_DIR;
    if (bot && fs.existsSync(path.join(bot, "help", "help-data.json"))) {
      const data = JSON.parse(fs.readFileSync(path.join(bot, "help", "help-data.json"), "utf8"));
      const lc = data.entries.find((e) => e.id === "livecam");
      assert.ok(lc && lc.pc && lc.pc.wcover, "Pepe's !livecam card carries the wcover slice");
      const got = HELP.withPrivacyCopy([lc])[0];
      assert.ok(got.details.includes("you show with your cover picture instead - a hooded frog if you're incognito - never your cam"), "/help: the !livecam card says the cover picture");
      assert.ok(!got.details.includes("it also keeps your cam off pads' automatic mic stages"), "...instead of the old clause");
    }
  } finally { await knobs({ withheld_cover: false }); }
});

// ── the engine (pure) ──
test("core: 'withheld' is a card state - a candidate and a tile, attributed in speaking(), never a hold / still / warm keep; a running relay or still is let go; opted_out from livecam is the card while cfg withheld_cover is on, a cut while off", () => {
  const C = { ...core.DEFAULTS, cold_open: true, enabled: true, stills: true, warm_keep_s: 180, warm_max: 3 };
  const PAD = { layout: "auto", max_people: 4, max_live: 4, default_view: "first", keep_recent: 0 };
  const t0 = 1e12;
  const S = core.newState();
  const I = (elig, holders, sess) => ({ why_off: null, holders: holders.map((login) => ({ login, since: t0 })), unproven_n: 0, elig: new Map(Object.entries(elig)),
                                        sess: new Map(Object.entries(sess || {})), pad: PAD, room: { cams: true, listAt: null, listFresh: null },
                                        site: { maxLive: 4, coldLeft: 9, stillsLeft: 4, poolLeft: 9 } });
  let A = [];
  for (let s = 0; s <= 4; s++) A.push(...core.step(S, I({ a: "withheld" }, ["a"]), C, t0 + s * 1000).actions);
  const x = core.tileOf(S, "a");
  assert.ok(x, "a tile");
  assert.deepEqual([x.video, x.why], ["card", "withheld"]);
  assert.ok(!A.some((a) => a.a === "hold" || a.a === "still" || a.a === "keep"), "never a hold, a still or a keep: " + JSON.stringify(A.map((a) => a.a)));
  assert.equal(core.speaking(S, I({ a: "withheld" }, ["a"]), C, t0 + 5000), null, "attributed - not 'someone'");
  assert.equal(core.speaking(S, I({ a: "opted_out" }, ["a"]), C, t0 + 5000), "someone", "(a CUT code is 'someone', as today)");
  assert.ok(core.CARD_WHYS.includes("withheld"));
  // a tile that was live: the relay is let go at once
  const S2 = core.newState();
  for (let s = 0; s <= 3; s++) core.step(S2, I({ b: "ok" }, ["b"]), C, t0 + s * 1000);
  core.holdDone(S2, "b", true, null, C, t0 + 3500);
  core.step(S2, I({ b: "ok" }, ["b"], { b: { state: "live", held: true, exact: true } }), C, t0 + 4000);
  assert.equal(core.tileOf(S2, "b").video, "live", "set up");
  A = core.step(S2, I({ b: "withheld" }, ["b"], { b: { state: "live", held: true, exact: true } }), C, t0 + 5000).actions;
  assert.ok(A.some((a) => a.a === "release" && a.login === "b"), "the relay let go");
  assert.deepEqual([core.tileOf(S2, "b").video, core.tileOf(S2, "b").why], ["card", "withheld"]);
  assert.equal(core.keepFor(S2, I({ b: "withheld" }, ["b"]), C, t0 + 6000, core.tileOf(S2, "b")), 0, "never kept warm");
  // livecam's "opted_out": the card while on, a cut while off
  const S3 = core.newState();
  for (let s = 0; s <= 3; s++) core.step(S3, I({ c: "ok" }, ["c"]), C, t0 + s * 1000);
  const r1 = core.sessionEnded(S3, "c", "opted_out", { ...C, withheld_cover: true }, t0 + 4000);
  assert.equal(r1.cut, null, "on: no cut");
  assert.deepEqual([core.tileOf(S3, "c").video, core.tileOf(S3, "c").why], ["card", "withheld"]);
  const r2 = core.sessionEnded(S3, "c", "opted_out", { ...C, withheld_cover: false }, t0 + 4500);
  assert.equal(r2.cut, "opted_out", "off: today's cut");
  assert.equal(core.tileOf(S3, "c"), null);
});

}
