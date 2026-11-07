"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { createCatalog } = require("../plexcatalog");
const { createLists, reference, DAY, TIMEOUT, DAILY_CALLS } = require("../plexlists");
const AT = Date.UTC(2026, 10, 5, 12);
const row = (key, title, more = {}) => ({ key: String(key), title, type: "movie", section: "71", content_rating: "PG", year: 2001, duration: 5400, ...more });
const catalogRows = () => [row(101, "Lantern Harbor", { imdb: "tt7000101", tmdb: "8101" }), row(102, "Copper Window", { tmdb: "8102" }),
  row(103, "Café & Cloud", { year: 2002 }), row(104, "Unlisted Moon"), row(105, "Hidden Fixture", { section: "73", imdb: "tt7000105" }),
  row(106, "Blocked Fixture", { content_rating: "X", imdb: "tt7000106" }), row(107, "Wrong ID", { imdb: "tt7000107" }),
  row(201, "Harbor Shift", { type: "show", section: "72", tvdb: "9201", content_rating: "TV-14" }),
  row(202, "Paper Dispatch", { type: "show", section: "72", content_rating: "TV-14" }),
  row(301, "星の港"), row(302, "雪の窓"), row(303, "Тихая гавань"), row(304, "Снежный архив"),
  row(305, "Май"), row(306, "Маи"), row(307, "カ"), row(308, "ガ")];
