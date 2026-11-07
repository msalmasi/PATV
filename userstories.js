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
// Story Studio (dark by default): feed_attachments.edit holds a versioned crop/trim/overlay declaration. The upload
// pipeline composes it once, then create() rechecks the destination, declared words and sticker ownership before
// claiming the result. story_text holds accessible words; story_mentions holds removable PATV account chips.
// Mentions never change a person's story, bridge identity or pad access. Only the final composed file is published.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const media = require("./media");
const rooms = require("./rooms");

const WINDOW_MS = 24 * 3600 * 1000;
const STORY_MAX_SECS = 30;
const STORY_MAX_IMAGE_MB = 10, STORY_MAX_VIDEO_MB = 60;
const STORY_PER_DAY = 20, STORY_GAP_MS = 10 * 1000;
const STORY_W = 1080, STORY_H = 1920;                  // Edited pictures and the transparent browser overlay.
const STORY_VIDEO_W = 720, STORY_VIDEO_H = 1280;        // Stored portrait H.264 output.
const STORY_SRC_MAX_SECS = 180, STORY_SRC_VIDEO_MB = 100; // Edited sources, also bounded by the feed's caps.
const OVERLAY_MAX_MB = 2;                              // A re-encoded PNG layer, counted with its source.
const OVERLAY_PER_HOUR = 30;                           // 1.99?? train3 verify: overlay uploads an hour (their own cap - feedweb)
const STORY_TEXTS_MAX = 3, STORY_TEXT_LEN = 120;         // Declared text layers; length is Unicode code points.
const STORY_STICKERS_MAX = 10;                         // Owned PATV sticker layers, not Camfrog art.
const STORY_MENTIONS_MAX = 5;                          // Removable account chips, never overlay pixels.
const CID_RE = /^[a-f0-9]{8,32}$/i;
const UID_RE = /^[A-Za-z0-9_.:\-]{1,80}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

