// wallet.js — a signed-in user's PAT wallet on PATV (/wallet): stashes, vault stakes, loans, the
// Federal Reserve, and market positions.
//
// Vault staking has its own snapshot and page (staking.js, /staking); the wallet shows a summary and
// each stash's holdings from it. Stashes and loans run in Pepe; he pushes a full snapshot of each here whenever one
// changes (POST /api/wallet/stashes and /api/wallet/loans). We keep only the latest snapshot of each
// (table wallet_snapshots, one row per key). Everything a user does here goes through the website
// action queue (actions.js, POST /act), which Pepe runs as the user's linked Camfrog name.
const { runQuery, getQuery } = require("./dbUtils");
const markets = require("./markets");
const actions = require("./actions");
const staking = require("./staking");
const credit = require("./credit");
const welcome = require("./welcome");

const ready = runQuery(`CREATE TABLE IF NOT EXISTS wallet_snapshots (
  key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)`).catch(() => {});

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v) => Number(v) || 0;
const low = (s) => String(s || "").toLowerCase();
const LOAN_STATUS = new Set(["offered", "accepting", "funding", "active", "repaid", "forgiven", "declined", "cancelled", "expired", "failed"]);
const REQ_STATUS = new Set(["pending", "approving", "approved", "denied"]);

function cleanStashes(body) {
  const stashes = (Array.isArray(body.stashes) ? body.stashes : []).slice(0, 5000).map((s) => ({
    id: s.id == null ? null : str(s.id, 40), name: str(s.name, 20), owner: str(s.owner, 60),
    members: (Array.isArray(s.members) ? s.members : []).slice(0, 50).map((m) => str(m, 60)),
    balance: Math.floor(num(s.balance)), staked: Math.floor(num(s.staked)), earned: Math.floor(num(s.earned)),
    created: num(s.created) || null, closed: num(s.closed) || null,
  })).filter((s) => s.name && s.owner);
  // (the old fee-share `staking` object is no longer stored: vault staking lives in staking.js)
  return { stashes };
}

function cleanLoans(body) {
  const loans = (Array.isArray(body.loans) ? body.loans : []).slice(0, 5000).map((l) => ({
    id: parseInt(l.id, 10) || 0, lender: str(l.lender, 60), borrower: str(l.borrower, 60),
    principal: Math.floor(num(l.principal)), rate: num(l.rate), rate_basis: l.rate_basis === "week" ? "week" : "flat",
    term: num(l.term), owed: Math.floor(num(l.owed)), paid: Math.floor(num(l.paid)), penalty: Math.floor(num(l.penalty)),
    status: LOAN_STATUS.has(l.status) ? l.status : str(l.status, 20), late: !!l.late, reserve: !!l.reserve,
    created: num(l.created) || null, due: num(l.due) || null, ended: num(l.ended) || null, offer_until: num(l.offer_until) || null,
  })).filter((l) => l.id);
  const requests = (Array.isArray(body.requests) ? body.requests : []).slice(0, 2000).map((r) => ({
    id: parseInt(r.id, 10) || 0, nick: str(r.nick, 60), amount: Math.floor(num(r.amount)), term: num(r.term),
    why: str(r.why, 300), status: REQ_STATUS.has(r.status) ? r.status : str(r.status, 20), created: num(r.created) || null,
    by: r.by ? str(r.by, 60) : null, loan: r.loan == null ? null : parseInt(r.loan, 10) || null, deny_why: r.deny_why ? str(r.deny_why, 300) : null,
    // the requester's credit score when they asked (1.99bg)
    credit: Number.isFinite(Number(r.credit)) && r.credit !== null && r.credit !== undefined ? Math.floor(num(r.credit)) : null,
    credit_band: r.credit_band ? str(r.credit_band, 20) : null,
  })).filter((r) => r.id);
  const rv = body.reserve || {};
  const reserve = { rate_week: num(rv.rate_week), max_days: num(rv.max_days), enabled: !!rv.enabled, book: Math.floor(num(rv.book)), room: Math.floor(num(rv.room)),
    base: Math.floor(num(rv.base)), per_level: Math.floor(num(rv.per_level)), max_auto: Math.floor(num(rv.max_auto)),
    max_open: Math.floor(num(rv.max_open)), min: Math.floor(num(rv.min)), limits: {},
    credit: rv.credit && typeof rv.credit === "object" ? credit.cleanWeights(rv.credit) : null };   // 1.99bg score weights
  // per-borrower limit factors (1.99aw); anyone not listed has no Reserve history
  const lim = rv.limits && typeof rv.limits === "object" && !Array.isArray(rv.limits) ? rv.limits : {};
  for (const k of Object.keys(lim).slice(0, 5000)) {
    const f = lim[k] || {};
    reserve.limits[low(k).slice(0, 60)] = { repaid: Math.floor(num(f.repaid)), lates: Math.floor(num(f.lates)), open: Math.floor(num(f.open)),
      late: !!f.late, reason: f.reason ? str(f.reason, 200) : null, credit: f.credit ? credit.cleanHistory(f.credit) : null };
  }
  return { loans, requests, reserve };
}

