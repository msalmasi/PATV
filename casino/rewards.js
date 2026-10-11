// casino/rewards.js — every casino-triggered reward of a settled hand, for EVERY seat (web or Camfrog): achievements,
// cosmetic drops, win XP and gang rep. The site is the source of truth for these (1.99mw; was split with Pepe in 1.99mj).
//
// History: in 1.99mj (the user's D4) the site counted only the seats Pepe couldn't (web-only players / web tables) and the
// events Pepe read named a seat's Camfrog name when HE counted it (pepe_casino.py -> _ach_bump / _cos_drop). Now the events
// name nobody for rewards, Pepe awards nothing for backend hands, and everything happens here, keyed by table + round/hand +
// seat, so a settlement re-run after a crash never counts, rolls or grants twice:
//
//   * achievements: bj_hands, bj_naturals, holdem_pots into casino_ach_counts, awarded through achievements.awardCount (the
//     cf_bj_* / cf_holdem_* badges, XP, PAT, Pepe's announcement feed). A Camfrog player's count so far lives in Pepe's
//     achievements_progress.json (old-engine hands + the backend hands he counted before 1.99mw): Pepe reports it as a BASE
//     (casino_ach_base, asked for through the bot poll's `ach_want`, answered with `ach_base`), and a threshold is checked
//     against base + the site's own count. A base never awards anything by itself - only a counted hand does.
//   * drops: the same rows and gates as Pepe's (cosmetics.rollDrop with the rates / params Pepe pushes to drop-config, organic,
//     the shared daily cap): blackjack = a paid natural on a bet >= min_bj_bet, the chance scaled by bet / the table maximum;
//     hold'em = a showdown pot >= min_holdem_pot won against someone else (not a linked account, both level >= min_level, at
//     most pair_rolls rolls per pair a day).
//   * win XP: Pepe's _grant_xp rate (XP_WIN_RATE 0.005) on what the seat WON: a blackjack round's net profit, a hold'em hand's
//     chips won minus the chips the winner put in.
//   * gang rep: gangs live in Pepe (gangs.json, keyed by his Camfrog identity), and rep there = the XP of a win. The site
//     can't add it itself, so it queues a rep event (casino_rep_queue, key = the win) for the seat's Camfrog name (the one
//     the seat played under, else the account's linked camfrogUsername; no Camfrog identity = no gang = nothing queued).
//     Pepe takes them from the bot poll (`rep`), applies each key once (_gang_add_rep) and acks them (`rep_ack`).
// Nothing here can fail a settlement: errors are logged and swallowed.
"use strict";
const { runQuery, getQuery } = require("../dbUtils");

const XP_WIN_RATE = 0.005;                       // Pepe's XP_WIN_RATE (frida-bot.py _grant_xp)
// 1.99pa: + the new milestone counts Pepe also keeps for his own tables (holdem_hands, bj_double_wins, hm_busts) - one base each
const METRICS = ["bj_hands", "bj_naturals", "holdem_pots", "holdem_hands", "bj_double_wins", "hm_busts"];
const AH = require("./achhands");
const BASE_FRESH_MS = 60 * 60 * 1000;            // ask Pepe again for a base older than this (old-engine hands keep counting there)

