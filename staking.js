// staking.js — the vault staking dashboard on PATV (/staking).
//
// Staking runs in Pepe until the Phase 3 cutover (capital/vaults.js: then the site owns the book and writes this snapshot
// itself). Stashes stake PAT into one of the protocol's vaults (Bank, House, Market
// maker) or into Auto, which spreads itself over the three by target weights. Each vault is priced
// per share; requests queue up and run at the next daily cut-off at that day's price. Pepe pushes a
// full snapshot here every few minutes (POST /api/staking/sync); we keep only the latest one
// (table staking_state, a single row) plus one compact row per day (staking_daily) as a backup of
// the price history. The epochs in the snapshot carry the history the page draws.
//
// Users stake / unstake through the website action queue (actions.js, POST /act, cmd=stash).
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = Promise.all([
  runQuery(`CREATE TABLE IF NOT EXISTS staking_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER)`),
  runQuery(`CREATE TABLE IF NOT EXISTS staking_daily (
    day TEXT PRIMARY KEY, ts INTEGER, prices TEXT, nav TEXT, staked TEXT, updated INTEGER)`),
]).catch(() => {});

const VAULTS = ["bank", "house", "mm"];
const ALL = ["bank", "house", "mm", "auto"];
const ACCOUNTS = ["bank", "jackpot", "mm", "lotto"]; // flow accounts (jackpot = the House)
const QKINDS = new Set(["deposit", "withdraw"]);
// one vault's weekly settlement (Pepe's epoch record, per-vault totals only)
const WF_FIELDS = ["surplus", "fed_loan_repaid", "stakers_share", "staked", "apr_cap", "stakers", "stakers_n", "fed", "incentives"];

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const low = (s) => String(s || "").toLowerCase();
// Pepe sends unix seconds; accept milliseconds too
const secs = (v) => { const n = num(v); return n > 1e12 ? Math.floor(n / 1000) : n; };
const pick = (o, keys, f = num) => { const r = {}; for (const k of keys) r[k] = f((o || {})[k]); return r; };
/** D2 on a weekly record's vault row (capital/vaults.js wfRowD2, the same rule): would_cap25 (what a 25% APR cap would have
 *  paid), weighting ("pat_days" wholly time-weighted | "partial" PAT-days that began mid-week | "snapshot"), cap_pct (the cap
 *  the plan applied, % APR; 0 = none) and fallback (D2's safeguard: no cap in force, the week not wholly time-weighted - the
 *  25% reference cap) - camfrog-bot 31c65d0; cap_pct / fallback null from an older Pepe. */
function wfD2(x) {
  const cap = numOrNull(x.cap_pct);
  return { would_cap25: numOrNull(x.would_cap25), weighting: ["pat_days", "partial", "snapshot"].includes(x.weighting) ? x.weighting : null,
           cap_pct: cap, fallback: cap === null ? null : (x.fallback === true || x.fallback === 1) };
}

function cleanFlows(f) {
  const out = {};
  for (const acct of ACCOUNTS) {
    const a = (f || {})[acct] || {};
    const side = (s) => {
      const r = {};
      Object.entries(s || {}).slice(0, 100).forEach(([why, amt]) => { const v = num(amt); if (v) r[str(why, 80)] = v; });
      return r;
    };
    out[acct] = { in: side(a.in), out: side(a.out) };
  }
  return out;
}

