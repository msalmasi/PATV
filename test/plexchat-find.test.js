"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { createFinder } = require("../plexfind");
function load(file, mocks) {
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  m._compile(fs.readFileSync(file, "utf8"), file); return m.exports;
}
function harness() {
  const s = { clerk_enabled: "everyone", clerk_block_ratings: "X,XXX,AO,R18,R18+", clerk_warn_ratings: "NR,Not Rated,Unrated", library_price: 100,
    library_queue: true, library_queue_max_items: 60, library_queue_max_hours: 12 };
  const users = [{ userId: "u1", username: "member", class: "pleb" }, { userId: "u2", username: "staffer", class: "staff" }];
  const d = { s, users, visible: true, adultGate: "ok", access: { free: false, how: "paid" }, calls: [], ready: true, onair: true, allowLibrary: true,
    state: { library: { queue: true, can_add: true } }, seenKeys: [], filters: [] };
  const entries = [
    { key: "901", type: "movie", title: "Lantern at Midnight", section: "71", duration: 5400, year: 2001, genres: ["Mystery"], content_rating: "PG", rating: 7.4, shelves: [] },
    { key: "902", type: "movie", title: "Paper Moon Station", section: "71", duration: 1800, year: 2003, genres: ["Mystery"], content_rating: "R", rating: 7.2, shelves: [] },
    { key: "999", type: "movie", title: "Synthetic Blocked Film", section: "71", duration: 1000, content_rating: "X" },
  ];
  const catalog = {
    async status() { return { ready: d.ready, at: 123, sections: [{ id: "71", policy: "allowed" }] }; },
    async rows({ kind }) { return structuredClone(entries.filter((r) => r.type === kind)); },
    async getByKeys(keys) { d.calls.push(["catalog_keys", [...keys]]); return structuredClone(entries.filter((r) => keys.includes(r.key))); },
    async shelves() { d.calls.push(["shelves"]); return { ok: true, genres: ["Mystery"], shelves: [], v: 1, catalog: { ready: d.ready, at: 123 } }; },
  };
  const finder = createFinder({ catalog, settings: () => s, deepMax: { movie: 2, show: 10 }, rng: () => 0 });
  const ml = {
    async init() {},
    _q: { async roomOf(id) { d.calls.push(["room", id]); return { id: id || "pad", title: "Lantern Pad" }; },
      async mustAccess(user) { d.calls.push(["access", user.userId]); if (d.accessError) throw d.accessError; return d.access; }, SLACK_MIN: 5 },
    async padState() { return d.state; },
    priceFor(sec) { return { price: Math.ceil(sec / 3600) * s.library_price }; },
    async search(user, q) { d.calls.push(["legacy_search", q]); return [entries[0]]; },
    async playFor(user, b) { d.calls.push(["play", user.userId, b]); return { title: "Lantern at Midnight", price: b.price || 0 }; },
    async logControl() {},
  };
  const queue = {
    estimate: (per, sec) => per * Math.ceil(sec / 3600),
    async addCostFor(room, sec) { d.calls.push(["next_cost", room, sec]); return 300; },
    async startFor(user, b) { d.calls.push(["start", user.userId, b]); return { title: "Lantern at Midnight", items: b.keys.length, total_sec: 7200, estimate: b.estimate,
      replaced: b.replace ? { title: "Old Paper Moon", queue: true } : null }; },
    async addNext(user, room, keys, opts) { d.calls.push(["next", user.userId, room, keys, opts]); return { next: "Lantern at Midnight", added: keys.length, cost: opts.estimate }; },
  };
  const mocks = {
    express: { json(options) { d.parser = options; return () => {}; } },
    "./dbUtils": { async getQuery(sql, args) {
      if (sql.includes("FROM users")) return users.filter((u) => u.userId === args[0]);
      if (sql.includes("FROM media_plays")) { d.calls.push(["history", sql, args]); return d.seenKeys.map((key) => ({ rating_key: key })); }
      throw new Error("Unexpected SQL in isolated test");
    } },
    "./autoaccount": { async isAutoAccount() { return false; } },
    "./medialib": ml, "./mediaqueue": queue, "./rooms": { HOUSE_ROOM: "house" }, "./mediaconf": { get: () => s },
    "./siteperms": { atLeast: (u) => u.class === "staff", can: (u) => u.class === "staff" },
    "./mainstage": { async seesPad() { d.calls.push(["see"]); return d.visible; }, async limitsFor() { return { library_max: 365 }; } },
    "./padaccess": { async init() {}, adultGate() { d.calls.push(["adult"]); if (d.gateError) throw new Error("fixture gate unavailable"); return d.adultGate; } },
    "./onair": { async init() {}, config: () => ({ enabled: d.onair, allow_library: d.allowLibrary }), WHY: { off: "off", library: "off" },
      async libraryFor(user, key, by, opts) { d.calls.push(["cam", user.userId, key, opts]); return { title: "Lantern at Midnight" }; }, view: () => ({}) },
    "./plexcatalog": catalog, "./plexfind": finder,
  };
  const pc = load(path.join(__dirname, "..", "plexchat.js"), mocks);
  const call = (op, body = {}, user = "u1") => pc.handle({ op, as: { user_id: user }, room: "pad", via: "web", ...body });
  return { ...d, data: d, pc, call, entries };
}

