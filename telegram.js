// telegram.js — the Telegram bridge, site side (1.99kn): link a PATV account to Telegram, the access tiers, and
// the alerts Pepe's Telegram bot delivers. The bot itself (polling, commands, chat with Pepe) runs inside Pepe
// (camfrog-bot telegram_bridge.py + pepe_telegram.py); its BotFather token lives in Pepe's admin panel, never here.
//
// LINKING (a proven identity, v2 §5: platform 'telegram', link_source 'self')
//   Edit profile → Connections → Telegram (or /settings/telegram) makes a ONE-TIME CODE (10 minutes, stored as a
//   SHA-256 hash only, one live code per account). The member opens t.me/<bot>?start=<code> (or sends
//   "/start <code>" to the bot). Telegram itself vouches for who sent that message (the update's from.id), so the
//   code proves "this Telegram account belongs to the PATV account that made the code". Pepe posts {code, tg_id}
//   to /api/telegram/link (bot token). Never linked by username or display name; a Telegram account already linked
//   to another PATV account is refused (unlink it there first). The account gets a 🔔 notice for every link.
//
// ACCESS (decided 2026-10-10)
//   none    no link, an archived account, or banned from the site (a global feed ban, feed_bans room_id '') -
//           the bot answers nothing but "not available"; no alerts are queued or delivered
//   alerts  any other linked account: the link + the alerts below (their own notices, nothing else)
//   full    an active Season Pass (premium.hasPass: paid, grace or comped): + Pepe's commands for PAT (an
//           allow-list, in Pepe) + chatting with Pepe
//
// ALERTS (telegram_prefs per inbox kind; telegram_outbox is the queue Pepe drains)
//   * every 🔔 notice filed in the inbox (inbox.add calls onNotice): mentions, tips, shop, Pepe's economy notices
//     (staking, loans, wagers, markets, bounties, lotto - the Monday / economy events), stage, follows / go-live,
//     whatever new kind is added later - one switch per kind. Default ON: dm, mention, tip, follow, stage and any
//     go-live kind; everything else is opt-in.
//   * direct messages (messages.js send / pepeReply call onDm): one alert per conversation per DM_GAP_MS, sent
//     DM_GRACE_MS later and dropped if it was read on the site meanwhile; quotes the message only when the member
//     allows previews (dm_prefs.alert_preview, the same switch as the Camfrog alert). Blocks are respected upstream.
//   * at most HOUR_MAX alerts per member an hour (extra ones are dropped - they're still in the inbox).
//   Texts are written in the member's site language (i18n: user_language) when queued; plain text, never HTML.
//
// Tables
//   telegram_links   user_id PK, tg_id UNIQUE, handle, link_source ('self'), proof ('start_code'), linked_at,
//                    paused (1 = the member blocked the bot: alerts wait until they talk to it again)
//   telegram_codes   code_hash PK, user_id, created, expires, used_at
//   telegram_prefs   user_id, kind, on_ (0/1)      (absent = the kind's default)
//   telegram_outbox  id, user_id, kind, text, ref (UNIQUE per user), check_ref, due_at, created, claimed_at, sent_at, tries, error
//   telegram_meta    k PK, v                        (bot_username, reported by Pepe)
//
// Routes
//   GET  /settings/telegram            the page (views/telegram.ejs)
//   GET  /api/telegram                 state for the page (same-site fetch)
//   POST /api/telegram/code            a new one-time code + deep link
//   POST /api/telegram/unlink          remove the link
//   POST /api/telegram/prefs           {on: {<kind>: true|false}}
//   POST /api/telegram/test            queue a test alert
//   bot token (body.password):
//   POST /api/telegram/hello           {bot_username}
//   POST /api/telegram/link            {code, tg_id, handle} -> {ok, username, lang, tier} | {ok:false, code}
//   POST /api/telegram/whois           {tg_id, seen} -> {linked, user:{username, display, camfrog}, tier, lang}
//   POST /api/telegram/unlink-tg       {tg_id}   (the member typed /unlink in Telegram)
//   POST /api/telegram/strings         {lang}    the "tg." strings in that language (English filled in)
//   POST /api/telegram/outbox/claim    {limit} -> {alerts: [{id, chat_id, text}]}
//   POST /api/telegram/outbox/ack      {sent: [id], failed: [{id, blocked, permanent, error}]}
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const CODE_TTL_MS = 10 * 60e3;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
const CODE_LEN = 10;
const CODE_RE = /^[A-Z2-9]{10}$/;
const CODES_PER_HOUR = 6;
const HOUR_MAX = 40;                 // alerts per member an hour
const DM_GAP_MS = 10 * 60e3;         // one DM alert per conversation per 10 minutes
const DM_GRACE_MS = 60e3;            // and only if it's still unread a minute later
const CLAIM_MAX = 50;
const RECLAIM_MS = 5 * 60e3;         // a claimed alert with no ack is handed out again after this
const MAX_TRIES = 5;
const KEEP_MS = 3 * 86400e3;
const TEXT_MAX = 3500;               // Telegram's limit is 4096
const TG_ID_RE = /^[1-9]\d{0,19}$/;
const DEFAULT_ON = new Set(["dm", "mention", "tip", "follow", "stage"]);
const isLiveKind = (k) => /live/i.test(String(k || ""));    // go-live alerts (whatever the go-live feature names its kind)

