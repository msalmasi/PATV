// legacypokernow.js - 2026-10-11: the kill flag on the LEGACY PokerNow games list (POST /api/pokernow/add), the same
// pattern as legacybj.js. The PokerNow selfbot that called it is stopped on prod, and the route took requests with no
// auth at all - anyone could fill the games list (/poker, Pepe's !poker). It never touched PAT.
// OFF by default: 410 Gone unless LEGACY_POKERNOW=1 is in .env.
"use strict";

function enabled(env = process.env) {
  return String(env.LEGACY_POKERNOW || "").trim() === "1";
}

/** -> null when the request may go on, else {status, body} to answer with */
function gate(env = process.env) {
  if (!enabled(env)) {
    return { status: 410, body: { error: "PokerNow games are retired - play Hold'em on publicaccess.tv/casino." } };
  }
  return null;
}

module.exports = { enabled, gate };
