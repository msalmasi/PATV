// plexsso.js — 1.99jr: "Sign in with Plex" on /login and /register.
//
// THE FLOW (Plex's PIN sign-in, the same one plexmembers.js uses to self-link):
//   GET  /auth/plex             make a strong PIN at plex.tv (POST /api/v2/pins?strong=true, PATV's client id + product),
//                               remember it IN THIS BROWSER'S SESSION (pin id, time, where to return) and send the visitor
//                               to app.plex.tv/auth#?... with forwardUrl = <site>/auth/plex/callback
//   GET  /auth/plex/callback    the session's pin, SINGLE USE (dropped before anything else) and at most 10 minutes old:
//                               read the pin; once Plex filled in its auth token, read WHO with it (GET /api/v2/user ->
//                               id, username, email, confirmed) and drop the token - it is never stored or logged
//     linked   -> signed in through user.controller finishLogin (the same path as a password sign-in)
//     not yet  -> the Plex identity waits in the session (10 minutes) and /auth/plex/new offers:
//                 * "Create a PATV account with Plex" (POST /auth/plex/create: the sign-up rules - createSsoAccount)
//                 * "I already have an account": /login?plex=1, a password sign-in that then links it (loginUser)
//
// LINKED means a plex_members row (plexmembers.js) for that Plex account id with a user and a TRUSTED link source:
//   self (proved with Plex's sign-in), admin, wizarr (a PATV invite code redeemed by that Plex account), overseerr (an
//   admin's link). NOT "email": a sync's guess from a matching email address is never enough to sign in as someone.
// A PATV account is NEVER picked by matching the Plex email or username (account takeover): only an explicit link.
// Linking here is the plexmembers self-link (link_source self), so 📼 free plays / flair / perks follow.
//
// Switch: mediaconf plex_sso (default on, /admin/media). Rate limits per IP on start, callback and create.
"use strict";
const crypto = require("crypto");
const conf = require("./mediaconf");
const guard = require("./middleware/authGuard");
const { getQuery } = require("./dbUtils");

const TTL = 10 * 60 * 1000;
const TRUSTED = ["self", "admin", "wizarr", "overseerr"];
let clock = () => Date.now();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PM = () => require("./plexmembers");
const UC = () => require("./user.controller");

const startLimit = guard.limiter({ max: 12, windowMs: 15 * 60 * 1000 });
const callbackLimit = guard.limiter({ max: 30, windowMs: 15 * 60 * 1000 });
const createLimit = guard.limiter({ max: 10, windowMs: 15 * 60 * 1000 });
const used = new Map();            // pin id -> when it was used (a replayed pin is refused even with a copied session)

function enabled() {
  try { return conf.get().plex_sso !== false; } catch (e) { return false; }
}
const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : en);
function fail(req, res, key, en) {
  req.flash("error", tr(req, key, en));
  return res.redirect("/login");
}
function fresh(o) { return !!o && typeof o === "object" && Number(o.at) > 0 && clock() - Number(o.at) <= TTL; }

/** The Plex identity waiting in this session (or null): {plex_id, username, email, email_verified, at}. */
function pendingFor(req) {
  const p = req && req.session && req.session.plexPending;
  if (!fresh(p)) { if (req && req.session && p) delete req.session.plexPending; return null; }
  return p;
}

/** The PATV account explicitly linked to a Plex account id (trusted link sources only), or null. */
async function linkedUser(plexId) {
  await PM().init();
  const rows = await getQuery(`SELECT u.userId, u.username, u.class, m.link_source FROM plex_members m JOIN users u ON u.userId = m.user_id
                               WHERE m.plex_id = ? AND m.user_id IS NOT NULL`, [String(plexId)]);
  const r = rows[0];
  return r && TRUSTED.includes(r.link_source) ? { userId: r.userId, username: r.username, class: r.class } : null;
}

/** Link the session's pending Plex identity to `user` (after "I already have an account" + a password sign-in). */
async function linkPendingTo(req, user) {
  const p = pendingFor(req);
  if (!p || !user || !user.userId) return null;
  delete req.session.plexPending;
  try {
    const r = await PM().linkSelf({ userId: user.userId, username: user.username }, { plex_id: p.plex_id, username: p.username, email: p.email });
    req.flash("success", tr(req, "auth.plex.linked", `Your Plex account ${p.username} is linked. Next time, just Sign in with Plex.`, { plex: p.username }));
    return r;
  } catch (e) {
    req.flash("error", e && e.refuse ? e.message : tr(req, "auth.plex.link_failed", "Your Plex account couldn't be linked. Try again from Edit profile, Connections."));
    return null;
  }
}

