// escrow/bounties.js — 1.99ou Phase 2: PAT bounties owned by the site (Pepe's pepe_bounty.py rules, exactly).
//
//   create   the creator's PAT goes into a ledger hold now; anyone chips in (each add is its own hold); hunters claim it; the
//            creator (or an admin, or Pepe when his evidence check VERIFIED the claim) resolves it: the pot minus FEE_PCT (routed
//            by the "bounty_fee" row - Pepe's published shares) is split evenly between the hunters, the remainder to the first.
//            Cancel (creator) / void (admin) / the deadline refund every hold in the pot.
//   evidence Pepe stays the verifier: he reads the task into a checkable `spec` (spec_put) and checks each claim against his mod
//            log / chat logs / transcripts / join journal (check_put), then auto-awards as Pepe (resolve with auto) - the site
//            only books what he found and settles the money.
//   ids      BT<n>, Pepe's sequence carried over.
// Record: {id, creator, task, room, status open|resolved|cancelled|expired, created, deadline, pot: [{hid, nick, amount, user}],
//          claims: {nick: {ts, note, evidence, web, user, check, rejected, disputed}}, hunters, resolved_by, resolved, fee, paid,
//          spec, spec_src, spec_set, spec_text, users: {creator}, via, ended, rev}   (times in seconds)
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const L = require("./ledger");
// 1.99ade: task, claim notes / links, reject and dispute reasons lose \p{Cf} (tag characters included) where they come in -
// Pepe's evidence check reads them with an LLM and can award on its own (fencing them as data in his prompt is the bot's side)
// 1.99ade: notes and reasons are one line (oneLine: new lines / U+2028 folded - a model must not see a fresh "SYSTEM:" line)
const { stripFormat, oneLine } = require("../textclean");

const GAME = "bounties";
const MIN = 1000;
const ADD_MIN = 100;
const FEE_PCT = 5;
const DEFAULT_SECS = 7 * 86400;
const MAX_SECS = 30 * 86400;
const MAX_OPEN = 5;
const DUP_SECS = 120;
const DISPUTE_AFTER = 12 * 3600;
const KEEP_DAYS = 60;
const AUTO_BY = "Pepe (verified)";
const LIVE = ["open"];
const RECENT = ["resolved", "cancelled", "expired"];
const CHECK_STATES = ["verified", "creator", "admin", "no_match", "manual"];

