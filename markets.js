// markets.js — Pepe's prediction markets on PATV.
//
// The markets themselves (bets, escrow, settlement) still run in Pepe; he pushes a snapshot of
// every market here whenever one changes (and on a heartbeat). This module stores those snapshots
// and renders /markets and /markets/:id. Parimutuel maths mirrors pepe_market.py: winners split the
// losing pool minus the fee, pro rata to their stake.
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

// Pepe as judge (1.90): keep just the display fields of his ruling
function cleanAi(ai) {
  if (!ai || typeof ai !== "object") return null;
  return { state: String(ai.state || ""), result: ai.result == null ? null : String(ai.result).slice(0, 60),
           confidence: Number(ai.confidence) || 0, reason: String(ai.reason || "").slice(0, 240),
           until: Number(ai.until) || 0,
           // 1.99dh: when Pepe looks again, whether he handed it to the admins, the price data he used
           next_try: Number(ai.next_try) || 0, escalated: Number(ai.escalated) || 0, tries: Number(ai.tries) || 0,
           evidence: String(ai.evidence || "").slice(0, 320),
           disputes: (ai.disputes || []).slice(0, 30).map((d) => ({ nick: String(d.nick || "").slice(0, 60), why: String(d.why || "").slice(0, 160) })) };
}

const ready = runQuery(`CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, closes INTEGER, updated INTEGER)`).catch(() => {});

// Website bets (orders). The PAT moves in Pepe (escrow): he claims pending orders every few
// seconds, places each through the same checks as a chat bet, and acks the result. A bet carries its
// order id, so an order claimed twice (Pepe restarted mid-way) is never placed twice.
const ordersReady = runQuery(`CREATE TABLE IF NOT EXISTS market_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  username TEXT NOT NULL, camfrog TEXT, option TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`).catch(() => {});
for (const col of ["kind TEXT DEFAULT 'buy'", "shares TEXT", "outcome TEXT", "site_admin INTEGER DEFAULT 0"]) {
  ordersReady.then(() => runQuery(`ALTER TABLE market_orders ADD COLUMN ${col}`)).catch(() => {});
}
const MIN_BET = 500;
const RECLAIM_MS = 2 * 60 * 1000;   // a claimed order with no answer after this is handed out again

const FEE_PCT = 5;
const LIVE = new Set(["open", "closed", "settling"]);

function lmsrPrices(m) {
  const b = m.b, q = m.q || {};
  const mx = Math.max(...m.options.map((o) => (q[o] || 0) / b));
  const ex = Object.fromEntries(m.options.map((o) => [o, Math.exp((q[o] || 0) / b - mx)]));
  const s = Object.values(ex).reduce((a, v) => a + v, 0);
  return Object.fromEntries(m.options.map((o) => [o, ex[o] / s]));
}

const AMM_FEE_PCT = 2;   // pepe_amm.py: of every buy and sell (a void refunds cost basis net of it)

// 1.99do: how a share market ended, or null while it's still trading / waiting for the judge.
// Pepe's resolve (pepe_amm._amm_resolve) stamps paid_out {at, total, result} BEFORE the status flips
// from 'settling' to settled/void, so paid_out alone already means the payouts are out.
//   {kind: "won", result}  each winning share paid 1 PAT, every other share is worth 0
//   {kind: "void", ratio}  holders got their cost (net of the 2% fee) back, scaled down by `ratio`
//                          when the pot after the Reserve's seed couldn't cover it all
function settlement(m) {
  const po = m.paid_out && typeof m.paid_out === "object" ? m.paid_out : null;
  if (!po && !["settled", "resolved", "void"].includes(m.status)) return null;
  const res = String((po && po.result) || m.result || "");
  if (m.status === "void" || /^void\b/i.test(res)) {
    const keep = 1 - AMM_FEE_PCT / 100;
    const owed = Object.values(m.positions || {}).map((p) => Object.values(p.cost || {}).reduce((a, v) => a + (Number(v) || 0), 0) * keep)
      .filter((v) => v >= 1).reduce((a, v) => a + v, 0);
    const total = po && Number.isFinite(Number(po.total)) ? Number(po.total) : null;
    // paid_out.total is the sum of the floored refunds; within a PAT per holder of `owed` means "in full"
    let ratio = total == null || !owed ? 1 : Math.min(1, total / owed);
    if (total != null && owed - total <= Object.keys(m.positions || {}).length) ratio = 1;
    return { kind: "void", ratio, total, known: total != null, reason: m.void_reason || null };
  }
  if ((m.options || []).includes(res)) return { kind: "won", result: res, total: po ? Number(po.total) || 0 : null };
  return null;
}

