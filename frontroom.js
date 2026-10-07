// frontroom.js — the homepage's AUTOMATIC room pick (1.99cj): a fair activity ranking with
// hysteresis. Pure functions; rooms.js keeps the state (rooms_kv "front_auto"), the settings
// (rooms_kv "front_cfg"), the clock and the event log.
//
// SCORE (per live bridged room, people only - bots and Pepe never count, see roomactivity.js):
//     score = w.chatters * unique chatters      (last window_min minutes)
//           + w.lines    * chat lines           (last window_min minutes)
//           + w.mic      * mic minutes          (last window_min minutes, summed over holders)
//           + w.people   * people in the room   (now)
//   defaults: chatters 4, lines 0.25, mic 1.5, people 0.5, window 20 min. No room gets a bonus:
//   not the house room (Pepe's Pad), not the room Pepe's Camfrog window shows. Ties: more people,
//   then more chatters, then the room id (stable, alphabetical).
//
// HYSTERESIS (one evaluation per eval_sec, default 60 s):
//   * nothing chosen yet, or the chosen room is no longer live / bridged -> the top room, now
//   * the chosen room "died out" (no human chat line or mic for dead_min, default 10 min) and the
//     top room is NOT dead -> the top room, now
//   * otherwise it's kept for at least hold_min (default 30 min); after that it changes only when
//     the best other room's score is >= lead_ratio (1.25) x the chosen room's for lead_evals (2)
//     evaluations in a row (the streak resets when a different room leads, or after a gap of more
//     than 3 evaluation periods with no evaluation)
//   * no live room at all -> keep whatever was chosen (the caller falls back to the house room only
//     when nothing was ever chosen)
//   * an admin's "Re-evaluate now" picks the top room immediately, hold or not
//
// 🚀 BOOSTS (1.99ee, boosts.js - featuring is earned, never bought): anyone can boost a pad with PAT.
// A row's `boost` = its ACTIVE boost PAT (each boost decays with a half-life of boost.half_min, 60 min).
//     boost points = 0 if the room is dead (no human chat / mic for dead_min) or its activity score is 0
//                  = min(boost.cap, boost.k * sqrt(active PAT), boost.rel * activity score)
//   defaults k 0.1, cap 25, rel 0.5: 10k PAT -> +10, 40k -> +20, 62.5k+ -> +25 (the cap), and never more
//   than half of the room's own activity score. A busy room scores ~40-80, a quiet one ~10, and a switch
//   needs a 1.25x lead for 2 checks after the 30-minute hold - so a boost can tip a close race (it can
//   be the last 25%), sqrt makes every extra PAT worth less, and a dead or empty room can't win at all.
//   The 30-minute hold is the minimum dwell: a boost only ever acts through the clear-lead rule, so
//   it can never move the pick sooner than hold_min after the last switch.
"use strict";

const DEFAULTS = Object.freeze({
  hold_min: 30, lead_ratio: 1.25, lead_evals: 2, dead_min: 10, window_min: 20, eval_sec: 60,
  w: Object.freeze({ chatters: 4, lines: 0.25, mic: 1.5, people: 0.5 }),
  boost: Object.freeze({ on: true, k: 0.1, cap: 25, rel: 0.5, half_min: 60 }),
});
const LIMITS = {
  hold_min: [0, 24 * 60], lead_ratio: [1, 10], lead_evals: [1, 30], dead_min: [1, 240], window_min: [5, 90], eval_sec: [15, 900],
};
const BOOST_LIMITS = { k: [0, 10], cap: [0, 1000], rel: [0, 5], half_min: [5, 24 * 60] };
const W_MAX = 100;

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** Clamp an admin's settings patch onto a full config. */
function cleanCfg(patch, base = DEFAULTS) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = { w: {} };
  for (const k of Object.keys(LIMITS)) {
    const [lo, hi] = LIMITS[k];
    out[k] = num(p[k], lo, hi, base[k] != null ? base[k] : DEFAULTS[k]);
  }
  out.lead_evals = Math.round(out.lead_evals);
  const pw = p.w && typeof p.w === "object" ? p.w : {};
  const bw = (base && base.w) || DEFAULTS.w;
  for (const k of Object.keys(DEFAULTS.w)) {
    // flat form fields (w_chatters) are accepted too
    const v = pw[k] != null ? pw[k] : p["w_" + k];
    out.w[k] = num(v, 0, W_MAX, bw[k] != null ? bw[k] : DEFAULTS.w[k]);
  }
  // 1.99ee: boost terms (nested {boost: {...}} or flat boost_k / boost_cap / boost_rel / boost_half_min / boost_on)
  const pb = p.boost && typeof p.boost === "object" ? p.boost : {};
  const bb = (base && base.boost) || DEFAULTS.boost;
  out.boost = {};
  for (const k of Object.keys(BOOST_LIMITS)) {
    const v = pb[k] != null ? pb[k] : p["boost_" + k];
    out.boost[k] = num(v, BOOST_LIMITS[k][0], BOOST_LIMITS[k][1], bb[k] != null ? bb[k] : DEFAULTS.boost[k]);
  }
  const on = pb.on != null ? pb.on : p.boost_on;
  out.boost.on = on == null || on === "" ? (bb.on != null ? !!bb.on : true) : (on === true || on === 1 || on === "1" || on === "on" || on === "true");
  return out;
}

