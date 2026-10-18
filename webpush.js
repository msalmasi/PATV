// webpush.js — 🔔 browser notifications (Web Push) for direct messages and mentions on v1 pages (1.99acd, QW-1). SHIPPED OFF.
//
// A member turns notifications on per browser in the 💬 Messages ⚙ dialog (public/js/webpush.js: the browser's own
// permission prompt only appears after they click "Turn on"). The browser hands us a push subscription (an endpoint at
// its maker's push service + two keys); we keep it here, and when a DM or a mention arrives that the existing rules
// already allow, we queue ONE content-free push and send it, encrypted (RFC 8291) and signed with our VAPID key
// (RFC 8292, webpushcrypto.js), straight to that push service. The service worker (/sw.js = public/js/push-sw.js)
// shows a generic line - "New message", "You were mentioned in <pad>" - and opens the right page on click.
//
// CONTENT-FREE (CHAT-ARCHITECTURE §7.1, the S5 push/intent row): a payload never carries message text, a sender or a
// group's title - only {v:1, k, t, b, u, tag, ts, d}: the kind, a localised generic title and body, a local link, the
// collapse tag, the time and the text direction. An Approved pad's name is never shown (a generic line instead).
//
// WHO GETS ONE (each hook runs only AFTER the feature's own rules passed; then the push-only rules below):
//   dm       messages.js send() / pepeReply(), for a member who isn't muted and doesn't block the sender (upstream)
//   mention  mentions.js (your name in a bridged pad's chat; quiet hours, mute, pad visibility upstream) and
//            feedmentions.js (@you in a post / comment; blocks, visibility, the feed switch, quiet hours upstream)
//   keyword  mentions.js, your own alert words
//   push-only: the switch + that kind's switch, an audience (admins / staff / everyone, the DB class), the member's
//   per-browser kinds, a bridge line older than late_s (backlog after a reconnect) or from a speaker whose account the
//   member blocked in DMs stays inbox-only, one DM push per conversation per dm_gap_s, at most hour_max an hour.
//   A per-kind grace (DM 0 s, mention 15 s, keyword 60 s - §7.1) during which reading it on the site cancels it
//   (DM: conversation_members.last_read_id; mentions: the 🔔 notice's read_at); muting / leaving cancels a DM push.
//   A DM push is a "burst" (dropped) only while an earlier push for that conversation inside dm_gap_s is still pending or was
//   sent and is still unread - after a read (or a push that never went out) the next DM pushes again.
//   A focused tab already on the target page gets no notification (the service worker checks).
//   A subscription belongs to the sign-in it was made under (sessions.js): signing that browser out ends its pushes, and so
//   does another account signing in there (sessions.signIn revokes the replaced sign-in; /api/push/state hands the browser
//   over). A sign-in that can't be checked right now (the database busy) is neither sent to nor dropped: the push retries.
//
// TABLES (init)
//   webpush_subs    id, endpoint UNIQUE (a capability URL: never logged or exported - logs show its host only), p256dh,
//                   auth (base64url), user_id, kinds (comma list in KINDS order), session_id (the sessions.id it was
//                   made under), vapid_kid (sha256 of our public key at subscribe time, 16 hex - another kid = stale, the
//                   browser re-subscribes), ua (the coarse family, sessions.describe - never the raw user agent), locale,
//                   expiration_time, created, updated (every subscribe / refresh / kinds change: N-1's S5 snapshot
//                   cursor), last_ok (written at most every LAST_OK_EVERY_MS), last_fail, fail_count, last_error (a short
//                   code), instance (prod | staging - the site it was made on: a copy of prod's database on staging never
//                   pushes to prod's members, whatever keys staging has). At most SUBS_MAX per account (the oldest
//                   COALESCE(last_ok, updated) goes).
//   webpush_outbox  one row per push decided: exactly the S5 push/intent fields {acct = user_id, kind, pad = room_id,
//                   src_key (UNIQUE per user: the dedupe), url} + tag (the device collapse tag), ctx (post | comment),
//                   check_ref (the read-cancel test: dm:<conv>:<msg> | inbox:<ref>), only_sub (test pushes), due_at,
//                   created, sent_at (set when the sender claims it - outcome "sending" - and again when it is done, whatever
//                   the outcome), tries, outcome (sending | sent | read | off | cap | nodevice | failed | late | gone),
//                   devices. Rows go after OUTBOX_KEEP_MS. No text is ever stored.
//   webpush_cfg     key, value, updated, actor - the switches below (/admin/push)
//
// SWITCHES (webpush_cfg; /admin/push, Admins only; cached, re-read within 10 s)
//   webpush_enabled (0)       the kill switch. Off: nothing queued, due rows dropped as "off", the UI hidden (a member
//                             with browsers still saved sees only "Turn off everywhere"), the APIs answer E_OFF (but
//                             unsubscribe); subscriptions are kept, so turning it back on resumes.
//   webpush_audience (admins) admins | staff | everyone - who sees the UI and gets pushes (checked at subscribe AND send)
//   webpush_kind_dm / _mention / _keyword (1), webpush_grace_*_s (0 / 15 / 60), webpush_dm_gap_s (30),
//   webpush_hour_max (60), webpush_late_s (120), webpush_hosts_extra ("": more push-service host names - exact names only,
//   never a wildcard: *.nip.io / *.ts.net would let any member point the sender at an address of their choosing)
// KEYS: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT from the environment, read once at init. Missing or broken ->
// the feature is off with one log line saying why (tools/vapid-keys.js makes a pair). The private key, the JWT,
// endpoints, p256dh / auth and payloads are never logged or shown; the admin page shows the kid only. docs/webpush.md.
//
// SENDING: an in-process loop (every 2 s + a kick on every insert, single-flight, at most INFLIGHT_MAX requests at once)
// over the due outbox rows. A row is CLAIMED (sent_at + outcome "sending") before anything goes out, so a database hiccup
// after the push service took it, or a second process, can never send it twice (at most once: right for a content-free
// buzz); the sweep closes rows stuck in "sending". 2xx ok; 404 / 410 remove the subscription; 401 / 403 = our VAPID JWT was
// refused (Apple BadJwtToken / ExpiredJwtToken, WNS, FCM credentials - a bad subject, key or clock: kept, loud log,
// Overview alert; a 403 counts as a failure, so a row that only ever gets 403 goes with the long-dead sweep); 429 / 5xx /
// timeouts retry after 30 s, 2 min, 10 min (Retry-After honoured per push service); redirects are never followed.
// Requests go out through https.request with a pinned lookup (§16): the push service's name is resolved here, loopback /
// private / link-local / CGNAT / ULA / multicast answers are refused ("addr", never retried), and the socket connects to
// the checked address. The RFC 8030 Topic header (which push services read) is keyed per subscription - HMAC(auth, tag) -
// so it collapses per device but can't link the members of a conversation or be reversed to a pad id; the payload is
// padded to a fixed size so its length doesn't give away a pad's name.
// Every 10 minutes: subscriptions of ended sign-ins / expired / long dead / another instance's go, old rows go.
//
// Routes (signed in, same site + X-Requested-With: fetch, JSON; endpoints only ever travel in a POST body)
//   POST /api/push/state         {endpoint?} -> {key, kid, kinds (offered), mine: {known, kinds} | null, others}
//                                (an endpoint saved for ANOTHER account: the browser changed hands - that row goes)
//   POST /api/push/subscribe     {subscription: {endpoint, expirationTime, keys: {p256dh, auth}}, kinds} -> {kinds, others}
//   POST /api/push/unsubscribe   {endpoint} | {all: true} -> {removed}   - ALWAYS answers, even while the switch is off or
//                                the member is out of the audience: turning notifications off never depends on them being on
//   POST /api/push/test          {endpoint} -> {queued}
//   POST /api/push/resubscribe   {old_endpoint, subscription} (the service worker's pushsubscriptionchange)
//   GET  /sw.js                  the service worker (root scope; no fetch handler, so it never touches page loads).
//                                serveWorker, mounted by index.js BEFORE the session / activity middleware: a browser's own
//                                soft-update fetches must not extend a sign-in or count as a visit
//   GET  /admin/push             the admin page (views/admin/push.ejs; Admins only, by the DB class)
//   POST /api/admin/push/settings  {settings: {webpush_*}}      POST /api/admin/push/test  (your own browsers)
"use strict";
const crypto = require("crypto");
const dns = require("dns");
const https = require("https");
const net = require("net");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const C = require("./webpushcrypto");

