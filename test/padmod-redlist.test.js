// 1.99abv: the room's 🟥 red list in the pad Manage panel - exact lines only, the list + "can Pepe grant admin here" from
// Pepe's caps, refused (greyed) where he can't, and only for Pepe admins / the pad's owner (Pepe's caps decide).
//   node --test test/padmod-redlist.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const PM = require(path.join(__dirname, "..", "padmod"));

test("exact lines: add / remove a checked login, nothing else", () => {
  assert.deepEqual(PM.buildModLine("redlist_add", "Bob_1"), { line: "!redlist add Bob_1" });
  assert.deepEqual(PM.buildModLine("redlist_remove", "@bob"), { line: "!redlist remove bob" });
  assert.ok(PM.buildModLine("redlist_add", "-all").error, "a flag is never a login");
  assert.ok(PM.buildModLine("redlist_add", "bob clear").error);
});

test("caps: the list and the grant flag ride along only with Pepe's red-list powers", () => {
  const c = PM.cleanCaps({ actions: ["kick", "redlist_add", "redlist_remove"], redlist: { edit: true, capable: false, list: ["Stevie", "bad name!"] } });
  assert.deepEqual(c.redlist, { edit: true, capable: false, list: ["stevie"] });
  assert.ok(c.actions.includes("redlist_add"));
  const n = PM.cleanCaps({ actions: ["kick", "redlist_add"] });
  assert.ok(!n.actions.includes("redlist_add") && !n.redlist, "no red list from Pepe: no red-list actions");
});

test("refused where Pepe can't grant admin, or without the powers", () => {
  assert.match(PM.redlistRefusal("redlist_add", { redlist: { edit: true, capable: false } }), /can't give admin/);
  assert.equal(PM.redlistRefusal("redlist_add", { redlist: { edit: true, capable: true } }), null);
  assert.match(PM.redlistRefusal("redlist_remove", {}), /Pepe admins and the pad's owner/);
  assert.equal(PM.redlistRefusal("kick", {}), null, "other actions untouched");
});
