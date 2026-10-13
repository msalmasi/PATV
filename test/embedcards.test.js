// Live feed cards (embedcards.js + public/js/embed-cards.js): GET /api/embeds shapes per kind (LMSR market prices, pool split
// + payout multiple, poll votes, bounty reward), statuses incl. closed-by-time / settled / void, the pad, the Approved-pad
// privacy rule (hidden = the same null as missing), the refs parser and cap, and the client's URL matching (own hosts and
// relative links only). Every time is relative to a fixed "now" passed in, so nothing depends on the clock.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embedcards-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
process.env.STAGING = "1";
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const padaccess = require(path.join(repo, "padaccess"));
const markets = require(path.join(repo, "markets"));
require(path.join(repo, "polls"));
require(path.join(repo, "bounties"));
const embeds = require(path.join(repo, "embedcards"));
const client = require(path.join(repo, "public", "js", "embed-cards.js"));

const NOW = 1_800_000_000_000;          // a fixed instant (ms); rows are placed around it
const S = NOW / 1000;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await rooms.init();
  await runQuery(`INSERT OR IGNORE INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated)
                  VALUES ('DRAMA_CENTRAL', 'drama-central', 'Drama Central', 'none', 'camfrog', ?, ?),
                         ('patv:vip', 'vip-lounge', 'VIP Lounge', 'none', 'site', ?, ?)`, [NOW, NOW, NOW, NOW]);
  await rooms.loadCache();
  await padaccess.init();
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level, updated, updated_by) VALUES ('patv:vip', 'approved', ?, 'test')", [NOW]);
  await runQuery("INSERT OR REPLACE INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES ('patv:vip', 'u-in', 'approved', ?, ?)", [NOW, NOW]);
  await padaccess.load();

  const lmsr = (id, extra) => markets.cleanMarket({ id, model: "lmsr", question: "Will it rain on " + id + "?", options: ["Yes", "No"], b: 1000,
    q: { Yes: 1000, No: 0 }, volume: 12345, status: "open", created: S - 3600, closes: S + 7200, room: "DRAMA_CENTRAL",
    positions: { ann: { nick: "Ann", shares: { Yes: 10, No: 0 }, cost: { Yes: 6, No: 0 } }, bob: { nick: "Bob", shares: { Yes: 0, No: 5 }, cost: { Yes: 0, No: 2 } } },
    trades: [], history: [], ...extra });
  await markets.storeRow(lmsr(1));
  await markets.storeRow(lmsr(2, { status: "settled", result: "Yes", paid_out: { at: S - 60, total: 10, result: "Yes" } }));
  await markets.storeRow(lmsr(3, { status: "void", void_reason: "ambiguous" }));
  await markets.storeRow(lmsr(4, { closes: S - 60 }));                      // still "open" in the row, but past its close
  await markets.storeRow(lmsr(5, { room: "", pad: "patv:vip" }));           // on an Approved pad
  await markets.storeRow(lmsr(6, { room: "" }));                            // site-wide
  const pool = (id, extra) => markets.cleanMarket({ id, model: "pool", question: "Who wins?", options: ["Red", "Blue"], status: "open",
    created: S - 3600, closes: S + 600, room: "DRAMA_CENTRAL",
    bets: [{ nick: "a", option: "Red", amount: 300, ts: S }, { nick: "b", option: "Blue", amount: 100, ts: S }], ...extra });
  await markets.storeRow(pool(10));
  await markets.storeRow(pool(11, { status: "void", result: "void" }));

  const poll = (id, status, pad) => runQuery("INSERT INTO polls (id, data, status, created, updated, pad) VALUES (?, ?, ?, ?, ?, ?)",
    [id, JSON.stringify({ id, question: "Best snack?", options: ["Chips", "Fruit", "Nuts"], votes: { 0: ["a", "b", "c"], 1: ["d"] }, creator: "x", status, created_at: "" }),
     status, "", NOW, pad]);
  await poll("poll_aa11", "active", "DRAMA_CENTRAL");
  await poll("poll_bb22", "ended", null);
  await poll("poll_vip", "active", "patv:vip");

  await runQuery("INSERT INTO bounties (id, data, status, deadline, updated) VALUES (?, ?, ?, ?, ?)",
    [7, JSON.stringify({ id: 7, creator: "x", task: "Sing on mic", room: "DRAMA_CENTRAL", status: "open", created: S - 60, deadline: S + 86400 + 3600,
                          pot: [{ nick: "a", amount: 500 }, { nick: "b", amount: 250 }], claims: [], hunters: [] }), "open", S + 90000, NOW]);
});

