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
//   * PO-0b (economy policy plan T23, D-5): the OWNER list is pinned on the site. Pepe's sync (bot token) can no longer
//     grant or remove "owner": such a change is held in pepe_roles_pending (and the existing owners get a notice) until
//     an existing owner confirms it on /admin/roles with the password step-up (or rejects it). Pepe's merged answer
//     carries the site's role for that login, so his local change goes back too. Everything else syncs as before.
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
      // PO-0b: an owner grant / removal that arrived by Pepe's sync, waiting for an existing owner (one row per login: the
      // newest change Pepe sent for it; `was` = the role the site had then)
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_roles_pending (login TEXT PRIMARY KEY, role TEXT, ts INTEGER NOT NULL, was TEXT,
                      via TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
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

/** 1.99ada: the user's 2026-10-16 owner rule in one place ("ops / economy is owner-only"): the account holds the site
 *  capability `cap` (its class, siteperms.js) AND its linked chat login is a Pepe "owner" here. `me` needs class +
 *  camfrogUsername read fresh from the database (adminkeys.meOf, recipecfg.meOf). Used by /admin/keys (keys.manage) and the
 *  /admin/economy payout recipe card (econ.pepe_econ_cmds). A roles read that fails answers false. */
async function ownerHolds(me, cap) {
  if (!me || !me.camfrogUsername || !SP.can(me, cap)) return false;
  try { return (await roleOf(me.camfrogUsername)) === "owner"; } catch (e) { return false; }
}

/** PO-0b (D-6, "economy writes are owner-only"): ownerHolds for a request's user, read fresh from the database (a JWT's
 *  class / link can be stale). -> the users row {userId, username, class, camfrogUsername}, or null when it isn't an owner. */
async function ownerOf(user, cap) {
  if (!user || !user.userId) return null;
  const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [user.userId]).catch(() => []))[0] || null;
  return me && (await ownerHolds(me, cap)) ? me : null;
}
/** The words an owner-only refusal says (the API's 403). */
const OWNER_ONLY = "Pepe owners only - your account needs the Admin class and a linked Camfrog login with Pepe's owner role.";

async function write(login, role, ts, by, via) {
  await runQuery(`INSERT INTO pepe_roles (login, role, ts, by, via) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET role = excluded.role, ts = excluded.ts, by = excluded.by, via = excluded.via`,
                 [login, role, ts, String(by || "").slice(0, 80) || null, via]);
}

/** Pepe's sync: {roles: {login: [role|null, ts]}} -> the merged map back (same shape). Newer wins per login; a merge
 *  that would leave nobody an owner keeps the owners it had. PO-0b: a change that grants or removes "owner" is HELD
 *  (pepe_roles_pending) instead - the answer keeps the site's role for that login, so Pepe's copy goes back too - until
 *  an existing owner confirms it on /admin/roles (confirmPending). Only while the site has no owner at all (a fresh
 *  database) does an owner arrive by sync, so there is someone to confirm the next one. */
async function botSync(body = {}) {
  await init();
  const cur = await map();
  const inc = body && typeof body.roles === "object" && body.roles ? body.roles : {};
  const next = { ...cur };
  const changed = [];
  const held = [];
  const pinned = Object.values(cur).some((x) => x.role === "owner");
  for (const [k, v] of Object.entries(inc).slice(0, 500)) {
    const l = low(k);
    if (!LOGIN_RE.test(l) || !Array.isArray(v)) continue;
    const role = v[0] == null ? null : String(v[0]).toLowerCase();
    const ts = Math.floor(Number(v[1]) || 0);
    if (role !== null && !ROLES.includes(role)) continue;
    const c = cur[l];
    if (!c || ts > c.ts) {
      const was = c ? c.role : null;
      if (pinned && (role === "owner") !== (was === "owner")) { held.push({ login: l, role, ts, was }); continue; }
      next[l] = { role, ts };
      changed.push(l);
    }
  }
  if (!Object.values(next).some((x) => x.role === "owner")) {
    for (const l of changed.slice()) if (cur[l] && cur[l].role === "owner") { next[l] = cur[l]; changed.splice(changed.indexOf(l), 1); }
  }
  for (const l of changed) await write(l, next[l].role, next[l].ts, "pepe", "chat");
  if (changed.length) await reconcile(changed);
  const fresh = [];
  for (const h of held) if (await hold(h)) fresh.push(h);
  if (fresh.length) await notifyOwners(fresh);
  const out = {};
  for (const [l, x] of Object.entries(next)) out[l] = [x.role, x.ts];
  return { ok: true, roles: out, changed: changed.length, held: held.length };
}

