// accountkey.js — 1.99wr (connections audit, work package A): the names an ACCOUNT goes by in records that were keyed by
// a Camfrog login. The site's escrow games (wagers, pools, bounties, P2P loans), the Federal Reserve and the market
// positions take the PATV account when it has no chat login linked: they store its username (and userId) and match
// actors by login OR username (escrow/games.isWho). A page that lists "mine" has to use the same name - but a bare
// username could also be SOMEONE ELSE's Camfrog login, so it only stands for this account while no other account has
// it linked as a chat login (otherwise the page shows nothing rather than another person's records).
"use strict";
const { getQuery } = require("./dbUtils");

const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** The record key of an account: its linked chat login, else "u:<userId>" (loginrekey.js / gangs.js convention). */
function keyOf(login, userId) {
  return low(login) || (userId ? `u:${userId}` : "");
}

/** true when no OTHER account has `name` as its linked chat login. */
async function ownsName(name, userId) {
  if (!name) return false;
  const r = await getQuery("SELECT 1 FROM users WHERE LOWER(camfrogUsername) = LOWER(?) AND userId != ? LIMIT 1", [name, String(userId || "")])
    .catch(() => [{}]);                     // can't tell: never claim the name
  return !r.length;
}

/**
 * The lowercased name this account plays under in the site-run games: its chat login when linked, else its PATV username
 * (only when no other account has that as a chat login), else null. `u` = {userId, username, camfrogUsername}.
 */
async function gameName(u) {
  if (!u) return null;
  if (u.camfrogUsername) return low(u.camfrogUsername);
  return (await ownsName(u.username, u.userId)) ? low(u.username) : null;
}

module.exports = { keyOf, ownsName, gameName, low };
