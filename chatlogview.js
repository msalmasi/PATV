// chatlogview.js — CL3: who sees how far back in a pad's chat, and what of it (the chat-history spec §3.2, §3.3).
//
// Every read of a pad's chat - today's live tail (bridge.liveView: the pad page, its long-poll, the homepage panel), and later
// history (CL8), search (CL9) and downloads (CL10) - asks ONE function for the viewer's floors and runs ONE projection:
//
//   view(padId, viewer)   -> the viewer's role and floors per item class (ms), what they may do (history / search / downloads /
//                            deep links), the pad's effective public windows. It runs reconcile() first, so a missed hook
//                            costs nothing.
//   reconcile(room, ins)  -> moves the room's WATERMARKS (chatlog_rooms) when a setting input changed. Widening is never
//                            retroactive (decision 5): a narrower setting applies at once; a wider one (a longer window, search
//                            turned on, a wider pad access, a new owner or a different pad) only to lines said from then on -
//                              window narrowed / widened   wm_cls = max(wm_cls, now - min(old window, retention_cls))
//                              search off -> on            wm_search = now (lines said while it was off stay unsearchable)
//                              access widened from Approved aud_m = now (and every line keeps its own aud as a backstop)
//                              a different pad             wm_chat = wm_tx = wm_search = aud_m = now
//                              a different owner           owner_since = now (a new owner doesn't inherit the earlier era)
//                            Tier changes never bump a window watermark: the EXPIRY watermarks exp_* follow the deletion cutoff
//                            (the tier then in force, with a 30-day grace after a downgrade - chatlog_meta tier:<room>), so an
//                            upgrade inside the grace brings lines back and nothing past it ever returns. "Also open earlier
//                            history" (chatlog_open) resets the window / search watermarks 7 days after the owner asks; any
//                            watermark bump meanwhile cancels it (fail closed: a newer closure is never opened unannounced).
//   filter / dress        -> the projection (§3.3): lines below the floor, an `aud` stricter than the viewer, people the sticky
//                            hidden set (chatlog.js) LEAVES OUT (!bridge hide, a kind Pepe never said, forget / delete / staff;
//                            !transcripts off for 🎙 lines) are left out - never shown as "someone". The owner's decision-9
//                            change (2026-10-19, "incognito hides WHO, not WHAT"): an INCOGNITO person's chat and 🎙 lines are
//                            kept and shown as "someone" - no login, display name, avatar or looks, no 🎙 id (privacyOf: "anon";
//                            dress anonymises) - their joins / leaves / mic lines stay left out (Pepe's anonymised stand-ins
//                            can't be told from a !bridge hide one's). 1.99afl (B.1): since Train 3 Pepe sends no event at all
//                            for a !bridge hide person, so a hashless anonymous MIC grab / drop from a sync that carried both
//                            kinded lists (stamped k3 at ingest; a drop only when its hold's grab was - Pepe's per-hold ref)
//                            is an incognito person's: "someone grabbed / dropped the mic" (privacyAt); one Pepe sent with
//                            the holder's hash (data.anon) is too, until that hash is left out. Joins / leaves and unstamped
//                            ones stay left out. Pepe's own anonymised lines (an incognito speaker's, sent
//                            with their hash - `ah`, server-only; archived as who "h:<hash>") are "someone" too, and left out
//                            once that hash is left out (Train 3 review: once ANY hash Pepe sent for the speaker is - `ahs`,
//                            data.anon.hs). The kind is the STRICTER of the two sticky stores - chatlog.js's and hubhidden.js's
//                            (kindNow; the integrator's one reader rule, so the chat never names someone tips / mentions / quotes
//                            keep private; fails closed while chatlog's set loads). Hidden people's names (both kinds) inside other lines become "someone"
//                            (their login + the display names in chatlog_hidden_names, >= 3 characters, a stop-list of common
//                            words never redacted); private-activity accounts are "someone" in presence lines; a web member
//                            whose account is gone is "former member"; removed lines (CL6) are left out except for the owner
//                            and staff.
//   signJc / checkJc      -> the page's signed JOIN CURSOR: with a window of "Off", a reconnecting page still gets up to
//                            GRACE_MS of lines said AFTER it first loaded (never before) - a missing or forged one counts as now.
//
// Roles (decision 6): site staff holding chatlog.read_all (CL6: siteperms-core.js, Staff, privacy-locked) read back to retention
// (every read below the public floor is audited, chatlog_views); the pad's owner from when they became the owner; the room's
// Camfrog mods (kick or more in Pepe's live caps) 7 days past the public floor (everything with the pad's "Room mods can read all
// history"); everyone else the public floor (a viewer who isn't an approved member: never before aud_m). Presence lines (joins,
// leaves, mic) are public for 24 hours (decision 10). Scrollback / search / downloads / deep links need a signed-in viewer
// (decision 7), an age-confirmed one on an 18+ pad, nobody blocked from the whole bridge or banned from the pad's feed; a pad
// without the 💎 bridge perk keeps them for its owner and staff only (decision 24).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const CL = require("./chatlog");

// ── owner decisions (spec §6): each one constant ──
const GRACE_MS = 10 * 60e3;              // decision 4: under "Off" a reconnect replays at most 10 minutes, never before the page loaded
const PRESENCE_MS = 24 * 3600e3;         // decision 10: joins / leaves / mic lines are public for 24 hours
const MOD_EXTRA_MS = 7 * 864e5;          // decision 6: the room's Camfrog mods read 7 days past the public floor
const OPEN_DELAY_MS = 7 * 864e5;         // decision 5: "Also open earlier history" takes effect 7 days after the request
const SIGNED_ONLY = true;                // decision 7: scrollback / search / downloads / deep links need a signed-in viewer
const BLOCK_RULES = true;                // a whole-bridge block or a feed ban takes them away for that pad (§3.2)
const DOWNGRADE_GRACE_MS = 30 * 864e5;   // a lapsed tier keeps its lines this long (an upgrade inside it brings them back)

const JC_TTL = 24 * 3600e3;              // a join cursor is good this long; then the page re-loads its view ({reinit: true})
const EXP_PERSIST_MS = 3600e3;           // the expiry watermark is written when it moved this much (exactly at a tier change)
const READ_ALL = "chatlog.read_all";     // the staff capability (CL6: siteperms-core.js; a registry without it = nobody holds it)
const KICK_ACTIONS = ["kick", "ban"];    // "kick or more" in Pepe's live caps = the room's Camfrog mod
const NAME_MIN = 3, NAMES_PER = 8, NAMES_PEOPLE_MAX = 400, NAMES_REFRESH_MS = 6 * 3600e3;
const AUD = Object.freeze({ public: "p", members: "m", approved: "a" });
const PRESENCE = new Set(["join", "leave", "mic", "unmic"]);
const TIER_RANK = Object.freeze({ standard: 0, prime: 1, unlimited: 2 });
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
// common words a hidden person's display name is never redacted as (a collision is counted on /admin/bridge, never redacted)
const STOP = new Set(`the and for you your are but not all any can had her him his its our out was who why how what when where
  with this that them they then than there here have has from just like love lol lmao omg yes yeah yep nope okay hey hello bye
  good bad nice cool sweet best great man men guy guys girl girls boy boys baby babe honey dear dude bro sis king queen lady sir
  angel star sun moon sky fire ice music song mic cam room chat pepe frog someone anyone everyone nobody somebody admin mod owner
  user guest test new old one two three day night time home life god thanks thank please sorry well very much more most some
  will would could should did does done got get let lets now off too who's you're i'm it's don't can't won't real true free
  big little happy sad funny crazy wild live online party drink beer wine coffee tea food pizza game play fun boss chief
  mama papa mom dad son daughter friend friends buddy pal hun hon sexy cute pretty hot cold rain snow storm wind`.split(/\s+/).filter(Boolean));

let clock = () => CL.now();
const now = () => clock();

// ── state ──
const ROWS = new Map();          // room id -> chatlog_rooms row (shaped)
const TIERS = new Map();         // room id -> {tier, prev, drop_at, lapsed} (chatlog_meta "tier:<room id>"; CL7 fix-up: lapsed)
const OPENS = new Map();         // room id -> its pending chatlog_open row
const CHAINS = new Map();        // room id -> promise chain: one room's watermark writes never interleave
const HASHES = new Map();        // login (lower) -> hash (CL.hash), bounded
const WHO = new Map();           // hash -> login: the hidden-names job finds a hidden person's login here (built from chat_log + ingest)
const DISP = new Map();          // login -> display names it showed in the live feeds / rosters (newest first, <= NAMES_PER) - CL3 fix-up
const NAMES = new Map();         // hash -> {login, names[], updated} (chatlog_hidden_names: ONLY hashes hidden now)
let NAMES_V = 0, RE = null, RE_V = -1, COLLISIONS = 0;
// CL8 fix-up: the privacy state's version - bumped by every change of the sticky hidden set (CL.onHidden) and of the redaction
// (the compiled names); GONE = takedowns per room (chatlogmod's live drop). Open pages compare the digest (historyBlock.pv) and
// re-check the lines they hold (chatloghist /history/check) - scrollback's and the offline 📜 card's lines included.
let PV = 0, RE_SRC = "";
const GONE = new Map();          // rk -> takedowns since boot
const PV_SALT = crypto.randomBytes(12).toString("hex");
const CACHE = { mod: new Map(), att: new Map(), blk: new Map(), cur: new Map(), audit: new Map() };
let attestedFn = null;           // tests

// ── small helpers ──
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const num0 = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const classOf = (k) => (k === "tx" ? "tx" : PRESENCE.has(k) ? "presence" : "chat");
const loginOf = (it) => (it && it.u && typeof it.u === "object" && !it.u.anon && !it.u.former && it.u.login ? String(it.u.login) : null);
/** sha256("pepe-hidden:" + lower(login))[:20] (chatlog.hash), cached: the live tail runs this per line per poll. */
function hashOf(login) {
  const k = lower(login);
  let h = HASHES.get(k);
  if (!h) {
    h = CL.hash(k);
    HASHES.set(k, h);
    if (HASHES.size > 20000) HASHES.delete(HASHES.keys().next().value);
  }
  return h;
}
// Train 3 review (the integrator's "one reader rule", now for the chat itself too): the kind a hash has is the STRICTER of the two
// sticky stores' - this archive set's (chatlog.hiddenKind) and hubhidden.js's (the set quotes.isHidden / tips / mentions / go-live /
// boost / the mic stage already read since adb9edcd) - so the live chat, its roster, history, search and downloads never name
// someone the rest of the site keeps private (hubhidden holds a person chatlog_hidden doesn't when it was never seeded from it -
// the first deploy - or an older Pepe's drop is held there). The chat fails closed while ITS set (chatlog's) loads; while
// hubhidden's start-up read is still running the chat reads chatlog's alone, as before (hubhidden's loading answer is "everyone
// left out": it would blank every pad's live chat for the length of a slow or retried read - quotes / tips keep refusing then,
// and the clip card says why). (hubhidden has no !transcripts off set: that one is chatlog's alone.) The two stores stay two
// (docs/chat-tickets.md).
let HUB = null;
function hub() {
  if (HUB === null) { try { HUB = require("./hubhidden"); } catch (e) { HUB = false; } }
  return HUB || null;
}
/** hubhidden's kind of h: "out" (bridge / unknown) | "anon" (incognito only) | null (not held, or its start-up read isn't done). */
function hubKind(h) {
  const H = hub();
  if (!H) return null;
  try {
    if (H.loading()) return null;
    return H.isLeftOutHash(h) ? "out" : H.isHiddenHash(h) ? "anon" : null;
  } catch (e) { return null; }
}
const KIND_RANK = { out: 2, anon: 1 };
const stricter = (a, b) => ((KIND_RANK[b] || 0) > (KIND_RANK[a] || 0) ? b : a);
/** The kind of h NOW across both stores: "out" | "anon" | null. */
const kindNow = (h) => stricter(CL.hiddenKind(h), hubKind(h));
const isHiddenLogin = (login) => !!login && kindNow(hashOf(login)) != null;
// owner change: the lines of this login are LEFT OUT now (not just anonymised) - fails closed while the set loads
const isLeftOutLogin = (login) => !!login && kindNow(hashOf(login)) === "out";
const HASH20 = /^[0-9a-f]{20}$/;
/** The speaker hash of an item: its login's, or (Pepe's anonymised line, an archived "h:" row) the hash kept with it. */
function speakerHash(it) {
  if (!it || typeof it !== "object") return null;
  if (typeof it.ah === "string" && HASH20.test(it.ah)) return it.ah;
  const l = loginOf(it);
  return l ? hashOf(l) : null;
}
/** Train 3 review: EVERY hash the speaker could be - the speaker hash, plus (Pepe's anonymised line) the other incognito hashes Pepe
 *  sent with it (`ahs`, data.anon.hs: the login and a display name, or members sharing a display name). */
