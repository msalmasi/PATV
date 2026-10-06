// Offline tests for room owners, per-room stages, featuring, scheduling / queue, embeds and royalties
// (1.99bi: rooms.js, mainstage.js, stageembed.js, royalties.js, roomsweb.js).
//   node --test test/rooms-stages.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));
const E = require(path.join(repo, "stageembed"));
const ROY = require(path.join(repo, "royalties"));
const funding = require(path.join(repo, "funding"));

let T = Date.UTC(2026, 9, 6, 12, 0, 0);     // a Tuesday
const clock = () => T;
S._setClock(clock); ROY._setClock(clock);
const adv = (ms) => { T += ms; };
const PRICE = 100, START = 100000;
const HOUSE = "PepeFrog.Room", PLANT = "plant_based_chatting";

async function balance(userId) { return (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [userId]))[0].b; }
let n = 0;
async function mkUser(bal = START, extra = {}) {
  const id = "u" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, discordUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
                 [id, extra.username || "user" + n, extra.display || "User " + n, bal, extra.camfrog || null, extra.discord || null, extra.class || "pleb"]);
  return { userId: id, username: extra.username || "user" + n, class: extra.class || "pleb" };
}
const pub = (name, extra = {}) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: "7", ...extra });
const upd = (name, extra = {}) => S.rtmpCallback({ call: "update_publish", app: "stage", name, addr: "1.2.3.4", clientid: "7", ...extra });
async function stream(name, secs, extra) {
  for (let t = 0; t < secs; t += 5) {
    adv(5000);
    if (t % 10 === 5) await upd(name, extra);
    await S.tick();
  }
}
async function clear() {
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await runQuery("UPDATE stage_queue SET status = 'left' WHERE status = 'waiting'");
}

let owner, admin;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  // the seed's owner match: "plantbaked" is this account's Discord name (as on prod)
  owner = await mkUser(START, { username: "pb", display: "pb", camfrog: "foamy1111", discord: "plantbaked" });
  // Pepe's automatic account for a Camfrog login "plantbaked" (as on staging): the real account still wins
  await mkUser(START, { username: "CF2o8n8u2v", display: "plantbaked", camfrog: "plantbaked" });
  admin = await mkUser(START, { username: "boss", class: "Admin" });
  await S.init();
  await S.setConfig({ price_per_min: PRICE, min_minutes: 2, max_minutes: 30, max_concurrent: 6, start_window_min: 10, idle_grace_min: 5,
                      bookings_per_hour: 50, revenue_vault: "reserve", enabled: true, schedule_days: 14, schedule_per_user: 3, lead_min: 5, queue_max: 10 }, "test");
  await ROY.setConfig({ enabled: true, stage_pct: 20, period_days: 7, min_active_days: 2, active_minutes: 30, active_peak: 2,
                        cap_per_period: 100000, keep_periods: 2 }, "test");
});
test.afterEach(clear);

// ── embeds ──
test("embed links: YouTube / Twitch parsed to ids, everything else refused", () => {
  const ok = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", { p: "youtube", t: "video", id: "dQw4w9WgXcQ" }],
    ["youtu.be/dQw4w9WgXcQ", { p: "youtube", t: "video", id: "dQw4w9WgXcQ" }],
    ["https://youtube.com/live/abcdefghijk?feature=share", { p: "youtube", t: "live", id: "abcdefghijk" }],
    ["https://m.youtube.com/shorts/abcdefghijk", { p: "youtube", t: "video", id: "abcdefghijk" }],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live", { p: "youtube", t: "channel", id: "UCabcdefghijklmnopqrstuv" }],
    ["https://www.twitch.tv/SomeStreamer", { p: "twitch", t: "channel", id: "somestreamer" }],
    ["twitch.tv/videos/123456789", { p: "twitch", t: "vod", id: "123456789" }],
    ["https://player.twitch.tv/?channel=abc_123&parent=x.com", { p: "twitch", t: "channel", id: "abc_123" }],
  ];
  for (const [u, want] of ok) assert.deepEqual(E.parse(u), want, u);
  const bad = ["", "javascript:alert(1)", "https://evil.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short", "https://www.youtube.com/@handle", "https://www.twitch.tv/directory", "https://www.twitch.tv/x/clip/abc",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ\"><script>", "https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ", "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ", "https://vimeo.com/123"];
  for (const u of bad) assert.throws(() => E.parse(u), E.EmbedError, u);
  assert.equal(E.playerUrl({ p: "youtube", t: "video", id: "dQw4w9WgXcQ" }), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1");
  assert.match(E.playerUrl({ p: "twitch", t: "channel", id: "abc" }, "staging.publicaccess.tv"), /^https:\/\/player\.twitch\.tv\/\?channel=abc&parent=staging\.publicaccess\.tv&/);
  assert.equal(E.clean({ p: "youtube", t: "video", id: "<script>xx" }), null, "stored embeds are re-checked");
  assert.equal(E.playerUrl({ p: "twitch", t: "channel", id: "abc" }, "evil.com\" onload=x"), "https://player.twitch.tv/?channel=abc&parent=publicaccess.tv&autoplay=true&muted=true");
});