function viewShares(m, me) {
  const prices = lmsrPrices(m);
  const settle = settlement(m);
  const holders = new Set(Object.values(m.positions || {}).filter((p) => Object.values(p.shares || {}).some((v) => v >= 1)).map((p) => p.nick.toLowerCase()));
  // a resolved market shows its result: the winner at 1.00, the rest at 0; `last` keeps the last trading price
  const options = m.options.map((o) => {
    const won = settle && settle.kind === "won" ? settle.result === o : m.result === o;
    const price = settle && settle.kind === "won" ? (won ? 1 : 0) : prices[o];
    return { name: o, price, last: prices[o], won };
  });
  let mine = null;
  if (me) {
    const keys = me.map((k) => String(k || "").toLowerCase()).filter(Boolean);
    const pos = Object.entries(m.positions || {}).find(([k]) => keys.includes(k));
    if (pos) {
      const p = pos[1];
      const keep = 1 - AMM_FEE_PCT / 100;
      const opts = m.options.filter((o) => (p.shares[o] || 0) >= 0.5 || (settle && settle.kind === "void" && (p.cost[o] || 0) >= 1));
      mine = opts.map((o) => {
        const sh = p.shares[o] || 0, cost = p.cost[o] || 0, now = prices[o];
        const row = { option: o, shares: sh, entry: sh ? cost / sh : 0, cost, price: now, value: sh * now, pnl: sh * now - cost, state: "open" };
        if (settle && settle.kind === "won") {
          const win = o === settle.result;
          const paid = win ? Math.floor(sh) : 0;
          Object.assign(row, { state: win ? "won" : "lost", price: win ? 1 : 0, value: paid, payout: paid, pnl: paid - cost });
        } else if (settle && settle.kind === "void") {
          const back = Math.floor(cost * keep * settle.ratio);
          Object.assign(row, { state: "refunded", price: null, value: back, payout: back, pnl: back - cost });
        }
        return row;
      });
    }
  }
  return { ...m, ref: `M${m.id}`, shares: true, options, total: m.volume || 0, bettors: holders.size, settle,
           betCount: (m.trades || []).length, mine, history: m.history || [], trades: (m.trades || []).slice().reverse() };
}

