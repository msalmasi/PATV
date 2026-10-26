// botcredits.js — the bot-token routes that move PAT into wallets or the House (1.99jw, Economy v3).
//
// "Every PAT the site pays must be funded by a named pool and logged": Pepe (and the Discord / Twitch bots) credit
// wallets through POST /api/bonus/chatwinner and move House money through POST /api/g/heist/jackpot-adjust. The site
// can't see Pepe's vaults, so it asks each call to NAME the pool it was paid from and carries a reference that makes
// it idempotent, and it logs every call in bot_credit_log:
//
//   bot_credit_log  ref (PRIMARY KEY - the caller's ref, or one made up when it sent none), ts (ms), endpoint
//                   ("chatwinner" | "jackpot-adjust" | "merge-balance"), userId, type, amount, source, outcome
//                   ("ok", or why it was refused: unsourced, no_user, insufficient, unfunded, error, ...)
//   A ref that already succeeded ("ok") is a duplicate: 200 with duplicate:true and nothing moves again. A ref that
//   failed may be retried. The effect and its "ok" row are written in ONE transaction (boosts.tx), so a crash can't
//   leave a credit without its log row or the other way round.
//
//   POST /api/bonus/chatwinner {password, userId, type, amount, source?, ref?, counterparty?, idempotency_key?}
//        A POSITIVE amount whose type isn't discord-* / twitch-* must carry `source` (the pool Pepe debited, <= 64)
//        and `ref` (<= 80), else 400 {success:false, error:"unsourced"} and nothing moves. discord-* / twitch-* credits
//        are still paid on the site out of the platform_rewards flow (funding.js). Debits (negative) are as before:
//        only what the balance covers. A free reward (the type is on autoescrow's kinds list) for a Camfrog AUTO account
//        is held in auto_escrow instead while that switch is on: 200 with escrowed:true, expires_at (docs/auto-account-escrow.md).
//        1.99afh (owner, 2026-10-26):
//        * platform_rewards is paid by the INCENTIVE BUDGET only: when Pepe's last sync routes it anywhere else, or never
//          routed it (vaultFor would read that as the Reserve), a discord-* / twitch-* credit is refused 409 "no_route" -
//          never a Reserve claim. (Connect bonuses and redemption codes have their own flows and aren't touched.)
//        * type "twitch-channelpoints" {userId, twitch_user_id, reward_id, reward_title, ref} pays the ALLOW-LISTED reward's
//          amount (twitchcp.js) - never the caller's `amount`, never a number from a title: a ref is required ("twitch-cp:"
//          + the redemption id, so a repeated EventSub delivery is a duplicate), an unlisted reward is refused 409
//          "not_allowlisted", one above the site's cap 409 "over_cap", and the account must be the one linked to that
//          Twitch user id (404 "no_user"). The answer carries `amount` (what was paid).
//   POST /api/g/heist/jackpot-adjust {password, amount, userId?, source, ref}   source (<= 64) and ref (<= 80) required.
//   POST /api/users/merge-balance {password, fromUserId, toUserId, ref}  the WHOLE balance of fromUserId moves to
//        toUserId atomically, two "account merge" transactions rows (out / in, each naming the other account), idempotent
//        per ref. Replaces POST /api/users/zero-balance (credit-then-zero, which wasn't atomic).
//   POST /api/g/stale/reclaimed {password, user: <username | userId>}  what the stale-account cleanup reclaimed from and
//        restored to that account (reserve_claims stale_reclaim / stale_restore) - Pepe caps "restore" mints with it.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const ledger = require("./ledger");
const funding = require("./funding");

let readyP = null;
function init() {
  if (!readyP) {
    readyP = runQuery(`CREATE TABLE IF NOT EXISTS bot_credit_log (
        ref TEXT PRIMARY KEY, ts INTEGER, endpoint TEXT, userId TEXT, type TEXT, amount INTEGER, source TEXT, outcome TEXT)`)
      .then(() => runQuery("CREATE INDEX IF NOT EXISTS bot_credit_log_ts ON bot_credit_log (ts)"))
      .catch((e) => { readyP = null; throw e; });
  }
  return readyP;
}

