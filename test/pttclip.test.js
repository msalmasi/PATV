// pttclip (1.99??): a push-to-talk web clip's limit is charged only for a clip that PLAYED.
// The owner, 2026-11-07: "push-to-talk web clips still charge their limit when the clip is uploaded, even if Pepe then can't get
// the mic - fix this too." bridge-relay's POST /api/rooms/:slug/clip took limited("clip|<account>", 30 s, 3 per 10 min) at the
// UPLOAD and never gave it back: a clip Pepe couldn't get the mic for (taken / full / busy / the room's mic break / a block / he
// left), whose audio failed, that he refused or that never came back still cost the sender a third of their 10 minutes and a
// 30 s wait. Now (the mirror of Pepe's pepe_relay CLIP_LIMIT / CLIP_TRY_LIMIT):
//   * the play limit is taken at the upload (three clips sent at once can't all wait for the mic) and given back EXACTLY once
//     however the clip ends without playing: Pepe's final not-ok answer (any), a job swept while still open (never answered)
//   * a clip that played keeps it
//   * the flood guard: 12 uploads per account per 10 min, played or not - never given back; a 429 from the play limit costs none
//   * the clip line shows Pepe's own words for a coded mic miss (no_mic / mic_later / audio_failed) - "no cooldown - try again"
// review (pttclip, 2026-11-07):
//   * an open clip job is timed from Pepe's CLAIM (he gives up 7 min after it reached him, ahead of the site), not the upload - a
//     clip that waited behind others is never swept (given back) while Pepe may still play it; one he said is playing gets 2 more
//     minutes; when the site does give up it fails the job "unconfirmed" and says it didn't count (the line no longer vanishes)
//   * a clip Pepe never takes (not pulling / not in the room) fails "nopepe" after 75 s - given back, said so
//   * a recording that is the upload's own fault (Pepe's code bad_clip: unreadable / too short / too long) keeps its charge
//   * a translated page shows a translated line per code (en.json js.pad.ptt.s_*), Pepe's own words on English pages
//   node --test test/pttclip.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pttclip-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));

const R = { id: "Room.Ptt", slug: "room-ptt", micRelay: true, relay: true, members: [], cmds: {} };
let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('p1', 'p1_patv', 'p1', 'x', 'alice')");
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const reset = () => { relay._hits.clear(); relay._jobs.clear(); };
async function upload() {
  const r = await fetch(base + "/api/rooms/" + R.slug + "/clip", { method: "POST",
    headers: { "content-type": "audio/webm", "x-clip-secs": "3.0", "x-test-user": "p1" }, body: Buffer.alloc(2000, 1) });
  return { status: r.status, d: await r.json() };
}
async function sent() {
  const { status, d } = await upload();
  assert.equal(status, 200, JSON.stringify(d));
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id: d.id, ok: true, msg: "queued for the mic", state: "queued" }]);
  return d.id;
}
const plays = () => (relay._hits.get("clip|p1") || []).length;
const ups = () => (relay._hits.get("clipup|p1") || []).length;
const mine = (id) => relay.mineFor("p1", R.id).find((x) => x.id === id);

test("a clip that played keeps its charge: the next one at once is 'slow down — one every 30s'", async () => {
  reset();
  const id = await sent();
  relay.applyAcks([{ id, ok: true, msg: "playing on the mic now", state: "playing" }, { id, ok: true, msg: "played" }]);
  assert.equal(plays(), 1);
  const r = await upload();
  assert.equal(r.status, 429);
  assert.match(r.d.error, /one every 30s/);
});

test("every way a clip ends without playing gives the limit back once - and only its own hit", async () => {
  const misses = [
    { ok: false, msg: "Pepe couldn't get the mic (someone else took the mic) - no cooldown - try again", code: "no_mic" },
    { ok: false, msg: "Pepe couldn't get the mic (Pepe's mic is blocked here) - it didn't count toward your limit", code: "mic_later" },
    { ok: false, msg: "Pepe's audio failed while playing it - no cooldown - try again", code: "audio_failed" },
    { ok: false, msg: "web mic isn't on in this room" },                       // a refusal (nothing played either)
    { ok: false, msg: "the recording expired" },
    { ok: false, msg: "Pepe hit an error" },
  ];
  for (const m of misses) {
    reset();
    const played = await sent();                                             // a clip that played first: its hit stays
    relay.applyAcks([{ id: played, ok: true, msg: "played" }]);
    relay._hits.get("clip|p1")[0] -= 31 * 1000;                              // ...31 s ago
    const id = await sent();
    assert.equal(plays(), 2, m.msg);
    relay.applyAcks([Object.assign({ id }, m)]);
    assert.equal(plays(), 1, `given back: ${m.msg}`);
    relay.applyAcks([Object.assign({ id }, m)]);                             // the same answer again (a re-sent ack)
    assert.equal(plays(), 1, `exactly once: ${m.msg}`);
    assert.equal(mine(id).ok, false);
    const r = await upload();
    assert.equal(r.status, 200, `the next clip goes at once - no cooldown (${m.msg}): ${JSON.stringify(r.d)}`);
  }
});

