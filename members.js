// members.js — 1.99anv: the 👥 All members table on /admin/users#members (owner, 2026-11-14: "is there somewhere I can see all
// users and sort by when users were created?").
//
//   GET /api/admin/members?page=&sort=&dir=&q=&filter=     capability accounts.members (Admin, locked: privacy)
//     page    1-based; PER (50) rows a page, paged on the server
//     sort    created (default, newest first) | seen | level | username; dir asc | desc (each sort has its own default)
//     q       part of a username, display name or Camfrog login (any case; % and _ are literal)
//     filter  all | website | chat | banned | deleted
//   -> {ok, page, pages, per, total (rows matching q + filter), sort, dir, filter, q, counts, rows}
//   counts  {total, website, chat, banned, deleted, new7, new30} over every account (q and filter don't change them)
//   rows    [{username, displayname, created (ms), seen (ms | null), level, methods: [..], invited_by, status: [..], gone}]
//
// What the columns mean
//   created     users.created_at (UTC "YYYY-MM-DD HH:MM:SS", SQLite's CURRENT_TIMESTAMP - every INSERT INTO users leaves it at that)
//   seen        the newest website activity: sessions.last_seen (every sign-in since 1.99wj, written at most every 5 minutes) or the
//               newest welcome_activity day (signed-in page views, kept 120 days) - null = no visit on record (the card says "no visit
//               recorded", not "never": a member from before sessions who hasn't been back in 120 days has none either)
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
// Indexes: users (created_at), users (level), users (username COLLATE NOCASE) - the three sorts on the users table itself; "seen" is
// one GROUP BY over sessions (its index sessions_user) and welcome_activity (its primary key).
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
const has = { tables: new Set(), cols: new Set(), at: 0 };
const SCHEMA_MS = 60 * 1000;
async function schema() {
  if (has.at && now() - has.at < SCHEMA_MS) return has;
  const tables = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  const cols = (await getQuery("SELECT name FROM pragma_table_info('users')")).map((r) => r.name);
  has.tables = new Set(tables); has.cols = new Set(cols); has.at = now();
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
  const invited = C("invited_by");
  return { chat, deleted, deleting, banned, bannedArgs, archived, seenJoin, seenCol,
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

/** Normalised query options. */
function options(o = {}) {
  const sort = Object.prototype.hasOwnProperty.call(SORTS, o.sort) ? o.sort : "created";
  const d = String(o.dir || "").toLowerCase();
  const dir = d === "asc" || d === "desc" ? d : SORTS[sort].def;
  const filter = FILTERS.includes(o.filter) ? o.filter : "all";
  const q = String(o.q == null ? "" : o.q).replace(/[\u0000-\u001f]/g, "").trim().replace(/^@/, "").slice(0, Q_MAX);
  const page = Math.max(1, Math.min(1e6, parseInt(o.page, 10) || 1));
  return { sort, dir, filter, q, page };
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
 * One page of the table. -> {page, pages, per, total, sort, dir, filter, q, rows} (see the header). opts: options() + {at}.
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
        ${P.seenCol} AS seen, ${P.invitedCol} AS invited_by_name,
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
      const [page, c] = await Promise.all([list({ ...req.query, at }), counts({ at })]);
      res.json({ ok: true, ...page, counts: c, account_links: SP.can(me, "accounts.security") });
    } catch (e) {
      console.error("[members] list:", e);
      res.status(500).json({ ok: false, error: "Couldn't load the members - try again." });
    }
  });
}

module.exports = { register, list, counts, options, createdMs, ensureIndexes, CAP, PER, SORTS, FILTERS, METHODS,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _resetSchema: () => { has.at = 0; indexed = null; } };
