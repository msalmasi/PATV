// textguard.js — the short-text guard (1.99up): one list of what a line Pepe says or shows on an owner's behalf may not
// contain - slurs, sexual content about minors, threats, PAT scams, fake staff announcements, phone numbers and street
// addresses (doxxing). Was soundboards.js's clip text guard (room boards); the owner panel's room topic uses it too, and
// Pepe keeps the same list (camfrog-bot pepe_roomowner.TOPIC_BAD) for the chat path. Pepe's own LLM guard still runs
// where he renders text.
"use strict";

const BAD_TEXT = Object.freeze([/\bn[i1]gg/i, /\bf[a@]gg?[o0]t/i, /\bk[i1]ke\b/i, /\bch[i1]nk\b/i, /\btr[a@]nn(y|ie)/i, /\bretard/i, /\brape/i,
  /\bchild\s*porn/i, /\bcp\b/i, /\bloli\b/i, /\bkill\s+(your|ur)self\b/i, /\bkys\b/i, /\bi('?ll| will)\s+kill\b/i,
  /\bsend\s+(me\s+)?(your\s+)?(pat|points)\b/i, /\b(staff|admin|mod)\s+(here|speaking)\b/i, /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/,
  /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr)\b/i]);

/** true when the text trips the guard */
function bad(text) {
  const s = String(text == null ? "" : text);
  return BAD_TEXT.some((rx) => rx.test(s));
}

// A pad verification code (padconnect.js: PATV-XXXXXX) - in a Camfrog room's topic it is the room owner's proof, so nothing
// the site or Pepe writes into a topic may carry one. Looser than the code format on purpose (any separator, full-width
// letters, invisible format characters): anything that could read as a code is refused.
const CODEISH = /PATV[\s\-_.:/]*[A-Z0-9]{6}/;
function hasPadCode(text) {
  const s = String(text == null ? "" : text).normalize("NFKC").replace(/\p{Cf}/gu, "").toUpperCase();
  return CODEISH.test(s);
}

module.exports = { BAD_TEXT, bad, hasPadCode };
