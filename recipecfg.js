// recipecfg.js — 1.99ada: the pad-vault PAYOUT RECIPE's percentages, edited on /admin/economy and owned by the site (the
// owner, 2026-10-19: "give me somewhere in the economy page I can change the pad-vault recipe so if need be I can bump this to
// 20%" and "let unpaid slices fund games"; Pepe 1.99adb pepe_recipe.py does the paying).
//
// SIX VALUES, owned here once saved: owner_pct, gang_pct, streamer_pct, people_pct, games_pct (fractions of a pad's day
// budget B, in whole percents) and games_unpaid (1 / 0, "unpaid shares fund room games": what the owner, gang and streamer
// slices didn't pay out that day is added to that day's room-games prize allowance, capped at B - everything paid). Every
// other recipe rule (cap_i7, owner_days, elig_days, vwm_ref, people_ref, convoy_min, min_lines, min_mic, hour, ...) stays
// Pepe's (chat: !econ recipe cfg <key> <value>) and the card only shows it. The per-pad payout RATE (the % of a vault that
// becomes B, 2-15 %, roomvaults.setRate on the pad page) is a different knob: nothing here touches it.
//
// HOW IT REACHES PEPE: the room-vault sync he already runs every ~5 minutes (roomvaults.sync, POST /api/g/roomvaults/sync)
// answers `recipe_cfg: {rev, cfg, at, by}` (null = never saved here: Pepe keeps his own values; OMITTED when the row can't be
// read, so a read error never looks like "not set"). He checks it with the same rules (clean() here, clean_site_cfg there -
// both suites pin the same 12 vectors), applies it from his NEXT daily payout epoch (~05:00 his time; the day already
// running is never changed after the fact) and reports back in the same sync body's recipe meta: cfg_rev (the applied site
// rev), cfg_src ("site" | "local"), cfg_applied_at, cfg_error ({rev, errors} while he refuses a rev). state() turns that into
// the card's applied / pending / refused / old_pepe. The website unreachable: he keeps his last applied values (never the
// defaults).
//
// CHAT: Pepe's `!econ recipe cfg <one of the six> <value>` WRITES THROUGH here (POST /api/g/recipe/cfg, bot token): the same
// rules, the same rev check, the same audit row (admin "chat:<login>", the login's linked PATV account as admin_id). No answer
// from the site = nothing changes (Pepe says so). Pepe's ACL keeps !econ owner-only; this route trusts the bot token.
//
//   recipe_cfg   id = 1 (one row), rev (+1 per saved change, never reused), cfg (JSON, the six), at (ms), by (site username
//                or "chat:<login>"), via ("web" | "chat"), note. Written in dbUtils.tx with its audit row.
//   history      admin_audit action "recipe-cfg" {rev, from, to, changed, via, warnings} + the note (adminaudit.js)
//
//   GET  /api/admin/econ/recipe   econ.telemetry_policy (Admins): saved, defaults, limits, Pepe's applied values, state,
//                                 can_edit, the change log and the biggest vaults' last payout day
//   POST /api/admin/econ/recipe   a Pepe OWNER (econ.pepe_econ_cmds + Pepe role "owner" on the linked chat login -
//                                 staffroles.ownerHolds, the user's 2026-10-16 "economy is owner-only" rule; the other
//                                 /admin/economy edit cards still check only the Admin class) + same-site fetch with
//                                 X-Requested-With: fetch + x-csrf-token (pepeCtlCsrf) + the /admin/economy step-up
//                                 (econstore.stepUp: the single-use nonce from /api/admin/econ/edit/nonce + the account
//                                 password). {nonce, password, base_rev, cfg, note}
//   POST /api/g/recipe/cfg        bot token. {actor, via: "chat", base_rev, cfg}
// Both writes answer 400 {code: "invalid", errors} / 409 {code: "stale", saved} (base_rev isn't the saved rev; null means
// "nothing saved yet") / 200 {saved, warnings}, or {unchanged: true, saved} for the values already saved (no rev, no audit).
// With NO row saved any base_rev is accepted (nothing to be stale against) and the first rev continues past the newest one
// seen (base_rev, Pepe's reported cfg_rev): a restored / emptied table never leaves Pepe's chat write-through stuck on 409.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const SITE_KEYS = Object.freeze(["owner_pct", "gang_pct", "streamer_pct", "people_pct", "games_pct", "games_unpaid"]);
const SLICE_KEYS = Object.freeze(SITE_KEYS.slice(0, 5));
const PAID_KEYS = Object.freeze(SITE_KEYS.slice(0, 4));
const PAID_MAX = 100, SUM_MAX = 150;          // whole percent: the four paid slices / all five (Pepe's PAID_MAX, SUM_MAX)
// Pepe's RC_DEFAULTS for the six (games_unpaid on since 1.99adb)
const DEFAULTS = Object.freeze({ owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.10, games_unpaid: 1 });
// Pepe's own recipe rules the card shows read-only (as he last reported them)
const PEPE_KEYS = Object.freeze(["cap_i7", "owner_days", "elig_days", "vwm_ref", "people_ref", "convoy_min", "min_lines", "min_mic", "hour"]);

