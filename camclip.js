// camclip.js — 🎬 cam clips from the pad page's cam snapshot popover (1.99ez).
//
// Next to the popover's snapshot, "🎬 Clip" (10 / 20 / 30 s, the stage clip lengths) asks Pepe to RECORD that person's
// cam. Same consent rules and pricing model as the cam snapshot's "Save snap" (bridge-relay.js):
//   1. Request (POST /api/rooms/:slug/camclip {login, secs}; signed in, linked Camfrog name, JSON + X-Requested-With).
//      Refused unless: the room is bridged and live with cam snapshots on (!bridge cams on); the person is on cam, not
//      Pepe, not private (bridge-hidden / !incognito = anon on the roster; an account that hides its activity -
//      stories.privateLogins); the room's !snap switch is on (bridge.snapSwitch - unknown counts as off, like stage
//      clips); nobody is already clipping that cam (ONE clip per cam at a time - Pepe enforces it too); the account's
//      rate limit (one every CLIP_GAP, CLIP_BURST per CLIP_WINDOW) and open-preview cap.
//      It becomes a bridge job (kind "camclip", offered ONCE - a re-offer after a lost ack must never start a second
//      recording) handed to Pepe in his /api/bridge/sync response.
//   2. Pepe records it on his own thread (pepe_camclip.py: opens the cam like !look, grabs the cam window's frames
//      for `secs` - the VideoViewport capture path - encodes H.264 mp4) and posts progress + the preview to
//      /api/bridge/camclip (bot token): state recording | encoding | ok | failed, the mp4, a poster jpeg, and what the
//      !clip rules say about SAVING it for the requester (save on|admins|no, viewer_ok, cost). The preview is FREE.
//      Previews live on disk in PENDING_DIR for PREVIEW_TTL, are served only to the account that asked
//      (GET /api/rooms/:slug/camclip/:id[/video|/poster]) and never listed anywhere.
//   3. Save (POST /api/rooms/:slug/camclip/:id/save) = the website action "camclip.save" [room, login, clip id] (the
//      Save snap path): Pepe re-checks every rule as the viewer's linked Camfrog name, charges the room's !clip price
//      (admins free; same routing), fetches the mp4 by id (/api/bridge/camclipdata, bot token, checked against the
//      account) and uploads it as a capture (/api/media kind "clip", subject + subject_login, by the viewer) - so it
//      lands in that pad's story (and the subject's profile story, userstories.js) with the usual provenance, and is
//      refunded if publishing fails. Discard (or the TTL) deletes the preview.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { getQuery } = require("./dbUtils");
const relay = require("./bridge-relay");

const SECS = Object.freeze([10, 20, 30]);
const SECS_DEFAULT = 20;
const PREVIEW_TTL = 10 * 60 * 1000;            // a finished preview can be saved for this long
const JOB_TTL = 8 * 60 * 1000;                 // a request Pepe never finished is dropped after this
const MAX_BYTES = 6 * 1024 * 1024;
const POSTER_MAX = 400 * 1024;
const CLIP_GAP = 60 * 1000, CLIP_BURST = 3, CLIP_WINDOW = 10 * 60 * 1000;
const SAVE_GAP = 20 * 1000, SAVE_BURST = 3, SAVE_WINDOW = 10 * 60 * 1000;
const OPEN_PER_USER = 2;
const ID_RE = /^w[a-f0-9]{16}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
let PENDING_DIR = process.env.CAMCLIP_DIR ? path.resolve(process.env.CAMCLIP_DIR) : path.join(os.tmpdir(), "patv-camclip");
let NOW = () => Date.now();

const clips = new Map();   // job id -> {id, roomId, login, userId, username, secs, state, status, ts, done, file, poster, rule, viewerOk, cost, save}

const OFF = "Snaps are off in this room (a mod can turn them on with !snap on).";
const deps = {
  snapSwitch: (roomId) => { try { return require("./bridge").snapSwitch(roomId); } catch (e) { return null; } },
  privateLogins: (list) => require("./stories").privateLogins(list),
  queueAction: (...a) => require("./actions").queue(...a),
};
function _setDeps(d) { Object.assign(deps, d || {}); }
function _setClock(fn) { NOW = fn; }
function _setDir(d) { PENDING_DIR = d; }

