// heistmarket.js — 1.99tt: the 🥷 Heist market - players sell their heist items to each other for PAT (points), plus an
// optional pawn shop (the House buys an item back at a % of its shop price; OFF by default).
//
// WHERE THE ITEMS ARE. A heist item lives on its owner's heist sheet (Pepe's heist_data.json entry: `gear` = permanent gear,
// `items` = consumable charges). Pepe's engines play from that sheet in both modes of the GTF backend (gtfstore.js): his
// files are the truth while it is OFF, and a mirror he syncs to gtf_records while it is ON. So the site never edits a sheet
// for the market. It asks Pepe to, through a queue of keyed ops he applies to his copy and acks (the sync then carries the
// change to the site's records when the backend is on):
//   escrow  take N of an item OUT of a sheet into the market (a listing / a pawn) - refused if it isn't there
//   deliver put N of an item INTO a sheet (the buyer's, or back to the seller's) - refused if they already own that
//           permanent gear or would go past the item cap; then the item waits in the market for them ("held")
// An item on the market is out of the sheet: it can't be used in a heist or the arena, can't be listed twice, and gear is
// unequipped by being taken out (heist gear has no separate "equipped" state - owning it is wearing it).
//
// MONEY. A sale is ONE transaction here (dbUtils.tx): the listing flips active -> sold, the buyer pays the price (only if
// the balance covers it), the seller gets the price minus the fee, the fee goes where the PAT Routing row
// `heist_market_fee` says (Fort Knox by default; pool legs while the pools are live, else reserve claims Pepe settles) and
// the delivery op is queued. No PAT is created or destroyed: only the fee moves, from the buyer to a pool. A retry of the
// same click answers "already"; a second buyer gets "someone just bought it".
//
// LISTING STATES (heist_market_listings.status)
//   escrowing  waiting for Pepe to take the item out of the seller's sheet      -> active | void (it wasn't there)
//   active     for sale                                                         -> sold | returning (delisted)
//   sold       paid; waiting for Pepe to put it in the buyer's sheet            -> done | held
//   returning  delisted; waiting for Pepe to put it back in the seller's sheet  -> delisted | held
//   held       the delivery was refused (gear already owned / item cap): the item waits in the market for holder_id, who
//              can claim it again (-> claiming -> done / delisted / held) once there's room
//   pawning / pawned / void / done / delisted  (pawn: escrowing -> pawned, or returning when the House can't pay)
//
// Tables: heist_market_listings, heist_market_ops (key PK, Pepe's queue), heist_market_meta (the admin config).
// Records follow the ACCOUNT (seller_id / buyer_id / holder_id are userIds; accountMerge.js rules); an op's login is the
// account's Camfrog login when it was queued, re-keyed by loginrekey.js while it is open.
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery, tx } = require("./dbUtils");

