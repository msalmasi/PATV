// pepeperms.js — 1.99acj site: Pepe's per-command permissions shared with the website + /admin/roles (release 1).
//
//   * pepe_perms holds one row per per-command entry, keyed like Pepe's sync (camfrog-bot pepe_acl.py, 1.99aci):
//       "powers:!cmd"          the lowest role that gets the command's ADMIN POWERS (Pepe's default: admin, or DEFAULT_GRANTS)
//       "use:!cmd"             the lowest role that may run the command at all (default: everyone)
//       "targets:!cmd:<role>"  for staff / assistant on a moderation command (MOD_RULES): the lowest Pepe role they may
//                              NOT act on - nobody (not theirs) / assistant / staff / admin / anyone
//     val NULL is a reset to Pepe's default (a tombstone, so it travels too). It rides Pepe's 60 s role sync
//     (POST /api/pepe/roles/bot, staffroles.js): he sends {perms: {v, entries: {key: [val|null, ts, by]}}, acl_defaults}
//     and adopts the merged answer - per entry the newer change wins, exactly like the roles. Each entry also carries the
//     editor's Pepe level ([val, ts, by, level]): an admin-level change that lands on a value only an owner could set (a
//     race - the admin never saw it) loses to it on both sides (pick / pepe_acl._acl_perm_pick).
//   * acl_defaults: Pepe's code defaults (DEFAULT_GRANTS, OWNER_POWERS, ADMIN_ONLY_POWERS, MOD_RULES and the moderation
//     bounds) arrive with every sync, so the site keeps no copy of them; until Pepe (1.99aci+) has synced, the command
//     tables say so and can't be edited (role holders still can).
//   * mixed versions: an old Pepe sends no "perms" -> nothing here changes and his answer carries no perms; an old site
//     ignores the new fields and Pepe keeps his own.
//   * edits made here follow Pepe's !perm rules (pepe_acl._acl_perm_why), decided by the editor's PEPE role (pepe_roles,
//     via their linked Camfrog login): admins and owners only; OWNER_POWERS' powers never move; room-role commands'
//     powers stay admin / owner; and an admin may only make changes an admin could make - never "owner", never "anyone" as
//     a moderation floor, never widen a room-role command's moderation rule past its default, never change an entry an
//     owner set beyond that. Every web change is written to admin_audit.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SR = require("./staffroles");

const LEVEL = { owner: 100, admin: 80, staff: 50, assistant: 35, trusted: 20, everyone: 0 };
const GRANT_ROLES = ["owner", "admin", "staff", "assistant", "trusted"];
const USE_ROLES = ["owner", "admin", "staff", "assistant", "trusted", "everyone"];
const FLOORS = ["nobody", "assistant", "staff", "admin", "anyone"];
const FLOOR_RANK = Object.fromEntries(FLOORS.map((f, i) => [f, i]));
const CMD_RE = /^![a-z0-9_\-.?]{1,39}$/;
const MAX_ENTRIES = 3000;

let clock = () => Date.now();
const now = () => clock();

