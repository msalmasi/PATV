// members.js — 1.99anv: the 👥 All members table on /admin/users#members (owner, 2026-11-14: "is there somewhere I can see all
// users and sort by when users were created?").
//
//   GET /api/admin/members?page=&sort=&dir=&q=&filter=&country=     capability accounts.members (Admin, locked: privacy)
//     page    1-based; PER (50) rows a page, paged on the server
//     sort    created (default, newest first) | seen | level | username; dir asc | desc (each sort has its own default)
//     q       part of a username, display name or Camfrog login (any case; % and _ are literal)
//     filter  all | website | chat | banned | deleted
//     country (1.99anx) a 2-letter code (any case: "us" = "US") = members whose country (below) is that one; "none" = no country
//             on record; anything else (empty, "XX", "T1", "USA", a repeated param) = any country - the way a bad sort / filter
//             falls back to its default, and the answer says what was used (country "")
//   -> {ok, page, pages, per, total (rows matching q + filter + country), sort, dir, filter, q, country, counts, countries,
//       no_country, rows}
//   counts      {total, website, chat, banned, deleted, new7, new30} over every account (q, filter and country don't change them)
//   countries   (1.99anx) [{cc, n}] - every country some account has, n accounts each, most first (then A-Z by code); no_country =
//               the accounts with none on record. Over EVERY account, like counts (q / filter / country don't change them), so the
//               picker's numbers are the whole site's - the card says so
//   rows    [{username, displayname, created (ms), seen (ms | null), level, country (CC | null), methods: [..], invited_by, status: [..],
//             gone}]
//
// What the columns mean
//   created     users.created_at (UTC "YYYY-MM-DD HH:MM:SS", SQLite's CURRENT_TIMESTAMP - every INSERT INTO users leaves it at that)
//   seen        the newest website activity: sessions.last_seen (every sign-in since 1.99wj, written at most every 5 minutes) or the
//               newest welcome_activity day (signed-in page views, kept 120 days) - null = no visit on record (the card says "no visit
//               recorded", not "never": a member from before sessions who hasn't been back in 120 days has none either)
//   country     (1.99anx, owner 2026-11-14: "filter the admin user list by their last logged in country (like we have the flag in the
//               profile)") EXACTLY the profile's 🏳️ (index.js, 1.99abt): of the member's sign-in sessions whose country is 2
//               characters and not XX (unknown) / T1 (Tor) - revoked and expired ones too - the one CREATED last; its code upper-cased
//               when it is 2 letters, else none (the profile then shows no flag either - it never falls back to an older session).
//               sessions.country is Cloudflare's CF-IPCountry at sign-in (sessions.place: only through our proxy, never XX / T1),
//               refreshed while the session is used. NOT the newest last_seen: a member who signed in from abroad last week and is
//               still using an older session from home shows the newer sign-in's country, like the profile. Equal created times
//               (the same millisecond) go to the later row (rowid) - the profile leaves that tie to SQLite. Null = none on record:
//               no session since 1.99wj (most of Pepe's chat accounts, members not seen since), or only XX / T1 / no-proxy ones.
//               One correlated subquery per account on sessions' index sessions_user (user_id, revoked_at) + a sort of that
//               member's few sessions; the filter, the count and the page all run it on the server
//   methods     how the account can sign in: password (users.password_set = 1, or an older account with a real email and no 0
//               marker), google / apple (sso_links), telegram (telegram_links), plex (plex_members linked), twitch / discord (the
//               provider id on the row), camfrog (a linked Camfrog login - Pepe's !signin chat sign-in link)
//   status      admin / staff / assistant (class), chat (chat-only), banned (a site ban: feed_bans room '' still running),
//               deleted (account_deletions 'done', or an account_archive row with tier DELETED), archived (the stale cleanup),
//               deleting (a deletion scheduled or held), invited (made with an invite)
//
// CHAT-ONLY (filter "chat"; invites.chatOnly is the per-account rule this follows, here as one SQL expression so the table can filter,
// count and page on it): an account made for chat - by Pepe (users.auto_source, never cleared - a renamed one too), by the Twitch /
// Discord bots (welcome_bonus.source twitch-bot / discord-bot, an invite_shadow row, or the stale cleanup's "bot-made" shape: a
// provider id with the bots' placeholder email and not an auto name) - that nobody has signed in to on the website:
//   no sessions row, no chat sign-in link used (chat_signin_log 'used'), no Google / Apple / Telegram / Plex link, no email with "@",
//   no password the member set, no website Twitch sign-in (users.twitchLogin) - and for Pepe's accounts no Discord / Twitch id either
//   (those only come from linking, which needs a signed-in member; the bots' accounts are MADE with one).
// "website" = every account that isn't chat-only (and isn't deleted).
//
// PRIVACY (the user-analytics rules): no email address, IP, device or session detail ever leaves this module - an email is only
// tested for "@" inside SQL. Usernames, display names, levels and dates are what the admin area already shows.
// The country (1.99anx) is the one thing taken from a session, and only as the 2-letter code the profile shows (never which
// session, when, from what IP or device): it is shown and filterable here EVEN when the member hid the flag from visitors (the
// profile layout's "country" item) or is incognito - the owner's rule for admins (2026-11-02: "Admins should be able to see
// through this like the other privacy toggles"; 🔐 Account security already shows each session's country and IP). Only holders
// of accounts.members (the gate below; Admin by default, locked: privacy) ever get it.
// Indexes: users (created_at), users (level), users (username COLLATE NOCASE) - the three sorts on the users table itself; "seen" is
// one GROUP BY over sessions (its index sessions_user) and welcome_activity (its primary key); "country" searches sessions_user
// (sessions.js makes it) per account. A database without a sessions table or its country / created column (an old one, a test's)
// has no country for anyone: rows say null, country=none is every account, a code matches nobody, countries is [].
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");

