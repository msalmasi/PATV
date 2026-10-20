// actionttl.js — 1.99ne: website actions queued for Pepe expire.
//
// Three queues hold things the site asks Pepe to do as a user: pepe_actions (actions.js: /act forms, the casino seat
// lane, DJ, room control, saves, ...), market_orders (markets.js: bets / sells / resolves) and bounty_actions
// (bounties.js). None had an age limit: an action queued while Pepe was down ran whenever he came back - a market bet
// at a price hours later, a seat move at a table long gone.
//
// Now each kind has a time-to-live (TTL_DEFAULTS, minutes; admins override any key in action_ttl_config through
// GET/POST /api/admin/action-ttl). A sweep (every 60 s, and right before every claim) expires a row that is still
// PENDING past its TTL:
//   * any PAT the site escrowed for it is refunded (REFUNDS: no queue escrows on the site today - Pepe charges when he
//     runs the action - so this only tidies the aigen job it points at);
//   * the row is marked: status 'failed' (every page already shows that), code E_TIMEOUT, expired_at = now;
//   * the user gets a notice (inbox + their Telegram alert), except for internal / short-lived kinds (NO_NOTICE).
// Only rows nobody claimed yet are expired here: a claimed row may already be running in Pepe. For those the claim
// payload carries expires_at, and Pepe refuses to START one past it (he still answers one he already ran from his
// journal), so a row he claimed before a crash isn't run hours late either.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const MIN = 60000;
// minutes. Keys: "cmd:<command>" (kind cmd), "<kind>" (pepe_actions), "market:<kind>", "bounty:<kind>", "default".
const TTL_DEFAULTS = Object.freeze({
  // /act chat commands (Pepe charges when he runs them)
  "cmd:market": 15, "cmd:pool": 30, "cmd:wager": 30, "cmd:bounty": 60, "cmd:stash": 30, "cmd:loan": 60,
  "cmd:lotto": 15, "cmd:cosmetic": 30, "cmd:avatar": 60, "cmd:sheet": 60, "cmd:donate": 60,
  // other website actions
  "poll.vote": 30, "poll.create": 30, "poll.end": 30,
  "table": 2,                          // a seat move only makes sense at the table it was made for
  "privacy.incognito": 15,            // 1.99wa: Settings → Privacy (incognito.js)
  "privacy.forgetme": 1440,           // 1.99aat: 🧠 Settings → Privacy "Make Pepe forget me" (pepeforget.js)
  "privacy.forget": 7 * 1440,         // 1.99wj: a deleted account's Camfrog login - Pepe forgets it (accountdelete.js retries an expired one)
  "dj": 10, "pepe.look": 10, "room.ctl": 15, "room.visit": 30, "room.bridge": 30, "econ.burn": 30, "econ.routes": 30, "econ.cmd": 30,
  "roomvault.admin": 30,               // 1.99yx: /pads/admin pad vault fines / transfers (padfines.js)
  "aigen": 15,                         // = aigen.js QUEUE_TTL (its job is timed out by aigen's own sweep)
  "snap.save": 15, "camclip.save": 15, "micclip.save": 15, "stagecap.save": 30,
  "notify": 1440,                      // a Camfrog PM copy of a notice that is already in the inbox
  // market orders (markets.js)
  "market:buy": 15, "market:sell": 15, "market:resolve": 240,
  // bounty actions (bounties.js)
  "bounty:add": 60, "bounty:claim": 120, "bounty:reject": 120, "bounty:dispute": 240, "bounty:resolve": 240, "bounty:cancel": 240,
  "default": 60,
});
const NO_NOTICE = new Set(["notify", "table", "privacy.forget"]);
const NOTICE_KIND = { market: "market", pool: "market", wager: "wager", bounty: "bounty", loan: "loan", lotto: "lotto",
                      cosmetic: "cosmetics", stash: "staking", donate: "system", avatar: "system" };
const MAX_MIN = 7 * 1440;
const KEY_RE = /^[a-z][a-z0-9_.:-]{0,40}$/;