class PermError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_perms (key TEXT PRIMARY KEY, val TEXT, ts INTEGER NOT NULL DEFAULT 0,
                      by TEXT, via TEXT, lvl INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS pepe_perm_meta (k TEXT PRIMARY KEY, v TEXT, at INTEGER)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const cmdOf = (c) => {
  c = String(c == null ? "" : c).trim().toLowerCase();
  if (c && !c.startsWith("!")) c = "!" + c;
  return CMD_RE.test(c) ? c : null;
};

// ── Pepe's defaults (from his sync) ──
const strList = (a, max = 400) => (Array.isArray(a) ? a.slice(0, max).map((x) => cmdOf(x)).filter(Boolean) : []);
/** Clean a defaults blob from Pepe -> the shape the page and the rules use, or null when it isn't one. */
function cleanDefaults(d) {
  if (!d || typeof d !== "object" || Number(d.v) !== 1) return null;
  const grants = {};
  for (const [k, v] of Object.entries(d.default_grants || {}).slice(0, 400)) {
    const c = cmdOf(k);
    if (c && GRANT_ROLES.includes(String(v))) grants[c] = String(v);
  }
  const roles = Array.isArray(d.mod_roles) ? d.mod_roles.filter((r) => r === "staff" || r === "assistant") : [];
  const max = {};
  for (const r of roles) max[r] = FLOORS.includes(String((d.mod_floor_max || {})[r])) ? String(d.mod_floor_max[r]) : "nobody";
  const mod = {};
  for (const [k, v] of Object.entries(d.mod_rules || {}).slice(0, 50)) {
    const c = cmdOf(k);
    if (!c || !v || typeof v !== "object") continue;
    mod[c] = {};
    for (const r of roles) mod[c][r] = FLOORS.includes(String(v[r])) ? String(v[r]) : "nobody";
  }
  const ceil = {};
  for (const r of roles) ceil[r] = Math.max(0, Math.min(4, Number((d.mod_cf_ceiling || {})[r]) || 0));
  return { v: 1, default_grants: grants, owner_only: strList(d.owner_only), admin_only: strList(d.admin_only),
           mod_rules: mod, mod_roles: roles, mod_floor_max: max, mod_cf_ceiling: ceil };
}

async function meta(k) {
  await init();
  const r = (await getQuery("SELECT v, at FROM pepe_perm_meta WHERE k = ?", [k]))[0];
  if (!r) return null;
  try { return { v: JSON.parse(r.v), at: Number(r.at) || 0 }; } catch (e) { return null; }
}
async function setMeta(k, v) {
  await runQuery(`INSERT INTO pepe_perm_meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at`,
                 [k, JSON.stringify(v), now()]);
}
async function defaults() { const m = await meta("defaults"); return m ? cleanDefaults(m.v) : null; }

// ── entries ──
/** "powers:!x" / "use:!x" / "targets:!x:staff" -> {kind, cmd, role} or null */
function parseKey(key) {
  const p = String(key || "").split(":");
  if (p.length === 2 && (p[0] === "powers" || p[0] === "use")) {
    const c = cmdOf(p[1]);
    return c ? { kind: p[0], cmd: c, role: null } : null;
  }
  if (p.length === 3 && p[0] === "targets" && (p[2] === "staff" || p[2] === "assistant")) {
    const c = cmdOf(p[1]);
    return c ? { kind: "targets", cmd: c, role: p[2] } : null;
  }
  return null;
}
const keyOf = (kind, cmd, role) => (kind === "targets" ? `targets:${cmd}:${role}` : `${kind}:${cmd}`);

/** The bounds of a moderation floor (Pepe's mod_floor_why): "" = fine, else why not. */
function floorWhy(D, cmd, role, floor) {
  if (!D || !D.mod_rules[cmd]) return "That command has no moderation rules.";
  if (!D.mod_roles.includes(role)) return "Moderation rules are for staff and assistants.";
  if (!FLOORS.includes(floor)) return "Pick one of the listed choices.";
  if (floor !== "nobody" && floor !== "anyone" && FLOOR_RANK[floor] > FLOOR_RANK[D.mod_floor_max[role] || "nobody"]) {
    return `${role === "staff" ? "Staff" : "Assistants"} can act on people below ${D.mod_floor_max[role]} at most (or anyone).`;
  }
  return "";
}
/** Would Pepe keep this value for this entry? (pepe_acl._acl_perm_val_ok) */
function valueOk(D, p, val) {
  if (val == null) return true;
  if (p.kind === "use") return USE_ROLES.includes(val);
  if (p.kind === "powers") {
    if (!GRANT_ROLES.includes(val)) return false;
    if (D && D.owner_only.includes(p.cmd)) return false;
    if (D && D.admin_only.includes(p.cmd) && val !== "admin" && val !== "owner") return false;
    return true;
  }
  return D ? !floorWhy(D, p.cmd, p.role, val) : FLOORS.includes(val);
}

async function entries() {
  await init();
  const m = {};
  for (const r of await getQuery("SELECT key, val, ts, by, via, lvl FROM pepe_perms")) {
    m[r.key] = { val: r.val || null, ts: Number(r.ts) || 0, by: r.by || null, via: r.via || null, lvl: r.lvl == null ? null : Number(r.lvl) };
  }
  return m;
}
async function write(key, val, ts, by, via, lvl) {
  await runQuery(`INSERT INTO pepe_perms (key, val, ts, by, via, lvl) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET val = excluded.val, ts = excluded.ts, by = excluded.by, via = excluded.via, lvl = excluded.lvl`,
                 [key, val, ts, String(by || "").slice(0, 80) || null, via, lvl == null ? null : lvl]);
}
const lvlOf = (v) => (Array.isArray(v) && v.length > 3 && Number.isInteger(v[3]) ? v[3] : null);

/** Pepe's sync (called by staffroles' /api/pepe/roles/bot): store his defaults, merge his entries (newer wins per entry),
 *  answer {perms: {v, entries}} - only when he sent perms (an old Pepe gets the answer he always got). */
async function botSync(body = {}) {
  await init();
  const out = {};
  const D0 = cleanDefaults(body && body.acl_defaults);
  if (D0) await setMeta("defaults", D0);           // the cleaned shape (cleanDefaults is idempotent on it)
  const P = body && body.perms;
  if (!P || typeof P !== "object" || typeof P.entries !== "object" || !P.entries) return out;
  const D = D0 || (await defaults());
  const cur = await entries();
  let changed = 0;
  for (const [k, v] of Object.entries(P.entries).slice(0, MAX_ENTRIES)) {
    const p = parseKey(k);
    if (!p || !Array.isArray(v) || v.length < 2) continue;
    const val = v[0] == null ? null : String(v[0]).toLowerCase();
    const ts = Math.floor(Number(v[1]) || 0);
    if (!valueOk(D, p, val)) continue;
    const key = keyOf(p.kind, p.cmd, p.role);
    const c = cur[key];
    const inc = { val, ts, by: v[2] ? "pepe:" + String(v[2]).slice(0, 60) : "pepe", via: "chat", lvl: lvlOf(v) };
    const win = c ? pick(D, p, c, inc) : inc;
    if (win !== c) {
      await write(key, win.val, win.ts, win.by, win.via, win.lvl);
      cur[key] = win;
      changed++;
    }
  }
  await setMeta("perms_synced", { changed });
  const ent = {};
  for (const [k, x] of Object.entries(cur)) ent[k] = [x.val, x.ts, x.by, x.lvl == null ? null : x.lvl];
  out.perms = { v: 1, entries: ent };
  return out;
}

/** One entry, two versions (ours, Pepe's) -> the one that stands (pepe_acl._acl_perm_pick): the newer wins (a tie: ours),
 *  EXCEPT an admin-level change over a value only an owner could set - the admin never saw that value (it hadn't synced
 *  yet; both sides refuse such a change outright), so the owner's value stands, re-stamped just after the admin's. */
function pick(D, p, cur, inc) {
  const newer = inc.ts > cur.ts ? inc : cur, older = newer === inc ? cur : inc;
  if (D && newer.lvl != null && newer.lvl < LEVEL.owner && older.val != null && !adminCouldSet(D, p.kind, p.cmd, older.val, p.role)) {
    return { ...older, ts: newer.ts + 1 };
  }
  return newer;
}

// ── the rules (pepe_acl._acl_perm_why) ──
function defaultVal(D, kind, cmd, role) {
  if (kind === "use") return "everyone";
  if (kind === "powers") return D.owner_only.includes(cmd) ? "owner" : (D.default_grants[cmd] || "admin");
  return (D.mod_rules[cmd] || {})[role] || "nobody";
}
function adminCouldSet(D, kind, cmd, val, role) {
  if (val == null || val === defaultVal(D, kind, cmd, role)) return true;
  if (kind === "use" || kind === "powers") return val !== "owner";
  if (val === "anyone") return false;
  if (D.admin_only.includes(cmd) && FLOOR_RANK[val] > FLOOR_RANK[defaultVal(D, kind, cmd, role)]) return false;
  return true;
}
/** "" if an editor with Pepe role level `lvl` may set kind/cmd(/role) to val (null = default), else why not. */
function permWhy(D, lvl, cur, kind, cmd, val, role) {
  if (lvl < LEVEL.admin) return "Only Pepe's admins and owners change permissions.";
  if (!D) return "Pepe hasn't synced his permission table yet.";
  if (!cmd) return "That isn't a command (letters, digits, - _ . ? after the !).";
  if (kind === "targets") {
    const why = floorWhy(D, cmd, role, val == null ? "nobody" : val);
    if (why) return why;
  } else if (kind !== "use" && kind !== "powers") {
    return "Pick powers, use or targets.";
  } else if (val != null) {
    if (!(kind === "use" ? USE_ROLES : GRANT_ROLES).includes(val)) return "Pick one of the listed roles.";
    if (kind === "powers" && D.owner_only.includes(cmd)) return `${cmd}'s powers are Pepe owners' only (points, the economy, Pepe's process, data).`;
    if (kind === "powers" && D.admin_only.includes(cmd) && ["staff", "assistant", "trusted"].includes(val)) {
      return `${cmd} changes Camfrog room roles - its powers stay with Pepe admins and owners.`;
    }
  }
  if (lvl < LEVEL.owner) {
    if (!adminCouldSet(D, kind, cmd, cur, role)) return OWNER_SET;
    if (!adminCouldSet(D, kind, cmd, val, role)) return OWNER_ONLY;
  }
  return "";
}
const OWNER_SET = "Only an owner can change that (an owner set it).";
const OWNER_ONLY = "Only an owner can do that.";
/** permWhy's answer -> an HTTP refusal */
function refusal(D, lvl, why) {
  if (lvl < LEVEL.admin) return new PermError(403, "not_pepe_admin", why);
  if (!D) return new PermError(409, "not_synced", why);
  if (why === OWNER_SET || why === OWNER_ONLY) return new PermError(403, "owner_only", why);
  return new PermError(400, "invalid", why);
}

// ── editors ──
const low = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();
/** The editor: their site account + Pepe role via the linked Camfrog login. */
async function editorOf(userId) {
  const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [userId]).catch(() => []))[0] || null;
  if (!me) return null;
  const login = low(me.camfrogUsername);
  const role = login ? await SR.roleOf(login) : null;
  // an account that lost the Admin class edits nothing (1.99ack: roles.assign - siteperms.js, locked: Admins)
  const level = require("./siteperms").can(me, "roles.assign") ? (LEVEL[role] || 0) : 0;
  return { userId: me.userId, username: me.username, cls: me.class, login: login || null, role: role || null, level };
}