function fileOf(id) { return ID_RE.test(id) ? path.join(PENDING_DIR, id + ".mp4") : null; }
function drop(c) {
  if (!c) return;
  const f = fileOf(c.id);
  if (f) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  clips.delete(c.id);
}
const isOpen = (c) => c.state === "pending" || c.state === "recording" || c.state === "encoding";
function sweep(now = NOW()) {
  for (const c of [...clips.values()]) {
    if (isOpen(c) ? now - c.ts > JOB_TTL : now - (c.done || c.ts) > PREVIEW_TTL) drop(c);
  }
}
setInterval(() => sweep(), 30 * 1000).unref();

/** The open clip of a cam (room + login), if any - one at a time. */
function busyFor(roomId, login) {
  for (const c of clips.values()) if (c.roomId === roomId && c.login === login && isOpen(c)) return c;
  return null;
}
function view(c, slug) {
  // Pepe refused before recording and only acked the job (sync acks): show his reason
  const j = relay._jobs.get(c.id);
  if (isOpen(c) && j && j.state === "done" && j.result && !j.result.ok) { c.state = "failed"; c.status = j.result.msg || "Pepe couldn't clip that cam."; c.done = NOW(); }
  const live = c.state === "ready" && NOW() - c.done < PREVIEW_TTL;
  const base = "/api/rooms/" + encodeURIComponent(slug) + "/camclip/" + c.id;
  const save = live && c.rule && c.rule !== "no" && c.viewerOk ? { cost: c.cost, id: c.save || null } : null;
  return { ok: true, id: c.id, state: live || c.state !== "ready" ? c.state : "expired", status: c.status || "", secs: c.secs, login: c.login,
           video: live ? base + "/video" : null, poster: live && c.poster ? base + "/poster" : null, until: live ? c.done + PREVIEW_TTL : null, save,
           saveRule: c.rule || null };
}

/** The popover's "🎬 Clip" for `userId` on `login`'s cam in room R: {secs, def, off: why it's greyed out | null, busy}. */
async function clipInfo(R, userId, login) {
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
  let off = null;
  if (!u || !u.camfrogUsername) off = "Link your Camfrog name first: type !verify in a Camfrog room with Pepe.";
  else if (deps.snapSwitch(R.id) !== true) off = OFF;
  else if ((await deps.privateLogins([login])).has(String(login).toLowerCase())) off = "They keep their activity private, so their cam can't be clipped.";
  const b = busyFor(R.id, String(login).toLowerCase());
  return { secs: SECS, def: SECS_DEFAULT, off, busy: b ? (b.userId === userId ? b.id : true) : null };
}

