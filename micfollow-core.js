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
  relays_max:            { def: 2, min: 0, max: 24 },
  cold_open:             { def: STAGING, bool: true },          // prod waits for V-2 / V-3
  cold_opens_per_min:    { def: 4, min: 0, max: 30 },           // site-wide
  cold_opens_per_pad:    { def: 2, min: 0, max: 30 },           // a minute, per pad
  open_fail_backoff_min: { def: 10, min: 1, max: 120 },
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
  max_live:              { def: 4, min: 1, max: 4 },
  notice_lead_s:         { def: 120, min: 120, max: 3600 },     // DF-11: the pad's first notice this long before the first pick
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
const PAD_FIELDS = Object.freeze({
  on:           { def: false, bool: true },
  layout:       { def: "auto", choices: LAYOUTS },
  default_view: { def: "first", choices: DEFAULT_VIEWS },
  max_people:   { def: 4, min: 1, max: 9 },
  max_live:     { def: 4, min: 1, max: 4 },
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
  "nopepe", "not_open", "no_pic"]);
const OFFCAM_WHYS = new Set(["not_on_cam", "cam_closed", "left_cam"]);
/** A held relay Pepe hasn't opened / verified by the exact name (sess.exact !== true) is never shown; after this long the
 *  mic stage gives it up (Pepe re-checks a running cam at most every 20 s: two tries and a poll). */
