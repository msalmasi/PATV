// escrow/pools.js — 1.99ou Phase 2: parimutuel BETTING POOLS (!pool) owned by the site (Pepe's pepe_market.py rules for the
// "pool" model, exactly). The LMSR share markets (!market, pepe_amm.py) stay in Pepe until Phase 3.
//
//   create   no money moves: a question, 2-6 options (yes/no by default), a judge (a person, or Pepe's AI judge), betting open
//            for 5 min .. 30 d (default 1 d). At most MAX_OPEN live markets per creator (pools here + Pepe's LMSR markets,
//            which he passes as lmsr_open). The same create twice within DUP_SECS is refused (Pepe's CreateGuard).
//   bet      any number of bets while it's open (min MIN_BET); each is its own ledger hold. The judge can't bet.
//   settle   the judge (Pepe for an AI-judged pool) or an admin, while open or closed: an option or "void <why>".
//            Pay (_market_pay): the winners split the losing side's pot pro rata to their stake, after FEE_PCT of the LOSING
//            pool (routed by the "market_fee" row - Pepe's published shares); rounding dust goes to the fee. Nobody backed the
//            result, everyone backed it, or void -> every stake refunded, no fee.
//   cancel   the creator before anyone else has bet, or an admin: every stake refunded.
//   deadlines (the site tick): open past `closes` -> closed (Pepe announces it and starts his AI judge); closed for
//            SETTLE_GRACE without a call -> every stake refunded (an AI-judged pool whose AI holds the deadline waits: ai_hold).
//   reserve_id  pools and Pepe's LMSR markets share the M numbering: while the pools run here the site owns the sequence and
//            Pepe takes each new LMSR market's id from here (keyed by his idem, so a retry gets the same id).
// Record: Pepe's markets.json shape {id, question, options, creator, judge, room, status open|closed|settled|void, created,
//         closes, bets: [{nick, option, amount, hold, ts, user, web, order}], model: "pool", ai_judge, ai, ai_hold, result,
//         settled_by, void_reason, fee, ended, bet_seq, auto}   (auto: 1.99th, Pepe's auto pools - markets.cleanAuto)  (times in seconds; hold = the ledger hold id, user = the PATV username)
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const L = require("./ledger");

const GAME = "pools";
const MIN_BET = 500;
const FEE_PCT = 5;                    // % of the LOSING pool
const DEFAULT_SECS = 86400;
const MAX_SECS = 30 * 86400;
const MIN_SECS = 300;
const SETTLE_GRACE = 7 * 86400;       // after betting closes, the judge has this long
const MAX_OPEN = 5;                   // open markets one person can have created (pools + LMSR markets)
const DUP_SECS = 120;                 // Pepe's CREATE_DEDUPE_SECS
const KEEP_DAYS = 60;
const MAX_HOLDS = 2000;               // one settle spends every bet's hold (Pepe's local pools had no cap)
const LIVE = ["open", "closed"];
const RECENT = ["settled", "void"];
const VOID_WORDS = new Set(["void", "refund", "draw", "push", "cancel", "nobody", "none", "tie"]);
const AI_WORDS = new Set(["pepe", "ai", "pepefrog", "pepebot", "robot", "🤖"]);

