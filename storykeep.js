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
//   * 🎙 Mic-stage captures (source "stage", stream "mic" - several people; mic keep, handoff 16 follow-up, owner 2026-11-01:
//     "make clips savable and postable") may be saved / posted only when ALL of: the rules above; the admin switch
//     stagecap_mic_keep (Stage admin, default on); the capture was taken in the open (stage_captures.veiled = 0: no cover tile,
//     no blanked tile, no "Someone is speaking" card, no muted sound, no voice the tiles don't show - stagemiccap.js; NULL = taken
//     before this rule: never); nobody shown removed its post; and, at that moment, EVERYONE shown - the cams drawn
//     (stage_capture_people) and the name cards (stage_capture_cards) - passes the engine's consent for the actor (and, posting,
//     the credited capturer): not hidden, the strict private-profile lookup, their cam rules; the accounts that had each login
//     when it was taken don't keep their activity private; the story block rule holds both ways. Any lookup error refuses.
//     The people shown are copied into story_keep_people (the live rows die with the 24 h capture) in the same transaction as the
//     story_posts claim / story_keeps row; deleted when the capture has no copy left. Every person shown (cam or name card, by
//     the spans their login was theirs - stagecap.ownSpans; a recycled login's later holder gets nothing) is told about a post
//     and sees "Remove me" on it: one removal takes the post down AND deletes every saved copy (they can't see private
//     collections, and a mic capture can't be cut). Copies go when someone shown goes private (profile, hidden / incognito,
//     Pepe's /api/media/anon for their login) or deletes their account: hooks where those change, read-time checks (Saved,
//     the story viewer) and an hourly backstop sweep (sweepKept). The story delete right stays cam-only (stagecap.canDelete).
//     Review fixes: a mic post is alive while its FEED post is (not deleted / purged) - story_posts.removed_at alone never hides one;
//     deleting a mic post (its author, an admin, any path) takes every saved copy with it (onPostDeleted - nobody but staff can open
//     a deleted post to tap Remove me); a saved copy with no save left is purged (purgeOrphanKeep); a recheck after the write that
//     fails only for the actor (their blocks, cam rules) undoes only that actor's new copy; a capture someone shown deleted their
//     account from is never kept (stage_captures.veiled = 2, set by account deletion; micrec's gone marker for a late card row).
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
//   story_keep_people  capture_id (the media id) + login (PK), role (cam | card), captured_at - who a saved / posted 🎙 mic-stage
//                copy shows (mic keep). NOT re-keyed on a login change (loginrekey.js): read by the ownership spans.
//   story_posts.stream  "mic" for a post made from a mic-stage capture (provenance "🎙 Mic stage in <room>", multi-subject Remove me)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
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

