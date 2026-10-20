// onair.js — 📺 "On Pepe's OBS" (1.99yt, a short-term POC): put one live pad slot (a stream, a 📼 Plex play) or one
// Camfrog cam on Pepe's MAIN stream - and with it on his OBS virtual cam, i.e. his Camfrog cam - so Camfrog users see it.
//
// How it reaches the picture (camfrog-bot pepe_onair.py does the OBS side):
//   * Pepe's OBS has a nested scene "IRL" sitting in his program scenes (Pepe / Main / PepeGame) above the background and
//     under his avatar + overlay. Its top source "IRL BB" plays the operator's own IRL feed (SRT from BELABOX cloud) and is
//     transparent while that feed is down. Pepe adds ONE more media source ("PATV OnAir") at the BOTTOM of that scene
//     (`!onair setup` / `python pepe_onair.py setup` - a deliberate one-off, never implicit).
//   * a SLOT: the source plays the slot's public HLS (nginx-rtmp /hls/<stream>.m3u8, or MediaMTX's for a WHIP slot) -
//     the same URL every viewer of the pad's stage gets. Slots on Approved pads (padaccess) are never eligible - every
//     other pad's stage is public (signed-out visitors see it too), so no read token is involved.
//   * a CAM: Pepe opens the cam in Camfrog (like a snapshot / live cam), grabs its window in a helper and encodes it to a
//     LOCAL udp MPEG-TS that the source plays (udp://127.0.0.1:<port>) - the cam never leaves the VM except inside
//     Pepe's own stream; no MediaMTX / token / VPS change.
//   * priority: the operator's IRL wins. While "IRL BB" is PLAYING Pepe hides the on-air source (it also stops decoding:
//     close_when_inactive), and shows it again when the IRL feed ends. The source sits UNDER IRL BB anyway.
//   * scene: when something goes on air (and when the IRL feed comes up) while OBS's program scene has no visible IRL
//     scene in it (Gaming, BRB, Wheel...), Pepe switches to the on-air scene (default "Pepe") and switches back when it
//     ends - only if nobody moved OBS meanwhile. Pepe's game scene (PepeGame) already contains IRL.
//
// Who / what (this module is the one home; the admin card is on /stage/admin, admins only):
//   * enabled - the KILL SWITCH (default ON on staging, OFF on prod). Off = nothing on air, Pepe hides the source.
//   * the target: {kind: 'slot', slot_id} | {kind: 'cam', room, login}, set by an admin on /stage/admin or by Pepe's
//     `!onair <pad|user|slot id>` / `!onair cam <login>` (Pepe checks his own admin list; the site trusts the bot token).
//     It ends by itself when the slot ends / stays off air LIVE_GRACE_MS / the cam leaves cam / consent goes.
//   * consent: a slot's streamer already streams publicly on that pad - they are told (inbox + Camfrog PM) and can take
//     themselves off (`!onair off` from their linked login, or POST /api/stage/onair/leave). A CAM needs the cam owner's
//     explicit opt-in for main-stream use (cam_optin, default required): Settings → Privacy (#onair) or `!onair me on` in
//     Camfrog; the live cam opt-out (livecam.js) and privacy (!bridge hide / incognito / private analytics) always win.
//     The cam owner gets a Camfrog PM from Pepe when it starts.
//   * never: NSFW slots, banned streamers; 📼 Plex library plays only with allow_library on (Pepe's main stream is
//     relayed to Twitch - restream.js - so a movie there is a DMCA risk; default off).
//   * stagefix site (V1-2 of the dynamic-stages design; Pepe's stream is public egress - the site, Twitch, his Camfrog cam,
//     VOD): never a 🎬 CAM SLOT (someone's Camfrog cam a pad owner put on a pad's stage - "cam_slot": it skipped the cam's
//     on-air opt-in; put the cam itself on, which asks its owner), never anything from an 18+ pad ("adult":
//     rooms_registry.adult, whatever the 18+ gate switch says), and a cam's own access mode counts (camaccess.js, D-9):
//     followers / request cams never ("cam_mode"); a members cam (the default) only with an on-air OK given AFTER its
//     owner last set the mode, and always with one (cam_optin off doesn't excuse it); everyone cams as before.
//     stagefix fix: "last set" = last CHANGED (camaccess mode_at: the ask switch or the same mode saved again doesn't void an
//     OK); a block with the admin and private activity are the one neutral "unavailable" (refusal, onair_log, the admin's list).
//     stagefix final round (D-9 (a)): a cam owner's "this session" OK covers picks from that pad's room only (onairconsent
//     keys it "cam:<login>@<room>"); a cam target saved before actor_ids existed gets them from its `by` at the next check.
//   * 1.99aag EMBEDS: a YouTube / Twitch embed slot goes on air in a second OBS source, a BROWSER source ("PATV OnAir Web",
//     `!onair setup embed`), that loads this site's /onair/player page (a signed per-pick token, the official YouTube IFrame
//     API / Twitch embed player, audio into the stream). The admin must tick "I have the rights to rebroadcast this" every
//     time (kept in onair_log + admin_audit: who, when). The page reports the player's state every few seconds; an embed
//     that hasn't been PLAYING for embed_stall_s (after a 60 s start grace; not counted while the IRL feed hides it) is
//     taken off - ads / "video unavailable" / an offline channel end it that way.
//   * 1.99aag CONSENT ON DEMAND (onairconsent.js): a slot on an APPROVED-only pad needs its owner's OK, a cam whose owner
//     hasn't opted in needs the cam owner's OK - the pick waits (pending) and only goes on air after Allow; Deny / no
//     answer in consent_min minutes drops it.
//   * audit: onair_log (every set / end / config change, who and why) + admin_audit rows for the web admin's actions.
//   * 1.99abj: `!onair <YouTube / Twitch link> rights` from Camfrog (the same pasted link as the player bar); ⏰ links queued
//     for later - next up, or at a time (onairqueue.js; a direct link now ends with its video so the next one starts);
//     mic_audio: the pick's sound also goes to Pepe's Camfrog mic (Pepe sets the on-air sources to monitor into his mic
//     cable - only after `!onair setup audio` - and holds the mic in rooms with `!mic onair on`).
//   * 1.99acw 🖼 PICTURES, 🔗 LINK CARDS, 🌐 LIVE PAGES (onairmedia.js has the pipeline): a third pick kind "media" with a `media`
//     sub-object {mode: image|card|live, lane: main|corner, corner, secs, until, caption, asset, card, direct, live}. Two LANES:
//     "main" is the old single TARGET (a full-screen picture replaces whatever is on, under the IRL feed like any pick); "corner"
//     is a new OVERLAY slot shown OVER the current scene (also over a stream already on air), hidden while the IRL feed is live
//     unless overlay_over_irl. A proxied picture / card is our own page (/onair/show?t=<signed per-pick token>, a strict CSP,
//     pictures only from /onair/m/); a DIRECT picture is the same page loading it from its own site (unscanned; locked capability
//     onair.direct_media, Staff - CSP img-src allows exactly that origin); a LIVE page is the page itself in a dedicated OBS
//     browser source (locked capability onair.live_page, Staff, plus the live_pages switch). Every media pick ends at `until`
//     (media_secs / live_secs default, media_max_s / live_max_s / direct_max_s max); one live page at a time. Media needs both
//     switches (enabled + media_enabled) and a Pepe that says he can (caps ["media", …] + state.media_ok after
//     `!onair setup media`) - an older Pepe is simply refused, and an older Pepe never shows the new kind anyway.
//     ✂ / !onair off clear both lanes; "off corner" only the corner. Everything is in onair_log (+ the full URL in its url
//     column) and admin_audit; the rights word / tick is required as for links.
//     1.99acw review: ⛔ Cut + block (the bar, `!onair off [corner] block`, the recent-pictures list, an image-safety "fn" mark)
//     blocks what was shown for good (onairmedia.block); refused / failed media jobs are logged ("refused", with the safety
//     check's id) and counted per PERSON (a linked chat login = its account) - unsafe strikes block that person's requests;
//     live_pages is off by default everywhere and a live page / direct picture also needs Pepe's "live" / "direct" cap (sent only
//     after his VM-local firewall attestation); a queued direct picture / live page is re-checked against its queuer's current
//     role (chat: plays within an hour) and gets its checks again at play time (live_deny, the direct picture's type probe).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const STAGING = !!process.env.STAGING;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const OBS_NAME_RE = /^[^\u0000-\u001f"\\]{1,60}$/;
const LIVE_GRACE_MS = 90 * 1000;        // a slot on air that isn't live this long is taken off
const BOT_FRESH_MS = 30 * 1000;
const AUDIT = "onair";
// 1.99ack: who may pick / cut = onair.operate, the settings = onair.config (siteperms.js)
const EMBED_GRACE_MS = 60 * 1000;       // an embed's start (player load, a pre-roll ad) before the stall clock runs
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const SITE = () => String(process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

const DEFAULTS = Object.freeze({
  enabled: STAGING,              // the kill switch
  cam_optin: true,               // a cam needs its owner's opt-in for the main stream
  allow_library: false,          // 📼 Plex library plays (Twitch relay = DMCA risk)
  auto_scene: true,              // switch OBS to `scene` when the program scene has no IRL in it
  // 1.99aaa: IRL auto-switch - the operator's IRL feed going live while OBS is on one of irl_from switches OBS to `scene`
  // (and back when it ends). Needs the IRL feed source always-on (Pepe's one-off `!onair setup irl`). Independent of
  // `enabled` (that one is the 3rd-party on-air kill switch).
  irl_switch: true,
  irl_from: "Pepe, PepeGame, BRB, Gaming",   // comma-separated OBS scene names (1.99aal: + Pepe / PepeGame - their Wheel / game overlay cover the IRL)
  scene: "Main",                 // OBS: the program scene to switch to (1.99aal: "Main" - "Pepe" has the Wheel over the IRL scene)
  irl_scene: "IRL",              // OBS: the nested scene that holds the IRL feed + the on-air source
  irl_source: "IRL BB",          // OBS: the operator's IRL feed (wins while PLAYING)
  source: "PATV OnAir",          // OBS: the on-air media source
  web_source: "PATV OnAir Web",  // OBS: the on-air browser source (embeds, 1.99aag)
  embed_stall_s: 90,             // an embed not PLAYING this long is taken off
  consent_min: 10,               // an owner's on-demand OK expires after this many minutes
  cam_fps: 15,                   // a cam on air: Pepe's local encode
  cam_kbps: 1500,
  mic_audio: false,              // 1.99abj: the pick's sound into Pepe's Camfrog mic (needs `!onair setup audio` once)
  // 1.99acw: 🖼 pictures / 🔗 cards / 🌐 live pages (onairmedia.js)
  media_enabled: true,           // the owner's "onair_media" switch (staff-only feature; needs `enabled` too)
  // live pages: OFF everywhere by default (the staging Pepe VM sits on the same home LAN). Switching it on is not enough: Pepe
  // also has to send the "live" cap, which he does only once his VM's firewall attestation is set (see pepe_onair.live_gate)
  live_pages: false,
  overlay_over_irl: false,       // corner items stay up over the operator's IRL feed (default: hidden while it's live - IRL wins)
  corner_source: "PATV OnAir Corner",   // OBS: the corner browser source (canvas-sized; the page draws the box)
  live_source: "PATV OnAir Live",       // OBS: the live-page browser source (1280x720, no OBS access)
  top_scene: "PATV OnAir Top",          // OBS: the nested scene on top of each program scene that holds the corner items
  top_scenes: "Main, Pepe, PepeGame, BRB, Gaming",   // program scenes that get the Top scene (`!onair setup media`)
  media_secs: 30, media_max_s: 600,     // a picture / card: default and max seconds
  live_secs: 60, live_max_s: 600,       // a live page
  direct_max_s: 120,                    // a direct (unscanned) picture - the host can change it while it's up
  corner_pct: 30,                       // the corner box, % of the canvas width
  max_image_mb: 8,                      // a picture's size cap (link or upload)
  media_per_10min: 8,                   // jobs per person per 10 minutes
  live_deny: "",                        // more hosts a live page may never open (the site's own hosts always refused)
});
const BOOLS = ["enabled", "cam_optin", "allow_library", "auto_scene", "irl_switch", "mic_audio", "media_enabled", "live_pages", "overlay_over_irl"];
const NAMES = ["scene", "irl_scene", "irl_source", "source", "web_source", "corner_source", "live_source", "top_scene"];
const NUMS = { cam_fps: [5, 30], cam_kbps: [200, 6000], embed_stall_s: [30, 600], consent_min: [1, 60],
               media_secs: [5, 600], media_max_s: [10, 600], live_secs: [10, 600], live_max_s: [10, 600], direct_max_s: [10, 300],
               corner_pct: [15, 50], max_image_mb: [1, 15], media_per_10min: [1, 60] };
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

let clock = () => Date.now();
const now = () => clock();
const S = () => require("./mainstage");
const PA = () => require("./padaccess");
const rooms = () => require("./rooms");
const bridge = () => require("./bridge");
const LC = () => require("./livecam");
const C = () => require("./onairconsent");
const EMB = () => require("./stageembed");
const Q = () => require("./onairqueue");
const M = () => require("./onairmedia");

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code || null; } }

