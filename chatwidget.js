// chatwidget.js — the chat hub's widget, hosted by v1 (S1 V2, release L4; ADR 0007 D3, D5, D14, D15; S1 plan §2.5 V2;
// docs/chat-tickets.md "S1: the widget host"). Off until every piece below exists - nothing a member sees changes before then.
//
//   * Files: the platform repo's export vendors the built widget into public/js/patv-chat/ (a v1 commit per widget version).
//     staticFiles() serves that directory with the cache headers the widget's host contract asks for: content-hashed files
//     `public, max-age=31536000, immutable`, manifest.json and releases.json `no-cache` (same name, new content each export),
//     every file `X-Content-Type-Options: nosniff`. A SharedWorker must be same-origin, which is why v1 serves it.
//   * manifest(): public/js/patv-chat/manifest.json - schema 1, the tab entry `entries.chat` and its SRI, checked against the
//     file's bytes. Read at start-up (register()) and LOOKED AT AGAIN at most every RECHECK_MS: v1's updater restarts nothing
//     for a public/ change (deploy/patv-update.sh: static files are served live), so a vendoring commit ("chat widget X.Y.Z")
//     arrives with a pull and no restart. manifest.json (a few hundred bytes) is read; its text changed -> verified again (the
//     entry's SRI against its bytes); a manifest that couldn't be used is verified again every time (a pull writes
//     manifest.json before the patv-chat.<h>.js it names). Pages rendered before keep loading their files: the export keeps
//     the previous two versions. Anything wrong = no widget; a log line per change of state, the reason only.
//   * The hub's addresses: HUB_RT_WS (wss://rt.publicaccess.tv) and HUB_RT_API (https://rt.publicaccess.tv) - ORIGINS, as
//     the widget's page config takes them (ws: / http: only to loopback). Unset or unusable = no widget.
//   * <patv-chat> (forPad -> res.locals.chatWidget): a SITE pad (an allow-list - ADR 0007 D3: S1 allows the hub only on site
//     pads; a pad that stops being one, e.g. padconnect's Twitch connect, which keeps the pad id and so its pad_hub row, loses
//     the widget with it) at pad_hub.chat_backend = 'hub', CHAT_HUB on (v1's kill switch, read with release L1's
//     chatswitches.chatHubOnNow(): value exactly 'on'; missing or unreadable reads as off), a manifest and the addresses. Who sees the chat is padaccess's, read here (not taken from the caller): behind the 18+ gate -> its
//     card; signed out -> the "Sign in to chat" teaser (S1 has no guest sockets, so no widget download either); outside the pad
//     (padaccess.full) -> null; signed in with a hub account id -> the mount (pad = hub_pad_id, room = uuidv5(NS_PAD_MAIN,
//     hub_pad_id), slug, mode full | compact, theme dark, locale, ?line= passed through - and on such a pad a ?line= link opens
//     the Live tab, bridge.padTabsFor's lineLive); without one (a legacy id while CHAT_GENESIS_NS is unset) -> a short note.
//     Anything else -> null: the page is as before.
//   * <patv-modtools> (toolsFor): /p/<slug>/mod of a hub pad (padModPage), /admin/chat/<view> (register) and the /admin
//     overview's chat reports card - REGARDLESS of CHAT_HUB (D3: mods keep working reports after a rollback); a manifest, the
//     addresses and a signed-in hub account needed. Every permission is the hub's can() (a refusal renders "Nothing to show");
//     v1 only keeps the admin pages to the capabilities D15 names (release L1's siteperms keys chat.mod_queue and chat.audit,
//     canChat) and /p/<slug>/mod to a signed-in viewer padaccess lets in, past its 18+ gate.
//   * The admin nav's 💬 Chat group (views/partials/admin-nav.ejs): THIS slice owns its moderation links (release L1 made the
//     group for /admin/chat, its break-glass form, and left these to V2): adminNavLinks(), handed to every view as
//     app.locals.chatAdminNav, lists /admin/chat/<view> per registered capability; the nav adds them to L1's entry and opens
//     the group to chat.mod_queue / chat.audit, and siteperms.AREA_PAGES gives a chat.mod_queue holder an admin home.
//   * What the views print (res.locals.chatWidget): layout.ejs's head - the preconnect to the hub (D5) and the text styles'
//     webfonts (D14: fonts in the page's head; the widget ships none) - and partials/chat-widget-boot.ejs: the page config
//     (JSON escaped as v1 does: <, U+2028, U+2029; no ticket - the worker fetches POST /api/chat/ticket itself) and the one
//     module script with its SRI.
// Logs carry reasons only - never an account, a pad, a ticket or a key. No hub call is ever made from here (the browser's
// worker talks to the hub).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");

