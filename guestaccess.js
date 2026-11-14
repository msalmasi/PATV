// guestaccess.js — 1.99anv: 🚪 Guest access - which parts of the site a SIGNED-OUT visitor can open (owner, 2026-11-14: "with the
// signup change, give me an admin toggle to turn different pages on/off for guest users (i.e. turn off prize page, games pages,
// etc.)" + "they should also probably be hidden from the navbar if they are off").
//
// THE SWITCHES. One per section (GROUPS below, named as the navbar names them), all ON by default - deploying this changes
// nothing. A section that is OFF, for a signed-out visitor:
//   * its pages answer 200 with a friendly page (views/guestGate.ejs): "Sign in to see <Section>" + Sign in (/login?next=<page>)
//     + "Got an invite?" while sign-ups are invite-only, else "Sign up" (/register?next=) - invites.mode()
//   * its guest-readable JSON GET APIs answer 401 {ok: false, error: "sign_in", section, message, signin}
//   * its share-card images (/og/market|bounty|profile|post/<id>.png, /og/lotto.png) answer 404 like a missing id (og.js's rule:
//     a link-preview crawler is a signed-out visitor - the page it reads is the gate page, whose card is the generic one)
//   * it is hidden from the navbar (the top bar, More, the ☰ menu, the footer) and from the homepage's tiles / widgets that point
//     into it: views call res.locals.guestHides(href) (or guestOff(key)) - the ONE helper, set here on every request
//   * the feed's live link cards (embedcards.js) of its items answer null, like a missing item
// Signed-in members are never affected (a valid login cookie - sessions.gate has already removed a revoked one), and neither are
// requests that carry a bot credential (a resolved X-PATV-Key, or the shared bot token in X-Bot-Token / Authorization / the
// query): those routes check it themselves.
// Only GET / HEAD are gated: a guest's POST is refused by the route itself (it needs an account).
//
// NEVER GATED, whatever the switches say (NEVER below - checked first, so no section pattern can reach them): the homepage and
// /about; sign-in / sign-up / invite / SSO / password reset / e-mail verification / Camfrog claim / chat sign-in (/signin) / the 18+
// confirmation; terms, privacy, Padiquette, rules, TAKE IT DOWN and the other legal pages; robots.txt, sitemaps, /healthz,
// /sw.js, icons, /public, /media (uploaded files), /og/page.png (the generic card), /.well-known; the language pages; every bot /
// webhook / internal route (an /api path with a /bot segment or "webhook", /internal/); OBS and embeds: /g/* and /api/g/* (the OBS wheel and
// Pepe's feeds), /events (the spin stream), /onair/* (Pepe's OBS player / picture pages), /gtf/heist/overlay + /api/gtf/heist/live
// (the heist overlay), a pad's audio stream (/p/<pad>/audio, old /rooms/<pad>/audio - the homepage's 🎧), the casino tables' chat frame
// (/p/<pad>/chat?embed=1 framed by this site - Sec-Fetch-Dest iframe + Sec-Fetch-Site same-origin), chat-log download links (tokened); /api/stage/rtmp + /api/stage/hls-auth (nginx); /admin, every */admin page
// and every /api/<x>/admin API (their own gate).
// APIs the bots READ without a key stay public too (Pepe's !store reads /api/prizes, his supply / burn ticks /api/stats/supply, the
// Discord bot /api/prizes and /api/leaderboard ...): /api/prizes, /api/achievements, /api/stats/*, /api/leaderboard,
// /api/rankings/top, /api/jackpot, /api/pokernow/*, /api/cosmetics/*, /api/u/*, /api/users/*, /api/stage, /api/rooms/* (the
// homepage's live room and stage poll them too), /api/stories (the story strips - signed-out visitors only get their sign-in
// prompt anyway).
//
// Settings: guest_access (k = section key, guest_open 0 | 1, updated) - a missing row is ON; who changed it is in admin_audit (no name
// column here: nothing for account merges / deletions to follow). Read into memory at boot and re-read every
// RELOAD_MS (like invites.js), so a change made by another process lands within 30 s; this process's own change is immediate.
// A database error keeps what was last read (at boot: everything on - fail open, like the default).
// Admin: /admin/users#guests (capability auth.guest_access, Admin by default) - GET /api/admin/guest-access, POST
// /api/admin/guest-access {changes: {key: bool}, expect: {key: bool}, reason} (same-origin fetch). Every change is one admin_audit
// row "guest_access" {section, from, to}, written in the same dbUtils.tx as the setting.
"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery, tx } = require("./dbUtils");

