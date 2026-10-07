// burns.js - PAT burning, the website side (1.99dk; Pepe's pepe_burn.py is the other half).
//
// Burning is the LAST step of the weekly surplus waterfall (ECONOMY-V2 6.7): once the incentive buffer
// and the Federal Reserve's 25M target are full, the leftover moves into Pepe's BURN RESERVE and is
// destroyed there. That is the only account PAT is ever burned from - never a wallet, the Reserve, the
// House or any vault. The burn reserve lives in Pepe, so every burn happens in Pepe; this module:
//
//   POST /api/g/burns/record   (bot) Pepe publishes each finished burn, keyed (a resend is a no-op).
//                              Only source "burn" is accepted - nothing else can be recorded as burned.
//   GET  /api/burns            (public) the burn log: date, amount, source, reason. No user data: the
//                              admin who burned it is not shown and @handles in a reason are masked.
//   burned()                   total / 7 d / 30 d, added to GET /api/stats/supply and the economy pages.
//   GET  /api/admin/burn       (Admin) Pepe's burn reserve + settings (synced on /api/g/funding-sync),
//                              the full log with the actor, and a reconcile of Pepe's total vs this log.
//   POST /api/admin/burn/nonce, POST /api/admin/burn   (Admin, CSRF, same-site, step-up password every
//                              time, single-use nonce) queue a manual burn of the burn reserve as a
//                              website action (kind "econ.burn") that Pepe runs - the request key is
//                              the idempotency key there. GET /api/admin/burn/:id = that action's result.
//
// Supply: burned PAT is not an account. A burn LOWERS the burn reserve that Pepe reports in his supply
// snapshot, so /api/stats/supply falls by exactly that amount; nothing here adds burns back in.
"use strict";
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const DAY_MS = 86400 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{4,80}$/;
const pwFails = guard.limiter({ max: 5, windowMs: 15 * 60 * 1000 });
const state = { panel: null, at: 0 };       // Pepe's _burn_panel(), synced with the Reserve
let now = () => Date.now();
function _setClock(fn) { now = fn; }

let ready = null;
function ensure() {
  ready = ready || runQuery(`CREATE TABLE IF NOT EXISTS pat_burns (
      key TEXT PRIMARY KEY, id TEXT, at INTEGER NOT NULL, source TEXT NOT NULL, amount INTEGER NOT NULL,
      reason TEXT, actor_kind TEXT, actor TEXT, recorded_at INTEGER)`)
    .then(() => runQuery("CREATE INDEX IF NOT EXISTS idx_pat_burns_at ON pat_burns (at)"))
    .catch((e) => { ready = null; throw e; });
  return ready;
}

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
function fail(status, message) { const e = new Error(message); e.status = status; return e; }

/** Pepe publishes finished burns. Returns the keys now on record (new or already there). */
async function record(list) {
  await ensure();
  const out = [];
  for (const b of (Array.isArray(list) ? list : []).slice(0, 50)) {
    if (!b || typeof b !== "object") continue;
    const key = String(b.key || "");
    const amount = Math.floor(Number(b.amount));
    if (!KEY_RE.test(key) || b.source !== "burn" || !Number.isFinite(amount) || amount <= 0 || amount > 1e13) continue;
    const at = Math.floor(Number(b.ts)) || now();
    const kind = ["admin", "auto", "waterfall"].includes(b.actor_kind) ? b.actor_kind : "admin";
    await runQuery(`INSERT OR IGNORE INTO pat_burns (key, id, at, source, amount, reason, actor_kind, actor, recorded_at)
                    VALUES (?, ?, ?, 'burn', ?, ?, ?, ?, ?)`,
      [key, clean(b.id, 20), at, amount, clean(b.reason, 200), kind, clean(b.actor, 60), now()]);
    out.push(key);
  }
  return out;
}