const WHY = {
  gone: "That slot doesn't exist.",
  ended: "That slot has ended.",
  not_live: "That slot isn't live.",
  rights: "Tick \"I have the rights to rebroadcast this\" first - an embed goes out on Pepe's stream and his Twitch relay.",
  embed_bad: "That embed link can't be played.",
  nsfw: "That slot is marked NSFW.",
  pad_private: "That pad is Approved-only - its owner has to allow it first (ask them).",
  denied: "The owner said no.",
  consent_expired: "The owner didn't answer in time.",
  consent_revoked: "The pad owner revoked their OK.",
  embed_not_playing: "The embed stopped playing (ended, an ad, unavailable or offline).",
  embed_ended: "The video ended.",
  banned: "That streamer is banned from the stage.",
  library: "📼 Plex plays are off for Pepe's main stream (allow_library) - his stream is relayed to Twitch.",
  offline: "That Camfrog room isn't live on the site.",
  room_off: "Cams aren't bridged in that room (!bridge cams on).",
  not_on_cam: "They aren't on cam.",
  livecam_off: "They've switched off live video of their cam.",
  private: "They keep their room activity private.",
  no_optin: "They haven't allowed their cam on Pepe's main stream (Settings → Privacy, or !onair me on in Camfrog).",
  // stagefix site
  cam_slot: "That's someone's Camfrog cam on a pad's stage - put the cam itself on Pepe's stream (that asks its owner).",
  adult: "That pad is 18+ - nothing from it goes on Pepe's public stream.",
  cam_mode: "They only show their cam to some people (followers or on request) - it can't go on Pepe's public stream.",
  unavailable: "That cam isn't available right now.",
  self: "That's Pepe's own cam.",
  off: "On-air is switched off (/stage/admin).",
  // 1.99acw: pictures / cards / live pages
  media_off: "Pictures and links on Pepe's stream are switched off (/stage/admin).",
  live_off: "Live pages are switched off (/stage/admin → Pictures & links).",
  pepe_away: "Pepe hasn't checked in - nothing can go on his OBS right now.",
  media_old_bot: "Pepe needs 1.99acv for pictures and links on his stream.",
  media_setup: "Pepe's OBS isn't set up for pictures and links yet - run !onair setup media.",
  live_setup: "Pepe's OBS can't show live pages (run !onair setup media - it needs an OBS whose browser source has page permissions).",
  // 1.99acw review: Pepe sends the "live" / "direct" caps only after the VM-local steps (his own reason is added when he gives one)
  live_fw: "Pepe's VM isn't firewalled for live pages yet",
  direct_fw: "Pepe's VM isn't firewalled for direct pictures yet - use a normal (checked) picture",
  person_blocked: "You can't put pictures or links on Pepe's stream right now (some of yours weren't safe for it) - an admin can lift that.",
  live_busy: "A live page is already on - ✂ cut it first.",
  media_done: "Its time was up.",
  pepe_cant: "Pepe's OBS can't show pictures and links any more.",
  pepe_refused: "Pepe's computer refused that address.",
  media_failed: "The picture didn't load - the site may block hotlinking or redirect elsewhere.",
};

