// roomsweb.js — the pages and APIs around pad (room) ownership (1.99bi): the Pads (/p, was /rooms), the
// owner's dashboard APIs (the page is the settings hub, padsettings.js), the pads admin (/pads/admin), the homepage's front
// room, and the bot-token endpoints Pepe uses (owners sync, owner !stage commands, royalty spend).
// Data lives in rooms.js (registry), mainstage.js (stages) and royalties.js.
"use strict";

// 1.99iv: a 📺 Prime Time pad may have more stage slots than the site cap (premium padPerks().extraSlots)
const primeSlots = (roomId) => { try { return require("./premium").padPerks(roomId).extraSlots || 0; } catch (e) { return 0; } };
const { getQuery } = require("./dbUtils");
const rooms = require("./rooms");
const stage = require("./mainstage");
const royalties = require("./royalties");

const BRIDGE_KEYS = { relay: "bridge_relay", mic: "bridge_mic", cams: "bridge_cams", audio: "bridge_audio", transcripts: "bridge_transcripts" };

function bridge() { return require("./bridge"); }

/** A room by any of its slugs (registry slug, bridge slug, slugified id). */
async function resolveRoom(slug) {
  const s = String(slug || "").toLowerCase();
  let R = await rooms.bySlug(s);
  if (!R) {
    const B = bridge().bySlug(s);
    if (B) R = await rooms.get(B.id);
  }
  return R;
}
/** The slug links should use: the bridge's (what Pepe's !bridge posts) when it's bridged, else ours. */
function linkSlug(R) {
  if (R && R.slug_set && R.slug) return R.slug;      // 1.99iy: a chosen address always wins
  try {
    const B = bridge()._rooms.get(R.id);
    if (B && B.slug) return B.slug;
  } catch (e) { /* no bridge */ }
  return R.slug;
}

/** Pads rows: every registered or bridged room (pad) with what's on now and next.
 *  1.99fu: `viewer` given (null = signed out) -> an Approved pad is left out for anyone outside it (padaccess.js: the
 *  guide is a discovery page; an Approved pad is reached by its link), and each row says its level (r.access). */
async function guideRows(signedIn, viewer) {
  await rooms.init();
  const PA = require("./padaccess");
  await PA.init();
  const B = bridge();
  const summary = await B.summary(signedIn);
  const reg = await rooms.list();
  const g = await stage.guide();
  const byId = new Map();
  for (const r of reg) byId.set(r.id, { reg: r, br: null });
  for (const b of summary) {
    if (!byId.has(b.id)) byId.set(b.id, { reg: null, br: b });
    else byId.get(b.id).br = b;
  }
  const pepe = B.stage();
  const bpat = await rooms.boostPats();       // 1.99ek: active boost PAT per pad (one cached query) for the 🚀 badges
  const out = [];
  for (const [id, x] of byId) {
    const r = x.reg, b = x.br;
    const slots = g.get(id) || { now: [], next: [] };
    out.push({
      id, slug: r ? linkSlug(r) : b.slug, title: (r && r.title) || (b && b.name) || id,
      owner: r && r.owner ? (r.owner.display || r.owner.username) : null, ownerUser: r && r.owner ? r.owner.username || null : null, house: !!(r && r.house),
      bridged: !!b, live: !!(b && b.live), count: b ? b.count : 0, micCount: b ? b.micCount : 0,
      topic: b ? b.topic : "", description: r ? r.description : "",
      slot_count: r ? r.slot_count : 1, now: slots.now, next: slots.next.slice(0, 4),
      featured: slots.now.find((s) => s.featured && s.live) || null,
      // 1.99cj: Pepe is IN the room (his stream is on its stage) - not "his Camfrog window shows it"
      pepe_here: B.pepeIn ? B.pepeIn(id) === true : false,
      platform: rooms.platformOf(id),            // 1.99x: camfrog | site | twitch | discord (a bridged-only room is camfrog)
      site_only: rooms.isCommunityOnly(id),      // 1.99ck: a pad with no Camfrog room (the Camfrog Lounge)
      boost_pat: Math.round(bpat.get(id) || 0),  // 1.99ek: active (decayed) boost PAT - 0 = not boosted
      access: PA.levelOf(id),                    // 1.99fu: public | members | approved
    });
  }
  if (viewer !== undefined) {
    for (let i = out.length - 1; i >= 0; i--) if (!PA.canSee(viewer, out[i].id)) out.splice(i, 1);
  }
  out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.now.filter((s) => s.live).length - a.now.filter((s) => s.live).length)
    || b.count - a.count || a.title.localeCompare(b.title));
  // 1.99ee: the automatic front-page ranking on each row (r.trend: {rank, front, score, boost}) - the guide's "Trending" strip
  try {
    const T = await rooms.trending(5);
    const all = [T.front, ...T.runners].filter(Boolean);
    all.forEach((t, i) => { const row = out.find((x) => x.id === t.id); if (row) row.trend = { rank: i + 1, front: !!(T.front && T.front.id === t.id), score: t.score, boost: t.boost }; });
  } catch (e) { console.error("[rooms] trending:", e.message); }
  return { rows: out, pepe };
}

