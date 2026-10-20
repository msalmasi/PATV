// verified.js — 1.99ws (connections audit, work package B): ONE answer to "has this account proven an identity?"
//
// Several trust gates used to ask "is a Camfrog name linked?" (a few also took Discord / Twitch). The user's rule
// (2026-10-13): a PATV account isn't tied to Camfrog, so any PROVEN identity counts - each one is something a
// throwaway account doesn't get for free, and each can be linked to ONE PATV account only (so one identity can't
// vouch for a pile of sock puppets):
//
//   camfrog   users.camfrogUsername  - !verify in a room with Pepe (the login typed the one-time code); unique per account
//   discord   users.discordId        - Discord OAuth
//   twitch    users.twitchId         - Twitch OAuth
//   telegram  telegram_links         - "/start <code>" sent from the user's own Telegram (Telegram vouches for the sender
//                                      id; a phone number behind it); tg_id UNIQUE
//   google    sso_links (google)     - Sign in with Google (OIDC `sub`, link_source 'self'); (provider, subject) unique
//   apple     sso_links (apple)      - Sign in with Apple (Apple's `sub`, link_source 'self'; an Apple Account has two-factor
//                                      sign-in on a real device); (provider, subject) unique
//   plex      plex_members           - a Plex account linked by a trusted source (plexsso.TRUSTED: self / admin / wizarr
//                                      / overseerr); plex_id is the key, so one Plex account -> one PATV account
//
//   email     users.isEmailVerified - 1.99wy (the user, 2026-10-13): a VERIFIED email address counts too, "just as trivial
//             to create as Discord / Google / Plex or Camfrog". The address has to be a real one (an "@") the account
//             confirmed (the emailed link, or a provider that reports it verified); users.email is unique per account.
//
// NOT counted: an unconfirmed email address, and site level / account age, which stay each gate's own separate fallback
// ("verified OR level >= N").
//
// What each gate protects against (all keep that protection - every proof above costs at least what a Discord or
// Twitch account did, and those already counted):
//   feed media uploads + DM pictures (feedstore.postRefusal media, dmmedia.pictureRefusal): illegal / abusive uploads
//       and storage abuse from throwaway accounts - verified OR level >= media_min_level
//   stage snaps / clips (stagecap.eligibility): harassment clips of streamers from throwaways - verified OR level
//   downvotes (feedstore.downCounts): brigading with sock puppets - a downvote counts when verified OR level
//   "new account" limits (feedstore.isNewAccount: posts / comments / reports per hour): spam - a verified account is
//       never "new"
//   require_link_to_post (feed config) and a pad's "who can post: linked accounts" (feedstore room settings): an
//       admin's / owner's choice of "proven accounts only"
//   pad create with create_link "any" (padcreate.eligibility): pad spam and slug squatting
//   web chat relay from an account with no chat login (bridge-relay.js, work package C): a relayed line carries the
//       PATV username into a live room, so the sender has to be a proven account
// create_link "camfrog" stays an explicit admin choice (Camfrog only).
//
// Use: an account row from feedstore.account / stagecap.account / padcreate.account comes with `proofs` attached
// (attach()); isVerified(u) is then synchronous. A bare row (no attach) is judged by its columns only - never MORE
// trusting than the full answer.
"use strict";
const { getQuery } = require("./dbUtils");

const COLUMN_PROOFS = [["camfrog", "camfrogUsername"], ["discord", "discordId"], ["twitch", "twitchId"]];
const CACHE_MS = 60 * 1000;
const cache = new Map();          // userId -> {at, list}  (the table proofs only)

// 1.99wy: a confirmed email address on the row (isEmailVerified + an address with "@"); a row without both columns gets it
// from the table proof below
const emailProof = (u) => !!u && Number(u.isEmailVerified) === 1 && String(u.email || "").includes("@");
function columnProofs(u) {
  const out = [];
  if (!u) return out;
  for (const [name, col] of COLUMN_PROOFS) if (u[col]) out.push(name);
  if (emailProof(u)) out.push("email");
  return out;
}

async function rows(sql, args) {
  try { return await getQuery(sql, args); } catch (e) { return []; }     // a table this site doesn't have yet
}

