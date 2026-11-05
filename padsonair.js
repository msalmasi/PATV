// padsonair.js - newstream 1.99akv (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to
// see it. Thats annoying."): the pads list (/p, views/rooms.ejs) was rendered once - a stream that went live, ended or was booked, Pepe coming
// on air, a pad's room going live never showed until a reload. The page now asks GET /api/pads/onair every 30 s while it is visible (and at
// once when it comes back) for a short signature of what its cards show that moves with a stage; only when the signature changes does it
// fetch itself again and swap its sections (rooms.ejs).
//
// The signature covers, per pad this viewer may see: its live slots (id, live, featured, title, mode), its next bookings (the cards list four),
// whether its Camfrog room is live and Pepe is in it - plus Pepe on air. Never headcounts (they move all the time; a swap brings them along).
// One cached snapshot (SNAP_MS) serves every viewer: mainstage.guide() (two reads), bridge.summary(false) and Pepe's state - the same calls
// the /p page makes, once per SNAP_MS for the whole site instead of once per viewer per poll. The /p page renders its first signature from the
// same snapshot (sigFor), so an unchanged list never refetches.
"use strict";
const crypto = require("crypto");

const SNAP_MS = 10000;
let snap = null, loading = null;
let clock = () => Date.now();

/** rows in roomsweb.guideRows' shape ({id, live, pepe_here, now: [...], next: [...]}) + Pepe ({active}) -> a short opaque string */
function sigOf(rows, pepe) {
  const parts = (rows || []).filter((r) => r && r.id != null).map((r) => [String(r.id), r.live ? 1 : 0, r.pepe_here ? 1 : 0,
    (r.now || []).map((s) => [String(s.id), s.live ? 1 : 0, s.featured ? 1 : 0, s.title || "", s.mode || "", s.cam ? 1 : 0]),
    (r.next || []).slice(0, 4).map((n) => [String(n.id), Number(n.start_at) || 0, n.featured ? 1 : 0, n.title || ""])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha1").update(JSON.stringify([pepe && pepe.active ? 1 : 0, parts])).digest("base64url").slice(0, 16);
}

async function load() {
  const MS = require("./mainstage"), B = require("./bridge");
  const [g, sum] = await Promise.all([MS.guide(), B.summary(false)]);
  const live = new Map();
  for (const r of sum || []) if (r && r.id) live.set(r.id, !!r.live);
  const ids = new Set([...g.keys(), ...live.keys()]);
  const st = B.stage ? B.stage() : null;
  const rows = [...ids].map((id) => {
    const x = g.get(id) || { now: [], next: [] };
    return { id, live: !!live.get(id), pepe_here: B.pepeIn ? B.pepeIn(id) === true : false, now: x.now, next: x.next };
  });
  return { at: clock(), rows, pepe: { active: !!(st && st.active) } };
}
/** the shared snapshot - at most one load at a time, SNAP_MS old at most */
async function snapshot() {
  if (snap && clock() - snap.at < SNAP_MS) return snap;
  if (!loading) loading = load().then((s) => { snap = s; return s; }).finally(() => { loading = null; });
  return loading;
}

/** this viewer's signature (null = signed out): only the pads they may see, a 🎬 cam slot only where they may see the pad's live room */
async function sigFor(viewer) {
  const PA = require("./padaccess");
  await PA.init();
  const s = await snapshot();
  const rows = s.rows.filter((r) => PA.canSee(viewer || null, r.id))
    .map((r) => ({ ...r, now: (r.now || []).filter((x) => !x.cam || PA.camVisible(viewer || null, r.id)) }));
  return sigOf(rows, s.pepe);
}

function register(app, { addUser }) {
  app.get("/api/pads/onair", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      res.json({ ok: true, sig: await sigFor(req.user && req.user.userId ? req.user : null) });
    } catch (e) {
      console.error("[padsonair]", e.message);
      res.status(500).json({ ok: false });
    }
  });
}

module.exports = { register, sigOf, sigFor, snapshot, SNAP_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { snap = null; loading = null; } };
