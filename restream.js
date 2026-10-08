// restream.js — "Also stream to Twitch": a server-side relay of a PATV stream to the streamer's own Twitch (1.99fk).
//
// Who / what:
//   DESTINATION  one saved Twitch destination per owner: a stage streamer (owner = their userId) or Pepe's main
//                stream (owner "@main", admins only). {server, key}. The stream key is encrypted at rest
//                (AES-256-GCM, key = HKDF-SHA256(RESTREAM_SECRET), the owner id as AAD) and never shown again
//                after saving - only ••••last4. Replace or delete it any time.
//   TOGGLE       per stream: Pepe's main stream ("main", admin toggle on /stage/admin) and every slot ("slot:<id>",
//                its streamer's toggle on /stage). A slot without its own toggle follows the destination's
//                "auto" switch ("turn it on for my new slots"). Switchable while live.
//   RELAY        runs only while the stream is LIVE on nginx-rtmp AND its toggle is on AND a key is saved
//                (desired()). The relay worker (deploy/restream/patv-restream.js, systemd patv-restream@<inst>)
//                polls POST /api/restream/worker/sync every few seconds (loopback only + a shared token): it
//                reports what it runs and gets back the list it should run. One ffmpeg per relay reads the stream
//                back from nginx-rtmp over loopback and copies it (-c copy, no re-encode) to Twitch.
//
// Sources: Pepe = rtmp://127.0.0.1/live/<his RTMP name> (OBS RTMP or his WHIP stream via pepe-relay.sh - both
// end up there as H.264 + AAC); slots streamed by RTMP or the browser relay = rtmp://127.0.0.1/<OUT>/<slot stream>.
// WHIP slots (Opus audio, MediaMTX only) can't be relayed yet - the UI says so.
// The copy keeps the streamer's encode: Twitch wants H.264 + AAC, keyframes every <= 2 s (4 s max) and about
// <= 6000 kbps. A slot that doesn't meet that still gets relayed; Twitch may reject or buffer it (the status
// shows the measured bitrate and a warning).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

let clock = () => Date.now();
const now = () => clock();
const STAGING = !!process.env.STAGING;
const MAIN = "main";                 // the toggle / relay id of Pepe's main stream
const MAIN_OWNER = "@main";          // its destination's owner id (no userId starts with "@")
const DEFAULT_SERVER = "rtmp://live.twitch.tv/app";
const BEAT_STALE_MS = 30 * 1000;     // nginx-rtmp on_update comes every 10 s
const STATUS_STALE_MS = 20 * 1000;   // the worker reports every ~3 s; quieter than this = worker down
const TWITCH_MAX_KBPS = 6000;

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// ── settings that come from the environment (read when used, so tests can set them) ──
const secret = () => String(process.env.RESTREAM_SECRET || "");
const workerToken = () => String(process.env.RESTREAM_TOKEN || "");
const allowLoopback = () => /^(1|true|yes|on)$/i.test(String(process.env.RESTREAM_ALLOW_LOOPBACK || ""));
function outApp() { try { return require("./mainstage").OUT_APP; } catch (e) { return STAGING ? "live_staging" : "live"; } }
const srcBase = () => String(process.env.RESTREAM_SRC_BASE || `rtmp://127.0.0.1/${outApp()}`).replace(/\/+$/, "");
// Pepe's RTMP name on the HLS application (prod only: staging has no main stream of its own)
const mainStream = () => (process.env.RESTREAM_MAIN_STREAM !== undefined ? String(process.env.RESTREAM_MAIN_STREAM)
  : (STAGING ? "" : String(process.env.STAGE_PEPE_KEYS || "broadcast").split(",")[0].trim()));
const configured = () => secret().length >= 16;

// ── crypto: AES-256-GCM, a fresh 12-byte IV per save, the owner id bound in as AAD ──
function aesKey(s = secret()) {
  if (String(s).length < 16) throw new Refuse(503, "Restreaming isn't set up on this server yet.");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(String(s)), Buffer.from("patv-restream-v1"), Buffer.from("stream-key"), 32));
}
function encrypt(plain, owner, s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(s), iv);
  c.setAAD(Buffer.from("owner:" + owner));
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
function decrypt(blob, owner, s) {
  const p = String(blob || "").split(".");
  if (p.length !== 4 || p[0] !== "v1") throw new Error("bad ciphertext");
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey(s), Buffer.from(p[1], "base64url"));
  d.setAAD(Buffer.from("owner:" + owner));
  d.setAuthTag(Buffer.from(p[2], "base64url"));
  return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
}
const mask = (last4) => (last4 ? "••••" + last4 : null);

