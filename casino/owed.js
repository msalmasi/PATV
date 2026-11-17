// casino/owed.js — 1.99aoj: casino PAT kept OWED because its credit was refused, and the owner's tool that settles it
// (/admin/casino/owed: casino/owedweb.js, views/admin/casino-owed.ejs, public/js/admin-owed.js; docs/casino-backend.md).
//
// A credit (money.credit -> ledger.post) is refused only when its account is gone - a hard purge or a broken merge (a merged
// account is followed). The PAT it would have paid is never dropped: it stays at the table, owed, and the table is never closed
// while anything is owed (blackjack: frozen, T.closing; Hold'em: open until the last owed item is settled).
//   * blackjack: a round's refused payout (T.owed[cbj:<t>:r<n>:<uid>:pay], kind "payout"); a stake refund refused when a player
//     leaves the betting window or the table closes (T.owed[<the stake's key>:refund], kind "refund" - service.js refundHeld); the
//     refund of a stake a restart caught in its intent (T.owed[<the intent's key>:refund]).
//   * Hold'em: a refused cash-out - the seat keeps its stack, sitting out (holdem.js refusedOut; T.qol[uid].refused = {key, since,
//     tries, code}, kind "cashout", retried by its sit-out clock under that SAME key); the refund of a buy-in a restart caught in its
//     intent (T.owed[<the intent's key>:refund]).
// Every T.owed entry is {uid, amount, round, kind, type, since, tries, code, next}, credited again by its OWN key (money.credit
// looks the key up first: a credit that landed replays - never pays twice) on the table's clock (RETRY_MS), at every boot and
// before a close.
//
// The tool lists every item of every open table and settles one - under the casino mutex, idempotent by the form's key, refused
// when the item changed since the page was drawn (its id, a hash of the table + its key, and its amount):
//   * retry now (casino admins): the item's own retry, at once;
//   * redirect (a Pepe owner + the password step-up): credited to another account by a NEW derived key <item key>:redirect;
//   * write off (a Pepe owner + the password step-up): to the House - jackpot_rakes <item key>:writeoff under the table's casino
//     spin id (cbj:<t>:r<n> / chm:<t>:owed: jackpotflows "casino tables"), the leg the casino's money routing books a lost stake
//     to. Never burned.
// One item lands under at most ONE of {its key, :redirect, :writeoff}, ever: every retry asks for the other two first
// (settledBy), a redirect / write-off asks for the original key first. A redirect or write-off is journalled on the table
// (T.owed_act, saved BEFORE the money moves); a restart finishes it (the move landed: the item closes) or drops it (nothing
// moved) before anything retries (resolve). 1.99aoj review: an act that THREW after its journal (a database error mid-move) is
// resolved the same way at once, or by the next locked step at that table (the tool's next action, the item's automatic retry) -
// every act runs under the casino mutex, so an act seen by another locked step is never in flight. Every action is in admin_audit
// (action "casino_owed"): who, the item (its page id, its key), the amount, the reason, the recipient (its account id and
// username, its ban / deletion lock), the ledger / House row it wrote (its key, the spin), via web, the outcome - one row per
// action (an act's id dedupes a restart).
// 1.99aoj review: a redirect's recipient is named EXACTLY when two usernames differ only in capitals (otherwise refused), is never
// an archived or deleted account (nobody can use points there), and a site-banned / deletion-scheduled one is paid only when the
// owner ticks "Pay this account anyway" (b.locked_ok) after the page said so.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("../dbUtils");
const money = require("./money");

const RETRY_MS = 10 * 60 * 1000;          // (service.js C.OWED_RETRY_MS is this clock)
const amt = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const count = (T) => Object.keys((T && T.owed) || {}).length;
/** an owed entry whose clock ran out */
const due = (T, t) => count(T) > 0 && Object.values(T.owed).some((o) => !(o.next > t));
const redirectKey = (key) => key + ":redirect";
const writeoffKey = (key) => key + ":writeoff";

