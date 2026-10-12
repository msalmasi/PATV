// capital/markets.js — Phase 3: Pepe's LMSR share markets (pepe_market.py + pepe_amm.py) owned by the site.
//
// Same rules, same numbers (the maths is capital/lmsr.js, replayed bit for bit against the Python): a share pays 1 PAT if its
// option wins; buys and sells pay AMM_FEE_PCT (2%); the pot is a pools row "market:<id>" (seeded from the Market maker vault,
// or the Federal Reserve when the vaults aren't live / for markets seeded before 1.92); the fee follows the seed (Market
// maker -> "mm", else Pepe's "market_fee" routing); a resolution pays 1 PAT per winning share and the rest of the pot goes
// back to the funder; a VOID gives the funder its seed first and holders split what's left up to what they put in net of
// fees (1.90a). Every action is ONE transaction: the market record, the wallet row, the pot / vault legs and the event.
//
// Pepe stays the chat client: he parses !market, makes one keyed call (POST /api/capital/bot/op) and announces from the
// answer / the event stream; his AI judge (Phase 5 moves it) keeps its state on his mirror and puts it here (ai_put); the
// judge's call comes back as a settle. The website's forms (/markets/:id/bet|sell|resolve) call this engine directly.
"use strict";
const C = require("./core");
const X = require("./lmsr");

const KIND = "market";
const LIVE = ["open", "closed", "settling"];
const VOID_WORDS = new Set(["void", "cancel", "cancelled", "refund", "nobody", "none", "draw"]);
const DUP_SECS = 120;
const ref = (m) => `M${m.id}`;
const potKey = (id) => `market:${id}`;
const fmt = C.fmt;

function matchOption(m, word) {
  const w = String(word || "").trim().toLowerCase();
  for (const o of m.options) if (o.toLowerCase() === w) return o;
  const starts = w ? m.options.filter((o) => o.toLowerCase().startsWith(w)) : [];
  return starts.length === 1 ? starts[0] : null;
}
function parseRef(t) {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  const n = s.startsWith("M") ? s.slice(1) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}
const isJudge = (actor, m) => C.same(actor.login, m.judge) || C.same(actor.username, m.judge);
const deadline = (m) => (m.status === "open" ? Number(m.closes) : m.status === "closed" ? Number(m.closes) + Number(m._grace || 0) : null);

/** The display row (/markets reads the `markets` table) - Pepe's snapshot shape. */
async function mirror(m) {
  const clean = require("../markets").cleanMarket(m);
  if (!clean) return;
  await C.init();
  await require("../dbUtils").runQuery(`INSERT INTO markets (id, data, status, closes, updated) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, closes = excluded.closes, updated = excluded.updated`,
                 [clean.id, JSON.stringify(clean), clean.status, clean.closes, Date.now()]).catch(async (e) => {
    if (!/no such table/.test(String(e.message))) throw e;
  });
}
async function put(m) {
  const c = await C.cfg();
  m._grace = Number(c.settle_grace) || 7 * 86400;
  await C.save(KIND, m, deadline(m));
  await mirror(m);
}
/** What Pepe's mirror and the bot answers carry (everything but nothing secret - there are no secrets in a market). */
const view = (m) => m;

async function emit(kind, m, extra) {
  await C.emit(`market_${kind}`, m.room || null, Object.assign({ ref: ref(m), market: view(m) }, extra || {}));
}
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});

async function getMarket(raw) {
  const n = parseRef(raw);
  if (n === null) return null;
  const m = await C.load(KIND, n);
  return m && m.model === "lmsr" ? m : null;
}
/** The fee legs: a Market-maker-seeded market keeps its fees; any other follows the "market_fee" routing row. */
async function feeLegs(m, fee) {
  fee = Math.trunc(fee);
  if (fee <= 0) return [];
  if ((m.seed_from || "reserve") === "mm") return [{ pool: "mm", amount: fee }];
  return (await require("../escrow/games").feeLegs("market_fee", fee)).map(([pool, amount]) => ({ pool, amount }));
}

