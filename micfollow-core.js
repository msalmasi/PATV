// micfollow-core.js — the pure decision engine of 🎙 "mic follows" (micfollow.js wires it up). In a pad whose stage is
// bridged to a Camfrog room, whoever holds the Camfrog mic gets their cam on THAT pad's stage; several holders at once are
// shown together in a layout. This file decides WHO is on the mic stage, in what layout, and what picture each one gets.
// No I/O, no clock, no site modules: step(state, input, cfg, t) -> {state, actions}. Every rule is unit-tested with a fake
// clock (test/micfollow-core.test.js).
//
// One step, in this order (spec §3.4):
//   1 consent cuts      a tile whose person may no longer be shown (a CUT code) comes off NOW - no hold, no budget, no card
//   2 release tracking  tile.relAt = the time they dropped the mic (null while they hold it)
//   3 due removals      relAt + handover_s, never before addedAt + min_on_stage_s; the LAST one on stays idle_hold_s
//   4 candidates        holders who held >= min_hold_s (a re-grab within regrab_merge_s is the same hold), not on the stage,
//                       not cut; after leaving, cooldown_s before coming back (unless the stage would be empty); none while
//                       frozen; newest first
//   5 capacity          min(max_people, the layout's cap); with no room the newest speaker DISPLACES the tile added longest
//                       ago (on >= min_on_stage_s, and an older speaker than the newcomer)
//   6 change budget     adds + removals + displacements are ONE change: never two within min_gap_s, at most
//                       max_changes_per_min a minute - otherwise deferred whole (the 1 s timer tries again)
//   7 apply             positions compact in addedAt order; v++; the layout follows the count
//   8 pictures          live (stays live while it lives) > a free live place to the newest (warm relay, else a cold open
//                       within the budgets) > a still > a name card. A relay is shown ONLY once Pepe says he opened (or
//                       verified) it by the EXACT name (sess.exact === true) - a warm ▶ Live relay is held so he checks it,
//                       and given up after EXACT_WAIT_MS if he can't (never the wrong "Bob"). A relay that ended "cam off" isn't
//                       reopened until the roster shows the cam off and on again (or OFFCAM_RETRY_MS); that also ends a
//                       failed-open backoff (rule 10)
//   9 active            true once a tile has a picture; stays true until nobody is on the mic stage
// Before-prod deltas (addendum 14.1.2): a proven holder never shown on this pad yet gets the pad's notice at the first
// qualifying grab and is "notice" (not a candidate) for notice_lead_s after it (micfollow.js sends it: notice_first);
// GRAB-SPAM (>= spam_holds separate holds shorter than spam_short_s within spam_window_s) keeps that person off the mic
// stage for spam_out_min; while the mic is held only by people nobody can show (unproven, anonymous, opted out, not noticed
// yet ...) - or by Pepe alone - tiles kept only by the hand-over / idle hold give way at once (min on stage still applies)
// and the program shows a NEUTRAL card ("Someone is speaking" / Pepe's card, S.neutral) instead of the last speaker's face;
// clearStage = the owner's "Clear the stage" (everyone off, frozen).
// mfix (owner 2026-10-25):
//   recent speakers  a pad's keep_recent (minutes; 0 = off): a tile whose person let go of the mic stays on the stage that
//                    long (its relay stays live) - a back-and-forth on a one-mic room still shows side by side. A new
//                    speaker who needs the room displaces the one off the mic LONGEST first; a recent speaker who grabs
//                    again just holds again (no change). A recent tile whose cam goes off leaves after the plain hand-over.
//                    Every consent rule re-runs on recent tiles each step like on any tile (cuts, opt-outs, cam access).
//   pins             I.pins = the pad's pinned cams (micfollow.js holds them, with the cam-slot consent rules): they take
//                    fixed places first, count toward max_people, and their people are never mic tiles (a tile of someone
//                    just pinned comes off - no duplicate). A single layout with a pin shows picture in picture.
//   speech nobody can show / Pepe's own mic-ups no longer clear the stage: the tiles stay (S.speaking = "someone" | "pepe"
//                    dims them and says so on the page, nobody is highlighted as the newest); the old give-way is the site
//                    knob unattributed_clear. The neutral card still shows when the last tiles leave while it runs.
//   soft failures    an open that failed for a passing reason (Pepe busy, a stray window, a slow open...) is tried again
//                    after soft_retry_s - soft_fails_max of them in open_fail_backoff_min, then the full backoff.
//   card reasons     a card says WHY there's no picture: cold_off / rate / relays / pool / pad_cap / retry / failed / full.
//   layoutOverride   the owner's stage-bar layout is never reset by the engine (micfollow.js keeps it until the owner does).
// 1.99afl (the incognito / mic-stage spec, F.1 S1 / S1b / S2):
//   stills       a refused still is soft (busy, noswitch, start_timeout, wrong_room, failed, an unknown code, an older
//                Pepe's answer with no code) -> another try after soft_retry_s like a soft live open (soft_fails_max of
//                them, then the backoff); only not_public / not_on_cam / ambiguous start the full backoff at once. No still
//                starts while a soft retry holds the person (the still is an exact job too: it would be refused the same
//                way and then back off for 10 minutes).
//   list_unread  Pepe can't read the room's participant list (rows he can't see): a ROOM-WIDE pause (S.listPause), never a
//                per-person failure - no exact open and no still for the room, never counted in S.soft, no backoff /
//                liveBlock; every tile without a live relay says so (card "list_unread"); running relays keep running. It
//                ends when Pepe's snapshot shows a complete read (listFresh) newer than the one the pause began under (or
//                after LIST_PAUSE_MAX_MS - one try, which pauses again if the list is still unread); the backoffs set
//                during it are cleared and each tile gets one normal attempt.
//   cam_unknown  the roster doesn't know whether they're on cam (on_cam null: the list is stale or they joined after the
//                last read): "checking their cam…" - no blind exact open (each one pages Camfrog's whole list on its UI
//                thread). Only with a Pepe that opens such a cam by its exact name (I.site.unkOpen: mf >= MF_UNK_OPEN -
//                none yet; through 1.99afk he refuses it at once as not_on_cam) at most ONE exact open per person per
//                list-read epoch (the room's listAt with listFresh), and only in an epoch that began after their grab (the
//                read still couldn't classify them, e.g. a lurker). A running relay proves the cam is on: the site never
//                ends a live tile for cam_unknown, and a warm relay may be held (review: Pepe through 1.99afk stops a
//                running relay himself when his roster's on_cam goes unknown - a not_on_cam end or refusal while the cam
//                is unknown reads "checking their cam…", never "cam off": camUnknownCard).
//                A list pause lets a tile hold a warm relay Pepe already verified by the exact name (no list needed).
// Actions (micfollow.js carries them out): hold / release / still / still_stop / span_open / span_close / picture /
// notice_first / spam / touch / deferred.
"use strict";

const STAGING = !!process.env.STAGING;

