// hublooks.js — S1 Q5b (release L3): the looks/changed topic of the v1 seam and the hub's looks call (seam plan §12.3-§12.7,
// S1-D10; ADR 0007 D11, D13; CA §5.5). The look itself is userlook.buildLooks - ONE builder for the topic, its snapshot and
// the call. Entity acct:<userId>; switch hubseam.looks (it also gates the call); huboutbox.js registers the topic.
//
//   triggers   (topic, entity) rows, gated by the switch, on every source the look reads (§12.3): users (insert, delete, the
//              look's columns and verified.js's proof columns), a deletion's state, equips and the equipped copies (a
//              transfer, a market listing's lock), telegram_links and Google sso_links (verified), premium_subs (the Season
//              Pass holder; a Plus pad's owner), plex_members, donations (reserve_claims mint:donation), the badge showcase,
//              pad flair assignments, a pad's owner change (auto.plus_pads of both owners).
//   snapshot   accounts with a non-default look (§12.4's rule) in acct:<userId> byte order; the hub re-fetches every held
//              look a complete page leaves out (a default one too) through the call.
//   call       POST /internal/v1/looks {ids: [hub account uuid] (1..450), card?} -> {v: 1, items, missing}: every id in exactly
//              one list, items in request order, duplicates ignored. An id resolves as users.userId (UUID ids) or through the
//              reverse map of chatticket.subjectOf (legacy ids); an account with no cosmetics gets its default look, an id
//              v1 doesn't have (purged, merged away, a done deletion) is missing.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const TOPIC = "looks/changed";
const SWITCH = "looks";
const MAX_IDS = 450;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_COLS = ["avatar", "displayname", "username", "text_style", "isEmailVerified", "email", "camfrogUsername", "discordId", "twitchId"];
const PREMIUM_COLS = ["tier", "target", "paid_through", "stripe_through", "renewer_id", "stripe_sub", "comped", "comp_until", "status"];
const PLEX_COLS = ["user_id", "on_server", "access", "expires", "pending", "link_source"];
const AVATAR_DEFAULTS = ["", "avatar.png", "/public/img/avatar.png", "/img/avatar.png"];
const stats = { calls: 0, items: 0, missing: 0 };

// ── triggers ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = () => `(SELECT value FROM hubseam_settings WHERE key = '${SWITCH}') = 'true'`;
const row = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || ${expr}, ${MS_SQL} WHERE ${expr} IS NOT NULL;`;
const both = (col) => row(`NEW.${col}`) + " " + row(`(CASE WHEN OLD.${col} IS NOT NEW.${col} THEN OLD.${col} END)`);
const changed = (cols) => cols.map((c) => `OLD."${c}" IS NOT NEW."${c}"`).join(" OR ");
/** A Plus pad's owner (the target is the pad's room id): auto.plus_pads. */
const plusOwner = (ref) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || r.owner_user_id, ${MS_SQL}
  FROM rooms_registry r WHERE ${ref}.tier = 'prime_plus' AND r.room_id = ${ref}.target AND r.owner_kind = 'user' AND r.owner_user_id IS NOT NULL;`;
