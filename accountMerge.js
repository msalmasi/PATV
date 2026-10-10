// accountMerge.js — move everything one PATV account owns to another.
//
// Every account merge uses it: the Twitch / Discord conflict merge (providermerge.js), the duplicate
// merge (staleaccounts.mergeDuplicate) and the Camfrog !verify merge (user.controller completeCamfrogLink).
// "Users should lose no data in a merge" (1.99gb): before, a hand-kept list of ~30 table.columns moved
// and everything else (posts, comments, votes, follows, stories, stage slots, rooms, royalties, DMs, the
// welcome bonus...) stayed behind under a deleted userId.
//
// How it stays complete:
//   * the columns are DISCOVERED from the live schema (pragma_table_info over every table): a column whose
//     NAME says it may hold a userId (CANDIDATE: *user_id / *userId, owner*, author_id, follower, target*,
//     counterparty, *_by / by*, payer*, sender_id, buyer_id, ...) is merged by the rule RULES gives it;
//   * every candidate column must be CLASSIFIED - a merge rule, "keep" (the old id stays on purpose: the
//     archive and the merge log), "special" (a dedicated step below) or a DENY reason (names, kinds, flags,
//     free text: not a userId). test/merge-coverage.test.js fails when a table in the code or in the schema
//     snapshot (test/fixtures/schema.sql) has an unclassified candidate column. At runtime an unclassified
//     one is still moved (UPDATE OR IGNORE - nothing deleted) and logged;
//   * profile pads (rooms_registry "user:<userId>") and DM conversations (dm_key "<id>|<id>") embed the
//     userId inside other values: special steps below;
//   * after the moves every merged column is counted again: whatever is still on the old id is reported in
//     the merge log ("left_over") instead of being silently lost.
//
// Unique-constraint collisions (both accounts have the same badge, follow the same person, voted on the
// same post, sit in the same group chat...): the target's row is kept and the old one's values are folded
// into it per the rule's `merge` (earliest award / follow date, the higher "read up to", summed counters, a
// ban or an approval only the old account had...), then the old duplicate goes. Self-references the merge
// creates (following / blocking yourself, a DM with yourself) are cleaned up; votes are re-counted.
//
// The caller runs this INSIDE its transaction (BEGIN IMMEDIATE on the shared connection); this module never
// begins or commits one. archiveMerged() + logMerge() write the account_archive snapshot of the old row and
// the per-table counts (account_merge_log); afterMerge() refreshes in-memory caches once it has committed.
//
// Escrow held by Pepe (wagers, markets, bounties, heist sheets, loans: wallet_snapshots JSON) is keyed by
// Camfrog LOGIN, not userId - nothing in it names the old userId. An account with anything in flight is
// refused before a provider merge (staleaccounts.holdsFor, providermerge.js) and merged by staff.
"use strict";
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

// ── which columns can hold a userId (by name) ───────────────────────────────────────────────────────────
const CANDIDATE = [
  /user_?id$/i,                                    // userId, user_id, owner_user_id, subject_user_id, by_user_id...
  /^(owner|author|payer|payee|buyer|seller|sender|recipient|blocker|blocked|reporter|admin|viewer|streamer|adder|from|to|target|subject|creator|follower|counterparty|actor|winner|lender|borrower|holder|member|player|uid|who|by)(_?id)?$/i,
  /_by$/i, /^by_/i,                                // created_by, posted_by, decided_by, by_login...
  /^owner_/i, /_owner$/i, /^(from|to)_/i,
  /^(author|payer|buyer|seller|sender|reporter|admin|viewer|streamer|adder|target|subject|creator)_/i,
];
const isCandidate = (col) => CANDIDATE.some((r) => r.test(String(col)));

// Columns that hold a userId although their name doesn't say so.
const EXTRA = ["rooms_kv.value", "premium_subs.renewer_id", "premium_subs.stripe_user"];   // "seeded:<room>" -> the owner it was seeded for

// Columns that hold a ROOM id: a profile pad's id is "user:<userId>" (rooms.js PROFILE_PREFIX).
const ROOM_COLUMNS = /^(room_id|home_pad|room|pad)$/i;
const ROOM_EXTRA = ["follows.target_id"];   // follows of kind 'room'
const PROFILE = (id) => "user:" + id;

// ── the classification ──────────────────────────────────────────────────────────────────────────────────
// "table.column" -> rule:
//   {move: true, key?, merge?, name?}  UPDATE OR IGNORE to the target. With `key` (the OTHER columns of the
//       unique key; [] = one row per user) rows that collide are folded into the target's row (merge:
//       {col: op}) and the old duplicate is deleted. name: a username column next to the id, renamed to
//       the target's username where it still says the old one.
//       ops: MIN / MAX / SUM / OLD_IF_NULL (the target's value unless NULL) / NULL_WINS (NULL = forever or
//       still active wins, else the later) / {rank: [best ... worst]}
//   {special: "why"}  moved by a dedicated step (still re-counted)
//   {keep: "why"}     the old id stays on purpose
//   {deny: "why"}     not a userId
const NAME = "a name / login label, not a userId";
const FLAG = "a flag or a kind, not a userId";
const TEXT = "free text, not a userId";
const M = (o) => Object.assign({ move: true }, o || {});

