// userlook.js - 1.99ex: how a person looks wherever the site shows them (feed posts, comments, the post page, Hop,
// DMs, notices): their profile photo (users.avatar - the same picture the profile header shows) and their equipped
// name style (cosmetics.js name_color: a colour or gradient), so a name in the feed looks like it does in chat,
// the bridge and the rankings.
//
//   looks({ ids, usernames }) -> Map keyed by userId AND lowercased username -> { avatar, nameCss }
//     ONE users query for the whole page / API response (no N+1); name styles come from cosmetics' shared cache
//     (one query for everyone, refreshed every minute).
//   avatarOf(raw) -> a safe photo URL or null: https:// or a site path only; the default placeholder is "no photo".
//   avHtml(person, { size, cls }) / nameHtml(person, { href, cls }) -> markup for views (escaped).
//     person: { username, display, avatar, nameCss, bot }. Pepe stays Pepe (his frog, no name style).
// There is no "hide my photo" setting on PATV today (the profile header always shows it); if one is added, apply it
// in looks() so every surface follows.
"use strict";
const { getQuery } = require("./dbUtils");

const PEPE_ID = "pepe-bot";
const DEFAULTS = new Set(["", "avatar.png", "/public/img/avatar.png", "/img/avatar.png"]);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function avatarOf(raw) {
  const u = String(raw == null ? "" : raw).trim();
  if (DEFAULTS.has(u)) return null;
  if (/^https:\/\/[^\s"'<>()\\]+$/.test(u) && u.length <= 600) return u;
  if (/^\/[A-Za-z0-9/_.\-]+$/.test(u) && !u.includes("..")) return u;
  return null;
}

/** A stable hue (0-359) - the same as feedweb's hue() and public/js/messages.js. */
function hue(s) {
  let h = 0;
  for (const ch of Array.from(String(s || ""))) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
const initial = (s) => (Array.from(String(s || "?").replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "?").toUpperCase();

let cosmetics = null;
function cx() {
  if (cosmetics === null) { try { cosmetics = require("./cosmetics"); } catch (e) { cosmetics = false; } }
  return cosmetics || null;
}
/** The equipped name style (css) for these usernames; {} when cosmetics aren't available. */
async function nameStyles(usernames) {
  const c = cx();
  if (!c || !usernames.length) return {};
  try { return await c.nameStyles(usernames); } catch (e) { return {}; }
}

const stats = { queries: 0 };
let query = getQuery;

/**
 * want: { ids: iterable of users.userId, usernames: iterable of PATV usernames } -> Map(key -> {userId, username, avatar, nameCss}).
 * Keys: the userId and the lowercased username. One users query, whatever the mix.
 */
async function looks(want = {}) {
  const ids = [...new Set([...(want.ids || [])].filter(Boolean).map(String))].slice(0, 450);
  const names = [...new Set([...(want.usernames || [])].filter(Boolean).map((s) => String(s).toLowerCase()))].slice(0, 450);
  const out = new Map();
  if (!ids.length && !names.length) return out;
  const where = [];
  if (ids.length) where.push(`userId IN (${ids.map(() => "?").join(",")})`);
  if (names.length) where.push(`LOWER(username) IN (${names.map(() => "?").join(",")})`);
  let rows = [];
  try {
    stats.queries++;
    rows = await query(`SELECT userId, username, avatar FROM users WHERE ${where.join(" OR ")}`, [...ids, ...names]);
  } catch (e) { rows = []; }
  const css = await nameStyles(rows.filter((r) => r.userId !== PEPE_ID).map((r) => r.username));
  for (const r of rows) {
    const bot = r.userId === PEPE_ID;           // Pepe stays Pepe: his frog, never a name style
    const v = { userId: r.userId, username: r.username, bot, avatar: bot ? null : avatarOf(r.avatar), nameCss: bot ? "" : css[r.username] || "" };
    out.set(String(r.userId), v);
    out.set(String(r.username).toLowerCase(), v);
  }
  return out;
}
/** Copy avatar + nameCss onto person objects ({userId?, username}) from a looks() map. Pepe (bot) gets neither. */
function apply(map, people) {
  for (const p of people) {
    if (!p) continue;
    const v = map.get(String(p.userId || "")) || (p.username ? map.get(String(p.username).toLowerCase()) : null);
    const bot = !!(p.bot || (v && v.bot));
    if (bot) p.bot = true;
    p.avatar = !bot && v ? v.avatar : null;
    p.nameCss = !bot && v ? v.nameCss : "";
  }
  return people;
}

/** The round avatar: the photo over the monogram (the monogram shows if the photo fails to load). */
function avHtml(person, opts = {}) {
  const p = person || {};
  const size = opts.size || 22;
  const cls = opts.cls ? " " + opts.cls : "";
  if (p.bot) return `<img class="av av-pepe${cls}" src="/public/img/pepe.png" alt="" width="${size}" height="${size}" aria-hidden="true">`;
  const mono = esc(initial(p.display || p.username));
  const st = `--h:${hue(p.username)}`;
  const src = avatarOf(p.avatar);
  if (!src) return `<span class="av${cls}" style="${st}" aria-hidden="true">${mono}</span>`;
  return `<span class="av av-ph${cls}" style="${st}" aria-hidden="true">${mono}<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}
/** The name, in the person's name style when they have one. href: wrap it in a link with class `cls`. */
function nameHtml(person, opts = {}) {
  const p = person || {};
  const text = esc(p.display || p.username || "");
  const styled = p.nameCss && !p.bot ? `<span class="cx-name" style="${esc(p.nameCss)}">${text}</span>` : text;
  if (!opts.href) return styled;
  return `<a class="${esc(opts.cls || "")}" href="${esc(opts.href)}">${styled}</a>`;
}

module.exports = { looks, apply, nameStyles, avatarOf, avHtml, nameHtml, hue, initial, stats, _setQuery: (q) => { query = q || getQuery; } };
