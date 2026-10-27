// CL3 chatlogview.js: the viewer's floors (spec §3.2) and forward-only widening (§2.5, the privacy critique's B3).
//   * the matrix: tier (standard / prime / unlimited) x setting (everything, off, 15 min, 90 days) x class (chat / mic / presence)
//     x viewer (signed out, member, owner, new owner, mod, mod with "read all", staff with chatlog.read_all) - plus the 18+ gate,
//     whole-bridge blocks and feed bans, the 💎 Plus gate;
//   * forward-only: Off -> Everything doesn't show earlier lines, search off -> on doesn't make earlier lines searchable,
//     Approved -> Public never shows Approved-era lines to non-members, a new owner doesn't read the earlier era, "open earlier
//     history" applies only when it takes effect (cancel works; a later bump cancels it);
//   * retention: a downgrade narrows at once, an upgrade inside the 30-day grace restores, after it doesn't;
//   * the signed join cursor: the reconnect grace only above it, a forged / foreign one counts as now, an old one re-inits;
//   * cursor bounds: one seek on chat_log_room_ts.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-floors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-floors-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PC = require(path.join(repo, "padchat"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const P = require(path.join(repo, "premium"));
const SP = require(path.join(repo, "siteperms"));
const UL = require(path.join(repo, "userlinks"));

const MIN = 60e3, H = 3600e3, D = 864e5;
let clockAt = Date.now();
CL._setClock(() => clockAt);
// (CL7 fix-up: "now" is a LATER millisecond than anything written before the call - a floor is inclusive, so a 📜 note or a line
// written in the same millisecond as the page load would count as "after" it; the read side's reconcile no longer writes exp_*
// on every view while Pepe's report isn't fresh, and that write used to keep the two apart by chance)
const fresh = () => { const t0 = Date.now(); while (Date.now() <= t0) { /* the next millisecond */ } clockAt = Date.now(); CV._clearCaches(); };

// tiers per room (premium.padPerks is the source; stubbed per room here) and the 💎 gate
const TIER = new Map(), GATED = new Set();
const realPerks = P.padPerks, realGate = P.bridgeAllowed;
P.padPerks = (id) => Object.assign({}, realPerks(id), { retention: TIER.get(id) || "standard" });
P.bridgeAllowed = (id) => !GATED.has(id);

const ALICE = { id: "alice", login: "alice", display: "Alice" };
const BOB = { id: "bob", login: "bob", display: "Bob" };
const CAROL = { id: "carol", login: "carol", display: "Carol" };
let seq = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "fl-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (room) => ({ room, members: [ALICE, BOB, CAROL], mic: [], count: 3, transcripts: true, mod: { modcf: { actions: ["kick", "ban"] } } });
const U = {};
async function mkUser(name, cls = "pleb", camfrog = null) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", ["id_" + name, name, name, cls, camfrog]);
  return { userId: "id_" + name, username: name, class: cls };
}
const label = (it) => it.text || (it.k + ":" + (it.u && it.u.login));
/** One room with lines of every age: chat 10 min .. 40 days, mic 2 / 40 / 400 days, joins 2 h (bob) and 30 h (carol). */
async function seedRoom(room, tier) {
  TIER.set(room.id, tier);
  const T = Date.now();
  await bridge.ingest({ rooms: [snap(room)], events: [
    ev(room, "message", { user: ALICE, text: "m-40d" }, T - 40 * D),
    ev(room, "x.pepe.transcript", { id: "tx-" + room.id.length + "400d00000000", user: ALICE, text: "t-400d" }, T - 400 * D),
    ev(room, "x.pepe.transcript", { id: "tx-" + room.id.length + "040d00000000", user: ALICE, text: "t-40d" }, T - 40 * D),
    ev(room, "message", { user: ALICE, text: "m-10d" }, T - 10 * D),
    ev(room, "message", { user: ALICE, text: "m-2d" }, T - 2 * D),
    ev(room, "x.pepe.transcript", { id: "tx-" + room.id.length + "002d00000000", user: ALICE, text: "t-2d" }, T - 2 * D),
    ev(room, "member.join", { user: CAROL }, T - 30 * H),
    ev(room, "message", { user: ALICE, text: "m-2h" }, T - 2 * H),
    ev(room, "member.join", { user: BOB }, T - 2 * H),
    ev(room, "message", { user: ALICE, text: "m-10min" }, T - 10 * MIN),
  ] });
}
async function sees(room, viewer, opts = {}) {
  const V = await CV.view(room.id, viewer, opts);
  const R = bridge._rooms.get(room.id);
  return CV.filter(R.feed, { view: V, jc: null }).items.filter((it) => it.k !== "note").map(label);
}
const ALL = ["m-40d", "t-400d", "t-40d", "m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"];
const only = (...keep) => ALL.filter((x) => keep.includes(x));
const setWin = (room, w, who = U.own1) => PC.save(who, { id: room.id }, { window_s: w });

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
  U.own1 = await mkUser("own1", "pleb", "own1cf");
  U.own2 = await mkUser("own2", "pleb", "own2cf");
  U.mem = await mkUser("mem");
  U.apr = await mkUser("apr");
  U.out = await mkUser("outsider");
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.boss = await mkUser("boss", "Admin", "bosscf");
  // CL3 fix-up: a room the archive made a row for (inputs NULL, no owner yet) that the registry seed then gives an owner - the
  // seed's hook (rooms.seed -> chatReconcile) must start the owner's era at that moment (checked below; no view runs for it).
  // Both are in place BEFORE bridge.load(): since the 18+ gate (adultgate.init, via padaccess.init) the bridge's load warms the
  // pad registry, and its one-time seed would run before the seeded owner's account exists.
  U.seedOwner = await mkUser("pbseed", "pleb", "foamy1111");
  await CL.init();
  await runQuery("INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES ('plant_based_chatting', 'plant_based_chatting', NULL, 0, ?)",
                 [Date.now() - D]);
  await bridge.load();
  await rooms.init();
  await PA.init();
  await P.init();
  await CV.init();
  PC._reset();
})();
const owned = async (room, who = "own1") => { await rooms.setOwner(room.id, who, "test"); fresh(); };

