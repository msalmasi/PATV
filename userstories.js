// userstories.js — members' own stories and "captures of me" (1.99ez).
//
// 1. Your story. A signed-in member uploads a picture or a short video (<= STORY_MAX_SECS) as a 24-hour story, to a pad
//    they may post in or to their own profile (its profile pad, user:<userId>). The upload is the FEED's pipeline
//    (feedmedia.js via /api/feed/uploads with purpose "story": 512 KB chunks, magic-byte sniff, size caps, re-encode
//    with every bit of metadata dropped - pictures to webp, video to H.264/AAC mp4 + a poster frame; the duration cap is
//    STORY_MAX_SECS for story uploads). Then POST /api/stories/mine {attachment, pad, nsfw} checks everything again:
//      * the account rules (feedstore.postRefusal: archived, restricted, feed bans - global and that pad's -, Pepe's
//        refusals for the linked login, the media level gate) and the pad's own who-can-post rules
//        (feedstore.roomPostRefusal: linked / followers / approved / per-day; a profile pad takes only its owner);
//      * a pad that approves posts first takes stories only from its owner and staff (a story can't wait in a queue);
//      * STORY_PER_DAY stories per member per 24 h, one every STORY_GAP_MS;
//      * the SAFETY CHECK (setSafetyCheck - the same pluggable hook shape as padlook.js): {ok:false} refuses,
//        {nsfw:true} marks the story NSFW (blurred behind a tap, never a strip cover), like the uploader's own NSFW tick.
//    The processed files MOVE out of the feed directory into the captures directory (media.js) and the attachment row
//    is marked consumed (state 'deleted', so it never counts against the feed quota or shows anywhere). The story is a
//    media row: source "user", by_user = the uploader's display name, by_user_id = the uploader, room = the pad (or
//    user:<userId>), expires = created + 24 h - so the strips, the viewer, seen state, the expiry purge and the poster
//    backfill treat it exactly like a capture. Removing it: the uploader, the pad's owner (rooms.canManage, which is the
//    member themselves on a profile pad), the pad's mods (Camfrog mod powers, storykeep's check) and site staff
//    (stagecap.canDelete / remove -> POST /api/stories/:id/delete). Stories can't be 📌 posted to a pad; 1.99fn: a snap
//    or clip story (kind photo / clip) CAN be 🔖 saved by any member (storykeep.SAVE_USER_KINDS) - removing the story
//    drops the saved copies too (storykeep.onCaptureRemoved).
//
// 2. Captures of me. A member's PERSON story (id "user:<userId>", the same id as their profile pad, so one seen state)
//    is their own profile uploads plus, unless they turned it off, the last 24 h of:
//      * cam snaps / clips whose subject is their linked Camfrog login (media.subject_login, Pepe 1.99ez+; older rows by
//        `subject` when it equals the login);
//      * stage snaps / clips of a stage slot they streamed (media.slot_id -> stage_slots.userId).
//    Never included: a private subject (media.anon: !incognito / !bridge hide), or anything at all of a member whose
//    linked account hides its Analytics / Rooms panel (the stories privacy rule - their own uploads still show), and
//    captures the member hid from their story (story_hides - hiding doesn't delete the capture; "Remove me" on a post
//    is still the way to take a post of yourself down).
//    The ring shows on their profile, in Following for people who follow them, and on the homepage / /feed strip for
//    people with an upload on their profile (plus the viewer's own).
//
// Data
//   story_prefs  user_id PK, captures_of_me (1 = show captures of me in my story; default 1), updated
//   story_hides  user_id + capture_id (PK), created - captures the member hid from their own story
//   media        (media.js) + subject_login; source "user" rows are member uploads
//   feed_attachments + purpose ('story' for a story upload: the 30 s cap; NULL = a post upload)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const media = require("./media");
const rooms = require("./rooms");

const WINDOW_MS = 24 * 3600 * 1000;
const STORY_MAX_SECS = 30;
const STORY_MAX_IMAGE_MB = 10, STORY_MAX_VIDEO_MB = 60;
const STORY_PER_DAY = 20, STORY_GAP_MS = 10 * 1000;
const CID_RE = /^[a-f0-9]{8,32}$/i;
const UID_RE = /^[A-Za-z0-9_.:\-]{1,80}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

