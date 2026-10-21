// adminchat.js — 💬 Admin › Chat hub (/admin/chat): the chat hub's break-glass form (S1 V1, release L1; ADR 0007 D3 and D15,
// OQ-19; CHAT-ARCHITECTURE §8.5, R-15 / CF F4). Server-rendered and it makes NO call to the chat hub, so it works while the
// hub is down: everything it shows and sets is v1's own - CHAT_HUB (chatswitches.js) and each pad's chat backend
// (padhub.js pad_hub.chat_backend), both mirrored to the hub by the seam (switches/changed, pads/changed: Q4's topics).
//
//   GET  /admin/chat            the page (views/admin/chat.ejs, public/js/admin-chat.js): CHAT_HUB, the pads on the hub and
//                               the site pads an owner may move there, the interlock (the twelve seam switches CHAT_HUB
//                               needs), the seam poster's status (huboutbox.status(): this site's queue, never the hub's)
//                               and the change log (admin_audit)
//   GET  /api/admin/chat        the same data as JSON
//   POST /api/admin/chat/hub    {on: true|false, reason, confirm?}                  CHAT_HUB on / off
//   POST /api/admin/chat/pad    {room_id, backend: "v1"|"hub", reason, confirm?}     a pad's chat backend
//
// Who: the page and turning OFF (CHAT_HUB off, a pad back to v1) need chat.breakglass (siteperms, locked at Admin - "ops"):
// any admin, one click (with a reason), never refused, so a rollback stays fast. Turning ON (CHAT_HUB on, a pad to hub) is a
// Pepe OWNER's - staffroles.ownerHolds(me, "chat.breakglass"): the Admin class AND the owner role on the linked chat login,
// read fresh from the database (the owner's 2026-10-16 rule: ops is owner-only) - with a confirm step the server enforces: an
// on-post without confirm: true answers 409 confirm with what would happen (`preview`) and writes nothing; the page asks with
// that, then posts again.
// Every change: a same-origin fetch (X-Requested-With: fetch + an Origin / Referer naming this host - authGuard.sameOriginFetch,
// the house pattern of adminkeys.js / backends.js), a required reason (cleanReason), an admin_audit row ("chat.switch" from
// chatswitches.set, after its commit; "chat.pad_backend" {room_id, slug, hub_pad_id, from, to} in the pad change's own
// transaction), Cache-Control: no-store. A change to the value already there writes nothing. CHAT_HUB on also needs the
// interlock (409 chat_hub_needs, `missing`); a pad moves to hub only when it is a site pad (409 site_pads_only - Camfrog pads
// keep their v1 chat in S1; hub_read is S2's: 409 hub_read_s2).
// The admin nav's Chat group (views/partials/admin-nav.ejs) opens here; V2 (release L4) adds the hub's moderation screens to
// the group as /admin/chat/{reports,held,modlog,bans,audit,switches} behind chat.mod_queue / chat.audit (MOD_VIEWS).
// Logs carry no reason, pad, account or switch value - only "[adminchat] <what>: <error>".
"use strict";
const { getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const CS = require("./chatswitches");
const PH = require("./padhub");

const CAP = "chat.breakglass";
const REASON_MAX = 200;                 // admin_audit keeps 200 characters
// ADR 0007 D1: the S1 pilot pads (site pads; Q4 seeds staff and canary), listed first among the pads an owner may move
const PILOT_PADS = ["patv:staff", "patv:canary", "patv:lounge"];
// V2's moderation screens in this group and the capability that opens each (ADR 0007 D15) - V2 hosts them
const MOD_VIEWS = { reports: "chat.mod_queue", held: "chat.mod_queue", modlog: "chat.mod_queue", bans: "chat.mod_queue",
                    audit: "chat.audit", switches: "chat.audit" };
const AUDIT = ["chat.switch", "chat.pad_backend"];

const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };
const refuse = (status, code, message, extra) => Object.assign(new Error(message), { status, code, refuse: true }, extra || {});

async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}
const isAdmin = (me) => SP.can(me, CAP);
const isOwner = async (me) => !!me && (await require("./staffroles").ownerHolds(me, CAP));

/** A reason as stored: control characters out, spaces folded, trimmed, at most REASON_MAX characters; "" when there is none. */
function cleanReason(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => { await CS.init(); await PH.init(); await require("./adminaudit").init(); })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── pads ──
const PAD_COLS = `r.room_id AS room_id, r.slug AS slug, r.title AS title, r.platform AS platform, h.hub_pad_id AS hub_pad_id,
                  h.chat_backend AS chat_backend, h.updated AS updated, h.updated_by AS updated_by`;