const FLOW = "heist_market_fee";
const PAWN_FLOW = "heist_pawn";
const DEFAULTS = {
  fee_pct: 5,               // % of each sale, to the heist_market_fee routing row's destinations (Fort Knox)
  min_price: 1,
  max_price: 1000000000,    // a sane ceiling (1B points)
  list_per_hour: 10,        // new listings per account per hour
  open_max: 20,             // listings an account can have open at once
  announce_min: 250000,     // Pepe announces a sale at or above this price (rare relics always)
  untradable: [],           // item keys an admin took off the market
  pawn_on: false,           // the pawn shop (the House buys items back) - an economy decision, OFF until the user turns it on
  pawn_rate: 40,            // % of the item's shop price
  pawn_source: "heist",     // the pool that pays (the Casino vault - what the heist shop's purchases refill)
  pawn_values: {},          // admin-set values for items with no shop price (loot); none -> can't be pawned
};
const RARE = new Set(["kingpinring", "loadeddice", "mastermind", "fence", "blueprints"]);
const OPEN = ["escrowing", "active", "sold", "returning", "claiming", "held"];
const IDEM_RE = /^[A-Za-z0-9_.:-]{6,80}$/;

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
const now = () => Date.now();
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const S = () => require("./gtfsheet");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS heist_market_listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'sale', item TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
        price INTEGER NOT NULL, seller_id TEXT NOT NULL, seller_login TEXT, status TEXT NOT NULL, list_key TEXT UNIQUE,
        buyer_id TEXT, buyer_login TEXT, buy_key TEXT, sold_at INTEGER, fee INTEGER, net INTEGER, fee_legs TEXT,
        holder_id TEXT, holder_login TEXT, cancel INTEGER NOT NULL DEFAULT 0, deliveries INTEGER NOT NULL DEFAULT 0,
        note TEXT, via TEXT, created INTEGER NOT NULL, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS heist_market_listings_status ON heist_market_listings (status, item)");
      await runQuery("CREATE INDEX IF NOT EXISTS heist_market_listings_seller ON heist_market_listings (seller_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS heist_market_listings_sold ON heist_market_listings (item, sold_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS heist_market_ops (
        key TEXT PRIMARY KEY, listing_id INTEGER NOT NULL, op TEXT NOT NULL, login TEXT NOT NULL, user_id TEXT, item TEXT NOT NULL,
        qty INTEGER NOT NULL, announce TEXT, created INTEGER NOT NULL, done_at INTEGER, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS heist_market_ops_open ON heist_market_ops (done_at, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS heist_market_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── config ──
function cleanConfig(c) {
  const o = Object.assign({}, DEFAULTS, c || {});
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const out = {
    fee_pct: Math.round(clamp(o.fee_pct, 0, 50, DEFAULTS.fee_pct) * 100) / 100,
    min_price: Math.floor(clamp(o.min_price, 1, 1e12, 1)),
    max_price: Math.floor(clamp(o.max_price, 1, 1e12, DEFAULTS.max_price)),
    list_per_hour: Math.floor(clamp(o.list_per_hour, 1, 1000, DEFAULTS.list_per_hour)),
    open_max: Math.floor(clamp(o.open_max, 1, 1000, DEFAULTS.open_max)),
    announce_min: Math.floor(clamp(o.announce_min, 0, 1e12, DEFAULTS.announce_min)),
    untradable: (Array.isArray(o.untradable) ? o.untradable : []).map(String).filter((k) => /^[a-z0-9_]{1,30}$/.test(k)).slice(0, 100),
    pawn_on: o.pawn_on === true,
    pawn_rate: Math.round(clamp(o.pawn_rate, 1, 100, DEFAULTS.pawn_rate) * 100) / 100,
    pawn_source: /^[a-z][a-z0-9_]{0,31}$/.test(String(o.pawn_source)) && !["jackpot", "casino", "house", "burn"].includes(String(o.pawn_source))
      ? String(o.pawn_source) : DEFAULTS.pawn_source,
    pawn_values: {},
  };
  if (out.min_price > out.max_price) out.min_price = out.max_price;
  for (const [k, v] of Object.entries(o.pawn_values && typeof o.pawn_values === "object" ? o.pawn_values : {}).slice(0, 100)) {
    const n = Math.floor(Number(v));
    if (/^[a-z0-9_]{1,30}$/.test(k) && Number.isSafeInteger(n) && n > 0) out.pawn_values[k] = n;
  }
  return out;
}
async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM heist_market_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
const setMeta = (key, v) => runQuery("INSERT INTO heist_market_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                      [key, J(v)]);
async function config() { return cleanConfig(await meta("config")); }

/** An admin's change (only the keys given). -> the new config. */
async function setConfig(patch, admin) {
  const before = await config();
  const next = cleanConfig(Object.assign({}, before, patch || {}));
  await setMeta("config", next);
  if (admin) {
    try { await require("./adminaudit").record(admin, "heist_market_config", null, { before, after: next }); } catch (e) { /* audit is optional */ }
  }
  return next;
}

// ── the fee's routing (the PAT Routing table's row, source of truth: /admin/economy) ──
/** [[dest, pct], ...] - the admin's override of `heist_market_fee` (even an empty one = all to the Reserve), else Pepe's
 *  default from his routing catalog, else Fort Knox 100%. */
async function feeShares() {
  try {
    const st = await require("./econstore").getSettings();
    if (st && st.pat_routes && Array.isArray(st.pat_routes[FLOW])) return st.pat_routes[FLOW];
  } catch (e) { /* no econ store yet */ }
  try {
    const row = (await getQuery("SELECT data FROM econ_catalog WHERE id = 1"))[0];
    const d = parse(row && row.data, null);
    const def = d && d.routes && d.routes[FLOW] && d.routes[FLOW].default;
    if (Array.isArray(def) && def.length) return def;
  } catch (e) { /* no catalog yet */ }
  return [["fortknox", 100]];
}
/** amount by shares -> [[dest, amount]]; the rest to the Reserve (PAT is never burned). */
function splitShares(shares, amount) {
  const out = [];
  let used = 0;
  for (const sh of shares || []) {
    const d = String((sh || [])[0] || ""), p = Number((sh || [])[1]);
    if (!d || !(p > 0)) continue;
    const a = Math.floor(amount * p / 100);
    if (a > 0) { out.push([d, a]); used += a; }
  }
  const rest = amount - used;
  if (rest > 0) {
    const i = out.findIndex(([d]) => d === "reserve");
    if (i >= 0) out[i] = [out[i][0], out[i][1] + rest]; else out.push(["reserve", rest]);
  }
  return out;
}
/** INSIDE the open transaction: book `amount` of fee by the routing row. -> [[dest, amount]] as booked. */
async function bookFee(mk, amount, payerId) {
  if (!(amount > 0)) return [];
  const P = require("./pools");
  const live = await P.live();
  const split = splitShares(await feeShares(), amount);
  const legs = [], out = [];
  for (let i = 0; i < split.length; i++) {
    const [dest, a] = split[i];
    if (dest === "jackpot" || dest === "casino") {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [`${mk}-${i}`, `bot:route:${FLOW}`, payerId || null, a]);
      out.push(["jackpot", a]);
    } else if (live && P.isPool(dest) && dest !== "burn") {
      legs.push({ pool: dest, amount: a });
      out.push([dest, a]);
    } else {
      // the pools still in Pepe: a reserve claim he settles (negative = the site collected it), as boosts.js does
      const fk = dest === "fortknox" && require("./funding").fortknoxLive();
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [uuidv4(), fk ? `fortknox:${FLOW}` : FLOW, payerId || null, "heist market fee", -a]);
      out.push([fk ? "fortknox" : "reserve", a]);
    }
  }
  if (legs.length) {
    const a = await P._applyLegs(mk, legs, { kind: "charge", flow: FLOW, why: "heist-market-fee", via: "site" });
    await P._recordMove(mk, { kind: "charge", flow: FLOW, why: "heist-market-fee", via: "site", legs, net: a.net, ts: a.ts,
                              result: { ok: true, key: mk, balances: a.after } });
    await P._bumpRev();
  }
  return out;
}

// ── people, items, sheets ──
async function userRow(userId) {
  return (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [String(userId || "")]))[0] || null;
}
async function userByLogin(login) {
  const k = low(login);
  if (!k) return null;
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE LOWER(camfrogUsername) = ?
                          ORDER BY CASE WHEN camfrogUsername = ? THEN 0 ELSE 1 END LIMIT 1`, [k, String(login)]))[0] || null;
}
const isAdmin = (u) => !!u && u.class === "Admin";

/** Pepe's heist-shop catalog (gtfsheet: he pushes it) + what the market makes of each item. */
async function catalog() {
  const cat = await S().catalog();
  return { shop: cat.shop || {}, item_cap: int(cat.item_cap) || 10 };
}
function itemInfo(cat, cfg, key) {
  const it = cat.shop[key];
  if (!it) return null;
  const gear = it.kind === "gear";
  const tradable = (gear || it.kind === "item") && !cfg.untradable.includes(key);
  const shopPrice = it.buyable !== false && it.cost > 0 ? int(it.cost) : 0;
  const pawnValue = cfg.pawn_values[key] || shopPrice;
  return { key, name: it.name || key, emoji: it.emoji || "🎒", kind: it.kind, gear, tradable, shop_price: shopPrice, pawn_value: pawnValue,
           rare: RARE.has(key), desc: it.desc || "", art: S().artFor ? S().artFor(key) : null };
}
/** The item key for what someone typed: a key, or a name ("Kingpin's Ring"). */
function itemKey(cat, raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (cat.shop[s]) return s;
  const flat = s.replace(/[^a-z0-9]/g, "");
  for (const [k, it] of Object.entries(cat.shop)) {
    if (k.replace(/_/g, "") === flat || String(it.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === flat) return k;
  }
  return null;
}
/** What a login's sheet holds, as the site sees it (its records with the backend on, Pepe's display mirror off) - a
 *  pre-check only: Pepe's op is the final word. null = the site doesn't know (no sheet copy). */
async function holdings(login) {
  const src = await S().source(login).catch(() => null);
  if (!src || !src.sheet) return null;
  const sh = parse(src.sheet, null);
  if (!sh) return null;
  return { gear: new Set((sh.gear || []).map(String)), items: sh.items && typeof sh.items === "object" ? sh.items : {} };
}

// ── reads ──
async function listingRow(id) {
  return (await getQuery("SELECT * FROM heist_market_listings WHERE id = ?", [Math.floor(Number(id)) || 0]))[0] || null;
}
function shape(r, cat, cfg, names) {
  const it = itemInfo(cat, cfg, r.item) || { key: r.item, name: r.item, emoji: "🎒", gear: false };
  const nm = (id, login) => (names && names[id]) || login || "?";
  return { id: r.id, kind: r.kind, item: r.item, name: it.name, emoji: it.emoji, art: it.art || null, gear: !!it.gear, rare: !!it.rare,
           qty: r.qty, price: r.price, unit: Math.floor(r.price / Math.max(1, r.qty)), status: r.status, created: r.created, sold_at: r.sold_at || null,
           seller: nm(r.seller_id, r.seller_login), seller_login: r.seller_login, buyer: r.buyer_id ? nm(r.buyer_id, r.buyer_login) : null,
           fee: r.fee, net: r.net, note: r.note || null, holder_login: r.holder_login || null };
}
async function namesFor(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = {};
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    for (const u of await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part)) {
      out[u.userId] = u.displayname || u.camfrogUsername || u.username;
    }
  }
  return out;
}

/** The last sale prices per item (unit prices, newest first). -> {item: {last, avg, n, recent: [{unit, qty, at}]}} */
async function history(item, limit = 400) {
  await init();
  const rows = item
    ? await getQuery("SELECT item, qty, price, sold_at FROM heist_market_listings WHERE kind = 'sale' AND sold_at IS NOT NULL AND item = ? ORDER BY sold_at DESC LIMIT 20", [item])
    : await getQuery("SELECT item, qty, price, sold_at FROM heist_market_listings WHERE kind = 'sale' AND sold_at IS NOT NULL ORDER BY sold_at DESC LIMIT ?", [limit]);
  const out = {};
  for (const r of rows) {
    const h = out[r.item] || (out[r.item] = { recent: [] });
    if (h.recent.length < 5) h.recent.push({ unit: Math.floor(r.price / Math.max(1, r.qty)), qty: r.qty, at: r.sold_at });
  }
  for (const h of Object.values(out)) {
    h.last = h.recent[0].unit;
    h.n = h.recent.length;
    h.avg = Math.round(h.recent.reduce((t, x) => t + x.unit, 0) / h.n);
  }
  return out;
}

/** Everything the page / Pepe's browse needs. viewerId may be null. */
async function view(viewerId, { item = null, sort = "newest" } = {}) {
  await init();
  const [cat, cfg] = await Promise.all([catalog(), config()]);
  const order = sort === "price" ? "price * 1.0 / qty ASC, id DESC" : sort === "price_desc" ? "price * 1.0 / qty DESC, id DESC" : "id DESC";
  const rows = item
    ? await getQuery(`SELECT * FROM heist_market_listings WHERE status = 'active' AND kind = 'sale' AND item = ? ORDER BY ${order} LIMIT 300`, [item])
    : await getQuery(`SELECT * FROM heist_market_listings WHERE status = 'active' AND kind = 'sale' ORDER BY ${order} LIMIT 300`);
  let mine = [], me = null, sellable = [];
  if (viewerId) {
    me = await userRow(viewerId);
    mine = await getQuery(`SELECT * FROM heist_market_listings WHERE (seller_id = ? AND (status IN (${OPEN.map(() => "?").join(",")}) OR updated > ?))
                           OR (holder_id = ? AND status IN ('held', 'claiming')) ORDER BY id DESC LIMIT 60`,
                          [viewerId, ...OPEN, now() - 7 * 86400e3, viewerId]);
    if (me && me.camfrogUsername) sellable = await sellableFor(viewerId, low(me.camfrogUsername), cat, cfg);
  }
  const names = await namesFor([...rows, ...mine].flatMap((r) => [r.seller_id, r.buyer_id]));
  const hist = await history(null);
  const items = {};
  for (const k of Object.keys(cat.shop)) { const i = itemInfo(cat, cfg, k); if (i && i.tradable) items[k] = i; }
  return {
    listings: rows.map((r) => shape(r, cat, cfg, names)), mine: mine.map((r) => Object.assign(shape(r, cat, cfg, names), { mine: r.seller_id === viewerId, holder: r.holder_id === viewerId })),
    history: hist, items, sellable, linked: !!(me && me.camfrogUsername), login: me && me.camfrogUsername ? low(me.camfrogUsername) : null,
    admin: isAdmin(me), config: { fee_pct: cfg.fee_pct, min_price: cfg.min_price, max_price: cfg.max_price, pawn_on: cfg.pawn_on, pawn_rate: cfg.pawn_rate,
                                   item_cap: cat.item_cap },
  };
}
/** The viewer's sheet items the market takes (minus what's already on its way out), with their pawn quote. */
async function sellableFor(userId, login, cat, cfg) {
  const h = await holdings(login);
  if (!h) return [];
  const out = [];
  const pend = {};
  for (const r of await getQuery("SELECT item, qty FROM heist_market_listings WHERE seller_id = ? AND status = 'escrowing'", [userId])) pend[r.item] = (pend[r.item] || 0) + r.qty;
  for (const k of h.gear) {
    const i = itemInfo(cat, cfg, k);
    if (i && i.tradable && !pend[k]) out.push(Object.assign({}, i, { n: 1, pawn: cfg.pawn_on && i.pawn_value ? Math.floor(i.pawn_value * cfg.pawn_rate / 100) : 0 }));
  }
  for (const [k, n0] of Object.entries(h.items)) {
    const i = itemInfo(cat, cfg, k);
    const n = int(n0) - (pend[k] || 0);
    if (i && i.tradable && n > 0) out.push(Object.assign({}, i, { n, pawn: cfg.pawn_on && i.pawn_value ? Math.floor(i.pawn_value * cfg.pawn_rate / 100) : 0 }));
  }
  return out.sort((a, b) => (b.rare - a.rare) || (b.shop_price - a.shop_price) || a.name.localeCompare(b.name));
}

// ── the queue Pepe applies ──
async function queueOp(listing, op, login, userId, announce) {
  const n = (await getQuery("SELECT deliveries FROM heist_market_listings WHERE id = ?", [listing.id]))[0];
  const seq = op === "escrow" ? 0 : (int(n && n.deliveries) + 1);
  const key = op === "escrow" ? `hm:esc:${listing.id}` : `hm:dlv:${listing.id}:${seq}`;
  if (op !== "escrow") await runQuery("UPDATE heist_market_listings SET deliveries = ? WHERE id = ?", [seq, listing.id]);
  await runQuery(`INSERT INTO heist_market_ops (key, listing_id, op, login, user_id, item, qty, announce, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [key, listing.id, op, low(login), userId || null, listing.item, listing.qty, announce ? J(announce) : null, now()]);
  return key;
}
/** The login a delivery goes to: the account's Camfrog login TODAY (records follow the account). */
async function loginOf(userId, fallback) {
  const u = await userRow(userId);
  return u && u.camfrogUsername ? low(u.camfrogUsername) : low(fallback);
}
/** Inside a transaction: send a listing's item back toward `toId` (its seller, or its holder). */
async function sendBack(L, toId, toLogin, status, note) {
  const login = await loginOf(toId, toLogin);
  await runQuery("UPDATE heist_market_listings SET status = ?, holder_id = ?, holder_login = ?, note = ?, updated = ? WHERE id = ?",
                 [status, toId, login, note || null, now(), L.id]);
  await queueOp(L, "deliver", login, toId, null);
}