// ── create (Pepe: a chat !market new, or one of his auto markets) ──
async function create(actor, a, t) {
  if (!actor.pepe) return fail("forbidden", "Markets are opened in a Camfrog room (!market new).");
  const c = await C.cfg();
  const question = String(a.question || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).slice(0, 30)).filter(Boolean);
  if (question.length < 5) return fail("bad_question", "what's the question?");
  if (options.length < 2 || options.length > 6 || new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
    return fail("bad_options", "give 2 to 6 options, e.g. options red/blue/green");
  }
  const secs = Math.trunc(Number(a.secs) || 0);
  if (secs < 300 || secs > Number(c.max_secs)) return fail("bad_secs", `betting can stay open from 5 minutes to ${Math.round(Number(c.max_secs) / 86400)}d.`);
  const creator = String(a.creator || actor.login || "").slice(0, 60);
  const aiJudge = !!a.ai_judge;
  const judge = aiJudge ? String(a.pepe || actor.login || "") : String((a.judge && a.judge.login) || "").slice(0, 60);
  if (!judge) return fail("bad_judge", "every market needs a judge");
  const live = await C.list(KIND, LIVE);
  const twin = live.find((m) => C.same(m.creator, creator) && m.question.toLowerCase() === question.toLowerCase()
                             && m.options.join("/").toLowerCase() === options.join("/").toLowerCase() && t.nowS - Number(m.created) < DUP_SECS);
  if (twin) return fail("dup", `you opened that market ${Math.trunc(t.nowS - twin.created)}s ago (${ref(twin)}) — not doubled.`, { ref: ref(twin), age: t.nowS - twin.created });
  const mine = live.filter((m) => C.same(m.creator, creator)).length + Math.trunc(Number(a.pool_open) || 0);
  if (!a.auto && mine >= Number(c.max_open)) return fail("max_open", `you already have ${mine} open markets.`);
  const seed = X.seed(options.length);
  const vaultsLive = !!Number(c.vaults_enabled) && !!(await require("./vaults").live());
  const mmCash = await C.poolBalance("mm");
  const funder = vaultsLive && mmCash >= seed ? "mm" : "reserve";
  if (funder !== "mm" && c.layers) {
    return fail("mm_short", `the Market maker vault can't seed a new market right now: it needs ${fmt(seed)} PAT and holds ${fmt(mmCash)}. ` +
                "Under economy v2 the Federal Reserve doesn't seed markets - try again once the Market maker has room (or open a !pool instead: it needs no seed).",
                { need: seed, have: mmCash });
  }
  if ((await C.poolBalance(funder)) < seed) return fail("seed_short", `the Market maker / Federal Reserve can't seed a market right now (it needs ${fmt(seed)} PAT).`);
  const id = await C.nextId("market");
  const m = { id, question, options, creator, judge, room: a.room === undefined ? actor.room || null : a.room, status: "open",
              created: t.nowS, closes: t.nowS + secs, bets: [] };
  if (aiJudge) m.ai_judge = true;
  if (a.auto && typeof a.auto === "object") m.auto = a.auto;
  X.newFields(m, t.nowS);
  m.seed_from = funder;
  await C.legs(`cap:mseed:${id}`, [{ pool: funder, amount: -seed }, { pool: potKey(id), amount: seed }],
               { kind: "capital", flow: "market_seed", why: `market seed (M${id})` });
  await put(m);
  await emit("created", m, { by: actor.login, via: actor.via, secs });
  return { ok: true, ref: ref(m), market: view(m), secs, seed, funder };
}

