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
function view(j, att) {
  const live = j.status === "queued" || j.status === "running";
  return {
    id: j.id, kind: j.kind, prompt: j.prompt, status: j.status, message: j.message || null, price: j.price, cost: j.cost,
    refunded: !!j.refunded, nsfw: !!j.nsfw, created: j.created, started: j.started, secs: j.secs || 0, eta: ETA[j.kind],
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
                               ORDER BY created DESC LIMIT 12`, [userId, NOW() - KEEP_MS]);
  const out = [];
  for (const j of rows) {
    const a = await attOf(j);
    if (j.status === "done" && (!a || a.post_id || a.state !== "ready")) continue;     // attached (posted) or purged
    if ((j.status === "failed" || j.status === "timeout") && NOW() - (j.finished || j.created) > 30 * 60e3) continue;
    out.push(view(j, a));
  }
  return out;
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
  const open = await getQuery("SELECT kind FROM feed_aigen_jobs WHERE user_id = ? AND status IN ('queued','running')", [u.userId]);
  if (open.length >= MAX_OPEN) throw new Refuse(429, `You have ${open.length} generations going - wait for one to finish.`);
  if (kind === "video" && open.filter((x) => x.kind === "video").length >= MAX_OPEN_VIDEO) throw new Refuse(429, "One video at a time - wait for the one that's generating.");
  const C = store.config();
  if (!store.isStaff(u)) {
    if ((await store.usedBytes(u.userId)) + (kind === "video" ? 20 : 3) * 1024 * 1024 > C.user_quota_mb * 1024 * 1024) {
      throw new Refuse(413, `You're using your ${C.user_quota_mb} MB of space - delete some old posts to make room.`);
    }
  }
  if (media.diskFreeBytes() < C.min_free_gb * 1024 ** 3) throw new Refuse(507, "The feed's storage is full right now - try again later.");
  const prices = await pricesFor(pad);
  const price = prices[kind];
  const shown = cleanPrice(b.price);
  if (shown != null && shown < price) throw new Refuse(409, `The price changed to ${fmt(price)} PAT - check it and try again.`);
  const id = "g" + crypto.randomBytes(10).toString("hex");
  const back = /^\/[A-Za-z0-9/_?=&.%#-]*$/.test(String(b.back || "")) && !String(b.back).startsWith("//") ? String(b.back).slice(0, 200) : null;
  const t = NOW();
  await runQuery(`INSERT INTO feed_aigen_jobs (id, user_id, username, camfrog, kind, prompt, pad, room, price, status, back, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
                 [id, u.userId, u.username, u.camfrogUsername || null, kind, prompt, pad, camfrogRoomOf(pad), price, back, t]);
  try {
    const aid = await (queue || require("./actions").queue)(u.userId, { kind: "aigen", args: [id], tag: "aigen", label: `✨ generate ${kind}: ${prompt}`.slice(0, 200), idem: b.idem });
    await runQuery("UPDATE feed_aigen_jobs SET action_id = ? WHERE id = ?", [aid || null, id]);
  } catch (e) {
    await runQuery("DELETE FROM feed_aigen_jobs WHERE id = ?", [id]);
    if (e.message === "duplicate") throw new Refuse(409, "Already sent - that one is generating.");
    if (e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    throw e;
  }
  if (audit) await audit({ kind: "aigen", id, event: "generate", user: u }).catch(() => {});
  console.log(`[aigen] ${id} ${kind} by ${u.username} pad=${pad || "-"} price=${price}`);
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
  return { id: j.id, kind: j.kind, prompt: j.prompt, room: j.room || null, price: j.price, username: j.username, camfrog: j.camfrog || null };
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
  if (!j || j.notified || (j.polled && NOW() - j.polled < POLL_FRESH_MS)) return false;
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
  if (!store.isStaff(u) && (await store.usedBytes(j.user_id)) + size > C.user_quota_mb * 1024 * 1024) {
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
  await finish(j, "done", { attachment_id: attId, nsfw, model: String(b.model || "").slice(0, 80) || null,
                            cost: cleanPrice(b.cost) != null ? cleanPrice(b.cost) : j.cost }, true);
  console.log(`[aigen] ${j.id} done -> attachment ${attId} (${size} bytes${nsfw ? ", NSFW" : ""})`);
  return { ok: true, attachment: attId };
}

async function setPrices(b) {
  await init();
  const P = { global: {}, rooms: {}, at: NOW() };
  for (const k of Object.values(KINDS)) { const v = cleanPrice((b.global || {})[k]); if (v != null) P.global[k] = v; }
  for (const [room, pr] of Object.entries(b.rooms || {}).slice(0, 500)) {
    if (!/^[\w.@ -]{1,80}$/.test(room) || !pr || typeof pr !== "object") continue;
    const o = {};
    for (const k of Object.values(KINDS)) { const v = cleanPrice(pr[k]); if (v != null) o[k] = v; }
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
      res.json({ ok: true, eligible: !why, why: why ? why.message : null, prices: await pricesFor(pad), jobs: await mine(req.user.userId),
                 limits: { open: MAX_OPEN, openVideo: MAX_OPEN_VIDEO, promptMax: PROMPT_MAX }, eta: ETA });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/aigen", json, addUser, guard, async (req, res) => {
    try { res.json({ ok: true, job: await create(req.user, req.body || {}, { audit: auditRec(req) }) }); } catch (e) { fail(res, e); }
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

  if (!noTimers) {
    const t = setInterval(() => sweep().catch((e) => console.error("[aigen] sweep:", e.message)), 60e3);
    if (t.unref) t.unref();
  }
}

module.exports = { register, init, create, discard, setPromptShown, start, progress, chunk, result, setPrices, sweep, mine, pricesFor, refusal, view,
                   camfrogRoomOf, normPad, _setClock, _setRoomCmds, KINDS, DEFAULT_PRICES, MAX_OPEN, MAX_OPEN_VIDEO, QUEUE_TTL, RUN_TTL, PROMPT_MAX, ETA, Refuse };
