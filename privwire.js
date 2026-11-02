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

// Review fix (A-compat-4): `spans` = [[on, off | null], ...] - when the switch was on. A NAMED (or Pepe-anonymised v1) line whose
// speaker is later only !bridge hide is masked only when it was said while the switch was ON (spans), not merely after G: after a
// switch-off Pepe is back on v1, whose !bridge hide promise is "left out", and the policy page reads as before - so lines said then
// stay left out. (A state from before spans: the current or last on period only - older periods fail toward "left out".)
// Counters: calls / ok / refused / err are Pepe's calls (token checked); probes = anything else that hit the v2 path (A-compat-9).
const SPANS_MAX = 500;
let clock = () => Date.now();
let STATE = { on: false, at: null, by: null, on_at: null, g_at: null, spans: [] };
const COUNTS = { calls: 0, ok: 0, refused: 0, err: 0, probes: 0, last_at: null };
const COUNT_KEYS = ["calls", "ok", "refused", "err", "probes"];
let ready = null, loaded = false, saveTimer = null;

function clean(s) {
  const o = s && typeof s === "object" ? s : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const on = o.on === true, at = n(o.at), on_at = n(o.on_at), g_at = n(o.g_at);
  let spans;
  if (Array.isArray(o.spans)) {
    spans = o.spans.filter((x) => Array.isArray(x) && n(x[0]) && (x[1] == null || n(x[1]) >= n(x[0]))).map((x) => [n(x[0]), x[1] == null ? null : n(x[1])]);
    // (only the last span may be open, and only while the switch is on)
    spans = spans.map((x, i) => (x[1] == null && (i < spans.length - 1 || !on) ? [x[0], Math.max(x[0], at || x[0])] : x));
  } else if (g_at) {
    spans = on ? [[on_at || g_at, null]] : on_at && at && at >= on_at ? [[on_at, at]] : [];
  } else spans = [];
  if (spans.length > SPANS_MAX) spans = spans.slice(-SPANS_MAX);
  return { on, at, by: typeof o.by === "string" ? o.by.slice(0, 60) : null, on_at, g_at, spans };
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
        if (v && typeof v === "object") for (const k of COUNT_KEYS) COUNTS[k] = Math.max(COUNTS[k], Math.floor(Number(v[k]) || 0));
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
/** Review fix (A-compat-4): was the switch on at `ts` (ms)? false until loaded (fails toward "left out"). */
function wasOnAt(ts) {
  const t = Number(ts);
  if (!loaded || !Number.isFinite(t)) return false;
  for (const [a, b] of STATE.spans) if (t >= a && (b == null || t < b)) return true;
  return false;
}
/** The start of the latest on period (ms) or null - a moment the switch was on (chatloghist probes its masking with it). */
const lastOnAt = () => (loaded && STATE.spans.length ? STATE.spans[STATE.spans.length - 1][0] : null);
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
  const spans = STATE.spans.map((x) => x.slice());
  if (on) spans.push([t, null]);
  else if (spans.length && spans[spans.length - 1][1] == null) spans[spans.length - 1][1] = t;
  const next = clean({ on, at: t, by: user && user.username ? user.username : null, on_at: on ? t : STATE.on_at, g_at: STATE.g_at || (on ? t : null), spans });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('privwire', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  await saveCounts().catch(() => {});
  try { await require("./adminaudit").record(user || { userId: "system" }, "privwire.switch", null, { on, g_at: next.g_at }); } catch (e) { console.error("[privwire] audit:", e.message); }
  try { await require("./rooms").event(null, "privwire.switch", user && user.username ? user.username : null, `privacy wire v2 ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  console.log(`[privwire] privacy wire v2 switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})${on && next.g_at === t ? " - G set now" : ""}`);
  return state();
}

// ── 1.99?? transcripts bar (owner 2026-11-02): a !transcripts off speaker's 🎙 lines as a blacked-out bar ──
// The site always says txbar: 1 while the switch is on (bridge.js syncAnswer); Pepe sends those lines (masked, v2 only) only after
// that, and only a Pepe that does it says txbar_cap: 1 on his syncs. The text that describes the bar (privacy.ejs, /help) shows only
// while BOTH are true - the switch on AND the latest sync came from a Pepe that sends the bar - so neither deploy order makes it say
// something that isn't so: an older Pepe keeps those lines left out and their turns clippable as before, and the text says that.
// Kept in chatlog_meta 'privwire_txcap' {cap, at} (written only when it changes), so a restart doesn't flip the text back meanwhile.
let TXCAP = { cap: false, at: null };
let txcapLoaded = false;
async function loadTxCap() {
  if (txcapLoaded) return;
  await init();
  const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'privwire_txcap'"))[0];
  try { const v = r ? JSON.parse(r.value) : null; if (v && typeof v === "object") TXCAP = { cap: v.cap === true, at: Number(v.at) > 0 ? Number(v.at) : null }; } catch (e) { /* off */ }
  txcapLoaded = true;
}
/** Every sync (v1 or v2): does the Pepe that sent it show !transcripts off 🎙 lines as a bar (txbar_cap: 1)? Writes only on a change. */
function noteTxCap(cap) {
  const want = cap === true;
  loadTxCap().then(async () => {
    if (TXCAP.cap === want) return;
    TXCAP = { cap: want, at: clock() };
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('privwire_txcap', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(TXCAP)]);
    console.log(`[privwire] Pepe ${want ? "sends" : "no longer sends"} !transcripts off 🎙 lines as a bar`);
  }).catch((e) => console.error("[privwire] txcap:", e && e.code ? e.code : "error"));
}
/** Is the transcripts bar live - the switch on AND the latest Pepe sends it? Synchronous; false until loaded (fails toward the old text). */
const txBar = () => isOn() && txcapLoaded && TXCAP.cap === true;

/** For views: {on, g, g_day} - the policy text behind the switch reads it (privacy.ejs locals.privwire; terms.js dates the page by
 *  G, the go-live). null while the switch is off: the policy reads exactly as before. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function privacyCopy() {
  if (!isOn() || !STATE.g_at) return null;
  const d = new Date(STATE.g_at);
  return { on: true, g: STATE.g_at, g_day: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
}

function register(app, { addUser, noTimers = false }) {
  init().catch((e) => console.error("[privwire] init:", e.message));
  loadTxCap().catch((e) => console.error("[privwire] txcap:", e && e.code ? e.code : "error"));   // 1.99?? transcripts bar
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/privwire", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); await loadTxCap(); res.json({ ok: true, state: state(), counts: counts(), txbar: { on: txBar(), cap: TXCAP.cap, at: TXCAP.at } }); }
    catch (e) { console.error("[privwire] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/privwire", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { const st = await setOn(b.on, { userId: req.user.userId, username: req.user.username }); await loadTxCap(); res.json({ ok: true, state: st, counts: counts(), txbar: { on: txBar(), cap: TXCAP.cap, at: TXCAP.at } }); }
    catch (e) { console.error("[privwire] switch:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  if (!noTimers && !saveTimer) {
    saveTimer = setInterval(() => { saveCounts().catch(() => {}); }, 3600e3);
    if (saveTimer.unref) saveTimer.unref();
  }
}

module.exports = { init, isOn, gAt, wasOnAt, lastOnAt, note, counts, state, setOn, saveCounts, privacyCopy, register, _clean: clean,
                   noteTxCap, txBar, loadTxCap,                                    // 1.99?? transcripts bar
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = clean(null); for (const k of COUNT_KEYS) COUNTS[k] = 0; COUNTS.last_at = null; ready = null; loaded = false;
                                   TXCAP = { cap: false, at: null }; txcapLoaded = false; } };
