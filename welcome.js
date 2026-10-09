// welcome.js — the welcome bonus (1.99bg): earned, once per real person, paid from the Reserve.
//
// Before: every new account got 50,000 PAT the moment it existed - web sign-ups (minted straight
// into the row), Pepe's auto-created Camfrog accounts and Discord/Twitch sign-ups (a 50k "connect"
// bonus) - so alts were free money. Now:
//
//   * a new account starts at 0 and gets a PENDING welcome bonus (welcome_bonus row)
//   * it VESTS when the account has really been used: level >= min_level (2), active on >= min_days
//     (2) different days (Camfrog chat/mic/commands from Pepe's user stats, PAT activity, or signed-in
//     site visits), and is at least min_age_hours (24) old
//   * it is paid ONCE PER PERSON: at vesting, the account's identity keys are compared with every
//     account that already got a welcome (or was here before this change): Camfrog login + Pepe's
//     alias identity, Discord id, Twitch id, normalised email (gmail dots/+tags), the browser
//     (patv_dev cookie) and the network (IP - at most ip_max welcomes per network per ip_window_days).
//     A match marks it "duplicate" (an admin can still pay it). Disposable-email-only accounts wait
//     for a real identity (a linked Camfrog, Discord or Twitch).
//   * the amount is admin-set (default 10,000) and paid from the Federal Reserve ("new_account"
//     payout row, a reserve_claims row Pepe settles); if the Reserve can't cover it, it stays
//     pending and is retried. Every decision is logged on the row (state, reason, dup_of, amount).
//   * Discord/Twitch CONNECT bonuses: an account created by that sign-in gets none (the welcome is its
//     bonus); linking to an existing account pays it only once per Discord/Twitch id, ever, and an
//     account whose welcome hasn't vested yet has it held (owed) and paid with the welcome.
//
// Privacy: identity keys are stored only as HMAC-SHA256(salt, kind:value) - never the raw IP,
// cookie, email or id - and network keys are dropped after 90 days. The salt is random per database.
//
// Existing accounts: anyone already here is "legacy" (keeps what they got - no clawback) and their
// keys count for dedupe; accounts from the last 30 days whose welcome was never paid (the Reserve
// was short) follow the new rule.
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const funding = require("./funding");

const DEFAULTS = { enabled: 1, amount: 10000, min_level: 2, min_days: 2, min_age_hours: 24, ip_max: 2,
  ip_window_days: 30, expire_days: 90, connect_amount: 50000 };
const STRONG = new Set(["cf", "discord", "twitch", "email", "dev"]);
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com",
  "temp-mail.org", "tempmail.com", "tempmail.net", "yopmail.com", "trashmail.com", "getnada.com", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mohmal.com", "emailondeck.com", "mintemail.com", "spamgourmet.com",
  "tempr.email", "discard.email", "mailnesia.com", "moakt.com", "burnermail.io", "temp-mail.io", "1secmail.com", "inboxkitten.com"]);
const DEV_COOKIE = "patv_dev";
const CF_RANDOM = /^CF[a-z0-9]{8}$/;