const G = () => require("./games");
const ref = (m) => `M${m.id}`;
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
/** pepe_escrow.norm_create_text: case, spacing and edge punctuation ignored. */
const normText = (t) => String(t || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ").replace(/^[ .,;:!?\-"']+|[ .,;:!?\-"']+$/g, "");
function parseRef(t) {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  const n = s.startsWith("M") ? s.slice(1) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
/** pepe_wager._fmt_secs */
function fmtSecs(secs) {
  secs = Math.max(0, Math.trunc(secs));
  if (secs >= 86400) { const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600); return `${d}d` + (h ? ` ${h}h` : ""); }
  if (secs >= 3600) { const m = Math.floor((secs % 3600) / 60); return `${Math.floor(secs / 3600)}h` + (m ? ` ${m}m` : ""); }
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

// ── Pepe's maths (pepe_market.py) ──
/** _market_match_option: an exact option (any case), else the ONE option it starts ("y" / "n" work). */
function matchOption(m, word) {
  const w = String(word || "").trim().toLowerCase();
  for (const o of m.options || []) if (o.toLowerCase() === w) return o;
  const starts = w ? (m.options || []).filter((o) => o.toLowerCase().startsWith(w)) : [];
  return starts.length === 1 ? starts[0] : null;
}
/** _market_pools: PAT per option (the options first, in order). */
function poolsOf(m) {
  const pools = {};
  for (const o of m.options || []) pools[o] = 0;
  for (const b of m.bets || []) pools[b.option] = (pools[b.option] || 0) + Number(b.amount);
  return pools;
}
/** _market_odds_line (pool model) - Pepe's own announcement words. */
function oddsLine(m) {
  const pools = poolsOf(m);
  const total = Object.values(pools).reduce((a, v) => a + v, 0);
  const parts = [];
  for (const o of m.options || []) {
    const p = pools[o];
    if (total && p) {
      const lose = total - p;
      const mult = 1 + (lose - Math.floor(lose * FEE_PCT / 100)) / p;
      parts.push(`${o}: PAT ${fmt(p)} (${Math.floor(p * 100 / total)}%, pays ${mult.toFixed(2)}x)`);
    } else parts.push(`${o}: PAT ${fmt(p)}`);
  }
  return parts.join(" · ") + (total ? ` — pot PAT ${fmt(total)}` : " — no bets yet");
}

/**
 * _market_pay's arithmetic for `result` (null = void), to the PAT. -> {refund_all, note, total, win_pool, fee, payouts: [[nick, amount]],
 * winners}. Python ints are exact: the products here (share * stake) can pass 2^53, so this runs on BigInt.
 *   refund_all (void / nobody backed it / everyone backed it): every stake back, no fee
 *   else: fee = lose_pool * FEE_PCT // 100; share = lose_pool - fee; each winner (by exact nick, first-bet order) gets
 *         stake + share * stake // win_pool; the rounding dust (total - paid - fee) goes to the fee
 */
function payoutPlan(m, result) {
  const pools = poolsOf(m);
  const total = Object.values(pools).reduce((a, v) => a + v, 0);
  const winPool = result ? (pools[result] || 0) : 0;
  if (result == null || winPool === 0 || winPool === total) {
    return { refund_all: true, note: result == null ? "void" : winPool === 0 ? "nobody" : "wash", total, win_pool: winPool, fee: 0, payouts: [], winners: 0 };
  }
  const lose = BigInt(total - winPool);
  let fee = lose * BigInt(FEE_PCT) / 100n;
  const share = lose - fee;
  const winners = new Map();
  for (const b of m.bets || []) if (b.option === result) winners.set(b.nick, (winners.get(b.nick) || 0n) + BigInt(b.amount));
  const payouts = [];
  let paid = 0n;
  const wp = BigInt(winPool);
  for (const [nick, stake] of winners) {
    const amt = stake + share * stake / wp;
    payouts.push([nick, Number(amt)]);
    paid += amt;
  }
  const dust = BigInt(total) - paid - fee;
  if (dust > 0n) fee += dust;                                    // rounding dust -> the fee
  return { refund_all: false, note: null, total, win_pool: winPool, fee: Number(fee), payouts, winners: winners.size };
}

// ── the display table the /markets and /wagers pages read (markets.js) ──
async function mirror(m) {
  const clean = require("../markets").cleanMarket(m);
  if (!clean) return;
  await require("../markets").storeRow(clean);      // 1.99ur: + its pad column (padlinks.js)
}

const FIELDS = ["id", "question", "options", "creator", "judge", "room", "pad", "tz", "status", "created", "closes", "model", "ai_judge", "ai", "ai_hold",
                "result", "settled_by", "void_reason", "fee", "ended", "bet_seq", "via", "users", "auto"];
const view = (m) => {
  const out = {};
  for (const k of FIELDS) if (m[k] !== undefined) out[k] = m[k];
  out.bets = (m.bets || []).map((b) => {
    const x = { nick: b.nick, option: b.option, amount: b.amount, hold: b.hold, ts: b.ts };
    for (const k of ["user", "web", "order"]) if (b[k] !== undefined && b[k] !== null) x[k] = b[k];
    return x;
  });
  return out;
};
async function emit(kind, m, extra) {
  await L.emitInTx(GAME, kind, m.room || null, Object.assign({ ref: ref(m), pool: view(m) }, extra || {}));
}
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
const nickOf = (actor) => actor.login || actor.username;
const isJudgeActor = (actor, m) => (m.ai_judge && !!actor.pepe) || G().same(actor.login, m.judge) || G().same(actor.username, m.judge);

async function pepeLogin() { return (await L.meta("pepe_login")) || "pepe"; }
async function notePepe(actor) {
  if (actor.pepe && actor.login && (await L.meta("pepe_login")) !== actor.login) await L.setMeta("pepe_login", String(actor.login).slice(0, 60));
}

// ── actions ──
async function create(actor, a, t) {
  const account = await G().actorAccount(actor);
  if (account && account.casino_banned) return fail("banned", "You're banned from the casino, so no pools.");
  const aiJudge = !!a.ai_judge;
  const judge = aiJudge ? String(a.pepe || await pepeLogin()) : (a.judge && a.judge.login ? String(a.judge.login).replace(/^@+/, "") : null);
  if (!judge) return fail("no_judge", "Every pool needs a judge — add 'judge @someone' (they can't bet on it), or 'judge @pepe' to let Pepe decide it (experimental).");
  if (!aiJudge && G().same(judge, await pepeLogin())) return fail("bad_judge", `I don't know who the judge '${judge}' is.`);
  let options = ["yes", "no"];
  if (Array.isArray(a.options)) {
    const opts = [...new Set(a.options.map((o) => String(o).replace(/^[ .,;]+|[ .,;]+$/g, "")).filter(Boolean).map((o) => o.slice(0, 30)))];
    if (opts.length < 2 || opts.length > 6) return fail("bad_options", "Give 2 to 6 options, e.g. options red/blue/green");
    options = opts;
  }
  const secs = Math.floor(Number(a.secs) || DEFAULT_SECS);
  if (secs > MAX_SECS || secs < MIN_SECS) return fail("bad_secs", `Betting can stay open from 5 minutes to ${fmtSecs(MAX_SECS)}.`, { min: MIN_SECS, max: MAX_SECS });
  const question = String(a.question || "").replace(/\s+/g, " ").trim().replace(/^[ ,;:\-]+|[ ,;:\-]+$/g, "").slice(0, 200);
  if (question.length < 5) return fail("no_question", "What's the question? e.g. !market new Will it rain Saturday? judge @carol");
  const me = { login: nickOf(actor), user: account ? account.username : actor.username || null };
  if (!me.login) return fail("no_account", "Couldn't find your account.");
  const mine = (await G().list(GAME, LIVE)).filter((m) => G().isWho(actor, { login: m.creator, user: (m.users || {}).creator }));
  const twin = mine.find((m) => normText(m.question) === normText(question) && (m.options || []).map(normText).join("\u0000") === options.map(normText).join("\u0000")
                                && t.nowS - m.created < DUP_SECS);
  if (twin) return fail("dup", `You already made that pool ${t.nowS - twin.created}s ago (${ref(twin)}) — not doubled.`, { ref: ref(twin), age: t.nowS - twin.created });
  // Pepe counts every live market a person created, pools and LMSR alike: his count of the LMSR ones (lmsr_open) or the display
  // table's (Pepe's LMSR snapshot - what a website create sees), whichever is higher
  // 1.99th: Pepe's auto pools (pepe_automkt.py: his own weekly count, Pepe-judged) carry `auto` and skip the per-creator cap
  const auto = actor.pepe && aiJudge ? require("../markets").cleanAuto(a.auto) : null;
  const open = mine.length + Math.max(0, Math.floor(Number(a.lmsr_open) || 0), await lmsrOpen(actor));
  if (open >= MAX_OPEN && !auto) return fail("max_open", `You already have ${open} open markets.`, { open });
  await notePepe(actor);
  const id = await G().nextId(GAME);
  // 1.99vb: a room Pepe sends as null means "no room" (a website create: its pad was picked, or it's site-wide) - not the actor's room
  const m = { id, question, options, creator: me.login, judge, room: a.room !== undefined ? a.room || null : actor.room || null, status: "open", created: t.nowS, closes: t.nowS + secs,
              bets: [], model: "pool", users: me.user ? { creator: me.user } : {}, via: actor.via || "room" };
  if (aiJudge) m.ai_judge = true;
  if (auto) m.auto = auto;
  // 1.99ur: the pad it belongs to (the website's pad picker, or Pepe's room for a chat create) + the creator's zone for a set close
  if (a.pad) m.pad = String(a.pad).slice(0, 128);
  if (a.tz && require("../markets").cleanTz(a.tz)) m.tz = require("../markets").cleanTz(a.tz);
  await G().save(GAME, m);
  await emit("created", m, { by: me.login, via: actor.via, secs });
  return { ok: true, ref: ref(m), pool: view(m), secs };
}

async function lmsrOpen(actor) {
  const rows = await getQuery("SELECT data FROM markets WHERE status IN ('open','closed','settling')").catch(() => []);
  let n = 0;
  for (const r of rows) {
    let m = null;
    try { m = JSON.parse(r.data); } catch (e) { m = null; }
    if (m && m.model === "lmsr" && G().isWho(actor, { login: m.creator })) n++;
  }
  return n;
}

async function holdKey(m) {
  const n = Math.max(Number(m.bet_seq) || 0, (m.bets || []).length) + 1;
  m.bet_seq = n;
  let key = `pool:${ref(m)}:b${n}`;
  if ((await getQuery("SELECT id FROM escrow_holds WHERE key = ?", [key]))[0]) key += `~${Date.now()}`;   // a key used before a rollback
  return key;
}

async function bet(actor, m, a, t) {
  if (!m) return fail("no_pool", `No market ${String(a.ref || "").toUpperCase()}.`);
  const r = ref(m);
  if (m.status !== "open" || m.closes < t.nowS) return fail("closed", `Betting on ${r} is closed.`);
  const nick = nickOf(actor);
  if (G().same(nick, m.judge) || G().same(actor.username, m.judge)) return fail("judge", "You're the judge — you can't bet on it.");
  const account = await G().actorAccount(actor);
  if (account && account.casino_banned) return fail("banned", "You're banned from the casino, so no betting.");
  const option = matchOption(m, a.option);
  if (!option) return fail("bad_option", `${r} options are: ${m.options.join(" / ")}.`, { options: m.options });
  const amount = Math.floor(Number(a.amount));
  if (!(amount >= MIN_BET) || !Number.isSafeInteger(amount)) return fail("min", `The minimum bet is PAT ${fmt(MIN_BET)}.`, { min: MIN_BET });
  if (a.order && (m.bets || []).some((b) => String(b.order) === String(a.order))) {
    return { ok: true, ref: r, pool: view(m), already: true, option, amount };          // a website order placed before (Pepe's re-delivery)
  }
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  if ((m.bets || []).length >= MAX_HOLDS) return fail("full", `${r} has taken all the bets it can.`);
  const key = await holdKey(m);
  let h;
  try {
    h = await L.holdInTx({ key, hid: null, account, login: nick, amount, ref: r, reason: "market-stake", cp: null, via: "site", casino: true });
  } catch (e) {
    // the words Pepe's escrow says ("couldn't place the bet — ..."); _rollback: games.act undoes the hold id it drew
    if (e && e.code === "E_INSUFFICIENT_PAT") {
      const b = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [account.userId]))[0];
      return fail("insufficient", `Couldn't place the bet — that needs PAT ${fmt(amount)} and ${nick} has ${fmt(b ? b.b : 0)}.`, { _rollback: true });
    }
    if (e && e.code === "E_CASINO_BANNED") return fail("banned", "You're banned from the casino, so no betting.", { _rollback: true });
    throw e;
  }
  const b = { nick, option, amount, hold: h.hid, ts: t.nowS, user: account.username };
  if (actor.via === "web") b.web = true;
  if (a.order) b.order = a.order;
  m.bets.push(b);
  await G().save(GAME, m);
  await emit("bet", m, { by: nick, option, amount, via: actor.via });
  const mine = m.bets.filter((x) => x.option === option && G().same(x.nick, nick)).reduce((s, x) => s + x.amount, 0);
  return { ok: true, ref: r, pool: view(m), option, amount, mine };
}

