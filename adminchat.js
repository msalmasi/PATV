// adminchat.js — 💬 Admin › Chat hub (/admin/chat): the chat hub's break-glass form (S1 V1, release L1; ADR 0007 D3 and D15,
// OQ-19; CHAT-ARCHITECTURE §8.5, R-15 / CF F4). Server-rendered and it makes NO call to the chat hub, so it works while the
// hub is down: everything it shows and sets is v1's own (chatswitches.js).
//
//   GET  /admin/chat            the page (views/admin/chat.ejs, public/js/admin-chat.js): CHAT_HUB, the pads on the hub and
//                               the site pads an owner may move there, the interlock (the twelve seam switches CHAT_HUB
//                               needs), the seam poster's status (huboutbox.status(): this site's queue, never the hub's)
//                               and the change log (admin_audit)
//   GET  /api/admin/chat        the same data as JSON
//   POST /api/admin/chat/hub    {on: true|false, reason, confirm?}           CHAT_HUB on / off
//   POST /api/admin/chat/pad    {room_id, backend: "v1"|"hub", reason, confirm?}   a pad's chat_backend
//
// Who: the page and turning OFF (CHAT_HUB off, a pad back to v1) need chat.breakglass (siteperms, locked at Admin - "ops"):
// any admin, one click (with a reason), never refused, so a rollback stays fast. Turning ON (CHAT_HUB on, a pad to hub) is a
// Pepe OWNER's - staffroles.ownerHolds(me, "chat.breakglass"): the Admin class AND the owner role on the linked chat login,
// read fresh from the database (the owner's 2026-10-16 rule: ops is owner-only) - with a confirm step: a post without
// confirm: true answers 409 confirm with what would happen (the preview) and writes nothing; the page asks, then posts again.
// Every change: a same-origin fetch (X-Requested-With: fetch + an Origin / Referer naming this host - authGuard.sameOriginFetch,
// the house pattern of adminkeys.js / backends.js), a required reason, an admin_audit row in the switch's own transaction
// ("chat.switch" / "chat.pad_backend"), Cache-Control: no-store. CHAT_HUB on also needs the interlock (409 chat_hub_needs);
// a pad moves to hub only when it is a site pad (409 site_only: Camfrog pads keep their v1 chat in S1; hub_read is S2's).
// The admin nav's Chat group (views/partials/admin-nav.ejs) opens here; V2 (release L4) adds the hub's moderation screens to
// the group as /admin/chat/{reports,held,modlog,bans,audit,switches} behind chat.mod_queue / chat.audit (MOD_VIEWS).
// Logs carry no reason, pad, account or switch value - only "[adminchat] <what>: <error>".
"use strict";
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");
const CS = require("./chatswitches");

const CAP = "chat.breakglass";
// ADR 0007 D1: the S1 pilot pads (site pads; Q4 seeds staff and canary), listed first among the pads an owner may move
const PILOT_PADS = ["patv:staff", "patv:canary", "patv:lounge"];
// V2's moderation screens in this group and the capability that opens each (ADR 0007 D15) - V2 hosts them
const MOD_VIEWS = { reports: "chat.mod_queue", held: "chat.mod_queue", modlog: "chat.mod_queue", bans: "chat.mod_queue",
                    audit: "chat.audit", switches: "chat.audit" };

const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };
const refuse = (status, code, message, extra) => Object.assign(new Error(message), { status, code, refuse: true }, extra || {});

async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}
const isAdmin = (me) => SP.can(me, CAP);
const isOwner = async (me) => !!me && (await require("./staffroles").ownerHolds(me, CAP));

/** The seam poster as this site sees it (huboutbox.status(): local state only - never a call to the hub). */
function posterOf(st) {
  if (!st) return null;
  const pick = (t) => (st.topics && st.topics[t]) || null;
  return { configured: !!st.configured, refusal: st.refusal || null, env: st.env || null, pending: Number(st.pending) || 0,
           oldest_pending: st.oldest_pending || null, last_post: st.last_post || null, heartbeat: st.heartbeat || null,
           failing: Object.keys(st.failing || {}), topics: { "switches/changed": pick("switches/changed"), "pads/changed": pick("pads/changed") } };
}

/** Everything the page shows. */
async function view(me) {
  await CS.init();
  const owner = await isOwner(me);
  const hub = await CS.rowOf("CHAT_HUB");
  const lock = await CS.interlock();
  const pads = await CS.hubPads();
  return {
    owner, hub, interlock: lock, pads,
    choices: owner ? await CS.sitePadChoices({ first: PILOT_PADS }) : [],
    pilots: PILOT_PADS,
    poster: posterOf(await safe(() => require("./huboutbox").status(), null)),
    log: await CS.recentChanges(20),
  };
}

