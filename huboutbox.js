// huboutbox.js — v1 -> chat hub: the durable, ordered outbox of the v1 seam (R-14's first slice + R-11's pieces, 1.99acf;
// the chat design §1.7, docs/chat-tickets.md). 1.99acm: R-14's and R-12's S0 slices (seam plan D-1 .. D-37).
//
//   hub_outbox(id, topic, entity, payload, created_at, posted_at, dedupe_key)
//     * SQLite triggers on source tables write rows (so every writer is covered, CLI scripts included): sessions.revoked_at ->
//       "sessions/revoked" "sid:<sessions.id>"; 1.99acm: profile_layout -> "privacy/changed" "pa:<user_id>" (private activity:
//       the Analytics section or its Rooms panel hidden, stories.privateLogins' rule), hub_hidden_h (hubhidden.js, Pepe's
//       hidden_h set; 1.99add refix 4: also a change of its scope - "incognito" when only incognito hides the hash) ->
//       "privacy/changed" "hh:<h>". Trigger rows carry only (topic, entity); the poster reads the entity's CURRENT state when it
//       posts.
//     * emit(topic, entity, payload, {dedupe}) for events that are not table writes (an account cutoff, a request-time incognito
//       request, a committed engine move, 1.99acm: a completed account deletion, a "Make Pepe forget me"): ONLY inside the
//       caller's dbUtils.tx, so the row commits or rolls back with the action. Deduped on dedupe_key.
//   The poster (while HUB_V1_URL + HUB_V1_KEY are set) wakes on emit and polls every 1 s, posts batches of at most 300 rows per
//   topic in id order to HUB_V1_URL/internal/v1/<topic> (HMAC-signed, hubsign.js; HUB_V1_PROXY = the userspace tailscaled HTTP
//   proxy for an http:// hub), marks them posted only on a 2xx. Each topic has its own failure state: a topic the hub refuses
//   (a 404 from an endpoint it doesn't have yet, a 500) backs off 1 s -> 30 s on its own while the other topics keep posting;
//   order is kept within a topic. Posted rows go after 7 days; while no hub is configured, unposted rows older than 7 days go
//   too (the hub bootstraps from snapshots). Nothing goes to a plain http:// hub address unless it is loopback or on the
//   tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net - the hub's own rule; HUB_V1_PROXY only carries it there):
//   status error "insecure_url" (/admin/keys#seam). An outbound key equal to an inbound one is never used ("key_reuse").
//   ids are AUTOINCREMENT (never reused after the table empties - the hub's v1_feed_pos and outbox/rewind{after_id} rely on
//   monotonic ids; the design's sketch says "integer primary key", docs/chat-tickets.md notes the deviation). The head is
//   sqlite_sequence.seq (1.99acm: never MAX(id), which is 0 on an emptied table - seam plan D-17).
//   Account fields in the payloads are the hub's account_id - chatticket.subjectOf(users.userId), the ticket's `sub` (a legacy
//   id -> its UUIDv5) - with the raw id beside it as v1_user.
//
// 1.99acm, the rest of the S0 contract (seam plan §2):
//   * the environment: HUB_V1_ENV (prod | staging | test | dev; default from STAGING) rides the heartbeat, and the outbound key
//     id must be "v1-<env>-<n>" (D-15): another one is never used (status "key_env"). HUB_V1_URL is an origin (D-16: the
//     signed path is the raw request target, so a path prefix would break verification; status "url_path").
//   * snapshot(topic, cursor) -> one page of the topic's CURRENT non-default state for the hub's repair pull (D-17), served by
//     hubinbound.js (GET /internal/v1/snapshot/<topic>) only while the topic's switch is on; rewind(topic, afterId) re-posts
//     kept rows (POST /internal/v1/outbox/rewind, the promotion runbook). A page runs inside dbUtils.tx (the process-wide
//     chain), so every source is an indexed keyset read of at most limit + 1 rows; sessions/revoked lists only the account
//     cutoffs the feed sent (session_cutoffs.hub_before - never "sign out everywhere else", which keeps this device).
//   * getSigned(path, {toFile}) - the synchronous export call (accountexport.js, GET /internal/v1/privacy/export/acct/<id>).
//   * the heartbeat carries the switches and per-topic {head, pending, oldest_pending_at} (D-18).
//
// Switches (hubseam_settings, /admin/keys#seam): tickets, heartbeat, sessions, privacy, econ, 1.99acm: erasure (the topics
// privacy/account-deleted + privacy/forget: one fan-out, on together - D-3) and export (the hub part of "Download my data"),
// 1.99ads: identity and looks (the S1 topics identity/changed, looks/changed; looks also gates the hub's looks call),
// S1 Q4 (release L1): pads, roles, bans and switches (pads/changed, roles/changed, bans/changed, switches/changed: hubpads.js,
// hubroles.js, hubbans.js, chatswitches.js), all off; spans (on: bridge spans only record, bridgespans.js). A topic whose
// switch is off writes nothing and serves no snapshot. Nothing is sent while HUB_V1_URL is unset. Tickets can only be on
// together with `sessions` and `heartbeat` (a revoked sign-in has to reach the hub, and the hub's 30-minute grace rides the
// heartbeat): setSettings refuses any other combination, and chatticket.js won't mint without them.
// S1 Q4, the interlock (S1-D7, ADR 0007 D3; chatswitches.js): while CHAT_HUB is on, none of its twelve switches
// (chatswitches.INTERLOCK) may be turned off here (409 chat_hub_on: turn CHAT_HUB off first, on /admin/chat).
"use strict";
const fs = require("fs");
const http = require("http");
const https = require("https");
const { runQuery, getQuery, tx, inTx } = require("./dbUtils");

// 1.99ads (S1 Q5b, release L3 - ADR 0007 D19: the letter of the release that changed the seam): the identity/changed and
// looks/changed topics (hubidentity.js, hublooks.js + userlook.buildLooks), their switches, snapshots and batch readers, and
// the hub's POST /internal/v1/looks (hubinbound.js).
// 1.99ady (S1 Q4, release L1; the letter is tentative until the release reaches staging - D19's merge-to-staging rule): the
// pads/changed, roles/changed, bans/changed and switches/changed topics the same way, and the CHAT_HUB interlock.
const VERSION = "1.99ady";
const DAY = 86400000;
const BATCH = 300;
const POLL_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const KEEP_MS = 7 * DAY;
const PAGE = 500;                      // snapshot rows per page (seam plan §2.5)
const PENDING_ON_MS = DAY;             // an unanswered incognito ON request counts as pending this long (D-7's backstop)
const TOPICS = { "sessions/revoked": "sessions", "privacy/changed": "privacy", "privacy/account-deleted": "erasure", "privacy/forget": "erasure",
                 "econ/committed": "econ",
                 "identity/changed": "identity", "looks/changed": "looks",                  // 1.99ads: S1 (seam plan §12.2)
                 "pads/changed": "pads", "roles/changed": "roles", "bans/changed": "bans", "switches/changed": "switches" };   // S1 Q4
