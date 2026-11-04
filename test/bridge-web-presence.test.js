"use strict";
// 1.99?? dockclean (Room Dock clean-up, owner point 32): web users on a pad's people list (padweb.js). Memory only, 90 s, at most 100 per
// room; PATV names only on the wire (no chat login, no account id); Incognito / !bridge hide / a member already in the room / a failed
// check keep someone off it; while the hidden list is loading nobody is listed.
//   node --test test/bridge-web-presence.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padweb-test-"));
process.chdir(tmp); delete process.env.STAGING; process.env.SECRET_KEY = "fixture-secret";
const { runQuery } = require(path.join(repo, "dbUtils"));
const W = require(path.join(repo, "padweb"));
const H = require(path.join(repo, "hubhidden"));
const R = { id: "Web.Room", members: [{ login: "inroom_cf", display: "In Room" }, { anon: true, veil: "incognito", alias: "Misty Froglet" }] };
const user = (n) => ({ userId: "id-" + n, username: n });
let now = 1_800_000_000_000;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER, updated INTEGER, reported INTEGER)`);
  W._setClock(() => now);
});
test.beforeEach(() => { W._reset(); });

test("a signed-in viewer is listed by PATV name only - no login, no account id; their own entry says me and has no tip", async () => {
  W.note(R.id, user("quill"), "quill_cf"); W.note(R.id, user("viewer"), null);
  const tipOf = (n) => ({ to: n, href: "/u/" + n + "/tip" });
  const list = await W.forRoom(R, { userId: "id-viewer", username: "viewer" }, tipOf);
  assert.deepEqual(list.map((e) => e.display), ["viewer", "quill"], "yourself first, then by name");
  assert.deepEqual(JSON.parse(JSON.stringify(list[1])), { web: true, display: "quill", patv: { username: "quill" }, tip: { to: "quill", href: "/u/quill/tip" } });
  assert.equal(list[0].me, true); assert.equal(list[0].tip, undefined);
  const wire = JSON.stringify(list); assert.doesNotMatch(wire, /id-quill|id-viewer|quill_cf|userId|login/);
});
test("presence lasts 90 s and at most 100 accounts per room (the oldest go first); signed-out viewers are never noted", async () => {
  W.note(R.id, user("early"), null); now += 60_000; W.note(R.id, user("late"), null);
  W.note(R.id, null, null); W.note(R.id, { username: "nobody" }, null);
  now += 31_000;
  assert.deepEqual((await W.forRoom(R)).map((e) => e.display), ["late"], "early is past 90 s");
  for (let i = 0; i < 105; i++) W.note(R.id, user("u" + String(i).padStart(3, "0")), null);
  const all = await W.forRoom(R); assert.equal(all.length, 100);
  assert.equal(all.some((e) => /^u00[0-4]$/.test(e.display)), false, "the five oldest went");
  now += 91_000; assert.deepEqual(await W.forRoom(R), []);
});
test("left out: a linked login already in the room, Incognito (login or account key), !bridge hide, and everyone while the list loads", async () => {
  W.note(R.id, user("dup"), "inroom_cf"); W.note(R.id, user("inc"), "inc_cf"); W.note(R.id, user("incacct"), null); W.note(R.id, user("hid"), "hid_cf"); W.note(R.id, user("ok"), null);
  await runQuery(`INSERT OR REPLACE INTO incognito_state (login, "on", updated, reported) VALUES ('inc_cf', 1, 1, 1), ('u:id-incacct', 1, 1, 1)`);
  const was = H.isLeftOutHash, wasLoading = H.loading;
  try {
    H.isLeftOutHash = (h) => h === H.hash("hid_cf");
    assert.deepEqual((await W.forRoom(R)).map((e) => e.display), ["ok"]);
    H.loading = () => true;
    assert.deepEqual(await W.forRoom(R), [], "fail closed while hubhidden loads");
  } finally { H.isLeftOutHash = was; H.loading = wasLoading; }
});
test("bridge.js: the /live route notes signed-in viewers after its access checks, and only the pad page's own view lists them", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  const route = src.slice(src.indexOf('app.get("/api/rooms/:slug/live"'), src.indexOf("1.99ye STAGING ONLY"));
  assert.ok(route.indexOf("padaccess\").full(req.user, R.id)") < route.indexOf('require("./padweb").note('), "noted after the members-tier check");
  assert.ok(route.indexOf("bridgeOk(R.id)") < route.indexOf('require("./padweb").note('), "and after the Prime Time Plus bridge check");
  assert.match(src, /if \(opts && opts\.program && userId && require\("\.\/paddock"\)\.current\(\)\.cfg\.mode !== "off"\) \{/);
  assert.match(fs.readFileSync(path.join(repo, "views/privacy.ejs"), "utf8"), /<% if \(locals\.padweb\) \{[^%]*%>\s*<p id="rooms-web">[\s\S]*?Incognito keeps you off it\.<\/p><% \} %>/, "the privacy page says so while the Room Dock is on");
  assert.match(fs.readFileSync(path.join(repo, "terms.js"), "utf8"), /res\.locals\.padweb = require\("\.\/paddock"\)\.current\(\)\.cfg\.mode !== "off"/);
});