const CAP = "accounts.members";
const PER = 50;
const DAY = 86400000;
const Q_MAX = 64;
const SORTS = Object.freeze({
  created: { def: "desc", col: "u.created_at", tie: "u.rowid" },
  seen: { def: "desc", col: "seen", tie: "u.created_at", nullsLast: true },
  level: { def: "desc", col: "u.level", tie: "u.xp" },
  username: { def: "asc", col: "u.username COLLATE NOCASE", tie: "u.rowid" },
});
const FILTERS = Object.freeze(["all", "website", "chat", "banned", "deleted"]);
const METHODS = Object.freeze(["password", "google", "apple", "telegram", "plex", "twitch", "discord", "camfrog"]);
const AUTO_GLOB = require("./autoaccount").AUTO_GLOB;

let clock = () => Date.now();
const now = () => clock();

// ── schema: what this database has (older ones, and the tests', lack some of it) ──
const has = { tables: new Set(), cols: new Set(), scols: new Set(), at: 0 };
const SCHEMA_MS = 60 * 1000;
async function schema() {
  if (has.at && now() - has.at < SCHEMA_MS) return has;
  const tables = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  const cols = (await getQuery("SELECT name FROM pragma_table_info('users')")).map((r) => r.name);
  const scols = tables.includes("sessions") ? (await getQuery("SELECT name FROM pragma_table_info('sessions')")).map((r) => r.name) : [];
  has.tables = new Set(tables); has.cols = new Set(cols); has.scols = new Set(scols); has.at = now();
  return has;
}
let indexed = null;
/** The sort indexes (once per process; a missing users table is retried next time). */
function ensureIndexes() {
  if (indexed) return indexed;
  indexed = (async () => {
    const H = await schema();
    if (!H.tables.has("users")) { indexed = null; has.at = 0; return false; }
    await runQuery("CREATE INDEX IF NOT EXISTS users_created_at ON users (created_at)");
    await runQuery("CREATE INDEX IF NOT EXISTS users_level ON users (level)");
    await runQuery("CREATE INDEX IF NOT EXISTS users_username_nocase ON users (username COLLATE NOCASE)");
    return true;
  })().catch((e) => { indexed = null; console.error("[members] indexes:", e.message); return false; });
  return indexed;
}

/** "YYYY-MM-DD HH:MM:SS" (UTC, CURRENT_TIMESTAMP's shape) for ms. */
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
/** users.created_at (CURRENT_TIMESTAMP text, or an ISO string / a number some old row may hold) -> ms | null. */
function createdMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z") : s);
  return isFinite(t) ? t : null;
}

