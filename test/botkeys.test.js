// 1.99acf botkeys.js (R-11): per-caller bot keys. The X-PATV-Key middleware (argon2id behind a SHA-256 tag prefilter and a
// cache), observe (every route allowed, (caller, method, route, family) logged at the end of the request - public routes
// too), enforce (out-of-scope -> 403 {error:"scope"} before the handler, an ops alert), the legacy tokens (counted once per
// request with a caller hint; DISCORD_BOT_TOKEN as token=discord; a family's legacy-enforce switch), unresolvable keys
// (fallback / refuse), rotation grace, revoke, the kill switch, the request context ending at finish, whoami, and that no
// secret, hash or tag ever leaks into a read or the console.
//   node --test test/botkeys.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "botkeys-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "shared-token-for-tests";
process.env.DISCORD_BOT_TOKEN = "discord-token-for-tests";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bk = require(path.join(repo, "botkeys"));
const opsalerts = require(path.join(repo, "opsalerts"));

bk._setArgon({ t: 1, m: 64, p: 1 });               // fast for tests (the PHC string carries the parameters)
const alerts = [];
opsalerts.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
const ACTOR = { userId: "u-owner", username: "owner" };

// every console line, to prove no secret / hash / tag is ever printed
const printed = [];
for (const k of ["log", "error", "warn", "info"]) {
  const orig = console[k];
  console[k] = (...a) => { printed.push(a.map(String).join(" ")); return orig.apply(console, a); };
}

let base, server, ran = 0;
const later = [];
test.before(async () => {
  await bk.init();
  const app = express();
  app.use(express.json());
  app.use(bk.middleware);
  app.post("/api/bridge/sync", (req, res) => { ran++; res.json({ ok: bk.isBotToken((req.body || {}).password) }); });
  app.post("/api/bridge/twice", (req, res) => { const a = bk.isBotToken(req.body.password); const b = bk.isBotToken(req.body.password); res.json({ ok: a && b }); });
  app.get("/api/users/discord/:id", (req, res) => { ran++; res.json({ ok: bk.isPlatformBot(req.get("x-bot-token")) }); });
  app.get("/api/public/thing", (req, res) => { ran++; res.json({ ok: true }); });
  app.post("/api/pepe/later", (req, res) => { const now = bk.isBotToken("x"); setTimeout(() => later.push(bk.isBotToken("x")), 30); res.json({ ok: now }); });
  app.post("/api/raw/thing", express.raw({ type: "*/*" }), (req, res) => res.json({ ok: bk.isBotToken() }));
  bk.register(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const call = (p, { key, body, method = body ? "POST" : "GET", headers = {} } = {}) =>
  fetch(base + p, { method, headers: Object.assign({ "content-type": "application/json", "user-agent": "python-requests/2.31.0" },
                                                   key ? { "x-patv-key": key } : {}, headers), body: body ? JSON.stringify(body) : undefined });
const okOf = async (r) => { const j = await r.json(); return j.ok; };
const randomKey = (caller) => caller + "." + crypto.randomBytes(32).toString("base64url");
let PEPE = null;

test("mint: the key is caller.secret (43 base64url chars), shown once; only an argon2id hash and a 16-hex tag are stored", async () => {
  const m = await bk.mint("pepe", "Pepe on the VM", ACTOR);
  PEPE = m.key;
  assert.match(m.key, bk.HEADER_RE);
  assert.equal(m.caller, "pepe");
  const secret = m.key.split(".")[1];
  const row = (await getQuery("SELECT * FROM bot_keys WHERE caller = 'pepe'"))[0];
  assert.match(row.hash, /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.match(row.tag, /^[0-9a-f]{16}$/);
  assert.equal(row.mode, "observe");
  assert.ok(!JSON.stringify(row).includes(secret), "the secret is never stored");
  assert.equal(await bk._phcVerify(row.hash, secret), true, "the PHC string verifies the secret");
  assert.equal(await bk._phcVerify(row.hash, secret + "x"), false);
  await assert.rejects(bk.mint("pepe", "again", ACTOR), (e) => e.code === "exists" && e.status === 409, "a live caller can't be minted twice");
  await assert.rejects(bk.mint("Bad Caller!", "", ACTOR), (e) => e.code === "bad_caller");
  const audit = await getQuery("SELECT action, detail FROM admin_audit WHERE action = 'botkeys.mint'");
  assert.equal(audit.length, 1);
  assert.ok(!audit[0].detail.includes(secret));
});

test("a random header never runs argon2 (tag prefilter); a good key runs it once, then the cache answers", async () => {
  const a0 = bk._stats.argon;
  for (let i = 0; i < 5; i++) await call("/api/bridge/sync", { key: randomKey("pepe"), body: {} });
  await call("/api/bridge/sync", { key: randomKey("nobody"), body: {} });
  await call("/api/bridge/sync", { key: "not a key at all", body: {} });
  assert.equal(bk._stats.argon, a0, "no argon2 run for a wrong / unknown / malformed key");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true, "the key is a bot caller (no password needed)");
  assert.equal(bk._stats.argon, a0 + 1, "one argon2 run");
  for (let i = 0; i < 3; i++) assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true);
  assert.equal(bk._stats.argon, a0 + 1, "cached afterwards");
});

test("observe: every route is allowed and logged at the end of the request (public routes too); key + password is not legacy", async () => {
  await bk.flush();
  await runQuery("DELETE FROM legacy_token_use"); await runQuery("DELETE FROM legacy_token_daily");
  assert.equal(await okOf(await call("/api/public/thing", { key: PEPE })), true);
  assert.equal(await okOf(await call("/api/users/discord/42", { key: PEPE })), true, "isPlatformBot for a key caller");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: { password: process.env.TWITCH_BOT_TOKEN } })), true);
  assert.equal(await okOf(await call("/api/raw/thing", { key: PEPE, body: { a: 1 } })), true, "the context survives a route-level express.raw");
  await bk.flush();
  const log = await getQuery("SELECT caller, method, route, family, n FROM bot_route_log WHERE caller = 'pepe' ORDER BY route");
  const row = (r) => log.find((x) => x.route === r);
  assert.ok(row("/api/public/thing") && row("/api/public/thing").family === "/api/public" && row("/api/public/thing").method === "GET");
  assert.ok(row("/api/users/discord/:id") && row("/api/users/discord/:id").family === "/api/users", "the route PATTERN, not the path");
  assert.ok(row("/api/bridge/sync").n >= 5);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM legacy_token_use"))[0].n, 0, "a resolved key + the password is never counted as legacy");
  assert.ok((await getQuery("SELECT last_used_at FROM bot_keys WHERE caller = 'pepe'"))[0].last_used_at > 0, "last_used_at bumped");
});