let DIR = path.join(__dirname, "public", "js", "patv-chat");
const URL_BASE = "/public/js/patv-chat/";
/** rt-schema's NS_PAD_MAIN (packages/rt-schema/src/ids.ts; golden/ids/pad-main.json): a pad's main room = uuidv5(this, hub_pad_id). */
const NS_PAD_MAIN = "a38452d6-3527-4dab-bfd9-8c94d9dd47a3";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.js$/;           // a manifest entry: one file name in this directory, no path
const SRI_RE = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const HASHED_RE = /\.[A-Za-z0-9_-]{8,}\.(?:js|css|json|woff2?|png|svg)$/;  // Vite's content-hashed names (`patv-chat.DxKEUOYo.js`)
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;              // the widget's own slug rule (attributes.ts)
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;            // the widget's locale rule (attributes.ts)
/** The text styles' webfonts layout.ejs doesn't already load (it has Press Start 2P): Nunito (rounded) and Comic Neue (comic),
 *  regular and bold (markdown-lite **bold**). A link of its own, so a refused family never takes the site's own fonts with it. */
const FONTS_HREF = "https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&family=Nunito:wght@400;700&display=swap";
/** <patv-modtools> views: the pad page (/p/<slug>/mod, D15) and the admin shell (/admin/chat/<view>), and who may open each. */
const PAD_VIEWS = ["reports", "held", "modlog", "bans", "lockdown"];
/** /admin/chat/<view> -> its capability: release L1's map (adminchat.MOD_VIEWS, ADR 0007 D15), one source for both slices. */
const ADMIN_VIEWS = require("./adminchat").MOD_VIEWS;
/** The admin views' names (the admin area is English): the admin nav's links and chatTools.ejs's own view links. */
const ADMIN_LABELS = { reports: "Reports", held: "Held", modlog: "Mod log", bans: "Bans", audit: "Audit (admin reads)", switches: "Retention & switches" };
/** The chat capabilities these pages use (release L1's siteperms keys: chat.mod_queue Assistant, chat.audit Admin). */
const CHAT_CAPS = new Set(Object.values(ADMIN_VIEWS));
/** How often manifest() looks at manifest.json again (a vendoring commit lands without a restart). */
const RECHECK_MS = 10 * 1000;

const once = new Set();
function logOnce(what) { if (!once.has(what)) { once.add(what); console.error("[chatwidget] " + what); } }

// ── the vendored files ──
let MANIFEST;                                   // undefined = not read yet; null = no usable manifest
let WHY = null;                                 // why there is none (the reason only)
let RAW;                                        // manifest.json's text when MANIFEST was decided (null = no file)
let CHECKED = 0;                                // when manifest() last looked
let now = () => Date.now();
function readRaw() {
  try { return fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"); } catch (e) { return null; }
}
function readManifest(raw) {
  if (raw == null) return { m: null, why: "no manifest" };
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { m: null, why: "manifest.json isn't JSON" }; }
  if (!j || typeof j !== "object" || j.schema !== 1) return { m: null, why: "manifest schema isn't 1" };
  const entry = j.entries && j.entries.chat;
  if (typeof entry !== "string" || !FILE_RE.test(entry) || entry.includes("..")) return { m: null, why: "manifest has no usable entries.chat" };
  const sri = j.sri && Object.prototype.hasOwnProperty.call(j.sri, entry) ? j.sri[entry] : null;
  if (typeof sri !== "string" || !SRI_RE.test(sri)) return { m: null, why: "manifest has no SRI for the tab entry" };
  let bytes;
  try { bytes = fs.readFileSync(path.join(DIR, entry)); } catch (e) { return { m: null, why: "the tab entry named in the manifest is missing" }; }
  const [alg, want] = [sri.slice(0, sri.indexOf("-")), sri.slice(sri.indexOf("-") + 1)];
  if (crypto.createHash(alg).update(bytes).digest("base64") !== want) return { m: null, why: "the tab entry doesn't match its SRI" };
  const version = typeof j.version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(j.version) ? j.version : null;
  return { m: { version, entry, script: URL_BASE + entry, integrity: sri }, why: null };
}
/** The widget's manifest ({version, entry, script, integrity}), or null. Cached; looked at again at most every RECHECK_MS -
 *  verified again when manifest.json's text changed, or every time while there is no usable one. */