const snapshot = () => ({ v: 1, allow_list_set: true, sections: [
  { id: "71", title: "Fixture Cinema", policy: "allowed", type: "movie" },
  { id: "72", title: "Fixture Series", policy: "allowed", type: "show" },
  { id: "73", title: "Private Fixture", policy: "adult", type: "movie" },
], rows: catalogRows(), shelves: [] });
const fixtureItems = () => [
  { rank: 37, mediatype: "movie", imdb_id: "tt7000101", id: 9999, title: "Provider Alternate Name", release_year: 1999, description: "NEVER RETAIN", poster: "NEVER RETAIN", score: 98 },
  { rank: 99, mediatype: "movie", id: 8102, title: "Another Provider Label", release_year: 2001 },
  { rank: 101, mediatype: "movie", title: "Cafe and Cloud", release_year: 2001 },
  { rank: 102, mediatype: "show", tvdb_id: 9201, title: "Alias", release_year: 2001 },
  { rank: 103, mediatype: "show", title: "Paper Dispatch", release_year: 2000 },
  { rank: 104, mediatype: "movie", imdb_id: "tt7000105", title: "Outside Private Name", release_year: 2001 },
  { rank: 105, mediatype: "movie", imdb_id: "tt7000106", title: "Outside Blocked Name", release_year: 2001 },
  { rank: 106, mediatype: "movie", title: "Outside Unknown Name", release_year: 2001 },
  { rank: 107, mediatype: "movie", imdb_id: "tt7999999", title: "Wrong ID", release_year: 2001 },
];
async function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexlists-test-"));
  const file = path.join(dir, "catalog.db"), calls = [], errors = [], requests = [];
  let clock = AT, secret = crypto.randomBytes(24).toString("hex"), handler = null;
  const cfg = { clerk_lists: true, clerk_block_ratings: "X,XXX,AO,R18,R18+" };
  const catalog = createCatalog({ file, settings: () => cfg, now: () => clock, log: { log() {}, error() {} } });
  await catalog.importSnapshot(snapshot());
  const meta = { id: 8001, name: "Lantern Top 250", description: "NEVER RETAIN", items: 9 };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://fixture.invalid");
    if (u.searchParams.get("apikey") !== secret) { res.writeHead(401); res.end("{}"); return; }
    u.searchParams.delete("apikey"); calls.push(u.pathname + u.search); // Never record a credential, even a random mock value.
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const send = (status, json, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(json)); };
    if (handler && await handler(u, send, req, res)) return;
    if (u.pathname === "/lists/search") return send(200, [meta]);
    if (u.pathname === "/lists/8001" || u.pathname === "/lists/invented/lantern-top") return send(200, meta);
    if (u.pathname === "/lists/8001/items") {
      const items = fixtureItems(); return send(200, { movies: items.filter((r) => r.mediatype === "movie"), shows: items.filter((r) => r.mediatype === "show") });
    }
    send(404, { error: "Do not expose provider errors" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = async (url, opts) => {
    assert.equal(url.origin, "https://api.mdblist.com");
    const local = new URL(url.pathname + url.search, "http://127.0.0.1:" + server.address().port);
    const res = await fetch(local, { signal: opts.signal, redirect: "manual" });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  const create = (extra = {}) => createLists({ catalog, settings: () => cfg, key: () => secret, now: () => clock, request,
    permissions: { can: (u, permission) => { assert.equal(permission, "media.admin"); return u && u.admin; } },
    guard: { sameSite: (r) => r.sameSite }, ...overrides, ...extra });
  const lists = create();
  t.after(async () => { await lists.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { lists, create, catalog, cfg, calls, requests, meta, file, dir, errors,
    clock: (value) => { clock = value; }, key: (value) => { secret = value; }, secret: () => secret,
    handler: (fn) => { handler = fn; } };
}

test("only numeric ids and canonical MDBList references are accepted", () => {
  assert.deepEqual(reference("8001"), { id: "8001", path: "/lists/8001" });
  assert.equal(reference("https://mdblist.com/lists/invented/lantern-top/").path, "/lists/invented/lantern-top");
  for (const bad of ["0", "-1", "https://other.invalid/lists/8001", "http://mdblist.com/lists/8001", "https://mdblist.com:444/lists/8001", "https://mdblist.com/lists/a/b?apikey=x", "https://mdblist.com/lists/a/%2e%2e", "https://user@mdblist.com/lists/a/b", "https://mdblist.com/lists/a/b#x", "https://mdblist.com/lists/a/b/c"]) assert.throws(() => reference(bad), (e) => e.code === "invalid_list");
});

test("no key means no database reads, provider calls, names, search, or sync", async () => {
  const lists = createLists({ key: () => "", catalog: new Proxy({}, { get() { throw new Error("should not read"); } }), settings: () => ({ clerk_lists: true }), request() { throw new Error("should not call"); } });
  assert.deepEqual(await lists.list(), { ok: true, configured: false, message: "needs MDBLIST_API_KEY" });
  assert.deepEqual(await lists.shelves(), []); assert.deepEqual(await lists.members(), []);
  assert.deepEqual(await lists.search("lantern"), { ok: false, code: "needs_key" });
  assert.deepEqual(await lists.add("8001"), { ok: false, code: "needs_key" });
  assert.equal((await lists.tick()).skipped, true); await lists.close();
});

test("mocked MDBList add matches identifiers first, safe title/year second, and exposes only matched keys", async (t) => {
  const h = await setup(t);
  assert.deepEqual(await h.lists.add("https://mdblist.com/lists/invented/lantern-top"), { ok: true, id: "8001" });
  const members = await h.lists.members({ id: "mdblist:8001" });
  assert.deepEqual(members.map((r) => [r.key, r.rank]), [["101", 37], ["102", 99], ["103", 101], ["201", 102]]);
  assert.deepEqual(await h.lists.shelves(), [{ id: "mdblist:8001", name: "Lantern Top 250", count: 4, kind: "mixed", source: "mdblist", ranked: true }]);
  const admin = (await h.lists.list()).lists[0]; assert.equal(admin.items, 9); assert.equal(admin.matched, 4); assert.equal(admin.unmatched, 5); assert.equal(admin.last_read, AT);
  const visible = JSON.stringify([members, admin, await h.lists.shelves()]);
  for (const hidden of ["Outside", "Provider Alternate", "NEVER RETAIN", "imdb", "poster", "description", "score"]) assert.equal(visible.includes(hidden), false);
  const stored = (await h.catalog.read("SELECT entries FROM plex_lists"))[0].entries;
  assert.equal(stored.includes("NEVER RETAIN"), false); assert.equal(stored.includes("description"), false); assert.equal(stored.includes("score"), false);
  assert.equal(h.requests.some((r) => r.query.append_to_response), false);
  assert.deepEqual((await h.lists.members({ id: "8001", rank_max: 100 })).map((r) => r.key), ["101", "102"]);
  assert.deepEqual((await h.lists.members({ kind: "show" })).map((r) => r.key), ["201"]);
  assert.deepEqual((await h.lists.membership(["103"])).map((r) => r.key), ["103"]);
});

test("ranks are never synthesized and empty or unmatched lists never become shelves", async (t) => {
  const h = await setup(t);
  assert.equal((await h.lists.importSnapshot({ configured: [
    { id: "8002", name: "Paper Picks", ranked: false, items: [{ type: "movie", title: "Unlisted Moon", year: 2001, rank: 4 }] },
    { id: "8003", name: "Absent Picks", items: [{ type: "movie", title: "Outside Unknown Name", year: 2001 }] },
  ] })).ok, true);
  assert.deepEqual((await h.lists.shelves()).map((r) => [r.name, r.ranked]), [["Paper Picks", false]]);
  assert.equal((await h.lists.members())[0].rank, null); assert.deepEqual(await h.lists.members({ rank_max: 100 }), []);
  assert.equal((await h.lists.list()).lists.find((r) => r.id === "8003").unmatched, 1);
});

test("non-Latin titles stay distinct and empty normalized titles never match", async (t) => {
  const h = await setup(t);
  await h.lists.importSnapshot({ configured: [{ id: "8004", name: "World Picks", items: [
    { type: "movie", title: "星の港", year: 2001 }, { type: "movie", title: "Тихая гавань", year: 2001 },
    { type: "movie", title: "☀️🎈", year: 2001 }, { type: "movie", title: "別の映画", year: 2001 },
    { type: "movie", title: "Май", year: 2001 }, { type: "movie", title: "ガ", year: 2001 },
  ] }] });
  assert.deepEqual((await h.lists.members()).map((r) => r.key), ["301", "303", "305", "308"]);
});

test("current rating and section changes revoke cached members, names and counts immediately", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  h.cfg.clerk_block_ratings += ",PG,TV-14";
  assert.deepEqual(await h.lists.shelves(), []); assert.deepEqual(await h.lists.members(), []);
  assert.equal((await h.lists.list()).lists[0].matched, 0); assert.equal((await h.lists.list()).lists[0].unmatched, 9);
  h.cfg.clerk_block_ratings = "X";
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET policy='off'"));
  assert.deepEqual(await h.lists.shelves(), []); assert.deepEqual(await h.lists.members(), []);
});

test("removal during a safe catalog lookup cannot return the removed list", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  const get = h.catalog.getByKeys;
  h.catalog.getByKeys = async (keys) => { const rows = await get(keys); await h.lists.remove("8001"); return rows; };
  assert.deepEqual(await h.lists.members(), []); assert.deepEqual(await h.lists.shelves(), []);
});

test("policy changes after getByKeys or during the final membership query fail closed", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  const get = h.catalog.getByKeys, read = h.catalog.read;
  h.catalog.getByKeys = async (keys) => { const rows = await get(keys); h.cfg.clerk_block_ratings += ",PG,TV-14"; return rows; };
  assert.deepEqual(await h.lists.members(), []); assert.deepEqual(await h.lists.shelves(), []);
  h.catalog.getByKeys = get; h.cfg.clerk_block_ratings = "X";
  h.catalog.read = async (sql, args, options) => {
    const rows = await read(sql, args, options);
    if (sql.includes("current_type")) h.cfg.clerk_block_ratings = "X,PG,TV-14";
    return rows;
  };
  assert.deepEqual(await h.lists.members(), []);
  h.catalog.read = read; h.cfg.clerk_block_ratings = "X";
  h.catalog.getByKeys = async (keys) => { const rows = await get(keys); await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET policy='off'")); return rows; };
  assert.deepEqual(await h.lists.members(), []);
});

test("switch and removed key hide cached names; only boolean true enables public reads", async (t) => {
  const h = await setup(t); await h.lists.add("8001"); const calls = h.calls.length;
  for (const value of [false, "off", "true", 0, 1, undefined]) {
    h.cfg.clerk_lists = value; assert.deepEqual(await h.lists.shelves(), []); assert.equal((await h.lists.tick()).skipped, true);
  }
  h.cfg.clerk_lists = true; assert.equal((await h.lists.shelves()).length, 1);
  h.key(""); assert.deepEqual(await h.lists.shelves(), []); assert.deepEqual(await h.lists.list(), { ok: true, configured: false, message: "needs MDBLIST_API_KEY" });
  assert.equal(h.calls.length, calls);
});

test("cursor pagination and old offset pagination preserve provider ranks", async (t) => {
  const h = await setup(t); let mode = "cursor";
  h.handler((u, send) => {
    if (!u.pathname.endsWith("/items")) return false;
    const second = mode === "cursor" ? u.searchParams.get("cursor") === "page-two" : u.searchParams.get("offset") === "1";
    send(200, { movies: [second ? fixtureItems()[1] : fixtureItems()[0]], shows: [], ...(mode === "cursor" && !second ? { pagination: { next_cursor: "page-two" } } : {}) }, second ? {} : { "X-Has-More": "true" }); return true;
  });
  assert.equal((await h.lists.add("8001")).ok, true); assert.deepEqual((await h.lists.members()).map((r) => r.rank), [37, 99]);
  assert.equal(h.requests.some((r) => r.query.cursor === "page-two"), true);
  mode = "offset"; assert.equal((await h.lists.refresh("8001")).ok, true);
  assert.equal(h.requests.some((r) => r.query.offset === "1"), true);
});

test("bad/incomplete pagination never replaces the last good cache", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  h.handler((u, send) => { if (!u.pathname.endsWith("/items")) return false; send(200, { movies: [fixtureItems()[0]], shows: [], next_cursor: "repeat" }, { "X-Has-More": "true" }); return true; });
  assert.deepEqual(await h.lists.refresh("8001"), { ok: false, code: "provider_invalid" });
  assert.equal((await h.lists.members()).length, 4); assert.equal((await h.lists.list()).lists[0].last_error, "provider_invalid");
  h.handler((u, send) => { if (!u.pathname.endsWith("/items")) return false; send(200, { movies: Array.from({ length: 1001 }, () => fixtureItems()[0]), shows: [] }); return true; });
  assert.equal((await h.lists.refresh("8001")).code, "list_too_large"); assert.equal((await h.lists.members()).length, 4);
});

test("24h timer, explicit refresh and quiet window enforce request timing", async (t) => {
  const h = await setup(t); await h.lists.add("8001"); const count = h.calls.length;
  h.clock(AT + DAY - 1); assert.equal((await h.lists.tick()).cached, true); assert.equal(h.calls.length, count);
  h.clock(AT + DAY); assert.equal((await h.lists.tick()).ok, true); assert.equal(h.calls.length, count + 2);
  assert.equal((await h.lists.refresh("8001")).ok, true); assert.equal(h.calls.length, count + 4);
  for (const minute of [220, 240, 259]) {
    h.clock(Date.UTC(2026, 10, 8, 0, minute)); const before = h.calls.length;
    assert.equal((await h.lists.tick()).skipped, true); assert.equal((await h.lists.refresh("8001")).code, "quiet");
    assert.equal((await h.lists.search("lantern")).code, "quiet"); assert.equal(h.calls.length, before);
  }
  h.clock(Date.UTC(2026, 10, 8, 4, 20)); assert.equal((await h.lists.refresh("8001")).ok, true);
});

test("429 Retry-After backoff survives module restart and is shared with search", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  h.handler((u, send) => { send(429, { error: "provider text" }, { "Retry-After": "600" }); return true; });
  assert.equal((await h.lists.refresh("8001")).code, "rate_limited"); const calls = h.calls.length;
  assert.equal((await h.lists.search("lantern")).code, "rate_limited"); assert.equal(h.calls.length, calls);
  const restarted = h.create(); t.after(() => restarted.close());
  assert.equal((await restarted.search("lantern")).code, "rate_limited"); assert.equal(h.calls.length, calls);
  h.clock(AT + 600001); h.handler(null); assert.equal((await restarted.search("lantern")).ok, true);
});

