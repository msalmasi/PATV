// capital/stakeroom.js — 1.99?? quick1: how much room the vaults have for a stake, in plain words (pure: no database).
//
// A member tried three times to stake and "it doesn't go through": every direct stake into the Bank, the House or the
// Market maker since 10-24 was queued ("goes into the House at the next cut-off"), then refunded IN FULL at the cut-off
// - stakers already own more of each vault than the staker limit (staker_max: the most of a vault stakers may own) lets
// in, so the cut-off's cap (capital/vaults.js executeOne) put nothing in. Now a stake that can't go in is refused before
// any PAT moves, saying why, how much room is left and when a full vault is likely to open; /staking shows the room
// before you submit (staking.js -> views/staking.ejs) and Pepe's chat reply is the same text (he relays the site's
// refusal; his local path, pepe_stakeroom.py, is the same words - its stakeroom_test.py compares the two).
//
// 1.99?? quick1 rework (owner 2026-11-04, "Soften the hint"): a full vault's words no longer point members to Auto as the
// way around the limit (Auto skips it while vault_auto_staker_cap is off) - they say the vault is full, that it has no
// room, when it's likely to open (unstakes already queued for the next cut-off, else about how much stakers would have
// to unstake, else no date) and, in one neutral clause, that Auto spreads stakes over the three vaults. "The vault grows
// on its own" was dropped: growth is shared pro rata, so it doesn't open room (only the APR ceiling's skim to the
// protocol would, and it is off - the protocol adding PAT, Pepe's policy engines, does).
//
// The room is executeOne's own cap solved for the amount: a direct stake x into vault v goes in WHOLE while
//   smax x (NAV + A + x) - (staked + A) >= x   <=>   x <= (smax x NAV - staked) / (1 - smax) - A
// (A = the deposits queued ahead of it into v: they run first at the cut-off and take room). It's "about": the cut-off
// prices the vaults again, and the cap there still decides (a stake that no longer fits then comes back to the stash,
// with Pepe's "Stake refunded" notice). smax >= 1 = no limit. An unstake u takes u off both NAV and the stakers' value,
// so it adds u to that room: a full vault opens for the smallest stake (minMove) once about minMove - room PAT is
// unstaked (needOf; the unstakes already queued from it count first).
"use strict";

const VAULTS = ["bank", "house", "mm"];
const LABEL = { bank: "🏦 Bank", house: "🎰 House", mm: "📈 Market maker", auto: "🤖 Auto" };
const fmt = (n) => Math.trunc(Number(n || 0)).toLocaleString("en-US");
const pct = (f) => `${Math.round((Number(f) || 0) * 100)}%`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// 1.99?? quick1 rework: room comes from unstakes or the protocol adding PAT (Pepe's policy engines) - not from growth
const WHEN = "Room opens again when stakers unstake or the protocol adds PAT - there's no date for that.";
const SOON = "Unstakes already queued may open room at the next daily cut-off.";

/** The most PAT a direct stake can put into one vault now and stay inside the staker limit - an integer >= 0, or null
 *  (no limit: smax >= 1). `ahead`: PAT already queued into it. Checked against executeOne's own expression. */
function fitOf(navV, stakedV, smax, ahead = 0) {
  const s = Number(smax);
  if (!Number.isFinite(s) || s >= 1) return null;
  if (s <= 0) return 0;
  const nv = num(navV), st = num(stakedV), a = Math.max(0, num(ahead));
  let x = Math.floor((s * (nv + a) - (st + a)) / (1 - s));
  if (!(x > 0)) return 0;
  // the cut-off's cap, exactly: trunc(smax x (NAV + x) - staked) >= x (float rounding: step down until it holds)
  for (let i = 0; i < 4 && Math.trunc(s * (nv + a + x) - (st + a)) < x; i++) x -= 1;
  return Math.max(0, x);
}

/** 1.99?? quick1 rework: when a vault is likely to take the smallest stake (minMove) again -> {need, soon}, or null (no
 *  limit, or a limit of 0 that never opens). need = about how much PAT stakers would still have to unstake from it beyond
 *  the unstakes already queued (`out`, PAT at today's price); soon = those queued unstakes alone would open room at the
 *  next cut-off (they wait there if the vault has no free PAT, so "may"). Not full -> {need: 0, soon: false}. */
