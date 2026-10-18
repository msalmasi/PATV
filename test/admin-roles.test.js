// 1.99acj /admin/roles (adminroles.js, pepeperms.js, staffroles.js): who sees it (site Admins; Staff back to the Overview),
// every change decided by the editor's PEPE role with Pepe's !role / !perm rules (owner vs admin limits, owner-only powers,
// room-role commands, moderation floors and their bounds, never an entry an owner set), same-origin fetch only, audited;
// Pepe's sync carrying the per-command entries + his code defaults (newer wins per entry, tombstones, junk ignored) and
// mixed versions (an old Pepe gets the answer he always got; nothing to edit until Pepe synced his defaults).
//   node --test test/admin-roles.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "admin-roles-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const PP = require(path.join(repo, "pepeperms"));
let T = 1_900_000_000_000;
PP._setClock(() => T);
require(path.join(repo, "staffroles"))._setClock(() => T);

let base, server;
const H = (u, extra = {}) => Object.assign({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra);
const get = (p, u) => fetch(base + p, { redirect: "manual", headers: H(u) });
const post = (p, u, body, extra) => fetch(base + p, { method: "POST", redirect: "manual", headers: H(u, extra), body: JSON.stringify(body || {}) });
const pj = async (p, u, body, extra) => { const r = await post(p, u, body, extra); return { status: r.status, j: await r.json() }; };
const perm = (u, body) => pj("/api/admin/roles/perm", u, body);
const role = (u, login, r) => pj("/api/admin/roles/role", u, { login, role: r });
const bot = async (body) => (await fetch(base + "/api/pepe/roles/bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", ...body }) })).json();
const audits = (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);
const entry = async (key) => (await PP.entries())[key];

// Pepe 1.99aci's acl_defaults (pepe_acl._acl_sync_defaults) - the shape he sends with every sync
const DEFAULTS = {
  v: 1, levels: { owner: 100, admin: 80, staff: 50, assistant: 35, trusted: 20, everyone: 0 },
  roles: ["owner", "admin", "staff", "assistant", "trusted"], grant_roles: ["owner", "admin", "staff", "assistant", "trusted"],
  default_grants: { "!djban": "staff", "!onair": "staff", "!costume": "assistant", "!trivia": "assistant" },
  owner_only: ["!backend-switch", "!econ", "!reserve", "!update"], admin_only: ["!admin", "!friend", "!mod", "!unrole"], backend_subs: ["backend", "backends"],
  mod_rules: { "!kick": { staff: "admin", assistant: "nobody" }, "!timeout": { staff: "admin", assistant: "nobody" },
               "!blockmic": { staff: "anyone", assistant: "nobody" }, "!unblockmic": { staff: "anyone", assistant: "anyone" },
               "!friend": { staff: "admin", assistant: "staff" }, "!mod": { staff: "admin", assistant: "nobody" } },
  mod_roles: ["staff", "assistant"], mod_floors: ["nobody", "assistant", "staff", "admin", "anyone"],
  mod_floor_max: { staff: "admin", assistant: "staff" }, mod_cf_ceiling: { staff: 2, assistant: 1 },
};
const ROLES = { bossfrog: ["owner", 1], plainadmin: ["admin", 1], staffer_cf: ["staff", 1], helper_cf: ["assistant", 1], second_owner: ["owner", 1] };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["own", "boss", "Admin", "BossFrog"], ["adm", "admin2", "Admin", "plainadmin"], ["stf", "staffer", "Staff", "staffer_cf"],
                                     ["mem", "member", "pleb", null], ["nolink", "adminnolink", "Admin", null], ["norole", "adminnorole", "Admin", "nobody_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, cls, cf]);
  }
  await require(path.join(repo, "adminaudit")).init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  require(path.join(repo, "staffroles")).register(app, { isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "adminroles")).register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  // an OLD Pepe's sync first: roles only
  const r = await bot({ roles: ROLES });
  assert.equal(r.ok, true);
  assert.equal(r.perms, undefined, "an old Pepe's answer carries no perms");
});
test.after(() => server && server.close());