const G = () => require("./games");
const ref = (b) => `BT${b.id}`;
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const nameOf = (s) => String(s || "").trim().replace(/^@+/, "").slice(0, 60);
const normText = (t) => String(t || "").toLowerCase().split(/\s+/).join(" ").replace(/^[ .,;:!?\-"']+|[ .,;:!?\-"']+$/g, "");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function parseRef(t) {
  const s = String(t || "").trim().replace(/^#/, "").toUpperCase();
  const n = s.startsWith("BT") ? s.slice(2) : s;
  return /^\d+$/.test(n) ? Number(n) : null;
}
/** Pepe's _fmt_secs (pepe_bounty.py). */
function fmtSecs(secs) {
  secs = Math.max(0, Math.trunc(Number(secs) || 0));
  if (secs >= 86400) {
    const h = Math.floor((secs % 86400) / 3600);
    return `${Math.floor(secs / 86400)}d` + (h ? ` ${h}h` : "");
  }
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}
const total = (b) => (b.pot || []).reduce((t, c) => t + Math.floor(Number(c.amount) || 0), 0);
const claimKey = (b, who) => Object.keys(b.claims || {}).find((k) => G().same(k, who)) || null;
const isCreator = (actor, b) => G().isWho(actor, { login: b.creator, user: (b.users || {}).creator });

// ── evidence (pepe_bountyverify._bv_evidence; a snap id is turned into its link by Pepe, who passes `evidence`) ──
const URL_RE = /https?:\/\/[^\s<>"']{3,300}/ig;
function evidenceOf(text) {
  text = oneLine(text, 300);
  const links = [];
  for (const m of text.match(URL_RE) || []) {
    const u = m.replace(/[.,);\]]+$/, "").slice(0, 300);
    if (!links.includes(u)) links.push(u);
  }
  return text || links.length ? { text: text.slice(0, 160), links: links.slice(0, 3) } : null;
}
function cleanEvidence(ev) {
  if (!ev || typeof ev !== "object") return null;
  const links = [].concat(ev.links || []).map((u) => String(u).trim().slice(0, 300)).filter((u) => /^https?:\/\//i.test(u)).slice(0, 3);
  return { text: oneLine(ev.text, 160), links };
}
function cleanCheck(ck) {
  if (!ck || typeof ck !== "object" || !CHECK_STATES.includes(ck.state)) return null;
  const out = { state: ck.state, how: ck.how === "semantic" ? "semantic" : ck.how ? "exact" : null,
                lines: [].concat(ck.lines || []).slice(0, 4).map((l) => String(l).slice(0, 300)), why: String(ck.why || "").slice(0, 200),
                at: Number(ck.at) || null };
  if (ck.event && typeof ck.event === "object") {
    out.event = { ts: Number(ck.event.ts) || null, type: String(ck.event.type || "").slice(0, 20), room: String(ck.event.room || "").slice(0, 80) };
  }
  return out;
}

// ── Pepe's _bv_describe (the display text when Pepe didn't send his own wording) ──
function fmtWindow(s) {
  s = Math.trunc(Number(s) || 0);
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
  return `${s} s`;
}
function describeSpec(spec) {
  if (!spec || typeof spec !== "object") return "manual (the creator decides)";
  const a = spec.action;
  const dn = (n) => n || "someone";
  let s;
  const nouns = { kick: "a kick of", ban: "a ban of", punish: "a punish (disable) of", mic_block: "a mic block of" };
  if (nouns[a]) s = `${nouns[a]} ${dn(spec.target)} by the claimant`;
  else if (a === "join") s = `${dn(spec.target)} joining a room`;
  else {
    const where = a === "mic_say" ? "on the mic" : "in room chat";
    s = `${spec.who ? spec.who : "the claimant"} saying '${spec.phrase}' ${where}` + (spec.semantic ? " (anything on that topic counts)" : "");
  }
  const t = spec.trigger;
  if (t && typeof t === "object") {
    const where = { said: "in chat", mic_said: "on the mic", any_said: "in chat or on mic" }[t.type] || "in chat or on mic";
    s += ` within ${fmtWindow(t.window_s)} after ${t.who ? t.who : "anyone"} mentions '${t.match}' (${where}`
      + (t.semantic ? "; anything on that topic counts" : "; those exact words") + ")";
  }
  if (spec.room && spec.room !== "any") s += `, in ${spec.room}`;
  return s;
}

// ── the display table the /bounties pages read (bounties.js, Pepe's /api/bounties/sync shape) ──
async function mirror(b) {
  const B = require("../bounties");
  const snap = {
    id: b.id, creator: b.creator, task: b.task, room: b.room || "", status: b.status, created: b.created, deadline: b.deadline,
    pot: (b.pot || []).map((c) => ({ nick: c.nick, amount: c.amount })),
    claims: Object.entries(b.claims || {}).map(([nick, c]) => ({
      nick, ts: c.ts, note: c.note || "", evidence: c.evidence || null, check: c.check || null,
      rejected: c.rejected ? { by: c.rejected.by, why: c.rejected.why || "" } : null, disputed: !!c.disputed })),
    hunters: b.hunters || [], resolved: b.resolved || null, auto: b.resolved_by === AUTO_BY,
    verify: b.spec ? { text: b.spec_text || describeSpec(b.spec), action: b.spec.action } : null,
  };
  const clean = B.cleanSnap(snap);
  if (clean) await B.storeSnap(clean);
}

const VIEW_KEYS = ["id", "creator", "task", "room", "status", "created", "deadline", "pot", "claims", "hunters", "resolved_by", "resolved", "fee", "paid",
                   "spec", "spec_src", "spec_set", "spec_text", "users", "via", "ended", "rev"];
const view = (b) => {
  const out = {};
  for (const k of VIEW_KEYS) if (b[k] !== undefined) out[k] = b[k];
  return out;
};
async function put(b) {
  b.rev = (Number(b.rev) || 0) + 1;
  await G().save(GAME, b);
}
/** One event per state change; `tok` lets Pepe skip announcing what he already said as the answer to his own call. */
async function emit(kind, b, extra) {
  const said = SAID ? { said: SAID } : {};
  await L.emitInTx(GAME, kind, b.room || null, Object.assign({ ref: ref(b), tok: tok(kind, b), bounty: view(b) }, said, extra || {}));
}
// Pepe's `said` token (the act's idem) echoed into the events of his own call, so he announces it once - set for the length
// of one act (every act runs inside ONE serialized money transaction, so no two acts interleave here)
let SAID = null;
const tok = (kind, b) => `${ref(b)}:${kind}:${b.rev}`;
const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra || {});
const done = (kind, b, extra) => Object.assign({ ok: true, ref: ref(b), tok: tok(kind, b), bounty: view(b) }, extra || {});

async function balanceOf(account) {
  const r = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [account.userId]))[0];
  return r ? Math.floor(Number(r.b) || 0) : 0;
}
/** Pepe's _bounty_open: the bounty exists, is open and isn't past its deadline. -> failure | null */
function notOpen(b, raw, t) {
  if (!b) return fail("no_bounty", `No bounty ${String(raw || "").toUpperCase()}.`);
  if (b.status !== "open" || Number(b.deadline) < t.nowS) {
    return fail("closed", `Bounty ${ref(b)} is ${b.status !== "open" ? b.status : "expired"}.`, { status: b.status !== "open" ? b.status : "expired" });
  }
  return null;
}

