// 🎙 mic follows on a pad's own stage (micfollow.js + bridge.js / livecam.js / mainstage.js / bridge-relay.js / camaccess.js /
// profilelayout.js wiring), on a temp DB: only proven holders; never act on R.mic from before a restart; every consent cut
// takes the tile off at once and lets go of the relay; opt-outs (website, !livecam off, the mic-stage switch) cut in the
// same call; never a followers / on-request cam; the per-viewer gates; one shared relay with a manual cam slot; warm vs
// cold, relays_max, exact === false; quiet stills; yielding to a manual slot; a ✂ Cut / stage ban keeps them off; notices;
// the appearance log; the kill switch / pad off / why_off; Pepe's poll; and nothing of it in any public egress.
//   node --test test/micfollow.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "micfollow-test-"));
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

W.enabled = () => true;
let T = Date.now();
LC._setClock(() => T);
stage._setClock(() => T);
MF._setClock(() => T);
MF._setBoot(0);
LC._setKick(() => {});
let padFullOk = true;
relay.padFull = async () => padFullOk;
let PRIV = new Set();
stories.privateLogins = async (ls) => new Set(ls.map((l) => String(l).toLowerCase()).filter((l) => PRIV.has(l)));
let primeOk = true;
premium.bridgeAllowed = () => primeOk;
const noted = [];
CV.noteViewers = (kind, room, owner, ids) => { noted.push([kind, owner, ...ids]); return Promise.resolve(0); };

const ROOM = { id: "Mic.Room", name: "Mic Room" };
const ADMIN = { userId: "u_admin", username: "admin", class: "Admin" };
const STAFF = { userId: "u_staff", username: "staffer", class: "Staff" };
let R = null;
const MEMBERS = () => [
  { login: "alice", display: "Alice W", on_cam: true }, { login: "bob", display: "Bob", on_cam: true }, { login: "carl", display: "Carl", on_cam: true },
  { login: "dana", display: "Dana", on_cam: true }, { login: "erin", display: "Erin", on_cam: false }, { login: "fay", display: "Fay", on_cam: true },
  { anon: true, display: "someone", on_cam: true }, { login: "pepe", display: "Pepe", self: true, on_cam: true }];
/** The room as Pepe's latest sync left it (fresh), with these PROVEN mic holders (grab order). */
function room(holders, extra) {
  R = bridge._rooms.get(ROOM.id);
  const mic = (holders || []).map((h) => (typeof h === "string" ? { login: h, display: h, proven: true } : h));
  Object.assign(R, { updated: T, cams: true, livecams: true, members: MEMBERS(), mic }, extra || {});
  return R;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
/** Wait (real time, at most `ms`; the test clock T stands still) until `fn()` - for a fire-and-forget hook to land. */
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (!fn() && Date.now() < end) await settle(); }
/** One engine step on Pepe's latest sync; waits for the async bits (fact look-ups, relay holds). */
async function step(holders, extra) {
  room(holders, extra); MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle();
  room(holders, extra); MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle();
  return MF._pads.get(ROOM.id).state;
}
const tiles = () => MF._pads.get(ROOM.id).state.tiles.map((x) => x.login);
const tile = (l) => MF._pads.get(ROOM.id).state.tiles.find((x) => x.login === l) || null;
const EXACT = new Set();      // cams Pepe reports as opened / verified by their exact name (live[].exact)
const bot = (extra) => LC.forBot(Object.assign({ cap: true, mf: 1,
  live: [...EXACT].filter((l) => LC._sessions.has(LC.keyOf(ROOM.id, l))).map((l) => ({ room: ROOM.id, login: l, state: "live", exact: true })) }, extra || {}), T);
/** MediaMTX says these cams' relays are up (and Pepe, on his next poll, that he opened them by their exact name). */
function up(...logins) { LC.noteSync(logins.map((l) => ({ name: LC.pathFor(ROOM.id, l), ready: true, readers: [] })), T); for (const l of logins) EXACT.add(l); }
async function at(sec, holders, extra) { T += sec * 1000; await bot(); return step(holders, extra); }
/** Bring `logins` onto the stage (held >= 2 s) with live relays; returns after the change budget allows it. */
async function onStage(logins) {
  await step(logins);
  await at(3, logins);
  up(...logins);
  await at(1, logins);
}
async function reset() {
  for (const P of MF._pads.values()) { P.state = require(path.join(repo, "micfollow-core")).newState(); P.stills.clear(); P.spans.clear(); }
  for (const S of [...LC._sessions.values()]) LC._sessions.delete(S.key);
  EXACT.clear();
  T += 10 * 60 * 1000;
  PRIV = new Set();
  for (const l of ["alice", "bob", "carl", "dana", "erin", "fay"]) await MF.unexclude(ROOM.id, l);   // a ✂ Cut in one test doesn't leak into the next
  for (const e of (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded) if (e.xid) await MF.unexcludeXid(ROOM.id, e.xid);   // (wave2 WP-4: veiled ones too)
  await bot();
}

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["u_admin", "admin", "Admin", null], ["u_staff", "staffer", "Staff", null], ["u_owner", "padowner", "pleb", null],
                                     ["u_alice", "alice_patv", "pleb", "alice"], ["u_bob", "bob_patv", "pleb", "bob"], ["u_v1", "viewer1", "pleb", "viewer1"],
                                     ["u_v2", "viewer2", "pleb", null], ["u_v3", "viewer3", "pleb", "viewer3"], ["u_fay", "fay_patv", "pleb", "fay"],
                                     ["pepe-bot", "Pepe", "Bot", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await require(path.join(repo, "inbox")).ready;
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "alice", login: "alice", display: "Alice W" }], count: 1, cams: true, livecams: true,
                                  mic: [{ id: "alice", login: "alice", display: "Alice W", proven: true, since: Date.now() / 1000 - 3 }, { id: "bob", login: "bob", proven: "yes" },
                                        { anonymous: true, id: "anon-1", display: "someone" }, { id: "pepe", login: "pepe", is_self: true, proven: true }] }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await rooms.setOwner(ROOM.id, "padowner", "test");
  await stage.init();
  await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true } });
  await CA.init();
  await MF._ready();
  // DF-11: everyone in these tests had the pad's first notice long ago (the notice-first gate has its own tests, r4)
  for (const l of ["alice", "bob", "carl", "dana", "erin", "fay"]) await MF._noticed(ROOM.id, l, 1);
  await rooms.setStage(ROOM.id, { slot_count: 2 }, "test", { maxSlots: 4, maxPrice: 1000, maxMinutes: 360 });
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
const slug = () => R.slug;

test("1. cleanMic keeps proven / since; unproven, anonymous, Pepe, bots and account keys are never staged", async () => {
  const B = bridge._rooms.get(ROOM.id);
  assert.equal(B.mic[0].proven, true);
  assert.ok(Math.abs(B.mic[0].since - (Date.now() - 3000)) < 2000, "since in ms");
  assert.equal(B.mic[1].proven, undefined, "proven must be exactly true");
  assert.equal(B.mic[3].proven, undefined, "Pepe himself is never proven");
  const now = Date.now();
  assert.equal(bridge.cleanMic({ login: "x", since: now / 1000 - 99999 }, now).since, now - 6 * 3600 * 1000, "clamped");
  // the page never sees them
  const v = await bridge.liveView(B, 0, null, null, null, true, {});
  assert.ok(v.mic.every((u) => u.proven === undefined && u.since === undefined));
  assert.equal(v.stage_program, undefined, "only the pad page's own /live asks for the program");
  // the engine: nothing but proven, real logins
  await MF.setKill(STAFF, true, "test");
  await MF.setCfg(ADMIN, { cold_open: true, reason: "test" });
  // (mfix: the original tests run without recent speakers - keep_recent 0; the mfix tests at the end cover them)
  await MF.setPad(ROOM.id, { on: true, keep_recent: 0 }, "test");
  await bot();
  await step([{ login: "alice", proven: false }, { anon: true, display: "someone" }, { login: "pepe", self: true, proven: true }, { login: "bob", bot: true, proven: true },
              { login: "u:abcdef12", acct: true, proven: true }]);
  await at(5, [{ login: "alice", proven: false }]);
  assert.deepEqual(tiles(), []);
  assert.equal(MF._pads.get(ROOM.id).state.unproven, 1);
});

test("2. R.mic reloaded from the DB after a restart is never acted on", async () => {
  await reset();
  MF._setBoot(T + 3600e3);                  // every sync "predates" the site's start
  await step(["alice"]); await at(3, ["alice"]);
  assert.deepEqual(tiles(), []);
  assert.equal(MF._pads.get(ROOM.id).state.whyOff, "stale");
  MF._setBoot(0);
  await at(1, ["alice"]); await at(3, ["alice"]);
  assert.deepEqual(tiles(), ["alice"]);
});

test("3-5. every CUT code takes the tile off at once (no card) and lets go of the relay; opt-outs cut in the same call", async () => {
  await reset();
  const kicked = [];
  LC._setKick((id) => kicked.push(id));
  const cuts = [
    ["opted_out (website switch)", async () => { await LC.setOptout("alice", true, { ts: T }); }, async () => { await LC.setOptout("alice", false, { ts: T + 1 }); }],
    ["mf_opted_out", async () => { await MF.setOptout("alice", true); }, async () => { await MF.setOptout("alice", false); }],
    ["private", async () => { PRIV.add("alice"); await MF.recheck("alice", { refresh: true }); }, async () => { PRIV.delete("alice"); await MF.recheck("alice", { refresh: true }); }],
    ["excluded", async () => { await MF.excludeFor(ROOM.id, "alice", 60, "owner", "test"); }, async () => { await MF.unexclude(ROOM.id, "alice"); }],
    // the ban hook (mainstage -> micfollow.recheckUser) is fire-and-forget: wait (real time, the test clock stands still) for it
    // to land - under a loaded full-suite run its look-ups outlast two 5 ms settles (train2 site)
    ["banned", async () => { await stage.ban("alice_patv", "test", "admin"); await until(() => !tiles().includes("alice")); },
               async () => { await stage.unban("u_alice", "admin"); await settle(); await settle(); }],
    ["mode_closed", async () => { await CA.setMode("alice", "request"); }, async () => { await CA.setMode("alice", "everyone"); }],
    ["!livecam off (Pepe's poll)", async () => { await LC.forBot({ cap: true, mf: 1, optout_events: [{ login: "alice", off: true, ts: T + 5 }] }, T); },
                                    async () => { await LC.forBot({ cap: true, mf: 1, optout_events: [{ login: "alice", off: false, ts: T + 6 }] }, T); }],
  ];
  for (const [name, cut, undo] of cuts) {
    await reset();
    await onStage(["alice", "bob"]);
    assert.deepEqual(tiles().sort(), ["alice", "bob"], name + ": set up");
    const sess = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.ok(sess && sess.holds.has("mf:" + ROOM.id), name + ": held");
    const w = await LC.stageWatch({ userId: "u_v1" }, R, "mf:" + ROOM.id, { login: "alice" }, T);
    assert.ok(w.whep);
    // train2 site: the undo runs in a finally - a failed assert used to leave the cut (a stage ban ...) on for every later test
    try {
      await cut();
      await settle();
      assert.deepEqual(tiles(), ["bob"], name + ": off at once");
      const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
      assert.ok(!S || S.ended || !S.holds.has("mf:" + ROOM.id), name + ": the relay is let go");
      assert.ok(!S || S.ended || !S.stageViewers.has("u_v1"), name + ": its mic-stage viewer is dropped");
    } finally {
      await undo();
      await settle();
    }
  }
  // not_member: they left (or went hidden - Pepe lists them as "someone"): no hand-over card
  await reset();
  await onStage(["alice", "bob"]);
  room(["bob"], { members: MEMBERS().filter((m) => m.login !== "alice") });
  MF.stepPad(ROOM.id, T);
  assert.deepEqual(tiles(), ["bob"]);
  LC._setKick(() => {});
});

test("6. a followers / on-request cam is never held (no want entry ever appears)", async () => {
  await reset();
  await CA.setMode("carl", "followers");
  await step(["carl"]); await at(3, ["carl"]); await at(6, ["carl"]);
  assert.deepEqual(tiles(), []);
  assert.ok(!(await bot()).want.some((w) => w.login === "carl"));
  await CA.setMode("carl", "everyone");
});

test("7. per-viewer gates: signed out, bridge block, blocked by the cam's owner, members mode, pad access, the 💎 bridge perk", async () => {
  await reset();
  await CA.setMode("alice", "members");
  await onStage(["alice"]);
  const snap = () => MF.snapshot(ROOM.id);
  const out = await MF.viewFor(snap(), R, null, null);
  assert.equal(out.signin, true);
  assert.deepEqual(out.src, []);
  assert.equal(out.count, 1);
  assert.equal(out.manage, null);
  const v1 = await MF.viewFor(snap(), R, "u_v1", null);
  assert.equal(v1.src[0].watch, "ok", "a linked member");
  assert.equal(v1.src[0].video, "live");
  assert.equal(v1.src[0].newest, true);
  const v2 = await MF.viewFor(snap(), R, "u_v2", null);
  assert.equal(v2.src[0].watch, "members_only", "unlinked + unverified");
  let r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v2");
  assert.equal(r.status, 403); assert.equal(r.d.code, "members_only");
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1");
  assert.equal(r.status, 200); assert.ok(r.d.whep);
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice", beat: true }, "u_v1");
  assert.equal(r.d.ok, true);
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, null);
  assert.equal(r.status, 401);
  // the cam's owner blocks v3
  await CV.block("alice", "viewer3");
  assert.equal((await MF.viewFor(snap(), R, "u_v3", null)).src[0].watch, "unavailable");
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v3");
  assert.equal(r.d.code, "unavailable");
  // a bridge block on live cams for v1 in this room
  const BB = require(path.join(repo, "bridgeblocks"));
  const realRefusal = BB.refusal;
  BB.refusal = async (roomId, uid, f) => (uid === "u_v1" && (f === "livecams" || f === "all") ? "blocked here" : null);
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1");
  assert.equal(r.d.code, "blocked");
  BB.refusal = realRefusal;
  // no pad access / no bridge perk
  padFullOk = false;
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1")).d.code, "pad_access");
  padFullOk = true;
  primeOk = false;
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1")).d.code, "prime");
  primeOk = true;
  // a cam that isn't on the mic stage
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "bob" }, "u_v1");
  assert.equal(r.d.state, "ended");
  // the pad's owner sees the managers' bits
  const own = await MF.viewFor(snap(), R, "u_owner", null);
  assert.ok(own.manage && own.why_off === null);
  await CA.setMode("alice", "everyone");
});

test("8-9. a manual cam slot and the mic stage share ONE relay; mic-only viewers aren't noted; the slot's viewers are", async () => {
  await reset();
  await onStage(["alice"]);
  const { slot } = await stage.camOpen(ADMIN, { room: ROOM.id, login: "alice" });
  const w = (await bot()).want.filter((x) => x.login === "alice");
  assert.equal(w.length, 1, "Pepe's want list has one entry");
  assert.equal(w[0].mf, true);
  noted.length = 0;
  const a = await LC.stageWatch({ userId: "u_v1" }, R, "mf:" + ROOM.id, { login: "alice" }, T);
  const b = await LC.stageWatch({ userId: "u_v2" }, R, slot.id, {}, T);
  const pt = (x) => new URL(x.whep).searchParams.get("pt");
  const p = new URL(a.whep).pathname.split("/").pop();
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(pt(a)) }, "read", "webrtc"), 200);
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(pt(b)) }, "read", "webrtc"), 200);
  assert.deepEqual(noted.map((n) => n[2]), ["u_v2"], "only the slot's viewer is noted one by one");
  // u_v1 came only through the mic stage (not noted); watching the same cam through the slot now, they ARE noted (1.99yq)
  const a2 = await LC.stageWatch({ userId: "u_v1" }, R, slot.id, {}, T);
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(pt(a2)) }, "read", "webrtc"), 200);
  assert.deepEqual(noted.map((n) => n[2]), ["u_v2", "u_v1"], "a slot viewer is always noted, whatever they watched before");
  await stage.end(slot.id, "cut", "admin");
});

test("10. relays_max + cold_open: only warm relays when cold opens are off; exact === false is never reused", async () => {
  await reset();
  await MF.setCfg(ADMIN, { cold_open: false });
  await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "dana", T);     // dana's relay is up for someone's ▶ Live
  up("dana");
  await step(["dana", "fay"]); await at(3, ["dana", "fay"]); await at(1, ["dana", "fay"]);
  assert.equal(tile("dana").video, "live", "warm: reused");
  assert.equal(tile("fay").video, "card", "cold: not opened");
  assert.equal(tile("fay").why, "cold_off", "mfix: the card says cold opens are off - not 'live cams are full'");
  // exact === false: a ▶ Live relay opened by Pepe's older, fuzzy name match (could be "Bob" for "Bobby"). It's held (so
  // Pepe checks it: want[].mf), never shown - "starting", no ticket - and given up when he can't confirm it
  await reset();
  await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "dana", T);
  up("dana"); EXACT.delete("dana");
  await bot({ live: [{ room: ROOM.id, login: "dana", state: "live", exact: false }] });
  await step(["dana"]); await at(3, ["dana"]); await at(1, ["dana"]);
  assert.equal(tile("dana").video, "starting", "held for Pepe's exact check, not shown");
  assert.ok((await bot({ live: [{ room: ROOM.id, login: "dana", state: "live", exact: false }] })).want.find((w) => w.login === "dana").mf, "Pepe is asked to check it");
  let wr = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "dana" }, "u_v1");
  assert.equal(wr.d.state, "ended", "no ticket for a tile that isn't live");
  assert.equal(wr.d.whep, undefined);
  for (let i = 0; i < 7; i++) { LC.beat("u_v1", ROOM.id, "dana", T + 10000); await at(10, ["dana"]); }   // the ▶ Live viewer keeps beating
  // mfix: given up after the wait (60 s) - a soft failure first ("trying again"): Pepe may be re-opening it by the exact name
  assert.deepEqual([tile("dana").video, tile("dana").why], ["card", "retry"], "given up after the wait");
  const ds = LC._sessions.get(LC.keyOf(ROOM.id, "dana"));
  assert.ok(ds && !ds.ended && !ds.holds.has("mf:" + ROOM.id), "the hold is let go; the ▶ Live viewer keeps watching");
  // cold opens on, but relays_max 1
  await reset();
  await MF.setCfg(ADMIN, { cold_open: true, relays_max: 1, stills: false });
  await step(["alice", "bob"]); await at(3, ["alice", "bob"]);
  assert.equal(MF._pads.get(ROOM.id).state.tiles.filter((x) => x.video === "starting" || x.video === "live").length, 1);
  await MF.setCfg(ADMIN, { relays_max: 2, stills: true });
  // exact flips to false on a tile that was LIVE: off live at once
  await reset();
  await onStage(["alice"]);
  assert.equal(tile("alice").video, "live");
  EXACT.delete("alice");
  await bot({ live: [{ room: ROOM.id, login: "alice", state: "live", exact: false }] });
  MF.stepPad(ROOM.id, T);
  assert.notEqual(tile("alice").video, "live", "never the wrong person: not live any more");
  const wr2 = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1");
  assert.equal(wr2.d.whep, undefined, "and no new tickets");
});

test("11. stills: a quiet snap job (mf, no viewer) and a frame nobody can save", async () => {
  await reset();
  await MF.setCfg(ADMIN, { relays_max: 0, stills: true, stills_max: 4 });
  await step(["bob"]); await at(3, ["bob"]);
  assert.equal(tile("bob").video, "still");
  const j = [...relay._jobs.values()].find((x) => x.kind === "snap" && x.target === "bob");
  assert.ok(j && j.mf === true && j.userId === null && j.viewers.size === 0);
  const offered = relay.takeJobs(new Set([ROOM.id])).find((x) => x.id === j.id);
  assert.equal(offered.mf, true);
  assert.equal(offered.user_id, undefined, "no account behind it");
  // Pepe answers with a frame (and a save rule): nobody gets Save
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100)]).toString("base64");
  const app = express(); app.use(express.json());
  relay.register(app, { isBotToken: (t) => t === "bot", addUser: (q, s, n) => n(), bySlug: bridge.bySlug, isLive: () => true });
  const srv = app.listen(0);
  await fetch("http://127.0.0.1:" + srv.address().port + "/api/bridge/snap", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot", id: j.id, room: ROOM.id, target: "bob", ok: true, data: jpeg, save: "on", viewer_ok: true, cost: 5 }) });
  srv.close();
  assert.equal(relay._snaps.get(ROOM.id + "|bob"), undefined, "never stored as a viewer's snapshot (no Save, no Generate)");
  const s = relay._mfSnaps.get(ROOM.id + "|bob");
  assert.ok(s && s.ok && s.img, "the mic stage's own (exact) frame");
  const r = await get(`/api/rooms/${slug()}/micfollow/still/bob`, "u_v1");
  assert.equal(r.d.state, "ok");
  assert.match(r.d.img, /^data:image\/jpeg;base64,/);
  assert.equal(r.d.save, undefined);
  assert.equal((await get(`/api/rooms/${slug()}/micfollow/still/bob`, null)).status, 401);
  // a viewer's OWN snapshot (Pepe's usual, fuzzy targeting - maybe the wrong "Bob") is never reused for the mic stage:
  // not its fresh frame, not its pending job
  relay._snaps.set(ROOM.id + "|carl", { sid: "fx", ts: Date.now(), ok: true, img: Buffer.from([0xff, 0xd8, 1]), viewers: new Set(["u_v1"]), okFor: new Map(), saves: new Map() });
  const vj = relay.newJob({ kind: "snap", roomId: ROOM.id, userId: "u_v1", username: "viewer1", camfrog: "", target: "dana", viewers: new Set(["u_v1"]) });
  assert.ok(relay.mfSnap(ROOM.id, "carl").id, "a fresh viewer frame isn't reused: an exact job of its own");
  assert.ok(relay.mfSnap(ROOM.id, "dana").id, "a viewer's pending job isn't reused either");
  assert.equal(relay.mfFrame(ROOM.id, "carl").state, "pending", "the viewer's frame is never served to the mic stage");
  assert.ok(relay.mfSnap(ROOM.id, "carl").pending, "its own job is reused");
  vj.state = "done"; relay._snaps.delete(ROOM.id + "|carl");
  // a bridge block on cam snapshots for this viewer: the still tile says so (not "starting" for ever), the route refuses
  const BB = require(path.join(repo, "bridgeblocks"));
  const realRefusal = BB.refusal;
  BB.refusal = async (roomId, uid, f) => (uid === "u_v3" && f === "snapshots" ? "blocked here" : null);
  try {
    const v3 = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v3", null);
    assert.equal(v3.src.find((x) => x.id === "bob").watch, "blocked");
    const r3 = await get(`/api/rooms/${slug()}/micfollow/still/bob`, "u_v3");
    assert.equal(r3.status, 403); assert.equal(r3.d.code, "blocked");
  } finally { BB.refusal = realRefusal; }
  await MF.setCfg(ADMIN, { relays_max: 2 });
});

test("12. yieldRelay: a manual cam slot still opens when live cams are full of mic-only relays", async () => {
  await reset();
  await LC.save(ADMIN, { cfg: { max_live: 2 } });
  await onStage(["alice", "bob"]);
  assert.equal(LC.liveCount(), 2);
  const { slot } = await stage.camOpen(ADMIN, { room: ROOM.id, login: "carl" });
  assert.ok(slot && slot.cam.login === "carl");
  assert.equal(MF._pads.get(ROOM.id).state.tiles.filter((x) => x.video === "live" || x.video === "starting").length, 1, "one gave its relay up");
  await stage.end(slot.id, "cut", "admin");
  await LC.save(ADMIN, { cfg: { max_live: 4 } });
});

