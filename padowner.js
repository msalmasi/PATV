// padowner.js — the room owner's Pepe control panel (1.99qr): /p/<slug>/owner, for a pad's owner (and site staff).
//
// One dashboard for running a Camfrog room with Pepe, each card with a plain-language explanation:
//   * 🏦 Room vault   balance, 7-day inflow / deposits / paid out, the day-by-day table and the latest moves (roomvaults.js
//                     card), and TOP UP: POST /api/rooms/:slug/vault/topup {amount, idem} queues the website action
//                     "roomvault.deposit" = exactly `!roomvault deposit <amount>` as the account's linked Camfrog login
//                     (1.99uu: no Camfrog name linked = from the PATV account itself; every pad has a vault, connected or not)
//                     (camfrog-bot pepe_roomowner._op_web_deposit -> pepe_roomvault._rv_deposit: escrow hold -> settle,
//                     min deposit, cap, journaled, never counted as inflow). KEYED: the form's one-time key (idem) makes a
//                     double click one deposit (actions.js unique (user, idem) + Pepe's webactions.json journal).
//   * 👑 Owner share  E-4: what the owner earned from the room vault's payout recipe (recipe.earned), the eligibility (presence
//                     and active days of the last payout day), the cap; the old royalties (royalties.status) folded underneath,
//                     closed once the cutover froze them
//   * 💸 Payout recipe the last 7 payout days: budget, what each slice paid, what stayed (roomvaults.card().recipe)
//   * 📺 Prime Time   the pad tier's status, when it ends, renewing (premium.state)
//   * 🎬 Stage        slots, featured stream, what's next, requests waiting (mainstage.roomStage / ownerState) - run on the
//                     settings hub's Stage tab
//   * 🐸 Pepe         the room's Pepe settings: what the OWNER may change (snap, clip, mic challenges, Pepe's language -
//                     website action "room.owner", pepe_roomowner._op_web_setting, the same storage as the chat commands),
//                     the website-bridge switches (the existing /api/rooms/:slug/bridge, roomsweb.js), and - read-only -
//                     everything else Pepe runs in the room (!say, music, DJ, games, casino backend, greeter, chatty,
//                     prices) with who controls it. Pepe reports these with his owner-map sync every 2 minutes
//                     (POST /api/rooms/owners `room_settings`, stored here in room_pepe_settings).
//                     1.99tn: + the pad's DEFAULT VOICE (room_voice: only voices the pad's owner owns - voicestore.roomVoices,
//                     checked here, by Pepe on the action and by Pepe at every line; a lost voice falls back to Pepe's
//                     default), conversation starters (convo + convo_quiet) and the audit's room switches (captions,
//                     alerts, dj_talk). The audit table: docs/pads-ownership-connections.md "Owner panel: Pepe's room settings".
//                     1.99up: + the ROOM TOPIC (POST /api/rooms/:slug/owner/topic -> website action "room.topic": length,
//                     textguard.js, never a pad verify code, TOPIC_MAX_HOUR an hour; Pepe re-checks all of it, keeps a pending
//                     code that's in the topic, and pauses the room's auto-topic), the AUTO-TOPIC (autotopic on/off,
//                     autotopic_every inside the admins' floor) and the room's SPEECH-TO-TEXT language (stt_language:
//                     default / auto / a code - the transcriber's language hint for that room's mic clips; NOT the
//                     "language" setting, which is the language Pepe chats in, 1.99jl).
//                     1.99vc: + Pepe's SPEAKING language (tts_language: default / auto / a code - sent with every TTS request
//                     for the room; a fixed language the room's voice can't speak falls back to English and the page says
//                     so, from Pepe's `tts` report) and the admins' MASTER SWITCHES (camfrog-bot pepe_cmdswitch, site
//                     cmdswitch.js): a setting whose master is off is in Pepe's `masters_off` and shows disabled with
//                     "Switched off by PATV admins" - the owner's own value is kept, and Pepe refuses a change to it.
//   * 🌐 Pepe on your pad's page   1.99up, padsite.js: his posts / comments / feed moderation on the pad's site side, for
//                     any pad (site-applied, inherit-with-reset, the safety floor) - POST /api/rooms/:slug/owner/site
//   * ❓ What you can do with Pepe in your room   data/owner-capabilities.json, GENERATED from Pepe's code by camfrog-bot
//                     tools/build_owner_caps.py (every owner check in the bot is listed or explicitly excluded), plus the
//                     website's owner controls (WEB_CAPS below - each names its real route, test/padowner.test.js checks
//                     every one is registered). Also public at /pads/owner-guide.
// Every write goes through an existing endpoint or a website action Pepe re-checks; nothing here grants anything new.
"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

// 1.99tf: every room-scoped Pepe setting the OWNER may change (camfrog-bot pepe_roomowner.OWNER_SPECS - Pepe re-checks each).
// The page groups them; each is read back from Pepe's own report, never assumed.
const ONOFF = ["on", "off"];
const OWNER_BOOL = Object.freeze(["snap", "clip", "challenge", "soundboard", "global_unblock", "greeter", "music", "music_requests",
  "trivia", "pictionary", "heist", "wheel", "bingo", "pvp", "casino", "say", "voices", "mic_replies", "michog", "votes", "vibe_lock",
  "convo", "captions", "alerts", "dj_talk",                          // 1.99tn: + conversation starters and the audit's room switches
  "autotopic"]);                                                    // 1.99up: the room's auto-topic
