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
//   * never: embeds (YouTube / Twitch players can't be put into OBS here - a browser source would be needed, ToS), slots
//     or cams of Approved pads, NSFW slots, banned streamers; 📼 Plex library plays only with allow_library on (Pepe's
//     main stream is relayed to Twitch - restream.js - so a movie there is a DMCA risk; default off).
//   * audit: onair_log (every set / end / config change, who and why) + admin_audit rows for the web admin's actions.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const STAGING = !!process.env.STAGING;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const OBS_NAME_RE = /^[^\u0000-\u001f"\\]{1,60}$/;
const LIVE_GRACE_MS = 90 * 1000;        // a slot on air that isn't live this long is taken off
const BOT_FRESH_MS = 30 * 1000;
const AUDIT = "onair";

const DEFAULTS = Object.freeze({
  enabled: STAGING,              // the kill switch
  cam_optin: true,               // a cam needs its owner's opt-in for the main stream
  allow_library: false,          // 📼 Plex library plays (Twitch relay = DMCA risk)
  auto_scene: true,              // switch OBS to `scene` when the program scene has no IRL in it
  scene: "Pepe",                 // OBS: the program scene to switch to
  irl_scene: "IRL",              // OBS: the nested scene that holds the IRL feed + the on-air source
  irl_source: "IRL BB",          // OBS: the operator's IRL feed (wins while PLAYING)
  source: "PATV OnAir",          // OBS: the on-air media source
  cam_fps: 15,                   // a cam on air: Pepe's local encode
  cam_kbps: 1500,
});
const BOOLS = ["enabled", "cam_optin", "allow_library", "auto_scene"];
const NAMES = ["scene", "irl_scene", "irl_source", "source"];
const NUMS = { cam_fps: [5, 30], cam_kbps: [200, 6000] };

let clock = () => Date.now();
const now = () => clock();
const S = () => require("./mainstage");
const PA = () => require("./padaccess");
const rooms = () => require("./rooms");
const bridge = () => require("./bridge");
const LC = () => require("./livecam");

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code || null; } }

const WHY = {
  gone: "That slot doesn't exist.",
  ended: "That slot has ended.",
  not_live: "That slot isn't live.",
  embed: "Embeds (YouTube / Twitch) can't go on Pepe's OBS.",
  nsfw: "That slot is marked NSFW.",
  pad_private: "That pad is Approved-only - its stage and cams stay off Pepe's main stream.",
  banned: "That streamer is banned from the stage.",
  library: "📼 Plex plays are off for Pepe's main stream (allow_library) - his stream is relayed to Twitch.",
  offline: "That Camfrog room isn't live on the site.",
  room_off: "Cams aren't bridged in that room (!bridge cams on).",
  not_on_cam: "They aren't on cam.",
  livecam_off: "They've switched off live video of their cam.",
  private: "They keep their room activity private.",
  no_optin: "They haven't allowed their cam on Pepe's main stream (Settings → Privacy, or !onair me on in Camfrog).",
  self: "That's Pepe's own cam.",
  off: "On-air is switched off (/stage/admin).",
};

