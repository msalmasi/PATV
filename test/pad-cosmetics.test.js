// Offline tests for 1.99ew: premium PAD cosmetics (padcosmetics.js / padcosmetics.json / public/css/padfx.css, the
// animated avatar in padlook.js). The money follows the boosts room-flow route exactly (boosts.routeInTx): the buyer is
// debited once (idempotent ref) with a transactions row; the pad's owner buying for their own pad sends 100% to Fort Knox;
// anyone else's purchase is a GIFT split 50/50 (odd PAT to Fort Knox) between a Fort Knox reserve claim (flow
// "pad_cosmetics", or "fortknox:pad_cosmetics" while Fort Knox is live) and the pad's room-vault escrow (room_flow_ledger
// kind "pad_cosmetic"). Equipping is owner / site admin only: one per slot, up to 3 badges.
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-cosmetics.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padcos-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const ejs = require("ejs");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PL = require(path.join(repo, "padlook"));
const PC = require(path.join(repo, "padcosmetics"));
const B = require(path.join(repo, "boosts"));
const F = require(path.join(repo, "funding"));

const PLANT = "plant_based_chatting", DRAMA = "DRAMA_CENTRAL";
const START = 5000000;
const USERS = {};
let owner, fan, fan2, admin, poor, server, base;

async function mkUser(name, { cls = "pleb", bal = START } = {}) {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, bal]);
  USERS[name] = { userId: id, username: name, class: cls };
  return USERS[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const slug = (id = PLANT) => rooms.getCached(id).slug;

function req(method, url, { user, json, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Origin: base }, headers);
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; }
    else if (body) data = body;
    if (data) h["Content-Length"] = data.length;
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
async function upload(user, s, kind, buf) {
  const o = await req("POST", `/api/rooms/${s}/look/uploads`, { user, json: { kind, size: buf.length } });
  if (!o.json || !o.json.ok) return o;
  for (let off = 0; off < buf.length; off += o.json.chunk) {
    const c = await req("PUT", `/api/rooms/${s}/look/uploads/${o.json.id}?offset=${off}`, { user, body: buf.subarray(off, Math.min(buf.length, off + o.json.chunk)),
      headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" } });
    if (!c.json || !c.json.ok) return c;
  }
  return req("POST", `/api/rooms/${s}/look/uploads/${o.json.id}/finish`, { user, json: {} });
}

/**
 * A tiny animated GIF (frames of w x h, each a solid palette colour). LZW with a fixed 8-bit code size: minimum code
 * size 7 (128 colours), a CLEAR before every 100 pixels so the table never grows past 8-bit codes - every code is a byte.
 */
function gif(w, h, frames) {
  const out = [];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  out.push(...Buffer.from("GIF89a"), ...u16(w), ...u16(h), 0xf6, 0, 0);
  for (let i = 0; i < 128; i++) out.push((i * 37) & 255, (i * 91) & 255, (i * 53) & 255);
  out.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0, 0, 0);
  for (let f = 0; f < frames; f++) {
    out.push(0x21, 0xf9, 0x04, 0x00, ...u16(10), 0x00, 0x00);
    out.push(0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0x00, 0x07);
    const codes = [];
    const n = w * h, color = (f * 13 + 5) % 128;
    for (let p = 0; p < n; p++) { if (p % 100 === 0) codes.push(128); codes.push(color); }
    codes.push(129);
    for (let o = 0; o < codes.length; o += 255) { const part = codes.slice(o, o + 255); out.push(part.length, ...part); }
    out.push(0x00);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  owner = await mkUser("plantowner");
  fan = await mkUser("fan");
  fan2 = await mkUser("fan2");
  admin = await mkUser("boss", { cls: "Admin" });
  poor = await mkUser("poor", { bal: 1000 });
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await rooms.addRoom(DRAMA, null, "test");
  await PC.init();
  const app = express();
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  PL.register(app, { addUser });
  PC.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); PL.setSafetyCheck(null); F.sync({}); });