/** _market_pay for a pool: every hold refunded, or one settle (payouts + the routed fee). The record's new state + the event. */
async function pay(m, result, t, info) {
  const plan = payoutPlan(m, result);
  const r = ref(m);
  const bets = m.bets || [];
  if (plan.refund_all) {
    for (const b of bets) await L.refundInTx({ key: `refund:${b.hold}`, hid: b.hold, reason: "market-refund" });
    m.status = result ? "settled" : "void";
  } else {
    const fees = await G().feeLegs("market_fee", plan.fee);
    const userOf = {};
    for (const b of bets) if (!(b.nick in userOf)) userOf[b.nick] = b.user || null;
    await L.settleInTx({ key: `settle:${bets[0].hold}`, hids: bets.map((b) => b.hold), ref: r, fees, max: MAX_HOLDS,
                         payouts: plan.payouts.map(([nick, amount]) => ({ user: userOf[nick], nick, amount, reason: "market-win" })) });
    m.status = "settled";
    m.fee = plan.fee;
  }
  m.ended = t.nowS;
  await G().save(GAME, m);
  const kind = plan.refund_all ? (result ? "refunded" : "void") : "settled";
  const data = { result: result || null, note: plan.note, total: plan.total, fee: plan.fee, payouts: plan.payouts, winners: plan.winners,
                 by: info.by || null, why: info.why || null, why_code: info.why_code || null, judge_call: !!info.judge_call, via: info.via || null };
  await emit(kind, m, data);
  return Object.assign({ kind }, data);
}