test("the matrix: standard tier, everything the tier keeps (the default)", async () => {
  await setup;
  const room = { id: "Std.Room", name: "Std Room" };
  await seedRoom(room, "standard");
  await owned(room);
  // a member: chat and mic 30 days (the standard windows), presence 24 hours
  assert.deepEqual(await sees(room, U.mem), only("m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"));
  // signed out on a Members pad: every line was said while it was Members (aud m) - nothing (the route refuses them anyway)
  assert.deepEqual(await sees(room, null), []);
  // the owner (from the room's start): retention, presence included
  assert.deepEqual(await sees(room, U.own1), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"));
  // a Camfrog mod (kick in Pepe's live caps): 7 days past the public floor - the public floor already is retention; presence 24 h
  assert.deepEqual(await sees(room, U.mod), only("m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"));
  assert.equal((await CV.view(room.id, U.mod)).role, "mod");
  // CL6: site staff hold chatlog.read_all (Staff and up, privacy-locked): back to retention, presence included
  assert.equal((await CV.view(room.id, U.boss)).role, "staff");
  assert.deepEqual(await sees(room, U.boss), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"));
  const V = await CV.view(room.id, U.mem);
  assert.deepEqual(V.eff, { chat: 30 * 86400, tx: 30 * 86400 });
  assert.equal(V.can.history, true);
  assert.equal(V.can.search, true);
  assert.equal(V.can.downloads, true, "on by default on a Members pad");
  assert.equal((await CV.view(room.id, null)).can.history, false, "decision 7: signed out = the live tail only");
});

test("the matrix: 15 minutes - members see 15 minutes; the owner everything; mods 7 days more (all with 'read all'); staff with read_all, audited", async () => {
  await setup;
  const room = { id: "Short.Room", name: "Short Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await setWin(room, 900);
  fresh();
  assert.deepEqual(await sees(room, U.mem), only("m-10min"));
  assert.deepEqual(await sees(room, U.own1), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"), "the owner sees past the window");
  assert.deepEqual(await sees(room, U.mod), only("m-2d", "t-2d", "m-2h", "join:bob", "m-10min"), "7 days past the window, presence 24 h");
  await PC.save(U.own1, { id: room.id }, { mods_all: true });
  fresh();
  assert.deepEqual(await sees(room, U.mod), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"), "Room mods can read all history");
  await PC.save(U.own1, { id: room.id }, { mods_all: false });
  // the room offline: no mod caps (Pepe's live caps) -> a member
  const R = bridge._rooms.get(room.id);
  const was = R.updated;
  R.updated = Date.now() - 10 * MIN;
  fresh();
  assert.deepEqual(await sees(room, U.mod), only("m-10min"), "a mod needs the room live");
  R.updated = was;
  // CL6: chatlog.read_all (staff, privacy-locked) - staff read back to retention and every read below the public floor leaves a
  // coalesced audit row
  {
    fresh();
    assert.ok(SP.BY_KEY[CV.READ_ALL], "the capability is in the registry");
    assert.equal((await CV.view(room.id, U.boss)).role, "staff");
    assert.deepEqual(await sees(room, U.boss), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"));
    const out = await bridge.liveView(R, 0, U.boss.userId, "bosscf", "boss", true, { viewer: U.boss });
    assert.ok(out.feed.some((x) => x.text === "m-2d"));
    await new Promise((r) => setTimeout(r, 30));
    const rows = await getQuery("SELECT * FROM chatlog_views WHERE user_id = ?", [U.boss.userId]);
    assert.equal(rows.length, 1, "a staff read below the public floor is audited");
    assert.equal(rows[0].kind, "history");
    await bridge.liveView(R, 0, U.boss.userId, "bosscf", "boss", true, { viewer: U.boss });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = ?", [U.boss.userId]))[0].n, 1, "coalesced per 10 minutes");
  }
});

test("the matrix: 90 days on a standard pad works as 30; Prime keeps chat for good and mic 365 days; Plus keeps everything", async () => {
  await setup;
  // (an older Pepe's report: Prime Time mic transcripts 365 days - mic retention, 2026-10-27: the site's own default now follows chat,
  //  tested below)
  await P.noteRetention({ chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: 365, rec_plus: null, pm_days: 30, pm_pass: null });
  const a = { id: "Ninety.Room", name: "Ninety Room" };
  await seedRoom(a, "standard");
  await owned(a);
  await setWin(a, 90 * 86400);
  fresh();
  assert.deepEqual(CL.effectiveWindows(a.id), { chat: 30 * 86400, tx: 30 * 86400 }, "min(setting, retention)");
  assert.deepEqual(await sees(a, U.mem), only("m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"));
  const p = { id: "Prime.Room", name: "Prime Room" };
  await seedRoom(p, "prime");
  fresh();
  assert.deepEqual(await sees(p, U.mem), only("m-40d", "t-40d", "m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"), "chat for good, mic 365 days");
  const u = { id: "Plus.Room", name: "Plus Room" };
  await seedRoom(u, "unlimited");
  fresh();
  assert.deepEqual(await sees(u, U.mem), only("m-40d", "t-400d", "t-40d", "m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"));
  assert.deepEqual(CL.effectiveWindows(u.id), { chat: null, tx: null });
  // mic retention (owner answers 2026-10-27): mic transcripts follow chat on every tier - Pepe's report from then (and the site's
  // default) keeps Prime Time's transcripts for good too
  await P.noteRetention({ chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null, pm_days: 30, pm_pass: null,
                          audio_days: 30, audio_prime: 180, audio_plus: null });
  assert.equal(P.RETENTION_DEFAULTS.rec_prime, null);
  assert.deepEqual(CL.effectiveWindows(p.id), { chat: null, tx: null });
});

test("18+ pads, whole-bridge blocks, feed bans and the 💎 Plus gate take history away (the live tail itself is unchanged)", async () => {
  await setup;
  const room = { id: "Adult.Room", name: "Adult Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [room.id]);
  await rooms.loadCache();
  let ok = new Set();
  CV._setAttested((uid) => ok.has(uid));
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, false, "18+: not age-confirmed");
  assert.equal((await CV.view(room.id, U.mem)).can.deep, false);
  ok = new Set([U.mem.userId]);
  CV._setAttested((uid) => ok.has(uid));
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, true, "age-confirmed");
  await runQuery("UPDATE rooms_registry SET adult = 0 WHERE room_id = ?", [room.id]);
  await rooms.loadCache();
  CV._setAttested(null);
  // a whole-bridge block (feature all) - a feature-only block (chat) doesn't count
  await require(path.join(repo, "bridgeblocks")).init();
  await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until, updated) VALUES (?, ?, 'chat', 'mem', '', ?, NULL, ?)",
                 [room.id, U.mem.userId, Date.now(), Date.now()]).catch(async () => {
    await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until) VALUES (?, ?, 'chat', 'mem', '', ?, NULL)", [room.id, U.mem.userId, Date.now()]);
  });
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, true, "a chat-only block keeps history");
  await runQuery("UPDATE bridge_blocks SET feature = 'all' WHERE user_id = ?", [U.mem.userId]);
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, false, "blocked from the whole bridge");
  await runQuery("DELETE FROM bridge_blocks WHERE user_id = ?", [U.mem.userId]);
  await runQuery("CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT, room_id TEXT, username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER)");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, at, until) VALUES (?, ?, ?, NULL)", [U.mem.userId, room.id, Date.now()]);
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, false, "banned from the pad's feed");
  assert.deepEqual(await sees(room, U.mem), only("m-10d", "m-2d", "t-2d", "m-2h", "join:bob", "m-10min"), "the live tail itself stays");
  await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.mem.userId]);
  // decision 24: a pad without the bridge perk keeps history for its owner (and staff) only
  GATED.add(room.id);
  fresh();
  assert.equal((await CV.view(room.id, U.mem)).can.history, false);
  assert.equal((await CV.view(room.id, U.own1)).can.history, true);
  GATED.delete(room.id);
});