// ── the catalog ──
test("catalog: the proposal's items and prices (from the rarity table), slots, a time-limited flag, nothing seasonal shipped", () => {
  const C = PC.CAT;
  const price = (id) => C.byId[id].price;
  assert.deepEqual(["pf_neon", "pf_pixel"].map(price), [75000, 75000], "neon / pixel frame: uncommon");
  assert.deepEqual(["pf_embers", "pf_snow", "pf_pride", "pf_matrix"].map(price), [250000, 250000, 250000, 250000], "animated frames: rare");
  assert.equal(price("pg_soft"), 75000);
  assert.deepEqual(["pg_rainbow", "pg_gold"].map(price), [750000, 750000], "animated glows: epic");
  assert.deepEqual(["pb_est2026", "pb_community", "pb_talk"].map(price), [25000, 25000, 25000], "badges: common");
  assert.equal(price("pa_animated"), 750000, "animated avatar: epic");
  assert.deepEqual(C.items.map((i) => i.kind).filter((v, i, a) => a.indexOf(v) === i), ["pad_frame", "pad_glow", "pad_badge", "pad_avatar"]);
  assert.deepEqual(C.byId.pb_community.style, { fx: null, text: "Community", icon: "🌱" });
  assert.ok(C.items.every((i) => !i.season), "no seasonal items ship now");
  assert.ok(C.items.every((i) => PC.onSale(i)));
  // the season flag: sells only inside its window; a broken item is skipped, never a crash
  const T = Date.UTC(2026, 9, 10);
  const c2 = PC.buildCatalog({ items: [
    { id: "x_winter", kind: "pad_frame", rarity: "rare", style: { fx: "snow" }, season: { from: "2026-12-01", to: "2027-01-01", label: "Winter 2026" } },
    { id: "x_cheap", kind: "pad_badge", rarity: "common", price: 1234, style: { text: "Hi" } },
    { id: "x_bad", kind: "pad_frame", rarity: "rare", style: { fx: "nope" } },
    { id: "x_kind", kind: "hat", rarity: "rare" },
  ] }, { rare: { price: 250000 }, common: { price: 25000 } });
  assert.deepEqual(c2.items.map((i) => i.id), ["x_winter", "x_cheap"]);
  assert.equal(c2.byId.x_cheap.price, 1234, "an explicit price wins over the rarity");
  assert.equal(PC.seasonState(c2.byId.x_winter, T), "upcoming"); assert.equal(PC.onSale(c2.byId.x_winter, T), false);
  assert.equal(PC.onSale(c2.byId.x_winter, Date.UTC(2026, 11, 15)), true);
  assert.equal(PC.onSale(c2.byId.x_winter, Date.UTC(2027, 0, 1)), false, "to is exclusive");
});

