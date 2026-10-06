// staking.js — the vault staking dashboard on PATV (/staking).
//
// Staking runs in Pepe. Stashes stake PAT into one of the protocol's vaults (Bank, House, Market
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

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const low = (s) => String(s || "").toLowerCase();
// Pepe sends unix seconds; accept milliseconds too
const secs = (v) => { const n = num(v); return n > 1e12 ? Math.floor(n / 1000) : n; };
const pick = (o, keys, f = num) => { const r = {}; for (const k of keys) r[k] = f((o || {})[k]); return r; };

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
    positions[str(id, 40)] = {
      owner: str(p.owner, 60), name: str(p.name, 20),
      members: (Array.isArray(p.members) ? p.members : []).slice(0, 50).map((m) => str(m, 60)),
      hold,
    };
  });
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
    },
    epochs: (Array.isArray(body.epochs) ? body.epochs : []).slice(-120).map((e) => ({
      ts: secs(e.ts), price: pick(e.price, ALL), nav: pick(e.nav, VAULTS), staked: pick(e.staked, VAULTS), flows: cleanFlows(e.flows),
    })).filter((e) => e.ts).sort((a, b) => a.ts - b.ts),
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
  // 120 epochs with flows can pass express.json()'s default 100kb — index.js must let this path
  // through to the larger parser here (same as /api/media) for big snapshots.
  app.post("/api/staking/sync", express.json({ limit: "4mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
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
    const msg = req.query.msg ? String(req.query.msg).slice(0, 200) : null;
    try {
      const snap = await latest();
      let camfrog = null, signedIn = false, acts = [];
      if (req.user && req.user.userId) {
        const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
        signedIn = !!u;
        camfrog = (u && u.camfrogUsername) || null;
        acts = await actions.recentFor(req.user.userId, "staking");
      }
      const base = { user: req.user ? req.user.username : null, signedIn, camfrog, msg, acts, now: Date.now() / 1000, snap: null };
      if (!snap) return res.render("staking", base);

      // My stashes: positions I'm in, plus any open stash of mine from the wallet snapshot (so a
      // stash with nothing staked yet can still stake).
      let mine = [];
      if (camfrog) {
        const me = low(camfrog);
        const seen = new Set();
        Object.entries(snap.positions || {}).forEach(([id, p]) => {
          if (!isMine(p, camfrog)) return;
          seen.add(low(p.owner) + "/" + low(p.name));
          mine.push({ id, owner: p.owner, name: p.name, members: p.members, hold: p.hold || {}, total: holdValue(p) });
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

      res.render("staking", {
        ...base, snap, mine,
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

module.exports = { register, latest, clean, isMine, holdValue, positionFor, revenue, chart, VAULTS: ALL };