const tx = (fn) => require("./boosts").tx(fn);
const newRef = (ep) => `auto:${ep}:${crypto.randomBytes(9).toString("hex")}`;
const PLATFORM = /^(discord|twitch)-/i;

/** A refusal inside the transaction: rolls it back, then is logged with its outcome and answered. */
class Refusal extends Error {
  constructor(status, body, outcome) { super(outcome); this.status = status; this.body = body; this.outcome = outcome; }
}

/** source / ref: absent (undefined / null / ""), or a string of 1..max characters. -> {ok, value} */
function optStr(v, max) {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim();
  if (!s || s.length > max) return { ok: false };
  return { ok: true, value: s };
}

/** Log an attempt that didn't move anything (never overwrites a successful row). */
async function note(e, outcome) {
  try {
    await init();
    await runQuery(`INSERT INTO bot_credit_log (ref, ts, endpoint, userId, type, amount, source, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ref) DO UPDATE SET ts = excluded.ts, endpoint = excluded.endpoint, userId = excluded.userId, type = excluded.type,
                      amount = excluded.amount, source = excluded.source, outcome = excluded.outcome
                    WHERE bot_credit_log.outcome IS NOT 'ok'`,
                   [e.ref || newRef(e.endpoint), Date.now(), e.endpoint, e.userId == null ? null : String(e.userId).slice(0, 80),
                    e.type == null ? null : String(e.type).slice(0, 80), Number.isFinite(e.amount) ? Math.trunc(e.amount) : null,
                    e.source || null, String(outcome).slice(0, 40)]);
  } catch (err) { console.error("[botcredits] log:", err.message); }
}

/**
 * Run `effect` in one transaction together with the entry's "ok" log row. -> {duplicate:true, row} when the ref already
 * succeeded, else {duplicate:false, result}. A Refusal thrown by `effect` rolls everything back, is logged with its
 * outcome and rethrown; any other error is logged as "error" and rethrown.
 */
async function logged(entry, effect) {
  await init();
  const e = Object.assign({}, entry, { ref: entry.ref || newRef(entry.endpoint) });
  try {
    return await tx(async () => {
      const prev = (await getQuery("SELECT * FROM bot_credit_log WHERE ref = ?", [e.ref]))[0];
      if (prev && prev.outcome === "ok") return { duplicate: true, row: prev };
      const result = await effect(e);
      const amount = result && Number.isFinite(result.logAmount) ? result.logAmount : e.amount;
      const vals = [Date.now(), e.endpoint, e.userId == null ? null : String(e.userId).slice(0, 80), e.type == null ? null : String(e.type).slice(0, 80),
                    Number.isFinite(amount) ? amount : null, e.source || null];   // (a merge may move fractional dust)
      if (prev) await runQuery("UPDATE bot_credit_log SET ts = ?, endpoint = ?, userId = ?, type = ?, amount = ?, source = ?, outcome = 'ok' WHERE ref = ?", [...vals, e.ref]);
      else await runQuery("INSERT INTO bot_credit_log (ts, endpoint, userId, type, amount, source, outcome, ref) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)", [...vals, e.ref]);
      return { duplicate: false, result, ref: e.ref };
    });
  } catch (err) {
    await note(e, err instanceof Refusal ? err.outcome : "error");
    throw err;
  }
}

// ── 1.99afh: Twitch channel-point redemptions (twitchcp.js) ──
const CHANNEL_POINTS = "twitch-channelpoints";
const isChannelPoints = (type) => String(type == null ? "" : type).trim().toLowerCase() === CHANNEL_POINTS;
const PLATFORM_FLOW = "platform_rewards";