function clean(body) {
  const apr = {};
  for (const v of ALL) { const a = (body.apr || {})[v] || {}; apr[v] = { 7: numOrNull(a["7"]), 30: numOrNull(a["30"]) }; }
  // 1.99by: while a vault has less history than the APR window Pepe sends null, plus the plain return
  // so far ({r, days}, not annualised) for the page to show instead
  const so_far = {};
  for (const v of ALL) {
    const x = (body.so_far || {})[v];
    so_far[v] = x && Number.isFinite(Number(x.r)) && Number.isFinite(Number(x.days)) ? { r: Number(x.r), days: Number(x.days) } : null;
  }
  const mb = body.mm_book || null;
  const mm_book = mb ? { seeds: num(mb.seeds), value: num(mb.value) } : null;
  const s = body.settings || {};
  const positions = {};
  Object.entries(body.positions && typeof body.positions === "object" ? body.positions : {}).slice(0, 5000).forEach(([id, p]) => {
    p = p || {};
    const hold = {};
    for (const v of ALL) {
      const h = (p.hold || {})[v];
      if (h && (num(h.shares) || num(h.value))) hold[v] = { shares: num(h.shares), value: num(h.value) };
    }
    // staking fix plan P0.3: what the stash put in / took out per vault, and what staking paid it (weekly payouts + corrections)
    // (partial: the stash held the vault before its cost history began - Staked and P/L are unknown until the backfill)
    const cost = {};
    for (const v of ALL) {
      const c = (p.cost || {})[v];
      if (c && (num(c.in) || num(c.out))) cost[v] = Object.assign({ in: num(c.in), out: num(c.out) }, c.partial ? { partial: 1 } : {});
    }
    const pd = p.paid && typeof p.paid === "object" ? p.paid : null;
    // P2.1: the stash's PAT-days this week per vault (what next Monday's payout is shared by)
    const pdw = {};
    for (const v of VAULTS) { const x = num((p.pd || {})[v]); if (x > 0) pdw[v] = x; }
    positions[str(id, 40)] = {
      owner: str(p.owner, 60), name: str(p.name, 20),
      owner_id: p.owner_id ? str(p.owner_id, 64) : null, owner_name: p.owner_name ? str(p.owner_name, 60) : null,   // 1.99wy
      members: (Array.isArray(p.members) ? p.members : []).slice(0, 50).map((m) => str(m, 60)),
      hold, cost, paid: pd ? { d7: num(pd.d7), all: num(pd.all), corr: num(pd.corr) } : null, pd: pdw,
    };
  });
  const wf = (Array.isArray(body.waterfall) ? body.waterfall : []).slice(-8).filter((r) => r && /^W\d{4}-\d{2}-\d{2}$/.test(String(r.epoch || ""))).map((r) => ({
    epoch: str(r.epoch, 12), boundary: secs(r.boundary) || null, days: numOrNull(r.days), done: secs(r.done) || null, state: str(r.state, 12),
    staker_share: numOrNull(r.staker_share), staker_cap_pct: numOrNull(r.staker_cap_pct),
    vaults: Object.fromEntries(VAULTS.filter((v) => r.vaults && r.vaults[v] && typeof r.vaults[v] === "object")
      .map((v) => [v, Object.assign(pick(r.vaults[v], WF_FIELDS), wfD2(r.vaults[v]))])),
  }));
  return {
    prices: pick(body.prices, ALL),
    nav: pick(body.nav, VAULTS),
    auto_nav: num(body.auto_nav),
    staked: pick(body.staked, VAULTS),
    apr,
    so_far,
    mm_book,
    targets: pick(body.targets, VAULTS),
    next_epoch: secs(body.next_epoch) || null,
    lotto_pot: num(body.lotto_pot), bank_cash: num(body.bank_cash), mm_cash: num(body.mm_cash),
    heist_vault: num(body.heist_vault),
    targets_size: pick(body.targets_size, VAULTS),
    dividends: (Array.isArray(body.dividends) ? body.dividends : []).slice(-200)
      .filter((x) => x && VAULTS.includes(x.vault))
      .map((x) => ({ vault: x.vault, amount: num(x.amount), ts: secs(x.ts) }))
      .filter((x) => x.ts && x.amount > 0).sort((a, b) => a.ts - b.ts),
    settings: {
      ceil: numOrNull(s.ceil), floor: numOrNull(s.floor), topup: typeof s.topup === "boolean" ? s.topup : numOrNull(s.topup),
      staker_max: numOrNull(s.staker_max), bank_min: numOrNull(s.bank_min), house_max: numOrNull(s.house_max), mm_max: numOrNull(s.mm_max),
      // staking fix plan: the protocol cushion's switch + window, the weekly bonus cap (a fraction; 0 = no cap)
      cushion: s.cushion === true || s.cushion === 1, cushion_days: numOrNull(s.cushion_days), bonus_cap: numOrNull(s.bonus_cap),
      // P2.2 / P2.1 (2026-10-19): Auto deposits under the staker limit; the weekly payout shared by PAT-days
      auto_staker_cap: s.auto_staker_cap === true || s.auto_staker_cap === 1, weighted: s.weighted === true || s.weighted === 1,
    },
    epochs: (Array.isArray(body.epochs) ? body.epochs : []).slice(-120).map((e) => ({
      ts: secs(e.ts), price: pick(e.price, ALL), nav: pick(e.nav, VAULTS), staked: pick(e.staked, VAULTS), flows: cleanFlows(e.flows),
      staker_index: e.staker_index && typeof e.staker_index === "object" ? pick(e.staker_index, VAULTS, numOrNull) : null,
    })).filter((e) => e.ts).sort((a, b) => a.ts - b.ts),
    // staking fix plan P0.3: the stakers' own index / APR next to the whole vault's, the weekly settlements, the cushion
    staker_index: pick(body.staker_index, VAULTS, numOrNull),
    staker_apr: Object.fromEntries(VAULTS.map((v) => { const a = (body.staker_apr || {})[v] || {}; return [v, { 7: numOrNull(a["7"]), 30: numOrNull(a["30"]) }]; })),
    staker_so_far: Object.fromEntries(VAULTS.map((v) => {
      const x = (body.staker_so_far || {})[v];
      return [v, x && Number.isFinite(Number(x.r)) && Number.isFinite(Number(x.days)) ? { r: Number(x.r), days: Number(x.days) } : null];
    })),
    waterfall: wf,
    cushion: Object.fromEntries(VAULTS.map((v) => { const x = (body.cushion || {})[v] || {}; return [v, { shares: num(x.shares), value: num(x.value) }]; })),
    // P2.1: this week's PAT-days per vault (the bucket next Monday settles)
    // (from: when the PAT-days began; partial: this week's bucket started after the week did - the first week after the deploy)
    pd_week: { boundary: secs((body.pd_week || {}).boundary) || null, total: pick((body.pd_week || {}).total, VAULTS),
               from: secs((body.pd_week || {}).from) || null, partial: (body.pd_week || {}).partial === true },
    positions,
    queue: (Array.isArray(body.queue) ? body.queue : []).slice(0, 2000).map((q) => ({
      id: q.id == null ? null : str(q.id, 40), stash: str(q.stash, 60), vault: ALL.includes(q.vault) ? q.vault : str(q.vault, 10),
      kind: QKINDS.has(q.kind) ? q.kind : str(q.kind, 12), amount: num(q.amount), shares: num(q.shares),
      state: str(q.state, 20), ts: secs(q.ts) || null,
    })),
  };
}

