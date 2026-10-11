// requestroles.js — 1.99la: the two 🎬 request roles sold in the store, carried out everywhere they apply.
//
//   🔭 scout    PATV: no daily request limit and no PAT per request (mediarequests.js).
//               Seerr: the linked Seerr user gets REQUEST and an explicit UNLIMITED quota (movie + TV limit 0 - in Seerr
//               null means "the global default", 0 means "no limit"), so any bot / app that requests as that Seerr user
//               is unlimited too.
//   🎟️ curator  Seerr: AUTO_APPROVE (+ movie / TV) and MANAGE_REQUESTS (+ REQUEST, MANAGE_ISSUES) on the linked Seerr
//               user - their own requests go straight through, and they can approve / decline anyone's.
//               PATV: /plex/manage (mediaissues.js) - every request and reported problem, approve / decline / resolve,
//               proxied to Seerr with the role checked server-side.
//   Both: the Discord role of the same name (the Discord bot's bridge, /store/role-grant). Bought before linking
//   Discord = waiting, given automatically once they link it.
//
// WHO HOLDS ONE: a row here with status 'active' - made by a store purchase (shop sale hook) or an admin
// (/admin/media/roles: "Activate" an old holder from user_roles, or "Add holder"). The store's user_roles row stays the
// "you own this" record (a second purchase is refused there). The roles don't expire (they're one-off purchases);
// an admin's Revoke ends one: the Seerr bits WE added are taken back (the user's earlier permissions are stored, never
// anything they had before), the quota goes back to what it was, the Discord role is removed only if we gave it.
//
// LINKING to a Seerr user (first match): an admin's Overseerr link (media_user_links) -> the Seerr user with the Plex id
// of their linked Plex account (plex_members) -> the Seerr user with their VERIFIED email -> if they have a linked Plex
// account but no Seerr user yet, Seerr imports them from Plex (POST /user/import-from-plex). No Plex link = waiting,
// with a 🔔 notice telling them to link Plex; a timer retries.
//
// Seerr is written to only from prod: on staging (STAGING set) every write is a dry run, logged ("would ...").
//
//   request_roles      one row per (account, role): status + the Seerr / Discord side and what to undo
//   request_role_log   every grant / revoke / apply / undo / approve / decline, with who did it
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}
let clock = () => Date.now();
const MIN = 60000, HOUR = 60 * MIN;

// Seerr's permission bits (server/lib/permissions.ts)
const P = {
  ADMIN: 2, MANAGE_USERS: 8, MANAGE_REQUESTS: 16, REQUEST: 32, AUTO_APPROVE: 128, AUTO_APPROVE_MOVIE: 256, AUTO_APPROVE_TV: 512,
  MANAGE_ISSUES: 1048576, VIEW_ISSUES: 2097152, CREATE_ISSUES: 4194304,
};
const ROLES = {
  scout: { bits: P.REQUEST, quota: true },
  curator: { bits: P.REQUEST | P.MANAGE_REQUESTS | P.AUTO_APPROVE | P.AUTO_APPROVE_MOVIE | P.AUTO_APPROVE_TV | P.MANAGE_ISSUES, quota: false },
};
const NAMES = Object.keys(ROLES);
// the store items (shop.js ROLE_PRIZES ids)
const PRIZE_ROLE = { "147ce895-37c2-4c43-98cc-9f7045de0cf3": "scout", "c0e57e08-6696-4c51-94ec-485f13a68cd8": "curator" };

const env = (k) => String(process.env[k] || "").trim();
const writable = () => !process.env.STAGING || env("SEERR_STAGING_WRITES") === "1";

