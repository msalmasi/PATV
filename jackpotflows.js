// jackpotflows.js — the House's (casino jackpot's) site-side flows, per day, for Pepe's vault flow table (1.99gx).
//
// The House is SUM(jackpot_rakes.amount). Pepe logs every jackpot movement HE makes (POST
// /api/g/heist/jackpot-adjust), but the wheel's stakes and prizes - and a few other site flows - happen here,
// so his table used to show them only as a small "Website" residual (change minus his own net). This sums
// the rakes per America/New_York day (the day Pepe's ledger uses, pepe_vaultlog._vl_day) by what made them:
//
//   wheel_spins row (spinId joins):  first + row of a spin = its stake ("wheel spins"); a later + row = a
//                                    jackpot reseed from the Reserve (v1 wheelReseed); a - row = a prize
//                                    ("wheel prizes": regular slices via funding.wheelDraw and the jackpot
//                                    slice), or a refund when the spin FAILED
//   spinId "bj:..." / NULL           the website's blackjack table (wager in, payout out). Untagged NULL rows
//                                    are older blackjack rows - or, out only, a funded reward (below)
//   spinId "fund:<flow>"             a reward the PAT Routing table sends to the House (funding.takeFunds)
//   spinId "shop-order:<id>"         official store boosts (shop.js)
//   spinId "admin:..."               an admin's manual adjustment (/api/g/wheel/jackpot)
//   spinId "bot:..."                 Pepe's own adjustments - he has them already: reported apart, never itemised
//   any other spinId                 untagged (before 1.99gx: Pepe's adjustments and admin ones looked alike)
//
// open/close are the House's balance at the day's NY midnights, so Pepe's "Website" column (the change minus
// every itemised flow) is what's really unexplained - ~0, unless an untracked flow appears.
"use strict";
const { getQuery } = require("./dbUtils");

const TZ = "America/New_York";
const MAX_DAYS = 92;
const LOOKBACK_MS = 2 * 3600 * 1000;    // a reseed's spin may have been staked just before the range
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function nyDay(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
// the UTC instant (ms) of 00:00 New York time on `day` (04:00 UTC in summer, 05:00 in winter)
function nyMidnight(day) {
  const [y, m, d] = day.split("-").map(Number);
  for (const h of [4, 5, 3, 6]) {
    const t = Date.UTC(y, m - 1, d, h);
    if (nyDay(t) === day && nyDay(t - 1) !== day) return t;
  }
  return Date.UTC(y, m - 1, d, 5);
}
function nextDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
// SQLite CURRENT_TIMESTAMP text (UTC) <-> ms
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const tsMs = (s) => Date.parse(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? "" : "Z"));

// -> {kind: "site"|"bot"|"untagged", dir: "in"|"out", name}
function classify(r, staked) {
  const amt = Number(r.amount) || 0;
  const dir = amt > 0 ? "in" : "out";
  const sid = r.spinId == null ? null : String(r.spinId);
  if (r.wsid) {
    if (amt > 0) {
      if (!staked.has(sid)) { staked.add(sid); return { kind: "site", dir, name: "wheel spins", stake: true }; }
      return { kind: "site", dir, name: "wheel reseeds" };
    }
    return { kind: "site", dir, name: r.wres === "FAILED" ? "wheel refunds" : "wheel prizes" };
  }
  if (sid === null) return { kind: "site", dir, name: amt > 0 ? "web blackjack" : "web blackjack / rewards" };
  if (sid.startsWith("bj:")) return { kind: "site", dir, name: "web blackjack" };
  if (sid.startsWith("fund:")) return { kind: "site", dir, name: "funded: " + (sid.slice(5).split(":")[0] || "reward") };
  if (sid.startsWith("shop-order:")) return { kind: "site", dir, name: "store boosts" };
  if (sid.startsWith("admin:")) return { kind: "site", dir, name: "admin (website)" };
  if (sid.startsWith("bot:")) return { kind: "bot", dir };
  return { kind: "untagged", dir };
}

// Per NY day from..to (inclusive): {day, open, close, spins, in: {name: PAT}, out: {name: PAT}, bot, untagged}
async function summary(from, to) {
  if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to)) || from > to) throw new Error("bad range");
  const days = [];
  for (let d = from; d <= to && days.length <= MAX_DAYS; d = nextDay(d)) days.push(d);
  if (days.length > MAX_DAYS) throw new Error("range too long");
  const start = nyMidnight(from), end = nyMidnight(nextDay(to));
  const base = Number((await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM jackpot_rakes WHERE timestamp < ?",
                                      [sqlTs(start)]))[0].t) || 0;
  const rows = await getQuery(
    `SELECT j.spinId AS spinId, j.amount AS amount, j.timestamp AS ts, w.spinId AS wsid, w.result AS wres
       FROM jackpot_rakes j LEFT JOIN wheel_spins w ON w.spinId = j.spinId
      WHERE j.timestamp >= ? AND j.timestamp < ? ORDER BY j.rowid`, [sqlTs(start - LOOKBACK_MS), sqlTs(end)]);
  const out = {};
  for (const d of days) out[d] = { day: d, open: null, close: null, spins: 0, in: {}, out: {}, bot: { in: 0, out: 0 }, untagged: { in: 0, out: 0 } };
  const staked = new Set();
  const net = {};
  for (const r of rows) {
    const ms = tsMs(r.ts);
    const c = classify(r, staked);
    if (!(ms >= start)) continue;          // lookback rows: only for telling a stake from a reseed
    const d = nyDay(ms);
    if (!out[d]) continue;
    const amt = Number(r.amount) || 0;
    net[d] = (net[d] || 0) + amt;
    const row = out[d];
    if (c.kind === "site") {
      row[c.dir][c.name] = (row[c.dir][c.name] || 0) + Math.abs(amt);
      if (c.stake) row.spins += 1;
    } else {
      row[c.kind][c.dir] += Math.abs(amt);
    }
  }
  let bal = base;
  for (const d of days) {
    out[d].open = bal;
    bal += net[d] || 0;
    out[d].close = bal;
  }
  return days.map((d) => out[d]);
}

function register(app, { isBotToken }) {
  // POST {password: <bot token>, from, to} (NY days, YYYY-MM-DD)
  app.post("/api/g/vault/jackpot-flows", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const to = DAY_RE.test(String(b.to || "")) ? b.to : nyDay(Date.now());
      const from = DAY_RE.test(String(b.from || "")) ? b.from : to;
      res.json({ ok: true, tz: TZ, from, to, days: await summary(from, to) });
    } catch (e) {
      res.status(/range/.test(e.message) ? 400 : 500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { register, summary, classify, nyDay, nyMidnight, nextDay, TZ };