// ── validation ──
// A Twitch stream key: live_<digits>_<letters/digits> (old keys: other shapes). No spaces, no slashes.
function cleanKey(v) {
  const k = String(v == null ? "" : v).trim();
  if (!k) return "";
  if (k.length < 8 || k.length > 200 || !/^[A-Za-z0-9_\-.?=&]+$/.test(k)) throw new Refuse(400, "That doesn't look like a stream key (letters, digits and _ - only).");
  return k;
}
const TWITCH_HOST = /^([a-z0-9-]+\.)*(twitch\.tv|contribute\.live-video\.net)$/i;
const LOOP_HOST = /^(127\.0\.0\.1|localhost)$/i;
/** rtmp(s)://<Twitch ingest>/app[/] -> normalised, or a Refuse. Blank / "auto" = Twitch's own nearest ingest. */
function cleanServer(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^auto$/i.test(s)) return DEFAULT_SERVER;
  let u;
  try { u = new URL(s); } catch (e) { throw new Refuse(400, "The server must be a Twitch ingest URL like rtmp://live.twitch.tv/app."); }
  if (!/^rtmps?:$/.test(u.protocol)) throw new Refuse(400, "The server must start with rtmp:// or rtmps://.");
  if (u.username || u.password || u.search || u.hash) throw new Refuse(400, "Just the ingest server - the key goes in its own field.");
  const host = u.hostname;
  if (!TWITCH_HOST.test(host) && !(allowLoopback() && LOOP_HOST.test(host))) throw new Refuse(400, "Only Twitch ingest servers (…twitch.tv or …contribute.live-video.net).");
  const path = u.pathname.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9_-]{1,32}$/.test(path)) throw new Refuse(400, "The server path should be /app.");
  return `${u.protocol}//${u.host}${path}`;
}

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS restream_dest (
        owner TEXT PRIMARY KEY,            -- userId, or "@main" (Pepe's main stream)
        service TEXT NOT NULL DEFAULT 'twitch',
        server TEXT NOT NULL,
        key_enc TEXT NOT NULL,             -- encrypt(key, owner): v1.<iv>.<tag>.<ct>
        last4 TEXT,
        auto INTEGER NOT NULL DEFAULT 0,   -- slots: on for my new slots
        updated INTEGER, by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS restream_toggles (
        target TEXT PRIMARY KEY,           -- "main" | "slot:<id>"
        enabled INTEGER NOT NULL, by TEXT, at INTEGER)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function destRow(owner) {
  await init();
  return (await getQuery("SELECT * FROM restream_dest WHERE owner = ?", [String(owner)]))[0] || null;
}
/** What anyone may see of a destination: never the key. */
function destView(d) {
  if (!d) return null;
  return { service: d.service || "twitch", server: d.server, key: mask(d.last4), auto: !!d.auto, updated: d.updated || null };
}
/** Save / replace a destination. {server, key, auto}: a blank key keeps the saved one (server / auto only). */
async function saveDest(owner, o = {}, by = "?") {
  await init();
  owner = String(owner || "");
  if (!owner) throw new Refuse(400, "no owner");
  const server = cleanServer(o.server);
  const key = cleanKey(o.key);
  const old = await destRow(owner);
  if (!key && !old) throw new Refuse(400, "Paste your Twitch stream key.");
  const auto = o.auto === undefined ? (old ? old.auto : 0) : (o.auto === true || o.auto === 1 || o.auto === "1" || o.auto === "true" || o.auto === "on" ? 1 : 0);
  const enc = key ? encrypt(key, owner) : old.key_enc;
  const last4 = key ? key.slice(-4) : old.last4;
  await runQuery(`INSERT INTO restream_dest (owner, service, server, key_enc, last4, auto, updated, by) VALUES (?, 'twitch', ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(owner) DO UPDATE SET server = excluded.server, key_enc = excluded.key_enc, last4 = excluded.last4,
                  auto = excluded.auto, updated = excluded.updated, by = excluded.by`, [owner, server, enc, last4, auto, now(), String(by).slice(0, 64)]);
  console.log(`[restream] destination ${key ? (old ? "key replaced" : "saved") : "updated"} for ${owner === MAIN_OWNER ? "Pepe's main stream" : "user " + owner} by ${by}`);
  return destView(await destRow(owner));
}
async function deleteDest(owner, by = "?") {
  await init();
  const r = await runQuery("DELETE FROM restream_dest WHERE owner = ?", [String(owner)]);
  if (r && r.changes) console.log(`[restream] destination deleted for ${owner === MAIN_OWNER ? "Pepe's main stream" : "user " + owner} by ${by}`);
  return !!(r && r.changes);
}

async function toggleOf(target) {
  await init();
  const r = (await getQuery("SELECT enabled FROM restream_toggles WHERE target = ?", [String(target)]))[0];
  return r ? !!r.enabled : null;
}
async function setToggle(target, on, by = "?") {
  await init();
  await runQuery(`INSERT INTO restream_toggles (target, enabled, by, at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(target) DO UPDATE SET enabled = excluded.enabled, by = excluded.by, at = excluded.at`,
                 [String(target), on ? 1 : 0, String(by).slice(0, 64), now()]);
  console.log(`[restream] ${target} ${on ? "ON" : "off"} by ${by}`);
  return !!on;
}

// ── Pepe's main stream: live = nginx-rtmp's on_publish / on_update for his key (mainstage.rtmpCallback) ──
let mainBeat = 0;
function noteMain(call, t = now()) {
  if (call === "publish" || call === "update_publish") mainBeat = t;
  else if (call === "publish_done") mainBeat = 0;
}
function mainLive(t = now()) {
  if (mainBeat && t - mainBeat < BEAT_STALE_MS) return true;
  try { const st = require("./bridge").stage(); return !!(st && st.source === "hls" && st.active); } catch (e) { return false; }
}

// ── what should be relayed right now ──
const slotTarget = (id) => "slot:" + id;
/** Why a slot isn't relayed (or null when it can be): the UI shows it. */
function slotBlock(s) {
  if (!s) return "no slot";
  if (s.mode === "embed") return "video-link slots aren't streams";
  if (s.via === "whip") return "WHIP streams can't be relayed yet - use OBS with RTMP or the browser";
  return null;
}
/** -> [{id, owner, source, dest(row), label}] - only streams that are live, switched on and have a key. */
async function desired(t = now()) {
  await init();
  const out = [];
  const ms = require("./mainstage");
  const main = mainStream();
  if (main && (await toggleOf(MAIN)) && mainLive(t)) {
    const d = await destRow(MAIN_OWNER);
    if (d) out.push({ id: MAIN, owner: MAIN_OWNER, source: `${srcBase()}/${main}`, dest: d, label: "Pepe's main stream" });
  }
  for (const s of await ms.openSlots()) {
    if (slotBlock(s) || !ms.isLive(s, t)) continue;
    const d = await destRow(s.userId);
    if (!d) continue;
    const tog = await toggleOf(slotTarget(s.id));
    if (!(tog === null ? !!d.auto : tog)) continue;
    out.push({ id: slotTarget(s.id), owner: s.userId, source: `${srcBase()}/${s.stream}`, dest: d, label: s.username });
  }
  return out;
}

// ── the worker's reports (memory: the worker re-sends everything every few seconds) ──
let STATUS = new Map();     // relay id -> {state, detail, kbps, fps, frames, since, restarts, at}
let workerAt = 0, workerInfo = null;
const STATES = new Set(["starting", "live", "error", "stopping"]);
function cleanStatus(id, x = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    state: STATES.has(x.state) ? x.state : "error",
    // the worker already strips URLs; this is a second guard (nothing that looks like a URL or key leaves here)
    detail: x.detail ? String(x.detail).replace(/rtmps?:\/\/\S+/gi, "<url>").replace(/live_[A-Za-z0-9_]+/g, "<key>").slice(0, 200) : null,
    kbps: num(x.kbps), fps: num(x.fps), frames: num(x.frames), since: num(x.since), restarts: num(x.restarts) || 0,
  };
}
/** The worker's sync: store its report, hand back what it should run (with the decrypted targets). */
async function workerSync(body = {}, t = now()) {
  workerAt = t;
  workerInfo = body.worker && typeof body.worker === "object" ? { version: String(body.worker.version || "").slice(0, 20), pid: Number(body.worker.pid) || null } : null;
  const rep = body.status && typeof body.status === "object" ? body.status : {};
  const next = new Map();
  for (const id of Object.keys(rep).slice(0, 100)) next.set(String(id).slice(0, 80), { ...cleanStatus(id, rep[id]), at: t });
  STATUS = next;
  const want = await desired(t);
  const relays = [];
  for (const r of want) {
    let key;
    try { key = decrypt(r.dest.key_enc, r.owner); } catch (e) {
      // a DB copied from another site (staging refresh) or a changed secret: never usable here
      STATUS.set(r.id, { ...cleanStatus(r.id, { state: "error", detail: "the saved key can't be read on this server - save it again" }), at: t });
      continue;
    }
    relays.push({ id: r.id, source: r.source, target: `${r.dest.server}/${key}` });
  }
  return { relays };
}
function workerUp(t = now()) { return !!workerAt && t - workerAt < STATUS_STALE_MS; }
/** {state, detail, kbps, ...} for one relay id as the UI shows it: live / starting / error / off / waiting. */
function statusOf(id, wanted, t = now()) {
  const s = STATUS.get(id);
  if (!wanted) return s && t - s.at < STATUS_STALE_MS && s.state !== "stopping" ? { ...s, state: "stopping" } : { state: "off" };
  if (!workerUp(t)) return { state: "error", detail: "the relay service isn't running" };
  if (!s) return { state: "starting" };
  const out = { ...s };
  if (out.state === "live" && out.kbps && out.kbps > TWITCH_MAX_KBPS * 1.05) out.warn = `${Math.round(out.kbps)} kbps is over Twitch's ~${TWITCH_MAX_KBPS} kbps`;
  return out;
}

// ── views ──
async function forMain(t = now()) {
  const d = await destRow(MAIN_OWNER);
  const on = !!(await toggleOf(MAIN));
  const live = mainLive(t);
  const wanted = !!(mainStream() && d && on && live);
  return { available: !!mainStream(), dest: destView(d), on, live, status: statusOf(MAIN, wanted, t) };
}
async function forSlot(s, d, t = now()) {
  const ms = require("./mainstage");
  const block = slotBlock(s);
  const tog = await toggleOf(slotTarget(s.id));
  const on = tog === null ? !!(d && d.auto) : tog;
  const live = ms.isLive(s, t);
  const wanted = !block && !!d && on && live;
  return { id: s.id, on, live, block, status: statusOf(slotTarget(s.id), wanted, t) };
}
/** /stage: my destination + my open slot's toggle and status */
async function me(userId, t = now()) {
  await init();
  const ms = require("./mainstage");
  const d = await destRow(userId);
  const open = (await ms.openSlots()).filter((s) => s.userId === userId && s.mode !== "embed");
  return { configured: configured(), dest: destView(d), defaultServer: DEFAULT_SERVER,
           slots: await Promise.all(open.map((s) => forSlot(s, d, t))) };
}
/** /stage/admin: Pepe's main stream + every relay that's wanted or reported */
async function adminState(t = now()) {
  await init();
  const ms = require("./mainstage");
  const rows = [];
  for (const s of await ms.openSlots()) {
    const d = await destRow(s.userId);
    if (!d && !STATUS.has(slotTarget(s.id))) continue;
    rows.push({ ...(await forSlot(s, d, t)), username: s.username, display: s.displayname || s.username, room_id: s.room_id, dest: destView(d) });
  }
  const saved = (await getQuery("SELECT COUNT(*) AS n FROM restream_dest WHERE owner != ?", [MAIN_OWNER]))[0].n;
  return { configured: configured(), main: await forMain(t), slots: rows, saved, defaultServer: DEFAULT_SERVER,
           worker: { up: workerUp(t), at: workerAt || null, ...(workerInfo || {}) } };
}

// ── routes ──
function register(app, { addUser }) {
  const rooms = require("./rooms");
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && (e.refuse || (e.status && e.status < 500 && e.message))) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[restream]", e && e.message);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const needStaff = (req, res, next) => (rooms.isStaff(req.user) ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  const needAdmin = (req, res, next) => (req.user && req.user.class === "Admin" ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  // writes: JSON from this site's own pages only (Origin/Referer + X-Requested-With, like feedweb.js)
  const csrf = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch" ? next()
    : res.status(403).json({ ok: false, error: "Bad request." }));
  const actor = (req) => (req.user && req.user.username) || "?";
  const noStore = (res) => res.set("Cache-Control", "no-store");

  // the relay worker: straight from the box (no proxy headers) and with the shared token
  app.post("/api/restream/worker/sync", async (req, res) => {
    noStore(res);
    const ra = req.socket.remoteAddress;
    const loop = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
    if (!loop || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["cf-connecting-ip"]) return res.status(403).json({ ok: false });
    const want = workerToken(), got = String(req.get("x-restream-token") || "");
    if (want.length < 16 || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await workerSync(req.body || {})) }); } catch (e) { fail(res, e); }
  });

  // ── the streamer (/stage) ──
  app.get("/api/restream/me", addUser, needUser, async (req, res) => {
    noStore(res);
    try { res.json({ ok: true, ...(await me(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/me/dest", addUser, needUser, csrf, async (req, res) => {
    noStore(res);
    try { res.json({ ok: true, dest: await saveDest(req.user.userId, req.body || {}, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/me/delete", addUser, needUser, csrf, async (req, res) => {
    noStore(res);
    try { res.json({ ok: true, deleted: await deleteDest(req.user.userId, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/slot/:id/toggle", addUser, needUser, csrf, async (req, res) => {
    noStore(res);
    try {
      const s = await require("./mainstage").getSlot(req.params.id);
      if (!s || s.userId !== req.user.userId) throw new Refuse(404, "That isn't your slot.");
      if (s.status === "ended" || s.settled) throw new Refuse(410, "This slot has ended.");
      const on = !!(req.body || {}).on;
      if (on && !(await destRow(req.user.userId))) throw new Refuse(400, "Save your Twitch stream key first.");
      await setToggle(slotTarget(s.id), on, actor(req));
      res.json({ ok: true, slot: await forSlot(s, await destRow(req.user.userId)) });
    } catch (e) { fail(res, e); }
  });

  // ── admins (/stage/admin) ──
  app.get("/api/restream/admin", addUser, needStaff, async (req, res) => {
    noStore(res);
    try { res.json({ ok: true, isAdmin: req.user.class === "Admin", ...(await adminState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/admin/main/dest", addUser, needAdmin, csrf, async (req, res) => {
    noStore(res);
    try { const b = req.body || {}; res.json({ ok: true, dest: await saveDest(MAIN_OWNER, { server: b.server, key: b.key }, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/admin/main/delete", addUser, needAdmin, csrf, async (req, res) => {
    noStore(res);
    try { await setToggle(MAIN, false, actor(req)); res.json({ ok: true, deleted: await deleteDest(MAIN_OWNER, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/restream/admin/main/toggle", addUser, needAdmin, csrf, async (req, res) => {
    noStore(res);
    try {
      const on = !!(req.body || {}).on;
      if (on && !(await destRow(MAIN_OWNER))) throw new Refuse(400, "Save Pepe's Twitch stream key first.");
      await setToggle(MAIN, on, actor(req));
      res.json({ ok: true, main: await forMain() });
    } catch (e) { fail(res, e); }
  });
  // staff can always switch a streamer's relay OFF (never on - that's the streamer's call)
  app.post("/api/restream/admin/slot/:id/off", addUser, needStaff, csrf, async (req, res) => {
    noStore(res);
    try { await setToggle(slotTarget(String(req.params.id)), false, actor(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, init, encrypt, decrypt, mask, cleanKey, cleanServer, saveDest, deleteDest, destRow, destView, toggleOf, setToggle,
  noteMain, mainLive, desired, workerSync, statusOf, me, adminState, forMain, configured, Refuse,
  MAIN, MAIN_OWNER, DEFAULT_SERVER, TWITCH_MAX_KBPS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { mainBeat = 0; STATUS = new Map(); workerAt = 0; workerInfo = null; },
};
