// mic keep (handoff 16 follow-up, owner 2026-11-01: "Privacy sentence approved, make clips savable and postable"): 🎙 mic-stage
// snaps and clips may be 🔖 saved / 📌 posted when shown in the open (stage_captures.veiled = 0) and everyone they show - the cams
// drawn and the name cards - passes a per-person recheck at that moment; a durable people record (story_keep_people) follows the
// copies; everyone shown gets "Remove me" on a post (it also drops every saved copy) and a notice; copies go when someone shown
// goes private or deletes their account; the story delete right stays cam-only; the admin kill switch stagecap_mic_keep.
//   node --test test/mic-keep.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mic-keep-test-"));
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
const HIDDEN = new Set(), REFUSED = new Set();

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
  SM.configure({ hidden: (l) => HIDDEN.has(l), camRefusal: async (l) => (REFUSED.has(l) ? { code: "opted_out" } : null) });
  keep._setHiddenCheck((l) => HIDDEN.has(l));                               // the cascade's "hidden now (sure)"
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
test.beforeEach(() => { HIDDEN.clear(); REFUSED.clear(); store._gaps && store._gaps.clear(); });

test("eligibility: a mic snap shown in the open can be saved and posted, with its durable people record; veiled and pre-flag (NULL) ones can't", async () => {
  const veiled = await micCap({ veiled: 1 });
  await refused(keep.save(U.dave, veiled.mid), /Not everyone in this mic-stage capture was shown openly/);
  await refused(keep.postToPad(U.carol, veiled.mid), /shown openly/);
  const old = await micCap({ veiled: null });
  await refused(keep.save(U.dave, old.mid), /no record that everyone in it was shown openly/);
  await refused(keep.postToPad(U.carol, old.mid), /no record/);
  const failed = await micCap({ state: "failed" });
  await refused(keep.save(U.dave, failed.mid), /no record/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_keep_people WHERE capture_id IN (?, ?, ?)", [veiled.mid, old.mid, failed.mid]))[0].n, 0);
  // in the open: saved by any member, posted by the capturer
  const ok = await micCap();
  assert.deepEqual(await keep.save(U.dave, ok.mid), { saved: true, again: false });
  const created = (await getQuery("SELECT created FROM stage_captures WHERE media_id = ?", [ok.mid]))[0].created;
  assert.deepEqual((await peopleOf(ok.mid)).map((r) => [r.login, r.role, r.captured_at]), [["alicecf", "cam", created], ["bobcf", "card", created]],
                   "the cams drawn and the name cards, at the time it was taken");
  await refused(keep.postToPad(U.dave, ok.mid), /Only the person who took this capture/);
  const r = await keep.postToPad(U.carol, ok.mid);
  assert.equal(r.again, false);
  const sp = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [ok.mid]))[0];
  assert.equal(sp.stream, "mic"); assert.equal(sp.subject_login, null); assert.equal(sp.subject_user_id, null);
  const P = await store.get(r.post.id, U.dave);
  assert.match(P.title, /^🎙 Mic-stage snap in /, "no single subject in the title");
  assert.equal(P.author.userId, U.carol.userId);
  // the 24 h capture expires: its live rows die, the copies keep their own record
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [ok.mid]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_capture_people p JOIN stage_captures c ON c.id = p.capture_id WHERE c.media_id = ?", [ok.mid]))[0].n, 0);
  assert.equal((await peopleOf(ok.mid)).length, 2, "story_keep_people outlives the capture");
});

test("eligibility: the capturer keeping their activity private still refuses (the existing rule)", async () => {
  await layout.save(U.carol.userId, { hidden: ["analytics"] });
  try {
    const c = await micCap();
    await refused(keep.save(U.dave, c.mid), /keeps their activity private/);
  } finally { await layout.reset(U.carol.userId); }
});

