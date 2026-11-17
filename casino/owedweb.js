// casino/owedweb.js — 1.99aoj: /admin/casino/owed, the owner's tool for casino PAT kept OWED because its credit was refused
// (casino/owed.js; docs/casino-backend.md). Site-admin only; linked from /admin/games (the casino card, with a count badge).
//   GET  /admin/casino/owed                     the page (casino.admin; anyone else -> /login)
//   GET  /api/casino/admin/owed                 {items, recent, owner, now} - every item owed at the open tables, the newest audited actions
//                                               (no account ids: a member is a username, or "account missing" + a short opaque reference)
//   POST /api/casino/admin/owed/retry           {table, item, amount, idem}  casino admins: the item's own retry, now
//   POST /api/casino/admin/owed/redirect        {table, item, amount, idem, to, reason, nonce, password}  a Pepe OWNER + the password step-up
//   POST /api/casino/admin/owed/writeoff        {table, item, amount, idem, reason, nonce, password}      a Pepe OWNER + the password step-up
// Every POST is a same-origin JSON fetch (X-Requested-With: fetch + an Origin / Referer naming this host - stepup.sameOrigin). The owner
// check (staffroles.ownerOf, casino.admin) comes before the step-up (stepup.check: the single-use nonce from POST /api/admin/stepup/nonce
// {for: "casino_owed"} and the account password; 5 wrong in 15 minutes -> 429), and both before anything moves. -> {ok, message} |
// {ok: false, code, error} (409 when the item changed since the page was drawn, or the credit is refused again).
"use strict";
const { getQuery } = require("../dbUtils");
const svc = require("./service");

const IDEM = /^[\w:.\-]{8,100}$/;
const TABLE = /^[0-9a-f]{10}$/;
const ITEM = /^[0-9a-f]{16}$/;
const OPS = ["retry", "redirect", "writeoff"];
const isJsonFetch = (req) => req.is("application/json") && req.get("X-Requested-With") === "fetch";

/** the signed-in account as the database has it now, when it holds casino.admin -> {userId, username, class, camfrogUsername} | null */
async function adminOf(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
  return u && require("../siteperms").can(u, "casino.admin") ? u : null;
}
const ownerOf = (me) => require("../staffroles").ownerOf(me, require("../stepup").PURPOSES.casino_owed).catch(() => null);

function register(app, { addUser }) {
  app.get("/admin/casino/owed", addUser, async (req, res) => {
    const me = await adminOf(req);
    if (!me) return res.redirect("/login");
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex");
    try {
      await svc.boot();
      res.render("admin/casino-owed", { user: req.user.username, title: "Owed casino PAT", owner: !!(await ownerOf(me)),
                                        isAdmin: require("../siteperms").can(me, "admin.sensitive_overview") });
    } catch (e) {
      console.error("[casino] owed page:", e);
      res.status(500).send("Couldn't load the admin page.");
    }
  });

  app.get("/api/casino/admin/owed", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const me = await adminOf(req);
    if (!me) return res.status(req.user && req.user.userId ? 403 : 401).json({ ok: false, error: "Casino admins only." });
    try {
      await svc.boot();
      res.json({ ok: true, items: await svc.OW.list(), recent: await svc.OW.recent(20), owner: !!(await ownerOf(me)), now: svc.S.hooks.now() });
    } catch (e) {
      console.error("[casino] owed list:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });

  app.post("/api/casino/admin/owed/:op", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const op = String(req.params.op || "");
    if (!OPS.includes(op)) return res.status(404).json({ ok: false, error: "No such action." });
    if (!isJsonFetch(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    const SU = require("../stepup");
    try { SU.sameOrigin(req); } catch (e) { return res.status(e.status || 403).json({ ok: false, code: e.code, error: e.message }); }
    const me = await adminOf(req);
    if (!me) return res.status(req.user && req.user.userId ? 403 : 401).json({ ok: false, error: "Casino admins only." });
    const b = req.body || {};
    if (!IDEM.test(String(b.idem || "")) || !TABLE.test(String(b.table || "")) || !ITEM.test(String(b.item || "")) || !Number.isSafeInteger(Number(b.amount))) {
      return res.status(400).json({ ok: false, error: "Bad request." });
    }
    try {
      if (op !== "retry") {
        // a Pepe owner's (it moves PAT), then the password step-up - both before anything moves
        const owner = await ownerOf(me);
        if (!owner) return res.status(403).json({ ok: false, code: "owner_only", error: require("../staffroles").OWNER_ONLY });
        const reason = String(b.reason == null ? "" : b.reason).trim();
        if (reason.length < 8) return res.status(400).json({ ok: false, code: "E_REASON", error: "Write a reason (at least 8 characters) - it goes in the admin log." });
        if (op === "redirect" && !String(b.to == null ? "" : b.to).trim()) return res.status(400).json({ ok: false, code: "E_TO", error: "Name the account to pay." });
        try { await SU.check(req, owner, b); }
        catch (e) {
          if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
          throw e;
        }
      }
      await svc.boot();
      const out = await svc.OW.act(op, { userId: me.userId, username: me.username }, b);
      res.status(out.ok ? 200 : out.status || 409).json(out);
    } catch (e) {
      console.error(`[casino] owed ${op}:`, e);
      res.status(500).json({ ok: false, error: "Something went wrong - reload the page and check the item." });
    }
  });
}

module.exports = { register, adminOf };
