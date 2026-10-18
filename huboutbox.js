// huboutbox.js — v1 -> chat hub: the durable, ordered outbox of the v1 seam (R-14's first slice + R-11's pieces, 1.99acf;
// the chat design §1.7, docs/chat-tickets.md).
//
//   hub_outbox(id, topic, entity, payload, created_at, posted_at, dedupe_key)
//     * SQLite triggers on source tables write rows (so every writer is covered, CLI scripts included): sessions.revoked_at ->
//       "sessions/revoked" "sid:<sessions.id>". Trigger rows carry only (topic, entity); the poster reads the entity's CURRENT
//       state when it posts.
//     * emit(topic, entity, payload, {dedupe}) for events that are not table writes (an account cutoff, a request-time incognito
//       request, a committed engine move): ONLY inside the caller's dbUtils.tx, so the row commits or rolls back with the
//       action. Deduped on dedupe_key.
//   The poster (while HUB_V1_URL + HUB_V1_KEY are set) wakes on emit and polls every 1 s, posts batches of at most 300 rows per
//   topic in id order to HUB_V1_URL/internal/v1/<topic> (HMAC-signed, hubsign.js; HUB_V1_PROXY = the userspace tailscaled HTTP
//   proxy for an http:// hub), marks them posted only on a 2xx. Each topic has its own failure state: a topic the hub refuses
//   (a 404 from an endpoint it doesn't have yet, a 500) backs off 1 s -> 30 s on its own while the other topics keep posting;
//   order is kept within a topic. Posted rows go after 7 days; while no hub is configured, unposted rows older than 7 days go
//   too (the hub bootstraps from snapshots). The heartbeat (30 s, switch `heartbeat`) carries outbox_head = MAX(id), so the hub
//   can measure seam lag. Nothing goes to a plain http:// hub address unless it is loopback or HUB_V1_PROXY carries it (the
//   tailnet): status error "insecure_url" (/admin/keys#seam).
//   ids are AUTOINCREMENT (never reused after the table empties - the hub's v1_feed_pos and outbox/rewind{after_id} rely on
//   monotonic ids; the design's sketch says "integer primary key", docs/chat-tickets.md notes the deviation).
//   Account fields in the payloads are the hub's account_id - chatticket.subjectOf(users.userId), the ticket's `sub` (a legacy
//   id -> its UUIDv5) - with the raw id beside it as v1_user.
//
// Switches (hubseam_settings, /admin/keys#seam): tickets, heartbeat, sessions, privacy, econ (all off) and spans (on: bridge
// spans only record, bridgespans.js). A topic whose switch is off writes nothing. Nothing is sent while HUB_V1_URL is unset.
// Tickets can only be on together with `sessions` and `heartbeat` (a revoked sign-in has to reach the hub, and the hub's
// 30-minute grace rides the heartbeat): setSettings refuses any other combination, and chatticket.js won't mint without them.
"use strict";
const http = require("http");
const https = require("https");
const { runQuery, getQuery, tx, inTx } = require("./dbUtils");

const VERSION = "1.99acf";
const DAY = 86400000;
const BATCH = 300;
const POLL_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const KEEP_MS = 7 * DAY;
const TOPICS = { "sessions/revoked": "sessions", "privacy/changed": "privacy", "econ/committed": "econ" };
const SWITCHES = ["tickets", "heartbeat", "sessions", "privacy", "econ", "spans"];
const DEFAULTS = { tickets: false, heartbeat: false, sessions: false, privacy: false, econ: false, spans: true };