// ── storage ──
let CFG = { ...DEFAULTS };
let TARGET = null;              // {id, kind, slot_id?, room?, login?, display?, pad, label, by, at, notified?} - the MAIN lane
let OVERLAY = null;             // 1.99acw: the CORNER lane - a media pick shown over the current scene (kind "media" only)
let V = 0;
let BOT = null;                 // {at, state, caps}
let OPTIN = new Map();          // login -> {on, updated, via}
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_state (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL, cfg TEXT NOT NULL,
                      target TEXT, updated_at INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_optin (login TEXT PRIMARY KEY, on_air INTEGER NOT NULL, updated INTEGER NOT NULL,
                      via TEXT, user_id TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, what TEXT NOT NULL,
                      by TEXT, kind TEXT, ref TEXT, label TEXT, detail TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS onair_log_at ON onair_log (at)");
      // 1.99acw: the corner lane (onair_state.overlay) and the full address of a media pick (onair_log.url - detail is cut at 500)
      try { await runQuery("ALTER TABLE onair_state ADD COLUMN overlay TEXT"); } catch (e) { /* already there */ }
      try { await runQuery("ALTER TABLE onair_log ADD COLUMN url TEXT"); } catch (e) { /* already there */ }
      const r = (await getQuery("SELECT v, cfg, target, overlay FROM onair_state WHERE id = 1"))[0];
      let migrated = false;
      if (r) {
        V = Number(r.v) || 0;
        let raw = {};
        try { raw = JSON.parse(r.cfg) || {}; } catch (e) { raw = {}; }
        CFG = clean(raw, DEFAULTS).cfg;
        // 1.99aal: one-time move of the switch target from "Pepe" (the Wheel covers the pick there) to "Main", and the IRL
        // auto-switch "from" list to include Pepe / PepeGame - only where the old defaults were still in place
        if (!(Number(raw.cfg_rev) >= 2)) {
          if (CFG.scene === "Pepe") CFG.scene = DEFAULTS.scene;
          if (CFG.irl_from === "BRB, Gaming") CFG.irl_from = DEFAULTS.irl_from;
          migrated = true;
        }
        try { TARGET = r.target ? JSON.parse(r.target) : null; } catch (e) { TARGET = null; }
        try { OVERLAY = r.overlay ? JSON.parse(r.overlay) : null; } catch (e) { OVERLAY = null; }
        if (OVERLAY && OVERLAY.kind !== "media") OVERLAY = null;
      }
      if (migrated) await persist("migration 1.99aal");
      OPTIN = new Map((await getQuery("SELECT login, on_air, updated, via FROM onair_optin")).map((x) =>
        [String(x.login).toLowerCase(), { on: !!x.on_air, updated: Number(x.updated) || 0, via: x.via || null }]));
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function persist(by) {
  V += 1;
  await runQuery(`INSERT INTO onair_state (id, v, cfg, target, overlay, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET v = excluded.v, cfg = excluded.cfg, target = excluded.target, overlay = excluded.overlay,
                  updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                 [V, JSON.stringify({ ...CFG, cfg_rev: 2 }), TARGET ? JSON.stringify(TARGET) : null, OVERLAY ? JSON.stringify(OVERLAY) : null,
                  now(), String(by || "?").slice(0, 80)]);
}
async function log(what, by, T, detail, url) {
  try {
    await runQuery("INSERT INTO onair_log (at, what, by, kind, ref, label, detail, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [now(), String(what).slice(0, 30), String(by || "?").slice(0, 80), T ? T.kind : null, T ? refOf(T) : null, T ? String(T.label || "").slice(0, 120) : null,
       detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500), url ? String(url).slice(0, 2048) : null]);
  } catch (e) { console.error("[onair] log:", e.message); }
  console.log(`[onair] ${what} by=${by}${T ? " " + T.kind + ":" + refOf(T) : ""}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
const refOf = (T) => (T.kind === "media" ? "media:" + ((T.media && T.media.mode) || "?") + ":" + mediaRef(T.media)
  : T.kind === "cam" ? T.room + "|" + T.login : T.direct ? "link:" + (T.embed ? T.embed.p + ":" + T.embed.id : "?") : T.slot_id);
const mediaRef = (m) => (!m ? "?" : m.direct ? m.direct.host : m.live ? m.live.host : m.card ? m.card.domain : m.asset ? m.asset.id : "?");

/** Any input -> {cfg, errors} (unknown keys ignored, bad values -> the base value + an error). */
function clean(input, base = CFG) {
  const src = input && typeof input === "object" ? input : {};
  const cfg = { ...DEFAULTS, ...base }, errors = {};
  for (const k of BOOLS) {
    if (!(k in src)) continue;
    const v = src[k];
    if (typeof v === "boolean") cfg[k] = v;
    else if (v === "on" || v === "true" || v === 1 || v === "1") cfg[k] = true;
    else if (v === "off" || v === "false" || v === 0 || v === "0") cfg[k] = false;
    else errors[k] = "on or off";
  }
  for (const k of NAMES) {
    if (!(k in src)) continue;
    const v = String(src[k] == null ? "" : src[k]).trim();
    if (OBS_NAME_RE.test(v)) cfg[k] = v; else errors[k] = "an OBS name (1-60 characters)";
  }
  for (const k of ["irl_from", "top_scenes"]) {          // 1.99acw: + top_scenes, validated the same way
    if (!(k in src)) continue;
    const list = String(src[k] == null ? "" : src[k]).split(",").map((x) => x.trim()).filter(Boolean);
    if (list.length <= 12 && list.every((x) => OBS_NAME_RE.test(x)) && list.join(", ").length <= 300) cfg[k] = list.join(", ");
    else errors[k] = "OBS scene names, comma-separated (at most 12)";
  }
  if ("live_deny" in src) {                              // 1.99acw: hosts a live page may never open
    const list = String(src.live_deny == null ? "" : src.live_deny).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (list.length <= 20 && list.every((x) => HOST_RE.test(x))) cfg.live_deny = list.join(", ");
    else errors.live_deny = "host names, comma-separated (at most 20)";
  }
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    if (!(k in src)) continue;
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= lo && n <= hi) cfg[k] = Math.round(n); else errors[k] = `${lo}–${hi}`;
  }
  return { cfg, errors };
}
const config = () => ({ ...CFG });
/** 1.99acw: may pictures / links be used at all (both switches)? imagesafety.js keeps Pepe's vision pull on while this is true. */
const mediaActive = () => !!(CFG.enabled && CFG.media_enabled);

// ── opt-ins (cams on the main stream) ──
const optedIn = (login) => { const o = OPTIN.get(String(login || "").toLowerCase()); return !!(o && o.on); };
async function setOptin(login, on, { via = "web", userId = null, ts = now() } = {}) {
  await init();
  const l = String(login || "").toLowerCase();
  if (!LOGIN_RE.test(l)) return false;
  const cur = OPTIN.get(l);
  if (cur && cur.updated > ts) return false;
  await runQuery(`INSERT INTO onair_optin (login, on_air, updated, via, user_id) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET on_air = excluded.on_air, updated = excluded.updated, via = excluded.via,
                  user_id = COALESCE(excluded.user_id, onair_optin.user_id)`, [l, on ? 1 : 0, ts, via === "chat" ? "chat" : "web", userId]);
  OPTIN.set(l, { on: !!on, updated: ts, via });
  if (!on && TARGET && TARGET.kind === "cam" && TARGET.login === l) await clear("opted_out", "system");
  return true;
}
async function optinState(userId) {
  await init();
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const login = r && r.camfrogUsername ? String(r.camfrogUsername).toLowerCase() : null;
  if (!login || !LOGIN_RE.test(login)) return { linked: false, login: null, on: false, required: CFG.cam_optin };
  const o = OPTIN.get(login);
  return { linked: true, login, on: !!(o && o.on), updated: o ? o.updated : null, via: o ? o.via : null, required: CFG.cam_optin };
}

// ── eligibility ──
// stagefix site: an 18+ pad (rooms_registry.adult) never reaches Pepe's public stream, whatever the 18+ gate switch says
const adultPad = (roomId) => { try { return require("./adultgate").isAdultPad(String(roomId || "")); } catch (e) { return false; } };
const CA = () => require("./camaccess");
/** stagefix site: the cam's own access mode (camaccess.js) and when its owner last set it (0 = never chose). */
function camModeOf(login) {
  try { return { mode: CA().accessOf(login).mode, since: CA().modeSince(login) }; } catch (e) { return { mode: "members", since: 0 }; }
}
/**
 * stagefix site: the on-air OK that lets `login`'s cam on Pepe's stream right now -> "optin" (their standing opt-in) | "session"
 * (a running 6 h OK) | "once" (this pick's OK, T) | "off" (none needed: cam_optin off, an `everyone` cam) | null.
 * D-9: a `members` cam needs an OK and counts it only when it was given AFTER the owner last set the mode - a later tightening
 * is the more recent choice. followers / request cams never get this far (camWhyNot: "cam_mode").
 */
function camConsent(login, T = null, t = now(), room = null) {
  login = String(login || "").toLowerCase();
  const md = camModeOf(login);
  const after = (at) => md.mode !== "members" || Number(at) > md.since;
  const o = OPTIN.get(login);
  if (o && o.on && after(o.updated)) return "optin";
  // stagefix final round (D-9 (a)): a "this session" OK covers picks from its own pad's room only (onairconsent keys it per pad)
  const sAt = C().camAllowedAt(login, String(room || (T && T.kind === "cam" && T.room) || ""), t);
  if (sAt && after(sAt)) return "session";
  const mine = !!(T && T.kind === "cam" && T.login === login);
  if (mine && T.cam_ok === "once" && after(T.cam_ok_at || T.at || 0)) return "once";
  if (md.mode === "everyone" && (!CFG.cam_optin || (mine && T.cam_ok === "off"))) return "off";
  return null;
}
async function slotWhyNot(s, { needLive = true, padOk = false } = {}, t = now()) {
  if (!s) return "gone";
  if (s.settled || !["waiting", "active"].includes(s.status)) return "ended";
  if (s.source === "cam") return "cam_slot";                     // stagefix site: a cam on a pad's stage, never as a slot
  if (s.nsfw) return "nsfw";
  if (adultPad(s.room_id || rooms().HOUSE_ROOM)) return "adult";   // stagefix site
  if (s.source === "library" && !CFG.allow_library) return "library";
  await PA().init();
  if (!padOk && PA().isApproved(s.room_id || rooms().HOUSE_ROOM)) return "pad_private";   // needs the owner's OK
  if (await S().isBanned(s.userId, s.room_id)) return "banned";
  if (needLive && !S().isLive(s, t)) return "not_live";
  return null;
}
const embedOf = (s) => { try { return EMB().clean(JSON.parse(s.embed || "null")); } catch (e) { return null; } };
/** "open" (not Approved) | "house" (no user owner) | "session" | "always" | null (the owner has to be asked). */
async function padConsent(pad) {
  await PA().init();
  if (!PA().isApproved(pad)) return "open";
  if (!C().padOwnerId(pad)) return "house";
  return C().padAllowed(pad);
}
function camMember(R, login) {
  return (R.members || []).find((x) => x && !x.anon && String(x.login || "").toLowerCase() === login) || null;
}
async function camWhyNot(room, login, { optinOk = false, padOk = false } = {}) {
  const R = bridge()._rooms.get(String(room || ""));
  if (!R || !bridge().isLive(R)) return "offline";
  if (!R.cams) return "room_off";
  const m = camMember(R, login);
  if (m && m.self) return "self";
  if (!m || !m.on_cam || m.bot) return "not_on_cam";
  try { if (LC().optedOut(login)) return "livecam_off"; } catch (e) { /* no live cams module */ }
  // stagefix fix: private activity is the neutral "unavailable" - the same word as a block between the cam's owner and the admin
  // (setCam / checkTarget / adminView), so neither the refusal nor onair_log says which
  try { if ((await require("./stories").privateLogins([login])).has(login)) return "unavailable"; } catch (e) { /* none */ }
  if (adultPad(R.id)) return "adult";                                    // stagefix site: an 18+ room's cam - never
  try { await CA().init(); } catch (e) { /* the default mode (members) applies */ }
  const md = camModeOf(login);
  if (md.mode === "followers" || md.mode === "request") return "cam_mode";   // stagefix site (D-9): never public
  if (!optinOk && !camConsent(login, null, now(), R.id)) return "no_optin";                  // (members: an OK given after the mode was set)
  await PA().init();
  if (!padOk && PA().isApproved(R.id)) return "pad_private";
  return null;
}
const refuse = (code) => new Refuse(code === "gone" ? 404 : 409, WHY[code] || code, code);

// ── set / clear ──
async function setSlot(slotId, by, { admin, rights = false, ask = true, starting = false, waitMs = 0 } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  const s = await S().getSlot(String(slotId || ""));
  // 1.99aao: a 📼 title just started for the pick (setLibrary) isn't live yet - the check() grace covers its start
  const why = await slotWhyNot(s, { padOk: true, needLive: !starting });
  if (why) throw refuse(why);
  const pad = s.room_id || rooms().HOUSE_ROOM;
  let embed = null;
  if (s.mode === "embed") {
    embed = embedOf(s);
    if (!embed) throw refuse("embed_bad");
    if (rights !== true) throw refuse("rights");
  }
  const padOk = await padConsent(pad);
  if (!padOk && !ask) throw refuse("pad_private");
  const label = `${s.displayname || s.username}${s.title ? " - " + s.title : ""}${s.source === "library" ? " (📼)" : ""}${embed ? " (" + EMB().label(embed) + ")" : ""}`;
  const prev = TARGET;
  await dropPending(prev);
  TARGET = { id: (embed ? "e:" : "s:") + s.id + ":" + now().toString(36), kind: embed ? "embed" : "slot", slot_id: s.id, user_id: s.userId,
             username: s.username, pad, label, by: String(by), at: now(), live_at: now(), pad_ok: padOk || null, pending: [],
             ...(embed ? { embed, rights: { by: String(by), at: now() } } : {}),
             ...(starting && waitMs > 0 ? { start_until: now() + waitMs } : {}) };     // 1.99aaq: time to start streaming
  if (!padOk) {
    const c = await C().ask({ kind: "pad", pad, slot_id: s.id, label, by, minutes: CFG.consent_min });
    TARGET.pending.push(c.id);
  }
  await persist(by);
  if (prev) await log("replaced", by, prev);
  const detail = { ...(embed ? { rights_confirmed: true } : {}), ...(TARGET.pending.length ? { waiting_for: "pad owner", consent: TARGET.pending } : {}) };
  await log(TARGET.pending.length ? "asked" : "set", by, TARGET, Object.keys(detail).length ? detail : null);
  if (admin) await audit(admin, TARGET.pending.length ? "ask" : "set", TARGET, detail);
  if (!TARGET.pending.length) tellLive(TARGET);
  return view();
}
// 1.99aao: staff paste a YouTube / Twitch link straight onto Pepe's stream from the player bar (no pad slot behind it).
// Same rules as an embed slot: the rights tick every time, the stall clock, the IRL feed wins; nobody to ask or tell.
async function setEmbed(url, by, { admin, rights = false, queued = null } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  let embed = null;
  try { embed = EMB().clean(EMB().parse(url)); }
  catch (e) { throw new Refuse(400, (e && e.message) || WHY.embed_bad, "embed_bad"); }
  if (!embed) throw refuse("embed_bad");
  if (rights !== true) throw refuse("rights");
  const prev = TARGET;
  await dropPending(prev);
  TARGET = { id: "e:link:" + now().toString(36), kind: "embed", direct: true, slot_id: null, user_id: null, pad: rooms().HOUSE_ROOM,
             label: "🔗 " + EMB().label(embed), by: String(by), at: now(), live_at: now(), pad_ok: "house", pending: [],
             embed, rights: queued ? { by: queued.by, at: queued.created } : { by: String(by), at: now() },
             ...(queued ? { queued: queued.id } : {}) };
  await persist(by);
  if (prev) await log("replaced", by, prev);
  const detail = { rights_confirmed: true, link: true, ...(queued ? { queued: queued.id, queued_by: queued.by, booked_at: queued.at } : {}) };
  await log("set", by, TARGET, detail);
  if (admin) await audit(admin, "set", TARGET, detail);
  return view();
}
// ── 1.99acw: 🖼 pictures, 🔗 link cards, 🌐 live pages (onairmedia.js prepares them; these put them on) ──
const BOT_CAPS = (t = now()) => (BOT && botOk(t) && Array.isArray(BOT.caps) ? BOT.caps : []);
/** Why a media pick of this mode can't go on now (a Refuse), or null. Pepe must be fresh, say he can (caps) and have the
 *  OBS sources (state.media_ok / live_ok after `!onair setup media`) - an older Pepe would show nothing.
 *  1.99acw review: a live page needs Pepe's "live" cap and a direct picture his "direct" cap - he sends them only once his VM's
 *  firewall attestation is set (live: also his panel login + an OBS websocket password), so no site setting alone turns them on. */
function mediaRefusal(mode, t = now(), { direct = false } = {}) {
  if (!CFG.enabled) return refuse("off");
  if (!CFG.media_enabled) return refuse("media_off");
  if (mode === "live" && !CFG.live_pages) return refuse("live_off");
  if (!botOk(t)) return refuse("pepe_away");
  const caps = BOT_CAPS(t), st = (BOT && BOT.state) || {};
  if (!caps.includes("media")) return refuse("media_old_bot");
  if (!st.media_ok) return refuse("media_setup");
  const why = (code, own) => new Refuse(409, WHY[code] + (own ? ` (${own})` : "") + ".", code);
  if (mode === "live" && !caps.includes("live")) return why("live_fw", st.live_why);
  if (mode === "live" && !st.live_ok) return refuse("live_setup");
  if (direct && mode === "image" && !caps.includes("direct")) return why("direct_fw", st.direct_why);
  return null;
}
const botMediaOk = (mode = "image", t = now(), direct = false) => !mediaRefusal(mode, t, { direct });
function maxSecsOf(m) {
  return m.direct ? Math.min(CFG.direct_max_s, M().DIRECT_HARD_MAX_S) : m.mode === "live" ? CFG.live_max_s : CFG.media_max_s;
}
/** A prepared media pick (onairmedia.mediaOf) goes on air in its lane. Throws Refuse. -> view() + {id}. */
async function setMedia(media, by, { admin, queued = null } = {}) {
  await init();
  if (!media || !["image", "card", "live"].includes(media.mode)) throw new Refuse(400, "That can't go on air.", "bad");
  const why = mediaRefusal(media.mode, now(), { direct: !!media.direct });
  if (why) throw why;
  const lane = media.lane === "corner" ? "corner" : "main";
  const other = lane === "main" ? OVERLAY : TARGET;
  if (media.mode === "live" && other && other.kind === "media" && other.media && other.media.mode === "live") throw refuse("live_busy");
  const t = now();
  const secs = Math.max(M().MIN_SECS, Math.min(Math.round(Number(media.secs) || CFG.media_secs), maxSecsOf(media)));
  const m = { ...media, lane, secs, until: t + secs * 1000 };
  delete m.note; delete m.clamped;
  const T = { id: "m:" + crypto.randomBytes(4).toString("hex") + ":" + t.toString(36), kind: "media", slot_id: null, user_id: null, pad: rooms().HOUSE_ROOM,
              label: M().labelOf(m), by: String(by), at: t, live_at: t, pad_ok: "house", pending: [],
              rights: queued ? { by: queued.by, at: queued.created } : { by: String(by), at: t }, ...(queued ? { queued: queued.id } : {}), media: m };
  let prev;
  if (lane === "main") { prev = TARGET; await dropPending(prev); TARGET = T; } else { prev = OVERLAY; OVERLAY = T; }
  await persist(by);
  if (prev) await log("replaced", by, prev);
  const url = M().urlOf(m);
  const detail = { mode: m.mode, lane, secs, rights_confirmed: true, ...(m.direct ? { direct: true, unscanned: true } : {}),
                   ...(m.live ? { live: true, sound: !!m.live.sound } : {}), ...(m.asset ? { asset: m.asset.id } : {}),
                   ...(queued ? { queued: queued.id, queued_by: queued.by, booked_at: queued.at } : {}) };
  await log("set", by, T, detail, url);
  if (admin) await audit(admin, "set", T, { ...detail, url });
  M().touch(M().refsOf(m), t).catch(() => {});
  return { ...view(), id: T.id };
}
/** What a person is told once a media pick is on (chat + the panel). */
function onAirMsg(T, clamped) {
  const m = T.media, d = M().fmtDur(m.secs) + (clamped ? " (the most allowed)" : "");
  const where = m.lane === "corner" ? " in the corner" : "";
  if (m.direct) return `⚠ Shown directly - NOT safety-scanned, and the site sees Pepe's address. Up${where} for ${d}: ${T.label}`;
  if (m.mode === "live") return `🌐 Live page on Pepe's stream${where} for ${d} (${m.live && m.live.sound ? "with sound" : "muted"}): ${m.live ? m.live.host : "?"}`;
  return (m.lane === "corner" ? `In the corner for ${d}: ` : `On Pepe's main stream for ${d}: `) + T.label;
}
/** The job body for a media request (chat or web): prepare (fetch / scan / check), then on air - or into the queue. */
async function finishMedia(spec, job, { by, admin = null, userId = null, queued = false, at = null, owner = null }) {
  const p = await M().prepare(spec, job, { userId, cfg: CFG, by });
  const media = M().mediaOf(spec, p);
  const note = media.note ? ` (${media.note})` : "";
  if (queued) {
    const row = await Q().add({ kind: "media", spec: { ...media, note: undefined, clamped: undefined }, at, by, label: M().labelOf(media), owner });
    const detail = { id: row.id, label: row.label, at: row.at, kind: "media", mode: media.mode, lane: media.lane, rights_confirmed: true };
    await log("queued", by, null, detail, M().urlOf(media));
    if (admin) await audit(admin, "queue", null, { ...detail, url: M().urlOf(media) });
    return { msg: `⏰ Queued [${row.id}] ${row.label} - ` + (row.at ? `on Pepe's stream ${Q().fmt(row.at)} (replaces what's in its spot).`
      : "next up, when its spot is free.") + note + (CFG.enabled ? "" : " On-air is switched OFF right now (/stage/admin)."), result: { queued: row.id } };
  }
  const v = await setMedia(media, by, { admin });
  const T = [TARGET, OVERLAY].find((x) => x && x.id === v.id);
  return { msg: (T ? onAirMsg(T, media.clamped) : "On Pepe's stream.") + note, result: { id: v.id } };
}
// 1.99acw review: a direct picture / live page queued from CHAT can't be re-checked against the person's role at play time (the
// site only has the chat login) - it must play within this long of being queued, or it's dropped
const CHAT_EXPOSED_MS = 60 * 60 * 1000;
/**
 * A media request, web or chat: gates, the person's block, the rate limit (one bucket per PERSON - a chat login linked to an
 * account shares the web's), the job (answered at once when it ends within 3 s). 1.99acw review: every attempt is recorded
 * (onair_attempts); a refused / failed one is in onair_log ("refused": who, the link, the code, the safety check) and, from the
 * web, admin_audit; unsafe refusals count against the person (M().noteOutcome).
 */
async function startMedia(spec, { actor, via, by, admin = null, userId = null, login = null, queued = false, at = null }) {
  const person = M().personKey({ userId, login });
  await M().assertPersonOk(person);
  if (queued) {
    if (!CFG.media_enabled) throw refuse("media_off");
    if (spec.mode === "live" && !CFG.live_pages) throw refuse("live_off");
    at = Q().checkAt(at);
    if (via === "chat" && (spec.direct || spec.mode === "live") && at != null && at > now() + CHAT_EXPOSED_MS) {
      throw new Refuse(400, "From chat, a direct picture or live page can be queued at most an hour ahead (use the website's panel for later).", "when");
    }
  } else {
    const why = mediaRefusal(spec.mode, now(), { direct: !!spec.direct });
    if (why) throw why;
  }
  const url = spec.url || (spec.upload ? "upload:" + spec.upload : null);
  const attempt = await M().rateCheck(person, CFG.media_per_10min, { via, by, mode: spec.mode + (spec.direct ? "+direct" : ""), url });
  const owner = via === "web" ? { via: "web", userId: userId ? String(userId) : null } : { via: "chat", login: login ? String(login) : null };
  const label = via === "chat" ? "chat " + (login || "?") : String(by || "?").replace(/^web:/, "");
  const j = M().startJob({
    actor, person, via,
    run: async (job) => {
      try {
        const r = await finishMedia(spec, job, { by, admin, userId, queued, at, owner });
        await M().noteOutcome(attempt, person, { state: "done" });
        return r;
      } catch (e) {
        const code = (e && e.code) || (e && e.refuse ? "refused" : "error");
        const detail = { mode: spec.mode, lane: spec.lane, code, ...(spec.direct ? { direct: true } : {}), ...(e && e.logId ? { safety_log: e.logId } : {}),
                         ...(e && e.minor ? { minor_flag: true } : {}), ...(queued ? { queued: true } : {}), via };
        await log("refused", by, null, detail, url);
        if (admin) await audit(admin, "refused", null, { ...detail, url });
        const out = await M().noteOutcome(attempt, person, { state: e && e.refuse ? "refused" : "failed", code, logId: (e && e.logId) || null,
                                                             minor: !!(e && e.minor), label }).catch((x) => { console.error("[onair] strike:", x.message); return {}; });
        if (out && out.blocked) e.message = (e.message || "Refused.") + " " + WHY.person_blocked;
        throw e;
      }
    },
  });
  return M().race(j);
}
const MODE_ICON = { image: "🖼", card: "🔗", live: "🌐" };

// 1.99aao: staff pick a 📼 Plex title from the player bar: it plays on Pepe's own pad (medialib's normal path - its access
// rules, encoder cap and log) and that slot goes on air at once; allow_library still decides whether Plex may go on air.
async function setLibrary(key, by, { admin, user } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  if (!CFG.allow_library) throw refuse("library");
  if (!user) throw new Refuse(403, "Site staff only.", "staff_only");
  const r = await require("./medialib").play(user, { room: rooms().HOUSE_ROOM, key: String(key || "") });
  try {
    return await setSlot(r.slot.id, by, { admin, ask: false, starting: true, waitMs: 3 * 60 * 1000 });
  } catch (e) {
    await require("./medialib").stop(user, rooms().HOUSE_ROOM, "onair_failed").catch(() => {});
    throw e;
  }
}
// 1.99aaq: staff stream straight onto Pepe's stream from their own OBS (RTMP / WHIP) or the browser: a slot on Pepe's own
// pad (the stage's normal booking - its limits, publish auth and Cut) that is the on-air pick from the start and goes out
// as soon as it's live; nothing reaches OBS until then, and if nothing arrives within GOLIVE_WAIT_MS the pick is dropped.
const GOLIVE_WAIT_MS = 10 * 60 * 1000;
async function setGoLive(user, by, { admin, minutes, title } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  if (!user) throw new Refuse(403, "Site staff only.", "staff_only");
  const m = [30, 60, 120, 180].includes(Number(minutes)) ? Number(minutes) : 60;
  const b = await S().book(user, { room: rooms().HOUSE_ROOM, minutes: m, title: String(title || "").trim() || "Live on Pepe's stream" });
  try {
    await setSlot(b.slot.id, by, { admin, ask: false, starting: true, waitMs: GOLIVE_WAIT_MS });
  } catch (e) {
    await S().end(b.slot.id, "onair_failed", user.username).catch(() => {});
    throw e;
  }
  // 1.99aay: + WHIP (OBS 30+ "WHIP" service, or any WHIP client): the slot's URL + a bearer token valid for the same start window
  let whip = null;
  try {
    const W = require("./webrtc");
    if (W.enabled()) whip = { url: W.whipUrl(b.slot.stream), token: W.whipToken(b.slot.id), expires: now() + GOLIVE_WAIT_MS };
  } catch (e) { whip = null; }
  return { slot_id: b.slot.id, minutes: m, rtmp: b.rtmp, whip, wait_min: GOLIVE_WAIT_MS / 60000, page: "/stage" };
}
function tellLive(T) {
  if (!T || T.kind === "cam" || !T.user_id) return;
  rooms().notify(T.user_id, { kind: "stage", title: "You're on Pepe's main stream",
    body: "An admin put your " + (T.kind === "embed" ? "embed" : "stream") + " on Pepe's main stream (publicaccess.tv, his Twitch relay and his Camfrog cam). " +
          "Type !onair off in Camfrog (from your linked name) to take it off, or end your slot.", link: "/stage", ref: "onair:" + T.slot_id })
    .catch(() => {});
}
/** stagefix site: the PATV account(s) behind whoever picks a cam - the signed-in admin, or the accounts linked to the Camfrog
 *  login Pepe says typed !onair cam ("pepe:<login>"). [] = no account (nothing to check blocks against). */
async function actorIdsOf(admin, by) {
  if (admin && admin.userId) return [String(admin.userId)];
  const m = /^pepe:([\w.\-$]{1,40})$/.exec(String(by || ""));
  // stagefix final round: "web:<username>" (the /stage/admin card's `by`) too - for a target saved before actor_ids existed
  const w = m ? null : /^web:(.{1,60})$/.exec(String(by || ""));
  try {
    if (m) return (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [m[1].toLowerCase()])).map((r) => String(r.userId));
    if (w) return (await getQuery("SELECT userId FROM users WHERE lower(username) = ?", [w[1].toLowerCase()])).map((r) => String(r.userId));
  } catch (e) { return []; }
  return [];
}
async function setCam(room, login, by, { admin, ask = false } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  login = String(login || "").toLowerCase().replace(/^@/, "");
  if (!LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?", "bad");
  const why = await camWhyNot(room, login, { optinOk: true, padOk: true });
  if (why) throw refuse(why);
  // stagefix site (D-17, blocks against the director): not when the cam's owner and whoever picks it blocked one another -
  // the neutral "unavailable", never which of them (re-checked every tick while it's on: checkTarget)
  const actorIds = await actorIdsOf(admin, by);
  if (actorIds.length && (await LC().blockedWith(login, actorIds))) throw refuse("unavailable");
  const R = bridge()._rooms.get(String(room));
  const camOk = camConsent(login, null, now(), R.id);   // stagefix site: D-9 - a members cam's OK must postdate its mode
  const padOk = await padConsent(R.id);
  if ((!camOk || !padOk) && !ask) throw refuse(!camOk ? "no_optin" : "pad_private");
  const m = camMember(R, login);
  const prev = TARGET;
  await dropPending(prev);
  TARGET = { id: "c:" + login + ":" + now().toString(36), kind: "cam", room: R.id, login, display: (m && m.display) || login, pad: R.id,
             label: `📷 ${(m && m.display) || login} (${R.name || R.id})`, by: String(by), at: now(), cam_ok: camOk || null, pad_ok: padOk || null,
             pending: [], actor_ids: actorIds };
  if (!camOk) TARGET.pending.push((await C().ask({ kind: "cam", login, room: R.id, label: TARGET.label, by, minutes: CFG.consent_min })).id);
  if (!padOk) TARGET.pending.push((await C().ask({ kind: "pad", pad: R.id, login, room: R.id, label: TARGET.label, by, minutes: CFG.consent_min })).id);
  await persist(by);
  if (prev) await log("replaced", by, prev);
  const detail = TARGET.pending.length ? { waiting_for: [!camOk ? "cam owner" : null, !padOk ? "pad owner" : null].filter(Boolean), consent: TARGET.pending } : null;
  await log(TARGET.pending.length ? "asked" : "set", by, TARGET, detail);
  if (admin) await audit(admin, TARGET.pending.length ? "ask" : "set", TARGET, detail);
  return view();
}
async function dropPending(T) {
  for (const id of (T && T.pending) || []) await C().cancel(id).catch(() => {});
}
/** onairconsent.js tells us: a request was answered / expired, or a pad's standing allow was revoked. */
async function onConsentChange(ev) {
  await init();
  if (!TARGET) return;
  if (ev.revoked) {
    if (TARGET.pad === ev.pad && (TARGET.pad_ok === "always" || TARGET.pad_ok === "session")) await clear("consent_revoked", "owner");
    return;
  }
  const r = ev.request;
  if (!r || !(TARGET.pending || []).includes(r.id)) return;
  if (r.status !== "allowed") return void (await clear(r.status === "denied" ? "denied" : "consent_expired", "owner"));
  TARGET.pending = TARGET.pending.filter((x) => x !== r.id);
  if (r.kind === "pad") TARGET.pad_ok = r.scope === "once" ? "once" : r.scope;
  else { TARGET.cam_ok = r.scope === "always" ? "optin" : r.scope; TARGET.cam_ok_at = now(); }   // stagefix site: when (D-9)
  await log("consent", "owner", TARGET, `${r.kind}: ${r.scope}`);
  if (!TARGET.pending.length) {
    TARGET.at = TARGET.live_at = now();
    await log("set", "owner-ok", TARGET, "on air after the owner's OK");
    tellLive(TARGET);
  }
  await persist("owner");
}
/** Take a pick off. 1.99acw: lane "main" (the default - what every per-pick reason means), "corner" (the overlay) or "all"
 *  (✂ / !onair off / the kill switch); `note` is added to the log's reason (e.g. Pepe's own refusal). */
async function clear(why, by, { admin, lane = "main", note = null } = {}) {
  await init();
  const ended = [];
  if ((lane === "main" || lane === "all") && TARGET) { const T = TARGET; TARGET = null; await dropPending(T); ended.push(T); }
  if ((lane === "corner" || lane === "all") && OVERLAY) { ended.push(OVERLAY); OVERLAY = null; }
  if (!ended.length) return view();
  await persist(by);
  for (const T of ended) {
    await log("end", by, T, note ? `${why}: ${String(note).slice(0, 200)}` : why);
    if (admin) await audit(admin, "off", T);
  }
  return view();
}
// ── 1.99acw review: blocks - a picture / link that wrongly passed is taken down for good (onairmedia.block) ──
/** After a block: take off every lane showing one of these pictures, cancel queued items that would show them. */
async function dropBlocked(b, by, { admin = null } = {}) {
  const hit = new Set([].concat(...b.assets.map((a) => [a.id, a.file])));
  const urls = new Set(b.urls);
  const shows = (m) => !!m && (M().refsOf(m).some((x) => hit.has(x)) || M().blockUrlsOf(m).some((u) => urls.has(u)));
  for (const [T, lane] of [[TARGET, "main"], [OVERLAY, "corner"]]) {
    if (T && T.kind === "media" && shows(T.media)) await clear("blocked", by, { admin, lane });
  }
  for (const r of await Q().list().catch(() => [])) {
    if (r.kind === "media" && shows(r.spec)) await Q().mark(r.id, "cancelled", "blocked by " + String(by).slice(0, 60));
  }
}
/** ✂ + block: the lane(s) off, and what their media picks showed blocked (their stored pictures + their links). */
async function cutAndBlock(lane, by, { admin = null } = {}) {
  await init();
  const picks = [];
  if ((lane === "main" || lane === "all") && TARGET && TARGET.kind === "media") picks.push(TARGET);
  if ((lane === "corner" || lane === "all") && OVERLAY && OVERLAY.kind === "media") picks.push(OVERLAY);
  const out = { picks: picks.length, assets: 0, urls: 0 };
  for (const T of picks) {
    const b = await M().block({ refs: M().refsOf(T.media), urls: M().blockUrlsOf(T.media) }, by, "blocked by " + by + " (cut + block)");
    out.assets += b.assets.length; out.urls += b.urls.length;
    const detail = { mode: T.media.mode, ...(T.media.direct ? { direct: true } : {}), assets: b.assets.map((a) => a.id), links: b.urls.length,
                     safety_log: b.assets.map((a) => a.safety_log).filter(Boolean) };
    await log("blocked", by, T, detail, M().urlOf(T.media));
    if (admin) await audit(admin, "block", T, { ...detail, url: M().urlOf(T.media) });
    await dropBlocked(b, by, { admin });
  }
  await clear("blocked", by, { admin, lane });
  return out;
}
/** A stored picture from the staff list (or the safety review): blocked, off air wherever it shows, out of the queue. */
async function blockAsset({ asset = null, logId = null }, by, { admin = null } = {}) {
  await init();
  const b = await M().block({ refs: asset ? [asset] : [], logId }, by, "blocked by " + by);
  if (!b.assets.length && !b.urls.length) return b;
  const detail = { assets: b.assets.map((a) => a.id), links: b.urls.length, safety_log: b.assets.map((a) => a.safety_log).filter(Boolean) };
  await log("blocked", by, null, detail, b.assets[0] && b.assets[0].src_url);
  if (admin) await audit(admin, "block", null, { ...detail, url: b.assets[0] && b.assets[0].src_url });
  await dropBlocked(b, by, { admin });
  return b;
}
/** imagesafety.review: an admin marked an on-air check "fn" (it should have been refused) -> block that picture. */
async function blockFromSafetyLog(logId, by) { return blockAsset({ logId }, by); }
async function audit(admin, action, T, extra) {
  try { await require("./adminaudit").record(admin, AUDIT, null, { action, kind: T ? T.kind : null, ref: T ? refOf(T) : null, label: T ? T.label : null, ...(extra || {}) }); }
  catch (e) { console.error("[onair] audit:", e.message); }
}
async function saveConfig(patch, by, { admin } = {}) {
  await init();
  const r = clean(patch);
  if (Object.keys(r.errors).length) { const f = Object.entries(r.errors)[0]; throw new Refuse(400, `${f[0]}: ${f[1]}`, "bad"); }
  const changed = {};
  for (const k of Object.keys(r.cfg)) if (r.cfg[k] !== CFG[k]) changed[k] = [CFG[k], r.cfg[k]];
  if (!Object.keys(changed).length) return config();
  CFG = r.cfg;
  if (!CFG.enabled && TARGET) { const T = TARGET; TARGET = null; await dropPending(T); await log("end", by, T, "switched_off"); }
  if (!CFG.enabled && OVERLAY) { const T = OVERLAY; OVERLAY = null; await log("end", by, T, "switched_off"); }
  // 1.99acw: pictures / links switched off -> off both lanes at once; live pages switched off -> a live page goes
  for (const [lane, T] of [["main", TARGET], ["corner", OVERLAY]]) {
    if (!T || T.kind !== "media") continue;
    const why = !CFG.media_enabled ? "media_off" : T.media && T.media.mode === "live" && !CFG.live_pages ? "live_off" : null;
    if (!why) continue;
    if (lane === "main") TARGET = null; else OVERLAY = null;
    await log("end", by, T, why);
  }
  await persist(by);
  await log("config", by, null, changed);
  if (admin) { try { await require("./adminaudit").record(admin, AUDIT, null, { action: "config", changed }); } catch (e) { /* logged above */ } }
  return config();
}

let lastMediaSweep = 0;
async function mediaSweep(t) {
  const refs = new Set();
  for (const T of [TARGET, OVERLAY]) if (T && T.kind === "media") for (const x of M().refsOf(T.media)) refs.add(x);
  for (const r of await Q().list().catch(() => [])) if (r.kind === "media") for (const x of M().refsOf(r.spec)) refs.add(x);
  return M().sweep(refs, t);           // t undefined = onairmedia's own clock
}
/** Every few seconds (and on each of Pepe's polls): end a target that no longer may / can be on air. */
let checking = null;
function check(t = now()) {
  if (checking) return checking;
  checking = (async () => {
    await init();
    await C().sweep().catch((e) => console.error("[onair] consent sweep:", e.message));
    await checkTarget(t);
    await queueTick(t).catch((e) => console.error("[onair] queue:", e.message));
    if (t - lastMediaSweep > 6 * 3600 * 1000) {                 // 1.99acw: stored on-air pictures nobody used in 30 days
      lastMediaSweep = t;
      mediaSweep().catch((e) => console.error("[onair] media sweep:", e.message));
    }
    return null;
  })().finally(() => { checking = null; });
  return checking;
}
/** 1.99abj: a booked link that's due goes on now (replacing the pick); with nothing on air, the next-up link.
 *  1.99acw: per lane (a corner item waits only for the corner); media rows wait while Pepe can't show them; a direct picture's /
 *  live page's host is checked again before it plays. */
const isLiveMedia = (T) => !!(T && T.kind === "media" && T.media && T.media.mode === "live");
/** 1.99acw review: may whoever queued this direct picture / live page still do that now? Web: their account's CURRENT class
 *  (a demoted account's queued item doesn't play). Chat: only within CHAT_EXPOSED_MS of queueing (the site can't re-check
 *  Pepe's role). A row without an owner (queued before this check) is refused. -> null | the reason. */
async function exposedOwnerWhy(r, t) {
  const m = r.spec || {};
  if (!(m.direct || m.mode === "live")) return null;
  const cap = m.mode === "live" ? "onair.live_page" : "onair.direct_media";
  const o = r.owner || {};
  if (o.via === "web" && o.userId) {
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(o.userId)]))[0];
    return u && SP.can(u, cap) ? null : "the person who queued it can't show " + (m.mode === "live" ? "live pages" : "direct pictures") + " any more";
  }
  if (o.via === "chat") return t - Number(r.created || 0) <= CHAT_EXPOSED_MS ? null : "queued from chat more than an hour ago (direct pictures / live pages from chat play within an hour)";
  return "it has no record of who queued it";
}
async function queueTick(t = now()) {
  const r = await Q().due({ idleMain: !TARGET, idleCorner: !OVERLAY, enabled: CFG.enabled, mediaOk: botMediaOk("image", t), liveOk: botMediaOk("live", t),
                            directOk: botMediaOk("image", t, true), liveMain: isLiveMedia(TARGET), liveCorner: isLiveMedia(OVERLAY) }, t);
  if (!r) return;
  try {
    if (r.kind === "media") {
      const owner = await exposedOwnerWhy(r, t);
      if (owner) throw new Refuse(403, "Not played: " + owner + ".", "owner");
      await M().recheck(r.spec, { cfg: CFG, timeoutMs: 4000 });   // (a short probe: this runs inside Pepe's poll)
      await setMedia(r.spec, "queue:" + r.by, { queued: r });
    } else await setEmbed(r.url, "queue:" + r.by, { rights: true, queued: r });
    await Q().mark(r.id, "played", null, t);
  } catch (e) {
    if (e && e.code === "live_busy") return;        // the other spot got a live page meanwhile: it keeps waiting (due() re-checks)
    await Q().mark(r.id, "failed", (e && e.message) || "failed", t);
    if (r.kind === "media") await log("refused", "queue:" + r.by, null, { queued: r.id, mode: r.mode, lane: r.lane, code: (e && e.code) || "error", why: String((e && e.message) || "").slice(0, 200) }, r.url);
    console.error("[onair] queued", r.kind === "media" ? "item" : "link", r.id, "failed:", e && e.message);
  }
}
/** 1.99acw: a media pick in either lane ends at its time, when pictures are switched off, when Pepe can't show it (for longer
 *  than BOT_FRESH_MS), when Pepe's own network check refused its host, or (a direct picture) when the show page couldn't load it. */