const store = () => require("./feedstore");
const fm = () => require("./feedmedia");
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const lc = (s) => String(s || "").trim().toLowerCase();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await media.ready;
      await store().init();
      await runQuery("CREATE TABLE IF NOT EXISTS story_prefs (user_id TEXT PRIMARY KEY, captures_of_me INTEGER NOT NULL DEFAULT 1, updated INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS story_hides (user_id TEXT NOT NULL, capture_id TEXT NOT NULL, created INTEGER, PRIMARY KEY (user_id, capture_id))");
      const cols = new Set((await getQuery("PRAGMA table_info(feed_attachments)")).map((c) => c.name));
      if (!cols.has("purpose")) await runQuery("ALTER TABLE feed_attachments ADD COLUMN purpose TEXT").catch(() => {});
      await runQuery("CREATE INDEX IF NOT EXISTS media_subject_login ON media (subject_login)").catch(() => {});
    })().catch((e) => { console.error("[userstories] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── the safety check (pluggable, the padlook.js hook shape) ──
let SAFETY = async () => ({ ok: true });
/** fn({file, kind: "image"|"video", poster, roomId, userId}) -> {ok:true[, nsfw:true]} | {ok:false, reason}. null restores the default. */
function setSafetyCheck(fn) { SAFETY = typeof fn === "function" ? fn : async () => ({ ok: true }); }

// ── prefs + hides ──
async function prefs(userId) {
  await init();
  const r = (await getQuery("SELECT captures_of_me FROM story_prefs WHERE user_id = ?", [String(userId || "")]))[0];
  return { capturesOfMe: r ? !!Number(r.captures_of_me) : true };
}
async function setPrefs(user, { capturesOfMe }) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  const on = !(capturesOfMe === false || capturesOfMe === 0 || capturesOfMe === "0" || capturesOfMe === "off" || capturesOfMe === "false");
  await runQuery(`INSERT INTO story_prefs (user_id, captures_of_me, updated) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET captures_of_me = excluded.captures_of_me, updated = excluded.updated`, [user.userId, on ? 1 : 0, NOW()]);
  return { capturesOfMe: on };
}
/** The subject hides a capture of them from THEIR story (the capture itself stays in its pad's story). Idempotent. */
async function hide(user, captureId) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  const id = String(captureId || "");
  if (!CID_RE.test(id)) throw new Refuse(404, "No such capture.");
  const row = (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
  if (!row) throw new Refuse(404, "No such capture.");
  if (row.source === "user") throw new Refuse(400, "That's an upload, not a capture - delete it instead.");
  if (!(await isSubject(user, row))) throw new Refuse(403, "Only the person in a capture can hide it from their story.");
  const r = await runQuery("INSERT OR IGNORE INTO story_hides (user_id, capture_id, created) VALUES (?, ?, ?)", [user.userId, id, NOW()]);
  return { hidden: true, again: !r.changes };
}
async function unhide(user, captureId) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  await runQuery("DELETE FROM story_hides WHERE user_id = ? AND capture_id = ?", [user.userId, String(captureId || "")]);
  return { hidden: false };
}
async function loginOf(userId) {
  const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId || "")]))[0];
  return u && u.camfrogUsername ? lc(u.camfrogUsername) : null;
}
async function slotOwner(slotId) {
  if (!slotId) return null;
  try { const s = await require("./mainstage").getSlot(String(slotId)); return s && s.userId ? s.userId : null; } catch (e) { return null; }
}
/** Is `user` the subject of capture `row`? (cam: their linked login; stage: the slot's streamer) */
async function isSubject(user, row) {
  if (!user || !user.userId || !row) return false;
  if (row.source === "stage") return (await slotOwner(row.slot_id)) === user.userId;
  if (Number(row.anon)) return false;
  const login = await loginOf(user.userId);
  if (!login) return false;
  return row.subject_login ? lc(row.subject_login) === login : lc(row.subject) === login;
}
/** Does this account keep its activity private (the stories rule: Analytics or its Rooms panel hidden)? Fails closed. */
async function isPrivate(userId) {
  const pl = require("./profilelayout");
  try {
    const L = await pl.get(userId);
    return pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden";
  } catch (e) { return true; }
}