async function settle(actor, m, a, t) {
  if (!m) return fail("no_pool", `No market ${String(a.ref || "").toUpperCase()}.`);
  const r = ref(m);
  const isJudge = isJudgeActor(actor, m);
  if (!(isJudge || actor.admin)) return fail("not_judge", `Only the judge (${m.ai_judge ? "Pepe" : m.judge}) or an admin can settle ${r}.`, { judge: m.judge, ref: r });
  if (!LIVE.includes(m.status)) return fail("done", `${r} is already ${m.status}.`, { status: m.status });
  const outcome = String(a.outcome || "").trim();
  const sp = outcome.indexOf(" ");
  const first = sp < 0 ? outcome : outcome.slice(0, sp);
  const rest = sp < 0 ? "" : outcome.slice(sp + 1);
  let result = null;
  if (VOID_WORDS.has(first.toLowerCase())) {
    m.void_reason = rest.trim().slice(0, 160);
  } else {
    result = matchOption(m, outcome);
    if (!result) return fail("bad_option", `${r} options are: ${m.options.join(" / ")} (or void <reason>).`, { options: m.options });
  }
  const by = nickOf(actor);
  m.result = result || "void";
  m.settled_by = by;
  const res = await pay(m, result, t, { by, why: result == null ? (m.void_reason || null) : null, judge_call: isJudge, via: actor.via });
  return Object.assign({ ok: true, ref: r, pool: view(m) }, res);
}