let overrides = {};
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS action_ttl_config (key TEXT PRIMARY KEY, minutes INTEGER NOT NULL, updated INTEGER, actor TEXT)");
      // the queue tables are made by their own modules; the marker column is added here (idempotent: only where it's
      // missing, after a verified backup of the database - dbbackup.js)
      const todo = [];
      for (const t of ["pepe_actions", "market_orders", "bounty_actions"]) {
        const cols = (await getQuery(`SELECT name FROM pragma_table_info('${t}')`).catch(() => [])).map((r) => r.name);
        if (cols.length && !cols.includes("expired_at")) todo.push(t);
      }
      if (todo.length) {
        const file = await require("./dbbackup").backupDb("pre-action-ttl");
        for (const t of todo) await runQuery(`ALTER TABLE ${t} ADD COLUMN expired_at INTEGER`).catch(() => {});
        console.log(`[actionttl] added expired_at to ${todo.join(", ")} (backup ${file})`);
      }
      await load();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function load() {
  const rows = await getQuery("SELECT key, minutes FROM action_ttl_config");
  const o = {};
  for (const r of rows) if (KEY_RE.test(r.key) && Number.isFinite(Number(r.minutes))) o[r.key] = Math.max(1, Math.min(MAX_MIN, Math.floor(r.minutes)));
  overrides = o;
  return o;
}

const minutesFor = (key) => (key in overrides ? overrides[key] : key in TTL_DEFAULTS ? TTL_DEFAULTS[key] : null);

/** The TTL (ms) of one queued row of `table`. */
function ttlMs(table, row) {
  let key = null;
  if (table === "pepe_actions") {
    if (row.kind === "cmd") {
      let args = row.args;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = []; } }
      key = "cmd:" + String((Array.isArray(args) && args[0]) || "");
    } else key = String(row.kind || "");
  } else if (table === "market_orders") key = "market:" + String(row.kind || "buy");
  else if (table === "bounty_actions") key = "bounty:" + String(row.kind || "");
  const m = (key && minutesFor(key)) || minutesFor("default");
  return m * MIN;
}
/** When a row stops being worth running (ms) - sent to Pepe with every claimed row. */
const expiresAt = (table, row) => (Number(row.created) || Date.now()) + ttlMs(table, row);

const EXPIRED_MSG = (mins) => `Pepe didn't get to this within ${mins >= 120 ? Math.round(mins / 60) + " hours" : mins + " minutes"} ` +
  "(he was offline or busy), so it was cancelled - nothing was done and no PAT was taken. Send it again if you still want it.";
const HINT = "Send it again - it runs as soon as Pepe is back.";

// Escrow refunds per kind. No queue escrows PAT on the site today (Pepe takes it when he runs the action), so the
// only work is pointing the queued aigen job at its fate; a kind that starts escrowing on the site adds its refund here.
const REFUNDS = {
  pepe_actions: {
    aigen: async (row) => {
      let args = [];
      try { args = JSON.parse(row.args || "[]"); } catch (e) { args = []; }
      if (!args[0]) return;
      await runQuery("UPDATE feed_aigen_jobs SET status = 'timeout', finished = ?, message = 'Pepe didn''t pick it up - nothing was charged' WHERE id = ? AND status = 'queued'",
                     [Date.now(), String(args[0])]).catch(() => {});
    },
  },
};

function noticeFor(table, row, mins) {
  let kind = "system", label = row.label || "", link = null;
  if (table === "pepe_actions") {
    if (NO_NOTICE.has(row.kind)) return null;
    let args = [];
    try { args = JSON.parse(row.args || "[]"); } catch (e) { args = []; }
    if (row.kind === "cmd") kind = NOTICE_KIND[args[0]] || "system";
    link = row.tag && /^[a-z0-9_-]{1,40}$/i.test(row.tag) ? "/" + row.tag : null;
  } else if (table === "market_orders") {
    kind = "market"; link = `/markets/${row.market_id}`;
    label = `${row.kind || "buy"} on market #${row.market_id}` + (row.kind === "buy" || !row.kind ? ` (${Number(row.amount || 0).toLocaleString("en-US")} PAT on ${row.option})` : "");
  } else if (table === "bounty_actions") {
    kind = "bounty"; link = `/bounties/${row.bounty_id}`;
    label = `${row.kind} on bounty #${row.bounty_id}`;
  }
  return { kind, title: "Cancelled - Pepe didn't get to it: " + String(label || "a website action").slice(0, 100),
           body: EXPIRED_MSG(mins), link, ref: `actexp:${table}:${row.id}` };
}

