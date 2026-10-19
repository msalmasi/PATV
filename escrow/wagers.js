// escrow/wagers.js — 1.99ou Phase 2: 1-on-1 PAT wagers owned by the site (Pepe's pepe_wager.py rules, exactly).
//
//   create   the creator's stake goes into a ledger hold now; the opponent has OFFER_SECS to accept (their stake is held
//            then) or decline. A named judge (or Pepe as the AI judge) settles it: the winner takes the pot minus FEE_PCT
//            (routed by the "wager_fee" row - Pepe's published shares), or void refunds both. Not settled by the deadline:
//            both refunded (an AI-judged wager whose AI still has a call pending waits - Pepe sets `ai_hold`).
//   ids      W<n>, Pepe's sequence carried over.
// Record: {id, creator, opponent, judge, amount, terms, room, status offered|active|won|void|expired|declined|cancelled,
//          created, offer_until, deadline, accepted, winner, fee, ended, settled_by, ai_judge, ai, ai_hold,
//          holds: {creator: hid, opponent: hid}, users: {creator: PATV username, opponent: ...}}   (times in seconds)
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const L = require("./ledger");

const GAME = "wagers";
const MIN = 1000;
const FEE_PCT = 5;
const OFFER_SECS = 600;
const DEFAULT_SECS = 7 * 86400;
const MAX_SECS = 30 * 86400;
const MAX_OPEN = 10;
const DUP_SECS = 120;
const KEEP_DAYS = 60;
const LIVE = ["offered", "active"];
const RECENT = ["won", "void", "expired", "declined", "cancelled"];
const VOID_WORDS = new Set(["void", "refund", "draw", "push", "cancel", "nobody", "none", "tie"]);
const AI_WORDS = new Set(["pepe", "@pepe", "ai", "pepefrog", "bot"]);

const G = () => require("./games");
const ref = (w) => `W${w.id}`;
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
const normText = (t) => String(t || "").toLowerCase().split(/\s+/).join(" ").replace(/^[ .,;:!?\-"']+|[ .,;:!?\-"']+$/g, "");
function parseRef(t) {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  const n = s.startsWith("W") ? s.slice(1) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}

// ── the display table the /wagers page reads (wagers.js) ──
let tableReady = null;
async function mirror(w) {
  if (!tableReady) tableReady = runQuery("CREATE TABLE IF NOT EXISTS wagers (id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, updated INTEGER)");
  await tableReady;
  const keep = {};
  for (const k of ["id", "creator", "opponent", "judge", "amount", "terms", "room", "status", "created", "offer_until", "deadline", "accepted", "winner",
                   "fee", "ended", "settled_by", "ai_judge", "ai"]) keep[k] = w[k] === undefined ? null : w[k];
  const clean = require("../wagers").cleanWager(keep);
  if (!clean) return;
  await runQuery(`INSERT INTO wagers (id, data, status, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, updated = excluded.updated`,
                 [clean.id, JSON.stringify(clean), clean.status, Date.now()]);
}

const view = (w) => {
  const out = {};
  for (const k of ["id", "creator", "opponent", "judge", "amount", "terms", "room", "status", "created", "offer_until", "deadline", "accepted",
                   "winner", "fee", "ended", "settled_by", "ai_judge", "ai", "ai_hold", "holds", "users"]) if (w[k] !== undefined) out[k] = w[k];
  return out;
};
async function emit(kind, w, extra) {
  await L.emitInTx(GAME, kind, w.room || null, Object.assign({ ref: ref(w), wager: view(w) }, extra || {}));
}
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});

