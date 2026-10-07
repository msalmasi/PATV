// Offline tests for 1.99ek's boost visibility: the shared 🚀 badge (boostmark.js), no "Boost a pad" buttons
// outside a pad page (/p and the homepage), the homepage's Top Pads (home.topPads + rooms.rankLive: top 5,
// live only, the front pick's order incl. boost) and the badge only on boosted pads.
//   node --test test/boost-vis.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boostvis-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const BM = require(path.join(repo, "boostmark"));
const B = require(path.join(repo, "boosts"));
const rooms = require(path.join(repo, "rooms"));
const home = require(path.join(repo, "home"));

const MIN = 60 * 1000;
let T = Date.UTC(2026, 9, 7, 18, 0, 0);
rooms._setClock(() => T); B._setClock(() => T);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await rooms.init();
  await B.init();
});

// ── the shared badge ──
test("formatter: 950, 12.4k, 1.2M (one decimal under 100 of a unit, no trailing .0, rolls over to the next unit)", () => {
  const cases = [[0, "0"], [0.4, "0"], [950, "950"], [999, "999"], [999.6, "1k"], [1000, "1k"], [1049, "1k"], [1050, "1.1k"], [12400, "12.4k"],
                 [99949, "99.9k"], [99950, "100k"], [124000, "124k"], [999960, "1M"], [1234567, "1.2M"], [12e6, "12M"], [3.4e9, "3.4B"]];
  for (const [n, s] of cases) assert.equal(BM.fmtPat(n), s, `fmtPat(${n})`);
});

test("tooltip: the full active PAT with separators and how boosts fade", () => {
  assert.equal(BM.boostTip(12400), "Boosted: 12,400 PAT still active · boosts fade by half every hour");
  assert.equal(BM.boostTip(1234567.4), "Boosted: 1,234,567 PAT still active · boosts fade by half every hour");
});

test("badge: nothing for a pad that isn't boosted; else the short number with the tooltip, classes escaped", () => {
  for (const n of [0, -5, 0.4, null, undefined, "x", NaN]) assert.equal(BM.boostMark(n, "pill ch-mark"), "", `no badge for ${n}`);
  const h = BM.boostMark(12400, "pill ch-mark");
  assert.equal(h, '<span class="pill ch-mark boost-mark" title="Boosted: 12,400 PAT still active · boosts fade by half every hour" '
                + 'aria-label="Boosted: 12,400 PAT still active · boosts fade by half every hour">🚀 12.4k</span>');
  assert.match(BM.boostMark(5, '"><b>'), /class="&quot;&gt;&lt;b&gt; boost-mark"/);
});

// ── Top Pads ──
const sum = (id, count, mic = 0, live = true) => ({ id, slug: id.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: id, count, micCount: mic, live });

test("topPads: live pads only, at most 5, in the ranking's order (unranked live pads last by headcount)", () => {
  const rows = [sum("A", 30), sum("B", 2), sum("C", 9), sum("D", 4), sum("E", 7), sum("F", 5), sum("G", 6), sum("Off", 99, 3, false)];
  const ranked = ["E", "B", "A", "C", "F", "D"].map((id) => ({ id }));
  const boosts = new Map([["B", 12400.4], ["Off", 50000]]);
  const t = home.topPads(rows, ranked, boosts);
  assert.equal(t.length, 5, "the top 5");
  assert.deepEqual(t.map((r) => r.id), ["E", "B", "A", "C", "F"], "ranking order, not headcount");
  assert.ok(!t.some((r) => r.id === "Off"), "an offline pad never shows");
  assert.deepEqual(t[1], { id: "B", slug: "b", name: "B", count: 2, micCount: 0, boost: 12400 });
  assert.equal(t[0].boost, 0);
  assert.deepEqual(home.topPads([sum("X", 1), sum("Y", 8)], [], new Map()).map((r) => r.id), ["Y", "X"], "unranked: by headcount");
  assert.deepEqual(home.topPads([sum("Off", 9, 0, false)], [], new Map()), [], "nothing live -> empty (the card hides)");
});

test("rankLive: the front pick's score - activity plus boost points - orders the live pads", async () => {
  B.clearCache();
  const act = (chatters, lines, people) => ({ chatters, lines, micMin: 0, people, lastAt: T - MIN });
  const rows = [
    { ...sum("Busy.Room", 21), act: act(8, 80, 20) },
    { ...sum("Close.Room", 19), act: act(7, 70, 18) },
    { ...sum("Dark.Room", 50, 0, false), act: act(20, 200, 49) },
  ];
  let r = await rooms.rankLive(rows, { now: T });
  assert.deepEqual(r.ranked.map((x) => x.id), ["Busy.Room", "Close.Room"], "live only, activity first");
  // a 40k-PAT boost (+20 points) tips the close race
  await runQuery(`INSERT INTO room_flow_ledger (ref, kind, room_id, payer_id, amount, fortknox, room_vault, created) VALUES ('t1', 'boost', 'Close.Room', 'u', 40000, 20000, 20000, ?)`, [T - 1000]);
  B.clearCache();
  r = await rooms.rankLive(rows, { now: T });
  assert.deepEqual(r.ranked.map((x) => x.id), ["Close.Room", "Busy.Room"]);
  assert.ok(Math.abs(r.boosts.get("Close.Room") - 40000) < 20, "active PAT per pad for the badges");
  assert.deepEqual(home.topPads(rows, r.ranked, r.boosts).map((x) => [x.id, x.boost > 39000]), [["Close.Room", true], ["Busy.Room", false]]);
});