/** The redeemed reward a channel-point call names: {id, title} (both as Twitch sent them, bounded). */
function cpReward(b) {
  const id = typeof b.reward_id === "string" && b.reward_id.trim() ? b.reward_id.trim().slice(0, 64) : null;
  const title = typeof b.reward_title === "string" ? b.reward_title.slice(0, 120) : null;
  return { id, title };
}
/** bot_credit_log's source for a redemption: which reward it was (the reward's id, else its title). */
const cpSource = (reward) => ("twitch-reward:" + (reward.id || reward.title || "?")).slice(0, 64);

/**
 * Before anything moves: the ref, the allowlist, the cap and the account linked to the Twitch user id.
 * -> {amount, reward} to pay, or {answer} (a duplicate's 200 or a refusal, already logged).
 */
async function channelPointsPrep(b) {
  const T = require("./twitchcp");
  const reward = cpReward(b);
  const rf = optStr(b.ref, 80);
  const entry = { endpoint: "chatwinner", userId: b.userId || null, type: CHANNEL_POINTS, amount: null, source: cpSource(reward), ref: rf.ok ? rf.value : null };
  const refuse = async (status, error, extra) => {
    await note(entry, error);
    await T.noteSeen(reward, error);
    console.warn(`[bonus] ${CHANNEL_POINTS} "${String(reward.title || "").slice(0, 60)}" (reward ${reward.id || "-"}) for ${b.userId || "-"} refused: ${error}`);
    return { answer: { status, json: Object.assign({ success: false, error }, extra || {}) } };
  };
  // the redemption's id makes it idempotent: a repeated EventSub delivery must not pay twice
  if (!rf.ok || !rf.value) return refuse(400, "unsourced");
  await init();
  const prev = (await getQuery("SELECT outcome, amount FROM bot_credit_log WHERE ref = ?", [rf.value]))[0];
  if (prev && prev.outcome === "ok") {
    return { answer: { status: 200, json: { duplicate: true, message: "Bonus winner logged and points awarded successfully", amount: Number(prev.amount) || 0 } } };
  }
  const cfg = await T.get();
  const hit = T.resolve(reward, cfg);
  if (!hit) return refuse(409, "not_allowlisted");
  entry.amount = hit.amount;
  if (hit.amount > cfg.cap) return refuse(409, "over_cap", { cap: cfg.cap });
  // credited by the Twitch USER ID (never a display name): the account must be the one linked to it
  const tw = typeof b.twitch_user_id === "string" || typeof b.twitch_user_id === "number" ? String(b.twitch_user_id).trim() : "";
  if (!/^\d{1,20}$/.test(tw) || !b.userId) return refuse(400, "bad_twitch_user");
  let linked = null;
  try { linked = (await getQuery("SELECT userId FROM users WHERE userId = ? AND twitchId = ?", [String(b.userId), tw]))[0] || null; } catch (e) { linked = null; }
  if (!linked) return refuse(404, "no_user", { code: ledger.E_TARGET_NOT_FOUND });
  return { amount: hit.amount, reward };
}

// ── POST /api/bonus/chatwinner ──
async function chatwinner(body, deps = {}) {
  const b = body || {};
  const { userId, type } = b;
  let { amount } = b;
  // 1.99afh: a channel-point redemption pays the allow-listed reward's amount, never the caller's
  const cp = isChannelPoints(type);
  let reward = null;
  if (cp) {
    const prep = await channelPointsPrep(b);
    if (prep.answer) return prep.answer;
    amount = prep.amount;
    reward = prep.reward;
  }
  if (!userId || !amount || !type) return { status: 400, text: "Missing required fields" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || Math.trunc(amt) === 0) return { status: 400, text: "Missing required fields" };
  const src = cp ? { ok: true, value: cpSource(reward) } : optStr(b.source, 64), rf = optStr(b.ref, 80);
  const entry = { endpoint: "chatwinner", userId, type: cp ? CHANNEL_POINTS : String(type), amount: Math.trunc(amt), source: src.ok ? src.value : null, ref: rf.ok ? rf.value : null };
  const out = await chatwinnerPay(b, deps, { userId, type: entry.type, amt, src, rf, entry, cp });
  if (cp) await require("./twitchcp").noteSeen(reward, out.outcome);
  delete out.outcome;
  return out;
}