test("forward-only: Off -> Everything doesn't bring earlier lines back; new lines show", async () => {
  await setup;
  const room = { id: "OffOn.Room", name: "OffOn Room" };
  await seedRoom(room, "standard");
  await owned(room);
  fresh();
  await setWin(room, 0);
  fresh();
  assert.deepEqual(await sees(room, U.mem), [], "Off: nothing earlier");
  await setWin(room, null);
  fresh();
  assert.deepEqual(await sees(room, U.mem), [], "Everything again: what had left public view stays out");
  assert.deepEqual(await sees(room, U.own1), only("m-10d", "m-2d", "t-2d", "join:carol", "m-2h", "join:bob", "m-10min"), "the owner still reads it");
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "said after" }, Date.now() + 5)] });
  clockAt = Date.now() + 1000;
  assert.ok((await CV.view(room.id, U.mem)).floor.chat <= Date.now() + 5);
  const R = bridge._rooms.get(room.id);
  const V = await CV.view(room.id, U.mem);
  assert.deepEqual(CV.filter(R.feed, { view: V, jc: null }).items.filter((it) => it.k === "msg").map(label), ["said after"]);
  const ev1 = await getQuery("SELECT what, detail FROM room_events WHERE room_id = ? AND what = 'chat.history' ORDER BY ts", [room.id]);
  assert.deepEqual(ev1.map((r) => r.detail), ["window everything -> off", "window off -> everything"]);
});