// 1.99tn: conversation starters' quiet time (pepe_convo convo_quiet_min, 5-240 min) - the page's choices
const CONVO_QUIET = Object.freeze([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]);
const VOICE_RE = /^[\w .'\-()]{1,40}$/;
const OWNER_SETTINGS = Object.freeze(Object.assign(Object.fromEntries(OWNER_BOOL.map((k) => [k, ONOFF])), {
  chatty: ["off", "low", "normal", "high"],
  // 1.99uy: how the greeter treats newcomers (a shared, easygoing welcome; text_mic adds a name-free spoken one) and regulars
  // (a short personal hello; mic = sometimes spoken, when the mic is free) - camfrog-bot pepe_greeter greeter_new / greeter_regulars
  greet_new: ["off", "text", "text_mic"],
  greet_regulars: ["off", "text", "mic"],
}));
// 1.99up: the auto-topic's interval choices (pepe_roomowner.AUTOTOPIC_EVERY - Pepe sends his own list in room_choices)
const AUTOTOPIC_EVERY = Object.freeze([15, 20, 30, 45, 60, 90, 120, 180]);
const TOPIC_MAX = 200, TOPIC_MIN = 2, TOPIC_MAX_HOUR = 6;
const TOPIC_HITS = new Map();
const OWNER_GROUPS = Object.freeze([
  ["topic", "🏷️", ["topic", "autotopic", "autotopic_every"]],      // 1.99up
  ["basics", "⚙️", ["snap", "clip", "challenge", "soundboard", "language", "stt_language"]],
  ["pepe", "🐸", ["greeter", "greet_new", "greet_regulars", "greeter_note", "chatty", "convo", "convo_quiet", "music", "music_requests", "dj_talk", "say", "voices", "mic_replies"]],
  ["voice", "🗣️", ["room_voice", "tts_language", "captions", "alerts"]],   // 1.99tn; 1.99vc: + the speaking language
  ["games", "🎲", ["trivia", "pictionary", "heist", "wheel", "bingo", "pvp", "casino"]],
  ["mod", "🛡️", ["global_unblock", "michog", "strikes", "votes"]],
  ["vibe", "🎭", ["vibe", "roasts", "vibe_lock"]],
]);
const OWNER_ICONS = Object.freeze({ snap: "📸", clip: "📹", challenge: "🎤", soundboard: "🔊", language: "🌐", greeter: "👋", greet_new: "🌱", greet_regulars: "🤝", greeter_note: "📝",
  chatty: "💬", music: "🎵", music_requests: "🎶", say: "🗣️", voices: "🎭", mic_replies: "🎙️", trivia: "❓", pictionary: "🎨", heist: "💰",
  wheel: "🎡", bingo: "🔢", pvp: "🥊", casino: "🃏", global_unblock: "🔓", michog: "🎤", strikes: "⚖️", votes: "🗳️", vibe: "🎭",
  roasts: "🔥", vibe_lock: "🔒", room_voice: "🗣️", convo: "💡", convo_quiet: "⏳", captions: "💬", alerts: "📣", dj_talk: "📻",
  topic: "🏷️", autotopic: "🤖", autotopic_every: "⏱️", stt_language: "📝", tts_language: "🌍" });
// what the read-only list ("everything else") must not repeat: the owner's own switches, by report key
const OWNER_COVERS = Object.freeze(new Set(["say", "music", "music_queue", "music_play", "heist", "poker", "blackjack", "wheel", "trivia",
  "duel", "brawl", "arena", "showdown", "pictionary", "mic_flag", "greeter", "chatty"]));
const NOTE_MAX = 160;
const CHOICE_RE = /^[a-z_]{1,24}$/;
const STT_RE = /^[a-z]{2,3}$/;
let CHOICES = { vibe: ["auto"], roasts: ["auto"], chatty: OWNER_SETTINGS.chatty.slice(),
  greet_new: OWNER_SETTINGS.greet_new.slice(), greet_regulars: OWNER_SETTINGS.greet_regulars.slice(), autotopic_every: AUTOTOPIC_EVERY.slice(), stt: [], tts: [] };
function setChoices(c) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => CHOICE_RE.test(String(x))).slice(0, 30).map(String) : []);
  const out = { vibe: list(c && c.vibe), roasts: list(c && c.roasts), chatty: OWNER_SETTINGS.chatty.slice(),
    greet_new: OWNER_SETTINGS.greet_new.slice(), greet_regulars: OWNER_SETTINGS.greet_regulars.slice() };   // 1.99uy
  // 1.99up: the auto-topic's intervals and the transcriber's languages, from Pepe's own lists
  const ev = c && Array.isArray(c.autotopic_every) ? c.autotopic_every.filter((n) => Number.isInteger(n) && n >= 5 && n <= 180).slice(0, 20) : [];
  out.autotopic_every = ev.length ? ev : AUTOTOPIC_EVERY.slice();
  out.stt = c && Array.isArray(c.stt) ? c.stt.filter((x) => Array.isArray(x) && STT_RE.test(String(x[0])))
    .slice(0, 120).map((x) => [String(x[0]), String(x[1] || x[0]).replace(/[<>"&]/g, "").slice(0, 40)]) : [];
  // 1.99vc: the languages Pepe's TTS takes (VoiceBox's list, pepe_roomowner.TTS_LANG_NAMES)
  out.tts = c && Array.isArray(c.tts) ? c.tts.filter((x) => Array.isArray(x) && STT_RE.test(String(x[0])))
    .slice(0, 60).map((x) => [String(x[0]), String(x[1] || x[0]).replace(/[<>"&]/g, "").slice(0, 40)]) : [];
  for (const k of ["vibe", "roasts"]) if (!out[k].length || out[k][0] !== "auto") out[k] = ["auto"].concat(out[k].filter((x) => x !== "auto"));
  CHOICES = out;
  return out;
}
const cleanNote = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
// 1.99qv: Pepe's room languages come with his owner sync (`room_languages` = [[code, English name, native name]], camfrog-bot
// pepe_roomowner._op_languages = pepe_i18n.LANGS) and are kept in room_pepe_meta - nothing hard-coded. Until Pepe has sent
// them the select offers "auto" and the room's current value only (Pepe validates every value again anyway).
const LANG_RE = /^(auto|[a-z]{2,3}(-[a-z]{2,4})?)$/;
let LANGS = [["auto", "Auto (follow the chat)", ""]];
let LANG_CODES = new Set(["auto"]);
function setLanguages(list) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, 80)) {
    if (!Array.isArray(x) || !LANG_RE.test(String(x[0] || ""))) continue;
    out.push([String(x[0]), String(x[1] || x[0]).replace(/[<>"&]/g, "").slice(0, 40), String(x[2] || "").replace(/[<>"&]/g, "").slice(0, 40)]);
  }
  if (!out.length || out[0][0] !== "auto") out.unshift(["auto", "Auto (follow the chat)", ""]);
  LANGS = out;
  LANG_CODES = new Set(out.map((l) => l[0]));
  return out;
}
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
// 1.99up: the owner's room topic - one line, no leading slash; length, textguard.js and never a pad verify code
const cleanTopic = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\/+/, "").trim();
function topicProblem(text) {
  const tg = require("./textguard");
  if (text.length < TOPIC_MIN) return "That's too short for a topic.";
  if (text.length > TOPIC_MAX) return `A topic is at most ${TOPIC_MAX} characters.`;
  if (tg.hasPadCode(text)) return "Pad codes (PATV-...) can't go in the topic through Pepe - type the code into the room's topic yourself in Camfrog.";
  if (tg.bad(text)) return "Pepe won't put that in the topic.";
  return null;
}
const SETTINGS_STALE_MS = 10 * 60 * 1000;          // Pepe re-sends every 2 min; older = he's away
// The website's owner controls (the generated list covers Pepe's side). `route` = METHOD path, checked by the tests.
const WEB_CAPS = Object.freeze([
  { id: "web_vault_topup", area: "vault", route: "POST /api/rooms/:slug/vault/topup", where: "/p/{slug}/owner#vault" },
  { id: "web_vault_rate", area: "vault", route: "POST /api/rooms/:slug/vault/rate", where: "/p/{slug}#vault" },
  { id: "web_pepe_settings", area: "room", route: "POST /api/rooms/:slug/owner/setting", where: "/p/{slug}/owner#pepe" },
  { id: "web_bridge", area: "room", route: "POST /api/rooms/:slug/bridge", where: "/p/{slug}/settings?tab=camfrog" },
  { id: "web_stage_settings", area: "stage", route: "POST /api/rooms/:slug/stage-settings", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_stage_feature", area: "stage", route: "POST /api/stage/slots/:id/feature", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_stage_ban", area: "stage", route: "POST /api/rooms/:slug/ban", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_pepe_feed", area: "feed", route: "POST /api/rooms/:slug/feed/pepe", where: "/p/{slug}/settings?tab=pepe" },
  { id: "web_automod", area: "feed", route: "POST /api/rooms/:slug/automod", where: "/p/{slug}/settings?tab=pepe" },
  { id: "web_golive", area: "stage", route: "POST /api/rooms/:slug/golive", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_prime", area: "tier", route: "GET /premium", where: "/premium?pad={slug}" },
  { id: "web_boost", area: "tier", route: "POST /api/rooms/:slug/boost", where: "/p/{slug}" },
  { id: "web_soundboard", area: "room", route: "POST /api/rooms/:slug/soundboard/clips", where: "/p/{slug}/owner#soundboard" },   // 1.99rh: soundboards.js
  { id: "web_pepe_room", area: "room", route: "POST /api/rooms/:slug/owner/pepe-room", where: "/p/{slug}/owner#pepe" },         // 1.99ti
  { id: "web_room_mod", area: "room", route: "POST /api/rooms/:slug/mod", where: "/p/{slug}/owner#mod" },                       // 1.99ti
  { id: "web_room_topic", area: "room", route: "POST /api/rooms/:slug/owner/topic", where: "/p/{slug}/owner#topic" },          // 1.99up
  { id: "web_pad_site", area: "feed", route: "POST /api/rooms/:slug/owner/site", where: "/p/{slug}/owner#site" },              // 1.99up
  { id: "web_pad_filter", area: "feed", route: "POST /api/rooms/:slug/owner/filter", where: "/p/{slug}/owner#safety" },        // 1.99ux: feedfilter.js
]);
// 1.99ti: Pepe in / out of the pad's Camfrog room (website action "room.ctl" from the owner; Pepe re-checks owner, Plus, his
// 5-room cap, his home room and staging). One per CTL_GAP_MS per pad here too.
const CTL_VERBS = new Set(["join", "leave", "rejoin"]);
const CTL_GAP_MS = 2 * 60 * 1000;
const CTL_LAST = new Map();
const STATES = new Set(["in", "joining", "recovering", "out", "paused"]);
// 1.99tn: owner setting changes per account + pad per SET_WINDOW_MS (staff exempt); Pepe has his own per-room limit
const SET_MAX = 20;
const SET_WINDOW_MS = 60 * 1000;
const SET_HITS = new Map();

/** 1.99tn: the voices this pad's OWNER may make its default voice (voicestore.roomVoices): [{id, display, kind, own}]. */
async function padVoices(R) {
  if (!R || !R.owner || !R.owner.userId) return [];
  const by = await require("./voicestore").roomVoices([R.owner.userId]);
  return by[R.owner.userId] || [];
}
/** 1.99tn: {room id: [voice ids]} for every Camfrog pad with a user owner - rides Pepe's owner sync (POST /api/rooms/owners
 *  answer `owner_voices`), so Pepe re-checks a room's owner-picked voice against the voice store at every line. */
async function ownerVoicesForPepe() {
  const list = rooms.listCached().filter((R) => R && R.owner && R.owner.userId && rooms.platformOf(R.id) === "camfrog");
  const by = await require("./voicestore").roomVoices(list.map((R) => R.owner.userId));
  const out = {};
  for (const R of list) out[R.id] = (by[R.owner.userId] || []).map((v) => v.id).slice(0, 200);
  return out;
}

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery("CREATE TABLE IF NOT EXISTS room_pepe_settings (room_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)")
      .then(() => runQuery("CREATE TABLE IF NOT EXISTS room_pepe_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL)"))
      .then(() => getQuery("SELECT k, v FROM room_pepe_meta WHERE k IN ('languages', 'choices')"))
      .then((rows) => {
        for (const r of rows) {
          try { if (r.k === "languages") setLanguages(JSON.parse(r.v)); else setChoices(JSON.parse(r.v)); } catch (e) { /* keep the fallback */ }
        }
      })
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── Pepe's report ──
const bool = (v) => (typeof v === "boolean" ? v : null);
const ID_RE = /^[A-Za-z0-9_.\- ]{1,120}$/;
function cleanOne(s) {
  const o = s && typeof s === "object" ? s : {};
  const sec = (x, keys) => { const out = {}; const v = x && typeof x === "object" ? x : {}; for (const k of keys) if (bool(v[k]) != null) out[k] = v[k]; return out; };
  // 1.99tf: every owner setting Pepe reports (a key he doesn't report stays absent: the page says so, never guesses)
  const ow = o.owner && typeof o.owner === "object" ? o.owner : {};
  const owner = sec(ow, OWNER_BOOL);
  const lang = typeof ow.language === "string" ? ow.language.toLowerCase() : "auto";
  owner.language = LANG_RE.test(lang) ? lang : "auto";
  if (OWNER_SETTINGS.chatty.includes(ow.chatty)) owner.chatty = ow.chatty;
  for (const k of ["greet_new", "greet_regulars"]) if (OWNER_SETTINGS[k].includes(ow[k])) owner[k] = ow[k];   // 1.99uy
  for (const k of ["vibe", "roasts"]) if (typeof ow[k] === "string" && CHOICE_RE.test(ow[k])) owner[k] = ow[k];
  if (Number.isInteger(ow.strikes) && ow.strikes >= 1 && ow.strikes <= 10) owner.strikes = ow.strikes;
  if (typeof ow.greeter_note === "string") owner.greeter_note = cleanNote(ow.greeter_note);
  // 1.99tn: the pad's default voice ("default" = Pepe's) and the starters' quiet time, as Pepe reports them
  if (typeof ow.room_voice === "string" && (ow.room_voice === "default" || VOICE_RE.test(ow.room_voice))) owner.room_voice = ow.room_voice.toLowerCase();
  if (Number.isInteger(ow.convo_quiet) && ow.convo_quiet >= 5 && ow.convo_quiet <= 240) owner.convo_quiet = ow.convo_quiet;
  // 1.99up: the auto-topic's interval ("default" = Pepe's global slider) and the room's STT language
  if (ow.autotopic_every === "default" || (Number.isInteger(ow.autotopic_every) && ow.autotopic_every >= 5 && ow.autotopic_every <= 180)) owner.autotopic_every = ow.autotopic_every;
  if (typeof ow.stt_language === "string" && (ow.stt_language === "default" || ow.stt_language === "auto" || STT_RE.test(ow.stt_language))) owner.stt_language = ow.stt_language;
  if (typeof ow.tts_language === "string" && (ow.tts_language === "default" || ow.tts_language === "auto" || STT_RE.test(ow.tts_language))) owner.tts_language = ow.tts_language;
  const ad = o.admin && typeof o.admin === "object" ? o.admin : {};
  const int = (v, d) => (Number.isInteger(v) && v >= 1 && v <= 10 ? v : d);
  const admin = { soundboard_master: ad.soundboard_master !== false, automod: ad.automod === true, chatty_llm: ad.chatty_llm !== false,
    strike_min: int(ad.strike_min, 2), strike_max: int(ad.strike_max, 5), strike_default: int(ad.strike_default, 3),
    // 1.99up: the auto-topic's master switch + the shortest interval an owner may pick
    autotopic_master: ad.autotopic_master !== false,
    autotopic_min: Number.isInteger(ad.autotopic_min) && ad.autotopic_min >= 5 && ad.autotopic_min <= 180 ? ad.autotopic_min : 30 };
  // 1.99up: the room's topic as Pepe last saw it, the auto-topic's state, the transcriber's language
  const tp = o.topic && typeof o.topic === "object" ? o.topic : null;
  const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const topic = tp ? { text: typeof tp.text === "string" ? tp.text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, TOPIC_MAX) : null,
    paused_until: ms(tp.paused_until), auto: bool(tp.auto), auto_own: bool(tp.auto_own), running: bool(tp.running),
    every_effective: Number.isInteger(tp.every_effective) ? Math.max(1, Math.min(600, tp.every_effective)) : null } : null;
  const sv = o.stt && typeof o.stt === "object" ? o.stt : null;
  const sttCode = (v) => (typeof v === "string" && (v === "auto" || STT_RE.test(v)) ? v : null);
  const stt = sv ? { global: sttCode(sv.global), effective: sttCode(sv.effective), own: bool(sv.own) } : null;
  // 1.99vc: Pepe's speaking language here (pepe_roomowner._op_tts_report) - what the room's voice can speak, any fallback
  const tv = o.tts && typeof o.tts === "object" ? o.tts : null;
  const codes = (v) => (Array.isArray(v) ? v.filter((x) => STT_RE.test(String(x))).slice(0, 40).map(String) : null);
  const tts = tv ? { own: sttCode(tv.own), global: sttCode(tv.global), effective: sttCode(tv.effective),
    voice: typeof tv.voice === "string" && VOICE_RE.test(tv.voice) ? tv.voice : null,
    engine: typeof tv.engine === "string" && /^[a-z_]{1,24}$/.test(tv.engine) ? tv.engine : null,
    supported: codes(tv.supported), fallback: sttCode(tv.fallback) } : null;
  // 1.99vc: the admins' master switches over the owner's settings: {owner key | "br:<x>": the switch's name}
  const masters_off = {};
  if (o.masters_off && typeof o.masters_off === "object" && !Array.isArray(o.masters_off)) {
    for (const [k, v] of Object.entries(o.masters_off).slice(0, 60)) {
      if (/^(br:)?[a-z_]{1,30}$/.test(k)) masters_off[k] = String(v || "").replace(/[\u0000-\u001f<>]/g, " ").slice(0, 80);
    }
  }
  const features = sec(o.features, ["say", "ask", "look", "roast", "camroast", "music", "music_queue", "music_play", "shop", "heist", "turf",
    "poker", "blackjack", "wheel", "trivia", "duel", "brawl", "arena", "showdown", "pictionary", "mic_flag", "cam_flag", "greeter", "chatty",
    "casino_backend", "auto_dj", "kickback", "modfines", "tts"]);
  const prices = {};
  for (const [k, v] of Object.entries(o.prices && typeof o.prices === "object" ? o.prices : {}).slice(0, 30)) {
    if (/^[a-z]{1,20}$/.test(k) && Number.isFinite(Number(v))) prices[k] = Math.max(0, Math.min(1e12, Math.floor(Number(v))));
  }
  // 1.99tn: the room voice as Pepe resolves it (pepe_roomowner._op_voice_report)
  const vo = o.voice && typeof o.voice === "object" ? o.voice : null;
  const vname = (x) => (typeof x === "string" && VOICE_RE.test(x) ? x : null);
  const voice = vo ? { choice: vo.choice === "default" ? "default" : vname(vo.choice), effective: vname(vo.effective), default: vname(vo.default),
    by: vo.by === "owner" || vo.by === "admin" ? vo.by : null, usable: bool(vo.usable), persona: vname(vo.persona), tts: bool(vo.tts) } : null;
  const vibe = o.vibe && typeof o.vibe === "object" ? { type: String(o.vibe.type || "").replace(/[^a-z_ -]/gi, "").slice(0, 24), locked: !!o.vibe.locked } : null;
  // 1.99ti: Pepe's own status for the room (pepe_roomowner._op_status)
  const st = o.status && typeof o.status === "object" ? o.status : null;
  const status = st && STATES.has(st.state) ? {
    state: st.state, joined_at: Number.isFinite(Number(st.joined_at)) && Number(st.joined_at) > 0 ? Math.floor(Number(st.joined_at)) : null,
    rooms: Math.max(0, Math.min(50, Math.floor(Number(st.rooms) || 0))), max: Math.max(1, Math.min(50, Math.floor(Number(st.max) || 5))),
    phase: typeof st.phase === "string" && /^[a-z_]{1,16}$/.test(st.phase) ? st.phase : null,
    home: st.home === true, paused: st.paused === true, staging: st.staging === true,
  } : null;
  return { owner, bridge: sec(o.bridge, ["relay", "mic", "cams", "audio", "transcripts", "cmds"]), bridged: bool(o.bridged), admin, status,
           features, prices, vibe, voice, pepe_here: bool(o.pepe_here), topic, stt, tts, masters_off };
}
/** POST /api/rooms/owners `room_settings` -> the table (the set Pepe sends replaces the rows it names). */
async function storeSettings(raw, languages, choices) {
  await init();
  if (choices && typeof choices === "object" && !Array.isArray(choices)) {
    const c = setChoices(choices);
    await runQuery(`INSERT INTO room_pepe_meta (k, v, updated) VALUES ('choices', ?, ?)
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated`, [JSON.stringify(c), Date.now()]);
  }
  if (Array.isArray(languages) && languages.length) {
    const list = setLanguages(languages);
    await runQuery(`INSERT INTO room_pepe_meta (k, v, updated) VALUES ('languages', ?, ?)
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated`, [JSON.stringify(list), Date.now()]);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  const t = Date.now();
  let n = 0;
  for (const [id, s] of Object.entries(raw).slice(0, 500)) {
    if (!ID_RE.test(id)) continue;
    await runQuery(`INSERT INTO room_pepe_settings (room_id, data, updated) VALUES (?, ?, ?)
                    ON CONFLICT(room_id) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [id, JSON.stringify(cleanOne(s)), t]);
    n++;
  }
  return n;
}
async function settingsFor(roomId) {
  await init();
  const r = (await getQuery("SELECT data, updated FROM room_pepe_settings WHERE room_id = ?", [String(roomId || "")]))[0];
  if (!r) return null;
  let d = null;
  try { d = JSON.parse(r.data); } catch (e) { d = null; }
  return d ? Object.assign(d, { updated: r.updated, stale: Date.now() - r.updated > SETTINGS_STALE_MS }) : null;
}

/** 1.99tf: may the room's soundboard play right now? (the pad's 🔊 drawer) - Pepe's own report: the admins' master switch,
 *  then the room's switch. Unknown (Pepe never reported this room) = on: Pepe refuses at play time anyway. */
async function soundboardState(roomId) {
  const s = await settingsFor(roomId).catch(() => null);
  if (!s) return { on: true, why: null };
  if (s.admin && s.admin.soundboard_master === false) return { on: false, why: "admins" };
  if (s.owner && s.owner.soundboard === false) return { on: false, why: "room" };
  return { on: true, why: null };
}

// ── the generated capability list ──
let CAPS = null;
function capabilities() {
  if (!CAPS) {
    try { CAPS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "owner-capabilities.json"), "utf8")); } catch (e) { CAPS = { capabilities: [], admin_only: [] }; }
  }
  return CAPS;
}

/** "Everything else Pepe runs here": the switches Pepe admins keep (not the owner's) + the prices. */
function readonlyList(pepe) {
  const features = Object.entries(pepe.features || {}).filter(([k]) => !OWNER_COVERS.has(k));
  const prices = Object.entries(pepe.prices || {});
  return { features, prices, count: features.length + prices.length + (pepe.vibe && pepe.vibe.type ? 1 : 0) };
}

/** Everything the owner page shows. */
async function pageData(R, viewer) {
  const web = require("./roomsweb");
  const slug = web.linkSlug(R);
  const camfrog = rooms.platformOf(R.id) === "camfrog";
  const safe = async (fn, d = null) => { try { return await fn(); } catch (e) { console.error("[padowner]", e.message); return d; } };
  // 1.99uu: every pad has a vault (connected to a chat room or not) - the vault, top-up and payout cards show on any pad
  const vaultPad = require("./roomvaults").hasVault(R.id);
  const vault = vaultPad ? await safe(() => require("./roomvaults").card(R.id, viewer, { canManage: true, staff: rooms.isStaff(viewer) })) : null;
  const roy = R.owner && R.owner.userId ? await safe(() => require("./royalties").status(R.id, R.owner.userId)) : null;
  // E-4: what the owner earned from the payout recipe's owner share (recipe.js credits)
  const share = R.owner && R.owner.userId ? await safe(() => require("./recipe").earned(R.id, R.owner.userId, "owner")) : null;
  const prem = await safe(() => require("./premium").state(viewer, slug));
  const stage = await safe(() => require("./mainstage").roomStage(R.id, viewer));
  const ownerStage = await safe(() => require("./mainstage").ownerState(R.id));
  const pepe = camfrog ? await safe(() => settingsFor(R.id)) : null;
  const voices = camfrog ? await safe(() => padVoices(R), []) : [];         // 1.99tn: the room voice's choices
  let live = null;
  try { const B = require("./bridge")._rooms.get(R.id); live = B ? { live: Date.now() - B.updated < 90000, count: B.count || 0 } : null; } catch (e) { live = null; }
  const u = (await getQuery("SELECT camfrogUsername, points_balance FROM users WHERE userId = ?", [viewer.userId]))[0] || {};
  const recent = await safe(() => require("./actions").recentFor(viewer.userId, "owner", 6), []);
  return {
    room: R, slug, camfrog, vaultPad, staff: rooms.isStaff(viewer), mine: !!(R.owner && R.owner.userId === viewer.userId),
    vault, roy, share, prime: prem && prem.pad ? prem.pad : null, primePrice: prem && prem.prices ? prem.prices.prime_time : null,
    primePerks: prem ? prem.perks : null, stage, requested: ownerStage ? ownerStage.requested.length : 0,
    pepe, live, linked: u.camfrogUsername || null, balance: Number(u.points_balance) || 0, recent,
    caps: capabilities(), webCaps: WEB_CAPS, LANGS: pepe && pepe.owner && !LANG_CODES.has(pepe.owner.language)
      ? LANGS.concat([[pepe.owner.language, pepe.owner.language, ""]]) : LANGS,
    CHOICES, GROUPS: OWNER_GROUPS, ICONS: OWNER_ICONS, readonly: pepe ? readonlyList(pepe) : null, VOICES: voices || [], CONVO_QUIET,
    plus: camfrog ? await safe(() => require("./premium").isPrimePlus(R.id), false) : false,
    site: await safe(() => require("./padsite").state(R.id)),          // 1.99up: Pepe on the pad's site side (any pad)
    filter: await safe(() => require("./feedfilter").state(R.id)),     // 1.99ux: the cheap content filter (any pad)
    TOPIC_MAX,
  };
}

/** 1.99ti: the pads this account owns, for the menu's "You" section and their profile: [{slug, title, href}] (cached, sync). */
function myPads(username) {
  const u = String(username || "").toLowerCase();
  if (!u) return [];
  try {
    const web = require("./roomsweb");
    return rooms.listCached().filter((R) => R && R.owner && String(R.owner.username || "").toLowerCase() === u && !R.profile)
      .sort((a, b) => String(a.title).localeCompare(String(b.title))).slice(0, 8)
      .map((R) => { const slug = web.linkSlug(R); return { slug, title: String(R.title || slug).slice(0, 40), href: "/p/" + encodeURIComponent(slug) + "/owner" }; });
  } catch (e) { return []; }
}

function register(app, { addUser }) {
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  if (app.locals) app.locals.myPads = myPads;          // 1.99ti: layout.ejs (You > My pads) + profile.ejs
  require("./padsite").register(app, { addUser });      // 1.99up: Pepe on the pad's site side (padsite.js)
  require("./feedfilter").register(app, { addUser });   // 1.99ux: the cheap content filter (owner card + /feed/admin/filter)
  const jsonOnly = (req, res, next) => (req.is("application/json") && req.get("X-Requested-With") === "fetch" ? next() : bad(res, 400, "Bad request."));
  async function ownedPad(req, res) {
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { bad(res, 404, "No such pad."); return null; }
    if (!(await rooms.canManage(req.user, R.id))) { bad(res, 403, "Only this pad's owner can do that."); return null; }
    if (rooms.platformOf(R.id) !== "camfrog") { bad(res, 400, "This pad has no Camfrog room."); return null; }
    return R;
  }
  // 1.99uu: the vault routes work on every pad (connected or not); the Pepe-in-the-room routes keep ownedPad (Camfrog)
  async function ownedVaultPad(req, res) {
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { bad(res, 404, "No such pad."); return null; }
    if (!(await rooms.canManage(req.user, R.id))) { bad(res, 403, "Only this pad's owner can do that."); return null; }
    if (!require("./roomvaults").hasVault(R.id)) { bad(res, 400, "This pad has no vault yet."); return null; }
    return R;
  }
  const queued = (res, e) => {
    if (e && e.message === "busy") return bad(res, 429, "You already have a few things waiting for Pepe - give him a moment.");
    if (e && e.message === "duplicate") return res.json({ ok: true, id: e.actionId || null, duplicate: true });
    console.error("[padowner]", e);
    return bad(res, 500, "Something went wrong - nothing was sent.");
  };

  // the public "What you can do with Pepe in your room" guide (the same list as the owner page's section)
  app.get("/pads/owner-guide", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.render("padOwner", { user: req.user ? req.user.username : null, guide: true, caps: capabilities(), webCaps: WEB_CAPS, slug: null, room: null });
  });

  app.get("/p/:slug/owner", addUser, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).render("notFound", { user: req.user.username, heading: "No such pad", message: "That pad isn't on PATV.", title: "Pad not found" });
      if (!(await rooms.canManage(req.user, R.id))) {
        return res.status(403).render("notFound", { user: req.user.username, heading: "Not your pad", message: "Only this pad's owner (and site admins) can open its owner panel.", title: "Not your pad" });
      }
      res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "no-store" });
      res.render("padOwner", { user: req.user.username, guide: false, ...(await pageData(R, req.user)) });
    } catch (e) {
      console.error("[padowner] page", e);
      res.status(500).send("Something went wrong.");
    }
  });

  // one owner setting -> website action "room.owner" (Pepe re-checks the owner and writes what the chat command writes)
  app.post("/api/rooms/:slug/owner/setting", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    await init();                                        // Pepe's language list (room_pepe_meta)
    const b = req.body || {};
    const key = String(b.key || "");
    let value = String(b.value == null ? "" : b.value).trim().toLowerCase();
    let ok;
    if (key === "language") ok = LANG_CODES.has(value);
    else if (key === "vibe" || key === "roasts") ok = CHOICES[key].includes(value);
    else if (key === "strikes") {
      const cur = await settingsFor(R.id).catch(() => null);
      const lo = (cur && cur.admin && cur.admin.strike_min) || 2, hi = (cur && cur.admin && cur.admin.strike_max) || 5;
      ok = value === "default" || (/^\d{1,2}$/.test(value) && +value >= lo && +value <= hi);
      if (!ok && /^\d{1,2}$/.test(value)) return bad(res, 400, `Pepe's admins allow ${lo} to ${hi} strikes.`);
    } else if (key === "greeter_note") { value = cleanNote(b.value); ok = true; }
    else if (key === "room_voice") {
      // 1.99tn: ONLY a voice the PAD's owner owns (not the acting staff member's) or "default" - checked here against the
      // voice store, and again by Pepe (pepe_roomowner._op_voice_ok) when it runs and at every line he speaks
      if (value !== "default") {
        const mine = await padVoices(R).catch(() => []);
        if (!mine.some((v) => v.id === value)) return bad(res, 403, "Pick one of the voices you own, or Pepe's default.");
      }
      ok = true;
    } else if (key === "convo_quiet") ok = value === "default" || CONVO_QUIET.includes(Number(value));
    else if (key === "autotopic_every") {
      // 1.99up: one of Pepe's intervals, never under the admins' floor (Pepe re-checks against his own floor)
      const cur = await settingsFor(R.id).catch(() => null);
      const floor = (cur && cur.admin && cur.admin.autotopic_min) || 30;
      ok = value === "default" || (CHOICES.autotopic_every.includes(Number(value)) && Number(value) >= floor);
      if (!ok && /^\d{1,3}$/.test(value) && Number(value) < floor) return bad(res, 400, `Pepe's admins allow every ${floor} minutes at the most often.`);
    } else if (key === "stt_language") {
      // 1.99up: default (Pepe's global setting) / auto / one of the transcriber's languages Pepe sent (he re-checks)
      ok = value === "default" || value === "auto" || CHOICES.stt.some((x) => x[0] === value) || (!CHOICES.stt.length && STT_RE.test(value));
    } else if (key === "tts_language") {
      // 1.99vc: default (Pepe's global) / auto / one of the TTS languages Pepe sent (he re-checks, and the voice's engine)
      ok = value === "default" || value === "auto" || CHOICES.tts.some((x) => x[0] === value) || (!CHOICES.tts.length && STT_RE.test(value));
    }
    else ok = Object.prototype.hasOwnProperty.call(OWNER_SETTINGS, key) && OWNER_SETTINGS[key].includes(value);
    if (!ok) return bad(res, 400, "That isn't a setting you can change here.");
    // 1.99vc: a setting the admins switched off everywhere (Pepe's report) - kept as it is, not queued
    {
      const cur = await settingsFor(R.id).catch(() => null);
      const off = cur && cur.masters_off ? cur.masters_off[key] : null;
      if (off) return bad(res, 409, "Switched off by PATV admins right now - your setting is kept for when it's back.");
    }
    // 1.99tn: a burst limit per account + pad (Pepe limits per room too); staff aren't limited
    if (!rooms.isStaff(req.user)) {
      const rk = req.user.userId + "|" + R.id, t = Date.now();
      const hits = (SET_HITS.get(rk) || []).filter((x) => t - x < SET_WINDOW_MS);
      if (hits.length >= SET_MAX) {
        SET_HITS.set(rk, hits);
        return bad(res, 429, `That's a lot of changes at once - try again in ${Math.ceil((SET_WINDOW_MS - (t - hits[0])) / 1000)} s.`);
      }
      hits.push(t);
      SET_HITS.set(rk, hits);
      if (SET_HITS.size > 5000) SET_HITS.clear();
    }
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "room.owner", args: [R.id, key, value], tag: "owner",
        label: `${R.title}: ${key} ${value}` });
      await rooms.event(R.id, "pepe-setting", req.user.username || "?", `${key}=${key === "greeter_note" ? (value ? "(note)" : "(cleared)") : value} (sent to Pepe)`).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // 1.99up: the room's topic -> website action "room.topic" (Pepe re-checks the owner, the text, the limit; keeps a pending
  // pad code that's in the topic; pauses the room's auto-topic). Checked here first so nothing junk is queued.
  app.post("/api/rooms/:slug/owner/topic", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    const text = cleanTopic((req.body || {}).text);
    const why = topicProblem(text);
    if (why) return bad(res, 400, why);
    if (!rooms.isStaff(req.user)) {
      const t = Date.now();
      const hits = (TOPIC_HITS.get(R.id) || []).filter((x) => t - x < 3600e3);
      if (hits.length >= TOPIC_MAX_HOUR) {
        TOPIC_HITS.set(R.id, hits);
        return bad(res, 429, `That's ${TOPIC_MAX_HOUR} topic changes this hour - try again in ${Math.ceil((3600e3 - (t - hits[0])) / 60000)} min.`);
      }
      hits.push(t);
      TOPIC_HITS.set(R.id, hits);
      if (TOPIC_HITS.size > 5000) TOPIC_HITS.clear();
    }
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "room.topic", args: [R.id, text], tag: "owner",
        label: `${R.title}: topic` });
      await rooms.event(R.id, "pepe-topic", req.user.username || "?", `${text.slice(0, 160)} (sent to Pepe)`).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // 1.99ti: ask Pepe into / out of the pad's Camfrog room, or to rejoin it - 💎 Prime Time Plus pads (staff: any)
  app.post("/api/rooms/:slug/owner/pepe-room", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    const verb = String((req.body || {}).verb || "");
    if (!CTL_VERBS.has(verb)) return bad(res, 400, "Join, leave or rejoin.");
    const staff = rooms.isStaff(req.user);
    if (!staff && !require("./premium").isPrimePlus(R.id)) {
      return bad(res, 403, "Pepe sits in Camfrog rooms for 💎 Prime Time Plus pads - get Plus for this pad first.");
    }
    const last = CTL_LAST.get(R.id) || 0;
    if (!staff && Date.now() - last < CTL_GAP_MS) {
      return bad(res, 429, `One room action every 2 minutes - try again in ${Math.ceil((CTL_GAP_MS - (Date.now() - last)) / 1000)} s.`);
    }
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "room.ctl", args: [verb, R.id], tag: "owner",
        label: `${R.title}: Pepe ${verb}` });
      CTL_LAST.set(R.id, Date.now());
      await rooms.event(R.id, "pepe-room", req.user.username || "?", `${verb} (sent to Pepe)`).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // Top up the room vault = !roomvault deposit <amount> as the linked Camfrog login (1.99uu: or, with no Camfrog name linked,
  // from the PATV account itself - the same path as the pad page's Donate), keyed by the form's one-time idem
  app.post("/api/rooms/:slug/vault/topup", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedVaultPad(req, res); if (!R) return;
    const b = req.body || {};
    const idem = String(b.idem || "");
    if (!IDEM_RE.test(idem)) return bad(res, 400, "Reload the page and try again.");
    const amount = typeof b.amount === "number" ? b.amount : /^\s*\d+\s*$/.test(String(b.amount || "")) ? parseInt(b.amount, 10) : NaN;
    const u = (await getQuery("SELECT camfrogUsername, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || {};
    let card = null;
    try { card = await require("./roomvaults").card(R.id, req.user, { canManage: true }); } catch (e) { card = null; }
    const min = (card && card.deposit_min) || 1000, cap = (card && card.cap) || 50000000;
    const room = Math.max(0, cap - ((card && card.balance) || 0));
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < min) return bad(res, 400, `Top up at least ${min.toLocaleString("en-US")} PAT.`);
    if (amount > room) return bad(res, 400, room ? `The vault can take ${room.toLocaleString("en-US")} PAT more (cap ${cap.toLocaleString("en-US")}).` : "The vault is full.");
    if (amount > (Number(u.points_balance) || 0)) return bad(res, 400, "You don't have that many PAT.");
    if (card && card.live === false) return bad(res, 409, "Pad vaults aren't open yet.");
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "roomvault.deposit", args: [R.id, String(amount)], tag: "owner",
        label: `${R.title}: top up ${amount.toLocaleString("en-US")} PAT`, idem });
      console.log(`[padowner] topup room=${R.id} account=${req.user.username} amount=${amount} action=${id}`);
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // the cards' live numbers (after a top-up / a setting)
  app.get("/api/rooms/:slug/owner/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedVaultPad(req, res); if (!R) return;          // 1.99uu: any pad (the Pepe part: Camfrog pads)
    try {
      const vault = await require("./roomvaults").card(R.id, req.user, { canManage: true, staff: rooms.isStaff(req.user) });
      const u = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || {};
      const pepe = rooms.platformOf(R.id) === "camfrog" ? await settingsFor(R.id) : null;
      res.json({ ok: true, vault, pepe, balance: Number(u.points_balance) || 0 });
    } catch (e) { console.error("[padowner] state", e); bad(res, 500, "Something went wrong."); }
  });
}

module.exports = { register, init, storeSettings, settingsFor, soundboardState, cleanOne, capabilities, pageData, WEB_CAPS, OWNER_SETTINGS,
                   padVoices, ownerVoicesForPepe, CONVO_QUIET, AUTOTOPIC_EVERY, cleanTopic, topicProblem, TOPIC_MAX,
                   OWNER_GROUPS, OWNER_BOOL, cleanNote, readonlyList, myPads, languages: () => LANGS, choices: () => CHOICES,
                   _reset: () => { CAPS = null; SET_HITS.clear(); TOPIC_HITS.clear(); } };
