// micclip.js — 🔊 mic clips (1.99fp): the AUDIO of a recent mic-up, clipped from the pad's Live tab or with Pepe's
// !clipmic, posted on the pad feed as an audio post (waveform card, the transcript as its caption).
//
// Pepe keeps the last mic-ups of each room he listens to (pepe_micclip.MicRing: 30 per room, 15 min, 60 MB, AAC; never
// anyone !incognito / !bridge hide) and links each to the 🎙 line the bridge shows for it (its "tx-..." id).
//   1. Preview (free): a 🎙 line's "🔊 Clip" -> POST /api/rooms/:slug/micclip {tx} (signed in, linked Camfrog name, JSON +
//      X-Requested-With). Refused unless the line is in the room's bridge feed, its speaker isn't anonymous / private
//      (stories.privateLogins), the room's !clip switch is on (bridge.clipSwitch; unknown = off) - except for admins
//      (camclip.clipAdmin, 1.99fb) -, the account's rate limit and open-preview cap. It becomes a bridge job (kind
//      "micclip", offered ONCE) for Pepe, who re-checks everything and posts the stored mic-up to /api/bridge/micclip
//      (bot token): state ok + the .m4a + its transcript + the !clip save rule / price for the requester, or failed.
//      Previews live on disk in PENDING_DIR for PREVIEW_TTL, are served only to the account that asked
//      (GET /api/rooms/:slug/micclip/:id[/audio]) and never listed anywhere. The page plays it with start / end trims.
//   2. Post (POST .../micclip/:id/save {start, end} in ms) = the website action "micclip.save" [room, speaker login,
//      clip id, start, end]: Pepe re-checks the rules as the linked Camfrog name, fetches the preview back by id
//      (/api/bridge/micclipdata, bot token, checked against the account), trims it, charges the room's !clip price
//      (admins free) and publishes it - refunded if that fails.
//   Publishing (both paths): Pepe's _snap_store(kind "audio") = a story capture (the pad's story + the speaker's
//      profile story; media.js makes its waveform card), then POST /api/bridge/micclip/post {media, by, user,
//      speakers, caption} (bot token): the capture becomes a permanent pad post (storykeep.postToPad - credited to the
//      clipper, the waveform card as the audio's poster, the transcript as title + body) and feed_voices records who is
//      heard in it. Every speaker gets "Remove me" (one click: the post comes down, the clipper is told) - one speaker
//      also through the capture's own subject rule, several (a merged !clipmic 3) only through this.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { getQuery, runQuery } = require("./dbUtils");
const relay = require("./bridge-relay");

const PREVIEW_TTL = 10 * 60 * 1000;
const JOB_TTL = 3 * 60 * 1000;
const MAX_BYTES = 6 * 1024 * 1024;
const REQ_GAP = 15 * 1000, REQ_BURST = 6, REQ_WINDOW = 10 * 60 * 1000;
const SAVE_GAP = 20 * 1000, SAVE_BURST = 3, SAVE_WINDOW = 10 * 60 * 1000;
const OPEN_PER_USER = 2;
const ID_RE = /^w[a-f0-9]{16}$/;
const TX_RE = /^tx-[0-9a-f]{8,32}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const POST_RE = /^[A-Za-z0-9]{8,16}$/;
const CLIP_OFF = "Clips are switched off in this room (!clip).";
const CODE_RE = /^E_[A-Z_]{2,30}$/;
let PENDING_DIR = process.env.MICCLIP_DIR ? path.resolve(process.env.MICCLIP_DIR) : path.join(os.tmpdir(), "patv-micclip");
let NOW = () => Date.now();

const clips = new Map();   // job id -> {id, roomId, tx, login, userId, username, state, status, ts, done, secs, text, viewerOk, cost, save, code}

const deps = {
  clipSwitch: (roomId) => { try { return require("./bridge").clipSwitch(roomId); } catch (e) { return null; } },
  clipAdmin: (R, u) => { try { return require("./camclip").clipAdmin(R, u); } catch (e) { return false; } },
  privateLogins: (list) => require("./stories").privateLogins(list),
  queueAction: (...a) => require("./actions").queue(...a),
  postToPad: (...a) => require("./storykeep").postToPad(...a),
  makePoster: (row) => require("./media").makePoster(row),
};
function _setDeps(d) { Object.assign(deps, d || {}); }
function _setClock(fn) { NOW = fn; }
function _setDir(d) { PENDING_DIR = d; }

