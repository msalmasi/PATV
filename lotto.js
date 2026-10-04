// lotto.js — Pepe's weekly lotto on PATV (/lotto).
//
// The lotto itself (tickets, escrowed jackpot, the Sunday draw) runs in Pepe; he pushes a snapshot
// here whenever it changes and we keep only the latest one. Buying tickets from the site goes
// through the action queue (actions.js): the form posts to /act with cmd=lotto and Pepe runs it as
// the user's linked Camfrog name, exactly like `!lotto quick 5` or `!lotto 3 9 14 27 pb 6` in chat.
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS lotto_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER)`).catch(() => {});

const WHITE_MAX = 30, WHITE_PICK = 4, BALL_MAX = 10;
const MAX_TICKETS_SHOWN = 300, MAX_PLAYERS = 2000, MAX_HISTORY = 60;

const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const str = (v, n = 60) => String(v == null ? "" : v).slice(0, n);
const whites = (a) => (Array.isArray(a) ? a.slice(0, WHITE_PICK).map((x) => int(x, 0, WHITE_MAX)) : []);

function cleanSnapshot(b) {
  const players = {};
  const src = b.players && typeof b.players === "object" ? b.players : {};
  for (const [name, p] of Object.entries(src).slice(0, MAX_PLAYERS)) {
    if (!p || typeof p !== "object") continue;
    players[str(name).toLowerCase()] = {
      count: int(p.count),
      tickets: (Array.isArray(p.tickets) ? p.tickets : []).slice(0, MAX_TICKETS_SHOWN)
        .filter((t) => Array.isArray(t)).map((t) => [whites(t[0]), int(t[1], 0, BALL_MAX)]),
    };
  }
  return {
    draw: int(b.draw),
    next_at: int(b.next_at),
    sales_open: !!b.sales_open,
    price: int(b.price),
    close_secs: int(b.close_secs, 0, 7 * 86400),
    jackpot: int(b.jackpot),
    sold: int(b.sold),
    prizes: (Array.isArray(b.prizes) ? b.prizes : []).slice(0, 20).filter((p) => Array.isArray(p))
      .map((p) => [int(p[0], 0, WHITE_PICK), !!p[1], int(p[2])]),
    players,
    history: (Array.isArray(b.history) ? b.history : []).slice(0, MAX_HISTORY).filter((h) => h && typeof h === "object")
      .map((h) => ({
        draw: int(h.draw), white: whites(h.white), pb: int(h.pb, 0, BALL_MAX),
        tickets: int(h.tickets), winners: int(h.winners), paid: int(h.paid), jackpot: int(h.jackpot),
        jackpot_winners: (Array.isArray(h.jackpot_winners) ? h.jackpot_winners : []).slice(0, 50).map((n) => str(n)),
        jackpot_paid: int(h.jackpot_paid),
        won: Array.isArray(h.won) ? h.won.slice(0, 200).filter((w) => Array.isArray(w)).map((w) => [str(w[0]), int(w[1])]) : null,
        ts: int(h.ts),
      })),
  };
}

// n choose k
function C(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** "1 in N" odds for matching exactly `w` whites, with or without the Pepe Ball. */
function oddsFor(w, ball) {
  const combos = C(WHITE_MAX, WHITE_PICK);
  const pW = (C(WHITE_PICK, w) * C(WHITE_MAX - WHITE_PICK, WHITE_PICK - w)) / combos;
  const p = pW * (ball ? 1 / BALL_MAX : (BALL_MAX - 1) / BALL_MAX);
  return p > 0 ? Math.round(1 / p) : null;
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/lotto/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
      const clean = cleanSnapshot(body);
      await runQuery(`INSERT INTO lotto_state (id, data, updated) VALUES (1, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
        [JSON.stringify(clean), Date.now()]);
      res.json({ success: true });
    } catch (e) {
      console.error("[lotto] sync:", e);
      res.status(500).json({ success: false });
    }
  });

  app.get("/lotto", addUser, async (req, res) => {
    try {
      await ready;
      const row = (await getQuery("SELECT data, updated FROM lotto_state WHERE id = 1"))[0];
      const L = row ? JSON.parse(row.data) : null;
      let me = null, acts = [];
      if (req.user && req.user.userId) {
        me = (await getQuery("SELECT username, camfrogUsername, class, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
        acts = await actions.recentFor(req.user.userId, "lotto");
      }
      const mine = L && me && me.camfrogUsername ? L.players[String(me.camfrogUsername).toLowerCase()] || null : null;
      // prize table: jackpot row first, then Pepe's list, each with its odds
      const prizes = L ? [{ w: WHITE_PICK, ball: true, amount: L.jackpot, jackpot: true, odds: oddsFor(WHITE_PICK, true) },
        ...L.prizes.filter((p) => !(p[0] === WHITE_PICK && p[1]))
          .map((p) => ({ w: p[0], ball: p[1], amount: p[2], jackpot: false, odds: oddsFor(p[0], p[1]) }))
          .sort((a, b) => b.amount - a.amount)] : [];
      // chance a ticket wins anything listed
      const anyOdds = prizes.length ? Math.round(1 / prizes.reduce((s, p) => s + (p.odds ? 1 / p.odds : 0), 0)) : null;
      res.locals.og = { title: "Pepe Lotto — this week's jackpot", description: "Pick 4 of 1-30 + a Pepe Ball. Draws every Sunday 9pm ET. Buy tickets on PATV or with !lotto in a Camfrog room.",
                        image: res.locals.ogBase + "/og/lotto.png?v=" + Math.floor(Date.now() / 600000), url: res.locals.ogBase + "/lotto" };
      res.render("lotto", {
        user: req.user ? req.user.username : null, L, updated: row ? row.updated : null, me, mine, prizes, anyOdds,
        acts, msg: req.query.msg ? String(req.query.msg).trim().slice(0, 200) : null,
        rules: { WHITE_MAX, WHITE_PICK, BALL_MAX },
      });
    } catch (e) {
      console.error("[lotto] page:", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, oddsFor, cleanSnapshot };
