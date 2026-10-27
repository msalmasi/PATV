// 1.99afn (FU-1, owner 2026-10-27 D-7 / D-8 / D-9 / D-10 / D-3): the mic stage's consent notice is ONE courtesy notice per Camfrog
// login, ever, across every pad - micfollow.courtesyOnce / homeCourtesy on a temp DB, without a bridge: the backfill from
// micfollow_notices (the people told before get nothing new), two pads in one tick (one PM), a failed queue (no row, retried),
// the account kinds (real: PM + silent inbox row; auto: PM only; "stage" PMs off: the inbox row only), a restart, the 300
// characters, retention (the 180-day purge never touches it; account deletion does; the export carries it) and D-3's homepage
// hook (only when the homepage mic stage exists).
//   node --test test/micfollow-courtesy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-courtesy-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));

let MF, inbox, actions;
const P = (roomId) => ({ roomId, met: null });
const R = (name) => ({ name });
const pms = async (login) => (await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify'")).map((a) => ({ by: a.user_id, to: JSON.parse(a.args)[0], text: JSON.parse(a.args)[1] }))
  .filter((a) => !login || a.to === login);
const box = async (uid) => getQuery("SELECT title, body, ref FROM inbox WHERE user_id = ? AND kind = 'stage'", [uid]);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0, email TEXT,
                  discordId TEXT, twitchId TEXT)`);
  for (const [id, name, cf, email] of [["pepe-bot", "Pepe", null, "pepe@x.y"], ["u_real", "realone", "realcf", "real@x.y"], ["u_auto", "CFab12cd34", "autocf", "randomnoat"],
                                       ["u_quiet", "quiet", "quietcf", "q@x.y"], ["u_owner", "owner", null, "o@x.y"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, email) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cf, email]);
  }
  const AA = require(path.join(repo, "autoaccount"));
  await AA.ensure();
  await runQuery("UPDATE users SET auto_source = 'camfrog' WHERE userId = 'u_auto'");
  assert.equal(await AA.isAutoAccount("u_auto"), true, "fixture: an auto account");
  inbox = require(path.join(repo, "inbox"));
  await inbox.ready;
  actions = require(path.join(repo, "actions"));
  await inbox.setPrefs("u_quiet", { stage: false });           // "stage" PMs off
  // the people pads already told (before 1.99afn): two pads told "toldtwice", one told "toldonce", one row without first_at
  await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_notices (room_id TEXT NOT NULL, login TEXT NOT NULL, first_at INTEGER, last_at INTEGER, PRIMARY KEY (room_id, login))`);
  for (const [room, login, at] of [["A", "toldtwice", 3000], ["B", "toldtwice", 1000], ["A", "toldonce", 2000], ["B", "toldnever", null]]) {
    await runQuery("INSERT INTO micfollow_notices (room_id, login, first_at, last_at) VALUES (?, ?, ?, ?)", [room, login, at, at]);
  }
  MF = require(path.join(repo, "micfollow"));
  await MF._ready();
});

test("backfill: everyone a pad told before is told (v1, the earliest time), nobody is PMed for it, and it runs again safely", async () => {
  const rows = await getQuery("SELECT login, sent_at, via, v FROM micfollow_courtesy ORDER BY login");
  assert.deepEqual(rows.map((r) => [r.login, Number(r.sent_at), r.via, r.v]), [["toldonce", 2000, "backfill", 1], ["toldtwice", 1000, "backfill", 1]]);
  assert.equal((await pms()).length, 0);
  const c = await MF.courtesyOnce(P("C"), R("Room C"), "toldtwice", Date.now());
  assert.deepEqual(c, { ok: true, sent: false, at: 1000 }, "told before -> nothing sent, the time they were told");
  assert.equal((await pms()).length, 0);
  // init again (a restart): the same rows, no duplicates
  MF._reset(); await MF._ready();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_courtesy"))[0].n, 2);
});

test("a real account: ONE PM (through Pepe, '!livecam off', the homepage) + ONE silent inbox row - and never again, on any pad, after a restart too", async () => {
  const t = Date.now();
  const c = await MF.courtesyOnce(P("Pad.A"), R("Room A"), "realcf", t);
  assert.equal(c.ok && c.sent, true);
  const pm = await pms("realcf");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].by, "pepe-bot", "no pad owner known: Pepe's own account (a house pad)");
  assert.match(pm[0].text, /!livecam off/);
  assert.match(pm[0].text, /PATV homepage to everyone if the pad is Public/, "owner D-1");
  const b = await box("u_real");
  assert.equal(b.length, 1, "one silent inbox row (rooms.notify would PM again: inbox.add never does)");
  assert.match(b[0].body, /only notice you'll get/);
  assert.equal(b[0].ref, "micfollow:courtesy:realcf");
  const row = (await getQuery("SELECT via, v, room_id FROM micfollow_courtesy WHERE login = 'realcf'"))[0];
  assert.deepEqual([row.via, row.v, row.room_id], ["pm+inbox", 2, "Pad.A"]);
  for (const pad of ["Pad.A", "Pad.B", "Pad.C"]) {
    const again = await MF.courtesyOnce(P(pad), R("x"), "realcf", t + 6 * 3600e3);
    assert.deepEqual([again.ok, again.sent], [true, false], pad);
  }
  MF._reset(); await MF._ready();                                 // a site restart (memory cleared)
  assert.equal((await MF.courtesyOnce(P("Pad.D"), R("x"), "realcf", t + 9e6)).sent, false);
  assert.equal((await pms("realcf")).length, 1);
  assert.equal((await box("u_real")).length, 1);
});