/** The credit itself (after the channel-point checks). -> {status, json | text, outcome} - outcome is what was logged. */
async function chatwinnerPay(body, deps, { userId, type, amt, src, rf, entry, cp: isCp }) {
  const amount = Math.trunc(amt);
  if (!src.ok || !rf.ok) {
    await note(entry, "bad_source");
    return { status: 400, json: { success: false, error: !src.ok ? "bad_source" : "bad_ref" }, outcome: "bad_source" };
  }
  const platform = PLATFORM.test(String(type));
  // 1.99jw: a credit that isn't a platform reward must say which pool paid it, and be idempotent
  if (amt > 0 && !platform && (!src.value || !rf.value)) {
    await note(entry, "unsourced");
    console.warn(`[bonus] ${type} +${amount} for ${userId} refused: no source/ref (unsourced)`);
    return { status: 400, json: { success: false, error: "unsourced" }, outcome: "unsourced" };
  }
  // 1.99ga: an account that doesn't exist is refused BEFORE any vault is touched
  if (!(await ledger.userExists(userId))) {
    await note(entry, "no_user");
    console.warn(`[bonus] ${type} ${amount} for missing account ${userId} - refused (${ledger.E_TARGET_NOT_FOUND})`);
    return { status: 404, json: { success: false, error: "no_user", code: ledger.E_TARGET_NOT_FOUND }, outcome: "no_user" };
  }
  const cp = deps.resolveCounterparty ? await deps.resolveCounterparty(body.counterparty) : null;
  const okBody = Object.assign({ message: "Bonus winner logged and points awarded successfully" }, isCp ? { amount } : {});
  let out;
  try {
    out = await logged(entry, async () => {
      // 1.63: Discord/Twitch rewards are paid OUT of a vault ("platform_rewards"), never minted
      if (amt > 0 && platform) {
        // 1.99afh (owner, 2026-10-26): ... and that vault is the incentive budget - routed elsewhere, or not routed by any
        // sync yet (vaultFor's default would make it a Reserve claim), the credit is refused, never paid by the Reserve
        const route = funding.routeOf(PLATFORM_FLOW);
        if (route !== "incentives") {
          console.warn(`[bonus] ${type} +${amount} for ${userId} refused: ${PLATFORM_FLOW} is routed to ${route || "nothing yet"}, not the incentive budget (no_route)`);
          throw new Refusal(409, { success: false, skipped: true, error: "no_route", message: "platform rewards are paid by the incentive budget only" }, "no_route");
        }
        const take = await funding.takeFundsRef(PLATFORM_FLOW, amount, userId, String(type));
        if (!take.ok) throw new Refusal(409, { success: false, skipped: true, error: "unfunded", message: "the bank can't cover it" }, "unfunded");
      }
      // Credit, or debit only what the balance covers: a deduction can never take anyone below zero.
      const transactionId = require("uuid").v4();
      // auto-account escrow (autoescrow.js): a free reward for a Camfrog auto account is held instead (platform rewards never)
      const posted = await require("./autoescrow").credit(userId, amount, "bonus win", { requireCover: true, counterparty: cp, transactionId,
                                                                           source: `bonus ${type}${src.value ? " from " + src.value : ""}`,
                                                                           kind: platform ? null : String(type) });
      if (!posted.ok) {
        if (posted.code === ledger.E_INSUFFICIENT) throw new Refusal(402, { success: false, error: "insufficient" }, "insufficient");
        throw new Refusal(404, { success: false, error: "no_user", code: ledger.E_TARGET_NOT_FOUND }, "no_user");
      }
      await runQuery("INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
                     [require("uuid").v4(), type, posted.userId, transactionId, amount]);
      return { userId: posted.userId, escrowed: !!posted.escrowed, expires_at: posted.expires_at || null };
    });
  } catch (e) {
    if (e instanceof Refusal) return { status: e.status, json: e.body, outcome: e.outcome };
    throw e;
  }
  if (out.duplicate) {
    const dup = Object.assign({ duplicate: true }, okBody);
    if (isCp) dup.amount = Number(out.row.amount) || 0;
    return { status: 200, json: dup, outcome: "duplicate" };
  }
  // escrowed: Pepe tells the person it's waiting for them (pepe_autoescrow.py) - it isn't in their wallet
  if (out.result && out.result.escrowed) return { status: 200, json: Object.assign({}, okBody, { escrowed: true, expires_at: out.result.expires_at }), outcome: "ok" };
  return { status: 200, json: okBody, outcome: "ok" };
}