async function cancel(actor, m, a, t) {
  if (!m) return fail("no_pool", `No market ${(String(a.ref || "") || "?").toUpperCase()}.`);
  const nick = nickOf(actor);
  const others = (m.bets || []).filter((b) => !G().same(b.nick, nick));
  const creator = G().isWho(actor, { login: m.creator, user: (m.users || {}).creator });
  if (!actor.admin && !(creator && !others.length)) return fail("not_yours", "Only the creator (before anyone else bets) or an admin can cancel a market.");
  if (!LIVE.includes(m.status)) return fail("done", `${ref(m)} is already ${m.status}.`, { status: m.status });
  const res = await pay(m, null, t, { by: nick, why_code: "cancel", via: actor.via });
  return Object.assign({ ok: true, ref: ref(m), pool: view(m) }, res);
}

/** Pepe's AI judge writes its state back (it runs in Pepe until Phase 5): the `ai` object + whether it holds the deadline. */
async function aiPut(actor, m, a) {
  if (!actor.pepe) return fail("not_pepe", "Only Pepe's AI judge can do that.");
  if (!m || !m.ai_judge) return fail("no_pool", "No such AI-judged pool.");
  const raw = a.ai && typeof a.ai === "object" ? JSON.stringify(a.ai) : "";
  if (raw.length > 16000) return fail("too_big", "AI state too big.");
  m.ai = raw ? JSON.parse(raw) : null;
  m.ai_hold = !!a.hold;
  await G().save(GAME, m);
  if (a.announce) await emit("ai", m, { text: String(a.announce).slice(0, 400) });
  return { ok: true, ref: ref(m), pool: view(m) };
}