test("13-14. a ✂ Cut of a manual cam slot keeps them off the mic stage 60 min; a stage ban keeps them off", async () => {
  await reset();
  const { slot } = await stage.camOpen(ADMIN, { room: ROOM.id, login: "fay" });
  await stage.end(slot.id, "cut", "padowner");
  await settle();
  const st = await MF.ownerState(ROOM.id);
  const ex = st.excluded.find((e) => e.login === "fay");
  assert.ok(ex && ex.reason === "cut" && ex.until > T + 59 * 60 * 1000);
  await step(["fay"]); await at(3, ["fay"]);
  assert.deepEqual(tiles(), []);
  await MF.unexclude(ROOM.id, "fay");
  await stage.roomBan(ROOM.id, "fay_patv", "test", "padowner");
  await settle(); await settle();
  await at(3, ["fay"]); await at(3, ["fay"]);
  assert.deepEqual(tiles(), [], "banned");
  await stage.roomUnban(ROOM.id, "u_fay", "padowner");
  await settle(); await settle();
});

test("15. 1.99afn (FU-1): ONE courtesy notice per Camfrog login, ever - a real account: the PM + one silent inbox row; unlinked: a PM queued under the pad owner; a house pad: under Pepe's own account (D-19); nothing more, ever", async () => {
  await reset();
  await runQuery("DELETE FROM inbox").catch(() => {});
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  await MF._noticed(ROOM.id, "alice", null);           // alice has never been told anywhere (she has a real PATV account)
  await step(["alice"]); await at(3, ["alice"]);
  for (let i = 0; i < 20; i++) await settle();
  const box = await getQuery("SELECT title, body FROM inbox WHERE user_id = 'u_alice' AND kind = 'stage'");
  assert.equal(box.length, 1, JSON.stringify(box));
  assert.match(box[0].title, /may show your cam while you hold the mic/);
  assert.match(box[0].body, /PATV homepage, to everyone/, "owner D-1: the notice says the homepage shows it to everyone on a Public pad");
  assert.match(box[0].body, /only notice you'll get/);
  const pm = await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify'");
  assert.equal(pm.length, 1, "one PM, never a room line (bot 1.99afm) - " + JSON.stringify(pm));
  const [to, text] = JSON.parse(pm[0].args);
  assert.equal(to, "alice");
  assert.equal(pm[0].user_id, "u_owner", "queued under the pad owner");
  assert.match(text, /^🎙 Once only: .* shows Mic Room's mic holder, cam too, to signed-in members \(and to everyone on the PATV homepage if the pad is Public\)\. Other pads with mic follows do too\./);
  assert.match(text, /Stop it everywhere: !livecam off https:\/\/publicaccess\.tv\/p\//);
  assert.ok(text.length <= 300);
  const c = await MF.courtesyOf("alice");
  assert.ok(c && c.v === MF.COURTESY_V && c.v === 2, "her courtesy row (v2: the text names the homepage) - " + JSON.stringify(c));
  assert.equal(tileOn("alice"), false, "not picked before notice_lead_s");
  T = Number(c.sent_at) + 121 * 1000; await bot(); await step(["alice"]); up("alice"); await at(1, ["alice"]);
  assert.equal(tileOn("alice"), true, "picked 120 s after the notice");
  // more grabs and pictures over six hours (the old re-notice was every 3 h): nothing more
  for (let h = 0; h < 6; h++) { await reset(); await onStage(["alice"]); for (let i = 0; i < 5; i++) await settle(); T += 3600e3; }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify'"))[0].n, 1, "no re-notice");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u_alice' AND kind = 'stage'"))[0].n, 1);
  // dana has no PATV account: a PM via Pepe, queued as the pad owner, and no inbox row anywhere
  await reset();
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  await MF._noticed(ROOM.id, "dana", null);
  await step(["dana"]); await at(3, ["dana"]);
  for (let i = 0; i < 20; i++) await settle();
  const acts = await getQuery("SELECT user_id, kind, args FROM pepe_actions WHERE kind = 'notify'");
  assert.ok(acts.length === 1 && acts[0].user_id === "u_owner" && JSON.parse(acts[0].args)[0] === "dana", JSON.stringify(acts));
  // a house pad with no owner: a PM queued under Pepe's own account - there is no public room line for the mic stage (D-19)
  await rooms.setOwner(ROOM.id, "house", "test");
  await reset();
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  await MF._noticed(ROOM.id, "carl", null);
  await step(["carl"]); await at(3, ["carl"]);
  for (let i = 0; i < 20; i++) await settle();
  const house = await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify'");
  assert.equal(house.length, 1, JSON.stringify(house));
  assert.equal(house[0].user_id, "pepe-bot");
  assert.equal(JSON.parse(house[0].args)[0], "carl");
  await rooms.setOwner(ROOM.id, "padowner", "test");
  // a span covered by the courtesy notice is "noticed"
  const sp = await getQuery("SELECT noticed FROM micfollow_spans WHERE login = 'alice' ORDER BY id DESC LIMIT 1");
  assert.equal(sp[0] && sp[0].noticed, 1);
});

test("16. the appearance log: one span per person on stage, closed with its reason; the person's own list; prune", async () => {
  await reset();
  await runQuery("DELETE FROM micfollow_spans");
  await onStage(["alice"]);
  await at(10, []); await at(30, []);
  for (let i = 0; i < 10; i++) await settle();
  const rows = await getQuery("SELECT * FROM micfollow_spans WHERE login = 'alice'");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].ended && rows[0].secs >= 20 && rows[0].end_reason === "released", JSON.stringify(rows[0]));
  assert.ok(rows[0].video_secs > 0);
  const mine = await MF.privacyState("u_alice");
  assert.equal(mine.linked, true);
  assert.equal(mine.spans.length, 1);
  assert.equal(mine.auto, true);
  await runQuery("UPDATE micfollow_spans SET started = ?", [T - 40 * 24 * 3600e3]);
  await MF.prune(T);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans"))[0].n, 0);
});

test("17. the kill switch, pad off, and why_off", async () => {
  await reset();
  await onStage(["alice"]);
  await assert.rejects(MF.setKill({ userId: "x", class: "pleb" }, false), (e) => e.status === 403);
  await MF.setKill(STAFF, false, "test");
  assert.deepEqual(tiles(), [], "everything dark at once");
  assert.equal((await MF.ownerState(ROOM.id)).why_off, "site_off");
  await MF.setKill(STAFF, true, "test");
  await at(1, ["alice"]);
  await at(3, ["alice"]);
  assert.deepEqual(tiles(), ["alice"]);
  await MF.setPad(ROOM.id, { on: false }, "test");
  assert.deepEqual(tiles(), []);
  assert.equal(MF.snapshot(ROOM.id), null, "no program when the pad has it off");
  await MF.setPad(ROOM.id, { on: true }, "test");
  for (const [why, fn, undo] of [
    ["livecams_off", () => LC.save(ADMIN, { cfg: { enabled: false } }), () => LC.save(ADMIN, { cfg: { enabled: true } })],
    ["room_off", () => {}, () => {}],
    ["prime", () => { primeOk = false; }, () => { primeOk = true; }],
    ["pepe_old", () => LC.forBot({ cap: true, mf: 0 }, T), () => bot()],
  ]) {
    await fn();
    room(["alice"], why === "room_off" ? { livecams: false } : {});
    MF.stepPad(ROOM.id, T);
    assert.equal(MF._pads.get(ROOM.id).state.whyOff, why);
    await undo();
  }
  // a managers-only why_off on the program
  await LC.forBot({ cap: true, mf: 0 }, T);
  room(["alice"]); MF.stepPad(ROOM.id, T);
  assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_owner", null)).why_off, "pepe_old");
  assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).why_off, undefined);
  await bot();
});

test("18. Pepe's poll carries want[].mf and mf_rooms; the console lines carry no logins (a daily per-person tag)", async () => {
  await reset();
  const lines = [], log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { await onStage(["alice"]); } finally { console.log = log; }
  const mine = lines.filter((l) => l.startsWith("[micfollow]"));
  assert.ok(mine.length && mine.some((l) => / p=\+[0-9a-f]{8}/.test(l)), mine.join("\n"));
  assert.ok(mine.every((l) => !/alice/i.test(l)), "no login in the micfollow lines");
  assert.equal(MF.ptag("alice", T), MF.ptag("ALICE", T));
  assert.notEqual(MF.ptag("alice", T), MF.ptag("alice", T + 24 * 3600e3), "changes every day");
  const r = await bot();
  assert.ok(r.want.find((w) => w.login === "alice").mf);
  assert.deepEqual(r.mf_rooms, [ROOM.id]);
});

test("19. egress: nothing of the mic stage in /api/stage, the stage slots / events, the homepage live view; never HLS", async () => {
  await reset();
  await runQuery("DELETE FROM stage_events");
  await onStage(["alice", "bob"]);
  assert.deepEqual(await stage.publicSlots(ROOM.id), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ('waiting','active')"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_events"))[0].n, 0);
  const home = await bridge.liveFor(R.slug);
  assert.equal(home.stage_program, undefined);
  const g = await stage.guide().catch(() => null);
  assert.ok(!JSON.stringify(g || {}).includes("alice"));
  const w = await LC.stageWatch({ userId: "u_v1" }, R, "mf:" + ROOM.id, { login: "alice" }, T);
  const p = new URL(w.whep).pathname.split("/").pop();
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(new URL(w.whep).searchParams.get("pt")) }, "read", "hls"), 403);
  // the pad page's own /live has it (per viewer)
  const lv = await bridge.liveView(R, 0, "u_v1", "viewer1", "viewer1", true, { program: true });
  assert.equal(lv.stage_program.count, 2);
  assert.deepEqual(lv.stage_program.src.map((s) => s.id).sort(), ["alice", "bob"]);
  assert.equal(lv.stage_program.src.find((s) => s.id === "alice").name, "alice_patv", "the PATV name when linked");
  // source checks: the public surfaces never read micfollow
  for (const f of ["home.js", "roomsweb.js", "onair.js", "restream.js", "stagecap.js"]) {
    if (fs.existsSync(path.join(repo, f))) assert.doesNotMatch(fs.readFileSync(path.join(repo, f), "utf8"), /micfollow/, f);
  }
});