test("429 fallback is bounded and zero remaining honors the documented reset header", async (t) => {
  const h = await setup(t);
  h.handler((u, send) => { send(429, {}); return true; });
  assert.equal((await h.lists.search("lantern")).code, "rate_limited"); const first = h.calls.length;
  h.clock(AT + 59999); assert.equal((await h.lists.search("lantern")).code, "rate_limited"); assert.equal(h.calls.length, first);
  h.clock(AT + 60001); h.handler((u, send) => { send(200, [], { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((AT + 3600000) / 1000) }); return true; });
  assert.equal((await h.lists.search("lantern")).ok, true); const second = h.calls.length;
  assert.equal((await h.lists.search("lantern")).code, "rate_limited"); assert.equal(h.calls.length, second);
});

test("daily allowance cap persists and resets at UTC midnight", async (t) => {
  const h = await setup(t);
  for (let n = 0; n < DAILY_CALLS; n++) assert.equal((await h.lists.search("lantern")).ok, true);
  assert.equal((await h.lists.search("lantern")).code, "daily_budget"); assert.equal(h.calls.length, DAILY_CALLS);
  h.clock(AT + DAY); assert.equal((await h.lists.search("lantern")).ok, true);
});

test("provider errors and credential echoes never enter admin, public reads, or stored fields", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  h.handler((u, send) => { send(502, { error: "https://api.mdblist.com?apikey=" + h.secret() }); return true; });
  const failed = await h.lists.refresh("8001"); assert.deepEqual(failed, { ok: false, code: "provider_unavailable" });
  assert.equal(JSON.stringify(await h.lists.list()).includes(h.secret()), false);
  h.handler((u, send) => { send(200, [{ id: 8002, name: "echo " + h.secret(), description: h.secret(), items: 2 }]); return true; });
  const search = await h.lists.search("lantern"); assert.equal(JSON.stringify(search).includes(h.secret()), false);
  const thrown = h.create({ request: async () => { throw new Error("transport " + h.secret()); } }); t.after(() => thrown.close());
  assert.deepEqual(await thrown.search("lantern"), { ok: false, code: "provider_unavailable" });
});

