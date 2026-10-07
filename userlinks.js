// userlinks.js - 1.99dt: a name on the site is a link to that person's PATV profile.
//
// Pepe's economy pages (markets, wagers, bounties, loans, lotto, stage...) print the Camfrog login he
// knows people by. In a view, write <%- ul(name) %> (or ul(name, { web: true }) for something made on
// the website) instead of <%= name %>. The helper leaves a marker; when the page has rendered, every
// marked name on it is resolved in ONE query (no N+1), and each becomes
//   <a class="ulink" href="/u/<username>/profile" title="<login>"><PATV display name></a>
// or stays the plain, escaped name when there's no live account for it.
//
// Resolution (lookup()):
//   * the name, minus a leading "@", lowercased; only login-shaped names ([\w.-], 1-40) are looked up
//   * users.camfrogUsername (case-insensitive) first, then users.username (case-insensitive)
//   * several accounts on one login: one that isn't a random "CF..." auto account wins (as the bridge does)
//   * archived accounts (users.archived_at) never match - no link to a profile that's gone
//   * anonymised names (Pepe sends !incognito / !bridge hide people as "someone") are never looked up
//   * the link text is the account's display name (displaynames.js); the login goes in the tooltip
//
// padLink(room) does the same for "in <room>": a link to the pad page (/p/<slug>) when the room is a
// known pad (registry cache / bridge, synchronously), else the plain room name.
//
// install(app) wires it into an Express app: app.locals.ul / padLink and a wrapper around
// app.response.render that resolves the markers. It's idempotent, and works for routes registered
// before it (the wrapper is on the app's response prototype, not a middleware).
"use strict";
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");

const NONCE = crypto.randomBytes(6).toString("hex");
const OPEN = `<!--ul${NONCE}:`;
const CLOSE = `<!--/ul${NONCE}-->`;
const MARK_RE = new RegExp(`<!--ul${NONCE}:([^:>]*):([a-z]*)-->([\\s\\S]*?)<!--/ul${NONCE}-->`, "g");
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ANON = new Set(["", "someone", "anonymous", "anon", "a guest", "guest", "?", "—", "-"]);
const MAX_KEYS = 400;                 // per page (2 parameters each, under SQLite's 999)

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The lookup key for a name, or "" when it's not something to look up (anonymised, not login-shaped). */
function keyOf(name) {
  const s = String(name == null ? "" : name).trim().replace(/^@/, "");
  if (ANON.has(s.toLowerCase())) return "";
  return LOGIN_RE.test(s) ? s.toLowerCase() : "";
}

// a no-break space: the 🌐 never wraps away from its name in a narrow column
const WEB = '&nbsp;<span class="ulink-web" title="Made on the website">🌐</span>';

/**
 * The marker a view prints (via <%- %>). opts: { web } adds the 🌐 marker, { anon } never links,
 * { text } shows this text instead of the name when there's no account (e.g. a display name).
 */
function ul(name, opts = {}) {
  const raw = String(name == null ? "" : name);
  const shown = opts.text != null ? String(opts.text) : raw;
  const key = opts.anon ? "" : keyOf(raw);
  const tail = opts.web ? WEB : "";
  if (!key) return esc(shown) + tail;
  return `${OPEN}${encodeURIComponent(raw)}:${opts.text != null ? "t" : ""}-->${esc(shown)}${CLOSE}${tail}`;
}

// ── lookup ──
let archCol = null, archAt = 0;
async function hasArchived(q) {
  if (archCol === true || (archCol === false && Date.now() - archAt < 60e3)) return archCol;
  try {
    archCol = (await q("PRAGMA table_info(users)")).some((c) => c.name === "archived_at");
  } catch (e) { archCol = false; }
  archAt = Date.now();
  return archCol;
}

const isCf = (u) => /^cf[a-z0-9]{8}$/i.test(String(u || ""));
let displaynames = null;
function displayOf(r) {
  if (!displaynames) { try { displaynames = require("./displaynames"); } catch (e) { displaynames = { usable: (s) => String(s || "").trim() }; } }
  return displaynames.usable(r.displayname) || r.username;
}

const stats = { lookups: 0 };
let query = getQuery;