// ── registry + owners ──
test("seeds: Pepe's Pad is the house's, Houseplants is plantbaked's (matched by Discord name); admin changes stick", async () => {
  const pad = await rooms.get(HOUSE);
  assert.equal(pad.title, "Pepe's Pad"); assert.equal(pad.owner_kind, "house"); assert.equal(pad.owner, null);
  const hp = await rooms.get(PLANT);
  assert.equal(hp.title, "Houseplants"); assert.equal(hp.owner.userId, owner.userId); assert.equal(hp.slot_count, 1);
  // permissions
  const someone = await mkUser();
  assert.equal(await rooms.canManage(owner, PLANT), true);
  assert.equal(await rooms.canManage(owner, HOUSE), false, "an owner can't run Pepe's room");
  assert.equal(await rooms.canManage(someone, PLANT), false);
  assert.equal(await rooms.canManage(admin, HOUSE), true);
  assert.equal(await rooms.canManage(null, PLANT), false);
  // an admin change is never overwritten by the seed again
  await rooms.setOwner(PLANT, "user" + someone.userId.slice(1), "boss");
  assert.equal((await rooms.get(PLANT)).owner.userId, someone.userId);
  await rooms.setOwner(PLANT, "plantbaked", "boss");
  assert.equal((await rooms.get(PLANT)).owner.userId, owner.userId, "found by Discord name");
  await assert.rejects(rooms.setOwner(PLANT, "nobody-like-this", "boss"), /No single PATV account/);
  // owners for Pepe carry the Camfrog name (lower-case)
  const forPepe = await rooms.ownersForPepe();
  assert.equal(forPepe.find((r) => r.id === PLANT).owner.camfrog, "foamy1111");
  assert.equal(forPepe.find((r) => r.id === HOUSE).owner_kind, "house");
});

test("owner match (1.99bn): an automatic account whose Camfrog login is someone's display name is never picked", async () => {
  // "plantbaked" matches pb (Discord) and CF2o8n8u2v (its Camfrog login = pb's Discord name): pb, always
  assert.equal((await rooms.findUser("plantbaked")).userId, owner.userId);
  assert.equal((await rooms.findUser("foamy1111")).userId, owner.userId, "the seed's Camfrog login");
  // even with no real account sharing the typed name, the display-name ghost isn't chosen
  const real = await mkUser(START, { username: "realguy", display: "zz_display", camfrog: "realguy_login" });
  const ghost = await mkUser(START, { username: "CFabcdefgh", display: "zz_display", camfrog: "zz_display" });
  assert.equal((await rooms.findUser("zz_display")).userId, real.userId);
  assert.ok(ghost);
  // an ordinary automatic account (its login is nobody else's name) is still found
  const auto = await mkUser(START, { username: "CFqqqqqqqq", display: "lonely", camfrog: "lonely" });
  assert.equal((await rooms.findUser("lonely")).userId, auto.userId);
});

test("owner settings: slot count / price / approval clamped; page fields cleaned; banner must be https", async () => {
  const R = await rooms.setStage(PLANT, { slot_count: 99, slot_price: 5000, approval: "on" }, "pb", { maxSlots: 4, maxPrice: PRICE });
  assert.equal(R.slot_count, 4); assert.equal(R.slot_price, PRICE); assert.equal(R.approval, true);
  const R2 = await rooms.setStage(PLANT, { slot_count: 0, slot_price: -5, approval: false }, "pb", { maxSlots: 4, maxPrice: PRICE });
  assert.equal(R2.slot_count, 1); assert.equal(R2.slot_price, 0); assert.equal(R2.approval, false);
  const P = await rooms.setPage(PLANT, { title: "  Houseplants\u0000 🌱 ", description: "Plants\nand chat", banner: "https://img.example/x.png" }, "pb");
  assert.equal(P.title, "Houseplants 🌱"); assert.equal(P.description, "Plants\nand chat"); assert.equal(P.banner, "https://img.example/x.png");
  await assert.rejects(rooms.setPage(PLANT, { banner: "javascript:alert(1)" }, "pb"), /https/);
  await assert.rejects(rooms.setPage(PLANT, { banner: "http://insecure/x.png" }, "pb"), /https/);
  await assert.rejects(rooms.setPage(PLANT, { banner: 'https://x.com/a" onerror="x' }, "pb"), /https/);
  await rooms.setPage(PLANT, { title: "Houseplants", banner: "" }, "pb");
});