const audit = (ed, action, detail) => require("./adminaudit").record({ userId: ed.userId, username: ed.username }, action, null, detail);

/** A per-command change made on the website. kind powers | use | targets; val a role / floor, or "default". */
async function setPerm(ed, { kind, cmd, value, role } = {}) {
  await init();
  if (!ed) throw new PermError(401, "auth", "Sign in first.");
  const D = await defaults();
  const c = cmdOf(cmd);
  kind = String(kind || "");
  role = kind === "targets" ? String(role || "") : null;
  const v = value == null || value === "default" ? null : String(value).toLowerCase();
  const key = c ? keyOf(kind, c, role) : null;
  const all = await entries();
  const cur = key && all[key] ? all[key].val : null;
  const why = permWhy(D, ed.level, cur, kind, c, v, role);
  if (why) throw refusal(D, ed.level, why);
  if (cur === v && all[key]) return { key, value: v, unchanged: true };
  const ts = Math.max(now(), (all[key] ? all[key].ts : 0) + 1);
  await write(key, v, ts, "web:" + String(ed.username || "?"), "web", ed.level);
  await audit(ed, "pepe_perm", { key, from: cur, to: v, editor_role: ed.role });
  return { key, value: v };
}
/** "Reset to default" for a command: its powers and use (and its moderation floors), each checked like a single change. */
async function resetCmd(ed, cmd) {
  if (!ed) throw new PermError(401, "auth", "Sign in first.");
  if (ed.level < LEVEL.admin) throw new PermError(403, "not_pepe_admin", "Only Pepe's admins and owners change permissions.");
  if (!(await defaults())) throw new PermError(409, "not_synced", "Pepe hasn't synced his permission table yet.");
  const c = cmdOf(cmd);
  if (!c) throw new PermError(400, "invalid", "That isn't a command.");
  const all = await entries();
  const keys = Object.keys(all).filter((k) => all[k].val != null && (k === "powers:" + c || k === "use:" + c || k.startsWith("targets:" + c + ":")));
  const D = await defaults();
  for (const k of keys) {   // check them all first: all or nothing
    const p = parseKey(k);
    const why = permWhy(D, ed.level, all[k].val, p.kind, p.cmd, null, p.role);
    if (why) throw refusal(D, ed.level, why);
  }
  for (const k of keys) { const p = parseKey(k); await setPerm(ed, { kind: p.kind, cmd: p.cmd, role: p.role, value: "default" }); }
  return { reset: keys.length };
}