const KINDS = Object.freeze(["dm", "mention", "keyword"]);   // what a member can turn on (reply is reserved for N-1)
const AUDIENCES = Object.freeze(["admins", "staff", "everyone"]);
const DEFAULTS = Object.freeze({
  webpush_enabled: 0, webpush_audience: "admins", webpush_kind_dm: 1, webpush_kind_mention: 1, webpush_kind_keyword: 1,
  webpush_grace_dm_s: 0, webpush_grace_mention_s: 15, webpush_grace_keyword_s: 60, webpush_dm_gap_s: 30, webpush_hour_max: 60,
  webpush_late_s: 120, webpush_hosts_extra: "",
});
const BOOLS = Object.freeze(["webpush_enabled", "webpush_kind_dm", "webpush_kind_mention", "webpush_kind_keyword"]);
const LIMITS = Object.freeze({
  webpush_grace_dm_s: [0, 300], webpush_grace_mention_s: [0, 600], webpush_grace_keyword_s: [0, 900],
  webpush_dm_gap_s: [0, 600], webpush_hour_max: [1, 500], webpush_late_s: [30, 3600],
});
const DEFAULT_HOSTS = Object.freeze(["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
                                     "web.push.apple.com", "*.push.apple.com", "*.notify.windows.com"]);
const SUBS_MAX = 10;                       // subscriptions per account
const ENDPOINT_MAX = 1024;
const OUTBOX_KEEP_MS = 3 * 86400e3;
const LAST_OK_EVERY_MS = 10 * 60e3;
const TICK_MS = 2000, SWEEP_MS = 10 * 60e3;
const BATCH = 25, INFLIGHT_MAX = 8, TIMEOUT_MS = 10e3;
const RETRY_STEPS = Object.freeze([30e3, 120e3, 600e3]);
const DEAD_FAILS = 20, DEAD_AGE_MS = 30 * 86400e3;
const CFG_TTL_MS = 10e3, ACCOUNT_TTL_MS = 60e3;
const TTL = Object.freeze({ dm: 86400, mention: 7200, keyword: 3600, test: 60 });           // seconds the push service keeps it
const URGENCY = Object.freeze({ dm: "high", mention: "high", keyword: "normal", test: "high" });
const TEST_URL = "/messages?settings=1#push";
const PAD_TO = 1024;                       // every payload record padded to this many bytes (more: the next 512)
const STUCK_MS = 5 * 60e3;                 // a row still "sending" this long after its claim: the process died mid-send
/** The site this process is (a subscription remembers where it was made). STAGING is set on staging only. */
const INSTANCE = () => (process.env.STAGING ? "staging" : "prod");

let NOW = () => Date.now();
const _setClock = (fn) => { NOW = fn || (() => Date.now()); };

// ── the transport (§16: a server request to a URL a user influenced goes to public addresses only, on a pinned socket) ──
const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
                      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
                      ["224.0.0.0", 4], ["240.0.0.0", 4]]) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64]]) {
  BLOCKED.addSubnet(a, p, "ipv6");
}
/** Loopback, private (RFC 1918), link-local, CGNAT / tailnets (100.64/10), ULA, multicast, documentation, unspecified - or junk? */
function blockedAddr(ip) {
  const s = String(ip || "").toLowerCase().split("%")[0];
  const v = net.isIP(s);
  if (v === 4) return BLOCKED.check(s, "ipv4");
  if (v !== 6) return true;
  let m = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);            // IPv4-mapped, dotted
  if (m) return net.isIP(m[1]) !== 4 || BLOCKED.check(m[1], "ipv4");
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);                                      // IPv4-mapped, hex
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return BLOCKED.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return BLOCKED.check(s, "ipv6");
}
let RESOLVE = dns.lookup;
/** net.connect's lookup: resolve here, keep only public answers, connect to one of those (never re-resolved). */
function pinnedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const o = options || {};
  const q = { all: true, verbatim: true };
  if (o.family === 4 || o.family === 6) q.family = o.family;
  RESOLVE(hostname, q, (err, list) => {
    if (err) return cb(err);
    const ok = (Array.isArray(list) ? list : []).filter((a) => a && !blockedAddr(a.address));
    if (!ok.length) {
      const e = new Error(`${hostname} resolves to no public address`);
      e.code = "E_ADDR";
      return cb(e);
    }
    if (o.all) return cb(null, ok.map((a) => ({ address: a.address, family: a.family })));
    cb(null, ok[0].address, ok[0].family);
  });
}
const PUSH_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 60e3, lookup: pinnedLookup });
/** POST to a push service: {status, headers: {get}}. Redirects are never followed (https.request doesn't). */
function pushRequest(url, { method = "POST", headers = {}, body = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      const h = Object.assign({}, headers);
      if (body) h["Content-Length"] = String(body.length);
      req = https.request(url, { method, headers: h, agent: PUSH_AGENT, signal }, (res) => {
        const hd = res.headers || {};
        res.resume();                                    // the body isn't used (reading it frees the socket)
        resolve({ status: res.statusCode, headers: { get: (k) => { const v = hd[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(", ") : String(v); } } });
      });
    } catch (e) { reject(e); return; }
    req.on("error", reject);
    req.end(body || undefined);
  });
}
let TRANSPORT = pushRequest;
const _setTransport = (fn) => { TRANSPORT = fn || pushRequest; };
const _setLookup = (fn) => { RESOLVE = fn || dns.lookup; };

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code || null; } }

// ── keys ──
const WHY_TEXT = Object.freeze({
  missing: "no VAPID key pair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set) - node tools/vapid-keys.js makes one",
  bad_public: "VAPID_PUBLIC_KEY isn't a P-256 public key",
  mismatch: "VAPID_PRIVATE_KEY doesn't match VAPID_PUBLIC_KEY",
  bad_subject: "VAPID_SUBJECT must be a mailto: or https: address",
});
let VAPID = { ok: false, why: "missing" };
function loadKeys(env) {
  VAPID = C.loadVapid(env || process.env);
  if (!VAPID.ok) console.log(`[webpush] off: ${WHY_TEXT[VAPID.why] || VAPID.why}`);
  return VAPID;
}
/** For the admin page: configured or not (and why), and the public key's fingerprint. Never anything secret. */
function keyStatus() {
  return { configured: !!VAPID.ok, why: VAPID.ok ? null : VAPID.why, reason: VAPID.ok ? null : WHY_TEXT[VAPID.why] || VAPID.why, kid: VAPID.ok ? VAPID.kid : null };
}