const FIELDS = Object.freeze({
  enabled:               { def: STAGING, bool: true },          // the staff kill switch (ships dark on prod)
  min_hold_s:            { def: 2, min: 1, max: 10 },
  regrab_merge_s:        { def: 5, min: 0, max: 15 },
  min_on_stage_s:        { def: 10, min: 4, max: 60 },
  handover_s:            { def: 8, min: 2, max: 30 },
  idle_hold_s:           { def: 20, min: 5, max: 120 },
  cooldown_s:            { def: 20, min: 0, max: 300 },
  max_changes_per_min:   { def: 6, min: 2, max: 20 },
  min_gap_s:             { def: 5, min: 2, max: 30 },
  // mfix: the live-cam limits for the mic stage (owner 2026-10-25: "increase the limit of live cams for mic follows") -
  // relays only the mic stage holds site-wide, and the cold opens a minute (site-wide / per pad). Pepe's VM measured ~3.4% of
  // one core per re-encoded relay; livecam's own max_live (all rooms) still caps them all.
  relays_max:            { def: 6, min: 0, max: 24 },
  // mfix review: cold opens - on for staging; prod stays off (the spec's V-2 / V-3 / V-5 checks) until staff switch it on at
  // /stage/admin (the owner's call - a Camfrog-locked cam may pop a viewing request at its owner on every mic turn)
  cold_open:             { def: STAGING, bool: true },
  cold_opens_per_min:    { def: 10, min: 0, max: 30 },          // site-wide
  cold_opens_per_pad:    { def: 6, min: 0, max: 30 },           // a minute, per pad
  open_fail_backoff_min: { def: 10, min: 1, max: 120 },
  soft_retry_s:          { def: 20, min: 5, max: 120 },         // mfix: a soft failed open (busy, a stray window...) is retried after this
  soft_fails_max:        { def: 3, min: 1, max: 10 },           //   ... this many in open_fail_backoff_min -> the full backoff
  stills:                { def: true, bool: true },
  stills_max:            { def: 4, min: 0, max: 12 },
  still_refresh_s:       { def: 20, min: 10, max: 120 },
  notice_gap_h:          { def: 3, min: 1, max: 48 },
  exclude_on_cut_min:    { def: 60, min: 0, max: 1440 },
  freeze_max_min:        { def: 30, min: 5, max: 240 },
  sync_fresh_s:          { def: 45, min: 10, max: 120 },        // > Pepe's 30 s snapshot cadence (BRIDGE_SNAPSHOT_EVERY) in quiet rooms
  stale_hold_s:          { def: 30, min: 0, max: 120 },
  private_cache_s:       { def: 10, min: 2, max: 60 },
  spans_keep_days:       { def: 30, min: 7, max: 180 },
  // the site's CAPS on every pad's own max_people / max_live (a pad owner may only narrow them; a pad's own default is 4
  // people). 9 = the 3 x 3 "Brady Bunch" grid stays reachable unless an admin narrows it site-wide.
  max_people:            { def: 9, min: 1, max: 9 },
  max_live:              { def: 6, min: 1, max: 6 },             // mfix: 4 -> 6 (recent speakers keep their relays)
  notice_lead_s:         { def: 120, min: 120, max: 3600 },     // DF-11: the pad's first notice this long before the first pick
  // mfix: DF-30 as it was - speech nobody can show makes the tiles give way to the neutral card at once. Off (the default):
  // the tiles stay, dimmed, with "Someone else is speaking" on them and nobody highlighted as the speaker
  unattributed_clear:    { def: false, bool: true },
  pins_max:              { def: 2, min: 0, max: 4 },             // mfix: 📌 pinned cams per pad (always leaving a mic place)
  pin_max_min:           { def: 180, min: 10, max: 720 },        //   ... a pin ends by itself after this long
  spam_holds:            { def: 4, min: 2, max: 20 },           // DF-37 grab-spam: this many separate short holds ...
  spam_short_s:          { def: 5, min: 2, max: 30 },           //   ... each shorter than this ...
  spam_window_s:         { def: 120, min: 30, max: 600 },       //   ... within this long ...
  spam_out_min:          { def: 10, min: 1, max: 120 },         //   ... keep them off the mic stage this long
  report_window_s:       { def: 120, min: 30, max: 900 },       // DF-31: two distinct qualified reporters within this ...
  report_out_h:          { def: 24, min: 1, max: 168 },         //   ... cut + keep off the pad's mic stage this long, pending review
  reports_per_hour:      { def: 3, min: 1, max: 20 },           //   a reporter's reports per pad an hour
});
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])));

const LAYOUTS = Object.freeze(["auto", "single", "split", "grid", "pip"]);
const SHAPES = Object.freeze(["single", "split", "grid4", "grid9", "pip"]);
const DEFAULT_VIEWS = Object.freeze(["first", "after_streams", "tab"]);
const KEEP_RECENT = Object.freeze([0, 1, 2, 5]);
const PAD_FIELDS = Object.freeze({
  on:           { def: false, bool: true },
  layout:       { def: "auto", choices: LAYOUTS },
  default_view: { def: "first", choices: DEFAULT_VIEWS },
  max_people:   { def: 4, min: 1, max: 9 },
  max_live:     { def: 4, min: 1, max: 6 },
  // mfix: minutes a speaker who let go of the mic stays on the stage (0 = off) - until a new speaker needs the room
  keep_recent:  { def: 2, min: 0, max: 5, allowed: KEEP_RECENT },
});
const PAD_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(PAD_FIELDS).map(([k, f]) => [k, f.def])));

/** The consent CUT codes (§4.1): a tile with one comes off at once. "unavailable" (train2 merge): stagefix's neutral word -
 *  "Take me off this Stage" on this pad, or a DM block either way with the pad's owner (never which) - the same rules
 *  livecam.stageConsent refuses a hold for, so the person isn't re-picked every cooldown_s only to be refused again. */
const CUT = Object.freeze(["not_member", "opted_out", "mf_opted_out", "private", "hidden", "excluded", "banned", "blocked_owner", "unavailable",
  "mode_closed", "ended_by"]);
const CUT_SET = new Set(CUT);
const isCut = (e) => CUT_SET.has(e);
// a session that ended for one of these: a card ("failed") and no new open for that person until the backoff passes
const FAIL_WHYS = new Set(["open_failed", "not_that_cam", "ambiguous", "noswitch", "busy", "start_timeout", "slots_busy", "spawn_failed", "failed",
  "nopepe", "not_open", "no_pic", "list_unread"]);
/** mfix: failures that say nothing about the person or their cam (Pepe's cam lock was busy, a window titled with their name
 *  that no exact open made was in the way, the room window wasn't on screen, a slow open, a warm relay Pepe couldn't confirm
 *  yet): another try after soft_retry_s, soft_fails_max times, before the full backoff. "ambiguous" (two people go by that
 *  name) is never soft. 1.99afl: "list_unread" is never a person's failure at all - its own branch (the room pauses) runs
 *  before failOpen; it is listed so it is never mistaken for a hard one. */
const SOFT_WHYS = new Set(["busy", "noswitch", "not_that_cam", "start_timeout", "no_pic", "not_open", "nopepe", "inexact", "list_unread"]);
const OFFCAM_WHYS = new Set(["not_on_cam", "cam_closed", "left_cam"]);
/** 1.99afl (S1): the still refusals Pepe names (his still result's `code`, bot 1.99afk) that start the full backoff - the
 *  spec's two (not_public, not_on_cam) plus "ambiguous", the live path's rule (two people go by that name: a retry can't tell
 *  them apart, and each one pages Camfrog's whole list), plus "not_in_list" (re-review, bot 1.99afk's own code for it: a
 *  COMPLETE list read has no row with exactly that name - a name shown differently doesn't pass in seconds, and each retry
 *  is another exact page-through). Anything else - busy, noswitch, start_timeout, wrong_room, "failed" (review: bot
 *  1.99afk's catch-all for not_open / an error / not that cam / an unmapped status), a code this build doesn't know, or no
 *  code (an older Pepe) - is soft: retried after soft_retry_s, soft_fails_max times, then the full backoff. */
const STILL_HARD = new Set(["not_public", "not_on_cam", "ambiguous", "not_in_list"]);
/** 1.99afl review (S2): the Pepe mic-stage level (livecam.botMf, his poll's `mf`) from which he opens a cam his roster can't
 *  classify (on_cam unknown) by its exact name, fast-failing a lurker. Through bot 1.99afk (mf 1) he refuses such a cam at once
 *  as "not_on_cam" (pepe_livecam._lv_why_not) - so the mic stage asks for none: the tile stays "checking their cam…" until a
 *  list read classifies it. */
const MF_UNK_OPEN = 2;
/** 1.99afl (S1b): a paused room tries once more after this long even if no newer complete list read came (it pauses again at
 *  once if the list is still unread) - so a pause can never outlive a missed snapshot field. */
const LIST_PAUSE_MAX_MS = 5 * 60 * 1000;
/** A held relay Pepe hasn't opened / verified by the exact name (sess.exact !== true) is never shown; after this long the
 *  mic stage gives it up (Pepe re-checks a running cam at most every 20 s; mfix: one he can't confirm he re-opens by the exact
 *  name - closing the window his older name match made - which takes a few seconds more). */
const EXACT_WAIT_MS = 60 * 1000;
/** mfix: the reasons a tile shows a card instead of a picture (the page words each). 1.99afl: + list_unread (the room's list
 *  can't be read - S1b), cam_unknown ("checking their cam…" - S2) and pepe (his cam relay isn't there - S4). */
const CARD_WHYS = Object.freeze(["off_cam", "failed", "retry", "full", "cold_off", "rate", "relays", "pool", "pad_cap", "list_unread", "cam_unknown", "pepe"]);
/** The site's live relays were full at the moment of a hold (a race, not a failed open): "full", another try after this. */
const FULL_RETRY_MS = 15 * 1000;
/** A relay that ended because the cam closed ("cam off"): no new open / still of that person until Pepe's roster shows
 *  their cam off and on again, or this long passed (the roster's on_cam can be a minute or more old - without this the
 *  very next step would reopen a closed cam, and every viewer would see "starting" / "cam off" flip). */
const OFFCAM_RETRY_MS = 60 * 1000;

