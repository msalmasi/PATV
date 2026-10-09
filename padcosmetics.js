// padcosmetics.js — premium PAD cosmetics (1.99ew): banner frames, name glows, badges and the animated avatar, bought
// with PAT for a PAD (they belong to the pad, not to whoever paid). Catalog: padcosmetics.json (prices default to the
// rarity table in cosmetics.json; a time-limited "season" window is supported, none ship yet). Effects are CSS only
// (public/css/padfx.css), drawn on the pad header, the /p cards and Top Pads (fx() below, app.locals.padFx).
//
// WHO BUYS
//   * the pad's OWNER buys for their own pad          -> owned straight away;
//   * anyone else signed in GIFTS one to a pad         -> state "gift": the owner is notified (inbox) and can equip it
//     (that accepts it) or decline it. Declined = gone from the pad, NO REFUND (said before the purchase).
//   A pad holds one copy of each item (a declined gift can be bought again). Equipping is the owner's or a site
//   admin's (rooms.canManage): one frame, one glow, one animated avatar, up to 3 badges.
//
// WHERE THE PAT GOES - exactly the boosts mechanism (boosts.routeInTx, economy v2 "room flow"):
//   * the buyer is debited in ONE transaction with a transactions row; the client's ref makes it idempotent (a
//     double click charges once: ref "padcos:<userId>:<ref>" is unique in room_flow_ledger);
//   * room_flow_ledger row: kind "pad_cosmetic", room_id, amount, fortknox, room_vault, owner_self, fk_to;
//   * the Fort Knox half is a negative reserve_claims row: flow "pad_cosmetics" (econ_layers off: Pepe's Reserve, Fort
//     Knox's stand-in) or "fortknox:pad_cosmetics" (Fort Knox live, funding.fortknoxLive(); ledger fk_to = 'fortknox');
//   * the room-vault half is held in the room_flow_ledger escrow until E-3 opens room vaults and migrates it;
//   * a GIFT (payer is not the owner) splits 50/50, the odd PAT to Fort Knox; the OWNER for their own pad: 100% Fort Knox;
//   * E-0 telemetry: econ_charges flow "pad_cosmetics", kind "room" (boosts.telemetry).
//   No refunds - except automatically: anything that fails inside the transaction rolls ALL of it back (debit included).
//
// Errors carry the 1.99ep website-action codes (weberrors.js): {ok:false, error, code, hint[, incident]}.
//
// Routes (JSON only, same-site):
//   GET  /api/rooms/:slug/cosmetics           catalog + what the pad has / has equipped + the viewer's role + balance
//   POST /api/rooms/:slug/cosmetics/buy       {item, ref}         signed in; owner = buy, anyone else = gift
//   POST /api/rooms/:slug/cosmetics/equip     {item, on}          owner / site admin
//   POST /api/rooms/:slug/cosmetics/decline   {id}                owner / site admin: decline a gift (no refund)
//   GET|POST /api/pad-cosmetics/admin         {pay}               staff: the sales switch
//
// 1.99iv PRIME TIME (premium.js): items with "perk": "prime_time" are never sold - a pad has them while it has 📺 Prime
// Time (equip like any other; they stop rendering when it lapses and come back with it). A Prime Time pad also gets
// the automatic "📺 Prime Time" badge (not counted) and premium padPerks().extraBadges more badge slots.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SLOT_KINDS = Object.freeze(["pad_frame", "pad_glow", "pad_badge", "pad_avatar"]);
const MAX_BADGES = 3;
const FX = Object.freeze({
  pad_frame: ["neon", "pixel", "embers", "snow", "pride", "matrix", "primetime"],
  pad_glow: ["soft", "rainbow", "gold", "primetime"],
  pad_avatar: ["anim"],
});
const ROUTING = Object.freeze({ owner: "100% Fort Knox", gift: "50% Fort Knox · 50% this pad's vault" });

let clock = () => Date.now();
const now = () => clock();

const ERR = () => require("./weberrors").ERRORS;
class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || codeFor(status); }
}
function codeFor(st) {
  return { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 402: "E_INSUFFICIENT_PAT", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND",
           409: "E_ALREADY", 410: "E_EXPIRED", 423: "E_FEATURE_OFF", 429: "E_RATE_LIMITED" }[st] || "E_REFUSED";
}