// i18n: a refusal's locales/en.json key (the route answers req.t(key) - mic keep's texts; older ones are plain English)
class Refuse extends Error { constructor(status, msg, i18n) { super(msg); this.status = status; this.refuse = true; if (i18n) this.i18n = i18n; } }

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
      // mic keep (handoff 16 follow-up)
      await runQuery(`CREATE TABLE IF NOT EXISTS story_keep_people (
        capture_id TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL, captured_at INTEGER NOT NULL, PRIMARY KEY (capture_id, login))`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_keep_people_login ON story_keep_people (login)");
      if (!(await getQuery("PRAGMA table_info(story_posts)")).some((c) => c.name === "stream")) await runQuery("ALTER TABLE story_posts ADD COLUMN stream TEXT");
    })().catch((e) => { console.error("[storykeep] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

const store = () => require("./feedstore");
const managesAny = (u) => SP.can(u, "pads.manage_any");   // 1.99ack (siteperms.js; was isStaff)
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

// ── 🎙 mic-stage captures (mic keep, handoff 16 follow-up, owner 2026-11-01) ──
const isMic = (r) => !!r && r.source === "stage" && r.stream === "mic";
const MIC = {
  off: "Saving and posting mic-stage snaps and clips is switched off right now.",
  unknown: "This mic-stage capture has no record that everyone in it was shown openly, so it can't be kept.",
  veiled: "Not everyone in this mic-stage capture was shown openly (a cover, a blanked tile, muted sound or a voice that isn't shown), so it can't be kept.",
  person: "Someone shown in this mic-stage capture can't be in a saved or posted copy right now, so it can't be kept.",
  error: "Couldn't check everyone shown in this mic-stage capture just now - try again in a moment.",
  removed: "Someone shown in this mic-stage capture removed it, so it can't be kept again.",
  not_shown: "Only someone shown in this capture can remove it.",
};
const micRefuse = (key, status = 403) => new Refuse(status, MIC[key], "storykeep.mic." + key);
const CLAIM_STALE_MS = 5 * 60e3;            // a story_posts claim with no post this old was left by a crash (postToPad retries it)
/** The admin kill switch (mainstage stage config stagecap_mic_keep, default on). Unreadable = off. */
function micKeepOn() {
  try { return require("./mainstage").config().stagecap_mic_keep !== false; } catch (e) { return false; }
}
const TABLES = new Set();
async function tableThere(name) {
  if (TABLES.has(name)) return true;
  const ok = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
  if (ok) TABLES.add(name);
  return ok;
}
/** The stage capture behind a published mic-stage media row, and who it shows from its LIVE rows (stage_capture_people = the cams
 *  drawn, role "cam"; stage_capture_cards = name cards, role "card") -> {cap, capturedAt, people: [{login, role}]} | null. */
async function micCapture(mediaId) {
  if (!(await tableThere("stage_captures"))) return null;
  const cap = (await getQuery("SELECT * FROM stage_captures WHERE media_id = ? AND source = 'mic'", [String(mediaId)]))[0];
  if (!cap) return null;
  const people = [], seen = new Set();
  const add = (l, role) => { const x = lc(l); if (x && !seen.has(x)) { seen.add(x); people.push({ login: x, role }); } };
  // 1.99aid (privacy controls, review fixes 2 - Q4-A): a cam drawn under a FROG NAME (stage_capture_people.veil, incognito cams) is role
  // "vcam" - kept like any cam drawn (owner Q4: every cam feature works, incognito changes only the name), checked as a frog-name cam
  // (micPeopleWhy / personState), never named to anyone but its own person
  if (await tableThere("stage_capture_people")) {
    const vcol = (await getQuery("PRAGMA table_info(stage_capture_people)")).some((c) => c.name === "veil");
    for (const r of await getQuery(`SELECT login${vcol ? ", veil" : ""} FROM stage_capture_people WHERE capture_id = ?`, [cap.id])) add(r.login, r.veil ? "vcam" : "cam");
  }
  if (await tableThere("stage_capture_cards")) for (const r of await getQuery("SELECT login FROM stage_capture_cards WHERE capture_id = ?", [cap.id])) add(r.login, "card");
  return { cap, capturedAt: Number(cap.created) || 0, people };
}
/** Who a saved / posted copy shows: its durable rows -> {capturedAt, people} | null (none). */
async function keptCapture(captureId) {
  const rows = await getQuery("SELECT login, role, captured_at FROM story_keep_people WHERE capture_id = ?", [String(captureId)]);
  return rows.length ? { capturedAt: Number(rows[0].captured_at) || 0, people: rows.map((r) => ({ login: lc(r.login), role: r.role })) } : null;
}
/** Why NOBODY may keep this mic-stage capture right now (null: anyone may, pending micPeopleWhy) - the switch, no in-the-open
 *  record (a row from before mic keep: veiled NULL, or no stage capture at all), veiled, or a person shown removed its post. */
async function micCaptureWhy(row, mc) {
  if (!micKeepOn()) return "off";
  if (!mc || mc.cap.state !== "done" || mc.cap.veiled == null) return "unknown";
  // review fix: 2 = someone shown has since deleted their account (accountdelete - their rows are gone, so no copy could record them)
  if (Number(mc.cap.veiled) === 2) return "person";
  if (Number(mc.cap.veiled) !== 0) return "veiled";
  const sp = (await getQuery("SELECT removed_by FROM story_posts WHERE capture_id = ?", [row.id]))[0];
  if (sp && sp.removed_by === "subject") return "removed";
  return null;
}
/**
 * The per-person recheck at the moment of a save / post: everyone a mic-stage capture shows (cams drawn and name cards) passes the
 * engine's consent now for each of `actorIds` (stagemiccap.consent: not hidden, the strict private-profile lookup that fails closed,
 * their cam rules - !livecam off included), the accounts that had each login when it was taken (ownersAt) don't keep their activity
 * private, and the story block rule holds both ways with each actor (storyreact.loginsBlocked). -> null | "person" | "error" (any
 * lookup error refuses). The answer never says who. `cache` (a Map) shares lookups across one request. `owners: false` (the story
 * viewer's buttons only - the action re-checks everything) skips the login-history walk; the current holder's privacy is in consent.
 * Review fixes: a login whose PATV account was deleted after the capture was taken (micrec's gone marker - a card row written after
 * the deletion) refuses; the accounts that had each login then are read with the STRICT profile lookup, and the block rule is
 * tested against them too (a re-link or unlink since never lifts their block - consent and loginsBlocked see the login's holder now).
 */
async function micPeopleWhy(mc, actorIds, cache = new Map(), { owners = true } = {}) {
  if (!mc) return "error";
  const actors = [...new Set(actorIds.filter(Boolean).map(String))];
  const logins = mc.people.map((p) => p.login);
  // (review fixes 2 - Q4-A: a frog-name cam - still incognito, its own cam rules; stagemiccap.consent's recheck form {sess: null})
  const vcam = new Set(mc.people.filter((p) => p.role === "vcam").map((p) => p.login));
  // 1.99aid (privacy controls S3): a name card's person (role "card") - stagemiccap.cardConsent: while micfollow_cfg withheld_cover is on,
  // a cam opt-out withholds the cam only, so a name card asks hidden / private / their cam blocks, never the cam's rules; off = consent
  const card = new Set(mc.people.filter((p) => p.role === "card").map((p) => p.login));
  try {
    const SM = require("./stagemiccap"), SR = require("./storyreact");
    if (!cache.has("srctx")) cache.set("srctx", SR.mkCtx());
    for (const a of actors) {
      for (const l of logins) {
        const v = vcam.has(l), c = !v && card.has(l);
        const k = (v ? "vconsent|" : c ? "cconsent|" : "consent|") + l + "|" + a;
        if (!cache.has(k)) cache.set(k, (await (v ? SM.consent(l, a, { sess: null }) : c ? SM.cardConsent(l, a) : SM.consent(l, a))) === true);
        if (!cache.get(k)) return "person";
      }
      const kb = "block|" + a + "|" + logins.join(",");
      if (!cache.has(kb)) cache.set(kb, (await SR.loginsBlocked(a, logins, cache.get("srctx"))).size > 0);
      if (cache.get(kb)) return "person";
    }
    if (!owners) return null;
    for (const l of logins) {
      if ((await goneAtCached(l, cache)) > mc.capturedAt) return "person";
      const was = await ownersAt(l, mc.capturedAt, cache);
      for (const uid of was) if (await layoutHidden(uid, cache)) return "person";        // strict: unreadable throws -> "error"
      for (const a of actors) {
        const kw = "bw|" + a;
        if (!cache.has(kw)) cache.set(kw, await SR.blockedWith(a));                       // dm_blocks either way (throws: refuses)
        if (was.some((uid) => uid !== a && cache.get(kw).has(uid))) return "person";
      }
    }
    return null;
  } catch (e) {
    console.error("[storykeep] mic recheck (refusing):", e.message);
    return "error";
  }
}
/** mic keep review: does account `uid` keep its activity private (Analytics or Rooms hidden)? The STRICT read - stagemiccap's
 *  privateLayoutStrict, which throws on an unreadable stored layout where profilelayout.get falls back to the public default; callers
 *  fail closed. Cached per `cache` (one request / sweep). */
async function layoutHidden(uid, cache = null) {
  const k = "ph|" + uid;
  if (cache && cache.has(k)) return cache.get(k);
  const pl = require("./profilelayout");
  const L = await require("./stagemiccap").privateLayoutStrict(String(uid), getQuery, pl);
  const h = pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden";
  if (cache) cache.set(k, h);
  return h;
}
async function goneAtCached(login, cache = null) {
  const k = "gone|" + login;
  if (cache && cache.has(k)) return cache.get(k);
  const g = Number(await require("./micrec").goneAt(login)) || 0;
  if (cache) cache.set(k, g);
  return g;
}
/** The PATV accounts whose Camfrog login `login` was at time `at`, by stagecap.ownSpans (a recycled login's later holder isn't one).
 *  Candidates: whoever has it now and every account the login history names with it (a merged-away id followed to the account it
 *  went into). Errors throw. -> [userId]. Review fix: the candidates and their spans are worked out once per login per `cache` (one
 *  request / sweep) - each row then only tests its own time against them. */
async function ownersAt(login, at, cache = null) {
  const l = lc(login);
  if (!/^[\w.\-]{1,64}$/.test(l)) return [];
  return (await loginOwners(l, cache))
    .filter((o) => o.spans.some((w) => w.login === l && at > Number(w.from) && at <= Number(w.to))).map((o) => o.uid);
}
/** [{uid, spans}] - every candidate account for `l` (lower-case) and the spans each held a login (stagecap.ownSpans). Errors throw
 *  (never cached). */
async function loginOwners(l, cache = null) {
  const k = "lo|" + l;
  if (cache && cache.has(k)) return cache.get(k);
  const ids = new Set();
  for (const r of await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [l])) ids.add(String(r.userId));
  if (await tableThere("login_changes")) for (const r of await getQuery("SELECT userId FROM login_changes WHERE lower(old_login) = ? OR lower(new_login) = ?", [l, l])) ids.add(String(r.userId));
  if (await tableThere("username_history")) {
    for (const r of await getQuery("SELECT userId FROM username_history WHERE kind = 'camfrog' AND (lower(old_username) = ? OR lower(new_username) = ?)", [l, l])) ids.add(String(r.userId));
  }
  let frontier = [...ids];
  for (let hop = 0; hop < 6 && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      const to = [];
      if (await tableThere("account_merge_log")) to.push(...(await getQuery("SELECT to_id AS id FROM account_merge_log WHERE from_id = ?", [id])));
      if (await tableThere("account_merges")) to.push(...(await getQuery("SELECT new_id AS id FROM account_merges WHERE old_id = ?", [id])));
      for (const r of to) { const x = String(r.id || ""); if (x && !ids.has(x)) { ids.add(x); next.push(x); } }
    }
    frontier = next;
  }
  const SC = require("./stagecap"), out = [];
  for (const uid of ids) {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [uid]))[0];
    if (!u) continue;
    out.push({ uid, spans: await SC.ownSpans(uid, u.camfrogUsername ? lc(u.camfrogUsername) : null, NOW()) });
  }
  if (cache) cache.set(k, out);
  return out;
}
/** Copy the LIVE people rows into story_keep_people - inside the caller's transaction, with the story_posts claim / story_keeps row. */
async function copyPeople(captureId, mc) {
  for (const p of mc.people) {
    await runQuery("INSERT OR IGNORE INTO story_keep_people (capture_id, login, role, captured_at) VALUES (?, ?, ?, ?)", [String(captureId), p.login, p.role, mc.capturedAt]);
  }
}
/** Re-read the live capture inside a transaction and copy its people (the capture still published, still in the open). */
async function claimPeople(row) {
  const m = (await getQuery("SELECT deleted, expires FROM media WHERE id = ?", [row.id]))[0];
  if (!m || Number(m.deleted) || !(Number(m.expires) > NOW())) throw new Refuse(410, "That capture was removed.");
  const live = await micCapture(row.id);
  const why = await micCaptureWhy(row, live);
  if (why) throw micRefuse(why);
  await copyPeople(row.id, live);
  return live;
}
/** The durable rows go once the capture has no copy left: no saved copy (an unpurged keep that still has a save - review fix: a keep
 *  nobody saves any more isn't one; purgeOrphanKeep deletes it), and no post that's claimed (being made) or alive (review fix: its
 *  FEED post neither deleted nor purged - story_posts.removed_at alone never decides). `captureId` null = every capture (the sweep,
 *  one statement). Idempotent. */
