// markets.js — Pepe's prediction markets on PATV.
//
// The markets themselves (bets, escrow, settlement) ran in Pepe; he pushed a snapshot of every market here whenever one
// changed (and on a heartbeat). Phase 2 moved the betting pools to escrow/pools.js, Phase 3 the LMSR share markets to
// capital/markets.js - each engine writes its own rows here, so the pages read the same table either way. This module stores those snapshots
// and renders /markets and /markets/:id. Parimutuel maths mirrors pepe_market.py: winners split the
// losing pool minus the fee, pro rata to their stake.
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");
const PATAmount = require("./public/js/patamount");     // 1.99nk: "1,000,000" / "5k" (Pepe's rules)

// Pepe as judge (1.90): keep just the display fields of his ruling
function cleanPrice(p) {
  if (!p || typeof p !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return { source: p.source ? String(p.source).slice(0, 40) : null, symbol: String(p.symbol || "").slice(0, 12),
           target: n(p.target), direction: String(p.direction || "").slice(0, 8), mode: String(p.mode || "").slice(0, 8),
           used: String(p.used || "").slice(0, 8), gran: n(p.gran), candles: n(p.candles), covered: !!p.covered,
           high: n(p.high), high_at: n(p.high_at), low: n(p.low), low_at: n(p.low_at), last: n(p.last),
           start: n(p.start), end: n(p.end), cov_start: n(p.cov_start), cov_end: n(p.cov_end) };
}
function cleanResettle(r) {
  if (!r || typeof r !== "object") return null;
  const n = (v) => Math.floor(Number(v) || 0);
  const rows = (a) => (Array.isArray(a) ? a : []).slice(0, 50).map((x) => ({ nick: String((x && x.nick) || "").slice(0, 60), amount: n(x && x.amount) }));
  return { at: Number(r.at) || 0, by: String(r.by || "").slice(0, 60), from: String(r.from || "").slice(0, 60), to: String(r.to || "").slice(0, 60),
           reason: String(r.reason || "").slice(0, 240), clawback: rows(r.clawback), payouts: rows(r.payouts), paid: n(r.paid),
           funder: String(r.funder || "").slice(0, 20), funder_back: n(r.funder_back), leftover: n(r.leftover) };
}
function cleanAi(ai) {
  if (!ai || typeof ai !== "object") return null;
  return { state: String(ai.state || ""), result: ai.result == null ? null : String(ai.result).slice(0, 60),
           confidence: Number(ai.confidence) || 0, reason: String(ai.reason || "").slice(0, 240),
           until: Number(ai.until) || 0,
           // 1.99dh: when Pepe looks again, whether he handed it to the admins, the price data he used
           next_try: Number(ai.next_try) || 0, escalated: Number(ai.escalated) || 0, tries: Number(ai.tries) || 0,
           evidence: String(ai.evidence || "").slice(0, 320),
           // 1.99jx: when Pepe ruled, and his exchange price check (M49) as numbers for the judgement section
           at: Number(ai.at) || 0, price: cleanPrice(ai.price), price_unread: !!ai.price_unread,
           disputes: (ai.disputes || []).slice(0, 30).map((d) => ({ nick: String(d.nick || "").slice(0, 60), why: String(d.why || "").slice(0, 160) })) };
}

/** An IANA zone name ("America/New_York", "UTC") the runtime knows, else null. */
function cleanTz(z) {
  const s = String(z || "").trim();
  if (!s || s.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(s)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch (e) { return null; }
}

/**
 * 1.99ur: the extra words a website create form adds to "!market new ..." / "!pool new ...": pad:<pad id> (the pad picker),
 * until:<unix seconds> (a picked close date/time) and tz:<IANA zone> (the creator's zone, shown with the close). Pepe's
 * parser (pepe_market._market_create) reads the same words. -> {text (without them), pad, until, tz}
 */
function createTokens(text) {
  let t = String(text || "");
  const out = { pad: null, until: null, tz: null };
  t = t.replace(/(^|\s)pad:(\S{1,128})(?=\s|$)/gi, (all, sp, v) => { out.pad = /^none$/i.test(v) ? "" : v; return sp; });
  t = t.replace(/(^|\s)until:(\d{9,11})(?=\s|$)/gi, (all, sp, v) => { out.until = Number(v); return sp; });
  t = t.replace(/(^|\s)tz:(\S{1,64})(?=\s|$)/gi, (all, sp, v) => { out.tz = cleanTz(v); return sp; });
  out.text = t.replace(/\s+/g, " ").trim();
  return out;
}

// 1.99th: Pepe's auto markets (camfrog-bot pepe_automkt.py) - what he made it from and how it settles: the 🤖 auto tag,
// the exact criteria, the source link, the resolution time. spec is what Pepe needs to settle it (ESPN event, price level).
const AUTO_CATS = new Set(["sports", "prices", "news", "trending"]);   // 1.99ur: trending = ideas from Polymarket's trending list, our own wording
const AUTO_RESOLVERS = new Set(["sports", "price", "ai"]);
function cleanAuto(a) {
  if (!a || typeof a !== "object" || !AUTO_CATS.has(String(a.cat))) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
  const url = String(a.source_url || "");
  let spec = a.spec && typeof a.spec === "object" ? a.spec : {};
  try { if (JSON.stringify(spec).length > 2000) spec = {}; spec = JSON.parse(JSON.stringify(spec)); } catch (e) { spec = {}; }
  return { v: 1, id: String(a.id || "").slice(0, 16), cat: String(a.cat), tag: String(a.tag || "").slice(0, 40),
           resolver: AUTO_RESOLVERS.has(String(a.resolver)) ? String(a.resolver) : "ai",
           criteria: String(a.criteria || "").slice(0, 600), source_url: /^https:\/\/[^\s"'<>]{4,300}$/.test(url) ? url : null,
           source_name: String(a.source_name || "").slice(0, 40), starts: n(a.starts), resolve_at: n(a.resolve_at), spec };
}

const ready = runQuery(`CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, closes INTEGER, updated INTEGER)`).catch(() => {})
  // 1.99ur: the pad a market / pool belongs to (padlinks.js) - a column, so a mirror write never loses it and a pad re-key moves it
  .then(() => runQuery("ALTER TABLE markets ADD COLUMN pad TEXT").catch(() => {}))
  .then(() => runQuery("CREATE INDEX IF NOT EXISTS markets_pad ON markets (pad)").catch(() => {}));
const padlinks = require("./padlinks");

/**
 * Store one display row (Pepe's snapshot, capital/markets.js and escrow/pools.js all write through here). The pad column is
 * set from the record the first time it resolves and never overwritten after (padlinks.js).
 */
async function storeRow(clean) {
  if (!clean || !clean.id) return;
  await ready;
  let pad = null;
  try { pad = padlinks.resolve(clean); } catch (e) { pad = null; }
  await runQuery(`INSERT INTO markets (id, data, status, closes, updated, pad) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, closes = excluded.closes,
                  updated = excluded.updated, pad = COALESCE(markets.pad, excluded.pad)`,
                 [clean.id, JSON.stringify(clean), clean.status, clean.closes, Date.now(), pad]);
}

// Website bets (orders). The PAT moves in Pepe (escrow): he claims pending orders every few
// seconds, places each through the same checks as a chat bet, and acks the result. A bet carries its
// order id, so an order claimed twice (Pepe restarted mid-way) is never placed twice.
// 1.99ou Phase 2: while the parimutuel POOLS run on the site (escrow/pools.js, `live:pools`), a pool bet / a judge's call
// from /markets/:id runs on that engine at once and is never queued; only the LMSR share markets (still Pepe's until
// Phase 3) keep using this queue. A pool order queued before the cutover is placed by Pepe on the engine (keyed by its id).
const ordersReady = runQuery(`CREATE TABLE IF NOT EXISTS market_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  username TEXT NOT NULL, camfrog TEXT, option TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`).catch(() => {});
for (const col of ["kind TEXT DEFAULT 'buy'", "shares TEXT", "outcome TEXT", "site_admin INTEGER DEFAULT 0"]) {
  ordersReady.then(() => runQuery(`ALTER TABLE market_orders ADD COLUMN ${col}`)).catch(() => {});
}
const ttl = require("./actionttl");     // 1.99ne: queued orders expire
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
  if (settle) Object.assign(settle, settleDetail(m, settle));
  // 1.99dy: the viewer's settled position in one line (payout across all their rows, net P/L)
  let myResult = null;
  if (settle && mine && mine.length) {
    const payout = mine.reduce((a, r) => a + (r.payout || 0), 0), cost = mine.reduce((a, r) => a + (r.cost || 0), 0);
    myResult = { state: settle.kind === "void" ? "refunded" : payout > 0 ? "won" : "lost", payout, cost, pnl: payout - cost,
                 rows: mine.map((r) => ({ option: r.option, shares: r.shares, payout: r.payout || 0, state: r.state })) };
  }
  return { ...m, ref: `M${m.id}`, shares: true, options, total: m.volume || 0, bettors: holders.size, settle, myResult,
           betCount: (m.trades || []).length, mine, history: m.history || [], trades: (m.trades || []).slice().reverse() };
}

// 1.99dy: the settlement as an event: when, who judged it (Pepe's AI ruling or a person), his reasoning,
// and each holder's payout. Pepe's sync carries only paid_out {at, total, result}, not the payout list,
// so the per-holder amounts are rebuilt from the positions the way pepe_amm._amm_resolve pays them:
// a win pays int(winning shares) (winners are always covered, never scaled); a void refunds
// int(cost x 0.98 x ratio) - exact when the pot covered everyone, approximate (approx) when scaled.
function settleDetail(m, settle) {
  const po = m.paid_out && typeof m.paid_out === "object" ? m.paid_out : null;
  const ai = m.ai || null;
  const res = settle.kind === "won" ? settle.result : null;
  const byAi = !m.resettle && !!(m.ai_judge && ai && ai.state === "final"
                  && (settle.kind === "void" ? /^void/i.test(String(ai.result || "")) : ai.result === res));
  const keep = 1 - AMM_FEE_PCT / 100;
  const payouts = [];
  for (const p of Object.values(m.positions || {})) {
    if (settle.kind === "won") {
      const sh = Number((p.shares || {})[res]) || 0;
      if (sh >= 1) payouts.push({ nick: p.nick, option: res, shares: sh, amount: Math.floor(sh) });
    } else {
      const c = Object.values(p.cost || {}).reduce((a, v) => a + (Number(v) || 0), 0) * keep;
      const amt = Math.floor(c * settle.ratio);
      if (c >= 1 && amt > 0) payouts.push({ nick: p.nick, option: null, shares: null, amount: amt });
    }
  }
  payouts.sort((a, b) => b.amount - a.amount);
  return {
    at: (po && po.at) || m.ended || 0, by: m.settled_by || null, byAi,
    why: byAi ? ai.reason || "" : "", evidence: byAi ? ai.evidence || "" : "", confidence: byAi ? ai.confidence || 0 : 0,
    resettle: m.resettle || null,
    payouts, winners: payouts.length, approx: settle.kind === "void" && settle.ratio < 1,
    paid: settle.total != null ? settle.total : payouts.reduce((a, p) => a + p.amount, 0),
  };
}

// 1.99dy: a price per share with enough digits to mean something: 0.822 -> "0.822", 0.00415 -> "0.00415",
// 4.37e-7 -> "4.37e-7"; 1 -> "1.000", 0 -> "0"
function fmtPrice(x) {
  x = Number(x);
  if (!Number.isFinite(x)) return "";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 0.1) return x.toFixed(3);
  if (a >= 1e-6) return String(Number(x.toPrecision(3)));
  return x.toPrecision(3);
}

// Pepe writes order replies like "bought 2,409,135 Yes shares for 10,000 PAT (avg 0.00)": a tiny average
// rounds to 0.00 in chat. Re-derive it from the numbers in the same line.
function fixOrderMessage(msg) {
  return String(msg || "").replace(/\b((?:bought|sold) ([\d,]+(?:\.\d+)?) .*? shares for ([\d,]+) PAT[^(]*)\(avg ([\d.]+)\)/i,
    (all, head, sh, pat, avg) => {
      const s = Number(sh.replace(/,/g, "")), p = Number(pat.replace(/,/g, ""));
      return s > 0 && Number(avg) < 0.1 ? `${head}(avg ${fmtPrice(p / s)})` : all;
    });
}

// "Ask Pepe to decide" replies are only the interim "🤖 looking into M27…" (his ruling lands on the market
// itself, later). Once the market is settled, point the newest of those at the result and drop the rest.
function settledActs(acts, v) {
  if (!v || !v.settle || !Array.isArray(acts)) return acts;
  const interim = (a) => a.status === "done" && /^\W*looking into M\d+/i.test(String(a.message || ""));
  const result = v.settle.kind === "void" ? "voided" : "settled " + v.settle.result;
  let seen = false;
  return acts.filter((a) => {
    if (!interim(a)) return true;
    if (seen) return false;
    seen = true;
    return true;
  }).map((a) => (interim(a) ? { ...a, message: `Pepe has ruled: ${result} — see the result at the top of this page.` } : a));
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

/** A market row as the /markets and /wagers pages store it (Pepe's snapshot shape; escrow/pools.js mirrors its pools through it). */
function cleanMarket(m) {
  const id = parseInt(m && m.id, 10);
  if (!id) return null;
  const clean = {
    id, question: String(m.question || "").slice(0, 200), options: (m.options || []).map((o) => String(o).slice(0, 30)).slice(0, 6),
    creator: m.creator || "", judge: m.judge || "", room: m.room || "", status: m.status || "open",
    // 1.99ur: the pad it was made for (padlinks.js) and, for a custom close, the creator's time zone (shown with the close)
    ...(m.pad ? { pad: String(m.pad).slice(0, 128) } : {}),
    ...(cleanTz(m.tz) ? { tz: cleanTz(m.tz) } : {}),
    created: Number(m.created) || 0, closes: Number(m.closes) || 0, result: m.result || null,
    settled_by: m.settled_by || null, fee: Number(m.fee) || 0, ended: Number(m.ended) || null,
    ai_judge: !!m.ai_judge, ai: cleanAi(m.ai), ...(m.model === "pool" ? { model: "pool" } : {}),
    ...(cleanAuto(m.auto) ? { auto: cleanAuto(m.auto) } : {}),
    // 1.99do: Pepe's payout stamp (a share market is paid once this is set) + why it was voided
    paid_out: m.paid_out && typeof m.paid_out === "object"
      ? { at: Number(m.paid_out.at) || 0, total: Math.floor(Number(m.paid_out.total) || 0), result: String(m.paid_out.result || "").slice(0, 200) } : null,
    void_reason: m.void_reason ? String(m.void_reason).slice(0, 200) : null,
    // 1.99ka: an admin re-settle (pepe_mktresettle): who, when, from -> to, why, and the PAT it moved
    resettle: cleanResettle(m.resettle),
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
  return clean;
}

/** Phase 3: the LMSR share markets run on the site (capital/markets.js live): their rows here are the engine's, not Pepe's. */
async function capitalLive() {
  try { return await require("./capital/core").live(); } catch (e) { return false; }
}

/** The parimutuel pools run on the site (escrow/pools.js live): their rows here are the engine's, not Pepe's. */
async function poolsOnSite() {
  try { return await require("./escrow/games").gameLive("pools"); } catch (e) { return false; }
}

/** 1.99ur: is this market / pool voided (or cancelled)? The lists hide those unless asked. */
function isVoided(m) {
  return (m.settle && m.settle.kind === "void") || m.status === "void" || m.status === "cancelled" || /^void\b/i.test(String(m.result || ""));
}

/**
 * 1.99ur: the rows a list page shows, with each one's pad: m.padId (the pad column, else resolved from the record; null =
 * site-wide) and m.padv ({id, slug, title, url} | null). Rows on a pad the viewer can't see are left out. ?pad= filters,
 * ?void=1 shows the voided ones. -> {rows, filter: {pad, padTitle, slug, pads: [{slug, title, n}], showVoid, voided}}
 */
async function listRows(req, { keep = () => true, limit = 1000 } = {}) {
  await ready;
  await padlinks.ready();
  const PA = require("./padaccess");
  try { await PA.init(); } catch (e) { /* the gate's own problem */ }
  const want = padlinks.fromParam(req.query.pad);              // null = every pad, "" = site-wide, else a pad id
  const showVoid = /^(1|true|yes|on)$/i.test(String(req.query.void || ""));
  let rows = (await getQuery("SELECT data, pad FROM markets ORDER BY id DESC LIMIT ?", [limit])).map((r) => {
    const d = JSON.parse(r.data);
    const v = view(d);
    v.padId = r.pad || padlinks.resolve(d) || null;
    v.padv = padlinks.view(v.padId);
    Object.defineProperty(v, "raw", { value: d, enumerable: false });     // the stored record (wagers.viewPool wants it)
    return v;
  }).filter(keep).filter((m) => !m.padId || PA.canSee(req.user || null, m.padId));
  const counts = new Map();
  for (const m of rows) { const k = m.padv ? m.padv.slug : "none"; counts.set(k, { slug: k, title: m.padv ? m.padv.title : null, n: ((counts.get(k) || {}).n || 0) + 1 }); }
  if (want !== null) rows = rows.filter((m) => (m.padId || "") === want);
  const voided = rows.filter(isVoided).length;
  if (!showVoid) rows = rows.filter((m) => !isVoided(m));
  const pv = want ? padlinks.view(want) : null;
  if (pv && !counts.has(pv.slug)) counts.set(pv.slug, { slug: pv.slug, title: pv.title, n: 0 });
  const pads = [...counts.values()].sort((a, b) => (a.slug === "none") - (b.slug === "none") || String(a.title).localeCompare(String(b.title)));
  return { rows, filter: { pad: want, slug: want === "" ? "none" : pv ? pv.slug : "", padTitle: pv ? pv.title : null, padUrl: pv ? pv.url : null,
                           pads, showVoid, voided } };
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
      const poolsLive = await poolsOnSite();
      // Phase 3: with the capital cluster on the site (capital/markets.js) the LMSR rows are the engine's - Pepe's are his mirror
      const capLive = await capitalLive();
      for (const m of list) {
        if (capLive && m && m.model === "lmsr") continue;
        // 1.99ou Phase 2: while the betting pools run on the site (escrow/pools.js) their rows are the site's - Pepe's
        // snapshot carries only his LMSR markets then, and a stale pool row from him never overwrites the engine's
        if (poolsLive && (!m || m.model !== "lmsr")) continue;
        const clean = cleanMarket(m);
        if (!clean) continue;
        const id = clean.id;
        if (poolsLive) {
          // an id the site's pool engine owns is never overwritten by an LMSR row (the ids come from its reserve_id)
          const was = (await getQuery("SELECT data FROM markets WHERE id = ?", [id]))[0];
          let wm = null;
          try { wm = was ? JSON.parse(was.data) : null; } catch (e) { wm = null; }
          if (wm && wm.model !== "lmsr") { console.error(`[markets] sync: M${id} is a site pool - Pepe's LMSR row for it ignored`); continue; }
        }
        await storeRow(clean);
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
      if (m.model === "lmsr" && (await capitalLive())) {
        // Phase 3: the share markets run on the site (capital/markets.js) - the buy happens now, nothing is queued for Pepe
        return back(await require("./capital/markets").webAct(req.user.userId, "bet", id,
          { option: String((req.body || {}).option || ""), amount: PATAmount.parse((req.body || {}).amount) || 0, idem: (req.body || {}).idem }));
      }
      if (m.model !== "lmsr") {
        // 1.99ou Phase 2: a pool bet with the pools on the site runs on the engine now (escrow/pools.js) - nothing is queued
        const msg = await require("./escrow/games").fromForm(req.user.userId, "pool", [`M${id}`, String((req.body || {}).option || ""),
                                                                                      String((req.body || {}).amount || "")], null);
        if (msg) return back(msg);
      }
      if (m.status !== "open" || m.closes * 1000 < Date.now()) return back("Betting on this market is closed.");
      const option = String((req.body || {}).option || "");
      if (!(m.options || []).includes(option)) return back("Pick one of the options.");
      const amount = PATAmount.parse((req.body || {}).amount) || 0;
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
      if (m.model === "lmsr" && (await capitalLive())) {
        // Phase 3: the share markets run on the site (capital/markets.js) - a sale / the judge's call happens now
        return back(await require("./capital/markets").webAct(req.user.userId, fields.kind, id, fields));
      }
      if (fields.kind === "resolve" && m.model !== "lmsr") {
        // 1.99ou Phase 2: the judge's call on a pool runs on the site engine when the pools live there (null = they don't)
        const msg = await require("./escrow/games").fromForm(req.user.userId, "pool", ["settle", `M${id}`, ...String(fields.outcome || "").split(" ")], null);
        if (msg) return back(msg);
      }
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
    // 1.99ne: overdue pending orders expire first (actionttl.js) - a bet is never placed at a price hours later
    await ttl.sweepTable("market_orders").catch((e) => console.error("[markets] ttl sweep:", e.message));
    const now = Date.now();
    const found = await getQuery(`SELECT * FROM market_orders WHERE status = 'pending' OR (status = 'claimed' AND claimed < ?)
                                 ORDER BY id LIMIT 20`, [now - RECLAIM_MS]);
    const rows = [];
    for (const o of found) {
      const r = await runQuery(`UPDATE market_orders SET status = 'claimed', claimed = ?, updated = ?
                                WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed < ?))`, [now, now, o.id, now - RECLAIM_MS]);
      if (r && r.changes === 1) rows.push(o);
    }
    res.json({ orders: rows.map((o) => ({ id: o.id, market_id: o.market_id, username: o.username, camfrog: o.camfrog,
                                          option: o.option, amount: o.amount, kind: o.kind || "buy", shares: o.shares,
                                          outcome: o.outcome, site_admin: !!o.site_admin,
                                          created: o.created || null, expires_at: ttl.expiresAt("market_orders", o) })) });
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
    // 1.99ur: ?pad=<slug|none> filters by pad; voided markets are hidden unless ?void=1 (the list's toggle)
    const L = await listRows(req, { keep: (m) => m.shares || m.auto });   // 1.99th: + Pepe's auto pools (sports winners)
    const live = L.rows.filter((m) => LIVE.has(m.status) && !m.settle).sort((a, b) => a.closes - b.closes);
    const done = L.rows.filter((m) => !LIVE.has(m.status) || m.settle).sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 40);
    let linked = false, acts = [];
    if (req.user && req.user.userId) {
      const u = await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]);
      linked = !!(u[0] && u[0].camfrogUsername);
      acts = await actions.recentFor(req.user.userId, "markets");
    }
    res.render("markets", { user: req.user ? req.user.username : null, live, done, now: Date.now() / 1000, linked, acts,
                            filter: L.filter, pick: await padlinks.choicesFor(req.user, req.query.pad), bounds: await require("./mktcfg").get(),
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
    const v = view(JSON.parse(rows[0].data), me);
    // 1.99ur: the pad it belongs to (the pad column, else resolved from its record)
    await padlinks.ready();
    const prow = (await getQuery("SELECT pad FROM markets WHERE id = ?", [id]))[0];
    v.padId = (prow && prow.pad) || padlinks.resolve(v) || null;
    v.padv = padlinks.view(v.padId);
    if (v.padId) {
      const PA = require("./padaccess");
      try { await PA.init(); } catch (e) { /* the gate's own problem */ }
      if (!PA.canSee(req.user || null, v.padId)) return res.status(404).render("market", { user: req.user ? req.user.username : null, m: null, now: Date.now() / 1000, orders: [], msg: null, bal: null });
    }
    acts = settledActs(acts, v);
    orders = orders.map((o) => ({ ...o, message: o.message ? fixOrderMessage(o.message) : o.message }));
    res.render("market", { user: req.user ? req.user.username : null, m: v, now: Date.now() / 1000, judgeMe, acts, inIt, fmtPrice,
                           orders, msg: req.query.msg ? String(req.query.msg).slice(0, 200) : null, bal, minBet: MIN_BET });
  });
}

module.exports = { register, storeRow, cleanTz, createTokens, listRows, isVoided, view, settlement, lmsrPrices, fmtPrice, fixOrderMessage, settledActs, cleanMarket, cleanAi, cleanAuto };