const CAP = "auth.guest_access";
const AUDIT = "guest_access";
const RELOAD_MS = 30 * 1000;

let clock = () => Date.now();
const now = () => clock();

// ── the sections ──
const I = "i";
const re = (s) => new RegExp(s, I);
const pre = (p) => re("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:/|$)");
/**
 * [key, nav section, home page, pages, apis, og images, exceptions]. Express routes case-insensitively and with or without one
 * trailing slash, so every pattern is /i and ends in (?:/|$). The file:line of each route is in the 1.99anv report (the route map).
 */
const GROUPS = Object.freeze([
  // ── Watch & hang out ──
  { key: "pads", label: "📡 Pads & stages",
    covers: "/p (the pads directory) and every pad page, /pads/* (new pad, owners' guide), /stage (Go live, booking, captures), /rooms/*; GET /api/pads/*. Not the homepage's own front-pad room and stage, a pad's 🎧 audio stream or the casino tables' chat frame.",
    sec: "watch", home: "/p",
    pages: [pre("/p"), pre("/pads"), pre("/rooms"), pre("/stage")],
    apis: [pre("/api/pads")],
    not: [re("^/(?:pads|stage|rooms)/admin(?:/|$)"), re("^/(?:p|rooms)/[^/]+/audio/?$"), re("^/p/[^/]+/chatlog/dl/")] },
  { key: "feed", label: "📝 Feed & Hop",
    covers: "/feed and every post page (/feed/p/..., /p/<pad>/posts/..., /u/<name>/posts/...), /submit, Hop (/hop, /p/<pad>/hop, /u/<name>/hop); GET /api/feed/*, /api/hop; post share cards (/og/post). The homepage's Hot on PATV box is hidden.",
    sec: "watch", home: "/feed",
    pages: [pre("/feed"), re("^/submit/?$"), re("^/p/[^/]+/submit/?$"), re("^/(?:p|u)/[^/]+/posts/"), re("^/hop/?$"), re("^/(?:p|u)/[^/]+/hop/?$")],
    apis: [pre("/api/feed"), re("^/api/hop/?$")],
    og: [re("^/og/post/")],
    not: [pre("/feed/admin"), pre("/feed/f")] },
  { key: "plex", label: "📼 Plex",
    covers: "/plex (the Plex hub), /plex/manage, /requests; GET /api/plex/*, /api/requests/*.",
    sec: "watch", home: "/plex",
    pages: [pre("/plex"), pre("/requests")],
    apis: [pre("/api/plex"), pre("/api/requests")] },
  { key: "creators", label: "⭐ Creators",
    covers: "/creators, /creators/terms, a creator's page /creators/<name>, the dashboard /creator.",
    sec: "watch", home: "/creators",
    pages: [pre("/creators"), pre("/creator")],
    apis: [] },
  { key: "members", label: "👤 Member profiles",
    covers: "/u/<name> and its tabs, tip page and saved stories; GET /api/u/<name>/profile|transactions, /api/stories/person/<name>; profile share cards (/og/profile). Avatars stay (/api/u/<name>/avatar), and names stay visible elsewhere.",
    sec: "watch", home: "/",
    pages: [re("^/u/[^/]+(?:/|$)")],
    apis: [re("^/api/u/[^/]+/(?:profile|transactions)/?$"), pre("/api/stories/person")],
    og: [re("^/og/profile/")],
    not: [re("^/u/[^/]+/wheel/?$")] },
  // ── Play ──
  { key: "wheel", label: "🎡 Wheel",
    covers: "The Wheel link and the homepage's coin-op wheel box; /u/<name>/wheel. Never the OBS wheel (/g/wheel, /api/g/wheel/*, /events).",
    sec: "play", home: "/",
    pages: [re("^/u/[^/]+/wheel/?$")],
    apis: [] },
  { key: "markets", label: "🔮 Markets",
    covers: "/markets and every market; market share cards (/og/market); the feed's live market cards.",
    sec: "play", home: "/markets", embeds: ["m"],
    pages: [pre("/markets")], apis: [], og: [re("^/og/market/")] },
  { key: "wagers", label: "🤝 Wagers",
    covers: "/wagers.",
    sec: "play", home: "/wagers",
    pages: [pre("/wagers")], apis: [] },
  { key: "gtf", label: "🔫 Grand Theft Frogger",
    covers: "/gtf and everything under it (leaderboards, sheets, gangs, heist market, Room Wars, the live heist page); GET /api/gtf/*, /api/gangs*. Never the heist overlay OBS loads (/gtf/heist/overlay + /api/gtf/heist/live).",
    sec: "play", home: "/gtf",
    pages: [pre("/gtf"), pre("/pondlife")],
    apis: [pre("/api/gtf"), pre("/api/gangs")],
    not: [re("^/gtf/heist/overlay/?$"), re("^/api/gtf/heist/live/?$"), re("^/api/gtf/bot(?:/|$)")] },
  { key: "lotto", label: "🎟️ Lotto (Pepeball)",
    covers: "/lotto, /lotto/fair/<draw>; GET /api/lotto/state, /api/lotto/fair; the lotto share card.",
    sec: "play", home: "/lotto",
    pages: [pre("/lotto")], apis: [re("^/api/lotto/(?:state|fair)(?:/|$)")], og: [re("^/og/lotto\\.png$")] },
  { key: "bingo", label: "🎱 Bingo",
    covers: "/bingo; GET /api/bingo/state.",
    sec: "play", home: "/bingo",
    pages: [pre("/bingo")], apis: [re("^/api/bingo/state/?$")] },
  { key: "casino", label: "🃏 Casino (Blackjack & Texas Hold'em)",
    covers: "/casino and every table and tournament page, /tables, /poker, /blackjack; GET /api/casino/*, /api/tables/state.",
    sec: "play", home: "/casino",
    pages: [pre("/casino"), re("^/(?:tables|poker|blackjack|bj)/?$")],
    apis: [pre("/api/casino"), re("^/api/tables/state/?$")],
    not: [re("^/api/casino/sizing\\.js$"), re("^/(?:api/)?casino/admin(?:/|$)"), re("^/api/casino/bot(?:/|$)")] },
  { key: "bounties", label: "🎯 Bounties",
    covers: "/bounties and every bounty; bounty share cards; the feed's live bounty cards.",
    sec: "play", home: "/bounties", embeds: ["bt"],
    pages: [pre("/bounties")], apis: [], og: [re("^/og/bounty/")] },
  { key: "polls", label: "🗳️ Polls",
    covers: "/polls and every poll; the feed's live poll cards.",
    sec: "play", home: "/polls", embeds: ["p"],
    pages: [pre("/polls")], apis: [] },
  { key: "raffles", label: "🎫 Raffles",
    covers: "/raffles and every raffle; GET /api/raffles/<id>/fair; the feed's live raffle cards.",
    sec: "play", home: "/raffles", embeds: ["r"],
    pages: [pre("/raffles")], apis: [re("^/api/raffles/[^/]+/fair/?$")] },
  // ── You ──
  { key: "economy", label: "👛 Wallet, staking & How PAT works",
    covers: "/wallet, /staking, /history (PAT history), /economy (How PAT works); GET /api/burns.",
    sec: "you", home: "/economy",
    pages: [pre("/wallet"), pre("/staking"), pre("/history"), pre("/economy")],
    apis: [re("^/api/burns/?$")] },
  { key: "rankings", label: "🏆 Rankings",
    covers: "/rankings (and /supply). The bots' own leaderboard and stats feeds stay.",
    sec: "you", home: "/rankings",
    pages: [pre("/rankings"), pre("/supply")], apis: [] },
  { key: "achievements", label: "🏅 Achievements",
    covers: "/achievements; GET /api/achievements/progress. Pepe's achievement catalog feed stays.",
    sec: "you", home: "/achievements",
    pages: [pre("/achievements")], apis: [re("^/api/achievements/progress/?$")] },
  // ── Shop, sounds & support ──
  { key: "shop", label: "🏪 Prize shop",
    covers: "/shop, every item, seller and order page. Pepe's and the Discord bot's !store feed (/api/prizes) stays.",
    sec: "shop", home: "/shop",
    pages: [pre("/shop")], apis: [], not: [pre("/shop/admin")] },
  { key: "premium", label: "💎 Prime Time & Season Pass",
    covers: "/premium; GET /api/premium/state, /api/premium/padfind.",
    sec: "shop", home: "/premium",
    pages: [pre("/premium")], apis: [re("^/api/premium/(?:state|padfind)/?$")] },
  { key: "cosmetics", label: "🎨 Cosmetics & stickers",
    covers: "/cosmetics (with its Stickers tab - /stickers goes there); GET /api/stickers. The name colours everyone sees stay.",
    sec: "shop", home: "/cosmetics",
    pages: [pre("/cosmetics"), pre("/stickers")], apis: [re("^/api/stickers/?$")] },
  { key: "sounds", label: "🔊 Soundboards & voice store",
    covers: "/soundboards, /voices (+ /voices/mine, /voices/clone); GET /api/soundboards, /api/voices. A pad's soundboard clips still play.",
    sec: "shop", home: "/soundboards",
    pages: [pre("/soundboards"), pre("/voices")], apis: [re("^/api/soundboards/?$"), re("^/api/voices/?$")] },
  // ── Info & links ──
  { key: "help", label: "🐸 Pepe's commands (help)",
    covers: "/help (with /help/formatting), /commands; GET /api/help/data.",
    sec: "info", home: "/help",
    pages: [pre("/help"), pre("/commands")], apis: [re("^/api/help/data/?$")] },
  { key: "search", label: "🔍 Search",
    covers: "/search and the navbar's search box; GET /api/search.",
    sec: "info", home: "/search",
    pages: [pre("/search")], apis: [re("^/api/search/?$")] },
].map((g) => Object.freeze({ embeds: [], og: [], not: [], ...g })));
const KEYS = GROUPS.map((g) => g.key);
const BY_KEY = Object.fromEntries(GROUPS.map((g) => [g.key, g]));
const SECTIONS = ["watch", "play", "you", "shop", "info"];
const EMBED_GROUP = Object.fromEntries(GROUPS.flatMap((g) => g.embeds.map((k) => [k, g.key])));

