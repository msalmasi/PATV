// storykeep.js — keeping story captures past their 24 hours (1.99eq).
//
// Two actions in the story viewer (public/js/stories.js):
//   📌 Post to pad  the capture becomes a permanent feed post in its pad, credited to the person who took it
//                   (their PATV account: a stage capture's by_user_id, a cam capture's linked Camfrog login; nobody
//                   linked -> the poster). The poster may add a caption. The post shows "📸 Captured from <room>" and
//                   links the subject's profile when their Camfrog name is linked (feedstore.decorate -> forPosts).
//                   NSFW carries over (a stage slot marked NSFW).
//   🔖 Save         a private per-member "Saved" collection (/u/<me>/saved - only its owner ever sees it).
//
// Media persistence: neither depends on the 24 h file. Post-to-pad makes a COPY of the capture as an ordinary post
// attachment (feed_attachments, files in the feed directory, served by /media/f/<file> under the post's own rules;
// purged deleted_purge_days after the post is deleted, like any post). Save makes ONE copy per capture
// (story_keeps), shared by everyone who saved it and deleted with the last save; served only at /media/s/<file>
// to members who saved it. Pictures are re-encoded (feedmedia.processImage: webp + thumbnail, no metadata); clips
// and audio are Pepe's / stagecap's own server-made mp4 / m4a, copied as they are (+ the clip's poster frame).
//
// Consent (approved rules, all checked here, server side):
//   * Post to pad: only the capturer, the pad's owner, the pad's mods (Camfrog mod powers in the pad's room, as Pepe
//     reports them - padmod.capsFor) or site staff. Save: any signed-in member (stories are members-only).
//   * Captures whose subject (or capturer) is private can never be posted or saved: media.anon (!incognito /
//     !bridge hide), an anonymous capturer ("someone"), or a linked account that hides its Analytics / Rooms panel
//     (stories.privateLogins; stage captures: the streamer's and capturer's accounts, same rule).
//   * Removed or expired captures (deleted, past expires, file gone) can't be posted or saved.
//   * The person on cam (the subject: their account, or their linked Camfrog login) sees "Remove me" on a post of
//     themselves: one click soft-deletes it (deleted_by "subject") and tells the poster (and the credited author).
//   * A capture taken down before it expired (Pepe's !snap delete, a stage capture deleted by staff / the pad owner /
//     the streamer) or later marked private (Pepe's /api/media/anon) takes every Saved copy with it at once
//     (onCaptureRemoved). Posts made from it are hidden too, unless the capturer deleted their own capture.
//   * Every action is idempotent: posting twice returns the same post, saving twice / unsaving twice is a no-op.
//   * 1.99fn: members' own stories (userstories.js, media.source "user") can be 🔖 SAVED by any signed-in member when
//     they're a snap or a clip - media.kind "photo" (a picture story) or "clip" (a video story); see SAVE_USER_KINDS.
//     Same private collection, same one-copy persistence. The uploader deleting the story, or a pad owner / mod /
//     staff removing it (stagecap.remove), drops every saved copy (onCaptureRemoved), exactly like a capture.
//     📌 Post to pad stays closed for them (a member's story is never re-posted by anyone).
//
// Data
//   story_posts  capture_id (PK: one permanent post per capture), post_id, room_id, author_id (credited),
//                posted_by (the actor), subject_user_id, subject_login, subject_name, room_title, kind, source,
//                created, removed_at, removed_by, removed_reason
//   story_keeps  capture_id (PK), kind, ct, file, thumb, poster, w, h, secs, bytes, created, purged_at, purge_reason
//   story_saves  user_id + capture_id (PK), created, kind, room_id, room_title, subject, by_name, source, nsfw, captured
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const media = require("./media");
const fm = require("./feedmedia");
const rooms = require("./rooms");

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }
const CID_RE = /^[a-f0-9]{8,32}$/i;
const POST_RE = /^[A-Za-z0-9]{8,16}$/;
const CAPTION_MAX = 140;
// 1.99fn: the kinds of a member's own story (source "user") that may be 🔖 saved: snaps (picture stories, kind "photo")
// and clips (video stories, kind "clip"). Anything else from a member (there's no audio story today) stays unsaveable.
const SAVE_USER_KINDS = new Set(["photo", "clip"]);
const userSaveable = (r) => !!r && r.source === "user" && SAVE_USER_KINDS.has(r.kind);

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await media.ready;
      await runQuery(`CREATE TABLE IF NOT EXISTS story_posts (
        capture_id TEXT PRIMARY KEY, post_id TEXT, room_id TEXT, author_id TEXT, posted_by TEXT, subject_user_id TEXT, subject_login TEXT,
        subject_name TEXT, room_title TEXT, kind TEXT, source TEXT, created INTEGER, removed_at INTEGER, removed_by TEXT, removed_reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_posts_post ON story_posts (post_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS story_keeps (
        capture_id TEXT PRIMARY KEY, kind TEXT, ct TEXT, file TEXT, thumb TEXT, poster TEXT, w INTEGER, h INTEGER, secs REAL, bytes INTEGER,
        created INTEGER, purged_at INTEGER, purge_reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_keeps_file ON story_keeps (file)");
      await runQuery(`CREATE TABLE IF NOT EXISTS story_saves (
        user_id TEXT NOT NULL, capture_id TEXT NOT NULL, created INTEGER, kind TEXT, room_id TEXT, room_title TEXT, subject TEXT, by_name TEXT,
        source TEXT, nsfw INTEGER NOT NULL DEFAULT 0, captured INTEGER, PRIMARY KEY (user_id, capture_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_saves_capture ON story_saves (capture_id)");
    })().catch((e) => { console.error("[storykeep] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

const store = () => require("./feedstore");
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const lc = (s) => String(s || "").trim().toLowerCase();

// ── pad mods: Camfrog mod powers in the pad's room, as Pepe reports them for watching linked logins (padmod.js) ──
const defaultModCheck = (acct, roomId) => {
  if (!acct || !acct.camfrogUsername) return false;
  try {
    const B = require("./bridge");
    const R = B._rooms && B._rooms.get ? B._rooms.get(roomId) : null;
    return !!require("./padmod").capsFor(R, acct.camfrogUsername);
  } catch (e) { return false; }
};
let modCheck = defaultModCheck;
function _setModCheck(fn) { modCheck = fn || defaultModCheck; }

// ── capture rows ──
async function captureRow(id) {
  if (!CID_RE.test(String(id || ""))) return null;
  await init();
  return (await getQuery("SELECT * FROM media WHERE id = ?", [String(id)]))[0] || null;
}
/** null when the capture is still here (not deleted, not expired, its file on disk), else why not. */
function goneWhy(row) {
  if (!row) return "No such capture.";
  if (Number(row.deleted)) return "That capture was removed.";
  if (!(Number(row.expires) > NOW())) return "That capture has expired.";
  if (!media.fileExists(row)) return "That capture's file is gone.";
  return null;
}

/** Accounts (userId set) whose layout hides Analytics or Rooms - the stories privacy rule, by account id. */
async function hiddenUsers(ids) {
  const out = new Set();
  const pl = require("./profilelayout");
  for (const id of [...new Set(ids.filter(Boolean))]) {
    let hidden;
    try {
      const L = await pl.get(id);
      hidden = pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden";
    } catch (e) { hidden = true; }          // can't read their choice: fail closed
    if (hidden) out.add(id);
  }
  return out;
}
async function slotUser(slotId) {
  if (!slotId) return null;
  try { const s = await require("./mainstage").getSlot(String(slotId)); return s && s.userId ? s.userId : null; } catch (e) { return null; }
}

/** Privacy for many capture rows at once -> Map id -> reason (only blocked ones are in it). */
async function privacyBlocks(rows) {
  const out = new Map();
  const logins = [], uids = [], slots = new Map();
  for (const r of rows) {
    if (r.source === "user") continue;
    if (r.source === "stage") {
      if (r.by_user_id) uids.push(r.by_user_id);
      const su = await slotUser(r.slot_id);
      slots.set(r.id, su);
      if (su) uids.push(su);
    } else logins.push(r.subject, r.by_user);
  }
  const priv = await require("./stories").privateLogins(logins);
  const hid = await hiddenUsers(uids);
  for (const r of rows) {
    const by = String(r.by_user || "").trim();
    // 1.99ez: a member's own story upload (userstories.js) is theirs; 1.99fn: a snap / clip story may be SAVED (never
    // posted - postToPad refuses source "user" on its own), anything else can't be kept
    if (r.source === "user") { if (!userSaveable(r)) out.set(r.id, "This is someone's own story, so it can't be kept."); continue; }
    if (Number(r.anon)) out.set(r.id, "The person in this capture is private (incognito or hidden), so it can't be kept.");
    else if (!by || lc(by) === "someone") out.set(r.id, "This capture was taken privately, so it can't be kept.");
    else if (r.source === "stage") {
      if ((r.by_user_id && hid.has(r.by_user_id)) || (slots.get(r.id) && hid.has(slots.get(r.id)))) out.set(r.id, "Someone in this capture keeps their activity private, so it can't be kept.");
    } else if (priv.has(lc(r.subject)) || priv.has(lc(r.by_user))) out.set(r.id, "Someone in this capture keeps their activity private, so it can't be kept.");
  }
  return out;
}

async function accountOf(user) {
  if (!user || !user.userId) return null;
  return store().account(user.userId);
}
async function userByLogin(login) {
  const l = lc(login);
  if (!/^[\w.\-]{1,40}$/.test(l)) return null;
  return (await getQuery("SELECT userId, username, displayname FROM users WHERE lower(camfrogUsername) = ? LIMIT 1", [l]))[0] || null;
}
async function userById(id) {
  if (!id) return null;
  return (await getQuery("SELECT userId, username, displayname FROM users WHERE userId = ?", [id]))[0] || null;
}
/** The capture's subject: {userId|null, login|null, name}. Cam: the Camfrog login; stage: the slot's streamer. */
async function subjectOf(row) {
  if (row.source === "stage") {
    const uid = await slotUser(row.slot_id);
    return { userId: uid, login: null, name: String(row.subject || "").slice(0, 60) || null };
  }
  const login = lc(row.subject) || null;
  const u = login ? await userByLogin(login) : null;
  return { userId: u ? u.userId : null, login, name: String(row.subject || "").slice(0, 60) || null };
}
/** The capturer's PATV account id, or null (cam: their linked login; stage: by_user_id). */
async function capturerId(row) {
  if (row.source === "stage") return row.by_user_id || null;
  const u = await userByLogin(row.by_user);
  return u ? u.userId : null;
}
function isCapturer(acct, row) {
  if (!acct) return false;
  if (row.source === "stage") return !!row.by_user_id && row.by_user_id === acct.userId;
  return !!acct.camfrogUsername && lc(acct.camfrogUsername) === lc(row.by_user);
}
/** May `acct` post `row` to its pad? (permission only - privacy / gone are separate) */
async function mayPost(acct, row) {
  if (!acct) return false;
  if (isStaff(acct) || isCapturer(acct, row)) return true;
  if (row.room && (await rooms.canManage(acct, row.room))) return true;
  return !!(row.room && modCheck(acct, row.room));
}

// ── copying the media ──
function feedSub(name) { const d = path.join(fm.dir(), name.slice(0, 2)); fs.mkdirSync(d, { recursive: true }); return path.join(d, name); }
/** Copy a capture's media into the feed directory (never the 24 h file itself). -> {kind, ct, file, thumb, poster, w, h, secs, bytes} */
const defaultPersist = async (row) => {
  const src = path.join(media.DIR, row.file);
  if (row.kind === "photo") {
    const head = Buffer.alloc(64);
    const fd = fs.openSync(src, "r");
    try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
    const sn = fm.sniff(head);
    if (sn.bad || sn.kind !== "image") throw new Refuse(422, "That capture's picture couldn't be read.");
    const out = await fm.processImage(src, sn.fmt);
    return { kind: "image", ct: out.ct, file: out.file, thumb: out.thumb, poster: null, w: out.w, h: out.h, secs: 0, bytes: out.bytes };
  }
  const base = crypto.randomBytes(16).toString("hex");
  const clip = row.kind === "clip";
  const file = base + (clip ? ".mp4" : ".m4a");
  fs.copyFileSync(src, feedSub(file));
  let poster = null, bytes = fs.statSync(feedSub(file)).size;
  const pf = clip ? media.posterFile(row.id) : null;
  if (pf && fs.existsSync(pf)) {
    poster = base + "_p.webp";
    fs.copyFileSync(pf, feedSub(poster));
    bytes += fs.statSync(feedSub(poster)).size;
  }
  return { kind: clip ? "video" : "audio", ct: clip ? "video/mp4" : "audio/mp4", file, thumb: null, poster, w: 0, h: 0, secs: Number(row.secs) || 0, bytes };
};
let persistImpl = defaultPersist;
function _setPersistImpl(fn) { persistImpl = fn || defaultPersist; }
function dropFiles(k) { if (k) fm.removeFiles([k.file, k.thumb, k.poster].filter(Boolean)); }
function roomFull(bytes) {
  const C = store().config();
  return fm.diskFreeBytes() - bytes * 2 < C.min_free_gb * 1024 ** 3;
}

// ── 📌 Post to pad ──
const KIND_NOUN = { photo: "Snap", clip: "Clip", audio: "Audio clip" };
/**
 * Post capture `captureId` to its pad. -> {post: {id, url}, again: bool}. Idempotent: a capture has at most one
 * permanent post; asking again returns it.
 */
async function postToPad(user, captureId, { caption = "" } = {}) {
  await init();
  const acct = await accountOf(user);
  if (!acct) throw new Refuse(401, "Sign in first.");
  const row = await captureRow(captureId);
  if (!row) throw new Refuse(404, "No such capture.");
  // 1.99ez / 1.99fn: a member's own story is never posted to a pad (only saved, when it's a snap / clip)
  if (row.source === "user") throw new Refuse(403, "This is someone's own story, so it can't be posted to a pad.");
  if (!(await mayPost(acct, row))) throw new Refuse(403, "Only the person who took this capture, the pad's owner or mods, or an admin can post it.");
  const R = row.room ? rooms.getCached(row.room) || (await rooms.get(row.room)) : null;
  if (!R) throw new Refuse(409, "This capture's room has no pad to post it in.");
  // the existing post (idempotent) - before the gone check, so a retry after expiry still gets its answer
  let prev = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [row.id]))[0];
  if (prev && !prev.post_id && NOW() - Number(prev.created || 0) > 5 * 60e3) {         // a claim left by a crash: retry
    await runQuery("DELETE FROM story_posts WHERE capture_id = ? AND post_id IS NULL", [row.id]);
    prev = null;
  }
  if (prev) return existing(prev, acct);
  const gone = goneWhy(row);
  if (gone) throw new Refuse(410, gone);
  const block = (await privacyBlocks([row])).get(row.id);
  if (block) throw new Refuse(403, block);
  // the claim (one post per capture, even with two clicks at once)
  const t = NOW();
  const claim = await runQuery("INSERT OR IGNORE INTO story_posts (capture_id, room_id, posted_by, created, kind, source) VALUES (?, ?, ?, ?, ?, ?)",
                               [row.id, R.id, acct.userId, t, row.kind, row.source || "cam"]);
  if (!claim.changes) return existing((await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [row.id]))[0], acct);
  let att = null, made = null;
  try {
    const authorId = (await capturerId(row)) || acct.userId;
    const subj = await subjectOf(row);
    const k = await persistImpl(row);
    if (roomFull(k.bytes)) { dropFiles(k); throw new Refuse(507, "The feed's storage is full right now."); }
    att = crypto.randomBytes(12).toString("hex");
    await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, secs, bytes, state, created, size_declared, received)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
                   [att, authorId, k.kind, k.ct, k.file, k.thumb, k.poster, k.w || 0, k.h || 0, k.secs || 0, k.bytes || 0, t, k.bytes || 0, k.bytes || 0]);
    const S = store();
    const cap = S.cleanLine(caption, CAPTION_MAX);
    const what = row.source === "stage" ? (row.kind === "clip" ? "Stage clip" : "Stage snap") : KIND_NOUN[row.kind] || "Capture";
    const title = cap || `${what}${subj.name ? " of " + subj.name : ""} in ${R.title || R.id}`.slice(0, CAPTION_MAX);
    made = await S.create(authorId, { title, community: R.id, attachments: [att], nsfw: !!Number(row.nsfw), announce: [] },
                          { free: true, onBehalf: authorId !== acct.userId || isStaff(acct) || (await rooms.canManage(acct, R.id)) });
    await runQuery(`UPDATE story_posts SET post_id = ?, author_id = ?, subject_user_id = ?, subject_login = ?, subject_name = ?, room_title = ? WHERE capture_id = ?`,
                   [made.id, authorId, subj.userId, subj.login, subj.name, R.title || R.id, row.id]);
    // the person on cam hears about it (with the way out) - unless they posted it themselves
    if (subj.userId && subj.userId !== acct.userId) {
      await S.notify(subj.userId, { kind: "feed", title: "A capture of you was posted",
        body: `${acct.displayname || acct.username} posted a ${what.toLowerCase()} of you to ${R.title || R.id}. Not OK? Open it and tap "Remove me".`,
        link: made.url, ref: "story-post:" + made.id });
    }
    console.log(`[storykeep] capture ${row.id} -> post ${made.id} in ${R.id} by ${acct.username} (credited ${authorId})`);
    return { post: { id: made.id, url: made.url }, again: false };
  } catch (e) {
    await runQuery("DELETE FROM story_posts WHERE capture_id = ? AND post_id IS NULL", [row.id]).catch(() => {});
    if (att && !made) {
      const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [att]))[0];
      if (a && !a.post_id) { dropFiles(a); await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ?", [att]).catch(() => {}); }
    }
    throw e;
  }
}
async function existing(sp, acct) {
  if (!sp) throw new Refuse(409, "Try again in a moment.");
  if (!sp.post_id) throw new Refuse(409, "It's being posted right now.");
  if (sp.removed_at) throw new Refuse(409, sp.removed_by === "subject" ? "The person in this capture removed its post, so it can't be posted again." : "This capture's post was removed.");
  const p = await store().get(sp.post_id, acct, { _inner: true });
  if (!p || p.deleted) throw new Refuse(409, "This capture's post was deleted.");
  return { post: { id: p.id, url: p.url }, again: true };
}