// ── actions ──
async function create(actor, a, t) {
  const me = nameOf(actor.login || actor.username);
  const secs = Math.floor(Number(a.secs) || DEFAULT_SECS);
  if (secs > MAX_SECS) return fail("too_long", `The longest a bounty can run is ${fmtSecs(MAX_SECS)}.`, { max: MAX_SECS });
  const amount = Math.floor(Number(a.amount));
  const task = stripFormat(a.task).replace(/\s+/g, " ").trim();     // 1.99ade: Pepe's LLM reads it into the checkable spec
  if (!(amount > 0)) return fail("usage", "Usage: !bounty <what has to happen> <amount> [by 2d] — e.g. !bounty kick plantbaked 1000");
  if (task.length < 3) return fail("no_task", "Say what has to happen, e.g. !bounty kick plantbaked 1000");
  if (amount < MIN) return fail("min", `A bounty starts at PAT ${fmt(MIN)}.`, { min: MIN });
  if (!me) return fail("no_account", "Couldn't post the bounty — couldn't find a PAT account.");
  const account = await G().actorAccount(actor);
  if (!account) return fail("no_account", "Couldn't post the bounty — couldn't find a PAT account.");
  const mine = (await G().list(GAME, LIVE)).filter((b) => isCreator(actor, b));
  // 1.99bj: the same bounty from the same person twice in a row is a double post, not two bounties
  const twin = mine.find((b) => normText(b.task) === normText(task.slice(0, 200)) && Math.floor(Number((b.pot[0] || {}).amount)) === amount
                                && t.nowS - Number(b.created) < DUP_SECS);
  if (twin) return fail("dup", `You already made that bounty ${t.nowS - Math.floor(twin.created)}s ago (${ref(twin)}) — not doubled.`,
                        { ref: ref(twin), age: t.nowS - Math.floor(twin.created) });
  if (mine.length >= MAX_OPEN) return fail("max_open", `You already have ${mine.length} open bounties — resolve or cancel some first.`, { open: mine.length });
  const bal = await balanceOf(account);
  if (bal < amount) return fail("insufficient", `Couldn't post the bounty — that needs PAT ${fmt(amount)} and ${me} has ${fmt(bal)}.`, { balance: bal });
  const id = await G().nextId(GAME);
  const b = { id, creator: me, task: task.slice(0, 200), room: a.room || actor.room || null, status: "open", created: t.nowS, deadline: t.nowS + secs,
              pot: [], claims: {}, hunters: [], users: { creator: account.username }, via: actor.via || "room" };
  const h = await L.holdInTx({ key: `bounty:BT${id}:pot0`, hid: null, account, login: me, amount, ref: `BT${id}`, reason: "bounty-post",
                               cp: null, via: "site", casino: false });
  b.pot.push({ hid: h.hid, nick: me, amount, user: account.username });
  await put(b);
  await emit("created", b, { by: me, secs, via: actor.via });
  return done("created", b, { secs });
}