// ── trading ──
function tradeChecks(m, actor, t) {
  if (m.status !== "open" || Number(m.closes) < t.nowS) return fail("closed", "trading on this market is closed");
  if (isJudge(actor, m)) return fail("judge", "you're the judge — you can't trade it");
  return null;
}
async function buy(actor, a, t) {
  const c = await C.cfg();
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", `no market ${String(a.ref || "?").toUpperCase()}.`);
  const opt = matchOption(m, a.option);
  if (!opt) return fail("bad_option", `${ref(m)} options are: ${m.options.join(" / ")}.`, { options: m.options });
  const bad = tradeChecks(m, actor, t);
  if (bad) return bad;
  const spend = Math.trunc(Number(a.amount) || 0);
  if (spend < Number(c.min_trade)) return fail("min", `the minimum buy is ${fmt(c.min_trade)} PAT`, { min: Number(c.min_trade) });
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
  if (!acct) return fail("no_account", "couldn't find your PAT account");
  if (acct.casino_banned) return fail("banned", "you're banned from the casino, so no trading.");
  const nick = actor.login || acct.camfrogUsername || acct.username;
  await C.wallet(acct.userId, -spend, "market-buy", { source: `capital:${ref(m)}` });
  const r = X.applyBuy(m, { nick, user: acct.username, opt, spend, nowS: t.nowS, web: a.order || null });
  const fl = await feeLegs(m, r.fee);
  await C.legs(`cap:buy:${t.key}`, [{ pool: potKey(m.id), amount: r.net }].concat(fl),
               { kind: "capital", flow: "market_buy", why: `markets fees (${ref(m)})` });
  await put(m);
  const p = X.prices(m)[opt];
  await emit("trade", m, { side: "buy", by: nick, via: actor.via, option: opt, amount: spend, shares: r.shares, price: p });
  return { ok: true, ref: ref(m), market: view(m), option: opt, spend, shares: r.shares, fee: r.fee, price: p, avg: spend / r.shares };
}
async function sell(actor, a, t) {
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", `no market ${String(a.ref || "?").toUpperCase()}.`);
  const opt = matchOption(m, a.option);
  if (!opt) return fail("bad_option", `${ref(m)} options are: ${m.options.join(" / ")}.`, { options: m.options });
  if (m.status !== "open" || Number(m.closes) < t.nowS) return fail("closed", "trading on this market is closed — wait for the judge");
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
  // the position: the actor's login (chat), else the account's linked login / username (web)
  const keys = [actor.login, acct && acct.camfrogUsername, acct && acct.username].filter(Boolean).map(C.low);
  const pk = keys.find((k) => m.positions && m.positions[k]);
  if (!pk) return fail("no_shares", `you don't hold any ${opt} shares`);
  const nick = m.positions[pk].nick;
  const plan = X.planSell(m, { nick, opt, want: a.shares === undefined || a.shares === null ? "all" : a.shares });
  if (!plan.ok) return fail(plan.code, plan.error);
  const payee = m.positions[pk].user ? await C.account({ username: m.positions[pk].user }) : acct;
  if (!payee) return fail("no_account", "couldn't find your PAT account");
  X.applySell(m, plan, { nick, opt, nowS: t.nowS, web: a.order || null });
  const fl = await feeLegs(m, plan.fee);
  await C.legs(`cap:sell:${t.key}`, [{ pool: potKey(m.id), amount: -Math.trunc(plan.gross) }].concat(fl),
               { kind: "capital", flow: "market_sell", why: `markets fees (${ref(m)})` });
  if (plan.pay > 0) await C.wallet(payee.userId, plan.pay, "market-sell", { source: `capital:${ref(m)}` });
  await put(m);
  const p = X.prices(m)[opt];
  await emit("trade", m, { side: "sell", by: nick, via: actor.via, option: opt, amount: plan.pay, shares: plan.shares, price: p });
  return { ok: true, ref: ref(m), market: view(m), option: opt, shares: plan.shares, pay: plan.pay, fee: plan.fee, pnl: plan.pay - plan.basis, price: p };
}

// ── resolution ──
/**
 * Pay a market out (status must be "settling"): 1 PAT per winning share (or the void rules), the rest of the pot to the
 * funder. -> {payouts, paid, leftover}. In the caller's transaction. win_reason as Pepe's (a re-settle passes its own).
 */
