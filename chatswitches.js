// chatswitches.js — v1's chat-hub switches (S1, release L1; ADR 0007 D3, D15; seam plan §12.1 S1-D7, §12.4, §12.10). v1 owns
// them; the hub mirrors them (switches/changed).
//
//   chat_switches(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, updated_by TEXT)
//     CHAT_HUB   on | off (default off) - the chat hub's global kill switch: v1 renders the hub's chat widget only while it is
//                on (and the pad's pad_hub.chat_backend is hub, V2); the hub refuses r: channels of hub pads while it is off.
//   (dm_backend v1 | shadow | hub is S5's: not a key here yet.)
//   updated_by is the admin's username - an audit label (accountMerge.js classifies it "deny"); admin_audit has the id.
//
// Written ONLY by /admin/chat (adminchat.js, S1 V1) through set(): it checks the key, the value and the interlock, writes the row
// and an admin_audit row ("chat.switch" {key, from, to}, with the reason) in ONE transaction; WHO may (a Pepe owner turns
// CHAT_HUB on, any admin turns it off - D15, OQ-19) and the confirm step are adminchat's decisions, not this module's.
// chatHubOn() reads a per-process cache (set() / load() / init() refresh it): a reader that must see an out-of-band write (a
// script, the sqlite3 CLI) at once reads chatHubOnNow() or calls load() on a short timer.
//
// The interlock (S1-D7, §12.10): CHAT_HUB = on is refused (409 chat_hub_needs, err.needs = the missing switches) unless the
// twelve seam switches of INTERLOCK are on, read inside the writing transaction (dbUtils.tx serialises the process's
// transactions). Turning CHAT_HUB off is never refused.
//
// Shared with S1 Q4, built in parallel: Q4's version of this module has the same table, API and rules and adds the rest - the
// switches/changed topic (the triggers on this table, the payload builder, the snapshot) and huboutbox.setSettings' half of the
// interlock (no seam switch CHAT_HUB needs goes off while it is on: 409 chat_hub_on). This file is V1's subset of it: when the
// two branches meet, keep Q4's file WITH V1's set() (the audit row inside the transaction, after V1's review; Q4's draft
// writes it after the commit and swallows a failure) - test/adminchat.test.js fails on a merge that keeps the old one.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEYS = Object.freeze({ CHAT_HUB: Object.freeze({ values: Object.freeze(["on", "off"]), def: "off" }) });
// S1-D7: what CHAT_HUB = on needs (the S0 seam, the privacy seam, and every S1 topic; pads / roles / bans / switches are Q4's)
const INTERLOCK = Object.freeze(["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"]);

class Refuse extends Error { constructor(status, code, msg, extra) { super(msg); this.status = status; this.code = code; this.refuse = true; Object.assign(this, extra || {}); } }

let clock = () => Date.now();
let CACHE = new Map();                     // key -> {value, updated, updated_by}

let ready = null;
/** The table and the cache. */
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chat_switches (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, updated_by TEXT)");
      await load();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function load() {
  const m = new Map();
  for (const r of await getQuery("SELECT key, value, updated, updated_by FROM chat_switches")) m.set(String(r.key), r);
  CACHE = m;
  return m;
}

/** A key's value now (sync, off the cache; the default for a key without a row). */
function get(key) {
  const k = KEYS[key];
  if (!k) return null;
  const r = CACHE.get(key);
  return r && k.values.includes(r.value) ? r.value : k.def;
}
const chatHubOn = () => get("CHAT_HUB") === "on";
/** Every key: {key: {value, updated, updated_by, default}} (for /admin/chat). */
function all() {
  const out = {};
  for (const [key, k] of Object.entries(KEYS)) {
    const r = CACHE.get(key);
    out[key] = { value: get(key), updated: r ? Number(r.updated) || null : null, updated_by: r ? r.updated_by || null : null, default: k.def };
  }
  return out;
}

