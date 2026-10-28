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
// votes / tips / stories (+ story votes, story tips sent / received, story settings - storyreact site), the DMs they SENT
// (their side of each conversation they are in; which of them were story replies, as metadata), notices, achievements,
// cosmetics, purchases and orders, subscriptions, likeness settings and earnings, their sign-in sessions, and the chat
// data PATV keeps keyed to their account or Camfrog login (chat statistics, room participation, clips they made or that
// are of them - as records; the clip files themselves are not in the zip; CL2: their own lines in the pad chat archive).
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
//
// Mic retention (owner answers 2026-10-27; the ops plan mic-audio-retention-2026-10-27 §7.2) - the member picks what else goes in
// (`parts`): chat logs, mic transcripts, what Pepe remembers about them, and (only while the mic-recordings policy switch is on -
// micrec.js - and with a linked Camfrog login) their mic recordings. Chat logs / transcripts are the site's own archive lines
// (chat.pad_chat_lines, split by kind) AND Pepe's copies; memories and recordings are Pepe's only. Pepe's part comes
// ASYNCHRONOUSLY from the bot (1.99afq pepe_mydata): the job asks him (website action "privacy.export" [export id, parts, before?])
// and waits (state queued, pepe_state 'wait'); he builds ONE zip (at most ~256 MB, newest recordings first, `next_before` for the
// rest) and sends it in slices to POST /api/privacy/export/bot/chunk, then /finish (bot token); the site joins and checks it (size,
// sha256, a zip) and the member's download carries it as pepe-data.zip (stored). No answer: asked again every PEPE_RETRY_MS (never
// while his last ask still waits for him), and PEPE_WAIT_MS after the request the zip is built without his part (the README says
// so). Pepe's options are offered only while he runs that release (micrec.pepeCan); an older form (no `parts`) gets today's export.
// Bounded: his zip PEPE_ZIP_MAX, REC_JOBS_MAX exports with recordings in flight, REC_DISK_MAX for them and EXPORT_DISK_MAX for every
// export on disk (a slice past it: 507), the member's zip below 4 GiB (no ZIP64), text deflated off the event loop.
//   account_exports  + parts (JSON {chat, transcripts, memories, recordings, rec_before, pepe: [the parts asked of Pepe]}), rec (1 =
//                    recordings asked), pepe_state (NULL | wait | done | gave_up), pepe_attempt (asks so far), pepe_asked_at,
//                    pepe_bytes (staged / received), pepe_summary (his /finish: parts, counts, left_out, next_before, truncated,
//                    before, size), pepe_error (his ok: false)
// Review fixes (1.99afr):
//   * scope: Pepe keeps his data under a Camfrog LOGIN, from all time - so a login another PATV account held before (its login
//     history, or a deleted account's marker - micrec.earlierHolder) gets NO Pepe part (his part would carry the earlier holder's
//     recordings, PMs and notes): the same rule account deletion uses (micrec.askable). Only the current login is ever asked.
//     Review 2: the site's own lines under such a login (chat.pad_chat_lines) start when it became this account's
//     (micrec.ownSince -> chatlog.exportLines loginSince; the README says from when) - for every download, the older form's too.
//   * "Only recordings before" limits recordings ONLY: the bot applies `before` to everything he builds, so a dated ask carries
//     recordings alone (`parts.pepe_left` = the Pepe parts left for a download without a date; the README says so).
//   * step-up: a download with Pepe's part needs the deletion flow's re-authentication (a password, or a sign-in in the last 10
//     minutes) and sends an inbox notice; at most PEPE_JOBS_MAX asks in flight site-wide (more wait their turn, `pepe` = 1);
//     re-asked only when no slice arrived lately (pepe_slice_at); his zip joined / hashed / stored without holding the event loop.
//   * a zip whose job was expired meanwhile (account deletion) is deleted, never announced; tick sweeps zips no ready row owns.
//   account_exports  + pepe (1 = Pepe's part asked), pepe_slice_at (his last slice)
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const util = require("util");
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 86400000;
const RATE_MS = DAY;
const EXPORT_TTL_MS = 7 * DAY;
const MAX_ROWS = 50000;            // per table
const TICK_MS = 10 * 60000;
// mic retention: Pepe's part (bot 1.99afq pepe_mydata)
const MB = 1024 * 1024;
const PEPE_PARTS = Object.freeze(["chat", "transcripts", "memories", "recordings"]);
const PEPE_KIND = "privacy.export";
const PEPE_RETRY_MS = 6 * 3600e3;           // no /finish this long after asking -> ask again
const PEPE_WAIT_MS = 72 * 3600e3;           // ... and this long after the request the zip is built without his part
const PEPE_SHOWN_MB = 256;                  // the bot's EXPORT_MAX_MB: one download of his part (newest recordings first)
// what the site takes (review: at most 512 MB - the bot sends at most 256; the member's zip stays far below 4 GiB)
const PEPE_ZIP_MAX = Math.max(1, Math.min(512, Number(process.env.ACCOUNT_EXPORT_PEPE_MAX_MB) || 320)) * MB;
const SLICE_MAX = MB;                       // raw bytes of one slice (the bot sends 384 KB: ~512 KB of base64 JSON)
const REC_JOBS_MAX = 3;                     // exports with recordings in flight at once
const PEPE_JOBS_MAX = 4;                    // review: asks of Pepe in flight site-wide (his EXPORT_QUEUE is 5); more wait their turn
const PEPE_SLICE_QUIET_MS = 3600e3;         // review: a slice this recent = he is uploading - never re-asked meanwhile
const ORPHAN_MS = 3600e3;                   // review: a zip no ready row owns, this old, is deleted (tick)
const REAUTH_TRIES = 5, REAUTH_WINDOW_MS = 15 * 60000;   // review: wrong passwords per account before a 429
const REC_DISK_MAX = 4096 * MB;             // ready recordings exports + in-flight ones (each counted at PEPE_ZIP_MAX)
const EXPORT_DISK_MAX = 8192 * MB;          // every ready export + Pepe's slices staged now: a slice past it is refused (507)
const ID_RE = /^[a-f0-9]{32}$/;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;