test("forward-only: search off -> on doesn't make the lines said while it was off searchable (members); the owner ignores it", async () => {
  await setup;
  const room = { id: "Search.Room", name: "Search Room" };
  await seedRoom(room, "standard");
  await owned(room);
  fresh();
  await PC.save(U.own1, { id: room.id }, { search: false });
  fresh();
  let V = await CV.view(room.id, U.mem);
  assert.equal(V.can.search, false, "search off: not for members");
  assert.equal((await CV.view(room.id, U.own1)).can.search, true, "the owner still searches");
  assert.equal((await CV.view(room.id, U.mod)).can.search, true, "and the room's mods");
  const t = Date.now();
  clockAt = t;
  await PC.save(U.own1, { id: room.id }, { search: true });
  fresh();
  V = await CV.view(room.id, U.mem);
  assert.equal(V.can.search, true);
  assert.ok(V.searchFloor.chat >= t, "lines said while search was off stay unsearchable for members");
  const O = await CV.view(room.id, U.own1);
  assert.equal(O.searchFloor.chat, O.floor.chat, "the owner's search floor is their floor");
});

test("forward-only: Approved -> Public never shows Approved-era lines to non-members; approved members keep them", async () => {
  await setup;
  const room = { id: "Appr.Room", name: "Appr Room" };
  await seedRoom(room, "standard");
  await owned(room);
  const R0 = await rooms.get(room.id);
  await PA.setLevel(U.own1, R0, "approved");
  const T = Date.now();
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "said while approved" }, T)] });
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES (?, ?, 'approved', ?, ?)", [room.id, U.apr.userId, T, T]);
  await PA.load();
  fresh();
  assert.ok(!(await sees(room, U.out)).includes("said while approved"), "an Approved pad's lines never reach a non-member");
  assert.ok((await sees(room, U.apr)).includes("said while approved"));
  await PA.setLevel(U.own1, R0, "public");
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "said while public" }, Date.now() + 5)] });
  clockAt = Date.now() + 1000; CV._clearCaches();
  const out = await sees(room, U.out);
  assert.ok(!out.includes("said while approved"), "not after it opens up either (aud_m + the line's own aud)");
  assert.ok(!out.includes("m-2h"), "nothing from before the widening");
  assert.ok(out.includes("said while public"));
  assert.ok((await sees(room, U.apr)).includes("said while approved"), "approved members keep reading it");
  const anon = await sees(room, null);
  assert.deepEqual(anon, ["said while public"], "signed out on the now-Public pad: only lines said while it was Public");
  const W = CV._rows.get(room.id);
  assert.ok(W.aud_m >= T, "aud_m moved at the change");
});

test("forward-only: a new owner doesn't read the earlier era (owner_since); the old one is a member again", async () => {
  await setup;
  const room = { id: "Owner.Room", name: "Owner Room" };
  await seedRoom(room, "standard");
  await owned(room, "own1");
  await setWin(room, 900);
  fresh();
  assert.ok((await sees(room, U.own1)).includes("m-2h"));
  await rooms.setOwner(room.id, "own2", "test");
  fresh();
  assert.deepEqual(await sees(room, U.own2), only("m-10min"), "the new owner gets the public view of the earlier era");
  assert.deepEqual(await sees(room, U.own1), only("m-10min"), "the old owner is a member now");
  assert.ok(CV._rows.get(room.id).owner_since >= clockAt - 60e3);
  const evs = await getQuery("SELECT what FROM room_events WHERE room_id = ? AND what = 'owner'", [room.id]);
  assert.ok(evs.length >= 2);
});

