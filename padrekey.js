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
  // CL2: the pad chat archive stays with the Camfrog room, like bridge_feed (pad_chat_cfg - the PAD's settings - moves)
  "chatlog_rooms", "chat_log", "chatlog_open", "chatlog_reports", "chatlog_holds", "chatlog_views", "chatlog_exports",
  // wave 2: the live feed's veil side tables stay with their feed rows / snapshot; frog-name sessions are keyed by the Camfrog
  // room (incog_alias.sk = HMAC(room, login) - re-keying room_id alone would orphan every open session)
  "bridge_veil", "bridge_rooms_veil", "incog_alias",
  "incog_alias_burn",                                   // privacy fix (1.99ahc, review F7): keyed like incog_alias
  // wave 2 WP-5: moderation evidence clips are of a turn said in the Camfrog room (evidence.js) - they stay with it, like bridge_feed
  "evidence_clips",
  "cam_evidence",                                       // 1.99aid (privacy controls S4): stills / clips of a cam in that room (camevidence.js)
]);
// feed_kv keys "<prefix><pad id>" (feedstore / padrules / feedautomod / pepefeed / aigen; 1.99ano: the house pad's welcome post id,
// tools/setup-pepes-pad.js)
const FEED_KV_PREFIXES = ["room:", "rules:", "mention:", "mention_set:", "mention_at:", "automod:scope:", "pepe:scope:", "aigen_room:", "pepespad:welcome:"];
// 1.99ano (account rotation): rooms_kv keys "<prefix><pad id>" that move with the pad (seeded: has its own rule - see rekey)
const ROOMS_KV_PREFIXES = ["pepespad:art:"];

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
 * 1.99ano opts.keep: extra tables (or table.column) that stay with the Camfrog room for THIS call only - the house rotation keeps
 * the room's evidence (bridge_spans, livecam_audit) under the old Camfrog room id (houserotate.js, D4).
 */
