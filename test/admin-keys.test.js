// 1.99acf /admin/keys (adminkeys.js): admins (class Admin in the database) can look, Staff are sent back to the Overview,
// members and visitors are refused; every change is owner-only (Admin + Pepe role "owner" on the linked chat login), needs a
// same-origin fetch with X-Requested-With: fetch, answers no-store and is written to admin_audit; a fresh key is in the
// mint / rotate answer only (never in the page or the JSON); the nav entry.
//   node --test test/admin-keys.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "admin-keys-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
delete process.env.CHAT_TICKET_KEY; delete process.env.CHAT_TICKET_KID;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bk = require(path.join(repo, "botkeys"));

bk._setArgon({ t: 1, m: 64, p: 1 });
require(path.join(repo, "opsalerts")).alert = async () => ({});
let base, server;
const H = (u, extra = {}) => Object.assign({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra);
const get = (p, u) => fetch(base + p, { redirect: "manual", headers: H(u) });
const post = (p, u, body, extra) => fetch(base + p, { method: "POST", redirect: "manual", headers: H(u, extra), body: JSON.stringify(body || {}) });
const audits = (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0, archived_at INTEGER)`);
  for (const [id, name, cls, cf] of [["own", "boss", "Admin", "BossFrog"], ["adm", "admin2", "Admin", "plainadmin"], ["stf", "staffer", "Staff", null], ["mem", "member", "pleb", null]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, cls, cf]);
  }
  const SR = require(path.join(repo, "staffroles"));
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('bossfrog', 'owner', 1), ('plainadmin', 'admin', 1)");
  await require(path.join(repo, "adminaudit")).init();
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  require(path.join(repo, "adminkeys")).register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("who sees it: admins (the page + JSON); Staff back to the Overview; members and visitors refused", async () => {
  let r = await get("/admin/keys", "");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login/);
  r = await get("/admin/keys", "stf");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/admin");
  assert.match((await get("/admin/keys", "mem")).headers.get("location"), /^\/login/);
  r = await get("/admin/keys", "adm");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const html = await r.text();
  assert.match(html, /Bot keys &amp; chat seam|Bot keys & chat seam/);
  assert.match(html, /href="\/admin\/keys"/, "in the admin nav");
  for (const id of ["keys", "scopes", "families", "legacy", "routes", "events", "seam"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="akNotOwner"/, "a plain admin is told only owners change things");
  assert.equal((await get("/api/admin/keys", "stf")).status, 403);
  assert.equal((await get("/api/admin/keys", "")).status, 401);
  const j = await (await get("/api/admin/keys", "adm")).json();
  assert.equal(j.ok, true);
  assert.equal(j.owner, false);
  assert.ok(j.seam && j.seam.tickets && j.seam.outbox && j.seam.spans);
  assert.equal((await (await get("/api/admin/keys", "own")).json()).owner, true);
});

test("changes are owner-only and same-origin fetches", async () => {
  let r = await post("/api/admin/keys/mint", "adm", { caller: "pepe" });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "owner_only", "an Admin without the owner role");
  assert.equal((await post("/api/admin/keys/mint", "stf", { caller: "pepe" })).status, 403);
  assert.equal((await post("/api/admin/keys/mint", "", { caller: "pepe" })).status, 401);
  r = await post("/api/admin/keys/mint", "own", { caller: "pepe" }, { "x-requested-with": "" });
  assert.equal(r.status, 403, "no X-Requested-With");
  r = await post("/api/admin/keys/mint", "own", { caller: "pepe" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403, "a foreign origin");
  assert.equal((await audits("botkeys.mint")).length, 0, "nothing happened");
});

test("an owner mints, rotates, sets scopes / mode, grants, flips a family and the settings - each audited; the key shows only in its answer", async () => {
  let r = await post("/api/admin/keys/mint", "own", { caller: "pepe", label: "Pepe VM" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const m = await r.json();
  assert.match(m.key, /^pepe\.[A-Za-z0-9_-]{43}$/);
  const secret = m.key.split(".")[1];
  r = await post("/api/admin/keys/mint", "own", { caller: "pepe" });
  assert.equal((await r.json()).code, "exists");
  assert.equal((await (await post("/api/admin/keys/mint", "own", { caller: "Bad!" })).json()).code, "bad_caller");
  const page = await (await get("/admin/keys", "own")).text();
  const json = await (await get("/api/admin/keys", "own")).text();
  const row = (await getQuery("SELECT hash, tag FROM bot_keys WHERE caller = 'pepe'"))[0];
  for (const s of [secret, row.hash, row.tag]) {
    assert.ok(!page.includes(s), "the page never holds a secret / hash / tag");
    assert.ok(!json.includes(s), "the JSON never holds a secret / hash / tag");
  }
  assert.ok(!/id="akNotOwner"/.test(page), "an owner gets the controls");
  const rot = await (await post("/api/admin/keys/rotate", "own", { caller: "pepe", grace_h: 6 })).json();
  assert.ok(rot.ok && rot.key !== m.key && rot.prev_until > Date.now());
  let res = await (await post("/api/admin/keys/mode", "own", { caller: "pepe", mode: "enforce", scopes: ["/api/bridge"] })).json();
  assert.equal(res.code, "too_early");
  res = await (await post("/api/admin/keys/mode", "own", { caller: "pepe", mode: "enforce", scopes: ["/api/bridge"], early: true })).json();
  assert.equal(res.ok, true);
  assert.equal((await (await post("/api/admin/keys/grant", "own", { caller: "pepe", family: "/api/pepe" })).json()).ok, true);
  assert.deepEqual(JSON.parse((await getQuery("SELECT scopes FROM bot_keys WHERE caller = 'pepe'"))[0].scopes), ["/api/bridge", "/api/pepe"]);
  assert.equal((await (await post("/api/admin/keys/family", "own", { family: "/api/bridge", legacy_enforce: true })).json()).legacy_enforce, true);
  assert.equal((await (await post("/api/admin/keys/settings", "own", { bad_key: "refuse", events: "enforce" })).json()).settings.events, "enforce");
  // R-11 review (SEC-1): the VM's old GET claim of /api/pepe/control/pending - allowed until an owner refuses it
  assert.equal((await (await get("/api/admin/keys", "own")).json()).settings.control_get, "allow", "the GET claim is allowed by default");
  assert.equal((await (await post("/api/admin/keys/settings", "own", { control_get: "refuse" })).json()).settings.control_get, "refuse");
  assert.equal((await (await post("/api/admin/keys/settings", "own", { control_get: "nonsense" })).json()).settings.control_get, "allow", "anything else is allow");
  // tickets only together with the revocation feed and the heartbeat (a signed-out session has to reach the hub)
  const lone = await post("/api/admin/hubseam/settings", "own", { tickets: true });
  assert.equal(lone.status, 409);
  assert.equal((await lone.json()).code, "tickets_need");
  assert.equal((await (await post("/api/admin/hubseam/settings", "own", { tickets: true, sessions: true, heartbeat: true, spans: false })).json()).settings.tickets, true);
  assert.equal((await (await post("/api/admin/hubseam/settings", "own", { sessions: false })).json()).code, "tickets_need", "...and sessions can't go off under it");
  assert.equal((await (await post("/api/admin/keys/revoke", "own", { caller: "pepe", reason: "x" })).json()).code, "reason");
  assert.equal((await (await post("/api/admin/keys/revoke", "own", { caller: "pepe", reason: "test over" })).json()).ok, true);
  for (const a of ["botkeys.mint", "botkeys.rotate", "botkeys.mode", "botkeys.grant", "botkeys.family", "botkeys.settings", "hubseam.settings", "botkeys.revoke"]) {
    const rows = await audits(a);
    assert.ok(rows.length >= 1, a + " audited");
    assert.equal(rows[0].admin_name, "boss");
    assert.ok(!String(rows[0].detail || "").includes(secret));
  }
  const after = await (await get("/api/admin/keys", "own")).json();
  const k = after.keys.find((x) => x.caller === "pepe");
  assert.ok(k.revoked_at && k.revoked_by === "boss" && k.revoked_why === "test over");
  assert.ok(!("hash" in k) && !("tag" in k) && !("prev_hash" in k));
  await post("/api/admin/keys/settings", "own", { bad_key: "fallback", events: "observe" });
});

test("1.99add: an owner un-hides one chat login in Pepe's sticky hidden set - audited with the hash only; everyone else is refused", async () => {
  const HH = require(path.join(repo, "hubhidden"));
  const sh = HH.hash("shycf");
  await HH.note([sh]);
  const j = await (await get("/api/admin/keys", "adm")).json();
  assert.deepEqual(Object.keys(j.seam.hidden).sort(), ["absent_once", "anonymised", "back", "booted", "bridge", "clock_s", "dup", "full", "held", "held_batches", "incognito",
                                                       "kept", "late", "left_out", "older_unhid", "pepe", "released", "resolved", "size", "stale", "stored", "unknown",
                                                       "untimed", "web"],
                   "sizes, counts per kind and held batch ids only, never a hash");
  assert.ok(Object.entries(j.seam.hidden).every(([k, v]) => k === "held_batches" ? Array.isArray(v)
    : v === null || typeof v === "number" || typeof v === "boolean" || v === "older" || v === "explicit" || v === "kinded"));
  assert.deepEqual([j.seam.hidden.unknown, j.seam.hidden.left_out], [1, 1], "an older Pepe's list: kind not known - left out");
  assert.ok(!JSON.stringify(j.seam.hidden).includes(sh));
  assert.match(await (await get("/admin/keys", "adm")).text(), /id="akUnhide"/);
  let r = await post("/api/admin/hubseam/unhide", "adm", { login: "shycf", reason: "testing" });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "owner_only", "an Admin without the owner role");
  assert.equal((await post("/api/admin/hubseam/unhide", "own", { login: "shycf", reason: "testing" }, { origin: "https://evil.example" })).status, 403, "a foreign origin");
  assert.equal((await (await post("/api/admin/hubseam/unhide", "own", { login: "shycf" })).json()).code, "reason");
  assert.equal((await (await post("/api/admin/hubseam/unhide", "own", { h: "zz", reason: "testing" })).json()).code, "bad_key");
  assert.equal(HH.isHiddenHash(sh), true, "nothing changed yet");
  assert.equal((await audits("hubseam.unhide")).length, 0);
  r = await post("/api/admin/hubseam/unhide", "own", { login: "ShyCF", reason: "!bridge show on an older Pepe" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const d = await r.json();
  assert.deepEqual([d.ok, d.h, d.was_hidden, d.held], [true, sh, true, null]);
  assert.equal(HH.isHiddenHash(sh), false);
  const a = await audits("hubseam.unhide");
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_name, "boss");
  assert.deepEqual(JSON.parse(a[0].detail), { h: sh, kind: "all", was_hidden: true, kinds: ["unknown"] });
  // refix 4: one kind at a time - incognito only leaves !bridge hide in place (and says so)
  await HH.noteSync({ list: [sh], bridge: [sh], incog: [sh] });
  assert.equal((await (await post("/api/admin/hubseam/unhide", "own", { login: "shycf", kind: "nope", reason: "testing" })).json()).code, "bad_kind");
  const k = await (await post("/api/admin/hubseam/unhide", "own", { login: "shycf", kind: "incognito", reason: "she turned it off in chat" })).json();
  assert.deepEqual([k.ok, k.kind, k.was_hidden, k.kinds, k.still], [true, "incognito", true, ["bridge", "incognito"], ["bridge"]]);
  assert.deepEqual([HH.isHiddenHash(sh), HH.isLeftOutHash(sh)], [true, true], "still on !bridge hide: left out");
});

test("1.99add refix: an owner decides a held batch of the hidden set (approve = un-hide them) - listed on the page by id and count only, audited, everyone else refused", async () => {
  const HH = require(path.join(repo, "hubhidden"));
  const [x, y] = [HH.hash("xcf"), HH.hash("ycf")];
  const t = Date.now() - 60000;
  await HH.noteSync({ list: [x, y], session: "k1", sent: new Date(t).toISOString() });
  await HH.noteSync({ list: [y], session: "k2", sent: new Date(t + 1500).toISOString() });   // an older Pepe restarted: x is missing
  const j = await (await get("/api/admin/keys", "adm")).json();
  assert.equal(j.seam.hidden.held_batches.length, 1);
  const b = j.seam.hidden.held_batches[0];
  assert.deepEqual([b.kind, b.n, Object.keys(b).sort()], ["restart", 1, ["at", "id", "kind", "n", "other"]]);
  const html = await (await get("/admin/keys", "adm")).text();
  assert.match(html, /id="akHeld"/);
  assert.match(html, new RegExp(`data-held="${b.id}"`));
  assert.ok(!html.includes(x) && !html.includes(y), "never a hash on the page");
  let r = await post("/api/admin/hubseam/held", "adm", { id: b.id, approve: true, reason: "testing" });
  assert.equal((await r.json()).code, "owner_only");
  assert.equal((await post("/api/admin/hubseam/held", "own", { id: b.id, approve: true, reason: "testing" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await (await post("/api/admin/hubseam/held", "own", { id: b.id, approve: true })).json()).code, "reason");
  assert.equal((await (await post("/api/admin/hubseam/held", "own", { id: "zz", approve: true, reason: "testing" })).json()).code, "not_found");
  assert.equal(HH.isHiddenHash(x), true, "nothing changed yet");
  assert.equal((await audits("hubseam.held")).length, 0);
  r = await post("/api/admin/hubseam/held", "own", { id: b.id, approve: true, reason: "x typed !bridge show before Pepe restarted" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { ok: true, id: b.id, approved: true, removed: 1, still_hidden: 0 });
  assert.equal(HH.isHiddenHash(x), false);
  assert.equal(HH.isHiddenHash(y), true);
  const a = await audits("hubseam.held");
  assert.equal(a.length, 1);
  assert.deepEqual(JSON.parse(a[0].detail), { id: b.id, kind: "restart", n: 1, approve: true });
  assert.equal((await (await post("/api/admin/hubseam/held", "own", { id: b.id, approve: false, reason: "again" })).json()).code, "decided");
});

test("1.99add refix 3: an owner looks a chat login up in the hidden set (kinds, held in which batch, missing once) - changes nothing, audited with the hash only (refix 4), owner-only and same-origin", async () => {
  const HH = require(path.join(repo, "hubhidden"));
  const [x, y] = [HH.hash("chkxcf"), HH.hash("chkycf")];
  const t = Date.now() - 30000;
  await HH.noteSync({ list: [x, y], session: "c1", sent: new Date(t).toISOString() });
  await HH.noteSync({ list: [y], session: "c2", sent: new Date(t + 1500).toISOString() });   // an older Pepe restarted: x is missing
  const b = (await (await get("/api/admin/keys", "adm")).json()).seam.hidden.held_batches.find((z) => z.n === 1 && z.kind === "restart");
  const n0 = (await audits("hubseam.check")).length + (await audits("hubseam.unhide")).length;
  let r = await post("/api/admin/hubseam/check", "adm", { login: "chkxcf" });
  assert.equal((await r.json()).code, "owner_only", "an Admin without the owner role");
  assert.equal((await post("/api/admin/hubseam/check", "own", { login: "chkxcf" }, { origin: "https://evil.example" })).status, 403, "a foreign origin");
  assert.equal((await (await post("/api/admin/hubseam/check", "own", { h: "zz" })).json()).code, "bad_key");
  r = await post("/api/admin/hubseam/check", "own", { login: "ChkXCF" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const d = await r.json();
  assert.deepEqual([d.ok, d.h, d.hidden, d.left_out, d.kinds, d.absent_once, d.held && d.held.kind, d.held && d.held.id],
                   [true, x, true, true, [{ kind: "unknown", src: "pepe" }], false, "restart", b.id]);
  assert.deepEqual((await (await post("/api/admin/hubseam/check", "own", { h: y })).json()).held, null);
  assert.equal((await (await post("/api/admin/hubseam/check", "own", { login: "nobodyatall" })).json()).hidden, false);
  const ck = await audits("hubseam.check");
  assert.equal(ck.length + (await audits("hubseam.unhide")).length, n0 + 3, "every look-up leaves a trace (incognito hides WHO)");
  assert.deepEqual(JSON.parse(ck[ck.length - 1].detail), { h: HH.hash("nobodyatall") }, "the hash only - never the login, nor the answer");
  assert.equal(HH.isHiddenHash(x), true, "...and changes nothing");
});

test("the nav entry and the page's own script", () => {
  const nav = fs.readFileSync(path.join(repo, "views", "partials", "admin-nav.ejs"), "utf8");
  assert.match(nav, /\['keys', '\/admin\/keys', '🔑', 'Bot keys & chat seam'/);
  for (const a of ["#keys", "#scopes", "#families", "#legacy", "#routes", "#events", "#seam"]) assert.ok(nav.includes(`['${a}'`), a);
  const view = fs.readFileSync(path.join(repo, "views", "admin", "keys.ejs"), "utf8");
  assert.match(view, /\/public\/js\/admin-keys\.js\?v=\d+/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-keys.js"), "utf8");
  assert.ok(!/localStorage|sessionStorage|console\.log/.test(js), "a fresh key is never stored or logged by the page");
  assert.ok(view.includes('id="akCtlGet"') && js.includes("body.control_get = $('akCtlGet').value"), "the GET-claim switch is on the page and the script sends it");
  assert.ok(view.includes('id="akUnhide"') && js.includes("post('/api/admin/hubseam/unhide', body)"), "1.99add: the un-hide form is on the page and the script sends it");
  assert.ok(js.includes("var body = isHash ? { h: key.slice(1).toLowerCase(), kind: kind, reason: why } : { login: key, kind: kind, reason: why };"),
            "1.99add refix: only '#<20 hex>' is sent as a hash - a 20-hex chat login is a login; refix 4: with the kind");
  assert.ok(view.includes('id="akUnhideKind"') && view.includes("'admkeys.seam.held_legacy'"), "refix 4: the kind picker and the legacy batches");
  assert.ok(view.includes('id="akHeld"') && js.includes("post('/api/admin/hubseam/held', { id: id, approve: approve, reason: why })"), "the held batches and their buttons");
  assert.ok(view.includes('id="akCheck"') && js.includes("post('/api/admin/hubseam/check', body)") && view.includes("'admkeys.seam.held_order'"),
            "1.99add refix 3: the Check button, and the out-of-order kind");
});
