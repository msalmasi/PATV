"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCatalog, quiet } = require("../plexcatalog");

const AT = Date.UTC(2026, 10, 5, 12);
const sections = [
  { id: "1", title: "Fixture Cinema", type: "movie", count: 5, policy: "allowed" },
  { id: "2", title: "Fixture Series", type: "show", count: 1, policy: "allowed" },
  { id: "3", title: "Hidden fixture name", type: "movie", count: 1, policy: "adult" },
  { id: "4", title: "Unreviewed fixture name", type: "movie", count: 1, policy: "off" },
];
const row = (key, title, extra = {}) => ({ key: String(key), title, type: "movie", section: "1", duration: 5400, year: 2001, added: 100, updated: 100,
  genres: ["Comedy"], content_rating: "PG", summary: "A small crew crosses a rainy town.", directors: ["Invented Director"], cast: ["Invented Performer"], ...extra });
const fixtureRows = () => [row(1, "Quiet Harbor"), row(2, "Snow Archive", { content_rating: "NR" }), row(3, "Night Envelope", { content_rating: "NC-17" }),
  row(4, "Filtered Marker", { content_rating: "X" }), row(5, "Offstage Sample", { section: "3" }), row(6, "Not Reviewed Sample", { section: "4" }),
  row(20, "Window Office", { type: "show", section: "2", content_rating: "TV-14" }),
  row(21, "First Shift", { type: "episode", section: "2", show: "Window Office", show_key: "20", season_key: "200", season: 1, episode: 1, summary: "A shift starts at sunrise.", content_rating: "" })];
const snapshot = () => ({ v: 1, allow_list_set: true, sections, rows: fixtureRows(), shelves: [
  { key: "51", name: "Quiet Comedies", members: ["1", "2", "4", "5", "6"] },
  { key: "52", name: "Only Denied Collection", members: ["4", "5", "6"] },
] });

test("catalog searches retain Unicode titles in FTS and LIKE fallback", async (t) => {
  for (const noFts of [false, true]) {
    const h = await setup(t, { noFts }), seed = snapshot();
    seed.rows.push(row(801, "春の灯"), row(802, "秋の雨"), row(803, "Зимний Маяк"), row(804, "Летний Маяк"), row(805, "별빛 항구"), row(806, "दीप"));
    seed.rows.find((item) => item.key === "20").title = "Северная Башня";
    seed.rows.find((item) => item.key === "21").show = "Северная Башня";
    await h.catalog.importSnapshot(seed);
    for (const [query, key] of [["春の灯", "801"], ["秋の雨", "802"], ["зимний", "803"], ["летний", "804"], ["별빛 항구", "805"], ["दीप", "806"]]) {
      assert.deepEqual((await h.catalog.search(query)).map((item) => item.key), [key], `${noFts ? "LIKE" : "FTS"}: ${query}`);
    }
    assert.deepEqual((await h.catalog.search("северная", { kind: "episode" })).map((item) => item.key), ["21"]);
    for (const query of ["春の雨", "...", "\u093e"]) assert.deepEqual(await h.catalog.search(query), []);
  }
});