// ── actions ──
async function create(actor, a, t) {
  const opp = a.opponent && a.opponent.login ? a.opponent : null;
  if (!opp) return fail("bad_opponent", "Who are you betting against?");
  const amount = Math.floor(Number(a.amount));
  if (!(amount >= MIN)) return fail("min", `The stake has to be at least PAT ${MIN.toLocaleString("en-US")}.`, { min: MIN });
  const aiJudge = !!a.ai_judge;
  const judge = aiJudge ? { login: String(a.pepe || "pepe") } : (a.judge && a.judge.login ? a.judge : null);
  if (!judge) return fail("no_judge", "Every wager needs a judge — add 'judge @someone' (not you or them).");
  const me = { login: actor.login || actor.username, user: actor.username };
  if (G().isWho(actor, opp) || G().same(opp.login, me.login)) return fail("self", "You can't bet against yourself.");
  if (!aiJudge && (G().isWho(actor, judge) || G().same(judge.login, opp.login))) return fail("judge_party", "The judge has to be someone other than the two of you.");
  const secs = Math.floor(Number(a.secs) || DEFAULT_SECS);
  if (secs > MAX_SECS) return fail("too_long", "The longest a wager can run is 30d.", { max: MAX_SECS });
  if (secs < 600) return fail("too_short", "Give the judge at least 10 minutes to decide.");
  // 1.99ade: the terms are what Pepe's AI judge rules on - no invisible characters (textclean.js)
  const terms = require("../textclean").stripFormat(a.terms).replace(/\s+/g, " ").replace(/^(?:that|on)\s+/i, "").trim().replace(/^[ ,;:\-]+|[ ,;:\-]+$/g, "").slice(0, 200);
  if (terms.length < 3) return fail("no_terms", "Say what you're betting on.");
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  if (account.casino_banned) return fail("banned", "You're banned from the casino, so no wagers.");
  const mine = (await G().list(GAME, LIVE)).filter((w) => G().isWho(actor, { login: w.creator, user: (w.users || {}).creator }));
  if (mine.length >= MAX_OPEN) return fail("max_open", `You already have ${mine.length} open wagers — settle some first.`, { open: mine.length });
  const twin = mine.find((w) => G().same(w.opponent, opp.login) && w.amount === amount && normText(w.terms) === normText(terms) && t.nowS - w.created < DUP_SECS);
  if (twin) return fail("dup", `You already made that wager ${t.nowS - twin.created}s ago (${ref(twin)}) — not doubled.`, { ref: ref(twin), age: t.nowS - twin.created });
  const id = await G().nextId(GAME);
  const w = { id, creator: me.login, opponent: opp.login, judge: judge.login, amount, terms, room: a.room || actor.room || null, status: "offered",
              created: t.nowS, offer_until: t.nowS + OFFER_SECS, deadline: t.nowS + secs, holds: {}, users: { creator: account.username },
              via: actor.via || "room" };
  if (aiJudge) w.ai_judge = true;
  const h = await L.holdInTx({ key: `wager:W${id}:creator`, hid: null, account, login: me.login, amount, ref: `W${id}`, reason: "wager-stake",
                               cp: opp.login, via: "site", casino: true });
  w.holds.creator = h.hid;
  await G().save(GAME, w);
  await emit("created", w, { by: me.login, via: actor.via });
  return { ok: true, ref: ref(w), wager: view(w), secs };
}

async function accept(actor, w, t) {
  if (!w || w.status !== "offered" || !G().isWho(actor, { login: w.opponent, user: (w.users || {}).opponent })) return fail("not_yours", `There's no wager ${w ? ref(w) : ""} waiting on you.`.replace("  ", " "));
  if (w.offer_until < t.nowS) return fail("expired", `Wager ${ref(w)} has expired.`);
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't find a PAT account.");
  if (account.casino_banned) return fail("banned", "You're banned from the casino, so you can't take wagers.");
  const h = await L.holdInTx({ key: `wager:${ref(w)}:opponent`, hid: null, account, login: actor.login || w.opponent, amount: w.amount, ref: ref(w),
                               reason: "wager-stake", cp: w.creator, via: "site", casino: true });
  w.holds.opponent = h.hid;
  w.users = Object.assign({}, w.users, { opponent: account.username });
  w.status = "active";
  w.accepted = t.nowS;
  await G().save(GAME, w);
  await emit("accepted", w, { via: actor.via });
  return { ok: true, ref: ref(w), wager: view(w) };
}

async function refundHold(hid, reason) {
  if (!hid) return null;
  return L.refundInTx({ key: `refund:${hid}`, hid, reason });
}

async function decline(actor, w, t) {
  if (!w || w.status !== "offered" || !G().isWho(actor, { login: w.opponent, user: (w.users || {}).opponent })) return fail("not_yours", "There's no such wager waiting on you.");
  await refundHold(w.holds.creator, "wager-declined-refund");
  w.status = "declined";
  w.ended = t.nowS;
  await G().save(GAME, w);
  await emit("declined", w, { by: actor.login || actor.username, via: actor.via });
  return { ok: true, ref: ref(w), wager: view(w) };
}