// ── catalog ──
/** Build a catalog from the raw JSON (+ the rarity table). Bad items are skipped with a log line, never a crash. */
function buildCatalog(raw, rarities) {
  const R = rarities || {};
  const slots = (raw && raw.slots) || {};
  const items = [];
  for (const it of (raw && raw.items) || []) {
    if (!it || typeof it.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(it.id)) { console.error("[padcosmetics] bad item id", it && it.id); continue; }
    if (!SLOT_KINDS.includes(it.kind)) { console.error(`[padcosmetics] ${it.id}: unknown kind ${it.kind}`); continue; }
    const st = it.style || {};
    if (FX[it.kind] && !FX[it.kind].includes(st.fx)) { console.error(`[padcosmetics] ${it.id}: unknown fx ${st.fx}`); continue; }
    if (it.kind === "pad_badge" && !(typeof st.text === "string" && st.text.trim())) { console.error(`[padcosmetics] ${it.id}: a badge needs style.text`); continue; }
    const perk = it.perk === "prime_time" ? "prime_time" : null;      // 1.99iv: comes with Prime Time, never sold
    const price = perk ? 0 : Number(it.price) > 0 ? Math.floor(Number(it.price)) : Math.floor(Number((R[it.rarity] || {}).price) || 0);
    if (!(price > 0) && !perk) { console.error(`[padcosmetics] ${it.id}: no price (rarity ${it.rarity})`); continue; }
    let season = null;
    if (it.season) {
      const from = Date.parse(String(it.season.from) + "T00:00:00Z"), to = Date.parse(String(it.season.to) + "T00:00:00Z");
      if (!(from < to)) { console.error(`[padcosmetics] ${it.id}: bad season`); continue; }
      season = { from, to, label: String(it.season.label || "Limited").slice(0, 40) };
    }
    items.push(Object.freeze({ id: it.id, kind: it.kind, name: String(it.name || it.id).slice(0, 60), rarity: String(it.rarity || "common"), price,
      desc: String(it.desc || "").slice(0, 200), animated: !!it.animated, retired: !!it.retired, season, perk,
      style: Object.freeze({ fx: st.fx || null, text: st.text ? String(st.text).slice(0, 24) : null, icon: st.icon ? String(st.icon).slice(0, 8) : null }) }));
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  return { slots, items, byId, rarities: R };
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("[padcosmetics] catalog:", e.message); return null; } }
function loadCatalog() {
  const raw = readJson(path.join(__dirname, "padcosmetics.json")) || {};
  const user = readJson(path.join(__dirname, "cosmetics.json")) || {};
  return buildCatalog(raw, raw.rarities || user.rarities || {});
}
let CAT = loadCatalog();

/** 'active' | 'upcoming' | 'over' for a time-limited item, null otherwise. */
function seasonState(item, t = now()) {
  if (!item || !item.season) return null;
  return t < item.season.from ? "upcoming" : t >= item.season.to ? "over" : "active";
}
const onSale = (item, t = now()) => !!item && !item.perk && !item.retired && item.price > 0 && (!item.season || seasonState(item, t) === "active");
// 1.99iv: Prime Time (premium.js) - perk items + extra badge slots while the pad has it
const isPrime = (roomId) => { try { return require("./premium").isPrime(roomId); } catch (e) { return false; } };
const maxBadges = (roomId) => { try { return MAX_BADGES + require("./premium").padPerks(roomId).extraBadges; } catch (e) { return MAX_BADGES; } };
const perkOk = (item, roomId) => !item.perk || (item.perk === "prime_time" && isPrime(roomId));