test("who sees it: site Admins (page + JSON); Staff back to the Overview; members and visitors refused; the nav entry", async () => {
  let r = await get("/admin/roles", "");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login/);
  r = await get("/admin/roles", "stf");
  assert.equal(r.headers.get("location"), "/admin");
  assert.match((await get("/admin/roles", "mem")).headers.get("location"), /^\/login/);
  r = await get("/admin/roles", "adm");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const html = await r.text();
  assert.match(html, /href="\/admin\/roles"/, "in the admin nav");
  for (const id of ["holders", "commands", "targets", "notes", "website", "chat"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="arNotSynced"/, "Pepe hasn't synced his permission table yet");
  assert.match(html, /data-site-perm="admin\.area"/, "the website permissions (1.99ack, release 2)");
  for (const c of ["!roles", "!role &lt;user&gt; &lt;owner|admin|staff|assistant|trusted|none&gt;", "!perm &lt;!cmd&gt; powers &lt;role|default&gt;",
                   "!perm &lt;!cmd&gt; use &lt;role|everyone|default&gt;", "!perm &lt;!cmd&gt; targets &lt;staff|assistant&gt;"]) {
    assert.ok(html.includes(c), "chat command listed: " + c);
  }
  assert.equal((await get("/api/admin/roles", "stf")).status, 403);
  assert.equal((await get("/api/admin/roles", "")).status, 401);
  const j = await (await get("/api/admin/roles", "adm")).json();
  assert.equal(j.ok, true);
  assert.equal(j.synced, false);
  assert.equal(j.editor.admin, true);
  assert.equal(j.editor.owner, false);
  assert.ok(j.holders.some((h) => h.login === "bossfrog" && h.role === "owner"));
  assert.equal((await (await get("/api/admin/roles", "own")).json()).editor.owner, true);
});

test("before Pepe's defaults arrive: permission edits wait (409), role edits already work", async () => {
  const r = await perm("own", { kind: "powers", cmd: "!costume", value: "staff" });
  assert.equal(r.status, 409);
  assert.equal(r.j.code, "not_synced");
  assert.equal((await pj("/api/admin/roles/reset", "own", { cmd: "!costume" })).status, 409);
  const r2 = await role("adm", "early_bird", "trusted");
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
});

test("Pepe 1.99aci's sync: defaults stored, his entries merged, the merged map answered", async () => {
  T += 1000;
  const r = await bot({ roles: ROLES, perms: { v: 1, entries: { "powers:!vol": ["staff", T - 500, "bossfrog"], "use:!video": [null, T - 400, "bossfrog"],
                                                               "powers:!econ": ["admin", T, "x"], "targets:!kick:assistant": ["admin", T, "x"], "junk": ["staff", T] } },
                        acl_defaults: DEFAULTS });
  assert.equal(r.ok, true);
  assert.ok(r.roles.bossfrog, "the roles answer is unchanged");
  assert.deepEqual(r.perms.entries["powers:!vol"].slice(0, 2), ["staff", T - 500]);
  assert.deepEqual(r.perms.entries["use:!video"].slice(0, 2), [null, T - 400], "a tombstone travels");
  assert.equal(r.perms.entries["powers:!econ"], undefined, "an owner power's grant is never kept");
  assert.equal(r.perms.entries["targets:!kick:assistant"], undefined, "an out-of-bounds floor is never kept");
  assert.equal(r.perms.entries.junk, undefined);
  assert.equal((await entry("powers:!vol")).via, "chat");
  const html = await (await get("/admin/roles", "adm")).text();
  assert.doesNotMatch(html, /id="arNotSynced"/);
  assert.match(html, /id="arSynced"/);
});

test("the default view matches Pepe's code defaults (prod today: no overrides)", async () => {
  const j = await (await get("/api/admin/roles", "adm")).json();
  const row = (c) => j.commands.find((x) => x.cmd === c);
  assert.equal(row("!onair").powers.eff, "staff");
  assert.equal(row("!onair").powers.over, null);
  assert.deepEqual(row("!onair").ladder.map((l) => l.powers), [true, true, true, false, false], "owner/admin/staff get !onair powers");
  assert.deepEqual(row("!onair").ladder.map((l) => l.use), [true, true, true, true, true]);
  assert.equal(row("!costume").powers.eff, "assistant");
  assert.equal(row("!econ").lock, "owner");
  assert.equal(row("!econ").powers.eff, "owner");
  assert.equal(row("!friend").lock, "room");
  assert.equal(row("!kick").powers.eff, "admin", "a MOD_RULES command is listed with its default admin powers");
  assert.ok(row("!vol"), "a command with an override is listed");
  const tg = j.targets.find((x) => x.cmd === "!blockmic");
  assert.deepEqual(tg.roles.map((r) => [r.role, r.eff]), [["staff", "anyone"], ["assistant", "nobody"]]);
  assert.deepEqual(j.targets.find((x) => x.cmd === "!friend").roles.map((r) => r.eff), ["admin", "staff"]);
  // the assistant column never offers "below admin" (out of bounds)
  const kickA = j.targets.find((x) => x.cmd === "!kick").roles.find((r) => r.role === "assistant");
  assert.equal(kickA.options.find((o) => o.v === "admin").inBounds, false);
  assert.equal(kickA.options.find((o) => o.v === "anyone").ok, false, "an admin can't choose anyone");
});