test("front room: admin pick, else the automatic (fair) pick, else - nothing ever live - the house room", async () => {
  await rooms.setFront("auto", "boss");
  assert.deepEqual(await rooms.frontRoom([]), { id: HOUSE, pinned: false });
  const summary = [{ id: "A", live: true, count: 3 }, { id: "B", live: true, count: 9 }, { id: "C", live: false, count: 50 }];
  // 1.99cj: Pepe's window room (the old second argument) is ignored; no activity yet -> headcount decides
  assert.deepEqual(await rooms.frontRoom(summary, { id: "A" }), { id: "B", pinned: false });
  await rooms.setFront(PLANT, "boss");
  assert.deepEqual(await rooms.frontRoom(summary), { id: PLANT, pinned: true });
  await assert.rejects(rooms.setFront("no-such-room", "boss"), /Unknown room/);
  await rooms.setFront("auto", "boss");
});

// ── per-room stages ──
test("slots per room: the owner's count is the limit; rooms don't share it; the site-wide cap still holds", async () => {
  await rooms.setStage(PLANT, { slot_count: 2 }, "pb", { maxSlots: 4, maxPrice: PRICE });
  const [a, b, c, d] = [await mkUser(), await mkUser(), await mkUser(), await mkUser()];
  const s1 = await S.book(a, { room: PLANT, minutes: 5, feature: false });
  assert.equal(s1.slot.held, 0, "ordinary slots are free by default"); assert.equal(s1.slot.featured, false); assert.equal(await balance(a.userId), START);
  await S.book(b, { room: PLANT, minutes: 5, feature: false });
  await assert.rejects(S.book(c, { room: PLANT, minutes: 5, feature: false }), (e) => e.status === 409 && /join the queue/.test(e.message));
  const h = await S.book(c, { room: HOUSE, minutes: 5, feature: false });    // another room has its own slot
  assert.equal(h.slot.room_id, HOUSE);
  await S.setConfig({ max_concurrent: 3 }, "test");
  try {
    await assert.rejects(S.book(d, { room: HOUSE, minutes: 5, feature: false }), (e) => e.status === 409);
  } finally { await S.setConfig({ max_concurrent: 6 }, "test"); }
  await assert.rejects(S.book(d, { room: "no-such-room", minutes: 5 }), (e) => e.status === 404);
  await rooms.setStage(PLANT, { slot_count: 1 }, "pb", { maxSlots: 4, maxPrice: PRICE });
});

test("a priced room: ordinary slots hold the room's price; the owner's price is capped at the featured price", async () => {
  await rooms.setStage(PLANT, { slot_price: 40 }, "pb", { maxSlots: 4, maxPrice: PRICE });
  try {
    const u = await mkUser();
    const r = await S.book(u, { room: PLANT, minutes: 10, feature: false });
    assert.equal(r.slot.price_per_min, 40); assert.equal(r.slot.held, 400);
    await pub(r.key, { clientid: "31" }); await S.tick();
    await stream(r.slot.stream, 70, { clientid: "31" });
    const res = await S.end(r.slot.id, "owner_ended", u.username);
    assert.equal(res.charged, 80); assert.equal(await balance(u.userId), START - 80);
    // the owner earned 20% royalty on it (accrued, not paid)
    const acc = await getQuery("SELECT amount, source FROM royalty_ledger WHERE ref = ?", ["stage:" + r.slot.id]);
    assert.deepEqual(acc.map((x) => [x.source, x.amount]), [["stage", 16]]);
  } finally { await rooms.setStage(PLANT, { slot_price: 0 }, "pb", { maxSlots: 4, maxPrice: PRICE }); }
});

test("featuring: one per room; paid feature only while nobody is featured; owner features free and overrides (paid one refunded)", async () => {
  await rooms.setStage(PLANT, { slot_count: 3 }, "pb", { maxSlots: 4, maxPrice: PRICE });
  const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
  const pa = await S.book(a, { room: PLANT, minutes: 10, feature: true });
  assert.equal(pa.slot.featured, true); assert.equal(pa.slot.held, 1000); assert.equal(pa.slot.feature_by, "paid");
  await assert.rejects(S.book(b, { room: PLANT, minutes: 5, feature: true }), (e) => e.status === 409 && /featured/.test(e.message));
  const sb = await S.book(b, { room: PLANT, minutes: 10, feature: false });
  // a goes live 90 s (2 billed minutes) then the owner features b instead
  await pub(pa.key, { clientid: "41" }); await S.tick();
  await stream(pa.slot.stream, 90, { clientid: "41" });
  const before = await balance(a.userId);
  await S.featureByOwner(sb.slot.id, "pb");
  let A = await S.getSlot(pa.slot.id), B = await S.getSlot(sb.slot.id);
  assert.equal(A.featured, 0); assert.equal(B.featured, 1); assert.equal(B.feature_by, "owner");
  assert.equal(A.held, 200, "hold shrunk to what was used"); assert.equal(await balance(a.userId), before + 800, "unused feature refunded at once");
  // a keeps streaming, but isn't billed any more
  await stream(pa.slot.stream, 120, { clientid: "41" });
  assert.equal((await S.getSlot(pa.slot.id)).charged, 200);
  const res = await S.end(pa.slot.id, "owner_ended", a.username);
  assert.equal(res.charged, 200); assert.equal(res.refund, 0);
  assert.equal(await balance(a.userId), START - 200);
  // owner unfeatures b (free feature: nothing to refund) -> c can now pay to be featured
  await S.unfeature(sb.slot.id, "pb");
  const pc = await S.book(c, { room: PLANT, minutes: 5, feature: true });
  assert.equal(pc.slot.featured, true);
  // public view: featured first
  await pub(pc.key, { clientid: "42" }); await S.tick();
  const live = await S.publicSlots(PLANT);
  assert.equal(live[0].id, pc.slot.id); assert.equal(live[0].featured, true);
  await rooms.setStage(PLANT, { slot_count: 1 }, "pb", { maxSlots: 4, maxPrice: PRICE });
});

