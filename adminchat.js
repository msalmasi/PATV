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
// that, then posts again. The confirm step is decided on the state read INSIDE the writing transaction (dbUtils.tx runs one
// at a time), so a stale page or a retry can never undo, unconfirmed, an admin's off that landed in between.
// Every change: a same-origin fetch (D15's house pattern, as adminkeys.js: X-Requested-With: fetch and an Origin / Referer
// whose host is this request's Host - sameOriginStrict below), a required reason (cleanReason), an admin_audit row in the
// change's own transaction ("chat.switch" through chatswitches.set; "chat.pad_backend" {room_id, slug, hub_pad_id, from, to}
// here) - a row that can't be written rolls the change back - and Cache-Control: no-store. A change to the value already there
// writes nothing. CHAT_HUB on also needs the interlock (409 chat_hub_needs, `missing`); a pad moves to hub only when it is a
// site pad (409 site_pads_only - Camfrog pads keep their v1 chat in S1; hub_read is S2's: 409 hub_read_s2).
// Turning CHAT_HUB off needs only chat_switches and admin_audit (initCore): never the pads (padhub, rooms); the page shows
// what it can read when the pads can't be read.
// The admin nav's Chat group (views/partials/admin-nav.ejs) opens here; V2 (release L4) adds the hub's moderation screens to
// the group as /admin/chat/{reports,held,modlog,bans,audit,switches} behind chat.mod_queue / chat.audit (MOD_VIEWS).
// Logs carry no reason, pad, account or switch value - only "[adminchat] <what>: <error>".
"use strict";
const { getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const CS = require("./chatswitches");
const PH = require("./padhub");

const CAP = "chat.breakglass";
const REASON_MAX = 200;                 // admin_audit keeps 200 (UTF-16) characters
const PAD_LIST_MAX = 500;               // rows a pad list shows (the page says when there are more)
// ADR 0007 D1: the S1 pilot pads (site pads; Q4 seeds staff and canary), listed first among the pads an owner may move
const PILOT_PADS = ["patv:staff", "patv:canary", "patv:lounge"];
// V2's moderation screens in this group and the capability that opens each (ADR 0007 D15) - V2 hosts them
const MOD_VIEWS = { reports: "chat.mod_queue", held: "chat.mod_queue", modlog: "chat.mod_queue", bans: "chat.mod_queue",
                    audit: "chat.audit", switches: "chat.audit" };
const AUDIT = ["chat.switch", "chat.pad_backend"];

const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };
const refuse = (status, code, message, extra) => Object.assign(new Error(message), { status, code, refuse: true }, extra || {});
// tests only: wraps setPad's read of the pad - f(read) -> the pad - so a test can race an admin's move against that very
// read (CHAT_HUB's read is CS.chatHubOnNow, which a test stubs): moving either read out of the transaction fails the race tests
let padRead = null;

async function meOf(req) {
  if (!req.user || !req.user.userId) return null;
  return (await safe(() => getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]), []))[0] || null;
}
const isAdmin = (me) => SP.can(me, CAP);
const isOwner = async (me) => !!me && (await require("./staffroles").ownerHolds(me, CAP));

/** ADR 0007 D15's house CSRF pattern ("sameOriginStrict, as adminkeys.js"): X-Requested-With: fetch and an Origin (else a
 *  Referer) whose host IS this request's Host - authGuard.sameOriginFetch plus the exact host (no "www." folding). */
function sameOriginStrict(req) {
  if (!require("./middleware/authGuard").sameOriginFetch(req)) return false;
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
}

// a reason as stored: format characters (zero-width, bidi controls, BOM) and lone surrogates out; control characters (C0,
// DEL, C1 with NEL) and line / paragraph separators to a space; spaces folded; at least one letter or digit
const REASON_DROP = /[\p{Cf}\p{Cs}]+/gu;
const REASON_SPACE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const REASON_WORD = /[\p{L}\p{N}]/u;
/** A reason as stored (see above), at most REASON_MAX UTF-16 units without splitting a character; "" when there is none. */
function cleanReason(v) {
  if (typeof v !== "string") return "";
  const s = v.replace(REASON_DROP, "").replace(REASON_SPACE, " ").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of s) {                                   // by code point: an emoji is never cut in half
    if (out.length + ch.length > REASON_MAX) break;
    out += ch;
  }
  out = out.trim();
  return REASON_WORD.test(out) ? out : "";
}

let core = null;
/** What CHAT_HUB and the audit rows need - chat_switches and admin_audit - and nothing else (turning off never waits on the pads). */
function initCore() {
  if (!core) {
    core = (async () => { await CS.init(); await require("./adminaudit").init(); })().catch((e) => { core = null; throw e; });
  }
  return core;
}
/** Everything: the core and the pads (padhub.init: rooms_registry, pad_hub and their triggers - memoised there). */
async function init() {
  await initCore();
  await PH.init();
}

