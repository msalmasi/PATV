// capital/watch.js — staking monitoring and the owner's staking card (staking fix plan 2026-10-19, §6 + P1.2).
//
// MONITORING. Every cut-off (capital/vaults.js epoch) runs audit(): the invariants I1-I5, I8 and I10 land in the
// vault_epoch event's notes.audit. After the cut-off commits, afterEpoch() keeps them (capital_meta "watch_last") and alerts
// every site admin through the site's ops alerts (opsalerts.alert: the website inbox + Telegram, idempotent per ref,
// rate-limited) - ref "<day>:<code>:<vault>":
//   alert   sent every cut-off it holds
//   warn    sent at most once a week per (code, vault) (capital_meta "watch_sent")
//   info    kept for the admin card only
// The 15-second tick adds (tick()): I8 no cut-off by epoch_hour + 30 min, a queue item "moving" for over an hour; and, once a
// week from Monday 05:00 UTC, I6 (weekly()): Pepe's pushed weekly settlement (cfg.waterfall) against the site's stash moves
// (every "wf-<eid>-<vault>-stk-<stash>" leg landed, the PAT adds up per vault) and the payout notices (inbox ref
// "wf:<eid>:s<stash>", one per paid stash) + I7 (info: the share of the stakers' 20% a cap let through). A settlement that
// isn't done by Monday 06:00 alerts once (wf_watch_late:<eid>) and is checked again every tick until it is - the cross-check
// then still runs (wf_watch:<eid> is only written once a DONE record was checked). The same check ALERTS a vault paid with
// no weekly cap on a week that wasn't WHOLLY time-weighted - by Pepe's record (weighting "partial" / "snapshot"), or, for a
// record from a Pepe before 31c65d0 (no cap_pct), by the site's book (capital/vaults.js pdWhole: Pepe's bucket rule) - which
// D2's safeguard (the 25% reference cap, Pepe's _tr_plan / policy/engines planEpoch) should have prevented. A 31c65d0+ record
// that says "pat_days" while the site's book (judged after the settlement - a later Monday cut-off can have pruned a bucket
// Pepe planned with) says not whole is info (pd-view-<vault>); a vault the safeguard capped (fallback) is info; and it warns
// about one that settled more than three weeks at once (the oldest week's PAT-days were already pruned, PD_KEEP 4).
// The cut-off's own audit flags a Monday cut-off more than an hour late (I8 late-monday).
// ROUND TRIPS (roundTrips, from Monday 05:00 once the Monday cut-off ran; capital_meta "watch_roundtrips", the card): stashes
// that unstaked at the cut-off before the Monday 01:00 UTC Pepeball draw and staked again at the one after it - they skip
// the draw's drop in the House's price (and Auto's) for a day's PAT-days and the other stakers carry it. Nothing stops it
// (no fee, no lock-up; P2.4 isn't built), so the owner sees how often it happens and what it dodged (warn >= 1,000 PAT).
// D2 (the owner, 2026-10-19: the weekly payout cap goes; "we can track and implement a weekly cap if necessary"): every
// settled week Pepe reports is kept with what a 25% APR cap would have paid (capTrack -> capital_meta "wf_cap_track", the
// card's tracker table, a year of weeks; Pepe sends the weekly digest to the admins himself, ref wf-digest:<epoch>).
// Staging records the findings but never alerts. Nothing here moves PAT.
//
// THE OWNER'S CARD (/admin/economy, views/partials/econ-staking.ejs + public/js/admin-staking.js):
//   GET  /api/admin/econ/staking   econ.telemetry_policy (Admins): the ceiling, the cushion switch and its size per vault, the
//                                  weekly payout cap, the time-weighting (this week's PAT-days, since when, wholly
//                                  time-weighted or not - Pepe's bucket rule: not = the 25% reference cap while no cap is set),
//                                  Auto under the staker limit, the stakers' index, the 25%-cap tracker, the round trips, the
//                                  last audit, the last weekly settlement, recent changes
//   POST /api/admin/econ/staking   a Pepe OWNER only (econ.pepe_econ_cmds + Pepe role owner on the linked chat login, the
//                                  2026-10-16 "economy is owner-only" rule) + same-site fetch + CSRF token + the /admin/economy
//                                  step-up (single-use nonce + account password). {nonce, password, op, value}:
//                                    op bonus_cap     0..100    -> !econ set wf_staker_cap_pct <n>      (% APR; 0 = no cap)
//                                  A website action (econ.cmd) Pepe runs with his own validation and owner check; the card
//                                  polls GET /api/admin/econ/edit/:id. The daily ceiling, the cushion (+ its window) and
//                                  Auto's staker limit are SHOWN only: they're Pepe's admin-panel knobs (vault_ceil_apr is a
//                                  fraction there), which his !econ set doesn't take - the card doesn't send them (the
//                                  2026-10-19 review: a command Pepe refuses, and a % vs fraction trap once he routes it).
//                                  Pepe pushes the applied values back (ceil_apr, ceil_cushion, ceil_cushion_days,
//                                  auto_staker_cap, wf_staker_cap_pct in his capital config) and the cut-off / the page read them.
"use strict";
const C = require("./core");
const V = require("./vaults");

