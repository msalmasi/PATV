"use strict";
// newstream 1.99akv (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the homepage's pieces that only learned about a stream at load:
//   1. Top Pads' "now playing" line of a SITE pad (no Camfrog room) - /api/home/nowplaying read the bridge's summary only, so a site pad's id
//      was never answered and its line never moved after load (rooms.withSitePads: the rows the page's Top Pads come from)
// Each test failed on 1.99akr (eaaf29c9).
//   node --test test/newstream-home.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "newstream-home-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const bridge = require(path.join(repo, "bridge"));
const MS = require(path.join(repo, "mainstage"));
const home = require(path.join(repo, "home"));

let server, base;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await rooms.init();
  const app = express();
  home.register(app, { addUser: (req, res, next) => next(), xpForNextLevel: () => 100 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => new Promise((r) => server.close(r)));

test("1: a site pad's Top Pads line follows a stream that started after load (/api/home/nowplaying answers site pads)", async () => {
  const keep = { summary: bridge.summary, withSitePads: rooms.withSitePads, publicSlots: MS.publicSlots };
  let slots = [];
  bridge.summary = async () => [{ id: "Cf.Room", slug: "cf-room", name: "Cf Room", live: true, count: 3, micCount: 0, mic: [] }];
  // (padsignals' row for a pad without a Camfrog room - live on its site activity)
  rooms.withSitePads = async (sum) => (sum || []).concat([{ id: "Site.Pad", slug: "site-pad", name: "Site Pad", live: true, count: 0, micCount: 0, site: true }]);
  MS.publicSlots = async () => slots;
  try {
    const ask = async () => (await fetch(base + "/api/home/nowplaying?ids=Site.Pad,Cf.Room")).json();
    let d = await ask();
    assert.equal(d.ok, true);
    assert.ok("Site.Pad" in d.np, "the site pad is answered");
    assert.equal(d.np["Site.Pad"], null, "nothing on yet");
    slots = [{ id: "s1", room_id: "Site.Pad", display: "Juniper", title: "Fresh set", hls: "/x.m3u8", featured: true }];
    d = await ask();
    assert.deepEqual(d.np["Site.Pad"], { k: "stage", name: "Juniper", title: "Fresh set" }, "🎥 Juniper — Fresh set, no refresh");
    assert.ok("Cf.Room" in d.np, "Camfrog pads as before");
  } finally { Object.assign(bridge, { summary: keep.summary }); rooms.withSitePads = keep.withSitePads; MS.publicSlots = keep.publicSlots; }
});