test("deadline aborts mock HTTP requests and never exceeds the 10s production ceiling", async (t) => {
  const h = await setup(t, { timeoutMs: 25 });
  h.handler(() => true);
  const start = Date.now(); assert.equal((await h.lists.search("lantern")).code, "provider_timeout");
  assert.ok(Date.now() - start < 1000); assert.equal(TIMEOUT, 10000);
});

test("duplicate add avoids an item refresh; remove and rematch only use the local cache", async (t) => {
  const h = await setup(t); await h.lists.add("8001");
  const old = h.calls.length; assert.deepEqual(await h.lists.add("8001"), { ok: true, id: "8001", existing: true });
  assert.equal(h.calls.length, old + 1);
  await h.catalog.write((tx) => tx.run("DELETE FROM plex_catalog WHERE key='101'"));
  assert.equal((await h.lists.members()).length, 3);
  const before = h.calls.length; assert.equal((await h.lists.rematch()).ok, true); assert.equal(h.calls.length, before);
  assert.equal((await h.lists.remove("8001")).ok, true); assert.deepEqual(await h.lists.shelves(), []); assert.equal(h.calls.length, before);
});

test("admin search strips metadata and caps names; ambiguous URL resolutions require an explicit id", async (t) => {
  const h = await setup(t);
  h.handler((u, send) => {
    if (u.pathname === "/lists/search") { send(200, Array.from({ length: 20 }, (_, n) => ({ id: 9000 + n, name: "Fixture " + n, items: 5, description: "private extra", poster: "extra" }))); return true; }
    if (u.pathname === "/lists/invented/mixed") { send(200, [{ id: 8001, name: "Movies" }, { id: 8002, name: "Shows" }]); return true; }
    return false;
  });
  const result = await h.lists.search("lantern"); assert.equal(result.lists.length, 10); assert.deepEqual(Object.keys(result.lists[0]).sort(), ["id", "items", "name"]);
  assert.equal((await h.lists.add("https://mdblist.com/lists/invented/mixed")).code, "ambiguous_list");
  const calls = h.calls.length; assert.equal((await h.lists.add("https://other.invalid/lists/8001")).code, "invalid_list"); assert.equal(h.calls.length, calls);
});

