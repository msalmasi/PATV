// padhub.js — the chat hub's stable pad id (S1-D1, ADR 0007 D2; seam plan §12.1): every pad's hub_pad_id, a random lower-case
// UUIDv4 that never changes for the pad's life. The hub's pads.pad_id is the same uuid; the seam's entities and payloads name
// pads by it (pad:<hub_pad_id>, the looks' flairs {pad_id: fid} and auto.plus_pads).
//
//   pad_hub(room_id TEXT PRIMARY KEY, hub_pad_id TEXT UNIQUE NOT NULL, chat_backend TEXT NOT NULL DEFAULT 'v1', updated, updated_by)
//
// Not a rooms_registry column: a staging DB refresh copies prod's registry, and deploy/keep-staging-tables.js keeps this
// table instead (staging's hub knows staging's ids). Filled by an AFTER INSERT trigger on rooms_registry (every writer, CLI
// scripts included) and by a start-up backfill for the rows that predate it; never recomputed. A re-key moves the row with
// the pad (padrekey.js moves every room_id column; a merge's UPDATE OR REPLACE keeps the moving pad's id).
//
// Built by S1 Q5b (release L3) because the looks need it (Q4, release L1, owns the rest of the pad seam: the pads/changed
// triggers on this table, chat_backend's writers, the displaced-row emit and pad deletion). This module is that piece only.
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

module.exports = { init, backfill, ofRooms, of, UUID4_RE, _setClock: (f) => { clock = f || (() => Date.now()); } };