function speakerHashes(it) {
  const h = speakerHash(it);
  if (!h) return [];
  if (h !== it.ah || !Array.isArray(it.ahs)) return [h];
  const out = [h];
  for (const x of it.ahs) if (typeof x === "string" && HASH20.test(x) && !out.includes(x)) out.push(x);
  return out;
}
/**
 * The owner's decision-9 change: what the sticky hidden set makes of this item's speaker NOW - "out" (left out: !bridge hide, a
 * kind Pepe never said, forget / delete / staff, !transcripts off for a 🎙 line, any hidden person's presence line, Pepe's
 * anonymised stand-in without a hash) | "anon" (incognito only: a chat / 🎙 line shown as "someone") | null (as it is). A purged
 * line (no author left) is null unless its hash is left out. Fails closed while the set loads (chatlog: everyone left out).
 */
function privacyOf(it) { return privacyAt(it, kindNow, CL.isTxHiddenHash); }
/** privacyOf against a given state of the set: kindOf(h) -> "out" | "anon" | null, txOf(h) -> !transcripts off. The owner-change
 *  fix-up: the live tail asks it with the set as it was BEFORE a change (chatlog's ch.prev) to tell which lines' look moved. */
function privacyAt(it, kindOf, txOf) {
  if (!it || typeof it !== "object") return null;
  const u = it.u && typeof it.u === "object" ? it.u : null;
  const ah = typeof it.ah === "string" && HASH20.test(it.ah) ? it.ah : null;
  if (ah) {
    // Train 3 review: left out once ANY hash the speaker could be is (Pepe's data.anon.hs - `ahs`): two incognito members sharing
    // a display name, one of them later on !bridge hide / forget-me / deleted, never leaves their line up as "someone"
    for (const x of speakerHashes(it)) if (kindOf(x) === "out" || (it.k === "tx" && txOf(x))) return "out";
    if (it.purged) return null;
    // 1.99afl review: a mic grab / drop Pepe sent with its holder's incognito hash (data.anon, like his anonymised chat / 🎙
    // lines - bridge.anonMic) is "someone grabbed / dropped the mic", and left out once that hash is (above); joins / leaves stay out
    return it.k === "join" || it.k === "leave" ? "out" : "anon";
  }
  if (!u) return null;
  // Pepe's anonymised stand-in with no hash (a join / leave / mic of someone on his hidden list - he doesn't say which kind - or an
  // older Pepe's line): left out, never "→ someone joined". (A purged line's blanked author is no stand-in.)
  // 1.99afl (B.1): a hashless anonymous MIC grab / drop stamped k3 at ingest - its sync carried both kinded hash lists
  // (bridge_hidden_h AND incog_hidden_h as arrays), so it came from a Pepe that never sends a !bridge hide person's events
  // (Train 3, 1.99adm on) with his hide list loaded: it is an INCOGNITO person's, shown as "someone grabbed / dropped the mic".
  // A drop is stamped only when its hold's grab was (bridge.k3Hold, Pepe's per-hold ref): a hold begun NAMED whose holder went
  // private mid-hold is released anonymised under a fresh ref - never shown. Joins / leaves, and any unstamped one (stored
  // before 1.99afl, an older Pepe, a lost list, an unpaired drop), stay left out (fails closed).
  if (u.anon) return it.purged ? null : it.k3 === 1 && (it.k === "mic" || it.k === "unmic") ? "anon" : "out";
  const login = loginOf(it);
  if (!login) return null;
  const h = hashOf(login);
  if (it.k === "tx" && txOf(h)) return "out";
  const kind = kindOf(h);
  if (kind === "out") return "out";
  if (kind === "anon") return PRESENCE.has(it.k) ? "out" : "anon";
  return null;
}
/** How a line LOOKS on a page under a privacy answer: "out" (not there) | "someone" | "named". Pepe's anonymised line (`ah`) and an
 *  archived "h:" row are "someone" whatever their speaker's state - only leaving changes them. */
const lookOf = (it, p) => (p === "out" ? "out" : p === "anon" || (it && typeof it.ah === "string" && HASH20.test(it.ah)) || (it && it.u && it.u.anon) ? "someone" : "named");
/**
 * The owner-change fix-up (review 2, HIGH): what a change of the hidden set does to a line an open page may hold, from its look
 * before (ch.prev: each touched hash's kind / !transcripts off as it was) to its look now. -> {gone, redo}:
 *   gone = it was on the page and must leave now (`removed`) - or it was named and is "someone" now (an older page just drops it);
 *   redo = drawn again in place: named -> "someone", "someone" -> named (un-hidden), left out -> named.
 * NEVER for a line whose look doesn't change (Pepe's anonymised lines / "h:" rows stay "someone" through every incognito on / off:
 * listing them beside the person's named lines would tell which "someone" lines are theirs), and never left out -> "someone" (the
 * "someone" lines that turn up together would be one person's, at the moment they typed !bridge show - they come with the next
 * load). Without ch.prev (an older caller) the look before is guessed from the change itself.
 */
const CH_SETS = new WeakMap();      // a change -> its hash lists as Sets (lookMove runs once per line of every live feed)
function chSets(ch) {
  let s = CH_SETS.get(ch);
  if (!s) {
    s = {};
    for (const k of ["added", "kinds", "removed", "addedTx", "removedTx"]) s[k] = new Set(Array.isArray(ch[k]) ? ch[k] : []);
    CH_SETS.set(ch, s);
  }
  return s;
}
function lookMove(it, ch) {
  const hs = speakerHashes(it);
  if (!hs.length || !ch || typeof ch !== "object") return { gone: false, redo: false, now: null };
  const prev = ch.prev instanceof Map ? ch.prev : null;
  const S = chSets(ch);
  // (Train 3 review: a change to ANY hash the speaker could be - `ahs` - touches the line)
  const has = (k) => hs.some((h) => S[k].has(h));
  const touched = has("added") || has("kinds") || has("removed") || (it.k === "tx" && (has("addedTx") || has("removedTx"))) ||
    (!!prev && hs.some((h) => prev.has(h)));
  if (!touched) return { gone: false, redo: false, now: null };
  const now = lookOf(it, privacyOf(it));
  const m = lookStep(it, ch, prev, has, now);
  m.now = now;                                              // (a touched line's look now: bridge.js clears stale entries by it)
  return m;
}
function lookStep(it, ch, prev, has, now) {
  let before;
  if (prev) {
    const was = (x) => (prev.has(x) ? prev.get(x) : null);
    // (Train 3 review: "before" stays this set's own state - hubhidden takes the same inputs and usually moves in the same sync,
    // so its kind NOW would hide the very move a page must see: named -> "someone" leaving a name up. "now" is the stricter of both)
    before = lookOf(it, privacyAt(it, (x) => (was(x) ? was(x).kind : CL.hiddenKind(x)), (x) => (was(x) ? !!was(x).tx : CL.isTxHiddenHash(x))));
  } else {
    // the guess (fails toward leaving): newly hidden = it was named; un-hidden = it was "someone" or out (never assumed on the page)
    before = has("added") || (it.k === "tx" && has("addedTx")) ? "named" : has("kinds") ? (now === "out" ? "someone" : "out") : "out";
    if (typeof it.ah === "string" && HASH20.test(it.ah) && before === "named") before = "someone";
  }
  if (before === now) return { gone: false, redo: false };
  if (now === "out") return { gone: true, redo: false };
  if (before === "named" && now === "someone") return { gone: true, redo: true };
  if (now === "named") return { gone: false, redo: true };
  return { gone: false, redo: false };                      // out -> "someone": with the next load, never live
}
// owner change (fix-up, review 2): hashes whose NAMED lines became "someone" lately (they went incognito from shown) -
// /history/check draws those named rows again as "someone" (the page may still show the name). Only that move: a line whose look
// doesn't change, or that turns up as "someone", is never drawn again (it would tell which "someone" lines are one person's).
const NAMED_TO_ANON = new Map();       // hash -> {at: ms, tx: their 🎙 lines were off before (they were never named on a page)}
function noteMoved(ch) {
  const t = Date.now();
  const prev = ch && ch.prev instanceof Map ? ch.prev : null;
  for (const h of ch && Array.isArray(ch.added) ? ch.added : []) {
    if (kindNow(h) !== "anon") continue;                   // (Train 3 review: left out by either store = nothing to draw again)
    const was = prev && prev.has(h) ? prev.get(h) : null;
    if (was && was.kind != null) continue;                 // (it was hidden before: its lines weren't named)
    NAMED_TO_ANON.delete(h);
    NAMED_TO_ANON.set(h, { at: t, tx: was ? !!was.tx : CL.isTxHiddenHash(h) });
  }
  while (NAMED_TO_ANON.size > 20000) NAMED_TO_ANON.delete(NAMED_TO_ANON.keys().next().value);
}
/** Was this (named, not Pepe-anonymised) line shown by name until its speaker went incognito in the last `ms`? */
function namedToAnonLately(it, ms = 3600e3) {
  if (!it || (typeof it.ah === "string" && HASH20.test(it.ah)) || !loginOf(it)) return false;
  const h = speakerHash(it);
  const r = h ? NAMED_TO_ANON.get(h) : null;
  return !!r && Date.now() - r.at < ms && !(it.k === "tx" && r.tx);
}
/** (kept for callers from before the fix-up: any line of a hash that moved from named to "someone" lately) */
const movedLately = (h, ms = 3600e3) => !!h && NAMED_TO_ANON.has(h) && Date.now() - NAMED_TO_ANON.get(h).at < ms;
/** A yes / no per key, cached (positive posMs, negative negMs). `onError` = the answer when the check itself fails - always the
 *  one that grants LESS (not a mod, not age-confirmed, blocked). */
function cachedAsync(map, key, posMs, negMs, fn, onError = false) {
  const c = map.get(key), t = Date.now();
  if (c && t - c.at < (c.v ? posMs : negMs)) return Promise.resolve(c.v);
  return Promise.resolve().then(fn).catch(() => onError).then((v) => {
    map.set(key, { v: !!v, at: Date.now() });
    if (map.size > 20000) map.delete(map.keys().next().value);
    return !!v;
  });
}
async function roQuery(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);       // no read connection (tests / tools): the shared one
    throw e;
  }
}

// ── setup ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await CL.init();
      for (const r of await getQuery("SELECT * FROM chatlog_rooms")) ROWS.set(r.room_id, shape(r));
      for (const r of await getQuery("SELECT key, value FROM chatlog_meta WHERE key LIKE 'tier:%'")) {
        try { TIERS.set(r.key.slice(5), cleanTier(JSON.parse(r.value))); } catch (e) { /* re-learnt at the next view */ }
      }
      const byRk = new Map([...ROWS.values()].map((r) => [r.rk, r.room_id]));
      for (const r of await getQuery("SELECT * FROM chatlog_open WHERE state = 'pending' ORDER BY id")) {
        const id = byRk.get(r.rk);
        if (id) OPENS.set(id, r);
      }
      for (const r of await getQuery("SELECT h, login, names, updated FROM chatlog_hidden_names")) {
        let names = [];
        try { names = JSON.parse(r.names); } catch (e) { names = []; }
        NAMES.set(r.h, { login: r.login, names: Array.isArray(names) ? names.map(String) : [], updated: Number(r.updated) || 0 });
      }
      NAMES_V++;
      CL.onHidden(() => scheduleNames());
      CL.onHidden(() => { PV++; });        // CL8 fix-up: open pages re-check what they show (historyBlock.pv)
      CL.onHidden(noteMoved);              // owner change: ...and draw again the lines whose speaker's kind moved
      scheduleNames();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function shape(r) {
  let inputs = null;
  try { inputs = r.inputs ? JSON.parse(r.inputs) : null; } catch (e) { inputs = null; }
  // CL3 fix-up: owner_id = the owner the watermarks last applied (accountMerge re-keys it - a merge isn't a new owner); created =
  // when the row was made (a row the archive created has no inputs yet: a pad born after it is a different pad)
  return { rk: Number(r.rk), room_id: r.room_id, first_ts: Number(r.first_ts) || null, owner_since: num0(r.owner_since),
           owner_grant: r.owner_grant == null ? null : Number(r.owner_grant), wm_chat: num0(r.wm_chat), wm_tx: num0(r.wm_tx),
           wm_search: num0(r.wm_search), aud_m: num0(r.aud_m), exp_chat: num0(r.exp_chat), exp_tx: num0(r.exp_tx),
           owner_id: r.owner_id == null || r.owner_id === "" ? null : String(r.owner_id), created: num0(r.created),
           inputs: inputs && typeof inputs === "object" ? inputs : null, at: Date.now() };
}
/** CL7 fix-up: the tiers a downgrade took away, each with ITS OWN 30-day grace - [{tier, at: when it was lost}], one per tier (the
 *  latest loss), highest first. A record from before the fix-up ({prev, drop_at} only) reads as that one lapse. */