async function dropPeopleIfNoCopy(captureId) {
  const all = captureId === null;
  const id = String(captureId || "");
  if (!all && !id) return 0;
  const fp = await tableThere("feed_posts");
  const C = "story_keep_people.capture_id";
  const r = await runQuery(`DELETE FROM story_keep_people WHERE ${all ? "1" : "capture_id = ?"}
    AND NOT EXISTS (SELECT 1 FROM story_keeps k WHERE k.capture_id = ${C} AND k.purged_at IS NULL
      AND EXISTS (SELECT 1 FROM story_saves s WHERE s.capture_id = k.capture_id))
    AND NOT EXISTS (SELECT 1 FROM story_posts sp WHERE sp.capture_id = ${C}
      AND ((sp.post_id IS NULL AND sp.created > ?) OR (sp.post_id IS NOT NULL AND
        ${fp ? "EXISTS (SELECT 1 FROM feed_posts p WHERE p.id = sp.post_id AND p.deleted_at IS NULL AND p.purged_at IS NULL)" : "sp.removed_at IS NULL"})))`,
    all ? [NOW() - CLAIM_STALE_MS] : [id, NOW() - CLAIM_STALE_MS]);
  return (r && r.changes) || 0;
}
/** mic keep review: is the feed post `postId` up (not deleted, not purged)? A missing row is down. */
async function feedPostAlive(postId) {
  if (!postId) return false;
  const p = (await getQuery("SELECT deleted_at, purged_at FROM feed_posts WHERE id = ?", [String(postId)]))[0];
  return !!p && p.deleted_at == null && p.purged_at == null;
}
/**
 * mic keep review: a saved copy nobody saves any more (its last saver's account deleted - accountdelete removes story_saves rows
 * directly; a save that failed between its two writes; a Remove me whose purge failed) is purged, then the people rows go if it was
 * the last copy. Atomic against a save in flight: the purge is one UPDATE that requires no save, and save() re-checks the keep inside
 * its own transaction. `grace` (ms): only a keep at least that old (the sweep - a save between ensureKeep and its story_saves row
 * isn't raced). -> purged?
 */
async function purgeOrphanKeep(captureId, { grace = 0 } = {}) {
  const id = String(captureId || "");
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ? AND purged_at IS NULL", [id]))[0];
  if (!k) return false;
  const r = await runQuery(`UPDATE story_keeps SET purged_at = ?, purge_reason = 'orphan' WHERE capture_id = ? AND purged_at IS NULL AND COALESCE(created, 0) <= ?
                            AND NOT EXISTS (SELECT 1 FROM story_saves s WHERE s.capture_id = ?)`, [NOW(), id, NOW() - grace, id]);
  if (!r || !r.changes) return false;
  dropFiles(k);
  await dropPeopleIfNoCopy(id);
  return true;
}

/** Privacy for many capture rows at once -> Map id -> {msg, i18n} (only blocked ones are in it). Whoever asks: the per-person
 *  recheck of a mic-stage capture (micPeopleWhy) is the caller's, for its actor. */