async function rekey(from, to, opts = {}) {
  if (!from || !to || from === to) throw new Error("rekey: bad ids");
  const keep = new Set(Array.isArray(opts && opts.keep) ? opts.keep.map(String) : []);
  const moved = {};
  const note = (k, r) => { const n = (r && r.changes) || 0; if (n) moved[k] = (moved[k] || 0) + n; };
  const tables = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  // S1 Q4 (seam plan §12.3, the displaced-row emit): a pad_hub row already at `to` would be displaced by the moving pad's row
  // below (UPDATE OR REPLACE fires no DELETE trigger) - it is deleted first, so the chat hub hears that pad is gone in this
  // same transaction (pads/changed, while its switch is on). The moving pad keeps its hub id (S1-D1).
  const HP = require("./hubpads");
  if (tables.has("pad_hub")) { const d = await HP.rekeyBefore(from, to); if (d) moved["pad_hub.displaced"] = 1; }
  for (const [t, c] of await padColumns()) {
    if (t === "follows" && c !== "target_id") continue;
    if (keep.has(t) || keep.has(`${t}.${c}`)) continue;
    note(`${t}.${c}`, await runQuery(`UPDATE OR REPLACE ${q(t)} SET ${q(c)} = ? WHERE ${q(c)} = ?`, [to, from]));
  }
  if (tables.has("follows")) note("follows.target_id", await runQuery("UPDATE OR REPLACE follows SET target_id = ? WHERE target_kind = 'room' AND target_id = ?", [to, from]));
  if (tables.has("feed_kv")) {
    for (const p of FEED_KV_PREFIXES) note("feed_kv." + p, await runQuery("UPDATE OR REPLACE feed_kv SET key = ? WHERE key = ?", [p + to, p + from]));
  }
  // 1.99ano (seeds never ghost): seeded:<from> is COPIED to seeded:<to> and itself becomes "rekeyed:<to>". rooms.seed() skips an id
  // with any seeded: value, so a seeded pad that moved away (the house rotation, a disconnect) is never re-created at its old id.
  if (tables.has("rooms_kv")) {
    note("rooms_kv.seeded", await runQuery("INSERT OR REPLACE INTO rooms_kv (key, value) SELECT ?, value FROM rooms_kv WHERE key = ?", ["seeded:" + to, "seeded:" + from]));
    await runQuery("UPDATE rooms_kv SET value = ? WHERE key = ?", ["rekeyed:" + to, "seeded:" + from]);
    // review F8: a SEEDS id moving away gets the marker even when its seeded: row is missing (seed() would re-create the pad there)
    let seeds = [];
    try { seeds = require("./rooms").SEEDS || []; } catch (e) { seeds = []; }
    if (seeds.some((x) => x && x.room_id === from)) await runQuery("INSERT OR REPLACE INTO rooms_kv (key, value) VALUES (?, ?)", ["seeded:" + from, "rekeyed:" + to]);
    for (const p of ROOMS_KV_PREFIXES) note("rooms_kv." + p, await runQuery("UPDATE OR REPLACE rooms_kv SET key = ? WHERE key = ?", [p + to, p + from]));
  }
  // 1.99ano: the pad's ids the generic column scan can't see (each was left behind before):
  //   pepe_modlog.room_l     the lower-case copy the moderation log's readers filter on (pepemodlog.js) - with the moved room_id
  //   sb_clips.board         the pad's soundboard ("room:<id>")
  //   backend_wants.feature  the pad's casino switch wish ("casino:<id>", backends.js)
  //   media_requests.pad_id  the pad a 📼 request came from
  //   feed_kv aigen_prices   Pepe's per-room AI generation prices (JSON rooms.<id>) - the moving pad's price wins on a clash
  if (tables.has("pepe_modlog") && !keep.has("pepe_modlog")) {
    note("pepe_modlog.room_l", await runQuery("UPDATE pepe_modlog SET room_l = ? WHERE room_id = ? AND room_l = ?",
                                              [String(to).toLowerCase(), to, String(from).toLowerCase()]));
  }
  if (tables.has("sb_clips")) note("sb_clips.board", await runQuery("UPDATE sb_clips SET board = ? WHERE board = ?", ["room:" + to, "room:" + from]));
  if (tables.has("backend_wants")) note("backend_wants.feature", await runQuery("UPDATE OR REPLACE backend_wants SET feature = ? WHERE feature = ?", ["casino:" + to, "casino:" + from]));
  if (tables.has("media_requests") && (await getQuery("PRAGMA table_info(media_requests)")).some((c) => c.name === "pad_id")) {
    note("media_requests.pad_id", await runQuery("UPDATE media_requests SET pad_id = ? WHERE pad_id = ?", [to, from]));
  }
  if (tables.has("feed_kv")) {
    const r = (await getQuery("SELECT value FROM feed_kv WHERE key = 'aigen_prices'"))[0];
    let v = null;
    try { v = r && r.value ? JSON.parse(r.value) : null; } catch (e) { v = null; }
    if (v && v.rooms && typeof v.rooms === "object" && Object.prototype.hasOwnProperty.call(v.rooms, from)) {
      v.rooms[to] = v.rooms[from];
      delete v.rooms[from];
      note("feed_kv.aigen_prices", await runQuery("UPDATE feed_kv SET value = ? WHERE key = 'aigen_prices'", [JSON.stringify(v)]));
    }
  }
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
  // S1 Q4: what the move changed without changing a key (a merge's members and pad feed bans left at `to` belong to the moved
  // pad now) reaches the chat hub too (pads/changed, bans/changed - each while its switch is on)
  if (tables.has("pad_hub") && tables.has("hub_outbox")) await HP.rekeyAfter(to);
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
  try { await require("./chatlog").loadPadCfg(); } catch (e) { /* not loaded */ }      // CL3: the pad's chat settings moved with it
  try { await require("./cliplink").loadCache(); } catch (e) { /* not loaded */ }      // 1.99aiq cliplink: the pad's clip switch (pad_clip_cfg) too
  // 1.99ano: Pepe's AI prices may have moved a room key (feed_kv aigen_prices) - only when aigen is loaded in this process
  try { const p = require.resolve("./aigen"); if (require.cache[p]) await require.cache[p].exports.reloadPrices(); } catch (e) { /* not loaded */ }
}

module.exports = { vaultRekeysForPepe, vaultRekeysDone, rekey, padColumns, reloadCaches, ROOM_BOUND, ROOM_COLUMNS, FEED_KV_PREFIXES, ROOMS_KV_PREFIXES };