const store = () => require("./feedstore");
const fm = () => require("./feedmedia");
const studioOn = () => !!store().config().story_studio;
const exempt = (u) => SP.can(u, "feed.limits_exempt");   // 1.99ack (siteperms.js; was isStaff)
const lc = (s) => String(s || "").trim().toLowerCase();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await media.ready;
      await store().init();
      await runQuery("CREATE TABLE IF NOT EXISTS story_prefs (user_id TEXT PRIMARY KEY, captures_of_me INTEGER NOT NULL DEFAULT 1, updated INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS story_hides (user_id TEXT NOT NULL, capture_id TEXT NOT NULL, created INTEGER, PRIMARY KEY (user_id, capture_id))");
      // storyreact site: "Let people vote, tip and reply on snaps and clips of me" (storyreact.js, D-2; default on)
      const pcols = new Set((await getQuery("PRAGMA table_info(story_prefs)")).map((c) => c.name));
      if (!pcols.has("capture_reacts")) await runQuery("ALTER TABLE story_prefs ADD COLUMN capture_reacts INTEGER NOT NULL DEFAULT 1").catch(() => {});
      const cols = new Set((await getQuery("PRAGMA table_info(feed_attachments)")).map((c) => c.name));
      if (!cols.has("purpose")) await runQuery("ALTER TABLE feed_attachments ADD COLUMN purpose TEXT").catch(() => {});
      if (!cols.has("edit")) await runQuery("ALTER TABLE feed_attachments ADD COLUMN edit TEXT").catch(() => {});
      await runQuery("CREATE TABLE IF NOT EXISTS story_text (story_id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS story_mentions (story_id TEXT NOT NULL, user_id TEXT NOT NULL, x REAL, y REAL, created INTEGER, removed_at INTEGER, PRIMARY KEY (story_id, user_id))");
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
  const r = (await getQuery("SELECT captures_of_me, capture_reacts FROM story_prefs WHERE user_id = ?", [String(userId || "")]))[0];
  return { capturesOfMe: r ? !!Number(r.captures_of_me) : true,
           captureReacts: r && r.capture_reacts != null ? !!Number(r.capture_reacts) : true };   // storyreact site (D-2)
}
const offWord = (v) => v === false || v === 0 || v === "0" || v === "off" || v === "false";
/** Change the story settings given (the others keep their value): capturesOfMe, captureReacts (storyreact site). */
async function setPrefs(user, { capturesOfMe, captureReacts } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  const cur = await prefs(user.userId);
  const a = capturesOfMe === undefined ? cur.capturesOfMe : !offWord(capturesOfMe);
  const b = captureReacts === undefined ? cur.captureReacts : !offWord(captureReacts);
  await runQuery(`INSERT INTO story_prefs (user_id, captures_of_me, capture_reacts, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET captures_of_me = excluded.captures_of_me, capture_reacts = excluded.capture_reacts,
                  updated = excluded.updated`, [user.userId, a ? 1 : 0, b ? 1 : 0, NOW()]);
  return { capturesOfMe: a, captureReacts: b };
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
// review fix: + stream, the column storyreact.hiddenIds reads to know a 🎙 mic-stage capture (parity with stories.captures: these rows
// feed hideBlocked too, though a person story never selects a mic capture today)
const SEL = "id, kind, ct, file, subject, by_user, by_user_id, room, created, expires, secs, anon, source, nsfw, slot_id, subject_login, stream";

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
  const SR = require("./storyreact");
  // storyreact site (D-3): the person circle of someone blocked either way isn't shown at all (feed config story_block_hide)
  let blockedIds = new Set(), blocksDown = false;
  if (signed && store().config().story_block_hide !== false) {
    // (no dm_blocks yet: nobody) - a lookup that fails FAILS CLOSED: only the viewer's own circle this time
    try { blockedIds = await SR.blockedWith(viewer.userId); }
    catch (e) { blocksDown = true; console.error("[userstories] people: blocks (failing closed):", e.message); }
  }
  // pass 1: each person's items this viewer may see
  const found = [];
  for (const uid of [...new Set(uids.filter((x) => x && UID_RE.test(String(x))))].slice(0, 200)) {
    if ((blocksDown || blockedIds.has(String(uid))) && String(uid) !== String(viewer.userId)) continue;
    const info = await personInfo(uid);
    if (!info) continue;
    const rows = await personRows(uid);
    if (!rows.length) continue;
    // 1.99fu: a capture taken in an Approved pad stays inside it (not in the person's story for anyone outside)
    const PA = require("./padaccess");
    await PA.init();
    // adultgate site: + a capture taken in an 18+ pad, for a viewer its 18+ gate stops (switch on; off: no difference)
    // storyreact site: + the story placement rule (storyreact.placed: on a profile pad only its owner's own uploads are stories)
    const items = (await stories.clean(rows)).filter((c) => SR.placed(c._row) && (!c.room || (PA.canSee(viewer, c.room) && PA.adultGate(viewer, c.room) === "ok")));
    if (items.length) found.push({ uid, info, items });
  }
  // storyreact site, once for every circle: what blocks hide from this viewer (D-3, the same rule as the pad strips) and
  // the reactions (it.react)
  if (signed && found.length) {
    const all = found.flatMap((f) => f.items);
    const kept = new Set((await SR.hideBlocked(viewer, all)).map((c) => c.id));
    for (const f of found) f.items = f.items.filter((c) => kept.has(c.id));
    await SR.annotate(viewer, found.flatMap((f) => f.items));
  }
  // pass 2: the circles
  const out = [];
  for (const { uid, info, items } of found) {
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
      await annotateStudio(viewer, items);
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
/** Where `user` may post a story: "Your profile" first, then every pad they may post in (approval pads: managers only).
 *  S1 Q4 (review): opts.include - the pad the story form was opened on - is offered even when it's unlisted (its own page). */
async function targets(user, { include = null } = {}) {
  await init();
  const S = store();
  const u = user && user.userId ? await S.account(user.userId) : null;
  if (!u) return { refusal: "Sign in first.", pads: [] };
  const base = await S.postRefusal(u, [], { media: true });
  if (base) return { refusal: base.message, pads: [] };
  const out = [{ id: "u/" + u.username, title: "Your profile", label: "u/" + u.username, profile: true }];
  for (const c of await S.communities(u, { include })) {
    if (!c.canPost) continue;
    if (!(await approvalAllowed(u, c.id))) continue;
    out.push({ id: c.id, title: c.title, label: "p/" + c.slug, slug: c.slug });
  }
  const answer = { refusal: null, pads: out, caps: { secs: STORY_MAX_SECS, imageMb: STORY_MAX_IMAGE_MB, videoMb: STORY_MAX_VIDEO_MB, perDay: STORY_PER_DAY } };
  if (studioOn()) {
    const PL = require("./padlook"); await PL.init();
    const person = await personInfo(u.userId);
    for (const target of out) {
      if (target.profile) target.look = { avatar: person && person.avatar || null, accent: null, ink: null };
      else {
        const L = PL.look(target.id);
        target.look = L && (L.avatar || L.banner || L.accent) ? { avatar: L.avatar, accent: L.accent, ink: L.ink } : null;
        target.href = require("./pads").padHref(rooms.getCached(target.id) || { id: target.id, slug: target.slug });
      }
    }
    const C = S.config();
    Object.assign(answer.caps, { srcSecs: Math.min(STORY_SRC_MAX_SECS, C.max_video_secs), srcVideoMb: Math.min(STORY_SRC_VIDEO_MB, C.max_video_mb),
      overlayMb: OVERLAY_MAX_MB, textsMax: STORY_TEXTS_MAX, textLen: STORY_TEXT_LEN, stickersMax: STORY_STICKERS_MAX,
      mentionsMax: STORY_MENTIONS_MAX, studio: true });
    answer.as = u.displayname || u.username;
  }
  return answer;
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
async function approvalAllowed(u, rid) {
  return rooms.isProfile(rid) || !(await store().roomSettings(rid)).approval || await rooms.canManage(u, rid);
}
/** Shared posting rules, in the existing order, used before uploading an edit and before publishing any story. */
async function postCheck(user, pad) {
  await init();
  const S = store(), u = user && user.userId ? await S.account(user.userId) : null;
  if (!u) throw new Refuse(401, "Sign in first.");
  const R = await resolvePad(u, pad), rid = R.id;
  const ref = await S.postRefusal(u, [rid], { media: true });
  if (ref) throw new Refuse(ref.status, ref.message);
  const why = await S.roomPostRefusal(u, rid);
  if (why) throw new Refuse(why.status, why.message);
  if (!(await approvalAllowed(u, rid))) throw new Refuse(403, `${R.title || rid} approves posts first, so stories there are for its owner.`);
  return { u, R };
}
async function rateCheck(u, t = NOW()) {
  if (exempt(u)) return;
  const n = (await getQuery("SELECT COUNT(*) AS n FROM media WHERE source = 'user' AND by_user_id = ? AND created > ?", [u.userId, t - WINDOW_MS]))[0].n;
  if (n >= STORY_PER_DAY) throw new Refuse(429, `You can post ${STORY_PER_DAY} stories a day.`);
  const last = gaps.get(u.userId) || 0;
  if (t - last < STORY_GAP_MS) throw new Refuse(429, `Slow down - try again in ${Math.ceil((STORY_GAP_MS - (t - last)) / 1000)}s.`);
}
async function checkWordsAndStickers(u, rid, edit, dup) {
  const verdict = await require("./feedfilter").check(u, [rid], { kind: "post", body: edit.text.join("\n"), dup });
  if (verdict && verdict.action === "block") throw new Refuse(422, verdict.message || "This pad's content filter doesn't allow those words.");
  if (verdict && verdict.action === "hide") throw new Refuse(422, "This pad's content filter doesn't allow those words in a story - change them and try again.");
  // Stories have no feed post id: flags and self-harm hits do not create a report or a care notice.
  await require("./stickers").validate(u.userId, edit.stickers.map(s => `[sticker:${s.pack}/${s.sticker}]`).join(" "));
}
/** Read-only preflight: takes neither the posting gap nor the overlay; the source processor claims the latter. */
async function preflight(user, edit) {
  if (!studioOn()) throw new Refuse(423, "Story Studio isn't switched on.");
  const { u, R } = await postCheck(user, edit.pad);
  await rateCheck(u);
  await checkWordsAndStickers(u, R.id, edit, true);
  if (edit.overlay) await require("./storycompose").overlayCheck(u.userId, edit.overlay);
  return { u, R };
}
async function cleanMentions(u, raw, rid) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > STORY_MENTIONS_MAX) throw new Refuse(400, `Choose up to ${STORY_MENTIONS_MAX} people to mention.`);
  const names = new Map();
  for (const value of raw) {
    if (!value || typeof value.username !== "string" || !value.username.trim() || value.username.length > 64 ||
        !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Refuse(400, "Choose a person and a position for each mention.");
    const name = lc(value.username);
    if (!names.has(name)) names.set(name, { name, x: Math.min(0.95, Math.max(0.05, value.x)), y: Math.min(0.95, Math.max(0.05, value.y)) });
  }
  const FM = require("./feedmentions");
  const known = new Map((await FM.accounts([...names.keys()])).map(a => [lc(a.username), a]));
  const out = [];
  for (const value of names.values()) {
    const account = known.get(value.name);
    if (!account || account.archived_at) throw new Refuse(400, `@${value.name} isn't available for a story mention.`);
    if (account.userId === u.userId) throw new Refuse(400, `You can't mention yourself (@${value.name}) in a story.`);
    if (store().isPepe(account)) throw new Refuse(400, `@${value.name} can't be mentioned in a story.`);
    // 1.99?? train3 verify: a chip only for someone who could see the story and take it off - not across a block (either way;
    // with story_block_hide on they couldn't even see the story to remove it, while everyone else saw "@them"), not on an
    // Approved pad they're outside of or an 18+ pad they haven't passed the gate of, not with their feed mentions switched off.
    // The same words as an unknown name, so the author can't tell which.
    if (!(await mentionable(u, account, rid))) throw new Refuse(400, `@${value.name} isn't available for a story mention.`);
    out.push({ userId: account.userId, x: value.x, y: value.y });
  }
  return out;
}
async function mentionable(author, account, rid) {
  const FM = require("./feedmentions"), PA = require("./padaccess");
  if (await FM.blockedEither(author.userId, account.userId)) return false;
  if (await require("./mentions").feedOff(account.userId)) return false;
  await PA.init();
  const acct = (await PA.accountLite(account.userId)) || account;
  return PA.canSee(acct, rid) && PA.adultGate(acct, rid) === "ok";
}
function editAlt(edit) {
  const cat = require("./stickers").CAT;
  return Array.from(edit.text.concat(edit.stickers.map(s => {
    const entry = cat.byId[s.pack] && cat.byId[s.pack].byId[s.sticker];
    return entry ? entry.name + " sticker" : "sticker";
  })).join(" · ")).slice(0, 300).join("");
}
/** Post upload `attachment` (a ready story upload of the member's) as a 24 h story. -> {id, room, href, expires} */
async function create(user, { attachment, pad, nsfw, mentions } = {}) {
  await init();
  const S = store();
  const { u, R } = await postCheck(user, pad);
  const rid = R.id;
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
  await rateCheck(u, t);
  const studio = studioOn();
  let edit = null;
  if (a.edit) {
    if (!studio) throw new Refuse(423, "Story Studio isn't switched on.");
    try { edit = require("./storycompose").cleanEdit(JSON.parse(a.edit), { kind: a.kind }); }
    catch (e) { if (e.refuse) throw e; throw new Refuse(400, "That story edit isn't valid."); }
    await checkWordsAndStickers(u, rid, edit, false);
  }
  const chips = studio ? await cleanMentions(u, mentions, rid) : [];
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
    if (edit) await runQuery("INSERT INTO story_text (story_id,text,created) VALUES (?,?,?)", [id, editAlt(edit), t]);
    for (const chip of chips) await runQuery("INSERT INTO story_mentions (story_id,user_id,x,y,created) VALUES (?,?,?,?,?)", [id, chip.userId, chip.x, chip.y, t]);
    if (video && !media.hasPoster({ id, kind: "clip" })) media.makePoster({ id, kind: "clip", file, secs: Number(a.secs) || 0 }).catch(() => {});
  } catch (e) {
    for (const f of [path.join(media.DIR, file), media.posterFile(id)]) { try { fs.unlinkSync(f); } catch (_) { /* none */ } }
    await runQuery("DELETE FROM media WHERE id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM story_text WHERE story_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM story_mentions WHERE story_id = ?", [id]).catch(() => {});
    console.error("[userstories] create failed:", id);
    throw new Refuse(500, "That story couldn't be saved - try again.");
  }
  await require("./storyreact").selfUp(u.userId, id);   // storyreact site: only with POLICY.autoSelfUp (D-5 alternative; off)
  console.log(`[userstories] account=${u.userId} story=${id} pad=${rid}`);
  const result = { id, room: rid, href: rooms.isProfile(rid) ? "/u/" + encodeURIComponent(u.username) : require("./pads").padHref(R), expires: t + WINDOW_MS };
  if (studio) {
    try {
      const row = (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
      await require("./feedmentions").notifyStory({ author: u, storyId: id, row, userIds: chips.map(c => c.userId), text: edit ? edit.text.join("\n") : "" });
    } catch (_) { console.error("[userstories] story notice unavailable:", id); }
    // Publishing already succeeded. A transient viewer lookup cannot turn it into a retry/duplicate post.
    let circle = null;
    try { circle = rooms.isProfile(rid) ? await personStory(user, u.userId) : (await require("./stories").forViewer(user, { room: rid }))[0] || null; }
    catch (_) { /* the editor can use its success toast without a local circle */ }
    Object.assign(result, { circle, item: circle && (circle.items || []).find(item => item.id === id) || null, scope: rid });
  }
  return result;
}

/** Adds accessible words to member stories and removable account chips only to signed-in viewers. */
async function annotateStudio(viewer, items) {
  for (const item of items) if (item.source === "user") { delete item.alt; delete item.mentions; }
  if (!studioOn()) return items;
  await init();
  const signed = !!(viewer && viewer.userId), ids = items.filter(c => c.source === "user").map(c => c.id);
  if (!ids.length) return items;
  const texts = new Map(), chips = new Map(), now = NOW();
  const cols = signed ? new Set((await getQuery("PRAGMA table_info(users)")).map(c => c.name)) : null;
  // 1.99?? train3 verify: a block made after the story went up (either way) takes the chip off for everyone
  const blocks = signed && (await getQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dm_blocks'")).length > 0;
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400), marks = part.map(() => "?").join(",");
    const rows = await getQuery(`SELECT m.id,t.text FROM media m LEFT JOIN story_text t ON t.story_id=m.id
      WHERE m.id IN (${marks}) AND m.source='user' AND m.deleted=0 AND m.expires>? AND m.created>?`, [...part, now, now - WINDOW_MS]);
    for (const row of rows) texts.set(row.id, row.text || "");
    if (signed) {
      const found = await getQuery(`SELECT sm.story_id,sm.user_id,sm.x,sm.y,u.username,u.displayname FROM story_mentions sm
        JOIN media m ON m.id=sm.story_id JOIN users u ON u.userId=sm.user_id
        WHERE sm.story_id IN (${marks}) AND sm.removed_at IS NULL AND m.source='user' AND m.deleted=0 AND m.expires>? AND m.created>?
        ${cols.has("archived_at") ? "AND COALESCE(u.archived_at,0)=0" : ""}
        ${blocks ? `AND NOT EXISTS (SELECT 1 FROM dm_blocks b WHERE (b.blocker_id=sm.user_id AND b.blocked_id=m.by_user_id)
                                                            OR (b.blocker_id=m.by_user_id AND b.blocked_id=sm.user_id))` : ""}`, [...part, now, now - WINDOW_MS]);
      for (const row of found) {
        if (!chips.has(row.story_id)) chips.set(row.story_id, []);
        chips.get(row.story_id).push({ u: row.username, d: row.displayname || null, x: row.x, y: row.y, mine: row.user_id === viewer.userId });
      }
    }
  }
  for (const item of items) if (texts.has(item.id)) {
    item.alt = texts.get(item.id);
    if (signed) item.mentions = chips.get(item.id) || [];
  }
  return items;
}
async function unmention(user, id) {
  const SR = require("./storyreact");
  if (!studioOn()) throw new Refuse(423, "Story Studio isn't switched on.");
  await init();
  // 1.99?? train3 verify: the person named acts on THEIR mention row - seeing the story isn't needed (a block, a pad they left,
  // the 18+ gate hid it from them and the chip stayed for everyone else). A row is theirs only; nothing else is revealed.
  const sid = String(id || "");
  if (!user || !user.userId || !/^[a-f0-9]{24}$/.test(sid)) throw new Refuse(404, SR.GONE);
  const mine = (await getQuery("SELECT removed_at FROM story_mentions WHERE story_id=? AND user_id=?", [sid, user.userId]))[0];
  if (!mine) throw new Refuse(404, SR.GONE);
  const r = await runQuery("UPDATE story_mentions SET removed_at=? WHERE story_id=? AND user_id=? AND removed_at IS NULL", [NOW(), sid, user.userId]);
  return { removed: !!r.changes };
}
async function sweep() {
  await init();
  const cut = NOW() - WINDOW_MS - 7 * 86400e3, result = {};
  for (const table of ["story_mentions", "story_text"]) {
    const r = await runQuery(`DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id=${table}.story_id AND m.deleted=0 AND m.created>?)`, [cut]);
    result[table] = r.changes || 0;
  }
  return result;
}

// ── routes ──
function register(app, { addUser, noTimers = false }) {
  app.locals.storyStudioOn = studioOn;
  if (!noTimers) { const timer = setInterval(() => sweep().catch(() => {}), 3600e3); if (timer.unref) timer.unref(); }
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
    const pad = typeof req.query.pad === "string" ? req.query.pad.slice(0, 128) : null;     // the pad the form was opened on
    try { res.json({ ok: true, ...(await targets(req.user, { include: pad })), prefs: await prefs(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/mine", addUser, json, async (req, res) => {
    try { res.json({ ok: true, story: await create(req.user, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/delete", addUser, json, async (req, res) => {
    try { await require("./stagecap").remove(req.user, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/unmention", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await unmention(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/hide", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await hide(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/unhide", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await unhide(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/prefs", addUser, json, async (req, res) => {
    // storyreact site: + captureReacts; a setting left out of the body keeps its value
    const b = req.body || {};
    try { res.json({ ok: true, prefs: await setPrefs(req.user, { capturesOfMe: b.capturesOfMe, captureReacts: b.captureReacts }) }); } catch (e) { fail(res, e); }
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

module.exports = { init, register, create, targets, people, personStory, personRows, profileUploaders, prefs, setPrefs, hide, unhide, isSubject, isPrivate,
                   annotate, annotateStudio, preflight, postCheck, rateCheck, unmention, sweep, studioOn, setSafetyCheck, Refuse, _setClock,
                   STORY_MAX_SECS, STORY_MAX_IMAGE_MB, STORY_MAX_VIDEO_MB, STORY_PER_DAY, STORY_GAP_MS, WINDOW_MS,
                   STORY_W, STORY_H, STORY_VIDEO_W, STORY_VIDEO_H, STORY_SRC_MAX_SECS, STORY_SRC_VIDEO_MB, OVERLAY_MAX_MB, OVERLAY_PER_HOUR,
                   STORY_TEXTS_MAX, STORY_TEXT_LEN, STORY_STICKERS_MAX, STORY_MENTIONS_MAX };
