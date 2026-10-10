// shop.js — the PATV shop: the official prize store plus a multi-seller marketplace.
//
// One purchase path (purchasePrize) for every storefront: the website (/shop), the Discord bot
// (/chatshop) and Pepe in Camfrog (/api/shop/camfrog/buy).
//
//  * OFFICIAL items (prizes.seller_id IS NULL) behave exactly as they always have: the buyer pays,
//    the PAT goes to the store owner's account (STORE_OWNER_USERNAME, default "pb"), role prizes
//    and the spin boost take effect at once. Each one is also recorded as a COMPLETED order.
//    Exception (1.99fj): "+100 Daily Gold Spins" (spinboost100) is priced per buyer - 3M for the
//    first copy, +1M for every copy they already own (spinboostPrice) - always computed here, never
//    taken from the client, and its PAT goes to the House (a jackpot_rakes row, like wheel wagers),
//    not to the store owner. The buyer's debit equals the House credit exactly.
//  * USER listings (seller_id = a user) are escrowed orders: the buyer is charged at once and the
//    order is "paid"; the seller fulfils it (a note/code for the buyer) and is credited the price
//    minus the shop fee right then, with the fee going to Pepe's Federal Reserve as a NEGATIVE
//    reserve_claims row (flow "shop_fee"). The buyer confirms receipt, or the order completes by
//    itself after auto_complete_days. Before fulfilment the seller can refund and the buyer can
//    cancel (full price back, stock restored); an unfulfilled order is refunded automatically
//    after auto_cancel_days. A buyer can open a dispute before completion and an admin resolves
//    it: pay the seller, or refund the buyer (if the seller was already paid, the net is clawed
//    back from the seller and the fee comes back out of the Reserve as a positive claim).
//
// Every money move runs in one SQLite transaction, serialised with every other shop transaction
// (one shared connection: a second BEGIN while one is open fails), and every status change is a
// conditional UPDATE ... WHERE status = <expected>, so a double click / two tabs / a retried
// request can never move the money twice.
//
// Notifications (email + a Camfrog PM through Pepe's action queue, kind "notify") go out after
// the transaction commits and never fail an order.
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const actions = require("./actions");
const inbox = require("./inbox");

const STORE_OWNER_USERNAME = process.env.STORE_OWNER_USERNAME || "pb";

// "+100 Daily Gold Spins" (1.99fj): escalating per-buyer price, proceeds to the House.
const SPINBOOST_ID = "spinboost100";
const SPINBOOST_SPINS = 100;          // extra daily gold spins per copy (users.extra_daily_spins)
const SPINBOOST_BASE = 3000000;       // the first copy
const SPINBOOST_STEP = 1000000;       // + this for every copy the buyer already owns (3M, 4M, 5M, ...)
const spinboostOwned = (extraDailySpins) => Math.max(0, Math.floor((Number(extraDailySpins) || 0) / SPINBOOST_SPINS));
const spinboostPrice = (owned) => SPINBOOST_BASE + SPINBOOST_STEP * Math.max(0, Math.floor(Number(owned) || 0));
const isSpinboost = (prize) => !!prize && prize.prizeId === SPINBOOST_ID && !prize.seller_id;
const SITE = String(process.env.PUBLIC_BASE_URL || "https://publicaccess.tv").replace(/\/+$/, "");
const MAIL_FROM = process.env.SHOP_FROM_EMAIL || "no-reply@publicaccess.tv";

// Prizes that are a ROLE (role names as they are in Discord). Owning one is recorded in
// user_roles; a second purchase of a role you already have is refused.
const ROLE_PRIZES = {
  "147ce895-37c2-4c43-98cc-9f7045de0cf3": "scout",
  "c0e57e08-6696-4c51-94ec-485f13a68cd8": "curator",
  "491cde2e-097e-4c2a-a351-ce441137ba38": "high roller",
};

const DEFAULT_CATEGORIES = ["Gift cards", "Digital", "Services", "Art & commissions", "Collectibles", "Discord perks", "Other"];
const DEFAULTS = {
  fee_pct: 10,              // % of each user-listing sale that goes to the Federal Reserve
  require_approval: 1,      // new listings from non-staff wait for review
  min_level: 5,             // level needed to list items (staff exempt)
  auto_complete_days: 7,    // fulfilled -> completed if the buyer doesn't confirm or dispute
  auto_cancel_days: 14,     // paid but never fulfilled -> refunded to the buyer (0 = never)
  categories: DEFAULT_CATEGORIES,
};
const PAGE_SIZE = 24;
const MAX_LISTINGS = 50;    // non-removed listings per seller
const PRICE_MAX = 1000000000;
const STOCK_MAX = 10000;
const DAY = 86400000;

const STATUS = {
  paid:      { label: "Paid — awaiting seller", color: "#ffd700" },
  fulfilled: { label: "Fulfilled", color: "#64b5f6" },
  completed: { label: "Completed", color: "#4caf50" },
  cancelled: { label: "Cancelled", color: "#999" },
  refunded:  { label: "Refunded", color: "#999" },
  disputed:  { label: "Disputed", color: "#e57373" },
};
const LISTING_STATUS = {
  active: { label: "Active", color: "#4caf50" },
  paused: { label: "Paused", color: "#999" },
  pending_review: { label: "Awaiting review", color: "#ffd700" },
  removed: { label: "Removed", color: "#e57373" },
};