test("an older Pepe: its first 'queued' answer is final, then the miss - still given back", async () => {
  reset();
  const { d } = await upload();
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id: d.id, ok: true, msg: "queued for the mic - waiting for a free slot" }]);
  assert.equal(plays(), 1);
  relay.applyAcks([{ id: d.id, ok: false, msg: "couldn't get the mic - the room's mic stayed busy. Try again" }]);
  assert.equal(plays(), 0);
});

test("an open clip is timed from Pepe's claim, not the upload: past CLIP_TTL it fails 'unconfirmed', given back, still shown", async () => {
  reset();
  const id = await sent();
  const j = relay._jobs.get(id);
  j.at = Date.now() - 9 * 60 * 1000;                                         // uploaded 9 min ago...
  j.claimed = Date.now() - 60 * 1000;                                        // ...Pepe took it a minute ago (it sat behind others)
  relay._sweep(Date.now());
  assert.equal(j.state, "queued", "still open - Pepe may still play it (he gives up 7 min after it reached him)");
  assert.equal(plays(), 1, "...and still charged");
  j.claimed = Date.now() - 8.5 * 60 * 1000;                                  // Pepe never answered past CLIP_TTL from his claim
  relay._sweep(Date.now());
  assert.equal(j.state, "done");
  assert.equal(j.result.ok, false);
  assert.equal(j.result.code, "unconfirmed");
  assert.match(j.result.msg, /didn.t count toward your limit/);
  assert.equal(plays(), 0, "given back");
  assert.equal(mine(id).code, "unconfirmed", "the clip line says what happened (it used to vanish)");
  relay._sweep(Date.now() + 4 * 60 * 1000);
  assert.equal(relay._jobs.has(id), false, "swept JOB_TTL after it finished");
  assert.equal(plays(), 0);
  // ...and a played clip that is swept later keeps its hit
  const id2 = await sent();
  relay.applyAcks([{ id: id2, ok: true, msg: "played" }]);
  relay._sweep(Date.now() + 4 * 60 * 1000);
  assert.equal(relay._jobs.has(id2), false);
  assert.equal(plays(), 1);
});

test("a clip Pepe said is playing gets 2 more minutes to say how it went", async () => {
  reset();
  const id = await sent();
  const j = relay._jobs.get(id);
  relay.applyAcks([{ id, ok: true, msg: "playing on the mic now", state: "playing" }]);
  j.claimed = Date.now() - 8.5 * 60 * 1000;
  relay._sweep(Date.now());
  assert.equal(j.state, "playing", "playing now: not swept at CLIP_TTL");
  assert.equal(plays(), 1);
  relay._sweep(Date.now() + 2.5 * 60 * 1000);
  assert.equal(j.state, "done");
  assert.equal(j.result.code, "unconfirmed");
  assert.equal(plays(), 0);
});

test("a clip Pepe never takes (not pulling, not in the room) fails 'nopepe' after 75 s - given back, never handed out after", async () => {
  reset();
  const { d } = await upload();
  const j = relay._jobs.get(d.id);
  relay._sweep(Date.now() + 30 * 1000);
  assert.equal(j.state, "pending", "30 s: still waiting for Pepe");
  relay._sweep(Date.now() + 80 * 1000);
  assert.equal(j.state, "done");
  assert.equal(j.result.code, "nopepe");
  assert.match(j.result.msg, /didn.t count toward your limit/);
  assert.equal(plays(), 0, "given back");
  assert.equal(ups(), 1, "the upload still counts for the flood guard");
  assert.deepEqual(relay.takeJobs(new Set([R.id])).filter((x) => x.id === d.id), [], "never handed to Pepe after");
  assert.equal((await upload()).status, 200, "the next clip goes at once");
});

test("a recording that is the upload's own fault (Pepe's bad_clip) keeps its charge", async () => {
  reset();
  const id = await sent();
  relay.applyAcks([{ id, ok: false, msg: "too short", code: "bad_clip" }]);
  assert.equal(plays(), 1, "kept");
  const r = await upload();
  assert.equal(r.status, 429);
  assert.match(r.d.error, /one every 30s/);
});