test("an auto account: the PM, no inbox row (nobody reads it); 'stage' PMs off: the inbox row only, no PM - still told (D-8)", async () => {
  await MF.courtesyOnce(P("Pad.A"), R("Room A"), "autocf", Date.now());
  assert.equal((await pms("autocf")).length, 1);
  assert.equal((await box("u_auto")).length, 0);
  assert.equal((await getQuery("SELECT via FROM micfollow_courtesy WHERE login = 'autocf'"))[0].via, "pm");
  const q = await MF.courtesyOnce(P("Pad.A"), R("Room A"), "quietcf", Date.now());
  assert.equal(q.sent, true);
  assert.equal((await pms("quietcf")).length, 0, "no PM: they switched stage PMs off");
  assert.equal((await box("u_quiet")).length, 1, "the inbox row is their notice");
  assert.equal((await getQuery("SELECT via FROM micfollow_courtesy WHERE login = 'quietcf'"))[0].via, "inbox");
  // nobody linked: the PM only
  await MF.courtesyOnce(P("Pad.A"), R("Room A"), "stranger", Date.now());
  assert.equal((await pms("stranger")).length, 1);
});

test("two pads in the same tick: one PM, one row; a failed queue leaves no row (retried later), then it goes out once", async () => {
  const t = Date.now();
  const [a, b] = await Promise.all([MF.courtesyOnce(P("Pad.A"), R("A"), "racer", t), MF.courtesyOnce(P("Pad.B"), R("B"), "racer", t)]);
  assert.equal([a, b].filter((x) => x.sent).length, 1, JSON.stringify([a, b]));
  assert.ok(a.ok && b.ok && a.at === b.at, "both know when they were told");
  assert.equal((await pms("racer")).length, 1);
  // the queue fails: nothing kept, so the next try sends it
  const real = actions.queue;
  actions.queue = async () => { throw new Error("queue down"); };
  try { await assert.rejects(MF.courtesyOnce(P("Pad.A"), R("A"), "unlucky", t), /queue down/); }
  finally { actions.queue = real; }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_courtesy WHERE login = 'unlucky'"))[0].n, 0, "the transaction rolled back");
  assert.equal((await pms("unlucky")).length, 0);
  const ok = await MF.courtesyOnce(P("Pad.A"), R("A"), "unlucky", t + 60e3);
  assert.equal(ok.sent, true);
  assert.equal((await pms("unlucky")).length, 1);
});

test("the PM fits 300 characters with 40-character names and keeps '!livecam off' (the link goes before that does)", () => {
  const T = require(path.join(repo, "i18n")).tFor("en");
  for (const key of ["mf.notice.pm_once", "mf.notice.pm_home"]) {
    for (const [room, pad, slug] of [["R".repeat(40), "P".repeat(40), "s".repeat(40)], ["Players__Lounge", "Players Lounge", "players-lounge"],
                                     ["You_Were_Never_Here", "You Were Never Here", "you-were-never-here"]]) {
      const s = MF.pmText(T, key, room, pad, 2, "https://publicaccess.tv/p/" + slug);
      assert.ok(s.length <= 300, key + " " + s.length);
      assert.match(s, /!livecam off/, key);
      if (room.length < 20) assert.match(s, /https:\/\/publicaccess\.tv\/p\//, key + ": the link fits with ordinary names");
    }
  }
});

test("retention: the 180-day purge of the pads' notices never touches the courtesy rows; account deletion removes theirs; the export carries it", async () => {
  await MF.prune(Date.now() + 400 * 864e5);
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM micfollow_courtesy"))[0].n >= 5, "still told, so never PMed again");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_notices"))[0].n, 0, "(the pads' own rows went)");
  const D = require(path.join(repo, "accountdelete"));
  assert.ok(D.DELETE_ROWS.some(([t, c, k]) => t === "micfollow_courtesy" && c === "login" && k === "login"));
  const X = fs.readFileSync(path.join(repo, "accountexport.js"), "utf8");
  assert.match(X, /mic_stage_courtesy_notice", rows\("micfollow_courtesy", "login = \?"/);
});

test("D-3: the homepage notice - nothing while the homepage mic stage doesn't exist; then ONE short PM to someone told with the old text (v1), none to someone told with the new one", async () => {
  const t = Date.now();
  assert.equal((await MF.homeCourtesy(P("Pad.A"), R("A"), "toldonce", t)).why, "home_off", "FU-2 isn't built: never sends");
  assert.equal((await pms("toldonce")).length, 0);
  MF._setHomeStage(() => true);
  try {
    const h = await MF.homeCourtesy(P("Pad.A"), R("Room A"), "toldonce", t);
    assert.deepEqual([h.ok, h.sent, h.ready], [true, true, false]);
    const pm = await pms("toldonce");
    assert.equal(pm.length, 1);
    assert.match(pm[0].text, /PATV homepage now shows mic stages too/);
    assert.match(pm[0].text, /!livecam off/);
    assert.equal((await getQuery("SELECT v FROM micfollow_courtesy WHERE login = 'toldonce'"))[0].v, 2);
    const again = await MF.homeCourtesy(P("Pad.B"), R("Room B"), "toldonce", t + 1000);
    assert.equal(again.sent, false, "never twice");
    assert.equal(again.ready, false, "a name card on the homepage for notice_lead_s after it");
    assert.equal((await MF.homeCourtesy(P("Pad.B"), R("Room B"), "toldonce", t + 121e3)).ready, true);
    assert.equal((await pms("toldonce")).length, 1);
    const v2 = await MF.homeCourtesy(P("Pad.A"), R("A"), "realcf", Date.now() + 121e3);
    assert.deepEqual([v2.sent, v2.ready], [false, true], "told with the homepage text already: nothing more");
    assert.equal((await MF.homeCourtesy(P("Pad.A"), R("A"), "nobodyyet", t)).why, "not_told", "the courtesy notice comes first");
  } finally { MF._setHomeStage(null); }
});