test("feature me: a free slot pays only from the upgrade on, stops being featured when its minutes are used up", async () => {
  const u = await mkUser();
  const r = await S.book(u, { room: PLANT, minutes: 20, feature: false });
  await pub(r.key, { clientid: "51" }); await S.tick();
  await stream(r.slot.stream, 120, { clientid: "51" });            // 2 free minutes
  const v = await S.upgrade(u, r.slot.id, 2);
  assert.equal(v.featured, true); assert.equal(v.held, 200); assert.equal(v.charged, 0, "earlier minutes are not billed");
  assert.equal(await balance(u.userId), START - 200);
  await stream(r.slot.stream, 30, { clientid: "51" });
  assert.equal((await S.getSlot(r.slot.id)).charged, 100);
  await stream(r.slot.stream, 100, { clientid: "51" });
  const s = await S.getSlot(r.slot.id);
  assert.equal(s.charged, 200); assert.equal(s.featured, 0, "used up -> quietly unfeatured"); assert.equal(s.status, "active", "but still on the stage");
  await assert.rejects(S.upgrade(await mkUser(), r.slot.id, 2), (e) => e.status === 404, "only your own slot");
  const res = await S.end(r.slot.id, "owner_ended", u.username);
  assert.equal(res.charged, 200); assert.equal(await balance(u.userId), START - 200);
});

test("embed slots: live at once (no key), billed while open, never accepted by nginx", async () => {
  const u = await mkUser();
  await assert.rejects(S.book(u, { room: PLANT, minutes: 5, feature: true, mode: "embed", embed: "https://evil.com/x" }), (e) => e.status === 400);
  const r = await S.book(u, { room: PLANT, minutes: 5, feature: true, mode: "embed", embed: "https://youtu.be/dQw4w9WgXcQ", title: "Music <b>video</b>" });
  assert.equal(r.key, null); assert.equal(r.slot.status, "active"); assert.equal(r.slot.live, true);
  assert.deepEqual(r.slot.embed, { p: "youtube", t: "video", id: "dQw4w9WgXcQ" });
  const live = await S.publicSlots(PLANT);
  assert.equal(live[0].hls, null); assert.deepEqual(live[0].embed, r.slot.embed); assert.equal(live[0].title, "Music <b>video</b>", "stored as text; pages escape it");
  assert.equal((await S.rtmpCallback({ call: "publish", app: "live", name: r.slot.stream, addr: "127.0.0.1" })).status, 403);
  for (let i = 0; i < 20; i++) { adv(5000); await S.tick(); }                 // ~95 s
  const res = await S.end(r.slot.id, "owner_ended", u.username);
  assert.equal(res.charged, 200);
});

