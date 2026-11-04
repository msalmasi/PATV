// netban.js - 1.99ajn padppl (owner: "We also need IP based types of bans for this type of thing" - the harasser's NEXT account): network
// bans, site-side. DARK until an admin turns the switch on (/admin/users#netbans, SP safety.net_bans): nothing is recorded before then, so
// nothing is stored before the privacy page says so (its "net-bans" text is switched on the same flag - terms.js).
//
// WHAT IS STORED (never a raw address):
//   net_seen   (user_id, net_hash, first_at, last_at, n, kinds)  - which networks an account used: at sign-up, sign-in, every 5-minute
//              session touch, a pad chat line / command / clip from the website, a post / comment / story / DM. net_hash = HMAC-SHA256
//              keyed with HKDF(SECRET_KEY, "patv-net-v1", "net-hash") over contentaudit.netOf(ip) (IPv4 as is, IPv6 by its /64), cut to 32
//              hex - keyed with the site secret, not a per-database salt, so a database-only leak can't brute-force IPv4 codes. Only the
//              trusted proxy's CF-Connecting-IP / X-Forwarded-For counts (the origin only accepts Cloudflare); a direct socket is never
//              recorded. Rows go 90 days after their last use (sweep). If SECRET_KEY rotates, old codes stop matching - old network bans
//              lapse, which is acceptable: they are short.
//   net_bans   (id, net_hash | cidr, scope site | pad, room_id, from_user, until, reason, by...) - "this account's recent networks"
//              (every net_hash of the account used in the last 30 days, default 7 days) or an admin-typed IP (hashed on entry, never
//              stored) / range (an admin-typed RULE, stored as text: IPv4 /8-/31, IPv6 /32-/63, matched in memory against the request).
//              Kept 365 days after they end.
//   net_ban_exempt (ban_id, user_id) - accounts an admin let through (a shared household / campus).
//   net_views  (id, at, admin_id, subject_id, reason) - EVERY admin look at network data, kept 2 years.
//
// ENFORCED (refusal(req, {scope, roomId, user})): sign-up (every web creator), sign-in (sessions.signIn), pad chat / commands / clips /
// snapshots from the website, feed posts / comments / stories, DMs; pad-scope bans in that pad only (its chat, posts, stage booking).
// Exempt: Staff and above (SP feed.moderate), a ban's exempt list, bot-token routes (never asked), a direct socket. The refusal never
// mentions an address: "That isn't available from your network right now. If you think this is a mistake, write to support."
// Sign-in is checked inside sessions.signIn only (review fix: it knows the account, so staff and exempt accounts pass a password form
// too); sign-up inside each account creator, before the account exists.
// Admin routes: POST /api/admin/nets {who, reason, op?: "hitting"} (other accounts sharing its networks - names, never codes; or the bans
// hitting that account), GET/POST /api/admin/netbans (switch, lift {ids}, account, exempt {target, ids?}, ip, range).
// Review fixes: a false positive on a shared network is fixed by letting that account through (exempt), never only by lifting the ban;
// the privacy page's paragraph shows while ANY code is stored (hasData), not only while the switch is on; sweeps also run soon after a
// start; account deletion deletes the account's net_seen rows (accountdelete.js DELETE_ROWS).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const SEEN_DAYS = 90, RECENT_DAYS = 30, BAN_KEEP_DAYS = 365, VIEW_KEEP_DAYS = 730, REFRESH_MS = 60 * 1000;
const KIND = { signup: 1, signin: 2, session: 4, say: 8, post: 16 };
const REFUSAL = "That isn't available from your network right now. If you think this is a mistake, write to support.";
let clock = () => Date.now();
const now = () => clock();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS net_seen (user_id TEXT NOT NULL, net_hash TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        n INTEGER NOT NULL DEFAULT 1, kinds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, net_hash))`);
      await runQuery("CREATE INDEX IF NOT EXISTS net_seen_hash ON net_seen (net_hash, last_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS net_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, net_hash TEXT, cidr TEXT, scope TEXT NOT NULL DEFAULT 'site',
        room_id TEXT, from_user TEXT, until INTEGER, reason TEXT, by_id TEXT, by_name TEXT, created INTEGER NOT NULL, lifted_at INTEGER, lifted_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS net_bans_hash ON net_bans (net_hash)");
      await runQuery("CREATE TABLE IF NOT EXISTS net_ban_exempt (ban_id INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (ban_id, user_id))");
      await runQuery("CREATE TABLE IF NOT EXISTS net_views (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT NOT NULL, subject_id TEXT, reason TEXT)");
      await runQuery("CREATE TABLE IF NOT EXISTS netban_config (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      const r = (await getQuery("SELECT value FROM netban_config WHERE key = 'on'"))[0];
      ON = !!(r && r.value === "1");
      await reload();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
let ON = false;
const isOn = () => ON;

// ── the code ──
let KEY = null;
function key() {
  if (KEY) return KEY;
  const secret = process.env.SECRET_KEY || "";
  if (!secret) { KEY = crypto.randomBytes(32); console.error("[netban] SECRET_KEY missing - network codes are per process"); return KEY; }
  KEY = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("patv-net-v1"), Buffer.from("net-hash"), 32));
  return KEY;
}
/** The network an address belongs to: IPv4 as is, IPv6 by its /64 - review fix: parsed (ip6 below), so every spelling of one /64
 *  ("2001:db8:1::5", "2001:db8:1:0:abcd::5") is ONE network and a compressed zero run never leaks interface bits into it. */
function netOf(ip) {
  let s = String(ip == null ? "" : ip).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (s.startsWith("::ffff:") && ip4(s.slice(7)) != null) s = s.slice(7);
  const v4 = ip4(s);
  if (v4 != null) return s.split(".").map(Number).join(".");
  const v6 = ip6(s);
  if (v6 == null) return null;
  const top = (v6 >> 64n).toString(16).padStart(16, "0");
  return top.match(/.{4}/g).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
function netHash(ip) {
  const n = netOf(ip);
  if (!n) return null;
  return crypto.createHmac("sha256", key()).update(n, "utf8").digest("hex").slice(0, 32);
}
/** The request's network: {ip, hash} from the trusted proxy's headers only (never a direct socket), or null. */
function reqNet(req) {
  let a = null;
  try { a = require("./middleware/authGuard").clientAddr(req); } catch (e) { return null; }
  if (!a || a.via === "direct" || !a.ip || a.ip === "?") return null;
  const h = netHash(a.ip);
  return h ? { ip: a.ip, hash: h } : null;
}

/** Remember that `userId` used this request's network (only while the switch is on). Never throws, never blocks. */
async function note(userId, req, kind = "session") {
  if (!ON || !userId) return;
  try {
    await init();
    const n = reqNet(req);
    if (!n) return;
    const t = now(), bit = KIND[kind] || 0;
    await runQuery(`INSERT INTO net_seen (user_id, net_hash, first_at, last_at, n, kinds) VALUES (?, ?, ?, ?, 1, ?)
                    ON CONFLICT(user_id, net_hash) DO UPDATE SET last_at = excluded.last_at, n = net_seen.n + 1, kinds = (net_seen.kinds | excluded.kinds)`,
      [String(userId), n.hash, t, t, bit]);
  } catch (e) { console.error("[netban] note:", e.message); }
}

// ── the active bans, in memory ──
let BANS = { hashes: new Map(), cidrs: [], exempt: new Map(), at: 0 };
async function reload() {
  const t = now();
  const rows = await getQuery("SELECT * FROM net_bans WHERE lifted_at IS NULL AND (until IS NULL OR until > ?) LIMIT 20000", [t]);
  const hashes = new Map(), cidrs = [], exempt = new Map();
  for (const r of rows) {
    const b = { id: Number(r.id), scope: r.scope === "pad" ? "pad" : "site", room: r.room_id || null, until: r.until == null ? null : Number(r.until) };
    if (r.net_hash) { const a = hashes.get(r.net_hash) || []; a.push(b); hashes.set(r.net_hash, a); }
    else if (r.cidr) { const c = parseCidr(r.cidr); if (c) cidrs.push(Object.assign(b, { cidr: c })); }
  }
  if (rows.length) {
    for (const e of await getQuery(`SELECT ban_id, user_id FROM net_ban_exempt WHERE ban_id IN (${rows.map(() => "?").join(",")})`, rows.map((r) => r.id))) {
      const s = exempt.get(Number(e.ban_id)) || new Set(); s.add(String(e.user_id)); exempt.set(Number(e.ban_id), s);
    }
  }
  BANS = { hashes, cidrs, exempt, at: t, pad: rows.some((r) => r.scope === "pad") };
}
/** Is any active ban pad-scope (then the gate looks up which pads a request is for)? From memory. */
const hasPadBans = () => !!BANS.pad;
async function fresh() { await init(); if (now() - BANS.at > REFRESH_MS) await reload(); }

// ── ranges ──
function ip4(s) { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s)); if (!m) return null; const p = m.slice(1).map(Number); if (p.some((x) => x > 255)) return null; return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }
function ip6(s) {
  let t = String(s).toLowerCase().replace(/^\[|\]$/g, "");
  if (t.startsWith("::ffff:") && ip4(t.slice(7)) != null) return null;
  if (!/^[0-9a-f:]+$/.test(t) || t.split("::").length > 2) return null;
  let [a, b] = t.split("::");
  const A = a ? a.split(":") : [], B = b != null ? (b ? b.split(":") : []) : [];
  if (b == null && A.length !== 8) return null;
  const parts = b == null ? A : [...A, ...Array(8 - A.length - B.length).fill("0"), ...B];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.reduce((acc, x) => (acc << 16n) + BigInt(parseInt(x, 16)), 0n);
}
function parseCidr(raw) {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const bits = Number(m[2]);
  const v4 = ip4(m[1]);
  if (v4 != null) { if (bits < 8 || bits > 31) return null; const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return { v: 4, net: (v4 & mask) >>> 0, mask, bits }; }
  const v6 = ip6(m[1]);
  if (v6 != null) { if (bits < 32 || bits > 63) return null; const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits); return { v: 6, net: v6 & mask, mask, bits }; }
  return null;
}
function inCidr(ip, c) {
  let s = String(ip || "").trim().toLowerCase(); if (s.startsWith("::ffff:")) s = s.slice(7);
  if (c.v === 4) { const v = ip4(s); return v != null && ((v & c.mask) >>> 0) === c.net; }
  const v = ip6(s); return v != null && (v & c.mask) === c.net;
}

/** Is `user` exempt from network bans (Staff and above)? */
const staffExempt = (u) => { try { return !!(u && SP.can(u, "feed.moderate")); } catch (e) { return false; } };

/**
 * Why this request is refused by a network ban (null = it isn't). scope "site" (sign-up / sign-in / anything) or "pad" (roomId: that
 * pad's bans AND the site's). user = the account acting (null at sign-up) - Staff and a ban's exempt accounts pass.
 */
async function refusal(req, { roomId = null, roomIds = null, user = null } = {}) {
  try {
    await fresh();
    if (!BANS.hashes.size && !BANS.cidrs.length) return null;
    if (user && staffExempt(user)) return null;
    const n = reqNet(req);
    if (!n) return null;
    const t = now(), uid = user && user.userId ? String(user.userId) : null;
    const pads = new Set([...(roomId ? [String(roomId)] : []), ...(Array.isArray(roomIds) ? roomIds.map(String) : [])]);
    const hit = (b) => (b.until == null || b.until > t) && (b.scope === "site" || (b.room && pads.has(b.room)))
      && !(uid && BANS.exempt.has(b.id) && BANS.exempt.get(b.id).has(uid));
    if ((BANS.hashes.get(n.hash) || []).some(hit)) return REFUSAL;
    if (BANS.cidrs.some((b) => hit(b) && inCidr(n.ip, b.cidr))) return REFUSAL;
    return null;
  } catch (e) { console.error("[netban] refusal:", e.message); return null; }
}

/** A NEW account from this request's network (every web account creator asks before it inserts the row): the refusal | null. */
async function newAccountRefusal(req) {
  if (!ON) return null;
  try { return await refusal(req, {}); } catch (e) { return null; }
}

// ── admin side ──
async function logView(me, subjectId, reason) {
  await runQuery("INSERT INTO net_views (at, admin_id, subject_id, reason) VALUES (?, ?, ?, ?)", [now(), String(me.userId), subjectId ? String(subjectId) : null, String(reason || "").slice(0, 200) || null]);
}
const needAdmin = (me) => { if (!SP.can(me, "safety.net_bans")) { const e = new Error("Admins only."); e.status = 403; throw e; } };

/** How many networks this account used lately and how many OTHER accounts share them (a count only; logged). */
async function shared(me, userId, { reason = "", accounts = false } = {}) {
  needAdmin(me);
  await init();
  if (!ON) return { on: false, networks: 0, shared: 0 };
  const since = now() - SEEN_DAYS * 86400e3;
  const nets = await getQuery("SELECT net_hash FROM net_seen WHERE user_id = ? AND last_at > ?", [String(userId), now() - RECENT_DAYS * 86400e3]);
  let others = 0, list = [];
  if (nets.length) {
    const ph = nets.map(() => "?").join(",");
    const r = (await getQuery(`SELECT COUNT(DISTINCT user_id) AS n FROM net_seen WHERE net_hash IN (${ph}) AND user_id != ? AND last_at > ?`,
      [...nets.map((x) => x.net_hash), String(userId), since]))[0];
    others = Number(r && r.n) || 0;
    // (review fix: the ban sheet's "let them through" boxes - the other accounts by NAME, at most 10, never a code or an address)
    if (accounts && others) {
      list = (await getQuery(`SELECT s.user_id, MAX(s.last_at) AS last, u.username FROM net_seen s LEFT JOIN users u ON u.userId = s.user_id
                              WHERE s.net_hash IN (${ph}) AND s.user_id != ? AND s.last_at > ? GROUP BY s.user_id ORDER BY last DESC LIMIT 10`,
        [...nets.map((x) => x.net_hash), String(userId), since])).filter((x) => x.username).map((x) => ({ userId: String(x.user_id), username: x.username }));
    }
  }
  await logView(me, userId, reason || "ban sheet");
  return { on: true, networks: nets.length, shared: others, ...(accounts ? { accounts: list } : {}) };
}
/** Review fix (a false positive on a shared network): the active bans that would refuse account `userId` from the networks it used
 *  lately - [{id, scope, room, until, from}] (never a code), logged as a view. */
async function hitting(me, userId, reason) {
  needAdmin(me);
  await init();
  if (!String(reason || "").trim()) { const e = new Error("Say why you're looking."); e.status = 400; throw e; }
  const nets = await getQuery("SELECT net_hash FROM net_seen WHERE user_id = ? AND last_at > ?", [String(userId), now() - SEEN_DAYS * 86400e3]);
  let rows = [];
  if (nets.length) {
    rows = await getQuery(`SELECT b.id, b.scope, b.room_id, b.until, b.from_user, u.username AS from_name, b.created FROM net_bans b LEFT JOIN users u ON u.userId = b.from_user
                           WHERE b.net_hash IN (${nets.map(() => "?").join(",")}) AND b.lifted_at IS NULL AND (b.until IS NULL OR b.until > ?)
                           AND b.id NOT IN (SELECT ban_id FROM net_ban_exempt WHERE user_id = ?) LIMIT 200`, [...nets.map((x) => x.net_hash), now(), String(userId)]);
  }
  await logView(me, userId, reason);
  return rows.map((r) => ({ id: Number(r.id), scope: r.scope, room: r.room_id || null, until: r.until == null ? null : Number(r.until), from: r.from_name || null }));
}
/** Let account `userId` through ban(s) `ids` (or every ban hitting it now, when ids is empty) - the remedy short of lifting the ban. */
async function exempt(me, userId, ids = [], reason = "") {
  needAdmin(me);
  await init();
  let list = (Array.isArray(ids) ? ids : []).map((x) => Math.floor(Number(x))).filter((x) => x > 0).slice(0, 200);
  if (!list.length) list = (await hitting(me, userId, reason || "exempt")).map((b) => b.id);
  await tx(async () => { for (const id of list) await runQuery("INSERT OR IGNORE INTO net_ban_exempt (ban_id, user_id) VALUES (?, ?)", [id, String(userId)]); });
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "net_ban", { userId: String(userId), username: null }, { op: "exempt", ids: list }, String(reason || "").slice(0, 200) || null);
  await reload();
  return { ok: true, n: list.length };
}
/** The other accounts sharing this account's networks in the last 90 days - names only, never codes or addresses (logged). */
async function sharedDetail(me, userId, reason) {
  needAdmin(me);
  await init();
  if (!String(reason || "").trim()) { const e = new Error("Say why you're looking."); e.status = 400; throw e; }
  const since = now() - SEEN_DAYS * 86400e3;
  const nets = await getQuery("SELECT net_hash FROM net_seen WHERE user_id = ? AND last_at > ?", [String(userId), since]);
  let rows = [];
  if (nets.length) {
    rows = await getQuery(`SELECT s.user_id, MAX(s.last_at) AS last, u.username, u.camfrogUsername FROM net_seen s LEFT JOIN users u ON u.userId = s.user_id
                           WHERE s.net_hash IN (${nets.map(() => "?").join(",")}) AND s.user_id != ? AND s.last_at > ? GROUP BY s.user_id ORDER BY last DESC LIMIT 200`,
      [...nets.map((x) => x.net_hash), String(userId), since]);
  }
  await logView(me, userId, reason);
  return { networks: nets.length, shared: rows.map((r) => ({ username: r.username || null, linked: r.camfrogUsername || null, lastDay: new Date(Number(r.last)).toISOString().slice(0, 10) })) };
}
/** Ban every network `userId` used in the last 30 days. scope site | pad (roomId). days default 7; 0 = permanent. */
async function banAccountNets(me, userId, { scope = "site", roomId = null, reason = "", days = 7, exempt = [], via = "admin" } = {}) {
  needAdmin(me);
  await init();
  if (!ON) { const e = new Error("Network bans are switched off."); e.status = 409; throw e; }
  const nets = await getQuery("SELECT net_hash FROM net_seen WHERE user_id = ? AND last_at > ?", [String(userId), now() - RECENT_DAYS * 86400e3]);
  const until = Number(days) > 0 ? now() + Math.min(365, Number(days)) * 86400e3 : null;
  const ids = [];
  await tx(async () => {
    for (const n of nets) {
      const r = await runQuery(`INSERT INTO net_bans (net_hash, scope, room_id, from_user, until, reason, by_id, by_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [n.net_hash, scope === "pad" ? "pad" : "site", scope === "pad" ? String(roomId || "") : null, String(userId), until, String(reason || "").slice(0, 120) || null, String(me.userId), me.username, now()]);
      if (r && r.id) ids.push(r.id);
    }
    for (const id of ids) for (const u of exempt) await runQuery("INSERT OR IGNORE INTO net_ban_exempt (ban_id, user_id) VALUES (?, ?)", [id, String(u)]);
  });
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "net_ban", { userId: String(userId), username: null },
    { op: "account_nets", n: ids.length, scope, room: roomId || null, until, via }, String(reason || "").slice(0, 200) || null);
  await reload();
  return { ok: true, networks: ids.length, until };
}
/** Ban one typed IP (stored only as its code) or a range (stored as the rule). */
async function banTyped(me, { ip = null, cidr = null, scope = "site", roomId = null, reason = "", days = 7 } = {}) {
  needAdmin(me);
  await init();
  if (!ON) { const e = new Error("Network bans are switched off."); e.status = 409; throw e; }
  const until = Number(days) > 0 ? now() + Math.min(365, Number(days)) * 86400e3 : null;
  let hash = null, rule = null;
  if (cidr) { const c = parseCidr(cidr); if (!c) { const e = new Error("A range like 203.0.113.0/24 (IPv4 /8-/31) or 2001:db8::/48 (IPv6 /32-/63)."); e.status = 400; throw e; } rule = String(cidr).trim().toLowerCase(); }
  else { if (!(ip4(ip) != null || ip6(ip) != null)) { const e = new Error("That isn't an IP address."); e.status = 400; throw e; } hash = netHash(ip); }
  const r = await runQuery(`INSERT INTO net_bans (net_hash, cidr, scope, room_id, until, reason, by_id, by_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [hash, rule, scope === "pad" ? "pad" : "site", scope === "pad" ? String(roomId || "") : null, until, String(reason || "").slice(0, 120) || null, String(me.userId), me.username, now()]);
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "net_ban", null, { op: rule ? "range" : "ip", rule, scope, room: roomId || null, until }, String(reason || "").slice(0, 200) || null);
  await reload();
  return { ok: true, id: r && r.id, until };
}
async function lift(me, id) {
  needAdmin(me);
  await init();
  // (review fix: an account's networks are ONE ban in the list - `id` may be several ids)
  const ids = (Array.isArray(id) ? id : [id]).map((x) => Math.floor(Number(x))).filter((x) => x > 0).slice(0, 200);
  await tx(async () => { for (const x of ids) await runQuery("UPDATE net_bans SET lifted_at = ?, lifted_by = ? WHERE id = ? AND lifted_at IS NULL", [now(), me.username, x]); });
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "net_ban", null, { op: "lift", ids }, null);
  await reload();
  return { ok: true };
}
/** The active bans for the admin list: what kind, scope, until, reason, who - never a code. A range shows its rule. Review fix: one
 *  account's networks banned together are ONE row (ids: every network's ban, n: how many networks, exempt: how many let through). */
async function listBans(me) {
  needAdmin(me);
  await init();
  const rows = await getQuery(`SELECT b.id, b.cidr, b.scope, b.room_id, b.until, b.reason, b.by_name, b.created, b.from_user, u.username AS from_name,
                               (SELECT COUNT(*) FROM net_ban_exempt e WHERE e.ban_id = b.id) AS ex FROM net_bans b
                               LEFT JOIN users u ON u.userId = b.from_user WHERE b.lifted_at IS NULL AND (b.until IS NULL OR b.until > ?) ORDER BY b.created DESC LIMIT 2000`, [now()]);
  const out = [], groups = new Map();
  for (const r of rows) {
    const base = { kind: r.cidr ? "range" : r.from_user ? "account" : "ip", rule: r.cidr || null, from: r.from_name || null, scope: r.scope, room: r.room_id || null,
                   until: r.until == null ? null : Number(r.until), reason: r.reason || "", by: r.by_name || "", at: Number(r.created) };
    if (base.kind !== "account") { out.push(Object.assign({ id: Number(r.id), ids: [Number(r.id)], n: 1, exempt: Number(r.ex) || 0 }, base)); continue; }
    const k = [r.from_user, r.scope, r.room_id || "", r.until == null ? "p" : Math.round(Number(r.until) / 60000), r.by_name || ""].join("|");
    let g = groups.get(k);
    if (!g) { g = Object.assign({ id: Number(r.id), ids: [], n: 0, exempt: 0 }, base); groups.set(k, g); out.push(g); }
    g.ids.push(Number(r.id)); g.n++; g.exempt = Math.max(g.exempt, Number(r.ex) || 0);
  }
  return out.slice(0, 500);
}
/** Is any network data stored (codes or bans)? The privacy page says what is kept while there is any, switch or not (review fix). */
let dataAt = 0, dataV = false;
async function hasData() {
  if (ON) return true;
  if (now() - dataAt < 60e3) return dataV;
  try { await init(); dataV = !!(await getQuery("SELECT 1 AS x FROM net_seen LIMIT 1"))[0] || !!(await getQuery("SELECT 1 AS x FROM net_bans WHERE lifted_at IS NULL LIMIT 1"))[0]; }
  catch (e) { dataV = false; }
  dataAt = now();
  return dataV;
}
const hasDataNow = () => ON || dataV;
async function setOn(me, on) {
  needAdmin(me);
  await init();
  await runQuery("INSERT INTO netban_config (key, value, updated, actor) VALUES ('on', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor",
    [on ? "1" : "0", now(), me.username]);
  ON = !!on;
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "net_ban", null, { op: on ? "switch_on" : "switch_off" }, null);
  return { on: ON };
}
async function sweep() {
  try {
    await init();
    const t = now();
    await runQuery("DELETE FROM net_seen WHERE last_at < ?", [t - SEEN_DAYS * 86400e3]);
    await runQuery("DELETE FROM net_bans WHERE (lifted_at IS NOT NULL AND lifted_at < ?) OR (until IS NOT NULL AND until < ?)", [t - BAN_KEEP_DAYS * 86400e3, t - BAN_KEEP_DAYS * 86400e3]);
    await runQuery("DELETE FROM net_ban_exempt WHERE ban_id NOT IN (SELECT id FROM net_bans)");
    await runQuery("DELETE FROM net_views WHERE at < ?", [t - VIEW_KEEP_DAYS * 86400e3]);
  } catch (e) { console.error("[netban] sweep:", e.message); }
}
/** Account deletion / merge. */
async function forget(userId) { try { await init(); await runQuery("DELETE FROM net_seen WHERE user_id = ?", [String(userId)]); } catch (e) { /* none */ } }

/** Express middleware for a write route: 403 with the refusal when the request's network is banned (roomOf(req) -> room id | null). */
function guardWrite(roomOf = null, userOf = (req) => req.user || null) {
  return async (req, res, next) => {
    if (!ON) return next();
    try {
      const roomId = roomOf ? await roomOf(req) : null;
      const why = await refusal(req, { roomId, user: userOf(req) });
      if (why) return res.status(403).json({ ok: false, code: "network", error: why });
    } catch (e) { /* fail open: the other checks still run */ }
    next();
  };
}

function register(app, { addUser }) {
  init().then(() => hasData()).catch((e) => console.error("[netban] init:", e.message));
  const t = setInterval(sweep, 24 * 3600e3); if (t.unref) t.unref();
  const t0 = setTimeout(sweep, 150 * 1000); if (t0.unref) t0.unref();      // (review fix: soon after a start too - deploys come often)
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (!(e && e.status)) console.error("[netban]", e);                 // (review fix: a 500 leaves a log line)
    res.status(e && e.status ? e.status : 500).json({ ok: false, error: e && e.status ? e.message : "Something went wrong." });
  };
  const meOf = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] : null);
  const writeOk = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch" && guard.sameSite(req);
  const who = async (raw) => {
    // u:<id> | @name | cf:<login> | a bare name (targets.js: one person, or 409 with the choices)
    const T = await require("./targets").resolve(String(raw || ""), { allowLogin: false });
    if (T.ambiguous) { const e = new Error(T.error); e.status = 409; e.choices = T.choices; throw e; }
    if (T.error || !T.userId) { const e = new Error(T.error || "No such account."); e.status = 404; throw e; }
    return T;
  };
  const failWho = (res, e) => (e && e.choices ? res.status(409).json({ ok: false, code: "ambiguous", error: e.message, choices: e.choices }) : fail(res, e));
  // (review fix: a POST - the free-text reason never sits in a URL, so it never lands in an access log)
  app.post("/api/admin/nets", addUser, require("express").json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try {
      const me = await meOf(req); needAdmin(me);
      const b = req.body || {}, T = await who(b.who);
      if (b.op === "hitting") return res.json({ ok: true, username: T.username, bans: await hitting(me, T.userId, b.reason) });
      res.json({ ok: true, username: T.username, ...(await sharedDetail(me, T.userId, b.reason)) });
    } catch (e) { failWho(res, e); }
  });
  app.get("/api/admin/netbans", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const me = await meOf(req); res.json({ ok: true, on: (await init(), ON), bans: await listBans(me) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/netbans", addUser, require("express").json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!writeOk(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try {
      const me = await meOf(req), b = req.body || {};
      if (b.op === "switch") return res.json({ ok: true, ...(await setOn(me, b.on === true)) });
      if (b.op === "lift") return res.json(await lift(me, Array.isArray(b.ids) ? b.ids : b.id));
      if (b.op === "account") {
        const T = await who(b.target);
        return res.json(await banAccountNets(me, T.userId, { scope: b.scope, roomId: b.room || null, reason: b.reason, days: b.days, exempt: Array.isArray(b.exempt) ? b.exempt.slice(0, 50) : [] }));
      }
      // (review fix: let one account through - every ban hitting it now, or the ones named - without lifting the ban for everyone)
      if (b.op === "exempt") { const T = await who(b.target); return res.json(Object.assign({ username: T.username }, await exempt(me, T.userId, Array.isArray(b.ids) ? b.ids : [], b.reason))); }
      if (b.op === "ip" || b.op === "range") return res.json(await banTyped(me, { ip: b.op === "ip" ? b.value : null, cidr: b.op === "range" ? b.value : null, scope: b.scope, roomId: b.room || null, reason: b.reason, days: b.days }));
      res.status(400).json({ ok: false, error: "switch, lift, account, exempt, ip or range" });
    } catch (e) { failWho(res, e); }
  });
}

module.exports = { init, register, note, refusal, newAccountRefusal, guardWrite, netHash, netOf, reqNet, parseCidr, inCidr, shared, sharedDetail, hitting, exempt, banAccountNets, banTyped, lift, listBans, setOn,
  isOn, hasData, hasDataNow, hasPadBans, sweep, forget, reload, REFUSAL, KIND,
  _setClock: (f) => { clock = f; }, _setOn: (v) => { ON = !!v; }, _resetKey: () => { KEY = null; } };