function manifest() {
  const t = now();
  if (MANIFEST !== undefined && t - CHECKED >= 0 && t - CHECKED < RECHECK_MS) return MANIFEST;
  CHECKED = t;
  const raw = readRaw();
  if (MANIFEST !== undefined && raw === RAW && (MANIFEST || raw === null)) return MANIFEST;   // in use and unchanged; still none
  const was = MANIFEST, r = readManifest(raw);
  MANIFEST = r.m;
  RAW = raw;
  if (r.m) {
    if (was === null || (was && was.entry !== r.m.entry)) console.log("[chatwidget] widget " + (r.m.version || "?") + " in use");
  } else if (was || (r.why !== WHY && r.why !== "no manifest")) {
    console.error("[chatwidget] widget off: " + r.why);
  }
  WHY = r.why;
  return MANIFEST;
}

/** express.static for /public/js/patv-chat/ with the host contract's cache headers (mount it BEFORE the general /public). */
function staticFiles(dir) {
  const express = require("express");
  return express.static(dir || DIR, {
    index: false, redirect: false, dotfiles: "ignore", fallthrough: true,
    setHeaders(res, file) {
      const name = path.basename(file);
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (name === "manifest.json" || name === "releases.json" || !HASHED_RE.test(name)) res.setHeader("Cache-Control", "no-cache");
      else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  });
}

// ── the hub's addresses ──
const isLoopback = (h) => h === "localhost" || h === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(h);
/** An origin (no path, query, fragment or credentials) with the secure scheme, or the plain one on loopback only; else null. */
function originOf(v, secure, plain) {
  const s = String(v || "").trim();
  if (!s || s.length > 256) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== secure && !(u.protocol === plain && isLoopback(u.hostname))) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.protocol + "//" + u.host;
}
/** {ws, api} from HUB_RT_WS / HUB_RT_API, or null (unset, or a value the widget would refuse). */
function rtConfig() {
  const wsRaw = process.env.HUB_RT_WS, apiRaw = process.env.HUB_RT_API;
  if (!String(wsRaw || "").trim() && !String(apiRaw || "").trim()) return null;
  const ws = originOf(wsRaw, "wss:", "ws:"), api = originOf(apiRaw, "https:", "http:");
  if (!ws || !api) { logOnce("widget off: HUB_RT_WS / HUB_RT_API must be the hub's origins (wss:// and https://)"); return null; }
  return { ws, api };
}

// ── v1's switches and the pad's row ──
/** CHAT_HUB (ADR 0007 D3): v1's own kill switch, set only on /admin/chat (release L1). Release L1's own reader,
 *  chatswitches.chatHubOnNow(): one row read on every call (no cache, so an off - the page's or the sqlite3 CLI's - is the
 *  next page load), on = the value exactly 'on' as the hub's mirror reads it; anything else - another spelling, no row, no
 *  table, unreadable - is off. */
function hubOn() { return require("./chatswitches").chatHubOnNow().catch(() => false); }
/** The pad's hub row: {hubPadId, backend} or null (no pad_hub row / table). */
async function padRow(roomId) {
  try {
    const r = (await getQuery("SELECT hub_pad_id, chat_backend FROM pad_hub WHERE room_id = ?", [String(roomId || "")]))[0];
    if (!r || !UUID_RE.test(String(r.hub_pad_id || ""))) return null;
    return { hubPadId: String(r.hub_pad_id).toLowerCase(), backend: String(r.chat_backend || "v1") };
  } catch (e) { return null; }
}
/** A pad's main room id (ADR 0007 D2; rt-schema padMainRoomId, pinned by its golden vectors). */
function padMainRoomId(hubPadId) {
  const id = String(hubPadId || "").toLowerCase();
  if (!UUID_RE.test(id)) throw new Error("padMainRoomId: not a uuid");
  return require("uuid").v5(id, NS_PAD_MAIN);
}
/** S1 allows the hub only on SITE pads (ADR 0007 D3) - an allow-list, so everything else fails closed: a Camfrog pad (its chat
 *  is the bridge), a profile pad, a Twitch or Discord pad (padconnect's connect turns a site pad into one and keeps its id, so
 *  its pad_hub row - 'hub' included - follows it), an unknown value. */