async function privacyWhy(rows) {
  const out = new Map();
  const logins = [], uids = [], slots = new Map();
  for (const r of rows) {
    if (r.source === "user") continue;
    if (r.source === "stage") {
      if (r.by_user_id) uids.push(r.by_user_id);
      const su = await slotUser(r.slot_id);
      slots.set(r.id, su);
      if (su) uids.push(su);
    } else logins.push(r.subject, r.by_user, r.subject_login);
  }
  const priv = await require("./stories").privateLogins(logins);
  const hid = await hiddenUsers(uids);
  const set = (id, msg, i18n) => out.set(id, { msg, i18n: i18n || null });
  for (const r of rows) {
    const by = String(r.by_user || "").trim();
    // 1.99ez: a member's own story upload (userstories.js) is theirs; 1.99fn: a snap / clip story may be SAVED (never
    // posted - postToPad refuses source "user" on its own), anything else can't be kept
    if (r.source === "user") { if (!userSaveable(r)) set(r.id, "This is someone's own story, so it can't be kept."); continue; }
    if (Number(r.anon)) set(r.id, "The person in this capture is private (incognito or hidden), so it can't be kept.");
    else if (!by || lc(by) === "someone") set(r.id, "This capture was taken privately, so it can't be kept.");
    else if (r.source === "stage") {
      if ((r.by_user_id && hid.has(r.by_user_id)) || (slots.get(r.id) && hid.has(slots.get(r.id)))) set(r.id, "Someone in this capture keeps their activity private, so it can't be kept.");
      // mic keep (replaces review fix 1's "never"): the switch, the in-the-open record, a removal by someone shown
      else if (isMic(r)) {
        let why;
        try { why = await micCaptureWhy(r, await micCapture(r.id)); } catch (e) { console.error("[storykeep] mic capture:", e.message); why = "error"; }
        if (why) set(r.id, MIC[why], "storykeep.mic." + why);
      }
    } else if (priv.has(lc(r.subject)) || priv.has(lc(r.by_user)) || (r.subject_login && priv.has(lc(r.subject_login)))) set(r.id, "Someone in this capture keeps their activity private, so it can't be kept.");
  }
  return out;
}
/** privacyWhy's reasons as plain text (Map id -> reason). */
async function privacyBlocks(rows) {
  return new Map([...(await privacyWhy(rows))].map(([id, w]) => [id, w.msg]));
}
const whyRefuse = (w) => new Refuse(403, w.msg, w.i18n);

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
  const login = lc(row.subject_login) || lc(row.subject) || null;      // 1.99fp: the subject's LOGIN when Pepe sent one
  const u = login ? await userByLogin(login) : null;
  return { userId: u ? u.userId : null, login, name: String(row.subject || "").slice(0, 60) || null };
}
/** The capturer's PATV account id, or null (cam: their linked login - 1.99?? cliplink: or by_user_id, an account with none; stage: by_user_id). */
async function capturerId(row) {
  if (row.source === "stage") return row.by_user_id || null;
  if (!row.source && row.by_user_id) return row.by_user_id;   // 1.99?? cliplink: Pepe's capture for a PATV account with no Camfrog name
  const u = await userByLogin(row.by_user);
  return u ? u.userId : null;
}
function isCapturer(acct, row) {
  if (!acct) return false;
  if (row.source === "stage") return !!row.by_user_id && row.by_user_id === acct.userId;
  if (!row.source && row.by_user_id) return row.by_user_id === acct.userId;   // 1.99?? cliplink: (media.js by_uid - the account that took it)
  return !!acct.camfrogUsername && lc(acct.camfrogUsername) === lc(row.by_user);
}
/** May `acct` post `row` to its pad? (permission only - privacy / gone are separate) */
async function mayPost(acct, row) {
  if (!acct) return false;
  if (managesAny(acct) || isCapturer(acct, row)) return true;
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
  const pf = media.posterFile(row.id);          // a clip's poster frame, or (1.99fp) an audio capture's waveform card
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
async function postToPad(user, captureId, { caption = "", body = "" } = {}) {
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
  const block = (await privacyWhy([row])).get(row.id);
  if (block) throw whyRefuse(block);
  const authorId = (await capturerId(row)) || acct.userId;
  // mic keep: everyone shown passes the recheck for the poster AND the credited capturer (the post reads as theirs)
  const mic = isMic(row);
  if (mic) {
    const pw = await micPeopleWhy(await micCapture(row.id), [acct.userId, authorId]);
    if (pw) throw micRefuse(pw);
  }
  // the claim (one post per capture, even with two clicks at once) - mic keep: with the durable people record, copied from the live
  // rows in the same transaction (the capture re-checked inside it: still published, still in the open)
  const t = NOW();
  const claim = await tx(async () => {
    const c = await runQuery("INSERT OR IGNORE INTO story_posts (capture_id, room_id, posted_by, created, kind, source, stream) VALUES (?, ?, ?, ?, ?, ?, ?)",
                             [row.id, R.id, acct.userId, t, row.kind, row.source || "cam", mic ? "mic" : null]);
    if (c.changes && mic) await claimPeople(row);
    return c;
  });
  if (!claim.changes) return existing((await getQuery("SELECT * FROM story_posts WHERE capture_id = ?", [row.id]))[0], acct);
  let att = null, made = null, linked = false;
  const what = mic ? (row.kind === "clip" ? "Mic-stage clip" : "Mic-stage snap")
    : row.source === "stage" ? (row.kind === "clip" ? "Stage clip" : "Stage snap") : KIND_NOUN[row.kind] || "Capture";
  try {
    // mic keep: no single subject - provenance is "🎙 Mic stage in <room>" (forPosts), every person shown has "Remove me"
    const subj = mic ? { userId: null, login: null, name: null } : await subjectOf(row);
    const k = await persistImpl(row);
    if (roomFull(k.bytes)) { dropFiles(k); throw new Refuse(507, "The feed's storage is full right now."); }
    att = crypto.randomBytes(12).toString("hex");
    await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, secs, bytes, state, created, size_declared, received)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
                   [att, authorId, k.kind, k.ct, k.file, k.thumb, k.poster, k.w || 0, k.h || 0, k.secs || 0, k.bytes || 0, t, k.bytes || 0, k.bytes || 0]);
    const S = store();
    const cap = S.cleanLine(caption, CAPTION_MAX);
    const title = cap || (mic ? `🎙 ${what} in ${R.title || R.id}` : `${what}${subj.name ? " of " + subj.name : ""} in ${R.title || R.id}`).slice(0, CAPTION_MAX);
    // adultgate site: liveRoom = the room it was captured in - the 18+ gate follows the post from its first notice on
    made = await S.create(authorId, { title, body: String(body || "").slice(0, 2000) || undefined, community: R.id, attachments: [att], nsfw: !!Number(row.nsfw), announce: [] },
                          { free: true, onBehalf: authorId !== acct.userId || managesAny(acct) || (await rooms.canManage(acct, R.id)), liveRoom: R.id });
    await runQuery(`UPDATE story_posts SET post_id = ?, author_id = ?, subject_user_id = ?, subject_login = ?, subject_name = ?, room_title = ? WHERE capture_id = ?`,
                   [made.id, authorId, subj.userId, subj.login, subj.name, R.title || R.id, row.id]);
    linked = true;
    // the person on cam hears about it (with the way out) - unless they posted it themselves
    if (subj.userId && subj.userId !== acct.userId) {
      await S.notify(subj.userId, { kind: "feed", title: "A capture of you was posted",
        body: `${acct.displayname || acct.username} posted a ${what.toLowerCase()} of you to ${R.title || R.id}. Not OK? Open it and tap "Remove me".`,
        link: made.url, ref: "story-post:" + made.id });
    }
  } catch (e) {
    // review fix: the feed post was made but its story_posts row never got its id - a live post with no record would have no
    // provenance, no Remove me and no cascade. Take it down first; the claim and the people rows go only once it is down. If even
    // that fails, record it on the claim instead (then it has Remove me and the cascade) and leave both.
    if (made && !linked) {
      let down = false;
      try {
        await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'capture', delete_reason = 'posting failed' WHERE id = ? AND deleted_at IS NULL", [NOW(), made.id]);
        down = true;
      } catch (e2) {
        console.error("[storykeep] post", made.id, "made but not recorded, and not taken down:", e2.message);
        await runQuery("UPDATE story_posts SET post_id = ?, author_id = ?, room_title = ? WHERE capture_id = ? AND post_id IS NULL", [made.id, authorId, R.title || R.id, row.id])
          .catch((e3) => console.error("[storykeep] post", made.id, "record retry:", e3.message));
      }
      if (down) {
        await runQuery("DELETE FROM story_posts WHERE capture_id = ? AND post_id IS NULL", [row.id]).catch(() => {});
        if (mic) await dropPeopleIfNoCopy(row.id).catch(() => {});
      }
      throw e;
    }
    await runQuery("DELETE FROM story_posts WHERE capture_id = ? AND post_id IS NULL", [row.id]).catch(() => {});
    if (mic) await dropPeopleIfNoCopy(row.id).catch(() => {});
    if (att && !made) {
      const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [att]))[0];
      if (a && !a.post_id) { dropFiles(a); await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ?", [att]).catch(() => {}); }
    }
    throw e;
  }
  if (mic) {
    // mic keep: someone who went private between the recheck above and the durable rows (a hook that fired then found no row) takes
    // the new post down now; a lookup error leaves it to the backstop sweep and the read-time checks. Review fix: a failure that's
    // only about this poster / the credited capturer (a block, cam rules) takes down only this new post (undoMicCopy)
    if ((await micPeopleWhy(await keptCapture(row.id), [acct.userId, authorId])) === "person") {
      await undoMicCopy(row.id, { postId: made.id });
      throw micRefuse("person");
    }
    await noticeShown(row.id, acct, made, what, R);
  }
  console.log(`[storykeep] capture ${row.id} -> post ${made.id} in ${R.id} by ${acct.username} (credited ${authorId})`);
  return { post: { id: made.id, url: made.url }, again: false };
}
/** mic keep: every linked account a new mic-stage post shows (cam or name card, the account that had the login when it was taken)
 *  hears about it with the way out - except the poster. A failed lookup tells nobody (they still have Remove me). */
