// S1 Q5a (1.99ads, ADR 0007 D13): the account cosmetics' ring, border and banner CSS is written from structured fields
// (cosmeticstyle.js), and every item still draws exactly what it drew from the hand-written CSS
// (test/fixtures/cosmetics-css-golden.json: render() at the last catalog with CSS strings, tools/gen-cosmetics-golden.js);
// each item's structured look (the chat hub's, Q5b) is pinned beside it and fits rt-schema's look.schema.json limits.
//   node --test test/cosmetics-structured.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "cosmetics-structured-test-")));
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cosmetics-css-golden.json"), "utf8"));
const CAT = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8"));
const CS = require(path.join(repo, "cosmeticstyle"));
const C = require(path.join(repo, "cosmetics"));
const byId = new Map(CAT.items.map((it) => [it.id, it]));
const HEX6 = /^#[0-9a-f]{6}$/;

test("every catalog item is in the golden, and every golden item still renders exactly as with the hand-written CSS", () => {
  assert.equal(G.items.length, CAT.items.length, "the golden covers the whole catalog");
  for (const g of G.items) {
    const it = byId.get(g.id);
    assert.ok(it, g.id);
    assert.deepEqual(JSON.parse(JSON.stringify(C.render(it))), g.render, g.id);
  }
});

test("the ring (19), border (21) and banner (18) items carry fields, never CSS strings", () => {
  const of = (k) => CAT.items.filter((it) => it.kind === k);
  // the plan's counts at Q5a (19 / 21 / 18); a later item joins as fields (staging's 🍏 Brushed Metal border made it 22)
  assert.ok(of("avatar_decoration").length >= 19);
  assert.ok(of("profile_border").length >= 21);
  assert.ok(of("profile_banner").length >= 18);
  for (const it of of("avatar_decoration")) {
    assert.ok((it.style.ring && typeof it.style.ring === "object") || Array.isArray(it.style.conic), it.id);
    assert.notEqual(typeof it.style.ring, "string", it.id);
  }
  for (const it of of("profile_border")) { assert.equal(it.style.css, undefined, it.id); assert.equal(typeof it.style.border, "object", it.id); }
  for (const it of of("profile_banner")) { assert.equal(it.style.background, undefined, it.id); assert.ok(Array.isArray(it.style.banner), it.id); }
  assert.equal(of("avatar_decoration").filter((it) => it.style.ring).length, 9, "nine hand-written rings became fields");
});

test("each item's structured look is pinned and fits look.schema.json (hex colours, list caps, w <= 8, the enums)", () => {
  for (const g of G.items) assert.deepEqual(CS.lookOf(byId.get(g.id)), g.look, g.id);
  const hexes = (list, max, id) => {
    assert.ok(Array.isArray(list) && list.length >= 1 && list.length <= max, id);
    for (const c of list) assert.match(c, HEX6, id);
  };
  for (const it of CAT.items) {
    const L = CS.lookOf(it);
    if (it.kind === "name_color") {
      assert.ok(L && L.name, it.id);
      assert.ok(["solid", "gradient"].includes(L.name.kind), it.id);
      hexes(L.name.colors, CS.MAX.name, it.id);
      if (L.name.kind === "gradient") assert.ok(["none", "shift"].includes(L.name.anim), it.id);
      assert.equal(L.name.solid, undefined, "solid is derived on the hub");
    } else if (it.kind === "avatar_decoration") {
      assert.equal(L.deco.item, it.id);
      hexes(L.deco.ring.colors, CS.MAX.ring, it.id);
      assert.ok(Number.isInteger(L.deco.ring.w) && L.deco.ring.w >= 0 && L.deco.ring.w <= 8, it.id);
      assert.ok(L.deco.ring.glow >= 0 && L.deco.ring.glow <= 1, it.id);
      assert.equal(typeof L.deco.ring.spin, "boolean", it.id);
    } else if (it.kind === "profile_border") {
      hexes(L.border.colors, CS.MAX.border, it.id);
      assert.ok(L.border.w >= 0 && L.border.w <= 8, it.id);
      assert.ok(["none", "pulse", "hue"].includes(L.border.anim), it.id);
    } else if (it.kind === "profile_banner") {
      hexes(L.banner.colors, CS.MAX.banner, it.id);
      assert.ok(Number.isInteger(L.banner.angle) && L.banner.angle >= 0 && L.banner.angle <= 359, it.id);
    } else if (it.kind === "profile_effect") {
      assert.ok(CS.EFFECTS.includes(L.effect), it.id);
    } else {
      assert.ok(CS.GTF_LAYERS[it.kind].includes(L.gtf[1]) && L.gtf[0] === CS.GTF_OPT[it.kind], it.id);
      assert.match(L.gtf[1], /^[a-z][a-z0-9_]{0,31}$/, it.id);
    }
  }
});

