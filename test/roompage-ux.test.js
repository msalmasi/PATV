// Offline tests for the room-page batch (1.99bx): the room Schedule (mainstage.roomSchedule + the
// partial) - what's public and what isn't -, the DJ booth's collapsed bar, the /stage device pickers
// and the channel guide's clickable cards.
//   node --test test/roompage-ux.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roompage-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

let T = Date.UTC(2026, 9, 6, 12, 0, 0);
S._setClock(() => T);
const PLANT = "plant_based_chatting";
let n = 0;
async function mkUser(extra = {}) {
  const id = "u" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, discordUsername, class)
                  VALUES (?, ?, ?, 'x', 100000, ?, ?, ?)`,
                 [id, extra.username || "user" + n, extra.display || "User " + n, extra.camfrog || null, extra.discord || null, extra.class || "pleb"]);
  return { userId: id, username: extra.username || "user" + n, class: extra.class || "pleb" };
}

let owner, admin, a, b, c, d, stranger;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  owner = await mkUser({ username: "pb", display: "pb", camfrog: "foamy1111", discord: "plantbaked" });
  admin = await mkUser({ username: "boss", class: "Admin" });
  await S.init();
  await S.setConfig({ price_per_min: 0, min_minutes: 2, max_minutes: 30, max_concurrent: 6, start_window_min: 10, idle_grace_min: 5,
                      bookings_per_hour: 50, revenue_vault: "reserve", enabled: true, schedule_days: 14, schedule_per_user: 3, lead_min: 5, queue_max: 10 }, "test");
  await rooms.setStage(PLANT, { slot_count: 1, approval: true }, "pb", { maxSlots: 4, maxPrice: 100 });
  [a, b, c, d, stranger] = [await mkUser({ display: "Alice Live" }), await mkUser({ display: "Bob Booked" }), await mkUser({ display: "Carol Pending" }),
                            await mkUser({ display: "Dave Queued" }), await mkUser({ display: "Just Looking" })];
  await S.book(a, { room: PLANT, minutes: 10, feature: false, title: "Open mic" });                  // on now (waiting for the stream)
  const rb = await S.book(owner, { room: PLANT, minutes: 15, feature: true, start_at: T + 2 * 3600000, title: "Owner's show" });
  assert.equal(rb.slot.status, "scheduled");
  const rbb = await S.book(b, { room: PLANT, minutes: 20, feature: false, start_at: T + 3 * 3600000, title: "Bob's set",
                               mode: "embed", embed: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(rbb.slot.status, "requested");
  await S.approve(rbb.slot.id, "pb");
  const rc = await S.book(c, { room: PLANT, minutes: 5, feature: false, start_at: T + 5 * 3600000, title: "SECRET-PENDING-TITLE" });
  assert.equal(rc.slot.status, "requested", "Carol's booking waits for the owner");
  await S.joinQueue(d, { room: PLANT, minutes: 5, feature: true });
});

test("schedule data: live now, booked + scheduled ahead, the queue; pending requests only for managers and the asker", async () => {
  const pub = await S.roomSchedule(PLANT, null, false);
  assert.equal(pub.live.length, 1);
  assert.equal(pub.live[0].display, "Alice Live"); assert.equal(pub.live[0].title, "Open mic"); assert.equal(pub.live[0].live, false);
  assert.deepEqual(pub.upcoming.map((u) => u.display), ["pb", "Bob Booked"]);
  const bob = pub.upcoming[1];
  assert.equal(bob.mode, "embed"); assert.match(bob.embed_label, /YouTube/i); assert.equal(bob.status, "scheduled");
  assert.equal(pub.upcoming[0].featured, true);
  assert.deepEqual(pub.queue.map((q) => [q.position, q.display, q.featured]), [[1, "Dave Queued", true]]);
  assert.equal(pub.pending, undefined);
  const json = JSON.stringify(pub);
  assert.doesNotMatch(json, /Carol Pending|SECRET-PENDING-TITLE/, "a pending request isn't public");
  for (const k of ["userId", "\"id\"", "key", "hls", "stream\":"]) assert.ok(!json.includes(k), "no " + k + " in the public schedule");

  const someone = await S.roomSchedule(PLANT, stranger, false);
  assert.doesNotMatch(JSON.stringify(someone), /Carol Pending/, "nor to another signed-in user");

  const carol = await S.roomSchedule(PLANT, c, false);
  const mine = carol.upcoming.find((u) => u.display === "Carol Pending");
  assert.ok(mine, "the asker sees their own request");
  assert.equal(mine.status, "requested"); assert.equal(mine.mine, true);
  assert.equal(carol.upcoming.filter((u) => u.mine).length, 1);

  const own = await S.roomSchedule(PLANT, owner, true);
  assert.ok(own.upcoming.some((u) => u.display === "Carol Pending" && u.status === "requested"), "the owner sees requests");
  assert.equal(own.pending, 1);
  assert.equal(own.upcoming.filter((u) => u.mine).length, 1, "the owner's own booking is marked theirs");
  const dave = await S.roomSchedule(PLANT, d, false);
  assert.equal(dave.queue[0].mine, true);
});

const renderRoom = (extra) => ejs.renderFile(path.join(repo, "views", "room.ejs"), {
  user: "u", signedIn: true, linked: true, room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "" },
  initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, ...extra });

test("room page: the schedule inside the ONE Stage card - local-time markup, one action row, no settings button, no pending for the public", async () => {
  const pub = await renderRoom({ schedule: await S.roomSchedule(PLANT, stranger, false), manage: false });
  assert.match(pub, /id="rmSched"/);
  // 1.99dx: merged into the Stage card, under the player: status line, Go live (primary) + Book a slot + Get featured in one row
  const card = pub.slice(pub.indexOf('id="rmStage"'), pub.indexOf("</section>", pub.indexOf('id="rmSched"')));
  assert.ok(card.includes('id="rmSched"'), "the schedule is inside the Stage card");
  assert.ok(card.indexOf('id="rmCap"') < card.indexOf('id="rmSlotsTxt"') && card.indexOf('id="rmSlotsTxt"') < card.indexOf('id="rmSched"'), "player + Snap/Clip, then the status + actions, then the schedule");
  assert.match(card, /<div class="stage-acts">\s*<a class="sact primary" href="\/stage\?room=plant_based_chatting">🎥 Go live here<\/a>\s*<a class="sact" href="\/stage\?room=plant_based_chatting#whenSet">📅 Book a slot<\/a>\s*<a class="sact" id="rmFeatBtn"/);
  assert.match(card, /Times in your local time/);
  assert.doesNotMatch(pub, /class="card rs"/, "no separate Schedule card");
  assert.doesNotMatch(pub, /\/p\/plant_based_chatting\/settings/, "1.99dc: no settings link for the public");
  assert.match(pub, /Alice Live/); assert.match(pub, /Bob Booked/); assert.match(pub, /Dave Queued/);
  assert.match(pub, /★ Featured/); assert.match(pub, /Ordinary slot/); assert.match(pub, /▶ YouTube/); assert.match(pub, /🎥 Stream/);
  assert.match(pub, /<time data-ts="\d+" data-min="15" datetime="2026-10-06T14:00:00.000Z">2026-10-06 14:00 UTC<\/time>/);
  assert.doesNotMatch(pub, /Carol Pending|SECRET-PENDING-TITLE|Waiting for the owner/);
  assert.match(pub, /room-schedule\.js/);
  assert.doesNotMatch(pub, /class="upnext"/, "the old up-next list gives way to the schedule");

  const own = await renderRoom({ schedule: await S.roomSchedule(PLANT, owner, true), manage: true });
  assert.doesNotMatch(own, /settings#stage/, "1.99dx: no Pad settings button in the Stage card");
  assert.match(own, /⚙ Pad settings[^<]*· 1 to approve<\/a>/, "the header's settings chip carries the approvals count");
  assert.match(own, /class="chip own ps-link" href="\/p\/plant_based_chatting\/settings"[^>]*>⚙ Pad settings[ <]/, "1.99dc: ONE settings link in the pad header");
  assert.match(own, /Carol Pending/); assert.match(own, /Waiting for the owner/);

  // names / titles are escaped
  const evil = await renderRoom({ schedule: { live: [], queue: [], upcoming: [{ display: "<img src=x onerror=alert(1)>", title: "<b>t</b>", start_at: T, minutes: 5,
    featured: false, mode: "stream", status: "scheduled", mine: false }] }, manage: false });
  assert.doesNotMatch(evil, /<img src=x/); assert.match(evil, /&lt;img src=x/);
  // no schedule -> no card
  assert.doesNotMatch(await renderRoom({}), /id="rmSched"/);
});

test("DJ booth: collapsed by default - the compact bar, an expand toggle wired to the full booth, remembered in localStorage", async () => {
  const html = await renderRoom({});
  assert.match(html, /<section class="card rdj hide collapsed" id="rdj"/);
  assert.match(html, /<button type="button" class="tog" id="rdjTog" aria-expanded="false" aria-controls="rdjFull">/);
  assert.match(html, /id="rdjMini"/); assert.match(html, /id="rdjMiniArt"/); assert.match(html, /id="rdjMiniFill"/); assert.match(html, /id="rdjMiniCtrls"/);
  assert.match(html, /<div class="full" id="rdjFull">/);
  // the full booth (queue, Talk to the DJ, shout-outs, admin) lives inside #rdjFull
  const full = html.slice(html.indexOf('id="rdjFull"'), html.indexOf("</section>", html.indexOf('id="rdjFull"')));
  for (const id of ["rdjQueue", "rdjVibe", "rdjSo", "rdjAdmin", "rdjFind"]) assert.match(full, new RegExp('id="' + id + '"'), id + " is in the full booth");
  assert.match(html, /\.rdj\.collapsed \.full \{ display: none; \}/);
  assert.match(html, /room-dj\.js\?v=4/);   // 1.99bz vibe votes bumped the cache-buster
  const js = fs.readFileSync(path.join(repo, "public", "js", "room-dj.js"), "utf8");
  assert.match(js, /patvDjOpen/);
  assert.match(js, /try \{ localStorage\.setItem/);
  assert.match(js, /renderMini\(\)/);
  for (const v of ["'skip'", "'pause'", "'resume'", "'dj.next'"]) assert.ok(js.includes(v), "mini control " + v);
});

test("/stage: camera + mic pickers and Switch camera in the browser pane; the program-feed switcher in the script", async () => {
  const html = await ejs.renderFile(path.join(repo, "views", "stageBook.ejs"), {
    user: "u", me: { userId: "u1" }, rooms: [{ id: PLANT, slug: PLANT, title: "Houseplants", slot_price: 0 }], pick: PLANT,
    C: { price_per_min: 0, min_minutes: 2, max_minutes: 30, lead_min: 5, schedule_days: 14, enabled: true, max_concurrent: 6, idle_grace_min: 5 },
    rtmpServer: "rtmp://example/stage", balance: 0, twitchUrl: null, staff: false });
  for (const id of ["camSel", "micSel", "flipBtn", "devNote", "camFld"]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /stage-book\.js\?v=5/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "stage-book.js"), "utf8");
  assert.match(js, /captureStream/); assert.match(js, /createMediaStreamDestination/); assert.match(js, /enumerateDevices/);
  assert.match(js, /facingMode/); assert.match(js, /devicechange/); assert.match(js, /new Worker/);
  const bridge = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");
  assert.match(bridge, /deviceId = \{ ideal: id \}/, "push-to-talk mic pick never fails on a stale id");
  assert.match(bridge, /recSession\.before\(\)/, "the iOS audio-session handling is still there");
});

test("Pads: each card is one link to its pad (no buttons, no nested links); schedule rows are stretched links", async () => {
  const html = await ejs.renderFile(path.join(repo, "views", "rooms.ejs"), {
    user: null, signedIn: false, staff: false, owned: [], pepe: { active: false },
    ul: (n, o) => '<a href="/u/' + n + '">' + ((o && o.text) || n) + "</a>",
    rows: [{ id: PLANT, slug: PLANT, title: "Houseplants", live: true, bridged: true, count: 3, micCount: 0, slot_count: 1, house: false, owner: "pb", ownerUser: "pb",
             pepe_here: true, description: "Plants",
             now: [{ username: "ann", display: "Ann", live: true, mode: "rtmp" }],
             next: [{ username: "pb", display: "pb", start_at: T + 3600000, minutes: 15, featured: true, title: null }] },
           { id: "quiet", slug: "quiet", title: "Quiet", live: false, bridged: false, count: 0, micCount: 0, slot_count: 2, house: true, now: [], next: [] }] });
  assert.match(html, /<h1>📡 Pads<\/h1>/);
  assert.match(html, /<a class="ch live onair" href="\/p\/plant_based_chatting">/);
  assert.match(html, /<a class="rl" href="\/p\/plant_based_chatting">Houseplants<\/a>/);
  assert.match(html, /<span class="padref">p\/plant_based_chatting<\/span>/);
  assert.doesNotMatch(html, /Channel guide|>Channels /, "no 'channel' copy left");
  // no buttons on the cards
  assert.doesNotMatch(html, /Open pad|Go live here|class="acts"/);
  // no nested anchors: every pad card contains no other <a>
  const cards = html.split(/<a class="ch(?=[ "])/).slice(1).map((c) => c.slice(0, c.indexOf("</a>")));
  assert.equal(cards.length, 2);
  for (const c of cards) assert.doesNotMatch(c, /<a[\s>]/, "no <a> inside a pad card");
  // fixed rows; Pepe is an icon with a tooltip; zero mic count hidden; "book a slot" link gone
  for (const k of ["ch-head", "ch-meta", "ch-desc", "ch-foot", "ch-badges"]) assert.match(cards[0], new RegExp('class="' + k + '"'));
  assert.match(cards[0], /<span class="pepe-here" role="img" title="Pepe is in this room — his stream plays here" aria-label="Pepe is in this room — his stream plays here">🐸<\/span>/);
  assert.doesNotMatch(html, /Pepe's here/);
  assert.match(cards[0], /👥 3/);
  assert.doesNotMatch(cards[0], /🎙/);
  assert.doesNotMatch(cards[1], /👥/);
  assert.match(cards[0], /<b>Ann<\/b>/);
  assert.match(cards[1], /class="ch-desc"><\/div>/, "the description row is there even when empty");
  assert.match(cards[1], /Nothing booked<\/li>/);
  assert.doesNotMatch(html, /\/analytics"/, "no analytics list on /p");
  assert.match(html, /grid-template-rows: subgrid/);
  assert.match(html, /\.cg \.sched a\.rl::after \{ content: ""; position: absolute; inset: 0;/);
  // Go live stays on the "Your show" card
  assert.match(html, /<a class="golive-btn" href="\/stage">🎥 Go live<\/a>/);
});