async function resolveInTx(m, result, t, { by = null, why = null, winReason = "market-win" } = {}) {
  if (m.paid_out) return null;
  const plan = X.resolvePlan(m, result);
  const reason = result ? winReason : "market-refund";
  const pot = await C.poolBalance(potKey(m.id));
  const take = Math.trunc(Math.max(0, plan.pool));
  if (pot !== take) throw new C.Refuse(500, `${ref(m)}'s pot holds ${pot}, the market says ${take} - left as it is`, "E_POT");
  const funder = m.seed_from || "reserve";
  const ls = [];
  if (take) ls.push({ pool: potKey(m.id), amount: -take });
  if (plan.leftover > 0) ls.push({ pool: funder, amount: plan.leftover });
  // the payouts leave the pot to wallets: the pot leg is the whole pot, the funder leg the leftover
  const paid = [];
  for (const [nick, user, amt] of plan.payouts) {
    const acct = await C.account({ username: user, login: nick });
    if (!acct) throw new C.Refuse(409, `couldn't find ${nick}'s PAT account - fix the link, then settle again`, "E_PAYEE", { payee: nick });
    paid.push([nick, user, amt, acct.userId]);
  }
  if (ls.length) await C.legs(`cap:resolve:${m.id}:${m.resettle_n || 0}`, ls, { kind: "capital", flow: "market_resolve", why: `market seed back (${ref(m)})` });
  for (const [, , amt, uid] of paid) await C.wallet(uid, amt, reason, { source: `capital:${ref(m)}` });
  m.paid_out = { at: t.nowS, total: plan.paid, result: result || "void", payouts: plan.payouts.map((p) => p.slice()), leftover: plan.leftover };
  m.status = result ? "settled" : "void";
  m.result = result || "void";
  m.ended = t.nowS;
  m.pool = 0.0;
  if (by) m.settled_by = by;
  if (!result && why) m.void_reason = m.void_reason || String(why).slice(0, 160);
  return plan;
}
const sellsOf = (m) => (m.trades || []).filter((x) => x.side === "sell");
async function settle(actor, a, t) {
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", `no market ${String(a.ref || "?").toUpperCase()}.`);
  if (!(isJudge(actor, m) || actor.admin || (actor.pepe && m.ai_judge))) {
    return fail("not_judge", `only the judge (${m.ai_judge ? "Pepe" : m.judge}) or an admin can settle ${ref(m)}.`, { judge: m.judge, ref: ref(m) });
  }
  if (!["open", "closed"].includes(m.status)) return fail("done", `${ref(m)} is already ${m.status}.`, { status: m.status, ref: ref(m) });
  const outcome = String(a.outcome || "").trim();
  const first = outcome.split(/\s+/)[0] || "";
  const rest = outcome.slice(first.length).trim();
  let result = null;
  if (VOID_WORDS.has(first.toLowerCase())) {
    // 1.90a: a judge voiding a share market must say why (an admin or Pepe needn't)
    if (!actor.admin && !actor.pepe && rest.length < 4) {
      return fail("void_reason", `voiding ${ref(m)} needs a reason: !market settle ${ref(m)} void <why>. Trading fees aren't refunded; holders split what's left after the Reserve's seed.`);
    }
    m.void_reason = rest.slice(0, 160);
  } else {
    result = matchOption(m, outcome);
    if (!result) return fail("bad_option", `${ref(m)} options are: ${m.options.join(" / ")} (or void <reason>).`, { options: m.options });
  }
  m.status = "settling";
  m.result = result || "void";
  m.settled_by = actor.login || actor.username;
  const plan = await resolveInTx(m, result, t, { by: m.settled_by, why: a.why || rest || null });
  await put(m);
  const voidAlert = !result && !actor.admin && !actor.pepe && sellsOf(m).length > 0;
  await emit(result ? "settled" : "void", m, { by: m.settled_by, via: actor.via, result, why: result ? null : (a.why || m.void_reason || null),
                                               payouts: plan.payouts.map(([n, , amt]) => [n, amt]), paid: plan.paid, leftover: plan.leftover,
                                               judge: isJudge(actor, m), void_alert: voidAlert, sellers: voidAlert ? [...new Set(sellsOf(m).map((x) => x.nick))] : null });
  return { ok: true, ref: ref(m), market: view(m), result: result || "void", payouts: plan.payouts.map(([n, , amt]) => [n, amt]), paid: plan.paid, leftover: plan.leftover };
}
async function cancel(actor, a, t) {
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", `no market ${String(a.ref || "?").toUpperCase()}.`);
  const others = Object.values(m.positions || {}).filter((p) => !C.same(p.nick, actor.login) && !C.same(p.user, actor.username));
  if (!actor.admin && !(C.same(actor.login, m.creator) && !others.length)) return fail("forbidden", "only the creator (before anyone else bets) or an admin can cancel a market.");
  if (!["open", "closed"].includes(m.status)) return fail("done", `${ref(m)} is already ${m.status}.`, { status: m.status });
  m.status = "settling";
  const why = `cancelled by ${actor.login || actor.username} — everyone's refunded`;
  const plan = await resolveInTx(m, null, t, { by: actor.login || actor.username, why });
  await put(m);
  await emit("void", m, { by: actor.login || actor.username, via: actor.via, result: null, why, why_code: "cancel", payouts: plan.payouts.map(([n, , amt]) => [n, amt]),
                          paid: plan.paid, leftover: plan.leftover });
  return { ok: true, ref: ref(m), market: view(m), result: "void", payouts: plan.payouts.map(([n, , amt]) => [n, amt]), paid: plan.paid };
}
/** Pepe's AI judge state (his mirror holds it; Phase 5 moves the judge) - what the page shows and what holds the deadline. */
async function aiPut(actor, a) {
  if (!actor.pepe) return fail("forbidden", "Pepe only.");
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", "no such market");
  if (!m.ai_judge) return fail("not_ai", `${ref(m)} isn't judged by Pepe`);
  m.ai = a.ai && typeof a.ai === "object" ? a.ai : null;
  m.ai_hold = !!a.hold;
  await put(m);
  return { ok: true, ref: ref(m), market: view(m) };
}

