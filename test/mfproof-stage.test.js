// 1.99ajs mfproof: a PROVEN, LINKED mic holder whose profile keeps its room activity private (owner report 2026-11-04: "brocklee258 shows
// in the room with his camfrog mic transcripts show with his username on the site, but shows his mic grabs as 'someone' and when he
// grabs the mic, it doesn't show his camera cover, just 'someone else is speaking'"). The real facts, replayed on a temp DB with the real
// mic-stage engine, livecam, camaccess, stage bans, stageleave, profilelayout and stories.privateLogins (NOT stubbed):
//   * the PATV account brocklee258 is linked to the Camfrog login ritchiecuh; its profile_layout hides the list prod has (analytics among
//     them) = private activity; a separate CF auto account (CFsa1p1bz8) carries camfrogUsername "brocklee258" - never picked for him;
//   * Pepe's snapshot: mic {login ritchiecuh, display ritchiecuh, proven: true, since}, member {on_cam: true, src: "list"}.
// Expected:
//   defaults            eligOf "private" - no tile, "Someone else is speaking" over another tile, no courtesy notice (today's CUT, the Q14 default), and
//                       /stage/admin's pad health counts him (admins only, counts only: unshown {private: 1})
//   withheld_cover only today's CUT too (private_cover is the owner's separate decision); private_cover only: the CUT
//   both on             the DF-11 notice gate first (one courtesy notice: the _wh text, from Pepe's own account, the inbox row on HIS
//                       account), then "withheld": a NAMED card with his stage cover, "cam off" - no hold, relay, still, warm keep or
//                       want; attributed (never "Someone is speaking"); a pin stays refused; a capture still blanks him (cardConsent)
//   every other rule    still keeps him off with both on (excluded, banned, "Take me off this Stage", blocked_owner, the DM block,
//                       ended_by, !bridge hide) - each fails on a naive early return at the private check
//   fails closed        privateLogins throwing = private: the CUT, or (both on) the withheld card - never his cam
//   relief              un-hiding Analytics (profilelayout.save -> micfollow.recheckUser) makes him an ordinary candidate at once
//   node --test test/mfproof-stage.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mfproof-stage-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
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
const PL = require(path.join(repo, "profilelayout"));
const quotes = require(path.join(repo, "quotes"));
const MF = require(path.join(repo, "micfollow"));
const core = require(path.join(repo, "micfollow-core"));

W.enabled = () => true;
let T = Date.now();
LC._setClock(() => T);
stage._setClock(() => T);
MF._setClock(() => T);
MF._setBoot(0);
LC._setKick(() => {});
relay.padFull = async () => true;
premium.bridgeAllowed = () => true;
CV.noteViewers = () => Promise.resolve(0);
const realPrivate = stories.privateLogins;

// the real shapes (synthetic ids): his account, its linked login, the hidden list prod's profile_layout row has, the auto account
const HIM = { userId: "u_brock", username: "brocklee258", login: "ritchiecuh" };
const AUTO = { userId: "u_cfauto", username: "CFsa1p1bz8", camfrog: "brocklee258" };
const HIDDEN = ["avatar", "gtf", "analytics", "plex", "an_words", "an_modon", "an_modlist", "an_modcmds", "px_watch", "px_pads"];
const ROOM = { id: "PepeFrog.Room", name: "Pepe's Pad" };
const ADMIN = { userId: "u_admin", username: "admin", class: "Admin" };
const STAFF = { userId: "u_staff", username: "staffer", class: "Staff" };
let R = null;
const MEMBERS = () => [
  { login: "ritchiecuh", display: "ritchiecuh", on_cam: true, src: "list" }, { login: "bob", display: "Bob", on_cam: true, src: "list" },
  { login: "pepe", display: "Pepe", self: true, on_cam: true }];