function normalizeWith(FLD, input, { base = null, lenient = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const cfg = {}, errors = {};
  for (const [k, f] of Object.entries(FLD)) {
    const has = Object.prototype.hasOwnProperty.call(src, k) && src[k] !== "" && src[k] != null;
    const raw = has ? src[k] : (base && base[k] != null ? base[k] : f.def);
    if (f.bool) {
      if (typeof raw === "boolean") cfg[k] = raw;
      else if (raw === "true" || raw === "on" || raw === 1 || raw === "1") cfg[k] = true;
      else if (raw === "false" || raw === "off" || raw === 0 || raw === "0") cfg[k] = false;
      else { cfg[k] = f.def; if (!lenient) errors[k] = "on or off"; }
      continue;
    }
    if (f.choices) {
      const v = String(raw).trim().toLowerCase();
      if (f.choices.includes(v)) cfg[k] = v;
      else { cfg[k] = f.def; if (!lenient) errors[k] = `one of ${f.choices.join(", ")}`; }
      continue;
    }
    const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isFinite(n)) { cfg[k] = f.def; if (!lenient) errors[k] = "a number"; continue; }
    if (n < f.min || n > f.max) { if (!lenient) errors[k] = `${f.min}–${f.max}`; cfg[k] = Math.max(f.min, Math.min(f.max, n)); } else cfg[k] = n;
    cfg[k] = Math.round(cfg[k]);
    // mfix: a field with a short list of values (keep_recent: 0 / 1 / 2 / 5 minutes) - anything else is the nearest one below
    if (f.allowed && !f.allowed.includes(cfg[k])) {
      if (!lenient && has) errors[k] = `one of ${f.allowed.join(", ")}`;
      const below = f.allowed.filter((x) => x <= cfg[k]);
      cfg[k] = below.length ? below[below.length - 1] : f.def;
    }
  }
  return { cfg, errors };
}
/** The site knobs (micfollow_cfg): {cfg, errors}. */
const normalize = (input, opts = {}) => normalizeWith(FIELDS, input, { base: opts.base || DEFAULTS, lenient: !!opts.lenient });
/** A pad's own settings (micfollow_pads): {cfg, errors}. max_live is also capped by the site's live-cam max_live. */
function normalizePad(input, opts = {}) {
  const r = normalizeWith(PAD_FIELDS, input, { base: opts.base || PAD_DEFAULTS, lenient: !!opts.lenient });
  if (Number.isFinite(opts.maxLive) && opts.maxLive >= 1 && r.cfg.max_live > opts.maxLive) {
    if (!opts.lenient && input && input.max_live != null) r.errors.max_live = `1–${opts.maxLive}`;
    r.cfg.max_live = opts.maxLive;
  }
  // the site knob max_people caps it the same way (§3.6: the owner may only narrow it)
  if (Number.isFinite(opts.maxPeople) && opts.maxPeople >= 1 && r.cfg.max_people > opts.maxPeople) {
    if (!opts.lenient && input && input.max_people != null) r.errors.max_people = `1–${opts.maxPeople}`;
    r.cfg.max_people = opts.maxPeople;
  }
  return r;
}

/** How many people a pad layout shows at most. */
function layoutCap(layout) {
  if (layout === "single") return 1;
  if (layout === "split" || layout === "pip") return 2;
  return 9;
}
/** The layout shape for n people on the mic stage (§6.1). */
function layoutFor(layout, n) {
  n = Math.max(0, n | 0);
  if (layout === "single") return "single";
  if (layout === "split") return n <= 1 ? "single" : "split";
  if (layout === "pip") return n <= 1 ? "single" : "pip";
  if (layout === "grid") return n <= 1 ? "single" : n <= 4 ? "grid4" : "grid9";
  return n <= 1 ? "single" : n === 2 ? "split" : n <= 4 ? "grid4" : "grid9";   // auto
}
/** mfix: the shape with `pins` pinned cams besides `tiles` mic tiles - a single layout with a pin is picture in picture. */
function shapeFor(layout, tiles, pins) {
  const n = Math.max(0, tiles | 0) + Math.max(0, pins | 0);
  if ((layout || "auto") === "single" && pins > 0 && n > 1) return "pip";
  return layoutFor(layout || "auto", n);
}
/** mfix: how many cams a pad may pin: pins_max, always leaving a mic place (a single layout: one pin, shown in a corner). */
function maxPins(layout, maxPeople, pinsMax) {
  const lay = layout || "auto";
  const cap = Math.max(1, Math.min(maxPeople | 0 || 1, layoutCap(lay)));
  return Math.max(0, Math.min(pinsMax | 0, lay === "single" ? 1 : cap - 1));
}

// ── state ──
function newState() {
  return {
    tiles: [],                 // [{login, addedAt, since, pos, relAt, video: card|starting|live|still, why, pend, pictured, qualAt, cold, vidSince, vidMs, peak, unverifiedAt}]
    seen: new Map(),           // holder login -> {since, held, relAt, shortAt}
    oseen: new Map(),          // holders nobody can show (unproven / anonymous / account keys / bots): key -> since
    pepeSince: 0,              // Pepe himself holds the mic since (0 = he doesn't)
    neutral: null,             // null | "someone" | "pepe": the neutral card that replaced the tiles (DF-12 / DF-30)
    short: new Map(),          // login -> [when a separate hold shorter than spam_short_s ended] (grab-spam, DF-37)
    spamUntil: new Map(),      // login -> until (grab-spam: off the mic stage)
    leftAt: new Map(),         // login -> when they last left the mic stage (cooldown)
    backoff: new Map(),        // login -> until (a failed open: no new open / still)
    liveBlock: new Map(),      // login -> until (yielded to a manual slot / the site was full: no live picture for a while)
    inexact: new Map(),        // login -> until (Pepe couldn't confirm the relay is exactly theirs: no live picture; stills are exact jobs)
    cutAt: new Map(),          // login -> when a consent cut took them off (the cooldown applies even to an empty stage)
    offcam: new Map(),         // login -> when their relay ended "cam off" (no new open / still until OFFCAM_RETRY_MS or off -> on)
    sawOff: new Set(),         // logins whose tile showed "cam off" while backed off / blocked: back on cam = the block ends (§3.4 rule 10)
    soft: new Map(),           // mfix: login -> [when a soft open failure happened] (soft_fails_max of them -> the full backoff)
    blockWhy: new Map(),       // mfix: login -> why liveBlock holds them ("retry" | "full")
    pinned: new Set(),         // mfix: the pad's pinned cams' logins (I.pins, last step)
    speaking: null,            // mfix: null | "someone" | "pepe" - speech nobody can show / Pepe while tiles stay (dimmed on the page)
    listPause: null,           // 1.99afl (S1b): {since, listAt} - Pepe can't read the room's list: no exact opens / stills here
    pauseBlocked: new Set(),   //   ... logins whose backoff / liveBlock was set during the pause (cleared when it ends)
    listAtSeen: null,          //   ... the room's listAt as the last step saw it (a pause began under that read)
    unkTried: new Map(),       // 1.99afl (S2): login -> the list-read epoch (listAt) of its one exact open while cam_unknown
    camUnk: new Set(),         //   ... review: the logins whose cam the roster couldn't classify at the last step
    changes: [],               // times of the last minute's changes
    lastChangeAt: -Infinity,
    v: 0, active: false, running: false, staleSince: 0, whyOff: null,
    frozenUntil: 0, layoutOverride: null, deferred: 0, deferring: false, unproven: 0,
  };
}
const tileOf = (S, login) => S.tiles.find((x) => x.login === login) || null;
const hasPicture = (x) => x.video === "live" || x.video === "still";
const liveish = (x) => x.video === "live" || x.video === "starting";
// mfix review: the stage may be the default view once a tile has a picture OR its cam is opening (a "starting" tile) - a pad
// whose owner put the mic stage first no longer shows Pepe's stream while a new speaker's cam opens (up to EXACT_WAIT_MS);
// a stage of only reason cards (cold opens off, full, failed) still never is (DF-15)
const showsSoon = (x) => hasPicture(x) || x.video === "starting";
// ties (several added in one change) go by when they grabbed the mic: the later grab is the newer speaker
const newer = (a, b) => a.addedAt - b.addedAt || (a.since || 0) - (b.since || 0) || a.pos - b.pos;
function compact(S) {
  S.tiles.sort(newer);
  S.tiles.forEach((x, i) => { x.pos = i; });
}
/** The newest speaker on the stage - mfix: only someone who HOLDS the mic now (a recent speaker who let go is never
 *  highlighted as the one speaking), and nobody while speech nobody can show runs. */
function newest(S) {
  if (S.speaking) return null;
  let n = null;
  for (const x of S.tiles) if (x.relAt == null && (!n || newer(x, n) > 0)) n = x;
  return n;
}
/** A consent cut happened (it is never deferred): it counts in the change budget, and that person gets the cooldown
 *  before coming back even when the stage would otherwise be empty - toggling an opt-out can't strobe the stage. */
