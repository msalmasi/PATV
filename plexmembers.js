// plexmembers.js — 1.99jp: which PATV users are on our Plex server, and the access PATV sold them.
//
// SOURCE OF TRUTH: the Plex server's shares (plex.tv shared_servers), read through the homelab media-control service
// (deploy/mediactl 1.2.0 GET /plex/shares - the Plex token never leaves the homelab). One row per Plex account that has
// (or had) a share: plex_members. A sync (hourly + "Sync now" on /admin/media) refreshes it.
//
// LINKING a Plex account to a PATV account (first match wins; an admin's decision is never changed by a sync):
//   self      the PATV user proved it with Plex's own sign-in (PIN flow, /subscriptions + Edit profile → Connections; 1.99jr: Sign in with Plex, plexsso.js) - the strongest
//   admin     an admin linked it (/admin/media → Plex members); an admin UNLINK is sticky too (link_lock)
//   wizarr    a PATV store order's Wizarr invite (media_invites.code) was redeemed by a Wizarr user whose email / username
//             is this Plex account
//   overseerr an admin's Overseerr link (media_user_links) points at the Overseerr user with this Plex id
//   email     a PATV account's VERIFIED email equals this Plex account's email (exactly one such account). Emails are kept
//             only as a keyed hash (HMAC with SECRET_KEY), never shown anywhere
//   (a PATV username / Camfrog name equal to the Plex username is only SUGGESTED to the admin - anyone can pick a name)
//
// ACCESS TYPE (what PATV sold them, from the store orders of mediaconf invite_items + subscriptions.js):
//   lifetime | yearly | monthly | subscription   PATV-sold; `expires` = the end of the paid time (stacked orders add up;
//                                                a subscription in its grace keeps it to the grace's end)
//   pre-existing   on the server before their first PATV purchase, or no PATV purchase at all, or not linked - NEVER revoked
//   manual         re-shared by hand after their PATV time ended, or an admin said "keep" - NEVER revoked
//   An admin can pin manual / pre-existing on any row.
//
// REVOKING (removing the library share when PATV-sold access ended): only rows that are linked, on the server, PATV-sold,
// not pinned, and expired. With plex_auto_revoke OFF (the default) a sync only LISTS them ("would remove") and an admin
// clicks Remove (or Keep); with it on, the sync removes them itself. Every removal is logged (plex_member_log).
//
// "PLEX USER" for 📼 free plays (medialib.js): linked to a row that's on the server (accepted) and still active, or on the
// override list (mediaconf library_users). memberSync(userId) is the cached answer for pages / flair / cosmetics.
//
//   plex_members      plex_id -> share, link, access, revoke state
//   plex_member_log   who did what to which row (links, unlinks, pins, removals, sync summaries)
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");