function lapsedOf(T) {
  if (!T) return [];
  if (Array.isArray(T.lapsed)) return T.lapsed;
  return T.prev && T.drop_at ? [{ tier: T.prev, at: T.drop_at }] : [];
}
/** The tracking record for `tier` with these lapses: one entry per tier (its latest loss), at most the ranks above "standard";
 *  prev / drop_at name the latest loss (what the admin card and older readers show). */
function tierRec(tier, lapsed) {
  const by = new Map();
  for (const e of lapsed || []) {
    if (!e || TIER_RANK[e.tier] == null || !(num0(e.at) > 0) || e.tier === "standard") continue;
    const have = by.get(e.tier);
    if (!have || num0(e.at) > have.at) by.set(e.tier, { tier: e.tier, at: num0(e.at) });
  }
  const list = [...by.values()].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  const last = list.reduce((m, e) => (!m || e.at > m.at ? e : m), null);
  return { tier, prev: last ? last.tier : null, drop_at: last ? last.at : null, lapsed: list };
}
const cleanTier = (o) => tierRec(TIER_RANK[o && o.tier] != null ? o.tier : "standard",
                                 lapsedOf({ lapsed: o && Array.isArray(o.lapsed) ? o.lapsed : undefined, prev: TIER_RANK[o && o.prev] != null ? o.prev : null,
                                            drop_at: num0(o && o.drop_at) || null }));

/** The room's chatlog_rooms row (created here when the archive never wrote one - the watermarks start with the settings). */
async function rowFor(roomId, ownerId) {
  const have = ROWS.get(roomId);
  if (have) {
    if (have.first_ts == null && Date.now() - have.at > 60e3) {     // the archive's first line (start_ts) arrives later
      const r = (await getQuery("SELECT first_ts FROM chatlog_rooms WHERE rk = ?", [have.rk]))[0];
      have.first_ts = r && r.first_ts != null ? Number(r.first_ts) : null;
      have.at = Date.now();
    }
    return have;
  }
  let db = (await getQuery("SELECT * FROM chatlog_rooms WHERE room_id = ?", [roomId]))[0];
  if (!db) {
    await runQuery(`INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES (?, ?, ?, 0, ?)
                    ON CONFLICT(room_id) DO NOTHING`, [roomId, roomId, ownerId || null, now()]);
    db = (await getQuery("SELECT * FROM chatlog_rooms WHERE room_id = ?", [roomId]))[0];
  }
  const r = shape(db);
  ROWS.set(roomId, r);
  CL.noteRk(roomId, r.rk);
  return r;
}
function serialRoom(roomId, fn) {
  const prev = CHAINS.get(roomId) || Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  CHAINS.set(roomId, tail);
  tail.then(() => { if (CHAINS.get(roomId) === tail) CHAINS.delete(roomId); });
  return p;
}

// ── retention: the tier's windows and the deletion cutoff (exp_*) ──
/** {chat, tx} in seconds for a tier (null = for good), from Pepe's mirrored windows (premium.retention). */
function retFor(tier) {
  let R = null;
  try { R = require("./premium").retention(); } catch (e) { R = null; }
  if (!R) return { chat: 30 * 86400, tx: 30 * 86400 };
  const k = tier === "unlimited" ? "_plus" : tier === "prime" ? "_prime" : "_days";
  const s = (v) => (v == null ? null : Number(v) * 86400);
  return { chat: s(R["chat" + k]), tx: s(R["rec" + k]) };
}
const longer = (a, b) => (a == null || b == null ? null : Math.max(a, b));
/** CL7 fix-up: the lapsed tiers still inside their own 30-day grace at t that rank above the tier now: [{tier, at, until}],
 *  highest first. Each lapse has its own end - a second downgrade inside a grace never shortens the first one's, nor the other way. */
function graceOf(T, t) {
  if (!T) return [];
  return lapsedOf(T).filter((e) => TIER_RANK[e.tier] > TIER_RANK[T.tier] && t - e.at < DOWNGRADE_GRACE_MS)
    .map((e) => ({ tier: e.tier, at: e.at, until: e.at + DOWNGRADE_GRACE_MS }));
}
/** The retention deletion follows: the tier now - or the longest window of every tier lost within the last 30 days (each lapse
 *  keeps its window until ITS grace ends; CL7 fix-up: Plus -> Prime Time, then Prime Time -> none 29 days later keeps Prime
 *  Time's windows for 30 days from the second drop). Per class: the longer of them. */
function deletionRet(T, t) {
  let r = retFor(T.tier);
  for (const e of graceOf(T, t)) {
    const p = retFor(e.tier);
    r = { chat: longer(r.chat, p.chat), tx: longer(r.tx, p.tx) };
  }
  return r;
}
/** The deletion cutoff per class (ms; 0 = nothing is past retention). CL7's purge deletes below it and raises exp_* to it. */
function cutoffs(T, t) {
  const r = deletionRet(T, t);
  return { chat: r.chat == null ? 0 : Math.max(0, Math.floor(t - r.chat * 1000)), tx: r.tx == null ? 0 : Math.max(0, Math.floor(t - r.tx * 1000)) };
}
/** The pad's tier for retention: unlimited | prime | standard - or null while the tier can't be known (premium.js not loaded):
 *  then visibility uses the standard windows and nothing permanent (the tier tracking, exp_*) moves. */
let premiumReady = false;
function padTier(padId) {
  if (!premiumReady) return null;
  try { const t = require("./premium").padPerks(padId).retention; return TIER_RANK[t] != null ? t : null; } catch (e) { return null; }
}
async function ensurePremium() {
  if (premiumReady) return true;
  try { await require("./premium").init(); premiumReady = true; } catch (e) { console.error("[chatlogview] tiers:", e.message); }
  return premiumReady;
}
/** CL7 fix-up: Pepe's retention report is fresh at t (chatlogpurge.reportAge: within the hour, a complete and valid report since
 *  the site started) - the windows the site holds are his. Can't tell -> not fresh. */
function retentionFresh(t) {
  try { return !!require("./chatlogpurge").reportAge(t).fresh; } catch (e) { return false; }
}

// ── reconcile: the watermarks follow the setting inputs (never widening the past) ──
const sameWin = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));
const padBorn = (pad) => { const m = /^p(\d+)$/.exec(String(pad || "")); return m ? Number(m[1]) : 0; };
const PAD_SLACK_MS = 10 * 60e3;
/**
 * Compare the inputs {win_s, search, aud, pad, owner, tier} with the ones last applied and move the watermarks in ONE small
 * transaction; apply a due "open earlier history". opts.newPad = a hook saying the room got a different pad.
 * `inp` may be a function (CL3 fix-up): it is read INSIDE the room's serial section, so the floors a view computes come from
 * exactly the inputs this reconcile applied (a setting saved in between can never meet unbumped watermarks).
 * -> the row (+ exp: the expiry floors now, T: the tier tracking, open: the pending open, inp: the inputs applied)
 */
async function reconcile(roomId, inp0, opts = {}) {
  await init();
  const id = String(roomId || "");
  return serialRoom(id, async () => {
    const t = opts.now || now();
    const inp = typeof inp0 === "function" ? inp0() : inp0;
    const row = await rowFor(id, inp.owner);
    const old = row.inputs;
    const set = {};
    let bumped = false, changed = false, ownerChanged = false;
    const raise = (col, v) => { const cur = set[col] != null ? set[col] : row[col]; if (v > cur) { set[col] = Math.floor(v); return true; } return false; };
    if (old) {
      if (!sameWin(old.win_s, inp.win_s)) {
        const oldWin = old.win_s == null ? Infinity : Number(old.win_s);
        const ret = inp.tier ? retFor(inp.tier) : { chat: null, tx: null };   // an unknown tier: the window's part only (exp_* has the rest)
        for (const cls of ["chat", "tx"]) {
          const cand = t - 1000 * Math.min(oldWin, ret[cls] == null ? Infinity : ret[cls]);
          if (Number.isFinite(cand) && raise("wm_" + cls, cand)) bumped = true;
        }
        changed = true;
      }
      if (old.search === false && inp.search === true) { if (raise("wm_search", t)) bumped = true; changed = true; }
      if (old.search !== inp.search) changed = true;
      if (old.aud === "a" && inp.aud !== "a") { raise("aud_m", t); changed = true; }
    }
    // a different pad (CL3 fix-up: also without recorded inputs, and from "no pad" to a pad - a missed hook costs nothing):
    //   the hook says so; or the recorded pad differs (a recorded null too: the room lost its pad, now it has one); or, with no
    //   inputs recorded yet (a row the archive created), the room got its pad after the row was made (padChangedSince)
    const newPad = !!opts.newPad || (old ? Object.prototype.hasOwnProperty.call(old, "pad") && !!inp.pad && (old.pad || null) !== inp.pad
                                         : await padChangedSince(id, row, inp));
    if (newPad) {
      for (const c of ["wm_chat", "wm_tx", "wm_search", "aud_m"]) raise(c, t);
      bumped = true; changed = true;
    }
    // a different owner (CL3 fix-up): against chatlog_rooms.owner_id - the owner last applied, or the one the archive saw when it
    // made the row - so a row without inputs is covered, and accountMerge's re-key isn't a new owner (the cached row is re-read
    // before deciding)
    if ((row.owner_id || null) !== (inp.owner || null)) {
      const db = (await getQuery("SELECT owner_id FROM chatlog_rooms WHERE rk = ?", [row.rk]))[0];
      row.owner_id = db && db.owner_id != null && db.owner_id !== "" ? String(db.owner_id) : null;
    }
    if ((row.owner_id || null) !== (inp.owner || null)) { set.owner_since = t; set.owner_grant = null; changed = true; ownerChanged = true; }
    // the tier: the old state's cutoff is made permanent before the switch (an upgrade after the grace restores nothing).
    // An unknown tier (null) moves nothing permanent. CL7 fix-up: opts.permanent === false (the retention purge while Pepe's
    // report isn't fresh, the clock looks wrong, a recount) moves NOTHING permanent - no exp_*, no tier change tracked (the
    // 10-minute sweep and views track a tier change as before; the purge then reads the room as "tier unknown" until they have).
    // (a room's FIRST record - the tier it has, no lapse - moves nothing: it is made either way)
    const perm = opts.permanent !== false;
    let T = TIERS.get(id) || null, tierWrite = false;
    if (inp.tier) {
      if (!T) { T = tierRec(inp.tier, []); tierWrite = true; }
      else if (T.tier !== inp.tier && perm) {
        const c0 = cutoffs(T, t);
        raise("exp_chat", c0.chat); raise("exp_tx", c0.tx);
        // CL7 fix-up: every tier lost keeps its OWN grace - a downgrade adds the tier it took away (from now), the lapses whose
        // grace ended drop out, an upgrade keeps the rest (an upgrade inside a grace brings its lines back while it lasts)
        let lapsed = lapsedOf(T).filter((e) => t - e.at < DOWNGRADE_GRACE_MS);
        if (TIER_RANK[inp.tier] < TIER_RANK[T.tier]) lapsed = lapsed.filter((e) => e.tier !== T.tier).concat([{ tier: T.tier, at: t }]);
        T = tierRec(inp.tier, lapsed);
        tierWrite = true;
      }
    }
    const cut = T ? cutoffs(T, t) : { chat: 0, tx: 0 };
    // the expiry watermark follows the cutoff lazily (an hour's steps) - CL7 fix-up: only while Pepe's retention report is fresh
    // (the windows the site holds are his, confirmed within the hour), never on windows he hasn't confirmed; the nightly purge
    // raises it exactly
    if (inp.tier && perm && retentionFresh(t)) {
      for (const cls of ["chat", "tx"]) {
        const cur = set["exp_" + cls] != null ? set["exp_" + cls] : row["exp_" + cls];
        if (cut[cls] > cur + EXP_PERSIST_MS) set["exp_" + cls] = cut[cls];
      }
    }
    // a pending "open earlier history": a watermark bump meanwhile cancels it (CL3 fix-up: so does a new owner - they never
    // inherit an opening the previous owner asked for); due -> the window / search watermarks fall to 0
    let op = OPENS.get(id) || null, opState = null, opened = null;
    if (op && op.state === "pending") {
      if (bumped || ownerChanged) opState = "cancelled";
      else if (Number(op.effective) <= t) {
        opState = "done";
        opened = op.scope;
        if (op.scope === "window" || op.scope === "both") { set.wm_chat = 0; set.wm_tx = 0; }
        if (op.scope === "search" || op.scope === "both") set.wm_search = 0;
      }
    }
    const next = { win_s: inp.win_s == null ? null : Number(inp.win_s), search: !!inp.search, aud: inp.aud, pad: inp.pad || null, owner: inp.owner || null,
                   tier: inp.tier || (old && old.tier) || null, changed_at: changed || opState ? t : (old && old.changed_at) || null };
    const cols = Object.keys(set);
    const inputsChanged = JSON.stringify(next) !== JSON.stringify(old);
    if (inputsChanged || cols.length || tierWrite || opState) {
      await tx(async () => {
        const assign = cols.map((c) => `${c} = ?`);
        await runQuery(`UPDATE chatlog_rooms SET inputs = ?, pad_id = ?, owner_id = ?${assign.length ? ", " + assign.join(", ") : ""} WHERE rk = ?`,
                       [JSON.stringify(next), id, next.owner, ...cols.map((c) => set[c]), row.rk]);
        if (tierWrite) {
          await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         ["tier:" + id, JSON.stringify(T)]);
        }
        if (opState) await runQuery("UPDATE chatlog_open SET state = ? WHERE id = ? AND state = 'pending'", [opState, op.id]);
      });
      for (const c of cols) row[c] = set[c];
      row.inputs = next;
      row.owner_id = next.owner;
      TIERS.set(id, T);
      if (opState) { OPENS.delete(id); op = null; }
    }
    if (opState) {
      const R = require("./rooms");
      if (opened) {
        R.event(id, "chat.open_earlier", "system", `opened (${opened})`).catch(() => {});
        noteLine(id, { w: "open_done", sc: opened });
      } else {
        R.event(id, "chat.open_earlier", "system", bumped ? "cancelled: the settings closed history again before it took effect"
                                                          : "cancelled: the pad has a new owner").catch(() => {});
      }
    }
    return Object.assign({}, row, { exp: { chat: Math.max(row.exp_chat, cut.chat), tx: Math.max(row.exp_tx, cut.tx) }, T, open: OPENS.get(id) || null, inp });
  });
}
/** A row without recorded inputs (the archive made it): did the room get a different pad since? The registry row's birth after
 *  the row was made (a disconnect + a new unowned pad), or a site pad connected to the room since (padconnect "pad-connected"). */
