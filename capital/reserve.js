// capital/reserve.js — Phase 3: the Federal Reserve's loans to players (pepe_loan.py "LR" + Reserve loans) and the credit
// score (pepe_credit.py) owned by the site. P2P loans are NOT here (Phase 2: escrow/loans.js); they share the L numbering
// and count toward a borrower's limit / credit history exactly as they did in Pepe.
//
//   borrow   instant up to the borrower's limit (level, Reserve loans repaid, lates, the lender's room), else a request LR<n>
//   approve / deny / grant   admins; a loan bigger than the Bank's cash needs the Fed's flash liquidity: the answer is
//            "need_flash" {gap} and Pepe (who still runs the Fed, Phase 4) lends the Bank the gap, then calls again
//   repay    wallet -> the lender's pool (the Bank once the vaults are live, else the Reserve), principal AND interest
//   due      every COLLECT_EVERY s after the due date the site takes what it can, adds PENALTY_PCT a day on what's left
//            (capped at PENALTY_CAP_PCT of the principal), marks it LATE
//   default  a Bank-funded loan this many days late: v1 the Reserve insures the Bank (capped per 30 days) and takes the
//            claim; economy v2 (layers) the protocol's surplus in the Bank covers it (its shares burned at today's price)
//            and the rest is a Fed liquidity loan Pepe opens (event bank_default -> op default_ack)
// Records keep Pepe's loans.json shape; the borrower is the ACCOUNT (uids.borrower, 1.99tl) - the login is display only.
"use strict";
const C = require("./core");

const KIND = "loan", RKIND = "request";
const LENDER = "🏛️ Federal Reserve";
const OPEN = ["funding", "active"];
const PRUNE = ["repaid", "forgiven", "declined", "cancelled", "expired"];
const fmt = C.fmt;
const ref = (ln) => `L${ln.id}`;
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
const left = (ln) => Math.max(0, Math.trunc(ln.owed) - Math.trunc(ln.paid || 0));
/** Python round() (half to even) for the interest. */
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
function fmtSecs(secs) {
  secs = Math.max(0, Math.trunc(secs));
  if (secs >= 86400) { const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600); return `${d}d` + (h ? ` ${h}h` : ""); }
  if (secs >= 3600) { const m = Math.floor((secs % 3600) / 60); return `${Math.floor(secs / 3600)}h` + (m ? ` ${m}m` : ""); }
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}
function parseTerm(s) {
  if (typeof s === "number") return Math.trunc(s);
  const m = /^\s*(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h)\s*$/i.exec(String(s || ""));
  if (!m) return null;
  const u = m[2].toLowerCase();
  return Math.round(Number(m[1]) * (/^w/.test(u) ? 604800 : /^d/.test(u) ? 86400 : 3600));
}
function parseRef(t, prefix = "L") {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  if (prefix === "L" && s.startsWith("LR")) return null;
  const n = s.startsWith(prefix) ? s.slice(prefix.length) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}

// ── who ──
/** The borrower's account (stored userId first - records follow the account, not the login). */
async function borrowerAcct(ln) {
  const uid = (ln.uids || {}).borrower;
  if (uid) {
    const a = await C.account({ userId: uid });
    if (a) return a;
  }
  return C.account({ login: ln.borrower });
}
/** Is this loan's borrower the actor (account first, login as a fallback for records without one)? */
function isBorrower(ln, acct, login) {
  const uid = (ln.uids || {}).borrower;
  if (uid && acct && String(uid) === String(acct.userId)) return true;
  if (uid && acct) return false;
  return C.same(ln.borrower, login) || (acct && (C.same(ln.borrower, acct.camfrogUsername) || C.same(ln.borrower, acct.username)));
}
async function p2pLoans() {
  try { return await require("../escrow/games").list("loans"); } catch (e) { return []; }
}
const p2pIsBorrower = (ln, acct, login) => C.same(ln.borrower, login) || (acct && (C.same(ln.borrower, acct.camfrogUsername)
  || C.same((ln.users || {}).borrower, acct.username)));