const DAY = 24 * 3600 * 1000;
const SLACK = 2 * DAY;                  // invite times vs order times: this much either way still counts as "the same"
const PATV_TYPES = ["lifetime", "yearly", "monthly", "subscription"];
const KEEP_TYPES = ["manual", "pre-existing"];
const LINK_SOURCES = ["self", "admin", "wizarr", "overseerr", "email"];
let clock = () => Date.now();

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// ── storage ──
let ready = null;
async function addCol(table, def) {
  try { await runQuery(`ALTER TABLE ${table} ADD COLUMN ${def}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS plex_members (
        plex_id TEXT PRIMARY KEY, share_id TEXT, username TEXT, title TEXT, email_hash TEXT,
        on_server INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, invited_at INTEGER, accepted_at INTEGER,
        user_id TEXT, link_source TEXT, link_lock INTEGER NOT NULL DEFAULT 0, linked_at INTEGER, linked_by TEXT,
        access TEXT, access_pinned INTEGER NOT NULL DEFAULT 0, expires INTEGER,
        first_seen INTEGER, last_seen INTEGER, last_synced INTEGER,
        revoke TEXT, revoke_at INTEGER, revoke_by TEXT, revoke_error TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS plex_members_user ON plex_members (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS plex_member_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, plex_id TEXT, user_id TEXT, what TEXT NOT NULL, actor TEXT, detail TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS plex_member_log_ts ON plex_member_log (ts)");
      await loadCache();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function log(plexId, userId, what, actor, detail) {
  try {
    await runQuery("INSERT INTO plex_member_log (ts, plex_id, user_id, what, actor, detail) VALUES (?, ?, ?, ?, ?, ?)",
                   [clock(), plexId || null, userId || null, what, actor || "system", detail ? String(detail).slice(0, 500) : null]);
  } catch (e) { /* log only */ }
}

// ── emails: only ever a keyed hash ──
function emailHash(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return crypto.createHmac("sha256", String(process.env.SECRET_KEY || "patv-plex")).update("plex-email:" + e).digest("hex").slice(0, 40);
}

// ── what PATV sold a user ──
const typeOfDays = (d) => (d <= 0 ? "lifetime" : d >= 360 ? "yearly" : "monthly");
const RANK = { lifetime: 4, subscription: 3, yearly: 2, monthly: 1 };
async function safeQuery(sql, args) { try { return await getQuery(sql, args); } catch (e) { return []; } }
/**
 * PATV-sold Plex access for one account -> {none, first, active, type, expires (ms | null = never), last_end}
 * Orders of the invite items stack (a second month starts where the first ends); a subscription in its grace keeps
 * the access to the grace's end.
 */
async function patvAccess(userId, t = clock()) {
  const items = conf.get().invite_items || {};
  const ids = Object.keys(items);
  const out = { none: true, first: null, active: false, type: null, expires: null, last_end: null };
  if (!userId || !ids.length) return out;
  const orders = await safeQuery(`SELECT id, prize_id, created FROM shop_orders WHERE buyer_id = ? AND prize_id IN (${ids.map(() => "?").join(",")})
                                  AND status NOT IN ('cancelled','refunded') ORDER BY created, id`, [userId, ...ids]);
  let end = 0, lifetime = false, lastType = null;
  for (const o of orders) {
    const days = Number((items[o.prize_id] || {}).days) || 0;
    const created = Number(o.created) || 0;
    if (out.first == null) out.first = created;
    out.none = false;
    if (days <= 0) { lifetime = true; lastType = "lifetime"; continue; }
    end = Math.max(end, created) + days * DAY;
    if (lastType !== "lifetime") lastType = typeOfDays(days);
  }
  let sub = null;
  try { sub = await require("./subscriptions").plexSub(userId, t); } catch (e) { sub = null; }
  if (sub) {
    out.none = false;
    if (out.first == null || (sub.created && sub.created < out.first)) out.first = sub.created || out.first;
    if (sub.until) end = Math.max(end, sub.until);
  }
  if (lifetime) return { ...out, active: true, type: "lifetime", expires: null, last_end: null };
  out.last_end = end || null;
  out.expires = end || null;
  out.active = end > t;
  out.type = sub && (sub.live || !lastType || sub.until >= end) ? "subscription" : lastType;
  return out;
}

/** The access type + expiry a row should have now (pure: row + patvAccess). */
function classify(row, pa, t = clock()) {
  if (row.access_pinned && KEEP_TYPES.includes(row.access)) return { access: row.access, expires: null };
  if (!row.user_id || !pa || pa.none) return { access: "pre-existing", expires: null };
  if (row.invited_at && pa.first && row.invited_at < pa.first - SLACK) return { access: "pre-existing", expires: null };
  if (pa.active) return { access: pa.type || "monthly", expires: pa.expires };
  // PATV time is over: shared again by hand after that = manual (left alone); else the PATV-sold access ended
  if (row.invited_at && pa.last_end && row.invited_at > pa.last_end + SLACK) return { access: "manual", expires: null };
  return { access: pa.type || "monthly", expires: pa.expires };
}
const isActiveRow = (r, t = clock()) => !!r && !!r.user_id && !!r.on_server && !r.pending &&
  (KEEP_TYPES.includes(r.access) || r.expires == null || Number(r.expires) > t);
const isCandidate = (r, t = clock()) => !!r && !!r.user_id && !!r.on_server && !r.access_pinned && PATV_TYPES.includes(r.access) &&
  r.expires != null && Number(r.expires) <= t && r.revoke !== "revoked";

// ── the cache: who's an active member right now (sync reads for pages, flair, cosmetics) ──
let ACTIVE = new Map();        // userId -> {plex_id, username, access, expires}
let BY_NAME = new Map();       // lowercased PATV username -> same
async function loadCache() {
  const rows = await getQuery(`SELECT m.*, u.username AS patv_name FROM plex_members m LEFT JOIN users u ON u.userId = m.user_id
                               WHERE m.user_id IS NOT NULL AND m.on_server = 1`).catch(() => []);
  const a = new Map(), n = new Map(), t = clock();
  for (const r of rows) {
    if (!isActiveRow(r, t)) continue;
    const v = { plex_id: r.plex_id, username: r.username, access: r.access, expires: r.expires == null ? null : Number(r.expires) };
    const cur = a.get(r.user_id);
    if (!cur || (cur.expires != null && (v.expires == null || v.expires > cur.expires))) a.set(r.user_id, v);
    if (r.patv_name) n.set(String(r.patv_name).toLowerCase(), a.get(r.user_id));
  }
  const before = ACTIVE;
  ACTIVE = a; BY_NAME = n;
  return { before, after: a };
}
/** Is this PATV account an active Plex member? (sync, cached; expiry re-checked) -> {plex_id, username, access, expires} | null */
function memberSync(userId, t = clock()) {
  const v = userId ? ACTIVE.get(String(userId)) : null;
  return v && (v.expires == null || v.expires > t) ? v : null;
}
function memberByName(name, t = clock()) {
  const v = name ? BY_NAME.get(String(name).toLowerCase()) : null;
  return v && (v.expires == null || v.expires > t) ? v : null;
}
/** The async, uncached answer (medialib's free plays): a linked, active row. */
async function memberFor(userId, t = clock()) {
  await init();
  if (!userId) return null;
  const rows = await getQuery("SELECT * FROM plex_members WHERE user_id = ? AND on_server = 1", [String(userId)]);
  let best = null;
  for (const r of rows) {
    if (!isActiveRow(r, t)) continue;
    if (!best || (best.expires != null && (r.expires == null || Number(r.expires) > Number(best.expires)))) best = r;
  }
  return best ? { plex_id: best.plex_id, username: best.username, access: best.access, expires: best.expires == null ? null : Number(best.expires) } : null;
}

// after the active set changed: Plex perk cosmetics for the new members, name styles / flair re-render
async function afterChange(before, after) {
  const fresh = [...after.keys()].filter((u) => !before.has(u));
  if (fresh.length) {
    try {
      const C = require("./cosmetics");
      for (const u of fresh) await C.grantPlexPerks(u).catch(() => 0);
    } catch (e) { /* cosmetics are decoration */ }
  }
  const gone = [...before.keys()].filter((u) => !after.has(u));
  if (fresh.length || gone.length) {
    try { require("./cosmetics").invalidateNames(); } catch (e) { /* decoration */ }
    try { require("./padflair").dropAll(); } catch (e) { /* decoration */ }
  }
  return { joined: fresh.length, left: gone.length };
}
async function reload() {
  const { before, after } = await loadCache();
  return afterChange(before, after);
}

// ── the upstreams (read-only) ──
let fetchShares = async () => {
  const lib = require("./medialib");
  const r = await lib.call("GET", "/plex/shares", null, { timeout: 30000 });
  if (r.status !== 200 || !r.json || !r.json.ok) throw new Refuse(502, (r.json && r.json.error) || `media-control answered ${r.status}`);
  return r.json.shares || [];
};
const env = (k) => String(process.env[k] || "").trim();
async function getJson(base, p, hdr) {
  const r = await fetch(base.replace(/\/+$/, "") + p, { headers: { Accept: "application/json", ...hdr }, signal: AbortSignal.timeout(20000), redirect: "error" });
  if (r.status !== 200) throw new Error(`answered ${r.status}`);
  return r.json();
}
/** Wizarr: PATV-issued invite codes -> the Wizarr user who used them (email hash + username). [] when not configured. */
let wizarrRedemptions = async () => {
  if (!conf.keys().wizarr) return [];
  const base = env("WIZARR_URL"), hdr = { "X-API-Key": env("WIZARR_API_KEY") };
  const [inv, users] = await Promise.all([getJson(base, "/api/invitations", hdr), getJson(base, "/api/users", hdr)]);
  const ul = Array.isArray(users) ? users : (users && users.users) || [];
  const byId = new Map(ul.map((u) => [String(u.id), u]));
  const out = [];
  for (const i of (Array.isArray(inv) ? inv : (inv && inv.invitations) || [])) {
    const m = /(\d+)/.exec(String(i.used_by == null ? "" : typeof i.used_by === "object" ? i.used_by.id : i.used_by));
    const u = m ? byId.get(m[1]) : null;
    if (!u || !i.code) continue;
    out.push({ code: String(i.code), email_hash: emailHash(u.email), username: String(u.username || "") });
  }
  return out;
};
/** Overseerr users: id -> {plex_id, email_hash}. [] when not configured. */
let overseerrUsers = async () => {
  if (!conf.keys().overseerr) return [];
  const j = await getJson(env("OVERSEERR_URL"), "/api/v1/user?take=1000&skip=0", { "X-Api-Key": env("OVERSEERR_API_KEY") });
  return (j.results || []).map((u) => ({ id: Number(u.id), plex_id: u.plexId != null ? String(u.plexId) : null, email_hash: emailHash(u.email) }));
};

// ── the sync ──
let syncing = null;
let lastSync = null;
/**
 * Read the shares, refresh the rows, link what can be linked, re-classify, list (or with plex_auto_revoke, remove) the
 * PATV-sold access that ended. dry = true: compute everything, write nothing (the admin's preview).
 */
function sync({ actor = "system", dry = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    await init();
    const t = clock();
    const shares = await fetchShares();                      // throws when unreachable: nothing changes
    const res = { at: t, dry, plex_users: shares.length, pending: 0, new: 0, gone: 0, linked: 0, auto_linked: 0, unlinked: 0,
                  by_source: {}, by_access: {}, candidates: 0, revoked: 0, errors: [] };
    const rows = new Map((await getQuery("SELECT * FROM plex_members")).map((r) => [r.plex_id, r]));
    const seen = new Set();
    const writes = [];
    for (const s of shares) {
      const pid = String(s.plex_id);
      seen.add(pid);
      if (s.pending) res.pending++;
      const inv = s.invited_at ? Number(s.invited_at) * 1000 : null, acc = s.accepted_at ? Number(s.accepted_at) * 1000 : null;
      const cur = rows.get(pid);
      const next = { ...(cur || { plex_id: pid, first_seen: t, link_lock: 0, access_pinned: 0 }), share_id: String(s.share_id), username: s.username || "",
                     title: s.title || "", email_hash: emailHash(s.email) || (cur && cur.email_hash) || null, on_server: 1, pending: s.pending ? 1 : 0,
                     invited_at: inv, accepted_at: acc, last_seen: t, last_synced: t };
      if (!cur) res.new++;
      rows.set(pid, next);
      writes.push(next);
    }
    for (const [pid, r] of rows) {
      if (seen.has(pid) || !r.on_server) continue;
      const next = { ...r, on_server: 0, last_synced: t };
      if (r.revoke === "candidate") next.revoke = null;
      rows.set(pid, next); writes.push(next); res.gone++;
    }
    // links (only rows nobody decided on: no user, no admin lock)
    const userLinked = new Set([...rows.values()].filter((r) => r.user_id).map((r) => r.user_id));
    const open = () => [...rows.values()].filter((r) => !r.user_id && !r.link_lock && r.on_server);
    const link = (r, userId, source) => {
      if (!userId || userLinked.has(userId)) return false;     // one Plex account per PATV account, automatically
      Object.assign(r, { user_id: userId, link_source: source, linked_at: t, linked_by: "sync" });
      userLinked.add(userId); res.auto_linked++;
      if (!writes.includes(r)) writes.push(r);
      return true;
    };
    // wizarr: the PATV order's invite code was redeemed by this Plex account
    try {
      const red = await wizarrRedemptions();
      if (red.length) {
        const codes = new Map((await safeQuery("SELECT code, user_id FROM media_invites WHERE code IS NOT NULL", [])).map((x) => [String(x.code), x.user_id]));
        for (const w of red) {
          const uid = codes.get(w.code);
          if (!uid) continue;
          const r = open().find((x) => (w.email_hash && x.email_hash === w.email_hash) || (w.username && x.username && x.username.toLowerCase() === w.username.toLowerCase()));
          if (r) link(r, uid, "wizarr");
        }
      }
    } catch (e) { res.errors.push("wizarr: " + conf.errLine(e)); }
    // overseerr: an admin's PATV -> Overseerr link, and that Overseerr user's Plex id
    try {
      const os = await overseerrUsers();
      if (os.length) {
        const byOs = new Map(os.map((u) => [u.id, u]));
        for (const l of await safeQuery("SELECT user_id, overseerr_user FROM media_user_links", [])) {
          const u = byOs.get(Number(l.overseerr_user));
          const r = u && u.plex_id ? open().find((x) => x.plex_id === u.plex_id) : null;
          if (r) link(r, l.user_id, "overseerr");
        }
      }
    } catch (e) { res.errors.push("overseerr: " + conf.errLine(e)); }
    // email: exactly one PATV account with that VERIFIED email
    try {
      const hashes = new Map();
      for (const u of await safeQuery("SELECT userId, email FROM users WHERE email IS NOT NULL AND email != '' AND isEmailVerified = 1", [])) {
        const h = emailHash(u.email);
        if (h) hashes.set(h, hashes.has(h) ? null : u.userId);      // null = ambiguous
      }
      for (const r of open()) { const uid = r.email_hash ? hashes.get(r.email_hash) : null; if (uid) link(r, uid, "email"); }
    } catch (e) { res.errors.push("email: " + conf.errLine(e)); }
    // access types
    const paCache = new Map();
    for (const r of rows.values()) {
      let pa = null;
      if (r.user_id) { if (!paCache.has(r.user_id)) paCache.set(r.user_id, await patvAccess(r.user_id, t)); pa = paCache.get(r.user_id); }
      const c = classify(r, pa, t);
      if (c.access !== r.access || (c.expires || null) !== (r.expires == null ? null : Number(r.expires))) {
        r.access = c.access; r.expires = c.expires == null ? null : c.expires;
        if (!writes.includes(r)) writes.push(r);
      }
      const cand = isCandidate(r, t);
      if (cand && r.revoke !== "candidate" && r.revoke !== "failed") { r.revoke = "candidate"; if (!writes.includes(r)) writes.push(r); }
      if (!cand && r.revoke === "candidate") { r.revoke = null; if (!writes.includes(r)) writes.push(r); }
    }
    if (!dry) {
      for (const r of writes) await save(r);
      const fresh = writes.filter((r) => r.linked_by === "sync" && r.linked_at === t);
      for (const r of fresh) await log(r.plex_id, r.user_id, "link", actor, `auto-linked by ${r.link_source} (${r.username || r.plex_id})`);
    }
    for (const r of rows.values()) {
      if (!r.on_server) continue;
      if (r.user_id) { res.linked++; res.by_source[r.link_source || "?"] = (res.by_source[r.link_source || "?"] || 0) + 1; } else res.unlinked++;
      res.by_access[r.access || "?"] = (res.by_access[r.access || "?"] || 0) + 1;
      if (r.revoke === "candidate") res.candidates++;
    }
    // removals: only with plex_auto_revoke on (else the admin decides on /admin/media)
    if (!dry && conf.get().plex_auto_revoke) {
      for (const r of [...rows.values()].filter((x) => x.revoke === "candidate")) {
        try { await revoke(r.plex_id, "auto", { auto: true }); res.revoked++; } catch (e) { res.errors.push(`remove ${r.username || r.plex_id}: ${conf.errLine(e)}`); }
      }
    }
    if (!dry) {
      const ch = await reload();
      res.members_joined = ch.joined; res.members_left = ch.left;
      await log(null, null, "sync", actor, JSON.stringify({ plex: res.plex_users, linked: res.linked, auto: res.auto_linked, unlinked: res.unlinked, candidates: res.candidates, revoked: res.revoked }));
      lastSync = res;
    }
    return res;
  })().finally(() => { syncing = null; });
  return syncing;
}
const COLS = ["share_id", "username", "title", "email_hash", "on_server", "pending", "invited_at", "accepted_at", "user_id", "link_source", "link_lock",
              "linked_at", "linked_by", "access", "access_pinned", "expires", "first_seen", "last_seen", "last_synced", "revoke", "revoke_at", "revoke_by", "revoke_error"];
async function save(r) {
  const vals = COLS.map((c) => (r[c] === undefined ? null : r[c]));
  await runQuery(`INSERT INTO plex_members (plex_id, ${COLS.join(", ")}) VALUES (?, ${COLS.map(() => "?").join(", ")})
                  ON CONFLICT(plex_id) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(", ")}`, [r.plex_id, ...vals]);
}
async function row(plexId) { return (await getQuery("SELECT * FROM plex_members WHERE plex_id = ?", [String(plexId || "")]))[0] || null; }

/** Re-classify one PATV account's rows now (after a purchase, a renewal, a lapse). */
async function refreshUser(userId) {
  await init();
  if (!userId) return 0;
  const rows = await getQuery("SELECT * FROM plex_members WHERE user_id = ?", [String(userId)]);
  if (!rows.length) return 0;
  const t = clock(), pa = await patvAccess(userId, t);
  let n = 0;
  for (const r of rows) {
    const c = classify(r, pa, t);
    const cand = isCandidate({ ...r, ...c }, t);
    const rv = cand ? (r.revoke === "failed" ? "failed" : "candidate") : r.revoke === "candidate" ? null : r.revoke;
    if (c.access !== r.access || (c.expires == null ? null : c.expires) !== (r.expires == null ? null : Number(r.expires)) || rv !== r.revoke) {
      await runQuery("UPDATE plex_members SET access = ?, expires = ?, revoke = ? WHERE plex_id = ?", [c.access, c.expires == null ? null : c.expires, rv, r.plex_id]);
      n++;
    }
  }
  if (n) await reload();
  return n;
}

// ── removing a share (admin-confirmed, or the auto-revoke) ──
let removeShare = async (r, by) => {
  const lib = require("./medialib");
  const x = await lib.call("POST", `/plex/shares/${encodeURIComponent(r.share_id)}/remove`, { plex_id: r.plex_id, by }, { timeout: 30000 });
  if (x.status !== 200 || !x.json || !x.json.ok) throw new Refuse(x.status >= 400 && x.status < 500 ? x.status : 502, (x.json && x.json.error) || `media-control answered ${x.status}`);
  return x.json;
};
/** Remove one row's library share - ONLY if it's still a revoke candidate (PATV-sold, expired, linked, not pinned). */
async function revoke(plexId, actor, { auto = false } = {}) {
  await init();
  const r = await row(plexId);
  if (!r) throw new Refuse(404, "No such Plex member.");
  // re-check now, with fresh PATV data: never on a guess from an old list
  const pa = r.user_id ? await patvAccess(r.user_id) : null;
  const c = classify(r, pa);
  const fresh = { ...r, ...c };
  if (!isCandidate(fresh)) {
    await runQuery("UPDATE plex_members SET access = ?, expires = ?, revoke = NULL WHERE plex_id = ? AND revoke = 'candidate'", [c.access, c.expires == null ? null : c.expires, r.plex_id]);
    throw new Refuse(409, `${r.username || r.plex_id} isn't due for removal (${c.access}${c.expires ? ", until " + new Date(c.expires).toISOString().slice(0, 10) : ""}).`);
  }
  try {
    await removeShare(r, actor);
  } catch (e) {
    await runQuery("UPDATE plex_members SET revoke = 'failed', revoke_error = ?, revoke_at = ?, revoke_by = ? WHERE plex_id = ?", [conf.errLine(e), clock(), actor, r.plex_id]);
    await log(r.plex_id, r.user_id, "remove-failed", actor, conf.errLine(e));
    throw e;
  }
  await runQuery("UPDATE plex_members SET revoke = 'revoked', revoke_at = ?, revoke_by = ?, revoke_error = NULL, on_server = 0 WHERE plex_id = ?", [clock(), actor, r.plex_id]);
  await log(r.plex_id, r.user_id, "removed", actor, `${auto ? "auto" : "admin"}: ${r.username || r.plex_id} (${c.access}, ended ${c.expires ? new Date(c.expires).toISOString().slice(0, 10) : "?"})`);
  if (r.user_id) {
    require("./inbox").addSafe(r.user_id, { kind: "media", title: "📼 Your Plex access ended",
      body: "The Plex access you bought on PATV ran out, so the library share was removed. Get it again any time in the store.", link: "/subscriptions",
      ref: `plex-removed:${r.plex_id}:${r.expires || 0}` }).catch(() => {});
  }
  await reload();
  return { ok: true, removed: r.username || r.plex_id };
}