// ── tables + config ──
let ready = null;
let PAY = true;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./boosts").init();          // room_flow_ledger + reserve_claims
      await require("./padlook").init();         // pad_looks (what's equipped)
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_cosmetic_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, buyer_id TEXT, buyer_name TEXT, price INTEGER NOT NULL, owner_self INTEGER NOT NULL DEFAULT 0,
        ref TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER, decided_by TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS pad_cos_ref ON pad_cosmetic_items (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS pad_cos_room ON pad_cosmetic_items (room_id, state)");
      await runQuery("CREATE TABLE IF NOT EXISTS pad_cosmetics_config (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM pad_cosmetics_config WHERE key = 'pay'"))[0];
      PAY = r ? r.value !== "false" : true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function setPay(on, actor) {
  await init();
  PAY = !!on;
  await runQuery("INSERT INTO pad_cosmetics_config (key, value) VALUES ('pay', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [PAY ? "true" : "false"]);
  try { await require("./rooms").event(null, "pad-cosmetics-config", actor, PAY ? "pay on" : "pay off"); } catch (e) { /* audit only */ }
  return { pay: PAY };
}

// ── reads ──
const LIVE = "state IN ('owned', 'gift')";
/** The pad's items (not declined): [{id, item_id, kind, state, buyer_name, price, owner_self, created}] */
async function padItems(roomId) {
  await init();
  return getQuery(`SELECT id, item_id, kind, state, buyer_name, price, owner_self, created FROM pad_cosmetic_items WHERE room_id = ? AND ${LIVE} ORDER BY id`, [roomId]);
}
/** Does the pad own (or hold an unanswered gift of) this item? */
async function hasItem(roomId, itemId) {
  await init();
  return !!(await getQuery(`SELECT 1 FROM pad_cosmetic_items WHERE room_id = ? AND item_id = ? AND ${LIVE} LIMIT 1`, [roomId, itemId]))[0];
}

// ── buying (and gifting) ──
const tx = (fn) => require("./boosts").tx(fn);
const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * Buy `itemId` for pad `roomId`. user = {userId, username}; opts = {ref, via}. The owner buying for their own pad is a
 * purchase (100% Fort Knox); anyone else is a gift (50/50). Idempotent per (user, ref): the same ref again returns the
 * first purchase with dup = true and charges nothing.
 */
async function buy(user, roomId, itemId, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to buy pad cosmetics.");
  if (!PAY) throw new Refuse(423, "Pad cosmetics aren't on sale right now.");
  const rooms = require("./rooms");
  const R = await rooms.get(roomId);
  if (!R) throw new Refuse(404, "No such pad.");
  if (R.profile) throw new Refuse(400, "Profiles have their own cosmetics (/cosmetics).", "E_UNSUPPORTED");
  const item = CAT.byId[String(itemId || "")];
  if (!item) throw new Refuse(404, "No such pad cosmetic.");
  if (item.perk) throw new Refuse(403, `${item.name} comes with 📺 Prime Time - it isn't sold on its own.`);
  if (!onSale(item)) throw new Refuse(410, seasonState(item) === "upcoming" ? "That one isn't on sale yet." : "That one isn't on sale any more.");
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = "padcos:" + user.userId + ":" + rawRef;
  const via = opts.via === "chat" ? "chat" : "web";
  const ownerSelf = !!(R.owner && R.owner.userId === user.userId);
  const slug = R.slug || R.id;
  const out = await tx(async () => {
    const had = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", [ref]))[0];
    if (had) {
      const it = (await getQuery("SELECT * FROM pad_cosmetic_items WHERE ref = ?", [ref]))[0] || null;
      return { dup: true, row: had, it };
    }
    if ((await getQuery(`SELECT 1 FROM pad_cosmetic_items WHERE room_id = ? AND item_id = ? AND ${LIVE} LIMIT 1`, [R.id, item.id]))[0]) {
      throw new Refuse(409, `p/${slug} already has ${item.name}.`);
    }
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?", [item.price, user.userId, item.price]);
    if (!paid.changes) throw new Refuse(402, `${item.name} costs ${fmt(item.price)} PAT - you don't have enough.`);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                   [uuidv4(), user.userId, `${ownerSelf ? "🎨 pad cosmetic" : "🎁 pad cosmetic gift"}: ${item.name} p/${slug}`.slice(0, 120), -item.price]);
    const row = await require("./boosts").routeInTx({ ref, kind: "pad_cosmetic", room_id: R.id, payer_id: user.userId, payer_name: u.username,
      amount: item.price, owner_self: ownerSelf, via, flow: "pad_cosmetics", detail: `${item.id} p/${slug}` });
    const t = row.created;
    const ins = await runQuery(`INSERT INTO pad_cosmetic_items (room_id, item_id, kind, state, buyer_id, buyer_name, price, owner_self, ref, created)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                               [R.id, item.id, item.kind, ownerSelf ? "owned" : "gift", user.userId, u.username, item.price, ownerSelf ? 1 : 0, ref, t]);
    return { dup: false, row, username: u.username, it: { id: ins.id, state: ownerSelf ? "owned" : "gift" } };
  });
  if (!out.dup) {
    require("./boosts").telemetry(out.row, opts.login || out.username, via);
    try { await rooms.event(R.id, ownerSelf ? "cosmetic-buy" : "cosmetic-gift", out.username, `${item.id} ${item.price} PAT; Fort Knox ${out.row.fortknox}, room vault ${out.row.room_vault}`); } catch (e) { /* audit only */ }
    if (!ownerSelf && R.owner && R.owner.userId) await giftNotice(R, item, out.username, out.it.id);
  }
  const r = out.row;
  return { dup: out.dup, item: item.id, name: item.name, amount: r.amount, fortknox: r.fortknox, room_vault: r.room_vault, owner_self: !!r.owner_self,
           gift: !r.owner_self, inv_id: out.it ? out.it.id : null, state: out.it ? out.it.state : null, room: { id: R.id, slug, title: R.title } };
}

/** The owner's inbox notice for a gift (idempotent by the gift's id). */
async function giftNotice(R, item, from, invId) {
  const slug = R.slug || R.id;
  return require("./inbox").addSafe(R.owner.userId, {
    kind: "room", ref: "padcos-gift:" + invId,
    title: `🎁 ${from} gifted ${item.name} to p/${slug}`,
    body: `${from} bought ${item.name} for your pad p/${slug}. Equip it from ✨ Cosmetics in the pad's settings, or decline it - gifts are never refunded.`,
    link: `/p/${encodeURIComponent(slug)}/settings#cosmetics`,
  });
}

// ── equipping (owner / site admin) ──
async function canManage(user, roomId) { return require("./rooms").canManage(user, roomId); }

/** Equip (on) or take off (!on) an item the pad has. Equipping a gift accepts it. -> the equipped set */
async function equip(user, roomId, itemId, on = true) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!(await canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner (or a site admin) can change its cosmetics.");
  const item = CAT.byId[String(itemId || "")];
  if (!item) throw new Refuse(404, "No such pad cosmetic.");
  const PL = require("./padlook");
  const cur = PL.cosmeticsOf(roomId);
  const actor = user.username || "?";
  if (!on) {
    if (item.kind === "pad_badge") cur.pad_badge = cur.pad_badge.filter((x) => x !== item.id);
    else if (cur[item.kind] === item.id) cur[item.kind] = null;
    const c = await PL.setCosmetics(roomId, cur, actor);
    await event(roomId, "cosmetic-unequip", actor, item.id);
    return c;
  }
  let inv = null;
  if (item.perk) {
    if (!perkOk(item, roomId)) throw new Refuse(403, `${item.name} comes with 📺 Prime Time - this pad doesn't have it right now.`);
  } else {
    inv = (await getQuery(`SELECT id, state FROM pad_cosmetic_items WHERE room_id = ? AND item_id = ? AND ${LIVE} ORDER BY id LIMIT 1`, [roomId, item.id]))[0];
    if (!inv) throw new Refuse(404, "This pad doesn't have that one - buy it first.");
  }
  if (item.kind === "pad_badge") {
    if (!cur.pad_badge.includes(item.id)) {
      const mb = maxBadges(roomId);
      if (cur.pad_badge.length >= mb) throw new Refuse(409, `Up to ${mb} badges at a time - take one off first.`, "E_BAD_ARGS");
      cur.pad_badge.push(item.id);
    }
  } else cur[item.kind] = item.id;                                // one per slot: it replaces what was there
  if (inv && inv.state === "gift") await runQuery("UPDATE pad_cosmetic_items SET state = 'owned', decided = ?, decided_by = ? WHERE id = ? AND state = 'gift'", [now(), actor, inv.id]);
  const c = await PL.setCosmetics(roomId, cur, actor);
  await event(roomId, "cosmetic-equip", actor, item.id);
  return c;
}

/** Decline a gift: it leaves the pad, nothing is refunded (the buyer was told). */
async function decline(user, roomId, invId) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!(await canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner (or a site admin) can decline gifts.");
  const id = Math.floor(Number(invId));
  const r = (await getQuery("SELECT * FROM pad_cosmetic_items WHERE id = ? AND room_id = ?", [id, roomId]))[0];
  if (!r) throw new Refuse(404, "No such gift.");
  if (r.state !== "gift") throw new Refuse(409, r.state === "declined" ? "Already declined." : "Only an unanswered gift can be declined.");
  await runQuery("UPDATE pad_cosmetic_items SET state = 'declined', decided = ?, decided_by = ? WHERE id = ? AND state = 'gift'", [now(), user.username || "?", id]);
  await event(roomId, "cosmetic-decline", user.username, `${r.item_id} from ${r.buyer_name || "?"} (no refund)`);
  return { ok: true, id };
}
async function event(roomId, what, actor, detail) {
  try { await require("./rooms").event(roomId, what, actor || "?", detail || ""); } catch (e) { /* audit only */ }
}

// ── rendering (views: app.locals.padFx) ──
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** One badge pill (mini = the icon only, the text as its title). */
function badgeHtml(item, mini) {
  if (!item || item.kind !== "pad_badge") return "";
  const ic = item.style.icon ? `<span aria-hidden="true">${esc(item.style.icon)}</span>` : "";
  const pt = item.id === "prime_time" ? " pfx-b-pt" : "";
  if (mini) return `<span class="pfx-b mini${pt}" title="${esc(item.style.text)}">${ic || esc(item.style.text.slice(0, 1))}<span class="pfx-sr">${esc(item.style.text)}</span></span>`;
  return `<span class="pfx-b${pt}">${ic}${esc(item.style.text)}</span>`;
}
/**
 * What a view needs to draw a pad's equipped cosmetics, sync (padlook's cache):
 *   cls    classes for the framed box ("pfx pfx-f-embers is-anim") - the box also needs `layer` as its first child
 *   layer  the effect layer html (absolute, behind the content, aria-hidden)
 *   glow   classes for the element holding the pad's NAME ("pfx-g pfx-g-gold")
 *   badges / badgesMini   the badge pills (wrapped), full or icon-only
 */
function fx(roomId) {
  const out = { cls: "", layer: "", glow: "", badges: "", badgesMini: "", any: false };
  let c;
  try { c = require("./padlook").cosmeticsOf(roomId); } catch (e) { return out; }
  const prime = isPrime(roomId);
  const live = (id) => { const it = id && CAT.byId[id]; return it && (!it.perk || prime) ? it : null; };   // perk items only while Prime Time
  const fr = live(c.pad_frame), gl = live(c.pad_glow);
  if (fr && fr.kind === "pad_frame") {
    out.cls = `pfx pfx-f-${fr.style.fx}${fr.animated ? " is-anim" : ""}`;
    out.layer = '<span class="pfx-l" aria-hidden="true"></span>';
  }
  if (gl && gl.kind === "pad_glow") out.glow = `pfx-g pfx-g-${gl.style.fx}`;
  const bs = c.pad_badge.map(live).filter((i) => i && i.kind === "pad_badge").slice(0, prime ? maxBadges(roomId) : MAX_BADGES);
  if (prime) bs.unshift(PRIME_BADGE);
  if (bs.length) {
    out.badges = `<span class="pfx-bs">${bs.map((b) => badgeHtml(b, false)).join("")}</span>`;
    out.badgesMini = `<span class="pfx-bs mini">${bs.map((b) => badgeHtml(b, true)).join("")}</span>`;
  }
  out.any = !!(out.cls || out.glow || out.badges);
  return out;
}

// the automatic badge of a Prime Time pad (not an item: it isn't equipped, bought or counted)
const PRIME_BADGE = Object.freeze({ id: "prime_time", kind: "pad_badge", name: "Prime Time", style: Object.freeze({ icon: "📺", text: "Prime Time" }) });

/** The catalog for pages / the API (prices resolved, sale state). */
function catalog(t = now()) {
  return CAT.items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, rarity: i.rarity, price: i.price, desc: i.desc, animated: i.animated,
    style: i.style, perk: i.perk || null, sale: onSale(i, t), season: i.season ? { label: i.season.label, from: i.season.from, to: i.season.to, state: seasonState(i, t) } : null }));
}

