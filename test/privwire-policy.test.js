// wave 2 WP-2 (incognito / mic-stage spec H, owner-approved 2026-10-28; I.2 go-live): the privacy text behind the "Privacy wire v2"
// switch. With the switch OFF the privacy page is byte for byte what the build before wave 2 renders - today's prod privacy page
// (119e948b: 1.99agr's short links on 72b12510's 1.99agq + 1.99ago mic-stage keep text - the privacy page, layout and legal css are
// unchanged between the two; the track was built on 6ee3c0a1 and moved here at integration) - with and
// without the memory switch's and the dated texts (wp1-voice, mic-stage-keep), so shipping dark changes nothing a member reads. With it
// ON the approved paragraphs show (frog names, the hidden bar, who can see through it, the retention rows, the changelog entry dated
// by G), and nothing promises the WP-5 evidence clips while they are off (locals.evidence null). WP-5: with evidence clips on (or kept),
// the three approved section H insertions show word for word - the capture bullet's sentence, the section 9 row and the changelog clause.
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
const DATES = { "wp1-voice": { at: 1793100000000, day: "28 October 2026" }, "mic-stage-keep": { at: 1793534400000, day: "1 November 2026" } };
// 1.99ajn padppl: section 6's "Blocking someone" paragraph is the current text for everyone (blocks.js - not behind a switch; dated by
// terms.js "blocks-2"): the one addition to the switch-off page, taken out before comparing with the old commit
const PADPPL = (page) => page.replace(/[ \t]*<p id="blocking">[\s\S]*?<\/p>\r?\n/, "");
const render = (src, extra) => ejs.render(lf(src), Object.assign({}, BASE, extra), { filename: FILE });

// mic keep wording fix (owner-approved 2026-11-02): the two sentences added to the Mic-stage snaps and clips paragraph - the only
// difference from 119e948b, and only on a page that publishes that paragraph (never served anywhere yet: mic-stage captures are off)
const MSK_FIX = [" \"Muted audio\" here means sound muted for a hidden or private speaker, not the second or so of silence every clip starts with.",
                 " Deleting a posted copy any other way - by the person who posted it, an admin or an account deletion - also deletes every saved copy."];