// never gated, whatever a section's patterns say (see the header)
const NEVER = Object.freeze([
  re("^/?$"), pre("/about"), pre("/info"),
  pre("/login"), pre("/register"), pre("/signup"), pre("/forgot-password"), pre("/reset-password"), pre("/verify-email"), pre("/auth"),
  re("^/resolve-(?:twitch|discord)-conflict"), pre("/claim"), pre("/signin"), pre("/confirm-age"), pre("/settings"), pre("/logout"),
  pre("/terms"), pre("/tos"), pre("/privacy"), pre("/privacy-policy"), pre("/guidelines"), pre("/padiquette"), pre("/rules"), pre("/takedown"),
  pre("/dmca"), pre("/cookies"), pre("/legal"), pre("/support"),
  re("^/robots\\.txt$"), re("^/sitemap"), pre("/healthz"), re("^/sw\\.js$"), re("^/favicon\\.ico$"), re("^/apple-touch-icon"), pre("/public"),
  pre("/media"), re("^/og/page\\.png$"), pre("/.well-known"), pre("/i18n"), pre("/lang"), pre("/language"), pre("/translate"),
  pre("/events"), pre("/g"), pre("/api/g"), pre("/internal"), pre("/onair"), re("^/gtf/heist/overlay/?$"), re("^/api/gtf/heist/live/?$"),
  re("^/api/stage/(?:rtmp|hls-auth)(?:/|$)"), re("^/api/(?:.*/)?bot(?:/|$)"), re("^/api/.*webhook"), re("^/(?:p|rooms)/[^/]+/audio/?$"),
  re("^/p/[^/]+/chatlog/dl/"), pre("/admin"), pre("/api/admin"), re("^/(?:feed|pads|stage|shop|casino|rooms)/admin(?:/|$)"),
  re("^/api/[^/]+/admin(?:/|$)"), pre("/sb/audio"),
  // read by Pepe / the Discord / Twitch bots without a key
  re("^/api/prizes/?$"), re("^/api/achievements/?$"), pre("/api/stats"), pre("/api/leaderboard"), pre("/api/rankings"), pre("/api/jackpot"),
  pre("/api/pokernow"), pre("/api/cosmetics"), re("^/api/u/[^/]+/(?:avatar|balance|level|casino-banned|wheel)"), pre("/api/users"),
  re("^/api/stage/?$"), pre("/api/rooms"), re("^/api/stories/?$"),
]);