let clock = () => Date.now();
const now = () => clock();
const dir = () => process.env.ACCOUNT_EXPORT_DIR || path.join(process.cwd(), "account-exports");
const pepeDir = (id) => path.join(dir(), `${id}.pepe`);
const rmPepe = (id) => { try { fs.rmSync(pepeDir(id), { recursive: true, force: true }); } catch (e) { /* gone */ } };

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
      // mic retention: the member's choices and Pepe's part
      for (const [c, type] of [["parts", "TEXT"], ["rec", "INTEGER"], ["pepe_state", "TEXT"], ["pepe_attempt", "INTEGER"], ["pepe_asked_at", "INTEGER"],
                               ["pepe_bytes", "INTEGER"], ["pepe_summary", "TEXT"], ["pepe_error", "TEXT"], ["pepe", "INTEGER"], ["pepe_slice_at", "INTEGER"]]) {
        if (!have.includes(c)) await runQuery(`ALTER TABLE account_exports ADD COLUMN ${c} ${type}`);
      }
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
async function collect(userId, { at = now(), parts = null } = {}) {
  collects++;
  tableCols.clear();
  const uid = String(userId);
  const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [uid]))[0];
  if (!u) throw new Error("no such account");
  const login = String(u.camfrogUsername || "").trim().toLowerCase() || null;
  const out = { exported_at: new Date(at).toISOString(), format: "patv-data-1", about: "PAT is points, not money. Ids are PATV's internal ids.",
                account: {} };
  // mic retention: what the member chose to include (an older form chose nothing: everything the site keeps, no Pepe part)
  if (parts) out.included = { chat_logs: !!parts.chat, mic_transcripts: !!parts.transcripts, pepe_memories: !!parts.memories, mic_recordings: !!parts.recordings };
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
  // adultgate site: the one-time age confirmation (users.age_confirmed_at, ms + the wording's version) + the 18+ creator-content one
  // (creators age_attest)
  await put("account", "age_confirmation", (async () => ({ at: Number(u.age_confirmed_at) > 0 ? Number(u.age_confirmed_at) : null,
    version: Number(u.age_confirmed_at) > 0 ? u.age_confirmed_v || null : null,
    creators: ((await rows("age_attest", "user_id = ?", [uid]).catch(() => null)) || [])[0] || null }))());
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
  // storyreact site: votes / tips on stories (received tips without who sent them or their note, like post tips), the story settings
  await put("stories", "votes", rows("story_votes", "user_id = ?", [uid]));
  await put("stories", "tips_sent", rows("story_tips", "sender_id = ?", [uid]));
  await put("stories", "tips_received", rows("story_tips", "recipient_id = ?", [uid], { omit: ["sender_id", "note"] }));
  await put("stories", "settings", rows("story_prefs", "user_id = ?", [uid]));
  await put("posts", "follows", rows("follows", "follower = ?", [uid]));
  // messages: their side only
  const convs = await getQuery("SELECT conversation_id FROM conversation_members WHERE user_id = ?", [uid]).catch(() => []);
  if (convs.length !== undefined) {
    const list = [];
    const via = (await colsOf("messages")).includes("via") ? ", via" : "";      // CL11: 'cf_message' / 'cf_pm' = sent from Camfrog
    for (const c of convs.slice(0, 5000)) {
      const meta = (await getQuery("SELECT id, kind, title, created_at, dm_key FROM conversations WHERE id = ?", [c.conversation_id]).catch(() => []))[0] || { id: c.conversation_id };
      // CL13: a "📨 Sent in Camfrog to <login>" thread names its Camfrog login (the key itself - internal ids - isn't exported)
      if (meta.kind === "cfpm") { const p = String(meta.dm_key || "").split("|").filter((x) => x.startsWith("cf:")); if (p.length === 1) meta.camfrog_login = p[0].slice(3); }
      delete meta.dm_key;
      const sent = await getQuery(`SELECT id, body, kind, created_at, edited_at, deleted_at${via} FROM messages WHERE conversation_id = ? AND sender_id = ? ORDER BY id LIMIT ?`,
                                  [c.conversation_id, uid, MAX_ROWS]).catch(() => []);
      list.push({ conversation: meta, messages_you_sent: sent });
    }
    out.messages = { note: "The messages you sent, in each conversation you are part of. Messages other people sent are theirs and are not included.", conversations: list };
  }
  // CL11: the Camfrog side of the `!msg` copies they sent (relay key, Camfrog logins, room, Camfrog time). Fix-up: not
  // `present` (whether the RECIPIENT was on the room's user list - a fact about them, not the sender), and only committed
  // copies of the sender's own messages (a copy being written has a negative placeholder message_id)
  if ((await colsOf("dm_relays")).length && (await colsOf("messages")).length) {
    // CL13: kept = true when the copy went to your own "Sent in Camfrog to <login>" log. Fix-up: only that - never WHY
    // (dm_relays.kept 'no_account' / 'refused' says whether the recipient has a PATV account or refuses you: a fact about them)
    const kept = (await colsOf("dm_relays")).includes("kept") ? ", CASE WHEN r.kept IS NULL THEN 0 ELSE 1 END AS kept" : "";
    await put("messages", "camfrog_copies", getQuery(`SELECT r.message_id, r.relay_key, r.via, r.from_login, r.to_login, r.cf_room, r.cf_sent_at, r.created${kept}
                                                      FROM dm_relays r JOIN messages m ON m.id = r.message_id
                                                      WHERE m.sender_id = ? AND r.message_id > 0 AND m.via = 'cf_pm' ORDER BY r.message_id LIMIT ${MAX_ROWS}`, [uid])
      .then((rs) => (kept ? rs.map((r) => Object.assign({}, r, { kept: !!r.kept })) : rs)));
  }
  await put("messages", "settings", rows("dm_prefs", "user_id = ?", [uid]));
  await put("messages", "your_blocks", rows("dm_blocks", "blocker_id = ?", [uid]));
  // storyreact site: which of your messages were story replies - metadata only (never the story's id or whose it was)
  await put("messages", "story_replies", rows("dm_story_refs", "sender_id = ?", [uid], { omit: ["story_id", "author_id", "author_name"] }));
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
    await put("chat", "stage_leave", rows("stage_leave", "login = ?", [login]));     // stagefix site: the pads keeping your cam off their Stage
    // stagefix final round (stagepin.js): your level for pads' Stages, the pads you said yes / no to, the asks sent to you
    await put("chat", "stage_level", rows("stage_level", "login = ?", [login]));
    await put("chat", "stage_pad_prefs", rows("stage_pad_prefs", "login = ?", [login]));
    await put("chat", "stage_asks", rows("stage_asks", "login = ?", [login], { omit: ["actor_id"] }));
    // micfollow: the 🎙 mic stage - when your cam showed on a pad's stage, your switch, pads that keep you off it (not who
    // set it), the pads' notices to you, and reports on your tiles (not who made them)
    await put("chat", "mic_stage_appearances", rows("micfollow_spans", "login = ?", [login], { order: "started" }));
    await put("chat", "mic_stage_setting", rows("micfollow_optout", "login = ?", [login]));
    await put("chat", "mic_stage_kept_off", rows("micfollow_excl", "login = ? OR user_id = ?", [login, uid], { omit: ["by"] }));
    await put("chat", "mic_stage_notices", rows("micfollow_notices", "login = ?", [login]));
    await put("chat", "mic_stage_courtesy_notice", rows("micfollow_courtesy", "login = ?", [login]));   // 1.99afn (FU-1)
    await put("chat", "mic_stage_reports_on_you", rows("micfollow_reports", "login = ?", [login], { omit: ["reporter_id", "resolved_by"], order: "at" }));
    // mfix: 📌 your cam pinned on a pad's mic stage now (not who pinned it)
    await put("chat", "mic_stage_pins_of_you", rows("micfollow_pins", "login = ?", [login], { omit: ["by_id", "by_name"], order: "at" }));
  }
  await put("chat", "mic_stage_pins_you_made", rows("micfollow_pins", "by_id = ?", [uid], { omit: ["by_name"], order: "at" }));   // mfix
  await put("chat", "mic_stage_reports_you_made", rows("micfollow_reports", "reporter_id = ?", [uid], { omit: ["resolved_by"], order: "at" }));
  // CL2: the pad chat archive (chatlog.js) - your own lines there (your linked Camfrog login or your account's web lines; Approved
  // pads too), your chat-log downloads (metadata) and the reports you filed on chat lines
  // mic retention: with the member's choices, the chat lines and the 🎙 transcript lines ("mic") each follow their own checkbox
  // (review: picked in SQL, before the row cap - a heavy chatter who ticks only transcripts still gets them)
  // review 2: a login another PATV account held before (micrec.ownSince - the rule Pepe's part follows): its lines only from when it
  // became this account's (lines before then may be theirs); the account's own web lines all. Unknown (an error) = none under it.
  // review 3: the note says "another PATV account had that name" only when ownSince really said so (on its error path every line
  // under the login is left out and out.errors says why - the check failed, so that claim may be untrue), and only when the member
  // asked for lines at all (neither box ticked: exportLines gives [] and there are no lines for a note to be about)
  let loginSince = 0, sinceKnown = true;
  if (login) {
    try { const M = require("./micrec"); loginSince = await M.ownSince(uid, login, at); }
    catch (e) { loginSince = at; sinceKnown = false; (out.errors = out.errors || []).push("chat.pad_chat_lines: who held your Camfrog name before couldn't be checked - lines under it were left out"); }
  }
  const wantLines = !parts || !!parts.chat || !!parts.transcripts;
  await put("chat", "pad_chat_lines", require("./chatlog").exportLines(uid, login, MAX_ROWS, parts ? { mic: !!parts.transcripts, other: !!parts.chat } : null, { loginSince }));
  if (sinceKnown && wantLines && loginSince > 0 && out.chat && Array.isArray(out.chat.pad_chat_lines)) {
    out.chat.pad_chat_lines_note = `Your lines under your Camfrog name start ${new Date(loginSince).toISOString().slice(0, 10)}: another PATV account had that name ` +
                                   "before you, and lines under it before then may be theirs.";
  }
  await put("chat", "chat_log_downloads", rows("chatlog_exports", "user_id = ?", [uid]));
  await put("chat", "chat_line_reports", rows("chatlog_reports", "reporter = ?", [uid], { omit: ["decided_by"] }));
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