test("legacy: the shared token alone is counted once per request with a caller hint; DISCORD_BOT_TOKEN as token=discord", async () => {
  await runQuery("DELETE FROM legacy_token_use"); await runQuery("DELETE FROM legacy_token_daily");
  assert.equal(await okOf(await call("/api/bridge/twice", { body: { password: process.env.TWITCH_BOT_TOKEN } })), true);
  assert.equal(await okOf(await call("/api/bridge/sync", { body: { password: "wrong" } })), false, "a wrong token is refused (and not counted)");
  assert.equal(await okOf(await call("/api/users/discord/7", { headers: { "x-bot-token": process.env.DISCORD_BOT_TOKEN, "user-agent": "axios/1.6.2" } })), true);
  await bk.flush();
  const rows = await getQuery("SELECT route, caller_hint, family, token, n FROM legacy_token_use ORDER BY route");
  const twice = rows.find((r) => r.route === "POST /api/bridge/twice");
  assert.ok(twice, JSON.stringify(rows));
  assert.equal(twice.n, 1, "two isBotToken calls in one request = one count");
  assert.equal(twice.token, "shared");
  assert.equal(twice.family, "/api/bridge");
  assert.match(twice.caller_hint, /^shared\|python-requests\/2\|/, "hint = token | UA family | address (never the raw UA)");
  const dc = rows.find((r) => r.route === "GET /api/users/discord/:id");
  assert.ok(dc && dc.token === "discord" && /^discord\|axios\/1\|/.test(dc.caller_hint), JSON.stringify(dc));
  assert.equal(rows.length, 2, "the refused wrong token isn't counted");
  const daily = await getQuery("SELECT token, family, n FROM legacy_token_daily");
  assert.ok(daily.some((d) => d.token === "shared" && d.family === "/api/bridge" && d.n === 1));
  assert.equal(bk.isBotToken(process.env.TWITCH_BOT_TOKEN), true, "outside a request it still works");
  await bk.flush();
  assert.ok((await getQuery("SELECT 1 FROM legacy_token_use WHERE route = '(no request)'")).length, "...counted as (no request)");
});