test("per-person recheck at the moment: a cam OR a name-card person hidden, private, refusing captures, or blocked with the actor refuses - never naming them", async () => {
  const c = await micCap();
  const PERSON = /Someone shown in this mic-stage capture can't be in a saved or posted copy right now/;
  HIDDEN.add("bobcf");                                                      // the name card is hidden now
  await refused(keep.save(U.dave, c.mid), PERSON);
  HIDDEN.clear(); REFUSED.add("alicecf");                                   // the drawn cam turned captures off (!livecam off)
  await refused(keep.save(U.dave, c.mid), PERSON);
  REFUSED.clear();
  await layout.save(U.bob.userId, { hidden: ["an_rooms"] });                // the card person keeps their activity private
  try { await refused(keep.save(U.dave, c.mid), PERSON); } finally { await layout.reset(U.bob.userId); }
  // the story block rule, both ways: bob blocked dave -> dave can't keep it; carol (no block) still can
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('bob', 'dave', 1)");
  try {
    await refused(keep.save(U.dave, c.mid), PERSON);
    assert.equal((await keep.postToPad(U.plantowner, c.mid)).again, false, "the pad owner (no block with anyone in it) posts it");
    assert.equal((await keep.save(U.carol, c.mid)).saved, true);
  } finally { await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'bob' AND blocked_id = 'dave'"); }
  assert.equal(await getQuery("SELECT 1 FROM story_saves WHERE user_id = 'dave' AND capture_id = ?", [c.mid]).then((r) => r.length), 0, "nothing written for a refusal");
  // the account that had the login WHEN IT WAS TAKEN: frank had "frankold" then (erin holds it now, public) - frank going private refuses
  const fc = await micCap({ cams: ["frankold"], cards: [], created: NOW - 3 * H });
  await layout.save(U.frank.userId, { hidden: ["analytics"] });
  try { await refused(keep.save(U.dave, fc.mid), PERSON); } finally { await layout.reset(U.frank.userId); }
  assert.equal((await keep.save(U.dave, fc.mid)).saved, true, "erin's own settings were never the question");
  // posting checks the credited capturer too: alice blocked carol -> nobody can post carol's capture of her
  const c2 = await micCap();
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('alice', 'carol', 1)");
  try {
    await refused(keep.postToPad(U.carol, c2.mid), PERSON);
    await refused(keep.postToPad(U.plantowner, c2.mid), PERSON, "the pad owner (no block of their own) can't post it either: it's credited to carol");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_posts WHERE capture_id = ?", [c2.mid]))[0].n, 0, "refused before any post is made");
    assert.equal((await keep.save(U.dave, c2.mid)).saved, true, "a save is checked against the saver only");
  } finally { await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'alice'"); }
});

test("per-person recheck: any lookup error refuses (and the refusal is i18n'd)", async () => {
  const c = await micCap();
  const SR = require(path.join(repo, "storyreact")), orig = SR.loginsBlocked;
  SR.loginsBlocked = async () => { throw new Error("fixture: dm_blocks unreadable"); };
  try {
    await refused(keep.save(U.dave, c.mid), /Couldn't check everyone shown/);
    const r = await fetch(base + `/api/stories/${c.mid}/save`, { method: "POST", headers: Object.assign(HDR(U.dave), { "x-test-t": "1" }), body: "{}" });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "T:storykeep.mic.error", "answered through req.t with its locales key");
  } finally { SR.loginsBlocked = orig; }
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const [k, v] of Object.entries(keep.MIC)) assert.equal(en["storykeep.mic." + k], v, "en.json carries storykeep.mic." + k);
});

test("the kill switch: off -> no new saved / posted mic copies (and no buttons); existing copies stay, Remove me still works", async () => {
  const c = await micCap(), live = await micCap();
  const r = await keep.postToPad(U.carol, c.mid);
  await MS.setConfig({ stagecap_mic_keep: false }, "test");
  try {
    await refused(keep.save(U.dave, live.mid), /switched off/);
    await refused(keep.postToPad(U.carol, live.mid), /switched off/);
    const items = (await require(path.join(repo, "stories")).forViewer(U.carol, { room: ROOM })).flatMap((x) => x.items || []);
    assert.deepEqual(items.find((x) => x.id === live.mid).can, { post: false, save: false });
    assert.ok(!(await store.get(r.post.id, U.dave)).deleted, "the existing post stays");
    assert.equal((await store.get(r.post.id, U.alice)).capture.canRemoveMe, true);
    assert.equal((await keep.removeMe(U.alice, r.post.id)).removed, true, "Remove me keeps working");
  } finally { await MS.setConfig({ stagecap_mic_keep: true }, "test"); }
  assert.equal((await keep.save(U.dave, live.mid)).saved, true, "back on");
});

test("the story delete right stays cam-only: a name-card person can't delete the capture; their card never shows up as depicted", async () => {
  const c = await micCap();
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [c.mid]))[0];
  assert.equal(await SC.canDelete(U.alice, m), true, "the cam drawn");
  assert.equal(await SC.canDelete(U.bob, m), false, "the name card");
  await assert.rejects(SC.remove(U.bob, c.mid), (e) => e.status === 403);
  assert.ok(!(await SC.depictedOf("bob", "bobcf")).some((r) => r.media_id === c.mid));
  assert.ok((await SC.depictedOf("bob", "bobcf", Date.now(), { cards: true })).some((r) => r.media_id === c.mid), "the card rows, by the same spans");
});