// ── the credit score (pepe_credit.py, the same weights as credit.js) ──
const HIST = ["on_time", "late_repaid", "defaults", "late_now", "collections", "open_debt", "open_loans", "forgiven"];
const emptyHist = () => Object.fromEntries(HIST.map((k) => [k, 0]));
function loanOutcome(ln) {
  const st = ln.status;
  const lf = Math.max(0, Math.trunc(ln.owed || 0) - Math.trunc(ln.paid || 0));
  const collected = (ln.payments || []).some((p) => p.source === "auto-collect");
  if (st === "repaid") return [ln.was_late ? "late_repaid" : "on_time", collected, 0];
  if (st === "forgiven") return [ln.was_late ? "defaults" : "forgiven", collected, 0];
  if (st === "active" || st === "funding") {
    if (ln.written_off || ln.insured) return ["defaults", collected, lf];
    if (ln.late) return ["late_now", collected, lf];
    return ["open", collected, lf];
  }
  return [null, false, 0];
}
function historyAdd(h, ln) {
  const [bucket, collected, debt] = loanOutcome(ln);
  if (bucket === null) return h;
  if (bucket !== "open") h[bucket] = (h[bucket] || 0) + 1;
  if (bucket === "open" || bucket === "late_now" || (bucket === "defaults" && ["active", "funding"].includes(ln.status))) {
    h.open_loans = (h.open_loans || 0) + 1;
    h.open_debt = (h.open_debt || 0) + Math.trunc(debt);
  }
  if (collected) h.collections = (h.collections || 0) + 1;
  return h;
}
async function archive() { return C.doc("credit", {}); }
/** The closed-loan history a pruned loan leaves behind, keyed by the borrower's ACCOUNT (u:<userId>) or login (no account). */
function archiveKey(acct, login) { return acct ? `u:${acct.userId}` : `l:${C.low(login)}`; }
async function history(acct, login, ctx) {
  const ar = ctx && ctx.archive ? ctx.archive : await archive();
  const h = emptyHist();
  // the archive entries that are this person's: their account's, else (no account) their login's
  const keys = new Set([archiveKey(acct, login)]);
  if (!acct && login) keys.add(`l:${C.low(login)}`);
  for (const k of keys) for (const f of HIST) h[f] += Math.trunc(Number((((ar[k] || {}).h) || {})[f]) || 0);
  for (const ln of (ctx && ctx.loans) || await C.list(KIND)) if (isBorrower(ln, acct, login)) historyAdd(h, ln);
  for (const ln of (ctx && ctx.p2p) || await p2pLoans()) if (p2pIsBorrower(ln, acct, login)) historyAdd(h, ln);
  return h;
}
async function creditScore(acct, login, ctx) {
  const c = await C.cfg();
  const credit = require("../credit");
  const w = Object.assign({}, c.credit || {}, { capacity_base: Number(c.rloan_base), capacity_per_level: Number(c.rloan_per_level) });
  return credit.creditScore(w, await history(acct, login, ctx), acct ? acct.level : 0, acct ? credit.ageDays(acct.created_at) : null);
}
const explain = (cs, top = 3) => {
  const parts = cs.factors.filter((x) => x.points).slice(0, top).map((x) => `${x.label} (${x.points >= 0 ? "+" : ""}${x.points})`);
  return `${cs.score} ${cs.band}` + (parts.length ? " — " + parts.join(", ") : " — no loan history yet");
};

// ── the limit (pepe_loan _rloan_*) ──
async function source() {
  const c = await C.cfg();
  return Number(c.vaults_enabled) && (await require("./vaults").live()) ? "bank" : "reserve";
}
async function book(loans) {
  return loans.filter((ln) => OPEN.includes(ln.status)).reduce((t, ln) => t + Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0)), 0);
}
async function room(loans) {
  const c = await C.cfg();
  loans = loans || await C.list(KIND);
  if ((await source()) === "bank") {
    const bk = loans.filter((ln) => ln.funded_by === "bank" && OPEN.includes(ln.status))
      .reduce((t, ln) => t + Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0)), 0);
    const cash = await C.poolBalance("bank");
    const flash = c.layers && c.flash && c.flash.bank ? Math.trunc(Number(c.flash.room) || 0) : 0;
    const cap = Math.trunc(Number(c.rloan_book_share) * 4 * (cash + flash + bk));
    return Math.max(0, Math.min(cap - bk, cash + flash));
  }
  const bk = await book(loans);
  const res = await C.poolBalance("reserve");
  const cap = Math.trunc(Number(c.rloan_book_share) * (res + bk));
  return Math.max(0, Math.min(cap - bk, res));
}
async function calc(level, repaid, lates, rm) {
  const c = await C.cfg();
  const base = Math.trunc(Number(c.rloan_base)), bonus = Math.trunc(Number(c.rloan_per_level)) * Math.trunc(Number(level) || 0);
  const mult = Math.min(2.0, 1 + 0.25 * Math.trunc(Number(repaid) || 0));
  const penalty = 0.5 ** Math.trunc(Number(lates) || 0);
  const raw = (base + bonus) * mult * penalty;
  const limit = Math.trunc(Math.min(Math.trunc(Number(c.rloan_max_auto)), raw, rm));
  return { level: Math.trunc(Number(level) || 0), base, level_bonus: bonus, repaid, mult, lates, penalty, raw: Math.trunc(raw),
           max_auto: Math.trunc(Number(c.rloan_max_auto)), room: rm, limit: Math.max(0, Math.floor(limit / 100) * 100) };
}
async function factors(acct, login, ctx) {
  const loans = (ctx && ctx.loans) || await C.list(KIND);
  const past = loans.filter((ln) => isBorrower(ln, acct, login));
  const p2p = (ctx && ctx.p2p) || await p2pLoans();
  const late = past.some((ln) => ln.status === "active" && ln.late) || p2p.some((ln) => ln.status === "active" && ln.late && p2pIsBorrower(ln, acct, login));
  return { repaid: past.filter((ln) => ln.status === "repaid").length, lates: past.filter((ln) => ln.was_late).length,
           open: past.filter((ln) => OPEN.includes(ln.status)).length, late };
}
async function reasonOf(f) {
  const c = await C.cfg();
  if (!Number(c.rloan_enabled)) return "Reserve loans are switched off right now";
  if (f.late) return "you're late on a loan — pay it off first";
  if (f.open >= Number(c.rloan_max_open)) return "you already have a Reserve loan open — repay it first";
  return null;
}
async function limitFor(acct, login) {
  const f = await factors(acct, login);
  const why = await reasonOf(f);
  if (why) return [0, why, f];
  return [(await calc(acct ? acct.level : 0, f.repaid, f.lates, await room())).limit, null, f];
}
function owedFor(principal, term, rateWeek) {
  const days = Math.max(1.0, term / 86400);
  return principal + Math.trunc(pyRound(principal * Number(rateWeek) * days / 7));
}
async function terms(a) {
  const c = await C.cfg();
  const principal = Math.trunc(Number(a.amount) || 0);
  if (!(principal >= Number(c.loan_min))) return fail("min", `Reserve loans start at PAT ${fmt(c.loan_min)}.`);
  const secs = parseTerm(a.term === undefined || a.term === null || a.term === "" ? "7d" : a.term);
  if (!secs || secs < 86400 || secs > Number(c.rloan_max_days) * 86400) return fail("bad_term", `give a term from 1d to ${Math.trunc(Number(c.rloan_max_days))}d, e.g. 7d.`);
  let rate = Number(c.rloan_rate_week);
  if (a.rate !== undefined && a.rate !== null && a.rate !== "") {
    const m = /^(\d+(?:\.\d+)?)%?$/.exec(String(a.rate).trim());
    if (!m) return fail("bad_rate", "give the rate as % per week, e.g. 3%.");
    rate = Number(m[1]) / 100;
  }
  return { ok: true, principal, secs, rate };
}