async function padChangedSince(roomId, row, inp) {
  if (!inp.pad || !(row.created > 0)) return false;
  // (a room's first sync makes its registry row and may archive its first line in either order: a pad born within PAD_SLACK_MS
  // of the row is the same pad)
  if (padBorn(inp.pad) > row.created + PAD_SLACK_MS) return true;
  try {
    return (await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'pad-connected' AND ts > ? LIMIT 1", [String(roomId), row.created])).length > 0;
  } catch (e) { return true; }                         // can't tell: fail closed (a new public period)
}
/** A pad's setting inputs as they are now (+ cfg: the settings row they were read from - view() takes its floors from it). */
function inputsOf(padId) {
  const id = String(padId || "");
  let reg = null, level = "members";
  try { reg = require("./rooms").getCached(id); } catch (e) { reg = null; }
  try { level = require("./padaccess").levelOf(id); } catch (e) { level = "members"; }
  const c = CL.padCfg(id);
  return { win_s: c.window_s, search: c.search !== false, aud: AUD[level] || "m",
           // the pad's identity: its registry row's birth (connecting a site pad to the room, or a disconnect + a new unowned
           // pad, changes it - padconnect.js re-keys rows; the room id stays)
           pad: reg && reg.created ? "p" + reg.created : null,
           owner: reg && reg.owner && reg.owner.userId ? String(reg.owner.userId) : null, tier: padTier(id), cfg: c, reg, level };
}
/** The hooks (rooms.setOwner / seeding, padaccess.setLevel, pad connect / disconnect, the settings routes): move the watermarks
 *  at the moment of change. Never throws. opts.newPad: the room got a different pad. CL3 fix-up: the registry is loaded first
 *  (an unloaded cache would read as "no pad, no owner" and record that). */
async function reconcileNow(roomId, opts = {}) {
  try {
    await init();
    if (!roomId) return null;
    await require("./rooms").init();
    await require("./padaccess").init();
    await ensurePremium();
    return await reconcile(String(roomId), () => inputsOf(roomId), opts);
  } catch (e) { console.error("[chatlogview] reconcile:", e.message); return null; }
}

// ── the viewer ──
function capKnown(key) { try { const SP = require("./siteperms"); return !!(SP.BY_KEY && Object.prototype.hasOwnProperty.call(SP.BY_KEY, key)); } catch (e) { return false; } }
function staffOf(viewer) {
  if (!viewer || !viewer.userId || !capKnown(READ_ALL)) return false;
  try { return require("./siteperms").can(viewer, READ_ALL); } catch (e) { return false; }
}
/** The room's Camfrog mod: a linked login with kick or more in Pepe's LIVE caps (positive 60 s, negative 5 s). */
function isMod(viewer, roomId) {
  if (!viewer || !viewer.userId) return Promise.resolve(false);
  return cachedAsync(CACHE.mod, viewer.userId + "|" + roomId, 60e3, 5e3, async () => {
    const pm = require("./padmod");
    const login = await pm.linkedLogin(viewer.userId);
    if (!login) return false;
    const B = require("./bridge");
    const R = B._rooms.get(roomId);
    if (!R || !B.isLive(R)) return false;
    pm.noteViewer(roomId, login);
    const caps = pm.capsFor(R, login);
    return !!(caps && Array.isArray(caps.actions) && caps.actions.some((a) => KICK_ACTIONS.includes(a)));
  });
}
// Rebased onto the 18+ gate (adultgate.js): the site's one age confirmation, by any mechanism (/confirm-age, PATV Creators'
// "I'm 18 or older", a creator's 18+ attestation, the voice-clone consent's 18+ box) - adultgate.confirmed, the drop-in for
// creators.attested its header names. The rule applies whatever the gate's switch says (spec §3.2: history, search, downloads
// and deep links on an 18+ pad need a signed-in, age-confirmed viewer).
function attested(userId) {
  if (!userId) return Promise.resolve(false);
  return cachedAsync(CACHE.att, String(userId), 60e3, 5e3, async () => (attestedFn ? attestedFn(userId) : require("./adultgate").confirmed(userId)));
}
/** A whole-bridge block (feature "all", this room or every room) or a ban from the pad's feed (or the whole feed). */
function blockedHere(userId, roomId) {
  if (!BLOCK_RULES || !userId) return Promise.resolve(false);
  return cachedAsync(CACHE.blk, userId + "|" + roomId, 60e3, 60e3, async () => {
    const t = Date.now();
    const has = async (table) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).length > 0;
    if (await has("bridge_blocks")) {
      const b = await getQuery(`SELECT 1 FROM bridge_blocks WHERE user_id = ? AND (room_id = ? OR room_id = '') AND (until IS NULL OR until > ?)
                                AND COALESCE(feature, 'all') = 'all' LIMIT 1`, [String(userId), String(roomId), t]);
      if (b.length) return true;
    }
    if (await has("feed_bans")) {
      const f = await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND (room_id = ? OR room_id = '') AND (until IS NULL OR until > ?) LIMIT 1",
                               [String(userId), String(roomId), t]);
      if (f.length) return true;
    }
    return false;
  }, true);
}

/**
 * The viewer's view of one pad. viewer = req.user-like {userId, class, ...} or null (signed out). opts.nonExempt = never the
 * owner / staff / mod floors (the homepage panel).
 * -> {role, exempt, signed, inside, now, floor: {chat, tx, presence}, searchFloor: {chat, tx}, pub: {chat, tx}, window_s,
 *     eff: {chat, tx} (seconds, null = no limit, 0 = off), searchOn, downloadsOn, can: {history, search, downloads, deep},
 *     start_ts, audit, v, closed: {window, search}, open, rk}
 */