test("owner routes: settings (fetch-only, owner only), exclude by PATV name, freeze, layout; the privacy switch; staff routes", async () => {
  await reset();
  let r = await post(`/api/rooms/${slug()}/micfollow/settings`, { on: true, layout: "grid", max_people: 6, max_live: 9 }, "u_v1");
  assert.equal(r.status, 403);
  r = await post(`/api/rooms/${slug()}/micfollow/settings`, { on: true, layout: "grid", max_people: 6, max_live: 9 }, "u_owner");
  assert.equal(r.status, 400, "max_live over the cap");
  // the site's max_people caps the pad's (an owner may only narrow it); its default is 9, so the 3 x 3 grid is reachable
  assert.equal(core.DEFAULTS.max_people, 9, "the site's cap by default: the whole Brady Bunch grid");
  assert.equal(core.PAD_DEFAULTS.max_people, 4, "a pad's own default stays 4");
  await MF.setCfg(ADMIN, { max_people: 4 });
  r = await post(`/api/rooms/${slug()}/micfollow/settings`, { on: true, layout: "grid", max_people: 6, max_live: 3, default_view: "after_streams" }, "u_owner");
  assert.equal(r.status, 400, "max_people over the site's cap (an admin narrowed it to 4): an owner may only narrow it");
  assert.equal(r.d.code, "bad");
  await MF.setCfg(ADMIN, { max_people: 9 });
  r = await post(`/api/rooms/${slug()}/micfollow/settings`, { on: true, layout: "grid", max_people: 6, max_live: 3, default_view: "after_streams" }, "u_owner");
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.settings, { on: true, layout: "grid", default_view: "after_streams", max_people: 6, max_live: 3, keep_recent: 0 });
  assert.equal(r.d.state.max_people_cap, 9);
  assert.equal(typeof r.d.state.status_text, "string", "the card repaints its status line from this");
  assert.match(r.d.state.status_text, /^(Running|Ready|Can't run|Off)/);
  const nofetch = await fetch(base + `/api/rooms/${slug()}/micfollow/settings`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "u_owner" }, body: "{}" });
  assert.equal(nofetch.status, 403, "fetch-only");
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "viewer2", kind: "patv", hours: 1 }, "u_owner");
  assert.equal(r.d.code, "unlinked");
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "nosuchpatv", kind: "patv", hours: 1 }, "u_owner");
  assert.equal(r.d.code, "nouser");
  // the owner says which kind of name: a PATV username that is ALSO someone else's Camfrog login in the room
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('u_carlimp', 'carl', 'carl', 'x', 'pleb', 'zed')");
  room([]);
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "carl", hours: 1 }, "u_owner");
  assert.equal(r.d.code, "ambiguous", "no kind: never guessed");
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "carl", kind: "camfrog", hours: 1 }, "u_owner");
  assert.ok(r.d.state.excluded.some((e) => e.login === "carl"), "the Camfrog person carl, not the PATV account's zed");
  assert.ok(!r.d.state.excluded.some((e) => e.login === "zed"));
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "viewer2", kind: "camfrog", hours: 1 }, "u_owner");
  assert.ok(r.d.state.excluded.some((e) => e.login === "viewer2"), "a Camfrog name that is also an unlinked PATV name");
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "carl", kind: "patv", hours: 1 }, "u_owner");
  assert.ok(r.d.state.excluded.some((e) => e.login === "zed"), "PATV: that account's linked Camfrog name");
  for (const l of ["carl", "zed", "viewer2"]) await post(`/api/rooms/${slug()}/micfollow/exclude`, { login: l, remove: true }, "u_owner");
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { name: "bob_patv", hours: 24 }, "u_owner");
  assert.ok(r.d.state.excluded.some((e) => e.login === "bob"));
  r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { login: "bob", remove: true }, "u_owner");
  assert.ok(!r.d.state.excluded.some((e) => e.login === "bob"));
  r = await post(`/api/rooms/${slug()}/micfollow/freeze`, { minutes: 999 }, "u_owner");
  assert.ok(r.d.frozen_until <= T + 30 * 60 * 1000 + 1000, "capped by freeze_max_min");
  await post(`/api/rooms/${slug()}/micfollow/freeze`, { minutes: 0 }, "u_owner");
  await onStage(["alice"]);                  // the on-stage picker is a session override: it needs someone on the mic stage
  r = await post(`/api/rooms/${slug()}/micfollow/layout`, { layout: "pip" }, "u_owner");
  assert.equal(r.d.layout, "pip");
  assert.equal(MF.snapshot(ROOM.id).override, "pip");
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/layout`, { layout: "huge" }, "u_owner")).status, 400);
  await post(`/api/rooms/${slug()}/micfollow/layout`, { layout: null }, "u_owner");
  await MF.setPad(ROOM.id, { layout: "auto", max_people: 4, max_live: 4, default_view: "first" }, "test");
  // the privacy switch
  r = await post("/api/privacy/micfollow", { auto: false }, "u_bob");
  assert.equal(r.d.auto, false);
  r = await get("/api/privacy/micfollow", "u_bob");
  assert.equal(r.d.auto, false);
  r = await post("/api/privacy/micfollow", { auto: true }, "u_bob");
  assert.equal(r.d.auto, true);
  assert.equal((await post("/api/privacy/micfollow", { auto: false }, "u_v2")).d.code, "unlinked");
  // staff
  assert.equal((await get("/api/stage/admin/micfollow", "u_v1")).status, 403);
  r = await get("/api/stage/admin/micfollow", "u_staff");
  assert.equal(r.status, 200);
  assert.equal(r.d.spans, undefined, "the appearance log is admins only");
  assert.ok((await get("/api/stage/admin/micfollow", "u_admin")).d.spans);
  assert.equal((await post("/api/stage/admin/micfollow/config", { min_hold_s: 3 }, "u_staff")).status, 403, "knobs: admins only");
  assert.equal((await post("/api/stage/admin/micfollow/config", { min_hold_s: 3, reason: "t" }, "u_admin")).d.cfg.min_hold_s, 3);
  await post("/api/stage/admin/micfollow/config", { min_hold_s: 2 }, "u_admin");
  r = await post("/api/stage/admin/micfollow/pad", { room: ROOM.id, on: false }, "u_staff");
  assert.equal(r.status, 200);
  assert.equal((await MF.ownerState(ROOM.id)).on, false);
  await MF.setPad(ROOM.id, { on: true }, "test");
  r = await post("/api/stage/admin/micfollow/kill", { enabled: true }, "u_staff");
  assert.equal(r.status, 200);
});

// ── review fixes (r2) ──

test("20. cam access not loaded yet: the mode check fails closed (nobody staged, no relay), then the load is retried and it works", async () => {
  await reset();
  CA._reset();                                   // as at a boot where cam_access hasn't loaded (yet)
  room(["alice"]); MF.stepPad(ROOM.id, T);
  T += 3000; room(["alice"]); MF.stepPad(ROOM.id, T);
  assert.deepEqual(tiles(), [], "a mode it can't read = mode_closed");
  assert.ok(!LC._sessions.has(LC.keyOf(ROOM.id, "alice")), "no relay opened");
  for (let i = 0; i < 20 && !CA.loaded(); i++) await settle();
  assert.equal(CA.loaded(), true, "the load is retried");
  await at(1, ["alice"]);
  assert.deepEqual(tiles(), ["alice"]);
});

test("21. Pepe's hidden list (!bridge hide / !incognito) cuts at once, even in the stale hold on an old roster", async () => {
  await reset();
  await onStage(["alice", "bob"]);
  const Q = require(path.join(repo, "quotes"));
  R.updated = T - 50 * 1000;                     // no sync for 50 s: the stale hold rides it out on the old roster ...
  Q.setHidden([Q.hiddenHash("alice")]);          // ... which still lists alice, but the site has Pepe's hidden list
  try {
    MF.stepPad(ROOM.id, T);
    assert.ok(MF._pads.get(ROOM.id).state.staleSince > 0, "in the stale hold");
    assert.deepEqual(tiles(), ["bob"], "alice is off at once");
    const r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v1");
    assert.equal(r.d.whep, undefined);
  } finally { Q.setHidden([]); }
});

test("22. livecam's own consent check refuses the hold (private activity, no hook yet): a cut - no 'failed' card left behind", async () => {
  await reset();
  await step(["alice"]);                         // facts fresh: not private
  PRIV.add("alice");                             // private activity on, no hook (the 10 s cache still says no)
  await at(3, ["alice"]);
  for (let i = 0; i < 10; i++) await settle();
  await MF._idle();
  assert.deepEqual(tiles(), [], "cut, not a 'Pepe couldn't open their cam' card for 10 min");
  const sp = (await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = 'alice' ORDER BY id DESC LIMIT 1"))[0];
  // train2 merge: stagefix's stageConsent refuses private activity with the neutral "unavailable" (it used to say opted_out)
  assert.equal(sp && sp.end_reason, "cut:unavailable");
});

test("23. a forced recheck isn't answered by a fetch that started before the change (private activity cuts in ~2 s, not 10)", async () => {
  await reset();
  await onStage(["alice"]);
  const before = stories.privateLogins;
  let release = null, calls = 0;
  const slow = new Promise((r) => { release = r; });
  // the first read is slow and gets the OLD value (it started before the change); later reads are the real thing
  stories.privateLogins = async (ls) => { if (calls++ === 0) { await slow; return new Set(); } return before(ls); };
  try {
    T += 11 * 1000; await bot();
    room(["alice"]); MF.stepPad(ROOM.id, T);     // the facts expired: that slow read starts
    await settle();                              // ... and is waiting
    PRIV.add("alice");                           // the person turns private activity on; the hook rechecks
    const p = MF.recheck("alice", { refresh: true });
    await settle();                              // the recheck now waits on the read that started BEFORE the change
    release();
    await p; await MF._idle(); await settle();
  } finally { stories.privateLogins = before; }
  assert.deepEqual(tiles(), [], "cut on the fresh read");
});

test("24. labels: an unlinked person is shown by their Camfrog LOGIN (a display name is free text - no impersonation)", async () => {
  await reset();
  const members = MEMBERS().map((m) => (m.login === "dana" ? { ...m, display: "alice_patv" } : m));
  await step(["dana"], { members }); await at(3, ["dana"], { members }); up("dana"); await at(1, ["dana"], { members });
  const lv = await bridge.liveView(R, 0, "u_v1", "viewer1", "viewer1", true, { program: true });
  const d = lv.stage_program.src.find((x) => x.id === "dana");
  assert.equal(d.name, "dana", "not the display name 'alice_patv'");
});

test("25. an exclusion by PATV name follows the account: re-linked to another Camfrog name, still kept off", async () => {
  await reset();
  await MF.excludeFor(ROOM.id, "fay", 24 * 60, "owner", "test", { userId: "u_fay" });
  await runQuery("UPDATE users SET camfrogUsername = 'fay2' WHERE userId = 'u_fay'");
  try {
    const members = MEMBERS().concat([{ login: "fay2", display: "Fay", on_cam: true }]);
    await step(["fay2"], { members }); await at(3, ["fay2"], { members }); await at(3, ["fay2"], { members });
    assert.deepEqual(tiles(), [], "fay2 is fay_patv's Camfrog name now");
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = 'fay' WHERE userId = 'u_fay'");
    await MF.unexclude(ROOM.id, "fay");
  }
});

test("26. relays the mic stage lets go of end at once (none linger against max_live); a manual cam slot then opens", async () => {
  await reset();
  await LC.save(ADMIN, { cfg: { max_live: 2 } });
  try {
    await onStage(["alice", "bob"]);
    assert.equal(LC.liveCount(), 2);
    await at(10, []); await at(30, []);          // both drop the mic: the last-on hold, then off
    assert.deepEqual(tiles(), []);
    assert.equal(LC.liveCount(), 0, "no lingering mic-only relays");
    const { slot } = await stage.camOpen(ADMIN, { room: ROOM.id, login: "carl" });
    assert.ok(slot && slot.cam.login === "carl");
    await stage.end(slot.id, "ended", "system");
  } finally { await LC.save(ADMIN, { cfg: { max_live: 4 } }); }
});

test("27. a yield to a manual cam slot: the freed relay isn't raced by a mic tile's cold open; nobody gets a 'failed' card", async () => {
  await reset();
  await LC.save(ADMIN, { cfg: { max_live: 2 } });
  try {
    await onStage(["alice", "bob", "dana"]);
    assert.equal(LC.liveCount(), 2);
    const { slot } = await stage.camOpen(ADMIN, { room: ROOM.id, login: "carl" });
    assert.ok(slot && slot.cam.login === "carl", "the manual slot got the relay");
    for (let i = 0; i < 3; i++) await at(1, ["alice", "bob", "dana"]);
    for (const l of ["alice", "bob", "dana"]) assert.notEqual(tile(l).why, "failed", l + ": no 10-minute failure for a capacity race");
    assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, "carl")) && !LC._sessions.get(LC.keyOf(ROOM.id, "carl")).ended);
    await stage.end(slot.id, "ended", "system");
  } finally { await LC.save(ADMIN, { cfg: { max_live: 4 } }); }
});

test("28. Pepe refuses a viewer's ▶ Live as full: mic follows sheds (its stills stop, nothing new for a minute)", async () => {
  await reset();
  await MF.setCfg(ADMIN, { relays_max: 0, stills: true });
  try {
    await step(["bob"]); await at(3, ["bob"]);
    assert.equal(tile("bob").video, "still");
    await LC.start({ userId: "u_v1", username: "viewer1" }, room(["bob"]), "carl", T);
    await bot({ refused: [{ room: ROOM.id, login: "carl", why: "slots_busy" }] });
    assert.notEqual(tile("bob").video, "still", "the still stops");
    assert.equal(MF._pads.get(ROOM.id).stills.size, 0);
    await at(5, ["bob"]);
    assert.notEqual(tile("bob").video, "still", "no new still while shedding");
    await at(60, ["bob"]);
    assert.equal(tile("bob").video, "still", "back after the shed");
  } finally { await MF.setCfg(ADMIN, { relays_max: 2 }); }
});

test("29. a quiet voice-only room (Pepe's snapshot only every 30 s) never goes stale: the program doesn't flap", async () => {
  await reset();
  await onStage(["alice"]);
  R.updated = T - 30 * 1000;
  MF.stepPad(ROOM.id, T);
  const S = MF._pads.get(ROOM.id).state;
  assert.equal(S.whyOff, null);
  assert.equal(S.staleSince, 0, "not stale 30 s after the last snapshot");
  assert.deepEqual(LC.forBot ? (await bot()).mf_rooms : [], [ROOM.id], "mf_rooms stays on");
});

// ── review fixes (r3) ──
const core = require(path.join(repo, "micfollow-core"));
/** The pad back to plain settings (the owner-routes test leaves it at grid / 6 people / 3 live). */
async function plainPad() { await MF.setPad(ROOM.id, { on: true, layout: "auto", default_view: "first", max_people: 4, max_live: 4, keep_recent: 0 }, "test"); }
const readOf = (w) => () => LC.auth({ path: new URL(w.whep).pathname.split("/").pop(), query: "pt=" + encodeURIComponent(new URL(w.whep).searchParams.get("pt")) }, "read", "webrtc");

test("30. exact: a warm relay Pepe hasn't confirmed (null) or says isn't exact (false) is never live - no ticket, no read; confirmed: live at once", async () => {
  await reset(); await plainPad();
  await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "dana", T);     // a ▶ Live open (his older, fuzzy match), not reported yet
  LC.noteSync([{ name: LC.pathFor(ROOM.id, "dana"), ready: true, readers: [] }], T);
  await step(["dana"]); await at(3, ["dana"]);
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "dana"));
  assert.ok(S.holds.has("mf:" + ROOM.id), "held - so Pepe is asked to check it (want[].mf)");
  assert.ok((await bot()).want.find((x) => x.login === "dana").mf);
  assert.equal(tile("dana").video, "starting");
  let r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "dana" }, "u_v3");
  assert.equal(r.d.whep, undefined, "no ticket");
  const w = await LC.stageWatch({ userId: "u_v3" }, R, "mf:" + ROOM.id, { login: "dana" }, T);
  assert.equal(await readOf(w)(), 403, "exact unknown: MediaMTX's read hook says no too");
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login: "dana", state: "live", exact: false }] }, T);
  assert.equal(tile("dana").video, "starting", "exact false: never live");
  assert.equal(await readOf(w)(), 403, "exact false");
  // Pepe verifies it in place: the flip steps the pad at once - live, tickets
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login: "dana", state: "live", exact: true }] }, T);
  assert.equal(tile("dana").video, "live");
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "dana" }, "u_v3");
  assert.ok(r.d.whep);
  // ... and when it stops being exact: off live in the same poll (no waiting for the next step), its viewers kicked
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login: "dana", state: "live", exact: false }] }, T);
  assert.notEqual(tile("dana").video, "live");
  assert.ok(!S.stageViewers.has("u_v3"), "the mic-stage viewer is dropped with the hold");
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "dana" }, "u_v3");
  assert.equal(r.d.whep, undefined);
  LC.stop("u_v1", ROOM.id, "dana", T);
});

test("31. relays_max covers warm relays too: once their ▶ Live viewers leave, the excess the mic stage alone holds is given up", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { cold_open: false, relays_max: 2 });
  try {
    const VW = { alice: "u_v1", bob: "u_v3", carl: "u_alice", dana: "u_bob" };
    const H4 = ["alice", "bob", "carl", "dana"];
    for (const l of H4) await LC.start({ userId: VW[l], username: VW[l] }, room([]), l, T);
    up(...H4);
    await step(H4); await at(3, H4); await at(1, H4);
    assert.equal(MF._pads.get(ROOM.id).state.tiles.filter((x) => x.video === "live").length, 4, "warm reuse is free");
    for (const l of H4) LC.stop(VW[l], ROOM.id, l, T);
    assert.equal(LC.mfOnlyCount(T), 4, "now only the mic stage holds them");
    MF.tick(T);
    assert.equal(LC.mfOnlyCount(T), 4, "a grace (a viewer's beat can lapse for a moment)");
    T += 6000; await bot(); MF.tick(T);
    assert.equal(LC.mfOnlyCount(T), 2, "back to relays_max");
    assert.equal(LC.liveCount(), 2, "the given-up ones ended");
    assert.equal(MF._pads.get(ROOM.id).state.tiles.filter((x) => x.video === "live").length, 2);
    assert.ok(MF.metrics(T).counts.relays_trimmed >= 2);
  } finally { await MF.setCfg(ADMIN, { cold_open: true, relays_max: 2 }); }
});

test("32. a viewer's ▶ Live start when live cams are full of mic-only relays: the mic stage gives one back (no slots_busy)", async () => {
  await reset(); await plainPad();
  await LC.save(ADMIN, { cfg: { max_live: 2 } });
  try {
    await onStage(["alice", "bob"]);
    assert.equal(LC.liveCount(), 2);
    const r = await LC.start({ userId: "u_v1", username: "viewer1" }, room(["alice", "bob"]), "fay", T);
    assert.ok(r && r.whep, "the ▶ Live start went through");
    assert.equal(LC.liveCount(), 2);
    assert.equal(MF._pads.get(ROOM.id).state.tiles.filter(core.liveish).length, 1, "one mic tile gave its relay up");
    LC.stop("u_v1", ROOM.id, "fay", T);
  } finally { await LC.save(ADMIN, { cfg: { max_live: 4 } }); }
});

test("33. a still job is cancelled when the still stops (a cut, ...): never handed to Pepe, his late frame dropped", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { relays_max: 0, stills: true, stills_max: 4 });
  const app = express(); app.use(express.json());
  relay.register(app, { isBotToken: (t) => t === "bot", addUser: (q, s, n) => n(), bySlug: bridge.bySlug, isLive: () => true });
  const srv = app.listen(0);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100)]).toString("base64");
  const answer = (id) => fetch("http://127.0.0.1:" + srv.address().port + "/api/bridge/snap", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot", id, room: ROOM.id, target: "bob", ok: true, data: jpeg }) }).then((x) => x.json());
  const pending = () => [...relay._jobs.values()].find((x) => x.kind === "snap" && x.mf && x.target === "bob" && x.state !== "done") || null;
  try {
    await step(["bob"]); await at(3, ["bob"]);
    assert.equal(tile("bob").video, "still");
    const j = pending();
    assert.ok(j, "a quiet still job is queued");
    await MF.setOptout("bob", true);
    assert.deepEqual(tiles(), []);
    assert.equal(j.state, "done"); assert.equal(j.cancelled, true);
    assert.ok(!relay.takeJobs(new Set([ROOM.id])).some((x) => x.id === j.id), "never offered to Pepe");
    // had Pepe taken it already: his frame is dropped - never stored, never shown (not as a viewer's snapshot either)
    assert.equal((await answer(j.id)).cancelled, true);
    assert.equal(relay._mfSnaps.get(ROOM.id + "|bob"), undefined);
    assert.equal(relay._snaps.get(ROOM.id + "|bob"), undefined);
    // ... even after the job itself was swept
    relay._jobs.delete(j.id);
    await answer(j.id);
    assert.equal(relay._snaps.get(ROOM.id + "|bob"), undefined, "a swept mic-stage job's frame is still never a viewer's snapshot");
    await MF.setOptout("bob", false);
    // the last-moment check in takeJobs: a still job whose still stopped is never handed over
    await at(25, ["bob"]); await at(1, ["bob"]);
    assert.equal(tile("bob").video, "still");
    const j2 = pending();
    assert.ok(j2);
    MF._pads.get(ROOM.id).stills.delete("bob");
    assert.ok(!relay.takeJobs(new Set([ROOM.id])).some((x) => x.id === j2.id));
    assert.equal(j2.cancelled, true);
  } finally { srv.close(); await MF.setCfg(ADMIN, { relays_max: 2 }); }
});

test("34. a consent cut, the kill switch or pad off end a relay only the mic stage held - at once, not after linger_s", async () => {
  for (const [name, cut, undo] of [
    ["mf_opted_out", () => MF.setOptout("alice", true), () => MF.setOptout("alice", false)],
    ["mode_closed", () => CA.setMode("alice", "request"), () => CA.setMode("alice", "everyone")],
    ["excluded", () => MF.excludeFor(ROOM.id, "alice", 60, "owner", "test"), () => MF.unexclude(ROOM.id, "alice")],
    ["kill", () => MF.setKill(STAFF, false, "test"), () => MF.setKill(STAFF, true, "test")],
    ["pad off", () => MF.setPad(ROOM.id, { on: false }, "test"), () => MF.setPad(ROOM.id, { on: true }, "test")],
  ]) {
    await reset(); await plainPad();
    await onStage(["alice"]);
    assert.deepEqual(tiles(), ["alice"], name + ": set up");
    await cut(); await settle();
    const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.ok(!S || S.ended, name + ": the relay ended");
    assert.ok(!(await bot()).want.some((x) => x.login === "alice"), name + ": Pepe stops publishing now");
    await undo();
  }
});

test("35. a cut that lands while a hold is on its way: no relay is created, Pepe is never asked", async () => {
  for (const [name, cut, undo] of [
    ["mf_opted_out", () => MF.setOptout("carl", true), () => MF.setOptout("carl", false)],
    ["cam access on request", () => CA.setMode("carl", "request"), () => CA.setMode("carl", "everyone")],
    ["excluded", () => MF.excludeFor(ROOM.id, "carl", 60, "owner", "test"), () => MF.unexclude(ROOM.id, "carl")],
    ["kill", () => MF.setKill(STAFF, false, "test"), () => MF.setKill(STAFF, true, "test")],
  ]) {
    await reset(); await plainPad();
    room(["carl"]); MF.stepPad(ROOM.id, T); await MF._idle(); await settle();
    const realPriv = stories.privateLogins;
    let release;
    const gate = new Promise((r) => { release = r; });
    stories.privateLogins = async (ls) => { if (ls.length === 1 && ls[0] === "carl") await gate; return new Set(); };   // livecam's consent check waits here
    try {
      T += 3000; room(["carl"]); MF.stepPad(ROOM.id, T);
      await settle();
      assert.ok(tile("carl") && tile("carl").pend, name + ": the hold is on its way");
      await cut();
      assert.deepEqual(tiles(), [], name + ": cut");
      release(); await settle(); await settle();
    } finally { stories.privateLogins = realPriv; }
    await MF._idle(); await settle();
    const S = LC._sessions.get(LC.keyOf(ROOM.id, "carl"));
    assert.ok(!S || S.ended, name + ": no relay");
    assert.ok(!(await bot()).want.some((x) => x.login === "carl"), name + ": never in Pepe's want list");
    await undo();
  }
});

test("36. 👻 ghost mode never reaches the mic stage: no bypass of the cam owner's block - the block drops them", async () => {
  await reset(); await plainPad();
  await onStage(["alice"]);
  const G = require(path.join(repo, "ghost"));
  const realG = G.isGhost;
  G.isGhost = (uid) => uid === "u_staff";
  try {
    const w = await LC.stageWatch({ userId: "u_staff", username: "staffer" }, R, "mf:" + ROOM.id, { login: "alice" }, T);
    const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.equal(S.stageViewers.get("u_staff").ghost, false, "never a ghost through the mic stage");
    assert.equal(await readOf(w)(), 200);
    await CV.block("alice", "staffer");
    assert.ok(!S.stageViewers.has("u_staff"), "the block drops them at once");
    assert.equal(await readOf(w)(), 403);
  } finally { G.isGhost = realG; await CV.unblock("alice", "staffer").catch(() => {}); }
});

test("37. livecam's lines for a relay the mic stage held carry no login (spec §12)", async () => {
  await reset(); await plainPad();
  const lines = [], log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { await onStage(["alice"]); await at(10, []); await at(30, []); } finally { console.log = log; }
  const lc = lines.filter((l) => l.startsWith("[livecam]"));
  assert.ok(lc.some((l) => /^\[livecam\] end .*target=- why=/.test(l)), lc.join("\n"));
  assert.ok(lc.every((l) => !/alice/.test(l)), lc.join("\n"));
});

test("38. the site knobs max_people / max_live cap every pad (admins narrow them; an owner can't widen them)", async () => {
  await reset();
  await MF.setPad(ROOM.id, { on: true, layout: "auto", max_people: 6, max_live: 3 }, "test");
  await MF.setCfg(ADMIN, { max_people: 2, max_live: 1 });
  try {
    await onStage(["alice", "bob", "carl"]);
    assert.equal(tiles().length, 2, "max_people 2");
    assert.equal(MF._pads.get(ROOM.id).state.tiles.filter(core.liveish).length, 1, "max_live 1");
    const st = await MF.ownerState(ROOM.id);
    assert.equal(st.max_people_cap, 2);
    assert.equal(st.max_live_cap, 1);
    await assert.rejects(MF.setPad(ROOM.id, { max_people: 3 }, "test"), (e) => e.code === "bad");
  } finally { await MF.setCfg(ADMIN, { max_people: 9, max_live: 4 }); await plainPad(); }
});

test("39. the notice to the person shown is in their own language; metrics per pad too", async () => {
  await reset(); await plainPad();
  T += 4 * 3600 * 1000; await bot();
  const I18N = require(path.join(repo, "i18n"));
  const realT = I18N.tFor, langs = [];
  I18N.tFor = (lang) => { langs.push(lang); return realT(lang); };
  I18N._prefs.set("u_alice", "es");
  await MF._noticed(ROOM.id, "alice", null);           // 1.99afn: the one courtesy notice - she hasn't had it yet
  try { await step(["alice"]); await at(3, ["alice"]); for (let i = 0; i < 20; i++) await settle(); }
  finally { I18N.tFor = realT; I18N._prefs.delete("u_alice"); }
  assert.ok(langs.includes("es"), langs.join(","));
  T = Number((await MF.courtesyOf("alice")).sent_at) + 121 * 1000; await bot();
  await onStage(["alice"]);
  const pad = (await MF.adminView(ADMIN)).pads.find((p) => p.room === ROOM.id);
  assert.ok(pad && pad.counts && pad.counts.adds >= 1, JSON.stringify(pad && pad.counts));
});

// ── final-verification fixes (r4): the before-prod deltas (addendum 14.1.2, owner-accepted 2026-10-19) ──

const tileOn = (l) => tiles().includes(l);

test("40. notice first (DF-11): the courtesy notice goes out at the first qualifying grab; the person is picked only 120 s later; someone told before (any pad) is picked at once and sent nothing", async () => {
  await reset(); await plainPad();
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  await MF._noticed(ROOM.id, "carl", null);          // carl has never been told (he has no PATV account: a PM via Pepe)
  await step(["carl"]); await at(3, ["carl"]);
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tileOn("carl"), false, "not on the stage yet");
  const pm = await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify'");
  assert.equal(pm.length, 1, JSON.stringify(pm));
  assert.equal(pm[0].user_id, "u_owner", "queued under the pad owner");
  const [to, text] = JSON.parse(pm[0].args);
  assert.equal(to, "carl");
  assert.match(text, /shows Mic Room's mic holder, cam too/);
  assert.match(text, /Other pads with mic follows do too/);
  assert.match(text, /in ~2 min/);
  assert.match(text, /Stop it everywhere: !livecam off https:\/\/publicaccess\.tv\/p\//, "the way to stop it (and the link) fit the 300 characters");
  assert.ok(text.length <= 300);
  const n = MF._notes.get(ROOM.id + "|carl");
  assert.ok(n && n.first, "noted");
  const row = (await getQuery("SELECT first_at FROM micfollow_notices WHERE room_id = ? AND login = 'carl'", [ROOM.id]))[0];
  assert.equal(Number(row.first_at), n.first, "kept in micfollow_notices (a restart keeps the gate)");
  assert.equal(Number((await MF.courtesyOf("carl")).sent_at), n.first, "...and the courtesy row says when he was told");
  await at(60, ["carl"]);
  assert.equal(tileOn("carl"), false, "60 s after the notice: still not");
  T = n.first + 121 * 1000; await bot(); await step(["carl"]);
  assert.equal(tileOn("carl"), true, "120 s after the notice: picked");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify'"))[0].n, 1, "one notice, not one per step");
  // later: no re-notice at all (1.99afn: the 3-hourly re-notices are gone)
  await reset(); await plainPad();
  T += 4 * 3600 * 1000; await bot();
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  await onStage(["carl"]);
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tileOn("carl"), true, "no 120 s wait the second time");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify'"))[0].n, 0, "nothing sent the second time");
  // told on another pad long ago (the pad's own notices row is gone - its 180-day purge): picked at once, nothing sent
  await reset(); await plainPad();
  MF._notes.delete(ROOM.id + "|carl");
  await runQuery("DELETE FROM micfollow_notices WHERE login = 'carl'");
  await runQuery("UPDATE micfollow_courtesy SET sent_at = 5, room_id = 'Other.Room' WHERE login = 'carl'");
  await step(["carl"]); await at(3, ["carl"]);
  for (let i = 0; i < 10; i++) await settle();
  up("carl"); await at(1, ["carl"]);
  assert.equal(tileOn("carl"), true, "told on another pad = told here (D-7)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify'"))[0].n, 0, "and nothing sent");
  assert.equal(MF._notes.get(ROOM.id + "|carl").first, 5, "the pad's gate reads the courtesy notice's time");
});

test("41. blocks (14.1.2 #2): DM blocks either way -> 'isn't available', no ticket; a person who blocked the pad owner is never on that owner's stage", async () => {
  await reset(); await plainPad();
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("DELETE FROM dm_blocks");
  // train2 site: the rows (and the cam block below) go in a finally - a failed assert here used to leave them behind and
  // fail tests 45 / 47 too
  try {
    await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_v1', 'u_alice', ?)", [T]);     // the viewer blocked alice
    await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_alice', 'u_v3', ?)", [T]);     // alice blocked viewer3
    await onStage(["alice"]);
    assert.equal(tile("alice").video, "live");
    for (const uid of ["u_v1", "u_v3"]) {
      const v = await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null);
      assert.equal(v.src[0].watch, "unavailable", uid + ": the neutral card");
      const r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, uid);
      assert.equal(r.status, 403, uid);
      assert.equal(r.d.code, "unavailable");
      assert.ok(!r.d.whep, "no subscription");
    }
    const ok = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v2");
    assert.ok(ok.d.whep, "anyone else still watches");
    await runQuery("DELETE FROM dm_blocks");
    // alice blocks the pad's owner from her cam (cam_blocks): CUT blocked_owner at once, and never back while it stands
    await CV.block("alice", "padowner");
    room(["alice"]); MF.stepPad(ROOM.id, T);
    assert.equal(tileOn("alice"), false, "cut at the next step");
    await at(3, ["alice"]); await at(30, ["alice"]);
    assert.equal(tileOn("alice"), false, "never on that owner's mic stage");
    await CV.unblock("alice", "padowner");
    await at(1, ["alice"]); await at(3, ["alice"]);
    assert.equal(tileOn("alice"), true, "unblocked: back");
  } finally {
    await runQuery("DELETE FROM dm_blocks");
    try { await CV.unblock("alice", "padowner"); } catch (e) { /* not blocked */ }
  }
});

test("42. site bans (14.1.2 #6): a whole-site / this pad's feed ban, an archived account, Pepe's own refusal of the login -> CUT banned", async () => {
  await reset(); await plainPad();
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
                  PRIMARY KEY (user_id, room_id))`);
  await runQuery("CREATE TABLE IF NOT EXISTS feed_restricted (login TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', reason TEXT, until INTEGER, PRIMARY KEY (login, room_id))");
  const cases = [
    ["a site-wide feed ban", "alice", () => runQuery("INSERT INTO feed_bans (user_id, room_id, at, until) VALUES ('u_alice', '', ?, NULL)", [T]), () => runQuery("DELETE FROM feed_bans")],
    ["this pad's ban", "alice", () => runQuery("INSERT INTO feed_bans (user_id, room_id, at, until) VALUES ('u_alice', ?, ?, ?)", [ROOM.id, T, T + 3600e3]), () => runQuery("DELETE FROM feed_bans")],
    ["an archived account", "fay", () => runQuery("UPDATE users SET archived_at = ? WHERE userId = 'u_fay'", [T]), () => runQuery("UPDATE users SET archived_at = NULL WHERE userId = 'u_fay'")],
    ["Pepe's red list / a recent kick (feed_restricted)", "dana", () => runQuery("INSERT INTO feed_restricted (login, room_id, reason, until) VALUES ('dana', ?, 'kicked', NULL)", [ROOM.id]),
      () => runQuery("DELETE FROM feed_restricted")],
  ];
  for (const [name, who, ban, unban] of cases) {
    await reset(); await plainPad();
    await onStage([who, "bob"]);
    assert.equal(tileOn(who), true, name + ": set up");
    await ban();
    await MF.recheck(who, { refresh: true });
    assert.equal(tileOn(who), false, name + ": cut at once");
    assert.equal(tileOn("bob"), true);
    await unban();
    await MF.recheck(who, { refresh: true });
  }
  // a feed ban takes them off at once (feedstore.ban -> micfollow.recheckUser)
  assert.match(fs.readFileSync(path.join(repo, "feedstore.js"), "utf8"), /require\("\.\/micfollow"\)\.recheckUser\(u\.userId\)/);
});

test("43. 18+ pads (14.1.2 #8): mic follows can't be switched on; a pad marked 18+ while it runs stops at once", async () => {
  await reset(); await plainPad();
  await onStage(["alice"]);
  assert.equal(tileOn("alice"), true);
  await rooms.setPage(ROOM.id, { adult: true }, "test");
  try {
    room(["alice"]); MF.stepPad(ROOM.id, T);
    assert.deepEqual(tiles(), [], "cleared");
    assert.equal(MF._pads.get(ROOM.id).state.whyOff, "adult");
    const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.ok(!S || S.ended || !S.holds.has("mf:" + ROOM.id), "its relay let go");
    await MF.setPad(ROOM.id, { on: false }, "test");
    await assert.rejects(MF.setPad(ROOM.id, { on: true }, "test"), (e) => e.code === "adult" && e.status === 409);
    const r = await post(`/api/rooms/${slug()}/micfollow/settings`, { on: true }, "u_owner");
    assert.equal(r.status, 409);
    const st = await MF.ownerState(ROOM.id);
    assert.equal(st.run_why, "adult");
    assert.equal(st.can_run, false);
  } finally { await rooms.setPage(ROOM.id, { adult: false }, "test"); await plainPad(); }
});

