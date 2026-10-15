// onairconsent.js — 📺 on Pepe's OBS: ON-DEMAND CONSENT (1.99aag). When an admin picks something that needs someone
// else's OK before it may go on Pepe's main stream (public site + Twitch relay + his Camfrog cam), the pick waits for it:
//   * a slot on an APPROVED-only pad   -> the pad OWNER (rooms registry owner) is asked;
//   * a cam whose owner hasn't opted in -> the CAM OWNER is asked (their linked PATV account, and Pepe PMs them in Camfrog).
// The ask = an inbox notification + a Camfrog PM (rooms.notify; for cams Pepe's own PM with "!onair yes|no|always") + a
// prompt on the pad page while they're online (public/js/onair-consent.js polls /api/onair/consent/mine) + the page
// /onair/consent/<id>. One tap: Allow this time · Allow for this session (SESSION_MS) · Deny; for a pad "always allow
// for my pad" (onair_pad_allow, revocable on the pad's settings → Stage) and for a cam "always" = the cam owner's normal
// on-air opt-in (onair_optin). Unanswered after cfg consent_min minutes -> expired, the pick is dropped.
// Nothing is remembered beyond the session unless "always" was ticked: session allows live in memory only.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const SESSION_MS = 6 * 3600 * 1000;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
let clock = () => Date.now();
const now = () => clock();
const OA = () => require("./onair");
const rooms = () => require("./rooms");

const SESSION = new Map();        // "pad:<id>" | "cam:<login>" -> until
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_consent (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pad TEXT, owner_id TEXT, login TEXT,
                      room TEXT, slot_id TEXT, label TEXT, by TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL,
                      scope TEXT, decided_at INTEGER, decided_via TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS onair_consent_status ON onair_consent (status, expires)");
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_pad_allow (pad TEXT PRIMARY KEY, owner_id TEXT, at INTEGER NOT NULL)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

/** The user id of a pad's owner (a user-owned pad), else null (house / no owner: staff decide - no ask). */
function padOwnerId(pad) {
  try { const r = rooms().getCached(String(pad || "")); return r && r.owner && r.owner.userId ? String(r.owner.userId) : null; } catch (e) { return null; }
}
async function userOfLogin(login) {
  const r = (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ? LIMIT 1", [String(login || "").toLowerCase()]))[0];
  return r ? String(r.userId) : null;
}

// ── standing allows ──
async function padAllowed(pad, t = now()) {
  await init();
  if ((SESSION.get("pad:" + pad) || 0) > t) return "session";
  return (await getQuery("SELECT 1 AS x FROM onair_pad_allow WHERE pad = ?", [String(pad)])).length ? "always" : null;
}
function camAllowed(login, t = now()) { return (SESSION.get("cam:" + String(login).toLowerCase()) || 0) > t ? "session" : null; }
async function padAllowState(pad) {
  await init();
  const r = (await getQuery("SELECT owner_id, at FROM onair_pad_allow WHERE pad = ?", [String(pad)]))[0];
  return { always: !!r, at: r ? r.at : null, session_until: SESSION.get("pad:" + pad) || null };
}
async function setPadAllow(pad, userId, on) {
  await init();
  if (on) await runQuery("INSERT OR REPLACE INTO onair_pad_allow (pad, owner_id, at) VALUES (?, ?, ?)", [String(pad), String(userId), now()]);
  else { await runQuery("DELETE FROM onair_pad_allow WHERE pad = ?", [String(pad)]); SESSION.delete("pad:" + pad); }
  await OA().onConsentChange({ kind: "pad", pad: String(pad), revoked: !on }).catch(() => {});
  return padAllowState(pad);
}

// ── requests ──
const rowView = (r) => r && ({ id: r.id, kind: r.kind, pad: r.pad, login: r.login, room: r.room, slot_id: r.slot_id, label: r.label, by: r.by,
  created: r.created, expires: r.expires, status: r.status, scope: r.scope, decided_at: r.decided_at });
async function get(id) { await init(); return rowView((await getQuery("SELECT * FROM onair_consent WHERE id = ?", [String(id || "")]))[0]); }

/** Ask. {kind: pad|cam, pad, login, room, slot_id, label, by, minutes} -> the request. Notifies at once. */
async function ask(o) {
  await init();
  const t = now();
  const id = crypto.randomBytes(9).toString("base64url");
  const owner = o.kind === "pad" ? module.exports.padOwnerId(o.pad) : await userOfLogin(o.login);
  const mins = Math.max(1, Math.min(60, Number(o.minutes) || 10));
  await runQuery(`INSERT INTO onair_consent (id, kind, pad, owner_id, login, room, slot_id, label, by, created, expires, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [id, o.kind, o.pad || null, owner, o.login ? String(o.login).toLowerCase() : null, o.room || null, o.slot_id || null,
     String(o.label || "").slice(0, 120), String(o.by || "?").slice(0, 80), t, t + mins * 60000]);
  if (owner) {
    const what = o.kind === "pad" ? `a stream on your pad (${o.label})` : "your Camfrog cam";
    rooms().notify(owner, { kind: "stage", title: "📺 May Pepe show " + (o.kind === "pad" ? "your pad's stream" : "your cam") + " on his main stream?",
      body: `An admin wants ${what} on Pepe's main stream (publicaccess.tv, his Twitch relay and his Camfrog cam). Allow or deny within ${mins} min - nothing goes on air without your OK.`,
      link: "/onair/consent/" + id, ref: "onair-consent:" + id }).catch(() => {});
  }
  return get(id);
}
/** Pending asks this user can answer (pad owner / the cam's linked account). */
async function mine(userId) {
  await init();
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const login = u && u.camfrogUsername ? String(u.camfrogUsername).toLowerCase() : "";
  const rows = await getQuery(`SELECT * FROM onair_consent WHERE status = 'pending' AND expires > ? AND (owner_id = ? OR (kind = 'cam' AND login = ?))
                               ORDER BY created DESC LIMIT 5`, [now(), String(userId), login || "\u0000"]);
  return rows.map(rowView);
}
/** Pending cam asks Pepe should PM about (by login). */
async function camAsks() {
  await init();
  return (await getQuery("SELECT * FROM onair_consent WHERE status = 'pending' AND kind = 'cam' AND expires > ? ORDER BY created LIMIT 20", [now()])).map(rowView);
}