// ── deadlines (the service tick) ──
async function due(nowS) {
  const c = await C.cfg();
  const out = [];
  for (const m of await C.list(KIND, ["open", "closed"])) {
    if (m.status === "open" && Number(m.closes) < nowS) out.push(m.id);
    else if (m.status === "closed" && Number(m.closes) + Number(c.settle_grace) < nowS && !(m.ai_judge && m.ai_hold)) out.push(m.id);
  }
  return out;
}
async function expire(id, t) {
  const c = await C.cfg();
  const m = await C.load(KIND, id);
  if (!m) return { ok: false };
  if (m.status === "open" && Number(m.closes) < t.nowS) {
    m.status = "closed";
    await put(m);
    await emit("closed", m, {});
    return { ok: true };
  }
  if (m.status === "closed" && Number(m.closes) + Number(c.settle_grace) < t.nowS && !(m.ai_judge && m.ai_hold)) {
    m.status = "settling";
    const why = "the judge never called it, so everyone gets their PAT back";
    const plan = await resolveInTx(m, null, t, { why });
    await put(m);
    await emit("void", m, { result: null, why, why_code: "overdue", payouts: plan.payouts.map(([n, , amt]) => [n, amt]), paid: plan.paid, leftover: plan.leftover });
    return { ok: true };
  }
  return { ok: false };
}