// ── the display: wallet_snapshots "loans" (wallet.js /wallet, credit.js) - Reserve loans + requests + limits, P2P rows kept ──
function snapLoan(ln) {
  return { id: ln.id, lender: LENDER, borrower: String(ln.borrower || "").slice(0, 60), principal: Math.trunc(ln.principal), rate: Number(ln.rate) || 0,
           rate_basis: ln.rate_basis || "week", term: Number(ln.term) || 0, owed: Math.trunc(ln.owed), paid: Math.trunc(ln.paid || 0),
           penalty: Math.trunc(ln.penalty || 0), status: ln.status, late: !!ln.late, reserve: true, created: Number(ln.created) || null,
           due: Number(ln.due) || null, ended: Number(ln.ended) || null, offer_until: null };
}
async function publish() {
  const { runQuery, getQuery } = require("../dbUtils");
  await runQuery("CREATE TABLE IF NOT EXISTS wallet_snapshots (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
  const c = await C.cfg();
  const loans = await C.list(KIND);
  const reqs = await C.list(RKIND);
  const p2p = await p2pLoans();
  const ar = await archive();
  const ctx = { loans, p2p, archive: ar };
  const r = (await getQuery("SELECT data FROM wallet_snapshots WHERE key = 'loans'"))[0];
  const old = r ? C.parse(r.data, {}) : {};
  const rows = (Array.isArray(old.loans) ? old.loans : []).filter((l) => l && !l.reserve).concat(loans.map(snapLoan));
  const rm = await room(loans);
  const info = { rate_week: Number(c.rloan_rate_week), max_days: Math.trunc(Number(c.rloan_max_days)), enabled: !!Number(c.rloan_enabled),
                 book: await book(loans), room: rm, base: Math.trunc(Number(c.rloan_base)), per_level: Math.trunc(Number(c.rloan_per_level)),
                 max_auto: Math.trunc(Number(c.rloan_max_auto)), max_open: Math.trunc(Number(c.rloan_max_open)), min: Math.trunc(Number(c.loan_min)),
                 credit: Object.assign({}, c.credit || require("../credit").DEFAULT_W, { capacity_base: Number(c.rloan_base), capacity_per_level: Number(c.rloan_per_level) }),
                 limits: {} };
  const names = new Set(loans.map((l) => C.low(l.borrower)).concat(p2p.map((l) => C.low(l.borrower))).filter(Boolean));
  for (const nick of names) {
    const ln = loans.find((l) => C.same(l.borrower, nick));
    const acct = ln ? await borrowerAcct(ln) : await C.account({ login: nick });
    const f = await factors(acct, nick, ctx);
    f.reason = await reasonOf(f);
    f.credit = await history(acct, nick, ctx);
    info.limits[nick] = f;
    if (acct && acct.camfrogUsername) info.limits[C.low(acct.camfrogUsername)] = f;
  }
  const snap = { loans: rows, requests: reqs.map((q) => Object.assign({}, q)), reserve: info };
  await runQuery(`INSERT INTO wallet_snapshots (key, data, updated) VALUES ('loans', ?, ?)
                  ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [JSON.stringify(snap), Date.now()]);
}

// ── PAT moves (in the caller's transaction) ──
async function issue(actor, borrowerLogin, principal, secs, rate, t, { by, request = null, flashDone = false, room: roomName = null }) {
  const acct = await C.account({ userId: actor.target_userId, login: borrowerLogin });
  if (!acct) return fail("no_account", "I couldn't find a PAT account for that.");
  const src = await source();
  const cash = await C.poolBalance(src);
  if (principal > cash) {
    const c = await C.cfg();
    const gap = principal - cash;
    if (src === "bank" && c.layers && c.flash && c.flash.bank && gap <= Math.trunc(Number(c.flash.room) || 0) && !flashDone) {
      return fail("need_flash", `the Bank holds PAT ${fmt(cash)} - the Fed's flash liquidity would lend it the ${fmt(gap)} gap.`, { gap, cash });
    }
    return fail("short", `the ${src === "bank" ? "Bank" : "Reserve"} only holds PAT ${fmt(cash)}.`, { cash });
  }
  const owed = owedFor(principal, secs, rate);
  const id = await C.nextId("loan");
  const ln = { id, lender: LENDER, borrower: String(borrowerLogin || acct.camfrogUsername || acct.username).slice(0, 60), principal,
               rate: Math.round(rate * 100 * 100) / 100, rate_basis: "week", term: secs, owed, paid: 0, penalty: 0, status: "active",
               room: roomName === null ? actor.room || null : roomName, created: t.nowS, reserve: true, approved_by: by, request,
               holds: {}, payments: [], funded_by: src, uids: { borrower: acct.userId }, users: { borrower: acct.username },
               accepted: t.nowS, due: t.nowS + secs };
  await C.legs(`cap:rloan:${id}`, [{ pool: src, amount: -principal }], { kind: "capital", flow: "reserve_loan", why: `reserve-loan (L${id})` });
  await C.wallet(acct.userId, principal, "reserve-loan", { counterparty: LENDER, source: `capital:L${id}` });
  await C.save(KIND, ln, ln.due);
  await C.emit("loan_issued", ln.room, { ref: ref(ln), loan: ln, by, notify: actor.login });
  return { ok: true, ref: ref(ln), loan: ln, owed };
}
/** Take `amount` from the borrower toward the loan, straight to the lender's pool. -> [paid, error] */
async function takePayment(ln, amount, source, t, key) {
  const acct = await borrowerAcct(ln);
  if (!acct) return [0, "the borrower has no PAT account"];
  try {
    await C.wallet(acct.userId, -amount, "loan-repayment", { counterparty: LENDER, source: `capital:${ref(ln)}` });
  } catch (e) {
    if (C.isRefuse(e) && e.code === "E_INSUFFICIENT_PAT") return [0, "insufficient PAT"];
    throw e;
  }
  const principalLeft = Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0));
  const interest = Math.max(0, amount - principalLeft);
  ln.paid = Math.trunc(ln.paid || 0) + amount;
  ln.payments = (ln.payments || []).concat([{ hold: null, key, amount, interest, source, ts: t.nowS }]);
  if (!ln.uids || !ln.uids.borrower) ln.uids = Object.assign({}, ln.uids || {}, { borrower: acct.userId });
  if (ln.paid >= ln.owed) { ln.status = "repaid"; ln.ended = t.nowS; ln.late = false; }
  const pool = ln.funded_by || "reserve";
  await C.legs(`cap:rpay:${key}`, [{ pool, amount }], { kind: "capital", flow: "reserve_loan_repay", why: `loan repayment (${ref(ln)})` });
  if (pool === "bank") await C.emit("bank_repaid", null, { ref: ref(ln), amount, key });       // Pepe repays the Bank's Fed flash loans from it
  return [amount, null];
}