// ── settings ──
const OFF = new Set();
let loadedAt = 0, ready = null, loading = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS guest_access (k TEXT PRIMARY KEY, guest_open INTEGER NOT NULL, updated INTEGER)");
      await load();
    })().catch((e) => { ready = null; console.error("[guestaccess] init:", e.message); throw e; });
  }
  return ready;
}
async function load() {
  const rows = await getQuery("SELECT k, guest_open FROM guest_access");
  const off = new Set();
  for (const r of rows) if (KEYS.includes(r.k) && Number(r.guest_open) === 0) off.add(r.k);
  OFF.clear();
  for (const k of off) OFF.add(k);
  loadedAt = now();
}
/** A reload in the background when the last read is older than RELOAD_MS (never blocks a request). */
function kick() {
  if (loading || now() - loadedAt < RELOAD_MS) return;
  loading = (ready ? load() : init()).catch((e) => { loadedAt = now(); console.error("[guestaccess] reload:", e.message); }).finally(() => { loading = null; });
}
/** {key: true (open to guests) | false} for every section. */
const settings = () => Object.fromEntries(KEYS.map((k) => [k, !OFF.has(k)]));
const isOn = (key) => !OFF.has(key);

// ── who's asking ──
/** A valid login cookie (sessions.gate has already dropped a revoked one), or req.user when addUser ran. */
function signedIn(req) {
  if (req && req.user && req.user.userId) return true;
  const tok = req && req.cookies && req.cookies.jwt;
  if (!tok || !process.env.SECRET_KEY) return false;
  try { const d = jwt.verify(tok, process.env.SECRET_KEY); return !!(d && d.userId); } catch (e) { return false; }
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** A bot credential on the request (checked without counting it as a legacy-token use - the route does that). */
function botCaller(req) {
  try { if (require("./botkeys").current()) return true; } catch (e) { /* no key context */ }
  const toks = [process.env.TWITCH_BOT_TOKEN, process.env.DISCORD_BOT_TOKEN].filter((t) => typeof t === "string" && t.length >= 8);
  if (!toks.length || !req) return false;
  const q = req.query || {};
  const cands = [req.get && req.get("x-bot-token"), String((req.get && req.get("authorization")) || "").replace(/^(?:Bearer|Bot)\s+/i, ""),
                 q.botToken, q.token, q.password].filter((v) => typeof v === "string" && v);
  return cands.some((c) => toks.some((t) => safeEq(c, t)));
}

// ── matching ──
/** The casino tables' 💬 Chat panel: a pad's chat window with ?embed=1, FRAMED by this site (bridge.js chatEmbedAsked - here the
 *  browser's Sec-Fetch headers must say so: a ?embed=1 typed into the address bar is the plain chat window, and that's the pad's). */
const framedChat = (req) => !!(req && req.query && String(req.query.embed || "") === "1" && typeof req.get === "function" &&
  req.get("Sec-Fetch-Dest") === "iframe" && req.get("Sec-Fetch-Site") === "same-origin");
/**
 * Every section this path belongs to, with what it is there: [{group, kind: page | api | og}] (whatever the switches say).
 * opts.framedChat: the request is the casino tables' chat frame (framedChat(req)) - never gated.
 */
function sectionsOf(path, { framedChat: framed = false } = {}) {
  const p = String(path || "");
  if (NEVER.some((r) => r.test(p))) return [];
  if (framed && /^\/p\/[^/]+\/chat\/?$/i.test(p)) return [];
  const out = [];
  for (const g of GROUPS) {
    if (g.not.some((r) => r.test(p))) continue;
    const kind = g.og.some((r) => r.test(p)) ? "og" : g.apis.some((r) => r.test(p)) ? "api" : g.pages.some((r) => r.test(p)) ? "page" : null;
    if (kind) out.push({ group: g, kind });
  }
  return out;
}
/** The first OFF section this path belongs to, or null. */
function gatedBy(path, opts) {
  if (!OFF.size) return null;
  return sectionsOf(path, opts).find((s) => OFF.has(s.group.key)) || null;
}
/** A link (as a view writes it: "/markets", "/markets/5?x=1#y", an absolute URL of this site or another) -> its gating section or null. */
function hrefGate(href) {
  if (!OFF.size || typeof href !== "string" || !href) return null;
  let u;
  try { u = new URL(href, "http://site.invalid"); } catch (e) { return null; }
  if (u.host !== "site.invalid" && !/^\//.test(href)) return null;    // another site (Discord, Twitch...) - never ours to hide
  return gatedBy(u.pathname);
}

// ── i18n ──
let EN_T = null;
function enT() {
  if (!EN_T) { let en = {}; try { en = require("./locales/en.json"); } catch (e) { en = {}; } EN_T = require("./i18n-core")(en, en, "en"); }
  return EN_T;
}
const tr = (req, key, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : enT()(key, vars));
const plain = (s) => String(s).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const nameOf = (req, key) => tr(req, "guest.s." + key);

// ── the answer ──
function nextOf(req) {
  const guard = require("./middleware/authGuard");
  return guard.safeNext(req.originalUrl || req.url || "/") || "/";
}
function signupMode() { try { return require("./invites").mode(); } catch (e) { return "open"; } }
function refuse(req, res, hit) {
  const g = hit.group;
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Cookie");
  res.set("X-Robots-Tag", "noindex");
  if (hit.kind === "og") return res.status(404).end();
  if (hit.kind === "api") {
    const next = g.home && g.home !== "/" ? g.home : "/";
    return res.status(401).json({ ok: false, error: "sign_in", section: g.key, message: plain(tr(req, "guest.api", { section: nameOf(req, g.key) })),
                                  signin: "/login?next=" + encodeURIComponent(next) });
  }
  const next = nextOf(req);
  const mode = signupMode();
  const base = res.locals && res.locals.ogBase ? res.locals.ogBase : "";
  const title = plain(tr(req, "guest.title", { section: nameOf(req, g.key) }));
  res.status(200).render("guestGate", {
    user: null, title: title + " · publicaccess.tv",
    gate: { key: g.key, name: nameOf(req, g.key), next, mode, signin: "/login?next=" + encodeURIComponent(next), signup: "/register?next=" + encodeURIComponent(next) },
    og: { title, description: plain(tr(req, "guest.og")), image: base + "/og/page.png", url: base + (res.locals && res.locals.ogPath ? res.locals.ogPath : req.path) },
  }, (err, html) => {
    if (err) { console.error("[guestaccess] page:", err.message); return res.status(200).type("text").send(title); }
    res.send(html);
  });
}

/**
 * The views' helpers for this request: {guestHides(href), guestOff(key)} - true only for a signed-out visitor and a section that is
 * OFF (whether the visitor is signed in is worked out once, the first time a helper needs it).
 */
function viewHelpers(req) {
  let guest;
  const isGuest = () => (guest === undefined ? (guest = !signedIn(req)) : guest);
  return { guestOff: (key) => OFF.has(key) && isGuest(), guestHides: (href) => !!(OFF.size && isGuest() && hrefGate(href)) };
}
/** The site-wide middleware (index.js, after the language / time zone ones): the view helpers on every request + the gate. */
function middleware(req, res, next) {
  kick();
  Object.assign(res.locals, viewHelpers(req));
  if (!OFF.size || (req.method !== "GET" && req.method !== "HEAD")) return next();
  const hit = gatedBy(req.path, { framedChat: framedChat(req) });
  if (!hit || signedIn(req) || botCaller(req)) return next();
  return refuse(req, res, hit);
}
/** For a route that serves several sections' items (embedcards.js): is this section hidden from THIS request? */
function hiddenFor(req, key) {
  if (!key || !OFF.has(key)) return false;
  return !signedIn(req) && !botCaller(req);
}

// ── admin ──
class Refuse extends Error { constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || null; } }
const boolOf = (v) => (v === true || v === 1 || v === "1" || v === "on" || v === "true" ? true : v === false || v === 0 || v === "0" || v === "off" || v === "false" ? false : null);
/**
 * Save changes {key: bool}. admin = {userId, username}. expect = what the admin's card loaded ({key: bool}; 409 E_STALE when another
 * admin changed one of those keys meanwhile). -> {settings, changed: [keys]}. Throws Refuse.
 */
async function setSettings(admin, changes, { reason = null, expect = null } = {}) {
  await init();
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Refuse(400, "Nothing to change.", "E_EMPTY");
  const want = {};
  for (const [k, v] of Object.entries(changes)) {
    if (!KEYS.includes(k)) throw new Refuse(400, `"${String(k).slice(0, 40)}" isn't a section.`, "E_KEY");
    const b = boolOf(v);
    if (b === null) throw new Refuse(400, `${k}: on or off (true / false).`, "E_VALUE");
    want[k] = b;
  }
  if (!Object.keys(want).length) throw new Refuse(400, "Nothing to change.", "E_EMPTY");
  await load().catch((e) => console.error("[guestaccess] reload:", e.message));   // compare with what's saved NOW
  if (expect && typeof expect === "object") {
    for (const k of Object.keys(want)) {
      if (!(k in expect)) continue;
      if (boolOf(expect[k]) !== isOn(k)) throw new Refuse(409, "Another admin changed these switches since you loaded this card - reload it and try again (nothing was saved).", "E_STALE");
    }
  }
  const diff = Object.keys(want).filter((k) => want[k] !== isOn(k));
  if (!diff.length) return { settings: settings(), changed: [] };
  const why = reason ? String(reason).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || null : null;
  const t = now();
  const A = require("./adminaudit");
  await A.init();
  await tx(async () => {
    for (const k of diff) {
      await runQuery("INSERT INTO guest_access (k, guest_open, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET guest_open = excluded.guest_open, updated = excluded.updated",
                     [k, want[k] ? 1 : 0, t]);
      await A.record(admin, AUDIT, null, { section: k, from: !want[k], to: want[k] }, why);
    }
  });
  for (const k of diff) { if (want[k]) OFF.delete(k); else OFF.add(k); }
  loadedAt = now();
  console.log(`[guestaccess] ${diff.map((k) => k + (want[k] ? " on" : " OFF")).join(", ")} for guests (by ${admin.username || admin.userId})`);
  return { settings: settings(), changed: diff };
}
/** The admin card: the sections (grouped like the navbar) with what each covers, the sign-up mode, the log. */
async function adminView() {
  await init();
  if (now() - loadedAt > RELOAD_MS) await load().catch(() => {});
  const audit = await require("./adminaudit").recent(AUDIT, 30).catch(() => []);
  return {
    settings: settings(), mode: signupMode(),
    sections: SECTIONS.map((s) => ({ key: s, groups: GROUPS.filter((g) => g.sec === s).map((g) => ({ key: g.key, label: g.label, covers: g.covers, on: isOn(g.key), home: g.home })) })),
    audit,
  };
}

function register(app, { addUser }) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const SP = require("./siteperms");
  const fetchOk = (req) => guard.sameSite(req) && req.get("X-Requested-With") === "fetch";
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, CAP)) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    if (req.method === "POST" && !fetchOk(req)) { res.status(403).json({ ok: false, error: "cross-site request refused" }); return null; }
    return row;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code || null, error: e.message });
    console.error("[guestaccess] admin:", e && e.message);
    return res.status(500).json({ ok: false, error: "Something went wrong - try again." });
  };
  app.get("/api/admin/guest-access", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    try { res.json({ ok: true, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/guest-access", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    const b = req.body || {};
    const expect = b.expect && typeof b.expect === "object" && !Array.isArray(b.expect) ? b.expect : null;
    try { const r = await setSettings(me, b.changes, { reason: b.reason, expect }); res.json({ ok: true, ...r, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, register, middleware, viewHelpers, settings, isOn, setSettings, adminView, sectionsOf, gatedBy, hrefGate, hiddenFor, signedIn, botCaller, framedChat,
  GROUPS, KEYS, BY_KEY, SECTIONS, NEVER, EMBED_GROUP, CAP, AUDIT, RELOAD_MS, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reload: () => load(),
};
