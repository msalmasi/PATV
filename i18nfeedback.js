// i18nfeedback.js - 1.99kf: "Suggest a better translation" + the admins' review of the suggestions.
//
//   /translate                         signed-in users browsing in another language: the strings of the page they
//                                      just left (i18n.recentPage) + a search over every string; each one shows the
//                                      English, the current translation and a suggestion form
//   POST /translate/suggest            a form post (also accepts JSON with X-Requested-With: fetch); checked with
//                                      i18n-check.js (same placeholders / markup as English); rate-limited per user
//   /admin/translations                Admins: pending suggestions (accept as-is or edited / reject), live overrides,
//                                      export. English-only like the rest of the admin area.
//   GET /admin/translations/export.json   the accepted overrides, for `node tools/i18n-overrides.js fold <file>`, which
//                                      writes them into locales/<code>.json and marks them human-reviewed (the
//                                      automatic sync then never overwrites them)
//
// Tables: translation_suggestions (every suggestion and what happened to it) and translation_overrides (lang, key) ->
// the accepted text. Overrides are applied at runtime on top of the catalogs (i18n.setOverrides) as long as the
// English they were made for hasn't changed (src_hash); a stale one is listed for the admins and not applied.
"use strict";
const express = require("express");
const { getQuery, runQuery } = require("./dbUtils");
const i18n = require("./i18n");
const C = require("./i18n-check");

const LIMIT_HOUR = 20;           // suggestions per user per hour
const LIMIT_DAY = 100;           // ... per day
const NOTE_MAX = 300;
const SEARCH_MAX = 40;
const PAGE_MAX = 120;
let NOW = () => Date.now();

let ready = null;
function init() {
  if (ready) return ready;
  ready = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS translation_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lang TEXT NOT NULL,
      key TEXT NOT NULL,
      userId TEXT NOT NULL,
      username TEXT,
      current_json TEXT,
      value_json TEXT NOT NULL,
      note TEXT,
      page TEXT,
      src_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_by TEXT,
      reviewed_at INTEGER,
      final_json TEXT)`);
    await runQuery("CREATE INDEX IF NOT EXISTS idx_tsugg_status ON translation_suggestions (status, created_at)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_tsugg_user ON translation_suggestions (userId, created_at)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_tsugg_key ON translation_suggestions (lang, key)");
    await runQuery(`CREATE TABLE IF NOT EXISTS translation_overrides (
      lang TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      src_hash TEXT NOT NULL,
      suggestion_id INTEGER,
      by TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (lang, key))`);
    await reload();
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const en = () => i18n.catalogs().en || {};
const catalogValue = (lang, key) => { const c = i18n.catalogs()[lang]; return c && Object.prototype.hasOwnProperty.call(c, key) ? c[key] : null; };
const langOk = (lang) => lang && lang !== "en" && !!i18n.catalogs()[lang];
const pluralCats = (lang) => { try { return new Intl.PluralRules(lang).resolvedOptions().pluralCategories; } catch (e) { return ["one", "other"]; } };

/** Every override row, with whether it still applies (English unchanged) and whether the catalog already has it. */
async function overrideRows() {
  const rows = await getQuery("SELECT lang, key, value_json, src_hash, suggestion_id, by, updated_at FROM translation_overrides ORDER BY lang, key");
  const E = en();
  return rows.map((r) => {
    const value = parse(r.value_json);
    const live = E[r.key] != null && C.hash(E[r.key]) === r.src_hash;
    return { lang: r.lang, key: r.key, value, src_hash: r.src_hash, suggestion_id: r.suggestion_id, by: r.by, updated_at: r.updated_at,
             stale: !live, folded: JSON.stringify(catalogValue(r.lang, r.key)) === JSON.stringify(value) };
  });
}

/** Re-apply the overlay from the table (after every accept / delete, and at start). */
async function reload() {
  const map = {};
  for (const r of await overrideRows()) {
    if (r.stale || r.folded || r.value == null) continue;
    (map[r.lang] = map[r.lang] || {})[r.key] = r.value;
  }
  return i18n.setOverrides(map);
}

/** A form/JSON body -> the suggested value for that key: a string, or a plural object from text_<category> fields. */
function valueFrom(body, lang, key) {
  const E = en();
  const clean = (s) => String(s == null ? "" : s).replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (E[key] != null && typeof E[key] === "object") {
    if (body.value && typeof body.value === "object") return Object.fromEntries(Object.entries(body.value).map(([c, s]) => [c, clean(s)]).filter(([, s]) => s));
    const o = {};
    for (const c of pluralCats(lang).concat(["other"])) { const s = clean(body["text_" + c]); if (s) o[c] = s; }
    return o;
  }
  return clean(body.value != null ? body.value : body.text);
}
const tooLong = (key, v) => C.strings(v).some((s) => String(s).length > Math.max(400, String(C.strings(en()[key])[0]).length * 4));

class Refused extends Error { constructor(code, status, problems) { super(code); this.code = code; this.status = status || 400; this.problems = problems || []; } }

/** Store one suggestion. Returns { id, updated }. Throws Refused(code) - codes are translate.err.<code>. */
async function suggest({ user, lang, key, body, page }) {
  await init();
  if (!user || !user.userId) throw new Refused("signin", 401);
  if (!langOk(lang)) throw new Refused("lang");
  const E = en();
  if (!key || E[key] == null) throw new Refused("unknown");
  const value = valueFrom(body || {}, lang, key);
  if (!value || (typeof value === "object" && !Object.keys(value).length)) throw new Refused("empty");
  if (tooLong(key, value)) throw new Refused("long");
  const problems = C.check(key, E[key], value);
  if (problems.length) throw new Refused("invalid", 400, problems);
  const cur = currentValue(lang, key);
  if (JSON.stringify(cur) === JSON.stringify(value)) throw new Refused("same");
  const note = String((body && body.note) || "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  const now = NOW();
  const mine = (await getQuery("SELECT id FROM translation_suggestions WHERE userId = ? AND lang = ? AND key = ? AND status = 'pending'", [user.userId, lang, key]))[0];
  if (mine) {
    await runQuery("UPDATE translation_suggestions SET value_json = ?, note = COALESCE(?, note), current_json = ?, src_hash = ?, page = COALESCE(?, page) WHERE id = ?",
      [JSON.stringify(value), note || null, JSON.stringify(cur), C.hash(E[key]), page || null, mine.id]);
    return { id: mine.id, updated: true };
  }
  const n = (await getQuery("SELECT SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS h, COUNT(*) AS d FROM translation_suggestions WHERE userId = ? AND created_at > ?",
    [now - 3600e3, user.userId, now - 86400e3]))[0] || {};
  if ((n.h || 0) >= LIMIT_HOUR || (n.d || 0) >= LIMIT_DAY) throw new Refused("rate", 429);
  const r = await runQuery(`INSERT INTO translation_suggestions (lang, key, userId, username, current_json, value_json, note, page, src_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [lang, key, user.userId, user.username || null, JSON.stringify(cur), JSON.stringify(value), note || null, page || null, C.hash(E[key]), now]);
  return { id: r && r.lastID, updated: false };
}

