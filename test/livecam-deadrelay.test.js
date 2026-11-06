// 1.99ahn dead relay (owner 2026-11-02: "Scarface's cam isn't loading here even though on the VM I see it loaded"): a relay
// counts as live only when MediaMTX has its stream (noteSync), never on Pepe's word alone. ~7% of Pepe's WHIP publishes are
// one-sided - MediaMTX drops the session but ffmpeg says "connected" and never exits - so Pepe reports them live for good and
// the tile sat at "cam starting…" until the person left the stage. Here, on a fake clock: a never-ready relay Pepe reports
// live ends start_timeout at START_MS (+ BOT_GRACE_MS after his first "live"), want[].nomedia asks Pepe to restart it after
// NOMEDIA_MS of fresh path lists without it, a relay that WAS ready and lost its stream gets nomedia after LOST_MS and ends
// relay_lost START_MS later, a stale MediaMTX path list (its API unreachable) ends nothing, the admin view says "no media",
// and the mic stage treats relay_lost as a soft failure (another try soon).
//   node --test test/livecam-deadrelay.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcdead-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const B = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const M = require(path.join(repo, "micfollow-core"));

W.enabled = () => true;
let T = 1_000_000_000_000;
LC._setClock(() => T);
LC._setKick(() => {});
relay.padFull = async () => true;

const LOGINS = ["ann", "ben", "cat", "dot", "eve", "fox", "gil", "hal"];
const R = { id: "Dead.Room", slug: "dead-room", cams: true, livecams: true, members: LOGINS.map((l) => ({ login: l, display: l.toUpperCase(), on_cam: true })) };
const MFH = "mf:" + R.id;
const key = (l) => LC.keyOf(R.id, l);
const sess = (l) => LC._sessions.get(key(l));
/** Pepe's poll: these cams live (exact, as the mic stage asks), with their restart counts. -> the site's answer */
const pepe = (live) => LC.forBot({ cap: true, mf: 1, live: Object.entries(live).map(([login, x]) => ({ room: R.id, login, state: x.state || "live",
  exact: true, restarts: x.restarts || 0 })) }, T);
/** MediaMTX's path list (webrtc.sync, every 5 s): `ready` = these cams' paths have their stream. */
const mtx = (...ready) => LC.noteSync(ready.map((l) => ({ name: LC.pathFor(R.id, l), ready: true, readers: [] })), T);
const wantOf = (ans, l) => ans.want.find((x) => x.login === l) || null;

/**
 * Run second by second from `t0 + from` to `t0 + to` (both s): each second Pepe polls (`pepeAt(s)` -> his live map, or null for
 * no poll), every 5 s MediaMTX's list comes (`syncAt(s)` -> the ready logins, or null = its API didn't answer). Stops when `stop()`.
 * -> [{s, ans}] Pepe's answers
 */
async function run(t0, from, to, { pepeAt, syncAt, stop }) {
  const out = [];
  for (let s = from; s <= to; s++) {
    T = t0 + s * 1000;
    if (s % 5 === 0 && syncAt) { const r = syncAt(s); if (r) mtx(...r); }
    const live = pepeAt ? pepeAt(s) : null;
    if (live) out.push({ s, ans: await pepe(live) });
    else LC.sweep(T);
    if (stop && stop()) break;
  }
  return out;
}
/** Each test starts with no relays (one that a test leaves running never takes another test's max_live place). */
function fresh() { T += 120 * 1000; LC._sessions.clear(); }
const firstNomedia = (answers, l) => { const x = answers.find((a) => { const w = wantOf(a.ans, l); return w && w.nomedia === true; }); return x ? x.s : null; };

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await LC.init();
  await LC.save({ class: "Admin", userId: "a", username: "admin" }, { cfg: { enabled: true } });
  B._rooms.set(R.id, R);
  await pepe({});
});

