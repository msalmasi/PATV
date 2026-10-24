// padhub.js — the chat hub's stable pad id (S1-D1, ADR 0007 D2; seam plan §12.1): every pad's hub_pad_id, a random lower-case
// UUIDv4 that never changes for the pad's life. The hub's pads.pad_id is the same uuid; the seam's entities and payloads name
// pads by it (pad:<hub_pad_id>, the looks' flairs {pad_id: fid} and auto.plus_pads).
//
//   pad_hub(room_id TEXT PRIMARY KEY, hub_pad_id TEXT UNIQUE NOT NULL, chat_backend TEXT NOT NULL DEFAULT 'v1', updated, updated_by)
//
// Not a rooms_registry column: a staging DB refresh copies prod's registry, and deploy/keep-staging-tables.js keeps this
// table instead (staging's hub knows staging's ids). Filled by an AFTER INSERT trigger on rooms_registry (every writer, CLI
// scripts included) and by a start-up backfill for the rows that predate it; never recomputed. A re-key moves the row with
// the pad (padrekey.js moves every room_id column; a merge's UPDATE OR REPLACE keeps the moving pad's id). A pad's deletion
// (padcreate.removePad, accountMerge's profile-pad fold, padconnect's merge into a room's pad - any DELETE of its registry
// row) drops its row through an AFTER DELETE trigger, in the same transaction (seam plan §12.3), so a pad re-created under
// the same room_id gets a new id.
//
// Built by S1 Q5b (release L3) because the looks need it (Q4, release L1, owns the rest of the pad seam: the pads/changed
// triggers on this table - its DELETE included, which tells the hub the pad is gone - chat_backend's writers and the
// displaced-row emit). This module is that piece only.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