const RULES = {
  // ledger
  "transactions.userId": M(), "transactions.counterparty": M(),
  "bonus_winners.userId": M(), "reserve_claims.userId": M(), "jackpot_rakes.userId": M(), "wheel_spins.userId": M(),
  "blackjack.userId": M(), "poker_cashier.userId": M(), "poker_now_games.userId": M(), "user_redemptions.userId": M({ key: ["code"] }),
  "pat_burns.actor": M(), "pat_burns.actor_kind": { deny: FLAG },
  "econ_charges.payer": M(), "econ_charges.payer_kind": { deny: FLAG },
  "room_flow_ledger.payer_id": M(), "room_flow_ledger.payer_name": { deny: NAME }, "room_flow_ledger.owner_self": { deny: FLAG },
  "royalty_ledger.owner_user_id": M(),
  "royalty_runs.owner_user_id": M({ key: ["room_id", "period"], merge: { amount: "SUM" } }),
  "levelup_rewards.userId": M({ key: ["level"], merge: { paid: "MAX" } }),
  "levelup_milestones.userId": M({ key: ["level"], merge: { paid: "MAX", paid_at: "OLD_IF_NULL" } }),
  "cosmetic_transfers.from_id": M(), "cosmetic_transfers.to_id": M(),
  "account_archive.userId": { keep: "the old account's archive snapshot (written by the merge)" },
  "account_archive.reclaimed": { deny: "a PAT amount" },
  "account_merge_log.from_id": { keep: "the merge log names the old account" },
  "account_merge_log.to_id": { keep: "the merge log (the target)" },
  "account_merge_log.from_username": { deny: NAME }, "account_merge_log.to_username": { deny: NAME },
  // achievements / badges / cosmetics / roles
  "user_badges.userId": M({ key: ["badgeId"], merge: { awardedAt: "MIN" } }),
  "user_badge_showcase.user_id": M({ key: [] }),
  // 1.99jo i18n.js: the saved site language (one per account; both have one: the target's stays)
  "user_language.userId": M({ key: [] }),
  "achievement_feed.userId": M(),
  "user_roles.userId": M({ key: ["role"], merge: { granted_at: "MIN" } }), "user_roles.granted_at": { deny: "a date" },
  "user_cosmetics.user_id": M(), "user_cosmetic_equips.user_id": M({ key: ["kind"] }),
  "cosmetic_listings.seller_id": M(), "cosmetic_listings.buyer_id": M(),
  "pad_cosmetic_items.buyer_id": M(), "pad_cosmetic_items.decided_by": M(), "pad_cosmetic_items.buyer_name": { deny: NAME },
  "pad_cosmetic_items.owner_self": { deny: FLAG },
  // 1.99iv premium.js (Prime Time / Season Pass): a Season Pass row's target IS the userId (a Prime Time row's is a room
  // id, which never equals a userId, so the move leaves it alone); both accounts with a pass: the later dates win
  "premium_subs.target": M({ key: ["tier"], merge: { paid_through: "MAX", stripe_through: "MAX", comped: "MAX" } }),
  "premium_subs.renewer_id": M(), "premium_subs.stripe_user": M(), "premium_subs.comp_by": { deny: NAME },
  "premium_ledger.target": M(), "premium_ledger.payer_id": M(), "premium_ledger.payer_name": { deny: NAME },
  // 1.99iw stickers.js: packs owned (both own a pack: one row stays)
  "user_sticker_packs.user_id": M({ key: ["pack_id"] }), "user_sticker_packs.payer_id": M(),
  // shop / markets / bounties / Pepe
  "shop_orders.buyer_id": M(), "shop_orders.seller_id": M(), "shop_orders.buyer_input": { deny: TEXT },
  "shop_orders.seller_note": { deny: TEXT }, "shop_orders.seller_paid": { deny: FLAG }, "shop_orders.dispute_from": { deny: FLAG },
  "shop_order_events.actor": M(), "shop_prefs.user_id": M({ key: [] }),
  "prizes.seller_id": M(), "prizes.buyer_prompt": { deny: TEXT },
  "market_orders.user_id": M({ name: "username" }), "market_orders.site_admin": { deny: FLAG },
  "bounty_actions.user_id": M({ name: "username" }), "bounty_actions.site_admin": { deny: FLAG },
  "pepe_actions.user_id": M({ key: ["idem"], name: "username" }), "pepe_actions.site_admin": { deny: FLAG },
  "pepe_control_audit.userId": M(), "pepe_control_cmds.userId": M(),
  // inbox / prefs / onboarding
  "inbox.user_id": M({ key: ["ref"] }), "inbox_prefs.user_id": M({ key: ["kind"] }),
  "profile_layout.user_id": M({ key: [] }), "tipjar_seen.userId": M({ key: [] }),
  "mention_prefs.user_id": M({ key: [] }), "mention_words.user_id": M({ key: ["phrase", "room_id"] }),   // 1.99ii: mentions.js
  "welcome_bonus.userId": { special: "welcome bonus states are combined (mergeWelcome)" },
  "welcome_keys.userId": M({ key: ["k"], merge: { created: "MIN" } }),
  "welcome_activity.userId": M({ key: ["day"] }),
  "stale_notice.userId": M({ key: [] }), "stale_notice.login": { deny: NAME },
  "pending_camfrog_links.userId": M(), "displayname_log.userId": M(), "displayname_log.actor": M(),
  "displayname_log.by_admin": { deny: FLAG },
  // feed
  "feed_posts.author_id": M(), "feed_posts.deleted_by": M(), "feed_posts.locked_by": M(), "feed_posts.nsfw_admin": { deny: FLAG },
  "feed_comments.author_id": M(), "feed_comments.deleted_by": M(),
  "feed_votes.user_id": M({ key: ["post_id"] }), "feed_comment_votes.user_id": M({ key: ["comment_id"] }),
  "feed_attachments.owner_id": M(), "feed_aigen_jobs.user_id": M({ name: "username" }),
  "feed_automod.author_id": M(), "feed_automod.reversed_by": M(), "feed_automod.target": M({ key: [] }),
  "feed_bans.user_id": M({ key: ["room_id"], merge: { until: "NULL_WINS" }, name: "username" }), "feed_bans.by": M(),
  "feed_room_members.user_id": M({ key: ["room_id"], name: "username" }), "feed_room_members.by": M(),
  "feed_room_report_done.by": M(),
  "feed_post_rooms.removed_by": M(), "feed_post_rooms.pinned_by": M(), "feed_post_rooms.hidden_by": M(), "feed_post_rooms.approved_by": M(),
  "feed_quotes.created_by": M(), "feed_quotes.logins": { deny: NAME },
  "feed_voices.removed_by": M(), "feed_voices.by_login": { deny: NAME }, "feed_voices.logins": { deny: NAME },
  "feed_post_tags.removed_by": { deny: NAME },       // 1.99iq: the mod's username (feedtags.js)
  // 1.99ir: pad flair (padflair.js) - who wears which flair moves with the account (one per pad: the target's wins)
  "pad_user_flairs.user_id": M({ key: ["room_id"] }), "pad_user_flairs.set_by": { deny: NAME }, "pad_flairs.created_by": { deny: NAME },
  "feed_reports.reporter_id": M({ key: ["post_id", "comment_id"] }), "feed_reports.resolved_by": M(),
  "feed_seen.user_id": M({ key: ["scope"], merge: { upto: "MAX" } }), "feed_view.user_id": M({ key: ["scope"] }),
  "pepe_feed_log.by": M(), "pepe_feed_log.target": M(), "pepe_feed_mutes.by": M(), "pepe_feed_seen.target": M({ key: [] }),
  "user_reports.target_id": M(), "user_reports.reporter_id": M(), "user_reports.resolved_by": M(),
  "image_safety_log.user_id": M(), "image_safety_log.reviewed_by": M(),
  "content_audit.user_id": M(), "content_audit.target_id": M(),
  "content_audit_views.admin_id": M(), "content_audit_views.target_id": M(), "content_audit_views.subject_id": M(),
  "content_audit_views.admin_name": { deny: NAME }, "content_audit_views.target_kind": { deny: FLAG },
  "admin_audit.admin_id": M(), "admin_audit.target_id": M(), "admin_audit.admin_name": { deny: NAME }, "admin_audit.target_name": { deny: NAME },
  "help_misses.user_id": M(), "bridge_cmd_log.user_id": M(),
  "media.by_user_id": M(), "media.by_user": { deny: NAME }, "media.subject": { deny: NAME }, "media.subject_login": { deny: NAME },
  // follows
  "follows.follower": M({ key: ["target_kind", "target_id"], merge: { created_at: "MIN" } }),
  "follows.target_id": M({ key: ["follower", "target_kind"], merge: { created_at: "MIN" } }),
  "follows.target_kind": { deny: FLAG }, "follow_prefs.user_id": M({ key: [], merge: { notify_posts: "MAX" } }),
  // stories
  "story_posts.author_id": M(), "story_posts.posted_by": M(), "story_posts.subject_user_id": M(), "story_posts.removed_by": M(),
  "story_posts.subject_login": { deny: NAME }, "story_posts.subject_name": { deny: NAME },
  "story_prefs.user_id": M({ key: [] }), "story_hides.user_id": M({ key: ["capture_id"] }),
  "story_saves.user_id": M({ key: ["capture_id"] }), "story_saves.subject": { deny: NAME }, "story_saves.by_name": { deny: NAME },
  "story_seen.user_id": M({ key: ["room_id"], merge: { upto: "MAX", updated: "MAX" } }),
  // stage / rooms / pads
  "stage_slots.userId": M({ name: "username" }), "stage_slots.ended_by": M(), "stage_slots.feature_by": M(), "stage_slots.approved_by": M(),
  "stage_queue.userId": M({ name: "username" }), "stage_captures.user_id": M({ name: "username" }),
  // 1.99ji: Plex / media (medialib.js, mediarequests.js, mediainvites.js)
  "media_plays.user_id": M({ name: "username" }), "media_sessions.by_user": { deny: NAME },
  "media_requests.user_id": M({ name: "username" }), "media_requests.mapped_by": { deny: FLAG },
  "media_credits.user_id": M({ key: ["kind"], merge: { n: "SUM" } }),
  "media_user_links.user_id": M({ key: [] }), "media_user_links.set_by": { deny: NAME },
  "media_invites.user_id": M({ name: "username" }), "media_invites.done_by": { deny: NAME },
  "stage_events.actor": M(), "room_events.actor": M(),
  "stage_bans.userId": M({ key: [], name: "username" }), "stage_bans.by": M(),
  "stage_room_bans.userId": M({ key: ["room_id"], name: "username" }), "stage_room_bans.by": M(),
  "rooms_registry.owner_user_id": M(), "rooms_registry.owner_kind": { deny: FLAG },
  "rooms_kv.value": M(),
  "pad_members.user_id": M({ key: ["room_id"], merge: { status: { rank: ["approved", "pending", "denied", "removed"] } } }),
  "pad_members.decided_by": M(), "pad_access.updated_by": M(), "pad_looks.updated_by": M(),
  "restream_dest.owner": M({ key: [] }), "restream_dest.by": M(),
  "restream_toggles.target": M({ key: [] }), "restream_toggles.by": M(),
  "econ_watch.streamer_id": M(), "econ_watch.viewer_id": M({ key: ["day", "stream"], merge: { secs: "SUM", muted_secs: "SUM", beats: "SUM" } }),
  "econ_watch_keys.viewer_id": M({ key: ["day", "stream", "k"] }),
  "pad_slug_aliases.by": M(),      // 1.99iy: who changed a pad's address (padaddress.js) - a username, moved like the other "by"s
  "rooms_registry.created_by": M(),   // 1.99iz: who made a member-made pad (padcreate.js); the owner column has its own rule
  "pad_connections.requested_by": M(), "pad_connections.verified_by": M(), "pad_connections.join_by": M(),   // 1.99ja: platform connections (padconnect.js)
  "room_vault_settings.changed_by": M(), "room_vault_rate_log.by": M(),      // economy v2 E-3 (roomvaults.js): who set a pad's payout rate
  // the pad launchpad (launchpad.js): one newcomer welcome per person (folded), visits per pad per day; admins by name
  "launchpad_welcomes.user_id": M({ key: [] }), "launchpad_visits.user_id": M({ key: ["room_id", "day"] }),
  "launchpad_pads.enrolled_by": { deny: NAME }, "launchpad_grads.decided_by": { deny: NAME },
  // direct messages
  "conversations.created_by": M(),
  "conversation_members.user_id": { special: "DM conversations and memberships are merged first (mergeConversations)" },
  "messages.sender_id": M(), "messages.deleted_by": M(),
  "dm_member_adds.adder_id": M(), "dm_member_adds.user_id": M(),
  "dm_blocks.blocker_id": M({ key: ["blocked_id"] }), "dm_blocks.blocked_id": M({ key: ["blocker_id"] }),
  "dm_prefs.user_id": M({ key: [] }), "dm_prefs.who": { deny: "a setting ('everyone' / 'following' / 'nobody')" },
  "dm_alerts.user_id": M({ key: ["conversation_id"], merge: { pending: "SUM", first_at: "MIN", last_msg_id: "MAX", last_alert_at: "MAX" } }),
  "dm_reports.sender_id": M(), "dm_reports.reporter_id": M({ key: ["message_id"] }), "dm_reports.resolved_by": M(),
  "dm_media.owner_id": M(),
  "pepe_dm_jobs.user_id": M(),               // 1.99ik: messages to Pepe waiting for his answer
};

