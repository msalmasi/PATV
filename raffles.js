// raffles.js — 🎫 PAT Raffles (1.99xk): anyone verified sets a prize, sells tickets for PAT, and a provably fair draw picks
// the winner. The SITE owns everything (tickets, escrow, the draw, the payouts); Pepe is only a chat client
// (camfrog-bot pepe_raffles.py: !raffle, announcements).
//
// A RAFFLE
//   prize       "pat"    a PAT amount the creator puts up (held in escrow from the moment the raffle is made)
//               "item"   an OFFICIAL Prize Shop item (shopcatalog: giftable, delivered by PATV - staff / Plex invite / role).
//                        One of its stock is RESERVED when the raffle is made (prizes.quantity - 1) and comes back if the
//                        raffle doesn't draw. A community creator pays the item's shop price into escrow up front (it goes
//                        to the store owner at the draw, exactly like a shop sale); a house raffle's item is PATV's own.
//               "custom" something the creator describes and delivers themselves. Buyer protection: the ticket pot stays
//                        in escrow after the draw until the winner confirms delivery, or custom_hold_days pass without a
//                        dispute; a dispute freezes it for an admin (release to the creator, or refund every ticket).
//   tickets     price (PAT), optional max per person, a minimum to run, an optional cap on the total
//   the draw    trigger "date"   at draw_at, IF the minimum is reached (else it keeps selling and draws the moment the
//                                minimum is reached - until the expiry)
//               trigger "target" as soon as `target` tickets are sold (sales stop there)
//               expires_at       not drawn by then -> every ticket refunded in full, the prize returned / released
//   the pad it belongs to (padlinks: pad column, moved by padrekey), title / description / image
//   house       admins' official raffles: listed first, highlighted, announced in every room Pepe is in; the whole ticket
//               pot goes to the House (a house PAT prize is paid by the House at the draw)
//
// MONEY - every move is ONE dbUtils.tx (escrow/ledger.js in-transaction primitives; holds are SERVICE kinds, never Pepe's):
//   RFT-<id> a ticket purchase (one hold per purchase)   RFP-<id> the creator's PAT prize   RFI-<id> the creator's item price
//   draw (community): the prize hold -> the winner; the ticket holds -> the creator minus the fee; the fee goes where the PAT
//                     Routing row `raffle_fee` says (default 100% House) - pool legs while the pools are live
//   draw (house):     the ticket holds -> the House (fee leg "jackpot"); a PAT prize -> the winner out of the House
//   expiry / takedown / a refunded dispute: every held ticket back to its buyer in full, the prize hold back to the creator,
//                     a reserved item back in stock
//   Nothing is minted or burned: supply is unchanged by every path (test/raffles.test.js checks it).
//
// FAIRNESS (the lotto / casino commit-reveal, casino/fair.js): a secret server_seed is made with the raffle and
//   commitment = sha256(server_seed) is published at once. At the draw, tickets_digest = sha256 of every purchase in order,
//   one line "<first>-<last>:<username>\n"; the winning ticket = 1 + below(n) over the HMAC-SHA256(server_seed,
//   `${tickets_digest}:R<id>:${counter}`) word stream. The seed is revealed after the draw; /raffles/<id> re-checks it in
//   the browser (and verify() here).
//
// ABUSE: verified accounts only (verified.js) create; creations per day, open raffles per user, a max ticket price; the
//   creator and their linked alts (welcome_bonus.dup_of, shared device / identity keys) can't buy; text
//   guard on everything Pepe repeats; community pictures are site pictures only; admin takedown with full refunds.
//   1.99xo (the user): NO ticket limit per raffle (only 1,000 tickets per purchase as a request-size guard); max PAT prize 1.5B.
//
// ADMIN EDIT (1.99afy, edit()): an admin changes an OPEN raffle - the draw date, the expiry, the target, the words any time;
//   price / trigger only before the first ticket; after it the minimum only down, the cap and max per person only up; the
//   prize never; never past 2 x max_days after it was made. Audited, an "edited" event, ONE notice per ticket holder a few
//   minutes after the last change (see the comment above planEdit). A chat buy (Pepe sends no price) is checked against the
//   price the buyer was last shown - the announced one (price0) or a newer one (raffle_price_seen) - see botAct.
//
// Tables (records follow the ACCOUNT - accountMerge.js rules):
//   raffles        one row per raffle (see init)
//   raffle_tickets one row per purchase: ticket numbers first_no..last_no, hold_id, key (UNIQUE idempotency), state
//   raffle_events  what Pepe announces (created / milestone / drawn / expired / removed / released / refunded; edited = not
//                  announced, it wakes the pages / the poll)
//   raffle_price_seen (1.99afy) the changed ticket price a chat buyer was shown (by !raffle <id> or a refused buy)
//   raffles_meta   enabled (the feature switch: default ON on staging, OFF on prod) / config (admin settings)
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const FLOW = "raffle_fee";
const KIND_TICKET = "RFT", KIND_PRIZE = "RFP", KIND_ITEM = "RFI";
const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const OPEN = ["open"];
const LIVE = ["open", "delivering", "disputed"];             // counts toward a creator's open raffles
const FINAL = ["drawn", "complete", "expired", "removed", "refunded"];
const STATUSES = ["open", "drawn", "delivering", "disputed", "complete", "expired", "removed", "refunded"];

let clock = () => Date.now();
const now = () => clock();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const str = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const int = (v) => { const n = Math.floor(Number(String(v == null ? "" : v).replace(/[,_\s]/g, ""))); return Number.isFinite(n) ? n : NaN; };
/** Tickets a raffle may hold at a price: no product cap (1.99xo) - only the pot (price x tickets) must stay a safe integer. */
const MAX_TICKETS = (price) => Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, Number(price) || 1));
/** A typed PAT amount ("25k", "1.5m", "12,000" - Pepe's rules, public/js/patamount.js) -> int or NaN. */
const pat = (v) => { if (typeof v === "number") return Math.floor(v); const n = require("./public/js/patamount").parse(v); return n ? Math.floor(n) : NaN; };

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || null; }
}

// ── config (admin-editable; every number here is a proposal listed for the user) ──
const DEFAULTS = Object.freeze({
  fee_pct: 10,                 // % of a community raffle's ticket pot, to the raffle_fee routing row (House by default)
  price_min: 10, price_max: 1000000,          // a ticket's price
  // 1.99xo (the user): NO ticket limit per raffle - a target / cap / minimum is any whole number (only the pot has to stay a
  // safe integer); the draw settles the ticket holds in chunks of SETTLE_CHUNK inside its one transaction, so the number of
  // separate purchases isn't capped either
  buy_max: 1000,               // tickets in one purchase (a request-size guard, not a raffle limit)
  prize_min: 1000, prize_max: 1500000000,     // a PAT prize (1.99xo: 1.5B, the user)
  open_max: 3,                 // live community raffles per creator
  per_day: 3,                  // community raffles a creator can make per 24 h
  min_lead_min: 10,            // a date draw at least this far ahead
  max_days: 30,                // the expiry at most this far ahead
  grace_hours: 1,              // a date raffle's expiry at least this long after its draw time
  custom_hold_days: 7,         // a custom prize: the pot waits this long for the winner's confirmation / a dispute
  custom_allowed: true,        // community raffles may offer a custom prize
  announce_milestones: true,   // Pepe announces 25 / 50 / 75 / 100% of the target (or the minimum)
});
const LIMITS = {
  fee_pct: [0, 50], price_min: [1, 1e9], price_max: [1, 1e10], buy_max: [1, 1e5],
  prize_min: [1, 1e12], prize_max: [1, 1e12], open_max: [0, 100], per_day: [0, 100], min_lead_min: [0, 1440], max_days: [1, 365],
  grace_hours: [0, 720], custom_hold_days: [1, 60],
};
let CONFIG = { ...DEFAULTS };
function cleanConfig(c) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = (c || {})[k];
    if (typeof d === "boolean") out[k] = v === undefined || v === null || v === "" ? d : (v === true || v === 1 || v === "1" || v === "on" || v === "true");
    else {
      const [lo, hi] = LIMITS[k] || [0, 1e12];
      const n = Math.floor(Number(v));
      out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    }
  }
  if (out.price_max < out.price_min) out.price_max = out.price_min;
  if (out.prize_max < out.prize_min) out.prize_max = out.prize_min;
  return out;
}
const config = () => ({ ...CONFIG });