// A user's instant Federal Reserve borrow limit - Pepe's _rloan_limit (pepe_loan.py), applied to the
// factors he syncs plus the user's level from our own users table (the number his level lookup reads).
//   limit = min(max instant, (base + per level x level) x min(2, 1 + 0.25 x repaid) x 0.5^lates, room), to the 100 below
// Zero with a reason while late on any loan, holding an open Reserve loan, or lending is switched off.
function reserveLimit(reserve, camfrog, level) {
  if (!camfrog) return { state: "nolink" };
  if (!reserve || !reserve.base) return { state: "nodata" };
  if (!reserve.enabled) return { state: "blocked", limit: 0, reason: "Reserve lending is paused right now" };
  const f = (reserve.limits || {})[low(camfrog)] || { repaid: 0, lates: 0, open: 0, late: false, reason: null };
  if (f.reason) return { state: "blocked", limit: 0, reason: f.reason };
  const lv = Math.max(0, Math.floor(num(level)));
  const levelBonus = reserve.per_level * lv;
  const mult = Math.min(2, 1 + 0.25 * f.repaid);
  const penalty = Math.pow(0.5, f.lates);
  const raw = Math.floor((reserve.base + levelBonus) * mult * penalty);
  const room = Math.max(0, reserve.room);
  const limit = Math.max(0, Math.floor(Math.floor(Math.min(reserve.max_auto, (reserve.base + levelBonus) * mult * penalty, room)) / 100) * 100);
  const capped = raw > reserve.max_auto && reserve.max_auto <= room ? "max" : raw > room ? "room" : null;
  const b = { level: lv, base: reserve.base, levelBonus, repaid: f.repaid, mult, lates: f.lates, penalty, raw, maxAuto: reserve.max_auto, room, capped };
  if (limit < Math.max(1, reserve.min || 0)) {
    return { state: "blocked", limit, breakdown: b,
      reason: room < Math.max(1, reserve.min || 0) ? "the Reserve is fully lent out right now - try again later" : "your limit is below the smallest Reserve loan" };
  }
  return { state: "ok", limit, breakdown: b };
}