test("admin routes preserve media.admin and same-site POST checks with no-store answers", async (t) => {
  const h = await setup(t), routes = new Map(), app = {};
  for (const method of ["get", "post"]) app[method] = (route, ...handlers) => routes.set(method.toUpperCase() + " " + route, handlers);
  h.lists.register(app, { addUser: (req, res, next) => next(), noTimers: true });
  async function invoke(method, suffix, more = {}) {
    const req = { method, user: { admin: true }, sameSite: true, query: {}, body: {}, ...more };
    let finish; const done = new Promise((resolve) => { finish = resolve; });
    const out = { status: 200, headers: {} }, res = { status(n) { out.status = n; return this; }, set(k, v) { out.headers[k] = v; }, json(body) { out.body = body; finish(); return this; } };
    const handlers = routes.get(method + " /api/media/admin/lists" + suffix); let index = 0;
    async function next() { const fn = handlers[index++]; if (fn) return fn(req, res, next); }
    await next(); await done; return out;
  }
  assert.equal((await invoke("GET", "", { user: { admin: false } })).status, 403);
  assert.equal((await invoke("GET", "/search", { user: null, query: { q: "lantern" } })).status, 403);
  // 1.99alq train3 verify: the search spends MDBList's budget - a GET without the fetch header (cross-site) is refused, no call
  const spent = h.calls.length;
  const cross = await invoke("GET", "/search", { query: { q: "lantern" } });
  assert.equal(cross.status, 403); assert.equal(h.calls.length, spent);
  assert.equal((await invoke("POST", "/add", { sameSite: false, body: { input: "8001" } })).status, 403);
  assert.equal(h.calls.length, 0);
  const good = await invoke("POST", "/add", { body: { input: "8001" } }); assert.equal(good.body.ok, true); assert.equal(good.headers["Cache-Control"], "no-store");
  assert.equal((await invoke("GET", "")).body.lists.length, 1);
  assert.equal((await invoke("POST", "/remove", { body: { id: "8001" } })).body.ok, true);
});