// ── routing ──
test("owner buys for their own pad: 100% Fort Knox (reserve claim 'pad_cosmetics'), nothing to the room vault, owned at once", async () => {
  F.sync({});                                                         // econ_layers off: Fort Knox not live
  const b0 = await bal(owner);
  const r = await PC.buy(owner, PLANT, "pf_neon", { ref: ref() });
  assert.deepEqual([r.dup, r.amount, r.fortknox, r.room_vault, r.owner_self, r.gift, r.state], [false, 75000, 75000, 0, true, false, "owned"]);
  assert.equal(await bal(owner), b0 - 75000);
  const tx = await getQuery("SELECT type, points FROM transactions WHERE userId = ?", [owner.userId]);
  assert.deepEqual(tx.map((t) => t.points), [-75000]); assert.match(tx[0].type, /🎨 pad cosmetic: Neon frame p\//);
  const L = (await getQuery("SELECT * FROM room_flow_ledger WHERE payer_id = ? AND kind = 'pad_cosmetic'", [owner.userId]))[0];
  assert.deepEqual([L.kind, L.room_id, L.amount, L.fortknox, L.room_vault, L.owner_self, L.via, L.fk_to, L.migrated_fk, L.migrated_rv],
                   ["pad_cosmetic", PLANT, 75000, 75000, 0, 1, "web", null, null, null]);
  assert.match(L.ref, /^padcos:u-plantowner:/);
  const C = await getQuery("SELECT flow, amount, type, settled FROM reserve_claims WHERE userId = ?", [owner.userId]);
  assert.deepEqual(C.map((c) => [c.flow, c.amount, c.settled]), [["pad_cosmetics", -75000, 0]]);
  assert.match(C[0].type, /^pad cosmetic plant_based_chatting: Fort Knox half$/);
  const E = await getQuery("SELECT flow, kind, payer_kind, amount, room_id FROM econ_charges WHERE flow = 'pad_cosmetics'").catch(() => []);
  // E-0 telemetry is best effort after the commit
  await new Promise((r2) => setTimeout(r2, 50));
  const E2 = await getQuery("SELECT flow, kind, payer_kind, amount, room_id FROM econ_charges WHERE flow = 'pad_cosmetics'");
  assert.deepEqual(E2.map((e) => [e.flow, e.kind, e.payer_kind, e.amount, e.room_id]), [["pad_cosmetics", "room", "owner", 75000, PLANT]], JSON.stringify(E));
  assert.equal(await PC.hasItem(PLANT, "pf_neon"), true);
});

test("a gift (anyone else): 50/50, the odd PAT to Fort Knox; the owner gets an inbox notice", async () => {
  // odd PAT: a test catalog with an odd price
  const real = PC.CAT;
  PC._setCatalog(PC.buildCatalog({ items: [...real.items.map((i) => ({ ...i, style: { ...i.style } })), { id: "pb_odd", kind: "pad_badge", name: "Odd", rarity: "common", price: 25001, style: { text: "Odd", icon: "🎲" } }] },
                                   real.rarities));
  try {
    const b0 = await bal(fan);
    const r = await PC.buy(fan, PLANT, "pb_odd", { ref: ref() });
    assert.deepEqual([r.amount, r.fortknox, r.room_vault, r.owner_self, r.gift, r.state], [25001, 12501, 12500, false, true, "gift"]);
    assert.equal(await bal(fan), b0 - 25001);
    const L = (await getQuery("SELECT * FROM room_flow_ledger WHERE payer_id = ? AND kind = 'pad_cosmetic'", [fan.userId]))[0];
    assert.deepEqual([L.amount, L.fortknox, L.room_vault, L.owner_self], [25001, 12501, 12500, 0]);
    const C = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ?", [fan.userId]);
    assert.deepEqual(C.map((c) => [c.flow, c.amount]), [["pad_cosmetics", -12501]]);
    const tx = await getQuery("SELECT type FROM transactions WHERE userId = ?", [fan.userId]);
    assert.match(tx[0].type, /🎁 pad cosmetic gift: Odd p\//);
    // gift notice to the owner, once
    const n = await getQuery("SELECT kind, title, body, link, ref FROM inbox WHERE user_id = ?", [owner.userId]);
    assert.equal(n.length, 1);
    assert.equal(n[0].kind, "room");
    assert.match(n[0].title, /^🎁 fan gifted Odd to p\//);
    assert.match(n[0].body, /Equip it .* or decline it - gifts are never refunded/);
    assert.match(n[0].link, /\/settings#cosmetics$/);
    assert.equal(await PC.giftNotice(rooms.getCached(PLANT), PC.CAT.byId.pb_odd, "fan", r.inv_id), false, "the notice is idempotent per gift");
    // an even gift splits exactly
    const e = await PC.buy(fan, PLANT, "pb_talk", { ref: ref() });
    assert.deepEqual([e.fortknox, e.room_vault], [12500, 12500]);
    // a site admin who isn't the owner is a gift too
    const a = await PC.buy(admin, PLANT, "pb_est2026", { ref: ref() });
    assert.deepEqual([a.gift, a.fortknox, a.room_vault], [true, 12500, 12500]);
  } finally { PC._setCatalog(real); }
});

test("econ_layers on: the Fort Knox half is a 'fortknox:pad_cosmetics' claim and the ledger says fk_to = 'fortknox' (off again: back to the Reserve)", async () => {
  F.sync({ fortknox: 123456 });
  assert.equal(F.fortknoxLive(), true);
  try {
    const g = await PC.buy(fan2, DRAMA, "pf_snow", { ref: ref() });
    assert.deepEqual([g.fortknox, g.room_vault], [125000, 125000]);
    const L = (await getQuery("SELECT fk_to FROM room_flow_ledger WHERE payer_id = ? AND room_id = ?", [fan2.userId, DRAMA]))[0];
    assert.equal(L.fk_to, "fortknox");
    const C = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ?", [fan2.userId]);
    assert.deepEqual(C.map((c) => [c.flow, c.amount]), [["fortknox:pad_cosmetics", -125000]]);
    const o = await PC.buy(owner, PLANT, "pg_soft", { ref: ref() });
    assert.equal(o.fortknox, 75000);
    const C2 = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ? ORDER BY rowid DESC LIMIT 1", [owner.userId]);
    assert.deepEqual([C2[0].flow, C2[0].amount], ["fortknox:pad_cosmetics", -75000]);
  } finally { F.sync({}); }
  assert.equal(F.fortknoxLive(), false);
  const r = await PC.buy(fan2, DRAMA, "pb_talk", { ref: ref() });
  const C3 = await getQuery("SELECT flow FROM reserve_claims WHERE userId = ? ORDER BY rowid DESC LIMIT 1", [fan2.userId]);
  assert.equal(C3[0].flow, "pad_cosmetics");
  assert.equal(r.room_vault, 12500);
  // E-1's one-time Fort Knox move counts unsettled pad_cosmetics claims as pending, like boosts / slot fees
  const s = await B.fkMigrationSummary();
  assert.ok(s.pending_claims >= 1);
});

test("idempotent: a double click (the same ref) charges once; a pad holds one of each; refusals move nothing and carry 1.99ep codes", async () => {
  const k = ref();
  const b0 = await bal(fan);
  const [x, y] = await Promise.all([PC.buy(fan, PLANT, "pf_pride", { ref: k }), PC.buy(fan, PLANT, "pf_pride", { ref: k })]);
  assert.deepEqual([x.dup, y.dup].sort(), [false, true]);
  const z = await PC.buy(fan, PLANT, "pf_pride", { ref: k });
  assert.equal(z.dup, true); assert.equal(z.inv_id, x.dup ? y.inv_id : x.inv_id);
  assert.equal(await bal(fan), b0 - 250000, "charged exactly once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_cosmetic_items WHERE room_id = ? AND item_id = 'pf_pride'", [PLANT]))[0].n, 1);
  // someone else trying to buy the same item for that pad: already there
  await assert.rejects(PC.buy(fan2, PLANT, "pf_pride", { ref: ref() }), (e) => e.status === 409 && e.code === "E_ALREADY");
  // insufficient PAT
  const p0 = await bal(poor);
  await assert.rejects(PC.buy(poor, PLANT, "pb_community", { ref: ref() }), (e) => e.status === 402 && e.code === "E_INSUFFICIENT_PAT" && /don't have enough/.test(e.message));
  assert.equal(await bal(poor), p0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger WHERE payer_id = ?", [poor.userId]))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [poor.userId]))[0].n, 0);
  await assert.rejects(PC.buy(fan, PLANT, "nope", { ref: ref() }), (e) => e.code === "E_TARGET_NOT_FOUND");
  await assert.rejects(PC.buy(fan, PLANT, "pb_community", { ref: "bad ref!" }), (e) => e.code === "E_BAD_ARGS");
  await assert.rejects(PC.buy(null, PLANT, "pb_community", { ref: ref() }), (e) => e.status === 401);
  await assert.rejects(PC.buy(fan, "No.Such.Pad", "pb_community", { ref: ref() }), (e) => e.status === 404);
  // the sales switch
  await PC.setPay(false, "test");
  try { await assert.rejects(PC.buy(fan, PLANT, "pb_community", { ref: ref() }), (e) => e.code === "E_FEATURE_OFF"); }
  finally { await PC.setPay(true, "test"); }
  // an unexpected error is E_INTERNAL with an incident id; a refusal keeps its own code + hint
  const ie = PC.errBody(new Error("boom"));
  assert.equal(ie.status, 500); assert.equal(ie.body.code, "E_INTERNAL"); assert.match(ie.body.incident, /^[0-9a-f]{8}$/); assert.doesNotMatch(JSON.stringify(ie.body), /boom/);
  const re = PC.errBody(new PC.Refuse(402, "nope"));
  assert.deepEqual([re.status, re.body.code], [402, "E_INSUFFICIENT_PAT"]); assert.ok(re.body.hint);
});

test("automatic refund: a failure mid-purchase rolls everything back (debit, ledger, claim, item)", async () => {
  const b0 = await bal(fan2);
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger"))[0].n;
  const c0 = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n;
  // make the item insert fail AFTER the debit + routing: a row that already holds the ref the purchase will use
  const k = ref();
  await runQuery("INSERT INTO pad_cosmetic_items (room_id, item_id, kind, state, price, ref, created) VALUES ('x', 'x', 'pad_badge', 'declined', 1, ?, 1)", ["padcos:" + fan2.userId + ":" + k]);
  await assert.rejects(PC.buy(fan2, PLANT, "pb_community", { ref: k }), (e) => /UNIQUE/.test(e.message));
  assert.equal(await bal(fan2), b0, "the debit was rolled back");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger"))[0].n, n0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n, c0);
  assert.equal(await PC.hasItem(PLANT, "pb_community"), false);
  await runQuery("DELETE FROM pad_cosmetic_items WHERE room_id = 'x'");
});

test("equip rules: owner / site admin only; one frame, one glow; up to 3 badges; equipping a gift accepts it; decline = gone, no refund", async () => {
  // a stranger can't
  await assert.rejects(PC.equip(fan, PLANT, "pf_neon"), (e) => e.status === 403 && e.code === "E_NO_PERMISSION");
  await assert.rejects(PC.equip(null, PLANT, "pf_neon"), (e) => e.status === 401);
  let c = await PC.equip(owner, PLANT, "pf_neon");
  assert.equal(c.pad_frame, "pf_neon");
  c = await PC.equip(owner, PLANT, "pf_pride");                      // the fan's gift: equipping accepts it
  assert.equal(c.pad_frame, "pf_pride", "one frame: the new one replaces the old");
  assert.equal((await getQuery("SELECT state FROM pad_cosmetic_items WHERE room_id = ? AND item_id = 'pf_pride'", [PLANT]))[0].state, "owned");
  c = await PC.equip(admin, PLANT, "pg_soft");                       // a site admin may
  assert.equal(c.pad_glow, "pg_soft");
  await assert.rejects(PC.equip(owner, PLANT, "pg_gold"), (e) => e.status === 404, "not owned: can't equip");
  // badges: buy a 4th, equip 3, the 4th is refused
  await PC.buy(owner, PLANT, "pb_community", { ref: ref() });
  for (const b of ["pb_talk", "pb_est2026", "pb_community"]) c = await PC.equip(owner, PLANT, b);
  assert.deepEqual(c.pad_badge, ["pb_talk", "pb_est2026", "pb_community"]);
  const odd = (await getQuery("SELECT id FROM pad_cosmetic_items WHERE room_id = ? AND item_id = 'pb_odd'", [PLANT]))[0];
  assert.ok(odd, "the odd-priced gift is still on the pad");
  const real = PC.CAT;
  PC._setCatalog(PC.buildCatalog({ items: [...real.items, { id: "pb_odd", kind: "pad_badge", name: "Odd", rarity: "common", price: 25001, style: { text: "Odd" } }] }, real.rarities));
  try {
    await assert.rejects(PC.equip(owner, PLANT, "pb_odd"), (e) => e.status === 409 && /Up to 3 badges/.test(e.message));
    c = await PC.equip(owner, PLANT, "pb_talk", false);
    assert.deepEqual(c.pad_badge, ["pb_est2026", "pb_community"]);
    // decline the odd gift: no refund, gone from the pad
    const fb = await bal(fan);
    await assert.rejects(PC.decline(fan, PLANT, odd.id), (e) => e.status === 403);
    await PC.decline(owner, PLANT, odd.id);
    assert.equal(await bal(fan), fb, "no refund");
    assert.equal(await PC.hasItem(PLANT, "pb_odd"), false);
    await assert.rejects(PC.decline(owner, PLANT, odd.id), (e) => e.status === 409);
    await assert.rejects(PC.equip(owner, PLANT, "pb_odd"), (e) => e.status === 404, "a declined gift can't be equipped");
    await assert.rejects(PC.decline(owner, PLANT, (await getQuery("SELECT id FROM pad_cosmetic_items WHERE item_id = 'pf_neon'"))[0].id), (e) => e.status === 409, "only an unanswered gift can be declined");
  } finally { PC._setCatalog(real); }
  // what views get
  const fx = PC.fx(PLANT);
  assert.equal(fx.cls, "pfx pfx-f-pride is-anim");
  assert.equal(fx.layer, '<span class="pfx-l" aria-hidden="true"></span>');
  assert.equal(fx.glow, "pfx-g pfx-g-soft");
  assert.match(fx.badges, /^<span class="pfx-bs"><span class="pfx-b"><span aria-hidden="true">📅<\/span>Est\. 2026<\/span><span class="pfx-b"><span aria-hidden="true">🌱<\/span>Community<\/span><\/span>$/);
  assert.match(fx.badgesMini, /class="pfx-b mini" title="Est\. 2026"/);
  assert.deepEqual(PC.fx("Quiet.Nothing"), { cls: "", layer: "", glow: "", badges: "", badgesMini: "", any: false });
});

test("HTTP: GET state (role + routing text), buy JSON-only + same-site + double-click safe, equip owner-only, insufficient PAT code", async () => {
  const s = slug();
  let r = await req("GET", `/api/rooms/${s}/cosmetics`, { user: "fan" });
  assert.equal(r.json.ok, true);
  assert.deepEqual([r.json.viewer.owner, r.json.viewer.manage, r.json.routing.mine], [false, false, "50% Fort Knox · 50% this pad's vault"]);
  assert.deepEqual(r.json.items, [], "who gave what is for the people who run the pad");
  assert.ok(r.json.has.includes("pf_neon"));
  r = await req("GET", `/api/rooms/${s}/cosmetics`, { user: "plantowner" });
  assert.deepEqual([r.json.viewer.owner, r.json.viewer.manage, r.json.routing.mine], [true, true, "100% Fort Knox"]);
  assert.ok(r.json.items.find((i) => i.item_id === "pf_pride" && i.from === "fan"));
  // buy over HTTP
  r = await req("POST", `/api/rooms/${s}/cosmetics/buy`, { json: { item: "pg_rainbow", ref: "web-ref-0001" } });
  assert.equal(r.status, 401); assert.equal(r.json.code, "E_NO_PERMISSION");
  r = await req("POST", `/api/rooms/${s}/cosmetics/buy`, { user: "fan", body: Buffer.from("item=pg_rainbow"), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 415, "a cross-site form can't buy");
  r = await req("POST", `/api/rooms/${s}/cosmetics/buy`, { user: "fan", json: { item: "pg_rainbow", ref: "web-ref-0001" }, headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  const b0 = await bal(fan);
  const [r1, r2] = await Promise.all([req("POST", `/api/rooms/${s}/cosmetics/buy`, { user: "fan", json: { item: "pg_rainbow", ref: "web-ref-0001" } }),
                                      req("POST", `/api/rooms/${s}/cosmetics/buy`, { user: "fan", json: { item: "pg_rainbow", ref: "web-ref-0001" } })]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.deepEqual([r1.json.dup, r2.json.dup].sort(), [false, true]);
  assert.equal(await bal(fan), b0 - 750000, "one charge for a double click");
  assert.deepEqual([r1.json.fortknox, r1.json.room_vault], [375000, 375000]);
  r = await req("POST", `/api/rooms/${s}/cosmetics/buy`, { user: "poor", json: { item: "pg_gold", ref: "web-ref-0002" } });
  assert.equal(r.status, 402); assert.equal(r.json.code, "E_INSUFFICIENT_PAT"); assert.ok(r.json.hint);
  // equip: owner yes, stranger no
  r = await req("POST", `/api/rooms/${s}/cosmetics/equip`, { user: "fan", json: { item: "pg_rainbow", on: true } });
  assert.equal(r.status, 403); assert.equal(r.json.code, "E_NO_PERMISSION");
  r = await req("POST", `/api/rooms/${s}/cosmetics/equip`, { user: "plantowner", json: { item: "pg_rainbow", on: true } });
  assert.equal(r.status, 200); assert.equal(r.json.state.equipped.pad_glow, "pg_rainbow");
  r = await req("POST", "/api/pad-cosmetics/admin", { user: "fan", json: { pay: false } });
  assert.equal(r.status, 403);
});

test("conservation: every pad-cosmetic PAT is in the Fort Knox claims or the room-vault escrow - nothing created or destroyed", async () => {
  const fk = -(await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM reserve_claims WHERE flow IN ('pad_cosmetics', 'fortknox:pad_cosmetics')"))[0].t;
  const rows = await getQuery("SELECT COALESCE(SUM(amount), 0) AS a, COALESCE(SUM(fortknox), 0) AS f, COALESCE(SUM(room_vault), 0) AS v FROM room_flow_ledger WHERE kind = 'pad_cosmetic'");
  const { a, f, v } = rows[0];
  assert.ok(a > 0);
  assert.equal(f + v, a, "each row splits exactly into its two halves");
  assert.equal(fk, f, "the Fort Knox halves are exactly the claims");
  const moved = (await getQuery("SELECT COALESCE(SUM(points), 0) AS t FROM transactions"))[0].t;
  assert.equal(moved, -a, "the wallets lost exactly what was routed");
  const items = (await getQuery("SELECT COALESCE(SUM(price), 0) AS t FROM pad_cosmetic_items WHERE room_id != 'x'"))[0].t;
  assert.equal(items, a, "every charge has its item (declined gifts included - no refunds)");
  const wallets = (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS b FROM users"))[0].b;
  const initial = (await getQuery("SELECT COUNT(*) AS n FROM users"))[0].n * START - (START - 1000);
  assert.equal(wallets + fk + v, initial, "wallets + Fort Knox claims + room-vault escrow = what everyone started with");
  // the room-vault escrow is per pad, ready for E-3
  const esc = await B.escrow();
  assert.ok(esc.rooms.find((x) => x.room_id === PLANT).room_vault > 0);
});

// ── the animated avatar ──
test("animated avatar: only once the pad owns it; animated GIF/WebP only, 256 px animated webp + a still, frame cap, safety hook refusal", async () => {
  const s = slug(DRAMA);
  await rooms.setOwner(DRAMA, "fan2", "test");
  const g = gif(64, 48, 6);
  assert.equal((await sharp(g, { animated: true }).metadata()).pages, 6, "the test GIF really is animated");
  let r = await upload("fan2", s, "avatar_anim", g);
  assert.equal(r.status, 403, "not owned yet"); assert.match(r.json.error, /pad cosmetic/);
  await assert.rejects(PL.setImage(DRAMA, "avatar_anim", g, { actor: "x" }), (e) => e.status === 403, "the server checks again at the end");
  await PC.buy(fan2, DRAMA, "pa_animated", { ref: ref() });
  // not animated / not GIF-WebP / too many frames / too big
  r = await upload("fan2", s, "avatar_anim", gif(32, 32, 1));
  assert.equal(r.status, 415); assert.match(r.json.error, /isn't animated/);
  r = await upload("fan2", s, "avatar_anim", await sharp({ create: { width: 40, height: 40, channels: 3, background: "#f00" } }).png().toBuffer());
  assert.equal(r.status, 415); assert.match(r.json.error, /animated WebP or GIF/);
  r = await upload("fan2", s, "avatar_anim", gif(8, 8, PL.ANIM_MAX_FRAMES + 1));
  assert.equal(r.status, 413); assert.match(r.json.error, /up to 150 frames/);
  r = await req("POST", `/api/rooms/${s}/look/uploads`, { user: "fan2", json: { kind: "avatar_anim", size: PL.MAX_BYTES + 1 } });
  assert.equal(r.status, 413);
  // the safety hook sees the animated webp and its still; a flagged one is refused and nothing is stored
  const seen = [];
  PL.setSafetyCheck(async (x) => { seen.push([x.kind, Buffer.isBuffer(x.buf), Buffer.isBuffer(x.still)]); return { ok: false, nsfw: true }; });
  r = await upload("fan2", s, "avatar_anim", g);
  PL.setSafetyCheck(null);
  assert.equal(r.status, 422); assert.match(r.json.error, /adult content/);
  assert.deepEqual(seen, [["avatar_anim", true, true]]);
  assert.equal(PL.look(DRAMA).hasAnim, false, "nothing stored");
  // a good one
  r = await upload("fan2", s, "avatar_anim", g);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let L = PL.look(DRAMA);
  assert.equal(L.hasAnim, true);
  assert.equal(L.avatarAnim, null, "uploaded, but not shown until pad_avatar is equipped");
  await PC.equip(fan2, DRAMA, "pa_animated");
  L = PL.look(DRAMA);
  assert.match(L.avatarAnim, /^\/media\/pad\/[a-f0-9]{32}_v\.webp$/);
  assert.match(L.avatarStill, /^\/media\/pad\/[a-f0-9]{32}_w\.webp$/);
  assert.equal(L.avatar, L.avatarStill, "plain <img> users (stories, chips) get the still");
  const file = PL.filePath(L.avatarAnim.split("/").pop());
  const m = await sharp(fs.readFileSync(file), { animated: true }).metadata();
  assert.deepEqual([m.format, m.width, m.pageHeight, m.pages], ["webp", 256, 256, 6], "a 256 px square animated webp");
  assert.ok(fs.statSync(file).size <= PL.ANIM_MAX_OUT, "size-capped");
  assert.equal(m.exif, undefined); assert.equal(m.xmp, undefined);
  const st = await sharp(fs.readFileSync(PL.filePath(L.avatarStill.split("/").pop()))).metadata();
  assert.deepEqual([st.format, st.width, st.height, st.pages || 1], ["webp", 256, 256, 1]);
  // the avatar html: <picture> with the still for reduced motion
  assert.match(PL.avatarHtml(DRAMA, { cls: "rm-av" }), /<span class="pad-av rm-av has-img is-anim" aria-hidden="true"><picture><source media="\(prefers-reduced-motion: reduce\)" srcset="\/media\/pad\/[a-f0-9]{32}_w\.webp"><img src="\/media\/pad\/[a-f0-9]{32}_v\.webp"/);
  // both files are served while in use; removing deletes both
  for (const u of [L.avatarAnim, L.avatarStill]) assert.equal((await req("GET", u)).status, 200);
  r = await req("POST", `/api/rooms/${s}/look/remove`, { user: "fan2", json: { kind: "avatar_anim" } });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await req("GET", L.avatarAnim)).status, 404);
});

// ── the CSS + the pages ──
test("padfx.css: every catalog effect has CSS; animations stop under prefers-reduced-motion; no JS needed", () => {
  const css = fs.readFileSync(path.join(repo, "public", "css", "padfx.css"), "utf8");
  for (const fx of PC.FX.pad_frame) assert.match(css, new RegExp(`\\.pfx-f-${fx}\\b`), fx);
  for (const fx of PC.FX.pad_glow) assert.match(css, new RegExp(`\\.pfx-g-${fx}\\b`), fx);
  assert.match(css, /\.pfx-b \{/);
  const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(rm.length > 30);
  assert.match(rm, /\.pfx > \.pfx-l::before, \.pfx > \.pfx-l::after, \.pfx-g-rainbow, \.pfx-g-gold \{ animation: none !important; \}/);
  // every animation in the file is on something the reduced-motion block switches off
  const animated = [...css.matchAll(/([^{}]+)\{[^}]*animation:\s*pfx-/g)].map((m) => m[1].trim().split("\n").pop().trim());
  assert.ok(animated.length >= 6);
  for (const sel of animated) assert.ok(/pfx-l::before|pfx-g-rainbow|pfx-g-gold/.test(sel), "covered: " + sel);
  // cheap: transforms / background-position only (no animated box-shadow / filter / width)
  for (const kf of css.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\s*\}/g)) assert.doesNotMatch(kf[1], /box-shadow|filter|width|height|top|left/, kf[0]);
});

test("pages: the pad header (frame + glow + badges + 🎁 for non-owners), /p cards, Top Pads, settings section, /cosmetics Pad group, /economy line", async () => {
  const rd = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n");
  const roomLocals = (user, extra = {}) => Object.assign({
    user, signedIn: !!user, linked: false, padLook: PL.look, padAv: PL.avatarHtml, padFx: PC.fx,
    room: { id: PLANT, name: "Houseplants", slug: slug(), count: 0, live: false, topic: "", bridged: false, siteOnly: false, platform: "camfrog",
            description: "", banner: "", owner: "plantowner", ownerUser: "plantowner", house: false, camfrogName: PLANT },
    initial: null, padTabs: null, latest: [], dms: false, pepeHere: false, stage: { active: false }, roomStage: null, manage: false, schedule: null,
    analytics: false, feed: null, fx: require(path.join(repo, "feedweb")).fx, embeds: require(path.join(repo, "stageembed")), host: "publicaccess.tv",
  }, extra);
  const page = async (u) => (await ejs.renderFile(path.join(repo, "views", "room.ejs"), roomLocals(u))).replace(/\r\n/g, "\n");
  let html = await page("fan");
  assert.match(html, /<link rel="stylesheet" href="\/public\/css\/padfx\.css\?v=1">/);
  assert.match(html, /<section class="hero pfx pfx-f-pride is-anim" aria-labelledby="rmTitle"><span class="pfx-l" aria-hidden="true"><\/span>/);
  assert.match(html, /<span class="rm-nm pfx-g pfx-g-rainbow">Houseplants<\/span><span class="pfx-bs">/);
  assert.match(html, /role="menuitem" data-pad-gift="[^"]+">🎁 Gift a cosmetic<\/button>/, "⋯ menu for a non-owner");
  assert.match(html, /<section class="card ab-gift" id="gift"[\s\S]*?never refunded[\s\S]*?data-pad-gift=/, "About tab entry + the no-refund rule");
  assert.match(html, /\/public\/js\/pad-cosmetics\.js\?v=1/);
  html = await page("plantowner");
  assert.doesNotMatch(html, /data-pad-gift/, "the owner buys from settings, not by gifting");
  assert.match(html, /settings#cosmetics">✨ Cosmetics in your pad's settings/);
  html = await page(null);
  assert.match(html, /href="\/login\?next=[^"]+%23gift">🎁 Gift a cosmetic<\/a>/, "signed out: sign in first");
  // a pad with nothing equipped renders exactly as before
  html = (await ejs.renderFile(path.join(repo, "views", "room.ejs"), roomLocals("fan", { room: { ...roomLocals().room, id: "Bare.Room", ownerUser: null, owner: null } }))).replace(/\r\n/g, "\n");
  assert.match(html, /<section class="hero" aria-labelledby="rmTitle">\n/);
  // /p cards + Top Pads
  const rooms_ = rd("views/rooms.ejs");
  assert.match(rooms_, /<a class="ch[^"]*<%= fx_ && fx_\.cls \? ' ' \+ fx_\.cls : '' %>" href="[^"]*"><%- fx_ \? fx_\.layer : '' %>/);
  assert.match(rooms_, /<span class="t<%= fx_ && fx_\.glow \? ' ' \+ fx_\.glow : '' %>"><%= r\.title %><\/span><%- fx_ \? fx_\.badges : '' %>/);
  const home = rd("views/home.ejs");
  assert.match(home, /<span class="nt<%= fx_ && fx_\.glow \? ' ' \+ fx_\.glow : '' %>"><%= r\.name %><\/span><%- fx_ \? fx_\.badgesMini : '' %>/);
  assert.match(home, /padfx\.css\?v=1/);
  // settings: the ✨ Cosmetics section inside the 🎨 Look card
  const ps = rd("views/padSettings.ejs");
  const look = ps.slice(ps.indexOf('<h3>🎨 Look</h3>'), ps.indexOf('id="royalties"'));
  assert.match(look, /<div class="pc" id="cosmetics" data-mode="manage" data-url="\/api\/rooms\/<%= encodeURIComponent\(slug\) %>\/cosmetics"/);
  assert.match(look, /<h4 class="pc-h">✨ Cosmetics<\/h4>/);
  assert.match(ps, /pad-cosmetics\.js\?v=1/);
  const js = rd("public/js/pad-cosmetics.js");
  assert.match(js, /Where the PAT goes/); assert.match(js, /no refund/i); assert.match(js, /newRef\(\)/);
  // /cosmetics: a Pad group
  const cos = rd("views/cosmetics.ejs");
  assert.match(cos, /data-ftype="group:Pad">🛋️ Pad<\/button>/);
  assert.match(cos, /data-group="Pad"/);
  const cosJs = rd("cosmetics.js");
  assert.match(cosJs, /padCat = require\("\.\/padcosmetics"\)\.catalog\(now\)/);
  // /economy: one line on pad cosmetics routing
  const eco = rd("views/economy.ejs");
  assert.match(eco, /Pad cosmetics<\/b>[^<]*<\/p>|✨ Pad cosmetics<\/b>[\s\S]{0,300}100% to Fort Knox[\s\S]{0,200}half to Fort Knox, half to that pad's room vault/);
});