/** "redirected" / "written off" when an owner settled that item elsewhere already, else null */
async function settledBy(key) {
  if (await money.isDone(redirectKey(key))) return "redirected";
  if (await money.houseDone(writeoffKey(key))) return "written off";
  return null;
}
/** its own credit landed, or an owner settled it elsewhere: nothing of it is owed any more (a table's save can be behind) */
const landed = async (key) => (await money.isDone(key)) || !!(await settledBy(key));
const actDone = async (a) => (a.op === "redirect" ? money.isDone(a.dkey) : money.houseDone(a.dkey));

/** a refused credit -> owed on the table (the same key twice - a step run again after a crash - stays one entry, tried once more) */
function owe(T, key, x, t, ms) {
  T.owed = T.owed || {};
  const o = T.owed[key] || { uid: x.uid, amount: amt(x.amount), round: x.round == null ? null : x.round, kind: x.kind || "payout",
                             type: x.type || null, since: t, tries: 0 };
  o.tries += 1;
  o.code = x.code || null;
  o.next = t + (ms || RETRY_MS);
  T.owed[key] = o;
  return o;
}
const defaultType = (T, o) => `${T.game === "holdem" ? "holdem" : "blackjack"} ${o.kind === "refund" ? "refund" : "payout"}`;

/**
 * Each owed entry credited again by its own key - every one (opts.all: a boot, a close), one (opts.only: the tool's retry), or the
 * ones whose clock ran out. An entry an owner settled elsewhere closes unpaid. An owner's settle left journalled (T.owed_act) is
 * resolved first (resolve, opts.hooks): every caller holds the casino mutex, so it is one that threw (or a restart caught) - never
 * one in flight (before the 1.99aoj review its item was skipped until a restart, and a due one kept the tick saving every 250 ms).
 * Saves nothing. -> how many are still owed
 */
async function retry(T, opts) {
  const p = opts || {};
  const t = p.t, ms = p.ms || RETRY_MS;
  if (T.owed_act) await resolve(T, p.hooks, "an error");
  for (const [key, o] of Object.entries(T.owed || {})) {
    if (p.only && key !== p.only) continue;
    if (!p.all && !p.only && o.next > t) continue;
    const by = await settledBy(key);
    if (by) {
      delete T.owed[key];
      console.log(`[casino] ${T.id}: owed ${o.kind || "payout"} ${key} was ${by} by an owner already - closed, not paid again`);
      continue;
    }
    const r = await money.credit(key, o.uid, o.amount, o.type || defaultType(T, o));
    if (r.ok) {
      delete T.owed[key];
      console.log(`[casino] ${T.id}: owed ${o.kind || "payout"} ${key} (${fmt(o.amount)} PAT) ${r.replay ? "had landed already" : "paid"} after ${o.tries} refusal(s)`);
      continue;
    }
    o.tries += 1;
    o.code = r.code || null;
    o.next = t + ms;
    console.error(`[casino] ${T.id}: owed ${o.kind || "payout"} ${key} (${fmt(o.amount)} PAT to ${o.uid}) refused again (${r.code}) - tried again in ${ms / 60000} min`);
  }
  return count(T);
}

/** supply.js: the PAT still owed at a table - entries whose credit hasn't landed (nor been settled elsewhere), minus a Hold'em seat's
 *  stack an owner already paid elsewhere while the table's save is behind (T.owed_act) */
async function held(T) {
  let n = 0;
  for (const [key, o] of Object.entries((T && T.owed) || {})) if (!(await landed(key))) n += amt(o && o.amount);
  const a = T && T.owed_act;
  if (a && a.kind === "cashout" && (await actDone(a))) n -= Math.min(amt(a.amount), amt(((T.eng || {}).chips || {})[a.uid]));
  return n;
}