/** What the site shows now for lang:key (override > catalog), or null when it falls back to English. */
function currentValue(lang, key) {
  const live = (i18n.overrides()[lang] || {})[key];
  if (live != null) return live;
  return catalogValue(lang, key);
}

/** One row of the /translate list. */
function item(lang, key) {
  const E = en();
  const cur = currentValue(lang, key);
  return { key, en: E[key], cur, plural: typeof E[key] === "object", improved: (i18n.overrides()[lang] || {})[key] != null,
           js: key.startsWith("js."), cats: pluralCats(lang) };
}

const plain = (v) => C.strings(v).join(" ").replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").toLowerCase();
function search(lang, q) {
  const s = String(q || "").trim().toLowerCase();
  if (s.length < 2) return [];
  const E = en(), out = [];
  for (const k of Object.keys(E)) {
    if (out.length >= SEARCH_MAX) break;
    if (k === s || plain(E[k]).includes(s) || plain(currentValue(lang, k) || "").includes(s)) out.push(item(lang, k));
  }
  return out;
}

/** The keys the user's last page used (most specific first: the page's own strings, then the navbar/footer). */
function pageItems(lang, recent) {
  if (!recent) return [];
  const E = en();
  const keys = recent.keys.filter((k) => E[k] != null);
  const chrome = (k) => /^(nav|foot)\./.test(k);
  return keys.filter((k) => !chrome(k)).concat(keys.filter(chrome)).slice(0, PAGE_MAX).map((k) => item(lang, k));
}

