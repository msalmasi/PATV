// staffroles.js — 1.99abn: Pepe's roles shared with the website, one list kept in step both ways.
//   * roles: owner > admin > staff > assistant > trusted (camfrog-bot pepe_acl.py has the same ladder and rules)
//   * pepe_roles holds {login -> role, ts}; a removal is a row with role NULL (a tombstone, so it travels too). Pepe
//     posts his whole map every minute (POST /api/pepe/roles/bot, bot token) and adopts the merged answer - per login
//     the newer change wins. A change made here (Admin → Users → Assign a class) reaches Pepe on his next sync.
//   * site classes follow the roles for accounts linked to that Camfrog login: owner / admin -> Admin, staff -> Staff,
//     assistant -> Assistant; a linked account whose role went away drops from those classes to "pleb". Accounts
//     without a linked login, or logins this list never had, are never touched (no surprise demotions).
//   * who may change what (the same as Pepe's !role): owners anything; admins hand out staff / assistant / trusted to
//     people below admin. Pepe always keeps an owner.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const LEVEL = { owner: 100, admin: 80, staff: 50, assistant: 35, trusted: 20 };
const ROLES = Object.keys(LEVEL);
const CLASS_OF = { owner: "Admin", admin: "Admin", staff: "Staff", assistant: "Assistant" };
const MANAGED = new Set(["Admin", "Staff", "Assistant"]);
const ROLE_OF_CLASS = { Admin: "admin", Staff: "staff", Assistant: "assistant" };
const LOGIN_RE = /^[\w.\-$]{1,40}$/;

let clock = () => Date.now();
const now = () => clock();

class RoleError extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_roles (login TEXT PRIMARY KEY, role TEXT, ts INTEGER NOT NULL DEFAULT 0,
                      by TEXT, via TEXT)`);
      // the class picker offers Assistant (Admin / Staff are there already on prod; added if missing)
      try {
        for (const c of ["Admin", "Staff", "Assistant"]) {
          const have = await getQuery("SELECT classId FROM classes WHERE class = ?", [c]);
          if (!have.length) await runQuery("INSERT INTO classes (classId, class) VALUES (?, ?)", [require("crypto").randomUUID(), c]);
        }
      } catch (e) { /* no classes table (tests) */ }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const low = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();
async function rows() {
  await init();
  return getQuery("SELECT login, role, ts, by, via FROM pepe_roles");
}
/** {login: {role, ts}} including removals (role null). */
async function map() {
  const m = {};
  for (const r of await rows()) m[r.login] = { role: r.role || null, ts: Number(r.ts) || 0 };
  return m;
}
async function roleOf(login) {
  const l = low(login);
  if (!l) return null;
  const r = (await getQuery("SELECT role FROM pepe_roles WHERE login = ?", [l]))[0];
  return r && r.role ? r.role : null;
}
const levelOf = (role) => LEVEL[role] || 0;

async function write(login, role, ts, by, via) {
  await runQuery(`INSERT INTO pepe_roles (login, role, ts, by, via) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET role = excluded.role, ts = excluded.ts, by = excluded.by, via = excluded.via`,
                 [login, role, ts, String(by || "").slice(0, 80) || null, via]);
}

/** Pepe's sync: {roles: {login: [role|null, ts]}} -> the merged map back (same shape). Newer wins per login; a merge
 *  that would leave nobody an owner keeps the owners it had. */
async function botSync(body = {}) {
  await init();
  const cur = await map();
  const inc = body && typeof body.roles === "object" && body.roles ? body.roles : {};
  const next = { ...cur };
  const changed = [];
  for (const [k, v] of Object.entries(inc).slice(0, 500)) {
    const l = low(k);
    if (!LOGIN_RE.test(l) || !Array.isArray(v)) continue;
    const role = v[0] == null ? null : String(v[0]).toLowerCase();
    const ts = Math.floor(Number(v[1]) || 0);
    if (role !== null && !ROLES.includes(role)) continue;
    const c = cur[l];
    if (!c || ts > c.ts) { next[l] = { role, ts }; changed.push(l); }
  }
  if (!Object.values(next).some((x) => x.role === "owner")) {
    for (const l of changed.slice()) if (cur[l] && cur[l].role === "owner") { next[l] = cur[l]; changed.splice(changed.indexOf(l), 1); }
  }
  for (const l of changed) await write(l, next[l].role, next[l].ts, "pepe", "chat");
  if (changed.length) await reconcile(changed);
  const out = {};
  for (const [l, x] of Object.entries(next)) out[l] = [x.role, x.ts];
  return { ok: true, roles: out, changed: changed.length };
}

/** A change made on the website: actor (their linked login) sets target's role (null = none). Pepe's !role rules. */
async function setRole(actorLogin, targetLogin, role, by) {
  await init();
  const a = low(actorLogin), t = low(targetLogin);
  if (!LOGIN_RE.test(t)) throw new RoleError(400, "That isn't a Camfrog login.");
  if (role !== null && !ROLES.includes(role)) throw new RoleError(400, "Roles: owner, admin, staff, assistant, trusted.");
  const me = levelOf(await roleOf(a)), cur = levelOf(await roleOf(t)), want = levelOf(role);
  if (me < LEVEL.owner) {
    if (me < LEVEL.admin) throw new RoleError(403, "Only Pepe's admins and owners change roles (your account is linked to " + (a || "no Camfrog name") + ").");
    if (cur >= me || want >= me) throw new RoleError(403, "Admins hand out staff / assistant / trusted, and only to people below admin.");
  }
  const m = await map();
  m[t] = { role, ts: now() };
  if (!Object.values(m).some((x) => x.role === "owner")) throw new RoleError(409, "Refusing - Pepe would have no owner.");
  await write(t, role, m[t].ts, by, "web");
  await reconcile([t]);
  return { login: t, role };
}

/** Site classes for linked accounts of these logins (all known logins when omitted). */
async function reconcile(logins) {
  await init();
  const m = await map();
  const list = (logins || Object.keys(m)).map(low).filter((l) => m[l]);
  let n = 0;
  for (const l of list) {
    const want = CLASS_OF[m[l].role] || null;
    const users = await getQuery("SELECT userId, class FROM users WHERE lower(camfrogUsername) = ?", [l]).catch(() => []);
    for (const u of users) {
      if (u.class === "Bot" || u.class === "Banned") continue;
      if (want && u.class !== want) { await runQuery("UPDATE users SET class = ? WHERE userId = ?", [want, u.userId]); n++; }
      else if (!want && MANAGED.has(u.class)) { await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [u.userId]); n++; }
    }
  }
  if (n) console.log(`[staffroles] ${n} site class(es) brought in step with Pepe's roles`);
  return n;
}