test("scheduling: holds when booked, opens at start - lead, reminder before, capacity respected, cancel refunds in full", async () => {
  const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
  const at = T + 60 * 60000;
  const r = await S.book(a, { room: PLANT, minutes: 10, feature: true, start_at: at });
  assert.equal(r.slot.status, "scheduled"); assert.equal(r.slot.held, 1000); assert.equal(await balance(a.userId), START - 1000);
  assert.equal((await pub(r.key)).status, 403, "the key doesn't work before the slot opens");
  // the room has 1 slot: an overlapping booking is refused, a later one is fine
  await assert.rejects(S.book(b, { room: PLANT, minutes: 10, feature: false, start_at: at + 5 * 60000 }), (e) => e.status === 409);
  const later = await S.book(b, { room: PLANT, minutes: 10, feature: false, start_at: at + 60 * 60000 });
  assert.equal(later.slot.status, "scheduled");
  // someone booking NOW for 30 min would collide with the 1 h booking? no: ends before it
  const now1 = await S.book(c, { room: PLANT, minutes: 30, feature: false });
  assert.equal(now1.slot.status, "waiting");
  await S.end(now1.slot.id, "owner_ended", c.username);
  // reminder 15 min before
  adv(46 * 60000); await S.tick();
  assert.equal((await S.getSlot(r.slot.id)).notified, 1);
  const inbox = await getQuery("SELECT title FROM inbox WHERE user_id = ? ORDER BY id", [a.userId]);
  assert.ok(inbox.some((x) => /starts in/.test(x.title)), JSON.stringify(inbox));
  // opens 5 min before the start
  adv(10 * 60000); await S.tick();
  let s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "waiting");
  assert.equal((await pub(r.key, { clientid: "61" })).status, 302);
  await S.tick();
  // cancel the later one: full refund
  const res = await S.end(later.slot.id, "cancelled", b.username);
  assert.equal(res.refund, 0); assert.equal(await balance(b.userId), START);
  await assert.rejects(S.book(a, { room: PLANT, minutes: 5, start_at: T + 20 * 86400000 }), /days ahead/);
});

test("approval: requests wait for the owner; deny refunds; not approved in time refunds; owner/staff bookings skip it", async () => {
  await rooms.setStage(PLANT, { approval: true }, "pb", { maxSlots: 4, maxPrice: PRICE });
  try {
    const [a, b] = [await mkUser(), await mkUser()];
    const r1 = await S.book(a, { room: PLANT, minutes: 5, feature: true, start_at: T + 3 * 3600000 });
    assert.equal(r1.slot.status, "requested"); assert.equal(await balance(a.userId), START - 500);
    const note = await getQuery("SELECT title, link FROM inbox WHERE user_id = ? AND title LIKE '%asked for a stage slot%'", [owner.userId]);
    assert.equal(note.length, 1); assert.match(note[0].link, /^\/p\/plant-based-chatting\/manage$/);
    await S.deny(r1.slot.id, "pb", "full that night");
    assert.equal(await balance(a.userId), START);
    const r2 = await S.book(b, { room: PLANT, minutes: 5, feature: false, start_at: T + 2 * 3600000 });
    assert.equal(r2.slot.status, "requested");
    await S.approve(r2.slot.id, "pb");
    assert.equal((await S.getSlot(r2.slot.id)).status, "scheduled");
    const r3 = await S.book(a, { room: PLANT, minutes: 5, feature: false, start_at: T + 5 * 3600000 });
    adv(5 * 3600000 + 11 * 60000); await S.tick();
    const s3 = await S.getSlot(r3.slot.id);
    assert.equal(s3.status, "ended"); assert.equal(s3.end_reason, "not_approved");
    const ro = await S.book(owner, { room: PLANT, minutes: 5, feature: false, start_at: T + 3600000 });
    assert.equal(ro.slot.status, "scheduled", "the owner's own bookings need no approval");
  } finally { await rooms.setStage(PLANT, { approval: false }, "pb", { maxSlots: 4, maxPrice: PRICE }); }
});

