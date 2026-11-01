// mic keep (handoff 16 follow-up, owner 2026-11-01): the engine's half - every finished mic-stage job reports `cards` (the logins
// shown openly only as a name card) and `veiled` (true unless everyone in it was shown openly: no cover / blank tile, no tile that
// stopped because its person went private, no "Someone is speaking" card, and - while the clip carries room audio - no muted
// stretch and no voice of a person the tiles don't show). stagecap stores the flag; storykeep keeps / posts only unveiled captures.
// Offline fixtures only (the stagemiccap.test.js harness): fake readers, a fake ffprobe / ffmpeg for clips.
//   node --test test/mic-keep-engine.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
process.env.SECRET_KEY = crypto.randomBytes(32).toString("hex");
process.env.FEED_NO_NICE = "1";
const M = require("../stagemiccap"), T = M._test;
const fm = require("../feedmedia"), sharp = require("sharp");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mic-keep-engine-test-"));
const R = { id: "fixture-pad", slug: "fixture-pad", title: "Fixture pad" }, U = { userId: "fixture-member", level: 3 };
const cam = (id, extra = {}) => ({ kind: "cam", id, name: id, video: "live", watch: "ok", pos: 0, ...extra });
const cover = (pos = 1) => ({ kind: "cover", id: "anon-01234567", name: "Frog", veil: "incognito", hood: 1, watch: "cover", pos });
let clock, program, hidden, refused, exact, mic, privLogins, taps, readers, graph;
function reset(extra = {}) {
  clock = 100000; program = { layout: "split", src: [cam("alice"), cam("bob", { pos: 1 })] };
  hidden = new Set(); refused = new Set(); exact = true; mic = []; privLogins = new Set(); taps = []; readers = []; graph = null; T.snapAt.clear();
  M.configure({ now: () => clock, config: () => ({ stagecap_mic: true }), killed: () => null, roomOff: () => null, eligibility: () => null,
    full: async () => true, block: async () => null, clipSwitch: () => true, clipOffText: () => "Clips are off.", liveShown: () => true, bridgeOk: () => true,
    account: async () => U, resolveRoom: async () => R, people: async () => [], program: async () => program,
    hidden: l => hidden.has(l), camRefusal: async l => (refused.has(l) ? {} : null),
    exact: () => exact, pin: () => true, camPath: (r, l) => "cam-" + l, still: () => null, offset: () => 0,
    mic: () => mic, privateLogins: async ls => new Set(ls.filter(l => privLogins.has(l))), note: async () => {},
    audioTap: (r, fn) => { const tap = { fn }; taps.push(tap); return () => {}; },
    fm: () => ({ ...fm, slot: async () => () => {}, run: async (cmd, args) => {
      if (cmd === fm.bin("ffprobe")) return { out: JSON.stringify({ packets: Array.from({ length: 24 }, (_, i) => ({ pos: i * 100, size: 100, duration_time: .25 })) }) };
      graph = args.includes("-filter_complex") ? args[args.indexOf("-filter_complex") + 1] : null;
      fs.writeFileSync(args[args.length - 1], "fixture"); return { out: "" };
    } }),
    reader: fakeReader, privacyWaitMs: 50, lastRosterWaitMs: 0, cards: async () => [], ...extra });
}
function id() { return "c" + crypto.randomBytes(10).toString("hex"); }
function options(kind = "snap") { const cid = id(); return { id: cid, R, user: U, kind, secs: 10, surface: "pad", tmpDir: tmp, out: path.join(tmp, cid + (kind === "snap" ? ".webp" : ".mp4")) }; }
function fakeReader(job, tile, file) {
  let resolve, done = false;
  const p = new Promise(r => { resolve = r; });
  const rd = { done: p, file, tile, kill() { if (done) return; done = true; resolve({ ok: false, file, firstAt: 0 }); },
    finish(data) { if (done) return; fs.writeFileSync(file, data); done = true; resolve({ ok: true, file, firstAt: 0 }); } };
  readers.push(rd); return rd;
}
const tick = () => new Promise(r => setImmediate(r));
let frame;
test.before(async () => { frame = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#d83136" } }).png().toBuffer(); });
test.beforeEach(() => reset());
test.after(async () => { for (const j of T.jobs.values()) M.cancel(j.id); await tick(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A snap whose final program is `finalProgram` (readers deliver frames). -> info */
async function snapWith(finalProgram) {
  const running = await M.start(options()); await tick();
  if (finalProgram) program = finalProgram;
  readers.forEach(r => r.finish(frame));
  return running.done;
}
/**
 * A 6 s forward clip on the fixture clock: `during(job, t)` runs at each 0.5 s step (change the program / mic list there); the room
 * audio taps 0.25 s chunks unless `audio` is false (`lat`: their MP3 latency, ms); `after(job)` runs after the last sample, before the
 * clip ends (what only the last mic-list read can see). -> info
 */
async function clipWith({ during = () => {}, audio = true, hmAt = () => 0, lat = 0, after = () => {} } = {}) {
  const o = options("clip"), running = await M.start(o); await tick();
  const job = T.jobs.get(o.id); clearInterval(job.timer);                   // the samples below run on the fixture clock only
  for (let i = 0; i < 24; i++) {
    const t = (i + 1) * .25;
    clock = job.started + t * 1000;
    if (audio) taps[0].fn(Buffer.alloc(100, 1), { hm: hmAt(t), lat: { mp3_ms: lat } });
    if (t % .5 === 0) { await during(job, t); await T.sample(job); }
  }
  await after(job);
  job.finishEarly(6);
  return running.done;
}

test("mic keep: a snap in which everyone is shown openly is not veiled; a cam that could only be a name card is recorded as a card", async () => {
  let info = await snapWith();
  assert.deepEqual([info.people, info.cards, info.veiled], [["alice", "bob"], [], false]);
  reset(); exact = false;                                                     // live video not exact -> both are name cards
  info = await snapWith();
  assert.deepEqual([info.people, info.cards.sort(), info.veiled], [[], ["alice", "bob"], false], "name cards are shown openly");
  reset(); program = { layout: "split", src: [cam("alice"), cam("bob", { pos: 1, watch: "notice" })] };
  info = await snapWith();
  assert.deepEqual([info.people, info.cards, info.veiled], [["alice"], ["bob"], false], "a noticed-only cam is a card");
});

test("mic keep: a snap with a cover tile, a blank tile or a 'Someone is speaking' card is veiled - and records no identity for them", async () => {
  let info = await snapWith({ layout: "split", src: [cam("alice"), cover()] });
  assert.equal(info.veiled, true, "a cover tile"); assert.deepEqual(info.cards, []); assert.deepEqual(info.people, ["alice"]);
  reset(); refused.add("bob");                                                // bob's cam rules refuse this viewer: a blank tile
  info = await snapWith();
  assert.equal(info.veiled, true, "a blank tile"); assert.deepEqual([info.people, info.cards], [["alice"], []], "never the blanked person");
  reset();
  info = await snapWith({ layout: "split", src: [cam("alice"), cam("bob", { pos: 1 })], speaking: "someone" });
  assert.equal(info.veiled, true, "someone nobody can show is speaking");
  reset();
  info = await snapWith({ layout: "split", src: [cam("alice"), cam("bob", { pos: 1 })], speaking: "pepe" });
  assert.equal(info.veiled, false, "Pepe on the mic isn't a person");
});

test("mic keep: a clip whose tiles stay open is not veiled; one tile leaving the mic (consent intact) keeps it open", async () => {
  let info = await clipWith();
  assert.equal(info.veiled, false); assert.equal(info.audio.reason, null); assert.equal(info.audio.muted_s, 0);
  assert.deepEqual(info.cards.sort(), ["alice", "bob"], "fake relays never decode: both tiles are name cards in this fixture");
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) program = { layout: "split", src: [cam("alice")] }; } });
  assert.equal(info.veiled, false, "bob left the stage with his consent intact");
  assert.ok(info.cards.includes("bob"), "he was shown (as a name card) before he left");
});

test("mic keep: a clip tile that stops because its person went private (gone from the program and consent fails, or blanked) is veiled", async () => {
  let info = await clipWith({ during: (job, t) => { if (t === 3) { hidden.add("bob"); program = { layout: "split", src: [cam("alice")] }; } } });
  assert.equal(info.veiled, true, "micfollow cut bob for going hidden: his tile vanished and his consent fails now");
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) refused.add("bob"); } });
  assert.equal(info.veiled, true, "bob's tile turned blank (his cam rules now refuse)");
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) program = { layout: "split", src: [cam("alice"), { ...cover(1), id: "bob" }] }; } });
  assert.equal(info.veiled, true, "bob's tile turned into a cover");
  reset(); refused.add("bob");                                                // blank from the start
  info = await clipWith();
  assert.equal(info.veiled, true);
  reset(); program = { layout: "split", src: [cam("alice"), cover()] };       // a cover from the start (it never changes)
  info = await clipWith();
  assert.equal(info.veiled, true, "a cover tile drawn all along"); assert.ok(!info.cards.some(l => /anon|frog/i.test(l)), "never its identity");
});

