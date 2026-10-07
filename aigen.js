// aigen.js — AI-generated pictures and videos for feed posts (1.99di). The composer's "✨ Generate" runs Pepe's
// own !imagine / !video generator as the signed-in user (camfrog-bot pepe_aigen.py), and the result comes back
// here as a normal feed attachment, flagged ai_generated, with its prompt.
//
// Flow
//   1. POST /api/feed/aigen {kind: image|video, prompt, pad, price, back}: the account must be allowed to post
//      media (feedstore.postRefusal media - a linked Camfrog name or level media_min_level, bans, Pepe's
//      restrictions) and to post in the picked pad; at most MAX_OPEN open jobs per account (MAX_OPEN_VIDEO
//      videos). A job row (feed_aigen_jobs) + a website action kind "aigen" args [job id] (actions.js) - Pepe
//      runs it as the linked Camfrog name, or (unlinked, level >= 2) charges the PATV account, like the stage
//      capture save. `price` is what the composer showed: Pepe refuses (charging nothing) if his is higher.
//   2. Pepe: /api/feed/aigen/start (queued -> running; a discarded / expired job is refused, nothing charged),
//      /progress (charged + generating, seconds so far), /chunk (the file, base64, in order), /result.
//   3. /result ok: the assembled file goes through feedmedia exactly like a user upload (magic bytes, re-encode,
//      metadata dropped) after the user's quota + the global quota + the disk floor; the attachment gets
//      ai_generated = 1, ai_prompt, ai_model, ai_nsfw (Pepe's result check said NSFW: a post using it is NSFW).
//      Anything that fails here answers ok:false and Pepe refunds.
//   4. The composer polls GET /api/feed/aigen/:id (preview, progress); anyone who left the page gets an inbox
//      notice when it's done (or failed). A finished job's preview: Attach (an ordinary attachment from then on),
//      Regenerate (a new job, charged again) or Discard (the file goes; the price isn't refunded - it was made).
//   5. Timeouts (sweep): queued > QUEUE_TTL -> "timeout", nothing charged; running > RUN_TTL -> "timeout" (a late
//      result is refused and Pepe refunds; a Pepe restart refunds what it charged).
//
// Prices: Pepe pushes his !imagine / !video prices - global and per Camfrog room - to /api/feed/aigen/prices
// every 10 min (feed_kv aigen_prices). A pad with a Camfrog room shows that room's price, anything else (site-only
// pads, profiles) the global one, before that the room's relay command menu, before that Pepe's defaults.
//
// 1.99dn
//   * Reference picture: the Generate panel can take one picture as a reference (image-to-image / image-to-video):
//     an upload through the normal feed upload pipeline (/api/feed/uploads: re-encoded, metadata dropped) or a
//     picture already in the draft - either way an image attachment of the account's own (`ref`). /start hands it
//     to Pepe re-encoded as a <= REF_MAX_PX JPEG. It costs what chat's -cam does: the !imagine / !video price +
//     Pepe's camsurcharge (pushed with the prices; DEFAULT_SURCHARGE before that). Pepe's guard treats it as a
//     photo of a real person: it can never be turned nude / sexual, and minors are always refused.
//   * Room generations -> the room's pad feed: a successful !imagine / !video in a Camfrog room is posted to that
//     room's pad. POST /api/feed/aigen/room (bot) decides: the pad's switch "Post room generations to the feed"
//     (feed_kv aigen_room:<pad>, default ON, Pad settings -> Feed), the requester's opt-out (feed_kv
//     aigen_nofeed:<userId>, Profile feed settings; or !imagine -nofeed in chat), feed bans / Pepe's refusals, the
//     feed's post limits and storage quotas. Author: the requester's linked PATV account, else Pepe with "made by
//     <display> in the room" (incognito: "someone"; Pepe's own chatty pictures: Pepe). It's a job row with
//     origin = 'room' (never in the composer, no inbox notices) that takes the same /chunk + /result; /result then
//     makes the post itself (free - it was paid in chat - and never announced in the room: it was just shown
//     there). Anything refused = skipped; the chat command is never held up by it.
//
// 1.99dr
//   * Cam snapshots as the reference: the pad page's bridge popover ("✨ Use in Generate" next to Save snap) and the
//     Generate panel ("📷 From a cam in this room": the people on cam in the picked pad's Camfrog room, from the bridge
//     roster - incognito / bridge-hidden people arrive anonymised and are never listed - then a fresh snapshot by
//     Pepe through the bridge's normal snap job, so the room's !bridge cams switch and the snapshot rate limits
//     apply). POST /api/feed/aigen/camref claims a frame this account was shown (bridge-relay snapForGen) into a
//     private, memory-only slot (CAMREF_TTL); POST /api/feed/aigen with `camref` copies it to the job (memory only)
//     and /start hands it to Pepe ONCE with ref_cam {room, login} - he re-checks the person's opt-out and the room's
//     switches before charging. Same price as a reference picture = chat's -cam (+ camsurcharge). The frame is
//     never written to disk or the database; only the generated result becomes an attachment (kept if attached).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const store = require("./feedstore");
const media = require("./feedmedia");
const rooms = require("./rooms");