function noteCut(S, logins, t) {
  S.lastChangeAt = t;
  S.changes = S.changes.filter((x) => t - x < 60 * 1000);
  S.changes.push(t);
  for (const l of logins) S.cutAt.set(l, t);
  if (S.cutAt.size > 500) for (const [l, at] of [...S.cutAt]) if (t - at > 3600e3) S.cutAt.delete(l);
}
/** Expired per-person timers go (the maps stay small however many people pass through a busy room). */
function pruneMaps(S, t) {
  for (const m of [S.backoff, S.liveBlock, S.inexact, S.spamUntil]) if (m.size > 200) for (const [l, until] of [...m]) if (until <= t) m.delete(l);
  if (S.blockWhy.size > 200) for (const l of [...S.blockWhy.keys()]) if (!((S.liveBlock.get(l) || 0) > t)) S.blockWhy.delete(l);
  if (S.soft.size > 200) for (const [l, list] of [...S.soft]) if (!list.length || t - list[list.length - 1] > 3600e3) S.soft.delete(l);
  if (S.offcam.size > 200) for (const [l, at] of [...S.offcam]) if (t - at >= OFFCAM_RETRY_MS) S.offcam.delete(l);
  if (S.leftAt.size > 500) for (const [l, at] of [...S.leftAt]) if (t - at > 3600e3) S.leftAt.delete(l);
  if (S.sawOff.size > 200) S.sawOff.clear();
  if (S.unkTried.size > 200) { const on = new Set(S.tiles.map((x) => x.login)); for (const l of [...S.unkTried.keys()]) if (!on.has(l)) S.unkTried.delete(l); }
}
/** 1.99afl (S1b): the room's list can't be read - pause it (once; the read it began under is kept). */
function pauseList(S, t) {
  if (!S.listPause) S.listPause = { since: t, listAt: S.listAtSeen || 0 };
}
/** ... a backoff / liveBlock set while the room is paused is remembered, so the pause's end clears it. */
function notePauseBlock(S, login) { if (S.listPause) S.pauseBlocked.add(login); }
/** ... a complete list read newer than the one the pause began under (or LIST_PAUSE_MAX_MS): the pause ends, its backoffs go. */
function endPause(S) {
  for (const l of S.pauseBlocked) { S.backoff.delete(l); S.liveBlock.delete(l); S.inexact.delete(l); S.blockWhy.delete(l); S.soft.delete(l); }
  S.pauseBlocked.clear();
  S.listPause = null;
}
/** ... a tile's relay / hold / still came back "list_unread": the room pauses; this tile says so (no count, no backoff). */
function listUnread(S, x, t) {
  pauseList(S, t);
  x.pend = false;
  setVideo(x, "card", "list_unread", t);
}
/** 1.99afl review (S2): was this tile's cam unknown to the roster when its relay was refused / ended "not_on_cam" (its epoch's
 *  one exact open, or the roster at the last step)? Pepe (through 1.99afk) refuses - and stops a running relay - whenever his
 *  roster's on_cam isn't TRUE, unknown included: that says nothing about the cam being off. */
const camUnknownNow = (S, x) => !!x.unkHold || !!(S.camUnk && S.camUnk.has(x.login));
/** ... then the tile says "checking their cam…" - never "cam off" (no S.offcam, no count, no backoff). This list-read epoch's
 *  exact open counts as tried, so it isn't asked for again before the next complete read. */
function camUnknownCard(S, x, t) {
  x.pend = false;
  x.unkHold = 0;
  if (S.listAtSeen) S.unkTried.set(x.login, S.listAtSeen);
  setVideo(x, "card", "cam_unknown", t);
}
/** The layout shape the mic stage shows now (mfix: with its pinned cams). */
function shapeOf(S, pad) { return shapeFor(S.layoutOverride || (pad && pad.layout) || "auto", S.tiles.length, S.pinned ? S.pinned.size : 0); }
/** mfix: a live picture didn't work out for `login` for `why`. A soft reason: another try after soft_retry_s (soft_fails_max
 *  times in open_fail_backoff_min) -> "retry"; else the full backoff -> "failed". inexact: Pepe couldn't confirm a warm relay -
 *  its full backoff is S.inexact (stills - exact jobs of their own - may still run). */
function failOpen(S, login, why, C, t) {
  notePauseBlock(S, login);                                 // (1.99afl: set during a list pause -> cleared when it ends)
  if (SOFT_WHYS.has(why)) {
    const win = C.open_fail_backoff_min * 60 * 1000;
    const list = (S.soft.get(login) || []).filter((x) => t - x < win);
    list.push(t);
    if (list.length < C.soft_fails_max) {
      S.soft.set(login, list);
      S.liveBlock.set(login, t + C.soft_retry_s * 1000);
      // 1.99afl (S4): Pepe's cam relay isn't there ("nopepe") says so on the card; any other soft reason is "trying again"
      const w = why === "nopepe" ? "pepe" : "retry";
      S.blockWhy.set(login, w);
      return w;
    }
    S.soft.delete(login);
  }
  (why === "inexact" ? S.inexact : S.backoff).set(login, t + C.open_fail_backoff_min * 60 * 1000);
  return "failed";
}

/** Take a tile off: let go of its relay / still, close its span. */
function removeTile(S, x, reason, t, A) {
  S.tiles = S.tiles.filter((y) => y !== x);
  if (liveish(x) || x.pend) A.push({ a: "release", login: x.login });
  if (x.video === "still") A.push({ a: "still_stop", login: x.login });
  A.push({ a: "span_close", login: x.login, reason, video_ms: (x.vidMs || 0) + (x.vidSince ? t - x.vidSince : 0), peak: x.peak || 0 });
  S.leftAt.set(x.login, t);
}
function setVideo(x, video, why, t) {
  const had = hasPicture(x);
  x.video = video;
  x.why = why || null;
  const has = hasPicture(x);
  if (has && !had) x.vidSince = t;
  if (!has && had && x.vidSince) { x.vidMs = (x.vidMs || 0) + (t - x.vidSince); x.vidSince = 0; }
}

/** Everyone off (RUN failed, pad off, kill switch). */
function clearAll(S, reason, t, A) {
  const had = S.tiles.length > 0;
  for (const x of S.tiles.slice()) removeTile(S, x, reason, t, A);
  S.tiles = [];
  S.active = false;
  S.seen.clear();
  S.oseen.clear(); S.pepeSince = 0;
  const neutral = !!S.neutral;
  S.neutral = null; S.speaking = null;
  if (S.listPause) endPause(S);                             // (1.99afl: a stopped stage starts its next run unpaused)
  if (had || neutral) { S.v++; A.push({ a: "touch", why: "clear:" + reason }); }
  return had;
}

/** 1: consent cuts. -> how many came off */
function consentCuts(S, I, t, A) {
  const cut = [];
  for (const x of S.tiles.slice()) {
    const e = I.elig.get(x.login);
    if (!isCut(e)) continue;
    removeTile(S, x, "cut:" + e, t, A);
    cut.push(x.login);
  }
  const n = cut.length;
  if (n) {
    noteCut(S, cut, t);
    compact(S);
    S.v++;
    A.push({ a: "touch", why: "cut", cut: n });
    if (!S.tiles.length) S.active = false;
  }
  return n;
}

/** 2: who holds the mic, since when (a re-grab within regrab_merge_s keeps the old since). A hold that ends shorter than
 *  spam_short_s is noted for the grab-spam rule (a re-grab merged into it takes the note back: it's the same hold). */
function track(S, holders, C, t) {
  const now = new Set();
  for (const h of holders) {
    now.add(h.login);
    const s = S.seen.get(h.login);
    const pepeSince = Number.isFinite(h.since) ? h.since : null;
    if (!s) S.seen.set(h.login, { since: pepeSince != null ? pepeSince : t, held: true, relAt: null, shortAt: null });
    else if (!s.held) {
      if (!(s.relAt != null && t - s.relAt <= C.regrab_merge_s * 1000)) s.since = pepeSince != null ? pepeSince : t;
      else if (s.shortAt != null) {                         // merged: that "short hold" goes on
        const list = S.short.get(h.login);
        if (list) { const i = list.lastIndexOf(s.shortAt); if (i >= 0) list.splice(i, 1); if (!list.length) S.short.delete(h.login); }
      }
      s.held = true; s.relAt = null; s.shortAt = null;
    }
  }
  for (const [login, s] of S.seen) {
    if (s.held && !now.has(login)) {
      s.held = false; s.relAt = t;
      if (t - s.since < C.spam_short_s * 1000) {
        s.shortAt = t;
        const list = S.short.get(login) || [];
        list.push(t);
        S.short.set(login, list.slice(-50));
      } else s.shortAt = null;
    }
    if (!s.held && s.relAt != null && t - s.relAt > Math.max(C.regrab_merge_s * 1000, 60 * 1000)) S.seen.delete(login);
  }
  return now;
}
/** DF-37 grab-spam: >= spam_holds separate short holds within spam_window_s -> off the mic stage for spam_out_min.
 *  -> the logins it just caught */
