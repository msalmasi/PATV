// escrow/loans.js — 1.99ou Phase 2: player-to-player PAT loans owned by the site (Pepe's pepe_loan.py P2P rules, exactly).
//
//   offer    the lender's principal goes into a ledger hold now; the borrower has OFFER_SECS to accept (the hold is settled to
//            them: they get the principal and owe principal + int(principal * rate / 100) within the term) or decline.
//   repay    the borrower pays some or all: the payment is held from them and settled to the lender in the SAME transaction,
//            minus RESERVE_CUT_PCT of whatever of it is BEYOND the principal (interest + penalties), routed by the
//            "loan_interest" row (Pepe's published shares). The principal is never taxed.
//   due      every COLLECT_EVERY seconds after the due date the site takes up to what the borrower has (balance read inside the
//            transaction), adds PENALTY_PCT a day on what's still owed (capped at PENALTY_CAP_PCT of the principal) and marks the
//            loan LATE until it's square.
//   forgive  the lender writes off what's left.
//   ids      L<n>: the site owns the L sequence while loans are live here. Federal Reserve loans stay in Pepe (Phase 3) but share
//            the sequence: his Reserve-loan issue takes its id from the keyed `reserve_id` verb, so ids never collide.
// Record (Pepe's shape): {id, lender, borrower, principal, rate, term, owed, paid, penalty, penalty_days, status
//          offered|active|repaid|forgiven|declined|cancelled|expired, room, created, offer_until, accepted, due, ended, late,
//          was_late, next_collect, holds: {principal: hid}, payments: [{hold, amount, interest, source, ts}],
//          users: {lender: PATV username, borrower: ...}, via}     (times in seconds)
// The website's /wallet reads loans from wallet_snapshots "loans" (Pepe's /api/wallet/loans): mirror() keeps this engine's
// records in that snapshot (and wallet.js merges Pepe's Reserve loans with these when he publishes).
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const L = require("./ledger");

const GAME = "loans";
const MIN = 1000;
const MAX_RATE = 50;
const MAX_SECS = 90 * 86400;
const MIN_SECS = 3600;
const OFFER_SECS = 600;
const RESERVE_CUT_PCT = 10;
const PENALTY_PCT = 2;
const PENALTY_CAP_PCT = 50;
const COLLECT_EVERY = 600;
const MAX_BORROWED = 5;
const DUP_SECS = 120;
const KEEP_DAYS = 90;
const LIVE = ["offered", "active"];
const RECENT = ["repaid", "forgiven", "declined", "cancelled", "expired"];

const G = () => require("./games");
const ref = (ln) => `L${ln.id}`;
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
function parseRef(t) {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  if (s.startsWith("LR")) return null;
  const n = s.startsWith("L") ? s.slice(1) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}
const left = (ln) => Math.max(0, ln.owed - (ln.paid || 0));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
/** Pepe's _fmt_secs */
function fmtSecs(secs) {
  secs = Math.max(0, Math.trunc(secs));
  if (secs >= 86400) { const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600); return `${d}d` + (h ? ` ${h}h` : ""); }
  if (secs >= 3600) { const m = Math.floor((secs % 3600) / 60); return `${Math.floor(secs / 3600)}h` + (m ? ` ${m}m` : ""); }
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