// ── storage ──
let ready = null;
let enabledCache = !!process.env.STAGING;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS raffles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, creator_id TEXT NOT NULL, house INTEGER NOT NULL DEFAULT 0, pad TEXT,
        title TEXT NOT NULL, description TEXT, image_url TEXT,
        prize_kind TEXT NOT NULL, prize_amount INTEGER NOT NULL DEFAULT 0, prize_item TEXT, prize_name TEXT, prize_cost INTEGER NOT NULL DEFAULT 0,
        prize_text TEXT, prize_hold TEXT,
        price INTEGER NOT NULL, max_per_user INTEGER NOT NULL DEFAULT 0, min_tickets INTEGER NOT NULL DEFAULT 1, max_tickets INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT NOT NULL, draw_at INTEGER, target INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
        fee_pct INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', sold INTEGER NOT NULL DEFAULT 0, pot INTEGER NOT NULL DEFAULT 0,
        buyers INTEGER NOT NULL DEFAULT 0, purchases INTEGER NOT NULL DEFAULT 0, milestones INTEGER NOT NULL DEFAULT 0,
        server_seed TEXT NOT NULL, commitment TEXT NOT NULL, tickets_digest TEXT, winning_no INTEGER, winner_id TEXT, winner_name TEXT,
        fee INTEGER NOT NULL DEFAULT 0, creator_payout INTEGER NOT NULL DEFAULT 0, fee_legs TEXT, order_id INTEGER, release_at INTEGER,
        dispute_by TEXT, dispute_note TEXT, dispute_at INTEGER,
        closed_by TEXT, close_reason TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, drawn_at INTEGER, closed_at INTEGER,
        price0 INTEGER, note_due INTEGER, note_from TEXT,
        CHECK (price > 0))`);
      // 1.99afy: price0 = the price the raffle was announced at (Pepe's "created" line; a chat buy is checked against it, or
      // against the price it was last shown - raffle_price_seen); note_due / note_from = the edit notices waiting to go out
      const cols = (await getQuery("SELECT name FROM pragma_table_info('raffles')")).map((x) => x.name);
      if (!cols.includes("price0")) {
        await runQuery("ALTER TABLE raffles ADD COLUMN price0 INTEGER");
        await runQuery("UPDATE raffles SET price0 = price WHERE price0 IS NULL");     // no price had been edited before 1.99afy
      }
      if (!cols.includes("note_due")) await runQuery("ALTER TABLE raffles ADD COLUMN note_due INTEGER");
      if (!cols.includes("note_from")) await runQuery("ALTER TABLE raffles ADD COLUMN note_from TEXT");
      await runQuery("CREATE INDEX IF NOT EXISTS raffles_note ON raffles (note_due)");
      await runQuery(`CREATE TABLE IF NOT EXISTS raffle_price_seen (
        raffle_id INTEGER NOT NULL, user_id TEXT NOT NULL, price INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (raffle_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS raffles_status ON raffles (status, house)");
      await runQuery("CREATE INDEX IF NOT EXISTS raffles_creator ON raffles (creator_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS raffles_pad ON raffles (pad, status)");
      await runQuery(`CREATE TABLE IF NOT EXISTS raffle_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, raffle_id INTEGER NOT NULL, user_id TEXT NOT NULL, username TEXT, qty INTEGER NOT NULL,
        first_no INTEGER NOT NULL, last_no INTEGER NOT NULL, amount INTEGER NOT NULL, hold_id TEXT, key TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL DEFAULT 'held', via TEXT, created INTEGER NOT NULL, CHECK (qty > 0 AND amount > 0))`);
      await runQuery("CREATE INDEX IF NOT EXISTS raffle_tickets_raffle ON raffle_tickets (raffle_id, first_no)");
      await runQuery("CREATE INDEX IF NOT EXISTS raffle_tickets_user ON raffle_tickets (user_id, raffle_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS raffle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, raffle_id INTEGER, kind TEXT NOT NULL, data TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS raffles_meta (key TEXT PRIMARY KEY, value TEXT)");
      // the escrow ledger's tables before any of our transactions use them (a memoized init inside a tx would wait on the gate)
      try { await ESC().init(); } catch (e) { console.error("[raffles] escrow init:", e.message); }
      try { await require("./econstore").init(); } catch (e) { /* no econ store: the fee goes to the House */ }
      const c = await meta("config");
      CONFIG = cleanConfig(c || {});
      await enabled();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function meta(key) {
  const r = (await getQuery("SELECT value FROM raffles_meta WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
const setMeta = (key, v) => runQuery("INSERT INTO raffles_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                     [key, JSON.stringify(v)]);
/** The feature switch (raffles_meta.enabled): default ON on staging (STAGING env), OFF on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled").catch(() => null);
  enabledCache = v === true || v === false ? v : !!process.env.STAGING;
  return enabledCache;
}
const enabledSync = () => enabledCache;
async function setEnabled(on, admin) {
  await init();
  await setMeta("enabled", !!on);
  enabledCache = !!on;
  if (admin) { try { await require("./adminaudit").record(admin, "raffles_switch", null, { enabled: !!on }); } catch (e) { /* audit is optional */ } }
  return enabledCache;
}
async function setConfig(input, admin) {
  await init();
  const before = config();
  const next = cleanConfig(Object.assign({}, CONFIG, input || {}));
  await setMeta("config", next);
  CONFIG = next;
  if (admin) { try { await require("./adminaudit").record(admin, "raffles_config", null, { before, after: next }); } catch (e) { /* optional */ } }
  return next;
}

// ── helpers ──
const ESC = () => require("./escrow/ledger");
async function escrowLive() { try { return !!(await ESC().live()); } catch (e) { return false; } }
async function needOn() {
  await init();
  if (!(await enabled())) throw new Refuse(423, "PAT Raffles aren't open yet.", "E_OFF");
}
async function needEscrow() {
  if (!(await escrowLive())) throw new Refuse(423, "Raffles open once the PAT escrow is live on this site.", "E_ESCROW_NOT_LIVE");
}
const USER_COLS = "userId, username, displayname, camfrogUsername, class, points_balance, discordId, twitchId, isEmailVerified, email";
async function userRow(userId) {
  if (!userId) return null;
  try { return (await getQuery(`SELECT ${USER_COLS} FROM users WHERE userId = ?`, [String(userId)]))[0] || null; } catch (e) {
    // a test database without every column
    return (await getQuery("SELECT userId, username, camfrogUsername, class, points_balance FROM users WHERE userId = ?", [String(userId)]))[0] || null;
  }
}
async function userByLogin(login) {
  const k = String(login || "").trim().replace(/^@+/, "");
  if (!k) return null;
  const r = (await getQuery(`SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) ORDER BY points_balance DESC LIMIT 1`, [k]))[0];
  return r ? userRow(r.userId) : null;
}
const rafflesAdmin = (u) => SP.can(u, "raffles.admin");   // 1.99ack (siteperms.js)
async function isVerified(u) {
  if (!u) return false;
  try { return await require("./verified").verify(u); } catch (e) { return !!u.camfrogUsername; }
}
const balanceOf = async (userId) => Number(((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [userId]))[0] || {}).b) || 0;
/** The creator and the buyer are the same person (same account, a known alt: dup_of or a shared device / identity key). */
async function linked(a, b) {
  if (!a || !b) return false;
  if (String(a) === String(b)) return true;
  try {
    const pairs = await require("./engagement").altPairs([String(a), String(b)]);
    if (pairs.has(`${a}|${b}`)) return true;
  } catch (e) { /* fall through to the direct check */ }
  const r = await getQuery("SELECT 1 AS x FROM welcome_bonus WHERE (userId = ? AND dup_of = ?) OR (userId = ? AND dup_of = ?) LIMIT 1", [a, b, b, a]).catch(() => []);
  return r.length > 0;
}

// ── fairness ──
const fair = () => require("./casino/fair");
const newSeed = () => crypto.randomBytes(32).toString("hex");
const commitmentOf = (seed) => crypto.createHash("sha256").update(String(seed), "utf8").digest("hex");
const ticketLine = (t) => `${t.first_no}-${t.last_no}:${String(t.username || "").toLowerCase()}\n`;
/** purchases [{first_no, last_no, username}] in ticket order -> sha256 hex */
function ticketsDigest(rows) {
  const h = crypto.createHash("sha256");
  for (const t of [...rows].sort((a, b) => a.first_no - b.first_no)) h.update(ticketLine(t), "utf8");
  return h.digest("hex");
}
/** The winning ticket number (1..n). */
function winningNumber(seed, digest, id, n) {
  if (!(n > 0)) return null;
  const F = fair();
  return 1 + F.below(F.words(seed, digest, `R${id}`), n);
}
/** rec {id, commitment, server_seed, tickets_digest, sold, winning_no, tickets?} -> {ok, commitment_ok, digest_ok, number_ok, number} */
function verify(rec) {
  if (!rec || !rec.server_seed) return { ok: false, reason: "the seed isn't revealed yet" };
  const commitmentOk = commitmentOf(rec.server_seed) === String(rec.commitment || "");
  const digestOk = !Array.isArray(rec.tickets) || ticketsDigest(rec.tickets) === rec.tickets_digest;
  const n = winningNumber(rec.server_seed, rec.tickets_digest, rec.id, Number(rec.sold));
  const numberOk = rec.winning_no == null || n === Number(rec.winning_no);
  return { ok: commitmentOk && digestOk && numberOk, commitment_ok: commitmentOk, digest_ok: digestOk, number_ok: numberOk, number: n };
}

// ── the fee's routing (the PAT Routing table's row raffle_fee; source of truth /admin/economy) ──
/** [[dest, pct], ...]: the admin's override of raffle_fee, else Pepe's routing catalog default, else the House 100%. Throws
 *  E_CFG_UNREADABLE / E_CFG_MISSING while the site owns the economy settings and can't read them: the draw / release is
 *  deferred (its transaction rolls back), never routed by a default (econstore.routeShares). */
async function feeShares() {
  return require("./econstore").routeShares(FLOW, [["jackpot", 100]]);
}
/** The fee legs a settle books: [[dest, amount]] summing to `amount`. The House = "jackpot"; a pool leg only while the pools
 *  are live on the site; a room / room_owner share (no room context here) -> Fort Knox; whatever isn't routed -> the Reserve
 *  (or the House while the pools aren't live). */
async function feeLegs(amount) {
  if (!(amount > 0)) return [];
  const P = require("./pools");
  let live = false;
  try { live = await P.live(); } catch (e) { live = false; }
  const dest = (d) => {
    d = String(d || "");
    if (d === "jackpot" || d === "house" || d === "casino") return "jackpot";
    if (d === "room" || d === "room_owner" || /^room:/.test(d)) d = "fortknox";
    return live && P.isPool(d) && d !== "burn" && d !== "lotto" ? d : "jackpot";
  };
  const out = new Map();
  let used = 0;
  for (const sh of (await feeShares()) || []) {
    const p = Number((sh || [])[1]);
    if (!(p > 0)) continue;
    const a = Math.floor(amount * p / 100);
    if (a <= 0) continue;
    const d = dest((sh || [])[0]);
    out.set(d, (out.get(d) || 0) + a);
    used += a;
  }
  const rest = amount - used;
  if (rest > 0) { const d = dest("reserve"); out.set(d, (out.get(d) || 0) + rest); }
  return [...out.entries()];
}

// ── reads ──
async function raffleRow(id) {
  const n = parseInt(String(id || "").replace(/^#?r(?:f)?/i, ""), 10);
  if (!n) return null;
  return (await getQuery("SELECT * FROM raffles WHERE id = ?", [n]))[0] || null;
}
async function eligibleItems() {
  try { return await require("./shop").raffleItems(); } catch (e) { return []; }
}
function padView(padId) {
  try { return require("./padlinks").view(padId); } catch (e) { return null; }
}
function canSeePad(viewer, padId) {
  if (!padId) return true;
  try { return require("./padaccess").canSee(viewer || null, padId); } catch (e) { return false; }
}
/** When it draws / closes next: a date raffle draws at draw_at (or at once once the minimum is met after it); else the expiry. */
function nextAt(r) {
  if (r.status !== "open") return null;
  if (r.trigger_kind === "date" && r.draw_at && now() < r.draw_at) return r.draw_at;
  return r.expires_at;
}
/** The shape every page / Pepe / the embed sees (no seed while it's secret). */
function shape(r, { viewer = null, mine = null, creatorName = null } = {}) {
  const goal = r.trigger_kind === "target" ? r.target : (r.max_tickets || 0);
  const minHit = r.sold >= r.min_tickets;
  const out = {
    id: r.id, ref: "R" + r.id, url: "/raffles/" + r.id, house: !!r.house, title: r.title, description: r.description || "", image: r.image_url || null,
    prize: { kind: r.prize_kind, amount: r.prize_amount, item: r.prize_item, name: r.prize_name, cost: r.prize_cost, text: r.prize_text },
    price: r.price, max_per_user: r.max_per_user, min_tickets: r.min_tickets, max_tickets: r.max_tickets,
    trigger: r.trigger_kind, draw_at: r.draw_at, target: r.target, expires_at: r.expires_at, goal, min_hit: minHit,
    status: r.status, sold: r.sold, pot: r.pot, buyers: r.buyers, fee_pct: r.fee_pct, next_at: nextAt(r),
    commitment: r.commitment, pad: r.pad || null, padv: padView(r.pad), creator: r.house ? null : (creatorName || null), created: r.created,
    drawn_at: r.drawn_at, closed_at: r.closed_at, winner: r.winner_name || null, winning_no: r.winning_no,
    release_at: r.release_at, close_reason: r.close_reason || null,
  };
  if (FINAL.includes(r.status) || ["delivering", "disputed"].includes(r.status)) {
    if (r.tickets_digest) { out.server_seed = r.server_seed; out.tickets_digest = r.tickets_digest; }
  }
  if (mine) out.mine = mine;
  if (viewer && r.winner_id && viewer === r.winner_id) out.youWon = true;
  return out;
}
async function names(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    for (const r of await getQuery(`SELECT userId, username FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part)) out.set(r.userId, r.username);
  }
  return out;
}
async function mineFor(userId, ids) {
  const out = new Map();
  if (!userId || !ids.length) return out;
  const rows = await getQuery(`SELECT raffle_id, SUM(qty) AS n FROM raffle_tickets WHERE user_id = ? AND state != 'refunded' AND raffle_id IN (${ids.map(() => "?").join(",")})
                               GROUP BY raffle_id`, [userId, ...ids]);
  for (const r of rows) out.set(r.raffle_id, Number(r.n) || 0);
  return out;
}

/**
 * The list: house raffles first (featured), then community; open first by when they close. Filters: pad (an id, "" = site-wide,
 * null = all), status "open" | "drawn" (drawn / delivering / disputed / complete) | "closed" (expired / removed / refunded) | "all".
 */
async function list({ viewer = null, pad = null, status = "open", limit = 200 } = {}) {
  await init();
  const where = [], args = [];
  if (status === "open") where.push("status = 'open'");
  else if (status === "drawn") where.push("status IN ('drawn','delivering','disputed','complete')");
  else if (status === "closed") where.push("status IN ('expired','removed','refunded')");
  if (pad !== null && pad !== undefined) {
    if (pad === "") where.push("pad IS NULL"); else { where.push("pad = ?"); args.push(pad); }
  }
  const rows = await getQuery(`SELECT * FROM raffles ${where.length ? "WHERE " + where.join(" AND ") : ""}
                               ORDER BY house DESC, CASE WHEN status = 'open' THEN 0 ELSE 1 END, COALESCE(drawn_at, closed_at, 0) DESC, id DESC LIMIT ?`,
                              [...args, Math.max(1, Math.min(500, limit))]);
  const vis = rows.filter((r) => canSeePad(viewer, r.pad));
  const nm = await names(vis.map((r) => r.creator_id));
  const mine = await mineFor(viewer && viewer.userId, vis.map((r) => r.id));
  const out = vis.map((r) => shape(r, { viewer: viewer && viewer.userId, mine: mine.get(r.id) || null, creatorName: nm.get(r.creator_id) }));
  const openSort = (a, b) => (a.next_at || 9e15) - (b.next_at || 9e15);
  if (status === "open") {
    return { house: out.filter((r) => r.house).sort(openSort), community: out.filter((r) => !r.house).sort(openSort) };
  }
  return { house: out.filter((r) => r.house), community: out.filter((r) => !r.house) };
}
/** Counts per pad (the filter) over open raffles + every raffle's pad. */
async function padCounts(viewer) {
  await init();
  const rows = await getQuery("SELECT pad, COUNT(*) AS n FROM raffles WHERE status = 'open' GROUP BY pad");
  const out = [];
  for (const r of rows) {
    if (!canSeePad(viewer, r.pad)) continue;
    const pv = padView(r.pad);
    out.push({ slug: pv ? pv.slug : "none", title: pv ? pv.title : null, n: Number(r.n) || 0 });
  }
  return out.sort((a, b) => (a.slug === "none") - (b.slug === "none") || String(a.title).localeCompare(String(b.title)));
}
/** One raffle's page data. -> null when missing or on a pad the viewer can't see. */
async function detail(id, viewer = null) {
  await init();
  const r = await raffleRow(id);
  if (!r || !canSeePad(viewer, r.pad)) return null;
  const nm = await names([r.creator_id]);
  const uid = viewer && viewer.userId;
  const mine = await mineFor(uid, [r.id]);
  const v = shape(r, { viewer: uid, mine: mine.get(r.id) || null, creatorName: nm.get(r.creator_id) });
  const purchases = await getQuery("SELECT first_no, last_no, username, qty, state, created, user_id FROM raffle_tickets WHERE raffle_id = ? ORDER BY first_no", [r.id]);
  const per = new Map();
  for (const p of purchases) {
    if (p.state === "refunded") continue;
    const k = p.user_id;
    const e = per.get(k) || { name: p.username, qty: 0 };
    e.qty += p.qty;
    per.set(k, e);
  }
  v.entrants = [...per.values()].sort((a, b) => b.qty - a.qty).slice(0, 100);
  v.entrant_count = per.size;
  v.tickets = v.tickets_digest ? purchases.filter((p) => p.state !== "refunded").map((p) => ({ first_no: p.first_no, last_no: p.last_no, username: p.username })) : null;
  v.isCreator = !!uid && uid === r.creator_id;
  v.isWinner = !!uid && uid === r.winner_id;
  if (uid) {
    v.myTickets = purchases.filter((p) => p.user_id === uid && p.state !== "refunded").map((p) => [p.first_no, p.last_no]);
  }
  return v;
}

// ── create ──
function cleanImage(raw, house) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let local = null;
  try { local = require("./shop").localImagePath(s); } catch (e) { local = null; }
  if (local) return local;
  if (!house) throw new Refuse(400, "Community raffles use a site picture (a /public/... path) or the prize's own picture - leave it empty for that.", "E_IMAGE");
  let u = null;
  try { u = new URL(s); } catch (e) { u = null; }
  if (!u || u.protocol !== "https:" || s.length > 500 || /["'<>\s\\]/.test(s)) throw new Refuse(400, "The picture must be an https:// link or a site picture path.", "E_IMAGE");
  return u.href;
}
function guardText(label, s) {
  // (not textguard.hasPadCode: that guards room TOPICS, and it reads "PATV Friday..." as a pad code)
  if (require("./textguard").bad(s)) throw new Refuse(400, `The ${label} has something Pepe can't repeat - reword it.`, "E_TEXT");
}
/** A date / time input: ms, a unix-seconds number, or an ISO / datetime-local string (+ tz offset minutes from the form). */
function parseWhen(v, tzOffsetMin) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d{9,13}$/.test(String(v))) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
  const s = String(v).trim();
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);
  const t = Date.parse(local ? s + "Z" : s);
  if (!Number.isFinite(t)) return NaN;
  return local ? t + (Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) * MIN : 0) : t;
}
/** Validate a create form / API body. -> the clean fields (no money moved). */
async function validate(user, b) {
  const C = CONFIG;
  const house = !!(b.house && b.house !== "0" && b.house !== "false") && SP.can(user, "raffles.house");   // 1.99ack: the House pays its PAT prize (locked)
  const title = str(b.title, 90);
  if (title.length < 3) throw new Refuse(400, "Give it a title (3-90 characters).", "E_TITLE");
  const description = String(b.description || "").replace(/\r/g, "").trim().slice(0, 1500);
  guardText("title", title);
  guardText("description", description);
  const kind = ["pat", "item", "custom"].includes(String(b.prize_kind)) ? String(b.prize_kind) : null;
  if (!kind) throw new Refuse(400, "Pick a prize: PAT, a Prize Shop item or a custom prize.", "E_PRIZE");
  const out = { house, title, description, prize_kind: kind, prize_amount: 0, prize_item: null, prize_name: null, prize_cost: 0, prize_text: null };
  if (kind === "pat") {
    // review of the owner answers 2026-10-20 (1): a House raffle's PAT prize is paid out of the House to the winner (up to
    // prize_max) - like the House adjust, a Pepe OWNER's (the class + the owner role on the linked chat login, read fresh).
    // An item or a custom House prize moves no House PAT and stays an Admin's.
    if (house) {
      const SR = require("./staffroles");
      if (!(await SR.ownerOf(user, "raffles.house"))) throw new Refuse(403, "A House raffle with a PAT prize: " + SR.OWNER_ONLY, "owner_only");
    }
    const a = pat(b.prize_amount);
    if (!(a >= C.prize_min && a <= C.prize_max)) throw new Refuse(400, `The PAT prize must be ${fmt(C.prize_min)}-${fmt(C.prize_max)} PAT.`, "E_PRIZE");
    out.prize_amount = a;
    out.prize_name = `${fmt(a)} PAT`;
  } else if (kind === "item") {
    const items = await eligibleItems();
    const it = items.find((x) => x.prizeId === String(b.prize_item || ""));
    if (!it) throw new Refuse(400, "Pick one of the Prize Shop items that can be raffled (in stock, delivered by PATV).", "E_ITEM");
    out.prize_item = it.prizeId;
    out.prize_name = str(it.prize, 120);
    out.prize_cost = Number(it.cost) || 0;
    out.item_image = it.image_url || null;                     // the card's picture when none is given
  } else {
    if (!house && !C.custom_allowed) throw new Refuse(400, "Custom prizes are switched off right now.", "E_PRIZE");
    const text = str(b.prize_text, 200);
    if (text.length < 3) throw new Refuse(400, "Describe the prize (3-200 characters).", "E_PRIZE");
    guardText("prize", text);
    out.prize_text = text;
    out.prize_name = text;
  }
  const price = pat(b.price);
  if (!(price >= C.price_min && price <= C.price_max)) throw new Refuse(400, `A ticket costs ${fmt(C.price_min)}-${fmt(C.price_max)} PAT.`, "E_PRICE");
  out.price = price;
  const minT = b.min_tickets === undefined || b.min_tickets === "" ? 1 : int(b.min_tickets);
  if (!(minT >= 1 && minT <= MAX_TICKETS(price))) throw new Refuse(400, "The minimum is 1 ticket or more.", "E_MIN");
  out.min_tickets = minT;
  const maxPer = b.max_per_user === undefined || b.max_per_user === "" ? 0 : int(b.max_per_user);
  if (!(maxPer >= 0 && maxPer <= MAX_TICKETS(price))) throw new Refuse(400, "Max tickets per person: leave it empty for no limit, or 1 and up.", "E_MAXPER");
  out.max_per_user = maxPer;
  const t = now();
  const trig = String(b.trigger) === "target" ? "target" : String(b.trigger) === "date" ? "date" : null;
  if (!trig) throw new Refuse(400, "Pick when it draws: on a date, or when a number of tickets is sold.", "E_TRIGGER");
  out.trigger_kind = trig;
  const tz = b.tz;
  let exp = parseWhen(b.expires_at, tz);
  if (trig === "date") {
    const at = parseWhen(b.draw_at, tz);
    if (!Number.isFinite(at) || at < t + C.min_lead_min * MIN || at > t + C.max_days * DAY) {
      throw new Refuse(400, `The draw date must be at least ${C.min_lead_min} minutes and at most ${C.max_days} days away.`, "E_DRAW_AT");
    }
    out.draw_at = at;
    const maxT = b.max_tickets === undefined || b.max_tickets === "" ? 0 : int(b.max_tickets);
    if (!(maxT === 0 || (maxT >= minT && maxT <= MAX_TICKETS(price)))) throw new Refuse(400, "The ticket cap must be at least the minimum (or empty for no cap).", "E_MAX");
    out.max_tickets = maxT;
    out.target = 0;
    if (exp === null) exp = Math.max(at + C.grace_hours * HOUR, Math.min(at + 3 * DAY, t + C.max_days * DAY));
    if (!Number.isFinite(exp) || exp < at + C.grace_hours * HOUR || exp > t + C.max_days * DAY) {
      throw new Refuse(400, `The expiry must be at least ${C.grace_hours} hour(s) after the draw date and at most ${C.max_days} days away.`, "E_EXPIRY");
    }
  } else {
    const target = int(b.target);
    if (!(target >= Math.max(1, minT) && target <= MAX_TICKETS(price))) throw new Refuse(400, `The target must be at least ${fmt(Math.max(1, minT))} tickets (the minimum).`, "E_TARGET");
    out.target = target;
    out.max_tickets = target;
    out.draw_at = null;
    if (exp === null) exp = t + 7 * DAY;
    if (!Number.isFinite(exp) || exp < t + HOUR || exp > t + C.max_days * DAY) throw new Refuse(400, `The expiry must be 1 hour to ${C.max_days} days away.`, "E_EXPIRY");
  }
  if (maxPer && out.max_tickets && maxPer > out.max_tickets) out.max_per_user = out.max_tickets;
  out.expires_at = exp;
  out.image_url = cleanImage(b.image_url, house) || out.item_image || null;
  delete out.item_image;
  return out;
}
/** Where a create lands: a pad the user may use, else Pepe's Pad for a house raffle, else site-wide. */
async function padFor(user, raw, house) {
  const padlinks = require("./padlinks");
  const p = await padlinks.checkPick(user, raw);
  if (p === null) throw new Refuse(403, "You can't post a raffle on that pad.", "E_PAD");
  if (p) return p;
  if (house) {
    try {
      const R = require("./rooms");
      await R.init();
      if (R.getCached(R.HOUSE_ROOM)) return R.HOUSE_ROOM;
    } catch (e) { /* no registry */ }
  }
  return null;
}
async function event(kind, raffleId, data) {
  const ins = await runQuery("INSERT INTO raffle_events (ts, raffle_id, kind, data) VALUES (?, ?, ?, ?)", [now(), raffleId || null, kind, JSON.stringify(data || {})]);
  return ins && ins.id;
}
const waiters = new Set();
function wake() { for (const w of [...waiters]) w(); }

/** The rooms Pepe announces a raffle in: its pad's Camfrog room + Pepe's Pad; "*" = every room he's in (house raffles). */
function roomsFor(r) {
  if (r.house) return ["*"];
  const out = [];
  try {
    const R = require("./rooms");
    const p = r.pad ? R.getCached(r.pad) : null;
    if (p && p.platform === "camfrog") out.push(p.id);
    if (R.HOUSE_ROOM && !out.includes(R.HOUSE_ROOM)) out.push(R.HOUSE_ROOM);
  } catch (e) { /* no registry */ }
  return out;
}
function brief(r, creatorName) {
  return { id: r.id, title: r.title, house: !!r.house, prize: r.prize_name, prize_kind: r.prize_kind, price: r.price, sold: r.sold, target: r.target,
           min_tickets: r.min_tickets, trigger: r.trigger_kind, draw_at: r.draw_at, expires_at: r.expires_at, creator: r.house ? null : creatorName || null,
           url: "/raffles/" + r.id, rooms: roomsFor(r) };
}

/**
 * Create a raffle. ONE transaction: the prize hold (PAT / the item's price) or the item reservation + the raffle row + its
 * created event. Idempotent by `idem` (the form's / Pepe's key). -> {ok, id, dup?}
 */
async function create(userId, input = {}) {
  await needOn();
  const user = await userRow(userId);
  if (!user) throw new Refuse(401, "Sign in first.", "E_AUTH");
  if (!(await isVerified(user))) throw new Refuse(403, "Only verified accounts can run a raffle - " + require("./verified").LINK_HINT + ".", "E_VERIFY");
  const idem = String(input.idem || "");
  if (!IDEM_RE.test(idem)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  const key = `rfc:${user.userId}:${idem}`;
  const prev = (await getQuery("SELECT id FROM raffles WHERE key = ?", [key]))[0];
  if (prev) return { ok: true, dup: true, id: prev.id };
  await needEscrow();
  const v = await validate(user, input);
  const C = CONFIG;
  if (!v.house) {
    const live = Number((await getQuery(`SELECT COUNT(*) AS n FROM raffles WHERE creator_id = ? AND house = 0 AND status IN (${LIVE.map(() => "?").join(",")})`,
                                        [user.userId, ...LIVE]))[0].n) || 0;
    if (C.open_max && live >= C.open_max) throw new Refuse(429, `You already have ${live} raffle(s) running - the limit is ${C.open_max}.`, "E_OPEN_MAX");
    const day = Number((await getQuery("SELECT COUNT(*) AS n FROM raffles WHERE creator_id = ? AND house = 0 AND created > ?", [user.userId, now() - DAY]))[0].n) || 0;
    if (day >= C.per_day) throw new Refuse(429, `That's ${C.per_day} raffles in 24 hours - try again later.`, "E_RATE");
  }
  const pad = await padFor(user, input.pad, v.house);
  const seed = newSeed();
  const res = await tx(async () => {
    const t = now();
    const ins = await runQuery(`INSERT INTO raffles (key, creator_id, house, pad, title, description, image_url, prize_kind, prize_amount, prize_item, prize_name,
        prize_cost, prize_text, price, price0, max_per_user, min_tickets, max_tickets, trigger_kind, draw_at, target, expires_at, fee_pct, status, server_seed, commitment,
        created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [key, user.userId, v.house ? 1 : 0, pad, v.title, v.description || null, v.image_url, v.prize_kind, v.prize_amount, v.prize_item, v.prize_name,
       v.prize_cost, v.prize_text, v.price, v.price, v.max_per_user, v.min_tickets, v.max_tickets, v.trigger_kind, v.draw_at, v.target, v.expires_at,
       v.house ? 0 : C.fee_pct, seed, commitmentOf(seed), t, t]);
    const id = ins.id;
    if (v.prize_kind === "item") {
      await require("./shop").raffleReserveInTx(v.prize_item);
    }
    let hold = null;
    const esc = ESC();
    if (!v.house && v.prize_kind === "pat") {
      const account = await esc.accountFor({ userId: user.userId });
      hold = await esc.holdInTx({ key: `rfp:${id}`, hid: null, account, amount: v.prize_amount, ref: `${KIND_PRIZE}-${id}`, reason: "raffle prize", cp: "raffle R" + id, via: "site" });
    } else if (!v.house && v.prize_kind === "item" && v.prize_cost > 0) {
      const account = await esc.accountFor({ userId: user.userId });
      hold = await esc.holdInTx({ key: `rfi:${id}`, hid: null, account, amount: v.prize_cost, ref: `${KIND_ITEM}-${id}`, reason: "raffle prize item", cp: "raffle R" + id, via: "site" });
    }
    if (hold) await runQuery("UPDATE raffles SET prize_hold = ? WHERE id = ?", [hold.hid, id]);
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [id]))[0];
    await event("created", id, brief(r, user.username));
    return { id };
  }).catch((e) => {
    if (e && e.code === "E_INSUFFICIENT_PAT") throw new Refuse(402, v.prize_kind === "item"
      ? `Putting up ${v.prize_name} costs its shop price, ${fmt(v.prize_cost)} PAT - you don't have that.`
      : `Putting up ${fmt(v.prize_amount)} PAT takes that much from your balance - you don't have it.`, "E_INSUFFICIENT_PAT");
    if (e && /SQLITE_CONSTRAINT.*raffles\.key/.test(String(e.message))) return null;
    throw e;
  });
  if (!res) {
    const again = (await getQuery("SELECT id FROM raffles WHERE key = ?", [key]))[0];
    return { ok: true, dup: true, id: again && again.id };
  }
  wake();
  try { require("./achievements").poke(user.userId); } catch (e) { /* never blocks */ }
  return { ok: true, id: res.id, balance: await balanceOf(user.userId) };
}

// ── buy ──
/**
 * Buy `qty` tickets. ONE transaction: the escrow hold + the ticket row (numbers sold+1 .. sold+qty) + the raffle's counters.
 * Idempotent by `idem`. A target raffle draws right after the purchase that reaches its target. -> {ok, from, to, qty, ...}
 */
async function buy(userId, { id, qty, idem, expect, via = "web" } = {}) {
  await needOn();
  const user = await userRow(userId);
  if (!user) throw new Refuse(401, "Sign in first.", "E_AUTH");
  const s = String(idem || "");
  if (!IDEM_RE.test(s)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  const r0 = await raffleRow(id);
  if (!r0) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  const key = `rft:${r0.id}:${user.userId}:${s}`;
  const prev = (await getQuery("SELECT * FROM raffle_tickets WHERE key = ?", [key]))[0];
  if (prev) return { ok: true, dup: true, raffle: r0.id, from: prev.first_no, to: prev.last_no, qty: prev.qty, amount: prev.amount, balance: await balanceOf(user.userId) };
  const n = int(qty === undefined || qty === "" ? 1 : qty);
  const C = CONFIG;
  if (!(n >= 1 && n <= C.buy_max)) throw new Refuse(400, `Buy 1-${fmt(C.buy_max)} tickets at a time.`, "E_QTY");
  if (!canSeePad({ userId: user.userId, username: user.username }, r0.pad)) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  if (expect !== undefined && expect !== null && expect !== "" && int(expect) !== r0.price) {
    throw new Refuse(409, `A ticket costs ${fmt(r0.price)} PAT - check it and try again.`, "E_PRICE_CHANGED");
  }
  if (await linked(r0.creator_id, user.userId)) throw new Refuse(403, r0.creator_id === user.userId ? "You can't buy tickets in your own raffle." : "That raffle was made by an account linked to yours - you can't buy tickets in it.", "E_SELF");
  await needEscrow();
  const out = await tx(async () => {
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r0.id]))[0];
    if (r.status !== "open") throw new Refuse(409, `That raffle is ${r.status}.`, "E_CLOSED");
    // 1.99afy: an admin can change the price before the first ticket (edit) - the price the buyer saw is checked again here
    if (expect !== undefined && expect !== null && expect !== "" && int(expect) !== r.price) {
      throw new Refuse(409, `A ticket costs ${fmt(r.price)} PAT - check it and try again.`, "E_PRICE_CHANGED");
    }
    const t = now();
    if (t >= r.expires_at) throw new Refuse(409, "That raffle has expired.", "E_CLOSED");
    const cap = r.max_tickets || 0;
    if (cap && r.sold + n > cap) throw new Refuse(409, r.sold >= cap ? "It's sold out." : `Only ${fmt(cap - r.sold)} ticket(s) left.`, "E_SOLD_OUT");
    const have = Number((await getQuery("SELECT COALESCE(SUM(qty),0) AS n FROM raffle_tickets WHERE raffle_id = ? AND user_id = ? AND state != 'refunded'",
                                        [r.id, user.userId]))[0].n) || 0;
    if (r.max_per_user && have + n > r.max_per_user) {
      throw new Refuse(409, have >= r.max_per_user ? `You have the most tickets one person can hold (${r.max_per_user}).` : `You can buy ${r.max_per_user - have} more.`, "E_MAX_PER");
    }
    const amount = r.price * n;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(r.pot + amount)) throw new Refuse(400, "Too many.", "E_QTY");
    const esc = ESC();
    const account = await esc.accountFor({ userId: user.userId });
    const h = await esc.holdInTx({ key: `rfb:${r.id}:${user.userId}:${s}`, hid: null, account, amount, ref: `${KIND_TICKET}-${r.id}`,
                                   reason: `raffle tickets R${r.id}`, cp: r.house ? "House raffle" : "raffle R" + r.id, via: "site" });
    const first = r.sold + 1, last = r.sold + n;
    await runQuery(`INSERT INTO raffle_tickets (raffle_id, user_id, username, qty, first_no, last_no, amount, hold_id, key, state, via, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`, [r.id, user.userId, user.username, n, first, last, amount, h.hid, key, str(via, 20), t]);
    const newBuyer = have === 0 ? 1 : 0;
    const u = await runQuery("UPDATE raffles SET sold = sold + ?, pot = pot + ?, buyers = buyers + ?, purchases = purchases + 1, updated = ? WHERE id = ? AND status = 'open' AND sold = ?",
                             [n, amount, newBuyer, t, r.id, r.sold]);
    if (!u.changes) throw new Refuse(409, "That raffle changed while you were buying - nothing was charged. Try again.", "E_RACE");
    // milestones (25 / 50 / 75 / 100% of the target - or of the minimum on a date raffle)
    const goal = r.trigger_kind === "target" ? r.target : r.min_tickets;
    let ms = null;
    if (C.announce_milestones && goal >= 4) {
      for (const [bit, pct] of [[1, 25], [2, 50], [4, 75], [8, 100]]) {
        if (!(r.milestones & bit) && last * 100 >= goal * pct && r.sold * 100 < goal * pct) ms = { bit, pct };
      }
      if (ms) {
        const bits = [1, 2, 4, 8].filter((b) => b <= ms.bit).reduce((a, b) => a | b, r.milestones);
        await runQuery("UPDATE raffles SET milestones = ? WHERE id = ?", [bits, r.id]);
        const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
        await event("milestone", r.id, Object.assign(brief(r2), { pct: ms.pct, goal, of: r.trigger_kind === "target" ? "target" : "minimum",
                                                                    rooms: r.house ? ["*"] : roomsFor(r).slice(0, 1) }));
      }
    }
    return { raffle: r.id, from: first, to: last, qty: n, amount, sold: last, target: r.target, trigger: r.trigger_kind };
  }).catch((e) => {
    if (e && e.code === "E_INSUFFICIENT_PAT") throw new Refuse(402, "You don't have enough PAT for that.", "E_INSUFFICIENT_PAT");
    if (e && /SQLITE_CONSTRAINT/.test(String(e.message)) && /raffle_tickets\.key|escrow_holds\.key/.test(String(e.message))) return null;
    throw e;
  });
  if (!out) return buy(userId, { id, qty, idem, expect, via });     // a concurrent retry with the same key: answer its result
  wake();
  let drew = null;
  if (out.trigger === "target" && out.sold >= out.target) drew = await draw(out.raffle).catch((e) => { console.error("[raffles] draw after buy:", e.message); return null; });
  else if (out.trigger === "date") drew = await maybeDraw(out.raffle).catch(() => null);
  return Object.assign({ ok: true, balance: await balanceOf(user.userId) }, out, drew && drew.drawn ? { drawn: true } : {});
}