/** GET data: catalog + the pad's items + equipped + the viewer. */
async function state(R, viewer) {
  await init();
  const signed = !!(viewer && viewer.userId);
  const owner = !!(signed && R.owner && R.owner.userId === viewer.userId);
  const manage = signed ? await canManage(viewer, R.id) : false;
  let balance = null;
  if (signed) { const b = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [viewer.userId]))[0]; balance = b ? b.points_balance : 0; }
  const items = await padItems(R.id);
  const prime = isPrime(R.id);
  const PL = require("./padlook");
  const L = PL.look(R.id);
  return {
    pay: PAY, catalog: catalog(), slots: Object.fromEntries(SLOT_KINDS.map((k) => [k, { ...(CAT.slots[k] || {}), max: k === "pad_badge" ? (prime ? maxBadges(R.id) : MAX_BADGES) : 1 }])),
    rarities: Object.fromEntries(Object.entries(CAT.rarities).map(([k, v]) => [k, { color: v && v.color }])),
    has: [...new Set([...items.map((i) => i.item_id), ...(prime ? CAT.items.filter((i) => i.perk === "prime_time").map((i) => i.id) : [])])],
    prime: { on: prime, link: `/premium?pad=${encodeURIComponent(R.slug || R.id)}` },
    // who gave what is for the people who run the pad
    items: manage ? items.map((i) => ({ id: i.id, item_id: i.item_id, kind: i.kind, state: i.state, from: i.owner_self ? null : i.buyer_name, created: i.created })) : [],
    equipped: PL.cosmeticsOf(R.id),
    anim: manage ? { uploaded: !!L.hasAnim, url: L.avatarAnim, max_frames: PL.ANIM_MAX_FRAMES, max_out: PL.ANIM_MAX_OUT } : null,
    pad: { id: R.id, slug: R.slug || R.id, title: R.title, accent: L.accent, avatar: L.avatar, owner: R.owner ? (R.owner.display || R.owner.username) : null },
    viewer: { signed, owner, manage, balance },
    routing: { mine: owner ? ROUTING.owner : ROUTING.gift, owner: ROUTING.owner, gift: ROUTING.gift },
  };
}

