// Offline tests for the room pages' DJ panel (roomdj.js, 1.99ba): Pepe's sync is bot-token only and
// re-sanitised (Spotify CDN art only, the admin lists never reach a browser); the panel only shows
// for a room Pepe reported lately; actions need a signed-in, linked account, the site's own fetch,
// a known verb, and admin powers for the DJ controls; they become "dj" website actions Pepe runs as
// that user; the generic /act form can't queue one; search results come back on the action; the
// room page renders the panel (read-only without a linked name).
//   node --test test/roomdj.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roomdj-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const actions = require(path.join(repo, "actions"));
const roomdj = require(path.join(repo, "roomdj"));

const R = { id: "PepeFrog.Room", slug: "pepes-pad" };
const R2 = { id: "Quiet.Room", slug: "quiet" };
const ART = "https://i.scdn.co/image/ab67616d00004851aaaaaaaaaaaaaaaaaaaaaaaa";

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await new Promise((r) => setTimeout(r, 100));               // actions.js creates pepe_actions on load
  for (const [id, cf] of [["u1", "Viewer1"], ["u2", null], ["u3", "BossFrog"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, id + "_patv", id, cf]);
  }
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  actions.register(app, { isBotToken, addUser });
  roomdj.register(app, { isBotToken, addUser, bySlug: (s) => (s === R.slug ? R : s === R2.slug ? R2 : null) });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {}, extra);
async function post(p, body, u, headers) {
  const r = await fetch(base + p, { method: "POST", headers: headers || H(u), body: JSON.stringify(body) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(p, u) { const r = await fetch(base + p, { headers: H(u) }); return { status: r.status, d: await r.json() }; }

const SYNC = {
  password: "bot-token",
  rooms: [{ id: R.id, name: "Pepe's Pad", queue: true, play: true, pause: true, talk: true, price: { queue: 2500 } }],
  state: {
    connected: true, at: Date.now(),
    now: { title: "Now Song", artist: "Now Artist", by: "dj", art: ART, playing: true, progress_ms: 30000, duration_ms: 200000 },
    queue: [{ title: "Req", artist: "A", by: "user", who: "Bob", art: "javascript:alert(1)" },
            { title: "Pick", artist: "B", by: "dj", art: "https://evil.example/x.png" },
            { title: "<img src=x onerror=alert(1)>", artist: "C‮", by: "nonsense" }],
    dj: { on: true, vibe: { text: "something chill", by: "someone", until: Date.now() + 600000 }, genre: "90s hip hop" },
    drop: { text: "Here we go!", ts: Date.now() }, votes: { start: 4, stop: 2 }, max_pending: 2,
  },
  admins: { dj: ["bossfrog"], music: ["bossfrog", "<script>"] },
};

test("sync: bot token only; state re-sanitised; watching rooms reported", async () => {
  assert.equal((await post("/api/dj/sync", Object.assign({}, SYNC, { password: "nope" }))).status, 403);
  const r = await post("/api/dj/sync", SYNC);
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.watching, []);
  const S = roomdj._S;
  assert.equal(S.state.now.art, ART);
  assert.equal(S.state.queue[0].art, undefined, "javascript: art dropped");
  assert.equal(S.state.queue[1].art, undefined, "non-Spotify art dropped");
  assert.equal(S.state.queue[2].by, "spotify", "unknown label -> spotify");
  assert.ok(!/‮/.test(S.state.queue[2].artist), "bidi control stripped");
  assert.ok(S.admins.music.has("bossfrog") && !S.admins.music.has("<script>"), "admin logins validated");
  await get("/api/rooms/pepes-pad/dj", "u1");
  assert.deepEqual((await post("/api/dj/sync", SYNC)).d.watching, [R.id], "a polled room is 'watching'");
});

test("panel: signed in only; inactive for a room without music; no admin lists in the response", async () => {
  assert.equal((await get("/api/rooms/pepes-pad/dj", null)).status, 401);
  assert.equal((await get("/api/rooms/nope/dj", "u1")).status, 404);
  assert.deepEqual((await get("/api/rooms/quiet/dj", "u1")).d, { active: false });
  const v = (await get("/api/rooms/pepes-pad/dj", "u1")).d;
  assert.equal(v.active, true);
  assert.equal(v.room.price.queue, 2500, "the room's chat price");
  assert.deepEqual(v.me, { linked: true, djAdmin: false, musicAdmin: false });
  assert.ok(!JSON.stringify(v).includes("bossfrog"), "admin logins never reach a browser");
  assert.equal(v.state.queue[0].who, "Bob");
  const unl = (await get("/api/rooms/pepes-pad/dj", "u2")).d;
  assert.deepEqual(unl.me, { linked: false, djAdmin: false, musicAdmin: false });
  const boss = (await get("/api/rooms/pepes-pad/dj", "u3")).d;
  assert.deepEqual(boss.me, { linked: true, djAdmin: true, musicAdmin: true }, "case-insensitive login match");
});

test("panel goes inactive when Pepe stops syncing", async () => {
  const S = roomdj._S, was = S.at;
  S.at = Date.now() - 5 * 60 * 1000;
  assert.equal((await get("/api/rooms/pepes-pad/dj", "u1")).d.active, false);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "skip" }, "u1")).status, 409);
  S.at = was;
});