// mic retention: the zip written to a FILE entry by entry (a recordings export is hundreds of MB): a {name, data} entry is checksummed
// and deflated off the event loop (zlib's thread pool; the checksum in steps); a {name, path} entry (Pepe's zip, ~hundreds of MB) is
// STORED and STREAMED - read in 1 MB pieces, each written and added to the crc, the crc patched into its header afterwards (review:
// never read whole into memory, never one long synchronous stretch). The central directory follows. Below 4 GiB and 65,535 entries
// (no ZIP64): the caps keep it there, and a bigger one throws. Every write is positional (the offset is ours - never the file's
// position, which a positional write may or may not move). entries: [{name, data} | {name, path} (stored)]
const deflateRaw = util.promisify(zlib.deflateRaw);
const PIECE = 1 << 20;
/** crc32 state (un-finalised: start with -1, finish with (c ^ -1) >>> 0) over buf, in 1 MB steps with a yield between them (Node 16
 *  has no native one; a 64 MB entry never holds the event loop for long). */
async function crcStep(c, buf) {
  for (let o = 0; o < buf.length; o += PIECE) {
    const end = Math.min(buf.length, o + PIECE);
    for (let i = o; i < end; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    if (end < buf.length) await new Promise((r) => setImmediate(r));
  }
  return c;
}
async function crcAsync(buf) { return ((await crcStep(-1, buf)) ^ -1) >>> 0; }
async function zipToFile(out, entries, at = new Date()) {
  if (entries.length > 65535) throw new Error("too many files for a zip");
  const dosTime = ((at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()) & 0xffff;
  const tmp = out + `.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const fh = await fs.promises.open(tmp, "w", 0o600);
  const central = [];
  let offset = 0;
  const put = async (buf, pos = offset) => { let o = 0; while (o < buf.length) { const { bytesWritten } = await fh.write(buf, o, buf.length - o, pos + o); o += bytesWritten; } };
  const header = (store, crc, csize, size, name) => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(store ? 10 : 20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    return local;
  };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, "utf8");
      const start = offset;
      let store, crc, csize, size;
      if (e.data !== undefined) {
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
        store = !!e.store;
        const comp = store ? raw : await deflateRaw(raw, { level: 6 });
        crc = await crcAsync(raw);
        csize = comp.length; size = raw.length;
        if (start + 30 + name.length + csize > 0xfffffffe) throw new Error("the zip would pass 4 GiB");
        await put(header(store, crc, csize, size, name), start);
        await put(name, start + 30);
        await put(comp, start + 30 + name.length);
      } else if (e.path) {
        // streamed, stored: the header first with a zero crc, the file in pieces, then the crc and sizes patched in
        store = true;
        size = (await fs.promises.stat(e.path)).size;
        csize = size;
        if (start + 30 + name.length + size > 0xfffffffe) throw new Error("the zip would pass 4 GiB");
        await put(header(true, 0, size, size, name), start);
        await put(name, start + 30);
        const src = await fs.promises.open(e.path, "r");
        let c = -1, got = 0;
        try {
          const piece = Buffer.alloc(Math.min(PIECE, Math.max(1, size)));
          while (got < size) {
            const { bytesRead } = await src.read(piece, 0, Math.min(piece.length, size - got), got);
            if (!bytesRead) break;
            const view = piece.subarray(0, bytesRead);
            c = await crcStep(c, view);
            await put(view, start + 30 + name.length + got);
            got += bytesRead;
          }
        } finally { await src.close(); }
        if (got !== size) throw new Error(`${e.name} changed while it was zipped`);
        crc = (c ^ -1) >>> 0;
        const fix = Buffer.alloc(4); fix.writeUInt32LE(crc, 0);
        await put(fix, start + 14);
      } else throw new Error("a zip entry needs data or a path");
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(store ? 10 : 20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(store ? 0 : 8, 10);
      cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(csize, 20);
      cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(start, 42);
      central.push(cen, name);
      offset = start + 30 + name.length + csize;
    }
    const cenBuf = Buffer.concat(central);
    if (offset + cenBuf.length + 22 > 0xfffffffe) throw new Error("the zip would pass 4 GiB");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
    await put(cenBuf, offset); await put(end, offset + cenBuf.length);
    await fh.close();
    fs.renameSync(tmp, out);
    return offset + cenBuf.length + 22;
  } catch (e) {
    try { await fh.close(); } catch (x) { /* closed */ }
    try { fs.unlinkSync(tmp); } catch (x) { /* gone */ }
    throw e;
  }
}

const README = `Your PATV data
==============

patv-data.json is everything PATV keeps about your account, as of the time in "exported_at".

- PAT is points, not money.
- Ids (userId, post ids, conversation ids...) are PATV's internal ids.
- "messages" has the messages YOU sent in each conversation you are part of. Other people's messages are theirs.
  "messages.camfrog_copies" is the Camfrog side of the !msg messages you sent through Pepe (the Camfrog logins, room and time).
  A conversation of kind "cfpm" is your own "Sent in Camfrog to <camfrog_login>" log: !msg copies that couldn't go to
  that person's PATV messages ("kept": true in camfrog_copies).
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

// ── mic retention: the member's choices and Pepe's part ──
/** The form's `parts` -> {chat, transcripts, memories, recordings, rec_before} | null (an older form: today's export). */
function cleanParts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = (k, d) => (raw[k] === undefined || raw[k] === null ? d : raw[k] === true);
  const rb = Number(raw.rec_before);
  const recordings = b("recordings", false);
  return { chat: b("chat", true), transcripts: b("transcripts", true), memories: b("memories", false), recordings,
           rec_before: recordings && Number.isFinite(rb) && rb > Date.UTC(2020, 0, 1) && rb < Date.UTC(2100, 0, 1) ? Math.floor(rb) : null };
}
const parseJson = (s, d) => { try { const v = JSON.parse(s || "null"); return v == null ? d : v; } catch (e) { return d; } };
/** review: a time from Pepe (unix s) - only a plausible one (2015 .. tomorrow), else null (never a throw on a date). */
const cleanSec = (v, t = now()) => { const n = Number(v); return Number.isInteger(n) && n > 1420070400 && n < t / 1000 + 86400 ? n : null; };
const linkedLogin = async (userId) => {
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = String((u && u.camfrogUsername) || "").trim().toLowerCase();
  return LOGIN_RE.test(l) ? l : null;
};
/** review: was the login another PATV account's before (micrec.earlierHolder)? Then Pepe's part - kept under the login from all
 *  time - would carry that holder's data, so it isn't asked (the deletion's rule - micrec.askable). Unknown (an error) = shared. */
async function loginShared(userId, login) {
  if (!login) return false;
  try { const M = require("./micrec"); await M.init(); return await M.earlierHolder(userId, login); } catch (e) { return true; }
}
/** What the form may offer this account now: {pepe, recordings, login, login_shared, rec_max_mb}. pepe = Pepe runs the release that
 *  gathers his part (micrec.pepeCan: bot 1.99afq) and the login is only ever this account's; recordings = that, the mic-recordings
 *  policy switch (micrec.js) and a linked Camfrog login. login_shared = his part is left out because another account held the login. */
async function offer(userId) {
  let pepe = false, policy = false;
  try { const M = require("./micrec"); await M.init(); pepe = M.pepeCan(); policy = M.policyOn(); } catch (e) { pepe = false; policy = false; }
  const login = await linkedLogin(userId);
  const shared = pepe && (await loginShared(userId, login));
  return { pepe: pepe && !shared, recordings: pepe && !shared && policy && !!login, login, login_shared: shared, rec_max_mb: PEPE_SHOWN_MB };
}
/** review: the account's re-authentication for a download with Pepe's part - the deletion flow's (accountdelete.request): a sign-in
 *  in the last 10 minutes (any way), or the password. -> null (ok) | {code: E_REAUTH | E_REAUTH_LIMIT, error} */
const reauthFails = new Map();          // userId -> [times of wrong passwords]
async function reauth(req, password) {
  if (await require("./sessions").isFresh(req)) return null;
  const uid = String(req.user.userId);
  if (typeof password !== "string" || !password) return { code: "E_REAUTH", error: "Confirm it's you: enter your password, or sign out and back in and ask within 10 minutes." };
  const t = now();
  const recent = (reauthFails.get(uid) || []).filter((x) => t - x < REAUTH_WINDOW_MS);
  if (recent.length >= REAUTH_TRIES) return { code: "E_REAUTH_LIMIT", error: "Too many wrong passwords - try again in 15 minutes, or sign out and back in.", retry_at: recent[0] + REAUTH_WINDOW_MS };
  if (await require("./accountdelete").verifyPassword(uid, password)) { reauthFails.delete(uid); return null; }
  recent.push(t);
  reauthFails.set(uid, recent);
  if (reauthFails.size > 5000) reauthFails.delete(reauthFails.keys().next().value);
  return { code: "E_REAUTH", error: "That password isn't right." };
}
/** Does the account have a password (else only a fresh sign-in re-authenticates)? (accountdelete's rule) */
async function hasPassword(userId) {
  const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0] || {};
  return u.password_set === undefined || u.password_set === null || Number(u.password_set) !== 0;
}
/** Room for one more recordings export? -> null | {code, retry_at?} */
async function recRoom() {
  const inflight = (await getQuery("SELECT COUNT(*) AS n FROM account_exports WHERE rec = 1 AND state IN ('queued','running')"))[0].n;
  if (inflight >= REC_JOBS_MAX) return { code: "E_REC_BUSY" };
  const ready = (await getQuery("SELECT COALESCE(SUM(bytes), 0) AS b, MIN(expires) AS next FROM account_exports WHERE rec = 1 AND state = 'ready'"))[0];
  if (Number(ready.b) + (inflight + 1) * PEPE_ZIP_MAX > REC_DISK_MAX) return { code: "E_REC_BUSY", retry_at: Number(ready.next) || null };
  return null;
}

// ── jobs ──
/** Ask for an export. opts.parts: the member's choices (cleanParts); opts.verify: async () => null | refusal - the route's
 *  re-authentication, asked only when Pepe's part goes in (review). -> {ok, id} | {ok:false, code: E_RATE (+ retry_at) | E_REC_OFF |
 *  E_PEPE_OFF | E_REC_BUSY (+ retry_at) | E_REAUTH | E_REAUTH_LIMIT} */
async function request(userId, opts = {}) {
  await init();
  const uid = String(userId);
  const last = (await getQuery("SELECT created FROM account_exports WHERE user_id = ? AND state != 'failed' ORDER BY created DESC LIMIT 1", [uid]))[0];
  if (last && now() - Number(last.created) < RATE_MS) return { ok: false, code: "E_RATE", retry_at: Number(last.created) + RATE_MS };
  const parts = cleanParts(opts.parts);
  if (parts) {
    const o = await offer(uid);
    if (parts.recordings && !o.recordings) return { ok: false, code: "E_REC_OFF" };
    if (parts.memories && !o.pepe) return { ok: false, code: "E_PEPE_OFF" };
    if (parts.recordings) { const busy = await recRoom(); if (busy) return { ok: false, ...busy }; }
    // Pepe's copies of the chat logs / transcripts ride along when he can gather them (the site's own lines are in either way)
    let pepe = o.pepe ? PEPE_PARTS.filter((k) => parts[k]) : [];
    // review: the login was another account's before - his copies would carry theirs (the README says why they're missing)
    if (o.login_shared && (parts.chat || parts.transcripts)) { parts.pepe_left = PEPE_PARTS.filter((k) => parts[k]); parts.pepe_left_why = "login_shared"; }
    // review: the bot applies `before` to EVERYTHING he builds - a dated ask carries recordings alone; the rest of his part needs a
    // download without a date (the README and the form say so)
    if (parts.rec_before && pepe.includes("recordings") && pepe.length > 1) {
      parts.pepe_left = pepe.filter((k) => k !== "recordings");
      parts.pepe_left_why = "dated";
      pepe = ["recordings"];
    }
    parts.pepe = pepe;
    if (pepe.length && typeof opts.verify === "function") {
      const v = await opts.verify();
      if (v) return { ok: false, ...v };
    }
  }
  const id = crypto.randomBytes(16).toString("hex");
  const withPepe = !!(parts && parts.pepe.length);
  await runQuery("INSERT INTO account_exports (id, user_id, created, state, parts, rec, pepe) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
                 [id, uid, now(), parts ? JSON.stringify(parts) : null, parts && parts.recordings ? 1 : null, withPepe ? 1 : null]);
  if (withPepe) {
    // review: a download with Pepe's part (PMs, his notes, recordings) is announced - someone else on a live session would show
    await require("./inbox").addSafe(uid, { kind: "system", title: "You asked for a copy of your data",
      body: `A download of your data with Pepe's part (${parts.pepe.map((k) => PART_WORDS[k] || k).join(", ")}) is being prepared. If this wasn't you, ` +
            "sign out your other sign-ins (Settings → Account → Sign-ins) and change your password.",
      link: "/settings/account#data", ref: `export-asked:${id}` });
  }
  setImmediate(() => run(id).catch((e) => console.error("[export] run:", e.message)));
  return { ok: true, id };
}

/** Ask Pepe for his part (ask n): the website action "privacy.export" [export id, parts (comma list), before (unix s)?] - the bot's
 *  pepe_mydata builds ONE zip of them and sends it to /api/privacy/export/bot/chunk + /finish under the export id. (A new build has
 *  another sha256: putChunk replaces an earlier build's slices - an ask again never deletes an upload in progress.) */
async function askPepe(job, n) {
  const parts = parseJson(job.parts, {});
  const login = await linkedLogin(job.user_id);
  const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(job.user_id)]))[0] || {};
  const t = now();
  const ask = (parts.pepe || []).filter((k) => k !== "recordings" || login);
  const nothing = async (why) => runQuery("UPDATE account_exports SET pepe_state = 'done', pepe_error = ?, pepe_attempt = ? WHERE id = ?", [why, n, job.id]);
  if (!ask.length) {
    // (recordings only, and the Camfrog login was unlinked since: nothing Pepe can be asked - built without his part)
    await nothing("no linked Camfrog login any more");
    return;
  }
  // review: the login now (it may have changed since the request) was another account's before - never asked (see loginShared)
  if (login && (await loginShared(job.user_id, login))) { await nothing("login_shared"); return; }
  // review: `before` only on an ask of recordings alone (request() splits a dated one) - the bot applies it to every part
  const dated = parts.rec_before && ask.length === 1 && ask[0] === "recordings";
  const args = [job.id, ask.join(",")].concat(dated ? [String(Math.floor(parts.rec_before / 1000))] : []);
  await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                  VALUES (?, ?, ?, 0, ?, ?, 'privacy', 'your data: Pepe''s part', 'pending', ?, ?, ?)`,
                 [String(job.user_id), u.username || "?", login, PEPE_KIND, JSON.stringify(args), t, t, `export-${job.id}-${n}`]);
  await runQuery("UPDATE account_exports SET pepe_state = 'wait', pepe_attempt = ?, pepe_asked_at = ?, pepe_summary = NULL WHERE id = ?",
                 [n, t, job.id]);
}
/** The pending asks of an export are withdrawn (it finished without Pepe, or it's gone). */
const withdrawAsks = (id, why) => runQuery("UPDATE pepe_actions SET status = 'failed', message = ?, updated = ? WHERE kind = ? AND idem LIKE ? AND status = 'pending'",
                                           [why, now(), PEPE_KIND, `export-${id}-%`]).catch(() => {});

const running = new Set();
let beforeReady = null;                                         // tests only (_setBeforeReady)
async function run(id) {
  if (running.has(id)) return null;
  running.add(id);
  try {
    await init();
    const claim = await runQuery("UPDATE account_exports SET state = 'running' WHERE id = ? AND state = 'queued'", [id]);
    if (!claim || !claim.changes) return null;
    let job = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
    try {
      // mic retention: Pepe's part first - asked once, then the job waits for his /finish (pepeTick re-asks / gives up); the chat hub
      // and the account are gathered only after it, so a waiting job never gathers them twice
      const parts = parseJson(job.parts, null);
      if (parts && (parts.pepe || []).length && job.pepe_state !== "done" && job.pepe_state !== "gave_up") {
        if (!job.pepe_state) {
          // review: at most PEPE_JOBS_MAX asks in flight site-wide - the others wait their turn (the tick tries again, oldest first);
          // one that waited PEPE_WAIT_MS is built without his part
          const inflight = Number((await getQuery("SELECT COUNT(*) AS n FROM account_exports WHERE pepe_state = 'wait' AND state IN ('queued','running')"))[0].n) || 0;
          if (now() - Number(job.created) > PEPE_WAIT_MS) {
            await runQuery("UPDATE account_exports SET pepe_state = 'gave_up', pepe_error = 'busy' WHERE id = ?", [id]);
          } else if (inflight >= PEPE_JOBS_MAX) {
            await runQuery("UPDATE account_exports SET state = 'queued' WHERE id = ?", [id]);
            return { ok: false, waiting: true, error: "pepe_busy" };
          } else {
            await askPepe(job, 1);
          }
          job = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
        }
      }
      if (parts && (parts.pepe || []).length && job.pepe_state === "wait") {
        if (now() - Number(job.created) <= PEPE_WAIT_MS) {
          await runQuery("UPDATE account_exports SET state = 'queued' WHERE id = ?", [id]);
          return { ok: false, waiting: true, error: "pepe" };
        }
        await runQuery("UPDATE account_exports SET pepe_state = 'gave_up', pepe_error = COALESCE(pepe_error, 'timeout') WHERE id = ?", [id]);
        await withdrawAsks(id, "the export was finished without Pepe's part");
        job = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
      }
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
      const data = await collect(job.user_id, { parts });
      const files = [{ name: "patv-data.json", data: JSON.stringify(data, null, 2) }];
      if (hub.data) files.push({ name: "chat-hub.jsonl", data: hub.data });
      const pp = parts && (parts.pepe || []).length ? pepeEntries(job) : null;
      if (pp) files.push(...pp.entries);
      // review 2: lines under a login another account held before start when it became this account's (collect: pad_chat_lines_note)
      const linesNote = data.chat && data.chat.pad_chat_lines_note ? `\nchat.pad_chat_lines: ${data.chat.pad_chat_lines_note}\n` : "";
      files.push({ name: "README.txt", data: README + (hub.data ? README_HUB : hub.none ? README_NO_HUB : "") + (parts ? readmeChoices(parts, pp) : "") + linesNote });
      fs.mkdirSync(dir(), { recursive: true });
      const file = path.join(dir(), `${id}.zip`);
      const bytes = await zipToFile(file, files, new Date(now()));
      if (beforeReady) await beforeReady(job);                 // (tests: what happens meanwhile - an account deletion)
      const t = now();
      const done = await runQuery("UPDATE account_exports SET state = 'ready', file = ?, bytes = ?, finished = ?, expires = ?, hub_error = NULL WHERE id = ? AND state = 'running'",
                                  [path.basename(file), bytes, t, t + EXPORT_TTL_MS, id]);
      rmPepe(id);
      alerted.delete(id);
      if (!done || !done.changes) {
        // review: the job went away while it was built (account deletion's removeAll, an admin): the file is nobody's - it goes now,
        // and nobody is told it's ready
        try { fs.unlinkSync(file); } catch (e) { /* gone */ }
        return { ok: false, gone: true };
      }
      await require("./inbox").addSafe(job.user_id, { kind: "system", title: "Your data export is ready",
        body: "The copy of your PATV data you asked for is ready. Download it from Settings → Account → Your data within 7 days, signed in to this account.",
        link: "/settings/account#data", ref: `export:${id}` });
      return { ok: true, bytes };
    } catch (e) {
      await runQuery("UPDATE account_exports SET state = 'failed', error = ?, finished = ? WHERE id = ? AND state = 'running'", [String(e.message).slice(0, 200), now(), id]);
      rmPepe(id);
      console.error(`[export] ${id} failed:`, e.message);
      return { ok: false, error: e.message };
    }
  } finally { running.delete(id); }
}

/** Pepe's zip (checked at /finish) as the entry pepe-data.zip - STORED: it is compressed already - and what his finish said about it.
 *  -> {entries, got, sum, state, error} */
function pepeEntries(job) {
  const f = pepeZip(job.id);
  const got = job.pepe_state === "done" && !job.pepe_error && fs.existsSync(f);
  return { entries: got ? [{ name: "pepe-data.zip", path: f }] : [], got, sum: parseJson(job.pepe_summary, {}) || {},
           state: job.pepe_state, error: job.pepe_error || null };
}

const README_PARTS = `
What you chose to include:
`;
const PART_WORDS = { chat: "chat logs", transcripts: "mic transcripts", memories: "what Pepe remembers about you", recordings: "mic recordings" };
// review: what Pepe's part covers, and what a recording can hold (one mixed sound per room - the ops plan 8.11)
// (review 2: no promise about the names linked before - deleting the account asks Pepe to forget only the name now, and deletes
// recordings only with "Also delete my mic recordings")
const README_SCOPE = "  It covers your Camfrog name now only: Camfrog names you linked before aren't in it (write to privacy@publicaccess.tv for them).\n";
const README_OVERLAP = "  A mic recording is the sound of the room while you held the mic. In a room with more than one mic, people who were on the mic at\n" +
                       "  the same time can be heard in it too, and a mic transcript can hold their words - they're theirs as well, so please don't share them.\n";
const README_OVERLAP_TX = "  In a room with more than one mic, a mic transcript can hold the words of people who were on the mic at the same time - they're\n" +
                          "  theirs as well, so please don't share them.\n";
const ERR_WORDS = { timeout: "Pepe didn't send it in time", busy: "Pepe was busy with other people's downloads for too long",
                    login_shared: "your Camfrog name was linked to another PATV account before yours, and Pepe can't yet tell their data from yours" };
/** The README paragraph about the member's choices and Pepe's part (pp = pepeEntries(...), or null: Pepe wasn't asked). */
function readmeChoices(parts, pp) {
  const yes = (b) => (b ? "yes" : "no");
  let s = README_PARTS + `- chat logs: ${yes(parts.chat)}, mic transcripts: ${yes(parts.transcripts)}, what Pepe remembers about you: ${yes(parts.memories)}, ` +
          `mic recordings: ${yes(parts.recordings)}\n`;
  s += "- patv-data.json \"chat.pad_chat_lines\" has your lines in pads' chat history (kind \"mic\" = a mic transcript) for what you ticked.\n";
  const asked = parts.pepe || [];
  const left = (parts.pepe_left || []).map((k) => PART_WORDS[k] || k).join(", ");
  if (parts.pepe_left_why === "login_shared" && left) {
    s += `- Pepe's part (${left}): not included - ${ERR_WORDS.login_shared}. Write to privacy@publicaccess.tv if you need it.\n`;
  } else if (parts.pepe_left_why === "dated" && left) {
    s += `- Pepe's part (${left}): not in this download - you asked for recordings from before a date, and Pepe sends only those then. ` +
         "Ask again without a date for the rest.\n";
  }
  if (!asked.length) {
    if ((parts.chat || parts.transcripts) && !parts.pepe_left_why) s += "- Pepe's own copies of room chat and mic transcripts couldn't be added this time (his part can't be gathered right now); ask again later.\n";
    return s;
  }
  const what = asked.map((k) => PART_WORDS[k] || k).join(", ");
  if (pp && pp.got) {
    s += `- pepe-data.zip: Pepe's part (${what}) - a zip of its own; its README.txt and manifest.json say what's in it and what was left out.\n` + README_SCOPE;
    if (asked.includes("recordings")) s += README_OVERLAP;
    else if (asked.includes("transcripts")) s += README_OVERLAP_TX;
    const nb = cleanSec(pp.sum && pp.sum.next_before);
    if (asked.includes("recordings") && nb) {
      s += `  Not every recording fitted: one download holds at most about ${PEPE_SHOWN_MB} MB, newest first. For the older ones, ask again and pick ` +
           `"Only recordings before" ${new Date(nb * 1000).toISOString().slice(0, 10)}, or write to privacy@publicaccess.tv.\n`;
    }
  } else {
    const e = pp && pp.error ? String(pp.error) : null;
    const why = pp && pp.state === "gave_up" ? (ERR_WORDS[e] || ERR_WORDS.timeout) : e ? (ERR_WORDS[e] || `Pepe couldn't send it (${e.slice(0, 80)})`) : "Pepe had nothing to send";
    s += `- Pepe's part (${what}): not included - ${why}. Ask again later, or write to privacy@publicaccess.tv.\n`;
  }
  return s;
}