test("no catalog item loses a colour on the wire (ADR 0007 D13); the caps are the hub's look.schema.json's", () => {
  // every item's look with no cap at all is its look: nothing is down-sampled (the pride items and nc_parade travel whole)
  const caps = { ...CS.MAX };
  let longest = { name: 0, ring: 0, border: 0, banner: 0 };
  try {
    Object.assign(CS.MAX, { name: 1e6, ring: 1e6, border: 1e6, banner: 1e6 });
    const whole = new Map(CAT.items.map((it) => [it.id, CS.lookOf(it)]));
    Object.assign(CS.MAX, caps);
    for (const it of CAT.items) {
      const L = CS.lookOf(it);
      assert.deepEqual(L, whole.get(it.id), it.id + ": down-sampled");
      const n = (k, list) => { if (list) longest[k] = Math.max(longest[k], list.length); };
      n("name", L.name && L.name.colors); n("ring", L.deco && L.deco.ring && L.deco.ring.colors);
      n("border", L.border && L.border.colors); n("banner", L.banner && L.banner.colors);
    }
  } finally { Object.assign(CS.MAX, caps); }
  assert.deepEqual(longest, { name: 9, ring: 6, border: 6, banner: 6 }, "nc_parade's 9 stops, the pride ring / border / banner's 6");
  assert.deepEqual(CS.MAX, { name: 12, ring: 8, border: 8, banner: 8, w: 8 });
  const hub = process.env.PATV_HUB_DIR;
  if (hub) {          // the platform's schema says the same caps
    const S = JSON.parse(fs.readFileSync(path.join(hub, "packages", "rt-schema", "schemas", "hcp", "v1", "look.schema.json"), "utf8")).properties;
    assert.equal(S.name.properties.colors.maxItems, CS.MAX.name);
    assert.equal(S.avatar.properties.deco.properties.ring.properties.colors.maxItems, CS.MAX.ring);
    assert.equal(S.profile.properties.border.properties.colors.maxItems, CS.MAX.border);
    assert.equal(S.profile.properties.banner.properties.colors.maxItems, CS.MAX.banner);
  }
});

test("the CSS writer: rgba from {hex, a}, v1's '.35' alphas, spread vs blur shadows, gradient heads, border extras", () => {
  assert.equal(CS.color({ hex: "#fff59d", a: 0.35 }), "rgba(255, 245, 157, .35)");
  assert.equal(CS.color("#111"), "#111");
  assert.throws(() => CS.color("url(x)"));
  assert.throws(() => CS.color({ hex: "#zzzzzz", a: 0.5 }));
  assert.equal(CS.shadow({ inset: true, y: 2, blur: 8, color: { hex: "#ffffff", a: 0.16 } }), "inset 0 2px 8px rgba(255, 255, 255, .16)");
  assert.equal(CS.shadow({ spread: 1, color: "#48484a" }), "0 0 0 1px #48484a");
  assert.equal(CS.ringCss({ border: "#66bb6a", shadows: [{ spread: 6, color: { hex: "#66bb6a", a: 0.35 } }] }),
               "border-color: #66bb6a; box-shadow: 0 0 0 6px rgba(102, 187, 106, .35);");
  assert.equal(CS.borderCss({ w: 4, line: "solid", color: "#1c1c1c", outline: { w: 2, line: "dotted", color: "#c0c4cc", offset: -8 },
                              shadows: [{ blur: 12, color: { hex: "#000000", a: 0.75 } }] }),
               "border: 4px solid #1c1c1c; outline: 2px dotted #c0c4cc; outline-offset: -8px; box-shadow: 0 0 12px rgba(0, 0, 0, .75);");
  assert.equal(CS.gradient({ fn: "radial", shape: "circle", at: [80, 50], stops: [["#9e9e9e", "0 22px"], ["transparent", "31px"]] }),
               "radial-gradient(circle at 80% 50%, #9e9e9e 0 22px, transparent 31px)");
  assert.deepEqual(CS.downsample([1, 2, 3, 4, 5, 6, 7], 4), [1, 3, 5, 7]);
  assert.equal(CS.hex6("#ABC"), "#aabbcc");
  assert.equal(CS.hexOf("from -45deg"), null);
});

test("render() of a broken field draws nothing instead of throwing", () => {
  const r = C.render({ id: "x", kind: "profile_border", style: { border: { w: 2, line: "solid", color: "url(evil)" } } });
  assert.equal(r.css, "");
  const b = C.render({ id: "y", kind: "profile_banner", style: { banner: "linear-gradient(red, blue)" } });
  assert.equal(b.css, "background: ;");
});