async function openOps(limit = 100) {
  await init();
  const rows = await getQuery("SELECT * FROM heist_market_ops WHERE done_at IS NULL ORDER BY created, key LIMIT ?", [Math.max(1, Math.min(500, int(limit) || 100))]);
  return rows.map((r) => ({ key: r.key, op: r.op, login: r.login, item: r.item, qty: r.qty, listing: r.listing_id, announce: parse(r.announce, null), created: r.created }));
}

const RESULTS = new Set(["ok", "missing", "owned", "full", "no_sheet", "untradable"]);
/**
 * Pepe applied (or refused) these ops: [{key, result}] -> the listings move on. Each op once (a repeated ack changes
 * nothing). -> {acked, results: {key: status}}
 */
async function ack(list) {
  await init();
  const out = {};
  let n = 0;
  for (const a of (Array.isArray(list) ? list : []).slice(0, 200)) {
    const key = String((a && a.key) || "");
    const result = RESULTS.has(String(a && a.result)) ? String(a.result) : "missing";
    const r = await tx(async () => {
      const op = (await getQuery("SELECT * FROM heist_market_ops WHERE key = ?", [key]))[0];
      if (!op || op.done_at) return null;
      await runQuery("UPDATE heist_market_ops SET done_at = ?, result = ? WHERE key = ? AND done_at IS NULL", [now(), result, key]);
      const L = await listingRow(op.listing_id);
      if (!L) return "gone";
      if (op.op === "escrow") {
        if (L.status !== "escrowing") return L.status;
        if (result !== "ok") {
          await runQuery("UPDATE heist_market_listings SET status = 'void', note = ?, updated = ? WHERE id = ?", [result, now(), L.id]);
          return "void";
        }
        if (L.cancel) { await sendBack(L, L.seller_id, L.seller_login, "returning", "delisted"); return "returning"; }
        if (L.kind === "pawn") return pawnPay(L);
        await runQuery("UPDATE heist_market_listings SET status = 'active', updated = ? WHERE id = ?", [now(), L.id]);
        return "active";
      }
      // a delivery
      if (!["sold", "returning", "claiming"].includes(L.status)) return L.status;
      if (result === "ok") {
        const st = L.buyer_id && L.holder_id === L.buyer_id ? "done" : "delisted";
        await runQuery("UPDATE heist_market_listings SET status = ?, note = NULL, updated = ? WHERE id = ?", [st, now(), L.id]);
        return st;
      }
      await runQuery("UPDATE heist_market_listings SET status = 'held', note = ?, updated = ? WHERE id = ?", [result, now(), L.id]);
      return "held";
    });
    if (r) { out[key] = r; n++; }
  }
  return { acked: n, results: out };
}

