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
  const T = PK.table(PK.values());
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