// ---------------------------------------------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------------------------------------------
async function listSuggestions({ status = "pending", lang = "" } = {}) {
  await init();
  const where = [], args = [];
  if (status !== "all") { where.push("status = ?"); args.push(status); }
  if (lang) { where.push("lang = ?"); args.push(lang); }
  const rows = await getQuery(`SELECT * FROM translation_suggestions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 300`, args);
  const E = en();
  return rows.map((r) => ({ id: r.id, lang: r.lang, key: r.key, username: r.username, note: r.note, page: r.page, status: r.status,
    created_at: r.created_at, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, en: E[r.key], value: parse(r.value_json),
    final: parse(r.final_json), current: currentValue(r.lang, r.key), stale: E[r.key] == null || C.hash(E[r.key]) !== r.src_hash }));
}

async function accept(id, adminName, edited) {
  await init();
  const r = (await getQuery("SELECT * FROM translation_suggestions WHERE id = ?", [Number(id) || 0]))[0];
  if (!r) throw new Refused("No such suggestion.", 404);
  if (r.status !== "pending") throw new Refused("Already " + r.status + ".", 409);
  const E = en();
  if (E[r.key] == null) throw new Refused("That string no longer exists.");
  let value = edited != null && edited !== "" ? edited : parse(r.value_json);
  if (typeof value === "string") value = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const problems = C.check(r.key, E[r.key], value);
  if (problems.length) throw new Refused("Not valid: " + problems.join("; "));
  const now = NOW();
  await runQuery(`INSERT INTO translation_overrides (lang, key, value_json, src_hash, suggestion_id, by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lang, key) DO UPDATE SET value_json = excluded.value_json, src_hash = excluded.src_hash, suggestion_id = excluded.suggestion_id,
    by = excluded.by, updated_at = excluded.updated_at`, [r.lang, r.key, JSON.stringify(value), C.hash(E[r.key]), r.id, adminName, now]);
  await runQuery("UPDATE translation_suggestions SET status = 'accepted', reviewed_by = ?, reviewed_at = ?, final_json = ? WHERE id = ?",
    [adminName, now, JSON.stringify(value), r.id]);
  await runQuery("UPDATE translation_suggestions SET status = 'superseded', reviewed_by = ?, reviewed_at = ? WHERE lang = ? AND key = ? AND status = 'pending' AND id <> ?",
    [adminName, now, r.lang, r.key, r.id]);
  await reload();
  try { require("./achievements").poke(r.userId); } catch (e) { /* achievements never block */ }   // 1.99mt: 🌍 Polyglot
  return { lang: r.lang, key: r.key, value };
}

async function reject(id, adminName) {
  await init();
  const r = (await getQuery("SELECT id, status FROM translation_suggestions WHERE id = ?", [Number(id) || 0]))[0];
  if (!r) throw new Refused("No such suggestion.", 404);
  if (r.status !== "pending") throw new Refused("Already " + r.status + ".", 409);
  await runQuery("UPDATE translation_suggestions SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?", [adminName, NOW(), r.id]);
  return { id: r.id };
}

async function removeOverride(lang, key) {
  await init();
  await runQuery("DELETE FROM translation_overrides WHERE lang = ? AND key = ?", [String(lang || ""), String(key || "")]);
  await reload();
}

/** Delete the overrides the catalogs already contain (after a fold was deployed). */
async function prune() {
  await init();
  let n = 0;
  for (const r of await overrideRows()) {
    if (!r.folded) continue;
    await runQuery("DELETE FROM translation_overrides WHERE lang = ? AND key = ?", [r.lang, r.key]);
    n++;
  }
  await reload();
  return n;
}

async function exportOverrides() {
  await init();
  const rows = (await overrideRows()).filter((r) => !r.folded);
  return { format: "patv-translation-overrides", version: 1, exported_at: new Date(NOW()).toISOString(),
           overrides: rows.map((r) => ({ lang: r.lang, key: r.key, value: r.value, src_hash: r.src_hash, by: r.by, stale: r.stale })) };
}

