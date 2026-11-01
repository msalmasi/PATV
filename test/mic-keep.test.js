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
  await assert.rejects(keep.postToPad(U.carol, c.mid), (e) => e.status === 409 && /removed it/.test(e.message));
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
  const sneak = (login) => keep._setPersistImpl(async (row) => { REFUSED.add(login); return keep.defaultPersist(row); });
  try {
    const c = await micCap();
    sneak("bobcf");                                                         // bob turns captures off while the copy is being made
    await refused(keep.postToPad(U.carol, c.mid), /Someone shown in this mic-stage capture/);
    const sp = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [c.mid]))[0];
    assert.ok(sp && sp.post_id && sp.removed_at, "the post was made, then taken down");
    assert.ok((await store.getRow(sp.post_id)).deleted_at);
    assert.deepEqual(await peopleOf(c.mid), []);
    REFUSED.clear();
    const d = await micCap();
    sneak("alicecf");
    await refused(keep.save(U.dave, d.mid), /Someone shown/);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [d.mid]))[0].n, 0);
    assert.ok((await getQuery("SELECT purged_at FROM story_keeps WHERE capture_id = ?", [d.mid]))[0].purged_at);
  } finally { keep._setPersistImpl(null); REFUSED.clear(); }
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
