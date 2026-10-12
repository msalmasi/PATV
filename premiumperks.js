// premiumperks.js — THE perk table of the three paid tiers (1.99tc): 📺 Prime Time, 💎 Prime Time Plus, 🎟️ Season Pass.
//
// Every place that lists what a tier gets (/premium, /subscriptions, the pad settings' Pad tier card, the owner panel)
// renders THIS list through views/partials/tier-perks.ejs, so the lists can't drift apart. The numbers come from where
// the perk is enforced, never from copy:
//   premium.js config     stage slots, badge slots, soundboard slots per tier, Plus spots, upload multiplier, sticker packs
//   premium.retention()   chat-log / recording / PM windows - Pepe reports his live retention.json with every owner sync
//   soundboards.config()  the Season Pass's free soundboard packs a month, and whether soundboards are on at all
//   padflair.js           flair slots (normal / Plus)
//   stickers.json         the Season Pass's seasonal perk packs (🎃 Spooky Season ...) and the Plus pack
//   mainstage room_rtc    whether low-latency room audio is live for Prime Time pads yet
//
// A perk is {id, icon, title: [key, vars], desc: [key, vars], live}. `live: false` = announced, not built yet ("soon").
// Text lives in locales/en.json (premium.* for the original perks, perks.* for 1.99tc's). Windows ({chat}, {rec}, {pm})
// are pre-rendered by win() with the caller's t (the partial does it), so a value of null reads "for good".
"use strict";

const safe = (fn, d) => { try { const v = fn(); return v === undefined || v === null ? d : v; } catch (e) { return d; } };
const P = () => require("./premium");

/** Everything the table reads, in one object (tests feed their own). */
function values() {
  const C = safe(() => P().config(), {}), D = safe(() => P().DEFAULTS, {});
  const num = (k) => (Number.isFinite(Number(C[k])) ? Number(C[k]) : Number(D[k]) || 0);
  const sb = safe(() => require("./soundboards").config(), {});
  const fl = safe(() => require("./padflair"), {});
  const stk = (perk) => safe(() => require("./stickers").perkPacks(perk), []);
  const rtc = safe(() => require("./mainstage").config().room_rtc, "off");
  return {
    prime_extra_slots: num("prime_extra_slots"), prime_extra_badges: num("prime_extra_badges"),
    sb_slots_free: num("sb_slots_free"), sb_slots_prime: num("sb_slots_prime"), sb_slots_plus: num("sb_slots_plus"),
    ptplus_max_rooms: num("ptplus_max_rooms"), sp_upload_mult: num("sp_upload_mult"), sp_sticker_packs: num("sp_sticker_packs"),
    retention: safe(() => P().retention(), safe(() => ({ ...P().RETENTION_DEFAULTS }), {})),
    sb_on: sb.enabled !== false, sb_sp_packs: Number.isFinite(Number(sb.sp_packs)) ? Number(sb.sp_packs) : 1,
    flairs: Number(fl.MAX_FLAIRS) || 25, flairs_plus: Number(fl.MAX_FLAIRS_PLUS) || 50,
    sp_seasonal: stk("season_pass").filter((p) => p.season),
    lowlat_live: rtc === "prime" || rtc === "all",
  };
}

const perk = (id, icon, title, desc, live = true) => ({ id, icon, title: Array.isArray(title) ? title : [title, {}], desc: Array.isArray(desc) ? desc : [desc, {}], live: !!live });