async function noticeShown(captureId, acct, made, what, R) {
  try {
    const kc = await keptCapture(captureId);
    const tell = new Map(), cache = new Map();
    // (review fixes 2 - Q4-A: someone drawn ONLY under a frog name hears about it in words about their frog name - their own inbox;
    // the post never names them)
    for (const p of kc ? kc.people : []) for (const uid of await ownersAt(p.login, kc.capturedAt, cache)) {
      if (uid !== acct.userId) tell.set(uid, tell.has(uid) ? tell.get(uid) && p.role === "vcam" : p.role === "vcam");
    }
    for (const [uid, frog] of tell) {
      await store().notify(uid, { kind: "feed", title: "A capture of you was posted",
        body: frog ? `${acct.displayname || acct.username} posted a ${what.toLowerCase()} that shows your cam under your frog name to ${R.title || R.id}. Not OK? Open it and tap "Remove me" - that also deletes every saved copy.`
          : `${acct.displayname || acct.username} posted a ${what.toLowerCase()} that shows you to ${R.title || R.id}. Not OK? Open it and tap "Remove me" - that also deletes every saved copy.`,
        link: made.url, ref: "story-post:" + made.id });
    }
  } catch (e) { console.error("[storykeep] mic post notices:", e.message); }
}
async function existing(sp, acct) {
  if (!sp) throw new Refuse(409, "Try again in a moment.");
  if (!sp.post_id) throw new Refuse(409, "It's being posted right now.");
  if (sp.removed_at && sp.stream === "mic" && sp.removed_by === "subject") throw micRefuse("removed", 409);
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
  if (sp && sp.stream === "mic") return micRemoveMe(acct, sp);
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
/** mic keep: the captures (of `captureIds`) whose kept / posted copy shows `acct` - a durable row's login inside a span in which it
 *  was the account's at captured_at (stagecap.ownSpans, depictedOf's rule: a recycled login's later holder is never shown). Errors
 *  throw (callers grant nothing). -> Set of capture ids */
async function micShownAs(acct, captureIds, roles = null) {
  const out = new Set();
  const ids = [...new Set((captureIds || []).map(String))];
  if (!acct || !acct.userId || !ids.length) return out;
  const rows = await getQuery(`SELECT capture_id, login, role, captured_at FROM story_keep_people WHERE capture_id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) return out;
  let login = acct.camfrogUsername;
  if (login === undefined) { const a = await accountOf(acct); login = a ? a.camfrogUsername : null; }
  const spans = await require("./stagecap").ownSpans(acct.userId, login ? lc(login) : null, NOW());
  for (const r of rows) {
    const at = Number(r.captured_at) || 0;
    if (spans.some((w) => w.login === lc(r.login) && at > Number(w.from) && at <= Number(w.to))) {
      out.add(r.capture_id);
      if (roles) { const k = r.capture_id; if (!roles.has(k)) roles.set(k, new Set()); roles.get(k).add(r.role); }   // (review fixes 2 - Q4-A)
    }
  }
  return out;
}
/**
 * mic keep: multi-subject "Remove me" on a post of a mic-stage capture - anyone it shows (cam or name card, micShownAs; a lookup error
 * grants nothing). One removal soft-deletes the post (deleted_by "subject") AND drops every saved copy (they can't see private
 * collections, and a mic capture can't be cut); nobody can save or post it again. The poster and the credited capturer are told.
 * Idempotent (a removed post answers again: true). Review fix: alive = its FEED post is up - a stale story_posts.removed_at (an
 * account deletion's blanket mark before the fix) never makes a live post unremovable; a post already down answers again: true after
 * making sure its saved copies went with it (onPostDeleted).
 */
async function micRemoveMe(acct, sp) {
  if (sp.removed_by === "subject") return { removed: true, again: true };
  if (!(await feedPostAlive(sp.post_id))) {
    await onPostDeleted(sp.post_id);
    return { removed: true, again: true };
  }
  let shown = false;
  const how = new Map();
  try { shown = (await micShownAs(acct, [sp.capture_id], how)).has(sp.capture_id); } catch (e) { console.error("[storykeep] mic remove-me (granting nothing):", e.message); }
  if (!shown) throw micRefuse("not_shown");
  // (review fixes 2 - Q4-A: shown only under a frog name - the poster is told "someone shown in it", never who)
  const frogOnly = [...(how.get(sp.capture_id) || [])].every((r) => r === "vcam");
  const t = NOW();
  const won = await tx(async () => {
    const u = await runQuery(`UPDATE story_posts SET removed_at = ?, removed_by = 'subject', removed_reason = 'remove-me'
                              WHERE capture_id = ? AND (removed_by IS NULL OR removed_by <> 'subject')`, [t, sp.capture_id]);
    if (!u.changes) return false;                  // two clicks at once: the other one did it
    await runQuery(`UPDATE feed_posts SET deleted_at = ?, deleted_by = 'subject', delete_reason = 'removed by someone shown in it' WHERE id = ? AND deleted_at IS NULL`, [t, sp.post_id]);
    await runQuery("DELETE FROM story_saves WHERE capture_id = ?", [sp.capture_id]);
    return true;
  });
  if (!won) return { removed: true, again: true };
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [sp.post_id]).catch(() => {});
  await purgeKeep(sp.capture_id, "remove-me");
  await dropPeopleIfNoCopy(sp.capture_id);
  const tell = [...new Set([sp.posted_by, sp.author_id].filter((x) => x && x !== acct.userId))];
  for (const uid of tell) {
    await store().notify(uid, { kind: "feed", title: "A capture you posted was removed",
      body: `${frogOnly ? "Someone shown in it" : (acct.displayname || acct.username) + " is in it and"} removed the post${sp.room_title ? " in " + sp.room_title : ""}. Saved copies of it were deleted too.`,
      link: "/feed", ref: "story-rm:" + sp.post_id });
  }
  console.log(`[storykeep] mic post ${sp.post_id} removed by someone shown in it${frogOnly ? "" : " (" + acct.username + ")"}; saved copies dropped`);
  return { removed: true, again: false };
}

/** Provenance for decorated posts -> Map post_id -> {room, kind, source, subjectName, subject: {username}|null, canRemoveMe}. */
async function forPosts(ids, viewer) {
  if (!ids || !ids.length) return new Map();
  await init();
  // mic keep review: + whether the feed post is up (a mic post's Remove me follows it, never story_posts.removed_at alone)
  const rows = await getQuery(`SELECT sp.*, p.id AS p_id, p.deleted_at AS p_deleted_at, p.purged_at AS p_purged_at FROM story_posts sp
                               LEFT JOIN feed_posts p ON p.id = sp.post_id WHERE sp.post_id IN (${ids.map(() => "?").join(",")})`, ids);
  const out = new Map();
  if (!rows.length) return out;
  let acct = viewer && viewer.userId ? viewer : null;
  if (acct && acct.camfrogUsername === undefined) acct = await accountOf(acct);
  const micUp = (r) => r.stream === "mic" && !!r.p_id && r.p_deleted_at == null && r.p_purged_at == null && r.removed_by !== "subject";
  // mic keep: which mic-stage posts show this viewer (a lookup error grants nothing)
  let shownIn = new Set();
  const micIds = rows.filter(micUp).map((r) => r.capture_id);
  if (acct && micIds.length) { try { shownIn = await micShownAs(acct, micIds); } catch (e) { console.error("[storykeep] mic provenance:", e.message); } }
  for (const r of rows) {
    const mic = r.stream === "mic";
    // the subject's profile: their account if posted with one, else (linked later) by login (mic keep: a mic post has no single subject)
    let su = !mic && r.subject_user_id ? await userById(r.subject_user_id) : null;
    if (!mic && !su && r.subject_login) su = await userByLogin(r.subject_login);
    const R = rooms.getCached(r.room_id);
    // 1.99fu: captured in an Approved pad this viewer is outside of - say so without naming it
    const PA = require("./padaccess");
    const hid = PA.isReady() && !PA.canSee(viewer, r.room_id);
    out.set(r.post_id, {
      room: hid ? { id: null, title: "a members-only pad", href: null }
        : { id: r.room_id, title: (R && R.title) || r.room_title || r.room_id, href: R ? require("./pads").padHref(R) : null },
      kind: r.kind, source: r.source, subjectName: mic ? null : r.subject_name || null,
      subject: su ? { username: su.username, display: su.displayname || su.username } : null,
      // mic keep: "🎙 Mic stage in <room>"; Remove me for everyone it shows (cam or name card)
      ...(mic ? { mic: true } : {}),
      canRemoveMe: mic ? micUp(r) && shownIn.has(r.capture_id) : !r.removed_at && subjectMatches(acct, r),
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
    try {
      // mic keep: the durable people record, copied from the live rows in the same transaction as the story_keeps row
      await tx(async () => {
        await runQuery(`INSERT INTO story_keeps (capture_id, kind, ct, file, thumb, poster, w, h, secs, bytes, created, purged_at, purge_reason)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                        ON CONFLICT(capture_id) DO UPDATE SET kind = excluded.kind, ct = excluded.ct, file = excluded.file, thumb = excluded.thumb,
                          poster = excluded.poster, w = excluded.w, h = excluded.h, secs = excluded.secs, bytes = excluded.bytes, created = excluded.created,
                          purged_at = NULL, purge_reason = NULL`,
                       [row.id, f.kind, f.ct, f.file, f.thumb, f.poster, f.w || 0, f.h || 0, f.secs || 0, f.bytes || 0, NOW()]);
        if (isMic(row)) await claimPeople(row);
      });
    } catch (e) { dropFiles(f); throw e; }
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
  const block = (await privacyWhy([row])).get(row.id);
  if (block) throw whyRefuse(block);
  // mic keep: everyone shown passes the recheck for the saver
  const mic = isMic(row);
  if (mic) {
    const pw = await micPeopleWhy(await micCapture(row.id), [acct.userId]);
    if (pw) throw micRefuse(pw);
  }
  await ensureKeep(row);
  const R = row.room ? rooms.getCached(row.room) : null;
  try {
    await tx(async () => {
      // review fix: the copy ensureKeep returned is still there (an orphan purge can't take it between the two writes unseen)
      const kk = (await getQuery("SELECT purged_at FROM story_keeps WHERE capture_id = ?", [row.id]))[0];
      if (!kk || kk.purged_at) throw new Refuse(409, "Try again in a moment.");
      await runQuery(`INSERT OR IGNORE INTO story_saves (user_id, capture_id, created, kind, room_id, room_title, subject, by_name, source, nsfw, captured)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [acct.userId, row.id, NOW(), row.kind, row.room || null, R ? R.title : row.room || null, String(row.subject || "").slice(0, 60) || null,
                      String(row.by_user || "").slice(0, 60) || null, row.source === "stage" ? "stage" : row.source === "user" ? "user" : "cam",
                      Number(row.nsfw) ? 1 : 0, Number(row.created) || null]);
      if (mic) await claimPeople(row);          // mic keep: (again, idempotent) the people record with the save, from the live rows
    });
  } catch (e) {
    // review fix: ensureKeep's copy (and its people rows) committed, but this save didn't - a copy nobody saves is purged now
    await purgeOrphanKeep(row.id).catch((e2) => console.error("[storykeep] orphan copy after a failed save:", e2.message));
    throw e;
  }
  // mic keep: someone who went private between the recheck and the durable rows takes the copies down now (an error: the sweep's).
  // Review fix: a failure that's only about this saver (their blocks, cam rules) undoes only their save (undoMicCopy)
  if (mic && (await micPeopleWhy(await keptCapture(row.id), [acct.userId])) === "person") {
    await undoMicCopy(row.id, { saver: acct.userId });
    throw micRefuse("person");
  }
  return { saved: true, again: false };
}
/**
 * mic keep review: the recheck after a save / post was written said "person" for this actor. When someone shown is private, hidden
 * or gone for EVERYONE (personState - not the actor's blocks or cam rules), every copy goes (onCaptureRemoved). Otherwise only the
 * actor's new copy: their save (the copy with it when nobody else saves it), or the post just made (taken down, its claim deleted -
 * it was never really posted, so it may be posted later). Never throws past its own lookups' errors.
 */