// ── the draw ──
// settleInTx spends at most 2,000 holds per call (escrow/ledger.js); a raffle with more purchases is settled in several keyed
// calls inside the draw's ONE transaction - the fee legs fill the first chunks, the creator's payout (or the House) the rest.
let SETTLE_CHUNK = 2000;
/** In the open transaction: spend every ticket hold of `r` -> `payee` (a userId; null = the whole pot to the House) minus `legs`. */
async function settlePotInTx(r, tickets, { payee, legs, how }) {
  const esc = ESC();
  const chunks = [];
  for (let i = 0; i < tickets.length; i += SETTLE_CHUNK) chunks.push(tickets.slice(i, i + SETTLE_CHUNK));
  const queue = (legs || []).map(([d, a]) => [d, a]);
  for (let c = 0; c < chunks.length; c++) {
    const part = chunks[c];
    const total = part.reduce((a, x) => a + x.amount, 0);
    let room = total;
    const fees = [];
    if (!payee) fees.push(["jackpot", total]), room = 0;
    while (room > 0 && queue.length) {
      const take = Math.min(room, queue[0][1]);
      fees.push([queue[0][0], take]);
      room -= take;
      queue[0][1] -= take;
      if (queue[0][1] <= 0) queue.shift();
    }
    const key = c === 0 ? `rfd:${r.id}:pot` : `rfd:${r.id}:pot:${c}`;
    await esc.settleInTx({ key, hids: part.map((x) => x.hold_id), ref: `${KIND_TICKET}-${r.id}`, max: 2000, fees,
                           payouts: payee && room > 0 ? [{ userId: payee, amount: room, reason: "raffle ticket sales", cp: "raffle R" + r.id }] : [] });
    await esc.record(key, { op: "settle", ref: `${KIND_TICKET}-${r.id}`, amount: total, via: "raffles", result: { ok: true, payout: payee ? room : 0, fees, how: how || null } });
  }
  if (queue.some(([, a]) => a > 0)) throw new Error(`raffle R${r.id}: fee legs exceed the pot`);
  await runQuery("UPDATE raffle_tickets SET state = 'spent' WHERE raffle_id = ? AND state = 'held'", [r.id]);
}
async function maybeDraw(id) {
  const r = await raffleRow(id);
  if (!r || r.status !== "open") return null;
  const t = now();
  if (t >= r.expires_at) return expire(r.id, "expired");
  if (r.trigger_kind === "target" && r.sold >= r.target) return draw(r.id);
  if (r.trigger_kind === "date" && t >= r.draw_at && r.sold >= r.min_tickets) return draw(r.id);
  return null;
}
/**
 * Draw a raffle. ONE transaction: the winner by the committed seed, every ticket hold settled (the pot to the creator minus the
 * fee, or to the House), the prize to the winner (or the custom-prize pot held for delivery), the row + event.
 * Re-runnable: a raffle that isn't open answers {drawn: false}.
 */