test("a key that doesn't resolve: fallback (judged on the legacy credentials, hint badkey:<caller>) or refuse (401); alerts only for a real caller", async () => {
  await runQuery("DELETE FROM legacy_token_use");
  alerts.length = 0;
  const u0 = bk._stats.unknown;
  assert.equal(await okOf(await call("/api/bridge/sync", { key: randomKey("ghost"), body: { password: process.env.TWITCH_BOT_TOKEN } })), true);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: randomKey("ghost"), body: {} })), false, "no legacy credential -> not a bot");
  await bk.flush();
  const r = (await getQuery("SELECT caller_hint FROM legacy_token_use WHERE route = 'POST /api/bridge/sync'"))[0];
  assert.match(r.caller_hint, /^badkey:ghost\|/);
  // a caller nobody minted (anyone can send one): counted, never an alert - made-up names can't flood the admins' Telegram
  for (let i = 0; i < 30; i++) await call("/", { key: randomKey("x" + i + "-made-up") });
  assert.equal(alerts.length, 0, "no alert for a caller with no row");
  assert.ok(bk._stats.unknown >= u0 + 32, "...only counted");
  // a real caller sending a wrong secret: one alert a day (source botkeys), no request path in it
  await bk.mint("probe", "alert probe", ACTOR);
  await call("/api/bridge/sync?evil=<b>hi</b>", { key: randomKey("probe"), body: {} });
  await call("/api/bridge/sync", { key: randomKey("probe"), body: {} });
  const mine = alerts.filter((a) => a.source === "botkeys" && /"probe"/.test(a.title));
  assert.equal(mine.length, 1, "one alert per known caller per day");
  assert.ok(!/evil|<b>/.test(mine[0].body) && /\/api\/bridge/.test(mine[0].body), "the family, never the raw path");
  await bk.setSettings({ bad_key: "refuse" }, ACTOR);
  const before = ran;
  const res = await call("/api/bridge/sync", { key: randomKey("ghost"), body: { password: process.env.TWITCH_BOT_TOKEN } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: "key" });
  assert.equal(ran, before, "the handler never ran");
  await bk.setSettings({ bad_key: "fallback" }, ACTOR);
});

test("unknown callers: at most one summary alert a day, after the day ends (source botkeys-unknown, no caller name in it)", async () => {
  await call("/", { key: randomKey("nobody-real") });
  const t = Date.now();
  alerts.length = 0;
  bk._setClock(() => t + 86400000);
  try {
    await bk.flush();
    await bk.flush();
    const sum = alerts.filter((a) => a.source === "botkeys-unknown");
    assert.equal(sum.length, 1, "one summary for the day that ended");
    assert.match(sum[0].title, /^\d+ bot key header\(s\) for unknown callers on \d{4}-\d{2}-\d{2}$/);
    assert.ok(!/nobody-real|made-up|ghost/.test(sum[0].title + sum[0].body), "never a name from a header");
  } finally { bk._setClock(null); }
});

test("enforce: outside its scopes the key counts for nothing (logged refused, alert, the legacy credentials decide); 403 once the family refuses the shared token", async () => {
  await assert.rejects(bk.setMode("pepe", "enforce", ["/api/bridge"], ACTOR), (e) => e.code === "too_early" && e.status === 409);
  await bk.setMode("pepe", "enforce", ["/api/bridge", "/api/users"], ACTOR, { early: true });
  alerts.length = 0;
  await runQuery("DELETE FROM legacy_token_use");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true, "in scope");
  // out of scope, the family's legacy switch off: the request goes on, judged as if it had no key
  let before = ran;
  let res = await call("/api/public/thing", { key: PEPE });
  assert.equal(res.status, 200, "a public route still answers");
  assert.equal(ran, before + 1);
  res = await call("/api/raw/thing", { key: PEPE, body: { a: 1 } });
  assert.equal((await res.json()).ok, false, "out of scope: no bot authority from the key");
  await call("/api/public/thing", { key: PEPE });
  const scopeAlerts = alerts.filter((a) => a.source === "botkeys-scope" && /outside its scopes on \/api\/public/.test(a.title));
  assert.equal(scopeAlerts.length, 1, "one alert per caller + family a day, under its own source");
  // the shared token on an out-of-scope family: counted with hint scope:<caller>
  await call("/api/users/discord/9", { key: PEPE, headers: { "x-bot-token": process.env.TWITCH_BOT_TOKEN } });   // in scope (/api/users)
  await bk.setMode("pepe", "enforce", ["/api/users"], ACTOR, { early: true });
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: { password: process.env.TWITCH_BOT_TOKEN } })), true,
               "out of scope + the password + no legacy switch: the password decides (not a 403 before routing)");
  await bk.flush();
  const hint = (await getQuery("SELECT caller_hint FROM legacy_token_use WHERE route = 'POST /api/bridge/sync'"))[0];
  assert.match(hint.caller_hint, /^scope:pepe\|/);
  // the family refuses the shared token: nothing else could authenticate it there -> 403 before the handler
  await bk.setFamily("/api/bridge", true, ACTOR);
  before = ran;
  res = await call("/api/bridge/sync", { key: PEPE, body: { password: process.env.TWITCH_BOT_TOKEN } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: "scope" });
  assert.equal(ran, before, "the handler never ran");
  await bk.setFamily("/api/bridge", false, ACTOR);
  await bk.flush();
  const refusedRows = await getQuery("SELECT family, refused, refused_at FROM bot_route_log WHERE caller = 'pepe' AND route = '(refused)' ORDER BY family");
  assert.deepEqual(refusedRows.map((r) => r.family), ["/api/bridge", "/api/public", "/api/raw"], "one '(refused)' row per family (not one collapsed row)");
  assert.equal(refusedRows.find((r) => r.family === "/api/public").refused, 2);
  assert.ok(refusedRows.every((r) => r.refused_at > 0));
  const recent = await bk.recentRefusals();
  assert.deepEqual(recent.map((r) => r.family).sort(), ["/api/bridge", "/api/public", "/api/raw"], "the admin Overview names each family");
  const v = await bk.adminView();
  const obs = v.observed.pepe.filter((o) => o.refused > 0).map((o) => o.family).sort();
  assert.deepEqual(obs, ["/api/bridge", "/api/public", "/api/raw"], "a Grant entry per refused family");
  await bk.setMode("pepe", "enforce", ["/api/bridge", "/api/users"], ACTOR, { early: true });
  await bk.grant("pepe", "/api/public", ACTOR);
  assert.equal((await call("/api/public/thing", { key: PEPE })).status, 200, "a granted family works at once (the cache follows the change)");
  await bk.setMode("pepe", "observe", null, ACTOR);
});