test("44. 🧹 Clear the stage (14.1.2 #3): the owner clears it - everyone off, relays let go, frozen; not for viewers", async () => {
  await reset(); await plainPad();
  await onStage(["alice", "bob"]);
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/clear`, {}, "u_v1")).status, 403, "owners / staff only");
  const r = await post(`/api/rooms/${slug()}/micfollow/clear`, {}, "u_owner");
  assert.equal(r.status, 200);
  assert.ok(r.d.frozen_until > T);
  assert.deepEqual(tiles(), []);
  for (const l of ["alice", "bob"]) {
    const S = LC._sessions.get(LC.keyOf(ROOM.id, l));
    assert.ok(!S || S.ended || !S.holds.has("mf:" + ROOM.id), l + ": released");
  }
  await at(3, ["alice", "bob", "carl"]); await at(30, ["alice", "bob", "carl"]);
  assert.deepEqual(tiles(), [], "frozen: nobody comes back");
  await post(`/api/rooms/${slug()}/micfollow/freeze`, { minutes: 0 }, "u_owner");
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? ORDER BY rowid DESC LIMIT 5", [ROOM.id]).catch(() => []);
  assert.ok(!ev.length || ev.some((e) => /cleared the mic stage/.test(JSON.stringify(e))), "logged as a room event");
});

test("45. ⚑ reports (14.1.2 #3, DF-31): hidden for the reporter at once; two DISTINCT qualified reporters cut + 24 h hold-out; staff dismiss lifts it", async () => {
  await reset(); await plainPad();
  for (const col of ["created_at TEXT", "isEmailVerified INTEGER DEFAULT 0", "discordId TEXT", "twitchId TEXT"]) await runQuery(`ALTER TABLE users ADD COLUMN ${col}`).catch(() => {});
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class) VALUES ('u_v4', 'viewer4', 'viewer4', 'x', 'pleb')");
  await runQuery("UPDATE users SET created_at = '2020-01-01 00:00:00', level = 5, isEmailVerified = 1 WHERE userId IN ('u_v1', 'u_v3', 'u_v4')");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_keys (k TEXT NOT NULL, userId TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (k, userId))");
  await runQuery("INSERT OR IGNORE INTO welcome_keys (k, userId, kind, created) VALUES ('dev:same', 'u_v1', 'dev', 1), ('dev:same', 'u_v4', 'dev', 1)");   // u_v4 = u_v1's alt
  await runQuery("DELETE FROM micfollow_reports");
  await onStage(["alice", "bob"]);
  // an unqualified viewer (a new account): hidden for them at once, counts for nothing
  let r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "abuse" }, "u_v2");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.hidden, r.d.qualified, r.d.cut], [true, false, false]);
  let v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v2", null);
  assert.equal(v.src.find((s) => s.id === "alice").watch, "hidden");
  assert.notEqual(v.src.find((s) => s.id === "bob").watch, "hidden", "only the tile they reported");
  assert.equal(v.report, true, "⚑ is offered to signed-in viewers");
  r = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "alice" }, "u_v2");
  assert.equal(r.d.code, "hidden", "no ticket for a tile you reported");
  v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
  assert.equal(v.src.find((s) => s.id === "alice").watch, "ok", "everyone else still sees it");
  // one qualified reporter + their alt = one: no cut
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "sexual" }, "u_v1");
  assert.deepEqual([r.d.qualified, r.d.cut], [true, false]);
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "sexual" }, "u_v4");
  assert.deepEqual([r.d.qualified, r.d.cut], [true, false], "an alt of the first reporter isn't a second one");
  assert.equal(tileOn("alice"), true);
  // a second distinct qualified reporter within the window: cut, kept off this pad's mic stage 24 h (pending review)
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "sexual" }, "u_v3");
  assert.deepEqual([r.d.qualified, r.d.cut], [true, true]);
  assert.equal(tileOn("alice"), false, "off for everyone");
  const ex = (await MF.ownerState(ROOM.id)).excluded.find((e) => e.login === "alice");
  assert.equal(ex.reason, "reported");
  assert.ok(Math.abs(ex.until - (T + 24 * 3600e3)) < 5000);
  await at(3, ["alice", "bob"]); await at(30, ["alice", "bob"]);
  assert.equal(tileOn("alice"), false, "held out");
  // staff review: the card lists it; dismiss lifts it and voids those reporters' weight on alice for 24 h
  const view = await MF.adminView(STAFF);
  const rep = view.reports.find((x) => x.login === "alice");
  assert.ok(rep && rep.cut && rep.qualified >= 3, JSON.stringify(view.reports));
  assert.equal((await post("/api/stage/admin/micfollow/report", { room: ROOM.id, login: "alice", action: "dismiss" }, "u_v1")).status, 403, "staff only");
  r = await post("/api/stage/admin/micfollow/report", { room: ROOM.id, login: "alice", action: "dismiss" }, "u_staff");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(!(await MF.ownerState(ROOM.id)).excluded.some((e) => e.login === "alice"), "lifted");
  await at(3, ["alice", "bob"]); await at(3, ["alice", "bob"]);
  assert.equal(tileOn("alice"), true, "back");
  T += 5 * 60 * 1000; await bot();
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "sexual" }, "u_v3");
  assert.equal(r.d.qualified, false, "a dismissed report voids that reporter's weight on her for 24 h");
  // can't report yourself; a tile that isn't there; at most reports_per_hour per reporter per pad
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice" }, "u_alice")).d.code, "self");
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/report`, { login: "dana" }, "u_v2")).d.code, "gone");
  await post(`/api/rooms/${slug()}/micfollow/report`, { login: "bob" }, "u_v2");
  await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "other" }, "u_v2");     // (alice: once per window)
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "bob", reason: "other" }, "u_v2");
  assert.equal(r.d.counted, false);
  // signed out / outside the pad's audience: refused
  assert.equal((await post(`/api/rooms/${slug()}/micfollow/report`, { login: "bob" }, null)).status, 401);
  padFullOk = false;
  try { assert.equal((await post(`/api/rooms/${slug()}/micfollow/report`, { login: "bob" }, "u_v3")).d.code, "pad_access"); } finally { padFullOk = true; }
});

test("46. the neutral card (14.1.2 #4) - mfix: by default the last speaker's tile stays, dimmed ('Someone is speaking' over it, nobody the speaker); unattributed_clear = the old give-way; Pepe never clears it", async () => {
  // mfix default: kept, dimmed
  await reset(); await plainPad();
  await onStage(["alice"]);
  T += 8000;
  await step([{ anon: true, display: "someone" }]);
  await at(3, [{ anon: true, display: "someone" }]);
  assert.deepEqual(tiles(), ["alice"], "kept on the stage");
  let snap = MF.snapshot(ROOM.id);
  assert.equal(snap.neutral, "someone");
  let v = await MF.viewFor(snap, R, "u_v1", null);
  assert.equal(v.speaking, "someone", "the page dims the tiles and says someone else is speaking");
  assert.equal(v.src.length, 1);
  assert.equal(v.src[0].newest, false, "nobody is highlighted as the speaker");
  assert.equal(v.active, true, "she still has a picture: the stage stays the default");
  // the old behaviour behind the site knob unattributed_clear
  await MF.setCfg(ADMIN, { unattributed_clear: true, reason: "test" });
  try {
    await reset(); await plainPad();
    await onStage(["alice"]);
    T += 8000;                                       // alice has been on min_on_stage_s by the time she drops
    await step([{ anon: true, display: "someone" }]);
    await at(3, [{ anon: true, display: "someone" }]);
    assert.deepEqual(tiles(), [], "no hand-over / idle hold while someone else talks");
    snap = MF.snapshot(ROOM.id);
    assert.equal(snap.neutral, "someone");
    v = await MF.viewFor(snap, R, "u_v1", null);
    assert.equal(v.speaking, "someone");
    assert.deepEqual(v.src, [], "no name, no face");
    assert.equal(v.active, false, "never the default view (DF-15)");
    // an unproven holder is the same
    await reset(); await plainPad();
    await onStage(["alice"]);
    T += 8000;
    await step([{ login: "bob", display: "Bob", proven: false }]);
    await at(3, [{ login: "bob", display: "Bob", proven: false }]);
    assert.deepEqual(tiles(), []);
    assert.equal(MF.snapshot(ROOM.id).neutral, "someone");
    // Pepe alone: his own mic-ups never clear the stage (even with the knob on)
    await reset(); await plainPad();
    await onStage(["alice"]);
    T += 8000;
    await step([{ login: "pepe", display: "Pepe", self: true }]);
    await at(3, [{ login: "pepe", display: "Pepe", self: true }]);
    assert.deepEqual(tiles(), ["alice"], "Pepe's TTS / DJ mic-up doesn't take her off");
    assert.equal(MF.snapshot(ROOM.id).neutral, "pepe", "the page says Pepe is on the mic");
    await at(25, [{ login: "pepe", display: "Pepe", self: true }]);
    assert.deepEqual(tiles(), [], "her idle hold ran out while he spoke");
    assert.equal(MF.snapshot(ROOM.id).neutral, "pepe", "his card once nobody is left");
    await at(1, []);
    assert.equal(MF.snapshot(ROOM.id).neutral, null, "the mic is free: the card goes");
  } finally { await MF.setCfg(ADMIN, { unattributed_clear: false, reason: "test" }); }
});

test("47. D-19: a viewer who sees a cam only through the mic stage is counted, never named, to the cam's owner (!whowatching, the privacy card)", async () => {
  await reset(); await plainPad();
  await onStage(["alice"]);
  await LC.stageWatch({ userId: "u_v1", username: "viewer1" }, R, "mf:" + ROOM.id, { login: "alice" }, T);
  const raw = LC.watchersOf("alice", T);
  assert.ok(raw.some((x) => x.userId === "u_v1" && x.mf === true), "livecam still knows them (cam access re-checks drop them)");
  const w = await CV.watching("alice", T);
  assert.deepEqual(w.live.map((x) => x.username), [], "never named");
  assert.equal(w.mic_stage_n, 1, "counted");
});

test("48. a still job Pepe already claimed when a site-only cut lands: its id goes to Pepe as mf_cancel (live-cam poll, relay pull, sync)", async () => {
  await reset(); await plainPad();
  const j = relay.mfSnap(ROOM.id, "zed");
  assert.ok(j.id);
  assert.ok(!(await bot()).mf_cancel.includes(j.id));
  relay.mfSnapCancel(ROOM.id, "zed");
  const r = await bot();
  assert.ok(r.mf_cancel.includes(j.id), "the poll tells Pepe to drop it (no cam open, no frame)");
  assert.ok(relay.mfCancelled().includes(j.id));
  const src = fs.readFileSync(path.join(repo, "bridge-relay.js"), "utf8") + fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.equal((src.match(/mf_cancel: mfc/g) || []).length, 2, "the relay pull and the sync carry it too");
});

test("49. export + forget-me (14.1.2 #6): the mic-stage rows are in the account export and deleted with the account (the 'no' stays, unlinked)", async () => {
  await reset(); await plainPad();
  await onStage(["alice"]);
  await at(1, []); await at(30, []);
  for (let i = 0; i < 10; i++) await settle();
  await MF.setOptout("alice", true, "u_alice");
  const X = require(path.join(repo, "accountexport"));
  const out = await X.collect("u_alice");
  assert.ok(out.chat && out.chat.mic_stage_appearances && out.chat.mic_stage_appearances.length >= 1, JSON.stringify(out.errors || []));
  assert.equal(out.chat.mic_stage_setting[0].off, 1);
  assert.ok(Array.isArray(out.chat.mic_stage_notices));
  assert.ok(out.chat.mic_stage_reports_on_you.every((x) => x.reporter_id === undefined), "never who reported them");
  await MF.setOptout("alice", false, "u_alice");
  const D = require(path.join(repo, "accountdelete"));
  const del = D.DELETE_ROWS.map((r) => r.join("."));
  for (const k of ["micfollow_spans.login.login", "micfollow_excl.login.login", "micfollow_excl.user_id.uid", "micfollow_notices.login.login",
                   "micfollow_reports.login.login", "micfollow_reports.reporter_id.uid"]) assert.ok(del.includes(k), k);
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /DELETE FROM micfollow_optout WHERE login = \? AND off = 0/);
});

test("50. train2 merge: 'Take me off this Stage' and a DM block with the pad's owner keep them OFF the mic stage (CUT unavailable) - no re-pick every cooldown_s", async () => {
  // stagefix's livecam.stageConsent refuses a hold for both (the neutral "unavailable"); micfollow's own eligibility has to
  // know them too, or a person who keeps the mic is picked, refused and cut again every cooldown_s (a tile with their name
  // flashing up, a span row each time, the change budget used up)
  const SL = require(path.join(repo, "stageleave"));
  SL._setClock(() => T);
  await SL.init();
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("DELETE FROM dm_blocks");
  // runs on its own too (--test-name-pattern): the site switch on, cold opens on; put back as they were in the finally
  const was = MF.current().cfg;
  await MF.setKill(STAFF, true, "test");
  await MF.setCfg(ADMIN, { cold_open: true, reason: "test" });
  const reasons = async () => (await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = 'alice' ORDER BY id")).map((r) => r.end_reason);
  /** alice keeps the mic for 2 minutes (Pepe's sync every 10 s): how many of those steps showed her, and the spans written */
  async function keepMic() {
    const n0 = (await reasons()).length;
    let shown = 0;
    for (let i = 0; i < 12; i++) {
      await at(10, ["alice"]);
      for (let k = 0; k < 5; k++) await settle();
      await MF._idle();
      if (tileOn("alice")) shown++;
    }
    return { shown, spans: (await reasons()).slice(n0) };
  }
  const relayLetGo = () => { const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice")); return !S || S.ended || !S.holds.has("mf:" + ROOM.id); };
  try {
    // a) she took herself off this pad's Stage before she grabs the mic: never picked, nothing written
    await reset(); await plainPad();
    await SL.leave({ roomId: ROOM.id, login: "alice", userId: "u_alice", via: "web" }, T);
    let r = await keepMic();
    assert.equal(r.shown, 0, "never on the mic stage while the take-off runs");
    assert.deepEqual(r.spans, [], "no span at all");
    // b) she is ON the mic stage and takes herself off: off at once, the neutral reason, the relay let go - and she stays off
    await runQuery("DELETE FROM stage_leave"); await SL.load(T);
    await reset(); await plainPad();
    await onStage(["alice"]);
    assert.equal(tile("alice").video, "live", "set up");
    await SL.leave({ roomId: ROOM.id, login: "alice", userId: "u_alice", via: "web" }, T);
    assert.equal(tileOn("alice"), false, "off at once (stageleave.leave steps the pad: micfollow.onStageLeave)");
    assert.ok(relayLetGo(), "the mic stage let go of her relay");
    for (let k = 0; k < 5; k++) await settle();
    assert.equal((await reasons()).slice(-1)[0], "cut:unavailable", "the neutral reason - never which");
    r = await keepMic();
    assert.equal(r.shown, 0, "stays off");
    assert.deepEqual(r.spans, [], "no re-pick / refusal / cut cycle");
    // ... and is back once it runs out (1 h)
    T += SL.LEAVE_MS;
    await at(1, ["alice"]); await at(3, ["alice"]);
    assert.equal(tileOn("alice"), true, "the hour is up: back");
    await runQuery("DELETE FROM stage_leave"); await SL.load(T);
    // c) a DM block either way with the pad's owner (stageConsent's other block rule): off, and stays off; lifted: back
    for (const [blocker, blocked] of [["u_alice", "u_owner"], ["u_owner", "u_alice"]]) {
      const name = blocker + " blocked " + blocked;
      await reset(); await plainPad();
      await onStage(["alice"]);
      assert.equal(tileOn("alice"), true, name + ": set up");
      await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [blocker, blocked, T]);
      await MF.recheck("alice", { refresh: true });
      assert.equal(tileOn("alice"), false, name + ": off");
      assert.ok(relayLetGo(), name + ": the relay let go");
      for (let k = 0; k < 5; k++) await settle();
      assert.equal((await reasons()).slice(-1)[0], "cut:unavailable", name + ": the neutral reason");
      r = await keepMic();
      assert.equal(r.shown, 0, name + ": stays off");
      assert.deepEqual(r.spans, [], name + ": no re-pick / refusal / cut cycle");
      await runQuery("DELETE FROM dm_blocks");
      await MF.recheck("alice", { refresh: true });
      await at(1, ["alice"]); await at(3, ["alice"]);
      assert.equal(tileOn("alice"), true, name + ": lifted - back");
    }
    // d) a DM block between her and someone who isn't the pad's owner keeps her on (that viewer just gets no picture - test 41)
    await reset(); await plainPad();
    await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_alice', 'u_v3', ?)", [T]);
    await onStage(["alice"]);
    assert.equal(tileOn("alice"), true, "a block with a viewer isn't one with the pad's owner");
  } finally {
    await runQuery("DELETE FROM stage_leave"); await SL.load(T);
    await runQuery("DELETE FROM dm_blocks");
    await MF.setCfg(ADMIN, { cold_open: was.cold_open, reason: "test" });
    await MF.setKill(STAFF, was.enabled, "test");
  }
});

// ── mfix (owner 2026-10-25): recent speakers, 📌 pins, refusal scoping, the kept layout, the card reasons, cfg rev 2 ──
const PINM = require(path.join(repo, "stagepin"));

test("51. mfix recent speakers: a split pad with keep_recent - a back-and-forth on one mic keeps both up; the recent one keeps its relay; only the holder is the newest", async () => {
  await reset();
  await MF.setPad(ROOM.id, { on: true, layout: "split", keep_recent: 2 }, "test");
  try {
    await onStage(["alice"]);
    await at(3, ["bob"]); await at(3, ["bob"]);
    up("bob"); await at(1, ["bob"]);
    assert.deepEqual(tiles().sort(), ["alice", "bob"], "alice stays up while bob talks");
    const snap = MF.snapshot(ROOM.id);
    assert.equal(snap.layout, "split");
    assert.equal(snap.tiles.find((x) => x.login === "alice").recent, true);
    assert.equal(snap.tiles.find((x) => x.login === "alice").newest, false);
    assert.equal(snap.tiles.find((x) => x.login === "bob").newest, true, "the one holding the mic is the newest");
    const sa = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.ok(sa && !sa.ended && sa.holds.has("mf:" + ROOM.id), "alice's relay stays held - no cold open when she talks again");
    // alice talks again: just holds again (no change, no new open)
    const holds0 = (await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans WHERE login = 'alice'"))[0].n;
    await at(3, ["alice"]); await at(3, ["alice"]);
    assert.deepEqual(tiles().sort(), ["alice", "bob"]);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans WHERE login = 'alice'"))[0].n, holds0, "the same span - she never left");
    assert.equal(MF.snapshot(ROOM.id).tiles.find((x) => x.login === "alice").newest, true);
    // nobody talks for 2 minutes: both leave (keep_recent), then the stage is empty
    await at(60, []); await at(65, []);
    assert.deepEqual(tiles(), ["alice"], "bob (off the mic since alice took it back) left after keep_recent; alice stays up (the last one on)");
    await at(60, []);
    assert.deepEqual(tiles(), [], "2 minutes after she let go: the stage is empty");
  } finally { await MF.setPad(ROOM.id, { layout: "auto", keep_recent: 0 }, "test"); }
});

test("52. mfix 📌 pins: the pad's owner pins a cam (held by its pin - a manual holder, not in relays_max); it takes the first place, makes the stage the default, viewers' tickets come through it; the person isn't a second tile; unpin", async () => {
  await reset(); await plainPad();
  await bot(); room([]);
  let r = await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl" }, "u_v1");
  assert.equal(r.status, 403, "only the pad's owner / staff");
  r = await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl" }, "u_owner");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.pinned, true);
  const pin = MF.pinOf(ROOM.id, "carl");
  assert.ok(pin && pin.holder.startsWith("pin:"));
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "carl"));
  assert.ok(S && S.holds.has(pin.holder) && !S.mf, "held by the pin - opened like a cam slot");
  assert.equal(LC.mfOnlyCount(T), 0, "not counted in relays_max (never yielded to ▶ Live)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_pins WHERE room_id = ?", [ROOM.id]))[0].n, 1, "kept across a restart");
  up("carl"); await bot();
  let snap = MF.snapshot(ROOM.id);
  assert.deepEqual([snap.tiles[0].login, snap.tiles[0].pin, snap.tiles[0].video], ["carl", true, "live"]);
  assert.equal(snap.active, true, "a pinned live picture: the mic stage can be the default ('First') with nobody on the mic");
  const v = await MF.viewFor(snap, R, "u_v1", null);
  assert.equal(v.src[0].pin, true);
  assert.equal(v.count, 0, "mfix review: nobody is on the mic - the 🎙 tab's count never counts a pinned cam");
  assert.equal(v.pins_n, 1, "...the pins have their own count");
  const w = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "carl", pin: true }, "u_v1");
  assert.ok(w.d.whep, JSON.stringify(w.d));
  // the pinned person grabs the mic: no second (mic) tile, and their pin is the newest speaker
  await step(["carl"]); await at(3, ["carl"]);
  assert.deepEqual(tiles(), []);
  snap = MF.snapshot(ROOM.id);
  assert.equal(snap.tiles.length, 1);
  assert.equal(snap.tiles[0].newest, true, "their pin is highlighted while they talk");
  // someone else on the mic shows beside the pin
  await at(3, ["dana"]); await at(3, ["dana"]);
  assert.deepEqual(tiles(), ["dana"]);
  snap = MF.snapshot(ROOM.id);
  assert.deepEqual(snap.tiles.map((x) => x.login), ["carl", "dana"], "the pin first, then the mic");
  // the list to pick from (owners only)
  assert.equal((await get(`/api/rooms/${slug()}/micfollow/pins`, "u_v1")).status, 403);
  const list = await get(`/api/rooms/${slug()}/micfollow/pins`, "u_owner");
  assert.ok(list.d.cams.some((c) => c.login === "carl" && c.pinned), JSON.stringify(list.d));
  assert.equal(list.d.room, 2);
  // unpin
  r = await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl", remove: true }, "u_owner");
  assert.equal(r.d.unpinned, true);
  assert.equal(MF.pinOf(ROOM.id, "carl"), null);
  assert.ok(!S.holds.has(pin.holder), "the pin let go of the relay");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_pins WHERE room_id = ?", [ROOM.id]))[0].n, 0);
});

test("53. mfix 📌 pins respect every cam rule: the mic-stage switch, the live-video opt-out, cam access followers / request, the level never / off (an ask - Allow pins it), a reported hold-out, not on cam; at most pins_max leaving a mic place", async () => {
  await reset(); await plainPad();
  await bot(); room([]);
  PINM._setClock(() => T);
  // (MF.pinPut straight - the route's own rate limit is per minute of real time; test 52 covers the route)
  const pinIt = (login) => MF.pinPut({ userId: "u_owner", username: "padowner" }, ROOM.id, login, T).then((r) => ({ d: { ok: true, ...r } }), (e) => ({ d: { ok: false, code: e.code, error: e.message } }));
  try {
    await MF.setOptout("bob", true);
    assert.equal((await pinIt("bob")).d.code, "unavailable", "the mic-stage switch off: never pinned there either");
    await MF.setOptout("bob", false);
    await LC.setOptout("dana", true);
    assert.equal((await pinIt("dana")).d.code, "opted_out");
    await LC.setOptout("dana", false);
    await CA.setMode("fay", "followers");
    assert.equal((await pinIt("fay")).d.code, "mode_closed", "a cam only for some viewers can't go on a stage");
    await CA.setMode("fay", "everyone");
    await PINM.setLevel("alice", "never");
    assert.equal((await pinIt("alice")).d.code, "unavailable", "their level 'never'");
    await PINM.setLevel("alice", "on");
    assert.equal((await pinIt("erin")).d.code, "left_cam", "not on cam");
    await MF.excludeFor(ROOM.id, "carl", 60, "reported", "reports");
    assert.equal((await pinIt("carl")).d.code, "unavailable", "a reported hold-out (staff review) stops a pin");
    await MF.unexclude(ROOM.id, "carl");
    await MF.excludeFor(ROOM.id, "carl", 60, "owner", "padowner");
    const ov = await pinIt("carl");
    assert.equal(ov.d.pinned, true, "the owner's own exclusion: a pin overrides it (they chose this person) " + JSON.stringify(ov.d));
    await MF.unexclude(ROOM.id, "carl");
    // level off: an ask first - nothing goes up until they allow it; Allow pins it on the mic stage
    await PINM.setLevel("bob", "off");
    const a = await pinIt("bob");
    assert.equal(a.d.asked, true, JSON.stringify(a.d));
    assert.equal(MF.pinOf(ROOM.id, "bob"), null);
    const ask = (await getQuery("SELECT * FROM stage_asks WHERE id = ?", [a.d.ask.id]))[0];
    assert.equal(ask.slot_id, "mic", "the ask remembers it's for the mic stage");
    const ans = await PINM.answer(a.d.ask.id, "yes", { userId: "u_bob" }, "web", T);
    assert.equal(ans.put, true, JSON.stringify(ans));
    assert.ok(MF.pinOf(ROOM.id, "bob"), "pinned once they said yes");
    // pins_max 2 on a 4-person pad: the third is refused (a mic place always stays)
    assert.equal((await pinIt("dana")).d.code, "pins_full");
  } finally {
    for (const l of ["carl", "bob", "dana"]) await MF.unpin(ROOM.id, l, "test", "system");
    await PINM.setLevel("bob", "on"); await PINM.dropYes(ROOM.id, "bob");
    await MF.setOptout("bob", false); await LC.setOptout("dana", false); await CA.setMode("fay", "everyone");
    PINM._setClock(null);
  }
});