// ── tables ──
const SUBS_USERS = new Set();        // accounts with at least one subscription: the hooks' first, free test
let SUBS_READY = false;
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS webpush_subs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        user_id TEXT NOT NULL, kinds TEXT NOT NULL DEFAULT 'dm,mention,keyword', session_id TEXT, vapid_kid TEXT NOT NULL,
        ua TEXT, locale TEXT, expiration_time INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        last_ok INTEGER, last_fail INTEGER, fail_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, instance TEXT)`);
      const cols = new Set((await getQuery("PRAGMA table_info(webpush_subs)")).map((c) => c.name));
      if (!cols.has("instance")) await runQuery("ALTER TABLE webpush_subs ADD COLUMN instance TEXT");
      await runQuery("CREATE INDEX IF NOT EXISTS webpush_subs_user ON webpush_subs (user_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS webpush_subs_updated ON webpush_subs (updated)");     // N-1's snapshot cursor (S5)
      await runQuery(`CREATE TABLE IF NOT EXISTS webpush_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, room_id TEXT, src_key TEXT NOT NULL,
        url TEXT NOT NULL, tag TEXT NOT NULL, ctx TEXT, check_ref TEXT, only_sub INTEGER, due_at INTEGER NOT NULL,
        created INTEGER NOT NULL, sent_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, outcome TEXT, devices INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS webpush_outbox_src ON webpush_outbox (user_id, src_key)");
      await runQuery("CREATE INDEX IF NOT EXISTS webpush_outbox_due ON webpush_outbox (sent_at, due_at)");
      await runQuery("CREATE INDEX IF NOT EXISTS webpush_outbox_tag ON webpush_outbox (user_id, tag, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS webpush_cfg (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
      await loadSubsUsers();
      loadKeys(process.env);
      if (VAPID.ok) {
        const c = await readConfig();
        console.log(`[webpush] keys loaded (kid ${VAPID.kid}); sending is ${c.webpush_enabled ? "on" : "off"} (/admin/push)`);
      }
    })().catch((e) => { console.error("[webpush] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
async function loadSubsUsers() {
  const rows = await getQuery("SELECT DISTINCT user_id FROM webpush_subs");
  SUBS_USERS.clear();
  for (const r of rows) SUBS_USERS.add(r.user_id);
  SUBS_READY = true;
}
async function refreshUser(uid) {
  const r = (await getQuery("SELECT 1 AS x FROM webpush_subs WHERE user_id = ? LIMIT 1", [uid]))[0];
  if (r) SUBS_USERS.add(uid); else SUBS_USERS.delete(uid);
}

// ── settings ──
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** "a.example, b.example" -> {ok: [host], bad: [what was refused]}. Exact names only: never a wildcard ("*.nip.io" would
 *  let a member pick a name that resolves anywhere), an IP, a port or a path. */
function cleanHosts(v) {
  const ok = [], bad = [];
  for (const h of String(v == null ? "" : v).split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20)) {
    if (HOST_RE.test(h) && !net.isIP(h)) { if (!ok.includes(h)) ok.push(h); } else bad.push(h.slice(0, 80));
  }
  return { ok, bad };
}
/** A patch over `base` -> a clean config. strict (an admin's save): junk is refused, not silently dropped. */
function cleanSettings(patch, base = DEFAULTS, { strict = false } = {}) {
  const out = Object.assign({}, DEFAULTS, base);
  const p = patch && typeof patch === "object" ? patch : {};
  for (const k of BOOLS) if (p[k] !== undefined && p[k] !== null) out[k] = bool(p[k]) ? 1 : 0;
  if (p.webpush_audience !== undefined && p.webpush_audience !== null) {
    const a = String(p.webpush_audience);
    if (AUDIENCES.includes(a)) out.webpush_audience = a;
    else if (strict) throw new Refuse(400, "The audience is admins, staff or everyone.");
  }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (p[k] === undefined || p[k] === null || p[k] === "") continue;
    const n = Math.floor(Number(p[k]));
    if (Number.isFinite(n)) out[k] = Math.max(lo, Math.min(hi, n));
    else if (strict) throw new Refuse(400, `${k} must be a number.`);
  }
  if (p.webpush_hosts_extra !== undefined && p.webpush_hosts_extra !== null) {
    const h = cleanHosts(p.webpush_hosts_extra);
    if (h.bad.length && strict) throw new Refuse(400, `Not a push service host name (exact names only - no wildcards, IPs or ports): ${h.bad.join(", ")}`);
    out.webpush_hosts_extra = h.ok.join(",");
  }
  return out;
}
async function readConfig() {
  const raw = {};
  for (const r of await getQuery("SELECT key, value FROM webpush_cfg")) raw[r.key] = r.value;
  return cleanSettings(raw);
}
let CFG = null, CFG_AT = 0;
/** The current switches (cached; another process's edit lands within CFG_TTL_MS). */
async function config(fresh = false) {
  if (!fresh && CFG && Date.now() - CFG_AT < CFG_TTL_MS) return CFG;
  await init();
  CFG = await readConfig();
  CFG_AT = Date.now();
  return CFG;
}
async function settingsView() { return Object.assign({}, await config()); }
const showVal = (k, v) => (BOOLS.includes(k) ? (v ? "on" : "off") : k === "webpush_hosts_extra" ? JSON.stringify(v || "") : String(v));
/** An admin's save: cleaned (refused when junk), audited, logged. -> the new config */
async function saveSettings(patch, admin) {
  const cur = await config(true);
  const next = cleanSettings(patch, cur, { strict: true });
  const changes = {};
  for (const k of Object.keys(DEFAULTS)) if (String(next[k]) !== String(cur[k])) changes[k] = [cur[k], next[k]];
  const t = NOW(), actor = String((admin && (admin.username || admin.userId)) || "?").slice(0, 60);
  for (const k of Object.keys(changes)) {
    await runQuery(`INSERT INTO webpush_cfg (key, value, updated, actor) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`, [k, String(next[k]), t, actor]);
  }
  CFG = next;
  CFG_AT = Date.now();
  if (Object.keys(changes).length) {
    console.log(`[webpush] settings saved by ${actor}: ` + Object.entries(changes).map(([k, [a, b]]) => `${k.replace(/^webpush_/, "")} ${showVal(k, a)}->${showVal(k, b)}`).join(" "));
    if (admin && admin.userId) {
      await require("./adminaudit").record(admin, "webpush.settings", null, { changes }).catch((e) => console.warn(`[webpush] audit: ${e.message}`));
    }
  }
  return next;
}
const offeredKinds = (cfg) => KINDS.filter((k) => cfg["webpush_kind_" + k]);

// ── who ──
const ACCOUNTS = new Map();          // userId -> {v: {class, archived_at} | null, at}
let USER_COLS = null;
async function accountOf(uid) {
  const c = ACCOUNTS.get(uid);
  if (c && Date.now() - c.at < ACCOUNT_TTL_MS) return c.v;
  if (!USER_COLS) USER_COLS = new Set((await getQuery("PRAGMA table_info(users)")).map((x) => x.name));
  const r = (await getQuery(`SELECT class, ${USER_COLS.has("archived_at") ? "archived_at" : "NULL AS archived_at"} FROM users WHERE userId = ?`, [uid]))[0] || null;
  ACCOUNTS.set(uid, { v: r, at: Date.now() });
  if (ACCOUNTS.size > 5000) ACCOUNTS.clear();
  return r;
}
function audienceOk(acc, cfg) {
  if (!acc || acc.archived_at) return false;
  if (cfg.webpush_audience === "everyone") return true;
  // 1.99ack: an audience the webpush_audience SETTING names (a rollout group, not a capability) - the class ladder (siteperms.atLeast)
  if (cfg.webpush_audience === "staff") return SP.atLeast(acc, "staff");
  return SP.atLeast(acc, "admin");
}
/** May this member see / use browser notifications right now? (switch on, keys loaded, in the audience) Never throws. */
async function available(user) {
  try {
    if (!user || !user.userId) return false;
    await init();
    if (!VAPID.ok) return false;
    const cfg = await config();
    if (!cfg.webpush_enabled) return false;
    return audienceOk(await accountOf(String(user.userId)), cfg);
  } catch (e) { return false; }
}
/**
 * What the Messages ⚙ dialog's widget needs: {key, kid, kinds} while it's offered to this member; {off: true, count} when
 * it isn't (switched off, out of the audience, no keys) but browsers of theirs are still saved - so they can always turn
 * them off; null otherwise.
 */
async function clientConfig(user) {
  if (await available(user)) {
    const cfg = await config();
    const kinds = offeredKinds(cfg);
    if (kinds.length) return { key: VAPID.publicKey, kid: VAPID.kid, kinds };
  }
  const n = user && user.userId ? await countAll(user.userId).catch(() => 0) : 0;
  return n ? { off: true, count: n } : null;
}
/** How many browsers this account has notifications on in (the settings hub's state). */
async function countFor(userId) {
  await init();
  return (await getQuery("SELECT COUNT(*) AS n FROM webpush_subs WHERE user_id = ? AND vapid_kid = ?", [String(userId || ""), VAPID.kid || ""]))[0].n;
}
/** Every saved browser of this account, whatever the key or the switches (what "Turn off everywhere" would remove). */
async function countAll(userId) {
  const uid = String(userId || "");
  if (!uid) return 0;
  await init();
  if (SUBS_READY && !SUBS_USERS.has(uid)) return 0;               // the free test: most members have none
  return (await getQuery("SELECT COUNT(*) AS n FROM webpush_subs WHERE user_id = ?", [uid]))[0].n;
}

// ── endpoints (an SSRF guard: we POST to whatever URL a browser gave us, so only known push services) ──
function hostOf(ep) { try { return new URL(ep).hostname.toLowerCase(); } catch (e) { return "?"; } }
function endpointOk(ep, cfg) {
  if (typeof ep !== "string" || !ep || ep.length > ENDPOINT_MAX) return false;
  let u;
  try { u = new URL(ep); } catch (e) { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  if (!h || h.startsWith("[") || net.isIP(h)) return false;
  const list = DEFAULT_HOSTS.concat(cleanHosts(cfg && cfg.webpush_hosts_extra).ok);
  return list.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}
function familyOf(host) {
  const h = String(host || "");
  if (/(^|\.)googleapis\.com$/.test(h)) return "fcm";
  if (/(^|\.)mozilla\.com$/.test(h)) return "mozilla";
  if (/(^|\.)apple\.com$/.test(h)) return "apple";
  if (/(^|\.)windows\.com$/.test(h)) return "wns";
  return "other";
}

// ── text ──
const snip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + "…" : x; };
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#34;": '"', "&#39;": "'" };
/** Catalog text is HTML-safe; a notification is plain text. */
const plain = (s) => String(s == null ? "" : s).replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#34|#39);/g, (m) => ENT[m]);
function tFor(lang) {
  try { return require("./i18n").tFor(lang || "en"); } catch (e) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e2) { en = {}; }
    const t = (k) => String(en[k] || k);
    t.dir = "ltr";
    return t;
  }
}
function langFor(uid, sub) {
  let l = null;
  try { l = require("./i18n").getPref(uid); } catch (e) { l = null; }
  return l || (sub && sub.locale) || "en";
}
const PAD_NAMES = new Map();         // room id -> the bridge's name for it (mentions.js hands it over; never stored)
function rememberPad(roomId, name) {
  if (!roomId || !name) return;
  PAD_NAMES.set(String(roomId), String(name).slice(0, 120));
  if (PAD_NAMES.size > 2000) PAD_NAMES.delete(PAD_NAMES.keys().next().value);
}
/** A pad's name for a title, or null: never for an Approved pad (or one whose level isn't known yet). */
function padTitle(roomId) {
  if (!roomId) return null;
  let lv = null;
  try { const PA = require("./padaccess"); lv = PA.isReady() ? PA.levelOf(roomId) : null; } catch (e) { lv = null; }
  if (!lv || lv === "approved") return null;
  let name = null;
  try { const r = require("./rooms").getCached(roomId); name = r && r.title; } catch (e) { name = null; }
  name = name || PAD_NAMES.get(String(roomId)) || null;
  return name ? snip(name, 40) || null : null;
}
/** The device payload for one row in one language (§7.4). Rendered at send time; only the kind and the pad id are stored. */
function render(row, lang) {
  const T = tFor(lang);
  const fill = (key, pad) => plain(T(key)).replace(/\{!?pad\}/g, () => pad);   // a function: "$&" in a pad name stays literal
  let title, body = plain(T("push.generic.open"));
  if (row.kind === "dm") title = plain(T("push.generic.dm"));
  else if (row.kind === "mention" && row.ctx === "comment") title = plain(T("push.generic.mention_comment"));
  else if (row.kind === "mention" && row.ctx === "post") title = plain(T("push.generic.mention_post"));
  else if (row.kind === "mention" || row.kind === "keyword") {
    const pad = padTitle(row.room_id);
    title = pad ? fill(`push.generic.${row.kind}_in`, pad) : plain(T(`push.generic.${row.kind}`));
  } else { title = plain(T("push.test.title")); body = plain(T("push.test.body")); }
  return { v: 1, k: row.kind, t: title, b: body, u: safeLink(row.url) || "/", tag: row.tag, ts: Number(row.created) || NOW(), d: T.dir === "rtl" ? "rtl" : "ltr" };
}
function safeLink(l) {
  try { return require("./inbox").safeLink(l); } catch (e) {
    const s = String(l || "");
    return /^\/(?![/\\])[^\s\\"'<>]{0,299}$/.test(s) ? s : null;
  }
}
const cleanRef = (s) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, 120);
/** The RFC 8030 Topic (sent in the clear; push services read it): keyed with this subscription's auth secret, so the same
 *  browser + tag collapse while two members of one conversation get unrelated values, and a pad id can't be looked up. */