// ── verbs ──
async function borrow(actor, a, t) {
  const tt = await terms(a);
  if (!tt.ok) return tt;
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
  if (!acct) return fail("no_account", "I couldn't find a PAT account for that.");
  const [limit, why] = await limitFor(acct, actor.login);
  if (why) return fail("refused", why);
  const ctx = { loans: await C.list(KIND), p2p: await p2pLoans() };
  if (tt.principal <= limit) {
    const twin = ctx.loans.find((ln) => isBorrower(ln, acct, actor.login) && ln.principal === tt.principal && ln.term === tt.secs && t.nowS - Number(ln.created) < 120);
    if (twin) return fail("dup", `you took that Reserve loan ${Math.trunc(t.nowS - twin.created)}s ago (${ref(twin)}) — not doubled.`, { ref: ref(twin) });
    const r = await issue(Object.assign({}, actor, { target_userId: acct.userId }), actor.login || acct.camfrogUsername, tt.principal, tt.secs, tt.rate, t,
                          { by: "auto", flashDone: !!a.flash_done });
    if (r.ok) r.credit = explain(await creditScore(acct, actor.login, ctx), 2);
    return r;
  }
  const rq = await request(actor, a, t);
  return Object.assign(rq, { over_limit: true, limit });
}
async function request(actor, a, t) {
  const tt = await terms(a);
  if (!tt.ok) return tt;
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
  const f = await factors(acct, actor.login);
  if (f.late) return fail("late", "you're late on a loan — pay it off before asking the Reserve.");
  const pend = (await C.list(RKIND, ["pending", "approving"])).find((r) => (acct && r.uid && r.uid === acct.userId) || C.same(r.nick, actor.login));
  if (pend) return fail("pending", `you already have request LR${pend.id} waiting.`, { ref: `LR${pend.id}` });
  const id = Math.trunc(Number((await C.meta("seq:request")) || 0)) + 1;
  await C.setMeta("seq:request", id);
  const cs = await creditScore(acct, actor.login);
  const r = { id, nick: String(actor.login || (acct && acct.camfrogUsername) || (acct && acct.username) || "").slice(0, 60), amount: tt.principal, term: tt.secs,
              why: String(a.why || "").slice(0, 160), status: "pending", created: t.nowS, room: actor.room || null, credit: cs.score, credit_band: cs.band,
              uid: acct ? acct.userId : null };
  await C.save(RKIND, r);
  await C.emit("loan_request", r.room, { ref: `LR${id}`, request: r, credit: explain(cs, 3) });
  return { ok: true, ref: `LR${id}`, request: r, credit: explain(cs, 2) };
}
async function approveLike(actor, a, t, grant) {
  if (!actor.admin) return fail("forbidden", "only admins can do that.");
  let r = null, who = null, uid = null;
  if (grant) {
    who = String((a.who && a.who.login) || a.who || "").replace(/^@+/, "");
    if (!who) return fail("bad_who", "who?");
    uid = (a.who && a.who.userId) || null;
  } else {
    const n = parseRef(a.ref, "LR");
    r = n === null ? null : await C.load(RKIND, n);
    if (!r || r.status !== "pending") return fail("no_request", `no pending request ${String(a.ref || "?").toUpperCase()}.`);
    who = r.nick;
    uid = r.uid || null;
  }
  const tt = await terms({ amount: a.amount !== undefined && a.amount !== null && a.amount !== "" ? a.amount : r && r.amount,
                           term: a.term || (r ? `${Math.max(1, Math.trunc(r.term / 86400))}d` : "7d"), rate: a.rate });
  if (!tt.ok) return tt;
  const res = await issue(Object.assign({}, actor, { target_userId: uid }), who, tt.principal, tt.secs, tt.rate, t,
                          { by: actor.login || actor.username, request: r ? r.id : null, flashDone: !!a.flash_done, room: actor.room || null });
  if (!res.ok) return res;
  if (r) {
    Object.assign(r, { status: "approved", by: actor.login || actor.username, loan: res.loan.id, decided: t.nowS });
    await C.save(RKIND, r);
  }
  return Object.assign(res, { request: r });
}
async function deny(actor, a, t) {
  if (!actor.admin) return fail("forbidden", "only admins can do that.");
  const n = parseRef(a.ref, "LR");
  const r = n === null ? null : await C.load(RKIND, n);
  if (!r || r.status !== "pending") return fail("no_request", `no pending request ${String(a.ref || "?").toUpperCase()}.`);
  Object.assign(r, { status: "denied", by: actor.login || actor.username, decided: t.nowS, deny_why: String(a.why || "").slice(0, 160) });
  await C.save(RKIND, r);
  await C.emit("loan_denied", r.room, { ref: `LR${r.id}`, request: r });
  return { ok: true, ref: `LR${r.id}`, request: r };
}
async function repay(actor, a, t) {
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login });
  let ln = null;
  const n = parseRef(a.ref);
  if (n !== null) ln = await C.load(KIND, n);
  else {
    const mine = (await C.list(KIND, ["active"])).filter((x) => isBorrower(x, acct, actor.login));
    if (mine.length === 1) ln = mine[0];
    else return fail("which", "which loan? " + (mine.map(ref).join(", ") || "you don't owe anything."), { refs: mine.map(ref) });
  }
  if (!ln) return fail("no_loan", `no Reserve loan ${String(a.ref || "?").toUpperCase()}.`);
  if (ln.status !== "active" || !(isBorrower(ln, acct, actor.login) || actor.admin && a.for_borrower)) return fail("not_yours", `you don't have an open loan ${ref(ln)}.`);
  const lf = left(ln);
  let amount = a.amount === undefined || a.amount === null || a.amount === "" ? lf : Math.trunc(Number(a.amount) || 0);
  if (!(amount > 0)) return fail("bad_amount", "how much? e.g. !loan repay L5 10k (or leave it off to pay it all).");
  amount = Math.min(amount, lf);
  const [paid, err] = await takePayment(ln, amount, "repay", t, t.key);
  if (!paid) return fail("insufficient", `couldn't repay — ${err}.`);
  await C.save(KIND, ln, ln.status === "active" ? ln.due : null);
  await C.emit(ln.status === "repaid" ? "loan_repaid" : "loan_paid", ln.room, { ref: ref(ln), loan: ln, by: actor.login, amount: paid, left: left(ln), via: actor.via });
  return { ok: true, ref: ref(ln), loan: ln, paid, left: left(ln) };
}
async function forgive(actor, a, t) {
  if (!actor.admin) return fail("forbidden", "you have no open loan to forgive.");
  const n = parseRef(a.ref);
  const ln = n === null ? null : await C.load(KIND, n);
  if (!ln || ln.status !== "active") return fail("no_loan", `you have no open loan ${String(a.ref || "?").toUpperCase()} to forgive.`);
  const lf = left(ln);
  Object.assign(ln, { status: "forgiven", late: false, ended: t.nowS });
  await C.save(KIND, ln);
  await C.emit("loan_forgiven", ln.room, { ref: ref(ln), loan: ln, by: actor.login, left: lf });
  return { ok: true, ref: ref(ln), loan: ln, left: lf };
}
async function defaultAck(actor, a) {
  if (!actor.pepe) return fail("forbidden", "Pepe only.");
  const V = require("./vaults");
  const d = await V.load();
  const rec = (d.v2_defaults || {})[String(a.key || "")];
  if (!rec) return fail("no_default", "no such default record");
  rec.state = "done";
  rec.fed_loan_done = C.nowS();
  await V.store(d);
  return { ok: true, key: a.key };
}