const SNAPSHOT_TOPICS = ["sessions/revoked", "privacy/changed", "privacy/account-deleted", "privacy/forget", "identity/changed", "looks/changed",
                         "pads/changed", "roles/changed", "bans/changed", "switches/changed"];
const SWITCHES = ["tickets", "heartbeat", "sessions", "privacy", "erasure", "export", "econ", "spans", "identity", "looks", "pads", "roles", "bans", "switches"];
const DEFAULTS = { tickets: false, heartbeat: false, sessions: false, privacy: false, erasure: false, export: false, econ: false, spans: true,
                   identity: false, looks: false, pads: false, roles: false, bans: false, switches: false };
const L1_SWITCHES = ["pads", "roles", "bans", "switches"];                                    // S1 Q4 (release L1)

let clock = () => Date.now();
const now = () => clock();
const hubUrl = () => String(process.env.HUB_V1_URL || "").trim().replace(/\/+$/, "");
const hubKey = () => ({ id: String(process.env.HUB_V1_KEY_ID || "").trim(), key: String(process.env.HUB_V1_KEY || "") });
const ENVS = ["prod", "staging", "test", "dev"];
/** This site's seam environment: HUB_V1_ENV, else staging / prod by STAGING. null when HUB_V1_ENV is set to something else. */
function hubEnv() {
  const e = String(process.env.HUB_V1_ENV || "").trim().toLowerCase();
  if (e) return ENVS.includes(e) ? e : null;
  return process.env.STAGING ? "staging" : "prod";
}