function grabSpam(S, C, t) {
  const caught = [];
  const win = C.spam_window_s * 1000;
  for (const [l, list] of [...S.short]) {
    const recent = list.filter((x) => t - x <= win);
    if (!recent.length) { S.short.delete(l); continue; }
    if (recent.length >= C.spam_holds) {
      S.spamUntil.set(l, t + C.spam_out_min * 60 * 1000);
      S.short.delete(l);
      caught.push(l);
    } else if (recent.length !== list.length) S.short.set(l, recent);
  }
  return caught;
}
const spamming = (S, l, t) => (S.spamUntil.get(l) || 0) > t;
/** Holders nobody can show (unproven, anonymous, account keys, bots) and Pepe himself: since when (Pepe's since if given). */
function trackOthers(S, I, t) {
  const now = new Set();
  for (const o of I.others || []) {
    if (!o || !o.key) continue;
    now.add(o.key);
    if (!S.oseen.has(o.key)) S.oseen.set(o.key, Number.isFinite(o.since) ? Math.min(o.since, t) : t);
  }
  for (const k of [...S.oseen.keys()]) if (!now.has(k)) S.oseen.delete(k);
  if (Number.isFinite(I.pepe)) { if (!S.pepeSince) S.pepeSince = Math.min(I.pepe, t); }
  else if (I.pepe === true) { if (!S.pepeSince) S.pepeSince = t; }
  else S.pepeSince = 0;
}
/** DF-30 / DF-12: is the mic held right now only by speech nobody can show? -> "someone" | "pepe" | null.
 *  "someone": no proven holder the mic stage may show (ok / off cam) holds it, and someone else - unproven, anonymous, or a
 *  proven holder who is cut / not noticed yet / grab-spamming - has held it >= min_hold_s. "pepe": Pepe alone holds it,
 *  >= min_hold_s. */
function speaking(S, I, C, t) {
  const minHold = C.min_hold_s * 1000;
  let attributed = false, other = false;
  for (const h of I.holders || []) {
    if (S.pinned && S.pinned.has(h.login)) { attributed = true; continue; }   // mfix: a pinned cam's person: shown, named
    const e = I.elig.get(h.login);
    if ((e === "ok" || e === "off_cam" || e === "cam_unknown") && !spamming(S, h.login, t)) { attributed = true; continue; }
    if (e === "pending" || e == null) continue;              // a fact fetch on its way (a moment): neither
    const s = S.seen.get(h.login);
    if (s && s.held && t - s.since >= minHold) other = true;
  }
  if (attributed) return null;
  for (const since of S.oseen.values()) if (t - since >= minHold) other = true;
  if (other) return "someone";
  if (!(I.holders || []).length && !S.oseen.size && S.pepeSince && t - S.pepeSince >= minHold) return "pepe";
  return null;
}

/** 8: pictures for every tile (not a "change": no budget, but v++ when one moves). opts.fresh = false (the stale hold):
 *  existing pictures follow their relays, nothing new is opened. -> changed */
function pictures(S, I, C, t, A, { fresh = true } = {}) {
  let changed = false;
  const padMaxLive = Math.max(0, Math.min(I.pad.max_live, Number.isFinite(I.site.maxLive) ? I.site.maxLive : 4));
  const NONE = { state: "none", held: false, exact: null };
  const shed = !!I.site.shed;          // Pepe refused a manual cam slot / ▶ Live as full: mic follows makes room
  // a) what still holds
  for (const x of S.tiles) {
    const e = I.elig.get(x.login);
    const ss = I.sess.get(x.login) || NONE;
    if (Number.isFinite(ss.viewers) && ss.viewers > (x.peak || 0)) x.peak = ss.viewers;
    if (e === "off_cam") {
      // their cam is off now: a failed-open / inexact / cam-off block ends when it comes back on (§3.4 rule 10)
      if ((S.backoff.get(x.login) || 0) > t || (S.inexact.get(x.login) || 0) > t || S.offcam.has(x.login)) S.sawOff.add(x.login);
      if (x.video !== "card" || x.why !== "off_cam") {
        if (liveish(x) || x.pend) A.push({ a: "release", login: x.login });
        if (x.video === "still") A.push({ a: "still_stop", login: x.login });
        x.pend = false;
        setVideo(x, "card", "off_cam", t);
        changed = true;
      }
      continue;
    }
    if (liveish(x)) {
      if (x.pend) continue;                                   // the hold is on its way
      if (!ss.held || ss.state === "ended" || ss.state === "none") { x.unverifiedAt = 0; setVideo(x, null, null, t); changed = true; continue; }
      // §7.2 / S-19: only a relay Pepe opened - or verified - by the EXACT name is shown. A warm ▶ Live relay (his older,
      // fuzzy name match) stays "starting" while he checks it; a live one that stops being exact comes off at once.
      // (the wait runs from the first moment it's up but not confirmed, through any reconnects, until Pepe confirms it)
      if (ss.exact === true) x.unverifiedAt = 0;
      else if (ss.state === "live" || x.unverifiedAt) {
        if (!x.unverifiedAt) x.unverifiedAt = t;
        if (x.video === "live" || t - x.unverifiedAt >= EXACT_WAIT_MS) {
          A.push({ a: "release", login: x.login });
          // mfix: a soft failure first (Pepe may still be re-opening it by the exact name) - the full block after a few
          failOpen(S, x.login, "inexact", C, t);
          x.unverifiedAt = 0;
          setVideo(x, null, null, t);                         // (b) gives it a still (an exact job) or a card
          changed = true;
          continue;
        }
        if (x.video !== "starting") { setVideo(x, "starting", null, t); changed = true; }
        continue;
      }
      const want = ss.state === "live" ? "live" : "starting";
      if (want === "live") x.unkHold = 0;                     // (1.99afl review: an epoch's open that worked out)
      if (x.video !== want) { setVideo(x, want, null, t); changed = true; }
    }
  }
  // b) free live places to the newest tiles without one; else a still; else a card
  let used = S.tiles.filter((x) => liveish(x) || x.pend).length;
  let cold = Math.max(0, I.site.coldLeft | 0), stills = Math.max(0, I.site.stillsLeft | 0);
  // Pepe's cam pool: every cold open and every still is an open cam there (micfollow.js leaves room for ▶ Live / slots)
  let pool = Number.isFinite(I.site.poolLeft) ? Math.max(0, I.site.poolLeft) : Infinity;
  const order = S.tiles.slice().sort((a, b) => newer(b, a));
  for (const x of order) {
    const e = I.elig.get(x.login);
    if (e === "off_cam" || liveish(x) || x.pend) continue;
    const ss = I.sess.get(x.login) || NONE;
    if (e === "ok" && S.sawOff.has(x.login)) {               // the cam went off and on again: the blocks end
      S.sawOff.delete(x.login); S.backoff.delete(x.login); S.inexact.delete(x.login); S.offcam.delete(x.login);
    }
    if (S.offcam.has(x.login) && t - S.offcam.get(x.login) >= OFFCAM_RETRY_MS) S.offcam.delete(x.login);
    if (S.offcam.has(x.login)) {                              // the relay ended "cam off": no reopen on an old roster
      if (x.video === "still") A.push({ a: "still_stop", login: x.login });
      // (1.99afl review: a roster that can't say whether the cam is on reads "checking their cam…", never "cam off")
      const w = e === "cam_unknown" ? "cam_unknown" : "off_cam";
      if (x.video !== "card" || x.why !== w) { setVideo(x, "card", w, t); changed = true; }
      continue;
    }
    // 1.99afl (S1b): Pepe can't read the room's list - no exact open and no still here until a newer complete read; the tile
    // says why (a live relay keeps running: it was handled above). Review: a warm relay Pepe already verified by the exact name
    // (a ▶ Live viewer's / a cam slot's) needs no list to be held - it goes on to the hold below
    const warmExact = (ss.state === "connecting" || ss.state === "live") && ss.exact === true;
    if (S.listPause && !warmExact) {
      if (x.video === "still") A.push({ a: "still_stop", login: x.login });
      if (x.video !== "card" || x.why !== "list_unread") { setVideo(x, "card", "list_unread", t); changed = true; }
      continue;
    }
    // 1.99afl (S2): the roster can't say whether their cam is on - "checking their cam…", never a blind exact open (or still).
    // A warm relay runs (so the cam IS on): it may be held. Otherwise one exact open per list-read epoch, and only in an epoch
    // that began after their grab (that read still couldn't classify them - a lurker, say: Pepe fast-fails it)
    let unkOpen = false;
    if (e === "cam_unknown") {
      if (x.video === "still") { A.push({ a: "still_stop", login: x.login }); setVideo(x, "card", "cam_unknown", t); changed = true; }
      const warm0 = ss.state === "connecting" || ss.state === "live";
      const seenAt = S.seen.get(x.login);
      const grab = seenAt ? seenAt.since : x.since || x.addedAt;
      const epoch = Number(I.room && I.room.listAt) > 0 ? Number(I.room.listAt) : 0;
      // (review: only a Pepe that opens such a cam at all - I.site.unkOpen, MF_UNK_OPEN; through 1.99afk he refuses it at once)
      const epochOk = !!(I.site && I.site.unkOpen === true) && !!(I.room && I.room.listFresh === true) && epoch > grab &&
        S.unkTried.get(x.login) !== epoch;
      if (!warm0 && !epochOk) {
        if (x.video !== "card" || x.why !== "cam_unknown") { setVideo(x, "card", "cam_unknown", t); changed = true; }
        continue;
      }
      unkOpen = !warm0 ? epoch : false;
    }
    const backed = (S.backoff.get(x.login) || 0) > t;
    const inexact = (S.inexact.get(x.login) || 0) > t;
    const lblock = (S.liveBlock.get(x.login) || 0) > t;
    const blocked = backed || inexact || lblock;
    // 1.99afl (S1): a soft-retry block holds stills back too (a still is an exact job: it would be refused the same way)
    const softBlock = lblock && (S.blockWhy.get(x.login) === "retry" || S.blockWhy.get(x.login) === "pepe");
    let why0 = null;                                          // mfix: why no live picture (the card says so)
    if (fresh && e !== "pending" && e !== "notice" && !blocked && used >= padMaxLive) why0 = "pad_cap";
    if (fresh && e !== "pending" && e !== "notice" && used < padMaxLive && !blocked) {
      // warm: a relay that runs already (a ▶ Live viewer's / a cam slot's) - held, it's shown once Pepe says it's exact (a)
      const warm = ss.state === "connecting" || ss.state === "live";
      const isCold = ss.state === "none" || ss.state === "ended";
      if (!warm) why0 = shed || pool <= 0 ? "pool" : cold <= 0 ? (I.site.coldWhy || "full") : null;
      if (warm || (isCold && cold > 0 && pool > 0 && !shed)) {
        if (x.video === "still") A.push({ a: "still_stop", login: x.login });
        if (isCold) { cold--; pool--; }
        if (unkOpen) S.unkTried.set(x.login, unkOpen);       // (1.99afl: this epoch's one exact open of a cam_unknown person)
        x.unkHold = unkOpen || 0;                            // (review: its "not_on_cam" refusal reads "checking their cam…")
        used++;
        x.pend = true;
        x.cold = isCold;
        setVideo(x, "starting", null, t);
        A.push({ a: "hold", login: x.login, cold: isCold });
        changed = true;
        continue;
      }
    }
    if (x.video === "still") {                                // keeps its still (unless Pepe needs the room)
      if (!shed) continue;
      A.push({ a: "still_stop", login: x.login });
      setVideo(x, "card", "full", t);
      changed = true;
      continue;
    }
    if (fresh && C.stills && C.cold_open && I.room.cams && !backed && !softBlock && !shed && !S.listPause && e !== "pending" && e !== "notice" && e !== "cam_unknown" &&
        stills > 0 && pool > 0) {
      stills--; pool--;
      setVideo(x, "still", null, t);
      A.push({ a: "still", login: x.login });
      changed = true;
      continue;
    }
    // (the stale hold opens nothing: a card keeps the reason it had)
    const kept = !fresh && x.video === "card" && x.why && x.why !== "off_cam" ? x.why : null;
    const why = backed || inexact ? "failed" : lblock ? (S.blockWhy.get(x.login) || "full") : (why0 || kept || "full");
    if (x.video !== "card" || x.why !== why) { setVideo(x, "card", why, t); changed = true; }
  }
  for (const x of S.tiles) {
    if (hasPicture(x) && !x.pictured) {
      x.pictured = true;
      A.push({ a: "picture", login: x.login, lat: x.qualAt ? Math.max(0, t - x.qualAt) : null, warm: !x.cold });
    }
  }
  return changed;
}