test("a relay Pepe reports live + exact that MediaMTX never has: want[].nomedia after 15 s of fresh lists without it, ends start_timeout at +45 s (logged without the login on the mic stage)", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "ann", MFH, T, { mf: true });
  const S = sess("ann"), t0 = S.createdAt;
  const logs = [], log0 = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  let answers;
  try {
    answers = await run(t0, 1, 60, { pepeAt: (s) => (s >= 2 ? { ann: {} } : {}), syncAt: () => [], stop: () => S.ended });
  } finally { console.log = log0; }
  // the fresh lists without it start at +5 s: 15 s later (+20 s) Pepe is asked to restart the publish - never sooner
  assert.equal(firstNomedia(answers, "ann"), 20, "nomedia only after 15 s of fresh path lists without the stream");
  assert.ok(answers.filter((a) => a.s < 20).every((a) => !(wantOf(a.ans, "ann") || {}).nomedia));
  assert.ok(S.ended, "a relay MediaMTX never had ends");
  assert.equal(S.endWhy, "start_timeout");
  assert.ok(S.ended > t0 + LC.START_MS && S.ended <= t0 + 45 * 1000, `at START_MS: ended +${(S.ended - t0) / 1000}s`);
  assert.equal(S.liveAt, 0, "never live - Pepe's word alone isn't");
  const nm = logs.filter((l) => /^\[livecam\] no media /.test(l));
  assert.equal(nm.length, 1, "one 'no media' line per loss: " + JSON.stringify(nm));
  assert.match(nm[0], /^\[livecam\] no media room=Dead\.Room target=- /, "a mic-stage relay's line has no login");
  assert.ok(!nm[0].includes("ann"));
});

test("BOT_GRACE_MS: a slow open Pepe reports live late (+35 s) isn't cut at +40 s - it ends once the path lists have shown 15 s without it after his first 'live'", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "ben", "slot-ben", T);
  const S = sess("ben"), t0 = S.createdAt;
  await run(t0, 1, 49, { pepeAt: (s) => (s >= 35 ? { ben: {} } : {}), syncAt: () => [] });
  assert.ok(!S.ended, "+49 s: still in the grace after Pepe's first 'live' at +35 s");
  // (review F1: judged on the lists - the one at +50 s is the first with 15 s of them after his "live": nomedia then; review
  // F2: he gets RESTART_MS to act on it - this Pepe ignores it, like an older one - so it ends 10 s after that)
  const answers = await run(t0, 50, 70, { pepeAt: () => ({ ben: {} }), syncAt: () => [], stop: () => S.ended });
  assert.equal(firstNomedia(answers, "ben"), 50, "asked to restart it on the +50 s list - not ended before he could");
  assert.ok(S.ended && S.endWhy === "start_timeout", `then start_timeout (${S.endWhy})`);
  assert.equal(S.ended, t0 + 61 * 1000, "RESTART_MS after the nomedia");
});

test("control: MediaMTX has the stream - live (liveAt is MediaMTX's moment, not Pepe's report), never ended, no nomedia", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "cat", "slot-cat", T);
  const S = sess("cat"), t0 = S.createdAt;
  const answers = await run(t0, 1, 180, { pepeAt: (s) => (s >= 2 ? { cat: {} } : {}), syncAt: (s) => (s >= 5 ? ["cat"] : []) });
  assert.ok(!S.ended, "a healthy relay lives on");
  assert.equal(LC.stageState("slot-cat", T).state, "live");
  assert.equal(S.liveAt, t0 + 5000, "liveAt = the first MediaMTX list that had it (+5 s), not Pepe's 'live' (+2 s)");
  assert.equal(firstNomedia(answers, "cat"), null, "never nomedia");
  const row = (await LC.adminView()).sessions.find((x) => x.login === "cat");
  assert.ok(row && !row.nomedia && row.liveAt === t0 + 5000);
});

test("a stale MediaMTX list (its API unreachable) ends nothing and asks for no restart; once it answers again, the dead relay ends 15 s later", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "dot", "slot-dot", T);
  const S = sess("dot"), t0 = S.createdAt;
  // the API answered once (+0 s), then not for 5 minutes: Pepe's word counts as before
  mtx();
  const answers = await run(t0, 1, 300, { pepeAt: (s) => (s >= 2 ? { dot: {} } : {}), syncAt: () => null });
  assert.ok(!S.ended, "nothing is ended on a stale list");
  assert.equal(firstNomedia(answers, "dot"), null, "no restart asked on a stale list");
  // it answers again (every 5 s) and still has no stream: the not-ready clock starts over at +305 s
  await run(t0, 301, 330, { pepeAt: () => ({ dot: {} }), syncAt: () => [], stop: () => S.ended });
  assert.ok(S.ended && S.endWhy === "start_timeout", `then it ends (${S.endWhy})`);
  assert.equal(S.ended, t0 + 320 * 1000, "15 s after the lists came back - not on the first fresh list after the gap");
  assert.equal(LC.syncFresh(T), true, "the lists are fresh again");
  T += 16 * 1000;
  assert.equal(LC.syncFresh(T), false, "16 s without one: stale");
});