function view(m, me) {
  if (m.model === "lmsr") return viewShares(m, me);
  const pools = {};
  for (const o of m.options || []) pools[o] = 0;
  const bettors = new Set();
  for (const b of m.bets || []) {
    pools[b.option] = (pools[b.option] || 0) + Number(b.amount || 0);
    bettors.add(String(b.nick || "").toLowerCase());
  }
  const total = Object.values(pools).reduce((s, v) => s + v, 0);
  const options = (m.options || []).map((o) => {
    const pool = pools[o] || 0;
    const lose = total - pool;
    const fee = Math.floor(lose * FEE_PCT / 100);
    return { name: o, pool, share: total ? Math.round(pool * 100 / total) : 0,
             mult: pool ? 1 + (lose - fee) / pool : null, won: m.result === o };
  });
  return { ...m, ref: `M${m.id}`, options, total, bettors: bettors.size, betCount: (m.bets || []).length };
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  // Snapshot push (Pepe)
  app.post("/api/markets/sync", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const list = Array.isArray(b.markets) ? b.markets.slice(0, 500) : [];
    try {
      await ready;
      for (const m of list) {
        const id = parseInt(m.id, 10);
        if (!id) continue;
        const clean = {
          id, question: String(m.question || "").slice(0, 200), options: (m.options || []).map((o) => String(o).slice(0, 30)).slice(0, 6),
          creator: m.creator || "", judge: m.judge || "", room: m.room || "", status: m.status || "open",
          created: Number(m.created) || 0, closes: Number(m.closes) || 0, result: m.result || null,
          settled_by: m.settled_by || null, fee: Number(m.fee) || 0, ended: Number(m.ended) || null,
          ai_judge: !!m.ai_judge, ai: cleanAi(m.ai), ...(m.model === "pool" ? { model: "pool" } : {}),
          // 1.99do: Pepe's payout stamp (a share market is paid once this is set) + why it was voided
          paid_out: m.paid_out && typeof m.paid_out === "object"
            ? { at: Number(m.paid_out.at) || 0, total: Math.floor(Number(m.paid_out.total) || 0), result: String(m.paid_out.result || "").slice(0, 200) } : null,
          void_reason: m.void_reason ? String(m.void_reason).slice(0, 200) : null,
          bets: (m.bets || []).map((x) => ({ nick: String(x.nick || ""), option: String(x.option || ""),
                                           amount: Math.floor(Number(x.amount) || 0), ts: Number(x.ts) || 0, web: !!x.web })),
        };
        if (m.model === "lmsr") {
          Object.assign(clean, {
            model: "lmsr", b: Number(m.b) || 50000, volume: Math.floor(Number(m.volume) || 0),
            q: Object.fromEntries(clean.options.map((o) => [o, Number((m.q || {})[o]) || 0])),
            positions: Object.fromEntries(Object.entries(m.positions || {}).slice(0, 2000).map(([k, p]) => [String(k).toLowerCase(), {
              nick: String(p.nick || k), shares: Object.fromEntries(clean.options.map((o) => [o, Number((p.shares || {})[o]) || 0])),
              cost: Object.fromEntries(clean.options.map((o) => [o, Number((p.cost || {})[o]) || 0])) }])),
            trades: (m.trades || []).slice(-300).map((t) => ({ ts: Number(t.ts) || 0, nick: String(t.nick || ""), side: t.side === "sell" ? "sell" : "buy",
              option: String(t.option || ""), shares: Number(t.shares) || 0, pat: Math.floor(Number(t.pat) || 0), web: !!t.web })),
            history: (m.history || []).slice(-400).map((h) => [Number(h[0]) || 0, h[1] || {}]),
          });
        }
        await runQuery(`INSERT INTO markets (id, data, status, closes, updated) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status,
                        closes = excluded.closes, updated = excluded.updated`,
          [id, JSON.stringify(clean), clean.status, clean.closes, Date.now()]);
      }
      res.json({ success: true, stored: list.length });
    } catch (e) {
      console.error("[markets] sync:", e);
      res.status(500).json({ success: false, error: "server_error" });
    }
  });

  // A signed-in user bets from the market page
  app.post("/markets/:id/bet", addUser, async (req, res) => {
    const id = parseInt(String(req.params.id).replace(/^m/i, ""), 10);
    const back = (msg) => res.redirect(`/markets/${id}?msg=${encodeURIComponent(msg)}`);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      await ready; await ordersReady;
      const rows = await getQuery("SELECT data FROM markets WHERE id = ?", [id]);
      if (!rows.length) return back("That market doesn't exist.");
      const m = JSON.parse(rows[0].data);
      if (m.status !== "open" || m.closes * 1000 < Date.now()) return back("Betting on this market is closed.");
      const option = String((req.body || {}).option || "");
      if (!(m.options || []).includes(option)) return back("Pick one of the options.");
      const amount = Math.floor(Number(String((req.body || {}).amount || "").replace(/[, ]/g, "")) || 0);
      if (amount < MIN_BET) return back(`The minimum bet is ${MIN_BET.toLocaleString()} PAT.`);
      const u = (await getQuery("SELECT username, camfrogUsername, points_balance, casino_banned FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!u) return back("Couldn't find your account.");
      if (u.casino_banned) return back("You're banned from the casino, so no betting.");
      if (Number(u.points_balance) < amount) return back(`You only have ${Number(u.points_balance).toLocaleString()} PAT.`);
      const open = await getQuery("SELECT COUNT(*) AS n FROM market_orders WHERE user_id = ? AND status IN ('pending','claimed')", [req.user.userId]);
      if (open[0].n >= 5) return back("You already have bets waiting to be placed — give Pepe a moment.");
      await runQuery(`INSERT INTO market_orders (market_id, user_id, username, camfrog, option, amount, status, created, updated)
                      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [id, req.user.userId, u.username, u.camfrogUsername || null, option, amount, Date.now(), Date.now()]);
      back(`Sent to Pepe: ${amount.toLocaleString()} PAT on ${option}. It's placed within a few seconds.`);
    } catch (e) {
      console.error("[markets] bet:", e);
      back("Something went wrong — nothing was charged. Try again.");
    }
  });

  async function queue(req, res, id, fields, okMsg) {
    const back = (msg) => res.redirect(`/markets/${id}?msg=${encodeURIComponent(msg)}`);
    try {
      const rows = await getQuery("SELECT data FROM markets WHERE id = ?", [id]);
      if (!rows.length) return back("That market doesn't exist.");
      const m = JSON.parse(rows[0].data);
      if (fields.kind === "sell" && (m.model !== "lmsr" || m.status !== "open")) return back("Shares can only be sold while trading is open.");
      if (fields.kind === "resolve" && !["open", "closed"].includes(m.status)) return back("This market is already resolved.");
      const u = (await getQuery("SELECT username, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!u) return back("Couldn't find your account.");
      const open = await getQuery("SELECT COUNT(*) AS n FROM market_orders WHERE user_id = ? AND status IN ('pending','claimed')", [req.user.userId]);
      if (open[0].n >= 5) return back("You already have orders waiting — give Pepe a moment.");
      await runQuery(`INSERT INTO market_orders (market_id, user_id, username, camfrog, option, amount, kind, shares, outcome, site_admin, status, created, updated)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [id, req.user.userId, u.username, u.camfrogUsername || null, fields.option || "", fields.amount || 0, fields.kind,
         fields.shares || null, fields.outcome || null, u.class === "Admin" ? 1 : 0, Date.now(), Date.now()]);
      back(okMsg);
    } catch (e) {
      console.error(`[markets] ${fields.kind}:`, e);
      back("Something went wrong — nothing changed. Try again.");
    }
  }

  app.post("/markets/:id/sell", addUser, async (req, res) => {
    const id = parseInt(String(req.params.id).replace(/^m/i, ""), 10);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    await ready; await ordersReady;
    const option = String((req.body || {}).option || "");
    const shares = String((req.body || {}).shares || "all").trim() || "all";
    if (!/^(all|\d+(\.\d+)?)$/i.test(shares)) return res.redirect(`/markets/${id}?msg=${encodeURIComponent("Enter a number of shares, or all.")}`);
    queue(req, res, id, { kind: "sell", option, shares }, `Sent to Pepe: sell ${shares} ${option} shares.`);
  });

  app.post("/markets/:id/resolve", addUser, async (req, res) => {
    const id = parseInt(String(req.params.id).replace(/^m/i, ""), 10);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    await ready; await ordersReady;
    let outcome = String((req.body || {}).outcome || "");
    if (!outcome) return res.redirect(`/markets/${id}?msg=${encodeURIComponent("Pick the winning option (or void).")}`);
    if (outcome === "void") {
      const reason = String((req.body || {}).reason || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (reason.length < 4) return res.redirect(`/markets/${id}?msg=${encodeURIComponent("Say why you're voiding it (holders and admins see the reason).")}`);
      outcome = "void " + reason;
    }
    queue(req, res, id, { kind: "resolve", outcome }, `Sent to Pepe: resolve as ${outcome}. Payouts follow in a few seconds.`);
  });

  // Pepe takes the pending orders (and any claimed ones he never answered)
  app.post("/api/markets/orders/claim", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ordersReady;
    const now = Date.now();
    const rows = await getQuery(`SELECT * FROM market_orders WHERE status = 'pending' OR (status = 'claimed' AND claimed < ?)
                                 ORDER BY id LIMIT 20`, [now - RECLAIM_MS]);
    for (const o of rows) await runQuery("UPDATE market_orders SET status = 'claimed', claimed = ?, updated = ? WHERE id = ?", [now, now, o.id]);
    res.json({ orders: rows.map((o) => ({ id: o.id, market_id: o.market_id, username: o.username, camfrog: o.camfrog,
                                          option: o.option, amount: o.amount, kind: o.kind || "buy", shares: o.shares,
                                          outcome: o.outcome, site_admin: !!o.site_admin })) });
  });

  app.post("/api/markets/orders/ack", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    await ordersReady;
    for (const r of ((req.body || {}).results || []).slice(0, 50)) {
      await runQuery("UPDATE market_orders SET status = ?, message = ?, updated = ? WHERE id = ?",
        [r.ok ? "placed" : "failed", String(r.message || "").slice(0, 200), Date.now(), parseInt(r.id, 10) || 0]);
    }
    res.json({ ok: true });
  });

  app.get("/markets", addUser, async (req, res) => {
    await ready;
    const rows = (await getQuery("SELECT data FROM markets ORDER BY id DESC LIMIT 300")).map((r) => view(JSON.parse(r.data)))
      .filter((m) => m.shares);
    const live = rows.filter((m) => LIVE.has(m.status) && !m.settle).sort((a, b) => a.closes - b.closes);
    const done = rows.filter((m) => !LIVE.has(m.status) || m.settle).sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 40);
    let linked = false, acts = [];
    if (req.user && req.user.userId) {
      const u = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]);
      linked = !!(u[0] && u[0].camfrogUsername);
      acts = await actions.recentFor(req.user.userId, "markets");
    }
    res.render("markets", { user: req.user ? req.user.username : null, live, done, now: Date.now() / 1000, linked, acts,
                            msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null });
  });

  app.get("/markets/:id", addUser, async (req, res) => {
    await ready;
    const id = parseInt(String(req.params.id).replace(/^m/i, ""), 10);
    const rows = id ? await getQuery("SELECT data FROM markets WHERE id = ?", [id]) : [];
    if (!rows.length) return res.status(404).render("market", { user: req.user ? req.user.username : null, m: null, now: Date.now() / 1000, orders: [], msg: null, bal: null });
    let orders = [], bal = null, me = null, judgeMe = false, acts = [], inIt = false;
    if (req.user && req.user.userId) {
      await ordersReady;
      orders = await getQuery("SELECT * FROM market_orders WHERE user_id = ? AND market_id = ? ORDER BY id DESC LIMIT 10", [req.user.userId, id]);
      const u = await getQuery("SELECT points_balance, username, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]);
      bal = u.length ? Number(u[0].points_balance) : null;
      if (u.length) {
        me = [u[0].camfrogUsername, u[0].username];
        const raw = JSON.parse(rows[0].data);
        judgeMe = u[0].class === "Admin" || (!!u[0].camfrogUsername && String(raw.judge || "").toLowerCase() === u[0].camfrogUsername.toLowerCase());
        const cf = String(u[0].camfrogUsername || "").toLowerCase();
        inIt = !!cf && (Object.keys(raw.positions || {}).includes(cf) || (raw.bets || []).some((b) => String(b.nick).toLowerCase() === cf)
                        || String(raw.creator || "").toLowerCase() === cf);
      }
      acts = await actions.recentFor(req.user.userId, "market-" + id);
    }
    res.locals.og = require("./og").forMarket(req, JSON.parse(rows[0].data));
    res.render("market", { user: req.user ? req.user.username : null, m: view(JSON.parse(rows[0].data), me), now: Date.now() / 1000, judgeMe, acts, inIt,
                           orders, msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null, bal, minBet: MIN_BET });
  });
}

module.exports = { register, view, settlement, lmsrPrices };