// ── schema ──
async function addCol(table, def) {
  try { await runQuery(`ALTER TABLE ${table} ADD COLUMN ${def}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

const ready = (async () => {
  // dbUtils creates prizes too, but without waiting; same definition, so whichever runs first wins.
  await runQuery(`CREATE TABLE IF NOT EXISTS prizes (
    prizeId TEXT PRIMARY KEY, prize TEXT NOT NULL, cost INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // Marketplace columns. Existing rows become active official instant items.
  for (const def of ["seller_id TEXT", "description TEXT", "category TEXT", "delivery TEXT DEFAULT 'instant'",
                     "image_url TEXT", "buyer_prompt TEXT", "status TEXT DEFAULT 'active'", "sold INTEGER DEFAULT 0",
                     "review_note TEXT", "created INTEGER", "updated INTEGER"]) {
    await addCol("prizes", def);
  }
  await runQuery(`CREATE TABLE IF NOT EXISTS shop_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize_id TEXT, buyer_id TEXT NOT NULL, seller_id TEXT, official INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL, price INTEGER NOT NULL, fee_pct REAL NOT NULL DEFAULT 0, fee INTEGER, net INTEGER,
    seller_paid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, buyer_input TEXT, seller_note TEXT, dispute_reason TEXT, dispute_from TEXT, resolution TEXT,
    source TEXT, created INTEGER, fulfilled_at INTEGER, completed_at INTEGER, closed_at INTEGER, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS shop_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    status TEXT NOT NULL, actor TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS shop_settings (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery(`CREATE TABLE IF NOT EXISTS shop_prefs (
    user_id TEXT PRIMARY KEY, email_off INTEGER NOT NULL DEFAULT 0, pm_off INTEGER NOT NULL DEFAULT 0)`);
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_prizes_status ON prizes (status, seller_id)",
    "CREATE INDEX IF NOT EXISTS idx_shop_orders_buyer ON shop_orders (buyer_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_shop_orders_seller ON shop_orders (seller_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders (status, updated)",
    "CREATE INDEX IF NOT EXISTS idx_shop_events_order ON shop_order_events (order_id, id)",
  ]) await runQuery(sql);
  // 1.99fj: the spin boost's list price is its first-copy price; what a buyer pays is spinboostPrice().
  try { await runQuery("ALTER TABLE users ADD COLUMN extra_daily_spins INTEGER DEFAULT 0"); }
  catch (e) { /* already there (or no users table yet - dbUtils creates it) */ }
  await runQuery("UPDATE prizes SET cost = ? WHERE prizeId = ? AND seller_id IS NULL AND cost != ?",
                 [SPINBOOST_BASE, SPINBOOST_ID, SPINBOOST_BASE]);
  await loadSettings();
  await backfillHistory();
})().catch((e) => console.error("[shop] schema:", e));

// ── settings ──
const settings = { ...DEFAULTS, categories: DEFAULT_CATEGORIES.slice() };
async function loadSettings() {
  const rows = await getQuery("SELECT key, value FROM shop_settings");
  for (const r of rows) {
    if (!(r.key in DEFAULTS)) continue;
    try {
      const v = JSON.parse(r.value);
      if (r.key === "categories") { if (Array.isArray(v) && v.length) settings.categories = v.map(String); }
      else if (typeof v === "number" && isFinite(v)) settings[r.key] = v;
    } catch (e) { /* keep default */ }
  }
}
async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    settings[k] = v;
    await runQuery("INSERT INTO shop_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   [k, JSON.stringify(v)]);
  }
}

// Past official purchases ("purchase of X" transactions) become completed orders, once.
async function backfillHistory() {
  const done = await getQuery("SELECT value FROM shop_settings WHERE key = 'backfilled'");
  if (done.length) return;
  await tx(async () => {
    const again = await getQuery("SELECT value FROM shop_settings WHERE key = 'backfilled'");
    if (again.length) return;
    const r = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net,
        seller_paid, status, source, created, completed_at, closed_at, updated)
      SELECT (SELECT p.prizeId FROM prizes p WHERE p.prize = substr(t.type, 13) AND p.seller_id IS NULL LIMIT 1),
             t.userId, NULL, 1, substr(t.type, 13), -t.points, 0, 0, -t.points, 1, 'completed', 'history',
             CAST(strftime('%s', t.timestamp) AS INTEGER) * 1000, CAST(strftime('%s', t.timestamp) AS INTEGER) * 1000,
             CAST(strftime('%s', t.timestamp) AS INTEGER) * 1000, CAST(strftime('%s', t.timestamp) AS INTEGER) * 1000
      FROM transactions t WHERE t.type LIKE 'purchase of %' AND t.points < 0 ORDER BY t.timestamp`);
    await runQuery(`UPDATE prizes SET sold = (SELECT COUNT(*) FROM shop_orders o WHERE o.prize_id = prizes.prizeId)
                    WHERE seller_id IS NULL`);
    await runQuery("INSERT INTO shop_settings (key, value) VALUES ('backfilled', ?)", [JSON.stringify(Date.now())]);
    if (r.changes) console.log(`[shop] recorded ${r.changes} past store purchases as completed orders`);
  });
}

// ── transactions ──
// Purchases run one at a time. They share one SQLite connection, and a second BEGIN while the
// first purchase's transaction is open fails ("cannot start a transaction within a transaction").
let _chain = Promise.resolve();
function serial(fn) {
  const run = _chain.then(() => fn(), () => fn());
  _chain = run.catch(() => {});
  return run;
}
function tx(fn) {
  return serial(async () => {
    await runQuery("BEGIN TRANSACTION");
    try {
      const out = await fn();
      await runQuery("COMMIT");
      return out;
    } catch (e) {
      try { await runQuery("ROLLBACK"); } catch (_) { /* nothing open */ }
      throw e;
    }
  });
}

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// 1.99ga: through the ledger - only an account that exists (a credit follows a merge), else it throws
// and the surrounding tx() rolls the whole order step back
async function move(userId, amount, label) {
  await require("./ledger").postOrThrow(userId, amount, label, { resolveMerged: amount > 0, source: "shop" });
}
async function event(orderId, status, actor, note) {
  await runQuery("INSERT INTO shop_order_events (order_id, ts, status, actor, note) VALUES (?, ?, ?, ?, ?)",
                 [orderId, Date.now(), status, actor || null, note ? String(note).slice(0, 500) : null]);
}
// Move an order from `from` (one status or a list) to `to`; throws if it isn't in `from` any more.
async function transition(order, from, to, fields = {}) {
  const froms = [].concat(from);
  const sets = ["status = ?", "updated = ?"], vals = [to, Date.now()];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  const r = await runQuery(`UPDATE shop_orders SET ${sets.join(", ")} WHERE id = ? AND status IN (${froms.map(() => "?").join(",")})`,
                           [...vals, order.id, ...froms]);
  if (!r.changes) throw new Refuse(409, "That order changed in the meantime — reload and try again.");
}
const feeFor = (price, pct) => Math.max(0, Math.min(price, Math.floor(price * (Number(pct) || 0) / 100)));

// ── notifications ──
let _resend = null, _sg = null;
async function sendEmail(to, subject, text) {
  if (!to) return false;
  const html = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");
  try {
    if (process.env.RESEND_API_KEY) {
      if (!_resend) { const { Resend } = require("resend"); _resend = new Resend(process.env.RESEND_API_KEY); }
      // Resend RESOLVES with {error} instead of throwing.
      const r = await _resend.emails.send({ to, from: MAIL_FROM, subject, text, html });
      if (r && r.error) { console.error("[shop] email failed:", r.error.message || r.error); return false; }
      return true;
    }
    if (process.env.SENDGRID_API_KEY) {
      if (!_sg) { _sg = require("@sendgrid/mail"); _sg.setApiKey(process.env.SENDGRID_API_KEY); }
      await _sg.send({ to, from: MAIL_FROM, subject, text, html });
      return true;
    }
  } catch (e) {
    console.error("[shop] email failed:", e.message);
  }
  return false;
}

async function prefsFor(userId) {
  const r = await getQuery("SELECT email_off, pm_off FROM shop_prefs WHERE user_id = ?", [userId]);
  return { email_off: !!(r[0] && r[0].email_off), pm_off: !!(r[0] && r[0].pm_off) };
}

// Email (unless opted out) + Camfrog PM through Pepe (unless opted out or no linked name).
// Never throws. `pm` is the short PM line; the link is appended to both.
async function notify(userId, { subject, text, pm, link }) {
  const out = { email: false, pm: false };
  try {
    if (!userId) return out;
    const u = (await getQuery("SELECT username, email, camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
    if (!u) return out;
    const p = await prefsFor(userId);
    const url = link ? SITE + link : "";
    // always the inbox (1.99au); the Camfrog PM below also honours the inbox's per-category switch
    out.inbox = await inbox.addSafe(userId, { kind: "shop", title: subject, body: text, link });
    if (u.email && !p.email_off) {
      out.email = await sendEmail(u.email, subject,
        `${text}\n\n${url}\n\n— PATV Shop. Turn these emails off in your seller dashboard: ${SITE}/shop/seller#notify`);
    }
    if (u.camfrogUsername && !p.pm_off && await inbox.pmAllowed(userId, "shop")) {
      try {
        // Pepe PMs it in a room they're in, or holds it until they show up (pepe_notice.py)
        await actions.queue(userId, { kind: "notify", args: [u.camfrogUsername, `${pm || subject} ${url}`.trim().slice(0, 300), "shop"],
                                      tag: "shop-notify", label: subject });
        out.pm = true;
      } catch (e) {
        console.error("[shop] PM not queued:", e.message);
      }
    }
  } catch (e) {
    console.error("[shop] notify:", e.message);
  }
  return out;
}

// ── purchase ──
let D = { achievements: null, discordBridge: null, userRoles: null };
// 1.99ji: after an official sale commits, these run (never awaited by the buyer, never throw into the sale): the media
// integrations fulfil their items there (mediainvites.js: a Wizarr invite; mediarequests.js: request credits).
const saleHooks = [];
function onOfficialSale(fn) { if (typeof fn === "function" && !saleHooks.includes(fn)) saleHooks.push(fn); }
function runSaleHooks(sale) {
  for (const fn of saleHooks) {
    Promise.resolve().then(() => fn(sale)).catch((e) => console.error("[shop] sale hook:", e && e.message));
  }
}

// Returns {success, status, message, prize, cost, balance, remaining_stock, owner, order_id}. Never throws.
async function purchasePrize({ userId, username, prizeId, source, buyerInput, expectedCost }) {
  try {
    await ready;
    const prizes = await getQuery(
      `SELECT prizeId, cost, prize, quantity, seller_id, status, buyer_prompt FROM prizes WHERE prizeId = ?`, [prizeId]);
    if (prizes.length === 0 || prizes[0].status === "removed") {
      return { success: false, status: 404, message: "That item isn't in the shop any more." };
    }
    if (prizes[0].status !== "active") {
      return { success: false, status: 400, message: `${prizes[0].prize} isn't for sale right now.` };
    }
    // The website sends the price the buyer saw; a price edit in between must not charge them more.
    // Official items check it inside buyOfficial, against the price the server computes for this
    // buyer at that moment (the spin boost's price depends on how many they own).
    if (prizes[0].seller_id && expectedCost != null && expectedCost !== "" && Number(expectedCost) !== prizes[0].cost) {
      return { success: false, status: 409, message: `The price of ${prizes[0].prize} just changed to ${prizes[0].cost.toLocaleString()} PAT — check it and try again. You have not been charged.` };
    }
    return prizes[0].seller_id ? await buyListing(prizes[0], { userId, username, source, buyerInput })
                               : await buyOfficial(prizes[0], { userId, username, source, expectedCost });
  } catch (error) {
    console.error("Shop purchase error:", error);
    return { success: false, status: 500, message: "Something went wrong buying that — you have not been charged." };
  }
}

async function userRoles(userId) {
  if (D.userRoles) return D.userRoles(userId);
  const rows = await getQuery("SELECT role FROM user_roles WHERE userId = ?", [userId]);
  return rows.map((r) => r.role);
}

// What this buyer pays for an official item: the list price, except the spin boost (per buyer).
async function priceFor(prize, userId) {
  if (!isSpinboost(prize)) return prize.cost;
  if (!userId) return SPINBOOST_BASE;
  const u = (await getQuery("SELECT extra_daily_spins FROM users WHERE userId = ?", [userId]))[0];
  return spinboostPrice(spinboostOwned(u && u.extra_daily_spins));
}
// Rows for a page: show the signed-in buyer their own spin-boost price (cost), keep list_cost.
async function personalise(rows, userId) {
  for (const r of rows || []) {
    if (r && isSpinboost(r)) { r.list_cost = r.cost; r.cost = await priceFor(r, userId); r.escalating = true; }
  }
  return rows;
}

// The official store: identical to the pre-marketplace purchase, plus a completed order row.
// The spin boost is priced per buyer and paid to the House (see the header).
function buyOfficial(listed, { userId, username, source, expectedCost }) {
  return serial(async () => {
    const prize = (await getQuery("SELECT prizeId, cost, prize, quantity FROM prizes WHERE prizeId = ?", [listed.prizeId]))[0];
    if (!prize) return { success: false, status: 404, message: "That item isn't in the shop any more." };
    const boost = isSpinboost(prize);
    const users = await getQuery(
      `SELECT points_balance, discordId, camfrogUsername${boost ? ", COALESCE(extra_daily_spins, 0) AS extra_daily_spins" : ""} FROM users WHERE userId = ?`, [userId]);
    if (users.length === 0) {
      return { success: false, status: 404, message: "We couldn't find your account." };
    }
    // The server's price, never the client's: the list price, or the spin boost's per-buyer price.
    const owned = boost ? spinboostOwned(users[0].extra_daily_spins) : 0;
    prize.cost = boost ? spinboostPrice(owned) : prize.cost;
    if (expectedCost != null && expectedCost !== "" && Number(expectedCost) !== prize.cost) {
      return { success: false, status: 409, cost: prize.cost,
               message: boost ? `${prize.prize} costs you ${prize.cost.toLocaleString()} PAT (you own ${owned}) — check it and try again. You have not been charged.`
                              : `The price of ${prize.prize} just changed to ${prize.cost.toLocaleString()} PAT — check it and try again. You have not been charged.` };
    }
    if (prize.quantity <= 0) {
      return { success: false, status: 400, message: `${prize.prize} is out of stock — check back later.` };
    }
    const balance = users[0].points_balance || 0;
    const role = ROLE_PRIZES[prize.prizeId] || null;
    if (role && (await userRoles(userId)).includes(role)) {
      return { success: false, status: 409, message: `You already have the ${prize.prize.replace(/ role$/i, "")} role.` };
    }
    if (balance < prize.cost) {
      // Tell them exactly how short they are — "Insufficient coins" left people guessing.
      const short = prize.cost - balance;
      return {
        success: false, status: 400, balance, cost: prize.cost,
        message: `${prize.prize} costs ${prize.cost.toLocaleString()} PAT and you have ` +
                 `${balance.toLocaleString()} — ${short.toLocaleString()} short.`,
      };
    }
    // Proceeds: the House (casino jackpot) for the spin boost, else the store owner.
    const owners = boost ? [] : await getQuery("SELECT userId, username FROM users WHERE username = ?", [STORE_OWNER_USERNAME]);
    const owner = owners[0] || null;
    if (!owner && !boost) {
      console.error(`STORE OWNER '${STORE_OWNER_USERNAME}' not found — sale proceeds go nowhere`);
    }

    let orderId = null;
    try {
      await runQuery("BEGIN TRANSACTION");
      const paid = await runQuery(
        "UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
        [prize.cost, userId, prize.cost]);
      if (!paid.changes) throw new Error("balance changed mid-purchase");
      const stock = await runQuery(
        "UPDATE prizes SET quantity = quantity - 1, sold = COALESCE(sold, 0) + 1 WHERE prizeId = ? AND quantity > 0 AND status = 'active'",
        [prize.prizeId]);
      if (!stock.changes) throw new Error("sold out mid-purchase");
      // Digital prize effect: the spin boost permanently raises this user's daily gold-spin
      // cap by 100 (stackable — buy it again for another +100/day, at +1M each time). Conditional
      // on the count it was priced from, so a concurrent purchase can't buy at the old price.
      if (boost) {
        const up = await runQuery(
          "UPDATE users SET extra_daily_spins = COALESCE(extra_daily_spins, 0) + ? WHERE userId = ? AND COALESCE(extra_daily_spins, 0) = ?",
          [SPINBOOST_SPINS, userId, users[0].extra_daily_spins]);
        if (!up.changes) throw new Error("boost count changed mid-purchase");
      }
      if (role) {
        await runQuery("INSERT OR IGNORE INTO user_roles (userId, role, source) VALUES (?, ?, ?)",
                       [userId, role, `purchase:${source}`]);
        if (D.achievements) D.achievements.checkWeb(userId);               // e.g. High Roller
      }
      await runQuery(
        "INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
        [uuidv4(), userId, `purchase of ${prize.prize}`, -prize.cost]);
      if (owner) {
        await require("./ledger").postOrThrow(owner.userId, prize.cost, `store sale: ${prize.prize} to ${username} (${source})`,
                                              { resolveMerged: true, source: "shop sale" });
      }
      const now = Date.now();
      const o = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net,
          seller_paid, status, source, created, completed_at, closed_at, updated)
        VALUES (?, ?, NULL, 1, ?, ?, 0, 0, ?, 1, 'completed', ?, ?, ?, ?, ?)`,
        [prize.prizeId, userId, prize.prize, prize.cost, prize.cost, source, now, now, now, now]);
      orderId = o.id;
      if (boost) {
        // to the House, the same place gold-wheel wagers go: debit == credit, nothing minted or burned
        await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                       [uuidv4(), `shop-order:${orderId}`, userId, prize.cost]);
      }
      await event(orderId, "completed", username, boost ? `Official store item — delivered instantly; ${prize.cost.toLocaleString()} PAT to the House (copy #${owned + 1})`
                                                        : "Official store item — delivered instantly");
      await runQuery("COMMIT");
    } catch (error) {
      try { await runQuery("ROLLBACK"); } catch (e) { /* nothing open */ }
      const known = /mid-purchase/.test(error.message);
      if (!known) console.error("Shop purchase error:", error);
      return {
        success: false, status: known ? 409 : 500,
        message: known ? "That changed while you were buying it — please try again. You have not been charged."
                       : "Something went wrong buying that — you have not been charged.",
      };
    }

    // E-0 telemetry (econ.js), best effort after the commit: the spin boost is a House inflow.
    if (boost) houseTelemetry(orderId, prize.cost, users[0].camfrogUsername || username, source);
    runSaleHooks({ orderId, prizeId: prize.prizeId, title: prize.prize, price: prize.cost, userId, username, source });

    // Notifications are not part of the purchase: an outage must never turn a completed, charged
    // purchase into a reported failure.
    sendEmail(process.env.STORE_NOTIFY_EMAIL || "pb@publicaccess.tv", "Purchase Notification",
              `User ${username} purchased ${prize.prize} for ${prize.cost} coins (via ${source}).`).catch(() => {});

    // Discord: the Discord shop announces its own sales and grants roles itself; for website and
    // Camfrog purchases the bot's bridge posts the sale in the purchases channel and grants the
    // role (if they've linked Discord). Awaited only for a role, so the buyer hears the outcome.
    let discord_role = null;
    if (source !== "discord" && D.discordBridge) {
      const job = D.discordBridge("/store/purchase", {
        username, camfrogUsername: users[0].camfrogUsername || null, discordId: users[0].discordId || null,
        prize: prize.prize, cost: prize.cost, source, role,
      });
      if (role) {
        const r = await job;
        discord_role = r.granted ? "granted" : (r.reason || r.error || "failed");
      }
    }

    const remaining = balance - prize.cost;
    return {
      success: true, status: 200, prize: prize.prize, prizeId: prize.prizeId, cost: prize.cost,
      balance: remaining, remaining_stock: Math.max(0, (prize.quantity || 1) - 1),
      owner: boost ? "House" : (owner ? owner.username : null), role, discord_role, order_id: orderId,
      ...(boost ? { owned: owned + 1, next_cost: spinboostPrice(owned + 1) } : {}),
      message: `Bought ${prize.prize} for ${prize.cost.toLocaleString()} PAT. ` +
               `Balance: ${remaining.toLocaleString()} PAT.`,
    };
  });
}

// ── 1.99ji: official SERVICE charges (no stocked prize) - e.g. a 🎬 media request (mediarequests.js) ──
// The same money path as an official store sale: the buyer pays, the PAT goes to the store owner, and a completed
// official order (prize_id NULL) records it on their orders page. refundService() reverses exactly that, once.
// 1.99jn: hold = true (📼 Play from Plex, medialib.js): the buyer pays and gets the completed order, but NOBODY is credited
// yet (seller_paid 0) - the caller routes the PAT itself once the service really happened (boosts.routeInTx: Fort Knox /
// the pad's room vault) and marks the order paid, or refundService() gives it all back (no store-owner debit for a hold).
async function chargeService({ userId, username, title, price, source, note, hold = false }) {
  await ready;
  price = Math.floor(Number(price));
  if (!(price > 0) || price > PRICE_MAX) throw new Refuse(400, "Bad price.");
  title = String(title || "Service").replace(/[\r\n\t]+/g, " ").slice(0, 120);
  const owner = hold ? null : (await getQuery("SELECT userId FROM users WHERE username = ?", [STORE_OWNER_USERNAME]))[0] || null;
  return tx(async () => {
    const r = await require("./ledger").post(userId, -price, `purchase of ${title}`, { requireCover: true, source: "shop service" });
    if (!r.ok) {
      if (r.code === "E_INSUFFICIENT") {
        const b = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]))[0];
        throw new Refuse(402, `That costs ${price.toLocaleString()} PAT and you have ${((b && b.points_balance) || 0).toLocaleString()}.`);
      }
      throw new Refuse(404, "We couldn't find your account.");
    }
    if (owner) await move(owner.userId, price, `store sale: ${title} to ${username} (${source || "website"})`);
    const t = Date.now();
    const o = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net,
        seller_paid, status, source, created, completed_at, closed_at, updated)
      VALUES (NULL, ?, NULL, 1, ?, ?, 0, 0, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
      [userId, title, price, price, hold ? 0 : 1, source || "website", t, t, t, t]);
    await event(o.id, "completed", username, note || (hold ? "Official service — charged (held until it starts)" : "Official service — charged"));
    return { order_id: o.id, price };
  });
}
// ── 1.99jp: a SUBSCRIPTION renewal (subscriptions.js) - the same money path as buying the official item again: the
// buyer pays the item's price, the store owner is credited (where that item's sales always went), a completed official
// order with the item's prize_id goes on their orders page. No stock is used. `inTx(order)` runs inside the same
// transaction (the subscription's own ledger row + new date), so the charge and the renewal commit together or not at all;
// it may return "dup" to abort with nothing charged (-> null).
async function chargeRenewal({ userId, username, prizeId, title, price, note, inTx }) {
  await ready;
  price = Math.floor(Number(price));
  if (!(price > 0) || price > PRICE_MAX) throw new Refuse(400, "Bad price.");
  title = String(title || "Subscription").replace(/[\r\n\t]+/g, " ").slice(0, 120);
  const owner = (await getQuery("SELECT userId FROM users WHERE username = ?", [STORE_OWNER_USERNAME]))[0] || null;
  if (!owner) console.error(`STORE OWNER '${STORE_OWNER_USERNAME}' not found - renewal proceeds go nowhere`);
  const out = await tx(async () => {
    const r = await require("./ledger").post(userId, -price, `purchase of ${title}`, { requireCover: true, source: "shop subscription" });
    if (!r.ok) {
      if (r.code === "E_INSUFFICIENT") throw new Refuse(402, `That costs ${price.toLocaleString()} PAT.`);
      throw new Refuse(404, "We couldn't find the account.");
    }
    if (owner) await move(owner.userId, price, `store sale: ${title} to ${username} (subscription)`);
    const t = Date.now();
    const o = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net,
        seller_paid, status, source, created, completed_at, closed_at, updated)
      VALUES (?, ?, NULL, 1, ?, ?, 0, 0, ?, 1, 'completed', 'subscription', ?, ?, ?, ?)`,
      [prizeId || null, userId, title, price, price, t, t, t, t]);
    await event(o.id, "completed", "system", note || "Subscription renewal — charged");
    const order = { order_id: o.id, price, created: t };
    if (inTx) { const x = await inTx(order); if (x === "dup") throw Object.assign(new Error("dup"), { dup: true }); }
    return order;
  }).catch((e) => { if (e && e.dup) return null; throw e; });
  if (out) runSaleHooks({ orderId: out.order_id, prizeId, title, price, userId, username, source: "subscription", renewal: true });
  return out;
}

/** Refund a chargeService() order (whole price back to the buyer, out of the store owner). -> true once, then false. */
async function refundService(orderId, reason, actor) {
  await ready;
  const owner = (await getQuery("SELECT userId FROM users WHERE username = ?", [STORE_OWNER_USERNAME]))[0] || null;
  return tx(async () => {
    const o = await getOrder(orderId);
    if (!o || !o.official || o.prize_id || o.status !== "completed") return false;
    // 1.99jn: a HELD charge (chargeService hold) was never credited to anyone - refund it from the hold, no owner debit.
    // A held charge that has since been ROUTED (seller_paid 1, source medialib) went to Fort Knox / a room vault: not here.
    const held = !o.seller_paid;
    if (!held && o.source === "medialib") return false;
    await transition(o, "completed", "refunded", { resolution: String(reason || "refunded").slice(0, 300), closed_at: Date.now() });
    await move(o.buyer_id, o.price, `shop refund: ${o.title} (order #${o.id})`);
    if (owner && !held) await require("./ledger").postOrThrow(owner.userId, -o.price, `store refund: ${o.title} (order #${o.id})`, { source: "shop service refund" });
    await event(o.id, "refunded", actor || "system", String(reason || "refunded").slice(0, 300));
    return true;
  });
}