function register(app, { addUser, isBotToken }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[rooms]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ ok: false, error: "JSON only." }));
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const needStaff = (req, res, next) => (rooms.isStaff(req.user) ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  const actor = (req) => (req.user && req.user.username) || "?";
  require("./boosts").register(app, { addUser, isBotToken });     // 1.99ee: 🚀 pad boosts (web + Pepe's !boost)
  require("./challengepay").register(app, { addUser, isBotToken });   // mic challenge prizes out of a pad's room-vault escrow
  require("./roomvaults").register(app, { addUser, isBotToken });
  require("./launchpad").register(app, { addUser, isBotToken });     // the pad launchpad: momentum, launch grants review, welcomes, boost credit     // economy v2 E-3: room vaults (Pepe's sync, the pad card, the owner's rate)
  const manageable = async (req, res) => {
    const R = await resolveRoom(req.params.slug);
    if (!R) { res.status(404).json({ ok: false, error: "No such pad." }); return null; }
    if (!(await rooms.canManage(req.user, R.id))) { res.status(403).json({ ok: false, error: "Only this pad's owner can do that." }); return null; }
    return R;
  };

  // ── bot-token endpoints (Pepe) ──
  app.post("/api/rooms/owners", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try {
      // 1.99br: Pepe's live room_owner % per room flow rides along (shown to owners / admins)
      if (Array.isArray((req.body || {}).owner_shares)) await royalties.setOwnerShares(req.body.owner_shares).catch(() => {});
      // 1.99bv: Pepe's relay refusals (restricted logins) in, the room feed mentions out
      let feed = {};
      try { feed = await require("./feedweb").botSync(req.body || {}); } catch (e) { console.error("[rooms] feed sync:", e.message); }
      // 1.99ja: the pending pad codes, for Pepe's room-topic check (padconnect.js)
      let padVerify = [];
      try { padVerify = await require("./padconnect").pendingForPepe(); } catch (e) { console.error("[rooms] pad verify:", e.message); }
      res.json({ ok: true, rooms: await rooms.ownersForPepe(), ...(feed.feed_mentions ? { feed_mentions: feed.feed_mentions } : {}), pad_verify: padVerify });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/royalties/spend", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, accrued: await royalties.spendBatch(b.items) }); } catch (e) { fail(res, e); }
  });
  // 1.99bn: the royalty flows summary for Pepe's admin vault-flows card
  app.post("/api/rooms/royalties/summary", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await royalties.summary()) }); } catch (e) { fail(res, e); }
  });
  // An owner's (or a Pepe admin's) "!stage ..." in their room. Pepe says who typed it; we check that
  // Camfrog name is this room's owner (or Pepe vouches they're one of his admins).
  app.post("/api/rooms/stage/act", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try {
      const R = await rooms.get(String(b.room || ""));
      if (!R) return res.json({ ok: false, message: "this room has no pad on PATV yet" });
      const by = String(b.by || "").trim().toLowerCase();
      const owner = !!(R.owner && R.owner.camfrog && String(R.owner.camfrog).toLowerCase() === by);
      if (!owner && !b.admin) return res.json({ ok: false, message: "only this pad's owner (or an admin) can run its stage" });
      const who = "pepe:" + by.slice(0, 40);
      const verb = String(b.verb || "status").toLowerCase();
      const arg = String(b.arg || "").trim();
      const st = await stage.roomStage(R.id);
      const open = await stage.openSlots(R.id);
      const pick = () => {
        if (!arg) return open.find((s) => s.featured) || (open.length === 1 ? open[0] : null);
        const n = Number(arg.replace(/^#/, ""));
        if (Number.isInteger(n) && n >= 1 && n <= open.length) return open[n - 1];
        const a = arg.replace(/^@/, "").toLowerCase();
        return open.find((s) => String(s.username || "").toLowerCase() === a || String(s.displayname || "").toLowerCase() === a) || null;
      };
      const list = () => open.map((s, i) => `#${i + 1} ${s.displayname || s.username}${s.featured ? " ★" : ""}${stage.isLive(s) ? " (live)" : ""}`).join(", ");
      if (verb === "status") {
        return res.json({ ok: true, message: `${R.title} stage: ${open.length}/${R.slot_count} slot${R.slot_count === 1 ? "" : "s"} in use` +
          (open.length ? ` - ${list()}` : "") + (st.upcoming.length ? ` · next: ${st.upcoming[0].display} at ${new Date(st.upcoming[0].start_at).toISOString().slice(11, 16)} UTC` : "") +
          (st.queue.length ? ` · ${st.queue.length} queued` : "") });
      }
      if (verb === "cut") {
        const s = arg.toLowerCase() === "all" ? null : pick();
        const ids = s ? [s.id] : open.map((x) => x.id);
        let n = 0;
        for (const id of ids) if (await stage.end(id, "cut", who)) n++;
        return res.json({ ok: true, cut: n, message: n ? `cut ${n} slot${n === 1 ? "" : "s"} - unused PAT refunded` : "nothing to cut" });
      }
      if (verb === "feature") {
        const s = pick();
        if (!s) return res.json({ ok: false, message: open.length ? `which one? ${list()}` : "no open slots on this pad's stage" });
        await stage.featureByOwner(s.id, who);
        return res.json({ ok: true, message: `${s.displayname || s.username} is featured in ${R.title}` });
      }
      if (verb === "unfeature") {
        const s = open.find((x) => x.featured);
        if (!s) return res.json({ ok: false, message: "nobody is featured" });
        await stage.unfeature(s.id, who, "the pad owner unfeatured it");
        return res.json({ ok: true, message: `${s.displayname || s.username} isn't featured any more` });
      }
      if (verb === "slots") {
        const n = Math.floor(Number(arg));
        if (!Number.isFinite(n) || n < 1) return res.json({ ok: false, message: `say how many: 1-${stage.config().max_slots_per_room + primeSlots(R.id)}` });
        const R2 = await rooms.setStage(R.id, { slot_count: n }, who, { maxSlots: stage.config().max_slots_per_room + primeSlots(R.id), maxPrice: stage.config().price_per_min });
        return res.json({ ok: true, message: `${R.title} has ${R2.slot_count} stage slot${R2.slot_count === 1 ? "" : "s"} now` });
      }
      res.json({ ok: false, message: "usage: !stage · !stage cut [#n|name|all] · !stage feature <#n|name> · !stage unfeature · !stage slots <n>" });
    } catch (e) {
      res.json({ ok: false, message: e && e.refuse ? e.message : "the website couldn't do that right now" });
      if (!(e && e.refuse)) console.error("[rooms] stage act:", e);
    }
  });

  // ── public: one room's stage (the room page + homepage poll this) ──
  app.get("/api/rooms/:slug/stage", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await resolveRoom(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const st = await stage.roomStage(R.id, req.user);
      const manage = await rooms.canManage(req.user, R.id);
      res.json({ ok: true, ...st, pepe: bridge().stage(), pepe_here: bridge().pepeIn(R.id) !== false, manage, schedule: await stage.roomSchedule(R.id, req.user, manage) });
    } catch (e) { fail(res, e); }
  });

  // ── owner dashboard: the pad settings hub /p/:slug/settings (padsettings.js, 1.99dc; /p/:slug/manage redirects there) ──
  app.post("/api/rooms/:slug/page", addUser, needUser, jsonOnly, async (req, res) => {
    try {
      const R = await manageable(req, res); if (!R) return;
      res.json({ ok: true, room: await rooms.setPage(R.id, req.body || {}, actor(req)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/stage-settings", addUser, needUser, jsonOnly, async (req, res) => {
    try {
      const R = await manageable(req, res); if (!R) return;
      const C = stage.config();
      res.json({ ok: true, room: await rooms.setStage(R.id, req.body || {}, actor(req), { maxSlots: C.max_slots_per_room + primeSlots(R.id), maxPrice: C.price_per_min }) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/owner-state", addUser, needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await manageable(req, res); if (!R) return;
      res.json({ ok: true, ...(await stage.ownerState(R.id)), royalties: R.owner ? await royalties.status(R.id, R.owner.userId) : null });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/ban", addUser, needUser, jsonOnly, async (req, res) => {
    try {
      const R = await manageable(req, res); if (!R) return;
      const u = await stage.roomBan(R.id, (req.body || {}).username, (req.body || {}).reason, actor(req));
      res.json({ ok: true, username: u.username });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/unban", addUser, needUser, jsonOnly, async (req, res) => {
    try {
      const R = await manageable(req, res); if (!R) return;
      res.json({ ok: await stage.roomUnban(R.id, (req.body || {}).userId, actor(req)) });
    } catch (e) { fail(res, e); }
  });
  // bridge switches for this room: queued for Pepe, who re-checks the owner and applies them
  app.post("/api/rooms/:slug/bridge", addUser, needUser, jsonOnly, async (req, res) => {
    try {
      const R = await manageable(req, res); if (!R) return;
      const b = req.body || {};
      const key = BRIDGE_KEYS[String(b.key || "")];
      if (!key) return res.status(400).json({ ok: false, error: "Unknown switch." });
      const on = b.on === true || b.on === "on" || b.on === 1 || b.on === "1";
      const id = await require("./actions").queue(req.user.userId, { kind: "room.bridge", args: [R.id, key, on ? "on" : "off"], tag: "room-manage",
        label: `${R.title}: ${String(b.key)} ${on ? "on" : "off"}` });
      await rooms.event(R.id, "bridge", actor(req), `${key}=${on ? "on" : "off"} (sent to Pepe)`);
      res.json({ ok: true, id });
    } catch (e) {
      if (e && e.message === "busy") return res.status(429).json({ ok: false, error: "You already have a few things waiting for Pepe - give him a moment." });
      fail(res, e);
    }
  });
  app.get("/api/rooms/action/:id", addUser, needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ?", [parseInt(req.params.id, 10) || 0, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such action." });
    res.json({ ok: true, status: a.status, message: a.message || "" });
  });

  // ── admin ──
  app.get("/pads/admin", addUser, async (req, res) => {
    if (!rooms.isStaff(req.user)) return res.redirect("/login");
    const list = await rooms.list();
    const g = await guideRows(true, req.user);
    const ov = await royalties.overview();
    const names = new Map();
    for (const o of ov) {
      if (!names.has(o.owner_user_id)) {
        const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [o.owner_user_id]))[0];
        names.set(o.owner_user_id, u ? u.username : o.owner_user_id);
      }
    }
    const sum = await royalties.summary();
    const fp = await rooms.frontStatus().catch(() => null);
    res.render("roomsAdmin", { user: req.user.username, isAdmin: req.user.class === "Admin", list, guide: g.rows, front: rooms.frontSetting(), fp, roy: royalties.config(),
      sum, padsCfg: { config: await require("./padcfg").get(), fields: require("./padcfg").FIELDS, limits: require("./padcfg").LIMITS,   // 1.99iy
                      reclaimable: await require("./padcreate").reclaimCandidates().then((r) => r.length).catch(() => null) },          // 1.99iz
      overview: ov.map((o) => ({ ...o, owner: names.get(o.owner_user_id), title: (list.find((r) => r.id === o.room_id) || {}).title || o.room_id })) });
  });
  app.post("/api/rooms/admin/owner", addUser, needStaff, jsonOnly, async (req, res) => {
    try { res.json({ ok: true, room: await rooms.setOwner(String((req.body || {}).room || ""), (req.body || {}).owner, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/admin/add", addUser, needStaff, jsonOnly, async (req, res) => {
    try { res.json({ ok: true, room: await rooms.addRoom(String((req.body || {}).room || "").trim(), (req.body || {}).title, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/front", addUser, needStaff, jsonOnly, async (req, res) => {
    try { res.json({ ok: true, front: await rooms.setFront((req.body || {}).room, actor(req)) }); } catch (e) { fail(res, e); }
  });
  // 1.99cj: the automatic pick - its state + score breakdown, "Re-evaluate now", and its tunables
  app.get("/api/rooms/front/status", addUser, needStaff, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await rooms.frontStatus()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/front/reevaluate", addUser, needStaff, jsonOnly, async (req, res) => {
    try {
      await rooms.frontReevaluate(await bridge().summary(false), actor(req));
      res.json({ ok: true, ...(await rooms.frontStatus()) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/front/config", addUser, needStaff, jsonOnly, async (req, res) => {
    try { res.json({ ok: true, cfg: await rooms.setFrontCfg(req.body || {}, actor(req)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/admin/royalties/summary", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: true, ...(await royalties.summary()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/admin/royalties", addUser, needStaff, jsonOnly, async (req, res) => {
    try { res.json({ ok: true, config: await royalties.setConfig(req.body || {}, actor(req)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, guideRows, resolveRoom, linkSlug, BRIDGE_KEYS };