test("mic keep: while a clip carries room audio, a muted stretch or a voice the tiles don't show makes it veiled; without audio it can't", async () => {
  // Pepe marked a stretch as a hidden holder's (hm): the audio plan mutes it -> veiled (every tile stays open, the list shows nobody else)
  let info = await clipWith({ hmAt: t => (t > 2 && t <= 3 ? 1 : 0) });
  assert.ok(info.audio.muted_s > 0); assert.equal(info.veiled, true, "muted sound");
  assert.match(graph, /volume=0:enable=/, "the stretch really is muted in the encode");
  // a holder the fixed tiles never draw (zed grabbed the mic mid-clip), not private: nothing muted, but his voice isn't shown
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) mic = [{ login: "zed", since: job.started + 2500 }]; } });
  assert.equal(info.audio.muted_s, 0); assert.equal(info.veiled, true, "a voice the clip doesn't show");
  // ... an anonymous holder, the same
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) mic = [{ anon: true }]; } });
  assert.equal(info.veiled, true, "an anonymous voice");
  // the people shown, Pepe himself and a bot holding the mic are fine
  reset();
  info = await clipWith({ during: (job, t) => { if (t === 3) mic = [{ login: "alice", proven: true }, { login: "BOB", proven: true }, { self: true, login: "pepefrog" }, { bot: true, login: "musicbot" }]; } });
  assert.equal(info.veiled, false, "every voice is someone shown (or not a person)");
  // the same unseen voice with no room audio in the clip: nothing of him is in it
  reset();
  info = await clipWith({ audio: false, during: (job, t) => { if (t === 3) mic = [{ login: "zed" }]; } });
  assert.equal(info.audio.reason, "off"); assert.equal(info.veiled, false, "audio dropped whole: judged on the pictures alone");
});

