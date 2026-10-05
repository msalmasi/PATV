// bridge-relay.js — the two-way part of the room bridge (STAGING TEST, bot 1.99).
//
// Signed-in website users can, where a room admin has switched it on in Camfrog:
//   * say   a chat line, relayed by Pepe as "🌐 <camfrog name> (web): …" in a different font
//           (needs a linked Camfrog name; !bridge relay on)
//   * clip  a short push-to-talk recording that Pepe plays on the mic (linked name; !bridge mic on)
//   * snap  a still of an on-cam user's cam, opened by Pepe (any signed-in user; !bridge cams on)
//
// Jobs live in memory only and reach Pepe in the response to his own /api/bridge/sync POST (no
// extra polling); he acks in the next sync. Clip audio is handed over once (/api/bridge/clip) and
// dropped; cam frames are kept in memory for SNAP_TTL and never written anywhere. Each request is
// logged (account, kind, target — never the text, audio or image) for abuse tracing; Pepe also logs
// every relay to his mod log. Pepe re-checks every rule (moderation state, rate limits, switches).
const express = require("express");
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");

const SAY_MAX = 300, CLIP_MAX_BYTES = 600 * 1024, CLIP_MAX_SECS = 30;
const JOB_TTL = 3 * 60 * 1000, CLAIM_RETRY = 45 * 1000;
const SNAP_TTL = 2 * 60 * 1000, SNAP_TARGET_GAP = 20 * 1000, SNAP_VIEWER_GAP = 10 * 1000;

const jobs = new Map();          // id -> {id, kind, roomId, userId, username, camfrog, text, data, mime, secs, target, state, at, claimed, tries, result}
const snaps = new Map();         // `${roomId}|${login}` -> {ts, ok, status, img: Buffer}
const hits = new Map();          // `${kind}|${userId}` -> [timestamps]