test("relay_lost: a relay that WAS ready loses its stream - nomedia after 20 s, the admin view says 'no media', relay_lost START_MS after the first nomedia", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "eve", "slot-eve", T);
  const S = sess("eve"), t0 = S.createdAt;
  const answers = await run(t0, 1, 130, { pepeAt: (s) => (s >= 2 ? { eve: {} } : {}), syncAt: (s) => (s >= 5 && s < 60 ? ["eve"] : []), stop: () => S.ended });
  assert.ok(S.liveAt > 0, "it was live");
  assert.equal(firstNomedia(answers, "eve"), 80, "lost at +60 s: nomedia at +80 s (LOST_MS), not before");
  const at85 = answers.find((a) => a.s === 85);
  assert.ok(at85 && wantOf(at85.ans, "eve").nomedia, "...and on every poll while it lasts (Pepe rate-limits his restarts)");
  assert.ok(S.ended, "it doesn't come back");
  assert.equal(S.endWhy, "relay_lost");
  assert.ok(S.ended > t0 + 120 * 1000 && S.ended <= t0 + 125 * 1000, `START_MS after the first nomedia: +${(S.ended - t0) / 1000}s`);
  assert.deepEqual(LC.stageState("slot-eve", T), { state: "ended", why: "relay_lost" });
});

test("relay_lost: Pepe restarts on nomedia - no second nomedia until he's been live 15 s again; a stream that comes back clears it all; the admin view", async () => {
  fresh();
  await pepe({});
  await LC.stageHold(R, "fox", "slot-fox", T);
  const S = sess("fox"), t0 = S.createdAt;
  // ready +5..+55, lost from +60; nomedia at +80; Pepe restarts: "backoff" +81..+83, live again (restarts 1) from +84
  const pepeAt = (s) => (s < 2 ? {} : s <= 80 ? { fox: {} } : s <= 83 ? { fox: { state: "backoff" } } : { fox: { restarts: 1 } });
  const answers = await run(t0, 1, 104, { pepeAt, syncAt: (s) => (s >= 5 && s < 60 ? ["fox"] : []) });
  const nm = answers.filter((a) => (wantOf(a.ans, "fox") || {}).nomedia).map((a) => a.s);
  assert.equal(nm[0], 80);
  assert.ok(!nm.some((s) => s > 80 && s < 100), "after his restart: nothing until he's been live 15 s again " + JSON.stringify(nm));
  // (review F1: judged on the lists - the one at +100 s is the first with 15 s of them after his restart's "live" at +84 s)
  assert.ok(nm.includes(100), "still nothing at the server 15 s after the restart: asked again");
  const row = (await LC.adminView()).sessions.find((x) => x.login === "fox");
  assert.ok(row && row.nomedia === true && row.lost === true && row.nomedia_s === 44, "the admin view: no media for 44 s, lost " + JSON.stringify(row && { nm: row.nomedia, s: row.nomedia_s }));
  assert.ok(!S.ended);
  // the stream is back at +105 s: nothing ends, nothing asked
  const later = await run(t0, 105, 200, { pepeAt: () => ({ fox: { restarts: 2 } }), syncAt: () => ["fox"] });
  assert.ok(!S.ended, "back in time: it lives on");
  assert.equal(firstNomedia(later, "fox"), null);
  assert.equal(S.nomediaAt, 0);
  const row2 = (await LC.adminView()).sessions.find((x) => x.login === "fox");
  assert.ok(row2 && !row2.nomedia, "the admin view drops 'no media'");
});