test("'Also open earlier history': only at effect (7 days); cancel works; a narrow + widen meanwhile (a newer closure) cancels it", async () => {
  await setup;
  const room = { id: "Open.Room", name: "Open Room" };
  await seedRoom(room, "standard");
  await owned(room);
  fresh();
  await assert.rejects(PC.openEarlier(U.own1, { id: room.id }, "window"), (e) => e.code === "nothing", "nothing is closed yet");
  await setWin(room, 0);
  await setWin(room, null);
  fresh();
  const st = await PC.state(room.id, U.own1);
  assert.equal(st.closed.window, true);
  await assert.rejects(PC.openEarlier(U.mem, { id: room.id }, "window"), (e) => e.status === 403, "owners only");
  const s1 = await PC.openEarlier(U.own1, { id: room.id }, "window");
  assert.equal(s1.open.scope, "window");
  const eff = s1.open.effective;
  assert.ok(eff >= clockAt + CV.OPEN_DELAY_MS - 5000);
  await assert.rejects(PC.openEarlier(U.own1, { id: room.id }, "window"), (e) => e.code === "pending");
  const R = bridge._rooms.get(room.id);
  assert.ok(R.feed.some((it) => it.k === "note" && it.w === "open" && it.o === eff), "📜 announced at once in the pad");
  const sync1 = await CL.forOwnerSync([{ id: room.id }]);
  assert.equal(sync1[0].chatlog.open_at, eff, "Pepe announces it from the owner sync (CL4)");
  clockAt = eff - D; CV._clearCaches();
  assert.ok(!(await sees(room, U.mem)).includes("m-2h"), "6 days later: still closed");
  clockAt = eff + 1000; CV._clearCaches();
  assert.ok((await sees(room, U.mem)).includes("m-2h"), "at effect: open");
  assert.ok(R.feed.some((it) => it.k === "note" && it.w === "open_done"), "📜 announced again when it takes effect");
  assert.equal((await getQuery("SELECT state FROM chatlog_open WHERE id = (SELECT MAX(id) FROM chatlog_open)"))[0].state, "done");
  // cancel
  const room2 = { id: "Cancel.Room", name: "Cancel Room" };
  await seedRoom(room2, "standard");
  await owned(room2);
  await setWin(room2, 0); await setWin(room2, null);
  fresh();
  const s2 = await PC.openEarlier(U.own1, { id: room2.id }, "window");
  await PC.cancelEarlier(U.own1, { id: room2.id });
  clockAt = s2.open.effective + 1000; CV._clearCaches();
  assert.ok(!(await sees(room2, U.mem)).includes("m-2h"), "cancelled: nothing opens");
  // a narrowing and a widening while pending close a newer period - that cancels it (fail closed: a newer closure is never
  // opened unannounced)
  fresh();
  const s3 = await PC.openEarlier(U.own1, { id: room2.id }, "window");
  await setWin(room2, 3600);
  clockAt += 2 * H;
  await setWin(room2, null);
  clockAt = s3.open.effective + 1000; CV._clearCaches();
  assert.ok(!(await sees(room2, U.mem)).includes("m-2h"));
  const rows = await getQuery("SELECT state FROM chatlog_open WHERE rk = ? ORDER BY id", [CV._rows.get(room2.id).rk]);
  assert.deepEqual(rows.map((r) => r.state), ["cancelled", "cancelled"]);
  const evs = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'chat.open_earlier' ORDER BY ts", [room2.id]);
  assert.ok(evs.some((r) => /cancelled: the settings closed history again/.test(r.detail)), "audited");
});

test("retention: a downgrade narrows at once; an upgrade inside the 30-day grace restores; after it, nothing comes back", async () => {
  await setup;
  const a = { id: "Grace.Room", name: "Grace Room" };
  await seedRoom(a, "unlimited");
  fresh();
  assert.ok((await sees(a, U.mem)).includes("m-40d"));
  TIER.set(a.id, "standard");
  fresh();
  assert.ok(!(await sees(a, U.mem)).includes("m-40d"), "a downgrade narrows visibility at once");
  clockAt = Date.now() + D; CV._clearCaches();
  TIER.set(a.id, "unlimited");
  assert.ok((await sees(a, U.mem)).includes("m-40d"), "an upgrade inside the grace restores");
  const b = { id: "Lapse.Room", name: "Lapse Room" };
  await seedRoom(b, "unlimited");
  fresh();
  TIER.set(b.id, "standard");
  await CV.view(b.id, U.mem);
  clockAt = Date.now() + 31 * D; CV._clearCaches();
  TIER.set(b.id, "unlimited");
  const after = await sees(b, U.mem);
  assert.ok(!after.includes("m-40d") && !after.includes("m-2d"), "past the grace: the cutoff is permanent (exp_*)");
  assert.ok(CV._rows.get(b.id).exp_chat > 0);
  const T = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", ["tier:" + b.id]))[0].value);
  assert.equal(T.tier, "unlimited");
});

test("the signed join cursor: under Off a reconnect gets only lines said after the page loaded; forged / foreign = now; old = reinit", async () => {
  await setup;
  const room = { id: "Jc.Room", name: "Jc Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await setWin(room, 0);
  const R = bridge._rooms.get(room.id);
  fresh();
  const first = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  assert.deepEqual(first.feed, [], "a fresh load shows nothing earlier");
  assert.match(first.jc, /^j1\.\d+\.\d+\./);
  assert.equal(first.history.window_s, 0);
  const at = first.cursor;
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "new while open" }, Date.now())] });
  fresh();
  const next = await bridge.liveView(R, at, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: first.jc });
  assert.deepEqual(next.feed.map(label), ["new while open"], "the reconnect grace, above the join cursor");
  const forged = first.jc.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.deepEqual((await bridge.liveView(R, at, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: forged })).feed, [], "forged = now");
  const foreign = CV.signJc("Other.Room", 0);
  assert.deepEqual((await bridge.liveView(R, at, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: foreign })).feed, [], "another room's = now");
  assert.deepEqual((await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem })).feed, [], "after=0: nothing earlier");
  const below = CV.signJc(room.id, at - 3);
  const b2 = await bridge.liveView(R, at - 3, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: below });
  assert.ok(!b2.feed.some((x) => /^m-/.test(x.text || "")), "never anything said before the join cursor's own lines");
  clockAt = Date.now() + CV.JC_TTL + 60e3;
  const old = await bridge.liveView(R, at, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: first.jc });
  assert.equal(old.reinit, true, "a day-old join cursor: the page loads its view again");
  assert.ok(!old.feed);
});

