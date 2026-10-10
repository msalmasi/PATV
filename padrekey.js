// padrekey.js — move a pad to a new id (1.99ja): what connecting a site pad to its Camfrog room and disconnecting it do.
//
// A pad's id (rooms_registry.room_id) is the key everything hangs off. Camfrog pads use the Camfrog room's id (that's
// what Pepe, the bridge and the room vault know), site pads a patv:<x> id. So:
//   connect     patv:<x>  -> <Camfrog room id>   the pad becomes that room's pad. If the room already has an UNOWNED
//                                                  pad (Pepe bridged it before), the two merge: the site pad's settings
//                                                  win where both have one; the room's posts / follows stay.
//   disconnect  <room id> -> patv:<x>            the pad goes back to being a site pad, with its feed.
// Everything that belongs to the PAD moves; what belongs to the CAMFROG ROOM stays with the room id (ROOM_BOUND: the
// bridge's chat log, room stats and activity, the room vault, economy telemetry, royalties - earned from the room's
// activity and paid by it -, boost / slot-fee routing, captured media). Pad data is found generically - any column
// named room_id / home_pad / room / pad in any table, minus ROOM_BOUND - plus the pad's keys that embed its id
// (feed_kv settings, rooms_kv seeded:, feed_seen pad:<id>, Pepe's feed log scope, follows of kind 'room').
// Rows move with UPDATE OR REPLACE: on a merge the moving pad's row replaces a clashing one.
//
// Run inside a transaction (mainstage._tx); the caller reloads the caches afterwards (reloadCaches()).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const ROOM_COLUMNS = /^(room_id|home_pad|room|pad)$/i;
// tables (or table.column) that stay with the Camfrog room
const ROOM_BOUND = new Set([
  "rooms_registry", "pad_connections",                                  // handled by the caller
  "bridge_rooms", "bridge_feed", "bridge_cmd_log", "camfrog_roomstats", "camfrog_roomstats_meta", "room_activity",
  "room_vault_state", "room_vault_settings", "room_vault_rate_log",
  "econ_charges", "econ_participation", "econ_watch", "econ_watch_keys",
  "royalty_ledger", "royalty_runs", "room_flow_ledger",
  "media", "image_safety_log",
  "feed_aigen_jobs.room",                                               // the Camfrog room a room generation came from
]);
// feed_kv keys "<prefix><pad id>" (feedstore / padrules / feedautomod / pepefeed / aigen)
const FEED_KV_PREFIXES = ["room:", "rules:", "mention:", "mention_set:", "mention_at:", "automod:scope:", "pepe:scope:", "aigen_room:"];

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

/** The [table, column] pairs that hold a pad id and move with the pad. */
async function padColumns() {
  const out = [];
  for (const { name } of await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    if (ROOM_BOUND.has(name)) continue;
    for (const c of await getQuery(`PRAGMA table_info(${q(name)})`)) {
      if (!ROOM_COLUMNS.test(c.name) || ROOM_BOUND.has(`${name}.${c.name}`)) continue;
      out.push([name, c.name]);
    }
  }
  return out;
}

/**
 * Move pad `from` to id `to` (the registry row is the caller's job). -> {moved: {"table.column": n}}
 * Never call it with from === to.
 */
async function rekey(from, to) {
  if (!from || !to || from === to) throw new Error("rekey: bad ids");
  const moved = {};
  const note = (k, r) => { const n = (r && r.changes) || 0; if (n) moved[k] = (moved[k] || 0) + n; };
  const tables = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  for (const [t, c] of await padColumns()) {
    if (t === "follows" && c !== "target_id") continue;
    note(`${t}.${c}`, await runQuery(`UPDATE OR REPLACE ${q(t)} SET ${q(c)} = ? WHERE ${q(c)} = ?`, [to, from]));
  }
  if (tables.has("follows")) note("follows.target_id", await runQuery("UPDATE OR REPLACE follows SET target_id = ? WHERE target_kind = 'room' AND target_id = ?", [to, from]));
  if (tables.has("feed_kv")) {
    for (const p of FEED_KV_PREFIXES) note("feed_kv." + p, await runQuery("UPDATE OR REPLACE feed_kv SET key = ? WHERE key = ?", [p + to, p + from]));
  }
  if (tables.has("rooms_kv")) note("rooms_kv.seeded", await runQuery("UPDATE OR REPLACE rooms_kv SET key = ? WHERE key = ?", ["seeded:" + to, "seeded:" + from]));
  if (tables.has("feed_seen")) note("feed_seen.scope", await runQuery("UPDATE OR REPLACE feed_seen SET scope = ? WHERE scope = ?", ["pad:" + to, "pad:" + from]));
  if (tables.has("pepe_feed_log")) note("pepe_feed_log.scope", await runQuery("UPDATE pepe_feed_log SET scope = ? WHERE scope = ?", [to, from]));
  return { moved };
}

/** After a rekey: every in-memory cache keyed by pad id. */
async function reloadCaches() {
  const rooms = require("./rooms");
  await rooms.loadCache();
  try { await require("./padaccess").load(); } catch (e) { /* not loaded in this process */ }
  try { await require("./padlook").loadCache(); } catch (e) { /* not loaded */ }
  try { require("./mainstage")._pubCache.clear(); } catch (e) { /* no stage */ }
}

module.exports = { rekey, padColumns, reloadCaches, ROOM_BOUND, ROOM_COLUMNS, FEED_KV_PREFIXES };
