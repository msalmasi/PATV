// incogcams.js — 1.99?? (privacy controls S5): INCOGNITO CAMS (G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S5", the
// owner's model 1.2 and his answers, section 8).
//
// The owner's rule (11-02): incognito hides the NAME on the website, never the cam. An incognito person whose cam is on in Camfrog
// and who hasn't switched live cam off (`!livecam off`) shows their cam on the website under their FROG NAME, and every cam feature
// is meant to work for it (Q4). Built in this slice: the people list's cam icon, ▶ Live, snapshots (+ Save, which Pepe names
// "someone"), ✨ Use in Generate, the pads' mic stages (live tiles + stills, Reveal / ✕ / ⚑ by the tile's id) and Pepe's side (AI
// references, on-air picks follow his gate). Not yet (still refused for a veiled cam, a follow-up): 🎬 cam clips, 📌 pins, stage cam
// slots, the site's on-air picker, and the cam itself in a mic-stage capture (drawn as the peek hood). What never reaches a member or a
// signed-out viewer is anything tied to the account (spec 1.2, the veiled-identity rule): the login, the PATV avatar or name
// style, the stage cover, real initials, a profile link, or the login inside an id, a session key, a WHEP path, an API answer, a
// capture's subject or a log non-admins read. A cam session belongs to ONE identity: a named one, or one frog-name session (each
// has a WHEP path of its own - livecam.js); any veil change ends it. Q3: no migration, no notice - the incognito people keep their
// livecam setting. Q23: such a cam is withheld only from viewers who are excluded (the person's cam access mode, their blocks),
// with the generic "That cam isn't available right now." - never a reason that names or describes them.
//
// THE SWITCH (dark): chatlog_meta 'incog_cams' {on, at, by, first_on} - /admin/bridge "Incognito cams" (chatlog.admin), audited
// (admin_audit incogcams.switch + a room_events row), like privacy wire v2 and evidence clips. It can go on only while privacy wire
// v2 is on (frog-name sessions and opaque ids exist only there). While it is on (and privacy wire v2 is), every sync answer says
// `incogcam: 1` (advert()); Pepe applies incognito cams only after that, and says `incogcam: 1` on his own sync while he does
// (noteBot). effective() = the advert AND Pepe's word within BOT_FRESH_MS: only then does the site show anything new. Off - or an
// older Pepe, or privacy wire v1 - and everything is exactly as before: a veiled person is never cam-opened (veil.js's anon rule).
//
// THE RESOLVER (server-only - nothing here is ever sent to a page):
//   entryOf(R, id)       the incognito person behind roster entry `id` (veil.opaqueId of their frog-name session) of bridge room R:
//                        {login, id, alias, hood, sess, onCam} - only while that session is their OPEN one (frognames.current) and
//                        they are incognito now and not left out / bridge off (quotes.isIncognito / isBridgeOff). null otherwise.
//   camOf(R, id)         entryOf + effective() + on cam (Pepe's roster): the one door to an incognito person's cam.
//   identityOf(R, login) the identity `login` shows in R now: "n" (named), "v:<sess>" (incognito, while effective), "x" (veiled
//                        otherwise), null (not listed) - a cam session / mic-stage tile runs under one and ends when it changes.
//   veiledPresence(R, login)  any veiled entry of that person in R (members, or a hold frozen veiled at its grab - spec 2.2: their
//                        NAMED cam waits until such a hold ends).
//   pageOnCam(u, roomId) chatlogview.roster: may this veiled roster entry carry on_cam to the page (a cam icon, ▶ Live by id)?
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const BOT_FRESH_MS = 2 * 60 * 1000;          // Pepe's word (his sync's incogcam: 1) counts this long - he syncs every few seconds
const ID_RE = /^v-[A-Za-z0-9_-]{12}$/;       // veil.opaqueId
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

let clock = () => Date.now();
const now = () => clock();
let STATE = { on: false, at: null, by: null, first_on: null };
let ready = null, loaded = false;
let BOT_AT = 0;

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