// E-0 (econ.js): journal a House inflow as a "game" flow, like Pepe's casino flows. Never throws.
function houseTelemetry(orderId, amount, login, source) {
  try {
    const econ = require("./econ");
    econ.config().then((c) => c.economy_e0 ? econ.ingestCharges([{ ref: `shop-spinboost-${orderId}`, ts: Date.now(), room: "",
      flow: "spinboost", kind: "game", payer: login || "", payer_kind: "other", amount,
      via: source === "website" ? "web" : "chat" }]) : 0).catch(() => {});
  } catch (e) { /* telemetry only */ }
}

// A user listing: charge the buyer, take one from stock, open a "paid" order, tell the seller.
async function buyListing(prize, { userId, username, source, buyerInput }) {
  const input = String(buyerInput || "").replace(/\r/g, "").trim().slice(0, 300);
  if (userId === prize.seller_id) return { success: false, status: 400, message: "That's your own listing." };
  if (prize.buyer_prompt && !input) {
    return { success: false, status: 400, needs_input: prize.buyer_prompt,
             message: source === "website" ? `The seller needs this to deliver it: ${prize.buyer_prompt}`
                                           : `${prize.prize} needs info from you (${prize.buyer_prompt}) — buy it on the website: ${SITE}/shop/item/${prize.prizeId}` };
  }
  const seller = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [prize.seller_id]))[0];
  if (!seller) return { success: false, status: 404, message: "That item isn't in the shop any more." };
  let result;
  try {
    result = await tx(async () => {
      const u = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]))[0];
      if (!u) throw new Refuse(404, "We couldn't find your account.");
      const p = (await getQuery("SELECT prize, cost, quantity, status FROM prizes WHERE prizeId = ?", [prize.prizeId]))[0];
      if (!p || p.status !== "active") throw new Refuse(409, "That item was just taken off sale. You have not been charged.");
      if (p.cost !== prize.cost) throw new Refuse(409, "The price just changed — reload and check it. You have not been charged.");
      if (p.quantity <= 0) throw new Refuse(400, `${p.prize} is out of stock — check back later.`);
      const balance = u.points_balance || 0;
      if (balance < p.cost) {
        throw Object.assign(new Refuse(400, `${p.prize} costs ${p.cost.toLocaleString()} PAT and you have ` +
          `${balance.toLocaleString()} — ${(p.cost - balance).toLocaleString()} short.`), { balance, cost: p.cost });
      }
      const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
                                  [p.cost, userId, p.cost]);
      if (!paid.changes) throw new Refuse(409, "Your balance changed mid-purchase — try again. You have not been charged.");
      const stock = await runQuery("UPDATE prizes SET quantity = quantity - 1, sold = COALESCE(sold, 0) + 1 WHERE prizeId = ? AND quantity > 0",
                                   [prize.prizeId]);
      if (!stock.changes) throw new Refuse(409, "It sold out while you were buying it. You have not been charged.");
      const now = Date.now();
      const o = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, seller_paid,
          status, buyer_input, source, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)`,
        [prize.prizeId, userId, seller.userId, p.prize, p.cost, settings.fee_pct, input || null, source, now, now]);
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                     [uuidv4(), userId, `shop purchase: ${p.prize} (order #${o.id})`, -p.cost]);
      await event(o.id, "paid", username, `Bought via ${source}`);
      return { orderId: o.id, title: p.prize, cost: p.cost, balance: balance - p.cost, remaining: p.quantity - 1 };
    });
  } catch (e) {
    if (e.refuse) return { success: false, status: e.status, message: e.message, balance: e.balance, cost: e.cost };
    throw e;
  }
  notify(seller.userId, {
    subject: `New order #${result.orderId}: ${result.title}`,
    text: `${username} bought "${result.title}" for ${result.cost.toLocaleString()} PAT.` +
          (input ? `\nThey wrote: ${input}` : "") +
          `\nThe PAT is held until you mark the order fulfilled. Fulfil or refund it here:`,
    pm: `🛒 New shop order #${result.orderId}: ${username} bought "${result.title}" for ${result.cost.toLocaleString()} PAT. Fulfil it:`,
    link: `/shop/orders/${result.orderId}`,
  });
  return {
    success: true, status: 200, prize: result.title, prizeId: prize.prizeId, cost: result.cost,
    balance: result.balance, remaining_stock: Math.max(0, result.remaining), order_id: result.orderId,
    seller: seller.username, owner: seller.username, role: null, discord_role: null,
    message: `Ordered ${result.title} for ${result.cost.toLocaleString()} PAT from ${seller.username}. ` +
             `Balance: ${result.balance.toLocaleString()} PAT. Track it: ${SITE}/shop/orders/${result.orderId}`,
  };
}