let clock = () => Date.now();
const now = () => clock();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS recipe_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, cfg TEXT NOT NULL,
        at INTEGER NOT NULL, by TEXT, via TEXT, note TEXT)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/**
 * The rules, identical to Pepe's clean_site_cfg (contract B.4): raw = an object with ALL six keys (a partial set is refused
 * whole); each slice a JSON number from 0 to 1 in whole percents (normalized to 2 decimals); games_unpaid 0 / 1 (true / false
 * accepted); owner + gang + streamers + regulars <= 100 % and all five <= 150 % (refused above); a warning above or below
 * 100 %. -> {ok, cfg (the six, normalized) | null, errors[], warnings[]}
 */
function clean(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, cfg: null, errors: ["the recipe needs all six values: " + SITE_KEYS.join(", ")], warnings: [] };
  }
  const missing = SITE_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(raw, k));
  if (missing.length) return { ok: false, cfg: null, errors: [`missing ${missing.join(", ")} (all six values are needed)`], warnings: [] };
  const errors = [], warnings = [], cfg = {}, pc = {};
  for (const k of SLICE_KEYS) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) { errors.push(`${k} must be a number from 0 to 1`); continue; }
    if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) { errors.push(`${k} must be a whole percent (0.01 steps)`); continue; }
    pc[k] = Math.round(v * 100);
    cfg[k] = pc[k] / 100;
  }
  const u = raw.games_unpaid;
  if (u === true || u === 1) cfg.games_unpaid = 1;
  else if (u === false || u === 0) cfg.games_unpaid = 0;
  else errors.push("games_unpaid must be 0 or 1 (off or on)");
  if (!errors.length) {
    const paid = PAID_KEYS.reduce((s, k) => s + pc[k], 0);
    const total = paid + pc.games_pct;
    if (paid > PAID_MAX) errors.push("owner + gang + streamers + regulars can't be more than 100% (they would pay out more than the day's budget)");
    if (total > SUM_MAX) errors.push("all five slices can't add up to more than 150%");
    if (!errors.length && total > 100) warnings.push(`the slices add up to ${total}%: on a day every slice pays in full, room games get only what's left of the budget`);
    if (!errors.length && total < 100) warnings.push(`${100 - total}% of each day's budget is never assigned and always stays in the vault`);
  }
  return errors.length ? { ok: false, cfg: null, errors, warnings: [] } : { ok: true, cfg, errors: [], warnings };
}