// 1.99alq train3 verify (review): Plex's country-prefixed certifications are blocked like the bare ones
test("a country-prefixed adult rating is blocked like the bare one; the settings cleaner takes the prefix off", async (t) => {
  const { crow, ratings, normRating } = require("../plexcatalog");
  for (const [raw, want] of [["gb/R18", "R18"], ["au/R18+", "R18+"], ["nz/ R18", "R18"], ["R", "R"], ["TV-MA", "TV-MA"], ["", ""], ["PG-13", "PG-13"]])
    assert.equal(normRating(raw), want, raw);
  assert.equal(crow(row(9, "Prefixed", { content_rating: "nz/R18" })).content_rating, "R18");
  assert.ok(ratings("X, gb/R18").has("R18"));
  // the settings cleaner, in a child (mediaconf opens the site database in its working directory)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexcatalog-clean-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = require("child_process").execFileSync(process.execPath, ["-e", `
    const C = require(${JSON.stringify(path.join(__dirname, "..", "mediaconf"))})._CLEAN;
    process.stdout.write(JSON.stringify([C.clerk_block_ratings("X, gb/R18 ,au/R18+,R18"), C.clerk_warn_ratings("NR, us/Not Rated")]));
    process.exit(0);`], { cwd: dir, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), ["X,R18,R18+", "NR,Not Rated"]);
  const h = await setup(t);
  h.api.rows.push(row(30, "Prefixed Marker", { content_rating: "gb/R18" }), row(31, "Prefixed Plus", { content_rating: "au/R18+" }));
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  assert.deepEqual(await h.catalog.getByKeys(["30", "31"]), []);
  assert.equal(JSON.stringify(await h.catalog.rows()).includes("Prefixed"), false);
});
// 1.99alq train3 verify (review): dark means dark - with every clerk switch off the timer reads nothing
test("the catalog timer reads nothing while every clerk switch is off, and syncs once one is on", async (t) => {
  const off = await setup(t);
  assert.equal(off.catalog.inUse(off.cfg), false);
  off.catalog.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(off.calls, [], "no mediactl read with everything off");
  assert.equal(fs.existsSync(path.join(off.dir, "catalog.db")), false, "no catalog file either");
  for (const [k, v] of [["clerk_enabled", "staff"], ["clerk_requests", "everyone"], ["clerk_embed", true], ["clerk_lists", true]])
    assert.equal(off.catalog.inUse({ ...off.cfg, [k]: v }), true, k);
  const on = await setup(t); on.cfg.clerk_enabled = "staff";
  on.catalog.start();
  for (let i = 0; i < 150 && !on.calls.includes("/sections"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(on.calls.includes("/sections"), "the clerk on: the timer syncs");
});

async function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexcatalog-test-"));
  let clock = AT;
  const cfg = { clerk_block_ratings: "X,XXX,AO,R18,R18+", catalog_sync_min: 60 };
  const api = { allowed: true, old: false, error: false, rows: fixtureRows(), sections: sections.map((s) => ({ ...s })), pageSize: 2 };
  const calls = [], logs = [], tautCalls = [], reads = [];
  const mediactl = async (method, route, _body, opts = {}) => {
    calls.push(route); reads.push({ route, timeout: opts.timeout });
    // 1.99?? catfix: a test can answer (or fail) any read first - api.hook(route, opts) -> an answer, a throw, or undefined
    if (api.hook) { const r = await api.hook(route, opts); if (r !== undefined) return r; }
    if (api.error) return { status: 502, json: { error: "Provider body must not appear" } };
    const u = new URL(route, "http://fixture.local");
    if (route === "/sections") return { status: api.old ? 404 : 200, json: { ok: !api.old, allow_list_set: api.allowed, sections: api.sections } };
    if (route === "/health") return { status: 200, json: { ok: true, version: api.version || "1.7.0" } };
    if (u.pathname === "/collections") {
      const all = api.collections || snapshot().shelves;
      // mediactl 1.7.0 walks every collection's members inside ONE answer (api.walkMs: how long that takes); the site's client
      // gives up after opts.timeout with no byte received - the real call() rejects "can't be reached (timeout)"
      if (api.walkMs && !(opts.timeout >= api.walkMs)) throw Object.assign(new Error("The media-control service can't be reached (timeout)."), { status: 502, refuse: true });
      if (semverOf(api.version) >= 1007001 && u.searchParams.has("size")) {   // 1.7.1: a page of shelves per answer
        const start = Number(u.searchParams.get("start") || 0), size = Number(u.searchParams.get("size"));
        const page = all.slice(start, start + size);
        return { status: 200, json: { ok: true, collections: page, total: all.length, next: start + page.length < all.length ? start + page.length : null } };
      }
      return { status: 200, json: { ok: true, collections: all } };
    }
    if (u.pathname === "/catalog") {
      const type = { 1: "movie", 2: "show", 4: "episode" }[u.searchParams.get("type")], sec = u.searchParams.get("section");
      let list = api.rows.filter((r) => r.type === type && (r.section === sec || (sec === "1" && ["3", "4"].includes(r.section)))); // broken provider injects denied rows
      if (u.searchParams.has("since")) list = list.filter((r) => r.updated >= Number(u.searchParams.get("since")));
      const start = Number(u.searchParams.get("start")), page = list.slice(start, start + api.pageSize);
      return { status: 200, json: { ok: true, rows: page, total: list.length, next: start + page.length < list.length ? start + page.length : null } };
    }
    return { status: 404, json: { ok: false } };
  };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => cfg, now: () => clock, mediactl, sleep: async () => {},
    mainRead: async (sql) => sql.includes("media_plays") ? [{ rating_key: "1", n: 2 }] : [{ rating_key: "1", server_plays: 3 }],
    tautulli: { configured: () => true, call: async (cmd, args) => { tautCalls.push({ cmd, ...args }); return { data: [{ rating_key: "1", play_count: 7 }, { rating_key: "5", play_count: 99 }] }; } },
    log: { log: (s) => logs.push(s), error: (s) => logs.push(s) }, ...overrides });
  t.after(async () => { await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { catalog, cfg, api, calls, logs, tautCalls, reads, setClock: (v) => { clock = v; }, dir };
}
function semverOf(v) { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || "1.7.0"); return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0; }
const timeoutError = () => Object.assign(new Error("The media-control service can't be reached (timeout)."), { status: 502, refuse: true });

test("full catalog sync filters sections/ratings, pages all types, stores bounded crow fields and safe shelves", async (t) => {
  const h = await setup(t);
  h.api.rows[0].file = "SHOULD_NOT_BE_STORED";
  h.api.rows[0].summary = "s".repeat(1100);
  h.api.rows[0].cast = Array.from({ length: 20 }, (_, i) => "Performer " + i);
  const result = await h.catalog.sync({ full: true });
  assert.equal(result.ok, true);
  assert.equal(result.full, true);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.blocked, { "1:X": 1 });
  const rows = await h.catalog.rows();
  assert.deepEqual(rows.map((r) => r.key).sort(), ["1", "2", "20", "21", "3"]);
  assert.equal(rows.find((r) => r.key === "1").summary.length, 1000);
  assert.equal(rows.find((r) => r.key === "1").cast.length, 6);
  assert.equal(rows.find((r) => r.key === "1").pad_plays, 2);
  assert.equal(rows.find((r) => r.key === "1").server_plays, 7);
  assert.equal(JSON.stringify(await h.catalog.exportSnapshot()).includes("SHOULD_NOT_BE_STORED"), false);
  assert.equal(JSON.stringify(rows).includes("Filtered Marker"), false);
  assert.equal(JSON.stringify(rows).includes("Offstage Sample"), false);
  const state = await h.catalog.status();
  assert.equal(state.ready, true);
  assert.equal(state.version, "1.7.0");
  assert.deepEqual(state.sections.filter((s) => s.policy !== "allowed").map((s) => s.title), ["(hidden)", "(hidden)"]);
  assert.deepEqual(new Set(h.tautCalls.map((r) => r.section_id)), new Set(["1", "2"]));
  assert.equal(h.calls.some((p) => p.includes("type=4")), true);
  assert.equal(h.calls.some((p) => p.includes("start=2")), true);
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Quiet Comedies", 2]]);
  assert.equal(h.logs.join("\n").includes("Marker"), false);
});

test("delta uses overlap cursor; full pass removes absent rows only after success", async (t) => {
  const h = await setup(t);
  await h.catalog.sync({ full: true });
  h.setClock(AT + 3600000);
  h.api.rows = [row(7, "Morning Letter", { updated: Math.floor((AT + 1800000) / 1000) })];
  await h.catalog.sync();
  assert.equal(h.calls.some((p) => p.includes("since=" + (Math.floor(AT / 1000) - 1))), true);
  assert.equal((await h.catalog.getByKeys(["1", "7"])).length, 2);
  h.api.error = true;
  assert.equal((await h.catalog.sync({ full: true })).ok, false);
  assert.equal((await h.catalog.getByKeys(["1", "7"])).length, 2);
  assert.equal((await h.catalog.status()).full_at, AT);
  h.api.error = false;
  await h.catalog.sync({ full: true });
  assert.deepEqual((await h.catalog.rows()).map((r) => r.key), ["7"]);
});

test("policy changes and changed blocked settings take effect on reads and force full sync", async (t) => {
  const h = await setup(t);
  await h.catalog.sync();
  h.cfg.clerk_block_ratings += ",PG";
  assert.deepEqual((await h.catalog.getByKeys(["1", "2", "3"])).map((r) => r.key), ["2", "3"]);
  assert.equal((await h.catalog.search("Quiet Harbor")).some((r) => r.key === "1"), false);
  h.setClock(AT + 60000);
  assert.equal((await h.catalog.sync()).full, true);
  assert.equal((await h.catalog.read("SELECT key FROM plex_catalog WHERE key='1'")).length, 0);
  h.api.sections[1].policy = "off";
  await h.catalog.sync();
  assert.equal((await h.catalog.getByKeys(["20", "21"])).length, 0);
});

test("ready fails closed for old mediactl, empty reviewed allow-list, stale full sync and broken file", async (t) => {
  const h = await setup(t);
  assert.equal((await h.catalog.status()).ready, false);
  h.api.old = true;
  assert.equal((await h.catalog.sync()).error, "needs media-control 1.7.0");
  assert.equal((await h.catalog.status()).requires_1_7, true);
  h.api.old = false;
  await h.catalog.sync();
  h.setClock(AT + 3 * 86400000 + 1);
  assert.equal((await h.catalog.status()).ready, false);
  h.setClock(AT + 60000);
  h.api.allowed = false;
  assert.equal((await h.catalog.sync()).error, "set MEDIACTL_SECTIONS");
  assert.equal((await h.catalog.rows()).length, 0);
  assert.deepEqual((await h.catalog.shelves()).shelves, []);
  const bad = path.join(h.dir, "broken.db");
  fs.writeFileSync(bad, "not a SQLite file");
  const broken = createCatalog({ file: bad, settings: () => ({}) });
  assert.equal((await broken.status()).ready, false);
  await broken.close();
});

test("maintenance interval skips every provider call; dry count leaves rows and sync markers unchanged", async (t) => {
  const h = await setup(t);
  h.setClock(Date.UTC(2026, 10, 5, 3, 40));
  assert.equal((await h.catalog.sync()).skipped, "maintenance");
  assert.deepEqual(h.calls, []);
  assert.equal(quiet(Date.UTC(2026, 10, 5, 4, 19, 59)), true);
  assert.equal(quiet(Date.UTC(2026, 10, 5, 4, 20)), false);
  h.setClock(AT);
  const r = await h.catalog.sync({ dry: true });
  assert.equal(r.received, 5);
  assert.equal((await h.catalog.rows()).length, 0);
  assert.equal((await h.catalog.status()).at, null);
  assert.deepEqual(h.tautCalls, []);
});

test("FTS self-test and LIKE fallback search, filters, strict final key re-reads", async (t) => {
  for (const noFts of [false, true]) {
    const h = await setup(t, { noFts });
    await h.catalog.importSnapshot(snapshot());
    assert.equal((await h.catalog.status()).fts, !noFts);
    assert.deepEqual((await h.catalog.search("sunrise", { kind: "episode", show_key: "20" })).map((r) => r.key), ["21"]);
    assert.deepEqual(await h.catalog.search("sunrise", { kind: "movie" }), []);
    assert.deepEqual((await h.catalog.getByKeys(["3", "5", "1", "4"])).map((r) => r.key), ["3", "1"]);
    assert.deepEqual((await h.catalog.search("Comedies")).map((r) => r.key).sort(), ["1", "2"]);
  }
});

test("readonly queries have isolated statement budget and recover after interrupt", async (t) => {
  const { catalog } = await setup(t);
  await catalog.init();
  await assert.rejects(catalog.read("CREATE TABLE forbidden(x)"), /readonly/i);
  await assert.rejects(catalog.read("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n", [], { budgetMs: 1 }), { code: "too_broad" });
  assert.equal((await catalog.read("SELECT 1 AS n"))[0].n, 1);
});

test("snapshot import/export strips denied metadata and unknown fields, preserves safe shelf membership", async (t) => {
  const { catalog } = await setup(t);
  await assert.rejects(catalog.importSnapshot({ ...snapshot(), allow_list_set: false }), { code: "bad_snapshot" });
  await catalog.importSnapshot(snapshot());
  const out = await catalog.exportSnapshot();
  assert.equal(out.rows.length, 5);
  assert.equal(JSON.stringify(out).includes("Hidden fixture name"), false);
  assert.equal(JSON.stringify(out).includes("Only Denied Collection"), false);
  assert.equal(JSON.stringify(out).includes("Filtered Marker"), false);
  assert.deepEqual(out.shelves[0].members, ["1", "2"]);
  await catalog.importSnapshot(out);
  assert.deepEqual((await catalog.getByKeys(["1"]))[0].shelves, ["Quiet Comedies"]);
});

test("more than SQLite's conservative bind limit uses chunked membership reads", async (t) => {
  const { catalog } = await setup(t);
  const data = snapshot();
  data.rows = Array.from({ length: 1200 }, (_, i) => row(1000 + i, "Synthetic film " + i));
  data.shelves = [{ key: "80", name: "Fixture Shelf", members: data.rows.map((r) => r.key) }];
  await catalog.importSnapshot(data);
  const result = await catalog.rows({ kind: "movie" });
  assert.equal(result.length, 1200);
  assert.equal(result.every((r) => r.shelves[0] === "Fixture Shelf"), true);
});

test("dryCount reads policy counts only without creating a database or exposing hidden section names", async (t) => {
  const h = await setup(t);
  assert.equal(fs.existsSync(h.catalog.file), false);
  const result = await h.catalog.dryCount();
  assert.equal(result.allowed_count, 6);
  assert.deepEqual(h.calls, ["/sections"]);
  assert.equal(fs.existsSync(h.catalog.file), false);
  assert.equal(JSON.stringify(result).includes("Hidden fixture name"), false);
});

test("admin actions require current admin and same-site POST; a full sync responds while the worker runs", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const h = await setup(t, {
    permissions: { can: (u, key) => !!u && u.class === "Admin" && key === "media.admin" },
    guard: { sameSite: (req) => req.get("Origin") === "https://fixture.invalid" },
    mediactl: async (_method, route) => { await waiting; return { status: 200, json: route === "/sections" ? { ok: true, allow_list_set: true, sections: [] } : { ok: true, version: "1.7.0" } }; },
  });
  const express = require("express"), app = express();
  app.use(express.json());
  h.catalog.register(app, { noTimers: true, addUser: (req, _res, next) => { req.user = req.get("Fixture-Admin") === "yes" ? { class: "Admin" } : null; next(); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/media/admin/catalog")).status, 403);
  assert.equal((await fetch(base + "/api/media/admin/catalog/sync", { method: "POST", headers: { "Fixture-Admin": "yes" } })).status, 403);
  const r = await fetch(base + "/api/media/admin/catalog/sync", { method: "POST", headers: { "Fixture-Admin": "yes", Origin: "https://fixture.invalid" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, started: true, syncing: true });
  release();
  await h.catalog.sync();
  const state = await (await fetch(base + "/api/media/admin/catalog", { headers: { "Fixture-Admin": "yes" } })).json();
  assert.equal(state.ok, true);
  assert.equal(state.ready, true);
});

test("snapshot export can open read-only and stale source timestamps remain stale on import", async (t) => {
  const h = await setup(t);
  await h.catalog.importSnapshot(snapshot());
  const ro = createCatalog({ file: h.catalog.file, readOnly: true, settings: () => h.cfg, now: () => AT });
  const copy = await ro.exportSnapshot();
  assert.equal(copy.rows.length, 5);
  await assert.rejects(ro.write(() => {}), { code: "readonly" });
  await ro.close();
  copy.full_at = AT - 4 * 86400000;
  await h.catalog.importSnapshot(copy);
  assert.equal((await h.catalog.status()).ready, false);
});

test("full passes with the same wall clock have distinct seen markers", async (t) => {
  const h = await setup(t);
  await h.catalog.sync({ full: true });
  h.api.rows = [row(7, "Morning Letter")];
  await h.catalog.sync({ full: true });
  assert.deepEqual((await h.catalog.rows()).map((r) => r.key), ["7"]);
});

test("snapshot tool reads current custom rating policy read-only without initializing application state", async (t) => {
  const h = await setup(t);
  await h.catalog.importSnapshot(snapshot());
  const sqlite3 = require("sqlite3"), settingsFile = path.join(h.dir, "myapp.db");
  const db = await new Promise((resolve, reject) => { const d = new sqlite3.Database(settingsFile, (e) => e ? reject(e) : resolve(d)); });
  const run = (sql, args) => new Promise((resolve, reject) => db.run(sql, args || [], (e) => e ? reject(e) : resolve()));
  await run("CREATE TABLE media_settings(key TEXT PRIMARY KEY,value TEXT)");
  await run("INSERT INTO media_settings VALUES ('clerk_block_ratings',?)", [JSON.stringify("X,XXX,AO,R18,R18+,PG")]);
  await new Promise((resolve) => db.close(resolve));
  const before = fs.readFileSync(settingsFile);
  const { main } = require("../tools/plexcatalog-snapshot");
  const out = path.join(h.dir, "snapshot.json");
  await main(["export", h.catalog.file, out, "--settings-db", settingsFile]);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).rows.some((r) => r.key === "1"), false);
  assert.deepEqual(fs.readFileSync(settingsFile), before);
});

test("a delta immediately revokes a formerly safe key when its returned row becomes blocked, denied or malformed", async (t) => {
  for (const change of [{ content_rating: "X" }, { section: "3" }, { title: "" }]) {
    const h = await setup(t);
    await h.catalog.sync();
    h.setClock(AT + 3600000);
    Object.assign(h.api.rows.find((r) => r.key === "1"), change, { updated: Math.floor((AT + 1800000) / 1000) });
    const result = await h.catalog.sync();
    assert.equal(result.full, false);
    assert.deepEqual(await h.catalog.getByKeys(["1"]), []);
    assert.equal((await h.catalog.search("Quiet Harbor")).some((r) => r.key === "1"), false);
    assert.equal((await h.catalog.exportSnapshot()).rows.some((r) => r.key === "1"), false);
    assert.equal((await h.catalog.read("SELECT key FROM plex_catalog_fts WHERE key='1'")).length, 0);
    assert.equal((await h.catalog.read("SELECT key FROM plex_shelf_members WHERE key='1'")).length, 0);
    assert.equal((await h.catalog.read("SELECT key FROM plex_catalog_genres WHERE key='1'")).length, 0);
  }
});

test("blocked or absent parent shows cannot leak through unrated episode rows in imports, reads or deltas", async (t) => {
  const h = await setup(t);
  const seed = snapshot();
  seed.rows.find((r) => r.key === "20").content_rating = "X";
  seed.rows.find((r) => r.key === "21").genres = ["Orphan Genre"];
  await h.catalog.importSnapshot(seed);
  assert.deepEqual(await h.catalog.getByKeys(["20", "21"]), []);
  assert.equal((await h.catalog.shelves()).genres.includes("Orphan Genre"), false);
  assert.equal((await h.catalog.read("SELECT key FROM plex_catalog WHERE key='21'")).length, 0);
  await h.catalog.importSnapshot(snapshot());
  h.cfg.clerk_block_ratings += ",TV-14";
  assert.deepEqual(await h.catalog.getByKeys(["20", "21"]), []);
  assert.deepEqual(await h.catalog.search("First Shift"), []);
  assert.equal((await h.catalog.exportSnapshot()).rows.some((r) => ["20", "21"].includes(r.key)), false);
  h.cfg.clerk_block_ratings = "X,XXX,AO,R18,R18+";
  h.setClock(AT + 3600000);
  h.api.rows.find((r) => r.key === "20").content_rating = "X";
  h.api.rows.find((r) => r.key === "20").updated = Math.floor((AT + 1800000) / 1000);
  const delta = await h.catalog.sync();
  assert.equal(delta.full, false);
  assert.deepEqual(await h.catalog.getByKeys(["20", "21"]), []);
  assert.equal((await h.catalog.read("SELECT key FROM plex_catalog_fts WHERE key IN ('20','21')")).length, 0);
  assert.equal((await h.catalog.read("SELECT key FROM plex_catalog WHERE key='21'")).length, 0);
});

// 1.99alq train3 review: the shelves listing's two aggregates (every visible row's genres, each shelf's visible members) scan the
// whole library - under the suite's load the 210k-row case below went past the 400 ms search budget ('too_broad'). They run on
// a budget of their own, and the answer is kept until the catalog changes (any write) or the block list does.
test("shelves' aggregates run on their own budget (a caller's read keeps the search cap), once per catalog change and block list", async (t) => {
  const { SHELVES_BUDGET_MS, SEARCH_BUDGET_MS } = require("../plexcatalog");
  const armed = [], aggregate = (j) => /FROM plex_catalog_genres g|FROM plex_shelves sh/.test(j.sql);
  const h = await setup(t, { onRead: (job) => armed.push(job) });
  await h.catalog.sync({ full: true });
  const names = (r) => r.shelves.map((s) => [s.name, s.count]);
  armed.length = 0;
  const first = await h.catalog.shelves();
  assert.deepEqual(names(first), [["Quiet Comedies", 2]]);
  assert.ok(Number(SHELVES_BUDGET_MS) > SEARCH_BUDGET_MS, "a budget of their own, longer than a search's");
  assert.deepEqual(armed.filter(aggregate).map((j) => j.budgetMs), [SHELVES_BUDGET_MS, SHELVES_BUDGET_MS], "the genres + shelves aggregates");
  armed.length = 0;
  await h.catalog.read("SELECT 1 AS n", [], { budgetMs: 60000 });
  assert.deepEqual(armed.map((j) => j.budgetMs), [SEARCH_BUDGET_MS], "a caller can't ask for more than the search budget");
  armed.length = 0;
  first.shelves.push({ name: "changed by a caller", count: 9 });
  first.genres.push("Changed By A Caller");
  const again = await h.catalog.shelves();
  assert.deepEqual(names(again), [["Quiet Comedies", 2]], "asked again: the same answer (a caller's copy changed nothing)");
  assert.equal(again.genres.includes("Changed By A Caller"), false);
  assert.equal(armed.filter(aggregate).length, 0, "...kept: no aggregate read");
  h.cfg.clerk_block_ratings += ",PG";
  armed.length = 0;
  assert.deepEqual(names(await h.catalog.shelves()), [["Quiet Comedies", 1]], "the block list changes: what it hides is gone at once");
  assert.equal(armed.filter(aggregate).length, 2);
  h.cfg.clerk_block_ratings = "X,XXX,AO,R18,R18+";
  assert.deepEqual(names(await h.catalog.shelves()), [["Quiet Comedies", 2]], "...and back");
  await h.catalog.write((tx) => tx.run("DELETE FROM plex_shelf_members WHERE key='2'"));
  armed.length = 0;
  assert.deepEqual(names(await h.catalog.shelves()), [["Quiet Comedies", 1]], "the catalog changes (a write): computed again");
  assert.equal(armed.filter(aggregate).length, 2);
});

test("shelves aggregates 10k films and 200k episodes without fetching metadata JSON", { timeout: 120000 }, async (t) => {
  const { SHELVES_BUDGET_MS } = require("../plexcatalog");
  const armed = [], aggregate = (j) => /FROM plex_catalog_genres g|FROM plex_shelves sh/.test(j.sql);
  const h = await setup(t, { noFts: true, onRead: (job) => armed.push(job) });
  await h.catalog.importSnapshot(snapshot());
  await h.catalog.write(async (tx) => {
    for (const [n, base, type, section, parent, genre] of [[10000, 1000000, "movie", "1", null, "Scale Cinema"], [200000, 2000000, "episode", "2", "20", "Scale Series"]]) {
      await tx.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at,server_plays,pad_plays)
        SELECT CAST(?+x AS TEXT),?,'Synthetic work','synthetic work',?,'window office',?,'PG',
          json_object('key',CAST(?+x AS TEXT),'type',?,'section',?,'title','Synthetic work','show_key',?,'content_rating','PG','summary',?),1,0,0 FROM n`,
      [n, base, type, parent, section, base, type, section, parent, "s".repeat(type === "episode" ? 500 : 512)]);
      await tx.run("INSERT INTO plex_catalog_genres(key,genre) SELECT key,? FROM plex_catalog WHERE CAST(key AS INTEGER)>? AND CAST(key AS INTEGER)<=?", [genre, base, base + n]);
    }
  });
  const { performance } = require("perf_hooks");
  armed.length = 0;
  const before = performance.now();
  const result = await h.catalog.shelves();
  const elapsed = performance.now() - before;
  assert.equal(result.catalog.ready, true);
  assert.ok(result.genres.includes("Scale Cinema"));
  assert.ok(result.genres.includes("Scale Series"));
  assert.equal((await h.catalog.status()).count, 210005);
  // 1.99alq train3 review: no wall-clock ceiling here (the suite's load is not the code's) - the two aggregates run on the
  // shelves budget, and a second ask with nothing changed reads no aggregate at all
  assert.deepEqual(armed.filter(aggregate).map((j) => j.budgetMs), [SHELVES_BUDGET_MS, SHELVES_BUDGET_MS]);
  t.diagnostic("shelves: 210005 rows with500/512-character summaries, " + elapsed.toFixed(1) + "ms");
  armed.length = 0;
  const kept = await h.catalog.shelves();
  assert.deepEqual(kept.genres, result.genres);
  assert.equal(armed.filter(aggregate).length, 0, "asked again: the kept answer");
  h.cfg.clerk_block_ratings += ",TV-14";
  assert.equal((await h.catalog.shelves()).genres.includes("Scale Series"), false);
});

