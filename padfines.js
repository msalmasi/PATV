// padfines.js — 1.99yx: admin FINES on pad vaults and admin TRANSFERS between pad vaults (camfrog-bot pepe_padfine.py, 1.99yw).
//
// The vaults are pools (room:<pad id>) that Pepe moves (his journal + the vault history live with him); the site asks him and
// records what he did:
//
//   POST /api/admin/padvault/move   site Admins (owner answer (5), 2026-10-21: moderation fines - !fine, !padfine, !padmove
//                                   and this form - stay with Admins/staff; b30a73e1 had made it an owner's), same-site fetch,
//                                   nonce + account password step-up (econstore.stepUp, throttled):
//                                   {op: fine|transfer, from, to?, amount, reason, nonce, password}
//                                   -> a website action "roomvault.admin" [op, from, to, amount, key, reason] that Pepe runs
//                                   with his own checks (the vault must hold the whole amount; a transfer respects the other
//                                   vault's cap); a row here (status queued) + an admin_audit row ("padvault-<op>-request")
//   POST /api/g/roomvaults/admin-move  (Pepe, bot token) {moves: [{key, op, room, to, amount, reason, actor, via, site_user,
//                                   legs, at, room_title, to_title, balance, to_balance}]} - every move he finished (from chat
//                                   !padfine / !padmove or from here). Idempotent per key: the row -> done, admin_audit
//                                   ("padvault-fine" / "padvault-transfer"), the pad owner(s) get a notice (inbox kind "room"),
//                                   a pad event.
//   GET  /api/admin/padvault/moves  site Admins: the latest moves + where fines go (PAT Routing row fine_pad, Pepe's table)
//
// A FINE goes where Pepe's PAT Routing row `fine_pad` says (default the Federal Reserve, like every other fine); a TRANSFER is
// a pool move. Supply never changes. The card is on /pads/admin#padfines (views/partials/pads-admin-fines.ejs).
//
//   pad_vault_admin_moves  key PK (Pepe's journal key: "web-<site key>" for a request from here, "chat-..." from chat), op,
//                          room_id, to_room, amount, reason, actor, via, site_user, legs (JSON), status queued|done|failed,
//                          action_id, created, done_at, message
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const OPS = new Set(["fine", "transfer"]);
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_RE = /^[A-Za-z0-9_.:\-]{1,120}$/;
const MAX_AMOUNT = 1e12;

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS pad_vault_admin_moves (key TEXT PRIMARY KEY, op TEXT NOT NULL, room_id TEXT NOT NULL,
      to_room TEXT, amount INTEGER NOT NULL, reason TEXT, actor TEXT, via TEXT, site_user TEXT, legs TEXT, status TEXT NOT NULL,
      action_id INTEGER, created INTEGER NOT NULL, done_at INTEGER, message TEXT)`)
      .then(() => runQuery("CREATE INDEX IF NOT EXISTS pad_vault_admin_moves_room ON pad_vault_admin_moves (room_id, created)"))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);
const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : 0; };
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

/** Where fines go now: Pepe's routing override for fine_pad (pushed to the site), else his default (the Reserve). The review of
 *  the owner answers: while the site owns the economy settings and can't read them -> {shares: null, unavailable: true} (the
 *  page says it can't tell) - never the default shown as if it were the route. */
async function fineRoute() {
  let r;
  try { r = await require("./econstore").routeOverride("fine_pad"); } catch (x) {
    if (!require("./policy/config").isCfgErr(x)) throw x;
    return { shares: null, override: false, unavailable: true };
  }
  r = Array.isArray(r) && r.length ? r : null;
  return { shares: r || [["reserve", 100]], override: !!r };
}

/** Queue a fine / transfer for Pepe as `admin` ({userId, username}). Used by the admin route and tools/padvault-move.js. */
async function request(admin, { op, from, to, amount, reason, key } = {}) {
  await init();
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!admin || !admin.userId) throw fail(401, "Sign in first.");
  op = String(op || "");
  if (!OPS.has(op)) throw fail(400, "Pick fine or transfer.");
  const rooms = require("./rooms");
  const R = await rooms.get(String(from || ""));
  if (!R || !ROOM_RE.test(R.id) || R.id !== String(from)) throw fail(404, "No such pad.");
  let T = null;
  if (op === "transfer") {
    T = await rooms.get(String(to || ""));
    if (!T || T.id !== String(to)) throw fail(404, "No such pad to move it into.");
    if (T.id === R.id) throw fail(400, "That's the same pad.");
  }
  const a = typeof amount === "number" ? amount : /^\s*\d+\s*$/.test(String(amount || "")) ? parseInt(amount, 10) : NaN;
  if (!Number.isFinite(a) || Math.floor(a) !== a || a < 1 || a > MAX_AMOUNT) throw fail(400, "Enter a whole amount of PAT.");
  const why = clean(reason, 200);
  if (why.length < 3) throw fail(400, "Give a reason - the pad owner sees it.");
  const k = key && KEY_RE.test(String(key)) ? String(key) : crypto.randomBytes(9).toString("hex");
  const rowKey = "web-" + k;
  const have = (await getQuery("SELECT key, status, action_id FROM pad_vault_admin_moves WHERE key = ?", [rowKey]))[0];
  if (have) return { key: rowKey, id: have.action_id, duplicate: true };
  const label = op === "fine" ? `Fine the ${R.title} pad vault ${fmt(a)} PAT` : `Move ${fmt(a)} PAT: ${R.title} -> ${T.title} pad vault`;
  const id = await require("./actions").queue(admin.userId, { kind: "roomvault.admin", args: [op, R.id, T ? T.id : "", String(a), k, why],
                                                               tag: "padvault-admin", label: label.slice(0, 200) });
  await runQuery(`INSERT INTO pad_vault_admin_moves (key, op, room_id, to_room, amount, reason, actor, via, site_user, status, action_id, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?, 'queued', ?, ?)`,
                 [rowKey, op, R.id, T ? T.id : null, a, why, "web:" + (admin.username || admin.userId), admin.userId, id, Date.now()]);
  await require("./adminaudit").record(admin, `padvault-${op}-request`, null, { key: rowKey, room: R.id, to: T ? T.id : null, amount: a, action: id }, why)
    .catch((e) => console.warn("[padfines] audit:", e.message));
  console.log(`[padfines] ${admin.username} queued ${op} ${R.id}${T ? " -> " + T.id : ""} ${a} as action ${id} (${rowKey})`);
  return { key: rowKey, id };
}

/** The account behind Pepe's actor string: "web:<username>" or a Camfrog login. */
async function adminOf(actor, siteUser) {
  if (siteUser) {
    const u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(siteUser)]).catch(() => []))[0];
    if (u) return u;
  }
  const a = String(actor || "").replace(/^web:/, "").trim().toLowerCase();
  if (a) {
    const u = (await getQuery(`SELECT userId, username FROM users WHERE LOWER(username) = ? OR LOWER(camfrogUsername) = ?
                               ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [a, a]).catch(() => []))[0];
    if (u) return u;
  }
  return { userId: "pepe:" + (a || "?"), username: a || "Pepe admin" };
}

