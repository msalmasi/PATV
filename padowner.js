// padowner.js — the room owner's Pepe control panel (1.99qr): /p/<slug>/owner, for a pad's owner (and site staff).
//
// One dashboard for running a Camfrog room with Pepe, each card with a plain-language explanation:
//   * 🏦 Room vault   balance, 7-day inflow / deposits / paid out, the day-by-day table and the latest moves (roomvaults.js
//                     card), and TOP UP: POST /api/rooms/:slug/vault/topup {amount, idem} queues the website action
//                     "roomvault.deposit" = exactly `!roomvault deposit <amount>` as the account's linked Camfrog login
//                     (camfrog-bot pepe_roomowner._op_web_deposit -> pepe_roomvault._rv_deposit: escrow hold -> settle,
//                     min deposit, cap, journaled, never counted as inflow). KEYED: the form's one-time key (idem) makes a
//                     double click one deposit (actions.js unique (user, idem) + Pepe's webactions.json journal).
//   * 👑 Royalties    earned / pending / paid, this period, active days, the next payout date (royalties.status)
//   * 📺 Prime Time   the pad tier's status, when it ends, renewing (premium.state)
//   * 🎬 Stage        slots, featured stream, what's next, requests waiting (mainstage.roomStage / ownerState) - run on the
//                     settings hub's Stage tab
//   * 🐸 Pepe         the room's Pepe settings: what the OWNER may change (snap, clip, mic challenges, Pepe's language -
//                     website action "room.owner", pepe_roomowner._op_web_setting, the same storage as the chat commands),
//                     the website-bridge switches (the existing /api/rooms/:slug/bridge, roomsweb.js), and - read-only -
//                     everything else Pepe runs in the room (!say, music, DJ, games, casino backend, greeter, chatty,
//                     prices) with who controls it. Pepe reports these with his owner-map sync every 2 minutes
//                     (POST /api/rooms/owners `room_settings`, stored here in room_pepe_settings).
//   * ❓ What you can do with Pepe in your room   data/owner-capabilities.json, GENERATED from Pepe's code by camfrog-bot
//                     tools/build_owner_caps.py (every owner check in the bot is listed or explicitly excluded), plus the
//                     website's owner controls (WEB_CAPS below - each names its real route, test/padowner.test.js checks
//                     every one is registered). Also public at /pads/owner-guide.
// Every write goes through an existing endpoint or a website action Pepe re-checks; nothing here grants anything new.
"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const OWNER_SETTINGS = Object.freeze({
  snap: ["on", "off"], clip: ["on", "off"], challenge: ["on", "off"],
});
// Pepe's room languages (camfrog-bot pepe_i18n.LANGS) - the select's choices; Pepe validates the value again.
const LANGS = Object.freeze([["auto", "Auto (follow the chat)"], ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"],
  ["de", "German"], ["it", "Italian"], ["nl", "Dutch"], ["pl", "Polish"], ["tr", "Turkish"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["ar", "Arabic"], ["fa", "Persian"], ["hi", "Hindi"], ["id", "Indonesian"], ["vi", "Vietnamese"], ["th", "Thai"], ["ja", "Japanese"],
  ["ko", "Korean"], ["zh", "Chinese (Simplified)"], ["zh-tw", "Chinese (Traditional)"]]);
const LANG_CODES = new Set(LANGS.map((l) => l[0]));
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SETTINGS_STALE_MS = 10 * 60 * 1000;          // Pepe re-sends every 2 min; older = he's away
// The website's owner controls (the generated list covers Pepe's side). `route` = METHOD path, checked by the tests.
const WEB_CAPS = Object.freeze([
  { id: "web_vault_topup", area: "vault", route: "POST /api/rooms/:slug/vault/topup", where: "/p/{slug}/owner#vault" },
  { id: "web_vault_rate", area: "vault", route: "POST /api/rooms/:slug/vault/rate", where: "/p/{slug}#vault" },
  { id: "web_pepe_settings", area: "room", route: "POST /api/rooms/:slug/owner/setting", where: "/p/{slug}/owner#pepe" },
  { id: "web_bridge", area: "room", route: "POST /api/rooms/:slug/bridge", where: "/p/{slug}/settings?tab=camfrog" },
  { id: "web_stage_settings", area: "stage", route: "POST /api/rooms/:slug/stage-settings", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_stage_feature", area: "stage", route: "POST /api/stage/slots/:id/feature", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_stage_ban", area: "stage", route: "POST /api/rooms/:slug/ban", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_pepe_feed", area: "feed", route: "POST /api/rooms/:slug/feed/pepe", where: "/p/{slug}/settings?tab=pepe" },
  { id: "web_automod", area: "feed", route: "POST /api/rooms/:slug/automod", where: "/p/{slug}/settings?tab=pepe" },
  { id: "web_golive", area: "stage", route: "POST /api/rooms/:slug/golive", where: "/p/{slug}/settings?tab=stage" },
  { id: "web_prime", area: "tier", route: "GET /premium", where: "/premium?pad={slug}" },
  { id: "web_boost", area: "tier", route: "POST /api/rooms/:slug/boost", where: "/p/{slug}" },
]);

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery("CREATE TABLE IF NOT EXISTS room_pepe_settings (room_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)")
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── Pepe's report ──
const bool = (v) => (typeof v === "boolean" ? v : null);
const ID_RE = /^[A-Za-z0-9_.\- ]{1,120}$/;
function cleanOne(s) {
  const o = s && typeof s === "object" ? s : {};
  const sec = (x, keys) => { const out = {}; const v = x && typeof x === "object" ? x : {}; for (const k of keys) if (bool(v[k]) != null) out[k] = v[k]; return out; };
  const owner = sec(o.owner, ["snap", "clip", "challenge"]);
  const lang = o.owner && typeof o.owner.language === "string" ? o.owner.language.toLowerCase() : "auto";
  owner.language = LANG_CODES.has(lang) ? lang : "auto";
  const features = sec(o.features, ["say", "ask", "look", "roast", "camroast", "music", "music_queue", "music_play", "shop", "heist", "turf",
    "poker", "blackjack", "wheel", "trivia", "duel", "brawl", "arena", "showdown", "pictionary", "mic_flag", "cam_flag", "greeter", "chatty",
    "casino_backend", "auto_dj"]);
  const prices = {};
  for (const [k, v] of Object.entries(o.prices && typeof o.prices === "object" ? o.prices : {}).slice(0, 30)) {
    if (/^[a-z]{1,20}$/.test(k) && Number.isFinite(Number(v))) prices[k] = Math.max(0, Math.min(1e12, Math.floor(Number(v))));
  }
  const vibe = o.vibe && typeof o.vibe === "object" ? { type: String(o.vibe.type || "").replace(/[^a-z_ -]/gi, "").slice(0, 24), locked: !!o.vibe.locked } : null;
  return { owner, bridge: sec(o.bridge, ["relay", "mic", "cams", "audio", "transcripts", "cmds"]), features, prices, vibe, pepe_here: bool(o.pepe_here) };
}
/** POST /api/rooms/owners `room_settings` -> the table (the set Pepe sends replaces the rows it names). */
async function storeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  await init();
  const t = Date.now();
  let n = 0;
  for (const [id, s] of Object.entries(raw).slice(0, 500)) {
    if (!ID_RE.test(id)) continue;
    await runQuery(`INSERT INTO room_pepe_settings (room_id, data, updated) VALUES (?, ?, ?)
                    ON CONFLICT(room_id) DO UPDATE SET data = excluded.data, updated = excluded.updated`, [id, JSON.stringify(cleanOne(s)), t]);
    n++;
  }
  return n;
}
async function settingsFor(roomId) {
  await init();
  const r = (await getQuery("SELECT data, updated FROM room_pepe_settings WHERE room_id = ?", [String(roomId || "")]))[0];
  if (!r) return null;
  let d = null;
  try { d = JSON.parse(r.data); } catch (e) { d = null; }
  return d ? Object.assign(d, { updated: r.updated, stale: Date.now() - r.updated > SETTINGS_STALE_MS }) : null;
}

// ── the generated capability list ──
let CAPS = null;
function capabilities() {
  if (!CAPS) {
    try { CAPS = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "owner-capabilities.json"), "utf8")); } catch (e) { CAPS = { capabilities: [], admin_only: [] }; }
  }
  return CAPS;
}

