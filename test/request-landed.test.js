// 📼 1.99?? clerkreq S6: a request made from chat landed on Plex -> a "request_landed" relay job, so Pepe says it in the pad's Camfrog
// room: "📼 <title> just landed - requested by <name> - say "pepe play <title>"" (camfrog-bot pepe_plexchat._relay_request_landed).
// Only for a live (bridged) room; offered to Pepe ONCE (a re-offer could say it twice); a veiled (anon) or incognito / hidden requester
// is never named and no login is sent.
//   node --test test/request-landed.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "req-landed-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const quotes = require(path.join(repo, "quotes"));

const ROOM = { id: "Landed.Room", name: "Landed Room" };
const jobs = () => [...relay._jobs.values()].filter((j) => j.kind === "request_landed");
function clearJobs() { for (const [k, j] of relay._jobs) if (j.kind === "request_landed") relay._jobs.delete(k); }

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  const add = (id, u, d, cf) => runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, u, d, cf]);
  await add("u_cedar", "cedar", "Cedar", "cedarcf");
  await add("u_web", "webonly", "", null);
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "cedarcf", login: "cedarcf", display: "cedar" }], mic: [], count: 1 }], events: [] });
});

test("a landed chat request is queued for Pepe once, with the title, the label and the requester's name", async () => {
  clearJobs();
  const r = await bridge.requestLanded({ roomId: ROOM.id, userId: "u_cedar", title: "The Good Doctor", year: 2017, anon: false });
  assert.deepEqual(r, { queued: true });
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "request_landed");
  assert.equal(offered.length, 1);
  assert.deepEqual({ room: offered[0].room, what: offered[0].what, title: offered[0].title, camfrog: offered[0].camfrog, display: offered[0].display },
                   { room: ROOM.id, what: "The Good Doctor (2017)", title: "The Good Doctor", camfrog: "cedarcf", display: "Cedar" });
  jobs()[0].claimed = Date.now() - 10 * 60e3;          // never acked: never offered again (it could be said twice)
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "request_landed").length, 0);
});

test("a veiled (anon) or hidden requester is never named and no login is sent; an offline room or a bad title queues nothing", async () => {
  clearJobs();
  assert.equal((await bridge.requestLanded({ roomId: ROOM.id, userId: "u_cedar", title: "The Good Doctor", year: 2017, anon: true })).queued, true);
  assert.deepEqual({ camfrog: jobs()[0].camfrog, display: jobs()[0].display, userId: jobs()[0].userId }, { camfrog: "", display: "", userId: "" });
  clearJobs();
  const h = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
  quotes.setHidden([h("cedarcf")]);
  assert.equal((await bridge.requestLanded({ roomId: ROOM.id, userId: "u_cedar", title: "The Good Doctor", year: 2017 })).queued, true);
  assert.deepEqual({ camfrog: jobs()[0].camfrog, display: jobs()[0].display }, { camfrog: "", display: "" });
  quotes.setHidden([]);
  clearJobs();
  assert.equal((await bridge.requestLanded({ roomId: ROOM.id, userId: "u_web", title: "Alien", year: null })).queued, true);
  assert.deepEqual({ camfrog: jobs()[0].camfrog, display: jobs()[0].display, what: jobs()[0].what }, { camfrog: "", display: "webonly", what: "Alien" });
  assert.equal((await bridge.requestLanded({ roomId: "No.Such.Room", userId: "u_web", title: "Alien" })).why, "room offline");
  assert.equal((await bridge.requestLanded({ roomId: ROOM.id, userId: "u_web", title: "" })).why, "title");
});

test("wiring: mediarequests says a landed chat request through bridge.requestLanded", () => {
  const src = fs.readFileSync(path.join(repo, "mediarequests.js"), "utf8");
  assert.match(src, /require\("\.\/bridge"\)\.requestLanded\(/);
});