/** Pepe's report of moves he finished. -> the keys recorded (new or already known). */
async function record(moves) {
  await init();
  const rooms = require("./rooms");
  const out = [];
  for (const m of (Array.isArray(moves) ? moves : []).slice(0, 50)) {
    const key = clean(m && m.key, 80);
    const op = String((m && m.op) || "");
    const room = clean(m && m.room, 120);
    if (!key || !OPS.has(op) || !ROOM_RE.test(room)) continue;
    const to = op === "transfer" ? clean(m.to, 120) : null;
    const amount = Math.max(0, int(m.amount));
    const legs = (Array.isArray(m.legs) ? m.legs : []).slice(0, 8).map((l) => [clean(l && l[0], 80), Math.max(0, int(l && l[1]))]);
    const reason = clean(m.reason, 200);
    const at = int(m.at) || Date.now();
    const prev = (await getQuery("SELECT status FROM pad_vault_admin_moves WHERE key = ?", [key]))[0];
    if (prev && prev.status === "done") { out.push(key); continue; }
    if (prev) {
      await runQuery("UPDATE pad_vault_admin_moves SET status = 'done', done_at = ?, legs = ?, actor = COALESCE(actor, ?) WHERE key = ?",
                     [at, JSON.stringify(legs), clean(m.actor, 60), key]);
    } else {
      await runQuery(`INSERT INTO pad_vault_admin_moves (key, op, room_id, to_room, amount, reason, actor, via, site_user, legs, status, created, done_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?)`,
                     [key, op, room, to, amount, reason, clean(m.actor, 60), clean(m.via, 10) || "chat", clean(m.site_user, 64) || null,
                      JSON.stringify(legs), at, at]);
    }
    out.push(key);
    const admin = await adminOf(m.actor, m.site_user);
    await require("./adminaudit").record(admin, `padvault-${op}`, null,
      { key, room, to, amount, legs, via: clean(m.via, 10), balance: int(m.balance), to_balance: m.to_balance == null ? null : int(m.to_balance) }, reason)
      .catch((e) => console.warn("[padfines] audit:", e.message));
    const R = await rooms.get(room).catch(() => null);
    const T = to ? await rooms.get(to).catch(() => null) : null;
    const title = (R && R.title) || clean(m.room_title, 60) || room;
    const toTitle = to ? (T && T.title) || clean(m.to_title, 60) || to : null;
    const link = (x) => (x && x.slug ? "/p/" + encodeURIComponent(String(x.slug).toLowerCase()) + "?tab=about#vault" : "/p");
    const owner = R && R.owner && R.owner.userId;
    if (op === "fine") {
      await rooms.event(room, "vault-fine", admin.username, `${fmt(amount)} PAT - ${reason}`);
      if (owner) {
        await rooms.notify(owner, { kind: "room", ref: `padfine:${key}`, link: link(R), pm: true,
          title: `⚖️ ${title}: the pad vault was fined ${fmt(amount)} PAT`,
          body: `A PATV admin fined your pad's vault ${fmt(amount)} PAT. Reason: ${reason}. It now holds ${fmt(m.balance)} PAT.` });
      }
    } else {
      await rooms.event(room, "vault-move-out", admin.username, `${fmt(amount)} PAT -> ${to} - ${reason}`);
      if (to) await rooms.event(to, "vault-move-in", admin.username, `${fmt(amount)} PAT <- ${room} - ${reason}`);
      if (owner) {
        await rooms.notify(owner, { kind: "room", ref: `padmove-out:${key}`, link: link(R), pm: true,
          title: `🏠 ${title}: ${fmt(amount)} PAT moved out of the pad vault`,
          body: `A PATV admin moved ${fmt(amount)} PAT from your pad's vault to the ${toTitle} pad vault. Reason: ${reason}. It now holds ${fmt(m.balance)} PAT.` });
      }
      const towner = T && T.owner && T.owner.userId;
      if (towner && towner !== owner) {
        await rooms.notify(towner, { kind: "room", ref: `padmove-in:${key}`, link: link(T), pm: false,
          title: `🏠 ${toTitle}: ${fmt(amount)} PAT moved into the pad vault`,
          body: `A PATV admin moved ${fmt(amount)} PAT from the ${title} pad vault into yours. Reason: ${reason}.` });
      }
    }
    console.log(`[padfines] ${op} ${key}: ${room}${to ? " -> " + to : ""} ${amount} by ${admin.username} (${reason})`);
  }
  return out;
}