async function act(verb, actor, a, t) {
  if (verb === "create") return create(actor, a, t);
  if (verb === "reserve_id") {
    // Pepe's LMSR market takes its id from the shared M sequence (keyed by his idem: games.act records the answer)
    if (!actor.pepe) return fail("not_pepe", "Only Pepe can reserve a market id.");
    await notePepe(actor);
    const id = await G().nextId(GAME);
    return { ok: true, ref: `M${id}`, id };
  }
  const m = await G().load(GAME, parseRef(a.ref));
  if (verb === "bet") return bet(actor, m, a, t);
  if (verb === "settle") return settle(actor, m, a, t);
  if (verb === "cancel") return cancel(actor, m, a, t);
  if (!m) return fail("no_pool", `No market ${String(a.ref || "").toUpperCase()}.`);
  if (verb === "ai_put") return aiPut(actor, m, a);
  if (verb === "ai_request") {
    // the website's "ask Pepe now" / "dispute" on an AI-judged pool: Pepe's AI judge runs it (it still lives in Pepe)
    if (!m.ai_judge) return fail("no_ai", `${ref(m)} isn't judged by Pepe.`);
    await emit("ai_request", m, { sub: String(a.sub || "ai").slice(0, 10), who: nickOf(actor), why: String(a.why || "").slice(0, 200), admin: !!actor.admin });
    return { ok: true, ref: ref(m) };
  }
  return fail("bad_verb", "Unknown pool action.");
}

const READS = ["get", "list"];
async function read(verb, actor, a) {
  if (verb === "get") {
    const m = await G().load(GAME, parseRef(a.ref));
    return { pool: m ? view(m) : null };
  }
  return { pools: (await G().list(GAME, LIVE)).map(view) };
}

// ── deadlines ──
async function due(nowS) {
  const out = [];
  for (const m of await G().list(GAME, LIVE)) {
    if (m.status === "open" && m.closes < nowS) out.push(m.id);
    else if (m.status === "closed" && m.closes + SETTLE_GRACE < nowS && !(m.ai_judge && m.ai_hold)) out.push(m.id);
  }
  // history: drop finished pools after 60 days (the display table keeps its own rows)
  if (Math.random() < 0.01) {
    await runQuery("DELETE FROM escrow_games WHERE game = ? AND status IN ('settled','void') AND updated < ?", [GAME, Date.now() - KEEP_DAYS * 86400000]).catch(() => {});
  }
  return out;
}
async function expire(id, t) {
  const m = await G().load(GAME, id);
  if (!m) return { ok: false };
  if (m.status === "open" && m.closes < t.nowS) {
    m.status = "closed";
    await G().save(GAME, m);
    await emit("closed", m);
    return { ok: true };
  }
  if (m.status === "closed" && m.closes + SETTLE_GRACE < t.nowS && !(m.ai_judge && m.ai_hold)) {
    await pay(m, null, t, { why_code: "overdue" });
    return { ok: true };
  }
  return { ok: false };
}

