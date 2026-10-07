// userlinks.js - 1.99dt: a name on the site is a link to that person's PATV profile.
//
// Pepe's economy pages (markets, wagers, bounties, loans, lotto, stage...) print the Camfrog login he
// knows people by. In a view, write <%- ul(name) %> (or ul(name, { web: true }) for something made on
// the website) instead of <%= name %>. The helper leaves a marker; when the page has rendered, every
// marked name on it is resolved in ONE query (no N+1), and each becomes
//   <a class="ulink" href="/u/<username>" title="<login>"><PATV display name></a>
// or stays the plain, escaped name when there's no live account for it.
//
// Resolution (lookup()) - 1.99en: LINKED LOGINS ONLY, on every page (it was the bridge's rule since 1.99eb):
//   * the name, minus a leading "@", lowercased; only login-shaped names ([\w.-], 1-40) are looked up
//   * a Camfrog name links to an account ONLY when it IS that account's linked users.camfrogUsername
//     (case-insensitive). There is no users.username fallback any more: a Camfrog login that merely equals
//     someone's PATV username is never shown as that person.
//   * a value that is a PATV account rather than a Camfrog login (a site booking, a website-made capture)
//     says so: ul(name, { user: <PATV username> }) or ul(name, { uid: <users.userId> }) - resolved by that,
//     never through the Camfrog-name path. All three kinds still share ONE users query per page.
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
// <!--ul<nonce>:<raw>:<flags>[:<ref>]--> ; flags: t = custom text, u = ref is a PATV username, i = ref is a userId
const MARK_RE = new RegExp(`<!--ul${NONCE}:([^:>]*):([a-z]*)(?::([^:>]*))?-->([\\s\\S]*?)<!--/ul${NONCE}-->`, "g");
const REF_RE = /^[^\u0000-\u001f]{1,64}$/;
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

/** The lookup key for a PATV username / userId ref (1.99en), or "". */
function refKey(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || ANON.has(s.toLowerCase())) return "";
  return REF_RE.test(s) ? s : "";
}

/**
 * The marker a view prints (via <%- %>). opts: { web } adds the 🌐 marker, { anon } never links,
 * { text } shows this text instead of the name when there's no account (e.g. a display name).
 * 1.99en: { user: <PATV username> } / { uid: <userId> } - the value is a website account, not a Camfrog
 * login: resolve it by that (pass `true` to mean "the name itself is the PATV username"). An anonymised
 * name ("someone") is never linked whatever the ref.
 */
function ul(name, opts = {}) {
  const raw = String(name == null ? "" : name);
  const shown = opts.text != null ? String(opts.text) : raw;
  const tail = opts.web ? WEB : "";
  const hidden = opts.anon || ANON.has(raw.trim().toLowerCase()) || (opts.text != null && ANON.has(shown.trim().toLowerCase()));
  let kind = "", ref = "";
  if (opts.uid != null && opts.uid !== false) { kind = "i"; ref = refKey(opts.uid); }
  else if (opts.user != null && opts.user !== false) { kind = "u"; ref = refKey(opts.user === true ? raw : opts.user).toLowerCase(); }
  const key = hidden ? "" : kind ? ref : keyOf(raw);
  if (!key) return esc(shown) + tail;
  const flags = (opts.text != null ? "t" : "") + kind;
  return `${OPEN}${encodeURIComponent(raw)}:${flags}${kind ? ":" + encodeURIComponent(ref) : ""}-->${esc(shown)}${CLOSE}${tail}`;
}