const WARN_EVERY = 7 * 86400;
const MOVING_MAX = 3600;
const LATE_AFTER = 1800;
const ADMIN_TAG = "staking-admin";
// the keys the card sends to Pepe's !econ set (WIRE: pepe_econcfg SPEC must take each one from the site's econ.cmd action)
const KEYS = Object.freeze({ bonus_cap: "wf_staker_cap_pct" });
// the knobs the card only SHOWS - Pepe's admin panel (frida-bot SINK_RATES) sets them: op -> his knob
const PANEL = Object.freeze({ ceiling: "vault_ceil_apr", cushion: "vault_ceil_cushion", cushion_days: "vault_ceil_cushion_days", auto_cap: "vault_auto_staker_cap" });
const RT_WARN = 1000;                   // round trips: a week whose estimated dodged drop reaches this is a warning (else info)
let clock = () => Date.now() / 1000;
const nowS = () => clock();
const dayOf = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const staging = () => !!process.env.STAGING;
let alertFn = (a) => require("../opsalerts").alert(a);

/** Alerts for findings (see the header). -> the keys sent. Never throws. */
async function send(findings, day) {
  const out = [];
  try {
    const sent = (await C.meta("watch_sent")) || {};               // "<code>:<vault>" -> last sent (s): a warn's weekly limit
    const refs = (await C.meta("watch_refs")) || {};               // ref -> sent (s): one alert per ref, ever (the tick repeats)
    const now = nowS();
    let changed = false;
    for (const f of findings || []) {
      if (!f || f.level === "info") continue;
      const k = `${f.code}:${f.vault || "-"}`;
      const ref = `${day}:${f.code}:${f.vault || "all"}`;
      if (refs[ref]) continue;
      if (f.level === "warn" && sent[k] && now - Number(sent[k]) < WARN_EVERY) continue;
      if (staging()) continue;
      try {
        const r = await alertFn({ source: "staking", ref, title: f.title, body: f.body });
        if (r && !r.limited) { sent[k] = now; refs[ref] = now; out.push(k); changed = true; }
      } catch (e) { console.error("[capital] staking alert:", e.message); }
    }
    if (changed) {
      for (const r of Object.keys(refs)) if (now - Number(refs[r]) > 8 * 86400) delete refs[r];
      await C.setMeta("watch_sent", sent);
      await C.setMeta("watch_refs", refs);
    }
  } catch (e) { console.error("[capital] staking alerts:", e.message); }
  return out;
}

/** After a cut-off committed: keep its audit, alert. r = epoch()'s {snap, notes}. */
async function afterEpoch(r) {
  if (!r || !r.snap) return [];
  const findings = (r.notes && r.notes.audit) || [];
  const day = dayOf(r.snap.ts);
  await C.setMeta("watch_last", { ts: r.snap.ts, day, findings, giveback: (r.notes || {}).giveback || {}, skim: (r.notes || {}).skim || {} }).catch(() => {});
  if (findings.length) console.log(`[capital] staking audit ${day}: ${findings.map((f) => `${f.code}${f.vault ? "/" + f.vault : ""} ${f.level}`).join(", ")}`);
  return send(findings, day);
}