/** The pin -> the Plex identity, or null when Plex hasn't finished. The token is used once, here, and dropped. */
async function identityFromPin(pinId) {
  const api = PM().plexApi;
  let token = null;
  for (let i = 0; i < 4 && !token; i++) {
    if (i) await sleep(1000);
    const r = await api("GET", `/api/v2/pins/${encodeURIComponent(pinId)}`);
    if (r.status === 404) return null;
    token = r.json && r.json.authToken ? String(r.json.authToken) : null;
  }
  if (!token) return null;
  const who = await api("GET", "/api/v2/user", { "X-Plex-Token": token });
  token = null;
  const pu = who.json || {};
  if (who.status !== 200 || !/^\d{1,15}$/.test(String(pu.id || ""))) throw Object.assign(new Error("no Plex user"), { plex: true });
  return { plex_id: String(pu.id), username: String(pu.username || pu.title || "").slice(0, 64), email: typeof pu.email === "string" ? pu.email.slice(0, 254) : null,
           email_verified: pu.confirmed === true };
}

function register(app, { addUser, authView } = {}) {
  const view = (req, extra) => (authView ? authView(req, extra) : Object.assign({ user: req.user ? req.user.username : null, errors: req.flash("error"),
    success: req.flash("success"), form: {}, next: "" }, extra));
  const home = (u, next) => next || `/u/${encodeURIComponent(u.username)}/wheel`;

  app.get("/auth/plex", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.user && req.user.username) return res.redirect(`/u/${encodeURIComponent(req.user.username)}/edit#connections`);
    await conf.init().catch(() => {});
    if (!enabled()) return fail(req, res, "auth.plex.off", "Plex sign-in isn't available right now.");
    // the session cookie is per host: start on the host Plex will send them back to
    try {
      const site = new URL(PM().site());
      if (req.get("host") && site.host !== req.get("host")) return res.redirect(site.origin + req.originalUrl);
    } catch (e) { /* bad config: carry on */ }
    const ip = guard.clientIp(req);
    const wait = startLimit.blocked(ip);
    if (wait) return fail(req, res, "auth.plex.slow_down", "Too many Plex sign-ins from your network. Try again in a few minutes.");
    startLimit.hit(ip);
    try {
      const r = await PM().plexApi("POST", "/api/v2/pins?strong=true");
      const id = String(r.json && r.json.id || ""), code = String(r.json && r.json.code || "");
      if ((r.status !== 201 && r.status !== 200) || !/^\d{1,15}$/.test(id) || !/^[A-Za-z0-9]{4,64}$/.test(code)) throw new Error(`pin answered ${r.status}`);
      req.session.plexSso = { pin: id, at: clock(), next: guard.safeNext(req.query.next) || "" };
      delete req.session.plexPending;
      const url = "https://app.plex.tv/auth#?" + new URLSearchParams({ clientID: PM().clientId(), code, "context[device][product]": "PATV",
        forwardUrl: PM().site() + "/auth/plex/callback" }).toString();
      return res.redirect(url);
    } catch (e) {
      console.error("[plexsso] start:", e && e.message);
      return fail(req, res, "auth.plex.unreachable", "Plex's sign-in can't be reached right now. Try again in a minute.");
    }
  });

  app.get("/auth/plex/callback", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const st = req.session && req.session.plexSso;
    if (req.session) delete req.session.plexSso;                       // single use, whatever happens next
    if (!enabled()) return fail(req, res, "auth.plex.off", "Plex sign-in isn't available right now.");
    if (!fresh(st) || !/^\d{1,15}$/.test(String(st.pin || "")) || used.has(String(st.pin)))
      return fail(req, res, "auth.plex.expired", "That Plex sign-in expired or didn't start here. Please try again.");
    const ip = guard.clientIp(req);
    if (callbackLimit.blocked(ip)) return fail(req, res, "auth.plex.slow_down", "Too many Plex sign-ins from your network. Try again in a few minutes.");
    callbackLimit.hit(ip);
    for (const [k, at] of used) if (clock() - at > 2 * TTL) used.delete(k);
    used.set(String(st.pin), clock());
    let who;
    try { who = await identityFromPin(st.pin); }
    catch (e) { console.error("[plexsso] identity:", e && e.message); return fail(req, res, "auth.plex.failed", "Plex sign-in didn't work. Please try again."); }
    if (!who) return fail(req, res, "auth.plex.unfinished", "The Plex sign-in wasn't finished. Please try again.");
    try {
      const u = await linkedUser(who.plex_id);
      if (u) {
        await UC().finishLogin(req, res, u, "plex sign-in");
        console.log(`[plexsso] ${u.username} signed in with Plex`);
        return res.redirect(home(u, st.next));
      }
      req.session.plexPending = { ...who, at: clock(), next: st.next || "" };
      return res.redirect("/auth/plex/new");
    } catch (e) {
      console.error("[plexsso] callback:", e && e.message);
      return fail(req, res, "auth.plex.failed", "Plex sign-in didn't work. Please try again.");
    }
  });

  app.get("/auth/plex/new", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.user && req.user.username) return res.redirect(`/u/${encodeURIComponent(req.user.username)}/edit#connections`);
    const p = pendingFor(req);
    if (!p) return fail(req, res, "auth.plex.expired", "That Plex sign-in expired or didn't start here. Please try again.");
    let suggest = "";
    try { suggest = await UC().generateUniqueUsername(p.username); } catch (e) { suggest = ""; }
    res.render("plexSso", view(req, { plex: { username: p.username, email: !!p.email, verified: !!p.email_verified }, suggest, next: p.next || "" }));
  });

  app.post("/auth/plex/create", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site sign-up refused");
    if (req.user && req.user.username) return res.redirect(`/u/${encodeURIComponent(req.user.username)}/edit#connections`);
    const p = pendingFor(req);
    if (!p) return fail(req, res, "auth.plex.expired", "That Plex sign-in expired or didn't start here. Please try again.");
    if (!enabled()) return fail(req, res, "auth.plex.off", "Plex sign-in isn't available right now.");
    const username = String((req.body || {}).username || "").trim().slice(0, 64);
    const back = (msg, field) => { req.flash("error", msg); req.flash("authForm", JSON.stringify({ username, field })); return res.redirect("/auth/plex/new"); };
    const ip = guard.clientIp(req);
    if (createLimit.blocked(ip)) return back(tr(req, "auth.plex.slow_down", "Too many Plex sign-ins from your network. Try again in a few minutes."));
    createLimit.hit(ip);
    try {
      // the Plex account may have been linked meanwhile (another tab): never make a second account for it
      const already = await linkedUser(p.plex_id);
      if (already) { delete req.session.plexPending; await UC().finishLogin(req, res, already, "plex sign-in"); return res.redirect(home(already, p.next)); }
      const r = await UC().createSsoAccount(req, res, { username, email: p.email, emailVerified: p.email_verified, provider: "plex", identity: "plex:" + p.plex_id });
      if (r.error) return back(r.error, r.field);
      delete req.session.plexPending;
      try { await PM().linkSelf(r.user, { plex_id: p.plex_id, username: p.username, email: p.email }); }
      catch (e) { console.error("[plexsso] link new account:", e && e.message); }
      await UC().finishLogin(req, res, r.user, "plex sign-up");
      req.flash("success", tr(req, "auth.plex.welcome", `Welcome to PATV, ${r.user.username}! Your Plex account is linked.`, { name: r.user.username }));
      return res.redirect(home(r.user, p.next));
    } catch (e) {
      console.error("[plexsso] create:", e && e.message);
      return back(tr(req, "auth.err.register_failed", "Something went wrong creating your account. Please try again."));
    }
  });

  app.post("/auth/plex/cancel", addUser, (req, res) => {
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
    if (req.session) delete req.session.plexPending;
    res.redirect("/login");
  });
}

module.exports = {
  register, enabled, pendingFor, linkedUser, linkPendingTo, identityFromPin, TRUSTED, TTL,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setSleep: (fn) => { sleep = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); },
  _clearUsed: () => used.clear(),
};
