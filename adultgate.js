// adultgate.js — adultgate site: the 18+ pad gate (ONE owner switch, OFF by default) and the account's one-time age
// confirmation. The owner's call (2026-10-19): "Not yet, but add the gate as a toggle for the future if we need it."
//
// WHAT THE SWITCH DOES (ON). A pad its owner (or a site admin) marked 18+ (rooms_registry.adult, the pad-settings
// checkbox - until now only a badge) keeps its page, its own posts and its stage as its access level allows, but its
// LIVE ROOM - everything padaccess.full() guards (chat lines, 🎙 mic transcripts, who's in it and who's on the mic, the
// room topic, room audio, cam snapshots / cam clips / live cams), story pictures and captures, analytics - and every
// copy of it elsewhere (chat quotes, mic clips and captures kept as posts, the homepage widget / now-playing, mic-challenge
// results, the counts on Top Pads and the /p cards, the name on a stage cam slot) needs a viewer who is signed in AND has
// confirmed they're 18 or older. gate() says why not:
//   "signin"   signed out -> a neutral card ("sign in to view this 18+ pad"), never a line, a name or a count
//   "confirm"  signed in, not confirmed -> the same card with "Confirm you're 18 or older" (/confirm-age)
//   "ok"       confirmed; the pad's owner and site staff (feed.see_hidden - the capability that already sees past 18+
//              creator locks) are never stopped
// Sending INTO the room from the site (relay lines, ! commands, voice clips, the Pepe menu, the DJ panel) follows the same
// rule: someone the gate keeps from reading the room doesn't talk into it either.
// Every surface asks padaccess.full() (which includes this) or padaccess.adultGate(); the live-room APIs are behind
// padaccess's /api/rooms/:slug gate (LIVE_API, case-insensitive like Express's routing) AND check the room they resolved
// themselves (refuseJson) - see the adultgate site commit for the full list.
// OFF (the default): gate() answers "ok" for everyone without looking at anything else, so nothing anywhere changes.
//
// Fails CLOSED: until the switch has been read from the database (a slow boot, or a database error), an 18+ pad is treated
// as if the switch were on; a failed load is logged, retried every RETRY_MS and shown on the /pads/admin card.
// Streams that were already open when the gate starts applying to them (the switch flipped on, a pad marked 18+) end:
// onChange() listeners (bridge.js MP3 listeners + the long-poll, roomrtc WebRTC readers, livecam viewers) re-check their
// viewers on every change and every TICK_MS while the switch is on.
//
// THE CONFIRMATION (one per account; works whatever the switch says - CL3's chat history applies the rule always).
// users.age_confirmed_at (ms) + users.age_confirmed_v (the wording's version, AGE_VERSION) - written once by POST
// /api/age/confirm from the /confirm-age page (signed in; same-site fetch with X-Requested-With: fetch + JSON - the site's
// CSRF rule for account writes; the box ticked), kept as the first time (confirming again changes nothing).
// Confirmations an account already gave elsewhere COUNT for the gate: PATV Creators' "I'm 18 or older" (creators.js
// age_attest), a creator's 18+ attestation (creators.r18_attest, and creator_pads.r18_attest given by the pad's owner) and
// the voice-clone consent's 18+ box (voiceclone.js voice_consents.attested_18). The sign-up statement doesn't. It does NOT
// work the other way round: PATV Creators keeps its own versioned confirmation (creators.attested) for R-rated creator posts.
//
// FOR OTHER FEATURES (CL3 chat history, ...): padaccess.adultGate(viewer, padId, {always: true}) applies the rule whatever
// the switch says (-> "ok" | "signin" | "confirm"); confirmed(userId) (async, any mechanism - a drop-in for
// creators.attested in an age check) / confirmedSync(userId) read the flag; confirmUrl(next) is where to send a "confirm"
// viewer; refusal(state, next, req.t) is the JSON body the gate answers (statusOf(state) its status).
//
// Data
//   users.age_confirmed_at  INTEGER (ms) | NULL, users.age_confirmed_v TEXT | NULL. Merge: the earliest of the two accounts'
//                           (with its version; accountMerge.carryUserFields + the Camfrog-link merge). Delete: cleared with the
//                           tombstone (accountdelete). Export: account.age_confirmation.
//   adult_gate_cfg          key PK ('enabled'), value '1' | '0', updated (ms), by (username - pseudonymised on account
//                           deletion, accountdelete NAME_COLUMNS). Written in one dbUtils.tx with its admin_audit row
//                           (action "adult-gate", {from, to}).
// Everything the gate reads is in memory (the switch + the confirmed accounts, loaded at init and kept current by every
// write here, creators.attestAge / apply / setPadFlags and voiceclone), so pages call it per row without a query.
//
// Admin: /pads/admin#adult. Anyone with the page (pads.registry_admin) sees the state and its log; only an OWNER changes
// it - Admin + Pepe role "owner" on the linked chat login (staffroles.ownerHolds(me, "pads.config"), the 2026-10-16 rule
// for policy switches) - by a same-origin fetch (X-Requested-With: fetch + Origin / Referer of this host).
//
//   GET  /confirm-age?next=<path>    the interstitial (signed out -> /login?next=...; already confirmed -> next)
//   POST /api/age/confirm {yes}      -> {ok, at, already}
//   GET  /api/admin/adultgate        the card's state (pads.registry_admin)
//   POST /api/admin/adultgate {enabled, reason}   owner only
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const STATES = Object.freeze(["ok", "signin", "confirm"]);
const OWNER_CAP = "pads.config";            // ownerHolds(me, OWNER_CAP): Admin class + Pepe role owner
const VIEW_CAP = "pads.registry_admin";      // /pads/admin
const STAFF_CAP = "feed.see_hidden";         // staff see past 18+ (creators.js uses the same capability)
const AUDIT = "adult-gate";
const CONFIRM_PATH = "/confirm-age";
const AGE_VERSION = "2026-10-19";            // the /confirm-age wording (locales age.p / age.p2 / age.ck) - stored with each confirmation
const RETRY_MS = 30 * 1000;                  // a failed load is retried this often (and on the next read after it)
const TICK_MS = 15 * 1000;                   // while the switch is on, open streams are re-checked this often
// padaccess's /api/rooms/:slug gate: the live-room APIs (their path under the pad), matched without regard to case (Express
// routes them that way). Reading the room (live, audio, cams, mic clips, quotes of its lines, the DJ panel, mic-challenge
// results), the Pepe menu (its replies describe cams / people in the room) and sending into it (relay lines + ! commands,
// voice clips).
const LIVE_API = /^\/(?:live|audio\/rtc|snap|camclip|micclip|livecam|quote|pepe|dj|say|clip|challenges)(?:\/|$)/i;

