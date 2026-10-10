// Offline tests for 1.99jp: 📼 Plex members (plexmembers.js), 🔁 store subscriptions (subscriptions.js), the free / paid
// 📼 Play-from-Plex terms (medialib.access), the automatic 📼 Plex flair (padflair.js) and the Plex perk cosmetics (cosmetics.js).
// Plex, Wizarr and Overseerr are stubs; nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/plexmembers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexm-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.WIZARR_URL;
delete process.env.OVERSEERR_URL;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIACTL_URL = "http://127.0.0.1:1";           // "configured" (access() never calls it)
process.env.MEDIACTL_SECRET = "s".repeat(40);

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const conf = require(path.join(repo, "mediaconf"));
const PM = require(path.join(repo, "plexmembers"));
const SUB = require(path.join(repo, "subscriptions"));
const L = require(path.join(repo, "medialib"));
const COS = require(path.join(repo, "cosmetics"));
const FL = require(path.join(repo, "padflair"));
const rooms = require(path.join(repo, "rooms"));

const DAY = 24 * 3600 * 1000;
const MONTH = "1c120384-c080-4186-b246-f1227e82ab01", YEAR = "a50a2e71-bd6b-467b-ae44-75ae59900637", LIFE = "e101bcff-cc8c-4db9-b4ca-302ef5e16871";
let T = Date.UTC(2026, 9, 10, 12);
const now = () => T;
PM._setClock(now);
SUB._setClock(now);