async function undoMicCopy(captureId, { saver = null, postId = null } = {}) {
  let everyone = false;
  try { everyone = (await keptStates([captureId])).get(captureId) === "private"; } catch (e) { everyone = false; }
  if (everyone) return onCaptureRemoved(captureId, { reason: "private" });
  if (saver) {
    await runQuery("DELETE FROM story_saves WHERE user_id = ? AND capture_id = ?", [String(saver), captureId]);
    await purgeOrphanKeep(captureId);
  }
  if (postId) {
    await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'capture', delete_reason = 'the post was undone' WHERE id = ? AND deleted_at IS NULL", [NOW(), postId]);
    await runQuery("DELETE FROM story_posts WHERE capture_id = ? AND post_id = ?", [captureId, postId]);
    await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [postId]).catch(() => {});
  }
  await dropPeopleIfNoCopy(captureId);
  return null;
}
async function purgeKeep(captureId, reason) {
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ? AND purged_at IS NULL", [captureId]))[0];
  if (!k) return false;
  dropFiles(k);
  await runQuery("UPDATE story_keeps SET purged_at = ?, purge_reason = ? WHERE capture_id = ?", [NOW(), reason || null, captureId]);
  await dropPeopleIfNoCopy(captureId);           // mic keep: the people record goes with the capture's last copy
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
  // mic keep: a saved mic-stage copy is checked against everyone it shows (keptStates) - someone private now takes it (and every
  // other copy) down; a lookup that fails only leaves it out of this list (nothing is deleted on an error)
  let micState = new Map();
  try { micState = await keptStates(rows.map((r) => r.capture_id)); } catch (e) { console.error("[storykeep] saved mic check:", e.message); micState = null; }
  const out = [];
  for (const r of rows) {
    if (Number(r.m_anon)) { await onCaptureRemoved(r.capture_id, { reason: "private" }); continue; }
    if (micState === null && r.source === "stage") continue;
    const ms = micState && micState.get(r.capture_id);
    if (ms === "private") { await onCaptureRemoved(r.capture_id, { reason: "private" }); continue; }
    if (ms === "error") continue;
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
    // mic keep review: a mic post is judged by its feed post - one still up is taken down even with a stale removed_at
    const fp = await tableThere("feed_posts");
    const sp = (await getQuery(`SELECT * FROM story_posts WHERE capture_id = ? AND post_id IS NOT NULL AND (removed_at IS NULL${fp
      ? " OR (stream = 'mic' AND EXISTS (SELECT 1 FROM feed_posts p WHERE p.id = story_posts.post_id AND p.deleted_at IS NULL))" : ""})`, [id]))[0];
    if (sp) {
      const t = NOW();
      await runQuery(`UPDATE feed_posts SET deleted_at = ?, deleted_by = 'capture', delete_reason = ? WHERE id = ? AND deleted_at IS NULL`,
                     [t, reason === "private" ? "the person in it went private" : "the capture was taken down", sp.post_id]);
      await runQuery("UPDATE story_posts SET removed_at = ?, removed_by = 'capture', removed_reason = ? WHERE capture_id = ?", [t, reason, id]);
      post = true;
    }
  }
  await dropPeopleIfNoCopy(id);                  // mic keep: no copy left -> the people record goes (a post that stays keeps it)
  if (del.changes || post) console.log(`[storykeep] capture ${id} ${reason}: ${del.changes} save(s) dropped${post ? ", its post hidden" : ""}`);
  return { saves: del.changes, post };
}
/**
 * mic keep review: a 🎙 mic-stage post that was deleted - by its author or an admin (feedstore.remove), account deletion, or any other
 * path (the hourly sweep finds those) - takes every saved copy of its capture with it. The people shown were told "Remove me also
 * deletes every saved copy", and nobody but staff can open a deleted post to tap it. story_posts gets removed_at (no re-post) - which
 * also marks it done: a new save of the live 24 h capture afterwards stays possible (and isn't swept). A mic post with removed_at set
 * was handled by whatever set it (Remove me, the cascade: their saved copies went then). Does nothing while the feed post is up;
 * idempotent; never throws. -> did it?
 */