const KINDS = { image: "imagine", video: "video" };
const DEFAULT_PRICES = { imagine: 25000, video: 50000 };      // Pepe's DEFAULT_PAT_COSTS
const PROMPT_MIN = 3, PROMPT_MAX = 600;
const MAX_OPEN = 2, MAX_OPEN_VIDEO = 1;
const QUEUE_TTL = 15 * 60e3;                                    // Pepe never picked it up
const RUN_TTL = { image: 5 * 60e3, video: 10 * 60e3 };          // started but no result
const KEEP_MS = 6 * 3600e3;                                     // finished previews stay this long (= unattached uploads)
const MAX_BYTES = 60 * 1024 * 1024;
const POLL_FRESH_MS = 20e3;                                     // polled this recently = the composer is open: no inbox notice
const ETA = { image: "~10–30 s", video: "~30–90 s" };
const JOB_RE = /^g[a-f0-9]{20}$/;
const DEFAULT_SURCHARGE = 10000;                                // Pepe's DEFAULT_PAT_COSTS camsurcharge (a reference picture)
const REF_MAX_PX = 1536;                                        // the reference picture Pepe gets (JPEG)
const ROOM_PEPE_PER_DAY = 40;                                   // room generations Pepe posts per pad per 24 h (on members' behalf)
const ATT_RE = /^[a-f0-9]{16,40}$/;
// 1.99dr: cam snapshots as the reference (memory only - never on disk, never in the DB)
const CAMREF_TTL = 15 * 60e3;                                   // a claimed snapshot waits this long for "Generate"
const CAMREF_PER_USER = 3;
const CAMREF_RE = /^c[a-f0-9]{20}$/;
const camRefs = new Map();                                      // claim id -> {img, userId, room, login, display, ts}
const camJobFrames = new Map();                                 // job id -> {img, ts}  (taken by /start, once)
let bridgeRoom = (roomId) => {
  try { const B = require("./bridge"); const R = B._rooms.get(roomId); return R && B.isLive(R) ? R : null; } catch (e) { return null; }
};
let snapForGen = (roomId, sid, userId) => require("./bridge-relay").snapForGen(roomId, sid, userId);
function _setBridge(roomFn, snapFn) { if (roomFn) bridgeRoom = roomFn; if (snapFn) snapForGen = snapFn; }

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await store.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_aigen_jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, camfrog TEXT, kind TEXT NOT NULL, prompt TEXT NOT NULL,
        pad TEXT, room TEXT, price INTEGER, cost INTEGER, status TEXT NOT NULL, message TEXT, refunded INTEGER NOT NULL DEFAULT 0,
        action_id INTEGER, attachment_id TEXT, nsfw INTEGER NOT NULL DEFAULT 0, model TEXT, back TEXT,
        created INTEGER NOT NULL, started INTEGER, progress_at INTEGER, secs INTEGER, finished INTEGER, polled INTEGER,
        notified INTEGER, received INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_aigen_user ON feed_aigen_jobs (user_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_aigen_status ON feed_aigen_jobs (status, created)");
      // 1.99dn: the reference picture (an attachment id) + room generations posted to the pad feed
      for (const [col, def] of [["ref_att", "TEXT"], ["origin", "TEXT"], ["post_id", "TEXT"], ["title", "TEXT"], ["byline", "TEXT"],
                                ["ref_cam", "TEXT"]]) {      // 1.99dr: {room, login, display} of a cam-snapshot reference
        const have = (await getQuery("PRAGMA table_info(feed_aigen_jobs)")).some((c) => c.name === col);
        if (!have) await runQuery(`ALTER TABLE feed_aigen_jobs ADD COLUMN ${col} ${def}`);
      }
    })().catch((e) => { console.error("[aigen] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const tmpPath = (id) => media.tmpPath("aigen-" + id);

// ── prices ──
let PRICES = null;          // {global: {imagine, video}, rooms: {room: {imagine, video}}, at}
async function loadPrices() {
  if (PRICES) return PRICES;
  try { PRICES = JSON.parse((await store.kvGet("aigen_prices")) || "null"); } catch (e) { PRICES = null; }
  if (!PRICES || typeof PRICES !== "object") PRICES = { global: {}, rooms: {}, at: 0 };
  return PRICES;
}
const cleanPrice = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : null);
let roomCmds = (roomId) => { try { const B = require("./bridge")._rooms.get(roomId); return (B && B.cmds) || {}; } catch (e) { return {}; } };
function _setRoomCmds(fn) { roomCmds = fn; }

/** The Camfrog room behind a pad id ("u/<me>" / profiles / site-only pads -> null). */
function camfrogRoomOf(padId) {
  const s = String(padId || "");
  if (!s || /^u\//.test(s) || rooms.isProfile(s)) return null;
  try { return rooms.isCommunityOnly(s) ? null : s; } catch (e) { return null; }
}
/** {image, video} prices for a pad: its Camfrog room's !imagine / !video price as Pepe reported it, else global. */
async function pricesFor(padId) {
  const P = await loadPrices();
  const room = camfrogRoomOf(padId);
  const out = {};
  for (const [kind, key] of Object.entries(KINDS)) {
    const r = room && P.rooms && P.rooms[room] ? cleanPrice(P.rooms[room][key]) : null;
    const menu = room ? cleanPrice((roomCmds(room) || {})["!" + key]) : null;
    const g = P.global ? cleanPrice(P.global[key]) : null;
    out[kind] = r != null ? r : menu != null ? menu : g != null ? g : DEFAULT_PRICES[key];
  }
  return out;
}

/** 1.99dn: the reference picture's surcharge for a pad = Pepe's -cam surcharge (the room's, else global). */
async function refPriceFor(padId) {
  const P = await loadPrices();
  const room = camfrogRoomOf(padId);
  const r = room && P.rooms && P.rooms[room] ? cleanPrice(P.rooms[room].camsurcharge) : null;
  const g = P.global ? cleanPrice(P.global.camsurcharge) : null;
  return r != null ? r : g != null ? g : DEFAULT_SURCHARGE;
}

/** A pad as the composer / API names it (id or slug; "u/<me>" = my profile) -> its room id ("u/..." kept), or null. */
async function normPad(p) {
  const s = String(p || "").trim().slice(0, 120);
  if (!s) return null;
  if (/^u\//.test(s)) return s;
  const R = await store.communityOf(s).catch(() => null);
  return R ? R.id : null;
}

// ── who may ──
/** null if `u` may generate for a post in `padId`, else {status, message}. */
async function refusal(u, padId) {
  const r = await store.postRefusal(u, [], { media: true });
  if (r) return r;
  if (padId && !/^u\//.test(String(padId))) {
    const R = await store.communityOf(padId);
    if (!R) return { status: 400, message: "That pad isn't on PATV." };
    const why = await store.roomPostRefusal(u, R.id);
    if (why) return why;
  }
  return null;
}

// ── jobs ──
function camOf(j) {
  if (!j || !j.ref_cam) return null;
  try { const c = JSON.parse(j.ref_cam); return c && typeof c === "object" ? c : null; } catch (e) { return null; }
}
function view(j, att) {
  const live = j.status === "queued" || j.status === "running";
  return {
    id: j.id, kind: j.kind, prompt: j.prompt, status: j.status, message: j.message || null, price: j.price, cost: j.cost,
    refunded: !!j.refunded, nsfw: !!j.nsfw, ref: !!(j.ref_att || j.ref_cam), refCam: camOf(j) ? camOf(j).display : null, created: j.created, started: j.started, secs: j.secs || 0, eta: ETA[j.kind],
    elapsed: live ? Math.max(0, Math.round((NOW() - (j.started || j.created)) / 1000)) : null,
    attachment: att ? { id: att.id, kind: att.kind, w: att.w, h: att.h, secs: att.secs, posted: !!att.post_id,
                        url: "/feed/f/" + (att.thumb || att.poster || att.file), file: "/feed/f/" + att.file,
                        poster: att.poster ? "/feed/f/" + att.poster : null, hidePrompt: !!att.ai_hide_prompt } : null,
  };
}
async function attOf(j) {
  return j.attachment_id ? (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [j.attachment_id]))[0] || null : null;
}
async function job(id) { return (await getQuery("SELECT * FROM feed_aigen_jobs WHERE id = ?", [String(id || "")]))[0] || null; }

/** The account's jobs the composer still shows: running ones and finished, unattached, undiscarded ones (KEEP_MS). */
async function mine(userId) {
  await init();
  const rows = await getQuery(`SELECT * FROM feed_aigen_jobs WHERE user_id = ? AND created > ? AND status IN ('queued','running','done','failed','timeout')
                               AND origin IS NULL ORDER BY created DESC LIMIT 12`, [userId, NOW() - KEEP_MS]);
  const out = [];
  for (const j of rows) {
    const a = await attOf(j);
    if (j.status === "done" && (!a || a.post_id || a.state !== "ready")) continue;     // attached (posted) or purged
    if ((j.status === "failed" || j.status === "timeout") && NOW() - (j.finished || j.created) > 30 * 60e3) continue;
    out.push(view(j, a));
  }
  return out;
}

// ── 1.99dr: cams in a pad's Camfrog room, as reference pictures ──
/** A member of bridge room R by login - never an anonymised (incognito / bridge-hidden) one, never Pepe. */
function camMember(R, login) {
  const low = String(login || "").toLowerCase();
  return (R && Array.isArray(R.members) ? R.members : []).find((m) => m && !m.anon && !m.self && m.login && String(m.login).toLowerCase() === low) || null;
}
/** The people on cam in the pad's Camfrog room -> {ok, slug, room, cams: [{login, display}], why}. */
async function camList(user, padId) {
  await init();
  const pad = await normPad(padId);
  const room = camfrogRoomOf(pad);
  if (!room) return { ok: true, cams: [], why: "Pick a Camfrog pad - the cams come from its Camfrog room." };
  const R = bridgeRoom(room);
  if (!R) return { ok: true, cams: [], why: "That pad's Camfrog room isn't live on the site right now." };
  if (!R.cams) return { ok: true, cams: [], why: "Cam snapshots aren't switched on in that Camfrog room." };
  const cams = R.members.filter((m) => m && !m.anon && !m.self && m.on_cam === true && m.login)
    .map((m) => ({ login: String(m.login), display: String(m.display || m.login) }))
    .sort((a, b) => a.display.localeCompare(b.display));
  return { ok: true, slug: R.slug, room: R.id, cams, why: cams.length ? null : "Nobody is on cam there right now." };
}
/** Claim a bridge snapshot this account was shown (sid) as its reference picture -> {ok, id, display, room, until}. */
async function claimCamRef(user, b) {
  await init();
  const u = await store.account(user.userId);
  if (!u) throw new Refuse(401, "Sign in first.");
  const pad = await normPad(b.pad);
  const room = camfrogRoomOf(pad);
  if (!room) throw new Refuse(400, "Cam snapshots come from a Camfrog pad's room.");
  const why = await refusal(u, pad);
  if (why) throw new Refuse(why.status || 403, why.message);
  const R = bridgeRoom(room);
  if (!R || !R.cams) throw new Refuse(403, "Cam snapshots aren't switched on in that Camfrog room.");
  const s = snapForGen(R.id, b.sid, u.userId);
  if (!s || s.error) throw new Refuse((s && s.status) || 410, (s && s.error) || "That snapshot expired - take a fresh one.");
  const m = camMember(R, s.login);
  if (!m) throw new Refuse(403, "Their cam can't be used.");          // incognito / hidden since, or gone
  const t = NOW();
  const mineNow = [...camRefs.entries()].filter(([, c]) => c.userId === u.userId).sort((x, y) => x[1].ts - y[1].ts);
  while (mineNow.length >= CAMREF_PER_USER) camRefs.delete(mineNow.shift()[0]);
  const id = "c" + crypto.randomBytes(10).toString("hex");
  camRefs.set(id, { img: s.img, userId: u.userId, room: R.id, login: String(m.login).toLowerCase(), display: String(m.display || m.login), ts: t });
  console.log(`[aigen] cam ref ${id} by ${u.username}: ${m.login} in ${R.id}`);
  return { ok: true, id, display: String(m.display || m.login), room: R.id, until: t + CAMREF_TTL };
}

async function create(user, b, { queue, audit } = {}) {
  await init();
  const u = await store.account(user.userId);
  if (!u) throw new Refuse(401, "Sign in first.");
  const kind = Object.prototype.hasOwnProperty.call(KINDS, b.kind) ? b.kind : null;
  if (!kind) throw new Refuse(400, "Generate a picture or a video.");
  const prompt = String(b.prompt || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (prompt.length < PROMPT_MIN) throw new Refuse(400, "Describe what to make.");
  if (prompt.length > PROMPT_MAX) throw new Refuse(400, `Keep the prompt under ${PROMPT_MAX} characters.`);
  const pad = await normPad(b.pad);
  if (b.pad && !pad) throw new Refuse(400, "That pad isn't on PATV.");
  const why = await refusal(u, pad);
  if (why) throw new Refuse(why.status || 403, why.message);
  const open = await getQuery("SELECT kind FROM feed_aigen_jobs WHERE user_id = ? AND status IN ('queued','running') AND origin IS NULL", [u.userId]);
  if (open.length >= MAX_OPEN) throw new Refuse(429, `You have ${open.length} generations going - wait for one to finish.`);
  if (kind === "video" && open.filter((x) => x.kind === "video").length >= MAX_OPEN_VIDEO) throw new Refuse(429, "One video at a time - wait for the one that's generating.");
  const C = store.config();
  if (!store.isStaff(u)) {
    if ((await store.usedBytes(u.userId)) + (kind === "video" ? 20 : 3) * 1024 * 1024 > C.user_quota_mb * 1024 * 1024) {
      throw new Refuse(413, `You're using your ${C.user_quota_mb} MB of space - delete some old posts to make room.`);
    }
  }
  if (media.diskFreeBytes() < C.min_free_gb * 1024 ** 3) throw new Refuse(507, "The feed's storage is full right now - try again later.");
  // 1.99dn: an optional reference picture - one of this account's own ready pictures (an upload / a draft picture)
  let ref = null;
  if (b.ref != null && b.ref !== "") {
    const rid = String(b.ref);
    const a = ATT_RE.test(rid) ? (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [rid]))[0] : null;
    if (!a || a.owner_id !== u.userId || a.kind !== "image" || a.state !== "ready" || !a.file) {
      throw new Refuse(400, "That reference picture isn't one of yours (or it's still processing) - pick it again.");
    }
    ref = a.id;
  }
  // 1.99dr: or a cam snapshot from the pad's Camfrog room (claimed by this account, still allowed)
  let cam = null;
  if (b.camref != null && b.camref !== "") {
    if (ref) throw new Refuse(400, "Use one reference picture - the upload or the cam.");
    const c = CAMREF_RE.test(String(b.camref)) ? camRefs.get(String(b.camref)) : null;
    if (!c || c.userId !== u.userId || NOW() - c.ts > CAMREF_TTL) throw new Refuse(410, "That cam snapshot expired - take a fresh one.");
    if (camfrogRoomOf(pad) !== c.room) throw new Refuse(400, "That cam snapshot is from another pad's Camfrog room - pick that pad, or a cam here.");
    const R = bridgeRoom(c.room);
    if (!R || !R.cams || !camMember(R, c.login)) throw new Refuse(403, "Their cam can't be used any more.");
    cam = c;
  }
  const prices = await pricesFor(pad);
  const price = prices[kind] + (ref || cam ? await refPriceFor(pad) : 0);
  const shown = cleanPrice(b.price);
  if (shown != null && shown < price) throw new Refuse(409, `The price changed to ${fmt(price)} PAT - check it and try again.`);
  const id = "g" + crypto.randomBytes(10).toString("hex");
  const back = /^\/[A-Za-z0-9/_?=&.%#-]*$/.test(String(b.back || "")) && !String(b.back).startsWith("//") ? String(b.back).slice(0, 200) : null;
  const t = NOW();
  await runQuery(`INSERT INTO feed_aigen_jobs (id, user_id, username, camfrog, kind, prompt, pad, room, price, status, back, created, ref_att, ref_cam)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
                 [id, u.userId, u.username, u.camfrogUsername || null, kind, prompt, pad, camfrogRoomOf(pad), price, back, t, ref,
                  cam ? JSON.stringify({ room: cam.room, login: cam.login, display: cam.display }) : null]);
  if (cam) camJobFrames.set(id, { img: cam.img, ts: t });            // private to this job; /start hands it over once
  try {
    const aid = await (queue || require("./actions").queue)(u.userId, { kind: "aigen", args: [id], tag: "aigen", label: `✨ generate ${kind}: ${prompt}`.slice(0, 200), idem: b.idem });
    await runQuery("UPDATE feed_aigen_jobs SET action_id = ? WHERE id = ?", [aid || null, id]);
  } catch (e) {
    camJobFrames.delete(id);
    await runQuery("DELETE FROM feed_aigen_jobs WHERE id = ?", [id]);
    if (e.message === "duplicate") throw new Refuse(409, "Already sent - that one is generating.");
    if (e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    throw e;
  }
  if (audit) await audit({ kind: "aigen", id, event: "generate", user: u }).catch(() => {});
  console.log(`[aigen] ${id} ${kind} by ${u.username} pad=${pad || "-"} price=${price}${ref ? " ref=" + ref : ""}${cam ? " cam=" + cam.login : ""}`);
  return view(await job(id), null);
}

async function discard(user, id) {
  await init();
  const j = await job(id);
  if (!j || j.user_id !== user.userId) throw new Refuse(404, "No such generation.");
  if (j.status === "running") throw new Refuse(409, "It's already generating - you can discard it when it's done.");
  if (j.status === "queued") {
    const r = await runQuery("UPDATE feed_aigen_jobs SET status = 'discarded', finished = ?, message = 'cancelled - nothing was charged' WHERE id = ? AND status = 'queued'", [NOW(), id]);
    if (!r.changes) throw new Refuse(409, "It just started generating - you can discard it when it's done.");
    camJobFrames.delete(id);
    return { ok: true, charged: false };
  }
  const a = await attOf(j);
  if (a && a.post_id) throw new Refuse(409, "That one is on a post - delete the post instead.");
  if (a && a.state !== "deleted" && a.state !== "purged") {
    media.removeFiles([a.file, a.thumb, a.poster].filter(Boolean));
    await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ? AND post_id IS NULL", [a.id]);
  }
  await runQuery("UPDATE feed_aigen_jobs SET status = 'discarded', finished = COALESCE(finished, ?) WHERE id = ?", [NOW(), id]);
  return { ok: true, charged: (j.cost || 0) > 0 && !j.refunded };
}

/** The author shows / hides the prompt under a generated file (before or after posting). */
async function setPromptShown(user, attId, show) {
  await init();
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(attId || "")]))[0];
  if (!a || a.owner_id !== user.userId || !a.ai_generated) throw new Refuse(404, "No such AI file.");
  await runQuery("UPDATE feed_attachments SET ai_hide_prompt = ? WHERE id = ?", [show ? 0 : 1, a.id]);
  return { ok: true, shown: !!show };
}

// ── Pepe's side ──
async function start(b) {
  await init();
  const j = await job(b.id);
  if (!j) throw new Refuse(404, "no such job");
  if (b.user && String(b.user).toLowerCase() !== String(j.username || "").toLowerCase()) throw new Refuse(403, "not that user's job");
  const r = await runQuery("UPDATE feed_aigen_jobs SET status = 'running', started = ?, progress_at = ? WHERE id = ? AND status = 'queued'", [NOW(), NOW(), j.id]);
  if (!r.changes) throw new Refuse(410, j.status === "discarded" ? "that generation was cancelled" : "that generation has expired");
  try { fs.unlinkSync(tmpPath(j.id)); } catch (e) { /* none */ }
  const out = { id: j.id, kind: j.kind, prompt: j.prompt, room: j.room || null, price: j.price, username: j.username, camfrog: j.camfrog || null };
  // 1.99dr: a cam snapshot reference - handed over ONCE (memory only; a site restart = gone: Pepe refuses, nothing
  // charged), with whose cam it is so Pepe can re-check their opt-out and the room's switches
  if (j.ref_cam) {
    const c = camOf(j);
    out.has_ref = true;
    out.ref_cam = c ? { room: String(c.room || ""), login: String(c.login || "") } : { room: "", login: "" };
    const f = camJobFrames.get(j.id);
    camJobFrames.delete(j.id);
    if (f && f.img) out.ref = { data: f.img.toString("base64"), mime: "image/jpeg" };
  } else
  // 1.99dn: the reference picture, as a JPEG (has_ref without data = it's gone: Pepe refuses, nothing charged)
  if (j.ref_att) {
    out.has_ref = true;
    const r = await refJpeg(j.ref_att, j.user_id).catch((e) => { console.error("[aigen] ref", j.id, e.message); return null; });
    if (r) out.ref = { data: r.toString("base64"), mime: "image/jpeg" };
  }
  return out;
}
/** The reference attachment (still this account's own, ready) -> a <= REF_MAX_PX JPEG Buffer, or null. */
async function refJpeg(attId, userId) {
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [attId]))[0];
  if (!a || a.owner_id !== userId || a.kind !== "image" || a.state !== "ready" || !a.file) return null;
  const f = media.filePath(a.file);
  if (!f || !fs.existsSync(f)) return null;
  const sharp = require("sharp");
  return sharp(f).rotate().resize({ width: REF_MAX_PX, height: REF_MAX_PX, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
}
async function progress(b) {
  await init();
  const cost = cleanPrice(b.cost), secs = cleanPrice(b.secs);
  await runQuery(`UPDATE feed_aigen_jobs SET progress_at = ?, cost = COALESCE(?, cost), secs = COALESCE(?, secs) WHERE id = ? AND status = 'running'`,
                 [NOW(), cost, secs, String(b.id || "")]);
  return { ok: true };
}
async function chunk(b) {
  await init();
  const j = await job(b.id);
  if (!j || j.status !== "running") throw new Refuse(410, "that generation isn't running");
  const off = Math.floor(Number(b.offset));
  const buf = Buffer.from(String(b.data || ""), "base64");
  if (!buf.length) throw new Refuse(400, "empty chunk");
  if (off !== j.received) throw new Refuse(409, "out of order");
  if (j.received + buf.length > MAX_BYTES) throw new Refuse(413, "too big");
  if (off === 0) {
    const sn = media.sniff(buf);
    const want = j.kind === "image" ? sn.kind === "image" : (sn.kind === "video" || sn.kind === "av");
    if (sn.bad || !want) throw new Refuse(415, sn.bad || "that isn't a " + (j.kind === "image" ? "picture" : "video"));
    fs.writeFileSync(tmpPath(j.id), buf);
  } else fs.appendFileSync(tmpPath(j.id), buf);
  await runQuery("UPDATE feed_aigen_jobs SET received = received + ?, progress_at = ? WHERE id = ? AND received = ?", [buf.length, NOW(), j.id, off]);
  return { ok: true, received: off + buf.length };
}

async function finish(j, status, fields, notice) {
  const sets = ["status = ?", "finished = ?"], args = [status, NOW()];
  for (const [k, v] of Object.entries(fields || {})) { sets.push(`${k} = ?`); args.push(v); }
  args.push(j.id);
  await runQuery(`UPDATE feed_aigen_jobs SET ${sets.join(", ")} WHERE id = ?`, args);
  try { fs.unlinkSync(tmpPath(j.id)); } catch (e) { /* none */ }
  if (notice) await tell(await job(j.id));
}

/** An inbox notice when the person isn't watching the composer (it polls while open). */
async function tell(j) {
  if (!j || j.origin === "room" || j.notified || (j.polled && NOW() - j.polled < POLL_FRESH_MS)) return false;
  await runQuery("UPDATE feed_aigen_jobs SET notified = ? WHERE id = ?", [NOW(), j.id]);
  const what = j.kind === "video" ? "video" : "picture";
  const ok = j.status === "done";
  const title = ok ? `✨ Your AI ${what} is ready` : `✨ Your AI ${what} couldn't be made`;
  const body = ok ? `"${j.prompt.slice(0, 120)}" - open the composer to attach it to a post (kept for 6 hours).`
    : `${j.message || "It failed"}.${j.refunded ? " The PAT was refunded." : (j.cost ? "" : " Nothing was charged.")}`;
  return store.notify(j.user_id, { kind: "feed", title, body, link: j.back || "/feed", ref: "aigen-" + j.id });
}

async function result(b) {
  await init();
  const j = await job(b.id);
  if (!j) throw new Refuse(404, "no such job");
  if (!b.ok) {
    const msg = String(b.error || "generation failed").slice(0, 300);
    // a failure report is always taken (also a second one after a failed store: "refunded")
    if (j.status === "done") return { ok: true };
    await finish(j, j.status === "discarded" || j.status === "timeout" ? j.status : "failed",
                 { message: msg, refunded: b.refunded ? 1 : 0, cost: cleanPrice(b.cost) != null ? cleanPrice(b.cost) : j.cost },
                 j.status !== "discarded");
    return { ok: true };
  }
  if (j.status !== "running") throw new Refuse(410, j.status === "discarded" ? "that generation was cancelled" : "that generation timed out");
  const C = store.config();
  const tmp = tmpPath(j.id);
  const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  if (!size || size !== j.received || (b.size != null && Number(b.size) !== size)) {
    await finish(j, "failed", { message: "the file didn't arrive in one piece" });
    throw new Refuse(409, "the file didn't arrive in one piece");
  }
  const u = await store.account(j.user_id);
  const room = j.origin === "room";
  if (!store.isStaff(u) && !(room && store.isPepe(u)) && (await store.usedBytes(j.user_id)) + size > C.user_quota_mb * 1024 * 1024) {
    await finish(j, "failed", { message: `you're using your ${C.user_quota_mb} MB of space` }, true);
    throw new Refuse(413, `You're using your ${C.user_quota_mb} MB of space`);
  }
  if ((await store.usedBytes(null)) + size > C.global_quota_gb * 1024 ** 3 || media.diskFreeBytes() - size * 2 < C.min_free_gb * 1024 ** 3) {
    console.error("[aigen] refused: storage full (quota or disk floor)");
    await finish(j, "failed", { message: "the feed's storage is full right now" }, true);
    throw new Refuse(507, "The feed's storage is full right now");
  }
  const attId = crypto.randomBytes(12).toString("hex");
  const nsfw = b.nsfw ? 1 : 0;
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, state, created, size_declared, received, ai_generated, ai_prompt, ai_model, ai_nsfw, ai_job)
                  VALUES (?, ?, ?, 'processing', ?, ?, ?, 1, ?, ?, ?, ?)`,
                 [attId, j.user_id, j.kind, NOW(), size, size, j.prompt, String(b.model || "").slice(0, 80) || null, nsfw, j.id]);
  try {
    const head = Buffer.alloc(64);
    const fd = fs.openSync(tmp, "r");
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    const sn = media.sniff(head);
    if (sn.bad) throw new media.MediaError(sn.bad);
    const out = j.kind === "image"
      ? (sn.kind === "image" ? await media.processImage(tmp, sn.fmt) : (() => { throw new media.MediaError("That isn't a picture."); })())
      : await media.processAv(tmp, { ...sn, kind: "video" }, C);
    if (out.kind !== j.kind) throw new media.MediaError("That came back as the wrong kind of file.");
    await runQuery(`UPDATE feed_attachments SET state = 'ready', kind = ?, ct = ?, file = ?, thumb = ?, poster = ?, w = ?, h = ?, secs = ?, bytes = ?, error = NULL
                    WHERE id = ?`, [out.kind, out.ct, out.file, out.thumb, out.poster, out.w, out.h, out.secs, out.bytes, attId]);
  } catch (e) {
    const msg = e && e.refuse ? e.message : "the file couldn't be processed";
    if (!(e && e.refuse)) console.error("[aigen] process", j.id, e);
    await runQuery("UPDATE feed_attachments SET state = 'failed', error = ? WHERE id = ?", [String(msg).slice(0, 300), attId]);
    await finish(j, "failed", { message: msg });
    throw new Refuse(422, msg);
  }
  if (room) return roomPost(j, attId, nsfw, b);
  await finish(j, "done", { attachment_id: attId, nsfw, model: String(b.model || "").slice(0, 80) || null,
                            cost: cleanPrice(b.cost) != null ? cleanPrice(b.cost) : j.cost }, true);
  console.log(`[aigen] ${j.id} done -> attachment ${attId} (${size} bytes${nsfw ? ", NSFW" : ""})`);
  return { ok: true, attachment: attId };
}

// ── 1.99dn: room generations -> the room's pad feed ──
const onFlag = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
/** The pad's "Post room generations to the feed" switch (default ON). */
async function roomGenOn(padId) {
  await store.init();
  const v = await store.kvGet("aigen_room:" + String(padId || ""));
  return v == null ? true : v === "1";
}
async function setRoomGen(user, padId, on) {
  if (!(await rooms.canManage(user, padId))) throw new Refuse(403, "Only this pad's owner can do that.");
  await store.kvSet("aigen_room:" + padId, on ? "1" : "0");
  try { await rooms.event(padId, "feed-aigen-room", user.username, on ? "on" : "off"); } catch (e) { /* no event log */ }
  return !!on;
}
/** A member's "Don't post my room generations" (default: posted). */
async function optedOut(userId) {
  await store.init();
  return (await store.kvGet("aigen_nofeed:" + String(userId || ""))) === "1";
}
async function setOptOut(userId, out) {
  await store.init();
  await store.kvSet("aigen_nofeed:" + userId, out ? "1" : "0");
  return !!out;
}

/**
 * Pepe: "this !imagine / !video just succeeded in <room>" {room, login, display, incognito, pepe, kind, prompt, title,
 * model} -> {ok: true, id} (send the file: /chunk + /result) or {ok: false, skip: why} (don't post it).
 */
async function roomStart(b) {
  await init();
  const kind = Object.prototype.hasOwnProperty.call(KINDS, b.kind) ? b.kind : null;
  if (!kind) throw new Refuse(400, "unknown kind");
  const prompt = String(b.prompt || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, PROMPT_MAX);
  if (!prompt) throw new Refuse(400, "no prompt");
  const skip = (why) => { console.log(`[aigen] room post skipped (${b.room}): ${why}`); return { ok: false, skip: why }; };
  const R = await store.communityOf(String(b.room || "").slice(0, 80)).catch(() => null);
  if (!R || rooms.platformOf(R.id) !== "camfrog") return skip("this room has no pad");
  if (!(await roomGenOn(R.id))) return skip("posting room generations is off for this pad");
  const C = store.config();
  if (!C.enabled) return skip("posting is switched off");
  const t = NOW();
  const login = b.pepe ? "" : String(b.login || "").trim().toLowerCase().slice(0, 60);
  // the requester's linked account: their opt-out, bans and the feed's limits apply even when Pepe posts it for them
  let linked = null;
  if (login) {
    const row = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = ? LIMIT 1", [login]))[0];
    if (row) linked = await store.account(row.userId);
    const rs = await getQuery("SELECT room_id FROM feed_restricted WHERE login = ? AND (until IS NULL OR until > ?)", [login, t]);
    if (rs.some((r) => r.room_id === "" || r.room_id === R.id)) return skip("Pepe's refusals apply to this login");
  }
  if (linked) {
    if (await optedOut(linked.userId)) return skip("the member opted out");
    const why = await store.postRefusal(linked, [R.id], { media: true });
    if (why) return skip(why.message);
  }
  let author, byline;
  const what = kind === "video" ? "!video" : "!imagine";
  const display = store.cleanLine ? store.cleanLine(b.display, 40) : String(b.display || "").slice(0, 40);
  if (linked && !b.incognito) {
    author = linked;
    const why = await store.roomPostRefusal(linked, R.id);
    if (why) return skip(why.message);
    const bud = await store.postBudget(linked);
    if (bud.left <= 0) return skip(bud.why || "post limit");
    if (!store.isStaff(linked) && (await store.usedBytes(linked.userId)) + (kind === "video" ? 20 : 3) * 1024 * 1024 > C.user_quota_mb * 1024 * 1024) {
      return skip("the member's storage is full");
    }
    byline = `✨ Made with ${what} in the Camfrog room.`;
  } else {
    const acct = await require("./pepefeed").ensureAccount();
    author = await store.account(acct.userId);
    if (!author) return skip("Pepe has no site account");
    const n = (await getQuery(`SELECT COUNT(*) AS n FROM feed_aigen_jobs WHERE origin = 'room' AND pad = ? AND user_id = ? AND created > ?
                                AND status IN ('running','done')`, [R.id, author.userId, t - 86400e3]))[0].n;
    if (n >= ROOM_PEPE_PER_DAY) return skip("Pepe's daily room-generation posts for this pad are used up");
    byline = b.pepe ? `✨ Pepe made this with ${what} in the Camfrog room.`
      : `✨ Made with ${what} by ${b.incognito ? "someone" : (display || "someone")} in the Camfrog room.`;
  }
  if ((await store.usedBytes(null)) + 20 * 1024 * 1024 > C.global_quota_gb * 1024 ** 3 || media.diskFreeBytes() < C.min_free_gb * 1024 ** 3) {
    return skip("the feed's storage is full");
  }
  const title = (store.cleanLine ? store.cleanLine(b.title || prompt, 140) : String(b.title || prompt).slice(0, 140)) || prompt.slice(0, 140);
  const id = "g" + crypto.randomBytes(10).toString("hex");
  await runQuery(`INSERT INTO feed_aigen_jobs (id, user_id, username, camfrog, kind, prompt, pad, room, price, cost, status, created, started, progress_at,
                  origin, title, byline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'running', ?, ?, ?, 'room', ?, ?)`,
                 [id, author.userId, author.username, login || null, kind, prompt, R.id, camfrogRoomOf(R.id), t, t, t, title, byline]);
  console.log(`[aigen] room ${kind} ${id} for ${login || "pepe"} -> p/${R.slug || R.id} as ${author.username}`);
  return { ok: true, id };
}

/** /result of a room job: the attachment is ready - make the post (free, never announced in the room). */
async function roomPost(j, attId, nsfw, b) {
  let made = null;
  try {
    made = await store.create(j.user_id, { title: j.title || j.prompt.slice(0, 140), body: j.byline || "", community: j.pad, attachments: [attId],
                                           nsfw: !!nsfw, announce: [] }, { free: true, roomGen: true });
  } catch (e) {
    const msg = e && e.refuse ? e.message : "the post couldn't be made";
    if (!(e && e.refuse)) console.error("[aigen] room post", j.id, e);
    const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [attId]))[0];
    if (a && !a.post_id) {
      media.removeFiles([a.file, a.thumb, a.poster].filter(Boolean));
      await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ? AND post_id IS NULL", [attId]);
    }
    await finish(j, "failed", { message: String(msg).slice(0, 300) });
    console.log(`[aigen] room post ${j.id} not made: ${msg}`);
    throw new Refuse(e && e.status && e.status < 500 ? e.status : 409, msg);
  }
  await finish(j, "done", { attachment_id: attId, nsfw, model: String(b.model || "").slice(0, 80) || null, post_id: made ? made.id : null });
  console.log(`[aigen] room post ${j.id} -> post ${made && made.id} in ${j.pad}${nsfw ? " (NSFW)" : ""}`);
  return { ok: true, attachment: attId, post: made ? made.id : null };
}

async function setPrices(b) {
  await init();
  const P = { global: {}, rooms: {}, at: NOW() };
  const KEYS = [...Object.values(KINDS), "camsurcharge"];      // 1.99dn: + the -cam surcharge (the reference picture)
  for (const k of KEYS) { const v = cleanPrice((b.global || {})[k]); if (v != null) P.global[k] = v; }
  for (const [room, pr] of Object.entries(b.rooms || {}).slice(0, 500)) {
    if (!/^[\w.@ -]{1,80}$/.test(room) || !pr || typeof pr !== "object") continue;
    const o = {};
    for (const k of KEYS) { const v = cleanPrice(pr[k]); if (v != null) o[k] = v; }
    P.rooms[room] = o;
  }
  await store.kvSet("aigen_prices", JSON.stringify(P));
  PRICES = P;
  return { ok: true, rooms: Object.keys(P.rooms).length };
}

/** Expire jobs Pepe never picked up / never finished. */
async function sweep() {
  await init();
  const t = NOW();
  for (const [k, c] of camRefs) if (t - c.ts > CAMREF_TTL) camRefs.delete(k);           // 1.99dr
  for (const [k, f] of camJobFrames) if (t - f.ts > QUEUE_TTL) camJobFrames.delete(k);
  const stale = await getQuery("SELECT * FROM feed_aigen_jobs WHERE (status = 'queued' AND created < ?) OR status = 'running'", [t - QUEUE_TTL]);
  let n = 0;
  for (const j of stale) {
    if (j.status === "queued") {
      await finish(j, "timeout", { message: "Pepe didn't pick it up - nothing was charged" }, true);
      n++;
    } else if (t - (j.started || j.created) > RUN_TTL[j.kind === "video" ? "video" : "image"]) {
      await finish(j, "timeout", { message: "it took too long - any PAT taken is refunded automatically" }, true);
      n++;
    }
  }
  return n;
}

// ── routes ──
function register(app, { isBotToken, addUser, noTimers = false, audit = null }) {
  init().catch(() => {});
  const json = express.json();
  const bigJson = express.json({ limit: "1mb" });      // one chunk: 384 KB -> ~512 KB of base64
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const bot = (req, res, next) => (isBotToken((req.body || {}).password) ? next() : res.status(403).json({ ok: false, error: "unauthorized" }));
  const fail = (res, e) => {
    const st = e && e.status && e.status < 600 ? e.status : 500;
    if (!(e && e.refuse)) console.error("[aigen]", e);
    res.status(st).json({ ok: false, error: e && e.refuse ? e.message : "Something went wrong." });
  };
  const auditRec = (req) => (what) => {
    if (audit) return audit(req, what);
    try { const a = require("./contentaudit"); return a.record(a.fromRequest(req), what); } catch (e) { return Promise.resolve(); }
  };

  app.get("/api/feed/aigen", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      await init();
      const u = await store.account(req.user.userId);
      const pad = await normPad(req.query.pad);
      const why = await refusal(u, pad);
      res.json({ ok: true, eligible: !why, why: why ? why.message : null, prices: await pricesFor(pad), refPrice: await refPriceFor(pad), jobs: await mine(req.user.userId),
                 limits: { open: MAX_OPEN, openVideo: MAX_OPEN_VIDEO, promptMax: PROMPT_MAX }, eta: ETA });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen", json, addUser, guard, async (req, res) => {
    try { res.json({ ok: true, job: await create(req.user, req.body || {}, { audit: auditRec(req) }) }); } catch (e) { fail(res, e); }
  });
  // 1.99dr: cams in the picked pad's Camfrog room (incognito / hidden never listed), and claiming a snapshot
  app.get("/api/feed/aigen/cams", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json(await camList(req.user, req.query.pad)); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/camref", json, addUser, guard, async (req, res) => {
    try { res.json(await claimCamRef(req.user, req.body || {})); } catch (e) { fail(res, e); }
  });
  app.get("/api/feed/aigen/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try {
      await init();
      const j = await job(req.params.id);
      if (!j || j.user_id !== req.user.userId) return res.status(404).json({ ok: false, error: "No such generation." });
      await runQuery("UPDATE feed_aigen_jobs SET polled = ? WHERE id = ?", [NOW(), j.id]);
      res.json({ ok: true, job: view(j, await attOf(j)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/:id/discard", json, addUser, guard, async (req, res) => {
    try { res.json(await discard(req.user, req.params.id)); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/attachments/:id/ai-prompt", json, addUser, guard, async (req, res) => {
    try { res.json(await setPromptShown(req.user, req.params.id, !!(req.body || {}).show)); } catch (e) { fail(res, e); }
  });

  // Pepe
  app.post("/api/feed/aigen/start", json, bot, async (req, res) => {
    try { res.json({ ok: true, job: await start(req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/progress", json, bot, async (req, res) => {
    try { res.json(await progress(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/chunk", bigJson, bot, async (req, res) => {
    try { res.json(await chunk(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/result", json, bot, async (req, res) => {
    try { res.json(await result(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen/prices", json, bot, async (req, res) => {
    try { res.json(await setPrices(req.body || {})); } catch (e) { fail(res, e); }
  });
  // 1.99dn: a room's !imagine / !video -> its pad feed (Pepe), and the pad owner's switch
  app.post("/api/feed/aigen/room", json, bot, async (req, res) => {
    try { res.json(await roomStart(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/feed/aigen-room", json, addUser, guard, async (req, res) => {
    try {
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json({ ok: true, on: await setRoomGen(await store.account(req.user.userId), R.id, onFlag((req.body || {}).on)) });
    } catch (e) { fail(res, e); }
  });

  if (!noTimers) {
    const t = setInterval(() => sweep().catch((e) => console.error("[aigen] sweep:", e.message)), 60e3);
    if (t.unref) t.unref();
  }
}

module.exports = { register, init, create, discard, setPromptShown, start, progress, chunk, result, setPrices, sweep, mine, pricesFor, refusal, view,
                   refPriceFor, roomStart, roomGenOn, setRoomGen, optedOut, setOptOut, DEFAULT_SURCHARGE, ROOM_PEPE_PER_DAY, REF_MAX_PX,
                   camfrogRoomOf, normPad, _setClock, _setRoomCmds, KINDS, camList, claimCamRef, camMember, _setBridge, CAMREF_TTL,
                   _camRefs: camRefs, _camJobFrames: camJobFrames, DEFAULT_PRICES, MAX_OPEN, MAX_OPEN_VIDEO, QUEUE_TTL, RUN_TTL, PROMPT_MAX, ETA, Refuse };