let salt = null;
let cfg = Object.assign({}, DEFAULTS);
let connectAward = null;               // awardBonus (user.controller); tests swap it
const touched = new Map();             // userId -> "YYYY-MM-DD" already recorded today (fewer writes)

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS welcome_bonus (
    userId TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER, amount INTEGER,
    reason TEXT, dup_of TEXT, connect_owed INTEGER DEFAULT 0, source TEXT)`);
  await runQuery("CREATE INDEX IF NOT EXISTS welcome_bonus_state ON welcome_bonus (state)");
  await runQuery(`CREATE TABLE IF NOT EXISTS welcome_keys (
    k TEXT NOT NULL, userId TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (k, userId))`);
  await runQuery("CREATE INDEX IF NOT EXISTS welcome_keys_user ON welcome_keys (userId)");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_activity (userId TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (userId, day))");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_meta (k TEXT PRIMARY KEY, v TEXT)");
  const s = await getQuery("SELECT v FROM welcome_meta WHERE k = 'salt'");
  if (s[0] && s[0].v) salt = s[0].v;
  else {
    salt = crypto.randomBytes(32).toString("hex");
    await runQuery("INSERT OR IGNORE INTO welcome_meta (k, v) VALUES ('salt', ?)", [salt]);
    salt = (await getQuery("SELECT v FROM welcome_meta WHERE k = 'salt'"))[0].v;
  }
  const c = await getQuery("SELECT v FROM welcome_meta WHERE k = 'config'");
  if (c[0]) cfg = cleanConfig(JSON.parse(c[0].v || "{}"));
})().catch((e) => console.error("[welcome] init:", e));

function cleanConfig(c) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const n = Math.floor(Number((c || {})[k]));
    out[k] = Number.isFinite(n) && n >= 0 ? Math.min(n, k.endsWith("amount") ? 10000000 : 100000) : d;
  }
  out.enabled = out.enabled ? 1 : 0;
  return out;
}

async function setConfig(c) {
  await ready;
  cfg = cleanConfig(Object.assign({}, cfg, c || {}));
  await runQuery("INSERT INTO welcome_meta (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(cfg)]);
  return cfg;
}
const config = () => Object.assign({}, cfg);

// ── identity keys (hashed) ──
function hash(kind, value) {
  return kind + ":" + crypto.createHmac("sha256", salt || "unsalted").update(kind + ":" + value).digest("hex").slice(0, 32);
}

function normEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  const m = s.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  return { addr: local + "@" + domain, domain, disposable: DISPOSABLE.has(domain) || /(^|\.)(temp|trash|throwaway|fake)[a-z-]*mail/.test(domain) };
}

// IPv4 as is; IPv6 by its /64 (one household / phone)
function normIp(ip) {
  let s = String(ip || "").trim().toLowerCase();
  if (!s || s === "?") return null;
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s === "127.0.0.1" || s === "::1") return null;
  if (s.includes(":")) return s.split(":").slice(0, 4).join(":") + "::/64";
  return s;
}

// The keys a user row proves (Camfrog, Discord, Twitch, a real email)
function rowKeys(u, extra) {
  const keys = [];
  if (!u) return keys;
  if (u.camfrogUsername) keys.push(["cf", hash("cf", String(u.camfrogUsername).toLowerCase())]);
  if (u.discordId) keys.push(["discord", hash("discord", String(u.discordId))]);
  if (u.twitchId) keys.push(["twitch", hash("twitch", String(u.twitchId))]);
  const em = normEmail(u.email);
  if (em && !em.disposable && (Number(u.isEmailVerified) === 1 || u.twitchId || u.discordId)) keys.push(["email", hash("email", em.addr)]);
  for (const [k, v] of extra || []) keys.push([k, v]);
  return keys;
}

async function addKeys(userId, keys) {
  if (!userId || !keys.length) return;
  const now = Date.now();
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    await runQuery(`INSERT OR IGNORE INTO welcome_keys (k, userId, kind, created) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}`,
      part.flatMap(([kind, k]) => [k, userId, kind, now]));
  }
}

// ── request hooks ──
function deviceId(req, res) {
  let d = req.cookies && req.cookies[DEV_COOKIE];
  if (typeof d !== "string" || !/^[a-f0-9]{32}$/.test(d)) {
    d = crypto.randomBytes(16).toString("hex");
    try { res.cookie(DEV_COOKIE, d, { httpOnly: true, sameSite: "lax", secure: req.secure || req.get("x-forwarded-proto") === "https", maxAge: 2 * 365 * 86400000 }); } catch (e) { /* headers sent */ }
  }
  return d;
}

function reqKeys(req, res) {
  const out = [];
  const dev = deviceId(req, res);
  if (dev) out.push(["dev", hash("dev", dev)]);
  const ip = normIp(require("./middleware/authGuard").clientIp(req));
  if (ip) out.push(["ip", hash("ip", ip)]);
  return out;
}

// Signed-in page views and actions: the browser/network keys + an active day (once a day per user).
async function touch(userId, req, res) {
  try {
    await ready;
    if (!userId) return;
    const day = new Date().toISOString().slice(0, 10);
    if (touched.get(userId) === day) return;
    touched.set(userId, day);
    if (touched.size > 50000) touched.clear();
    await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES (?, ?)", [userId, day]);
    if (req) await addKeys(userId, reqKeys(req, res));
  } catch (e) {
    console.error("[welcome] touch:", e.message);
  }
}

// express middleware: give every browser a device id; record signed-in activity
function middleware(getUserId) {
  return (req, res, next) => {
    if (req.method !== "GET" || /^\/(api|public|og|uploads)\b|^\/healthz/.test(req.path)) return next();
    deviceId(req, res);
    const uid = getUserId(req);
    if (uid) touch(uid, req, res);
    next();
  };
}

// ── new accounts ──
// source: web | camfrog | discord | twitch | discord-bot | twitch-bot. `identity` = Pepe's canonical
// alias identity for a Camfrog login (one person, several logins).
async function enroll(userId, source, req, res, identity) {
  try {
    await ready;
    if (!userId) return;
    await runQuery("INSERT OR IGNORE INTO welcome_bonus (userId, state, created, source) VALUES (?, 'pending', ?, ?)", [userId, Date.now(), source || null]);
    const extra = req ? reqKeys(req, res) : [];
    if (identity) extra.push(["cf", hash("cf", String(identity).toLowerCase())]);
    const u = (await getQuery("SELECT userId, camfrogUsername, discordId, twitchId, email, isEmailVerified FROM users WHERE userId = ?", [userId]))[0];
    await addKeys(userId, rowKeys(u, extra));
    if (req) {
      const day = new Date().toISOString().slice(0, 10);
      await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES (?, ?)", [userId, day]);
      touched.set(userId, day);
    }
  } catch (e) {
    console.error("[welcome] enroll:", e.message);
  }
}

// ── vesting ──
async function activeDays(userId, camfrog) {
  const days = new Set();
  (await getQuery("SELECT day FROM welcome_activity WHERE userId = ?", [userId])).forEach((r) => days.add(r.day));
  (await getQuery("SELECT DISTINCT date(timestamp) AS d FROM transactions WHERE userId = ? AND type NOT IN ('Welcome PAT', 'bonus win') LIMIT 400", [userId]))
    .forEach((r) => r.d && days.add(r.d));
  if (camfrog) {
    const row = (await getQuery("SELECT data FROM camfrog_userstats WHERE login = ?", [String(camfrog).toLowerCase()]).catch(() => []))[0];
    if (row) {
      try {
        const s = JSON.parse(row.data) || {};
        const add = (o, min) => Object.entries(o || {}).forEach(([d, v]) => { if (Number(v) >= min) days.add(d); });
        add((s.chat || {}).days, 5);          // 5+ messages
        add((s.mic || {}).days, 120);         // 2+ minutes on mic
        add((s.cmds || {}).days, 1);          // a command
      } catch (e) { /* bad row */ }
    }
  }
  return days.size;
}

// {vested: bool, need: [what's missing], level, days, hours}
async function progress(userId) {
  await ready;
  const u = (await getQuery("SELECT userId, level, created_at, camfrogUsername, discordId, twitchId, email, isEmailVerified FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return null;
  const t = Date.parse(String(u.created_at || "").replace(" ", "T") + "Z");
  const hours = Number.isFinite(t) ? (Date.now() - t) / 3600000 : 0;
  const days = await activeDays(userId, u.camfrogUsername);
  const level = Number(u.level) || 0;
  const need = [];
  if (level < cfg.min_level) need.push(`reach level ${cfg.min_level} (you're ${level})`);
  if (days < cfg.min_days) need.push(`be active on ${cfg.min_days} different days (${days} so far)`);
  if (hours < cfg.min_age_hours) need.push(`wait until your account is ${cfg.min_age_hours} hours old`);
  const em = normEmail(u.email);
  const real = u.camfrogUsername || u.discordId || u.twitchId || (em && !em.disposable && Number(u.isEmailVerified) === 1);
  if (!real) need.push("link your Camfrog name (!verify), Discord or Twitch, or verify a non-disposable email");
  return { vested: !need.length, need, level, days, hours: Math.floor(hours), user: u };
}