// ── "Remove me" (the subject) ──
function subjectMatches(acct, sp) {
  if (!acct || !sp) return false;
  if (sp.subject_user_id && sp.subject_user_id === acct.userId) return true;
  return !!(sp.subject_login && acct.camfrogUsername && lc(acct.camfrogUsername) === sp.subject_login);
}
/** The subject hides the post of themselves (soft delete) and the poster is told. Idempotent. */
async function removeMe(user, postId) {
  await init();
  const acct = await accountOf(user);
  if (!acct) throw new Refuse(401, "Sign in first.");
  if (!POST_RE.test(String(postId || ""))) throw new Refuse(404, "No such post.");
  const sp = (await getQuery("SELECT * FROM story_posts WHERE post_id = ?", [String(postId)]))[0];
  if (!sp || !subjectMatches(acct, sp)) throw new Refuse(403, "Only the person in this capture can remove it.");
  if (sp.removed_at) return { removed: true, again: true };
  const t = NOW();
  await runQuery(`UPDATE feed_posts SET deleted_at = ?, deleted_by = 'subject', delete_reason = 'removed by the person in it' WHERE id = ? AND deleted_at IS NULL`, [t, sp.post_id]);
  await runQuery("UPDATE story_posts SET removed_at = ?, removed_by = 'subject', removed_reason = 'remove-me' WHERE capture_id = ? AND removed_at IS NULL", [t, sp.capture_id]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [sp.post_id]).catch(() => {});
  const tell = [...new Set([sp.posted_by, sp.author_id].filter((x) => x && x !== acct.userId))];
  for (const uid of tell) {
    await store().notify(uid, { kind: "feed", title: "A capture you posted was removed",
      body: `${acct.displayname || acct.username} is in it and removed the post${sp.room_title ? " in " + sp.room_title : ""}.`, link: "/feed", ref: "story-rm:" + sp.post_id });
  }
  console.log(`[storykeep] post ${sp.post_id} removed by its subject ${acct.username}`);
  return { removed: true, again: false };
}