// one value compared the way Pepe compares them: slices as whole percents, the switch as 0 / 1
function sameKey(k, a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (k === "games_unpaid") return Number(a) === Number(b);
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}
const same = (a, b) => !!a && !!b && SITE_KEYS.every((k) => sameKey(k, a[k], b[k]));
const show = (k, v) => (v == null ? "?" : k === "games_unpaid" ? String(Number(v)) : String(Math.round(Number(v) * 100) / 100));
/** "games_pct 0.1 -> 0.2, games_unpaid 1 -> 0" (the server log line); from = null lists the new values. */
function diffText(from, to) {
  const ks = SITE_KEYS.filter((k) => !from || !sameKey(k, from[k], to[k]));
  return ks.map((k) => (from ? `${k} ${show(k, from[k])} -> ${show(k, to[k])}` : `${k} ${show(k, to[k])}`)).join(", ") || "no change";
}

/** The saved row (null = never saved). Throws on a read error or a broken row - forPepe's caller then omits the field. */
async function read() {
  await init();
  const r = (await getQuery("SELECT rev, cfg, at, by, via, note FROM recipe_cfg WHERE id = 1"))[0];
  if (!r) return null;
  return { rev: Number(r.rev), cfg: JSON.parse(r.cfg), at: Number(r.at), by: r.by || null, via: r.via || null, note: r.note || null };
}
const pub = (s) => (s ? { rev: s.rev, cfg: s.cfg, at: s.at, by: s.by } : null);
/** What the room-vault sync hands Pepe: {rev, cfg, at, by} | null. Throws on a read error. */
async function forPepe() { return pub(await read()); }

/** Pepe's recipe as he last reported it on the room-vault sync (roomvaults meta "recipe"), or null. */
async function pepeMeta() {
  const RV = require("./roomvaults");
  const m = await RV.metaGet();
  return { rec: m.recipe && typeof m.recipe === "object" ? m.recipe : null, synced: m.synced || null };
}
/** The six as Pepe last reported them (only the keys he sent) - the "from" of a first save; null = never reported. */
function pepeSix(rec) {
  const c = rec && rec.cfg && typeof rec.cfg === "object" ? rec.cfg : null;
  if (!c) return null;
  const out = {};
  for (const k of SITE_KEYS) if (c[k] != null && Number.isFinite(Number(c[k]))) out[k] = Number(c[k]);
  return Object.keys(out).length ? out : null;
}

/**
 * Saved vs what Pepe applies (contract C.3): not_set (nothing saved), refused (he reported cfg_error for the saved rev),
 * old_pepe (his meta carries no cfg_src / cfg_rev: a Pepe before 1.99adb), applied (he reports the saved rev with the same
 * values), else pending (he hasn't picked it up yet - or never synced a recipe).
 */
function state(saved, rec) {
  if (!saved) return "not_set";
  if (!rec) return "pending";
  if (rec.cfg_error && rec.cfg_error.rev === saved.rev) return "refused";
  if (rec.cfg_src == null && rec.cfg_rev == null) return "old_pepe";
  if (rec.cfg_rev === saved.rev && same(rec.cfg || {}, saved.cfg)) return "applied";
  return "pending";
}

const cleanNote = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const cleanLogin = (v) => { const l = String(v || "").trim().replace(/^@/, "").toLowerCase(); return LOGIN_RE.test(l) ? l : null; };

/**
 * One write, from the web card or from chat: the rules, then (in one transaction with its audit row) the rev check, the
 * unchanged check and the new row. admin = the audit row's {userId, username}. -> {status, body}
 */