/** The SQL pieces for this database: {seenJoin, chat, deleted, banned, archived, invitedJoin, invitedCol, ...}. */
function pieces(H, at) {
  const T = (t) => H.tables.has(t), C = (c) => H.cols.has(c);
  const ex = (t, where) => (T(t) ? `EXISTS (SELECT 1 FROM ${t} WHERE ${where})` : "0");
  const nonEmpty = (c) => (C(c) ? `TRIM(COALESCE(u.${c}, '')) <> ''` : "0");
  const emailAt = C("email") ? "COALESCE(u.email, '') LIKE '%@%'" : "0";
  // website sign-in evidence (invites.webSignedIn, minus the provider ids - see CHAT-ONLY above)
  const webStrong = [
    ex("sessions", "user_id = u.userId"),
    ex("chat_signin_log", "user_id = u.userId AND kind = 'used'"),
    ex("sso_links", "user_id = u.userId"),
    ex("telegram_links", "user_id = u.userId"),
    ex("plex_members", "user_id = u.userId"),
    emailAt,
    C("password_set") ? "COALESCE(u.password_set, 0) = 1" : "0",
    nonEmpty("twitchLogin"),
  ].join(" OR ");
  const pepeMade = C("auto_source") ? "u.auto_source IS NOT NULL" : "0";
  const botMade = [
    T("welcome_bonus") ? "EXISTS (SELECT 1 FROM welcome_bonus w WHERE w.userId = u.userId AND w.source IN ('twitch-bot', 'discord-bot'))" : "0",
    ex("invite_shadow", "user_id = u.userId AND web_at IS NULL"),
    `(u.username NOT GLOB '${AUTO_GLOB}' AND (${nonEmpty("discordId")} OR ${nonEmpty("twitchId")}) AND NOT (${emailAt}))`,
  ].join(" OR ");
  const chat = `((${pepeMade}) AND NOT (${webStrong} OR ${nonEmpty("discordId")} OR ${nonEmpty("twitchId")}))
                OR ((${botMade}) AND NOT (${webStrong}))`;
  const deleted = [ex("account_deletions", "user_id = u.userId AND state = 'done'"),
                   T("account_archive") ? "EXISTS (SELECT 1 FROM account_archive a WHERE a.userId = u.userId AND a.tier = 'DELETED')" : "0"].join(" OR ");
  const deleting = ex("account_deletions", "user_id = u.userId AND state IN ('scheduled', 'held')");
  const banned = T("feed_bans") ? "EXISTS (SELECT 1 FROM feed_bans b WHERE b.user_id = u.userId AND b.room_id = '' AND (b.until IS NULL OR b.until > ?))" : "0";
  const bannedArgs = T("feed_bans") ? [at] : [];
  const archived = C("archived_at") ? "u.archived_at IS NOT NULL" : "0";
  // last seen on the website: the newest session, else the newest signed-in activity day
  const parts = [];
  if (T("sessions")) parts.push("SELECT user_id AS uid, MAX(COALESCE(last_seen, created)) AS t FROM sessions GROUP BY user_id");
  if (T("welcome_activity")) parts.push("SELECT userId AS uid, CAST(strftime('%s', MAX(day)) AS INTEGER) * 1000 AS t FROM welcome_activity GROUP BY userId");
  const seenJoin = parts.length ? `LEFT JOIN (SELECT uid, MAX(t) AS seen FROM (${parts.join(" UNION ALL ")}) GROUP BY uid) sn ON sn.uid = u.userId` : "";
  const seenCol = parts.length ? "sn.seen" : "NULL";
  // 1.99anx: the country they last signed in from - the profile's query (index.js, 1.99abt) as a correlated subquery: its WHERE picks
  // the newest session with a 2-character, non-XX / T1 country, and its JS check (2 letters, upper-cased) becomes the CASE: a newest
  // row that fails it is '' -> NULL, never an older session's (see "country" in the header). Only fixed SQL here, never a value.
  const countryCol = T("sessions") && ["user_id", "created", "country"].every((c) => H.scols.has(c))
    ? `NULLIF((SELECT CASE WHEN s.country GLOB '[A-Za-z][A-Za-z]' THEN upper(s.country) ELSE '' END FROM sessions s
         WHERE s.user_id = u.userId AND s.country IS NOT NULL AND length(s.country) = 2 AND upper(s.country) NOT IN ('XX', 'T1')
         ORDER BY s.created DESC, s.rowid DESC LIMIT 1), '')`
    : "NULL";
  const invited = C("invited_by");
  return { chat, deleted, deleting, banned, bannedArgs, archived, seenJoin, seenCol, countryCol,
           invitedJoin: invited ? "LEFT JOIN users iu ON iu.userId = u.invited_by" : "",
           invitedCol: invited ? "iu.username" : "NULL",
           autoCol: C("auto_source") ? "u.auto_source" : "NULL",
           pwCol: C("password_set") ? "u.password_set" : "NULL",
           has: (c) => C(c) };
}