// ── storage ──
let CFG = { ...DEFAULTS };
let TARGET = null;              // {id, kind, slot_id?, room?, login?, display?, pad, label, by, at, notified?}
let V = 0;
let BOT = null;                 // {at, state}
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
      const r = (await getQuery("SELECT v, cfg, target FROM onair_state WHERE id = 1"))[0];
      if (r) {
        V = Number(r.v) || 0;
        try { CFG = clean(JSON.parse(r.cfg) || {}, DEFAULTS).cfg; } catch (e) { CFG = { ...DEFAULTS }; }
        try { TARGET = r.target ? JSON.parse(r.target) : null; } catch (e) { TARGET = null; }
      }
      OPTIN = new Map((await getQuery("SELECT login, on_air, updated, via FROM onair_optin")).map((x) =>
        [String(x.login).toLowerCase(), { on: !!x.on_air, updated: Number(x.updated) || 0, via: x.via || null }]));
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function persist(by) {
  V += 1;
  await runQuery(`INSERT INTO onair_state (id, v, cfg, target, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET v = excluded.v, cfg = excluded.cfg, target = excluded.target,
                  updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                 [V, JSON.stringify(CFG), TARGET ? JSON.stringify(TARGET) : null, now(), String(by || "?").slice(0, 80)]);
}
async function log(what, by, T, detail) {
  try {
    await runQuery("INSERT INTO onair_log (at, what, by, kind, ref, label, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [now(), String(what).slice(0, 30), String(by || "?").slice(0, 80), T ? T.kind : null, T ? refOf(T) : null, T ? String(T.label || "").slice(0, 120) : null,
       detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)]);
  } catch (e) { console.error("[onair] log:", e.message); }
  console.log(`[onair] ${what} by=${by}${T ? " " + T.kind + ":" + refOf(T) : ""}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
const refOf = (T) => (T.kind === "slot" ? T.slot_id : T.room + "|" + T.login);

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
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    if (!(k in src)) continue;
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= lo && n <= hi) cfg[k] = Math.round(n); else errors[k] = `${lo}–${hi}`;
  }
  return { cfg, errors };
}
const config = () => ({ ...CFG });

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
async function slotWhyNot(s, { needLive = true } = {}, t = now()) {
  if (!s) return "gone";
  if (s.settled || !["waiting", "active"].includes(s.status)) return "ended";
  if (s.mode === "embed") return "embed";
  if (s.nsfw) return "nsfw";
  if (s.source === "library" && !CFG.allow_library) return "library";
  await PA().init();
  if (PA().isApproved(s.room_id || rooms().HOUSE_ROOM)) return "pad_private";   // an Approved pad's stage is for its members
  if (await S().isBanned(s.userId, s.room_id)) return "banned";
  if (needLive && !S().isLive(s, t)) return "not_live";
  return null;
}
function camMember(R, login) {
  return (R.members || []).find((x) => x && !x.anon && String(x.login || "").toLowerCase() === login) || null;
}
async function camWhyNot(room, login) {
  const R = bridge()._rooms.get(String(room || ""));
  if (!R || !bridge().isLive(R)) return "offline";
  if (!R.cams) return "room_off";
  const m = camMember(R, login);
  if (m && m.self) return "self";
  if (!m || !m.on_cam || m.bot) return "not_on_cam";
  try { if (LC().optedOut(login)) return "livecam_off"; } catch (e) { /* no live cams module */ }
  try { if ((await require("./stories").privateLogins([login])).has(login)) return "private"; } catch (e) { /* none */ }
  if (CFG.cam_optin && !optedIn(login)) return "no_optin";
  await PA().init();
  if (PA().isApproved(R.id)) return "pad_private";
  return null;
}
const refuse = (code) => new Refuse(code === "gone" ? 404 : 409, WHY[code] || code, code);