// ── person stories ──
let MCOLS = null;
async function mcols() {
  if (!MCOLS) MCOLS = new Set((await getQuery("PRAGMA table_info(media)")).map((c) => c.name));
  return MCOLS;
}
const SEL = "id, kind, ct, file, subject, by_user, by_user_id, room, created, expires, secs, anon, source, nsfw, slot_id, subject_login";

/** The raw rows of `uid`'s person story (newest first): own profile uploads + captures of them (prefs, privacy, hides). */
async function personRows(uid, { prefsOn = null } = {}) {
  await init();
  await mcols();
  const t = NOW(), since = t - WINDOW_MS;
  const own = await getQuery(`SELECT ${SEL} FROM media WHERE deleted = 0 AND expires > ? AND created > ? AND source = 'user' AND room = ?
                              ORDER BY created DESC LIMIT 100`, [t, since, rooms.PROFILE_PREFIX + uid]);
  let caps = [];
  const on = prefsOn === null ? (await prefs(uid)).capturesOfMe : prefsOn;
  if (on && !(await isPrivate(uid))) {
    const login = await loginOf(uid);
    if (login) {
      caps = caps.concat(await getQuery(`SELECT ${SEL} FROM media WHERE deleted = 0 AND expires > ? AND created > ? AND COALESCE(source, 'cam') = 'cam'
                                          AND COALESCE(anon, 0) = 0 AND (subject_login = ? OR (subject_login IS NULL AND lower(subject) = ?))
                                          ORDER BY created DESC LIMIT 200`, [t, since, login, login]));
    }
    try {
      caps = caps.concat(await getQuery(`SELECT ${SEL.split(", ").map((c) => "m." + c).join(", ")} FROM media m JOIN stage_slots s ON s.id = m.slot_id
                                          WHERE m.deleted = 0 AND m.expires > ? AND m.created > ? AND m.source = 'stage' AND s.userId = ?
                                          ORDER BY m.created DESC LIMIT 200`, [t, since, uid]));
    } catch (e) { /* no stage table yet */ }
    if (caps.length) {
      const hid = new Set((await getQuery("SELECT capture_id FROM story_hides WHERE user_id = ?", [uid])).map((r) => r.capture_id));
      caps = caps.filter((r) => !hid.has(r.id));
    }
  }
  const seen = new Set();
  return own.concat(caps).filter((r) => (seen.has(r.id) ? false : seen.add(r.id))).sort((a, b) => b.created - a.created);
}

async function personInfo(uid) {
  const u = (await getQuery("SELECT userId, username, displayname, avatar FROM users WHERE userId = ?", [uid]).catch(() => []))[0];
  if (!u) return null;
  return { id: rooms.PROFILE_PREFIX + u.userId, person: true, user: u.username, title: u.displayname || u.username,
           href: "/u/" + encodeURIComponent(u.username),
           avatar: u.avatar && /^(\/|https:\/\/)/.test(String(u.avatar)) ? String(u.avatar) : null };
}

/**
 * Person story entries for `uids` (the strip / viewer shape of stories.forViewer). Signed in: items (oldest first) with
 * where each was taken, seen state, a cover; signed out: the circle and a count only. Empty stories are left out.
 * seen: Map(room id -> upto) - stories.seenMap(viewer).
 */