async function draw(id) {
  await init();
  const res = await tx(async () => {
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [Number(id)]))[0];
    if (!r || r.status !== "open") return { drawn: false };
    if (r.sold < Math.max(1, r.min_tickets)) return { drawn: false };
    const tickets = await getQuery("SELECT * FROM raffle_tickets WHERE raffle_id = ? AND state = 'held' ORDER BY first_no", [r.id]);
    const n = tickets.reduce((a, x) => a + x.qty, 0);
    if (n !== r.sold) throw new Error(`raffle R${r.id}: ${n} held tickets vs sold ${r.sold}`);
    const digest = ticketsDigest(tickets);
    const no = winningNumber(r.server_seed, digest, r.id, n);
    const win = tickets.find((x) => no >= x.first_no && no <= x.last_no);
    const winner = await userRow(win.user_id) || { userId: win.user_id, username: win.username };
    const t = now();
    const esc = ESC();
    const hids = tickets.map((x) => x.hold_id);
    const custom = r.prize_kind === "custom";
    let fee = 0, payout = 0, legs = [];
    let status = "drawn", releaseAt = null, orderId = null;
    const creator = await userRow(r.creator_id);
    // the ticket pot
    if (r.house) {
      await settlePotInTx(r, tickets, { payee: null, legs: [], how: "house" });
      legs = [["jackpot", r.pot]];
    } else if (custom) {
      status = "delivering";                                    // the pot waits in escrow for the winner's confirmation
      releaseAt = t + CONFIG.custom_hold_days * DAY;
      fee = Math.floor(r.pot * r.fee_pct / 100);
      payout = r.pot - fee;
    } else {
      fee = Math.floor(r.pot * r.fee_pct / 100);
      payout = r.pot - fee;
      legs = await feeLegs(fee);
      await settlePotInTx(r, tickets, { payee: r.creator_id, legs, how: "draw" });
    }
    // the prize
    if (r.prize_kind === "pat") {
      if (r.house) {
        await esc.grantInTx({ key: `rfw:${r.id}`, pool: "jackpot", ref: `${KIND_PRIZE}-${r.id}`,
                              payouts: [{ userId: winner.userId, amount: r.prize_amount, reason: "raffle prize", cp: "House raffle R" + r.id }] });
      } else {
        await esc.settleInTx({ key: `rfw:${r.id}`, hids: [r.prize_hold], ref: `${KIND_PRIZE}-${r.id}`, fees: [],
                               payouts: [{ userId: winner.userId, amount: r.prize_amount, reason: "raffle prize", cp: "raffle R" + r.id }] });
      }
      await esc.record(`rfw:${r.id}`, { op: r.house ? "grant" : "settle", ref: `${KIND_PRIZE}-${r.id}`, amount: r.prize_amount, via: "raffles", result: { ok: true, winner: winner.userId } });
    } else if (r.prize_kind === "item") {
      if (!r.house && r.prize_hold) {
        // the creator's item price goes to the store owner, as a shop sale would
        const S = require("./shop");
        const owner = (await getQuery("SELECT userId FROM users WHERE username = ?", [S.STORE_OWNER_USERNAME]))[0];
        await esc.settleInTx({ key: `rfw:${r.id}`, hids: [r.prize_hold], ref: `${KIND_ITEM}-${r.id}`, fees: owner ? [] : [["jackpot", r.prize_cost]],
                               payouts: owner ? [{ userId: owner.userId, amount: r.prize_cost, reason: "store sale (raffle prize)", cp: "raffle R" + r.id }] : [] });
      }
      orderId = await require("./shop").raffleOrderInTx({ prizeId: r.prize_item, title: r.prize_name, winnerId: winner.userId, winnerName: winner.username,
                                                         payerId: r.house ? null : r.creator_id, payerName: r.house ? null : (creator && creator.username),
                                                         price: r.house ? 0 : r.prize_cost, raffleId: r.id });
    }
    const u = await runQuery(`UPDATE raffles SET status = ?, tickets_digest = ?, winning_no = ?, winner_id = ?, winner_name = ?, fee = ?, creator_payout = ?,
                              fee_legs = ?, order_id = ?, release_at = ?, drawn_at = ?, updated = ? WHERE id = ? AND status = 'open'`,
                             [status, digest, no, winner.userId, winner.username, r.house ? 0 : fee, r.house ? 0 : payout, JSON.stringify(legs), orderId, releaseAt, t, t, r.id]);
    if (!u.changes) throw new Refuse(409, "changed under us", "E_RACE");
    const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
    await event("drawn", r.id, Object.assign(brief(r2, creator && creator.username), { winner: winner.username, winner_login: winner.camfrogUsername || null,
                                                                                        winning_no: no, entrants: new Set(tickets.map((x) => x.user_id)).size }));
    return { drawn: true, r: r2, winner, creator, orderId, tickets };
  });
  if (!res.drawn) return res;
  wake();
  const r = res.r;
  // after the commit: notices, the shop's sale hooks (a Plex invite), achievements - never fail the draw
  try {
    const inbox = require("./inbox");
    const what = r.prize_kind === "pat" ? `${fmt(r.prize_amount)} PAT (already in your balance)` : r.prize_kind === "item" ? `${r.prize_name} (it's on your shop orders page)` : `"${r.prize_text}" - the raffle's creator delivers it; confirm on the raffle page once you have it`;
    await inbox.addSafe(res.winner.userId, { kind: "raffle", title: `🎫 You won raffle R${r.id}: ${r.title}`, body: `Ticket #${r.winning_no} won ${what}.`,
                                             link: `/raffles/${r.id}`, ref: `raffle-win:${r.id}` });
    if (!r.house && res.creator) {
      await inbox.addSafe(res.creator.userId, { kind: "raffle", title: `🎫 Raffle R${r.id} was drawn: ${r.title}`,
        body: r.prize_kind === "custom" ? `${res.winner.username} won. Deliver the prize: your ${fmt(r.creator_payout)} PAT (the pot minus the ${r.fee_pct}% fee) is released when they confirm it, or after ${CONFIG.custom_hold_days} days without a dispute.`
                                         : `${res.winner.username} won. ${fmt(r.creator_payout)} PAT (the pot minus the ${r.fee_pct}% fee) is in your balance.`,
        link: `/raffles/${r.id}`, ref: `raffle-drawn:${r.id}` });
    }
  } catch (e) { console.error("[raffles] notices:", e.message); }
  if (res.orderId) { try { require("./shop").raffleOrderAfter({ orderId: res.orderId, prizeId: r.prize_item, title: r.prize_name, userId: res.winner.userId, username: res.winner.username, price: r.house ? 0 : r.prize_cost, raffleId: r.id }); } catch (e) { console.error("[raffles] order hooks:", e.message); } }
  try { require("./achievements").poke(res.winner.userId, r.creator_id); } catch (e) { /* never blocks */ }
  return { drawn: true, id: r.id, winner: res.winner.username, winning_no: r.winning_no, status: r.status };
}