async function save({ cfg, base_rev, by, via, note, admin }) {
  const c = clean(cfg);
  if (!c.ok) return { status: 400, body: { ok: false, code: "invalid", errors: c.errors } };
  if (base_rev != null && !(Number.isSafeInteger(base_rev) && base_rev >= 0)) {
    return { status: 400, body: { ok: false, code: "invalid", errors: ["base_rev must be a revision number or null"] } };
  }
  const base = base_rev == null ? null : base_rev;
  await init();
  const AA = require("./adminaudit");
  await AA.init();                                  // never a CREATE TABLE inside the transaction
  const { rec } = await pepeMeta().catch(() => ({ rec: null }));
  const r = await tx(async () => {
    const cur = await read();
    // the rev check guards a SAVED row against a write based on an older one. With no row there's nothing to overwrite, so any
    // base_rev is accepted: Pepe can still hold a site rev after the row went (a database restored to before the first save,
    // the row deleted) and a 409 {saved: null} would leave his chat write-through stuck - he can't apply null, so every retry
    // answered "the website changed the recipe meanwhile" until someone saved on the web.
    if (cur && base !== cur.rev) return { status: 409, body: { ok: false, code: "stale", saved: pub(cur) } };
    if (cur && same(cur.cfg, c.cfg)) return { status: 200, body: { ok: true, unchanged: true, saved: pub(cur), warnings: c.warnings } };
    const from = cur ? cur.cfg : pepeSix(rec);
    const changed = SITE_KEYS.filter((k) => !from || !sameKey(k, from[k], c.cfg[k]));
    // a first row continues past the newest rev anyone has seen (the base_rev sent, the rev Pepe reports applied), so a rev
    // number Pepe already applied is never handed out again for other values
    const seen = cur ? cur.rev : Math.max(0, base || 0, rec && Number.isSafeInteger(rec.cfg_rev) ? rec.cfg_rev : 0);
    const rev = seen + 1, at = now();
    const n = cleanNote(note) || null;
    await runQuery(`INSERT INTO recipe_cfg (id, rev, cfg, at, by, via, note) VALUES (1, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, cfg = excluded.cfg, at = excluded.at, by = excluded.by,
                    via = excluded.via, note = excluded.note`, [rev, JSON.stringify(c.cfg), at, by, via, n]);
    await AA.record(admin, "recipe-cfg", null, { rev, from: from || null, to: c.cfg, changed, via, warnings: c.warnings }, n);
    return { status: 200, body: { ok: true, saved: { rev, cfg: c.cfg, at, by }, warnings: c.warnings }, log: diffText(from, c.cfg) };
  });
  if (r.log) { console.log(`[recipecfg] ${by} rev ${r.body.saved.rev} (${via}): ${r.log}`); delete r.log; }
  return r;
}

/** Fresh class + linked chat login from the database (never the session's copy). */
async function meOf(user) {
  if (!user || !user.userId) return null;
  return (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0] || null;
}
/** Saving needs econ.pepe_econ_cmds (locked: Admin) AND Pepe role "owner" on the account's linked chat login. */
async function canEdit(user) {
  try { return await require("./staffroles").ownerHolds(await meOf(user), "econ.pepe_econ_cmds"); } catch (e) { return false; }
}

/**
 * The biggest vaults' last payout day: what the games got (slice + unpaid shares = allowance) and what they used. capped =
 * the allowance came out BELOW slice + unpaid shares: games_from_unpaid is Pepe's figure before the cap (B - everything
 * paid), so the sum only binds when the five slices add up to more than 100 % - derived here from his numbers, since his
 * games_capped flag isn't synced.
 */
async function lastDay(limit = 5) {
  const RV = require("./roomvaults");
  await RV.init();
  const rows = await getQuery("SELECT room_id, recipe FROM room_vault_state WHERE balance > 0 AND recipe IS NOT NULL ORDER BY balance DESC LIMIT ?", [limit]);
  const rooms = require("./rooms");
  const out = [];
  for (const r of rows) {
    let rc = null;
    try { rc = JSON.parse(r.recipe); } catch (e) { rc = null; }
    const eps = (rc && Array.isArray(rc.epochs)) ? rc.epochs : [];
    const e = eps[eps.length - 1];
    if (!e) continue;
    const R = await rooms.get(r.room_id).catch(() => null);
    const g = rc.games && rc.games.day === e.day ? rc.games : null;
    // an older Pepe reports neither split: its allowance WAS the games slice
    const split = Number(e.games_base) > 0 || Number(e.games_from_unpaid) > 0;
    const base = split ? Number(e.games_base) || 0 : Number(e.games_allow) || 0, unpaid = Number(e.games_from_unpaid) || 0;
    const allow = Number(e.games_allow) || 0;
    out.push({ room: r.room_id, title: R ? R.title : r.room_id, day: e.day, B: Number(e.B) || 0,
               games_base: base, games_from_unpaid: unpaid, games_allow: allow, capped: split && base + unpaid > allow,
               used: g ? Number(g.used) || 0 : null });
  }
  return out;
}