test("scheduler uses one unref timer and coalesces concurrent ticks", async (t) => {
  let starts = 0, clears = 0, unrefs = 0;
  const h = await setup(t, { setInterval(fn, ms) { starts++; assert.equal(ms, 60000); return { unref() { unrefs++; } }; }, clearInterval() { clears++; } });
  h.lists.start(); h.lists.start(); assert.equal(starts, 1); assert.equal(unrefs, 1);
  await h.lists.add("8001"); h.clock(AT + DAY);
  const before = h.calls.length; await Promise.all([h.lists.tick(), h.lists.tick(), h.lists.tick()]); assert.equal(h.calls.length, before + 2);
  await h.lists.close(); assert.equal(clears, 1);
});

test("outside-list admin card uses text, hides controls without key, and submits only explicit actions", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ejs = require("ejs");
  const locale = require("../locales/en.json");
  const view = fs.readFileSync(path.join(__dirname, "../views/mediaAdmin.ejs"), "utf8");
  const card = view.slice(view.indexOf('  <section class="sb-card" id="clerkLists"'), view.indexOf("  <% if (libraryOk)"));
  const html = ejs.render(card, { t(key) { assert.ok(locale[key], key); return locale[key]; } });
  assert.match(html, /Find a list/); assert.ok(!html.includes("undefined"));
  const nodes = new Map(), requests = [];
  function element(tag) {
    return { tag, children: [], handlers: {}, style: {}, textContent: "", hidden: false, value: "", disabled: false,
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      set innerHTML(_) { throw new Error("Provider text must not become HTML"); }
    };
  }
  for (const id of ["clerkLists","clControls","clStatus","clOut","clSearchOut","clInput","clAdd","clQuery","clSearch","clMsg"]) nodes.set(id, element("div"));
  let configured = false;
  const state = () => configured ? { ok: true, configured: true, enabled: false, lists: [{ id: "8001", name: "<img src=x onerror=unsafe()>", ranked: true, items: 5, matched: 3, unmatched: 2, last_read: 1793872800000, last_error: "provider_unavailable" }] } : { ok: true, configured: false };
  const context = {
    document: { getElementById: id => nodes.get(id) || null, createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {}, __t(key, fallback, values) { assert.ok(locale[key], key); return fallback.replace(/\{(\w+)\}/g, (m,n) => values && values[n] != null ? String(values[n]) : m); } },
    console, Promise, Date, Number, setTimeout, clearTimeout, encodeURIComponent,
    fetch(url, options) {
      requests.push({ url, options });
      let result = { ok: true };
      if (url === "/api/media/admin/lists") result = state();
      else if (url.startsWith("/api/media/admin/lists/search?")) result.lists = [{ id: "9001", name: "<svg onload=unsafe()>", items: 7 }];
      else if (url === "/api/media/admin/checks") result.checks = {};
      else assert.ok(["/api/media/admin/lists/add","/api/media/admin/lists/refresh","/api/media/admin/lists/remove"].includes(url), url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "../public/js/media-admin.js"), "utf8");
  const flush = async () => { for (let i=0;i<8;i++) await new Promise(resolve => setImmediate(resolve)); };
  const text = node => [node.textContent,...node.children.map(text)].join(" ");
  const descendants = node => [node,...node.children.flatMap(descendants)];
  vm.runInNewContext(source, context); await flush();
  assert.equal(nodes.get("clControls").hidden, true);
  assert.match(text(nodes.get("clStatus")), /MDBLIST_API_KEY/);
  assert.equal(requests.filter(r => r.options.method === "POST").length, 0);
  configured = true; vm.runInNewContext(source, context); await flush();
  assert.equal(nodes.get("clControls").hidden, false);
  assert.match(text(nodes.get("clOut")), /<img src=x/);
  assert.ok(!text(nodes.get("clOut")).includes("provider_unavailable"));
  nodes.get("clInput").value = "8002"; nodes.get("clAdd").handlers.click(); await flush();
  assert.deepEqual(JSON.parse(requests.find(r => r.url.endsWith("/add")).options.body), { input: "8002" });
  for (const label of ["Refresh", "Remove"]) {
    descendants(nodes.get("clOut")).find(node => node.tag === "button" && node.textContent === label).handlers.click(); await flush();
    assert.ok(requests.some(r => r.url.endsWith("/"+label.toLowerCase()) && JSON.parse(r.options.body).id === "8001"));
  }
  nodes.get("clQuery").value = "a&b"; nodes.get("clSearch").handlers.click(); await flush();
  assert.ok(requests.some(r => r.url.endsWith("search?q=a%26b")));
  assert.match(text(nodes.get("clSearchOut")), /<svg onload/);
  assert.equal(nodes.get("clSearch").disabled, false);
  configured = false; vm.runInNewContext(source, context); await flush();
  assert.equal(nodes.get("clControls").hidden, true);
  assert.equal(text(nodes.get("clOut")).trim(), ""); assert.equal(text(nodes.get("clSearchOut")).trim(), "");
  assert.ok(requests.every(r => r.options.credentials === "same-origin"));
});