/** Jobs waiting for Pepe: asked again when his last ask failed / expired or went quiet for PEPE_RETRY_MS (never while it's still
 *  waiting for him to take it, review: nor while his slices are arriving - pepe_slice_at); built without his part PEPE_WAIT_MS after
 *  the request (a job still waiting its turn - PEPE_JOBS_MAX - too). -> {asked, gave_up} */
async function pepeTick() {
  const out = { asked: 0, gave_up: 0 };
  const t = now();
  for (const j of await getQuery("SELECT * FROM account_exports WHERE state = 'queued' AND pepe_state = 'wait' ORDER BY created LIMIT 50")) {
    if (t - Number(j.created) > PEPE_WAIT_MS) { out.gave_up++; await run(j.id); continue; }
    const act = (await getQuery("SELECT status, updated FROM pepe_actions WHERE kind = ? AND idem = ?", [PEPE_KIND, `export-${j.id}-${j.pepe_attempt}`]))[0];
    if (act && act.status === "pending") continue;                          // he hasn't taken it yet (down?) - no pile of asks
    if (t - Number(j.pepe_asked_at || 0) < PEPE_RETRY_MS) continue;         // started (or failed) recently
    if (t - Number(j.pepe_slice_at || 0) < PEPE_SLICE_QUIET_MS) continue;   // review: he is uploading it right now
    await askPepe(j, (Number(j.pepe_attempt) || 0) + 1);
    out.asked++;
  }
  // review: jobs still waiting their turn past PEPE_WAIT_MS (the tick runs only the oldest few): built without his part now
  for (const j of await getQuery("SELECT id FROM account_exports WHERE state = 'queued' AND pepe = 1 AND pepe_state IS NULL AND created < ? ORDER BY created LIMIT 20",
                                 [t - PEPE_WAIT_MS])) { out.gave_up++; await run(j.id); }
  return out;
}

