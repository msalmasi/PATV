// weberrors.js — website-action error codes (1.99ep). THE list on the site side.
//
// Pepe acks every failed website action (pepe_actions row) with a stable code + hint (bot pepe_weberrors.py,
// the same table - keep the two in step; test/weberrors.test.js pins the code list). Pages show the friendly
// message, the hint, and the code in small print for support; an unexpected bot error is E_INTERNAL with an
// incident id (the exception itself stays in Pepe's log).
//
// Old rows (before 1.99ep) have no code: present() infers one from the message with the bot's own patterns,
// and a 1.99ds "something went wrong: <Type>: <reason>" text is shown as the friendly E_INTERNAL line
// instead of the exception name. v2: the PCP / website error catalogue (docs/v2 ARCHITECTURE.md §17.72 #8).
"use strict";

const ERRORS = Object.freeze({
  // who you are / what you may do
  E_NOT_LINKED: ["Your PATV account isn't linked to a Camfrog name yet.", "Link it on your profile (type !verify in any Camfrog room) - website actions run as that name."],
  E_NO_PERMISSION: ["You're not allowed to do that.", "It's limited to the owner, an admin, or a higher level - ask one of them."],
  E_BANNED: ["You're blocked from doing that right now.", "A ban or an ignore is in place - talk to a room admin if you think it's a mistake."],
  // money
  E_INSUFFICIENT_PAT: ["You don't have enough PAT for that.", "Check your balance on your wallet page, then try a smaller amount."],
  // the request itself
  E_BAD_ARGS: ["That request wasn't quite right.", "Check the amounts and names in the form and send it again."],
  E_TARGET_NOT_FOUND: ["Pepe couldn't find what that was about.", "It may have ended or been removed - reload the page and pick it again."],
  E_EXPIRED: ["That has expired.", "Start it again from the page (take a fresh snapshot / preview)."],
  E_ALREADY: ["That's already done or already running.", "Nothing was repeated - reload the page to see where it stands."],
  E_UNSUPPORTED: ["That can't be done from the website.", "Use the chat command in a Camfrog room instead."],
  // timing / state
  E_COOLDOWN: ["You need to wait a bit before doing that again.", "Try again in a few minutes."],
  E_GAME_BUSY: ["Something else is already running there.", "Wait for it to finish, or join it instead."],
  E_ROOM_OFFLINE: ["Pepe isn't in that room right now.", "Try again when Pepe is back in the room, or do it from a room he's in."],
  E_FEATURE_OFF: ["That's switched off right now.", "The room owner or an admin has turned it off."],
  E_RATE_LIMITED: ["You've sent a lot of requests at once.", "Give Pepe a moment to catch up, then try again."],
  E_TIMEOUT: ["Pepe didn't get to it in time - nothing happened.", "Send it again."],
  E_TEMPORARY: ["Pepe couldn't do that just now.", "It's a temporary problem - try again in a minute."],
  E_INTERRUPTED: ["Pepe restarted while doing that.", "Check your balance and the page before trying again, so nothing happens twice."],
  E_UPSTREAM: ["A service Pepe needs didn't answer.", "Any PAT taken for it was refunded - try again later."],
  // the catch-alls
  E_REFUSED: ["Pepe couldn't do that.", "His reply says why - fix that and try again."],
  E_INTERNAL: ["Something went wrong on Pepe's side.", "Check your balance before trying again; give support the incident id if it keeps happening."],
});
const CODES = Object.freeze(Object.keys(ERRORS));