test("catalog snapshot replacement rematches configured lists without provider reads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexlists-import-"));
  const cfg = { clerk_lists: true, clerk_block_ratings: "X,XXX,AO,R18,R18+" };
  let lists, rematches = 0, requests = 0;
  const adapter = { enabled: () => !!lists && lists.enabled(), rematch: async () => { rematches++; return lists.rematch(); },
    close: async () => { if (lists) await lists.close(); } };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => cfg, now: () => AT,
    lists: adapter, log: { log() {}, error() {} } });
  t.after(async () => { await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await catalog.importSnapshot(snapshot());
  lists = createLists({ catalog, settings: () => cfg, key: "fixture-only", now: () => AT,
    request() { requests++; throw new Error("snapshot import must not call MDBList"); } });
  await lists.importSnapshot({ configured: [{ id: "8001", name: "Snapshot shelf", ranked: true,
    items: [{ type: "movie", imdb: "tt7000101", title: "Provider label", year: 2001, rank: 4 }] }] });
  assert.deepEqual((await lists.members()).map(row => row.key), ["101"]);
  const next = snapshot();
  next.rows = next.rows.filter(row => row.key !== "101");
  next.rows.push(row("991", "Replacement catalog title", { imdb: "tt7000101" }));
  assert.equal((await catalog.importSnapshot(next)).ok, true);
  assert.equal(rematches, 1);
  assert.deepEqual((await lists.members()).map(row => row.key), ["991"]);
  assert.equal(requests, 0);
  cfg.clerk_lists = false;
  assert.equal((await catalog.importSnapshot(snapshot())).ok, true);
  assert.equal(rematches, 1, "disabled lists do not rematch");
  cfg.clerk_lists = true;
  adapter.rematch = async () => { throw new Error("local list cache unavailable"); };
  assert.equal((await catalog.importSnapshot(next)).ok, true, "list failure never discards a successful catalog import");
});

test("catalog shutdown releases active list rematch before waiting for sync", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexlists-close-"));
  let release, entered, closes = 0;
  const wait = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
  let catalog;
  const lists = { enabled: () => true, rematch: async () => { entered(); await wait; await catalog.read("SELECT key FROM plex_catalog"); },
    close: async () => { closes++; release(); } };
  catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => ({ clerk_lists: true }), now: () => AT,
    lists, mainRead: async () => [], tautulli: { configured: () => false },
    mediactl: async (_, route) => ({ status: 200, json: route === "/sections" ? { allow_list_set: true, sections: [] } : { version: "1.7.0" } }),
    log: { log() {}, error() {} } });
  t.after(async () => { release(); await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const syncing = catalog.sync({ full: true });
  await began;
  let timeout;
  try {
    await Promise.race([catalog.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("shutdown deadlocked")), 1000); })]);
  } finally { clearTimeout(timeout); }
  assert.equal((await syncing).ok, true);
  assert.equal(closes, 1);
});