/** {prime_time: [...], prime_plus: [...], season_pass: [...]} for the values v (default: the live ones). */
function table(v = values()) {
  const R = v.retention || {};
  const W = (k) => ({ win: R[k] === undefined ? null : R[k] });      // pre-rendered by the partial (win())
  const seasonal = (v.sp_seasonal || []).map((p) => `${p.emoji} ${p.name}` + (p.season && p.season.label ? ` (${p.season.label})` : ""));
  const prime_time = [
    perk("badge", "📺", "premium.pt.badge", "premium.pt.badge_d"),
    perk("theme", "🖼️", "premium.pt.theme", "premium.pt.theme_d"),
    perk("intro", "🎬", "premium.pt.intro", "premium.pt.intro_d"),
    perk("badge_slots", "🏷️", ["premium.pt.badge_slots", { n: v.prime_extra_badges }], ["premium.pt.badge_slots_d", { n: 3 + v.prime_extra_badges }]),
    perk("stage_slots", "🎤", ["premium.pt.stage_slots", { n: v.prime_extra_slots }], "premium.pt.stage_slots_d"),
    perk("retention", "🗄️", ["perks.pt.retention", { chat: W("chat_prime"), rec: W("rec_prime") }],
         ["perks.pt.retention_d", { chat: W("chat_prime"), rec: W("rec_prime"), none: W("chat_days"), none_rec: W("rec_days") }]),
    perk("soundboard", "🔊", ["perks.pt.soundboard", { n: v.sb_slots_prime }], ["perks.pt.soundboard_d", { plus: v.sb_slots_plus }], v.sb_on && v.sb_slots_prime > 0),
    perk("lowlat", "⚡", "premium.pt.lowlat", v.lowlat_live ? "perks.pt.lowlat_live_d" : "premium.pt.lowlat_d", v.lowlat_live),
    perk("longer", "⏱️", "premium.pt.longer", "premium.pt.longer_d", false),
    perk("vault", "🏦", "premium.pt.vault", "premium.pt.vault_d", false),
    perk("sticker", "🧸", "premium.pt.sticker", "premium.pt.sticker_d", false),
    perk("analytics", "📈", "premium.pt.analytics", "premium.pt.analytics_d", false),
  ];
  const prime_plus = [
    perk("all_pt", "📺", "premium.pp.all_pt", "perks.pp.all_pt_d"),
    perk("intro", "💎", "perks.pp.intro", "perks.pp.intro_d"),
    perk("room", "🌉", ["perks.pp.room", { n: v.ptplus_max_rooms }], "premium.pp.room_d"),
    perk("retention", "🗄️", ["perks.pp.retention", { chat: W("chat_plus"), rec: W("rec_plus") }],
         ["perks.pp.retention_d", { chat: W("chat_plus"), rec: W("rec_plus"), none: W("chat_days") }]),
    perk("soundboard", "🔊", ["premium.pp.soundboard", { n: v.sb_slots_plus }], ["premium.pp.soundboard_d", { pt: v.sb_slots_prime }], v.sb_on && v.sb_slots_plus > 0),
    perk("stickers", "🧸", "premium.pp.stickers", "premium.pp.stickers_d"),
    perk("cosmetics", "✨", "premium.pp.cosmetics", "perks.pp.cosmetics_d"),
    perk("badge", "💠", "perks.pp.badge", "perks.pp.badge_d"),
    perk("flair", "🏷️", ["perks.pp.flair", { n: v.flairs_plus }], ["perks.pp.flair_d", { n: v.flairs_plus, free: v.flairs }]),
  ];
  const season_pass = [
    perk("name", "🌈", "premium.sp.name", "premium.sp.name_d"),
    perk("ring", "💫", "premium.sp.ring", "premium.sp.ring_d"),
    perk("banner", "🏞️", "premium.sp.banner", "premium.sp.banner_d"),
    perk("chip", "🎟️", "premium.sp.chip", "premium.sp.chip_d"),
    perk("stickers", "🧸", ["premium.sp.stickers", { count: v.sp_sticker_packs }], "premium.sp.stickers_d", v.sp_sticker_packs > 0),
    ...(seasonal.length ? [perk("seasonal", (v.sp_seasonal[0] && v.sp_seasonal[0].emoji) || "🎃", ["perks.sp.seasonal", { packs: seasonal.join(", ") }], "perks.sp.seasonal_d")] : []),
    perk("uploads", "📤", ["premium.sp.uploads", { n: v.sp_upload_mult }], "premium.sp.uploads_d"),
    perk("sb_season", "🔊", "perks.sp.sb_season", "perks.sp.sb_season_d", v.sb_on),
    perk("sb_pack", "🎁", ["perks.sp.sb_pack", { count: v.sb_sp_packs }], "perks.sp.sb_pack_d", v.sb_on && v.sb_sp_packs > 0),
    perk("sb_priority", "⏩", "perks.sp.sb_priority", "perks.sp.sb_priority_d", v.sb_on),
    perk("pm_logs", "🔒", ["perks.sp.pm", { pm: W("pm_pass") }], ["perks.sp.pm_d", { pm: W("pm_pass"), none: W("pm_days") }]),
    perk("telegram", "✈️", "perks.sp.telegram", "perks.sp.telegram_d"),
    perk("flair", "🎨", "premium.sp.flair", "premium.sp.flair_d", false),
    perk("priority", "🐸", "premium.sp.priority", "premium.sp.priority_d", false),
  ];
  return { prime_time, prime_plus, season_pass };
}

/** A retention window as words: null -> "for good", whole years -> "for N year(s)", else "for N day(s)". */
function win(t, days) {
  if (days === null || days === undefined) return t("perks.win.forever");
  const n = Number(days);
  if (n % 365 === 0) return t("perks.win.years", { count: n / 365 });
  return t("perks.win.days", { count: n });
}
/** [key, vars] -> text with t; {win} vars become words. */
function text(t, pair) {
  const [key, vars] = pair;
  const out = {};
  for (const [k, x] of Object.entries(vars || {})) out[k] = x && typeof x === "object" && "win" in x ? win(t, x.win) : x;
  return t(key, out);
}

module.exports = { values, table, win, text };
