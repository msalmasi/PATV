// 1.99zh: gtfheist.js - the live heist page's feed (/api/gtf/heist/live) and Pepe's overlay page.
//   * a heist's events in order; a new session starts a fresh log; the first call gets only the current scene
//   * the narration lines and the summary are kept (and cleaned); closed / cancelled ends it; an old heist stops showing
//   * the overlay upload is sha-checked; /gtf/heist/overlay serves it same-origin; bot routes need the token
//   * the page renders (with and without a heist); the /gtf minimap links it
//   NODE_PATH=G:/PATV/node_modules node --test test/gtfheist.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "gtfheist-test-")));
const express = require("express");
const ejs = require("ejs");
const H = require(path.join(repo, "gtfheist"));

const sum = (session, phase, round) => ({ session, phase, job: "casino", scenario: "Casino Job", emoji: "🎰", rounds: 5, round, room: "PepeLab",
  crew: [{ name: "alice", seed: 12, status: "in", held: 500 }, { name: "<b>bob</b>", seed: 13, status: "out", held: 0 }] });

let base, server;
test.before(async () => {
  const app = express();
  app.use((req, res, next) => (req.path === "/api/gtf/bot/overlay" ? next() : express.json()(req, res, next)));
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  H.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("events, scenes, sessions", async () => {
  await H.push({ kind: "lobby", summary: sum("s1", "lobby", 0), events: [{ event: "lobby", data: { action: "open", title: "CASINO JOB", players: [] } }] });
  let f = await H.live(0);
  assert.equal(f.heist.session, "s1");
  assert.deepEqual(f.events.map((e) => e.event), ["lobby"]);
  await H.push({ kind: "start", summary: sum("s1", "running", 0), events: [{ event: "heist", data: { action: "start", crew: [] } }] });
  await H.push({ kind: "round", summary: sum("s1", "running", 1), events: [{ event: "heist", data: { action: "round", round: 1, dc: 9 } }],
                 lines: [{ t: 1, text: "Round 1: the pit boss looks over" }] });
  await H.push({ kind: "rolls", events: [{ event: "heist", data: { action: "rolls", rolls: [{ name: "alice", roll: 14 }] } }, { event: "heist", data: { action: "bogus" } }] });
  f = await H.live(0);
  assert.deepEqual(f.events.map((e) => e.data.action), ["round", "rolls"], "the first call: only the current scene (from the last round)");
  // 1.99@S: the countdown rides along after the rolls and is part of the current scene
  await H.push({ kind: "timer", events: [{ event: "heist", data: { action: "timer", kind: "bail", label: "Round 2 in", secs: 16, until: Date.now() + 16000 } }] });
  const ft = await H.live(0);
  assert.deepEqual(ft.events.map((e) => e.data.action), ["round", "rolls", "timer"], "the timer is kept and replayed with its scene");
  assert.ok(ft.now > 0, "the feed carries the site clock (countdown skew)");
  const after = await H.live(f.events[0].id);
  assert.deepEqual(after.events.map((e) => e.data.action), ["rolls", "timer"]);
  assert.equal(f.heist.lines.length, 1);
  assert.equal(f.heist.summary.crew[1].name, "<b>bob</b>", "kept as text (the page escapes it)");
  // a new heist: a fresh log
  await H.push({ kind: "lobby", summary: sum("s2", "lobby", 0), events: [{ event: "lobby", data: { action: "open" } }] });
  f = await H.live(0);
  assert.equal(f.heist.session, "s2");
  assert.equal(f.heist.lines.length, 0);
  await H.push({ kind: "cancelled", events: [{ event: "heist", data: { action: "closed" } }] });
  f = await H.live(0);
  assert.ok(f.heist.ended, "cancelled = ended");
  assert.equal(f.heist.summary.phase, "cancelled");
});

test("overlay upload: sha-checked, served same-origin, bot token", async () => {
  const html = "<!DOCTYPE html><html><body>overlay</body></html>";
  const sha = crypto.createHash("sha256").update(html).digest("hex");
  let r = await fetch(base + "/api/gtf/bot/overlay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope", sha, html }) });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/gtf/bot/overlay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bot-token", sha: "0".repeat(64), html }) });
  assert.equal(r.status, 400, "a wrong sha is refused");
  r = await fetch(base + "/api/gtf/bot/overlay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bot-token", sha, html }) });
  assert.equal(r.status, 200);
  r = await fetch(base + "/api/gtf/bot/overlay/have", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bot-token", sha }) });
  assert.equal((await r.json()).have, true);
  r = await fetch(base + "/gtf/heist/overlay");
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(await r.text(), /overlay/);
  r = await fetch(base + "/api/gtf/bot/heistlive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  assert.equal(r.status, 403);
});

test("the page renders; the minimap links it", async () => {
  const view = path.join(repo, "views", "gtfHeist.ejs");
  const withHeist = await ejs.renderFile(view, { user: null, first: await H.live(0) });
  assert.match(withHeist, /\/gtf\/heist\/overlay\?view=games&amp;feed=\/api\/gtf\/heist\/live/);
  const none = await ejs.renderFile(view, { user: "pb", first: null });
  assert.match(none, /No heist is running/);
  const gtf = fs.readFileSync(path.join(repo, "views", "gtf.ejs"), "utf8");
  assert.ok(gtf.includes('href="/gtf/heist"'), "the minimap links the live page");
});