// ── POST /api/g/heist/jackpot-adjust ──
async function jackpotAdjust(body) {
  const b = body || {};
  if (b.amount === undefined || b.amount === null || b.amount === "" || isNaN(Number(b.amount))) return { status: 400, text: "Missing or invalid amount" };
  const amount = Math.round(Number(b.amount));
  const src = optStr(b.source, 64), rf = optStr(b.ref, 80);
  const entry = { endpoint: "jackpot-adjust", userId: b.userId || null, type: "house", amount, source: src.ok ? src.value : null, ref: rf.ok ? rf.value : null };
  if (!src.ok || !rf.ok || !src.value || !rf.value) {
    await note(entry, "unsourced");
    console.warn(`[jackpot-adjust] ${amount} refused: no source/ref (unsourced)`);
    return { status: 400, json: { success: false, error: "unsourced" } };
  }
  const out = await logged(entry, async () => {
    const spinId = "bot:" + require("uuid").v4();     // 1.99gx: tagged - Pepe logs these himself (jackpotflows.js keeps them apart)
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [require("uuid").v4(), spinId, b.userId || null, amount]);
    return {};
  });
  const pot = await funding.jackpotPot();
  return { status: 200, json: out.duplicate ? { success: true, jackpotTotal: pot, duplicate: true } : { success: true, jackpotTotal: pot } };
}

// ── POST /api/users/merge-balance ──
let txCols = null;
async function hasCounterparty() {
  if (txCols === null || !txCols.counterparty) {
    const c = (await getQuery("SELECT name FROM pragma_table_info('transactions')")).map((r) => r.name);
    txCols = { counterparty: c.includes("counterparty") };
  }
  return txCols.counterparty;
}
async function mergeBalance(body) {
  const b = body || {};
  const from = typeof b.fromUserId === "string" ? b.fromUserId.trim() : "";
  const to = typeof b.toUserId === "string" ? b.toUserId.trim() : "";
  const rf = optStr(b.ref, 80);
  if (!from || !to || !rf.ok || !rf.value) return { status: 400, json: { ok: false, error: "fromUserId, toUserId and ref are required" } };
  if (from === to) return { status: 400, json: { ok: false, error: "from and to are the same account" } };
  await ledger.ensure();
  const cp = await hasCounterparty();
  const entry = { endpoint: "merge-balance", userId: from, type: "account merge", amount: 0, source: "account:" + to, ref: rf.value };
  let out;
  try {
    out = await logged(entry, async () => {
      const a = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [from]))[0];
      const t = (await getQuery("SELECT 1 FROM users WHERE userId = ?", [to]))[0];
      if (!a || !t) throw new Refusal(404, { ok: false, error: !a ? "no such account (from)" : "no such account (to)" }, "no_user");
      const moved = Number(a.b) || 0;
      if (moved > 0) {
        // the WHOLE balance (fractional dust included), both rows naming the other account, so the ledger adds up
        const { v4 } = require("uuid");
        const ins = (uid, pts, other) => cp
          ? runQuery("INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, 'account merge', ?, ?)", [v4(), uid, pts, other])
          : runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'account merge', ?)", [v4(), uid, pts]);
        await ins(from, -moved, to);
        await ins(to, moved, from);
        const d = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ?", [moved, from]);
        const c = await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [moved, to]);
        if (!d || d.changes !== 1 || !c || c.changes !== 1) throw new Error("merge-balance: balance not moved");
      }
      return { moved, logAmount: moved };
    });
  } catch (e) {
    if (e instanceof Refusal) return { status: e.status, json: e.body };
    throw e;
  }
  if (out.duplicate) return { status: 200, json: { ok: true, moved: Number(out.row.amount) || 0, duplicate: true } };
  console.log(`[merge-balance] ${out.result.moved} PAT ${from} -> ${to} (ref ${rf.value})`);
  return { status: 200, json: { ok: true, moved: out.result.moved } };
}