// ── the tick ──
const movingSeen = new Map();          // queue id -> first seen "moving" (s)
/** I8: a late cut-off, a request stuck mid-move. d = the vault doc, c = the config. -> findings sent */
async function tick(d, c) {
  const now = nowS();
  const f = [];
  if (d && d.inited && Number(c.vaults_enabled) && Number(d.next_epoch) > 0 && now > Number(d.next_epoch) + LATE_AFTER) {
    f.push({ code: "I8", vault: "late", level: "alert", title: "Staking: the daily cut-off is late",
             body: `It was due at ${new Date(Number(d.next_epoch) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC and hasn't run.` });
  }
  const moving = new Set();
  for (const q of Object.values((d && d.queue) || {})) {
    if (!q || q.state !== "moving") continue;
    moving.add(q.id);
    if (!movingSeen.has(q.id)) movingSeen.set(q.id, now);
    if (now - movingSeen.get(q.id) > MOVING_MAX) {
      f.push({ code: "I8", vault: `moving-${q.id}`, level: "alert", title: `Staking: request ${q.id} is stuck mid-move`,
               body: `${q.kind} ${q.vault} for stash ${q.stash} has been "moving" for over an hour.` });
    }
  }
  for (const id of [...movingSeen.keys()]) if (!moving.has(id)) movingSeen.delete(id);
  return f.length ? send(f, dayOf(now)) : [];
}

// ── D2 (the owner, 2026-10-19): the weekly payout cap goes - TRACK what a 25% cap would have paid, week by week ──
const TRACK_CAP = 0.25;
const TRACK_KEEP = 52;
/**
 * Every SETTLED week Pepe pushed (cfg.waterfall, per-vault totals): the stakers' share of the surplus, what they were paid,
 * and what a TRACK_CAP APR cap on their (time-weighted) stake would have paid - Pepe's own figure when his record carries it
 * (would_cap25, pepe_treasury._tr_track), else the waterfall's expression from the record, min(stakers' share,
 * int(staked x 0.25 x days / 365)) (the per-stash split truncates each stash's PAT, so the real figure could be up to one PAT
 * per stash lower). over = what was paid above it (with that cap it would have gone to the Fed and the incentive budget).
 * -> [{eid, days, done, cap_pct, vaults: {v: {pool, paid, staked, cap25, would25, over, weighting, cap_pct, fallback}}, total}],
 * oldest first (a vault's cap_pct / fallback: the cap the plan applied and whether it was D2's safeguard - the 25% reference cap
 * on a week that wasn't wholly time-weighted - camfrog-bot 31c65d0; null from an older Pepe).
 */
function capTrack(c) {
  const out = [];
  for (const r of V.waterfallFrom(c)) {
    if (r.state !== "done") continue;
    const days = Number(r.days) || 7;
    const vaults = {};
    const total = { pool: 0, paid: 0, would25: 0, over: 0 };
    for (const v of V.VAULTS) {
      const x = r.vaults[v];
      if (!x) continue;
      const pool = Math.trunc(Number(x.stakers_share) || 0), paid = Math.trunc(Number(x.stakers) || 0), staked = Math.trunc(Number(x.staked) || 0);
      const cap25 = Math.trunc(staked * TRACK_CAP * days / 365);
      const would25 = x.would_cap25 !== null && x.would_cap25 !== undefined ? Math.trunc(Number(x.would_cap25)) : Math.min(pool, cap25);
      const over = Math.max(0, paid - would25);
      vaults[v] = { pool, paid, staked, cap25, would25, over, weighting: x.weighting || null,
                    cap_pct: x.cap_pct === undefined ? null : x.cap_pct, fallback: x.fallback === undefined ? null : x.fallback };
      total.pool += pool; total.paid += paid; total.would25 += would25; total.over += over;
    }
    out.push({ eid: r.epoch, days, done: r.done, cap_pct: r.staker_cap_pct, vaults, total });
  }
  return out;
}
/** Keeps the tracker (capital_meta "wf_cap_track", merged by week, the last TRACK_KEEP weeks - Pepe pushes only his last 8)
 *  for the owner's card. The weekly digest itself is Pepe's (pepe_treasury._tr_digest, ref wf-digest:<epoch>, to the
 *  admins), so the site doesn't send a second one. -> the rows kept */
async function trackCap(c) {
  const rows = capTrack(c);
  const prev = (await C.meta("wf_cap_track")) || [];
  if (!rows.length) return prev;
  const by = new Map(prev.map((x) => [x.eid, x]));
  for (const r of rows) by.set(r.eid, r);
  const kept = [...by.values()].sort((a, b) => (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0)).slice(-TRACK_KEEP);
  if (JSON.stringify(kept) !== JSON.stringify(prev)) await C.setMeta("wf_cap_track", kept);
  return kept;
}