/** Answer. answer: once | session | always | deny. who: {userId} (web) or {login} (Pepe: the cam owner typing in Camfrog). */
async function decide(id, answer, who = {}, via = "web") {
  await init();
  const r = (await getQuery("SELECT * FROM onair_consent WHERE id = ?", [String(id || "")]))[0];
  if (!r) throw new Refuse(404, "That request doesn't exist.");
  let may = false;
  if (who.userId && r.owner_id && String(who.userId) === String(r.owner_id)) may = true;
  if (!may && r.kind === "cam" && who.login && String(who.login).toLowerCase() === r.login) may = true;
  if (!may && r.kind === "cam" && who.userId) {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(who.userId)]))[0];
    may = !!(u && u.camfrogUsername && String(u.camfrogUsername).toLowerCase() === r.login);
  }
  if (!may) throw new Refuse(403, "This request isn't yours to answer.");
  if (r.status !== "pending") throw new Refuse(409, `Already ${r.status}.`);
  if (r.expires <= now()) { await expireOne(r); throw new Refuse(409, "That request expired."); }
  if (!["once", "session", "always", "deny"].includes(answer)) throw new Refuse(400, "Allow or deny?");
  const status = answer === "deny" ? "denied" : "allowed";
  await runQuery("UPDATE onair_consent SET status = ?, scope = ?, decided_at = ?, decided_via = ? WHERE id = ? AND status = 'pending'",
    [status, answer === "deny" ? null : answer, now(), via, r.id]);
  if (answer === "session") SESSION.set((r.kind === "pad" ? "pad:" + r.pad : "cam:" + r.login), now() + SESSION_MS);
  if (answer === "always") {
    if (r.kind === "pad") await runQuery("INSERT OR REPLACE INTO onair_pad_allow (pad, owner_id, at) VALUES (?, ?, ?)", [r.pad, r.owner_id || who.userId || null, now()]);
    else await OA().setOptin(r.login, true, { via: via === "chat" ? "chat" : "web", userId: who.userId || null });
  }
  const c = await get(r.id);
  await OA().onConsentChange({ kind: r.kind, request: c });
  return c;
}
async function expireOne(r) {
  await runQuery("UPDATE onair_consent SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", [now(), r.id]);
  await OA().onConsentChange({ kind: r.kind, request: await get(r.id) });
}
async function sweep() {
  await init();
  for (const r of await getQuery("SELECT * FROM onair_consent WHERE status = 'pending' AND expires <= ?", [now()])) await expireOne(r);
  for (const [k, until] of SESSION) if (until <= now()) SESSION.delete(k);
}
async function cancel(id) {
  await init();
  await runQuery("UPDATE onair_consent SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'", [now(), String(id || "")]);
}

// ── routes ──
function register(app, { addUser }) {
  init().catch((e) => console.error("[onairconsent] init:", e.message));
  const guard = require("./middleware/authGuard");
  const csrf = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch" ? next()
    : res.status(403).json({ ok: false, error: "Security check failed - reload the page." }));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[onairconsent]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.get("/onair/consent/:id", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    try {
      const c = await get(req.params.id);
      const mineList = await mine(req.user.userId);
      const own = !!(c && (mineList.some((m) => m.id === c.id) || c.status !== "pending"));
      res.render("onairConsent", { user: req.user.username, c: own ? c : null });
    } catch (e) { console.error("[onairconsent] page:", e); res.status(500).send("Couldn't load the page."); }
  });
  app.get("/api/onair/consent/mine", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.json({ ok: true, asks: [] });
    try { res.json({ ok: true, asks: await mine(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/onair/consent/:id", addUser, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, request: await decide(req.params.id, String((req.body || {}).answer || ""), { userId: req.user.userId }, "web") }); }
    catch (e) { fail(res, e); }
  });
  // the pad's settings → Stage: "always allow" (revocable)
  const ownerOf = (req) => { const id = String(req.params.pad || ""); return module.exports.padOwnerId(id) === String(req.user.userId) ? id : null; };
  app.get("/api/onair/pad-allow/:pad", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const pad = ownerOf(req);
    if (!pad) return res.status(403).json({ ok: false, error: "Only the pad's owner can see this." });
    try { res.json({ ok: true, ...(await padAllowState(pad)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/onair/pad-allow/:pad", addUser, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const pad = ownerOf(req);
    if (!pad) return res.status(403).json({ ok: false, error: "Only the pad's owner can change this." });
    try { res.json({ ok: true, ...(await setPadAllow(pad, req.user.userId, (req.body || {}).always === true)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, init, ask, get, mine, camAsks, decide, sweep, cancel, padAllowed, camAllowed, padAllowState, setPadAllow, padOwnerId, userOfLogin,
  Refuse, SESSION_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { SESSION.clear(); ready = null; },
};
