// eventsauth.js — who may listen on the /events bus (R-11, 1.99acf; the chat design §16: "v1's open /events bus is closed").
//
// /events?type=<t>&identifier=<id> was open to anyone who knew (or guessed) an identifier. The channels and their consumers:
//   dm                      the /messages page's own DM stream (messages.sse; it always needed the session) - unchanged
//   spin / public           the OBS WheelSource (public/publicwheel.js, no session)
//   spin / watch            the homepage stage line (home.ejs, anyone)
//   spin / <pageId>         the gold wheel page (public/script.js, signed in; a random page id)
//   spin|results / <spinId> the homepage after a spin (session), the Twitch bot (twitch.js) and the Discord bot (commands/spin.js)
//
// bot_keys_settings.events (/admin/keys#events):
//   observe (default)  exactly today's behaviour, plus counting who listens how (events_auth_log: day, type, channel,
//                      auth = session | key | anon | mismatch).
//   enforce            spinId channels need the spin owner's session or a bot key (in enforce mode the key's scopes must hold
//                      /events - botkeys.js refuses it before this runs); another user's session -> 403, nothing -> 401.
//                      A gold-wheel page channel needs a session and is registered as "<userId>:<pageId>" (the gold spin
//                      sends to both names). public / watch stay open but become read-only and non-identifying: the OBS
//                      request carries no username (the page only needs "Request" + the spinId), the homepage line carries no
//                      spinId. Anything else -> 400.
// Switch to enforce only once the log shows `key` (not `anon`) for both bots' spin / results subscriptions.
//
// An incognito spinner is "someone" on every public spin surface in BOTH modes (watchLook: the homepage stage stream, its
// first paint from /api/g/wheel/last.json, the OBS wheel's acknowledge-spin answer) - {anon: true} with no name or colour;
// the page says "someone" in its own language (js.home.spin.someone). Incognito already hides a member on the public boards.
// The log is bounded: `type` is counted as dm | spin | results | other (anyone can send any ?type=), and at most MAX_KEYS
// distinct rows build up between two flushes.
"use strict";
const { getQuery } = require("./dbUtils");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_RE = /^[a-z0-9]{1,32}$/i;
const SOMEONE = { name: "", display: "", nameCss: "", anon: true };
const TYPES = ["dm", "spin", "results"];
const MAX_KEYS = 1000;                       // distinct (day, type, chan, auth) between two flushes

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const { runQuery } = require("./dbUtils");
      await runQuery(`CREATE TABLE IF NOT EXISTS events_auth_log (day TEXT NOT NULL, type TEXT NOT NULL, chan TEXT NOT NULL, auth TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, type, chan, auth))`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const enforcing = () => require("./botkeys").settings().events === "enforce";

/** The channel kind of (type, identifier): dm | public | watch | page | spin | results | other. */
function chanOf(type, identifier) {
  const id = String(identifier == null ? "" : identifier);
  if (type === "dm") return "dm";
  if (type === "spin" && id === "public") return "public";
  if (type === "spin" && id === "watch") return "watch";
  if (type === "spin" || type === "results") {
    if (UUID_RE.test(id)) return type;
    if (type === "spin" && PAGE_RE.test(id)) return "page";
    if (type === "results" && id) return "results";
  }
  return "other";
}

async function spinOwner(spinId) {
  try { const r = (await getQuery("SELECT userId FROM wheel_spins WHERE spinId = ?", [String(spinId)]))[0]; return r ? String(r.userId) : null; }
  catch (e) { return null; }
}

// ── counting (flushed with the botkeys counters) ──
let counts = new Map();
const typeOf = (type) => (TYPES.includes(type) ? type : "other");
function count(type, chan, auth) {
  const k = [new Date().toISOString().slice(0, 10), typeOf(type), chan, auth].join("\u0001");
  if (!counts.has(k) && counts.size >= MAX_KEYS) return;
  counts.set(k, (counts.get(k) || 0) + 1);
}
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  const bk = require("./botkeys");
  bk.onFlush(async (runQuery, purge) => {
    await init();
    const C = counts;
    counts = new Map();
    for (const [k, n] of C) {
      const [day, type, chan, auth] = k.split("\u0001");
      await runQuery(`INSERT INTO events_auth_log (day, type, chan, auth, n) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(day, type, chan, auth) DO UPDATE SET n = n + excluded.n`, [day, type, chan, auth, n]);
    }
    if (purge) await runQuery("DELETE FROM events_auth_log WHERE day < ?", [new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)]);
  }, () => counts.size > 0);
}