// ── listing ──
function cleanIdem(idem) {
  const s = String(idem || "");
  if (!IDEM_RE.test(s)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return s;
}
function cleanPrice(v, cfg) {
  const m = String(v == null ? "" : v).trim().toLowerCase().replace(/[, _]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  const p = m ? Math.floor(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : NaN;
  if (!Number.isSafeInteger(p) || p < cfg.min_price || p > cfg.max_price) {
    throw new Refuse(400, `Set a price from ${fmt(cfg.min_price)} to ${fmt(cfg.max_price)} PAT.`, "E_PRICE");
  }
  return p;
}
async function needLinked(userId) {
  const u = await userRow(userId);
  if (!u) throw new Refuse(401, "Sign in first.", "E_AUTH");
  if (!u.camfrogUsername) throw new Refuse(409, "Link your Camfrog name first (type !verify in a Camfrog room) - heist items live on its sheet.", "E_NOT_LINKED");
  return u;
}

/** Put an item up for sale. -> {ok, listing, already?} (status escrowing until Pepe takes it out of the sheet) */
async function list(userId, { item, qty, price, idem, via = "web" } = {}) {
  await init();
  const key = cleanIdem(idem);
  const lk = `hl:${userId}:${key}`;
  const [cat, cfg] = await Promise.all([catalog(), config()]);
  const dup = (await getQuery("SELECT * FROM heist_market_listings WHERE list_key = ?", [lk]))[0];
  if (dup) return { ok: true, already: true, listing: shape(dup, cat, cfg) };
  const u = await needLinked(userId);
  const login = low(u.camfrogUsername);
  const k = itemKey(cat, item);
  const it = k && itemInfo(cat, cfg, k);
  if (!it) throw new Refuse(404, "That isn't a heist item.", "E_ITEM");
  if (!it.tradable) throw new Refuse(409, `${it.name} can't be traded.`, "E_UNTRADABLE");
  const q = it.gear ? 1 : int(qty || 1);
  if (q < 1 || q > cat.item_cap) throw new Refuse(400, `Sell 1 to ${cat.item_cap} at a time.`, "E_QTY");
  const p = cleanPrice(price, cfg);
  const hour = (await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings WHERE seller_id = ? AND created > ?", [userId, now() - 3600e3]))[0].n;
  if (hour >= cfg.list_per_hour) throw new Refuse(429, `That's ${cfg.list_per_hour} listings this hour - try again later.`, "E_RATE");
  const open = (await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings WHERE seller_id = ? AND status IN ('escrowing', 'active')", [userId]))[0].n;
  if (open >= cfg.open_max) throw new Refuse(409, `You already have ${cfg.open_max} listings up - delist one first.`, "E_OPEN_MAX");
  if (it.gear && (await getQuery("SELECT 1 FROM heist_market_listings WHERE seller_id = ? AND item = ? AND status IN ('escrowing', 'active')", [userId, k])).length) {
    throw new Refuse(409, `Your ${it.name} is already on the market.`, "E_LISTED");
  }
  const h = await holdings(login);
  if (h) {
    const pend = (await getQuery("SELECT COALESCE(SUM(qty), 0) AS n FROM heist_market_listings WHERE seller_id = ? AND item = ? AND status = 'escrowing'", [userId, k]))[0].n;
    const have = it.gear ? (h.gear.has(k) ? 1 : 0) : int(h.items[k]);
    if (have - pend < q) throw new Refuse(409, have - pend > 0 ? `You only have ${have - pend} ${it.name} to sell.` : `You don't have a ${it.name}.`, "E_MISSING");
  }
  const L = await tx(async () => {
    const again = (await getQuery("SELECT * FROM heist_market_listings WHERE list_key = ?", [lk]))[0];
    if (again) return again;
    const t = now();
    const r = await runQuery(`INSERT INTO heist_market_listings (kind, item, qty, price, seller_id, seller_login, status, list_key, holder_id, holder_login, via, created, updated)
                              VALUES ('sale', ?, ?, ?, ?, ?, 'escrowing', ?, ?, ?, ?, ?, ?)`, [k, q, p, userId, login, lk, userId, login, String(via).slice(0, 10), t, t]);
    const row = await listingRow(r.id);
    await queueOp(row, "escrow", login, userId, null);
    return row;
  });
  return { ok: true, listing: shape(L, cat, cfg) };
}

/** Take a listing down (the seller, or an admin). An escrowing one is taken down as soon as Pepe has the item. */
async function delist(userId, id, { admin = false, reason = null } = {}) {
  await init();
  const u = await userRow(userId);
  if (!u) throw new Refuse(401, "Sign in first.", "E_AUTH");
  const asAdmin = admin && isAdmin(u);
  const out = await tx(async () => {
    const L = await listingRow(id);
    if (!L || L.kind !== "sale") throw new Refuse(404, "No such listing.", "E_NOT_FOUND");
    if (L.seller_id !== userId && !asAdmin) throw new Refuse(403, "That isn't your listing.", "E_NOT_YOURS");
    if (L.status === "escrowing") {
      await runQuery("UPDATE heist_market_listings SET cancel = 1, updated = ? WHERE id = ?", [now(), L.id]);
      return { status: "escrowing", cancel: true };
    }
    if (L.status !== "active") throw new Refuse(409, L.status === "sold" || L.status === "done" ? "That one already sold." : "That listing isn't up any more.", "E_NOT_ACTIVE");
    await sendBack(L, L.seller_id, L.seller_login, "returning", asAdmin && L.seller_id !== userId ? `admin: ${String(reason || "delisted").slice(0, 120)}` : "delisted");
    return { status: "returning" };
  });
  if (asAdmin && out.status) {
    try { await require("./adminaudit").record(u, "heist_market_delist", null, { id: Number(id) }, reason ? String(reason) : null); } catch (e) { /* optional */ }
  }
  return Object.assign({ ok: true, id: Number(id) }, out);
}

/** A held item (its delivery was refused) - try the delivery again. */
async function claim(userId, id) {
  await init();
  return tx(async () => {
    const L = await listingRow(id);
    if (!L) throw new Refuse(404, "No such listing.", "E_NOT_FOUND");
    if (L.holder_id !== userId) throw new Refuse(403, "That item isn't waiting for you.", "E_NOT_YOURS");
    if (L.status === "claiming") return { ok: true, already: true, status: "claiming" };
    if (L.status !== "held") throw new Refuse(409, "That item isn't waiting in the market.", "E_NOT_HELD");
    await sendBack(L, userId, L.holder_login, "claiming", null);
    return { ok: true, status: "claiming" };
  });
}

/** Buy a listing. ONE transaction: buyer pays, seller gets the price minus the fee, the fee is routed, the item is the
 *  buyer's (its delivery to their sheet is queued). -> {ok, listing, fee, net, already?} */
async function buy(userId, { id, idem, via = "web" } = {}) {
  await init();
  cleanIdem(idem);
  const [cat, cfg] = await Promise.all([catalog(), config()]);
  const u = await needLinked(userId);
  const login = low(u.camfrogUsername);
  const L0 = await listingRow(id);
  if (!L0 || L0.kind !== "sale") throw new Refuse(404, "No such listing.", "E_NOT_FOUND");
  if (L0.buyer_id === userId && ["sold", "done", "held", "claiming"].includes(L0.status)) return { ok: true, already: true, listing: shape(L0, cat, cfg) };
  if (L0.status !== "active") throw new Refuse(409, "That listing isn't for sale any more.", "E_NOT_ACTIVE");
  if (L0.seller_id === userId || low(L0.seller_login) === login) throw new Refuse(409, "That's your own listing.", "E_SELF");
  const alts = await require("./engagement").altPairs([userId, L0.seller_id]).catch(() => new Set());
  if (alts.has(userId + "|" + L0.seller_id)) throw new Refuse(409, "Sales between linked accounts aren't allowed.", "E_ALT");
  const it = itemInfo(cat, cfg, L0.item) || { name: L0.item, gear: false };
  // the buyer's sheet: permanent gear is one per player; consumables stop at the item cap
  const h = await holdings(login);
  const incoming = (await getQuery(`SELECT COALESCE(SUM(qty), 0) AS n FROM heist_market_listings WHERE holder_id = ? AND item = ? AND status IN ('sold', 'claiming', 'held')`,
                                   [userId, L0.item]))[0].n;
  if (it.gear) {
    if ((h && h.gear.has(L0.item)) || incoming > 0) throw new Refuse(409, `You already own ${it.name} - it's one per player.`, "E_OWNED");
  } else if (h && int(h.items[L0.item]) + incoming + L0.qty > cat.item_cap) {
    throw new Refuse(409, `That would take you past ${cat.item_cap} ${it.name} - use some first.`, "E_FULL");
  }
  const seller = await userRow(L0.seller_id);
  const fee = Math.floor(L0.price * cfg.fee_pct / 100);
  const net = L0.price - fee;
  const announce = it.rare || L0.price >= cfg.announce_min
    ? { item: L0.item, name: it.name, emoji: it.emoji, qty: L0.qty, price: L0.price, seller: L0.seller_login, buyer: login } : null;
  const res = await tx(async () => {
    const L = await listingRow(id);
    if (L.buyer_id === userId && L.status !== "active") return { already: true, L };
    const up = await runQuery(`UPDATE heist_market_listings SET status = 'sold', buyer_id = ?, buyer_login = ?, holder_id = ?, holder_login = ?, sold_at = ?,
                               fee = ?, net = ?, buy_key = ?, updated = ? WHERE id = ? AND status = 'active'`,
                              [userId, login, userId, login, now(), fee, net, `hb:${userId}:${String(idem).slice(0, 80)}`, now(), L.id]);
    if (!up || up.changes !== 1) throw new Refuse(409, "Someone else just bought it.", "E_NOT_ACTIVE");
    const ledger = require("./ledger");
    const d = await ledger.post(userId, -L.price, "heist-market-buy", { requireCover: true, counterparty: seller ? seller.username : undefined, source: "gtf/market" });
    if (!d.ok) {
      throw d.code === ledger.E_INSUFFICIENT ? new Refuse(402, `That costs ${fmt(L.price)} PAT - you don't have enough.`, "E_INSUFFICIENT_PAT")
        : new Refuse(404, "Couldn't find your account.", "E_TARGET_NOT_FOUND");
    }
    if (net > 0) {
      const c = await ledger.post(L.seller_id, net, "heist-market-sale", { resolveMerged: true, counterparty: u.username, source: "gtf/market" });
      if (!c.ok) throw new Refuse(409, "The seller's account is gone - nothing was charged.", "E_SELLER_GONE");
    }
    const legs = await bookFee(`hm:fee:${L.id}`, fee, userId);
    await runQuery("UPDATE heist_market_listings SET fee_legs = ? WHERE id = ?", [J(legs), L.id]);
    await queueOp(L, "deliver", login, userId, announce);
    return { L: await listingRow(L.id), legs };
  });
  if (!res.already) awardSeller(L0.seller_id, L0.item).catch(() => {});
  return { ok: true, already: !!res.already, listing: shape(res.L, cat, cfg), fee: res.L.fee, net: res.L.net, fee_legs: res.legs || parse(res.L.fee_legs, []) };
}

// 🏅 the seller's market achievements (cf_hm_sale_1 "First Sale", cf_hm_ring "Fence"): counts from the sales table, awarded
// through achievements.awardCount like the casino backend's (metrics hm_sales / hm_ring_sales)
async function awardSeller(sellerId, item) {
  const A = require("./achievements");
  const n = (await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings WHERE seller_id = ? AND kind = 'sale' AND sold_at IS NOT NULL", [sellerId]))[0].n;
  await A.awardCount(sellerId, "hm_sales", n);
  if (item === "kingpinring") {
    const r = (await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings WHERE seller_id = ? AND kind = 'sale' AND item = 'kingpinring' AND sold_at IS NOT NULL", [sellerId]))[0].n;
    await A.awardCount(sellerId, "hm_ring_sales", r);
  }
}

// ── the pawn shop (OFF by default) ──
/** A quote: what the House pays for `qty` of an item right now, or why it won't. */
async function pawnQuote(item, qty) {
  const [cat, cfg] = await Promise.all([catalog(), config()]);
  const k = itemKey(cat, item);
  const it = k && itemInfo(cat, cfg, k);
  if (!it) throw new Refuse(404, "That isn't a heist item.", "E_ITEM");
  if (!cfg.pawn_on) throw new Refuse(409, "The pawn shop is closed.", "E_PAWN_OFF");
  if (!it.tradable) throw new Refuse(409, `${it.name} can't be traded.`, "E_UNTRADABLE");
  if (!it.pawn_value) throw new Refuse(409, `The pawn shop doesn't take ${it.name} - it has no shop price.`, "E_NO_VALUE");
  const q = it.gear ? 1 : int(qty || 1);
  if (q < 1 || q > cat.item_cap) throw new Refuse(400, `Pawn 1 to ${cat.item_cap} at a time.`, "E_QTY");
  return { it, q, pay: Math.floor(it.pawn_value * q * cfg.pawn_rate / 100), cfg, cat };
}
/** Sell an item to the House (pool -> wallet once Pepe has taken the item out of the sheet). */
async function pawn(userId, { item, qty, idem, via = "web" } = {}) {
  await init();
  const key = cleanIdem(idem);
  const lk = `hp:${userId}:${key}`;
  const dup = (await getQuery("SELECT * FROM heist_market_listings WHERE list_key = ?", [lk]))[0];
  const [cat0, cfg0] = await Promise.all([catalog(), config()]);
  if (dup) return { ok: true, already: true, listing: shape(dup, cat0, cfg0) };
  const u = await needLinked(userId);
  const login = low(u.camfrogUsername);
  const { it, q, pay, cfg, cat } = await pawnQuote(item, qty);
  if (!(pay > 0)) throw new Refuse(409, "That's worth nothing at the pawn shop.", "E_NO_VALUE");
  const P = require("./pools");
  if (!(await P.live())) throw new Refuse(409, "The pawn shop needs the pools on the site.", "E_POOLS");
  if ((await P.balance(cfg.pawn_source)) < pay) throw new Refuse(409, "The House can't cover that right now.", "E_HOUSE_SHORT");
  const h = await holdings(login);
  if (h) {
    const pend = (await getQuery("SELECT COALESCE(SUM(qty), 0) AS n FROM heist_market_listings WHERE seller_id = ? AND item = ? AND status = 'escrowing'", [userId, it.key]))[0].n;
    const have = it.gear ? (h.gear.has(it.key) ? 1 : 0) : int(h.items[it.key]);
    if (have - pend < q) throw new Refuse(409, `You don't have ${q > 1 ? q + " " : "a "}${it.name} to pawn.`, "E_MISSING");
  }
  const hour = (await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings WHERE seller_id = ? AND created > ?", [userId, now() - 3600e3]))[0].n;
  if (hour >= cfg.list_per_hour) throw new Refuse(429, `That's ${cfg.list_per_hour} market moves this hour - try again later.`, "E_RATE");
  const L = await tx(async () => {
    const again = (await getQuery("SELECT * FROM heist_market_listings WHERE list_key = ?", [lk]))[0];
    if (again) return again;
    const t = now();
    const r = await runQuery(`INSERT INTO heist_market_listings (kind, item, qty, price, seller_id, seller_login, status, list_key, holder_id, holder_login, via, note, created, updated)
                              VALUES ('pawn', ?, ?, ?, ?, ?, 'escrowing', ?, ?, ?, ?, ?, ?, ?)`,
                             [it.key, q, pay, userId, login, lk, userId, login, String(via).slice(0, 10), J({ source: cfg.pawn_source, rate: cfg.pawn_rate }), t, t]);
    const row = await listingRow(r.id);
    await queueOp(row, "escrow", login, userId, null);
    return row;
  });
  return { ok: true, listing: shape(L, cat, cfg), pay };
}
/** Inside ack's transaction: the House pays for a pawned item (a savepoint: a short pool sends the item back). */
async function pawnPay(L) {
  const P = require("./pools");
  const n = parse(L.note, {}) || {};
  const src = n.source || DEFAULTS.pawn_source;
  const mk = `hm:pawn:${L.id}`;
  try {
    await tx(async () => {
      if (!(await P.live())) throw new P.Refuse(409, "pools not live", "E_NOT_LIVE");
      const legs = [{ pool: src, amount: -L.price }];
      const a = await P._applyLegs(mk, legs, { kind: "fund", flow: PAWN_FLOW, why: "heist-pawn", via: "site" });
      const c = await require("./ledger").post(L.seller_id, L.price, "heist-pawn", { resolveMerged: true, source: `pool:${src}` });
      if (!c.ok) throw new Refuse(404, "seller gone", "E_TARGET_NOT_FOUND");
      await P._recordMove(mk, { kind: "fund", flow: PAWN_FLOW, why: "heist-pawn", via: "site", legs, net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } });
      await P._bumpRev();
      await runQuery("UPDATE heist_market_listings SET status = 'pawned', holder_id = NULL, holder_login = 'house', sold_at = ?, net = ?, fee = 0, updated = ? WHERE id = ?",
                     [now(), L.price, now(), L.id]);
    });
    return "pawned";
  } catch (e) {
    await sendBack(L, L.seller_id, L.seller_login, "returning", e.code === "E_INSUFFICIENT" ? "the House couldn't cover it" : "pawn refused");
    return "returning";
  }
}

// ── Pepe's chat commands (!sell / !buyitem / !delist / !heistmarket / !pawn) as the account linked to a login ──
async function botAct(b) {
  await init();
  const u = await userByLogin(b.login);
  const op = String(b.op || "");
  if (op === "browse" || op === "history") {
    const cat = await catalog();
    const item = b.item ? itemKey(cat, b.item) : null;
    if (b.item && !item) throw new Refuse(404, "That isn't a heist item.", "E_ITEM");
    if (op === "history") return { ok: true, item, history: (await history(item))[item] || null };
    const v = await view(u ? u.userId : null, { item, sort: "price" });
    return { ok: true, item, listings: v.listings.slice(0, 8), total: v.listings.length, history: item ? v.history[item] || null : null, config: v.config };
  }
  if (!u) throw new Refuse(409, "Link your Camfrog name to a publicaccess.tv account first (!verify).", "E_NOT_LINKED");
  if (op === "mine") {
    const v = await view(u.userId);
    return { ok: true, mine: v.mine.filter((m) => OPEN.includes(m.status)).slice(0, 10), config: v.config };
  }
  if (op === "list") return list(u.userId, { item: b.item, qty: b.qty, price: b.price, idem: b.key, via: "chat" });
  if (op === "buy") return buy(u.userId, { id: b.id, idem: b.key, via: "chat" });
  if (op === "delist") return delist(u.userId, b.id, {});
  if (op === "claim") return claim(u.userId, b.id);
  if (op === "pawn") return pawn(u.userId, { item: b.item, qty: b.qty, idem: b.key, via: "chat" });
  if (op === "quote") { const q = await pawnQuote(b.item, b.qty); return { ok: true, item: q.it.key, name: q.it.name, qty: q.q, pay: q.pay }; }
  throw new Refuse(400, "Unknown market action.", "E_OP");
}

async function adminView() {
  await init();
  const [cfg, cat] = await Promise.all([config(), catalog()]);
  const counts = {};
  for (const r of await getQuery("SELECT status, COUNT(*) AS n FROM heist_market_listings GROUP BY status")) counts[r.status] = r.n;
  const open = (await getQuery("SELECT COUNT(*) AS n, MIN(created) AS oldest FROM heist_market_ops WHERE done_at IS NULL"))[0];
  const fees = (await getQuery("SELECT COALESCE(SUM(fee), 0) AS f, COALESCE(SUM(price), 0) AS v, COUNT(*) AS n FROM heist_market_listings WHERE kind = 'sale' AND sold_at IS NOT NULL"))[0];
  const items = Object.keys(cat.shop).map((k) => itemInfo(cat, cfg, k)).filter((i) => i && (i.gear || i.kind === "item"));
  return { config: cfg, defaults: DEFAULTS, counts, open_ops: open.n, oldest_op: open.oldest, sales: { n: fees.n, volume: fees.v, fees: fees.f },
           fee_shares: await feeShares(), items };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[heistmarket] init:", e.message));
  const answer = (res, e, tag) => {
    if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    if (e && e.code === "E_INSUFFICIENT") return res.status(409).json({ ok: false, error: e.message, code: e.code });
    console.error(`[heistmarket] ${tag}:`, e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) { answer(res, e, "bot"); }
  };
  // Pepe: his queue, his acks, and the chat commands (POST so the staging router can fall back to his sandbox)
  app.post("/api/gtf/bot/market/ops", bot(async (b) => ({ ok: true, ops: await openOps(b.limit) })));
  app.post("/api/gtf/bot/market/ack", bot(async (b) => Object.assign({ ok: true }, await ack(b.results))));
  app.post("/api/gtf/bot/market/act", bot((b) => botAct(b)));

  const uid = (req) => (req.user && req.user.userId) || null;
  const web = (fn) => async (req, res) => {
    if (!uid(req)) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { res.json(await fn(uid(req), req.body || {})); } catch (e) { answer(res, e, "web"); }
  };
  app.get("/gtf/market", addUser, async (req, res) => {
    try {
      const sort = ["price", "price_desc", "newest"].includes(String(req.query.sort)) ? String(req.query.sort) : "newest";
      const v = await view(uid(req), { sort });
      const adm = v.admin ? await adminView() : null;
      res.render("heistmarket", { user: req.user ? req.user.username : null, v, adm, sort, signedIn: !!uid(req) });
    } catch (e) { console.error("[heistmarket] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/gtf/market", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(Object.assign({ ok: true }, await view(uid(req), { sort: String(req.query.sort || "newest") }))); } catch (e) { answer(res, e, "api"); }
  });
  app.post("/api/gtf/market/list", addUser, web((u, b) => list(u, { item: b.item, qty: b.qty, price: b.price, idem: b.idem, via: "web" })));
  app.post("/api/gtf/market/buy", addUser, web((u, b) => buy(u, { id: b.id, idem: b.idem, via: "web" })));
  app.post("/api/gtf/market/delist", addUser, web((u, b) => delist(u, b.id, {})));
  app.post("/api/gtf/market/claim", addUser, web((u, b) => claim(u, b.id)));
  app.post("/api/gtf/market/pawn", addUser, web((u, b) => pawn(u, { item: b.item, qty: b.qty, idem: b.idem, via: "web" })));
  // admins: the config (fee %, limits, the pawn shop) and taking a listing down
  const adminOnly = (fn) => web(async (u, b) => {
    const a = await userRow(u);
    if (!isAdmin(a)) throw new Refuse(403, "Admins only.", "E_ADMIN");
    return fn(a, b);
  });
  app.post("/api/admin/heist-market", addUser, adminOnly(async (a, b) => ({ ok: true, config: await setConfig(b.config || {}, a), view: await adminView() })));
  app.post("/api/admin/heist-market/delist", addUser, adminOnly((a, b) => delist(a.userId, b.id, { admin: true, reason: b.reason })));
}

module.exports = { init, register, config, setConfig, cleanConfig, feeShares, splitShares, bookFee, list, delist, claim, buy, pawn, pawnQuote, ack, openOps,
                   history, view, adminView, botAct, holdings, catalog, itemInfo, itemKey, Refuse, DEFAULTS, FLOW, RARE };