function platformOk(platform) { return platform === "site"; }
function platformOf(roomId) {
  try { return require("./rooms").platformOf(roomId); } catch (e) { return "camfrog"; }
}
/** A site pad now: the registry says so (rooms.platformOf - its column, else what the id implies) and so does the caller, when it
 *  names a platform. */
function sitePad(roomId, platform) { return platformOk(platformOf(roomId)) && (platform == null || platformOk(platform)); }
/** ?line=<seq> as the widget takes it (a positive safe integer, digits only), or null. */
function lineOf(req) {
  const v = req && req.query ? req.query.line : null;
  return typeof v === "string" && /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v)) ? v : null;
}

// ── what the page prints ──
/** JSON for an inline <script type="application/json">: <, U+2028 and U+2029 as unicode escapes (v1's pattern). */
function escJson(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
/** The hub account id the page hints to the worker (the ticket's `sub`), or null signed out / without one. */
function acctOf(req) {
  const id = req && req.user && req.user.userId;
  if (!id) return null;
  try { return require("./chatticket").subjectOf(id); } catch (e) { return null; }
}
const localeOf = (res) => { const l = String((res && res.locals && res.locals.lang) || "en"); return LOCALE_RE.test(l) ? l : "en"; };
/** {head, boot} for a page that loads the widget: the head's preconnects + webfonts, the config + the module script. */
function pageBits(M, rt, acct) {
  const pre = [rt.api];
  const wsHttp = rt.ws.replace(/^ws(s?):/, "http$1:");
  if (wsHttp !== rt.api) pre.push(wsHttp);
  return {
    head: { preconnect: pre, fonts: FONTS_HREF },
    boot: { configJson: escJson({ ws: rt.ws, api: rt.api, assets: "/public/img/", acct: acct || null }), script: M.script, integrity: M.integrity },
  };
}

/**
 * <patv-chat> on a pad's page (bridge.js /p/:slug, mode "full") or the homepage's room panel (home.js, mode "compact" - that
 * panel shows the bridge's rooms, which are Camfrog rooms, so in S1 it fires only if a hub site pad is ever put there: ADR
 * 0007 D14's "Lounge chat" card lever, D17).
 * Who may see the chat is padaccess's and is read HERE, never taken from the caller (one place to get it right): its 18+ gate
 * (adultGate: "signin" | "confirm" -> the 18+ card instead of the chat) and the pad's level (full: an Approved pad's outsider
 * gets nothing). Sets res.locals.chatWidget and returns it (or null):
 *   {state: "mount", head, boot, mount: {pad, room, slug, mode, theme, locale, line}} | {state: "gate", gate, next} |
 *   {state: "signin", next} | {state: "unavailable"} | null (not a hub site pad, CHAT_HUB off, no widget: the page as before)
 * `next` (the sign-in / 18+ card's way back) keeps a valid ?line=.
 */
async function forPad(req, res, { roomId, slug, platform, mode = "full" } = {}) {
  const out = await decide(req, res, { roomId, slug, platform, mode }).catch((e) => {
    logOnce("mount check failed: " + String((e && e.message) || e).slice(0, 80));
    return null;
  });
  if (res && res.locals && out) res.locals.chatWidget = out;
  return out;
}
async function decide(req, res, { roomId, slug, platform, mode }) {
  if (!roomId || !sitePad(roomId, platform)) return null;
  const M = manifest(), rt = rtConfig();
  if (!M || !rt) return null;
  const row = await padRow(roomId);
  if (!row || row.backend !== "hub") return null;
  if (!(await hubOn())) return null;
  const PA = require("./padaccess");
  await PA.init();
  const viewer = req && req.user && req.user.userId ? req.user : null;
  const s = String(slug || "").toLowerCase();
  const line = lineOf(req);
  const next = "/p/" + encodeURIComponent(s) + (line ? "?line=" + line : "");
  const gate = PA.adultGate(viewer, roomId);
  if (gate !== "ok") return { state: "gate", gate: gate === "signin" ? "signin" : "confirm", next };
  if (!viewer) return { state: "signin", next };
  if (!PA.full(viewer, roomId)) return null;
  const acct = acctOf(req);
  if (!acct) return { state: "unavailable" };
  return {
    state: "mount", ...pageBits(M, rt, acct),
    mount: { pad: row.hubPadId, room: padMainRoomId(row.hubPadId), slug: SLUG_RE.test(s) ? s : null, mode: mode === "compact" ? "compact" : "full",
             theme: "dark", locale: localeOf(res), line },
  };
}

/** <patv-modtools> on this page: {state: "tools", head, boot, locale} | {state: "off", why} (no manifest / addresses / hub id). */
function toolsFor(req, res) {
  const M = manifest(), rt = rtConfig();
  if (!M) return { state: "off", why: "not_installed" };
  if (!rt) return { state: "off", why: "no_hub" };
  const acct = acctOf(req);
  if (!acct) return { state: "off", why: "no_account" };
  return { state: "tools", ...pageBits(M, rt, acct), locale: localeOf(res) };
}

// ── who may open the admin views ──
/** The signed-in account as the database has it now (a JWT's class can be stale), or null. */
async function freshMe(req) {
  if (!req || !req.user || !req.user.userId) return null;
  try { return (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(req.user.userId)]))[0] || null; }
  catch (e) { return null; }
}
/** A chat capability these pages use (D15: chat.mod_queue - Assistant by default, chat.audit - Admin): release L1's siteperms
 *  keys, with their overrides. Any other key is refused. */