// ── reads ──
async function read(verb, actor, a) {
  const acct = await C.account({ userId: actor.userId, username: actor.username, login: actor.login || (a.who && a.who.login) });
  if (verb === "info" || verb === "limit") {
    const login = (a.who && a.who.login) || actor.login;
    const who = a.who ? await C.account({ login }) : acct;
    const [limit, why, f] = await limitFor(who, login);
    const c = await C.cfg();
    const mine = (await C.list(KIND, OPEN)).filter((ln) => isBorrower(ln, who, login));
    return { limit, why, factors: f, rate_week: Number(c.rloan_rate_week), max_days: Math.trunc(Number(c.rloan_max_days)), loans: mine,
             credit: explain(await creditScore(who, login), 2), room: await room() };
  }
  if (verb === "credit") {
    const login = (a.who && a.who.login) || actor.login;
    const who = a.who ? await C.account({ login }) : acct;
    return { credit: await creditScore(who, login), line: explain(await creditScore(who, login), Number(a.top) || 3) };
  }
  if (verb === "requests") {
    if (!actor.admin) return { requests: [] };
    return { requests: await C.list(RKIND, ["pending"]), room: await room() };
  }
  return {};
}
async function act(verb, actor, a, t) {
  if (verb === "borrow") return borrow(actor, a, t);
  if (verb === "request") return request(actor, a, t);
  if (verb === "approve") return approveLike(actor, a, t, false);
  if (verb === "grant") return approveLike(actor, a, t, true);
  if (verb === "deny") return deny(actor, a, t);
  if (verb === "repay") return repay(actor, a, t);
  if (verb === "forgive") return forgive(actor, a, t);
  if (verb === "default_ack") return defaultAck(actor, a, t);
  return fail("bad_verb", `unknown loan verb ${verb}`);
}
const READS = ["info", "limit", "credit", "requests"];