function limited(key, gap, burst, windowMs) {
  const now = Date.now();
  const q = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (q.length && now - q[q.length - 1] < gap) return `slow down — one every ${Math.round(gap / 1000)}s`;
  if (q.length >= burst) return `slow down — ${burst} per ${Math.round(windowMs / 60000)} min`;
  q.push(now);
  hits.set(key, q);
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.at > JOB_TTL) jobs.delete(id);
  for (const [k, s] of snaps) if (now - s.ts > SNAP_TTL) snaps.delete(k);
  for (const [k, q] of hits) if (!q.length || now - q[q.length - 1] > 15 * 60 * 1000) hits.delete(k);
}, 15 * 1000).unref();

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
  .replace(/<[^<>]{0,60}>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

function newJob(fields) {
  const j = Object.assign({ id: "w" + crypto.randomBytes(8).toString("hex"), state: "pending", at: Date.now(), claimed: 0, tries: 0, result: null }, fields);
  jobs.set(j.id, j);
  return j;
}

/** The jobs to hand Pepe with this sync response (pending, or claimed but never acked). */
function takeJobs(liveRoomIds) {
  const now = Date.now(), out = [];
  for (const j of jobs.values()) {
    if (!liveRoomIds.has(j.roomId)) continue;
    const due = j.state === "pending" || (j.state === "claimed" && now - j.claimed > CLAIM_RETRY && j.tries < 2);
    if (!due) continue;
    j.state = "claimed"; j.claimed = now; j.tries++;
    const base = { id: j.id, kind: j.kind, room: j.roomId, user: j.username, camfrog: j.camfrog || "" };
    if (j.kind === "say") base.text = j.text;
    if (j.kind === "clip") { base.mime = j.mime; base.secs = j.secs; base.size = j.data ? j.data.length : 0; }
    if (j.kind === "snap") { base.target = j.target; base.viewer = j.username; }
    out.push(base);
    if (out.length >= 10) break;
  }
  return out;
}

function applyAcks(acks) {
  for (const a of Array.isArray(acks) ? acks.slice(0, 100) : []) {
    const j = a && jobs.get(String(a.id || ""));
    if (!j) continue;
    j.state = "done";
    j.result = { ok: !!a.ok, msg: clean(a.msg, 200) };
    j.data = null;
  }
}

/** This user's recent relay jobs in a room (for the composer's status line). */
function mineFor(userId, roomId) {
  const out = [];
  for (const j of jobs.values()) {
    if (j.userId !== userId || j.roomId !== roomId || j.kind === "snap") continue;
    out.push({ id: j.id, kind: j.kind, state: j.state, ok: j.result ? j.result.ok : null, msg: j.result ? j.result.msg : "", at: j.at });
  }
  return out.slice(-5);
}

function register(app, { isBotToken, addUser, bySlug, isLive }) {
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  };
  const roomFor = (req, res, flag) => {
    const R = bySlug(req.params.slug);
    if (!R || !isLive(R)) { res.status(404).json({ ok: false, error: "That room isn't live right now." }); return null; }
    if (!R[flag]) { res.status(403).json({ ok: false, error: "That isn't switched on in this room." }); return null; }
    return R;
  };

  app.post("/api/rooms/:slug/say", addUser, express.json({ limit: "8kb" }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "relay");
    if (!R) return;
    if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a room with Pepe." });
    const text = clean((req.body || {}).text, SAY_MAX);
    if (!text) return res.status(400).json({ ok: false, error: "Type something first." });
    const lim = limited("say|" + u.userId, 3000, 5, 60000);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "say", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, text });
    console.log(`[bridge-relay] say room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} job=${j.id}`);
    res.json({ ok: true, id: j.id });
  });

  app.post("/api/rooms/:slug/clip", addUser, express.raw({ type: ["audio/*", "application/octet-stream"], limit: CLIP_MAX_BYTES }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "micRelay");
    if (!R) return;
    if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a room with Pepe." });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const secs = Number(req.get("x-clip-secs")) || 0;
    if (!buf || buf.length < 500) return res.status(400).json({ ok: false, error: "That recording is empty." });
    if (secs > CLIP_MAX_SECS + 1) return res.status(400).json({ ok: false, error: `Keep it under ${CLIP_MAX_SECS} seconds.` });
    const mime = String(req.get("content-type") || "audio/webm").split(";")[0].slice(0, 40);
    const lim = limited("clip|" + u.userId, 30000, 3, 600000);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "clip", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, data: buf, mime, secs });
    console.log(`[bridge-relay] clip room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} bytes=${buf.length} job=${j.id}`);
    res.json({ ok: true, id: j.id });
  });

  // Pepe fetches a clip's audio once; it's dropped from memory right after.
  app.post("/api/bridge/clip", express.json({ limit: "8kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const j = jobs.get(String(b.id || ""));
    if (!j || j.kind !== "clip" || !j.data) return res.status(404).json({ ok: false });
    const data = j.data.toString("base64");
    j.data = null;
    res.json({ ok: true, mime: j.mime, data });
  });

  app.post("/api/rooms/:slug/snap", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    const u = await me(req);
    if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
    const R = roomFor(req, res, "cams");
    if (!R) return;
    const login = String((req.body || {}).login || "").toLowerCase().slice(0, 40);
    const m = R.members.find((x) => !x.anon && String(x.login).toLowerCase() === login);
    if (!m || !m.on_cam || m.self) return res.status(400).json({ ok: false, error: "They aren't on cam." });
    const key = R.id + "|" + login;
    const cached = snaps.get(key);
    if (cached && Date.now() - cached.ts < SNAP_TARGET_GAP) return res.json({ ok: true, cached: true });
    for (const j of jobs.values()) if (j.kind === "snap" && j.roomId === R.id && j.target === login && j.state !== "done") return res.json({ ok: true, pending: true });
    const lim = limited("snap|" + u.userId, SNAP_VIEWER_GAP, 6, 60000);
    if (lim) return res.status(429).json({ ok: false, error: lim });
    const j = newJob({ kind: "snap", roomId: R.id, userId: u.userId, username: u.username, target: login });
    console.log(`[bridge-relay] snap room=${R.id} viewer=${u.username} target=${login} job=${j.id}`);
    res.json({ ok: true, id: j.id });
  });

  // Pepe posts the frame (or why there isn't one).
  app.post("/api/bridge/snap", express.json({ limit: "1mb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const j = jobs.get(String(b.id || ""));
    const roomId = String(b.room || (j && j.roomId) || ""), login = String(b.target || (j && j.target) || "").toLowerCase().slice(0, 40);
    if (!roomId || !login) return res.status(400).json({ ok: false });
    let img = null;
    if (b.ok && typeof b.data === "string") {
      img = Buffer.from(b.data, "base64");
      if (img.length > 400 * 1024 || img[0] !== 0xff || img[1] !== 0xd8) img = null;      // JPEG only, small
    }
    snaps.set(roomId + "|" + login, { ts: Date.now(), ok: !!img, status: clean(b.status, 120), img });
    if (j) { j.state = "done"; j.result = { ok: !!img, msg: clean(b.status, 120) }; }
    res.json({ ok: true });
  });

  app.get("/api/rooms/:slug/snap/:login", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const R = bySlug(req.params.slug);
    if (!R || !R.cams) return res.status(404).json({ state: "off" });
    const login = String(req.params.login || "").toLowerCase().slice(0, 40);
    const s = snaps.get(R.id + "|" + login);
    const pending = [...jobs.values()].some((j) => j.kind === "snap" && j.roomId === R.id && j.target === login && j.state !== "done");
    if (s && (!pending || Date.now() - s.ts < SNAP_TARGET_GAP)) {
      return res.json({ state: s.ok ? "ok" : "refused", ts: s.ts, status: s.status, img: s.img ? "data:image/jpeg;base64," + s.img.toString("base64") : null });
    }
    res.json({ state: pending ? "pending" : "none" });
  });
}

module.exports = { register, takeJobs, applyAcks, mineFor, _jobs: jobs, _snaps: snaps };