let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_ach_counts (userId TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
                    updated INTEGER, PRIMARY KEY (userId, metric))`);
    await runQuery("CREATE TABLE IF NOT EXISTS casino_reward_done (key TEXT PRIMARY KEY, created INTEGER)");
    await runQuery("CREATE TABLE IF NOT EXISTS casino_pvp_rolls (pair TEXT NOT NULL, ts INTEGER NOT NULL)");
    await runQuery("CREATE INDEX IF NOT EXISTS casino_pvp_rolls_pair ON casino_pvp_rolls (pair, ts)");
    // 1.99mw: Pepe's counts so far (per account and metric) and the gang-rep queue for Pepe
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_ach_base (userId TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
                    updated INTEGER, PRIMARY KEY (userId, metric))`);
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_rep_queue (key TEXT PRIMARY KEY, userId TEXT, camfrog TEXT NOT NULL, amount INTEGER NOT NULL,
                    created INTEGER, acked INTEGER)`);
    await runQuery("CREATE INDEX IF NOT EXISTS casino_rep_queue_open ON casino_rep_queue (acked, created)");
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

const hooks = { now: () => Date.now(), updateLevel: null };

async function once(key) {
  await ensure();
  const r = await runQuery("INSERT OR IGNORE INTO casino_reward_done (key, created) VALUES (?, ?)", [String(key).slice(0, 200), hooks.now()]);
  return !!(r && r.changes);
}

async function baseOf(uid, metric) {
  const r = await getQuery("SELECT n FROM casino_ach_base WHERE userId = ? AND metric = ?", [uid, metric]).catch(() => []);
  return r[0] ? Number(r[0].n) || 0 : 0;
}

async function bump(key, uid, metric, n) {
  await quietBackfill().catch(() => {});        // 1.99pa: new thresholds on old counts are given quietly first
  if (!(await once(key))) return null;
  await runQuery(`INSERT INTO casino_ach_counts (userId, metric, n, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(userId, metric) DO UPDATE SET n = n + excluded.n, updated = excluded.updated`, [uid, metric, n, hooks.now()]);
  const row = (await getQuery("SELECT n FROM casino_ach_counts WHERE userId = ? AND metric = ?", [uid, metric]))[0];
  return require("../achievements").awardCount(uid, metric, (row ? row.n : 0) + (await baseOf(uid, metric)));
}

/** 1.99pa: a running count (a streak) - set, not added; awarded with its value (no Pepe base: his tables keep their own). */
async function setRun(key, uid, metric, value, award) {
  if (!(await once(key))) return null;
  await runQuery(`INSERT INTO casino_ach_counts (userId, metric, n, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(userId, metric) DO UPDATE SET n = excluded.n, updated = excluded.updated`, [uid, metric, value, hooks.now()]);
  return award && value > 0 ? require("../achievements").awardCount(uid, award, value) : null;
}
async function runOf(uid, metric) {
  const r = await getQuery("SELECT n FROM casino_ach_counts WHERE userId = ? AND metric = ?", [uid, metric]).catch(() => []);
  return r[0] ? Number(r[0].n) || 0 : 0;
}

/** 1.99pa: the card-table achievements of one seat's blackjack round (achhands.blackjackSeat), each step keyed. */
async function blackjackSeatAch(T, k, uid, r, dealer) {
  const m = AH.blackjackSeat(r, !!T.high_stakes);
  for (const [metric, n] of Object.entries(m)) if (metric[0] !== "_") await bump(`${k}:${metric}`, uid, metric, n);
  // streaks: rounds won in a row (a push neither adds nor breaks), and the dealer busting every round you played
  const run = m._result === "win" ? (await runOf(uid, "bj_streak_run")) + 1 : m._result === "loss" ? 0 : await runOf(uid, "bj_streak_run");
  await setRun(`${k}:streak`, uid, "bj_streak_run", run, m._result === "win" ? "bj_streak" : null);
  const busted = !!(dealer && dealer.bust);
  const drun = busted ? (await runOf(uid, "bj_dbust_run")) + 1 : 0;
  await setRun(`${k}:dbust`, uid, "bj_dbust_run", drun, busted ? "bj_dealer_busts" : null);
}

const cos = () => require("../cosmetics");

/** The Camfrog name for a seat's gang rep: the one it played under, else the account's linked name. */
async function camfrogOf(T, uid) {
  const p = ((T && T.players) || {})[uid] || {};
  if (p.camfrog) return String(p.camfrog);
  const r = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [uid]).catch(() => []);
  return (r[0] && r[0].camfrogUsername) || null;
}

/** Win XP + a gang-rep event for `won` PAT/chips won, once per key. -> xp granted (0 if none / already done) */
async function winReward(T, key, uid, won) {
  try {
    const xp = Math.round((Number(won) || 0) * XP_WIN_RATE);
    if (!uid || xp <= 0 || !(await once(`${key}:win`))) return 0;      // marked BEFORE: never twice (lotto's rule)
    try {
      const up = hooks.updateLevel || require("../user.controller").updateLevel;
      if (up) await up(uid, xp);
    } catch (e) { console.error("[casino] win xp:", e.message); }
    const cf = await camfrogOf(T, uid);
    // G1: once the gangs live on the site the rep is applied here (keyed by the win) and the queue to Pepe retires
    if (await require("../gangs").addRep({ key: "casino:" + String(key).slice(0, 200), userId: uid, camfrog: cf, amount: xp, src: "casino" })) return xp;
    if (cf) {
      await runQuery("INSERT OR IGNORE INTO casino_rep_queue (key, userId, camfrog, amount, created, acked) VALUES (?, ?, ?, ?, ?, NULL)",
                     [String(key).slice(0, 200), uid, cf.slice(0, 64), xp, hooks.now()]);
    }
    return xp;
  } catch (e) {
    console.error("[casino] win reward:", e.message);
    return 0;
  }
}

/** A settled blackjack round. results: the engine's settle results (key = userId). -> [{uid, item}] drops */
async function blackjackRound(T, n, results, maxBet) {
  const drops = [];
  try {
    const cfg = await cos().dropConfig();
    for (const r of results || []) {
      const uid = r.key;
      const k = `cbj:${T.id}:r${n}:${uid}`;
      await bump(`${k}:hands`, uid, "bj_hands", (r.hands || []).length || 1);
      await winReward(T, k, uid, (Number(r.total_payout) || 0) - (Number(r.total_bet) || 0));
      await blackjackSeatAch(T, k, uid, r, ((T.eng && T.eng.results) || {}).dealer);    // 1.99pa
      const nat = (r.hands || []).filter((h) => h.is_bj && h.outcome === "blackjack").map((h) => Number(h.bet) || 0);
      if (!nat.length) continue;
      await bump(`${k}:natural`, uid, "bj_naturals", 1);
      const bet = Math.max(...nat);
      if (bet < (Number(cfg.min_bj_bet) || 0) || !(await once(`${k}:drop`))) continue;
      const it = await cos().rollDrop(uid, "blackjack", `${T.id}-r${n}-${uid}`, { organic: true, scale: bet / Math.max(1, Number(maxBet) || 10000) });
      if (it) drops.push({ uid, item: it });
    }
  } catch (e) {
    console.error("[casino] rewards (blackjack):", e.message);
  }
  return drops;
}

async function levelOf(uid) {
  const r = await getQuery("SELECT COALESCE(level, 0) AS l FROM users WHERE userId = ?", [uid]).catch(() => []);
  return r[0] ? Number(r[0].l) || 0 : 0;
}
async function dupOf(uid) {
  const r = await getQuery("SELECT dup_of FROM welcome_bonus WHERE userId = ?", [uid]).catch(() => []);
  return (r[0] && r[0].dup_of) || null;
}
/** Pepe's _cos_pvp_ok: a different identity, both level >= min_level, at most pair_rolls rolls per pair a day (1 opponent) */
async function pvpOk(uid, against, cfg) {
  const others = (against || []).filter((x) => x && x !== uid);
  if (!others.length) return false;
  const mine = await dupOf(uid);
  for (const o of others) if (o === mine || (await dupOf(o)) === uid) return false;
  const minLevel = Number(cfg.min_level) || 0;
  if (minLevel > 0) for (const w of [uid].concat(others)) if ((await levelOf(w)) < minLevel) return false;
  if (others.length === 1) {
    const pair = [uid, others[0]].sort().join("|");
    const day = hooks.now() - 24 * 3600 * 1000;
    const c = (await getQuery("SELECT COUNT(*) AS c FROM casino_pvp_rolls WHERE pair = ? AND ts > ?", [pair, day]))[0];
    if ((c ? c.c : 0) >= (Number(cfg.pair_rolls) || 0)) return false;
    await runQuery("INSERT INTO casino_pvp_rolls (pair, ts) VALUES (?, ?)", [pair, hooks.now()]);
  }
  return true;
}

/** A won hold'em pot (each award / an uncontested win). against: the userIds shown down against (none if uncontested). */
async function holdemPot(T, hand, idx, uid, amount, against) {
  try {
    const k = `chm:${T.id}:h${hand}:${uid}:p${idx}`;
    await bump(`${k}:pot`, uid, "holdem_pots", 1);
    const cfg = await cos().dropConfig();
    if ((Number(amount) || 0) < (Number(cfg.min_holdem_pot) || 0) || !(against || []).length) return null;
    if (!(await once(`${k}:drop`))) return null;
    await ensure();
    if (!(await pvpOk(uid, against, cfg))) return null;
    const it = await cos().rollDrop(uid, "holdem", `${T.id}-h${hand}-${uid}-${idx}`, { organic: true });
    return it ? { uid, item: it } : null;
  } catch (e) {
    console.error("[casino] rewards (hold'em):", e.message);
    return null;
  }
}

/** A finished hold'em hand: win XP + gang rep for each winner on chips won minus chips put in. won: {uid: chips}, contrib: {uid: chips}
 *  1.99pa: + a hand played (holdem_hands) for every seat that put chips in. */
async function holdemHand(T, hand, won, contrib) {
  for (const [uid, amt] of Object.entries(won || {})) {
    await winReward(T, `chm:${T.id}:h${hand}:${uid}`, uid, (Number(amt) || 0) - (Number((contrib || {})[uid]) || 0));
  }
  try {
    for (const [uid, put] of Object.entries(contrib || {})) if (Number(put) > 0) await bump(`chm:${T.id}:h${hand}:${uid}:hands`, uid, "holdem_hands", 1);
  } catch (e) {
    console.error("[casino] rewards (hold'em hands):", e.message);
  }
}

/** 1.99pa: a hold'em showdown's hand achievements (achhands.holdemShowdown) for every seat at it, keyed per hand + seat + metric.
 *  sd: holdem.js T.sd ({board, shown: [{cards}], cf: [{uid}]} in reveal order), awards: the engine's awards event. */
async function holdemShowdown(T, hand, sd, awards) {
  try {
    if (!sd || !Array.isArray(sd.shown) || !Array.isArray(sd.cf)) return;
    const reveals = sd.shown.map((s, i) => ({ who: (sd.cf[i] || {}).uid, cards: s.cards })).filter((r) => r.who && Array.isArray(r.cards));
    const stacks = Object.assign({}, (T.eng && T.eng.chips) || {});
    const res = AH.holdemShowdown({ reveals, board: sd.board || [], awards: (awards || []).map((a) => ({ who: a.who, amount: a.amount, pot: a.pot })),
                                    stacks, highStakes: !!T.high_stakes });
    // a knock-out of your own alt doesn't count
    const busts = {};
    for (const [w, l] of res._bustPairs || []) {
      if (w === l || (await dupOf(w)) === l || (await dupOf(l)) === w) continue;
      busts[w] = (busts[w] || 0) + 1;
    }
    for (const [uid, m] of Object.entries(res)) {
      for (const [metric, n0] of Object.entries(m)) {
        const n = metric === "hm_busts" ? (busts[uid] || 0) : n0;
        if (n > 0) await bump(`chm:${T.id}:h${hand}:${uid}:${metric}`, uid, metric, n);
      }
    }
  } catch (e) {
    console.error("[casino] rewards (hold'em showdown):", e.message);
  }
}

// ── the bot poll's side: Pepe's bases in, the rep queue out ──

/** Camfrog names of seated players whose Pepe base is missing or stale (Pepe answers with their counts). */
async function wantBases(tables) {
  try {
    await ensure();
    const want = new Map();                                   // userId -> camfrog name
    for (const T of tables || []) {
      if (!T || T.status === "closed" || !T.eng) continue;
      for (const uid of T.eng.seats || []) {
        if (want.has(uid)) continue;
        const cf = await camfrogOf(T, uid);
        if (cf) want.set(uid, cf);
      }
    }
    const out = [];
    const stale = hooks.now() - BASE_FRESH_MS;
    for (const [uid, cf] of want) {
      const r = await getQuery("SELECT MIN(updated) AS u, COUNT(*) AS c FROM casino_ach_base WHERE userId = ?", [uid]);
      const row = r[0] || {};
      if (!(row.c >= METRICS.length) || !(Number(row.u) > stale)) out.push(cf);
      if (out.length >= 50) break;
    }
    return out;
  } catch (e) {
    console.error("[casino] ach want:", e.message);
    return [];
  }
}

/** Pepe's counts for these Camfrog names: [{camfrog, m: {metric: n}}]. Replaces the base (Pepe's count is the truth of his side). */
async function setBases(list, tables) {
  if (!Array.isArray(list) || !list.length) return 0;
  let n = 0;
  try {
    await ensure();
    // a seat's own Camfrog name first (the name Pepe counted it under), then the account link
    const seatOf = new Map();
    for (const T of tables || []) {
      for (const [uid, p] of Object.entries((T && T.players) || {})) if (p && p.camfrog) seatOf.set(String(p.camfrog).toLowerCase(), uid);
    }
    for (const b of list.slice(0, 50)) {
      const cf = String((b && b.camfrog) || "").trim();
      if (!cf || cf.length > 64 || !b.m || typeof b.m !== "object") continue;
      let uid = seatOf.get(cf.toLowerCase());
      if (!uid) {
        const r = await getQuery(`SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?)
                                  ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [cf]).catch(() => []);
        uid = r[0] && r[0].userId;
      }
      if (!uid) continue;
      for (const m of METRICS) {
        const v = Math.trunc(Number(b.m[m]) || 0);
        if (!(v >= 0) || v > 1e9) continue;
        await runQuery(`INSERT INTO casino_ach_base (userId, metric, n, updated) VALUES (?, ?, ?, ?)
                        ON CONFLICT(userId, metric) DO UPDATE SET n = excluded.n, updated = excluded.updated`, [uid, m, v, hooks.now()]);
      }
      n++;
    }
  } catch (e) {
    console.error("[casino] ach base:", e.message);
  }
  return n;
}

