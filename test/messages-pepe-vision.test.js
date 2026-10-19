// Photos sent to Pepe in a 1:1 DM (messages.js pepeClaim / pepeMedia / pepeFlag): the claim carries opaque, bot-only
// references (never a file name or URL) and the "[sent a photo]" tag even with a caption; POST /api/messages/bot/media
// hands the bytes to the bot only while that message's job is CLAIMED (within the window, never after his answer, never
// for a message after a clear-history point, a deleted message, a block, an NSFW-marked picture or someone else's
// conversation - every condition of the gate on its own), capped in size and fetches per claim, with private headers and
// ids-only logging (the 500 path included); while a photo job is claimed its conversation's new messages are held (a
// follow-up never gets a blind answer next to the look); Pepe's check that flags a photo goes through the SITE'S
// image-safety policy for DM pictures (recorded with a blurred thumbnail only while those checks are on - never a DM
// report); the page tells members how Pepe looks at photos (his reported vision mode).
//   node --test test/messages-pepe-vision.test.js      (needs the repo's node_modules - sharp; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pepe-vision-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.DM_DIR = path.join(tmp, "dmfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));
const dmmedia = require(path.join(repo, "dmmedia"));
const isf = require(path.join(repo, "imagesafety"));

let T = Date.now();
dm._setClock(() => T);
isf._setClock(() => T);
const tick = (ms = 1000) => { T += ms; };
const RECLAIM_MS = 120e3;            // messages.js PEPE_RECLAIM_MS
const JOB_MAX_MS = 15 * 60e3;        // messages.js PEPE_JOB_MAX_MS

