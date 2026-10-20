// S1 Q5a (1.99adp, ADR 0007 D13): the account cosmetics' ring, border and banner CSS is written from structured fields
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
  assert.equal(of("avatar_decoration").length, 19);
  assert.equal(of("profile_border").length, 21);
  assert.equal(of("profile_banner").length, 18);
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