// Same person as someone who already got a welcome? -> {dup_of, reason} or null
async function duplicateOf(userId, keys) {
  const strong = keys.filter(([kind]) => STRONG.has(kind)).map(([, k]) => k);
  if (strong.length) {
    const hit = await getQuery(`SELECT k.userId, k.kind FROM welcome_keys k JOIN welcome_bonus b ON b.userId = k.userId
      WHERE k.k IN (${strong.map(() => "?").join(",")}) AND k.userId != ? AND b.state IN ('paid', 'legacy', 'paying') LIMIT 1`, [...strong, userId]);
    if (hit[0]) return { dup_of: hit[0].userId, reason: `same ${({ cf: "Camfrog identity", dev: "browser", email: "email" })[hit[0].kind] || hit[0].kind} as an account that already got one` };
  }
  const ips = keys.filter(([kind]) => kind === "ip").map(([, k]) => k);
  if (ips.length) {
    const since = Date.now() - cfg.ip_window_days * 86400000;
    const n = await getQuery(`SELECT COUNT(DISTINCT k.userId) AS n FROM welcome_keys k JOIN welcome_bonus b ON b.userId = k.userId
      WHERE k.k IN (${ips.map(() => "?").join(",")}) AND k.userId != ? AND b.state = 'paid' AND b.decided >= ?`, [...ips, userId, since]);
    if (n[0] && n[0].n >= cfg.ip_max) return { dup_of: null, reason: `${n[0].n} welcome bonuses already went to this network in ${cfg.ip_window_days} days` };
  }
  return null;
}

