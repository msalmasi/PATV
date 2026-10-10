// Offline tests for 1.99iw: chat sticker packs (stickers.js / stickers.json / public/stickers/*.svg) - ownership,
// PAT purchase + routing (premium.js "stickers" row), gifts, the Season Pass monthly allowance, validation (you can
// only send stickers you own - DMs, posts, comments) and rendering.
//   NODE_PATH=G:/PATV/node_modules node --test test/stickers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stickers-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const STK = require(path.join(repo, "stickers"));
const F = require(path.join(repo, "funding"));

let t = Date.UTC(2026, 9, 10, 12);
PR._setClock(() => t);
STK._setClock(() => t);
const U = {};
async function mk(name, bal = 5000000) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", ["u-" + name, name, name, bal]);
  U[name] = { userId: "u-" + name, username: name };
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await mk("ann"); await mk("bob"); await mk("cat", 10);
  await rooms.init();
  await STK.init();
});
test.after(() => F.sync({}));

test("catalog: three starter packs of eight, every sticker has its SVG art; price from the setting (250k)", () => {
  const c = STK.catalog();
  assert.deepEqual(c.map((p) => p.id), ["pixelpepe", "kawaiipond", "patvreacts"]);
  for (const p of c) {
    assert.equal(p.stickers.length, 8);
    assert.equal(p.price, 250000);
    for (const s of p.stickers) {
      const svg = fs.readFileSync(path.join(repo, s.url.replace(/^\//, "")), "utf8");
      assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ 24" shape-rendering="crispEdges">/);
      assert.doesNotMatch(svg, /<script|on\w+=/i);
      assert.equal(s.token, `[sticker:${p.id}/${s.id}]`);
    }
  }
});

test("buying: one debit, 100% Fort Knox, owned for good; a replayed ref charges once; can't buy twice; not enough PAT refused", async () => {
  F.sync({ fortknox: 1 });
  const b0 = await bal(U.ann);
  const r0 = ref();
  const r = await STK.buy(U.ann, { pack: "pixelpepe", ref: r0 });
  assert.deepEqual([r.dup, r.price, r.source], [false, 250000, "buy"]);
  assert.equal(await bal(U.ann), b0 - 250000);
  const c = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ?", [U.ann.userId]);
  assert.deepEqual(c.map((x) => [x.flow, x.amount]), [["fortknox:stickers", -250000]]);
  assert.equal((await STK.buy(U.ann, { pack: "pixelpepe", ref: r0 })).dup, true);
  assert.equal(await bal(U.ann), b0 - 250000);
  await assert.rejects(STK.buy(U.ann, { pack: "pixelpepe", ref: ref() }), /already have/);
  assert.equal(await STK.owns(U.ann.userId, "pixelpepe"), true);
  await assert.rejects(STK.buy(U.cat, { pack: "kawaiipond", ref: ref() }), (e) => e.status === 402);
  assert.equal(await bal(U.cat), 10);
  assert.equal(await STK.owns(U.cat.userId, "kawaiipond"), false);
  await assert.rejects(STK.buy(U.ann, { pack: "nope", ref: ref() }), /No such sticker pack/);
});

test("gifts: the giver pays, the receiver owns it and gets a notice", async () => {
  const b0 = await bal(U.ann);
  const r = await STK.buy(U.ann, { pack: "kawaiipond", ref: ref(), to: "cat" });
  assert.deepEqual([r.source, r.to], ["gift", "cat"]);
  assert.equal(await bal(U.ann), b0 - 250000);
  assert.equal(await STK.owns(U.cat.userId, "kawaiipond"), true);
  assert.equal(await STK.owns(U.ann.userId, "kawaiipond"), false);
  const n = await getQuery("SELECT title FROM inbox WHERE user_id = ?", [U.cat.userId]);
  assert.match(n[0].title, /ann gave you the Kawaii Pond sticker pack/);
});

test("Season Pass: one free pack a month (no PAT moves), none without a pass, not for gifts", async () => {
  await assert.rejects(STK.buy(U.bob, { pack: "patvreacts", ref: ref(), allowance: true }), /comes with a 🎟️ Season Pass/);
  await PR.buy(U.bob, { tier: "season_pass", months: 2, ref: ref() });
  const b0 = await bal(U.bob);
  assert.deepEqual(await STK.allowance(U.bob.userId), { per: 1, used: 0, left: 1, period: "2026-10" });
  const r = await STK.buy(U.bob, { pack: "patvreacts", ref: ref(), allowance: true });
  assert.deepEqual([r.price, r.source], [0, "season_pass"]);
  assert.equal(await bal(U.bob), b0);
  await assert.rejects(STK.buy(U.bob, { pack: "pixelpepe", ref: ref(), allowance: true }), /used this month's free pack/);
  await assert.rejects(STK.buy(U.bob, { pack: "pixelpepe", ref: ref(), allowance: true, to: "ann" }), /your own packs/);
  t = Date.UTC(2026, 10, 2);                                   // next month: a new one
  assert.equal((await STK.allowance(U.bob.userId)).left, 1);
  await STK.buy(U.bob, { pack: "pixelpepe", ref: ref(), allowance: true });
  assert.equal(await STK.owns(U.bob.userId, "pixelpepe"), true);
  t = Date.UTC(2026, 9, 10, 12);
});

test("using them: only packs you own (validate), at most 12; rendering turns known tokens in escaped HTML into pictures", async () => {
  await STK.validate(U.ann.userId, "hi [sticker:pixelpepe/happy] there");
  await STK.validate(U.ann.userId, "no stickers at all");
  await STK.validate(U.ann.userId, "[sticker:fake/thing] is just text");
  await assert.rejects(STK.validate(U.ann.userId, "[sticker:kawaiipond/blush]"), /don't have the Kawaii Pond sticker pack/);
  await assert.rejects(STK.validate(U.ann.userId, "[sticker:pixelpepe/happy]".repeat(13)), /At most 12/);
  const h = STK.inline("hi &lt;b&gt; [sticker:pixelpepe/happy] [sticker:pixelpepe/nope]");
  assert.match(h, /<img class="stk" src="\/public\/stickers\/pixelpepe\/happy.svg" alt="Happy Pepe"/);
  assert.match(h, /\[sticker:pixelpepe\/nope\]/, "an unknown sticker stays text");
  assert.match(h, /&lt;b&gt;/);
  assert.match(STK.inline("[sticker:pixelpepe/happy]"), /class="stk stk-l"[^>]*width="96"/, "a sticker on its own is big");
  assert.equal(STK.inline("plain"), "plain");
  // the hook for native PATV chat
  assert.equal(typeof STK.chat.validate, "function");
  assert.equal(typeof STK.chat.inline, "function");
});

test("pageData: packs with owned flags + the allowance", async () => {
  const d = await STK.pageData(U.bob);
  assert.equal(d.signed, true);
  assert.deepEqual(d.packs.filter((p) => p.owned).map((p) => p.id).sort(), ["patvreacts", "pixelpepe"]);
  assert.equal(d.allowance.per, 1);
  const anon = await STK.pageData(null);
  assert.equal(anon.signed, false);
  assert.ok(anon.packs.every((p) => !p.owned));
});
