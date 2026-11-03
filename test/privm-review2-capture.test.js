// 1.99?? (privacy controls, review fixes 2 - Q4-A; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q4: "every feature works
// for an incognito person's cam ... incognito only affects the NAME shown"): a 🎙 mic-stage snap / clip that DRAWS an incognito cam
// under its frog name is shown in the open like a named cam - `veiled` false, the person only in `vpeople` (server-only, with the
// frog-name session), never in `people` / `cards`. A frog tile that is NOT drawn (its hood: the viewer is excluded, no frame) still
// veils the capture, as before. Offline fixtures (the mic-keep-engine.test.js harness: fake readers, a fake ffmpeg).
//   node --test test/privm-review2-capture.test.js
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-capture-"));
const R = { id: "fixture-pad", slug: "fixture-pad", title: "Fixture pad" }, U = { userId: "fixture-member", level: 3 };
const cam = (id, extra = {}) => ({ kind: "cam", id, name: id, video: "live", watch: "ok", pos: 0, ...extra });
// an incognito person's cam tile on the viewer's stage: its public id ("anon-…"), the frog name, the hood - never a login
const frog = (extra = {}) => ({ kind: "cam", id: "anon-0badf00d", name: "Soggy Bullfrog", veil: "incognito", hood: 1, watch: "ok", video: "live", pos: 1, ...extra });
const VEIL = { login: "frankiecf", sess: "s-frog-1" };
let clock, program, hidden, refused, exact, mic, privLogins, taps, readers, still, veiledNow;
function reset(extra = {}) {
  clock = 100000; program = { layout: "split", src: [cam("alice"), frog()] };
  hidden = new Set(); refused = new Set(); exact = true; mic = []; privLogins = new Set(); taps = []; readers = []; still = null; veiledNow = true; T.snapAt.clear();
  M.configure({ now: () => clock, config: () => ({ stagecap_mic: true }), killed: () => null, roomOff: () => null, eligibility: () => null,
    full: async () => true, block: async () => null, clipSwitch: () => true, clipOffText: () => "Clips are off.", liveShown: () => true, bridgeOk: () => true,
    account: async () => U, resolveRoom: async () => R, people: async () => [], program: async () => program,
    hidden: l => hidden.has(l), camRefusal: async l => (refused.has(l) ? {} : null),
    exact: () => exact, pin: () => true, camPath: (r, l) => "cam-" + l, still: async () => still, offset: () => 0,
    // the frog tile's server-side identity (micfollow's vidVeil), its own relay path and "still incognito under that session"
    vtile: (rid, eid) => (eid === "anon-0badf00d" ? { ...VEIL } : null), vpath: (rid, l) => "vcam-" + l, stillVeiled: () => veiledNow,
    personIncognito: () => veiledNow,
    mic: () => mic, privateLogins: async ls => new Set(ls.filter(l => privLogins.has(l))), note: async () => {},
    audioTap: (r, fn) => { const tap = { fn }; taps.push(tap); return () => {}; },
    fm: () => ({ ...fm, slot: async () => () => {}, run: async (cmd, args) => {
      if (cmd === fm.bin("ffprobe")) return { out: JSON.stringify({ packets: Array.from({ length: 24 }, (_, i) => ({ pos: i * 100, size: 100, duration_time: .25 })) }) };
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
let frame, stillUrl;
test.before(async () => {
  frame = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#d83136" } }).png().toBuffer();
  stillUrl = "data:image/png;base64," + frame.toString("base64");
});
test.beforeEach(() => reset());
test.after(async () => { for (const j of T.jobs.values()) M.cancel(j.id); await tick(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function snapWith(finalProgram) {
  const running = await M.start(options()); await tick();
  if (finalProgram) program = finalProgram;
  readers.forEach(r => r.finish(frame));
  return running.done;
}
async function clipWith() {
  const o = options("clip"), running = await M.start(o); await tick();
  const job = T.jobs.get(o.id); clearInterval(job.timer);
  for (let i = 0; i < 24; i++) {
    clock = job.started + (i + 1) * 250;
    if ((i + 1) % 2 === 0) await T.sample(job);
  }
  job.finishEarly(6);
  return running.done;
}

test("Q4-A: a mic-stage snap that DRAWS an incognito cam under its frog name is in the open - the person only in vpeople, never named", async () => {
  const info = await snapWith();
  assert.equal(info.veiled, false, "a frog-name cam drawn live is shown openly (owner Q4) - it was veiled before");
  assert.deepEqual(info.people, ["alice"], "the named cam");
  assert.deepEqual(info.vpeople, [{ login: "frankiecf", sess: "s-frog-1" }], "the frog-name cam: server-only, with its session");
  assert.ok(!info.cards.includes("frankiecf") && !info.people.includes("frankiecf"), "never a name card or a named person");
});

test("Q4-A: a frog tile that is NOT drawn (its hood - the viewer excluded, or no frame) still veils the snap, as before", async () => {
  let info = await snapWith({ layout: "split", src: [cam("alice"), frog({ watch: "unavailable" })] });
  assert.equal(info.veiled, true, "a hooded frog (the person's rules exclude this viewer)");
  assert.ok(!info.vpeople, "nobody drawn under a frog name");
  reset(); veiledNow = false;                                                 // no longer incognito under that session: the hood
  info = await snapWith();
  assert.equal(info.veiled, true, "consent under that frog-name session failed: the hood");
  reset(); exact = false;                                                     // no exact relay: the frog tile shows its hood
  info = await snapWith();
  assert.equal(info.veiled, true, "a frog tile without its frame is a hood");
});

test("Q4-A: a clip that draws a frog-name cam (a still frame) is in the open; one whose frog tile is a hood all along is veiled", async () => {
  program = { layout: "split", src: [cam("alice", { video: "still" }), frog({ video: "still" })] };
  still = { state: "ok", img: stillUrl };
  let info = await clipWith();
  assert.deepEqual(info.vpeople, [{ login: "frankiecf", sess: "s-frog-1" }]);
  assert.equal(info.veiled, false, "the frog-name cam was drawn: shown openly like the named one");
  reset(); program = { layout: "split", src: [cam("alice", { video: "still" }), frog({ video: "still", watch: "unavailable" })] }; still = { state: "ok", img: stillUrl };
  info = await clipWith();
  assert.equal(info.veiled, true, "a hooded frog all along");
});

// /privacy says the same (V-2: text and behaviour match) - only on the page that shows incognito cams (S7's copy); off, as before
test("Q4-A /privacy: with incognito cams on, the mic-stage paragraph says a cam under a frog name counts as shown openly (never that it can't be kept)", () => {
  const ejs = require("ejs");
  const FILE = path.join(__dirname, "..", "views", "privacy.ejs");
  const src = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  const BASE = { user: null, title: "Privacy Policy", VERSION: "x", UPDATED: "1 November 2026", enforced: false, chatlog: null, hubErasure: null,
                 micrec: null, memory: null, policyDates: { "mic-stage-keep": { at: 1793534400000, day: "1 November 2026" } } };
  const para = (o) => (ejs.render(src, Object.assign({}, BASE, o), { filename: FILE }).match(/<p id="mic-stage-captures">[\s\S]*?<\/p>/) || [""])[0];
  const on = para({ incogcam: { on: true, on_at: 1793700000000, on_day: "3 November 2026" } });
  assert.ok(on.includes("A cam shown under a frog name counts as shown openly"), on.slice(0, 300));
  assert.ok(!on.includes("a cam shown under a frog name, a blanked tile"), "no longer listed among what can't be kept");
  const off = para({});
  assert.ok(!off.includes("frog name counts as shown openly") && off.includes("one with a cover tile, a blanked tile or muted audio can't."), "off: as before");
});
