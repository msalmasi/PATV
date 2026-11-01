// Every GTF cosmetic in cosmetics.json has a painter in public/js/avatar.js (and cosmetics.js knows the
// layer), renders on its own and with a full outfit, and the 1.99re items (alien / reaper / scythe /
// skateboard) are priced and sold the way the catalog says.
//   node --test test/gtf-layers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const repo = path.resolve(__dirname, "..");
require(path.join(repo, "public", "js", "avatar.js"));
const CAT = require(path.join(repo, "cosmetics.json"));
const OPT = { gtf_hat: "hat", gtf_mask: "mask", gtf_outfit: "outfit", gtf_prop: "prop", gtf_bg: "bg", gtf_frame: "frame" };
const gtf = CAT.items.filter((i) => OPT[i.kind]);

test("every GTF item's layer exists in avatar.js and renders", () => {
  const L = globalThis.pepeAvatarLayers;
  for (const it of gtf) {
    const slot = OPT[it.kind], layer = it.style && it.style.layer;
    assert.ok(L[slot].includes(layer), `${it.id}: ${slot} layer ${layer} missing from avatar.js`);
    const svg = globalThis.pepeAvatarSVG(42, 64, { [slot]: layer });
    assert.match(svg, /viewBox="0 0 17 17"/, `${it.id} renders on the layered grid`);
  }
});

test("1.99re items: slots, prices, availability", () => {
  const by = Object.fromEntries(CAT.items.map((i) => [i.id, i]));
  const want = {
    gm_alien: ["gtf_mask", "alien", "rare", 250000],
    go_reaper: ["gtf_outfit", "reaper", "epic", 750000],
    gp_scythe: ["gtf_prop", "scythe", "legendary", 2500000],
    gp_skateboard: ["gtf_prop", "skateboard", "uncommon", 75000],
  };
  for (const [id, [kind, layer, rarity, price]] of Object.entries(want)) {
    const it = by[id];
    assert.ok(it, id);
    assert.equal(it.kind, kind); assert.equal(it.style.layer, layer);
    assert.equal(it.rarity, rarity); assert.equal(it.price, price);
    assert.equal(price, CAT.rarities[rarity].price, `${id} costs its rarity's list price`);
  }
  for (const id of ["go_reaper", "gp_scythe"]) {
    assert.deepEqual(by[id].source, ["season"]);
    assert.deepEqual(by[id].season, by.gh_horns.season, `${id} sells in the Halloween 2026 window`);
  }
  for (const id of ["gm_alien", "gp_skateboard"]) assert.deepEqual(by[id].source, ["shop", "drop"]);
});

test("cosmetics.js knows the new layers", () => {
  // S1 Q5a (1.99ads): the layer enums moved to cosmeticstyle.js (cosmetics.js imports them; the chat hub's looks use them too)
  const src = ["cosmetics.js", "cosmeticstyle.js"].map((f) => require("fs").readFileSync(path.join(repo, f), "utf8")).join("\n");
  for (const l of ["alien", "reaper", "scythe", "skateboard"]) assert.match(src, new RegExp(`"${l}"`));
});