test("actions: gating", async () => {
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "skip" }, "u1", { "content-type": "application/json", "x-test-user": "u1" })).status, 400,
    "no X-Requested-With: fetch -> refused (cross-site forms)");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "skip" }, null)).status, 401);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "skip" }, "u2")).status, 403, "unlinked");
  assert.equal((await post("/api/rooms/quiet/dj", { verb: "skip" }, "u1")).status, 409, "not a music room");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "vol", text: "100" }, "u1")).status, 400, "unknown verb");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "__proto__" }, "u1")).status, 400);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "dj.on" }, "u1")).status, 403, "DJ controls: admins only");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "dj.clear" }, "u1")).status, 403, "reset session: admins only");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "find", text: "  " }, "u1")).status, 400);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "pick", text: "1; drop" }, "u1")).status, 400);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "vibe", text: "" }, "u1")).status, 400);
});

test("actions: queued as 'dj' website actions Pepe runs as the user", async () => {
  const a = await post("/api/rooms/pepes-pad/dj", { verb: "skip", text: "ignored words" }, "u1");
  assert.equal(a.d.ok, true);
  let row = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [a.d.id]))[0];
  assert.equal(row.kind, "dj");
  assert.deepEqual(JSON.parse(row.args), [R.id, "skip"], "a no-text verb carries no text");
  assert.equal(row.camfrog, "Viewer1");
  assert.equal(row.tag, "dj:" + R.id);
  const v = await post("/api/rooms/pepes-pad/dj", { verb: "vibe", text: "90s\nhip hop" }, "u1");
  row = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [v.d.id]))[0];
  assert.deepEqual(JSON.parse(row.args), [R.id, "vibe", "90s hip hop"]);
  const boss = await post("/api/rooms/pepes-pad/dj", { verb: "dj.off" }, "u3");
  assert.equal(boss.d.ok, true, "an admin may ask for a DJ control");
  // Pepe claims them like any action (not the table lane)
  const c = await post("/api/actions/claim", { password: "bot-token" });
  assert.ok(c.d.actions.some((x) => x.kind === "dj" && x.args[1] === "skip" && x.camfrog === "Viewer1"));
  // the busy cap applies (6 open actions per user)
  for (let i = 0; i < 6; i++) await post("/api/rooms/pepes-pad/dj", { verb: "pause" }, "u1");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "pause" }, "u1")).status, 429);
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE user_id = 'u1'");
});