test("54. mfix 📌 a pin ends when the cam goes away (off cam), the person takes themselves off the stage, mic follows stops on the pad, or pin_max_min passes", async () => {
  await reset(); await plainPad();
  await bot(); room([]);
  // (MF.pinPut straight - the route's own rate limit is per minute of real time; test 52 covers the route)
  const pinIt = (login) => MF.pinPut({ userId: "u_owner", username: "padowner" }, ROOM.id, login, T).then((r) => ({ d: { ok: true, ...r } }), (e) => ({ d: { ok: false, code: e.code, error: e.message } }));
  assert.equal((await pinIt("carl")).d.pinned, true);
  // off cam -> unpinned by the pin check
  const members = MEMBERS().map((m) => (m.login === "carl" ? { ...m, on_cam: false } : m));
  room([], { members });
  await MF.pinTick(T);
  assert.equal(MF.pinOf(ROOM.id, "carl"), null, "the cam went away");
  // "Take me off this Stage" (stageleave) -> at once
  room([]);
  assert.equal((await pinIt("dana")).d.pinned, true);
  const SL = require(path.join(repo, "stageleave"));
  SL._setClock(() => T);
  try {
    await SL.leave({ roomId: ROOM.id, login: "dana", via: "web" }, T);
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(MF.pinOf(ROOM.id, "dana"), null, "off this pad's stage at once");
    assert.equal((await pinIt("dana")).d.code, "unavailable", "and can't be pinned back meanwhile");
  } finally { await runQuery("DELETE FROM stage_leave"); await SL.load(T); SL._setClock(null); }
  // mic follows off on the pad: pins go too
  assert.equal((await pinIt("fay")).d.pinned, true);
  await MF.setPad(ROOM.id, { on: false }, "test");
  assert.equal(MF.pinOf(ROOM.id, "fay"), null);
  await MF.setPad(ROOM.id, { on: true }, "test");
  // its row deleted (an account deletion: accountdelete.js deletes the pins of / by the account) -> ends at the next check
  await bot(); room([]);
  assert.equal((await pinIt("dana")).d.pinned, true);
  await runQuery("DELETE FROM micfollow_pins WHERE login = 'dana'");
  await MF.pinTick(T);
  assert.equal(MF.pinOf(ROOM.id, "dana"), null, "its row is gone: the pin ends");
  // pin_max_min
  await bot(); room([]);
  assert.equal((await pinIt("fay")).d.pinned, true);
  T += (MF.cfg().pin_max_min + 1) * 60 * 1000; await bot(); room([]);
  await MF.pinTick(T);
  assert.equal(MF.pinOf(ROOM.id, "fay"), null, "expired");
});

test("55. mfix: Pepe's refusal of an EXACT (mic-stage) open of a relay a ▶ Live viewer also watches lets only the mic stage go; a refusal about an older session never ends a newer one", async () => {
  await reset(); await plainPad();
  await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "dana", T);
  up("dana"); EXACT.delete("dana");
  await bot({ live: [{ room: ROOM.id, login: "dana", state: "live", exact: false }] });
  await step(["dana"]); await at(3, ["dana"]);
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "dana"));
  assert.ok(S.holds.has("mf:" + ROOM.id), "the mic stage holds the warm relay");
  assert.ok((await bot({ live: [] })).want.find((x) => x.login === "dana").sid === S.sid, "want[] carries the session's id");
  LC.beat("u_v1", ROOM.id, "dana", T);
  await bot({ live: [], refused: [{ room: ROOM.id, login: "dana", why: "not_that_cam", x: true, sid: S.sid }] });
  assert.ok(!S.ended, "the ▶ Live viewer keeps the relay");
  assert.ok(!S.holds.has("mf:" + ROOM.id), "the mic stage let go");
  assert.equal(tile("dana").why, "retry", "a soft failure: another try soon, not 10 minutes");
  // a refusal about an older session of that cam (Pepe re-sends one for 30 s) never ends a newer one
  await LC.start({ userId: "u_v3", username: "viewer3" }, room([]), "fay", T);
  const F = LC._sessions.get(LC.keyOf(ROOM.id, "fay"));
  await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: "open_failed", sid: "0123456789ab" }] });
  assert.ok(!F.ended, "an older session's refusal");
  await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: "open_failed", sid: F.sid }] });
  assert.ok(F.ended, "its own refusal ends it as before");
  // an older Pepe (no sid): as before
  await LC.start({ userId: "u_alice", username: "alice_patv" }, room([]), "carl", T);
  const C2 = LC._sessions.get(LC.keyOf(ROOM.id, "carl"));
  await bot({ live: [], refused: [{ room: ROOM.id, login: "carl", why: "open_failed" }] });
  assert.ok(C2.ended);
});

test("56. mfix: the owner's stage-bar layout is kept across an empty stage and a restart; saving the pad's own layout replaces it; the card says why there's no picture", async () => {
  await reset(); await plainPad();
  assert.equal(await MF.setOverride(ROOM.id, "split"), "split");    // (the owner's bar route: "owner routes" above)
  await onStage(["alice"]); await at(10, []); await at(40, []);
  assert.deepEqual(tiles(), []);
  assert.equal(MF.snapshot(ROOM.id).override, "split", "not dropped when the stage empties");
  const row = (await getQuery("SELECT layout_override FROM micfollow_pads WHERE room_id = ?", [ROOM.id]))[0];
  assert.equal(row.layout_override, "split", "kept across a restart");
  await MF.setPad(ROOM.id, { layout: "grid" }, "test");
  assert.equal(MF.snapshot(ROOM.id).override, null, "the owner saved the pad's own layout: the bar's choice goes");
  await MF.setPad(ROOM.id, { layout: "auto" }, "test");
  // the card reasons reach the page (viewFor)
  await MF.setCfg(ADMIN, { cold_open: false, reason: "test" });
  try {
    await reset(); await plainPad();
    await step(["fay"]); await at(3, ["fay"]);
    const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
    assert.equal(v.src[0].why, "cold_off", "cold opens off - not 'live cams are full'");
  } finally { await MF.setCfg(ADMIN, { cold_open: true, reason: "test" }); }
});

test("57. mfix cfg rev 2: a saved row still holding the old defaults moves to the new ones once (audited as system); a knob set otherwise stays; an admin's later choice sticks", async () => {
  await runQuery("UPDATE micfollow_cfg SET data = ? WHERE id = 1",
                 [JSON.stringify({ ...core.DEFAULTS, enabled: true, cold_open: false, relays_max: 2, cold_opens_per_min: 7, cold_opens_per_pad: 2, max_live: 4 })]);
  MF._reset(); await MF._ready();
  const c = MF.cfg();
  // mfix review: prod - cold opens stay as saved (staff switch them on at /stage/admin: the owner's OK / V-2, V-3, V-5)
  assert.deepEqual([c.cold_open, c.relays_max, c.cold_opens_per_min, c.cold_opens_per_pad, c.max_live], [false, 6, 7, 6, 6], "7 a minute was set on purpose: kept");
  const row = (await getQuery("SELECT data, updated_by FROM micfollow_cfg WHERE id = 1"))[0];
  assert.equal(JSON.parse(row.data)._rev, MF.CFG_REV);
  assert.equal(row.updated_by, "system");
  const au = (await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'micfollow_cfg' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(au.admin_id, "system");
  assert.equal(JSON.parse(au.detail).action, "migrate");
  // ...staging: cold opens move to on by themselves too
  await runQuery("UPDATE micfollow_cfg SET data = ? WHERE id = 1",
                 [JSON.stringify({ ...core.DEFAULTS, enabled: true, cold_open: false, relays_max: 2, cold_opens_per_min: 4, cold_opens_per_pad: 2, max_live: 4 })]);
  process.env.STAGING = "1";
  try { MF._reset(); await MF._ready(); } finally { delete process.env.STAGING; }
  const cs = MF.cfg();
  assert.deepEqual([cs.cold_open, cs.relays_max, cs.cold_opens_per_min, cs.cold_opens_per_pad, cs.max_live], [true, 6, 10, 6, 6], "staging: every old default moves");
  await MF.setCfg(ADMIN, { cold_open: false, reason: "test" });
  MF._reset(); await MF._ready();
  assert.equal(MF.cfg().cold_open, false, "an admin's choice after the move sticks across a restart");
  await MF.setCfg(ADMIN, { cold_open: true, reason: "test" });
  for (const l of ["alice", "bob", "carl", "dana", "erin", "fay"]) await MF._noticed(ROOM.id, l, 1);
});

// ── mfix review (2026-10-25) ──
const pinBy = (login) => MF.pinPut({ userId: "u_owner", username: "padowner" }, ROOM.id, login, T).then((r) => ({ d: { ok: true, ...r } }), (e) => ({ d: { ok: false, code: e.code, error: e.message } }));

test("58. mfix review: ⚑ a viewer reports a 📌 pinned cam - hidden for them (no ticket through the pin), two qualified reporters unpin it at once; one unpinned a moment ago can still be reported", async () => {
  await reset(); await plainPad();
  await runQuery("DELETE FROM micfollow_reports");
  await bot(); room([]);
  let r = await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl" }, "u_owner");
  assert.equal(r.d.pinned, true, JSON.stringify(r.d));
  up("carl"); await bot();
  const pin = MF.pinOf(ROOM.id, "carl");
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "carl"));
  let w = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "carl", pin: true }, "u_v1");
  assert.ok(w.d.whep, JSON.stringify(w.d));
  assert.ok(S.stageViewers.has("u_v1"));
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "carl", reason: "sexual" }, "u_v1");
  assert.equal(r.status, 200, "a pinned cam is on the mic stage - it can be reported " + JSON.stringify(r.d));
  assert.deepEqual([r.d.hidden, r.d.qualified, r.d.cut], [true, true, false]);
  assert.ok(!S.stageViewers.has("u_v1"), "their live view through the pin ends now");
  const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
  assert.equal(v.src.find((s) => s.id === "carl").watch, "hidden", "hidden for the reporter");
  w = await post(`/api/rooms/${slug()}/micfollow/watch`, { login: "carl", pin: true }, "u_v1");
  assert.equal(w.d.code, "hidden", "no ticket through the pin for a cam you reported");
  assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v3", null)).src.find((s) => s.id === "carl").watch, "ok", "everyone else still sees it");
  // a second distinct qualified reporter: cut - the pin comes off at once (not at the next pin check) and can't go back up
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "carl", reason: "sexual" }, "u_v3");
  assert.deepEqual([r.d.qualified, r.d.cut], [true, true], JSON.stringify(r.d));
  assert.equal(MF.pinOf(ROOM.id, "carl"), null, "unpinned at once");
  assert.ok(!S.holds.has(pin.holder), "the pin let go of the relay");
  assert.equal((await pinBy("carl")).d.code, "unavailable", "held out (staff review): no pin");
  await MF.unexclude(ROOM.id, "carl");
  // a cam unpinned a moment ago can still be reported (REPORT_RECENT_MS), not after
  room([]);
  assert.equal((await pinBy("dana")).d.pinned, true);
  await MF.unpin(ROOM.id, "dana", "unpinned", "padowner");
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "dana", reason: "abuse" }, "u_v2");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  T += 3 * 60 * 1000;
  r = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "dana", reason: "abuse" }, "u_v2");
  assert.equal(r.d.code, "gone");
});

test("59. mfix review: 🧹 Clear the stage takes 📌 pinned cams off too (their relays let go) - everyone off, frozen", async () => {
  await reset(); await plainPad();
  await bot(); room([]);
  assert.equal((await pinBy("dana")).d.pinned, true);
  const pin = MF.pinOf(ROOM.id, "dana");
  await onStage(["alice"]);
  up("dana"); await bot();
  assert.deepEqual(MF.snapshot(ROOM.id).tiles.map((x) => x.login), ["dana", "alice"]);
  const r = await post(`/api/rooms/${slug()}/micfollow/clear`, {}, "u_owner");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(MF.pinOf(ROOM.id, "dana"), null, "the pin is off");
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "dana"));
  assert.ok(!S || S.ended || !S.holds.has(pin.holder), "its relay let go");
  assert.deepEqual(MF.snapshot(ROOM.id).tiles, [], "nobody on the stage");
  await post(`/api/rooms/${slug()}/micfollow/freeze`, { minutes: 0 }, "u_owner");
});

test("60. mfix review: a pin's relay ending for a PASSING reason (Pepe busy, a slow open, his cams full) is held again after a short wait - up to 3 times in a row; a cam that went away ends it", async () => {
  await reset(); await plainPad();
  await bot(); room([]);
  assert.equal((await pinBy("fay")).d.pinned, true);
  const pin = MF.pinOf(ROOM.id, "fay");
  const key = LC.keyOf(ROOM.id, "fay");
  const S = LC._sessions.get(key);
  await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: "busy", sid: S.sid }] });
  assert.ok(S.ended && S.endWhy === "busy");
  assert.ok(MF.pinOf(ROOM.id, "fay"), "a passing reason never ends the pin");
  const t0 = MF.snapshot(ROOM.id).tiles[0];
  assert.deepEqual([t0.login, t0.video, t0.why], ["fay", "card", "retry"], "its tile says it's trying again");
  room([]); await MF.pinTick(T);
  assert.equal(LC._sessions.get(key), S, "not before the wait is over");
  T += 16 * 1000; await bot(); room([]);
  await MF.pinTick(T);
  const S2 = LC._sessions.get(key);
  assert.ok(S2 && S2 !== S && !S2.ended && S2.holds.has(pin.holder), "held again after the wait");
  up("fay"); await bot(); room([]); await MF.pinTick(T);
  assert.equal(pin.fails, 0, "a picture again: a later passing failure starts over");
  // three passing failures in a row, then the fourth ends it
  let cur = S2;
  const passing = ["open_failed", "spawn_failed", "busy"];       // (start_timeout is the site's own sweep - the same path)
  for (let i = 1; i <= 3; i++) {
    await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: passing[i - 1], sid: cur.sid }] });
    assert.ok(MF.pinOf(ROOM.id, "fay"), "try " + i + ": still pinned");
    T += (i * 15 + 1) * 1000; await bot({ live: [] }); room([]);
    await MF.pinTick(T);
    cur = LC._sessions.get(key);
    assert.ok(cur && !cur.ended && cur.holds.has(pin.holder), "try " + i + ": held again");
  }
  await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: "busy", sid: cur.sid }] });
  assert.equal(MF.pinOf(ROOM.id, "fay"), null, "the fourth in a row: the pin ends");
  // a cam that went away (not a passing reason) ends it at once
  room([]);
  assert.equal((await pinBy("fay")).d.pinned, true);
  const S3 = LC._sessions.get(key);
  await bot({ live: [], refused: [{ room: ROOM.id, login: "fay", why: "not_on_cam", sid: S3.sid }] });
  assert.equal(MF.pinOf(ROOM.id, "fay"), null, "off cam: the pin ends");
});

test("61. mfix review: an exact refusal of a relay that's LIVE for a ▶ Live viewer (Pepe put it back the ordinary way) lets only the mic stage go; one from before the mic stage's latest hold is ignored; want[].shared", async () => {
  await reset(); await plainPad();
  await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "dana", T);
  up("dana"); EXACT.delete("dana");
  const liveDana = [{ room: ROOM.id, login: "dana", state: "live", exact: false }];
  await bot({ live: liveDana });
  await step(["dana"]); await at(3, ["dana"]);
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "dana"));
  assert.ok(S.holds.has("mf:" + ROOM.id) && S.mfHeldAt, "the mic stage holds the warm relay");
  LC.beat("u_v1", ROOM.id, "dana", T);
  let ans = await bot({ live: liveDana });
  assert.equal(ans.want.find((x) => x.login === "dana").shared, true, "want[].shared: a ▶ Live viewer uses it too");
  // Pepe re-sends a refusal for 30 s: one from before this hold is about an earlier hold - ignored
  const ago = (T - S.mfHeldAt) / 1000;
  await bot({ live: liveDana, refused: [{ room: ROOM.id, login: "dana", why: "noswitch", x: true, sid: S.sid, age: ago + 10 }] });
  assert.ok(S.holds.has("mf:" + ROOM.id), "an exact refusal older than the mic stage's hold changes nothing");
  // a fresh one while the relay is live (put back the ordinary way): only the mic stage lets go
  T += 2000; LC.beat("u_v1", ROOM.id, "dana", T);
  await bot({ live: liveDana, refused: [{ room: ROOM.id, login: "dana", why: "noswitch", x: true, sid: S.sid, age: 0.5 }] });
  assert.ok(!S.ended, "the ▶ Live viewer keeps the relay");
  assert.ok(!S.holds.has("mf:" + ROOM.id), "the mic stage let go");
  assert.equal(tile("dana").why, "retry", "a soft failure: another try soon");
  ans = await bot({ live: liveDana });
  const wd = ans.want.find((x) => x.login === "dana");
  assert.ok(wd && !wd.mf && !wd.shared, "no longer asked for exactly");
  // an ordinary (not exact) refusal of a live session is still ignored, as before
  await bot({ live: liveDana, refused: [{ room: ROOM.id, login: "dana", why: "open_failed", sid: S.sid }] });
  assert.ok(!S.ended, "a live relay outlives an ordinary refusal");
});

test("62. mfix review: 'First' - a new speaker's tile whose cam is opening (starting) makes the mic stage the default at once; a stage of only reason cards still doesn't; a pad's own max_live goes up to 6", async () => {
  await reset(); await plainPad();
  await step(["alice"]); await at(3, ["alice"]);
  assert.equal(tile("alice").video, "starting", "a cold open on its way");
  assert.equal(MF.snapshot(ROOM.id).active, true, "the stage is the default while the cam opens (no Pepe's stream first)");
  await MF.setCfg(ADMIN, { cold_open: false, reason: "test" });
  try {
    await reset(); await plainPad();
    await step(["fay"]); await at(3, ["fay"]);
    assert.equal(tile("fay").why, "cold_off");
    assert.equal(MF.snapshot(ROOM.id).active, false, "only a reason card: never the default (DF-15)");
  } finally { await MF.setCfg(ADMIN, { cold_open: true, reason: "test" }); }
  const was = LC.cfg().max_live;
  await LC.save(ADMIN, { cfg: { max_live: 12 } });
  try {
    assert.equal((await MF.ownerState(ROOM.id)).max_live_cap, 6, "a pad owner may raise max_live to 6 (no fixed 4)");
    const s = await MF.setPad(ROOM.id, { max_live: 6 }, "test");
    assert.equal(s.max_live, 6);
  } finally { await plainPad(); await LC.save(ADMIN, { cfg: { max_live: was } }); }
});

// ── 1.99afl: the incognito / mic-stage spec, F.1 S1-S3 (wired) ──
test("63. 1.99afl S2: a holder Pepe's roster can't classify (no on_cam) is 'checking their cam…' - no blind exact open; one after a complete read that began after the grab", async () => {
  await reset(); await plainPad();
  await MF._noticed(ROOM.id, "gus", 1);
  const withGus = (x) => ({ members: [...MEMBERS(), { login: "gus", display: "Gus" }], ...(x || {}) });   // in the room, cam unknown
  const sess = () => LC._sessions.has(LC.keyOf(ROOM.id, "gus"));
  await step(["gus"], withGus({ listAt: T - 60 * 1000, listFresh: true }));
  await at(3, ["gus"], withGus({ listAt: T - 60 * 1000, listFresh: true }));
  assert.deepEqual([tile("gus").video, tile("gus").why], ["card", "cam_unknown"], "never 'cam off', never a blind open");
  assert.equal(sess(), false);
  const v = await MF.viewFor(MF.snapshot(ROOM.id), bridge._rooms.get(ROOM.id), "u_v1", null, T);
  assert.equal(v.src.find((x) => x.id === "gus").why, "cam_unknown", "the program says why");
  await at(5, ["gus"], withGus({ listAt: T - 1000, listFresh: false }));
  assert.equal(sess(), false, "a stale read isn't enough");
  // review: Pepe through 1.99afk (his poll's mf 1) refuses such a cam at once ("not_on_cam", _lv_why_not) - the mic stage asks
  // for none, however many complete reads come: "checking their cam…" all along, never "cam off"
  for (let i = 0; i < 4; i++) {
    await at(20, ["gus"], withGus({ listAt: T - 1000, listFresh: true }));
    assert.equal(sess(), false, "no exact open with today's Pepe (" + i + ")");
    assert.deepEqual([tile("gus").video, tile("gus").why], ["card", "cam_unknown"]);
  }
  assert.equal(MF.health(MF._pads.get(ROOM.id), bridge._rooms.get(ROOM.id), T).list.fresh, true);
  // a Pepe that opens such a cam by its exact name (mf >= MF_UNK_OPEN): one exact open per complete read after the grab ...
  const sessOn = () => { const S = LC._sessions.get(LC.keyOf(ROOM.id, "gus")); return !!S && !S.ended; };
  const bot2 = (x) => LC.forBot(Object.assign({ cap: true, mf: 2, live: [] }, x || {}), T);
  T += 1000; await bot2();
  await step(["gus"], withGus({ listAt: T - 500, listFresh: true }));
  assert.equal(sessOn(), true, "a complete read after the grab that still can't say: one exact open");
  const S = LC._sessions.get(LC.keyOf(ROOM.id, "gus"));
  // ... which Pepe refuses "not_on_cam" when the cam isn't on: still "checking their cam…" - not "cam off" - and no other open
  // before the next complete read
  T += 2000;
  await bot2({ refused: [{ room: ROOM.id, login: "gus", why: "not_on_cam", x: true, age: 0.5, sid: S.sid }] });
  await until(() => !sessOn());
  assert.equal(sessOn(), false, "Pepe's refusal ended it");
  await step(["gus"], withGus({ listAt: T - 2500, listFresh: true }));
  assert.deepEqual([tile("gus").video, tile("gus").why], ["card", "cam_unknown"], "a refusal while the roster can't say isn't 'cam off'");
  assert.ok(!MF._pads.get(ROOM.id).state.offcam.has("gus"));
  for (let i = 0; i < 3; i++) { T += 5000; await bot2(); await step(["gus"], withGus({ listAt: T - 2500 - (i + 1) * 5000, listFresh: true })); }
  assert.equal(sessOn(), false, "one exact open per list-read epoch");
  assert.equal(tile("gus").why, "cam_unknown");
  // a RUNNING relay Pepe stops himself "not_on_cam" when his roster's on_cam goes unknown: "checking their cam…" too
  await reset(); await plainPad(); await bot();
  await onStage(["dana"]);
  assert.equal(tile("dana").video, "live");
  const noCam = (x) => Object.assign({}, x, { members: x.members.map((m) => (m.login === "dana" ? { login: "dana", display: "Dana" } : m)) });
  await at(1, ["dana"], noCam({ members: MEMBERS(), listAt: T - 500, listFresh: true }));
  assert.equal(tile("dana").video, "live", "the site never ends a live relay for cam_unknown");
  EXACT.delete("dana");
  await bot({ live: [], refused: [{ room: ROOM.id, login: "dana", why: "not_on_cam" }] });
  const danaOn = () => { const D = LC._sessions.get(LC.keyOf(ROOM.id, "dana")); return !!D && !D.ended; };
  await until(() => !danaOn());
  assert.equal(danaOn(), false);
  await step(["dana"], noCam({ members: MEMBERS(), listAt: T - 500, listFresh: true }));
  assert.deepEqual([tile("dana").video, tile("dana").why], ["card", "cam_unknown"], "never 'cam off' for a cam the roster can't classify");
});

