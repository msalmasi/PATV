// lotto.js — Pepe's weekly lotto on PATV (/lotto).
//
// The lotto itself (tickets, escrowed jackpot, the Sunday draw) runs in Pepe; he pushes a snapshot
// here whenever it changes and we keep only the latest one. Buying tickets from the site goes
// through the action queue (actions.js): the form posts to /act with cmd=lotto and Pepe runs it as
// the user's linked Camfrog name, exactly like `!lotto quick 5` or `!lotto 3 9 14 27 pb 6` in chat.
//
// 1.99ml: with the lotto backend ON (lotto/service.js, docs/lotto-backend.md) the SITE owns the lotto: the service
// writes lotto_state itself (storeSnapshot below) and Pepe's /api/lotto/sync is refused (409 {backend: true}, so a
// Pepe still running his own lotto stops selling). The description above is true while lotto_backend is off.
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS lotto_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER)`)
  // 1.99lb: Pepe clears the tickets the moment he draws, so the site keeps each player's tickets of the last
  // draw (taken from the snapshot just before the draw number moved on) - "your tickets" can then show the
  // matches. Only the last two draws are kept; a player only ever sees their own.
  .then(() => runQuery(`CREATE TABLE IF NOT EXISTS lotto_last_tickets (
    draw INTEGER NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, tickets TEXT NOT NULL, PRIMARY KEY (draw, name))`))
  .catch(() => {});

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

// 1.99nh: /lotto?dup=3-9-14-27-6&dupdraw=12 (actions.js, after a hand pick the buyer already holds) -> the "buy it
// again?" card's ticket; anything malformed -> null (no card)
function parseDupAsk(q) {
  const n = String((q && q.dup) || "").split("-").map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : NaN));
  const draw = /^\d{1,7}$/.test(String((q && q.dupdraw) || "")) ? Number(q.dupdraw) : 0;
  if (n.length !== WHITE_PICK + 1 || !draw) return null;
  const w = n.slice(0, WHITE_PICK), pb = n[WHITE_PICK];
  if (new Set(w).size !== WHITE_PICK || !w.every((x) => x >= 1 && x <= WHITE_MAX) || !(pb >= 1 && pb <= BALL_MAX)) return null;
  return { draw, w: w.sort((a, b) => a - b), pb };
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

/** 1.99lb: when a snapshot moves to a new draw, archive the previous snapshot's tickets per player. */
async function keepLastTickets(clean) {
  const row = (await getQuery("SELECT data FROM lotto_state WHERE id = 1"))[0];
  if (!row) return;
  let old;
  try { old = JSON.parse(row.data); } catch (e) { return; }
  if (!old || !old.draw || !(clean.draw > old.draw)) return;
  for (const [name, p] of Object.entries(old.players || {})) {
    if (!p || !p.tickets || !p.tickets.length) continue;
    await runQuery(`INSERT OR REPLACE INTO lotto_last_tickets (draw, name, count, tickets) VALUES (?, ?, ?, ?)`,
      [old.draw, name, int(p.count), JSON.stringify(p.tickets)]);
  }
  await runQuery("DELETE FROM lotto_last_tickets WHERE draw < ?", [old.draw - 1]);
}

/** Which prize a ticket won against a drawn result: { w, ball, amount } or null. */
function ticketPrize(t, h, prizes) {
  if (!h || !Array.isArray(t)) return null;
  const w = (t[0] || []).filter((n) => h.white.includes(n)).length, ball = t[1] === h.pb;
  const p = (prizes || []).find((x) => x.w === w && x.ball === ball);
  return p ? { w, ball, amount: p.amount, jackpot: !!p.jackpot } : null;
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  app.post("/api/lotto/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      await ready;
      // 1.99ml: the backend owns the lotto - a Pepe still running his own must not overwrite it
      if ((await require("./lotto/service").loadSettings()).lotto_backend) return res.status(409).json({ success: false, backend: true });
      const clean = cleanSnapshot(body);
      await keepLastTickets(clean);
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
      const backend = !!(L && L.backend);
      // 1.99ml: the backend keys a player without a Camfrog link as "@<username>"
      const pkey = me ? (me.camfrogUsername ? String(me.camfrogUsername) : backend ? "@" + me.username : "").toLowerCase() : "";
      const mine = L && pkey ? L.players[pkey] || null : null;
      // prize table: jackpot row first, then Pepe's list, each with its odds
      const prizes = L ? [{ w: WHITE_PICK, ball: true, amount: L.jackpot, jackpot: true, odds: oddsFor(WHITE_PICK, true) },
        ...L.prizes.filter((p) => !(p[0] === WHITE_PICK && p[1]))
          .map((p) => ({ w: p[0], ball: p[1], amount: p[2], jackpot: false, odds: oddsFor(p[0], p[1]) }))
          .sort((a, b) => b.amount - a.amount)] : [];
      // chance a ticket wins anything listed
      const anyOdds = prizes.length ? Math.round(1 / prizes.reduce((s, p) => s + (p.odds ? 1 / p.odds : 0), 0)) : null;
      // 1.99lb: the player count, and the viewer's own tickets + winnings from the last draw
      const players = L ? Object.values(L.players || {}).filter((p) => p && p.count > 0).length : 0;
      const latest = L && L.history.length ? L.history[0] : null;
      let last = null;
      if (latest && pkey) {
        const login = pkey;
        const r = (await getQuery("SELECT count, tickets FROM lotto_last_tickets WHERE draw = ? AND name = ?", [latest.draw, login]))[0];
        let tickets = [];
        try { tickets = r ? JSON.parse(r.tickets) : []; } catch (e) { tickets = []; }
        const rows = tickets.map((t) => ({ t, prize: ticketPrize(t, latest, prizes) }));
        const rank = (x) => (x.prize ? (x.prize.jackpot ? 1e15 : x.prize.amount) : -1);
        rows.sort((a, b) => rank(b) - rank(a));
        // what Pepe paid them (his top-50 list), else the fixed prizes their tickets matched
        const listed = (latest.won || []).filter((w) => String(w[0]).toLowerCase() === login);
        const won = listed.length ? listed.reduce((s, w) => s + w[1], 0)
          : rows.reduce((s, x) => s + (x.prize && !x.prize.jackpot ? x.prize.amount : 0), 0);
        if (r || won) last = { draw: latest.draw, count: r ? r.count : 0, won, tickets: rows };
      }
      res.locals.og = { title: "Pepeball — this week's jackpot", description: "Pick 4 of 1-30 + a Pepe Ball. Draws every Sunday 9pm ET. Buy tickets on PATV or with !lotto in a Camfrog room.",
                        image: res.locals.ogBase + "/og/lotto.png?v=" + Math.floor(Date.now() / 600000), url: res.locals.ogBase + "/lotto" };
      res.render("lotto", {
        user: req.user ? req.user.username : null, L, updated: row ? row.updated : null, me, mine, prizes, anyOdds,
        players, last, now: Math.floor(Date.now() / 1000), backend, commitment: L && L.commitment ? L.commitment : null,
        acts, msg: req.query.msg ? String(req.query.msg).trim().slice(0, 200) : null,
        dupAsk: me ? parseDupAsk(req.query) : null,
        rules: { WHITE_MAX, WHITE_PICK, BALL_MAX },
      });
    } catch (e) {
      console.error("[lotto] page:", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

/** 1.99ml: the lotto backend (lotto/service.js) writes the page's snapshot here - the same row Pepe's sync wrote. */
async function storeSnapshot(snap) {
  await ready;
  const clean = Object.assign(cleanSnapshot(snap), { backend: true, commitment: snap.commitment ? String(snap.commitment).slice(0, 64) : null });
  await keepLastTickets(clean);
  await runQuery(`INSERT INTO lotto_state (id, data, updated) VALUES (1, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [JSON.stringify(clean), Date.now()]);
}

module.exports = { register, oddsFor, cleanSnapshot, ticketPrize, storeSnapshot, parseDupAsk };