/** Role holders: !role's rules (staffroles.setRole), audited. role null / "none" removes. */
async function setRole(ed, login, role) {
  if (!ed) throw new PermError(401, "auth", "Sign in first.");
  if (ed.level < LEVEL.admin) throw new PermError(403, "not_pepe_admin", "Only Pepe's admins and owners change roles (your account needs a linked Camfrog login with one of those roles).");
  const r = role == null || role === "" || role === "none" ? null : String(role).toLowerCase();
  const t = low(login);
  const from = await SR.roleOf(t);
  let res;
  try { res = await SR.setRole(ed.login, t, r, "web:" + String(ed.username || "?")); }
  catch (e) { if (e && e.refuse) throw new PermError(e.status || 400, e.status === 403 ? "owner_only" : "invalid", e.message); throw e; }
  await audit(ed, "pepe_role", { login: res.login, from, to: res.role, editor_role: ed.role });
  return res;
}

// ── the page's data ──
const ROLE_COLS = ["owner", "admin", "staff", "assistant", "trusted"];
async function view(ed) {
  const D = await defaults();
  const m = await meta("defaults");
  const ps = await meta("perms_synced");
  const all = await entries();
  const roleMap = await SR.map();
  const holders = [];
  for (const [login, x] of Object.entries(roleMap)) {
    if (!x.role) continue;
    const accts = await getQuery("SELECT username FROM users WHERE lower(camfrogUsername) = ? LIMIT 3", [login]).catch(() => []);
    holders.push({ login, role: x.role, ts: x.ts, accounts: accts.map((a) => a.username) });
  }
  holders.sort((a, b) => (LEVEL[b.role] - LEVEL[a.role]) || a.login.localeCompare(b.login));
  const owners = holders.filter((h) => h.role === "owner").length;
  const lvl = ed ? ed.level : 0;
  const isOwner = lvl >= LEVEL.owner;
  for (const h of holders) {
    // what this editor may do to this person (staffroles.setRole's rules)
    h.editable = isOwner || (lvl >= LEVEL.admin && LEVEL[h.role] < lvl);
    h.lastOwner = h.role === "owner" && owners <= 1;
  }
  const out = { synced: !!D, synced_at: m ? m.at : 0, perms_synced_at: ps ? ps.at : 0, holders, editor: ed ? { login: ed.login, role: ed.role, level: lvl, owner: isOwner, admin: lvl >= LEVEL.admin } : null,
                role_options: isOwner ? GRANT_ROLES : lvl >= LEVEL.admin ? ["staff", "assistant", "trusted"] : [], commands: [], targets: [] };
  if (!D) return out;
  const cmds = new Set([...Object.keys(D.default_grants), ...D.owner_only, ...D.admin_only, ...Object.keys(D.mod_rules)]);
  for (const [k, x] of Object.entries(all)) { const p = parseKey(k); if (p && p.kind !== "targets" && x.val != null) cmds.add(p.cmd); }
  for (const c of [...cmds].sort()) {
    const pw = all["powers:" + c], us = all["use:" + c];
    const ownerOnly = D.owner_only.includes(c), roomRole = D.admin_only.includes(c);
    const pDef = defaultVal(D, "powers", c), pOver = pw ? pw.val : null, uOver = us ? us.val : null;
    let pEff = ownerOnly ? "owner" : roomRole ? (pOver === "owner" ? "owner" : "admin") : (pOver || pDef);
    const uEff = uOver || "everyone";
    const ladder = ROLE_COLS.map((r) => {
      const use = LEVEL[r] >= LEVEL[uEff];
      return { role: r, use, powers: use && LEVEL[r] >= LEVEL[pEff] };
    });
    const opt = (kind, list, cur) => list.map((v) => ({ v, ok: lvl >= LEVEL.admin && !permWhy(D, lvl, cur, kind, c, v, null) }));
    const powersList = ownerOnly ? ["owner"] : roomRole ? ["owner", "admin"] : GRANT_ROLES;
    out.commands.push({
      cmd: c, lock: ownerOnly ? "owner" : roomRole ? "room" : null, mod: !!D.mod_rules[c],
      powers: { def: pDef, over: pOver, eff: pEff, by: pw && pw.val != null ? pw.by : null, ts: pw ? pw.ts : 0,
                options: opt("powers", powersList, pOver), locked: ownerOnly || (lvl >= LEVEL.admin && !!permWhy(D, lvl, pOver, "powers", c, null, null) && pOver != null) },
      use: { def: "everyone", over: uOver, eff: uEff, by: us && us.val != null ? us.by : null, ts: us ? us.ts : 0,
             options: opt("use", USE_ROLES, uOver), locked: lvl >= LEVEL.admin && uOver != null && !!permWhy(D, lvl, uOver, "use", c, null, null) },
      overridden: pOver != null || uOver != null,
      ladder,
    });
  }
  for (const c of Object.keys(D.mod_rules).sort()) {
    const row = { cmd: c, room: D.admin_only.includes(c), roles: [] };
    for (const r of D.mod_roles) {
      const e = all[keyOf("targets", c, r)];
      const over = e ? e.val : null, def = D.mod_rules[c][r];
      row.roles.push({ role: r, def, over, eff: over || def, by: e && e.val != null ? e.by : null,
                       options: FLOORS.map((f) => ({ v: f, inBounds: !floorWhy(D, c, r, f), ok: lvl >= LEVEL.admin && !permWhy(D, lvl, over, "targets", c, f, r) })),
                       locked: lvl >= LEVEL.admin && over != null && !!permWhy(D, lvl, over, "targets", c, null, r) });
    }
    out.targets.push(row);
  }
  out.mod_cf_ceiling = D.mod_cf_ceiling;
  return out;
}

module.exports = { init, botSync, setPerm, resetCmd, setRole, view, editorOf, defaults, entries, permWhy, parseKey, cleanDefaults, PermError,
  LEVEL, FLOORS, _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { ready = null; } };
