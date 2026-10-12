// Offline tests for 1.99qy: 💎 Prime Time Plus decides Camfrog rooms (the user's model).
//   - the cap: at most ptplus_max_rooms Plus pads at once (comps count); buying / gifting / chipping in / comping NEW Plus is
//     refused when full ("sold out", nothing charged), renewing or extending a Plus pad always works; race-safe (two buyers,
//     one spot -> one wins); the waitlist is told when a spot frees; the owner hears 3 days before Pepe leaves
//   - connect: with the gate on, a Camfrog connect needs Plus; Pepe joins on his own (no opt-in / admin approval); the
//     Plus moves with the pad when it's re-keyed (connect + disconnect); Pepe's list (plusRoomsForPepe / the owner sync)
//   - gate off: the old flow (connect free, opt-in + admin approval)
//   node --test test/ptplus-rooms.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptplus-rooms-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const PCR = require(path.join(repo, "padcreate"));
const CN = require(path.join(repo, "padconnect"));
const F = require(path.join(repo, "funding"));
require(path.join(repo, "terms"))._setRequired(false);

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 12, 12);
let t = T0;
PR._setClock(() => t);
CN._setClock(() => t);
const U = {};
async function mk(name, { cls = "pleb", bal = 500000000, camfrog = null } = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, 5, '2026-01-01 00:00:00')`, ["u-" + name, name, name, cls, bal, camfrog]);
  U[name] = { userId: "u-" + name, username: name, class: cls };
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const inbox = async (u, like) => (await getQuery("SELECT title FROM inbox WHERE user_id = ? AND title LIKE ?", [u.userId, like])).length;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT, twitchLogin TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  for (const n of ["ann", "bob", "cat", "dan", "eve"]) await mk(n, { camfrog: n + "cf" });
  await mk("boss", { cls: "Admin" });
  await rooms.init();
  await require(path.join(repo, "padcfg")).set({ create_max_per_user: 10 }, "test");
  for (const [id, who] of [["Ann.Room", "ann"], ["Bob.Room", "bob"], ["Cat.Room", "cat"], ["Dan.Room", "dan"]]) {
    await rooms.addRoom(id, id.split(".")[0], "test"); await rooms.setOwner(id, who, "test");
  }
  await PR.init();
  await PR.setConfig({ comp_admins: false, ptplus_max_rooms: 3 }, "test");
  await CN.init();
});
test.after(() => F.sync({}));

test("the cap: 3 spots (a comp counts); a 4th pad is sold out - buy, gift, chip-in and comp refused before any PAT moves", async () => {
  await PR.setComp("prime_plus", "Ann.Room", true, "test", "house-like comp");            // 1 (no end date)
  await PR.buy(U.bob, { tier: "prime_plus", pad: "Bob.Room", months: 1, ref: ref() });      // 2
  await PR.buy(U.eve, { tier: "prime_plus", pad: "Cat.Room", months: 1, ref: ref() });      // 3 (a gift)
  assert.deepEqual(PR.plusSpots(), { used: 3, held: 0, max: 3, left: 0, soldOut: true });
  const b0 = await bal(U.dan);
  for (const opts of [{ months: 1 }, { amount: 5000000 }]) {
    await assert.rejects(PR.buy(U.dan, { tier: "prime_plus", pad: "Dan.Room", ref: ref(), ...opts }), (e) => e.soldOut && /sold out/.test(e.message));
  }
  await assert.rejects(PR.buy(U.eve, { tier: "prime_plus", pad: "Dan.Room", months: 1, ref: ref(), anon: true }), /sold out/);
  await assert.rejects(PR.setComp("prime_plus", "Dan.Room", true, "test", "x", { until: t + 10 * DAY }), /sold out/);
  assert.equal(await bal(U.dan), b0, "nothing charged");
  assert.equal(PR.isPrimePlus("Dan.Room"), false);
  assert.equal(PR.errBody(Object.assign(new PR.Refuse(409, "x"), { soldOut: true })).body.sold_out, true);
  // renewing / extending a Plus pad never needs a spot
  const r = await PR.buy(U.ann, { tier: "prime_plus", pad: "Bob.Room", months: 1, ref: ref() });
  assert.equal(r.paid_through, T0 + 60 * DAY);
  const ch = await PR.buy(U.dan, { tier: "prime_plus", pad: "Cat.Room", amount: 5000000, ref: ref() });
  assert.equal(ch.kind, "contribute");
  // the page says so
  const st = await PR.state(U.dan, "Dan.Room");
  assert.deepEqual([st.plus_spots.used, st.plus_spots.max, st.plus_spots.soldOut], [3, 3, true]);
});

test("race: two buyers, one spot -> exactly one gets it (the count runs inside BEGIN IMMEDIATE)", async () => {
  await PR.setConfig({ ptplus_max_rooms: 4 }, "test");
  await rooms.addRoom("Race1.Room", "Race1", "test"); await rooms.addRoom("Race2.Room", "Race2", "test");
  const res = await Promise.allSettled([
    PR.buy(U.ann, { tier: "prime_plus", pad: "Race1.Room", months: 1, ref: ref() }),
    PR.buy(U.bob, { tier: "prime_plus", pad: "Race2.Room", months: 1, ref: ref() }),
  ]);
  assert.deepEqual(res.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.match(res.find((x) => x.status === "rejected").reason.message, /sold out/);
  assert.equal(PR.plusSpots().used, 4);
  // undo the race winner for the rest of the file
  const won = PR.isPrimePlus("Race1.Room") ? "Race1.Room" : "Race2.Room";
  await runQuery("DELETE FROM premium_subs WHERE tier = 'prime_plus' AND target = ?", [won]);
  await PR.loadCache();
  await PR.setConfig({ ptplus_max_rooms: 3 }, "test");
});

test("waitlist: sold out -> join; when a spot frees, everyone on it is told once; the owner hears 3 days before Pepe leaves", async () => {
  await PR.plusWaitlist(U.dan, true);
  assert.equal(await PR.plusWaitlistNotify(t), 0, "still full: nobody told");
  // Cat.Room's Plus (bought at T0 for 30 days + a 3-day chip-in, no renewer) ends at T0 + 33 d
  t = T0 + 31 * DAY;
  assert.equal(await PR.plusLeaveNotices(t), 1, "Cat.Room's owner is told");
  assert.equal(await inbox(U.cat, "%Prime Time Plus ends soon%"), 1);
  assert.equal(await PR.plusLeaveNotices(t), 0, "once per end date");
  t = T0 + 34 * DAY;
  await PR.loadCache();
  assert.equal(PR.isPrimePlus("Cat.Room"), false);
  assert.equal(await PR.plusWaitlistNotify(t), 1);
  assert.equal(await inbox(U.dan, "%Plus spot is free%"), 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM premium_plus_waitlist"))[0].n, 0);
});

test("connect (gate on): a Camfrog connect needs Plus; Pepe joins on his own; the Plus moves with the pad (connect + disconnect); Pepe's list", async () => {
  await PR.setConfig({ plus_bridge_gate: true }, "test");
  PCR._resetRecent();
  const P = await PCR.create(U.eve, { title: "Eve Lounge" });
  await assert.rejects(CN.requestCamfrog(U.eve, P, { room: "Eve Room" }), /comes with 💎 Prime Time Plus \(\d of 3 spots left\)/);
  await PR.buy(U.eve, { tier: "prime_plus", pad: P.id, months: 1, ref: ref() });
  const c = await CN.requestCamfrog(U.eve, P, { room: "Eve Room" });
  assert.equal(c.join_opt_in, true, "Pepe is in by default");
  let L = await CN.plusRoomsForPepe();
  assert.equal(L.enforced, true);
  assert.equal(L.max, 3);
  assert.deepEqual(L.pending.map((x) => x.name), ["Eve Room"], "Pepe goes in to see the code");
  assert.ok(!L.rooms.some((r) => r.id === P.id), "a site pad isn't a Camfrog room yet");
  await assert.rejects(CN.setJoin(U.eve, P, true), /nothing to ask for|isn't connected/);
  const r = await CN.verifyFromPepe({ via: "topic", room: "Eve.Room", room_name: "Eve Room", code: c.code, topic: "hi " + c.code });
  assert.equal(r.ok, true, r.message);
  assert.equal(PR.isPrimePlus("Eve.Room"), true, "the Plus moved to the room id");
  assert.equal(PR.isPrimePlus(P.id), false);
  const conn = await CN.current("Eve.Room", "camfrog");
  assert.equal(conn.join_status, "approved", "no admin approval needed");
  L = await CN.plusRoomsForPepe();
  assert.deepEqual(L.rooms.filter((x) => x.id === "Eve.Room").map((x) => x.name), ["Eve Room"]);
  assert.ok(L.rooms.some((x) => x.id === "Ann.Room") && L.rooms.some((x) => x.id === "Bob.Room"));
  const o = await rooms.ownersForPepe();
  assert.equal(o.find((x) => x.id === "Eve.Room").prime_plus, true);
  // disconnect: the pad goes back to a site pad WITH its Plus; the room drops off Pepe's list (he leaves)
  await CN.disconnect(U.eve, await rooms.get("Eve.Room"), "camfrog");
  assert.equal(PR.isPrimePlus("Eve.Room"), false);
  assert.equal(PR.isPrimePlus(P.id), true);
  assert.ok(!(await CN.plusRoomsForPepe()).rooms.some((x) => x.id === "Eve.Room"));
});

test("connect: the Plus runs out while the code is pending -> the connect is cancelled; gate off -> the old flow", async () => {
  PCR._resetRecent();
  const P = await PCR.create(U.eve, { title: "Eve Two" });
  await assert.rejects(CN.requestCamfrog(U.eve, P, { room: "Eve Two Room" }), /sold out|Prime Time Plus/);
  await PR.setConfig({ plus_bridge_gate: false }, "test");
  const c = await CN.requestCamfrog(U.eve, P, { room: "Eve Two Room" });
  assert.equal(c.join_opt_in, false, "gate off: Pepe only on request");
  await PR.setConfig({ plus_bridge_gate: true }, "test");
  const r = await CN.verifyFromPepe({ via: "topic", room: "EveTwo.Room", room_name: "Eve Two Room", code: c.code, topic: c.code });
  assert.equal(r.ok, false);
  assert.match(r.message || r.error || "", /Prime Time Plus/);
  assert.equal((await getQuery("SELECT status FROM pad_connections WHERE code = ?", [c.code]))[0].status, "cancelled");
  await PR.setConfig({ plus_bridge_gate: false }, "test");
});

test("the views: the pad page card and the connect panel name the spots; /premium shows N of 5 + sold out + the waitlist", () => {
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /t\('pad\.plusroom\.h', \{ left: sp_\.left, max: sp_\.max \}\)/);
  const conn = fs.readFileSync(path.join(repo, "views", "partials", "pad-connect.ejs"), "utf8");
  assert.match(conn, /PX_\.enforced && !PX_\.has/);
  const prem = fs.readFileSync(path.join(repo, "views", "premium.ejs"), "utf8");
  assert.match(prem, /t\('premium\.pp\.spots', \{ used: SPOTS\.used, max: SPOTS\.max \}\)/);
  assert.match(prem, /data-plus-wait=/);
  const EN = require(path.join(repo, "locales", "en.json"));
  assert.equal(EN["pad.plusroom.h"], "Connect your Camfrog room with Prime Time Plus ({left} of {max} spots left)");
  for (const k of ["premium.pp.spots", "premium.pp.sold_out", "premium.pp.waitlist_on", "premium.pp.notice.leave_body", "pad.conn.plus_in", "pad.conn.plus_out"]) assert.ok(EN[k], k);
});

test("1.99rd ownership vs connections: the owner is the registry's (creator / admin), never the connection; per-platform Plus gate", async () => {
  // the per-platform list is config: default camfrog only; junk dropped
  assert.deepEqual(PR.config().plus_gate_platforms, ["camfrog"]);
  assert.deepEqual(PR.cleanConfig({ plus_gate_platforms: ["twitch", "nope", "twitch", "irc"] }).plus_gate_platforms, ["twitch", "irc"]);
  await PR.setConfig({ plus_bridge_gate: true }, "test");
  assert.equal(CN.needsPlus("camfrog"), true);
  assert.equal(CN.needsPlus("twitch"), false, "Twitch isn't gated by default");
  await PR.setConfig({ plus_gate_platforms: ["camfrog", "twitch"] }, "test");
  assert.equal(CN.needsPlus("twitch"), true);
  await runQuery("UPDATE users SET twitchId = 'tw-eve', twitchLogin = 'evelive' WHERE userId = ?", [U.eve.userId]);
  PCR._resetRecent();
  const T = await PCR.create(U.eve, { title: "Eve Twitch" });
  await assert.rejects(CN.connectTwitch(U.eve, T), /Connecting Twitch comes with 💎 Prime Time Plus/);
  await PR.setConfig({ plus_gate_platforms: ["camfrog"], plus_bridge_gate: false }, "test");
  assert.equal(CN.needsPlus("camfrog"), false, "gate off: nothing needs Plus");
  // the Eve Lounge pad (connected + disconnected above): its owner never changed
  const P = await rooms.bySlug("eve-lounge");
  assert.equal(P.owner.userId, U.eve.userId, "still eve's pad after connect + disconnect");
  // an admin's assignment is ownership too, with no connection at all
  await rooms.setOwner("Dan.Room", "eve", "admin test");
  assert.equal((await rooms.get("Dan.Room")).owner.userId, U.eve.userId);
  assert.equal(await rooms.canManage(U.eve, "Dan.Room"), true);
  assert.equal((await CN.current("Dan.Room", "camfrog")), null, "no connection involved");
  const doc = fs.readFileSync(path.join(repo, "docs", "pads-ownership-connections.md"), "utf8");
  assert.match(doc, /A connection never makes anyone an owner/);
});

test("1.99rl the vault belongs to the pad: connect -> disconnect -> reconnect to ANOTHER room; rate, royalties and escrow follow the pad, Pepe is told to move the PAT", async () => {
  await PR.setConfig({ plus_bridge_gate: false }, "test");
  const RK = require(path.join(repo, "padrekey"));
  await require(path.join(repo, "roomvaults")).init();
  await require(path.join(repo, "royalties")).init();
  PCR._resetRecent();
  const P = await PCR.create(U.cat, { title: "Cat Vault" });
  const site0 = P.id;
  const connect = async (roomId, name) => {
    const c = await CN.requestCamfrog(U.cat, await rooms.get(P.id) || await rooms.bySlug("cat-vault"), { room: name });
    const r = await CN.verifyFromPepe({ via: "topic", room: roomId, room_name: name, code: c.code, topic: c.code });
    assert.equal(r.ok, true, r.message);
  };
  await connect("VaultA.Room", "Vault A");
  // things the pad earned while it was VaultA.Room's pad
  await runQuery("INSERT INTO room_vault_settings (room_id, rate, changed_at, changed_by) VALUES ('VaultA.Room', 12, 1, 'u-cat')");
  await runQuery(`INSERT INTO royalty_ledger (room_id, owner_user_id, kind, source, amount, period, ref, created)
                  VALUES ('VaultA.Room', 'u-cat', 'accrue', 'spend', 4321, 1, 'roy-test-1', 1)`);
  const R = await rooms.get("VaultA.Room");
  await CN.disconnect(U.cat, R, "camfrog");
  const back = await rooms.bySlug("cat-vault");
  assert.equal(back.id, site0);
  assert.equal((await getQuery("SELECT rate FROM room_vault_settings WHERE room_id = ?", [site0]))[0].rate, 12, "the owner's payout rate follows the pad");
  assert.equal((await getQuery("SELECT SUM(amount) AS a FROM royalty_ledger WHERE room_id = ?", [site0]))[0].a, 4321, "unpaid royalties follow the pad");
  await connect("VaultB.Room", "Vault B");                                                         // a DIFFERENT room
  assert.equal((await getQuery("SELECT rate FROM room_vault_settings WHERE room_id = 'VaultB.Room'"))[0].rate, 12);
  assert.equal((await getQuery("SELECT SUM(amount) AS a FROM royalty_ledger WHERE room_id = 'VaultB.Room'"))[0].a, 4321);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM royalty_ledger WHERE room_id = 'VaultA.Room'"))[0].n, 0, "nothing left behind in the old room");
  // Pepe's list: the three moves, in order (site -> A, A -> site, site -> B); the PAT moves on his side (vaultrekey_test.py)
  const open = (await RK.vaultRekeysForPepe()).filter((x) => [x.from, x.to].some((v) => [site0, "VaultA.Room", "VaultB.Room"].includes(v)));
  assert.deepEqual(open.map((x) => [x.from, x.to]), [[site0, "VaultA.Room"], ["VaultA.Room", site0], [site0, "VaultB.Room"]]);
  assert.equal(await RK.vaultRekeysDone(open.map((x) => ({ id: x.id, amount: 100 }))), 3);
  assert.equal(await RK.vaultRekeysDone(open.map((x) => ({ id: x.id, amount: 100 }))), 0, "idempotent");
  assert.ok(!(await RK.vaultRekeysForPepe()).some((x) => open.some((o) => o.id === x.id)), "done ones aren't sent again");
});

test("1.99rl Twitch: the ACCOUNT link (identity / SSO) never creates a pad connection; only a pad-level connect does", () => {
  for (const f of ["twitchlogin.js", "oauthlink.js", "userlinks.js", "ssolinks.js"]) {
    const p = path.join(repo, f);
    if (!fs.existsSync(p)) continue;
    assert.doesNotMatch(fs.readFileSync(p, "utf8"), /pad_connections|padconnect/, f + " must not touch pad connections");
  }
  const doc = fs.readFileSync(path.join(repo, "docs", "pads-ownership-connections.md"), "utf8");
  assert.match(doc, /account-level Twitch link/i);
  assert.match(doc, /pad bridges/i);
});
