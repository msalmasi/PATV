// hubroles.js — S1 Q4 (release L1): the roles/changed topic of the v1 seam (seam plan §12.2-§12.6; ADR 0007 D9, D11): an
// account's GLOBAL role, by ACCOUNT - the higher of its site class's role (Admin / Staff / Assistant: no Camfrog link needed,
// D11-site-roles, the owner's change of 2026-10-25) and the Pepe role of its linked Camfrog login, if any (owner and trusted
// come only from there) - staffroles.globalRolesOf; the site's Banned and Bot classes hold none at all (the review of
// D11-site-roles: the site's label decides). Entity acct:<userId>; switch hubseam.roles; huboutbox.js registers the topic,
// the batch reader and the snapshot.
//
//   {account, v1_user, role: owner|admin|staff|assistant|trusted|null, cls|null, role_at: ms|null}   (role_at = pepe_roles.ts
//   when that row decides the role - a removal is Pepe's tombstone row, with its own ts - else null) -> {account, v1_user,
//   gone:true} when the users row is gone. The payload's shape is unchanged by D11-site-roles: only who holds a role is.
//
// Triggers (S1-D3; gated by the switch; (topic, entity) only):
//   pepe_roles  insert / delete / update of login, role (when one changed) -> one row per users row whose
//               lower(trim(camfrogUsername)) is the login (OLD and NEW login), found through users_camfrog_login
//   users       insert WHEN the row comes with a Camfrog login (sign-up, the rehearsal seeding) or a role-giving class (an
//               account created as Staff, a script) / update of camfrogUsername, class WHEN changed (any account: a class
//               change is a role change, linked or not) / delete WHEN the row had a login or a role-giving class (any other
//               row held no role: its unlink or demotion posted already)
// Snapshot (§12.6): the accounts that hold a role - a role-giving class, or a linked login with a Pepe role on an account
// whose class isn't Banned / Bot - acct:<userId> in byte order.
"use strict";
const { getQuery } = require("./dbUtils");

const TOPIC = "roles/changed";
const SWITCH = "roles";

// ── triggers ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = () => `(SELECT value FROM hubseam_settings WHERE key = '${SWITCH}') = 'true'`;
const acct = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || ${expr}, ${MS_SQL} WHERE ${expr} IS NOT NULL;`;
/** the users row linked to a login expression: lower(trim(camfrogUsername)) with the terms of accountMerge.js's partial unique
 *  index users_camfrog_login, so the index answers it (one account per login) - never a scan of users */
const LINKED = "u.camfrogUsername IS NOT NULL AND trim(u.camfrogUsername) != ''";
const byLogin = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || u.userId, ${MS_SQL}
  FROM users u WHERE lower(trim(u.camfrogUsername)) = ${expr} AND ${LINKED};`;
/** D11-site-roles: the classes that give a role by themselves (staffroles.ROLE_OF_CLASS: Admin, Staff, Assistant), as an SQL
 *  list - the same exact names siteperms reads (fixed words, never user input). */
const roleClasses = () => Object.keys(require("./staffroles").ROLE_OF_CLASS).map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
const CLASS_HAS_ROLE = (row) => `${row}."class" IN (${roleClasses()})`;
function triggerSql(userCols = null) {
  const T = [];
  const add = (name, on, body, when = "") => T.push([`hub_s1_rl_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_rl_${name}_v1 ${on}
    WHEN ${gate()}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  add("pr_i", "AFTER INSERT ON pepe_roles", byLogin("NEW.login"));
  add("pr_d", "AFTER DELETE ON pepe_roles", byLogin("OLD.login"));
  add("pr_u", "AFTER UPDATE OF login, role ON pepe_roles", byLogin("NEW.login") + " " + byLogin("(CASE WHEN OLD.login IS NOT NEW.login THEN OLD.login END)"),
      "OLD.login IS NOT NEW.login OR OLD.role IS NOT NEW.role");
  const cols = ["camfrogUsername", "class"].filter((c) => !userCols || userCols.has(c));
  // a row that may hold a role: a Camfrog login (its Pepe role) or a role-giving class (D11-site-roles)
  const holds = (row) => [cols.includes("camfrogUsername") ? `${row}.camfrogUsername IS NOT NULL` : null,
                          cols.includes("class") ? CLASS_HAS_ROLE(row) : null].filter(Boolean).join(" OR ");
  if (cols.length) {
    add("users_i", "AFTER INSERT ON users", acct("NEW.userId"), holds("NEW"));
    add("users_d", "AFTER DELETE ON users", acct("OLD.userId"), holds("OLD"));
  }
  if (cols.length) add("users_u", `AFTER UPDATE OF ${cols.map((c) => `"${c}"`).join(", ")} ON users`, acct("NEW.userId"),
                       cols.map((c) => `OLD."${c}" IS NOT NEW."${c}"`).join(" OR "));
  return T;
}

/** pepe_roles exists, then the triggers. huboutbox.init(). (The login lookups use accountMerge.js's users_camfrog_login.) */
async function init() {
  await require("./staffroles").init();
  await require("./hubpads").installTriggers(triggerSql(await require("./hubidentity").usersColumns()));
}

/** acct:<userId> payloads, read now. -> Map(entity -> payload) (another shape is left out: posted with payload null). */
async function build(entities) {
  const HO = require("./huboutbox");
  const out = new Map();
  const ids = [...new Set([...(entities || [])].map(String).filter((e) => /^acct:./.test(e)).map((e) => e.slice(5)))];
  if (!ids.length) return out;
  const roles = await require("./staffroles").globalRolesOf(ids);
  for (const id of ids) {
    const r = roles.get(id);
    const p = { account: HO.accountOf(id), v1_user: id };
    if (!r) p.gone = true;
    else Object.assign(p, { role: r.role, cls: r.cls, role_at: r.role_at });
    out.set("acct:" + id, p);
  }
  return out;
}

/** The snapshot: accounts that hold a role - a role-giving class (D11-site-roles: no login needed) or a linked login with a
 *  Pepe role (pepe_roles.role not null) on an account whose class isn't Banned / Bot (staffroles.NO_ROLE_CLASSES) - after
 *  `bound` in userId byte order, each once. */
async function snapshotSource(bound, limit) {
  if (bound == null) return [];
  const { ROLES: roles, NO_ROLE_CLASSES } = require("./staffroles");
  const none = [...NO_ROLE_CLASSES];
  const ids = (await getQuery(`SELECT id FROM (
                                 SELECT u.userId AS id FROM users u JOIN pepe_roles r ON r.login = lower(trim(u.camfrogUsername)) AND ${LINKED}
                                  WHERE r.role IN (${roles.map(() => "?").join(",")}) AND u.userId > ?
                                    AND (u."class" IS NULL OR u."class" NOT IN (${none.map(() => "?").join(",")}))
                                 UNION
                                 SELECT u.userId AS id FROM users u WHERE ${CLASS_HAS_ROLE("u")} AND u.userId > ?)
                               ORDER BY id LIMIT ?`,
                              [...roles, bound, ...none, bound, limit])).map((r) => String(r.id));
  const built = await build(ids.map((id) => "acct:" + id));
  return ids.map((id) => ({ entity: "acct:" + id, payload: built.get("acct:" + id) }));
}

module.exports = { TOPIC, SWITCH, init, build, triggerSql, snapshotSource };