function room(holders, extra) {
  R = bridge._rooms.get(ROOM.id);
  const mic = (holders || []).map((h) => (typeof h === "string" ? { login: h, display: h, proven: true, since: T - 5000 } : h));
  Object.assign(R, { updated: T, cams: true, livecams: true, members: MEMBERS(), mic, listFresh: true, listAt: T }, extra || {});
  return R;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
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
async function at(sec, holders, extra) { T += sec * 1000; await bot(); return step(holders, extra); }
function up(...logins) { LC.noteSync(logins.map((l) => ({ name: LC.pathFor(ROOM.id, l), ready: true, readers: [] })), T); for (const l of logins) EXACT.add(l); }
async function onStage(logins) { await step(logins); await at(3, logins); up(...logins); await at(1, logins); }
async function plainPad() { await MF.setPad(ROOM.id, { on: true, layout: "auto", default_view: "first", max_people: 4, max_live: 4, keep_recent: 0 }, "test"); }
async function knobs(extra) {
  await MF.setCfg(ADMIN, Object.assign({ enabled: true, cold_open: true, withheld_cover: false, private_cover: false, reason: "test" }, extra || {}));
}
async function hide(on) {
  await PL.save(HIM.userId, { order: [], hidden: on ? HIDDEN : HIDDEN.filter((x) => x !== "analytics"), priv: [], pub: [] });
  await MF._idle(); await settle();
}
async function reset() {
  for (const Q of MF._pads.values()) { Q.state = core.newState(); Q.stills.clear(); Q.spans.clear(); }
  for (const S of [...LC._sessions.values()]) LC._sessions.delete(S.key);
  EXACT.clear();
  T += 10 * 60 * 1000;
  stories.privateLogins = realPrivate;
  await MF.unexclude(ROOM.id, HIM.login);
  await MF.recheck(HIM.login, { refresh: true });
  await bot();
}
const ownLive = (l) => { const S = LC._sessions.get(LC.keyOf(ROOM.id, l)); return !!(S && !S.ended && S.holds.has("mf:" + ROOM.id)); };
const wantOf = async () => ((await bot()).want || []).map((w) => w.login);
/** The report's scene: bob's cam tile is up, then he holds the mic (alone on it) - with a fresh stage. */
async function withBob() { await reset(); await plainPad(); await onStage(["bob"]); return hold(6, ["bob"]); }
const padRow = async (user) => (await MF.adminView(user)).pads.find((p) => p.room === ROOM.id);
/** He holds the mic (alone, or while `live` people's tiles are up) for a while, the pad stepped as Pepe's syncs would -> what the stage
 *  did meanwhile. someone = "Someone is speaking" (the neutral card, or the strip over other tiles: the program's speaking). */
async function hold(n = 6, live = []) {
  let someone = false, everTile = false, everLive = false, everWant = false;
  await step([HIM.login]);
  for (let i = 0; i < n; i++) {
    if (live.length) up(...live);
    await at(3, [HIM.login]);
    for (let k = 0; k < 3; k++) await settle();
    const snap = MF.snapshot(ROOM.id);
    if (snap.neutral || (await MF.viewFor(snap, R, "u_v1", null)).speaking) someone = true;
    if (tileOn(HIM.login)) everTile = true;
    if (ownLive(HIM.login) || LC._sessions.has(LC.keyOf(ROOM.id, HIM.login))) everLive = true;
    if ((await wantOf()).includes(HIM.login)) everWant = true;
  }
  return { someone, everTile, everLive, everWant };
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["u_admin", "admin", "Admin", null], ["u_staff", "staffer", "Staff", null], ["u_owner", "padowner", "pleb", null],
                                     [HIM.userId, HIM.username, "pleb", HIM.login], [AUTO.userId, AUTO.username, "pleb", AUTO.camfrog],
                                     ["u_bob", "bob_patv", "pleb", "bob"], ["u_v1", "viewer1", "pleb", "viewer1"], ["pepe-bot", "Pepe", "Bot", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  for (let i = 0; i < 50 && !(await getQuery("SELECT 1 AS x FROM sqlite_master WHERE name = 'pepe_actions'")).length; i++) await settle();
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "ritchiecuh", login: "ritchiecuh", display: "ritchiecuh" }], count: 1, cams: true, livecams: true, mic: [] }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await rooms.setOwner(ROOM.id, "padowner", "test");
  await stage.init();
  await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true } });
  await CA.init();
  for (const l of [HIM.login, "bob", AUTO.camfrog]) await CA.setMode(l, "everyone");
  await MF._ready();
  for (const l of [HIM.login, "bob"]) await MF._noticed(ROOM.id, l, 1);   // (told - the tests that replay prod's "never told" clear it)
  await MF.setKill(STAFF, true, "test");
  await knobs();
  await plainPad();
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await hide(true);                                     // the profile_layout row prod has (saved 2026-10-13): private activity
});