let NOW = () => Date.now();
const _setClock = (fn) => { NOW = fn || (() => Date.now()); };
const site = () => (process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS telegram_links (user_id TEXT PRIMARY KEY, tg_id TEXT NOT NULL UNIQUE, handle TEXT,
        link_source TEXT NOT NULL DEFAULT 'self', proof TEXT NOT NULL DEFAULT 'start_code', linked_at INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS telegram_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL,
        expires INTEGER NOT NULL, used_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS telegram_codes_user ON telegram_codes (user_id, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS telegram_prefs (user_id TEXT NOT NULL, kind TEXT NOT NULL, on_ INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, kind))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS telegram_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, ref TEXT NOT NULL, check_ref TEXT, due_at INTEGER NOT NULL, created INTEGER NOT NULL, claimed_at INTEGER,
        sent_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, error TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS telegram_outbox_ref ON telegram_outbox (user_id, ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS telegram_outbox_due ON telegram_outbox (sent_at, due_at)");
      await runQuery("CREATE TABLE IF NOT EXISTS telegram_meta (k TEXT PRIMARY KEY, v TEXT)");
    })().catch((e) => { console.error("[telegram] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── helpers ──
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);
const snip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + "…" : x; };
function newCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function tgId(v) {
  const s = String(v == null ? "" : v).trim();
  return TG_ID_RE.test(s) ? s : null;
}
function cleanHandle(h) {
  const s = String(h || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{3,40}$/.test(s) ? s : null;
}
async function meta(k) { await init(); const r = (await getQuery("SELECT v FROM telegram_meta WHERE k = ?", [k]))[0]; return r ? r.v : null; }
async function setMeta(k, v) { await init(); await runQuery("INSERT INTO telegram_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]); }
const botUsername = () => meta("bot_username");

function langOf(userId) {
  try { return require("./i18n").getPref(userId) || "en"; } catch (e) { return "en"; }
}
function tFor(lang) {
  try { return require("./i18n").tFor(lang || "en"); } catch (e) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e2) { en = {}; }
    return (k, v) => String(en[k] || k).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? String(v[n]) : m));
  }
}

async function account(userId) {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const pick = (c) => (cols.has(c) ? c : `NULL AS ${c}`);
  return (await getQuery(`SELECT userId, username, class, ${pick("displayname")}, ${pick("camfrogUsername")}, ${pick("archived_at")} FROM users WHERE userId = ?`,
    [String(userId || "")]))[0] || null;
}
async function siteBanned(userId) {
  try {
    return !!(await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [userId, NOW()]))[0];
  } catch (e) { return false; }        // no feed_bans table yet
}
function hasPass(userId) {
  try { return !!require("./premium").hasPass(userId); } catch (e) { return false; }
}
const CF_AUTO = /^cf[a-z0-9]{8}$/i;
/** 'none' | 'alerts' | 'full' for an account (see ACCESS above). */
async function tierOf(acc) {
  if (!acc || acc.archived_at) return "none";
  if (await siteBanned(acc.userId)) return "none";
  return hasPass(acc.userId) ? "full" : "alerts";
}

// ── linking ──
async function linkOf(userId) { await init(); return (await getQuery("SELECT * FROM telegram_links WHERE user_id = ?", [userId]))[0] || null; }
async function linkByTg(id) { await init(); return (await getQuery("SELECT * FROM telegram_links WHERE tg_id = ?", [String(id)]))[0] || null; }