async function add(actor, b, a, t) {
  const no = notOpen(b, a.ref, t);
  if (no) return no;
  const me = nameOf(actor.login || actor.username);
  const amount = Math.floor(Number(a.amount));
  if (!(amount >= ADD_MIN)) return fail("min", `Chip in at least PAT ${fmt(ADD_MIN)}.`, { min: ADD_MIN });
  const account = await G().actorAccount(actor);
  if (!account || !me) return fail("no_account", `Couldn't add to ${ref(b)} — couldn't find a PAT account.`);
  const bal = await balanceOf(account);
  if (bal < amount) return fail("insufficient", `Couldn't add to ${ref(b)} — that needs PAT ${fmt(amount)} and ${me} has ${fmt(bal)}.`, { balance: bal });
  const h = await L.holdInTx({ key: `bounty:${ref(b)}:pot${b.pot.length}`, hid: null, account, login: me, amount, ref: ref(b), reason: "bounty-add",
                               cp: null, via: "site", casino: false });
  b.pot.push({ hid: h.hid, nick: me, amount, user: account.username });
  await put(b);
  await emit("add", b, { nick: me, amount, total: total(b), web: actor.via === "web" });
  return done("add", b, { amount, total: total(b) });
}

async function claim(actor, b, a, t) {
  const no = notOpen(b, a.ref, t);
  if (no) return no;
  const me = nameOf(actor.login || actor.username);
  if (!me) return fail("no_account", "Couldn't find your account.");
  if (isCreator(actor, b) || G().same(me, b.creator)) return fail("own", "You can't claim your own bounty.");
  if (b.spec && b.spec.target && G().same(me, b.spec.target)) return fail("self_target", "You can't collect a bounty on yourself.");
  let link = stripFormat(a.link).trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) link = "";
  // 1.99ade: the note is what Pepe's evidence check (an LLM that can award the bounty) reads - no invisible format characters
  const text = (oneLine(a.note, 160) + " " + link).trim();
  const ev = a.evidence !== undefined ? cleanEvidence(a.evidence) : evidenceOf(text);
  const web = actor.via === "web";
  const old = claimKey(b, me);
  const prev = old ? b.claims[old] : {};
  if (old) delete b.claims[old];
  const c = { ts: t.nowS, note: text.slice(0, 160) };
  if (ev) c.evidence = ev;
  if (web) c.web = true;
  if (actor.username) c.user = actor.username;
  if (prev.disputed) c.disputed = prev.disputed;                  // an update doesn't pull it back from the admins
  b.claims[me] = c;
  await put(b);
  await emit("claim", b, { nick: me, note: text.slice(0, 160), web, spec: !!b.spec });
  return done("claim", b, { nick: me });
}

async function resolve(actor, b, a, t) {
  const auto = !!(a.auto && actor.pepe);
  if (auto) {
    if (!b) return fail("no_bounty", `No bounty ${String(a.ref || "").toUpperCase()}.`);
    if (b.status !== "open") return fail("closed", `${ref(b)} is already ${b.status}.`, { status: b.status });
  } else {
    const no = notOpen(b, a.ref, t);
    if (no) return no;
  }
  const admin = !!actor.admin;
  if (!(auto || isCreator(actor, b) || admin)) return fail("not_creator", `Only ${b.creator} (or an admin) can resolve ${ref(b)}.`, { creator: b.creator });
  const hunters = [];
  for (const raw of [].concat(a.hunters || [])) {
    const n = nameOf(raw);
    if (!n) return fail("bad_hunter", `I don't know who '${String(raw).slice(0, 40)}' is.`);
    if (G().same(n, b.creator) || G().same(n, (b.users || {}).creator)) return fail("own", "The creator can't collect their own bounty.");
    const k = claimKey(b, n);
    if (!k && !admin) return fail("not_claimed", `${n} hasn't claimed ${ref(b)} — they need to !bounty claim ${ref(b)} first.`, { hunter: n });
    if (auto && (!k || ((b.claims[k].check || {}).state !== "verified"))) return fail("not_verified", `${n}'s claim on ${ref(b)} isn't verified.`);
    if (!hunters.some((h) => G().same(h, n))) hunters.push(k || n);
  }
  if (!hunters.length) return fail("usage", `Usage: !bounty resolve ${ref(b)} @hunter`);
  // Pepe's _bounty_pay: fee = total * BOUNTY_FEE_PCT // 100, the rest split evenly, the remainder to the first hunter
  const tot = total(b);
  const fee = Math.floor(tot * FEE_PCT / 100);
  const net = tot - fee;
  const each = Math.floor(net / hunters.length);
  const extra = net - each * hunters.length;
  const payouts = hunters.map((h, i) => {
    const c = b.claims[claimKey(b, h)] || {};
    return { user: c.user || undefined, nick: h, amount: each + (i === 0 ? extra : 0), reason: "bounty-win", cp: b.creator };
  });
  const fees = await G().feeLegs("bounty_fee", fee);
  await L.settleInTx({ key: `settle:${b.pot[0].hid}`, hids: b.pot.map((c) => c.hid), payouts, fees, ref: ref(b) });
  for (const h of hunters) {                                     // paying a claim settles any rejection of it
    const c = b.claims[claimKey(b, h)];
    if (c && c.rejected) delete c.rejected;
  }
  const by = auto ? AUTO_BY : nameOf(actor.login || actor.username);
  b.status = "resolved";
  b.hunters = hunters;
  b.resolved_by = by;
  b.resolved = t.nowS;
  b.ended = t.nowS;
  b.fee = fee;
  b.paid = net;
  await put(b);
  await emit("resolved", b, { by, hunters, paid: net, each, extra, fee, auto, via: actor.via });
  return done("resolved", b, { paid: net, each, fee, hunters });
}