/**
 * One step. input I = {
 *   why_off: null | "site_off" | "livecams_off" | "webrtc_off" | "room_off" | "prime" | "pepe" | "pepe_old" | "stale" | "pad_off",
 *   holders: [{login, since}]  proven, real holders in grab order,  unproven_n,
 *   others: [{key, since}]  holders nobody can show (unproven, anonymous, account keys, bots),  pepe: since | true | null,
 *   elig: Map(login -> "ok" | "off_cam" | "cam_unknown" (1.99afl: the roster can't say) | "pending" | "notice" (not noticed
 *         notice_lead_s ago) | CUT code)  holders + tiles,
 *   sess: Map(login -> {state, why, exact, held, mfOnly, viewers})     livecam.mfState,
 *   pad: {layout, max_people, max_live, default_view, keep_recent (minutes)},
 *   room: {cams, listAt (ms of Pepe's last complete participant-list read, null = none), listFresh (true / false / null)},
 *   site: {maxLive, coldLeft, coldWhy (why coldLeft is 0: cold_off | rate | relays | full), stillsLeft, poolLeft (Pepe's cam pool
 *          share: cold opens + stills), shed (make room for a manual cam), unkOpen (1.99afl review: Pepe opens a cam_unknown
 *          person's cam by its exact name - MF_UNK_OPEN)},
 *   pins: [login | {login}]  the pad's pinned cams (mfix) }
 * -> {state, actions}
 */