/** The proofs kept in their own tables (telegram / google / plex) for one account. Cached CACHE_MS. */
async function tableProofs(userId, { fresh = false } = {}) {
  const id = String(userId || "");
  if (!id) return [];
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list = [];
  if ((await rows("SELECT 1 FROM users WHERE userId = ? AND isEmailVerified = 1 AND email LIKE '%@%' LIMIT 1", [id])).length) list.push("email");
  if ((await rows("SELECT 1 FROM telegram_links WHERE user_id = ? LIMIT 1", [id])).length) list.push("telegram");
  if ((await rows("SELECT 1 FROM sso_links WHERE provider = 'google' AND user_id = ? AND link_source = 'self' LIMIT 1", [id])).length) list.push("google");
  if ((await rows("SELECT 1 FROM sso_links WHERE provider = 'apple' AND user_id = ? AND link_source = 'self' LIMIT 1", [id])).length) list.push("apple");
  let trusted = ["self", "admin", "wizarr", "overseerr"];
  try { trusted = require("./plexsso").TRUSTED || trusted; } catch (e) { /* keep the copy */ }
  if ((await rows(`SELECT 1 FROM plex_members WHERE user_id = ? AND link_source IN (${trusted.map(() => "?").join(",")}) LIMIT 1`,
    [id, ...trusted])).length) list.push("plex");
  cache.set(id, { at: Date.now(), list });
  if (cache.size > 5000) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return list;
}

/** S1 Q5b: tableProofs for many accounts at once, uncached (the chat hub's looks: userlook.buildLooks reads them when it
 *  posts). The same proofs as tableProofs. -> Map(userId -> [proof]) (every id present, [] when none) */
async function tableProofsMany(userIds) {
  const ids = [...new Set([...(userIds || [])].filter(Boolean).map(String))];
  const out = new Map(ids.map((id) => [id, []]));
  let trusted = ["self", "admin", "wizarr", "overseerr"];
  try { trusted = require("./plexsso").TRUSTED || trusted; } catch (e) { /* keep the copy */ }
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const qs = part.map(() => "?").join(",");
    const add = (rows, key, proof) => { for (const r of rows) { const l = out.get(String(r[key])); if (l && !l.includes(proof)) l.push(proof); } };
    add(await rows(`SELECT userId FROM users WHERE userId IN (${qs}) AND isEmailVerified = 1 AND email LIKE '%@%'`, part), "userId", "email");
    add(await rows(`SELECT user_id FROM telegram_links WHERE user_id IN (${qs})`, part), "user_id", "telegram");
    add(await rows(`SELECT user_id FROM sso_links WHERE provider = 'google' AND link_source = 'self' AND user_id IN (${qs})`, part), "user_id", "google");
    add(await rows(`SELECT user_id FROM plex_members WHERE user_id IN (${qs}) AND link_source IN (${trusted.map(() => "?").join(",")})`,
      [...part, ...trusted]), "user_id", "plex");
  }
  return out;
}

/** Attach `proofs` (every proven identity) to an account row and return it. Needs u.userId. */
async function attach(u, opts) {
  if (!u) return u;
  const list = [...new Set(columnProofs(u).concat(await tableProofs(u.userId, opts)))];
  Object.defineProperty(u, "proofs", { value: list, enumerable: false, configurable: true, writable: true });
  return u;
}

/** Synchronous: any proven identity on this row (attached proofs + its own columns). */
function isVerified(u) {
  if (!u) return false;
  if (columnProofs(u).length) return true;
  return Array.isArray(u.proofs) && u.proofs.length > 0;
}

/** Async: attach (if needed) and answer. */
async function verify(u) {
  if (!u) return false;
  if (!Array.isArray(u.proofs)) await attach(u);
  return isVerified(u);
}

/** Forget an account's cached table proofs (after a link / unlink). */
function forget(userId) { cache.delete(String(userId || "")); }

// The refusal copy every converted gate uses for "link something first".
const LINK_HINT = "verify your email address, or link an account in Settings → Account → Connections (a chat account - for Camfrog, type !verify in a room with Pepe - or Discord, Twitch, Telegram, Google, Apple or Plex)";

module.exports = { isVerified, verify, attach, tableProofs, tableProofsMany, columnProofs, forget, LINK_HINT, _cache: cache };
