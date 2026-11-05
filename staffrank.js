// staffrank.js - rankrule (the owner, 2026-11-05, on the admin actions that didn't check rank on the server: "Rank rule - refuse
// actions on equal or higher-ranked staff."): ONE rank rule for every per-account staff sanction on the website, said in the same
// words everywhere (locales/en.json staffrank.refused / staffrank.self).
//
//   the ladder   siteperms-core.js classRank - Assistant 1 < Staff 2 < Admin 3 (every other class 0) - plus the site's OWNER above
//                everyone: an Admin-class account whose linked Camfrog login holds Pepe's "owner" role on the site's pinned owner list
//                (pepe_roles - staffroles.ownerHolds's rule), rank 4. Both rows are read FRESH (a session's class can be stale).
//   the rule     a target whose rank is > 0 and >= the actor's is refused (padbans.rankRefusal's rule, which now calls this): PATV
//                staff only by someone of a HIGHER rank; a member (rank 0) by anyone the route itself lets act. Nobody is above the
//                owner, so one owner can't sanction another.
//   self         yourself - your own account, or your own alt (another account with the same linked Camfrog login) - is refused
//                too ("That's you."), for sanctions AND for lifts (you never lift your own ban).
//   lifts        (decision, documented in the rankrule notes) a LIFT (unban, unblock, reinstate, cancel, put back up) is never
//                refused for rank: it gives the person back what they had, and a pad owner or staff must still be able to undo a ban
//                made before this rule. RANK_ON_LIFTS = true applies the same ladder to lifts, in this one place.
//   not here     Pepe (bot-token routes keep Pepe's own ladder), a frog name's (veil) ban (that answer would say who it is), the
//                class picker / roles (staffroles.js has its own, stricter ladder), comps and gifts (not sanctions).
"use strict";
const { getQuery } = require("./dbUtils");
const core = require("./siteperms-core");
const EN = require("./locales/en.json");

const OWNER_RANK = 4;
const RANK_ON_LIFTS = false;
const KEYS = Object.freeze({ rank: "staffrank.refused", self: "staffrank.self" });
const TEXT = Object.freeze({ rank: EN[KEYS.rank], self: EN[KEYS.self] });
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** The refusal (a route's fail() sends status + message; msg() says it in the viewer's language). */
class StaffRankError extends Error {
  constructor(why) {
    super(TEXT[why] || TEXT.rank);
    this.status = why === "self" ? 400 : 403;
    this.code = why === "self" ? "self" : "staff_rank";
    this.kind = why;
    this.i18n = KEYS[why] || KEYS.rank;
    this.refuse = true;
  }
}

/** A users row, fresh: x = an account id, or an object with .userId. -> {userId, username, class, camfrogUsername} | null */
async function rowOf(x) {
  const id = x != null && typeof x === "object" ? x.userId : x;
  if (id == null || id === "") return null;
  return (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(id)]).catch(() => []))[0] || null;
}

/** Is this users row the site's owner (the Admin class + a linked login with Pepe's owner role)? A roles read that fails: no. */
async function isOwner(row) {
  if (!row || core.classRank(row) !== 3 || !low(row.camfrogUsername)) return false;
  try { return (await require("./staffroles").roleOf(row.camfrogUsername)) === "owner"; } catch (e) { return false; }
}
/** A users row -> 0 (no staff class) .. 3 (Admin), 4 (the owner). */
async function rankOf(row) {
  const r = core.classRank(row);
  return r === 3 && (await isOwner(row)) ? OWNER_RANK : r;
}

/** Yourself: the same account, or the same linked Camfrog login (your own alt - padbans' "That's you." rule). */
function isSelf(me, them) {
  if (!me || !them) return false;
  if (String(me.userId) === String(them.userId)) return true;
  return !!low(me.camfrogUsername) && low(me.camfrogUsername) === low(them.camfrogUsername);
}

/**
 * The rule on two users rows (read by the caller): -> null (go on) | "self" | "rank". me null = an actor without an account (rank 0).
 * them null -> null (the route answers its own "no such account"). opts.lift: a lift (no rank check unless RANK_ON_LIFTS);
 * opts.self false: leave the self check to the route (it has its own words for it).
 */
async function decide(me, them, { lift = false, self = true } = {}) {
  if (!them) return null;
  if (self && isSelf(me, them)) return "self";
  if (lift && !RANK_ON_LIFTS) return null;
  const theirs = await rankOf(them);
  if (!theirs) return null;
  const mine = me ? await rankOf(me) : 0;
  return theirs >= mine ? "rank" : null;
}
/** decide() with both rows read fresh. actor = req.user / a users row (its userId is what counts); target = an id or {userId}. */
async function check(actor, target, opts = {}) {
  const them = await rowOf(target);
  if (!them) return null;
  return decide(await rowOf(actor), them, opts);
}
/** check(), throwing StaffRankError. */
async function assert(actor, target, opts = {}) {
  const why = await check(actor, target, opts);
  if (why) throw new StaffRankError(why);
}

/** The words for a refusal in the request's language (req.t; English without one). e = a StaffRankError or "rank" / "self". */
function text(req, e) {
  const key = typeof e === "string" ? KEYS[e] : e && e.i18n;
  if (!key) return e && e.message ? e.message : TEXT.rank;
  try { if (req && typeof req.t === "function") return req.t(key); } catch (x) { /* English */ }
  return typeof e === "string" ? TEXT[e] : e.message;
}
/** For a route's fail(res, e): the error's message, said in the viewer's language when it is a rank / self refusal. */
function msg(res, e) {
  if (!(e instanceof StaffRankError)) return e && e.message;
  return text(res && res.req, e);
}
/** Send a refusal from a route: -> the response. */
function send(req, res, why) {
  const e = new StaffRankError(why);
  return res.status(e.status).json({ ok: false, error: text(req, e), code: e.code });
}

module.exports = { rowOf, rankOf, isOwner, isSelf, decide, check, assert, text, msg, send, StaffRankError, KEYS, TEXT, OWNER_RANK, RANK_ON_LIFTS };
