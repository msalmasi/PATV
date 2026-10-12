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
  const src = require("fs").readFileSync(path.join(repo, "cosmetics.js"), "utf8");
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
