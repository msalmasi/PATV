// accountexport.js — "Download my data" (Settings → Account → Your data), 1.99wj.
//
// A member asks for a copy of what PATV keeps about them: a zip with one JSON file (patv-data.json) + a README. It is
// built in the background (a job row; the 10-minute tick picks up anything a restart interrupted), the member gets an
// inbox notice when it is ready, and the download works for EXPORT_TTL_MS (7 days) - signed in as the same account
// only, never a bearer link. At most one export a day (RATE_MS).
//
// What is in it (SECTIONS below - every table is optional, a missing one is skipped): the profile, connections (ids and
// names, never a token or a signature), the wallet and its transactions, holdings (stashes the chat login owns or is a
// member of, escrow holds, market orders, lotto tickets, waiting chat rewards, heist market listings), posts / comments /
// votes / tips / stories, the DMs they SENT (their side of each conversation they are in), notices, achievements,
// cosmetics, purchases and orders, subscriptions, likeness settings and earnings, their sign-in sessions, and the chat
// data PATV keeps keyed to their account or Camfrog login (chat statistics, room participation, clips they made or that
// are of them - as records; the clip files themselves are not in the zip).
//
// What is never in it: secrets (OMIT: passwords, tokens, hashes, stream / restream keys, signatures, nonces, payment
// processor customer / subscription ids) and other people's private data - the DMs other people sent, a buyer's
// delivery details on an order where this account is the seller, who paid to use their likeness, who subscribes to
// them as a creator (counts only), reports others filed about them.
//
//   account_exports   id PK, user_id, created, state queued|running|ready|failed|expired, file, bytes, finished, error, expires
//
// Routes: GET /api/account/export (the member's exports), POST /api/account/export (same-origin fetch; 429 + `retry_at`
// once a day), GET /settings/account/export/:id (the download).
//
// 1.99acm - the chat hub's part (the R-12 privacy seam, §9.4; switch hubseam.export, off): while it is on and a hub is
// configured (HUB_V1_URL), the zip also carries chat-hub.jsonl - what the chat hub keeps about the account (its chat lines,
// privacy flags and requests, chat sessions without secrets, account cutoffs, pads owned there), fetched with a signed
// GET /internal/v1/privacy/export/acct/<the hub's account id>?ref=<this export's id> (huboutbox.getSigned: streamed to a 0600
// temp file, 64 MB / 60 s caps). The answer must end with its {"t":"end","complete":true} line (a truncated one is refused).
// The export never ships without that part while the switch is on (seam plan D-25): when the hub can't answer, the job goes
// back to 'queued' with hub_wait_since (the first failure) and hub_error (a code), the 10-minute tick retries it, the member
// keeps seeing "being prepared", and after 24 h ops is told (a console error once, /admin/keys#seam). The hub part is asked
// FIRST: the account is gathered only once it arrived (or isn't needed), never on every retry of a waiting job. An account with no hub
// account id (a legacy id while CHAT_GENESIS_NS is unset) exports without it, and the README says so.
//   account_exports  + hub_wait_since, hub_error
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 86400000;
const RATE_MS = DAY;
const EXPORT_TTL_MS = 7 * DAY;
const MAX_ROWS = 50000;            // per table
const TICK_MS = 10 * 60000;

let clock = () => Date.now();
const now = () => clock();
const dir = () => process.env.ACCOUNT_EXPORT_DIR || path.join(process.cwd(), "account-exports");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS account_exports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', file TEXT, bytes INTEGER,
        finished INTEGER, error TEXT, expires INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS account_exports_user ON account_exports (user_id, created)");
      const have = (await getQuery("SELECT name FROM pragma_table_info('account_exports')")).map((c) => c.name);   // 1.99acm
      if (!have.includes("hub_wait_since")) await runQuery("ALTER TABLE account_exports ADD COLUMN hub_wait_since INTEGER");
      if (!have.includes("hub_error")) await runQuery("ALTER TABLE account_exports ADD COLUMN hub_error TEXT");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── never exported ──
const OMIT = /password|token|secret|signature|nonce|_hash$|^hash$|hash_|key_enc|streamkey|stream_key|^key_hash$|stripe_sub|stripe_customer|session_hash|code_hash|resetpassword|emailverification|^sha$/i;