async function view(padId, viewer, opts = {}) {
  await init();
  const id = String(padId || "");
  const t = opts.now || now();
  const PA = require("./padaccess");
  await PA.init();
  await require("./rooms").init();          // CL3 fix-up: never "no pad, no owner" from a registry cache that isn't loaded yet
  await ensurePremium();
  // CL3 fix-up: ONE snapshot of the inputs (the settings row, the registry row, the access level, the tier), read inside the
  // room's serial section by reconcile() itself - the floors below come from exactly what it applied, so a setting saved
  // between two reads can never meet watermarks that weren't moved for it (15 min -> Everything showed the whole tail)
  const W = await reconcile(id, () => inputsOf(id), { now: t });
  const inp = W.inp;
  const cfg = inp.cfg;
  const reg = inp.reg;
  const ret = retFor(inp.tier);
  const win = cfg.window_s == null ? Infinity : cfg.window_s;
  const inf = (s) => (s == null ? Infinity : s);
  const pub = (cls) => Math.max(0, Math.floor(Math.max(t - 1000 * Math.min(win, inf(ret[cls])), W["wm_" + cls], W.exp[cls])));
  const full = (cls) => Math.max(0, Math.floor(Math.max(t - 1000 * inf(ret[cls]), W.exp[cls])));
  const signed = !!(viewer && viewer.userId);
  const ne = !!opts.nonExempt;
  const staff = signed && !ne && staffOf(viewer);
  const owner = signed && !ne && !!(reg && reg.owner && String(reg.owner.userId) === String(viewer.userId));
  const mod = signed && !ne && !staff && !owner ? await isMod(viewer, id) : false;
  const inside = signed && PA.inside(viewer, id);
  const role = staff ? "staff" : owner ? "owner" : mod ? "mod" : signed ? "member" : "anon";
  const floor = {}, searchFloor = {};
  for (const cls of ["chat", "tx"]) {
    let f;
    if (role === "staff") f = full(cls);
    else if (role === "owner") f = Math.min(pub(cls), Math.max(full(cls), W.owner_grant ? 0 : W.owner_since));
    else if (role === "mod") f = cfg.mods_all ? full(cls) : Math.max(full(cls), pub(cls) - MOD_EXTRA_MS);
    else f = inside ? pub(cls) : Math.max(pub(cls), W.aud_m);
    floor[cls] = Math.max(0, Math.floor(f));
    searchFloor[cls] = role === "member" || role === "anon" ? Math.max(floor[cls], W.wm_search) : floor[cls];
  }
  const fullPresence = role === "staff" || role === "owner" || (role === "mod" && cfg.mods_all);
  floor.presence = fullPresence ? floor.chat : Math.max(floor.chat, t - PRESENCE_MS);
  // CL8: why each floor is where it is - the scrollback's end marker ("Earlier messages aren't shown on this pad." for off /
  // window / earlier, "That's the start of this pad's chat history." for retention / start). The largest term wins (ties: the
  // first listed). The 24 h presence cap never changes it (spec §2.2).
  const why = {};
  for (const cls of ["chat", "tx"]) {
    const pick = (cands) => { let best = -Infinity, r = "start"; for (const [v, w] of cands) if (Number.isFinite(v) && v > best) { best = v; r = w; } return best > 0 ? r : "start"; };
    const retT = inf(ret[cls]) === Infinity ? -Infinity : t - 1000 * ret[cls];
    const fullC = [[retT, "retention"], [W.exp[cls], "retention"]];
    const pubC = [[win < inf(ret[cls]) ? t - 1000 * win : -Infinity, "window"], ...fullC, [W["wm_" + cls], "earlier"]];
    const pubWhy = () => (cfg.window_s === 0 ? "off" : pick(pubC));
    let w;
    if (role === "staff") w = pick(fullC);
    else if (role === "owner") w = floor[cls] >= pub(cls) ? pubWhy() : pick([...fullC, [W.owner_grant ? 0 : W.owner_since, "earlier"]]);
    else if (role === "mod") w = floor[cls] > full(cls) ? (cfg.window_s === 0 ? "window" : pubWhy()) : pick(fullC);
    else w = inside ? pubWhy() : cfg.window_s === 0 ? "off" : pick([...pubC, [W.aud_m, "earlier"]]);
    why[cls] = floor[cls] <= 0 ? "start" : w;
  }
  const level = inp.level;                  // CL3 fix-up: the snapshot's (the level reconcile applied)
  const pubPresence = Math.max(0, Math.floor(Math.max(pub("chat"), t - PRESENCE_MS)));
  const exempt = role === "staff" || role === "owner" || role === "mod";
  let bridgeOk = true;
  try { bridgeOk = require("./premium").bridgeAllowed(id); } catch (e) { bridgeOk = true; }
  const adult = !!(reg && reg.adult);
  const blocked = signed ? await blockedHere(viewer.userId, id) : false;
  const ageOk = !adult || (signed && (await attested(viewer.userId)));
  const history = (!SIGNED_ONLY || signed) && !blocked && ageOk && (bridgeOk || role === "owner" || role === "staff");
  const searchOn = cfg.search !== false;
  const downloadsOn = cfg.downloads != null ? cfg.downloads : level !== "approved";
  const eff = CL.effectiveWindows(id);
  const closed = { window: W.wm_chat > t - 1000 * Math.min(win, inf(ret.chat)) || W.wm_tx > t - 1000 * Math.min(win, inf(ret.tx)),
                   search: searchOn && W.wm_search > pub("chat") };
  return {
    // CL8 fix-up: pub.presence = the public presence floor (the chat floor and the 24 h cap) - a staff read below it is audited too
    // CL6 fix-up: blocked = a whole-bridge block or a ban from this pad's feed (or the whole feed) - a report then hides nothing
    rk: W.rk, role, exempt, signed, inside, adult, blocked, now: t, floor, why, searchFloor, pub: { chat: pub("chat"), tx: pub("tx"), presence: pubPresence },
    window_s: cfg.window_s, eff, searchOn, downloadsOn, mods_all: !!cfg.mods_all, level, aud: AUD[level] || "m",
    can: { history, deep: history, search: history && (searchOn || exempt), downloads: history && (role === "owner" || role === "staff" || downloadsOn) },
    start_ts: W.first_ts || null, audit: role === "staff" && (floor.chat < pub("chat") || floor.tx < pub("tx") || floor.presence < pubPresence), viewer: signed ? String(viewer.userId) : null,
    aud_m: W.aud_m,                      // CL10: a mod's download takes the PUBLIC floors - for a viewer outside an Approved era, from aud_m
    // the page compares it to re-filter after a change - CL3 fix-up: an opaque digest (the watermarks themselves would tell anyone
    // when the pad changed owner or opened up from Approved)
    v: crypto.createHash("sha256").update("chat-v:" + [cfg.updated || 0, W.wm_chat, W.wm_tx, W.wm_search, W.aud_m, W.owner_since, AUD[level] || "m",
                                                       cfg.window_s == null ? "n" : cfg.window_s].join(".")).digest("base64url").slice(0, 16),
    closed, open: W.open ? { scope: W.open.scope, effective: Number(W.open.effective) } : null,
  };
}
/** A view that shows nothing earlier than now (when computing the real one failed): the projection fails closed. */
function closedView(t = now()) {
  return { rk: null, role: "anon", exempt: false, signed: false, inside: false, adult: false, blocked: true, now: t, floor: { chat: t, tx: t, presence: t },
           why: { chat: "off", tx: "off" }, searchFloor: { chat: t, tx: t }, pub: { chat: t, tx: t, presence: t }, window_s: 0, eff: { chat: 0, tx: 0 }, searchOn: false, downloadsOn: false, mods_all: false,
           level: "approved", aud: "a", can: { history: false, deep: false, search: false, downloads: false }, start_ts: null, audit: false, viewer: null,
           v: "closed", closed: { window: false, search: false }, open: null };
}

/** What the live answer tells the page (spec §3.5 Live: {window_s, chat_s, tx_s, search, downloads, role, start_ts} + the
 *  viewer's floors, so an open page re-filters what it shows after a settings change). */
function historyBlock(V) {
  let explain = "/privacy#rooms";
  try { if (CL.cfg().notice) explain = "/privacy#chat-history"; } catch (e) { /* the policy text isn't up */ }
  return { window_s: V.window_s, chat_s: V.eff.chat, tx_s: V.eff.tx, search: V.searchOn, downloads: V.downloadsOn, role: V.role, start_ts: V.start_ts,
           floor: { chat: V.floor.chat, tx: V.floor.tx, presence: V.floor.presence }, now: V.now, grace_ms: GRACE_MS, v: V.v,
           pv: privacyVer(V.rk),                // CL8 fix-up: the privacy state - a change makes open pages re-check their lines
           deep: V.can.deep, scroll: !!(V.can.history && CL.on("history")), search_ok: V.can.search, explain,
           // CL9: the chat card's 🔍 (chatlogsearch.js) - signed in, history allowed, and the pad's search on (or full history:
           // with search off, `search` false + `find` true = "Only you and this pad's mods can search here.") - CL9 fix-up: and
           // scrollback on (chatlog.history): a result opens its line in the history, and search never opens the archive before it
           find: !!(V.can.search && CL.on("search") && CL.on("history")),
           // CL10: the chat card's ⋯ -> ⬇ Download chat log (chatlogexport.js): dl = this viewer may ask for a file here (signed in,
           // the pad allows downloads - or they own it / are staff -, the chatlog.downloads switch on; the established-account rule
           // is the POST's answer); dl_full = the file reaches past the public window (the owner, staff - presence lines too);
           // signed out on a pad that allows them: dl_signin ("Sign in to download"). CL10 fix-up: only while scrollback is on too
           // (chatlog.history) - a file is an archive read beyond the live tail; history off stops downloads as well
           dl: !!(V.can.downloads && CL.on("downloads") && CL.on("history")), dl_full: V.role === "owner" || V.role === "staff",
           ...(V.signed || !CL.on("downloads") || !CL.on("history") || !V.downloadsOn ? {} : { dl_signin: true }),
           // CL8: a signed-out viewer of a Public pad keeps the live tail and sees "Sign in to scroll back through earlier chat."
           // (decision 7) - only once scrollback is on
           ...(V.signed || !CL.on("history") ? {} : { signin: true }) };
}

// ── cursor bounds (feasibility H1): each floor becomes a cursor once, by one seek on chat_log_room_ts ──
/** {chat, tx, presence, min} = the first c at or after each floor in the archive (null = no archived line there). Cached per
 *  (room, floor minute) for 60 s. The archive reads (CL8+) query WHERE rk = ? AND c >= :cmin AND c < :before. */
async function cursorBounds(rk, floor) {
  const out = {};
  for (const cls of ["chat", "tx", "presence"]) {
    const f = Math.floor(Number(floor[cls]) || 0);
    const key = rk + "|" + Math.floor(f / 60e3);
    const c = CACHE.cur.get(key);
    if (c && Date.now() - c.at < 60e3) { out[cls] = c.v; continue; }
    const r = (await roQuery("SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [rk, Math.floor(f / 60e3) * 60e3]))[0];
    const v = r ? Number(r.c) : null;
    CACHE.cur.set(key, { v, at: Date.now() });
    if (CACHE.cur.size > 5000) CACHE.cur.delete(CACHE.cur.keys().next().value);
    out[cls] = v;
  }
  const vals = [out.chat, out.tx, out.presence].filter((x) => x != null);
  out.min = vals.length ? Math.min(...vals) : null;
  return out;
}

// ── the projection ──
/** May a viewer with view V see a line said with access level `aud`? An unknown aud counts as the pad's level now. */
function audOk(aud, V) {
  const a = aud === "p" || aud === "m" || aud === "a" ? aud : V.aud;
  if (a === "p") return true;
  if (a === "m") return V.signed;
  return V.inside;
}
/**
 * Stage 1 (before names are resolved): drop what this viewer may not see. ctx = {view, jc (the page's join cursor, null for a
 * history read), now}. -> {items, left: {privacy, removed}} - kept items are the SAME objects (stage 2 copies them).
 */
function filter(items, ctx) {
  const V = ctx.view, t = ctx.now || V.now, jc = ctx.jc == null ? null : Number(ctx.jc);
  const left = { privacy: 0, removed: 0 };
  const out = [];
  // CL10: ctx.noRemoved - a download leaves taken-down lines out for everyone (the owner's / staff's 30-day appeal copy never goes
  // into a file that later removals can't reach); they are counted as "removed by moderators"
  const keepRemoved = !ctx.noRemoved && (V.role === "owner" || V.role === "staff");
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    const cls = classOf(it.k);
    const ts = Number(it.ts) || 0;
    const grace = jc != null && Number(it.c) > jc && ts >= t - GRACE_MS;
    if (!(ts >= V.floor[cls]) && !grace) continue;
    if (!audOk(it.aud, V)) continue;
    // CL3 fix-up + the owner's decision-9 change (privacyOf): the people the sticky set leaves out (!bridge hide, a kind Pepe never
    // said, forget / delete / staff; !transcripts off for 🎙 lines), any hidden person's joins / leaves / mic lines and Pepe's
    // anonymised stand-ins are LEFT OUT; an incognito person's chat / 🎙 line stays (dress shows it as "someone")
    if (privacyOf(it) === "out") { left.privacy++; continue; }
    if ((it.rm_at != null || it.purged) && !keepRemoved) { left.removed++; continue; }
    out.push(it);
  }
  return { items: out, left };
}
/** Hidden people in a roster: incognito -> "someone" (a website Incognito ON hides at once, before Pepe's next roster); Train 3
 *  review fix-up: LEFT OUT (!bridge hide, a kind Pepe never said, forget / delete / staff) -> not listed at all (the owner's rule:
 *  "!bridge hide = left out everywhere" - never a "someone" entry that says they are there). Fails closed while the set loads
 *  (everyone counts as left out: nobody named). Pepe's own anonymous stand-ins carry no hash and pass as they are. */
function roster(list) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    if (!u || typeof u !== "object") continue;
    if (u.anon || !u.login) { out.push(Object.assign({}, SOMEONE)); continue; }
    const k = kindNow(hashOf(u.login));
    if (k === "out") continue;
    if (k) { out.push(Object.assign({}, SOMEONE)); continue; }
    out.push(pick(u, ROSTER_U));                                // 1.99afl (S6): built from a whitelist, never the entry itself
  }
  return out;
}
const SOMEONE = Object.freeze({ anon: true, display: "someone" });
// 1.99afl (S6 - the incognito spec's rollback floor): the projection BUILDS every object it hands out from the fields its kind may
// show; it never copies an item (or a roster entry) and deletes the fields it knows about. A field nobody listed here - a server-
// only hash (ah / ahs), a stamp (k3), a later build's veiled identity or hidden words - can never reach a page, an API answer or a
// download, whatever the stored item (bridge_feed, chat_log.d) holds. A field a page needs must be added here.
const OUT_COMMON = Object.freeze(["c", "ts", "k"]);
const OUT_KIND = Object.freeze({
  msg: Object.freeze(["text"]), tx: Object.freeze(["text", "id"]), topic: Object.freeze(["text"]),
  join: Object.freeze([]), leave: Object.freeze([]), mic: Object.freeze([]), unmic: Object.freeze(["ms"]),
  live: Object.freeze(["who", "pad", "what", "link", "np"]),          // 🎥 bridge.liveNotice
  note: Object.freeze(["w", "s", "o", "sc"]),                         // 📜 bridge.noteItem
});
const OUT_U = Object.freeze(["login", "display", "self", "bot", "web", "acct", "unresolved"]);
const ROSTER_U = Object.freeze(["login", "display", "self", "bot", "on_cam", "on_mic", "src", "unresolved", "acct", "web"]);
/** The listed fields of src (own, defined) copied into `into`. */
function pick(src, keys, into = {}) {
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) into[k] = src[k];
  return into;
}
/**
 * Stage 2: copies, never the feed's own objects. lookup(u) -> the name cache entry {acc, priv} (bridge.resolveNames) or
 * undefined. Private-activity people are "someone" in presence lines; a web member with no live account is "former member";
 * hidden people's names inside text become "someone"; a removed line (owner / staff only) keeps its text until purged. The
 * owner's decision-9 change: an incognito person's line is "someone" (privacyOf "anon").
 */
