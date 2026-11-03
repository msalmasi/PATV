// 1.99?? (privacy controls, review fixes 2 - Q4-A; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q4: every cam feature
// works for an incognito person's cam, incognito changes only the NAME): a 🎙 mic-stage capture in the open that drew an incognito cam
// under its frog name (stage_capture_people.veil) can be 🔖 saved and 📌 posted - its person is a "vcam" in the durable record, checked
// as a frog-name cam (still incognito, their cam rules - stagemiccap.consent {sess: null}), told in words about their frog name, given
// Remove me, never named to the poster; the cascade takes the copies down when they're LEFT OUT (bridge off), never for the incognito
// they were drawn under. The mic-keep.test.js harness (the real schema, storykeep, the feed).
//   node --test test/privm-review2-keep.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-keep-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIA_DIR = path.join(dir, "media");
process.env.FEED_DIR = path.join(dir, "feed");
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

// the real schema (snapshot + every CREATE TABLE in the code), like test/micstage-people.test.js
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT", "text_style TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const H = 3600e3, NOW = Date.now();
const ROOM = "plant_based_chatting";
const T = { frankLeft: NOW - 2 * H, erinLinked: NOW - 1.5 * H };
let runQuery, getQuery, keep, SC, SM, MS, D, X, store, layout, media, sharp, webp, base, server;
const U = {};
const users = new Map();
const HIDDEN = new Set(), REFUSED = new Set(), INCOG = new Set(), LEFT = new Set();