let n = 0;
async function mkUser({ cls = "pleb", bal = 100000000, email = null, verified = 0, name = null } = {}) {
  const id = "p" + (++n);
  const username = name || "member" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, email, isEmailVerified) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
                 [id, username, username, cls, bal, email, verified]);
  return { userId: id, username, class: cls };
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const setBal = (u, b) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [b, u.userId]);
async function order(userId, prizeId, daysAgo, status = "completed") {
  const t = T - daysAgo * DAY;
  await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, official, title, price, status, source, created, updated) VALUES (?, ?, 1, 'Plex', 1, ?, 'test', ?, ?)`,
                 [prizeId, userId, status, t, t]);
}
// a fake Plex server: the shares mediactl would return
let SHARES = [];
const share = (plexId, username, email, invitedDaysAgo, extra = {}) =>
  ({ share_id: "s" + plexId, plex_id: String(plexId), username, title: "", email, invited_at: Math.floor((T - invitedDaysAgo * DAY) / 1000),
     accepted_at: Math.floor((T - invitedDaysAgo * DAY) / 1000), pending: false, all_libraries: true, ...extra });
const removed = [];
PM._set({
  fetchShares: async () => SHARES.map((s) => ({ ...s })),
  wizarrRedemptions: async () => [],
  overseerrUsers: async () => [],
  removeShare: async (r, by) => { removed.push({ plex_id: r.plex_id, share_id: r.share_id, by }); SHARES = SHARES.filter((s) => s.plex_id !== r.plex_id); return { ok: true }; },
});

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await shop.ready;
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite 1 Month Access', 5000000, 50)", [MONTH]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite 1 Year Access', 50000000, 50)", [YEAR]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite Lifetime Access', 250000000, 50)", [LIFE]);
  await mkUser({ bal: 0, name: "pb" });                    // the store owner
  await conf.init();
  await PM.init();
  await SUB.init();
  await COS.ready;
});

test("access types: what PATV sold (stacked orders, lifetime, refunds) vs pre-existing / manual shares", async () => {
  const a = await mkUser();
  // nothing bought: pre-existing, never removed
  let pa = await PM.patvAccess(a.userId);
  assert.equal(pa.none, true);
  assert.deepEqual(PM.classify({ user_id: a.userId, invited_at: T - 100 * DAY }, pa), { access: "pre-existing", expires: null });
  // two months bought the same day stack to 60 days
  await order(a.userId, MONTH, 10);
  await order(a.userId, MONTH, 10);
  pa = await PM.patvAccess(a.userId);
  assert.equal(pa.active, true);
  assert.equal(pa.type, "monthly");
  assert.equal(pa.expires, T - 10 * DAY + 60 * DAY);
  assert.deepEqual(PM.classify({ user_id: a.userId, invited_at: T - 10 * DAY }, pa), { access: "monthly", expires: pa.expires });
  // shared long before the first PATV purchase: pre-existing whatever they bought later
  assert.equal(PM.classify({ user_id: a.userId, invited_at: T - 400 * DAY }, pa).access, "pre-existing");
  // a refunded order doesn't count; an expired one is over
  const b = await mkUser();
  await order(b.userId, MONTH, 45);
  await order(b.userId, YEAR, 5, "refunded");
  pa = await PM.patvAccess(b.userId);
  assert.equal(pa.active, false);
  const c = PM.classify({ user_id: b.userId, invited_at: T - 45 * DAY }, pa);
  assert.equal(c.access, "monthly");
  assert.ok(c.expires < T, "ended");
  assert.equal(PM.isCandidate({ ...c, user_id: b.userId, on_server: 1 }), true, "PATV-sold and ended: a removal candidate");
  // shared again by hand after the PATV time ended: manual, left alone
  const m = PM.classify({ user_id: b.userId, invited_at: T - 2 * DAY }, pa);
  assert.equal(m.access, "manual");
  assert.equal(PM.isCandidate({ ...m, user_id: b.userId, on_server: 1 }), false);
  // lifetime
  const l = await mkUser();
  await order(l.userId, LIFE, 300);
  pa = await PM.patvAccess(l.userId);
  assert.deepEqual([pa.active, pa.type, pa.expires], [true, "lifetime", null]);
  // pinned rows keep their type
  assert.deepEqual(PM.classify({ user_id: b.userId, access: "manual", access_pinned: 1 }, pa), { access: "manual", expires: null });
  // unlinked rows are never PATV-sold
  assert.deepEqual(PM.classify({ user_id: null }, null), { access: "pre-existing", expires: null });
});

let alice, bob, carol, dave, eve;
test("sync: shares become rows; auto-links by VERIFIED email (unique) + Wizarr + Overseerr; a same name is only suggested; dry run writes nothing", async () => {
  alice = await mkUser({ email: "Alice@Example.test", verified: 1 });            // email match
  bob = await mkUser({ email: "bob@example.test", verified: 0 });                // NOT verified: no auto link
  carol = await mkUser({ name: "carolplex" });                                   // same name as her Plex account: suggestion only
  dave = await mkUser();                                                         // Wizarr redemption of his PATV order's invite
  eve = await mkUser();                                                          // Overseerr link
  await order(alice.userId, MONTH, 3);
  await order(dave.userId, YEAR, 20);
  await runQuery(`CREATE TABLE IF NOT EXISTS media_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE, user_id TEXT NOT NULL, username TEXT,
                  prize_id TEXT, title TEXT, days INTEGER, status TEXT NOT NULL, code TEXT, url TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
                  created INTEGER NOT NULL, updated INTEGER NOT NULL, next_try INTEGER, done_by TEXT)`);
  await runQuery("INSERT INTO media_invites (order_id, user_id, username, status, code, created, updated) VALUES (9001, ?, ?, 'created', 'WZCODE1', ?, ?)", [dave.userId, dave.username, T, T]);
  await runQuery("CREATE TABLE IF NOT EXISTS media_user_links (user_id TEXT PRIMARY KEY, overseerr_user INTEGER NOT NULL, set_by TEXT, at INTEGER)");
  await runQuery("INSERT INTO media_user_links (user_id, overseerr_user) VALUES (?, 7)", [eve.userId]);
  PM._set({
    wizarrRedemptions: async () => [{ code: "WZCODE1", email_hash: PM.emailHash("dave@plex.test"), username: "davep" }],
    overseerrUsers: async () => [{ id: 7, plex_id: "5005", email_hash: null }],
  });
  SHARES = [share(1001, "alicep", "alice@example.test", 2), share(1002, "bobp", "bob@example.test", 50), share(1003, "carolplex", "c@x.test", 500),
            share(1004, "davep", "dave@plex.test", 19), share(5005, "evep", "e@x.test", 30), share(1006, "oldfriend", "old@x.test", 900),
            share(1007, "newbie", "n@x.test", 0, { pending: true, accepted_at: null })];
  const dry = await PM.sync({ dry: true });
  assert.equal(dry.plex_users, 7);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM plex_members"))[0].n, 0, "a dry run writes nothing");
  const r = await PM.sync();
  assert.equal(r.plex_users, 7);
  assert.equal(r.pending, 1);
  assert.equal(r.linked, 3, "alice (email), dave (wizarr), eve (overseerr)");
  assert.deepEqual(r.by_source, { email: 1, wizarr: 1, overseerr: 1 });
  assert.equal(r.unlinked, 4);
  const row = async (pid) => (await getQuery("SELECT * FROM plex_members WHERE plex_id = ?", [pid]))[0];
  assert.equal((await row("1001")).user_id, alice.userId);
  assert.equal((await row("1001")).access, "monthly");
  assert.equal((await row("1002")).user_id, null, "unverified email: not linked");
  assert.equal((await row("1003")).user_id, null, "same name: not linked");
  assert.equal((await row("1004")).access, "yearly");
  assert.equal((await row("5005")).access, "pre-existing", "eve bought nothing on PATV");
  assert.equal((await row("1006")).access, "pre-existing");
  assert.ok(!(await getQuery("SELECT email_hash FROM plex_members")).some((x) => /@/.test(x.email_hash || "")), "emails are only kept hashed");
  const st = await PM.adminState();
  assert.equal(st.unlinked.find((x) => x.plex_id === "1003").suggest, "carolplex");
  assert.equal(st.candidates.length, 0);
  // members (cached + uncached)
  assert.ok(PM.memberSync(alice.userId));
  assert.ok(await PM.memberFor(eve.userId));
  assert.equal(PM.memberSync(bob.userId), null);
  assert.equal(await PM.memberFor(carol.userId), null);
});

test("admin link / unlink is sticky; pins keep a share out of the removal list", async () => {
  await PM.adminLink("1003", "carolplex", "boss");
  await PM.sync();
  let r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1003'"))[0];
  assert.equal(r.user_id, carol.userId);
  assert.equal(r.link_source, "admin");
  await PM.adminLink("1001", "", "boss");                                    // unlink alice: a sync must not relink her by email
  await PM.sync();
  r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1001'"))[0];
  assert.equal(r.user_id, null);
  assert.equal(r.link_lock, 1);
  await PM.adminLink("1001", alice.username, "boss");
  await PM.sync();
  assert.equal((await getQuery("SELECT user_id FROM plex_members WHERE plex_id = '1001'"))[0].user_id, alice.userId);
});

test("removal: PATV-sold access that ended is only LISTED (auto-revoke off); an admin removes it; pre-existing / manual / pinned never", async () => {
  // dave's year ends; alice's month too
  T += 400 * DAY;
  let r = await PM.sync();
  assert.ok(r.candidates >= 2);
  assert.equal(removed.length, 0, "nothing removed while plex_auto_revoke is off");
  const st = await PM.adminState();
  const cand = st.candidates.map((x) => x.plex_id).sort();
  assert.ok(cand.includes("1001") && cand.includes("1004"));
  assert.ok(!cand.includes("5005") && !cand.includes("1006") && !cand.includes("1003"), "pre-existing / unpurchased never listed");
  // keep alice (pinned manual), remove dave
  await PM.adminPin("1001", "keep", "boss");
  await assert.rejects(PM.revoke("1001", "boss"), (e) => e.status === 409, "pinned: refused");
  await assert.rejects(PM.revoke("1006", "boss"), (e) => e.status === 409, "pre-existing: refused");
  const out = await PM.revoke("1004", "boss");
  assert.equal(out.ok, true);
  assert.deepEqual(removed.map((x) => x.plex_id), ["1004"]);
  r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1004'"))[0];
  assert.equal(r.revoke, "revoked");
  assert.equal(r.on_server, 0);
  assert.equal(PM.memberSync(dave.userId), null);
  const log = await getQuery("SELECT what FROM plex_member_log WHERE plex_id = '1004'");
  assert.ok(log.some((l) => l.what === "removed"));
  const note = await getQuery("SELECT title FROM inbox WHERE user_id = ?", [dave.userId]);
  assert.ok(note.some((x) => /Plex access ended/.test(x.title)));
});

test("auto-revoke on: the sync removes ended PATV-sold access itself (and only that)", async () => {
  const f = await mkUser();
  await order(f.userId, MONTH, 40);
  SHARES.push(share(1008, "frankp", "frank@x.test", 39));
  await PM.sync();
  await PM.adminLink("1008", f.username, "boss");
  await conf.set({ plex_auto_revoke: true }, "test");
  try {
    removed.length = 0;
    const r = await PM.sync();
    assert.equal(r.revoked, 1);
    assert.deepEqual(removed.map((x) => x.plex_id), ["1008"]);
  } finally { await conf.set({ plex_auto_revoke: false }, "test"); }
});

test("📼 terms: Plex members FREE (own daily cap), everyone else 50,000 PAT per started hour, admins free; off = closed", async () => {
  assert.equal(conf.get().library_price, 50000, "the new default");
  await conf.set({ library_enabled: true, library_plex: true, library_users: "" }, "test");
  const admin = await mkUser({ cls: "Admin" });
  const outsider = await mkUser();
  let a = await L.access(outsider);
  assert.deepEqual([a.ok, a.free, a.how], [true, false, "paid"], "no longer locked for non-Plex users");
  assert.equal(L.priceFor(6780, 0).price, 100000, "a 1:53 film = 2 started hours x 50k");
  assert.equal(L.priceFor(2700, 0).price, 50000);
  const info = await L.goLiveInfo(outsider);
  assert.equal(info.show, true);
  assert.equal(info.price_per_hour, 50000);
  assert.equal(info.daily_cap, 3);
  a = await L.access(eve);                                                    // on the server (pre-existing)
  assert.deepEqual([a.ok, a.free, a.how], [true, true, "plex"]);
  const mi = await L.goLiveInfo(eve);
  assert.equal(mi.member, true);
  assert.equal(mi.price_per_hour, 0);
  assert.equal(mi.daily_cap, 5, "free plays have their own cap (library_free_daily_cap)");
  assert.equal((await L.access(admin)).how, "admin");
  assert.equal((await L.access(admin)).free, true);
  await conf.set({ library_users: outsider.username }, "test");
  assert.deepEqual([(await L.access(outsider)).free, (await L.access(outsider)).how], [true, "override"]);
  await conf.set({ library_users: "", library_plex: false }, "test");
  assert.equal((await L.access(eve)).why, "off");
  assert.equal((await L.goLiveInfo(outsider)).show, false);
  assert.equal((await L.access(admin)).ok, true, "admins aren't affected");
  await conf.set({ library_plex: true }, "test");
  // the free daily cap counts free member plays only (not carried resumes, not admin plays)
  await runQuery(`CREATE TABLE IF NOT EXISTS media_plays (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, username TEXT, room_id TEXT NOT NULL, slot_id TEXT,
                  rating_key TEXT, title TEXT, kind TEXT, year INTEGER, duration INTEGER, quality INTEGER, offset_start INTEGER, audio INTEGER, sub INTEGER, ended_at INTEGER,
                  end_reason TEXT, last_pos INTEGER, error TEXT, price INTEGER NOT NULL DEFAULT 0, order_id INTEGER, charge TEXT, settled_at INTEGER, carried_from INTEGER, access TEXT)`);
  for (let i = 0; i < 3; i++) await runQuery("INSERT INTO media_plays (ts, user_id, room_id, charge, access) VALUES (?, ?, 'x', 'free', 'plex')", [Date.now(), eve.userId]);
  await runQuery("INSERT INTO media_plays (ts, user_id, room_id, charge, access, carried_from) VALUES (?, ?, 'x', 'free', 'plex', 1)", [Date.now(), eve.userId]);
  assert.equal(await L.freeToday(eve.userId), 3);
});

test("subscriptions: start = an ordinary purchase; renew charges once per period to the store owner; can't pay -> grace -> lapse", async () => {
  const s = await mkUser({ bal: 12000000 });
  const owner = (await getQuery("SELECT userId FROM users WHERE username = 'pb'"))[0];
  const ob = async () => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [owner.userId]))[0].b;
  const o0 = await ob();
  await assert.rejects(SUB.start(s, YEAR), (e) => e.status === 400, "only listed items are subscriptions");
  const r = await SUB.start(s, MONTH, 5000000);
  assert.equal(r.ok, true);
  assert.equal(await bal(s), 7000000);
  assert.equal(await ob(), o0 + 5000000, "routed like the item's sales: the store owner");
  await assert.rejects(SUB.start(s, MONTH, 5000000), (e) => e.status === 409, "one live subscription per item");
  let sub = (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [r.sub_id]))[0];
  assert.equal(sub.status, "active");
  assert.equal(sub.paid_through, T + 30 * DAY);
  assert.equal((await SUB.plexSub(s.userId)).live, true);
  // not due yet: nothing
  assert.deepEqual(await SUB.renewDue(), { renewed: 0, grace: 0, lapsed: 0, ended: 0 });
  // due: charged once (a second run in the same period charges nothing)
  T += 30 * DAY;
  assert.equal((await SUB.renewDue()).renewed, 1);
  assert.equal((await SUB.renewDue()).renewed, 0);
  assert.equal(await bal(s), 2000000);
  assert.equal(await ob(), o0 + 10000000);
  sub = (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [r.sub_id]))[0];
  assert.equal(sub.paid_through, T + 30 * DAY);
  assert.equal(sub.renewals, 1);
  const orders = await getQuery("SELECT * FROM shop_orders WHERE buyer_id = ? ORDER BY id", [s.userId]);
  assert.equal(orders.length, 2);
  assert.equal(orders[1].source, "subscription");
  assert.equal(orders[1].prize_id, MONTH, "renewal orders count as Plex access");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM shop_sub_ledger WHERE sub_id = ?", [r.sub_id]))[0].n, 2);
  // can't pay: grace (+ one notice), still live
  T += 30 * DAY;
  assert.equal((await SUB.renewDue()).grace, 1);
  assert.equal((await SUB.renewDue()).grace, 1);
  sub = (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [r.sub_id]))[0];
  assert.equal(sub.status, "grace");
  assert.equal(sub.grace_until, sub.paid_through + 3 * DAY);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND ref LIKE 'sub-grace:%'", [s.userId]))[0].n, 1);
  assert.equal((await SUB.plexSub(s.userId)).live, true, "access goes on during the grace");
  // tops up in the grace: Pay now renews from the original date
  await setBal(s, 6000000);
  assert.equal((await SUB.payNow(s, r.sub_id)).ok, true);
  sub = (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [r.sub_id]))[0];
  assert.equal(sub.status, "active");
  assert.equal(sub.paid_through, T + 30 * DAY);
  // next period unpaid past the grace: lapsed, not live, Plex access ends (subject to the review)
  T += 30 * DAY;
  await setBal(s, 0);
  await SUB.renewDue();
  T += 3 * DAY + 1000;
  assert.equal((await SUB.renewDue()).lapsed, 1);
  sub = (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [r.sub_id]))[0];
  assert.equal(sub.status, "lapsed");
  assert.equal((await SUB.plexSub(s.userId)).live, false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND ref LIKE 'sub-lapsed:%'", [s.userId]))[0].n, 1);
});

test("subscriptions: cancel keeps the paid time and never charges again; resume before the end; cancelling in the grace ends it", async () => {
  const s = await mkUser({ bal: 20000000 });
  const r = await SUB.start(s, MONTH, 5000000);
  const paid = T + 30 * DAY;
  const c = await SUB.cancel(s, r.sub_id);
  assert.equal(c.ends, paid);
  assert.equal((await SUB.plexSub(s.userId)).live, true, "still theirs until the paid date");
  await SUB.resume(s, r.sub_id);
  await SUB.cancel(s, r.sub_id);
  const other = await mkUser();
  await assert.rejects(SUB.cancel(other, r.sub_id), (e) => e.status === 404, "only your own");
  T = paid + 1000;
  const b0 = await bal(s);
  assert.equal((await SUB.renewDue()).ended, 1);
  assert.equal(await bal(s), b0, "a cancelled subscription is never charged again");
  assert.equal((await getQuery("SELECT status FROM shop_subs WHERE id = ?", [r.sub_id]))[0].status, "ended");
  await assert.rejects(SUB.resume(s, r.sub_id), (e) => e.status === 409);
  // cancel during the grace = ends now
  const g = await mkUser({ bal: 5000000 });
  const r2 = await SUB.start(g, MONTH, 5000000);
  T += 30 * DAY;
  await SUB.renewDue();
  assert.equal((await getQuery("SELECT status FROM shop_subs WHERE id = ?", [r2.sub_id]))[0].status, "grace");
  await SUB.cancel(g, r2.sub_id);
  assert.equal((await getQuery("SELECT status FROM shop_subs WHERE id = ?", [r2.sub_id]))[0].status, "ended");
  // the page data lists both kinds
  const pd = await SUB.pageData(g);
  assert.equal(pd.subs[0].status, "ended");
  assert.ok(pd.offers.some((o) => o.prize_id === MONTH && o.days === 30 && o.price === 5000000));
});

test("a subscriber on the server is a member with access type 'subscription' until it lapses", async () => {
  const s = await mkUser({ bal: 10000000 });
  await SUB.start(s, MONTH, 5000000);
  SHARES.push(share(1010, "subp", "sub@x.test", 0));
  await PM.sync();
  await PM.adminLink("1010", s.username, "boss");
  let r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1010'"))[0];
  assert.equal(r.access, "subscription");
  assert.ok(PM.memberSync(s.userId));
  T += 30 * DAY;
  await setBal(s, 0);
  await SUB.renewDue();                       // grace
  await PM.sync();
  assert.ok(PM.memberSync(s.userId), "still a member in the grace");
  T += 4 * DAY;
  await SUB.renewDue();                       // lapsed
  await PM.sync();
  r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1010'"))[0];
  assert.equal(r.revoke, "candidate", "listed for the admin to remove");
  assert.equal(PM.memberSync(s.userId), null);
});

test("📼 flair + perk cosmetics: automatic while a member, gone when it lapses; the pad's own flair wins", async () => {
  await rooms.init();
  const ROOM = "flair.pad";
  await rooms.addRoom(ROOM, null, "test");
  const x = await mkUser();
  await order(x.userId, MONTH, 1);
  SHARES.push(share(1011, "xp", "x@x.test", 0));
  await PM.sync();
  await PM.adminLink("1011", x.username, "boss");
  FL.dropAll();
  let m = await FL.forUsers(ROOM, [x.userId, carol.userId]);
  assert.equal(m.get(x.userId).name, "Plex");
  assert.equal(m.get(x.userId).emoji, "📼");
  assert.equal((await FL.byUsername(ROOM)).get(x.username).auto, "plex", "the live chat sees it too");
  assert.match(FL.html(m.get(x.userId)), /On our Plex server/);
  // the perk items were granted when they became a member
  const inv = await COS.inventory(x.userId);
  const perks = inv.items.filter((i) => i.perk === "plex").map((i) => i.item_id).sort();
  assert.deepEqual(perks, ["nc_plex", "pb_plex"]);
  const pb = inv.items.find((i) => i.item_id === "pb_plex");
  assert.equal((await COS.equip(x.userId, pb.inv_id, true)).ok, true);
  assert.equal((await COS.profileData(x.username)).plex, true);
  assert.ok((await COS.profileData(x.username)).equipped.profile_border, "renders while a member");
  // setting off: no flair
  await conf.set({ plex_flair: false }, "test");
  assert.equal((await FL.forUsers(ROOM, [x.userId])).get(x.userId), undefined);
  await conf.set({ plex_flair: true }, "test");
  // their access ends: flair, chip and the perk items' look go away (the items stay in the inventory)
  T += 40 * DAY;
  await PM.sync();
  FL.dropAll();
  assert.equal((await FL.forUsers(ROOM, [x.userId])).get(x.userId), undefined);
  assert.equal((await COS.profileData(x.username)).plex, false);
  assert.equal((await COS.profileData(x.username)).equipped.profile_border, undefined);
  assert.equal((await COS.equip(x.userId, pb.inv_id, true)).ok, false, "can't equip it while not a member");
  assert.ok((await COS.inventory(x.userId)).items.some((i) => i.item_id === "pb_plex" && i.perk_off));
});

test("self-link with Plex's sign-in (PIN): the account Plex says it is gets linked; the token is never kept", async () => {
  const me = await mkUser();
  const calls = [];
  PM._set({
    plexTv: async (method, p, hdr) => {
      calls.push({ method, p, token: hdr && hdr["X-Plex-Token"] });
      if (method === "POST" && p.startsWith("/api/v2/pins")) return { status: 201, json: { id: 777, code: "abcd1234" } };
      if (p === "/api/v2/pins/777") return { status: 200, json: calls.filter((c) => c.p === "/api/v2/pins/777").length > 1 ? { authToken: "one-time-token" } : {} };
      if (p === "/api/v2/user") return { status: 200, json: { id: 1002, username: "bobp", email: "bob@example.test" } };
      return { status: 404, json: null };
    },
  });
  const st = await PM.linkStart(me);
  assert.equal(st.pin, "777");
  assert.match(st.url, /^https:\/\/app\.plex\.tv\/auth#\?/);
  assert.equal((await PM.linkCheck(me, "777")).done, false);
  const other = await mkUser();
  await assert.rejects(PM.linkCheck(other, "777"), (e) => e.status === 404, "someone else's PIN");
  const done = await PM.linkCheck(me, "777");
  assert.equal(done.done, true);
  const r = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '1002'"))[0];
  assert.equal(r.user_id, me.userId);
  assert.equal(r.link_source, "self");
  assert.ok(!JSON.stringify(await getQuery("SELECT * FROM plex_members")).includes("one-time-token"));
  assert.ok(!JSON.stringify(await getQuery("SELECT * FROM plex_member_log")).includes("one-time-token"));
  assert.ok(await PM.memberFor(me.userId), "bob's share was on the server: a member now");
  await PM.unlinkSelf(me, "1002");
  assert.equal(await PM.memberFor(me.userId), null);
});

test("the subscriptions page renders in other languages (and in English without the middleware)", async () => {
  const ejs = require("ejs");
  const i18n = require(path.join(repo, "i18n"));
  const s = await mkUser({ bal: 6000000 });
  await SUB.start(s, MONTH, 5000000);
  const data = await SUB.pageData(s);
  const plex = await PM.mine(s.userId);
  const locals = { user: s.username, title: "Subscriptions", data, plex, invites: [{ prize_id: MONTH, title: "Plex Invite 1 Month Access", price: 5000000, days: 30, sub: true }],
                   selflink: true, balance: 1000000, pin: null, libraryOpen: true, price: 50000 };
  const en = await ejs.renderFile(path.join(repo, "views", "subscriptions.ejs"), locals);
  assert.match(en, /Your subscriptions/);
  assert.match(en, /Renews on/);
  for (const c of ["de", "ar", "ja"]) {
    const t = i18n.tFor(c);
    const html = await ejs.renderFile(path.join(repo, "views", "subscriptions.ejs"), { ...locals, i18nT: t, t, i18nClient: (p) => i18n.clientJson(c, p) });
    assert.ok(html.includes(t("subs.h1")));
    assert.doesNotMatch(html, /(?<![.\w])subs\.[a-z_]+\b/, "no raw keys (the js.subs.* strings in PATV_I18N are fine)");
  }
});
