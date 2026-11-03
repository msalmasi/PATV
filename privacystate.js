// privacystate.js — 1.99?? (privacy controls S6): the privacy switchboard v3 on the website - Settings → Privacy "On the website"
// (G:/ops/privacy-controls-spec-2026-11-02.md section 4.3 + section 5 "S6"; the owner's answers, section 8 - Q20: a control turns OFF
// from a room line too, Pepe's side).
//
// THE CARD. One card at the top of /settings/privacy: a master switch "Show me on the website (bridge)" (off = `!bridge hide`) over one
// switch per website control - Name (incognito, incognito.js's own request), Mic transcripts (`!transcripts off`, here), Cam (live cam
// off, livecam.js's own switch). While the master is off the sub-switches show ON and greyed: "on because the bridge is off - your own
// setting comes back when you turn it back on" (bridge off is an override: it never changes the stored switches - privacyeff.js).
// Chat lines and Voice wait for their builds (S8 / S9). Pepe owns bridge and transcripts, so a change is a REQUEST:
//
//   POST /api/privacy/state {kind: "bridge"|"tx", on}   on = the privacy switch ON (bridge: hidden; tx: transcripts off). Needs the
//                                          member's linked Camfrog login. Queued as Pepe's website action "privacy.bridge" [hide|show] /
//                                          "privacy.tx" [off|on] (actions.js) - he runs the same state change as the PM command
//                                          (pepe_privstate._pv3_web). Audit row "request"; at most RATE_MAX per RATE_WINDOW_MS (429).
//   GET  /api/privacy/state                the card's state AS PEPE LAST REPORTED IT, + `waiting` per kind until a report newer than the
//                                          request arrives ("Waiting for Pepe…") + incognito / live cam as their own modules keep them
//   Pepe's report rides the incognito report loop: POST /api/privacy/incognito/sync {items: [..., {login, kind: "bridge"|"tx", on,
//   via: chat|web|ident, changed, ts}], full_bridge?: [...], full_tx?: [...]} - incognito.js hands the body here (sync). Only LINKED
//   logins are stored; each reported change files an audit row "applied" and, when it really changed, ONE inbox notice (kind
//   "system", ref pv3:<kind>:<login>:<ts>). The full lists heal the table. Pepe never reports what a room line he couldn't prove did
//   under a display name (spec 4.1) - only proven logins, and only while he applies v3.
//
// THE SWITCH (dark): chatlog_meta 'privacy_v3' {on, at, by, first_on} - /admin/bridge#privacyv3 (chatlog.admin), audited (admin_audit
// privacyv3.switch + a room_events row). ON needs privacy wire v2 (the card's words are v2's: a frog name, the blacked-out bar). While
// it's on the sync answer says `privstate: 1` (advert()); Pepe then answers !privacy, lets an unproven room line switch a control on
// AND off for the name it showed, takes privacy.bridge / privacy.tx and reports bridge / tx - and says `privstate: 1` on his own sync
// (noteBot). effective() = the advert AND Pepe's word within BOT_FRESH_MS. Off, or an older Pepe: the routes answer 404, the card and
// the /help card don't show, his reports of these kinds are ignored, and every page is as before.
//
//   privacy_state       login (lower), kind (bridge | tx), on, updated (Pepe's ms of the change), reported, via - PK (login, kind)
//   privacy_state_log   id, user_id, login, kind, at, ev request|applied|refused, on, via, ip
//   privacy_state_meta  key/value: last_full_<kind>, full_n_<kind>
// Account deletion removes the account's rows (accountdelete.js), the data download carries them (accountexport.js), a merge moves the
// audit (accountMerge.js; the state is keyed by the chat login).
"use strict";
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const KINDS = Object.freeze(["bridge", "tx"]);
const ACTION = Object.freeze({ bridge: "privacy.bridge", tx: "privacy.tx" });
const ARGS = Object.freeze({ bridge: ["show", "hide"], tx: ["on", "off"] });        // [privacy switch off, on]
const BOT_FRESH_MS = 2 * 60 * 1000;
const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const WAIT_MS = 15 * 60 * 1000;          // = actionttl.js: privacy.bridge / privacy.tx expire after 15 minutes
const FAILED_MS = 15 * 60 * 1000;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const VIAS = new Set(["web", "chat", "ident", "full"]);
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();