async function checkMedia(T, lane, t) {
  const m = T.media || {};
  const end = (why, note) => clear(why, "system", { lane, note });
  if (!CFG.enabled) return end("switched_off");
  if (!CFG.media_enabled) return end("media_off");
  if (m.mode === "live" && !CFG.live_pages) return end("live_off");
  if (m.until && t >= m.until) return end("media_done");
  if (BOT && botOk(t)) {
    const st = BOT.state || {};
    if (st.media_err_id && st.media_err_id === T.id) return end("pepe_refused", st.media_err || null);
    const caps = BOT_CAPS(t);
    const can = caps.includes("media") && !!st.media_ok && (m.mode !== "live" || (caps.includes("live") && !!st.live_ok)) && (!m.direct || caps.includes("direct"));
    if (can) delete m.cant_since;
    else if (!m.cant_since) m.cant_since = t;
    else if (t - m.cant_since > BOT_FRESH_MS) return end("pepe_cant");
  }
  if (m.direct && m.show_state === "error") return end("media_failed");
  return null;
}
async function checkTarget(t) {
    if (OVERLAY) await checkMedia(OVERLAY, "corner", t);
    if (!TARGET) return null;
    if (!CFG.enabled) return clear("switched_off", "system");
    const T = TARGET;
    if (T.kind === "media") return checkMedia(T, "main", t);
    const pending = (T.pending || []).length > 0;
    if (T.kind === "embed" && T.direct) {                                     // 1.99aao: a pasted link - only the stall clock
      // 1.99abj: ...and its video ending (the player says so) - the next queued link starts right away
      if (!pending && T.embed_state === "ended" && T.embed_seen_at && T.embed_seen_at - T.at > 5000) return clear("embed_ended", "system");
      if (!pending) {
        if (BOT && BOT.state && BOT.state.irl && botOk(t)) T.embed_play_at = t;
        const last = Math.max(T.at + EMBED_GRACE_MS, T.embed_play_at || 0);
        if (t - last > CFG.embed_stall_s * 1000) return clear("embed_not_playing", "system");
      }
    } else if (T.kind === "slot" || T.kind === "embed") {
      const s = await S().getSlot(T.slot_id);
      const why = await slotWhyNot(s, { needLive: false, padOk: true }, t);
      if (why) return clear(why, "system");
      if (!pending && (T.pad_ok === "session" || T.pad_ok === "always") && !(await padConsent(T.pad))) return clear("consent_revoked", "system");
      if (S().isLive(s, t)) { T.live_at = t; T.went_live = true; }
      else if (t - (T.live_at || T.at) > LIVE_GRACE_MS && !(T.start_until && !T.went_live && t < T.start_until)) return clear("not_live", "system");
      if (T.kind === "embed" && !pending) {
        if (BOT && BOT.state && BOT.state.irl && botOk(t)) T.embed_play_at = t;     // hidden under the IRL feed: no stall clock
        const last = Math.max(T.at + EMBED_GRACE_MS, T.embed_play_at || 0);
        if (t - last > CFG.embed_stall_s * 1000) return clear("embed_not_playing", "system");
      }
    } else {
      // stagefix site: the OK still counts (camConsent: a once / session OK, the standing opt-in, none needed - and for a
      // members cam, given after its mode was last set: tightening it takes the cam off)
      try { await CA().init(); } catch (e) { /* the default mode (members) applies */ }
      const optinOk = pending || !!camConsent(T.login, T, t);
      const why = await camWhyNot(T.room, T.login, { optinOk, padOk: true });
      if (why) return clear(why, "system");
      // stagefix site: a block between the cam's owner and whoever picked it, made while it's on, takes it off.
      // stagefix final round: a cam put on air before actor_ids existed (saved by an older build) gets them from its `by` now
      if (!Array.isArray(T.actor_ids)) T.actor_ids = await actorIdsOf(null, T.by);
      if (T.actor_ids.length && (await LC().blockedWith(T.login, T.actor_ids))) return clear("unavailable", "system");
      if (!pending && (T.pad_ok === "session" || T.pad_ok === "always") && !(await padConsent(T.pad))) return clear("consent_revoked", "system");
    }
    return null;
}