test("a family's legacy-enforce switch refuses the shared token there only; keys are unaffected", async () => {
  await bk.setFamily("/api/bridge", true, ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { body: { password: process.env.TWITCH_BOT_TOKEN } })), false, "refused on /api/bridge");
  assert.equal(await okOf(await call("/api/users/discord/1", { headers: { "x-bot-token": process.env.TWITCH_BOT_TOKEN } })), true, "allowed elsewhere");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true, "a key still works there");
  await bk.flush();
  const r = (await getQuery("SELECT refused FROM legacy_token_use WHERE route = 'POST /api/bridge/sync' AND caller_hint LIKE 'shared|%'"))[0];
  assert.ok(r && r.refused >= 1, "counted as refused");
  await bk.setFamily("/api/bridge", false, ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { body: { password: process.env.TWITCH_BOT_TOKEN } })), true);
});

test("rotate: the old secret works through the grace window, then stops; revoke stops the key at once", async () => {
  const r = await bk.rotate("pepe", 1, ACTOR);
  assert.match(r.key, bk.HEADER_RE);
  assert.notEqual(r.key, PEPE);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: r.key, body: {} })), true, "the new key works");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true, "the old one too, during the grace");
  const t = Date.now();
  bk._setClock(() => t + 2 * 3600e3);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), false, "after the grace: unresolved (no password -> refused)");
  assert.equal(await okOf(await call("/api/bridge/sync", { key: r.key, body: {} })), true);
  bk._setClock(null);
  await assert.rejects(bk.revoke("pepe", "", ACTOR), (e) => e.code === "reason");
  await bk.revoke("pepe", "rotating the VM", ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: r.key, body: {} })), false, "revoked: gone at once");
  const again = await bk.mint("pepe", "back", ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: again.key, body: {} })), true, "a revoked caller can get a fresh key");
  const row = (await getQuery("SELECT mode, scopes, revoked_at FROM bot_keys WHERE caller = 'pepe'"))[0];
  assert.equal(row.mode, "observe");
  assert.equal(row.revoked_at, null);
  assert.ok(JSON.parse(row.scopes).includes("/api/bridge"), "scopes kept");
  PEPE = again.key;
});

test("the kill switch: enabled=false ignores the header (legacy only)", async () => {
  await bk.setSettings({ enabled: false }, ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), false);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: { password: process.env.TWITCH_BOT_TOKEN } })), true);
  await bk.setSettings({ enabled: true }, ACTOR);
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true);
});