function dress(items, ctx) {
  const lookup = typeof ctx.lookup === "function" ? ctx.lookup : () => undefined;
  const out = [];
  for (const it of items) {
    // 1.99afl (S6): built from the whitelist (OUT_COMMON + OUT_KIND) - never aud, rm_*, purged, ah, ahs, k3 or anything unlisted
    const o = pick(it, OUT_COMMON);
    pick(it, OUT_KIND[it.k] || [], o);
    // the owner's decision-9 change: an incognito person's line is "someone" - no login, display name, avatar, looks or flair, and
    // no 🎙 id (it is a hash of their login and the words: a viewer could test it against a guess). Asked again here, not taken
    // from filter(): whatever the set says now never names them ("out" since filter: still anonymised, the next answer drops it).
    // _sh (never serialised: not enumerable) = their hash, so the viewer's OWN lines still get their 🗑 Remove my line.
    const p = privacyOf(it);
    const u = it.u && typeof it.u === "object" ? it.u : null;
    if ((p === "anon" || p === "out") && !it.purged) {
      o.u = Object.assign({}, SOMEONE);
      if (o.k === "tx") delete o.id;
      const sh = speakerHash(it);
      if (sh) Object.defineProperty(o, "_sh", { value: sh, enumerable: false });
    } else if (u && u.anon) o.u = Object.assign({}, SOMEONE);
    else if (u && u.former) o.u = { former: true };
    else if (u) {
      const e = u.login ? lookup(u) : undefined;
      if (/^u:/i.test(String(u.login || "")) && e && e.acc === null) o.u = { former: true };
      else if (PRESENCE.has(o.k) && e && e.acc && e.priv) o.u = { anon: true, display: "someone" };
      else o.u = pick(u, OUT_U);
    }
    if (typeof o.text === "string") o.text = redact(o.text);
    if (o.k === "live") { if (typeof o.who === "string") o.who = redact(o.who); if (typeof o.what === "string") o.what = redact(o.what); }
    if (it.purged) { o.removed = { purged: true }; delete o.text; if (o.u) o.u = { anon: true, display: "someone" }; }
    else if (it.rm_at != null) {
      // CL6: who hid it, by name (ctx.rmNames = chatlogmod.rmNames: rm_by -> username) - never an account id. CL6 fix-up: as the
      // pad's OWNER sees it (anyone but staff - ctx.view.role; no view = the owner's rules), a line its author removed or a "minor"
      // report hid is SEALED - no words, no speaker, no reason ("Removed by its author" / "Hidden by PATV staff": nobody can undo a
      // self-removal, and "hidden after a report" would say why); a staff member hides as "PATV staff", never by name
      const staffView = !!(ctx.view && ctx.view.role === "staff");
      const by = String(it.rm_by || "").replace(/:.*/, "");
      if (!staffView && (by === "self" || by === "report")) {
        o.removed = { at: Number(it.rm_at), by: by === "self" ? "self" : "staff", sealed: true };
        delete o.text; delete o.id;
        if (o.u) o.u = { anon: true, display: "someone" };
      } else {
        const who = (by === "mod" || staffView) && ctx.rmNames && ctx.rmNames.get ? ctx.rmNames.get(it.rm_by) : null;
        o.removed = { at: Number(it.rm_at), by, why: it.rm_why ? String(it.rm_why).slice(0, 200) : "", ...(who ? { who: String(who) } : {}) };
      }
    }
    out.push(o);
  }
  return out;
}
/** Both stages for the read paths that resolve names themselves (CL8+). ctx = {view, jc?, now?, names: async (users) -> lookup}. */
async function project(items, ctx) {
  const f = filter(items, ctx);
  const lookup = ctx.names ? await ctx.names(f.items.map((it) => it.u).filter(Boolean)) : null;
  // CL6: the owner's / staff's muted rows say who hid a line
  let rmNames = null;
  if (f.items.some((it) => it.rm_at != null && !it.purged)) { try { rmNames = await require("./chatlogmod").rmNames(f.items); } catch (e) { rmNames = null; } }
  return { items: dress(f.items, { view: ctx.view, lookup, rmNames }), left: f.left };
}
/** A chat_log row -> a feed item (the shape the projection and the renderers take). */
function itemOf(r) {
  let d = {};
  try { d = JSON.parse(r.d) || {}; } catch (e) { d = {}; }
  const it = Object.assign({}, d && typeof d === "object" ? d : {}, { c: Number(r.c), ts: Number(r.ts), k: r.k });
  if (r.text != null) it.text = r.text;
  if (r.tx) it.id = r.tx;
  // CL6: a purged line's who is "h:<hash>" (the login is gone; Pepe's removed list still matches) - never a login to resolve.
  // Owner change: so is an incognito person's line Pepe sent anonymised - the hash rides as `ah` (server-only: dress drops it)
  const login = r.who && !String(r.who).startsWith("h:") ? r.who : null;
  if ((d && d.u) || login) it.u = Object.assign({}, (d && d.u) || {}, login ? { login } : {});
  if (r.who && /^h:[0-9a-f]{20}$/.test(String(r.who))) it.ah = String(r.who).slice(2);
  else delete it.ah;
  // Train 3 review: the speaker's other incognito hashes (d.ahs - Pepe's data.anon.hs) ride only beside an "h:" who
  if (it.ah && Array.isArray(it.ahs)) {
    const more = it.ahs.filter((x) => typeof x === "string" && HASH20.test(x) && x !== it.ah);
    if (more.length) it.ahs = more; else delete it.ahs;
  } else delete it.ahs;
  it.aud = r.aud;
  if (r.rm_at != null) { it.rm_at = Number(r.rm_at); it.rm_by = r.rm_by || null; it.rm_why = r.rm_why || null; }
  if (r.purged) it.purged = 1;
  return it;
}

// ── redaction: hidden people's names inside other lines ──
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");     // the u flag allows no other identity escapes ("-" needs none here)
/** CL3 fix-up: a regex source matching any of `words` (lower-cased), factored as a TRIE - one branch per next character, a
 *  shorter name as an optional tail. The flat "a|b|c|..." alternation of up to 3,600 names was tried name by name at every
 *  position of every line (40 ms per 200-line answer at 1,800 names, 130-180 ms at 3,600); the trie fails after one character
 *  on almost every branch. Longest first still holds: the optional tail is greedy and backtracks to the shorter name when the
 *  word boundary after the longer one fails. */
function trieSource(words) {
  const root = new Map();
  for (const w of words) {
    let n = root;
    for (const ch of Array.from(w)) { if (!n.has(ch)) n.set(ch, new Map()); n = n.get(ch); }
    n.set("", null);                                   // a name ends here
  }
  const build = (n) => {
    const alts = [];
    for (const [ch, child] of n) if (ch !== "") alts.push(escRe(ch) + build(child));
    if (!alts.length) return "";
    const body = alts.length === 1 ? alts[0] : "(?:" + alts.join("|") + ")";
    return n.has("") ? "(?:" + body + ")?" : body;
  };
  return build(root);
}
/** The regex over every name of every person hidden NOW (<= 400 people, NAMES_PEOPLE_MAX), longest first; recompiled only when
 *  the set changes. People past the cap are counted (OVER) and shown on /admin/bridge - never silently dropped. */
let OVER = 0;
function compile() {
  if (RE_V === NAMES_V) return RE;
  const terms = new Set();
  let coll = 0, people = 0, over = 0;
  for (const [h, r] of NAMES) {
    if (!CL.isHiddenHash(h) && hubKind(h) == null) continue;   // (Train 3 review: hidden by either store)
    if (++people > NAMES_PEOPLE_MAX) { over++; continue; }
    for (const n of [r.login, ...(r.names || [])]) {
      const s = String(n == null ? "" : n).replace(/^@+/, "").trim();
      if (Array.from(s).length < NAME_MIN || /^u:/i.test(s)) continue;
      if (STOP.has(s.toLowerCase())) { coll++; continue; }
      terms.add(s.toLowerCase());
    }
  }
  COLLISIONS = coll;
  OVER = over;
  if (over) console.error(`[chatlogview] ${over} hidden people past the ${NAMES_PEOPLE_MAX}-person redaction cap - their names aren't redacted`);
  RE = terms.size ? new RegExp("(?<![\\p{L}\\p{N}_])@?(?:" + trieSource([...terms]) + ")(?![\\p{L}\\p{N}_])", "giu") : null;
  RE_V = NAMES_V;
  const src = RE ? RE.source : "";
  if (src !== RE_SRC) { RE_SRC = src; PV++; }          // CL8 fix-up: a name redacted (or no longer) - open pages re-dress their lines
  return RE;
}
function redact(s) {
  if (typeof s !== "string" || !s) return s;
  const re = compile();
  return re ? s.replace(re, "someone") : s;
}

// ── the hidden-names job: when a hash enters the hidden set, derive its names from the archive (+ the live feeds) ──
let whoBuilt = null;
function whoReady() {
  if (!whoBuilt) {
    whoBuilt = (async () => {
      const rows = await roQuery("SELECT DISTINCT who FROM chat_log WHERE who IS NOT NULL");
      for (const r of rows) if (r.who && !String(r.who).startsWith("h:")) WHO.set(hashOf(r.who), lower(r.who));   // CL6: "h:" = a purged line's
    })().catch((e) => { whoBuilt = null; console.error("[chatlogview] who map:", e.message); });
  }
  return whoBuilt;
}
/** bridge.ingest / bridge.load: every speaker key seen, with the display name it showed (CL3 fix-up: also the people in the
 *  rooms' rosters, and everything the live feeds hold after a restart - Pepe anonymises a hidden person's NEW items, so the
 *  only places their login is still seen are what was kept from before). The archive may be off: then these are the only
 *  places a login is seen. */
function noteWho(login, display) {
  if (!login) return;
  const l = lower(login);
  const h = hashOf(l);
  const d = String(display == null ? "" : display).replace(/<[^>]*>/g, "").trim().slice(0, 40);
  if (d && d.toLowerCase() !== l) {
    let s = DISP.get(l);
    if (!s) { s = []; DISP.set(l, s); if (DISP.size > 50000) DISP.delete(DISP.keys().next().value); }
    if (!s.some((x) => x.toLowerCase() === d.toLowerCase())) { s.unshift(d); if (s.length > NAMES_PER) s.length = NAMES_PER; }
  }
  if (WHO.get(h) === l) return;
  WHO.set(h, l);
  if (WHO.size > 200000) WHO.delete(WHO.keys().next().value);
  if ((CL.isHiddenHash(h) || hubHas(h)) && !NAMES.has(h)) scheduleNames();
}
/** hubhidden holds h now (memory; never "while it loads" - the names job would run for every login seen). */
function hubHas(h) { const H = hub(); try { return !!(H && H.isHiddenHash(h)); } catch (e) { return false; } }
function hubHashes() { const H = hub(); try { return H && H.hiddenHashes ? H.hiddenHashes() : []; } catch (e) { return []; } }
/** Train 3 review: hubhidden pushed its set (on every change, and once at its start-up): when what it hides - or how - really
 *  changed, the hidden-names job runs again and open pages re-check what they show (PV, historyBlock.pv). Only once this module
 *  has started (hubhidden's own tests never open the archive tables). */
