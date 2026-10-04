// markets.js — Pepe's prediction markets on PATV.
//
// The markets themselves (bets, escrow, settlement) still run in Pepe; he pushes a snapshot of
// every market here whenever one changes (and on a heartbeat). This module stores those snapshots
// and renders /markets and /markets/:id. Parimutuel maths mirrors pepe_market.py: winners split the
// losing pool minus the fee, pro rata to their stake.
const { runQuery, getQuery } = require("./dbUtils");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, closes INTEGER, updated INTEGER)`).catch(() => {});

const FEE_PCT = 5;
const LIVE = new Set(["open", "closed", "settling"]);

function view(m) {
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
          bets: (m.bets || []).map((x) => ({ nick: String(x.nick || ""), option: String(x.option || ""),
                                           amount: Math.floor(Number(x.amount) || 0), ts: Number(x.ts) || 0 })),
        };
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

  app.get("/markets", addUser, async (req, res) => {
    await ready;
    const rows = (await getQuery("SELECT data FROM markets ORDER BY id DESC LIMIT 300")).map((r) => view(JSON.parse(r.data)));
    const live = rows.filter((m) => LIVE.has(m.status)).sort((a, b) => a.closes - b.closes);
    const done = rows.filter((m) => !LIVE.has(m.status)).sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 40);
    res.render("markets", { user: req.user ? req.user.username : null, live, done, now: Date.now() / 1000 });
  });

  app.get("/markets/:id", addUser, async (req, res) => {
    await ready;
    const id = parseInt(String(req.params.id).replace(/^m/i, ""), 10);
    const rows = id ? await getQuery("SELECT data FROM markets WHERE id = ?", [id]) : [];
    if (!rows.length) return res.status(404).render("market", { user: req.user ? req.user.username : null, m: null, now: Date.now() / 1000 });
    res.render("market", { user: req.user ? req.user.username : null, m: view(JSON.parse(rows[0].data)), now: Date.now() / 1000 });
  });
}

module.exports = { register, view };