async function setState(userId, state, fields) {
  const f = Object.assign({ reason: null, dup_of: null, amount: null }, fields || {});
  await runQuery("UPDATE welcome_bonus SET state = ?, decided = ?, reason = ?, dup_of = ?, amount = COALESCE(?, amount) WHERE userId = ?",
    [state, Date.now(), f.reason, f.dup_of, f.amount, userId]);
}

// Pay a vested, non-duplicate welcome (+ any connect bonuses it held). force = an admin override.
async function payout(userId, force) {
  const from = force ? "('pending', 'duplicate', 'expired')" : "('pending')";
  const claim = await runQuery(`UPDATE welcome_bonus SET state = 'paying' WHERE userId = ? AND state IN ${from}`, [userId]);
  if (!claim || !claim.changes) return { ok: false, why: "not pending" };
  const amount = cfg.amount;
  const ok = amount > 0 ? await funding.fundPayout(userId, amount, "new_account", "Welcome PAT") : true;
  const queued = ok === "queued";             // E-2: owed by the incentive budget; its queue credits it
  if (!ok) {
    await runQuery("UPDATE welcome_bonus SET state = 'pending', reason = ? WHERE userId = ?", ["the Federal Reserve can't cover it right now - retrying", userId]);
    return { ok: false, why: "reserve" };
  }
  await setState(userId, "paid", { amount, reason: (force ? "paid by an admin" : "vested")
    + (queued ? " - queued: paid when the weekly incentive budget has room" : "") });
  const row = (await getQuery("SELECT connect_owed FROM welcome_bonus WHERE userId = ?", [userId]))[0] || {};
  const owed = Number(row.connect_owed) || 0;
  if (owed > 0) {
    await runQuery("UPDATE welcome_bonus SET connect_owed = 0 WHERE userId = ?", [userId]);
    const awardBonus = connectAward || require("./user.controller").awardBonus;
    for (let i = 0; i < owed; i++) await awardBonus(userId, "connect bonus (held until the welcome vested)", cfg.connect_amount).catch(() => {});
  }
  console.log(`[welcome] paid ${userId} ${amount}${owed ? ` + ${owed} held connect bonus(es)` : ""}${force ? " (admin)" : ""}`);
  await require("./inbox").addSafe(userId, { kind: "system", title: `Welcome bonus: PAT ${amount.toLocaleString("en-US")}`,
    body: queued ? "Thanks for sticking around - your welcome bonus is in line for this week's incentive budget and lands in your wallet as soon as it has room."
                 : "Thanks for sticking around - your welcome bonus is in your wallet.", link: "/wallet", ref: `welcome:${userId}` });
  return { ok: true, amount };
}