let clock = () => Date.now();
const now = () => clock();
const hubUrl = () => String(process.env.HUB_V1_URL || "").trim().replace(/\/+$/, "");
const hubKey = () => ({ id: String(process.env.HUB_V1_KEY_ID || "").trim(), key: String(process.env.HUB_V1_KEY || "") });

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS hub_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT,
        created_at INTEGER NOT NULL, posted_at INTEGER, dedupe_key TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS hub_outbox_pending ON hub_outbox (posted_at, id)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS hub_outbox_dedupe ON hub_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL");
      await runQuery("CREATE TABLE IF NOT EXISTS hubseam_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      // sessions/revoked: every revocation, whoever writes it (the site, an admin script), while the `sessions` switch is on
      await require("./sessions").init();
      await runQuery(`CREATE TRIGGER IF NOT EXISTS hub_outbox_session_revoked AFTER UPDATE OF revoked_at ON sessions
        WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
         AND (SELECT value FROM hubseam_settings WHERE key = 'sessions') = 'true'
        BEGIN INSERT INTO hub_outbox (topic, entity, created_at)
              VALUES ('sessions/revoked', 'sid:' || NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END`);
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
  if (after.tickets && !ticketsReady(after)) {
    throw Object.assign(new Error("Chat tickets need sign-outs to the hub (sessions) and the heartbeat on - turn those on first, or turn tickets off first."),
                        { status: 409, code: "tickets_need", refuse: true });
  }
  await tx(async () => {
    for (const [k, v] of Object.entries(next)) {
      await runQuery(`INSERT INTO hubseam_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                     [k, v ? "true" : "false", now(), actor && actor.username ? String(actor.username).slice(0, 80) : null]);
    }
    if (actor && actor.userId) await require("./adminaudit").record(actor, "hubseam.settings", null, next, null);
  });
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
const readers = {
  "sessions/revoked": async (entity) => {
    const m = /^sid:([a-f0-9]{64})$/.exec(String(entity));
    if (!m) return null;
    const r = (await getQuery("SELECT id, user_id, revoked_at, revoked_why, expires FROM sessions WHERE id = ?", [m[1]]))[0];
    if (!r) return { kind: "session", sid: m[1].slice(0, 32), gone: true };
    return { kind: "session", sid: r.id.slice(0, 32), account: accountOf(r.user_id), v1_user: String(r.user_id), at: r.revoked_at, until: r.expires,
             why: r.revoked_why };
  },
};

/** The hub's account_id for a users.userId: the ticket's `sub` (chatticket.subjectOf - a legacy id -> its UUIDv5 when
 *  CHAT_GENESIS_NS is set, else null). */
function accountOf(userId) {
  if (userId == null || userId === "") return null;
  try { return require("./chatticket").subjectOf(userId); } catch (e) { return null; }
}

// ── transport ──
/** POST (or any method) to a URL with a 10 s timeout; an http:// URL goes through HUB_V1_PROXY when set. -> {ok, status, error?} */
function request(urlStr, { method = "POST", headers = {}, body = "" } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, status: 0, error: "bad_url" }); }
    const buf = Buffer.from(body == null ? "" : String(body));
    const hdrs = { "content-type": "application/json", "content-length": buf.length, "user-agent": "patv-v1-seam/" + VERSION, ...headers };
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
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = mod.request(opts, (res) => {
      let n = 0;
      res.on("data", (c) => { n += c.length; if (n > 1 << 20) res.destroy(); });
      res.on("end", () => fin({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      res.on("error", () => fin({ ok: false, status: res.statusCode || 0, error: "response" }));
    });
    req.setTimeout(10000, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => fin({ ok: false, status: 0, error: String(e.code || "network").slice(0, 40) }));
    req.end(buf);
  });
}

const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
/** Would a POST to HUB_V1_URL cross the network in cleartext? (http:// to a non-loopback host with no HUB_V1_PROXY) */
function insecureUrl(urlStr = hubUrl()) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return false; }
  if (u.protocol !== "http:") return false;
  if (String(process.env.HUB_V1_PROXY || "").trim()) return false;      // the tailnet proxy carries it (§1.4)
  return !LOOPBACK_RE.test(u.hostname);
}

/** A signed POST to the hub's path (e.g. "/internal/v1/heartbeat"). */
async function postSigned(path, obj) {
  const url = hubUrl();
  const k = hubKey();
  if (!url) return { ok: false, status: 0, error: "unconfigured" };
  if (!k.id || !k.key) return { ok: false, status: 0, error: "no_key" };
  if (insecureUrl(url)) return { ok: false, status: 0, error: "insecure_url" };   // session ids / accounts never go in cleartext
  const full = url + path;
  let signPath;
  try { const u = new URL(full); signPath = u.pathname + u.search; } catch (e) { return { ok: false, status: 0, error: "bad_url" }; }
  const body = JSON.stringify(obj);
  const headers = require("./hubsign").sign({ method: "POST", path: signPath, body, keyId: k.id, key: k.key });
  return request(full, { method: "POST", headers, body });
}

// ── the poster ──
let lastPost = null, lastBeat = null, pumping = null, backoffMs = 0, retryAt = 0, wakeTimer = null;
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
      for (const r of rows) {
        let payload = null;
        if (r.payload != null) { try { payload = JSON.parse(r.payload); } catch (e) { payload = null; } }
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

// ── heartbeat (§2.2) ──
async function heartbeatOnce() {
  if (!hubUrl() || !on("heartbeat")) return null;
  await init();
  const head = (await getQuery("SELECT MAX(id) AS id FROM hub_outbox"))[0];
  let kids = [];
  try { kids = require("./chatticket").kids(); } catch (e) { kids = []; }
  const body = { v: 1, env: process.env.STAGING ? "staging" : "prod", at: now(), outbox_head: (head && head.id) || 0, jwks_kids: kids, version: VERSION };
  const r = await postSigned("/internal/v1/heartbeat", body);
  lastBeat = { at: body.at, ok: r.ok, status: r.status, error: r.error || null };
  return lastBeat;
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
  return { posted: (a && a.changes) || 0, unposted: (b && b.changes) || 0 };
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
  return { configured: !!hubUrl(), key: !!(k.id && k.key), proxy: !!String(process.env.HUB_V1_PROXY || "").trim(),
           insecure: !!hubUrl() && insecureUrl(), settings: settings(),
           pending: p.n || 0, oldest_pending: p.oldest || null, posted: q.n || 0, last_post: lastPost, heartbeat: lastBeat,
           retry_in_ms: wait, failing: topics };
}

// ── econ/committed (§13): idemBegin's done() for a key in the hub interaction namespace ──
/**
 * Store an idempotent move's outcome (index.js idemBegin -> done). A key starting "ix:" (the hub's interactions; none exist in
 * v1 before S4 / S7a) also writes an econ/committed row - in the same transaction - while the `econ` switch is on: {key, tx,
 * outcome: {status, ok, code}, endpoint, at}. Definitive refusals are outcomes too. Deduped on the key (a replay never gets
 * here; a second done() writes nothing).
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
  init, start, stop, emit, settings, setSettings, reloadSettings, on, pumpOnce, pump, heartbeatOnce, cleanup, status, idemDone, request,
  postSigned, insecureUrl, accountOf, ticketsReady, readers, TOPICS, SWITCHES, DEFAULTS, VERSION, BATCH, KEEP_MS,
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _resetPoster: () => { backoffMs = 0; retryAt = 0; lastPost = null; lastBeat = null; topicFail.clear(); },
};