async function save(key, data) {
  await ready;
  await runQuery(`INSERT INTO wallet_snapshots (key, data, updated) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
    [key, JSON.stringify(data), Date.now()]);
}

async function load(key) {
  await ready;
  const r = (await getQuery("SELECT data, updated FROM wallet_snapshots WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return { ...JSON.parse(r.data), updated: r.updated }; } catch (e) { return null; }
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/wallet/stashes", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      const snap = cleanStashes(body);
      await save("stashes", snap);
      res.json({ success: true, stored: snap.stashes.length });
    } catch (e) {
      console.error("[wallet] stashes sync:", e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/api/wallet/loans", async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      const snap = cleanLoans(body);
      await save("loans", snap);
      res.json({ success: true, stored: snap.loans.length, requests: snap.requests.length });
    } catch (e) {
      console.error("[wallet] loans sync:", e);
      res.status(500).json({ success: false });
    }
  });

  // A borrower's credit score for someone about to lend to them (the P2P form). Signed-in users with
  // a linked Camfrog name only - the same thing !loan check shows in a room. Score, band, top factors.
  app.get("/wallet/credit", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "sign in" });
    const name = String(req.query.u || "").trim().replace(/^@+/, "").slice(0, 60);
    if (!/^[A-Za-z0-9_.\-]{1,60}$/.test(name)) return res.status(400).json({ error: "who?" });
    try {
      const me = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!me || !me.camfrogUsername) return res.status(403).json({ error: "link your Camfrog name first" });
      const row = (await getQuery("SELECT camfrogUsername, level, created_at FROM users WHERE LOWER(camfrogUsername) = LOWER(?) LIMIT 1", [name]))[0];
      if (!row) return res.status(404).json({ error: `${name} has no PATV account yet` });
      const ln = (await load("loans")) || { reserve: null };
      const cs = credit.forCamfrog(ln.reserve || { limits: {} }, row.camfrogUsername, row);
      res.json({ name: row.camfrogUsername, score: cs.score, band: cs.band, top: cs.factors.filter((f) => f.points).slice(0, 3) });
    } catch (e) {
      console.error("[wallet] credit lookup:", e.message);
      res.status(500).json({ error: "couldn't look that up" });
    }
  });

  app.get("/wallet", addUser, async (req, res) => {
    const msg = req.query.msg ? String(req.query.msg).slice(0, 200) : null;
    if (!req.user || !req.user.userId) return res.render("wallet", { user: null, signedIn: false, msg });
    try {
      const u = (await getQuery("SELECT username, camfrogUsername, class, points_balance, level, created_at FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!u) return res.render("wallet", { user: req.user.username, signedIn: false, msg });
      const camfrog = u.camfrogUsername || null;
      const me = camfrog ? low(camfrog) : null;
      const isAdmin = u.class === "Admin";
      const st = (await load("stashes")) || { stashes: [] };
      const sk = await staking.latest(); // vault staking snapshot (staking.js)
      const ln = (await load("loans")) || { loans: [], requests: [], reserve: null };
      const open = (st.stashes || []).filter((s) => !s.closed);

      // stashes I own or belong to; `ref` is how the chat command names it for me
      const myStashes = me ? open.filter((s) => low(s.owner) === me || (s.members || []).some((m) => low(m) === me)).map((s) => {
        const owner = low(s.owner) === me;
        const p = staking.positionFor(sk, s);
        return { ...s, owner_me: owner, ref: owner ? s.name : `${s.owner}/${s.name}`, hold: (p && p.hold) || {}, vaulted: staking.holdValue(p) };
      }).sort((a, b) => (b.owner_me - a.owner_me) || (b.balance - a.balance)) : [];

      const mineLoan = (l) => me && (low(l.borrower) === me || low(l.lender) === me);
      const myLoans = me ? (ln.loans || []).filter(mineLoan).map((l) => ({
        ...l, ref: `L${l.id}`, iBorrow: low(l.borrower) === me, iLend: low(l.lender) === me, left: Math.max(0, l.owed - l.paid),
      })) : [];
      const OPEN = new Set(["offered", "accepting", "funding", "active"]);
      const borrowed = myLoans.filter((l) => l.iBorrow && OPEN.has(l.status)).sort((a, b) => (a.due || 0) - (b.due || 0));
      const lent = myLoans.filter((l) => l.iLend && OPEN.has(l.status)).sort((a, b) => (a.due || 0) - (b.due || 0));
      const loanHistory = myLoans.filter((l) => !OPEN.has(l.status)).sort((a, b) => (b.ended || b.created || 0) - (a.ended || a.created || 0)).slice(0, 20);
      const myRequests = me ? (ln.requests || []).filter((r) => low(r.nick) === me).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 10) : [];

      // LMSR market positions
      // 1.99do: a paid-out market is never an open position (its value is 0 or already paid); the last
      // 30 days of those go in a separate "settled" table with what each row paid
      let positions = [], settledPositions = [];
      if (me) {
        const rows = await getQuery("SELECT data FROM markets WHERE status IN ('open','closed','settling','settled','resolved','void') ORDER BY id DESC LIMIT 300");
        const since = Date.now() / 1000 - 30 * 86400;
        for (const r of rows) {
          let m;
          try { m = JSON.parse(r.data); } catch (e) { continue; }
          if (m.model !== "lmsr" || !(m.positions || {})[me]) continue;
          const v = markets.view(m, [camfrog]);
          if (!v.mine || !v.mine.length) continue;
          const row = { id: m.id, ref: v.ref, question: m.question, status: m.status, closes: m.closes, mine: v.mine, settle: v.settle };
          if (!v.settle && ["open", "closed", "settling"].includes(m.status)) positions.push(row);
          else if (v.settle && (m.ended || (m.paid_out || {}).at || 0) >= since) settledPositions.push(row);
        }
      }

      let admin = null;
      if (isAdmin) {
        // requesters' credit scores, live (level + account age from users)
        const pend = (ln.requests || []).filter((r) => r.status === "pending" || r.status === "approving");
        const names = [...new Set(pend.map((r) => low(r.nick)))].slice(0, 200);
        const rows = names.length ? await getQuery(`SELECT LOWER(camfrogUsername) AS c, level, created_at FROM users WHERE LOWER(camfrogUsername) IN (${names.map(() => "?").join(",")})`, names) : [];
        const byName = Object.fromEntries(rows.map((r) => [r.c, r]));
        for (const r of pend) r.creditLive = credit.forCamfrog(ln.reserve || { limits: {} }, r.nick, byName[low(r.nick)] || null);
        const all = open.slice().sort((a, b) => b.balance - a.balance).map((s) => {
          const p = staking.positionFor(sk, s);
          return { ...s, hold: (p && p.hold) || {}, vaulted: staking.holdValue(p) };
        });
        admin = {
          stashes: all,
          totals: all.reduce((t, s) => ({ balance: t.balance + s.balance, vaulted: t.vaulted + s.vaulted }), { balance: 0, vaulted: 0 }),
          pending: (ln.requests || []).filter((r) => r.status === "pending" || r.status === "approving").sort((a, b) => (a.created || 0) - (b.created || 0)),
          reserveLoans: (ln.loans || []).filter((l) => l.reserve && OPEN.has(l.status)).map((l) => ({ ...l, ref: `L${l.id}`, left: Math.max(0, l.owed - l.paid) }))
            .sort((a, b) => (a.due || 0) - (b.due || 0)),
        };
      }

      res.render("wallet", {
        user: u.username, signedIn: true, msg, camfrog, isAdmin, now: Date.now() / 1000,
        bal: Number(u.points_balance) || 0, myStashes, vaults: sk || null, stashesUpdated: st.updated || null,
        borrowed, lent, loanHistory, myRequests, reserve: ln.reserve ? { ...ln.reserve, limits: undefined } : null, positions, settledPositions, admin,
        myLimit: reserveLimit(ln.reserve || null, camfrog, u.level), // only ever the signed-in user's own
        myCredit: camfrog ? credit.forCamfrog(ln.reserve || { limits: {} }, camfrog, u) : null,
        welcomeStatus: await welcome.status(req.user.userId).catch(() => null),
        acts: await actions.recentFor(req.user.userId, "wallet"),
      });
    } catch (e) {
      console.error("[wallet] page:", e);
      res.status(500).send("Couldn't load your wallet.");
    }
  });
}

module.exports = { register, cleanStashes, cleanLoans, reserveLimit };
