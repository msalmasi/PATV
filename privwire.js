// privwire.js - wave 2 WP-2 (incognito / mic-stage spec A.3, I.2, I.5; owner answers section M): the "Privacy wire v2" switch.
//
// Pepe sends the website only redacted lines today: an incognito person is a fresh "someone", a !bridge hide person isn't sent at
// all. With privacy wire v2 he sends the FULL form - the real UserRef of a veiled person plus a `priv` block, a hidden speaker's
// words in priv.words, hold ids on mic events - to POST /api/bridge/sync/v2, and the website does the masking itself: frog names
// (frognames.js chat sessions), masked bars for hidden lines, real identities only in side tables (bridge_veil, chat_log_veil,
// bridge_rooms_veil) that only the reveal endpoints read (seethrough.js, logged).
//
// The switch is the opt-in: Pepe moves up only after an /api/bridge/sync answer says `privwire: 2`, which it says only while this
// switch is ON. Off (the default), the site never advertises, so it never receives a real name - not even in a refused request -
// and the v2 route answers 409 privwire_off BEFORE anything else happens (Pepe then sends that batch on v1 and ignores adverts for
// 10 minutes). The route's call counter stays at 0 while the switch has never been on: the staging dark proof (I.2 step 3).
//
// State: chatlog_meta 'privwire' {on, at, by, on_at, g_at} - g_at = G, the go-live time: set at the FIRST switch-on and never
// cleared (lines said before G keep the old rules: pre-G incognito lines stay "someone", pre-G !bridge hide lines stay left out;
// turning the switch off later keeps what was stored since G - policy text needs an owner decision before any such switch-off).
// Counters {calls, ok, refused, err, last_at} in memory, written to chatlog_meta 'privwire_counts' hourly and at each switch.
// Every flip: an admin_audit row (privwire.switch) and a room_events row ("privwire.switch"). Card: /admin/bridge "Privacy wire v2"
// (chatlog.admin), next to the see-through log.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

let clock = () => Date.now();
let STATE = { on: false, at: null, by: null, on_at: null, g_at: null };
const COUNTS = { calls: 0, ok: 0, refused: 0, err: 0, last_at: null };
let ready = null, loaded = false, saveTimer = null;

function clean(s) {
  const o = s && typeof s === "object" ? s : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  return { on: o.on === true, at: n(o.at), by: typeof o.by === "string" ? o.by.slice(0, 60) : null, on_at: n(o.on_at), g_at: n(o.g_at) };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'privwire'"))[0];
      try { STATE = clean(r ? JSON.parse(r.value) : null); } catch (e) { STATE = clean(null); }
      const c = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'privwire_counts'"))[0];
      try {
        const v = c ? JSON.parse(c.value) : null;
        if (v && typeof v === "object") for (const k of ["calls", "ok", "refused", "err"]) COUNTS[k] = Math.max(COUNTS[k], Math.floor(Number(v[k]) || 0));
        if (v && Number(v.last_at) > 0) COUNTS.last_at = COUNTS.last_at || Number(v.last_at);
      } catch (e) { /* counts start at 0 */ }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** Is the switch on? Synchronous; false until the state has loaded (fails closed: no advert, the v2 route refuses). */
const isOn = () => loaded && STATE.on === true;
/** G (ms): the first switch-on, sticky; null = never on (every line keeps the old rules). */
const gAt = () => (loaded ? STATE.g_at : null);
/** The v2 route's counters: note("calls" | "ok" | "refused" | "err"). */
function note(k) {
  if (!(k in COUNTS) || k === "last_at") return;
  COUNTS[k]++;
  COUNTS.last_at = clock();
}
async function saveCounts() {
  await init();
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('privwire_counts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 [JSON.stringify(COUNTS)]);
}
function counts() { return { ...COUNTS }; }
function state() { return { ...STATE, loaded }; }

/** Flip the switch. user = {userId, username}. -> state. The first ON sets G (never moved again). Audited twice. */
async function setOn(want, user) {
  await init();
  const on = want === true;
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = clock();
  const next = clean({ on, at: t, by: user && user.username ? user.username : null, on_at: on ? t : STATE.on_at, g_at: STATE.g_at || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('privwire', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  await saveCounts().catch(() => {});
  try { await require("./adminaudit").record(user || { userId: "system" }, "privwire.switch", null, { on, g_at: next.g_at }); } catch (e) { console.error("[privwire] audit:", e.message); }
  try { await require("./rooms").event(null, "privwire.switch", user && user.username ? user.username : null, `privacy wire v2 ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  console.log(`[privwire] privacy wire v2 switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})${on && next.g_at === t ? " - G set now" : ""}`);
  return state();
}

/** For views: {on, g} - the policy text behind the switch reads it (privacy.ejs locals.privwire). */
function privacyCopy() { return isOn() ? { on: true, g: STATE.g_at } : null; }

function register(app, { addUser, noTimers = false }) {
  init().catch((e) => console.error("[privwire] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/privwire", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state(), counts: counts() }); }
    catch (e) { console.error("[privwire] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/privwire", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }), counts: counts() }); }
    catch (e) { console.error("[privwire] switch:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  if (!noTimers && !saveTimer) {
    saveTimer = setInterval(() => { saveCounts().catch(() => {}); }, 3600e3);
    if (saveTimer.unref) saveTimer.unref();
  }
}

module.exports = { init, isOn, gAt, note, counts, state, setOn, saveCounts, privacyCopy, register,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = clean(null); for (const k of ["calls", "ok", "refused", "err"]) COUNTS[k] = 0; COUNTS.last_at = null; ready = null; loaded = false; } };