const get = async (q, viewer) => embeds.build(embeds.parseRefs(q), viewer || null, NOW);

test("LMSR market: prices per option, volume, traders, time left, pad", async () => {
  const { M1 } = await get("M1");
  assert.equal(M1.kind, "market");
  assert.equal(M1.url, "/markets/1");
  assert.equal(M1.title, "Will it rain on 1?");
  assert.equal(M1.status, "open");
  assert.equal(M1.closes, (S + 7200) * 1000, "closes in ms");
  assert.equal(M1.volume, 12345);
  assert.equal(M1.traders, 2);
  assert.equal(M1.options.length, 2);
  assert.ok(M1.options[0].price > 0.7 && M1.options[0].price < 0.75, "e^1/(e^1+1)");
  assert.ok(Math.abs(M1.options[0].price + M1.options[1].price - 1) < 1e-9);
  assert.deepEqual(M1.pad, { id: "DRAMA_CENTRAL", slug: "drama-central", title: "Drama Central", url: "/p/drama-central" });
});

test("statuses: settled (with result + winner), void, closed once past its close", async () => {
  const r = await get("M2,M3,M4");
  assert.equal(r.M2.status, "settled");
  assert.equal(r.M2.result, "Yes");
  assert.deepEqual(r.M2.options.map((o) => [o.name, o.price, o.won]), [["Yes", 1, true], ["No", 0, false]]);
  assert.equal(r.M3.status, "void");
  assert.equal(r.M3.result, null);
  assert.ok(r.M3.options.every((o) => !o.won));
  assert.equal(r.M4.status, "closed");
});

test("pool: % of the pot + payout multiple; a voided pool", async () => {
  const r = await get("m:10,M11");
  assert.equal(r.M10.kind, "pool");
  assert.equal(r.M10.pot, 400);
  assert.equal(r.M10.bettors, 2);
  assert.deepEqual(r.M10.options.map((o) => [o.name, o.pool, o.share]), [["Red", 300, 75], ["Blue", 100, 25]]);
  assert.equal(r.M10.options[1].mult, 3.85, "1 + (300 - 15 fee) / 100");
  assert.equal(r.M10.status, "open");
  assert.equal(r.M11.status, "void");
});

test("polls: vote split, status, permalink; bounties: reward + deadline", async () => {
  const r = await get("P:poll_aa11,P:poll_bb22,BT7");
  const p = r["P:poll_aa11"];
  assert.equal(p.kind, "poll");
  assert.equal(p.url, "/polls/poll_aa11");
  assert.equal(p.status, "open");
  assert.equal(p.votes, 4);
  assert.deepEqual(p.options.map((o) => [o.name, o.count, o.pct, o.lead]), [["Chips", 3, 75, true], ["Fruit", 1, 25, false], ["Nuts", 0, 0, false]]);
  assert.equal(p.pad.title, "Drama Central");
  assert.equal(r["P:poll_bb22"].status, "ended");
  assert.equal(r["P:poll_bb22"].pad, null, "site-wide");
  assert.equal(r.BT7.kind, "bounty");
  assert.equal(r.BT7.pot, 750);
  assert.equal(r.BT7.url, "/bounties/7");
  assert.equal(r.BT7.status, "open");
  assert.equal(r.BT7.pad.id, "DRAMA_CENTRAL", "the bounty's room is its pad");
});

test("privacy: Approved-pad items are null for outsiders (same as missing), shown to members and staff; site-wide = pad null", async () => {
  const out = await get("M5,P:poll_vip,M999,P:nope");
  assert.deepEqual(out, { M5: null, "P:poll_vip": null, M999: null, "P:nope": null });
  const outsider = await get("M5", { userId: "u-out", username: "out", class: "pleb" });
  assert.equal(outsider.M5, null);
  const member = await get("M5,P:poll_vip", { userId: "u-in", username: "in", class: "pleb" });
  assert.equal(member.M5.pad.id, "patv:vip");
  assert.equal(member["P:poll_vip"].status, "open");
  const staff = await get("M5", { userId: "u-staff", username: "st", class: "Admin" });
  assert.equal(staff.M5.status, "open");
  assert.equal((await get("M6")).M6.pad, null);
});