/** A fresh one-time code for this account (any older unused one stops working). */
async function makeCode(userId) {
  await init();
  const acc = await account(userId);
  if (!acc || acc.archived_at) throw new Refuse(404, "No such account.");
  if ((await tierOf(acc)) === "none") throw new Refuse(403, "Telegram isn't available for this account.", "E_BANNED");
  const t = NOW();
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM telegram_codes WHERE user_id = ? AND created > ?", [userId, t - 3600e3]))[0].n;
  if (recent >= CODES_PER_HOUR) throw new Refuse(429, "Too many codes - try again in a while.", "E_RATE");
  await runQuery("UPDATE telegram_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL", [t, userId]);   // revoked (kept for the hourly count)
  runQuery("DELETE FROM telegram_codes WHERE expires < ?", [t - 86400e3]).catch(() => {});
  const code = newCode();
  await runQuery("INSERT INTO telegram_codes (code_hash, user_id, created, expires) VALUES (?, ?, ?, ?)", [sha(code), userId, t, t + CODE_TTL_MS]);
  const bot = await botUsername();
  return { code, expires: t + CODE_TTL_MS, bot, deepLink: bot ? `https://t.me/${bot}?start=${code}` : null };
}

/** Pepe: the bot got "/start <code>" from Telegram user tg_id. */
async function link({ code, tg_id, handle } = {}) {
  await init();
  const id = tgId(tg_id);
  const c = String(code || "").trim().toUpperCase();
  if (!id) throw new Refuse(400, "bad telegram id", "E_BAD");
  if (!CODE_RE.test(c)) throw new Refuse(400, "That isn't a link code.", "E_CODE_INVALID");
  const t = NOW();
  const row = (await getQuery("SELECT * FROM telegram_codes WHERE code_hash = ?", [sha(c)]))[0];
  if (!row || row.used_at) throw new Refuse(404, "That code doesn't work - make a new one on publicaccess.tv.", "E_CODE_INVALID");
  if (row.expires < t) throw new Refuse(410, "That code has expired - make a new one on publicaccess.tv.", "E_CODE_EXPIRED");
  const used = await runQuery("UPDATE telegram_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL", [t, row.code_hash]);
  if (!used || !used.changes) throw new Refuse(404, "That code doesn't work - make a new one on publicaccess.tv.", "E_CODE_INVALID");
  const acc = await account(row.user_id);
  const tier = await tierOf(acc);
  if (tier === "none") throw new Refuse(403, "Telegram isn't available for this account.", "E_BANNED");
  const other = await linkByTg(id);
  if (other && other.user_id !== acc.userId) throw new Refuse(409, "This Telegram account is linked to another PATV account - unlink it there first.", "E_TG_TAKEN");
  const h = cleanHandle(handle);
  await runQuery(`INSERT INTO telegram_links (user_id, tg_id, handle, link_source, proof, linked_at, paused) VALUES (?, ?, ?, 'self', 'start_code', ?, 0)
                  ON CONFLICT(user_id) DO UPDATE SET tg_id = excluded.tg_id, handle = excluded.handle, link_source = 'self', proof = 'start_code',
                  linked_at = excluded.linked_at, paused = 0`, [acc.userId, id, h, t]);
  // a security notice for every link (the inbox, not Telegram: "not you? unlink it")
  try {
    await require("./inbox").addSafe(acc.userId, { kind: "system", title: tFor(langOf(acc.userId))("tg.notice.linked_title"),
      body: tFor(langOf(acc.userId))("tg.notice.linked_body", { handle: h ? "@" + h : "#" + id.slice(-4) }), link: "/settings/telegram", ref: `tglink:${id}:${t}` });
  } catch (e) { /* logged there */ }
  console.log(`[telegram] linked ${acc.username} (tier ${tier})`);
  return { username: acc.username, lang: langOf(acc.userId), tier };
}

async function unlink(userId) {
  await init();
  const r = await runQuery("DELETE FROM telegram_links WHERE user_id = ?", [userId]);
  await runQuery("DELETE FROM telegram_outbox WHERE user_id = ? AND sent_at IS NULL", [userId]);
  return !!(r && r.changes);
}
async function unlinkTg(id) {
  const l = await linkByTg(id);
  return l ? unlink(l.user_id) : false;
}