test("switch off: the privacy page is byte for byte today's prod one (plain, with the memory switch, with the dated texts)", (t) => {
  const old = spawnSync("git", ["show", "119e948b:views/privacy.ejs"], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (old.status !== 0) { t.skip("119e948b isn't in this clone"); return; }
  const now = fs.readFileSync(FILE, "utf8");
  // mic-stage captures off (prod and staging today: only wp1-voice is dated) - byte for byte
  for (const extra of [{}, { memory: MEMORY }, { privwire: null }, { policyDates: { "wp1-voice": DATES["wp1-voice"] } },
                       { policyDates: { "wp1-voice": DATES["wp1-voice"] }, memory: MEMORY, privwire: null }]) {
    assert.equal(render(now, extra).split('<p id="blocking">').length, 2, "the blocking paragraph, once");
    assert.equal(PADPPL(render(now, extra)), render(old.stdout, extra), "identical with " + JSON.stringify(extra));
  }
  // the mic-stage paragraph published: identical but for the wording fix's two sentences, each once, inside that paragraph
  for (const extra of [{ policyDates: DATES }, { policyDates: DATES, memory: MEMORY, privwire: null }]) {
    const page = render(now, extra);
    const para = (page.match(/<p id="mic-stage-captures">[\s\S]*?<\/p>/) || [""])[0];
    for (const s of MSK_FIX) assert.equal(page.split(s).length, 2, "once: " + s), assert.ok(para.includes(s), "in the paragraph: " + s);
    assert.equal(MSK_FIX.reduce((x, s) => x.replace(s, ""), PADPPL(page)), render(old.stdout, extra), "nothing else changed with " + JSON.stringify(extra));
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
    // 1.99aht transcripts bar: while the bar is live too (privwire.txBar: the switch AND a Pepe that sends it), the transcripts card says
    // the bar - Pepe's v2tx wording when his data has it, else the site's own; the bridge card's old transcripts clause is swapped
    const tb = PW.txBar;
    PW.txBar = () => true;
    try {
      const bridgeV2 = { id: "bridge", summary: "b", v2: { details: "Hidden people show as a bar. `!transcripts off` keeps your mic transcripts off the website." } };
      const out2 = H.withPrivwireNotes([...cards, bridgeV2, { id: "transcripts", summary: "off", v2tx: { summary: "Pepe's bar words" } }]);
      // (1.99aht S1, owner Q5 / Q6: the name still shows, only the words are blacked out, members can still clip the audio)
      assert.equal(out2[2].summary, "Your own switch: with !transcripts off, your name still shows on the website, but your mic words are blacked out.");
      assert.ok(out2[2].details.includes("With `!transcripts off`, your name still shows there, but your words are blacked out. Members can still clip " +
                                         "the audio, but never see the words. PATV administrators, and a pad's owner in their own pad, can reveal the " +
                                         "words. Every reveal is logged."), out2[2].details);
      assert.ok(!/never reach the website|Members can't clip/.test(out2[2].details), "no longer 'never reach the website' or 'can't clip'");
      assert.equal(out2[4].details, "Hidden people show as a bar. `!transcripts off` blacks out only the words of your mic transcripts (your name still shows).");
      assert.equal(out2[5].summary, "Pepe's bar words", "Pepe's own v2tx wording wins");
      assert.equal(out2[3], cards[3], "other cards untouched");
    } finally { PW.txBar = tb; }
    const out3 = H.withPrivwireNotes([{ id: "transcripts", summary: "off", v2tx: { summary: "Pepe's bar words" } }]);
    assert.match(out3[0].details, /never reach the website/, "the switch on but no bar: v2tx is ignored");
  } finally { PW.isOn = on; }
});

test("switch on: the approved section H text shows, dated by G; no evidence-clip promise while evidence clips are off", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const on = render(now, { privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" } });
  const off = render(now, {});
  for (const s of ["random frog name", "blacked-out bar", "Who can see through it", "Hidden (<code>!bridge hide</code>) is incognito plus a blacked-out bar",
                   "Log of reveals by pad owners and administrators", "<b>1 November 2026:</b> <a href=\"#incognito\">Incognito</a> and hidden",
                   "anyone can clip your mic turns like everyone's, including onto a soundboard, and the clip shows your frog name",
                   "it's never used for voice features, and a hidden person's turns never reach a soundboard"]) {
    assert.ok(on.includes(s), "on: " + s);
    assert.ok(!off.includes(s), "off: " + s);
  }
  assert.ok(!/moderation evidence|evidence clip/i.test(on), "no moderation-evidence sentence while evidence clips are off (locals.evidence null)");
  assert.ok(!on.includes("you appear as \"someone\";"), "the old section 3 sentence is replaced");
  // owner 11-02 (M addendum 4, item 1): frog-name clips may go on soundboards, so the bullet no longer says the buffer is never used for them
  assert.ok(!on.includes("never used for soundboards"), "no blanket soundboard promise with the switch on");
  // 1.99ago's mic-stage keep paragraph (and its change note) stays after section 3's privwire paragraph with the switch on too
  const onKeep = render(now, { privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" }, policyDates: DATES });
  assert.ok(onKeep.includes("random frog name") && onKeep.includes('<p id="mic-stage-captures">'), "on + mic-stage-keep: both paragraphs");
  assert.ok(onKeep.indexOf("random frog name") < onKeep.indexOf('<p id="mic-stage-captures">'), "the keep paragraph follows section 3's");
  assert.ok(onKeep.includes('href="#mic-stage-captures"'), "the keep change note");
  // with the mic-recordings text too (the merged capture bullet)
  const MR = { on_day: "28 October 2026", on_at: 1793100000000, ret: null };
  let both = null;
  try { both = render(now, { privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" }, micrec: MR }); } catch (e) { both = null; }
  if (both) assert.ok(both.includes("Your mic-ups are also recorded and kept like everyone's"), "the merged capture bullet with mic recordings on");
});

// 1.99ahx frog names (owner 2026-11-03, "Lets do 2"): "someone" lasts 15 minutes after being seen by name, then a frog name - the switch-on
// page says so (never "until your next visit"), the switch-off page is untouched, and the text is dated ("frog-15", only while on)
test("1.99ahx frog-15: the switch-on incognito bullet says 'someone' for 15 minutes, then a frog name; dated by 'frog-15' only while the switch is on", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const PWON = { on: true, g: 1793534400000, g_day: "1 November 2026" };
  const on = render(now, { privwire: PWON });
  const NEW = "If you were just seen under your name in a room, you show up as \"someone\" there for 15 minutes, then under a frog name.";
  assert.equal(on.split(NEW).length, 2, "once, in the incognito bullet");
  assert.ok(!on.includes("until your next visit"), "never the old rule");
  assert.ok(!render(now, {}).includes(NEW), "switch off: not there (the page as before)");
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /"frog-15": \(\) => require\("\.\/privwire"\)\.isOn\(\) === true/);
  assert.match(src, /filter\(\(\[k\]\) => k !== "frog-15" \|\| privwire\)/);
});

// wave 2 WP-5: the three insertions, word for word as approved (section H, M addendum 2; the merged bullet M addendum 3) - never reworded.
// owner 11-02 (M addendum 4, item 5): the sentence and the section 9 row, where they state the 30 days, add "copies in backups are deleted
// within 30 days after" (the changelog clause is unchanged)
const EV_SENTENCE = " An administrator or the pad's owner can save your mic audio as moderation evidence after revealing who you are - never posted, kept 30 days (copies in backups are deleted within 30 days after), and every evidence clip is logged.";
const EV_ROW = "<tr><td>Moderation evidence clips of incognito or hidden people</td><td>30 days (longer only under a legal hold). Copies in backups are deleted within 30 days after.</td></tr>";
const EV_CHANGE = "for moderation (each reveal logged; kept for the pad's chat window); they can also save an incognito or hidden person's mic audio as moderation evidence (logged, 30 days, never posted). Neither setting mutes";
test("WP-5: evidence clips on -> the approved capture sentence, section 9 row and changelog clause, exactly; kept clips alone keep the row", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const PWON = { on: true, g: 1793534400000, g_day: "1 November 2026" };
  const EV = { on: true, any: false, on_at: 1793600000000, on_day: "2 November 2026" };
  const both = render(now, { privwire: PWON, evidence: EV });
  assert.ok(both.includes("If you're hidden, members can't clip them." + EV_SENTENCE), "the capture sentence, right after the hidden-clip sentence");
  assert.ok(both.includes(EV_ROW), "the section 9 row");
  assert.ok(both.includes(EV_CHANGE), "the changelog clause, before the full stop");
  assert.equal(both.split(/moderation evidence/i).length - 1, 3, "three places, no more");
  assert.equal(both.split("deleted within 30 days after").length - 1, 2, "owner 11-02: the backup clause in the sentence and the row, nowhere else");
  // with mic recordings too: the sentence stays before the recordings sentence (the merged bullet)
  const withRec = render(now, { privwire: PWON, evidence: EV, micrec: { on_day: "28 October 2026", on_at: 1793100000000, ret: null } });
  assert.ok(withRec.includes(EV_SENTENCE + " Your mic-ups are also recorded and kept like everyone's"), "before the mic-recordings sentence");
  // privacy wire v2 on, evidence clips off: none of it
  const pwOnly = render(now, { privwire: PWON, evidence: null });
  for (const s of [EV_SENTENCE, EV_ROW, "they can also save an incognito"]) assert.ok(!pwOnly.includes(s), "evidence off: " + s.slice(0, 40));
  // privacy wire v2 off but clips still kept (switched off later): the retention row stays true until the last one goes
  const keptOnly = render(now, { evidence: { on: false, any: true, on_at: 1793600000000, on_day: "2 November 2026" } });
  assert.ok(keptOnly.includes(EV_ROW), "the retention row while clips are kept");
  assert.ok(!keptOnly.includes(EV_SENTENCE.trim()) && !keptOnly.includes("they can also save an incognito"), "the privwire paragraphs stay off");
  // and with evidence null (the default) the page is the switch-off page: byte-identical (the first test compares that with 119e948b)
  assert.equal(render(now, { evidence: null }), render(now, {}));
});

test("WP-5: terms.js dates /privacy by the evidence switch's first ON too (evidence.privacyCopy) and passes it to the view", () => {
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /evidence = await require\("\.\/evidence"\)\.privacyCopy\(\)/);
  assert.match(src, /\[evidence && evidence\.on_at, evidence && evidence\.on_day\]/);
  assert.match(src, /privwire, evidence, policyDates \}\)/);
});

// 1.99aht transcripts bar (owner 2026-11-02: "If someone has !transcripts off, it should still show in the chat but blocked out like with
// bridge hide."): its sentences show only inside the privacy-wire-v2 branches AND while the bar is live (terms.js locals.txbar =
// privwire.txBar: the switch on and a Pepe that sends the bar); the change note is dated by policy_text_dates "tx-bar". The owner approves
// this wording before it ships - these are the exact sentences.
// 1.99aht S1 (owner answers Q5 / Q6 / Q7, 2026-11-02): the name still shows, only the words are blacked out, members can still clip the
// audio (never the words), administrators and the pad's owner can reveal the words (logged); earlier mic transcripts stay left out
const TXB_SENTENCES = [
  " If you type <code>!transcripts off</code>, your name still shows, but the words of your mic transcripts are blacked out. Members can still clip the audio, but never see the words. Administrators and the pad's owner can reveal the words, and every reveal is logged.",
  "With <code>!transcripts off</code>, your name still shows (your frog name if you're incognito), but the words of your mic transcripts are a blacked-out bar for everyone else. They can't be searched or quoted. Only the pad's owner and PATV administrators can reveal the words, and each reveal is logged. Your mic transcripts from before you turned transcripts off are left out until you turn them back on.",
  " Mic transcripts said with <code>!transcripts off</code> before 3 November 2026 stay left out.",
  " Neither mutes your voice in the room's audio. <code>!transcripts off</code> blacks out only the words of your mic transcripts; your name still shows. Members can still clip the audio, but never see the words. See",
  "<li><b><code>!transcripts off</code> blacks out only your words on the mic:</b> your name still shows (your frog name if you're incognito or hidden), but your mic transcripts show on the website as a blacked-out bar. Your typed lines and your mic grabs and drops show as usual. Members can still clip the audio of your mic turns, but never see the words. Only PATV administrators and a pad's owner (in their own pad, for lines said while they own it) can reveal the words, and every reveal is logged.",
  "<li><b>3 November 2026:</b> <code>!transcripts off</code> (sections 3 and 10): your mic transcripts now show on the website instead of being left out. Your name still shows; only the words are blacked out. Members can still clip the audio, but never see the words. PATV administrators and a pad's owner can reveal the words, for moderation (each reveal logged). This applies to mic transcripts said from 3 November 2026; earlier ones stay left out.</li>",
];
const TXB_EVIDENCE = [" An administrator or the pad's owner can save one as moderation evidence, like a hidden person's.</li>",
                      "; an administrator or the pad's owner can save one as moderation evidence (logged, 30 days, never posted)."];
test("transcripts bar: its sentences only with privacy wire v2 AND the bar live, dated by tx-bar; switch off or no bar: the page as before", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const PWON = { on: true, g: 1793534400000, g_day: "1 November 2026" };
  const TXD = Object.assign({}, DATES, { "tx-bar": { at: 1793700000000, day: "3 November 2026" } });
  const CLOC = { notice_day: "1 October 2026", start_day: "8 October 2026" };    // (the chat-history section: the archive's notice is on)
  const on = render(now, { privwire: PWON, txbar: { on: true }, policyDates: TXD, chatlog: CLOC });
  for (const s of TXB_SENTENCES) assert.equal(on.split(s).length, 2, "once: " + s.slice(0, 70));
  assert.ok(!on.includes("<code>!transcripts off</code> leaves your mic transcripts out."), "the old chat-history sentence is replaced");
  // 1.99aht S1: nothing of the txbar build's first wording ("without your name", "can't clip") is left
  for (const s of ["without your name", "Members can't clip those mic turns", "members can no longer clip"]) assert.ok(!on.includes(s), "gone: " + s);
  // 1.99aht RV-4: "While it's on, your earlier mic transcripts are left out." read as "while transcripts are on" - gone; the clip point
  // is in section 3 and section 10 too (the same sentence as Pepe's replies)
  assert.ok(!on.includes("While it's on, your earlier mic transcripts"), "RV-4: the misreadable sentence is gone");
  assert.equal(on.split("Members can still clip the audio, but never see the words.").length - 1, 3, "RV-4: sections 3 and 10 and the change note carry the clip point");
  assert.ok(on.indexOf("<b>3 November 2026:</b> <code>!transcripts off</code>") < on.indexOf("<b>1 November 2026:</b> <a href=\"#incognito\">"), "the newest change note first");
  for (const s of TXB_EVIDENCE) assert.ok(!on.includes(s), "no evidence sentence while evidence clips are off");
  // the approved wave 2 sentences are untouched (the evidence sentence still follows the hidden-clip one)
  const ev = render(now, { privwire: PWON, txbar: { on: true }, policyDates: TXD, chatlog: CLOC, evidence: { on: true, any: false, on_at: 1793600000000, on_day: "2 November 2026" } });
  for (const s of TXB_EVIDENCE) assert.equal(ev.split(s).length, 2, "evidence on: " + s.slice(0, 60));
  assert.ok(ev.includes("If you're hidden, members can't clip them." + EV_SENTENCE), "wave 2's capture sentence as approved");
  // no tx-bar date (the dates table failed): the sentences, without the dated ones
  const nodate = render(now, { privwire: PWON, txbar: { on: true }, policyDates: DATES, chatlog: CLOC });
  assert.ok(nodate.includes(TXB_SENTENCES[0]) && !nodate.includes("3 November 2026"), "undated: no date clause, no change note");
  // privacy wire v2 on, the bar not live (an older Pepe): exactly the wave 2 page
  assert.equal(render(now, { privwire: PWON, policyDates: TXD, chatlog: CLOC }), render(now, { privwire: PWON, txbar: null, policyDates: TXD, chatlog: CLOC }));
  const noBar = render(now, { privwire: PWON, policyDates: DATES, chatlog: CLOC });
  for (const s of TXB_SENTENCES) assert.ok(!noBar.includes(s.trim().slice(0, 60)), "no bar: " + s.slice(0, 50));
  assert.ok(noBar.includes("<code>!transcripts off</code> leaves your mic transcripts out."), "no bar: the wave 2 sentence");
  // the switch off: whatever txbar says, the switch-off page (byte-identical - the first test compares it with 119e948b)
  assert.equal(render(now, { txbar: { on: true }, policyDates: TXD, chatlog: CLOC }), render(now, { policyDates: TXD, chatlog: CLOC }));
  assert.equal(render(now, { txbar: { on: true } }), render(now, {}));
});

test("transcripts bar: terms.js dates it by policy_text_dates 'tx-bar' while privwire.txBar, passes locals.txbar, and its date counts only while shown", () => {
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /const TEXT_DATES = \["wp1-voice", "mic-stage-keep", "tx-bar", "frog-15", "livecam-never-kept", "stage-cover", "rooms-web-2", "net-bans", "blocks-2", "chat-mentions", "gift-inbox", "net-bans-2"\];/);   // (1.99aid privacy controls S0: + livecam-never-kept; 1.99aih round 6: + stage-cover; 1.99ajn padppl: + rooms-web-2, net-bans, blocks-2, chat-mentions; audiogate2: + net-bans-2)
  assert.match(src, /"tx-bar": \(\) => require\("\.\/privwire"\)\.txBar\(\) === true/);
  // (review fix F1: "live" while privwire.txBar, "kept" while it isn't but bars it made are still kept - privwire.txTextNow)
  assert.match(src, /const m = privwire \? await PWm\.txTextNow\(\) : null;/);
  assert.match(src, /txbar = m === "live" \? \{ on: true \} : m === "kept" \? \{ kept: true, \.\.\.\(PWm\.txOff\(\) \|\| \{\}\) \} : null;/);
  assert.match(src, /\[txbar && txbar\.kept && txbar\.off_at, txbar && txbar\.kept && txbar\.off_day\]/);
  assert.match(src, /filter\(\(\[k\]\) => k !== "tx-bar" \|\| txbar\)/);
  assert.match(src, /memory, txbar, privwire, evidence, policyDates \}\)/);
});

