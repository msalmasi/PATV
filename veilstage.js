// veilstage.js - wave 2: WP-4's mic-stage covers wired to WP-2's privacy wire v2 (incognito / mic-stage spec F.4 covers, E.1 / E.2 /
// E.6 see-through + the owner's J-18 toggle, C.2 frog-name sessions, A.6 "Mic stage tile"; G:/ops/incognito-micstage-design-2026-10-27.md).
//
// micfollow.js (WP-4) shows a veiled mic holder as a hooded-frog COVER tile only through two seams, and until something plugs into
// them nothing changes (v1 has no covers at all - the neutral card, as today):
//   setVeilSource(fn)      fn(u, R) -> the per-hold facts of an R.mic entry {veil, alias, hood, since, proven, sess, began_named,
//                          login, display}. Here: WP-2's veiled R.mic entries (veil.snapshotEntries / nameSnapshot) - page-safe
//                          veil / alias / hood on the entry, the identity on its non-enumerable _vz {login, display, proven, since,
//                          beganNamed, sess}. Only while the privacy wire v2 is ON, and only while that frog-name session is still
//                          the person's OPEN one (frognames.current) - an ended session's stale entry is no cover (the neutral card
//                          until the next snapshot sights them again). Never someone LEFT OUT (leftOut: forget-me, an account
//                          deletion, a staff removal - the people list leaves them out too); a cover already up for them comes off
//                          at once (micfollow.coverLeftOut). micfollow keeps only proven && !began_named && a valid sess.
//                          The hood is the session's own (frognames), the same index the chat bubble draws (chatlog-core hoodOf ->
//                          veil.css .hd0-7 / hood-*-N.svg), so one person shows one hood colour in the chat and on the stage.
//   setRevealSource(...)   available() = the privacy wire v2 is on; role(user, padId) = "admin" (chatlog.see_through - Admin, locked
//                          "privacy": never Staff, J-2) | "owner" (the pad's owner NOW - rooms_registry's current owner: the stage is
//                          live, so this is not seethrough.chatRole's owner-era rule for past lines nor roomstats' 90-day board rule;
//                          a new owner gets the stage Reveal at once, a former owner loses it at once) | null.
// The Reveal itself is POST /api/chatlog/reveal {room, tile} (seethrough.js: the same refusals as a line reveal, one seethrough_log
// row scope stage_line - or, while the viewer's J-18 toggle is on, counted on that toggle's row: ONE toggle per pad for lines AND
// tiles, scope chat_toggle). A ✕ on a cover (micfollow.excludeCover) writes scope stage_exclude.
// Un-veil linkability (follow-up): frognames.onEnd -> micfollow.coverSessionEnded - the cover of a session that ends (off, a named
// sighting, A-privacy-5's incognito -> hidden switch, forget-me, its clock) comes off at once, never lingering as a "recent" tile.
"use strict";

let wired = false;
const PW = () => require("./privwire");
const FN = () => require("./frognames");

/** wave2 integrate, review fix XT-1: is this person LEFT OUT now for a reason no frog name may carry - chatlogview's HARD_OUT (forget-me,
 *  an account deletion, a staff removal), the same rule chatlogview.roster leaves a veiled entry out of the people list by (never a
 *  "someone" entry that says they are there) and a chat Reveal of their lines is refused by (bridge.revealLookup)? A !bridge hide alone
 *  is not (that person is masked: a shadow cover). Their login's hash and the priv block's h (Pepe's, when given) are both asked.
 *  Fails closed: while the hidden set loads, or when it can't be asked, everyone is (no cover, no tile Reveal). */
function leftOut(login, h) {
  try {
    const CV = require("./chatlogview");
    const hs = [...new Set([login ? CV.hashOf(login) : null, typeof h === "string" && h ? h : null].filter(Boolean))];
    if (!hs.length) return true;
    return hs.some((x) => CV.kindNow(x) === "out" && !CV.maskable(x));
  } catch (e) { return true; }
}

/** WP-2's facts for an R.mic entry `u` of bridge room R -> {veil, alias, hood, since, proven, sess, began_named, login, display} | null. */
function veilSource(u, R) {
  try { if (!PW().isOn()) return null; } catch (e) { return null; }
  if (!u || u.anon !== true || (u.veil !== "incognito" && u.veil !== "hidden") || !R || !R.id) return null;
  const vz = u._vz;
  if (!vz || typeof vz.login !== "string" || !vz.login || vz.sess == null) return null;
  let cur = null;
  try { cur = FN().current(R.id, vz.login); } catch (e) { cur = null; }
  if (!cur || cur.session == null || String(cur.session) !== String(vz.sess)) return null;   // (ended / replaced: no cover)
  // review fix XT-1: left out (forget-me, an account deletion, a staff removal) -> no cover, as the people list leaves them out; one
  // up now comes off at once (after this step: never from inside micfollow's holder scan)
  if (leftOut(vz.login, vz.h)) {
    const roomId = R.id, sess = vz.sess;
    queueMicrotask(() => { try { require("./micfollow").coverLeftOut(roomId, sess); } catch (e) { /* no mic follows */ } });
    return null;
  }
  const hood = Number(u.hood);
  return { veil: u.veil, alias: typeof u.alias === "string" && u.alias ? u.alias : null,
           hood: typeof u.alias === "string" && u.alias && Number.isInteger(hood) && hood >= 0 && hood <= 7 ? hood : null,
           since: Number.isFinite(vz.since) ? vz.since : undefined, proven: vz.proven === true, sess: String(vz.sess),
           began_named: vz.beganNamed === true, login: vz.login, display: vz.display ? String(vz.display) : vz.login };
}

/** The live-stage see-through role of `user` ({userId}) on pad `padId`: "admin" | "owner" | null (a check that can't run: null). */
async function stageRole(user, padId) {
  if (!user || !user.userId || !padId) return null;
  try { if (await require("./siteperms").canId(user.userId, "chatlog.see_through")) return "admin"; } catch (e) { return null; }
  try {
    const R = require("./rooms");
    const pad = (R.getCached && R.getCached(padId)) || (R.get ? await R.get(padId) : null);
    return pad && pad.owner && pad.owner.userId != null && String(pad.owner.userId) === String(user.userId) ? "owner" : null;
  } catch (e) { return null; }
}

/** frognames: a session ended -> its cover (if one is up) comes off now. */
function sessionEnded(ev) {
  try { if (ev && ev.roomId) require("./micfollow").coverSessionEnded(ev.roomId, ev.session); } catch (e) { /* no mic follows */ }
}

/** Plug WP-2 into micfollow's seams (bridge.register, after micfollow.register). Idempotent. */
function wire() {
  const MF = require("./micfollow");
  MF.setVeilSource(veilSource);
  MF.setRevealSource({ available: () => { try { return PW().isOn() === true; } catch (e) { return false; } }, role: stageRole });
  if (!wired) { FN().onEnd(sessionEnded); wired = true; }
}

module.exports = { veilSource, leftOut, stageRole, sessionEnded, wire };