// deps the site passes in (tests swap them)
let D = { discordBridge: null };
let seerr = (...a) => require("./mediarequests").api(...a);

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS request_roles (
        user_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, source TEXT, order_id INTEGER,
        granted_at INTEGER, granted_by TEXT, revoked_at INTEGER, revoked_by TEXT,
        seerr_user INTEGER, seerr_state TEXT, seerr_prev_perms INTEGER, seerr_added INTEGER NOT NULL DEFAULT 0,
        seerr_prev_quota TEXT, seerr_quota_set INTEGER NOT NULL DEFAULT 0, seerr_at INTEGER, seerr_note TEXT, seerr_next INTEGER,
        discord_state TEXT, discord_kept INTEGER NOT NULL DEFAULT 0, discord_at INTEGER, discord_note TEXT, discord_next INTEGER,
        notified_link INTEGER, PRIMARY KEY (user_id, role))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS request_role_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, role TEXT, action TEXT NOT NULL, actor TEXT, detail TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS request_role_log_ts ON request_role_log (ts)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function log(userId, role, action, actor, detail) {
  try {
    await runQuery("INSERT INTO request_role_log (ts, user_id, role, action, actor, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [clock(), userId || null, role || null, action, actor || "system", detail == null ? null : String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)]);
  } catch (e) { /* log only */ }
  console.log(`[request-roles] ${action} ${role || ""} ${userId || ""} by ${actor || "system"}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 200) : ""}`);
}
const rowOf = async (userId, role) => (await getQuery("SELECT * FROM request_roles WHERE user_id = ? AND role = ?", [String(userId), role]))[0] || null;

/** Is this role active for this account? */
async function isActive(userId, role) {
  if (!userId || !ROLES[role]) return false;
  await init();
  return !!(await getQuery("SELECT 1 FROM request_roles WHERE user_id = ? AND role = ? AND status = 'active'", [String(userId), role]))[0];
}
/** {scout, curator} for one account */
async function rolesOf(userId) {
  const out = { scout: false, curator: false };
  if (!userId) return out;
  await init();
  for (const r of await getQuery("SELECT role FROM request_roles WHERE user_id = ? AND status = 'active'", [String(userId)])) out[r.role] = true;
  return out;
}
/** May manage every request / issue: an active curator, or a site admin. */
async function canManage(user) {
  if (!user || !user.userId) return false;
  if (conf.isAdmin(user)) return true;
  return isActive(user.userId, "curator");
}

// ── grant / revoke ──
async function grant(userId, role, { source = "admin", actor = "system", orderId = null } = {}) {
  await init();
  if (!ROLES[role]) throw new Refuse(400, "Not a request role.");
  const u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!u) throw new Refuse(404, "No such PATV account.");
  const had = await rowOf(u.userId, role);
  if (had && had.status === "active") return { already: true, row: had };
  const t = clock();
  // a re-grant after a revoke starts the Seerr / Discord side over (what to undo was already undone)
  await runQuery(`INSERT INTO request_roles (user_id, role, status, source, order_id, granted_at, granted_by, seerr_state, discord_state)
                  VALUES (?, ?, 'active', ?, ?, ?, ?, 'pending', 'pending')
                  ON CONFLICT(user_id, role) DO UPDATE SET status = 'active', source = excluded.source, order_id = excluded.order_id,
                    granted_at = excluded.granted_at, granted_by = excluded.granted_by, revoked_at = NULL, revoked_by = NULL,
                    seerr_state = 'pending', seerr_added = 0, seerr_prev_perms = NULL, seerr_prev_quota = NULL, seerr_quota_set = 0,
                    seerr_note = NULL, seerr_next = NULL, discord_state = 'pending', discord_kept = 0, discord_note = NULL, discord_next = NULL,
                    notified_link = NULL`,
                 [u.userId, role, source, orderId, t, actor]);
  await runQuery("INSERT OR IGNORE INTO user_roles (userId, role, source) VALUES (?, ?, ?)", [u.userId, role, source]).catch(() => {});
  await log(u.userId, role, "grant", actor, { source, order: orderId, username: u.username });
  kick(u.userId);
  return { ok: true, row: await rowOf(u.userId, role) };
}