/** A filter key -> its WHERE clause (+ args). */
function filterWhere(P, filter) {
  switch (filter) {
    case "website": return { sql: `NOT (${P.chat}) AND NOT (${P.deleted})`, args: [] };
    case "chat": return { sql: `(${P.chat}) AND NOT (${P.deleted})`, args: [] };
    case "banned": return { sql: P.banned, args: P.bannedArgs };
    case "deleted": return { sql: `(${P.deleted})`, args: [] };
    default: return { sql: "1", args: [] };
  }
}
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** 1.99anx: the country param -> "" (any) | "none" | "CC" (2 letters, upper-cased; never XX / T1, which no member's country is). */
function countryOpt(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^none$/i.test(s)) return "none";
  return /^[A-Za-z]{2}$/.test(s) && s.toUpperCase() !== "XX" ? s.toUpperCase() : "";
}
/** The country param -> its WHERE clause (+ args); the code is bound, never written into the SQL. */
function countryWhere(P, country) {
  if (country === "none") return { sql: `${P.countryCol} IS NULL`, args: [] };
  if (country) return { sql: `${P.countryCol} = ?`, args: [country] };
  return null;
}

/** Normalised query options. */
function options(o = {}) {
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "created";
  const d = String(o.dir || "").toLowerCase();
  const dir = d === "asc" || d === "desc" ? d : SORTS[sort].def;
  const filter = FILTERS.includes(o.filter) ? o.filter : "all";
  const q = String(o.q == null ? "" : o.q).replace(/[\u0000-\u001f]/g, "").trim().replace(/^@/, "").slice(0, Q_MAX);
  const page = Math.max(1, Math.min(1e6, parseInt(o.page, 10) || 1));
  return { sort, dir, filter, q, country: countryOpt(o.country), page };
}