/** The rule for one column: its RULES entry, else null (an unclassified candidate). */
function classify(table, column) {
  return RULES[`${table}.${column}`] || null;
}

async function tableExists(t) {
  return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
}
async function columnsOf(t) {
  return (await getQuery("SELECT name FROM pragma_table_info(?)", [t]).catch(() => [])).map((c) => c.name);
}
async function allTables() {
  return (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
}

/** Every table.column of the live database that may hold a userId: [{table, column, rule}]. */
async function discover() {
  const out = [];
  for (const table of await allTables()) {
    if (table === "users") continue;
    for (const column of await columnsOf(table)) {
      const k = `${table}.${column}`;
      if (!isCandidate(column) && !EXTRA.includes(k) && !RULES[k]) continue;
      out.push({ table, column, rule: classify(table, column) });
    }
  }
  return out;
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// The folded value: T = the target's row (the outer table), O = the old account's colliding row (alias o).
function foldExpr(table, col, op) {
  const T = `${q(table)}.${q(col)}`, O = `o.${q(col)}`;
  if (op && op.rank) {
    const r = (x) => `(CASE ${x} ${op.rank.map((v, i) => `WHEN '${String(v).replace(/'/g, "''")}' THEN ${i}`).join(" ")} ELSE ${op.rank.length} END)`;
    return `CASE WHEN ${r(O)} < ${r(T)} THEN ${O} ELSE ${T} END`;
  }
  switch (op) {
    case "MIN": return `CASE WHEN ${T} IS NULL OR (${O} IS NOT NULL AND ${O} < ${T}) THEN ${O} ELSE ${T} END`;
    case "MAX": return `CASE WHEN ${T} IS NULL OR (${O} IS NOT NULL AND ${O} > ${T}) THEN ${O} ELSE ${T} END`;
    case "SUM": return `COALESCE(${T}, 0) + COALESCE(${O}, 0)`;
    case "OLD_IF_NULL": return `COALESCE(${T}, ${O})`;
    case "NULL_WINS": return `CASE WHEN ${T} IS NULL OR ${O} IS NULL THEN NULL WHEN ${O} > ${T} THEN ${O} ELSE ${T} END`;
    default: throw new Error(`accountMerge: unknown merge op ${JSON.stringify(op)}`);
  }
}