// ── PO-0b: owner changes from Pepe's sync wait for an owner on the website ──
/** Store (or refresh) a held owner change. -> true when it is new for this login (or a newer change than the one held). */
async function hold({ login, role, ts, was }) {
  const t = now();
  const cur = (await getQuery("SELECT role, ts FROM pepe_roles_pending WHERE login = ?", [login]))[0];
  if (cur && Number(cur.ts) >= ts) return false;
  await runQuery(`INSERT INTO pepe_roles_pending (login, role, ts, was, via, created, updated) VALUES (?, ?, ?, ?, 'pepe', ?, ?)
                  ON CONFLICT(login) DO UPDATE SET role = excluded.role, ts = excluded.ts, was = excluded.was, updated = excluded.updated`,
                 [login, role, ts, was, t, t]);
  console.log(`[staffroles] held Pepe's owner change for ${login}: ${was || "none"} -> ${role || "none"} (an owner confirms it on /admin/roles)`);
  return true;
}
/** A notice to every account linked to an existing owner: what's waiting and where to confirm it. Never throws. */
async function notifyOwners(list) {
  try {
    const owners = Object.entries(await map()).filter(([, x]) => x.role === "owner").map(([l]) => l);
    const what = list.map((h) => `${h.login}: ${h.was || "no role"} -> ${h.role || "no role"}`).join(", ");
    const inbox = require("./inbox");
    for (const l of owners) {
      for (const u of await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [l]).catch(() => [])) {
        await inbox.addSafe(u.userId, { kind: "admin", title: "👑 Owner change from Pepe is waiting for you",
                                        body: `Pepe's role sync asked for: ${what}. Owner changes from chat wait for an owner's confirmation on the website.`,
                                        link: "/admin/roles#pending", ref: `roles-pending:${list.map((h) => h.login + "@" + h.ts).join(",")}`.slice(0, 190) });
      }
    }
  } catch (e) { console.error("[staffroles] owner notice:", e.message); }
}
/** The owner changes waiting for confirmation (oldest first). */
async function pendingList() {
  await init();
  return getQuery("SELECT login, role, ts, was, via, created, updated FROM pepe_roles_pending ORDER BY created, login");
}
/**
 * An existing Pepe owner (`me`: a fresh users row - class + camfrogUsername) confirms or rejects a held owner change. The
 * caller has done the password step-up (econstore.stepUp) and the same-site checks. Confirm = the change Pepe sent, stamped
 * now (newer than both sides' copies, so it travels back to Pepe on his next sync); reject = the row goes, the site's role
 * stands. Pepe always keeps an owner. Both are written to admin_audit.
 */
async function confirmPending(me, login, action) {
  await init();
  const l = low(login);
  // ONE transaction (the review of PO-0b): the role, the pending row and the site classes change together or not at all -
  // a failure part-way never leaves an owner change applied with its row still waiting, or a class out of step with the
  // role. The admin_audit row is written after the commit (adminaudit creates its table lazily: never inside a
  // transaction that may roll back).
  const out = await require("./dbUtils").tx(async () => {
    if (!(await ownerHolds(me, "roles.assign"))) throw new RoleError(403, "Only a Pepe owner confirms owner changes (your account needs a linked Camfrog login with the owner role).");
    const p = (await getQuery("SELECT login, role, ts, was FROM pepe_roles_pending WHERE login = ?", [l]))[0];
    if (!p) throw new RoleError(404, "Nothing is waiting for that login.");
    if (action === "reject") {
      await runQuery("DELETE FROM pepe_roles_pending WHERE login = ?", [l]);
      return { res: { login: l, rejected: true, role: await roleOf(l) }, audit: ["pepe_role_pending_reject", { login: l, asked: p.role, was: p.was }] };
    }
    if (action !== "confirm") throw new RoleError(400, "Confirm or reject.");
    const m = await map();
    const role = p.role || null;
    const ts = Math.max(now(), Number(p.ts) + 1, ((m[l] && m[l].ts) || 0) + 1);
    m[l] = { role, ts };
    if (!Object.values(m).some((x) => x.role === "owner")) throw new RoleError(409, "Refusing - Pepe would have no owner.");
    await write(l, role, ts, "web:" + String(me.username || "?"), "web");
    await runQuery("DELETE FROM pepe_roles_pending WHERE login = ?", [l]);
    await reconcile([l]);
    return { res: { login: l, confirmed: true, role }, audit: ["pepe_role_pending_confirm", { login: l, from: p.was, to: role }] };
  });
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, out.audit[0], null, out.audit[1])
    .catch((e) => console.error("[staffroles] audit:", e && e.message));
  return out.res;
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
  await runQuery("DELETE FROM pepe_roles_pending WHERE login = ?", [t]);   // PO-0b: a web change decides that login - nothing waits any more
  await reconcile([t]);
  return { login: t, role };
}