let HUB_SIG = crypto.createHash("sha1").update("").digest("hex");     // (an empty set: nothing to re-check)
function hubChanged() {
  if (!ready) return;
  const H = hub();
  let sig = "";
  try {
    const hs = H ? H.hiddenHashes().sort() : [];
    sig = crypto.createHash("sha1").update(hs.map((h) => h + (H.isLeftOutHash(h) ? "o" : "a")).join(",")).digest("hex");
  } catch (e) { sig = "?" + Date.now(); }
  if (sig === HUB_SIG) return;
  HUB_SIG = sig;
  PV++;
  scheduleNames();
}
/** The 8 most recent distinct display names a login showed (the live feeds first, then the rosters', then the archive's rows). */
async function namesFor(login) {
  const seen = new Map();
  const add = (v) => {
    const s = String(v == null ? "" : v).replace(/<[^>]*>/g, "").trim().slice(0, 40);
    if (s && !seen.has(s.toLowerCase()) && seen.size < NAMES_PER) seen.set(s.toLowerCase(), s);
  };
  try {
    for (const R of require("./bridge")._rooms.values()) {
      for (let i = R.feed.length - 1; i >= 0; i--) { const it = R.feed[i]; if (loginOf(it) && lower(loginOf(it)) === login) add(it.u.display); }
    }
  } catch (e) { /* no bridge */ }
  for (const d of DISP.get(login) || []) add(d);
  try {
    for (const r of await roQuery("SELECT d FROM chat_log WHERE who = ? ORDER BY c DESC LIMIT 400", [login])) {
      if (seen.size >= NAMES_PER) break;
      try { const d = JSON.parse(r.d); if (d && d.u) add(d.u.display); } catch (e) { /* skip */ }
    }
  } catch (e) { /* the archive isn't there */ }
  return [...seen.values()];
}
let namesBusy = null, namesAgain = false;
function scheduleNames() {
  if (namesBusy) { namesAgain = true; return namesBusy; }
  namesBusy = refreshNames().catch((e) => console.error("[chatlogview] hidden names:", e.message))
    .then(() => { namesBusy = null; if (namesAgain) { namesAgain = false; return scheduleNames(); } return null; });
  return namesBusy;
}
/** Rows for hashes hidden now (new, or older than 6 h), none for the others. -> {set, dropped} */
async function refreshNames() {
  await init();
  await whoReady();
  const hidden = new Set([...CL.hiddenHashes(), ...hubHashes()]);   // (Train 3 review: either store's)
  const t = now();
  const gone = [...NAMES.keys()].filter((h) => !hidden.has(h));
  const want = [...hidden].filter((h) => WHO.has(h) && (!NAMES.has(h) || t - (NAMES.get(h).updated || 0) > NAMES_REFRESH_MS));
  const rows = [];
  for (const h of want) {
    const names = await namesFor(WHO.get(h));
    // CL7: a refresh never drops a name it had - the retention purge deletes a hidden person's old lines (and the display names
    // they carried) while other people's lines still inside retention can name them
    const prev = NAMES.get(h);
    if (prev && prev.login === WHO.get(h)) {
      for (const n of prev.names) if (names.length < NAMES_PER && !names.some((x) => x.toLowerCase() === String(n).toLowerCase())) names.push(String(n));
    }
    rows.push([h, WHO.get(h), names]);
  }
  if (!gone.length && !rows.length) return { set: 0, dropped: 0 };
  await tx(async () => {
    for (const h of gone) await runQuery("DELETE FROM chatlog_hidden_names WHERE h = ?", [h]);
    for (const [h, login, names] of rows) {
      await runQuery(`INSERT INTO chatlog_hidden_names (h, login, names, updated) VALUES (?, ?, ?, ?)
                      ON CONFLICT(h) DO UPDATE SET login = excluded.login, names = excluded.names, updated = excluded.updated`, [h, login, JSON.stringify(names), t]);
    }
  });
  for (const h of gone) NAMES.delete(h);
  for (const [h, login, names] of rows) NAMES.set(h, { login, names, updated: t });
  NAMES_V++;
  return { set: rows.length, dropped: gone.length };
}

// ── private activity (the stories.privateLogins rule: the profile's Analytics section or its Rooms panel hidden) ──
/** -> {logins: Set(lower login), ids: Set(userId)} of the ones that keep their activity private. Fails closed. */
async function privateFlags({ logins = [], ids = [] } = {}) {
  const out = { logins: new Set(), ids: new Set() };
  let PL = null;
  try { PL = require("./profilelayout"); } catch (e) { PL = null; }
  const hidden = async (uid) => {
    if (!PL) return true;
    try { const L = await PL.get(uid); return PL.stateOf(L, "analytics") === "hidden" || PL.stateOf(L, "an_rooms") === "hidden"; } catch (e) { return true; }
  };
  const L = [...new Set(logins.map(lower))].filter(Boolean);
  for (let i = 0; i < L.length; i += 400) {
    const part = L.slice(i, i + 400);
    let users;
    try { users = await getQuery(`SELECT userId, camfrogUsername FROM users WHERE lower(camfrogUsername) IN (${part.map(() => "?").join(",")})`, part); }
    catch (e) { for (const l of part) out.logins.add(l); continue; }
    for (const u of users) if (await hidden(u.userId)) out.logins.add(lower(u.camfrogUsername));
  }
  for (const id of [...new Set(ids.map(String))].filter(Boolean)) if (await hidden(id)) out.ids.add(id);
  return out;
}

// ── the signed join cursor ──
// CL3 fix-up: bound to the viewer too (their account id, "-" signed out) - another account's cursor counts as forged
const jcWho = (who) => (who == null || who === "" ? "-" : String(who));
const jcMac = (roomId, body, who) => crypto.createHmac("sha256", SECRET).update("chat-jc:" + String(roomId) + "|" + jcWho(who) + "|" + body).digest("base64url").slice(0, 22);
/** The page's join cursor: the feed cursor when it loaded + an HMAC over (room, viewer, cursor, issue time). */
function signJc(roomId, c, t = now(), who = null) {
  const body = Math.max(0, Math.floor(Number(c) || 0)) + "." + Math.floor(t / 1000);
  return "j1." + body + "." + jcMac(roomId, body, who);
}
/** -> {ok: true, c} | {ok: false, expired?}. Missing / forged / from another room or viewer = not ok (the caller counts it as
 *  now). A FRESH load (after=0) never takes one (bridge.liveView): the grace is for a page's own reconnects only. */