/** Move one column. -> {moved, folded, left} */
async function moveColumn(table, column, rule, fromId, toId, names) {
  const cols = new Set(await columnsOf(table));
  if (!cols.has(column)) return { moved: 0, folded: 0, left: 0 };
  const r = await runQuery(`UPDATE OR IGNORE ${q(table)} SET ${q(column)} = ? WHERE ${q(column)} = ?`, [toId, fromId]);
  const moved = (r && r.changes) || 0;
  let folded = 0;
  let left = (await getQuery(`SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${q(column)} = ?`, [fromId]))[0].n;
  if (left && rule && rule.key) {
    // the old account's rows that collide with one the target already has (same key): fold, then drop
    const key = rule.key.filter((k) => cols.has(k));
    const match = key.map((k) => `o.${q(k)} IS ${q(table)}.${q(k)}`).concat([`o.${q(column)} = ?`]).join(" AND ");
    for (const [c, op] of Object.entries(rule.merge || {})) {
      if (!cols.has(c)) continue;
      await runQuery(`UPDATE ${q(table)} SET ${q(c)} = (SELECT ${foldExpr(table, c, op)} FROM ${q(table)} o WHERE ${match})
                      WHERE ${q(column)} = ? AND EXISTS (SELECT 1 FROM ${q(table)} o WHERE ${match})`, [fromId, toId, fromId]);
    }
    const d = await runQuery(`DELETE FROM ${q(table)} WHERE ${q(column)} = ? AND EXISTS (SELECT 1 FROM ${q(table)} t2 WHERE t2.${q(column)} = ?
                              ${key.map((k) => `AND t2.${q(k)} IS ${q(table)}.${q(k)}`).join(" ")})`, [fromId, toId]);
    folded = (d && d.changes) || 0;
    if (folded) left = (await getQuery(`SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${q(column)} = ?`, [fromId]))[0].n;
  }
  if (rule && rule.name && cols.has(rule.name) && names && names.from && names.to) {
    await runQuery(`UPDATE ${q(table)} SET ${q(rule.name)} = ? WHERE ${q(column)} = ? AND ${q(rule.name)} = ?`, [names.to, toId, names.from]);
  }
  return { moved, folded, left };
}

