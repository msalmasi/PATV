// siteperms.js — 1.99ack / 1.99acl site: the website's own permissions (release 2 of /admin/roles; the registry is siteperms-core.js).
//
//   can(user, key)      sync: does this account (its users.class: Admin / Staff / Assistant) hold the capability?
//   canId(userId, key)  the same for an account id (reads its class)
//   minClass(key)       the minimum class that holds it now ("admin" | "staff" | "assistant")
//   atLeast(user, cls)  class ladder only - for a SETTING that names an audience (webpush_audience, library_allow), never a gate
//
// * Every check the site used to write as class === "Admin" / "Admin"-or-"Staff" goes through can() with a key from the
//   registry. With no overrides the answers are exactly the old ones, except the owner's 2026-10-18 decisions (economic
//   configs Admin-only, Assistants get banner / soundboard / pad connection review, likeness view = Staff).
// * site_perms holds the overrides: (key, min_class, ts, by, by_level); min_class NULL = back to the default (the row
//   stays so "who reset it" is shown). They are cached in memory (loaded at start, reloaded every minute, replaced on
//   every change made here), so can() never touches the database.
// * An unknown key is a typo: it throws under the test runner and is denied (and logged once) in production.
// * Editing (/admin/roles, the "Website permissions" section): decided by the editor's PEPE role (pepeperms.editorOf,
//   like release 1) - owners and admins only; an admin never changes a row an owner set; locked capabilities never move;
//   the only values are admin / staff / assistant (nothing below Assistant). Every change is written to admin_audit.
// * Views: res.locals.can(key[, user]) (installed on every render, see install()) - the request's user by default.
"use strict";
const db = require("./dbUtils");   // 1.99acl: through the module (the tests make a load fail)
const runQuery = (...a) => db.runQuery(...a), getQuery = (...a) => db.getQuery(...a);
const C = require("./siteperms-core");

const OWNER = 100, ADMIN = 80;   // Pepe role levels (pepeperms.LEVEL)

// 1.99acl: no prototype on either map (a key / value like "constructor" or "__proto__" is never found by accident)
let OV = Object.create(null);    // key -> {min, ts, by, lvl} (min null = a reset row)
let MIN = Object.create(null);   // key -> min (overrides in force)
let SEEN = null;                 // the table's "max(ts) / count" at the last load (the 5 s poll)
let clock = () => Date.now();
const now = () => clock();