// ── S1 Q4 (seam plan §12.4 roles/changed; ADR 0007 D11, as the owner changed it on 2026-10-25 - D11-site-roles: the global
// role is the site's, by account - its class (Admin / Staff / Assistant) or the Pepe role of its linked Camfrog login, the
// higher; a Camfrog link is never needed): readers only - no membership hook (the hub mirrors roles through the seam) ──
/**
 * D11-site-roles (the owner's answer of 2026-10-25: "the chat server should accept the site's Admin/Staff label - there should
 * be no Camfrog dependency"): the role a site class gives by itself, by ACCOUNT - the site's own ladder (siteperms-core.js
 * CLASS_RANK: Assistant < Staff < Admin; exact class names only, as siteperms reads them): Admin -> admin, Staff -> staff,
 * Assistant -> assistant; null for every other class (pleb, Bot, Banned, a class an Admin added). No class gives "owner": the
 * site's owners are its pinned owner list (PO-0b), which pepe_roles holds.
 */
function roleOfClass(cls) {
  return cls != null && Object.prototype.hasOwnProperty.call(ROLE_OF_CLASS, cls) ? ROLE_OF_CLASS[cls] : null;
}

/**
 * The global role of these accounts, as the seam's roles/changed carries it (hubroles.js): the HIGHER on the ladder (LEVEL) of
 *   * the account's site class (roleOfClass: Admin / Staff / Assistant) - no linked Camfrog login needed (D11-site-roles), and
 *   * the pepe_roles row of the account's linked Camfrog login, if it has one (the site's role list: owner and trusted have no
 *     class), keyed the way the seam keys it - SQLite's lower(trim(users.camfrogUsername)) (pepe_roles logins are ASCII, so
 *     JavaScript's low() agrees).
 * Neither can take away what the other gives, so an account that never linked Camfrog, or unlinked it, keeps its class's role,
 * and a linked one whose class lags behind Pepe's sync (reconcile runs every 5 minutes) keeps its Pepe role.
 * -> Map(userId -> {login, role, role_at, cls}) for every account that has a users row (role: owner | admin | staff | assistant |
 * trusted | null; role_at: the pepe_roles row's ts when that row decides the answer - a removal is a tombstone with its own ts -
 * null when the class does or there is no row; cls: users.class). An id without a users row is left out (the account is gone).
 */
async function globalRolesOf(userIds) {
  await init();
  const ids = [...new Set([...(userIds || [])].filter((x) => x != null && x !== "").map(String))];
  const out = new Map();
  const users = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    users.push(...(await getQuery(`SELECT userId, class, lower(trim(camfrogUsername)) AS login FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part)));
  }
  const logins = [...new Set(users.map((u) => u.login).filter(Boolean))];
  const roles = new Map();
  for (let i = 0; i < logins.length; i += 400) {
    const part = logins.slice(i, i + 400);
    for (const r of await getQuery(`SELECT login, role, ts FROM pepe_roles WHERE login IN (${part.map(() => "?").join(",")})`, part)) roles.set(r.login, r);
  }
  for (const u of users) {
    const r = u.login ? roles.get(u.login) : null;
    const cls = u.class == null || u.class === "" ? null : String(u.class);
    const pepe = r && ROLES.includes(r.role) ? r.role : null;
    const byClass = roleOfClass(cls);
    const fromClass = levelOf(byClass) > levelOf(pepe);           // a tie is the same role: the row's (and its ts) answer
    out.set(String(u.userId), { login: u.login || null, role: fromClass ? byClass : pepe,
                                role_at: !fromClass && r ? Number(r.ts) || null : null, cls });
  }
  return out;
}
/** One account's global role (globalRolesOf) -> {login, role, role_at, cls}, or null when it has no users row. */
async function globalRoleOf(userId) { return (await globalRolesOf([userId])).get(String(userId)) || null; }

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
      // owner answers 2026-10-20 (3): taking the owner role away needs the password step-up, which lives on /admin/roles -
      // an owner can't do it from the class picker. (Anyone else is refused by setRole's rules, as before.)
      if (cur === "owner" && me && (await roleOf(me.camfrogUsername)) === "owner") {
        throw new RoleError(409, "That's a Pepe owner - owner changes are made on Admin › Roles, with your password.");
      }
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

module.exports = { init, map, roleOf, ownerHolds, ownerOf, OWNER_ONLY, botSync, setRole, reconcile, register, classUpdate, classesEdit, pendingList, confirmPending,
  globalRoleOf, globalRolesOf, roleOfClass,          // S1 Q4: the seam's roles/changed reader (D11-site-roles: + the class's role)
  RoleError, LEVEL, ROLES, CLASS_OF, MANAGED, ROLE_OF_CLASS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; } };