// One user: vest + dedupe + pay. Returns the new state.
async function check(userId) {
  await ready;
  const row = (await getQuery("SELECT * FROM welcome_bonus WHERE userId = ?", [userId]))[0];
  if (!row || row.state !== "pending") return row ? row.state : null;
  if (!cfg.enabled) return "pending";
  const p = await progress(userId);
  if (!p) { await setState(userId, "gone", { reason: "account no longer exists" }); return "gone"; }
  if (!p.vested) {
    if (Date.now() - row.created > cfg.expire_days * 86400000) { await setState(userId, "expired", { reason: "never vested" }); return "expired"; }
    return "pending";
  }
  const own = await getQuery("SELECT kind, k FROM welcome_keys WHERE userId = ?", [userId]);
  const keys = rowKeys(p.user, own.map((r) => [r.kind, r.k]));
  await addKeys(userId, keys.filter(([kind]) => kind !== "ip" && kind !== "dev"));
  const dup = await duplicateOf(userId, keys);
  if (dup) {
    await setState(userId, "duplicate", dup);
    console.log(`[welcome] ${userId} not paid: ${dup.reason}`);
    return "duplicate";
  }
  const r = await payout(userId, false);
  return r.ok ? "paid" : "pending";
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await ready;
    // a crash between claiming and paying: paid if the transaction landed, else back to pending
    for (const r of await getQuery("SELECT userId, decided FROM welcome_bonus WHERE state = 'paying'")) {
      const t = await getQuery("SELECT 1 FROM transactions WHERE userId = ? AND type = 'Welcome PAT' LIMIT 1", [r.userId]);
      await runQuery("UPDATE welcome_bonus SET state = ? WHERE userId = ? AND state = 'paying'", [t[0] ? "paid" : "pending", r.userId]);
    }
    const rows = await getQuery("SELECT userId FROM welcome_bonus WHERE state = 'pending' ORDER BY created LIMIT 300");
    for (const r of rows) await check(r.userId).catch((e) => console.error("[welcome] check:", e.message));
    await runQuery("DELETE FROM welcome_keys WHERE kind = 'ip' AND created < ?", [Date.now() - 90 * 86400000]);
    await runQuery("DELETE FROM welcome_activity WHERE day < ?", [new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)]);
  } catch (e) {
    console.error("[welcome] sweep:", e.message);
  } finally {
    sweeping = false;
  }
}

// ── connect bonuses (Discord/Twitch linked to an existing account) ──
// Returns "paid" | "held" | "dup" | "none". `created` = this sign-in made the account (no bonus).
async function connectBonus(userId, platform, platformId, award, created) {
  await ready;
  if (created || !userId) return "none";
  const k = hash("conn-" + platform, String(platformId || ""));
  if (platformId) {
    // 1.99fy: claim the id and check it in ONE statement - pay only when this call inserted the key.
    // (A look-then-insert let two racing sign-ins / merges both pass the check and both get paid;
    // the key's primary key is (k, userId), so INSERT OR IGNORE alone would let a second account in.)
    const ins = await runQuery(`INSERT OR IGNORE INTO welcome_keys (k, userId, kind, created)
                                SELECT ?, ?, 'conn', ? WHERE NOT EXISTS (SELECT 1 FROM welcome_keys WHERE k = ?)`,
                               [k, userId, Date.now(), k]);
    if (!ins || ins.changes !== 1) return "dup";           // that Discord/Twitch id already earned one
  }
  const row = (await getQuery("SELECT state FROM welcome_bonus WHERE userId = ?", [userId]))[0];
  if (row && !["paid", "legacy"].includes(row.state)) {
    await runQuery("UPDATE welcome_bonus SET connect_owed = connect_owed + 1 WHERE userId = ?", [userId]);
    return "held";
  }
  await award(userId, `${platform} connect`, cfg.connect_amount);
  return "paid";
}