async function cancel(actor, b, a, t, asAdmin) {
  if (!b) return fail("no_bounty", `No bounty ${String(a.ref || "").toUpperCase()}.`);
  if (asAdmin && !actor.admin) return fail("admin_only", "Admin only.");
  if (!asAdmin && !isCreator(actor, b)) return fail("not_creator", `Only ${b.creator} can cancel ${ref(b)}.`, { creator: b.creator });
  if (b.status !== "open") return fail("closed", `${ref(b)} is already ${b.status}.`, { status: b.status });
  for (const c of b.pot) await L.refundInTx({ key: `refund:${c.hid}`, hid: c.hid, reason: "bounty-cancel-refund" });
  b.status = "cancelled";
  b.ended = t.nowS;
  b.cancelled_by = nameOf(actor.login || actor.username);
  await put(b);
  await emit("cancelled", b, { admin: !!asAdmin, by: b.cancelled_by, via: actor.via });
  return done("cancelled", b, { admin: !!asAdmin });
}

async function reject(actor, b, a, t) {
  const no = notOpen(b, a.ref, t);
  if (no) return no;
  const creator = isCreator(actor, b);
  const admin = !!actor.admin;
  if (!(creator || admin)) return fail("not_creator", `Only ${b.creator} (or an admin) can reject a claim on ${ref(b)}.`);
  const n = nameOf(a.hunter);
  const k = claimKey(b, n);
  if (!k) return fail("not_claimed", `${n || "That person"} hasn't claimed ${ref(b)}.`);
  const c = b.claims[k];
  if (c.disputed && !admin) return fail("disputed", `${k}'s claim on ${ref(b)} is with the admins now.`);
  const by = creator ? b.creator : nameOf(actor.login || actor.username);
  const why = oneLine(a.why, 160);
  const final = !!(admin && c.disputed);
  c.rejected = { by, why, ts: t.nowS, admin: final };
  if (final && typeof c.disputed === "object") c.disputed.closed = t.nowS;
  await put(b);
  await emit("rejected", b, { by, hunter: k, why, final, via: actor.via });
  return done("rejected", b, { hunter: k, final });
}

async function dispute(actor, b, a, t) {
  const no = notOpen(b, a.ref, t);
  if (no) return no;
  const me = nameOf(actor.login || actor.username);
  const k = claimKey(b, me) || (actor.username ? claimKey(b, actor.username) : null);
  if (!k) return fail("not_claimed", `You haven't claimed ${ref(b)} — !bounty claim ${ref(b)} first.`);
  const c = b.claims[k];
  if (c.disputed) return fail("already", `Your claim on ${ref(b)} is already with the admins.`);
  const waited = t.nowS - Number(c.ts || t.nowS);
  if (!c.rejected && waited < DISPUTE_AFTER) {
    return fail("too_soon", `Give ${b.creator} a chance first — you can dispute once they reject it, or ${Math.floor((DISPUTE_AFTER - waited) / 3600) + 1}h from now if they don't decide.`);
  }
  const why = oneLine(a.why, 160);
  c.disputed = { why, ts: t.nowS };
  await put(b);
  await emit("disputed", b, { nick: k, why, waited, via: actor.via });
  return done("disputed", b, { nick: k });
}