class PermError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS site_perms (key TEXT PRIMARY KEY, min_class TEXT, ts INTEGER NOT NULL DEFAULT 0,
                      by TEXT, by_level INTEGER)`);
      await reload();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const stampOf = (r) => (r ? (Number(r.t) || 0) + "/" + (Number(r.n) || 0) : null);
async function reload() {
  const stamp = stampOf((await getQuery("SELECT MAX(ts) AS t, COUNT(*) AS n FROM site_perms"))[0]);
  const rows = await getQuery("SELECT key, min_class, ts, by, by_level FROM site_perms");
  const ov = Object.create(null), min = Object.create(null);
  for (const r of rows) {
    const cap = C.capOf(r.key);
    if (!cap) continue;                                    // a key the registry dropped (or junk)
    const m = C.isClass(r.min_class) ? r.min_class : null; // junk values ("pleb", "constructor", ...) count as no override
    ov[r.key] = { min: m, ts: Number(r.ts) || 0, by: r.by || null, lvl: r.by_level == null ? null : Number(r.by_level) };
    if (m && !cap.locked) min[r.key] = m;
  }
  OV = ov; MIN = min; SEEN = stamp;
  return Object.keys(min).length;
}
/** 1.99acl: another process's edit, picked up within seconds - reload only when the table's max(ts) / row count moved. */
async function poll() {
  if (!ready) return init();
  await ready;
  const stamp = stampOf((await getQuery("SELECT MAX(ts) AS t, COUNT(*) AS n FROM site_perms"))[0]);
  if (stamp !== SEEN) await reload();
}

function can(user, key) { return C.check(MIN, user, key); }
async function canId(userId, key) {
  if (!C.capOf(key)) return C.check(MIN, null, key);     // throws / denies like can()
  if (!userId) return false;
  const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0];
  return can(u || null, key);
}
function minClass(key) {
  if (!C.capOf(key)) { C.check(MIN, null, key); return null; }
  return C.minOf(MIN, key);
}
/** Class ladder for an audience a setting names ("admin" / "staff" / "assistant"). */
function atLeast(user, cls) { const r = C.rankOf(cls); return r > 0 && C.classRank(user) >= r; }
/** Any of these keys. */
function canAny(user, keys) { return keys.some((k) => can(user, k)); }

// ── the admin area: Admins / Staff (admin.area) everywhere; anyone else only on a page they hold a key for ──
/** The admin pages with a gate of their own and the capability that opens each for someone without admin.area (Assistants,
 *  by default: banner review, soundboard moderation and pad connection requests - every other entry only when an override
 *  lowers its key) - in the nav's order, the first one they hold is their home. */
const AREA_PAGES = [
  ["/admin/markets", ["markets.auto"]],
  ["/admin/raffles", ["raffles.admin"]],
  ["/admin/oracle", ["oracle.admin"]],
  ["/pads/admin", ["pads.registry_admin"]],
  ["/feed/admin", ["feed.admin_page"]],
  ["/admin/shopart", ["shopart.view"]],
  ["/admin/creators", ["creators.admin"]],
  ["/admin/banner", ["banner.review"]],
  ["/stage/admin", ["stage.admin"]],
  ["/admin/media", ["media.admin"]],
  ["/admin/push", ["push.admin"]],
  ["/admin/soundboards", ["soundboards.moderate"]],
  ["/pads/admin#padconn", ["pads.connect_review"]],
  // S1 V2 (ADR 0007 D15): the chat hub's report queue (chatwidget.js) for chat.mod_queue - Assistants by default, so one whose
  // only admin capability is the queue gets an admin home (and the layout's 🛠️ Admin link). The key is release L1's: no entry
  // until siteperms registers it (a key it doesn't know throws in tests and is denied, with a log line, in production).
  ...(C.capOf("chat.mod_queue") ? [["/admin/chat/reports", ["chat.mod_queue"]]] : []),
  ["/admin/help", ["help.admin"]],
  ["/admin/translations", ["i18n.admin"]],
  ["/shop/admin", ["shop.admin"]],
];
function areaHome(user) {
  if (can(user, "admin.area")) return "/admin";
  for (const [href, keys] of AREA_PAGES) if (canAny(user, keys)) return href;
  return null;
}
/** Express gate: admin.area, or one of `keys` (the page's own). */
function gate(...keys) {
  return (req, res, next) => {
    const u = req.user || null;
    if (can(u, "admin.area") || keys.some((k) => can(u, k))) return next();
    const home = u ? areaHome(u) : null;
    if (home && req.method === "GET" && !/^\/api\//.test(req.path)) return res.redirect(home);
    if (typeof req.flash === "function") req.flash("error", "Access denied. You must be an admin or staff to access this page.");
    return res.redirect("/login");
  };
}

// ── views: res.locals.can ──
/** Adds can(key[, user]) to every render's locals (the request's user by default). Once per process. */
function install() {
  const proto = require("express").response;
  if (proto.__sitePerms) return;
  const orig = proto.render;
  proto.render = function (view, options, cb) {
    try {
      if (this.locals && typeof this.locals.can !== "function") {
        const req = this.req;
        const opts = options && typeof options === "object" ? options : {};
        this.locals.can = (key, u) => can(u !== undefined ? u : ((req && req.user) || opts.me || opts.viewer || null), key);
      }
      // the layout's 🛠️ Admin link: where this viewer's admin area starts (null: none)
      if (this.locals && typeof this.locals.adminHome !== "function") {
        const req = this.req;
        this.locals.adminHome = () => (req && req.user ? areaHome(req.user) : null);
      }
    } catch (e) { /* never block a render */ }
    return orig.call(this, view, options, cb);
  };
  Object.defineProperty(proto, "__sitePerms", { value: true });
}
install();

// ── editing (/admin/roles) ──
const audit = (ed, detail) => require("./adminaudit").record({ userId: ed.userId, username: ed.username }, "site_perm", null, detail);
const LABEL_MIN = { admin: "Admin", staff: "Staff", assistant: "Assistant" };

const NO_KEY = "No such permission.", BAD_VAL = "Pick Admin, Staff or Assistant (nothing goes below Assistant).";
const OWNER_SET = "Only an owner can change that (an owner set it).";
/** "" when an editor at Pepe level `lvl` may set key to val (null = default), else why not. `cur` = the key's current row
 *  ({min, lvl}; the cache when not given - setMin passes the one it just read from the database).
 *  1.99acl: keys and values only from the registry's own entries (never an inherited "constructor" / "__proto__"); a row an
 *  owner wrote - a value OR a reset - is the owners' until an owner changes it. */
function editWhy(lvl, key, val, cur) {
  if (!(lvl >= ADMIN)) return "Only Pepe's admins and owners change the website's permissions.";
  const cap = C.capOf(key);
  if (!cap) return NO_KEY;
  if (cap.locked) return "That permission is locked - it can't be changed here.";
  if (val != null && !C.isClass(val)) return BAD_VAL;
  const c = cur !== undefined ? cur : (Object.prototype.hasOwnProperty.call(OV, key) ? OV[key] : null);
  if (lvl < OWNER && c && (Number(c.lvl) || 0) >= OWNER) return OWNER_SET;
  return "";
}

/** A change made on /admin/roles: key's minimum class -> value ("admin" | "staff" | "assistant" | "default"). */
async function setMin(ed, key, value) {
  await init();
  if (!ed) throw new PermError(401, "auth", "Sign in first.");
  const k = typeof key === "string" ? key : "";
  const v = value == null || value === "default" || value === "" ? null : String(value).toLowerCase();
  const refuse = (why) => {
    const code = !(ed.level >= ADMIN) ? "not_pepe_admin" : why === OWNER_SET ? "owner_only" : why === NO_KEY || why === BAD_VAL ? "invalid" : "locked";
    return new PermError(code === "invalid" ? 400 : 403, code, why);
  };
  let why = editWhy(ed.level, k, v, null);
  if (why) throw refuse(why);
  // 1.99acl: the current row from the database, not the cache - another process may have written it since our last load
  const row = (await getQuery("SELECT min_class, ts, by_level FROM site_perms WHERE key = ?", [k]))[0] || null;
  const cur = row ? { min: C.isClass(row.min_class) ? row.min_class : null, ts: Number(row.ts) || 0, lvl: row.by_level == null ? null : Number(row.by_level) } : null;
  why = editWhy(ed.level, k, v, cur);
  if (why) throw refuse(why);
  const from = cur ? cur.min : null;
  if (from === v && (cur || v == null)) return { key: k, value: v, unchanged: true };
  const ts = Math.max(now(), cur ? cur.ts + 1 : 0);
  const by = "web:" + String(ed.username || "?");
  // ... and the write itself never replaces an owner's row unless the editor is an owner (a race between that read and here)
  const r = await runQuery(`INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET min_class = excluded.min_class, ts = excluded.ts, by = excluded.by, by_level = excluded.by_level
                  WHERE COALESCE(site_perms.by_level, 0) < ${OWNER} OR excluded.by_level >= ${OWNER}`,
                 [k, v, ts, by.slice(0, 80), ed.level]);
  if (r && r.changes === 0) { await reload(); throw refuse(OWNER_SET); }
  await reload();
  await audit(ed, { key: k, from, to: v, editor_role: ed.role });
  return { key: k, value: v };
}

const CLASS_COLS = ["admin", "staff", "assistant"];
/** The section's data for this editor (pepeperms.editorOf). */
async function view(ed) {
  await init();
  const lvl = ed ? ed.level : 0;
  const groups = C.GROUPS.map((g) => ({ group: g, label: "siteperm.g." + g, rows: [] }));
  const gi = Object.fromEntries(groups.map((g, i) => [g.group, i]));
  for (const cap of C.CAPS.map((c) => C.BY_KEY[c[0]])) {
    const o = OV[cap.key] || null;
    const eff = C.minOf(MIN, cap.key);
    const ownerSet = !!(o && (o.lvl || 0) >= OWNER);   // 1.99acl: an owner's reset too
    groups[gi[cap.group]].rows.push({
      key: cap.key, label: cap.label, def: cap.def, over: cap.locked ? null : (o ? o.min : null), eff,
      locked: cap.locked || null, lockLabel: cap.locked ? "siteperm.lock." + cap.locked : null,
      by: o ? o.by : null, ts: o ? o.ts : 0, ownerSet,
      ladder: CLASS_COLS.map((c) => ({ cls: c, has: C.rankOf(c) >= C.rankOf(eff) })),
      options: CLASS_COLS.map((c) => ({ v: c, ok: !editWhy(lvl, cap.key, c) })),
      editable: !editWhy(lvl, cap.key, null),
      changed: !!(o && o.min != null && !cap.locked),
    });
  }
  return { groups: groups.filter((g) => g.rows.length), canEdit: lvl >= ADMIN, owner: lvl >= OWNER, classes: CLASS_COLS };
}

let timer = null, pollTimer = null;
/** The minute timer: a full reload, or - when the load at start failed - another try at it (1.99acl). */
function tick() {
  const what = ready ? "reload" : "init";
  return (ready ? reload() : init()).catch((e) => console.error("[siteperms] " + what + ":", e.message));
}
function register(app, { noTimers } = {}) {
  init().catch((e) => console.error("[siteperms] init:", e.message));
  if (!noTimers && !timer) {
    timer = setInterval(tick, 60e3);
    if (timer.unref) timer.unref();
    // 1.99acl: other processes' edits within 5 s (one cheap max(ts) / count query; a reload only when it moved)
    pollTimer = setInterval(() => { poll().catch((e) => console.error("[siteperms] poll:", e.message)); }, 5e3);
    if (pollTimer.unref) pollTimer.unref();
  }
}

module.exports = { init, reload, poll, tick, register, can, canId, canAny, minClass, atLeast, gate, areaHome, AREA_PAGES, install, setMin, view, editWhy,
  PermError, CAPS: C.CAPS, BY_KEY: C.BY_KEY, GROUPS: C.GROUPS, RANK: C.RANK, classRank: C.classRank, LABEL_MIN,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; OV = Object.create(null); MIN = Object.create(null); SEEN = null; } };
