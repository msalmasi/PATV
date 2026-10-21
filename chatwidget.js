// chatwidget.js — the chat hub's widget, hosted by v1 (S1 V2, release L4; ADR 0007 D3, D5, D14, D15; S1 plan §2.5 V2;
// docs/chat-tickets.md "S1: the widget host"). Off until every piece below exists - nothing a member sees changes before then.
//
//   * Files: the platform repo's export vendors the built widget into public/js/patv-chat/ (a v1 commit per widget version).
//     staticFiles() serves that directory with the cache headers the widget's host contract asks for: content-hashed files
//     `public, max-age=31536000, immutable`, manifest.json and releases.json `no-cache` (same name, new content each export),
//     every file `X-Content-Type-Options: nosniff`. A SharedWorker must be same-origin, which is why v1 serves it.
//   * manifest(): public/js/patv-chat/manifest.json, read ONCE per process (an export arrives with a deploy, which restarts the
//     site): schema 1, the tab entry `entries.chat` and its SRI, checked against the file's bytes. Anything wrong = no widget
//     (one log line, the reason only).
//   * The hub's addresses: HUB_RT_WS (wss://rt.publicaccess.tv) and HUB_RT_API (https://rt.publicaccess.tv) - ORIGINS, as
//     the widget's page config takes them (ws: / http: only to loopback). Unset or unusable = no widget.
//   * <patv-chat> (forPad -> res.locals.chatWidget): a pad at pad_hub.chat_backend = 'hub' (S1: never a Camfrog pad - ADR 0007
//     D3), CHAT_HUB on (v1's kill switch: chat_switches key 'CHAT_HUB' = 'on'; the table is release L1's - missing or
//     unreadable reads as off), a manifest and the addresses. Signed in with a hub account id -> the mount (pad = hub_pad_id,
//     room = uuidv5(NS_PAD_MAIN, hub_pad_id), slug, mode full | compact, theme dark, locale, ?line= passed through); signed
//     out -> the "Sign in to chat" teaser (S1 has no guest sockets, so no widget download either); signed in without a hub
//     account id (a legacy id while CHAT_GENESIS_NS is unset) -> a short note. Anything else -> null: the page is as before.
//   * <patv-modtools> (toolsFor): /p/<slug>/mod of a hub pad (padModPage), /admin/chat/<view> (register) and the /admin
//     overview's chat reports card - REGARDLESS of CHAT_HUB (D3: mods keep working reports after a rollback); a manifest, the
//     addresses and a signed-in hub account needed. Every permission is the hub's can() (a refusal renders "Nothing to show");
//     v1 only keeps the admin pages to the capabilities D15 names (chat.mod_queue, chat.audit - release L1's keys; until they
//     exist, their D15 default classes, canChat).
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
const ADMIN_VIEWS = { reports: "chat.mod_queue", held: "chat.mod_queue", modlog: "chat.mod_queue", bans: "chat.mod_queue",
                      audit: "chat.audit", switches: "chat.audit" };
/** D15's default class for each chat capability (siteperms-core CLASS_RANK names) - used only until release L1 registers the keys. */
const CAP_DEFAULTS = { "chat.mod_queue": "Assistant", "chat.audit": "Admin" };

const once = new Set();
function logOnce(what) { if (!once.has(what)) { once.add(what); console.error("[chatwidget] " + what); } }