async function cancel(actor, w, t) {
  if (!w || !G().isWho(actor, { login: w.creator, user: (w.users || {}).creator })) return fail("not_yours", "You don't have that wager.");
  if (w.status !== "offered") return fail("not_offered", `Wager ${ref(w)} is already ${w.status} — only the judge can end it now.`, { status: w.status });
  await refundHold(w.holds.creator, "wager-cancel-refund");
  w.status = "cancelled";
  w.ended = t.nowS;
  await G().save(GAME, w);
  await emit("cancelled", w, { via: actor.via });
  return { ok: true, ref: ref(w), wager: view(w) };
}

async function settle(actor, w, a, t) {
  if (!w) return fail("no_wager", "No such wager.");
  const isJudge = w.ai_judge ? !!actor.pepe : G().same(actor.login, w.judge) || G().same(actor.username, w.judge);
  if (!(isJudge || actor.admin)) return fail("not_judge", `Only the judge (${w.ai_judge ? "Pepe" : w.judge}) or an admin can settle ${ref(w)}.`, { judge: w.judge });
  if (w.status !== "active") return fail("not_live", `Wager ${ref(w)} is ${w.status}, not live.`, { status: w.status });
  const word = low(a.outcome);
  let winner = null;
  if (!VOID_WORDS.has(word)) {
    if (G().same(word, w.creator) || G().same(word, (w.users || {}).creator)) winner = w.creator;
    else if (G().same(word, w.opponent) || G().same(word, (w.users || {}).opponent)) winner = w.opponent;
    else return fail("bad_winner", `The winner has to be ${w.creator} or ${w.opponent} (or 'void' to refund both).`, { creator: w.creator, opponent: w.opponent });
  }
  const by = actor.login || actor.username;
  if (winner === null) {
    await refundHold(w.holds.creator, "wager-void-refund");
    await refundHold(w.holds.opponent, "wager-void-refund");
    w.status = "void";
    w.ended = t.nowS;
    w.settled_by = by;
    w.winner = null;
    await G().save(GAME, w);
    await emit("void", w, { by, judge_call: isJudge, via: actor.via });
    return { ok: true, ref: ref(w), wager: view(w) };
  }
  const pot = 2 * w.amount;
  const fee = Math.floor(pot * FEE_PCT / 100);
  const loser = winner === w.creator ? w.opponent : w.creator;
  const side = winner === w.creator ? "creator" : "opponent";
  const fees = await G().feeLegs("wager_fee", fee);
  const winHold = (await L.holdsByIds([w.holds[side]]))[0];
  await L.settleInTx({ key: `settle:${w.holds.creator}`, hids: [w.holds.creator, w.holds.opponent],
                       payouts: [{ userId: winHold && winHold.user_id, nick: winner, amount: pot - fee, reason: "wager-win", cp: loser }], fees, ref: ref(w) });
  w.status = "won";
  w.winner = winner;
  w.fee = fee;
  w.ended = t.nowS;
  w.settled_by = by;
  await G().save(GAME, w);
  await emit("won", w, { by, judge_call: isJudge, loser, paid: pot - fee, fee, via: actor.via });
  return { ok: true, ref: ref(w), wager: view(w), paid: pot - fee, fee };
}

/** Pepe's AI judge writes its state back (it runs in Pepe until Phase 5): the `ai` object + whether it holds the deadline. */
async function aiPut(actor, w, a) {
  if (!actor.pepe) return fail("not_pepe", "Only Pepe's AI judge can do that.");
  if (!w || !w.ai_judge) return fail("no_wager", "No such AI-judged wager.");
  // the AI judge's whole state (it lives in Pepe until Phase 5; the display table cleans it - wagers.cleanAi)
  const raw = a.ai && typeof a.ai === "object" ? JSON.stringify(a.ai) : "";
  if (raw.length > 16000) return fail("too_big", "AI state too big.");
  w.ai = raw ? JSON.parse(raw) : null;
  w.ai_hold = !!a.hold;
  await G().save(GAME, w);
  if (a.announce) await emit("ai", w, { text: String(a.announce).slice(0, 400) });
  return { ok: true, ref: ref(w), wager: view(w) };
}