// ── admin actions ──
async function userByName(name) {
  const s = String(name || "").trim().replace(/^@/, "");
  if (!s) return null;
  return (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [s]))[0] || null;
}
/** Link (username) or unlink ("" / null) a Plex row; sticky either way (a sync never changes it). */
async function adminLink(plexId, username, actor) {
  await init();
  const r = await row(plexId);
  if (!r) throw new Refuse(404, "No such Plex member.");
  if (!username) {
    await runQuery("UPDATE plex_members SET user_id = NULL, link_source = NULL, link_lock = 1, linked_at = ?, linked_by = ?, revoke = NULL WHERE plex_id = ?", [clock(), actor, r.plex_id]);
    await log(r.plex_id, r.user_id, "unlink", actor, `admin unlinked ${r.username || r.plex_id}`);
  } else {
    const u = await userByName(username);
    if (!u) throw new Refuse(404, "No such PATV account.");
    await runQuery("UPDATE plex_members SET user_id = ?, link_source = 'admin', link_lock = 1, linked_at = ?, linked_by = ? WHERE plex_id = ?", [u.userId, clock(), actor, r.plex_id]);
    await log(r.plex_id, u.userId, "link", actor, `admin linked ${r.username || r.plex_id} -> ${u.username}`);
  }
  const uid = username ? (await userByName(username)).userId : r.user_id;
  await refreshUser(uid).catch(() => 0);
  await reload();
  return { ok: true };
}
/** Pin the access type (manual | pre-existing: never removed) or unpin ("auto"). "keep" = manual. */
async function adminPin(plexId, access, actor) {
  await init();
  const r = await row(plexId);
  if (!r) throw new Refuse(404, "No such Plex member.");
  const a = access === "keep" ? "manual" : access;
  if (a === "auto") {
    await runQuery("UPDATE plex_members SET access_pinned = 0 WHERE plex_id = ?", [r.plex_id]);
    await log(r.plex_id, r.user_id, "unpin", actor, "access type back to automatic");
    if (r.user_id) await refreshUser(r.user_id); else await reload();
  } else {
    if (!KEEP_TYPES.includes(a)) throw new Refuse(400, "Pin it as manual or pre-existing.");
    await runQuery("UPDATE plex_members SET access = ?, expires = NULL, access_pinned = 1, revoke = NULL WHERE plex_id = ?", [a, r.plex_id]);
    await log(r.plex_id, r.user_id, "pin", actor, a);
    await reload();
  }
  return { ok: true };
}

