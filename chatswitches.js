// chatswitches.js — S1 V1 (release L1; ADR 0007 D3 and D15, OQ-19; seam plan §12.2, §12.4 and §12.10; CHAT-ARCHITECTURE
// §8.5): the chat hub's two break-glass controls, both v1-owned and set ONLY on the /admin/chat form (adminchat.js):
//
//   chat_switches(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
//     the global switches. One key in S1: CHAT_HUB (on | off; no row = off). v1 mounts <patv-chat> only while it is on and a
//     pad's chat_backend is hub (V2); the hub mirrors it through switches/changed (seam plan §12.2: an AFTER INSERT / UPDATE
//     OF value trigger on this table, entity sw:<key>, payload {key, value, updated_at} - see rowOf / all - written by Q4,
//     gated by the `switches` seam switch) and treats it as off until that topic has bootstrapped. dm_backend (v1 | shadow |
//     hub) is S5's key: reserved, never stored before then.
//   pad_hub.chat_backend (padhub.js, S1-D1): v1 | hub_read | hub per pad, default v1. In S1 only a SITE pad may be hub, and
//     hub_read opens with S2 (ADR 0007 D3). It reaches the hub on pads/changed (Q4's pad_hub trigger). pad_hub.updated_by is
//     the admin's USERNAME - an audit label (accountMerge.js classifies it "deny": not a user id); admin_audit has the id.
//
// Who (adminchat.js decides; this module only enforces the data rules): turning ON (CHAT_HUB on, a pad to hub) is a Pepe
// owner's - staffroles.ownerHolds(me, "chat.breakglass") - with a confirm step; turning OFF (CHAT_HUB off, a pad back to v1)
// is any admin's (chat.breakglass, locked at Admin), one click, never refused, so a rollback stays fast. Every change needs a
// reason and writes an admin_audit row in the SAME transaction as the switch ("chat.switch" {key, from, to};
// "chat.pad_backend" {room_id, slug, hub_pad_id, from, to}). A write that changes nothing writes nothing (no audit row).
//
// The interlock (S1-D7, seam plan §12.10, the S0 `tickets` pattern): CHAT_HUB on is refused - 409 chat_hub_needs, naming the
// switches that are off - unless the twelve seam switches of INTERLOCK are on (huboutbox's hubseam_settings, read inside the
// writing transaction); and while CHAT_HUB is on, turning one of them off on /admin/keys#seam is refused - 409 chat_hub_on,
// "turn CHAT_HUB off first" (huboutbox.setSettings calls guardSeamOff in its transaction). A seam switch huboutbox doesn't
// have yet (pads, roles, bans and switches arrive with Q4) reads as off, so CHAT_HUB can't go on before they exist.
//
// Nothing here calls the chat hub: the form works while the hub is down (CHAT-ARCHITECTURE §8.5).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEYS = { CHAT_HUB: { values: ["off", "on"], def: "off" } };
// S1-D7: the seam switches CHAT_HUB needs (huboutbox SWITCHES names; pads / roles / bans / switches are Q4's)
const INTERLOCK = ["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"];
const BACKENDS = ["v1", "hub_read", "hub"];                 // pad_hub.chat_backend's values
const S1_BACKENDS = ["v1", "hub"];                          // what S1 may set (hub_read: S2)
const REASON_MAX = 200;                                     // admin_audit keeps 200 characters