/** Names -> Map(key -> {username, display}) for the ones with a live account. ONE users query. */
async function lookup(names) {
  const keys = [...new Set([...names].map(keyOf).filter(Boolean))].slice(0, MAX_KEYS);
  const out = new Map();
  if (!keys.length) return out;
  const live = (await hasArchived(query)) ? " AND archived_at IS NULL" : "";
  const ph = keys.map(() => "?").join(",");
  stats.lookups++;
  const rows = await query(
    `SELECT username, displayname, camfrogUsername FROM users
      WHERE (LOWER(camfrogUsername) IN (${ph}) OR LOWER(username) IN (${ph}))${live}`, [...keys, ...keys]);
  const best = new Map();       // key -> [rank, row]
  const want = new Set(keys);
  const offer = (k, rank, r) => {
    if (!want.has(k)) return;
    const cur = best.get(k);
    if (!cur || rank < cur[0]) best.set(k, [rank, r]);
  };
  for (const r of rows) {
    if (!r.username) continue;
    const cf = String(r.camfrogUsername || "").toLowerCase();
    const un = String(r.username).toLowerCase();
    if (cf) offer(cf, isCf(r.username) ? 1 : 0, r);   // the login: a real account before a CF auto one
    offer(un, 2, r);                                   // a PATV username
  }
  for (const [k, [, r]] of best) out.set(k, { username: r.username, display: displayOf(r) });
  return out;
}

/** The href of a profile. */
const profileHref = (username) => "/u/" + encodeURIComponent(String(username)) + "/profile";

/** The html for one resolved name (exported for code that builds html itself). */
function linkHtml(raw, acc, shownIfPlain) {
  if (!acc) return esc(shownIfPlain != null ? shownIfPlain : raw);
  return `<a class="ulink" href="${profileHref(acc.username)}" title="${esc(raw)}">${esc(acc.display)}</a>`;
}

/** Resolve every marker in a rendered page (one lookup). Markers that can't be resolved become their plain text. */
async function finish(html) {
  if (typeof html !== "string" || html.indexOf(OPEN) < 0) return html;
  const names = [];
  html.replace(MARK_RE, (m, enc) => { try { names.push(decodeURIComponent(enc)); } catch (e) { /* bad marker */ } return m; });
  let found = new Map();
  try { found = await lookup(names); } catch (e) { console.error("[userlinks] lookup:", e.message); }
  return html.replace(MARK_RE, (m, enc, flags, inner) => {
    let raw = "";
    try { raw = decodeURIComponent(enc); } catch (e) { return inner; }
    const acc = found.get(keyOf(raw));
    return acc ? linkHtml(raw, acc) : inner;
  });
}

/** Strip markers without a lookup (a page that failed to resolve still reads right). */
const strip = (html) => (typeof html === "string" ? html.replace(MARK_RE, (m, enc, flags, inner) => inner) : html);

// ── pads ──
const slugify = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
/** A known pad for a room name / id, synchronously (registry cache, then the bridge's slugs), or null. */
function padFor(room) {
  const s = String(room == null ? "" : room).trim();
  if (!s) return null;
  try {
    const rooms = require("./rooms");
    let R = rooms.getCached ? rooms.getCached(s) : null;
    if (!R) {
      const pads = require("./pads");
      R = pads.padBySlugSync(slugify(s)) || pads.padBySlugSync(s.toLowerCase());
    }
    return R || null;
  } catch (e) { return null; }
}
/** "<room>" as a link to its pad page when it's a known pad, else the escaped name (or `fallback`). */
function padLink(room, fallback) {
  const R = room ? padFor(room) : null;
  if (!R) return esc(room || fallback || "");
  let href;
  try { href = require("./pads").padHref(R); } catch (e) { href = "/p/" + encodeURIComponent(R.slug || slugify(room)); }
  return `<a class="pad-link" href="${esc(href)}" title="${esc("p/" + (R.slug || ""))}">${esc(room)}</a>`;
}

// ── Express ──
function install(app) {
  if (!app || app.__userlinks) return app;
  app.__userlinks = true;
  app.locals.ul = ul;
  app.locals.padLink = padLink;
  app.locals.ulEsc = esc;          // for views that build a line from escaped text + ul() links
  const proto = app.response;
  const orig = proto.render;
  proto.render = function render(view, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const res = this, req = this.req;
    orig.call(this, view, options, (err, html) => {
      if (err) return callback ? callback(err) : req.next(err);
      finish(html).catch((e) => { console.error("[userlinks] render:", e.message); return strip(html); })
        .then((out) => (callback ? callback(null, out) : res.send(out)));
    });
  };
  return app;
}

/** SQL for "users.archived_at, or NULL when the column isn't there" (for code that links names itself). */
async function archivedCol(alias = "") {
  return (await hasArchived(query)) ? `${alias ? alias + "." : ""}archived_at` : "NULL";
}

module.exports = { install, ul, padLink, padFor, lookup, finish, strip, linkHtml, keyOf, profileHref, stats, archivedCol,
  _setQuery: (fn) => { query = fn || getQuery; archCol = null; } };