function canChat(me, key) {
  if (!me || !CHAT_CAPS.has(key)) return false;
  return require("./siteperms").can(me, key);
}

/**
 * /p/<slug>/mod (pads.js): a pad at chat_backend = 'hub' gets the chat moderation page (D15: Reports, Held, Mod log, Bans,
 * Lockdown - the views and the room-settings header are <patv-modtools>'s); every other pad, and every pad while there is no
 * widget, keeps `fallback` (the 301 to the pad settings' Moderation tab). While the widget is installed a signed-out visitor
 * is sent to sign in first for EVERY slug, before the pad is looked up (so the answer never tells a visitor which pads are on
 * the hub; the address comes back here and routes by the pad). An Approved pad's outsider -> the fallback (padaccess decides
 * there). An 18+ pad's viewer padaccess's 18+ gate stops (age not confirmed, while the gate is on) -> its card, no tools.
 */
function padModPage(fallback, addUser) {
  const withUser = (req, res) => new Promise((resolve) => {
    if (req.user !== undefined || typeof addUser !== "function") return resolve(req.user);
    addUser(req, res, () => resolve(req.user));
  });
  return async (req, res, next) => {
    try {
      if (!manifest() || !rtConfig()) return fallback(req, res, next);
      const raw = String(req.params.slug || "").slice(0, 128);
      const view = PAD_VIEWS.includes(String((req.query || {}).view || "")) ? String(req.query.view) : "reports";
      const viewQ = view !== "reports" ? "?view=" + view : "";
      const u = await withUser(req, res);
      if (!u || !u.userId) return res.redirect(302, "/login?next=" + encodeURIComponent("/p/" + encodeURIComponent(raw) + "/mod" + viewQ));
      const R = await require("./roomsweb").resolveRoom(raw).catch(() => null);
      if (!R || !sitePad(R.id, R.platform || null)) return fallback(req, res, next);
      const row = await padRow(R.id);
      if (!row || row.backend !== "hub") return fallback(req, res, next);
      const slug = require("./pads").padSlug(R) || String(R.slug || "");
      const PA = require("./padaccess");
      await PA.init();
      // padaccess.full is its 18+ gate + the pad level: past the gate, full() decides (an Approved pad's outsider -> the fallback);
      // stopped by the gate, a viewer the level lets in gets the 18+ card (full() alone would send them to the settings hub)
      const gate = PA.adultGate(u, R.id);
      if (gate === "ok" ? !PA.full(u, R.id) : !PA.canSee(u, R.id)) return fallback(req, res, next);
      const tools = gate !== "ok" ? { state: "gate", gate: gate === "signin" ? "signin" : "confirm", next: "/p/" + encodeURIComponent(slug) + "/mod" + viewQ }
                                  : toolsFor(req, res);
      if (tools.state === "tools") res.locals.chatWidget = tools;
      res.set("Cache-Control", "private, no-store");
      res.set("X-Robots-Tag", "noindex");
      res.render("padChatMod", { user: u.username || null, room: { id: R.id, title: R.title || R.name || slug }, slug, view, views: PAD_VIEWS,
                                 hubPadId: row.hubPadId, tools });
    } catch (e) {
      console.error("[chatwidget] mod page:", String((e && e.message) || e).slice(0, 120));
      res.status(500).send("Couldn't load the chat moderation page.");
    }
  };
}