/** Everything the owner page shows. */
async function pageData(R, viewer) {
  const web = require("./roomsweb");
  const slug = web.linkSlug(R);
  const camfrog = rooms.platformOf(R.id) === "camfrog";
  const safe = async (fn, d = null) => { try { return await fn(); } catch (e) { console.error("[padowner]", e.message); return d; } };
  const vault = camfrog ? await safe(() => require("./roomvaults").card(R.id, viewer, { canManage: true, staff: rooms.isStaff(viewer) })) : null;
  const roy = R.owner && R.owner.userId ? await safe(() => require("./royalties").status(R.id, R.owner.userId)) : null;
  const prem = await safe(() => require("./premium").state(viewer, slug));
  const stage = await safe(() => require("./mainstage").roomStage(R.id, viewer));
  const ownerStage = await safe(() => require("./mainstage").ownerState(R.id));
  const pepe = camfrog ? await safe(() => settingsFor(R.id)) : null;
  let live = null;
  try { const B = require("./bridge")._rooms.get(R.id); live = B ? { live: Date.now() - B.updated < 90000, count: B.count || 0 } : null; } catch (e) { live = null; }
  const u = (await getQuery("SELECT camfrogUsername, points_balance FROM users WHERE userId = ?", [viewer.userId]))[0] || {};
  const recent = await safe(() => require("./actions").recentFor(viewer.userId, "owner", 6), []);
  return {
    room: R, slug, camfrog, staff: rooms.isStaff(viewer), mine: !!(R.owner && R.owner.userId === viewer.userId),
    vault, roy, prime: prem && prem.pad ? prem.pad : null, primePrice: prem && prem.prices ? prem.prices.prime_time : null,
    primePerks: prem ? prem.perks : null, stage, requested: ownerStage ? ownerStage.requested.length : 0,
    pepe, live, linked: u.camfrogUsername || null, balance: Number(u.points_balance) || 0, recent,
    caps: capabilities(), webCaps: WEB_CAPS, LANGS,
  };
}