/** Provenance for decorated posts -> Map post_id -> {room, kind, source, subjectName, subject: {username}|null, canRemoveMe}. */
async function forPosts(ids, viewer) {
  if (!ids || !ids.length) return new Map();
  await init();
  const rows = await getQuery(`SELECT * FROM story_posts WHERE post_id IN (${ids.map(() => "?").join(",")})`, ids);
  const out = new Map();
  if (!rows.length) return out;
  let acct = viewer && viewer.userId ? viewer : null;
  if (acct && acct.camfrogUsername === undefined) acct = await accountOf(acct);
  for (const r of rows) {
    // the subject's profile: their account if posted with one, else (linked later) by login
    let su = r.subject_user_id ? await userById(r.subject_user_id) : null;
    if (!su && r.subject_login) su = await userByLogin(r.subject_login);
    const R = rooms.getCached(r.room_id);
    out.set(r.post_id, {
      room: { id: r.room_id, title: (R && R.title) || r.room_title || r.room_id, href: R ? require("./pads").padHref(R) : null },
      kind: r.kind, source: r.source, subjectName: r.subject_name || null,
      subject: su ? { username: su.username, display: su.displayname || su.username } : null,
      canRemoveMe: !r.removed_at && subjectMatches(acct, r),
    });
  }
  return out;
}