/**
 * The admin nav's chat moderation links (views/partials/admin-nav.ejs's 💬 Chat group; ADR 0007 D15 - this slice owns them,
 * release L1 owns the group's /admin/chat entry): [href, label, capability] per /admin/chat/<view> (release L1's keys).
 */
function adminNavLinks() {
  return Object.keys(ADMIN_VIEWS).map((v) => ["/admin/chat/" + v, ADMIN_LABELS[v], ADMIN_VIEWS[v]]);
}

/** /admin/chat/<view> (D15's admin shell; /admin/chat itself, the break-glass form, is release L1's), the admin nav's chat links
 *  (app.locals.chatAdminNav) - and the manifest, read now so a bad export is logged when the site starts. */
function register(app, { addUser }) {
  manifest();
  if (app.locals) app.locals.chatAdminNav = adminNavLinks;
  const noop = (req, res, next) => next();
  app.get("/admin/chat/:view", addUser || noop, async (req, res, next) => {
    const view = String(req.params.view || "");
    if (!Object.prototype.hasOwnProperty.call(ADMIN_VIEWS, view)) return next();
    try {
      const me = await freshMe(req);
      if (!me) { if (typeof req.flash === "function") req.flash("error", "Please log in."); return res.redirect("/login?next=" + encodeURIComponent("/admin/chat/" + view)); }
      if (!canChat(me, ADMIN_VIEWS[view])) return res.status(403).send("Forbidden");
      const SP = require("./siteperms");
      const tools = toolsFor(req, res);
      if (tools.state === "tools") res.locals.chatWidget = tools;
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      const views = Object.keys(ADMIN_VIEWS).filter((v) => canChat(me, ADMIN_VIEWS[v]));
      res.render("admin/chatTools", { user: me.username, title: "Admin · Chat", me, isAdmin: SP.can(me, "admin.sensitive_overview"),
                                      view, views, labels: ADMIN_LABELS, tools, widget: status(),
                                      errors: typeof req.flash === "function" ? req.flash("error") : [],
                                      success: typeof req.flash === "function" ? req.flash("success") : [] });
    } catch (e) {
      console.error("[chatwidget] admin view:", String((e && e.message) || e).slice(0, 120));
      res.status(500).send("Couldn't load the admin page.");
    }
  });
}

/** Middleware for /admin (the overview): the chat reports card's <patv-modtools> when the viewer holds chat.mod_queue. */
function overviewCard() {
  return async (req, res, next) => {
    try {
      const me = await freshMe(req);
      if (me && canChat(me, "chat.mod_queue")) {
        const tools = toolsFor(req, res);
        if (tools.state === "tools") res.locals.chatWidget = tools;
      }
    } catch (e) { /* the overview renders without the card */ }
    next();
  };
}

/** The widget's install state (no ids) - /admin/chat/<view>'s footer line: the vendored version, or why there's none (a broken
 *  manifest's reason), and whether the hub's addresses are set. */
function status() {
  const M = manifest();
  return { version: M ? M.version : null, entry: M ? M.entry : null, why: M ? null : WHY, hub: !!rtConfig() };
}

module.exports = { manifest, staticFiles, rtConfig, hubOn, padRow, padMainRoomId, escJson, forPad, toolsFor, canChat, padModPage, register,
                   overviewCard, status, platformOk, lineOf, adminNavLinks, NS_PAD_MAIN, FONTS_HREF, PAD_VIEWS, ADMIN_VIEWS, ADMIN_LABELS, URL_BASE,
                   RECHECK_MS,
                   _setDir: (d) => { DIR = d || path.join(__dirname, "public", "js", "patv-chat"); MANIFEST = undefined; WHY = null; RAW = undefined; },
                   _setNow: (fn) => { now = typeof fn === "function" ? fn : () => Date.now(); },
                   _reset: () => { MANIFEST = undefined; WHY = null; RAW = undefined; once.clear(); } };