test("mic keep: noteVoices - an unreadable mic list or a holder whose tile stopped counts as unseen; the tiles shown don't", () => {
  const job = { tiles: [{ login: "alice", stop: null, mode: "live" }, { login: "bob", stop: 2, mode: "card" }, { mode: "cover", stop: null }] };
  T.noteVoices(job, [{ login: "Alice", proven: true }]); assert.equal(!!job.unseen, false);
  T.noteVoices(job, [{ login: "bob", proven: true }]); assert.equal(job.unseen, true, "bob's tile stopped while he still holds the mic");
  const j2 = { tiles: [] }; T.noteVoices(j2, undefined); assert.equal(j2.unseen, true, "no mic list: fail closed");
  const j3 = { tiles: [{ login: "alice", stop: null, mode: "live" }] }; T.noteVoices(j3, [{ login: "bad login!" }]); assert.equal(j3.unseen, true);
});

// ── review fixes ──
test("mic keep review: the lead-in every clip with MP3 latency has (sound made before the first mic-list read) is muted but doesn't veil it; a private mute does", async () => {
  let info = await clipWith({ lat: 500 });
  assert.ok(info.audio.muted_s > 0, "the lead-in is muted (future-only audio)");
  assert.match(graph, /volume=0:enable=/);
  assert.equal(info.veiled, false, "nothing heard in it is anyone's - everyone was shown openly");
  reset();
  info = await clipWith({ lat: 500, hmAt: t => (t > 3 && t <= 4 ? 1 : 0) });
  assert.equal(info.veiled, true, "a hidden holder's stretch still veils it");
  // the plan itself: private_s counts Pepe's hm mark, a private holder and audio that can't be placed - never the lead-in
  const chunks = Array.from({ length: 8 }, (_, i) => ({ offset: i * 100, bytes: 100, at: (i + 1) * .25, hm: 0, lat: { mp3_ms: 1000 } }));
  const packets = chunks.map(c => ({ pos: c.offset, size: 100, duration_time: .25 }));
  const lead = M.audioPlan(chunks, packets, [{ at: 0, private: false }], 2);
  assert.ok(lead.muted_s > 0); assert.equal(lead.private_s, 0);
  assert.ok(M.audioPlan(chunks, packets, [{ at: 0, private: true }], 2).private_s > 0, "a private holder from the start");
  assert.ok(M.audioPlan(chunks.map((c, i) => ({ ...c, hm: i === 6 ? 1 : 0 })), packets, [{ at: 0, private: false }], 2).private_s > 0, "Pepe's hm mark");
  assert.ok(M.audioPlan(chunks.map(c => ({ ...c, lat: null })), packets, [{ at: 0, private: false }], 2).private_s > 0, "audio that can't be placed");
  assert.ok(M.audioPlan(chunks, packets, [], 2).private_s > 0, "no mic-list read at all");
});

