// chatswitches.js — S1 Q4 (release L1): v1's chat-hub switches and the switches/changed topic of the v1 seam (ADR 0007 D3,
// D15; seam plan §12.1 S1-D7, §12.4, §12.10). v1 owns them; the hub mirrors them.
//
//   chat_switches(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, updated_by TEXT)
//     CHAT_HUB   on | off (default off) - the chat hub's global kill switch: v1 renders the hub's chat widget only while it is
//                on (and the pad's pad_hub.chat_backend is hub, V2); the hub refuses r: channels of hub pads while it is off.
//   (dm_backend v1 | shadow | hub is S5's: not a key here yet - the hub accepts and stores it, with no S1 effect.)
//
// Written ONLY by /admin/chat (V1's adminchat.js) through set(): it checks the key, the value and the interlock, writes the row
// and an admin_audit row ("chat.switch" {key, from, to}, with the reason) in ONE transaction (V1's set(), after V1's review);
// WHO may (a Pepe owner turns CHAT_HUB on, any admin turns it off - D15, OQ-19) and the confirm step are adminchat's
// decisions, not this module's. chatHubOn() reads a per-process cache (set() / load() / init() refresh it): a reader that must
// see an out-of-band write (a script, the sqlite3 CLI) at once reads chatHubOnNow() or calls load() on a short timer.
//
// The interlock (S1-D7, §12.10): CHAT_HUB = on is refused (409 chat_hub_needs, err.needs = the missing switches) unless the
// twelve seam switches of INTERLOCK are on; huboutbox.setSettings refuses turning one of them off while CHAT_HUB is on (409
// chat_hub_on, "turn CHAT_HUB off first"). Turning CHAT_HUB off is never refused. Both checks read the database inside the
// writing transaction (dbUtils.tx serialises every transaction of the process), so the two can't cross.
//
// The topic: switches/changed, entity sw:<key>, payload {key, value, updated_at: ms|null}; triggers (insert / update of value /
// delete, gated by the hubseam `switches` switch) write (topic, entity) only; the snapshot lists every key (a key without a row
// is its default, updated_at null) - v1 always lists every key.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const TOPIC = "switches/changed";
const SWITCH = "switches";
const KEYS = Object.freeze({ CHAT_HUB: Object.freeze({ values: Object.freeze(["on", "off"]), def: "off" }) });
// S1-D7: what CHAT_HUB = on needs (the S0 seam, the privacy seam, and every S1 topic)
const INTERLOCK = Object.freeze(["tickets", "sessions", "heartbeat", "privacy", "erasure", "export", "pads", "roles", "bans", "identity", "looks", "switches"]);

class Refuse extends Error { constructor(status, code, msg, extra) { super(msg); this.status = status; this.code = code; this.refuse = true; Object.assign(this, extra || {}); } }

let clock = () => Date.now();
let CACHE = new Map();                     // key -> {value, updated, updated_by}

let ready = null;
/** The table and the cache (the topic's triggers are installTriggers(), called by huboutbox.init() - the outbox must exist). */
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
/** Every key: {key: {value, updated, updated_by, default}} (for /admin/chat and /admin/keys#seam). */
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
/** Is CHAT_HUB on - read from the database (huboutbox.setSettings' interlock, inside its transaction). */
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
    const was = cur && k.values.includes(cur.value) ? cur.value : k.def;
    if (key === "CHAT_HUB" && v === "on" && was !== "on") {
      const missing = await needsNow();
      if (missing.length) {
        throw new Refuse(409, "chat_hub_needs", `CHAT_HUB needs these seam switches on first: ${missing.join(", ")}.`, { needs: missing });
      }
    }
    if (cur && cur.value === v) return { key, value: v, changed: false, updated: t, was };
    await runQuery(`INSERT INTO chat_switches (key, value, updated, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by`, [key, v, t, by]);
    const changed = was !== v;
    // in the same transaction as the change: a failed row (it throws) rolls the change back
    if (audited && changed) await AA.record({ userId: actor.userId, username: actor.username }, "chat.switch", null, { key, from: was, to: v }, reason);
    return { key, value: v, changed, updated: t, was };
  });
  // the cache follows the commit; a failed re-read is logged and never reported as the change not made (the next load(),
  // /admin/chat's page view included, catches up)
  await load().catch((e) => console.error("[chatswitches] reload:", e && e.message));
  return { key: res.key, value: res.value, changed: res.changed, updated: res.updated };
}

// ── the topic ──
const MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const gate = () => `(SELECT value FROM hubseam_settings WHERE key = '${SWITCH}') = 'true'`;
const row = (expr) => `INSERT INTO hub_outbox (topic, entity, created_at) SELECT '${TOPIC}', 'sw:' || ${expr}, ${MS_SQL} WHERE ${expr} IS NOT NULL;`;
function triggerSql() {
  const T = [];
  const add = (name, on, body, when = "") => T.push([`hub_s1_sw_${name}_v1`, `CREATE TRIGGER IF NOT EXISTS hub_s1_sw_${name}_v1 ${on}
    WHEN ${gate()}${when ? " AND (" + when + ")" : ""} BEGIN ${body} END`]);
  add("i", "AFTER INSERT ON chat_switches", row("NEW.key"));
  add("u", "AFTER UPDATE OF key, value ON chat_switches", row("NEW.key") + " " + row("(CASE WHEN OLD.key IS NOT NEW.key THEN OLD.key END)"),
      "OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value");
  add("d", "AFTER DELETE ON chat_switches", row("OLD.key"));
  return T;
}
async function installTriggers() {
  await init();
  await require("./hubpads").installTriggers(triggerSql());
}

/** sw:<key> payloads, read now. -> Map(entity -> {key, value, updated_at}) (a key of another name: its stored value). */
async function build(entities) {
  const out = new Map();
  const keys = [...new Set([...(entities || [])].map(String))].filter((e) => /^sw:[A-Za-z0-9_]{1,40}$/.test(e)).map((e) => e.slice(3));
  if (!keys.length) return out;
  const rows = new Map((await getQuery(`SELECT key, value, updated FROM chat_switches WHERE key IN (${keys.map(() => "?").join(",")})`, keys))
    .map((r) => [String(r.key), r]));
  for (const key of keys) {
    const r = rows.get(key);
    const k = KEYS[key];
    if (!r && !k) continue;                                // never a switch here: nothing to say (posted with payload null)
    out.set("sw:" + key, { key, value: r ? String(r.value) : k.def, updated_at: r && Number(r.updated) ? Number(r.updated) : null });
  }
  return out;
}
/** The snapshot: every key (§12.6: v1 always lists every key), in entity byte order after `k` (the cursor), at most `limit`. */
async function snapshotSource(k, limit) {
  const ents = Object.keys(KEYS).map((key) => "sw:" + key)
    .filter((e) => k == null || Buffer.compare(Buffer.from(e, "utf8"), Buffer.from(k, "utf8")) > 0)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))).slice(0, limit);
  const built = await build(ents);
  return ents.map((entity) => ({ entity, payload: built.get(entity) }));
}

module.exports = { TOPIC, SWITCH, KEYS, INTERLOCK, Refuse, init, load, get, chatHubOn, all, needs, needsNow, chatHubOnNow, set, triggerSql, installTriggers,
                   build, snapshotSource, _setClock: (f) => { clock = f || (() => Date.now()); } };
