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

// ── S1 Q5b (release L3): the structured look the chat hub gets (seam plan §12.4, CA §5.5, ADR 0007 D13) ──
// ONE builder serves the looks/changed topic (huboutbox's trigger rows, read when they post), its snapshot (hublooks.js)
// and the hub's POST /internal/v1/looks call (hubinbound.js): buildLooks(userIds, {card}) -> Map(userId -> payload).
//
//   {acct, v1_user, handle?, display, bot, verified,
//    avatar: {url? (https, absolute), hue, deco?: {item, ring?: {colors, w, glow, spin}, emoji?}},
//    name: {kind: "solid"} | {item, kind: solid|gradient, colors, anim?, period_s?},     (no `solid`: the hub derives it)
//    text?: {color?, font, scope: "all"},                                                (users.text_style, textstyle.js)
//    badges: [{id, icon?, label_key}] (≤ 8), profile?: {effect?, banner?, border?}, gtf?: {hat, mask, outfit, prop, bg, frame},
//    flairs: {<hub_pad_id>: "f<id>"}, auto: {supporter: tier | null, plex: bool, plus_pads: [hub_pad_id]},
//    valid_until: ms | null, h}
//   -> {acct, v1_user, gone: true}   no users row (purged, merged away) or a done deletion (its row is a pseudonym)
//
// Every source is read from the database now (never the module caches: a perk's state is the hub's state only when the row
// posts). The cosmetics are the equipped, unlocked copies whose perk is live (cosmetics.js's own rule), as structured fields
// (cosmeticstyle.js, Q5a). Bots (Pepe) get a bot badge and nothing else. `valid_until` is the earliest end among the
// time-bounded parts the look shows: an equipped Season Pass / Plex perk item, the 📼 Plex auto flair, the 💎 Plus pads.
// `h` = sha256 hex of the canonical JSON of the payload without h, always over the card look, so a chat-only answer
// (card false: no profile, no gtf) never moves the hub's v by itself.
const crypto = require("crypto");
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const BOT_BADGE = { id: "bot", icon: "badges/bot", label_key: "badge.bot" };
const MAX_BADGES = 8;
const SHOWCASE_MAX = 3;

/** Canonical JSON (seam plan §12.4): keys sorted by UTF-16 code unit at every depth, arrays in order, no whitespace. */
function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
/** The look's h: lower-case hex sha256 of the canonical payload without h. */
function lookHash(p) {
  const rest = {};
  for (const k of Object.keys(p)) if (k !== "h") rest[k] = p[k];
  return crypto.createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}
/** §12.4's default-look rule (the looks snapshot lists only non-default looks; acct, handle, display, bot, verified,
 *  avatar.hue and h don't count). */
function isDefaultLook(p) {
  if (!p || p.gone) return false;
  const a = p.avatar || {};
  const auto = p.auto || {};
  return !a.url && !a.deco && !!p.name && Object.keys(p.name).length === 1 && p.name.kind === "solid" && !p.text && !p.entrance &&
    !p.profile && !p.gtf && !(p.badges || []).length && !Object.keys(p.flairs || {}).length && auto.supporter == null && auto.plex === false &&
    !(auto.plus_pads || []).length && p.valid_until == null;
}

/** The site's own origin for avatar paths (https only: the hub refuses anything else). */
function siteOrigin() {
  const s = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
                   (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/"'<>()\\]+$/.test(s) ? s : null;
}
/** users.avatar -> an absolute https URL for the hub, or null (the default placeholder, an unsafe value, no https origin). */
function avatarUrl(raw) {
  const a = avatarOf(raw);
  if (!a) return null;
  if (a.startsWith("https://")) return a;
  const o = siteOrigin();
  const u = o ? o + a : null;
  return u && u.length <= 2048 ? u : null;
}
function cleanDisplay(s) {
  const t = Array.from(String(s == null ? "" : s).replace(CTRL_RE, "").trim()).slice(0, 64).join("").trim();
  return t || null;
}
const tableExists = async (t) => (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const inList = (n) => Array(n).fill("?").join(",");
async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) out.push(...(await fn(ids.slice(i, i + 400))));
  return out;
}
const minEnd = (a, b) => (b == null || !Number.isFinite(b) ? a : a == null ? b : Math.min(a, b));
/** The achievement ids of achievements.json (a showcased badge must be one): read once, never through achievements.js, whose
 *  load writes the badges table. null when the catalog can't be read (then any owned badge id counts). */
let ACH_IDS;
function achievementIds() {
  if (ACH_IDS === undefined) {
    try {
      const cat = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "achievements.json"), "utf8"));
      ACH_IDS = new Set((cat.achievements || []).map((a) => String(a.id)));
    } catch (e) { ACH_IDS = null; }
  }
  return ACH_IDS;
}