test("queue: next up gets the slot when it frees (featured if asked and free), notified; can leave; full refusal", async () => {
  const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
  const sa = await S.book(a, { room: PLANT, minutes: 5, feature: false });
  const q1 = await S.joinQueue(b, { room: PLANT, minutes: 5, feature: true });
  const q2 = await S.joinQueue(c, { room: PLANT, minutes: 5, mode: "embed", embed: "https://twitch.tv/somechan" });
  assert.equal(q1.position, 1); assert.equal(q2.position, 2);
  await assert.rejects(S.joinQueue(b, { room: PLANT, minutes: 5 }), /already in a queue/);
  await S.tick();
  assert.equal((await S.queueFor(PLANT)).length, 2, "still busy: nobody promoted");
  await S.end(sa.slot.id, "owner_ended", a.username);
  await S.tick();
  const mineB = await S.mine(b.userId);
  const sb = mineB.slots.find((x) => x.status === "waiting");
  assert.ok(sb, "b got the slot"); assert.equal(sb.featured, true); assert.equal(sb.held, 500);
  assert.ok((await getQuery("SELECT title FROM inbox WHERE user_id = ?", [b.userId])).some((x) => /You're up/.test(x.title)));
  assert.equal((await S.queueFor(PLANT)).length, 1);
  assert.equal(await S.leaveQueue(c, q2.id), true);
  assert.equal((await S.queueFor(PLANT)).length, 0);
});

test("room bans: block booking + publishing in that room only; the owner can't be banned from their room", async () => {
  const u = await mkUser();
  const r = await S.book(u, { room: PLANT, minutes: 5, feature: false });
  await S.roomBan(PLANT, u.username, "spam", "pb");
  assert.equal((await S.getSlot(r.slot.id)).end_reason, "banned");
  await assert.rejects(S.book(u, { room: PLANT, minutes: 5, feature: false }), (e) => e.status === 403);
  const h = await S.book(u, { room: HOUSE, minutes: 5, feature: false });
  assert.equal(h.slot.status, "waiting", "other rooms are fine");
  await assert.rejects(S.roomBan(PLANT, "pb", "x", "boss"), /owner/);
  await S.roomUnban(PLANT, u.userId, "pb");
});

test("legacy API: book() with no room = a paid take-over of the house room (the 1.99al behaviour)", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  assert.equal(r.slot.room_id, HOUSE); assert.equal(r.slot.featured, true); assert.equal(r.slot.held, 500);
});

// ── royalties ──
test("royalties: stage share, Pepe's routed owner shares (as-is), the owner's own spend, house rooms, idempotent", async () => {
  assert.equal(ROY.share("stage", 1000), 200); assert.equal(ROY.share("spend", 999), 0, "room spend arrives as the share"); assert.equal(ROY.share("other", 1000), 0);
  const u = await mkUser(START, { camfrog: "spender1" });
  const before = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM royalty_ledger WHERE kind = 'accrue' AND source = 'spend'"))[0].t;
  const n1 = await ROY.spendBatch([
    { room: PLANT, amount: 500, base: 5000, share: true, login: "Spender1", cmd: "imagine", ref: "r-1" },
    { room: PLANT, amount: 500, base: 5000, share: true, login: "spender1", cmd: "imagine", ref: "r-1" },      // a re-sent batch
    { room: PLANT, amount: 300, base: 3000, share: true, login: "foamy1111", cmd: "ask", ref: "r-2" },        // the owner himself
    { room: HOUSE, amount: 300, base: 3000, share: true, login: "spender1", cmd: "ask", ref: "r-3" },         // Pepe's room
    { room: "unknown-room", amount: 300, share: true, login: "spender1", ref: "r-4" },
    { room: PLANT, amount: -5, share: true, login: "spender1", ref: "r-5" },
    { room: PLANT, amount: 5000, login: "spender1", cmd: "ask", ref: "r-6" },                                 // pre-1.99br report: ignored
  ]);
  assert.equal(n1, 1);
  const after = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM royalty_ledger WHERE kind = 'accrue' AND source = 'spend'"))[0].t;
  assert.equal(after - before, 500);
  assert.ok(u);
});

test("royalties: released weekly by the Reserve only when the room was active; capped; carried over; expired; retried when unfunded", async () => {
  // a fresh owner + room so earlier tests' accruals don't mix in
  const o2 = await mkUser(START, { username: "roomowner2", camfrog: "ro2" });
  await rooms.addRoom("royal_room", "Royal Room", "boss");
  await rooms.setOwner("royal_room", "roomowner2", "boss");
  T = Date.UTC(2026, 9, 12, 10, 0, 0);                      // a Monday: start of a period
  const P0 = ROY.periodOf(T);
  await ROY.spendBatch([{ room: "royal_room", amount: 200000, base: 2000000, share: true, login: "someone", ref: "big-1" }]);   // a 10% share
  // active on 2 days (>= 30 min, peak >= 2): one minute bucket at a time
  for (const day of [0, 1]) {
    for (let m = 0; m < 31; m++) await rooms.noteActivity("royal_room", 3, 1, T + day * 86400000 + m * 60000);
  }
  await rooms.noteActivity("royal_room", 1, 0, T + 2 * 86400000);   // a quiet day: doesn't count
  assert.equal(await ROY.activeDays("royal_room", P0), 2);
  // next period: the Reserve isn't synced -> unfunded, retried; then funded -> capped at 100,000
  T += 7 * 86400000;
  funding.state.reserve = null;
  let out = await ROY.releaseTick();
  assert.equal(out.find((x) => x.room === "royal_room").outcome, "unfunded");
  funding.sync({ reserve: 10000000 });
  const bal0 = await balance(o2.userId);
  out = await ROY.releaseTick();
  assert.deepEqual(out.find((x) => x.room === "royal_room"), { room: "royal_room", owner: o2.userId, outcome: "released", amount: 100000 });
  assert.equal(await balance(o2.userId), bal0 + 100000);
  const claim = await getQuery("SELECT flow, amount FROM reserve_claims WHERE flow = 'room_owner'");
  assert.deepEqual(claim.map((c) => [c.flow, c.amount]), [["room_owner", 100000]], "paid from the Reserve as a claim Pepe settles");
  out = await ROY.releaseTick();
  assert.equal(out.find((x) => x.room === "royal_room"), undefined, "a period is processed once");
  let st = await ROY.status("royal_room", o2.userId);
  assert.equal(st.pending, 100000); assert.equal(st.paid, 100000);
  // the next period was quiet: missed, carried over
  T += 7 * 86400000;
  out = await ROY.releaseTick();
  assert.equal(out.find((x) => x.room === "royal_room").outcome, "missed");
  // two more quiet periods: what was earned in P0 is now older than keep_periods (2) -> forfeited
  T += 7 * 86400000; await ROY.releaseTick();
  T += 7 * 86400000; out = await ROY.releaseTick();
  st = await ROY.status("royal_room", o2.userId);
  assert.equal(st.forfeited, 100000); assert.equal(st.pending, 0);
  assert.equal(st.earned, st.paid + st.forfeited + st.pending, "the ledger always balances");
  const notes = (await getQuery("SELECT title FROM inbox WHERE user_id = ?", [o2.userId])).map((x) => x.title);
  assert.ok(notes.some((t) => /\+100,000 PAT pad owner royalties/.test(t))); assert.ok(notes.some((t) => /carried over/.test(t)));
  T = Date.UTC(2026, 9, 6, 12, 0, 0) + 400 * 86400000;
});

test("royalties (1.99br): Pepe's routed room_owner shares booked as-is, flows, voids, owner shares, summary", async () => {
  await rooms.setOwner(PLANT, "foamy1111", "boss");
  assert.equal(ROY.categoryOf("!speak"), "say"); assert.equal(ROY.categoryOf("voice:morgan"), "voice");
  assert.equal(ROY.categoryOf("play"), "queue"); assert.equal(ROY.categoryOf("shoutout"), "shoutout"); assert.equal(ROY.categoryOf(""), "other");
  assert.equal(ROY.labelOf("shoutout"), "DJ shout-outs"); assert.equal(ROY.labelOf("brandnew"), "!brandnew");
  assert.equal(ROY.config().spend_pct, undefined, "no website rate for room spend - Pepe's routing decides");
  await mkUser(START, { camfrog: "cats1" });
  const sum0 = await ROY.summary();
  const n = await ROY.spendBatch([
    { room: PLANT, amount: 250, base: 2500, share: true, login: "cats1", cmd: "shoutout", ref: "c-1" },   // Soho 20 / Reserve 70 / owner 10
    { room: PLANT, amount: 100, base: 1000, share: true, login: "cats1", cmd: "queue", ref: "c-2" },
    { room: PLANT, amount: 333, base: 1000, share: true, login: "cats1", cmd: "say", ref: "c-3" },        // an admin-set 33.3%: booked as-is
  ]);
  assert.equal(n, 3);
  const row = async (ref) => (await getQuery("SELECT category, base, amount FROM royalty_ledger WHERE ref = ?", ["spend:" + ref]))[0];
  assert.deepEqual({ ...(await row("c-1")) }, { category: "shoutout", base: 2500, amount: 250 });
  assert.equal((await row("c-3")).amount, 333);
  await ROY.spendBatch([
    { ref: "c-2", void: true },                                                                       // refunded: gone
    { room: PLANT, amount: 100, base: 1000, share: true, login: "cats1", cmd: "queue", ref: "c-2" },  // a re-sent copy can't come back
  ]);
  assert.equal(await row("c-2"), undefined);
  // Pepe's live shares (owner sync) are kept for the owner / admin pages
  await ROY.setOwnerShares([{ flow: "shoutout", label: "!dj shoutout", pct: 10 }, { flow: "sponsor", label: "!sponsor", pct: 0 }, null, { nope: 1 }]);
  assert.deepEqual(ROY.ownerShares(), [{ flow: "shoutout", label: "!dj shoutout", pct: 10 }, { flow: "sponsor", label: "!sponsor", pct: 0 }]);
  const sum = await ROY.summary();
  assert.equal(sum.windows.today.accrued - sum0.windows.today.accrued, 583);
  assert.deepEqual(sum.owner_shares, ROY.ownerShares());
  const hp = sum.rooms.find((r) => r.room_id === PLANT);
  assert.ok(hp && hp.owner === "pb" && hp.pending === hp.earned - hp.paid - hp.expired);
  const so = sum.categories.find((c) => c.category === "shoutout");
  assert.ok(so && so.label === "DJ shout-outs" && so.base_30d >= 2500 && so.accrued_30d >= 250);
  assert.ok(sum.rooms.every((r) => r.room_id !== "-"), "void markers aren't rooms");
  const st = await ROY.status(PLANT, owner.userId);
  assert.deepEqual(st.owner_shares, ROY.ownerShares());
});

// ── HTTP: owner routes + Pepe's endpoints ──
test("HTTP: owner-only routes, Pepe's owner sync + !stage act, front room needs staff", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const users = { [owner.userId]: owner, [admin.userId]: admin };
  const addUser = (req, res, next) => { const id = req.headers["x-test-user"]; req.user = id ? (users[id] || { userId: id, username: "x", class: "pleb" }) : null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const J = (url, body, user, extra = {}) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": user } : {}), ...extra },
                                                                 body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    const someone = await mkUser();
    let r = await J("/api/rooms/plant-based-chatting/stage-settings", { slot_count: 2 }, someone.userId);
    assert.equal(r.status, 403);
    r = await J("/api/rooms/plant-based-chatting/stage-settings", { slot_count: 2 }, owner.userId);
    assert.equal(r.status, 200); assert.equal(r.j.room.slot_count, 2);
    r = await J("/api/rooms/pepefrog-room/stage-settings", { slot_count: 2 }, owner.userId);
    assert.equal(r.status, 403, "not his room");
    r = await fetch(base + "/api/rooms/plant-based-chatting/page", { method: "POST", headers: { "Content-Type": "text/plain", "x-test-user": owner.userId }, body: "title=x" });
    assert.equal(r.status, 415, "a cross-site form can't post here");
    r = await J("/api/rooms/front", { room: PLANT }, owner.userId);
    assert.equal(r.status, 403, "owners don't pick the homepage room");
    r = await J("/api/rooms/front", { room: "auto" }, admin.userId);
    assert.equal(r.status, 200);
    // Pepe: owners + !stage
    r = await J("/api/rooms/owners", { password: "nope" });
    assert.equal(r.status, 403);
    r = await J("/api/rooms/owners", { password: "bot" });
    assert.equal(r.j.rooms.find((x) => x.id === PLANT).owner.camfrog, "foamy1111");
    r = await J("/api/rooms/owners", { password: "bot", owner_shares: [{ flow: "queue", label: "Music queue (!play)", pct: 15 }] });
    assert.ok(r.j.ok); assert.deepEqual(ROY.ownerShares(), [{ flow: "queue", label: "Music queue (!play)", pct: 15 }], "Pepe's live shares stored");
    const u = await mkUser();
    const sl = await S.book(u, { room: PLANT, minutes: 5, feature: false });
    r = await J("/api/rooms/stage/act", { password: "bot", room: PLANT, by: "randomguy", verb: "cut" });
    assert.equal(r.j.ok, false, "not the owner");
    r = await J("/api/rooms/stage/act", { password: "bot", room: PLANT, by: "Foamy1111", verb: "feature", arg: "#1" });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal((await S.getSlot(sl.slot.id)).featured, 1);
    r = await J("/api/rooms/stage/act", { password: "bot", room: PLANT, by: "foamy1111", verb: "status" });
    assert.match(r.j.message, /1\/2 slots in use/);
    r = await J("/api/rooms/stage/act", { password: "bot", room: PLANT, by: "someadmin", admin: true, verb: "cut" });
    assert.equal(r.j.cut, 1);
    // slot owner controls: feature/cut by a non-owner refused
    const sl2 = await S.book(u, { room: PLANT, minutes: 5, feature: false });
    r = await J("/api/stage/slots/" + sl2.slot.id + "/feature", {}, someone.userId);
    assert.equal(r.status, 403);
    r = await J("/api/stage/slots/" + sl2.slot.id + "/cut", { ban: true }, owner.userId);
    assert.equal(r.status, 200);
    assert.equal((await S.roomBans(PLANT)).some((b) => b.userId === u.userId), true);
    await S.roomUnban(PLANT, u.userId, "pb");
    // !stage cut from the old bot (no room) still cuts every room
    await S.book(u, { room: HOUSE, minutes: 5, feature: false });
    r = await J("/api/stage/cut", { password: "bot" });
    assert.equal(r.j.cut, 1);
    // Pepe's spend batch
    r = await J("/api/rooms/royalties/spend", { password: "bot", items: [{ room: PLANT, amount: 100, base: 1000, share: true, login: "zz", ref: "http-1" }] });
    assert.equal(r.j.accrued, 1);
    r = await J("/api/rooms/royalties/summary", { password: "nope" });
    assert.equal(r.status, 403);
    r = await J("/api/rooms/royalties/summary", { password: "bot" });
    assert.equal(r.status, 200); assert.ok(r.j.ok && r.j.totals && r.j.windows["7d"] && Array.isArray(r.j.categories));
    await rooms.setStage(PLANT, { slot_count: 1 }, "pb", { maxSlots: 4, maxPrice: PRICE });
  } finally { srv.close(); }
});

test("money is conserved across stages: balances + held + revenue = what everyone started with", async () => {
  const users = await getQuery("SELECT SUM(points_balance) AS b FROM users");
  const open = await getQuery("SELECT COALESCE(SUM(held),0) AS h FROM stage_slots WHERE settled = 0");
  const rev = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE flow = 'stage_slot'");
  const paidOut = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE flow = 'room_owner'");
  const started = (await getQuery("SELECT COUNT(*) AS n FROM users"))[0].n * START;
  assert.equal(users[0].b + open[0].h + (-rev[0].t) - paidOut[0].t, started);
});