async function onPostDeleted(postId) {
  try {
    await init();
    const sp = (await getQuery("SELECT * FROM story_posts WHERE post_id = ? AND stream = 'mic'", [String(postId || "")]))[0];
    if (!sp || sp.removed_at != null || (await feedPostAlive(sp.post_id))) return false;
    const t = NOW();
    const del = await tx(async () => {
      const d = await runQuery("DELETE FROM story_saves WHERE capture_id = ?", [sp.capture_id]);
      await runQuery(`UPDATE story_posts SET removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'post-deleted'),
                      removed_reason = COALESCE(removed_reason, 'post deleted') WHERE capture_id = ?`, [t, sp.capture_id]);
      return d.changes || 0;
    });
    await purgeKeep(sp.capture_id, "post-deleted");
    await dropPeopleIfNoCopy(sp.capture_id);
    if (del) console.log(`[storykeep] mic post ${sp.post_id} deleted: ${del} saved cop${del === 1 ? "y" : "ies"} of capture ${sp.capture_id} dropped`);
    return true;
  } catch (e) { console.error("[storykeep] mic post deleted:", e.message); return false; }
}

// ── mic keep: copies go when someone they show goes private or deletes their account ──
// Hooks: profilelayout.save (onPeoplePrivate {userId}), hubhidden's set changing (hiddenChanged -> the hidden check), Pepe's
// /api/media/anon (onPeoplePrivate {logins}), account deletion (accountdelete.execute: keptOf wide + onCaptureRemoved). Backstop:
// sweepKept (hourly, register) and the read-time checks (savedFor, annotate). Lookup errors never remove anything.
/** quotes.isHidden only when it's sure: null while either hidden store is still loading (both then say "hidden" for everyone -
 *  right for showing, never a reason to delete). Replaceable in tests (_setHiddenCheck). */
function defaultHiddenCheck(login) {
  try {
    if (require("./hubhidden").loading()) return null;
    try { if (!require("./chatlog").hiddenReady()) return null; } catch (e) { /* no chat archive set in this build */ }
    return !!require("./quotes").isHidden(login);
  } catch (e) { return null; }
}
let hiddenCheck = defaultHiddenCheck;
function _setHiddenCheck(fn) { hiddenCheck = fn || defaultHiddenCheck; }
/** 1.99aid (privacy controls, review fixes 2 - Q4-A): for a cam drawn under a FROG NAME (role "vcam") - quotes.isBridgeOff only (left out
 *  now: !bridge hide or stricter), never the incognito half they were drawn under; null while the hidden stores load (as above). */
function defaultLeftOutCheck(login) {
  try {
    if (require("./hubhidden").loading()) return null;
    try { if (!require("./chatlog").hiddenReady()) return null; } catch (e) { /* no chat archive set in this build */ }
    return !!require("./quotes").isBridgeOff(login);
  } catch (e) { return null; }
}
let leftOutCheck = defaultLeftOutCheck;
function _setLeftOutCheck(fn) { leftOutCheck = fn || defaultLeftOutCheck; }
/**
 * One person a kept / posted copy shows (login, captured at `at`) for the cascade: "private" - hidden / incognito now (sure), an
 * account that had the login since `at` was deleted (micrec's marker; reaching a later holder only removes content), or an account
 * that had it at `at` (ownersAt) or has it now keeps its activity private (profile layout); "error" - a lookup failed; else "ok".
 * Review fixes: the profile read is the strict one (an unreadable layout is "error", never public); everything per login (the
 * hidden answer, the gone marker, the candidate accounts and their spans, the current holders) and per account (the profile) is read
 * once per `cache` - a sweep or a Saved page costs one walk per distinct login, not one per row.
 */
async function personState(login, at, cache = new Map(), vcam = false) {
  const k = (vcam ? "vps|" : "ps|") + login + "|" + at;
  if (cache.has(k)) return cache.get(k);
  let st = "ok";
  try {
    const kh = (vcam ? "leftout|" : "hid|") + login;          // (review fixes 2 - Q4-A; never loginOwners' "lo|" key)
    if (!cache.has(kh)) cache.set(kh, vcam ? leftOutCheck(login) : hiddenCheck(login));
    const h = cache.get(kh);
    if (h === null) st = "error";
    else if (h) st = "private";
    else if ((await goneAtCached(login, cache)) > at) st = "private";
    else {
      const owners = new Set(await ownersAt(login, at, cache));
      const kc = "cur|" + login;
      if (!cache.has(kc)) cache.set(kc, (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [lc(login)])).map((r) => String(r.userId)));
      for (const uid of cache.get(kc)) owners.add(uid);
      for (const uid of owners) if (await layoutHidden(uid, cache)) { st = "private"; break; }
    }
  } catch (e) { console.error("[storykeep] mic person check:", e.message); st = "error"; }
  cache.set(k, st);
  return st;
}
/** Captures (of `captureIds`, or every one with durable rows) -> Map capture id -> "private" | "error" | "ok" by everyone they show. */
async function keptStates(captureIds = null, cache = new Map()) {
  await init();
  const ids = captureIds ? [...new Set(captureIds.map(String))] : null;
  if (ids && !ids.length) return new Map();
  const rows = ids ? await getQuery(`SELECT * FROM story_keep_people WHERE capture_id IN (${ids.map(() => "?").join(",")})`, ids)
    : await getQuery("SELECT * FROM story_keep_people");
  const out = new Map();
  for (const r of rows) {
    const st = await personState(lc(r.login), Number(r.captured_at) || 0, cache, r.role === "vcam");
    const was = out.get(r.capture_id);
    if (st === "private" || was === "private") out.set(r.capture_id, "private");
    else if (st === "error" || was === "error") out.set(r.capture_id, "error");
    else out.set(r.capture_id, "ok");
  }
  return out;
}
/**
 * The durable rows that show `userId` - each row's login inside a span in which it was the account's at captured_at
 * (stagecap.ownSpans; `wide` for account deletion). `login` undefined = the account's login now. Errors throw.
 * -> [{capture_id, login, role, captured_at}]
 */
async function keptOf(userId, login, upto = NOW(), { wide = false } = {}) {
  await init();
  if (!userId) return [];
  let l = login;
  if (l === undefined) { const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0]; l = u && u.camfrogUsername ? u.camfrogUsername : null; }
  const out = new Map();
  for (const w of await require("./stagecap").ownSpans(userId, l ? lc(l) : null, upto, { wide })) {
    for (const r of await getQuery("SELECT * FROM story_keep_people WHERE login = ? AND captured_at > ? AND captured_at <= ?", [w.login, Number(w.from) || 0, Number(w.to) || 0])) {
      out.set(r.capture_id + "|" + r.login, r);
    }
  }
  return [...out.values()];
}
/** Someone shown went private: every kept / posted copy showing them goes. `logins`: by login (Pepe's /api/media/anon, the hidden
 *  set); `userId`: an account whose profile NOW hides Analytics or Rooms (its spans, wide). Never throws. -> captures taken down */