test("refs: parsed, de-duplicated, junk dropped, capped", () => {
  assert.deepEqual(embeds.parseRefs("M1, m1 ,m:1,BT3,bt:3,P:poll_x,P:bad/id,X9,,M"), [
    { kind: "m", id: 1, ref: "M1" }, { kind: "bt", id: 3, ref: "BT3" }, { kind: "p", id: "poll_x", ref: "P:poll_x" }]);
  const many = Array.from({ length: 50 }, (_, i) => "M" + (i + 1)).join(",");
  assert.equal(embeds.parseRefs(many).length, embeds.MAX_REFS);
  assert.deepEqual(embeds.parseRefs(undefined), []);
});

test("the HTTP endpoint: JSON shape, private short cache", async () => {
  let handler = null;
  embeds.register({ get: (p, _mw, h) => { if (p === "/api/embeds") handler = h; } }, { addUser: () => {} });
  assert.ok(handler);
  const headers = {};
  let body = null, code = 200;
  const res = { set: (k, v) => { headers[k] = v; }, json: (b) => { body = b; }, status: (c) => { code = c; return res; } };
  await handler({ query: { refs: "M1,M5,BT7" }, user: null }, res);
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.now, "number");
  assert.deepEqual(Object.keys(body.items).sort(), ["BT7", "M1", "M5"]);
  assert.equal(body.items.M5, null);
  assert.match(headers["Cache-Control"], /^private, max-age=\d+$/);
});

test("client: links on this site's own hosts (absolute or relative) match; other hosts don't", () => {
  const base = "https://staging.publicaccess.tv/feed";
  const f = (h, b) => client.refFromHref(h, b || base);
  assert.equal(f("https://publicaccess.tv/markets/123"), "M123");
  assert.equal(f("https://staging.publicaccess.tv/markets/M12?x=1#top"), "M12");
  assert.equal(f("https://www.publicaccess.tv/markets/7/"), "M7");
  assert.equal(f("/markets/45"), "M45");
  assert.equal(f("markets/45", "https://publicaccess.tv/"), "M45");
  assert.equal(f("/polls/poll_ab12"), "P:poll_ab12");
  assert.equal(f("/bounties/BT9"), "BT9");
  assert.equal(f("/bounties/9"), "BT9");
  assert.equal(f("http://localhost:3000/markets/5", "http://localhost:3000/feed"), "M5", "the page's own host (dev)");
  assert.equal(f("https://evil.example/markets/1"), null);
  assert.equal(f("https://publicaccess.tv.evil.example/markets/1"), null);
  assert.equal(f("https://user:pw@publicaccess.tv/markets/1"), null);
  assert.equal(f("https://publicaccess.tv:8443/markets/1"), null);
  assert.equal(f("javascript:alert(1)"), null);
  assert.equal(f("/markets"), null);
  assert.equal(f("/markets/12/trade"), null);
  assert.equal(f("/markets/abc"), null);
  assert.equal(f("/polls/bad%2Fid"), null);
  assert.equal(f(""), null);
  assert.equal(f(null), null);
});

test("client: countdown + price formatting", () => {
  assert.equal(client.fmtLeft(0), "");
  assert.equal(client.fmtLeft(-5000), "");
  assert.equal(client.fmtLeft(59 * 1000), "0m 59s");
  assert.equal(client.fmtLeft((2 * 3600 + 5 * 60) * 1000), "2h 5m");
  assert.equal(client.fmtLeft((3 * 86400 + 4 * 3600 + 59) * 1000), "3d 4h");
  assert.equal(client.pct(0.62), "62%");
  assert.equal(client.pct(0.004), "<1%");
  assert.equal(client.pct(0.996), ">99%");
  assert.equal(client.pct(1), "100%");
  assert.equal(client.pct(0), "0%");
});