test("find and shelves run visibility, age, cam and access gates before any catalog read; staff rollout stays off for others", async () => {
  for (const op of ["find", "shelves"]) {
    const h = harness(); h.data.visible = false;
    assert.equal((await h.call(op, { ask: { select: "random" } })).code, "pad");
    assert.ok(!h.data.calls.some((x) => ["catalog_keys", "shelves"].includes(x[0])));
    h.data.visible = true; h.data.adultGate = "confirm";
    assert.equal((await h.call(op)).code, "pad");
    h.data.adultGate = "ok"; h.data.gateError = true;
    assert.equal((await h.call(op)).code, "pad");
    h.data.gateError = false; h.s.clerk_enabled = "staff";
    assert.equal((await h.call(op)).code, "clerk_off");
    h.data.calls.length = 0;
    assert.equal((await h.call(op, { ask: { select: "random" } }, "u2")).ok, true);
    h.s.clerk_enabled = "everyone";
    assert.equal((await h.call(op, { target: "cam" })).code, "onair_staff");
    h.data.onair = false;
    assert.equal((await h.call(op, { target: "cam" }, "u2")).code, "onair_off");
  }
});

test("prices, list estimates and next costs reuse the playback helpers; unseen reads only the resolved requester", async () => {
  const h = harness(); h.data.seenKeys = ["902"];
  const one = await h.call("find", { ask: { title: "Lantern at Midnight", unseen: true }, raw: "play Lantern at Midnight", as: { user_id: "u1" }, seenKeys: ["901"] });
  assert.equal(one.rows[0].key, "901"); assert.equal(one.rows[0].price, 200); assert.equal(one.rows[0].next_cost, 300);
  const read = h.data.calls.find((x) => x[0] === "history");
  assert.deepEqual(read[2], ["u1"]); assert.match(read[1], /WHERE user_id = \?/);
  const list = await h.call("find", { ask: { kind: "movie", select: "in_order" } });
  assert.deepEqual(list.rows[0].keys, ["901", "902"]); assert.equal(list.rows[0].estimate, 200); assert.equal(list.rows[0].next_cost, 300);
  h.data.access = { free: true, how: "member" };
  const free = await h.call("find", { ask: { title: "Lantern at Midnight" } }); assert.equal(free.rows[0].price, 0); assert.equal(free.per_hour, 0);
});

test("list play validates every key, passes the original replacement slot and uses next's single list insertion", async () => {
  const h = harness();
  const r = await h.call("play", { keys: ["901", "902"], scope: "list", mode: "replace", estimate: 200, replace_slot: "slot-12345678" });
  assert.equal(r.ok, true); assert.equal(r.queue, true); assert.deepEqual(r.replaced, { title: "Old Paper Moon", queue: true });
  assert.deepEqual(h.data.calls.find((x) => x[0] === "start")[2], { room: "pad", keys: ["901", "902"], scope: "list", estimate: 200, replace: "slot-12345678" });
  const next = await h.call("play", { keys: ["901", "902"], scope: "series", mode: "next", estimate: 300 });
  assert.equal(next.added, 2); assert.deepEqual(h.data.calls.find((x) => x[0] === "next").slice(3), [["901", "902"], { estimate: 300, scope: null }]);
  const starts = h.data.calls.filter((x) => x[0] === "start").length;
  for (const keys of [["901", "999"], ["901", "888"], ["901", "bad"]]) assert.equal((await h.call("play", { keys, scope: "list" })).code, "not_found");
  assert.equal(h.data.calls.filter((x) => x[0] === "start").length, starts);
  assert.equal((await h.call("play", { keys: ["901", "902"], scope: "list", target: "cam" }, "u2")).code, "bad");
});