// ── set / clear ──
async function setSlot(slotId, by, { admin } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  const s = await S().getSlot(String(slotId || ""));
  const why = await slotWhyNot(s);
  if (why) throw refuse(why);
  const prev = TARGET;
  const label = `${s.displayname || s.username}${s.title ? " - " + s.title : ""}${s.source === "library" ? " (📼)" : ""}`;
  TARGET = { id: "s:" + s.id + ":" + now().toString(36), kind: "slot", slot_id: s.id, user_id: s.userId, username: s.username,
             pad: s.room_id || rooms().HOUSE_ROOM, label, by: String(by), at: now(), live_at: now() };
  await persist(by);
  if (prev) await log("replaced", by, prev);
  await log("set", by, TARGET);
  if (admin) await audit(admin, "set", TARGET);
  rooms().notify(s.userId, { kind: "stage", title: "You're on Pepe's main stream",
    body: "An admin put your stream on Pepe's main stream (publicaccess.tv, his Twitch relay and his Camfrog cam). " +
          "Type !onair off in Camfrog (from your linked name) to take it off, or end your slot.", link: "/stage", ref: "onair:" + s.id })
    .catch(() => {});
  return view();
}
async function setCam(room, login, by, { admin } = {}) {
  await init();
  if (!CFG.enabled) throw refuse("off");
  login = String(login || "").toLowerCase().replace(/^@/, "");
  if (!LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?", "bad");
  const why = await camWhyNot(room, login);
  if (why) throw refuse(why);
  const R = bridge()._rooms.get(String(room));
  const m = camMember(R, login);
  const prev = TARGET;
  TARGET = { id: "c:" + login + ":" + now().toString(36), kind: "cam", room: R.id, login, display: (m && m.display) || login, pad: R.id,
             label: `📷 ${(m && m.display) || login} (${R.name || R.id})`, by: String(by), at: now() };
  await persist(by);
  if (prev) await log("replaced", by, prev);
  await log("set", by, TARGET);
  if (admin) await audit(admin, "set", TARGET);
  return view();
}
async function clear(why, by, { admin } = {}) {
  await init();
  if (!TARGET) return view();
  const T = TARGET;
  TARGET = null;
  await persist(by);
  await log("end", by, T, why);
  if (admin) await audit(admin, "off", T);
  return view();
}
async function audit(admin, action, T) {
  try { await require("./adminaudit").record(admin, AUDIT, null, { action, kind: T ? T.kind : null, ref: T ? refOf(T) : null, label: T ? T.label : null }); }
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
  if (!CFG.enabled && TARGET) { const T = TARGET; TARGET = null; await log("end", by, T, "switched_off"); }
  await persist(by);
  await log("config", by, null, changed);
  if (admin) { try { await require("./adminaudit").record(admin, AUDIT, null, { action: "config", changed }); } catch (e) { /* logged above */ } }
  return config();
}

/** Every few seconds (and on each of Pepe's polls): end a target that no longer may / can be on air. */
let checking = null;
function check(t = now()) {
  if (checking) return checking;
  checking = (async () => {
    await init();
    if (!TARGET) return null;
    if (!CFG.enabled) return clear("switched_off", "system");
    if (TARGET.kind === "slot") {
      const s = await S().getSlot(TARGET.slot_id);
      const why = await slotWhyNot(s, { needLive: false }, t);
      if (why) return clear(why, "system");
      if (S().isLive(s, t)) TARGET.live_at = t;
      else if (t - (TARGET.live_at || TARGET.at) > LIVE_GRACE_MS) return clear("not_live", "system");
    } else {
      const why = await camWhyNot(TARGET.room, TARGET.login);
      if (why) return clear(why, "system");
    }
    return null;
  })().finally(() => { checking = null; });
  return checking;
}

// ── what Pepe gets ──
async function botTarget() {
  if (!TARGET || !CFG.enabled) return null;
  const T = TARGET;
  if (T.kind === "slot") {
    const s = await S().getSlot(T.slot_id);
    if (!s) return null;
    return { id: T.id, kind: "slot", label: T.label, url: S().hlsOf(s), live: S().isLive(s), since: T.at };
  }
  return { id: T.id, kind: "cam", label: T.label, room: T.room, login: T.login, display: T.display, since: T.at };
}
/** Pepe's poll: {state, optin_events, cmd} in -> {cfg, target, optin, result} out. */
async function forBot(body = {}, t = now()) {
  await init();
  BOT = { at: t, state: body.state && typeof body.state === "object" ? sanitizeState(body.state) : null };
  for (const e of (Array.isArray(body.optin_events) ? body.optin_events : []).slice(0, 100)) {
    if (e && typeof e === "object") await setOptin(e.login, e.on === true, { via: "chat", ts: Math.floor(Number(e.ts) || t) });
  }
  let result = null;
  if (body.cmd && typeof body.cmd === "object") result = await botCommand(body.cmd);
  await check(t).catch((e) => console.error("[onair] check:", e.message));
  return { ok: true, v: V, cfg: config(), target: await botTarget(), optin: [...OPTIN].filter(([, o]) => o.on).map(([l]) => l).slice(0, 5000), result };
}
function sanitizeState(s) {
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
  return { obs: str(s.obs, 20), applied: str(s.applied, 80), shown: !!s.shown, irl: !!s.irl, scene: str(s.scene, 60),
           switched_from: str(s.switched_from, 60), source_ok: !!s.source_ok, err: str(s.err, 200), cam: str(s.cam, 30) };
}
/** !onair from Camfrog (Pepe checked who may): {action: set|off|leave|status, query, room, by, admin} -> {ok, msg}. */
async function botCommand(c) {
  const by = "pepe:" + String(c.by || "?").slice(0, 40);
  const action = String(c.action || "");
  try {
    if (action === "status") return { ok: true, msg: statusLine() };
    if (action === "leave") {                    // the streamer / cam owner takes themselves off
      const who = String(c.by || "").toLowerCase();
      if (!TARGET) return { ok: true, msg: "Nothing is on Pepe's main stream." };
      let mine = TARGET.kind === "cam" && TARGET.login === who;
      if (!mine && TARGET.kind === "slot") {
        const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [TARGET.user_id]))[0];
        mine = !!(u && u.camfrogUsername && String(u.camfrogUsername).toLowerCase() === who);
      }
      if (!mine && !c.admin) return { ok: false, msg: "That isn't yours to take off (it's " + TARGET.label + ")." };
      await clear(mine ? "left" : "off", by);
      return { ok: true, msg: "Taken off Pepe's main stream." };
    }
    if (!c.admin) return { ok: false, msg: "Admins only." };
    if (action === "off") { await clear("off", by); return { ok: true, msg: "Off Pepe's main stream - back to normal." }; }
    if (action === "cam") { await setCam(c.room, c.query, by); return { ok: true, msg: "On Pepe's main stream: " + TARGET.label }; }
    if (action === "set") {
      const s = await resolveSlot(String(c.query || ""));
      await setSlot(s.id, by);
      return { ok: true, msg: "On Pepe's main stream: " + TARGET.label };
    }
    return { ok: false, msg: "usage: !onair <pad|user|slot id> | !onair cam <login> | !onair off" };
  } catch (e) {
    if (e && e.refuse) return { ok: false, msg: e.message };
    console.error("[onair] cmd:", e);
    return { ok: false, msg: "Something went wrong." };
  }
}
/** A live slot by id (prefix), pad (slug / room id) or streamer name. Throws Refuse when none / several. */
async function resolveSlot(q) {
  q = q.trim().toLowerCase().replace(/^@/, "");
  if (!q) throw new Refuse(400, "Which one? !onair <pad|user|slot id>", "bad");
  const t = now();
  const live = (await S().openSlots()).filter((s) => S().isLive(s, t) && s.mode !== "embed");
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
  return (TARGET ? `On Pepe's main stream: ${TARGET.label} (since ${new Date(TARGET.at).toISOString().slice(11, 16)} UTC, by ${TARGET.by}).` : "Nothing is on Pepe's main stream.") + pepe;
}

