// terms.js — the Terms of Service + Privacy Policy pages and acceptance (1.99cc).
//
//   /terms, /privacy               the pages (views/terms.ejs, views/privacy.ejs), "Last updated" = UPDATED
//   POST /api/terms/accept         the signed-in user accepts the current VERSION (the composer's prompt)
//   users.terms_accepted_version / users.terms_accepted_at (ms)   recorded at sign-up (the web form) and
//                                  the first time someone posts or comments after VERSION changed
//   needs(userId)                  true when the user hasn't accepted VERSION yet (feedweb's posting gate)
//   enforced()                     1.99cf: is acceptance required at all? The admin switch terms_enforced
//                                  (/feed/admin, feedstore config, default OFF) AND no [[PLACEHOLDER]] left in
//                                  views/terms.ejs + views/privacy.ejs. Off: the pages show a "Draft" banner,
//                                  nobody is asked to accept, sign-up records nothing.
//   placeholders()                 the [[...]] markers still in those two pages ({page, text}); while any
//                                  remain the switch can't be turned on (feedstore.setConfig refuses)
//
// Bump VERSION (and UPDATED) when the terms change materially: everyone is asked once more, the next
// time they post.
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

const VERSION = "2026-10-08";
const UPDATED = "8 October 2026";

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
      if (!cols.size) return;                     // no users table (a bare test DB)
      if (!cols.has("terms_accepted_version")) {
        try { await runQuery("ALTER TABLE users ADD COLUMN terms_accepted_version TEXT"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      if (!cols.has("terms_accepted_at")) {
        try { await runQuery("ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
    })().catch((e) => { console.error("[terms] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── 1.99cf: the switch (set by feedstore from its config; default OFF) ──
let SETTING = false;
let OVERRIDE = null;                              // tests: true / false forces the gate, null follows the setting
/** feedstore calls this whenever its config loads or changes (terms_enforced). */
function setEnforced(on) { SETTING = !!on; }
/** Tests of other features switch the posting gate off (null = follow the admin setting again). */
function _setRequired(on) { OVERRIDE = on == null ? null : !!on; }

// The [[PLACEHOLDER]] markers left in the two pages: PH('...') calls and literal [[...]] text. Re-read when a
// file changes (mtime), so filling them in and deploying is enough.
const PAGES = [["terms", path.join(__dirname, "views", "terms.ejs")], ["privacy", path.join(__dirname, "views", "privacy.ejs")]];
const PH_CALL = /\bPH\(\s*(['"`])((?:(?!\1).)*)\1\s*\)/g;
const PH_TEXT = /\[\[([^\[\]]{1,200})\]\]/g;
const EJS_COMMENT = /<%#[\s\S]*?%>/g;
let phCache = { key: "", list: [] };
let phOverride = null;                            // tests: a fixed list
function _setPlaceholders(list) { phOverride = list == null ? null : list.slice(); }
function placeholders() {
  if (phOverride) return phOverride.slice();
  let key = "";
  for (const [, f] of PAGES) { try { key += fs.statSync(f).mtimeMs + ";"; } catch (e) { key += "missing;"; } }
  if (key === phCache.key) return phCache.list.slice();
  const list = [];
  for (const [page, f] of PAGES) {
    let src = "";
    try { src = fs.readFileSync(f, "utf8"); } catch (e) { list.push({ page, text: "(page missing)" }); continue; }
    const seen = new Set();
    for (const line of src.replace(EJS_COMMENT, "").split(/\r?\n/)) {
      if (/\bconst\s+PH\s*=/.test(line)) continue;            // the helper itself
      for (const m of line.matchAll(PH_CALL)) seen.add(m[2].trim());
      for (const m of line.replace(PH_CALL, "").matchAll(PH_TEXT)) seen.add(m[1].trim());
    }
    for (const t of seen) list.push({ page, text: t });
  }
  phCache = { key, list };
  return list.slice();
}
/** Acceptance is required: the admin switch is on and the pages are finished (or a test forced it). */
function enforced() {
  if (OVERRIDE !== null) return OVERRIDE;
  return SETTING && placeholders().length === 0;
}
const required = enforced;

async function accepted(userId) {
  await init();
  const r = (await getQuery("SELECT terms_accepted_version AS v, terms_accepted_at AS at FROM users WHERE userId = ?", [String(userId || "")]))[0];
  return r ? { version: r.v || null, at: r.at || null } : null;
}
/** True when this user still has to accept the current terms before posting. */
async function needs(userId) {
  if (!userId || !enforced()) return false;
  const a = await accepted(userId);
  return !!a && a.version !== VERSION;
}
/** Record acceptance of the current VERSION (idempotent: the first acceptance time is kept). */
async function accept(userId) {
  if (!userId) return false;
  await init();
  const r = await runQuery("UPDATE users SET terms_accepted_version = ?, terms_accepted_at = ? WHERE userId = ? AND (terms_accepted_version IS NULL OR terms_accepted_version != ?)",
                           [VERSION, Date.now(), String(userId), VERSION]);
  return !!r.changes;
}

function register(app, { addUser }) {
  init().catch(() => {});
  // every page rendered after this: may it say "By posting / signing up you agree to the Terms"?
  app.use((req, res, next) => { res.locals.termsEnforced = enforced(); next(); });
  const page = (view, title, path) => (req, res) => {
    res.locals.og = { title: title + " — Public Access TV", description: title + " for publicaccess.tv.", image: (res.locals.ogBase || "") + "/og/page.png?t=" + encodeURIComponent(title),
                      url: (res.locals.ogBase || "") + path };
    res.render(view, { user: req.user ? req.user.username : null, title, VERSION, UPDATED, enforced: enforced() });
  };
  app.get("/terms", addUser, page("terms", "Terms of Service", "/terms"));
  app.get("/privacy", addUser, page("privacy", "Privacy Policy", "/privacy"));
  app.get(["/tos", "/terms-of-service"], (req, res) => res.redirect(301, "/terms"));
  app.get("/privacy-policy", (req, res) => res.redirect(301, "/privacy"));
  app.post("/api/terms/accept", addUser, async (req, res) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    let same = true;
    if (src && host) { try { same = new URL(src).host === host; } catch (e) { same = false; } }
    if (!same || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await accept(req.user.userId);
      res.json({ ok: true, version: VERSION });
    } catch (e) {
      console.error("[terms] accept:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { VERSION, UPDATED, init, needs, accept, accepted, register, required, enforced, setEnforced, placeholders, _setRequired, _setPlaceholders };