// ── pads ──
// from pad_hub, the registry joined when it has the pad: a pad_hub row whose registry row is gone (a staging refresh, a hand
// edit) is still listed (`gone`) and can still go back to v1
const PAD_COLS = `h.room_id AS room_id, r.room_id AS reg_id, r.slug AS slug, r.title AS title, r.platform AS platform,
                  h.hub_pad_id AS hub_pad_id, h.chat_backend AS chat_backend, h.updated AS updated, h.updated_by AS updated_by`;
const PAD_FROM = "pad_hub h LEFT JOIN rooms_registry r ON r.room_id = h.room_id";
/** rooms.js's rule for a registry row's platform (the column, else what the id implies). */
function platformOf(r) {
  const rooms = require("./rooms");
  const p = String((r && r.platform) || "").toLowerCase();
  return rooms.PLATFORMS.includes(p) ? p : rooms.platformFromId(r && r.room_id);
}
const padView = (r) => ({ room_id: String(r.room_id), slug: r.slug || null, title: r.title || null,
                          platform: platformOf(r), gone: r.reg_id == null,
                          hub_pad_id: r.hub_pad_id || null, backend: r.chat_backend == null ? "v1" : String(r.chat_backend),
                          updated: Number(r.updated) || null, updated_by: r.updated_by || null });
const cap = (n) => Math.max(1, Math.min(PAD_LIST_MAX, Number(n) || PAD_LIST_MAX));
/** One pad with its hub id and backend (as stored), by room id; null when it has no pad_hub row. */
async function pad(roomId) {
  if (typeof roomId !== "string" || !roomId || roomId.length > 200) return null;
  const r = (await getQuery(`SELECT ${PAD_COLS} FROM ${PAD_FROM} WHERE h.room_id = ?`, [roomId]))[0];
  return r ? padView(r) : null;
}
/** The pads whose backend isn't v1 (the pads on the hub - and any value a hand edit left), by title. -> {pads, more} */
async function hubPads(limit = PAD_LIST_MAX) {
  const n = cap(limit);
  const rows = await getQuery(`SELECT ${PAD_COLS} FROM ${PAD_FROM} WHERE h.chat_backend <> 'v1'
                               ORDER BY lower(coalesce(r.title, r.slug, h.room_id)), h.room_id LIMIT ?`, [n + 1]);
  return { pads: rows.slice(0, n).map(padView), more: rows.length > n };
}
/** Site pads still on v1 - what an owner may move to the hub - the pilot pads first, then by title. -> {pads, more}
 *  The site-pad rule (platformOf: the platform column, else what the id implies) runs in SQL, so profile and Camfrog
 *  pads are never read; the JS filter after it stays the authority. */