let clock = () => Date.now();
const now = () => clock();
let STATE = { on: false, at: null, by: null, first_on: null };
let ready = null, loaded = false;
let BOT_AT = 0;

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

// ── the switch ──
function cleanState(o) {
  const v = o && typeof o === "object" ? o : {};
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { on: v.on === true, at: n(v.at), by: typeof v.by === "string" ? v.by.slice(0, 60) : null, first_on: n(v.first_on) };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS privacy_state (login TEXT NOT NULL, kind TEXT NOT NULL, "on" INTEGER NOT NULL DEFAULT 0,
        updated INTEGER, reported INTEGER, via TEXT, PRIMARY KEY (login, kind))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS privacy_state_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, kind TEXT,
        at INTEGER NOT NULL, ev TEXT NOT NULL, "on" INTEGER, via TEXT, ip TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS privacy_state_log_user ON privacy_state_log (user_id, at)");
      await runQuery("CREATE TABLE IF NOT EXISTS privacy_state_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'privacy_v3'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** The switch itself (false until loaded: fails closed). */
const isOn = () => loaded && STATE.on === true;
const everOn = () => loaded && STATE.first_on != null;
const pwOn = () => { try { return require("./privwire").isOn() === true; } catch (e) { return false; } };
/** Does the sync answer say privstate: 1? The switch AND privacy wire v2. */
const advert = () => isOn() && pwOn();
/** Pepe's sync body (v1 or v2): privstate: 1 = he runs the switchboard v3 now. Anything else: he doesn't. */
function noteBot(body, t = now()) { BOT_AT = body && typeof body === "object" && body.privstate === 1 ? t : 0; }
const botOn = (t = now()) => BOT_AT > 0 && t - BOT_AT <= BOT_FRESH_MS;
/** Does the card work now? The advert AND Pepe's word. Synchronous; fails closed. */
const effective = (t = now()) => advert() && botOn(t);
function state() { return { ...STATE, loaded, advert: advert(), pepe: botOn(), effective: effective(), privwire: pwOn() }; }
async function setOn(want, user) {
  await init();
  const on = want === true;
  if (on && !pwOn()) throw new Refuse(409, "Turn privacy wire v2 on first - the card's words are its words (frog names, the blacked-out bar).", "privwire_off");
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = now();
  const next = cleanState({ on, at: t, by: user && user.username ? user.username : null, first_on: STATE.first_on || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('privacy_v3', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "privacyv3.switch", null, { on }); } catch (e) { console.error("[privacystate] audit:", e.message); }
  try { await require("./rooms").event(null, "privacyv3.switch", user && user.username ? user.username : null, `privacy switchboard v3 ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  console.log(`[privacystate] privacy switchboard v3 switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}

async function meta(key) {
  const r = (await getQuery("SELECT value FROM privacy_state_meta WHERE key = ?", [key]))[0];
  return r ? r.value : null;
}
const setMeta = (key, value) => runQuery("INSERT INTO privacy_state_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                         [key, String(value)]);
async function log(e) {
  try {
    await runQuery(`INSERT INTO privacy_state_log (user_id, login, kind, at, ev, "on", via, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.userId ? String(e.userId) : null, e.login ? String(e.login).slice(0, 64) : null, e.kind || null, e.at || now(), e.ev,
       e.on == null ? null : e.on ? 1 : 0, e.via ? String(e.via).slice(0, 12) : null, e.ip ? String(e.ip).slice(0, 64) : null]);
  } catch (err) { console.error("[privacystate] log:", err.message); }
}

// ── who ──
/** The account's linked Camfrog login (lower) or null. These switches are about the chat identity in Camfrog rooms. */
async function loginOf(userId) {
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const l = r ? low(r.camfrogUsername) : "";
  return l && LOGIN_RE.test(l) ? l : null;
}

// ── the state ──
async function kindState(userId, login, kind, fb) {
  const out = { on: null, updated: null, reported: null, waiting: null, failed: null, from: null };
  const r = (await getQuery(`SELECT "on" AS "on", updated, reported FROM privacy_state WHERE login = ? AND kind = ?`, [login, kind]))[0];
  if (r) { out.on = !!r.on; out.updated = Number(r.updated) || null; out.reported = Number(r.reported) || null; out.from = "pepe"; }
  else if (Number(await meta("last_full_" + kind)) > 0) { out.on = false; out.reported = Number(await meta("last_full_" + kind)); out.from = "full"; }
  else if (fb != null) { out.on = !!fb; out.from = "site"; }         // what the site's own hidden sets say until Pepe reports
  let a = null;
  try {
    a = (await getQuery(`SELECT id, args, status, message, created, updated FROM pepe_actions WHERE user_id = ? AND kind = ?
                         ORDER BY id DESC LIMIT 1`, [String(userId), ACTION[kind]]))[0] || null;
  } catch (e) { a = null; }
  if (a) {
    let want = null;
    try { want = JSON.parse(a.args)[0] === ARGS[kind][1]; } catch (e) { want = null; }
    const answered = out.updated && out.updated >= Number(a.created);
    if (a.status === "failed" || a.status === "expired") {
      if (Date.now() - Number(a.updated || a.created) < FAILED_MS) out.failed = { message: a.message || "" };
    } else if (!answered && Date.now() - Number(a.created) < WAIT_MS) {    // pepe_actions rows carry real time
      out.waiting = { id: a.id, want, status: a.status };
    }
  }
  return out;
}
/** The card's state. {effective, linked, login, bridge, tx, incognito: {on, waiting}, livecam: {off}, log} */
async function stateOf(userId) {
  await init();
  const out = { effective: effective(), linked: false, login: null, bridge: null, tx: null, incognito: null, livecam: null, log: [] };
  const login = await loginOf(userId);
  out.linked = !!login;
  out.login = login;
  out.log = await getQuery(`SELECT at, kind, ev, "on" AS "on", via FROM privacy_state_log WHERE user_id = ? ORDER BY id DESC LIMIT 8`, [String(userId)]);
  if (!login) return out;
  let own = null;
  try { own = await require("./privacyeff").stated(login); } catch (e) { own = null; }
  out.bridge = await kindState(userId, login, "bridge", own ? own.bridge_off : null);
  out.tx = await kindState(userId, login, "tx", own ? own.tx_off : null);
  try {
    const I = await require("./incognito").stateOf(userId);
    out.incognito = { on: I.on, waiting: I.waiting ? { want: I.waiting.want } : null };
  } catch (e) { out.incognito = { on: null, waiting: null }; }
  try { const L = await require("./livecam").optoutState(userId); out.livecam = { off: !!L.off }; } catch (e) { out.livecam = { off: null }; }
  return out;
}

/** The member asks Pepe to switch `kind` (on = the privacy switch ON). -> {id} | throws Refuse. */
async function request(userId, kind, on, { ip } = {}) {
  await init();
  if (!effective()) throw new Refuse(404, "Not found.", "off");
  if (!KINDS.includes(kind)) throw new Refuse(400, "kind must be bridge or tx", "bad");
  if (typeof on !== "boolean") throw new Refuse(400, "on must be true or false", "bad");
  const login = await loginOf(userId);
  if (!login) throw new Refuse(409, "Link your Camfrog name first - these switches are about your chat identity.", "unlinked");
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM privacy_state_log WHERE user_id = ? AND ev = 'request' AND at > ?",
                                 [String(userId), now() - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) {
    await log({ userId, login, kind, ev: "refused", on, via: "web", ip });
    throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
  }
  let id;
  try {
    id = await tx(async () => {
      const aid = await require("./actions").queue(String(userId), { kind: ACTION[kind], args: [ARGS[kind][on ? 1 : 0]], tag: "privacy",
                                                                     label: kind === "bridge" ? `bridge ${on ? "off (hidden)" : "on (shown)"}` : `mic transcripts ${on ? "off" : "on"}` });
      await log({ userId, login, kind, ev: "request", on, via: "web", ip, at: now() });
      return aid;
    });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.", "busy");
    throw e;
  }
  return { id };
}

const WHERE = { web: "from Settings → Privacy", chat: { bridge: "with !bridge in chat", tx: "with !transcripts in chat" },
                ident: "carried over from a room line typed under the name you showed there", full: "" };
/** The inbox notice for one reported change (S6 wording - the owner approves it before the switch goes on). */
function noticeOf(kind, on, login, via) {
  const w = via === "chat" ? WHERE.chat[kind] : WHERE[via] || "";
  const where = w ? ` (${w})` : "";
  if (kind === "bridge") {
    return on
      ? { title: "🌉 You're hidden on the website",
          body: `Pepe switched the bridge OFF for your chat name ${login}${where}: the website shows you under a random frog name, blacks out your messages and mic transcripts, and hides your cam. Your own privacy switches come back when you turn the bridge back on. Not you? Turn it back on in Settings → Privacy.` }
      : { title: "🌉 You're on the website again",
          body: `Pepe switched the bridge back ON for your chat name ${login}${where}: the website goes back to your own privacy switches. What you said while you were hidden stays hidden. Not you? Turn it off in Settings → Privacy.` };
  }
  return on
    ? { title: "🎙 Mic transcripts off on the website",
        body: `Pepe switched your mic transcripts OFF on the website for your chat name ${login}${where}: from now on the website doesn't show what you say on the mic. Not you? Turn them back on in Settings → Privacy.` }
    : { title: "🎙 Mic transcripts on again",
        body: `Pepe switched your mic transcripts back ON on the website for your chat name ${login}${where}. Transcripts from while they were off stay off. Not you? Turn them off in Settings → Privacy.` };
}

/** livecam.setOptout: a linked login's live cam switch really changed (the website's own switch - the card, the Live cam card - or
 *  Pepe's !livecam). One inbox notice while the switchboard v3 is in effect; nothing otherwise. Never throws. */
async function camChanged(login, off, via, ts = now()) {
  try {
    if (!effective()) return false;
    const l = low(login);
    if (!LOGIN_RE.test(l)) return false;
    const u = await require("./incognito").userByLogin(l);
    if (!u) return false;
    const where = via === "chat" ? "with !livecam in chat" : "from Settings → Privacy";
    await require("./inbox").addSafe(u.userId, off
      ? { kind: "system", title: "📡 Your cam is hidden from the website",
          body: `Your cam is OFF for the website for your chat name ${l} (${where}): nobody there can watch it live, snap it or clip it. Not you? Turn it back on in Settings → Privacy.`,
          link: "/settings/privacy#web", ref: `pv3:cam:${l}:${Math.floor(Number(ts) || now())}` }
      : { kind: "system", title: "📡 Your cam can be watched on the website again",
          body: `Your cam is ON for the website again for your chat name ${l} (${where}) - who may watch is under Live cam in Settings → Privacy. Not you? Turn it off there.`,
          link: "/settings/privacy#web", ref: `pv3:cam:${l}:${Math.floor(Number(ts) || now())}` });
    return true;
  } catch (e) { console.error("[privacystate] cam notice:", e.message); return false; }
}

/** Pepe's report (the incognito report's body: its kind "bridge" / "tx" items and full_bridge / full_tx). Ignored while the switch's
 *  advert is off (a report that arrives after it went off changes nothing). -> {applied, ignored} */
async function sync(body) {
  await init();
  if (!advert()) return { applied: 0, ignored: 0, off: true };
  const t = now();
  const items = (Array.isArray(body && body.items) ? body.items : []).filter((it) => it && KINDS.includes(it.kind)).slice(0, 500);
  const INC = require("./incognito");
  let applied = 0, ignored = 0;
  for (const it of items) {
    const login = low(it.login);
    const ts = Math.floor(Number(it.ts) || 0);
    if (!login || !LOGIN_RE.test(login) || !(ts > 0)) { ignored++; continue; }
    const u = await INC.userByLogin(login);
    if (!u) { ignored++; continue; }                           // only linked chat logins are kept
    const on = it.on === true;
    const via = VIAS.has(it.via) ? it.via : "chat";
    const cur = (await getQuery(`SELECT "on" AS "on", updated FROM privacy_state WHERE login = ? AND kind = ?`, [login, it.kind]))[0];
    if (cur && Number(cur.updated) > ts) { ignored++; continue; }                     // older than what we have
    if (cur && Number(cur.updated) === ts && !!cur.on === on) { applied++; continue; } // a re-sent report
    await tx(async () => {
      await runQuery(`INSERT INTO privacy_state (login, kind, "on", updated, reported, via) VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT(login, kind) DO UPDATE SET "on" = excluded."on", updated = excluded.updated, reported = excluded.reported, via = excluded.via`,
                     [login, it.kind, on ? 1 : 0, ts, t, via]);
      await log({ userId: u.userId, login, kind: it.kind, ev: "applied", on, via, at: t });
    });
    applied++;
    if (it.changed === false) continue;
    const n = noticeOf(it.kind, on, login, via);
    await require("./inbox").addSafe(u.userId, { kind: "system", title: n.title, body: n.body, link: "/settings/privacy#web",
                                                 ref: `pv3:${it.kind}:${login}:${ts}` });
  }
  for (const kind of KINDS) {
    const list = body && body["full_" + kind];
    if (!Array.isArray(list)) continue;
    const set = new Set(list.map(low).filter((l) => LOGIN_RE.test(l)));
    await tx(async () => {
      for (const r of await getQuery(`SELECT login FROM privacy_state WHERE kind = ? AND "on" = 1`, [kind])) {
        if (!set.has(r.login)) await runQuery(`UPDATE privacy_state SET "on" = 0, reported = ? WHERE login = ? AND kind = ?`, [t, r.login, kind]);
      }
      const users = await INC.usersByLogins([...set]);
      for (const l of set) {
        if (!users.has(l)) continue;
        await runQuery(`INSERT INTO privacy_state (login, kind, "on", updated, reported, via) VALUES (?, ?, 1, NULL, ?, 'full')
                        ON CONFLICT(login, kind) DO UPDATE SET "on" = 1, reported = excluded.reported`, [l, kind, t]);
      }
      await setMeta("last_full_" + kind, t);
      await setMeta("full_n_" + kind, set.size);
    });
  }
  return { applied, ignored };
}

/** /admin/bridge (admins): how many people Pepe reports hidden / with transcripts off - never who. */
async function adminSummary() {
  await init();
  const out = { ...state() };
  for (const kind of KINDS) {
    out[kind] = { linked: (await getQuery(`SELECT COUNT(*) AS n FROM privacy_state WHERE kind = ? AND "on" = 1`, [kind]))[0].n,
                  all: Number(await meta("last_full_" + kind)) > 0 ? Number(await meta("full_n_" + kind)) : null,
                  last_full: Number(await meta("last_full_" + kind)) || null };
  }
  return out;
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[privacystate] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "4kb" });
  const fetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    console.error("[privacystate]", e && (e.code || e.message));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  // dark: 404 until the switch is on AND Pepe applies it (exactly as if the route didn't exist)
  const dark = (req, res, next) => (effective() ? next() : res.status(404).json({ ok: false, error: "Not found." }));
  app.get("/api/privacy/state", dark, addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await stateOf(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/privacy/state", dark, addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const b = req.body || {};
    try { res.json({ ok: true, ...(await request(req.user.userId, b.kind, b.on, { ip: guard.clientIp(req) })) }); } catch (e) { fail(res, e); }
  });
  // the switch (/admin/bridge#privacyv3; chatlog.admin, like privacy wire v2)
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/privacyv3", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { res.json({ ok: true, state: await adminSummary() }); }
    catch (e) { console.error("[privacystate] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/privacyv3", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (!fetchOnly(req, res)) return;
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { await setOn(b.on, { userId: req.user.userId, username: req.user.username }); res.json({ ok: true, state: await adminSummary() }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      console.error("[privacystate] switch:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, isOn, everOn, advert, noteBot, botOn, effective, state, setOn, register, request, sync, stateOf, adminSummary, camChanged,
                   noticeOf, loginOf, Refuse, KINDS, ACTION, ARGS, BOT_FRESH_MS, RATE_MAX, RATE_WINDOW_MS,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = cleanState(null); loaded = false; ready = null; BOT_AT = 0; } };
