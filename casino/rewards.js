// casino/rewards.js — achievements and cosmetic drops for casino players Pepe can't count (1.99mj; the user's D4).
//
// Pepe counts blackjack hands / naturals and hold'em pots per Camfrog name, from the events of tables played in his rooms
// (pepe_casino.py -> _ach_bump / _cos_drop). Everyone else is counted HERE:
//
//     the site counts a seat  <=>  NOT (the table is in a Camfrog room AND the seat has a Camfrog name)
//
// and the event Pepe reads carries a seat's Camfrog name ONLY when Pepe counts it (service.js / holdem.js pass
// pepeName()), so no seat is ever counted by both. Counted here: the same metrics (bj_hands, bj_naturals, holdem_pots)
// into casino_ach_counts, awarded through achievements.awardCount (the same cf_bj_* / cf_holdem_* badges, XP, PAT and
// Pepe's announcement feed), and the same drops with Pepe's rows and gates (cosmetics.rollDrop, organic, daily cap):
//   * blackjack: a paid natural on a bet >= min_bj_bet, the chance scaled by bet / the table maximum;
//   * hold'em: a showdown pot >= min_holdem_pot won against someone else - not a linked account, both level >= min_level,
//     at most pair_rolls rolls per pair a day.
// Every step has a key in casino_reward_done (table, round / hand, seat, what), so a settlement re-run after a crash
// never counts or rolls twice. Nothing here can fail a settlement: errors are logged and swallowed.
"use strict";
const { runQuery, getQuery } = require("../dbUtils");

let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_ach_counts (userId TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
                    updated INTEGER, PRIMARY KEY (userId, metric))`);
    await runQuery("CREATE TABLE IF NOT EXISTS casino_reward_done (key TEXT PRIMARY KEY, created INTEGER)");
    await runQuery("CREATE TABLE IF NOT EXISTS casino_pvp_rolls (pair TEXT NOT NULL, ts INTEGER NOT NULL)");
    await runQuery("CREATE INDEX IF NOT EXISTS casino_pvp_rolls_pair ON casino_pvp_rolls (pair, ts)");
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

const hooks = { now: () => Date.now() };

/** Does Pepe count this seat? (a table in one of his rooms + a Camfrog name on the seat) */
const pepeCounts = (T, uid) => !!(T && T.room && ((T.players || {})[uid] || {}).camfrog);
/** The Camfrog name to put in an event for Pepe's counters: only when he counts the seat. */
const pepeName = (T, uid) => (pepeCounts(T, uid) ? T.players[uid].camfrog : null);

async function once(key) {
  await ensure();
  const r = await runQuery("INSERT OR IGNORE INTO casino_reward_done (key, created) VALUES (?, ?)", [String(key).slice(0, 200), hooks.now()]);
  return !!(r && r.changes);
}

async function bump(key, uid, metric, n) {
  if (!(await once(key))) return null;
  await runQuery(`INSERT INTO casino_ach_counts (userId, metric, n, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(userId, metric) DO UPDATE SET n = n + excluded.n, updated = excluded.updated`, [uid, metric, n, hooks.now()]);
  const row = (await getQuery("SELECT n FROM casino_ach_counts WHERE userId = ? AND metric = ?", [uid, metric]))[0];
  return require("../achievements").awardCount(uid, metric, row ? row.n : 0);
}

const cos = () => require("../cosmetics");

/** A settled blackjack round. results: the engine's settle results (key = userId). -> [{uid, item}] drops */
async function blackjackRound(T, n, results, maxBet) {
  const drops = [];
  try {
    const cfg = await cos().dropConfig();
    for (const r of results || []) {
      const uid = r.key;
      if (pepeCounts(T, uid)) continue;
      const k = `cbj:${T.id}:r${n}:${uid}`;
      await bump(`${k}:hands`, uid, "bj_hands", (r.hands || []).length || 1);
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
    if (pepeCounts(T, uid)) return null;
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

async function counts(uid) {
  await ensure();
  const out = {};
  for (const r of await getQuery("SELECT metric, n FROM casino_ach_counts WHERE userId = ?", [uid])) out[r.metric] = r.n;
  return out;
}

module.exports = { pepeCounts, pepeName, blackjackRound, holdemPot, counts, ensure, hooks };