/** Boost points for a room (pure): 0 for a dead / inactive room, else min(cap, k*sqrt(active), rel*activity). */
function boostPoints(activePat, actScore, dead, b = DEFAULTS.boost) {
  const a = Math.max(0, Number(activePat) || 0), s = Math.max(0, Number(actScore) || 0);
  if (!b || b.on === false || dead || s <= 0 || a <= 0) return 0;
  return r2(Math.min(b.cap, b.k * Math.sqrt(a), b.rel * s));
}

const r2 = (n) => Math.round(n * 100) / 100;
/** act = {chatters, lines, micMin, people} -> {score, parts: {chatters: {n, w, pts}, ...}} */
function score(act, w = DEFAULTS.w) {
  const a = act || {};
  const parts = {
    chatters: { n: Math.max(0, Number(a.chatters) || 0), w: w.chatters },
    lines: { n: Math.max(0, Number(a.lines) || 0), w: w.lines },
    mic: { n: Math.max(0, Number(a.micMin) || 0), w: w.mic },
    people: { n: Math.max(0, Number(a.people) || 0), w: w.people },
  };
  let s = 0;
  for (const k of Object.keys(parts)) { parts[k].pts = r2(parts[k].n * parts[k].w); s += parts[k].n * parts[k].w; }
  return { score: r2(s), parts };
}

const isDead = (lastAt, cfg, now) => !lastAt || now - lastAt > cfg.dead_min * 60 * 1000;

/** rows = [{id, live, act: {chatters, lines, micMin, people, lastAt}, boost: active boost PAT}] -> live rooms, best first. */
function rank(rows, cfg, now) {
  return (rows || []).filter((r) => r && r.id && r.live).map((r) => {
    const sc = score(r.act, cfg.w);
    const dead = isDead(r.act && r.act.lastAt, cfg, now);
    const bp = boostPoints(r.boost, sc.score, dead, cfg.boost || DEFAULTS.boost);
    const parts = { ...sc.parts };
    if (Number(r.boost) > 0) parts.boost = { n: Math.round(Number(r.boost)), w: (cfg.boost || DEFAULTS.boost).k, pts: bp };
    return { id: r.id, score: r2(sc.score + bp), activity: sc.score, boost: bp, parts, lastAt: (r.act && r.act.lastAt) || null, dead };
  }).sort((a, b) => b.score - a.score || b.parts.people.n - a.parts.people.n || b.parts.chatters.n - a.parts.chatters.n
         || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * One evaluation. state = {id, at, lead: {id, n} | null, evalAt} (or null).
 * Returns {state, switched: {from, to, reason} | null}.
 */
function decide(state, ranked, cfg, now, { force = false } = {}) {
  const st = state && state.id ? { ...state } : { id: null, at: 0, lead: null, evalAt: 0 };
  // a long gap without evaluations breaks a lead streak ("in a row" means consecutive periods)
  if (st.evalAt && now - st.evalAt > 3 * cfg.eval_sec * 1000) st.lead = null;
  st.evalAt = now;
  const top = ranked[0] || null;
  const pick = (r, why) => {
    const from = st.id;
    const reason = why + (r.boost > 0 ? ` · incl. 🚀 boost +${r.boost}` : "");
    const same = from === r.id;
    const next = { ...st, id: r.id, at: same ? st.at : now, lead: null, score: r.score, parts: r.parts, reason: same ? st.reason : reason };
    return { state: next, switched: same ? null : { from, to: r.id, reason } };
  };
  if (!top) return { state: st, switched: null };                         // nothing live: keep what we have
  if (force) return pick(top, "re-evaluated by an admin");
  const cur = st.id ? ranked.find((r) => r.id === st.id) : null;
  if (!cur) return pick(top, st.id ? "the featured pad is no longer live" : "first pick");
  st.score = cur.score; st.parts = cur.parts;
  // the best OTHER room, and whether it clearly leads this time
  const other = ranked.find((r) => r.id !== cur.id) || null;
  const leads = !!(other && other.score > 0 && other.score >= cfg.lead_ratio * cur.score);
  st.lead = leads ? { id: other.id, n: (st.lead && st.lead.id === other.id ? st.lead.n : 0) + 1, score: other.score } : null;
  if (cur.dead && top.id !== cur.id && !top.dead) {
    return pick(top, `activity died out (no chat or mic for ${cfg.dead_min} min)`);
  }
  const held = now - (st.at || 0) < cfg.hold_min * 60 * 1000;
  if (!held && st.lead && st.lead.n >= cfg.lead_evals) {
    const r = ranked.find((x) => x.id === st.lead.id);
    if (r) return pick(r, `clear lead: ${r.score} vs ${cur.score} (>= ${cfg.lead_ratio}x for ${st.lead.n} checks)`);
  }
  return { state: st, switched: null };
}

module.exports = { DEFAULTS, LIMITS, BOOST_LIMITS, cleanCfg, score, boostPoints, rank, decide, isDead };