/** GET /api/admin/econ/recipe */
async function adminData(me) {
  const saved = await read();
  const { rec, synced } = await pepeMeta();
  const nul = (v) => (v === undefined ? null : v);
  return {
    ok: true, saved, defaults: DEFAULTS, limits: { paid_max: PAID_MAX / 100, sum_max: SUM_MAX / 100, sum_warn: 1 },
    pepe: { cfg: (rec && rec.cfg) || {}, cfg_rev: rec ? nul(rec.cfg_rev) : null, cfg_src: rec ? nul(rec.cfg_src) : null,
            cfg_applied_at: rec ? nul(rec.cfg_applied_at) : null, cfg_error: rec ? nul(rec.cfg_error) : null, synced, on: !!(rec && rec.on === true) },
    state: state(saved, rec), can_edit: await canEdit(me), site_keys: SITE_KEYS, pepe_keys: PEPE_KEYS,
    log: await require("./adminaudit").recent("recipe-cfg", 20),
    last: await lastDay(5),
  };
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[recipecfg] init:", e.message));
  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  const oops = (res, where, e) => { console.error("[recipecfg] " + where + ":", e); res.status(500).json({ ok: false, error: "Something went wrong." }); };

  app.get("/api/admin/econ/recipe", noStore, addUser, async (req, res) => {
    try {
      const me = await meOf(req.user);
      if (!me) return res.status(401).json({ ok: false, error: "Sign in first." });
      if (!SP.can(me, "econ.telemetry_policy")) return res.status(403).json({ ok: false, error: "Admins only." });
      res.json(await adminData(me));
    } catch (e) { oops(res, "view", e); }
  });

  app.post("/api/admin/econ/recipe", noStore, addUser, async (req, res) => {
    try {
      const me = await meOf(req.user);
      if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
      if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)
          || !require("./pepecontrol").csrfOk(me.username, req.get("x-csrf-token"))) {
        return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
      }
      if (!(await canEdit(me))) return res.status(403).json({ ok: false, code: "owner_only", error: "Only a Pepe owner can change the payout recipe." });
      const b = req.body || {};
      try { await require("./econstore").stepUp(me, b); }
      catch (e) { if (e && e.status) return res.status(e.status).json({ ok: false, code: e.code, error: e.message }); throw e; }
      const r = await save({ cfg: b.cfg, base_rev: b.base_rev, by: me.username, via: "web", note: b.note,
                             admin: { userId: me.userId, username: me.username } });
      res.status(r.status).json(r.body);
    } catch (e) { oops(res, "save", e); }
  });

  // Pepe's chat write-through (!econ recipe cfg <site key> <value>); he applies `saved` himself (200 and 409 alike)
  app.post("/api/g/recipe/cfg", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const login = cleanLogin(b.actor) || "pepe";
      const acct = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = ? LIMIT 1", [login]))[0] || null;
      const by = "chat:" + login;
      const r = await save({ cfg: b.cfg, base_rev: b.base_rev, by, via: "chat", note: b.note, admin: { userId: acct ? acct.userId : "pepe", username: by } });
      res.status(r.status).json(r.body);
    } catch (e) { console.error("[recipecfg] chat:", e); res.status(500).json({ ok: false, error: "server_error" }); }
  });
}

module.exports = { init, register, clean, state, save, read, forPepe, canEdit, adminData, lastDay, diffText,
                   SITE_KEYS, SLICE_KEYS, PAID_KEYS, PEPE_KEYS, DEFAULTS, PAID_MAX, SUM_MAX,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; } };