// ── views ──
function view() {
  return { v: V, cfg: config(), target: TARGET ? { ...TARGET } : null, pepe: BOT ? { at: BOT.at, online: botOk(), state: BOT.state } : null };
}
async function adminView() {
  await init();
  await check().catch(() => {});
  const t = now();
  const slots = [];
  for (const s of await S().openSlots()) {
    if (!S().isLive(s, t)) continue;
    slots.push({ id: s.id, username: s.username, display: s.displayname || s.username, title: s.title || null, pad: s.room_id,
                 library: s.source === "library", why: await slotWhyNot(s, {}, t) });
  }
  const cams = [];
  for (const R of bridge()._rooms.values()) {
    if (!bridge().isLive(R)) continue;
    for (const m of R.members || []) {
      if (!m || m.anon || m.self || m.bot || !m.on_cam || !m.login) continue;
      const login = String(m.login).toLowerCase();
      cams.push({ room: R.id, roomName: R.name || R.id, login, display: m.display || login, why: await camWhyNot(R.id, login) });
      if (cams.length >= 200) break;
    }
  }
  const logRows = await getQuery("SELECT at, what, by, kind, ref, label, detail FROM onair_log ORDER BY id DESC LIMIT 40");
  return { ...view(), now: t, slots, cams, log: logRows, why: WHY, optins: [...OPTIN.values()].filter((o) => o.on).length };
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
  const needAdmin = (req, res, next) => (req.user && req.user.class === "Admin" ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
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
  app.get("/api/stage/admin/onair", addUser, needAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/onair", addUser, needAdmin, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    try {
      if (b.action === "slot") await setSlot(b.slot_id, actor(req), { admin: adm(req) });
      else if (b.action === "cam") await setCam(b.room, b.login, actor(req), { admin: adm(req) });
      else if (b.action === "off") await clear("off", actor(req), { admin: adm(req) });
      else if (b.action === "config") await saveConfig(b.cfg || {}, actor(req), { admin: adm(req) });
      else throw new Refuse(400, "Unknown action.", "bad");
      res.json({ ok: true, ...(await adminView()) });
    } catch (e) { fail(res, e); }
  });

  // a streamer takes their own slot off (the inbox note points here via !onair off; this is the web way)
  app.post("/api/stage/onair/leave", addUser, csrf, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await init();
      if (!TARGET || TARGET.kind !== "slot" || String(TARGET.user_id) !== String(req.user.userId)) return res.json({ ok: true, onair: false });
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
  register, init, forBot, botCommand, setSlot, setCam, clear, saveConfig, check, adminView, view, config, clean, setOptin, optinState, optedIn,
  slotWhyNot, camWhyNot, resolveSlot, Refuse, DEFAULTS, WHY, LIVE_GRACE_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { CFG = { ...DEFAULTS }; TARGET = null; V = 0; BOT = null; OPTIN = new Map(); ready = null; },
};