/** Pepe: who is this Telegram user? Only what the bridge needs - never an email, never an IP. */
async function whois({ tg_id, seen } = {}) {
  await init();
  const id = tgId(tg_id);
  if (!id) throw new Refuse(400, "bad telegram id", "E_BAD");
  const l = await linkByTg(id);
  if (!l) return { linked: false };
  const acc = await account(l.user_id);
  const tier = await tierOf(acc);
  if (seen && l.paused) await runQuery("UPDATE telegram_links SET paused = 0 WHERE user_id = ?", [l.user_id]);
  if (!acc || tier === "none") return { linked: true, tier: "none", lang: acc ? langOf(acc.userId) : "en" };
  let disp = acc.displayname || "";
  try { disp = require("./displaynames").usable(acc.displayname) || ""; } catch (e) { /* plain */ }
  const cf = acc.camfrogUsername && !CF_AUTO.test(acc.username) ? String(acc.camfrogUsername).toLowerCase() : null;
  return { linked: true, tier, lang: langOf(acc.userId),
           user: { username: acc.username, display: snip(disp || acc.username, 40), camfrog: cf } };
}

// ── preferences ──
function kinds() {
  let list = [];
  try { list = require("./inbox").kindList(); } catch (e) { list = []; }
  return list.filter((k) => k.key !== "admin");
}
const defaultOn = (kind) => DEFAULT_ON.has(kind) || isLiveKind(kind);
async function prefs(userId) {
  await init();
  const rows = await getQuery("SELECT kind, on_ FROM telegram_prefs WHERE user_id = ?", [userId]);
  const set = new Map(rows.map((r) => [r.kind, !!r.on_]));
  return kinds().map((k) => ({ key: k.key, icon: k.icon, label: k.label, on: set.has(k.key) ? set.get(k.key) : defaultOn(k.key) }));
}
async function wants(userId, kind) {
  await init();
  const r = (await getQuery("SELECT on_ FROM telegram_prefs WHERE user_id = ? AND kind = ?", [userId, kind]))[0];
  return r ? !!r.on_ : defaultOn(kind);
}
async function setPrefs(userId, on) {
  await init();
  const known = new Set(kinds().map((k) => k.key));
  for (const k of Object.keys(on || {})) {
    if (!known.has(k)) continue;
    await runQuery(`INSERT INTO telegram_prefs (user_id, kind, on_) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET on_ = excluded.on_`,
      [userId, k, on[k] ? 1 : 0]);
  }
  return prefs(userId);
}