test("64. 1.99afl S1 / S1b / S3: Pepe's still result code - busy retries soon (no backoff), list_unread pauses the room; /stage/admin's pad health; the 'can't read the list' alert", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { relays_max: 0, stills: true, stills_max: 4 });
  const app = express(); app.use(express.json());
  relay.register(app, { isBotToken: (t) => t === "bot", addUser: (q, s, n) => n(), bySlug: bridge.bySlug, isLive: () => true });
  const srv = app.listen(0);
  try {
    const answer = (login, code) => {
      const j = [...relay._jobs.values()].reverse().find((x) => x.kind === "snap" && x.mf === true && x.target === login);
      return fetch("http://127.0.0.1:" + srv.address().port + "/api/bridge/snap", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "bot", id: j.id, room: ROOM.id, target: login, ok: false, status: "busy", ...(code ? { code } : {}) }) });
    };
    await step(["bob"]); await at(3, ["bob"]);
    assert.equal(tile("bob").video, "still");
    await answer("bob", "busy");
    assert.deepEqual([tile("bob").video, tile("bob").why], ["card", "retry"], "a soft refusal: another try soon");
    const P = MF._pads.get(ROOM.id);
    assert.ok(!(P.state.backoff.get("bob") > T), "never the 10-minute backoff for a busy still");
    await at(1, ["bob"]);
    assert.notEqual(tile("bob").video, "still", "no still while the soft retry holds");
    await at(MF.cfg().soft_retry_s + 1, ["bob"]);
    assert.equal(tile("bob").video, "still", "tried again");
    // an older Pepe's refusal (no code) is soft too
    await answer("bob");
    assert.equal(tile("bob").why, "retry");
    await at(MF.cfg().soft_retry_s + 1, ["bob"]);
    assert.equal(tile("bob").video, "still");
    // Pepe can't read the room's list: the ROOM pauses, nothing counted against bob
    await answer("bob", "list_unread");
    assert.ok(P.state.listPause, "paused");
    assert.deepEqual([tile("bob").video, tile("bob").why], ["card", "list_unread"]);
    const view = await MF.adminView(STAFF, T);
    const row = view.pads.find((p) => p.room === ROOM.id);
    assert.ok(row.list && row.list.paused != null, "the health row shows the pause");
    assert.equal(row.fails_1h["still:busy"], 1);
    assert.equal(row.fails_1h["still:nocode"], 1);
    assert.equal(row.fails_1h["still:list_unread"], 1);
    assert.equal(row.cards.list_unread, 1);
    assert.equal(view.metrics.counts["still_refused:list_unread"], 1);
    // a newer complete read resumes it
    await at(2, ["bob"], { listAt: T + 2000, listFresh: true });
    assert.equal(P.state.listPause, null);
  } finally { srv.close(); await MF.setCfg(ADMIN, { relays_max: 2 }); }
  // S3: no complete read for > 10 minutes while someone holds the mic -> the site's Admins get one alert (an inbox notice)
  const notes = async () => (await getQuery("SELECT title FROM inbox WHERE user_id = 'u_admin' AND title LIKE '%people list%'"));
  const before = (await notes()).length;
  room(["alice"], { listFresh: false, listAt: T - 11 * 60 * 1000 });
  const P = MF._pads.get(ROOM.id);
  P.alertAt = 0;
  P.state.running = true; P.state.whyOff = null;
  assert.equal(MF.listAlert(P, bridge._rooms.get(ROOM.id), T), true);
  await until(async () => (await notes()).length > before);
  for (let i = 0; i < 20 && (await notes()).length === before; i++) await settle();
  assert.equal((await notes()).length, before + 1, "one notice to the Admin");
  assert.equal(MF.listAlert(P, bridge._rooms.get(ROOM.id), T + 60 * 1000), false, "once per pad per 6 h");
  room(["alice"], { listFresh: false, listAt: T - 5 * 60 * 1000 });
  P.alertAt = 0;
  assert.equal(MF.listAlert(P, bridge._rooms.get(ROOM.id), T), false, "a read 5 minutes ago: no alert");
  room(["alice"], { listFresh: null, listAt: null });
  assert.equal(MF.listAlert(P, bridge._rooms.get(ROOM.id), T), false, "a Pepe that doesn't say: never");
  room([], { listFresh: false, listAt: T - 60 * 60 * 1000 });
  assert.equal(MF.listAlert(P, bridge._rooms.get(ROOM.id), T), false, "nobody on the mic: no alert");
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.2, J-10): kept ("warm") relays ──
/** alice on the stage live, then she lets go: her tile leaves (the last-on lock, then released). */
async function aliceLeaves() {
  await onStage(["alice"]);
  assert.equal(tile("alice").video, "live");
  // (MediaMTX's 5 s path sync keeps the relay "live" meanwhile - up() each time)
  for (let i = 0; i < 10 && tiles().length; i++) { up("alice"); await at(5, []); }
  assert.deepEqual(tiles(), []);
  up("alice");
}

test("65. wave2 F.2 warm keep: the leaving tile's relay stays up under 'mfw:' - counted in mfOnlyCount / relays_max, Pepe keeps it exact, NEVER watchable, 'warm' on the admin list; a comeback is live in the same step on the same relay", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { warm_keep_s: 180, warm_max: 3, cold_open: true, relays_max: 4, reason: "test" });
  try {
    await aliceLeaves();
    const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
    assert.ok(S && !S.ended, "the relay lives on");
    assert.ok(S.holds.has("mfw:" + ROOM.id) && !S.holds.has("mf:" + ROOM.id), "held warm, not by the stage");
    const st = LC.mfState(ROOM.id, "alice", T);
    assert.deepEqual([st.kept, st.held, st.state, st.exact, st.mfOnly], [true, false, "live", true, true]);
    assert.equal(LC.mfOnlyCount(T), 1, "a mic-stage relay for relays_max");
    assert.ok(MF.keptOf(ROOM.id, "alice"), "kept by the pad");
    assert.equal(MF.metrics(T).current.kept, 1);
    assert.equal(MF.metrics(T).counts.keep_kept, 1);
    // no ticket, ever: the route (no tile) and livecam itself (a warm holder)
    const w = await post("/api/rooms/" + slug() + "/micfollow/watch", { login: "alice" }, "u_v1");
    assert.equal(w.d.state, "ended");
    assert.ok(!w.d.whep);
    await assert.rejects(LC.stageWatch({ userId: "u_v1", username: "viewer1" }, room([]), "mfw:" + ROOM.id, { login: "alice" }), (e) => e.code === "gone");
    // Pepe is still asked for it by its exact name
    const want = (await bot()).want.find((x) => x.login === "alice");
    assert.ok(want && want.mf === true, "want[].mf");
    const row = (await LC.adminView()).sessions.find((x) => x.login === "alice");
    assert.ok(row && row.warm === true && row.warm_s > 0 && row.warm_s <= 180, "warm (mic stage, Ns left)");
    // she talks again: live in the step that puts her up - the same relay, no cold open
    const cold0 = MF.metrics(T).counts.cold_ok || 0;
    await step(["alice"]);
    T += 6000; up("alice"); await bot();                         // (held >= 2 s, and past the change budget's min_gap_s)
    await step(["alice"]);
    assert.equal(tile("alice").video, "live", "live in the step that put her up (server side)");
    assert.equal(LC._sessions.get(LC.keyOf(ROOM.id, "alice")), S, "the same relay");
    assert.ok(S.holds.has("mf:" + ROOM.id) && !S.holds.has("mfw:" + ROOM.id), "the stage holds it again");
    assert.equal(MF._pads.get(ROOM.id).state.kept.size, 0);
    assert.equal(MF.metrics(T).counts.keep_taken, 1);
    assert.equal(MF.metrics(T).counts.cold_ok || 0, cold0, "no cold open");
    assert.equal(MF.metrics(T).qualify_to_picture.keep.n, 1, "the comeback's latency");
  } finally { await MF.setCfg(ADMIN, { warm_keep_s: 0, relays_max: 2, reason: "test" }); }
});

test("66. wave2 F.2 eviction: a viewer's ▶ Live start and a cold open that need the room drop the kept relay first (least recently used); the warm_max budget", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { warm_keep_s: 180, warm_max: 3, cold_open: true, relays_max: 4, reason: "test" });
  await LC.save(ADMIN, { cfg: { max_live: 1 } });
  try {
    await aliceLeaves();
    assert.equal(LC.liveCount(), 1);
    const r = await LC.start({ userId: "u_v1", username: "viewer1" }, room([]), "fay", T);
    assert.ok(r && r.whep, "▶ Live went through (no slots_busy)");
    assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, "alice")).ended, "the kept relay made room");
    assert.equal(MF._pads.get(ROOM.id).state.kept.size, 0);
    assert.equal(MF.metrics(T).counts.keep_evicted, 1);
    assert.ok(MF.metrics(T).counts.yields_kept >= 1, "evicted before any live tile was asked to yield");
    LC.stop("u_v1", ROOM.id, "fay", T);
  } finally { await LC.save(ADMIN, { cfg: { max_live: 4 } }); }
  // relays_max 1: alice kept, bob's cold open needs her room - she goes first, his open proceeds in the same step
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { relays_max: 1, reason: "test" });
  try {
    await aliceLeaves();
    assert.ok(MF.keptOf(ROOM.id, "alice"));
    await step(["bob"]); up("alice"); await at(6, ["bob"]);
    assert.equal(MF.keptOf(ROOM.id, "alice"), null, "evicted for bob");
    assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, "alice")).ended);
    assert.ok(["starting", "live"].includes(tile("bob").video), "bob's open went ahead");
    assert.ok(MF._pads.get(ROOM.id).state.evictAt > 0, "the slots_busy retry window starts");
  } finally { await MF.setCfg(ADMIN, { relays_max: 4, reason: "test" }); }
  // warm_max 0 while one is kept: it ends at the next step (warm keep off)
  await reset(); await plainPad();
  try {
    await aliceLeaves();
    await MF.setCfg(ADMIN, { warm_max: 0, reason: "test" });
    await at(1, []);
    assert.equal(MF.keptOf(ROOM.id, "alice"), null);
    assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, "alice")).ended);
  } finally { await MF.setCfg(ADMIN, { warm_keep_s: 0, warm_max: 3, relays_max: 2, reason: "test" }); }
});

test("67. wave2 F.2: !livecam off, the mic-stage switch, private activity, an exclusion, 'Take me off this Stage' and mic follows off each end a kept relay at once", async () => {
  const cases = [
    ["!livecam off", async () => { await LC.setOptout("alice", true, { ts: T }); }, async () => { await LC.setOptout("alice", false, { ts: T + 1 }); }],
    ["the mic-stage switch", async () => { await MF.setOptout("alice", true); }, async () => { await MF.setOptout("alice", false); }],
    ["private activity", async () => { PRIV.add("alice"); await MF.recheck("alice", { refresh: true }); }, async () => { PRIV.delete("alice"); await MF.recheck("alice", { refresh: true }); }],
    ["an exclusion", async () => { await MF.excludeFor(ROOM.id, "alice", 60, "owner", "test"); }, async () => { await MF.unexclude(ROOM.id, "alice"); }],
    ["Take me off this Stage", async () => {
      const SL = require(path.join(repo, "stageleave"));
      SL._setClock(() => T); await SL.init();
      await SL.leave({ roomId: ROOM.id, login: "alice", userId: "u_alice", via: "web" }, T);
    }, async () => { const SL = require(path.join(repo, "stageleave")); await runQuery("DELETE FROM stage_leave"); await SL.load(T); }],
    ["mic follows off on the pad", async () => { await MF.setPad(ROOM.id, { on: false }, "test"); }, async () => { await plainPad(); }],
  ];
  await MF.setCfg(ADMIN, { warm_keep_s: 180, warm_max: 3, cold_open: true, relays_max: 4, reason: "test" });
  try {
    for (const [name, on, off] of cases) {
      await reset(); await plainPad();
      await aliceLeaves();
      assert.ok(MF.keptOf(ROOM.id, "alice"), name + ": kept");
      try {
        await on();
        await until(() => !MF.keptOf(ROOM.id, "alice"));
        assert.equal(MF.keptOf(ROOM.id, "alice"), null, name + ": no longer kept");
        const S = LC._sessions.get(LC.keyOf(ROOM.id, "alice"));
        assert.ok(!S || S.ended, name + ": the relay ended");
      } finally { await off(); }
    }
  } finally { await MF.setCfg(ADMIN, { warm_keep_s: 0, relays_max: 2, reason: "test" }); }
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.3, J-14): the dynamic layout ──
test("68. wave2 F.3 dynamic: dark until its switch (a pad can't pick it; a stored one shows as auto with no dyn); on: the legacy layout still goes out with dyn {n, t, main}, rings on every holder, the main moves at most every main_hold_s, a pin takes it only by the pinNew rule", async () => {
  // (1.99ahp: the dynamic layout WITHOUT stable slots - the knob off, today's main; with them: test/micfollow-slots.test.js)
  await reset(); await plainPad();
  assert.equal(MF.cfg().dynamic, false, "ships dark");
  let st = await MF.ownerState(ROOM.id);
  assert.ok(!st.layouts.includes("dynamic"), "not offered");
  await assert.rejects(MF.setPad(ROOM.id, { layout: "dynamic" }, "test"), (e) => e.status === 400);
  let r = await post(`/api/rooms/${slug()}/micfollow/layout`, { layout: "dynamic" }, "u_owner");
  assert.equal(r.status, 400, "nor on the stage bar");
  await MF.setCfg(ADMIN, { dynamic: true, main_hold_s: 15, stable_slots: false, reason: "test" });
  try {
    st = await MF.ownerState(ROOM.id);
    assert.ok(st.layouts.includes("dynamic"));
    await MF.setPad(ROOM.id, { layout: "dynamic" }, "test");
    await onStage(["alice"]);
    let snap = MF.snapshot(ROOM.id);
    assert.equal(snap.layout, "single", "the legacy layout (an old page draws it)");
    assert.deepEqual(snap.dyn, { n: 1, t: "d1", main: "alice" });
    assert.equal(snap.tiles[0].ring, true, "the holder's ring");
    // bob grabs 6 s later: the newest speaker - but the main holds main_hold_s (15 s) since alice took it
    up("alice"); await at(3, ["alice", "bob"]); up("alice"); await at(3, ["alice", "bob"]); up("alice", "bob"); await at(1, ["alice", "bob"]);
    snap = MF.snapshot(ROOM.id);
    assert.deepEqual(snap.tiles.map((x) => x.login), ["alice", "bob"]);
    assert.equal(snap.layout, "split");
    assert.equal(snap.tiles.find((x) => x.login === "bob").newest, true);
    assert.deepEqual(snap.dyn, { n: 2, t: "d2", main: "alice" }, "hysteresis: not yet");
    assert.ok(snap.tiles.every((x) => x.ring), "both holders get rings (a 2-slot room)");
    const v0 = MF._pads.get(ROOM.id).state.v;
    up("alice", "bob"); await at(9, ["alice", "bob"]);
    snap = MF.snapshot(ROOM.id);
    assert.equal(snap.dyn.main, "bob", "after main_hold_s the newest speaker takes the main");
    assert.ok(MF._pads.get(ROOM.id).state.v > v0, "a move bumps v (pages repaint)");
    // viewFor: the template over this viewer's own entries
    let v = await MF.viewFor(snap, R, "u_v1", null);
    assert.deepEqual(v.dyn, { n: 2, t: "d2", main: "bob" });
    assert.equal(v.layout, "split");
    assert.ok(v.src.every((s) => s.ring === true));
    // a recent speaker (let go of the mic) has no ring
    up("alice", "bob"); await at(1, ["bob"]);
    snap = MF.snapshot(ROOM.id);
    assert.equal(snap.tiles.find((x) => x.login === "alice").ring, undefined);
    // the site switch goes off: a pad on dynamic shows auto (no dyn, not fixed) and keeps its choice on a save
    await MF.setCfg(ADMIN, { dynamic: false, reason: "test" });
    snap = MF.snapshot(ROOM.id);
    assert.equal(snap.dyn, undefined);
    assert.equal(snap.fixed, false);
    assert.equal(snap.tiles.some((x) => x.ring), false);
    st = await MF.ownerState(ROOM.id);
    assert.ok(st.layouts.includes("dynamic"), "still offered to a pad that uses it (a save never turns it into auto)");
    await MF.setPad(ROOM.id, { max_people: 4 }, "test");
    assert.equal(MF._pads.get(ROOM.id).settings.layout, "dynamic");
    await MF.setCfg(ADMIN, { dynamic: true, reason: "test" });
  } finally { await MF.setCfg(ADMIN, { dynamic: false, main_hold_s: 3, stable_slots: true, reason: "test" }); await plainPad(); }
  // 📌 a pin takes the main only when it holds the mic and grabbed last (today's pinNew rule)
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { dynamic: true, main_hold_s: 0, stable_slots: false, reason: "test" });
  try {
    await MF.setPad(ROOM.id, { layout: "dynamic" }, "test");
    await bot(); room([]);
    r = await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl" }, "u_owner");
    assert.equal(r.d.pinned, true, JSON.stringify(r.d));
    up("carl"); await bot();
    await step(["dana"]); await at(3, ["dana"]); up("carl", "dana"); await at(3, ["dana"]);
    let snap = MF.snapshot(ROOM.id);
    assert.deepEqual(snap.tiles.map((x) => x.login), ["carl", "dana"]);
    assert.equal(snap.dyn.main, "dana", "the pin sits in a secondary cell while dana talks");
    await at(3, ["dana", "carl"]); await at(1, ["dana", "carl"]);
    snap = MF.snapshot(ROOM.id);
    assert.equal(snap.dyn.main, "carl", "the pin holds the mic and grabbed last: it takes the main");
    await post(`/api/rooms/${slug()}/micfollow/pin`, { login: "carl", remove: true }, "u_owner");
  } finally { await MF.setCfg(ADMIN, { dynamic: false, main_hold_s: 3, stable_slots: true, reason: "test" }); await plainPad(); }
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.4): veiled speakers as hooded-frog cover tiles ──
const REF1 = "anon-0a1b2c3d", REF2 = "anon-5e6f7a8b";
const ANON = (ref) => ({ anon: true, display: "someone", ref });
/** Every key the engine got an elig / sess entry for, every login livecam / the still relay were asked about (spies). */
function coverSpies() {
  const seen = { elig: new Set(), sess: new Set(), hold: [], mf: [], snap: [] };
  const step0 = core.step, hold0 = LC.stageHold, mfs0 = LC.mfState, snap0 = relay.mfSnap;
  core.step = (S, I, C, t) => { for (const k of I.elig.keys()) seen.elig.add(k); for (const k of I.sess.keys()) seen.sess.add(k); return step0(S, I, C, t); };
  LC.stageHold = (R0, login, ...r) => { seen.hold.push(String(login)); return hold0(R0, login, ...r); };
  LC.mfState = (room0, login, ...r) => { seen.mf.push(String(login)); return mfs0(room0, login, ...r); };
  relay.mfSnap = (room0, login, ...r) => { seen.snap.push(String(login)); return snap0(room0, login, ...r); };
  seen.restore = () => { core.step = step0; LC.stageHold = hold0; LC.mfState = mfs0; relay.mfSnap = snap0; };
  return seen;
}
const noIdentity = (json, extra = []) => { for (const s of [REF1, REF2, "~cv:", '"login"', '"avatar"', '"nameCss"', '"ref"', '"key"', '"sess"', ...extra]) assert.ok(!json.includes(s), "leaks " + s); };

test("69. wave2 F.4 covers: a proven veiled holder (the v2 seam) is a hooded-frog cover (incognito, no frog name here, a random id never a login) - in no role's program a login / avatar / ref / key / session; never eligOf / livecam / stills / spans; covers off = today's neutral card", async () => {
  await reset(); await plainPad();
  // (review B-privacy-ux-2: covers come only from WP-2's per-hold facts - a proven hold; v1 has none, tests 73 / 74)
  MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s69", veil: "incognito", alias: null, login: "erin", display: "Erin" } : null));
  // covers off (the prod default): today's path - an `others` entry: alice let go, the anonymous holder talks -> "Someone else
  // is speaking" over her (recent) tile
  assert.equal(MF.cfg().covers, false, "ships dark");
  await onStage(["alice"]);
  up("alice"); await at(3, [ANON(REF1)]); up("alice"); await at(3, [ANON(REF1)]);
  assert.deepEqual(tiles(), ["alice"]);
  assert.equal(MF.snapshot(ROOM.id).neutral, "someone", "the dimmed strip, as today");
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  const spy = coverSpies();
  try {
    up("alice"); await at(1, [ANON(REF1)]); up("alice"); await at(6, [ANON(REF1)]);
    const P = MF._pads.get(ROOM.id);
    const ct = P.state.tiles.find((x) => x.cover);
    assert.ok(ct, "a cover tile");
    assert.equal(ct.login, "~cv:ss69", "keyed by the frog-name session (server-side only)");
    const snap = MF.snapshot(ROOM.id);
    assert.equal(snap.neutral, null, "a cover talking is attributed: no 'someone' strip");
    for (const [who, uid] of [["member", "u_v1"], ["pad owner", "u_owner"], ["admin", "u_admin"], ["staff", "u_staff"]]) {
      const v = await MF.viewFor(snap, R, uid, null);
      const c = v.src.find((s) => s.kind === "cover");
      assert.ok(c, who + ": the cover");
      assert.match(c.id, /^anon-[0-9a-f]{8}$/, who);
      assert.notEqual(c.id, REF1, "never Pepe's hold ref");
      assert.ok(!MEMBERS().some((m) => m.login === c.id), "never a login");
      assert.deepEqual([c.name, c.veil, c.video, c.watch], [null, "incognito", "cover", "cover"], who + ": no frog name from the source - 'someone'");
      assert.ok(Number.isInteger(c.hood) && c.hood >= 0 && c.hood <= 7);
      assert.equal(c.rv, undefined, who + ": no Reveal (no reveal source yet)");
      assert.equal(c.ex, undefined, who + ": no ✕ (no reveal source yet)");
      noIdentity(JSON.stringify(c), ["erin", "Erin", "s69"]);
      noIdentity(JSON.stringify(v.src.filter((s) => s.kind === "cover")), ["erin", "Erin", "s69"]);
    }
    assert.equal((await MF.viewFor(snap, R, null, null)).src.length, 0, "signed out: nothing");
    // the page's whole /live answer
    const live = JSON.stringify(await bridge.liveView(bridge._rooms.get(ROOM.id), 0, "u_v1", "viewer1", null, true, { program: true }));
    assert.ok(!live.includes(REF1) && !live.includes("~cv:"), "no hold ref / key anywhere on the page's answer");
    // the id stays put while the tile is up
    const id0 = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).src.find((s) => s.kind === "cover").id;
    up("alice"); await at(1, [ANON(REF1)]);
    assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).src.find((s) => s.kind === "cover").id, id0, "stable for the tile's life");
    // never eligOf / livecam / stills / spans - neither the cover nor the person behind it
    for (const k of [...spy.elig, ...spy.sess, ...spy.hold, ...spy.mf, ...spy.snap]) assert.ok(!k.includes("~cv") && !k.includes(REF1) && k !== "erin", "asked about " + k);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_spans WHERE login LIKE '%cv%' OR login LIKE 'anon%'"))[0].n, 0, "no span row");
    // the tile routes refuse the cover's id (an old page posts it like a login)
    for (const [p, body, u] of [["watch", { login: id0 }, "u_v3"], ["report", { login: id0, reason: "other" }, "u_v3"], ["exclude", { login: id0, hours: 1 }, "u_admin"],
                                ["pin", { login: id0 }, "u_admin"]]) {
      const r = await post(`/api/rooms/${slug()}/micfollow/${p}`, body, u);
      assert.equal(r.status, 400, p + ": " + JSON.stringify(r.d));
      assert.equal(r.d.code, "cover", p);
    }
    assert.equal((await get(`/api/rooms/${slug()}/micfollow/still/${id0}`, "u_v1")).d.code, "cover");
    // the hold ends: the cover leaves after the hand-over like any tile
    for (let i = 0; i < 8; i++) { up("alice"); await at(5, ["alice"]); }
    assert.ok(!P.state.tiles.some((x) => x.cover));
    assert.equal(P.covers.size, 0, "its public entry went with it");
  } finally { spy.restore(); MF.setVeilSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); }
});

