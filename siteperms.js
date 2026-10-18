// siteperms.js — 1.99ack site: the website's own permissions (release 2 of /admin/roles; the registry is siteperms-core.js).
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
const { runQuery, getQuery } = require("./dbUtils");
const C = require("./siteperms-core");

const OWNER = 100, ADMIN = 80;   // Pepe role levels (pepeperms.LEVEL)

let OV = {};        // key -> {min, ts, by, lvl} (min null = a reset row)
let MIN = {};       // key -> min (overrides in force)
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
async function reload() {
  const rows = await getQuery("SELECT key, min_class, ts, by, by_level FROM site_perms");
  const ov = {}, min = {};
  for (const r of rows) {
    const cap = C.BY_KEY[r.key];
    if (!cap) continue;                                    // a key the registry dropped
    const m = r.min_class && C.RANK[r.min_class] ? r.min_class : null;
    ov[r.key] = { min: m, ts: Number(r.ts) || 0, by: r.by || null, lvl: r.by_level == null ? null : Number(r.by_level) };
    if (m && !cap.locked) min[r.key] = m;
  }
  OV = ov; MIN = min;
  return Object.keys(min).length;
}

function can(user, key) { return C.check(MIN, user, key); }
async function canId(userId, key) {
  if (!C.BY_KEY[key]) return C.check(MIN, null, key);     // throws / denies like can()
  if (!userId) return false;
  const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0];
  return can(u || null, key);
}
function minClass(key) {
  if (!C.BY_KEY[key]) { C.check(MIN, null, key); return null; }
  return C.minOf(MIN, key);
}
/** Class ladder for an audience a setting names ("admin" / "staff" / "assistant"). */
function atLeast(user, cls) { const r = C.RANK[cls]; return !!r && C.classRank(user) >= r; }
/** Any of these keys. */
function canAny(user, keys) { return keys.some((k) => can(user, k)); }

// ── the admin area: Admins / Staff (admin.area) everywhere; anyone else only on a page they hold a key for ──
/** The admin pages with a gate of their own and the capability that opens each for someone without admin.area (Assistants,
 *  by default: the first three; the rest only when an override lowers them) - in the nav's order, the first one is their home. */
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

/** "" when an editor at Pepe level `lvl` may set key to val (null = default), else why not. */
function editWhy(lvl, key, val) {
  if (lvl < ADMIN) return "Only Pepe's admins and owners change the website's permissions.";
  const cap = C.BY_KEY[key];
  if (!cap) return "No such permission.";
  if (cap.locked) return "That permission is locked - it can't be changed here.";
  if (val != null && !C.RANK[val]) return "Pick Admin, Staff or Assistant (nothing goes below Assistant).";
  const cur = OV[key];
  if (lvl < OWNER && cur && cur.min != null && (cur.lvl || 0) >= OWNER) return OWNER_SET;
  return "";
}
const OWNER_SET = "Only an owner can change that (an owner set it).";

/** A change made on /admin/roles: key's minimum class -> value ("admin" | "staff" | "assistant" | "default"). */
async function setMin(ed, key, value) {
  await init();
  if (!ed) throw new PermError(401, "auth", "Sign in first.");
  const k = String(key || "");
  const v = value == null || value === "default" || value === "" ? null : String(value).toLowerCase();
  const why = editWhy(ed.level, k, v);
  if (why) {
    const code = ed.level < ADMIN ? "not_pepe_admin" : why === OWNER_SET ? "owner_only" : !C.BY_KEY[k] ? "invalid" : C.BY_KEY[k].locked ? "locked" : "invalid";
    throw new PermError(code === "invalid" ? 400 : 403, code, why);
  }
  const cur = OV[k] || null;
  const from = cur ? cur.min : null;
  if (from === v && (cur || v == null)) return { key: k, value: v, unchanged: true };
  const ts = Math.max(now(), cur ? cur.ts + 1 : 0);
  const by = "web:" + String(ed.username || "?");
  await runQuery(`INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET min_class = excluded.min_class, ts = excluded.ts, by = excluded.by, by_level = excluded.by_level`,
                 [k, v, ts, by.slice(0, 80), ed.level]);
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
    const ownerSet = !!(o && o.min != null && (o.lvl || 0) >= OWNER);
    groups[gi[cap.group]].rows.push({
      key: cap.key, label: cap.label, def: cap.def, over: cap.locked ? null : (o ? o.min : null), eff,
      locked: cap.locked || null, lockLabel: cap.locked ? "siteperm.lock." + cap.locked : null,
      by: o ? o.by : null, ts: o ? o.ts : 0, ownerSet,
      ladder: CLASS_COLS.map((c) => ({ cls: c, has: C.RANK[c] >= C.RANK[eff] })),
      options: CLASS_COLS.map((c) => ({ v: c, ok: !editWhy(lvl, cap.key, c) })),
      editable: !editWhy(lvl, cap.key, null),
      changed: !!(o && o.min != null && !cap.locked),
    });
  }
  return { groups: groups.filter((g) => g.rows.length), canEdit: lvl >= ADMIN, owner: lvl >= OWNER, classes: CLASS_COLS };
}

let timer = null;
function register(app, { noTimers } = {}) {
  init().catch((e) => console.error("[siteperms] init:", e.message));
  if (!noTimers && !timer) {
    timer = setInterval(() => { if (ready) reload().catch((e) => console.error("[siteperms] reload:", e.message)); }, 60e3);
    if (timer.unref) timer.unref();
  }
}

module.exports = { init, reload, register, can, canId, canAny, minClass, atLeast, gate, areaHome, AREA_PAGES, install, setMin, view, editWhy,
  PermError, CAPS: C.CAPS, BY_KEY: C.BY_KEY, GROUPS: C.GROUPS, RANK: C.RANK, classRank: C.classRank, LABEL_MIN,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; OV = {}; MIN = {}; } };