// ── the queue ──
/** Queue one alert. -> true if queued. Never throws. */
async function queue(userId, { kind, text, ref, dueAt, check } = {}) {
  try {
    await init();
    const l = await linkOf(userId);
    if (!l) return false;
    const acc = await account(userId);
    if ((await tierOf(acc)) === "none") return false;
    if (kind !== "test" && !(await wants(userId, kind))) return false;
    const t = NOW();
    const hour = (await getQuery("SELECT COUNT(*) AS n FROM telegram_outbox WHERE user_id = ? AND created > ?", [userId, t - 3600e3]))[0].n;
    if (hour >= HOUR_MAX) return false;
    const body = clean(text, TEXT_MAX);
    if (!body) return false;
    const r = await runQuery(`INSERT OR IGNORE INTO telegram_outbox (user_id, kind, text, ref, check_ref, due_at, created) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, String(kind || "system").slice(0, 32), body, String(ref || `x:${t}:${Math.random()}`).slice(0, 160), check || null, Math.max(t, Number(dueAt) || t), t]);
    if (Math.random() < 0.02) runQuery("DELETE FROM telegram_outbox WHERE created < ?", [t - KEEP_MS]).catch(() => {});
    return !!(r && r.changes);
  } catch (e) {
    console.error("[telegram] queue:", e.message);
    return false;
  }
}

/** inbox.add -> here, for a notice it just stored (fire and forget). */
function onNotice(userId, n) {
  if (!userId || !n) return;
  (async () => {
    if (!(await linkOf(userId))) return;
    const icon = (() => { try { return (require("./inbox").KINDS[n.kind] || {}).icon || "🔔"; } catch (e) { return "🔔"; } })();
    const lines = [`${icon} ${snip(n.title, 200)}`];
    if (n.body) lines.push(snip(n.body, 900));
    if (n.link) lines.push(site() + n.link);
    await queue(userId, { kind: n.kind, text: lines.join("\n"), ref: "n:" + (n.ref || `${n.kind}:${n.created}:${sha(n.title).slice(0, 12)}`) });
  })().catch((e) => console.error("[telegram] notice:", e.message));
}

/** messages.js -> here, for a new direct message to `userId` (fire and forget). {conversationId, messageId, from, text, group, pics} */
function onDm(userId, m) {
  if (!userId || !m || !m.conversationId) return;
  (async () => {
    if (!(await linkOf(userId))) return;
    let preview = true;
    try { preview = (await require("./messages").prefs(userId)).preview; } catch (e) { preview = true; }
    const t = tFor(langOf(userId));
    const who = snip(m.from || "someone", 40);
    const head = m.group ? t("tg.alert.dm_group", { who, group: snip(m.group, 40) }) : t("tg.alert.dm", { who });
    const lines = [`💬 ${head}`];
    if (preview && m.text) lines.push(`“${snip(m.text, 300)}”`);
    else if (preview && m.pics) lines.push(t("tg.alert.dm_photo"));
    lines.push(`${site()}/messages`);
    const tNow = NOW();
    await queue(userId, { kind: "dm", text: lines.join("\n"), ref: `dm:${m.conversationId}:${Math.floor(tNow / DM_GAP_MS)}`,
                          dueAt: tNow + DM_GRACE_MS, check: m.messageId ? `dm:${m.conversationId}:${m.messageId}` : null });
  })().catch((e) => console.error("[telegram] dm:", e.message));
}

/** Read on the site since it was queued? (a DM alert's check_ref "dm:<conversation>:<message id>") */
async function stale(userId, check) {
  const m = /^dm:(.+):(\d+)$/.exec(String(check || ""));
  if (!m) return false;
  try {
    const r = (await getQuery("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [m[1], userId]))[0];
    return !!r && Number(r.last_read_id) >= Number(m[2]);
  } catch (e) { return false; }
}

/** Pepe: due alerts, claimed. -> [{id, chat_id, text}] */
async function claim({ limit = CLAIM_MAX } = {}) {
  await init();
  const t = NOW();
  const rows = await getQuery(`SELECT o.*, l.tg_id, l.paused FROM telegram_outbox o LEFT JOIN telegram_links l ON l.user_id = o.user_id
                               WHERE o.sent_at IS NULL AND o.due_at <= ? AND (o.claimed_at IS NULL OR o.claimed_at < ?) ORDER BY o.id LIMIT ?`,
                              [t, t - RECLAIM_MS, Math.max(1, Math.min(CLAIM_MAX, Number(limit) || CLAIM_MAX))]);
  const out = [];
  for (const r of rows) {
    const drop = (why) => runQuery("UPDATE telegram_outbox SET sent_at = ?, error = ? WHERE id = ?", [t, why, r.id]);
    if (!r.tg_id) { await drop("unlinked"); continue; }
    if (r.paused) continue;                                   // waits until they talk to the bot again
    if (r.tries >= MAX_TRIES) { await drop("gave up"); continue; }
    if (r.check_ref && (await stale(r.user_id, r.check_ref))) { await drop("read on the site"); continue; }
    if ((await tierOf(await account(r.user_id))) === "none") { await drop("no access"); continue; }
    const c = await runQuery("UPDATE telegram_outbox SET claimed_at = ?, tries = tries + 1 WHERE id = ? AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)",
      [t, r.id, t - RECLAIM_MS]);
    if (!c || !c.changes) continue;
    out.push({ id: r.id, chat_id: r.tg_id, text: r.text, kind: r.kind });
  }
  return out;
}

/** Pepe: what happened to them. failed: [{id, blocked, permanent, error}] */
async function ack({ sent = [], failed = [] } = {}) {
  await init();
  const t = NOW();
  let n = 0;
  for (const id of (Array.isArray(sent) ? sent : []).slice(0, 200)) {
    const r = await runQuery("UPDATE telegram_outbox SET sent_at = ? WHERE id = ? AND sent_at IS NULL", [t, parseInt(id, 10) || 0]);
    n += (r && r.changes) || 0;
  }
  for (const f of (Array.isArray(failed) ? failed : []).slice(0, 200)) {
    const id = parseInt(f && f.id, 10) || 0;
    const row = (await getQuery("SELECT user_id FROM telegram_outbox WHERE id = ?", [id]))[0];
    if (!row) continue;
    if (f.blocked) {
      // they blocked the bot: hold their alerts (this one included) until they write to it again
      await runQuery("UPDATE telegram_links SET paused = 1 WHERE user_id = ?", [row.user_id]);
      await runQuery("UPDATE telegram_outbox SET claimed_at = NULL WHERE id = ?", [id]);
    } else if (f.permanent) {
      await runQuery("UPDATE telegram_outbox SET sent_at = ?, error = ? WHERE id = ?", [t, clean(f.error, 120) || "failed", id]);
    } else {
      await runQuery("UPDATE telegram_outbox SET claimed_at = NULL, error = ? WHERE id = ?", [clean(f.error, 120) || "retry", id]);
    }
  }
  return n;
}

/** The "tg." strings in `lang` (English filled in) - Pepe's Telegram texts, translated by the site's i18n sync. */
function strings(lang) {
  try {
    const I = require("./i18n");
    const code = I.match(lang) || "en";
    return { lang: code, s: I.clientStrings(code, ["tg."]) };
  } catch (e) { return { lang: "en", s: {} }; }
}

/** Everything the settings page shows. */
async function state(userId) {
  await init();
  const l = await linkOf(userId);
  const acc = await account(userId);
  const tier = await tierOf(acc);
  return { linked: !!l, handle: l && l.handle ? l.handle : null, linkedAt: l ? l.linked_at : null, paused: !!(l && l.paused),
           tier, pass: tier === "full", available: tier !== "none", bot: await botUsername(), prefs: await prefs(userId),
           camfrog: !!(acc && acc.camfrogUsername && !CF_AUTO.test(acc.username)), hourMax: HOUR_MAX };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch(() => {});
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (write) => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (write && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const bot = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.refuse ? e.status : 500;
    if (st === 500) console.error("[telegram]", e && e.message);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message, code: (e && e.code) || undefined });
  };

  app.get("/settings/telegram", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/telegram"));
    try {
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("telegram", { title: "Telegram", user: req.user.username, boot: await state(req.user.userId) });
    } catch (e) {
      console.error("[telegram] page:", e.message);
      res.status(500).send("Couldn't load your Telegram settings.");
    }
  });
  app.get("/api/telegram", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, ...(await state(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/code", addUser, guard(true), async (req, res) => {
    try { res.json({ ok: true, ...(await makeCode(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/unlink", addUser, guard(true), async (req, res) => {
    try { await unlink(req.user.userId); res.json({ ok: true, ...(await state(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/prefs", addUser, guard(true), async (req, res) => {
    const on = req.body && req.body.on;
    if (!on || typeof on !== "object" || Array.isArray(on)) return res.status(400).json({ ok: false, error: "Nothing to save." });
    try { await setPrefs(req.user.userId, on); res.json({ ok: true, ...(await state(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/test", addUser, guard(true), async (req, res) => {
    try {
      if (!(await linkOf(req.user.userId))) throw new Refuse(400, "Link Telegram first.");
      const t = tFor(langOf(req.user.userId));
      const ok = await queue(req.user.userId, { kind: "test", text: "✅ " + t("tg.alert.test"), ref: `test:${Math.floor(NOW() / 60e3)}` });
      res.json({ ok: true, queued: ok });
    } catch (e) { fail(res, e); }
  });

  // Pepe (bot token)
  app.post("/api/telegram/hello", bot, async (req, res) => {
    const h = cleanHandle((req.body || {}).bot_username);
    if (!h) return res.status(400).json({ ok: false, error: "bad bot username" });
    try { await setMeta("bot_username", h); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/link", bot, async (req, res) => {
    try { res.json({ ok: true, ...(await link(req.body || {})) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/whois", bot, async (req, res) => {
    try { res.json({ ok: true, ...(await whois(req.body || {})) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/unlink-tg", bot, async (req, res) => {
    const id = tgId((req.body || {}).tg_id);
    if (!id) return res.status(400).json({ ok: false, error: "bad telegram id" });
    try { res.json({ ok: true, removed: await unlinkTg(id) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/strings", bot, (req, res) => {
    res.json({ ok: true, ...strings((req.body || {}).lang) });
  });
  app.post("/api/telegram/outbox/claim", bot, async (req, res) => {
    try { res.json({ ok: true, alerts: await claim({ limit: (req.body || {}).limit }) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/telegram/outbox/ack", bot, async (req, res) => {
    try { res.json({ ok: true, acked: await ack(req.body || {}) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, makeCode, link, unlink, unlinkTg, whois, tierOf, prefs, setPrefs, wants, queue, onNotice, onDm, claim, ack,
                   strings, state, linkOf, linkByTg, botUsername, setMeta, newCode, Refuse, DEFAULT_ON, HOUR_MAX, DM_GAP_MS, DM_GRACE_MS,
                   CODE_TTL_MS, _setClock };
