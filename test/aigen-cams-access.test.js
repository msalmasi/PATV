// Offline tests for gatefix site (aigen.js livePad): Generate's "📷 From a cam in this room" list (GET /api/feed/aigen/cams)
// follows the pad's access level like the live room it comes from. Before, it had no pad check at all: a signed-in
// outsider of an Approved (members-only) pad could list the login and display name of everyone on cam there.
//   * Approved pad: an outsider (never asked, a request waiting, denied, removed) gets EXACTLY the answer a pad that
//     doesn't exist gets - no logins, no display names, nothing that says the pad or its live room is there - by id,
//     slug or p/<slug>, whether or not the room is live or its cams are on
//   * its approved members, its owner, site Staff and Admins see who's on cam as before
//   * signed out: 401 at the route (unchanged); camList itself fails closed without a viewer (Public pads aside)
//   * Public and Members pads: unchanged for every signed-in viewer
//   * access changes apply at once (approve / remove / the level)
//   * claiming a snapshot (POST /api/feed/aigen/camref) takes the same check FIRST: an outsider gets exactly the answer an
//     unknown pad gets (never "this pad is for approved members", never - on staging - the 18+ card with the pad's slug)
//   * GET /api/feed/aigen?pad=: an outsider is priced like no pad at all - never that pad's own room prices
//   (the Prime Time Plus bridge gate on the cams: test/aigen-cams-bridge.test.js, through the real bridge)
//   NODE_PATH=G:/PATV/node_modules node --test test/aigen-cams-access.test.js      (temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aigen-cams-access-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const AG = require(path.join(repo, "aigen"));
const PA = require(path.join(repo, "padaccess"));
const pads = require(path.join(repo, "pads"));
require(path.join(repo, "terms"))._setRequired(false);

const BOT = "bot";
const PUB = "pubcam.Room", MEM = "memcam.Room", APP = "appcam.Room";
const TITLES = { [PUB]: "Open Cams", [MEM]: "Member Cams", [APP]: "Hidden Cams" };
// who's on cam in each pad's Camfrog room (the bridge's roster as Pepe synced it); the names must never reach an outsider
const ROSTER = () => [
  { login: "PepeFrog", display: "PepeFrog", self: true, on_cam: true },
  { login: "zz_secretcam", display: "Zed Secret", on_cam: true },
  { login: "aa_privatecam", display: "Ava Private", on_cam: true },
  { login: "lurkcf", display: "Lurker", on_cam: false },
  { anon: true, display: "someone", on_cam: true },
];
const LISTED = ["aa_privatecam", "zz_secretcam"];               // sorted by display: Ava Private, Zed Secret
const SECRETS = ["zz_secretcam", "Zed Secret", "aa_privatecam", "Ava Private", "lurkcf", "Lurker"];
const BR = new Map();
const MISSING = { ok: true, cams: [], why: "Pick a Camfrog pad - the cams come from its Camfrog room." };
const SID = "sgoodframe";