// ── what Pepe gets ──
async function botTarget() {
  if (!TARGET || !CFG.enabled || (TARGET.pending || []).length) return null;
  const T = TARGET;
  if (T.kind === "slot") {
    const s = await S().getSlot(T.slot_id);
    if (!s) return null;
    // 1.99aaq: a pick still waiting for its stream to start (go live / 📼) stays off OBS until it's live - no blank scene
    if (T.start_until && !T.went_live && !S().isLive(s)) return null;
    return { id: T.id, kind: "slot", label: T.label, url: (S().playUrlOf || S().hlsOf)(s), live: S().isLive(s), since: T.at };
  }
  if (T.kind === "embed") return { id: T.id, kind: "embed", label: T.label, url: playerUrl(T), since: T.at };
  if (T.kind === "media") return CFG.media_enabled ? mediaForBot(T, "main") : null;
  // 1.99abv: `consent` = the cam owner OK'd THIS pick (!onair yes / always, the consent page) or opted in / opt-in is off -
  // Pepe's own check only knows the standing opt-ins, so a one-time OK used to be refused on his side ("no_optin").
  // check() above still ends the pick when that OK lapses.
  return { id: T.id, kind: "cam", label: T.label, room: T.room, login: T.login, display: T.display, since: T.at, consent: !!T.cam_ok };
}
/** 1.99acw: a media pick as Pepe gets it. url = our show page (a picture / card / direct picture) or the live page itself;
 *  check_host = the host Pepe's VM loads directly (direct / live: he checks it on his own network first); until = the site's
 *  clock (Pepe also hides it past until + a grace, and caps it from when HE first applied it). */