const fileOf = (id) => (ID_RE.test(id) ? path.join(PENDING_DIR, id + ".m4a") : null);
function drop(c) {
  if (!c) return;
  const f = fileOf(c.id);
  if (f) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  clips.delete(c.id);
}
const isOpen = (c) => c.state === "pending";
function sweep(now = NOW()) {
  for (const c of [...clips.values()]) if (isOpen(c) ? now - c.ts > JOB_TTL : now - (c.done || c.ts) > PREVIEW_TTL) drop(c);
}
setInterval(() => sweep(), 30 * 1000).unref();

function view(c, slug) {
  const j = relay._jobs.get(c.id);
  if (isOpen(c) && j && j.state === "done" && j.result && !j.result.ok) { c.state = "failed"; c.status = j.result.msg || "Pepe couldn't clip that."; c.done = NOW(); }
  const live = c.state === "ready" && NOW() - c.done < PREVIEW_TTL;
  const base = "/api/rooms/" + encodeURIComponent(slug) + "/micclip/" + c.id;
  return { ok: true, id: c.id, state: live || c.state !== "ready" ? c.state : "expired", status: c.status || "", secs: c.secs || 0, text: live ? c.text || "" : "",
           login: c.login, audio: live ? base + "/audio" : null, until: live ? c.done + PREVIEW_TTL : null,
           save: live && c.viewerOk ? { cost: c.cost, id: c.save || null } : null, ...(c.code ? { code: c.code } : {}) };
}

/** Is the room's !clip on for this account? -> null when OK, else the refusal. */
function clipGate(R, u) {
  return deps.clipSwitch(R.id) === true || deps.clipAdmin(R, u) ? null : CLIP_OFF;
}