// ── the tick: collection, penalties, late marks; Bank defaults; pruning ──
async function due(nowS) {
  const out = [];
  for (const ln of await C.list(KIND, ["active"])) {
    if (Number(ln.due) < nowS && nowS >= Number(ln.next_collect || 0)) out.push(ln.id);
  }
  return out;
}
async function collect(id, t) {
  const c = await C.cfg();
  const ln = await C.load(KIND, id);
  if (!ln || ln.status !== "active" || !(Number(ln.due) < t.nowS) || t.nowS < Number(ln.next_collect || 0)) return { ok: false };
  ln.next_collect = t.nowS + Number(c.collect_every);
  const daysLate = Math.trunc(require("./lmsr").pyFloorDiv(t.nowS - Number(ln.due), 86400));
  const cap = Math.floor(Math.trunc(ln.principal) * Number(c.penalty_cap_pct) / 100);
  while ((ln.penalty_days || 0) < daysLate && (ln.penalty || 0) < cap) {
    const add = Math.min(Math.floor(left(ln) * Number(c.penalty_pct) / 100), cap - (ln.penalty || 0));
    ln.penalty = (ln.penalty || 0) + add;
    ln.owed = Math.trunc(ln.owed) + add;
    ln.penalty_days = (ln.penalty_days || 0) + 1;
  }
  if ((ln.penalty_days || 0) < daysLate) ln.penalty_days = daysLate;
  let took = 0;
  const lf = left(ln);
  if (lf > 0) {
    const acct = await borrowerAcct(ln);
    const bal = acct ? Number((await require("../dbUtils").getQuery("SELECT points_balance FROM users WHERE userId = ?", [acct.userId]))[0].points_balance) || 0 : 0;
    const amount = Math.min(lf, Math.max(0, Math.trunc(bal)));
    if (amount > 0) [took] = await takePayment(ln, amount, "auto-collect", t, `collect:${ln.id}:${Math.trunc(t.nowS)}`);
  }
  let kind = null;
  if (ln.status === "repaid") kind = "collected_paid";
  else if (!ln.late) { ln.late = true; ln.was_late = true; kind = "late"; }
  else if (took) kind = "collected";
  await C.save(KIND, ln, ln.status === "active" ? ln.next_collect : null);
  if (kind) await C.emit(`loan_${kind}`, ln.room, { ref: ref(ln), loan: ln, took, left: left(ln) });
  return { ok: true };
}
/** Bank-funded loans in default (BANK_DEFAULT_DAYS past due): v1 Reserve insurance, or the economy v2 cover. */
async function defaults(t) {
  const c = await C.cfg();
  const V = require("./vaults");
  const out = [];
  for (const ln of await C.list(KIND, ["active"])) {
    if (ln.funded_by !== "bank" || ln.insured || ln.written_off) continue;
    if (t.nowS - Number(ln.due || t.nowS) < Number(c.bank_default_days) * 86400) continue;
    const unpaid = Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0));
    if (unpaid <= 0) continue;
    out.push({ id: ln.id, unpaid });
  }
  return out;
}
async function defaultOne(id, t) {
  const c = await C.cfg();
  const V = require("./vaults");
  const ln = await C.load(KIND, id);
  if (!ln || ln.status !== "active" || ln.funded_by !== "bank" || ln.insured || ln.written_off) return { ok: false };
  const unpaid = Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0));
  if (unpaid <= 0 || t.nowS - Number(ln.due) < Number(c.bank_default_days) * 86400) return { ok: false };
  const d = await V.load();
  if (c.layers) {
    // economy v2 (pepe_layers._v2_bank_default): the protocol's value above the Bank's target absorbs it first, the rest is a
    // Fed liquidity loan Pepe opens (he still runs the Fed). Needs his policy numbers fresh.
    if ((await C.cfgAge()) > 7200 || !c.targets || c.targets.bank === undefined) return { ok: false, waiting: "policy state from Pepe is stale" };
    const key = `L${ln.id}`;
    d.v2_defaults = d.v2_defaults || {};
    if (d.v2_defaults[key]) return { ok: false };
    const ctx = await V.ctx();
    const prices = V.prices(d, ctx);
    const nav = V.nav("bank", ctx);
    const prot = Number(((d.v.bank || {}).holders || {}).protocol || 0) * prices.bank;
    const surplus = Math.max(0, Math.min(nav - Number(c.targets.bank), prot));
    const cover = Math.min(unpaid, Math.trunc(surplus));
    const need = unpaid - cover;
    const loan = Math.min(need, Math.max(0, Math.trunc(Number(c.fl_room) || 0)));
    const rec = { loan_id: ln.id, unpaid, nav: Math.trunc(nav), target: Math.trunc(Number(c.targets.bank)), protocol_value: Math.trunc(prot),
                  surplus: Math.trunc(surplus), cover, fed_loan: loan, written_off: need - loan, price: prices.bank, ts: t.nowS,
                  state: loan > 0 ? "fed" : "done" };
    if (cover) {
      const st = d.v.bank;
      const sh = cover / prices.bank;
      st.holders.protocol = Number(st.holders.protocol || 0) - sh;
      st.total = Number(st.total) - sh;
      rec.shares_burned = sh;
    }
    d.v2_defaults[key] = rec;
    await V.store(d);
    Object.assign(ln, { insured: t.nowS, insured_by: "v2", v2_cover: { surplus: cover, fed_loan: loan, written_off: need - loan } });
    await C.save(KIND, ln, ln.due);
    await C.emit("bank_default", null, { ref: ref(ln), key, rec });
    return { ok: true };
  }
  const cut = t.nowS - 30 * 86400;
  d.insured = (d.insured || []).filter((x) => Number(x[0]) > cut);
  const used = d.insured.reduce((s, x) => s + Number(x[1]), 0);
  if (used + unpaid <= Number(c.bank_insurance_cap) && (await C.poolBalance("reserve")) >= unpaid) {
    await C.legs(`cap:insure:L${ln.id}`, [{ pool: "reserve", amount: -unpaid }, { pool: "bank", amount: unpaid }], { kind: "capital", flow: "bank_insurance", why: `loan default insurance (L${ln.id})` });
    Object.assign(ln, { insured: t.nowS, funded_by: "reserve" });
    d.insured.push([t.nowS, unpaid]);
    await C.emit("bank_insured", null, { ref: ref(ln), unpaid });
  } else {
    ln.written_off = t.nowS;
    await C.emit("bank_written_off", null, { ref: ref(ln), unpaid });
  }
  await V.store(d);
  await C.save(KIND, ln, ln.due);
  return { ok: true };
}
/** Closed loans 90 days old leave the book; their outcome rolls into the borrower's credit archive (never lost). */
async function prune(t) {
  const cut = t.nowS - 90 * 86400;
  const ar = await archive();
  let n = 0;
  for (const ln of await C.list(KIND, PRUNE)) {
    if (Number(ln.ended || t.nowS) >= cut) continue;
    const acct = await borrowerAcct(ln);
    const k = archiveKey(acct, ln.borrower);
    const e = ar[k] || { h: emptyHist(), login: C.low(ln.borrower) };
    const [bucket, collected] = loanOutcome(ln);
    if (bucket && bucket !== "open") e.h[bucket] = (e.h[bucket] || 0) + 1;
    if (collected) e.h.collections = (e.h.collections || 0) + 1;
    e.h.open_debt = 0; e.h.open_loans = 0;
    ar[k] = e;
    await C.remove(KIND, ln.id);
    n++;
  }
  if (n) await C.putDoc("credit", ar);
  return n;
}