// ── the vendored files ──
let MANIFEST;                                   // undefined = not read yet; null = no usable manifest
let WHY = null;
function readManifest() {
  const file = path.join(DIR, "manifest.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return { m: null, why: "no manifest" }; }
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
/** The widget's manifest ({version, entry, script, integrity}), or null (read once per process). */
function manifest() {
  if (MANIFEST === undefined) {
    const r = readManifest();
    MANIFEST = r.m;
    WHY = r.why;
    if (!r.m && r.why !== "no manifest") logOnce("widget off: " + r.why);
  }
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
/** CHAT_HUB (ADR 0007 D3): v1's own kill switch, set only on /admin/chat (release L1). Missing table / row / unreadable = off. */
async function hubOn() {
  try {
    const r = (await getQuery("SELECT value FROM chat_switches WHERE key = 'CHAT_HUB'"))[0];
    return !!r && String(r.value).trim().toLowerCase() === "on";
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) logOnce("CHAT_HUB can't be read - treated as off");
    return false;
  }
}
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
/** S1 allows the hub only on site pads (ADR 0007 D3): never a Camfrog pad (its chat is the bridge) or a profile pad. */
function platformOk(platform) { return platform !== "camfrog" && platform !== "profile"; }
function platformOf(roomId) {
  try { return require("./rooms").platformOf(roomId); } catch (e) { return "camfrog"; }
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
 * <patv-chat> on a pad's page (bridge.js /p/:slug, mode "full") or the homepage's room panel (home.js, mode "compact").
 * `gate` = padaccess.adultGate for this viewer ("ok" | "signin" | "confirm": the 18+ card instead of the chat), `open` =
 * padaccess.full (may this viewer see the pad's members-tier content). Sets res.locals.chatWidget and returns it (or null):
 *   {state: "mount", head, boot, mount: {pad, room, slug, mode, theme, locale, line}} | {state: "gate", gate, next} |
 *   {state: "signin", next} | {state: "unavailable"} | null (not a hub pad, CHAT_HUB off, no widget: the page as before)
 */
async function forPad(req, res, { roomId, slug, platform, mode = "full", open = true, gate = "ok" } = {}) {
  const out = await decide(req, res, { roomId, slug, platform, mode, open, gate }).catch((e) => {
    logOnce("mount check failed: " + String((e && e.message) || e).slice(0, 80));
    return null;
  });
  if (res && res.locals && out) res.locals.chatWidget = out;
  return out;
}
async function decide(req, res, { roomId, slug, platform, mode, open, gate }) {
  if (!roomId || !platformOk(platform || platformOf(roomId))) return null;
  const M = manifest(), rt = rtConfig();
  if (!M || !rt) return null;
  const row = await padRow(roomId);
  if (!row || row.backend !== "hub") return null;
  if (!(await hubOn())) return null;
  const s = String(slug || "").toLowerCase();
  const next = "/p/" + encodeURIComponent(s);
  if (gate === "signin" || gate === "confirm") return { state: "gate", gate, next };
  const signedIn = !!(req && req.user && req.user.userId);
  if (!signedIn) return { state: "signin", next };
  if (!open) return null;
  const acct = acctOf(req);
  if (!acct) return { state: "unavailable" };
  const q = (req && req.query) || {};
  const line = typeof q.line === "string" && /^[1-9]\d{0,15}$/.test(q.line) && Number.isSafeInteger(Number(q.line)) ? q.line : null;
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
/** A chat capability (D15: chat.mod_queue Assistant, chat.audit Admin): siteperms once release L1 registers the key (its
 *  overrides apply then), its D15 default class until then. Unknown keys are refused. */
function canChat(me, key) {
  if (!Object.prototype.hasOwnProperty.call(CAP_DEFAULTS, key)) return false;
  const core = require("./siteperms-core");
  if (core.capOf(key)) return require("./siteperms").can(me, key);
  return core.classRank(me) >= core.CLASS_RANK[CAP_DEFAULTS[key]];
}

/**
 * /p/<slug>/mod (pads.js): a pad at chat_backend = 'hub' gets the chat moderation page (D15: Reports, Held, Mod log, Bans,
 * Lockdown - the views and the room-settings header are <patv-modtools>'s); every other pad, and every pad while there is no
 * widget, keeps `fallback` (the 301 to the pad settings' Moderation tab). Signed out -> sign in first. An Approved pad's
 * outsider -> the fallback (padaccess decides there).
 */
function padModPage(fallback, addUser) {
  const withUser = (req, res) => new Promise((resolve) => {
    if (req.user !== undefined || typeof addUser !== "function") return resolve(req.user);
    addUser(req, res, () => resolve(req.user));
  });
  return async (req, res, next) => {
    try {
      if (!manifest() || !rtConfig()) return fallback(req, res, next);
      const R = await require("./roomsweb").resolveRoom(String(req.params.slug || "").slice(0, 128)).catch(() => null);
      if (!R || !platformOk(R.platform || platformOf(R.id))) return fallback(req, res, next);
      const row = await padRow(R.id);
      if (!row || row.backend !== "hub") return fallback(req, res, next);
      const u = await withUser(req, res);
      const slug = require("./pads").padSlug(R) || String(R.slug || "");
      if (!u || !u.userId) return res.redirect(302, "/login?next=" + encodeURIComponent("/p/" + slug + "/mod"));
      const PA = require("./padaccess");
      await PA.init();
      if (!PA.full(u, R.id)) return fallback(req, res, next);
      const view = PAD_VIEWS.includes(String((req.query || {}).view || "")) ? String(req.query.view) : "reports";
      const tools = toolsFor(req, res);
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

/** /admin/chat/<view> (D15's admin shell; the Chat group and /admin/chat itself are release L1's). */
function register(app, { addUser }) {
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
                                      view, views, tools,
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

/** /admin/keys#seam-style status (no ids): the manifest's version or why there's none, whether the addresses are set. */
function status() {
  const M = manifest();
  return { version: M ? M.version : null, entry: M ? M.entry : null, why: M ? null : WHY, hub: !!rtConfig() };
}

module.exports = { manifest, staticFiles, rtConfig, hubOn, padRow, padMainRoomId, escJson, forPad, toolsFor, canChat, padModPage, register,
                   overviewCard, status, platformOk, NS_PAD_MAIN, FONTS_HREF, PAD_VIEWS, ADMIN_VIEWS, URL_BASE,
                   _setDir: (d) => { DIR = d || path.join(__dirname, "public", "js", "patv-chat"); MANIFEST = undefined; WHY = null; },
                   _reset: () => { MANIFEST = undefined; WHY = null; once.clear(); } };