function mediaForBot(T, lane) {
  const m = T.media || {};
  return { id: T.id, kind: "media", mode: m.mode, lane, label: T.label, url: m.mode === "live" && m.live ? m.live.url : showUrl(T.id),
           until: m.until || null, secs: m.secs || null, layout: lane === "corner" ? "corner" : "full", corner: m.corner || null,
           sound: !!(m.live && m.live.sound), direct: !!m.direct, check_host: (m.direct && m.direct.host) || (m.live && m.live.host) || null,
           since: T.at, ...(lane === "corner" ? { pct: CFG.corner_pct } : {}) };
}
function botOverlay() {
  if (!OVERLAY || !CFG.enabled || !CFG.media_enabled || OVERLAY.kind !== "media") return null;
  return mediaForBot(OVERLAY, "corner");
}
// the embed player page's token: the pick's id + an HMAC (only that pick; a new pick = a new URL)
const sigFor = (scope, id) => crypto.createHmac("sha256", SECRET).update(scope + id).digest("base64url").slice(0, 32);
const sig = (id) => sigFor("onair-player:", id);
const playerToken = (id) => Buffer.from(String(id)).toString("base64url") + "." + sig(id);
function playerUrl(T) { return SITE() + "/onair/player?t=" + encodeURIComponent(playerToken(T.id)); }
// 1.99acw: the show page's token (pictures / cards): the same scheme, its own scope - a player token never opens a show page
const showToken = (id) => Buffer.from(String(id)).toString("base64url") + "." + sigFor("onair-show:", id);
function showUrl(id) { return SITE() + "/onair/show?t=" + encodeURIComponent(showToken(id)); }
function idOfToken(tok, scope) {
  const m = /^([A-Za-z0-9_-]{4,200})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ""));
  if (!m) return null;
  let id = "";
  try { id = Buffer.from(m[1], "base64url").toString("utf8"); } catch (e) { return null; }
  const a = Buffer.from(m[2]), b = Buffer.from(sigFor(scope, id));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}
/** The current embed pick for a player token, else null. */
function embedForToken(tok) {
  const id = idOfToken(tok, "onair-player:");
  if (!id) return null;
  return TARGET && TARGET.id === id && TARGET.kind === "embed" && !(TARGET.pending || []).length && CFG.enabled ? TARGET : null;
}
/** 1.99acw: the media pick (either lane) a show token belongs to -> {T, lane}, else null (a stale / wrong token, a live page). */
function mediaForToken(tok) {
  const id = idOfToken(tok, "onair-show:");
  if (!id || !CFG.enabled || !CFG.media_enabled) return null;
  for (const [T, lane] of [[TARGET, "main"], [OVERLAY, "corner"]]) {
    if (T && T.id === id && T.kind === "media" && T.media && T.media.mode !== "live") return { T, lane };
  }
  return null;
}
/** The show page reports in (loaded / error / showing every few seconds) -> {on, until}. A direct picture that didn't load ends. */
function showState(tok, state, w, h) {
  const hit = mediaForToken(tok);
  if (!hit) return { on: false };
  const m = hit.T.media;
  const st = ["loaded", "error", "showing"].includes(String(state)) ? String(state) : "showing";
  m.seen_at = now();
  if (st !== "showing") {
    m.show_state = st;
    const W = Math.floor(Number(w)), H = Math.floor(Number(h));
    if (st === "loaded" && W > 0 && H > 0 && W <= 20000 && H <= 20000) m.shown_size = [W, H];
  }
  if (st === "error" && m.direct) check().catch(() => {});
  return { on: true, until: m.until || null };
}
/** The show page's CSP: our own files only, plus - for a direct picture - exactly its origin in img-src. */
function showCsp(origin) {
  const extra = origin && M().ORIGIN_RE.test(origin) ? " " + origin : "";
  return `default-src 'none'; img-src 'self'${extra}; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; ` +
         "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}
/** What the show page renders (escaped by EJS; only our own /onair/m/ files or the checked direct URL as an image source). */
function showView(hit) {
  const m = hit.T.media;
  const file = (f) => (f && M().FILE_RE.test(f) ? "/onair/m/" + f : null);
  const card = m.card ? { title: m.card.title || "", description: m.card.description || "", site: m.card.site || "", domain: m.card.domain || "",
                          img: file(m.asset && m.asset.file), icon: file(m.card.icon),
                          letter: String(m.card.site || m.card.domain || "?").replace(/^www\./i, "").charAt(0).toUpperCase() || "?" } : null;
  return { kind: m.mode === "card" ? "card" : "image", lane: hit.lane, corner: m.corner || "tr", pct: CFG.corner_pct, until: m.until || 0,
           caption: m.caption || "", direct: !!m.direct, src: m.direct ? m.direct.url : file(m.asset && m.asset.file), card };
}
const EMBED_STATES = new Set(["playing", "buffering", "paused", "ended", "error", "offline", "unstarted", "cued", "ad", "loading"]);
function embedState(tok, state, detail) {
  const T = embedForToken(tok);
  if (!T) return { on: false };
  const st = EMBED_STATES.has(String(state)) ? String(state) : "loading";
  T.embed_state = st;
  T.embed_seen_at = now();
  if (st === "playing") T.embed_play_at = now();
  if (detail) T.embed_detail = String(detail).replace(/[\u0000-\u001f]/g, " ").slice(0, 120);
  return { on: true };
}
/** Pepe's poll: {state, optin_events, cmd} in -> {cfg, target, optin, result} out. */
async function forBot(body = {}, t = now()) {
  await init();
  // 1.99acw: caps - what this Pepe can show ("media", "overlay", "live"; an older Pepe sends none and is never sent media)
  const caps = Array.isArray(body.caps) ? body.caps.filter((x) => typeof x === "string" && x.length <= 20 && /^[a-z_]+$/.test(x)).slice(0, 10) : [];
  BOT = { at: t, state: body.state && typeof body.state === "object" ? sanitizeState(body.state) : null, caps };
  for (const e of (Array.isArray(body.optin_events) ? body.optin_events : []).slice(0, 100)) {
    if (e && typeof e === "object") await setOptin(e.login, e.on === true, { via: "chat", ts: Math.floor(Number(e.ts) || t) });
  }
  let result = null;
  if (body.cmd && typeof body.cmd === "object") result = await botCommand(body.cmd);
  await check(t).catch((e) => console.error("[onair] check:", e.message));
  let asks = [];
  try { asks = (await C().camAsks()).map((a) => ({ id: a.id, login: a.login, room: a.room, by: a.by, expires: a.expires })); } catch (e) { asks = []; }
  // 1.99acw: + overlay (the corner lane) and features (a newer Pepe answers !onair image|link locally without "media" here)
  return { ok: true, v: V, cfg: config(), target: await botTarget(), overlay: botOverlay(), features: ["media"],
           optin: [...OPTIN].filter(([, o]) => o.on).map(([l]) => l).slice(0, 5000), asks, result };
}
function sanitizeState(s) {
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
  return { obs: str(s.obs, 20), applied: str(s.applied, 80), shown: !!s.shown, irl: !!s.irl, scene: str(s.scene, 60),
           irl_watch: str(s.irl_watch, 10), irl_switched_from: str(s.irl_switched_from, 60),
           switched_from: str(s.switched_from, 60), source_ok: !!s.source_ok, err: str(s.err, 200), cam: str(s.cam, 30),
           mic_audio: str(s.mic_audio, 10),
           // 1.99acw: pictures / links - the OBS sources exist (media_ok / live_ok / top_ok), the corner lane, Pepe's own refusal
           media_ok: !!s.media_ok, live_ok: !!s.live_ok, top_ok: !!s.top_ok, ov_applied: str(s.ov_applied, 80), ov_shown: !!s.ov_shown,
           media_err: str(s.media_err, 200), media_err_id: str(s.media_err_id, 80),
           // 1.99acw review: why Pepe isn't sending the "live" / "direct" caps (the VM-local steps still missing)
           live_why: str(s.live_why, 200), direct_why: str(s.direct_why, 200) };
}
/** !onair from Camfrog (Pepe checked who may): {action: set|off|leave|status, query, room, by, admin} -> {ok, msg}. */
async function botCommand(c) {
  const by = "pepe:" + String(c.by || "?").slice(0, 40);
  const action = String(c.action || "");
  try {
    if (action === "status") {
      const n = (await Q().list().catch(() => [])).length;
      return { ok: true, msg: statusLine() + (n ? ` ⏰ ${n} queued (!onair queue).` : "") };
    }
    if (action === "consent") {                  // the cam owner answers in Camfrog: !onair yes | always | no
      const who = String(c.by || "").toLowerCase();
      const a = (await C().camAsks()).filter((x) => x.login === who).pop();
      if (!a) return { ok: false, msg: "Nobody is asking for your cam right now." };
      const ans = { yes: "once", always: "always", no: "deny" }[String(c.answer || "")] || null;
      if (!ans) return { ok: false, msg: "!onair yes (this time) | !onair always | !onair no" };
      await C().decide(a.id, ans, { login: who }, "chat");
      return { ok: true, msg: ans === "deny" ? "OK - your cam stays off Pepe's main stream." : ans === "always" ?
        "OK - your cam is on Pepe's main stream now, and admins may put it on again (!onair me off to stop that)." :
        "OK - your cam is on Pepe's main stream now. !onair off takes it off." };
    }
    if (action === "leave") {                    // the streamer / cam owner takes themselves off
      const who = String(c.by || "").toLowerCase();
      if (!TARGET) return { ok: true, msg: "Nothing is on Pepe's main stream." };
      let mine = TARGET.kind === "cam" && TARGET.login === who;
      if (!mine && TARGET.kind !== "cam") {
        const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [TARGET.user_id]))[0];
        mine = !!(u && u.camfrogUsername && String(u.camfrogUsername).toLowerCase() === who);
      }
      if (!mine && !c.admin) return { ok: false, msg: "That isn't yours to take off (it's " + TARGET.label + ")." };
      await clear(mine ? "left" : "off", by);
      return { ok: true, msg: "Taken off Pepe's main stream." };
    }
    if (action === "job") {                      // 1.99acw: Pepe asks how a picture / link request he started is doing
      const v = M().job(c.id, "chat:" + String(c.by || "").toLowerCase().slice(0, 40));
      if (!v) return { ok: false, state: "unknown", final: true, msg: "The website restarted while checking (or that check is gone) - try again." };
      return { ok: v.state !== "refused" && v.state !== "failed", state: v.state, final: v.final, job: v.id, msg: v.msg };
    }
    if (!c.admin) return { ok: false, msg: "Admins only." };
    if (action === "off") {
      const words = String(c.query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const corner = words.includes("corner"), blockIt = words.includes("block");     // 1.99acw: the corner lane only / + block
      if (words.some((w) => w !== "corner" && w !== "block")) return { ok: false, msg: "usage: !onair off [corner] [block]" };
      if (blockIt) {                                  // 1.99acw review: cut + block (its pictures and links never come back)
        const r = await cutAndBlock(corner ? "corner" : "all", by);
        if (!r.picks) return { ok: true, msg: (corner ? "The corner is clear" : "Off Pepe's main stream") + " - there was no picture or link to block." };
        return { ok: true, msg: `⛔ Cut and blocked: ${r.assets} stored picture(s), ${r.urls} link(s) - they can't go on Pepe's stream again.` };
      }
      if (corner) {
        if (!OVERLAY) return { ok: true, msg: "Nothing is in the corner." };
        await clear("off", by, { lane: "corner" });
        return { ok: true, msg: "The corner is clear." };
      }
      await clear("off", by, { lane: "all" });
      return { ok: true, msg: "Off Pepe's main stream - back to normal." };
    }
    if (action === "media") return await botMedia(c, by);
    const said = () => ((TARGET.pending || []).length ? "Asked for the owner's OK - it goes on air once they allow it: " : "On Pepe's main stream: ") + TARGET.label;
    if (action === "cam") { await setCam(c.room, c.query, by, { ask: true }); return { ok: true, msg: said() }; }
    if (action === "queue" || action === "unqueue") return await botQueue(c, by);
    if (action === "set") {
      let q = String(c.query || "").trim();
      const rights = /\s+rights$/i.test(q);
      if (rights) q = q.replace(/\s+rights$/i, "");
      if (isLink(q)) {                           // 1.99abj: a YouTube / Twitch link straight from chat
        if (!rights) return { ok: false, msg: "Add \"rights\" to confirm you have the rights to rebroadcast it (it goes out on Pepe's stream and his Twitch relay): !onair <link> rights" };
        await setEmbed(q, by, { rights: true });
        return { ok: true, msg: "On Pepe's main stream: " + TARGET.label };
      }
      const s = await resolveSlot(q);
      if (s.mode === "embed" && !rights) return { ok: false, msg: "That's a YouTube / Twitch embed - add \"rights\" to confirm you have the rights to rebroadcast it: !onair " + q + " rights" };
      await setSlot(s.id, by, { rights, ask: true });
      return { ok: true, msg: said() };
    }
    return { ok: false, msg: "usage: !onair <pad|user|slot id|link rights> | !onair cam <login> | !onair queue | !onair off" };
  } catch (e) {
    if (e && e.refuse) return { ok: false, msg: e.message };
    console.error("[onair] cmd:", e);
    return { ok: false, msg: "Something went wrong." };
  }
}
const isLink = (q) => /^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be|twitch\.tv)(\/|$)/i.test(String(q || "").trim());
/** 1.99acw: !onair image|link <link> … rights (and queue / at / in) from Camfrog. Pepe checked !onair's admin powers (c.admin)
 *  and the person's REAL role (c.staff: his staff role or above) - direct pictures and live pages need c.staff. The grammar is
 *  onairmedia.parseChat's. -> {ok, msg, job, state, final}: the answer at once when the job ends within 3 s, else Pepe polls
 *  {action: "job", id} and replies with the outcome. */