async function revoke(userId, role, { actor = "system", reason = "" } = {}) {
  await init();
  const row = await rowOf(userId, role);
  if (!row || row.status !== "active") throw new Refuse(404, "They don't hold that role.");
  const t = clock();
  await runQuery(`UPDATE request_roles SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                    seerr_state = CASE WHEN seerr_added > 0 OR seerr_quota_set = 1 THEN 'undo' ELSE 'none' END, seerr_next = NULL,
                    discord_state = CASE WHEN discord_state = 'applied' AND discord_kept = 0 THEN 'undo' ELSE 'none' END, discord_next = NULL
                  WHERE user_id = ? AND role = ? AND status = 'active'`, [t, actor, String(userId), role]);
  // the store's "you own this" goes too, so they could buy it again
  await runQuery("DELETE FROM user_roles WHERE userId = ? AND LOWER(role) = ?", [String(userId), role]).catch(() => {});
  await log(userId, role, "revoke", actor, reason ? { reason: String(reason).slice(0, 200) } : null);
  await undoSeerr(await rowOf(userId, role)).catch((e) => console.error("[request-roles] undo seerr:", conf.errLine(e)));
  await undoDiscord(await rowOf(userId, role)).catch((e) => console.error("[request-roles] undo discord:", conf.errLine(e)));
  return { ok: true, row: await rowOf(userId, role) };
}

