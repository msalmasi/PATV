// Offline tests for 1.99up: three more pad-owner controls (padowner.js, padsite.js, textguard.js, pepefeed / feedautomod / golive):
//   * the room topic: POST /api/rooms/:slug/owner/topic -> website action "room.topic"; owner only; length, the text guard,
//     never a pad verify code (any disguise); 6 an hour (staff exempt); audited (room_events "pepe-topic")
//   * the auto-topic + the room's speech-to-text language as owner settings ("room.owner"): the admins' floor, Pepe's lists
//   * Pepe's report carries topic / stt / the admin bounds; the page shows the topic group and the transcription select
//   * "Pepe on your pad's page" (padsite.js): defaults inherited ("own" false), an override, reset to default, owner only,
//     the pad settings tab's own changes count as overrides, rate limit, audit; the safety floor (severe at least hidden)
//     can't be relaxed; posts / comments / kinds split reaches the gate, the post route and Pepe's sync
//   NODE_PATH=G:/PATV/node_modules node --test test/padowner-topic-site.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padowner-ts-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PO = require(path.join(repo, "padowner"));
const PS = require(path.join(repo, "padsite"));
const PF = require(path.join(repo, "pepefeed"));
const AM = require(path.join(repo, "feedautomod"));
const GL = require(path.join(repo, "golive"));
const TG = require(path.join(repo, "textguard"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const PLANT = "plant_based_chatting";
let base, server, owner, fan, staff, SLUG;
let n = 0;
async function mkUser(extra = {}) {
  const id = "v" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?)`, [id, name, name, 1000000, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111" });
  fan = await mkUser({ username: "fan", camfrog: "fanguy" });
  staff = await mkUser({ username: "boss", cls: "Admin", camfrog: "bossy" });
  await rooms.init();
  await rooms.setOwner(PLANT, "foamy1111", "test");
  SLUG = (await rooms.get(PLANT)).slug || PLANT;
  require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 200));
  await PO.init();
  await PF.init();
  await AM.init();
  await GL.init();
  await PS.init();
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const users = { owner, fan, staff };
  const addUser = (req, res, next) => { req.user = users[req.get("x-test-user")] || null; next(); };
  const isBotToken = (t) => t === "bot-token";
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const page = (p, u) => fetch(base + p, { headers: u ? { "x-test-user": u } : {}, redirect: "manual" }).then(async (r) => ({ status: r.status, text: await r.text() }));
const actions = () => getQuery("SELECT * FROM pepe_actions ORDER BY id");

test("textguard: pad codes in any disguise, the guard list", () => {
  for (const s of ["PATV-AB23CD", "patv-ab23cd", "PATV AB23CD", "PATV_AB23CD", "ＰＡＴＶ-AB23CD", "PA\u200bTV-AB23CD", "x patv.ab23cd y"]) {
    assert.ok(TG.hasPadCode(s), s);
  }
  assert.ok(!TG.hasPadCode("PATV is great") && !TG.hasPadCode("Friday karaoke"));
  assert.ok(TG.bad("call 555-123-4567") && TG.bad("kys") && !TG.bad("karaoke night"));
});

test("the room topic -> one room.topic action; owner only; checked; 6 an hour; audited", async () => {
  PO._reset();
  await runQuery("DELETE FROM pepe_actions");
  let r = await post(`/api/rooms/${SLUG}/owner/topic`, "owner", { text: "  /Karaoke night -\n bring a song " });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const a = (await actions()).pop();
  assert.equal(a.kind, "room.topic");
  assert.deepEqual(JSON.parse(a.args), [PLANT, "Karaoke night - bring a song"], "one line, no leading slash");
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'pepe-topic'", [PLANT]);
  assert.ok(ev.length >= 1, "audited");
  r = await post(`/api/rooms/${SLUG}/owner/topic`, "fan", { text: "hijacked" });
  assert.equal(r.status, 403);
  for (const bad of ["PATV-AB23CD", "connect: ＰＡＴＶ-AB23CD", "x", "y".repeat(201), "my number 555-123-4567"]) {
    r = await post(`/api/rooms/${SLUG}/owner/topic`, "owner", { text: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await actions()).length, 1, "nothing junk was queued");
  for (let i = 0; i < 5; i++) {
    r = await post(`/api/rooms/${SLUG}/owner/topic`, "owner", { text: "topic number " + i });
    assert.equal(r.status, 200);
    await runQuery("UPDATE pepe_actions SET status = 'done'");
  }
  r = await post(`/api/rooms/${SLUG}/owner/topic`, "owner", { text: "one too many" });
  assert.equal(r.status, 429, "the 7th in an hour");
  r = await post(`/api/rooms/${SLUG}/owner/topic`, "staff", { text: "staff topic" });
  assert.equal(r.status, 200, "staff aren't limited");
});

test("the auto-topic + the transcription language: owner settings inside Pepe's lists and the admins' floor", async () => {
  PO._reset();
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  const report = { [PLANT]: { owner: { snap: true, autotopic: false, autotopic_every: "default", stt_language: "default", language: "auto" },
    admin: { autotopic_master: true, autotopic_min: 45 },
    topic: { text: "the current topic <b>", paused_until: Date.now() + 3600e3, auto: false, auto_own: false, running: false, every_effective: 45 },
    stt: { global: "auto", effective: "auto", own: false } } };
  const choices = { vibe: ["auto", "chill"], roasts: ["auto"], autotopic_every: [15, 20, 30, 45, 60, 90, 120, 180], stt: [["cy", "Welsh"], ["de", "German"], ["<x>", "bad"]] };
  let r = await post("/api/rooms/owners", null, { password: "bot-token", room_settings: report, room_choices: choices });
  assert.equal(r.status, 200);
  const s = await PO.settingsFor(PLANT);
  assert.equal(s.owner.autotopic_every, "default");
  assert.equal(s.owner.stt_language, "default");
  assert.equal(s.admin.autotopic_min, 45);
  assert.equal(s.topic.text, "the current topic <b>");
  assert.deepEqual(s.stt, { global: "auto", effective: "auto", own: false });
  assert.deepEqual(PO.choices().stt, [["cy", "Welsh"], ["de", "German"]], "junk dropped");
  for (const [k, v] of [["autotopic", "on"], ["autotopic_every", "60"], ["autotopic_every", "default"], ["stt_language", "cy"], ["stt_language", "auto"], ["stt_language", "default"]]) {
    r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: k, value: v });
    assert.equal(r.status, 200, k + " " + JSON.stringify(r.d));
    await runQuery("UPDATE pepe_actions SET status = 'done'");
    assert.deepEqual(JSON.parse((await actions()).pop().args), [PLANT, k, v]);
  }
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: "autotopic_every", value: "30" });
  assert.equal(r.status, 400, "under the admins' floor (45)");
  assert.match(r.d.error, /45/);
  for (const [k, v] of [["autotopic_every", "7"], ["stt_language", "fr"], ["stt_language", "x1"], ["autotopic", "maybe"]]) {
    r = await post(`/api/rooms/${SLUG}/owner/setting`, "owner", { key: k, value: v });
    assert.equal(r.status, 400, k + "=" + v);
  }
  r = await post(`/api/rooms/${SLUG}/owner/setting`, "fan", { key: "autotopic", value: "on" });
  assert.equal(r.status, 403);
  // the page: the topic group, the topic as Pepe saw it (escaped), the floor, the transcription select
  const pg = await page("/p/" + SLUG + "/owner", "owner");
  assert.equal(pg.status, 200, pg.text.slice(0, 300));
  for (const want of ['id="topic"', 'id="poTopic"', 'data-po-set="autotopic"', 'data-po-set="autotopic_every"', 'data-po-set="stt_language"',
                      '<option value="cy" >Welsh</option>', "the current topic &lt;b&gt;"]) {
    assert.ok(pg.text.includes(want), want);
  }
  assert.ok(!/<option value="30"/.test(pg.text.split('data-po-set="autotopic_every"')[1].split("</select>")[0]), "no choice under the floor");
  assert.ok(!/owner\.[a-z_]+\.?[a-z_-]*</.test(pg.text.replace(/<script[\s\S]*?<\/script>/g, "")), "no raw i18n keys");
});

test("Pepe on your pad's page: defaults inherited, override, reset, owner only, audit", async () => {
  PS._reset();
  let st = await PS.state(PLANT);
  for (const [k, it] of Object.entries(st.values)) assert.equal(it.own, false, k + " follows the default");
  assert.equal(st.values.replies.value, true);
  assert.equal(st.values.posts.value, false);
  assert.equal(st.values.post_kinds.value, null, "every kind");
  assert.equal(st.values.announce.value, true);
  assert.equal(st.values.automod_level.value, "standard");
  let r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "posts", value: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.site.values.posts.value, true);
  assert.equal(r.d.site.values.posts.own, true);
  assert.equal(r.d.site.values.comments.value, false, "comments stay separate");
  let S = await PF.scopeSettings(PLANT);
  assert.equal(PF.postsOn(S), true);
  assert.equal(PF.commentsOn(S), false);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "post_kinds", value: ["recap", "dj", "nonsense"] });
  assert.deepEqual(r.d.site.values.post_kinds.value, ["recap", "dj"]);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "comment_rate", value: "high" });
  S = await PF.scopeSettings(PLANT);
  assert.equal(S.comments_per_day, 25);
  assert.equal(S.gap_min, 15);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "announce", value: false });
  assert.equal(await GL.padAnnounce(PLANT), false);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "announce", reset: true });
  assert.equal(await GL.padAnnounce(PLANT), true);
  assert.equal(r.d.site.values.announce.own, false, "back to the default");
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "posts", reset: true });
  assert.equal(r.d.site.values.posts.value, false);
  assert.equal(r.d.site.values.posts.own, false);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "replies", value: false });
  assert.equal((await PF.scopeSettings(PLANT)).respond, false);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "replies", reset: true });
  assert.equal((await PF.scopeSettings(PLANT)).respond, true);
  assert.equal(r.d.site.values.replies.own, false);
  // bad values / not the owner / unknown keys
  for (const body of [{ key: "posts", value: "maybe" }, { key: "posts_per_day", value: 99 }, { key: "comment_rate", value: "insane" }, { key: "image_safety", value: false },
                      { key: "automod_level", value: "off" }]) {
    r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  r = await post(`/api/rooms/${SLUG}/owner/site`, "fan", { key: "posts", value: true });
  assert.equal(r.status, 403);
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'pepe-site'", [PLANT]);
  assert.ok(ev.length >= 6, "every change and reset audited");
  // the pad settings' Pepe tab writes the same store: a value off the default counts as overridden
  await PF.setScope(owner, PLANT, { comments_per_day: 7 });
  st = await PS.state(PLANT);
  assert.equal(st.values.comment_rate.value, "custom");
  assert.equal(st.values.comment_rate.own, true);
  // the page shows the card
  const pg = await page("/p/" + SLUG + "/owner", "owner");
  for (const want of ['id="site"', 'data-ps-set="posts"', 'data-ps-kind="recap"', 'data-ps-reset="comment_rate"', en["owner.site_floor_takedown"]]) {
    assert.ok(pg.text.includes(want), want);
  }
});

test("the safety floor: severe verdicts are always at least hidden; owners can't relax it", async () => {
  PS._reset();
  let r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "automod", value: true });
  assert.equal(r.status, 200);
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "automod_level", value: "relaxed" });
  assert.equal(r.d.site.values.automod_level.value, "relaxed");
  // through the pad settings tab's own route too: severe "none" is lifted to the floor
  const A = await AM.setScope(owner, PLANT, { severe: "none", minor: "none" });
  assert.equal(A.severe, "hide");
  assert.equal(A.minor, "none", "above the floor the owner chooses");
  const d = AM.decide({ action: "remove", rule: "doxxing", severity: "severe", reason: "address" }, { minor: "none", serious: "none", severe: "none" },
                     [{ id: "doxxing", title: "Doxxing", severity: "severe" }]);
  assert.equal(d.action, "hide", "decide applies the floor even to a stored older value");
  // no padsite key reaches the site's own protections
  for (const k of ["image_safety", "takedown", "csam", "reports", "admin_lock"]) assert.equal(PS.SPEC[k], undefined, k);
  // a site admin's lock holds
  await AM.setScope(staff, PLANT, { admin_lock: true });
  r = await post(`/api/rooms/${SLUG}/owner/site`, "owner", { key: "automod", value: false });
  assert.equal(r.status, 403);
  await AM.setScope(staff, PLANT, { admin_lock: false });
});

test("posts / comments / kinds reach the gate, the post route and Pepe's sync", async () => {
  const G = PF.cleanGlobal({});
  const U = { posts: 0, comments: 0, cost: 0, last: 0, byScope: {} };
  const S1 = PF.cleanScope({ auto: false, posts: true });
  assert.equal(PF.gate("post", "auto", S1, G, U, { scope: "x" }), null);
  assert.match(PF.gate("comment", "auto", S1, G, U, { scope: "x" }), /auto comments are off/);
  const S2 = PF.cleanScope({ auto: true, posts: false });
  assert.match(PF.gate("post", "auto", S2, G, U, { scope: "x" }), /auto posting is off/);
  assert.equal(PF.gate("comment", "auto", S2, G, U, { scope: "x" }), null, "unset comments follow auto");
  // the post route refuses a kind the pad keeps out
  PS._reset();
  await PS.set(owner, PLANT, "posts", true);
  await PS.set(owner, PLANT, "post_kinds", ["recap"]);
  await assert.rejects(PF.post({ scope: PLANT, title: "A question", body: "x", kind: "question", cost: 0 }), /kind are off/);
  // 1.99wq: a news post is routed (pepetopics.js) - with no pad taking news it goes nowhere
  await assert.rejects(PF.post({ scope: PLANT, title: "Some news", body: "x", kind: "news", cost: 0 }), /kind are off|no pad takes/);
  const sync = await PF.sync({});
  const e = sync.scopes[PLANT];
  assert.ok(e, "the pad is in Pepe's sync");
  assert.equal(e.posts, true);
  assert.deepEqual(e.kinds, ["recap"]);
  assert.equal(e.auto, true, "an older bot reads auto = posts or comments");
});