// ── the website's /act forms (views/wagers.ejs, partials/aijudge.ejs) and /markets/:id bet / resolve ──
const JUDGE_RE = /(?:^|\s)(?:judged\s+by|judge|referee|ref|arbiter)\s*[:=]?\s+@?([^\s,;]+)/ig;
const OPTIONS_RE = /(?:^|\s)options?\s*[:=]?\s+(.+?)(?=\s+(?:judge|judged|ref|referee|arbiter|closes?|close|by)\b|$)/i;
const CLOSES_RE = /(?:^|\s)(?:closes?|close\s+in|by|betting\s+closes?)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)(?=$|[\s,.;!?])/i;
function durationSecs(n, unit) {
  const u = String(unit).toLowerCase();
  const mult = /^w/.test(u) ? 604800 : /^d/.test(u) ? 86400 : /^h/.test(u) ? 3600 : 60;
  return Math.round(Number(n) * mult);
}
/** _market_create's parsing of "<question> judge @x [options a/b/c] [closes 2d]". */
function parseCreate(text) {
  // 1.99ur: the website's create form adds pad:<pad id>, until:<unix s> (a picked close date) and tz:<zone>
  const tok = require("../markets").createTokens(String(text || ""));
  text = tok.text;
  const jm = [...text.matchAll(JUDGE_RE)];
  if (!jm.length) return { error: "Every pool needs a judge — add 'judge @someone' (they can't bet on it), or 'judge @pepe' to let Pepe decide it (experimental)." };
  const last = jm[jm.length - 1];
  const jword = last[1];
  text = (text.slice(0, last.index) + " " + text.slice(last.index + last[0].length)).trim();
  let options = null;
  const om = OPTIONS_RE.exec(text);
  if (om) {
    options = om[1].split(/\s*(?:\/|\||,)\s*/).map((o) => o.replace(/^[ .,;]+|[ .,;]+$/g, "")).filter(Boolean);
    text = (text.slice(0, om.index) + " " + text.slice(om.index + om[0].length)).trim();
  }
  let secs = DEFAULT_SECS;
  const cm = CLOSES_RE.exec(text);
  if (cm) { secs = durationSecs(cm[1], cm[2]); text = (text.slice(0, cm.index) + " " + text.slice(cm.index + cm[0].length)).trim(); }
  if (tok.until) secs = Math.round(tok.until - Date.now() / 1000);
  const ai = AI_WORDS.has(low(jword));
  return { question: text, options, secs, ai_judge: ai, judge: ai ? null : { login: jword.replace(/^@+/, "") },
           ...(tok.pad ? { pad: tok.pad } : {}), ...(tok.tz ? { tz: tok.tz } : {}) };
}
function fromForm(words, actor) {
  const w = words.map((x) => String(x));
  const sub = low(w[0]);
  if (sub === "new" || sub === "create") {
    const c = parseCreate(w.slice(1).join(" "));
    if (c.error) return c.error;
    if (!actor.login && !actor.username) return "Couldn't find your account.";
    return { verb: "create", args: c };
  }
  if (sub === "bet" || sub === "back") {
    if (w.length < 4) return "Pick an option and an amount.";
    return { verb: "bet", args: { ref: w[1], option: w[2], amount: amountOf(w[3]) } };
  }
  if (sub === "settle" || sub === "resolve") {
    if (w.length < 3) return "Pick the winning option (or void).";
    return { verb: "settle", args: { ref: w[1], outcome: w.slice(2).join(" ") } };
  }
  if (sub === "cancel") return { verb: "cancel", args: { ref: w[1] } };
  if (sub === "ai" || sub === "dispute") return { verb: "ai_request", args: { ref: w[1], sub, why: w.slice(2).join(" ") } };
  if (parseRef(w[0]) !== null && w.length >= 3) return { verb: "bet", args: { ref: w[0], option: w[1], amount: amountOf(w[2]) } };
  return null;                                                         // a read (!pool list / !pool M5): Pepe answers it
}
function amountOf(s) {
  const n = require("../public/js/patamount").parse(s);
  return Number.isFinite(n) ? n : 0;
}
function webReply(verb, res, args) {
  if (!res.ok) return res.error || "Something went wrong — nothing changed.";
  const m = res.pool || {};
  if (res.dup) return `Already done (${res.ref}).`;
  if (verb === "create") return `🎱 Pool ${res.ref} is open: "${m.question}" — ${(m.options || []).join(" / ")}. Betting closes in ${fmtSecs(res.secs || 0)}.`;
  if (verb === "bet") return res.already ? `Already placed (${res.ref}).` : `🎱 ${res.ref}: you're in for PAT ${fmt(res.mine)} on ${res.option}.`;
  if (verb === "settle" || verb === "cancel") {
    if (res.kind === "settled") return `🏆 ${res.ref}: ${res.result}! ${res.winners} winner(s) split PAT ${fmt(res.total - res.fee)}.`;
    if (res.kind === "refunded") return `${res.ref}: ${res.result}! ${res.note === "nobody" ? `nobody backed ${res.result}` : `everyone backed ${res.result}`} — every stake is refunded.`;
    return `↩️ ${res.ref} ${verb === "cancel" ? "cancelled" : "voided"} — everyone's refunded.`;
  }
  if (verb === "ai_request") return args && args.sub === "dispute" ? "Sent to Pepe's AI judge: your dispute." : "Asked Pepe's AI judge to look now.";
  return "Done.";
}