function register(app, { isBotToken, addUser, bySlug, isLive }) {
  try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch (e) { /* exists */ }
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  };
  const jsonOnly = (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") { res.status(400).json({ ok: false, error: "Bad request." }); return false; }
    return true;
  };
  const mine = (req, res) => {
    const c = clips.get(String(req.params.id || ""));
    const R = bySlug(req.params.slug);
    if (!c || !R || c.roomId !== R.id || !req.user || c.userId !== req.user.userId) { res.status(404).json({ ok: false, error: "No such clip." }); return null; }
    return { c, R };
  };

  // 1. ask Pepe to record a cam
  app.post("/api/rooms/:slug/camclip", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = bySlug(req.params.slug);
      if (!R || !isLive(R)) return res.status(404).json({ ok: false, error: "That Camfrog room isn't live right now." });
      if (!R.cams) return res.status(403).json({ ok: false, error: "Cam snapshots aren't switched on in this Camfrog room." });
      if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." });
      const login = String((req.body || {}).login || "").toLowerCase().slice(0, 40);
      const secs = SECS.includes(Number((req.body || {}).secs)) ? Number(req.body.secs) : SECS_DEFAULT;
      const m = LOGIN_RE.test(login) ? (R.members || []).find((x) => !x.anon && String(x.login || "").toLowerCase() === login) : null;
      if (!m || !m.on_cam || m.self) return res.status(400).json({ ok: false, error: "They aren't on cam." });
      if ((await deps.privateLogins([login])).has(login)) return res.status(403).json({ ok: false, error: "They keep their activity private, so their cam can't be clipped." });
      if (deps.snapSwitch(R.id) !== true) return res.status(403).json({ ok: false, error: OFF });
      const busy = busyFor(R.id, login);
      if (busy) return res.status(409).json({ ok: false, error: busy.userId === u.userId ? "You're already clipping their cam." : "Pepe is already clipping their cam - try again in a bit.", id: busy.userId === u.userId ? busy.id : undefined });
      const open = [...clips.values()].filter((c) => c.userId === u.userId && (isOpen(c) || c.state === "ready")).length;
      if (open >= OPEN_PER_USER) return res.status(429).json({ ok: false, error: "Save or discard the clips you have first." });
      const lim = relay.limited("camclip|" + u.userId, CLIP_GAP, CLIP_BURST, CLIP_WINDOW);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const j = relay.newJob({ kind: "camclip", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, target: login, secs,
                               viewers: new Set([u.userId]) });
      clips.set(j.id, { id: j.id, roomId: R.id, login, userId: u.userId, username: u.username, secs, state: "pending", status: "", ts: NOW(), done: 0,
                        poster: null, rule: null, viewerOk: false, cost: 0, save: null });
      console.log(`[camclip] request room=${R.id} viewer=${u.username} camfrog=${u.camfrogUsername} target=${login} secs=${secs} job=${j.id}`);
      res.json({ ok: true, id: j.id, secs });
    } catch (e) {
      console.error("[camclip] request:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });

  // 2. Pepe: progress + the preview
  app.post("/api/bridge/camclip", express.json({ limit: "9mb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const c = clips.get(String(b.id || ""));
    if (!c) return res.status(404).json({ ok: false, error: "unknown clip" });
    const st = String(b.state || "");
    const j = relay._jobs.get(c.id);
    if (st === "recording" || st === "encoding") {
      if (isOpen(c)) { c.state = st; c.status = relay.clean(b.status, 120); }
      return res.json({ ok: true });
    }
    if (st === "ok") {
      let mp4 = null;
      try { mp4 = Buffer.from(String(b.data || ""), "base64"); } catch (e) { mp4 = null; }
      // an MP4 only: "ftyp" at byte 4, small
      if (!mp4 || mp4.length < 64 || mp4.length > MAX_BYTES || mp4.toString("latin1", 4, 8) !== "ftyp") {
        c.state = "failed"; c.status = "Pepe's clip couldn't be read."; c.done = NOW();
      } else {
        fs.mkdirSync(PENDING_DIR, { recursive: true });
        fs.writeFileSync(fileOf(c.id), mp4);
        let poster = null;
        try { poster = b.poster ? Buffer.from(String(b.poster), "base64") : null; } catch (e) { poster = null; }
        c.poster = poster && poster.length < POSTER_MAX && poster[0] === 0xff && poster[1] === 0xd8 ? poster : null;
        c.secs = Math.max(1, Math.min(31, Number(b.secs) || c.secs));
        c.rule = ["on", "admins", "no"].includes(b.save) ? b.save : null;
        c.viewerOk = !!b.viewer_ok;
        c.cost = Math.max(0, parseInt(b.cost, 10) || 0);
        c.state = "ready"; c.status = "ok"; c.done = NOW();
      }
    } else {
      c.state = "failed"; c.status = relay.clean(b.status, 160) || "Pepe couldn't clip that cam."; c.done = NOW();
    }
    if (j) { j.state = "done"; j.doneAt = NOW(); j.result = { ok: c.state === "ready", msg: c.status }; }
    res.json({ ok: true });
  });

  // 3. the requester's view of it
  app.get("/api/rooms/:slug/camclip/:id", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    const x = mine(req, res);
    if (x) res.json(view(x.c, req.params.slug));
  });
  app.get("/api/rooms/:slug/camclip/:id/video", addUser, (req, res) => {
    const x = mine(req, res);
    if (!x) return;
    const f = fileOf(x.c.id);
    if (x.c.state !== "ready" || NOW() - x.c.done >= PREVIEW_TTL || !f || !fs.existsSync(f)) return res.status(410).json({ ok: false, error: "That clip expired." });
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cross-Origin-Resource-Policy": "same-origin" });
    res.type("video/mp4");
    res.sendFile(f, { acceptRanges: true });
  });
  app.get("/api/rooms/:slug/camclip/:id/poster", addUser, (req, res) => {
    const x = mine(req, res);
    if (!x) return;
    if (!x.c.poster) return res.status(404).end();
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.type("image/jpeg").send(x.c.poster);
  });
  app.post("/api/rooms/:slug/camclip/:id/discard", addUser, express.json({ limit: "4kb" }), (req, res) => {
    if (!jsonOnly(req, res)) return;
    const x = mine(req, res);
    if (!x) return;
    if (isOpen(x.c)) return res.status(409).json({ ok: false, error: "It's still recording." });
    if (x.c.save) return res.status(409).json({ ok: false, error: "It's being saved." });
    drop(x.c);
    res.json({ ok: true });
  });

  // 4. Save = the website action "camclip.save" (Pepe charges !clip as the viewer, then publishes it)
  app.post("/api/rooms/:slug/camclip/:id/save", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      const x = mine(req, res);
      if (!x) return;
      const { c, R } = x;
      const u = await me(req);
      if (!u || !u.camfrogUsername) return res.status(403).json({ ok: false, error: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." });
      if (c.state !== "ready" || NOW() - c.done >= PREVIEW_TTL) return res.status(410).json({ ok: false, error: "That clip expired - record a fresh one." });
      if (!c.rule || c.rule === "no" || !c.viewerOk) return res.status(403).json({ ok: false, error: "Clips of them can't be saved here." });
      if (deps.snapSwitch(R.id) !== true) return res.status(403).json({ ok: false, error: OFF });
      if (c.save) {
        const a = (await getQuery("SELECT status FROM pepe_actions WHERE id = ? AND user_id = ?", [c.save, u.userId]))[0];
        if (a && a.status !== "failed") return res.json({ ok: true, id: c.save, again: true });       // one save per clip
      }
      const lim = relay.limited("saveclip|" + u.userId, SAVE_GAP, SAVE_BURST, SAVE_WINDOW);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const id = await deps.queueAction(u.userId, { kind: "camclip.save", args: [R.id, c.login, c.id], tag: "clip", label: "!clip " + c.login });
      c.save = id;
      c.done = Math.max(c.done, NOW() - PREVIEW_TTL + 5 * 60 * 1000);   // Pepe has at least 5 more minutes to fetch it
      console.log(`[camclip] save room=${R.id} viewer=${u.username} camfrog=${u.camfrogUsername} target=${c.login} clip=${c.id} action=${id}`);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent." });
    }
  });
  app.get("/api/rooms/:slug/camclip/:id/save", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const c = clips.get(String(req.params.id || ""));
    const aid = c && c.userId === req.user.userId ? c.save : parseInt(req.query.action, 10) || 0;
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ? AND kind = 'camclip.save'", [aid || 0, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such save." });
    const msg = a.message || "";
    const m = msg.match(/\/media\/([a-f0-9]{8,32})\b/i);
    res.json({ ok: true, status: a.status, message: msg, url: a.status === "done" && m ? "/media/" + m[1] : null });
  });

  // 5. Pepe fetches a clip being saved (bot token), checked against the account the save was queued for
  app.post("/api/bridge/camclipdata", express.json({ limit: "4kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const c = clips.get(String(b.id || ""));
    const f = c ? fileOf(c.id) : null;
    if (!c || c.state !== "ready" || !c.save || String(b.user || "") !== c.username || !f || !fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.json({ ok: true, room: c.roomId, target: c.login, secs: c.secs, data: fs.readFileSync(f).toString("base64") });
  });
}

module.exports = { register, sweep, busyFor, clipInfo, SECS, SECS_DEFAULT, PREVIEW_TTL, _clips: clips, _setDeps, _setClock, _setDir, fileOf };