async function stats() {
  await init();
  const rows = await getQuery("SELECT status, COUNT(*) AS n FROM translation_suggestions GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ---------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------
function register(app, { addUser }) {
  const form = express.urlencoded({ extended: false, limit: "32kb" });
  const json = express.json({ limit: "32kb" });
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const isAdmin = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return u && u.class === "Admin" ? u : null;
  };
  const safePage = (p) => { const s = String(p || ""); return /^\/(?![\/\\])[^\s]*$/.test(s) && s.length < 300 ? s : ""; };

  const render = async (req, res, extra = {}, status = 200) => {
    const lang = req.lang || "en";
    const uid = req.user && req.user.userId;
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
    const key = typeof req.query.key === "string" && en()[req.query.key] != null ? req.query.key : "";
    const recent = uid ? i18n.recentPage(uid) : null;
    const one = key && !q && langOk(lang) ? [item(lang, key)] : [];
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex");
    res.status(status).render("translate", Object.assign({
      user: req.user ? req.user.username : null, signedIn: !!uid, isEn: !langOk(lang), q, one,
      pageItems: langOk(lang) && !q && !key ? pageItems(lang, recent) : [], pagePath: recent ? recent.path : "",
      results: langOk(lang) && q ? search(lang, q) : [], sent: typeof req.query.sent === "string" ? req.query.sent : "",
      error: null, ogPath: "/translate",
    }, extra));
  };

  app.get("/translate", addUser, async (req, res) => {
    try { await init(); await render(req, res); } catch (e) { console.error("[i18nfeedback] page:", e); res.status(500).send("Something went wrong."); }
  });

  const suggestRoute = async (req, res) => {
    const wantsJson = req.is("application/json");
    if (!sameSite(req) || (wantsJson && req.get("X-Requested-With") !== "fetch")) return res.status(403).json({ ok: false, error: "Bad request." });
    const b = req.body || {};
    const lang = String(b.lang || req.lang || ""), key = String(b.key || "");
    const back = safePage(b.page);
    try {
      const r = await suggest({ user: req.user, lang, key, body: b, page: back || null });
      if (wantsJson) return res.json({ ok: true, id: r.id, updated: r.updated });
      const qs = new URLSearchParams();
      if (b.q) qs.set("q", String(b.q).slice(0, 80));
      else qs.set("key", key);
      qs.set("sent", key);
      return res.redirect(303, "/translate?" + qs.toString() + "#k-" + encodeURIComponent(key));
    } catch (e) {
      if (!(e instanceof Refused)) { console.error("[i18nfeedback] suggest:", e); return res.status(500).json({ ok: false, error: "Something went wrong." }); }
      const msg = req.t ? req.t("translate.err." + e.code) : e.code;
      if (wantsJson) return res.status(e.status).json({ ok: false, code: e.code, error: msg, problems: e.problems });
      if (e.code === "signin") return res.redirect(303, "/login?next=" + encodeURIComponent("/translate?key=" + key));
      req.query = { key, q: typeof b.q === "string" ? b.q : "" };
      return render(req, res, { error: { key, code: e.code, message: msg, problems: e.problems, body: b } }, e.status);
    }
  };
  app.post("/translate/suggest", addUser, form, json, suggestRoute);

  // ---- admin ----
  app.get("/admin/translations", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      const a = await isAdmin(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!a) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The translation review page is for site admins.", title: "Admins only" });
      const status = ["pending", "accepted", "rejected", "superseded", "all"].includes(req.query.status) ? req.query.status : "pending";
      const lang = typeof req.query.lang === "string" && langOk(req.query.lang) ? req.query.lang : "";
      res.render("admin/translations", { title: "Translations", user: a.username, isAdmin: true, status, lang,
        rows: await listSuggestions({ status, lang }), overrides: await overrideRows(), stats: await stats(),
        langs: i18n.supported().filter((l) => l.code !== "en"), pluralCats });
    } catch (e) { console.error("[i18nfeedback] admin:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/admin/translations/export.json", addUser, async (req, res) => {
    const a = await isAdmin(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    try {
      res.set("Cache-Control", "no-store");
      res.set("Content-Disposition", `attachment; filename="translation-overrides-${new Date().toISOString().slice(0, 10)}.json"`);
      res.type("application/json").send(JSON.stringify(await exportOverrides(), null, 2) + "\n");
    } catch (e) { console.error("[i18nfeedback] export:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  const adminApi = async (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    const a = await isAdmin(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    req.admin = a;
    next();
  };
  const fail = (res, e) => {
    if (e instanceof Refused) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[i18nfeedback]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/admin/translations/:id/accept", addUser, json, adminApi, async (req, res) => {
    try { res.json({ ok: true, ...(await accept(req.params.id, req.admin.username, (req.body || {}).value)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/translations/:id/reject", addUser, json, adminApi, async (req, res) => {
    try { res.json({ ok: true, ...(await reject(req.params.id, req.admin.username)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/translations/override/delete", addUser, json, adminApi, async (req, res) => {
    try { await removeOverride((req.body || {}).lang, (req.body || {}).key); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/translations/prune", addUser, json, adminApi, async (req, res) => {
    try { res.json({ ok: true, removed: await prune() }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, reload, suggest, accept, reject, removeOverride, prune, exportOverrides, listSuggestions, overrideRows,
  search, pageItems, item, valueFrom, Refused, LIMIT_HOUR, LIMIT_DAY, _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