/** Interrupted jobs run again; expired files go. */
async function tick() {
  await init();
  for (const j of await getQuery("SELECT id FROM account_exports WHERE state = 'running' AND created < ?", [now() - 30 * 60000])) {
    if (running.has(j.id)) continue;                     // mic retention: still being built here (a job that waited for Pepe is older)
    await runQuery("UPDATE account_exports SET state = 'queued' WHERE id = ? AND state = 'running'", [j.id]);
  }
  // (1.99acm: new jobs before the ones waiting for the chat hub; mic retention: the ones waiting for Pepe are pepeTick's; review:
  //  the ones waiting their turn to ask him (PEPE_JOBS_MAX) last, oldest first)
  for (const j of await getQuery(`SELECT id FROM account_exports WHERE state = 'queued' AND (pepe_state IS NULL OR pepe_state <> 'wait')
                                  ORDER BY (hub_wait_since IS NOT NULL), (pepe = 1 AND pepe_state IS NULL), created LIMIT 5`)) await run(j.id);
  try { await pepeTick(); } catch (e) { console.error("[export] pepe tick:", e.message); }
  for (const j of await getQuery("SELECT id, file FROM account_exports WHERE state = 'ready' AND expires <= ?", [now()])) {
    if (j.file) { try { fs.unlinkSync(path.join(dir(), path.basename(j.file))); } catch (e) { /* gone */ } }
    await runQuery("UPDATE account_exports SET state = 'expired', file = NULL WHERE id = ?", [j.id]);
  }
  await sweepFiles();
}