test("provenance + notices: '🎙 Mic stage in <room>', no subject link; every linked account shown (cam or card, the login's holder then) is told - not the poster, not the login's later holder", async () => {
  const c = await micCap({ cams: ["alicecf", "frankold"], cards: ["bobcf", "carolcf"], created: NOW - 3 * H });
  const r = await keep.postToPad(U.carol, c.mid);
  const told = (await getQuery("SELECT user_id FROM inbox WHERE ref = ?", ["story-post:" + r.post.id])).map((x) => x.user_id).sort();
  assert.deepEqual(told, ["alice", "bob", "frank"], "frank had 'frankold' when it was taken; erin linked it later; carol posted it (and is a card in it)");
  const P = await store.get(r.post.id, U.dave);
  assert.equal(P.capture.mic, true); assert.equal(P.capture.subject, null); assert.equal(P.capture.subjectName, null);
  const page = await fetch(base + r.post.url, { headers: { "x-test-user": "alice" } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /class="fp-cap"><span aria-hidden="true">🎙<\/span><span>Mic stage in/);
  assert.match(html, /data-act="remove-me"/);
  assert.doesNotMatch(html, /fp-cap[^]*Captured from/);
  assert.ok(!(await (await fetch(base + r.post.url, { headers: { "x-test-user": "erin" } })).text()).includes('data-act="remove-me"'), "not the recycled login's later holder");
});

test("multi-subject Remove me: every person shown (cam or card, by the login spans) - one removal takes the post down AND every saved copy, the poster and author are told, idempotent, never again", async () => {
  const c = await micCap({ cams: ["alicecf", "frankold"], cards: ["bobcf"], created: NOW - 3 * H });
  await keep.save(U.dave, c.mid); await keep.save(U.plantowner, c.mid);
  const r = await keep.postToPad(U.carol, c.mid);
  const can = async (u) => (await store.get(r.post.id, u)).capture.canRemoveMe;
  assert.deepEqual([await can(U.alice), await can(U.bob), await can(U.frank), await can(U.erin), await can(U.dave), await can(U.carol)],
                   [true, true, true, false, false, false], "cam, card, the login's holder then; never its later holder, a saver or the poster");
  await refused(keep.removeMe(U.erin, r.post.id), /Only someone shown in this capture/);
  await refused(keep.removeMe(U.carol, r.post.id), /Only someone shown/);
  // a lookup error grants nothing
  const orig = SC.ownSpans;
  SC.ownSpans = async () => { throw new Error("fixture: login history unreadable"); };
  try {
    assert.equal(await can(U.bob), false);
    await refused(keep.removeMe(U.bob, r.post.id), /Only someone shown/);
  } finally { SC.ownSpans = orig; }
  // the name card removes it
  const out = await keep.removeMe(U.bob, r.post.id);
  assert.deepEqual(out, { removed: true, again: false });
  const row = await store.getRow(r.post.id);
  assert.ok(row.deleted_at); assert.equal(row.deleted_by, "subject");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 0, "every saved copy goes");
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [c.mid]))[0];
  assert.ok(k.purged_at, "the copy's files are purged"); assert.equal(k.purge_reason, "remove-me");
  assert.deepEqual(await peopleOf(c.mid), [], "no copy left: the people record goes");
  assert.deepEqual((await keep.savedFor(U.dave)).filter((x) => x.id === c.mid), []);
  const told = (await getQuery("SELECT user_id FROM inbox WHERE ref = ?", ["story-rm:" + r.post.id])).map((x) => x.user_id);
  assert.deepEqual(told, ["carol"], "the poster (= the credited capturer here)");
  assert.deepEqual(await keep.removeMe(U.bob, r.post.id), { removed: true, again: true }, "idempotent");
  await refused(keep.save(U.dave, c.mid), /removed it, so it can't be kept again/);
  // review fix: the multi-subject text exactly (the generic "removed its post" matched a looser pattern), and its locales key
  await assert.rejects(keep.postToPad(U.carol, c.mid), (e) => e.status === 409 && e.message === keep.MIC.removed && e.i18n === "storykeep.mic.removed");
  const r2 = await fetch(base + `/api/stories/${c.mid}/post`, { method: "POST", headers: Object.assign(HDR(U.carol), { "x-test-t": "1" }), body: "{}" });
  assert.equal(r2.status, 409); assert.equal((await r2.json()).error, "T:storykeep.mic.removed");
});