// ── re-settle (pepe_mktresettle, admin): claw back the first resolution, take the funder's leftover back, resolve again ──
async function resettlePlan(m, word) {
  if (!["settled", "void"].includes(m.status) || !m.paid_out) return [null, `${ref(m)} hasn't been paid out (${m.status}) - settle it normally.`];
  if (m.resettle) return [null, `${ref(m)} was already re-settled (${m.resettle.from} -> ${m.resettle.to}). One re-settle per market; anything more is by hand.`];
  const w = String(word || "").trim();
  const first = w.split(/\s+/)[0] || "";
  const reason = w.slice(first.length).trim();
  let nw = null;
  if (!["void", "cancel", "refund"].includes(first.toLowerCase())) {
    nw = matchOption(m, first);
    if (!nw) return [null, `${ref(m)} options are: ${m.options.join(" / ")} (or void).`];
  }
  if (reason.length < 4) return [null, "say why: !market resettle <id> <option|void> <reason>"];
  const old = m.paid_out.result || m.result;
  if ((String(old).toLowerCase() === "void" ? null : old) === nw) return [null, `${ref(m)} is already settled ${old}.`];
  if (!Array.isArray(m.paid_out.payouts)) return [null, `${ref(m)}: its first payouts aren't on record - re-settle it by hand.`];
  const debits = m.paid_out.payouts.filter((p) => Math.trunc(p[2]) > 0).map((p) => [p[0], p[1], Math.trunc(p[2])]);
  const leftover = Math.trunc(Number(m.paid_out.leftover) || 0);
  const pool = debits.reduce((s, p) => s + p[2], 0) + leftover;
  if (Math.trunc(Number(m.paid_out.total)) !== debits.reduce((s, p) => s + p[2], 0)) return [null, `${ref(m)}: the payouts don't match paid_out - re-settle it by hand.`];
  const funder = m.seed_from || "reserve";
  const probe = JSON.parse(JSON.stringify(m));
  probe.pool = pool;
  const np = X.resolvePlan(probe, nw);
  const users = [];
  for (const [nick, user, amt] of debits) {
    const acct = await C.account({ username: user, login: nick });
    const bal = acct ? Number((await require("../dbUtils").getQuery("SELECT points_balance FROM users WHERE userId = ?", [acct.userId]))[0].points_balance) || 0 : 0;
    users.push({ nick, user: acct ? acct.username : user, userId: acct ? acct.userId : null, amount: amt, balance: bal, ok: !!acct && bal >= amt });
  }
  const fbal = await C.poolBalance(funder);
  const plan = { market: m.id, ref: ref(m), from: old, to: nw || "void", to_raw: nw, reason: reason.slice(0, 200), pool, debits: users, funder,
                 funder_back: leftover, funder_balance: fbal, funder_ok: fbal >= leftover, payouts: np.payouts, paid: np.paid, leftover: np.leftover };
  plan.funder_net = np.leftover - leftover;
  plan.conserved = users.reduce((s, d) => s + d.amount, 0) + leftover === pool && pool === np.paid + np.leftover;
  return [plan, null];
}
const planDigest = (p) => require("crypto").createHash("sha256").update(JSON.stringify([p.ref, p.to, p.pool, p.debits.map((d) => [d.nick, d.amount]),
  p.funder_back, p.payouts.map((x) => [x[0], x[2]]), p.leftover]), "utf8").digest("hex").slice(0, 12);
async function resettle(actor, a, t, { dry }) {
  if (!actor.admin) return fail("forbidden", "only an admin can re-settle a market.");
  const m = await getMarket(a.ref);
  if (!m) return fail("no_market", `no market ${String(a.ref || "?").toUpperCase()}.`);
  const [plan, err] = await resettlePlan(m, a.outcome);
  if (err) return fail("refused", err);
  plan.code = planDigest(plan);
  const blocked = plan.debits.some((d) => !d.ok) || !plan.funder_ok || !plan.conserved;
  if (dry || blocked) return { ok: true, dry: true, blocked, plan };
  if (String(a.code || "") !== plan.code) return fail("changed", "something changed since the dry run - run it again.", { plan });
  // one transaction: every clawback (a payee short -> nothing at all), the funder's first leftover back, the pot restored, resolved again
  for (const d of plan.debits) await C.wallet(d.userId, -d.amount, "market-resettle-clawback", { source: `capital:${ref(m)}` });
  const n = Math.trunc(Number(m.resettle_n) || 0) + 1;
  await C.legs(`cap:resettle:${m.id}:${n}`, [{ pool: plan.funder, amount: -plan.funder_back }, { pool: potKey(m.id), amount: plan.pool }],
               { kind: "capital", flow: "market_resettle", why: `market re-settle (${ref(m)}): first leftover back` });
  m.resettle_n = n;
  m.resettle = { at: t.nowS, by: actor.login || actor.username, from: plan.from, to: plan.to, reason: plan.reason,
                 clawback: plan.debits.map((d) => ({ nick: d.nick, amount: d.amount })), funder: plan.funder, funder_back: plan.funder_back,
                 payouts: plan.payouts.map(([nick, , amount]) => ({ nick, amount })), paid: plan.paid, leftover: plan.leftover };
  m.pool = plan.pool;
  delete m.paid_out;
  m.status = "settling";
  m.result = plan.to;
  m.settled_by = actor.login || actor.username;
  if (!plan.to_raw) m.void_reason = plan.reason.slice(0, 160);
  const r = await resolveInTx(m, plan.to_raw, t, { by: m.settled_by, why: plan.reason, winReason: "market-win (re-settled)" });
  if (r.paid !== plan.paid || r.leftover !== plan.leftover) throw new C.Refuse(500, `${ref(m)}: the re-settle paid ${r.paid} (+${r.leftover}), the plan said ${plan.paid} (+${plan.leftover})`, "E_VERIFY");
  await put(m);
  await emit("resettled", m, { by: m.settled_by, from: plan.from, to: plan.to, reason: plan.reason, clawback: m.resettle.clawback, payouts: m.resettle.payouts });
  return { ok: true, ref: ref(m), market: view(m), plan };
}