/** every owed item of a table: its T.owed entries and (Hold'em) the seats whose cash-out was refused */
function itemsOf(T) {
  const out = [];
  if (!T || T.status !== "open") return out;
  for (const [key, o] of Object.entries(T.owed || {})) {
    out.push({ key, kind: o.kind || "payout", uid: o.uid, amount: amt(o.amount), round: o.round == null ? null : o.round,
               since: o.since || null, tries: o.tries || 0, code: o.code || null, next: o.next || null });
  }
  if (T.game === "holdem" && !T.tourney && T.eng) {
    for (const uid of T.eng.seats || []) {
      const r = T.qol && T.qol[uid] && T.qol[uid].refused;
      if (!r || !r.key) continue;
      out.push({ key: r.key, kind: "cashout", uid, amount: amt((T.eng.chips || {})[uid]), round: null, since: r.since || null, tries: r.tries || 0,
                 code: r.code || null, next: (T.dl && T.dl.sitout && T.dl.sitout[uid]) || null });
    }
  }
  return out.filter((it) => it.amount > 0);
}
/** an item's id on the page: never its key (a key names the account id) */
const itemId = (T, key) => crypto.createHash("sha256").update(`owed|${T.id}|${key}`).digest("hex").slice(0, 16);
/** a short opaque reference for a member whose account row is gone (never the account id) */
const shortId = (uid) => crypto.createHash("sha256").update(`owed-member|${uid}`).digest("hex").slice(0, 8);
function whatOf(T, it) {
  if (it.kind === "cashout") return "cash-out (the seat's chips)";
  if (it.kind === "refund") return T.game === "holdem" ? "buy-in refund" : `stake refund (round ${it.round == null ? "?" : it.round})`;
  return `round ${it.round == null ? "?" : it.round} payout`;
}
const labelOf = (T, it) => (it.kind === "cashout" ? "holdem cash-out" : `${T.game === "holdem" ? "holdem" : "blackjack"} ${it.kind === "refund" ? "refund" : "payout"}`) + " (redirected)";
const spinOf = (T, it) => (T.game === "holdem" ? `chm:${T.id}:owed` : `cbj:${T.id}:r${it.round == null ? T.eng.round_no : it.round}`);
/** a redirect's recipient by username: the exact spelling first; two accounts differing only in capitals and none spelled exactly ->
 *  {ambiguous}; none -> null (1.99aoj review - the old look-up took whichever case-variant row came first) */
async function targetOf(name) {
  const rows = await getQuery("SELECT userId, username, archived_at FROM users WHERE LOWER(username) = LOWER(?) ORDER BY (username = ?) DESC LIMIT 2", [name, name]);
  if (!rows.length) return null;
  if (rows[0].username === name || rows.length === 1) return rows[0];
  return { ambiguous: true };
}
const lockText = (lock) => (lock.kind === "deletion" ? "scheduled for deletion by PATV staff" : lock.until != null ? "site-banned for now" : "site-banned");
const nameOf = async (uid) => ((await getQuery("SELECT username FROM users WHERE userId = ?", [uid]).catch(() => []))[0] || {}).username || null;

/** One admin_audit row per action (an act's id: a restart that finishes it never writes a second). Never throws.
 *  1.99aoj review: the row names the item (its page id and its key), the recipient's ACCOUNT id beside its username (a username can be
 *  renamed later), its ban / deletion lock, and the ledger row (a redirect: transactions <key>:redirect) or House row (a write-off:
 *  jackpot_rakes <key>:writeoff + its spin id) the action wrote - so the row joins the ledger. (admin_audit is admins-only; recent()
 *  passes none of these ids to the page.) */
async function audit(by, d, reason) {
  try {
    const A = require("../adminaudit");
    await A.init();
    if (d.act && (await getQuery("SELECT 1 FROM admin_audit WHERE action = 'casino_owed' AND detail LIKE ?", [`%"act":"${d.act}"%`])).length) return;
    const detail = { op: d.op, act: d.act || null, table: d.table, game: d.game, item: d.item || null, key: d.key || null, what: d.what, amount: d.amount,
                     to: d.to || null, to_id: d.to_id || null, via: "web", outcome: d.outcome, code: d.code || null };
    if (d.to_lock) detail.to_lock = d.to_lock;
    if (d.ledger_key) detail.ledger_key = d.ledger_key;
    if (d.house_key) { detail.house_key = d.house_key; detail.spin = d.spin || null; }
    await A.record(by, "casino_owed", { userId: d.uid, username: await nameOf(d.uid) }, detail, reason || null);
  } catch (e) { console.error("[casino] owed audit:", e && e.message ? e.message : e); }
}
const actAudit = (a, outcome) => audit(a.by, { op: a.op, act: a.id, table: a.table, game: a.game, item: a.item, key: a.key, what: a.what, amount: a.amount,
                                               to: a.to_name, to_id: a.to, to_lock: a.to_lock || null, uid: a.uid, outcome,
                                               ledger_key: a.op === "redirect" ? a.dkey : null, house_key: a.op === "redirect" ? null : a.dkey, spin: a.spin }, a.reason);

