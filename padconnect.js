// padconnect.js — connect a pad to a platform (1.99ja): Camfrog (verified), Twitch (OAuth-linked channel), Discord (later).
//
// A pad made on the site is a SITE pad (patv:<x>). Its owner can connect it:
//
// CAMFROG — prove you run the room, then the pad becomes that room's pad.
//   1. The owner types the Camfrog room's name (Settings -> Address & platform) and gets a one-time code, PATV-XXXXXX
//      (48 h). Optional: "I'd like Pepe in my room" (join_opt_in).
//   2. Proof, either way:
//      - TOPIC (instant): the code goes in the room's topic, which only the room's owner / operators can set. Pepe checks
//        the topics of the rooms he's in against the pending codes (they ride along on his 2-minute owner sync) and
//        posts the match to POST /api/pads/verify {via: "topic"}; the site also checks the topic of any room the bridge
//        shows, every minute and on "Check now".
//      - COMMAND (needs a site admin's OK): anyone in the room types !verifypad PATV-XXXXXX; Pepe posts who typed it
//        (via: "command"). That proves someone in the room has the code, not that they run it, so the request goes to
//        "review" for a site admin (/pads/admin) - unless Pepe vouches the typer is one of his own admins.
//      A site admin can also approve a request by hand (with Pepe's evidence of the room's id) or deny it.
//      Pepe has to be IN the room to see either. If he isn't, the request waits; a site Admin can "Ask Pepe to visit"
//      (a website action "room.visit" [name, "visit"]: Pepe joins and leaves again after a while). He never joins a
//      room on his own for this.
//   3. On success the pad is re-keyed to the room's id (padrekey.js): its platform becomes camfrog, so it gets the room
//      bridge (switches for its owner), the room vault, owner !stage commands and royalties; the feed, follows, stories,
//      settings and the chosen address come along. If the room already had an UNOWNED pad (Pepe bridged it before) the
//      two merge (the site pad's settings win; the room's old address redirects). A room whose pad has an owner, or a
//      house room, can't be taken - a site admin decides those (Pads admin: owners).
//   4. Pepe JOINING the room: only when the owner opted in AND a site Admin approves it (join_status requested ->
//      approved: the website action room.visit [name, "stay"] - Pepe joins and puts it on his auto-join list). Pepe's
//      existing auto-join list and admins' !joinroom are untouched.
//   Disconnecting re-keys the pad back to a site pad (its old patv: id when free) with its feed; what belongs to the
//   Camfrog room (bridge log, room stats, room vault, royalties) stays with the room, which gets a fresh unowned pad if
//   Pepe is still in it.
//
// TWITCH — the owner's PATV account must have Twitch linked through the existing OAuth sign-in (users.twitchId +
//   twitchLogin, twitchlogin.js); that login IS the proof. The pad keeps its id; its platform becomes twitch and its
//   Live tab embeds the channel's player (stageembed.js). One pad per channel. twitchChatHook() is where a Twitch chat
//   bridge plugs in later (nothing reads Twitch chat yet).
//
// DISCORD — the schema takes it (platform 'discord'); the UI says "coming later" and the API refuses.
//
//   pad_connections  id, room_id (the pad, follows re-keys), platform, external_id (Camfrog room id / Twitch login /
//                    Discord server id), external_name (what the owner typed / the room's display name), status (pending |
//                    review | verified | denied | cancelled | expired | disconnected), code, code_expires, method (topic |
//                    command | pepe-admin | admin | oauth), evidence (JSON), requested_by, requested_at, verified_at,
//                    verified_by, join_opt_in, join_status (none | requested | approved | denied), join_by, join_at, orig_id
//                    (the pad's id before a Camfrog connect), chat_bridge (0; the Twitch chat hook), note, updated
//
//   owner:  GET  /api/rooms/:slug/connect                        the state
//           POST /api/rooms/:slug/connect/camfrog {room, join}   start (a new code; replaces a pending one)
//           POST /api/rooms/:slug/connect/camfrog/check          check the topic now (bridged rooms)
//           POST /api/rooms/:slug/connect/camfrog/join {on}      opt in / out of Pepe joining
//           POST /api/rooms/:slug/connect/twitch                 connect the owner's linked Twitch channel
//           POST /api/rooms/:slug/connect/discord                501 "coming later"
//           POST /api/rooms/:slug/disconnect {platform, confirm}  back to a site pad (camfrog / twitch), or cancel a pending one
//   admins: GET  /api/pads/connections                           the queue    POST /api/pads/connections/:id/:op
//           (op: approve | deny | visit | join | nojoin - visit / join queue Pepe actions, site Admins only)
//   Pepe:   POST /api/pads/verify {password, room, room_name, code, via, by, admin}; the owner sync carries pad_verify
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const CODE_TTL = 48 * 3600e3;
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^PATV-[A-Z2-9]{6}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'~\-]{1,63}$/;
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}$/;
const OPEN_SLOTS = "('waiting','active')";
const PLATFORMS = ["camfrog", "twitch", "discord"];
let NOW = () => Date.now();

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isAdmin = (u) => !!u && u.class === "Admin";

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await rooms.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, platform TEXT NOT NULL, external_id TEXT, external_name TEXT,
        status TEXT NOT NULL, code TEXT, code_expires INTEGER, method TEXT, evidence TEXT,
        requested_by TEXT, requested_at INTEGER, verified_at INTEGER, verified_by TEXT,
        join_opt_in INTEGER NOT NULL DEFAULT 0, join_status TEXT NOT NULL DEFAULT 'none', join_by TEXT, join_at INTEGER,
        orig_id TEXT, chat_bridge INTEGER NOT NULL DEFAULT 0, note TEXT, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pad_connections_room ON pad_connections (room_id, platform, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS pad_connections_code ON pad_connections (code)");
      await runQuery("CREATE INDEX IF NOT EXISTS pad_connections_ext ON pad_connections (platform, external_id, status)");
    })().catch((e) => { console.error("[padconnect] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

function newCode() {
  const b = crypto.randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length];
  return "PATV-" + s;
}
const cleanCode = (c) => { const s = String(c || "").trim().toUpperCase().replace(/^PATV(?!-)/, "PATV-"); return CODE_RE.test(s) ? s : null; };
const tx = (fn) => require("./mainstage")._tx(fn);
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

function view(c) {
  if (!c) return null;
  return { id: c.id, room_id: c.room_id, platform: c.platform, external_id: c.external_id, external_name: c.external_name, status: c.status,
           code: c.code, code_expires: c.code_expires, method: c.method, evidence: parse(c.evidence), requested_at: c.requested_at,
           verified_at: c.verified_at, join_opt_in: !!c.join_opt_in, join_status: c.join_status, orig_id: c.orig_id, note: c.note || "" };
}
/** The live (pending / review / verified) connection of a pad on one platform, or null. */
async function current(roomId, platform) {
  await init();
  return view((await getQuery(`SELECT * FROM pad_connections WHERE room_id = ? AND platform = ? AND status IN ('pending','review','verified')
                               ORDER BY id DESC LIMIT 1`, [roomId, platform]))[0]);
}
async function byId(id) { await init(); return (await getQuery("SELECT * FROM pad_connections WHERE id = ?", [Number(id) || 0]))[0] || null; }

async function mustOwn(user, R) {
  if (!R) throw new Refuse(404, "No such pad.");
  if (R.profile || rooms.isProfile(R.id)) throw new Refuse(400, "Profiles can't be connected.");
  if (R.house) throw new Refuse(403, "House pads are run by the site.");
  if (!(await rooms.canManage(user, R.id))) throw new Refuse(403, "Only this pad's owner (or a site admin) can do that.");
  if (!R.owner || !R.owner.userId) throw new Refuse(400, "A pad needs an owner to be connected.");
}
async function openSlots(roomId) {
  try { return (await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE room_id = ? AND status IN ${OPEN_SLOTS}`, [roomId]))[0].n; }
  catch (e) { return 0; }
}

/** An account's Twitch link: {twitchId, twitchLogin} (columns that a minimal DB lacks read as null). */
async function twitchOfUser(userId) {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const c = (k) => (cols.has(k) ? k : `NULL AS ${k}`);
  return (await getQuery(`SELECT ${c("twitchId")}, ${c("twitchLogin")} FROM users WHERE userId = ?`, [String(userId || "")]))[0] || {};
}

/** What the settings card shows. */
async function state(R, viewer) {
  await init();
  const platform = R.platform || rooms.platformOf(R.id);
  const own = R.owner ? await twitchOfUser(R.owner.userId) : {};
  const tw = require("./twitchlogin").clean(own.twitchLogin);
  const cf = await current(R.id, "camfrog");
  return {
    platform, staff: rooms.isStaff(viewer), admin: isAdmin(viewer), house: !!R.house, ownerIsViewer: !!(R.owner && viewer && R.owner.userId === viewer.userId),
    camfrog: cf, twitch: await current(R.id, "twitch"), discord: null,
    twitchLinked: !!own.twitchId, twitchLogin: tw, code_ttl_h: CODE_TTL / 3600e3,
    pepeIn: cf && cf.status === "verified" ? pepeIn(R.id) : null,
  };
}
function pepeIn(roomId) {
  try { return require("./bridge").pepeIn(roomId) === true; } catch (e) { return null; }
}

// ── Camfrog ──
/** A room the bridge shows whose id or display name is `name`, or null. */
function bridgeRoom(name) {
  const n = norm(name);
  if (!n) return null;
  try {
    for (const B of require("./bridge")._rooms.values()) if (norm(B.id) === n || norm(B.name) === n) return B;
  } catch (e) { /* no bridge */ }
  return null;
}
/** Can pad R (owned by ownerId) become the pad of Camfrog room `roomId`? -> null or why not. */
async function targetProblem(R, roomId) {
  if (!ROOM_ID_RE.test(String(roomId || ""))) return "That isn't a Camfrog room id Pepe can use.";
  if (roomId === rooms.HOUSE_ROOM || ["PepeFrog.Room", "PepeBeta.Room"].includes(roomId)) return "That's Pepe's own room.";
  const T = await rooms.get(roomId);
  if (!T) return null;
  if (T.id === R.id) return "This pad already is that room's pad.";
  if (T.house) return "That's one of Pepe's house rooms.";
  if (T.platform !== "camfrog") return "Another pad already uses that id.";
  if (T.owner && R.owner && T.owner.userId === R.owner.userId) return `You already own that room's pad (p/${T.slug}). Ask a site admin to merge them.`;
  if (T.owner) return "That room's pad already has an owner. Ask a site admin if that's wrong.";
  return null;
}

async function requestCamfrog(user, R, { room, join } = {}) {
  await init();
  await mustOwn(user, R);
  if ((R.platform || rooms.platformOf(R.id)) !== "site") {
    throw new Refuse(400, R.platform === "camfrog" ? "This pad is already a Camfrog pad." : "Disconnect this pad from " + R.platform + " first.");
  }
  const name = String(room == null ? "" : room).replace(/\s+/g, " ").trim().slice(0, 64);
  if (!NAME_RE.test(name)) throw new Refuse(400, "Type the Camfrog room's name as it shows on its tab (letters, digits, spaces, . _ - ' ~).");
  const B = bridgeRoom(name);
  const p = await targetProblem(R, B ? B.id : name.replace(/ /g, "_"));
  if (p && (B || ROOM_ID_RE.test(name))) throw new Refuse(409, p);
  const t = NOW();
  const code = newCode();
  await tx(async () => {
    await runQuery("UPDATE pad_connections SET status = 'cancelled', updated = ?, note = 'replaced by a new code' WHERE room_id = ? AND platform = 'camfrog' AND status IN ('pending','review')", [t, R.id]);
    await runQuery(`INSERT INTO pad_connections (room_id, platform, external_id, external_name, status, code, code_expires, requested_by, requested_at, join_opt_in, updated)
                    VALUES (?, 'camfrog', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
                   [R.id, B ? B.id : null, B ? B.name || name : name, code, t + CODE_TTL, user.userId, t, join ? 1 : 0, t]);
  });
  await rooms.event(R.id, "pad-connect", user.username || "?", `Camfrog room "${name}": code issued${join ? " (asks for Pepe to join)" : ""}`);
  return current(R.id, "camfrog");
}

async function setJoin(user, R, on) {
  await init();
  await mustOwn(user, R);
  const c = await current(R.id, "camfrog");
  if (!c) throw new Refuse(404, "This pad isn't connected to a Camfrog room.");
  if (c.join_status === "approved" && on) return c;
  const status = !on ? "none" : c.status === "verified" ? "requested" : "none";
  await runQuery("UPDATE pad_connections SET join_opt_in = ?, join_status = CASE WHEN join_status = 'approved' AND ? = 0 THEN 'approved' ELSE ? END, updated = ? WHERE id = ?",
                 [on ? 1 : 0, on ? 1 : 0, status, NOW(), c.id]);
  await rooms.event(R.id, "pad-connect", user.username || "?", on ? "asks for Pepe to join the room" : "no longer asks for Pepe to join");
  if (on && status === "requested") await tellAdmins(`Pepe join request: p/${R.slug}`, `${R.title} asks for Pepe to join its Camfrog room ${c.external_name || c.external_id}.`);
  return current(R.id, "camfrog");
}

async function tellAdmins(title, body) {
  try {
    for (const a of await getQuery("SELECT userId FROM users WHERE class = 'Admin'")) {
      await rooms.notify(a.userId, { kind: "stage", title, body, link: "/pads/admin#padconn", pm: false });
    }
  } catch (e) { console.error("[padconnect] admins:", e.message); }
}

/**
 * Finish a Camfrog connection: re-key the pad to the room. conn = a pad_connections row (pending / review), roomId = the
 * Camfrog room's id (Pepe's evidence), roomName = its display name. -> the pad (view) or throws Refuse.
 */
async function finishCamfrog(connId, { roomId, roomName, method, actor, evidence } = {}) {
  await init();
  const out = await tx(async () => {
    const c = (await getQuery("SELECT * FROM pad_connections WHERE id = ?", [connId]))[0];
    if (!c || !["pending", "review"].includes(c.status)) return { already: true, c };
    const R = await rooms.get(c.room_id);
    if (!R || R.platform !== "site" || !R.owner || R.owner.userId !== c.requested_by && !(await isStaffId(c.requested_by))) {
      await runQuery("UPDATE pad_connections SET status = 'cancelled', note = 'the pad changed', updated = ? WHERE id = ?", [NOW(), c.id]);
      throw new Refuse(409, "That pad changed since the request (owner or platform) - start again.");
    }
    const target = String(roomId || c.external_id || "").trim();
    const why = await targetProblem(R, target);
    if (why) {
      await runQuery("UPDATE pad_connections SET status = 'denied', note = ?, updated = ? WHERE id = ?", [why.slice(0, 200), NOW(), c.id]);
      throw new Refuse(409, why);
    }
    if (await openSlots(R.id)) throw new Refuse(409, "This pad's stage has live or waiting slots - end them first, then try again.");
    const T = await rooms.get(target);
    const t = NOW();
    if (T) await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [T.id]);           // its rows merge below; its old address redirects
    const res = await require("./padrekey").rekey(R.id, target);
    await runQuery("UPDATE rooms_registry SET room_id = ?, platform = 'camfrog', updated = ? WHERE room_id = ?", [target, t, R.id]);
    if (T && T.slug && T.slug !== R.slug && !(await getQuery("SELECT 1 FROM rooms_registry WHERE slug = ?", [T.slug])).length) {
      await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [T.slug, target, t, "connect"]);
    }
    await runQuery("UPDATE pad_connections SET room_id = ? WHERE room_id = ?", [target, R.id]);
    await runQuery(`UPDATE pad_connections SET status = 'verified', method = ?, verified_at = ?, verified_by = ?, external_id = ?, external_name = ?,
                    evidence = ?, orig_id = ?, join_status = CASE WHEN join_opt_in = 1 THEN 'requested' ELSE join_status END, updated = ? WHERE id = ?`,
                   [method || "admin", t, actor || null, target, String(roomName || c.external_name || target).slice(0, 100),
                    JSON.stringify(Object.assign(parse(c.evidence) || {}, evidence || {})).slice(0, 2000), R.id, t, c.id]);
    return { R, T, target, moved: res.moved, c };
  });
  if (out.already) return rooms.get((out.c && out.c.room_id) || "");
  await require("./padrekey").reloadCaches();
  const P = await rooms.get(out.target);
  try { require("./bridge").reslug(out.target); } catch (e) { /* no bridge */ }
  await rooms.event(out.target, "pad-connected", actor || "?", `Camfrog room ${out.target}${out.T ? " (merged its unowned pad p/" + out.T.slug + ")" : ""} via ${method}; was ${out.R.id}`);
  console.log(`[padconnect] ${out.R.id} -> ${out.target} (${method}) moved ${JSON.stringify(out.moved)}`);
  await rooms.notify(P.owner.userId, { kind: "stage", title: `p/${P.slug} is now the pad of Camfrog room ${out.target}`, pm: true,
    body: "Its room bridge, room vault and owner !stage commands are yours now.", link: "/p/" + encodeURIComponent(P.slug) + "/settings?tab=address" });
  if (out.c.join_opt_in) await tellAdmins(`Pepe join request: p/${P.slug}`, `${P.title} (Camfrog room ${out.target}) asks for Pepe to join.`);
  return P;
}
async function isStaffId(userId) {
  const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [userId || ""]))[0];
  return rooms.isStaff(u);
}

/** Pepe's report: a code in a room's topic, or !verifypad typed in a room. -> {ok, message, status} */
async function verifyFromPepe(b) {
  await init();
  const code = cleanCode(b.code);
  const roomId = String(b.room || "").trim().slice(0, 128);
  const roomName = String(b.room_name || b.room || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const via = b.via === "topic" ? "topic" : "command";
  const by = String(b.by || "").trim().toLowerCase().slice(0, 60);
  if (!code) return { ok: false, message: "that isn't a pad code - they look like PATV-AB23CD" };
  const c = (await getQuery("SELECT * FROM pad_connections WHERE code = ? AND platform = 'camfrog' ORDER BY id DESC LIMIT 1", [code]))[0];
  if (!c || !["pending", "review"].includes(c.status)) return { ok: false, message: "no pad is waiting for that code (codes last 48 hours - get a new one in the pad's settings)" };
  if (Number(c.code_expires) < NOW()) {
    await runQuery("UPDATE pad_connections SET status = 'expired', updated = ? WHERE id = ?", [NOW(), c.id]);
    return { ok: false, message: "that code expired - get a new one in the pad's settings" };
  }
  const want = norm(c.external_name), wantId = norm(c.external_id);
  if (!(norm(roomId) === want || norm(roomName) === want || (wantId && norm(roomId) === wantId))) {
    return { ok: false, message: `that code is for the room "${c.external_name}", not this one` };
  }
  const R = await rooms.get(c.room_id);
  const slug = R ? R.slug : "?";
  const ev = { by: by || null, via, at: NOW(), room: roomId, room_name: roomName, pepe_admin: !!b.admin, topic: via === "topic" ? String(b.topic || "").slice(0, 200) : undefined };
  if (via === "topic" || b.admin) {
    try {
      await finishCamfrog(c.id, { roomId, roomName, method: via === "topic" ? "topic" : "pepe-admin", actor: via === "topic" ? "pepe:topic" : "pepe:" + by, evidence: { [via]: ev } });
      return { ok: true, status: "verified", message: `verified - p/${slug} is this room's pad on PATV now` };
    } catch (e) {
      if (e && e.refuse) return { ok: false, message: e.message };
      throw e;
    }
  }
  // a command from someone in the room: proof they're here with the code, not that they run the room -> a site admin decides
  const owner = R && R.owner ? (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [R.owner.userId]))[0] : null;
  ev.owner_login = !!(owner && owner.camfrogUsername && owner.camfrogUsername.toLowerCase() === by);
  const evidence = Object.assign(parse(c.evidence) || {}, { command: ev });
  await runQuery("UPDATE pad_connections SET status = 'review', external_id = ?, external_name = ?, evidence = ?, updated = ? WHERE id = ?",
                 [roomId || c.external_id, roomName || c.external_name, JSON.stringify(evidence).slice(0, 2000), NOW(), c.id]);
  if (c.status !== "review") await tellAdmins(`Pad connection to check: p/${slug}`, `${by || "someone"} typed the code in Camfrog room ${roomName || roomId}${ev.owner_login ? " (the pad owner's linked login)" : ""}.`);
  return { ok: true, status: "review", message: `got it - a site admin will confirm p/${slug} for this room. Put ${code} in the room topic to finish right away.` };
}

/** Pending codes for Pepe's topic check: [{code, room}] (the owner sync carries them). */
async function pendingForPepe() {
  await init();
  const rows = await getQuery(`SELECT code, external_id, external_name FROM pad_connections WHERE platform = 'camfrog' AND status IN ('pending','review')
                               AND code_expires > ? ORDER BY id DESC LIMIT 200`, [NOW()]);
  return rows.map((r) => ({ code: r.code, room: r.external_id || r.external_name, name: r.external_name }));
}

/** The site's own topic check: pending requests whose room the bridge shows. -> how many finished. */
async function checkTopics(onlyId = null) {
  await init();
  let n = 0;
  const rows = await getQuery(`SELECT * FROM pad_connections WHERE platform = 'camfrog' AND status IN ('pending','review') AND code_expires > ?${onlyId ? " AND id = ?" : ""}`,
                              onlyId ? [NOW(), onlyId] : [NOW()]);
  for (const c of rows) {
    const B = bridgeRoom(c.external_id || c.external_name) || bridgeRoom(c.external_name);
    if (!B || !B.topic || !String(B.topic).toUpperCase().includes(c.code)) continue;
    try {
      await finishCamfrog(c.id, { roomId: B.id, roomName: B.name, method: "topic", actor: "site:topic", evidence: { topic: { at: NOW(), via: "bridge", topic: String(B.topic).slice(0, 200) } } });
      n++;
    } catch (e) { if (!(e && e.refuse)) console.error("[padconnect] topic:", e.message); }
  }
  return n;
}
async function expire() {
  await init();
  await runQuery("UPDATE pad_connections SET status = 'expired', updated = ? WHERE status IN ('pending','review') AND code_expires < ?", [NOW(), NOW()]);
}

/** Back to a site pad (Camfrog / Twitch), or cancel a pending Camfrog request. */
async function disconnect(user, R, platform) {
  await init();
  await mustOwn(user, R);
  const P = String(platform || "").toLowerCase();
  if (P === "camfrog") {
    const cur = await current(R.id, "camfrog");
    if (cur && cur.status !== "verified") {
      await runQuery("UPDATE pad_connections SET status = 'cancelled', note = 'cancelled by the owner', updated = ? WHERE id = ?", [NOW(), cur.id]);
      await rooms.event(R.id, "pad-connect", user.username || "?", "cancelled the Camfrog request");
      return rooms.get(R.id);
    }
    if (R.platform !== "camfrog") throw new Refuse(400, "This pad isn't connected to a Camfrog room.");
    if (await openSlots(R.id)) throw new Refuse(409, "This pad's stage has live or waiting slots - end them first.");
    let to = cur && cur.orig_id && /^patv:/.test(cur.orig_id) && !(await rooms.get(cur.orig_id)) ? cur.orig_id : null;
    if (!to) {
      for (;;) { to = "patv:" + crypto.randomBytes(6).toString("hex"); if (!(await getQuery("SELECT 1 FROM rooms_registry WHERE room_id = ?", [to])).length) break; }
    }
    const t = NOW();
    const from = R.id;
    const res = await tx(async () => {
      const r = await require("./padrekey").rekey(from, to);
      await runQuery("UPDATE rooms_registry SET room_id = ?, platform = 'site', slug_set = 1, updated = ? WHERE room_id = ?", [to, t, from]);
      await runQuery("UPDATE pad_connections SET room_id = ? WHERE room_id = ?", [to, from]);
      if (cur) await runQuery("UPDATE pad_connections SET status = 'disconnected', note = ?, updated = ? WHERE id = ?", [`disconnected by ${user.username || "?"}`, t, cur.id]);
      return r;
    });
    await require("./padrekey").reloadCaches();
    // the bridge's live room (if Pepe is still in it) stops showing the pad's address; it gets its own unowned pad again
    try {
      const B = require("./bridge")._rooms.get(from);
      if (B) { await rooms.noteBridged(from, B.name); require("./bridge").reslug(from); }
    } catch (e) { /* no bridge */ }
    await rooms.event(to, "pad-disconnected", user.username || "?", `from Camfrog room ${from}; now a site pad (${to})`);
    console.log(`[padconnect] ${from} -> ${to} (disconnect) moved ${JSON.stringify(res.moved)}`);
    return rooms.get(to);
  }
  if (P === "twitch") {
    const cur = await current(R.id, "twitch");
    if (R.platform !== "twitch" && !cur) throw new Refuse(400, "This pad isn't connected to Twitch.");
    await tx(async () => {
      await runQuery("UPDATE rooms_registry SET platform = 'site', updated = ? WHERE room_id = ? AND platform = 'twitch'", [NOW(), R.id]);
      if (cur) await runQuery("UPDATE pad_connections SET status = 'disconnected', note = ?, updated = ? WHERE id = ?", [`disconnected by ${user.username || "?"}`, NOW(), cur.id]);
    });
    await rooms.loadCache();
    await rooms.event(R.id, "pad-disconnected", user.username || "?", `from Twitch ${cur ? cur.external_id : ""}`);
    return rooms.get(R.id);
  }
  throw new Refuse(400, "Unknown platform.");
}

// ── Twitch ──
async function connectTwitch(user, R) {
  await init();
  await mustOwn(user, R);
  if ((R.platform || rooms.platformOf(R.id)) !== "site") {
    throw new Refuse(400, R.platform === "twitch" ? "This pad is already a Twitch pad." : "Disconnect this pad from " + R.platform + " first.");
  }
  const own = await twitchOfUser(R.owner.userId);
  if (!own.twitchId) throw new Refuse(400, "Link Twitch to the owner's PATV account first (Sign in with Twitch).");
  const login = require("./twitchlogin").clean(own.twitchLogin);
  if (!login) throw new Refuse(400, "Sign in with Twitch once more so PATV knows the channel's name.");
  const taken = (await getQuery("SELECT room_id FROM pad_connections WHERE platform = 'twitch' AND external_id = ? AND status = 'verified' AND room_id != ?", [login, R.id]))[0];
  if (taken) throw new Refuse(409, `twitch.tv/${login} is already connected to another pad.`);
  const t = NOW();
  await tx(async () => {
    await runQuery("UPDATE rooms_registry SET platform = 'twitch', updated = ? WHERE room_id = ? AND platform = 'site'", [t, R.id]);
    await runQuery(`INSERT INTO pad_connections (room_id, platform, external_id, external_name, status, method, requested_by, requested_at, verified_at, verified_by, updated)
                    VALUES (?, 'twitch', ?, ?, 'verified', 'oauth', ?, ?, ?, ?, ?)`, [R.id, login, login, user.userId, t, t, user.username || null, t]);
  });
  await rooms.loadCache();
  await rooms.event(R.id, "pad-connected", user.username || "?", `Twitch channel twitch.tv/${login}`);
  return rooms.get(R.id);
}
/** The Twitch channel of a Twitch pad, or null. */
async function twitchOf(roomId) {
  if (rooms.platformOf(roomId) !== "twitch") return null;
  const c = await current(roomId, "twitch");
  return c && c.status === "verified" ? { login: c.external_id, chat_bridge: false } : null;
}
/** Hook for a later Twitch chat bridge: given a Twitch pad, the Twitch login whose chat would be relayed. Nothing calls it yet. */
async function twitchChatHook(roomId) {
  const t = await twitchOf(roomId);
  return t ? { login: t.login, enabled: false } : null;
}

// ── admins ──
async function queueList() {
  await init();
  const rows = await getQuery(`SELECT * FROM pad_connections WHERE (platform = 'camfrog' AND status IN ('pending','review'))
                               OR (status = 'verified' AND join_status = 'requested') ORDER BY updated DESC LIMIT 100`);
  return rows.map((c) => {
    const R = rooms.getCached(c.room_id);
    const B = bridgeRoom(c.external_id || c.external_name);
    return Object.assign(view(c), { pad: R ? { slug: R.slug, title: R.title, owner: R.owner ? R.owner.username : null } : null,
                                    bridged: !!B, room_id_seen: B ? B.id : null, expired: Number(c.code_expires) < NOW() && c.status !== "verified" });
  });
}
async function adminOp(admin, id, op, { note } = {}) {
  await init();
  if (!rooms.isStaff(admin)) throw new Refuse(403, "Site staff only.");
  const c = await byId(id);
  if (!c) throw new Refuse(404, "No such request.");
  const t = NOW();
  const name = c.external_name || c.external_id;
  if (op === "approve") {
    if (!["pending", "review"].includes(c.status)) throw new Refuse(409, "That request isn't waiting.");
    const B = bridgeRoom(c.external_id || c.external_name);
    const roomId = (B && B.id) || c.external_id || (ROOM_ID_RE.test(String(c.external_name || "")) ? c.external_name : null);
    if (!roomId) throw new Refuse(409, "Pepe hasn't seen that room yet, so its id isn't known - ask Pepe to visit first.");
    return { pad: await finishCamfrog(c.id, { roomId, roomName: (B && B.name) || name, method: "admin", actor: admin.username, evidence: { admin: { by: admin.username, at: t } } }) };
  }
  if (op === "deny") {
    if (!["pending", "review"].includes(c.status)) throw new Refuse(409, "That request isn't waiting.");
    await runQuery("UPDATE pad_connections SET status = 'denied', note = ?, updated = ? WHERE id = ?", [String(note || `denied by ${admin.username}`).slice(0, 200), t, c.id]);
    await rooms.event(c.room_id, "pad-connect", admin.username, `Camfrog request for "${name}" denied`);
    const R = await rooms.get(c.room_id);
    if (R && R.owner) await rooms.notify(R.owner.userId, { kind: "stage", title: `Your Camfrog connection for p/${R.slug} wasn't approved`, pm: false, body: note ? String(note).slice(0, 200) : "", link: "/p/" + encodeURIComponent(R.slug) + "/settings?tab=address" });
    return { ok: true };
  }
  if (op === "visit" || op === "join") {
    if (!isAdmin(admin)) throw new Refuse(403, "Only site Admins can send Pepe somewhere.");
    if (op === "join" && !(c.status === "verified" && c.join_opt_in)) throw new Refuse(409, "Pepe joins only a connected room whose owner asked for him.");
    if (op === "visit" && !["pending", "review"].includes(c.status)) throw new Refuse(409, "Visits are for requests that are waiting.");
    const id2 = await require("./actions").queue(admin.userId, { kind: "room.visit", args: [String(c.external_name || c.external_id), op === "join" ? "stay" : "visit"],
      tag: "pad-" + op, label: `Pepe ${op === "join" ? "joins" : "visits"} ${name}` });
    if (op === "join") await runQuery("UPDATE pad_connections SET join_status = 'approved', join_by = ?, join_at = ?, updated = ? WHERE id = ?", [admin.username, t, t, c.id]);
    await rooms.event(c.room_id, "pad-connect", admin.username, op === "join" ? `approved Pepe joining ${name}` : `asked Pepe to visit ${name} (to verify)`);
    return { ok: true, action: id2 };
  }
  if (op === "nojoin") {
    await runQuery("UPDATE pad_connections SET join_status = 'denied', join_by = ?, join_at = ?, updated = ? WHERE id = ?", [admin.username, t, t, c.id]);
    await rooms.event(c.room_id, "pad-connect", admin.username, `declined Pepe joining ${name}`);
    return { ok: true };
  }
  throw new Refuse(400, "Unknown action.");
}

function register(app, { addUser, isBotToken, noTimers = false }) {
  const json = require("express").json({ limit: "8kb" });
  const sameSite = (req, res, next) => {
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return res.status(403).json({ ok: false, error: "Cross-site request refused." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[padconnect]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const pad = async (req) => {
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) throw new Refuse(404, "No such pad.");
    return R;
  };
  app.get("/api/rooms/:slug/connect", addUser, needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await pad(req);
      if (!(await rooms.canManage(req.user, R.id))) throw new Refuse(403, "Only this pad's owner can see that.");
      res.json({ ok: true, ...(await state(R, req.user)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/connect/camfrog", addUser, needUser, json, sameSite, async (req, res) => {
    try { const R = await pad(req); res.json({ ok: true, camfrog: await requestCamfrog(req.user, R, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/connect/camfrog/check", addUser, needUser, json, sameSite, async (req, res) => {
    try {
      const R = await pad(req);
      await mustOwn(req.user, R);
      const c = await current(R.id, "camfrog");
      if (!c || c.status === "verified") return res.json({ ok: true, done: !!c, pad: R.slug });
      const n = await checkTopics(c.id);
      const after = n ? await rooms.get((await byId(c.id)).room_id) : null;
      res.json({ ok: true, done: !!n, pad: after ? after.slug : R.slug, bridged: !!bridgeRoom(c.external_id || c.external_name) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/connect/camfrog/join", addUser, needUser, json, sameSite, async (req, res) => {
    try { const R = await pad(req); res.json({ ok: true, camfrog: await setJoin(req.user, R, !!(req.body || {}).on) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/connect/twitch", addUser, needUser, json, sameSite, async (req, res) => {
    try { const R = await pad(req); const P = await connectTwitch(req.user, R); res.json({ ok: true, platform: P.platform }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/connect/discord", addUser, needUser, json, sameSite, (req, res) => {
    res.status(501).json({ ok: false, error: "Discord pads are coming later." });
  });
  app.post("/api/rooms/:slug/disconnect", addUser, needUser, json, sameSite, async (req, res) => {
    try {
      const R = await pad(req);
      const b = req.body || {};
      if (b.confirm !== true && b.confirm !== "yes") throw new Refuse(400, "Confirm first.");
      const P = await disconnect(req.user, R, b.platform);
      res.json({ ok: true, platform: P.platform, slug: P.slug, href: "/p/" + encodeURIComponent(P.slug) + "/settings?tab=address#connections" });
    } catch (e) { fail(res, e); }
  });
  // admins
  app.get("/api/pads/connections", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!rooms.isStaff(req.user)) return res.status(403).json({ ok: false, error: "Staff only." });
    try { res.json({ ok: true, items: await queueList() }); } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/connections/:id/:op", addUser, needUser, json, sameSite, async (req, res) => {
    try { res.json({ ok: true, ...(await adminOp(req.user, req.params.id, String(req.params.op || ""), req.body || {})) }); } catch (e) { fail(res, e); }
  });
  // Pepe
  app.post("/api/pads/verify", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken || !isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json(await verifyFromPepe(b)); } catch (e) { console.error("[padconnect] verify:", e); res.json({ ok: false, message: "the website couldn't check that right now" }); }
  });
  if (!noTimers) {
    const t = setInterval(() => { expire().then(() => checkTopics()).catch((e) => console.error("[padconnect] sweep:", e.message)); }, 60e3);
    if (t.unref) t.unref();
  }
}

module.exports = { init, register, state, current, requestCamfrog, setJoin, finishCamfrog, verifyFromPepe, pendingForPepe, checkTopics, expire,
                   disconnect, connectTwitch, twitchOf, twitchChatHook, queueList, adminOp, newCode, cleanCode, PLATFORMS, Refuse,
                   _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