/** Unacked rep events for Pepe (oldest first). */
async function repPending(limit = 50) {
  try {
    await ensure();
    return (await getQuery("SELECT key, camfrog, amount FROM casino_rep_queue WHERE acked IS NULL ORDER BY created, key LIMIT ?",
                           [Math.max(1, Math.min(200, limit))])).map((r) => ({ key: r.key, camfrog: r.camfrog, amount: Number(r.amount) || 0 }));
  } catch (e) {
    console.error("[casino] rep queue:", e.message);
    return [];
  }
}

async function repAck(keys) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  let n = 0;
  try {
    await ensure();
    for (const k of keys.slice(0, 200)) {
      const r = await runQuery("UPDATE casino_rep_queue SET acked = ? WHERE key = ? AND acked IS NULL", [hooks.now(), String(k).slice(0, 200)]);
      n += (r && r.changes) || 0;
    }
  } catch (e) {
    console.error("[casino] rep ack:", e.message);
  }
  return n;
}

/** 1.99nc: a counted achievement metric outside the casino (lotto wins / tickets, market wins), once per key - the same
 *  counter and award path as the casino's (casino_ach_counts -> achievements.awardCount -> Pepe's feed). */
async function siteCount(key, uid, metric, n) {
  try {
    if (!uid || !metric || !(Number(n) > 0)) return null;
    return await bump(key, uid, metric, Math.trunc(Number(n)));
  } catch (e) {
    console.error(`[achievements] ${metric}:`, e.message);
    return null;
  }
}

