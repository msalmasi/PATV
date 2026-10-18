// adminkeys.js — /admin/keys: bot keys & the chat seam (R-11 + S0, 1.99acf; docs/bot-keys.md, docs/chat-tickets.md).
//
//   GET  /admin/keys                       the page (views/admin/keys.ejs, public/js/admin-keys.js): keys, scopes, route
//                                          families, legacy token use, the route log, /events auth, chat tickets & hub seam
//   GET  /api/admin/keys                   the same data as JSON (never a hash, tag or secret)
//   POST /api/admin/keys/mint {caller, label}                 -> {key} once ("<caller>.<secret>", the X-PATV-Key value)
//   POST /api/admin/keys/rotate {caller, grace_h}             -> {key} once; the old secret works grace_h more hours (0-72)
//   POST /api/admin/keys/revoke {caller, reason}
//   POST /api/admin/keys/mode {caller, mode, scopes[], early}  observe | enforce (enforce before 7 observed days needs early)
//   POST /api/admin/keys/grant {caller, family}               a family a key in enforce was refused on
//   POST /api/admin/keys/family {family, legacy_enforce}      refuse the shared tokens on one route family
//   POST /api/admin/keys/settings {enabled, bad_key, events, control_get}  the header kill switch, unresolvable keys, the
//                                          /events mode, the VM's old GET claim of /api/pepe/control/pending (allow | refuse)
//   POST /api/admin/hubseam/settings {tickets, heartbeat, sessions, privacy, econ, spans}
// Who: viewing needs class Admin IN THE DATABASE (Staff get a flash + the Overview); every change needs an OWNER - Admin plus
// Pepe role "owner" on the linked chat login (the user's 2026-10-16 rule: ops is owner-only). Changes need a same-origin fetch
// with X-Requested-With: fetch, are written to admin_audit and answer Cache-Control: no-store.
"use strict";
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };

async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}
const canView = (me) => SP.can(me, "keys.view");
async function isOwner(me) {
  if (!SP.can(me, "keys.manage") || !me.camfrogUsername) return false;   // keys.manage (locked: Admin) + a Pepe owner
  return (await safe(() => require("./staffroles").roleOf(me.camfrogUsername), null)) === "owner";
}
const sameOriginStrict = (req) => {
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
};

/** Everything the page shows. */
async function pageData() {
  const bk = require("./botkeys");
  const view = await bk.adminView();
  return {
    ...view,
    events_log: await safe(() => require("./eventsauth").recent(7), []),
    seam: {
      tickets: await safe(async () => require("./chatticket").status(), null),
      outbox: await safe(() => require("./huboutbox").status(), null),
      spans: await safe(() => require("./bridgespans").stats(), null),
    },
  };
}

function register(app, { addUser }) {
  const bk = require("./botkeys");
  app.get("/admin/keys", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/keys"));
    try {
      const me = await meOf(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!canView(me)) {
        if (typeof req.flash === "function") req.flash("error", "Bot keys & the chat seam are for site admins.");
        return res.redirect((me && SP.areaHome(me)) || "/login");
      }
      const d = await pageData();
      res.render("admin/keys", { title: "Admin · Bot keys & chat seam", user: me.username, isAdmin: true, me, owner: await isOwner(me), view: d });
    } catch (e) { console.error("[adminkeys] page:", e); res.status(500).send("Couldn't load the admin page."); }
  });

  app.get("/api/admin/keys", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!canView(me)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try { res.json({ ok: true, owner: await isOwner(me), ...(await pageData()) }); }
    catch (e) { console.error("[adminkeys] data:", e.message); res.status(500).json({ ok: false }); }
  });

  // every change: same-origin fetch, owner, audited by the module that does it
  const change = (path, fn) => app.post(path, addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!(await isOwner(me))) return res.status(403).json({ ok: false, code: "owner_only", error: "Only an owner can change bot keys." });
    try {
      res.json({ ok: true, ...(await fn(req.body || {}, { userId: me.userId, username: me.username })) });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code, error: e.message });
      console.error("[adminkeys]", path, e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." });
    }
  });
  change("/api/admin/keys/mint", (b, me) => bk.mint(b.caller, b.label, me));
  change("/api/admin/keys/rotate", (b, me) => bk.rotate(b.caller, b.grace_h, me));
  change("/api/admin/keys/revoke", (b, me) => bk.revoke(b.caller, b.reason, me));
  change("/api/admin/keys/mode", (b, me) => bk.setMode(b.caller, b.mode, b.scopes, me, { early: b.early === true }));
  change("/api/admin/keys/grant", (b, me) => bk.grant(b.caller, b.family, me));
  change("/api/admin/keys/family", (b, me) => bk.setFamily(b.family, b.legacy_enforce, me));
  change("/api/admin/keys/settings", async (b, me) => ({ settings: await bk.setSettings(b, me) }));
  change("/api/admin/hubseam/settings", async (b, me) => ({ settings: await require("./huboutbox").setSettings(b, me) }));
}

module.exports = { register, isOwner, pageData };
