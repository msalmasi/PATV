// privact.js — 1.99ajs mfproof: PRIVATE-ACTIVITY PRESENCE LINES on pads (owner report 2026-11-04: brocklee258, Camfrog login ritchiecuh,
// "shows in the room ... mic transcripts show with his username on the site, but shows his mic grabs as 'someone'").
//
// Private activity = a linked account whose profile hides its Analytics section or that section's Rooms panel (chatlogview.privateFlags /
// stories.privateLogins - one rule). Since CL3 the pad chat shows such a person's JOIN / LEAVE / MIC / UNMIC lines as "someone"
// (chatlogview.dress - the live feed, scrollback / history, its search answers and the downloads all dress through it), while their
// chat and 🎙 transcript lines - content - stay named, and the people list and the page's 🎙 holder list name them too. On a live pad
// that mask hides nothing ("someone grabbed the mic" beside a named people-list entry and a named transcript of the same hold).
//
// THE SWITCH: chatlog_meta 'privact_presence' {mask, at, by}. mask true (the DEFAULT - also while unloaded or unreadable: fails closed)
// = today's CL3 mask, byte for byte. mask false = those four line kinds name the person like their chat lines do. Admin: /admin/bridge
// "Private-activity presence lines" (chatlog.admin), audited (admin_audit privact.presence + a room_events row). It changes only the
// presence-line mask: chat search still skips private accounts' lines (chatlogsearch.searchable), the pad's web-viewer list still
// leaves them out (padweb), and every cam / capture / clip / analytics rule is untouched. Incognito, !bridge hide, !transcripts off,
// forget-me and the removed / purged rules run before this one and are never affected.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const KEY = "privact_presence";
let clock = () => Date.now();
const now = () => clock();
let STATE = { mask: true, at: null, by: null };
let ready = null, loaded = false;

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

/** A stored value -> {mask, at, by}; anything but an explicit mask: false is the mask (today's rule). */
function cleanState(o) {
  const v = o && typeof o === "object" ? o : {};
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { mask: v.mask !== false, at: n(v.at), by: typeof v.by === "string" ? v.by.slice(0, 60) : null };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", [KEY]))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** Are a private-activity account's join / leave / mic / unmic lines "someone"? Synchronous; true until loaded (fails closed). */
const masked = () => !loaded || STATE.mask !== false;
function state() { return { ...STATE, loaded, masked: masked() }; }
async function setMask(want, user) {
  await init();
  const mask = want !== false;
  if (STATE.mask === mask) return { ...state(), unchanged: true };
  const next = cleanState({ mask, at: now(), by: user && user.username ? user.username : null });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [KEY, JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "privact.presence", null, { mask }); } catch (e) { console.error("[privact] audit:", e.message); }
  try { await require("./rooms").event(null, "privact.presence", user && user.username ? user.username : null, `private-activity presence lines ${mask ? "masked" : "named"}`); } catch (e) { /* best effort */ }
  console.log(`[privact] private-activity presence lines ${mask ? "MASKED" : "NAMED"} (${(user && user.username) || "?"})`);
  return state();
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[privact] init:", e.message));
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "2kb" });
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/privact", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state() }); }
    catch (e) { console.error("[privact] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/privact", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.mask !== "boolean") return res.status(400).json({ ok: false, error: "Say mask: true or false." });
    try { res.json({ ok: true, state: await setMask(b.mask, { userId: req.user.userId, username: req.user.username }) }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      console.error("[privact] switch:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, masked, state, setMask, register, cleanState, Refuse, KEY,
                   _setClock: (fn) => { clock = typeof fn === "function" ? fn : () => Date.now(); },
                   _reset: () => { ready = null; loaded = false; STATE = cleanState(null); } };