// ── order actions ──
async function getOrder(id) {
  const r = await getQuery(`SELECT o.*, b.username AS buyer_name, s.username AS seller_name
    FROM shop_orders o LEFT JOIN users b ON b.userId = o.buyer_id LEFT JOIN users s ON s.userId = o.seller_id
    WHERE o.id = ?`, [parseInt(id, 10) || 0]);
  return r[0] || null;
}

// Inside a tx: pay the seller (net) and send the fee to the Reserve.
async function paySeller(o) {
  const fee = feeFor(o.price, o.fee_pct), net = o.price - fee;
  await move(o.seller_id, net, `shop sale: ${o.title} to ${o.buyer_name || "buyer"} (order #${o.id}, fee ${fee.toLocaleString()})`);
  if (fee > 0) {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                   [uuidv4(), "shop_fee", o.seller_id, `shop fee: order #${o.id}`, -fee]);
  }
  return { fee, net };
}
// Inside a tx: give the buyer everything back; undo the seller's payout if there was one.
async function refundBuyer(o) {
  await move(o.buyer_id, o.price, `shop refund: ${o.title} (order #${o.id})`);
  if (o.seller_paid) {
    await move(o.seller_id, -(o.net || 0), `shop refund: ${o.title} (order #${o.id}, clawback)`);
    if (o.fee > 0) {
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [uuidv4(), "shop_fee_refund", o.seller_id, `shop fee refund: order #${o.id}`, o.fee]);
    }
  } else if (o.prize_id) {
    await runQuery("UPDATE prizes SET quantity = quantity + 1, sold = MAX(COALESCE(sold, 0) - 1, 0) WHERE prizeId = ?", [o.prize_id]);
  }
}

