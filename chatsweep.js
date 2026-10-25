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
//     rename, an account deletion, and sessions.gate seeing a revoked / expired / unknown session - also sets the marker
//     cookie `patv_chat_sweep` (mark());
//   * the next signed-out page that uses layout.ejs (the one the sign-out lands on: `/` after Sign out, `/login` after the
//     others) carries a small static inline script, views/partials/chat-sweep.ejs (locals() below puts `chatSweep` on the
//     page): it deletes every `patv-chat:<uuid>` database (indexedDB.databases(), the widget's own sweep rule), then the
//     marker. A browser without databases() (Firefox before 126) deletes the one database the marker names. A delete that
//     fails or never finishes keeps the marker, so the next signed-out page tries again.
//
// Not Clear-Site-Data: it can't name databases. "storage" would also clear local storage (drafts and preferences), the
// widget's device database `patv-device` (the device id, which survives every wipe by design) and the notifications
// service worker. The device database is never touched here.
//
// The marker is not HttpOnly (the page's script deletes it) and holds no secret: "1", or the signed-out account's hub account
// id (chatticket.subjectOf - the same id the database's name carries in this browser) for the fallback. It is sent only to
// this site and never logged. A signed-in page never carries the script (it would delete the signed-in account's database
// too; the widget's own sign-in sweep covers that case). An account switch without a sign-out is the widget's (its sign-in
// sweeps every other account's database). No switch: the script finds nothing to delete where the widget never ran, and a
// switch left off would keep exactly the data this is for, after a CHAT_HUB rollback too.
"use strict";

const COOKIE = "patv_chat_sweep";
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;   // as long as a login lasts (loginCookie LOGIN_DAYS): until the next signed-out page
// The platform's rule (account.ts ACCOUNT_DB_PREFIX + UUID_RE, accountDbName): the account databases only - never patv-device,
// never another name under the prefix.
const ACCOUNT_DB_PREFIX = "patv-chat:";
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACCOUNT_DB_RE = new RegExp("^" + ACCOUNT_DB_PREFIX + UUID_SRC + "$");
const SUBJECT_RE = new RegExp("^" + UUID_SRC + "$");

function cookieOptions() {
  return { httpOnly: false, secure: true, sameSite: "Lax", path: "/", maxAge: MAX_AGE_MS };
}

/** The account a response signs out: the caller's, else the request's live session or user. */
function signedOutUser(res, userId) {
  if (userId != null && userId !== "") return userId;
  const req = res && res.req;
  if (req && req.loginSession && req.loginSession.userId) return req.loginSession.userId;
  if (req && req.user && req.user.userId) return req.user.userId;
  return null;
}

/** The marker's value: the account's hub account id when it has one, else "1". Never throws. */
function valueFor(userId) {
  if (userId == null || userId === "") return "1";
  try {
    const s = require("./chatticket").subjectOf(userId);
    return typeof s === "string" && SUBJECT_RE.test(s) ? s : "1";
  } catch (e) {
    return "1";
  }
}

/** loginCookie.clearLogin: the next signed-out page deletes this browser's chat databases. */
function mark(res, userId) {
  if (!res || typeof res.cookie !== "function") return;
  try {
    res.cookie(COOKIE, valueFor(signedOutUser(res, userId)), cookieOptions());
    if (res.locals) res.locals.chatSweep = true;
  } catch (e) {
    console.error("[chatsweep] mark failed:", e.message);
  }
}

/** Middleware (index.js, after sessions.gate): a request carrying the marker gets the sweep on its page (layout.ejs, signed out). */
function locals(req, res, next) {
  if (req.cookies && req.cookies[COOKIE] && res.locals) res.locals.chatSweep = true;
  next();
}

module.exports = { COOKIE, MAX_AGE_MS, ACCOUNT_DB_PREFIX, ACCOUNT_DB_RE, SUBJECT_RE, UUID_SRC, cookieOptions, valueFor, mark, locals };