// ── one-off: existing accounts (no clawback) ──
async function backfill() {
  await ready;
  const done = await getQuery("SELECT v FROM welcome_meta WHERE k = 'backfill'");
  if (done[0]) return;
  const t0 = Date.now();
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  // unpaid recent Pepe-created / Discord / Twitch accounts follow the new rule
  const unpaid = await getQuery(`SELECT u.userId FROM users u WHERE u.created_at >= ?
      AND (u.username GLOB 'CF[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]' OR u.discordBonus = 1 OR u.twitchBonus = 1)
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.userId = u.userId AND t.type = 'Welcome PAT')
      AND NOT EXISTS (SELECT 1 FROM bonus_winners b WHERE b.userId = u.userId AND b.type LIKE '%connect%')`, [recent]);
  for (let i = 0; i < unpaid.length; i += 200) {
    const part = unpaid.slice(i, i + 200);
    await runQuery(`INSERT OR IGNORE INTO welcome_bonus (userId, state, created, source, reason) VALUES ${part.map(() => "(?, 'pending', ?, 'backfill', 'never paid before 1.99bg')").join(", ")}`,
      part.flatMap((r) => [r.userId, Date.now()]));
  }
  // everyone else is legacy; their identities count for dedupe
  await runQuery("INSERT OR IGNORE INTO welcome_bonus (userId, state, created, decided, source, reason) SELECT userId, 'legacy', ?, ?, 'legacy', 'account from before 1.99bg' FROM users", [Date.now(), Date.now()]);
  const users = await getQuery("SELECT userId, camfrogUsername, discordId, twitchId, email, isEmailVerified FROM users WHERE camfrogUsername IS NOT NULL OR discordId IS NOT NULL OR twitchId IS NOT NULL OR isEmailVerified = 1");
  let n = 0;
  for (const u of users) { const ks = rowKeys(u); n += ks.length; await addKeys(u.userId, ks); }
  // Discord/Twitch ids that already earned a connect bonus
  for (const u of await getQuery("SELECT userId, discordId, twitchId, discordBonus, twitchBonus FROM users WHERE (discordBonus = 1 AND discordId IS NOT NULL) OR (twitchBonus = 1 AND twitchId IS NOT NULL)")) {
    const ks = [];
    if (u.discordBonus && u.discordId) ks.push(["conn", hash("conn-discord", String(u.discordId))]);
    if (u.twitchBonus && u.twitchId) ks.push(["conn", hash("conn-twitch", String(u.twitchId))]);
    await addKeys(u.userId, ks);
  }
  await runQuery("INSERT OR REPLACE INTO welcome_meta (k, v) VALUES ('backfill', ?)", [String(Date.now())]);
  console.log(`[welcome] backfill: ${unpaid.length} unpaid recent account(s) pending, ${users.length} legacy identities (${n} keys) in ${Date.now() - t0} ms`);
}

// ── admin ──
async function adminView() {
  await ready;
  const counts = {};
  for (const r of await getQuery("SELECT state, COUNT(*) AS n FROM welcome_bonus GROUP BY state")) counts[r.state] = r.n;
  const since = Date.now() - 7 * 86400000;
  const paid7 = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM welcome_bonus WHERE state = 'paid' AND decided >= ?", [since]))[0];
  const recent = await getQuery(`SELECT b.userId, u.username, u.displayname, b.state, b.created, b.decided, b.amount, b.reason, b.dup_of, b.source, b.connect_owed,
      d.username AS dup_name FROM welcome_bonus b LEFT JOIN users u ON u.userId = b.userId LEFT JOIN users d ON d.userId = b.dup_of
      WHERE b.state IN ('pending', 'duplicate', 'paid', 'expired') ORDER BY COALESCE(b.decided, b.created) DESC LIMIT 40`);
  return { config: config(), counts, paid7: { n: paid7.n, total: paid7.t, perDay: Math.round(paid7.t / 7) }, recent };
}

// for the wallet: {state, amount, need} or null
async function status(userId) {
  await ready;
  const row = (await getQuery("SELECT state, amount, reason, connect_owed FROM welcome_bonus WHERE userId = ?", [userId]))[0];
  if (!row || row.state === "legacy" || row.state === "gone") return null;
  if (row.state !== "pending") return { state: row.state, amount: row.amount || cfg.amount, reason: row.reason, need: [] };
  const p = await progress(userId);
  return { state: "pending", amount: cfg.amount, need: p ? p.need : [], level: p && p.level, days: p && p.days, connectOwed: row.connect_owed || 0, enabled: !!cfg.enabled };
}

function start() {
  setTimeout(() => backfill().catch((e) => console.error("[welcome] backfill:", e.message)), 20000);
  setInterval(() => sweep(), 10 * 60 * 1000).unref();
  setTimeout(() => sweep(), 60000).unref();
}

module.exports = { start, enroll, touch, middleware, check, sweep, payout, connectBonus, backfill, adminView, status, progress,
  setConfig, config, normEmail, normIp, hash, reqKeys, duplicateOf, ready, DEFAULTS, useConnectAward: (fn) => { connectAward = fn; }, _reset: () => { touched.clear(); cfg = Object.assign({}, DEFAULTS); } };