const seasonHolder = (ref) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'acct:' || ${ref}.target, ${MS_SQL}
  WHERE ${ref}.tier = 'season_pass' AND ${ref}.target IS NOT NULL;`;

/** [name, sql] of every looks trigger; `userCols` as hubidentity.triggerSql (the users columns this database has). */
function triggerSql(userCols = null) {
  const ucols = USER_COLS.filter((c) => !userCols || userCols.has(c));
  const T = [];
  const add = (name, on, body, when = "") => T.push([`hub_s1_lk_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_lk_${name}_v1 ${on}
    WHEN ${gate()}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  add("users_i", "AFTER INSERT ON users", row("NEW.userId"));
  add("users_d", "AFTER DELETE ON users", row("OLD.userId"));
  if (ucols.length) add("users_u", `AFTER UPDATE OF ${ucols.map((c) => `"${c}"`).join(", ")} ON users`, row("NEW.userId"), changed(ucols));
  add("del_u", "AFTER UPDATE OF state ON account_deletions", row("NEW.user_id"), "OLD.state IS NOT NEW.state");
  add("eq_i", "AFTER INSERT ON user_cosmetic_equips", row("NEW.user_id"));
  add("eq_d", "AFTER DELETE ON user_cosmetic_equips", row("OLD.user_id"));
  add("eq_u", "AFTER UPDATE ON user_cosmetic_equips", both("user_id"));
  add("copy_u", "AFTER UPDATE OF user_id, locked, item_id ON user_cosmetics", both("user_id"), changed(["user_id", "locked", "item_id"]));
  add("copy_d", "AFTER DELETE ON user_cosmetics", row("OLD.user_id"));
  add("tg_i", "AFTER INSERT ON telegram_links", row("NEW.user_id"));
  add("tg_d", "AFTER DELETE ON telegram_links", row("OLD.user_id"));
  add("tg_u", "AFTER UPDATE OF user_id ON telegram_links", both("user_id"), "OLD.user_id IS NOT NEW.user_id");
  add("sso_i", "AFTER INSERT ON sso_links", row("NEW.user_id"), "NEW.provider = 'google'");
  add("sso_d", "AFTER DELETE ON sso_links", row("OLD.user_id"), "OLD.provider = 'google'");
  add("sso_u", "AFTER UPDATE OF user_id, link_source ON sso_links", both("user_id"),
      "(OLD.provider = 'google' OR NEW.provider = 'google') AND (" + changed(["user_id", "link_source"]) + ")");
  add("prem_i", "AFTER INSERT ON premium_subs", seasonHolder("NEW") + " " + plusOwner("NEW"));
  add("prem_d", "AFTER DELETE ON premium_subs", seasonHolder("OLD") + " " + plusOwner("OLD"));
  add("prem_u", `AFTER UPDATE OF ${PREMIUM_COLS.join(", ")} ON premium_subs`,
      seasonHolder("NEW") + " " + plusOwner("NEW") + " " + seasonHolder("OLD") + " " + plusOwner("OLD"), changed(PREMIUM_COLS));
  add("plex_i", "AFTER INSERT ON plex_members", row("NEW.user_id"));
  add("plex_d", "AFTER DELETE ON plex_members", row("OLD.user_id"));
  add("plex_u", `AFTER UPDATE OF ${PLEX_COLS.join(", ")} ON plex_members`, both("user_id"), changed(PLEX_COLS));
  add("donation_i", "AFTER INSERT ON reserve_claims", row("NEW.userId"), "NEW.flow = 'mint:donation'");
  add("show_i", "AFTER INSERT ON user_badge_showcase", row("NEW.user_id"));
  add("show_u", "AFTER UPDATE ON user_badge_showcase", both("user_id"));
  add("show_d", "AFTER DELETE ON user_badge_showcase", row("OLD.user_id"));
  add("flair_i", "AFTER INSERT ON pad_user_flairs", row("NEW.user_id"));
  add("flair_u", "AFTER UPDATE ON pad_user_flairs", both("user_id"));
  add("flair_d", "AFTER DELETE ON pad_user_flairs", row("OLD.user_id"));
  add("owner_u", "AFTER UPDATE OF owner_user_id, owner_kind ON rooms_registry", both("owner_user_id"),
      changed(["owner_user_id", "owner_kind"]));
  add("pad_d", "AFTER DELETE ON rooms_registry", row("OLD.owner_user_id"));
  return T;
}

/** Every source the look reads exists, then the indexes the snapshot pages through, then the triggers. huboutbox.init(). */
async function init() {
  await require("./textstyle").init();
  await require("./rooms").init();
  await require("./padhub").init();
  await require("./cosmetics").ready;
  await require("./premium").init();                       // premium_subs (+ boosts: reserve_claims)
  await require("./plexmembers").init();
  await require("./telegram").init();
  await require("./ssolinks").init();
  await require("./padflair").init();
  await require("./accountdelete").init();
  await runQuery("CREATE INDEX IF NOT EXISTS hub_s1_donors ON reserve_claims (userId) WHERE flow = 'mint:donation' AND amount > 0");
  await runQuery("CREATE INDEX IF NOT EXISTS pad_user_flairs_user ON pad_user_flairs (user_id)");
  const HI = require("./hubidentity");
  await HI.installTriggers(triggerSql(await HI.usersColumns()));
}