/** The admin card: the latest moves (with the queued ones' Pepe status) + where fines go. */
async function recent(limit = 20) {
  await init();
  const rows = await getQuery("SELECT * FROM pad_vault_admin_moves ORDER BY created DESC LIMIT ?", [Math.min(100, Math.max(1, limit | 0))]);
  const ids = rows.filter((r) => r.status === "queued" && r.action_id).map((r) => r.action_id);
  const acts = {};
  if (ids.length) {
    for (const a of await getQuery(`SELECT id, status, message FROM pepe_actions WHERE id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => [])) acts[a.id] = a;
  }
  const out = rows.map((r) => {
    let legs = [];
    try { legs = r.legs ? JSON.parse(r.legs) : []; } catch (e) { legs = []; }
    const a = acts[r.action_id];
    // a queued request Pepe refused (or that expired) shows his answer; one he ran shows done once his report lands
    const status = r.status === "queued" && a && a.status === "failed" ? "failed" : r.status;
    return { key: r.key, op: r.op, room: r.room_id, to: r.to_room, amount: r.amount, reason: r.reason, actor: r.actor, via: r.via,
             legs, status, created: r.created, done_at: r.done_at, message: a ? a.message : null };
  });
  return { moves: out, route: await fineRoute() };
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[padfines] init:", e.message));
  app.post("/api/g/roomvaults/admin-move", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, keys: await record(b.moves) }); }
    catch (e) { console.error("[padfines] record:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  });
  const ctl = require("./pepecontrol");
  const admin = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!SP.can(req.user, "econ.padvault_move")) return res.status(403).json({ ok: false, error: "Admins only." });
    next();
  };
  const csrf = (req, res, next) => {
    if (!require("./middleware/authGuard").sameSite(req) || req.get("X-Requested-With") !== "fetch") {
      return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    }
    next();
  };
  app.get("/api/admin/padvault/moves", addUser, admin, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await recent(25))); }
    catch (e) { console.error("[padfines] recent:", e); res.status(500).json({ ok: false, error: "Couldn't load." }); }
  });
  // owner answer (5), 2026-10-21: a pad-vault fine / transfer is MODERATION - it stays with site Admins (the econ.padvault_move
  // capability), like !padfine / !padmove in chat; the owner gate of the 2026-10-20 answers is gone. The website action Pepe runs
  // carries the Admin class again (actions.js: roomvault.admin is no longer an owner kind). The step-up stays.
  app.post("/api/admin/padvault/nonce", addUser, admin, csrf, (req, res) => res.json({ ok: true, nonce: ctl.issueNonce(req.user) }));
  app.post("/api/admin/padvault/move", addUser, admin, csrf, async (req, res) => {
    const b = req.body || {};
    try {
      // the shared, throttled step-up (econstore.stepUp: the single-use nonce + the password, 5 wrong in 15 min -> 429)
      await require("./econstore").stepUp(req.user, b);
      res.json(Object.assign({ ok: true }, await request(req.user, { op: b.op, from: b.from, to: b.to, amount: b.amount, reason: b.reason, key: b.key })));
    } catch (e) {
      if (e && e.message === "busy") return res.status(429).json({ ok: false, error: "You already have a few things waiting for Pepe - give him a moment." });
      res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Something went wrong." });
      if (!e.status) console.error("[padfines] move:", e);
    }
  });
}

module.exports = { init, register, request, record, recent, fineRoute, adminOf };