/** rooms.js's rule for a registry row's platform (the column, else what the id implies). */
function platformOf(r) {
  const rooms = require("./rooms");
  const p = String((r && r.platform) || "").toLowerCase();
  return rooms.PLATFORMS.includes(p) ? p : rooms.platformFromId(r && r.room_id);
}
const padView = (r) => ({ room_id: String(r.room_id), slug: r.slug || null, title: r.title || null, platform: platformOf(r),
                          hub_pad_id: r.hub_pad_id || null, backend: r.chat_backend == null ? "v1" : String(r.chat_backend),
                          updated: Number(r.updated) || null, updated_by: r.updated_by || null });
/** One pad with its hub id and backend (as stored), by room id; null when there is no such pad or it has no hub id. */
async function pad(roomId) {
  if (typeof roomId !== "string" || !roomId || roomId.length > 200) return null;
  const r = (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id WHERE r.room_id = ?`, [roomId]))[0];
  return r ? padView(r) : null;
}
/** The pads whose backend isn't v1 (the pads on the hub - and any value a hand edit left), by title. */
async function hubPads() {
  return (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id
                          WHERE h.chat_backend <> 'v1' ORDER BY lower(coalesce(r.title, r.slug)), r.room_id`)).map(padView);
}
/** Site pads still on v1 - what an owner may move to the hub - by title (the pilot pads first), at most 500. */
async function sitePadChoices() {
  const rows = (await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id
                                WHERE h.chat_backend = 'v1' ORDER BY lower(coalesce(r.title, r.slug)), r.room_id`)).map(padView)
    .filter((p) => p.platform === "site");
  const pin = PILOT_PADS.map((id) => rows.find((p) => p.room_id === id)).filter(Boolean);
  return pin.concat(rows.filter((p) => !PILOT_PADS.includes(p.room_id))).slice(0, 500);
}

/** The interlock's switches as stored now ({name: bool}) and the ones CHAT_HUB still needs. */
async function interlock() {
  const state = Object.fromEntries(CS.INTERLOCK.map((k) => [k, false]));
  for (const r of await getQuery("SELECT key, value FROM hubseam_settings").catch(() => [])) {
    if (Object.prototype.hasOwnProperty.call(state, r.key)) state[r.key] = r.value === "true";
  }
  return { state, missing: CS.needs(state) };
}

/** The newest /admin/chat changes (admin_audit), newest first. */
async function recentChanges(limit = 20) {
  const rows = await getQuery(`SELECT id, at, admin_name, action, detail, reason FROM admin_audit WHERE action IN (${AUDIT.map(() => "?").join(",")})
                               ORDER BY id DESC LIMIT ?`, [...AUDIT, Math.max(1, Math.min(200, Number(limit) || 20))]);
  return rows.map((r) => {
    let detail = null;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (e) { detail = null; }
    return { id: r.id, at: Number(r.at) || null, admin: r.admin_name || null, action: r.action, detail, reason: r.reason || null };
  });
}

/** The seam poster as this site sees it (huboutbox.status(): local state only - never a call to the hub). */
function posterOf(st) {
  if (!st) return null;
  const pick = (t) => (st.topics && st.topics[t]) || null;
  return { configured: !!st.configured, refusal: st.refusal || null, env: st.env || null, pending: Number(st.pending) || 0,
           oldest_pending: st.oldest_pending || null, last_post: st.last_post || null, heartbeat: st.heartbeat || null,
           failing: Object.keys(st.failing || {}), topics: { "switches/changed": pick("switches/changed"), "pads/changed": pick("pads/changed") } };
}

/** Everything the page shows. */
async function view(me) {
  await init();
  await CS.load();                                        // the switch as stored now (another process, a script)
  const owner = await isOwner(me);
  return {
    owner, hub: CS.all().CHAT_HUB, interlock: await interlock(), pads: await hubPads(),
    choices: owner ? await sitePadChoices() : [], pilots: PILOT_PADS,
    poster: posterOf(await safe(() => require("./huboutbox").status(), null)),
    log: await recentChanges(20),
  };
}

/** What turning CHAT_HUB on would do (the confirm step's text comes from this). */
async function hubPreview() {
  const pads = (await hubPads()).filter((p) => p.backend === "hub");
  return { pads: pads.map((p) => p.title || p.slug || p.room_id), n: pads.length };
}

/** CHAT_HUB on / off. */
async function setHub(b, me) {
  if (b.on !== true && b.on !== false) throw refuse(400, "bad_request", "Say on (true) or off (false).");
  const why = cleanReason(b.reason);
  if (!why) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
  await init();
  if (b.on) {
    if (!(await isOwner(me))) throw refuse(403, "owner_only", "Only a Pepe owner turns the chat hub on - any admin can turn it off.");
    if (!(await CS.chatHubOnNow())) {
      const missing = await CS.needsNow();
      if (missing.length) {
        throw refuse(409, "chat_hub_needs", "The chat hub needs these seam switches on first (/admin/keys#seam): " + missing.join(", ") + ".", { missing });
      }
      if (b.confirm !== true) throw refuse(409, "confirm", "Confirm turning the chat hub on.", { preview: await hubPreview() });
    }
  }
  const r = await CS.set("CHAT_HUB", b.on ? "on" : "off", me, { reason: why });
  return { changed: r.changed, value: r.value, at: r.changed ? r.updated : null };
}

/** A pad's chat backend: v1 (any admin) or hub (an owner, a site pad, after the confirm step). */
async function setPad(b, me) {
  const backend = typeof b.backend === "string" ? b.backend : "";
  if (!PH.BACKENDS.includes(backend)) throw refuse(400, "bad_backend", "A pad's chat backend is v1, hub_read or hub.");
  if (backend === "hub_read") throw refuse(409, "hub_read_s2", "Read-only hub chat (hub_read) comes with S2.");
  if (typeof b.room_id !== "string" || !b.room_id) throw refuse(400, "bad_request", "Pick a pad.");
  const why = cleanReason(b.reason);
  if (!why) throw refuse(400, "reason_required", "Say why (the reason goes in the admin audit log).");
  await init();
  if (backend === "hub") {
    if (!(await isOwner(me))) throw refuse(403, "owner_only", "Only a Pepe owner moves a pad to the chat hub - any admin can move it back.");
    const p = await pad(b.room_id);
    if (!p) throw refuse(404, "no_pad", "No such pad.");
    if (p.platform !== "site") throw refuse(409, "site_pads_only", "Only a site pad can move its chat to the hub in S1 (a Camfrog pad's chat is its Camfrog room's).");
    if (p.backend !== "hub" && b.confirm !== true) {
      throw refuse(409, "confirm", "Confirm moving this pad to the chat hub.",
                   { preview: { title: p.title || p.slug || p.room_id, slug: p.slug, chat_hub: await CS.chatHubOnNow() } });
    }
  }
  // the change and its audit row commit together (padhub.setBackend runs inside this transaction)
  return tx(async () => {
    const before = await pad(b.room_id);
    const r = await PH.setBackend(b.room_id, backend, me);
    if (r.changed) {
      await require("./adminaudit").record(me, "chat.pad_backend", null,
        { room_id: r.room_id, slug: before ? before.slug : null, hub_pad_id: r.hub_pad_id, from: before ? before.backend : null, to: r.chat_backend }, why);
    }
    return { changed: r.changed, room_id: r.room_id, backend: r.chat_backend };
  });
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[adminchat] init:", e.message));
  const guard = require("./middleware/authGuard");
  const noStore = (res) => { res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex"); };

  app.get("/admin/chat", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/chat"));
    try {
      const me = await meOf(req);
      noStore(res);
      if (!isAdmin(me)) {
        if (typeof req.flash === "function") req.flash("error", "The chat hub switches are for site admins.");
        return res.redirect((me && SP.areaHome(me)) || "/login");
      }
      res.render("admin/chat", { title: "Admin · Chat hub", user: me.username, isAdmin: true, me, V: await view(me) });
    } catch (e) { console.error("[adminchat] page:", e.message); res.status(500).send("Couldn't load the admin page."); }
  });

  app.get("/api/admin/chat", addUser, async (req, res) => {
    noStore(res);
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!isAdmin(me)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try { res.json(Object.assign({ ok: true }, await view(me))); }
    catch (e) { console.error("[adminchat] view:", e.message); res.status(500).json({ ok: false, code: "internal", error: "Something went wrong." }); }
  });

  // every change: same-origin fetch, an admin (an owner to turn anything on), a reason; refusals answer {ok:false, code, error}
  const change = (path, fn) => app.post(path, addUser, async (req, res) => {
    noStore(res);
    if (!guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    const me = await meOf(req);
    if (!me) return res.status(401).json({ ok: false, code: "auth", error: "Sign in first." });
    if (!isAdmin(me)) return res.status(403).json({ ok: false, code: "admin_only", error: "Admins only." });
    try {
      res.json(Object.assign({ ok: true }, await fn(req.body || {}, me)));
    } catch (e) {
      if (e && e.refuse) {
        const out = { ok: false, code: e.code, error: e.message };
        const missing = e.missing || e.needs;
        if (missing) out.missing = missing;
        if (e.preview) out.preview = e.preview;
        return res.status(e.status || 400).json(out);
      }
      console.error("[adminchat]", path, e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong - nothing changed." });
    }
  });
  change("/api/admin/chat/hub", setHub);
  change("/api/admin/chat/pad", setPad);
}

module.exports = { register, init, view, setHub, setPad, hubPads, sitePadChoices, interlock, recentChanges, cleanReason, isOwner,
                   CAP, MOD_VIEWS, PILOT_PADS, REASON_MAX };