test("70. wave2 F.4: anonymous holds (stamped or not) and named hidden holders never become covers on v1; covers count toward max_people and ring / lead the dynamic layout; the v2 seam (setVeilSource): proven holds only, frog name + hood + veil on the page, the identity server-side", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  try {
    bridge._k3Refs.set(ROOM.id, new Map([[REF1, T]]));
    await step([ANON(REF2), ANON(REF1)]); await at(3, [ANON(REF2), ANON(REF1)]); await at(3, [ANON(REF2), ANON(REF1)]);
    assert.deepEqual(tiles(), [], "an anonymous hold - unstamped, or B.1-stamped (review B-privacy-ux-2) - stays the neutral `others` entry");
    assert.equal(MF._pads.get(ROOM.id).state.oseen.size, 1, "(anonymous holders collapse into one key, as today)");
    // a named holder the site's hidden set marks: cut as today (no cover - the v1 wire can't say who is veiled)
    const Q = require(path.join(repo, "quotes")), hid0 = Q.isHidden;
    Q.isHidden = (l) => String(l).toLowerCase() === "bob" || hid0(l);
    try {
      await at(1, ["bob"]); await at(3, ["bob"]); await at(3, ["bob"]);
      assert.deepEqual(tiles(), []);
    } finally { Q.isHidden = hid0; }
    // capacity: max_people 2 - a cover counts and displaces like a tile; in the dynamic layout it rings and takes the main
    await reset(); await MF.setPad(ROOM.id, { on: true, layout: "dynamic", max_people: 2, keep_recent: 0 }, "test").catch(() => {});
    // (1.99ahp: today's dynamic main - the knob stable_slots off; with it on, 2 on the stage never move: see below)
    await MF.setCfg(ADMIN, { dynamic: true, main_hold_s: 0, stable_slots: false, reason: "test" });
    await MF.setPad(ROOM.id, { on: true, layout: "dynamic", max_people: 2, keep_recent: 0 }, "test");
    await onStage(["alice", "bob"]);
    up("alice", "bob"); await at(10, ["alice", "bob"]);
    // (the veiled grab comes now: the newest speaker - a proven veiled hold through the v2 seam)
    MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s70", veil: "incognito" } : null));
    up("alice", "bob"); await at(1, ["alice", "bob", ANON(REF1)]); up("alice", "bob"); await at(6, ["alice", "bob", ANON(REF1)]);
    const P = MF._pads.get(ROOM.id);
    assert.equal(P.state.tiles.length, 2, "max_people 2");
    assert.ok(P.state.tiles.some((x) => x.cover), "the cover displaced the tile added longest ago");
    const snap = MF.snapshot(ROOM.id);
    const c = snap.tiles.find((x) => x.cover);
    assert.equal(c.newest, true); assert.equal(c.ring, true);
    assert.equal(snap.dyn.main, c.cid, "the main cell, by its public id");
    noIdentity(JSON.stringify((await MF.viewFor(snap, R, "u_owner", null)).src.filter((s) => s.kind === "cover")));
    // 1.99ahp stable slots on: 2 on the stage - nobody moves; the cover sits after the named one (never in a named place), rings
    await MF.setCfg(ADMIN, { stable_slots: true, reason: "test" });
    const st = MF.snapshot(ROOM.id), sc = st.tiles.find((x) => x.cover);
    assert.equal(st.stable, true);
    assert.deepEqual([sc.pos, sc.ring, sc.newest], [1, true, true]);
    assert.equal(st.dyn.main, st.tiles.find((x) => !x.cover).login, "the main cell is place 0 with 2");
    noIdentity(JSON.stringify((await MF.viewFor(st, R, "u_owner", null)).src.filter((s) => s.kind === "cover")));
  } finally { MF.setVeilSource(null); await MF.setCfg(ADMIN, { dynamic: false, main_hold_s: 3, stable_slots: true, reason: "test" }); await plainPad(); bridge._k3Refs.delete(ROOM.id); }
  // v2 (WP-2 / WP-3): the privacy wire's per-hold facts through the seam
  await reset(); await plainPad();
  MF.setVeilSource((u) => {
    if (!u.anon) return null;
    if (u.ref === REF1) return { proven: true, sess: "s42", veil: "hidden", alias: "Soggy Bullfrog", hood: 3, login: "erin", display: "Erin" };
    if (u.ref === REF2) return { proven: true, sess: "s43", began_named: true, login: "dana" };
    return { proven: false, sess: "s44", login: "fay" };
  });
  try {
    await step([ANON(REF1), ANON(REF2), ANON("anon-99999999")]);
    await at(3, [ANON(REF1), ANON(REF2), ANON("anon-99999999")]); await at(6, [ANON(REF1), ANON(REF2), ANON("anon-99999999")]);
    const P = MF._pads.get(ROOM.id);
    assert.deepEqual(P.state.tiles.map((x) => x.login), ["~cv:ss42"], "only the proven hold that didn't begin named");
    const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_admin", null);
    const c = v.src[0];
    assert.deepEqual([c.kind, c.name, c.hood, c.veil], ["cover", "Soggy Bullfrog", 3, "hidden"]);
    assert.deepEqual(P.coverWho.get("~cv:ss42"), { login: "erin", display: "Erin" }, "the identity stays server-side");
    noIdentity(JSON.stringify(v), ["erin", "Erin", "s42"]);
    assert.equal(P.state.oseen.size, 1, "the other two: the neutral `others` entry (anonymous holders collapse into one key, as today)");
  } finally { MF.setVeilSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); }
});

test("71. wave2 F.4 bridge: cleanMic keeps Pepe's per-hold ref on an anonymous holder (server-only, for the v2 veil source); no page roster carries it", async () => {
  assert.deepEqual(bridge.cleanMic({ anonymous: true, id: REF1, display: "someone" }), { anon: true, display: "someone", ref: REF1 });
  assert.deepEqual(bridge.cleanMic({ anonymous: true, id: "alice", display: "someone" }), { anon: true, display: "someone" }, "only a hold ref (HOLD_REF_RE)");
  assert.deepEqual(bridge.cleanMic({ anonymous: true }), { anon: true, display: "someone" });
  assert.equal(bridge.k3Ref, undefined, "(review B-privacy-ux-2: the v1 stamp is no cover rule any more)");
  // a page's roster / mic list never carries it (chatlogview.roster builds "someone" from a whitelist)
  const CVw = require(path.join(repo, "chatlogview"));
  assert.deepEqual(CVw.roster([{ anon: true, display: "someone", ref: REF1 }]), [{ anon: true, display: "someone" }]);
});

test("72. wave2 WP-4 Reveal seam: no rv / ex anywhere until WP-2's reveal source is available AND the identity is known; then only an Admin (see-through) or the pad's current owner, on the pad page; self: 1 for the person; ✕ on a cover = a veiled exclusion listed by label, never by login", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  const coverId = async () => (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).src.find((s) => s.kind === "cover").id;
  try {
    // v1 (today's wire): even a B.1-stamped hold is no cover (review B-privacy-ux-2) - nothing to reveal or ✕, available or not
    bridge._k3Refs.set(ROOM.id, new Map([[REF1, T]]));
    MF.setRevealSource({ available: () => true });
    await step([ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    assert.ok(!MF._pads.get(ROOM.id).state.tiles.some((x) => x.cover), "v1: no cover");
    assert.equal(MF._pads.get(ROOM.id).covers.size, 0);
    MF.setRevealSource(null);
    bridge._k3Refs.delete(ROOM.id);
    let id;
    // v2: the seam knows who (alice) - but the reveal source isn't available: still nothing
    await reset(); await plainPad();
    MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s7", veil: "incognito", alias: "Damp Toad", hood: 2, login: "alice", display: "Alice W" } : null));
    await step([ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    id = await coverId();
    assert.deepEqual(MF.coverWho(ROOM.id, id), { login: "alice", display: "Alice W" });
    assert.equal(MF.coverWho(ROOM.id, "anon-ffffffff"), null);
    const flags = async (uid, surface) => { const v = await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null, undefined, surface); const c = v.src.find((s) => s.kind === "cover"); return { rv: c.rv, ex: c.ex, self: c.self, json: JSON.stringify(v) }; };
    for (const uid of ["u_admin", "u_owner", "u_staff", "u_v1"]) assert.equal((await flags(uid)).rv, undefined, uid + ": the switch is off");
    assert.equal((await flags("u_alice")).self, 1, "the person behind it sees 'this is you'");
    // WP-2 says the privacy wire is on: Admins (chatlog.see_through) and the pad's current owner get Reveal + ✕ on the pad page
    MF.setRevealSource({ available: () => true });
    for (const [uid, want] of [["u_admin", 1], ["u_owner", 1], ["u_staff", undefined], ["u_v1", undefined], [null, undefined]]) {
      if (!uid) { assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, null, null)).src.length, 0); continue; }
      const f = await flags(uid);
      assert.equal(f.rv, want, uid + " rv"); assert.equal(f.ex, want, uid + " ex");
      assert.ok(!f.json.includes("alice") && !f.json.includes("Alice W") && !f.json.includes("s7"), uid + ": the program never carries the identity");
    }
    assert.equal((await flags("u_admin", "capture")).rv, undefined, "a capture never carries them");
    MF.setRevealSource({ available: () => true, role: async () => null });
    assert.equal((await flags("u_admin")).rv, undefined, "WP-2's own role rule decides");
    MF.setRevealSource({ available: () => true });
    // ✕ on the cover: a member can't; a see-through manager keeps them off without seeing who - listed by label, never by login
    assert.equal((await post(`/api/rooms/${slug()}/micfollow/exclude`, { tile: id, hours: 1 }, "u_v1")).status, 403);
    MF.setRevealSource(null);
    const off = await post(`/api/rooms/${slug()}/micfollow/exclude`, { tile: id, hours: 1 }, "u_admin");   // (u_admin: the owner route's per-user rate limit is spent by earlier tests)
    assert.equal(off.status, 403, "no reveal source: no veiled exclusion either");
    assert.equal(off.d.code, "cover");
    MF.setRevealSource({ available: () => true });
    const r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { tile: id, hours: 1 }, "u_admin");
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const row = r.d.state.excluded.find((e) => e.veiled);
    assert.ok(row && row.veiled === "Damp Toad" && row.login === null && /^[0-9a-f]{16}$/.test(row.xid));
    assert.ok(!JSON.stringify(r.d).includes("alice"), "the owner's answer never names them");
    assert.ok(!MF._pads.get(ROOM.id).state.tiles.some((x) => x.cover), "the cover came off at once");
    await at(1, [ANON(REF1)]); await at(3, [ANON(REF1)]);
    assert.ok(!MF._pads.get(ROOM.id).state.tiles.some((x) => x.cover), "and stays off (the neutral card meanwhile)");
    assert.deepEqual(tiles(), []);
    const rm = await post(`/api/rooms/${slug()}/micfollow/exclude`, { xid: row.xid, remove: true }, "u_admin");
    assert.equal(rm.status, 200);
    assert.ok(!rm.d.state.excluded.some((e) => e.veiled), "removed by its xid");
  } finally {
    MF.setVeilSource(null); MF.setRevealSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); await MF.unexclude(ROOM.id, "alice");
    for (const e of (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded) if (e.xid) await MF.unexcludeXid(ROOM.id, e.xid);
  }
});

test("73. wave2 F.4 end to end on today's wire (review B-privacy-ux-2): Pepe's kinded sync with an anonymous grab -> B.1 stamps it -> STILL the neutral card, never an 'incognito' cover (an unproven !bridge hide holder or a name Pepe can't resolve arrives exactly like this); the same with an older Pepe", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  let n = 0;
  const ev = (type, data) => ({ op: "event", id: "w4-cover-" + Date.now() + "-" + (++n), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
  const sync = (u, extra) => bridge.ingest(Object.assign({ rooms: [{ room: ROOM, members: [{ id: "alice", login: "alice", display: "Alice W", on_cam: true }], mic: [u], count: 2, cams: true, livecams: true }],
                                                           events: [ev("mic.grab", { user: u })] }, extra || {}));
  const ripe = async () => { for (let i = 0; i < 3; i++) { T += 3000; const B = bridge._rooms.get(ROOM.id); B.updated = T; MF.stepPad(ROOM.id, T); await MF._idle(); } };
  try {
    const stamped = { anonymous: true, id: "anon-c0ffee01", display: "someone" };
    await sync(stamped, { bridge_hidden_h: [], incog_hidden_h: [] });
    const B = bridge._rooms.get(ROOM.id);
    assert.deepEqual(B.mic[0], { anon: true, display: "someone", ref: "anon-c0ffee01" }, "the ref is kept server-side");
    assert.ok((bridge._k3Refs.get(ROOM.id) || new Map()).has("anon-c0ffee01"), "B.1 stamped the grab (the chat says 'someone grabbed the mic')");
    await ripe();
    let P = MF._pads.get(ROOM.id);
    assert.ok(!P.state.tiles.some((x) => x.cover), "no cover: the site can't tell incognito from hidden / unresolved, nor see proven");
    assert.equal(P.covers.size, 0);
    assert.equal(P.state.oseen.size, 1, "an `others` entry (the neutral card), as today");
    // an older / unloaded Pepe (no kinded lists): the hold isn't stamped - the neutral card too
    await reset(); await plainPad();
    const plain = { anonymous: true, id: "anon-c0ffee02", display: "someone" };
    await sync(plain, { hidden_h: [] });
    assert.ok(!(bridge._k3Refs.get(ROOM.id) || new Map()).has("anon-c0ffee02"));
    await ripe();
    P = MF._pads.get(ROOM.id);
    assert.ok(!P.state.tiles.some((x) => x.cover), "no cover");
    assert.equal(P.state.oseen.size, 1, "an `others` entry (the neutral card), as today");
  } finally { await MF.setCfg(ADMIN, { covers: false, reason: "test" }); }
});

// ── wave2 WP-4 review fixes ──
/** `logins` go on the stage live, then let go and leave (kept warm while warm keep is on). `also` = relays kept already:
 *  MediaMTX's path sync marks every relay it doesn't list as down, so each up() names them all. */
async function leaves(logins, also = []) {
  const keepUp = () => { if (also.length) up(...also); };
  keepUp(); await step(logins);
  keepUp(); await at(3, logins);
  up(...logins, ...also); await at(1, logins);
  for (const l of logins) assert.equal(tile(l).video, "live", l + " is live");
  for (let i = 0; i < 10 && tiles().length; i++) { up(...logins, ...also); await at(5, []); }
  assert.deepEqual(tiles(), []);
  up(...logins, ...also);
}

test("74. wave2 review (B-relays-1 / B-privacy-ux-1): one incognito person re-grabbing - a new hold ref each time - never floods the stage: v1 makes no cover at all; v2 keys the cover by the frog-name session, so grab-spam (DF-37) catches it like a login and the named tiles stay", async () => {
  const keep2 = { on: true, layout: "auto", default_view: "first", max_people: 4, max_live: 4, keep_recent: 2 };
  // they grab for ~3 s every 10 s, each hold with a fresh ref (Pepe's _br_hold_user) that B.1 stamps
  const cycle = async (i) => {
    const ref = "anon-c0de00" + i.toString(16).padStart(2, "0");
    bridge._k3Refs.set(ROOM.id, new Map([[ref, T]]));
    up("alice", "bob"); await at(1, [ANON(ref)]); up("alice", "bob"); await at(2, [ANON(ref)]);   // held 2 s (min_hold_s)
    up("alice", "bob"); await at(1, []); up("alice", "bob"); await at(6, []);                      // let go after ~3 s: a short hold
  };
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  try {
    for (const v2 of [false, true]) {
      const tag = v2 ? "v2" : "v1";
      await reset(); await MF.setPad(ROOM.id, keep2, "test");
      if (v2) MF.setVeilSource((u) => (u.anon && /^anon-c0de00/.test(u.ref || "") ? { proven: true, sess: "troll", veil: "incognito" } : null));
      await onStage(["alice", "bob"]);                         // alice and bob talked and let go: recent tiles (keep_recent 2 min)
      up("alice", "bob"); await at(3, []);
      const P = MF._pads.get(ROOM.id);
      const spam0 = MF.metrics(T).counts.grab_spam || 0;
      let most = 0;
      for (let i = 0; i < 6; i++) {
        await cycle(i);
        most = Math.max(most, P.state.tiles.filter((x) => x.cover).length);
        assert.deepEqual(P.state.tiles.filter((x) => !x.cover).map((x) => x.login).sort(), ["alice", "bob"], tag + " cycle " + i + ": the named tiles stay");
      }
      if (!v2) assert.equal(most, 0, "v1: never a cover (the neutral strip, as today)");
      else {
        assert.equal(most, 1, "v2: one cover for the one person");
        assert.ok((P.state.spamUntil.get("~cv:stroll") || 0) > T, "DF-37 caught the frog-name session");
        assert.ok(!P.state.tiles.some((x) => x.cover), "and took its cover off");
        assert.ok((MF.metrics(T).counts.grab_spam || 0) > spam0);
      }
      MF.setVeilSource(null);
    }
  } finally { MF.setVeilSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); bridge._k3Refs.delete(ROOM.id); await plainPad(); }
});

test("75. wave2 review (B-privacy-ux-3 / -7): a veiled exclusion is a row of its own - an exclude or a remove by a guessed login never replaces, removes or tells it apart (the pad's list is the same whether the guess is right); no frog name = null on the wire (the page words it)", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s75", veil: "incognito", login: "alice", display: "Alice W" } : null));   // (no frog name)
  MF.setRevealSource({ available: () => true });
  try {
    await step([ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    const id = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_admin", null)).src.find((s) => s.kind === "cover").id;
    await MF.excludeCover(ADMIN, R, id, 0);
    const st0 = await MF.ownerState(ROOM.id, undefined, { lift: true });
    assert.equal(st0.excluded.length, 1);
    const vrow = st0.excluded[0];
    assert.equal((await MF.ownerState(ROOM.id)).excluded[0].xid, undefined, "integration review P2: no viewer named - no xid");
    assert.deepEqual([vrow.login, vrow.veiled, /^[0-9a-f]{16}$/.test(vrow.xid)], [null, null, true], "no frog name: null - no English copy in the DB");
    const db = (await getQuery("SELECT login, veiled, vlogin, user_id FROM micfollow_excl WHERE room_id = ? AND vlogin IS NOT NULL", [ROOM.id]))[0];
    assert.deepEqual([db.login, db.veiled, db.vlogin, db.user_id], ["~v:" + vrow.xid, null, "alice", null], "keyed by its xid; the login server-side only");
    // (the person's own data: account deletion removes it, their export includes it - by vlogin)
    assert.ok(require(path.join(repo, "accountdelete")).DELETE_ROWS.some(([tb, col, kind]) => tb === "micfollow_excl" && col === "vlogin" && kind === "login"));
    assert.match(fs.readFileSync(path.join(repo, "accountexport.js"), "utf8"), /rows\("micfollow_excl", "vlogin = \?", \[login\]/);
    // site staff (pads.manage_any, no see-through) try names: the list must read the same whether the guess is right
    const norm = (st, guess) => st.excluded.map((e) => ({ login: e.login === guess ? "GUESS" : e.login, veiled: e.veiled, xid: e.xid || null, always: e.until == null, reason: e.reason, by: e.by }))
      .sort((a, b) => String(a.login).localeCompare(String(b.login)));
    const tryName = async (guess) => {
      const a = await post(`/api/rooms/${slug()}/micfollow/exclude`, { login: guess, hours: 1 }, "u_staff");
      assert.equal(a.status, 200, JSON.stringify(a.d));
      const r = await post(`/api/rooms/${slug()}/micfollow/exclude`, { login: guess, remove: true }, "u_staff");
      assert.equal(r.status, 200, JSON.stringify(r.d));
      return [norm(a.d.state, guess), norm(r.d.state, guess), norm(await MF.ownerState(ROOM.id), guess)];
    };
    const wrong = await tryName("bob"), right = await tryName("alice");
    assert.deepEqual(right, wrong, "a right guess reads exactly like a wrong one");
    assert.equal(right[0].length, 2, "the 🕶 row + the guessed name's row");
    // (integration review P2 / P3: staff may not lift it, so their list carries no xid)
    assert.deepEqual(right[1], [{ login: null, veiled: null, xid: null, always: true, reason: "owner", by: "admin" }], "the 🕶 row is still there, untouched");
    assert.ok((await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded.some((e) => e.xid === vrow.xid), "untouched: the same row");
    // it still keeps alice off: her cover doesn't come back
    await at(1, [ANON(REF1)]); await at(3, [ANON(REF1)]);
    assert.ok(!MF._pads.get(ROOM.id).state.tiles.some((x) => x.cover));
    // only its xid removes it
    assert.equal(await MF.unexclude(ROOM.id, "~v:" + vrow.xid), false, "never addressed like a name");
    assert.equal(await MF.unexcludeXid(ROOM.id, vrow.xid), true);
    assert.equal((await MF.ownerState(ROOM.id)).excluded.length, 0);
  } finally { MF.setVeilSource(null); MF.setRevealSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); }
});

test("76. wave2 review (B-relays-2): a Pepe pool that's already over (▶ Live grew while a relay was kept) has nothing to give - evicting the kept relay only gets back to where it was, so no cold open", async () => {
  await reset(); await plainPad();
  const P = MF._pads.get(ROOM.id);
  const L0 = { liveCount: LC.liveCount, mfOnlyCount: LC.mfOnlyCount, mfState: LC.mfState, botPool: LC.botPool };
  try {
    // pool 6, POOL_FREE 2: 4 relays (2 ▶ Live, a live mic tile, a kept one) + 1 still = raw -1
    LC.liveCount = () => 4;
    LC.mfOnlyCount = () => 2;
    LC.botPool = () => ({ capacity: 6 });
    LC.mfState = (room0, login, t) => (login === "zed" ? { mfOnly: true, held: false, kept: true, state: "live", exact: true } : L0.mfState(room0, login, t));
    P.state.kept.set("zed", { leftAt: T - 1000, until: T + 60000 });
    P.state.tiles.push({ login: "yan", video: "still", addedAt: T, pos: 0 });
    let b = MF._siteBudget(P, T);
    assert.equal(b.poolFree, 0);
    assert.equal(b.poolLeft, 0, "raw -1 + 1 reclaimable = 0: no open (it was 1, leaving 1 cam for ▶ Live / slots instead of 2)");
    // the pool exactly full (raw 0): the kept relay's room is real - one open (core marks it evict)
    LC.liveCount = () => 3;
    b = MF._siteBudget(P, T);
    assert.deepEqual([b.poolFree, b.poolLeft], [0, 1]);
  } finally { Object.assign(LC, L0); P.state.kept.delete("zed"); P.state.tiles = P.state.tiles.filter((x) => x.login !== "yan"); }
});

test("77. wave2 review (B-relays-3): a kept relay the same step drops (expired / the pad's max_live) makes the room for an evict-marked open - no second eviction of another comeback", async () => {
  for (const variant of ["expired", "pad_full"]) {
    await reset();
    await MF.setPad(ROOM.id, { on: true, layout: "auto", default_view: "first", max_people: 4, max_live: variant === "pad_full" ? 2 : 4, keep_recent: 0 }, "test");
    await MF.setCfg(ADMIN, { warm_keep_s: 180, warm_max: 3, cold_open: true, relays_max: 2, reason: "test" });
    try {
      await leaves(["bob"]);                                    // bob kept first (the least recently used) ...
      T += 5000; await leaves(["alice"], ["bob"]);              // ... then alice: relays_max 2 is full
      assert.ok(MF.keptOf(ROOM.id, "bob") && MF.keptOf(ROOM.id, "alice"), variant + ": both kept");
      const c0 = { ...MF.metrics(T).counts };
      const carl = { login: "carl", display: "carl", proven: true };
      T += 5000; up("alice", "bob"); await bot();               // (past the change budget's min_gap_s)
      up("alice", "bob"); await step([carl]);                   // carl grabs (his facts looked up meanwhile)
      T += 3000; up("alice", "bob"); await bot();
      // expired: alice's keep runs out in the very step carl goes up / pad_full: carl's live place leaves room for one kept relay
      if (variant === "expired") MF._pads.get(ROOM.id).state.kept.get("alice").until = T;
      room([carl]); MF.stepPad(ROOM.id, T); await MF._idle(); await settle();
      assert.ok(tile("carl"), variant + ": carl is up, his open on its way");
      const gone = variant === "expired" ? "alice" : "bob", stays = variant === "expired" ? "bob" : "alice";
      assert.equal(MF.keptOf(ROOM.id, gone), null, variant + ": " + gone + "'s kept relay ended");
      assert.ok(MF.keptOf(ROOM.id, stays), variant + ": " + stays + " is still kept - no second eviction");
      assert.ok(!LC._sessions.get(LC.keyOf(ROOM.id, stays)).ended, variant + ": " + stays + "'s relay runs");
      const c1 = MF.metrics(T).counts;
      assert.equal((c1.keep_evicted || 0) - (c0.keep_evicted || 0), variant === "pad_full" ? 1 : 0, variant + ": evictions");
      assert.equal((c1.keep_expired || 0) - (c0.keep_expired || 0), variant === "expired" ? 1 : 0, variant + ": expiries");
    } finally { await MF.setCfg(ADMIN, { warm_keep_s: 0, relays_max: 2, reason: "test" }); await plainPad(); }
  }
});

test("78. wave2 review (B-relays-5 / B-privacy-ux-5): lowering warm_max or warm_keep_s at /stage/admin applies to relays kept already - over warm_max the least recently used go at once; kept longer than warm_keep_s, they end at once", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { warm_keep_s: 180, warm_max: 3, cold_open: true, relays_max: 4, reason: "test" });
  try {
    await leaves(["carl"]); T += 2000; await leaves(["bob"], ["carl"]); T += 2000; await leaves(["alice"], ["carl", "bob"]);
    assert.equal(MF.keptList(T).length, 3);
    const ev0 = MF.metrics(T).counts.keep_evicted || 0;
    up("alice", "bob", "carl");
    await MF.setCfg(ADMIN, { warm_max: 1, reason: "test" });
    assert.deepEqual(MF.keptList(T).map((k) => k.login), ["alice"], "the most recently kept stays");
    assert.equal((MF.metrics(T).counts.keep_evicted || 0) - ev0, 2, "two evicted in the same call (F.5: never more than warm_max)");
    for (const l of ["bob", "carl"]) assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, l)).ended, l + "'s relay ended");
    // warm_keep_s lowered below how long alice has been kept: she ends at once
    await MF.setCfg(ADMIN, { warm_max: 3, reason: "test" });
    T += 30000; up("alice"); await bot(); room([]);               // (Pepe polled, his sync is fresh: only the knob can end it)
    const ex0 = MF.metrics(T).counts.keep_expired || 0;
    await MF.setCfg(ADMIN, { warm_keep_s: 20, reason: "test" });
    assert.equal(MF.keptOf(ROOM.id, "alice"), null);
    assert.ok(LC._sessions.get(LC.keyOf(ROOM.id, "alice")).ended);
    assert.equal((MF.metrics(T).counts.keep_expired || 0) - ex0, 1);
  } finally { await MF.setCfg(ADMIN, { warm_keep_s: 0, warm_max: 3, relays_max: 2, reason: "test" }); }
});