async function act(verb, actor, a, t) {
  if (verb === "create") return create(actor, a, t);
  const w = await G().load(GAME, parseRef(a.ref));
  if (!w && verb !== "create") return fail("no_wager", `No wager ${String(a.ref || "").toUpperCase()}.`);
  if (verb === "accept") return accept(actor, w, t);
  if (verb === "decline") return decline(actor, w, t);
  if (verb === "cancel") return cancel(actor, w, t);
  if (verb === "settle") return settle(actor, w, a, t);
  if (verb === "ai_put") return aiPut(actor, w, a);
  if (verb === "ai_request") {
    // the website's "ask Pepe now" / "dispute" on an AI-judged wager: Pepe's AI judge runs it (it still lives in Pepe)
    if (!w.ai_judge) return fail("no_ai", `${ref(w)} isn't judged by Pepe.`);
    // 1.99ade: the reason goes to Pepe's AI judge - one line, no invisible characters (textclean.js)
    await emit("ai_request", w, { sub: String(a.sub || "ai").slice(0, 10), who: actor.login || actor.username, why: require("../textclean").oneLine(a.why, 200),
                                  admin: !!actor.admin });
    return { ok: true, ref: ref(w) };
  }
  return fail("bad_verb", "Unknown wager action.");
}

const READS = ["get", "list"];
async function read(verb, actor, a) {
  if (verb === "get") {
    const w = await G().load(GAME, parseRef(a.ref));
    return w ? { wager: view(w) } : { wager: null };
  }
  const mine = (await G().list(GAME, LIVE)).filter((w) => G().isWho(actor, { login: w.creator, user: (w.users || {}).creator })
    || G().isWho(actor, { login: w.opponent, user: (w.users || {}).opponent }) || G().same(actor.login, w.judge));
  return { wagers: mine.map(view) };
}

// ── deadlines ──
async function due(nowS) {
  const out = [];
  for (const w of await G().list(GAME, LIVE)) {
    if (w.status === "offered" && w.offer_until < nowS) out.push(w.id);
    else if (w.status === "active" && w.deadline < nowS && !(w.ai_judge && w.ai_hold)) out.push(w.id);
  }
  // history: drop finished wagers after 60 days (the display table keeps its own 60 days)
  if (Math.random() < 0.01) {
    await runQuery("DELETE FROM escrow_games WHERE game = ? AND status IN ('won','void','expired','declined','cancelled') AND updated < ?",
                   [GAME, Date.now() - KEEP_DAYS * 86400000]).catch(() => {});
  }
  return out;
}
async function expire(id, t) {
  const w = await G().load(GAME, id);
  if (!w) return { ok: false };
  if (w.status === "offered" && w.offer_until < t.nowS) {
    await refundHold(w.holds.creator, "wager-expired-refund");
    w.status = "expired";
    w.ended = t.nowS;
    w.expired = "offer";
    await G().save(GAME, w);
    await emit("expired_offer", w);
    return { ok: true };
  }
  if (w.status === "active" && w.deadline < t.nowS && !(w.ai_judge && w.ai_hold)) {
    await refundHold(w.holds.creator, "wager-deadline-refund");
    await refundHold(w.holds.opponent, "wager-deadline-refund");
    w.status = "expired";
    w.ended = t.nowS;
    w.expired = "deadline";
    await G().save(GAME, w);
    await emit("expired", w);
    return { ok: true };
  }
  return { ok: false };
}