/** Pepe (or, through him, the creator / an admin: !bounty verify) sets how a bounty is checked. */
async function specPut(actor, b, a) {
  if (!b) return fail("no_bounty", `No bounty ${String(a.ref || "").toUpperCase()}.`);
  if (!(actor.pepe || isCreator(actor, b) || actor.admin)) return fail("not_creator", `Only ${b.creator} (or an admin) can change how ${ref(b)} is verified.`);
  if (b.status !== "open") return fail("closed", `${ref(b)} is already ${b.status}.`, { status: b.status });
  if (!a.set && b.spec_set) return Object.assign(done("spec", b), { skipped: true });   // the creator already set it by hand
  const raw = a.spec && typeof a.spec === "object" ? JSON.stringify(a.spec) : "";
  if (raw.length > 4000) return fail("too_big", "Spec too big.");
  b.spec = raw ? JSON.parse(raw) : null;
  b.spec_src = a.src ? String(a.src).slice(0, 20) : null;
  b.spec_text = b.spec ? String(a.text || describeSpec(b.spec)).slice(0, 300) : null;
  if (a.set) b.spec_set = true;
  await put(b);
  await emit("spec", b, { by: nameOf(actor.login || actor.username), set: !!a.set });
  return done("spec", b);
}

/** Pepe's evidence check of one claim (his logs live with him); stale if the claim was re-made since. */
async function checkPut(actor, b, a) {
  if (!actor.pepe) return fail("not_pepe", "Only Pepe's evidence check can do that.");
  if (!b) return fail("no_bounty", `No bounty ${String(a.ref || "").toUpperCase()}.`);
  if (b.status !== "open") return fail("closed", `${ref(b)} is already ${b.status}.`, { status: b.status });
  const k = claimKey(b, a.nick);
  if (!k) return fail("no_claim", `${nameOf(a.nick)} hasn't claimed ${ref(b)}.`);
  const c = b.claims[k];
  if (a.ts !== undefined && Number(c.ts) !== Number(a.ts)) return fail("stale", "That claim was made again since.");
  const ck = a.check === null ? null : cleanCheck(a.check);
  if (a.check !== undefined && a.check !== null && !ck) return fail("bad_check", "Bad check.");
  if (a.check !== undefined) { if (ck) c.check = ck; else delete c.check; }
  if (a.evidence !== undefined) { const ev = cleanEvidence(a.evidence); if (ev) c.evidence = ev; }
  await put(b);
  await emit("check", b, { nick: k, state: ck ? ck.state : null });
  return done("check", b, { nick: k });
}

async function act(verb, actor, a, t) {
  SAID = a && /^[A-Za-z0-9_.:@\-]{6,120}$/.test(String(a.said || "")) ? String(a.said) : null;
  try { return await act1(verb, actor, a, t); } finally { SAID = null; }
}
async function act1(verb, actor, a, t) {
  if (verb === "create") return create(actor, a, t);
  const b = await G().load(GAME, parseRef(a.ref));
  if (verb === "add") return add(actor, b, a, t);
  if (verb === "claim") return claim(actor, b, a, t);
  if (verb === "resolve") return resolve(actor, b, a, t);
  if (verb === "cancel") return cancel(actor, b, a, t, false);
  if (verb === "void") return cancel(actor, b, a, t, true);
  if (verb === "reject") return reject(actor, b, a, t);
  if (verb === "dispute") return dispute(actor, b, a, t);
  if (verb === "spec_put") return specPut(actor, b, a);
  if (verb === "check_put") return checkPut(actor, b, a);
  return fail("bad_verb", "Unknown bounty action.");
}

const READS = ["get", "list"];
async function read(verb, actor, a) {
  if (verb === "get") {
    const b = await G().load(GAME, parseRef(a.ref));
    return { bounty: b ? view(b) : null };
  }
  return { bounties: (await G().list(GAME, LIVE)).map(view) };
}