// ── round trips around the Monday draw (see the header) ──
const RT_KEEP = 12;
/**
 * The stashes that left at the cut-off before the Monday boundary B and came back at the one after it. Pure, from the vault
 * queue (done requests stay 30 days): a withdrawal done in [B - 1 day - 2 h, B - 2 h) and a deposit by the same stash done in
 * [B - 2 h, B + 1 day - 2 h) (the 01:00 UTC draw falls between the two cut-offs). The drop it dodged, estimated per pair:
 * each vault leg x max(0, 1 - the deposit's price / the withdrawal's price) x min(1, back in / out).
 * -> {boundary, pairs, stashes: [ids], out, in, dodged}
 */
function roundTrips(d, B) {
  const qs = Object.values((d && d.queue) || {}).filter((q) => q && q.state === "done" && Number(q.done) > 0);
  const outs = qs.filter((q) => q.kind === "withdraw" && q.done >= B - 86400 - 7200 && q.done < B - 7200);
  const ins = qs.filter((q) => q.kind === "deposit" && q.done >= B - 7200 && q.done < B + 86400 - 7200);
  const res = { boundary: B, pairs: 0, stashes: [], out: 0, in: 0, dodged: 0 };
  const seen = new Set();
  for (const w of outs) {
    const back = ins.filter((q) => String(q.stash) === String(w.stash));
    if (!back.length) continue;
    let outAmt = 0;
    for (const a of Object.values(w.legs || {})) outAmt += Number(a) || 0;
    if (!(outAmt > 0)) continue;
    let inAmt = 0;
    for (const q of back) for (const a of Object.values(q.legs || {})) inAmt += Number(a) || 0;
    if (!(inAmt > 0)) continue;
    const pIn = back[0].prices || {}, pOut = w.prices || {};
    let dodged = 0;
    for (const [x, a] of Object.entries(w.legs || {})) {
      const pa = Number(pOut[x]), pb = Number(pIn[x]);
      if (pa > 0 && pb > 0) dodged += Number(a) * Math.max(0, 1 - pb / pa);
    }
    res.pairs += 1;
    res.out += Math.trunc(outAmt);
    res.in += Math.trunc(inAmt);
    res.dodged += dodged * Math.min(1, inAmt / outAmt);
    if (!seen.has(String(w.stash))) { seen.add(String(w.stash)); res.stashes.push(String(w.stash)); }
  }
  res.dodged = Math.trunc(res.dodged);
  return res;
}
/** Once a week (from Monday 05:00, once the Monday cut-off ran): the round trips -> capital_meta "watch_roundtrips" (the card)
 *  and, when they dodged at least RT_WARN PAT, a weekly warning. -> the week's row | null */
async function roundTripsWeek(boundary, eid) {
  const mk = `rt_watch:${eid}`;
  if (await C.meta(mk)) return null;
  const d = await V.load();
  if (!d.inited) return null;
  const lastTs = d.epochs.length ? Number(d.epochs[d.epochs.length - 1].ts) : 0;
  if (lastTs < boundary) return null;                                          // the Monday cut-off hasn't run yet
  const r = Object.assign({ eid }, roundTrips(d, boundary));
  const prev = (await C.meta("watch_roundtrips")) || [];
  await C.setMeta("watch_roundtrips", prev.filter((x) => x.eid !== eid).concat([r]).slice(-RT_KEEP));
  await C.setMeta(mk, { at: nowS() });
  if (r.pairs) {
    const f = { code: "I11", vault: "roundtrip", level: r.dodged >= RT_WARN ? "warn" : "info",
                title: `Staking: ${r.pairs} round trip(s) around Monday's draw (${eid})`,
                body: `Stash(es) ${r.stashes.slice(0, 20).join(", ")} unstaked PAT ${C.fmt(r.out)} at the cut-off before the draw and staked PAT ${C.fmt(r.in)} again at the one after it, `
                      + `skipping about PAT ${C.fmt(r.dodged)} of the drop (the other stakers carried it). No fee or lock-up stops this yet.` };
    const wk = (await C.meta("watch_weekly")) || [];
    await C.setMeta("watch_weekly", wk.concat([{ eid, at: nowS(), findings: [f] }]).slice(-8));
    await send([f], dayOf(nowS()));
  }
  return r;
}

/** I6 / I7: once a week from Monday 05:00 UTC, Pepe's settlement against the stash moves and the notices. -> findings | null
 *  (the 25% cap tracker runs first, on every tick that has Pepe's records - it only writes when a week is new; the round
 *  trips run once the Monday cut-off did) */