test("79. wave2 review (B-privacy-ux-4): switching `covers` off at /stage/admin takes every cover tile off at once - no hand-over or idle hold beside the neutral strip - and its public entry and identity go with it", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s79", veil: "incognito", login: "erin", display: "Erin" } : null));
  try {
    await step([ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    const P = MF._pads.get(ROOM.id);
    assert.ok(P.state.tiles.some((x) => x.cover) && P.covers.size === 1 && P.coverWho.size === 1);
    room([ANON(REF1)]);
    await MF.setCfg(ADMIN, { covers: false, reason: "test" });   // (saveCfg steps every pad with the new knobs)
    assert.ok(!P.state.tiles.some((x) => x.cover), "off at once");
    assert.equal(P.covers.size, 0); assert.equal(P.coverWho.size, 0);
    const snap = MF.snapshot(ROOM.id);
    assert.ok(!snap || !snap.tiles.some((x) => x.cover));
  } finally { MF.setVeilSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" }); }
});

// ── wave2 integration review ──
test("80. wave2 integration review (P1 / T-1, P2, P3): only a VEILED exclusion takes a cover off - a by-name or by-account row never does (staff could exclude a guessed login and watch which cover drops); every ✕ gets a random xid, shown only to who may lift it (one person's frog names are never linked across sessions); a lift needs the see-through rule and is logged", async () => {
  await reset(); await plainPad();
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  let sess = "s80a";
  MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess, veil: "incognito", alias: sess === "s80a" ? "Damp Toad" : "Mossy Newt", login: "alice", display: "Alice W" } : null));
  MF.setRevealSource({ available: () => true });
  const STAFF = { userId: "u_staff", username: "staffer", class: "Staff" }, OWNER = { userId: "u_owner", username: "padowner", class: "pleb" };
  const covers = async () => (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_staff", null)).src.filter((s) => s.kind === "cover").map((s) => ({ id: s.id, name: s.name, recent: !!s.recent }));
  const lifts = async () => (await getQuery("SELECT * FROM seethrough_log WHERE scope = 'stage_exclude' ORDER BY id")).length;
  try {
    await step([ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    const before = await covers();
    assert.equal(before.length, 1, "alice's cover is up");
    // (P1) a wrong guess and a right one - by name, and by PATV account - leave the cover program exactly the same
    const guess = async (login, opts) => {
      await MF.excludeFor(ROOM.id, login, 60, "owner", "staffer", opts);
      await at(1, [ANON(REF1)]); await at(1, [ANON(REF1)]);
      const out = await covers();
      await MF.unexclude(ROOM.id, login);
      return out;
    };
    const n0 = await lifts();
    assert.deepEqual(await guess("bob"), before, "a wrong guess: nothing changes");
    assert.deepEqual(await guess("alice"), before, "the right guess by name: nothing changes either (the cover stays up, not 'recent')");
    assert.deepEqual(await guess("alice", { userId: "u_alice" }), before, "nor by her PATV account");
    assert.equal(await lifts(), n0, "(no see-through row - and nothing to see)");
    assert.equal(MF.veilExcluded(ROOM.id, "alice"), false);
    // a veiled ✕ (the see-through manager's, logged) is what takes it off
    await MF.excludeCover(ADMIN, R, before[0].id, 1);
    assert.equal(MF.veilExcluded(ROOM.id, "alice"), true);
    assert.deepEqual(await covers(), [], "the ✕: off at once");
    // (P2) its xid is random, listed only for a viewer who may lift it - never staff
    const x1 = (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded.find((e) => e.veiled === "Damp Toad").xid;
    assert.match(x1, /^[0-9a-f]{16}$/);
    assert.deepEqual((await MF.ownerState(ROOM.id, undefined, { viewerId: "u_staff" })).excluded.map((e) => [e.veiled, e.xid]), [["Damp Toad", undefined]], "staff: the 🕶 row, no xid");
    assert.deepEqual((await MF.ownerState(ROOM.id, undefined, { viewerId: "u_owner" })).excluded.map((e) => [e.veiled, e.xid]), [["Damp Toad", x1]], "the pad's owner: with it");
    assert.deepEqual((await MF.ownerState(ROOM.id, undefined, { viewerId: "u_admin" })).excluded.map((e) => e.xid), [x1], "an admin (see-through): with it");
    // (P3) a lift: staff are refused (route and function), nothing is written; the owner may - one stage_exclude row (lift:<xid>)
    await assert.rejects(MF.liftVeiled(STAFF, R, x1), (e) => e.status === 403 && e.code === "cover");
    const rs = await post(`/api/rooms/${slug()}/micfollow/exclude`, { xid: x1, remove: true }, "u_staff");
    assert.equal(rs.status, 403, JSON.stringify(rs.d));
    assert.ok(!JSON.stringify(rs.d).includes("alice"));
    assert.equal(MF.veilExcluded(ROOM.id, "alice"), true, "still kept off");
    const n1 = await lifts();
    assert.equal(n1, n0 + 1, "only the ✕'s own row so far");
    await assert.rejects(MF.liftVeiled(OWNER, R, "0".repeat(16)), (e) => e.status === 404, "an unknown xid: gone");
    assert.deepEqual(await MF.liftVeiled(OWNER, R, x1), { lifted: true });
    assert.equal(MF.veilExcluded(ROOM.id, "alice"), false);
    const rows = await getQuery("SELECT * FROM seethrough_log WHERE scope = 'stage_exclude' ORDER BY id");
    assert.equal(rows.length, n1 + 1);
    const row = rows[rows.length - 1];
    assert.deepEqual([row.user_id, row.role, row.room_id, row.ref, JSON.parse(row.logins)], ["u_owner", "owner", ROOM.id, "lift:" + x1, ["alice"]], "logged before it took effect");
    // the same person, a new frog-name session later, ✕-ed again: another xid (the two frog names can't be tied together)
    sess = "s80b";
    await at(3, [ANON(REF1)]); await at(3, [ANON(REF1)]); await at(6, [ANON(REF1)]);
    const again = await covers();
    assert.equal(again.length, 1, "a new cover: " + JSON.stringify(again));
    await MF.excludeCover(ADMIN, R, again[0].id, 1);
    const x2 = (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded.find((e) => e.veiled === "Mossy Newt").xid;
    assert.match(x2, /^[0-9a-f]{16}$/);
    assert.notEqual(x2, x1, "a new xid per ✕");
  } finally {
    MF.setVeilSource(null); MF.setRevealSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" });
    for (const l of ["alice", "bob"]) await MF.unexclude(ROOM.id, l);
    for (const e of (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded) if (e.xid) await MF.unexcludeXid(ROOM.id, e.xid);
  }
});

// ── 1.99ahn dead relay (owner 2026-11-02, "Scarface's cam isn't loading here even though on the VM I see it loaded"): a
// mic-stage relay Pepe reports live + exact but MediaMTX never has (a one-sided WHIP publish) no longer holds its tile at
// "cam starting…" until the person leaves the stage ──
test("81. 1.99ahn dead relay: Pepe says live + exact, MediaMTX's lists (every 5 s) never have it - want[].nomedia from +20 s, the relay ends start_timeout by +45 s, the tile says 'trying again' and the mic stage holds it again after soft_retry_s", async () => {
  await reset(); await plainPad();
  await step(["carl"]); await at(3, ["carl"]);
  const key = LC.keyOf(ROOM.id, "carl");
  const S = LC._sessions.get(key);
  assert.ok(S && !S.ended && S.holds.has("mf:" + ROOM.id), "the mic stage holds carl's relay");
  const t0 = S.createdAt;
  EXACT.add("carl");                         // Pepe: live, exact - but no up(): MediaMTX never has the stream
  const logs = [], log0 = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  let nomediaAt = null;
  try {
    for (let s = 1; s <= 60 && !S.ended; s++) {
      T = t0 + s * 1000;
      if (s % 5 === 0) LC.noteSync([], T);
      const ans = await bot();
      const w = ans.want.find((x) => x.login === "carl");
      if (w && w.nomedia === true && nomediaAt == null) nomediaAt = s;
      if (s === 30) { await step(["carl"]); assert.equal(tile("carl").video, "starting", "+30 s: cam starting…"); }
    }
  } finally { console.log = log0; }
  assert.equal(nomediaAt, 20, "Pepe is asked to restart the publish after 15 s of fresh lists without it");
  assert.ok(S.ended && S.endWhy === "start_timeout", `the dead relay ends (${S.endWhy}) - Pepe's 'live' alone never counts`);
  assert.ok(S.ended > t0 + LC.START_MS && S.ended <= t0 + 45 * 1000);
  const nm = logs.filter((l) => l.startsWith("[livecam] no media "));
  assert.equal(nm.length, 1);
  assert.ok(nm[0].startsWith("[livecam] no media room=" + ROOM.id + " target=- ") && !nm[0].includes("carl"), "logged without the login: " + nm[0]);
  await step(["carl"]);
  assert.deepEqual([tile("carl").video, tile("carl").why], ["card", "retry"], "a soft failure: 'trying again', never the 10-minute backoff");
  assert.ok(!(MF._pads.get(ROOM.id).state.backoff.get("carl") > T));
  await at(MF.cfg().soft_retry_s + 1, ["carl"]);
  const S2 = LC._sessions.get(key);
  assert.ok(S2 && S2 !== S && !S2.ended && S2.holds.has("mf:" + ROOM.id), "held again after soft_retry_s: a new relay");
  up("carl"); await at(1, ["carl"]);
  assert.equal(tile("carl").video, "live", "this time MediaMTX has it: live");
});

test("82. 1.99ahn dead relay: a live mic-stage relay that loses its stream at MediaMTX - nomedia after 20 s, relay_lost START_MS later, a soft retry; a stale MediaMTX list ends nothing", async () => {
  await reset(); await plainPad();
  await onStage(["dana"]);
  const key = LC.keyOf(ROOM.id, "dana");
  const S = LC._sessions.get(key);
  assert.equal(tile("dana").video, "live");
  const t0 = T;
  // MediaMTX's API stops answering for 5 minutes: nothing is judged, nothing ends, Pepe isn't asked for anything
  for (let s = 1; s <= 300; s++) {
    T = t0 + s * 1000;
    const ans = await bot();
    assert.ok(!(ans.want.find((x) => x.login === "dana") || {}).nomedia, "no nomedia on a stale list");
  }
  assert.ok(!S.ended, "a stale list ends nothing");
  // it answers again - without dana's stream: nomedia 20 s on, relay_lost START_MS after that
  let nomediaAt = null;
  for (let s = 301; s <= 400 && !S.ended; s++) {
    T = t0 + s * 1000;
    if (s % 5 === 0) LC.noteSync([], T);
    const w = (await bot()).want.find((x) => x.login === "dana");
    if (w && w.nomedia === true && nomediaAt == null) nomediaAt = s;
  }
  assert.equal(nomediaAt, 325, "lost from the first fresh list (+305 s): nomedia at +325 s");
  assert.ok(S.ended && S.endWhy === "relay_lost", `relay_lost (${S.endWhy})`);
  // (review F1: judged on the lists - the +370 s one is the first more than START_MS after the first nomedia)
  assert.equal(S.ended, t0 + 370 * 1000, "START_MS after the first nomedia");
  await step(["dana"]);
  assert.deepEqual([tile("dana").video, tile("dana").why], ["card", "retry"], "relay_lost is soft: another try soon");
  await at(MF.cfg().soft_retry_s + 1, ["dana"]);
  const S2 = LC._sessions.get(key);
  assert.ok(S2 && S2 !== S && !S2.ended, "held again");
});

// ── 1.99ahq stage cover (stagecover.js): a named card's picture; never a veiled speaker's ──
test("83. 1.99ahq stage cover: a NAMED tile carries its person's cover (GTF avatar by default, then the profile photo, a plain-card choice = none); a veiled speaker's cover tile never does - no GTF URL, seed, photo or /media/cover anywhere on the page's answer; a reported tile / a hidden login gets none", async () => {
  await reset(); await plainPad();
  await runQuery("DELETE FROM micfollow_reports");
  const SC = require(path.join(repo, "stagecover"));
  await SC.init();
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  await runQuery("INSERT OR REPLACE INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES ('alice', 4242, 1), ('erin', 777777, 1)");
  await runQuery("UPDATE users SET avatar = 'https://cdn.example.test/alice.png' WHERE userId = 'u_alice'");
  SC.invalidate();
  const erinGtf = SC.gtfUrl(777777, {});
  MF.setVeilSource((u) => (u.anon && u.ref === REF1 ? { proven: true, sess: "s81", veil: "incognito", alias: "Soggy Bullfrog", login: "erin", display: "Erin" } : null));
  await MF.setCfg(ADMIN, { covers: true, reason: "test" });
  try {
    await onStage(["alice"]);
    for (let i = 0; i < 4 && !MF._pads.get(ROOM.id).state.tiles.some((x) => x.cover); i++) { up("alice"); await at(3, ["alice", ANON(REF1)]); }
    const snap = MF.snapshot(ROOM.id);
    assert.ok(snap.tiles.some((x) => x.cover), "a cover tile is up beside alice: " + JSON.stringify(MF._pads.get(ROOM.id).state.tiles.map((x) => x.login)));
    const v = await MF.viewFor(snap, R, "u_staff", null);
    const a = v.src.find((s) => s.id === "alice"), c = v.src.find((s) => s.kind === "cover");
    assert.equal(a.ck, "gtf", "the default: her GTF avatar");
    assert.equal(a.avatar, SC.gtfUrl(4242, {}));
    assert.match(a.avatar, /^\/media\/cover\/a\/4242\.[a-f0-9]{20}\.svg$/, "the URL names no login and no user id");
    assert.ok(!a.avatar.includes("alice") && !a.avatar.includes("u_alice"));
    assert.ok(c, "the cover");
    for (const k of ["avatar", "ck"]) assert.equal(c[k], undefined, "a cover carries no " + k);
    const live = JSON.stringify(await bridge.liveView(bridge._rooms.get(ROOM.id), 0, "u_staff", "staffer", null, true, { program: true }));
    for (const s of [erinGtf, "777777", "/media/cover/a/777777"]) assert.ok(!live.includes(s), "the veiled speaker's GTF avatar leaks: " + s);
    // her choice: the profile photo; then the plain card (no picture at all)
    await SC.save("u_alice", { kind: "photo" });
    let a2 = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_staff", null)).src.find((s) => s.id === "alice");
    assert.deepEqual([a2.avatar, a2.ck], ["https://cdn.example.test/alice.png", "photo"]);
    await SC.save("u_alice", { kind: "card" });
    a2 = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_staff", null)).src.find((s) => s.id === "alice");
    assert.equal(a2.avatar, null); assert.equal(a2.ck, undefined);
    await SC.save("u_alice", { kind: "gtf" });
    // a viewer who reported her tile gets no picture on it (the letter); a login the site hides now gets none for anyone
    const mine = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_fay", null)).src.find((s) => s.id === "alice");
    assert.ok(mine.avatar, "fay sees her cover before reporting");
    const rr = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "other" }, "u_fay");
    assert.equal(rr.status, 200, JSON.stringify(rr.d));
    const hid = (await MF.viewFor(MF.snapshot(ROOM.id), R, "u_fay", null)).src.find((s) => s.id === "alice");
    assert.equal(hid.watch, "hidden"); assert.equal(hid.avatar, null, "a reported tile: no cover");
    const Q = require(path.join(repo, "quotes")), hid0 = Q.isHidden;
    Q.isHidden = (l) => String(l).toLowerCase() === "alice" || hid0(l);
    try { assert.equal(await SC.coverOf("alice"), null, "hidden now: no cover, whatever is cached"); } finally { Q.isHidden = hid0; }
  } finally {
    MF.setVeilSource(null); await MF.setCfg(ADMIN, { covers: false, reason: "test" });
    await runQuery("DELETE FROM stage_covers"); await runQuery("UPDATE users SET avatar = NULL WHERE userId = 'u_alice'"); SC.invalidate();
    await runQuery("DELETE FROM micfollow_reports WHERE login = 'alice'").catch(() => {});
  }
});

test("84. 1.99ahq stage cover review fix (PRIV-2): a viewer the person blocked - from their cam (camviewers) or in DMs, either way - gets the letter on that tile, never their cover; a cam-mode refusal (members only) still shows it", async () => {
  await reset(); await plainPad();
  const SC = require(path.join(repo, "stagecover"));
  await SC.init();
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  await runQuery("INSERT OR REPLACE INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES ('alice', 4242, 1)");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("DELETE FROM dm_blocks");
  MF._hide.clear();                                                  // (tiles reported in earlier tests)
  try { await CV.unblock("alice", "viewer3"); } catch (e) { /* (test 7's block) */ }
  SC.invalidate();
  const gtf = SC.gtfUrl(4242, {});
  const tileFor = async (uid) => (await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null)).src.find((s) => s.id === "alice");
  try {
    await CA.setMode("alice", "members");
    await onStage(["alice"]);
    let a = await tileFor("u_v2");
    assert.equal(a.watch, "members_only");
    assert.equal(a.avatar, gtf, "a cam-mode refusal (members only) still shows her cover");
    assert.equal((await tileFor("u_v3")).avatar, gtf, "before any block");
    // she blocks viewer3 from her cam
    await CV.block("alice", "viewer3");
    a = await tileFor("u_v3");
    assert.equal(a.watch, "unavailable");
    assert.equal(a.avatar, null, "blocked from her cam: the letter, not her cover"); assert.equal(a.ck, undefined);
    // DM blocks, either way: she blocked viewer1; fay blocked her
    await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_alice', 'u_v1', ?), ('u_fay', 'u_alice', ?)", [T, T]);
    for (const uid of ["u_v1", "u_fay"]) {
      a = await tileFor(uid);
      assert.equal(a.watch, "unavailable", uid);
      assert.equal(a.avatar, null, uid + ": a DM block - the letter"); assert.equal(a.ck, undefined, uid);
    }
    const live = JSON.stringify(await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v3", null));
    assert.ok(!live.includes("/media/cover/") && !live.includes("4242"), "nothing of her cover in the blocked viewer's answer");
  } finally {
    await runQuery("DELETE FROM dm_blocks");
    try { await CV.unblock("alice", "viewer3"); } catch (e) { /* not blocked */ }
    await CA.setMode("alice", "everyone");
    await runQuery("DELETE FROM cosmetic_avatar_seeds WHERE camfrog = 'alice'"); SC.invalidate();
  }
});

test("85. 1.99ahq stage cover fix 3: a profile photo on an allowed host reaches the page through the site's proxy (cfg cover_photo_proxy, default on) - no Discord id in the program; off = its own URL; a host off the list keeps its own URL; a reported tile still gets none", async () => {
  await reset(); await plainPad();
  const SC = require(path.join(repo, "stagecover"));
  await SC.init();
  MF._hide.clear();
  // (never the internet: the background warm-up fetch fails at once)
  SC._setPhotoNet({ lookup: async () => { throw Object.assign(new Error("offline test"), { code: "OFFLINE" }); }, request: () => { throw new Error("no request in tests"); } });
  const photo = "https://cdn.discordapp.com/avatars/123456789012345678/" + "c".repeat(32) + ".png";
  await runQuery("UPDATE users SET avatar = ? WHERE userId = 'u_alice'", [photo]);
  SC.invalidate();
  const tileFor = async (uid) => (await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null)).src.find((s) => s.id === "alice");
  try {
    assert.equal(core.DEFAULTS.cover_photo_proxy, true, "default on");
    await SC.save("u_alice", { kind: "photo" });
    await onStage(["alice"]);
    let a = await tileFor("u_staff");
    assert.equal(a.ck, "photo");
    assert.match(a.avatar, /^\/media\/cover\/p\/[a-f0-9]{32}\.webp$/);
    assert.equal(a.avatar, SC.photoProxyUrl(photo));
    const live = JSON.stringify(await MF.viewFor(MF.snapshot(ROOM.id), R, "u_staff", null));
    assert.ok(!live.includes("123456789012345678") && !live.includes("discordapp"), "no Discord id / host in the program");
    await MF.setCfg(ADMIN, { cover_photo_proxy: false, reason: "test" });
    a = await tileFor("u_staff");
    assert.deepEqual([a.avatar, a.ck], [photo, "photo"], "off: the photo's own URL, as before");
    await MF.setCfg(ADMIN, { cover_photo_proxy: true, reason: "test" });
    await runQuery("UPDATE users SET avatar = 'https://cdn.example.test/alice.png' WHERE userId = 'u_alice'"); SC.invalidate();
    a = await tileFor("u_staff");
    assert.deepEqual([a.avatar, a.ck], ["https://cdn.example.test/alice.png", "photo"], "a host off the list: its own URL (a capture draws the letter)");
    await runQuery("UPDATE users SET avatar = ? WHERE userId = 'u_alice'", [photo]); SC.invalidate();
    const rr = await post(`/api/rooms/${slug()}/micfollow/report`, { login: "alice", reason: "other" }, "u_fay");
    assert.equal(rr.status, 200, JSON.stringify(rr.d));
    const hid = await tileFor("u_fay");
    assert.equal(hid.watch, "hidden"); assert.equal(hid.avatar, null, "a reported tile: no cover, proxied or not");
  } finally {
    await MF.setCfg(ADMIN, { cover_photo_proxy: true, reason: "test" });
    SC._setPhotoNet(null);
    await runQuery("DELETE FROM stage_covers"); await runQuery("UPDATE users SET avatar = NULL WHERE userId = 'u_alice'"); SC.invalidate();
    await runQuery("DELETE FROM micfollow_reports WHERE login = 'alice'").catch(() => {});
    MF._hide.clear();
  }
});