function bump(out, k, n) { if (n) out.moved[k] = (out.moved[k] || 0) + n; }

// ── special steps ───────────────────────────────────────────────────────────────────────────────────────

/** Direct messages: the old account's 1:1 conversations get the target's dm_key; a conversation the target
 *  already has with that person absorbs it (messages, alerts, reports... move; the other person's two
 *  memberships fold); a DM between the two merged accounts becomes a one-member "notes" group (its
 *  messages are kept). Group chats both accounts were in keep one, folded, membership. */
async function mergeConversations(fromId, toId, out) {
  if (!(await tableExists("conversations")) || !(await tableExists("conversation_members"))) return;
  const convTables = [];
  for (const t of await allTables()) if (t !== "conversation_members" && (await columnsOf(t)).includes("conversation_id")) convTables.push(t);
  const dms = await getQuery("SELECT id, dm_key FROM conversations WHERE dm_key IS NOT NULL AND (dm_key LIKE ? OR dm_key LIKE ?)",
                             [`${fromId}|%`, `%|${fromId}`]);
  for (const c of dms) {
    const ids = String(c.dm_key).split("|");
    if (!ids.includes(fromId)) continue;
    const other = ids[0] === fromId ? ids[1] : ids[0];
    if (other === toId || other === fromId) {
      await runQuery("UPDATE conversations SET kind = 'group', dm_key = NULL, title = COALESCE(title, 'Notes (merged accounts)') WHERE id = ?", [c.id]);
      await runQuery("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [c.id, fromId]);
      bump(out, "conversations (DM between the merged accounts -> notes)", 1);
      continue;
    }
    const key = [toId, other].sort().join("|");
    const have = (await getQuery("SELECT id FROM conversations WHERE dm_key = ?", [key]))[0];
    if (!have) {
      await runQuery("UPDATE conversations SET dm_key = ? WHERE id = ?", [key, c.id]);
      bump(out, "conversations.dm_key", 1);
      continue;
    }
    // the target already talks to `other`: one conversation
    for (const t of convTables) {
      await runQuery(`UPDATE OR IGNORE ${q(t)} SET conversation_id = ? WHERE conversation_id = ?`, [have.id, c.id]);
      await runQuery(`DELETE FROM ${q(t)} WHERE conversation_id = ?`, [c.id]);
    }
    await foldMembers(c.id, have.id, other, other);
    await foldMembers(c.id, have.id, fromId, toId);
    await runQuery("DELETE FROM conversation_members WHERE conversation_id = ?", [c.id]);
    if ((await columnsOf("conversations")).includes("last_msg_id")) {
      await runQuery(`UPDATE conversations SET last_msg_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?),
                      last_msg_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?) WHERE id = ?`, [have.id, have.id, have.id]);
    }
    await runQuery("DELETE FROM conversations WHERE id = ?", [c.id]);
    bump(out, "conversations (joined with the target's DM)", 1);
  }
  // memberships: where both accounts are in the same conversation the target's row absorbs the old one
  const both = await getQuery(`SELECT conversation_id AS id FROM conversation_members WHERE user_id = ?
                               AND conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)`, [fromId, toId]);
  for (const b of both) await foldMembers(b.id, b.id, fromId, toId);
  const r = await runQuery("UPDATE conversation_members SET user_id = ? WHERE user_id = ?", [toId, fromId]);
  bump(out, "conversation_members.user_id", (r && r.changes) || 0);
  if (both.length) out.folded["conversation_members.user_id"] = both.length;
}

/** Fold membership (fromConv, fromUser) into (toConv, toUser): the later read mark, the earlier clear / join,
 *  visible if either was, owner if either was, still a member if either was; then delete it. */
async function foldMembers(fromConv, toConv, fromUser, toUser) {
  const o = (await getQuery("SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [fromConv, fromUser]))[0];
  if (!o) return;
  const t = (await getQuery("SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [toConv, toUser]))[0];
  if (!t) {
    await runQuery("UPDATE conversation_members SET conversation_id = ?, user_id = ? WHERE conversation_id = ? AND user_id = ?", [toConv, toUser, fromConv, fromUser]);
    return;
  }
  const n = (x) => Number(x) || 0;
  const set = {
    role: o.role === "owner" || t.role === "owner" ? "owner" : t.role,
    joined_at: Math.min(n(o.joined_at) || n(t.joined_at), n(t.joined_at) || n(o.joined_at)),
    last_read_id: Math.max(n(o.last_read_id), n(t.last_read_id)),
    cleared_id: Math.min(n(o.cleared_id), n(t.cleared_id)),
    hidden: Math.min(n(o.hidden), n(t.hidden)),
    left_at: o.left_at == null || t.left_at == null ? null : Math.max(n(o.left_at), n(t.left_at)),
  };
  if ("muted" in t) set.muted = Math.min(n(o.muted), n(t.muted));
  const cols = Object.keys(set);
  await runQuery(`UPDATE conversation_members SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE conversation_id = ? AND user_id = ?`,
                 cols.map((c) => set[c]).concat([toConv, toUser]));
  await runQuery("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [fromConv, fromUser]);
}

/** Profile pads: everything on the old account's pad (user:<old>) lands on the target's (user:<new>). The
 *  old pad's registry row becomes the target's pad when it has none, else it goes. */
async function mergeProfilePad(fromId, toId, out) {
  const P = PROFILE(fromId), T = PROFILE(toId);
  const tables = await allTables();
  const hasReg = tables.includes("rooms_registry");
  const oldPad = hasReg ? (await getQuery("SELECT room_id FROM rooms_registry WHERE room_id = ?", [P]))[0] : null;
  const newPad = hasReg ? (await getQuery("SELECT room_id FROM rooms_registry WHERE room_id = ?", [T]))[0] : null;
  if (oldPad && !newPad) {
    await runQuery("UPDATE rooms_registry SET room_id = ?, owner_user_id = ? WHERE room_id = ?", [T, toId, P]);
    bump(out, "rooms_registry.room_id (profile pad)", 1);
  }
  for (const table of tables) {
    if (table === "rooms_registry") continue;
    for (const column of await columnsOf(table)) {
      if (!ROOM_COLUMNS.test(column) && !ROOM_EXTRA.includes(`${table}.${column}`)) continue;
      const r = await runQuery(`UPDATE OR IGNORE ${q(table)} SET ${q(column)} = ? WHERE ${q(column)} = ?`, [T, P]);
      const d = await runQuery(`DELETE FROM ${q(table)} WHERE ${q(column)} = ?`, [P]);   // duplicates of what the target's pad has
      bump(out, `${table}.${column} (profile pad)`, (r && r.changes) || 0);
      if (d && d.changes) out.folded[`${table}.${column} (profile pad)`] = d.changes;
    }
  }
  if (tables.includes("rooms_kv")) {
    await runQuery("UPDATE OR IGNORE rooms_kv SET key = ? WHERE key = ?", ["seeded:" + T, "seeded:" + P]);
    await runQuery("DELETE FROM rooms_kv WHERE key = ?", ["seeded:" + P]);
  }
  if (oldPad && newPad) {
    await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [P]);
    out.folded["rooms_registry.room_id (old profile pad)"] = 1;
  }
}

const WELCOME_RANK = ["paid", "legacy", "paying", "pending", "duplicate", "expired", "gone"];
/** The welcome bonus is once per person: the more advanced state wins (paid > legacy > ... > gone), held
 *  connect bonuses add up, the older start date stays. */
async function mergeWelcome(fromId, toId, out) {
  if (!(await tableExists("welcome_bonus"))) return;
  const o = (await getQuery("SELECT * FROM welcome_bonus WHERE userId = ?", [fromId]))[0];
  if (!o) return;
  const t = (await getQuery("SELECT * FROM welcome_bonus WHERE userId = ?", [toId]))[0];
  if (!t) {
    await runQuery("UPDATE welcome_bonus SET userId = ? WHERE userId = ?", [toId, fromId]);
    bump(out, "welcome_bonus.userId", 1);
    return;
  }
  const rank = (s) => { const i = WELCOME_RANK.indexOf(s); return i < 0 ? WELCOME_RANK.length : i; };
  const win = rank(o.state) < rank(t.state) ? o : t;
  const owed = (Number(o.connect_owed) || 0) + (Number(t.connect_owed) || 0);
  await runQuery(`UPDATE welcome_bonus SET state = ?, decided = ?, amount = ?, reason = ?, dup_of = ?, created = MIN(created, ?), connect_owed = ?
                  WHERE userId = ?`,
                 [win.state, win.decided, win.amount, win === o ? `${o.reason || o.state} (carried over in an account merge)` : t.reason,
                  win.dup_of, Number(o.created) || Date.now(), owed, toId]);
  await runQuery("DELETE FROM welcome_bonus WHERE userId = ?", [fromId]);
  out.folded["welcome_bonus.userId"] = 1;
  if (owed && ["paid", "legacy"].includes(win.state)) out.welcomeOwed = owed;   // paid by afterMerge
}

/**
 * Move every row `fromId` owns to `toId`. Run it INSIDE the caller's transaction. Safe to re-run.
 * opts: {fromUsername, toUsername} (label columns next to an id follow the target's name).
 * -> {moved: {"table.column": n}, folded: {...}, left: {...}, unclassified: [...], recount, welcomeOwed?}
 */
async function moveUserRows(fromId, toId, opts = {}) {
  const out = { moved: {}, folded: {}, left: {}, unclassified: [], recount: { posts: [], comments: [] } };
  if (!fromId || !toId || fromId === toId) return out;
  const names = { from: opts.fromUsername || null, to: opts.toUsername || null };
  if (!names.from || !names.to) {
    for (const r of await getQuery("SELECT userId, username FROM users WHERE userId IN (?, ?)", [fromId, toId])) {
      if (r.userId === fromId) names.from = names.from || r.username; else names.to = names.to || r.username;
    }
  }
  // posts / comments the old account voted on: their cached counts are recomputed afterwards
  if (await tableExists("feed_votes")) out.recount.posts = (await getQuery("SELECT DISTINCT post_id AS id FROM feed_votes WHERE user_id = ?", [fromId])).map((r) => r.id);
  if (await tableExists("feed_comment_votes")) out.recount.comments = (await getQuery("SELECT DISTINCT comment_id AS id FROM feed_comment_votes WHERE user_id = ?", [fromId])).map((r) => r.id);

  await mergeConversations(fromId, toId, out);
  await mergeProfilePad(fromId, toId, out);
  await mergeWelcome(fromId, toId, out);

  for (const { table, column, rule } of await discover()) {
    if (rule && (rule.deny || rule.keep || rule.special)) continue;
    if (!rule) out.unclassified.push(`${table}.${column}`);
    const r = await moveColumn(table, column, rule, fromId, toId, names);
    const k = `${table}.${column}`;
    bump(out, k, r.moved);
    if (r.folded) out.folded[k] = (out.folded[k] || 0) + r.folded;
    if (r.left) out.left[k] = r.left;
  }

  // self-references the merge made
  if (await tableExists("follows")) {
    const r = await runQuery("DELETE FROM follows WHERE follower = ? AND ((target_kind = 'user' AND target_id = ?) OR (target_kind = 'room' AND target_id = ?))",
                             [toId, toId, PROFILE(toId)]);
    if (r && r.changes) out.folded["follows (self-follow)"] = r.changes;
  }
  if (await tableExists("dm_blocks")) {
    const r = await runQuery("DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?", [toId, toId]);
    if (r && r.changes) out.folded["dm_blocks (self-block)"] = r.changes;
  }
  // re-count those votes (feedstore keeps cached ups / downs / score / hot)
  if (out.recount.posts.length || out.recount.comments.length) {
    try {
      const feed = require("./feedstore");
      for (const id of out.recount.posts) await feed.recountPost(id);
      for (const id of out.recount.comments) await feed.recountComment(id);
    } catch (e) { console.error("[MERGE] vote recount:", e.message); }
  }
  if (out.unclassified.length) console.error(`[MERGE] unclassified user columns (moved, not folded): ${out.unclassified.join(", ")} - classify them in accountMerge.js RULES`);
  return out;
}

// ── the users row ─────────────────────────────────────────────────────────────────────────────────────────
const DEFAULT_AVATAR = /(^|\/)avatar\.png$/i;
const placeholderEmail = (e) => !e || !String(e).includes("@");
/**
 * Carry the old account's own fields onto the target (inside the caller's transaction; the old row must
 * still exist): the two CUMULATIVE XP totals added (1.99gg, user.controller mergeXpOf - it used to add only
 * the in-level xp and keep the higher level, losing the lower account's levels; levels above both are paid
 * by afterMerge through the normal level-up path, deduped by levelup_rewards, which moved with the rows),
 * liked and extra spins added, the stricter casino ban, the older creation date, the
 * connect-bonus flags, and an avatar / stream id / VERIFIED email the target lacks. Balance, the Twitch /
 * Discord / Camfrog ids and the username are the caller's.
 * -> {xp (the old account's cumulative XP carried over), level, emailMoved, fields}
 */
async function carryUserFields(from, toId) {
  const cols = new Set(await columnsOf("users"));
  const to = (await getQuery("SELECT * FROM users WHERE userId = ?", [toId]))[0];
  if (!from || !to) return { xp: 0, level: 0, emailMoved: false, fields: [] };
  const set = {}, n = (x) => Number(x) || 0;
  const mx = require("./user.controller").mergeXpOf(to, from);
  if (cols.has("xp") && cols.has("level")) { set.xp = mx.store.xp; set.level = mx.store.level; }
  if (cols.has("liked")) set.liked = n(to.liked) + n(from.liked);
  if (cols.has("extra_daily_spins")) set.extra_daily_spins = n(to.extra_daily_spins) + n(from.extra_daily_spins);
  if (cols.has("casino_banned")) set.casino_banned = Math.max(n(to.casino_banned), n(from.casino_banned));
  for (const b of ["twitchBonus", "discordBonus"]) {
    if (!cols.has(b) || !n(from[b]) || n(to[b])) continue;
    set[b] = 1;
    if (cols.has(b + "_at")) set[b + "_at"] = from[b + "_at"] || null;
  }
  if (cols.has("created_at") && from.created_at && (!to.created_at || String(from.created_at) < String(to.created_at))) set.created_at = from.created_at;
  if (cols.has("avatar") && from.avatar && !DEFAULT_AVATAR.test(String(from.avatar)) && (!to.avatar || DEFAULT_AVATAR.test(String(to.avatar)))) set.avatar = from.avatar;
  for (const c of ["streamId", "streamKey"]) if (cols.has(c) && !to[c] && from[c]) set[c] = from[c];
  // a verified email the target lacks (users.email is UNIQUE: off the old row first). Never replaces a verified one.
  let emailMoved = false;
  if (cols.has("email") && cols.has("isEmailVerified") && !placeholderEmail(from.email) && n(from.isEmailVerified) === 1 &&
      (placeholderEmail(to.email) || n(to.isEmailVerified) !== 1)) {
    await runQuery("UPDATE users SET email = NULL WHERE userId = ?", [from.userId]);
    set.email = from.email; set.isEmailVerified = 1; emailMoved = true;
  }
  const keys = Object.keys(set);
  if (keys.length) await runQuery(`UPDATE users SET ${keys.map((k) => `${q(k)} = ?`).join(", ")} WHERE userId = ?`, keys.map((k) => set[k]).concat([toId]));
  return { xp: mx.otherTotal, level: n(from.level), emailMoved, fields: keys.filter((k) => k !== "email") };
}

// ── the record of a merge ─────────────────────────────────────────────────────────────────────────────────
const SECRET = /password|email|token|reset|secret|streamkey/i;
let logReady = null;
function ensureLog() {
  if (!logReady) {
    logReady = runQuery(`CREATE TABLE IF NOT EXISTS account_merge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, via TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      from_username TEXT, to_username TEXT, pat REAL, xp INTEGER, moved TEXT, folded TEXT, left_over TEXT, unclassified TEXT, note TEXT)`)
      .then(() => runQuery("CREATE INDEX IF NOT EXISTS account_merge_log_to ON account_merge_log (to_id)"))
      .catch((e) => { logReady = null; throw e; });
  }
  return logReady;
}

/** account_archive snapshot of the old users row (never its password / email / tokens / stream key). */
async function archiveMerged(from, to, { via, runId, balance = 0 } = {}) {
  if (!from) return;
  await require("./staleaccounts").ensure();
  const snap = {};
  for (const [k, v] of Object.entries(from)) if (!SECRET.test(k)) snap[k] = v;
  snap.merged_into = to ? to.userId : null;
  const now = Date.now();
  await runQuery(`INSERT INTO account_archive (userId, run_id, tier, reason, archived_at, balance, reclaimed, purged_at, snapshot)
                  VALUES (?, ?, 'MERGE', ?, ?, ?, 0, ?, ?)
                  ON CONFLICT(userId) DO UPDATE SET run_id = excluded.run_id, tier = excluded.tier, reason = excluded.reason,
                    archived_at = excluded.archived_at, balance = excluded.balance, reclaimed = 0, purged_at = excluded.purged_at,
                    snapshot = excluded.snapshot`,
                 [from.userId, runId || `merge-${via}-${now}`, `merged into ${to ? to.username : "?"} (${via})`.slice(0, 300),
                  now, Number(balance) || 0, now, JSON.stringify(snap)]);
}

/** One account_merge_log row: who into whom, how, and the counts per table.column. -> its id */
async function logMerge({ via, from, to, pat = 0, xp = 0, report = {}, note = null }) {
  await ensureLog();
  const j = (x) => JSON.stringify(x || {});
  const r = await runQuery(`INSERT INTO account_merge_log (at, via, from_id, to_id, from_username, to_username, pat, xp, moved, folded, left_over, unclassified, note)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [Date.now(), String(via), from.userId, to.userId, from.username || null, to.username || null, Number(pat) || 0, Number(xp) || 0,
                            j(report.moved), j(report.folded), j(report.left), JSON.stringify(report.unclassified || []), note]);
  return r && (r.id || r.lastID);
}

/** After the transaction committed: refresh the caches the moved rows feed and pay connect bonuses a
 *  vested welcome held. Never throws. */
async function afterMerge(toId, report = {}) {
  const loaded = (m) => Object.keys(require.cache).some((k) => k.endsWith(path.sep + m + ".js"));
  try { if (loaded("rooms")) await require("./rooms").loadCache(); } catch (e) { console.error("[MERGE] rooms cache:", e.message); }
  try { if (loaded("padaccess")) await require("./padaccess").load(); } catch (e) { console.error("[MERGE] pad cache:", e.message); }
  try {
    const owed = Number(report.welcomeOwed) || 0;
    if (owed > 0) {
      const welcome = require("./welcome");
      const take = await runQuery("UPDATE welcome_bonus SET connect_owed = 0 WHERE userId = ? AND connect_owed = ?", [toId, owed]);
      if (take && take.changes) {
        const award = require("./user.controller").awardBonus;
        for (let i = 0; i < owed; i++) await award(toId, "connect bonus (held until the welcome vested)", welcome.config().connect_amount).catch(() => {});
      }
    }
  } catch (e) { console.error("[MERGE] held connect bonus:", e.message); }
  // 1.99gg: the merged XP may reach levels above both accounts' (user.controller mergeXpOf stores the higher
  // level + the rest as in-level XP): settle it through the normal level-up path, which pays only levels
  // neither account was paid for (levelup_rewards / levelup_milestones moved with the rows)
  try {
    const uc = require("./user.controller");
    const u = (await getQuery("SELECT xp, level FROM users WHERE userId = ?", [toId]))[0];
    if (u && (Number(u.xp) || 0) >= uc.xpForNextLevel(Number(u.level) || 0)) await uc.updateLevel(toId, 0);
  } catch (e) { console.error("[MERGE] level-up after merge:", e.message); }
}

/** A Camfrog name moving from one real account to another takes its Camfrog achievements (cf_*)
 *  along — copied, quietly (no XP/PAT), so they aren't earned a second time. */
async function copyCamfrogBadges(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 0;
  const r = await runQuery(
    `INSERT OR IGNORE INTO user_badges (userId, badgeId, awardedAt)
     SELECT ?, badgeId, awardedAt FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_%'`, [toId, fromId]);
  return (r && r.changes) || 0;
}

/** 1.99bs: one PATV account per Camfrog login. Racing find_or_create_user calls in Pepe used to make
 *  several "CF…" accounts for one login (27 copies merged 2026-10-06); a unique index on the normalised
 *  login makes a second one impossible. If duplicates exist the index can't be built - it says which
 *  logins, and the register route's own check-first still holds. Returns true when the index exists. */
async function ensureCamfrogUnique() {
  try {
    await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS users_camfrog_login ON users (lower(trim(camfrogUsername)))
                    WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != ''`);
    return true;
  } catch (e) {
    const d = await getQuery(`SELECT lower(trim(camfrogUsername)) AS l, COUNT(*) AS n FROM users
      WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != '' GROUP BY l HAVING n > 1 LIMIT 20`).catch(() => []);
    console.error(`[accounts] unique Camfrog login index not built (${e.message}); duplicate logins: ${d.map((x) => x.l + " x" + x.n).join(", ") || "?"}`);
    return false;
  }
}

/** The account already on this Camfrog login (normalised), or null. */
async function accountForLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return null;
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername, points_balance FROM users
                          WHERE lower(trim(camfrogUsername)) = ? LIMIT 1`, [l]))[0] || null;
}

module.exports = {
  moveUserRows, carryUserFields, archiveMerged, logMerge, afterMerge, ensureLog, discover, classify, isCandidate,
  RULES, CANDIDATE, EXTRA, ROOM_COLUMNS, copyCamfrogBadges, ensureCamfrogUnique, accountForLogin,
};