async function weekly(c) {
  const E = require("../policy/engines");
  const { getQuery } = require("../dbUtils");
  if (c && Array.isArray(c.waterfall)) await trackCap(c).catch((e) => console.error("[capital] staking cap tracker:", e.message));
  const now = nowS();
  const hour = Number((c || {}).epoch_hour) || 4;
  const boundary = E.weekStart(now, hour);
  const eid = E.epochId(now, hour);
  if (now < boundary + 3600) return null;
  if (c && (await C.live().catch(() => false))) await roundTripsWeek(boundary, eid).catch((e) => console.error("[capital] staking round trips:", e.message));
  if (!c || !c.tr_live || !Array.isArray(c.waterfall)) return null;          // an older Pepe (no waterfall push) or v1
  const mk = `wf_watch:${eid}`;
  if (await C.meta(mk)) return null;
  const rec = c.waterfall.find((r) => r.epoch === eid);
  const f = [];
  if (!rec || rec.state !== "done") {
    if (now < boundary + 2 * 3600) return null;                                // Pepe pushes every few minutes: give it time
    // not done: alert ONCE, then keep checking each tick - when it's done, the cross-check below still runs
    const lk = `wf_watch_late:${eid}`;
    if (await C.meta(lk)) return null;
    f.push({ code: "I6", vault: null, level: "alert", title: `Staking: the weekly settlement ${eid} isn't done`,
             body: (rec ? `Pepe reports it as "${rec.state}".` : "Pepe hasn't reported it (his config push carries the last 8).")
                   + " The payout cross-check runs when it is." });
    await C.setMeta(lk, { at: now, findings: f });
    const prev = (await C.meta("watch_weekly")) || [];
    await C.setMeta("watch_weekly", prev.concat([{ eid, at: now, findings: f }]).slice(-8));
    await send(f, dayOf(now));
    return f;
  } else {
    // D2's safeguard (camfrog-bot 31c65d0): with no weekly cap in force, a vault whose week isn't WHOLLY time-weighted (no
    // PAT-days bucket, PAT-days that began mid-week - the first week after the deploy - or a pruned oldest week) is paid under
    // the 25% reference cap, or a stake made just before the PAT-days began would share the stakers' full 20% as if held all
    // week. Pepe's record says, per vault, how the stakes were weighted and which cap the plan applied (weighting / cap_pct /
    // fallback); the site's own book is judged by the same bucket rule (V.pdWhole, lb = the settlement before this one). ALERT
    // a vault paid with NO cap on a week that wasn't wholly time-weighted - by Pepe's record ("partial" / "snapshot") or, for
    // a record from a Pepe before 31c65d0 (no cap_pct: his "pat_days" only meant a bucket existed), by the site's book. The
    // safeguard at work is info.
    // The site judges its book AFTER the settlement, which isn't always the book Pepe planned on: the Monday cut-off at B
    // creates bucket B + 7 d and prunes to PD_KEEP (4), and Pepe can settle BEFORE it (a manual run, or a cut-off more than
    // LATE_MONDAY late). A settlement over 21 days (lb = B - 21 d - under the pd-pruned warning's "more than 21") then had
    // bucket B - 21 d when Pepe planned (whole: pat_days, no cap) and lost it here by the time this runs (not whole). So when
    // the record says how Pepe weighted it (a 31c65d0+ Pepe: cap_pct reported), his word decides and a book that disagrees is
    // only info (pd-view-<vault>); for an older record that case can still raise a false partial-week alert.
    const d = (await C.live().catch(() => false)) ? await V.load().catch(() => null) : null;   // the site's book only (not Pepe's local one)
    const B = Number(rec.boundary) || boundary;
    const lb = V.lastSettled(c, eid);
    for (const v of V.VAULTS) {
      const x = (rec.vaults || {})[v];
      if (!x || !(Number(x.stakers_share) > 0) || !(Number(x.stakers) > 0)) continue;
      const r2 = V.wfRowD2(x);
      const inForce = rec.staker_cap_pct === null || rec.staker_cap_pct === undefined || !Number.isFinite(Number(rec.staker_cap_pct)) ? null : Number(rec.staker_cap_pct);
      if (r2.cap_pct === null && inForce === null) continue;                      // the cap isn't known (an older Pepe)
      if (r2.fallback) {
        f.push({ code: "I6", vault: `refcap-${v}`, level: "info", title: `${V.LABEL[v]}: paid under the 25% reference cap (${eid})`,
                 body: `No weekly cap was in force, but the week wasn't wholly time-weighted (${r2.weighting || "?"}), so D2's safeguard held the stakers' payout to ${r2.cap_pct}% a year on their stake: paid ${C.fmt(x.stakers)} of their ${C.fmt(x.stakers_share)}.` });
        continue;
      }
      if ((r2.cap_pct !== null ? r2.cap_pct : inForce) > 0) continue;              // capped: nothing to check
      const siteWhole = d && d.inited ? V.pdWhole(d.v[v], B, lb) : null;
      const pepeSays = r2.cap_pct !== null && r2.weighting !== null;              // a 31c65d0+ record: his weighting decides
      if (pepeSays && r2.weighting === "pat_days" && siteWhole === false) {
        f.push({ code: "I6", vault: `pd-view-${v}`, level: "info", title: `${V.LABEL[v]}: the site's book reads ${eid} as not wholly time-weighted; Pepe paid it as whole`,
                 body: `Pepe weighted it by PAT-days with no cap (his book when he planned it); the site checked its book after the settlement, with lb ${lb ? new Date(lb * 1000).toISOString().slice(0, 10) : "none"} `
                       + `and ${Math.round(Number(rec.days) || 7)} days. A Monday cut-off after Pepe's settlement adds next week's bucket and drops the oldest (4 kept), so a long settlement run before it looks partial here. Pepe's weighting is what was paid.` });
        continue;
      }
      if (r2.weighting === "partial" || r2.weighting === "snapshot" || (!pepeSays && siteWhole === false)) {
        const from = d && Number(d.pd_from) > 0 ? new Date(Number(d.pd_from) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;
        f.push({ code: "I6", vault: `partial-week-${v}`, level: "alert", title: `Staking: ${V.LABEL[v]} paid with no weekly cap on a week that wasn't wholly time-weighted (${eid})`,
                 body: `Pepe's record: weighted by ${r2.weighting || "?"}, cap ${r2.cap_pct === null ? "not reported" : r2.cap_pct + "%"}; the site's book: `
                       + (siteWhole === null ? "not here" : siteWhole ? "wholly time-weighted" : "not wholly time-weighted (no bucket older than the week)")
                       + (from ? `, PAT-days since ${from}` : "") + `. The stakers got ${C.fmt(x.stakers)} uncapped - check who was paid (a stake made just before the PAT-days began shared the full 20%).` });
      }
    }
    if (Number(rec.days) > 21) {
      f.push({ code: "I6", vault: "pd-pruned", level: "warn", title: `Staking: ${eid} settled ${Math.round(Number(rec.days))} days at once`,
               body: "The vault keeps 4 weeks of PAT-days (counting next week's), so the oldest week of this settlement was already dropped: the stakers' average stake is under-counted." });
    }
    const paidStashes = new Set();
    for (const v of V.VAULTS) {
      const x = rec.vaults[v];
      if (!x) continue;
      const rows = await getQuery("SELECT stash_id, amount FROM stash_moves WHERE key LIKE ? AND amount > 0", [`wf-${eid}-${v}-stk-%`]);
      const got = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      for (const r of rows) paidStashes.add(String(r.stash_id));
      if (Math.abs(got - Number(x.stakers || 0)) > Math.max(1, Number(x.stakers_n || 0))) {
        f.push({ code: "I6", vault: v, level: "alert", title: `Staking: ${V.LABEL[v]} stakers' payout doesn't add up (${eid})`,
                 body: `Pepe paid ${C.fmt(x.stakers)} PAT to ${x.stakers_n || 0} stash(es); the stashes received ${C.fmt(got)} in ${rows.length} move(s).` });
      }
      const pool = Number(x.stakers_share || 0);
      if (pool > 0 && Number(x.stakers) / pool < 0.25 && Number(rec.staker_cap_pct) !== 0) {
        f.push({ code: "I7", vault: v, level: "info", title: `${V.LABEL[v]}: the APR cap let ${(100 * Number(x.stakers) / pool).toFixed(1)}% of the stakers' share through (${eid})`,
                 body: `stakers' 20%: ${C.fmt(pool)} PAT, cap ${C.fmt(x.apr_cap)}, paid ${C.fmt(x.stakers)}.` });
      }
    }
    if (paidStashes.size) {
      let have = 0;
      const missing = [];
      for (const id of paidStashes) {
        const ref = `wf:${eid}:s${id}`;
        const a = (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", [ref]).catch(() => [{ n: 0 }]))[0].n;
        const b = (await getQuery("SELECT COUNT(*) AS n FROM inbox_pending WHERE ref = ?", [ref]).catch(() => [{ n: 0 }]))[0].n;
        if (Number(a) + Number(b) > 0) have++; else missing.push(id);
      }
      if (!have) {
        f.push({ code: "I6", vault: "notices", level: "warn", title: `Staking: no payout notices for ${eid}`,
                 body: `${paidStashes.size} stash(es) were paid and none got a "Staking payout" notice (Pepe older than the notice change?).` });
      } else if (missing.length) {
        f.push({ code: "I6", vault: "notices", level: "alert", title: `Staking: ${missing.length} payout notice(s) missing for ${eid}`,
                 body: `stash(es) ${missing.slice(0, 20).join(", ")} were paid without a notice.` });
      }
    }
  }
  if (await C.meta(`wf_watch_late:${eid}`)) f.push({ code: "I6", vault: "late", level: "info", title: `Staking: ${eid} settled late`, body: `Done at ${new Date(Number(rec.done || now) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC; the cross-check ran then.` });
  await C.setMeta(mk, { at: now, findings: f });
  const prev = (await C.meta("watch_weekly")) || [];
  await C.setMeta("watch_weekly", prev.concat([{ eid, at: now, findings: f }]).slice(-8));
  await send(f, dayOf(now));
  return f;
}

// ── the owner's card ──
async function meOf(user) {
  if (!user || !user.userId) return null;
  return (await require("../dbUtils").getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0] || null;
}
/** Changing the switches: econ.pepe_econ_cmds AND Pepe role "owner" on the linked chat login. */
async function canEdit(user) {
  try { return await require("../staffroles").ownerHolds(await meOf(user), "econ.pepe_econ_cmds"); } catch (e) { return false; }
}
/** The card's numbers. */
async function adminData(me) {
  const c = await C.cfg();
  const live = await C.live();
  const d = await V.load();
  const now = nowS();
  const pdNow = V.patDaysNow(d, now, Number(c.epoch_hour), V.lastSettled(c));
  const out = { ok: true, live, can_edit: await canEdit(me), cfg_age: await C.cfgAge(),
                cfg: { ceil_apr: Number(c.ceil_apr), ceiling_on: V.ceilingOn(c), cushion: V.cushionCfg(c).on, cushion_days: V.cushionCfg(c).days,
                       staker_max: Number(c.staker_max), bonus_cap: await V.bonusCap(c), tr_live: !!c.tr_live, auto_staker_cap: V.autoCapOn(c),
                       weighted: Object.keys(pdNow.vaults).length > 0, pd_boundary: pdNow.boundary,
                       // P2.1: when the PAT-days started (display); partial = this week isn't WHOLLY time-weighted (V.pdPartial,
                       // Pepe's bucket rule since the 31c65d0 port: with no weekly cap he holds its settlement to the 25%
                       // reference cap by himself); first = it's partial because the PAT-days began inside it (V.pdFirstWeek)
                       pd_from: live && d.inited ? pdNow.from : null, pd_partial: live && d.inited ? pdNow.partial : null,
                       pd_first: live && d.inited ? !!pdNow.partial && V.pdFirstWeek(pdNow.from, pdNow.boundary) : null },
                keys: KEYS, panel: PANEL, vaults: {}, watch: (await C.meta("watch_last")) || null, weekly: (await C.meta("watch_weekly")) || [],
                waterfall: V.waterfallFrom(c).slice(-1)[0] || null, track: ((await C.meta("wf_cap_track")) || []).slice(-12),
                roundtrips: ((await C.meta("watch_roundtrips")) || []).slice(-8), actions: [] };
  if (live && d.inited) {
    const k = await V.ctx();
    const p = V.prices(d, k);
    const last = d.epochs[d.epochs.length - 1] || null;
    for (const v of V.VAULTS) {
      const st = d.v[v] || {};
      const ent = Array.isArray(st.cushion) ? st.cushion : [];
      const win = V.cushionShares(st, now, V.cushionCfg(c).days);
      const prot = Number((st.holders || {})[V.PROTOCOL] || 0);
      const pd = pdNow.vaults[v] || null;
      out.vaults[v] = { price: p[v], peak_price: st.peak_price === undefined ? null : Number(st.peak_price), nav: V.nav(v, k),
                        staked: V.stakerValue(d, v, p), protocol_shares: prot, protocol_value: prot * p[v],
                        basis: st.basis === undefined ? null : Number(st.basis),
                        cushion: { shares: win, value: win * p[v], entries: ent.length, oldest: ent.length ? Number(ent[0][0]) : null,
                                   newest: ent.length ? Number(ent[ent.length - 1][0]) : null },
                        // P2.1: this week's PAT-days (what next Monday's stakers' payout is split by) and how many stashes have some
                        pat_days: pd ? { total: pd.total, stashes: Object.keys(pd.by).length } : null,
                        staker_index: last && last.staker_index ? Number(last.staker_index[v]) || null : null,
                        staker_apr7: V.stakerApr(d, v, 7, c), vault_apr7: V.apr(d, v, 7, c) };
    }
  }
  out.actions = await require("../dbUtils").getQuery(
    "SELECT id, username, label, status, message, created, updated FROM pepe_actions WHERE tag = ? ORDER BY id DESC LIMIT 10", [ADMIN_TAG]).catch(() => []);
  return out;
}
/** The words for Pepe's !econ set, or {error}. The weekly cap goes as Pepe's % number ("25" = 25% a year, "0" = no cap).
 *  The ceiling / cushion / window / Auto's limit are his admin-panel knobs: refused here (the card shows where to set them). */
function commandFor(op, value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  if (op === "bonus_cap") {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s) > 100) return { error: "The weekly payout cap is 0 to 100 (% a year; 0 = no cap)." };
    return { words: ["set", KEYS.bonus_cap, String(Number(s))], label: Number(s) > 0 ? `Staking weekly payout cap ${Number(s)}% APR` : "Staking weekly payout cap OFF" };
  }
  if (PANEL[op]) return { error: `That one is set on Pepe's admin panel (${PANEL[op]}), not from here.`, code: "panel" };
  return { error: "Unknown change." };
}