const SEL = {
  pepe_actions: "SELECT id, user_id, kind, args, tag, label, created FROM pepe_actions WHERE status = 'pending' AND created < ? ORDER BY id LIMIT 500",
  market_orders: "SELECT id, user_id, market_id, option, amount, kind, created FROM market_orders WHERE status = 'pending' AND created < ? ORDER BY id LIMIT 500",
  bounty_actions: "SELECT id, user_id, bounty_id, kind, amount, created FROM bounty_actions WHERE status = 'pending' AND created < ? ORDER BY id LIMIT 500",
};
const EXPIRE = {
  pepe_actions: "UPDATE pepe_actions SET status = 'failed', message = ?, code = 'E_TIMEOUT', hint = ?, expired_at = ?, updated = ? WHERE id = ? AND status = 'pending'",
  market_orders: "UPDATE market_orders SET status = 'failed', message = ?, expired_at = ?, updated = ? WHERE id = ? AND status = 'pending'",
  bounty_actions: "UPDATE bounty_actions SET status = 'failed', message = ?, expired_at = ?, updated = ? WHERE id = ? AND status = 'pending'",
};

/** Expire the overdue pending rows of one queue. -> [expired rows] */
async function sweepTable(table, now = Date.now()) {
  await init();
  const smallest = Math.min(...Object.values({ ...TTL_DEFAULTS, ...overrides })) * MIN;
  let rows;
  try { rows = await getQuery(SEL[table], [now - smallest]); } catch (e) { return []; }   // queue table not made yet
  const out = [];
  for (const row of rows) {
    const ttl = ttlMs(table, row);
    if (now - Number(row.created || 0) < ttl) continue;
    const mins = Math.round(ttl / MIN);
    const msg = EXPIRED_MSG(mins);
    const args = table === "pepe_actions" ? [msg.slice(0, 400), HINT, now, now, row.id] : [msg.slice(0, 200), now, now, row.id];
    const r = await runQuery(EXPIRE[table], args);
    if (!r || r.changes !== 1) continue;                // claimed (or expired) in the meantime
    out.push(row);
    const refund = (REFUNDS[table] || {})[row.kind];
    if (refund) await refund(row).catch((e) => console.error(`[actionttl] refund ${table} ${row.id}:`, e.message));
    // 1.99add: a website Incognito ON Pepe never claimed - the sticky hidden set hid them at once; undone now (never rejects)
    if (table === "pepe_actions" && row.kind === "privacy.incognito") await require("./incognito").actionsSettled([row.id]);
    const n = noticeFor(table, row, mins);
    if (n && row.user_id) await require("./inbox").addSafe(row.user_id, n);
  }
  if (out.length) console.log(`[actionttl] expired ${out.length} ${table} row(s) Pepe never claimed: ${out.map((r) => r.id).join(", ")}`);
  return out;
}
async function sweep(now = Date.now()) {
  const out = {};
  for (const t of Object.keys(SEL)) out[t] = (await sweepTable(t, now)).length;
  return out;
}

let timer = null;
function start(everyMs = 60000) {
  if (timer) return timer;
  init().catch((e) => console.error("[actionttl] init:", e.message));
  timer = setInterval(() => sweep().catch((e) => console.error("[actionttl] sweep:", e.message)), everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

async function set(key, minutes, actor) {
  await init();
  if (!KEY_RE.test(String(key || ""))) throw Object.assign(new Error("bad key"), { status: 400 });
  if (minutes === null || minutes === undefined || minutes === "") {
    await runQuery("DELETE FROM action_ttl_config WHERE key = ?", [key]);
  } else {
    const m = Math.floor(Number(minutes));
    if (!Number.isFinite(m) || m < 1 || m > MAX_MIN) throw Object.assign(new Error(`minutes must be 1..${MAX_MIN}`), { status: 400 });
    await runQuery(`INSERT INTO action_ttl_config (key, minutes, updated, actor) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET minutes = excluded.minutes, updated = excluded.updated, actor = excluded.actor`,
                   [key, m, Date.now(), actor ? String(actor).slice(0, 60) : null]);
  }
  return load();
}
const view = () => ({ defaults: TTL_DEFAULTS, overrides: { ...overrides } });

function register(app, { addUser }) {
  start();
  const guard = require("./middleware/authGuard");
  const admin = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "ops.action_ttl")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch")) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  app.get("/api/admin/action-ttl", addUser, admin, async (req, res) => {
    try { await init(); res.json({ ok: true, ...view() }); } catch (e) { res.status(500).json({ ok: false, error: "Couldn't load." }); }
  });
  app.post("/api/admin/action-ttl", addUser, admin, async (req, res) => {
    const b = req.body || {};
    try { await set(b.key, b.minutes, req.user.username); res.json({ ok: true, ...view() }); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Couldn't save." }); }
  });
}

module.exports = { init, start, register, sweep, sweepTable, ttlMs, expiresAt, set, view, TTL_DEFAULTS, _load: load };