let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; this.refuse = true; } }

// ── state (memory) ──
let ENABLED = false;
let META = { updated: null, by: null };
let CONFIRMED = new Set();     // user ids confirmed by any mechanism
let loaded = false;
let ready = null;
let lastError = null;          // {at, message} of the last failed load (null once one succeeds)
let retryT = null, lastKick = 0;
let attempted = false;         // init() has been asked for (register() does at boot): from then on, not loaded = unknown = closed

const tableExists = async (t) => (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const colsOf = async (t) => new Set((await getQuery(`PRAGMA table_info(${t})`)).map((c) => c.name));
/** The switch's state isn't known (yet): the load is pending or failed. The gate then acts as if it were ON. */
const unknown = () => attempted && !loaded;

function init() {
  attempted = true;
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS adult_gate_cfg (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, by TEXT)");
      const cols = await colsOf("users");
      for (const [c, def] of [["age_confirmed_at", "INTEGER"], ["age_confirmed_v", "TEXT"]]) {
        if (cols.size && !cols.has(c)) {
          try { await runQuery(`ALTER TABLE users ADD COLUMN ${c} ${def}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
        }
      }
      // which pads are 18+ comes from the pad registry's cache - warm it first (a load that finds no pads can't fail open)
      try { await require("./rooms").init(); } catch (e) { /* the registry reports its own trouble */ }
      await load();
    })().catch((e) => {
      ready = null;
      const msg = String((e && e.message) || e).slice(0, 200);
      const quiet = lastError && lastError.message === msg && now() - lastError.logged < 10 * 60e3;
      lastError = { at: now(), message: msg, logged: quiet ? lastError.logged : now() };
      if (!quiet) console.error(`[adultgate] couldn't load the 18+ gate (${msg}) - 18+ pads stay gated until it loads; retrying every ${RETRY_MS / 1000}s`);
      if (!retryT) {
        retryT = setTimeout(() => { retryT = null; init().catch(() => {}); }, RETRY_MS);
        if (retryT.unref) retryT.unref();
      }
      throw e;
    });
  }
  return ready;
}
/** A read before the first successful load: start (or retry) it, at most once a second. */
function kick() {
  const t = now();
  if (!attempted || ready || t - lastKick < 1000) return;
  lastKick = t;
  init().catch(() => {});
}

/** (Re)load the switch and every confirmed account from the database. accountMerge / accountdelete call it after a change. */
async function load() {
  const S = new Set();
  const add = (rows, k) => { for (const r of rows || []) if (r && r[k] != null && r[k] !== "") S.add(String(r[k])); };
  if ((await colsOf("users")).has("age_confirmed_at")) add(await getQuery("SELECT userId FROM users WHERE age_confirmed_at IS NOT NULL"), "userId");
  if (await tableExists("age_attest")) add(await getQuery("SELECT user_id FROM age_attest"), "user_id");
  if (await tableExists("voice_consents") && (await colsOf("voice_consents")).has("attested_18")) {
    add(await getQuery("SELECT DISTINCT user_id FROM voice_consents WHERE attested_18 = 1"), "user_id");
  }
  // a creator's 18+ attestation (its "adult" box): their profile's, and a pad's given by that pad's owner
  if (await tableExists("creators")) add(await getQuery("SELECT user_id FROM creators WHERE r18_attest IS NOT NULL AND r18_attest != ''"), "user_id");
  if (await tableExists("creator_pads") && await tableExists("rooms_registry")) {
    add(await getQuery(`SELECT r.owner_user_id AS uid FROM creator_pads cp JOIN rooms_registry r ON r.room_id = cp.room_id
                        JOIN users u ON u.userId = r.owner_user_id
                        WHERE cp.r18_attest IS NOT NULL AND cp.r18_attest != '' AND lower(u.username) = lower(cp.set_by)`).catch(() => []), "uid");
  }
  const cfg = (await getQuery("SELECT value, updated, by FROM adult_gate_cfg WHERE key = 'enabled'"))[0];
  const was = ENABLED;
  ENABLED = !!cfg && cfg.value === "1";
  META = { updated: cfg ? Number(cfg.updated) || null : null, by: cfg ? cfg.by || null : null };
  CONFIRMED = S;
  const first = !loaded;
  loaded = true;
  lastError = null;
  if (first || was !== ENABLED) bump(first ? "load" : "switch");
}

// ── reads (synchronous, off memory) ──
const enabled = () => ENABLED;
/** The pad is marked 18+ (rooms.js registry cache; false for an unregistered id). */
function isAdultPad(roomId) {
  try { const r = require("./rooms").getCached(String(roomId || "")); return !!(r && r.adult); } catch (e) { return false; }
}
function ownerOf(roomId) {
  try { const r = require("./rooms").getCached(String(roomId || "")); return r && r.owner && r.owner.userId ? String(r.owner.userId) : null; } catch (e) { return null; }
}
/** Could the gate stop anyone on this pad right now? (the switch on - or not read yet: fail closed - and the pad 18+) */
function applies(roomId) {
  if (unknown()) kick();
  return (ENABLED || unknown()) && isAdultPad(roomId);
}
/** Confirmed by any mechanism (memory). */
const confirmedSync = (userId) => !!userId && CONFIRMED.has(String(userId));
/** Never stopped: site staff (feed.see_hidden) and the pad's owner. */
function exempt(viewer, roomId) {
  if (!viewer || !viewer.userId) return false;
  if (SP.can(viewer, STAFF_CAP)) return true;
  const own = ownerOf(roomId);
  return !!own && own === String(viewer.userId);
}
/**
 * May `viewer` (null = signed out) see this pad's live content as far as the 18+ rule goes?
 * -> "ok" | "signin" | "confirm". With the switch OFF: "ok" (unless opts.always). Before the switch has been read: as if ON.
 * Only the 18+ rule: the pad's access level (padaccess.full) is checked separately.
 */
function gate(viewer, roomId, opts) {
  if (unknown()) kick();
  if (!(opts && opts.always) && !ENABLED && !unknown()) return "ok";
  if (!isAdultPad(roomId)) return "ok";
  if (!viewer || !viewer.userId) return "signin";
  if (confirmedSync(viewer.userId) || exempt(viewer, roomId)) return "ok";
  return "confirm";
}
/** The 18+ pads `viewer` is stopped at right now ([] while the switch is off): the feed leaves their live-room posts out. */
function gatedRooms(viewer) {
  if (!ENABLED && !unknown()) return [];
  let list = [];
  try { list = require("./rooms").listCached().filter((r) => r && r.adult); } catch (e) { list = []; }
  return list.map((r) => r.id).filter((id) => gate(viewer || null, id) !== "ok");
}
/** Confirmed by any mechanism - read from the database (for code that may run before init or in another process). */
async function confirmed(userId) {
  if (!userId) return false;
  try { await init(); } catch (e) { /* the switch couldn't be read - the account's rows below still can */ }
  if (confirmedSync(userId)) return true;
  const uid = String(userId);
  const r = (await getQuery("SELECT age_confirmed_at AS at FROM users WHERE userId = ?", [uid]).catch(() => []))[0];
  if (r && r.at) return true;
  if (await tableExists("age_attest") && (await getQuery("SELECT 1 AS x FROM age_attest WHERE user_id = ?", [uid])).length) return true;
  if (await tableExists("voice_consents") && (await colsOf("voice_consents")).has("attested_18")
      && (await getQuery("SELECT 1 AS x FROM voice_consents WHERE user_id = ? AND attested_18 = 1 LIMIT 1", [uid])).length) return true;
  if (await tableExists("creators") && (await getQuery("SELECT 1 AS x FROM creators WHERE user_id = ? AND r18_attest IS NOT NULL AND r18_attest != ''", [uid])).length) return true;
  return false;
}
/** The account's own confirmation on /confirm-age: {at (ms), v} or null. */
async function confirmedAt(userId) {
  if (!userId) return null;
  try { await init(); } catch (e) { /* as confirmed() */ }
  const r = (await getQuery("SELECT age_confirmed_at AS at, age_confirmed_v AS v FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0];
  return r && r.at ? { at: Number(r.at), v: r.v || null } : null;
}

/** The interstitial's address for a return path (only local paths survive - authGuard.safeNext). */
function confirmUrl(next) {
  const n = require("./middleware/authGuard").safeNext(next);
  return CONFIRM_PATH + (n ? "?next=" + encodeURIComponent(n) : "");
}
function signinUrl(next) {
  const n = require("./middleware/authGuard").safeNext(next);
  return "/login" + (n ? "?next=" + encodeURIComponent(n) : "");
}
// the copy lives in locales/en.json (+ its translations); `t` = req.t when a request is at hand, else the English
let EN_JSON = null;
function en(key) {
  if (!EN_JSON) { try { EN_JSON = require("./locales/en.json"); } catch (e) { EN_JSON = {}; } }
  return typeof EN_JSON[key] === "string" ? EN_JSON[key] : key;
}
function txt(t, key) {
  if (typeof t === "function") { try { const s = t(key); if (s && s !== key) return s; } catch (e) { /* English below */ } }
  return en(key);
}
/** The JSON a gated API answers (status: statusOf - 401 signin / 403 confirm). No line, name or count. t = req.t (optional). */
function refusal(state, next, t) {
  const signin = state === "signin";
  return { ok: false, adult: true, gate: signin ? "signin" : "confirm", locked: "adult",
           error: txt(t, signin ? "adultgate.api_signin" : "adultgate.api_confirm"),
           ...(signin ? { signin: signinUrl(confirmUrl(next)) } : { confirm: confirmUrl(next) }) };
}
const statusOf = (state) => (state === "signin" ? 401 : 403);
/** The pad's own address (for `next`). */
function padPath(roomId, slug) {
  if (slug) return "/p/" + encodeURIComponent(String(slug));
  try { const R = require("./rooms").getCached(String(roomId || "")); if (R) return "/p/" + encodeURIComponent(require("./pads").padSlug(R)); } catch (e) { /* below */ }
  return "/p";
}
/**
 * For a route that resolved its room itself: when the gate stops req.user there, answer the refusal (JSON, 401 / 403,
 * no-store) and return true; else false (and nothing is sent). Fails closed like gate().
 */
function refuseJson(req, res, roomId, slug) {
  const viewer = req && req.user && req.user.userId ? req.user : null;
  const g = gate(viewer, roomId);
  if (g === "ok") return false;
  res.set("Cache-Control", "no-store");
  res.status(statusOf(g)).json(refusal(g, padPath(roomId, slug), req && req.t));
  return true;
}

// ── changes: open streams re-check their viewers ──
const listeners = new Set();
/** fn(why) runs on every change that can stop someone ("switch" | "pad" | "load" | "tick"); errors are its own. */
function onChange(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); }
function bump(why = "change") {
  for (const fn of listeners) {
    try { const p = fn(why); if (p && typeof p.catch === "function") p.catch((e) => console.error("[adultgate] re-check:", e.message)); }
    catch (e) { console.error("[adultgate] re-check:", e.message); }
  }
}
let tickT = null;
function startTick() {
  if (tickT) return;
  tickT = setInterval(() => { if (ENABLED || unknown()) bump("tick"); }, TICK_MS);
  if (tickT.unref) tickT.unref();
}

// ── writes ──
/** Someone confirmed through another feature (creators.attestAge / apply / setPadFlags, voiceclone): the gate knows at once. */
function note(userId) { if (userId) CONFIRMED.add(String(userId)); }
/** An account went away (accountdelete): it no longer counts. */
function drop(userId) { if (userId) CONFIRMED.delete(String(userId)); }

/** The signed-in user confirms they're 18 or older. Idempotent: the first time is kept. -> {ok, at, already} */
async function confirm(user, yes) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, en("age.err_signin"), "signin");
  if (!(yes === true || yes === 1 || yes === "1" || yes === "on" || yes === "true")) throw new Refuse(400, en("age.err_tick"), "tick");
  const uid = String(user.userId);
  const t = now();
  const out = await tx(async () => {
    const r = (await getQuery("SELECT userId, age_confirmed_at AS at FROM users WHERE userId = ?", [uid]))[0];
    if (!r) throw new Refuse(401, en("age.err_signin"), "signin");
    if (r.at) return { at: Number(r.at), already: true };
    await runQuery("UPDATE users SET age_confirmed_at = ?, age_confirmed_v = ? WHERE userId = ? AND age_confirmed_at IS NULL", [t, AGE_VERSION, uid]);
    return { at: t, already: false };
  });
  CONFIRMED.add(uid);
  return { ok: true, ...out };
}

/** The owner switch. actor = {userId, username}. Writes the row + its admin_audit row in one transaction. -> view */
async function setEnabled(on, actor, reason) {
  await init();
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in first.");
  if (typeof on !== "boolean") throw new Refuse(400, "Say on or off (enabled: true | false).");
  const AA = require("./adminaudit");
  await AA.init();                         // its CREATE TABLE never runs inside the transaction below
  const from = ENABLED;
  if (from === on) return adminView(actor);
  const t = now();
  const why = reason == null ? null : String(reason).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) || null;
  await tx(async () => {
    await runQuery(`INSERT INTO adult_gate_cfg (key, value, updated, by) VALUES ('enabled', ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by`,
                   [on ? "1" : "0", t, String(actor.username || actor.userId).slice(0, 80)]);
    await AA.record({ userId: actor.userId, username: actor.username || null }, AUDIT, null, { from, to: on }, why);
  });
  ENABLED = on;
  META = { updated: t, by: String(actor.username || actor.userId).slice(0, 80) };
  bump("switch");                          // streams already open on an 18+ pad re-check their viewers now
  return adminView(actor);
}