/** review: files no job owns - Pepe's pieces of jobs that aren't waiting any more (a crash between the zip and the cleanup), a zip
 *  no READY row names (a job deleted / expired while it was built, a crash before its row was written) and an old half-written
 *  zip - once ORPHAN_MS old (a zip is renamed into place moments before its row says ready), never one being built here. */
async function sweepFiles() {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch (e) { names = []; }
  const t = now();
  const age = (n) => { try { return t - fs.statSync(path.join(dir(), n)).mtimeMs; } catch (e) { return 0; } };
  for (const n of names) {
    let m = /^([a-f0-9]{32})\.pepe$/.exec(n);
    if (m) {
      const j = (await getQuery("SELECT state FROM account_exports WHERE id = ?", [m[1]]))[0];
      if (!j || !(j.state === "queued" || j.state === "running")) rmPepe(m[1]);
      continue;
    }
    m = /^([a-f0-9]{32})\.zip(\.tmp-.*)?$/.exec(n);
    if (!m || running.has(m[1]) || age(n) < ORPHAN_MS) continue;
    const owned = !m[2] && (await getQuery("SELECT 1 FROM account_exports WHERE id = ? AND state = 'ready' AND file = ?", [m[1], n]))[0];
    if (!owned) { try { fs.unlinkSync(path.join(dir(), n)); } catch (e) { /* gone */ } }
  }
}