test("the mic stage: relay_lost and start_timeout are soft failures - a 'trying again' card, another try after soft_retry_s", () => {
  for (const why of ["relay_lost", "start_timeout"]) {
    assert.ok(M.FAIL_WHYS.has(why) && M.SOFT_WHYS.has(why), why + " is a soft failure");
    const S = M.newState();
    const C = { ...M.DEFAULTS, cold_open: true, enabled: true };
    const PAD = { layout: "auto", max_people: 4, max_live: 4, default_view: "first" };
    const t = 1_000_000_000_000;
    let held = false;
    const input = () => ({ why_off: null, holders: [{ login: "a" }], unproven_n: 0, elig: new Map([["a", "ok"]]),
      sess: new Map([["a", { state: held ? "connecting" : "none", held, exact: null, viewers: 0 }]]), pad: PAD,
      room: { cams: true, listAt: null, listFresh: null }, site: { maxLive: 4, coldLeft: 9, stillsLeft: 4 } });
    // the wiring (as micfollow.js): a hold succeeds at once and its relay is connecting - "cam starting…"
    const step = (at) => { for (const a of M.step(S, input(), C, at).actions) if (a.a === "hold") { held = true; M.holdDone(S, "a", true, null, C, at); } };
    step(t); step(t + 2000); step(t + 2500);
    assert.equal((S.tiles.find((y) => y.login === "a") || {}).video, "starting", why + ": on the stage, starting");
    const r = M.sessionEnded(S, "a", why, C, t + 4000);
    assert.equal(r.cut, null);
    const x = S.tiles.find((y) => y.login === "a");
    assert.ok(x, why + ": the tile stays");
    assert.equal(x.why, "retry", why + ": 'trying again', not the 10-minute backoff");
    assert.equal(S.liveBlock.get("a"), t + 4000 + C.soft_retry_s * 1000, why + ": another try after soft_retry_s");
  }
});