// 1.99aht transcripts bar review fix (F1): the bar no longer live (a Pepe without it - a bot rollback, any sync without txbar_cap) while
// bars it made are still kept and revealable (privwire.txKept): terms.js passes locals.txbar = {kept, off_at, off_day} and the page says
// new mic transcripts are left out AND the ones already shown as a bar stay bars, with a change note dated by when the bar stopped. The
// owner approves this wording before it ships - these are the exact sentences.
const TXB_KEPT = [
  " <code>!transcripts off</code> leaves your mic transcripts out; the ones already shown as a blacked-out bar stay that way, and administrators and the pad's owner can reveal those too.",
  "<code>!transcripts off</code> leaves your mic transcripts out. The ones already shown as a blacked-out bar are kept like hidden lines: never searched or quoted, and only the pad's owner and PATV administrators can reveal what you said.",
  "<li><b><code>!transcripts off</code> leaves your mic transcripts out.</b> Mic turns that already show on the website as a blacked-out bar stay that way: only PATV administrators and a pad's owner (in their own pad, for lines said while they own it) can reveal what you said, and every reveal is logged.</li>",
  "<li><b>4 November 2026:</b> <code>!transcripts off</code> (sections 3 and 10): new mic transcripts are left out of the website again; the ones already shown as a blacked-out bar stay that way.</li>",
];
test("transcripts bar review fix F1: the bar no longer live but bars it made kept - the kept sentences and a dated note; switch off: the page as before", () => {
  const now = fs.readFileSync(FILE, "utf8");
  const PWON = { on: true, g: 1793534400000, g_day: "1 November 2026" };
  const TXD = Object.assign({}, DATES, { "tx-bar": { at: 1793700000000, day: "3 November 2026" } });
  const CLOC = { notice_day: "1 October 2026", start_day: "8 October 2026" };
  const KEPT = { kept: true, off_at: 1793800000000, off_day: "4 November 2026" };
  const page = render(now, { privwire: PWON, txbar: KEPT, policyDates: TXD, chatlog: CLOC });
  for (const s of TXB_KEPT) assert.equal(page.split(s).length, 2, "once: " + s.slice(0, 70));
  for (const i of [0, 1, 2, 3, 4]) assert.ok(!page.includes(TXB_SENTENCES[i]), "no 'live' sentence: " + TXB_SENTENCES[i].slice(0, 60));
  assert.ok(page.includes(TXB_SENTENCES[5]), "the dated note of when the bar started stays (history)");
  assert.ok(page.indexOf(TXB_KEPT[3]) < page.indexOf(TXB_SENTENCES[5]), "the kept note first (newest)");
  assert.ok(!page.includes("<code>!transcripts off</code> leaves your mic transcripts out. Lines said before"), "never wave 2's bare sentence while bars are kept");
  assert.ok(!render(now, { privwire: PWON, txbar: KEPT, policyDates: TXD, chatlog: CLOC, evidence: { on: true, any: true, on_at: 1793600000000, on_day: "2 November 2026" } })
    .includes(TXB_EVIDENCE[0].replace("</li>", "")), "kept: no 'can save one as evidence' in the bullet (new turns aren't masked then; the dated note keeps its clause)");
  // no date for when it stopped (its meta row lost): no kept note, the rest as above
  const undated = render(now, { privwire: PWON, txbar: { kept: true }, policyDates: TXD, chatlog: CLOC });
  assert.ok(!undated.includes(TXB_KEPT[3].slice(30)) && undated.includes(TXB_KEPT[1]), "undated: no kept note");
  // the switch off: the switch-off page, whatever txbar says (byte-identical - the first test compares it with 119e948b)
  assert.equal(render(now, { txbar: KEPT, policyDates: TXD, chatlog: CLOC }), render(now, { policyDates: TXD, chatlog: CLOC }));
  assert.equal(render(now, { txbar: KEPT }), render(now, {}));
});