function register(app, { addUser }) {
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const jsonOnly = (req, res, next) => (req.is("application/json") && req.get("X-Requested-With") === "fetch" ? next() : bad(res, 400, "Bad request."));
  async function ownedPad(req, res) {
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { bad(res, 404, "No such pad."); return null; }
    if (!(await rooms.canManage(req.user, R.id))) { bad(res, 403, "Only this pad's owner can do that."); return null; }
    if (rooms.platformOf(R.id) !== "camfrog") { bad(res, 400, "This pad has no Camfrog room."); return null; }
    return R;
  }
  const queued = (res, e) => {
    if (e && e.message === "busy") return bad(res, 429, "You already have a few things waiting for Pepe - give him a moment.");
    if (e && e.message === "duplicate") return res.json({ ok: true, id: e.actionId || null, duplicate: true });
    console.error("[padowner]", e);
    return bad(res, 500, "Something went wrong - nothing was sent.");
  };

  // the public "What you can do with Pepe in your room" guide (the same list as the owner page's section)
  app.get("/pads/owner-guide", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.render("padOwner", { user: req.user ? req.user.username : null, guide: true, caps: capabilities(), webCaps: WEB_CAPS, slug: null, room: null });
  });

  app.get("/p/:slug/owner", addUser, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).render("notFound", { user: req.user.username, heading: "No such pad", message: "That pad isn't on PATV.", title: "Pad not found" });
      if (!(await rooms.canManage(req.user, R.id))) {
        return res.status(403).render("notFound", { user: req.user.username, heading: "Not your pad", message: "Only this pad's owner (and site admins) can open its owner panel.", title: "Not your pad" });
      }
      res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "no-store" });
      res.render("padOwner", { user: req.user.username, guide: false, ...(await pageData(R, req.user)) });
    } catch (e) {
      console.error("[padowner] page", e);
      res.status(500).send("Something went wrong.");
    }
  });

  // one owner setting -> website action "room.owner" (Pepe re-checks the owner and writes what the chat command writes)
  app.post("/api/rooms/:slug/owner/setting", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    const b = req.body || {};
    const key = String(b.key || ""), value = String(b.value || "").toLowerCase();
    const ok = key === "language" ? LANG_CODES.has(value) : Object.prototype.hasOwnProperty.call(OWNER_SETTINGS, key) && OWNER_SETTINGS[key].includes(value);
    if (!ok) return bad(res, 400, "That isn't a setting you can change here.");
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "room.owner", args: [R.id, key, value], tag: "owner",
        label: `${R.title}: ${key} ${value}` });
      await rooms.event(R.id, "pepe-setting", req.user.username || "?", `${key}=${value} (sent to Pepe)`).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // Top up the room vault = !roomvault deposit <amount> as the linked Camfrog login, keyed by the form's one-time idem
  app.post("/api/rooms/:slug/vault/topup", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    const b = req.body || {};
    const idem = String(b.idem || "");
    if (!IDEM_RE.test(idem)) return bad(res, 400, "Reload the page and try again.");
    const amount = typeof b.amount === "number" ? b.amount : /^\s*\d+\s*$/.test(String(b.amount || "")) ? parseInt(b.amount, 10) : NaN;
    const u = (await getQuery("SELECT camfrogUsername, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || {};
    if (!u.camfrogUsername) return bad(res, 403, "Link your Camfrog name first: type !verify in a Camfrog room with Pepe - deposits come from that name.");
    let card = null;
    try { card = await require("./roomvaults").card(R.id, req.user, { canManage: true }); } catch (e) { card = null; }
    const min = (card && card.deposit_min) || 1000, cap = (card && card.cap) || 50000000;
    const room = Math.max(0, cap - ((card && card.balance) || 0));
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < min) return bad(res, 400, `Top up at least ${min.toLocaleString("en-US")} PAT.`);
    if (amount > room) return bad(res, 400, room ? `The vault can take ${room.toLocaleString("en-US")} PAT more (cap ${cap.toLocaleString("en-US")}).` : "The vault is full.");
    if (amount > (Number(u.points_balance) || 0)) return bad(res, 400, "You don't have that many PAT.");
    if (card && card.live === false) return bad(res, 409, "Room vaults aren't open yet.");
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "roomvault.deposit", args: [R.id, String(amount)], tag: "owner",
        label: `${R.title}: top up ${amount.toLocaleString("en-US")} PAT`, idem });
      console.log(`[padowner] topup room=${R.id} account=${req.user.username} amount=${amount} action=${id}`);
      res.json({ ok: true, id });
    } catch (e) { queued(res, e); }
  });

  // the cards' live numbers (after a top-up / a setting)
  app.get("/api/rooms/:slug/owner/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const R = await ownedPad(req, res); if (!R) return;
    try {
      const vault = await require("./roomvaults").card(R.id, req.user, { canManage: true, staff: rooms.isStaff(req.user) });
      const u = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || {};
      res.json({ ok: true, vault, pepe: await settingsFor(R.id), balance: Number(u.points_balance) || 0 });
    } catch (e) { console.error("[padowner] state", e); bad(res, 500, "Something went wrong."); }
  });
}

module.exports = { register, init, storeSettings, settingsFor, cleanOne, capabilities, pageData, WEB_CAPS, OWNER_SETTINGS, LANGS,
                   _reset: () => { CAPS = null; } };