test("an item without aud counts as the pad's level now; closedView fails closed", async () => {
  await setup;
  const room = { id: "Std.Room" };
  fresh();
  const V = await CV.view(room.id, U.mem);
  const t = Date.now();
  const it = { c: 1, k: "msg", ts: t, text: "x", u: { login: "alice", display: "Alice" } };
  assert.equal(CV.filter([it], { view: V, jc: null }).items.length, 1);
  assert.equal(CV.filter([it], { view: Object.assign({}, V, { signed: false }), jc: null }).items.length, 0, "a Members pad: signed out never");
  const C = CV.closedView(t);
  assert.equal(CV.filter([Object.assign({}, it, { ts: t - 1 })], { view: C, jc: null }).items.length, 0);
});

test("cursor bounds: each floor becomes a cursor by one seek on chat_log_room_ts", async () => {
  await setup;
  const room = { id: "Bounds.Room", name: "Bounds Room" };
  if (!CL.on("notice")) await CL.setSwitch("notice", true, "test");
  clockAt = CL.cfg().notice_at + CL.NOTICE_DAYS * D + 1000;
  await CL.setSwitch("archive", true, "test");
  const T = Date.now();
  await bridge.ingest({ rooms: [snap(room)], events: [
    ev(room, "message", { user: ALICE, text: "b-3h" }, T - 3 * H),
    ev(room, "message", { user: ALICE, text: "b-1h" }, T - H),
    ev(room, "message", { user: ALICE, text: "b-now" }, T),
  ] });
  const rk = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [room.id]))[0].rk;
  const cs = (await getQuery("SELECT c, text FROM chat_log WHERE rk = ? ORDER BY c", [rk])).reduce((m, r) => Object.assign(m, { [r.text]: r.c }), {});
  const b = await CV.cursorBounds(rk, { chat: T - 2 * H, tx: T - 4 * H, presence: T + H });
  assert.equal(b.chat, cs["b-1h"]);
  assert.equal(b.tx, cs["b-3h"]);
  assert.equal(b.presence, null);
  assert.equal(b.min, cs["b-3h"]);
  const plan = (await getQuery("EXPLAIN QUERY PLAN SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [rk, T])).map((r) => r.detail).join(" | ");
  assert.match(plan, /chat_log_room_ts/);
  assert.doesNotMatch(plan, /SCAN chat_log(?! USING)/);
  await CL.setSwitch("archive", false, "test");
  fresh();
});

// ───────────────────────── CL3 fix-up ─────────────────────────
const dbRow = async (id) => (await getQuery("SELECT * FROM chatlog_rooms WHERE room_id = ?", [id]))[0];
// the bridge holds at most 20 live rooms: these tests let theirs go when done (Pepe's "closed")
const dropRooms = (...rs) => bridge.ingest({ closed: rs.map((r) => r.id), rooms: [], events: [] });