/**
 * May this request listen? -> {ok, chan, auth, register (the channel name to register under), status?, error?, enforce}.
 * Observe mode: always ok (registered as today); auth is still worked out and counted.
 */
async function decide(req, type, identifier) {
  hook();
  const chan = chanOf(type, identifier);
  const key = require("./botkeys").current();
  const sess = req.loginSession && req.loginSession.userId ? String(req.loginSession.userId) : null;
  let auth = key ? "key" : sess ? "session" : "anon";
  if ((chan === "spin" || chan === "results") && !key && sess && (await spinOwner(identifier)) !== sess) auth = "mismatch";
  count(type, chan, auth);
  const id = String(identifier == null ? "" : identifier);
  const enforce = enforcing();
  const out = { ok: true, chan, auth, register: id, enforce };
  if (!enforce) return out;
  switch (chan) {
    case "dm": case "public": case "watch":
      return out;                                                      // dm: messages.sse checks the session itself
    case "page":
      if (key) return out;
      if (!sess) return { ...out, ok: false, status: 401, error: "session" };
      return { ...out, register: sess + ":" + id };
    case "spin": case "results":
      if (auth === "key" || auth === "session") return out;
      return { ...out, ok: false, status: auth === "mismatch" ? 403 : 401, error: auth === "mismatch" ? "forbidden" : "session" };
    default:
      return { ...out, ok: false, status: 400, error: "bad_request" };
  }
}

/** The public channels' message as the bus sends it (enforce: read-only, nothing that identifies anyone). */
function publicView(identifier, msg) {
  if (!enforcing() || !msg || typeof msg !== "object") return msg;
  if (identifier === "public") return { message: "Request", spinId: msg.spinId, timestamp: msg.timestamp };
  if (identifier === "watch") { const { spinId, ...rest } = msg; return rest; }
  return msg;
}

/** Is this account incognito (its linked chat login, or its account key u:<id>)? */
async function isIncognito(userId) {
  try {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
    const login = u && u.camfrogUsername ? String(u.camfrogUsername).trim().toLowerCase() : "u:" + String(userId);
    const st = (await getQuery(`SELECT "on" AS "on" FROM incognito_state WHERE login = ?`, [login]).catch(() => []))[0];
    if (st && st.on) return true;
    return !!(await getQuery("SELECT 1 AS x FROM incognito_anon WHERE login = ?", [login]).catch(() => []))[0];
  } catch (e) { return false; }
}

/** A spinner's look on a public surface (the homepage stage, last.json, the OBS wheel): {anon: true, no name, no colour} for
 *  an incognito spinner - in both /events modes. */
async function watchLook(userId, look) {
  return (await isIncognito(userId)) ? { ...SOMEONE } : look;
}

/** events_auth_log for /admin/keys#events (the last `days` days). */
async function recent(days = 7) {
  try {
    await init();
    return await getQuery("SELECT day, type, chan, auth, n FROM events_auth_log WHERE day >= ? ORDER BY day DESC, type, chan, auth LIMIT 500",
                          [new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10)]);
  } catch (e) { return []; }
}

module.exports = { init, decide, chanOf, publicView, watchLook, isIncognito, recent, enforcing, SOMEONE, TYPES, MAX_KEYS, _counts: () => counts };
