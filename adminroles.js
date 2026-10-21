// adminroles.js — 1.99acj site: /admin/roles, Pepe's roles & permissions, editable in place (release 1; pepeperms.js).
//
//   GET  /admin/roles                       the page (views/admin/roles.ejs, public/js/admin-roles.js)
//   GET  /api/admin/roles                   the same data as JSON
//   POST /api/admin/roles/role  {login, role}                    owner | admin | staff | assistant | trusted | none (!role)
//                                                                owner answers 2026-10-20: making or removing an OWNER also
//                                                                needs {nonce, password} (the step-up, stepup.js)
//   POST /api/admin/roles/perm  {cmd, kind, value, role?}        kind powers | use | targets (role staff | assistant);
//                                                                value a role / floor, or "default" (!perm)
//   POST /api/admin/roles/reset {cmd}                            the command's powers + use + floors back to Pepe's defaults
//   POST /api/admin/roles/site  {key, value}                     1.99ack (release 2): a WEBSITE capability's minimum class
//                                                                (admin | staff | assistant | default) - siteperms.js
// Who: viewing needs roles.assign (siteperms.js, locked: class Admin) IN THE DATABASE (anyone else in the admin area gets a
// flash + their admin home, others /login). Every change is decided
// by the editor's PEPE role (pepe_roles, via their linked Camfrog login) with Pepe's own !role / !perm rules - owners
// anything, admins within an admin's reach (pepeperms.permWhy / staffroles.setRole); others nothing. Changes need a
// same-origin fetch with X-Requested-With: fetch, answer Cache-Control: no-store and are written to admin_audit.
// 1.99ack (release 2): the website's own permissions (siteperms.js) in the "Website permissions" section - the same editors
// and rules (owners anything; admins never a row an owner set; locked rows never; nothing below Assistant), audited (site_perm).
"use strict";
const { getQuery } = require("./dbUtils");
const P = require("./pepeperms");
const SP = require("./siteperms");

const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };
const sameOriginStrict = (req) => {
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
};
async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}

function register(app, { addUser }) {
  P.init().catch((e) => console.error("[adminroles] init:", e.message));
  SP.init().catch((e) => console.error("[adminroles] siteperms:", e.message));

  app.get("/admin/roles", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/roles"));
    try {
      const me = await meOf(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!SP.can(me, "roles.assign")) {
        if (typeof req.flash === "function") req.flash("error", "Roles & permissions are for site admins.");
        return res.redirect((me && SP.areaHome(me)) || "/login");
      }
      const ed = await P.editorOf(me.userId);
      res.render("admin/roles", { title: "Admin · Roles & permissions", user: me.username, isAdmin: true, view: await P.view(ed), site: await SP.view(ed),
                                  pending: await safe(() => require("./staffroles").pendingList(), []) });   // PO-0b
    } catch (e) { console.error("[adminroles] page:", e); res.status(500).send("Couldn't load the admin page."); }
  });

  app.get("/api/admin/roles", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!SP.can(me, "roles.assign")) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try { const ed = await P.editorOf(me.userId); res.json({ ok: true, ...(await P.view(ed)), site: await SP.view(ed), pending: await safe(() => require("./staffroles").pendingList(), []) }); }
    catch (e) { console.error("[adminroles] data:", e.message); res.status(500).json({ ok: false }); }
  });

  const change = (path, fn) => app.post(path, addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!SP.can(me, "roles.assign")) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try {
      const ed = await P.editorOf(me.userId);
      res.json({ ok: true, ...(await fn(req.body || {}, ed, req, me)) });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code, error: e.message });
      console.error("[adminroles]", path, e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." });
    }
  });
  // Owner answers 2026-10-20 (3): a change that makes someone an OWNER or takes the owner role away needs the password
  // step-up (stepup.js: a single-use nonce from /api/admin/roles/nonce + the account password, 5 wrong in 15 min -> 429),
  // like confirming an owner change that came from Pepe's sync. Checked only for an editor who is an owner - anyone else is
  // refused by Pepe's !role rules (P.setRole) as before, without being asked for a password.
  const SRr = require("./staffroles");
  const roleOrNull = (r) => (r == null || r === "" || r === "none" ? null : String(r).toLowerCase());
  change("/api/admin/roles/role", async (b, ed, req, me) => {
    const to = roleOrNull(b.role);
    const from = await SRr.roleOf(String(b.login || "").trim().replace(/^@/, "").toLowerCase());
    if (ed && ed.level >= SRr.LEVEL.owner && (to === "owner") !== (from === "owner")) await require("./stepup").check(req, me, b);
    return P.setRole(ed, b.login, b.role);
  });
  change("/api/admin/roles/perm", (b, ed) => P.setPerm(ed, { kind: b.kind, cmd: b.cmd, value: b.value, role: b.role }));
  change("/api/admin/roles/reset", (b, ed) => P.resetCmd(ed, b.cmd));
  change("/api/admin/roles/site", (b, ed) => SP.setMin(ed, b.key, b.value));   // 1.99ack: a website capability

  // PO-0b (T23): owner grants / removals that came by Pepe's sync wait here for an existing owner + the password step-up
  const SR = require("./staffroles");
  const strict = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) { res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  app.post("/api/admin/roles/nonce", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!strict(req, res)) return;
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!(await SR.ownerHolds(me, "roles.assign"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    res.json({ ok: true, nonce: require("./pepecontrol").issueNonce(me) });
  });
  app.post("/api/admin/roles/pending", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!strict(req, res)) return;
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!(await SR.ownerHolds(me, "roles.assign"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    const b = req.body || {};
    try {
      await require("./econstore").stepUp(me, b);
      res.json({ ok: true, ...(await SR.confirmPending(me, b.login, String(b.action || ""))) });
    } catch (e) {
      if (e && (e.refuse || e.status)) return res.status(e.status || 400).json({ ok: false, code: e.code || "refused", error: e.message });
      console.error("[adminroles] pending:", e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." });
    }
  });
}

module.exports = { register };