const topicOf = (tag, auth) => crypto.createHmac("sha256", C.unb64u(auth) || Buffer.from(String(auth || ""), "utf8"))
  .update(String(tag)).digest("base64url").slice(0, 32);

// ── health (in memory since the start + SQL over the outbox) ──
const STATS = { since: Date.now(), outcomes: {}, hosts: {}, removed: {}, vapidErrorAt: 0, vapidErrorStatus: null, lastError: null };
function bump(outcome, kind) {
  const o = (STATS.outcomes[kind || "?"] = STATS.outcomes[kind || "?"] || {});
  o[outcome] = (o[outcome] || 0) + 1;
}
function hostStat(fam, st) {
  const cls = typeof st === "number" && st ? `${Math.floor(st / 100)}xx` : String(st);
  const h = (STATS.hosts[fam] = STATS.hosts[fam] || {});
  h[cls] = (h[cls] || 0) + 1;
}
const LOGGED = new Map();
function logOnce(key, everyMs, line) {
  const t = Date.now();
  if (t - (LOGGED.get(key) || 0) < everyMs) return;
  LOGGED.set(key, t);
  console.log(line);
}

// ── hooks (fire and forget: they never throw into, or make wait, the DM / mention that called them) ──
const chains = new Map();            // userId -> the tail of its queue: one member's pushes are decided in order
function serial(uid, fn) {
  const prev = chains.get(uid) || Promise.resolve();
  const p = prev.then(fn, fn).catch((e) => console.error("[webpush] queue:", e.message));
  chains.set(uid, p);
  p.finally(() => { if (chains.get(uid) === p) chains.delete(uid); });
  return p;
}
/** messages.js: a new DM for `userId` that already passed the mute / block rules. {conversationId, messageId} */
function onDm(userId, m) {
  try {
    const uid = String(userId || "");
    if (!uid || !m || !m.conversationId || !m.messageId) return;
    if (SUBS_READY && !SUBS_USERS.has(uid)) return;
    serial(uid, () => queueDm(uid, m));
  } catch (e) { /* never fails the send */ }
}
/**
 * mentions.js / feedmentions.js: a 🔔 mention notice was just stored for `userId`.
 * {kind: mention | keyword, roomId (null for the feed), url, srcKey (the notice's ref), at (the line's time), speaker
 *  (the line's chat login), ctx (post | comment: the feed), padName (the bridge's name for the room)}
 */