test("the real facts: his login is private activity by the real rule (stories.privateLogins / chatlogview.privateFlags); the auto account's 'brocklee258' never is", async () => {
  assert.deepEqual([...(await stories.privateLogins([HIM.login, AUTO.camfrog]))], [HIM.login]);
  const f = await require(path.join(repo, "chatlogview")).privateFlags({ logins: [HIM.login, AUTO.camfrog] });
  assert.deepEqual([...f.logins], [HIM.login]);
  assert.equal(core.FIELDS.private_cover.def, false, "dark");
  assert.equal(MF.cfg().private_cover, false);
  assert.equal(MF.privateCover(), false);
  const view = await MF.adminView(ADMIN);
  assert.ok(view.fields.private_cover && view.fields.private_cover.bool === true, "a /stage/admin knob (auto-listed)");
});

test("defaults (today, the Q14 default): the CUT - no tile, 'Someone else is speaking' over bob's tile, no courtesy notice; pad health counts him for admins (counts only)", async () => {
  await reset(); await plainPad();
  await MF._noticed(ROOM.id, HIM.login, null);                         // prod: no micfollow_notices / micfollow_courtesy row for him
  await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
  const h = await hold(8);
  assert.deepEqual([h.everTile, h.everLive, h.everWant], [false, false, false], "never on the stage, never his cam");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify'"))[0].n, 0, "no courtesy PM (a CUT never reaches the notice gate)");
  assert.equal(await MF.courtesyOf(HIM.login), null);
  const adm = await padRow(ADMIN);
  assert.deepEqual(adm.unshown, { private: 1 }, "admins: one holder the stage can't show, private");
  assert.ok(!JSON.stringify(adm.unshown).includes(HIM.login), "counts only");
  assert.equal((await padRow(STAFF)).unshown, undefined, "staff: not shown");
  // ...and while someone else's tile is up: "Someone else is speaking" over it, his cover nowhere - the report, exactly
  const o = await withBob();
  assert.deepEqual([o.everTile, o.everLive, o.someone], [false, false, true], "the strip over bob's tile, never his card");
  // withheld_cover alone (dudepruitt76 / tutsuo's relief) changes nothing for private activity
  await knobs({ withheld_cover: true });
  try {
    const w = await withBob();
    assert.deepEqual([w.everTile, w.everLive, w.someone], [false, false, true], "withheld_cover only: still the CUT");
    assert.deepEqual((await padRow(ADMIN)).unshown, { private: 1 });
    await knobs({ private_cover: true });
    const p = await withBob();
    assert.deepEqual([p.everTile, p.everLive, p.someone], [false, false, true], "private_cover only: the CUT (the card exists only with withheld_cover)");
  } finally { await knobs(); await MF._noticed(ROOM.id, HIM.login, 1); }
});