const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at) VALUES (?, ?, ?, 'x', ?, ?, ?, '2026-01-01 00:00:00')`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog === undefined ? name + "cf" : extra.camfrog, extra.level == null ? 5 : extra.level]);
  return (U[name] = { userId: id, username: name });
}
let base, server;
const LOGS = [];
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await inbox.ready; await follows.init(); await store.init(); await dm.init(); await isf.init();
  for (const n of ["alice", "bob", "carol", "dave", "erin", "frank", "gina", "hank", "ivy"]) await mkUser(n);
  await mkUser("boss", { class: "Admin" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('pepe-bot', 'PepeFrog', 'Pepe', 'x', 'Bot', 'pepefrog')");
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  dm.register(app, { isBotToken: (t) => t === "bot", addUser });
  inbox.register(app, { isBotToken: (t) => t === "bot", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // every log line of the run: nothing may carry a picture's file name or path
  for (const k of ["log", "error", "warn"]) {
    const orig = console[k];
    console[k] = (...a) => { LOGS.push(a.map(String).join(" ")); orig.apply(console, a); };
  }
});
test.after(() => { server && server.close(); for (const set of dm._streams.values()) for (const r of set) { try { r.end(); } catch (e) { /* */ } } });
test.beforeEach(() => { dm._gaps.clear(); tick(2000); });

async function call(method, p, user, body) {
  const h = { "X-Requested-With": "fetch" };
  if (user) h["x-test-user"] = user.userId;
  if (body) h["Content-Type"] = "application/json";
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch (e) { d = txt; }
  return { status: r.status, d };
}
const post = (p, u, body) => call("POST", p, u, body);
/** A 64x48 picture: a solid colour, or (checker: true) black and white 4 px squares - sharp detail a blur wipes out. */
async function picture(color, checker) {
  if (!checker) return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).png().toBuffer();
  const raw = Buffer.alloc(64 * 48 * 3);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) raw.fill(((x >> 2) + (y >> 2)) % 2 ? 255 : 0, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
  return sharp(raw, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();
}
async function upload(u, color = "#c83a5a", checker = false) {
  const buf = await picture(color, checker);
  const o = await post("/api/messages/uploads", u, { size: buf.length });
  assert.equal(o.status, 200, JSON.stringify(o.d));
  const r = await fetch(`${base}/api/messages/uploads/${o.d.id}?offset=0`, { method: "PUT", body: buf,
    headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", "x-test-user": u.userId } });
  assert.equal(r.status, 200);
  await post(`/api/messages/uploads/${o.d.id}/finish`, u, {});
  for (let i = 0; i < 100; i++) {
    const s = await call("GET", `/api/messages/uploads/${o.d.id}`, u);
    if (s.d.state === "ready") return o.d.id;
    if (s.d.state === "failed") throw new Error("upload failed");
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("upload never finished");
}
const toPepe = async (u, body, pics = [], nsfw = []) => { tick(1000); return post("/api/messages/send", u, { to: "PepeFrog", body, pictures: pics, nsfw }); };
const claim = (extra = {}) => post("/api/messages/pepe/claim", null, { password: "bot", ...extra });
const answer = (conversation, upto, text) => post("/api/messages/pepe/reply", null, { password: "bot", conversation, upto, text });
const media = (ref, password = "bot") => fetch(base + "/api/messages/bot/media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, ref }) });
const status = async (ref) => { const r = await media(ref); await r.arrayBuffer(); return r.status; };
const flag = (ref, verdict, password = "bot", model = "local:qwen3.6:35b") => post("/api/messages/bot/media/flag", null, { password, ref, verdict, model });
const row = async (ref) => (await getQuery("SELECT * FROM dm_media WHERE id = ?", [ref]))[0];
const mine = (c, who) => c.d.conversations.find((x) => x.user.username === who);
const scores = (s = {}) => ({ nudity_explicit: 0, sexual: 0, suggestive: 0, minor_risk: 0, gore: 0, hate_symbols: 0, ...s });

test("claim: a photo comes as an opaque reference with its tag - never a file name or URL; Pepe's vision mode reaches the header", async () => {
  const pid = await upload(U.alice);
  const s = await toPepe(U.alice, "look at my cat", [pid]);
  assert.equal(s.status, 200, JSON.stringify(s.d));
  const c = await claim({ price: 1000, vision: "local" });
  assert.equal(c.status, 200);
  const A = mine(c, "alice");
  assert.equal(A.messages.length, 1);
  assert.equal(A.messages[0].text, "look at my cat [sent a photo]", "a caption no longer hides the photo");
  assert.deepEqual(A.messages[0].photos.map((p) => [p.ref, p.nsfw]), [[pid, false]]);
  assert.match(A.messages[0].photos[0].ref, /^[a-f0-9]{24}$/);
  const r = await row(pid);
  const raw = JSON.stringify(c.d);
  assert.ok(!raw.includes(r.file) && !raw.includes(r.thumb) && !raw.includes("/messages/media/"), "no file name, no URL in the claim");
  assert.equal(A.history[A.history.length - 1].text, "look at my cat [sent a photo]");
  const h = await call("GET", `/api/messages/c/${A.conversation}?head=1`, U.alice);
  assert.equal(h.d.conversation.pepe.vision, "local", "the page learns how Pepe looks at photos");
  await claim({ vision: "telepathy" });
  assert.equal(dm.pepeNote().vision, "local", "an unknown mode is ignored");
  // a text-only message carries no photos key (the payload is unchanged for those)
  tick(1000);
  await toPepe(U.bob, "just text");
  const B = mine(await claim(), "bob");
  assert.equal(B.messages[0].photos, undefined);
  await answer(B.conversation, B.upto, "ok");
});

test("media: bot token only; the bytes with private headers; capped fetches per claim; refused once he answered", async () => {
  const conv = (await getQuery("SELECT conversation_id FROM pepe_dm_jobs WHERE user_id = 'u_alice' LIMIT 1"))[0].conversation_id;
  const ref = (await getQuery("SELECT id FROM dm_media WHERE conversation_id = ? LIMIT 1", [conv]))[0].id;
  assert.equal((await media(ref, "nope")).status, 403);
  const r = await media(ref);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const bytes = Buffer.from(await r.arrayBuffer());
  const a = await row(ref);
  assert.ok(bytes.equals(fs.readFileSync(dmmedia.filePath(a.file))), "exactly the stored (re-encoded) picture");
  assert.equal(await status(ref), 200);
  assert.equal(await status(ref), 200);
  const four = await media(ref);
  assert.equal(four.status, 429, "at most PEPE_MEDIA_FETCHES per claim");
  assert.equal((await four.json()).code, "rate");
  // junk / unknown references: the same 404
  for (const bad of ["", "../etc/passwd", a.file, "0".repeat(24), ref.toUpperCase(), { x: 1 }]) assert.equal(await status(bad), 404, JSON.stringify(bad));
  // he answers: the claim is over
  const upto = (await getQuery("SELECT MAX(message_id) AS m FROM pepe_dm_jobs WHERE user_id = 'u_alice'"))[0].m;
  assert.equal((await answer(conv, upto, "cute cat, looks like it runs the place.")).status, 200);
  const after = await media(ref);
  assert.equal(after.status, 404);
  assert.equal((await after.json()).code, "window");
});

test("the window: only a CLAIMED job, and only for PEPE_MEDIA_WINDOW_MS after the claim", async () => {
  const pid = await upload(U.carol);
  await toPepe(U.carol, "", [pid]);
  assert.equal(await status(pid), 404, "pending (not claimed yet): no bytes");
  const C = mine(await claim(), "carol");
  assert.equal(C.messages[0].text, "[sent a photo]");
  assert.equal(await status(pid), 200, "claimed: yes");
  tick(dm.PEPE_MEDIA_WINDOW_MS + 1000);
  const late = await media(pid);
  assert.equal(late.status, 404, "past the window");
  assert.equal((await late.json()).code, "window");
  // re-offered (a new claim) - the window starts again
  const again = mine(await claim(), "carol");
  assert.ok(again, "re-offered");
  assert.equal(await status(pid), 200);
  await answer(again.conversation, again.upto, "");
});

test("never after a clear-history point, a deleted message, a block, or for a conversation that isn't with Pepe", async () => {
  // clear history after the claim
  const p1 = await upload(U.dave);
  await toPepe(U.dave, "one", [p1]);
  const D = mine(await claim(), "dave");
  assert.equal(await status(p1), 200);
  await call("POST", `/api/messages/c/${D.conversation}/clear`, U.dave, {});
  assert.equal(await status(p1), 404, "cleared: gone for Pepe too");
  await answer(D.conversation, D.upto, "");
  // cleared BEFORE the claim: no reference handed out at all
  const p2 = await upload(U.dave);
  const s2 = await toPepe(U.dave, "two", [p2]);
  tick(1000);
  await runQuery("UPDATE conversation_members SET cleared_id = ? WHERE conversation_id = ? AND user_id = 'u_dave'", [s2.d.message.id, D.conversation]);
  const D2 = mine(await claim(), "dave");
  assert.equal(D2.messages[0].photos, undefined, "a photo before the member's clear point is never offered");
  assert.equal(await status(p2), 404);
  await answer(D2.conversation, D2.upto, "");
  // deleted
  const p3 = await upload(U.dave);
  const s3 = await toPepe(U.dave, "three", [p3]);
  const D3 = mine(await claim(), "dave");
  assert.ok(D3.messages[0].photos.length);
  await post(`/api/messages/m/${s3.d.message.id}/delete`, U.dave, {});
  assert.equal(await status(p3), 404, "deleted message");
  await answer(D3.conversation, D3.upto, "");
  // a block after the claim
  const p4 = await upload(U.dave);
  await toPepe(U.dave, "four", [p4]);
  const D4 = mine(await claim(), "dave");
  assert.equal(await status(p4), 200);
  await dm.setBlock(U.dave, "PepeFrog", true);
  assert.equal(await status(p4), 404, "blocked");
  tick(1000);
  await dm.setBlock(U.dave, "PepeFrog", false);
  assert.equal((await answer(D4.conversation, D4.upto, "")).status, 200);
  // a photo between two members: never Pepe's, even with a (forged) claimed job row
  const p5 = await upload(U.erin);
  const s5 = await post("/api/messages/send", U.erin, { to: "bob", body: "hi bob", pictures: [p5] });
  assert.equal(s5.status, 200);
  await runQuery("INSERT INTO pepe_dm_jobs (message_id, conversation_id, user_id, created, state, claimed_at) VALUES (?, ?, 'u_erin', ?, 'claimed', ?)",
                 [s5.d.message.id, s5.d.conversation.id, T, T]);
  assert.equal(await status(p5), 404, "not a conversation with Pepe");
  assert.equal((await flag(p5, { verdict: "refuse", scores: scores() })).status, 404);
  await runQuery("DELETE FROM pepe_dm_jobs WHERE message_id = ?", [s5.d.message.id]);
});

test("the gate, one condition at a time: each one alone refuses the bytes (404), and putting it back serves them again", async () => {
  const pid = await upload(U.frank);
  const s = await toPepe(U.frank, "gate", [pid]);
  const mid = s.d.message.id;
  const F = mine(await claim(), "frank");
  const conv = F.conversation;
  const a = await row(pid);
  const c0 = (await getQuery("SELECT * FROM conversations WHERE id = ?", [conv]))[0];
  const job0 = (await getQuery("SELECT * FROM pepe_dm_jobs WHERE message_id = ?", [mid]))[0];
  assert.equal(await status(pid), 200, "the baseline");
  const fresh = () => runQuery("UPDATE pepe_dm_jobs SET claimed_at = claimed_at + 1 WHERE message_id = ?", [mid]);   // a new fetch count
  const cases = [
    ["the member's account archived", "UPDATE users SET archived_at = ? WHERE userId = 'u_frank'", [T], "UPDATE users SET archived_at = NULL WHERE userId = 'u_frank'", []],
    ["a stale job (created more than PEPE_JOB_MAX_MS ago)", "UPDATE pepe_dm_jobs SET created = ? WHERE message_id = ?", [T - JOB_MAX_MS - 1000, mid],
     "UPDATE pepe_dm_jobs SET created = ? WHERE message_id = ?", [job0.created, mid]],
    ["the job not claimed (pending)", "UPDATE pepe_dm_jobs SET state = 'pending' WHERE message_id = ?", [mid], "UPDATE pepe_dm_jobs SET state = 'claimed' WHERE message_id = ?", [mid]],
    ["the member left the conversation", "UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND user_id = 'u_frank'", [T, conv],
     "UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ? AND user_id = 'u_frank'", [conv]],
    ["the message isn't a text message", "UPDATE messages SET kind = 'system' WHERE id = ?", [mid], "UPDATE messages SET kind = 'text' WHERE id = ?", [mid]],
    ["the picture's owner isn't the sender", "UPDATE dm_media SET owner_id = 'u_bob' WHERE id = ?", [pid], "UPDATE dm_media SET owner_id = 'u_frank' WHERE id = ?", [pid]],
    ["the picture's conversation isn't the message's", "UPDATE dm_media SET conversation_id = 'elsewhere' WHERE id = ?", [pid],
     "UPDATE dm_media SET conversation_id = ? WHERE id = ?", [a.conversation_id, pid]],
    ["the picture isn't ready", "UPDATE dm_media SET state = 'processing' WHERE id = ?", [pid], "UPDATE dm_media SET state = 'ready' WHERE id = ?", [pid]],
    ["the conversation isn't a DM", "UPDATE conversations SET kind = 'group' WHERE id = ?", [conv], "UPDATE conversations SET kind = 'dm' WHERE id = ?", [conv]],
    ["the conversation's dm_key isn't Pepe + the member", "UPDATE conversations SET dm_key = 'u_bob|u_frank' WHERE id = ?", [conv],
     "UPDATE conversations SET dm_key = ? WHERE id = ?", [c0.dm_key, conv]],
    ["Pepe isn't in the conversation", "UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND user_id = 'pepe-bot'", [T, conv],
     "UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ? AND user_id = 'pepe-bot'", [conv]],
  ];
  for (const [what, bad, badArgs, good, goodArgs] of cases) {
    await runQuery(bad, badArgs);
    assert.equal(await status(pid), 404, what);
    await runQuery(good, goodArgs);
    await fresh();
    assert.equal(await status(pid), 200, what + " - put back");
  }
  // the reference format: a dm_media row whose id isn't 24 lowercase hex is never served, even when everything else fits
  const odd = "Z".repeat(24);
  await runQuery("INSERT INTO dm_media (id, owner_id, conversation_id, message_id, state, file, thumb, w, h, bytes, nsfw, sort, created) SELECT ?, owner_id, conversation_id, message_id, state, file, thumb, w, h, bytes, nsfw, 9, created FROM dm_media WHERE id = ?",
                 [odd, pid]);
  await fresh();
  assert.equal(await status(odd), 404, "a reference that isn't a dm_media id's format");
  await runQuery("DELETE FROM dm_media WHERE id = ?", [odd]);
  await answer(conv, F.upto, "");
});

test("an NSFW-marked photo is listed as such and never handed over; the size cap", async () => {
  const p1 = await upload(U.erin);
  await toPepe(U.erin, "spicy", [p1], [p1]);
  const E = mine(await claim(), "erin");
  assert.deepEqual(E.messages[0].photos.map((p) => p.nsfw), [true]);
  const r = await media(p1);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "nsfw");
  await answer(E.conversation, E.upto, "");
  const p2 = await upload(U.erin);
  await toPepe(U.erin, "big one", [p2]);
  const E2 = mine(await claim(), "erin");
  const file = dmmedia.filePath((await row(p2)).file);
  fs.writeFileSync(file, Buffer.alloc(dm.PEPE_MEDIA_MAX_BYTES + 1, 7));
  const big = await media(p2);
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, "big");
  fs.unlinkSync(file);
  const missing = await media(p2);
  assert.equal(missing.status, 404, "a file that's gone: 404, no path anywhere");
  assert.ok(!JSON.stringify(await missing.json()).includes(path.basename(file)));
  await answer(E2.conversation, E2.upto, "");
});

test("the claim holds a conversation while its photo job is claimed: a follow-up waits for the photo answer (text-only never held)", async () => {
  const pid = await upload(U.hank);
  const s1 = await toPepe(U.hank, "look at my cat", [pid]);
  const H = mine(await claim(), "hank");
  assert.ok(H.messages[0].photos.length);
  tick(1000);
  const s2 = await toPepe(U.hank, "his name is Tom");
  assert.equal(mine(await claim(), "hank"), undefined, "held while the photo job is claimed (no blind answer next to the look)");
  assert.equal((await getQuery("SELECT state FROM pepe_dm_jobs WHERE message_id = ?", [s2.d.message.id]))[0].state, "pending", "the follow-up waits, untouched");
  assert.equal(await status(pid), 200, "the photo is still his to look at");
  // a text-only conversation is never held
  await toPepe(U.ivy, "one");
  const I1 = mine(await claim(), "ivy");
  await toPepe(U.ivy, "two");
  const I2 = mine(await claim(), "ivy");
  assert.ok(I1 && I2, "text-only: a new message is offered while the earlier one is claimed");
  await answer(I2.conversation, I2.upto, "ok");
  // the photo answer closes the photo job -> the follow-up comes next, with that answer in its history
  assert.equal((await answer(H.conversation, H.upto, "cute cat")).status, 200);
  const H2 = mine(await claim(), "hank");
  assert.deepEqual(H2.messages.map((m) => m.id), [s2.d.message.id], "only the follow-up");
  assert.equal(H2.messages[0].photos, undefined);
  assert.ok(H2.history.some((h) => h.from === "pepe" && h.text === "cute cat"), "his photo answer is in its history");
  await answer(H2.conversation, H2.upto, "hi Tom");
  // no answer in time: once the photo job is due again, everything is offered together
  const p2 = await upload(U.hank);
  const s3 = await toPepe(U.hank, "", [p2]);
  mine(await claim(), "hank");
  tick(1000);
  const s4 = await toPepe(U.hank, "hello?");
  assert.equal(mine(await claim(), "hank"), undefined, "held");
  tick(RECLAIM_MS + 1000);
  const H4 = mine(await claim(), "hank");
  assert.deepEqual(H4.messages.map((m) => m.id), [s3.d.message.id, s4.d.message.id], "the photo again, with the text, in one claim");
  assert.ok(H4.messages[0].photos.length && !H4.messages[1].photos);
  await answer(H4.conversation, H4.upto, "");
  assert.equal(s1.status, 200);
});

test("flag: never before the photo was handed over; while the site's checks are off for DMs nothing is recorded, and never a DM report", async () => {
  const pid = await upload(U.bob);
  const s = await toPepe(U.bob, "", [pid]);
  const B = mine(await claim(), "bob");
  const minor = { verdict: "nsfw", scores: scores({ sexual: 0.6, suggestive: 0.7, minor_risk: 0.8 }), reason: "test" };
  assert.equal((await flag(pid, minor, "nope")).status, 403);
  assert.equal((await flag(pid, minor)).status, 404, "not handed over yet: nothing to flag");
  assert.equal(await status(pid), 200);
  assert.equal((await flag(pid, null)).status, 400, "no classification");
  const f = await flag(pid, minor);
  assert.equal(f.status, 200, JSON.stringify(f.d));
  assert.deepEqual([f.d.recorded, f.d.off], [false, true], "the checks are off (the shipped default): nothing recorded");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM image_safety_log"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_reports WHERE message_id = ?", [s.d.message.id]))[0].n, 0, "never a DM report");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u_boss'"))[0].n, 0, "no admin notice");
  await answer(B.conversation, B.upto, "");
});

test("flag: with the checks on for DMs - the site's policy decides; a blurred thumbnail only, the notice under notify_minor, late checks count", async () => {
  await isf.setConfig({ image_safety_shadow: true }, "test");
  try {
    const pid = await upload(U.gina, "#000", true);
    const s = await toPepe(U.gina, "", [pid]);
    const G = mine(await claim(), "gina");
    assert.equal(await status(pid), 200);
    // his answer goes out before his check is done: the job is closed, the check still counts (within the window)
    await answer(G.conversation, G.upto, "");
    assert.equal(await status(pid), 404, "the bytes: no longer");
    const minor = { verdict: "nsfw", scores: scores({ sexual: 0.6, suggestive: 0.7, minor_risk: 0.8 }), reason: "a neutral reason" };
    const f = await flag(pid, minor);
    assert.equal(f.status, 200, JSON.stringify(f.d));
    assert.equal(f.d.recorded, true);
    assert.equal(f.d.minor, true);
    const r = (await getQuery("SELECT * FROM image_safety_log WHERE id = ?", [f.d.logId]))[0];
    assert.deepEqual([r.surface, r.mode, r.action, r.flagged, r.ref, r.user_id, r.model], ["dm", "pepe_dm", "flag", 1, "dm:" + pid, "u_gina", "local:qwen3.6:35b"]);
    assert.equal(r.would, "refuse", "what the DM policy says about it");
    assert.ok(r.thumb, "a thumbnail is kept");
    // blurred: the 4 px checkerboard is gone (compared with the same thumbnail made without the blur)
    const frames = await isf.imageFrames(dmmedia.filePath((await row(pid)).file));
    const clear = await sharp(frames[0]).resize(256, 256, { fit: "inside" }).webp({ quality: 70 }).toBuffer();
    const sd = async (b) => (await sharp(b).stats()).channels[0].stdev;
    const stored = fs.readFileSync(path.join(process.env.IMAGESAFETY_DIR, r.thumb));
    assert.ok(await sd(stored) < 0.35 * (await sd(clear)), `the stored thumbnail is blurred (${(await sd(stored)).toFixed(1)} vs ${(await sd(clear)).toFixed(1)})`);
    const notes = await getQuery("SELECT * FROM inbox WHERE user_id = 'u_boss' AND ref = ?", ["imagesafety:" + f.d.logId]);
    assert.equal(notes.length, 1, "the URGENT notice (notify_minor), as for the site's own checks");
    assert.match(notes[0].title, /URGENT/);
    assert.match(notes[0].body, /sent to Pepe/);
    assert.ok(!notes[0].body.includes("gina"), "the notice doesn't name the member");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_reports WHERE message_id = ?", [s.d.message.id]))[0].n, 0, "never a DM report");
    assert.equal((await flag(pid, minor)).d.already, true, "once per photo");
    assert.ok((await isf.recent({ filter: "flagged" })).some((x) => x.id === f.d.logId && x.mode === "pepe_dm" && x.thumb), "on the admins' review page");
    // a refuse verdict with a low minor_risk: flagged by the policy too, blurred too
    const p2 = await upload(U.gina, "#000", true);
    await toPepe(U.gina, "", [p2]);
    const G2 = mine(await claim(), "gina");
    assert.equal(await status(p2), 200);
    const f2 = await flag(p2, { verdict: "refuse", scores: scores({ minor_risk: 0.1 }) });
    assert.equal(f2.d.recorded, true);
    const r2 = (await getQuery("SELECT * FROM image_safety_log WHERE id = ?", [f2.d.logId]))[0];
    assert.ok(await sd(fs.readFileSync(path.join(process.env.IMAGESAFETY_DIR, r2.thumb))) < 0.35 * (await sd(clear)), "always blurred");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u_boss' AND ref = ?", ["imagesafety:" + f2.d.logId]))[0].n, 0,
                 "no URGENT notice without a minor_risk hit (the site's rule)");
    await answer(G2.conversation, G2.upto, "");
    // adult content only: the policy doesn't flag it - nothing recorded (Pepe just doesn't describe it)
    const p3 = await upload(U.gina);
    await toPepe(U.gina, "", [p3]);
    const G3 = mine(await claim(), "gina");
    assert.equal(await status(p3), 200);
    const f3 = await flag(p3, { verdict: "nsfw", scores: scores({ nudity_explicit: 0.9 }) });
    assert.deepEqual([f3.d.recorded, f3.d.allowed], [false, true]);
    assert.equal((await flag(p3, { scores: { x: 1 } })).status, 400, "an unusable classification");
    // past the window after the fetch: nothing
    tick(dm.PEPE_MEDIA_WINDOW_MS + 1000);
    assert.equal((await flag(p3, minor)).status, 404, "past the window");
    await answer(G3.conversation, G3.upto, "");
    // the enforcing master switch counts as "on" too
    await isf.setConfig({ image_safety_shadow: false, image_safety_enabled: true }, "test");
    const p4 = await upload(U.gina, "#000", true);
    await toPepe(U.gina, "", [p4]);
    const G4 = mine(await claim(), "gina");
    assert.equal(await status(p4), 200);
    assert.equal((await flag(p4, minor)).d.recorded, true);
    // the dm surface switched off: nothing
    await isf.setConfig({ image_safety_surfaces: { ...isf.DEFAULTS.surfaces, dm: false } }, "test");
    const p5 = await upload(U.gina, "#000", true);
    await toPepe(U.gina, "", [p5]);
    await answer(G4.conversation, G4.upto, "");
    const G5 = mine(await claim(), "gina");
    assert.equal(await status(p5), 200);
    assert.equal((await flag(p5, minor)).d.off, true, "the DM surface off: nothing recorded");
    await answer(G5.conversation, G5.upto, "");
  } finally {
    await isf.setConfig({ image_safety_shadow: false, image_safety_enabled: false, image_safety_surfaces: isf.DEFAULTS.surfaces }, "test");
  }
});

test("a server error on the photo route logs the ref and an error code only - never the file name or path (500)", async () => {
  const pid = await upload(U.carol);
  await toPepe(U.carol, "", [pid]);
  const C = mine(await claim(), "carol");
  const file = (await row(pid)).file;
  const orig = dmmedia.filePath;
  dmmedia.filePath = (name) => { throw Object.assign(new Error(`EACCES: permission denied, open '${path.join(process.env.DM_DIR, name)}'`), { code: "EACCES" }); };
  const before = LOGS.length;
  let r;
  try { r = await media(pid); } finally { dmmedia.filePath = orig; }
  assert.equal(r.status, 500);
  const body = await r.text();
  assert.ok(!body.includes(file) && !body.includes("EACCES: permission"), "the answer carries no path");
  const lines = LOGS.slice(before);
  assert.ok(lines.some((l) => l.includes(`[dm] pepe media ${pid}: EACCES`)), "logged: the ref and the code");
  assert.ok(!lines.some((l) => l.includes(file) || l.includes(file.replace(/\.webp$/, ""))), "never the file");
  await answer(C.conversation, C.upto, "");
});

test("logs: never a picture's file name or path; the page shows the photo notice", async () => {
  const names = (await getQuery("SELECT file, thumb FROM dm_media WHERE file IS NOT NULL")).flatMap((r) => [r.file, r.thumb]).filter(Boolean);
  assert.ok(names.length > 3);
  for (const l of LOGS) for (const n of names) assert.ok(!l.includes(n) && !l.includes(n.replace(/\.webp$/, "")), "a log line names a picture: " + l);
  const r = await fetch(base + "/messages", { headers: { "x-test-user": U.alice.userId } });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /id="dmPepePics"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8");
  assert.match(js, /function pepePicsNote\(v\)/);
  for (const k of ["js.msg.pepe_pics_local", "js.msg.pepe_pics_cloud", "js.msg.pepe_pics_off"]) assert.ok(js.includes(`'${k}'`), k);
  // the local-mode notice is honest about his later answers (the photo stays local; his reply about it is in the chat)
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["js.msg.pepe_pics_local"], /photo itself is never sent to an outside AI company/);
  assert.match(en["js.msg.pepe_pics_local"], /later answers here may come from an outside AI provider/);
  assert.ok(js.includes(en["js.msg.pepe_pics_local"]) && js.includes(en["js.msg.pepe_pics_cloud"]), "the page's fallbacks match en.json");
  dm._pepeState({ price: 0, at: T, vision: null });
  assert.equal(dm.pepeNote().vision, null, "never reported: the page says he can't look");
});