// ── the website's /act form (views/wagers.ejs) ──
const JUDGE_RE = /(?:^|\s)(?:judged\s+by|judge|referee|ref|arbiter)\s*[:=]?\s+@?([^\s,;]+)/ig;
const BY_RE = /(?:^|\s)(?:by|within|deadline)\s+(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)(?=$|[\s,.;!?])/i;
function durationSecs(n, unit) {
  const u = String(unit).toLowerCase();
  const mult = /^w/.test(u) ? 604800 : /^d/.test(u) ? 86400 : /^h/.test(u) ? 3600 : 60;
  return Math.round(Number(n) * mult);
}
function parseCreate(words) {
  if (words.length < 3) return null;
  const opponent = String(words[0]).trim().replace(/^@+/, "");
  const amount = require("../public/js/patamount").parse(words[1]);
  let text = words.slice(2).join(" ");
  const jm = [...text.matchAll(JUDGE_RE)];
  if (!jm.length) return { error: "Every wager needs a judge — add one (not you or them), or let Pepe judge it." };
  const last = jm[jm.length - 1];
  const jword = last[1];
  text = (text.slice(0, last.index) + " " + text.slice(last.index + last[0].length)).trim();
  let secs = DEFAULT_SECS;
  const bm = BY_RE.exec(text);
  if (bm) { secs = durationSecs(bm[1], bm[2]); text = (text.slice(0, bm.index) + " " + text.slice(bm.index + bm[0].length)).trim(); }
  const ai = AI_WORDS.has(low(jword));
  return { opponent: { login: opponent }, amount: Number.isFinite(amount) ? amount : 0, terms: text, secs, ai_judge: ai, judge: ai ? null : { login: jword.replace(/^@+/, "") } };
}
function fromForm(words, actor) {
  const w = words.map((x) => String(x));
  const sub = low(w[0]);
  if (["accept", "decline", "cancel"].includes(sub)) return { verb: sub, args: { ref: w[1] } };
  if (sub === "settle" || sub === "resolve" || sub === "judge") {
    if (w.length < 3) return "Pick a winner (or void).";
    return { verb: "settle", args: { ref: w[1], outcome: w[2] } };
  }
  if (sub === "ai" || sub === "dispute") return { verb: "ai_request", args: { ref: w[1], sub, why: w.slice(2).join(" ") } };
  const c = parseCreate(w);
  if (!c) return "Fill in the form first.";
  if (c.error) return c.error;
  if (!actor.login && !actor.username) return "Couldn't find your account.";
  return { verb: "create", args: c };
}
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
function webReply(verb, res, args) {
  if (!res.ok) return res.error || "Something went wrong — nothing changed.";
  const w = res.wager || {};
  if (res.dup) return `Already done (${res.ref}).`;
  if (verb === "create") return `🤝 Wager ${res.ref} offered: PAT ${fmt(w.amount)} each on "${w.terms}". ${w.opponent} has 10 minutes to accept.`;
  if (verb === "accept") return `✅ Wager ${res.ref} is ON — PAT ${fmt(2 * w.amount)} pot.`;
  if (verb === "decline") return `Declined ${res.ref} — ${w.creator} gets their PAT back.`;
  if (verb === "cancel") return `Wager ${res.ref} cancelled — your PAT ${fmt(w.amount)} is back.`;
  if (verb === "settle") return w.status === "void" ? `↩️ ${res.ref} voided — both refunded.` : `🏆 ${res.ref}: ${w.winner} wins PAT ${fmt(res.paid)}.`;
  if (verb === "ai_request") return args && args.sub === "dispute" ? "Sent to Pepe's AI judge: your dispute." : "Asked Pepe's AI judge to look now.";
  return "Done.";
}

// ── the cutover (Pepe's wagers.json <-> here) ──
function cleanImport(x) {
  const list = Array.isArray(x && x.wagers) ? x.wagers : Object.values((x && x.wagers) || {});
  const records = [];
  for (const raw of list) {
    const id = Math.trunc(Number(raw && raw.id));
    if (!(id > 0)) throw new L.Refuse(400, "a wager without an id", "E_BAD_RECORD");
    const st = String(raw.status || "");
    if (["accepting", "settling"].includes(st)) throw new L.Refuse(409, `W${id} is mid-step (${st}) - let Pepe finish it first`, "E_BUSY");
    const amount = Math.floor(Number(raw.amount));
    if (!(amount > 0)) throw new L.Refuse(400, `W${id}: bad amount`, "E_BAD_RECORD");
    const holds = Object.assign({}, raw.holds || {});
    if (st === "offered" && !holds.creator) throw new L.Refuse(400, `W${id}: offered without the creator's stake`, "E_BAD_RECORD");
    if (st === "active" && !(holds.creator && holds.opponent)) throw new L.Refuse(400, `W${id}: active without both stakes`, "E_BAD_RECORD");
    const w = view(Object.assign({}, raw, { id, amount, holds }));
    w.users = Object.assign({}, raw.users || {});
    records.push(w);
  }
  return { records, seq: Math.trunc(Number(x && x.seq) || 0) };
}
function importTotals({ records }) {
  const holds = [];
  let sum = 0, count = 0;
  for (const w of records || []) {
    if (!LIVE.includes(w.status)) continue;
    count++;
    for (const side of w.status === "active" ? ["creator", "opponent"] : ["creator"]) {
      holds.push({ id: String(w.holds[side]), ref: `W${w.id}`, amount: w.amount });
      sum += w.amount;
    }
  }
  return { sum, count, holds };
}

module.exports = { GAME, LIVE, RECENT, READS, MIN, FEE_PCT, OFFER_SECS, act, read, due, expire, mirror, fromForm, webReply, cleanImport, importTotals,
                   parseCreate, view };