// ── 1.99?? catfix (prod 2026-11-08: the clerk turned on, the card said "Last sync: Never" / "catalog source unavailable") ──
// Proven on prod (read-only, the site's own mediactl client): every catalog page answers in under 4 s, but mediactl 1.7.0
// answers a section's /collections only after walking every collection's members, and the largest movie section has 1381
// collections whose member reads take Plex ~2-3 s each - that walk did not answer within 15 minutes (about an hour), while
// the site's client gave up after 15 s with no byte received. The run threw away the whole section it had just read (no
// "at", no "full_at"), and every next run started over and failed at the same read.
test("catfix: a 1.7.0 whole-section /collections walk that takes too long skips that section's shelves - the sync still finishes", async (t) => {
  const h = await setup(t);
  h.api.walkMs = 30000;   // a small section's whole walk (one with 51 collections took 48 s on prod): fits
  const r = await h.catalog.sync({ full: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cols = h.reads.filter((x) => x.route.startsWith("/collections"));
  assert.equal(cols.length, 2, "one whole-section answer per allowed section");
  assert.ok(cols.every((x) => x.timeout >= 60000 && x.timeout <= 300000), "1.7.0's whole answer gets minutes, not 15 s: " + cols.map((x) => x.timeout));
  const pages = h.reads.filter((x) => x.route.startsWith("/catalog"));
  assert.ok(pages.every((x) => x.timeout >= 30000 && x.timeout <= 120000), "a page keeps a page's timeout: " + pages.map((x) => x.timeout));
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Quiet Comedies", 2]]);
  let st = await h.catalog.status();
  assert.deepEqual([st.ready, st.error, st.at, st.full_at, st.shelves_skipped], [true, null, AT, AT, []]);
  // the big section's walk (about an hour on prod): no answer in time - its shelves stay as they were, the sync finishes
  h.api.walkMs = 3600000;
  h.calls.length = 0;
  h.setClock(AT + 86400000);
  const big = await h.catalog.sync({ full: true });
  assert.equal(big.ok, true, JSON.stringify(big));
  assert.equal(h.calls.filter((c) => c.startsWith("/collections?section=1")).length, 1, "no second try of an hour-long walk (1.7.0 keeps walking after the site leaves)");
  st = await h.catalog.status();
  assert.deepEqual([st.ready, st.error, st.full_at], [true, null, AT + 86400000]);
  assert.deepEqual(st.shelves_skipped.map((x) => x.section), ["1", "2"]);
  assert.match(st.shelves_skipped[0].why, /^no answer within \d+ s$/);
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Quiet Comedies", 2]], "the shelves read before are kept");
  assert.ok(h.logs.some((l) => /collections of section 1 \(movies\) not refreshed: no answer within \d+ s - media-control 1\.7\.1 reads them a page at a time/.test(l)), h.logs.join("\n"));
});

test("catfix: shelves are read by the daily full sweep only - a delta never walks /collections", async (t) => {
  const h = await setup(t);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  h.calls.length = 0;
  h.setClock(AT + 3600000);
  const delta = await h.catalog.sync();
  assert.deepEqual([delta.ok, delta.full], [true, false]);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("/collections")), [], "a large section's shelves are thousands of slow Plex reads");
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Quiet Comedies", 2]], "the sweep's shelves stay");
});