// ── refunds: expiry, takedown, a refunded dispute, a creator's cancel ──
/** In the open transaction: every held ticket back to its buyer, the prize hold back to the creator, a reserved item back in stock. */
async function refundAllInTx(r, why) {
  const esc = ESC();
  const tickets = await getQuery("SELECT * FROM raffle_tickets WHERE raffle_id = ? AND state = 'held' ORDER BY id", [r.id]);
  let back = 0;
  for (const x of tickets) {
    await esc.refundInTx({ key: `rfr:${x.id}`, hid: x.hold_id, reason: `raffle refund R${r.id}` });
    await esc.record(`rfr:${x.id}`, { op: "refund", ref: `${KIND_TICKET}-${r.id}`, amount: x.amount, via: "raffles", result: { ok: true, why } });
    await runQuery("UPDATE raffle_tickets SET state = 'refunded' WHERE id = ? AND state = 'held'", [x.id]);
    back += x.amount;
  }
  if (r.prize_hold && ["open"].includes(r.status)) {
    const h = (await getQuery("SELECT state FROM escrow_holds WHERE id = ?", [r.prize_hold]))[0];
    if (h && h.state === "held") {
      await esc.refundInTx({ key: `rfr:${r.id}:prize`, hid: r.prize_hold, reason: `raffle prize back R${r.id}` });
      await esc.record(`rfr:${r.id}:prize`, { op: "refund", ref: `${r.prize_kind === "item" ? KIND_ITEM : KIND_PRIZE}-${r.id}`, amount: r.prize_kind === "item" ? r.prize_cost : r.prize_amount, via: "raffles", result: { ok: true, why } });
    }
  }
  if (r.prize_kind === "item" && r.status === "open") await require("./shop").raffleReleaseInTx(r.prize_item);
  return { tickets: tickets.length, refunded: back, buyers: [...new Set(tickets.map((x) => x.user_id))] };
}
/** Close an open raffle with full refunds: "expired" (the timer), "removed" (an admin), "cancelled" (the creator, nothing sold). */
async function expire(id, why = "expired", { actor = null, reason = null } = {}) {
  await init();
  const res = await tx(async () => {
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [Number(id)]))[0];
    if (!r || r.status !== "open") return { closed: false };
    const out = await refundAllInTx(r, why);
    const st = why === "expired" ? "expired" : "removed";
    const t = now();
    const u = await runQuery("UPDATE raffles SET status = ?, closed_at = ?, closed_by = ?, close_reason = ?, updated = ? WHERE id = ? AND status = 'open'",
                             [st, t, actor, reason ? str(reason, 200) : (why === "cancelled" ? "cancelled by its creator" : null), t, r.id]);
    if (!u.changes) throw new Refuse(409, "changed under us", "E_RACE");
    const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
    await event(why === "expired" ? "expired" : why === "cancelled" ? "cancelled" : "removed", r.id, Object.assign(brief(r2), { refunded: out.refunded, tickets: out.tickets, why }));
    return Object.assign({ closed: true, r: r2 }, out);
  });
  if (!res.closed) return res;
  wake();
  try {
    const inbox = require("./inbox");
    const r = res.r;
    const title = why === "expired" ? `🎫 Raffle R${r.id} didn't draw - your tickets are refunded` : `🎫 Raffle R${r.id} was taken down - your tickets are refunded`;
    for (const b of res.buyers) {
      await inbox.addSafe(b, { kind: "raffle", title, body: `${r.title}: every ticket you bought is back in your balance, in full.`, link: `/raffles/${r.id}`, ref: `raffle-refund:${r.id}` });
    }
    if (!r.house && why !== "cancelled") {
      await inbox.addSafe(r.creator_id, { kind: "raffle", title: why === "expired" ? `🎫 Your raffle R${r.id} expired` : `🎫 Your raffle R${r.id} was taken down`,
        body: `${r.title}: ${why === "expired" ? `it didn't reach ${r.min_tickets} ticket(s) in time` : `an admin removed it${r.close_reason ? ` (${r.close_reason})` : ""}`}. The tickets were refunded${r.prize_kind === "custom" ? "" : " and your prize is back"}.`,
        link: `/raffles/${r.id}`, ref: `raffle-closed:${r.id}` });
    }
  } catch (e) { console.error("[raffles] refund notices:", e.message); }
  return { closed: true, id: res.r.id, status: res.r.status, refunded: res.refunded, tickets: res.tickets };
}

// ── custom prizes: confirm / dispute / release / admin decision ──
/** In the open transaction: release a custom raffle's pot to the creator minus the fee. */
async function releaseInTx(r, how) {
  const esc = ESC();
  const tickets = await getQuery("SELECT * FROM raffle_tickets WHERE raffle_id = ? AND state = 'held' ORDER BY first_no", [r.id]);
  const pot = tickets.reduce((a, x) => a + x.amount, 0);
  const fee = Math.floor(pot * r.fee_pct / 100);
  const payout = pot - fee;
  const legs = await feeLegs(fee);
  if (tickets.length) await settlePotInTx(r, tickets, { payee: r.creator_id, legs, how });
  const t = now();
  const u = await runQuery("UPDATE raffles SET status = 'complete', fee = ?, creator_payout = ?, fee_legs = ?, closed_at = ?, close_reason = ?, updated = ? WHERE id = ? AND status IN ('delivering','disputed')",
                           [fee, payout, JSON.stringify(legs), t, how, t, r.id]);
  if (!u.changes) throw new Refuse(409, "changed under us", "E_RACE");
  const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
  await event("released", r.id, Object.assign(brief(r2), { how, payout }));
  return { payout, fee, r: r2 };
}
async function confirmDelivery(userId, id) {
  await init();
  const r0 = await raffleRow(id);
  if (!r0) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  if (r0.winner_id !== userId) throw new Refuse(403, "Only the winner can confirm the prize arrived.", "E_NOT_WINNER");
  const res = await tx(async () => {
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r0.id]))[0];
    if (r.status !== "delivering") throw new Refuse(409, r.status === "disputed" ? "It's with the admins now." : `That raffle is ${r.status}.`, "E_STATE");
    return releaseInTx(r, "confirmed by the winner");
  });
  wake();
  require("./inbox").addSafe(res.r.creator_id, { kind: "raffle", title: `🎫 ${res.r.winner_name} confirmed the prize of raffle R${res.r.id}`,
    body: `${fmt(res.payout)} PAT (the pot minus the ${res.r.fee_pct}% fee) is in your balance.`, link: `/raffles/${res.r.id}`, ref: `raffle-released:${res.r.id}` }).catch(() => {});
  try { require("./achievements").poke(res.r.creator_id); } catch (e) { /* never blocks */ }
  return { ok: true, status: "complete", payout: res.payout };
}
async function dispute(userId, id, note) {
  await init();
  const r = await raffleRow(id);
  if (!r) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  if (r.winner_id !== userId) throw new Refuse(403, "Only the winner can report a problem with the prize.", "E_NOT_WINNER");
  const why = str(note, 300);
  if (why.length < 5) throw new Refuse(400, "Say what went wrong (5-300 characters).", "E_NOTE");
  const t = now();
  const u = await runQuery("UPDATE raffles SET status = 'disputed', dispute_by = ?, dispute_note = ?, dispute_at = ?, updated = ? WHERE id = ? AND status = 'delivering'",
                           [userId, why, t, t, r.id]);
  if (!u.changes) throw new Refuse(409, `That raffle is ${r.status}.`, "E_STATE");
  await event("disputed", r.id, { id: r.id, title: r.title, rooms: [] });
  try {
    const admins = await getQuery("SELECT userId FROM users WHERE class = 'Admin'");
    for (const a of admins) await require("./inbox").addSafe(a.userId, { kind: "admin", title: `🎫 Raffle R${r.id} prize disputed`, body: `${r.winner_name}: ${why}`, link: `/admin/raffles#R${r.id}`, ref: `raffle-dispute:${r.id}` });
  } catch (e) { /* notices never block */ }
  return { ok: true, status: "disputed" };
}
/** Admin: "release" (pay the creator) or "refund" (every ticket back) a disputed / delivering custom raffle. */
async function decide(adminId, id, decision, reason) {
  await init();
  const a = await userRow(adminId);
  if (!rafflesAdmin(a)) throw new Refuse(403, "Admins only.", "E_ADMIN");
  const r0 = await raffleRow(id);
  if (!r0) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  if (!["delivering", "disputed"].includes(r0.status)) throw new Refuse(409, `That raffle is ${r0.status}.`, "E_STATE");
  const why = str(reason, 200) || null;
  let out;
  if (decision === "release") {
    out = await tx(async () => {
      const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r0.id]))[0];
      if (!["delivering", "disputed"].includes(r.status)) throw new Refuse(409, `That raffle is ${r.status}.`, "E_STATE");
      return releaseInTx(r, `released by an admin${why ? ": " + why : ""}`);
    });
    out = { ok: true, status: "complete", payout: out.payout };
  } else if (decision === "refund") {
    out = await tx(async () => {
      const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r0.id]))[0];
      if (!["delivering", "disputed"].includes(r.status)) throw new Refuse(409, `That raffle is ${r.status}.`, "E_STATE");
      const res = await refundAllInTx(r, "dispute refund");
      const t = now();
      await runQuery("UPDATE raffles SET status = 'refunded', closed_at = ?, closed_by = ?, close_reason = ?, updated = ? WHERE id = ?", [t, a.userId, why || "refunded by an admin", t, r.id]);
      const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
      await event("refunded", r.id, Object.assign(brief(r2), { refunded: res.refunded }));
      return Object.assign({ r: r2 }, res);
    });
    for (const b of out.buyers) {
      require("./inbox").addSafe(b, { kind: "raffle", title: `🎫 Raffle R${out.r.id}: your tickets are refunded`, body: `The prize of ${out.r.title} wasn't delivered - every ticket you bought is back in your balance.`,
                                      link: `/raffles/${out.r.id}`, ref: `raffle-refund:${out.r.id}` }).catch(() => {});
    }
    out = { ok: true, status: "refunded", refunded: out.refunded };
  } else throw new Refuse(400, "Release or refund?", "E_DECISION");
  try { await require("./adminaudit").record(a, "raffle_decide", null, { raffle: r0.id, decision }, why || ""); } catch (e) { /* optional */ }
  wake();
  return out;
}
/** Admin takedown of an open raffle (full refunds), or of a custom raffle waiting on delivery (= refund). */
async function takedown(adminId, id, reason) {
  await init();
  const a = await userRow(adminId);
  if (!rafflesAdmin(a)) throw new Refuse(403, "Admins only.", "E_ADMIN");
  const r = await raffleRow(id);
  if (!r) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  const why = str(reason, 200);
  if (why.length < 3) throw new Refuse(400, "Give a reason (it goes in the admin log and to the creator).", "E_REASON");
  let out;
  if (r.status === "open") out = await expire(r.id, "removed", { actor: a.userId, reason: why });
  else if (["delivering", "disputed"].includes(r.status)) out = await decide(adminId, r.id, "refund", why);
  else throw new Refuse(409, `That raffle is ${r.status} - nothing to take down.`, "E_STATE");
  try { await require("./adminaudit").record(a, "raffle_takedown", null, { raffle: r.id }, why); } catch (e) { /* optional */ }
  return Object.assign({ ok: true }, out);
}

// ── 1.99afy: an admin changes an open raffle (the owner 2026-10-29: "allow admins to change the raffle draw date etc.") ──
// Only an OPEN raffle that isn't due this moment (drawing / closing). ONE transaction that re-reads the row (a buy or the draw
// tick before it is seen, never overwritten): the changed fields, the milestones re-based on a new goal, one admin_audit row
// (raffle_edit: before -> after of each changed field), one "edited" event (wakes the long-pollers; Pepe ignores the kind) and
// the notices booked (note_due / note_from). After the commit: the draw at once if the edit made it due (a minimum lowered to
// what's sold after the draw date). A no-op saves, records and tells nothing. The fairness is untouched: the seed was
// committed at creation and the tickets digest is taken at the draw, whenever that is.
//   any time            title, description, draw_at, expires_at, target (more than the tickets sold)
//   timing (from NOW)   draw_at min_lead_min .. max_days away; expires_at at most max_days away and at least grace_hours after
//                       the draw (or after now + min_lead_min, the later) on a date raffle, an hour away on a target raffle
//   lifetime            never later than 2 x max_days after the raffle was made (or its expiry, if that's later already): an
//                       admin can't keep buyers' tickets held for ever by moving the expiry again and again
//   before a ticket     price, the trigger (date <-> target), minimum / cap / max per person within the creation limits; a
//                       House raffle's price with a PAT prize: a Pepe owner's, as its creation is
//   once one is sold    price + trigger LOCKED; the minimum only down; the cap only up (empty = none); max per person only up
//                       and never below the most one buyer holds
//   never               the prize (its escrow / the reserved item were taken when the raffle was made)
// THE NOTICES (flushEditNotices, on the clock): edits close together make ONE notice - sent NOTE_QUIET after the last change
// (at most NOTE_MAX after the first, and before an old or new draw time that comes sooner), listing the change from what the
// holders were last told to what it is then. One per ticket holder when something a buyer sees changed (draw date, expiry,
// target, minimum, cap, max per person, title), one to a community raffle's creator for any change. Nothing when it all
// changed back, or when the raffle drew / closed in the meantime (those notices say it). Off the request, so a raffle with
// thousands of holders doesn't hold up the admin's save.
const EDIT_COLS = ["title", "description", "price", "trigger_kind", "draw_at", "target", "min_tickets", "max_tickets", "max_per_user", "expires_at"];
const BUYER_COLS = ["title", "draw_at", "expires_at", "target", "min_tickets", "max_tickets", "max_per_user"];
const NOTE_QUIET = 3 * MIN, NOTE_MAX = 15 * MIN;
/** Two times in the same minute (a datetime-local field has no seconds) - or both unset. */
const sameMinute = (a, b) => (a == null || b == null ? a == null && b == null : Math.floor(a / MIN) === Math.floor(b / MIN));
/** The latest an edit can move a raffle's expiry to: 2 x max_days after it was made (or its expiry, when that's later). */
const editCeiling = (r) => Math.max(Number(r.created) + 2 * CONFIG.max_days * DAY, Number(r.expires_at) || 0);
const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
/** The fields an edit compares (the description as text). */
const editSnap = (r) => Object.fromEntries(EDIT_COLS.map((k) => [k, k === "description" ? (r.description || "") : r[k]]));
/** An open raffle the tick / a buy would draw or close right now: an edit never runs then (it can't skip or delay a due draw). */
function dueNow(r, t) {
  if (t >= r.expires_at) return true;
  if (r.trigger_kind === "target") return r.sold >= r.target;
  return r.draw_at != null && t >= r.draw_at && r.sold >= r.min_tickets;
}
const goalOf = (x) => (x.trigger_kind === "target" ? x.target : x.min_tickets);
/**
 * The edited row: the fields `b` gives over the current row `r` at time `t` (most = the most tickets one buyer holds).
 * A field that's absent or equal to its value (a time in the same minute) is not a change and isn't re-checked.
 * -> {nx, changes: {col: [before, after]}} | throws a Refuse.
 */