// ── POST /api/g/stale/reclaimed ──
async function staleReclaimed(user) {
  const u = String(user || "").trim();
  if (!u) return { status: 404, json: { ok: false } };
  const rows = await getQuery("SELECT userId, username FROM users WHERE userId = ? OR LOWER(username) = LOWER(?) ORDER BY (userId = ?) DESC LIMIT 1", [u, u, u]);
  if (!rows.length) return { status: 404, json: { ok: false } };
  const { userId, username } = rows[0];
  let reclaimed = 0, restored = 0;
  try {
    const r = (await getQuery(`SELECT COALESCE(SUM(CASE WHEN flow = 'stale_reclaim' THEN -amount ELSE 0 END), 0) AS rc,
                                      COALESCE(SUM(CASE WHEN flow = 'stale_restore' THEN amount ELSE 0 END), 0) AS rs
                               FROM reserve_claims WHERE userId = ? AND flow IN ('stale_reclaim', 'stale_restore')`, [userId]))[0] || {};
    reclaimed = Number(r.rc) || 0; restored = Number(r.rs) || 0;
  } catch (e) { /* no reserve_claims yet: nothing reclaimed */ }
  return { status: 200, json: { ok: true, userId, username, reclaimed, restored } };
}

function register(app, { isBotToken, idemBegin, resolveCounterparty }) {
  init().catch((e) => console.error("[botcredits] init:", e.message));
  const send = (res, r) => (r.json !== undefined ? res.status(r.status).json(r.json) : res.status(r.status).send(r.text));

  app.post("/api/bonus/chatwinner", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).send("Access denied");
    // the caller's idempotency_key (an older Pepe) still replays the stored answer
    const idem = idemBegin ? await idemBegin(req, res, "bonus/chatwinner") : { replay: false, done: () => {}, fail: () => {} };
    if (idem.replay) return;
    try {
      const r = await chatwinner(req.body || {}, { resolveCounterparty });
      if (r.json !== undefined) idem.done(r.status, r.json); else idem.fail();
      send(res, r);
    } catch (e) {
      idem.fail();
      console.error("Failed to process bonus winner:", e);
      res.status(500).send("Failed to process bonus winner");
    }
  });

  app.post("/api/g/heist/jackpot-adjust", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).send("Access denied");
    try { send(res, await jackpotAdjust(req.body || {})); } catch (e) {
      console.error("Heist jackpot-adjust error:", e);
      res.status(500).send("Failed to adjust jackpot");
    }
  });

  app.post("/api/users/merge-balance", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { send(res, await mergeBalance(req.body || {})); } catch (e) {
      console.error("[merge-balance]", e);
      res.status(500).json({ ok: false, error: "internal server error" });
    }
  });

  // (a POST, so the bot token travels in the body, never in a URL)
  app.post("/api/g/stale/reclaimed", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { send(res, await staleReclaimed((req.body || {}).user)); } catch (e) {
      console.error("[stale/reclaimed]", e);
      res.status(500).json({ ok: false });
    }
  });
}

module.exports = { register, init, chatwinner, jackpotAdjust, mergeBalance, staleReclaimed, note, CHANNEL_POINTS };