/** Every export file of an account goes (account deletion). */
async function removeAll(userId) {
  await init();
  for (const j of await getQuery("SELECT id, file FROM account_exports WHERE user_id = ?", [String(userId)])) {
    if (j.file) { try { fs.unlinkSync(path.join(dir(), path.basename(j.file))); } catch (e) { /* gone */ } }
    rmPepe(j.id);                                           // mic retention: Pepe's pieces too
    await withdrawAsks(j.id, "the account was deleted");
  }
  await runQuery("UPDATE account_exports SET state = 'expired', file = NULL WHERE user_id = ? AND state IN ('queued','running','ready')", [String(userId)]);
}

async function mine(userId) {
  await init();
  const rows = await getQuery(`SELECT id, created, state, bytes, finished, expires,
                                      CASE WHEN pepe_state = 'wait' OR (pepe = 1 AND pepe_state IS NULL AND state IN ('queued','running')) THEN 1 ELSE 0 END AS waiting_pepe,
                                      pepe_summary FROM account_exports WHERE user_id = ? ORDER BY created DESC LIMIT 5`, [String(userId)]);
  // mic retention: older recordings that didn't fit -> the form offers "Only recordings before" that day (ms; review: a plausible
  // time only - Pepe's value is never trusted into a date)
  return rows.map((r) => {
    const nb = cleanSec((parseJson(r.pepe_summary, {}) || {}).next_before);
    const out = { ...r, next_before: nb ? nb * 1000 : null };
    delete out.pepe_summary;
    return out;
  });
}

/** mic retention: the admin card (micrec.adminView) - counts only. */
async function pepeStatus() {
  await init();
  const r = (await getQuery(`SELECT SUM(CASE WHEN state IN ('queued','running') AND pepe_state = 'wait' THEN 1 ELSE 0 END) AS waiting,
                                    SUM(CASE WHEN state IN ('queued','running') AND pepe = 1 AND pepe_state IS NULL THEN 1 ELSE 0 END) AS held,
                                    SUM(CASE WHEN rec = 1 AND state IN ('queued','running') THEN 1 ELSE 0 END) AS rec_inflight,
                                    COALESCE(SUM(CASE WHEN rec = 1 AND state = 'ready' THEN bytes ELSE 0 END), 0) AS rec_ready_bytes,
                                    SUM(CASE WHEN pepe_state = 'gave_up' AND created > ? THEN 1 ELSE 0 END) AS gave_up_7d
                             FROM account_exports`, [now() - 7 * DAY]))[0] || {};
  return { waiting: Number(r.waiting) || 0, held: Number(r.held) || 0, pepe_jobs_max: PEPE_JOBS_MAX, rec_inflight: Number(r.rec_inflight) || 0,
           rec_ready_bytes: Number(r.rec_ready_bytes) || 0, gave_up_7d: Number(r.gave_up_7d) || 0, rec_max: PEPE_ZIP_MAX, rec_jobs_max: REC_JOBS_MAX,
           rec_disk_max: REC_DISK_MAX };
}

// ── Pepe's zip (bot token; bot 1.99afq pepe_mydata._md_upload): POST /api/privacy/export/bot/chunk, /finish ──
class Refuse extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const SHA_RE = /^[0-9a-f]{64}$/;
const pepeZip = (id) => path.join(pepeDir(id), "pepe-data.zip");
const chains = new Map();                                    // export id -> its slices in progress (one at a time per export)
function serial(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return p;
}
const int =(v) => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN);
/** The job a slice / finish is for - only one waiting for Pepe; else E_GONE (Pepe stops). */
async function waitingJob(b) {
  const id = String(b.id || "");
  if (!ID_RE.test(id)) throw new Refuse(400, "E_BAD", "bad export id");
  const j = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
  if (!j || j.state !== "queued" || j.pepe_state !== "wait") throw new Refuse(409, "E_GONE", "this download isn't waiting for Pepe");
  return j;
}
/** One slice of Pepe's zip {id, seq, total, size, sha256, data}. -> {ok, have, total, dup?} */
async function putChunk(b) {
  await init();
  const j = await waitingJob(b);
  const seq = int(b.seq), total = int(b.total), size = int(b.size), sha = String(b.sha256 || "").toLowerCase();
  if (!SHA_RE.test(sha)) throw new Refuse(400, "E_BAD", "sha256 must be 64 hex");
  if (!(size >= 1 && size <= PEPE_ZIP_MAX)) throw new Refuse(413, "E_CAP", `Pepe's part is at most ${Math.round(PEPE_ZIP_MAX / MB)} MB`);
  if (!(total >= Math.ceil(size / SLICE_MAX) && total >= 1 && total <= Math.ceil(size / 1024) + 1)) throw new Refuse(400, "E_BAD", "bad slice count");
  if (!(seq >= 0 && seq < total)) throw new Refuse(400, "E_BAD", "bad slice number");
  if (typeof b.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) throw new Refuse(400, "E_BAD", "data must be base64");
  const buf = Buffer.from(b.data, "base64");
  if (!buf.length || buf.length > SLICE_MAX) throw new Refuse(400, "E_BAD", `a slice is 1..${SLICE_MAX} bytes`);
  return serial(j.id, async () => {
    const d = path.join(pepeDir(j.id), sha);
    // a different build (another sha256) replaces an earlier one's slices (and its count of staged bytes)
    let replaced = false;
    try {
      for (const e of await fs.promises.readdir(pepeDir(j.id))) {
        if (e !== sha && SHA_RE.test(e)) { await fs.promises.rm(path.join(pepeDir(j.id), e), { recursive: true, force: true }); replaced = true; }
      }
    } catch (e) { /* none */ }
    if (replaced) await runQuery("UPDATE account_exports SET pepe_bytes = 0 WHERE id = ?", [j.id]);
    await fs.promises.mkdir(d, { recursive: true, mode: 0o700 });
    const metaF = path.join(d, "meta.json");
    const meta = parseJson(await fs.promises.readFile(metaF, "utf8").catch(() => null), null);
    if (meta && (meta.total !== total || meta.size !== size)) throw new Refuse(409, "E_SEQ", "that upload was started with another size / slice count");
    const part = path.join(d, "p" + seq);
    const have = await fs.promises.readFile(part).catch(() => null);
    if (have) {
      if (sha256(have) !== sha256(buf)) throw new Refuse(409, "E_SEQ", `slice ${seq} was already sent with different data`);
      return { ok: true, dup: true };
    }
    // the disk: every ready export + what's staged now
    const ready = Number((await getQuery("SELECT COALESCE(SUM(bytes), 0) AS b FROM account_exports WHERE state = 'ready'"))[0].b) || 0;
    const staged = Number((await getQuery("SELECT COALESCE(SUM(pepe_bytes), 0) AS b FROM account_exports WHERE pepe_state = 'wait' AND state IN ('queued','running')"))[0].b) || 0;
    if (ready + staged + buf.length > EXPORT_DISK_MAX) throw new Refuse(507, "E_FULL", "no room for more downloads right now");
    if (!meta) await fs.promises.writeFile(metaF, JSON.stringify({ total, size }), { mode: 0o600 });
    await fs.promises.writeFile(part, buf, { mode: 0o600 });
    // review: counted as it comes (never a re-stat of every slice), and when - an upload in progress is never asked again
    await runQuery("UPDATE account_exports SET pepe_bytes = COALESCE(pepe_bytes, 0) + ?, pepe_slice_at = ? WHERE id = ?", [buf.length, now(), j.id]);
    return { ok: true };
  });
}
/** Pepe is done: {id, ok: true, size, sha256, name, parts, counts, left_out, next_before, truncated, before} - the slices are joined
 *  and checked (size, sha256, a zip) into pepe-data.zip - or {id, ok: false, error}: the download is made without his part. Either
 *  way the job builds the zip now. -> {ok, expires_at} */