test("hooks move the watermarks at the moment of change - also on a row the archive made (no inputs yet); no view needed", async () => {
  await setup;
  // the seed's hook (setup): an archive row with no owner, the seed gives the room one -> a new owner's era from then
  let s = null;
  for (let i = 0; i < 100 && !(s && s.inputs); i++) { s = await dbRow("plant_based_chatting"); if (!(s && s.inputs)) await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(s && s.inputs, "the seed's hook reconciled the room");
  assert.equal(s.owner_id, U.seedOwner.userId);
  assert.ok(Number(s.owner_since) > 0, "the seeded owner doesn't inherit the era before the seed");
  // rooms.setOwner on an archive row (inputs NULL, the owner the archive saw): owner_since = the moment of the change
  const room = { id: "Hook.Room", name: "Hook Room" };
  await seedRoom(room, "standard");
  await owned(room, "own1");
  await runQuery("UPDATE chatlog_rooms SET inputs = NULL, owner_id = ?, owner_since = 0 WHERE room_id = ?", [U.own1.userId, room.id]);
  CV._rows.delete(room.id);
  const T1 = Date.now() - 5 * MIN;
  clockAt = T1;
  await rooms.setOwner(room.id, "own2", "test");
  let r = await dbRow(room.id);
  assert.equal(Number(r.owner_since), T1, "the hook, at the change (a view would have said a later time)");
  assert.equal(r.owner_id, U.own2.userId);
  clockAt = Date.now(); CV._clearCaches();
  await CV.view(room.id, U.own2);
  assert.equal(Number((await dbRow(room.id)).owner_since), T1, "a later view moves nothing");
  // padaccess.setLevel: Approved -> Members, at the moment of the change
  const R0 = await rooms.get(room.id);
  await PA.setLevel(U.own2, R0, "approved");
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "said while approved" }, Date.now() + 2)] });
  const T2 = Date.now() + 10;
  clockAt = T2;
  await PA.setLevel(U.own2, R0, "members");
  assert.equal(Number((await dbRow(room.id)).aud_m), T2, "aud_m moved by the hook");
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES (?, ?, 'approved', ?, ?)", [room.id, U.apr.userId, T2, T2]);
  await PA.load();
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "said while members" }, T2 + 500)] });
  clockAt = T2 + 1000; CV._clearCaches();
  const mem = await sees(room, U.mem);
  assert.ok(!mem.includes("said while approved"), "Approved -> Members: a non-approved member never reads the Approved era");
  assert.ok(mem.includes("said while members"));
  assert.ok((await sees(room, U.apr)).includes("said while approved"), "an approved member keeps it");
  assert.equal(Number((await dbRow(room.id)).aud_m), T2);
  // a hook saying "a different pad" (padconnect) on an archive row with no inputs is honoured
  const r2 = { id: "HookPad.Room", name: "HookPad Room" };
  await seedRoom(r2, "standard");
  await owned(r2);
  await runQuery("UPDATE chatlog_rooms SET inputs = NULL WHERE room_id = ?", [r2.id]);
  CV._rows.delete(r2.id);
  const T3 = Date.now();
  clockAt = T3;
  await CV.reconcileNow(r2.id, { newPad: true });
  r = await dbRow(r2.id);
  assert.deepEqual([r.wm_chat, r.wm_tx, r.wm_search, r.aud_m].map(Number), [T3, T3, T3, T3]);
  await dropRooms(room, r2);
  fresh();
});

test("the lazy backstop: no pad -> a pad, a site pad connected to an archive row's room, and a merge that re-keys the owner", async () => {
  await setup;
  // the room loses its pad (no registry row), a view records that, then it gets one: a new public period
  const room = { id: "NoPad.Room", name: "NoPad Room" };
  await seedRoom(room, "standard");
  fresh();
  await CV.view(room.id, U.mem);
  await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [room.id]);
  await rooms.loadCache();
  fresh();
  await CV.view(room.id, U.mem);
  assert.equal(CV._rows.get(room.id).inputs.pad, null, "recorded: no pad");
  assert.ok((await sees(room, U.mem)).includes("m-2h"));
  await rooms.addRoom(room.id, "NoPad Room", "test");
  const T = Date.now();
  clockAt = T; CV._clearCaches();
  assert.deepEqual(await sees(room, U.mem), [], "null -> a pad: nothing earlier for visitors");
  assert.equal(CV._rows.get(room.id).wm_chat, T);
  // an archive row (no inputs) whose room got a site pad connected since (padconnect's "pad-connected" event)
  const a = { id: "Conn.Room", name: "Conn Room" };
  await seedRoom(a, "standard");
  await owned(a);
  // (the row is younger than the pad's registry row - only the connect event tells)
  const created = Date.now() - 1000;
  await runQuery("UPDATE chatlog_rooms SET inputs = NULL, created = ? WHERE room_id = ?", [created, a.id]);
  CV._rows.delete(a.id);
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'pad-connected', 'test', 'x')", [a.id, created + 500]);
  fresh();
  assert.deepEqual(await sees(a, U.mem), [], "a pad connected since the row was made: a new public period");
  // a merge re-keys chatlog_rooms.owner_id (accountMerge) - not a new owner
  const m = { id: "Merge.Room", name: "Merge Room" };
  await seedRoom(m, "standard");
  await owned(m, "own1");
  fresh();
  await CV.view(m.id, U.own1);
  const before = CV._rows.get(m.id).owner_since;
  await runQuery("UPDATE chatlog_rooms SET owner_id = ? WHERE room_id = ?", [U.own2.userId, m.id]);
  await runQuery("UPDATE rooms_registry SET owner_user_id = ? WHERE room_id = ?", [U.own2.userId, m.id]);
  await rooms.loadCache();
  clockAt = Date.now() + MIN; CV._clearCaches();
  await CV.view(m.id, U.own2);
  assert.equal(CV._rows.get(m.id).owner_since, before, "the merged owner keeps their era");
  assert.equal(JSON.parse((await dbRow(m.id)).inputs).owner, U.own2.userId);
  // account deletion: the owner the watermarks last saw is never a deleted account's id
  assert.ok((await CV.forgetOwner(U.own2.userId)) >= 1);
  const gone = await dbRow(m.id);
  assert.equal(gone.owner_id, null);
  assert.equal(JSON.parse(gone.inputs).owner, null);
  await dropRooms(room, a, m);
  fresh();
});

