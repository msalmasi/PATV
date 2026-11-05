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

async function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexcatalog-test-"));
  let clock = AT;
  const cfg = { clerk_block_ratings: "X,XXX,AO,R18,R18+", catalog_sync_min: 60 };
  const api = { allowed: true, old: false, error: false, rows: fixtureRows(), sections: sections.map((s) => ({ ...s })), pageSize: 2 };
  const calls = [], logs = [], tautCalls = [];
  const mediactl = async (method, route) => {
    calls.push(route);
    if (api.error) return { status: 502, json: { error: "Provider body must not appear" } };
    const u = new URL(route, "http://fixture.local");
    if (route === "/sections") return { status: api.old ? 404 : 200, json: { ok: !api.old, allow_list_set: api.allowed, sections: api.sections } };
    if (route === "/health") return { status: 200, json: { ok: true, version: "1.7.0" } };
    if (u.pathname === "/collections") return { status: 200, json: { ok: true, collections: snapshot().shelves } };
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
  return { catalog, cfg, api, calls, logs, tautCalls, setClock: (v) => { clock = v; }, dir };
}

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

test("shelves aggregates 10k films and 200k episodes without fetching metadata JSON", { timeout: 120000 }, async (t) => {
  const h = await setup(t, { noFts: true });
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
  const before = performance.now();
  const result = await h.catalog.shelves();
  const elapsed = performance.now() - before;
  assert.equal(result.catalog.ready, true);
  assert.ok(result.genres.includes("Scale Cinema"));
  assert.ok(result.genres.includes("Scale Series"));
  assert.equal((await h.catalog.status()).count, 210005);
  // Each read has the real400ms interrupt; this whole-result ceiling allows several bounded queries.
  assert.ok(elapsed < 1600, "shelves took " + Math.round(elapsed) + "ms");
  t.diagnostic("shelves: 210005 rows with500/512-character summaries, " + elapsed.toFixed(1) + "ms");
  h.cfg.clerk_block_ratings += ",TV-14";
  assert.equal((await h.catalog.shelves()).genres.includes("Scale Series"), false);
});