function planEdit(r, b, t, most) {
  const C = CONFIG;
  const sold = Number(r.sold) || 0, locked = sold > 0;
  const has = (k) => b[k] !== undefined && b[k] !== null;
  const given = (k) => has(k) && String(b[k]).trim() !== "";
  const nx = {};
  for (const k of EDIT_COLS) nx[k] = r[k];
  nx.description = r.description || "";
  // the prize: never (held in escrow / reserved from stock since the raffle was made)
  const prizeLocked = () => new Refuse(409, "The prize can't change: it has been held since the raffle was made. Take the raffle down (every ticket refunded) and make a new one instead.", "E_LOCKED");
  if (given("prize_kind") && String(b.prize_kind) !== String(r.prize_kind)) throw prizeLocked();
  if (given("prize_amount") && pat(b.prize_amount) !== Number(r.prize_amount)) throw prizeLocked();
  if (given("prize_item") && String(b.prize_item) !== String(r.prize_item || "")) throw prizeLocked();
  if (given("prize_text") && str(b.prize_text, 200) !== String(r.prize_text || "")) throw prizeLocked();
  // the words (the creation rules)
  if (has("title")) {
    const title = str(b.title, 90);
    if (title.length < 3) throw new Refuse(400, "Give it a title (3-90 characters).", "E_TITLE");
    if (title !== r.title) guardText("title", title);
    nx.title = title;
  }
  if (has("description")) {
    const d = String(b.description).replace(/\r/g, "").trim().slice(0, 1500);
    if (d !== nx.description) guardText("description", d);
    nx.description = d;
  }
  // the price: until the first ticket
  let priceChanged = false;
  if (given("price")) {
    const p = pat(b.price);
    if (p !== r.price) {
      if (locked) throw new Refuse(409, `Tickets are sold, so the price stays ${fmt(r.price)} PAT.`, "E_LOCKED");
      if (!(p >= C.price_min && p <= C.price_max)) throw new Refuse(400, `A ticket costs ${fmt(C.price_min)}-${fmt(C.price_max)} PAT.`, "E_PRICE");
      nx.price = p;
      priceChanged = true;
    }
  }
  const cap = MAX_TICKETS(nx.price);
  // the trigger: date <-> target until the first ticket
  let switched = false;
  if (given("trigger")) {
    const trig = String(b.trigger) === "target" ? "target" : String(b.trigger) === "date" ? "date" : null;
    if (!trig) throw new Refuse(400, "Pick when it draws: on a date, or when a number of tickets is sold.", "E_TRIGGER");
    if (trig !== r.trigger_kind) {
      if (locked) throw new Refuse(409, "Tickets are sold, so it keeps drawing the way it was announced (on its date, or at its ticket target).", "E_LOCKED");
      switched = true;
      nx.trigger_kind = trig;
      if (trig === "target") nx.draw_at = null;
      else { nx.target = 0; nx.max_tickets = 0; }
    }
  }
  const isDate = nx.trigger_kind === "date";
  // the minimum: only down once a ticket is sold
  let minChanged = false;
  if (has("min_tickets")) {
    const m = String(b.min_tickets).trim() === "" ? 1 : int(b.min_tickets);
    if (m !== r.min_tickets) {
      if (!(m >= 1 && m <= cap)) throw new Refuse(400, "The minimum is 1 ticket or more.", "E_MIN");
      if (locked && m > r.min_tickets) throw new Refuse(409, `Tickets are sold, so the minimum can only go down (it's ${fmt(r.min_tickets)}).`, "E_MIN");
      nx.min_tickets = m;
      minChanged = true;
    }
  }
  // max per person (empty / 0 = no limit): only up once a ticket is sold, never below what one buyer holds
  if (has("max_per_user")) {
    const mp = String(b.max_per_user).trim() === "" ? 0 : int(b.max_per_user);
    if (mp !== r.max_per_user) {
      if (!(mp >= 0 && mp <= cap)) throw new Refuse(400, "Max tickets per person: leave it empty for no limit, or 1 and up.", "E_MAXPER");
      if (locked && (r.max_per_user === 0 || (mp !== 0 && mp < r.max_per_user))) {
        throw new Refuse(409, `Tickets are sold, so the most one person can hold can only go up (it's ${r.max_per_user ? fmt(r.max_per_user) : "no limit"}).`, "E_MAXPER");
      }
      if (mp !== 0 && mp < most) throw new Refuse(409, `Someone already holds ${fmt(most)} tickets - max per person can't be lower than that.`, "E_MAXPER");
      nx.max_per_user = mp;
    }
  }
  // the goal: a date raffle's cap (empty = none) / a target raffle's target (= its cap)
  let goalChanged = false;
  if (isDate) {
    if (given("target") && !switched && int(b.target) !== r.target) throw new Refuse(400, "That raffle draws on a date - it has no ticket target (its cap is the most tickets it sells).", "E_TARGET");
    if (has("max_tickets")) {
      const mt = String(b.max_tickets).trim() === "" ? 0 : int(b.max_tickets);
      if (switched || mt !== r.max_tickets) {
        if (!(mt === 0 || (mt >= 1 && mt <= cap))) throw new Refuse(400, "The ticket cap must be at least the minimum (or empty for no cap).", "E_MAX");
        if (locked && (r.max_tickets === 0 || (mt !== 0 && mt < r.max_tickets))) {
          throw new Refuse(409, `Tickets are sold, so the cap can only go up (it's ${r.max_tickets ? fmt(r.max_tickets) : "no cap"}).`, "E_MAX");
        }
        if (mt !== 0 && mt < sold) throw new Refuse(409, `${fmt(sold)} tickets are sold - the cap can't be lower.`, "E_MAX");
        nx.max_tickets = mt;
        goalChanged = true;
      }
    }
    if ((goalChanged || minChanged || priceChanged) && nx.max_tickets && nx.max_tickets < nx.min_tickets) {
      throw new Refuse(400, "The ticket cap must be at least the minimum (or empty for no cap).", "E_MAX");
    }
  } else {
    if (given("max_tickets") && !switched && int(b.max_tickets) !== r.max_tickets) throw new Refuse(400, "A target raffle's cap is its target - change the target instead.", "E_MAX");
    if (switched && !given("target")) throw new Refuse(400, `Give the ticket target (at least ${fmt(Math.max(1, nx.min_tickets))}).`, "E_TARGET");
    if (given("target")) {
      const tg = int(b.target);
      if (switched || tg !== r.target) { nx.target = tg; goalChanged = true; }
    }
    if (minChanged && nx.min_tickets > nx.target && !goalChanged) throw new Refuse(400, `The minimum can't be more than the target (${fmt(nx.target)}).`, "E_MIN");
    if (goalChanged || minChanged || priceChanged) {
      const lo = Math.max(1, nx.min_tickets, sold + 1);
      if (!(nx.target >= lo && nx.target <= cap)) {
        throw new Refuse(400, sold ? `The target must be at least ${fmt(lo)} tickets (the minimum, and more than the ${fmt(sold)} sold).` : `The target must be at least ${fmt(lo)} tickets (the minimum).`, "E_TARGET");
      }
    }
    nx.max_tickets = nx.target;
  }
  if (priceChanged && (nx.min_tickets > cap || nx.max_per_user > cap)) throw new Refuse(400, "That's too many tickets for that price.", "E_PRICE");
  // the draw date (a date raffle): min_lead_min .. max_days from now
  let drawChanged = false;
  if (isDate) {
    if (has("draw_at") || switched) {
      const at = has("draw_at") ? parseWhen(b.draw_at, b.tz) : null;
      if (at === null || !Number.isFinite(at)) throw new Refuse(400, "Give the draw date.", "E_DRAW_AT");
      if (switched || !sameMinute(at, r.draw_at)) {
        if (at < t + C.min_lead_min * MIN || at > t + C.max_days * DAY) {
          throw new Refuse(400, `The draw date must be at least ${C.min_lead_min} minutes and at most ${C.max_days} days from now.`, "E_DRAW_AT");
        }
        const last = editCeiling(r) - C.grace_hours * HOUR;
        if (at > last) {
          throw new Refuse(400, `A raffle runs at most ${2 * C.max_days} days in all, and it expires at least ${C.grace_hours} hour(s) after its draw - the draw date can be ${utc(last)} at the latest.`, "E_DRAW_AT");
        }
        nx.draw_at = at;
        drawChanged = true;
      }
    }
  } else if (given("draw_at") && !switched && !sameMinute(parseWhen(b.draw_at, b.tz), r.draw_at)) {
    throw new Refuse(400, "That raffle draws when its target is sold - it has no draw date.", "E_DRAW_AT");
  }
  // the expiry: at most max_days from now; after the draw (+ grace_hours) on a date raffle, an hour away on a target raffle
  let expChanged = false;
  if (has("expires_at")) {
    const e = parseWhen(b.expires_at, b.tz);
    if (e === null || !Number.isFinite(e)) throw new Refuse(400, "Give the expiry date.", "E_EXPIRY");
    if (!sameMinute(e, r.expires_at)) { nx.expires_at = e; expChanged = true; }
  }
  if (expChanged || drawChanged || switched) {
    if (isDate) {
      const after = Math.max(nx.draw_at, t + C.min_lead_min * MIN);
      if (nx.expires_at < after + C.grace_hours * HOUR) {
        throw new Refuse(400, nx.draw_at >= t + C.min_lead_min * MIN
          ? `The expiry must be at least ${C.grace_hours} hour(s) after the draw date and at most ${C.max_days} days from now.`
          : `The expiry must be at least ${C.grace_hours} hour(s) and ${C.min_lead_min} minutes from now (the draw date has passed), and at most ${C.max_days} days.`, "E_EXPIRY");
      }
    } else if (nx.expires_at < t + HOUR) throw new Refuse(400, `The expiry must be 1 hour to ${C.max_days} days from now.`, "E_EXPIRY");
    if (expChanged && nx.expires_at > t + C.max_days * DAY) {
      throw new Refuse(400, isDate ? `The expiry must be at least ${C.grace_hours} hour(s) after the draw date and at most ${C.max_days} days from now.` : `The expiry must be 1 hour to ${C.max_days} days from now.`, "E_EXPIRY");
    }
    if (expChanged && nx.expires_at > editCeiling(r)) {
      throw new Refuse(400, `A raffle runs at most ${2 * C.max_days} days in all (its tickets stay held until it draws or expires) - this one can expire ${utc(editCeiling(r))} at the latest.`, "E_EXPIRY");
    }
  }
  // the milestones follow a new goal: the ones already passed are marked (not announced again), the rest can still come
  nx.milestones = r.milestones;
  if (goalOf(nx) !== goalOf(r)) {
    const g = goalOf(nx);
    nx.milestones = [[1, 25], [2, 50], [4, 75], [8, 100]].reduce((acc, [bit, pct]) => (g > 0 && sold * 100 >= g * pct ? acc | bit : acc), 0);
  }
  const changes = {};
  for (const k of EDIT_COLS) {
    const before = k === "description" ? (r.description || "") : r[k];
    if (nx[k] !== before) changes[k] = [before, nx[k]];
  }
  return { nx, changes };
}
/**
 * Admin: change an open raffle. input = any of {title, description, price, trigger, draw_at, expires_at, target, min_tickets,
 * max_tickets, max_per_user, tz} (times as ms / unix seconds / ISO / datetime-local + tz, like create). -> {ok, id, changed: [cols],
 * noop?, holders (ticket holders now), notify_at (when their notice goes - flushEditNotices), drawn?}
 */
async function edit(adminId, id, input = {}) {
  await init();
  const a = await userRow(adminId);
  if (!rafflesAdmin(a)) throw new Refuse(403, "Admins only.", "E_ADMIN");
  const r0 = await raffleRow(id);
  if (!r0) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  const b = input && typeof input === "object" ? input : {};
  const AA = require("./adminaudit");
  await AA.init();                 // before the transaction: a memoized init awaited inside one would wait at the write gate
  // a House raffle with a PAT prize is a Pepe owner's to make (validate) - its price too (read before the transaction)
  const SR = require("./staffroles");
  const houseOwner = r0.house && r0.prize_kind === "pat" ? !!(await SR.ownerOf(a, "raffles.house").catch(() => null)) : true;
  const res = await tx(async () => {
    const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r0.id]))[0];
    if (!r || r.status !== "open") throw new Refuse(409, `That raffle is ${r ? r.status : "gone"} - only an open raffle can be changed.`, "E_STATE");
    const t = now();
    if (dueNow(r, t)) throw new Refuse(409, t >= r.expires_at ? "That raffle is closing right now (its expiry has passed)." : "That raffle is being drawn right now.", "E_DUE");
    const most = Number((await getQuery(`SELECT COALESCE(MAX(n), 0) AS m FROM (SELECT SUM(qty) AS n FROM raffle_tickets WHERE raffle_id = ? AND state = 'held' GROUP BY user_id)`,
                                        [r.id]))[0].m) || 0;
    const { nx, changes } = planEdit(r, b, t, most);
    const keys = Object.keys(changes);
    if (!keys.length) return { changed: [] };
    if (changes.price && !houseOwner) throw new Refuse(403, "The ticket price of a House raffle with a PAT prize: " + SR.OWNER_ONLY, "owner_only");
    // the notices: what the holders were last told stays the "before" until they're told again; one notice for edits close together
    let from = null;
    try { from = r.note_from ? JSON.parse(r.note_from) : null; } catch (e) { from = null; }
    if (!from || !from.before || !from.since) from = { since: t, before: editSnap(r) };
    let due = Math.min(from.since + NOTE_MAX, t + NOTE_QUIET);
    for (const at of [from.before.draw_at, r.draw_at, nx.draw_at]) if (at && at > t) due = Math.min(due, Math.max(t, at - MIN));
    const u = await runQuery(`UPDATE raffles SET title = ?, description = ?, price = ?, price0 = COALESCE(price0, ?), trigger_kind = ?, draw_at = ?, target = ?,
                              min_tickets = ?, max_tickets = ?, max_per_user = ?, expires_at = ?, milestones = ?, note_due = ?, note_from = ?, updated = ?
                              WHERE id = ? AND status = 'open' AND sold = ?`,
                             [nx.title, nx.description || null, nx.price, r.price, nx.trigger_kind, nx.draw_at, nx.target, nx.min_tickets, nx.max_tickets,
                              nx.max_per_user, nx.expires_at, nx.milestones, due, JSON.stringify(from), t, r.id, r.sold]);
    if (!u.changes) throw new Refuse(409, "That raffle changed while you were editing it - nothing was saved. Try again.", "E_RACE");
    await AA.record(a, "raffle_edit", null, { raffle: r.id, changes: Object.fromEntries(keys.map((k) => [k, { before: changes[k][0], after: changes[k][1] }])) });
    const r2 = (await getQuery("SELECT * FROM raffles WHERE id = ?", [r.id]))[0];
    const creator = r.house ? null : await userRow(r.creator_id);
    await event("edited", r.id, Object.assign(brief(r2, creator && creator.username), { changed: keys, by: "PATV" }));
    const holders = Number((await getQuery("SELECT COUNT(DISTINCT user_id) AS n FROM raffle_tickets WHERE raffle_id = ? AND state = 'held'", [r.id]))[0].n) || 0;
    return { changed: keys, r: r2, holders, due };
  });
  if (!res.changed.length) return { ok: true, id: r0.id, changed: [], noop: true };
  wake();
  // the edit may have made it due (a minimum lowered to what's sold after the draw date): draw it now, as a buy would
  let drew = null;
  try { drew = await maybeDraw(res.r.id); } catch (e) { console.error("[raffles] draw after edit:", e.message); }
  return Object.assign({ ok: true, id: res.r.id, changed: res.changed, holders: res.holders, notify_at: res.due }, drew && drew.drawn ? { drawn: true } : {});
}
/**
 * The clock: the edit notices that are due (note_due). Each raffle's booking is taken in a transaction (an edit after it books
 * a new one, from what this one tells), then: the change from what the holders were last told (note_from.before) to the row
 * now - one notice per ticket holder (a buyer-visible change), one to a community raffle's creator. -> notices filed
 */