// The bot's classifier (pepe_weberrors._RULES), for rows acked before codes existed. First match wins.
const RULES = [
  ["E_INTERRUPTED", /^interrupted by a restart/],
  ["E_INTERNAL", /^something went wrong/],
  ["E_NOT_LINKED", /link your camfrog name|\bverify\b.*first|isn't linked/],
  ["E_INSUFFICIENT_PAT", /insufficient pat|not enough pat|don't have enough|you have [\d,]+\b|costs? [\d,.]+[km]? pat\b.*\byou have|can't afford|couldn't take the pat/],
  ["E_BANNED", /you're banned|is ignoring your commands|you are banned|you're blocked/],
  ["E_ROOM_OFFLINE", /pepe isn't in (that|this|the)|isn't on in that room|not in that room/],
  ["E_FEATURE_OFF", /switched off|aren't on in this room|turned off|is closed right now|isn't on right now/],
  ["E_EXPIRED", /expired|has closed|no longer (open|running)/],
  ["E_COOLDOWN", /cooldown|cool down|wait \d|slow down|again in \d|too soon/],
  ["E_RATE_LIMITED", /too many|rate limit|a lot this hour/],
  ["E_TIMEOUT", /didn't get to it in time|timed out/],
  ["E_GAME_BUSY", /already (running|open|in progress)|is busy|is already being done|a table is already open|poll is already running/],
  ["E_ALREADY", /^already done|you already|already (have|did|own)/],
  ["E_TEMPORARY", /try again in a minute|hasn't loaded|not ready yet|just now/],
  ["E_UPSTREAM", /couldn't post|couldn't pm|- refunded$|refunded\)?$/],
  ["E_NO_PERMISSION", /^only |admin only|admins only|is for \w+s and up|you can't|not allowed|opted out|you do not own|that's your own/],
  ["E_UNSUPPORTED", /can't be (done|changed) from the site|unknown action|doesn't move pepe|only a new avatar/],
  ["E_TARGET_NOT_FOUND", /^no (market|pool|wager|loan|bounty|item|costume|persona|.* table is open)|there's no|that poll isn't running|not that cam|nobody to tell|that listing|i don't know|you have no|isn't running|not found|no such/],
  ["E_BAD_ARGS", /^usage|^say |^bad |^type |^pick |^give |^tell |which |how much|the minimum|move at least|needs a question|on or off|unknown switch|what's the|the longest|loans start|the stake/],
];

/** The code for a failure message (old rows, or a site-side failure text). Never null. */
function classify(msg) {
  const low = String(msg || "").trim().toLowerCase().replace(/^[^\p{L}\p{N}_]+/u, "");
  if (!low) return "E_REFUSED";
  for (const [code, rx] of RULES) if (rx.test(low)) return code;
  return "E_REFUSED";
}

const LEGACY_EXC = /^\s*something went wrong(\.|:\s*[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)?\b.*)?\s*$/i;
const INCIDENT_RE = /^[0-9a-f]{6,16}$/i;

/**
 * How to show one website-action row ({status, message, code?, hint?, incident?}). -> null while it's waiting
 * or when it succeeded, else {code, message, hint, incident, legacy}. The message is Pepe's own reply when he
 * gave one (most specific), the code's friendly line when he didn't, and never an exception name.
 */
function present(a) {
  if (!a || a.status !== "failed") return null;
  const raw = String(a.message || "").trim();
  const known = a.code && Object.prototype.hasOwnProperty.call(ERRORS, a.code);
  const code = known ? a.code : classify(raw);
  const incident = INCIDENT_RE.test(String(a.incident || "")) ? String(a.incident) : null;
  let message = raw;
  if (code === "E_INTERNAL" && LEGACY_EXC.test(raw)) {
    // old rows: the bare 2026-10-05 webact bug (fixed in bot 1.99ae), and 1.99ds "something went wrong: <Type>:
    // <reason>" - a bug on Pepe's side, shown friendly instead of the exception
    message = /^\s*something went wrong\.?\s*$/i.test(raw) ? "Pepe hit a bug on his side (since fixed) — nothing happened, so just try again."
      : ERRORS.E_INTERNAL[0] + " Check your balance before trying again.";
  }
  if (!message) message = ERRORS[code][0];
  const hint = (known && a.hint ? String(a.hint) : ERRORS[code][1]).slice(0, 300);
  return { code, message: message.slice(0, 400), hint, incident, legacy: !known };
}

module.exports = { ERRORS, CODES, RULES, classify, present };