const tableCols = new Map();
async function colsOf(t) {
  if (!tableCols.has(t)) tableCols.set(t, (await getQuery(`SELECT name FROM pragma_table_info('${t.replace(/'/g, "")}')`)).map((r) => r.name));
  return tableCols.get(t);
}
async function rows(table, where, params, { omit = [], order = null } = {}) {
  const cols = await colsOf(table);
  if (!cols.length) return null;                                     // no such table here
  for (const c of (where.match(/\b[a-z_][a-z0-9_]*(?=\s*(=|IN|LIKE))/gi) || [])) if (!cols.includes(c)) return null;
  const keep = cols.filter((c) => !OMIT.test(c) && !omit.includes(c));
  const sql = `SELECT ${keep.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE ${where}${order && cols.includes(order) ? ` ORDER BY "${order}"` : ""} LIMIT ${MAX_ROWS}`;
  return getQuery(sql, params);
}

/** Everything for one account. -> plain object (the JSON in the zip). */
let collects = 0;                 // tests: how often the whole account was gathered
async function collect(userId, { at = now() } = {}) {
  collects++;
  tableCols.clear();
  const uid = String(userId);
  const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [uid]))[0];
  if (!u) throw new Error("no such account");
  const login = String(u.camfrogUsername || "").trim().toLowerCase() || null;
  const out = { exported_at: new Date(at).toISOString(), format: "patv-data-1", about: "PAT is points, not money. Ids are PATV's internal ids.",
                account: {} };
  const put = async (section, name, p) => {
    try {
      const r = await p;
      if (r === null || r === undefined) return;
      (out[section] = out[section] || {})[name] = r;
    } catch (e) { (out.errors = out.errors || []).push(`${section}.${name}: ${e.message}`); }
  };
  // profile
  const profile = {};
  for (const [k, v] of Object.entries(u)) if (!OMIT.test(k)) profile[k] = v;
  out.account.profile = profile;
  await put("account", "roles", rows("user_roles", "userId = ?", [uid]));
  await put("account", "username_history", rows("username_history", "userId = ?", [uid]));
  await put("account", "displayname_history", rows("displayname_log", "userId = ?", [uid], { omit: ["actor"] }));
  await put("account", "language", rows("user_language", "userId = ?", [uid]));
  await put("account", "time_zone", rows("user_timezone", "userId = ?", [uid]));
  await put("account", "profile_layout", rows("profile_layout", "user_id = ?", [uid]));
  await put("account", "terms", Promise.resolve({ version: u.terms_accepted_version || null, at: u.terms_accepted_at || null }));
  // connections (ids and names - never tokens)
  out.connections = { twitch: u.twitchId ? { id: u.twitchId, name: u.twitchDisplayname, login: u.twitchLogin || null } : null,
                      discord: u.discordId ? { id: u.discordId, name: u.discordUsername } : null, camfrog: login };
  await put("connections", "sign_in_links", rows("sso_links", "user_id = ?", [uid]));
  await put("connections", "telegram", rows("telegram_links", "user_id = ?", [uid]));
  await put("connections", "plex", rows("plex_members", "user_id = ?", [uid], { omit: ["share_id", "email_hash"] }));
  await put("connections", "crypto_wallets", rows("crypto_wallets", "user_id = ?", [uid], { omit: ["message"] }));
  await put("connections", "media_request_account", rows("media_user_links", "user_id = ?", [uid], { omit: ["set_by"] }));
  // wallet (PAT is points)
  out.wallet = { balance: Number(u.points_balance) || 0 };
  await put("wallet", "transactions", rows("transactions", "userId = ?", [uid], { order: "timestamp" }));
  await put("wallet", "bonus_wins", rows("bonus_winners", "userId = ?", [uid]));
  await put("wallet", "wheel_spins", rows("wheel_spins", "userId = ?", [uid]));
  await put("wallet", "level_up_rewards", rows("levelup_rewards", "userId = ?", [uid]));
  await put("wallet", "welcome_bonus", rows("welcome_bonus", "userId = ?", [uid], { omit: ["dup_of"] }));
  // holdings
  // 1.99wy: stashes are held by the account ("u:<userId>"); a row its login still holds (not re-keyed yet) too
  {
    const ks = [`u:${uid}`].concat(login ? [String(login).toLowerCase()] : []);
    const IN = `(${ks.map(() => "?").join(",")})`;
    await put("holdings", "stashes_owned", rows("stashes", `lower(owner) IN ${IN}`, ks.map((k) => k.toLowerCase())));
    await put("holdings", "stash_memberships", rows("stash_members", `lower(login) IN ${IN}`, ks.map((k) => k.toLowerCase())));
  }
  await put("holdings", "stash_moves", rows("stash_moves", "user_id = ?", [uid]));
  await put("holdings", "escrow_holds", rows("escrow_holds", "user_id = ?", [uid], { omit: ["cp"] }));
  await put("holdings", "market_orders", rows("market_orders", "user_id = ?", [uid]));
  await put("holdings", "lotto_tickets", rows("lotto_tickets", "userId = ?", [uid]));
  await put("holdings", "chat_rewards_waiting", rows("auto_escrow", "user_id = ?", [uid]));
  await put("holdings", "bounty_actions", rows("bounty_actions", "user_id = ?", [uid]));
  await put("holdings", "website_game_actions", rows("pepe_actions", "user_id = ?", [uid]));
  await put("holdings", "heist_market_listings", rows("heist_market_listings", "seller_id = ? OR buyer_id = ?", [uid, uid], { omit: ["buyer_login", "seller_login", "holder_login"] }));
  await put("holdings", "gang", rows("gang_members", "userId = ?", [uid]));
  // posts and comments
  await put("posts", "posts", rows("feed_posts", "author_id = ?", [uid], { order: "created" }));
  await put("posts", "comments", rows("feed_comments", "author_id = ?", [uid], { order: "created" }));
  await put("posts", "attachments", rows("feed_attachments", "owner_id = ?", [uid], { omit: ["file", "thumb", "poster"] }));
  await put("posts", "votes", rows("feed_votes", "user_id = ?", [uid]));
  await put("posts", "comment_votes", rows("feed_comment_votes", "user_id = ?", [uid]));
  await put("posts", "tips_sent", rows("post_tips", "sender_id = ?", [uid]));
  await put("posts", "tips_received", rows("post_tips", "recipient_id = ?", [uid], { omit: ["sender_id", "note"] }));
  await put("posts", "stories", rows("story_posts", "author_id = ? OR posted_by = ?", [uid, uid]));
  await put("posts", "follows", rows("follows", "follower = ?", [uid]));
  // messages: their side only
  const convs = await getQuery("SELECT conversation_id FROM conversation_members WHERE user_id = ?", [uid]).catch(() => []);
  if (convs.length !== undefined) {
    const list = [];
    for (const c of convs.slice(0, 5000)) {
      const meta = (await getQuery("SELECT id, kind, title, created_at FROM conversations WHERE id = ?", [c.conversation_id]).catch(() => []))[0] || { id: c.conversation_id };
      const sent = await getQuery("SELECT id, body, kind, created_at, edited_at, deleted_at FROM messages WHERE conversation_id = ? AND sender_id = ? ORDER BY id LIMIT ?",
                                  [c.conversation_id, uid, MAX_ROWS]).catch(() => []);
      list.push({ conversation: meta, messages_you_sent: sent });
    }
    out.messages = { note: "The messages you sent, in each conversation you are part of. Messages other people sent are theirs and are not included.", conversations: list };
  }
  await put("messages", "settings", rows("dm_prefs", "user_id = ?", [uid]));
  await put("messages", "your_blocks", rows("dm_blocks", "blocker_id = ?", [uid]));
  // notices + preferences
  await put("notices", "inbox", rows("inbox", "user_id = ?", [uid], { order: "created" }));
  await put("notices", "inbox_settings", rows("inbox_prefs", "user_id = ?", [uid]));
  await put("notices", "mention_settings", rows("mention_prefs", "user_id = ?", [uid]));
  await put("notices", "mention_words", rows("mention_words", "user_id = ?", [uid]));
  await put("notices", "go_live_alerts", rows("golive_prefs", "user_id = ?", [uid]));
  await put("notices", "telegram_alerts", rows("telegram_prefs", "user_id = ?", [uid]));
  // 1.99acd: the browsers with notifications on (webpush.js) - the push service's host, never the endpoint's path or the keys
  await put("notices", "browser_notifications", require("./webpush").exportFor(uid));
  // achievements + cosmetics
  await put("achievements", "badges", rows("user_badges", "userId = ?", [uid]));
  await put("achievements", "feed", rows("achievement_feed", "userId = ?", [uid]));
  await put("achievements", "marks", rows("ach_marks", "userId = ?", [uid]));
  await put("achievements", "streak_days", rows("activity_days", "userId = ?", [uid]));   // 1.99xi: 🔥 the days your streak is made of
  await put("achievements", "casino_counts", rows("casino_ach_counts", "userId = ?", [uid]));
  await put("cosmetics", "items", rows("user_cosmetics", "user_id = ?", [uid]));
  await put("cosmetics", "equipped", rows("user_cosmetic_equips", "user_id = ?", [uid]));
  await put("cosmetics", "sticker_packs", rows("user_sticker_packs", "user_id = ?", [uid]));
  await put("cosmetics", "soundboard_items", rows("sb_owned", "user_id = ?", [uid]));
  await put("cosmetics", "voices_owned", rows("voice_owned", "user_id = ?", [uid]));
  await put("cosmetics", "listings", rows("cosmetic_listings", "seller_id = ?", [uid]));
  // purchases and orders: a buyer's delivery details only on their OWN orders
  await put("purchases", "orders_you_bought", rows("shop_orders", "buyer_id = ?", [uid]));
  await put("purchases", "orders_you_sold", rows("shop_orders", "seller_id = ? AND (buyer_id IS NULL OR buyer_id != ?)", [uid, uid], { omit: ["buyer_input", "gift_note", "buyer_id", "gift_from"] }));
  await put("purchases", "premium_payments", rows("premium_ledger", "payer_id = ?", [uid]));
  await put("purchases", "banner_bookings", rows("banner_bookings", "user_id = ?", [uid]));
  await put("purchases", "media_requests", rows("media_requests", "user_id = ?", [uid]));
  await put("purchases", "gifts_given", rows("gift_log", "giver_id = ?", [uid]));
  await put("purchases", "gifts_received", rows("gift_log", "recipient_id = ? AND (anon IS NULL OR anon = 0)", [uid]));
  await put("purchases", "donations", rows("donation_usd_log", "user_id = ?", [uid], { omit: ["session"] }));
  await put("purchases", "crypto_donations", rows("crypto_payments", "user_id = ?", [uid]));
  await put("purchases", "stage_slots", rows("stage_slots", "userId = ?", [uid], { omit: ["stream"] }));
  await put("purchases", "redemptions", rows("user_redemptions", "userId = ?", [uid]));
  // subscriptions
  await put("subscriptions", "season_pass_and_prime_time", rows("premium_subs", "target = ? OR renewer_id = ?", [uid, uid], { omit: ["stripe_user", "comp_by"] }));
  await put("subscriptions", "store_subscriptions", rows("shop_subs", "user_id = ?", [uid]));
  await put("subscriptions", "creators_you_follow", rows("creator_subs", "fan_id = ?", [uid]));
  await put("subscriptions", "creator_unlocks", rows("creator_unlocks", "fan_id = ?", [uid]));
  try {
    const n = await getQuery("SELECT tier, status, COUNT(*) AS subscribers FROM creator_subs WHERE creator_id = ? GROUP BY tier, status", [uid]);
    if (n.length) (out.subscriptions = out.subscriptions || {}).your_subscribers_counts = n;
  } catch (e) { /* no creators */ }
  await put("subscriptions", "creator_profile", rows("creators", "user_id = ?", [uid], { omit: ["paused_by", "note"] }));
  await put("subscriptions", "creator_earnings", rows("creator_ledger", "creator_id = ?", [uid], { omit: ["fan_id"] }));
  // likeness
  await put("likeness", "settings", rows("likeness_prefs", "user_id = ?", [uid]));
  await put("likeness", "earnings", rows("likeness_ledger", "subject_user_id = ?", [uid], { omit: ["payer_user_id", "payer_login"] }));
  await put("likeness", "voice_consents", rows("voice_consents", "user_id = ?", [uid], { omit: ["audio", "reviewed_by", "revoked_by"] }));
  // sessions + security logs
  await put("security", "sessions", rows("sessions", "user_id = ?", [uid], { omit: ["id", "device_key", "legacy_key"] }));
  await put("security", "chat_sign_ins", rows("chat_signin_log", "user_id = ?", [uid]));
  await put("security", "incognito_log", rows("incognito_log", "user_id = ?", [uid]));
  // chat data keyed to the account or the Camfrog login
  if (login) {
    try {
      const r = (await getQuery("SELECT data, updated FROM camfrog_userstats WHERE login = ?", [login]))[0];
      if (r) (out.chat = out.chat || {}).statistics = { data: JSON.parse(r.data || "{}"), updated: r.updated };
    } catch (e) { /* none */ }
    await put("chat", "room_participation", rows("econ_participation", "login = ?", [login]));
    await put("chat", "clips_of_you", rows("media", "lower(subject_login) = ?", [login], { omit: ["file"] }));
    await put("chat", "incognito", rows("incognito_state", "login = ?", [login]));
  }
  await put("chat", "clips_you_made", rows("media", "by_user_id = ?", [uid], { omit: ["file"] }));
  await put("chat", "stage_captures", rows("stage_captures", "user_id = ?", [uid]));
  await put("chat", "commands_from_the_website", rows("bridge_cmd_log", "user_id = ?", [uid]));
  // pads they own
  await put("pads", "owned", rows("rooms_registry", "owner_user_id = ?", [uid]));
  await put("pads", "memberships", rows("pad_members", "user_id = ?", [uid], { omit: ["decided_by", "note"] }));
  return out;
}