test("command permissions: Pepe's !perm rules, owner vs admin", async () => {
  T += 1000;
  let r = await perm("adm", { kind: "powers", cmd: "costume", value: "staff" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal((await entry("powers:!costume")).val, "staff");
  assert.equal((await entry("powers:!costume")).by, "web:admin2");
  const a = await audits("pepe_perm");
  assert.deepEqual(JSON.parse(a[a.length - 1].detail), { key: "powers:!costume", from: null, to: "staff", editor_role: "admin" });
  r = await perm("adm", { kind: "use", cmd: "!video", value: "owner" });
  assert.equal(r.status, 403, "an admin can't make a command owner-only");
  assert.equal(r.j.code, "owner_only");
  r = await perm("adm", { kind: "powers", cmd: "!djban", value: "owner" });
  assert.equal(r.status, 403, "...nor its powers");
  r = await perm("own", { kind: "use", cmd: "!video", value: "owner" });
  assert.equal(r.status, 200);
  for (const v of ["everyone", "admin", "default"]) {
    r = await perm("adm", { kind: "use", cmd: "!video", value: v });
    assert.equal(r.status, 403, "an admin can't change what an owner set: " + v);
  }
  r = await pj("/api/admin/roles/reset", "adm", { cmd: "!video" });
  assert.equal(r.status, 403, "...nor reset it");
  for (const u of ["own", "adm"]) {
    r = await perm(u, { kind: "powers", cmd: "!econ", value: "admin" });
    assert.equal(r.status, 400, "owner powers never move (" + u + ")");
    r = await perm(u, { kind: "powers", cmd: "!friend", value: "staff" });
    assert.equal(r.status, 400, "room-role powers never go to staff (" + u + ")");
  }
  r = await perm("own", { kind: "powers", cmd: "!friend", value: "owner" });
  assert.equal(r.status, 200, "an owner may raise a room-role command to owner-only");
  r = await perm("adm", { kind: "powers", cmd: "!friend", value: "admin" });
  assert.equal(r.status, 403);
  r = await perm("adm", { kind: "use", cmd: "!x<script>", value: "staff" });
  assert.equal(r.status, 400, "a command name is checked");
  r = await perm("adm", { kind: "use", cmd: "!vid", value: "god" });
  assert.equal(r.status, 400);
  r = await perm("adm", { kind: "sudo", cmd: "!vid", value: "staff" });
  assert.equal(r.status, 400);
  r = await pj("/api/admin/roles/reset", "own", { cmd: "!video" });
  assert.equal(r.status, 200);
  assert.equal((await entry("use:!video")).val, null, "a reset is a tombstone");
});

test("moderation targets: bounds, admins can't choose anyone / widen a room-role command / change an owner's choice", async () => {
  T += 1000;
  let r = await perm("adm", { kind: "targets", cmd: "!kick", role: "staff", value: "staff" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await perm("adm", { kind: "targets", cmd: "!kick", role: "staff", value: "anyone" });
  assert.equal(r.status, 403);
  r = await perm("own", { kind: "targets", cmd: "!kick", role: "assistant", value: "admin" });
  assert.equal(r.status, 400, "assistants never act on staff - not even an owner sets that");
  r = await perm("adm", { kind: "targets", cmd: "!mod", role: "assistant", value: "assistant" });
  assert.equal(r.status, 403, "an admin can't give assistants a room-role command");
  r = await perm("adm", { kind: "targets", cmd: "!friend", role: "assistant", value: "assistant" });
  assert.equal(r.status, 200, "narrowing one is fine");
  r = await perm("adm", { kind: "targets", cmd: "!ban", role: "staff", value: "staff" });
  assert.equal(r.status, 400, "only Pepe's moderation commands have floors");
  r = await perm("adm", { kind: "targets", cmd: "!kick", role: "admin", value: "staff" });
  assert.equal(r.status, 400, "admins / owners aren't covered");
  r = await perm("own", { kind: "targets", cmd: "!timeout", role: "staff", value: "anyone" });
  assert.equal(r.status, 200);
  r = await perm("adm", { kind: "targets", cmd: "!timeout", role: "staff", value: "admin" });
  assert.equal(r.status, 403, "an admin can't change an owner's 'anyone'");
  r = await pj("/api/admin/roles/reset", "adm", { cmd: "!timeout" });
  assert.equal(r.status, 403, "reset is all-or-nothing");
  r = await pj("/api/admin/roles/reset", "adm", { cmd: "!kick" });
  assert.equal(r.status, 200);
  assert.equal((await entry("targets:!kick:staff")).val, null);
});

test("role holders: Pepe's !role rules on the website, audited", async () => {
  T += 1000;
  let r = await role("adm", "plainadmin", "owner");
  assert.equal(r.status, 403, "an admin can't make themselves owner");
  r = await role("adm", "someone", "owner");
  assert.equal(r.status, 403);
  r = await role("adm", "someone", "admin");
  assert.equal(r.status, 403, "admins don't make admins");
  r = await role("adm", "bossfrog", "trusted");
  assert.equal(r.status, 403, "an admin can't demote an owner");
  r = await role("adm", "newbie_cf", "staff");
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const a = await audits("pepe_role");
  assert.deepEqual(JSON.parse(a[a.length - 1].detail), { login: "newbie_cf", from: null, to: "staff", editor_role: "admin" });
  r = await role("adm", "newbie_cf", "none");
  assert.equal(r.status, 200);
  r = await role("own", "plainadmin", "staff");
  assert.equal(r.status, 200, "an owner changes an admin");
  r = await role("own", "plainadmin", "admin");
  assert.equal(r.status, 200);
  r = await role("own", "second_owner", "none");
  assert.equal(r.status, 200);
  r = await role("own", "bossfrog", "none");
  assert.equal(r.status, 409, "Pepe always keeps an owner");
  r = await role("own", "bad login!", "staff");
  assert.equal(r.status, 400);
});

test("who may edit at all: Staff, an Admin without a linked login, an Admin whose login has no Pepe role", async () => {
  for (const [u, code] of [["stf", "admin_only"], ["nolink", "not_pepe_admin"], ["norole", "not_pepe_admin"], ["mem", "admin_only"]]) {
    const r = await perm(u, { kind: "use", cmd: "!video", value: "staff" });
    assert.equal(r.status, 403, u);
    assert.equal(r.j.code, code, u);
    const r2 = await role(u, "x_cf", "trusted");
    assert.equal(r2.status, 403, u);
    const r3 = await pj("/api/admin/roles/reset", u, { cmd: "!vol" });
    assert.equal(r3.status, 403, u);
  }
  assert.equal((await perm("", { kind: "use", cmd: "!video", value: "staff" })).status, 401);
  const html = await (await get("/admin/roles", "nolink")).text();
  assert.match(html, /id="arReadOnly"/, "read-only note");
});

test("CSRF: a change needs X-Requested-With: fetch from this origin", async () => {
  let r = await post("/api/admin/roles/perm", "own", { kind: "use", cmd: "!video", value: "staff" }, { "x-requested-with": "" });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "cross_site");
  r = await post("/api/admin/roles/role", "own", { login: "x_cf", role: "admin" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/admin/roles/reset", { method: "POST", headers: { "x-user": "own", "content-type": "application/json", "x-requested-with": "fetch" }, body: "{}" });
  assert.equal(r.status, 403, "no origin / referer at all");
});

test("sync semantics: a web change reaches Pepe; newer wins per entry both ways; old Pepe untouched", async () => {
  T += 1000;
  let r = await perm("own", { kind: "use", cmd: "!snap", value: "trusted" });
  assert.equal(r.status, 200);
  const webTs = (await entry("use:!snap")).ts;
  // Pepe's next sync doesn't have it yet: the answer carries it
  let s = await bot({ roles: ROLES, perms: { v: 1, entries: { "powers:!vol": ["staff", 1, null] } }, acl_defaults: DEFAULTS });
  assert.deepEqual(s.perms.entries["use:!snap"].slice(0, 2), ["trusted", webTs]);
  assert.equal(s.perms.entries["powers:!vol"][0], "staff", "an older entry from Pepe doesn't overwrite a newer one here");
  // an older chat value for the same entry loses; a newer one wins
  s = await bot({ roles: ROLES, perms: { v: 1, entries: { "use:!snap": ["admin", webTs - 1, "plainadmin"] } }, acl_defaults: DEFAULTS });
  assert.equal(s.perms.entries["use:!snap"][0], "trusted");
  T += 1000;
  s = await bot({ roles: ROLES, perms: { v: 1, entries: { "use:!snap": [null, T, "bossfrog"] } }, acl_defaults: DEFAULTS });
  assert.equal(s.perms.entries["use:!snap"][0], null, "a newer reset made in chat wins");
  assert.equal((await entry("use:!snap")).by, "pepe:bossfrog");
  // an old Pepe (roles only) changes nothing and gets no perms
  const before = await PP.entries();
  s = await bot({ roles: ROLES });
  assert.equal(s.perms, undefined);
  assert.deepEqual(await PP.entries(), before);
  // a bad defaults blob is ignored (the stored one stays)
  s = await bot({ roles: ROLES, acl_defaults: { v: 99 } });
  assert.ok(await PP.defaults(), "defaults kept");
  // a bot request without the token is refused
  const bad = await fetch(base + "/api/pepe/roles/bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope", perms: { entries: {} } }) });
  assert.equal(bad.status, 403);
});

test("a race: an admin's web change over an owner-only value made in chat that hadn't synced yet - the owner's value stands", async () => {
  T += 1000;
  const ownerTs = T - 300;                       // the owner's !perm in chat, a moment before the admin's web edit
  let r = await perm("adm", { kind: "use", cmd: "!clipit", value: "staff" });
  assert.equal(r.status, 200, "the admin saw no owner value - allowed");
  const webTs = (await entry("use:!clipit")).ts;
  assert.equal((await entry("use:!clipit")).lvl, 80, "a web change carries the editor's Pepe level");
  let s = await bot({ roles: ROLES, perms: { v: 1, entries: { "use:!clipit": ["owner", ownerTs, "bossfrog", 100] } }, acl_defaults: DEFAULTS });
  assert.deepEqual(s.perms.entries["use:!clipit"], ["owner", webTs + 1, "pepe:bossfrog", 100], "the owner's value, re-stamped after the admin's");
  assert.equal((await entry("use:!clipit")).val, "owner");
  // the other way round: the admin's chat change raced an owner's web change
  T += 1000;
  r = await perm("own", { kind: "targets", cmd: "!kick", role: "staff", value: "anyone" });
  assert.equal(r.status, 200);
  const oTs = (await entry("targets:!kick:staff")).ts;
  s = await bot({ roles: ROLES, perms: { v: 1, entries: { "targets:!kick:staff": ["staff", oTs + 5, "plainadmin", 80] } }, acl_defaults: DEFAULTS });
  assert.equal(s.perms.entries["targets:!kick:staff"][0], "anyone");
  assert.equal(s.perms.entries["targets:!kick:staff"][1], oTs + 6);
  // an owner's newer change from chat wins as usual; so does an admin's over an admin-reachable value
  s = await bot({ roles: ROLES, perms: { v: 1, entries: { "targets:!kick:staff": ["admin", oTs + 50, "bossfrog", 100] } }, acl_defaults: DEFAULTS });
  assert.equal(s.perms.entries["targets:!kick:staff"][0], "admin");
  s = await bot({ roles: ROLES, perms: { v: 1, entries: { "targets:!kick:staff": ["staff", oTs + 60, "plainadmin", 80] } }, acl_defaults: DEFAULTS });
  assert.equal(s.perms.entries["targets:!kick:staff"][0], "staff");
});

test("the page script builds no HTML and posts same-origin with X-Requested-With", () => {
  const js = fs.readFileSync(path.join(repo, "public/js/admin-roles.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /'X-Requested-With': 'fetch'/);
  assert.match(js, /credentials: 'same-origin'/);
  const ejs = fs.readFileSync(path.join(repo, "views/admin/roles.ejs"), "utf8");
  assert.doesNotMatch(ejs.replace(/<%-\s*(t\(|include\(|RN\(|FL\(|o\.ok|r\.over|c\.\w+\.over|off|dis|!canEdit|r !== h\.role|r === 'owner'|l\.)/g, ""), /<%-/, "raw output only for translated strings / static attributes");
});