test("🍂 Fireside 2026: eight seasonal items like October's - one window, list prices, on sale only in November, never dropped; the new leaves effect is drawn", () => {
  const ids = ["nc_toffeeapple", "pb_flannel", "ad_secondhelping", "bn_fireworks", "fx_fallingleaves", "gh_bobble", "go_fireside", "gp_sparkler"];
  const set = CAT.items.filter((it) => it.season && it.season.label === "Fireside 2026");
  assert.deepEqual(set.map((it) => it.id), ids, "the set, in shop order");
  const RAR = CAT.rarities;
  for (const it of set) {
    assert.deepEqual(it.season, { from: "2026-11-01", to: "2026-12-01", label: "Fireside 2026" }, it.id);
    assert.deepEqual(it.source, ["season"], it.id);
    assert.equal(it.price, RAR[it.rarity].price, it.id + " costs its rarity's list price");
    assert.ok(!it.drop_weight && !it.perk, it.id);
    assert.equal(C.onSale(it, Date.parse("2026-10-31T23:59:59Z")), false, it.id + ": not before November");
    assert.equal(C.onSale(it, Date.parse("2026-11-15T12:00:00Z")), true, it.id + ": on sale in November");
    assert.equal(C.onSale(it, Date.parse("2026-12-01T00:00:00Z")), false, it.id + ": gone on Dec 1 (Winter 2026 starts)");
    assert.equal(C.seasonState(it, Date.parse("2026-12-15T00:00:00Z")), "over");
  }
  // the same kinds, rarities and prices as the Halloween 2026 set (the 'Bonfire Night' name stays October's)
  const hal = CAT.items.filter((it) => it.season && it.season.label === "Halloween 2026");
  assert.deepEqual(set.map((it) => [it.kind, it.rarity]).sort(), hal.map((it) => [it.kind, it.rarity]).sort());
  assert.ok(!set.some((it) => /bonfire night/i.test(it.name)));
  const ring = byId.get("ad_secondhelping");
  assert.ok(Array.isArray(ring.style.conic) && !ring.style.ring, "a conic ring (the nine hand-written rings stay nine)");
  // a profile effect needs its enum entry and its CSS, or it draws nothing
  assert.ok(CS.EFFECTS.includes("leaves"));
  assert.equal(C.render(byId.get("fx_fallingleaves")).effect, "leaves");
  const css = fs.readFileSync(path.join(repo, "views", "partials", "cosmetics-css.ejs"), "utf8");
  for (const e of CS.EFFECTS) assert.ok(css.includes(`.cx-fx-${e} {`), "CSS for every effect: " + e);
  // the shop's set heading: 🍂 and its own colours (not the 📅 / purple fallback)
  const view = fs.readFileSync(path.join(repo, "views", "cosmetics.ejs"), "utf8");
  const helpers = new Function([view.match(/const seasonEmoji = .*;/)[0], view.match(/const seasonClass = .*;/)[0],
                                "return { seasonEmoji, seasonClass };"].join(";"))();
  assert.deepEqual([helpers.seasonEmoji("Fireside 2026"), helpers.seasonClass("Fireside 2026")], ["🍂", "fireside"]);
  assert.deepEqual([helpers.seasonEmoji("Halloween 2026"), helpers.seasonEmoji("Winter 2026"), helpers.seasonClass("Pride 2027")], ["🎃", "❄️", "pride"]);
  assert.match(view, /\.cxp \.season\.fireside \{/);
  assert.doesNotMatch(view, /\(Halloween, winter\)/, "the how-it-works copy names no particular season");
});

// December 2026 - every date is passed in (C.onSale / C.seasonState take the time): nothing reads today's date
test("❄️ Winter Lights 2026: eight seasonal items like November's - one December window, list prices, never dropped; the new lights effect is drawn", () => {
  const ids = ["nc_twinkle", "pb_fairisle", "ad_countdown", "bn_brightnight", "fx_fairylights", "gh_earmuffs", "go_winterlights", "gp_lantern"];
  const set = CAT.items.filter((it) => it.season && it.season.label === "Winter Lights 2026");
  assert.deepEqual(set.map((it) => it.id), ids, "the set, in shop order");
  const RAR = CAT.rarities;
  for (const it of set) {
    assert.deepEqual(it.season, { from: "2026-12-01", to: "2027-01-01", label: "Winter Lights 2026" }, it.id);
    assert.deepEqual(it.source, ["season"], it.id);
    assert.equal(it.price, RAR[it.rarity].price, it.id + " costs its rarity's list price");
    assert.ok(!it.drop_weight && !it.perk, it.id + ": never dropped, not a perk");
    assert.equal(C.onSale(it, Date.parse("2026-11-30T23:59:59Z")), false, it.id + ": not in November");
    assert.equal(C.seasonState(it, Date.parse("2026-11-15T12:00:00Z")), "upcoming", it.id + ": shown as coming in November");
    assert.equal(C.onSale(it, Date.parse("2026-12-01T00:00:00Z")), true, it.id + ": on sale from Dec 1 00:00 UTC");
    assert.equal(C.onSale(it, Date.parse("2026-12-31T23:59:59Z")), true, it.id + ": through New Year's Eve");
    assert.equal(C.onSale(it, Date.parse("2027-01-01T00:00:00Z")), false, it.id + ": gone on New Year's Day (December only)");
    assert.equal(C.seasonState(it, Date.parse("2027-01-15T00:00:00Z")), "over");
  }
  // the hand-over: Fireside's set leaves the shop the second Winter Lights' arrives
  const fire = CAT.items.filter((it) => it.season && it.season.label === "Fireside 2026");
  for (const [when, f, w] of [["2026-11-30T23:59:59Z", true, false], ["2026-12-01T00:00:00Z", false, true]]) {
    assert.ok(fire.every((it) => C.onSale(it, Date.parse(when)) === f), "Fireside at " + when);
    assert.ok(set.every((it) => C.onSale(it, Date.parse(when)) === w), "Winter Lights at " + when);
  }
  // the same kinds, rarities and prices as the Fireside 2026 and Halloween 2026 sets; names of its own
  const key = (xs) => xs.map((it) => [it.kind, it.rarity, it.price].join(" ")).sort();
  assert.deepEqual(key(set), key(fire));
  assert.deepEqual(key(set), key(CAT.items.filter((it) => it.season && it.season.label === "Halloween 2026")));
  const others = CAT.items.filter((it) => !ids.includes(it.id)).map((it) => it.name.toLowerCase());
  for (const it of set) assert.ok(!others.includes(it.name.toLowerCase()), it.name + ": a name of its own (Winter 2026 has Northern Lights, Let It Snow ...)");
  // every winter holiday, none of them the theme (and no Santa: hand-off 07 builds that costume)
  for (const it of set) assert.doesNotMatch(it.name + " " + it.desc, /\b(christmas|xmas|santa|claus|hanukk?ah|kwanzaa|reindeer|sleigh|elf)\b/i, it.id);
  const ring = byId.get("ad_countdown");
  assert.ok(Array.isArray(ring.style.conic) && !ring.style.ring, "a conic ring (the nine hand-written rings stay nine)");
  assert.equal(ring.style.conic.length, 12, "twelve hard strokes");
  assert.deepEqual(CS.lookOf(ring).deco.ring.colors, ["#ffd23f", "#1c1f4a"], "the hub's look: gold and midnight");
  // the new profile effect: its enum entry, its CSS (every effect has one), drawn for the item; reduced motion stops it
  assert.ok(CS.EFFECTS.includes("lights"));
  assert.equal(C.render(byId.get("fx_fairylights")).effect, "lights");
  assert.deepEqual(CS.lookOf(byId.get("fx_fairylights")), { effect: "lights" });
  const css = fs.readFileSync(path.join(repo, "views", "partials", "cosmetics-css.ejs"), "utf8");
  for (const e of CS.EFFECTS) assert.ok(css.includes(`.cx-fx-${e} {`), "CSS for every effect: " + e);
  assert.match(css, /\.cx-fx-lights \{[^}]*animation: cx-twinkle/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.cx-fx,/);
  // the banner and the border carry their own colours into the hub's look
  assert.ok(CS.lookOf(byId.get("bn_brightnight")).banner.colors.includes("#0b1026"), "the night sky is the banner's base");
  assert.deepEqual(CS.lookOf(byId.get("pb_fairisle")).border.colors, ["#c2255c", "#f3e3c3", "#1e3566"]);
  // the shop's set heading: ❄️ and its own colours (the older 'Winter 2026' set keeps its own)
  const view = fs.readFileSync(path.join(repo, "views", "cosmetics.ejs"), "utf8");
  const helpers = new Function([view.match(/const seasonEmoji = .*;/)[0], view.match(/const seasonClass = .*;/)[0],
                                "return { seasonEmoji, seasonClass };"].join(";"))();
  assert.deepEqual([helpers.seasonEmoji("Winter Lights 2026"), helpers.seasonClass("Winter Lights 2026")], ["❄️", "winterlights"]);
  assert.deepEqual([helpers.seasonEmoji("Winter 2026"), helpers.seasonClass("Winter 2026")], ["❄️", "winter"]);
  assert.match(view, /\.cxp \.season\.winterlights \{/);
});