test("both on: the one courtesy notice first (_wh, from Pepe's own account, the inbox row on HIS account - never the auto account), then a NAMED card with his cover; no cam, no 'Someone is speaking'", async () => {
  const SC = require(path.join(repo, "stagecover"));
  await SC.init();
  const asked = [], cov0 = SC.coverOf;
  SC.coverOf = (l) => { asked.push(String(l)); return cov0(l); };
  await knobs({ withheld_cover: true, private_cover: true, stills: true, warm_keep_s: 180, warm_max: 3 });
  try {
    await reset(); await plainPad();
    await MF._noticed(ROOM.id, HIM.login, null);
    await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
    await runQuery("DELETE FROM inbox WHERE kind = 'stage'");
    const pre = await hold(3);
    assert.deepEqual([pre.everTile, pre.everLive, pre.everWant], [false, false, false], "before notice_lead_s: off the stage");
    assert.deepEqual((await padRow(ADMIN)).unshown, { notice: 1 }, "the DF-11 lead time - counted as notice");
    const pm = (await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify'"));
    assert.equal(pm.length, 1, "one courtesy PM");
    const [to, text] = JSON.parse(pm[0].args);
    assert.equal(to, HIM.login);
    assert.equal(pm[0].user_id, "pepe-bot", "under Pepe's own account - the pad owner's action rows never pair the login with a private setting");
    assert.match(text, /Your cam stays off mic stages: you can show in ~2 min with your cover picture\./, "the _wh text");
    const ib = await getQuery("SELECT user_id, title FROM inbox WHERE kind = 'stage'");
    assert.deepEqual(ib.map((r) => r.user_id), [HIM.userId], "the inbox row on his account, never the auto account " + AUTO.username);
    assert.equal(ib[0].title, "🎙 Pads on PATV may show your cover picture while you hold the mic");
    T += 121 * 1000;
    asked.length = 0;
    const h = await hold(6);
    assert.equal(h.everLive || h.everWant, false, "never a relay or a want of his cam");
    assert.equal(h.someone, false, "never 'Someone is speaking' - he is shown");
    assert.ok(tileOn(HIM.login), "his tile: " + JSON.stringify(tiles()));
    assert.deepEqual([tile(HIM.login).video, tile(HIM.login).why], ["card", "withheld"]);
    assert.ok(!P().stills.has(HIM.login) && !P().state.kept.has(HIM.login), "never a still or a kept relay");
    assert.equal(MF.stillWanted(ROOM.id, HIM.login), false);
    for (const uid of ["u_v1", "u_owner", "u_admin"]) {
      const v = await MF.viewFor(MF.snapshot(ROOM.id), R, uid, null);
      const s = v.src.find((e) => e.id === HIM.login);
      assert.ok(s, uid);
      assert.deepEqual([s.kind, s.name, s.video, s.why, s.watch], ["cam", "ritchiecuh", "card", "off_cam", "ok"], uid + ": named, 'cam off' - never why");
      assert.equal(v.speaking, null, uid);
    }
    assert.ok(asked.includes(HIM.login), "the picture is stagecover.coverOf's (his own section choices decide it)");
    assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null, T, "capture")).src.find((e) => e.id === HIM.login).why, "withheld");
    assert.deepEqual((await padRow(ADMIN)).unshown, {}, "shown: not counted");
    // the tile routes have no cam to give; a pin stays refused
    const pin = await MF.pinPut({ userId: "u_owner", username: "padowner" }, ROOM.id, HIM.login, T).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, code: e.code }));
    assert.deepEqual(pin, { ok: false, code: "unavailable" }, "pins stay refused (pinRule)");
    // a capture still leaves him out: the name card's consent asks private activity (the strict lookup), whatever the switches
    const SM = require(path.join(repo, "stagemiccap"));
    assert.equal(await SM._test.cardConsent(HIM.login, "u_v1"), false, "captures: still blanked (cardConsent)");
    assert.equal(await SM._test.consent(HIM.login, "u_v1"), false, "captures: no cam either");
    // he lets go: off after the hand-over; the span carries no video
    for (let i = 0; i < 10 && tileOn(HIM.login); i++) await at(3, []);
    assert.equal(tileOn(HIM.login), false);
    const sp = (await getQuery("SELECT video_secs FROM micfollow_spans WHERE login = ? ORDER BY id DESC LIMIT 1", [HIM.login]))[0];
    assert.ok(sp && Number(sp.video_secs) === 0, "his span - no video");
    // while bob's tile is up: his card beside it, never "Someone else is speaking"
    const o = await withBob();
    assert.deepEqual([o.everLive, o.someone, tile(HIM.login) && tile(HIM.login).why], [false, false, "withheld"], "his card, attributed");
    // private_cover off again: today's CUT at once
    await hold(2);
    assert.ok(tileOn(HIM.login));
    await knobs({ withheld_cover: true, private_cover: false });
    assert.equal(tileOn(HIM.login), false, "switch off: cut at once");
    assert.equal((await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = ? ORDER BY id DESC LIMIT 1", [HIM.login]))[0].end_reason, "cut:private");
  } finally { SC.coverOf = cov0; await knobs({ warm_keep_s: 0 }); await MF._noticed(ROOM.id, HIM.login, 1); }
});