// ── snapshot (§12.6): non-default looks in acct:<userId> byte order ──
const byte = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const CHUNK = 200;
/** The accounts that MAY have a non-default look, after `after` (exclusive), at most `n`, in byte order. */
async function candidates(after, n) {
  const lists = [];
  for (const sql of [
    `SELECT userId AS id FROM users WHERE userId > ? AND ((text_style IS NOT NULL AND text_style <> '')
       OR (avatar IS NOT NULL AND avatar NOT IN (${AVATAR_DEFAULTS.map((a) => `'${a}'`).join(", ")})) OR userId = 'pepe-bot') ORDER BY userId LIMIT ?`,
    "SELECT DISTINCT user_id AS id FROM user_cosmetic_equips WHERE user_id > ? ORDER BY user_id LIMIT ?",
    "SELECT DISTINCT user_id AS id FROM pad_user_flairs WHERE user_id > ? ORDER BY user_id LIMIT ?",
    "SELECT user_id AS id FROM user_badge_showcase WHERE user_id > ? AND badges IS NOT NULL AND badges NOT IN ('', '[]') ORDER BY user_id LIMIT ?",
    "SELECT DISTINCT userId AS id FROM reserve_claims WHERE flow = 'mint:donation' AND amount > 0 AND userId > ? ORDER BY userId LIMIT ?",
    "SELECT DISTINCT user_id AS id FROM plex_members WHERE user_id > ? AND on_server = 1 ORDER BY user_id LIMIT ?",
    "SELECT target AS id FROM premium_subs WHERE tier = 'season_pass' AND target > ? ORDER BY target LIMIT ?",
    `SELECT DISTINCT r.owner_user_id AS id FROM rooms_registry r JOIN premium_subs p ON p.tier = 'prime_plus' AND p.target = r.room_id
     WHERE r.owner_kind = 'user' AND r.owner_user_id > ? ORDER BY r.owner_user_id LIMIT ?`,
  ]) {
    // one source at a time (the page's transaction holds the connection); a table this site doesn't have yet lists nothing
    lists.push(...(await getQuery(sql, [after, n]).catch(() => [])).map((r) => String(r.id)));
  }
  return [...new Set(lists)].sort(byte).slice(0, n);
}
/** One snapshot source: {entity, payload} of the non-default looks after the cursor's account, at most `limit`. */
async function snapshotSource(bound, limit, t = Date.now()) {
  if (bound == null) return [];
  const UL = require("./userlook");
  const out = [];
  let after = bound;
  for (;;) {
    const ids = await candidates(after, CHUNK);
    if (!ids.length) return out;
    const built = await UL.buildLooks(ids, { card: true, t });
    for (const id of ids) {
      const p = built.get(id);
      if (!p || p.gone || UL.isDefaultLook(p)) continue;
      out.push({ entity: "acct:" + id, payload: p });
      if (out.length >= limit) return out;
    }
    if (ids.length < CHUNK) return out;
    after = ids[ids.length - 1];
  }
}

// ── the call: POST /internal/v1/looks ──
// hub account id -> users.userId: a UUID userId is its own account id; a legacy id's account is chatticket.subjectOf (UUIDv5),
// reversed through a map built from users (refreshed when an id misses, at most once a minute).
let REV = new Map(), revAt = 0;
const REV_MS = 60 * 1000;
async function rebuildReverse() {
  const HO = require("./huboutbox");
  const m = new Map();
  for (const r of await getQuery("SELECT userId FROM users")) {
    const a = HO.accountOf(r.userId);
    if (a) m.set(a, String(r.userId));
  }
  REV = m; revAt = Date.now();
  return m.size;
}
async function resolve(ids) {
  const out = new Map();
  const direct = await getQuery(`SELECT userId FROM users WHERE userId IN (${ids.map(() => "?").join(",")})`, ids).catch(() => []);
  const HO = require("./huboutbox");
  for (const r of direct) { const a = HO.accountOf(r.userId); if (a && ids.includes(a)) out.set(a, String(r.userId)); }
  if (ids.some((id) => !out.has(id) && !REV.has(id)) && Date.now() - revAt > REV_MS) await rebuildReverse();
  for (const id of ids) if (!out.has(id) && REV.has(id)) out.set(id, REV.get(id));
  return out;
}
/**
 * The looks call's answer. body: the parsed JSON. -> {status, body}. 400 a malformed body or a non-uuid id, 413 more than 450
 * ids; the caller answers 404 while the looks switch is off (before this runs).
 */
async function call(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b || !Array.isArray(b.ids) || !b.ids.length) return { status: 400, body: { ok: false, error: "bad_body" } };
  if (b.card !== undefined && typeof b.card !== "boolean") return { status: 400, body: { ok: false, error: "bad_body" } };
  if (b.ids.length > MAX_IDS) return { status: 413, body: { ok: false, error: "too_many_ids" } };
  if (!b.ids.every((x) => typeof x === "string" && UUID_RE.test(x))) return { status: 400, body: { ok: false, error: "bad_id" } };
  const ids = [...new Set(b.ids)];
  const byAcct = await resolve(ids);
  const built = await require("./userlook").buildLooks([...new Set(byAcct.values())], { card: b.card === true, t: require("./huboutbox").clockNow() });
  const items = [], missing = [];
  for (const id of ids) {
    const p = byAcct.has(id) ? built.get(byAcct.get(id)) : null;
    if (!p || p.gone || p.acct !== id) missing.push(id);
    else items.push(p);
  }
  stats.calls++; stats.items += items.length; stats.missing += missing.length;
  return { status: 200, body: { v: 1, items, missing } };
}

module.exports = { TOPIC, SWITCH, init, triggerSql, snapshotSource, candidates, call, rebuildReverse, MAX_IDS, USER_COLS,
                   status: () => ({ ...stats, reverse: REV.size }), _resetReverse: () => { REV = new Map(); revAt = 0; } };