async function onPeoplePrivate({ logins = [], userId = null, named = [] } = {}) {
  try {
    await init();
    const caps = new Set();
    const ls = [...new Set((logins || []).map(lc).filter(Boolean))];
    if (ls.length) for (const r of await getQuery(`SELECT DISTINCT capture_id FROM story_keep_people WHERE login IN (${ls.map(() => "?").join(",")})`, ls)) caps.add(r.capture_id);
    // (review fixes 2 - Q4-A: `named` - only the rows that show them by name, never a frog-name cam row; the hidden sweep's incognito half)
    const ns = [...new Set((named || []).map(lc).filter(Boolean))];
    if (ns.length) for (const r of await getQuery(`SELECT DISTINCT capture_id FROM story_keep_people WHERE role <> 'vcam' AND login IN (${ns.map(() => "?").join(",")})`, ns)) caps.add(r.capture_id);
    if (userId && (await layoutHidden(userId))) {             // review fix: the strict read (unreadable: nothing removed here)
      for (const r of await keptOf(userId, undefined, NOW(), { wide: true })) caps.add(r.capture_id);
    }
    for (const id of caps) await onCaptureRemoved(id, { reason: "private" });
    return caps.size;
  } catch (e) { console.error("[storykeep] mic cascade:", e.message); return 0; }
}
/** hubhidden's set changed (incognito / !bridge hide): the hidden check over the durable rows, debounced. */
let hiddenTimer = null;
function hiddenChanged() {
  if (hiddenTimer) return;
  hiddenTimer = setTimeout(() => { hiddenTimer = null; sweepHidden().catch((e) => console.error("[storykeep] hidden sweep:", e.message)); }, 2000);
  if (hiddenTimer.unref) hiddenTimer.unref();
}
async function sweepHidden() {
  await init();
  // (review fixes 2 - Q4-A: a frog-name cam row goes when its person is LEFT OUT; hidden by incognito alone takes only the named rows)
  const rows = await getQuery("SELECT DISTINCT login, role FROM story_keep_people");
  const out = new Set(), named = new Set();
  for (const r of rows) {
    const l = lc(r.login);
    if (r.role === "vcam") { if (leftOutCheck(l) === true) out.add(l); }
    else if (hiddenCheck(l) === true) named.add(l);
  }
  return out.size || named.size ? onPeoplePrivate({ logins: [...out], named: [...named] }) : 0;
}
/** The backstop (hourly, register): rows of captures with no copy left go; copies showing someone private now go. Cheap: one pass
 *  over story_keep_people. -> captures taken down. Review fixes, first: saved copies nobody saves any more (any capture, after a grace -
 *  purgeOrphanKeep) are purged; deleted mic posts whose saved copies are still here (a deletion path without the hook) drop them
 *  (onPostDeleted); the no-copy rows go in ONE statement; the private check reads each distinct login once (personState's cache). */
let sweeping = null;
function sweepKept() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    await init();
    const orphans = await getQuery(`SELECT capture_id FROM story_keeps k WHERE purged_at IS NULL AND COALESCE(created, 0) <= ?
                                    AND NOT EXISTS (SELECT 1 FROM story_saves s WHERE s.capture_id = k.capture_id)`, [NOW() - CLAIM_STALE_MS]);
    for (const r of orphans) await purgeOrphanKeep(r.capture_id, { grace: CLAIM_STALE_MS });
    if (await tableThere("feed_posts")) {
      const gone = await getQuery(`SELECT sp.post_id FROM story_posts sp JOIN feed_posts p ON p.id = sp.post_id
                                   WHERE sp.stream = 'mic' AND sp.removed_at IS NULL AND p.deleted_at IS NOT NULL`);
      for (const r of gone) await onPostDeleted(r.post_id);
    }
    await dropPeopleIfNoCopy(null);
    let n = 0;
    for (const [id, st] of await keptStates()) if (st === "private") { await onCaptureRemoved(id, { reason: "private" }); n++; }
    return n;
  })().finally(() => { sweeping = null; });
  return sweeping;
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
  const blocks = await privacyWhy(rows);
  const saved = new Set(saves.map((s) => s.capture_id));
  const postMap = new Map(posts.map((p) => [p.capture_id, p]));
  const links = await store().postLinks(posts.filter((p) => p.post_id && !p.removed_at).map((p) => p.post_id));
  const canMap = new Map();
  const micCache = new Map();                    // mic keep: one request's per-person lookups
  for (const c of items) {
    const r = byId.get(c.id);
    if (!r) { c.can = { post: false, save: false }; continue; }
    let priv = blocks.has(r.id);
    const live = !goneWhy(r);
    const sp = postMap.get(r.id);
    const key = r.room + "|" + (isCapturer(acct, r) ? "c" : "");
    if (!canMap.has(key)) canMap.set(key, await mayPost(acct, r));
    const hasPad = !!(r.room && rooms.getCached(r.room));
    // mic keep: the read-time per-person recheck - this viewer for 🔖, and the credited capturer too for 📌 (an error = no button)
    let micPost = true;
    if (isMic(r) && !priv && live) {
      const mc = await micCapture(r.id).catch(() => null);
      priv = !!(await micPeopleWhy(mc, [acct.userId], micCache, { owners: false }));
      micPost = !priv && (!r.by_user_id || r.by_user_id === acct.userId || !(await micPeopleWhy(mc, [r.by_user_id], micCache, { owners: false })));
    }
    c.saved = saved.has(r.id);
    c.posted = sp && sp.post_id && !sp.removed_at ? links.get(sp.post_id) || null : null;
    c.can = { post: r.source !== "user" && !priv && micPost && live && hasPad && !(sp && sp.removed_at) && canMap.get(key), save: !priv && live };
    if (priv) c.private = true;
  }
  return items;
}

// ── routes ──
function register(app, { addUser, noTimers = false }) {
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
    // mic keep: refusals with a locales/en.json key answer in the reader's language
    const msg = st === 500 ? "Something went wrong." : e.i18n && res.req && typeof res.req.t === "function" ? res.req.t(e.i18n) : e.message;
    res.status(st).json({ ok: false, error: msg });
  };
  // mic keep: the cascade's hidden-set hook and the hourly backstop sweep (unref'd - never keeps the process up)
  try { require("./hubhidden").onChange(hiddenChanged); } catch (e) { console.error("[storykeep] hidden hook:", e.message); }
  if (!noTimers) {
    const t = setInterval(() => sweepKept().catch((e) => console.error("[storykeep] mic sweep:", e.message)), 60 * 60e3);
    if (t.unref) t.unref();
  }
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
                   isPadMod, Refuse, _setClock, _setModCheck, _setPersistImpl, defaultPersist,
                   // mic keep (handoff 16 follow-up): the cascade + account deletion / export hooks
                   onPeoplePrivate, hiddenChanged, sweepHidden, sweepKept, keptOf, keptStates, dropPeopleIfNoCopy, ownersAt, MIC, _setHiddenCheck,
                   _setLeftOutCheck,
                   onPostDeleted, purgeOrphanKeep,            // mic keep review: feedstore.remove / account deletion
                   _micPeopleWhy: micPeopleWhy };             // 1.99aid (privacy controls S3): tests - the per-person recheck by role