// ── 🔖 Save ──
const keepPending = new Map();
async function ensureKeep(row) {
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [row.id]))[0];
  if (k && !k.purged_at) return k;
  if (keepPending.has(row.id)) return keepPending.get(row.id);
  const p = (async () => {
    const f = await persistImpl(row);
    if (roomFull(f.bytes)) { dropFiles(f); throw new Refuse(507, "Storage is full right now."); }
    await runQuery(`INSERT INTO story_keeps (capture_id, kind, ct, file, thumb, poster, w, h, secs, bytes, created, purged_at, purge_reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    ON CONFLICT(capture_id) DO UPDATE SET kind = excluded.kind, ct = excluded.ct, file = excluded.file, thumb = excluded.thumb,
                      poster = excluded.poster, w = excluded.w, h = excluded.h, secs = excluded.secs, bytes = excluded.bytes, created = excluded.created,
                      purged_at = NULL, purge_reason = NULL`,
                   [row.id, f.kind, f.ct, f.file, f.thumb, f.poster, f.w || 0, f.h || 0, f.secs || 0, f.bytes || 0, NOW()]);
    return (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [row.id]))[0];
  })().finally(() => keepPending.delete(row.id));
  keepPending.set(row.id, p);
  return p;
}
/** Save a capture to the member's private collection. Idempotent. -> {saved: true, again} */
async function save(user, captureId) {
  await init();
  const acct = await accountOf(user);
  if (!acct) throw new Refuse(401, "Sign in first.");
  const row = await captureRow(captureId);
  if (!row) throw new Refuse(404, "No such capture.");
  const have = (await getQuery("SELECT 1 FROM story_saves WHERE user_id = ? AND capture_id = ?", [acct.userId, row.id]))[0];
  if (have) return { saved: true, again: true };
  const gone = goneWhy(row);
  if (gone) throw new Refuse(410, gone);
  const block = (await privacyBlocks([row])).get(row.id);
  if (block) throw new Refuse(403, block);
  await ensureKeep(row);
  const R = row.room ? rooms.getCached(row.room) : null;
  await runQuery(`INSERT OR IGNORE INTO story_saves (user_id, capture_id, created, kind, room_id, room_title, subject, by_name, source, nsfw, captured)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [acct.userId, row.id, NOW(), row.kind, row.room || null, R ? R.title : row.room || null, String(row.subject || "").slice(0, 60) || null,
                  String(row.by_user || "").slice(0, 60) || null, row.source === "stage" ? "stage" : row.source === "user" ? "user" : "cam",
                  Number(row.nsfw) ? 1 : 0, Number(row.created) || null]);
  return { saved: true, again: false };
}
async function purgeKeep(captureId, reason) {
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ? AND purged_at IS NULL", [captureId]))[0];
  if (!k) return false;
  dropFiles(k);
  await runQuery("UPDATE story_keeps SET purged_at = ?, purge_reason = ? WHERE capture_id = ?", [NOW(), reason || null, captureId]);
  return true;
}
/** Take it out of the collection; the copy goes with the last save. Idempotent. */
async function unsave(user, captureId) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const id = String(captureId || "");
  if (!CID_RE.test(id)) throw new Refuse(404, "No such capture.");
  const r = await runQuery("DELETE FROM story_saves WHERE user_id = ? AND capture_id = ?", [user.userId, id]);
  const left = (await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [id]))[0].n;
  if (!left) await purgeKeep(id, "unsaved");
  return { saved: false, again: !r.changes };
}
const sUrl = (f) => (f && fm.FILE_RE.test(f) ? "/media/s/" + f : null);
/** The member's saved captures, newest first (only ever their own). A capture since marked private goes now. */
async function savedFor(user, { limit = 200 } = {}) {
  await init();
  if (!user || !user.userId) return [];
  const rows = await getQuery(`SELECT s.*, k.kind AS kkind, k.file, k.thumb, k.poster, k.w, k.h, k.secs, m.anon AS m_anon FROM story_saves s
                               JOIN story_keeps k ON k.capture_id = s.capture_id AND k.purged_at IS NULL
                               LEFT JOIN media m ON m.id = s.capture_id
                               WHERE s.user_id = ? ORDER BY s.created DESC LIMIT ?`, [user.userId, Math.min(500, limit)]);
  const out = [];
  for (const r of rows) {
    if (Number(r.m_anon)) { await onCaptureRemoved(r.capture_id, { reason: "private" }); continue; }
    const R = r.room_id ? rooms.getCached(r.room_id) : null;
    out.push({ id: r.capture_id, kind: r.kind, mediaKind: r.kkind, src: sUrl(r.file), thumb: sUrl(r.thumb) || sUrl(r.poster), poster: sUrl(r.poster), w: r.w, h: r.h, secs: r.secs,
               room: { id: r.room_id, title: (R && R.title) || r.room_title || r.room_id, href: R ? require("./pads").padHref(R) : null },
               subject: r.subject || null, by: r.by_name || null, source: r.source, nsfw: !!r.nsfw, captured: r.captured, saved: r.created });
  }
  return out;
}

/**
 * A capture was taken down before it expired, or marked private: every Saved copy goes now, and (unless the
 * capturer deleted their own capture) a post made from it is hidden. Expiry never calls this.
 */
async function onCaptureRemoved(captureId, { reason = "removed", byCapturer = false } = {}) {
  await init();
  const id = String(captureId || "");
  if (!CID_RE.test(id)) return { saves: 0, post: false };
  const del = await runQuery("DELETE FROM story_saves WHERE capture_id = ?", [id]);
  await purgeKeep(id, reason);
  let post = false;
  if (!byCapturer) {
    const sp = (await getQuery("SELECT * FROM story_posts WHERE capture_id = ? AND post_id IS NOT NULL AND removed_at IS NULL", [id]))[0];
    if (sp) {
      const t = NOW();
      await runQuery(`UPDATE feed_posts SET deleted_at = ?, deleted_by = 'capture', delete_reason = ? WHERE id = ? AND deleted_at IS NULL`,
                     [t, reason === "private" ? "the person in it went private" : "the capture was taken down", sp.post_id]);
      await runQuery("UPDATE story_posts SET removed_at = ?, removed_by = 'capture', removed_reason = ? WHERE capture_id = ?", [t, reason, id]);
      post = true;
    }
  }
  if (del.changes || post) console.log(`[storykeep] capture ${id} ${reason}: ${del.changes} save(s) dropped${post ? ", its post hidden" : ""}`);
  return { saves: del.changes, post };
}

/** Story viewer flags for `viewer` on forViewer items: can.post / can.save, saved, posted (url). Mutates + returns items. */
async function annotate(viewer, items) {
  if (!items.length || !viewer || !viewer.userId) return items;
  await init();
  const acct = await accountOf(viewer);
  if (!acct) return items;
  const ids = items.map((c) => c.id);
  const q = ids.map(() => "?").join(",");
  const [rows, saves, posts] = await Promise.all([
    getQuery(`SELECT * FROM media WHERE id IN (${q})`, ids),
    getQuery(`SELECT capture_id FROM story_saves WHERE user_id = ? AND capture_id IN (${q})`, [acct.userId, ids].flat()),
    getQuery(`SELECT capture_id, post_id, removed_at FROM story_posts WHERE capture_id IN (${q})`, ids),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const blocks = await privacyBlocks(rows);
  const saved = new Set(saves.map((s) => s.capture_id));
  const postMap = new Map(posts.map((p) => [p.capture_id, p]));
  const links = await store().postLinks(posts.filter((p) => p.post_id && !p.removed_at).map((p) => p.post_id));
  const canMap = new Map();
  for (const c of items) {
    const r = byId.get(c.id);
    if (!r) { c.can = { post: false, save: false }; continue; }
    const priv = blocks.has(r.id);
    const live = !goneWhy(r);
    const sp = postMap.get(r.id);
    const key = r.room + "|" + (isCapturer(acct, r) ? "c" : "");
    if (!canMap.has(key)) canMap.set(key, await mayPost(acct, r));
    const hasPad = !!(r.room && rooms.getCached(r.room));
    c.saved = saved.has(r.id);
    c.posted = sp && sp.post_id && !sp.removed_at ? links.get(sp.post_id) || null : null;
    c.can = { post: r.source !== "user" && !priv && live && hasPad && !(sp && sp.removed_at) && canMap.get(key), save: !priv && live };
    if (priv) c.private = true;
  }
  return items;
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
    if (st === 500) console.error("[storykeep]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  app.post("/api/stories/:id/post", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await postToPad(req.user, req.params.id, { caption: (req.body || {}).caption })) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/save", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await save(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/unsave", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await unsave(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/posts/:id/remove-me", addUser, json, async (req, res) => {
    try { res.json({ ok: true, ...(await removeMe(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/stories/saved", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, items: await savedFor(req.user) }); } catch (e) { fail(res, e); }
  });
  // a saved copy's file: only for members who saved it (never public, never cached by shared caches)
  app.get("/media/s/:file", addUser, async (req, res) => {
    const name = String(req.params.file || "");
    const p = fm.filePath(name);
    res.set("X-Robots-Tag", "noindex");
    if (!p || !req.user || !req.user.userId) return res.status(404).end();
    try {
      await init();
      const k = (await getQuery("SELECT * FROM story_keeps WHERE (file = ? OR thumb = ? OR poster = ?) AND purged_at IS NULL LIMIT 1", [name, name, name]))[0];
      if (!k) return res.status(404).end();
      const mine = (await getQuery("SELECT 1 FROM story_saves WHERE user_id = ? AND capture_id = ?", [req.user.userId, k.capture_id]))[0];
      if (!mine) return res.status(404).end();
      const ct = name.endsWith(".webp") ? "image/webp" : name.endsWith(".m4a") ? "audio/mp4" : "video/mp4";
      res.set({ "Content-Type": ct, "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="patv-saved-${k.capture_id}.${name.split(".").pop()}"`,
                "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
                "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "private, max-age=600" });
      res.sendFile(p, { acceptRanges: true, headers: { "Content-Type": ct } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[storykeep] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  // /u/<me>/saved - the owner's page; anyone else (or signed out) gets the profile's 404 / sign-in
  app.get("/u/:username/saved", addUser, async (req, res) => {
    const name = String(req.params.username || "");
    res.set("X-Robots-Tag", "noindex");
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.redirect(302, "/login?next=" + encodeURIComponent("/u/" + name + "/saved"));
    if (lc(req.user.username) !== lc(name)) {
      return res.status(404).render("notFound", { user: req.user.username, heading: "Nothing here", message: "Saved captures are private to their owner.", title: "Not found" });
    }
    try {
      const items = await savedFor(req.user);
      res.render("saved", { user: req.user.username, me: req.user.username, items, HOP: require("./hop").HOP });
    } catch (e) {
      console.error("[storykeep] saved page:", e);
      res.status(500).send("Something went wrong.");
    }
  });
}

/** 1.99ez: is `acct` (with camfrogUsername) a mod of `roomId`'s Camfrog room (userstories: removing members' stories)? */
function isPadMod(acct, roomId) { try { return !!modCheck(acct, roomId); } catch (e) { return false; } }

module.exports = { SAVE_USER_KINDS, userSaveable, init, register, postToPad, removeMe, forPosts, save, unsave, savedFor, onCaptureRemoved, annotate, privacyBlocks, mayPost, subjectOf,
                   isPadMod, Refuse, _setClock, _setModCheck, _setPersistImpl, defaultPersist };
