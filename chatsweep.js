// chatsweep.js — S1 F13 (C8-v1-signout-sweep, the owner's answer of 2026-10-25; ADR 0007 D14, CF §5.7): a sign-out leaves
// no chat lines behind in this browser, also when no chat page opens again.
//
// The chat hub's widget keeps one IndexedDB database per account on this origin, `patv-chat:<hub account id>` (the platform
// repo's packages/chat-core/src/storage/account.ts: cached rooms and lines, the looks cache, the outbox and the sent journal).
// The widget deletes it itself when it hears the sign-out (a chat tab open: the hub closes 4003), and a later widget page
// deletes every other account's database when it signs in; but v1's signed-out pages load no widget, so a shared computer
// kept a signed-out account's lines for as long as nobody opened a widget page. Now:
//
//   * every response that ends this browser's login - loginCookie.clearLogin: Sign out (POST /logout), Your devices' "Sign
//     out" on this device and "Sign out everywhere", a password reset, a password change that signs this device out, a
//     rename, an account deletion, refreshLogin finding the account gone, and sessions.gate seeing a revoked / expired /
//     unknown session - also sets the marker cookie `patv_chat_sweep` (mark());
//   * the next signed-out page that uses layout.ejs (the one the sign-out lands on: `/` after Sign out, `/login` after the
//     others) carries a small static inline script, views/partials/chat-sweep.ejs (locals() below, or mark() on the
//     response that signs out, puts `chatSweep` on the page): it deletes every `patv-chat:<uuid>` database
//     (indexedDB.databases(), the widget's own sweep rule), then the marker. A delete that fails or never finishes keeps the
//     marker, so the next signed-out page tries again. A browser without databases() (Firefox before 126) can't list them:
//     the marker goes, and only the widget's own wipes reach its databases.
//
// The marker's value is always "1": it says nothing about the account (review 1 of F13: an account id there would outlive
// the sign-out wherever the sweep didn't run - JavaScript off, a tab holding the database - in a cookie that isn't
// HttpOnly, on a shared computer). Not HttpOnly (the page's script deletes it); sent only to this site and never logged.
//
// Never while signed in: the script deletes EVERY account database, the signed-in account's too. So the page gets it only
// when the request has no live login (liveLogin(): no session from sessions.gate and no login cookie a reader would accept;
// a marker that outlived a sweep and a later sign-in stays quiet) AND the view renders signed out (layout.ejs, the second
// check). An account switch without a sign-out is the widget's (its sign-in sweeps every other account's database).
//
// Not Clear-Site-Data: it can't name databases. "storage" would also clear local storage (drafts and preferences), the
// widget's device database `patv-device` (the device id, which survives every wipe by design) and the notifications
// service worker. The device database is never touched here. No switch: the script finds nothing to delete where the
// widget never ran, and a switch left off would keep exactly the data this is for, after a CHAT_HUB rollback too.
"use strict";
const jwt = require("jsonwebtoken");

const COOKIE = "patv_chat_sweep";
const VALUE = "1";
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;   // as long as a login lasts (loginCookie LOGIN_DAYS): until the next signed-out page
// The platform's rule (account.ts ACCOUNT_DB_PREFIX + UUID_RE, accountDbName): the account databases only - never patv-device,
// never another name under the prefix.
const ACCOUNT_DB_PREFIX = "patv-chat:";
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACCOUNT_DB_RE = new RegExp("^" + ACCOUNT_DB_PREFIX + UUID_SRC + "$");

function cookieOptions() {
  return { httpOnly: false, secure: true, sameSite: "Lax", path: "/", maxAge: MAX_AGE_MS };
}

/** loginCookie.clearLogin: the next signed-out page (this response's own included) deletes this browser's chat databases. */
function mark(res) {
  if (!res || typeof res.cookie !== "function") return;
  try {
    res.cookie(COOKIE, VALUE, cookieOptions());
    if (res.locals) res.locals.chatSweep = true;
  } catch (e) {
    console.error("[chatsweep] mark failed:", e.message);
  }
}

/** A login this request still has (after sessions.gate): a live session, or a login cookie the readers would accept. */
function liveLogin(req) {
  if (!req) return false;
  if (req.loginSession) return true;
  const tok = req.cookies && req.cookies.jwt;
  if (!tok) return false;
  try {
    const d = jwt.verify(tok, process.env.SECRET_KEY || "");
    return !!(d && d.userId);
  } catch (e) {
    return false;   // expired, tampered or no SECRET_KEY: every reader treats the request as signed out
  }
}

/** Middleware (index.js, right after sessions.gate): a signed-out request carrying the marker gets the sweep on its page. */
function locals(req, res, next) {
  if (req.cookies && req.cookies[COOKIE] && res.locals && !liveLogin(req)) res.locals.chatSweep = true;
  next();
}

module.exports = { COOKIE, VALUE, MAX_AGE_MS, ACCOUNT_DB_PREFIX, ACCOUNT_DB_RE, UUID_SRC, cookieOptions, mark, liveLogin, locals };