// ── lookup ──
let archCol = null, archAt = 0, hasAvatar = false;
async function hasArchived(q) {
  if (archCol === true || (archCol === false && Date.now() - archAt < 60e3)) return archCol;
  try {
    const cols = await q("PRAGMA table_info(users)");
    archCol = cols.some((c) => c.name === "archived_at");
    hasAvatar = cols.some((c) => c.name === "avatar");
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

const accOf = (r) => {
  const o = { username: r.username, display: displayOf(r) };
  if (hasAvatar) o.avatar = r.avatar || null;         // 1.99ea: the room bridge shows it
  return o;
};

/**
 * 1.99en: every kind of name in ONE users query. want = { logins, usernames, ids } (any iterable each) ->
 * { logins: Map(login key -> acc), usernames: Map(lowercased username -> acc), ids: Map(userId -> acc) }.
 *   logins    - Camfrog names: match ONLY users.camfrogUsername (linked-only; a real account before a CF auto one)
 *   usernames - PATV usernames (site features that store one): users.username, case-insensitive
 *   ids       - users.userId
 * Archived accounts never match.
 */
async function resolve(want = {}) {
  const logins = [...new Set([...(want.logins || [])].map(keyOf).filter(Boolean))].slice(0, MAX_KEYS);
  const usernames = [...new Set([...(want.usernames || [])].map((v) => refKey(v).toLowerCase()).filter(Boolean))].slice(0, MAX_KEYS);
  const ids = [...new Set([...(want.ids || [])].map(refKey).filter(Boolean))].slice(0, MAX_KEYS);
  const out = { logins: new Map(), usernames: new Map(), ids: new Map() };
  if (!logins.length && !usernames.length && !ids.length) return out;
  const live = (await hasArchived(query)) ? " AND archived_at IS NULL" : "";
  const ph = (a) => a.map(() => "?").join(",");
  const where = [];
  if (logins.length) where.push(`LOWER(camfrogUsername) IN (${ph(logins)})`);
  if (usernames.length) where.push(`LOWER(username) IN (${ph(usernames)})`);
  if (ids.length) where.push(`userId IN (${ph(ids)})`);
  stats.lookups++;
  const rows = await query(
    `SELECT userId, username, displayname, camfrogUsername${hasAvatar ? ", avatar" : ""} FROM users
      WHERE (${where.join(" OR ")})${live}`, [...logins, ...usernames, ...ids]);
  const best = new Map();       // login key -> [rank, row]
  const wantL = new Set(logins), wantU = new Set(usernames), wantI = new Set(ids);
  for (const r of rows) {
    if (!r.username) continue;
    const cf = String(r.camfrogUsername || "").toLowerCase();
    if (cf && wantL.has(cf)) {
      const rank = isCf(r.username) ? 1 : 0;          // the login: a real account before a CF auto one
      const cur = best.get(cf);
      if (!cur || rank < cur[0]) best.set(cf, [rank, r]);
    }
    const un = String(r.username).toLowerCase();
    if (wantU.has(un)) out.usernames.set(un, accOf(r));
    if (r.userId != null && wantI.has(String(r.userId))) out.ids.set(String(r.userId), accOf(r));
  }
  for (const [k, [, r]] of best) out.logins.set(k, accOf(r));
  return out;
}

/** Camfrog names -> Map(key -> {username, display[, avatar]}) for the ones with a live account. ONE users query.
 *  1.99en: LINKED-ONLY for everyone (the room bridge's 1.99eb rule): a name matches ONLY an account whose
 *  linked camfrogUsername it is - no users.username fallback. `opts` is accepted for old callers
 *  ({ linkedOnly: true } is now simply the only behaviour). */
async function lookup(names, opts = {}) {     // eslint-disable-line no-unused-vars
  return (await resolve({ logins: names })).logins;
}

/** 1.99en: PATV usernames -> Map(lowercased username -> acc). For values that are website accounts. */
async function lookupUsers(usernames) {
  return (await resolve({ usernames })).usernames;
}

/** The href of a profile. */
const profileHref = (username) => "/u/" + encodeURIComponent(String(username));

/** The html for one resolved name (exported for code that builds html itself). */
function linkHtml(raw, acc, shownIfPlain) {
  if (!acc) return esc(shownIfPlain != null ? shownIfPlain : raw);
  return `<a class="ulink" href="${profileHref(acc.username)}" title="${esc(raw)}">${esc(acc.display)}</a>`;
}

/** Resolve every marker in a rendered page (one lookup). Markers that can't be resolved become their plain text. */
async function finish(html) {
  if (typeof html !== "string" || html.indexOf(OPEN) < 0) return html;
  const want = { logins: [], usernames: [], ids: [] };
  const dec = (s) => { try { return decodeURIComponent(s || ""); } catch (e) { return null; } };
  html.replace(MARK_RE, (m, enc, flags, ref) => {
    const raw = dec(enc);
    if (raw == null) return m;
    if (flags.includes("i")) want.ids.push(dec(ref) || "");
    else if (flags.includes("u")) want.usernames.push(dec(ref) || "");
    else want.logins.push(raw);
    return m;
  });
  let found = { logins: new Map(), usernames: new Map(), ids: new Map() };
  try { found = await resolve(want); } catch (e) { console.error("[userlinks] lookup:", e.message); }
  return html.replace(MARK_RE, (m, enc, flags, ref, inner) => {
    const raw = dec(enc);
    if (raw == null) return inner;
    const r = dec(ref) || "";
    const acc = flags.includes("i") ? found.ids.get(refKey(r))
      : flags.includes("u") ? found.usernames.get(refKey(r).toLowerCase())
        : found.logins.get(keyOf(raw));
    return acc ? linkHtml(raw, acc) : inner;
  });
}

/** Strip markers without a lookup (a page that failed to resolve still reads right). */
const strip = (html) => (typeof html === "string" ? html.replace(MARK_RE, (m, enc, flags, ref, inner) => inner) : html);

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

module.exports = { install, ul, padLink, padFor, lookup, lookupUsers, resolve, refKey, finish, strip, linkHtml, keyOf, profileHref, stats, archivedCol,
  _setQuery: (fn) => { query = fn || getQuery; archCol = null; } };