const EXACT_WAIT_MS = 45 * 1000;
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
    changes: [],               // times of the last minute's changes
    lastChangeAt: -Infinity,
    v: 0, active: false, running: false, staleSince: 0, whyOff: null,
    frozenUntil: 0, layoutOverride: null, deferred: 0, deferring: false, unproven: 0,
  };
}
const tileOf = (S, login) => S.tiles.find((x) => x.login === login) || null;
const hasPicture = (x) => x.video === "live" || x.video === "still";
const liveish = (x) => x.video === "live" || x.video === "starting";
// ties (several added in one change) go by when they grabbed the mic: the later grab is the newer speaker
const newer = (a, b) => a.addedAt - b.addedAt || (a.since || 0) - (b.since || 0) || a.pos - b.pos;
function compact(S) {
  S.tiles.sort(newer);
  S.tiles.forEach((x, i) => { x.pos = i; });
}
function newest(S) {
  let n = null;
  for (const x of S.tiles) if (!n || newer(x, n) > 0) n = x;
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
  if (S.offcam.size > 200) for (const [l, at] of [...S.offcam]) if (t - at >= OFFCAM_RETRY_MS) S.offcam.delete(l);
  if (S.leftAt.size > 500) for (const [l, at] of [...S.leftAt]) if (t - at > 3600e3) S.leftAt.delete(l);
  if (S.sawOff.size > 200) S.sawOff.clear();
}
/** The layout shape the mic stage shows now. */
function shapeOf(S, pad) { return layoutFor(S.layoutOverride || (pad && pad.layout) || "auto", S.tiles.length); }

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
  S.layoutOverride = null;
  S.seen.clear();
  S.oseen.clear(); S.pepeSince = 0;
  const neutral = !!S.neutral;
  S.neutral = null;
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
    if (!S.tiles.length) { S.active = false; S.layoutOverride = null; }
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
    const e = I.elig.get(h.login);
    if ((e === "ok" || e === "off_cam") && !spamming(S, h.login, t)) { attributed = true; continue; }
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
          S.inexact.set(x.login, t + C.open_fail_backoff_min * 60 * 1000);
          x.unverifiedAt = 0;
          setVideo(x, null, null, t);                         // (b) gives it a still (an exact job) or a card
          changed = true;
          continue;
        }
        if (x.video !== "starting") { setVideo(x, "starting", null, t); changed = true; }
        continue;
      }
      const want = ss.state === "live" ? "live" : "starting";
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
      if (x.video !== "card" || x.why !== "off_cam") { setVideo(x, "card", "off_cam", t); changed = true; }
      continue;
    }
    const backed = (S.backoff.get(x.login) || 0) > t;
    const inexact = (S.inexact.get(x.login) || 0) > t;
    const blocked = backed || inexact || (S.liveBlock.get(x.login) || 0) > t;
    if (fresh && e !== "pending" && e !== "notice" && used < padMaxLive && !blocked) {
      // warm: a relay that runs already (a ▶ Live viewer's / a cam slot's) - held, it's shown once Pepe says it's exact (a)
      const warm = ss.state === "connecting" || ss.state === "live";
      const isCold = ss.state === "none" || ss.state === "ended";
      if (warm || (isCold && cold > 0 && pool > 0 && !shed)) {
        if (x.video === "still") A.push({ a: "still_stop", login: x.login });
        if (isCold) { cold--; pool--; }
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
    if (fresh && C.stills && C.cold_open && I.room.cams && !backed && !shed && e !== "pending" && e !== "notice" && stills > 0 && pool > 0) {
      stills--; pool--;
      setVideo(x, "still", null, t);
      A.push({ a: "still", login: x.login });
      changed = true;
      continue;
    }
    const why = backed || inexact ? "failed" : "full";
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
 *   elig: Map(login -> "ok" | "off_cam" | "pending" | "notice" (not noticed notice_lead_s ago) | CUT code)  holders + tiles,
 *   sess: Map(login -> {state, why, exact, held, mfOnly, viewers})     livecam.mfState,
 *   pad: {layout, max_people, max_live, default_view},  room: {cams},
 *   site: {maxLive, coldLeft, stillsLeft, poolLeft (Pepe's cam pool share: cold opens + stills), shed (make room for a manual cam)} }
 * -> {state, actions}
 */
function step(S, I, C, t) {
  const A = [];
  S.unproven = Math.max(0, I.unproven_n | 0);
  if (S.frozenUntil && S.frozenUntil <= t) S.frozenUntil = 0;
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
        else if (S.tiles.some(hasPicture)) S.active = true;
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
    if (!S.tiles.length) { S.active = false; S.layoutOverride = null; }
  }
  if (caught.length) A.push({ a: "spam", n: caught.length });
  // the pad's first notice (DF-11): at the first qualifying grab, before anyone can be picked - frozen or not
  for (const h of I.holders || []) {
    const s = S.seen.get(h.login);
    if (s && s.held && t - s.since >= C.min_hold_s * 1000 && I.elig.get(h.login) === "notice" && !spamming(S, h.login, t)) A.push({ a: "notice_first", login: h.login });
  }
  // speech nobody can show (DF-30) / Pepe alone (DF-12): the hand-over and idle holds don't apply
  const speak = speaking(S, I, C, t);
  // 4 (computed before 3: the last-on lock needs "is a qualified holder waiting")
  const onStage = new Set(S.tiles.map((x) => x.login));
  const frozen = S.frozenUntil > t;
  const qualified = [];
  if (!frozen) {
    for (const h of I.holders || []) {
      const s = S.seen.get(h.login);
      if (!s || !s.held || onStage.has(h.login)) continue;
      if (t - s.since < C.min_hold_s * 1000) continue;
      const e = I.elig.get(h.login);
      if (e !== "ok" && e !== "off_cam") continue;            // cut, not noticed long enough ago, or not known yet
      if (spamming(S, h.login, t)) continue;
      qualified.push({ login: h.login, since: s.since });
    }
  }
  // 3 due removals (+ the last-on lock; neither hold applies while speech nobody can show runs)
  const minOn = C.min_on_stage_s * 1000;
  const dueAt = (x, hold) => Math.max(x.relAt + hold, x.addedAt + minOn);
  let due = S.tiles.filter((x) => x.relAt != null && t >= dueAt(x, speak ? 0 : C.handover_s * 1000));
  if (!speak && S.tiles.length && due.length === S.tiles.length && !qualified.length) {
    due = S.tiles.filter((x) => x.relAt != null && t >= dueAt(x, C.idle_hold_s * 1000));
  }
  const dueSet = new Set(due);
  let remaining = S.tiles.filter((x) => !dueSet.has(x));
  // the layout's cap went down (the owner narrowed it): the oldest extras go, once they've been on min_on_stage_s
  const layout = S.layoutOverride || I.pad.layout || "auto";
  const cap = Math.max(1, Math.min(I.pad.max_people, layoutCap(layout)));
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
    const pool = remaining.filter((x) => !displaced.includes(x) && t - x.addedAt >= minOn && holderSince(x) < c.since)
      .sort((a, b) => (a.relAt != null ? 0 : 1) - (b.relAt != null ? 0 : 1) || a.addedAt - b.addedAt);
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
      if (!S.tiles.length) S.layoutOverride = null;
      gaveWay = !!speak && due.length > 0;
    }
  } else S.deferring = false;
  // the neutral card: it replaces tiles that gave way to speech nobody can show (never a stage that was idle anyway)
  const neutral = speak && !S.tiles.length && (gaveWay || S.neutral) ? speak : null;
  if (neutral !== S.neutral) { S.neutral = neutral; S.v++; A.push({ a: "touch", why: "neutral" }); }
  pruneMaps(S, t);
  // 8 pictures
  if (pictures(S, I, C, t, A)) { S.v++; A.push({ a: "touch", why: "picture" }); }
  // 9 active
  if (!S.tiles.length) S.active = false;
  else if (S.tiles.some(hasPicture)) S.active = true;
  return { state: S, actions: A };
}

/** A hold micfollow.js tried finished: ok, or refused with a livecam code. -> actions */
function holdDone(S, login, ok, code, C, t) {
  const A = [];
  const x = tileOf(S, login);
  if (!x) { if (ok) A.push({ a: "release", login }); return A; }   // it left meanwhile
  x.pend = false;
  if (ok) return A;
  if (code === "opted_out" || code === "unavailable" || code === "ended_by") {
    // livecam's own consent check refused it (opted out, private activity, a relay someone ended): a CUT - off now, no
    // card left behind (§4.1). train2 merge: stagefix's stageConsent says "unavailable" - neutral, never which - for private
    // activity, "Take me off this Stage", a block with the pad's owner and a stage ban: a cut too
    removeTile(S, x, "cut:" + code, t, A);
    noteCut(S, [login], t);
    compact(S);
    if (!S.tiles.length) { S.active = false; S.layoutOverride = null; }
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
  if (code === "not_on_cam") { S.offcam.set(login, t); setVideo(x, "card", "off_cam", t); }
  else if (code === "slots_busy" || code === "budget") {
    // the site's live relays were full at that moment (a race - e.g. a manual cam slot took the freed one): "full" and
    // another try soon; never the 10-minute failure backoff (that would block its still too)
    S.liveBlock.set(login, t + FULL_RETRY_MS);
    setVideo(x, "card", "full", t);
  } else {
    S.backoff.set(login, t + C.open_fail_backoff_min * 60 * 1000);
    setVideo(x, "card", "failed", t);
  }
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
    if (!S.tiles.length) { S.active = false; S.layoutOverride = null; }
    S.v++;
    A.push({ a: "touch", why: "cut", cut: 1 });
    return { cut: code, actions: A };
  }
  if (!liveish(x) && !x.pend) return { cut: null, actions: A };
  x.pend = false;
  if (OFFCAM_WHYS.has(why)) { S.offcam.set(login, t); setVideo(x, "card", "off_cam", t); }
  else if (FAIL_WHYS.has(why)) {
    S.backoff.set(login, t + C.open_fail_backoff_min * 60 * 1000);
    setVideo(x, "card", "failed", t);
  } else setVideo(x, null, null, t);                      // anything else: the next step finds it a picture again
  S.v++;
  A.push({ a: "touch", why: "session_end" });
  return { cut: null, actions: A };
}

/** A still frame came back refused ("cam isn't public", busy, not on cam): a card and the backoff. -> actions */
function stillFailed(S, login, C, t) {
  const A = [];
  const x = tileOf(S, login);
  if (!x || x.video !== "still") return A;
  S.backoff.set(login, t + C.open_fail_backoff_min * 60 * 1000);
  setVideo(x, "card", "failed", t);
  A.push({ a: "still_stop", login });
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
  if (!S.tiles.length) { S.active = false; S.layoutOverride = null; }
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
  S.active = false; S.layoutOverride = null; S.neutral = null;
  S.frozenUntil = Math.max(S.frozenUntil || 0, t + Math.max(0, freezeMs || 0));
  S.v++;
  A.push({ a: "touch", why: "cleared", cut: out.length });
  return A;
}

/** Is anything in this pad's program waiting on the clock? (the 1 s timer only steps these) */
function hot(S, t) {
  if (S.tiles.length || S.staleSince || S.neutral || S.oseen.size || S.pepeSince) return true;
  for (const s of S.seen.values()) if (s.held) return true;
  return false;
}

module.exports = {
  FIELDS, DEFAULTS, PAD_FIELDS, PAD_DEFAULTS, LAYOUTS, SHAPES, DEFAULT_VIEWS, CUT, isCut, FAIL_WHYS, OFFCAM_WHYS, EXACT_WAIT_MS, FULL_RETRY_MS, OFFCAM_RETRY_MS,
  normalize, normalizePad, layoutCap, layoutFor, newState, step, holdDone, sessionEnded, stillFailed, yieldTile, cutNow, clearStage, hot, speaking,
  shapeOf, newest, tileOf, hasPicture, liveish,
};