test("the pages: /admin/pepe/livecams says 'no media' for such a relay; a ▶ Live viewer of a lost relay reads 'The live cam stopped.'", () => {
  const ejs = fs.readFileSync(path.join(repo, "views", "admin", "pepeLivecams.ejs"), "utf8");
  assert.match(ejs, /s\.nomedia \? ' · ⚠ no media'/, "the admin row");
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8");
  assert.match(js, /case 'unwatched': case 'gone': case 'relay_lost': return _t\('js\.pad\.live\.err_gone'/);
  // review UX-3: a new pad-livecam.js, so a new ?v= - a cached v7 would say "Pepe couldn't open their cam live" for relay_lost
  // (1.99aid privacy controls S5: v9 - a veiled cam by its opaque id; v8's relay_lost stays)
  assert.match(fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8"), /<script src="\/public\/js\/pad-livecam\.js\?v=13"><\/script>/);   // (1.99aid privacy controls V-5: v11; round 3 - F2: v12; camstutter: v13 - fast_end)
});

// ── review fixes ──
/**
 * Millisecond steps from the hold to `upto` s: MediaMTX's lists at `lists` (s; the stream in them from `readyAt` s), Pepe's
 * poll every 1 s at `off` s past each second -> `pepeAt(s)` his live map. -> {S, t0, nomedia: [s of polls asked to restart]}
 */
async function runMs(login, { lists, readyAt, off = 0, upto, pepeAt, holder = MFH }) {
  fresh();
  await pepe({});
  await LC.stageHold(R, login, holder, T, holder === MFH ? { mf: true } : undefined);
  const S = sess(login), t0 = S.createdAt;
  const listMs = new Set(lists.map((x) => Math.round(x * 1000))), offMs = Math.round(off * 1000), nomedia = [];
  for (let ms = 100; ms <= upto * 1000 && !S.ended; ms += 100) {
    T = t0 + ms;
    if (listMs.has(ms)) mtx(...(ms >= readyAt * 1000 ? [login] : []));
    if ((ms - offMs) % 1000 === 0) {
      const w = wantOf(await pepe(pepeAt(ms / 1000)), login);
      if (w && w.nomedia) nomedia.push(ms / 1000);
    } else LC.sweep(T);
  }
  return { S, t0, nomedia };
}

test("review F1: a path list taken just before MediaMTX had the stream, then its API goes quiet - judged only on what the lists saw: no nomedia for a healthy relay, a slow open isn't cut", async () => {
  // A: Pepe live at +5 s; lists at +0.5 / +5.5 (0.3 s before MediaMTX's ready at +5.8), then the API doesn't answer. Healthy.
  const a = await runMs("gil", { lists: [0.5, 5.5], readyAt: 5.8, upto: 60, pepeAt: (s) => (s >= 5 ? { gil: {} } : {}) });
  assert.deepEqual(a.nomedia, [], "no restart asked: the lists saw 0.5 s of it missing after his 'live', not 15 s");
  assert.ok(!a.S.ended, "nothing ended");
  // B: a slow open - Pepe live at +24.9 s; lists every 5 s +0.9 .. +25.9 (ready at +26.2), then the API doesn't answer
  const b = await runMs("hal", { lists: [0.9, 5.9, 10.9, 15.9, 20.9, 25.9], readyAt: 26.2, off: 0.9, upto: 60, pepeAt: (s) => (s >= 24.9 ? { hal: {} } : {}) });
  assert.deepEqual(b.nomedia, [], "no restart asked");
  assert.ok(!b.S.ended, `not ended start_timeout on lists that stopped 1 s after his 'live' (${b.S.endWhy})`);
  // control: the API answers on - the same healthy open is live, nothing asked
  const c = await runMs("gil", { lists: [0.5, 5.5, 10.5, 15.5, 20.5, 25.5, 30.5, 35.5, 40.5, 45.5, 50.5, 55.5], readyAt: 5.8, upto: 60, pepeAt: (s) => (s >= 5 ? { gil: {} } : {}) });
  assert.deepEqual(c.nomedia, []);
  assert.ok(!c.S.ended && c.S.liveAt === c.t0 + 10500, "live from the list at +10.5 s");
});

/**
 * Second by second from the hold to `upto` s: MediaMTX's list every 5 s (`ready(s)` - the stream in it), then Pepe's poll
 * (`bot(s, nomedia)` -> his entry for this relay or null; `nomedia` = the polls so far whose answer asked him to restart it).
 * -> {S, t0, nomedia}
 */
async function drive(login, { bot, ready, upto, holder = MFH }) {
  fresh();
  await pepe({});
  await LC.stageHold(R, login, holder, T, holder === MFH ? { mf: true } : undefined);
  const S = sess(login), t0 = S.createdAt, nomedia = [];
  for (let s = 1; s <= upto && !S.ended; s++) {
    T = t0 + s * 1000;
    if (s % 5 === 0) mtx(...(ready(s) ? [login] : []));
    const x = bot(s, nomedia);
    const w = wantOf(await pepe(x ? { [login]: x } : {}), login);
    if (w && w.nomedia) nomedia.push(s);
  }
  return { S, t0, nomedia };
}
/**
 * A NEW Pepe (bot 1.99ahn): live on the relay from `firstLive` s. A want[].nomedia ends that publish (at most once per 20 s, never
 * mid-restart): "live" on his next 2 polls (_end_procs), "backoff" backoffs[n] s, "starting" 2 s, then live again (restarts
 * n+1). bot.lives = the s each publish came live.
 */
function newPepe(firstLive, backoffs = [1]) {
  let r = 0, kick = null, lastKick = -1e9, liveFrom = firstLive, seen = 0;
  const lives = [firstLive];
  const bot = (s, nm) => {
    if (s < firstLive) return null;
    if (nm.length > seen) {
      const k = nm[nm.length - 1];
      seen = nm.length;
      if (kick == null && k - lastKick >= 20) { kick = k; lastKick = k; }
    }
    if (kick != null) {
      const d = s - kick, b = backoffs[Math.min(r, backoffs.length - 1)];
      if (d <= 2) return { restarts: r };
      if (d <= 2 + b) return { state: "backoff", restarts: r + 1 };
      if (d <= 4 + b) return { state: "starting", restarts: r + 1 };
      r++; kick = null; liveFrom = s; lives.push(s);
    }
    return { restarts: r };
  };
  bot.lives = lives;
  return bot;
}

test("review F2/R1: a slow first 'live' (+20 s / +25 s) on a one-sided publish - Pepe's nomedia restart comes up healthy just after START_MS: it goes live, not start_timeout", async () => {
  for (const firstLive of [3, 12, 16, 20, 25]) {
    const bot = newPepe(firstLive);
    const r = await drive("ann", { bot, ready: (s) => bot.lives.length > 1 && s >= bot.lives[1] + 1, upto: 90 });
    const at = `first live +${firstLive} s, nomedia ${JSON.stringify(r.nomedia)}, restarted live +${bot.lives[1]} s`;
    assert.ok(r.nomedia.length > 0, at + ": asked to restart the dead publish");
    assert.ok(!r.S.ended, `${at}: not cut while the restart came up (ended ${r.S.endWhy} +${(r.S.ended - r.t0) / 1000} s)`);
    assert.ok(r.S.liveAt > r.t0 + bot.lives[1] * 1000, at + ": live on MediaMTX's word, from the restarted publish");
    assert.equal(LC.stageState(MFH, T).state, "live");
  }
});

test("review F2: the restarted publish is one-sided again - start_timeout once the lists show 15 s without it after its 'live' (one restart for a relay that was never live)", async () => {
  const bot = newPepe(3);
  const r = await drive("ben", { bot, ready: () => false, upto: 90 });
  assert.deepEqual(r.nomedia, [20, 21, 22], "asked on the +20 s list, and while that publish still ran - never for the restarted one");
  assert.equal(bot.lives[1], 26, "his restart was live at +26 s");
  assert.equal(r.S.endWhy, "start_timeout");
  assert.equal(r.S.ended, r.t0 + 45 * 1000, "on the +45 s list - 15 s of lists after the restart's 'live' (+26 s)");
});

test("review F2: a restart that never comes live again (stuck in backoff) ends START_MS after Pepe went down - not at the hold's START_MS", async () => {
  const bot = newPepe(3, [1000]);
  const r = await drive("cat", { bot, ready: () => false, upto: 90 });
  assert.equal(r.nomedia[0], 20);
  assert.equal(r.S.endWhy, "start_timeout");
  assert.equal(r.S.ended, r.t0 + 64 * 1000, "down at +23 s (backoff): ended once START_MS had passed since then");
});

test("review F2: a ready relay that lost its stream - the second restart is still in its backoff at nomedia + START_MS: not relay_lost; live again once MediaMTX has it", async () => {
  // ready +5..+55, lost from +60; nomedia +80 -> restart 1 live +86 (one-sided again); nomedia +105 -> restart 2 backs off
  // 20 s (live +130), MediaMTX has it from +131
  const bot = newPepe(2, [1, 20]);
  const r = await drive("dot", { bot, ready: (s) => (s >= 5 && s < 60) || (bot.lives.length > 2 && s >= bot.lives[2] + 1), upto: 150, holder: "slot-dot" });
  assert.ok(!r.S.ended, `not cut at +125 s while the restart backed off (ended ${r.S.endWhy} +${(r.S.ended - r.t0) / 1000} s)`);
  assert.deepEqual([r.nomedia[0], r.nomedia.find((s) => s > 86)], [80, 105], "two restarts asked " + JSON.stringify(r.nomedia));
  assert.deepEqual(bot.lives, [2, 86, 130]);
  assert.ok(r.S.ready && r.S.missSince === 0 && r.S.nomediaAt === 0, "back on MediaMTX: nothing missing, nothing asked");
  assert.equal(LC.stageState("slot-dot", T).state, "live");
});

test("review F2: the caps - a publish that keeps restarting on its own never holds a never-ready relay past RESTART_CAP_MS after the nomedia, nor START_CAP_MS after the hold", async () => {
  // after the nomedia (+20 s) his publisher restarts itself every 10 s (a new restart count, never 15 s of lists after one)
  const flap = (s, nm) => (s < 3 ? null : { restarts: nm.length && s > nm[0] ? 1 + Math.floor((s - nm[0] - 1) / 10) : 0 });
  const a = await drive("eve", { bot: flap, ready: () => false, upto: 150 });
  assert.equal(a.nomedia[0], 20);
  assert.equal(a.S.endWhy, "start_timeout");
  assert.equal(a.S.ended, a.t0 + 101 * 1000, "RESTART_CAP_MS (80 s) after the nomedia");
  // he restarts himself every 10 s from the start: no nomedia is ever due, the relay is held until START_CAP_MS (120 s)
  const b = await drive("fox", { bot: (s) => (s < 3 ? null : { restarts: Math.floor((s - 3) / 10) }), ready: () => false, upto: 150 });
  assert.deepEqual(b.nomedia, []);
  assert.equal(b.S.endWhy, "start_timeout");
  assert.equal(b.S.ended, b.t0 + 121 * 1000, "START_CAP_MS after the hold");
});