test("the request context ends with the request: a timer it started is no bot caller", async () => {
  assert.equal(await okOf(await call("/api/pepe/later", { key: PEPE, body: {} })), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(later, [false]);
});

test("whoami: the key's caller, mode and observed days; 401 without a key (never the legacy token)", async () => {
  const r = await call("/api/botkeys/whoami", { key: PEPE });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.caller, "pepe");
  assert.equal(j.mode, "observe");
  assert.equal(j.observe_days, 0);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await call("/api/botkeys/whoami", { headers: { "x-bot-token": process.env.TWITCH_BOT_TOKEN } })).status, 401);
});

test("an expired cache entry is re-checked against the row instead of argon2; a secret changed or revoked behind the cache still fails", async () => {
  assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true);   // cached
  const a0 = bk._stats.argon, r0 = bk._stats.revalidated;
  const t = Date.now();
  try {
    bk._setClock(() => t + bk.CACHE_MS + 1000);
    const many = await Promise.all(Array.from({ length: 6 }, () => call("/api/bridge/sync", { key: PEPE, body: {} })));
    for (const r of many) assert.equal(await okOf(r), true);
    assert.equal(bk._stats.argon, a0, "no argon2 when the entry runs out and nothing changed (Pepe's audio never stalls)");
    assert.equal(bk._stats.revalidated, r0 + 1, "one row re-check for the concurrent requests");
    bk._setClock(() => t + 2 * bk.CACHE_MS + 2000);
    assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true);
    assert.equal(bk._stats.argon, a0, "...again");
    // revoked by something that doesn't bump this process (a CLI script): the next re-check sees it
    await runQuery("UPDATE bot_keys SET revoked_at = ? WHERE caller = 'pepe'", [t]);
    bk._setClock(() => t + 3 * bk.CACHE_MS + 3000);
    assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), false, "revoked behind the cache: refused at the re-check");
    await runQuery("UPDATE bot_keys SET revoked_at = NULL WHERE caller = 'pepe'");
    // the stored secret replaced behind the cache (same caller, no bump): no shortcut - argon2 / the tag decide, and the old one fails
    const row = (await getQuery("SELECT hash, tag FROM bot_keys WHERE caller = 'pepe'"))[0];
    await runQuery("UPDATE bot_keys SET hash = ?, tag = ? WHERE caller = 'pepe'", [await bk._phcHash("another-secret"), bk._tagOf("another-secret")]);
    bk._setClock(() => t + 4 * bk.CACHE_MS + 4000);
    assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), false, "the old secret no longer resolves");
    // the same tag but a different stored hash (an edited row): the shortcut refuses and argon2 runs
    await runQuery("UPDATE bot_keys SET hash = ?, tag = ? WHERE caller = 'pepe'", [row.hash, row.tag]);
    bk._setClock(() => t + 5 * bk.CACHE_MS + 5000);
    assert.equal(await okOf(await call("/api/bridge/sync", { key: PEPE, body: {} })), true, "the original row back: argon2 verifies it");
    const a1 = bk._stats.argon;
    assert.ok(a1 > a0, "a full verify ran after the stored secret changed");
  } finally { bk._setClock(null); }
});

test("route families are generated from the path", () => {
  assert.equal(bk.family("/api/bridge/sync"), "/api/bridge");
  assert.equal(bk.family("/api/soundboards/bot/src/x"), "/api/soundboards/bot");
  assert.equal(bk.family("/API/Gtf/bot/put?x=1"), "/api/gtf/bot");
  assert.equal(bk.family("/events"), "/events");
  assert.equal(bk.family("/u/someone/chattip"), "/u", "not per user");
  assert.equal(bk.family("/"), "/");
  assert.equal(bk.uaFamily("Mozilla/5.0 (Windows)"), "browser");
  assert.equal(bk.uaFamily("curl/7.68.0"), "curl");
  assert.equal(bk.uaFamily("pepe-vm-control/1"), "pepe-vm-control/1");
  assert.equal(bk.uaFamily(""), "-");
});

test("no secret, hash or tag in adminView() or anywhere on the console", async () => {
  const v = JSON.stringify(await bk.adminView());
  const rows = await getQuery("SELECT hash, tag, prev_hash, prev_tag FROM bot_keys");
  for (const r of rows) for (const x of Object.values(r)) if (x) assert.ok(!v.includes(x), "adminView leaks " + String(x).slice(0, 12));
  const secret = PEPE.split(".")[1];
  assert.ok(!v.includes(secret));
  const all = printed.join("\n");
  assert.ok(!all.includes(secret), "the secret was printed");
  for (const r of rows) for (const x of Object.values(r)) if (x) assert.ok(!all.includes(x), "a hash / tag was printed");
  assert.ok(!all.includes(process.env.TWITCH_BOT_TOKEN), "the shared token was printed");
});