function needOf(navV, stakedV, smax, ahead = 0, minMove = 1000, out = 0) {
  const s = Number(smax);
  if (!Number.isFinite(s) || s >= 1 || s <= 0) return null;
  const nv = num(navV), st = num(stakedV), a = Math.max(0, num(ahead)), o = Math.max(0, num(out));
  const mm = Math.max(1, Math.trunc(num(minMove) || 1));
  const n0 = Math.ceil(mm - (s * (nv + a) - (st + a)) / (1 - s));
  if (!(n0 > 0)) return { need: 0, soon: false };
  const left = Math.ceil(n0 - o);
  return { need: Math.max(0, left), soon: o > 0 && left <= 0 };
}

/**
 * The room of every vault for a stake now -> {smax, autoCap, minMove, vaults: {v: {fit, full, share, need, soon}},
 * auto: {fit, full}, anyOpen}. In: nav / staked per vault (PAT), smax (staker_max), autoCap (Auto deposits obey the
 * limit - Pepe's vault_auto_staker_cap), ahead = PAT of deposits queued per vault, out = PAT of unstakes queued per vault
 * (1.99?? quick1 rework: they only say when a full vault may open - the room itself doesn't count them), minMove (the
 * smallest stake). full = less room than minMove. need / soon: needOf (null with no limit). Auto: no limit while autoCap
 * is off (fit null); under it, about the sum of the vaults' room.
 */
function roomOf({ nav, staked, smax, autoCap, ahead, out, minMove } = {}) {
  const mm = Math.max(1, Math.trunc(num(minMove) || 1));
  const vaults = {};
  let sum = 0, limited = true;
  for (const v of VAULTS) {
    const n = num((nav || {})[v]), st = num((staked || {})[v]);
    const fit = fitOf(n, st, smax, (ahead || {})[v]);
    if (fit === null) limited = false; else sum += fit;
    const full = fit !== null && fit < mm;
    const nd = full ? needOf(n, st, smax, (ahead || {})[v], mm, (out || {})[v]) : null;
    vaults[v] = { fit, full, share: n > 0 ? st / n : 0, need: nd ? nd.need : fit === null ? null : 0, soon: !!(nd && nd.soon) };
  }
  const autoFit = autoCap && limited ? sum : null;
  const auto = { fit: autoFit, full: autoFit !== null && autoFit < mm };
  return { smax: Number(smax), autoCap: !!autoCap, minMove: mm, vaults, auto,
           anyOpen: !auto.full || VAULTS.some((v) => !vaults[v].full) };
}

/** Another DIRECT vault that still has room (the one with the most), or "". 1.99?? quick1 rework: Auto is no longer
 *  offered here as the way around a full vault - autoNote says what it is, neutrally. */
function elsewhere(room, vault) {
  const open = VAULTS.filter((v) => v !== vault && !room.vaults[v].full).sort((a, b) => (room.vaults[b].fit ?? Infinity) - (room.vaults[a].fit ?? Infinity));
  if (!open.length) return "";
  const v = open[0], f = room.vaults[v].fit;
  return f === null ? ` ${LABEL[v]} still takes stakes.` : ` ${LABEL[v]} has room for about PAT ${fmt(f)}.`;
}

/** 1.99?? quick1 rework: when a full vault is likely to open - the unstakes already queued, else about how much stakers
 *  would have to unstake, else no date. */
function whenOf(r) {
  if (r && r.soon) return " Unstakes already queued from it may open room at the next daily cut-off.";
  if (r && r.need > 0) return ` It opens again once stakers unstake about PAT ${fmt(r.need)} from it or the protocol adds PAT - there's no date for that.`;
  return ` ${WHEN}`;
}

/** 1.99?? quick1 rework: Auto, in one neutral clause (what it does - not "it still takes stakes"), or "" when it can't
 *  take one either. */