// ── the display: wallet_snapshots "loans" (wallet.js /wallet, credit.js) in Pepe's /api/wallet/loans shape ──
function snapLoan(ln) {
  return { id: ln.id, lender: String(ln.lender || "").slice(0, 60), borrower: String(ln.borrower || "").slice(0, 60), principal: Math.floor(ln.principal || 0),
           rate: Number(ln.rate) || 0, rate_basis: "flat", term: Number(ln.term) || 0, owed: Math.floor(ln.owed || 0), paid: Math.floor(ln.paid || 0),
           penalty: Math.floor(ln.penalty || 0), status: ln.status, late: !!ln.late, reserve: false, created: Number(ln.created) || null,
           due: Number(ln.due) || null, ended: Number(ln.ended) || null, offer_until: Number(ln.offer_until) || null };
}
let snapReady = null;
async function mirror(ln) {
  if (!snapReady) snapReady = runQuery("CREATE TABLE IF NOT EXISTS wallet_snapshots (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
  await snapReady;
  const r = (await getQuery("SELECT data FROM wallet_snapshots WHERE key = 'loans'"))[0];
  let data = { loans: [], requests: [], reserve: null };
  if (r) { try { data = JSON.parse(r.data) || data; } catch (e) { /* a broken snapshot is replaced */ } }
  if (!Array.isArray(data.loans)) data.loans = [];
  const row = snapLoan(ln);
  const i = data.loans.findIndex((l) => Number(l.id) === row.id);
  if (i >= 0) data.loans[i] = row; else data.loans.push(row);
  await runQuery(`INSERT INTO wallet_snapshots (key, data, updated) VALUES ('loans', ?, ?)
                  ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [JSON.stringify(data), Date.now()]);
}
/** Pepe's /api/wallet/loans while loans are live here: his Reserve loans + this engine's P2P records (his P2P rows are a mirror). */
async function mergeSnapshot(loans) {
  const mine = (await G().list(GAME)).map(snapLoan);
  const ids = new Set(mine.map((l) => l.id));
  return (Array.isArray(loans) ? loans : []).filter((l) => l && l.reserve && !ids.has(Number(l.id))).concat(mine);
}
/** Pepe's Reserve loans as he last published them (open-loan count / late marks the site can't see otherwise). */
async function reserveLoans() {
  const r = (await getQuery("SELECT data FROM wallet_snapshots WHERE key = 'loans'").catch(() => []))[0];
  if (!r) return [];
  try { return (JSON.parse(r.data).loans || []).filter((l) => l && l.reserve); } catch (e) { return []; }
}

const view = (ln) => {
  const out = {};
  for (const k of ["id", "lender", "borrower", "principal", "rate", "term", "owed", "paid", "penalty", "penalty_days", "status", "room", "created",
                   "offer_until", "accepted", "due", "ended", "late", "was_late", "next_collect", "holds", "payments", "users"]) if (ln[k] !== undefined) out[k] = ln[k];
  return out;
};
async function emit(kind, ln, extra) {
  await L.emitInTx(GAME, kind, ln.room || null, Object.assign({ ref: ref(ln), loan: view(ln) }, extra || {}));
}
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
const borrowerOf = (ln) => ({ login: ln.borrower, user: (ln.users || {}).borrower });
const lenderOf = (ln) => ({ login: ln.lender, user: (ln.users || {}).lender });

// ── actions ──
async function offer(actor, a, t) {
  const who = a.borrower && a.borrower.login ? String(a.borrower.login).replace(/^@+/, "") : null;
  if (!who) return fail("bad_borrower", "Who are you lending to?");
  const me = { login: actor.login || actor.username, user: actor.username };
  if (G().isWho(actor, { login: who, user: who }) || G().same(who, me.login)) return fail("self", "You can't lend to yourself.");
  const principal = Math.floor(Number(a.principal));
  if (!(principal >= MIN)) return fail("min", `Loans start at PAT ${fmt(MIN)}.`, { min: MIN });
  let rate = Number(a.rate);
  if (!Number.isFinite(rate) || rate < 0) return fail("bad_rate", "Give the interest as a percent, e.g. 10%.");
  if (rate > MAX_RATE) return fail("max_rate", `The most a loan can charge is ${MAX_RATE}%.`, { max: MAX_RATE });
  rate = rate === Math.trunc(rate) ? Math.trunc(rate) : Math.round(rate * 100) / 100;
  const secs = Math.floor(Number(a.secs) || 0);
  if (!secs || secs < MIN_SECS || secs > MAX_SECS) return fail("bad_term", `Give a term from 1h to ${fmtSecs(MAX_SECS)}, e.g. 7d.`);
  const owed = principal + Math.trunc(principal * rate / 100);
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  const recent = await G().list(GAME, LIVE.concat(RECENT));
  const twin = recent.find((l) => G().isWho(actor, lenderOf(l)) && G().same(l.borrower, who) && l.principal === principal && Number(l.rate) === rate
                              && Math.floor(Number(l.term)) === secs && t.nowS - Number(l.created) < DUP_SECS);
  if (twin) return fail("dup", `You already made that loan offer ${t.nowS - Math.floor(twin.created)}s ago (${ref(twin)}) — not doubled.`,
                        { ref: ref(twin), age: t.nowS - Math.floor(twin.created) });
  // open loans the borrower owes (P2P here + Pepe's Reserve loans: his count when he asks, else his last published book)
  const p2p = recent.filter((l) => LIVE.includes(l.status) && G().same(l.borrower, who)).length;
  // (only Pepe's bot-token calls carry reserve_open: the website's form args are built by fromForm and never do)
  const fed = a.reserve_open !== undefined && a.reserve_open !== null && Number.isFinite(Number(a.reserve_open)) ? Math.trunc(Number(a.reserve_open))
    : (await reserveLoans()).filter((l) => ["funding", "active"].includes(l.status) && G().same(l.borrower, who)).length;
  if (p2p + fed >= MAX_BORROWED) return fail("max_open", `${who} already has ${p2p + fed} open loans.`, { open: p2p + fed });
  const id = await G().nextId(GAME);
  const ln = { id, lender: me.login, borrower: who, principal, rate, term: secs, owed, paid: 0, penalty: 0, status: "offered",
               room: a.room || actor.room || null, created: t.nowS, offer_until: t.nowS + OFFER_SECS, holds: {}, payments: [],
               users: { lender: account.username }, via: actor.via || "room" };
  const h = await L.holdInTx({ key: `loan:L${id}:principal`, hid: null, account, login: me.login, amount: principal, ref: `L${id}`,
                               reason: "loan-principal", cp: who, via: "site" });
  ln.holds.principal = h.hid;
  await G().save(GAME, ln);
  const late = recent.filter((l) => l.status === "active" && l.late && G().same(l.borrower, who));
  const fedLate = (await reserveLoans()).filter((l) => l.status === "active" && l.late && G().same(l.borrower, who));
  const lateInfo = { count: late.length + fedLate.length, owed: late.concat(fedLate).reduce((s, l) => s + left(l), 0) };
  await emit("offered", ln, { by: me.login, via: actor.via, late: lateInfo });
  return { ok: true, ref: ref(ln), loan: view(ln), late: lateInfo };
}

async function accept(actor, ln, t) {
  if (!ln || ln.status !== "offered" || !G().isWho(actor, borrowerOf(ln))) return fail("not_yours", `There's no loan ${ln ? ref(ln) : ""} waiting on you.`.replace("  ", " "));
  if (ln.offer_until < t.nowS) return fail("expired", `Loan ${ref(ln)} has expired.`);
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  await L.settleInTx({ key: `settle:${ln.holds.principal}`, hids: [ln.holds.principal], ref: ref(ln), fees: [],
                       payouts: [{ userId: account.userId, nick: ln.borrower, amount: ln.principal, reason: "loan-received", cp: ln.lender }] });
  ln.users = Object.assign({}, ln.users, { borrower: account.username });
  ln.status = "active";
  ln.accepted = t.nowS;
  ln.due = t.nowS + ln.term;
  await G().save(GAME, ln);
  await emit("accepted", ln, { via: actor.via });
  return { ok: true, ref: ref(ln), loan: view(ln) };
}

async function decline(actor, ln, t) {
  if (!ln || ln.status !== "offered" || !G().isWho(actor, borrowerOf(ln))) return fail("not_yours", `There's no loan ${ln ? ref(ln) : ""} waiting on you.`.replace("  ", " "));
  await L.refundInTx({ key: `refund:${ln.holds.principal}`, hid: ln.holds.principal, reason: "loan-declined-refund" });
  ln.status = "declined";
  ln.ended = t.nowS;
  await G().save(GAME, ln);
  await emit("declined", ln, { by: actor.login || actor.username, via: actor.via });
  return { ok: true, ref: ref(ln), loan: view(ln) };
}

async function cancel(actor, ln, t, raw) {
  if (!ln || !G().isWho(actor, lenderOf(ln)) || ln.status !== "offered") return fail("not_yours", `You have no pending loan offer ${String(raw || "?").toUpperCase()}.`);
  await L.refundInTx({ key: `refund:${ln.holds.principal}`, hid: ln.holds.principal, reason: "loan-cancel-refund" });
  ln.status = "cancelled";
  ln.ended = t.nowS;
  await G().save(GAME, ln);
  await emit("cancelled", ln, { via: actor.via });
  return { ok: true, ref: ref(ln), loan: view(ln) };
}

/** Pepe's _loan_take_payment + _loan_pay_lender in ONE transaction: hold `amount` from the borrower, record it, pay the lender
 *  minus the protocol's cut of the part beyond the principal. Throws (rolls back) if the borrower can't cover it. */
async function takePayment(ln, account, amount, source, t) {
  const n = (ln.payments || []).length + 1;
  const h = await L.holdInTx({ key: `loan:${ref(ln)}:pay:${n}`, hid: null, account, login: ln.borrower, amount, ref: ref(ln),
                               reason: "loan-repayment", cp: ln.lender, via: "site" });
  const principalLeft = Math.max(0, ln.principal - (ln.paid || 0));
  const interest = Math.max(0, amount - principalLeft);
  ln.paid = (ln.paid || 0) + amount;
  ln.payments = (ln.payments || []).concat([{ hold: h.hid, amount, interest, source, ts: t.nowS }]);
  const done = ln.paid >= ln.owed;
  if (done) {
    ln.status = "repaid";
    ln.ended = t.nowS;
    ln.late = false;
  }
  const cut = Math.floor(interest * RESERVE_CUT_PCT / 100);
  const fees = await G().feeLegs("loan_interest", cut);
  await L.settleInTx({ key: `settle:${h.hid}`, hids: [h.hid], ref: ref(ln), fees,
                       payouts: [{ user: (ln.users || {}).lender || undefined, nick: ln.lender, amount: amount - cut, reason: "loan-repayment", cp: ln.borrower }] });
  return { amount, interest, cut, done };
}

async function repay(actor, ln, a, t) {
  if (!ln || !G().isWho(actor, borrowerOf(ln)) || ln.status !== "active") return fail("not_yours", `You don't have an open loan ${ln ? ref(ln) : String(a.ref || "").toUpperCase()}.`);
  const owe = left(ln);
  let amount = a.amount === undefined || a.amount === null || a.amount === "" ? owe : Math.floor(Number(a.amount));
  if (!(amount > 0)) return fail("bad_amount", `How much? e.g. !loan repay ${ref(ln)} 10k (or leave it off to pay it all).`);
  amount = Math.min(amount, owe);
  if (!(amount > 0)) return fail("bad_amount", `Loan ${ref(ln)} is already paid.`);
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  const p = await takePayment(ln, account, amount, "repay", t);
  ln.users = Object.assign({}, ln.users, { borrower: ln.users && ln.users.borrower ? ln.users.borrower : account.username });
  await G().save(GAME, ln);
  await emit(p.done ? "repaid" : "paid", ln, { by: actor.login || actor.username, amount, cut: p.cut, via: actor.via });
  return { ok: true, ref: ref(ln), loan: view(ln), paid: amount, left: left(ln), cut: p.cut };
}

async function forgive(actor, ln, t, raw) {
  if (!ln || !G().isWho(actor, lenderOf(ln)) || ln.status !== "active") return fail("not_yours", `You have no open loan ${String(raw || "?").toUpperCase()} to forgive.`);
  const owe = left(ln);
  ln.status = "forgiven";
  ln.late = false;
  ln.ended = t.nowS;
  await G().save(GAME, ln);
  await emit("forgiven", ln, { by: actor.login || actor.username, left: owe, via: actor.via });
  return { ok: true, ref: ref(ln), loan: view(ln), left: owe };
}

async function act(verb, actor, a, t) {
  if (verb === "offer") return offer(actor, a, t);
  if (verb === "reserve_id") {
    // Pepe's Federal Reserve loans stay in Pepe but share the L sequence: he takes their id here (keyed by his idem)
    if (!actor.pepe) return fail("not_pepe", "Only Pepe can do that.");
    const id = await G().nextId(GAME);
    return { ok: true, id, ref: `L${id}` };
  }
  const ln = await G().load(GAME, parseRef(a.ref));
  if (verb === "accept") return accept(actor, ln, t);
  if (verb === "decline") return decline(actor, ln, t);
  if (verb === "cancel") return cancel(actor, ln, t, a.ref);
  if (verb === "repay") return repay(actor, ln, a, t);
  if (verb === "forgive") return forgive(actor, ln, t, a.ref);
  return fail("bad_verb", "Unknown loan action.");
}

const READS = ["get", "list", "check"];
async function read(verb, actor, a) {
  if (verb === "get") {
    const ln = await G().load(GAME, parseRef(a.ref));
    return { loan: ln ? view(ln) : null };
  }
  if (verb === "check") {
    const who = String((a.who && a.who.login) || a.who || "").replace(/^@+/, "");
    const mine = (await G().list(GAME)).filter((l) => G().same(l.borrower, who));
    const owes = mine.filter((l) => l.status === "active");
    return { who, owes: owes.reduce((s, l) => s + left(l), 0), open: owes.length, late: owes.filter((l) => l.late).length,
             repaid: mine.filter((l) => l.status === "repaid").length, forgiven: mine.filter((l) => l.status === "forgiven").length };
  }
  const mine = (await G().list(GAME, LIVE)).filter((l) => G().isWho(actor, lenderOf(l)) || G().isWho(actor, borrowerOf(l)));
  return { loans: mine.map(view) };
}

// ── deadlines: offers that run out, due-date collection + penalties ──
async function due(nowS) {
  const out = [];
  for (const ln of await G().list(GAME, LIVE)) {
    if (ln.status === "offered" && ln.offer_until < nowS) out.push(ln.id);
    else if (ln.status === "active" && ln.due < nowS && nowS >= (ln.next_collect || 0)) out.push(ln.id);
  }
  if (Math.random() < 0.01) {
    await runQuery("DELETE FROM escrow_games WHERE game = ? AND status IN ('repaid','forgiven','declined','cancelled','expired') AND updated < ?",
                   [GAME, Date.now() - KEEP_DAYS * 86400000]).catch(() => {});
  }
  return out;
}
async function expire(id, t) {
  const ln = await G().load(GAME, id);
  if (!ln) return { ok: false };
  const now = t.nowS;
  if (ln.status === "offered" && ln.offer_until < now) {
    await L.refundInTx({ key: `refund:${ln.holds.principal}`, hid: ln.holds.principal, reason: "loan-expired-refund" });
    ln.status = "expired";
    ln.ended = now;
    await G().save(GAME, ln);
    await emit("expired", ln);
    return { ok: true };
  }
  if (!(ln.status === "active" && ln.due < now && now >= (ln.next_collect || 0))) return { ok: false };
  // Pepe's _loan_collect
  ln.next_collect = now + COLLECT_EVERY;
  const daysLate = Math.floor((now - ln.due) / 86400);
  const cap = Math.floor(ln.principal * PENALTY_CAP_PCT / 100);
  while ((ln.penalty_days || 0) < daysLate && (ln.penalty || 0) < cap) {
    const add = Math.min(Math.floor(left(ln) * PENALTY_PCT / 100), cap - (ln.penalty || 0));
    ln.penalty = (ln.penalty || 0) + add;
    ln.owed += add;
    ln.penalty_days = (ln.penalty_days || 0) + 1;
  }
  if ((ln.penalty_days || 0) < daysLate) ln.penalty_days = daysLate;
  let took = 0;
  const owe = left(ln);
  if (owe > 0) {
    // up to what the borrower has, read inside this transaction
    const account = await L.accountFor({ username: (ln.users || {}).borrower, login: ln.borrower });
    const bal = account ? Math.floor(Number(((await getQuery("SELECT points_balance FROM users WHERE userId = ?", [account.userId]))[0] || {}).points_balance) || 0) : 0;
    const amount = Math.min(owe, bal);
    if (amount > 0) {
      await takePayment(ln, account, amount, "auto-collect", t);
      took = amount;
    }
  }
  let kind = null;
  if (ln.status === "repaid") kind = "collected_paid";
  else if (!ln.late) { ln.late = true; ln.was_late = true; kind = "late"; }
  else if (took) kind = "collected";
  await G().save(GAME, ln);
  if (kind) await emit(kind, ln, { took });
  return { ok: true };
}

// ── the website's /act forms (views/wallet.ejs): P2P loans run here; Reserve-loan forms go to Pepe (null) ──
const PEPE_SUBS = new Set(["", "help", "list", "mine", "reserve", "fed", "bank", "request", "requests", "approve", "deny", "grant", "check", "credit"]);
function parseTerm(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)\s*$/i.exec(String(s || ""));
  if (!m) return null;
  const u = m[2].toLowerCase();
  const mult = /^w/.test(u) ? 604800 : /^d/.test(u) ? 86400 : /^h/.test(u) ? 3600 : 60;
  return Math.round(Number(m[1]) * mult);
}
async function fromForm(words, actor) {
  const w = words.map((x) => String(x == null ? "" : x).trim()).filter((x, i) => i === 0 || x);
  const sub = low(w[0]);
  if (PEPE_SUBS.has(sub)) return null;
  if (["accept", "decline", "repay", "pay", "forgive", "cancel"].includes(sub)) {
    const n = parseRef(w[1]);
    const ln = n === null ? null : await G().load(GAME, n);
    if (!ln) return null;                                            // no ref / a Reserve loan: Pepe's
    const verb = sub === "pay" ? "repay" : sub;
    const args = { ref: w[1] };
    if (verb === "repay" && w[2]) {
      const amt = require("../public/js/patamount").parse(w[2]);
      if (!(amt > 0)) return `How much? e.g. ${fmt(10000)} (or leave it empty to pay it all).`;
      args.amount = amt;
    }
    return { verb, args };
  }
  if (/^l\d+$/i.test(sub) && w.length === 1) return null;
  if (w.length < 4) return "Fill in who, how much, the interest and the term.";
  const target = await L.accountFor({ login: w[0].replace(/^@+/, "") });
  if (!target) return `I don't know who '${w[0]}' is.`;
  const principal = require("../public/js/patamount").parse(w[1]);
  if (!(principal >= MIN)) return `Loans start at PAT ${fmt(MIN)}.`;
  const m = /^(\d+(?:\.\d+)?)%?$/.exec(w[2]);
  if (!m) return "Give the interest as a percent, e.g. 10%.";
  const secs = parseTerm(w.slice(3).join(" "));
  if (!secs || secs < MIN_SECS || secs > MAX_SECS) return `Give a term from 1h to ${fmtSecs(MAX_SECS)}, e.g. 7d.`;
  if (!actor.login && !actor.username) return "Couldn't find your account.";
  return { verb: "offer", args: { borrower: { login: target.camfrogUsername || target.username }, principal, rate: Number(m[1]), secs } };
}
function webReply(verb, res) {
  if (!res.ok) return res.error || "Something went wrong — nothing changed.";
  if (res.dup) return `Already done (${res.ref}).`;
  const ln = res.loan || {};
  if (verb === "offer") {
    return `💸 Loan ${res.ref} offered to ${ln.borrower}: PAT ${fmt(ln.principal)} at ${ln.rate}%, pay back PAT ${fmt(ln.owed)} within ${fmtSecs(ln.term)}. They have 10 minutes to accept.`
      + (res.late && res.late.count ? ` ⚠️ Heads up: ${ln.borrower} is LATE on ${res.late.count} loan(s), owing PAT ${fmt(res.late.owed)}.` : "");
  }
  if (verb === "accept") return `🤝 Loan ${res.ref}: you borrowed PAT ${fmt(ln.principal)} — you owe PAT ${fmt(ln.owed)} within ${fmtSecs(ln.term)}.`;
  if (verb === "decline") return `You turned down loan ${res.ref} — ${ln.lender} keeps their PAT ${fmt(ln.principal)}.`;
  if (verb === "cancel") return `Loan offer ${res.ref} cancelled — your PAT ${fmt(ln.principal)} is back.`;
  if (verb === "repay") return ln.status === "repaid" ? `✅ You paid off loan ${res.ref} (PAT ${fmt(ln.paid)} total). All square.`
    : `Paid PAT ${fmt(res.paid)} on ${res.ref} — PAT ${fmt(res.left)} left.`;
  if (verb === "forgive") return `🕊️ You forgave the PAT ${fmt(res.left)} left on loan ${res.ref}.`;
  return "Done.";
}

// ── the cutover (Pepe's loans.json P2P loans <-> here; his Reserve loans stay with him) ──
function cleanImport(x) {
  const list = Array.isArray(x && x.loans) ? x.loans : Object.values((x && x.loans) || {});
  const records = [];
  for (const raw of list) {
    const id = Math.trunc(Number(raw && raw.id));
    if (!(id > 0)) throw new L.Refuse(400, "a loan without an id", "E_BAD_RECORD");
    if (raw.reserve) throw new L.Refuse(400, `L${id} is a Federal Reserve loan - those stay in Pepe`, "E_BAD_RECORD");
    const st = String(raw.status || "");
    if (["accepting", "funding"].includes(st)) throw new L.Refuse(409, `L${id} is mid-step (${st}) - let Pepe finish it first`, "E_BUSY");
    const principal = Math.floor(Number(raw.principal));
    if (!(principal > 0) || !(Math.floor(Number(raw.owed)) >= principal)) throw new L.Refuse(400, `L${id}: bad amounts`, "E_BAD_RECORD");
    const holds = Object.assign({}, raw.holds || {});
    if (st === "offered" && !holds.principal) throw new L.Refuse(400, `L${id}: offered without the lender's principal`, "E_BAD_RECORD");
    if (st === "active" && !(Number(raw.due) > 0)) throw new L.Refuse(400, `L${id}: active without a due date`, "E_BAD_RECORD");
    const ln = view(Object.assign({}, raw, { id, principal, owed: Math.floor(Number(raw.owed)), paid: Math.floor(Number(raw.paid) || 0),
                                             penalty: Math.floor(Number(raw.penalty) || 0), holds,
                                             payments: Array.isArray(raw.payments) ? raw.payments.map((p) => Object.assign({}, p)) : [] }));
    ln.users = Object.assign({}, raw.users || {});
    records.push(ln);
  }
  return { records, seq: Math.trunc(Number(x && x.seq) || 0) };
}
/** Live loans: offered ones hold the lender's principal on the ledger; active ones hold nothing (the borrower has it). */
function importTotals({ records }) {
  const holds = [];
  let sum = 0, count = 0;
  for (const ln of records || []) {
    if (!LIVE.includes(ln.status)) continue;
    count++;
    if (ln.status === "offered") {
      holds.push({ id: String(ln.holds.principal), ref: `L${ln.id}`, amount: ln.principal });
      sum += ln.principal;
    }
  }
  return { sum, count, holds };
}

module.exports = { GAME, LIVE, RECENT, READS, MIN, OFFER_SECS, RESERVE_CUT_PCT, PENALTY_PCT, PENALTY_CAP_PCT, COLLECT_EVERY,
                   act, read, due, expire, mirror, mergeSnapshot, fromForm, webReply, cleanImport, importTotals, view, snapLoan };