// ── Seerr: who is this account there ──
let seerrUsersCache = { at: 0, list: null };
async function seerrUsers({ fresh = false } = {}) {
  if (!fresh && seerrUsersCache.list && clock() - seerrUsersCache.at < 5 * MIN) return seerrUsersCache.list;
  const r = await seerr("GET", "/user?take=1000&skip=0&sort=created");
  if (r.status !== 200 || !r.json) throw new Refuse(502, "Couldn't read the request server's users.");
  seerrUsersCache = { at: clock(), list: (r.json.results || []).map((u) => ({
    id: u.id, plexId: u.plexId == null ? null : String(u.plexId), email: String(u.email || "").toLowerCase(),
    name: u.displayName || u.plexUsername || u.username || ("#" + u.id), permissions: Number(u.permissions) || 0,
    movieQuotaLimit: u.movieQuotaLimit == null ? null : Number(u.movieQuotaLimit), tvQuotaLimit: u.tvQuotaLimit == null ? null : Number(u.tvQuotaLimit) })) };
  return seerrUsersCache.list;
}
const TRUSTED_PLEX = ["self", "admin", "wizarr", "overseerr", "email", "owner"];
/** -> {id, how, name} | {id: null, why: "no_plex" | "not_in_seerr", plexIds} */
async function seerrUserFor(userId, { allowImport = true } = {}) {
  const link = (await getQuery("SELECT overseerr_user FROM media_user_links WHERE user_id = ?", [String(userId)]).catch(() => []))[0];
  const list = await seerrUsers();
  if (link) {
    const m = list.find((x) => x.id === Number(link.overseerr_user));
    return { id: Number(link.overseerr_user), how: "link", name: m ? m.name : null };
  }
  const plexIds = (await getQuery(`SELECT plex_id, link_source, access FROM plex_members WHERE user_id = ?`, [String(userId)]).catch(() => []))
    .filter((r) => TRUSTED_PLEX.includes(r.link_source) || r.access === "owner").map((r) => String(r.plex_id));
  let m = list.find((x) => x.plexId && plexIds.includes(x.plexId));
  if (m) return { id: m.id, how: "plex", name: m.name };
  const u = (await getQuery("SELECT email, isEmailVerified FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0];
  if (u && u.email && Number(u.isEmailVerified) === 1) {
    m = list.find((x) => x.email && x.email === String(u.email).toLowerCase());
    if (m) return { id: m.id, how: "email", name: m.name };
  }
  if (!plexIds.length) return { id: null, why: "no_plex", plexIds };
  if (!allowImport || !writable()) return { id: null, why: "not_in_seerr", plexIds };
  // a linked Plex account Seerr doesn't know yet: Seerr imports it from the Plex server's users
  const r = await seerr("POST", "/user/import-from-plex", { plexIds });
  await log(userId, null, "seerr_import", "system", { plexIds, status: r.status, created: ((r.json && r.json.createdUsers) || []).length });
  m = (await seerrUsers({ fresh: true })).find((x) => x.plexId && plexIds.includes(x.plexId));
  return m ? { id: m.id, how: "imported", name: m.name } : { id: null, why: "not_in_seerr", plexIds };
}

const QUOTA_KEYS = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"];
const bitsOf = (roles) => roles.reduce((b, r) => b | (ROLES[r] ? ROLES[r].bits : 0), 0);

async function setSeerr(userId, role, patch) {
  const keys = Object.keys(patch);
  await runQuery(`UPDATE request_roles SET ${keys.map((k) => k + " = ?").join(", ")} WHERE user_id = ? AND role = ?`, [...keys.map((k) => patch[k]), String(userId), role]);
}

/** Give one active role's Seerr side. Never throws for an upstream problem: the row says what happened + when to retry. */
async function applySeerr(row) {
  if (!row || row.status !== "active") return null;
  const t = clock();
  const later = (state, note, wait) => setSeerr(row.user_id, row.role, { seerr_state: state, seerr_note: note, seerr_at: t, seerr_next: t + wait }).then(() => state);
  if (!conf.keys().overseerr) return later("off", "Seerr isn't configured on this site", HOUR);
  let who;
  try { who = await seerrUserFor(row.user_id); }
  catch (e) { return later("error", conf.errLine(e), 15 * MIN); }
  if (!who.id) {
    const state = await later("no_link", who.why === "no_plex" ? "no linked Plex account" : "their Plex account isn't on the request server yet", who.why === "no_plex" ? 10 * MIN : 6 * HOUR);
    if (!row.notified_link) {
      await runQuery("UPDATE request_roles SET notified_link = ? WHERE user_id = ? AND role = ? AND notified_link IS NULL", [t, row.user_id, row.role]);
      await require("./inbox").addSafe(row.user_id, { kind: "media", title: `🎬 Link your Plex account to finish setting up ${row.role === "scout" ? "🔭 Scout" : "🎟️ Curator"}`,
        body: "Your role works on PATV already. To unlock it on the request server (Seerr) too, link your Plex account on the Plex page — we'll do the rest by ourselves.",
        link: "/plex#access", ref: `rrole-link:${row.role}:${row.user_id}` }).catch(() => {});
    }
    return state;
  }
  if (who.id === 1) return later("owner", "the server owner's Seerr account already has every permission", 365 * 24 * HOUR);
  const need = ROLES[row.role].bits;
  if (!writable()) {
    await log(row.user_id, row.role, "seerr_dry", "system", { seerr_user: who.id, would_add_bits: need, quota_unlimited: !!ROLES[row.role].quota });
    await setSeerr(row.user_id, row.role, { seerr_user: who.id, seerr_state: "dry", seerr_note: "staging: dry run, nothing written", seerr_at: t, seerr_next: null });
    return "dry";
  }
  try {
    const g = await seerr("GET", `/user/${who.id}/settings/permissions`);
    if (g.status !== 200 || !g.json) return later("error", `reading permissions answered ${g.status}`, 15 * MIN);
    const cur = Number(g.json.permissions) || 0;
    const prev = row.seerr_prev_perms == null ? cur : row.seerr_prev_perms;
    const add = cur & P.ADMIN ? 0 : need & ~cur;
    if (add) {
      const w = await seerr("POST", `/user/${who.id}/settings/permissions`, { permissions: cur | add });
      if (w.status !== 200) return later("error", `setting permissions answered ${w.status}`, 15 * MIN);
    }
    const patch = { seerr_user: who.id, seerr_prev_perms: prev, seerr_added: (row.seerr_added || 0) | add };
    await setSeerr(row.user_id, row.role, patch);           // saved at once: what to undo, even if the quota step fails
    let quota = null;
    if (ROLES[row.role].quota && !(cur & (P.ADMIN | P.MANAGE_USERS))) {
      const q = await seerr("GET", `/user/${who.id}/settings/main`);
      if (q.status !== 200 || !q.json) return later("error", `reading the quota answered ${q.status}`, 15 * MIN);
      if (q.json.movieQuotaLimit !== 0 || q.json.tvQuotaLimit !== 0) {
        const before = Object.fromEntries(QUOTA_KEYS.map((k) => [k, q.json[k] == null ? null : Number(q.json[k])]));
        const w = await seerr("POST", `/user/${who.id}/settings/main`, { username: q.json.username, email: q.json.email,
          movieQuotaLimit: 0, movieQuotaDays: before.movieQuotaDays, tvQuotaLimit: 0, tvQuotaDays: before.tvQuotaDays });
        if (w.status !== 200) return later("error", `setting the quota answered ${w.status}`, 15 * MIN);
        if (!row.seerr_quota_set) await setSeerr(row.user_id, row.role, { seerr_prev_quota: JSON.stringify(before), seerr_quota_set: 1 });
        quota = { before, after: "unlimited" };
      }
    }
    await setSeerr(row.user_id, row.role, { seerr_state: "applied", seerr_note: `as Seerr user #${who.id} (${who.how})`, seerr_at: t, seerr_next: null });
    await log(row.user_id, row.role, "seerr_grant", "system", { seerr_user: who.id, how: who.how, before: cur, added: add, after: cur | add, quota });
    return "applied";
  } catch (e) {
    return later("error", conf.errLine(e), 15 * MIN);
  }
}

/** Take back what applySeerr added (a revoked row in state 'undo'). */
async function undoSeerr(row) {
  if (!row || row.status !== "revoked" || row.seerr_state !== "undo") return null;
  const t = clock();
  if (!writable()) { await setSeerr(row.user_id, row.role, { seerr_state: "undone", seerr_note: "staging: dry run", seerr_at: t }); return "undone"; }
  try {
    const id = row.seerr_user;
    const others = (await getQuery("SELECT role FROM request_roles WHERE user_id = ? AND status = 'active' AND role != ?", [row.user_id, row.role])).map((r) => r.role);
    const keep = bitsOf(others);
    const g = await seerr("GET", `/user/${id}/settings/permissions`);
    if (g.status !== 200 || !g.json) throw new Error(`reading permissions answered ${g.status}`);
    const cur = Number(g.json.permissions) || 0;
    const remove = (row.seerr_added || 0) & ~keep;
    if (cur & remove) {
      const w = await seerr("POST", `/user/${id}/settings/permissions`, { permissions: cur & ~remove });
      if (w.status !== 200) throw new Error(`setting permissions answered ${w.status}`);
    }
    let quota = null;
    if (row.seerr_quota_set && row.seerr_prev_quota && !others.some((r) => ROLES[r].quota)) {
      const q = await seerr("GET", `/user/${id}/settings/main`);
      if (q.status !== 200 || !q.json) throw new Error(`reading the quota answered ${q.status}`);
      if (q.json.movieQuotaLimit === 0 && q.json.tvQuotaLimit === 0) {      // still what we set - put theirs back
        const before = JSON.parse(row.seerr_prev_quota);
        const w = await seerr("POST", `/user/${id}/settings/main`, { username: q.json.username, email: q.json.email, ...before });
        if (w.status !== 200) throw new Error(`restoring the quota answered ${w.status}`);
        quota = before;
      }
    }
    await setSeerr(row.user_id, row.role, { seerr_state: "undone", seerr_note: `removed ${cur & remove} from Seerr user #${id}`, seerr_at: t, seerr_next: null });
    await log(row.user_id, row.role, "seerr_revoke", "system", { seerr_user: id, before: cur, removed: cur & remove, after: cur & ~remove, quota_restored: quota });
    return "undone";
  } catch (e) {
    await setSeerr(row.user_id, row.role, { seerr_note: "undo failed: " + conf.errLine(e), seerr_at: t, seerr_next: t + 15 * MIN });
    await log(row.user_id, row.role, "seerr_revoke_failed", "system", conf.errLine(e));
    return "error";
  }
}

// ── Discord ──
async function setDiscord(userId, role, patch) { return setSeerr(userId, role, patch); }
async function applyDiscord(row) {
  if (!row || row.status !== "active") return null;
  const t = clock();
  const u = (await getQuery("SELECT discordId FROM users WHERE userId = ?", [row.user_id]))[0];
  if (!u || !u.discordId) {
    if (row.discord_state !== "no_discord") await log(row.user_id, row.role, "discord_waiting", "system", "no Discord linked - given when they link it");
    await setDiscord(row.user_id, row.role, { discord_state: "no_discord", discord_note: "no Discord account linked yet", discord_at: t, discord_next: t + 2 * MIN });
    return "no_discord";
  }
  if (!D.discordBridge) {
    await setDiscord(row.user_id, row.role, { discord_state: "off", discord_note: "the Discord bot bridge isn't set up here", discord_at: t, discord_next: t + HOUR });
    return "off";
  }
  const r = (await D.discordBridge("/store/role-grant", { discordId: String(u.discordId), role: row.role })) || {};
  if (r.granted) {
    // "already had it" right after a website / Camfrog / Discord purchase = the store's own sale message just gave it
    // (shop.js -> /store/purchase, or the Discord shop) - that's ours too; otherwise it was theirs before: never removed
    const fromSale = /^purchase:/.test(row.source || "") && t - (row.granted_at || 0) < 15 * MIN;
    const kept = r.already && !fromSale ? 1 : 0;
    await setDiscord(row.user_id, row.role, { discord_state: "applied", discord_kept: kept, discord_note: kept ? "they had it already" : "given", discord_at: t, discord_next: null });
    await log(row.user_id, row.role, "discord_grant", "system", kept ? "already had it" : r.already ? "given with the sale" : "given");
    return "applied";
  }
  const reason = r.reason || r.error || "failed";
  const state = ["not_in_server", "no_such_role"].includes(reason) ? reason : "error";
  await setDiscord(row.user_id, row.role, { discord_state: state, discord_note: String(reason).slice(0, 120), discord_at: t, discord_next: t + (state === "error" ? 15 * MIN : 6 * HOUR) });
  if (row.discord_state !== state) await log(row.user_id, row.role, "discord_" + state, "system", reason);
  return state;
}
async function undoDiscord(row) {
  if (!row || row.status !== "revoked" || row.discord_state !== "undo") return null;
  const t = clock();
  const u = (await getQuery("SELECT discordId FROM users WHERE userId = ?", [row.user_id]))[0];
  if (!u || !u.discordId || !D.discordBridge) {
    await setDiscord(row.user_id, row.role, { discord_state: "none", discord_note: "nothing to remove (no Discord / no bridge)", discord_at: t });
    return "none";
  }
  const r = (await D.discordBridge("/store/role-remove", { discordId: String(u.discordId), role: row.role })) || {};
  if (r.ok || r.removed != null) {
    await setDiscord(row.user_id, row.role, { discord_state: "removed", discord_note: r.removed ? "removed" : (r.reason || "they didn't have it"), discord_at: t, discord_next: null });
    await log(row.user_id, row.role, "discord_revoke", "system", r.removed ? "removed" : (r.reason || "not held"));
    return "removed";
  }
  await setDiscord(row.user_id, row.role, { discord_note: "remove failed: " + String(r.error || "failed").slice(0, 100), discord_at: t, discord_next: t + 15 * MIN });
  return "error";
}

// ── the timer: retries waiting sides (Plex / Discord linked later, upstream errors) ──
const SEERR_RETRY = ["pending", "no_link", "error", "off"];
const DISCORD_RETRY = ["pending", "no_discord", "not_in_server", "no_such_role", "error", "off"];
let running = null;
async function reconcile({ userId = null } = {}) {
  await init();
  if (running) return running;
  running = (async () => {
    const t = clock();
    const who = userId ? "AND user_id = ?" : "";
    const args = userId ? [String(userId)] : [];
    let n = 0;
    for (const row of await getQuery(`SELECT * FROM request_roles WHERE status = 'active' AND seerr_state IN (${SEERR_RETRY.map(() => "?").join(",")})
                                      AND (seerr_next IS NULL OR seerr_next <= ? ${userId ? "OR 1" : ""}) ${who} LIMIT 50`, [...SEERR_RETRY, t, ...args])) {
      if ((await applySeerr(row)) === "applied") n++;
    }
    for (const row of await getQuery(`SELECT * FROM request_roles WHERE status = 'active' AND discord_state IN (${DISCORD_RETRY.map(() => "?").join(",")})
                                      AND (discord_next IS NULL OR discord_next <= ? ${userId ? "OR 1" : ""}) ${who} LIMIT 50`, [...DISCORD_RETRY, t, ...args])) {
      if ((await applyDiscord(row)) === "applied") n++;
    }
    for (const row of await getQuery(`SELECT * FROM request_roles WHERE status = 'revoked' AND (seerr_state = 'undo' OR discord_state = 'undo')
                                      AND ((seerr_next IS NULL OR seerr_next <= ?) OR (discord_next IS NULL OR discord_next <= ?)) ${who} LIMIT 20`, [t, t, ...args])) {
      await undoSeerr(row); await undoDiscord(await rowOf(row.user_id, row.role));
    }
    return n;
  })().finally(() => { running = null; });
  return running;
}
/** Something changed for this account (a purchase, Plex / Discord linked): try its waiting sides soon. */
function kick(userId) {
  if (!userId) return;
  setTimeout(() => { reconcile({ userId }).catch((e) => console.error("[request-roles] kick:", conf.errLine(e))); }, 1500).unref();
}

// ── the store hook ──
async function onSale(sale) {
  const role = PRIZE_ROLE[sale.prizeId];
  if (!role) return false;
  await grant(sale.userId, role, { source: `purchase:${sale.source || "?"}`, actor: sale.username || "buyer", orderId: sale.orderId });
  return true;
}

// ── admin ──
async function adminState() {
  await init();
  const rows = await getQuery(`SELECT r.*, u.username, u.discordId IS NOT NULL AS has_discord FROM request_roles r LEFT JOIN users u ON u.userId = r.user_id
                               ORDER BY r.status = 'active' DESC, r.granted_at DESC`);
  // store owners (user_roles) of these roles who aren't active here: old Discord-era holders, to activate by hand
  const legacy = await getQuery(`SELECT ur.userId, ur.role, ur.source, u.username,
        (SELECT COUNT(*) FROM shop_orders o WHERE o.buyer_id = ur.userId AND o.prize_id IN (${Object.keys(PRIZE_ROLE).map(() => "?").join(",")}) AND o.status = 'completed') AS orders
      FROM user_roles ur LEFT JOIN users u ON u.userId = ur.userId
      WHERE LOWER(ur.role) IN ('scout', 'curator')
        AND NOT EXISTS (SELECT 1 FROM request_roles r WHERE r.user_id = ur.userId AND r.role = LOWER(ur.role) AND r.status = 'active')`,
    Object.keys(PRIZE_ROLE)).catch(() => []);
  const logRows = await getQuery(`SELECT l.*, u.username FROM request_role_log l LEFT JOIN users u ON u.userId = l.user_id ORDER BY l.id DESC LIMIT 100`);
  return { rows, legacy, log: logRows, writable: writable() };
}
async function userByName(name) {
  const u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)", [String(name || "").trim()]))[0];
  if (!u) throw new Refuse(404, "No such PATV account.");
  return u;
}
/** Discord holders vs PATV vs Seerr, for the admin view (read-only). */
async function audit() {
  await init();
  const out = {};
  const seerrList = conf.keys().overseerr ? await seerrUsers({ fresh: true }).catch(() => null) : null;
  for (const role of NAMES) {
    let discordIds = null, discordError = null;
    if (D.discordBridge) {
      const r = await D.discordBridge("/store/role-members", { role }, 60000);
      if (r && Array.isArray(r.discordIds)) discordIds = r.discordIds.map(String); else discordError = (r && (r.error || r.reason)) || "no answer";
    } else discordError = "no Discord bridge here";
    const discord = [];
    for (const id of discordIds || []) {
      const u = (await getQuery("SELECT userId, username FROM users WHERE discordId = ?", [id]))[0];
      discord.push(u ? { userId: u.userId, username: u.username } : { userId: null, username: null, discordTail: id.slice(-4) });
    }
    const orders = await getQuery(`SELECT o.buyer_id AS userId, u.username, COUNT(*) AS n FROM shop_orders o LEFT JOIN users u ON u.userId = o.buyer_id
                                   WHERE o.prize_id = ? AND o.status = 'completed' GROUP BY o.buyer_id`,
                                  [Object.keys(PRIZE_ROLE).find((k) => PRIZE_ROLE[k] === role)]);
    const owned = await getQuery("SELECT ur.userId, u.username, ur.source FROM user_roles ur LEFT JOIN users u ON u.userId = ur.userId WHERE LOWER(ur.role) = ?", [role]);
    const active = await getQuery("SELECT r.user_id AS userId, u.username, r.seerr_state, r.seerr_user FROM request_roles r LEFT JOIN users u ON u.userId = r.user_id WHERE r.role = ? AND r.status = 'active'", [role]);
    // who already looks like a holder on Seerr: Scout = an explicit unlimited quota (every user has REQUEST by default);
    // Curator = any of AUTO_APPROVE (+movie/TV) / MANAGE_REQUESTS (listed with what they have). Admins left out.
    const CUR = P.MANAGE_REQUESTS | P.AUTO_APPROVE | P.AUTO_APPROVE_MOVIE | P.AUTO_APPROVE_TV;
    const seerr = seerrList ? seerrList.filter((x) => x.id !== 1 && !(x.permissions & P.ADMIN) &&
        (role === "scout" ? x.movieQuotaLimit === 0 && x.tvQuotaLimit === 0 : (x.permissions & CUR) !== 0))
      .map((x) => ({ id: x.id, name: x.name, has: role === "scout" ? "unlimited quota"
        : [["MANAGE_REQUESTS", P.MANAGE_REQUESTS], ["AUTO_APPROVE", P.AUTO_APPROVE], ["AUTO_APPROVE_MOVIE", P.AUTO_APPROVE_MOVIE], ["AUTO_APPROVE_TV", P.AUTO_APPROVE_TV]]
          .filter(([, b]) => x.permissions & b).map(([k]) => k).join("+") })) : null;
    out[role] = { discord, discordError, orders, owned, active, seerr };
  }
  return out;
}

// ── routes: /admin/media/roles ──
let timer = null;
function register(app, { addUser, discordBridge, noTimers } = {}) {
  if (discordBridge) D.discordBridge = discordBridge;
  const guard = require("./middleware/authGuard");
  require("./shop").onOfficialSale(onSale);
  init().catch((e) => console.error("[request-roles] setup:", conf.errLine(e)));
  if (!noTimers && !timer) {
    timer = setInterval(() => reconcile().catch((e) => console.error("[request-roles] reconcile:", conf.errLine(e))), 2 * MIN);
    timer.unref();
  }
  const admin = (req, res, next) => {
    if (!conf.isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  const J = (fn) => [addUser, admin, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json(await fn(req)); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[request-roles]", conf.errLine(e));
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  }];
  app.get("/admin/media/roles", addUser, async (req, res) => {
    if (!conf.isAdmin(req.user)) return res.redirect("/login");
    try { res.set("Cache-Control", "no-store"); res.render("requestRolesAdmin", { user: req.user.username, ...(await adminState()) }); }
    catch (e) { console.error("[request-roles] admin page:", conf.errLine(e)); res.status(500).send("Couldn't load the request roles."); }
  });
  const roleOf = (v) => { const r = String(v || "").toLowerCase(); if (!ROLES[r]) throw new Refuse(400, "Pick scout or curator."); return r; };
  app.post("/api/media/admin/roles/grant", ...J(async (req) => {
    const b = req.body || {};
    const u = await userByName(b.username);
    return { ok: true, ...(await grant(u.userId, roleOf(b.role), { source: "admin:" + req.user.username, actor: req.user.username })) };
  }));
  app.post("/api/media/admin/roles/revoke", ...J(async (req) => {
    const b = req.body || {};
    const u = await userByName(b.username);
    return { ok: true, ...(await revoke(u.userId, roleOf(b.role), { actor: req.user.username, reason: b.reason })) };
  }));
  app.post("/api/media/admin/roles/retry", ...J(async (req) => {
    const b = req.body || {};
    const u = await userByName(b.username);
    await runQuery("UPDATE request_roles SET seerr_next = NULL, discord_next = NULL WHERE user_id = ?", [u.userId]);
    seerrUsersCache = { at: 0, list: null };
    await reconcile({ userId: u.userId });
    return { ok: true };
  }));
  app.get("/api/media/admin/roles/audit", ...J(async () => ({ ok: true, audit: await audit() })));
}

module.exports = {
  init, register, isActive, rolesOf, canManage, grant, revoke, applySeerr, undoSeerr, applyDiscord, undoDiscord, reconcile, kick, onSale,
  seerrUserFor, seerrUsers, adminState, audit, log, writable, ROLES, P, PRIZE_ROLE, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _set: (o) => { if (o.seerr) seerr = o.seerr; if ("discordBridge" in o) D.discordBridge = o.discordBridge; seerrUsersCache = { at: 0, list: null }; },
};