function autoNote(room) {
  if (!room || room.auto.full) return "";
  return room.auto.fit === null ? " 🤖 Auto spreads stakes over the three vaults."
    : ` 🤖 Auto spreads stakes over the three vaults (room for about PAT ${fmt(room.auto.fit)}).`;
}

/**
 * Why a stake of `amount` into `vault` can't go in now - {code: "full" | "capped", error, fit} - or null (it fits).
 * ctx.stash names where the PAT stays ("owner/name"); ctx.placed (Auto under the limit): what the cut-off's Auto split
 * would put in at today's numbers (capital/vaults.js autoCappedLegs), when the caller worked it out.
 */
function refusal(room, vault, amount, ctx = {}) {
  if (!room) return null;
  const amt = Math.trunc(num(amount));
  const stash = ctx.stash ? ` - your PAT stays in ${ctx.stash}` : "";
  const lim = `stakers may own at most ${pct(room.smax)} of a vault`;
  if (vault === "auto") {
    if (room.auto.fit === null) return null;                       // Auto skips the limit (vault_auto_staker_cap off)
    const fit = ctx.placed != null ? Math.trunc(num(ctx.placed)) : room.auto.fit;
    if (room.auto.full || fit < room.minMove) {
      const when = VAULTS.some((v) => room.vaults[v].soon) ? SOON : WHEN;
      return { code: "full", fit: 0, error: `🏦 Staking is full right now: every vault is at its staker limit (${lim}), so 🤖 Auto can't take stakes either. Nothing moved${stash}. ${when}` };
    }
    if (amt > fit) {
      return { code: "capped", fit, error: `🏦 🤖 Auto only has room for about PAT ${fmt(fit)} right now (${lim}). Nothing moved${stash} - stake PAT ${fmt(fit)} or less.` };
    }
    return null;
  }
  const r = room.vaults[vault];
  if (!r || r.fit === null) return null;
  if (r.full) {
    return { code: "full", fit: 0, error: `🏦 The ${LABEL[vault]} vault is full right now: ${lim}, and they already own ${pct(r.share)} of it, so it has no room for a stake. Nothing moved${stash}.${whenOf(r)}${elsewhere(room, vault)}${autoNote(room)}` };
  }
  if (amt > r.fit) {
    return { code: "capped", fit: r.fit, error: `🏦 The ${LABEL[vault]} vault only has room for about PAT ${fmt(r.fit)} right now (${lim}). Nothing moved${stash} - stake PAT ${fmt(r.fit)} or less.${elsewhere(room, vault)}` };
  }
  return null;
}

/** Staking switched off (vaults_enabled 0) - said plainly, not "launching". */
const PAUSED = "🏦 Staking is paused right now (the vaults are switched off). Nothing moved - try again once it's back on.";

/** The room for /staking from its snapshot (staking.js: nav, staked, prices, settings.staker_max / auto_staker_cap /
 *  min_move, the pending queue) -> roomOf, or null when the snapshot can't say (no staker_max). */
function fromSnap(snap) {
  if (!snap || !snap.settings || snap.settings.staker_max == null) return null;
  const ahead = { bank: 0, house: 0, mm: 0 }, out = { bank: 0, house: 0, mm: 0 };
  for (const q of snap.queue || []) {
    if (!q || !VAULTS.includes(q.vault) || /^(done|failed|cancel)/i.test(q.state || "")) continue;
    if (q.kind === "deposit") ahead[q.vault] += num(q.amount);
    // 1.99?? quick1 rework: an unstake queued from a vault, at today's price (when a full vault may open)
    else if (q.kind === "withdraw") out[q.vault] += Math.trunc(num(q.shares) * num((snap.prices || {})[q.vault]));
  }
  return roomOf({ nav: snap.nav, staked: snap.staked, smax: snap.settings.staker_max, autoCap: !!snap.settings.auto_staker_cap,
                  ahead, out, minMove: snap.settings.min_move || 1000 });
}

module.exports = { VAULTS, LABEL, WHEN, SOON, PAUSED, fitOf, needOf, roomOf, refusal, fromSnap, elsewhere, whenOf, autoNote };