/**
 * The structured looks of these accounts (users.userId), read now. -> Map(userId -> payload); every requested id is in it
 * (a gone payload for an account v1 no longer has). opts.card false leaves profile and gtf out (h unchanged).
 * The tables the sources need exist (hublooks.init() ran) - safe inside the poster's transaction.
 */
async function buildLooks(userIds, { card = true, t = Date.now() } = {}) {
  const ids = [...new Set([...(userIds || [])].filter((x) => x != null && x !== "").map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const HO = require("./huboutbox");
  const C = require("./cosmetics");
  const CS = require("./cosmeticstyle");
  const TS = require("./textstyle");
  const P = require("./premium");
  const users = new Map((await chunked(ids, (part) => getQuery(
    `SELECT userId, username, displayname, avatar, text_style, camfrogUsername, discordId, twitchId, isEmailVerified, email
     FROM users WHERE userId IN (${inList(part.length)})`, part))).map((r) => [String(r.userId), r]));
  const done = new Set();
  if (await tableExists("account_deletions")) {
    for (const r of await chunked(ids, (part) => getQuery(`SELECT DISTINCT user_id FROM account_deletions WHERE state = 'done' AND user_id IN (${inList(part.length)})`, part))) {
      done.add(String(r.user_id));
    }
  }
  const live = ids.filter((id) => users.has(id) && !done.has(id));
  const liveSet = new Set(live);
  const people = live.filter((id) => id !== PEPE_ID);
  // the sources, one query (per 400 ids) each
  const equips = new Map();                                // userId -> {kind: item}
  for (const r of await chunked(people, (part) => getQuery(
    `SELECT e.user_id, e.kind, c.item_id FROM user_cosmetic_equips e
     JOIN user_cosmetics c ON c.id = e.inv_id AND c.user_id = e.user_id AND c.locked = 0 WHERE e.user_id IN (${inList(part.length)})`, part))) {
    const it = C.byId(r.item_id);
    if (!it || it.kind !== r.kind) continue;
    if (!equips.has(String(r.user_id))) equips.set(String(r.user_id), {});
    equips.get(String(r.user_id))[r.kind] = it;
  }
  const passes = await P.subsFor("season_pass", people);
  const plex = await require("./plexmembers").membersFor(people, t);
  let plexFlairOn = false;
  try { plexFlairOn = !!require("./mediaconf").get().plex_flair; } catch (e) { plexFlairOn = false; }
  const sup = await require("./supporter").tiersFor(people);
  const proofs = await require("./verified").tableProofsMany(live);
  const showcase = new Map();                              // userId -> [achievement id]
  for (const r of await chunked(people, (part) => getQuery(`SELECT user_id, badges FROM user_badge_showcase WHERE user_id IN (${inList(part.length)})`, part))) {
    let list = [];
    try { list = JSON.parse(r.badges || "[]"); } catch (e) { list = []; }
    showcase.set(String(r.user_id), (Array.isArray(list) ? list : []).slice(0, SHOWCASE_MAX).map(String));
  }
  const owned = new Set();
  const wanted = [...new Set([].concat(...[...showcase.values()]))];
  if (wanted.length && (await tableExists("user_badges"))) {
    for (const r of await chunked(people, (part) => getQuery(
      `SELECT userId, badgeId FROM user_badges WHERE userId IN (${inList(part.length)}) AND badgeId IN (${inList(wanted.length)})`, [...part, ...wanted]))) {
      owned.add(String(r.userId) + "\u0000" + String(r.badgeId));
    }
  }
  const achIds = achievementIds();
  const flairs = new Map();                                // userId -> {hub_pad_id: "f<id>"}
  const assigned = await require("./padflair").hubAssignments(people);
  const PH = require("./padhub");
  const plusRooms = await chunked(people, (part) => getQuery(
    `SELECT room_id, owner_user_id FROM rooms_registry WHERE owner_kind = 'user' AND owner_user_id IN (${inList(part.length)})`, part));
  const plusSubs = await P.subsFor("prime_plus", plusRooms.map((r) => r.room_id));
  const hubIds = await PH.ofRooms(assigned.map((r) => r.room_id).concat(plusRooms.map((r) => r.room_id)));
  for (const r of assigned) {
    const pad = hubIds.get(String(r.room_id));
    if (!pad) continue;
    if (!flairs.has(String(r.user_id))) flairs.set(String(r.user_id), {});
    flairs.get(String(r.user_id))[pad] = "f" + Number(r.flair_id);
  }
  const plusPads = new Map();                              // userId -> [{pad, end}]
  for (const r of plusRooms) {
    const sub = plusSubs.get(String(r.room_id));
    const pad = hubIds.get(String(r.room_id));
    if (!sub || !pad) continue;
    const end = P.endsAt(sub, t);
    if (!(t < end)) continue;
    if (!plusPads.has(String(r.owner_user_id))) plusPads.set(String(r.owner_user_id), []);
    plusPads.get(String(r.owner_user_id)).push({ pad, end });
  }

  for (const id of ids) {
    const acct = HO.accountOf(id);
    if (!liveSet.has(id)) { out.set(id, { acct, v1_user: id, gone: true }); continue; }
    const u = users.get(id);
    const bot = id === PEPE_ID;
    const p = { acct, v1_user: id };
    if (HANDLE_RE.test(String(u.username || ""))) p.handle = String(u.username);
    p.display = cleanDisplay(u.displayname) || cleanDisplay(u.username) || (bot ? "Pepe" : "member");
    p.bot = bot;
    p.verified = require("./verified").columnProofs(u).length > 0 || (proofs.get(id) || []).length > 0;
    const avatar = {};
    const url = bot ? avatarUrl("/public/img/pepe.png") : avatarUrl(u.avatar);
    if (url) avatar.url = url;
    avatar.hue = hue(u.username);
    let validUntil = null;
    if (bot) {
      p.avatar = avatar;
      p.name = { kind: "solid" };
      p.badges = [BOT_BADGE];
      p.flairs = {};
      p.auto = { supporter: null, plex: false, plus_pads: [] };
      p.valid_until = null;
    } else {
      const eq = equips.get(id) || {};
      const pass = passes.get(id);
      const passEnd = pass ? P.endsAt(pass, t) : 0;
      const pm = plex.get(id) || null;
      const perkEnd = (it) => {                            // the end of an equipped perk item's perk; 0 = off (not drawn)
        if (!it || !C.isPerk(it)) return Infinity;
        if (it.perk === "plex") return pm ? (pm.expires == null ? Infinity : pm.expires) : 0;
        return t < passEnd ? passEnd : 0;
      };
      const drawn = {};
      for (const [kind, it] of Object.entries(eq)) {
        const end = perkEnd(it);
        if (!(end > t)) continue;
        drawn[kind] = it;
        if (end !== Infinity) validUntil = minEnd(validUntil, end);
      }
      const look = (kind) => (drawn[kind] ? CS.lookOf(drawn[kind]) : null);
      const deco = look("avatar_decoration");
      if (deco && deco.deco) avatar.deco = deco.deco;
      p.avatar = avatar;
      const nm = look("name_color");
      p.name = nm && nm.name ? nm.name : { kind: "solid" };
      const text = TS.lookText(u.text_style);
      if (text) p.text = text;
      const badges = [];
      const tier = sup.get(id);
      if (tier) badges.push({ id: "supporter." + tier.tier, icon: "badges/supporter-" + tier.tier, label_key: "badge.supporter." + tier.tier });
      for (const b of showcase.get(id) || []) {
        if (!/^[a-z0-9][a-z0-9_]{0,59}$/.test(b) || !owned.has(id + "\u0000" + b) || (achIds && !achIds.has(b))) continue;
        badges.push({ id: "ach." + b, icon: "ach/" + b, label_key: "ach.n." + b });
      }
      p.badges = badges.slice(0, MAX_BADGES);
      const profile = {};
      const fx = look("profile_effect"), banner = look("profile_banner"), border = look("profile_border");
      if (fx) profile.effect = fx.effect;
      if (banner) profile.banner = banner.banner;
      if (border) profile.border = border.border;
      if (Object.keys(profile).length) p.profile = profile;
      const gtf = {};
      for (const k of CS.GTF_OPT ? Object.keys(CS.GTF_OPT) : []) { const g = look(k); if (g) gtf[g.gtf[0]] = g.gtf[1]; }
      if (Object.keys(gtf).length) p.gtf = gtf;
      p.flairs = flairs.get(id) || {};
      const plexAuto = !!(pm && plexFlairOn);
      if (plexAuto && pm.expires != null) validUntil = minEnd(validUntil, pm.expires);
      const pads = (plusPads.get(id) || []).slice().sort((a, b) => (a.pad < b.pad ? -1 : a.pad > b.pad ? 1 : 0));
      for (const x of pads) if (x.end !== Infinity) validUntil = minEnd(validUntil, x.end);
      p.auto = { supporter: tier ? tier.tier : null, plex: plexAuto, plus_pads: pads.map((x) => x.pad) };
      p.valid_until = validUntil;
    }
    p.h = lookHash(p);
    if (!card) { delete p.profile; delete p.gtf; }
    out.set(id, p);
  }
  return out;
}

module.exports = { looks, apply, nameStyles, avatarOf, avHtml, nameHtml, hue, initial, stats, _setQuery: (q) => { query = q || getQuery; },
                   buildLooks, lookHash, canonicalJson, isDefaultLook, avatarUrl, siteOrigin, PEPE_ID, BOT_BADGE };