let cache = null; // { data, updated }

/** The latest staking snapshot from Pepe ({...snapshot, updated}) or null. */
async function latest() {
  if (cache) return { ...cache.data, updated: cache.updated };
  await ready;
  try {
    const r = (await getQuery("SELECT data, updated FROM staking_state WHERE id = 1"))[0];
    if (!r) return null;
    cache = { data: JSON.parse(r.data), updated: r.updated };
    return { ...cache.data, updated: cache.updated };
  } catch (e) {
    return null;
  }
}

/** Does this position (stash) belong to / include this Camfrog name? */
function isMine(p, camfrog) {
  const me = low(camfrog);
  return !!me && (low(p.owner) === me || (p.members || []).some((m) => low(m) === me));
}

/** Total value of a position's holdings across vaults. */
const holdValue = (p) => ALL.reduce((t, v) => t + ((p && p.hold && p.hold[v]) ? num(p.hold[v].value) : 0), 0);

/**
 * Staking fix plan P0.3: a stash's numbers per vault - in (what went in: deposit legs, refunds not counted), out (what came
 * back: withdrawals), staked = in - out, value (now), P/L = value + out - in (the payouts are NOT in it: they land in the
 * stash's balance, see `paid`). The cost history is only trusted when it's WHOLE: a vault the stash holds with no cost
 * record, or with a partial one (the stash held it before its history began - capital/vaults.js addCost / backfillCost), has
 * staked and pl null ("—", never a made-up 0 or a fake gain), and so has the total.
 * -> {rows: {vault: {in, out, staked, value, pl, has, partial}}, total: {in, out, staked, value, pl}}
 */
function pnl(m) {
  const rows = {};
  const tot = { in: 0, out: 0, staked: 0, value: 0, pl: 0 };
  let known = true;
  for (const v of ALL) {
    const h = (m && m.hold && m.hold[v]) || null, c = (m && m.cost && m.cost[v]) || null;
    if (!h && !c) continue;
    const value = h ? num(h.value) : 0;
    const vin = c ? num(c.in) : 0, out = c ? num(c.out) : 0;
    const whole = !!c && !c.partial;
    const pl = whole ? value + out - vin : null;
    if (!whole) known = false;
    rows[v] = { in: vin, out, staked: whole ? vin - out : null, value, pl, has: !!h, partial: !!(c && c.partial) };
    tot.in += vin; tot.out += out; tot.staked += whole ? vin - out : 0; tot.value += value; tot.pl += pl || 0;
  }
  if (!known) { tot.pl = null; tot.staked = null; }
  return { rows, total: tot };
}

