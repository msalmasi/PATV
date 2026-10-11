// 🚀 Boost announcements (1.99nk): a pad boost made on the website queues a "boostnote" relay job so Pepe says it in the
// pad's Camfrog room (pepe_rooms._boost_note coalesces them per room: one line per 60 s, summed). Only for a live room;
// a hidden booster is "someone" and no login is sent; the job is offered to Pepe once; bounded per room. A chat !boost is
// announced by Pepe from its own reply, which now carries pad + link.
//   node --test test/boost-announce.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boost-ann-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const quotes = require(path.join(repo, "quotes"));

const ROOM = { id: "Boost.Room", name: "Boost Room" };
const jobs = () => [...relay._jobs.values()].filter((j) => j.kind === "boostnote");
function clearJobs() { for (const [k, j] of relay._jobs) if (j.kind === "boostnote") relay._jobs.delete(k); bridge._boostAnnHits.clear(); }

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  const add = (id, u, d, cf) => runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, u, d, cf]);
  await add("u_alice", "alice", "Alice ✨", "alicecf");
  await add("u_web", "webonly", "", null);
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "alicecf", login: "alicecf", display: "alice" }], mic: [], count: 1 }], events: [] });
});

test("a website boost is queued for Pepe once, with the pad, amount, link and the booster's name", async () => {
  clearJobs();
  const r = await bridge.boostAnnounce({ roomId: ROOM.id, userId: "u_alice", amount: 50000, pad: "Boost Room", link: "https://publicaccess.tv/p/boost-room" });
  assert.deepEqual(r, { queued: true });
  const j = jobs();
  assert.equal(j.length, 1);
  assert.deepEqual({ camfrog: j[0].camfrog, amount: j[0].amount, pad: j[0].pad, display: j[0].display },
                   { camfrog: "alicecf", amount: 50000, pad: "Boost Room", display: "Alice ✨" });
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "boostnote");
  assert.equal(offered.length, 1);
  assert.deepEqual({ room: offered[0].room, amount: offered[0].amount, pad: offered[0].pad, link: offered[0].link, camfrog: offered[0].camfrog, display: offered[0].display },
                   { room: ROOM.id, amount: 50000, pad: "Boost Room", link: "https://publicaccess.tv/p/boost-room", camfrog: "alicecf", display: "Alice ✨" });
  j[0].claimed = Date.now() - 10 * 60e3;          // never acked: not offered again (it could be said twice)
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "boostnote").length, 0);
  assert.deepEqual(relay.mineFor("u_alice", ROOM.id).filter((x) => x.kind === "boostnote"), [], "not in the relay composer's status feed");
});

test("hidden booster -> 'someone' and no login; a booster with no link -> PATV name; offline room / bad input; per-room bound", async () => {
  clearJobs();
  const h = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
  quotes.setHidden([h("alicecf")]);
  assert.equal((await bridge.boostAnnounce({ roomId: ROOM.id, userId: "u_alice", amount: 100, pad: "Boost Room" })).queued, true);
  assert.deepEqual({ camfrog: jobs()[0].camfrog, display: jobs()[0].display }, { camfrog: "", display: "someone" });
  quotes.setHidden([]);
  clearJobs();
  assert.equal((await bridge.boostAnnounce({ roomId: ROOM.id, userId: "u_web", amount: 100, pad: "Boost Room" })).queued, true);
  assert.deepEqual({ camfrog: jobs()[0].camfrog, display: jobs()[0].display }, { camfrog: "", display: "webonly" });
  assert.equal((await bridge.boostAnnounce({ roomId: "No.Such.Room", userId: "u_web", amount: 100, pad: "x" })).why, "room offline");
  assert.equal((await bridge.boostAnnounce({ roomId: ROOM.id, userId: "u_web", amount: 0, pad: "x" })).why, "amount");
  assert.equal((await bridge.boostAnnounce({ roomId: ROOM.id, userId: "nobody", amount: 5, pad: "x" })).why, "booster");
  clearJobs();
  let n = 0;
  for (let i = 0; i < 25; i++) if ((await bridge.boostAnnounce({ roomId: ROOM.id, userId: "u_web", amount: 100, pad: "Boost Room" })).queued) n++;
  assert.equal(n, 20, "at most 20 jobs per room a minute (Pepe sums them into one line anyway)");
});

test("wiring: web boosts announce (chat boosts don't - Pepe says those), the chat reply carries pad + link", () => {
  const src = fs.readFileSync(path.join(repo, "boosts.js"), "utf8");
  assert.match(src, /if \(via === "web"\) \{\s+try \{ await require\("\.\/bridge"\)\.boostAnnounce\(\{ roomId: R\.id, userId: user\.userId, amount, pad: R\.title, link: padLink\(R\) \}\);/);
  assert.match(src, /amount: r\.amount, last_hour: st\.last_hour, pad: R\.title, link: padLink\(R\) \}\);/);
  const B = require(path.join(repo, "boosts"));
  assert.equal(B.padLink({ id: "Boost.Room", slug: "boost-room" }), "https://publicaccess.tv/p/boost-room");
});
