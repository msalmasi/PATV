"use strict";
// 1.99ajf dockclean (Room Dock clean-up, owner point 32): web users on a pad's people list (padweb.js). Memory only, 90 s, at most 100 per
// room; PATV names only on the wire (no chat login, no account id); Incognito / !bridge hide / a member already in the room / a failed
// check keep someone off it; while the hidden list is loading nobody is listed.
// 1.99ajf dockclean review (privacy): the site's ONE hidden rule (quotes.isHidden - forget-me / account deletion / staff removal live in
// the chat archive's sticky set, not hubhidden), private room activity (chatlogview.privateFlags), 👻 ghost mode and DM blocks either
// way keep people off it too; only the pad page's own polls (?pad=1) note anyone.
//   node --test test/bridge-web-presence.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padweb-test-"));
process.chdir(tmp); delete process.env.STAGING; process.env.SECRET_KEY = "fixture-secret";
const { runQuery } = require(path.join(repo, "dbUtils"));
const W = require(path.join(repo, "padweb"));
const H = require(path.join(repo, "hubhidden"));
const Q = require(path.join(repo, "quotes")), CV = require(path.join(repo, "chatlogview")), M = require(path.join(repo, "messages")), G = require(path.join(repo, "ghost"));
const R = { id: "Web.Room", members: [{ login: "inroom_cf", display: "In Room" }, { anon: true, veil: "incognito", alias: "Misty Froglet" }] };
const user = (n) => ({ userId: "id-" + n, username: n });
let now = 1_800_000_000_000;
// what the fixture's privacy sources say (padweb reads each through its module at call time)
const S = { hidden: new Set(), clHidden: new Set(), priv: new Set(), privFail: false, blocks: {}, blocksFail: false, ghosts: new Set() };
const real = { isHidden: Q.isHidden, isHiddenLogin: CV.isHiddenLogin, privateFlags: CV.privateFlags, cardBlocks: M.cardBlocks, isGhost: G.isGhost };
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER, updated INTEGER, reported INTEGER)`);
  W._setClock(() => now);
  Q.isHidden = (k) => S.hidden.has(k);
  CV.isHiddenLogin = (k) => S.clHidden.has(k);
  CV.privateFlags = async ({ ids = [] } = {}) => { if (S.privFail) throw new Error("db busy"); return { ids: new Set(ids.filter((i) => S.priv.has(i))), logins: new Set() }; };
  M.cardBlocks = async (id) => { if (S.blocksFail) throw new Error("db busy"); return new Set(S.blocks[id] || []); };
  G.isGhost = (id) => S.ghosts.has(String(id));
});
test.after(() => { Object.assign(Q, { isHidden: real.isHidden }); Object.assign(CV, { isHiddenLogin: real.isHiddenLogin, privateFlags: real.privateFlags }); M.cardBlocks = real.cardBlocks; G.isGhost = real.isGhost; });
test.beforeEach(() => {
  W._reset();
  S.hidden.clear(); S.clHidden.clear(); S.priv.clear(); S.privFail = false; S.blocks = {}; S.blocksFail = false; S.ghosts.clear();
});

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
test("review: the ONE hidden rule - forget-me / deleted / staff-removed people (the chat archive's set) and the chat's own view leave them out", async () => {
  W.note(R.id, user("forgot"), "forgot_cf"); W.note(R.id, user("removed"), null); W.note(R.id, user("clonly"), "clonly_cf"); W.note(R.id, user("ok"), null);
  S.hidden.add("forgot_cf");            // quotes.isHidden: e.g. !forgetme / staff removal, held by chatlog's sticky set only
  S.hidden.add("u:id-removed");         // an account key (no chat login) removed by staff
  S.clHidden.add("clonly_cf");          // chatlogview.isHiddenLogin
  assert.deepEqual((await W.forRoom(R)).map((e) => e.display), ["ok"]);
  Q.isHidden = () => { throw new Error("set not ready"); };
  try { assert.deepEqual(await W.forRoom(R), [], "a failing hidden check leaves everyone out"); } finally { Q.isHidden = (k) => S.hidden.has(k); }
});
test("review: private room activity, 👻 ghost mode and DM blocks either way leave people out; a failed read fails closed", async () => {
  W.note(R.id, user("private"), null); W.note(R.id, user("ghost"), null); W.note(R.id, user("blocked"), null); W.note(R.id, user("blocker"), null); W.note(R.id, user("ok"), null);
  S.priv.add("id-private"); S.ghosts.add("id-ghost");
  S.blocks["id-viewer"] = ["id-blocked", "id-blocker"];       // messages.cardBlocks: blocked EITHER way with the viewer
  const me = { userId: "id-viewer", username: "viewer" };
  assert.deepEqual((await W.forRoom(R, me)).map((e) => e.display), ["ok"]);
  assert.deepEqual((await W.forRoom(R, { userId: "id-other", username: "other" })).map((e) => e.display), ["blocked", "blocker", "ok"], "blocks are the viewer's own");
  W._reset(); W.note(R.id, user("ok"), null);
  S.privFail = true;
  assert.deepEqual(await W.forRoom(R, me), [], "a private-activity read that fails counts as private");
  W._reset(); W.note(R.id, user("ok"), null); W.note(R.id, user("viewer"), null);
  S.privFail = false; S.blocksFail = true;
  assert.deepEqual((await W.forRoom(R, me)).map((e) => e.display), ["viewer"], "blocks unknown: nobody else is listed (yourself still are)");
});
test("bridge.js: only the pad page's own /live polls (?pad=1) note signed-in viewers, after the route's access checks; only the pad page's view lists them", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  const route = src.slice(src.indexOf('app.get("/api/rooms/:slug/live"'), src.indexOf("1.99ye STAGING ONLY"));
  assert.ok(route.indexOf("padaccess\").full(req.user, R.id)") < route.indexOf('require("./padweb").note('), "noted after the members-tier check");
  assert.ok(route.indexOf("bridgeOk(R.id)") < route.indexOf('require("./padweb").note('), "and after the Prime Time Plus bridge check");
  assert.match(route, /const padPage = req\.query\.pad === "1";\s*if \(signed && padPage\) require\("\.\/padweb"\)\.note\(/, "the homepage panel / owner / settings polls are not noted");
  assert.match(route, /program: !pop, padPage \}\);/);   // (1.99ajh dockpop: ?pop=1, the chat window, has no mic-stage program)
  assert.match(src, /if \(opts && opts\.padPage && userId && require\("\.\/paddock"\)\.current\(\)\.cfg\.mode !== "off"\) \{/);
  // (1.99ajh dockpop: a re-check asks once without &wait=1 - the long-poll and the re-check both carry pad=1)
  assert.match(fs.readFileSync(path.join(repo, "views/room.ejs"), "utf8"), /var wait = quick \? '' : '&wait=1'; quick = false;[\s\S]{0,600}'\?after=' \+ cursor \+ wait \+ '&pad=1'/, "the pad page asks with pad=1");
  for (const f of ["views/home.ejs", "public/js/pad-owner-mod.js", "public/js/pad-settings.js"]) assert.doesNotMatch(fs.readFileSync(path.join(repo, f), "utf8"), /pad=1/, f + " never asks to be listed");
  assert.match(fs.readFileSync(path.join(repo, "views/privacy.ejs"), "utf8"), /<% if \(locals\.padweb\) \{[^%]*%>\s*<p id="rooms-web">[\s\S]*?Incognito, or keeping your room activity private on your profile, keeps you off it[\s\S]*?<\/p><% \} %>/, "the privacy page says so while the Room Dock is on");
  assert.match(fs.readFileSync(path.join(repo, "terms.js"), "utf8"), /res\.locals\.padweb = require\("\.\/paddock"\)\.current\(\)\.cfg\.mode !== "off"/);
});