// ── routes ──
function errBody(e) {
  if (e && e.refuse) {
    const code = e.code && ERR()[e.code] ? e.code : "E_REFUSED";
    return { status: e.status || 400, body: { ok: false, error: e.message, code, hint: ERR()[code][1] } };
  }
  const incident = crypto.randomBytes(4).toString("hex");
  console.error(`[padcosmetics] incident ${incident}:`, e);
  return { status: 500, body: { ok: false, error: "Something went wrong - nothing was charged.", code: "E_INTERNAL", hint: ERR().E_INTERNAL[1], incident } };
}
function register(app, { addUser }) {
  init().catch((e) => console.error("[padcosmetics] init:", e.message));
  if (app.locals) app.locals.padFx = fx;
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => { const x = errBody(e); res.status(x.status).json(x.body); };
  const pad = async (req) => {
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) throw new Refuse(404, "No such pad.");
    return R;
  };
  const write = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page.", code: "E_NO_PERMISSION", hint: ERR().E_NO_PERMISSION[1] });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only.", code: "E_BAD_ARGS", hint: ERR().E_BAD_ARGS[1] });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first.", code: "E_NO_PERMISSION", hint: ERR().E_NO_PERMISSION[1] });
    next();
  };
  const B = "/api/rooms/:slug/cosmetics";
  app.get(B, addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await state(await pad(req), req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post(B + "/buy", addUser, write, async (req, res) => {
    try {
      const R = await pad(req);
      const b = req.body || {};
      const r = await buy(req.user, R.id, b.item, { ref: b.ref, via: "web" });
      res.json({ ok: true, ...r, state: await state(R, req.user) });
    } catch (e) { fail(res, e); }
  });
  app.post(B + "/equip", addUser, write, async (req, res) => {
    try {
      const R = await pad(req);
      const b = req.body || {};
      await equip(req.user, R.id, b.item, b.on !== false && b.on !== "false" && b.on !== 0);
      res.json({ ok: true, state: await state(R, req.user) });
    } catch (e) { fail(res, e); }
  });
  app.post(B + "/decline", addUser, write, async (req, res) => {
    try {
      const R = await pad(req);
      await decline(req.user, R.id, (req.body || {}).id);
      res.json({ ok: true, state: await state(R, req.user) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/pad-cosmetics/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!require("./rooms").isStaff(req.user)) throw new Refuse(403, "Admins only.");
      await init();
      const sums = await getQuery(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(fortknox), 0) AS fortknox, COALESCE(SUM(room_vault), 0) AS room_vault
                                   FROM room_flow_ledger WHERE kind = 'pad_cosmetic'`);
      res.json({ ok: true, pay: PAY, totals: sums[0] });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pad-cosmetics/admin", addUser, write, async (req, res) => {
    try {
      if (!require("./rooms").isStaff(req.user)) throw new Refuse(403, "Admins only.");
      res.json({ ok: true, ...(await setPay((req.body || {}).pay !== false && (req.body || {}).pay !== "false", req.user.username)) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, register, buy, equip, decline, padItems, hasItem, fx, badgeHtml, catalog, state, onSale, seasonState, buildCatalog, loadCatalog, setPay, errBody,
  giftNotice, Refuse, ROUTING, SLOT_KINDS, MAX_BADGES, FX,
  get CAT() { return CAT; },
  _setCatalog: (c) => { CAT = c || loadCatalog(); },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
