// hubpads.js — S1 Q4 (release L1): the pads/changed topic of the v1 seam (seam plan §12.2-§12.6, S1-D1 .. S1-D6; ADR 0007
// D1-D3, D11): every pad the chat hub mirrors and each pad's approved members. Entities pad:<hub_pad_id> (padhub.js's stable
// id) and pm:<hub_pad_id>/<userId>; switch hubseam.pads; huboutbox.js registers the topic, the batch reader and the snapshot.
//
//   pad  {kind:"pad", pad_id, v1_room_id, slug, title|null, platform: camfrog|site|twitch|discord|profile,
//         visibility: public|members|approved (pad_access; no row = members; a profile pad is members), nsfw (adult),
//         listed (rooms_registry.listed; a profile pad never), tier: free|prime|plus, tier_until: ms|null (the tier's end,
//         premium.endsAt on the database rows: a comp, the grace of a renewing sub, a Stripe renewal's stripe_through),
//         owner: {kind:"house"} | {kind:"none"} | {kind:"user", account, v1_user}, owner_since|null, owner_grant|null
//         (chatlog_rooms, CHATLOG CL3: user owners only; 0 / no row = null), chat_backend: v1|hub_read|hub (pad_hub),
//         history: {window_s, search, downloads, mods_all} (pad_chat_cfg; NULL / no row = the defaults null, true, null, false),
//         flairs: [{id:"f<id>", name, color, emoji|null, self_assign}] (padflair.hubDefs: the user flairs in sort order, <= 50),
//         fx: {frame, glow} ({fx, perk} of the equipped pad_frame / pad_glow item, or null), badges: [{id, perk}] (the
//         equipped pad_badge items in equip order), badge_max: {free, prime} (padcosmetics.MAX_BADGES, + premium's
//         prime_extra_badges), created_at}
//        -> {kind:"pad", pad_id, gone:true} when the id has no pad_hub row with a registry row (deleted, displaced)
//   pm   {kind:"pm", pad_id, account, v1_user, status: approved|pending|denied|removed} (pad_members; only approved grants)
//        -> {kind:"pm", pad_id, account, v1_user, gone:true} when the row (or the pad) is gone
//   The perk items, the badge caps and the tier's end travel as they are: the hub draws them (padcosmetics.fx()'s rule).
//
// Triggers (S1-D3: (topic, entity) only, every one gated by the switch; a room_id-keyed source resolves its pad through
// pad_hub for OLD and NEW room_id; an UPDATE fires only for the listed columns and only when one changed):
//   rooms_registry  insert / update of room_id, slug, title, platform, owner_kind, owner_user_id, adult, listed (never
//                   updated, slot_*, banner, takeover: the bridge and the stage write those all day); its delete is pad_hub's
//                   (padhub.js's pad_hub_drop deletes the pad's row in the same statement)
//   pad_hub         insert / delete (a deleted pad: padhub.js's pad_hub_drop) / update of room_id, hub_pad_id, chat_backend
//   pad_access      insert / delete / update of room_id, level
//   premium_subs    prime_time / prime_plus rows: insert / delete / update of every column premium.endsAt / statusOf read
//   pad_chat_cfg    insert / delete / update of room_id, window_s, search, downloads, mods_all
//   chatlog_rooms   insert / delete / update of room_id, owner_since, owner_grant (CL3's owner times; never its counters)
//   pad_flairs      kind 'user': insert / delete / update (the flair definitions ride the pad, seam plan §12.3)
//   pad_looks       insert / delete / update of room_id, cosmetics
//   pad_members     insert / delete / update of room_id, user_id, status -> pm:<hub_pad_id>/<user_id>, OLD and NEW
// What no trigger sees (time: a tier lapsing; config: grace_days, prime_extra_badges) reaches the hub with the 10-minute
// snapshot; the payload carries tier_until, so a lapse needs no row.
// Re-keys (padrekey.js, seam plan §12.3 "UPDATE OR REPLACE displaces rows"): rekeyBefore() deletes a pad_hub row the moving
// pad's row would displace, so pad_hub's DELETE trigger tells the hub that pad is gone in the re-key's own transaction;
// rekeyAfter() writes the rows the move changed without changing their keys (the members and pad feed bans left at the
// new id now belong to the moved pad).
// Snapshot (§12.6): every registry row (pad:, by hub_pad_id), then every approved member (pm:), in entity byte order.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const TOPIC = "pads/changed";
const SWITCH = "pads";
const PLATFORMS = ["camfrog", "site", "twitch", "discord", "profile"];
const LEVELS = ["public", "members", "approved"];
const PM_STATUS = ["approved", "pending", "denied", "removed"];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAD_RE = new RegExp(`^pad:(${UUID})$`);
const PM_RE = new RegExp(`^pm:(${UUID})/([^/]+)$`);
const REG_COLS = ["room_id", "slug", "title", "platform", "owner_kind", "owner_user_id", "adult", "listed"];
const PREMIUM_COLS = ["tier", "target", "paid_through", "stripe_through", "renewer_id", "stripe_sub", "comped", "comp_until", "status"];
const CFG_COLS = ["room_id", "window_s", "search", "downloads", "mods_all"];
const MAX_FLAIRS = 50, MAX_BADGES_SENT = 8;

