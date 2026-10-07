// adminxp.js — the admin XP / level control (1.99cy). The Users & Accounts page's XP card posted to
// /api/admin/update-level since the 1.99cv redesign (and on the old panel before it), but the route never
// existed. Now it does:
//   POST /api/admin/update-level  {username, mode: "add" | "set_level", amount, reason?, confirm?}
//        without confirm: a preview {before, after, xpDelta} and nothing changes; with confirm: true it applies.
//        Admins only (class "Admin"), same-site, JSON. No level-up rewards (see user.controller.js adminAdjustXp).
//   GET  /api/admin/xp/recent   the last adjustments (admin_audit, action "xp")
"use strict";
const { getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");
const audit = require("./adminaudit");
const uc = require("./user.controller");

async function adminOf(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  return u && u.class === "Admin" ? u : null;
}

function register(app, { addUser }) {
  audit.init().catch((e) => console.error("[adminaudit] init:", e.message));

  app.post("/api/admin/update-level", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Cross-site request refused." });
      if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
      const admin = await adminOf(req);
      if (!admin) return res.status(403).json({ ok: false, error: "Admins only." });
      const b = req.body || {};
      const name = String(b.username || "").trim().replace(/^@/, "").slice(0, 64);
      if (!name) return res.status(400).json({ ok: false, error: "Enter a username." });
      let input;
      try { input = uc.checkXpAdjust(String(b.mode || "add"), b.amount); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
      const rows = await getQuery("SELECT userId, username, archived_at FROM users WHERE LOWER(username) = LOWER(?) LIMIT 2", [name]);
      if (rows.length !== 1) return res.status(404).json({ ok: false, error: `No account called "${name}".` });
      const target = rows[0];
      const reason = String(b.reason || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
      const apply = b.confirm === true;
      const r = await uc.adminAdjustXp(target.userId, input, {
        apply,
        onApplied: (plan) => audit.record(admin, "xp", target, { mode: input.mode, amount: input.amount, before: plan.before, after: plan.after,
                                                                  xpDelta: plan.xpDelta, rewards: false }, reason || null),
      });
      res.json({ ok: true, applied: r.applied, user: target.username, archived: !!target.archived_at, mode: input.mode, amount: input.amount,
                 before: r.before, after: r.after, xpDelta: r.xpDelta, rewards: false });
    } catch (e) {
      const st = e && e.status && e.status < 500 ? e.status : 500;
      if (st === 500) console.error("[adminxp]", e && e.message);
      res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
    }
  });

  app.get("/api/admin/xp/recent", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!(await adminOf(req))) return res.status(403).json({ ok: false, error: "Admins only." });
      res.json({ ok: true, items: await audit.recent("xp", 15) });
    } catch (e) { res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = { register };