let clock = () => Date.now();
const refuse = (status, code, message, extra) => Object.assign(new Error(message), { status, code, refuse: true }, extra || {});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chat_switches (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      await require("./padhub").init();
      await require("./adminaudit").init();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** A table that may not exist yet (a module's unit test, a site that never ran huboutbox): its rows or []. Never creates it
 *  - a CREATE inside someone's transaction would be undone with it. */
async function rowsOr(sql, args) {
  try { return await getQuery(sql, args || []); } catch (e) { if (/no such table/i.test(String(e.message))) return []; throw e; }
}

/** {key, value, updated_at: ms | null} - the switches/changed payload of key (no row: the default, updated_at null). */
async function rowOf(key) {
  if (!own(KEYS, key)) throw refuse(400, "bad_key", "Unknown chat switch.");
  const r = (await rowsOr("SELECT value, updated_at FROM chat_switches WHERE key = ?", [key]))[0];
  const value = r && KEYS[key].values.includes(r.value) ? r.value : KEYS[key].def;
  return { key, value, updated_at: r && r.value === value ? Number(r.updated_at) || null : null };
}
/** Every key, defaults included (the switches/changed snapshot lists every key - seam plan §12.6). */
async function all() { const out = []; for (const k of Object.keys(KEYS)) out.push(await rowOf(k)); return out; }
async function get(key) { return (await rowOf(key)).value; }
/** CHAT_HUB is on. A read error or a missing table reads as off. */
async function chatHubOn() { try { return (await get("CHAT_HUB")) === "on"; } catch (e) { return false; } }

/** The interlock's seam switches as stored now: {name: bool} (a missing row or table: off). */
async function seamState() {
  const out = Object.fromEntries(INTERLOCK.map((k) => [k, false]));
  for (const r of await rowsOr(`SELECT key, value FROM hubseam_settings WHERE key IN (${INTERLOCK.map(() => "?").join(",")})`, INTERLOCK)) {
    if (own(out, r.key)) out[r.key] = r.value === "true";
  }
  return out;
}
const missingOf = (state) => INTERLOCK.filter((k) => state[k] !== true);
/** The seam switches CHAT_HUB on still needs ([] = it may go on). */
async function interlock() { const state = await seamState(); return { state, missing: missingOf(state) }; }

/**
 * huboutbox.setSettings' half of the interlock - call it INSIDE that transaction with the switches it is about to write
 * ({name: bool}): turning one of INTERLOCK off while CHAT_HUB is on is refused (409 chat_hub_on). Turning them on, or any
 * other switch, never is.
 */
async function guardSeamOff(next) {
  const off = INTERLOCK.filter((k) => next && own(next, k) && next[k] === false);
  if (!off.length || !(await chatHubOn())) return;
  throw refuse(409, "chat_hub_on", "The chat hub (CHAT_HUB) is on and needs these switches - turn CHAT_HUB off first on /admin/chat.", { off });
}

/** A reason as stored: trimmed, control characters out, at most REASON_MAX characters; "" when there is none. */
function cleanReason(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}
const actorName = (actor) => String((actor && actor.username) || "").slice(0, 80) || null;

/**
 * Set a global switch. -> {changed, key, from, to, at}. Turning CHAT_HUB on runs the interlock in the transaction (409
 * chat_hub_needs {missing}); the same value again changes nothing (no write, no audit row). Who may is adminchat.js's call.
 */
async function set(key, value, actor, reason) {
  if (!own(KEYS, key)) throw refuse(400, "bad_key", "Unknown chat switch.");
  if (!KEYS[key].values.includes(value)) throw refuse(400, "bad_value", "That isn't a value of " + key + ".");
  const why = cleanReason(reason);
  if (!why) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
  if (!actor || !actor.userId) throw refuse(401, "auth", "Sign in first.");
  await init();
  return tx(async () => {
    const from = (await rowOf(key)).value;
    if (from === value) return { changed: false, key, from, to: value, at: null };
    if (key === "CHAT_HUB" && value === "on") {
      const missing = missingOf(await seamState());
      if (missing.length) throw refuse(409, "chat_hub_needs", "The chat hub needs these seam switches on first (/admin/keys#seam): " + missing.join(", ") + ".", { missing });
    }
    const at = clock();
    await runQuery(`INSERT INTO chat_switches (key, value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value, at]);
    await require("./adminaudit").record(actor, "chat.switch", null, { key, from, to: value }, why);
    return { changed: true, key, from, to: value, at };
  });
}

const PAD_COLS = `r.room_id AS room_id, r.slug AS slug, r.title AS title, r.platform AS platform, h.hub_pad_id AS hub_pad_id,
                  h.chat_backend AS chat_backend, h.updated AS updated, h.updated_by AS updated_by`;
/** A registry row's platform (rooms.js's rule for rows without one). */
function platformOf(r) {
  const rooms = require("./rooms");
  const p = String((r && r.platform) || "").toLowerCase();
  return rooms.PLATFORMS.includes(p) ? p : rooms.platformFromId(r && r.room_id);
}
const padView = (r) => ({ room_id: String(r.room_id), slug: r.slug || null, title: r.title || null, platform: platformOf(r),
                          hub_pad_id: r.hub_pad_id || null, backend: BACKENDS.includes(r.chat_backend) ? r.chat_backend : "v1",
                          stored: r.chat_backend == null ? null : String(r.chat_backend),      // as written (a hand edit may hold another value)
                          updated: Number(r.updated) || null, updated_by: r.updated_by || null });

/** One pad with its hub id and backend, by room id; null when there is no such pad (or it has no hub id yet). */
async function pad(roomId) {
  if (typeof roomId !== "string" || !roomId || roomId.length > 200) return null;
  const r = (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id WHERE r.room_id = ?`, [roomId]))[0];
  return r ? padView(r) : null;
}
/** The pads whose backend isn't v1 (the pads on the hub), by title. */
async function hubPads() {
  await init();
  return (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id
                          WHERE h.chat_backend <> 'v1' ORDER BY lower(coalesce(r.title, r.slug)), r.room_id`)).map(padView);
}
/** Site pads still on v1 - what an owner may move to the hub - by title, at most `limit`. `first` (room ids) come first. */
async function sitePadChoices({ limit = 500, first = [] } = {}) {
  await init();
  const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
  const rows = (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id
                                WHERE h.chat_backend = 'v1' ORDER BY lower(coalesce(r.title, r.slug)), r.room_id`)).map(padView)
    .filter((p) => p.platform === "site");
  const pin = first.map((id) => rows.find((p) => p.room_id === id)).filter(Boolean);
  return pin.concat(rows.filter((p) => !first.includes(p.room_id))).slice(0, lim);
}

/**
 * Move a pad's chat to `backend` (v1 | hub). -> {changed, pad, from, to, at}. Refused: an unknown pad (404 no_pad), a value S1
 * doesn't allow (400 bad_backend; hub_read 400 not_in_s1), hub for a pad that isn't a site pad (409 site_only - Camfrog,
 * Twitch, Discord and profile pads stay on v1 chat in S1). The same backend again changes nothing.
 */
async function setPadBackend(roomId, backend, actor, reason) {
  if (backend === "hub_read") throw refuse(400, "not_in_s1", "Read-only hub chat (hub_read) opens with S2 - pick v1 or hub.");
  if (!S1_BACKENDS.includes(backend)) throw refuse(400, "bad_backend", "Pick v1 or hub.");
  const why = cleanReason(reason);
  if (!why) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
  if (!actor || !actor.userId) throw refuse(401, "auth", "Sign in first.");
  await init();
  return tx(async () => {
    const p = await pad(roomId);
    if (!p) throw refuse(404, "no_pad", "No such pad.");
    if (backend === "hub" && p.platform !== "site") {
      throw refuse(409, "site_only", "Only site pads move to the chat hub in S1 - a Camfrog (or other bridged) pad keeps its v1 chat.");
    }
    if (p.stored === backend) return { changed: false, pad: p, from: p.backend, to: backend, at: null };
    const at = clock();
    await runQuery("UPDATE pad_hub SET chat_backend = ?, updated = ?, updated_by = ? WHERE room_id = ?", [backend, at, actorName(actor), p.room_id]);
    await require("./adminaudit").record(actor, "chat.pad_backend", null,
      { room_id: p.room_id, slug: p.slug, hub_pad_id: p.hub_pad_id, from: p.stored, to: backend }, why);
    return { changed: true, pad: { ...p, backend, stored: backend, updated: at, updated_by: actorName(actor) }, from: p.stored, to: backend, at };
  });
}

/** The newest /admin/chat changes (admin_audit), newest first. */
async function recentChanges(limit = 20) {
  await init();
  const rows = await getQuery("SELECT id, at, admin_name, action, detail, reason FROM admin_audit WHERE action IN ('chat.switch', 'chat.pad_backend') ORDER BY id DESC LIMIT ?",
                              [Math.max(1, Math.min(200, Number(limit) || 20))]);
  return rows.map((r) => {
    let detail = null;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (e) { detail = null; }
    return { id: r.id, at: Number(r.at) || null, admin: r.admin_name || null, action: r.action, detail, reason: r.reason || null };
  });
}

module.exports = {
  init, KEYS, INTERLOCK, BACKENDS, S1_BACKENDS, REASON_MAX, rowOf, all, get, chatHubOn, seamState, interlock, guardSeamOff, cleanReason,
  set, pad, hubPads, sitePadChoices, setPadBackend, recentChanges,
  _setClock: (f) => { clock = f || (() => Date.now()); },
};