const inList = (n) => Array(n).fill("?").join(",");
/** A read's error handler: a table this database doesn't have (yet) reads as no rows; anything else is thrown (the poster backs
 *  off and retries - never a pad without that part). */
const noTable = (e) => { if (/no such table/i.test(String(e && e.message))) return []; throw e; };
async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) out.push(...(await fn(ids.slice(i, i + 400))));
  return out;
}
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ── triggers ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = (sw = SWITCH) => `(SELECT value FROM hubseam_settings WHERE key = '${sw}') = 'true'`;
/** pad:<hub_pad_id> of a room id expression (resolved through pad_hub now; NULL or no pad_hub row writes nothing) */
const padOf = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'pad:' || h.hub_pad_id, ${MS_SQL} FROM pad_hub h WHERE h.room_id = ${expr};`;
const padBoth = (col) => padOf(`NEW.${col}`) + " " + padOf(`(CASE WHEN OLD.${col} IS NOT NEW.${col} THEN OLD.${col} END)`);
const changed = (cols) => cols.map((c) => `OLD."${c}" IS NOT NEW."${c}"`).join(" OR ");
const pmOf = (ref, extra = "") => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'pm:' || h.hub_pad_id || '/' || ${ref}.user_id, ${MS_SQL}
  FROM pad_hub h WHERE h.room_id = ${ref}.room_id AND ${ref}.user_id IS NOT NULL AND ${ref}.user_id <> ''${extra};`;

/** [name, sql] of every pads trigger. `have`: {table: Set(columns)} of this database (an UPDATE OF names only columns the
 *  table has; a table it lacks gets no triggers). */