async function sitePadChoices(limit = PAD_LIST_MAX) {
  const n = cap(limit);
  const P = require("./rooms").PLATFORMS;
  const pin = PILOT_PADS.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
  const rows = await getQuery(`SELECT ${PAD_COLS} FROM rooms_registry r JOIN pad_hub h ON h.room_id = r.room_id
                               WHERE h.chat_backend = 'v1' AND (lower(coalesce(r.platform, '')) = 'site'
                                 OR (lower(coalesce(r.platform, '')) NOT IN (${P.map(() => "?").join(",")}) AND lower(r.room_id) LIKE 'patv:%'))
                               ORDER BY CASE r.room_id ${pin} ELSE ${PILOT_PADS.length} END, lower(coalesce(r.title, r.slug)), r.room_id
                               LIMIT ?`, [...P, ...PILOT_PADS, n + 1]);
  const pads = rows.map(padView).filter((p) => p.platform === "site");
  return { pads: pads.slice(0, n), more: rows.length > n };
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

/** fn() or null when it throws (logged as "[adminchat] <what>: <error>"). */
async function soft(what, fn) {
  try { return await fn(); } catch (e) { console.error(`[adminchat] ${what}:`, e && e.message); return null; }
}

/** Everything the page shows. The pads are read when they can be (pads_ok); the switch, the interlock and the log always. */
async function view(me) {
  await initCore();
  await CS.load();                                        // the switch as stored now (another process, a script)
  const owner = await isOwner(me);
  const padsUp = (await soft("pads", () => PH.init().then(() => true))) === true;
  const hp = padsUp ? await soft("pads", () => hubPads()) : null;
  const ch = padsUp && owner ? await soft("pads", () => sitePadChoices()) : null;
  return {
    owner, hub: CS.all().CHAT_HUB, interlock: await interlock(),
    pads_ok: !!hp && (!owner || !!ch), pads: hp ? hp.pads : [], pads_more: !!(hp && hp.more),
    choices: ch ? ch.pads : [], choices_more: !!(ch && ch.more), pilots: PILOT_PADS, list_max: PAD_LIST_MAX,
    poster: posterOf(await safe(() => require("./huboutbox").status(), null)),
    log: await recentChanges(20),
  };
}

/** What turning CHAT_HUB on would do (the confirm step's text comes from this): the pads on the hub, at most 20 named. */
async function hubPreview() {
  const n = (await getQuery(`SELECT COUNT(*) AS n FROM pad_hub h JOIN rooms_registry r ON r.room_id = h.room_id WHERE h.chat_backend = 'hub'`))[0].n;
  const rows = await getQuery(`SELECT r.title AS title, r.slug AS slug, h.room_id AS room_id FROM pad_hub h JOIN rooms_registry r ON r.room_id = h.room_id
                               WHERE h.chat_backend = 'hub' ORDER BY lower(coalesce(r.title, r.slug)), h.room_id LIMIT 20`);
  return { pads: rows.map((p) => p.title || p.slug || p.room_id), n: Number(n) || 0 };
}

/** CHAT_HUB on / off. */
async function setHub(b, me) {
  if (b.on !== true && b.on !== false) throw refuse(400, "bad_request", "Say on (true) or off (false).");
  const why = cleanReason(b.reason);
  if (!why) throw refuse(400, "reason_required", "Say why, with at least one letter or number (the reason goes in the admin audit log).");
  if (b.on) {
    await init();                                         // the preview reads the pads
    if (!(await isOwner(me))) throw refuse(403, "owner_only", "Only a Pepe owner turns the chat hub on - any admin can turn it off.");
  } else {
    await initCore();                                     // off: the switch and admin_audit only
  }
  try {
    // the read the confirm step rests on, the interlock pre-check, the change and its audit row: one transaction
    return await tx(async () => {
      if (b.on) {
        const was = await CS.chatHubOnNow();                // the row, never the per-process cache (a CLI write misses it)
        if (!was) {
          const missing = await CS.needsNow();
          if (missing.length) {
            throw refuse(409, "chat_hub_needs", "The chat hub needs these seam switches on first (/admin/keys#seam): " + missing.join(", ") + ".", { missing });
          }
          if (b.confirm !== true) throw refuse(409, "confirm", "Confirm turning the chat hub on.", { preview: await hubPreview() });
        }
      }
      const r = await CS.set("CHAT_HUB", b.on ? "on" : "off", me, { reason: why });
      return { changed: r.changed, value: r.value, at: r.changed ? r.updated : null };
    });
  } finally {
    await CS.load().catch((e) => console.error("[adminchat] reload:", e && e.message));   // the cache as committed
  }
}

/** A pad's chat backend: v1 (any admin) or hub (an owner, a site pad, after the confirm step). */
async function setPad(b, me) {
  const backend = typeof b.backend === "string" ? b.backend : "";
  if (!PH.BACKENDS.includes(backend)) throw refuse(400, "bad_backend", "A pad's chat backend is v1, hub_read or hub.");
  if (backend === "hub_read") throw refuse(409, "hub_read_s2", "Read-only hub chat (hub_read) comes with S2.");
  if (typeof b.room_id !== "string" || !b.room_id) throw refuse(400, "bad_request", "Pick a pad.");
  const why = cleanReason(b.reason);
  if (!why) throw refuse(400, "reason_required", "Say why, with at least one letter or number (the reason goes in the admin audit log).");
  await init();
  if (backend === "hub" && !(await isOwner(me))) {
    throw refuse(403, "owner_only", "Only a Pepe owner moves a pad to the chat hub - any admin can move it back.");
  }
  // the pad as stored, its platform and the confirm step are read and decided in the change's own transaction, with its
  // audit row (padhub.setBackend runs inside it): a stale page can't undo an admin's move back to v1, unconfirmed
  return tx(async () => {
    const before = await (padRead ? padRead(() => pad(b.room_id)) : pad(b.room_id));
    if (backend === "hub") {
      if (!before || before.gone) throw refuse(404, "no_pad", "No such pad.");
      if (before.platform !== "site") throw refuse(409, "site_pads_only", "Only a site pad can move its chat to the hub in S1 (a Camfrog pad's chat is its Camfrog room's).");
      if (before.backend !== "hub" && b.confirm !== true) {
        throw refuse(409, "confirm", "Confirm moving this pad to the chat hub.",
                     { preview: { title: before.title || before.slug || before.room_id, slug: before.slug, chat_hub: await CS.chatHubOnNow() } });
      }
    }
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
    if (!sameOriginStrict(req)) return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
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
      // every write is in one transaction that rolled back: nothing changed
      console.error("[adminchat]", path, e.message);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong - nothing changed." });
    }
  });
  change("/api/admin/chat/hub", setHub);
  change("/api/admin/chat/pad", setPad);
}

module.exports = { register, init, initCore, view, setHub, setPad, hubPads, sitePadChoices, interlock, recentChanges, cleanReason, isOwner,
                   sameOriginStrict, CAP, MOD_VIEWS, PILOT_PADS, REASON_MAX, PAD_LIST_MAX,
                   _setPadRead: (f) => { padRead = typeof f === "function" ? f : null; } };