function checkJc(tok, roomId, t = now(), who = null) {
  const m = /^j1\.(\d{1,15})\.(\d{9,12})\.([A-Za-z0-9_-]{22})$/.exec(String(tok == null ? "" : tok));
  if (!m) return { ok: false };
  const want = jcMac(roomId, m[1] + "." + m[2], who);
  const a = Buffer.from(m[3]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
  const issued = Number(m[2]) * 1000;
  if (issued > t + 60e3) return { ok: false };
  if (t - issued > JC_TTL) return { ok: false, expired: true };
  return { ok: true, c: Number(m[1]) };
}

// ── quotes and mic clips (decision 13): only lines inside the quoter's view, pad access and the bridge perk ──
/** CL3 fix-up: the view a quote / clip is picked in - or null when this viewer may not quote on the pad at all (signed out, no
 *  full pad access, no bridge perk; never an error). A quote or a clip is a PUBLIC post: it takes the NON-exempt floors (the
 *  public window), so an owner or a room mod can't republish lines the forward-only rule keeps out of public view. */
async function quoteView(viewer, roomId) {
  try {
    if (!viewer || !viewer.userId) return null;
    const PA = require("./padaccess");
    await PA.init();
    if (!PA.full(viewer, roomId)) return null;
    if (!require("./premium").bridgeAllowed(roomId)) return null;
    return await view(roomId, viewer, { nonExempt: true });
  } catch (e) { console.error("[chatlogview] quote view:", e.message); return null; }
}
/** The feed items this viewer may quote / clip from (the same objects, in order; no join-cursor grace) - [] without access. */
async function quotableFeed(viewer, roomId, feed) {
  const V = await quoteView(viewer, roomId);
  return V ? filter(Array.isArray(feed) ? feed : [], { view: V, jc: null }).items : [];
}
/** -> true when every item is one this viewer may quote on the pad now. */
async function quotable(viewer, roomId, items) {
  try {
    const list = Array.isArray(items) ? items : [items];
    if (!list.length || list.some((x) => !x)) return false;
    const V = await quoteView(viewer, roomId);
    return !!V && filter(list, { view: V, jc: null }).items.length === list.length;
  } catch (e) { console.error("[chatlogview] quotable:", e.message); return false; }
}
/** redact() once the hidden people's names are loaded (a page render, the room list) - fails closed: "" when they can't be. */
async function redactLoaded(s) {
  try { await init(); } catch (e) { return typeof s === "string" ? "" : s; }
  return redact(s);
}

// ── staff reads below the public floor: an audit row, coalesced per (user, room, kind, 10 minutes) ──
// CL8 fix-up: the row covers EVERY span read in its 10 minutes - a later page further back (or newer) widens its from_ts / to_ts
// (it kept only the first page's, so deeper reads in the same 10 minutes were never recorded). -> wrote or widened a row?
// CL10 fix-up: opts.strict (a download audits its span BEFORE the file is sent) - a row that couldn't be written or widened throws
// (code "audit") instead of being logged and forgotten, and a coalesced entry whose own insert failed is written afresh.
async function auditRead(V, roomId, kind, fromTs, toTs, opts = {}) {
  if (!V || V.role !== "staff" || !V.viewer || V.rk == null) return false;
  const strict = !!(opts && opts.strict);
  const failed = () => Object.assign(new Error("audit"), { code: "audit" });
  const key = V.viewer + "|" + V.rk + "|" + kind;
  const t = now();
  const a = Math.floor(Number(fromTs)) || null, b = Math.floor(Number(toTs)) || null;
  const lo = a == null ? b : b == null ? a : Math.min(a, b), hi = a == null ? b : b == null ? a : Math.max(a, b);
  const c = CACHE.audit.get(key);
  if (c && t - c.at < 10 * 60e3 && !(strict && (await c.id) == null)) {
    const wider = (lo != null && (c.lo == null || lo < c.lo)) || (hi != null && (c.hi == null || hi > c.hi));
    if (!wider) return false;
    if (lo != null && (c.lo == null || lo < c.lo)) c.lo = lo;
    if (hi != null && (c.hi == null || hi > c.hi)) c.hi = hi;
    try {
      const id = await c.id;
      if (id != null) await runQuery("UPDATE chatlog_views SET from_ts = ?, to_ts = ? WHERE id = ?", [c.lo, c.hi, id]);
    } catch (e) {
      console.error("[chatlogview] audit:", e.message);
      if (strict) throw failed();
    }
    return true;
  }
  const e = { at: t, lo, hi, id: null };
  e.id = runQuery("INSERT INTO chatlog_views (user_id, rk, who, kind, from_ts, to_ts, why, at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)",
                  [V.viewer, V.rk, kind, lo, hi, t]).then((r) => (r && r.id != null ? r.id : null), (err) => { console.error("[chatlogview] audit:", err.message); return null; });
  CACHE.audit.set(key, e);
  if (CACHE.audit.size > 5000) CACHE.audit.delete(CACHE.audit.keys().next().value);
  if ((await e.id) == null && strict) { CACHE.audit.delete(key); throw failed(); }
  return true;
}

// ── CL8 fix-up: the privacy state, for open pages ──
/** An opaque digest of the privacy state a page's lines depend on: the sticky hidden set and the redaction (every pad), and this
 *  room's takedowns. When it changes, the page re-checks the lines it holds (chatloghist /history/check). Changes at a restart. */
function privacyVer(rk) {
  compile();
  const g = rk == null ? 0 : GONE.get(Number(rk)) || 0;
  return crypto.createHash("sha256").update("chat-pv:" + PV_SALT + ":" + PV + ":" + g).digest("base64url").slice(0, 12);
}
/** The sticky hidden set's version (chatloghist rebuilds its SQL list of left-out logins when it moves). */
const hiddenVer = () => PV;
/** chatlogmod: a line of this room was taken down (or restored) - its open pages re-check what they show. */
function noteGone(roomId) {
  const r = ROWS.get(String(roomId || ""));
  if (r && r.rk != null) GONE.set(r.rk, (GONE.get(r.rk) || 0) + 1);
  else PV++;                                 // a room no page has viewed since boot: every page re-checks (rare)
}
/** The public floor of an item's class for view V (chat, 🎙, presence - the 24 h cap): a staff read below it is audited. */
function pubFloor(V, k) {
  const p = (V && V.pub) || {};
  const cls = classOf(k);
  if (cls === "presence") return p.presence != null ? p.presence : Math.max(Number(p.chat) || 0, Number(V && V.now) - PRESENCE_MS);
  return Number(p[cls]) || 0;
}

// ── "Also open earlier history" ──
/** A pending open for the room ({id, scope, requested, effective, by_user}) or null. */
const pendingOpen = (roomId) => OPENS.get(String(roomId || "")) || null;
/** The owner asks: effective OPEN_DELAY_MS later. -> the row. Throws {status, code} on a refusal. */
async function requestOpen(roomId, scope, actorId) {
  await init();
  const id = String(roomId || "");
  if (!["window", "search", "both"].includes(scope)) throw Object.assign(new Error("Pick what to open: the window, search or both."), { status: 400, code: "bad_scope", refuse: true });
  const V = await view(id, null);
  if (OPENS.get(id)) throw Object.assign(new Error("An earlier-history opening is already scheduled."), { status: 409, code: "pending", refuse: true });
  const something = scope === "window" ? V.closed.window : scope === "search" ? V.closed.search : V.closed.window || V.closed.search;
  if (!something) {
    throw Object.assign(new Error("Nothing earlier is closed there - every line your settings allow is already shown."), { status: 409, code: "nothing", refuse: true });
  }
  // CL3 fix-up: the "already scheduled" check and the insert are one step in the room's serial section (two requests at once
  // made two pending rows and two 📜 notes, and the one OPENS didn't track stayed pending for good)
  return serialRoom(id, async () => {
    if (OPENS.get(id)) throw Object.assign(new Error("An earlier-history opening is already scheduled."), { status: 409, code: "pending", refuse: true });
    const t = now();
    const row = await rowFor(id, null);
    const eff = t + OPEN_DELAY_MS;
    let newId = null;
    await tx(async () => {
      await runQuery("INSERT INTO chatlog_open (rk, scope, requested, effective, by_user, state) VALUES (?, ?, ?, ?, ?, 'pending')", [row.rk, scope, t, eff, actorId || null]);
      newId = (await getQuery("SELECT MAX(id) AS id FROM chatlog_open WHERE rk = ?", [row.rk]))[0].id;
      const next = Object.assign({}, row.inputs || {}, { changed_at: t });
      await runQuery("UPDATE chatlog_rooms SET inputs = ? WHERE rk = ?", [JSON.stringify(next), row.rk]);
      row.inputs = next;
    });
    const op = { id: newId, rk: row.rk, scope, requested: t, effective: eff, by_user: actorId || null, state: "pending" };
    OPENS.set(id, op);
    return op;
  });
}
/** The owner cancels while it's pending. -> true | false (nothing pending). */
async function cancelOpen(roomId) {
  await init();
  const id = String(roomId || "");
  return serialRoom(id, async () => {
    const op = OPENS.get(id);
    if (!op) return false;
    await runQuery("UPDATE chatlog_open SET state = 'cancelled' WHERE id = ? AND state = 'pending'", [op.id]);
    OPENS.delete(id);
    return true;
  });
}
/** CL6 (staff, chatlogmod.ownerGrant): let the pad's owner read from before they became the owner (owner_grant = when it was
 *  granted), or take it back. A new owner clears it (reconcile). -> changed? */
async function setOwnerGrant(roomId, on) {
  await init();
  const id = String(roomId || "");
  return serialRoom(id, async () => {
    const row = await rowFor(id, null);
    const v = on ? now() : null;
    if ((row.owner_grant != null) === !!on) return false;
    await runQuery("UPDATE chatlog_rooms SET owner_grant = ? WHERE rk = ?", [v, row.rk]);
    row.owner_grant = v;
    return true;
  });
}
/** Apply the opens that came due in rooms nobody viewed (every 10 minutes; view() applies them too). */
async function sweepOpens() {
  for (const id of [...OPENS.keys()]) {
    const op = OPENS.get(id);
    if (op && Number(op.effective) <= now()) await reconcileNow(id);
  }
}
/** CL3 fix-up: a pad's tier change is tracked from when it happens, not from when someone next views the pad - every 10 minutes
 *  each room with a chatlog_rooms row whose tier differs from the one tracked (or has none tracked yet) is reconciled (the
 *  downgrade grace then starts within 10 minutes of the change, and exp_* moves for rooms nobody views). In memory: no query
 *  for a room whose tier didn't change. -> rooms reconciled */
async function sweepTiers() {
  if (!(await ensurePremium())) return 0;
  let n = 0;
  const ids = new Set(ROWS.keys());
  // (+ the rows the archive made since that no view or hook has loaded yet)
  try { for (const r of await getQuery("SELECT room_id FROM chatlog_rooms")) ids.add(r.room_id); } catch (e) { /* no archive tables yet */ }
  for (const id of ids) {
    const tier = padTier(id), T = TIERS.get(id);
    if (!tier || (T && T.tier === tier)) continue;
    await reconcileNow(id);
    n++;
  }
  return n;
}
/** CL7 (chatlogpurge.js): the room's tier tracking {tier, prev, drop_at, lapsed} (a copy), or null while none is recorded. */
function tierOf(roomId) {
  const T = TIERS.get(String(roomId || ""));
  return T ? { tier: T.tier, prev: T.prev, drop_at: T.drop_at, lapsed: lapsedOf(T).map((e) => ({ tier: e.tier, at: e.at })) } : null;
}
/** CL7 fix-up (chatlogpurge.js): the archive's first line moved forward (the purge deleted the ones before it) - the cached row
 *  follows (view().start_ts: "That's the start of this pad's chat history"). first_ts null = no line left (the next one sets it). */
function noteFirst(roomId, firstTs) {
  const r = ROWS.get(String(roomId || ""));
  if (r) { r.first_ts = firstTs != null && Number(firstTs) > 0 ? Number(firstTs) : null; r.at = Date.now(); }
}
/** CL7 (chatlogpurge.js): raise the room's expiry watermarks exp_* to the purge's deletion cutoff {chat, tx} (ms) - exactly, in
 *  the room's serial section (the cached row follows). Only ever up: a lower cutoff (an upgrade after the grace) moves nothing.
 *  -> {chat, tx} the watermarks now | null (no chatlog_rooms row) */
async function raiseExp(roomId, cut) {
  await init();
  const id = String(roomId || "");
  return serialRoom(id, async () => {
    if (!ROWS.has(id) && !(await getQuery("SELECT 1 FROM chatlog_rooms WHERE room_id = ?", [id])).length) return null;
    const row = await rowFor(id, null);
    const set = {};
    for (const cls of ["chat", "tx"]) {
      const v = Math.floor(Number(cut && cut[cls]) || 0);
      if (v > row["exp_" + cls]) set["exp_" + cls] = v;
    }
    const cols = Object.keys(set);
    if (cols.length) {
      await tx(async () => {
        await runQuery(`UPDATE chatlog_rooms SET ${cols.map((c) => `${c} = MAX(${c}, ?)`).join(", ")} WHERE rk = ?`, [...cols.map((c) => set[c]), row.rk]);
      });
      for (const c of cols) row[c] = set[c];
    }
    return { chat: row.exp_chat, tx: row.exp_tx };
  });
}
/** The owner sync's per-room extras: {open_at, changed_at, wm_search}. */
function syncInfo(roomId) {
  const id = String(roomId || "");
  const r = ROWS.get(id), op = OPENS.get(id);
  return { open_at: op ? Number(op.effective) : null, changed_at: Math.max((r && r.inputs && r.inputs.changed_at) || 0, op ? Number(op.requested) : 0) || null,
           wm_search: r ? r.wm_search : 0 };
}

// ── the 📜 note line (a settings change, an earlier-history opening) in the pad's chat ──
function noteLine(roomId, note) {
  try {
    const B = require("./bridge");
    if (B.noteItem) return B.noteItem(roomId, note).catch((e) => { console.error("[chatlogview] note:", e.message); return false; });
  } catch (e) { console.error("[chatlogview] note:", e.message); }
  return Promise.resolve(false);
}

/** CL3 fix-up (account deletion, accountdelete.js): the owner the watermarks last applied never keeps a deleted account's id -
 *  chatlog_rooms.owner_id and inputs.owner become null (a deleted account owns no pad: deletion is refused while it does).
 *  -> rows changed */
async function forgetOwner(userId) {
  const uid = String(userId || "");
  if (!uid) return 0;
  let rows;
  try { rows = await getQuery("SELECT rk, room_id, owner_id, inputs FROM chatlog_rooms WHERE owner_id = ? OR inputs LIKE ?", [uid, "%" + JSON.stringify(uid) + "%"]); }
  catch (e) { return 0; }                              // no archive tables yet
  let n = 0;
  for (const r of rows) {
    let inp = null;
    try { inp = r.inputs ? JSON.parse(r.inputs) : null; } catch (e) { inp = null; }
    const hit = String(r.owner_id || "") === uid || !!(inp && inp.owner === uid);
    if (!hit) continue;
    if (inp && inp.owner === uid) inp.owner = null;
    await runQuery("UPDATE chatlog_rooms SET owner_id = CASE WHEN owner_id = ? THEN NULL ELSE owner_id END, inputs = ? WHERE rk = ?",
                   [uid, inp ? JSON.stringify(inp) : r.inputs, r.rk]);
    const m = ROWS.get(r.room_id);
    if (m) {
      if (m.owner_id === uid) m.owner_id = null;
      if (m.inputs && m.inputs.owner === uid) m.inputs = Object.assign({}, m.inputs, { owner: null });
    }
    n++;
  }
  return n;
}

/** The admin card's extras: redaction stop-list collisions, how many names are known. */
function adminInfo() {
  compile();
  // CL3 fix-up: over = hidden people past the redaction cap (their names aren't redacted - the card says so)
  return { collisions: COLLISIONS, named: NAMES.size, opens: OPENS.size, over: OVER, cap: NAMES_PEOPLE_MAX };
}

function start() {
  init().then(() => {
    const t = setInterval(() => {
      sweepOpens().catch((e) => console.error("[chatlogview] opens:", e.message))
        .then(() => sweepTiers()).catch((e) => console.error("[chatlogview] tiers:", e.message));
      scheduleNames();
    }, 10 * 60e3);
    if (t.unref) t.unref();
  }).catch((e) => console.error("[chatlogview] init:", e.message));
}

module.exports = {
  init, start, view, closedView, historyBlock, reconcile, reconcileNow, inputsOf, cursorBounds, filter, dress, project, roster, itemOf, audOk,
  redact, compile, refreshNames, scheduleNames, noteWho, namesFor, privateFlags, signJc, checkJc, quotable, quoteView, quotableFeed, redactLoaded, auditRead, pendingOpen, requestOpen,
  cancelOpen, setOwnerGrant, sweepOpens, sweepTiers, syncInfo, trieSource, forgetOwner, adminInfo, retFor, cutoffs, deletionRet, padTier, classOf, hashOf, isHiddenLogin,
  privacyVer, hiddenVer, noteGone, pubFloor,          // CL8 fix-up
  privacyOf, speakerHash, isLeftOutLogin, movedLately, // owner change (decision 9: incognito "someone", !bridge hide left out)
  privacyAt, lookOf, lookMove, namedToAnonLately,      // owner-change fix-up (review 2): only a line whose look moves is drawn again
  tierOf, raiseExp, ensurePremium,                    // CL7: the retention purge (chatlogpurge.js)
  graceOf, lapsedOf, noteFirst, retentionFresh,       // CL7 fix-up
  speakerHashes, kindNow, hubChanged,                 // Train 3 review: every hash a "someone" line could be; the stricter of both stores
  GRACE_MS, PRESENCE_MS, MOD_EXTRA_MS, OPEN_DELAY_MS, SIGNED_ONLY, BLOCK_RULES, DOWNGRADE_GRACE_MS, JC_TTL, READ_ALL, AUD, STOP, PRESENCE,
  _caches: CACHE, _rows: ROWS, _tiers: TIERS, _opens: OPENS, _names: NAMES, _who: WHO, _disp: DISP,
  _setClock: (f) => { clock = f || (() => CL.now()); },
  _setAttested: (f) => { attestedFn = f || null; CACHE.att.clear(); },
  _bumpNames: () => { NAMES_V++; },
  _clearCaches: () => { for (const m of Object.values(CACHE)) m.clear(); },
};