/** The interlock's missing switches for these hubseam settings ({name: bool}) - [] when CHAT_HUB may go on. */
const needs = (settings) => INTERLOCK.filter((k) => !(settings && settings[k] === true));
/** The same, read from the database (inside the caller's transaction). */
async function needsNow() {
  const on = new Set((await getQuery("SELECT key FROM hubseam_settings WHERE value = 'true'").catch(() => [])).map((r) => String(r.key)));
  return INTERLOCK.filter((k) => !on.has(k));
}
/** Is CHAT_HUB on - read from the database. */
async function chatHubOnNow() {
  const r = (await getQuery("SELECT value FROM chat_switches WHERE key = 'CHAT_HUB'").catch(() => []))[0];
  return !!r && r.value === "on";
}

/**
 * Set a chat switch (/admin/chat). actor = {userId, username} (the admin_audit row; updated_by is the username, an audit label).
 * opts.reason goes into the audit row. Refusals (err.refuse, .status, .code): 400 bad_key / bad_value, 409 chat_hub_needs
 * (err.needs: the interlock's missing switches). -> {key, value, changed, updated}
 * A change and its "chat.switch" admin_audit row commit together (ADR 0007 D15: every change writes admin_audit): when the
 * row can't be written the change is rolled back and set() rejects. Inside the caller's dbUtils.tx it is a savepoint of it.
 * changed is "the row was written": false (nothing written) for the value already there and for the default when there is
 * no row; true for a real change and for rewriting a stored value set() doesn't know (audited, from = the stored value).
 */
async function set(key, value, actor = null, { reason = null } = {}) {
  await init();
  const k = KEYS[key];
  if (!k) throw new Refuse(400, "bad_key", "Unknown chat switch.");
  const v = String(value == null ? "" : value).toLowerCase();
  if (!k.values.includes(v)) throw new Refuse(400, "bad_value", `${key} is ${k.values.join(" or ")}.`);
  const audited = !!(actor && actor.userId);
  const AA = require("./adminaudit");
  if (audited) await AA.init();             // its table before the transaction: no DDL inside one
  const t = clock();
  const by = actor && (actor.username || actor.userId) ? String(actor.username || actor.userId).slice(0, 80) : null;
  const res = await tx(async () => {
    const cur = (await getQuery("SELECT value FROM chat_switches WHERE key = ?", [key]))[0];
    const known = !!cur && k.values.includes(cur.value);
    const was = known ? cur.value : k.def;
    if (key === "CHAT_HUB" && v === "on" && was !== "on") {
      const missing = await needsNow();
      if (missing.length) {
        throw new Refuse(409, "chat_hub_needs", `CHAT_HUB needs these seam switches on first: ${missing.join(", ")}.`, { needs: missing });
      }
    }
    // Nothing to change - the value already there, or no row and the default asked for (no row IS the default): no write,
    // so no updated / updated_by without an audit row to match, and no switches/changed row for nothing (V1's 2nd review).
    if (was === v && (known || !cur)) return { key, value: v, changed: false, updated: t, was };
    await runQuery(`INSERT INTO chat_switches (key, value, updated, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by`, [key, v, t, by]);
    // every write is a change with its audit row - a stored value set() doesn't know (a hand edit: "ON") rewritten too, its
    // `from` what was stored - in the same transaction as the change: a failed row (it throws) rolls the change back
    const from = cur ? String(cur.value).slice(0, 40) : was;
    if (audited) await AA.record({ userId: actor.userId, username: actor.username }, "chat.switch", null, { key, from, to: v }, reason);
    return { key, value: v, changed: true, updated: t, was };
  });
  // the cache follows the commit; a failed re-read is logged and never reported as the change not made (the next load(),
  // /admin/chat's page view included, catches up)
  await load().catch((e) => console.error("[chatswitches] reload:", e && e.message));
  return { key: res.key, value: res.value, changed: res.changed, updated: res.updated };
}

module.exports = { KEYS, INTERLOCK, Refuse, init, load, get, chatHubOn, all, needs, needsNow, chatHubOnNow, set,
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