test("hood / alien head hide the seed's random hat; the board only draws legs without an outfit", () => {
  const f = globalThis.pepeAvatarSVG;
  // seed 5's random hat is drawn without a hat layer; the alien mask and the reaper hood cover it
  const bare = f(5, 64, { bg: "city" }), alien = f(5, 64, { bg: "city", mask: "alien" });
  assert.notEqual(bare, alien);
  const withHat = f(5, 64, { mask: "alien", hat: "tophat" });
  assert.match(withHat, /#111111/, "a hat layer still wins over the alien's antennae");
  const board = f(7, 64, { prop: "skateboard" }), boardSuit = f(7, 64, { prop: "skateboard", outfit: "suit" });
  assert.match(board, /#E4572E/); assert.match(boardSuit, /#E4572E/);
});

test("🍂 Fireside 2026 (November): the bobble hat, the knit and the sparkler - painted, listed, seasonal, the October slots and prices", () => {
  const by = Object.fromEntries(CAT.items.map((i) => [i.id, i]));
  const want = {
    gh_bobble: ["gtf_hat", "bobble", "uncommon", 75000],
    go_fireside: ["gtf_outfit", "fireside", "epic", 750000],
    gp_sparkler: ["gtf_prop", "sparkler", "legendary", 2500000],
  };
  const season = { from: "2026-11-01", to: "2026-12-01", label: "Fireside 2026" };
  for (const [id, [kind, layer, rarity, price]] of Object.entries(want)) {
    const it = by[id];
    assert.ok(it, id);
    assert.deepEqual([it.kind, it.style.layer, it.rarity, it.price], [kind, layer, rarity, price], id);
    assert.equal(price, CAT.rarities[rarity].price, `${id} costs its rarity's list price`);
    assert.deepEqual(it.source, ["season"], id);
    assert.deepEqual(it.season, season, `${id} sells in the Fireside 2026 window`);
    assert.ok(!it.drop_weight && !it.perk, `${id}: seasonal gear never drops and isn't a perk`);
    assert.ok(globalThis.pepeAvatarLayers[OPT[kind]].includes(layer), `${id}: avatar.js paints ${layer}`);
  }
  // the same slots and prices as October's horns / shroud / scythe
  assert.deepEqual(["gh_horns", "go_reaper", "gp_scythe"].map((id) => by[id].price), [75000, 750000, 2500000]);
  const f = globalThis.pepeAvatarSVG;
  for (const seed of [7, 42, 1234, 99999]) {
    const bare = f(seed, 64, { bg: "city" });
    for (const o of [{ hat: "bobble" }, { outfit: "fireside" }, { prop: "sparkler" }, { hat: "bobble", outfit: "fireside", prop: "sparkler" }]) {
      const svg = f(seed, 64, { bg: "city", ...o });
      assert.match(svg, /viewBox="0 0 17 17"/);
      assert.notEqual(svg, bare, JSON.stringify(o) + " draws something");
    }
  }
  assert.match(f(42, 64, { hat: "bobble" }), /#F3E3C3/, "the cream bobble");
  assert.notEqual(f(42, 64, { hat: "bobble" }), f(42, 64, { hat: "beanie" }), "not the Getaway Beanie");
  assert.match(f(42, 64, { outfit: "fireside" }), /#C0502E/, "the rust scarf");
  assert.match(f(42, 64, { prop: "sparkler" }), /#FFD23F/, "gold sparks");
});

test("🍂 Fireside review: the sparkler never paints on the face or the hat, the knit keeps every mouth, the bobble has no stray ties", () => {
  const f = globalThis.pepeAvatarSVG;
  const RECT = /<rect x="(\d+)" y="(\d+)" width="([\d.]+)" height="[\d.]+" fill="([^"]+)"\/>/g;
  const grid = (svg) => {
    const g = Array.from({ length: 17 }, () => Array(17).fill(null));
    for (const m of svg.matchAll(RECT)) for (let i = 0; i < Math.round(Number(m[3]) - 0.02); i++) g[+m[2]][+m[1] + i] = m[4];
    return g;
  };
  const MOUTHS = ["#8a0f1a", "#610b12"];                 // MOUTH and the open mouth's darker row
  const KNIT = ["#C0502E", "#E0A526", "#F3E3C3", "#CDB88F"];   // the bobble hat's rust, mustard, cream and shade
  for (let seed = 0; seed < 200; seed++) {
    const bare = grid(f(seed, 64, { bg: "city" }));
    // the frog's head is canvas rows 4-12, cols 4-12: no spark lands there (one did, in the right eye)
    const spark = grid(f(seed, 64, { bg: "city", prop: "sparkler" }));
    for (let y = 4; y <= 12; y++) for (let x = 4; x <= 12; x++) assert.equal(spark[y][x], bare[y][x], `seed ${seed}: sparkler on the face at ${y},${x}`);
    // every pixel the bobble hat paints (its knit colours) stays the hat's under the sparkler (no specks on the band or the cuff)
    const hat = grid(f(seed, 64, { bg: "city", hat: "bobble" }));
    const both = grid(f(seed, 64, { bg: "city", hat: "bobble", prop: "sparkler" }));
    for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
      if (KNIT.includes(hat[y][x]) && hat[y][x] !== bare[y][x]) assert.equal(both[y][x], hat[y][x], `seed ${seed}: a spark on the bobble hat at ${y},${x}`);
    }
    // nothing below the ear flaps (the old tie tassels): from canvas row 7 down it draws what any hat layer does (the Beanie;
    // a hat layer also drops the seed's own shades)
    const beanie = grid(f(seed, 64, { bg: "city", hat: "beanie" }));
    for (let y = 7; y < 17; y++) for (let x = 0; x < 17; x++) assert.equal(hat[y][x], beanie[y][x], `seed ${seed}: bobble paints ${y},${x}`);
    // the knit's scarf wraps under the mouth: a frown's corners and an open mouth (frog row 9 = canvas row 11) survive
    const knit = grid(f(seed, 64, { bg: "city", outfit: "fireside" }));
    for (let x = 0; x < 17; x++) if (MOUTHS.includes(bare[11][x])) assert.equal(knit[11][x], bare[11][x], `seed ${seed}: the knit hides the mouth at 11,${x}`);
  }
});