function step(S, I, C, t) {
  const A = [];
  S.unproven = Math.max(0, I.unproven_n | 0);
  if (S.frozenUntil && S.frozenUntil <= t) S.frozenUntil = 0;
  // 1.99afl (S1b): a paused room resumes on a complete list read newer than the one it paused under (or LIST_PAUSE_MAX_MS)
  const room = I.room || {};
  const listAt = Number(room.listAt) > 0 ? Number(room.listAt) : 0;
  if (S.listPause && ((room.listFresh === true && listAt > S.listPause.listAt) || t - S.listPause.since >= LIST_PAUSE_MAX_MS)) {
    endPause(S);
    S.v++;
    A.push({ a: "touch", why: "list_back" });
  }
  S.listAtSeen = listAt || null;
  // (1.99afl review: whose cam the roster couldn't classify now - a "not_on_cam" end / refusal for them reads "checking")
  S.camUnk = new Set();
  if (I.elig && typeof I.elig.forEach === "function") I.elig.forEach((e, l) => { if (e === "cam_unknown") S.camUnk.add(l); });
  // RUN (§3.2): a stale sync is ridden out for stale_hold_s with the program unchanged (consent cuts still apply)
  if (I.why_off) {
    if (I.why_off === "stale" && S.running && S.tiles.length) {
      if (!S.staleSince) S.staleSince = t;
      if (t - S.staleSince <= C.stale_hold_s * 1000) {
        S.whyOff = null;
        consentCuts(S, I, t, A);
        // the pictures still follow their relays (livecam's state, not Pepe's room sync): a starting tile turns live, an
        // ended one a card - but nothing new is opened on a stale roster
        if (pictures(S, I, C, t, A, { fresh: false })) { S.v++; A.push({ a: "touch", why: "picture" }); }
        if (!S.tiles.length) S.active = false;
        else if (S.tiles.some(showsSoon)) S.active = true;
        return { state: S, actions: A };
      }
    }
    clearAll(S, I.why_off === "site_off" ? "kill" : I.why_off, t, A);
    S.running = false; S.staleSince = 0; S.whyOff = I.why_off;
    return { state: S, actions: A };
  }
  S.running = true; S.staleSince = 0; S.whyOff = null;
  // 1
  consentCuts(S, I, t, A);
  // mfix: the pad's pinned cams - their people are never mic tiles (a tile of someone just pinned comes off: no duplicate,
  // and no cooldown when the pin ends - they were on the stage all along)
  const pins = new Set((I.pins || []).map((p) => (p && typeof p === "object" ? p.login : p)).filter(Boolean));
  const pinsMoved = pins.size !== S.pinned.size || [...pins].some((l) => !S.pinned.has(l));
  S.pinned = pins;
  const pinnedOff = S.tiles.filter((x) => pins.has(x.login));
  for (const x of pinnedOff) { removeTile(S, x, "pinned", t, A); S.leftAt.delete(x.login); }
  if (pinnedOff.length || pinsMoved) { compact(S); S.v++; A.push({ a: "touch", why: "pins" }); }
  // 2
  const HS = track(S, I.holders || [], C, t);
  trackOthers(S, I, t);
  for (const x of S.tiles) x.relAt = HS.has(x.login) ? null : (x.relAt || t);
  // grab-spam (DF-37): off the mic stage now (a forced removal, like a cut: no hold, no card)
  const caught = grabSpam(S, C, t);
  const spamOff = S.tiles.filter((x) => spamming(S, x.login, t));
  if (spamOff.length) {
    for (const x of spamOff) removeTile(S, x, "spam", t, A);
    noteCut(S, spamOff.map((x) => x.login), t);
    compact(S);
    S.v++;
    A.push({ a: "touch", why: "cut", cut: spamOff.length });
    if (!S.tiles.length) S.active = false;
  }
  if (caught.length) A.push({ a: "spam", n: caught.length });
  // the pad's first notice (DF-11): at the first qualifying grab, before anyone can be picked - frozen or not
  for (const h of I.holders || []) {
    if (pins.has(h.login)) continue;                         // mfix: pinned - on the stage by the pin's own consent, not the mic's
    const s = S.seen.get(h.login);
    if (s && s.held && t - s.since >= C.min_hold_s * 1000 && I.elig.get(h.login) === "notice" && !spamming(S, h.login, t)) A.push({ a: "notice_first", login: h.login });
  }
  // speech nobody can show (DF-30) / Pepe alone (DF-12). mfix: the tiles stay, dimmed on the page (S.speaking); only the
  // site knob unattributed_clear brings back the old give-way (no hand-over / idle hold) - and never for Pepe's own mic-ups
  const speak = speaking(S, I, C, t);
  const clearing = speak === "someone" && C.unattributed_clear === true;
  // 4 (computed before 3: the last-on lock needs "is a qualified holder waiting")
  const onStage = new Set([...S.tiles.map((x) => x.login), ...pins]);
  const frozen = S.frozenUntil > t;
  const qualified = [];
  if (!frozen) {
    for (const h of I.holders || []) {
      const s = S.seen.get(h.login);
      if (!s || !s.held || onStage.has(h.login)) continue;
      if (t - s.since < C.min_hold_s * 1000) continue;
      const e = I.elig.get(h.login);
      // cut, not noticed long enough ago, or not known yet (1.99afl: a cam the roster can't classify yet still goes up - as a
      // "checking their cam…" card, like a "cam off" one did before)
      if (e !== "ok" && e !== "off_cam" && e !== "cam_unknown") continue;
      if (spamming(S, h.login, t)) continue;
      qualified.push({ login: h.login, since: s.since });
    }
  }
  // 3 due removals (+ the last-on lock; with unattributed_clear neither hold applies while speech nobody can show runs).
  // mfix: a recent speaker stays keep_recent minutes after letting go (until a new speaker needs the room - 5); one whose
  // cam went off leaves after the plain hand-over (a "cam off" card isn't worth keeping)
  const minOn = C.min_on_stage_s * 1000;
  const keepMs = Math.max(0, Number(I.pad.keep_recent) || 0) * 60 * 1000;
  const offCam = (x) => I.elig.get(x.login) === "off_cam";
  const holdOf = (x) => (clearing ? 0 : offCam(x) ? C.handover_s * 1000 : Math.max(C.handover_s * 1000, keepMs));
  const dueAt = (x, hold) => Math.max(x.relAt + hold, x.addedAt + minOn);
  let due = S.tiles.filter((x) => x.relAt != null && t >= dueAt(x, holdOf(x)));
  if (!clearing && S.tiles.length && due.length === S.tiles.length && !qualified.length) {
    due = S.tiles.filter((x) => x.relAt != null && t >= dueAt(x, offCam(x) ? holdOf(x) : Math.max(C.idle_hold_s * 1000, holdOf(x))));
  }
  const dueSet = new Set(due);
  let remaining = S.tiles.filter((x) => !dueSet.has(x));
  // the layout's cap went down (the owner narrowed it): the oldest extras go, once they've been on min_on_stage_s.
  // mfix: pinned cams take their places first (they count toward max_people); at least one place stays the mic's
  const layout = S.layoutOverride || I.pad.layout || "auto";
  const cap = Math.max(1, Math.min(I.pad.max_people, layoutCap(layout)) - pins.size);
  const trim = [];
  if (remaining.length > cap) {
    for (const x of remaining.slice().sort((a, b) => a.addedAt - b.addedAt)) {
      if (remaining.length - trim.length <= cap) break;
      if (t - x.addedAt >= minOn) trim.push(x);
    }
    const trimSet = new Set(trim);
    remaining = remaining.filter((x) => !trimSet.has(x));
  }
  // 4 cont.: the cooldown, unless the stage would otherwise be empty (but always after a consent cut); newest first
  const cool = (m, l) => t - (m.get(l) || -Infinity) < C.cooldown_s * 1000;
  const cands = qualified.filter((c) => !cool(S.cutAt, c.login) && (!remaining.length || !cool(S.leftAt, c.login)))
    .sort((a, b) => b.since - a.since);
  // 5 capacity + displacement (the newest speaker policy)
  const adds = [], displaced = [];
  let free = cap - remaining.length;
  const holderSince = (x) => { const s = S.seen.get(x.login); return x.relAt != null || !s || !s.held ? -Infinity : s.since; };
  for (const c of cands) {
    if (free > 0) { adds.push(c); free--; continue; }
    // released tiles first - mfix: the one off the mic LONGEST - then the one added longest ago
    const pool = remaining.filter((x) => !displaced.includes(x) && t - x.addedAt >= minOn && holderSince(x) < c.since)
      .sort((a, b) => (a.relAt != null ? 0 : 1) - (b.relAt != null ? 0 : 1) || (a.relAt || 0) - (b.relAt || 0) || a.addedAt - b.addedAt);
    if (!pool.length) continue;
    displaced.push(pool[0]);
    adds.push(c);
  }
  // 6 the change budget
  const change = due.length + trim.length + displaced.length + adds.length > 0;
  let gaveWay = false;
  if (change) {
    S.changes = S.changes.filter((x) => t - x < 60 * 1000);
    const ok = t - S.lastChangeAt >= C.min_gap_s * 1000 && S.changes.length < C.max_changes_per_min;
    if (!ok) {
      // counted once per deferred change (not once per 1 s retry of the same one)
      if (!S.deferring) { S.deferring = true; S.deferred++; A.push({ a: "deferred" }); }
    } else {
      S.deferring = false;
      // 7 apply
      for (const x of due) removeTile(S, x, "released", t, A);
      for (const x of trim) removeTile(S, x, "trim", t, A);
      for (const x of displaced) removeTile(S, x, "displaced", t, A);
      // the earliest grab first, so the one who grabbed LAST is the newest speaker (the highlight, live video first)
      for (const c of adds.slice().sort((a, b) => a.since - b.since)) {
        const x = { login: c.login, addedAt: t, since: c.since, pos: S.tiles.length, relAt: null, video: "card", why: null, pend: false, pictured: false,
                    qualAt: c.since + C.min_hold_s * 1000, cold: false, vidSince: 0, vidMs: 0, peak: 0, unverifiedAt: 0 };
        S.tiles.push(x);
        A.push({ a: "span_open", login: c.login });
      }
      compact(S);
      S.lastChangeAt = t;
      S.changes.push(t);
      S.v++;
      A.push({ a: "touch", why: "change", add: adds.length, rem: due.length + trim.length + displaced.length });
      gaveWay = !!speak && due.length > 0;
    }
  } else S.deferring = false;
  // the neutral card: it replaces tiles that left while speech nobody can show ran (never a stage that was idle anyway;
  // mfix: nor one with pinned cams - they stay up, dimmed like tiles)
  const neutral = speak && !S.tiles.length && !pins.size && (gaveWay || S.neutral) ? speak : null;
  if (neutral !== S.neutral) { S.neutral = neutral; S.v++; A.push({ a: "touch", why: "neutral" }); }
  // mfix: tiles (or pins) kept up while speech nobody can show / Pepe runs: the page dims them and says who speaks
  const speakingNow = speak && (S.tiles.length || pins.size) ? speak : null;
  if (speakingNow !== S.speaking) { S.speaking = speakingNow; S.v++; A.push({ a: "touch", why: "speaking" }); }
  pruneMaps(S, t);
  // 8 pictures
  if (pictures(S, I, C, t, A)) { S.v++; A.push({ a: "touch", why: "picture" }); }
  // 9 active
  if (!S.tiles.length) S.active = false;
  else if (S.tiles.some(showsSoon)) S.active = true;
  return { state: S, actions: A };
}

