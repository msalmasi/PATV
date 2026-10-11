// plexhub.js — 📼 the Plex hub at /plex (1.99kp): everything Plex in one findable place.
//
// Before this, /requests existed but nothing pointed at it, and Plex access lived on /subscriptions. The hub shows:
//   * Request a movie or show - the /requests flow (mediarequests.js) and its prices / daily limit / your credits
//   * Your requests and where they are (Overseerr status, refunds)
//   * Your Plex access: linked account, member until when (plexmembers.js), the store items + the monthly subscription
//     (subscriptions.js) - managing it stays on /subscriptions
//   * 📼 Play from Plex on the Go-live page (/stage?mode=plex) and what it costs you (medialib.goLiveInfo)
//   * The members' perks
// Read-only: every action stays on its own page (same checks). Linked from the navbar (More + ☰), the store,
// /subscriptions, Edit profile -> Connections (Plex row) and the footer. Signed-out visitors see the public parts.
"use strict";
const { getQuery } = require("./dbUtils");

async function safe(fn, dflt) { try { return await fn(); } catch (e) { return dflt; } }

async function pageData(user) {
  const MC = require("./mediaconf");
  await MC.init();
  const S = MC.get();
  const me = user && user.userId ? user : null;
  const MR = require("./mediarequests");
  const reqOn = MC.on.requests();
  const requests = {
    on: reqOn, price: { movie: S.request_price_movie, tv: S.request_price_tv }, perDay: S.requests_per_day,
    credits: me ? await safe(() => MR.credits(me.userId), { movie: 0, tv: 0 }) : { movie: 0, tv: 0 },
    mine: me ? (await safe(() => MR.mine(me.userId), [])).slice(0, 8) : [],
  };
  const plex = me ? await safe(() => require("./plexmembers").mine(me.userId), null) : null;
  const sub = me ? await safe(() => require("./subscriptions").plexSub(me.userId), null) : null;
  const invites = [];
  for (const [pid, v] of Object.entries(S.invite_items || {})) {
    const it = (await safe(() => getQuery("SELECT prizeId, prize, cost, status, quantity FROM prizes WHERE prizeId = ?", [pid]), []))[0];
    if (it && it.status === "active") invites.push({ prize_id: pid, title: it.prize, price: it.cost, days: Number(v.days) || 0 });
  }
  invites.sort((a, b) => (a.days || 1e9) - (b.days || 1e9));
  const play = me ? await safe(() => require("./medialib").goLiveInfo(me), null) : null;
  const libOpen = !!S.library_plex && MC.on.library();
  return {
    requests, plex, sub, invites, play, signedIn: !!me,
    library: { open: libOpen, price: S.library_price, freeCap: S.library_free_daily_cap, paidCap: S.library_daily_cap },
    perks: { flair: !!S.plex_flair, sso: !!S.plex_sso, selflink: !!S.plex_selflink },
    invitesOn: MC.on.invites(),
  };
}

function register(app, { addUser }) {
  app.get("/plex", addUser, async (req, res) => {
    try {
      const data = await pageData(req.user && req.user.userId ? req.user : null);
      res.set("Cache-Control", "no-store");
      res.render("plex", { user: req.user ? req.user.username : null, title: req.t ? req.t("plex.title") : "Plex", ...data });
    } catch (e) {
      console.error("[plex] hub:", e);
      res.status(500).send("Couldn't load the Plex page.");
    }
  });
}

module.exports = { register, pageData };