// ── who is heard in a posted clip (feed_voices) + their "Remove me" ──
async function linkedLogin(viewer) {
  if (!viewer || !viewer.userId) return null;
  if (viewer.camfrogUsername !== undefined) return viewer.camfrogUsername ? String(viewer.camfrogUsername).toLowerCase() : null;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [viewer.userId]))[0];
  return r && r.camfrogUsername ? String(r.camfrogUsername).toLowerCase() : null;
}
/** decorate(): post id -> {speakers: n, canRemoveMe, removed} for mic clip posts. */
async function voicesFor(ids, viewer) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await getQuery(`SELECT * FROM feed_voices WHERE post_id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) return out;
  const me = await linkedLogin(viewer);
  for (const r of rows) {
    const logins = String(r.logins || "").trim().split(/\s+/).filter(Boolean);
    out.set(r.post_id, { speakers: logins.length, canRemoveMe: !!me && !r.removed_at && logins.includes(me), removed: !!r.removed_at });
  }
  return out;
}
async function removeMe(user, postId) {
  if (!user || !user.userId) throw Object.assign(new Error("Sign in first."), { status: 401, refuse: true });
  if (!POST_RE.test(String(postId || ""))) throw Object.assign(new Error("No such post."), { status: 404, refuse: true });
  await require("./feedstore").init();
  const r = (await getQuery("SELECT * FROM feed_voices WHERE post_id = ?", [String(postId)]))[0];
  const me = await linkedLogin(user);
  if (!r || !me || !String(r.logins || "").split(/\s+/).includes(me)) throw Object.assign(new Error("Only someone heard in this clip can remove it."), { status: 403, refuse: true });
  if (r.removed_at) return { removed: true, again: true };
  const t = NOW();
  await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'subject', delete_reason = 'removed by someone heard in it' WHERE id = ? AND deleted_at IS NULL", [t, r.post_id]);
  await runQuery("UPDATE feed_voices SET removed_at = ?, removed_by = ? WHERE post_id = ?", [t, user.userId, r.post_id]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [r.post_id]).catch(() => {});
  try {
    const p = (await getQuery("SELECT author_id FROM feed_posts WHERE id = ?", [r.post_id]))[0];
    if (p && p.author_id !== user.userId) {
      await require("./feedstore").notify(p.author_id, { kind: "feed", title: "A mic clip you posted was removed",
        body: "Someone heard in it removed the post.", link: "/feed", ref: "voice-rm:" + r.post_id });
    }
  } catch (e) { /* courtesy */ }
  console.log(`[micclip] post ${r.post_id} removed by a speaker`);
  return { removed: true, again: false };
}

function register(app, { isBotToken, addUser, bySlug, isLive }) {
  try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch (e) { /* exists */ }
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
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
  const LINK = "Link your Camfrog name first: type !verify in a Camfrog room with Pepe.";

  // 1. a preview of one 🎙 line's mic-up
  app.post("/api/rooms/:slug/micclip", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = bySlug(req.params.slug);
      if (!R || !isLive(R)) return res.status(404).json({ ok: false, error: "That Camfrog room isn't live right now." });
      if (!u.camfrogUsername) return res.status(403).json({ ok: false, error: LINK });
      const tx = String((req.body || {}).tx || "");
      const it = TX_RE.test(tx) ? (R.feed || []).find((x) => x && x.k === "tx" && x.id === tx) : null;
      if (!it) return res.status(404).json({ ok: false, error: "That mic line isn't in the room's feed any more." });
      if (!it.u || it.u.anon || !LOGIN_RE.test(String(it.u.login || ""))) return res.status(403).json({ ok: false, error: "They're private." });
      const login = String(it.u.login).toLowerCase();
      if (it.u.self) return res.status(400).json({ ok: false, error: "That's Pepe." });
      if ((await deps.privateLogins([login])).has(login)) return res.status(403).json({ ok: false, error: "They keep their activity private, so their voice can't be clipped." });
      const off = clipGate(R, u);
      if (off) return res.status(403).json({ ok: false, error: off, code: "E_FEATURE_OFF" });
      for (const c of clips.values()) {
        if (c.userId === u.userId && c.tx === tx && (isOpen(c) || (c.state === "ready" && NOW() - c.done < PREVIEW_TTL))) return res.json({ ok: true, id: c.id, again: true });
      }
      const open = [...clips.values()].filter((c) => c.userId === u.userId && (isOpen(c) || c.state === "ready")).length;
      if (open >= OPEN_PER_USER) return res.status(429).json({ ok: false, error: "Post or discard the clips you have first." });
      const lim = relay.limited("micclip|" + u.userId, REQ_GAP, REQ_BURST, REQ_WINDOW);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const j = relay.newJob({ kind: "micclip", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, target: login, tx,
                               viewers: new Set([u.userId]) });
      clips.set(j.id, { id: j.id, roomId: R.id, tx, login, userId: u.userId, username: u.username, state: "pending", status: "", ts: NOW(), done: 0,
                        secs: 0, text: "", viewerOk: false, cost: 0, save: null });
      console.log(`[micclip] request room=${R.id} viewer=${u.username} camfrog=${u.camfrogUsername} speaker=${login} job=${j.id}`);
      res.json({ ok: true, id: j.id });
    } catch (e) {
      console.error("[micclip] request:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });

  // 2. Pepe: the preview (or why not)
  app.post("/api/bridge/micclip", express.json({ limit: "9mb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const c = clips.get(String(b.id || ""));
    if (!c) return res.status(404).json({ ok: false, error: "unknown clip" });
    const j = relay._jobs.get(c.id);
    if (String(b.state || "") === "ok") {
      let m4a = null;
      try { m4a = Buffer.from(String(b.data || ""), "base64"); } catch (e) { m4a = null; }
      if (!m4a || m4a.length < 64 || m4a.length > MAX_BYTES || m4a.toString("latin1", 4, 8) !== "ftyp" || String(b.target || "").toLowerCase() !== c.login) {
        c.state = "failed"; c.status = "Pepe's clip couldn't be read."; c.done = NOW();
      } else {
        fs.mkdirSync(PENDING_DIR, { recursive: true });
        fs.writeFileSync(fileOf(c.id), m4a);
        c.secs = Math.max(1, Math.min(600, Number(b.secs) || 1));
        c.text = relay.clean(b.text, 2000);
        c.viewerOk = !!b.viewer_ok && b.save !== "no";
        c.cost = Math.max(0, parseInt(b.cost, 10) || 0);
        c.state = "ready"; c.status = "ok"; c.done = NOW();
      }
    } else {
      c.state = "failed"; c.status = relay.clean(b.status, 160) || "Pepe couldn't clip that."; c.done = NOW();
      if (CODE_RE.test(String(b.code || ""))) c.code = String(b.code);
    }
    if (j) { j.state = "done"; j.doneAt = NOW(); j.result = { ok: c.state === "ready", msg: c.status }; }
    res.json({ ok: true });
  });

  // 3. the requester's view + the audio
  app.get("/api/rooms/:slug/micclip/:id", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    const x = mine(req, res);
    if (x) res.json(view(x.c, req.params.slug));
  });
  app.get("/api/rooms/:slug/micclip/:id/audio", addUser, (req, res) => {
    const x = mine(req, res);
    if (!x) return;
    const f = fileOf(x.c.id);
    if (x.c.state !== "ready" || NOW() - x.c.done >= PREVIEW_TTL || !f || !fs.existsSync(f)) return res.status(410).json({ ok: false, error: "That clip expired." });
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cross-Origin-Resource-Policy": "same-origin" });
    res.type("audio/mp4");
    res.sendFile(f, { acceptRanges: true });
  });
  app.post("/api/rooms/:slug/micclip/:id/discard", addUser, express.json({ limit: "4kb" }), (req, res) => {
    if (!jsonOnly(req, res)) return;
    const x = mine(req, res);
    if (!x) return;
    if (x.c.save) return res.status(409).json({ ok: false, error: "It's being posted." });
    drop(x.c);
    res.json({ ok: true });
  });

  // 4. Post = the website action "micclip.save" (Pepe charges !clip as the viewer, then publishes it)
  app.post("/api/rooms/:slug/micclip/:id/save", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      const x = mine(req, res);
      if (!x) return;
      const { c, R } = x;
      const u = await me(req);
      if (!u || !u.camfrogUsername) return res.status(403).json({ ok: false, error: LINK });
      if (c.state !== "ready" || NOW() - c.done >= PREVIEW_TTL) return res.status(410).json({ ok: false, error: "That clip expired — clip it again." });
      if (!c.viewerOk) return res.status(403).json({ ok: false, error: "You can't post clips here." });
      const off = clipGate(R, u);
      if (off) return res.status(403).json({ ok: false, error: off, code: "E_FEATURE_OFF" });
      if (c.save) {
        const a = (await getQuery("SELECT status FROM pepe_actions WHERE id = ? AND user_id = ?", [c.save, u.userId]))[0];
        if (a && a.status !== "failed") return res.json({ ok: true, id: c.save, again: true });
      }
      const b = req.body || {};
      const total = Math.round(c.secs * 1000);
      let start = Math.max(0, Math.min(total, Math.round(Number(b.start) || 0)));
      let end = Math.round(Number(b.end) || total);
      end = Math.max(0, Math.min(total, end || total));
      if (end - start < 1000) return res.status(400).json({ ok: false, error: "Keep at least 1 second." });
      const lim = relay.limited("savemic|" + u.userId, SAVE_GAP, SAVE_BURST, SAVE_WINDOW);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const id = await deps.queueAction(u.userId, { kind: "micclip.save", args: [R.id, c.login, c.id, start, end], tag: "clip", label: "🔊 clip " + c.login });
      c.save = id;
      c.done = Math.max(c.done, NOW() - PREVIEW_TTL + 5 * 60 * 1000);   // Pepe has at least 5 more minutes to fetch it
      console.log(`[micclip] save room=${R.id} viewer=${u.username} speaker=${c.login} clip=${c.id} ${start}-${end}ms action=${id}`);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent." });
    }
  });
  app.get("/api/rooms/:slug/micclip/:id/save", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const c = clips.get(String(req.params.id || ""));
    const aid = c && c.userId === req.user.userId ? c.save : parseInt(req.query.action, 10) || 0;
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ? AND kind = 'micclip.save'", [aid || 0, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such post." });
    const msg = a.message || "";
    const m = msg.match(/(\/(?:p|u)\/[^\s]+\/posts\/[A-Za-z0-9]{8,16}[^\s]*)/);
    res.json({ ok: true, status: a.status, message: msg, url: a.status === "done" && m ? m[1] : null });
  });

  // 5. Pepe fetches the preview being posted (bot token), checked against the account the save was queued for
  app.post("/api/bridge/micclipdata", express.json({ limit: "4kb" }), (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const c = clips.get(String(b.id || ""));
    const f = c ? fileOf(c.id) : null;
    if (!c || c.state !== "ready" || !c.save || String(b.user || "") !== c.username || !f || !fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.json({ ok: true, room: c.roomId, target: c.login, secs: c.secs, text: c.text, data: fs.readFileSync(f).toString("base64") });
  });

  // 6. Pepe: a published audio capture -> a permanent pad post (both paths)
  app.post("/api/bridge/micclip/post", express.json({ limit: "16kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      await require("./feedstore").init();
      const mid = String(b.media || "");
      const row = /^[a-f0-9]{8,32}$/i.test(mid) ? (await getQuery("SELECT * FROM media WHERE id = ? AND deleted = 0", [mid]))[0] : null;
      if (!row || row.kind !== "audio") return res.status(404).json({ ok: false, error: "no such audio capture" });
      const by = String(b.by || "").toLowerCase();
      // the clipper's account: the PATV account that asked (website), else the one linked to their Camfrog login
      let acct = null;
      if (b.user) acct = (await getQuery("SELECT userId, camfrogUsername FROM users WHERE username = ?", [String(b.user).slice(0, 60)]))[0] || null;
      if (acct && String(acct.camfrogUsername || "").toLowerCase() !== by) acct = null;
      if (!acct && LOGIN_RE.test(by)) {
        acct = (await getQuery(`SELECT userId, camfrogUsername FROM users WHERE lower(camfrogUsername) = ? ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [by]))[0] || null;
      }
      if (!acct) return res.status(409).json({ ok: false, error: "no PATV account for the clipper" });
      try { await deps.makePoster(row); } catch (e) { /* the post just has no waveform card */ }
      const speakers = (Array.isArray(b.speakers) ? b.speakers : []).map((s) => String(s || "").toLowerCase()).filter((s) => LOGIN_RE.test(s)).slice(0, 5);
      const cap = String(b.caption || "").replace(/\s+/g, " ").trim();
      const who = String(row.subject || "").slice(0, 60);
      const title = cap ? `🎙 ${who ? who + ": " : ""}“${cap.length > 100 ? cap.slice(0, 99) + "…" : cap}”` : `🎙 ${who || "Mic clip"}`;
      const r = await deps.postToPad({ userId: acct.userId }, row.id, { caption: title.slice(0, 140), body: cap.length > 100 ? cap : "" });
      const t = NOW();
      await runQuery(`INSERT INTO feed_voices (post_id, room_id, media_id, logins, by_login, created) VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT(post_id) DO UPDATE SET logins = excluded.logins`,
                     [r.post.id, row.room || "", row.id, " " + speakers.join(" ") + " ", by, t]);
      console.log(`[micclip] capture ${row.id} -> post ${r.post.id} (${speakers.length} speaker(s))`);
      res.json({ ok: true, url: r.post.url, id: r.post.id, again: !!r.again });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[micclip] post:", e);
      res.status(500).json({ ok: false, error: "the website hit an error" });
    }
  });

  app.post("/api/feed/posts/:id/voice-remove-me", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try { res.json({ ok: true, ...(await removeMe(req.user, req.params.id)) }); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.refuse ? e.message : "Something went wrong." }); }
  });
}

module.exports = { register, sweep, voicesFor, removeMe, clipGate, PREVIEW_TTL, _clips: clips, _setDeps, _setClock, _setDir, fileOf };