// op: fulfil | refund | cancel | confirm | dispute | resolve_seller | resolve_buyer
// actor: {userId, username, staff}. Returns {ok, message}. Throws Refuse for expected refusals.
async function orderAction(id, op, actor, { note, reason } = {}) {
  await ready;
  const o0 = await getOrder(id);
  if (!o0 || o0.official) throw new Refuse(404, "No such order.");
  const isBuyer = actor.userId === o0.buyer_id, isSeller = actor.userId === o0.seller_id, staff = !!actor.staff;
  const who = actor.username || "system";
  let after = null;   // notifications to send after commit

  const run = (fn) => tx(async () => {
    const o = await getOrder(id);     // fresh, inside the transaction
    return fn(o);
  });

  if (op === "fulfil") {
    if (!isSeller) throw new Refuse(403, "Only the seller can fulfil this order.");
    const text = String(note || "").replace(/\r/g, "").trim().slice(0, 1000);
    await run(async (o) => {
      await transition(o, "paid", "fulfilled", { seller_note: text || null, fulfilled_at: Date.now() });
      const { fee, net } = await paySeller(o);
      await runQuery("UPDATE shop_orders SET fee = ?, net = ?, seller_paid = 1 WHERE id = ?", [fee, net, o.id]);
      await event(o.id, "fulfilled", who, `Seller paid ${net.toLocaleString()} PAT (fee ${fee.toLocaleString()})`);
    });
    after = () => notify(o0.buyer_id, {
      subject: `Order #${o0.id} fulfilled: ${o0.title}`,
      text: `${o0.seller_name} marked your order "${o0.title}" as fulfilled.` + (text ? `\nTheir note: ${text}` : "") +
            `\nConfirm you received it, or open a dispute within ${settings.auto_complete_days} days:`,
      pm: `📦 Your shop order #${o0.id} "${o0.title}" was fulfilled by ${o0.seller_name}. Details:`,
      link: `/shop/orders/${o0.id}`,
    });
    await after();
    return { message: "Marked fulfilled — you've been paid." };
  }

  if (op === "refund" || op === "cancel") {
    if (op === "cancel" && !isBuyer) throw new Refuse(403, "Only the buyer can cancel.");
    if (op === "refund" && !isSeller && !staff) throw new Refuse(403, "Only the seller or an admin can refund.");
    // Seller/buyer: only before fulfilment. Staff: also a fulfilled order (seller's payout is clawed back).
    const from = staff && !isSeller && !isBuyer ? ["paid", "fulfilled", "disputed"] : ["paid"];
    const to = op === "cancel" ? "cancelled" : "refunded";
    const why = String(reason || note || "").trim().slice(0, 300);
    await run(async (o) => {
      await transition(o, from, to, { closed_at: Date.now(), resolution: why || null });
      await refundBuyer(o);
      await event(o.id, to, staff && !isSeller && !isBuyer ? `admin:${who}` : who,
                  `${o.price.toLocaleString()} PAT returned to the buyer` + (why ? ` — ${why}` : ""));
    });
    if (op === "cancel") {
      await notify(o0.seller_id, { subject: `Order #${o0.id} cancelled by the buyer`,
        text: `${o0.buyer_name} cancelled "${o0.title}" before it was fulfilled. They were refunded and the stock is back.`,
        pm: `❌ ${o0.buyer_name} cancelled shop order #${o0.id} "${o0.title}".`, link: "/shop/seller" });
    } else {
      await notify(o0.buyer_id, { subject: `Order #${o0.id} refunded: ${o0.title}`,
        text: `Your order "${o0.title}" was refunded: ${o0.price.toLocaleString()} PAT is back in your balance.` + (why ? `\nReason: ${why}` : ""),
        pm: `↩️ Shop order #${o0.id} "${o0.title}" was refunded — ${o0.price.toLocaleString()} PAT is back.`,
        link: `/shop/orders/${o0.id}` });
    }
    return { message: op === "cancel" ? "Order cancelled — your PAT is back." : "Refunded — the buyer has their PAT back." };
  }

  if (op === "confirm") {
    if (!isBuyer) throw new Refuse(403, "Only the buyer can confirm.");
    await run(async (o) => {
      await transition(o, "fulfilled", "completed", { completed_at: Date.now(), closed_at: Date.now() });
      await event(o.id, "completed", who, "Buyer confirmed receipt");
    });
    return { message: "Thanks — order completed." };
  }

  if (op === "dispute") {
    if (!isBuyer) throw new Refuse(403, "Only the buyer can open a dispute.");
    const why = String(reason || "").replace(/\r/g, "").trim().slice(0, 1000);
    if (why.length < 5) throw new Refuse(400, "Say what went wrong (a sentence is enough).");
    await run(async (o) => {
      await transition(o, ["paid", "fulfilled"], "disputed", { dispute_reason: why, dispute_from: o.status });
      await event(o.id, "disputed", who, why);
    });
    await notify(o0.seller_id, { subject: `Dispute on order #${o0.id}: ${o0.title}`,
      text: `${o0.buyer_name} opened a dispute on "${o0.title}": ${why}\nAn admin will look at it.`,
      pm: `⚠️ ${o0.buyer_name} opened a dispute on shop order #${o0.id} "${o0.title}". An admin will review it.`,
      link: `/shop/orders/${o0.id}` });
    sendEmail(process.env.STORE_NOTIFY_EMAIL || "pb@publicaccess.tv", `Shop dispute: order #${o0.id}`,
              `${o0.buyer_name} disputes "${o0.title}" (seller ${o0.seller_name}): ${why}\n${SITE}/shop/admin#disputes`).catch(() => {});
    return { message: "Dispute opened — an admin will review it." };
  }

  if (op === "resolve_seller" || op === "resolve_buyer") {
    if (!staff) throw new Refuse(403, "Admins only.");
    const why = String(reason || note || "").trim().slice(0, 300);
    if (op === "resolve_seller") {
      await run(async (o) => {
        const now = Date.now();
        await transition(o, "disputed", "completed", { completed_at: now, closed_at: now, resolution: "seller" + (why ? `: ${why}` : "") });
        if (!o.seller_paid) {
          const { fee, net } = await paySeller(o);
          await runQuery("UPDATE shop_orders SET fee = ?, net = ?, seller_paid = 1, fulfilled_at = COALESCE(fulfilled_at, ?) WHERE id = ?",
                         [fee, net, now, o.id]);
        }
        await event(o.id, "completed", `admin:${who}`, "Dispute resolved for the seller" + (why ? ` — ${why}` : ""));
      });
    } else {
      await run(async (o) => {
        await transition(o, "disputed", "refunded", { closed_at: Date.now(), resolution: "buyer" + (why ? `: ${why}` : "") });
        await refundBuyer(o);
        await event(o.id, "refunded", `admin:${who}`, "Dispute resolved for the buyer" + (why ? ` — ${why}` : ""));
      });
    }
    const forBuyer = op === "resolve_buyer";
    const msg = `The dispute on order #${o0.id} "${o0.title}" was resolved in favour of the ${forBuyer ? "buyer (refunded)" : "seller (paid)"}.` + (why ? ` ${why}` : "");
    await notify(o0.buyer_id, { subject: `Dispute resolved: order #${o0.id}`, text: msg, pm: "⚖️ " + msg, link: `/shop/orders/${o0.id}` });
    await notify(o0.seller_id, { subject: `Dispute resolved: order #${o0.id}`, text: msg, pm: "⚖️ " + msg, link: `/shop/orders/${o0.id}` });
    return { message: "Dispute resolved." };
  }
  throw new Refuse(400, "Unknown action.");
}

// Fulfilled orders nobody disputed complete; paid orders nobody fulfilled are refunded.
async function sweep() {
  await ready;
  const now = Date.now();
  const due = await getQuery("SELECT id FROM shop_orders WHERE status = 'fulfilled' AND fulfilled_at < ? LIMIT 200",
                             [now - settings.auto_complete_days * DAY]);
  for (const { id } of due) {
    try {
      await tx(async () => {
        const o = await getOrder(id);
        await transition(o, "fulfilled", "completed", { completed_at: Date.now(), closed_at: Date.now() });
        await event(id, "completed", "system", `Completed automatically after ${settings.auto_complete_days} days`);
      });
    } catch (e) { if (!e.refuse) console.error("[shop] auto-complete:", e.message); }
  }
  if (settings.auto_cancel_days > 0) {
    const stale = await getQuery("SELECT id FROM shop_orders WHERE status = 'paid' AND official = 0 AND created < ? LIMIT 200",
                                 [now - settings.auto_cancel_days * DAY]);
    for (const { id } of stale) {
      try {
        const o0 = await getOrder(id);
        await tx(async () => {
          const o = await getOrder(id);
          await transition(o, "paid", "refunded", { closed_at: Date.now(), resolution: "not fulfilled in time" });
          await refundBuyer(o);
          await event(id, "refunded", "system", `Not fulfilled within ${settings.auto_cancel_days} days — buyer refunded`);
        });
        await notify(o0.buyer_id, { subject: `Order #${id} refunded: ${o0.title}`,
          text: `The seller didn't fulfil "${o0.title}" within ${settings.auto_cancel_days} days, so your ${o0.price.toLocaleString()} PAT is back.`,
          pm: `↩️ Shop order #${id} "${o0.title}" wasn't fulfilled in time — ${o0.price.toLocaleString()} PAT refunded.`, link: `/shop/orders/${id}` });
        await notify(o0.seller_id, { subject: `Order #${id} expired: ${o0.title}`,
          text: `You didn't fulfil "${o0.title}" within ${settings.auto_cancel_days} days, so the buyer was refunded.`,
          pm: `⌛ Shop order #${id} "${o0.title}" expired unfulfilled — the buyer was refunded.`, link: "/shop/seller" });
      } catch (e) { if (!e.refuse) console.error("[shop] auto-cancel:", e.message); }
    }
  }
}

// ── listings ──
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const oneLine = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const toInt = (v) => { const n = Math.floor(Number(String(v == null ? "" : v).replace(/[, _]/g, ""))); return isFinite(n) ? n : NaN; };

