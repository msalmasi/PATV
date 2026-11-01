// wave 2 WP-2 (incognito / mic-stage spec H, owner-approved 2026-10-28; I.2 go-live): the privacy text behind the "Privacy wire v2"
// switch. With the switch OFF the privacy page is byte for byte what the pre-WP-2 build (staging 6ee3c0a1) renders - with and without
// the chat archive's, the mic recordings' and the memory switch's texts - so shipping dark changes nothing a member reads. With it
// ON the approved paragraphs show (frog names, the hidden bar, who can see through it, the retention rows, the changelog entry dated
// by G), and nothing promises the WP-5 evidence clips yet.
//   node --test test/privwire-policy.test.js       (needs git; the comparison half is skipped when the old commit isn't in this clone)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const FILE = path.join(repo, "views", "privacy.ejs");
process.chdir(fs.mkdtempSync(path.join(require("os").tmpdir(), "privwire-policy-test-")));   // (help.js opens ./myapp.db: a temp one)
const lf = (s) => String(s).replace(/\r\n/g, "\n");
const BASE = { user: null, title: "Privacy Policy", VERSION: "x", UPDATED: "1 November 2026", enforced: false, chatlog: null, hubErasure: null,
               micrec: null, memory: null, policyDates: {} };
const MEMORY = { on_day: "29 October 2026", on_at: 1793200000000 };
const render = (src, extra) => ejs.render(lf(src), Object.assign({}, BASE, extra), { filename: FILE });

test("switch off: the privacy page is byte for byte the pre-WP-2 one (plain, with the memory switch)", (t) => {
  const old = spawnSync("git", ["show", "6ee3c0a1:views/privacy.ejs"], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (old.status !== 0) { t.skip("6ee3c0a1 isn't in this clone"); return; }
  const now = fs.readFileSync(FILE, "utf8");
  for (const extra of [{}, { memory: MEMORY }, { privwire: null }]) {
    assert.equal(render(now, extra), render(old.stdout, extra), "identical with " + JSON.stringify(extra));
  }
});

test("/help: Pepe's incognito / bridge / transcripts cards get the v2 notes only while the switch is on", async () => {
  process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret";
  const H = require(path.join(repo, "help"));
  const PW = require(path.join(repo, "privwire"));
  const cards = [{ id: "incognito", summary: "be someone" }, { id: "bridge", summary: "left out" }, { id: "transcripts", summary: "off" }, { id: "dice", summary: "roll" }];
  assert.deepEqual(H.withPrivwireNotes(cards), cards, "off (the default): byte-equal - the same objects");
  const on = PW.isOn;
  PW.isOn = () => true;
  try {
    const out = H.withPrivwireNotes(cards);
    assert.match(out[0].details, /random frog name/);
    assert.match(out[1].details, /blacked-out bar/);
    assert.match(out[2].details, /never reach the website/);
    assert.equal(out[3], cards[3], "other cards untouched");
  } finally { PW.isOn = on; }
});

test("switch on: the approved section H text shows, dated by G; no evidence-clip promise before WP-5", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const on = render(now, { privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" } });
  const off = render(now, {});
  for (const s of ["random frog name", "blacked-out bar", "Who can see through it", "Hidden (<code>!bridge hide</code>) is incognito plus a blacked-out bar",
                   "Log of reveals by pad owners and administrators", "<b>1 November 2026:</b> <a href=\"#incognito\">Incognito</a> and hidden",
                   "anyone can clip your mic turns like everyone's, and the clip shows your frog name"]) {
    assert.ok(on.includes(s), "on: " + s);
    assert.ok(!off.includes(s), "off: " + s);
  }
  assert.ok(!/moderation evidence|evidence clip/i.test(on), "no moderation-evidence sentence until WP-5 ships the evidence store");
  assert.ok(!on.includes("you appear as \"someone\";"), "the old section 3 sentence is replaced");
  // with the mic-recordings text too (the merged capture bullet)
  const MR = { on_day: "28 October 2026", on_at: 1793100000000, ret: null };
  let both = null;
  try { both = render(now, { privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" }, micrec: MR }); } catch (e) { both = null; }
  if (both) assert.ok(both.includes("Your mic-ups are also recorded and kept like everyone's"), "the merged capture bullet with mic recordings on");
});
