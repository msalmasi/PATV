// oracleadmin.js - 1.99uc: /admin/oracle, the admins' view of the AI judge's proposals and disputes (oracle.js, docs/oracle-contract.md).
//
//   GET  /admin/oracle                 the list (filters: ?status=window|proposed|disputed|due|settled|overridden|failed|superseded
//                                      &kind=market|pool|wager &from=YYYY-MM-DD &to=YYYY-MM-DD &before=<ms>) + the summary tiles
//   GET  /admin/oracle?key=<key>       one proposal: the full rationale and evidence, the timeline, the disputes, the actions
//   GET  /api/admin/oracle/list        the same list as JSON          GET /api/admin/oracle/proposal?key=  one proposal as JSON
//   POST /api/admin/oracle/act         {key, action, idem, minutes, outcome, reason, login} -> oracle.adminAct (keyed, audited)
//
// Admins only (class Admin, read fresh on every request). The POST also needs the site's same-site check and
// X-Requested-With: fetch. Everything Pepe or a disputer wrote is escaped; evidence links are http(s) only, rel=nofollow.
// The page script (public/js/admin-oracle.js) runs the countdowns and the in-page confirm dialog.
"use strict";
const { getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const O = require("./oracle");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Escaped text with its http(s) links made into links (escaped too). Nothing else becomes markup. */
function linkify(text) {
  const s = String(text == null ? "" : text);
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let out = "", last = 0, m;
  while ((m = re.exec(s))) {
    const url = m[0].replace(/[).,;:!?\]]+$/, "");
    if (!url.length) continue;
    out += esc(s.slice(last, m.index)) + `<a href="${esc(url)}" rel="noopener noreferrer nofollow ugc" target="_blank">${esc(url)}</a>`;
    last = m.index + url.length;
    re.lastIndex = last;
  }
  return out + esc(s.slice(last));
}
/** The judge's evidence ({text, price, auto} from Pepe, or anything else) as safe HTML. labels: {text: "...", ...} (already HTML-safe). */
function evidenceHtml(ev, labels = {}) {
  if (ev == null || ev === "") return "";
  if (typeof ev !== "object" || Array.isArray(ev)) {
    return typeof ev === "string" ? `<div class="oa-ev-text">${linkify(ev)}</div>` : `<pre class="oa-ev-json">${linkify(JSON.stringify(ev, null, 2))}</pre>`;
  }
  const parts = [];
  for (const [k, v] of Object.entries(ev)) {
    if (v == null || v === "" || (typeof v === "object" && !Object.keys(v).length)) continue;
    const label = labels[k] || esc(k);
    const body = typeof v === "string" ? `<div class="oa-ev-text">${linkify(v)}</div>` : `<pre class="oa-ev-json">${linkify(JSON.stringify(v, null, 2))}</pre>`;
    parts.push(`<div class="oa-ev-part"><b>${label}</b>${body}</div>`);
  }
  return parts.join("");
}

async function adminNow(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
  return SP.can(u, "oracle.admin") ? { userId: u.userId, username: u.username, camfrogUsername: u.camfrogUsername || null } : null;
}

function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const json = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await adminNow(req).catch(() => null);
    if (!me) return res.status(403).json({ ok: false, error: "Admins only." });
    try { res.json(await fn(req, me)); } catch (e) {
      if (e instanceof O.Refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
      console.error(`[oracleadmin] ${req.path}:`, e);
      res.status(500).json({ ok: false, error: "Something went wrong - nothing changed." });
    }
  };
  app.get("/api/admin/oracle/list", addUser, json(async (req) => ({ ok: true, summary: await O.adminSummary(), ...(await O.adminList(req.query || {})) })));
  app.get("/api/admin/oracle/proposal", addUser, json(async (req) => {
    const p = await O.adminDetail(String((req.query || {}).key || ""));
    if (!p) throw new O.Refuse(404, "no such proposal", "E_NOT_FOUND");
    return { ok: true, proposal: p };
  }));
  app.post("/api/admin/oracle/act", addUser, async (req, res, next) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) {
      res.set("Cache-Control", "no-store");
      return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    }
    next();
  }, json(async (req, me) => O.adminAct(me, req.body || {})));

  app.get("/admin/oracle", addUser, async (req, res) => {
    const me = await adminNow(req).catch(() => null);
    if (!me) { if (typeof req.flash === "function") req.flash("error", "Admins only."); return res.redirect("/login"); }
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex");
    try {
      const q = req.query || {};
      const summary = await O.adminSummary();
      let P = null, L = null;
      if (q.key) {
        P = await O.adminDetail(String(q.key));
        if (!P) return res.status(404).render("admin/oracle", { user: me.username, title: "Admin · AI judge", isAdmin: true, summary, P: null, L: null, missing: true, evidenceHtml, linkify, now: Date.now() });
      } else {
        L = await O.adminList(q);
      }
      res.render("admin/oracle", { user: me.username, title: "Admin · AI judge", isAdmin: true, summary, P, L, missing: false, evidenceHtml, linkify, now: Date.now() });
    } catch (e) { console.error("[oracleadmin] page:", e); res.status(500).send("Couldn't load the AI judge's proposals."); }
  });
}

module.exports = { register, evidenceHtml, linkify, esc };
