// Offline tests for 1.99tc: THE perk table (premiumperks.js) behind every tier perk list, Pepe's retention windows
// (premium.cleanRetention / noteRetention), and the shared partial (views/partials/tier-perks.ejs).
//   NODE_PATH=G:/PATV/node_modules node --test test/premiumperks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perks-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const ejs = require("ejs");
const PK = require(path.join(repo, "premiumperks"));
const PR = require(path.join(repo, "premium"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const t = new Function(fs.readFileSync(path.join(repo, "i18n-core.js"), "utf8"))()(en);
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("the table reads the live config: slots, retention, soundboard, flair, seasonal stickers", () => {
  const v = PK.values();
  const T = PK.table(v);
  const C = PR.config();
  const byId = (tier, id) => T[tier].find((p) => p.id === id);
  assert.deepEqual(byId("prime_time", "stage_slots").title, ["premium.pt.stage_slots", { n: C.prime_extra_slots }]);
  assert.deepEqual(byId("prime_time", "soundboard").title[1], { n: C.sb_slots_prime });
  assert.deepEqual(byId("prime_plus", "soundboard").title[1], { n: C.sb_slots_plus });
  assert.deepEqual(byId("prime_plus", "room").title[1], { n: C.ptplus_max_rooms });
  assert.equal(byId("prime_plus", "flair").title[1].n, require(path.join(repo, "padflair")).MAX_FLAIRS_PLUS);
  assert.equal(byId("season_pass", "sb_pack").title[1].count, require(path.join(repo, "soundboards")).config().sp_packs);
  const seasonal = byId("season_pass", "seasonal");
  assert.ok(seasonal && /Spooky Season \(Halloween\)/.test(seasonal.title[1].packs), "the 🎃 Season Pass stickers from stickers.json");
  for (const id of ["retention", "intro", "badge", "cosmetics", "stickers"]) assert.ok(byId("prime_plus", id), "plus: " + id);
  for (const id of ["sb_season", "sb_priority", "pm_logs", "telegram", "uploads"]) assert.ok(byId("season_pass", id), "season pass: " + id);
  // 1.99aak: live cams per viewer - the Season Pass line carries livecam.js's caps (pad tiers don't change them)
  const lc = byId("season_pass", "livecams");
  const LCc = require(path.join(repo, "livecam")).current().cfg;
  assert.ok(lc, "season pass: livecams");
  assert.deepEqual(lc.title[1], { n: LCc.viewers_sp });
  assert.deepEqual(lc.desc[1], { n: LCc.viewers_sp, free: LCc.viewers_free });
  assert.match(t(lc.title[0], lc.title[1]), /Watch 4 live cams at once/);
  assert.ok(!byId("prime_time", "livecams") && !byId("prime_plus", "livecams"), "no pad-tier live-cam perk");
  // every key the table uses exists in en.json
  for (const tier of Object.keys(T)) for (const p of T[tier]) for (const [k] of [p.title, p.desc]) assert.ok(k in en, k);
});

test("retention windows: Pepe's defaults, words, and his report cleaned", () => {
  // (an older Pepe's report: no audio windows - "mic recordings" are his transcript windows, as before)
  const T = PK.table({ ...PK.values(), retention: PR.cleanRetention({ ...PR.RETENTION_DEFAULTS, rec_prime: 365, audio_days: undefined, audio_prime: undefined, audio_plus: undefined }) });
  const pt = T.prime_time.find((p) => p.id === "retention"), pp = T.prime_plus.find((p) => p.id === "retention");
  assert.equal(strip(PK.text(t, pt.title)), "Chat logs kept for good, mic recordings for 1 year");
  assert.match(strip(PK.text(t, pt.desc)), /chat logs for 30 days, recordings for 30 days/);
  assert.equal(strip(PK.text(t, pp.title)), "Chat logs and mic recordings kept for good");
  const sp = T.season_pass.find((p) => p.id === "pm_logs");
  assert.equal(strip(PK.text(t, sp.title)), "Your PM / DM logs kept for good");
  assert.equal(PK.win(t, 730), "for 2 years");
  assert.equal(PK.win(t, 1), "for 1 day");
  const c = PR.cleanRetention({ chat_days: 14, rec_prime: null, pm_days: 0, chat_plus: "x", bogus: 5 });
  assert.deepEqual([c.chat_days, c.rec_prime, c.pm_days, c.chat_plus, "bogus" in c], [14, null, 30, null, false]);
  const T2 = PK.table({ ...PK.values(), retention: { ...PR.RETENTION_DEFAULTS, rec_prime: 90 } });
  assert.equal(strip(PK.text(t, T2.prime_time.find((p) => p.id === "retention").title)), "Chat logs kept for good, mic recordings for 90 days");
});

test("mic retention: once Pepe reports the audio windows, the recordings perk names them and mic transcripts follow chat - the new wording only while the policy switch is on", () => {
  // the owner's numbers (option C): no tier 30 days, Prime Time 180, Plus for good; transcripts = chat on every tier (his split on)
  const R = PR.cleanRetention({ chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null,
                                audio_days: 30, audio_prime: 180, audio_plus: null, pm_days: 30, pm_pass: null, split: true });
  assert.equal(R.audio_reported, true);
  assert.deepEqual([PR.RETENTION_DEFAULTS.audio_days, PR.RETENTION_DEFAULTS.audio_prime, PR.RETENTION_DEFAULTS.audio_plus, PR.RETENTION_DEFAULTS.rec_prime],
                   [30, 180, null, null], "the site's defaults before a report: option C, transcripts follow chat");
  assert.equal(PR.cleanRetention({ chat_days: 30 }).audio_reported, false, "an older Pepe's report has no audio windows");
  assert.equal(PR.cleanRetention({ audio_days: 30, audio_prime: 0, audio_plus: null }).audio_reported, false, "an invalid window isn't a report of them");
  assert.equal(PK.values().micrec_on, false, "the switch ships off");
  // the mic-recordings policy switch ON (the owner approved the text): the audio windows, Plus's grace
  const T = PK.table({ ...PK.values(), retention: R, micrec_on: true });
  const pt = T.prime_time.find((p) => p.id === "retention"), pp = T.prime_plus.find((p) => p.id === "retention");
  assert.equal(strip(PK.text(t, pt.title)), "Chat logs and mic transcripts kept for good, mic recordings for 180 days");
  assert.match(strip(PK.text(t, pt.desc)), /chat logs and transcripts for 30 days, recordings for 30 days/);
  assert.equal(strip(PK.text(t, pp.title)), "Chat logs, mic transcripts and mic recordings kept for good");
  assert.match(strip(PK.text(t, pp.desc)), /while the pad has Prime Time Plus, and 30 days after/);
  // review: the switch OFF with his split on - no new claim, and not the old one either (it would say recordings "for good" on Prime
  // Time: the transcript window is chat's now): chat logs and mic transcripts only
  const TS = PK.table({ ...PK.values(), retention: R, micrec_on: false });
  const pts = TS.prime_time.find((p) => p.id === "retention"), pps = TS.prime_plus.find((p) => p.id === "retention");
  assert.equal(strip(PK.text(t, pts.title)), "Chat logs and mic transcripts kept for good");
  assert.equal(strip(PK.text(t, pps.title)), "Chat logs and mic transcripts kept for good");
  for (const p of [pts, pps]) {
    assert.doesNotMatch(strip(PK.text(t, p.title)) + " " + strip(PK.text(t, p.desc)), /recording|30 days after/i, "no recordings claim while the switch is off");
  }
  // the bot's split rule off (as 1.99afq ships): transcripts and recordings both follow rec_* (audio_* = rec_*) - the old text, true -
  // whatever the switch (review: Plus no longer turns to the new wording when its windows happen to match)
  const OFF = PR.cleanRetention({ chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: 365, rec_plus: null,
                                  audio_days: 30, audio_prime: 365, audio_plus: null, pm_days: 30, pm_pass: null, split: false });
  assert.deepEqual([OFF.audio_reported, OFF.split], [true, false]);
  const TO = PK.table({ ...PK.values(), retention: OFF });
  assert.equal(strip(PK.text(t, TO.prime_time.find((p) => p.id === "retention").title)), "Chat logs kept for good, mic recordings for 1 year");
  assert.deepEqual(TO.prime_plus.find((p) => p.id === "retention").title[0], "perks.pp.retention", "Plus: today's key while the switch is off");
  // Plus keeping recordings shorter than chat: the two windows apart
  const T2 = PK.table({ ...PK.values(), retention: { ...R, audio_plus: 365 }, micrec_on: true });
  assert.equal(strip(PK.text(t, T2.prime_plus.find((p) => p.id === "retention").title)), "Chat logs and mic transcripts kept for good, mic recordings for 1 year");
  for (const TT of [T, TS, TO]) for (const tier of Object.keys(TT)) for (const p of TT[tier]) for (const [k] of [p.title, p.desc]) assert.ok(k in en, k);
});

test("status follows the switches: low latency, soundboards off", () => {
  const v = PK.values();
  assert.equal(PK.table({ ...v, lowlat_live: true }).prime_time.find((p) => p.id === "lowlat").live, true);
  assert.equal(PK.table({ ...v, lowlat_live: false }).prime_time.find((p) => p.id === "lowlat").live, false);
  const off = PK.table({ ...v, sb_on: false });
  assert.equal(off.season_pass.find((p) => p.id === "sb_season").live, false);
  assert.equal(PK.table({ ...v, sp_seasonal: [] }).season_pass.some((p) => p.id === "seasonal"), false, "no seasonal packs -> no line");
});

test("the partial renders the shared list (full + compact + skip)", async () => {
  const file = path.join(repo, "views", "partials", "tier-perks.ejs");
  const locals = { i18nT: t, perkTable: () => PK.table(), perkText: PK.text };
  const full = await ejs.renderFile(file, { ...locals, tier: "prime_plus" });
  assert.match(full, /data-perk="intro"/);
  assert.match(strip(full), /Its own intro: the PRIME TIME PLUS title card/);
  assert.match(strip(full), /A diamond-and-gold title card/);
  const compact = await ejs.renderFile(file, { ...locals, tier: "prime_plus", compact: true, skip: ["all_pt"] });
  assert.doesNotMatch(compact, /data-perk="all_pt"/);
  assert.doesNotMatch(strip(compact), /A diamond-and-gold title card/, "compact = titles only");
  const pad = await ejs.renderFile(path.join(repo, "views", "partials", "pad-tier-perks.ejs"), { ...locals, padTier: "prime_time" });
  assert.match(strip(pad), /This pad has 📺 Prime Time/);
  assert.match(strip(pad), /Prime Time Plus adds/);
});