let base, server;
const U = {};
const users = new Map();
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 1000, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const slugOf = (id) => pads.padSlug(rooms.getCached(id));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.member = await mkUser("invitee", { camfrog: "inviteecf" });
  U.outsider = await mkUser("outsider", { camfrog: "outsidercf" });
  U.asker = await mkUser("asker");
  U.denied = await mkUser("deniedone");
  U.removed = await mkUser("removedone");
  U.staff = await mkUser("staffer", { class: "Staff" });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  for (const id of [PUB, MEM, APP]) {
    await rooms.addRoom(id, TITLES[id], "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await store.init();
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(PUB), "public");
  await PA.setLevel(U.owner, await rooms.get(APP), "approved");
  const R = await rooms.get(APP);
  await PA.request(U.member, R, "hi");
  await PA.decide(U.owner, R, U.member.userId, true);
  await PA.request(U.asker, R, "let me in");                    // waiting
  await PA.request(U.denied, R, "please");
  await PA.decide(U.owner, R, U.denied.userId, false);           // denied
  await PA.request(U.removed, R, "me too");
  await PA.decide(U.owner, R, U.removed.userId, true);
  await PA.remove(U.owner, R, U.removed.userId);                 // was in, removed
  for (const id of [PUB, MEM, APP]) BR.set(id, { id, slug: slugOf(id), cams: true, members: ROSTER() });
  // the bridge's snapshot handed to Generate (bridge-relay snapForGen): one good frame id, of someone on cam
  AG._setBridge((roomId) => BR.get(roomId) || null, (roomId, sid) => (sid === SID ? { login: "zz_secretcam", img: Buffer.from("frame") } : null));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  AG.register(app, { addUser, isBotToken: (t) => t === BOT, noTimers: true, audit: async () => {} });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

async function cams(pad, u) {
  const r = await fetch(base + "/api/feed/aigen/cams?pad=" + encodeURIComponent(pad), { headers: u ? { "x-test-user": u.userId } : {} });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
/** The answer a pad that isn't there gets, for this viewer (the reference an outsider's answer must equal). */
async function missingFor(u) {
  const a = await cams("no-such-pad-anywhere", u);
  assert.equal(a.status, 200);
  assert.deepEqual(a.d, MISSING, "the no-such-pad answer this test compares against");
  return a;
}
function assertListed(r, id, tag) {
  assert.equal(r.status, 200, tag + ": " + r.text);
  assert.deepEqual(r.d.cams.map((c) => c.login), LISTED, tag + ": who's on cam");
  assert.equal(r.d.room, id, tag + ": the room");
  assert.equal(r.d.slug, slugOf(id), tag + ": the slug the panel asks Pepe through");
  assert.equal(r.d.why, null, tag);
}
const OUTSIDERS = ["outsider", "asker", "denied", "removed"];
const INSIDERS = ["member", "owner", "staff", "admin"];
const VIEWERS = OUTSIDERS.concat(INSIDERS);

test("an Approved pad: every kind of outsider gets exactly the no-such-pad answer - no names, no sign the pad is there", async () => {
  const slug = slugOf(APP);
  for (const v of OUTSIDERS) {
    const ref = await missingFor(U[v]);
    for (const key of [APP, slug, "p/" + slug, slug.toUpperCase()]) {
      const r = await cams(key, U[v]);
      assert.equal(r.status, ref.status, v + " " + key + ": status");
      assert.equal(r.text, ref.text, v + " " + key + ": byte for byte the answer a missing pad gets");
      for (const s of SECRETS.concat([APP, slug, TITLES[APP]])) assert.ok(!r.text.includes(s), v + " " + key + ": never " + s);
    }
  }
});

test("an Approved pad: whether its room is live or its cams are on never shows through to an outsider", async () => {
  const B = BR.get(APP);
  const ref = await missingFor(U.outsider);
  try {
    B.cams = false;
    assert.equal((await cams(APP, U.outsider)).text, ref.text, "cams switched off: still the missing answer");
    assert.match((await cams(APP, U.member)).d.why, /aren't switched on/, "a member still sees why");
    BR.delete(APP);
    assert.equal((await cams(APP, U.outsider)).text, ref.text, "room not live: still the missing answer");
    assert.match((await cams(APP, U.member)).d.why, /isn't live/, "a member still sees why");
    BR.set(APP, Object.assign(B, { cams: true, members: [{ login: "PepeFrog", display: "PepeFrog", self: true, on_cam: true }] }));
    assert.equal((await cams(APP, U.outsider)).text, ref.text, "nobody on cam: still the missing answer");
    assert.match((await cams(APP, U.member)).d.why, /Nobody is on cam/);
  } finally {
    BR.set(APP, Object.assign(B, { cams: true, members: ROSTER() }));
  }
});

test("an Approved pad: its approved members, its owner, site Staff and Admins see who's on cam (as before)", async () => {
  const slug = slugOf(APP);
  for (const v of INSIDERS) {
    for (const key of [APP, slug, "p/" + slug]) {
      const r = await cams(key, U[v]);
      assertListed(r, APP, v + " " + key);
      assert.ok(!r.text.includes("someone") && !r.text.includes("lurkcf") && !/pepefrog/i.test(r.text), v + ": incognito, off-cam and Pepe never listed");
    }
  }
});

test("signed out: the route still asks for a sign-in; camList itself fails closed without a viewer (a Public pad's is anyone's)", async () => {
  for (const id of [PUB, MEM, APP]) {
    const r = await cams(id, null);
    assert.equal(r.status, 401, id + ": signed in only");
    for (const s of SECRETS) assert.ok(!r.text.includes(s), id + ": no names signed out");
  }
  assert.deepEqual(await AG.camList(null, APP), MISSING, "Approved, no viewer: the missing answer");
  assert.deepEqual(await AG.camList({}, APP), MISSING, "Approved, a viewer object with no account: the missing answer");
  assert.deepEqual(await AG.camList(null, MEM), MISSING, "Members, no viewer: the live room is for signed-in members (padaccess.full)");
  assert.deepEqual((await AG.camList(null, PUB)).cams.map((c) => c.login), LISTED, "Public: anyone (padaccess.full)");
});

test("Public and Members pads: unchanged - every signed-in viewer sees who's on cam", async () => {
  for (const id of [PUB, MEM]) {
    for (const v of VIEWERS) {
      assertListed(await cams(id, U[v]), id, v + " " + id);
      assertListed(await cams(slugOf(id), U[v]), id, v + " " + id + " by slug");
    }
  }
});

test("access changes apply at once: approved -> listed, removed -> missing again, the level opened -> listed", async () => {
  const R = await rooms.get(APP);
  const ref = await missingFor(U.asker);
  assert.equal((await cams(APP, U.asker)).text, ref.text, "waiting: outside");
  await PA.decide(U.owner, R, U.asker.userId, true);
  assertListed(await cams(APP, U.asker), APP, "approved just now");
  await PA.remove(U.owner, R, U.asker.userId);
  assert.equal((await cams(APP, U.asker)).text, ref.text, "removed just now: outside again");
  try {
    await PA.setLevel(U.owner, R, "members");
    assertListed(await cams(APP, U.outsider), APP, "the owner opened the pad to members");
  } finally {
    await PA.setLevel(U.owner, R, "approved");
  }
  assert.equal((await cams(APP, U.outsider)).text, (await missingFor(U.outsider)).text, "Approved again: outside");
});

const CLAIM_MISSING = { ok: false, error: "Cam snapshots come from a Camfrog pad's room." };
async function claim(pad, u, sid = SID) {
  const r = await fetch(base + "/api/feed/aigen/camref", {
    method: "POST", body: JSON.stringify({ pad, sid }),
    headers: Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}),
  });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
/** The claim answer a pad that isn't there gets, for this viewer. */
async function claimMissingFor(u) {
  const a = await claim("no-such-pad-anywhere", u);
  assert.equal(a.status, 400);
  assert.deepEqual(a.d, CLAIM_MISSING, "the no-such-pad answer this test compares against");
  return a;
}

test("claiming a snapshot: an Approved pad's outsider gets exactly the unknown pad's answer - the pad check comes first", async () => {
  const slug = slugOf(APP);
  for (const v of OUTSIDERS) {
    const ref = await claimMissingFor(U[v]);
    for (const key of [APP, slug, "p/" + slug, slug.toUpperCase()]) {
      for (const sid of [SID, "sanyoldframe"]) {
        const r = await claim(key, U[v], sid);
        assert.equal(r.status, ref.status, v + " " + key + ": status (" + r.text + ")");
        assert.equal(r.text, ref.text, v + " " + key + ": byte for byte the answer an unknown pad gets - not 'for approved members'");
        for (const s of SECRETS.concat([APP, slug, TITLES[APP], "approved"])) assert.ok(!r.text.includes(s), v + " " + key + ": never " + s);
      }
    }
  }
  assert.equal(AG._camRefs.size, 0, "nothing was claimed for an outsider");
  for (const v of INSIDERS) {
    const r = await claim(slug, U[v]);
    assert.equal(r.status, 200, v + ": " + r.text);
    assert.equal(r.d.display, "Zed Secret", v + ": the frame's person");
    assert.equal(r.d.room, APP);
  }
  for (const id of [PUB, MEM]) {
    const r = await claim(id, U.outsider);
    assert.equal(r.status, 200, id + ": Public / Members pads as before (" + r.text + ")");
  }
  AG._camRefs.clear();
});

test("GET /api/feed/aigen: an Approved pad's outsider is priced like no pad at all - never that pad's own room prices", async () => {
  await AG.setPrices({ global: { imagine: 25000, video: 100000, camsurcharge: 10000 },
                       rooms: { [APP]: { imagine: 41111, video: 151111, camsurcharge: 12121 }, [MEM]: { imagine: 30303, video: 120202, camsurcharge: 11011 } } });
  const panel = async (pad, u) => {
    const r = await fetch(base + "/api/feed/aigen?pad=" + encodeURIComponent(pad), { headers: { "x-test-user": u.userId } });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return { d: JSON.parse(text), text };
  };
  const slug = slugOf(APP);
  for (const v of OUTSIDERS) {
    const none = await panel("no-such-pad-anywhere", U[v]);
    for (const key of [APP, slug, "p/" + slug]) {
      const r = await panel(key, U[v]);
      assert.deepEqual(r.d.prices, none.d.prices, v + " " + key + ": the global prices");
      assert.equal(r.d.refPrice, none.d.refPrice, v + " " + key + ": the global -cam surcharge");
      assert.deepEqual(r.d.prices, { image: 25000, video: 100000 });
      for (const s of ["41111", "151111", "12121"]) assert.ok(!r.text.includes(s), v + " " + key + ": never the pad's own price " + s);
      assert.equal(r.d.eligible, false, v + ": can't generate for it (as before)");
    }
  }
  for (const v of INSIDERS) {
    const r = await panel(slug, U[v]);
    assert.deepEqual(r.d.prices, { image: 41111, video: 151111 }, v + ": the pad's own room prices");
    assert.equal(r.d.refPrice, 12121, v);
  }
  for (const v of VIEWERS) {
    const r = await panel(MEM, U[v]);
    assert.deepEqual(r.d.prices, { image: 30303, video: 120202 }, v + ": a Members pad's prices for anyone signed in (as before)");
    assert.equal(r.d.refPrice, 11011, v);
  }
});

// The 18+ pad gate (adultgate.js, 1.99adf) is on staging only: once this merges there, the Approved rule must still come
// first (an outsider gets the missing-pad answer, never the 18+ card) and the 18+ gate keep its own answer for members.
const HAS_GATE = fs.existsSync(path.join(repo, "adultgate.js"));
test("with the 18+ gate (staging): the Approved rule comes first - an outsider gets the missing answer, a member the gate's", { skip: !HAS_GATE && "no adultgate.js on this branch" }, async () => {
  const GATE = require(path.join(repo, "adultgate"));
  await rooms.setPage(APP, { adult: true }, "test");
  await GATE.setEnabled(true, U.admin, "test");
  try {
    for (const v of ["outsider", "asker"]) {
      const ref = await missingFor(U[v]);
      assert.equal((await cams(APP, U[v])).text, ref.text, v + " unconfirmed: the missing answer, not the 18+ card");
      await GATE.confirm(U[v], true);
      assert.equal((await cams(APP, U[v])).text, ref.text, v + " confirmed: still outside");
    }
    const r = await cams(APP, U.member);
    assert.equal(r.status, 403, "a member who hasn't confirmed: the gate's own answer");
    assert.equal(r.d.gate, "confirm");
    for (const s of SECRETS) assert.ok(!r.text.includes(s), "the gate's answer has no names: " + s);
    await GATE.confirm(U.member, true);
    assertListed(await cams(APP, U.member), APP, "a confirmed member");
    for (const v of ["owner", "staff", "admin"]) assertListed(await cams(APP, U[v]), APP, v + " (exempt from the 18+ gate)");
  } finally {
    await GATE.setEnabled(false, U.admin, "test");
    await rooms.setPage(APP, { adult: false }, "test");
  }
});

test("with the 18+ gate (staging): claiming a snapshot - an outsider gets the unknown pad's answer, never the 18+ card or the pad's slug", { skip: !HAS_GATE && "no adultgate.js on this branch" }, async () => {
  const GATE = require(path.join(repo, "adultgate"));
  const slug = slugOf(APP);
  const fresh = await mkUser("newcomer");                        // never confirmed, never asked
  const washer = await mkUser("washer");                          // approved below, never confirmed
  const R = await rooms.get(APP);
  await PA.request(washer, R, "hi");
  await PA.decide(U.owner, R, washer.userId, true);
  await rooms.setPage(APP, { adult: true }, "test");
  await GATE.setEnabled(true, U.admin, "test");
  try {
    for (const v of [fresh, U.outsider]) {
      const ref = await claimMissingFor(v);
      for (const key of [APP, slug]) {
        const r = await claim(key, v);
        assert.equal(r.text, ref.text, v.username + " " + key + ": the unknown pad's answer, not the 18+ card / 'for approved members'");
        assert.ok(!r.text.includes(slug) && !r.text.includes("18") && !r.text.includes("confirm"), v.username + ": nothing of the pad");
      }
    }
    const m = await claim(APP, washer);
    assert.equal(m.status, 403, "a member who hasn't confirmed: the gate's own answer");
    assert.equal(m.d.gate, "confirm");
    await GATE.confirm(washer, true);
    assert.equal((await claim(APP, washer)).status, 200, "confirmed: claimed");
  } finally {
    AG._camRefs.clear();
    await PA.remove(U.owner, R, washer.userId);
    await GATE.setEnabled(false, U.admin, "test");
    await rooms.setPage(APP, { adult: false }, "test");
  }
});

test("other pads behave as before: a site-only pad and an unknown one answer as they did", async () => {
  await rooms.addRoom("patv:camless", "No Camfrog", "test");
  for (const v of ["outsider", "member"]) {
    assert.deepEqual((await cams("patv:camless", U[v])).d, MISSING, v + ": a site-only pad has no cams");
    assert.deepEqual((await cams("", U[v])).d, MISSING, v + ": no pad picked");
  }
});