let ready = null;
let s1 = { ready: false, error: null };          // 1.99ads: the S1 topics' setup (hubidentity / hublooks init)
let l1 = { ready: false, error: null };          // S1 Q4: release L1's topics (hubpads / hubroles / hubbans / chatswitches init)
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS hub_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT,
        created_at INTEGER NOT NULL, posted_at INTEGER, dedupe_key TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS hub_outbox_pending ON hub_outbox (posted_at, id)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS hub_outbox_dedupe ON hub_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL");
      await runQuery("CREATE TABLE IF NOT EXISTS hubseam_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      const ms = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
      const gate = (sw) => `(SELECT value FROM hubseam_settings WHERE key = '${sw}') = 'true'`;
      // sessions/revoked: every revocation, whoever writes it (the site, an admin script), while the `sessions` switch is on
      await require("./sessions").init();
      await runQuery(`CREATE TRIGGER IF NOT EXISTS hub_outbox_session_revoked AFTER UPDATE OF revoked_at ON sessions
        WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
         AND ${gate("sessions")}
        BEGIN INSERT INTO hub_outbox (topic, entity, created_at)
              VALUES ('sessions/revoked', 'sid:' || NEW.id, ${ms}); END`);
      // 1.99acm: the sessions/revoked snapshot pages revoked sessions in id order through this partial index (no scan, no sort)
      await runQuery("CREATE INDEX IF NOT EXISTS hub_sessions_revoked ON sessions (id, expires) WHERE revoked_at IS NOT NULL");
      // 1.99acm privacy/changed "pa:<user_id>": any profile layout write (the poster computes the flag; saves are rare)
      await require("./profilelayout").ready;
      for (const [ev, ref] of [["INSERT", "NEW"], ["UPDATE OF layout", "NEW"], ["DELETE", "OLD"]]) {
        await runQuery(`CREATE TRIGGER IF NOT EXISTS hub_outbox_pa_${ev.split(" ")[0].toLowerCase()} AFTER ${ev} ON profile_layout WHEN ${gate("privacy")}
          BEGIN INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('privacy/changed', 'pa:' || ${ref}.user_id, ${ms}); END`);
      }
      // 1.99acm privacy/changed "hh:<h>": Pepe's hidden_h set (hubhidden.js) gains or loses a hash
      await require("./hubhidden").init();
      for (const [ev, ref] of [["INSERT", "NEW"], ["DELETE", "OLD"]]) {
        await runQuery(`CREATE TRIGGER IF NOT EXISTS hub_outbox_hh_${ev.toLowerCase()} AFTER ${ev} ON hub_hidden_h WHEN ${gate("privacy")}
          BEGIN INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('privacy/changed', 'hh:' || ${ref}.h, ${ms}); END`);
      }
      // 1.99add refix 4: a hash hidden only by incognito (scope "incognito": shown as "someone") or also left out (scope NULL)
      await runQuery(`CREATE TRIGGER IF NOT EXISTS hub_outbox_hh_update AFTER UPDATE OF scope ON hub_hidden_h WHEN OLD.scope IS NOT NEW.scope AND ${gate("privacy")}
        BEGIN INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('privacy/changed', 'hh:' || NEW.h, ${ms}); END`);
      // 1.99ads: the S1 topics' source tables, indexes and triggers (each gated by its own switch, written whatever it says).
      // Never in the way of the S0 seam: a failure is logged, shown on /admin/keys#seam (status().s1.error) and keeps the
      // identity / looks switches from turning on; a database without a users table (a module's unit test) has no S1 topics.
      s1 = { ready: false, error: null };
      if (await hasTable("users")) {
        try {
          await require("./hubidentity").init();
          await require("./hublooks").init();
          s1.ready = true;
        } catch (e) {
          s1.error = String(e.message || e).slice(0, 200);
          console.error("[hub_outbox] S1 topics (identity, looks):", s1.error);
        }
      }
      // S1 Q4 (release L1): pads, roles, bans, switches - set up on their own (a failure here never takes identity / looks
      // down), shown on /admin/keys#seam (status().l1) and keeping these four switches from turning on
      l1 = { ready: false, error: null };
      if (await hasTable("users")) {
        try {
          await require("./hubpads").init();
          await require("./hubroles").init();
          await require("./hubbans").init();
          await require("./chatswitches").installTriggers();
          l1.ready = true;
        } catch (e) {
          l1.error = String(e.message || e).slice(0, 200);
          console.error("[hub_outbox] S1 topics (pads, roles, bans, switches):", l1.error);
        }
      }
      await reloadSettings();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── switches ──
let SETTINGS = { ...DEFAULTS };
async function reloadSettings() {
  const out = { ...DEFAULTS };
  for (const r of await getQuery("SELECT key, value FROM hubseam_settings")) if (SWITCHES.includes(r.key)) out[r.key] = r.value === "true";
  SETTINGS = out;
  return { ...SETTINGS };
}
const settings = () => ({ ...SETTINGS });
const on = (name) => SETTINGS[name] === true;
/** Tickets need the revocation feed and the heartbeat (chatticket.js checks the same before it mints). */
const ticketsReady = (s) => s.sessions === true && s.heartbeat === true;
async function setSettings(patch, actor) {
  await init();
  const next = {};
  for (const k of SWITCHES) if (patch && k in patch) next[k] = patch[k] === true || patch[k] === "true";
  if (!Object.keys(next).length) throw Object.assign(new Error("Nothing to change."), { status: 400, code: "nothing", refuse: true });
  const after = { ...(await reloadSettings()), ...next };
  if ((next.identity === true || next.looks === true) && !s1.ready) {
    throw Object.assign(new Error("The identity / looks topics couldn't be set up on this site (see the seam status) - they can't be turned on."),
                        { status: 409, code: "s1_not_ready", refuse: true });
  }
  if (L1_SWITCHES.some((k) => next[k] === true) && !l1.ready) {
    throw Object.assign(new Error("The pads / roles / bans / switches topics couldn't be set up on this site (see the seam status) - they can't be turned on."),
                        { status: 409, code: "l1_not_ready", refuse: true });
  }
  if (after.tickets && !ticketsReady(after)) {
    throw Object.assign(new Error("Chat tickets need sign-outs to the hub (sessions) and the heartbeat on - turn those on first, or turn tickets off first."),
                        { status: 409, code: "tickets_need", refuse: true });
  }
  const CS = require("./chatswitches");
  await tx(async () => {
    // S1 Q4 (S1-D7): CHAT_HUB on needs every interlock switch - none that is on goes off under it (read here, in the writing
    // transaction, so a concurrent CHAT_HUB change can't cross it)
    const was = new Set((await getQuery("SELECT key FROM hubseam_settings WHERE value = 'true'")).map((r) => String(r.key)));
    const offing = CS.INTERLOCK.filter((k) => next[k] === false && was.has(k));
    if (offing.length && (await CS.chatHubOnNow())) {
      throw Object.assign(new Error(`CHAT_HUB is on and needs ${offing.join(", ")} - turn CHAT_HUB off first (Admin › Chat).`),
                          { status: 409, code: "chat_hub_on", refuse: true, needs: offing });
    }
    for (const [k, v] of Object.entries(next)) {
      await runQuery(`INSERT INTO hubseam_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                     [k, v ? "true" : "false", now(), actor && actor.username ? String(actor.username).slice(0, 80) : null]);
    }
    if (actor && actor.userId) await require("./adminaudit").record(actor, "hubseam.settings", null, next, null);
    // 1.99acm: Pepe's hidden_h set is kept only while the privacy feed is on (hubhidden.js); with the switch already 'false'
    // in this transaction the hh triggers write nothing for these deletes
    if (next.privacy === false) await runQuery("DELETE FROM hub_hidden_h");
  });
  if (next.privacy === false) require("./hubhidden")._forget();
  return reloadSettings();
}

// ── emit ──
/**
 * One outbox row for an event that is not a table write. MUST run inside the action's dbUtils.tx (throws otherwise - a
 * programming error). A no-op (false) when the topic's switch is off. A database error is logged and swallowed: the action
 * still commits, and the hub heals from the topic's snapshot. -> true when a row was written (false when deduped / off).
 */
async function emit(topic, entity, payload, { dedupe = null } = {}) {
  if (!inTx()) throw new Error("hubOutbox.emit() must run inside dbUtils.tx - the same transaction as the action");
  const sw = TOPICS[topic];
  if (!sw) throw new Error("hubOutbox.emit(): unknown topic " + topic);
  if (!on(sw)) return false;
  try {
    const r = await runQuery("INSERT OR IGNORE INTO hub_outbox (topic, entity, payload, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?)",
                             [topic, String(entity).slice(0, 200), payload == null ? null : JSON.stringify(payload), now(),
                              dedupe == null ? null : String(dedupe).slice(0, 200)]);
    wake();
    return !!(r && r.changes);
  } catch (e) {
    console.error(`[hub_outbox] emit ${topic}: ${e.message}`);
    return false;
  }
}

// ── trigger rows: the entity's current state at post time ──
const sessionRow = (r) => ({ kind: "session", sid: r.id.slice(0, 32), account: accountOf(r.user_id), v1_user: String(r.user_id), at: r.revoked_at,
                             until: r.expires, why: r.revoked_why });
/** 1.99acm: private activity = the profile's Analytics section or its Rooms panel hidden (stories.privateLogins' rule). */
async function privateActivity(userId) {
  const pl = require("./profilelayout");
  const row = (await getQuery("SELECT layout, updated FROM profile_layout WHERE user_id = ?", [String(userId)]))[0];
  let L;
  try { L = row ? pl.sanitize(JSON.parse(row.layout)) : pl.sanitize(pl.DEFAULT); } catch (e) { L = null; }
  const value = !L || pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden";   // unreadable: fail closed
  return { value, at: (row && Number(row.updated)) || null };
}
const paRow = (userId, value, at) => ({ flag: "private_activity", value, subject: { acct: accountOf(userId), v1_user: String(userId) }, at });
// 1.99add refix 4: scope "incognito" = hidden ONLY by incognito (the owner's rule: shown as "someone", words kept); absent = left
// out (!bridge hide, or an older Pepe's list that doesn't say which) - every row before refix 4 meant that. An optional field: the
// hub (S0) reads h / value / at and ignores it, so it keeps leaving everyone out until it reads `scope` (fail closed)
const hhRow = (h, value, at, scope = null) => ({ flag: "hidden_h", h, value, at, ...(value && scope === "incognito" ? { scope: "incognito" } : {}) });

const readers = {
  "sessions/revoked": async (entity) => {
    const m = /^sid:([a-f0-9]{64})$/.exec(String(entity));
    if (!m) return null;
    const r = (await getQuery("SELECT id, user_id, revoked_at, revoked_why, expires FROM sessions WHERE id = ?", [m[1]]))[0];
    if (!r) return { kind: "session", sid: m[1].slice(0, 32), gone: true };
    return sessionRow(r);
  },
  "privacy/changed": async (entity) => {
    const e = String(entity);
    if (e.startsWith("pa:")) {
      const uid = e.slice(3);
      const pa = await privateActivity(uid);
      return paRow(uid, pa.value, pa.at || now());
    }
    if (e.startsWith("hh:")) {
      const h = e.slice(3);
      const r = (await getQuery("SELECT since, scope FROM hub_hidden_h WHERE h = ?", [h]))[0];
      return hhRow(h, !!r, r ? Number(r.since) : now(), r ? r.scope : null);
    }
    return null;
  },
  // 1.99ads (S1): acct:<userId> -> the identity / the look, read now (the batch readers below serve the poster)
  "identity/changed": async (entity) => (await readersMany["identity/changed"]([entity])).get(String(entity)) || null,
  "looks/changed": async (entity) => (await readersMany["looks/changed"]([entity])).get(String(entity)) || null,
  // S1 Q4: pad: / pm: -> the pad / the membership; acct: -> the global role; fb: -> the feed ban; sw: -> the chat switch
  "pads/changed": async (entity) => (await readersMany["pads/changed"]([entity])).get(String(entity)) || null,
  "roles/changed": async (entity) => (await readersMany["roles/changed"]([entity])).get(String(entity)) || null,
  "bans/changed": async (entity) => (await readersMany["bans/changed"]([entity])).get(String(entity)) || null,
  "switches/changed": async (entity) => (await readersMany["switches/changed"]([entity])).get(String(entity)) || null,
};
/** 1.99ads: topics whose rows the poster reads in ONE pass per batch (a batch of 300 looks is one set of queries, not 300).
 *  entities -> Map(entity -> payload); an entity of another shape is left out (posted with payload null). */
const acctIds = (entities) => entities.map(String).filter((e) => /^acct:./.test(e)).map((e) => e.slice(5));
const byEntity = (m) => new Map([...m].map(([id, p]) => ["acct:" + id, p]));
const readersMany = {
  "identity/changed": async (entities) => byEntity(await require("./hubidentity").build(acctIds(entities))),
  "looks/changed": async (entities) => byEntity(await require("./userlook").buildLooks(acctIds(entities), { card: true, t: now() })),
  // S1 Q4 (release L1): each reader already answers Map(entity -> payload)
  "pads/changed": async (entities) => require("./hubpads").build(entities, now()),
  "roles/changed": async (entities) => require("./hubroles").build(entities),
  "bans/changed": async (entities) => require("./hubbans").build(entities, now()),
  "switches/changed": async (entities) => require("./chatswitches").build(entities),
};

/** The hub's account_id for a users.userId: the ticket's `sub` (chatticket.subjectOf - a legacy id -> its UUIDv5 when
 *  CHAT_GENESIS_NS is set, else null). */
let accountOverride = null;      // tests (the golden rows' fixed ids)
function accountOf(userId) {
  if (accountOverride) return accountOverride(userId);
  if (userId == null || userId === "") return null;
  try { return require("./chatticket").subjectOf(userId); } catch (e) { return null; }
}

// ── transport ──
/**
 * A request to a URL with a timeout (10 s); an http:// URL goes through HUB_V1_PROXY when set. -> {ok, status, error?}
 * 1.99acm: {toFile, maxBytes} streams a 2xx body into a new file (mode 0600; removed again on any failure) -> {.., file, bytes}.
 */
function request(urlStr, { method = "POST", headers = {}, body = "", toFile = null, maxBytes = 1 << 20, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, status: 0, error: "bad_url" }); }
    const buf = Buffer.from(body == null ? "" : String(body));
    const hdrs = { "user-agent": "patv-v1-seam/" + VERSION, ...headers };
    if (method !== "GET" || buf.length) { hdrs["content-type"] = "application/json"; hdrs["content-length"] = buf.length; }
    const proxy = String(process.env.HUB_V1_PROXY || "").trim();
    let mod, opts;
    if (proxy && u.protocol === "http:") {
      let p;
      try { p = new URL(proxy.includes("://") ? proxy : "http://" + proxy); } catch (e) { return resolve({ ok: false, status: 0, error: "bad_proxy" }); }
      mod = http;
      opts = { host: p.hostname, port: Number(p.port) || 80, method, path: u.href, headers: { ...hdrs, host: u.host } };
    } else {
      mod = u.protocol === "https:" ? https : http;
      opts = { hostname: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), method, path: u.pathname + u.search, headers: hdrs };
    }
    let done = false, fd = null, n = 0;
    const closeFd = () => { if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } fd = null; } };
    const fin = (v) => {
      if (done) return;
      done = true;
      if (v.ok && fd != null) { try { fs.fsyncSync(fd); } catch (e) { /* best effort */ } }
      closeFd();
      if (!v.ok && toFile && v.error !== "file_exists") { try { fs.unlinkSync(toFile); } catch (e) { /* none */ } }
      resolve(v);
    };
    const req = mod.request(opts, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      if (toFile && ok) {
        try { fd = fs.openSync(toFile, "wx", 0o600); } catch (e) { fin({ ok: false, status: res.statusCode, error: "file_exists" }); return res.destroy(); }
      }
      res.on("data", (c) => {
        if (done) return;
        n += c.length;
        if (n > maxBytes) { fin({ ok: false, status: res.statusCode, error: "too_large" }); return res.destroy(); }
        if (fd != null) { try { fs.writeSync(fd, c); } catch (e) { fin({ ok: false, status: res.statusCode, error: "file" }); res.destroy(); } }
      });
      res.on("end", () => fin(ok ? { ok: true, status: res.statusCode, ...(toFile ? { file: toFile, bytes: n } : {}) }
                                 : { ok: false, status: res.statusCode }));
      res.on("error", () => fin({ ok: false, status: res.statusCode || 0, error: "response" }));
      res.on("aborted", () => fin({ ok: false, status: res.statusCode || 0, error: "response" }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => fin({ ok: false, status: 0, error: String(e.code || "network").slice(0, 40) }));
    req.end(buf);
  });
}

/** 1.99acm: loopback or the tailnet - the hub's own rule (config.ts tailnetOrLoopback): 127/8, ::1, localhost,
 *  100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net. */
function tailnetOrLoopback(hostname) {
  const h = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".ts.net")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return require("net").isIPv6(h) && /^fd7a:115c:a1e0:/.test(h);
}
/** Would a request to HUB_V1_URL cross the network in cleartext? http:// is only for loopback or a tailnet address / name
 *  (1.99acm: whether HUB_V1_PROXY is set or not - tailscaled's proxy dials any other host directly, in the clear). */
function insecureUrl(urlStr = hubUrl()) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return false; }
  if (u.protocol !== "http:") return false;
  return !tailnetOrLoopback(u.hostname);
}
/** 1.99acm: HUB_V1_URL must be an origin - no path, query or fragment (seam plan D-16). */
function urlHasPath(urlStr = hubUrl()) {
  try { const u = new URL(urlStr); return (!!u.pathname && u.pathname !== "/") || !!u.search || !!u.hash; } catch (e) { return false; }
}
/** Why nothing may be sent right now, or null. */
function refusal() {
  const url = hubUrl();
  const k = hubKey();
  if (!url) return "unconfigured";
  if (!k.id || !k.key) return "no_key";
  const env = hubEnv();
  if (!env) return "bad_env";
  if (!require("./hubsign").keyIdOk(k.id, "v1", env)) return "key_env";       // never sign with a key of another env / direction
  // 1.99acm: one secret for both directions would let either side's signature pass as the other's - never sign with it
  if ([process.env.HUB_V1_IN_KEY, process.env.HUB_V1_IN_PREV_KEY].some((x) => x && String(x) === k.key)) return "key_reuse";
  if (urlHasPath(url)) return "url_path";
  if (insecureUrl(url)) return "insecure_url";      // session ids / accounts never go in cleartext
  return null;
}

/** A signed request to the hub's path (e.g. "/internal/v1/heartbeat"). */
async function signed(method, path, obj, opts = {}) {
  const why = refusal();
  if (why) return { ok: false, status: 0, error: why };
  const full = hubUrl() + path;
  let signPath;
  try { const u = new URL(full); signPath = u.pathname + u.search; } catch (e) { return { ok: false, status: 0, error: "bad_url" }; }
  const body = obj === undefined ? "" : JSON.stringify(obj);
  const k = hubKey();
  const headers = require("./hubsign").sign({ method, path: signPath, body, keyId: k.id, key: k.key });
  return request(full, { method, headers, body, ...opts });
}
const postSigned = (path, obj) => signed("POST", path, obj);
/** 1.99acm: a signed GET whose 2xx body is streamed into a new 0600 file. -> {ok, status, file?, bytes?, error?} */
function getSigned(path, { toFile, maxBytes = 64 << 20, timeoutMs = 60000 } = {}) {
  if (!toFile) throw new Error("getSigned needs toFile");
  return signed("GET", path, undefined, { toFile, maxBytes, timeoutMs });
}

// ── the poster ──
let lastPost = null, lastBeat = null, pumping = null, backoffMs = 0, retryAt = 0, wakeTimer = null, fault = null;
// per topic: {backoffMs, retryAt, status, error} while the hub refuses it - the other topics keep posting
const topicFail = new Map();
const topicReady = (topic, t = now()) => { const f = topicFail.get(topic); return !f || t >= f.retryAt; };
function topicFailed(topic, res) {
  const f = topicFail.get(topic) || { backoffMs: 0 };
  f.backoffMs = Math.min(BACKOFF_MAX_MS, f.backoffMs ? f.backoffMs * 2 : 1000);
  f.retryAt = now() + f.backoffMs;
  f.status = res.status || 0;
  f.error = res.error || null;
  topicFail.set(topic, f);
}
function wake() {
  if (!hubUrl() || wakeTimer) return;
  wakeTimer = setTimeout(() => { wakeTimer = null; pump(); }, 50);
  if (wakeTimer.unref) wakeTimer.unref();
}

/** One pass: every topic with pending rows that isn't backing off, one batch each (<= 300, id order). -> {posted, failed?}
 *  (failed: some topic's batch was refused - it backs off on its own; the others were still posted). Passes never overlap
 *  (one chain), so a row is never posted twice by two passes at once. */
let passChain = Promise.resolve();
function pumpOnce() {
  const run = passChain.then(onePass, onePass);
  passChain = run.catch(() => {});
  return run;
}
async function onePass() {
  if (!hubUrl()) return { posted: 0, idle: true };
  await init();
  // a cheap hint first (it may see another request's uncommitted row - so the real read below runs in a tx of its own,
  // where no other transaction can be open on the shared connection)
  const hint = (await getQuery("SELECT 1 AS x FROM hub_outbox WHERE posted_at IS NULL LIMIT 1"))[0];
  if (!hint) return { posted: 0 };
  const t0 = now();
  const batches = await tx(async () => {
    const topics = await getQuery("SELECT topic, MIN(id) AS first FROM hub_outbox WHERE posted_at IS NULL GROUP BY topic ORDER BY first");
    const out = [];
    for (const { topic } of topics) {
      if (!topicReady(topic, t0)) continue;                // backing off on its own
      const rows = await getQuery("SELECT id, topic, entity, payload, created_at FROM hub_outbox WHERE posted_at IS NULL AND topic = ? ORDER BY id LIMIT ?",
                                  [topic, BATCH]);
      const list = [];
      // 1.99ads: a batch reader reads every trigger row's entity of the batch at once (the same current state per entity)
      const many = readersMany[topic] ? await readersMany[topic]([...new Set(rows.filter((r) => r.payload == null).map((r) => r.entity))]) : null;
      for (const r of rows) {
        let payload = null;
        if (r.payload != null) { try { payload = JSON.parse(r.payload); } catch (e) { payload = null; } }
        else if (many) payload = many.get(String(r.entity)) || null;
        else if (readers[topic]) payload = await readers[topic](r.entity);
        list.push({ id: r.id, topic: r.topic, entity: r.entity, payload, created_at: r.created_at });
      }
      out.push({ topic, rows: list });
    }
    return out;
  });
  let posted = 0, failed = null;
  for (const b of batches) {
    if (!b.rows.length) continue;
    const res = await postSigned("/internal/v1/" + b.topic, { rows: b.rows });
    lastPost = { at: now(), topic: b.topic, rows: b.rows.length, ok: res.ok, status: res.status, error: res.error || null };
    if (!res.ok) {                                     // this topic backs off; the next topic's batch still goes
      topicFailed(b.topic, res);
      if (!failed) failed = { topic: b.topic, status: res.status, error: res.error || null };
      continue;
    }
    topicFail.delete(b.topic);
    const ids = b.rows.map((r) => r.id);
    if (fault) await fault({ topic: b.topic, ids });    // tests: a crash between the hub's 2xx and posted_at (the hub skips the re-post)
    await runQuery(`UPDATE hub_outbox SET posted_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, [now(), ...ids]);
    posted += ids.length;
  }
  return failed ? { posted, failed: true, ...failed } : { posted };
}
function pump() {
  if (pumping || !hubUrl() || now() < retryAt) return pumping;
  pumping = (async () => {
    let total = 0, last = null;
    try {
      for (let i = 0; i < 20; i++) {                     // drain a backlog quickly, then let the timer take over
        const r = await pumpOnce();
        total += r.posted || 0;
        backoffMs = 0; retryAt = 0;                       // a refused topic backs off on its own (topicFail)
        if (r.failed) last = r;
        if (!r.posted) break;
      }
      return last ? { ...last, posted: total } : { posted: total };
    } catch (e) {
      console.error("[hub_outbox] poster:", e.message);
      backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : 1000);
      retryAt = now() + backoffMs;
      return { posted: total, failed: true, error: e.message };
    }
  })().finally(() => { pumping = null; });
  return pumping;
}

// ── the head and per-topic stats (D-17, D-18) ──
/** The outbox's high-water mark: sqlite_sequence.seq (never MAX(id) - 0 on an emptied table). */
async function headId() {
  const r = (await getQuery("SELECT seq FROM sqlite_sequence WHERE name = 'hub_outbox'"))[0];
  return (r && Number(r.seq)) || 0;
}
/** {topic: {head, pending, oldest_pending_at}} for every topic with rows and every topic whose switch is on. */
async function topicStats() {
  const out = {};
  for (const [t, sw] of Object.entries(TOPICS)) if (on(sw)) out[t] = { head: 0, pending: 0, oldest_pending_at: null };
  const rows = await getQuery(`SELECT topic, MAX(id) AS head, SUM(CASE WHEN posted_at IS NULL THEN 1 ELSE 0 END) AS pending,
                                      MIN(CASE WHEN posted_at IS NULL THEN created_at END) AS oldest FROM hub_outbox GROUP BY topic`);
  for (const r of rows) {
    if (!TOPICS[r.topic]) continue;
    out[r.topic] = { head: Number(r.head) || 0, pending: Number(r.pending) || 0, oldest_pending_at: r.oldest == null ? null : Number(r.oldest) };
  }
  return out;
}
const beatSwitches = () => Object.fromEntries(SWITCHES.filter((k) => k !== "spans").map((k) => [k, on(k)]));

// ── heartbeat (§2.2; 1.99acm: + switches, topics) ──
async function heartbeatBody() {
  await init();
  let kids = [];
  try { kids = require("./chatticket").kids(); } catch (e) { kids = []; }
  return { v: 1, env: hubEnv(), at: now(), outbox_head: await headId(), jwks_kids: kids, version: VERSION, switches: beatSwitches(),
           topics: await topicStats() };
}
async function heartbeatOnce() {
  if (!hubUrl() || !on("heartbeat")) return null;
  const body = await heartbeatBody();
  const r = await postSigned("/internal/v1/heartbeat", body);
  lastBeat = { at: body.at, ok: r.ok, status: r.status, error: r.error || null };
  return lastBeat;
}

// ── snapshots (hub -> v1 GET /internal/v1/snapshot/<topic>, seam plan §2.5, D-17) ──
// Each source lists a topic's CURRENT non-default state as {entity, payload}, entity > `after`, in byte order (SQLite's
// BINARY collation; JS sorts with Buffer.compare), at most `limit`. The page merges the sources. The payloads are the feed's.
const byteCmp = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const after = (list, k) => (k == null ? list : list.filter((r) => byteCmp(r.entity, k) > 0));
const sorted = (list) => list.sort((a, b) => byteCmp(a.entity, b.entity));
const hasTable = async (t) => (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const secs = (ms) => Math.ceil(Number(ms) / 1000);

// 1.99acm: keyset paging. Every source reads at most `limit` matching rows past the cursor, through an index where the
// entity is `<prefix><indexed column>` (the prefix is constant, so the column's byte order is the entity's): the snapshot
// runs inside dbUtils.tx - the process-wide chain - so a page must stay short. bound() turns the cursor into the column's
// lower bound: "" (all), the cursor's suffix, or null (the cursor is past every entity of this prefix).
function bound(prefix, k) {
  if (k == null) return "";
  if (k.startsWith(prefix)) return k.slice(prefix.length);
  return byteCmp(k, prefix) < 0 ? "" : null;
}
const scan = { resolved: 0, parsed: 0 };          // tests: per-page work (users resolved, layouts parsed)
const PA_CHUNK = 200;

const SOURCES = {
  "sessions/revoked": {
    sessions: async (k, limit, t) => {
      const b = bound("sid:", k);
      if (b == null) return [];
      // hub_sessions_revoked (id, expires) WHERE revoked_at IS NOT NULL: in id order, no sort, no table scan
      const rows = await getQuery(`SELECT id, user_id, revoked_at, revoked_why, expires FROM sessions
                                   WHERE revoked_at IS NOT NULL AND id > ? AND expires > ? ORDER BY id LIMIT ?`, [b, t, limit]);
      return rows.map((r) => ({ entity: "sid:" + r.id, payload: sessionRow(r) }));
    },
    accounts: async (k, limit) => {
      const b = bound("acct:", k);
      if (b == null) return [];
      // the account cutoffs the FEED sent (sign out everywhere, admin, ban, password reset, deletion: hub_before - never a
      // "sign out everywhere else" / password change, which keep this device and send only per-session rows) and merges
      // (the merge wins for one id)
      const cut = await getQuery(`SELECT user_id, hub_before, hub_why FROM session_cutoffs WHERE user_id > ? AND hub_before IS NOT NULL
                                  ORDER BY user_id LIMIT ?`, [b, limit]);
      const merges = (await hasTable("account_merge_log"))
        ? await getQuery(`SELECT from_id, MAX(at) AS at, (SELECT to_id FROM account_merge_log m2 WHERE m2.from_id = m.from_id ORDER BY m2.id DESC LIMIT 1) AS to_id
                          FROM account_merge_log m WHERE from_id > ? GROUP BY from_id ORDER BY from_id LIMIT ?`, [b, limit])
        : [];
      const out = new Map();
      for (const c of cut) {
        out.set("acct:" + c.user_id, { kind: "account", account: accountOf(c.user_id), v1_user: String(c.user_id), before: secs(c.hub_before),
                                       why: c.hub_why == null ? null : String(c.hub_why) });
      }
      for (const m of merges) {
        out.set("acct:" + m.from_id, { kind: "merge", account: accountOf(m.from_id), into: accountOf(m.to_id), v1_user: String(m.from_id),
                                       v1_into: m.to_id == null ? null : String(m.to_id), before: secs(m.at) });
      }
      return sorted([...out].map(([entity, payload]) => ({ entity, payload }))).slice(0, limit);
    },
  },
  "privacy/changed": {
    incognito: async (k, limit) => incognitoState(k, limit),
    private_activity: async (k, limit) => {
      const b = bound("pa:", k);
      if (b == null) return [];
      const pl = require("./profilelayout");
      const out = [];
      let cur = b;
      for (;;) {                                          // in user_id order (the primary key), stopping at `limit` matches
        const rows = await getQuery("SELECT user_id, layout, updated FROM profile_layout WHERE user_id > ? ORDER BY user_id LIMIT ?", [cur, PA_CHUNK]);
        for (const r of rows) {
          scan.parsed++;
          let L;
          try { L = pl.sanitize(JSON.parse(r.layout)); } catch (e) { L = null; }
          if (L && pl.stateOf(L, "analytics") !== "hidden" && pl.stateOf(L, "an_rooms") !== "hidden") continue;
          out.push({ entity: "pa:" + r.user_id, payload: paRow(r.user_id, true, Number(r.updated) || null) });
          if (out.length >= limit) return out;
        }
        if (rows.length < PA_CHUNK) return out;
        cur = rows[rows.length - 1].user_id;
      }
    },
    hidden_h: async (k, limit) => {
      const b = bound("hh:", k);
      if (b == null) return [];
      const rows = await getQuery("SELECT h, since, scope FROM hub_hidden_h WHERE h > ? ORDER BY h LIMIT ?", [b, limit]);
      return rows.map((r) => ({ entity: "hh:" + r.h, payload: hhRow(r.h, true, Number(r.since), r.scope) }));
    },
  },
  "privacy/account-deleted": {
    deletions: async (k, limit) => {
      const b = bound("acct:", k);
      if (b == null) return [];
      const ad = require("./accountdelete");
      const rows = await getQuery(`SELECT id, user_id, pseudonym, done_at FROM account_deletions d
                                   WHERE user_id > ? AND state = 'done'
                                     AND id = (SELECT MAX(id) FROM account_deletions x WHERE x.user_id = d.user_id AND x.state = 'done')
                                   ORDER BY user_id LIMIT ?`, [b, limit]);
      return rows.map((r) => ({ entity: "acct:" + r.user_id, payload: ad.hubRow(r) }));
    },
  },
  "privacy/forget": {
    // (the entity's order is the TEXT order of the decimal id, so no integer index helps; the log only has a row per
    // "Make Pepe forget me", at most 3 per member a day)
    forget: async (k, limit) => {
      const pf = require("./pepeforget");
      const rows = await getQuery(`SELECT id, user_id, at FROM pepe_forget_log WHERE user_id IS NOT NULL AND ('forget:' || id) > ?
                                   ORDER BY ('forget:' || id) LIMIT ?`, [k == null ? "" : k, limit]);
      return rows.map((r) => ({ entity: "forget:" + r.id, payload: pf.hubRow(r) }));
    },
  },
  // 1.99ads (S1, seam plan §12.6): every account, merged and deleted id; the non-default looks
  "identity/changed": {
    accounts: async (k, limit) => require("./hubidentity").snapshotSource(bound("acct:", k), limit),
  },
  "looks/changed": {
    looks: async (k, limit, t) => require("./hublooks").snapshotSource(bound("acct:", k), limit, t),
  },
  // S1 Q4 (release L1, seam plan §12.6): every registry row then every approved member; accounts with a role; live feed
  // bans; every chat switch key
  "pads/changed": {
    pads: async (k, limit, t) => require("./hubpads").snapshotPads(bound("pad:", k), limit, t),
    members: async (k, limit, t) => require("./hubpads").snapshotMembers(bound("pm:", k), limit, t),
  },
  "roles/changed": {
    roles: async (k, limit) => require("./hubroles").snapshotSource(bound("acct:", k), limit),
  },
  "bans/changed": {
    bans: async (k, limit, t) => require("./hubbans").snapshotSource(k, limit, t),
  },
  "switches/changed": {
    switches: async (k, limit) => require("./chatswitches").snapshotSource(k, limit),
  },
};

/** privacy/changed incognito entities with non-default state: confirmed ON (Pepe's reports: incognito_state for linked keys,
 *  incognito_anon for every login) or a pending ON (an open privacy.incognito "on" action newer than Pepe's last report of
 *  that key, <= 24 h). {flag, value (confirmed), phase:"state", via, subject, at, pending_on, pending_at} (seam plan D-7).
 *  1.99acm: the keys come from reads of the ON rows and the open actions only; their entities (cfh:<hash> / acct:<id>) are
 *  derived, sorted and cut at the cursor and `limit` FIRST, and only that page's linked accounts are resolved - in one
 *  indexed query (incognito.usersByLogins). */
async function incognitoState(k, limit = PAGE + 1) {
  const I = require("./incognito");
  const keys = new Map();               // key -> {on, via, at, updated, pendingAt, user}
  const get = (key) => {
    if (!keys.has(key)) keys.set(key, { on: false, via: null, at: null, updated: null, pendingAt: null, user: null });
    return keys.get(key);
  };
  const stateRow = (s, r) => {
    s.on = !!r.on;
    s.via = r.via === "web" ? "web" : r.via === "chat" ? "chat" : null;
    s.updated = Number(r.updated) || null;
    s.at = Number(r.updated) || Number(r.reported) || null;
  };
  for (const r of await getQuery(`SELECT login, "on" AS "on", updated, reported, via FROM incognito_state WHERE "on" = 1`)) {
    if (I.isKey(r.login)) stateRow(get(r.login), r);
  }
  for (const r of await getQuery("SELECT login, since FROM incognito_anon")) {
    if (!I.isKey(r.login)) continue;
    const s = get(r.login);
    if (!s.on) { s.on = true; s.at = s.at || Number(r.since) || null; s.via = s.via || "chat"; }
  }
  if (await hasTable("pepe_actions")) {
    const open = await getQuery(`SELECT user_id, MAX(created) AS created FROM pepe_actions WHERE kind = 'privacy.incognito' AND args = '["on"]'
                                 AND status IN ('pending','claimed') AND created > ? GROUP BY user_id`, [now() - PENDING_ON_MS]);
    const pend = [];
    for (const a of open) {
      const key = await I.loginOf(a.user_id);
      if (key) pend.push({ key, a });
    }
    // Pepe's last report of a pending key that isn't ON (the ON ones were read above)
    const off = pend.map((p) => p.key).filter((key) => !keys.has(key));
    for (let i = 0; i < off.length; i += 400) {
      const part = off.slice(i, i + 400);
      for (const r of await getQuery(`SELECT login, "on" AS "on", updated, reported, via FROM incognito_state WHERE login IN (${part.map(() => "?").join(",")})`, part)) {
        stateRow(get(r.login), r);
      }
    }
    for (const { key, a } of pend) {
      const s = get(key);
      if (s.updated && s.updated >= Number(a.created)) continue;     // Pepe answered after it
      s.pendingAt = Number(a.created);
      s.user = String(a.user_id);
    }
  }
  let list = [];
  for (const [key, s] of keys) {
    if (!s.on && !s.pendingAt) continue;                              // default state: not listed
    const entity = I.entityOf(key);
    if (entity) list.push({ entity, key, s });
  }
  list = after(sorted(list), k).slice(0, limit);
  const need = list.filter((x) => !x.s.user && !I.ACCT_RE.test(x.key)).map((x) => x.key);
  scan.resolved += need.length;
  const users = await I.usersByLogins(need);
  return list.map(({ entity, key, s }) => {
    const user = s.user || (I.ACCT_RE.test(key) ? null : users.get(key) || null);
    const p = { flag: "incognito", value: s.on, phase: "state" };
    if (s.on && s.via) p.via = s.via;                                 // how the confirmed ON came about
    p.subject = I.subjectOf(key, user);
    p.at = Math.max(s.at || 0, s.pendingAt || 0) || now();
    p.pending_on = !!s.pendingAt;
    p.pending_at = s.pendingAt || null;
    return { entity, payload: p };
  });
}

const encCursor = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
function decCursor(c) {
  if (c == null || c === "") return null;
  let o;
  try { o = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8")); } catch (e) { o = null; }
  if (!o || typeof o.k !== "string" || !o.k || o.k.length > 200) throw Object.assign(new Error("bad cursor"), { status: 400, code: "bad_cursor" });
  return o.k;
}

/**
 * One snapshot page of a topic (seam plan §2.5, D-17). -> null when the topic is unknown, has no snapshot or its switch is off
 * (answer 404); else {v:1, topic, head, range:{after, through}, rows:[{entity, payload}], next, complete}. `head` is read
 * first, in the same SQLite transaction as the rows, so every row is at least as new as it (the hub applies a page row only
 * where its feed position <= head).
 */
let mergeIndex = false;
async function snapshot(topic, cursor, { limit = PAGE } = {}) {
  if (!SNAPSHOT_TOPICS.includes(topic) || !on(TOPICS[topic])) return null;
  await init();
  const k = decCursor(cursor);
  const lim = Math.max(1, Math.min(PAGE, Number(limit) || PAGE));
  // the source modules' tables exist before the read transaction (their CREATE TABLEs never run inside it)
  if (topic === "sessions/revoked" && !mergeIndex && (await hasTable("account_merge_log"))) {
    await runQuery("CREATE INDEX IF NOT EXISTS account_merge_log_from ON account_merge_log (from_id, id)");      // the merges' keyset
    mergeIndex = true;
  }
  if (topic === "privacy/changed") { await require("./incognito").init(); await require("./profilelayout").ready; await require("./hubhidden").init(); }
  if (topic === "privacy/account-deleted") await require("./accountdelete").init();
  if (topic === "privacy/forget") await require("./pepeforget").init();
  return tx(async () => {
    const head = await headId();
    const t = now();
    let rows = [];
    for (const [s, fn] of Object.entries(SOURCES[topic])) {
      for (const r of await fn(k, lim + 1, t)) rows.push({ ...r, s });
    }
    rows = sorted(rows);
    const more = rows.length > lim;
    const page = rows.slice(0, lim);
    const last = page.length ? page[page.length - 1] : null;
    return { v: 1, topic, head, range: { after: k, through: more && last ? last.entity : null },
             rows: page.map((r) => ({ entity: r.entity, payload: r.payload })),
             next: more && last ? encCursor({ k: last.entity, s: last.s }) : null, complete: !more };
  });
}

/** outbox/rewind (the promotion runbook, §15.4): kept rows of `topic` above `afterId` are posted again. `guard` runs first
 *  inside the same transaction (hubinbound: the request's durable nonce - a throw rolls the rewind back). */
async function rewind(topic, afterId, { guard = null } = {}) {
  if (!TOPICS[topic]) throw Object.assign(new Error("unknown topic"), { status: 404, code: "unknown_topic" });
  const a = Number(afterId);
  if (!Number.isSafeInteger(a) || a < 0) throw Object.assign(new Error("bad after_id"), { status: 400, code: "bad_after_id" });
  await init();
  const r = await tx(async () => {
    if (guard) await guard();
    const u = await runQuery("UPDATE hub_outbox SET posted_at = NULL WHERE topic = ? AND id > ? AND posted_at IS NOT NULL", [topic, a]);
    const o = (await getQuery("SELECT MIN(id) AS id FROM hub_outbox WHERE topic = ?", [topic]))[0];
    return { reposted: (u && u.changes) || 0, oldest_kept_id: o && o.id != null ? Number(o.id) : null, head: await headId() };
  });
  topicFail.delete(topic);
  wake();
  return { ok: true, ...r };
}

// ── cleanup ──
async function cleanup() {
  await init();
  const t = now();
  const a = await runQuery("DELETE FROM hub_outbox WHERE posted_at IS NOT NULL AND posted_at < ?", [t - KEEP_MS]);
  let b = { changes: 0 };
  if (!hubUrl()) {
    b = await runQuery("DELETE FROM hub_outbox WHERE posted_at IS NULL AND created_at < ?", [t - KEEP_MS]);
    if (b && b.changes) console.log(`[hub_outbox] no hub configured: ${b.changes} unposted row(s) older than 7 days removed`);
  }
  let nonces = 0;
  try { nonces = await require("./hubinbound").cleanup(); } catch (e) { console.error("[hub_outbox] inbound nonces:", e.message); }
  return { posted: (a && a.changes) || 0, unposted: (b && b.changes) || 0, nonces };
}

/** For /admin/keys#seam. */
async function status() {
  await init();
  const p = (await getQuery("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM hub_outbox WHERE posted_at IS NULL"))[0] || {};
  const q = (await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NOT NULL"))[0] || {};
  const k = hubKey();
  const t = now();
  const topics = {};
  let wait = retryAt > t ? retryAt - t : 0;
  for (const [topic, f] of topicFail) {
    topics[topic] = { retry_in_ms: Math.max(0, f.retryAt - t), status: f.status, error: f.error };
    wait = Math.max(wait, Math.max(0, f.retryAt - t));
  }
  let inbound = null, exportWait = null;
  try { inbound = require("./hubinbound").status(); } catch (e) { inbound = null; }
  try { exportWait = await require("./accountexport").hubWaits(); } catch (e) { exportWait = null; }
  return { configured: !!hubUrl(), key: !!(k.id && k.key), key_id: k.id || null, env: hubEnv(), proxy: !!String(process.env.HUB_V1_PROXY || "").trim(),
           insecure: !!hubUrl() && insecureUrl(), refusal: hubUrl() ? refusal() : null, settings: settings(),
           pending: p.n || 0, oldest_pending: p.oldest || null, posted: q.n || 0, head: await headId(), topics: await topicStats(),
           last_post: lastPost, heartbeat: lastBeat, retry_in_ms: wait, failing: topics, inbound, export_wait: exportWait,
           // 1.99ads: links left out of identity rows (they'd fail the hub's platform rule) and the looks call's counts
           s1: { ready: s1.ready, error: s1.error, identity: require("./hubidentity").status(), looks: require("./hublooks").status() },
           // S1 Q4: release L1's topics, the chat switches (CHAT_HUB is set on /admin/chat) and what CHAT_HUB still needs
           l1: { ready: l1.ready, error: l1.error, chat: safeChat(), needs: require("./chatswitches").needs(settings()) } };
}
function safeChat() { try { return require("./chatswitches").all(); } catch (e) { return null; } }

// ── econ/committed (§13): idemBegin's done() for a key in the hub interaction namespace ──
/**
 * Store an idempotent move's outcome (index.js idemBegin -> done). A key starting "ix:" (the hub's interactions; none exist in
 * v1 before S4 / S7a) also writes an econ/committed row - in the same transaction - while the `econ` switch is on: {key, tx,
 * outcome: {status, ok, code}, endpoint, at}. Definitive refusals are outcomes too. Deduped on the key (a replay never gets
 * here; a second done() writes nothing). (The hub has no intake for this topic before R-4 - seam plan D-1 - and answers 404;
 * the topic then backs off on its own.)
 */
async function idemDone(key, endpoint, status, body) {
  const b = body && typeof body === "object" ? body : {};
  const update = () => runQuery("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ?", [status, JSON.stringify(b), key]);
  if (!/^ix:/.test(String(key || "")) || !on("econ")) return update().catch(() => {});
  return tx(async () => {
    await update();
    await emit("econ/committed", String(key), {
      key: String(key), tx: b.tx || b.transactionId || null,
      outcome: { status: Number(status) || 0, ok: Number(status) < 300, code: b.error || b.code || null },
      endpoint: String(endpoint || ""), at: now(),
    }, { dedupe: "econ:" + key });
  }).catch((e) => console.error("[hub_outbox] econ/committed:", e.message));
}

// ── timers (index.js start(); nothing is sent while HUB_V1_URL is unset) ──
const timers = [];
function start() {
  init().catch((e) => console.error("[hub_outbox] init:", e.message));
  if (timers.length) return;
  const every = (ms, fn) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); timers.push(t); };
  every(POLL_MS, () => { if (hubUrl()) pump(); });
  every(HEARTBEAT_MS, () => { heartbeatOnce().catch((e) => { lastBeat = { at: now(), ok: false, status: 0, error: e.message }; }); });
  every(60 * 60 * 1000, () => { cleanup().catch((e) => console.error("[hub_outbox] cleanup:", e.message)); });
  every(30 * 1000, () => { reloadSettings().catch(() => {}); });
  try { require("./shutdown").onDrain(stop); } catch (e) { /* no graceful stop */ }
}
function stop() { while (timers.length) clearInterval(timers.pop()); }

module.exports = {
  init, start, stop, emit, settings, setSettings, reloadSettings, on, pumpOnce, pump, heartbeatOnce, heartbeatBody, cleanup, status, idemDone, request,
  postSigned, getSigned, insecureUrl, urlHasPath, refusal, hubEnv, headId, topicStats, snapshot, rewind, accountOf, ticketsReady, readers,
  privateActivity, tailnetOrLoopback, TOPICS, SNAPSHOT_TOPICS, SWITCHES, DEFAULTS, VERSION, BATCH, PAGE, KEEP_MS, readersMany, L1_SWITCHES,
  _scan: () => ({ ...scan }), _resetScan: () => { scan.resolved = 0; scan.parsed = 0; },
  clockNow: () => now(),                       // 1.99ads: the seam's clock (the looks call reads perks at it; tests set it)
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _setFault: (f) => { fault = f || null; },
  _setAccountOf: (f) => { accountOverride = f || null; },
  _resetPoster: () => { backoffMs = 0; retryAt = 0; lastPost = null; lastBeat = null; topicFail.clear(); },
};