test("the floors come from ONE snapshot of the inputs: a setting saved between two reads never meets unmoved watermarks", async () => {
  await setup;
  const room = { id: "Race.Room", name: "Race Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await setWin(room, 900);
  fresh();
  // the 15-minute setting, and then "Everything" lands between the view's reads (writeRow before its reconcileNow): the old
  // view read the inputs, reconciled, then read the settings row again - and showed the whole tail with 15-minute watermarks
  const realCfg = CL.padCfg;
  let n = 0;
  CL.padCfg = (id) => { const c = realCfg(id); if (id !== room.id) return c; n++; return Object.assign({}, c, { window_s: n === 1 ? 900 : null }); };
  try {
    assert.deepEqual(await sees(room, U.mem), only("m-10min"), "the member sees the window the reconcile applied");
  } finally { CL.padCfg = realCfg; }
  // ...and the real save after it: forward-only as always
  await setWin(room, null);
  fresh();
  assert.deepEqual(await sees(room, U.mem), only("m-10min"));
  await dropRooms(room);
});

test("'open earlier history': two requests at once make one; a new owner cancels a pending one; it's audited", async () => {
  await setup;
  const room = { id: "Open2.Room", name: "Open2 Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await setWin(room, 0); await setWin(room, null);
  fresh();
  PC._reset();
  const both = await Promise.allSettled([PC.openEarlier(U.own1, { id: room.id }, "window"), PC.openEarlier(U.own1, { id: room.id }, "window")]);
  assert.deepEqual(both.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(both.find((x) => x.status === "rejected").reason.code, "pending");
  const rk = CV._rows.get(room.id).rk;
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_open WHERE rk = ? AND state = 'pending'", [rk]))[0].n, 1, "one pending row");
  const R = bridge._rooms.get(room.id);
  assert.equal(R.feed.filter((it) => it.k === "note" && it.w === "open").length, 1, "one 📜 note");
  const eff = CV.pendingOpen(room.id).effective;
  await rooms.setOwner(room.id, "own2", "test");
  assert.equal(CV.pendingOpen(room.id), null, "a new owner never inherits an opening");
  assert.deepEqual((await getQuery("SELECT state FROM chatlog_open WHERE rk = ?", [rk])).map((x) => x.state), ["cancelled"]);
  const evs = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'chat.open_earlier'", [room.id]);
  assert.ok(evs.some((x) => /cancelled: the pad has a new owner/.test(x.detail)));
  clockAt = eff + 1000; CV._clearCaches();
  assert.ok(!(await sees(room, U.mem)).includes("m-2h"), "nothing opens");
  await dropRooms(room);
  fresh();
});

test("the join cursor: bound to its viewer; a fresh load (after=0) never takes one; the history block's version is opaque", async () => {
  await setup;
  const room = { id: "Jc2.Room", name: "Jc2 Room" };
  await seedRoom(room, "standard");
  await owned(room);
  await setWin(room, 0);
  const R = bridge._rooms.get(room.id);
  fresh();
  const first = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user: ALICE, text: "after the load" }, Date.now())] });
  fresh();
  const mine = await bridge.liveView(R, first.cursor, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: first.jc });
  assert.deepEqual(mine.feed.map(label), ["after the load"], "the page's own reconnect");
  const theirs = await bridge.liveView(R, first.cursor, U.apr.userId, null, "apr", false, { viewer: U.apr, jc: first.jc });
  assert.deepEqual(theirs.feed, [], "another account's cursor counts as forged");
  // a fresh load presenting a 5-minute-old cursor: nothing earlier (it used to replay the last 10 minutes)
  clockAt = Date.now() + 5 * MIN; CV._clearCaches();
  const again = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem, jc: first.jc });
  assert.deepEqual(again.feed.filter((it) => it.k === "msg").map(label), [], "after=0 ignores the cursor");
  assert.match(again.history.v, /^[A-Za-z0-9_-]{16}$/, "an opaque digest, no watermark in it");
  assert.ok(!String(again.history.v).includes(String(CV._rows.get(room.id).wm_chat)));
  await dropRooms(room);
  fresh();
});

test("tier changes are tracked from when they happen (the 10-minute sweep), not from the next view", async () => {
  await setup;
  const room = { id: "Sweep.Room", name: "Sweep Room" };
  await seedRoom(room, "unlimited");
  fresh();
  await CV.view(room.id, U.mem);
  assert.equal(CV._tiers.get(room.id).tier, "unlimited");
  TIER.set(room.id, "standard");
  const T = Date.now();
  clockAt = T;
  assert.ok((await CV.sweepTiers()) >= 1);
  const t = CV._tiers.get(room.id);
  assert.deepEqual([t.tier, t.prev, t.drop_at], ["standard", "unlimited", T], "the grace starts at the sweep");
  assert.equal(JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", ["tier:" + room.id]))[0].value).drop_at, T);
  assert.equal(await CV.sweepTiers(), 0, "nothing changed: nothing reconciled");
  await dropRooms(room);
  fresh();
});
