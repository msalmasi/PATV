// /economy PAT map (Economy v3): the paid-room-command split comes from Pepe's live room_owner share, and launch
// grants read "coming soon" while the launchpad is off.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const ejs = require("ejs");

const repo = path.join(__dirname, "..");
const view = path.join(repo, "views", "economy.ejs");
const opts = { views: [path.join(repo, "views")] };
const render = (extra) => ejs.renderFile(view, Object.assign({ user: null, treasury: null, roomVaults: null, ogBase: "http://t" }, extra), opts);

test("PAT map: paid room commands show the live split, launch grants follow the launchpad switch", async () => {
  const off = await render({ roomSplit: { owner: 10, fortknox: 45, room: 45 }, launchpadOn: false });
  assert.match(off, /45% Fort Knox · 45% that pad&#39;s vault · 10% the pad&#39;s owner|45% Fort Knox · 45% that pad's vault · 10% the pad's owner/);
  assert.match(off, /<li class="soon">Launch grants that seed new pads' vaults<span class="pm-soon">/);
  const on = await render({ roomSplit: { owner: 20, fortknox: 40, room: 40 }, launchpadOn: true });
  assert.match(on, /40% Fort Knox · 40% that pad's vault · 20% the pad's owner/);
  assert.match(on, /<li>Launch grants that seed new pads' vaults<\/li>/);
  // rendered without them (older callers): the defaults, launch grants coming soon
  const bare = await render({});
  assert.match(bare, /45% Fort Knox · 45% that pad's vault · 10% the pad's owner/);
});

test("econpage.roomSplit: the most common non-zero room_owner share, the rest split Fort Knox / room vault", async () => {
  const P = require(path.join(repo, "econpage"));
  const R = require(path.join(repo, "royalties"));
  assert.deepEqual(P.roomSplit(), { owner: 10, fortknox: 45, room: 45 }, "no shares synced: the default");
  const orig = R.ownerShares;
  R.ownerShares = () => [{ flow: "say", pct: 20 }, { flow: "ask", pct: 20 }, { flow: "sponsor", pct: 0 }, { flow: "queue", pct: 10 }];
  try { assert.deepEqual(P.roomSplit(), { owner: 20, fortknox: 40, room: 40 }); } finally { R.ownerShares = orig; }
  assert.equal(P.launchpadOn(), false, "no launchpad synced: off");
});