test("both on: every other stage rule still keeps a private-activity holder OFF (each fails on a naive early return at the private check); lifted: his named card", async () => {
  const SL = require(path.join(repo, "stageleave"));
  SL._setClock(() => T);
  await SL.init();
  const cool0 = LC.cooling, hid0 = quotes.isHidden;
  const CASES = [
    ["excluded", async () => MF.excludeFor(ROOM.id, HIM.login, 60, "owner", "test"), async () => MF.unexclude(ROOM.id, HIM.login)],
    ["banned", async () => { await stage.ban(HIM.username, "test", "admin"); await MF.recheck(HIM.login, { refresh: true }); },
               async () => { await stage.unban(HIM.userId, "admin"); await MF.recheck(HIM.login, { refresh: true }); }],
    ["Take me off this Stage", async () => SL.leave({ roomId: ROOM.id, login: HIM.login, userId: HIM.userId, via: "web" }, T),
                               async () => { await runQuery("DELETE FROM stage_leave"); await SL.load(T); }],
    ["blocked_owner", async () => { assert.equal((await CV.block(HIM.login, "padowner")).ok, true); }, async () => CV.unblock(HIM.login, "padowner")],
    ["the DM block with the owner", async () => { await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, 'u_owner', ?)", [HIM.userId, T]); await MF.recheck(HIM.login, { refresh: true }); },
                                    async () => { await runQuery("DELETE FROM dm_blocks"); await MF.recheck(HIM.login, { refresh: true }); }],
    ["ended_by", async () => { LC.cooling = (rid, l, t) => String(l).toLowerCase() === HIM.login || cool0(rid, l, t); }, async () => { LC.cooling = cool0; }],
    ["!bridge hide", async () => { quotes.isHidden = (l) => String(l).toLowerCase() === HIM.login || hid0(l); }, async () => { quotes.isHidden = hid0; }],
    ["the DF-11 notice gate", async () => MF._noticed(ROOM.id, HIM.login, null), async () => MF._noticed(ROOM.id, HIM.login, 1)],
  ];
  await knobs({ withheld_cover: true, private_cover: true });
  try {
    const shown = [];
    for (const [name, on, off] of CASES) {
      await reset(); await plainPad();
      await on();
      try {
        const h = await hold(6);
        const v = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
        if (h.everTile || v.src.some((s) => s.id === HIM.login)) shown.push(name);
        assert.equal(h.everLive, false, name + ": never his cam");
      } finally { await off(); await settle(); }
      if (name === "the DF-11 notice gate") T += 121 * 1000;
      for (let i = 0; i < 12 && !tileOn(HIM.login); i++) { await at(3, [HIM.login]); for (let k = 0; k < 3; k++) await settle(); }
      assert.ok(tileOn(HIM.login), name + ": lifted - his card");
      assert.equal(tile(HIM.login).why, "withheld", name);
    }
    assert.deepEqual(shown, [], "no tile in any of these: " + shown.join(", "));
    // the control: a cam opt-out on top of private activity is still the withheld card (both say "the cam only")
    await reset(); await plainPad();
    await CA.setMode(HIM.login, "followers");
    try {
      await hold(4);
      assert.deepEqual([tile(HIM.login) && tile(HIM.login).why], ["withheld"]);
    } finally { await CA.setMode(HIM.login, "everyone"); }
  } finally { LC.cooling = cool0; quotes.isHidden = hid0; await knobs(); }
});

test("fails closed: a private-activity lookup that throws is private - the CUT, or (both on) the withheld card; never his cam", async () => {
  for (const both of [false, true]) {
    await knobs(both ? { withheld_cover: true, private_cover: true } : {});
    await reset(); await plainPad();
    await hide(false);                                 // (his profile public now: only the failing lookup can make him private)
    stories.privateLogins = async () => { throw new Error("db busy"); };
    try {
      await MF.recheck(HIM.login, { refresh: true });
      const h = await hold(6);
      assert.equal(h.everLive || h.everWant, false, (both ? "both on" : "defaults") + ": never his cam");
      if (both) assert.deepEqual([tile(HIM.login) && tile(HIM.login).why], ["withheld"]);
      else assert.equal(h.everTile, false, "defaults: the CUT");
    } finally { stories.privateLogins = realPrivate; await hide(true); }
  }
  await knobs();
});

test("relief today: un-hiding Analytics (profilelayout.save rechecks him) makes him an ordinary candidate at once - and named in the stage's speaking state; hiding it again cuts him (defaults)", async () => {
  await knobs();
  await reset(); await plainPad();
  await hold(3);
  assert.equal(tileOn(HIM.login), false, "private: off");
  await hide(false);
  await at(1, [HIM.login]);
  for (let i = 0; i < 4 && !tileOn(HIM.login); i++) await at(1, [HIM.login]);
  assert.ok(tileOn(HIM.login), "public again: on the stage");
  assert.notEqual(tile(HIM.login).why, "withheld", "his cam can show (cam access everyone, live cam on)");
  assert.equal((await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null)).speaking, null, "attributed");
  await hide(true);
  await at(1, [HIM.login]);
  assert.equal(tileOn(HIM.login), false, "hidden again: cut at once");
  assert.equal((await getQuery("SELECT end_reason FROM micfollow_spans WHERE login = ? ORDER BY id DESC LIMIT 1", [HIM.login]))[0].end_reason, "cut:private");
});