test("clerk singles reread catalog/current ratings while legacy search and play stay unchanged with clerk off", async () => {
  const h = harness();
  h.entries[0].content_rating = "X";
  assert.equal((await h.call("play", { key: "901", scope: "title", clerk: true, price: 200 })).code, "not_found");
  assert.ok(!h.data.calls.some((x) => x[0] === "play"));
  h.s.clerk_enabled = "off";
  assert.equal((await h.call("find", { ask: { title: "Lantern" } })).code, "clerk_off");
  assert.equal((await h.call("play", { key: "901", scope: "title", clerk: true })).code, "clerk_off");
  assert.equal((await h.call("search", { q: "Lantern" })).ok, true);
  assert.equal((await h.call("play", { key: "901", scope: "title", price: 200 })).ok, true);
});

test("bot route keeps its existing token check and 16KB body limit", async () => {
  const h = harness(); let handler;
  h.pc.register({ post(route, parser, last) { assert.equal(route, "/api/medialib/bot"); handler = last; } }, { isBotToken: (token) => token === "fixture-bot-token" });
  assert.deepEqual(h.data.parser, { limit: "16kb" });
  const res = { statusCode: 200, set() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
  await handler({ body: { password: "bad", op: "find", as: { user_id: "u1" } } }, res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "auth"); assert.equal(h.data.calls.length, 0);
  await handler({ body: { password: "fixture-bot-token", op: "shelves", as: { user_id: "u1" }, room: "pad" } }, res);
  assert.equal(res.body.ok, true);
});

test("60-episode build stays below the two-second shortcut gate against mocked mediactl", async (t) => {
  const repo = process.env.PATV_SITE_DIR || path.resolve(__dirname, "..");
  const mediactl = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));
  const secret = "synthetic-queue-check-secret-".repeat(2), keys = Array.from({ length: 60 }, (_, i) => String(81000 + i));
  let reads = 0;
  const plex = { async item(key) { reads++; return { key, type: "episode", title: "Invented chapter", show: "Clockwork Orchard", season: 1, episode: Number(key) - 80999, duration: 600 }; } };
  const server = mediactl.makeServer(mediactl.loadConfig({ MEDIACTL_SECRET: secret, MEDIACTL_ALLOW: "127.0.0.1/32" }), { plex, streams: { list: () => [] } }).server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeIdleConnections(); server.close(resolve); }));
  const ml = { init: async () => {}, _q: { mustAccess: async () => ({ free: true }), fetchItem: async (key) => {
    const url = "/item/" + key, ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("hex");
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: {
      "x-mc-ts": ts, "x-mc-nonce": nonce, "x-mc-sig": mediactl.sign(secret, { ts, nonce, method: "GET", url, body: "" }) } });
    assert.equal(response.status, 200); return (await response.json()).item;
  } } };
  const queue = load(path.join(repo, "mediaqueue.js"), { "./dbUtils": {}, "./mediaconf": { get: () => ({ library_queue_max_items: 60, library_queue_max_hours: 12 }) },
    "./mainstage": {}, "./rooms": {}, "./medialib": ml });
  const started = performance.now(), result = await queue.preview({ userId: "fixture" }, { keys });
  const elapsed = performance.now() - started;
  assert.equal(reads, 60); assert.equal(result.items.length, 60); assert.equal(result.total_sec, 36000);
  assert.ok(elapsed < 2000, `60 mocked reads took ${elapsed.toFixed(1)} ms; review the brief's shortcut gate`);
  t.diagnostic(`60-episode build: ${elapsed.toFixed(1)} ms; mediaqueue.js stays unchanged.`);
});