async function flushEditNotices({ limit = 20 } = {}) {
  await init();
  const due = await getQuery("SELECT id FROM raffles WHERE note_due IS NOT NULL AND note_due <= ? ORDER BY note_due LIMIT ?", [now(), limit]);
  let n = 0;
  for (const { id } of due) {
    try {
      const got = await tx(async () => {
        const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [id]))[0];
        if (!r || r.note_due == null || r.note_due > now()) return null;
        await runQuery("UPDATE raffles SET note_due = NULL, note_from = NULL WHERE id = ?", [id]);
        const holders = (await getQuery("SELECT DISTINCT user_id FROM raffle_tickets WHERE raffle_id = ? AND state = 'held' ORDER BY user_id", [id])).map((x) => x.user_id);
        return { r, holders };
      });
      if (!got || got.r.status !== "open") continue;           // drawn / closed since: those notices tell the holders
      let from = null;
      try { from = JSON.parse(got.r.note_from || "null"); } catch (e) { from = null; }
      if (!from || !from.before) continue;
      const nowSnap = editSnap(got.r);
      const changes = {};
      for (const k of EDIT_COLS) if (k in from.before && from.before[k] !== nowSnap[k]) changes[k] = [from.before[k], nowSnap[k]];
      if (!Object.keys(changes).length) continue;              // changed back: nothing to tell
      n += await editNotices({ r: got.r, changes, holders: got.holders, tag: got.r.note_due });
    } catch (e) { console.error(`[raffles] edit notices R${id}:`, e.message); }
  }
  return n;
}
/** One edit notice per ticket holder (a buyer-visible change), one to a community raffle's creator. -> notices filed */
async function editNotices({ r, changes, holders, tag }) {
  const inbox = require("./inbox");
  let TZ = null;
  try { TZ = require("./tz"); await TZ.ensure(); } catch (e) { TZ = null; }
  const when = (ms, uid) => {
    if (!ms) return "-";
    try { return TZ.fmt(ms, { zone: TZ.getPref(uid) || "UTC", style: "datetime" }); } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
  };
  const tickets = (n) => `${fmt(n)} ticket${Number(n) === 1 ? "" : "s"}`;
  const line = (k, uid) => {
    const [was, is] = changes[k];
    switch (k) {
      case "title": return `Title: "${is}" (was "${was}")`;
      case "description": return "The description changed.";
      case "price": return `Ticket price: ${fmt(is)} PAT (was ${fmt(was)} PAT)`;
      case "trigger_kind": return is === "date" ? "It now draws on a date (it drew at a ticket target)." : "It now draws when its ticket target is sold (it drew on a date).";
      case "draw_at": return !is ? null : was ? `Draw: ${when(is, uid)} (was ${when(was, uid)})` : `Draw: ${when(is, uid)}`;
      case "expires_at": return `Expires (every ticket refunded if it hasn't drawn): ${when(is, uid)} (was ${when(was, uid)})`;
      case "target": return is ? `It draws when ${tickets(is)} are sold${was ? ` (was ${fmt(was)})` : ""}` : null;
      case "min_tickets": return `Minimum to draw: ${tickets(is)} (was ${fmt(was)})`;
      case "max_tickets": return r.trigger_kind === "target" ? null : `Ticket cap: ${is ? tickets(is) : "none"} (was ${was ? fmt(was) : "none"})`;
      case "max_per_user": return `Most tickets one person can hold: ${is ? fmt(is) : "no limit"} (was ${was ? fmt(was) : "no limit"})`;
      default: return null;
    }
  };
  const lines = (cols, uid) => cols.filter((k) => changes[k]).map((k) => line(k, uid)).filter(Boolean);
  let n = 0;
  if (BUYER_COLS.some((k) => changes[k])) {
    for (const uid of holders) {
      const title = changes.draw_at ? `🎫 ${r.title}: the draw is now ${when(r.draw_at, uid)} (changed by PATV)`
        : changes.expires_at ? `🎫 ${r.title}: it now expires ${when(r.expires_at, uid)} (changed by PATV)`
        : changes.target ? `🎫 ${r.title}: it now draws at ${tickets(r.target)} (changed by PATV)`
        : `🎫 ${r.title}: the raffle was changed by PATV`;
      const body = [`Raffle R${r.id}:`, ...lines(BUYER_COLS, uid), "Your tickets and their numbers stay as they are."].join("\n");
      if (await inbox.addSafe(uid, { kind: "raffle", title, body, link: `/raffles/${r.id}`, ref: `raffle-edit:${r.id}:${tag}` })) n++;
    }
  }
  if (!r.house && r.creator_id) {
    const body = [...lines(EDIT_COLS, r.creator_id), holders.length && BUYER_COLS.some((k) => changes[k]) ? `Everyone holding tickets (${fmt(holders.length)}) was told.` : null].filter(Boolean).join("\n");
    if (await inbox.addSafe(r.creator_id, { kind: "raffle", title: `🎫 Your raffle R${r.id} was changed by PATV: ${r.title}`, body, link: `/raffles/${r.id}`, ref: `raffle-edit-creator:${r.id}:${tag}` })) n++;
  }
  return n;
}
/**
 * 1.99xq: the admins' page (/admin/raffles) - what needs a decision (disputed / waiting on delivery), every open raffle (house
 * and community, every pad - admins see them all) and the last closed / drawn ones. -> {review, open, recent}
 */
async function adminState({ recent = 30 } = {}) {
  await init();
  const q = (where, order, lim) => getQuery(`SELECT * FROM raffles WHERE ${where} ORDER BY ${order} LIMIT ?`, [lim]);
  const review = await q("status IN ('disputed','delivering')", "CASE WHEN status = 'disputed' THEN 0 ELSE 1 END, COALESCE(dispute_at, drawn_at, 0) DESC", 200);
  const open = await q("status = 'open'", "house DESC, expires_at ASC", 500);
  const past = await q("status NOT IN ('open','disputed','delivering')", "COALESCE(closed_at, drawn_at, updated, 0) DESC", Math.max(1, Math.min(200, recent)));
  const nm = await names([...review, ...open, ...past].flatMap((r) => [r.creator_id, r.dispute_by, r.closed_by]));
  // 1.99afy: the edit form's floors - the most tickets one buyer holds in each open raffle (max per person can't go below it)
  const most = new Map();
  const openIds = open.filter((r) => r.sold > 0).map((r) => r.id);
  for (let i = 0; i < openIds.length; i += 400) {
    const part = openIds.slice(i, i + 400);
    const rows = await getQuery(`SELECT raffle_id, MAX(n) AS m FROM (SELECT raffle_id, SUM(qty) AS n FROM raffle_tickets WHERE state = 'held' AND raffle_id IN (${part.map(() => "?").join(",")})
                                 GROUP BY raffle_id, user_id) GROUP BY raffle_id`, part);
    for (const x of rows) most.set(x.raffle_id, Number(x.m) || 0);
  }
  const view = (r) => Object.assign(shape(r, { creatorName: nm.get(r.creator_id) }), {
    dispute_note: r.dispute_note || null, dispute_by: r.dispute_by ? (nm.get(r.dispute_by) || r.dispute_by) : null, dispute_at: r.dispute_at || null,
    closed_by: r.closed_by ? (nm.get(r.closed_by) || r.closed_by) : null, most_held: most.get(r.id) || 0,
    edit_until: r.status === "open" ? editCeiling(r) : null,      // the latest an edit can move its expiry to
  });
  return { review: review.map(view), open: open.map(view), recent: past.map(view) };
}
/** The creator cancels before anyone bought a ticket (the prize comes back). */
async function cancel(userId, id) {
  await init();
  const r = await raffleRow(id);
  if (!r) throw new Refuse(404, "No such raffle.", "E_NOT_FOUND");
  if (r.creator_id !== userId) throw new Refuse(403, "Only its creator can cancel a raffle.", "E_NOT_CREATOR");
  if (r.status !== "open") throw new Refuse(409, `That raffle is ${r.status}.`, "E_STATE");
  if (r.sold > 0) throw new Refuse(409, "Tickets are sold - it can't be cancelled now (an admin can take it down with refunds).", "E_SOLD");
  return Object.assign({ ok: true }, await expire(r.id, "cancelled", { actor: userId, reason: "cancelled by its creator" }));
}

// ── the clock: date draws, expiries, custom-prize releases ──
let ticking = null;
function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    await init();
    const t = now();
    const out = { drawn: 0, expired: 0, released: 0, noticed: 0 };
    const due = await getQuery(`SELECT id FROM raffles WHERE status = 'open' AND (expires_at <= ? OR (trigger_kind = 'date' AND draw_at <= ? AND sold >= min_tickets)
                                OR (trigger_kind = 'target' AND sold >= target)) ORDER BY id LIMIT 50`, [t, t]);
    for (const { id } of due) {
      try {
        const r = await maybeDraw(id);
        if (r && r.drawn) out.drawn++;
        else if (r && r.closed) out.expired++;
      } catch (e) { console.error(`[raffles] tick R${id}:`, e.message); }
    }
    const rel = await getQuery("SELECT id FROM raffles WHERE status = 'delivering' AND release_at <= ? ORDER BY id LIMIT 50", [t]);
    for (const { id } of rel) {
      try {
        const res = await tx(async () => {
          const r = (await getQuery("SELECT * FROM raffles WHERE id = ?", [id]))[0];
          if (!r || r.status !== "delivering" || r.release_at > now()) return null;
          return releaseInTx(r, "released after the hold window");
        });
        if (res) {
          out.released++;
          require("./inbox").addSafe(res.r.creator_id, { kind: "raffle", title: `🎫 Raffle R${res.r.id}: your ticket sales are released`,
            body: `No dispute in ${CONFIG.custom_hold_days} days - ${fmt(res.payout)} PAT is in your balance.`, link: `/raffles/${res.r.id}`, ref: `raffle-released:${res.r.id}` }).catch(() => {});
        }
      } catch (e) { console.error(`[raffles] release R${id}:`, e.message); }
    }
    // 1.99afy: an admin's edits - one notice per holder once the changes settle (after the draws: a raffle drawn meanwhile says so itself)
    try { out.noticed = await flushEditNotices(); } catch (e) { console.error("[raffles] edit notices:", e.message); }
    if (out.drawn || out.expired || out.released) wake();
    return out;
  })().finally(() => { ticking = null; });
  return ticking;
}