async function mkUser(id, cf) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified, level, created_at)
                  VALUES (?, ?, ?, ?, 'x', 'pleb', ?, 0, 1, 5, '2026-01-01 00:00:00')`, [id, id, id[0].toUpperCase() + id.slice(1), id + "@example.com", cf]);
  const u = { userId: id, username: id, class: "pleb" };
  users.set(id, u);
  return u;
}
let seq = 0;
/** A published mic-stage capture by carol: the stage capture (with its veiled flag), its drawn cams and name cards, the media row. */
async function micCap({ veiled = 0, cams = ["alicecf"], cards = ["bobcf"], created = NOW - 5 * 60e3, state = "done", by = "carol" } = {}) {
  const n = String(++seq).padStart(4, "0");
  const cid = "c" + crypto.createHash("sha1").update("cap" + n).digest("hex").slice(0, 20);
  const mid = crypto.createHash("sha1").update("media" + n).digest("hex").slice(0, 24);
  await runQuery(`INSERT INTO stage_captures (id, user_id, username, room_id, source, slot_id, stream_label, kind, ct, state, media_id, created, veiled)
                  VALUES (?, ?, ?, ?, 'mic', NULL, '🎙 the mic', 'photo', 'image/webp', ?, ?, ?, ?)`, [cid, by, by, ROOM, state, mid, created, veiled]);
  for (const l of cams) await runQuery("INSERT INTO stage_capture_people (capture_id, login) VALUES (?, ?)", [cid, l]);
  for (const l of cards) await runQuery("INSERT INTO stage_capture_cards (capture_id, login) VALUES (?, ?)", [cid, l]);
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, stream, nsfw, by_user_id, slot_id)
                  VALUES (?, 'photo', 'image/webp', ?, 10, 0, '🎙 the mic', ?, ?, ?, ?, 0, 0, 'stage', 'mic', 0, ?, NULL)`, [mid, mid + ".webp", by, ROOM, created, NOW + 24 * H, by]);
  fs.writeFileSync(path.join(media.DIR, mid + ".webp"), webp);
  return { cid, mid };
}
const peopleOf = async (mid) => (await getQuery("SELECT login, role, captured_at FROM story_keep_people WHERE capture_id = ? ORDER BY login", [mid]));
const refused = async (p, re) => assert.rejects(p, (e) => e.refuse && (!re || re.test(e.message)) || assert.fail("got " + e.message));
const HDR = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: HDR(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null; try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, text: d ? null : await r.text() };
}

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  sharp = require("sharp");
  webp = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#0a0" } }).webp().toBuffer();
  media = require(path.join(repo, "media"));
  keep = require(path.join(repo, "storykeep"));
  SC = require(path.join(repo, "stagecap"));
  SM = require(path.join(repo, "stagemiccap"));
  MS = require(path.join(repo, "mainstage"));
  D = require(path.join(repo, "accountdelete"));
  X = require(path.join(repo, "accountexport"));
  store = require(path.join(repo, "feedstore"));
  layout = require(path.join(repo, "profilelayout"));
  require(path.join(repo, "terms"))._setRequired(false);
  await media.ready;
  await D.init();
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
  await require(path.join(repo, "inbox")).ready;
  const rooms = require(path.join(repo, "rooms"));
  await rooms.init();
  for (const [id, cf] of [["plantowner", "ownercf"], ["carol", "carolcf"], ["alice", "alicecf"], ["bob", "bobcf"], ["dave", "davecf"], ["frank", "frankcf"], ["erin", "frankold"]]) U[id] = await mkUser(id, cf);
  await rooms.setOwner(ROOM, "plantowner", "test");
  // frank had "frankold" and let it go; erin linked it after him (a recycled login)
  await runQuery(`INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES
                  ('frank', 'frankold', 'frankcf', 'frankold', 'frankcf', ?, 'verify'), ('erin', NULL, 'frankold', 'u:erin', 'frankold', ?, 'verify')`, [T.frankLeft, T.erinLinked]);
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await SC.init();                                                          // stage_captures (+ veiled), the people / card tables + triggers
  SC._setDeps({ can: () => false, canManage: async () => false });
  await keep.init();
  await MS.init();
  // the engine's consent: hidden (quotes.isHidden) and the cam rules are fixtures; the strict private-profile lookup is the real one
  SM.configure({ hidden: (l) => HIDDEN.has(l), camRefusal: async (l) => (REFUSED.has(l) ? { code: "opted_out" } : null), personIncognito: (l) => INCOG.has(l) });
  keep._setHiddenCheck((l) => HIDDEN.has(l));                               // the cascade's "hidden now (sure)"
  keep._setLeftOutCheck((l) => LEFT.has(l));                                 // (review fixes 2 - Q4-A: a frog-name cam's "left out now")
  keep._setModCheck(() => false);
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.use((req, res, next) => { if (req.get("x-test-t")) req.t = (k) => "T:" + k; res.locals.ogBase = "http://test"; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "stories")).register(app, { addUser });
  keep.register(app, { addUser, noTimers: true });
  media.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

test.beforeEach(() => { HIDDEN.clear(); REFUSED.clear(); INCOG.clear(); LEFT.clear(); store._gaps && store._gaps.clear(); });

/** A published mic-stage capture in the open (veiled 0) that drew `vcams` under a FROG NAME (stage_capture_people.veil = the frog-name
 *  session, as stagecap records an engine's vpeople) besides its named cams and cards. */
async function micCapV({ cams = ["alicecf"], vcams = ["frankcf"], cards = [], by = "carol" } = {}) {
  const c = await micCap({ cams, cards, by });
  for (const l of vcams) await runQuery("INSERT INTO stage_capture_people (capture_id, login, veil) VALUES (?, ?, ?)", [c.cid, l, "s-frog-" + l]);
  return c;
}
const inboxOf = async (ref) => getQuery("SELECT user_id, body FROM inbox WHERE ref = ? ORDER BY user_id", [ref]);