/** the settled item leaves the table: its owed entry, or (Hold'em) the seat with its stack (paid elsewhere) */
async function closeItem(T, a, hooks) {
  if (a.kind === "cashout") { if (hooks && hooks.dropSeat) await hooks.dropSeat(T, a.uid, { quiet: !!(hooks && hooks.quiet) }); }
  else if (T.owed) delete T.owed[a.key];
}

/**
 * At boot (service.recover / holdem.js recover), before anything retries: a redirect / write-off a restart caught. Its move landed ->
 * the item closes; nothing moved -> the act is dropped (the item stays owed). Audited either way. Saves nothing. -> true when there was one
 * 1.99aoj review: also for an act that threw after its journal (why "an error": settleItem's catch, the tool's next action, retry).
 */
async function resolve(T, hooks, why) {
  const a = T && T.owed_act;
  if (!a) return false;
  const after = why || "a restart";
  if (await actDone(a)) {
    await actAudit(a, `done (finished after ${after})`);
    await closeItem(T, a, Object.assign({ quiet: true }, hooks || {}));
    console.log(`[casino] ${T.id}: an owner's ${a.op} of ${a.key} (${fmt(a.amount)} PAT) landed before ${after} - the item is closed`);
  } else {
    await actAudit(a, `interrupted by ${after} - nothing moved`);
    console.warn(`[casino] ${T.id}: an owner's ${a.op} of ${a.key} was interrupted by ${after} before it moved anything - still owed`);
  }
  T.owed_act = null;
  return true;
}

/**
 * 1.99aoj review (the rollback runbook): owed items left in CLOSED rows. 1.99aoi - the build the site CI's automatic rollback runs -
 * doesn't know T.owed: it closes such a table (the idle close, an admin's close) with the items still in its saved JSON, and no build
 * retries, counts or lists them after (the tool sees open tables only). Run once per boot (service.js boot), read only: the closed
 * blackjack / Hold'em rows whose saved owed still holds an item that never landed (its key, :redirect or :writeoff) are named in the
 * log and in one ops alert (every site admin; one per set of tables - opsalerts.js dedupes by ref), so someone settles them by hand
 * (docs/casino-backend.md, the rollback runbook). d.alert: the ops alert (tests). -> [{table, game, closed_at, n, amount}]
 */
async function closedAudit(d) {
  const alert = (d && d.alert) || ((a) => require("../opsalerts").alert(a));
  // (the prefilter: a non-empty owed object as JSON.stringify saves it - "owed":{} never matches; each match is parsed and checked)
  const rows = await getQuery(`SELECT id, game, state FROM casino_tables WHERE status = 'closed' AND game IN ('bj', 'holdem') AND instr(state, '"owed":{"') > 0`);
  const out = [];
  for (const r of rows) {
    let T;
    try { T = JSON.parse(r.state); } catch (e) { continue; }
    let n = 0, amount = 0;
    for (const [key, o] of Object.entries((T && T.owed) || {})) {
      if (!o || !amt(o.amount) || (await landed(key))) continue;
      n += 1;
      amount += amt(o.amount);
    }
    if (n) out.push({ table: r.id, game: r.game, closed_at: T.closed_at || null, n, amount });
  }
  if (!out.length) return out;
  const total = out.reduce((s, x) => s + x.amount, 0);
  const ids = out.map((x) => x.table);
  console.error(`[casino] ${out.length} closed table(s) still hold ${fmt(total)} PAT owed that no build pays (a rollback closed them): ${ids.slice(0, 20).join(", ")}` +
                `${ids.length > 20 ? ` and ${ids.length - 20} more` : ""} - settle them by hand (docs/casino-backend.md, the rollback runbook)`);
  try {
    await alert({ source: "casino_owed", ref: "closed:" + crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16),
                  title: `${out.length} closed casino table(s) still hold ${fmt(total)} PAT owed`,
                  body: `A rollback build closed ${out.length === 1 ? "this table" : "these tables"} with points still owed (a payout or refund whose account was gone): ` +
                        `${ids.slice(0, 20).join(", ")}. Nothing retries or counts them and /admin/casino/owed doesn't list them - settle each by hand ` +
                        `(docs/casino-backend.md, "Rolling back to 1.99aoi with something owed").` });
  } catch (e) { console.error("[casino] owed closed-table alert:", e && e.message ? e.message : e); }
  return out;
}

