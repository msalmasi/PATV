// 💸 Tip from the pad without leaving it (1.99il): the roster menu's Tip opens a modal (public/js/pad-tip.js) that POSTs
// the normal tip route with the pad's slug; the site then queues a "tipnote" job so Pepe announces it in the Camfrog
// room - only when the room is live, the tipper can see the pad, the recipient's linked login is in the room, nobody
// involved is hidden, and within the per-tipper / per-room limits. The job is offered to Pepe once.
//   node --test test/pad-tip.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-tip-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const quotes = require(path.join(repo, "quotes"));
const PA = require(path.join(repo, "padaccess"));

const ROOM = { id: "Tip.Room", name: "Tip Room" };
const tipJobs = () => [...relay._jobs.values()].filter((j) => j.kind === "tipnote");
function clearJobs() { for (const [k, j] of relay._jobs) if (j.kind === "tipnote") relay._jobs.delete(k); bridge._tipAnnHits.clear(); }
async function roster(members) {
  await bridge.ingest({ rooms: [{ room: ROOM, members, mic: [], count: members.length }], events: [] });
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  const add = (id, u, d, cf) => runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, u, d, cf]);
  await add("u_alice", "alice", "Alice ✨", "alicecf");
  await add("u_bob", "bob", "Bob", "bobcf");
  await add("u_carol", "carol", "Carol", null);          // not linked
  await add("u_web", "webonly", "Web Only", null);       // a tipper with no Camfrog link
  await PA.init();
  await roster([{ id: "bobcf", login: "bobcf", display: "Bobby" }, { id: "alicecf", login: "alicecf", display: "alice" }, { id: "anon-1", display: "someone", anonymous: true }]);
});

test("the menu's Tip is a modal item (href kept as the fallback); the modal parses amounts like the tip page", () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), { window: win });
  const items = win.PATVRoom._modMenuItems(null, { login: "bobcf", display: "Bobby", patv: { username: "bob" }, tip: { to: "bob", href: "/u/bob/tip" } }, { signed: true });
  const tip = JSON.parse(JSON.stringify(items.find((x) => x.id === "tip")));
  assert.deepEqual({ kind: tip.kind, to: tip.to, href: tip.href }, { kind: "tip", to: "bob", href: "/u/bob/tip" });
  const w2 = {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-tip.js"), "utf8"), { window: w2, crypto: {} });
  const p = w2.PATVRoom._tipParse;
  assert.equal(p("2500"), 2500); assert.equal(p("2,500"), 2500); assert.equal(p("2.5k"), 2500); assert.equal(p("1m"), 1e6);
  assert.ok(Number.isNaN(p("abc"))); assert.ok(Number.isNaN(p("-5")));
  assert.equal(typeof w2.PATVRoom.tipModal, "function");
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-tip.js"), "utf8");
  assert.match(src, /JSON\.stringify\(\{ amount: p\.amount, note: p\.note, idempotency_key: p\.key, room: o\.slug \|\| '' \}\)/, "the tip route, with the pad slug");
  assert.doesNotMatch(src, /innerHTML/, "textContent only");
});

test("a tip to someone in the room is queued for Pepe, once, with the tipper's name and the recipient's login", async () => {
  clearJobs();
  const r = await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "bob", amount: 5000 });
  assert.deepEqual(r, { queued: true });
  const j = tipJobs();
  assert.equal(j.length, 1);
  assert.equal(j[0].target, "bobcf"); assert.equal(j[0].camfrog, "alicecf"); assert.equal(j[0].amount, 5000); assert.equal(j[0].display, "Alice ✨");
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "tipnote");
  assert.equal(offered.length, 1);
  assert.deepEqual({ room: offered[0].room, target: offered[0].target, amount: offered[0].amount, camfrog: offered[0].camfrog, user: offered[0].user },
                   { room: ROOM.id, target: "bobcf", amount: 5000, camfrog: "alicecf", user: "alice" });
  j[0].claimed = Date.now() - 10 * 60e3;          // never acked: still not offered again (it could be said twice)
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "tipnote").length, 0);
  assert.deepEqual(relay.mineFor("u_alice", ROOM.id).filter((x) => x.kind === "tipnote"), [], "not in the relay composer's status feed");
});

test("not announced: recipient not linked / not in the room, offline room, hidden people, rate limits", async () => {
  clearJobs();
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "carol", amount: 10 })).why, "recipient not linked");
  await runQuery("UPDATE users SET camfrogUsername = 'carolcf' WHERE userId = 'u_carol'");
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "carol", amount: 10 })).why, "recipient not in the room");
  assert.equal((await bridge.tipAnnounce({ slug: "no-such-room", senderId: "u_alice", recipient: "bob", amount: 10 })).why, "room offline");
  const h = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
  quotes.setHidden([h("bobcf")]);
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "bob", amount: 10 })).why, "private");
  quotes.setHidden([h("alicecf")]);
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "bob", amount: 10 })).why, "private", "a hidden tipper isn't named either");
  quotes.setHidden([]);
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_web", recipient: "bob", amount: 10 })).queued, true, "a tipper with no Camfrog link: named by PATV name");
  assert.equal(tipJobs()[0].camfrog, "");
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_web", recipient: "alice", amount: 10 })).why, "rate", "one per tipper per 30 s");
  assert.equal(tipJobs().length, 1);
});

test("an Approved pad: only people inside it can have their tip announced there", async () => {
  clearJobs();
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'approved')", [ROOM.id]);
  await PA.load();
  assert.equal((await bridge.tipAnnounce({ slug: "tip-room", senderId: "u_alice", recipient: "bob", amount: 10 })).why, "pad");
  await runQuery("DELETE FROM pad_access WHERE room_id = ?", [ROOM.id]);
  await PA.load();
});

test("wiring: the tip route announces only for a pad slug and says so; the pad page loads the modal", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /if \(req\.body\.room && typeof req\.body\.room === "string"\) \{\s+const a = await require\("\.\/bridge"\)\.tipAnnounce\(\{ slug: req\.body\.room\.slice\(0, 128\), senderId: req\.userId, recipient: req\.params\.username, amount: r\.amount \}\);\s+body\.announce = !!a\.queued;/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /<script src="\/public\/js\/pad-tip\.js\?v=1"><\/script>/);
  assert.match(room, /me: <%- JSON\.stringify\(signedIn && user \? user : null\)/);
});