test("catfix: mediactl 1.7.1 answers /collections a page of shelves at a time; every page is stored, a repeated shelf once", async (t) => {
  const h = await setup(t);
  h.api.version = "1.7.1";
  h.api.walkMs = 4 * 60000;   // a whole walk would still be slow - the site never asks 1.7.1 for one
  const shelves = Array.from({ length: 23 }, (_, n) => ({ key: String(900 + n), name: "Paged Shelf " + String(n).padStart(2, "0"), members: ["1", "2"] }));
  shelves.splice(10, 0, { ...shelves[9] });   // Plex's list moved between two pages: the last shelf of page 1 opens page 2 again
  // the fake pages the list; a paged read is quick, so it isn't held to the whole walk's time
  h.api.hook = (route, opts) => {
    const u = new URL(route, "http://fixture.local");
    if (u.pathname !== "/collections") return undefined;
    assert.ok(u.searchParams.has("size"), "1.7.1 is asked for pages");
    assert.ok(opts.timeout >= 60000 && opts.timeout <= 300000, "a page of shelves gets a page's timeout: " + opts.timeout);
    const start = Number(u.searchParams.get("start")), size = Number(u.searchParams.get("size"));
    assert.ok(size >= 1 && size <= 50, "a bounded page: " + size);
    const page = shelves.slice(start, start + size);
    return { status: 200, json: { ok: true, collections: page, total: shelves.length, next: start + page.length < shelves.length ? start + page.length : null } };
  };
  const r = await h.catalog.sync({ full: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.calls.filter((c) => c.startsWith("/collections?section=1")).length >= 3, "more than one page for section 1");
  const names = (await h.catalog.shelves()).shelves.map((s) => s.name);
  assert.deepEqual(names, shelves.filter((s, i) => i !== 10).map((s) => s.name), "every page's shelves, the repeated one once");
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_shelf_members"))[0].n, 23 * 2);
  // the next full sweep replaces the section's shelves (page 1 clears them), it doesn't pile them up
  shelves.splice(0, shelves.length, { key: "990", name: "Only Shelf Left", members: ["1"] });
  h.setClock(AT + 86400000);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Only Shelf Left", 1]]);
});

test("catfix: a read that fails for a passing reason is tried again after a wait; an answer that can't change isn't", async (t) => {
  const slept = [];
  const h = await setup(t, { sleep: async (ms) => { slept.push(ms); } });
  let fails = 2;
  h.api.hook = (route) => {
    if (route.includes("section=1&type=1&start=2") && fails > 0) { fails--; throw timeoutError(); }
    return undefined;
  };
  const r = await h.catalog.sync({ full: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.calls.filter((c) => c.includes("section=1&type=1&start=2")).length, 3, "two failures, then the page");
  assert.deepEqual(slept.filter((ms) => ms > 250), [2000, 10000], "backing off between tries");
  assert.equal((await h.catalog.getByKeys(["3"])).length, 1, "the page that failed twice is in the catalog");
  for (const status of [429, 500, 502, 503, 504]) {
    const x = await setup(t, { sleep: async () => {} });
    let left = 1;
    x.api.hook = (route) => route.includes("type=4") && left-- > 0 ? { status, json: { ok: false, error: "busy" } } : undefined;
    assert.equal((await x.catalog.sync({ full: true })).ok, true, status + " is tried again");
  }
  // a refusal that won't change by asking again (a section no longer allowed, a bad request): no second try
  const y = await setup(t, { sleep: async (ms) => { if (ms > 250) slept.push("y" + ms); } });
  y.api.hook = (route) => route.includes("type=4") ? { status: 404, json: { ok: false, error: "Not in the Plex library" } } : undefined;
  const no = await y.catalog.sync({ full: true });
  assert.equal(no.ok, false);
  assert.equal(y.calls.filter((c) => c.includes("type=4")).length, 1);
  assert.equal(slept.some((v) => String(v).startsWith("y")), false);
  assert.equal(no.error, "catalog source unavailable: episode page from 0 of section 2 (shows) - media-control answered 404");
});

test("catfix: the last sync error says which read failed, how, after how many tries - and when", async (t) => {
  const h = await setup(t);
  // a catalog page that never answers: tried again, then the sweep stops there (and carries on later). (1.99?? catfix review:
  // a shelves page no longer stops the sweep - its section keeps the shelves it had - so this reads a catalog page.)
  h.api.hook = (route) => route.includes("section=2&type=4") ? Promise.reject(timeoutError()) : undefined;
  const r = await h.catalog.sync({ full: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /^catalog source unavailable: episode page from 0 of section 2 \(shows\) - no answer within \d+ s \(4 tries\)$/);
  const st = await h.catalog.status();
  assert.equal(st.error, r.error);
  assert.equal(st.error_at, AT);
  assert.equal(st.at, null, "nothing finished yet");
  const x = await setup(t);
  x.api.hook = (route) => route === "/sections" ? { status: 503, json: { ok: false } } : undefined;
  assert.equal((await x.catalog.sync()).error, "catalog source unavailable: the section list - media-control answered 503 (4 tries)");
  const y = await setup(t);
  y.api.hook = (route) => route.includes("type=2") ? { status: 200, json: { ok: true, rows: "not a list" } } : undefined;
  assert.equal((await y.catalog.sync()).error, "catalog source unavailable: show page from 0 of section 2 (shows) - media-control's answer wasn't usable");
  const z = await setup(t);
  z.api.hook = (route) => route.startsWith("/catalog") ? Promise.reject(Object.assign(new Error("The media-control service isn't configured."), { status: 503, extra: { code: "encoder_down" } })) : undefined;
  assert.equal((await z.catalog.sync()).error, "catalog source unavailable: movie page from 0 of section 1 (movies) - media-control isn't configured on the site");
  for (const l of [...h.logs, ...x.logs, ...y.logs, ...z.logs]) assert.equal(/Quiet Harbor|Window Office|Fixture Cinema|Fixture Series/.test(l), false, "no titles in the log: " + l);
  // a successful sync clears the error and its time
  h.api.hook = null;
  h.setClock(AT + 60000);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  const ok = await h.catalog.status();
  assert.equal(ok.error, null); assert.equal(ok.error_at, null); assert.equal(ok.ready, true);
});

test("catfix: a full sweep that stops keeps what it read and the next run carries on from that page; its end still removes what Plex dropped", async (t) => {
  const h = await setup(t);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);   // full_at = AT
  // later that day "Sync now" (a full sweep) loses media-control at section 2's episodes - and Plex has since dropped key 3
  h.setClock(AT + 3600000);
  h.api.rows = h.api.rows.filter((r) => r.key !== "3");
  let down = true;
  h.api.hook = (route) => down && route.includes("section=2&type=4") ? { status: 503, json: { ok: false } } : undefined;
  const failed = await h.catalog.sync({ full: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "catalog source unavailable: episode page from 0 of section 2 (shows) - media-control answered 503 (4 tries)");
  const mid = await h.catalog.status();
  assert.deepEqual([mid.at, mid.full_at], [AT, AT], "the unfinished sweep sets neither");
  assert.deepEqual(mid.progress, { started: AT + 3600000, done: 1, total: 2, received: 3 }, "section 1 done, section 2's shows read");
  assert.equal((await h.catalog.getByKeys(["3"])).length, 1, "an unfinished sweep removes nothing");
  assert.ok(h.logs.some((l) => /sync failed: .*kept: 1 of 2 sections done/.test(l)), h.logs.join("\n"));
  // the next run - a plain timer tick on the same day, which would otherwise be a delta - finishes that sweep
  down = false; h.calls.length = 0;
  h.setClock(AT + 7200000);
  const resumed = await h.catalog.sync();
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.full, true); assert.equal(resumed.resumed, true);
  assert.equal(h.calls.some((c) => c.includes("section=1")), false, "section 1 is not read again: " + h.calls.join(" "));
  assert.equal(h.calls.some((c) => c.includes("section=2&type=2")), false, "nor section 2's shows");
  assert.ok(h.calls.some((c) => c.includes("section=2&type=4&start=0")), "it carries on at the episode page that failed");
  assert.equal(h.calls.some((c) => c.includes("since=")), false, "a full read, no delta filter");
  assert.deepEqual(await h.catalog.getByKeys(["3"]), [], "the finished sweep removes what Plex no longer has");
  const done = await h.catalog.status();
  assert.deepEqual([done.at, done.full_at], [AT + 3600000, AT + 3600000], "the sweep's own start (the next delta reads everything changed since)");
  assert.deepEqual([done.error, done.progress, done.ready], [null, null, true]);
  assert.deepEqual((await h.catalog.rows()).map((r) => r.key).sort(), ["1", "2", "20", "21"]);
  assert.deepEqual((await h.catalog.shelves()).shelves.map((s) => [s.name, s.count]), [["Quiet Comedies", 2]]);
  // and the next tick is an ordinary delta again
  h.setClock(AT + 3 * 3600000); h.calls.length = 0;
  const delta = await h.catalog.sync();
  assert.deepEqual([delta.ok, delta.full, delta.resumed], [true, false, false]);
  assert.ok(h.calls.some((c) => c.includes("since=" + (Math.floor((AT + 3600000) / 1000) - 1))));
});

test("catfix: a sweep stopped part-way through a page run or by the maintenance window carries on at that page", async (t) => {
  const h = await setup(t);
  h.setClock(Date.UTC(2026, 10, 6, 3, 30));
  h.api.rows.push(row(8, "Lantern Courier"), row(9, "Paper Garden"));   // section 1: pages at 0, 2, 4, 6 (two rows a page)
  let quietAt = null;
  h.api.hook = (route) => {
    if (quietAt == null && route.includes("section=1&type=1&start=4")) { quietAt = Date.UTC(2026, 10, 6, 3, 45); h.setClock(quietAt); }
    return undefined;
  };
  const r = await h.catalog.sync({ full: true });
  assert.deepEqual([r.ok, r.error], [false, "maintenance window"]);
  const st = await h.catalog.status();
  assert.equal(st.progress.done, 0);
  h.api.hook = null; h.calls.length = 0;
  h.setClock(Date.UTC(2026, 10, 6, 4, 30));
  const again = await h.catalog.sync();
  assert.equal(again.ok, true, JSON.stringify(again));
  const first = h.calls.find((c) => c.startsWith("/catalog"));
  // 1.99?? catfix review: from the page before the one the window stopped (re-read, so a title Plex removed while the sweep
  // waited can't shift another past the cursor) - not the section's first
  assert.equal(first, "/catalog?section=1&type=1&start=4&size=500", "the page before the one the window stopped, not the section's first");
  assert.equal(h.calls.some((c) => c.includes("section=1&type=1&start=0")), false);
  assert.equal((await h.catalog.getByKeys(["1", "8", "9"])).length, 3);
});

test("catfix: an unfinished sweep is started over when the block list changed or it is more than a day old; a dry run never touches it", async (t) => {
  for (const change of ["block", "age"]) {
    const h = await setup(t);
    h.api.hook = (route) => route.includes("type=4") ? { status: 404, json: { ok: false } } : undefined;
    assert.equal((await h.catalog.sync({ full: true })).ok, false);
    assert.notEqual((await h.catalog.status()).progress, null);
    h.api.hook = null; h.calls.length = 0;
    const dry = await h.catalog.sync({ dry: true });
    assert.equal(dry.ok, true);
    assert.ok(h.calls.some((c) => c.includes("section=1&type=1&start=0")), "a dry run reads everything");
    assert.notEqual((await h.catalog.status()).progress, null, "...and leaves the unfinished sweep as it was");
    h.calls.length = 0;
    if (change === "block") { h.cfg.clerk_block_ratings += ",NC-17"; h.setClock(AT + 60000); }
    else h.setClock(AT + 27 * 3600000);
    const r = await h.catalog.sync();
    assert.equal(r.ok, true); assert.equal(r.resumed, false);
    assert.ok(h.calls.some((c) => c.includes("section=1&type=1&start=0")), change + ": started over");
  }
});

test("catfix: the timer looks again sooner after a run that failed for a passing reason", () => {
  const { nextTickMin } = require("../plexcatalog");
  const cfg = { catalog_sync_min: 60 };
  assert.equal(nextTickMin(cfg, false, null), 5, "every switch off: the idle look");
  assert.equal(nextTickMin(cfg, true, { ok: true }), 60);
  assert.equal(nextTickMin(cfg, true, { ok: false, retry: true }), 10);
  assert.equal(nextTickMin(cfg, true, { ok: false, retry: false }), 60, "needs a newer mediactl: nothing to gain by asking sooner");
  assert.equal(nextTickMin(cfg, true, null), 60, "the maintenance window: no run, the usual wait");
  assert.equal(nextTickMin({ catalog_sync_min: 10 }, true, { ok: false, retry: true }), 10);
  assert.equal(nextTickMin({ catalog_sync_min: 5 }, true, { ok: true }), 10, "never more often than every 10 minutes");
});

// 1.99?? catfix review: every client-side failure but "not configured" read as "can't be reached" and was tried 4 times - a
// certificate pin that no longer matches said "media-control can't be reached (4 tries)" and its real cause appeared nowhere;
// and the timer came back every 10 minutes even for failures asking again can't fix.
test("catfix review: a failure asking again can't fix is named and tried once; an unreachable service says why", async (t) => {
  const once = async (err, route = "/sections") => {
    const slept = [];
    const h = await setup(t, { sleep: async (ms) => { slept.push(ms); } });
    h.api.hook = (r) => r === route ? Promise.reject(err()) : undefined;
    const r = await h.catalog.sync();
    return { r, tries: h.calls.filter((c) => c === route).length, slept, logs: h.logs, st: await h.catalog.status() };
  };
  const pin = await once(() => Object.assign(new Error("media-control certificate doesn't match MEDIACTL_TLS_SHA256"), { status: 502 }));
  assert.equal(pin.r.error, "catalog source unavailable: the section list - media-control's certificate doesn't match MEDIACTL_TLS_SHA256");
  assert.deepEqual([pin.tries, pin.slept, pin.r.retry], [1, [], false], "one try, no sooner look");
  assert.equal(pin.st.error, pin.r.error, "the card says it too");
  const url = await once(() => Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" }));
  assert.equal(url.r.error, "catalog source unavailable: the section list - MEDIACTL_URL isn't a usable address");
  assert.deepEqual([url.tries, url.r.retry], [1, false]);
  const unset = await once(() => Object.assign(new Error("The media-control service isn't configured."), { status: 503, extra: { code: "encoder_down" } }));
  assert.equal(unset.r.error, "catalog source unavailable: the section list - media-control isn't configured on the site");
  assert.deepEqual([unset.tries, unset.r.retry], [1, false]);
  // passing reasons: tried again, and the cause is named (the error code only - never an address)
  for (const [err, why] of [
    [() => Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:8443"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],                   // the pinned TLS connect
    [() => Object.assign(new Error("The media-control service can't be reached (read ECONNRESET)."), { status: 502, refuse: true }), "ECONNRESET"],
    [() => Object.assign(new Error("The media-control service can't be reached (socket hang up)."), { status: 502, refuse: true }), "connection closed"],
    [() => Object.assign(new Error("The media-control service can't be reached (something new)."), { status: 502, refuse: true }), null],
  ]) {
    const x = await once(err);
    assert.equal(x.r.error, "catalog source unavailable: the section list - media-control can't be reached" + (why ? " (" + why + ")" : "") + " (4 tries)");
    assert.deepEqual([x.tries, x.r.retry], [4, true]);
    assert.equal(/192\.0\.2\.10|8443/.test(x.r.error + x.logs.join("\n")), false, "no address in the error or the log");
  }
  const late = await once(() => Object.assign(new Error("The media-control service can't be reached (timeout)."), { status: 502, refuse: true }));
  assert.match(late.r.error, /^catalog source unavailable: the section list - no answer within \d+ s \(4 tries\)$/);
  assert.equal(late.r.retry, true);
});

// 1.99?? catfix, the next wall after the collections one: the search index's key is an UNINDEXED FTS5 column, so every
// "DELETE FROM plex_catalog_fts WHERE key=?" (one per row written, per revoked key, per shelf member) scans the whole index.
// Measured (synthetic, this box): 5.8 ms a delete at 16k rows, 85 ms at 240k - a 500-row episode page spent ~42 s deleting,
// a full sweep hours; on prod the second sweep read the same section 2.4x slower than the first (8.5 vs 3.5 minutes) as the
// index filled. The index row's rowid is now the Plex key itself, so each write finds its row directly; the end of a sync
// rewrites only the rows whose shelves changed.
const ftsScans = (sqls) => sqls.filter((s) => /plex_catalog_fts\b[^;]*\bWHERE\s+key\b/i.test(s) || /UPDATE plex_catalog_fts SET shelves=''/.test(s));
test("catfix: the search index is keyed by the Plex key (rowid) - writing a page never scans it, a quiet sync rewrites nothing", async (t) => {
  const sqls = [];
  const h = await setup(t, { onWrite: (sql) => sqls.push(sql) });
  h.api.rows.push(...Array.from({ length: 40 }, (_, i) => row(5000 + i, "Synthetic reel " + i)));
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_catalog_fts WHERE rowid<>CAST(key AS INTEGER)"))[0].n, 0, "rowid = key");
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_catalog_fts"))[0].n, (await h.catalog.read("SELECT COUNT(*) AS n FROM plex_catalog"))[0].n);
  assert.deepEqual(ftsScans(sqls), [], "no statement finds an index row by its key column (a whole-index scan each)");
  assert.deepEqual((await h.catalog.search("Synthetic reel 7")).map((r) => r.key).slice(0, 1), ["5007"]);
  assert.deepEqual((await h.catalog.search("Comedies")).map((r) => r.key).sort(), ["1", "2"], "shelf names are searchable");
  // a delta with nothing new: no index row rewritten
  sqls.length = 0;
  h.setClock(AT + 3600000);
  assert.equal((await h.catalog.sync()).full, false);
  assert.deepEqual(sqls.filter((s) => /^\s*(UPDATE|INSERT INTO|DELETE FROM) plex_catalog_fts/.test(s)), [], "nothing changed, nothing rewritten");
  // a revoked row leaves the index by its rowid
  sqls.length = 0;
  h.setClock(AT + 7200000);
  Object.assign(h.api.rows.find((r) => r.key === "5003"), { content_rating: "X", updated: Math.floor((AT + 5400000) / 1000) });
  await h.catalog.sync();
  assert.equal((await h.catalog.search("Synthetic reel 3")).some((r) => r.key === "5003"), false);
  assert.equal(ftsScans(sqls).length, 0, "a delta never scans the index");
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_catalog_fts WHERE rowid=5003"))[0].n, 0);
});

test("catfix: an index built before (rowids not the keys) is rebuilt on open, inside one transaction, and still finds everything", async (t) => {
  const h = await setup(t);
  await h.catalog.importSnapshot(snapshot());
  // the 1.99alq layout: rows inserted without a rowid (1, 2, 3, ...)
  await h.catalog.write(async (tx) => {
    const rows = await tx.all("SELECT key,title,show,summary,genres,shelves,people FROM plex_catalog_fts ORDER BY key DESC");
    await tx.run("DELETE FROM plex_catalog_fts");
    for (const r of rows) await tx.run("INSERT INTO plex_catalog_fts(key,title,show,summary,genres,shelves,people) VALUES (?,?,?,?,?,?,?)", [r.key, r.title, r.show, r.summary, r.genres, r.shelves, r.people]);
  });
  assert.ok((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_catalog_fts WHERE rowid<>CAST(key AS INTEGER)"))[0].n > 0, "the old layout");
  await h.catalog.close();
  const again = createCatalog({ file: h.catalog.file, settings: () => h.cfg, now: () => AT, log: { log: () => {} } });
  try {
  await again.init();
  assert.equal((await again.read("SELECT COUNT(*) AS n FROM plex_catalog_fts WHERE rowid<>CAST(key AS INTEGER)"))[0].n, 0);
  assert.equal((await again.read("SELECT COUNT(*) AS n FROM plex_catalog_fts"))[0].n, 5);
  assert.deepEqual((await again.search("sunrise", { kind: "episode" })).map((r) => r.key), ["21"]);
  assert.deepEqual((await again.search("Comedies")).map((r) => r.key).sort(), ["1", "2"], "the shelf names come back too");
  } finally { await again.close(); }
});

// ── 1.99?? catfix review: shelves can't stop the sweep, paged shelves swap in whole, a resume re-reads the page before its
// cursor, an import ends an unfinished sweep, and the stored tables (not only the read filter) stay clean across a resume ──
/** mediactl 1.7.1's paged /collections for section 1 (section 2 has none); fail(start) -> true makes that page time out. */
function pagedShelves(h, list, fail = () => false) {
  h.api.version = "1.7.1";
  h.api.hook = (route) => {
    const u = new URL(route, "http://fixture.local");
    if (u.pathname !== "/collections") return undefined;
    const start = Number(u.searchParams.get("start")), size = Number(u.searchParams.get("size"));
    if (fail(start)) return Promise.reject(timeoutError());
    const all = u.searchParams.get("section") === "1" ? list() : [];
    const page = all.slice(start, start + size);
    return { status: 200, json: { ok: true, collections: page, total: all.length, next: start + page.length < all.length ? start + page.length : null } };
  };
}
const shelfSet = (prefix, from, members = ["1", "2"]) => Array.from({ length: 12 }, (_, n) => ({ key: String(from + n), name: prefix + " " + String(n).padStart(2, "0"), members }));
const shelfNames = async (h) => (await h.catalog.shelves()).shelves.map((s) => s.name);

test("catfix review: on mediactl 1.7.1 a shelves page that keeps failing skips that section's shelves - the sweep finishes and the next run is a delta", async (t) => {
  const h = await setup(t);
  let shelves = shelfSet("Kept Shelf", 900), failAt = null;
  pagedShelves(h, () => shelves, (start) => start === failAt);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  const before = await shelfNames(h);
  assert.equal(before.length, 12);
  // the next day Plex's collections have changed, and one page of section 1's shelves fails every time
  h.setClock(AT + 86400000); h.calls.length = 0;
  shelves = shelfSet("New Shelf", 950, ["1"]); failAt = 5;
  const r = await h.catalog.sync();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.full, true);
  assert.equal(h.calls.filter((c) => c.startsWith("/collections?section=1&start=5&")).length, 4, "tried again, then given up");
  const st = await h.catalog.status();
  assert.deepEqual([st.ready, st.error, st.full_at, st.progress], [true, null, AT + 86400000, null], "the sweep finished");
  assert.deepEqual(st.shelves_skipped.map((x) => x.section), ["1"]);
  assert.match(st.shelves_skipped[0].why, /^no answer within \d+ s \(4 tries\)$/);
  assert.deepEqual(await shelfNames(h), before, "the section keeps every shelf it had - not the first page of the new ones");
  // the next run is an ordinary delta: titles added to Plex keep arriving
  h.setClock(AT + 86400000 + 3600000); h.calls.length = 0;
  h.api.rows.push(row(9, "Late Arrival", { updated: Math.floor((AT + 86400000 + 1800000) / 1000) }));
  const delta = await h.catalog.sync();
  assert.deepEqual([delta.ok, delta.full, delta.resumed], [true, false, false]);
  assert.equal((await h.catalog.getByKeys(["9"])).length, 1);
  // the day after, the page answers again: the new shelves replace the old ones in one go
  failAt = null; h.setClock(AT + 2 * 86400000);
  assert.equal((await h.catalog.sync()).ok, true);
  assert.deepEqual(await shelfNames(h), shelves.map((s) => s.name));
  assert.deepEqual((await h.catalog.status()).shelves_skipped, []);
});

test("catfix review: paged shelves swap in when the section's last page lands - a sweep stopped part-way still shows the old shelves whole", async (t) => {
  const h = await setup(t);
  let shelves = shelfSet("Kept Shelf", 900), stopAt = null;
  // the maintenance window starts while page `stopAt` is being answered: that page is stored, the next read is the window's
  pagedShelves(h, () => shelves, (start) => { if (start === stopAt) { stopAt = null; h.setClock(Date.UTC(2026, 10, 6, 3, 45)); } return false; });
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  const before = await shelfNames(h);
  h.setClock(Date.UTC(2026, 10, 6, 3, 30));
  shelves = shelfSet("Novel Rack", 950); stopAt = 5;
  const r = await h.catalog.sync();
  assert.deepEqual([r.ok, r.error], [false, "maintenance window"]);
  assert.deepEqual(await shelfNames(h), before, "two of three pages read: the clerk still sees the old shelves, all of them");
  assert.deepEqual((await h.catalog.getByKeys(["1"]))[0].shelves.sort(), before, "...and so does a title's shelf list");
  assert.deepEqual(await h.catalog.search("Novel"), [], "the pages read so far are not searchable yet");
  h.setClock(Date.UTC(2026, 10, 6, 4, 30)); h.calls.length = 0;
  const again = await h.catalog.sync();
  assert.deepEqual([again.ok, again.resumed], [true, true], JSON.stringify(again));
  assert.equal(h.calls.find((c) => c.startsWith("/collections")), "/collections?section=1&start=5&size=5", "it carries on at the page before its cursor");
  assert.deepEqual(await shelfNames(h), shelves.map((s) => s.name), "the last page landed: the new shelves, every page, and none of the old");
  assert.deepEqual((await h.catalog.getByKeys(["1"]))[0].shelves.sort(), shelves.map((s) => s.name));
});

test("catfix review: a resumed sweep re-reads the page before its cursor - a title Plex removed meanwhile can't push another past it", async (t) => {
  const h = await setup(t);
  h.api.rows = [1, 2, 3, 4, 5, 6].map((k) => row(k, "Reel " + k));   // section 1, two a page: 0, 2, 4
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  h.setClock(Date.UTC(2026, 10, 6, 3, 30));
  let stop = true;
  h.api.hook = (route) => { if (stop && route.includes("section=1&type=1&start=2")) { stop = false; h.setClock(Date.UTC(2026, 10, 6, 3, 45)); } return undefined; };
  const r = await h.catalog.sync();
  assert.deepEqual([r.ok, r.error], [false, "maintenance window"]);   // pages 0 and 2 read, the cursor at 4
  h.api.rows = h.api.rows.filter((x) => x.key !== "1");               // Plex drops title 1 while the sweep waits
  h.setClock(Date.UTC(2026, 10, 6, 4, 30)); h.calls.length = 0;
  const again = await h.catalog.sync();
  assert.deepEqual([again.ok, again.resumed], [true, true]);
  assert.equal(h.calls.find((c) => c.startsWith("/catalog")), "/catalog?section=1&type=1&start=2&size=500");
  assert.deepEqual((await h.catalog.read("SELECT key FROM plex_catalog ORDER BY CAST(key AS INTEGER)")).map((x) => x.key), ["1", "2", "3", "4", "5", "6"],
    "title 5 moved from 4 to 3 and is still read (title 1 was read before Plex dropped it: this sweep saw it)");
  assert.equal(again.received, 5, "the page read again counts once (its first count is taken back): page 0's 2, then 2 + 1 from page 2 on");
  assert.equal((await h.catalog.search("Reel 5")).some((x) => x.key === "5"), true);
  h.setClock(Date.UTC(2026, 10, 7, 12));   // the next day's sweep: title 1 goes
  assert.equal((await h.catalog.sync()).full, true);
  assert.deepEqual((await h.catalog.read("SELECT key FROM plex_catalog ORDER BY CAST(key AS INTEGER)")).map((x) => x.key), ["2", "3", "4", "5", "6"]);
});

test("catfix review: a snapshot import ends an unfinished sweep - the next sync doesn't carry it on and keeps the imported rows", async (t) => {
  const h = await setup(t);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  h.setClock(AT + 3600000);
  h.api.hook = (route) => route.includes("section=2&type=4") ? { status: 503, json: { ok: false } } : undefined;
  assert.equal((await h.catalog.sync({ full: true })).ok, false);
  assert.notEqual((await h.catalog.status()).progress, null);
  await h.catalog.importSnapshot(snapshot());
  const st = await h.catalog.status();
  assert.deepEqual([st.progress, st.error, st.error_at, st.shelves_skipped], [null, null, null, []]);
  assert.deepEqual((await h.catalog.read("SELECT value FROM plex_catalog_state WHERE key='error_detail'")).map((x) => x.value), ["null"]);
  h.api.hook = null;
  const next = await h.catalog.sync();
  assert.deepEqual([next.ok, next.resumed], [true, false], JSON.stringify(next));
  assert.deepEqual((await h.catalog.read("SELECT key FROM plex_catalog ORDER BY CAST(key AS INTEGER)")).map((x) => x.key), ["1", "2", "3", "20", "21"]);
  assert.equal((await h.catalog.status()).count, 5);
});

test("catfix review: across a resume the stored tables hold nothing of a section turned off or a blocked rating", async (t) => {
  const h = await setup(t);
  h.api.rows.push(row(22, "Second Shift", { type: "episode", section: "2", show: "Window Office", show_key: "20", season_key: "200", season: 1, episode: 2, content_rating: "X" }));
  assert.equal((await h.catalog.sync({ full: true })).ok, true);
  h.setClock(AT + 3600000);
  let down = true;
  h.api.hook = (route) => down && route.includes("section=2&type=4") ? { status: 503, json: { ok: false } } : undefined;
  assert.equal((await h.catalog.sync({ full: true })).ok, false);      // section 1 done, section 2's shows read
  h.api.sections[0].policy = "off";                                     // between the halves: section 1 is turned off
  h.setClock(AT + 7200000);
  assert.equal((await h.catalog.sync()).ok, false, "still failing at the episodes");
  const mid = await h.catalog.status();
  assert.deepEqual([mid.progress.done, mid.progress.total], [0, 1], "a section no longer allowed isn't counted as read");
  assert.ok(h.logs.some((l) => /kept: 0 of 1 sections done/.test(l)), h.logs.join("\n"));
  down = false;
  h.setClock(AT + 3 * 3600000);
  const done = await h.catalog.sync();
  assert.deepEqual([done.ok, done.resumed], [true, true], JSON.stringify(done));
  assert.equal(done.blocked["2:X"], 1, "the blocked episode on the resumed page is counted");
  const keys = async (sql) => (await h.catalog.read(sql)).map((x) => String(x.k));
  assert.deepEqual(await keys("SELECT key AS k FROM plex_catalog ORDER BY CAST(key AS INTEGER)"), ["20", "21"]);
  assert.deepEqual(await keys("SELECT rowid AS k FROM plex_catalog_fts ORDER BY rowid"), ["20", "21"]);
  assert.deepEqual(await keys("SELECT DISTINCT key AS k FROM plex_catalog_genres ORDER BY CAST(key AS INTEGER)"), ["20", "21"]);
  assert.deepEqual(await keys("SELECT key AS k FROM plex_shelves"), []);
  assert.deepEqual(await keys("SELECT key AS k FROM plex_shelf_members"), []);
  assert.deepEqual(await keys("SELECT key AS k FROM plex_shelves_next UNION ALL SELECT key FROM plex_shelf_members_next"), [], "no staged shelves left");
  assert.equal(JSON.stringify(await h.catalog.read("SELECT data FROM plex_catalog")).includes("Second Shift"), false);
});
