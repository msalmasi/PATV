// padrekey.js — move a pad to a new id (1.99ja): what connecting a site pad to its Camfrog room and disconnecting it do.
//
// A pad's id (rooms_registry.room_id) is the key everything hangs off. Camfrog pads use the Camfrog room's id (that's
// what Pepe, the bridge and the room vault know), site pads a patv:<x> id. So:
//   connect     patv:<x>  -> <Camfrog room id>   the pad becomes that room's pad. If the room already has an UNOWNED
//                                                  pad (Pepe bridged it before), the two merge: the site pad's settings
//                                                  win where both have one; the room's posts / follows stay.
//   disconnect  <room id> -> patv:<x>            the pad goes back to being a site pad, with its feed.
// Everything that belongs to the PAD moves; what belongs to the CAMFROG ROOM stays with the room id (ROOM_BOUND: the
// bridge's chat log, room stats and activity, economy telemetry, captured media).
// 1.99rl "THE VAULT BELONGS TO THE PAD" (the user, 2026-10-11): the room vault (its site mirror, the owner's payout rate
// and its log), owner royalties (ledger + runs), the room-flow escrow (room_flow_ledger) and the launchpad move WITH the
// pad. The vault's PAT itself is Pepe's pool room:<pad id> (local, or the site's pools.js with the Phase 1 backend on):
// every re-key files a pad_vault_rekeys row {from, to}; Pepe gets the open ones with his owner sync, moves the balance
// with keyed, journaled legs (pepe_roomvault._rv_rekeys - the same on both pool paths) and reports them done. Supply
// never changes: one pool goes down by exactly what the other goes up. Pad data is found generically - any column
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
  "econ_charges", "econ_participation", "econ_watch", "econ_watch_keys",
  "pad_vault_rekeys",                                                   // 1.99rl: the re-key journal itself
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
  // 1.99rl: the vault's PAT follows the pad - Pepe moves pool room:<from> -> room:<to> (keyed, journaled) when he sees this
  await runQuery(`CREATE TABLE IF NOT EXISTS pad_vault_rekeys (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                  created INTEGER NOT NULL, done_at INTEGER, amount INTEGER)`);
  note("pad_vault_rekeys", await runQuery("INSERT INTO pad_vault_rekeys (from_id, to_id, created) VALUES (?, ?, ?)", [from, to, Date.now()]));
  // 1.99qy: a pad's 📺 Prime Time / 💎 Prime Time Plus (premium_subs.target = the pad id) moves with the pad - buying Plus
  // for a site pad and then connecting its Camfrog room keeps the Plus. On a merge with the room's old (unowned) pad, the
  // subscription that runs longer wins (a no-end comp beats everything); the other one's row is dropped (its ledger stays).
  if (tables.has("premium_subs")) {
    const P = require("./premium");
    const end = (r) => { try { return P.endsAt(r); } catch (e) { return Number(r.paid_through) || 0; } };
    for (const tier of ["prime_time", "prime_plus"]) {
      const a = (await getQuery("SELECT * FROM premium_subs WHERE tier = ? AND target = ?", [tier, from]))[0];
      if (!a) continue;
      const b = (await getQuery("SELECT * FROM premium_subs WHERE tier = ? AND target = ?", [tier, to]))[0];
      if (b && end(b) >= end(a)) { note("premium_subs.dropped", await runQuery("DELETE FROM premium_subs WHERE id = ?", [a.id])); continue; }
      if (b) await runQuery("DELETE FROM premium_subs WHERE id = ?", [b.id]);
      note("premium_subs.target", await runQuery("UPDATE premium_subs SET target = ? WHERE id = ?", [to, a.id]));
    }
    if (tables.has("premium_ledger")) note("premium_ledger.target", await runQuery("UPDATE premium_ledger SET target = ? WHERE target = ? AND tier IN ('prime_time','prime_plus')", [to, from]));
  }
  return { moved };
}

/** 1.99rl: the open vault re-keys for Pepe's owner sync: [{id, from, to}] (oldest first). */
async function vaultRekeysForPepe(limit = 50) {
  try { return (await getQuery("SELECT id, from_id AS 'from', to_id AS 'to' FROM pad_vault_rekeys WHERE done_at IS NULL ORDER BY id LIMIT ?", [limit])); }
  catch (e) { return []; }                                   // no table yet: nothing was ever re-keyed
}
/** 1.99rl: Pepe's report [{id, amount}] -> marked done (idempotent). -> how many were new */
async function vaultRekeysDone(items) {
  let n = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 200)) {
    const id = Math.floor(Number(it && it.id));
    if (!(id > 0)) continue;
    try {
      const r = await runQuery("UPDATE pad_vault_rekeys SET done_at = ?, amount = ? WHERE id = ? AND done_at IS NULL",
                               [Date.now(), Math.max(0, Math.floor(Number(it.amount) || 0)), id]);
      n += r.changes || 0;
    } catch (e) { /* no table: nothing to mark */ }
  }
  return n;
}

/** After a rekey: every in-memory cache keyed by pad id. */
async function reloadCaches() {
  const rooms = require("./rooms");
  await rooms.loadCache();
  try { await require("./padaccess").load(); } catch (e) { /* not loaded in this process */ }
  try { await require("./padlook").loadCache(); } catch (e) { /* not loaded */ }
  try { require("./mainstage")._pubCache.clear(); } catch (e) { /* no stage */ }
  try { await require("./premium").loadCache(); } catch (e) { /* not loaded */ }      // 1.99qy: Plus / Prime Time moved with the pad
}

module.exports = { vaultRekeysForPepe, vaultRekeysDone, rekey, padColumns, reloadCaches, ROOM_BOUND, ROOM_COLUMNS, FEED_KV_PREFIXES };
