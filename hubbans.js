// hubbans.js — S1 Q4 (release L1): the bans/changed topic of the v1 seam (seam plan §12.2-§12.6; ADR 0007 D9, D11): v1's
// feed bans (feedstore.js feed_bans), mirrored by the hub as source 'v1' feature bans - a site-wide ban (room_id '') covers
// everything (`all`), a pad's ban covers its chat (`chat`). Entity fb:<userId>/<room_id> (`*` for the site-wide ''); switch
// hubseam.bans; huboutbox.js registers the topic, the batch reader and the snapshot.
//
//   {kind:"feed_ban", scope: global|pad, pad_id|null, v1_room_id|null, account, v1_user, feature: all|chat, until: ms|null,
//    banned_at: ms|null, active:true}
//   -> {kind:"feed_ban", scope, pad_id, v1_room_id, account, v1_user, active:false}   the row is gone or past its `until`
// No reason and no actor cross the seam (§2.7's rule). pad_id is the pad's hub_pad_id (pad_hub) - null for a room the
// registry doesn't know (an active one is the hub's to quarantine, no_pad; an inactive one - a re-keyed pad's OLD key, a
// deleted pad's ban - revokes by its idem_key "v1:" + entity) - and for a global ban.
//
// Triggers (S1-D3; gated by the switch): feed_bans insert / delete (unbans; v1's sweep deletes the expired rows) / update of
// user_id, room_id, until (a merge moves user_id, a re-key room_id) -> the OLD and the NEW entity. INSERT OR REPLACE (a re-ban)
// fires the insert trigger. An expiry needs no row: the payload carries `until` and the hub applies it. A pad that gets a hub
// id (pad_hub's insert: a new pad, a pad re-created under a room id whose v1 feed bans outlived the old pad, a bridged room
// banned in before it was registered) posts the room's bans, so the hub holds them under the new pad at once (v1 enforces
// feed bans by room id, whatever the pad).
// Snapshot (§12.6): the live feed bans (until NULL or in the future) that the hub can hold - site-wide ones, and pad ones whose
// room has a pad (a pad_hub row) - entities in byte order (computed in SQL: the entity's order isn't (user_id, room_id)'s).
// A live pad ban on a room without a pad (a deleted pad's: v1 keeps feed_bans when a pad goes, padcreate.removePad; a room the
// registry never knew) is left out: listed, the hub would file a no_pad quarantine row for it on every 10-minute pull, for
// good (rooms 0002's seam_quarantine has no dedupe). Left out, it reads absent, so the hub revokes the ban it held for a
// deleted pad (§12.6: absent -> revoked_at; seam plan §12.4's "a ban on a deleted pad" ends that way, the pad itself archived
// by pads/changed at once). A feed row for such a ban (a ban or a change after the pad went) still posts it active with
// pad_id null - the golden "room the registry does not know" row, quarantined once per change: v1 keeps no record of the
// pads it deleted, so it can't tell the two apart.
"use strict";
const { getQuery } = require("./dbUtils");

const TOPIC = "bans/changed";
const SWITCH = "bans";
const ENT = (ref) => `'fb:' || ${ref}.user_id || '/' || CASE WHEN ${ref}.room_id IS NULL OR ${ref}.room_id = '' THEN '*' ELSE ${ref}.room_id END`;

// ── triggers ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = () => `(SELECT value FROM hubseam_settings WHERE key = '${SWITCH}') = 'true'`;
const row = (ref, extra = "") => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', ${ENT(ref)}, ${MS_SQL}
  WHERE ${ref}.user_id IS NOT NULL AND ${ref}.user_id <> ''${extra};`;
function triggerSql() {
  const T = [];
  const add = (name, on, body, when = "") => T.push([`hub_s1_bn_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_bn_${name}_v1 ${on}
    WHEN ${gate()}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  add("i", "AFTER INSERT ON feed_bans", row("NEW"));
  add("d", "AFTER DELETE ON feed_bans", row("OLD"));
  add("u", "AFTER UPDATE OF user_id, room_id, until ON feed_bans",
      row("NEW") + " " + row("OLD", " AND (OLD.user_id IS NOT NEW.user_id OR OLD.room_id IS NOT NEW.room_id)"),
      "OLD.user_id IS NOT NEW.user_id OR OLD.room_id IS NOT NEW.room_id OR OLD.until IS NOT NEW.until");
  // a pad's hub id minted (padhub.js's insert trigger or backfill): the room's pad bans, now holdable under that pad
  add("pi", "AFTER INSERT ON pad_hub", `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', ${ENT("b")}, ${MS_SQL}
    FROM feed_bans b WHERE b.room_id = NEW.room_id AND b.room_id <> '' AND b.user_id IS NOT NULL AND b.user_id <> '';`);
  return T;
}