/** The admin list: on-server rows (linked / unlinked, suggestions), would-remove, PATV buyers without Plex, the log. */
async function adminState() {
  await init();
  const t = clock();
  const rows = await getQuery(`SELECT m.plex_id, m.share_id, m.username, m.title, m.on_server, m.pending, m.invited_at, m.accepted_at, m.user_id, m.link_source,
                                      m.link_lock, m.linked_by, m.access, m.access_pinned, m.expires, m.last_synced, m.revoke, m.revoke_at, m.revoke_by, m.revoke_error,
                                      u.username AS patv FROM plex_members m LEFT JOIN users u ON u.userId = m.user_id ORDER BY LOWER(m.username)`);
  // suggestions for unlinked rows: a PATV username / Camfrog login equal to the Plex username (never automatic)
  const names = new Map();
  for (const u of await safeQuery("SELECT userId, username, camfrogUsername FROM users", [])) {
    for (const n of [u.username, u.camfrogUsername]) if (n) { const k = String(n).toLowerCase(); if (!names.has(k)) names.set(k, u.username); }
  }
  const linkedUsers = new Set(rows.filter((r) => r.user_id).map((r) => r.user_id));
  const view = rows.map((r) => ({ ...r, active: isActiveRow(r, t), suggest: !r.user_id && r.username ? names.get(String(r.username).toLowerCase()) || null : null }));
  // PATV buyers (store invite items / Plex subscriptions) who aren't linked to any Plex account
  const items = Object.keys(conf.get().invite_items || {});
  let buyers = [];
  if (items.length) {
    buyers = await safeQuery(`SELECT o.buyer_id AS user_id, u.username, COUNT(*) AS orders, MAX(o.created) AS last FROM shop_orders o LEFT JOIN users u ON u.userId = o.buyer_id
                              WHERE o.prize_id IN (${items.map(() => "?").join(",")}) AND o.status NOT IN ('cancelled','refunded') GROUP BY o.buyer_id ORDER BY last DESC`, items);
    buyers = buyers.filter((b) => !linkedUsers.has(b.user_id));
    for (const b of buyers) { const pa = await patvAccess(b.user_id, t); b.access = pa.type; b.expires = pa.expires; b.active = pa.active; }
  }
  return {
    on: { sync: conf.keys().mediactl, auto_revoke: !!conf.get().plex_auto_revoke },
    last: lastSync,
    linked: view.filter((r) => r.on_server && r.user_id),
    unlinked: view.filter((r) => r.on_server && !r.user_id),
    off_server: view.filter((r) => !r.on_server).slice(0, 100),
    candidates: view.filter((r) => r.revoke === "candidate" || r.revoke === "failed"),
    buyers,
    log: await getQuery("SELECT ts, plex_id, user_id, what, actor, detail FROM plex_member_log ORDER BY id DESC LIMIT 40"),
  };
}