function cleanState(o) {
  const v = o && typeof o === "object" ? o : {};
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { on: v.on === true, at: n(v.at), by: typeof v.by === "string" ? v.by.slice(0, 60) : null, first_on: n(v.first_on) };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'incog_cams'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** The switch itself (false until loaded: fails closed). */
const isOn = () => loaded && STATE.on === true;
const pwOn = () => { try { return require("./privwire").isOn() === true; } catch (e) { return false; } };
/** Does the sync answer say incogcam: 1? The switch AND privacy wire v2 (frog names exist only there). */
const advert = () => isOn() && pwOn();
/** Pepe's sync body (v1 or v2): incogcam: 1 = he applies incognito cams now (he got our advert, on v2). Anything else: he doesn't. */
function noteBot(body, t = now()) { BOT_AT = body && typeof body === "object" && body.incogcam === 1 ? t : 0; }
const botOn = (t = now()) => BOT_AT > 0 && t - BOT_AT <= BOT_FRESH_MS;
/** May the site show an incognito person's cam now? The advert AND Pepe's word. Synchronous; fails closed. */
const effective = (t = now()) => advert() && botOn(t);
function state() { return { ...STATE, loaded, advert: advert(), pepe: botOn(), effective: effective(), privwire: pwOn() }; }

/** Flip the switch (user = {userId, username}). ON needs privacy wire v2 (409 privwire_off). Audited twice. Switching OFF ends
 *  every cam session of an incognito person at once (livecam.veilSwitchOff) - Pepe's next answer has no advert either. */
async function setOn(want, user) {
  await init();
  const on = want === true;
  if (on && !pwOn()) throw new Refuse(409, "Turn privacy wire v2 on first - frog names exist only on it.", "privwire_off");
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = now();
  const next = cleanState({ on, at: t, by: user && user.username ? user.username : null, first_on: STATE.first_on || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('incog_cams', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "incogcams.switch", null, { on }); } catch (e) { console.error("[incogcams] audit:", e.message); }
  try { await require("./rooms").event(null, "incogcams.switch", user && user.username ? user.username : null, `incognito cams ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  if (!on) { try { require("./livecam").veilSwitchOff(); } catch (e) { /* no live cams */ } }
  console.log(`[incogcams] incognito cams switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}

// ── the resolver (server-only) ──
/** Is `login` incognito now - veiled by incognito ALONE (not !bridge hide, forget-me, a deletion, a staff removal)? Fails closed. */
function personIncognito(login) {
  try { const Q = require("./quotes"); return !!Q.isIncognito(login) && !Q.isBridgeOff(login); } catch (e) { return false; }
}
/** Is frog-name session `sess` still `login`'s OPEN one in room `roomId`? */
function sessOpen(roomId, login, sess) {
  try { const cur = require("./frognames").current(roomId, login); return !!(cur && cur.session != null && String(cur.session) === String(sess)); }
  catch (e) { return false; }
}
/** The incognito person behind roster entry `id` of bridge room R (see the header) - never checks the switch or the cam. */
function entryOf(R, id) {
  if (!R || typeof id !== "string" || !ID_RE.test(id)) return null;
  const e = (R.members || []).find((x) => x && x.anon === true && x.veil === "incognito" && x.id === id);
  const vz = e && e._vz;
  if (!vz || vz.kind !== "incognito" || vz.sess == null || !LOGIN_RE.test(low(vz.login))) return null;
  const login = low(vz.login);
  if (!personIncognito(login) || !sessOpen(R.id, login, vz.sess)) return null;
  return { login, id, alias: typeof e.alias === "string" && e.alias ? e.alias : null, hood: Number.isInteger(e.hood) ? e.hood : null,
           sess: String(vz.sess), onCam: vz.on_cam === true ? true : vz.on_cam === false ? false : null };
}
/** The one door to an incognito person's cam: entryOf, while incognito cams are effective and Pepe says they're on cam. */
function camOf(R, id, t = now()) {
  if (!effective(t)) return null;
  const v = entryOf(R, id);
  return v && v.onCam === true ? v : null;
}
/** The incognito roster entry of `login` in R whose frog-name session is `sess` (or their open one when sess is null). */
function entryByLogin(R, login, sess = null) {
  const l = low(login);
  if (!R || !LOGIN_RE.test(l)) return null;
  for (const e of R.members || []) {
    const vz = e && e.anon === true && e.veil === "incognito" ? e._vz : null;
    if (!vz || vz.kind !== "incognito" || low(vz.login) !== l || vz.sess == null) continue;
    if (sess != null && String(vz.sess) !== String(sess)) continue;
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) continue;
    const v = entryOf(R, e.id);
    if (v) return v;
  }
  return null;
}
/** The identity `login` shows in room R now (see the header). Named wins only when no veiled entry of theirs is listed. */
function identityOf(R, login, t = now()) {
  const l = low(login);
  if (!R || !LOGIN_RE.test(l)) return null;
  let named = false, veiled = null;
  for (const e of R.members || []) {
    if (!e) continue;
    if (!e.anon && low(e.login) === l) named = true;
    else if (e.anon && e._vz && low(e._vz.login) === l) {
      if (e._vz.kind === "incognito" && e._vz.sess != null && !veiled) veiled = "v:" + String(e._vz.sess);
      else veiled = "x";
    }
  }
  if (veiled && veiled !== "x") {
    if (!effective(t) || !personIncognito(l) || !sessOpen(R.id, l, veiled.slice(2))) return "x";
    return veiled;
  }
  if (veiled) return "x";
  return named ? "n" : null;
}
/** Any veiled entry of `login` in R - a frog-name roster entry, or a mic hold frozen veiled at its grab. */
function veiledPresence(R, login) {
  const l = low(login);
  if (!R || !l) return false;
  for (const e of [...(R.members || []), ...(R.mic || [])]) if (e && e.anon && e._vz && low(e._vz.login) === l) return true;
  return false;
}
/** chatlogview.roster: may this veiled roster entry show on_cam to the page? Only an incognito entry with its opaque id (a frog
 *  name), incognito cams effective, on cam, and the person hasn't switched live cam off (a withheld cam has no cam icon - the
 *  person list says nothing about why). Every viewer gets the same entry: the per-viewer gate (Q23) is ▶ Live's. */
function pageOnCam(u, roomId, t = now()) {
  if (!u || u.anon !== true || u.veil !== "incognito" || !u.alias || typeof u.id !== "string" || !ID_RE.test(u.id)) return false;
  const vz = u._vz;
  if (!vz || vz.kind !== "incognito" || vz.on_cam !== true || !effective(t)) return false;
  const l = low(vz.login);
  if (!LOGIN_RE.test(l) || !personIncognito(l) || vz.sess == null || roomId == null || !sessOpen(roomId, l, vz.sess)) return false;
  try { if (require("./livecam").optedOut(l)) return false; } catch (e) { return false; }
  return true;
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[incogcams] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/incogcams", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state() }); }
    catch (e) { console.error("[incogcams] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/incogcams", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }) }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      console.error("[incogcams] switch:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, isOn, advert, noteBot, botOn, effective, state, setOn, register, Refuse, BOT_FRESH_MS, ID_RE,
                   personIncognito, sessOpen, entryOf, camOf, entryByLogin, identityOf, veiledPresence, pageOnCam,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = cleanState(null); loaded = false; ready = null; BOT_AT = 0; } };