// ── pages ──
const UL = (n) => String(n == null ? "" : n);
async function renderPads(rows) {
  return ejs.renderFile(path.join(repo, "views", "rooms.ejs"), {
    user: null, signedIn: false, staff: false, owned: [], pepe: { active: false }, boostMark: BM.boostMark, ul: UL, rows });
}
const pad = (id, extra = {}) => ({ id, slug: id.toLowerCase(), title: id, live: true, bridged: true, count: 5, micCount: 1, slot_count: 1, now: [], next: [], ...extra });

test("/p: no 'Boost a pad' button (boosting happens on the pad page); the copy still says fans can boost", async () => {
  const html = await renderPads([pad("Alpha", { trend: { rank: 1, front: true, score: 50, boost: 0 } })]);
  assert.doesNotMatch(html, /Boost a pad/i);
  assert.doesNotMatch(html, /href="#trending"/);
  assert.match(html, /href="\/stage">🎥 Go live</);
  assert.match(html, /Fans can <b>🚀 boost<\/b> a pad/);
});

test("/p: the 🚀 badge only on boosted pads - card header slot and Trending strip", async () => {
  const html = await renderPads([
    pad("Alpha", { boost_pat: 12400, trend: { rank: 1, front: true, score: 50, boost: 11.1 } }),
    pad("Beta", { boost_pat: 0, trend: { rank: 2, front: false, score: 30, boost: 0 } }),
    pad("Gamma", { live: false }),
  ]);
  assert.equal((html.match(/class="pill ch-mark boost-mark"/g) || []).length, 1, "one card badge");
  assert.equal((html.match(/class="tg boost boost-mark"/g) || []).length, 1, "one Trending badge");
  assert.equal((html.match(/🚀 12\.4k/g) || []).length, 2);
  assert.match(html, /title="Boosted: 12,400 PAT still active · boosts fade by half every hour"/);
  assert.doesNotMatch(html, /🚀 \+/, "no boost-points tag any more");
  const cards = html.split('<a class="ch');
  const beta = cards.slice(1).find((c) => c.includes('href="/p/beta"'));
  assert.ok(beta && !beta.includes("boost-mark"), "an unboosted pad shows nothing");
});

test("/p schedule: the time column sizes to its content and never wraps; phones stack it", () => {
  const src = fs.readFileSync(path.join(repo, "views", "rooms.ejs"), "utf8");
  assert.match(src, /\.cg \.sched li \{ display: grid; grid-template-columns: max-content minmax\(0, 1fr\);/);
  assert.match(src, /\.cg \.sched time \{[^}]*white-space: nowrap;/);
  assert.match(src, /@media \(max-width: 640px\) \{[\s\S]*?\.cg \.sched li \{ grid-template-columns: minmax\(0, 1fr\);/);
});

async function renderHome(locals = {}) {
  return ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: false, stageAdmin: null,
    frontInfo: { id: "Alpha", slug: "alpha", title: "Alpha", pinned: false, owner: null, boost: 0 }, pepeHere: true, featuredPrice: 0,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: UL,
  }, locals));
}

test("home: no 'Boost a pad' button; Go live and Pads stay; the copy links fans to /p", async () => {
  const html = await renderHome();
  assert.doesNotMatch(html, /Boost a pad/i);
  assert.doesNotMatch(html, /#trending/);
  assert.match(html, /class="golive-btn" href="\/stage\?room=alpha">🎥 Go live</);
  assert.match(html, /<a class="btn" href="\/p">Pads<\/a>/);
  assert.match(html, /<b>🚀 boost<\/b> a pad from <a href="\/p">its page<\/a>/);
});

test("home: Top Pads lists the given (top 5, live) pads with 👥 / 🎙 and a 🚀 badge only when boosted; hidden when none live", async () => {
  const tops = [{ id: "B", slug: "b", name: "Bee", count: 12, micCount: 2, boost: 1234567 }, { id: "A", slug: "a", name: "Ay", count: 30, micCount: 0, boost: 0 }];
  let html = await renderHome({ tops, frontInfo: { id: "B", slug: "b", title: "Bee", pinned: false, owner: null, boost: 1234567 } });
  assert.match(html, /<h2 id="tpH"><span>Top Pads<\/span>/);
  assert.doesNotMatch(html, /On now/);
  const box = html.slice(html.indexOf('id="tpH"'), html.indexOf("</ol>", html.indexOf('id="tpH"')));
  assert.deepEqual([...box.matchAll(/href="\/p\/([^"]+)"/g)].map((m) => m[1]), ["b", "a"], "in the given order");
  assert.match(box, /👥 12<\/span><span[^>]*>🎙 2<\/span><span class="bm boost-mark"[^>]*>🚀 1\.2M<\/span>/);
  assert.equal((box.match(/boost-mark/g) || []).length, 1, "the unboosted pad has no badge");
  const bar = html.slice(html.indexOf('id="stTtl"'), html.indexOf('id="stSub"'));
  assert.match(bar, /<span class="bm boost-mark" title="Boosted: 1,234,567 PAT still active[^"]*"[^>]*>🚀 1\.2M<\/span>/, "front stage header badge");
  html = await renderHome({ tops: [] });
  assert.doesNotMatch(html, /id="tpH"/, "no live pad -> no Top Pads card");
  const bar0 = html.slice(html.indexOf('id="stTtl"'), html.indexOf('id="stSub"'));
  assert.doesNotMatch(bar0, /boost-mark/, "the featured pad isn't boosted -> no badge");
});