/** feed_bans exists (feedstore.js's table: its DDL, nothing else of the feed's start-up), then the triggers. huboutbox.init(). */
async function init() {
  const { runQuery } = require("./dbUtils");
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
        PRIMARY KEY (user_id, room_id))`);
  await require("./padhub").init();                     // pad_hub: the snapshot's filter and the "pi" trigger's table
  await require("./hubpads").installTriggers(triggerSql());
}

/** fb:<userId>/<room|*> -> {user, room} ('' for *), or null. A user id never holds '/', a room id neither. */
function parse(entity) {
  const m = /^fb:([^/]+)\/([^/]+)$/.exec(String(entity));
  return m ? { user: m[1], room: m[2] === "*" ? "" : m[2] } : null;
}

/** The feed ban payloads of these entities, read now (t: the seam's clock). -> Map(entity -> payload). */
async function build(entities, t = Date.now()) {
  const HO = require("./huboutbox");
  const out = new Map();
  const list = [...new Set([...(entities || [])].map(String))].map((e) => ({ e, k: parse(e) })).filter((x) => x.k);
  if (!list.length) return out;
  const rows = new Map();
  const users = [...new Set(list.map((x) => x.k.user))];
  for (let i = 0; i < users.length; i += 400) {
    const part = users.slice(i, i + 400);
    for (const r of await getQuery(`SELECT user_id, room_id, at, until FROM feed_bans WHERE user_id IN (${part.map(() => "?").join(",")})`, part)) {
      rows.set(String(r.user_id) + "\n" + String(r.room_id || ""), r);
    }
  }
  const pads = await require("./padhub").ofRooms(list.map((x) => x.k.room).filter(Boolean));
  for (const { e, k } of list) {
    const r = rows.get(k.user + "\n" + k.room);
    const global = k.room === "";
    const p = { kind: "feed_ban", scope: global ? "global" : "pad", pad_id: global ? null : pads.get(k.room) || null,
                v1_room_id: global ? null : k.room, account: HO.accountOf(k.user), v1_user: k.user };
    const until = r && r.until != null && r.until !== "" ? Number(r.until) : null;
    if (r && (until == null || until > t)) Object.assign(p, { feature: global ? "all" : "chat", until, banned_at: r.at == null ? null : Number(r.at) || null, active: true });
    else p.active = false;
    out.set(e, p);
  }
  return out;
}

/**
 * The snapshot: the live feed bans after the cursor `k` (the whole entity), at most `limit`, in entity byte order - site-wide
 * ones and pad ones whose room has a pad (pad_hub), never a pad ban the hub can't hold (see the header).
 */
async function snapshotSource(k, limit, t = Date.now()) {
  const ent = ENT("b");
  const ids = (await getQuery(`SELECT ${ent} AS e FROM feed_bans b WHERE b.user_id IS NOT NULL AND b.user_id <> ''
                               AND (b.until IS NULL OR b.until > ?)
                               AND (b.room_id IS NULL OR b.room_id = '' OR EXISTS (SELECT 1 FROM pad_hub h WHERE h.room_id = b.room_id))
                               AND ${ent} > ? ORDER BY ${ent} LIMIT ?`,
                              [t, k == null ? "" : String(k), limit])).map((r) => String(r.e));
  const built = await build(ids, t);
  return ids.filter((e) => built.has(e)).map((entity) => ({ entity, payload: built.get(entity) }));
}

module.exports = { TOPIC, SWITCH, init, build, parse, triggerSql, snapshotSource };