/** What turning CHAT_HUB on would do (the confirm step's text comes from this). */
async function hubPreview() {
  const pads = (await CS.hubPads()).filter((p) => p.backend === "hub");
  return { pads: pads.map((p) => p.title || p.slug || p.room_id), n: pads.length };
}

function register(app, { addUser }) {
  CS.init().catch((e) => console.error("[adminchat] init:", e.message));
  const guard = require("./middleware/authGuard");
  const noStore = (res) => { res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex"); };

  app.get("/admin/chat", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/chat"));
    try {
      const me = await meOf(req);
      noStore(res);
      if (!isAdmin(me)) {
        if (typeof req.flash === "function") req.flash("error", "The chat hub switches are for site admins.");
        return res.redirect((me && SP.areaHome(me)) || "/login");
      }
      res.render("admin/chat", { title: "Admin · Chat hub", user: me.username, isAdmin: true, me, V: await view(me) });
    } catch (e) { console.error("[adminchat] page:", e.message); res.status(500).send("Couldn't load the admin page."); }
  });

  app.get("/api/admin/chat", addUser, async (req, res) => {
    noStore(res);
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!isAdmin(me)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try { res.json(Object.assign({ ok: true }, await view(me))); }
    catch (e) { console.error("[adminchat] view:", e.message); res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." }); }
  });

  // every change: same-origin fetch, an admin (an owner to turn anything on), a reason; refusals answer {ok:false, code, error}
  const change = (path, fn) => app.post(path, addUser, async (req, res) => {
    noStore(res);
    if (!guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!isAdmin(me)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try {
      res.json(Object.assign({ ok: true }, await fn(req.body || {}, me)));
    } catch (e) {
      if (e && e.refuse) {
        const out = { ok: false, code: e.code, error: e.message };
        for (const k of ["missing", "preview", "off"]) if (e[k] !== undefined) out[k] = e[k];
        return res.status(e.status || 400).json(out);
      }
      console.error("[adminchat]", path, e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong - nothing changed." });
    }
  });

  change("/api/admin/chat/hub", async (b, me) => {
    if (b.on !== true && b.on !== false) throw refuse(400, "bad_request", "Say on (true) or off (false).");
    if (!CS.cleanReason(b.reason)) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
    if (b.on) {
      if (!(await isOwner(me))) throw refuse(403, "owner_only", "Only a Pepe owner turns the chat hub on - any admin can turn it off.");
      if ((await CS.get("CHAT_HUB")) !== "on") {
        const lock = await CS.interlock();
        if (lock.missing.length) {
          throw refuse(409, "chat_hub_needs", "The chat hub needs these seam switches on first (/admin/keys#seam): " + lock.missing.join(", ") + ".", { missing: lock.missing });
        }
        if (b.confirm !== true) throw refuse(409, "confirm", "Confirm turning the chat hub on.", { preview: await hubPreview() });
      }
    }
    const r = await CS.set("CHAT_HUB", b.on ? "on" : "off", me, b.reason);
    return { changed: r.changed, value: r.to, at: r.at };
  });

  change("/api/admin/chat/pad", async (b, me) => {
    const backend = typeof b.backend === "string" ? b.backend : "";
    if (backend === "hub_read") throw refuse(400, "not_in_s1", "Read-only hub chat (hub_read) opens with S2 - pick v1 or hub.");
    if (!CS.S1_BACKENDS.includes(backend)) throw refuse(400, "bad_backend", "Pick v1 or hub.");
    if (typeof b.room_id !== "string" || !b.room_id) throw refuse(400, "bad_request", "Pick a pad.");
    if (!CS.cleanReason(b.reason)) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
    if (backend === "hub") {
      if (!(await isOwner(me))) throw refuse(403, "owner_only", "Only a Pepe owner moves a pad to the chat hub - any admin can move it back.");
      const p = await CS.pad(b.room_id);
      if (!p) throw refuse(404, "no_pad", "No such pad.");
      if (p.platform !== "site") throw refuse(409, "site_only", "Only site pads move to the chat hub in S1 - a Camfrog (or other bridged) pad keeps its v1 chat.");
      if (p.backend !== "hub" && b.confirm !== true) {
        throw refuse(409, "confirm", "Confirm moving this pad to the chat hub.",
                     { preview: { title: p.title || p.slug || p.room_id, slug: p.slug, chat_hub: (await CS.get("CHAT_HUB")) === "on" } });
      }
    }
    const r = await CS.setPadBackend(b.room_id, backend, me, b.reason);
    return { changed: r.changed, room_id: r.pad.room_id, backend: r.to, at: r.at };
  });
}

module.exports = { register, view, CAP, MOD_VIEWS, PILOT_PADS, isOwner };