/** Find a stash's position by id, falling back to owner + name. */
function positionFor(snap, stash) {
  if (!snap || !snap.positions || !stash) return null;
  if (stash.id != null && snap.positions[String(stash.id)]) return snap.positions[String(stash.id)];
  return Object.values(snap.positions).find((p) => low(p.owner) === low(stash.owner) && low(p.name) === low(stash.name)) || null;
}

// "markets fees (M3)" → "Markets fees"; "heist_payout" → "Heist payout"
function label(why) {
  const base = String(why || "other").split(" (")[0].replace(/[_-]+/g, " ").trim() || "other";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Revenue (in) / costs (out) per flow account over the epochs within `days` of the last one. */
function revenue(epochs, days, top = 6) {
  if (!epochs.length) return null;
  const cut = epochs[epochs.length - 1].ts - days * 86400 + 3600; // the last `days` cut-offs
  const span = epochs.filter((e) => e.ts > cut);
  const res = {};
  for (const acct of ACCOUNTS) {
    const sum = { in: {}, out: {} };
    for (const e of span) {
      for (const side of ["in", "out"]) {
        Object.entries(((e.flows || {})[acct] || {})[side] || {}).forEach(([why, amt]) => {
          const k = label(why);
          sum[side][k] = (sum[side][k] || 0) + num(amt);
        });
      }
    }
    const list = (o) => {
      const all = Object.entries(o).map(([k, v]) => ({ k, v })).filter((x) => x.v).sort((a, b) => b.v - a.v);
      const head = all.slice(0, top);
      const rest = all.slice(top).reduce((t, x) => t + x.v, 0);
      if (rest) head.push({ k: `Other (${all.length - top})`, v: rest });
      return head;
    };
    const tin = Object.values(sum.in).reduce((t, v) => t + v, 0);
    const tout = Object.values(sum.out).reduce((t, v) => t + v, 0);
    res[acct] = { in: list(sum.in), out: list(sum.out), tin, tout, net: tin - tout };
  }
  return { days, epochs: span.length, accounts: res };
}

/** Share-price series normalised to 1.0 at each vault's first priced epoch. */
function chart(epochs) {
  const series = {};
  for (const v of ALL) {
    const first = epochs.find((e) => num(e.price[v]) > 0);
    const base = first ? num(first.price[v]) : 0;
    series[v] = base ? epochs.map((e) => (num(e.price[v]) > 0 ? num(e.price[v]) / base : null)) : [];
  }
  return { ts: epochs.map((e) => e.ts), series };
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  // 120 epochs with flows can pass express.json()'s default 100kb — index.js must let this path
  // through to the larger parser here (same as /api/media) for big snapshots.
  app.post("/api/staking/sync", express.json({ limit: "4mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
      // Phase 3: while the capital cluster lives on the site (capital/vaults.js) the site writes this snapshot from its own book -
      // a copy from Pepe (his mirror) is acknowledged and dropped
      if (await require("./capital/core").live().catch(() => false)) return res.json({ success: true, ignored: "the vaults live on the site" });
      const snap = clean(body);
      const now = Date.now();
      await runQuery(`INSERT INTO staking_state (id, data, updated) VALUES (1, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [JSON.stringify(snap), now]);
      cache = { data: snap, updated: now };
      const last = snap.epochs[snap.epochs.length - 1];
      if (last) {
        const day = new Date(last.ts * 1000).toISOString().slice(0, 10);
        await runQuery(`INSERT INTO staking_daily (day, ts, prices, nav, staked, updated) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(day) DO UPDATE SET ts = excluded.ts, prices = excluded.prices, nav = excluded.nav,
                        staked = excluded.staked, updated = excluded.updated`,
          [day, last.ts, JSON.stringify(last.price), JSON.stringify(last.nav), JSON.stringify(last.staked), now]);
      }
      res.json({ success: true, epochs: snap.epochs.length, positions: Object.keys(snap.positions).length, queue: snap.queue.length });
    } catch (e) {
      console.error("[staking] sync:", e);
      res.status(500).json({ success: false });
    }
  });

  app.get("/staking", addUser, async (req, res) => {
    const msg = require("./notices").read(req);       // 1.99ade: ?m=<id> (notices.js), never ?msg= text
    try {
      const snap = await latest();
      let camfrog = null, signedIn = false, acts = [], me = null;
      if (req.user && req.user.userId) {
        const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
        signedIn = !!u;
        camfrog = (u && u.camfrogUsername) || null;
        acts = await actions.recentFor(req.user.userId, "staking");
        // 1.99wy: stashes belong to the ACCOUNT (stashes.js) - "mine" is the signed-in account's, chat login or not
        if (u) me = await require("./stashes").actorOf({ userId: req.user.userId }).catch(() => null);
      }
      const base = { user: req.user ? req.user.username : null, signedIn, camfrog, msg, acts, now: Date.now() / 1000, snap: null,
                     canStake: !!camfrog || !!(me && me.userId && (await require("./stashes").live().catch(() => false))) };
      if (!snap) return res.render("staking", base);

      // My stashes: positions I'm in, plus any open stash of mine (so a stash with nothing staked yet can still stake).
      let mine = [];
      const SS = require("./stashes");
      const siteOwned = await SS.live().catch(() => false);
      if (me && me.userId && siteOwned) {
        for (const s of (await SS.list()).filter((x) => SS.canUse(x, me))) {
          const p = (snap.positions || {})[String(s.id)] || null;
          const ownerMe = SS.isOwner(s, me);
          const keys = new Set([String(s.id), low(s.name), low(s.owner + "/" + s.name), low(s.owner_name + "/" + s.name)]);
          mine.push({ id: s.id, owner: s.owner, owner_name: s.owner_name, name: s.name, members: s.member_names, hold: (p && p.hold) || {},
                      cost: (p && p.cost) || {}, paid: (p && p.paid) || null, pd: (p && p.pd) || {},
                      total: holdValue(p), balance: s.balance, owner_me: ownerMe, ref: ownerMe ? s.name : `${s.owner_name}/${s.name}`,
                      pending: (snap.queue || []).filter((q) => keys.has(String(q.stash)) || keys.has(low(q.stash))) });
        }
        mine.sort((a, b) => (b.owner_me - a.owner_me) || (b.total - a.total));
      } else if (camfrog) {
        const me = low(camfrog);
        const seen = new Set();
        Object.entries(snap.positions || {}).forEach(([id, p]) => {
          if (!isMine(p, camfrog)) return;
          seen.add(low(p.owner) + "/" + low(p.name));
          mine.push({ id, owner: p.owner, name: p.name, members: p.members, hold: p.hold || {}, cost: p.cost || {}, paid: p.paid || null, pd: p.pd || {}, total: holdValue(p) });
        });
        try {
          const w = (await getQuery("SELECT data FROM wallet_snapshots WHERE key = 'stashes'"))[0];
          const list = w ? (JSON.parse(w.data).stashes || []) : [];
          list.filter((s) => !s.closed && isMine(s, camfrog) && !seen.has(low(s.owner) + "/" + low(s.name)))
            .forEach((s) => mine.push({ id: s.id, owner: s.owner, name: s.name, members: s.members || [], hold: {}, total: 0, balance: s.balance }));
        } catch (e) { /* no wallet snapshot yet */ }
        mine = mine.map((s) => {
          const ownerMe = low(s.owner) === me;
          const keys = new Set([String(s.id), low(s.name), low(s.owner + "/" + s.name)]);
          const pending = (snap.queue || []).filter((q) => keys.has(String(q.stash)) || keys.has(low(q.stash)));
          return { ...s, owner_me: ownerMe, ref: ownerMe ? s.name : `${s.owner}/${s.name}`, pending };
        }).sort((a, b) => (b.owner_me - a.owner_me) || (b.total - a.total));
      }

      // the view gets only the viewer's own stashes (mine): every other stash's holdings, cost, payouts and PAT-days stay out
      res.render("staking", {
        ...base, snap: Object.assign({}, snap, { positions: {}, queue: [] }), mine, pnl,
        chart: chart(snap.epochs || []),
        rev: [revenue(snap.epochs || [], 7), revenue(snap.epochs || [], 30)].filter(Boolean),
        pending: (snap.queue || []).filter((q) => !/^(done|failed|cancel)/i.test(q.state || "")),
      });
    } catch (e) {
      console.error("[staking] page:", e);
      res.status(500).send("Couldn't load the staking dashboard.");
    }
  });
}

/** Phase 3: the site's own vault book (capital/vaults.js) writes staking_state itself - it hands the cache the new copy. */
function setCache(data, updated) { cache = { data, updated }; }

module.exports = { register, latest, clean, isMine, holdValue, pnl, positionFor, revenue, chart, setCache, ready, VAULTS: ALL };
