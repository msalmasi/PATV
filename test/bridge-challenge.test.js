// Offline tests for 1.99de mic challenges on the room feed: Pepe's x.pepe.challenge event becomes a "chal"
// feed item (category / verdict whitelisted, score clamped, incognito performers stay "someone"), and the
// room page + homepage widget render it as one line.
//   node --test test/bridge-challenge.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-chal-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const bridge = require(path.join(repo, "bridge"));

let seq = 0;
const ROOM = { id: "pepelab.room", name: "PepeLab", kind: "room" };
function ev(type, data) {
  return { op: "event", id: "t-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data };
}
const feed = () => bridge._rooms.get(ROOM.id).feed.filter((x) => x.k === "chal");

test("a challenge result becomes one chal feed item", async () => {
  await bridge.ingest({ rooms: [{ room: ROOM, members: [], mic: [] }], events: [
    ev("x.pepe.challenge", { user: { id: "alice", login: "alice", display: "Alice W" }, category: "sing", verdict: "scored",
                             score: 7.04, quip: "a frog in love", paid: 35000 }),
  ] });
  const it = feed().pop();
  assert.equal(it.u.display, "Alice W");
  assert.equal(it.cat, "sing");
  assert.equal(it.v, "scored");
  assert.equal(it.score, 7);
  assert.equal(it.paid, 35000);
  assert.equal(it.text, "a frog in love");
});

test("incognito performer stays anonymous; head-to-head carries the opponent", async () => {
  await bridge.ingest({ events: [
    ev("x.pepe.challenge", { user: { id: "anon-1", display: "someone", anonymous: true }, category: "beatbox", verdict: "won",
                             score: 8, quip: "", vs: { id: "bob", login: "bob", display: "Bob" }, vs_score: 99 }),
  ] });
  const it = feed().pop();
  assert.deepEqual(it.u, { anon: true, display: "someone" });
  assert.equal(it.vs.login, "bob");
  assert.equal(it.vsScore, 10);
});

test("unknown categories / verdicts are dropped", async () => {
  const before = feed().length;
  await bridge.ingest({ events: [
    ev("x.pepe.challenge", { user: { id: "alice", login: "alice" }, category: "karaoke", verdict: "scored", score: 5 }),
    ev("x.pepe.challenge", { user: { id: "alice", login: "alice" }, category: "sing", verdict: "hacked", score: 5 }),
  ] });
  assert.equal(feed().length, before);
});

// the renderers in the two views share chalText(); run it from the room page's inline script
test("room page + homepage render the challenge line", () => {
  for (const view of ["views/room.ejs", "views/home.ejs"]) {
    const src = fs.readFileSync(path.join(repo, view), "utf8");
    const m = src.match(/var CHAL = [\s\S]*?\n    function chalText\(it\) \{[\s\S]*?\n    \}\n/);
    assert.ok(m, view + ": chalText present");
    const ctx = { out: null };
    vm.runInNewContext("function label(u) { return !u || u.anon ? 'someone' : (u.display || u.login); }\n" + m[0] +
      "out = [chalText({cat:'sing', v:'scored', u:{display:'Alice'}, score:7, paid:35000, text:'nice'})," +
      " chalText({cat:'fart', v:'won', u:{anon:true}, vs:{login:'bob'}, score:8, vsScore:6})," +
      " chalText({cat:'moan', v:'not_live', u:{login:'x'}})];", ctx);
    assert.match(ctx.out[0], /Alice scored 7\/10 in the singing challenge \(\+35,000 PAT\) — “nice”/);
    assert.match(ctx.out[1], /someone won a fart-off against bob \(8 vs 6\)/);
    assert.match(ctx.out[2], /disqualified/);
    assert.match(src, /it\.k === 'chal'/, view + ": chal items are rendered");
  }
});