let clock = () => Date.now();
const UUID_SQL = "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
                 "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const UUID4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./rooms").init();
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_hub (room_id TEXT PRIMARY KEY, hub_pad_id TEXT UNIQUE NOT NULL,
                      chat_backend TEXT NOT NULL DEFAULT 'v1', updated INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TRIGGER IF NOT EXISTS pad_hub_mint AFTER INSERT ON rooms_registry
        BEGIN INSERT OR IGNORE INTO pad_hub (room_id, hub_pad_id, updated) VALUES (NEW.room_id, ${UUID_SQL}, ${MS_SQL}); END`);
      // a deleted pad's hub id goes with it, in the deleting statement's own transaction (seam plan §12.3 "Pad deletion"):
      // a pad created later under the same room_id (a Camfrog room's id) is a new pad to the hub, never the old one revived
      await runQuery(`CREATE TRIGGER IF NOT EXISTS pad_hub_drop AFTER DELETE ON rooms_registry
        BEGIN DELETE FROM pad_hub WHERE room_id = OLD.room_id; END`);
      await backfill();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Registry rows without a hub id get one (start-up; idempotent). -> how many were minted */
async function backfill() {
  const rows = await getQuery("SELECT r.room_id FROM rooms_registry r LEFT JOIN pad_hub h ON h.room_id = r.room_id WHERE h.room_id IS NULL");
  let n = 0;
  for (const r of rows) {
    const x = await runQuery("INSERT OR IGNORE INTO pad_hub (room_id, hub_pad_id, updated) VALUES (?, ?, ?)", [r.room_id, crypto.randomUUID(), clock()]);
    n += (x && x.changes) || 0;
  }
  if (n) console.log(`[padhub] ${n} pad(s) got a hub pad id`);
  return n;
}

/** room ids -> Map(room_id -> hub_pad_id) for those that have one (a read; call init() first, outside a transaction). */
async function ofRooms(roomIds) {
  const ids = [...new Set([...(roomIds || [])].filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const r of await getQuery(`SELECT room_id, hub_pad_id FROM pad_hub WHERE room_id IN (${part.map(() => "?").join(",")})`, part)) {
      out.set(String(r.room_id), String(r.hub_pad_id));
    }
  }
  return out;
}
async function of(roomId) { return (await ofRooms([roomId])).get(String(roomId)) || null; }

// S1 V1 (ADR 0007 D3): chat_backend - v1 | hub_read | hub, default v1 - is the pad's chat backend, set only on /admin/chat
// (adminchat.js) through setBackend and mirrored to the hub by pads/changed (Q4's trigger). S1 allows `hub` only on a site pad
// (no Camfrog room behind it: a Camfrog pad's chat is the bridge's), and `hub_read` is S2's (refused). setBackend checks the
// value and the pad, nothing else: who may switch (an owner turns on, any admin turns off - D15) is adminchat's. Q4 builds the
// same functions here in parallel (the same API and refusals): when the two branches meet, keep Q4's file WITH V1's
// setBackend (after V1's review: a pad_hub row whose registry row is gone - a staging refresh, a hand edit - can still go back
// to v1, and the room_events row names "PATV staff", never the admin: the pad's owner reads room_events).
const BACKENDS = Object.freeze(["v1", "hub_read", "hub"]);
// how staff show in a pad's room_events (its owner reads them on /p/:slug/settings) - chatlogmod.js's STAFF_ACTOR
const STAFF_ACTOR = "PATV staff";
class Refuse extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; this.refuse = true; } }
/** rooms.js's rule for a registry row's platform (the column, else what the id implies; Q4 exports it as rooms.cleanPlatform). */
function platformOf(r) {
  const rooms = require("./rooms");
  const p = String((r && r.platform) || "").toLowerCase();
  return rooms.PLATFORMS.includes(p) ? p : rooms.platformFromId(r && r.room_id);
}

/** A pad's chat backend (v1 | hub_read | hub; "v1" for a pad without a row or an unknown value). */
async function backendOf(roomId) {
  await init();
  const r = (await getQuery("SELECT chat_backend FROM pad_hub WHERE room_id = ?", [String(roomId || "")]))[0];
  return r && BACKENDS.includes(r.chat_backend) ? r.chat_backend : "v1";
}
/**
 * Set a pad's chat backend - /admin/chat's writer (adminchat.js decides who may). `hub` only on a site pad, `hub_read` refused
 * until S2, a profile pad never; `v1` always (a pad_hub row whose registry row is gone included: going back is never refused).
 * -> {room_id, hub_pad_id, chat_backend, changed}. updated_by gets the actor's username (an audit label; accountMerge.js: deny);
 * the pad's room_events row names STAFF_ACTOR. Refusals (err.refuse, .status, .code): 400 bad_backend, 404 no_pad, 409
 * hub_read_s2 | site_pads_only. Runs inside the caller's dbUtils.tx when there is one (call init() first).
 */
async function setBackend(roomId, backend, actor = null) {
  await init();
  const id = String(roomId || "");
  const b = String(backend == null ? "" : backend);
  if (!BACKENDS.includes(b)) throw new Refuse(400, "bad_backend", "A pad's chat backend is v1, hub_read or hub.");
  if (b === "hub_read") throw new Refuse(409, "hub_read_s2", "Read-only hub chat (hub_read) comes with S2.");
  const R = (await getQuery("SELECT room_id, platform FROM rooms_registry WHERE room_id = ?", [id]))[0];
  if (!R && b !== "v1") throw new Refuse(404, "no_pad", "No such pad.");
  const rooms = require("./rooms");
  if (b === "hub" && platformOf(R) !== "site") {
    throw new Refuse(409, "site_pads_only", "Only a site pad can move its chat to the hub in S1 (a Camfrog pad's chat is its Camfrog room's).");
  }
  if (R && !(await getQuery("SELECT 1 FROM pad_hub WHERE room_id = ?", [id])).length) await backfill();
  const cur = (await getQuery("SELECT hub_pad_id, chat_backend FROM pad_hub WHERE room_id = ?", [id]))[0];
  if (!cur) throw new Refuse(404, "no_pad", "No such pad.");
  const changed = cur.chat_backend !== b;
  if (changed) {
    const by = actor && (actor.username || actor.userId) ? String(actor.username || actor.userId).slice(0, 80) : null;
    await runQuery("UPDATE pad_hub SET chat_backend = ?, updated = ?, updated_by = ? WHERE room_id = ?", [b, clock(), by, id]);
    if (R) await rooms.event(id, "chat-backend", STAFF_ACTOR, `${cur.chat_backend || "v1"} -> ${b}`);
  }
  return { room_id: id, hub_pad_id: String(cur.hub_pad_id), chat_backend: b, changed };
}

module.exports = { init, backfill, ofRooms, of, backendOf, setBackend, BACKENDS, Refuse, UUID4_RE, STAFF_ACTOR,
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