/** The counts at the top of the card (every account; q / filter don't change them). */
async function counts({ at = now() } = {}) {
  const H = await schema();
  if (!H.tables.has("users")) return { total: 0, website: 0, chat: 0, banned: 0, deleted: 0, new7: 0, new30: 0 };
  const P = pieces(H, at);
  const r = (await getQuery(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN NOT (${P.chat}) AND NOT (${P.deleted}) THEN 1 ELSE 0 END), 0) AS website,
      COALESCE(SUM(CASE WHEN (${P.chat}) AND NOT (${P.deleted}) THEN 1 ELSE 0 END), 0) AS chat,
      COALESCE(SUM(CASE WHEN ${P.banned} THEN 1 ELSE 0 END), 0) AS banned,
      COALESCE(SUM(CASE WHEN (${P.deleted}) THEN 1 ELSE 0 END), 0) AS deleted,
      COALESCE(SUM(CASE WHEN u.created_at >= ? THEN 1 ELSE 0 END), 0) AS new7,
      COALESCE(SUM(CASE WHEN u.created_at >= ? THEN 1 ELSE 0 END), 0) AS new30
    FROM users u`, [...P.bannedArgs, sqlTime(at - 7 * DAY), sqlTime(at - 30 * DAY)]))[0] || {};
  const n = (k) => Number(r[k]) || 0;
  return { total: n("total"), website: n("website"), chat: n("chat"), banned: n("banned"), deleted: n("deleted"), new7: n("new7"), new30: n("new30") };
}

/**
 * 1.99anx: the country picker's list - {countries: [{cc, n}] (most accounts first, then by code), no_country: n} over EVERY
 * account, like counts (q / filter / country don't change it). [] / 0 without a sessions country (countryCol is NULL for all).
 */
async function countries({ at = now() } = {}) {
  const H = await schema();
  if (!H.tables.has("users")) return { countries: [], no_country: 0 };
  const P = pieces(H, at);
  const rows = await getQuery(`SELECT cc, COUNT(*) AS n FROM (SELECT ${P.countryCol} AS cc FROM users u) GROUP BY cc`);
  let none = 0;
  const list = [];
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.cc != null && /^[A-Z]{2}$/.test(r.cc)) list.push({ cc: r.cc, n });
    else none += n;
  }
  list.sort((a, b) => b.n - a.n || (a.cc < b.cc ? -1 : a.cc > b.cc ? 1 : 0));
  return { countries: list, no_country: none };
}

/** The sign-in methods of a page of accounts: Map userId -> Set(method). */
async function methodsOf(H, rows) {
  const out = new Map(rows.map((r) => [r.userId, new Set()]));
  if (!rows.length) return out;
  const ids = rows.map((r) => r.userId);
  const qs = ids.map(() => "?").join(", ");
  const add = (id, m) => { const s = out.get(id); if (s) s.add(m); };
  for (const r of rows) {
    const pw = r.password_set;
    if (Number(pw) === 1 || ((pw === null || pw === undefined) && r.email_at && !r.is_chat)) add(r.userId, "password");
    if (String(r.twitchId || "").trim()) add(r.userId, "twitch");
    if (String(r.discordId || "").trim()) add(r.userId, "discord");
    if (String(r.camfrogUsername || "").trim()) add(r.userId, "camfrog");
  }
  if (H.tables.has("sso_links")) {
    for (const l of await getQuery(`SELECT user_id, provider FROM sso_links WHERE user_id IN (${qs})`, ids)) {
      if (l.provider === "google" || l.provider === "apple" || l.provider === "plex" || l.provider === "telegram") add(l.user_id, l.provider);
    }
  }
  if (H.tables.has("telegram_links")) for (const l of await getQuery(`SELECT user_id FROM telegram_links WHERE user_id IN (${qs})`, ids)) add(l.user_id, "telegram");
  if (H.tables.has("plex_members")) for (const l of await getQuery(`SELECT DISTINCT user_id FROM plex_members WHERE user_id IN (${qs})`, ids)) add(l.user_id, "plex");
  return out;
}

const CLASS_BADGE = { Admin: "admin", Staff: "staff", Assistant: "assistant" };
/**
 * One page of the table. -> {page, pages, per, total, sort, dir, filter, q, country, rows} (see the header). opts: options() + {at}.
 */
async function list(opts = {}) {
  const o = options(opts);
  const at = opts.at || now();
  await ensureIndexes();
  const H = await schema();
  if (!H.tables.has("users")) return { ...o, page: 1, pages: 1, per: PER, total: 0, rows: [] };
  const P = pieces(H, at);
  const where = [], args = [];
  const f = filterWhere(P, o.filter);
  where.push(f.sql); args.push(...f.args);
  if (o.q) {
    const like = "%" + likeEsc(o.q) + "%";
    const cols = ["u.username", ...(P.has("displayname") ? ["u.displayname"] : []), ...(P.has("camfrogUsername") ? ["u.camfrogUsername"] : [])];
    where.push("(" + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
    for (let i = 0; i < cols.length; i++) args.push(like);
  }
  const cw = countryWhere(P, o.country);
  if (cw) { where.push(cw.sql); args.push(...cw.args); }
  const W = where.length ? "WHERE " + where.map((w) => "(" + w + ")").join(" AND ") : "";
  const total = Number(((await getQuery(`SELECT COUNT(*) AS n FROM users u ${W}`, args))[0] || {}).n) || 0;
  const pages = Math.max(1, Math.ceil(total / PER));
  const page = Math.min(o.page, pages);
  const S = SORTS[o.sort];
  const dir = o.dir === "asc" ? "ASC" : "DESC";
  const col = S.col === "seen" ? P.seenCol : S.col;
  const order = `${S.nullsLast ? `(${col} IS NULL), ` : ""}${col} ${dir}, ${S.tie} ${dir}`;
  const rows = await getQuery(`SELECT u.userId, u.username, u.displayname, u.created_at, u.level, u.class, u.twitchId, u.discordId,
        ${P.has("camfrogUsername") ? "u.camfrogUsername" : "NULL AS camfrogUsername"}, ${P.pwCol} AS password_set, ${P.autoCol} AS auto_source,
        ${P.seenCol} AS seen, ${P.countryCol} AS country, ${P.invitedCol} AS invited_by_name,
        CASE WHEN ${P.has("email") ? "COALESCE(u.email, '') LIKE '%@%'" : "0"} THEN 1 ELSE 0 END AS email_at,
        CASE WHEN ${P.chat} THEN 1 ELSE 0 END AS is_chat,
        CASE WHEN ${P.deleted} THEN 1 ELSE 0 END AS is_deleted,
        CASE WHEN ${P.deleting} THEN 1 ELSE 0 END AS is_deleting,
        CASE WHEN ${P.banned} THEN 1 ELSE 0 END AS is_banned,
        CASE WHEN ${P.archived} THEN 1 ELSE 0 END AS is_archived,
        ${P.has("invited_by") ? "CASE WHEN u.invited_by IS NOT NULL THEN 1 ELSE 0 END" : "0"} AS is_invited
      FROM users u ${P.seenJoin} ${P.invitedJoin} ${W}
      ORDER BY ${order} LIMIT ? OFFSET ?`, [...P.bannedArgs, ...args, PER, (page - 1) * PER]);
  const M = await methodsOf(H, rows);
  return {
    ...o, page, pages, per: PER, total,
    rows: rows.map((r) => {
      const status = [];
      if (CLASS_BADGE[r.class]) status.push(CLASS_BADGE[r.class]);
      if (r.is_deleted) status.push("deleted");
      else {
        if (r.is_chat) status.push("chat");
        if (r.is_banned) status.push("banned");
        if (r.is_deleting) status.push("deleting");
        if (r.is_archived) status.push("archived");
      }
      if (r.is_invited) status.push("invited");
      const ms = M.get(r.userId) || new Set();
      return {
        username: r.username, displayname: r.displayname && r.displayname !== r.username ? r.displayname : null,
        created: createdMs(r.created_at), seen: r.seen == null ? null : Number(r.seen) || null, level: Math.max(0, Math.floor(Number(r.level) || 0)),
        country: typeof r.country === "string" && /^[A-Z]{2}$/.test(r.country) ? r.country : null,
        methods: METHODS.filter((m) => ms.has(m)),
        chat_source: r.is_chat ? (r.auto_source ? "camfrog" : String(r.twitchId || "").trim() ? "twitch" : String(r.discordId || "").trim() ? "discord" : "bot") : null,
        invited_by: r.invited_by_name || null, status, gone: !!r.is_deleted,
      };
    }),
  };
}

function register(app, { addUser }) {
  ensureIndexes();
  app.get("/api/admin/members", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      // the class in the DATABASE (a JWT's can be stale)
      const me = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!SP.can(me, CAP)) return res.status(403).json({ ok: false, error: "Admins only." });
      const at = now();
      const [page, c, cc] = await Promise.all([list({ ...req.query, at }), counts({ at }), countries({ at })]);
      res.json({ ok: true, ...page, counts: c, countries: cc.countries, no_country: cc.no_country, account_links: SP.can(me, "accounts.security") });
    } catch (e) {
      console.error("[members] list:", e);
      res.status(500).json({ ok: false, error: "Couldn't load the members - try again." });
    }
  });
}

module.exports = { register, list, counts, countries, options, createdMs, ensureIndexes, CAP, PER, SORTS, FILTERS, METHODS,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _resetSchema: () => { has.at = 0; indexed = null; },
                   // tests: the country column's SQL for this database (EXPLAIN QUERY PLAN)
                   _countryCol: async () => pieces(await schema(), now()).countryCol };
