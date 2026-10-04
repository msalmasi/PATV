// wagers.js — 1-on-1 wagers and group betting pools on PATV (/wagers).
//
// The wagers themselves (escrow, accept/settle, AI judging) run in Pepe; he pushes a snapshot of
// every wager here whenever one changes. Group pools are ordinary parimutuel markets, so they come
// from the `markets` table (markets.js). Everything a user does here (accept, settle, dispute, bet,
// start one) goes through the website action queue (actions.js, POST /act), which Pepe runs as the
// user's linked Camfrog name — so every rule and fee is exactly the chat command's.
const { runQuery, getQuery } = require("./dbUtils");
const markets = require("./markets");
const actions = require("./actions");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS wagers (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, updated INTEGER)`).catch(() => {});
const KEEP_DAYS = 60;
const LIVE = new Set(["offered", "accepting", "active", "settling"]);
const POOL_LIVE = new Set(["open", "closed", "settling"]);
const WAGER_MIN = 1000;
const POOL_MIN = 500;
const FEE_PCT = 5;
const AI_STATES = new Set(["thinking", "unsure", "proposed", "disputed", "final", "done"]);

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v) => Number(v) || 0;
const low = (s) => String(s || "").toLowerCase();

/** Sanitise Pepe's AI-judge object (shared shape for wagers and markets). */
function cleanAi(ai) {
  if (!ai || typeof ai !== "object") return null;
  return {
    state: AI_STATES.has(ai.state) ? ai.state : "thinking",
    result: ai.result == null ? null : str(ai.result, 60),
    confidence: Math.max(0, Math.min(1, num(ai.confidence))),
    reason: str(ai.reason, 600),
    until: num(ai.until) || null,
    disputes: (Array.isArray(ai.disputes) ? ai.disputes : []).slice(0, 50)
      .map((d) => ({ nick: str(d && d.nick, 60), why: str(d && d.why, 300), ts: num(d && d.ts) })),
  };
}

function cleanWager(w) {
  const id = parseInt(w.id, 10);
  if (!id) return null;
  return {
    id, creator: str(w.creator, 60), opponent: str(w.opponent, 60), judge: str(w.judge, 60),
    amount: Math.floor(num(w.amount)), terms: str(w.terms, 300), room: str(w.room, 80),
    status: str(w.status || "offered", 20), created: num(w.created), offer_until: num(w.offer_until),
    deadline: num(w.deadline), accepted: num(w.accepted) || null, winner: w.winner ? str(w.winner, 60) : null,
    fee: Math.floor(num(w.fee)), ended: num(w.ended) || null, settled_by: w.settled_by ? str(w.settled_by, 60) : null,
    ai_judge: !!w.ai_judge, ai: cleanAi(w.ai),
  };
}

/** Display object for a wager; `me` is the viewer's lowercased Camfrog name (or null). */
function viewWager(w, me) {
  const pot = w.amount * 2;
  const fee = w.fee || Math.floor(pot * FEE_PCT / 100);
  const isCreator = !!me && low(w.creator) === me;
  const isOpponent = !!me && low(w.opponent) === me;
  return {
    ...w, ref: `W${w.id}`, pot, payout: pot - fee,
    isCreator, isOpponent, inIt: isCreator || isOpponent,
    isJudge: !!me && !w.ai_judge && low(w.judge) === me,
  };
}

/** Pool (parimutuel market) display object, plus who-am-I flags for the viewer. */
function viewPool(m, me) {
  const v = markets.view(m);
  const myBets = me ? (m.bets || []).filter((b) => low(b.nick) === me) : [];
  const mine = {};
  for (const b of myBets) mine[b.option] = (mine[b.option] || 0) + Number(b.amount || 0);
  return {
    ...v, ai: cleanAi(m.ai), ai_judge: !!m.ai_judge,
    inIt: myBets.length > 0, mine: Object.entries(mine).map(([option, amount]) => ({ option, amount })),
    isJudge: !!me && !m.ai_judge && low(m.judge) === me,
  };
}

function register(app, { isBotToken, addUser }) {
  // Pepe pushes wagers here
  app.post("/api/wagers/sync", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    const list = Array.isArray(body.wagers) ? body.wagers.slice(0, 1000) : [];
    try {
      await ready;
      let stored = 0;
      for (const raw of list) {
        const w = cleanWager(raw || {});
        if (!w) continue;
        await runQuery(`INSERT INTO wagers (id, data, status, updated) VALUES (?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, updated = excluded.updated`,
          [w.id, JSON.stringify(w), w.status, Date.now()]);
        stored++;
      }
      await runQuery(`DELETE FROM wagers WHERE status NOT IN ('offered','accepting','active','settling') AND updated < ?`,
        [Date.now() - KEEP_DAYS * 86400000]);
      res.json({ success: true, stored });
    } catch (e) {
      console.error("[wagers] sync:", e);
      res.status(500).json({ success: false });
    }
  });

  app.get("/wagers", addUser, async (req, res) => {
    try {
      await ready;
      let me = null, camfrog = null, bal = null, isAdmin = false, acts = [];
      if (req.user && req.user.userId) {
        const u = (await getQuery("SELECT username, camfrogUsername, class, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
        if (u) {
          camfrog = u.camfrogUsername || null;
          me = camfrog ? low(camfrog) : null;
          bal = Number(u.points_balance) || 0;
          isAdmin = u.class === "Admin";
        }
        acts = await actions.recentFor(req.user.userId, "wagers");
      }
      const now = Date.now() / 1000;
      const ws = (await getQuery("SELECT data FROM wagers ORDER BY id DESC LIMIT 500")).map((r) => viewWager(JSON.parse(r.data), me));
      const offers = ws.filter((w) => w.status === "offered" && w.isOpponent && w.offer_until > now);
      const live = ws.filter((w) => LIVE.has(w.status)).sort((a, b) => (b.inIt - a.inIt) || (a.deadline - b.deadline));
      const doneW = ws.filter((w) => !LIVE.has(w.status) && (w.status === "won" || w.status === "void"))
        .sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 20);

      const ms = (await getQuery("SELECT data FROM markets ORDER BY id DESC LIMIT 300")).map((r) => JSON.parse(r.data))
        .filter((m) => m.model !== "lmsr");
      const pools = ms.filter((m) => POOL_LIVE.has(m.status)).map((m) => viewPool(m, me))
        .sort((a, b) => (b.inIt - a.inIt) || (a.closes - b.closes));
      const doneP = ms.filter((m) => !POOL_LIVE.has(m.status)).map((m) => viewPool(m, me))
        .sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 15);

      res.render("wagers", {
        user: req.user ? req.user.username : null, signedIn: !!(req.user && req.user.userId),
        camfrog, me, bal, isAdmin, now, offers, live, doneW, pools, doneP, acts,
        msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null,
        wagerMin: WAGER_MIN, poolMin: POOL_MIN, feePct: FEE_PCT,
      });
    } catch (e) {
      console.error("[wagers] page:", e);
      res.status(500).send("Couldn't load wagers.");
    }
  });
}

module.exports = { register, cleanAi, viewWager, viewPool };