async function botMedia(c, by) {
  const login = String(c.by || "").toLowerCase().slice(0, 40);
  const spec = M().parseChat(c.mode, c.words, CFG);
  if ((spec.direct || spec.mode === "live") && c.staff !== true) {
    return { ok: false, final: true, msg: "Direct pictures and live pages are for Pepe's staff and up." };
  }
  const whenText = String(c.when || "").trim();
  let at = null;
  if (whenText) {
    at = Q().parseWhen(whenText);
    if (at == null) return { ok: false, final: true, msg: `I can't read "${whenText}" as a time - try 9pm, 21:30, 9:30pm tomorrow or in 45m (New York time).` };
  }
  // 1.99acw review: the person behind the login (users.camfrogUsername) - their site account's userId goes on the safety check and
  // shares the rate limit / strikes with the web; an unlinked login is its own person ("cf:<login>")
  const userId = await M().userIdForLogin(login);
  const v = await startMedia(spec, { actor: "chat:" + login, via: "chat", by, userId, login, queued: !!(c.queue || whenText), at });
  const msg = v.final ? v.msg : `${MODE_ICON[spec.mode] || ""} ${v.msg}`.trim();
  return { ok: v.state !== "refused" && v.state !== "failed", final: v.final, state: v.state, job: v.id, msg };
}
/** 1.99abj: !onair queue [<link> rights] · !onair at <time> <link> rights · !onair in <30m> <link> rights · !onair unqueue <id|all>. */
async function botQueue(c, by) {
  if (c.action === "unqueue") {
    const n = await Q().cancel(c.query, by);
    return n ? { ok: true, msg: `Cancelled ${n} queued link${n === 1 ? "" : "s"}.` } : { ok: false, msg: "Nothing queued matches that - !onair queue lists them." };
  }
  const words = String(c.query || "").trim().split(/\s+/).filter(Boolean);
  const rights = words.length && /^rights$/i.test(words[words.length - 1]);
  if (rights) words.pop();
  const li = words.findIndex(isLink);
  if (li < 0 && !String(c.when || "").trim()) {                  // no link: the list
    const rows = await Q().list();
    if (!rows.length) return { ok: true, msg: "⏰ Nothing queued. !onair queue <link> rights (next up) · !onair at 9pm <link> rights · !onair in 30m <link> rights" };
    return { ok: true, msg: "⏰ " + rows.slice(0, 6).map((r) => `[${r.id}] ${r.at ? Q().fmt(r.at) : "next up"}: ${r.label}`).join(" · ") +
      (rows.length > 6 ? ` (+${rows.length - 6} more)` : "") + " - !onair unqueue <id|all>" };
  }
  if (li < 0) return { ok: false, msg: "Which link? !onair at 9pm <YouTube / Twitch link> rights" };
  const url = words[li];
  const whenText = (String(c.when || "") + " " + words.filter((w, i) => i !== li).join(" ")).trim();
  let at = null;
  if (whenText) {
    at = Q().parseWhen(whenText);
    if (at == null) return { ok: false, msg: `I can't read "${whenText}" as a time - try 9pm, 21:30, 9:30pm tomorrow or in 45m (New York time).` };
  }
  if (!rights) return { ok: false, msg: "Add \"rights\" at the end to confirm you have the rights to rebroadcast it: !onair " + (at ? "at <time> " : "queue ") + "<link> rights" };
  const r = await Q().add({ url, at, by });
  return { ok: true, msg: `⏰ Queued [${r.id}] ${r.label} - ` + (r.at ? `on Pepe's stream ${Q().fmt(r.at)} (replaces whatever is on).` : "next up, after what's on now.") +
    (CFG.enabled ? "" : " On-air is switched OFF right now (/stage/admin).") };
}
/** A live slot by id (prefix), pad (slug / room id) or streamer name. Throws Refuse when none / several. */
async function resolveSlot(q) {
  q = q.trim().toLowerCase().replace(/^@/, "");
  if (!q) throw new Refuse(400, "Which one? !onair <pad|user|slot id>", "bad");
  const t = now();
  const live = (await S().openSlots()).filter((s) => S().isLive(s, t));
  const slugOf = (id) => { const r = rooms().getCached(id); return r && r.slug ? String(r.slug).toLowerCase() : rooms().slugify ? rooms().slugify(id) : String(id).toLowerCase(); };
  const tries = [
    (s) => s.id.toLowerCase() === q || (q.length >= 6 && s.id.toLowerCase().startsWith(q)),
    (s) => String(s.username || "").toLowerCase() === q || String(s.displayname || "").toLowerCase() === q,
    (s) => String(s.room_id || "").toLowerCase() === q || slugOf(s.room_id) === q,
  ];
  for (const f of tries) {
    let hits = live.filter(f);
    if (hits.length > 1) { const feat = hits.filter((s) => s.featured); if (feat.length === 1) hits = feat; }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Refuse(409, "Several live slots match: " + hits.map((s) => `${s.username} (${s.id.slice(0, 8)})`).join(", "), "ambiguous");
  }
  throw new Refuse(404, `No live slot matches "${q}".` + (live.length ? " Live: " + live.slice(0, 6).map((s) => `${s.username} (${s.id.slice(0, 8)})`).join(", ") : " Nothing is live."), "none");
}
function botOk(t = now()) { return !!(BOT && t - BOT.at < BOT_FRESH_MS); }
function statusLine() {
  if (!CFG.enabled) return "On-air is switched OFF (/stage/admin).";
  const st = BOT && BOT.state;
  const pepe = !botOk() ? " Pepe hasn't checked in." : st ? ` OBS ${st.obs || "?"}${st.irl ? ", the IRL feed is live (it wins)" : ""}${st.err ? ", " + st.err : ""}.` : "";
  if (TARGET && (TARGET.pending || []).length) return `Waiting for the owner's OK: ${TARGET.label} (asked by ${TARGET.by}).` + pepe;
  const left = (T) => (T && T.kind === "media" && T.media && T.media.until ? `, ${M().fmtDur(Math.max(0, Math.ceil((T.media.until - now()) / 1000)))} left` : "");
  const corner = OVERLAY ? ` ↗ Corner: ${OVERLAY.label} (by ${OVERLAY.by}${left(OVERLAY)}).` : "";
  return (TARGET ? `On Pepe's main stream: ${TARGET.label} (since ${new Date(TARGET.at).toISOString().slice(11, 16)} UTC, by ${TARGET.by}${left(TARGET)}).` : "Nothing is on Pepe's main stream.") + corner + pepe;
}

