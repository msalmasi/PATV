// stepup.js — the owner's password step-up on the website actions that move PAT or change who owns Pepe (owner answers
// 2026-10-20, (3)): the PAT grant (POST /api/admin/transfer/:username), the House adjust (POST /api/g/wheel/jackpot) and a
// direct owner grant / removal on /admin/roles (POST /api/admin/roles/role). The same throttled step-up as the
// /admin/economy edit (econstore.stepUp):
//   * a same-origin fetch: X-Requested-With: fetch AND an Origin / Referer naming this host (a request with neither is refused)
//   * a single-use nonce (pepecontrol.issueNonce / takeNonce): POST /api/admin/stepup/nonce {for: grant|house} here, or
//     /api/admin/roles/nonce on /admin/roles - only a Pepe owner gets one
//   * the account's own password; 5 wrong in 15 minutes per account -> 429 until the window ends (shared with every other
//     step-up: the economy edit, the payout recipe and staking cards, the owner-change confirm)
// Refusals: 403 cross_site / owner_only / password / no_password, 409 nonce, 429 too_many (Error with .status, .code, .refuse).
"use strict";

const CROSS = "Security check failed - reload the page.";
const fail = (status, code, message) => Object.assign(new Error(message), { status, code, refuse: true });

/** What each step-up guards: the capability the owner check uses (staffroles.ownerOf). */
const PURPOSES = { grant: "econ.grant_pat", house: "econ.house_adjust" };

/** Throws unless the request is a same-origin fetch. */
function sameOrigin(req) {
  if (!require("./middleware/authGuard").sameOriginFetch(req)) throw fail(403, "cross_site", CROSS);
}

/** The whole step-up for one request: same origin, then the nonce + password (econstore.stepUp: the nonce is spent on the
 *  first try, whatever happens next). `user` needs userId + username (the nonce is bound to the username). */
async function check(req, user, body) {
  sameOrigin(req);
  try {
    await require("./econstore").stepUp(user, body || {});
  } catch (e) {
    if (e && e.status) throw fail(e.status, e.code || "refused", e.message);
    throw e;
  }
}

/** POST /api/admin/stepup/nonce {for: grant|house} (after addUser): a single-use nonce for a Pepe owner of that action. */
async function nonceRoute(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    sameOrigin(req);
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    const cap = PURPOSES[String((req.body || {}).for || "")];
    if (!cap) return res.status(400).json({ ok: false, code: "bad_request", error: "Which action?" });
    const SR = require("./staffroles");
    const me = await SR.ownerOf(req.user, cap);
    if (!me) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    res.json({ ok: true, nonce: require("./pepecontrol").issueNonce(me) });
  } catch (e) {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[stepup] nonce:", e && e.message);
    res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." });
  }
}

module.exports = { check, sameOrigin, nonceRoute, PURPOSES, fail };