/** The member's own view (/subscriptions, Edit profile → Connections). */
async function mine(userId) {
  await init();
  const rows = await getQuery("SELECT plex_id, username, on_server, pending, access, expires, link_source, link_lock FROM plex_members WHERE user_id = ?", [String(userId || "")]);
  const t = clock();
  return { rows: rows.map((r) => ({ ...r, active: isActiveRow({ ...r, user_id: userId }, t) })), member: await memberFor(userId, t), patv: await patvAccess(userId, t) };
}

// ── self-link: Plex's own sign-in (PIN flow) proves which Plex account is yours ──
const PIN_TTL = 15 * 60 * 1000;
const pins = new Map();          // pin id -> {userId, at}
const SITE = () => String(process.env.PUBLIC_BASE_URL || "https://publicaccess.tv").replace(/\/+$/, "");
const CLIENT_ID = () => "patv-" + crypto.createHash("sha256").update(SITE()).digest("hex").slice(0, 16);
const plexHdr = (extra) => ({ Accept: "application/json", "X-Plex-Product": "PATV", "X-Plex-Client-Identifier": CLIENT_ID(), ...(extra || {}) });
let plexTv = async (method, p, hdr) => {
  const r = await fetch("https://plex.tv" + p, { method, headers: plexHdr(hdr), signal: AbortSignal.timeout(15000), redirect: "error" });
  let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: j };
};
async function linkStart(user, { back } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!conf.get().plex_selflink) throw new Refuse(403, "Linking a Plex account isn't open right now.");
  for (const [k, v] of pins) if (clock() - v.at > PIN_TTL) pins.delete(k);
  if ([...pins.values()].filter((v) => v.userId === user.userId).length >= 3) throw new Refuse(429, "Finish the Plex sign-in you already started (or wait 15 minutes).");
  const r = await plexTv("POST", "/api/v2/pins?strong=true");
  if (r.status !== 201 && r.status !== 200) throw new Refuse(502, "Plex's sign-in can't be reached right now.");
  const id = String(r.json && r.json.id || ""), code = String(r.json && r.json.code || "");
  if (!/^\d{1,15}$/.test(id) || !/^[A-Za-z0-9]{4,64}$/.test(code)) throw new Refuse(502, "Plex's sign-in answered oddly - try again.");
  pins.set(id, { userId: user.userId, at: clock() });
  const url = "https://app.plex.tv/auth#?" + new URLSearchParams({ clientID: CLIENT_ID(), code, "context[device][product]": "PATV",
    // 1.99jr: back to where they started - Edit profile → Connections, or /subscriptions
    forwardUrl: SITE() + (back === "profile" && user.username ? "/u/" + encodeURIComponent(user.username) + "/edit?plex=" + id : "/subscriptions?plex=" + id) }).toString();
  return { ok: true, pin: id, url };
}
/** Poll a PIN: once the user signed in to Plex, read WHO (id, username, email) with that one-time token, then drop it. */
async function linkCheck(user, pinId) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const p = pins.get(String(pinId || ""));
  if (!p || p.userId !== user.userId || clock() - p.at > PIN_TTL) throw new Refuse(404, "That Plex sign-in expired - start again.");
  const r = await plexTv("GET", `/api/v2/pins/${encodeURIComponent(pinId)}`);
  const token = r.json && r.json.authToken;
  if (!token) return { ok: true, done: false };
  pins.delete(String(pinId));
  const who = await plexTv("GET", "/api/v2/user", { "X-Plex-Token": String(token) });
  const pu = who.json || {};
  if (who.status !== 200 || !/^\d{1,15}$/.test(String(pu.id || ""))) throw new Refuse(502, "Couldn't read your Plex account - try again.");
  // the token is not kept anywhere
  return linkSelf(user, { plex_id: String(pu.id), username: String(pu.username || pu.title || ""), email: pu.email });
}
async function linkSelf(user, pu) {
  await init();
  const t = clock();
  const cur = await row(pu.plex_id);
  if (cur && cur.user_id && cur.user_id !== user.userId && cur.link_source === "admin") throw new Refuse(409, "That Plex account is linked to another PATV account - ask an admin.");
  if (cur) {
    await runQuery("UPDATE plex_members SET user_id = ?, link_source = 'self', link_lock = 1, linked_at = ?, linked_by = ?, username = COALESCE(NULLIF(?, ''), username), email_hash = COALESCE(?, email_hash) WHERE plex_id = ?",
                   [user.userId, t, user.username, pu.username, emailHash(pu.email), pu.plex_id]);
  } else {
    await save({ plex_id: pu.plex_id, username: pu.username, title: "", email_hash: emailHash(pu.email), on_server: 0, pending: 0, user_id: user.userId,
                 link_source: "self", link_lock: 1, linked_at: t, linked_by: user.username, access: "pre-existing", access_pinned: 0, first_seen: t });
  }
  await log(pu.plex_id, user.userId, "link", user.username, `self-linked with Plex sign-in (${pu.username || pu.plex_id})`);
  await refreshUser(user.userId);
  await reload();
  const r = await row(pu.plex_id);
  return { ok: true, done: true, plex: { username: r.username, on_server: !!r.on_server, active: isActiveRow(r) } };
}
async function unlinkSelf(user, plexId) {
  await init();
  const r = await row(plexId);
  if (!r || r.user_id !== user.userId) throw new Refuse(404, "Not linked to you.");
  if (r.link_source === "admin") throw new Refuse(403, "An admin linked this one - ask them to change it.");
  await runQuery("UPDATE plex_members SET user_id = NULL, link_source = NULL, link_lock = 1, linked_at = ?, linked_by = ?, revoke = NULL WHERE plex_id = ?", [clock(), user.username, r.plex_id]);
  await log(r.plex_id, user.userId, "unlink", user.username, "unlinked by the member");
  await reload();
  return { ok: true };
}