// ── deadlines ──
async function due(nowS) {
  const out = [];
  for (const b of await G().list(GAME, LIVE)) if (b.status === "open" && Number(b.deadline) < nowS) out.push(b.id);
  if (Math.random() < 0.01) {
    await runQuery("DELETE FROM escrow_games WHERE game = ? AND status IN ('resolved','cancelled','expired') AND updated < ?",
                   [GAME, Date.now() - KEEP_DAYS * 86400000]).catch(() => {});
  }
  return out;
}
async function expire(id, t) {
  const b = await G().load(GAME, id);
  if (!b || b.status !== "open" || !(Number(b.deadline) < t.nowS)) return { ok: false };
  for (const c of b.pot) await L.refundInTx({ key: `refund:${c.hid}`, hid: c.hid, reason: "bounty-expired-refund" });
  b.status = "expired";
  b.ended = t.nowS;
  await put(b);
  await emit("expired", b);
  return { ok: true };
}

// ── the website's /act form (views/bounties.ejs: task, reward, "by 7d") ──
const BY_RE = /(?:^|\s)(?:by|within|deadline)\s+(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)\s*$/i;
function durationSecs(n, unit) {
  const u = String(unit).toLowerCase();
  const mult = /^w/.test(u) ? 604800 : /^d/.test(u) ? 86400 : /^h/.test(u) ? 3600 : 60;
  return Math.round(Number(n) * mult);
}
/** Pepe's _bounty_create parse: "by 2d" at the end, the amount = the last token that is one, the rest is the task. */
function parseCreate(words) {
  let text = words.join(" ").replace(/\s+/g, " ").trim();
  let secs = DEFAULT_SECS;
  const m = BY_RE.exec(text);
  if (m) {
    secs = durationSecs(m[1], m[2]) || secs;
    text = text.slice(0, m.index).trim();
  }
  const toks = text.split(/\s+/).filter(Boolean);
  const parse = require("../public/js/patamount").parse;
  let amount = null, idx = -1;
  for (let i = toks.length - 1; i >= 0; i--) {
    const v = parse(toks[i]);
    if (v > 0) { amount = v; idx = i; break; }
  }
  if (amount === null) return { secs, amount: 0, task: text };
  return { secs, amount, task: toks.filter((_, i) => i !== idx).join(" ").trim() };
}
function fromForm(words, actor) {
  const w = words.map((x) => String(x));
  const sub = String(w[0] || "").toLowerCase();
  if (["list", "ls", "open", "help", "?", "verify", "check", "spec"].includes(sub)) return null;      // Pepe's (reads / the LLM)
  if (["add", "chip", "contribute", "+"].includes(sub) && w.length >= 3) {
    return { verb: "add", args: { ref: w[1], amount: require("../public/js/patamount").parse(w[2]) || 0 } };
  }
  if (["claim", "done", "did"].includes(sub) && w.length >= 2) return { verb: "claim", args: { ref: w[1], note: w.slice(2).join(" ") } };
  if (["resolve", "pay", "award"].includes(sub) && w.length >= 3) return { verb: "resolve", args: { ref: w[1], hunters: w.slice(2) } };
  if (["cancel", "withdraw"].includes(sub) && w.length >= 2) return { verb: "cancel", args: { ref: w[1] } };
  if (sub === "void" && w.length >= 2) return { verb: "void", args: { ref: w[1] } };
  if (["reject", "deny"].includes(sub) && w.length >= 3) return { verb: "reject", args: { ref: w[1], hunter: w[2], why: w.slice(3).join(" ") } };
  if (["dispute", "appeal"].includes(sub) && w.length >= 2) return { verb: "dispute", args: { ref: w[1], why: w.slice(2).join(" ") } };
  if (w.length === 1 && parseRef(w[0]) !== null) return null;
  if (!actor.login && !actor.username) return "Couldn't find your account.";
  const c = parseCreate(w);
  if (c.secs > MAX_SECS) return `The longest a bounty can run is ${fmtSecs(MAX_SECS)}.`;
  return { verb: "create", args: c };
}
function webReply(verb, res, args) {
  if (!res.ok) return cap(String(res.error || "Something went wrong — nothing changed."));
  if (res.dup) return `Already done (${res.ref}).`;
  const b = res.bounty || {};
  if (verb === "create") return `🎯 Bounty ${res.ref} is up: PAT ${fmt(total(b))} for "${b.task}" (${fmtSecs(Number(b.deadline) - Number(b.created))}).`;
  if (verb === "add") return `💰 Added PAT ${fmt(res.amount)} to ${res.ref} — the pot is PAT ${fmt(res.total)} now.`;
  if (verb === "claim") return b.spec ? "Claim sent — Pepe is checking his logs." : "Claim sent — the poster picks who gets paid.";
  if (verb === "resolve") return `🏆 ${res.ref} paid: ${(res.hunters || []).join(", ")} collect PAT ${fmt(res.paid)}.`;
  if (verb === "cancel" || verb === "void") return `↩️ ${res.ref} cancelled — everyone who chipped in is refunded.`;
  if (verb === "reject") return `🚫 Rejected ${res.hunter}'s claim.`;
  if (verb === "dispute") return "⚖️ Sent to the admins.";
  return "Done.";
}

