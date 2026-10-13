// actorcap.js — 1.99wv (connections audit, work package C): does the running Pepe act for a PATV ACCOUNT?
//
// Every website action (actions.js) and every relay job (bridge-relay.js) now carries the account as its actor
// ({userId, username, display, login}). A Pepe that understands it (camfrog-bot 1.99wt, pepe_acctactor.py) says so on
// each claim / sync (`actor_cap: 1`); for an account with no chat login he then acts as "u:<userId>" (charged from the
// account, shown as "🌐 <name>", records re-keyed when it links a chat login later).
//
// Backward compatibility: the site offers the account-only paths (relay lines, the Pepe menu, DJ requests, casino seats,
// donate, market create, cosmetics) to an account with no chat login ONLY while a capable Pepe has been heard from in the
// last CAP_TTL_MS. An older Pepe never says it, so the site keeps refusing those the way it always did (and an older
// site never sends an actor: the new Pepe then refuses unlinked actions as before).
"use strict";

const CAP_TTL_MS = 10 * 60 * 1000;
let seenAt = 0;
let clock = () => Date.now();

/** A claim / sync body from Pepe: remember whether he can act for an account. */
function note(body) {
  if (body && (body.actor_cap === 1 || body.actor_cap === true || body.actor_cap === "1")) seenAt = clock();
}
/** true while a Pepe that acts for accounts was heard from recently. */
function on() { return seenAt > 0 && clock() - seenAt < CAP_TTL_MS; }

/** The actor block sent to Pepe with an action / relay job. `u` = {userId, username, camfrogUsername}; `display` optional. */
function actorOf(u, display) {
  if (!u || !u.userId) return null;
  return { userId: String(u.userId), username: u.username || null, login: u.camfrogUsername || u.camfrog || null,
           display: display ? String(display).slice(0, 40) : null };
}

module.exports = { note, on, actorOf, CAP_TTL_MS, _set: (t) => { seenAt = t; }, _setClock: (f) => { clock = f; } };