test("Q4-A: a capture in the open that drew an incognito cam under its frog name can be saved and posted - its person kept as 'vcam', checked as a frog-name cam", async () => {
  INCOG.add("frankcf"); HIDDEN.add("frankcf");          // frank is incognito (quotes.isHidden says hidden: the incognito half)
  const c = await micCapV();
  await keep.save(U.dave, c.mid);                       // (before: role "cam" -> the named consent -> hidden -> refused)
  assert.deepEqual((await peopleOf(c.mid)).map((p) => [p.login, p.role]), [["alicecf", "cam"], ["frankcf", "vcam"]]);
  const r = await keep.postToPad(U.carol, c.mid);
  const told = await inboxOf("story-post:" + r.post.id);
  assert.deepEqual(told.map((x) => x.user_id), ["alice", "frank"], "everyone shown is told (their own inbox)");
  assert.match(told.find((x) => x.user_id === "frank").body, /shows your cam under your frog name/, "frank's notice is about his frog name");
  assert.doesNotMatch(told.find((x) => x.user_id === "alice").body, /frog name/);
  const P = await store.get(r.post.id, U.dave);
  assert.equal(P.capture.subject, null); assert.equal(P.capture.subjectName, null);
  assert.equal(JSON.stringify(P).includes("frankcf"), false, "the post never carries the frog-name cam's login");
  assert.equal((await store.get(r.post.id, U.frank)).capture.canRemoveMe, true, "its own person may remove it");
});

test("Q4-A: the frog-name consent - once they're no longer incognito (or their cam rules refuse the actor) it can't be kept; never naming them", async () => {
  const c = await micCapV();
  await refused(keep.save(U.dave, c.mid), /Someone shown in this mic-stage capture/);   // not incognito any more
  INCOG.add("frankcf"); REFUSED.add("frankcf");
  await refused(keep.save(U.dave, c.mid), /Someone shown/);                            // their cam rules refuse
  REFUSED.clear();
  await keep.save(U.dave, c.mid);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 1);
});

test("Q4-A: Remove me by someone shown ONLY under a frog name - the poster is told 'someone shown in it', never who", async () => {
  INCOG.add("frankcf");
  const c = await micCapV();
  const r = await keep.postToPad(U.carol, c.mid);
  assert.deepEqual(await keep.removeMe(U.frank, r.post.id), { removed: true, again: false });
  const told = await inboxOf("story-rm:" + r.post.id);
  assert.deepEqual(told.map((x) => x.user_id), ["carol"]);
  assert.match(told[0].body, /^Someone shown in it removed the post/);
  assert.doesNotMatch(told[0].body, /Frank|frank/, "never the frog's account name");
  // a named person's removal still names them (as before)
  const c2 = await micCapV({ vcams: [] });
  const r2 = await keep.postToPad(U.carol, c2.mid);
  await keep.removeMe(U.alice, r2.post.id);
  assert.match((await inboxOf("story-rm:" + r2.post.id))[0].body, /^Alice is in it and removed the post/);
});

test("Q4-A: the cascade - incognito alone never takes a frog-name cam's copies down (it was drawn under it); left out (bridge off) does", async () => {
  INCOG.add("frankcf");
  const c = await micCapV();
  await keep.save(U.dave, c.mid);
  const saves = async () => (await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n;
  HIDDEN.add("frankcf");                                // hidden in the incognito sense
  await keep.sweepHidden();
  assert.equal(await saves(), 1, "the frog-name cam stays (it was shown under its frog name)");
  assert.equal((await keep.keptStates([c.mid])).get(c.mid), "ok", "the backstop agrees");
  LEFT.add("frankcf");                                  // !bridge hide: left out
  assert.equal((await keep.keptStates([c.mid])).get(c.mid), "private");
  await keep.sweepHidden();
  assert.equal(await saves(), 0, "left out: every copy showing them goes");
  // a NAMED cam of someone who goes incognito still goes (as before)
  LEFT.clear(); HIDDEN.clear();
  const n = await micCapV({ cams: ["bobcf"], vcams: [] });
  await keep.save(U.dave, n.mid);
  HIDDEN.add("bobcf");
  await keep.sweepHidden();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [n.mid]))[0].n, 0);
});