test("the flood guard: 12 uploads per 10 min, played or not, never given back; a play-limit 429 costs none", async () => {
  reset();
  for (let i = 0; i < 12; i++) {
    const id = await sent();
    relay.applyAcks([{ id, ok: false, msg: "Pepe couldn't get the mic (someone else took the mic) - no cooldown - try again", code: "no_mic" }]);
  }
  assert.equal(plays(), 0);
  assert.equal(ups(), 12);
  const r = await upload();
  assert.equal(r.status, 429);
  assert.match(r.d.error, /12 clips per 10 min/);
  assert.equal(ups(), 12, "the refused upload took nothing");
  assert.equal(plays(), 0, "...nor a play");
  // a play-limit refusal never eats an upload
  reset();
  await sent();
  for (let i = 0; i < 3; i++) assert.equal((await upload()).status, 429);
  assert.equal(ups(), 1, "three play-limit 429s took no uploads");
});

test("mineFor carries a clip's code (the clip line reads it)", async () => {
  reset();
  const id = await sent();
  relay.applyAcks([{ id, ok: false, msg: "Pepe couldn't get the mic (someone else took the mic) - no cooldown - try again", code: "no_mic" }]);
  assert.equal(mine(id).code, "no_mic");
});

// ── the clip line in the browser (public/js/room-bridge.js) ──
function loadClient(o = {}) {
  const ctx = {
    window: {}, console,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0, mediaDevices: {} },
    document: { createElement: () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, appendChild() {}, addEventListener() {} }), hidden: false, addEventListener() {},
                documentElement: o.lang ? { lang: o.lang } : undefined },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: () => Promise.resolve({ json: () => ({ ok: true }) }), Blob: class {},
    Date, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  if (o.t) ctx.__t = o.t;                 // a translated page's catalog lookup
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  return ctx.window.PATVRoom;
}

test("the clip line: Pepe's own words for a coded mic miss; the old wording keeps the short line", () => {
  const S = loadClient().clipStatus;
  const nm = "Pepe couldn't get the mic (someone else took the mic) - no cooldown - try again";
  assert.equal(S({ state: "done", ok: false, code: "no_mic", msg: nm }), nm);
  const ml = "Pepe couldn't get the mic (Pepe's mic is blocked here) - it didn't count toward your limit";
  assert.equal(S({ state: "done", ok: false, code: "mic_later", msg: ml }), ml);
  const af = "Pepe's audio failed while playing it - no cooldown - try again";
  assert.equal(S({ state: "done", ok: false, code: "audio_failed", msg: af }), af);
  const br = "Pepe's mic is on a break in this room for about 29 min (someone in the room blocked Pepe's mic) - it doesn't count toward your limit. Try again then";
  assert.equal(S({ state: "done", ok: false, code: "mic_later", msg: br }), br);
  // an older Pepe's words (no code): the short translated line, as before
  assert.equal(S({ state: "done", ok: false, msg: "couldn't get the mic - the room's mic stayed busy. Try again" }), "couldn’t get the mic, try again");
  // any other refusal: "not sent — why"
  assert.equal(S({ state: "done", ok: false, code: "refused", msg: "web mic isn't on in this room" }), "not sent — web mic isn't on in this room");
});

test("the clip line on a translated page: a translated line per code (en.json), Pepe's own words only on English pages", () => {
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  const keys = { no_mic: "js.pad.ptt.s_no_mic_free", mic_later: "js.pad.ptt.s_mic_later", audio_failed: "js.pad.ptt.s_audio_failed",
                 nopepe: "js.pad.ptt.s_nopepe", unconfirmed: "js.pad.ptt.s_unconfirmed" };
  const words = "Pepe couldn't get the mic (someone else took the mic) - no cooldown - try again";
  // a German page with no catalog loaded: the English of each key (= en.json, i18n.test checks the defaults)
  const S = loadClient({ lang: "de" }).clipStatus;
  for (const [code, key] of Object.entries(keys)) {
    assert.equal(typeof EN[key], "string", `${key} is in en.json`);
    assert.equal(S({ state: "done", ok: false, code, msg: words }), EN[key], code);
  }
  // ...and with its catalog: the translated line
  const T = loadClient({ lang: "de", t: (k, d) => "DE:" + k }).clipStatus;
  for (const [code, key] of Object.entries(keys)) assert.equal(T({ state: "done", ok: false, code, msg: words }), "DE:" + key, code);
  // an English page: Pepe's / the site's own words (the reason, the break's length)
  const E = loadClient({ lang: "en" }).clipStatus;
  for (const code of Object.keys(keys)) assert.equal(E({ state: "done", ok: false, code, msg: words }), words, code);
  assert.equal(E({ state: "done", ok: false, code: "no_mic", msg: "" }), EN[keys.no_mic], "no words: the line");
  // bad_clip / a refusal: "not sent — why", as before
  assert.equal(E({ state: "done", ok: false, code: "bad_clip", msg: "too short" }), "not sent — too short");
});