async function finish(b) {
  await init();
  const j = await waitingJob(b);
  return serial(j.id, async () => {
    const summary = {};
    for (const k of ["parts", "counts", "left_out", "truncated"]) if (b[k] !== undefined) summary[k] = b[k];
    // review: his times are checked before anything makes a date of them (an implausible one is dropped, never a throw later)
    for (const k of ["next_before", "before"]) { const v = cleanSec(b[k]); if (v) summary[k] = v; }
    let err = null;
    if (b.ok !== true) err = String(b.error || "failed").replace(/[\r\n\t]+/g, " ").slice(0, 200);
    else {
      const sha = String(b.sha256 || "").toLowerCase(), size = int(b.size);
      if (!SHA_RE.test(sha) || !(size >= 1)) throw new Refuse(400, "E_BAD", "size and sha256, please");
      const d = path.join(pepeDir(j.id), sha);
      const meta = parseJson(await fs.promises.readFile(path.join(d, "meta.json"), "utf8").catch(() => null), null);
      if (!meta || meta.size !== size) throw new Refuse(409, "E_SEQ", "no upload of that size / sha256");
      const missing = [];
      for (let i = 0; i < meta.total; i++) if (!(await fs.promises.stat(path.join(d, "p" + i)).catch(() => null))) missing.push(i);
      if (missing.length) throw new Refuse(409, "E_SEQ", `missing slice(s) ${missing.slice(0, 20).join(", ")}`);
      // review: joined and hashed slice by slice, asynchronously (≤ 1 MB each) - never hundreds of MB on the event loop at once
      const out = pepeZip(j.id), tmp = out + ".tmp";
      const fh = await fs.promises.open(tmp, "w", 0o600);
      const h = crypto.createHash("sha256");
      let joined = 0, head = null;
      try {
        for (let i = 0; i < meta.total; i++) {
          const p = await fs.promises.readFile(path.join(d, "p" + i));
          if (!head) head = p.subarray(0, 4);
          h.update(p);
          let o = 0;
          while (o < p.length) { const { bytesWritten } = await fh.write(p, o, p.length - o, joined + o); o += bytesWritten; }
          joined += p.length;
        }
      } finally { await fh.close(); }
      if (joined !== size || h.digest("hex") !== sha || !head || head.length < 4 || head.readUInt32LE(0) !== 0x04034b50) {
        await fs.promises.rm(d, { recursive: true, force: true });
        await fs.promises.unlink(tmp).catch(() => {});
        await runQuery("UPDATE account_exports SET pepe_bytes = 0 WHERE id = ?", [j.id]);
        throw new Refuse(400, "E_SHA", "the slices don't make that file (size / sha256 / not a zip) - send it again");
      }
      await fs.promises.rename(tmp, out);
      await fs.promises.rm(d, { recursive: true, force: true });
      summary.size = size;
    }
    const r = await runQuery("UPDATE account_exports SET pepe_state = 'done', pepe_summary = ?, pepe_error = ?, pepe_bytes = ? WHERE id = ? AND pepe_state = 'wait'",
                             [JSON.stringify(summary).slice(0, 20000), err, summary.size || 0, j.id]);
    if (!r || !r.changes) throw new Refuse(409, "E_GONE", "this download isn't waiting for Pepe");
    await withdrawAsks(j.id, "Pepe's part arrived");
    setImmediate(() => run(j.id).catch((e) => console.error("[export] run:", e.message)));
    return { ok: true, expires_at: now() + EXPORT_TTL_MS };
  });
}

let timer = null;
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[export] init:", e.message));
  if (!timer) {
    timer = setInterval(() => tick().catch((e) => console.error("[export] tick:", e.message)), TICK_MS);
    if (timer.unref) timer.unref();
    setTimeout(() => tick().catch(() => {}), 20000).unref();
  }
  const express = require("express");
  const sameOrigin = (req) => { const s = req.get("origin") || req.get("referer"); try { return !!s && new URL(s).host === req.get("host"); } catch (e) { return false; } };
  app.get("/api/account/export", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try {
      const o = await offer(req.user.userId);
      // review: whether a download with Pepe's part needs the password now (no sign-in in the last 10 minutes), and whether it has one
      res.json({ ok: true, exports: await mine(req.user.userId), ttl_days: EXPORT_TTL_MS / DAY,
                 offer: { pepe: o.pepe, recordings: o.recordings, login_shared: o.login_shared, rec_max_mb: o.rec_max_mb },
                 reauth: { fresh: await require("./sessions").isFresh(req), password: await hasPassword(req.user.userId) } });
    } catch (e) { res.status(500).json({ ok: false }); }
  });
  app.post("/api/account/export", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    if (req.get("X-Requested-With") !== "fetch" || !sameOrigin(req)) return res.status(403).json({ ok: false, error: "cross-site" });
    try {
      const b = req.body || {};
      // review: Pepe's part (recordings, PMs, his notes) needs the deletion flow's re-authentication
      const r = await request(req.user.userId, { parts: b.parts, verify: () => reauth(req, b.password) });
      res.status(r.ok ? 200 : r.code === "E_RATE" || r.code === "E_REC_BUSY" || r.code === "E_REAUTH_LIMIT" ? 429 : r.code === "E_REAUTH" ? 403 : 409).json(r);
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
  // mic retention: Pepe's zip in slices (index.js keeps its global 100 KB parser off /chunk: a slice is ~512 KB of JSON)
  const bot = (req, res) => {
    if (typeof isBotToken !== "function" || !isBotToken((req.body || {}).password)) { res.status(403).json({ ok: false, error: "unauthorized" }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e instanceof Refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[export] pepe upload:", e.message);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/privacy/export/bot/chunk", express.json({ limit: "1mb" }), async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await putChunk(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/export/bot/finish", express.json({ limit: "64kb" }), async (req, res) => {
    if (!bot(req, res)) return;
    try { res.json(await finish(req.body || {})); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, request, run, tick, pepeTick, collect, zip, zipToFile, crc32, removeAll, mine, hubWaits, offer, cleanParts, putChunk, finish,
                   pepeStatus, OMIT, RATE_MS, EXPORT_TTL_MS, PEPE_KIND, PEPE_PARTS, PEPE_RETRY_MS, PEPE_WAIT_MS, PEPE_ZIP_MAX, PEPE_SHOWN_MB, REC_JOBS_MAX,
                   REC_DISK_MAX, EXPORT_DISK_MAX, Refuse, PEPE_JOBS_MAX, PEPE_SLICE_QUIET_MS, ORPHAN_MS, REAUTH_TRIES, sweepFiles, reauth, cleanSec,
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _dir: dir, _collects: () => collects, _pepeZip: (id) => pepeZip(id),
                   _resetReauth: () => reauthFails.clear(), _setBeforeReady: (f) => { beforeReady = f || null; } };