// ── admin ──
async function meOf(user) {
  if (!user || !user.userId) return null;
  return (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(user.userId)]).catch(() => []))[0] || null;
}
async function canEdit(user) {
  try { return await require("./staffroles").ownerHolds(await meOf(user), OWNER_CAP); } catch (e) { return false; }
}
/** The /pads/admin card: the switch, who changed it last, whether `user` may change it, the change log, counts, load trouble. */
async function adminView(user) {
  try { await init(); } catch (e) { /* shown as load_error below; the card still renders */ }
  let log = [];
  try { log = await require("./adminaudit").recent(AUDIT, 10); } catch (e) { log = []; }
  let pads = 0;
  try { pads = require("./rooms").listCached().filter((r) => r && r.adult).length; } catch (e) { pads = 0; }
  return { enabled: ENABLED, loaded, load_error: lastError ? { at: lastError.at, message: lastError.message } : null, updated: META.updated, by: META.by, can_edit: loaded && (await canEdit(user)),
           adult_pads: pads, confirmed: CONFIRMED.size, version: AGE_VERSION,
           log: log.map((r) => ({ at: r.at, admin: r.admin, to: !!(r.detail && r.detail.to), reason: r.reason || null })) };
}

// ── routes ──
function register(app, { addUser }) {
  init().catch(() => {});
  startTick();
  const guard = require("./middleware/authGuard");
  const strictOrigin = (req) => {
    const src = req.get("origin") || req.get("referer"), host = req.get("host");
    if (!src || !host) return false;
    try { return new URL(src).host.replace(/^www\./i, "").toLowerCase() === String(host).replace(/^www\./i, "").toLowerCase(); } catch (e) { return false; }
  };
  const fail = (res, e, t) => {
    if (e && e.refuse) {
      const key = e.code === "tick" ? "age.err_tick" : e.code === "signin" ? "age.err_signin" : null;
      return res.status(e.status || 400).json({ ok: false, code: e.code || null, error: key ? txt(t, key) : e.message });
    }
    console.error("[adultgate]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };

  // the interstitial
  app.get(CONFIRM_PATH, addUser, async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    const next = guard.safeNext(req.query.next) || "/";
    if (!req.user || !req.user.userId) return res.redirect(302, signinUrl(confirmUrl(next)));
    try {
      await init();
      const mine = await confirmedAt(req.user.userId);
      const done = !!(mine || confirmedSync(req.user.userId));
      if (done && req.query.stay !== "1") return res.redirect(302, next);
      res.locals.og = { title: txt(req.t, "age.title") + " — Public Access TV", description: txt(req.t, "age.og_desc"),
                        image: (res.locals.ogBase || "") + "/og/page.png?t=" + encodeURIComponent("18+"), url: (res.locals.ogBase || "") + CONFIRM_PATH };
      res.render("ageConfirm", { user: req.user.username, next, at: mine ? mine.at : null, done });
    } catch (e) {
      console.error("[adultgate] page:", e);
      res.status(500).send("Something went wrong.");
    }
  });
  app.post("/api/age/confirm", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, code: "cross_site", error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "signin", error: txt(req.t, "age.err_signin") });
    try { res.json(await confirm(req.user, (req.body || {}).yes)); } catch (e) { fail(res, e, req.t); }
  });

  // the owner switch (/pads/admin#adult)
  app.get("/api/admin/adultgate", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!SP.can(req.user, VIEW_CAP)) return res.status(403).json({ ok: false, error: "Pads admins only." });
    try { res.json({ ok: true, ...(await adminView(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/adultgate", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !strictOrigin(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!(await canEdit(req.user))) return res.status(403).json({ ok: false, code: "owner_only", error: "Only an owner can change the 18+ gate." });
    try {
      const me = await meOf(req.user);
      const b = req.body || {};
      res.json({ ok: true, ...(await setEnabled(b.enabled, { userId: me.userId, username: me.username }, b.reason)) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, load, register, gate, enabled, applies, isAdultPad, exempt, gatedRooms, confirmed, confirmedSync, confirmedAt, confirm, note, drop, setEnabled,
  adminView, canEdit, confirmUrl, signinUrl, refusal, refuseJson, statusOf, padPath, txt, onChange, bump, Refuse, STATES, LIVE_API, CONFIRM_PATH,
  AUDIT, OWNER_CAP, STAFF_CAP, AGE_VERSION, TICK_MS, RETRY_MS,
  isReady: () => loaded, unknown,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  // tests: the switch couldn't be read (a load that keeps failing - no retry until _reset); _reset + init() load it again
  _fail: (message) => { attempted = true; loaded = false; lastError = { at: now(), message }; ready = Promise.reject(new Error(message)); ready.catch(() => {}); },
  _reset: () => { ready = null; loaded = false; lastError = null; ENABLED = false; META = { updated: null, by: null }; CONFIRMED = new Set(); },
};