function validateListing(b) {
  const title = oneLine(b.title, 80);
  const description = String(b.description || "").replace(/\r/g, "").trim().slice(0, 1000);
  const category = settings.categories.includes(String(b.category)) ? String(b.category) : null;
  const price = toInt(b.price), stock = toInt(b.stock);
  const buyer_prompt = oneLine(b.buyer_prompt, 120) || null;
  let image_url = String(b.image_url || "").trim();
  if (title.length < 3) throw new Refuse(400, "Give it a title (3–80 characters).");
  if (!category) throw new Refuse(400, "Pick a category.");
  if (!(price >= 1 && price <= PRICE_MAX)) throw new Refuse(400, `Price must be 1–${PRICE_MAX.toLocaleString()} PAT.`);
  if (!(stock >= 0 && stock <= STOCK_MAX)) throw new Refuse(400, `Stock must be 0–${STOCK_MAX.toLocaleString()}.`);
  if (image_url) {
    let u = null;
    try { u = new URL(image_url); } catch (e) { u = null; }
    if (!u || u.protocol !== "https:" || image_url.length > 500 || /["'<>\s]/.test(image_url)) {
      throw new Refuse(400, "The image must be an https:// link (or leave it empty).");
    }
    image_url = u.href;
  } else image_url = null;
  return { title, description, category, price, stock, buyer_prompt, image_url };
}

async function createListing(me, b) {
  await ready;
  const staff = isStaff(me);
  const v = validateListing(b);
  const official = staff && (b.official === "1" || b.official === "on");
  if (!official) {
    const u = (await getQuery("SELECT level FROM users WHERE userId = ?", [me.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    if (!staff && (u.level || 0) < settings.min_level) {
      throw new Refuse(403, `You need to be level ${settings.min_level} to sell in the shop (you're level ${u.level || 0}).`);
    }
    const n = await getQuery("SELECT COUNT(*) AS n FROM prizes WHERE seller_id = ? AND status != 'removed'", [me.userId]);
    if (n[0].n >= MAX_LISTINGS) throw new Refuse(400, `You can have up to ${MAX_LISTINGS} listings — remove an old one first.`);
  }
  const status = official || staff || !settings.require_approval ? "active" : "pending_review";
  const id = uuidv4(), now = Date.now();
  await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, seller_id, description, category, delivery, image_url,
      buyer_prompt, status, sold, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, v.title, v.price, v.stock, official ? null : me.userId, v.description || null, v.category,
     official ? "instant" : "manual", v.image_url, official ? null : v.buyer_prompt, status, now, now]);
  return { id, status };
}

async function getListing(id) {
  const r = await getQuery(`SELECT p.*, u.username AS seller_name, u.displayname AS seller_display, u.avatar AS seller_avatar
    FROM prizes p LEFT JOIN users u ON u.userId = p.seller_id WHERE p.prizeId = ?`, [String(id || "")]);
  return r[0] || null;
}

async function editListing(me, id, b) {
  await ready;
  const p = await getListing(id);
  const staff = isStaff(me);
  if (!p || (!staff && p.seller_id !== me.userId)) throw new Refuse(404, "No such listing.");
  if (p.status === "removed" && !staff) throw new Refuse(400, "That listing was removed.");
  const v = validateListing(b);
  const contentChanged = v.title !== p.prize || (v.description || "") !== (p.description || "") || v.category !== p.category ||
                         (v.image_url || "") !== (p.image_url || "") || (v.buyer_prompt || "") !== (p.buyer_prompt || "");
  let status = p.status;
  // Changing what's being sold sends a listing back to review (no approve-then-swap).
  if (!staff && p.seller_id && settings.require_approval && contentChanged && (status === "active" || status === "paused")) status = "pending_review";
  await runQuery(`UPDATE prizes SET prize = ?, description = ?, category = ?, cost = ?, quantity = ?, image_url = ?, buyer_prompt = ?,
      status = ?, updated = ? WHERE prizeId = ?`,
    [v.title, v.description || null, v.category, v.price, v.stock, v.image_url, p.seller_id ? v.buyer_prompt : null, status, Date.now(), p.prizeId]);
  return { status, reviewed: status === "pending_review" && p.status !== "pending_review" };
}

// op: pause | activate | remove (seller) ; approve | reject | remove | restore (staff)
async function listingStatus(me, id, op, note) {
  await ready;
  const p = await getListing(id);
  const staff = isStaff(me);
  if (!p || (!staff && p.seller_id !== me.userId)) throw new Refuse(404, "No such listing.");
  const set = async (to, from, extra) => {
    const r = await runQuery(`UPDATE prizes SET status = ?, review_note = ?, updated = ? WHERE prizeId = ? AND status IN (${from.map(() => "?").join(",")})`,
                             [to, extra === undefined ? p.review_note : extra, Date.now(), p.prizeId, ...from]);
    if (!r.changes) throw new Refuse(409, "That listing changed in the meantime — reload.");
  };
  const why = oneLine(note, 300) || null;
  if (op === "pause") { await set("paused", ["active"]); return "Paused — buyers can't see it until you resume it."; }
  if (op === "activate") {
    if (p.status === "paused") { await set("active", ["paused"]); return "Back on sale."; }
    throw new Refuse(400, "Only a paused listing can be resumed.");
  }
  if (op === "remove") { await set("removed", ["active", "paused", "pending_review"], staff && p.seller_id !== me.userId ? why : p.review_note); return "Removed."; }
  if (!staff) throw new Refuse(403, "Admins only.");
  if (op === "approve") { await set("active", ["pending_review"], null); return "Approved."; }
  if (op === "reject") { await set("removed", ["pending_review"], why || "Rejected"); return "Rejected."; }
  if (op === "restore") { await set("paused", ["removed"], null); return "Restored (paused)."; }
  throw new Refuse(400, "Unknown action.");
}

// ── queries for pages ──
const likeArg = (s) => "%" + String(s).replace(/[\\%_]/g, (c) => "\\" + c) + "%";

async function browse(q) {
  await ready;
  const where = ["p.status = 'active'"], args = [];
  const term = oneLine(q.q, 80);
  if (term) {
    where.push("(p.prize LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.displayname LIKE ? ESCAPE '\\')");
    const l = likeArg(term); args.push(l, l, l, l);
  }
  const cat = settings.categories.includes(String(q.cat)) ? String(q.cat) : "";
  if (cat) { where.push("p.category = ?"); args.push(cat); }
  const min = toInt(q.min), max = toInt(q.max);
  if (min > 0) { where.push("p.cost >= ?"); args.push(min); }
  if (max > 0) { where.push("p.cost <= ?"); args.push(max); }
  const seller = oneLine(q.seller, 60);
  if (seller) { where.push("LOWER(u.username) = LOWER(?)"); args.push(seller); }
  const instock = q.instock === "1";
  if (instock) where.push("p.quantity > 0");
  const official = q.official === "1";
  if (official) where.push("p.seller_id IS NULL");
  const sorts = {
    newest: "COALESCE(p.created, CAST(strftime('%s', p.timestamp) AS INTEGER) * 1000) DESC",
    price_asc: "p.cost ASC", price_desc: "p.cost DESC", popular: "COALESCE(p.sold, 0) DESC",
  };
  const sort = sorts[q.sort] ? q.sort : "newest";
  const from = `FROM prizes p LEFT JOIN users u ON u.userId = p.seller_id WHERE ${where.join(" AND ")}`;
  const total = (await getQuery(`SELECT COUNT(*) AS n ${from}`, args))[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, toInt(q.page) || 1));
  const items = await getQuery(`SELECT p.prizeId, p.prize, p.cost, p.quantity, p.seller_id, p.category, p.image_url, p.description,
      p.sold, p.delivery, p.buyer_prompt, u.username AS seller_name, u.displayname AS seller_display
    ${from} ORDER BY (p.quantity > 0) DESC, ${sorts[sort]}, p.prizeId LIMIT ? OFFSET ?`, [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  const cats = await getQuery("SELECT category, COUNT(*) AS n FROM prizes WHERE status = 'active' GROUP BY category");
  return { items, total, page, pages, sort, filters: { q: term, cat, min: min > 0 ? min : "", max: max > 0 ? max : "", seller, instock, official },
           catCounts: Object.fromEntries(cats.map((c) => [c.category || "", c.n])) };
}

async function sellerSales(userId) {
  const r = await getQuery("SELECT COUNT(*) AS n FROM shop_orders WHERE seller_id = ? AND status IN ('fulfilled','completed')", [userId]);
  return r[0].n;
}

async function eventsFor(ids) {
  if (!ids.length) return {};
  const rows = await getQuery(`SELECT * FROM shop_order_events WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
  const out = {};
  for (const e of rows) (out[e.order_id] = out[e.order_id] || []).push(e);
  return out;
}

const ORDER_COLS = `o.*, b.username AS buyer_name, s.username AS seller_name`;
const ORDER_JOIN = `FROM shop_orders o LEFT JOIN users b ON b.userId = o.buyer_id LEFT JOIN users s ON s.userId = o.seller_id`;

async function revenue(userId) {
  const now = Date.now(), out = {};
  for (const [k, since] of [["d7", now - 7 * DAY], ["d30", now - 30 * DAY], ["all", 0]]) {
    const r = await getQuery(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS gross, COALESCE(SUM(fee),0) AS fees, COALESCE(SUM(net),0) AS net
      FROM shop_orders WHERE seller_id = ? AND seller_paid = 1 AND status IN ('fulfilled','completed','disputed') AND fulfilled_at >= ?`, [userId, since]);
    out[k] = r[0];
  }
  const held = await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS t FROM shop_orders WHERE seller_id = ? AND status IN ('paid') ", [userId]);
  out.held = held[0];
  out.best = await getQuery(`SELECT title, COUNT(*) AS n, SUM(net) AS net FROM shop_orders WHERE seller_id = ? AND seller_paid = 1
    AND status IN ('fulfilled','completed','disputed') GROUP BY prize_id, title ORDER BY n DESC, net DESC LIMIT 5`, [userId]);
  return out;
}

// ── view helpers (passed to every shop view as H) ──
const H = {
  fmt: (n) => Math.floor(Number(n) || 0).toLocaleString("en-US"),
  when: (ms) => ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
  day: (ms) => ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "",
  av: (a) => (a && /^(https:\/\/|\/)/.test(String(a)) ? String(a) : "/public/img/avatar.png"),
  status: (s) => STATUS[s] || { label: s, color: "#ccc" },
  lstatus: (s) => LISTING_STATUS[s] || { label: s, color: "#ccc" },
  qs: (base, patch) => {
    const p = Object.assign({}, base, patch);
    const parts = Object.entries(p).filter(([, v]) => v !== "" && v != null && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(v === true ? "1" : v)}`);
    return parts.length ? "?" + parts.join("&") : "";
  },
};

const safeBack = (b, dflt) => (/^\/shop[A-Za-z0-9/_?=&.%#-]*$/.test(String(b || "")) ? String(b) : dflt);
const withMsg = (back, msg) => {
  const [path, hash] = back.split("#");
  return path + (path.includes("?") ? "&" : "?") + "msg=" + encodeURIComponent(msg) + (hash ? "#" + hash : "");
};

// ── routes ──
function register(app, deps) {
  const { isBotToken, addUser, requireUser } = deps;
  D = { achievements: deps.achievements || null, discordBridge: deps.discordBridge || null, userRoles: deps.userRoles || null };
  const timer = setInterval(() => sweep().catch((e) => console.error("[shop] sweep:", e.message)), 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  ready.then(() => setTimeout(() => sweep().catch(() => {}), 30 * 1000).unref());

  const msgOf = (req) => (req.query.msg ? String(req.query.msg).slice(0, 300) : null);
  async function meOf(req) {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, displayname, class, level, points_balance, email, camfrogUsername FROM users WHERE userId = ?",
                              [req.user.userId]))[0];
    return u ? { ...u, staff: isStaff(u) } : null;
  }
  const base = (req, me, extra) => Object.assign({ user: me ? me.username : (req.user ? req.user.username : null), me, H,
    msg: msgOf(req), settings, categories: settings.categories }, extra);
  // Form posts: run, then go back with a message.
  const formPost = (dflt, fn) => [addUser, async (req, res) => {
    const back = safeBack((req.body || {}).back, dflt);
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      const me = await meOf(req);
      if (!me) return res.redirect("/login");
      const r = await fn(req, me);
      res.redirect(withMsg((r && r.back) || back, (r && r.message) || r || "Done."));
    } catch (e) {
      if (!e.refuse) console.error("[shop]", req.path, e);
      res.redirect(withMsg(back, e.refuse ? e.message : "Something went wrong — nothing changed."));
    }
  }];

  // ── buying ──
  // Website purchase (JSON)
  app.post("/shop", addUser, requireUser, async (req, res) => {
    const r = await purchasePrize({ userId: req.user.userId, username: req.user.username,
                                    prizeId: req.body.product, source: "website", buyerInput: req.body.buyer_input,
                                    expectedCost: req.body.price });
    const { status, ...body } = r;
    res.status(status).json(body);
  });

  // Discord bot purchase (discord-bot/commands/shop.js) - same response shape it always had.
  app.post("/chatshop", async (req, res) => {
    const { product, username, userId, password } = req.body;
    if (password !== process.env.TWITCH_BOT_TOKEN) {
      return res.status(403).send("Access denied");
    }
    const r = await purchasePrize({ userId, username, prizeId: product, source: "discord" });
    if (r.success) return res.json({ success: true, message: "Purchase successful" });
    return res.status(r.status).json({ success: false, message: r.message });
  });

  // Pepe (Camfrog) purchase: bot-only, by Camfrog login.
  app.post("/api/shop/camfrog/buy", async (req, res) => {
    const { camfrogUsername, prizeId, botToken } = req.body || {};
    if (!isBotToken(botToken)) {
      return res.status(403).json({ success: false, message: "forbidden" });
    }
    const users = await getQuery(
      "SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?)", [camfrogUsername || ""]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: "no PATV account for that Camfrog user" });
    }
    const r = await purchasePrize({ userId: users[0].userId, username: users[0].username,
                                    prizeId, source: "camfrog" });
    const { status, ...body } = r;
    res.status(status).json({ ...body, username: users[0].username });
  });

  // The official store's items (Discord /chatshop and Pepe list these). Marketplace listings are
  // not included: those bots can't ask the buyer for delivery details.
  app.get("/api/prizes", async (req, res) => {
    try {
      await ready;
      const rows = await getQuery("SELECT prizeId, prize, cost, quantity FROM prizes WHERE seller_id IS NULL AND status = 'active'");
      // the spin boost's cost here is its first-copy price; buying it charges the buyer's own price
      res.json(rows.map((row) => ({ prize: row.prize, cost: row.cost, prizeId: row.prizeId, quantity: row.quantity,
        ...(row.prizeId === SPINBOOST_ID ? { cost_note: `${SPINBOOST_BASE.toLocaleString()} for your first, +${SPINBOOST_STEP.toLocaleString()} for each one you own` } : {}) })));
    } catch (error) {
      console.error(error);
      res.status(500).send("Failed to retrieve prizes.");
    }
  });

  // ── browsing ──
  app.get("/shop", addUser, async (req, res) => {
    try {
      const me = await meOf(req);
      const data = await browse(req.query);
      await personalise(data.items, me && me.userId);
      res.render("shop", base(req, me, { ...data, store: null }));
    } catch (e) {
      console.error("[shop] browse:", e);
      res.status(500).send("Couldn't load the shop.");
    }
  });

  app.get("/shop/item/:id", addUser, async (req, res) => {
    try {
      await ready;
      const me = await meOf(req);
      const p = await getListing(req.params.id);
      const canSee = p && (p.status === "active" || (me && (me.staff || me.userId === p.seller_id)));
      if (!canSee) return res.status(404).render("shopItem", base(req, me, { p: null, sales: 0, more: [] }));
      await personalise([p], me && me.userId);
      const sales = p.seller_id ? await sellerSales(p.seller_id) : 0;
      const more = await getQuery(`SELECT prizeId, prize, cost, quantity, image_url FROM prizes WHERE status = 'active' AND prizeId != ?
        AND ${p.seller_id ? "seller_id = ?" : "seller_id IS NULL"} ORDER BY COALESCE(sold,0) DESC LIMIT 6`,
        p.seller_id ? [p.prizeId, p.seller_id] : [p.prizeId]);
      if (!p.seller_id) await personalise(more, me && me.userId);
      // 1.99jp: an official item that's also sold as a subscription (subscriptions.js)
      let sub = null;
      if (!p.seller_id) {
        try { const SUB = require("./subscriptions"); await SUB.init(); const c = SUB.config(); if (c.enabled && c.items[p.prizeId]) sub = { days: c.items[p.prizeId].days }; } catch (e) { sub = null; }
      }
      res.render("shopItem", base(req, me, { p, sales, more, sub }));
    } catch (e) {
      console.error("[shop] item:", e);
      res.status(500).send("Couldn't load that item.");
    }
  });

  // ── seller dashboard ──
  app.get("/shop/seller", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      await ready;
      const me = await meOf(req);
      if (!me) return res.redirect("/login");
      const listings = await getQuery(`SELECT * FROM prizes WHERE seller_id = ? ORDER BY CASE status WHEN 'removed' THEN 1 ELSE 0 END,
        COALESCE(updated, created) DESC LIMIT 200`, [me.userId]);
      const todo = await getQuery(`SELECT ${ORDER_COLS} ${ORDER_JOIN} WHERE o.seller_id = ? AND o.status IN ('paid','disputed') ORDER BY o.id LIMIT 200`, [me.userId]);
      const history = await getQuery(`SELECT ${ORDER_COLS} ${ORDER_JOIN} WHERE o.seller_id = ? AND o.status NOT IN ('paid') ORDER BY o.id DESC LIMIT 50`, [me.userId]);
      const rev = await revenue(me.userId);
      const prefs = await prefsFor(me.userId);
      const canSell = me.staff || (me.level || 0) >= settings.min_level;
      const edit = req.query.edit ? listings.find((l) => l.prizeId === req.query.edit) || null : null;
      res.render("shopSeller", base(req, me, { listings, todo, history, rev, prefs, canSell, edit, sales: await sellerSales(me.userId) }));
    } catch (e) {
      console.error("[shop] seller:", e);
      res.status(500).send("Couldn't load your seller dashboard.");
    }
  });

  // A seller's storefront
  app.get("/shop/seller/:username", addUser, async (req, res) => {
    try {
      await ready;
      const me = await meOf(req);
      const s = (await getQuery("SELECT userId, username, displayname, avatar, created_at FROM users WHERE LOWER(username) = LOWER(?)",
                                [String(req.params.username)]))[0];
      if (!s) return res.status(404).render("shop", base(req, me, { items: [], total: 0, page: 1, pages: 1, sort: "newest", filters: {}, catCounts: {},
                                                                     store: { missing: String(req.params.username).slice(0, 60) } }));
      const data = await browse({ ...req.query, seller: s.username });
      res.render("shop", base(req, me, { ...data, store: { ...s, sales: await sellerSales(s.userId) } }));
    } catch (e) {
      console.error("[shop] storefront:", e);
      res.status(500).send("Couldn't load that shop.");
    }
  });

  app.post("/shop/listing", ...formPost("/shop/seller", async (req, me) => {
    const r = await createListing(me, req.body || {});
    return { message: r.status === "pending_review" ? "Listed — it goes live once an admin approves it." : "Listed — it's live.",
             back: me.staff && (req.body || {}).official ? "/shop/admin" : "/shop/seller#listings" };
  }));
  app.post("/shop/listing/:id", ...formPost("/shop/seller#listings", async (req, me) => {
    const r = await editListing(me, req.params.id, req.body || {});
    return r.reviewed ? "Saved — the changes go live once an admin approves them." : "Saved.";
  }));
  app.post("/shop/listing/:id/:op", ...formPost("/shop/seller#listings", async (req, me) => {
    return listingStatus(me, req.params.id, String(req.params.op), (req.body || {}).note);
  }));

  app.post("/shop/prefs", ...formPost("/shop/seller#notify", async (req, me) => {
    const b = req.body || {};
    await runQuery(`INSERT INTO shop_prefs (user_id, email_off, pm_off) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET email_off = excluded.email_off, pm_off = excluded.pm_off`,
      [me.userId, b.email ? 0 : 1, b.pm ? 0 : 1]);
    return "Notification settings saved.";
  }));

  // ── orders ──
  app.get("/shop/orders", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      await ready;
      const me = await meOf(req);
      if (!me) return res.redirect("/login");
      const page = Math.max(1, toInt(req.query.page) || 1);
      const total = (await getQuery("SELECT COUNT(*) AS n FROM shop_orders WHERE buyer_id = ?", [me.userId]))[0].n;
      const orders = await getQuery(`SELECT ${ORDER_COLS} ${ORDER_JOIN} WHERE o.buyer_id = ? ORDER BY o.id DESC LIMIT 30 OFFSET ?`,
                                    [me.userId, (page - 1) * 30]);
      const events = await eventsFor(orders.map((o) => o.id));
      const spent = (await getQuery(`SELECT COALESCE(SUM(price),0) AS t, COUNT(*) AS n FROM shop_orders WHERE buyer_id = ?
        AND status NOT IN ('cancelled','refunded')`, [me.userId]))[0];
      const open = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS t FROM shop_orders WHERE buyer_id = ? AND status IN ('paid','fulfilled','disputed')", [me.userId]))[0];
      res.render("shopOrders", base(req, me, { orders, events, spent, open, page, pages: Math.max(1, Math.ceil(total / 30)) }));
    } catch (e) {
      console.error("[shop] orders:", e);
      res.status(500).send("Couldn't load your orders.");
    }
  });

  app.get("/shop/orders/:id", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      await ready;
      const me = await meOf(req);
      if (!me) return res.redirect("/login");
      const o = await getOrder(req.params.id);
      if (!o || !(me.staff || o.buyer_id === me.userId || o.seller_id === me.userId)) {
        return res.status(404).render("shopOrder", base(req, me, { o: null, events: [], role: null }));
      }
      const events = (await eventsFor([o.id]))[o.id] || [];
      const role = o.buyer_id === me.userId ? "buyer" : o.seller_id === me.userId ? "seller" : "admin";
      res.render("shopOrder", base(req, me, { o, events, role }));
    } catch (e) {
      console.error("[shop] order:", e);
      res.status(500).send("Couldn't load that order.");
    }
  });

  app.post("/shop/orders/:id/:op", ...formPost("/shop/orders", async (req, me) => {
    const op = String(req.params.op);
    if (!["fulfil", "refund", "cancel", "confirm", "dispute", "resolve_seller", "resolve_buyer"].includes(op)) throw new Refuse(404, "Unknown action.");
    const b = req.body || {};
    const r = await orderAction(req.params.id, op, { userId: me.userId, username: me.username, staff: me.staff },
                                { note: b.note, reason: b.reason });
    return { message: r.message, back: safeBack(b.back, `/shop/orders/${parseInt(req.params.id, 10) || 0}`) };
  }));

  // ── admin ──
  const staffPage = (fn) => async (req, res) => {
    const me = await meOf(req).catch(() => null);
    if (!me || !me.staff) {
      if (req.flash) req.flash("error", "Access denied. You must be an admin or staff to access this page.");
      return res.redirect("/login");
    }
    return fn(req, res, me);
  };

  app.get("/shop/admin", addUser, staffPage(async (req, res, me) => {
    try {
      await ready;
      const review = await getQuery(`SELECT p.*, u.username AS seller_name FROM prizes p LEFT JOIN users u ON u.userId = p.seller_id
        WHERE p.status = 'pending_review' ORDER BY p.updated LIMIT 100`);
      const disputes = await getQuery(`SELECT ${ORDER_COLS}, (SELECT points_balance FROM users WHERE userId = o.seller_id) AS seller_balance
        ${ORDER_JOIN} WHERE o.status = 'disputed' ORDER BY o.updated LIMIT 100`);
      const ost = Object.keys(STATUS).includes(req.query.ostatus) ? req.query.ostatus : "";
      const page = Math.max(1, toInt(req.query.page) || 1);
      const owhere = ost ? "WHERE o.status = ?" : "", oargs = ost ? [ost] : [];
      const ototal = (await getQuery(`SELECT COUNT(*) AS n FROM shop_orders o ${owhere}`, oargs))[0].n;
      const orders = await getQuery(`SELECT ${ORDER_COLS} ${ORDER_JOIN} ${owhere} ORDER BY o.id DESC LIMIT 50 OFFSET ?`, [...oargs, (page - 1) * 50]);
      const lq = oneLine(req.query.lq, 80);
      const listings = await getQuery(`SELECT p.prizeId, p.prize, p.cost, p.quantity, p.status, p.seller_id, p.sold, u.username AS seller_name
        FROM prizes p LEFT JOIN users u ON u.userId = p.seller_id
        ${lq ? "WHERE p.prize LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'" : ""}
        ORDER BY (p.seller_id IS NULL) DESC, COALESCE(p.updated, p.created, 0) DESC LIMIT 100`, lq ? [likeArg(lq), likeArg(lq)] : []);
      const stats = (await getQuery(`SELECT COUNT(*) AS n, COALESCE(SUM(fee),0) AS fees, COALESCE(SUM(CASE WHEN status IN ('paid','disputed') AND seller_paid = 0 THEN price ELSE 0 END),0) AS held
        FROM shop_orders WHERE official = 0`))[0];
      let subsCfg = null;          // 1.99jp: subscriptions.js config (its own form below the settings)
      try { const SUB = require("./subscriptions"); await SUB.init(); subsCfg = SUB.config(); } catch (e) { subsCfg = null; }
      res.render("shopAdmin", base(req, me, { review, disputes, orders, ost, page, opages: Math.max(1, Math.ceil(ototal / 50)), listings, lq, stats, subsCfg }));
    } catch (e) {
      console.error("[shop] admin:", e);
      res.status(500).send("Couldn't load the shop admin.");
    }
  }));

  app.get("/shop/admin/edit/:id", addUser, staffPage(async (req, res, me) => {
    await ready;
    const p = await getListing(req.params.id);
    res.status(p ? 200 : 404).render("shopEdit", base(req, me, { p }));
  }));

  app.post("/shop/admin/settings", ...formPost("/shop/admin#settings", async (req, me) => {
    if (!me.staff) throw new Refuse(403, "Admins only.");
    const b = req.body || {};
    const fee = Number(b.fee_pct), lvl = toInt(b.min_level), ac = toInt(b.auto_complete_days), ax = toInt(b.auto_cancel_days);
    if (!(fee >= 0 && fee <= 50)) throw new Refuse(400, "Fee must be 0–50%.");
    if (!(lvl >= 0 && lvl <= 1000)) throw new Refuse(400, "Min level must be 0–1000.");
    if (!(ac >= 1 && ac <= 90)) throw new Refuse(400, "Auto-complete must be 1–90 days.");
    if (!(ax >= 0 && ax <= 365)) throw new Refuse(400, "Auto-refund must be 0–365 days.");
    const cats = [...new Set(String(b.categories || "").split(/\r?\n/).map((c) => oneLine(c, 40)).filter(Boolean))].slice(0, 40);
    if (!cats.length) throw new Refuse(400, "Keep at least one category.");
    await saveSettings({ fee_pct: Math.round(fee * 100) / 100, require_approval: b.require_approval ? 1 : 0, min_level: lvl,
                         auto_complete_days: ac, auto_cancel_days: ax, categories: cats });
    return "Shop settings saved.";
  }));

  // Legacy official-item manager (kept; edits official items only)
  app.get("/admin/manage-prizes", addUser, (req, res) => {
    const userType = req.user ? req.user.class : null;
    const username = req.user ? req.user.username : null;
    if (userType === "Admin" || userType === "Staff") {
      res.render("managePrizes", { user: username });
    } else {
      req.flash("error", "Access denied. You must be an admin or staff to access this page.");
      res.redirect("/login");
    }
  });

  app.post("/api/prizes/edit", addUser, async (req, res) => {
    const userType = req.user ? req.user.class : null;
    if (userType === "Admin" || userType === "Staff") {
      const { action, prizeId, prizeName, cost, quantity } = req.body;
      try {
        await ready;
        if (action === "add") {
          if (prizeId) {
            const r = await runQuery("UPDATE prizes SET prize = ?, cost = ?, quantity = ?, updated = ? WHERE prizeId = ? AND seller_id IS NULL",
                                     [prizeName, cost, quantity, Date.now(), prizeId]);
            if (!r.changes) return res.status(404).send("Prize not found.");
            res.json({ message: "Prize updated successfully." });
          } else {
            await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, delivery, status, sold, created, updated)
                            VALUES (?, ?, ?, ?, 'instant', 'active', 0, ?, ?)`,
                           [uuidv4(), prizeName, cost, quantity, Date.now(), Date.now()]);
            res.json({ message: "Prize added successfully." });
          }
        } else if (action === "remove") {
          // Official items only: a marketplace listing with the same name is never touched.
          const result = await runQuery("DELETE FROM prizes WHERE prize = ? AND seller_id IS NULL", [prizeName]);
          if (result.changes) res.json({ message: "Prize removed successfully." });
          else res.status(404).send("Prize not found.");
        } else {
          res.status(400).send("Invalid action specified.");
        }
      } catch (error) {
        console.error(error);
        res.status(500).send("Failed to process prize.");
      }
    } else {
      req.flash("error", "Access denied. You must be an admin or staff to access this page.");
      return res.redirect("/login");
    }
  });
}

module.exports = { register, purchasePrize, orderAction, onOfficialSale, chargeService, chargeRenewal, refundService, getOrder, event, createListing, editListing, listingStatus, sweep, settings, saveSettings,
                   ready, ROLE_PRIZES, STORE_OWNER_USERNAME, notify,
                   SPINBOOST_ID, SPINBOOST_SPINS, SPINBOOST_BASE, SPINBOOST_STEP, spinboostPrice, spinboostOwned, priceFor, personalise };
