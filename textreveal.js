// textreveal.js — 1.99?? (privacy controls S4t, G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner 2026-11-02 ~22:05Z: "yes" to
// PAD OWNERS, STAFF and room MODS revealing blacked-out TEXT too, like cams, through the reveal audit log). TEXT REVEAL ROLES.
//
// Text see-through = who is behind a frog name (chat lines, the people list, mic-stage tiles, the analytics boards) and what a blacked-out
// line / transcript bar says. Until now only Admins (chatlog.see_through - locked "privacy", Staff could never hold it, J-2) and a pad's
// owner in their own pad (their owner era) could. While this switch is ON:
//   staff  a holder of chatlog.reveal_text (Staff, locked "privacy": never granted further down) - every pad, every era
//   mod    a moderator of the pad's Camfrog room: Pepe's mod caps for the viewer's LINKED Camfrog login there (padmod.capsFor - the check
//          the Manage panel, livecam.mayEnd and S4's cam reveals use; Pepe sends caps only for linked logins watching the pad) - that pad
//          only, every era (the room's mod list has no history)
// Admins and pad owners keep exactly today's rules. Every reveal stays a seethrough_log row (with its scope and role) written BEFORE the
// answer; a non-admin must give a reason (at least REASON_MIN characters - 409 reason_needed, the page asks and sends it again); non-admin
// reveals are rate-limited (NONADMIN_PER_MIN lines a minute) and counted per day (seethrough.noteOwnerUse tells the Admins past its limits,
// as for owners). Audio evidence, cam evidence, the report queues' "h:" keys and Pepe's analytics notes are NOT text reveals: unchanged.
//
// THE SWITCH (dark): chatlog_meta 'text_reveal_roles' {on, at, by, first_on} - /admin/bridge "Text reveal roles" (chatlog.admin), audited
// (admin_audit textreveal.switch + a room_events row). Off (the default) = today's roles, words and refusals exactly. While on, the sync
// answer says `textreveal: 1` (advert()): Pepe's replies and help cards that name who can reveal switch to the new wording (bot pepe_privtext);
// the site's /privacy, /help and Settings sentences switch with the switch itself (privacycopy.js `textreveal`).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const REASON_MIN = 3;
const NONADMIN_PER_MIN = 60;
let clock = () => Date.now();
const now = () => clock();
let STATE = { on: false, at: null, by: null, first_on: null };
let ready = null, loaded = false;

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
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'text_reveal_roles'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** The switch (false until loaded: fails closed - today's roles). */
const isOn = () => loaded && STATE.on === true;
/** Does the sync answer say textreveal: 1? (the switch - text reveals need no privacy wire: frog names / "someone" exist on both) */
const advert = () => isOn();
function state() { return { ...STATE, loaded, advert: advert() }; }

async function setOn(want, user) {
  await init();
  const on = want === true;
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = now();
  const next = cleanState({ on, at: t, by: user && user.username ? user.username : null, first_on: STATE.first_on || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('text_reveal_roles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "textreveal.switch", null, { on }); } catch (e) { console.error("[textreveal] audit:", e.message); }
  try { await require("./rooms").event(null, "textreveal.switch", user && user.username ? user.username : null, `text reveal roles ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  console.log(`[textreveal] text reveal roles switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}

/** The extra text-reveal role of `user` on pad `roomId` while the switch is on: "staff" | "mod" | null (off: always null). Fresh; fails
 *  closed. Admins and pad owners are the callers' own rules (seethrough.chatRole, veilstage.stageRole, roomstats.seeThroughRole). */
async function extraRole(user, roomId) {
  if (!isOn() || !user || user.userId == null || !roomId) return null;
  let u = null;
  try { u = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(user.userId)]))[0] || null; } catch (e) { return null; }
  if (!u) return null;
  try { if (require("./siteperms").can(u, "chatlog.reveal_text")) return "staff"; } catch (e) { return null; }
  try {
    const R = require("./bridge")._rooms.get(String(roomId));
    if (R && u.camfrogUsername && require("./padmod").capsFor(R, u.camfrogUsername)) return "mod";
  } catch (e) { /* no caps */ }
  return null;
}
/** Must this reveal carry a reason? Every non-admin one while the switch is on (off: as today - optional). */
const needsReason = (role) => isOn() && !!role && role !== "admin" && (typeof role !== "object" || role.role !== "admin");
const reasonOk = (reason) => String(reason == null ? "" : reason).replace(/\s+/g, " ").trim().length >= REASON_MIN;
const REASON_MSG = "Say why (at least 3 characters) - it's logged.";
/** The 409 a page answers with "Why? (logged)" and sends again. */
function reasonRefusal(res) {
  return res.status(409).json({ ok: false, code: "reason_needed", reason_needed: true, error: REASON_MSG });
}
// non-admin reveals per user per minute (lines; a toggle counts 1)
const RL = new Map();
function limitedNonAdmin(uid, n = 1) {
  const t = now(), k = String(uid), w = RL.get(k) || { t, n: 0 };
  if (t - w.t > 60e3) { w.t = t; w.n = 0; }
  w.n += n;
  RL.set(k, w);
  if (RL.size > 5000) RL.delete(RL.keys().next().value);
  return w.n > NONADMIN_PER_MIN;
}
/** Who may reveal, in words, for the refusals (the switch picks the sentence). */
const whoMay = () => (isOn()
  ? "Only PATV admins and staff, a pad's owner in their own pad and the room's moderators can reveal who is behind a frog name."
  : "Only PATV admins, and a pad's owner in their own pad, can reveal who is behind a frog name.");

function register(app, { addUser }) {
  init().catch((e) => console.error("[textreveal] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/textreveal", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state() }); }
    catch (e) { console.error("[textreveal] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/textreveal", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }) }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      console.error("[textreveal] switch:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, isOn, advert, state, setOn, extraRole, needsReason, reasonOk, reasonRefusal, limitedNonAdmin, whoMay, register, Refuse,
                   REASON_MIN, REASON_MSG, NONADMIN_PER_MIN,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = cleanState(null); loaded = false; ready = null; RL.clear(); } };