test("the generic /act form can't queue a DJ action (CMDS / KINDS allow-lists)", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM pepe_actions"))[0].n;
  for (const body of [{ kind: "dj", a0: R.id, a1: "skip", back: "/rooms/pepes-pad" }, { kind: "cmd", cmd: "dj", a0: "on", back: "/rooms/pepes-pad" },
                      { kind: "cmd", cmd: "skip", a0: "x", back: "/" }]) {
    const r = await fetch(base + "/act", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-test-user": "u1" }, body: new URLSearchParams(body).toString() });
    assert.equal(r.status, 302);
    assert.match(decodeURIComponent(r.headers.get("location")), /can't be done from the site/);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions"))[0].n, before);
});

test("search: Pepe's results come back on the action, for its owner only", async () => {
  const a = await post("/api/rooms/pepes-pad/dj", { verb: "find", text: "song one" }, "u1");
  assert.equal(a.d.ok, true);
  assert.equal((await post("/api/dj/result", { password: "nope", id: a.d.id, results: [] })).status, 403);
  await post("/api/dj/result", { password: "bot-token", id: a.d.id, results: [
    { n: 1, title: "Song One", artist: "X", album: "LP", art: ART }, { n: 2, title: "Two", artist: "Y", art: "data:image/png;base64,AAAA" }] });
  await post("/api/actions/ack", { password: "bot-token", results: [{ id: a.d.id, ok: true, message: "found 2 - pick one" }] });
  const s = (await get("/api/rooms/pepes-pad/dj/act/" + a.d.id, "u1")).d;
  assert.equal(s.status, "done");
  assert.equal(s.results.length, 2);
  assert.equal(s.results[0].art, ART);
  assert.equal(s.results[1].art, undefined);
  assert.equal((await get("/api/rooms/pepes-pad/dj/act/" + a.d.id, "u3")).status, 404, "someone else's action");
  const panel = (await get("/api/rooms/pepes-pad/dj", "u1")).d;
  assert.ok(panel.acts.some((x) => x.id === a.d.id && x.message === "found 2 - pick one"), "recent DJ requests listed");
});

test("DJ patter (1.99bl): shout-outs for anyone, patter switches for admins, sanitised queue + settings", async () => {
  const sync = JSON.parse(JSON.stringify(SYNC));
  sync.rooms[0].patter = { on: true, live: true, every: 99, words: 30, joins: true, starters: false };
  sync.rooms[0].price.shoutout = 2500;
  sync.state.shoutouts = [{ to: "Bob‮", by: "Alice", msg: "happy birthday", ded: true }, { to: "" }, "junk"];
  await post("/api/dj/sync", sync);
  const v = (await get("/api/rooms/pepes-pad/dj", "u1")).d;
  assert.equal(v.room.price.shoutout, 2500);
  assert.deepEqual(v.room.patter, { on: true, live: true, every: 10, words: 30, joins: true, starters: false }, "clamped");
  assert.equal(v.state.shoutouts.length, 1, "malformed entries dropped");
  assert.equal(v.state.shoutouts[0].to, "Bob", "bidi stripped");
  assert.equal(v.state.shoutouts[0].ded, true);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "shoutout", text: "" }, "u1")).status, 400, "needs a name");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "shoutout", text: "<b> hi" }, "u1")).status, 400, "starts with a login");
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "dj.patter.off" }, "u1")).status, 403, "patter switches: admins only");
  const a = await post("/api/rooms/pepes-pad/dj", { verb: "shoutout", text: "@bob happy birthday -d" }, "u1");
  assert.equal(a.d.ok, true);
  const row = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [a.d.id]))[0];
  assert.deepEqual(JSON.parse(row.args), [R.id, "shoutout", "@bob happy birthday -d"]);
  assert.match(row.label, /shout-out/);
  const s = await post("/api/rooms/pepes-pad/dj", { verb: "skip", text: "ignored" }, "u3");
  assert.deepEqual(JSON.parse((await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [s.d.id]))[0].args), [R.id, "skip"]);
  assert.equal((await post("/api/rooms/pepes-pad/dj", { verb: "dj.patter.joins.off" }, "u3")).d.ok, true, "an admin may switch patter");
  await runQuery("UPDATE pepe_actions SET status = 'done'");
  await post("/api/dj/sync", SYNC);
});

test("homepage helper: now playing for a music room only", () => {
  assert.deepEqual(roomdj.nowPlaying(R.id), { title: "Now Song", artist: "Now Artist", playing: true, dj: true });
  assert.equal(roomdj.nowPlaying(R2.id), null);
});

test("room page renders the panel; read-only without a linked name; escaped", async () => {
  const render = (linked, slug) => ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: "u", signedIn: true, linked, room: { name: "Pepe's Pad", slug: slug || "pepes-pad", count: 2, live: true, topic: "" },
    initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {} });
  const on = await render(true);
  assert.match(on, /id="rdj"/);
  assert.match(on, /id="rdjFind"/);
  assert.match(on, /room-dj\.js/);
  const ro = await render(false);
  assert.match(ro, /id="rdj"/);
  assert.doesNotMatch(ro, /id="rdjFind"/, "no request form when read-only");
  assert.match(ro, /link your Camfrog name/);
  const evil = await render(true, "a\"><script>x</script>");
  assert.doesNotMatch(evil, /data-slug="a"><script>/);
  const out = await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: null, signedIn: false, linked: false, room: { name: "Pepe's Pad", slug: "pepes-pad", count: 2, live: true, topic: "" },
    initial: null, onStage: false, stage: {} });
  assert.doesNotMatch(out, /id="rdj"/, "signed-out visitors get the sign-in teaser, no panel");
});