// ── reads ──
async function read(verb, actor, a) {
  if (verb === "get") {
    const m = await getMarket(a.ref);
    return m ? { market: view(m) } : { market: null };
  }
  if (verb === "portfolio") {
    const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
    const keys = [actor.login, acct && acct.camfrogUsername, acct && acct.username].filter(Boolean).map(C.low);
    const lines = [];
    for (const m of await C.list(KIND, ["open", "closed"])) {
      const pk = keys.find((k) => m.positions && m.positions[k]);
      if (!pk) continue;
      const p = X.prices(m);
      for (const o of X.mapKeys(m, "shares", pk)) {
        const sh = Number(m.positions[pk].shares[o]);
        if (sh < 1) continue;
        const cost = Number(m.positions[pk].cost[o] || 0);
        lines.push({ ref: ref(m), option: o, shares: sh, entry: cost / sh, price: p[o], value: sh * p[o], cost });
      }
    }
    return { lines };
  }
  return {};
}

/** The verbs (the service runs each in one transaction under its key). */
async function act(verb, actor, a, t) {
  if (verb === "create") return create(actor, a, t);
  if (verb === "buy") return buy(actor, a, t);
  if (verb === "sell") return sell(actor, a, t);
  if (verb === "settle") return settle(actor, a, t);
  if (verb === "cancel") return cancel(actor, a, t);
  if (verb === "ai_put") return aiPut(actor, a, t);
  if (verb === "resettle_plan") return resettle(actor, a, t, { dry: true });
  if (verb === "resettle") return resettle(actor, a, t, { dry: false });
  return fail("bad_verb", `unknown market verb ${verb}`);
}
const READS = ["get", "portfolio"];

// ── the website (/markets/:id/bet|sell|resolve while the capital cluster lives here) ──
async function webAct(userId, kind, id, fields) {
  const u = (await require("../dbUtils").getQuery("SELECT userId, username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return "Couldn't find your account.";
  const actor = { userId: u.userId, username: u.username, login: u.camfrogUsername || u.username, admin: u.class === "Admin", via: "web", pepe: false };
  const verb = kind === "bet" ? "buy" : kind === "resolve" ? "settle" : kind;
  const args = { ref: `M${id}`, option: fields.option, amount: fields.amount, shares: fields.shares, outcome: fields.outcome };
  const res = await require("./service").act("markets", { verb, actor, args, idem: fields.idem ? `web-${u.userId}-${fields.idem}` : null });
  if (!res.ok) {
    const e = String(res.error || "Something went wrong — nothing changed.");
    return e.charAt(0).toUpperCase() + e.slice(1);
  }
  if (res.dup) return "Already done — that order went through once.";
  if (verb === "buy") return `Bought ${Math.round(res.shares).toLocaleString("en-US")} ${res.option} shares for ${fmt(res.spend)} PAT — ${res.option} is now ${(res.price * 100).toFixed(1)}%.`;
  if (verb === "sell") return `Sold ${Math.round(res.shares).toLocaleString("en-US")} ${res.option} shares for ${fmt(res.pay)} PAT.`;
  return `Resolved: ${res.result}. ${res.payouts.length} holder(s) paid ${fmt(res.paid)} PAT.`;
}

module.exports = { KIND, LIVE, act, read, READS, due, expire, resolveInTx, getMarket, matchOption, parseRef, mirror, put, view, ref, potKey,
                   webAct, resettlePlan };