test("mic keep review: a hold that began in the clip's last seconds (after its last sample - Pepe's list is up to 2 s late) is still checked; one that began after the end isn't in it", async () => {
  const wins = () => { const m = /volume=0:enable='([^']*)'/.exec(graph || ""); return m ? [...m[1].matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map(x => [Number(x[1]), Number(x[2])]) : []; };
  const mutedAt = x => wins().some(([a, b]) => a <= x && x <= b);
  // zed (not shown) grabbed at 5.6 s; the list carrying him reaches the site only after the clip's last sample
  let info = await clipWith({ after: job => { mic = [{ login: "zed", proven: true, since: job.started + 5600 }]; } });
  assert.equal(info.veiled, true, "his voice is in the clip's last 0.4 s");
  reset();
  info = await clipWith({ after: job => { mic = [{ login: "zed", proven: true, since: job.started + 6500 }]; } });
  assert.equal(info.veiled, false, "he grabbed after the clip ended");
  // alice (shown) is private and her hold began at 5 s: the last read mutes her from her since - the 24 h story's clip too
  reset();
  info = await clipWith({ after: job => { mic = [{ login: "alice", proven: true, since: job.started + 5000 }]; privLogins.add("alice"); } });
  assert.ok(mutedAt(5.5), "muted from her hold"); assert.ok(!mutedAt(2), "not before it");
  assert.equal(info.veiled, true, "a private mute: not in the open");
  // the list unreadable at that last read: unseen, and its last MIC_LAG muted
  reset();
  info = await clipWith({ after: () => { mic = undefined; } });
  assert.equal(info.veiled, true); assert.ok(mutedAt(5));
});

test("mic keep review: noteVoices - a holder without Pepe's proven mark is unseen even when the name matches a shown tile", () => {
  const job = { tiles: [{ login: "alice", stop: null, mode: "live" }] };
  T.noteVoices(job, [{ login: "alice" }]); assert.equal(job.unseen, true);
  const ok = { tiles: [{ login: "alice", stop: null, mode: "live" }] };
  T.noteVoices(ok, [{ login: "alice", proven: true }]); assert.equal(!!ok.unseen, false);
});

test("mic keep review: the publish recheck covers the name cards - a card person who went private or hidden since the preview stops it", async () => {
  const cap = { id: id(), user_id: U.userId, room_id: R.id, kind: "snap" };
  M.configure({ people: async () => ["alice"], cards: async () => ["bob"] });
  assert.equal(await M.recheck(cap), null);
  hidden.add("bob");
  assert.equal(await M.recheck(cap), T.MSG.revoked, "hidden");
  hidden.clear(); privLogins.add("bob");
  assert.equal(await M.recheck(cap), T.MSG.revoked, "keeps their activity private");
});