/**
 * The tool (casino/owedweb.js). core: {S, clock, save, locked, games: {bj: {after}, holdem: {after, retrySeat, dropSeat}}}
 *   after(T)            the table's step once an item is settled (a frozen round marked done, a table waiting to close closes, Hold'em's
 *                       deadlines / close); saves. -> true when it closed
 *   retrySeat(T, uid)   Hold'em: the refused seat's own cash-out, now (holdem.js standCmd)
 *   dropSeat(T, uid, o) Hold'em: the seat leaves, its stack paid elsewhere (o.quiet: no table line)
 */
function install(core) {
  const { S, clock, save, locked } = core;
  const G = (T) => core.games[T.game === "holdem" ? "holdem" : "bj"];
  const crash = (name) => { if (S.hooks && S.hooks.crash === name) throw Object.assign(new Error("test crash at " + name), { crash: true }); };   // tests only
  const ok = (message, extra) => Object.assign({ ok: true, message }, extra || {});
  const fail = (status, code, error) => ({ ok: false, status, code, error });
  const tablePath = (T) => `/casino/${T.game === "holdem" ? "holdem" : "blackjack"}/t/${T.id}`;

  async function describe(T, it) {
    const name = await nameOf(it.uid);
    return { id: itemId(T, it.key), table: T.id, game: T.game, url: tablePath(T), high_stakes: !!T.high_stakes, kind: it.kind, round: it.round,
             what: whatOf(T, it), member: name ? { name } : { name: null, missing: true, ref: shortId(it.uid) }, amount: it.amount,
             since: it.since, tries: it.tries, code: it.code, next: it.next, closing: !!T.closing };
  }
  const openTables = () => Array.from(S.tables.values()).filter((T) => T.status === "open" && (T.game === "bj" || T.game === "holdem"));
  /** every item owed at the open tables (oldest first) */
  async function list() {
    const rows = [];
    for (const T of openTables()) for (const it of itemsOf(T)) rows.push(await describe(T, it));
    return rows.sort((a, b) => (a.since || 0) - (b.since || 0));
  }
  /** the /admin/games badge: {n, amount} */
  function summary() {
    let n = 0, amount = 0;
    for (const T of openTables()) for (const it of itemsOf(T)) { n += 1; amount += it.amount; }
    return { n, amount };
  }
  /** the newest audited actions (no account ids: the member as the audit named them, never target_id) */
  async function recent(limit) {
    const rows = await require("../adminaudit").recent("casino_owed", limit || 20).catch(() => []);
    return rows.map((r) => ({ at: r.at, by: r.admin, member: r.target || null, reason: r.reason, op: (r.detail || {}).op || null, what: (r.detail || {}).what || null,
                              amount: (r.detail || {}).amount || 0, to: (r.detail || {}).to || null, table: (r.detail || {}).table || null,
                              game: (r.detail || {}).game || null, outcome: (r.detail || {}).outcome || null }));
  }

  /** op "retry" | "redirect" | "writeoff"; admin {userId, username}; body {table, item, amount, idem, reason?, to?}. Under the mutex;
   *  the same idem answers what it answered the first time. -> {ok, message} | {ok: false, status, code, error} */
  function act(op, admin, body) {
    const b = body || {};
    return locked(async () => {
      const ik = `owed-admin:${admin.userId}:${String(b.idem || "").slice(0, 100)}`;
      const prev = await getQuery("SELECT response FROM casino_actions WHERE key = ?", [ik]);
      if (prev.length) return Object.assign(JSON.parse(prev[0].response), { replayed: true });
      const out = await run(op, admin, b);
      await runQuery("INSERT OR IGNORE INTO casino_actions (key, table_id, userId, response, created) VALUES (?, ?, ?, ?, ?)",
                     [ik, String(b.table || "").slice(0, 20) || null, admin.userId, JSON.stringify(out), clock()]);
      return out;
    });
  }

  async function run(op, admin, b) {
    const T = S.tables.get(String(b.table || ""));
    if (!T || T.status !== "open" || (T.game !== "bj" && T.game !== "holdem")) return fail(409, "E_GONE", "That table isn't open any more - reload the page.");
    // 1.99aoj review: an earlier settle at this table that threw after its journal (a database error mid-move) - finished or dropped now,
    // as a restart would (under the mutex nothing else is in flight); it used to answer "busy" to every action there until a restart
    if (T.owed_act) {
      await resolve(T, G(T), "an error");
      await G(T).after(T);
      if (T.status !== "open") return fail(409, "E_CHANGED", "That item was settled already - reload the page.");
    }
    const it = itemsOf(T).find((x) => itemId(T, x.key) === String(b.item || ""));
    if (!it) return fail(409, "E_CHANGED", "That item isn't owed any more - reload the page.");
    if (Number(b.amount) !== it.amount) return fail(409, "E_CHANGED", `The amount changed since the page was drawn (it is ${fmt(it.amount)} PAT now) - reload the page.`);
    if (it.kind === "cashout" && T.eng.hand_active && T.eng.players.includes(it.uid)) return fail(409, "E_IN_HAND", "That seat is in a hand - try again when the hand ends.");
    if (op === "retry") return retryItem(T, it, admin);
    return settleItem(T, it, op, admin, b);
  }

  async function retryItem(T, it, admin) {
    let paid;
    if (it.kind === "cashout") {
      await G(T).retrySeat(T, it.uid);
      paid = !T.eng.seats.includes(it.uid);
    } else {
      await retry(T, { only: it.key, t: clock(), ms: RETRY_MS });
      paid = !(T.owed && T.owed[it.key]);
      await G(T).after(T);
    }
    const now = paid ? null : itemsOf(T).find((x) => x.key === it.key);
    await audit(admin, { op: "retry", table: T.id, game: T.game, item: itemId(T, it.key), key: it.key, what: whatOf(T, it), amount: it.amount, uid: it.uid,
                         outcome: paid ? "paid" : "still refused", code: now ? now.code : null }, null);
    return paid ? ok(`Paid to the original account (${fmt(it.amount)} PAT).`)
                : fail(409, "E_REFUSED", `Still refused (${(now && now.code) || "?"}) - it stays owed, and it is tried again automatically.`);
  }

  async function settleItem(T, it, op, admin, b) {
    const reason = String(b.reason == null ? "" : b.reason).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
    if (reason.length < 8) return fail(400, "E_REASON", "Write a reason (at least 8 characters) - it goes in the admin log.");
    // nothing is owed after all: its own credit landed (a table's save was behind), or it was settled elsewhere already
    const by = await settledBy(it.key);
    if (by || (await money.isDone(it.key))) {
      await closeItem(T, { kind: it.kind, key: it.key, uid: it.uid }, G(T));
      await G(T).after(T);
      await audit(admin, { op, table: T.id, game: T.game, item: itemId(T, it.key), key: it.key, what: whatOf(T, it), amount: it.amount, uid: it.uid,
                           outcome: by ? `already ${by}` : "had landed already" }, reason);
      return fail(409, "E_LANDED", by ? `It was ${by} already - nothing is owed.` : "It reached the original account after all - nothing is owed.");
    }
    let to = null, lock = null;
    if (op === "redirect") {
      const name = String(b.to == null ? "" : b.to).trim().replace(/^@/, "").slice(0, 64);
      if (!name) return fail(400, "E_TO", "Name the account to pay.");
      to = await targetOf(name);
      if (!to) return fail(404, "E_TO", `No account called ${name}.`);
      if (to.ambiguous) return fail(409, "E_TO_AMBIGUOUS", `More than one account is called ${name} in different capitals - type the username exactly as it is written.`);
      if (to.userId === it.uid) return fail(409, "E_SAME", "That's the original account - use Retry now.");
      if (to.archived_at) return fail(409, "E_TO_ARCHIVED", `${to.username} is an archived or deleted account - nobody can use points paid there. Restore it first, or name another account.`);
      lock = await require("../siteban").startLock(to.userId);
      if (lock && b.locked_ok !== true) {
        return Object.assign(fail(409, "E_TO_LOCKED", `${to.username} is ${lockText(lock)}. Tick "Pay this account anyway" to pay it all the same.`), { lock: lock.kind });
      }
    }
    const a = { id: crypto.randomBytes(6).toString("hex"), op, key: it.key, item: itemId(T, it.key), kind: it.kind, uid: it.uid, amount: it.amount,
                dkey: op === "redirect" ? redirectKey(it.key) : writeoffKey(it.key), spin: spinOf(T, it), to: to ? to.userId : null, to_name: to ? to.username : null,
                to_lock: lock ? lock.kind : null, by: { userId: admin.userId, username: admin.username }, reason, at: clock(), table: T.id, game: T.game, what: whatOf(T, it) };
    T.owed_act = a;                  // the journal: saved before anything moves (resolve finishes or drops it after a restart)
    await save(T);
    try {
      crash("owed:act");
      if (op === "redirect") {
        const r = await money.credit(a.dkey, a.to, a.amount, labelOf(T, it));
        if (!r.ok) {
          T.owed_act = null;
          await save(T);
          await audit(admin, { op, act: a.id, table: T.id, game: T.game, item: a.item, key: a.key, what: a.what, amount: a.amount, to: a.to_name, to_id: a.to,
                               to_lock: a.to_lock, uid: a.uid, outcome: "refused", code: r.code }, reason);
          return fail(409, "E_TO_REFUSED", `${to.username} couldn't be credited (${r.code}) - nothing moved, and it stays owed.`);
        }
      } else {
        await money.house(a.dkey, a.spin, null, a.amount);
      }
      crash("owed:moved");
      await actAudit(a, "done");
      await closeItem(T, a, G(T));
      T.owed_act = null;
    } catch (e) {
      // 1.99aoj review: an error after the journal (a database error mid-move) - finished (the move landed) or dropped (nothing moved)
      // now, as a restart would; if that fails too, the next locked step at this table resolves it (run, retry). (A test's simulated
      // process death - e.crash - leaves the journal for the boot, like a real one.)
      if (!(e && e.crash) && T.owed_act === a) {
        try { await resolve(T, G(T), "an error"); await G(T).after(T); }
        catch (e2) { console.error(`[casino] ${T.id}: an owner's ${op} of ${a.key} failed and couldn't be resolved yet:`, e2 && e2.message ? e2.message : e2); }
      }
      throw e;
    }
    await G(T).after(T);
    console.log(`[casino] ${T.id}: ${admin.username} ${op === "redirect" ? "redirected" : "wrote off"} ${a.key} (${fmt(a.amount)} PAT${a.to_name ? " to " + a.to_name : " to the House"})`);
    return ok(op === "redirect" ? `Paid ${fmt(a.amount)} PAT to ${a.to_name}.` : `Written off: ${fmt(a.amount)} PAT went back to the House.`);
  }

  return { list, summary, recent, act };
}

module.exports = { RETRY_MS, count, due, owe, retry, settledBy, landed, held, itemsOf, itemId, shortId, whatOf, resolve, install,
                   redirectKey, writeoffKey, closedAudit };