function triggerSql(have) {
  const T = [];
  const add = (name, on, body, when = "", sw = SWITCH) => T.push([`hub_s1_pd_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_pd_${name}_v1 ${on}
    WHEN ${gate(sw)}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  const of = (t, list) => (have[t] ? list.filter((c) => have[t].has(c)) : []);
  if (have.rooms_registry) {
    // (a registry DELETE needs no trigger of its own: padhub.js's pad_hub_drop deletes the pad's pad_hub row in the same
    // statement, and pad_hub's DELETE trigger below names the pad by the id it had; an INSERT is covered by pad_hub_mint's row
    // too - this one also covers a pad_hub row that was already there)
    add("reg_i", "AFTER INSERT ON rooms_registry", padOf("NEW.room_id"));
    const c = of("rooms_registry", REG_COLS);
    add("reg_u", `AFTER UPDATE OF ${c.map((x) => `"${x}"`).join(", ")} ON rooms_registry`, padBoth("room_id"), changed(c));
  }
  if (have.pad_hub) {
    const id = (ref) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'pad:' || ${ref}, ${MS_SQL} WHERE ${ref} IS NOT NULL;`;
    add("hub_i", "AFTER INSERT ON pad_hub", id("NEW.hub_pad_id"));
    add("hub_d", "AFTER DELETE ON pad_hub", id("OLD.hub_pad_id"));
    add("hub_u", "AFTER UPDATE OF room_id, hub_pad_id, chat_backend ON pad_hub",
        id("NEW.hub_pad_id") + " " + id("(CASE WHEN OLD.hub_pad_id IS NOT NEW.hub_pad_id THEN OLD.hub_pad_id END)"),
        changed(["room_id", "hub_pad_id", "chat_backend"]));
  }
  const keyed = (short, table, cols, cond = (ref) => "") => {
    if (!have[table]) return;
    const c = of(table, cols);
    const w = (ref) => cond(ref);
    add(short + "_i", `AFTER INSERT ON ${table}`, padOf(`NEW.${cols === PREMIUM_COLS ? "target" : "room_id"}`), w("NEW"));
    add(short + "_d", `AFTER DELETE ON ${table}`, padOf(`OLD.${cols === PREMIUM_COLS ? "target" : "room_id"}`), w("OLD"));
    if (c.length) {
      const key = cols === PREMIUM_COLS ? "target" : "room_id";
      const cw = cond("NEW") || cond("OLD") ? `(${cond("NEW")} OR ${cond("OLD")}) AND (${changed(c)})` : changed(c);
      add(short + "_u", `AFTER UPDATE OF ${c.map((x) => `"${x}"`).join(", ")} ON ${table}`, padBoth(key), cw);
    }
  };
  keyed("acc", "pad_access", ["room_id", "level"]);
  keyed("prem", "premium_subs", PREMIUM_COLS, (ref) => `${ref}.tier IN ('prime_time', 'prime_plus')`);
  keyed("cfg", "pad_chat_cfg", CFG_COLS);
  keyed("clr", "chatlog_rooms", ["room_id", "owner_since", "owner_grant"]);
  keyed("look", "pad_looks", ["room_id", "cosmetics"]);
  if (have.pad_flairs) {
    // the user flairs only (kind 'user'; a NULL kind is a flair from before 1.99wq: a user flair); every column - a rename,
    // a recolour, an emoji, self-assign, the order, a move between pads, a change of kind
    const user = (ref) => `COALESCE(${ref}.kind, 'user') = 'user'`;
    const k = have.pad_flairs.has("kind");
    add("flr_i", "AFTER INSERT ON pad_flairs", padOf("NEW.room_id"), k ? user("NEW") : "");
    add("flr_d", "AFTER DELETE ON pad_flairs", padOf("OLD.room_id"), k ? user("OLD") : "");
    add("flr_u", "AFTER UPDATE ON pad_flairs", padBoth("room_id"), k ? `${user("NEW")} OR ${user("OLD")}` : "");
  }
  if (have.pad_members) {
    add("pm_i", "AFTER INSERT ON pad_members", pmOf("NEW"));
    add("pm_d", "AFTER DELETE ON pad_members", pmOf("OLD"));
    add("pm_u", "AFTER UPDATE OF room_id, user_id, status ON pad_members",
        pmOf("NEW") + " " + pmOf("OLD", " AND (OLD.room_id IS NOT NEW.room_id OR OLD.user_id IS NOT NEW.user_id)"),
        changed(["room_id", "user_id", "status"]));
  }
  return T;
}

const SOURCES = ["rooms_registry", "pad_hub", "pad_access", "premium_subs", "pad_chat_cfg", "chatlog_rooms", "pad_flairs", "pad_looks", "pad_members"];
async function columnsOf(tables) {
  const out = {};
  for (const t of tables) {
    const cols = (await getQuery("SELECT name FROM pragma_table_info(?)", [t])).map((r) => r.name);
    if (cols.length) out[t] = new Set(cols);
  }
  return out;
}

/** Every source the payload reads exists, then the triggers (dropped and created in one transaction). huboutbox.init(). */
async function init() {
  await require("./rooms").init();
  await require("./padhub").init();
  await require("./padaccess").init();
  await require("./premium").init();
  await require("./padflair").init();
  await require("./padlook").init();
  // CL2's tables the payload reads (chatlog.js owns them: its own DDL, nothing else of its start-up)
  const CL = require("./chatlog");
  for (const s of CL.MAIN_DDL) if (/CREATE TABLE IF NOT EXISTS (chatlog_rooms|pad_chat_cfg) /.test(s)) await runQuery(s);
  await installTriggers(triggerSql(await columnsOf(SOURCES)));
}
async function installTriggers(list) {
  await tx(async () => {
    for (const [name, sql] of list) {
      await runQuery(`DROP TRIGGER IF EXISTS ${name}`);
      await runQuery(sql);
    }
  });
}

// ── the reader: the entities' CURRENT state, one pass per batch ──
const cleanPlatform = (p, roomId) => {
  const v = String(p || "").toLowerCase();
  return PLATFORMS.includes(v) ? v : require("./rooms").platformFromId(roomId);
};
/** {tier, tier_until} at t from the pad's prime_plus / prime_time rows (premium.padTier's rule, on the database rows). */
function tierOf(plus, prime, t) {
  const P = require("./premium");
  const end = (s) => (s ? P.endsAt(s, t) : 0);
  const until = (e) => (e === Infinity ? null : e);
  const pe = end(plus);
  if (t < pe) return { tier: "plus", tier_until: until(pe) };
  const te = end(prime);
  if (t < te) return { tier: "prime", tier_until: until(te) };
  return { tier: "free", tier_until: null };
}
/** {fx, badges} from the pad's equipped cosmetics (padlook.parseCosmetics of pad_looks.cosmetics; the padcosmetics catalog). */
function cosmeticsOf(raw) {
  const c = require("./padlook").parseCosmetics(raw);
  const CAT = require("./padcosmetics").CAT;
  const item = (id, kind) => { const it = id && CAT && CAT.byId[id]; return it && it.kind === kind ? it : null; };
  const slot = (id, kind) => { const it = item(id, kind); return it && it.style && it.style.fx ? { fx: String(it.style.fx), perk: it.perk || null } : null; };
  const badges = [];
  for (const id of c.pad_badge) {
    const it = item(id, "pad_badge");
    if (it && badges.length < MAX_BADGES_SENT) badges.push({ id: it.id, perk: it.perk || null });
  }
  return { fx: { frame: slot(c.pad_frame, "pad_frame"), glow: slot(c.pad_glow, "pad_glow") }, badges };
}
function historyOf(row) {
  const b = (v) => (v == null ? null : !!Number(v));
  if (!row) return { window_s: null, search: true, downloads: null, mods_all: false };
  const s = b(row.search), m = b(row.mods_all);
  return { window_s: num(row.window_s), search: s == null ? true : s, downloads: b(row.downloads), mods_all: m == null ? false : m };
}

/**
 * The pads/changed payloads of these entities, read now (t: the seam's clock). -> Map(entity -> payload); an entity of
 * another shape is left out (posted with payload null). Reads every source from the database (never a module's cache).
 */
async function build(entities, t = Date.now()) {
  const HO = require("./huboutbox");
  const out = new Map();
  const pads = new Map(), pms = new Map();               // entity -> hub id | {hub, user}
  for (const e of new Set([...(entities || [])].map(String))) {
    let m = PAD_RE.exec(e);
    if (m) { pads.set(e, m[1]); continue; }
    m = PM_RE.exec(e);
    if (m) pms.set(e, { hub: m[1], user: m[2] });
  }
  if (!pads.size && !pms.size) return out;
  const hubIds = [...new Set([...pads.values(), ...[...pms.values()].map((x) => x.hub)])];
  const hubRows = new Map((await chunked(hubIds, (part) => getQuery(
    `SELECT room_id, hub_pad_id, chat_backend FROM pad_hub WHERE hub_pad_id IN (${inList(part.length)})`, part))).map((r) => [String(r.hub_pad_id), r]));
  const roomIds = [...new Set([...hubRows.values()].map((r) => String(r.room_id)))];
  const reg = new Map((await chunked(roomIds, (part) => getQuery(`SELECT * FROM rooms_registry WHERE room_id IN (${inList(part.length)})`, part)))
    .map((r) => [String(r.room_id), r]));

  if (pads.size) {
    const live = [...new Set([...pads.values()])].map((h) => hubRows.get(h)).filter((h) => h && reg.has(String(h.room_id))).map((h) => String(h.room_id));
    const by = async (sql, key = "room_id") => new Map((await chunked(live, (part) => getQuery(sql(part.length), part).catch(noTable))).map((r) => [String(r[key]), r]));
    const levels = await by((n) => `SELECT room_id, level FROM pad_access WHERE room_id IN (${inList(n)})`);
    const cfg = await by((n) => `SELECT room_id, window_s, search, downloads, mods_all FROM pad_chat_cfg WHERE room_id IN (${inList(n)})`);
    const times = await by((n) => `SELECT room_id, owner_since, owner_grant FROM chatlog_rooms WHERE room_id IN (${inList(n)})`);
    const looks = await by((n) => `SELECT room_id, cosmetics FROM pad_looks WHERE room_id IN (${inList(n)})`);
    const subs = new Map();
    for (const s of await chunked(live, (part) => getQuery(
      `SELECT * FROM premium_subs WHERE tier IN ('prime_time', 'prime_plus') AND target IN (${inList(part.length)})`, part).catch(noTable))) {
      subs.set(s.tier + ":" + s.target, s);
    }
    const P = require("./premium");
    const PC = require("./padcosmetics");
    const free = PC.MAX_BADGES;
    const extra = Math.max(0, Math.floor(Number((P.config() || {}).prime_extra_badges) || 0));
    const PF = require("./padflair");
    for (const [e, hub] of pads) {
      const h = hubRows.get(hub);
      const r = h ? reg.get(String(h.room_id)) : null;
      if (!r) { out.set(e, { kind: "pad", pad_id: hub, gone: true }); continue; }
      const id = String(r.room_id);
      const platform = cleanPlatform(r.platform, id);
      const lv = levels.get(id);
      const visibility = platform === "profile" ? "members" : lv && LEVELS.includes(String(lv.level || "").toLowerCase()) ? String(lv.level).toLowerCase() : "members";
      const userOwner = r.owner_kind === "user" && r.owner_user_id != null && r.owner_user_id !== "";
      const owner = r.owner_kind === "house" ? { kind: "house" }
        : userOwner ? { kind: "user", account: HO.accountOf(r.owner_user_id), v1_user: String(r.owner_user_id) } : { kind: "none" };
      const tm = times.get(id);
      const since = userOwner && tm && Number(tm.owner_since) > 0 ? Number(tm.owner_since) : null;
      const grant = userOwner && tm && Number(tm.owner_grant) > 0 ? Number(tm.owner_grant) : null;
      const cos = cosmeticsOf(looks.has(id) ? looks.get(id).cosmetics : null);
      const flairs = platform === "profile" ? [] : (await PF.hubDefs(id)).slice(0, MAX_FLAIRS);
      out.set(e, {
        kind: "pad", pad_id: hub, v1_room_id: id, slug: String(r.slug), title: r.title == null || r.title === "" ? null : String(r.title),
        platform, visibility, nsfw: !!Number(r.adult), listed: platform !== "profile" && Number(r.listed) !== 0,
        ...tierOf(subs.get("prime_plus:" + id), subs.get("prime_time:" + id), t),
        owner, owner_since: since, owner_grant: grant,
        chat_backend: require("./padhub").BACKENDS.includes(h.chat_backend) ? h.chat_backend : "v1",
        history: historyOf(cfg.get(id)),
        flairs, fx: cos.fx, badges: cos.badges, badge_max: { free, prime: free + extra },
        created_at: num(r.created),
      });
    }
  }

  if (pms.size) {
    // the members' rows, read per pad (pad_members' key is (room_id, user_id))
    const want = new Map();                               // room id -> Set(user)
    for (const { hub, user } of pms.values()) {
      const h = hubRows.get(hub);
      if (!h) continue;
      const id = String(h.room_id);
      if (!want.has(id)) want.set(id, new Set());
      want.get(id).add(user);
    }
    const rows = new Map();                               // "room\nuser" -> status
    for (const [id, users] of want) {
      for (const r of await chunked([...users], (part) => getQuery(
        `SELECT room_id, user_id, status FROM pad_members WHERE room_id = ? AND user_id IN (${inList(part.length)})`, [id, ...part]).catch(noTable))) {
        rows.set(String(r.room_id) + "\n" + String(r.user_id), r.status);
      }
    }
    for (const [e, { hub, user }] of pms) {
      const h = hubRows.get(hub);
      const st = h && reg.has(String(h.room_id)) ? rows.get(String(h.room_id) + "\n" + user) : undefined;
      const p = { kind: "pm", pad_id: hub, account: HO.accountOf(user), v1_user: user };
      if (st === undefined || st === null) p.gone = true;
      else p.status = PM_STATUS.includes(st) ? st : "removed";      // anything else grants nothing
      out.set(e, p);
    }
  }
  return out;
}

// ── snapshot (§12.6): every registry row, then every approved member, in entity byte order ──
/** pad:<hub_pad_id> of every registry row after `bound` (hub_pad_id order = the entity's byte order), at most `limit`. */
async function snapshotPads(bound, limit, t) {
  if (bound == null) return [];
  const ids = (await getQuery(`SELECT h.hub_pad_id FROM pad_hub h JOIN rooms_registry r ON r.room_id = h.room_id
                               WHERE h.hub_pad_id > ? ORDER BY h.hub_pad_id LIMIT ?`, [bound, limit])).map((r) => "pad:" + r.hub_pad_id);
  const built = await build(ids, t);
  return ids.map((entity) => ({ entity, payload: built.get(entity) }));
}
/** pm:<hub_pad_id>/<userId> of every approved member after `bound` (the entity's own byte order), at most `limit`. */
async function snapshotMembers(bound, limit, t) {
  if (bound == null) return [];
  const ent = "('pm:' || h.hub_pad_id || '/' || m.user_id)";
  const ids = (await getQuery(`SELECT ${ent} AS e FROM pad_members m JOIN pad_hub h ON h.room_id = m.room_id
                               JOIN rooms_registry r ON r.room_id = m.room_id
                               WHERE m.status = 'approved' AND ${ent} > ? ORDER BY ${ent} LIMIT ?`, ["pm:" + bound, limit])).map((r) => String(r.e));
  const built = await build(ids, t);
  return ids.filter((e) => PM_RE.test(e)).map((entity) => ({ entity, payload: built.get(entity) }));
}

// ── re-keys (padrekey.js, in the re-key's transaction) ──
/**
 * Before a re-key moves `from`'s rows to `to`: a pad_hub row already at `to` would be displaced by the moving pad's row
 * (UPDATE OR REPLACE fires no DELETE trigger), and the hub would hear of that pad only at the next snapshot. It is deleted
 * here instead, so pad_hub's DELETE trigger writes pad:<displaced hub_pad_id> (the hub archives that pad at once). The moving
 * pad keeps its id (S1-D1). -> the displaced hub_pad_id, or null
 */
async function rekeyBefore(from, to) {
  try {
    const mine = (await getQuery("SELECT hub_pad_id FROM pad_hub WHERE room_id = ?", [String(from)]))[0];
    const theirs = (await getQuery("SELECT hub_pad_id FROM pad_hub WHERE room_id = ?", [String(to)]))[0];
    if (!mine || !theirs) return null;
    await runQuery("DELETE FROM pad_hub WHERE room_id = ?", [String(to)]);
    return String(theirs.hub_pad_id);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
}
/**
 * After a re-key: rows at `to` whose keys the move didn't change but whose pad did (a merge: the room's old pad's members and
 * pad feed bans stay at the room id and now belong to the moved pad) - one trigger-style row each, gated by its switch.
 */
async function rekeyAfter(to) {
  const id = String(to);
  try {
    await runQuery(`INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'pm:' || h.hub_pad_id || '/' || m.user_id, ${MS_SQL}
                    FROM pad_members m JOIN pad_hub h ON h.room_id = m.room_id WHERE m.room_id = ? AND ${gate()}`, [id]);
    await runQuery(`INSERT INTO hub_outbox (topic, entity, created_at) SELECT 'bans/changed', 'fb:' || b.user_id || '/' || b.room_id, ${MS_SQL}
                    FROM feed_bans b WHERE b.room_id = ? AND b.room_id <> '' AND ${gate("bans")}`, [id]);
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
}

module.exports = { TOPIC, SWITCH, init, build, triggerSql, columnsOf, installTriggers, snapshotPads, snapshotMembers, rekeyBefore, rekeyAfter,
                   tierOf, cosmeticsOf, historyOf, SOURCES, REG_COLS, PREMIUM_COLS };
