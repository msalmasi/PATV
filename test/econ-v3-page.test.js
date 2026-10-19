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

test("1.99ada: the payout recipe's Room games line says unpaid shares top up the prizes only while Pepe reports it on (strict === 1)", async () => {
  // plain English like the rest of the pad-vault card (no catalog piece spliced into an English sentence), with its spaces
  const GAMES = /XP only\. Whatever the owner, gang\s+and streamer slices don't pay out that day is added to this prize pool; what the games don't award stays in the vault\.<\/li>/;
  const REST = /for a busier day \(or, for the owner, gang and streamer slices, tops up the room games' prizes\):<\/p>/;
  const rv = (cfg) => ({ live: true, total: 0, cap: 50000000, rooms: [], recipe: { on: true, cfg } });
  const games = (h) => (h.match(/<li><b>Room games[\s\S]*?<\/li>/) || [""])[0];
  const on = await render({ roomVaults: rv({ games_pct: 0.2, games_unpaid: 1 }) });
  assert.match(games(on), /Room games 20%/);
  assert.match(games(on), GAMES, "on: in the Room games line");
  assert.match(on, REST, "and in the 'the rest stays' sentence");
  for (const cfg of [{ games_pct: 0.1, games_unpaid: 0 }, { games_pct: 0.1 }, { games_pct: 0.1, games_unpaid: true }]) {
    const off = await render({ roomVaults: rv(cfg) });
    assert.match(off, /Room games 10%/);
    assert.doesNotMatch(off, /Whatever the owner, gang/, "off / an older Pepe: nothing - " + JSON.stringify(cfg));
    assert.match(off, /for a busier day:<\/p>/);
  }
  // a value Pepe reports out of range (a bad chat override from before 1.99adb's load check) never prints "500%"
  const junk = await render({ roomVaults: rv({ games_pct: 5, owner_pct: -0.1, gang_pct: "x", people_pct: 0, cap_i7: 2 }) });
  assert.match(junk, /Room games 10%/); assert.match(junk, /Owner 15%/); assert.match(junk, /Gang 15%/);
  assert.match(junk, /Regulars 0%/, "a real 0 slice shows 0");
  assert.match(junk, /Capped at 25% of the room/);
  assert.doesNotMatch(junk, /500%|-10%|200%/);
});