// ── Pepe: events + the chat verbs ──
async function eventsAfter(after, waitMs = 0) {
  await init();
  const a = Number(after);
  if (!(a >= 0)) {
    const r = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM raffle_events"))[0];
    return { cursor: Number(r.m) || 0, events: [] };
  }
  const read = async () => (await getQuery("SELECT * FROM raffle_events WHERE id > ? ORDER BY id LIMIT 100", [a])).map((e) => {
    let d = {};
    try { d = JSON.parse(e.data || "{}"); } catch (x) { d = {}; }
    return { id: e.id, ts: e.ts, raffle: e.raffle_id, kind: e.kind, data: d };
  });
  let ev = await read();
  const w = Math.max(0, Math.min(25000, Number(waitMs) || 0));
  if (!ev.length && w) {
    await new Promise((res) => {
      const done = () => { clearTimeout(tm); waiters.delete(done); res(); };
      const tm = setTimeout(done, w);
      waiters.add(done);
    });
    ev = await read();
  }
  if (Math.random() < 0.02) {
    runQuery("DELETE FROM raffle_events WHERE ts < ?", [now() - 14 * DAY]).catch(() => {});
    runQuery("DELETE FROM raffle_price_seen WHERE raffle_id IN (SELECT id FROM raffles WHERE status != 'open')").catch(() => {});
  }
  return { cursor: ev.length ? ev[ev.length - 1].id : a, events: ev };
}
/** A short chat view of one raffle. */
function chatView(v) {
  return { id: v.id, title: v.title, house: v.house, prize: v.prize.name, prize_kind: v.prize.kind, price: v.price, sold: v.sold, target: v.target,
           min_tickets: v.min_tickets, max_tickets: v.max_tickets, max_per_user: v.max_per_user, trigger: v.trigger, draw_at: v.draw_at, expires_at: v.expires_at,
           next_at: v.next_at, status: v.status, winner: v.winner, winning_no: v.winning_no, mine: v.mine || 0, url: v.url, creator: v.creator, pad: v.padv ? v.padv.title : null };
}
/** 1.99afy: the ticket price a chat buyer was last shown - a newer one they saw (raffle_price_seen), else the announced one. */
async function chatPrice(r, userId) {
  const s = (await getQuery("SELECT price FROM raffle_price_seen WHERE raffle_id = ? AND user_id = ?", [r.id, userId]))[0];
  if (s) return Number(s.price);
  return r.price0 != null ? Number(r.price0) : undefined;
}
/** Note the price a chat buyer was just shown (needed once it isn't the announced one, or a note is there already). */
async function chatSaw(raffleId, userId, price, force = false) {
  if (!force) {
    const r = (await getQuery("SELECT price0 FROM raffles WHERE id = ?", [raffleId]))[0];
    const has = (await getQuery("SELECT 1 AS x FROM raffle_price_seen WHERE raffle_id = ? AND user_id = ?", [raffleId, userId]))[0];
    if (!has && (!r || r.price0 == null || Number(r.price0) === Number(price))) return false;
  }
  await runQuery(`INSERT INTO raffle_price_seen (raffle_id, user_id, price, ts) VALUES (?, ?, ?, ?)
                  ON CONFLICT(raffle_id, user_id) DO UPDATE SET price = excluded.price, ts = excluded.ts`, [raffleId, userId, Number(price), now()]);
  return true;
}
/** Pepe's chat verbs. b = {verb, login, id, qty, key, room} -> {ok, ...} | throws Refuse */
async function botAct(b) {
  await init();
  if (!(await enabled())) return { ok: false, code: "E_OFF", error: "PAT Raffles aren't open yet." };
  const verb = String(b.verb || "list");
  const u = b.login ? await userByLogin(b.login) : null;
  const viewer = u ? { userId: u.userId, username: u.username } : null;
  if (verb === "list") {
    const L = await list({ viewer, status: "open" });
    const all = L.house.concat(L.community);
    return { ok: true, raffles: all.slice(0, 8).map(chatView), total: all.length };
  }
  if (verb === "show") {
    const v = await detail(b.id, viewer);
    if (!v) return { ok: false, code: "E_NOT_FOUND", error: "No such raffle." };
    // 1.99afy: the chat line shows the price - a price an admin changed is now one this buyer has seen
    if (u && v.status === "open") await chatSaw(v.id, u.userId, v.price).catch((e) => console.error("[raffles] price seen:", e.message));
    return { ok: true, raffle: chatView(v) };
  }
  if (verb === "buy") {
    if (!u) return { ok: false, code: "E_NO_ACCOUNT", error: "link your chat name to a PATV account first (!verify)." };
    const key = String(b.key || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    // 1.99afy: Pepe sends no price, and an admin can change it before the first ticket - the buy goes through only at the price
    // this buyer was last shown in chat: the one it was announced at, or a newer one (!raffle <id>, or this refusal)
    const r0 = await raffleRow(b.id);
    const expect = r0 ? await chatPrice(r0, u.userId) : undefined;
    try {
      const r = await buy(u.userId, { id: b.id, qty: b.qty, idem: key, expect, via: "chat" });
      return Object.assign({ ok: true }, r);
    } catch (e) {
      if (!(e && e.code === "E_PRICE_CHANGED" && r0)) throw e;
      const cur = await raffleRow(r0.id);
      if (!cur || cur.status !== "open") throw e;
      await chatSaw(cur.id, u.userId, cur.price, true);
      const n = Math.max(1, int(b.qty === undefined || b.qty === "" ? 1 : b.qty) || 1);
      throw new Refuse(409, `R${cur.id}'s ticket price was changed by PATV: it's ${fmt(cur.price)} PAT a ticket now (it was ${fmt(expect)})`
        + ` - nothing was charged. Send the same !raffle buy again to buy ${fmt(n)} for ${fmt(cur.price * n)} PAT, or buy on the site.`, "E_PRICE_CHANGED");
    }
  }
  return { ok: false, code: "E_VERB", error: "unknown verb" };
}

// ── pad pages + embeds ──
async function forPad(padId, viewer = null) {
  await init();
  if (!padId) return null;
  const rows = await getQuery("SELECT * FROM raffles WHERE pad = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, id DESC LIMIT 20", [padId]);
  const nm = await names(rows.map((r) => r.creator_id));
  const open = rows.filter((r) => r.status === "open").map((r) => shape(r, { creatorName: nm.get(r.creator_id) }));
  const past = rows.filter((r) => r.status !== "open").slice(0, 2).map((r) => shape(r, { creatorName: nm.get(r.creator_id) }));
  return { open: open.slice(0, 4), past, count: rows.length, any: rows.length > 0, on: enabledSync() };
}
/** Embed cards (embedcards.js): {ref: card | null} for ids the viewer may see. */
async function cards(ids, viewer) {
  await init();
  const out = {};
  const list0 = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 30);
  if (!list0.length) return out;
  const rows = await getQuery(`SELECT * FROM raffles WHERE id IN (${list0.map(() => "?").join(",")})`, list0);
  for (const r of rows) {
    if (!canSeePad(viewer, r.pad)) continue;
    const st = r.status === "open" ? (now() < r.expires_at ? "open" : "closed") : ["drawn", "complete", "delivering", "disputed"].includes(r.status) ? "settled" : r.status === "expired" ? "expired" : "void";
    out["R" + r.id] = { ref: "R" + r.id, kind: "raffle", id: r.id, url: "/raffles/" + r.id, title: r.title, status: st, closes: nextAt(r), house: !!r.house,
                        result: st === "settled" && r.winner_name ? r.winner_name : null, prize: r.prize_name, price: r.price, sold: r.sold,
                        goal: r.trigger_kind === "target" ? r.target : r.min_tickets, trigger: r.trigger_kind, pad: padView(r.pad) };
  }
  return out;
}

// ── achievements (achievements.js featureMetrics) ──
const ACH_BUYERS = 3;            // a raffle counts once 3+ different people bought tickets in it
async function achMetrics(userId) {
  const one = async (sql, p) => { const r = await getQuery(sql, p).catch(() => []); return Number((r[0] && Object.values(r[0])[0]) || 0) || 0; };
  return {
    raffles_made: await one(`SELECT COUNT(*) FROM raffles WHERE creator_id = ? AND house = 0 AND status IN ('drawn','delivering','complete') AND buyers >= ?`, [userId, ACH_BUYERS]),
    raffle_wins: await one(`SELECT COUNT(*) FROM raffles WHERE winner_id = ? AND status IN ('drawn','delivering','complete') AND buyers >= ?`, [userId, ACH_BUYERS]),
  };
}

// ── routes ──
function register(app, { isBotToken, addUser, noTimers = false }) {
  init().catch((e) => console.error("[raffles] init:", e.message));
  if (app.locals) app.locals.rafflesOn = () => enabledSync();
  require("./userlinks").install(app);
  const guard = require("./middleware/authGuard");
  const hits = guard.limiter({ max: 30, windowMs: 60 * 1000 });
  const uid = (req) => (req.user && req.user.userId) || null;
  const answer = (res, e, tag) => {
    if (e && (e.refuse || e instanceof Refuse || (e.status && e.code))) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
    console.error(`[raffles] ${tag}:`, e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { answer(res, e, "bot"); }
  };
  app.post("/api/raffles/bot/act", bot((b) => botAct(b)));
  app.post("/api/raffles/bot/poll", bot(async (b) => Object.assign({ ok: true, on: await enabled() }, await eventsAfter(b.after, b.wait))));

  // the web: JSON (fetch, same site) - the pages' forms post here through public/js/raffles.js
  // fn(userId, body, raffle id from the path)
  const web = (fn) => async (req, res) => {
    if (!uid(req)) return res.status(401).json({ ok: false, error: "Sign in first.", code: "E_AUTH" });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const k = "rf:" + uid(req);
    if (hits.blocked(k)) return res.status(429).json({ ok: false, error: "Slow down a little.", code: "E_RATE" });
    hits.hit(k);
    try { res.json(await fn(uid(req), req.body || {}, req.params && req.params.id)); } catch (e) { answer(res, e, "web"); }
  };
  app.post("/api/raffles/create", addUser, web((u, b) => create(u, b)));
  app.post("/api/raffles/:id/buy", addUser, web((u, b, id) => buy(u, { id, qty: b.qty, idem: b.idem, expect: b.expect, via: "web" })));
  app.post("/api/raffles/:id/cancel", addUser, web((u, b, id) => cancel(u, id)));
  app.post("/api/raffles/:id/confirm", addUser, web((u, b, id) => confirmDelivery(u, id)));
  app.post("/api/raffles/:id/dispute", addUser, web((u, b, id) => dispute(u, id, b.note)));
  app.post("/api/raffles/:id/takedown", addUser, web((u, b, id) => takedown(u, id, b.reason)));
  app.post("/api/raffles/:id/decide", addUser, web((u, b, id) => decide(u, id, String(b.decision || ""), b.reason)));
  // 1.99afy: an admin changes an open raffle (/admin/raffles -> Edit): the draw date, the expiry, the target, the limits, the words
  app.post("/api/admin/raffles/:id/edit", addUser, web((u, b, id) => edit(u, id, b)));
  app.post("/api/admin/raffles", addUser, web(async (u, b) => {
    const a = await userRow(u);
    if (!rafflesAdmin(a)) throw new Refuse(403, "Admins only.", "E_ADMIN");
    if (b.enabled !== undefined) await setEnabled(!!b.enabled && b.enabled !== "0" && b.enabled !== "false", a);
    const cfg = b.config && typeof b.config === "object" ? await setConfig(b.config, a) : config();
    return { ok: true, enabled: await enabled(), config: cfg };
  }));
  // 1.99xq: the admins' page - the switch, the settings, House raffles, the review queue and takedowns (was a card on /raffles)
  app.get("/admin/raffles", addUser, async (req, res) => {
    if (!uid(req)) return res.redirect("/login");
    try {
      await init();
      const me = await userRow(uid(req));
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!rafflesAdmin(me)) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The raffle settings are for site admins.", title: "Admins only" });
      const padlinks = require("./padlinks");
      try { await padlinks.ready(); } catch (e) { /* no pads: site-wide only */ }
      res.render("admin/raffles", {
        user: me.username, isAdmin: true, title: "Admin · Raffles", on: await enabled(), escrowLive: await escrowLive(), cfg: config(), defaults: DEFAULTS, limits: LIMITS,
        A: await adminState(), shares: await feeShares().catch(() => []), items: await eligibleItems(),
        pick: await padlinks.choicesFor(req.user || null, "").catch(() => ({ choices: [], def: "" })), idem: crypto.randomBytes(9).toString("hex"),
      });
    } catch (e) { console.error("[raffles] admin page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/raffles/:id/fair", addUser, async (req, res) => {
    try {
      await init();
      const r = await raffleRow(req.params.id);
      if (!r || !canSeePad(req.user || null, r.pad)) return res.status(404).json({ ok: false, error: "No such raffle." });
      const out = { ok: true, id: r.id, commitment: r.commitment, sold: r.sold, status: r.status };
      if (r.tickets_digest) {
        out.server_seed = r.server_seed; out.tickets_digest = r.tickets_digest; out.winning_no = r.winning_no;
        out.tickets = (await getQuery("SELECT first_no, last_no, username FROM raffle_tickets WHERE raffle_id = ? AND state != 'refunded' ORDER BY first_no", [r.id]))
          .map((t) => [t.first_no, t.last_no, t.username]);
      }
      res.json(out);
    } catch (e) { answer(res, e, "fair"); }
  });

  // pages
  app.get("/raffles", addUser, async (req, res) => {
    try {
      await init();
      const padlinks = require("./padlinks");
      await padlinks.ready();
      try { await require("./padaccess").init(); } catch (e) { /* the gate's own problem */ }
      const me = await userRow(uid(req));
      const viewer = me ? { userId: me.userId, username: me.username } : null;
      const status = ["open", "drawn", "closed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
      const want = padlinks.fromParamFor(req.user || null, req.query.pad);     // 1.99ade: a pad they can't see = unknown (no title leak)
      const L = await list({ viewer, pad: want, status });
      const pv = want ? padlinks.view(want) : null;
      const pads = await padCounts(viewer);
      if (pv && !pads.some((p) => p.slug === pv.slug)) pads.push({ slug: pv.slug, title: pv.title, n: 0 });
      const filter = { pad: want, slug: want === "" ? "none" : pv ? pv.slug : "", padTitle: pv ? pv.title : null, padUrl: pv ? pv.url : null, pads };
      const verified = me ? await isVerified(me) : false;
      res.render("raffles", {
        user: req.user ? req.user.username : null, me, L, status, filter, on: await enabled(), escrowLive: await escrowLive(), verified, admin: rafflesAdmin(me),
        cfg: config(), items: me ? await eligibleItems() : [], pick: await padlinks.choicesFor(req.user || null, req.query.pad || ""),
        idem: crypto.randomBytes(9).toString("hex"), msg: require("./notices").read(req),     // 1.99ade: ?m=<id>, never ?msg= text
      });
    } catch (e) { console.error("[raffles] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/raffles/:id", addUser, async (req, res) => {
    try {
      await init();
      try { await require("./padlinks").ready(); await require("./padaccess").init(); } catch (e) { /* see canSee */ }
      const me = await userRow(uid(req));
      const viewer = me ? { userId: me.userId, username: me.username } : null;
      const v = await detail(req.params.id, viewer);
      if (!v) {
        return res.status(404).render("notFound", { user: req.user ? req.user.username : null, heading: "No such raffle",
          message: "That raffle doesn't exist (or it's on a pad you can't see).", title: "Raffle not found" });
      }
      res.render("raffle", { user: req.user ? req.user.username : null, me, v, admin: rafflesAdmin(me), on: await enabled(), cfg: config(),
                             idem: crypto.randomBytes(9).toString("hex"), balance: me ? Number(me.points_balance) || 0 : null });
    } catch (e) { console.error("[raffles] detail:", e); res.status(500).send("Something went wrong."); }
  });

  if (!noTimers && !process.env.NODE_TEST_CONTEXT && !process.env.RAFFLES_NO_TIMER) {
    const iv = setInterval(() => { tick().catch((e) => console.error("[raffles] tick:", e.message)); }, 15000);
    if (iv.unref) iv.unref();
  }
}
module.exports = {
  init, register, enabled, enabledSync, setEnabled, config, setConfig, cleanConfig, create, buy, draw, maybeDraw, expire, cancel, takedown, edit, flushEditNotices, confirmDelivery,
  dispute, decide, tick, list, detail, adminState, forPad, cards, botAct, eventsAfter, verify, ticketsDigest, winningNumber, commitmentOf, feeShares, feeLegs, achMetrics,
  Refuse, DEFAULTS, FLOW, KINDS: [KIND_TICKET, KIND_PRIZE, KIND_ITEM], STATUSES,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setSettleChunk: (n) => { SETTLE_CHUNK = Math.max(1, Math.min(2000, Math.floor(n) || 2000)); },
};