function register(app, { addUser }) {
  const SP = require("../siteperms");
  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  app.get("/api/admin/econ/staking", noStore, addUser, async (req, res) => {
    try {
      const me = await meOf(req.user);
      if (!me) return res.status(401).json({ ok: false, error: "Sign in first." });
      if (!SP.can(me, "econ.telemetry_policy")) return res.status(403).json({ ok: false, error: "Admins only." });
      res.json(await adminData(me));
    } catch (e) { console.error("[capital] staking card:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/econ/staking", noStore, addUser, async (req, res) => {
    try {
      const me = await meOf(req.user);
      if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
      if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)
          || !require("../pepecontrol").csrfOk(me.username, req.get("x-csrf-token"))) {
        return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
      }
      if (!(await canEdit(me))) return res.status(403).json({ ok: false, code: "owner_only", error: "Only a Pepe owner can change the staking switches." });
      const b = req.body || {};
      const cmd = commandFor(String(b.op || ""), b.value);
      if (cmd.error) return res.status(400).json({ ok: false, code: cmd.code || "invalid", error: cmd.error });
      try { await require("../econstore").stepUp(me, b); }
      catch (e) { if (e && e.status) return res.status(e.status).json({ ok: false, code: e.code, error: e.message }); throw e; }
      let id;
      try { id = await require("../actions").queue(me.userId, { kind: "econ.cmd", args: cmd.words, tag: ADMIN_TAG, label: cmd.label }); }
      catch (e) { return res.status(409).json({ ok: false, code: "busy", error: e.message === "busy" ? "You have too many requests waiting for Pepe - try again in a minute." : "Couldn't queue that." }); }
      console.log(`[capital] ${me.username} queued !econ ${cmd.words.join(" ")} (staking card) as action ${id}`);
      res.json({ ok: true, request: { id }, command: "!econ " + cmd.words.join(" ") });
    } catch (e) { console.error("[capital] staking card save:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = { afterEpoch, tick, weekly, send, adminData, canEdit, commandFor, register, KEYS, PANEL, WARN_EVERY, capTrack, trackCap, TRACK_CAP,
                   roundTrips, roundTripsWeek, RT_WARN,
                   _setClock: (fn) => { clock = fn || (() => Date.now() / 1000); }, _setAlert: (fn) => { alertFn = fn || ((a) => require("../opsalerts").alert(a)); },
                   _resetMoving: () => movingSeen.clear() };