// ── views ──
function view() {
  return { v: V, cfg: config(), target: TARGET ? { ...TARGET } : null, overlay: OVERLAY ? { ...OVERLAY } : null,
           pepe: BOT ? { at: BOT.at, online: botOk(), state: BOT.state, caps: BOT.caps || [] } : null };
}
/** 1.99acw: the pictures & links part of the admin view - switches, readiness, limits, what this viewer may use, their jobs. */
async function mediaView(user) {
  const cfgHolder = !!(user && SP.can(user, "onair.config"));
  const dw = mediaRefusal("image", now(), { direct: true });
  return { enabled: !!CFG.media_enabled, live_pages: !!CFG.live_pages, ready: botMediaOk("image"), live_ready: botMediaOk("live"),
           direct_ready: !dw, direct_why: dw ? dw.message : null,
           why: mediaRefusal("image") ? mediaRefusal("image").message : null, live_why: mediaRefusal("live") ? mediaRefusal("live").message : null,
           defaults: { media_secs: CFG.media_secs, live_secs: CFG.live_secs },
           max: { media_s: CFG.media_max_s, live_s: CFG.live_max_s, direct_s: Math.min(CFG.direct_max_s, M().DIRECT_HARD_MAX_S), image_mb: CFG.max_image_mb,
                  caption: M().CAPTION_MAX },
           corner_pct: CFG.corner_pct,
           can: { direct: !!(user && SP.can(user, "onair.direct_media")), live: !!(user && SP.can(user, "onair.live_page")), block: !!(user && SP.can(user, "onair.operate")),
                  lift: cfgHolder },
           jobs: user && user.userId ? M().jobsFor("web:" + user.userId) : [],
           // 1.99acw review: the staff list of recent on-air pictures (block from there) and - for the settings holders - who is
           // blocked from media requests
           recent: user && SP.can(user, "onair.operate") ? await M().recentAssets(24).catch(() => []) : [],
           blocked_people: cfgHolder ? await M().personBlocks().catch(() => []) : [] };
}
async function adminView(user) {
  await init();
  await check().catch(() => {});
  const t = now();
  const slots = [];
  for (const s of await S().openSlots()) {
    if (!S().isLive(s, t)) continue;
    const e = s.mode === "embed" ? embedOf(s) : null;
    slots.push({ id: s.id, username: s.username, display: s.displayname || s.username, title: s.title || null, pad: s.room_id,
                 library: s.source === "library", embed: e ? EMB().label(e) : null, why: s.mode === "embed" && !e ? "embed_bad" : await slotWhyNot(s, { padOk: true }, t),
                 ask: !(await padConsent(s.room_id || rooms().HOUSE_ROOM)) });
  }
  const cams = [];
  for (const R of bridge()._rooms.values()) {
    if (!bridge().isLive(R)) continue;
    for (const m of R.members || []) {
      if (!m || m.anon || m.self || m.bot || !m.on_cam || !m.login) continue;
      const login = String(m.login).toLowerCase();
      const why = await camWhyNot(R.id, login, { optinOk: true, padOk: true });
      const ask = !why && (!camConsent(login, null, t, R.id) || !(await padConsent(R.id)));     // stagefix site: the same OK setCam needs (D-9)
      cams.push({ room: R.id, roomName: R.name || R.id, login, display: m.display || login, why, ask });
      if (cams.length >= 200) break;
    }
  }
  // stagefix fix: a cam whose owner and this admin blocked one another is "unavailable" in the list too (setCam refuses it) - the
  // same word as private activity, so the list and the refusal agree and neither says which
  try {
    const ids = await actorIdsOf(user, null);
    const no = ids.length ? await LC().blockedSet(cams.filter((c) => !c.why).map((c) => c.login), ids) : new Set();
    for (const c of cams) if (!c.why && no.has(c.login)) { c.why = "unavailable"; c.ask = false; }
  } catch (e) { /* no blocks to show */ }
  const logRows = await getQuery("SELECT at, what, by, kind, ref, label, detail, url FROM onair_log ORDER BY id DESC LIMIT 40");
  const pending = [];
  for (const id of (TARGET && TARGET.pending) || []) { const c = await C().get(id); if (c) pending.push(c); }
  const queue = await Q().list().catch(() => []);
  return { ...view(), now: t, slots, cams, pending, log: logRows, why: WHY, optins: [...OPTIN.values()].filter((o) => o.on).length, queue,
           media: await mediaView(user) };
}

// ── routes ──
let timer = null;
function register(app, { addUser, isBotToken, noTimers } = {}) {
  init().catch((e) => console.error("[onair] init:", e.message));
  if (!noTimers && !timer) {
    timer = setInterval(() => check().catch((e) => console.error("[onair] check:", e.message)), 5000);
    if (timer.unref) timer.unref();
  }
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[onair]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const csrf = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch" ? next()
    : res.status(403).json({ ok: false, error: "Security check failed - reload the page." }));
  const needAdmin = (req, res, next) => (SP.can(req.user, "onair.config") ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  // 1.99aan: site staff (Admin / Staff - the same rule as ghost mode) may pick / cut from the player bar too; the settings stay Admin-only
  const needStaff = (req, res, next) => (SP.can(req.user, "onair.operate") ? next() : res.status(403).json({ ok: false, error: "Site staff only." }));
  const actor = (req) => "web:" + ((req.user && req.user.username) || "?");
  const adm = (req) => ({ userId: req.user.userId, username: req.user.username });

  // Pepe
  app.post("/api/stage/onair/bot", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json(await forBot(b)); } catch (e) { fail(res, e); }
  });

  // admins (/stage/admin card)
  app.get("/api/stage/admin/onair", addUser, needStaff, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await adminView(req.user)) }); } catch (e) { fail(res, e); }
  });
  // 1.99acw: a picture / link request still being checked (the panel polls it); your own jobs only (onair.config: anyone's)
  app.get("/api/stage/admin/onair/job/:id", addUser, needStaff, (req, res) => {
    res.set("Cache-Control", "no-store");
    const v = M().job(req.params.id, "web:" + req.user.userId, { any: SP.can(req.user, "onair.config") });
    if (!v) return res.status(404).json({ ok: false, error: "That check is gone (the website may have restarted) - try again." });
    res.json({ ok: true, job: v });
  });
  app.post("/api/stage/admin/onair", addUser, needStaff, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    try {
      if (b.action === "slot") await setSlot(b.slot_id, actor(req), { admin: adm(req), rights: b.rights === true, ask: b.ask === true });
      else if (b.action === "cam") await setCam(b.room, b.login, actor(req), { admin: adm(req), ask: b.ask === true });
      else if (b.action === "embed") await setEmbed(b.url, actor(req), { admin: adm(req), rights: b.rights === true });
      else if (b.action === "queue") {                 // 1.99abj: ⏰ a link for later (at = ms, or null = next up)
        if (b.rights !== true) throw refuse("rights");
        const r = await Q().add({ url: b.url, at: b.at == null || b.at === "" ? null : Number(b.at), by: actor(req) });
        await log("queued", actor(req), null, { id: r.id, label: r.label, at: r.at });
        await audit(adm(req), "queue", null, { id: r.id, label: r.label, at: r.at, rights_confirmed: true });
      }
      else if (b.action === "unqueue") {
        const n = await Q().cancel(b.id, actor(req));
        if (!n) throw new Refuse(404, "That queued link is gone.", "gone");
        await audit(adm(req), "unqueue", null, { id: String(b.id || "").slice(0, 20) });
      }
      else if (b.action === "library") {
        await setLibrary(b.key, actor(req), { admin: adm(req), user: { userId: req.user.userId, username: req.user.username, class: req.user.class } });
      }
      else if (b.action === "golive") {
        const g = await setGoLive({ userId: req.user.userId, username: req.user.username, class: req.user.class }, actor(req),
                                  { admin: adm(req), minutes: b.minutes, title: b.title });
        return res.json({ ok: true, golive: g, ...(await adminView(req.user)) });
      }
      else if (b.action === "media") {                 // 1.99acw: 🖼 a picture / 🔗 a card / 🌐 a live page (now or ⏰ queued)
        await init();
        const spec = M().validateSpec(b, CFG);
        if (spec.direct && !SP.can(req.user, "onair.direct_media")) throw new Refuse(403, "Direct pictures are for Staff and up (not scanned; the picture's site sees Pepe's address).", "staff_only");
        if (spec.mode === "live" && !SP.can(req.user, "onair.live_page")) throw new Refuse(403, "Live pages are for Staff and up (Pepe's OBS opens the page itself).", "staff_only");
        const queued = b.queue === true || (b.at != null && b.at !== "");
        const job = await startMedia(spec, { actor: "web:" + req.user.userId, via: "web", by: actor(req), admin: adm(req), userId: req.user.userId,
                                              login: req.user.camfrogUsername || null, queued, at: b.at == null || b.at === "" ? null : Number(b.at) });
        if (job.final && job.state !== "done") return res.status(422).json({ ok: false, code: job.code, error: job.msg, job, ...(await adminView(req.user)) });
        return res.json({ ok: true, job, ...(await adminView(req.user)) });
      }
      else if (b.action === "off") {
        const lane = b.lane === "corner" || b.lane === "main" ? b.lane : "all";
        // 1.99acw review: "Cut + block" - the lane off AND its pictures / links blocked for good
        if (b.block === true) await cutAndBlock(lane, actor(req), { admin: adm(req) });
        else await clear("off", actor(req), { admin: adm(req), lane });
      }
      else if (b.action === "media_block") {          // 1.99acw review: block a stored picture from the recent list
        const r = await blockAsset({ asset: String(b.asset || "").slice(0, 40) }, actor(req), { admin: adm(req) });
        if (!r.assets.length) throw new Refuse(404, "That picture is gone.", "gone");
      }
      else if (b.action === "media_unblock_person") { // 1.99acw review: lift a person's block from media requests (admins)
        if (!SP.can(req.user, "onair.config")) throw new Refuse(403, "Admins only.", "admin_only");
        const who = String(b.who || "").slice(0, 60);
        if (!(await M().liftPerson(who, actor(req)))) throw new Refuse(404, "That block is gone.", "gone");
        await log("lifted", actor(req), null, { who });
        await audit(adm(req), "unblock_person", null, { who });
      }
      else if (b.action === "config") {
        if (!SP.can(req.user, "onair.config")) throw new Refuse(403, "Admins only.", "admin_only");
        await saveConfig(b.cfg || {}, actor(req), { admin: adm(req) });
      }
      else throw new Refuse(400, "Unknown action.", "bad");
      res.json({ ok: true, ...(await adminView(req.user)) });
    } catch (e) { fail(res, e); }
  });

  // 1.99acw: the show page (pictures / cards / direct pictures) - loaded ONLY by Pepe's OBS browser sources "PATV OnAir Web"
  // (full) and "PATV OnAir Corner" (corner); the token is the pick's. A stale / wrong token = an empty transparent page.
  // A strict CSP: our own script / style / pictures, plus exactly the direct picture's origin in img-src.
  app.get("/onair/show", (req, res) => {
    const hit = mediaForToken(req.query.t);
    const origin = hit && hit.T.media.direct ? hit.T.media.direct.origin : null;
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY", "Content-Security-Policy": showCsp(origin) });
    res.render("onairShow", { item: hit ? showView(hit) : null, token: hit ? String(req.query.t) : "" });
  });
  const showHits = guard.limiter({ max: 60, windowMs: 60 * 1000 });
  app.post("/api/onair/show/state", (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    const key = "s:" + String(b.t || "").slice(-32);
    if (showHits.blocked(key)) return res.status(429).json({ ok: false });
    showHits.hit(key);
    res.json({ ok: true, ...showState(b.t, b.state, b.w, b.h) });
  });
  M().register(app);                                    // GET /onair/m/<file> - the stored pictures

  // 1.99aag: the embed player page (OBS's browser source loads it; the token is the pick's - nothing else on it)
  app.get("/onair/player", (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "strict-origin-when-cross-origin" });
    const T = embedForToken(req.query.t);
    res.render("onairPlayer", { embed: T ? T.embed : null, token: String(req.query.t || ""), parent: new URL(SITE()).hostname });
  });
  const stHits = guard.limiter({ max: 60, windowMs: 60 * 1000 });
  app.post("/api/onair/player/state", (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    const key = "t:" + String(b.t || "").slice(-32);
    if (stHits.blocked(key)) return res.status(429).json({ ok: false });
    stHits.hit(key);
    res.json({ ok: true, ...embedState(b.t, b.state, b.detail) });
  });

  // a streamer takes their own slot off (the inbox note points here via !onair off; this is the web way)
  app.post("/api/stage/onair/leave", addUser, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await init();
      if (!TARGET || TARGET.kind === "cam" || String(TARGET.user_id) !== String(req.user.userId)) return res.json({ ok: true, onair: false });
      await clear("left", actor(req));
      res.json({ ok: true, onair: false });
    } catch (e) { fail(res, e); }
  });

  // Settings → Privacy (#onair): the cam owner's opt-in (their linked chat login)
  app.get("/api/privacy/onair", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await optinState(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  const hits = guard.limiter({ max: 20, windowMs: 60 * 60 * 1000 });
  app.post("/api/privacy/onair", addUser, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const on = (req.body || {}).on;
      if (typeof on !== "boolean") throw new Refuse(400, "on must be true or false", "bad");
      const st = await optinState(req.user.userId);
      if (!st.linked) throw new Refuse(409, "Link your Camfrog name first - this is about your cam there.", "unlinked");
      if (hits.blocked("u:" + req.user.userId)) throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
      hits.hit("u:" + req.user.userId);
      await setOptin(st.login, on, { via: "web", userId: String(req.user.userId) });
      res.json({ ok: true, ...(await optinState(req.user.userId)) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, init, forBot, botCommand, botQueue, isLink, setSlot, setCam, setEmbed, setLibrary, setGoLive, clear, saveConfig, check, adminView, view, config, clean, setOptin, optinState, optedIn,
  slotWhyNot, camWhyNot, resolveSlot, Refuse, DEFAULTS, WHY, LIVE_GRACE_MS, EMBED_GRACE_MS, onConsentChange, embedForToken, embedState, playerToken,
  // 1.99acw: pictures / cards / live pages
  mediaActive, mediaRefusal, setMedia, startMedia, botMedia, botOverlay, showToken, mediaForToken, showState, showCsp, mediaSweep, sanitizeState, BOT_FRESH_MS,
  cutAndBlock, blockAsset, blockFromSafetyLog, CHAT_EXPOSED_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { CFG = { ...DEFAULTS }; TARGET = null; OVERLAY = null; V = 0; BOT = null; OPTIN = new Map(); ready = null; lastMediaSweep = 0; },
};