async function burned() {
  await ensure();
  const t = now();
  const r = (await getQuery(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN at >= ? THEN amount ELSE 0 END), 0) AS d7,
      COALESCE(SUM(CASE WHEN at >= ? THEN amount ELSE 0 END), 0) AS d30, MAX(at) AS last FROM pat_burns`,
    [t - 7 * DAY_MS, t - 30 * DAY_MS]))[0] || {};
  return { total: Number(r.total) || 0, d7: Number(r.d7) || 0, d30: Number(r.d30) || 0, count: Number(r.n) || 0, last: r.last || null };
}

const SOURCE_LABEL = { burn: "🔥 Burn reserve (surplus after the incentive buffer and the Reserve were full)" };
const maskHandles = (s) => String(s || "").replace(/@[A-Za-z0-9_.-]+/g, "@…");

/** The public log: no user data (no actor, @handles masked). */
async function publicLog({ limit = 50, before = null } = {}) {
  await ensure();
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  const rows = before
    ? await getQuery("SELECT id, at, source, amount, reason, actor_kind FROM pat_burns WHERE at < ? ORDER BY at DESC LIMIT ?", [Number(before) || 0, lim])
    : await getQuery("SELECT id, at, source, amount, reason, actor_kind FROM pat_burns ORDER BY at DESC LIMIT ?", [lim]);
  return rows.map((r) => ({ id: r.id, at: r.at, amount: r.amount, source: r.source, sourceLabel: SOURCE_LABEL[r.source] || r.source,
                            reason: maskHandles(r.reason), how: r.actor_kind === "admin" ? "admin" : r.actor_kind === "waterfall" ? "waterfall" : "automatic" }));
}

/** Pepe's burn panel, from /api/g/funding-sync. */
function sync(panel) {
  if (panel && typeof panel === "object") { state.panel = panel; state.at = now(); }
}

async function adminView() {
  await ensure();
  const log = await getQuery("SELECT id, at, source, amount, reason, actor_kind, actor FROM pat_burns ORDER BY at DESC LIMIT 30");
  const site = await burned();
  const p = state.panel;
  const pepeTotal = p && p.stats ? Number(p.stats.total) || 0 : null;
  return { pepe: p, syncedAt: state.at, burned: site, log,
           reconcile: { pepe: pepeTotal, site: site.total, ok: pepeTotal === null ? null : pepeTotal === site.total,
                        note: pepeTotal !== null && pepeTotal > site.total ? "some burns are still being published" : null } };
}

/** An admin asks Pepe to burn (part of) the burn reserve. Throws {status, message} when refused. */
async function request(user, { amount, reason, nonce, password }, ip) {
  await ensure();
  const ctl = require("./pepecontrol");
  if (!user || user.class !== "Admin") throw fail(403, "Admins only.");
  if (!ctl.takeNonce(user, nonce)) throw fail(409, "That confirmation was already used or has expired - start again.");
  const who = String(user.username || "").toLowerCase();
  const wait = pwFails.blocked(who);
  if (wait) throw fail(429, "Too many wrong passwords. Try again in " + guard.waitText(wait) + ".");
  const row = (await getQuery("SELECT password FROM users WHERE userId = ?", [user.userId]))[0];
  const hash = row && typeof row.password === "string" && row.password.startsWith("$2") ? row.password : null;
  if (!hash) throw fail(403, "Your account has no password to confirm with - set one (forgot password) first.");
  if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 200 || !(await bcrypt.compare(password, hash))) {
    pwFails.hit(who);
    throw fail(403, "Wrong password.");
  }
  pwFails.reset(who);
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw fail(400, "Enter a positive amount.");
  const p = state.panel;
  if (!p || now() - state.at > 10 * 60 * 1000) throw fail(409, "Pepe hasn't synced the burn reserve recently - he may be offline.");
  if (amt > Number(p.max_now || 0)) throw fail(400, "Pepe allows at most " + Number(p.max_now || 0).toLocaleString("en-US") + " PAT right now (the burn reserve and the caps).");
  const key = crypto.randomBytes(12).toString("hex");
  const why = clean(reason, 200) || "admin burn (website)";
  const id = await require("./actions").queue(user.userId, { kind: "econ.burn", args: [String(amt), why, key], tag: "econ-burn",
    label: "Burn " + amt.toLocaleString("en-US") + " PAT from the burn reserve" });
  console.log(`[burns] ${user.username} asked Pepe to burn ${amt} PAT (action ${id}, ip ${ctl.ipHash(ip)})`);
  return { id, key, amount: amt };
}

async function actionResult(id) {
  const r = (await getQuery("SELECT id, status, message, label, created, updated FROM pepe_actions WHERE id = ? AND kind = 'econ.burn'",
    [parseInt(id, 10) || 0]))[0];
  if (!r) throw fail(404, "No such burn request.");
  return r;
}

function register(app, { isBotToken, addUser }) {
  ensure().catch((e) => console.error("[burns] init:", e.message));
  const ctl = require("./pepecontrol");
  const bot = (req, res, next) => (isBotToken((req.body || {}).password) ? next() : res.status(403).json({ error: "unauthorized" }));
  const admin = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in first." });
    if (req.user.class !== "Admin") return res.status(403).json({ error: "Admins only." });
    next();
  };
  const csrf = (req, res, next) => {
    if (!guard.sameSite(req) || !ctl.csrfOk(req.user.username, req.get("x-csrf-token"))) return res.status(403).json({ error: "Security check failed - reload the page." });
    next();
  };
  const send = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong." });
  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

  app.post("/api/g/burns/record", bot, async (req, res) => {
    try { res.json({ ok: true, recorded: await record((req.body || {}).burns) }); } catch (e) { console.error("[burns] record:", e.message); send(res, e); }
  });
  app.get("/api/burns", async (req, res) => {
    try { res.json({ burned: await burned(), burns: await publicLog({ limit: req.query.limit, before: req.query.before }) }); }
    catch (e) { send(res, e); }
  });
  app.get("/api/admin/burn", noStore, addUser, admin, async (req, res) => {
    try { res.json(await adminView()); } catch (e) { send(res, e); }
  });
  app.post("/api/admin/burn/nonce", noStore, addUser, admin, csrf, (req, res) => res.json({ nonce: ctl.issueNonce(req.user) }));
  app.post("/api/admin/burn", noStore, addUser, admin, csrf, async (req, res) => {
    const b = req.body || {};
    try { res.json({ ok: true, request: await request(req.user, { amount: b.amount, reason: b.reason, nonce: b.nonce, password: b.password }, guard.clientIp(req)) }); }
    catch (e) { if (!e.status) console.error("[burns] request:", e.message); send(res, e); }
  });
  app.get("/api/admin/burn/:id", noStore, addUser, admin, async (req, res) => {
    try { res.json({ ok: true, action: await actionResult(req.params.id) }); } catch (e) { send(res, e); }
  });
}

module.exports = { register, record, burned, publicLog, sync, adminView, request, actionResult, ensure, state, _setClock };