// ── the website's forms (/wallet: the Reserve card) ──
async function fromForm(userId, words) {
  const w = words.map((x) => String(x == null ? "" : x).trim());
  const sub = C.low(w[0]);
  const u = (await require("../dbUtils").getQuery("SELECT userId, username, camfrogUsername, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return "Couldn't find your account.";
  const actor = { userId: u.userId, username: u.username, login: u.camfrogUsername || u.username, admin: u.class === "Admin", via: "web" };
  const amt = (x) => require("../public/js/patamount").parse(x);
  let verb, args;
  if (["reserve", "fed", "bank"].includes(sub) && w.length > 1) { verb = "borrow"; args = { amount: amt(w[1]), term: w[2] || "7d" }; }
  else if (sub === "request") { verb = "request"; args = { amount: amt(w[1]), term: w[2] || "7d", why: w.slice(3).join(" ") }; }
  else if (["repay", "pay"].includes(sub) && /^l\d+$/i.test(w[1] || "")) {
    const n = parseRef(w[1]);
    if (!(await C.load(KIND, n))) return null;                         // a P2P loan: escrow/loans.js
    verb = "repay"; args = { ref: w[1], amount: w[2] ? amt(w[2]) : undefined };
  } else if (["approve", "deny", "grant"].includes(sub)) {
    verb = sub;
    args = sub === "grant" ? { who: { login: w[1] }, amount: amt(w[2]), term: w[3], rate: w[4] } : { ref: w[1], amount: w[2] ? amt(w[2]) : undefined, term: w[3], rate: w[4], why: w.slice(2).join(" ") };
  } else return null;
  const res = await require("./service").act("reserve", { verb, actor, args, idem: null });
  if (!res.ok) {
    if (res.code === "need_flash") return "The Bank needs Fed liquidity for that right now - ask in a Camfrog room (!loan reserve), or borrow less.";
    return res.error || "Something went wrong — nothing changed.";
  }
  if (verb === "borrow" && res.loan) return `🏛️ Loan ${res.ref}: PAT ${fmt(res.loan.principal)} from the Federal Reserve is in your wallet — you owe PAT ${fmt(res.loan.owed)} within ${fmtSecs(res.loan.term)}.`;
  if (res.request && (verb === "borrow" || verb === "request")) return `🏛️ Request ${res.ref} sent: PAT ${fmt(res.request.amount)} for ${fmtSecs(res.request.term)}. An admin will approve or deny it.`;
  if (verb === "repay") return res.loan.status === "repaid" ? `✅ Loan ${res.ref} is paid off.` : `Paid PAT ${fmt(res.paid)} on ${res.ref} — PAT ${fmt(res.left)} left.`;
  if (verb === "deny") return `Request ${res.ref} denied.`;
  return `🏛️ ${res.ref} paid out: PAT ${fmt(res.loan.principal)} to ${res.loan.borrower}, owes PAT ${fmt(res.loan.owed)}.`;
}

module.exports = { KIND, RKIND, LENDER, OPEN, act, read, READS, due, collect, defaults, defaultOne, prune, publish, history, creditScore, explain,
                   room, calc, limitFor, factors, owedFor, borrowerAcct, isBorrower, left, ref, pyRound, parseTerm, fromForm, snapLoan, loanOutcome, historyAdd };