async function people(viewer, uids, { seen = null } = {}) {
  await init();
  const stories = require("./stories");
  const signed = !!(viewer && viewer.userId);
  const S = seen || (signed ? await stories.seenMap(viewer.userId) : new Map());
  const out = [];
  for (const uid of [...new Set(uids.filter((x) => x && UID_RE.test(String(x))))].slice(0, 200)) {
    const info = await personInfo(uid);
    if (!info) continue;
    const rows = await personRows(uid);
    if (!rows.length) continue;
    // 1.99fu: a capture taken in an Approved pad stays inside it (not in the person's story for anyone outside)
    const PA = require("./padaccess");
    await PA.init();
    const items = (await stories.clean(rows)).filter((c) => !c.room || PA.canSee(viewer, c.room));
    if (!items.length) continue;
    items.sort((a, b) => a.created - b.created);
    for (const c of items) {
      const R = c.room ? rooms.getCached(c.room) : null;
      if (c.source !== "user" && R) c.where = { title: R.title || c.room, href: require("./pads").padHref(R) };
      if (signed && viewer.userId === uid && c.source !== "user") c.hideable = true;      // "🙈 Hide from my story"
    }
    const latest = items[items.length - 1].created;
    const upto = S.get(info.id) || 0;
    const cv = [...items].reverse().find((c) => !c.nsfw && (c.kind === "photo" || (c.kind === "clip" && c.poster)));
    const base = { ...info, latest, count: items.length, unseen: latest > upto };
    if (signed) {
      try { await require("./storykeep").annotate(viewer, items); } catch (e) { console.error("[userstories] annotate:", e.message); }
      await annotate(viewer, items);
      out.push({ ...base, seen: upto, cover: cv ? (cv.kind === "photo" ? cv.src : cv.poster) : null, items: items.map(({ room: _r, ...x }) => x) });
    } else out.push({ ...base, unseen: true, cover: null });
  }
  return out;
}
/** One member's person story, or null when it's empty. */
async function personStory(viewer, uid, opts = {}) {
  return (await people(viewer, [uid], opts))[0] || null;
}
/** Uploaders of live profile-pad stories (the people who get a circle on the homepage / /feed strip). */
async function profileUploaders() {
  await init();
  const t = NOW();
  const rows = await getQuery("SELECT DISTINCT by_user_id FROM media WHERE deleted = 0 AND expires > ? AND created > ? AND source = 'user' AND room LIKE 'user:%'",
                              [t, t - WINDOW_MS]);
  return rows.map((r) => r.by_user_id).filter(Boolean);
}

/** can.del on member uploads for `viewer` (mutates). The server re-checks (stagecap.canDelete). */
async function annotate(viewer, items) {
  const mine = items.filter((c) => c.source === "user");
  if (!mine.length || !viewer || !viewer.userId) return items;
  const rows = await getQuery(`SELECT * FROM media WHERE id IN (${mine.map(() => "?").join(",")})`, mine.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of mine) {
    const r = byId.get(c.id);
    // 1.99fn: save comes from storykeep.annotate (snap / clip stories are saveable); post never
    c.can = Object.assign({}, c.can || {}, { post: false, save: !!(c.can && c.can.save) && !!r && require("./storykeep").userSaveable(r),
                                             del: !!r && (await require("./stagecap").canDelete(viewer, r).catch(() => false)) });
    c.mine = !!r && r.by_user_id === viewer.userId;
  }
  return items;
}

// ── posting a story ──
/** Where `user` may post a story: "Your profile" first, then every pad they may post in (approval pads: managers only). */
async function targets(user) {
  await init();
  const S = store();
  const u = user && user.userId ? await S.account(user.userId) : null;
  if (!u) return { refusal: "Sign in first.", pads: [] };
  const base = await S.postRefusal(u, [], { media: true });
  if (base) return { refusal: base.message, pads: [] };
  const out = [{ id: "u/" + u.username, title: "Your profile", label: "u/" + u.username, profile: true }];
  for (const c of await S.communities(u)) {
    if (!c.canPost) continue;
    if ((await S.roomSettings(c.id)).approval && !(await rooms.canManage(u, c.id))) continue;
    out.push({ id: c.id, title: c.title, label: "p/" + c.slug, slug: c.slug });
  }
  return { refusal: null, pads: out, caps: { secs: STORY_MAX_SECS, imageMb: STORY_MAX_IMAGE_MB, videoMb: STORY_MAX_VIDEO_MB, perDay: STORY_PER_DAY } };
}