test("transcripts bar review fix F1: /help - the bar no longer live but bars kept: the transcripts card says the shown ones stay bars", () => {
  const H = require(path.join(repo, "help"));
  const PW = require(path.join(repo, "privwire"));
  const on = PW.isOn, tb = PW.txBar, tk = PW.txKept;
  PW.isOn = () => true; PW.txBar = () => false; PW.txKept = () => true;
  try {
    const out = H.withPrivwireNotes([{ id: "transcripts", summary: "off", v2: { details: "Pepe's v2 words." }, v2tx: { summary: "bar words" } }, { id: "dice", summary: "roll" }]);
    assert.equal(out[0].details, "Pepe's v2 words.\n\nMic turns that already show on the website as a blacked-out bar stay that way: only PATV administrators, and a pad's owner in their own pad, can reveal what you said, and every reveal is logged.");
    assert.equal(out[0].summary, "off", "v2tx (the live wording) isn't used");
    assert.equal(out[1].summary, "roll");
    PW.txKept = () => false;
    assert.equal(H.withPrivwireNotes([{ id: "transcripts", summary: "off", v2: { details: "Pepe's v2 words." } }])[0].details, "Pepe's v2 words.", "none kept: wave 2's card");
    PW.isOn = () => false; PW.txKept = () => true;
    const cards = [{ id: "transcripts", summary: "off" }];
    assert.equal(H.withPrivwireNotes(cards), cards, "the switch off: byte-equal, the same objects");
  } finally { PW.isOn = on; PW.txBar = tb; PW.txKept = tk; }
});