// ── timers + routes ──
let timer = null;
function startJob() {
  if (timer) return;
  const run = () => {
    if (!conf.keys().mediactl) return;
    const S = conf.get();
    const every = Math.max(10, Number(S.plex_sync_min) || 60) * 60000;
    if (lastSync && clock() - lastSync.at < every - 30000) return;
    sync().catch((e) => { lastSync = { at: clock(), error: conf.errLine(e) }; console.error("[plex] sync:", conf.errLine(e)); });
  };
  setTimeout(run, 2 * 60 * 1000).unref();
  timer = setInterval(run, 5 * 60 * 1000);
  timer.unref();
}
function register(app, { addUser, noTimers } = {}) {
  init().then(() => { if (!noTimers) startJob(); }).catch((e) => console.error("[plex] init:", conf.errLine(e)));
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[plex]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const me = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    res.set("Cache-Control", "no-store");
    next();
  };
  const admin = (req, res, next) => {
    if (!conf.isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    res.set("Cache-Control", "no-store");
    next();
  };
  const J = (gate, fn) => [addUser, gate, async (req, res) => { try { res.json(await fn(req)); } catch (e) { fail(res, e); } }];
  // the member
  app.get("/api/plex/me", ...J(me, async (req) => ({ ok: true, ...(await mine(req.user.userId)) })));
  app.post("/api/plex/link/start", ...J(me, async (req) => linkStart(req.user, { back: String((req.body || {}).back || "") })));
  app.post("/api/plex/link/check", ...J(me, async (req) => linkCheck(req.user, (req.body || {}).pin)));
  app.post("/api/plex/link/unlink", ...J(me, async (req) => unlinkSelf(req.user, (req.body || {}).plex_id)));
  // the admins (/admin/media → Plex members)
  app.get("/api/media/admin/plex", ...J(admin, async () => ({ ok: true, ...(await adminState()) })));
  app.post("/api/media/admin/plex/sync", ...J(admin, async (req) => ({ ok: true, result: await sync({ actor: req.user.username, dry: !!(req.body || {}).dry }) })));
  app.post("/api/media/admin/plex/link", ...J(admin, async (req) => adminLink((req.body || {}).plex_id, String((req.body || {}).username || "").trim(), req.user.username)));
  app.post("/api/media/admin/plex/pin", ...J(admin, async (req) => adminPin((req.body || {}).plex_id, String((req.body || {}).access || ""), req.user.username)));
  app.post("/api/media/admin/plex/revoke", ...J(admin, async (req) => revoke((req.body || {}).plex_id, req.user.username)));
}

module.exports = {
  init, register, sync, refreshUser, revoke, adminLink, adminPin, adminState, mine, memberFor, memberSync, memberByName, patvAccess, classify,
  isActiveRow, isCandidate, emailHash, linkStart, linkCheck, linkSelf, unlinkSelf, reload, row, Refuse, PATV_TYPES, KEEP_TYPES, LINK_SOURCES,
  // 1.99jr: Sign in with Plex (plexsso.js) shares the PATV client id + the plex.tv caller (tests swap it with _set)
  plexApi: (...a) => plexTv(...a), clientId: () => CLIENT_ID(), site: () => SITE(),
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _set: (o) => {
    if (o.fetchShares) fetchShares = o.fetchShares;
    if (o.wizarrRedemptions) wizarrRedemptions = o.wizarrRedemptions;
    if (o.overseerrUsers) overseerrUsers = o.overseerrUsers;
    if (o.removeShare) removeShare = o.removeShare;
    if (o.plexTv) plexTv = o.plexTv;
  },
  _lastSync: () => lastSync,
};