// 1.99pa: once, quietly give the new thresholds on the counts the site already has (cf_bj_10 / cf_bj_5000 / cf_bj_natural_10 /
// cf_holdem_100 ...: site count + Pepe's base) - badge only, no XP / PAT / announcement - before any new hand can award them
// loudly (bump() waits for it). Flag achievement_meta 'casino_ach_backfill_oq'.
let quietP = null;
function quietBackfill() {
  if (!quietP) {
    quietP = (async () => {
      await ensure();
      const A = require("../achievements");
      await A.ready;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      if ((await getQuery("SELECT v FROM achievement_meta WHERE k = 'casino_ach_backfill_oq'")).length) return { done: true, already: true, given: 0 };
      const ach = A.list().filter((a) => a.side !== "web" && ["bj_hands", "bj_naturals", "holdem_pots"].includes(a.metric));
      const rows = await getQuery(`SELECT c.userId, c.metric, c.n + COALESCE(b.n, 0) AS v FROM casino_ach_counts c
                                   LEFT JOIN casino_ach_base b ON b.userId = c.userId AND b.metric = c.metric
                                   WHERE c.metric IN ('bj_hands', 'bj_naturals', 'holdem_pots')`);
      const given = [];
      for (const r of rows) {
        for (const a of ach) {
          if (a.metric !== r.metric || (Number(r.v) || 0) < (a.threshold || 1)) continue;
          const x = await A.award({ userId: r.userId }, a.id, null, { silent: true });
          if (x.ok && x.awarded) given.push({ userId: r.userId, badgeId: a.id });
        }
      }
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES ('casino_ach_backfill_oq', ?)",
                     [JSON.stringify({ at: new Date().toISOString(), given: given.length, users: new Set(given.map((g) => g.userId)).size })]);
      if (given.length) console.log(`[casino] achievements quiet backfill: ${given.length} badge(s)`);
      return { done: true, given: given.length, list: given };
    })().catch((e) => { quietP = null; throw e; });
  }
  return quietP;
}

async function counts(uid) {
  await ensure();
  const out = {};
  for (const r of await getQuery("SELECT metric, n FROM casino_ach_counts WHERE userId = ?", [uid])) out[r.metric] = r.n;
  return out;
}

module.exports = { blackjackRound, holdemPot, holdemHand, holdemShowdown, quietBackfill, winReward, wantBases, setBases, repPending, repAck, counts, ensure, hooks, siteCount,
                   XP_WIN_RATE, METRICS };