/** Admin → Users → Assign a class (Admins only - 1.99abn: Staff could set anyone's class, Admin included). Admin / Staff /
 *  Assistant go through Pepe's roles (setRole: his hierarchy, and the class follows); other classes are set directly. */
async function classUpdate(actor, username, cls) {
  await init();
  if (!SP.can(actor, "roles.assign")) throw new RoleError(403, "Only Admins change classes.");   // 1.99ack: roles.assign (locked: Admins)
  cls = String(cls || "").trim();
  if (!cls || cls.length > 40) throw new RoleError(400, "Pick a class.");
  const known = new Set((await getQuery("SELECT class FROM classes").catch(() => [])).map((r) => r.class));
  if ((!known.has(cls) && cls !== "pleb") || cls === "Bot") throw new RoleError(400, "That class isn't on the list.");
  const t = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE username = ?", [String(username || "")]))[0];
  if (!t) throw new RoleError(404, "No account by that username.");
  if (t.class === "Bot") throw new RoleError(409, "That's Pepe's own account.");
  if (MANAGED.has(cls) || MANAGED.has(t.class)) {
    const tl = low(t.camfrogUsername);
    if (!tl) throw new RoleError(409, "Link their Camfrog name first - Admin / Staff / Assistant follow Pepe's roles (owner / admin = Admin).");
    const me = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [actor.userId]))[0];
    const cur = await roleOf(tl);
    const role = MANAGED.has(cls) ? ROLE_OF_CLASS[cls] : null;
    if (!(cls === "Admin" && (cur === "owner" || cur === "admin")) && cur !== role) {
      await setRole(me && me.camfrogUsername, tl, role, "web:" + String(actor.username || "?"));
    }
    if (!MANAGED.has(cls)) await runQuery("UPDATE users SET class = ? WHERE userId = ?", [cls, t.userId]);
    else await reconcile([tl]);
    return { message: "User class updated successfully.", login: tl, role: await roleOf(tl) };
  }
  await runQuery("UPDATE users SET class = ? WHERE userId = ?", [cls, t.userId]);
  return { message: "User class updated successfully." };
}
/** Manage classes: Admins only; the classes Pepe's roles use (and pleb / Bot) can't be removed. */
async function classesEdit(actor, action, className) {
  await init();
  if (!SP.can(actor, "roles.class_list")) throw new RoleError(403, "Only Admins edit the class list.");   // 1.99ack: roles.class_list (locked)
  const c = String(className || "").trim();
  if (!c || c.length > 40 || /[<>"'&]/.test(c)) throw new RoleError(400, "A class name, up to 40 characters.");
  if (action === "add") {
    if ((await getQuery("SELECT classId FROM classes WHERE class = ?", [c])).length) return { message: "Class already exists." };
    await runQuery("INSERT INTO classes (classId, class) VALUES (?, ?)", [require("crypto").randomUUID(), c]);
    return { message: "Class added successfully." };
  }
  if (action === "remove") {
    if (MANAGED.has(c) || c === "pleb" || c === "Bot") throw new RoleError(409, "That class is in use by Pepe's roles - it stays.");
    const r = await runQuery("DELETE FROM classes WHERE class = ?", [c]);
    if (!r || !r.changes) throw new RoleError(404, "Class not found.");
    return { message: "Class removed successfully." };
  }
  throw new RoleError(400, "Invalid action specified.");
}

let timer = null;
function register(app, { isBotToken, noTimers } = {}) {
  init().catch((e) => console.error("[staffroles] init:", e.message));
  // a member who links their Camfrog name later gets their class within a few minutes
  if (!noTimers && !timer) {
    timer = setInterval(() => reconcile().catch((e) => console.error("[staffroles] reconcile:", e.message)), 5 * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  app.post("/api/pepe/roles/bot", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const out = await botSync(b);
      // 1.99acj: + Pepe's per-command permissions and their defaults (pepeperms.js) - only when he sends them (1.99aci+);
      // a failure there never costs the roles answer
      if (b.perms || b.acl_defaults) {
        try { Object.assign(out, await require("./pepeperms").botSync(b)); } catch (e) { console.error("[staffroles] perms:", e.message); }
      }
      res.json(out);
    } catch (e) { console.error("[staffroles]", e); res.status(500).json({ ok: false }); }
  });
}

module.exports = { init, map, roleOf, botSync, setRole, reconcile, register, classUpdate, classesEdit, RoleError, LEVEL, ROLES, CLASS_OF, MANAGED, ROLE_OF_CLASS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; } };