/** A hold micfollow.js tried finished: ok, or refused with a livecam code. -> actions */
function holdDone(S, login, ok, code, C, t) {
  const A = [];
  const x = tileOf(S, login);
  if (!x) { if (ok) A.push({ a: "release", login }); return A; }   // it left meanwhile
  x.pend = false;
  if (ok) return A;
  const unk = code === "not_on_cam" && camUnknownNow(S, x);
  x.unkHold = 0;
  if (code === "opted_out" || code === "unavailable" || code === "ended_by") {
    // livecam's own consent check refused it (opted out, private activity, a relay someone ended): a CUT - off now, no
    // card left behind (§4.1). train2 merge: stagefix's stageConsent says "unavailable" - neutral, never which - for private
    // activity, "Take me off this Stage", a block with the pad's owner and a stage ban: a cut too
    removeTile(S, x, "cut:" + code, t, A);
    noteCut(S, [login], t);
    compact(S);
    if (!S.tiles.length) S.active = false;
    S.v++;
    A.push({ a: "touch", why: "cut", cut: 1 });
    return A;
  }
  if (code === "gone") {
    // the mic stage's own re-check after the hold's awaits said no (a cut on its way): nothing was held - the next step
    // decides (it cuts the tile, or tries again); no backoff
    setVideo(x, null, null, t);
    S.v++;
    return A;
  }
  if (code === "list_unread") listUnread(S, x, t);       // 1.99afl (S1b): the ROOM pauses - never this person's failure
  else if (unk) camUnknownCard(S, x, t);                 // (1.99afl review: a cam the roster can't classify isn't "off")
  else if (code === "not_on_cam") { S.offcam.set(login, t); setVideo(x, "card", "off_cam", t); }
  else if (code === "slots_busy" || code === "budget") {
    // the site's live relays were full at that moment (a race - e.g. a manual cam slot took the freed one): "full" and
    // another try soon; never the 10-minute failure backoff (that would block its still too)
    S.liveBlock.set(login, t + FULL_RETRY_MS);
    S.blockWhy.set(login, "full");
    notePauseBlock(S, login);
    setVideo(x, "card", "full", t);
  } else setVideo(x, "card", failOpen(S, login, code, C, t), t);   // mfix: a soft reason is tried again soon
  S.v++;
  A.push({ a: "touch", why: "hold_failed" });
  return A;
}

/** livecam ended the relay of `login` (its onEnd hook). -> {cut: CUT code | null, actions} */
function sessionEnded(S, login, why, C, t) {
  const A = [];
  const x = tileOf(S, login);
  if (!x) return { cut: null, actions: A };
  why = String(why || "");
  if (why === "opted_out" || why === "ended_by" || why === "ended_by_admin") {
    const code = why === "opted_out" ? "opted_out" : "ended_by";
    removeTile(S, x, "cut:" + code, t, A);
    noteCut(S, [login], t);
    compact(S);
    if (!S.tiles.length) S.active = false;
    S.v++;
    A.push({ a: "touch", why: "cut", cut: 1 });
    return { cut: code, actions: A };
  }
  if (!liveish(x) && !x.pend) return { cut: null, actions: A };
  x.pend = false;
  const unk = why === "not_on_cam" && camUnknownNow(S, x);
  x.unkHold = 0;
  if (why === "list_unread") listUnread(S, x, t);        // 1.99afl (S1b): the room pauses (before failOpen: never counted)
  // 1.99afl review (S2): Pepe refused - or stopped - the relay "not_on_cam" while the roster couldn't classify the cam (his
  // epoch open, or his own tick ending a running relay when his on_cam went unknown): "checking their cam…", not "cam off"
  else if (unk) camUnknownCard(S, x, t);
  else if (OFFCAM_WHYS.has(why)) { S.offcam.set(login, t); setVideo(x, "card", "off_cam", t); }
  else if (why === "slots_busy") {                        // mfix: Pepe's live cams were full - a race, another try soon
    S.liveBlock.set(login, t + FULL_RETRY_MS);
    S.blockWhy.set(login, "full");
    notePauseBlock(S, login);
    setVideo(x, "card", "full", t);
  } else if (FAIL_WHYS.has(why)) setVideo(x, "card", failOpen(S, login, why, C, t), t);   // mfix: soft reasons retry soon
  else setVideo(x, null, null, t);                        // anything else: the next step finds it a picture again
  S.v++;
  A.push({ a: "touch", why: "session_end" });
  return { cut: null, actions: A };
}

/** A still frame came back refused. 1.99afl (S1): by Pepe's `code` (bot 1.99afk) - list_unread pauses the ROOM (S1b); a
 *  hard refusal (STILL_HARD: "cam isn't public", not on cam, ambiguous, not in the list) is a card and the full backoff;
 *  anything else (busy, noswitch, start_timeout, wrong_room, failed, an unknown code, or none at all - an older Pepe) is
 *  soft: failOpen's retry after soft_retry_s (soft_fails_max of them, then the backoff), never the 10 minutes at once.
 *  -> actions */
function stillFailed(S, login, C, t, code = null) {
  const A = [];
  const x = tileOf(S, login);
  if (!x || x.video !== "still") return A;
  A.push({ a: "still_stop", login });
  const c = typeof code === "string" ? code : "";
  if (c === "list_unread") listUnread(S, x, t);
  else if (STILL_HARD.has(c)) {
    S.backoff.set(login, t + C.open_fail_backoff_min * 60 * 1000);
    notePauseBlock(S, login);
    setVideo(x, "card", "failed", t);
  } else setVideo(x, "card", failOpen(S, login, SOFT_WHYS.has(c) ? c : "busy", C, t), t);
  S.v++;
  A.push({ a: "touch", why: "still_failed" });
  return A;
}

/** A manual cam slot needs the relay: this tile gives its live picture up (still / card), not back for blockMs. */
function yieldTile(S, login, t, blockMs = 60 * 1000) {
  const x = tileOf(S, login);
  if (!x) return false;
  x.pend = false;
  S.liveBlock.set(login, t + blockMs);
  S.blockWhy.set(login, "full");
  setVideo(x, null, null, t);
  S.v++;
  return true;
}

/** The owner's ✕ / an exclusion / a ban: off now, no hand-over (a consent cut outside a step). -> actions */
function cutNow(S, login, code, t) {
  const A = [];
  const x = tileOf(S, login);
  if (!x) return A;
  removeTile(S, x, "cut:" + code, t, A);
  noteCut(S, [login], t);
  compact(S);
  if (!S.tiles.length) S.active = false;
  S.v++;
  A.push({ a: "touch", why: "cut", cut: 1 });
  return A;
}

/** The owner's "Clear the stage" (addendum 14.1.2 #3): everyone off now (no hand-over, no card), the program idles and
 *  freezes for freezeMs (nobody new comes on); each person waits the cooldown after it, as after a cut. -> actions */
function clearStage(S, t, freezeMs) {
  const A = [];
  const out = S.tiles.map((x) => x.login);
  for (const x of S.tiles.slice()) removeTile(S, x, "cleared", t, A);
  S.tiles = [];
  if (out.length) noteCut(S, out, t);
  S.active = false; S.neutral = null; S.speaking = null;
  S.frozenUntil = Math.max(S.frozenUntil || 0, t + Math.max(0, freezeMs || 0));
  S.v++;
  A.push({ a: "touch", why: "cleared", cut: out.length });
  return A;
}

/** Is anything in this pad's program waiting on the clock? (the 1 s timer only steps these) */
function hot(S, t) {
  if (S.tiles.length || S.staleSince || S.neutral || S.speaking || S.oseen.size || S.pepeSince || S.listPause) return true;
  for (const s of S.seen.values()) if (s.held) return true;
  return false;
}

module.exports = {
  FIELDS, DEFAULTS, PAD_FIELDS, PAD_DEFAULTS, LAYOUTS, SHAPES, DEFAULT_VIEWS, CUT, isCut, FAIL_WHYS, SOFT_WHYS, OFFCAM_WHYS, EXACT_WAIT_MS, FULL_RETRY_MS, OFFCAM_RETRY_MS,
  CARD_WHYS, KEEP_RECENT, STILL_HARD, LIST_PAUSE_MAX_MS, MF_UNK_OPEN,
  normalize, normalizePad, layoutCap, layoutFor, shapeFor, maxPins, newState, step, holdDone, sessionEnded, stillFailed, yieldTile, cutNow, clearStage, hot, speaking,
  shapeOf, newest, tileOf, hasPicture, liveish, failOpen,
};
