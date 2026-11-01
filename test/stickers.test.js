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

test("catalog: eight packs of eight (1.99lf added three, 1.99qp two perk packs - Spooky Season in October), every sticker has its SVG art and English i18n keys; price from the setting (250k)", () => {
  const c = STK.catalog();
  assert.deepEqual(c.map((p) => p.id), ["pixelpepe", "kawaiipond", "patvreacts", "miclife", "highroller", "movienight", "spooky", "primeplus"]);
  const EN = require("../locales/en.json");
  for (const p of c) {
    assert.ok(EN["stk.pack." + p.id + ".name"] && EN["stk.pack." + p.id + ".desc"], "en.json names " + p.id);
    for (const s of p.stickers) assert.ok(EN["stk.s." + p.id + "." + s.id], "en.json names " + p.id + "/" + s.id);
  }
  for (const p of c) {
    assert.equal(p.stickers.length, 8);
    assert.equal(p.price, p.perk ? null : 250000, "perk packs are never sold");
    for (const s of p.stickers) {
      const svg = fs.readFileSync(path.join(repo, s.url.replace(/^\//, "")), "utf8");
      assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ 24" shape-rendering="crispEdges">/);
      assert.doesNotMatch(svg, /<script|on\w+=/i);
      assert.equal(s.token, `[sticker:${p.id}/${s.id}]`);
    }
  }
});

test("🍂 Fireside Season (November): a Season Pass perk pack listed Nov 1 - Dec 1 (UTC) every year, never sold or comped; art + English keys", async () => {
  const pk = STK.CAT.byId.fireside;
  assert.ok(pk, "in the catalog (a bad id or missing art drops a pack quietly)");
  assert.ok(pk.season, "a parsed window - a typo would make the perk pack year-round");
  assert.deepEqual([pk.perk, pk.emoji, pk.season.from, pk.season.to, pk.season.label], ["season_pass", "🍂", "11-01", "12-02", "November"]);
  assert.deepEqual(pk.stickers.map((s) => s.id), ["fireworks", "toasty", "leafpile", "snug", "cocoa", "moustache", "drumstick", "pie"]);
  const listed = (when) => STK.catalog(when).some((p) => p.id === "fireside");
  assert.equal(listed(Date.UTC(2026, 9, 31, 23, 59)), false, "not on Oct 31");
  assert.equal(listed(Date.UTC(2026, 10, 1, 0, 0)), true, "from Nov 1");
  assert.equal(listed(Date.UTC(2026, 10, 26, 12)), true, "Thanksgiving");
  assert.equal(listed(Date.UTC(2026, 11, 1, 23, 59)), true, "through Dec 1 (a Thanksgiving weekend can end on it)");
  assert.equal(listed(Date.UTC(2026, 11, 2, 0, 0)), false, "gone on Dec 2");
  assert.equal(listed(Date.UTC(2027, 10, 15)), true, "every year");
  const nov3 = STK.catalog(Date.UTC(2026, 10, 3)).map((p) => p.id);
  assert.ok(nov3.includes("spooky") && nov3.includes("fireside"), "overlaps Spooky's last week");
  assert.ok(nov3.indexOf("fireside") === nov3.indexOf("spooky") + 1, "the seasonal packs sit together");
  const EN = require("../locales/en.json");
  assert.ok(EN["stk.pack.fireside.name"] && EN["stk.pack.fireside.desc"]);
  for (const s of STK.catalog(Date.UTC(2026, 10, 15)).find((p) => p.id === "fireside").stickers) {
    assert.ok(EN["stk.s.fireside." + s.id], "en.json names fireside/" + s.id);
    const svg = fs.readFileSync(path.join(repo, s.url.replace(/^\//, "")), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">\r?\n<title>[^<]+<\/title>\r?\n/);
    assert.doesNotMatch(svg, /<script|on\w+=|<text/i, "no script, no text in the art");
  }
  // art review fixes: the leaf pile is a closed mound with a margin (it bled off three edges), and the moustache has no red
  // mouth corners showing through its droops
  const px = (id) => {
    const g = new Map();
    const svg = fs.readFileSync(path.join(repo, "public", "stickers", "fireside", id + ".svg"), "utf8");
    for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g))
      for (let i = 0; i < +m[3]; i++) g.set(`${+m[1] + i},${m[2]}`, m[4]);
    return g;
  };
  const pile = px("leafpile");
  for (let y = 9; y < 24; y++) for (const x of [0, 23]) assert.ok(!pile.has(`${x},${y}`), `leafpile: nothing on the edge at ${x},${y}`);
  for (let x = 0; x < 24; x++) assert.ok(!pile.has(`${x},23`), `leafpile: nothing on the bottom edge at ${x},23`);
  const mo = px("moustache");
  for (let y = 11; y <= 14; y++) for (let x = 0; x < 24; x++) assert.notEqual(mo.get(`${x},${y}`), "#e5383b", `moustache: red at ${x},${y}`);
  // every pack in stickers.json (in season or not) has its English keys
  for (const p of STK.CAT.packs) {
    assert.ok(EN["stk.pack." + p.id + ".name"] && EN["stk.pack." + p.id + ".desc"], "en.json names " + p.id);
    for (const s of p.stickers) assert.ok(EN["stk.s." + p.id + "." + s.id], "en.json names " + p.id + "/" + s.id);
    // the '{label} only' tag's label is a key too, so the sync translates the month ('November' is not a proper noun everywhere)
    if (p.season) assert.equal(EN["stk.season." + p.id], p.season.label, "en.json stk.season." + p.id);
  }
  await assert.rejects(STK.buy(U.ann, { pack: "fireside", ref: ref() }), /Fireside Season comes with a 🎟️ Season Pass \(November only\)/);
  await assert.rejects(STK.grantComp(U.ann.userId, "fireside", "test"), /Comp the tier instead/);
  // Pepe: house art in season, the readable stand-in out of it
  assert.equal(STK.forPepe("[sticker:fireside/pie]", Date.UTC(2026, 10, 15)), "[sticker:fireside/pie]");
  assert.equal(STK.forPepe("[sticker:fireside/pie]", Date.UTC(2026, 11, 15)), "[sticker: Room for pie]");
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
  assert.deepEqual(d.packs.filter((p) => p.owned).map((p) => p.id).sort(), ["patvreacts", "pixelpepe", "spooky"], "1.99qp: a Season Pass in October has Spooky Season");
  assert.equal(d.allowance.per, 1);
  const anon = await STK.pageData(null);
  assert.equal(anon.signed, false);
  assert.ok(anon.packs.every((p) => !p.owned));
});