// ── the cutover (Pepe's markets.json pools <-> here) ──
function cleanImport(x) {
  const list = Array.isArray(x && x.pools) ? x.pools : Object.values((x && x.pools) || {});
  const records = [];
  for (const raw of list) {
    const id = Math.trunc(Number(raw && raw.id));
    if (!(id > 0)) throw new L.Refuse(400, "a pool without an id", "E_BAD_RECORD");
    if (raw.model === "lmsr") throw new L.Refuse(400, `M${id} is a share market - those stay on Pepe`, "E_BAD_RECORD");
    const st = String(raw.status || "");
    if (st === "settling") throw new L.Refuse(409, `M${id} is mid-step (settling) - let Pepe finish it first`, "E_BUSY");
    if (![...LIVE, ...RECENT].includes(st)) throw new L.Refuse(400, `M${id}: unknown status ${st.slice(0, 20)}`, "E_BAD_RECORD");
    if (!Array.isArray(raw.options) || raw.options.length < 2) throw new L.Refuse(400, `M${id}: bad options`, "E_BAD_RECORD");
    const bets = (Array.isArray(raw.bets) ? raw.bets : []).map((b) => {
      const amount = Math.floor(Number(b && b.amount));
      if (!(amount > 0) || !b.hold || !b.nick) throw new L.Refuse(400, `M${id}: a bet without its stake`, "E_BAD_RECORD");
      return Object.assign({}, b, { amount, hold: String(b.hold), ts: Math.floor(Number(b.ts) || 0) });
    });
    if (LIVE.includes(st) && bets.some((b) => !b.user)) throw new L.Refuse(400, `M${id}: a live bet without its PATV account`, "E_BAD_RECORD");
    const m = view(Object.assign({}, raw, { id, bets, created: Math.floor(Number(raw.created) || 0), closes: Math.floor(Number(raw.closes) || 0) }));
    m.bets = bets.map((b) => view({ bets: [b] }).bets[0]);
    m.bet_seq = bets.length;
    delete m.ai_hold;
    records.push(m);
  }
  return { records, seq: Math.trunc(Number(x && x.seq) || 0) };
}
function importTotals({ records }) {
  const holds = [];
  let sum = 0, count = 0;
  for (const m of records || []) {
    if (!LIVE.includes(m.status)) continue;
    count++;
    for (const b of m.bets || []) {
      holds.push({ id: String(b.hold), ref: `M${m.id}`, amount: b.amount });
      sum += b.amount;
    }
  }
  return { sum, count, holds };
}

module.exports = { GAME, LIVE, RECENT, READS, MIN_BET, FEE_PCT, SETTLE_GRACE, MAX_OPEN, act, read, due, expire, mirror, fromForm, webReply,
                   cleanImport, importTotals, parseCreate, view, payoutPlan, poolsOf, matchOption, oddsLine, fmtSecs };