// ── a minimal zip (deflate) - no dependency; Node 16 has no zlib.crc32 ──
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(files, at = new Date()) {
  const parts = [], central = [];
  let offset = 0;
  const dosTime = ((at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()) & 0xffff;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

const README = `Your PATV data
==============

patv-data.json is everything PATV keeps about your account, as of the time in "exported_at".

- PAT is points, not money.
- Ids (userId, post ids, conversation ids...) are PATV's internal ids.
- "messages" has the messages YOU sent in each conversation you are part of. Other people's messages are theirs.
- Never included: your password, sign-in tokens, stream keys, payment processor ids, and other people's private data.
- Clip files are not in the zip; their records are (chat.clips_you_made, chat.clips_of_you).

Questions or a correction: publicaccess.tv/privacy
`;
// 1.99acm: the chat hub's part (or why it is missing)
const README_HUB = `
chat-hub.jsonl is what PATV's chat hub keeps about your account: one JSON object per line - your chat messages there, your
privacy settings and requests, your chat sign-ins (never a secret), and the pads you own there. Its last line says it is
complete.
`;
const README_NO_HUB = `
Your account has no chat hub id yet, so chat-hub.jsonl isn't included. Ask us at publicaccess.tv/privacy if you need it.
`;
const HUB_WAIT_ALERT_MS = DAY;
const HUB_MAX_BYTES = 64 << 20;

/** 1.99acm: the hub part. -> {skip: true} (switch off / no hub), {none: true} (no hub account id), {data: Buffer} or
 *  {wait: code}. */
async function hubPart(job) {
  const ho = require("./huboutbox");
  if (!ho.on("export") || !String(process.env.HUB_V1_URL || "").trim()) return { skip: true };
  const acct = ho.accountOf(job.user_id);
  if (!acct) return { none: true };
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = path.join(dir(), `.${job.id}.hub-${process.pid}-${Date.now()}.jsonl`);
  const r = await ho.getSigned(`/internal/v1/privacy/export/acct/${encodeURIComponent(acct)}?ref=${encodeURIComponent(job.id)}`,
                               { toFile: tmp, maxBytes: HUB_MAX_BYTES, timeoutMs: 60000 });
  if (!r.ok) return { wait: r.error || ("http_" + r.status) };
  try {
    const data = fs.readFileSync(tmp);
    const lines = data.toString("utf8").split("\n").filter((l) => l.trim());
    let end = null;
    try { end = JSON.parse(lines[lines.length - 1]); } catch (e) { end = null; }
    if (!end || end.t !== "end" || end.complete !== true) return { wait: "truncated" };
    return { data };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
  }
}

/** For /admin/keys#seam: exports waiting for the chat hub. -> {waiting, oldest_since, overdue} */
async function hubWaits() {
  await init();
  const r = (await getQuery("SELECT COUNT(*) AS n, MIN(hub_wait_since) AS oldest FROM account_exports WHERE state = 'queued' AND hub_wait_since IS NOT NULL"))[0] || {};
  const oldest = r.oldest == null ? null : Number(r.oldest);
  return { waiting: Number(r.n) || 0, oldest_since: oldest, overdue: !!oldest && now() - oldest > HUB_WAIT_ALERT_MS };
}
const alerted = new Set();

// ── jobs ──
/** Ask for an export. -> {ok, id} | {ok:false, code:"E_RATE", retry_at} */
async function request(userId) {
  await init();
  const uid = String(userId);
  const last = (await getQuery("SELECT created FROM account_exports WHERE user_id = ? AND state != 'failed' ORDER BY created DESC LIMIT 1", [uid]))[0];
  if (last && now() - Number(last.created) < RATE_MS) return { ok: false, code: "E_RATE", retry_at: Number(last.created) + RATE_MS };
  const id = crypto.randomBytes(16).toString("hex");
  await runQuery("INSERT INTO account_exports (id, user_id, created, state) VALUES (?, ?, ?, 'queued')", [id, uid, now()]);
  setImmediate(() => run(id).catch((e) => console.error("[export] run:", e.message)));
  return { ok: true, id };
}

const running = new Set();
async function run(id) {
  if (running.has(id)) return null;
  running.add(id);
  try {
    await init();
    const claim = await runQuery("UPDATE account_exports SET state = 'running' WHERE id = ? AND state = 'queued'", [id]);
    if (!claim || !claim.changes) return null;
    const job = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
    try {
      // 1.99acm: the chat hub's part FIRST - required while hubseam.export is on (the job waits for the hub, never ships without
      // it) - so a job waiting for the hub doesn't gather the whole account on every tick only to throw it away. (A refusal -
      // no key, key_env, insecure_url - comes back from getSigned without a network call.)
      const hub = await hubPart(job);
      if (hub.wait) {
        const t = now();
        const since = Number(job.hub_wait_since) || t;
        await runQuery("UPDATE account_exports SET state = 'queued', hub_wait_since = ?, hub_error = ? WHERE id = ?", [since, String(hub.wait).slice(0, 40), id]);
        if (t - since > HUB_WAIT_ALERT_MS && !alerted.has(id)) {
          alerted.add(id);
          console.error(`[export] ${id}: waiting for the chat hub for over 24 h (${hub.wait}) - check /admin/keys#seam`);
        }
        return { ok: false, waiting: true, error: hub.wait };
      }
      const data = await collect(job.user_id);
      const files = [{ name: "patv-data.json", data: JSON.stringify(data, null, 2) }];
      if (hub.data) files.push({ name: "chat-hub.jsonl", data: hub.data });
      files.push({ name: "README.txt", data: README + (hub.data ? README_HUB : hub.none ? README_NO_HUB : "") });
      const buf = zip(files, new Date(now()));
      fs.mkdirSync(dir(), { recursive: true });
      const file = path.join(dir(), `${id}.zip`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      const t = now();
      await runQuery("UPDATE account_exports SET state = 'ready', file = ?, bytes = ?, finished = ?, expires = ?, hub_error = NULL WHERE id = ?",
                     [path.basename(file), buf.length, t, t + EXPORT_TTL_MS, id]);
      alerted.delete(id);
      await require("./inbox").addSafe(job.user_id, { kind: "system", title: "Your data export is ready",
        body: "The copy of your PATV data you asked for is ready. Download it from Settings → Account → Your data within 7 days, signed in to this account.",
        link: "/settings/account#data", ref: `export:${id}` });
      return { ok: true, bytes: buf.length };
    } catch (e) {
      await runQuery("UPDATE account_exports SET state = 'failed', error = ?, finished = ? WHERE id = ?", [String(e.message).slice(0, 200), now(), id]);
      console.error(`[export] ${id} failed:`, e.message);
      return { ok: false, error: e.message };
    }
  } finally { running.delete(id); }
}

/** Interrupted jobs run again; expired files go. */
async function tick() {
  await init();
  for (const j of await getQuery("SELECT id FROM account_exports WHERE state = 'running' AND created < ?", [now() - 30 * 60000])) {
    await runQuery("UPDATE account_exports SET state = 'queued' WHERE id = ? AND state = 'running'", [j.id]);
  }
  // (1.99acm: new jobs before the ones waiting for the chat hub)
  for (const j of await getQuery("SELECT id FROM account_exports WHERE state = 'queued' ORDER BY (hub_wait_since IS NOT NULL), created LIMIT 5")) await run(j.id);
  for (const j of await getQuery("SELECT id, file FROM account_exports WHERE state = 'ready' AND expires <= ?", [now()])) {
    if (j.file) { try { fs.unlinkSync(path.join(dir(), path.basename(j.file))); } catch (e) { /* gone */ } }
    await runQuery("UPDATE account_exports SET state = 'expired', file = NULL WHERE id = ?", [j.id]);
  }
}

/** Every export file of an account goes (account deletion). */
async function removeAll(userId) {
  await init();
  for (const j of await getQuery("SELECT id, file FROM account_exports WHERE user_id = ?", [String(userId)])) {
    if (j.file) { try { fs.unlinkSync(path.join(dir(), path.basename(j.file))); } catch (e) { /* gone */ } }
  }
  await runQuery("UPDATE account_exports SET state = 'expired', file = NULL WHERE user_id = ? AND state IN ('queued','running','ready')", [String(userId)]);
}

async function mine(userId) {
  await init();
  return getQuery("SELECT id, created, state, bytes, finished, expires FROM account_exports WHERE user_id = ? ORDER BY created DESC LIMIT 5", [String(userId)]);
}

let timer = null;
function register(app, { addUser }) {
  init().catch((e) => console.error("[export] init:", e.message));
  if (!timer) {
    timer = setInterval(() => tick().catch((e) => console.error("[export] tick:", e.message)), TICK_MS);
    if (timer.unref) timer.unref();
    setTimeout(() => tick().catch(() => {}), 20000).unref();
  }
  const sameOrigin = (req) => { const s = req.get("origin") || req.get("referer"); try { return !!s && new URL(s).host === req.get("host"); } catch (e) { return false; } };
  app.get("/api/account/export", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try { res.json({ ok: true, exports: await mine(req.user.userId), ttl_days: EXPORT_TTL_MS / DAY }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });
  app.post("/api/account/export", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    if (req.get("X-Requested-With") !== "fetch" || !sameOrigin(req)) return res.status(403).json({ ok: false, error: "cross-site" });
    try {
      const r = await request(req.user.userId);
      res.status(r.ok ? 200 : 429).json(r);
    } catch (e) { console.error("[export] request:", e.message); res.status(500).json({ ok: false }); }
  });
  app.get("/settings/account/export/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/account#data"));
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).send("Not found");
    const j = (await getQuery("SELECT * FROM account_exports WHERE id = ? AND user_id = ?", [id, String(req.user.userId)]).catch(() => []))[0];
    if (!j || j.state !== "ready" || !j.file || Number(j.expires) <= now()) return res.status(410).send("This export has expired or isn't ready. Ask for a new one in Settings → Account → Your data.");
    const file = path.join(dir(), path.basename(j.file));
    if (!fs.existsSync(file)) return res.status(410).send("This export has expired. Ask for a new one in Settings → Account → Your data.");
    res.download(file, `patv-data-${new Date(Number(j.finished || j.created)).toISOString().slice(0, 10)}.zip`);
  });
}

module.exports = { init, register, request, run, tick, collect, zip, crc32, removeAll, mine, hubWaits, OMIT, RATE_MS, EXPORT_TTL_MS,
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _dir: dir, _collects: () => collects };