// ── the cutover (Pepe's bounties.json <-> here) ──
function cleanImport(x) {
  const list = Array.isArray(x && x.bounties) ? x.bounties : Object.values((x && x.bounties) || {});
  const records = [];
  for (const raw of list) {
    const id = Math.trunc(Number(raw && raw.id));
    if (!(id > 0)) throw new L.Refuse(400, "a bounty without an id", "E_BAD_RECORD");
    const st = String(raw.status || "");
    if (st === "paying") throw new L.Refuse(409, `BT${id} is mid-step (paying) - let Pepe finish it first`, "E_BUSY");
    if (![...LIVE, ...RECENT].includes(st)) throw new L.Refuse(400, `BT${id}: unknown status ${st.slice(0, 20)}`, "E_BAD_RECORD");
    const pot = (Array.isArray(raw.pot) ? raw.pot : []).map((c) => ({ hid: String(c && c.hid || ""), nick: String(c && c.nick || "").slice(0, 60),
                                                                       amount: Math.floor(Number(c && c.amount)), user: c && c.user ? String(c.user).slice(0, 80) : undefined }));
    if (st === "open") {
      if (!pot.length) throw new L.Refuse(400, `BT${id}: open without a pot`, "E_BAD_RECORD");
      for (const c of pot) if (!c.hid || !(c.amount > 0)) throw new L.Refuse(400, `BT${id}: a pot entry without its hold / amount`, "E_BAD_RECORD");
    }
    let claims = raw.claims || {};
    if (Array.isArray(claims)) claims = Object.fromEntries(claims.filter((c) => c && c.nick).map((c) => [String(c.nick), Object.assign({}, c)]));
    const b = view(Object.assign({}, raw, { id, pot, claims: JSON.parse(JSON.stringify(claims)), hunters: Array.isArray(raw.hunters) ? raw.hunters : [] }));
    b.users = Object.assign({}, raw.users || {});
    if (!b.users.creator && pot[0] && G().same(pot[0].nick, b.creator) && pot[0].user) b.users.creator = pot[0].user;
    records.push(b);
  }
  return { records, seq: Math.trunc(Number(x && x.seq) || 0) };
}
function importTotals({ records }) {
  const holds = [];
  let sum = 0, count = 0;
  for (const b of records || []) {
    if (!LIVE.includes(b.status)) continue;
    count++;
    for (const c of b.pot || []) {
      holds.push({ id: String(c.hid), ref: `BT${b.id}`, amount: Math.floor(Number(c.amount)) });
      sum += Math.floor(Number(c.amount));
    }
  }
  return { sum, count, holds };
}
/** The cutover precondition: no website bounty action may still be waiting for Pepe (the old bounty_actions queue retires). */
async function beforeImport() {
  let n = 0;
  try { n = Number((await getQuery("SELECT COUNT(*) AS n FROM bounty_actions WHERE status IN ('pending','claimed')"))[0].n) || 0; } catch (e) { n = 0; }
  if (n) throw new L.Refuse(409, `${n} website bounty action(s) still waiting for Pepe (bounty_actions pending/claimed) - let him finish them first`, "E_BUSY", { pending: n });
}

module.exports = { GAME, LIVE, RECENT, READS, MIN, ADD_MIN, FEE_PCT, DEFAULT_SECS, MAX_SECS, MAX_OPEN, DISPUTE_AFTER, AUTO_BY, act, read, due, expire, mirror,
                   fromForm, webReply, cleanImport, importTotals, beforeImport, parseCreate, describeSpec, evidenceOf, view, fmtSecs };