async function resolvePad(u, pad) {
  const k = String(pad == null ? "" : pad).trim();
  if (!k) throw new Refuse(400, "Choose a pad or your profile.");
  if (/^(?:profile|@me|u\/.{1,64})$/i.test(k)) {
    const m = /^u\/(.{1,64})$/i.exec(k);
    if (m && lc(m[1]) !== lc(u.username)) throw new Refuse(403, `Only ${m[1]} can post a story on their profile.`);
    const R = await rooms.ensureProfile(u.userId);
    if (!R) throw new Refuse(403, "Your account can't have a profile story.");
    return R;
  }
  const R = rooms.getCached(k) || (await rooms.get(k)) || (rooms.bySlugCached ? rooms.bySlugCached(k) : null) || (await rooms.bySlug(k).catch(() => null));
  if (!R) throw new Refuse(400, "That pad isn't on PATV.");
  return R;
}

const gaps = new Map();
/** Post upload `attachment` (a ready story upload of the member's) as a 24 h story. -> {id, room, href, expires} */
async function create(user, { attachment, pad, nsfw } = {}) {
  await init();
  const S = store();
  const u = user && user.userId ? await S.account(user.userId) : null;
  if (!u) throw new Refuse(401, "Sign in first.");
  const R = await resolvePad(u, pad);
  const rid = R.id;
  // the account rules + this pad's bans and Pepe's refusals, then the pad's own who-can-post rules
  const ref = await S.postRefusal(u, [rid], { media: true });
  if (ref) throw new Refuse(ref.status, ref.message);
  const why = await S.roomPostRefusal(u, rid);
  if (why) throw new Refuse(why.status, why.message);
  if (!rooms.isProfile(rid) && (await S.roomSettings(rid)).approval && !(await rooms.canManage(u, rid))) {
    throw new Refuse(403, `${R.title || rid} approves posts first, so stories there are for its owner.`);
  }
  // the upload: mine, a finished STORY upload (picture or video), not used yet
  const aid = String(attachment || "");
  if (!/^[a-f0-9]{24}$/.test(aid)) throw new Refuse(400, "Upload a picture or a video first.");
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [aid]))[0];
  if (!a || a.owner_id !== u.userId || a.post_id) throw new Refuse(404, "That upload isn't yours or was already used.");
  if (a.state === "processing" || a.state === "uploading") throw new Refuse(409, "Still processing - wait for it to finish.");
  if (a.state !== "ready") throw new Refuse(409, a.error || "That upload didn't work - try another file.");
  if (a.purpose !== "story") throw new Refuse(400, "That upload wasn't made for a story.");
  if (a.kind !== "image" && a.kind !== "video") throw new Refuse(400, "Stories are a picture or a short video.");
  if (a.kind === "video" && !(Number(a.secs) <= STORY_MAX_SECS + 0.5)) throw new Refuse(400, `Story videos can be up to ${STORY_MAX_SECS} s.`);
  const src = fm().filePath(a.file);
  if (!src || !fs.existsSync(src)) throw new Refuse(410, "That upload's file is gone - upload it again.");
  // rate: STORY_PER_DAY a day, one every STORY_GAP_MS (staff exempt)
  const t = NOW();
  if (!isStaff(u)) {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM media WHERE source = 'user' AND by_user_id = ? AND created > ?", [u.userId, t - WINDOW_MS]))[0].n;
    if (n >= STORY_PER_DAY) throw new Refuse(429, `You can post ${STORY_PER_DAY} stories a day.`);
    const last = gaps.get(u.userId) || 0;
    if (t - last < STORY_GAP_MS) throw new Refuse(429, `Slow down - try again in ${Math.ceil((STORY_GAP_MS - (t - last)) / 1000)}s.`);
  }
  // the safety check
  let verdict;
  try {
    verdict = await SAFETY({ file: src, kind: a.kind, poster: a.poster ? fm().filePath(a.poster) : null, secs: Number(a.secs) || 0, roomId: rid, userId: u.userId });
  } catch (e) { verdict = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
  if (!verdict || verdict.ok !== true) throw new Refuse(422, (verdict && verdict.reason) || "That file can't be used.");
  // claim the upload (one story per upload, even with two clicks at once)
  const claim = await runQuery("UPDATE feed_attachments SET state = 'deleted', error = 'used for a story' WHERE id = ? AND state = 'ready' AND post_id IS NULL", [a.id]);
  if (!claim.changes) throw new Refuse(409, "That upload was already used.");
  gaps.set(u.userId, t);
  const id = crypto.randomBytes(12).toString("hex");
  const video = a.kind === "video";
  const file = id + (video ? ".mp4" : ".webp");
  const move = (from, to) => { fs.copyFileSync(from, to); try { fs.unlinkSync(from); } catch (e) { /* stays for the sweep */ } };
  try {
    move(src, path.join(media.DIR, file));
    if (video && a.poster) {
      const pf = fm().filePath(a.poster);
      if (pf && fs.existsSync(pf)) move(pf, media.posterFile(id));
    }
    fm().removeFiles([a.thumb].filter(Boolean));
    const isNsfw = verdict.nsfw === true || nsfw === true || nsfw === 1 || nsfw === "1" || nsfw === "on";
    const bytes = fs.statSync(path.join(media.DIR, file)).size;
    await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, nsfw, by_user_id)
                    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, 0, 'user', ?, ?)`,
                   [id, video ? "clip" : "photo", video ? "video/mp4" : "image/webp", file, bytes, video ? Number(a.secs) || 0 : 0,
                    String(u.displayname || u.username).slice(0, 60), rid, t, t + WINDOW_MS, isNsfw ? 1 : 0, u.userId]);
    if (video && !media.hasPoster({ id, kind: "clip" })) media.makePoster({ id, kind: "clip", file, secs: Number(a.secs) || 0 }).catch(() => {});
  } catch (e) {
    for (const f of [path.join(media.DIR, file), media.posterFile(id)]) { try { fs.unlinkSync(f); } catch (_) { /* none */ } }
    await runQuery("DELETE FROM media WHERE id = ?", [id]).catch(() => {});
    console.error("[userstories] create:", e);
    throw new Refuse(500, "That story couldn't be saved - try again.");
  }
  console.log(`[userstories] ${u.username} posted a ${video ? "video" : "picture"} story ${id} to ${rid}`);
  return { id, room: rid, href: rooms.isProfile(rid) ? "/u/" + encodeURIComponent(u.username) : require("./pads").padHref(R), expires: t + WINDOW_MS };
}

// ── routes ──
function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const json = (req, res, next) => {
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 600 && e.refuse ? e.status : 500;
    if (st === 500 && !(e && e.refuse)) console.error("[userstories]", e);
    res.status(st).json({ ok: false, error: st === 500 && !(e && e.refuse) ? "Something went wrong." : e.message });
  };
  app.get("/api/stories/targets", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await targets(req.user)), prefs: await prefs(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/mine", addUser, json, async (req, res) => {
    try { res.json({ ok: true, story: await create(req.user, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/delete", addUser, json, async (req, res) => {
    try { await require("./stagecap").remove(req.user, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/hide", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await hide(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/unhide", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await unhide(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/prefs", addUser, json, async (req, res) => {
    try { res.json({ ok: true, prefs: await setPrefs(req.user, { capturesOfMe: (req.body || {}).capturesOfMe }) }); } catch (e) { fail(res, e); }
  });
  // one member's person story (the profile ring's data when the page didn't inline it)
  app.get("/api/stories/person/:username", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to see stories." });
    try {
      const u = (await getQuery("SELECT userId FROM users WHERE lower(username) = ?", [lc(req.params.username).slice(0, 64)]))[0];
      const st = u ? await personStory(req.user, u.userId) : null;
      res.json({ ok: true, rooms: st ? [st] : [] });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, create, targets, people, personStory, personRows, profileUploaders, prefs, setPrefs, hide, unhide, isSubject,
                   annotate, setSafetyCheck, Refuse, _setClock, STORY_MAX_SECS, STORY_MAX_IMAGE_MB, STORY_MAX_VIDEO_MB, STORY_PER_DAY, STORY_GAP_MS, WINDOW_MS };