test("cascade: a person shown going private (profile), hidden (the hidden set, debounced) or marked private by Pepe's /api/media/anon takes every copy showing them down", async () => {
  // profile: alice hides Rooms -> the hook (profilelayout.save)
  const a = await micCap();
  await keep.save(U.dave, a.mid); const pa = await keep.postToPad(U.carol, a.mid);
  await layout.save(U.alice.userId, { hidden: ["an_rooms"] });
  try {
    const row = await store.getRow(pa.post.id);
    assert.ok(row.deleted_at); assert.equal(row.deleted_by, "capture");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [a.mid]))[0].n, 0);
    assert.deepEqual(await peopleOf(a.mid), []);
  } finally { await layout.reset(U.alice.userId); }
  // hidden: the hidden set's change listener schedules the hidden check over the durable rows
  const b = await micCap();
  await keep.save(U.dave, b.mid);
  HIDDEN.add("bobcf");
  await require(path.join(repo, "hubhidden")).hideNow(["bobcf"]);          // the set changes -> its listeners (storykeep's, from register)
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [b.mid]))[0].n, 0, "the card person went hidden");
  HIDDEN.clear();
  // Pepe marks one of HIS captures of alice private (she went !incognito): her mic-stage copies go too
  const c = await micCap();
  await keep.save(U.dave, c.mid);
  const pepeCap = "ab12ab12ab12ab12";
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, subject_login)
                  VALUES (?, 'photo', 'image/webp', 'x.webp', 1, 0, 'alicecf', 'carolcf', ?, ?, ?, 0, 0, 'alicecf')`, [pepeCap, ROOM, NOW, NOW + H]);
  const res = await fetch(base + "/api/media/anon", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bot" },
    body: JSON.stringify({ password: "bot", items: [{ id: pepeCap, subject: true }] }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 0, "her saved mic copy went with it");
});

test("the window between the recheck and the durable rows: someone who goes private meanwhile takes the new post / saved copy down", async () => {
  // review fix: going hidden is everyone's business (every copy goes); a block or cam rule of the actor's undoes only their copy (below)
  const sneak = (login) => keep._setPersistImpl(async (row) => { HIDDEN.add(login); return keep.defaultPersist(row); });
  try {
    const c = await micCap();
    sneak("bobcf");                                                         // bob goes hidden while the copy is being made
    await refused(keep.postToPad(U.carol, c.mid), /Someone shown in this mic-stage capture/);
    const sp = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [c.mid]))[0];
    assert.ok(sp && sp.post_id && sp.removed_at, "the post was made, then taken down");
    assert.ok((await store.getRow(sp.post_id)).deleted_at);
    assert.deepEqual(await peopleOf(c.mid), []);
    HIDDEN.clear();
    const d = await micCap();
    sneak("alicecf");
    await refused(keep.save(U.dave, d.mid), /Someone shown/);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [d.mid]))[0].n, 0);
    assert.ok((await getQuery("SELECT purged_at FROM story_keeps WHERE capture_id = ?", [d.mid]))[0].purged_at);
  } finally { keep._setPersistImpl(null); HIDDEN.clear(); }
});

test("cascade backstop: the hourly sweep drops copies showing someone private now, and rows of captures with no copy left; a lookup error removes nothing", async () => {
  const c = await micCap(), lone = await micCap();
  await keep.save(U.dave, c.mid);
  await keep.save(U.dave, lone.mid);
  await keep.unsave(U.dave, lone.mid);                                      // its last copy goes -> its rows go at once
  assert.deepEqual(await peopleOf(lone.mid), []);
  // a stray row (a crash between writes): the sweep drops it
  await runQuery("INSERT INTO story_keep_people (capture_id, login, role, captured_at) VALUES ('deadbeefdeadbeef', 'alicecf', 'cam', 1)");
  // bob went private without the hook (a direct write)
  await runQuery("INSERT INTO profile_layout (user_id, layout, updated) VALUES ('bob', ?, 1) ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout", [JSON.stringify({ hidden: ["analytics"] })]);
  // ... but the hidden stores are still loading: nothing is removed on an unknown answer
  keep._setHiddenCheck(() => null);
  try {
    assert.equal(await keep.sweepKept(), 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 1, "kept on an error");
    assert.deepEqual((await keep.savedFor(U.dave)).filter((x) => x.id === c.mid), [], "... though the Saved page leaves it out meanwhile");
  } finally { keep._setHiddenCheck((l) => HIDDEN.has(l)); }
  assert.equal(await keep.sweepKept(), 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_keep_people WHERE capture_id = 'deadbeefdeadbeef'"))[0].n, 0);
  await runQuery("DELETE FROM profile_layout WHERE user_id = 'bob'");
});

test("read-time checks: Saved drops a mic copy whose person went private; the story viewer's buttons follow the per-person recheck", async () => {
  const c = await micCap(), veiled = await micCap({ veiled: 1 });
  await keep.save(U.dave, c.mid);
  const items = async (u) => (await require(path.join(repo, "stories")).forViewer(u, { room: ROOM })).flatMap((x) => x.items || []);
  let it = await items(U.carol);
  assert.deepEqual(it.find((x) => x.id === c.mid).can, { post: true, save: true });
  assert.deepEqual(it.find((x) => x.id === veiled.mid).can, { post: false, save: false });
  REFUSED.add("alicecf");
  it = await items(U.carol);
  assert.deepEqual(it.find((x) => x.id === c.mid).can, { post: false, save: false }, "the button goes with the recheck");
  REFUSED.clear();
  HIDDEN.add("alicecf");
  assert.deepEqual((await keep.savedFor(U.dave)).filter((x) => x.id === c.mid), [], "gone from Saved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 0, "and deleted");
});

test("Download my data lists the copies that show you (cam or card) and the name-card references - never other people's logins; durable rows are never re-keyed", async () => {
  const c = await micCap({ cams: ["alicecf"], cards: ["bobcf"] });
  await keep.save(U.dave, c.mid);
  const pa = await keep.postToPad(U.carol, c.mid);
  const a = (await X.collect("alice")).chat;
  const mine = a.mic_stage_copies_of_you.filter((r) => r.capture === c.mid);
  assert.deepEqual(mine.map((r) => [r.login, r.role, r.saved_copy, r.post]), [["alicecf", "cam", true, pa.post.id]]);
  assert.ok(!JSON.stringify(a.mic_stage_copies_of_you).includes("bobcf") && !JSON.stringify(a.mic_stage_copies_of_you).includes("dave"), "no one else");
  const b = (await X.collect("bob")).chat;
  assert.deepEqual(b.mic_stage_copies_of_you.filter((r) => r.capture === c.mid).map((r) => r.role), ["card"]);
  assert.ok(b.mic_stage_captures_of_you_as_name_card.some((r) => r.media_id === c.mid));
  assert.ok(!b.mic_stage_captures_of_you.some((r) => r.media_id === c.mid), "a card isn't a cam reference");
  // alice changes her Camfrog login: her durable row keeps the login she had then - and stays hers by the spans
  await runQuery("UPDATE users SET camfrogUsername = 'alicenew' WHERE userId = 'alice'");
  await require(path.join(repo, "loginrekey")).changed("alice", "alicecf", "alicenew", "verify");
  try {
    assert.deepEqual((await peopleOf(c.mid)).map((r) => r.login), ["alicecf", "bobcf"], "not re-keyed");
    assert.equal((await store.get(pa.post.id, U.alice)).capture.canRemoveMe, true, "still hers");
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = 'alicecf' WHERE userId = 'alice'");
    await require(path.join(repo, "loginrekey")).changed("alice", "alicenew", "alicecf", "verify");
  }
});

// ── review fixes (these run before the last test, which deletes bob) ──
const PERSON = /Someone shown in this mic-stage capture can't be in a saved or posted copy right now/;
const savesOf = async (mid) => (await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [mid]))[0].n;
const keepOf = async (mid) => (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [mid]))[0] || null;
async function deleteAccount(id) {
  await D.schedule({ userId: id, username: id });
  const r = await D.execute(id, { force: true });
  assert.equal(r.state, "done", JSON.stringify(r));
  return r;
}

test("review: account deletion of a mic post's poster (a pad mod) leaves the post up - everyone shown keeps Remove me and the cascade; a stale removed mark never hides a live mic post", async () => {
  const mod = await mkUser("modx", "modxcf");
  const a = await micCap({ cards: ["carolcf"] }), b = await micCap({ cards: ["carolcf"] });
  keep._setModCheck((acct) => !!acct && acct.userId === "modx");
  let pa, pb;
  try { pa = await keep.postToPad(mod, a.mid); pb = await keep.postToPad(mod, b.mid); } finally { keep._setModCheck(() => false); }
  await deleteAccount("modx");
  for (const p of [pa, pb]) assert.ok(!(await store.getRow(p.post.id)).deleted_at, "carol's posts (credited to her) stay up");
  const sp = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [a.mid]))[0];
  assert.equal(sp.removed_at, null, "never marked removed while it's up");
  assert.equal(sp.posted_by, null, "the deleted account leaves the record");
  assert.equal((await store.get(pa.post.id, U.alice)).capture.canRemoveMe, true, "alice keeps Remove me");
  assert.deepEqual(await keep.removeMe(U.alice, pa.post.id), { removed: true, again: false });
  assert.ok((await store.getRow(pa.post.id)).deleted_at, "and it really comes down");
  // a stale mark (the blanket one from before the fix): judged by its feed post - Remove me, the sweep and the cascade still reach it
  const s3 = await micCap({ cards: ["carolcf"] }), p3 = await keep.postToPad(U.carol, s3.mid);
  await runQuery("UPDATE story_posts SET removed_at = 1, removed_reason = 'account deleted' WHERE capture_id IN (?, ?)", [b.mid, s3.mid]);
  assert.equal((await store.get(pb.post.id, U.alice)).capture.canRemoveMe, true);
  assert.deepEqual(await keep.removeMe(U.alice, p3.post.id), { removed: true, again: false }, "Remove me works on it");
  assert.ok((await store.getRow(p3.post.id)).deleted_at);
  await keep.sweepKept();
  assert.equal((await peopleOf(b.mid)).length, 2, "its people record stays while the post is up");
  await layout.save(U.alice.userId, { hidden: ["analytics"] });
  try { assert.ok((await store.getRow(pb.post.id)).deleted_at, "alice going private takes it down"); } finally { await layout.reset(U.alice.userId); }
});

test("review: account deletion of a mic post's author (no replies: step 2 deletes the post) takes its saved copies with it", async () => {
  const capy = await mkUser("capy", "capycf");
  const c = await micCap({ by: "capy", cards: ["carolcf"] });
  await keep.save(U.dave, c.mid);
  const pc = await keep.postToPad(capy, c.mid);
  const r = await deleteAccount("capy");
  assert.ok((await store.getRow(pc.post.id)).deleted_at);
  assert.equal(await savesOf(c.mid), 0, "dave's saved copy went with the post");
  assert.ok((await keepOf(c.mid)).purged_at);
  assert.deepEqual(await peopleOf(c.mid), []);
  assert.equal(r.report.mic_posts_deleted, 1);
});

test("review: once someone shown (cam or name card) deletes their account, the 24 h capture can't be kept; a card row written after the deletion refuses too", async () => {
  await mkUser("goner", "gonercf");
  const c = await micCap({ cams: ["alicecf"], cards: ["gonercf"] });
  await deleteAccount("goner");
  assert.equal(Number((await getQuery("SELECT veiled FROM stage_captures WHERE media_id = ?", [c.mid]))[0].veiled), 2, "marked: someone shown deleted their account");
  await refused(keep.save(U.dave, c.mid), PERSON);
  await refused(keep.postToPad(U.carol, c.mid), PERSON);
  // a capture still recording when the account went writes its card rows afterwards (veiled 0): micrec's gone marker refuses it
  const late = await micCap({ cams: ["alicecf"], cards: ["gonercf"], created: Date.now() - 60e3 });
  await refused(keep.save(U.dave, late.mid), PERSON);
  assert.deepEqual(await peopleOf(late.mid), []);
});

test("review: the block recheck reaches the account that had a login when it was taken, not only its holder now", async () => {
  const fc = await micCap({ cams: ["frankold"], cards: [], created: NOW - 3 * H });     // frank had frankold then; erin holds it now
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('frank', 'dave', 1)");
  try {
    await refused(keep.save(U.dave, fc.mid), PERSON);
    assert.equal((await keep.save(U.carol, fc.mid)).saved, true, "no block with carol");
  } finally { await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'frank' AND blocked_id = 'dave'"); }
});

test("review: an unreadable stored profile layout of the account that had a login then refuses the save, and the cascade's check says error, not ok", async () => {
  const fc = await micCap({ cams: ["frankold"], cards: [], created: NOW - 3 * H });
  await keep.save(U.carol, fc.mid);
  await runQuery("INSERT INTO profile_layout (user_id, layout, updated) VALUES ('frank', 'not json', 1) ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout");
  try {
    await refused(keep.save(U.dave, fc.mid), /Couldn't check everyone shown/);
    assert.equal((await keep.keptStates([fc.mid])).get(fc.mid), "error");
  } finally { await runQuery("DELETE FROM profile_layout WHERE user_id = 'frank'"); }
  assert.equal((await keep.keptStates([fc.mid])).get(fc.mid), "ok");
});

test("review: a recheck after the write that fails only for this actor (a block) undoes only their new copy - the existing post and other copies stay", async () => {
  const blockDuringPersist = (blocker, blocked) => keep._setPersistImpl(async (row) => {
    await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [blocker, blocked]);
    return keep.defaultPersist(row);
  });
  // the save side: the pad owner already posted it; alice blocks dave while his copy is being made
  const c = await micCap({ cards: ["carolcf"] });
  const pa = await keep.postToPad(U.plantowner, c.mid);
  blockDuringPersist("alice", "dave");
  try {
    await refused(keep.save(U.dave, c.mid), PERSON);
    keep._setPersistImpl(null);
    assert.equal(await savesOf(c.mid), 0, "dave's save is undone (and the copy nobody else saves)");
    assert.ok((await keepOf(c.mid)).purged_at);
    assert.ok(!(await store.getRow(pa.post.id)).deleted_at, "the pad owner's post stays up");
    assert.equal((await getQuery("SELECT removed_at FROM story_posts WHERE capture_id = ?", [c.mid]))[0].removed_at, null);
    assert.equal((await peopleOf(c.mid)).length, 2, "its people record stays with the post");
    assert.equal((await keep.save(U.erin, c.mid)).saved, true, "someone without a block still saves it");
  } finally { keep._setPersistImpl(null); await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'alice' AND blocked_id = 'dave'"); }
  // the post side: alice blocks the posting pad owner while the post is being made - only that post goes, and it may be posted later
  const d = await micCap({ cards: ["carolcf"] });
  await keep.save(U.erin, d.mid);
  const before = (await getQuery("SELECT MAX(rowid) AS m FROM feed_posts"))[0].m || 0;
  blockDuringPersist("alice", "plantowner");
  try {
    await refused(keep.postToPad(U.plantowner, d.mid), PERSON);
    keep._setPersistImpl(null);
    const made = await getQuery("SELECT * FROM feed_posts WHERE rowid > ?", [before]);
    assert.equal(made.length, 1); assert.ok(made[0].deleted_at, "the new post is taken down");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_posts WHERE capture_id = ?", [d.mid]))[0].n, 0, "never really posted");
    assert.equal(await savesOf(d.mid), 1, "erin's saved copy stays");
  } finally { keep._setPersistImpl(null); await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'alice' AND blocked_id = 'plantowner'"); }
  assert.equal((await keep.postToPad(U.carol, d.mid)).again, false, "posted later, once nothing stands in the way");
});

test("review: a post made but never recorded (its story_posts update failed) is taken down - never left live with no Remove me", async () => {
  const c = await micCap({ cards: ["carolcf"] });
  await runQuery(`CREATE TRIGGER fail_link_fixture BEFORE UPDATE OF post_id ON story_posts WHEN NEW.post_id IS NOT NULL AND OLD.capture_id = '${c.mid}'
                  BEGIN SELECT RAISE(ABORT, 'fixture: database busy'); END`);
  const before = (await getQuery("SELECT MAX(rowid) AS m FROM feed_posts"))[0].m || 0;
  try { await assert.rejects(keep.postToPad(U.carol, c.mid), /fixture: database busy/); } finally { await runQuery("DROP TRIGGER fail_link_fixture"); }
  const made = await getQuery("SELECT * FROM feed_posts WHERE rowid > ?", [before]);
  assert.equal(made.length, 1, "the feed post had been made");
  assert.ok(made[0].deleted_at, "... and is taken down");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_posts WHERE capture_id = ?", [c.mid]))[0].n, 0);
  assert.deepEqual(await peopleOf(c.mid), []);
  assert.equal((await keep.postToPad(U.carol, c.mid)).again, false, "it can be posted again");
});

test("review: saved copies nobody saves any more are purged with their people rows - the last saver's account deleted, a failed save, and (after a grace) anything else", async () => {
  const gina = await mkUser("gina", "ginacf");
  const c = await micCap({ cards: ["carolcf"] });
  await keep.save(gina, c.mid);
  await deleteAccount("gina");
  assert.ok((await keepOf(c.mid)).purged_at, "purged after the deletion");
  assert.deepEqual(await peopleOf(c.mid), []);
  assert.ok(!(await X.collect("alice")).chat.mic_stage_copies_of_you.some((r) => r.capture === c.mid), "Download my data stops listing it");
  // a save whose second write fails: the copy ensureKeep made goes at once
  const d = await micCap({ cards: ["carolcf"] });
  await runQuery(`CREATE TRIGGER fail_save_fixture BEFORE INSERT ON story_saves WHEN NEW.capture_id = '${d.mid}' BEGIN SELECT RAISE(ABORT, 'fixture: save failed'); END`);
  try { await assert.rejects(keep.save(U.dave, d.mid), /fixture: save failed/); } finally { await runQuery("DROP TRIGGER fail_save_fixture"); }
  assert.ok((await keepOf(d.mid)).purged_at);
  assert.deepEqual(await peopleOf(d.mid), []);
  // any other way (a row deleted directly): the sweep, once the copy is past the grace (a save may be between its two writes)
  const e = await micCap({ cards: ["carolcf"] });
  await keep.save(U.dave, e.mid);
  await runQuery("DELETE FROM story_saves WHERE capture_id = ?", [e.mid]);
  await keep.sweepKept();
  assert.equal((await keepOf(e.mid)).purged_at, null, "inside the grace: kept");
  assert.deepEqual(await peopleOf(e.mid), [], "... but a copy nobody saves isn't a copy: its people rows go now (a save in flight copies them again)");
  await runQuery("UPDATE story_keeps SET created = created - 600000 WHERE capture_id = ?", [e.mid]);
  await keep.sweepKept();
  assert.ok((await keepOf(e.mid)).purged_at);
  assert.deepEqual(await peopleOf(e.mid), []);
});

test("review: a mic post deleted by its poster takes every saved copy with it (nobody shown can open a deleted post to tap Remove me); other deletion paths: the sweep", async () => {
  const c = await micCap({ cards: ["carolcf"] });
  await keep.save(U.dave, c.mid);
  const pa = await keep.postToPad(U.carol, c.mid);
  await store.remove(U.carol, pa.post.id);
  assert.equal(await savesOf(c.mid), 0);
  assert.ok((await keepOf(c.mid)).purged_at);
  assert.deepEqual(await peopleOf(c.mid), []);
  assert.deepEqual(await keep.removeMe(U.alice, pa.post.id), { removed: true, again: true });
  // a path without the hook (any other UPDATE of feed_posts): the hourly sweep
  const d = await micCap({ cards: ["carolcf"] });
  await keep.save(U.dave, d.mid);
  const pd = await keep.postToPad(U.carol, d.mid);
  await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'system' WHERE id = ?", [Date.now(), pd.post.id]);
  await keep.sweepKept();
  assert.equal(await savesOf(d.mid), 0);
  assert.deepEqual(await peopleOf(d.mid), []);
  assert.equal((await keep.save(U.dave, d.mid)).saved, true, "the live 24 h capture may still be saved anew (no post, no Remove me - like any saved copy)");
  await keep.sweepKept();
  assert.equal(await savesOf(d.mid), 1, "... and the next sweep leaves that new copy alone (the deletion was handled)");
});

test("review: the cascade's check walks each login's history once per sweep / Saved page, not once per durable row", async () => {
  const caps = [];
  for (let i = 0; i < 4; i++) { const c = await micCap({ cams: ["frankold"], cards: [], created: NOW - 3 * H - i * 60e3 }); await keep.save(U.carol, c.mid); caps.push(c.mid); }
  const orig = SC.ownSpans, SMx = require(path.join(repo, "stagemiccap")), origL = SMx.privateLayoutStrict;
  let spans = 0, layouts = 0;
  SC.ownSpans = async (...a) => { spans++; return orig(...a); };
  SMx.privateLayoutStrict = async (...a) => { layouts++; return origL(...a); };
  try {
    const st = await keep.keptStates(caps);
    assert.deepEqual(caps.map((id) => st.get(id)), ["ok", "ok", "ok", "ok"]);
    assert.equal(spans, 2, "frankold's two candidate accounts (frank, erin) - once each, for four rows");
    assert.ok(layouts <= 2, "each account's profile once (" + layouts + ")");
  } finally { SC.ownSpans = orig; SMx.privateLayoutStrict = origL; }
});

test("review: the story viewer hides 📌 Post from a pad owner when the credited capturer fails the recheck (the post would read as theirs)", async () => {
  const c = await micCap({ cards: ["carolcf"] });
  const items = async (u) => (await require(path.join(repo, "stories")).forViewer(u, { room: ROOM })).flatMap((x) => x.items || []);
  assert.deepEqual((await items(U.plantowner)).find((x) => x.id === c.mid).can, { post: true, save: true });
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('alice', 'carol', 1)");
  try {
    assert.deepEqual((await items(U.plantowner)).find((x) => x.id === c.mid).can, { post: false, save: true }, "saving is the owner's own business; posting is carol's");
  } finally { await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'alice' AND blocked_id = 'carol'"); }
});

test("review: the copy texts - the viewer's 📌 panel knows a mic capture (mic flag), the Remove me confirm names the saved copies, Hop says '🎙 Mic stage in'", async () => {
  const c = await micCap({ cards: ["carolcf"] });
  const it = (await require(path.join(repo, "stories")).forViewer(U.carol, { room: ROOM })).flatMap((x) => x.items || []).find((x) => x.id === c.mid);
  assert.equal(it.mic, true, "the viewer gets the mic flag (its subject is the stage's label, not a person)");
  const pa = await keep.postToPad(U.carol, c.mid);
  const html = await (await fetch(base + pa.post.url, { headers: { "x-test-user": "alice" } })).text();
  assert.match(html, /data-act="remove-me" data-mic="1"/, "the mic Remove me button says so");
  const feedJs = fs.readFileSync(path.join(repo, "public", "js", "feed.js"), "utf8");
  assert.match(feedJs, /b\.getAttribute\('data-mic'\) === '1'\s*\? _t\('js\.feed\.remove_me_mic'/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["js.feed.remove_me_mic"], /every saved copy of it is deleted too/);
  // Hop: the server passes the flag, the client renders its own label
  const hopItem = require(path.join(repo, "hop")).itemOf(await store.get(pa.post.id, U.dave));
  assert.deepEqual(hopItem.capture, { room: hopItem.capture.room, mic: true });
  const hopJs = fs.readFileSync(path.join(repo, "public", "js", "hop.js"), "utf8");
  assert.match(hopJs, /it\.capture\.mic \? _t\('js\.hop\.mic_stage_in', '🎙 Mic stage in \{room\}'/);
  assert.doesNotMatch(hopJs, /'📸 Captured from ' \+/, "the camera label is i18n'd too");
});

test("account deletion: every copy showing the person goes (post hidden, saves dropped, rows gone); their name-card rows go, the 24 h capture of them as a card stays", async () => {
  const c = await micCap({ cams: ["alicecf"], cards: ["bobcf"] });
  await keep.save(U.dave, c.mid);
  const pa = await keep.postToPad(U.carol, c.mid);
  const other = await micCap({ cams: ["alicecf"], cards: [] });            // a copy that doesn't show bob stays
  await keep.save(U.dave, other.mid);
  const before = new Set((await keep.keptOf("bob")).map((x) => x.capture_id));
  assert.ok(before.has(c.mid) && !before.has(other.mid));
  await D.schedule({ userId: "bob", username: "bob" });
  const r = await D.execute("bob", { force: true });
  assert.equal(r.state, "done", JSON.stringify(r));
  assert.ok((await store.getRow(pa.post.id)).deleted_at, "the post is down");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [c.mid]))[0].n, 0);
  assert.deepEqual(await peopleOf(c.mid), []);
  assert.equal(r.report.mic_copies_removed, before.size, "every copy showing him (this test's and earlier ones')");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_capture_cards WHERE login = 'bobcf'"))[0].n, 0, "his card rows");
  assert.equal(Number((await getQuery("SELECT deleted FROM media WHERE id = ?", [c.mid]))[0].deleted), 0, "a card never had the delete right: the story capture stays");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [other.mid]))[0].n, 1, "a copy without him stays");
});
