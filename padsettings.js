// padsettings.js — ONE settings hub per pad (1.99dc): /p/<slug>/settings, for the pad's owner and site staff.
// Before this a pad's settings were split over /p/<slug>/manage (stage, page, bridge, royalties), /p/<slug>/mod
// (feed reports, approval, bans, Pepe's feed settings) and the pad page's live Manage panel, and "is Pepe on my
// feed?" wasn't findable. The hub has one section per job; the page draws all of them and the tabs (public/js/
// pad-settings.js) show one at a time (no JS: all, in order):
//   General      title, description, the look (1.99es: avatar, banner upload, accent - padlook.js), the platform badge (read-only), royalties
//   Stage        who's on now, bookings, slots / prices / approval, stage bans, stage events
//   Feed         who can post, the approval switch, posts per day, approved posters, Camfrog announcements
//   Pepe         "Pepe on this pad's feed" (the pad's master switch), answering / taking part / limits / vision,
//                and the automod (feedautomod.js)
//   Rules        the pad's own rules (padrules.js), or Padiquette when it has none
//   Moderation   approval queue, reports, Pepe's automod calls (reversible), pins, feed bans, the audit log
//   Camfrog room the live Manage panel (padmod.js / room-mod.js: kick, ban, topic ... as your Camfrog login, run by
//                Pepe) and the website-bridge switches - Camfrog-backed pads only
// Old addresses redirect here (pads.js): /p/<s>/manage -> ?tab=stage, /p/<s>/mod -> ?tab=moderation; the old
// in-page anchors (#royalties, #pepe, #announce, #settings, #queue, #reports, #members, #bans, #audit) exist on this
// page, and the browser carries the fragment through a redirect, so old links land on the right card.
// Every write still goes to its existing endpoint (same checks): nothing here grants anything new.
"use strict";
const { getQuery } = require("./dbUtils");
const rooms = require("./rooms");
const store = require("./feedstore");

const TABS = Object.freeze(["general", "stage", "feed", "pepe", "rules", "moderation", "camfrog"]);

async function pins(roomId) {
  const rows = await getQuery(`SELECT p.id, p.title, p.body, pr.pinned_at, pr.pinned_by FROM feed_post_rooms pr JOIN feed_posts p ON p.id = pr.post_id
                   WHERE pr.room_id = ? AND pr.pinned_at IS NOT NULL AND pr.removed_at IS NULL AND p.deleted_at IS NULL ORDER BY pr.pinned_at DESC`, [roomId]);
  for (const r of rows) r.url = await store.postLink(r.id);     // 1.99dv: the post's canonical address
  return rows;
}

/** Everything the hub shows for one pad (the viewer may manage it). */
async function hubData(R, viewer, app) {
  const web = require("./roomsweb");
  const stage = require("./mainstage");
  const royalties = require("./royalties");
  const PF = require("./pepefeed");
  const AM = require("./feedautomod");
  const padrules = require("./padrules");
  await store.init();
  let B = null;
  try { B = require("./bridge")._rooms.get(R.id) || null; } catch (e) { B = null; }
  const platform = rooms.platformOf(R.id);
  const camfrog = platform === "camfrog";
  const reports = await store.roomReports(R.id);
  const pending = await store.roomPending(R.id, viewer);
  const automod = await AM.list(R.id, 60);
  return {
    room: R, slug: web.linkSlug(R), platform, camfrog,
    staff: rooms.isStaff(viewer), admin: !!viewer && viewer.class === "Admin",
    // stage + page + royalties (was /manage)
    st: await stage.ownerState(R.id), C: stage.config(), roy: R.owner ? await royalties.status(R.id, R.owner.userId) : null,
    bridge: B ? { live: Date.now() - B.updated < 90000, relay: !!B.relay, mic: !!B.micRelay, cams: !!B.cams, audio: !!B.audio, transcripts: B.transcripts !== false } : null,
    analytics: app ? rooms.hasRoute(app, "/p/:slug/analytics") : false,
    stageEvents: await getQuery("SELECT ts, what, actor, detail FROM room_events WHERE room_id = ? AND what NOT LIKE 'feed-%' ORDER BY ts DESC LIMIT 20", [R.id]),
    // feed (was /mod)
    reports, pending, settings: await store.roomSettings(R.id), members: await store.roomMembers(R.id), bans: await store.bans(R.id),
    audit: await store.roomAudit(R.id), WHO: store.WHO, pins: await pins(R.id),
    announce: camfrog ? await store.mentionOn(R.id) : null,
    aigenRoom: camfrog ? await require("./aigen").roomGenOn(R.id) : null,      // 1.99dn: room !imagine / !video -> this feed
    // Pepe + automod + rules (new)
    pepe: await PF.scopeView(R.id), PF,
    am: await AM.settings(R.id), amGlobal: await AM.globalCaps(), AM, automod,
    rules: await padrules.get(R.id), effective: await padrules.effective(R.id), padrules,
    queue: reports.length + pending.length,
    // 1.99es: the pad's look (padlook.js) - avatar, banner upload + focal point, accent colour
    look: await require("./padlook").init().then(() => require("./padlook").look(R.id)), PL: require("./padlook"),
  };
}

function register(app, { addUser }) {
  app.get("/p/:slug/settings", addUser, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      const R = (await rooms.get(String(req.params.slug || ""))) || (await require("./roomsweb").resolveRoom(req.params.slug));
      if (!R) return res.status(404).render("notFound", { user: req.user.username, heading: "No such pad", message: "That pad isn't on PATV.", title: "Pad not found" });
      const viewer = await store.account(req.user.userId);
      if (!(await rooms.canManage(viewer, R.id))) {
        return res.status(403).render("notFound", { user: req.user.username, heading: "Not your pad", message: "Only this pad's owner (and site admins) can change its settings.", title: "Not your pad" });
      }
      const D = await hubData(R, viewer, app);
      const tab = TABS.includes(String(req.query.tab || "")) ? String(req.query.tab) : "general";
      res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "no-store" });
      res.render("padSettings", { user: req.user.username, viewer, tab, TABS, fx: require("./feedweb").fx, G: require("./guidelines"), ...D });
    } catch (e) {
      console.error("[padsettings]", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

module.exports = { register, hubData, TABS };