function onMention(userId, o) {
  try {
    const uid = String(userId || "");
    if (!uid || !o || !o.srcKey) return;
    if (o.roomId && o.padName) rememberPad(o.roomId, o.padName);
    if (SUBS_READY && !SUBS_USERS.has(uid)) return;
    serial(uid, () => queueMention(uid, o));
  } catch (e) { /* never fails the alert */ }
}
async function gate(uid, kind) {
  await init();
  if (!VAPID.ok) return null;
  const cfg = await config();
  if (!cfg.webpush_enabled || !cfg["webpush_kind_" + kind]) return null;
  if (!SUBS_USERS.has(uid)) return null;
  if (!audienceOk(await accountOf(uid), cfg)) return null;
  return { cfg, t: NOW() };
}
async function queueDm(uid, m) {
  const g = await gate(uid, "dm");
  if (!g) return false;
  const conv = String(m.conversationId), mid = Math.floor(Number(m.messageId));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conv) || !(mid > 0)) return false;
  // muted / left: nothing to queue (send() hands a 1:1's recipient over without reading its mute); checked again when it's due
  const mem = (await getQuery("SELECT muted, left_at, last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [conv, uid]).catch(() => []))[0];
  if (mem && (mem.muted || mem.left_at)) { bump("muted", "dm"); return false; }
  const tag = "dm:" + conv;
  // a burst: an earlier push for this conversation inside the gap is still waiting, or went out and its message is still
  // unread (the device already shows "New message" for it). Read since, or never sent (read / off / nodevice / failed ...):
  // this one pushes.
  if (g.cfg.webpush_dm_gap_s > 0) {
    const prev = (await getQuery(`SELECT check_ref FROM webpush_outbox WHERE user_id = ? AND tag = ? AND created > ?
                                  AND (outcome IS NULL OR outcome IN ('sending', 'sent')) ORDER BY id DESC LIMIT 1`,
                                 [uid, tag, g.t - g.cfg.webpush_dm_gap_s * 1000]))[0];
    const pm = prev && /^dm:.+:(\d+)$/.exec(String(prev.check_ref || ""));
    if (pm && !(mem && Number(mem.last_read_id) >= Number(pm[1]))) { bump("burst", "dm"); return false; }
  }
  return insert(uid, g.cfg, g.t, { kind: "dm", room_id: null, src_key: `dm:${conv}:${mid}`, url: `/messages/c/${conv}`, tag, ctx: null,
                                   check_ref: `dm:${conv}:${mid}`, due_at: g.t + g.cfg.webpush_grace_dm_s * 1000 });
}
async function queueMention(uid, o) {
  const kind = o.kind === "keyword" ? "keyword" : "mention";
  const g = await gate(uid, kind);
  if (!g) return false;
  const ref = cleanRef(o.srcKey);
  if (!ref) return false;
  const roomId = o.roomId ? String(o.roomId).slice(0, 128) : null;
  if (roomId) {
    const at = Number(o.at) || 0;
    if (at && g.t - at > g.cfg.webpush_late_s * 1000) { bump("late", kind); return false; }      // bridge backlog: inbox only
    if (o.speaker && (await speakerBlocked(uid, o.speaker))) { bump("blocked", kind); return false; }
  }
  return insert(uid, g.cfg, g.t, { kind, room_id: roomId, src_key: ref, url: safeLink(o.url) || (roomId ? "/p" : "/feed"),
                                   tag: roomId ? `${kind}:${roomId}` : "mention:feed", ctx: roomId ? null : o.ctx === "comment" ? "comment" : "post",
                                   check_ref: "inbox:" + ref, due_at: g.t + g.cfg[`webpush_grace_${kind}_s`] * 1000 });
}
/** Does `uid` block (DMs, messages.js dm_blocks) the account behind this chat login? A web-relay line's login is u:<userId>. */
async function speakerBlocked(uid, speaker) {
  try {
    const s = String(speaker || "").trim();
    if (!s) return false;
    const m = /^u:(.+)$/i.exec(s);
    const who = m ? (await getQuery("SELECT userId FROM users WHERE LOWER(userId) = LOWER(?) LIMIT 1", [m[1]]))[0]
                  : (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?) LIMIT 1", [s]))[0];
    if (!who) return false;
    return !!(await getQuery("SELECT 1 AS x FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ? LIMIT 1", [uid, who.userId]))[0];
  } catch (e) { return false; }
}
async function insert(uid, cfg, t, r) {
  if (r.kind !== "test") {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM webpush_outbox WHERE user_id = ? AND created > ? AND kind != 'test'", [uid, t - 3600e3]))[0].n;
    if (n >= cfg.webpush_hour_max) { bump("cap", r.kind); return false; }
  }
  const ins = await runQuery(`INSERT OR IGNORE INTO webpush_outbox (user_id, kind, room_id, src_key, url, tag, ctx, check_ref, only_sub, due_at, created)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                             [uid, r.kind, r.room_id || null, r.src_key, r.url, r.tag, r.ctx || null, r.check_ref || null, r.only_sub || null, r.due_at, t]);
  if (!(ins && ins.changes)) return false;                      // the same src_key again: one push
  if (Math.random() < 0.02) runQuery("DELETE FROM webpush_outbox WHERE created < ?", [t - OUTBOX_KEEP_MS]).catch(() => {});
  kick();
  return true;
}
/** Test pushes to one subscription (subId) or all of this account's. -> how many browsers. */
async function queueTest(uid, subId = null) {
  await init();
  if (!VAPID.ok) return 0;
  const t = NOW();
  const subs = subId ? await getQuery("SELECT id FROM webpush_subs WHERE id = ? AND user_id = ? AND vapid_kid = ?", [subId, uid, VAPID.kid])
                     : await getQuery("SELECT id FROM webpush_subs WHERE user_id = ? AND vapid_kid = ?", [uid, VAPID.kid]);
  for (const s of subs) {
    await insert(uid, null, t, { kind: "test", room_id: null, src_key: `test:${s.id}:${Math.floor(t / 60e3)}`, url: TEST_URL, tag: "test", only_sub: s.id, due_at: t });
  }
  return subs.length;
}

// ── the sender ──
let AUTO = false;                    // the timers run (not in tests: they call drain())
let STOPPING = false;
function kick() { if (AUTO && !STOPPING) setImmediate(() => { drain().catch((e) => console.error("[webpush] drain:", e.message)); }); }
let inflight = 0;
const waiters = [];
async function slot(fn) {
  while (inflight >= INFLIGHT_MAX) await new Promise((r) => waiters.push(r));
  inflight++;
  try { return await fn(); } finally { inflight--; const w = waiters.shift(); if (w) w(); }
}
const BACKOFF = new Map();           // push-service host -> ms: Retry-After
function retryAfter(res, t) {
  let v = null;
  try { v = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null; } catch (e) { v = null; }
  if (!v) return 0;
  const s = Number(v);
  const until = Number.isFinite(s) ? t + s * 1000 : Date.parse(v);
  return Number.isFinite(until) && until > t ? Math.min(until, t + 3600e3) : 0;
}
let TICKING = null, AGAIN = false;
/** Send everything due now (single-flight: a call while it runs makes it go round once more). */
function drain() {
  if (TICKING) { AGAIN = true; return TICKING; }
  TICKING = (async () => {
    try {
      await init();
      for (let round = 0; round < 40 && !STOPPING; round++) {
        AGAIN = false;
        const t = NOW();
        const rows = await getQuery("SELECT * FROM webpush_outbox WHERE sent_at IS NULL AND due_at <= ? ORDER BY id LIMIT ?", [t, BATCH]);
        if (!rows.length) break;
        const cfg = await config();
        await Promise.all(rows.map(async (r) => {
          if (!(await claim(r, t))) return;                     // another drain (or process) has it, or the claim failed
          await deliver(r, cfg, t).catch(async (e) => {
            console.error("[webpush] deliver:", e.message);
            await finish(r, "failed", t).catch(() => {});
          });
        }));
        if (rows.length < BATCH && !AGAIN) break;
      }
    } finally { TICKING = null; }
  })();
  return TICKING;
}
/** Take a due row before sending it: whatever happens after (a failed write once the push service took it, a crash), it
 *  is never picked again - at most one buzz per row. -> true when this call got it. */
async function claim(row, t) {
  try {
    const r = await runQuery("UPDATE webpush_outbox SET sent_at = ?, outcome = 'sending' WHERE id = ? AND sent_at IS NULL", [t, row.id]);
    return !!(r && r.changes === 1);
  } catch (e) {
    console.error("[webpush] claim:", e.message);
    return false;
  }
}
async function finish(row, outcome, t, devices = 0, tries = null) {
  await runQuery("UPDATE webpush_outbox SET sent_at = ?, outcome = ?, devices = ?, tries = COALESCE(?, tries) WHERE id = ?", [t, outcome, devices, tries, row.id]);
  bump(outcome, row.kind);
  return outcome;
}
/** Read on the site (or muted / left) since it was queued? */
async function isRead(row) {
  const ref = String(row.check_ref || "");
  let m = /^dm:(.+):(\d+)$/.exec(ref);
  if (m) {
    const r = (await getQuery("SELECT last_read_id, left_at, muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [m[1], row.user_id]).catch(() => []))[0];
    return !r || !!r.left_at || !!r.muted || Number(r.last_read_id) >= Number(m[2]);
  }
  m = /^inbox:(.+)$/.exec(ref);
  if (m) {
    const r = (await getQuery("SELECT read_at FROM inbox WHERE user_id = ? AND ref = ?", [row.user_id, m[1]]).catch(() => []))[0];
    return !!(r && r.read_at);
  }
  return false;
}
/** The sign-in a subscription is bound to: "live" | "dead" | "unknown" (it couldn't be read - the database busy). The
 *  binding is what makes "signing that browser out stops them" true, so unknown is never treated as live: that browser
 *  is skipped this round (and the push retried), never sent to and never dropped. */
async function sessionState(s) {
  try { return (await require("./sessions").isLive(s.session_id, s.user_id)) ? "live" : "dead"; } catch (e) { return "unknown"; }
}
async function dropSub(s, why) {
  await runQuery("DELETE FROM webpush_subs WHERE id = ?", [s.id]);
  STATS.removed[why] = (STATS.removed[why] || 0) + 1;
  await refreshUser(s.user_id);
}
async function subOk(s, t) {
  if (!s.fail_count && !s.last_error && s.last_ok && t - s.last_ok < LAST_OK_EVERY_MS) return;
  await runQuery("UPDATE webpush_subs SET fail_count = 0, last_error = NULL, last_ok = ? WHERE id = ?",
                 [s.last_ok && t - s.last_ok < LAST_OK_EVERY_MS ? s.last_ok : t, s.id]);
}
async function subFail(s, t, code) {
  await runQuery("UPDATE webpush_subs SET fail_count = fail_count + 1, last_fail = ?, last_error = ? WHERE id = ?", [t, String(code).slice(0, 16), s.id]);
}
function noteError(host, status, t) { STATS.lastError = { host, status, at: t }; }

async function deliver(row, cfg, t) {
  const test = row.kind === "test";
  if (!VAPID.ok) return finish(row, "off", t);
  if (!test && (!cfg.webpush_enabled || !cfg["webpush_kind_" + row.kind])) return finish(row, "off", t);
  if (!test && (await isRead(row))) return finish(row, "read", t);
  const acc = await accountOf(row.user_id);
  if (test ? !acc || acc.archived_at : !audienceOk(acc, cfg)) return finish(row, "off", t);
  const subs = row.only_sub
    ? await getQuery("SELECT * FROM webpush_subs WHERE id = ? AND user_id = ?", [row.only_sub, row.user_id])
    : test ? await getQuery("SELECT * FROM webpush_subs WHERE user_id = ?", [row.user_id])
           : await getQuery("SELECT * FROM webpush_subs WHERE user_id = ? AND (',' || kinds || ',') LIKE ?", [row.user_id, `%,${row.kind},%`]);
  const live = [];
  let unknown = 0;
  for (const s of subs) {
    if (s.instance && s.instance !== INSTANCE()) { await dropSub(s, "instance"); continue; }   // another site's (a copied database)
    if (s.vapid_kid !== VAPID.kid) continue;                                  // made with another key: it re-subscribes
    if (Number(s.expiration_time) > 0 && Number(s.expiration_time) < t) { await dropSub(s, "expired"); continue; }
    const ss = await sessionState(s);
    if (ss === "dead") { await dropSub(s, "signed_out"); continue; }
    if (ss === "unknown") { unknown++; continue; }
    live.push(s);
  }
  if (!live.length) return unknown ? reschedule(row, t, []) : finish(row, "nodevice", t);
  if (row.room_id) await require("./padaccess").init().catch(() => {});     // the level decides whether the pad is named
  const res = await Promise.all(live.map((s) => sendOne(row, s, cfg, t)));
  const ok = res.filter((r) => r.r === "ok").length;
  if (ok) return finish(row, "sent", t, ok);
  const retry = res.filter((r) => r.r === "retry");
  if (retry.length) return reschedule(row, t, retry.map((r) => r.until || 0));
  return finish(row, res.every((r) => r.r === "gone") ? "gone" : "failed", t);
}
/** Put a claimed row back in the queue for its next try (30 s, 2 min, 10 min; later of that and any Retry-After), or give up. */
async function reschedule(row, t, untils) {
  const tries = (Number(row.tries) || 0) + 1;
  if (tries > RETRY_STEPS.length || t - Number(row.created) > (TTL[row.kind] || 3600) * 1000) return finish(row, "failed", t, 0, tries);
  const wait = Math.max(RETRY_STEPS[tries - 1], ...untils.map((u) => (u || 0) - t));
  await runQuery("UPDATE webpush_outbox SET tries = ?, due_at = ?, sent_at = NULL, outcome = NULL WHERE id = ? AND outcome = 'sending'", [tries, t + wait, row.id]);
  bump("retry", row.kind);
  return "retry";
}
async function sendOne(row, s, cfg, t) {
  const host = hostOf(s.endpoint), fam = familyOf(host);
  if (!endpointOk(s.endpoint, cfg)) { await subFail(s, t, "host"); return { r: "fail" }; }
  const hb = BACKOFF.get(host);
  if (hb && hb > t) return { r: "retry", until: hb };
  let body, headers;
  try {
    body = C.encrypt(Buffer.from(JSON.stringify(render(row, langFor(row.user_id, s))), "utf8"), s.p256dh, s.auth, { padTo: PAD_TO });
    headers = { TTL: String(TTL[row.kind] || 3600), Urgency: URGENCY[row.kind] || "normal", Topic: topicOf(row.tag, s.auth), "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream", Authorization: C.vapidAuth(s.endpoint, VAPID, t) };
  } catch (e) { await subFail(s, t, "keys"); return { r: "fail" }; }
  let res;
  try {
    res = await slot(() => TRANSPORT(s.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }));
  } catch (e) {
    if (e && e.code === "E_ADDR") {                                                        // the name resolves to no public address
      hostStat(fam, "addr");
      noteError(host, "addr", t);
      await subFail(s, t, "addr");
      logOnce("addr:" + host, 3600e3, `[webpush] ${host} resolves to no public address - refused, not retried`);
      return { r: "fail" };
    }
    const code = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "net";
    hostStat(fam, code);
    noteError(host, code, t);
    await subFail(s, t, code);
    return { r: "retry" };
  }
  const st = Number(res && res.status) || 0;
  hostStat(fam, st);
  if (st >= 200 && st < 300) { await subOk(s, t); return { r: "ok" }; }
  if (st === 404 || st === 410) { await dropSub(s, "gone"); return { r: "gone" }; }        // unsubscribed / expired at the push service
  noteError(host, st, t);
  // 401 / 403: the push service refused OUR side - the VAPID JWT (Apple BadJwtToken / ExpiredJwtToken for a subject, exp or
  // server clock it won't take; WNS and FCM credential errors). Never a reason to delete the browser's row: a row made with
  // another key is skipped above (vapid_kid) and the browser re-subscribes. A 403 is counted, so a row that only ever gets
  // 403 goes with the long-dead sweep (DEAD_FAILS + DEAD_AGE_MS); a 401 isn't.
  if (st === 401 || st === 403) {
    STATS.vapidErrorAt = t;
    STATS.vapidErrorStatus = st;
    if (st === 403) await subFail(s, t, "403");
    logOnce(`vapid:${st}:${host}`, 600e3, `[webpush] ${host} refused our VAPID signature (${st}) - check VAPID_SUBJECT, the key pair and the server clock (docs/webpush.md); the subscription is kept`);
    return { r: "fail" };
  }
  if (st === 429 || st >= 500) {
    const until = retryAfter(res, t);
    if (until) BACKOFF.set(host, until);
    await subFail(s, t, String(st));
    return { r: "retry", until };
  }
  await subFail(s, t, String(st || "?"));                                                  // 400, 413, a redirect (never followed), ...
  logOnce(`st:${host}:${st}`, 600e3, `[webpush] ${host} answered ${st} - not retried`);
  return { r: "fail" };
}

/** Every SWEEP_MS: subscriptions of ended sign-ins, expired or long-dead ones, and old outbox rows. */
async function sweep(t = NOW()) {
  await init();
  const hasSessions = (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"))[0];
  let n = 0;
  if (hasSessions) {             // never without the table: that would read as "every session ended"
    const r = await runQuery(`DELETE FROM webpush_subs WHERE session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = webpush_subs.session_id
                              AND s.user_id = webpush_subs.user_id AND s.revoked_at IS NULL AND s.expires > ?)`, [t]);
    n += (r && r.changes) || 0;
  }
  const e = await runQuery("DELETE FROM webpush_subs WHERE expiration_time IS NOT NULL AND expiration_time > 0 AND expiration_time < ?", [t]);
  const d = await runQuery("DELETE FROM webpush_subs WHERE fail_count >= ? AND COALESCE(last_ok, created) < ?", [DEAD_FAILS, t - DEAD_AGE_MS]);
  const o = await runQuery("DELETE FROM webpush_subs WHERE instance IS NOT NULL AND instance != ?", [INSTANCE()]);     // a copied database
  n += ((e && e.changes) || 0) + ((d && d.changes) || 0) + ((o && o.changes) || 0);
  // claimed and never finished (the process died mid-send, or the finishing write failed): closed, never sent again
  await runQuery("UPDATE webpush_outbox SET outcome = 'failed' WHERE outcome = 'sending' AND sent_at < ?", [t - STUCK_MS]);
  await runQuery("DELETE FROM webpush_outbox WHERE created < ?", [t - OUTBOX_KEEP_MS]);
  if (n) STATS.removed.sweep = (STATS.removed.sweep || 0) + n;
  await loadSubsUsers();
  return n;
}

/** The admin page's Delivery card + the Overview alerts. Plain numbers only (no endpoints, keys or names). */
async function health() {
  await init();
  const t = NOW();
  const cfg = await config();
  const day = {}, totals = {};
  for (const r of await getQuery("SELECT kind, COALESCE(outcome, 'waiting') AS outcome, COUNT(*) AS n FROM webpush_outbox WHERE created > ? GROUP BY kind, outcome", [t - 86400e3])) {
    (day[r.kind] = day[r.kind] || {})[r.outcome] = r.n;
    totals[r.outcome] = (totals[r.outcome] || 0) + r.n;
  }
  const q = (await getQuery("SELECT COUNT(*) AS n, SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due FROM webpush_outbox WHERE sent_at IS NULL", [t]))[0] || {};
  const subs = { total: 0, accounts: 0, stale: 0, kinds: {}, browsers: {} };
  const users = new Set();
  for (const s of await getQuery("SELECT user_id, kinds, ua, vapid_kid FROM webpush_subs")) {
    if (s.vapid_kid !== VAPID.kid) { subs.stale++; continue; }
    subs.total++;
    users.add(s.user_id);
    for (const k of String(s.kinds || "").split(",").filter(Boolean)) subs.kinds[k] = (subs.kinds[k] || 0) + 1;
    const fam = String(s.ua || "Unknown browser").split(" on ")[0];
    subs.browsers[fam] = (subs.browsers[fam] || 0) + 1;
  }
  subs.accounts = users.size;
  return { keys: keyStatus(), enabled: !!cfg.webpush_enabled, audience: cfg.webpush_audience, day, totals,
           queue: { waiting: q.n || 0, due: q.due || 0 }, subs, hosts: STATS.hosts, mem: STATS.outcomes, removed: STATS.removed,
           lastError: STATS.lastError, vapidErrorAt: STATS.vapidErrorAt || null, vapidErrorStatus: STATS.vapidErrorStatus || null, since: STATS.since };
}

/** accountexport.js: this account's browsers - never the endpoint's path or the keys. */
async function exportFor(userId) {
  const has = (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'webpush_subs'"))[0];
  if (!has) return null;
  const rows = await getQuery("SELECT id, endpoint, kinds, ua, locale, created, last_ok FROM webpush_subs WHERE user_id = ? ORDER BY id", [String(userId || "")]);
  return rows.map((r) => ({ id: r.id, push_service: hostOf(r.endpoint), kinds: String(r.kinds || "").split(",").filter(Boolean), browser: r.ua || null,
                            locale: r.locale || null, created: r.created, last_ok: r.last_ok || null }));
}

// ── routes ──
function cleanKinds(v, cfg) {
  const offered = offeredKinds(cfg);
  const list = Array.isArray(v) ? [...new Set(v.map((x) => String(x)))] : [];
  if (!list.length || list.some((k) => !offered.includes(k))) throw new Refuse(400, "Pick at least one kind of notification.", "E_KINDS");
  return KINDS.filter((k) => list.includes(k));
}
function cleanSub(s, cfg) {
  const sub = s && typeof s === "object" ? s : {};
  if (!endpointOk(sub.endpoint, cfg)) throw new Refuse(400, "This browser's push service isn't supported.", "E_ENDPOINT");
  const keys = sub.keys && typeof sub.keys === "object" ? sub.keys : {};
  if (!C.checkKeys(keys.p256dh, keys.auth)) throw new Refuse(400, "This browser sent keys that can't be used.", "E_KEYS");
  const exp = Number(sub.expirationTime);
  return { endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth, exp: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : null };
}
/** One browser = one account at a time: the same endpoint again (any account) replaces the row. */
async function upsert(uid, sub, kinds, req, res, t) {
  const prev = (await getQuery("SELECT user_id FROM webpush_subs WHERE endpoint = ?", [sub.endpoint]))[0];
  let ua = "Unknown browser";
  try { ua = require("./sessions").describe(req.get("user-agent")); } catch (e) { ua = "Unknown browser"; }
  const locale = String((res.locals && res.locals.lang) || req.lang || "en").slice(0, 12);
  await runQuery(`INSERT INTO webpush_subs (endpoint, p256dh, auth, user_id, kinds, session_id, vapid_kid, ua, locale, expiration_time, created, updated, instance)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds,
                  session_id = excluded.session_id, vapid_kid = excluded.vapid_kid, ua = excluded.ua, locale = excluded.locale,
                  expiration_time = excluded.expiration_time, updated = excluded.updated, fail_count = 0, last_error = NULL, instance = excluded.instance,
                  created = CASE WHEN webpush_subs.user_id = excluded.user_id THEN webpush_subs.created ELSE excluded.created END`,
                 [sub.endpoint, sub.p256dh, sub.auth, uid, kinds.join(","), req.loginSession.id, VAPID.kid, ua, locale, sub.exp, t, t, INSTANCE()]);
  // at most SUBS_MAX per account: the one used longest ago goes (never the one just saved)
  const extra = await getQuery(`SELECT id FROM webpush_subs WHERE user_id = ? AND endpoint != ? ORDER BY COALESCE(last_ok, updated) DESC, id DESC LIMIT -1 OFFSET ?`,
                               [uid, sub.endpoint, SUBS_MAX - 1]);
  for (const x of extra) await runQuery("DELETE FROM webpush_subs WHERE id = ?", [x.id]);
  SUBS_USERS.add(uid);
  if (prev && prev.user_id !== uid) await refreshUser(prev.user_id);
}
const othersOf = async (uid, ep) => (await getQuery("SELECT COUNT(*) AS n FROM webpush_subs WHERE user_id = ? AND vapid_kid = ? AND endpoint != ?", [uid, VAPID.kid, ep || ""]))[0].n;

function register(app, { addUser, noTimers = false } = {}) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const userLimit = guard.limiter({ max: 30, windowMs: 60e3 });
  const testLimit = guard.limiter({ max: 3, windowMs: 10 * 60e3 });
  const fail = (res, e) => {
    const st = e && e.refuse ? e.status : 500;
    if (st === 500) console.error("[webpush]", e && e.message);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message, code: (e && e.code) || undefined });
  };
  // needOn: the feature must be offered to this member (switch, keys, audience). Turning notifications OFF never needs it.
  const userGuard = (needOn) => async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!req.loginSession || !req.loginSession.id || String(req.loginSession.userId) !== String(req.user.userId)) {
      return res.status(401).json({ ok: false, error: "Sign in again.", code: "E_SESSION" });
    }
    if (needOn && !(await available(req.user))) return res.status(404).json({ ok: false, code: "E_OFF", error: "Browser notifications are off." });
    const k = String(req.user.userId);
    if (userLimit.blocked(k)) return res.status(429).json({ ok: false, code: "E_RATE", error: "Too many tries - wait a minute." });
    userLimit.hit(k);
    next();
  };
  const userApi = userGuard(true), userOffApi = userGuard(false);
  const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  app.post("/api/push/state", addUser, userApi, async (req, res) => {
    try {
      const uid = String(req.user.userId), cfg = await config(), t = NOW();
      const ep = typeof body(req).endpoint === "string" && body(req).endpoint.length <= ENDPOINT_MAX ? body(req).endpoint : null;
      let mine = null;
      if (ep) {
        let row = (await getQuery("SELECT * FROM webpush_subs WHERE endpoint = ?", [ep]))[0];
        if (row && row.user_id !== uid) {
          // this browser's subscription is saved for another account: the browser changed hands without a sign-out (only the
          // browser holds the endpoint, so this caller is at it). That account's pushes must stop showing here.
          await runQuery("DELETE FROM webpush_subs WHERE id = ?", [row.id]);
          STATS.removed.handover = (STATS.removed.handover || 0) + 1;
          await refreshUser(row.user_id);
          row = null;
        }
        const known = !!row && row.vapid_kid === VAPID.kid
          && (row.session_id === req.loginSession.id || (await sessionState(row)) === "live");
        mine = { known, kinds: known ? String(row.kinds || "").split(",").filter(Boolean) : [] };
        const lang = String((res.locals && res.locals.lang) || req.lang || "en").slice(0, 12);
        if (known && (row.locale !== lang || t - Number(row.updated) >= 3600e3)) {
          await runQuery("UPDATE webpush_subs SET locale = ?, updated = ? WHERE id = ?", [lang, t, row.id]);
        }
      }
      res.json({ ok: true, key: VAPID.publicKey, kid: VAPID.kid, kinds: offeredKinds(cfg), mine, others: await othersOf(uid, ep) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/push/subscribe", addUser, userApi, async (req, res) => {
    try {
      const uid = String(req.user.userId), cfg = await config();
      const sub = cleanSub(body(req).subscription, cfg);
      const kinds = cleanKinds(body(req).kinds, cfg);
      await upsert(uid, sub, kinds, req, res, NOW());
      res.json({ ok: true, kinds, others: await othersOf(uid, sub.endpoint) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/push/unsubscribe", addUser, userOffApi, async (req, res) => {
    try {
      const uid = String(req.user.userId), b = body(req);
      await init();
      let r;
      if (b.all === true) r = await runQuery("DELETE FROM webpush_subs WHERE user_id = ?", [uid]);
      else if (typeof b.endpoint === "string" && b.endpoint) r = await runQuery("DELETE FROM webpush_subs WHERE endpoint = ? AND user_id = ?", [b.endpoint.slice(0, ENDPOINT_MAX + 1), uid]);
      else throw new Refuse(400, "Which browser?", "E_ENDPOINT");
      await refreshUser(uid);
      res.json({ ok: true, removed: (r && r.changes) || 0 });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/push/test", addUser, userApi, async (req, res) => {
    try {
      const uid = String(req.user.userId), ep = body(req).endpoint;
      if (testLimit.blocked(uid)) return res.status(429).json({ ok: false, code: "E_RATE", error: "That's enough tests for now - try again in a few minutes." });
      const row = typeof ep === "string" ? (await getQuery("SELECT id FROM webpush_subs WHERE endpoint = ? AND user_id = ? AND vapid_kid = ?", [ep, uid, VAPID.kid]))[0] : null;
      if (!row) throw new Refuse(404, "Notifications aren't on in this browser.", "E_NODEVICE");
      testLimit.hit(uid);
      res.json({ ok: true, queued: (await queueTest(uid, row.id)) > 0 });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/push/resubscribe", addUser, userApi, async (req, res) => {
    try {
      const uid = String(req.user.userId), b = body(req), cfg = await config();
      const old = typeof b.old_endpoint === "string" ? (await getQuery("SELECT * FROM webpush_subs WHERE endpoint = ? AND user_id = ?", [b.old_endpoint, uid]))[0] : null;
      if (!old) throw new Refuse(404, "Notifications aren't on in this browser.", "E_NODEVICE");
      const sub = cleanSub(b.subscription, cfg);
      const kinds = KINDS.filter((k) => String(old.kinds || "").split(",").includes(k));
      if (sub.endpoint !== old.endpoint) await runQuery("DELETE FROM webpush_subs WHERE id = ?", [old.id]);
      await upsert(uid, sub, kinds.length ? kinds : offeredKinds(cfg), req, res, NOW());
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // GET /sw.js is NOT here: index.js mounts serveWorker before the session / activity middleware (see serveWorker)

  // admins (by the class in the database)
  const adminOf = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return SP.can(u, "push.admin") ? u : null;
  };
  const adminApi = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const a = await adminOf(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    req.admin = a;
    next();
  };
  app.get("/admin/push", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/push"));
    try {
      const a = await adminOf(req);
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      if (!a) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The Web Push settings are for site admins.", title: "Admins only" });
      res.render("admin/push", { user: a.username, isAdmin: true, S: await settingsView(), K: keyStatus(), H: await health(), D: DEFAULTS, L: LIMITS, HOSTS: DEFAULT_HOSTS });
    } catch (e) { console.error("[webpush] admin page:", e.message); res.status(500).send("Something went wrong."); }
  });
  app.post("/api/admin/push/settings", addUser, adminApi, async (req, res) => {
    try { res.json({ ok: true, settings: await saveSettings(body(req).settings || {}, req.admin) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/push/test", addUser, adminApi, async (req, res) => {
    try {
      await init();
      if (!VAPID.ok) throw new Refuse(409, "This server has no VAPID keys yet - see docs/webpush.md.", "E_KEYS");
      const n = await queueTest(String(req.admin.userId));
      if (!n) throw new Refuse(404, "None of your browsers has notifications on yet - turn them on in Messages settings (⚙) first.", "E_NODEVICE");
      res.json({ ok: true, devices: n });
    } catch (e) { fail(res, e); }
  });

  if (!noTimers && !AUTO) {
    AUTO = true;
    const a = setInterval(() => { if (VAPID.ok && !STOPPING) drain().catch((e) => console.error("[webpush] drain:", e.message)); }, TICK_MS);
    const b = setInterval(() => { sweep().catch((e) => console.error("[webpush] sweep:", e.message)); }, SWEEP_MS);
    if (a.unref) a.unref();
    if (b.unref) b.unref();
    // a restart: stop picking rows (in-flight requests finish or time out; what's left goes out after the start)
    try { require("./shutdown").onDrain(() => { STOPPING = true; }); } catch (e) { /* no shutdown hooks */ }
  }
}

/**
 * GET /sw.js - the service worker, at the site root so its scope is the whole site. Served even while the switch is off:
 * an installed worker stays inert without pushes, and a 404 would only make browsers keep their old copy. index.js mounts
 * it BEFORE cookie-parser and the session / activity middleware: browsers fetch it on their own (a soft update after
 * navigations and pushes), and that must not extend the sign-in a subscription is bound to, write a welcome activity day,
 * clear a stale-account notice or run the nav counts. It needs no user.
 */
const SW_FILE = path.join(__dirname, "public", "js", "push-sw.js");
function serveWorker(req, res) {
  res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  res.sendFile(SW_FILE, (e) => { if (e && !res.headersSent) res.status(404).end(); });
}

/** Tests: wait for the hooks' queues. */
async function _idle() { while (chains.size) await Promise.all([...chains.values()]); }
function _reset() {
  CFG = null; ACCOUNTS.clear(); USER_COLS = null; BACKOFF.clear(); LOGGED.clear(); PAD_NAMES.clear(); STOPPING = false;
  STATS.outcomes = {}; STATS.hosts = {}; STATS.removed = {}; STATS.vapidErrorAt = 0; STATS.vapidErrorStatus = null; STATS.lastError = null;
}
/** Tests: load the keys from another environment (init() reads process.env once). */
async function _loadKeys(env) { await init(); return loadKeys(env); }

module.exports = {
  init, register, serveWorker, available, clientConfig, countFor, countAll, onDm, onMention, drain, sweep, health, keyStatus, config, saveSettings,
  settingsView, cleanSettings, cleanHosts, endpointOk, blockedAddr, exportFor, render, queueTest, offeredKinds, KINDS, AUDIENCES, DEFAULTS, LIMITS,
  DEFAULT_HOSTS, SUBS_MAX, TTL, RETRY_STEPS, PAD_TO, STUCK_MS, Refuse, _setClock, _setTransport, _setLookup, _pushRequest: pushRequest, _pinnedLookup: pinnedLookup, _topicOf: topicOf,
  _idle, _reset, _loadKeys, _stats: STATS, _subsUsers: SUBS_USERS,
};
