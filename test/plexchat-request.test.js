"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createFinder } = require("../plexfind");
function load(file, mocks) {
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  m._compile(fs.readFileSync(file, "utf8"), file); return m.exports;
}
function harness() {
  const settings = { clerk_enabled: "everyone", clerk_requests: "everyone", library_price: 100, library_queue_max_items: 60,
    library_queue_max_hours: 12, request_min_level: 3, requests_per_day: 4, request_price_movie: 400, request_price_tv: 700 };
  const d = { settings, on: true, visible: true, gate: "ok", access: true, adult: false, now: Date.UTC(2026, 10, 5), calls: [], writes: [],
    users: [{ userId: "u1", username: "cedar", class: "pleb", level: 5 }, { userId: "u2", username: "willow", class: "staff", level: 5 }],
    scout: false, credits: 0, today: 0, ready: true, apiError: null, pending: null, mode: "missing", requestResult: { ok: true, status: "pending", label: "NEVER-RAW-LABEL", paid_with: "pat", price: 400 } };
  const config = { get: () => settings, on: { requests: () => d.on } };
  const db = {
    async getQuery(sql, args) {
      d.calls.push(["sql", sql, args]);
      if (sql.includes("FROM users")) return d.users.filter((u) => u.userId === args[0]);
      if (sql.includes("COUNT(*) AS n FROM media_requests")) return [{ n: d.today }];
      if (sql.includes("FROM media_credits")) return [{ n: d.credits }];
      if (sql.includes("FROM request_roles")) return d.scout ? [{ "1": 1 }] : [];
      if (sql.includes("FROM media_plays")) return [];
      throw new Error("Unexpected fixture SQL");
    },
    async runQuery(sql) { d.writes.push(sql); throw new Error("Read-only preview attempted a write"); },
  };
  const preview = load(path.join(__dirname, "..", "mediarequests.js"), {
    "./dbUtils": db, "./mediaconf": config, "./siteperms": {},
    "./requestroles": { async isActive(userId, role) { d.calls.push(["role", userId, role]); return d.scout; } },
  });
  preview._setClock(() => d.now);
  const requests = {
    canRequest: (...args) => preview.canRequest(...args),
    async search(user, q) {
      d.calls.push(["search", user && user.userId, q]);
      if (d.apiError) throw d.apiError;
      if (d.searchRows) return structuredClone(d.searchRows);
      return [{ type: "movie", tmdb: 901, title: "Distant Lantern", year: 2020, media_status: d.mode === "gated" ? 5 : 1,
        availability: d.mode === "gated" ? "available" : "unknown", overview: "NEVER-OVERVIEW", poster: "/NEVER-POSTER" }];
    },
    async details() { if (d.details) return structuredClone(d.details); throw new Error("This fixture offers only movies"); },
    async request(user, body, meta) {
      d.calls.push(["request", user.userId, body]);
      if (meta !== undefined) d.calls.push(["request_meta", meta]);     // 1.99and clerkreq S6: where a chat request came from
      if (d.pending) await d.pending;
      if (d.requestError) throw d.requestError;
      return { ...d.requestResult };
    },
  };
  const entries = [
    { key: "101", type: "movie", title: "Home Lantern", section: "71", year: 2001, duration: 3600, genres: ["Drama"], content_rating: "PG", added: 100 },
    { key: "102", type: "movie", title: "Paper Lantern", section: "71", year: 2010, duration: 5400, genres: ["Drama"], content_rating: "R", added: 200 },
    { key: "103", type: "movie", title: "River Lantern", section: "71", year: 2015, duration: 6000, genres: ["Drama"], content_rating: "PG", added: 300 },
    { key: "104", type: "movie", title: "Forest Lantern", section: "71", year: 2016, duration: 4000, genres: ["Drama"], content_rating: "PG", added: 400 },
  ];
  const catalog = {
    async status() { return { ready: d.ready, sections: [{ id: "71", policy: "allowed" }] }; },
    async rows({ kind }) { return entries.filter((r) => r.type === kind); },
    async getByKeys(keys) { return entries.filter((r) => keys.includes(r.key)); },
    async search() { return []; },
  };
  const finder = createFinder({ catalog, settings: () => settings, requests, now: () => d.now, rng: () => 0, deepMax: { movie: 2, show: 10 } });
  const mocks = {
    express: { json: () => () => {} }, "./dbUtils": db, "./autoaccount": { async isAutoAccount() { return false; } }, "./mediaconf": config,
    "./siteperms": { atLeast: (u) => u.class === "staff", can: (u) => u.class === "staff" },
    "./rooms": { HOUSE_ROOM: "house" }, "./mainstage": { async seesPad() { return d.visible; }, async limitsFor() { return { library_max: 365 }; } },
    "./padaccess": { async init() {}, adultGate() { return d.gate; } },
    "./medialib": { async init() {}, _q: { SLACK_MIN: 5,
      async roomOf(id) { return { id, title: "Cedar Pad", adult: d.adult && id !== "house" }; },
      async mustAccess() { if (!d.access) throw Object.assign(new Error("Sign in first."), { refuse: true, status: 401 }); return { free: false }; } },
      async padState() { return {}; }, priceFor(sec) { return { price: Math.ceil(sec / 3600) * settings.library_price }; } },
    "./mediaqueue": { estimate: (price, sec) => Math.ceil(sec / 3600) * price },
    "./onair": { async init() {}, config: () => ({ enabled: true, allow_library: true }), WHY: {} },
    "./plexcatalog": catalog, "./plexfind": finder, "./mediarequests": requests,
  };
  const pc = load(path.join(__dirname, "..", "plexchat.js"), mocks); pc._setClock(() => d.now);
  const call = (op, body = {}, user = "u1") => pc.handle({ op, room: "pad", via: "web", as: { user_id: user }, ...body });
  const offer = (body = {}, user = "u1") => call("find", { ask: { title: "Distant Lantern", kind: "movie", year: 2020 }, ...body }, user);
  const send = (body = {}, user = "u1") => call("request", { kind: "movie", tmdb: 901, ...body }, user);
  return { d, pc, preview, call, offer, send };
}

test("canRequest reads only current rights and preserves Scout, credit, PAT and free priority", async () => {
  const h = harness(), u = h.d.users[0];
  assert.equal((await h.preview.canRequest(null, "movie")).reason, "signin");
  h.d.on = false; assert.equal((await h.preview.canRequest(u, "movie")).reason, "off"); h.d.on = true;
  u.level = 2; assert.deepEqual(await h.preview.canRequest(u, "movie"), { ok: false, reason: "level", level: 3, cost: { with: "free", price: 0 } }); u.level = 5;
  h.d.today = 4; assert.equal((await h.preview.canRequest(u, "movie")).reason, "limit");
  h.d.scout = true; h.d.credits = 3;
  assert.deepEqual((await h.preview.canRequest(u, "movie")).cost, { with: "scout", price: 0 });
  h.d.scout = false; h.d.today = 0;
  assert.deepEqual((await h.preview.canRequest(u, "tv")).cost, { with: "credit", price: 0 });
  h.d.credits = 0; assert.deepEqual((await h.preview.canRequest(u, "tv")).cost, { with: "pat", price: 700 });
  h.d.settings.request_price_movie = 0; assert.deepEqual((await h.preview.canRequest(u, "movie")).cost, { with: "free", price: 0 });
  assert.deepEqual(h.d.writes, []);
  assert.ok(h.d.calls.filter((c) => c[0] === "sql").every((c) => !/INSERT|UPDATE|DELETE/.test(c[1])));
});

test("find offers verified titles and request delegates once to unchanged request() under the resolved account", async () => {
  const h = harness(), out = await h.offer();
  assert.equal(out.ok, true); assert.equal(out.seerr.title, "Distant Lantern");
  assert.deepEqual(out.request, { may: true, cost: { with: "pat", price: 400 } });
  assert.doesNotMatch(JSON.stringify(out), /NEVER/);
  assert.equal(h.d.calls.filter((c) => c[0] === "request").length, 0);
  const result = await h.send({ userId: "u2", title: "Injected title", price: 0 });
  assert.deepEqual(result.status, "pending"); assert.equal(result.label, "pending");
  assert.deepEqual(h.d.calls.find((c) => c[0] === "request"), ["request", "u1", { type: "movie", tmdb: 901 }]);
  assert.equal((await h.send()).code, "request_stale");
});

test("offers bind account, pad, target, item and ten-minute lifetime", async () => {
  const h = harness();
  assert.equal((await h.send()).code, "request_stale"); await h.offer();
  for (const [body, user] of [[{}, "u2"], [{ room: "elsewhere" }, "u1"], [{ tmdb: 902 }, "u1"], [{ kind: "tv", season: 1 }, "u1"]]) {
    assert.equal((await h.send(body, user)).code, "request_stale");
  }
  h.d.now += 10 * 60000; assert.equal((await h.send()).code, "request_stale");
  assert.equal(h.d.calls.filter((c) => c[0] === "request").length, 0);
  await h.offer({}, "u2"); assert.equal((await h.send({ target: "cam" }, "u2")).code, "request_stale");
});

test("a simultaneous yes consumes an offer before awaiting request completion", async () => {
  const h = harness(); await h.offer();
  let release; h.d.pending = new Promise((resolve) => { release = resolve; });
  const first = h.send();
  for (let i = 0; i < 20 && !h.d.calls.some((c) => c[0] === "request"); i++) await Promise.resolve();
  assert.equal((await h.send()).code, "request_stale"); release();
  assert.equal((await first).ok, true); assert.equal(h.d.calls.filter((c) => c[0] === "request").length, 1);
});

test("request previews are personal and refresh rights and cost at confirmation", async () => {
  const h = harness(); await h.offer(); h.d.credits = 1;
  assert.equal((await h.send()).code, "request_stale"); assert.equal(h.d.calls.filter((c) => c[0] === "request").length, 0);
  let out = await h.offer(); assert.deepEqual(out.request.cost, { with: "credit", price: 0 });
  h.d.today = 4; assert.equal((await h.send()).code, "limit");
  h.d.users[0].level = 2; out = await h.offer(); assert.deepEqual(out.request, { may: false, reason: "level", level: 3 });
  h.d.users[0].level = 5; h.d.today = 0; h.d.settings.clerk_requests = "staff";
  out = await h.offer(); assert.deepEqual(out.request, { may: false, reason: "clerk_off" });
  out = await h.offer({}, "u2"); assert.equal(out.request.may, true);
  h.d.settings.clerk_requests = "off"; assert.equal((await h.send({}, "u2")).code, "request_off");
});

test("off, adult, PM, Telegram and authorization failures cannot perform external lookups or requests", async () => {
  for (const mode of ["off", "adult", "pm", "telegram", "private", "gate", "access", "clerk"]) {
    const h = harness(); const body = {};
    if (mode === "off") h.d.on = false;
    if (mode === "adult") h.d.adult = true;
    if (["pm", "telegram"].includes(mode)) body.via = mode;
    if (mode === "private") h.d.visible = false;
    if (mode === "gate") h.d.gate = "confirm";
    if (mode === "access") h.d.access = false;
    if (mode === "clerk") h.d.settings.clerk_enabled = "off";
    const out = await h.offer(body); assert.equal(out.seerr, undefined, mode);
    assert.equal(h.d.calls.filter((c) => c[0] === "search").length, 0, mode);
    assert.equal((await h.send(body)).ok, false, mode);
    assert.equal(h.d.calls.filter((c) => c[0] === "request").length, 0, mode);
  }
  const h = harness(); h.d.adult = true;
  assert.equal((await h.offer({ target: "cam" }, "u2")).seerr, undefined, "an adult originating room stays excluded even when the target is the house cam");
  assert.equal(h.d.calls.filter((c) => c[0] === "search").length, 0);
});

test("Seerr already-available misses are unavailable and omit every title/overview/poster", async () => {
  const h = harness(); h.d.mode = "gated";
  const out = await h.offer(); assert.equal(out.code, "unavailable");
  assert.doesNotMatch(JSON.stringify(out), /Distant|Lantern|901|NEVER/);
  assert.equal((await h.send()).code, "request_stale");
});

test("upstream request refusals expose fixed codes, never raw provider text", async () => {
  for (const [status, message, code] of [[401, "NEVER-SIGNIN", "signin"], [403, "NEVER-LEVEL", "level"], [429, "NEVER-LIMIT", "limit"],
    [409, "NEVER already on Plex", "available"], [409, "NEVER duplicate", "requested"], [502, "NEVER-SECRET", "upstream"], [402, "NEVER balance", "pat"]]) {
    const h = harness(); await h.offer(); h.d.requestError = Object.assign(new Error(message), { status, refuse: true });
    const out = await h.send(); assert.equal(out.code, code); assert.doesNotMatch(JSON.stringify(out), /NEVER/);
    assert.equal((await h.send()).code, "request_stale");
  }
});

test("browse enforces the same access checks and returns three priced suggestions", async () => {
  const h = harness();
  const out = await h.call("browse", { ask: { action: "browse", kind: "movie", select: "latest" }, limit: 20 });
  assert.equal(out.rows.length, 3); assert.deepEqual(out.rows.map((r) => r.key), ["104", "103", "102"]);
  assert.ok(out.rows.every((r) => r.price > 0)); assert.equal(out.seerr, undefined);
  h.d.visible = false; assert.equal((await h.call("browse")).code, "pad");
});

test("a verified missing episode requests exactly its offered season; whole-show offers keep the default", async () => {
  const h = harness();
  h.d.searchRows = [{ type: "tv", tmdb: 902, title: "Distant Orchard", year: 2003, media_status: 4, availability: "partial" }];
  h.d.details = { type: "tv", tmdb: 902, title: "Distant Orchard", year: 2003, media_status: 4,
    seasons: [{ n: 4, episodes: 10, status: 1 }] };
  const episode = await h.call("find", { ask: { guesses: [{ kind: "episode", show: "Distant Orchard", year: 2003,
    season: 4, episode: 2, episode_title: "The Envelope", confidence: .9 }] } });
  assert.equal(episode.seerr.season, 4); assert.equal(episode.request.cost.price, 700);
  assert.equal((await h.call("request", { kind: "tv", tmdb: 902, season: 5 })).code, "request_stale");
  assert.equal((await h.call("request", { kind: "tv", tmdb: 902, season: 4 })).ok, true);
  assert.deepEqual(h.d.calls.find((c) => c[0] === "request"), ["request", "u1", { type: "tv", tmdb: 902, seasons: [4] }]);
  const show = await h.call("find", { ask: { title: "Distant Orchard", kind: "show" } });
  assert.equal(show.seerr.season, undefined);
  assert.equal((await h.call("request", { kind: "tv", tmdb: 902 })).ok, true);
  assert.deepEqual(h.d.calls.filter((c) => c[0] === "request").at(-1)[2], { type: "tv", tmdb: 902 });
});

test("failed external lookups and stale index never create request offers", async () => {
  const h = harness(); h.d.apiError = new Error("NEVER-PRIVATE-UPSTREAM");
  let out = await h.offer(); assert.equal(out.seerr, undefined); assert.doesNotMatch(JSON.stringify(out), /NEVER/);
  h.d.apiError = null; h.d.ready = false; h.d.calls.length = 0;
  out = await h.offer(); assert.equal(out.catalog.ready, false); assert.equal(out.seerr, undefined);
  assert.equal(h.d.calls.filter((c) => c[0] === "search").length, 0);
  assert.equal((await h.send()).code, "request_stale");
});

test("pre-model probes preserve exact library titles and defer all external work to the interpreted find", async () => {
  const h = harness();
  const exact = await h.call("find", { ask: { title: "Distant Lantern" }, raw: "Home Lantern", probe: true });
  assert.equal(exact.rows[0].key, "101"); assert.equal(exact.exact, true);
  const probe = await h.offer({ probe: true }); assert.equal(probe.seerr, undefined);
  assert.equal(h.d.calls.filter((c) => c[0] === "search").length, 0);
  const answer = await h.offer(); assert.equal(answer.request.may, true);
  assert.equal(h.d.calls.filter((c) => c[0] === "search").length, 1);
});

// ── 1.99and clerkreq S5: op request_offer - "pepe request <title>" from chat. The same gates as find (the speaker, the rate, the clerk's
// access, the pad: no 18+ pads, a typed room line or the pad's web chat only, requests on, the chat-request rollout); a forced title-level
// ask; the answer says what can happen: it's on the shelves (rows) | Seerr's one title + its request preview | Seerr's choices, each with
// its own preview | why not (requested / unavailable) | nothing to request (seerr_state). op request stays the only write.
const ask = (h, body = {}, user = "u1") => h.call("request_offer", { title: "Distant Lantern", kind: "movie", ...body }, user);
const searches = (h) => h.d.calls.filter((c) => c[0] === "search").length;
const requests = (h) => h.d.calls.filter((c) => c[0] === "request").length;

test("request_offer: a title on the shelves is that title - no outside lookup, priced rows to play or queue", async () => {
  const h = harness();
  const out = await ask(h, { title: "Home Lantern", kind: null });
  assert.equal(out.ok, true); assert.equal(out.answer, "on_shelves");
  assert.deepEqual(out.rows.map((r) => r.key), ["101"]); assert.ok(out.rows[0].price > 0); assert.equal(out.pad.id, "pad");
  assert.equal(searches(h), 0); assert.equal(out.seerr, undefined);
  // a near title is not that title ("Lantern" is in four films' names): Seerr is asked for the one named
  const near = await ask(h, { title: "Lantern", kind: "movie" });
  assert.notEqual(near.answer, "on_shelves"); assert.equal(searches(h), 1);
});

test("request_offer: a verified missing title's offer is bound to the speaker, the pad and the title; the yes is from chat", async () => {
  const h = harness();
  const out = await ask(h);
  assert.equal(out.answer, "seerr"); assert.equal(out.seerr.tmdb, 901); assert.equal(out.seerr_state, "ok");
  assert.deepEqual(out.request, { may: true, cost: { with: "pat", price: 400 } });
  assert.doesNotMatch(JSON.stringify(out), /NEVER/);
  assert.equal(requests(h), 0, "an offer writes nothing");
  for (const [body, user] of [[{}, "u2"], [{ room: "elsewhere" }, "u1"], [{ tmdb: 902 }, "u1"], [{ kind: "tv" }, "u1"]]) {
    assert.equal((await h.send(body, user)).code, "request_stale");
  }
  h.d.requestResult = { ...h.d.requestResult, id: 77 };
  const sent = await h.send();
  assert.equal(sent.ok, true); assert.equal(sent.id, 77); assert.equal(sent.status, "pending");
  assert.deepEqual(h.d.calls.find((c) => c[0] === "request"), ["request", "u1", { type: "movie", tmdb: 901 }]);
  assert.deepEqual(h.d.calls.find((c) => c[0] === "request_meta"), ["request_meta", { origin: "chat", pad: "pad", anon: false }]);
  assert.equal((await h.send()).code, "request_stale", "an offer is used once");
  // a veiled speaker's request is never named when it lands
  await ask(h); await h.send({ veiled: true });
  assert.deepEqual(h.d.calls.filter((c) => c[0] === "request_meta").at(-1)[1], { origin: "chat", pad: "pad", anon: true });
});

test("request_offer: a stale offer or a changed cost is refused at the yes (409 request_stale) - nothing sent", async () => {
  const h = harness();
  await ask(h); h.d.credits = 1;
  assert.equal((await h.send()).code, "request_stale");
  await ask(h); h.d.now += 10 * 60000;
  assert.equal((await h.send()).code, "request_stale");
  assert.equal(requests(h), 0);
});

test("request_offer: an 18+ pad, a PM / Telegram line, requests off and the rollout off are refused or say why - no outside lookup there", async () => {
  for (const mode of ["adult", "pm", "telegram"]) {
    const h = harness(); const body = {};
    if (mode === "adult") h.d.adult = true; else body.via = mode;
    const out = await ask(h, body);
    assert.equal(out.code, "request_off", mode); assert.equal(searches(h), 0, mode);
    assert.equal((await h.send(body)).ok, false, mode); assert.equal(requests(h), 0, mode);
  }
  let h = harness(); h.d.on = false;
  let out = await ask(h);
  assert.equal(out.answer, "miss"); assert.equal(out.seerr_state, "off"); assert.equal(searches(h), 0);
  h = harness(); h.d.settings.clerk_requests = "off";
  out = await ask(h);
  assert.equal(out.answer, "seerr"); assert.deepEqual(out.request, { may: false, reason: "clerk_off" });
  assert.equal((await h.send()).code, "request_off"); assert.equal(requests(h), 0);
  h = harness(); h.d.visible = false;
  assert.equal((await ask(h)).code, "pad"); assert.equal(searches(h), 0);
});

test("request_offer: a double yes sends one request", async () => {
  const h = harness(); await ask(h);
  let release; h.d.pending = new Promise((resolve) => { release = resolve; });
  const first = h.send();
  for (let i = 0; i < 20 && !h.d.calls.some((c) => c[0] === "request"); i++) await Promise.resolve();
  assert.equal((await h.send()).code, "request_stale"); release();
  assert.equal((await first).ok, true); assert.equal(requests(h), 1);
});

test("request_offer and find: Seerr's choices each carry their own preview and offer; a pick's yes requests exactly that one", async () => {
  const h = harness();
  h.d.searchRows = [{ type: "movie", tmdb: 905, title: "Distant Lantern", year: 2020, media_status: 1, availability: "unknown" },
    { type: "movie", tmdb: 906, title: "Distant Lantern", year: 1990, media_status: 1, availability: "unknown" }];
  const out = await ask(h, { kind: null });
  assert.equal(out.answer, "choices"); assert.equal(out.seerr, undefined);
  assert.deepEqual(out.seerr_choices.map((c) => [c.tmdb, c.year, c.request.may, c.request.cost.price]), [[905, 2020, true, 400], [906, 1990, true, 400]]);
  assert.equal((await h.send({ tmdb: 906 })).ok, true);
  assert.deepEqual(h.d.calls.find((c) => c[0] === "request")[2], { type: "movie", tmdb: 906 });
  const found = await h.call("find", { ask: { title: "Distant Lantern" } });
  assert.equal(found.seerr, undefined); assert.equal(found.seerr_choices.length, 2); assert.equal(found.seerr_choices[0].request.may, true);
  assert.equal((await h.send({ tmdb: 905 })).ok, true, "the play path's choices are offers too");
});

test("request_offer: already requested, already available elsewhere and nothing to request say so - never an offer", async () => {
  let h = harness();
  h.d.searchRows = [{ type: "movie", tmdb: 901, title: "Distant Lantern", year: 2020, media_status: 2, availability: "pending" }];
  let out = await ask(h);
  assert.equal(out.code, "requested"); assert.equal(out.label, "Distant Lantern (2020)"); assert.equal((await h.send()).code, "request_stale");
  h = harness(); h.d.mode = "gated";
  out = await ask(h);
  assert.equal(out.code, "unavailable"); assert.doesNotMatch(JSON.stringify(out), /Distant|Lantern|901|NEVER/);
  h = harness(); h.d.searchRows = [];
  out = await ask(h);
  assert.equal(out.ok, true); assert.equal(out.answer, "miss"); assert.equal(out.seerr_state, "none");
  h = harness(); h.d.apiError = Object.assign(new Error("NEVER-PRIVATE-UPSTREAM"), { status: 502, refuse: true, upstream: true });
  out = await ask(h);
  assert.equal(out.answer, "miss"); assert.equal(out.seerr_state, "down"); assert.doesNotMatch(JSON.stringify(out), /NEVER/);
  h = harness();
  assert.equal((await h.call("request_offer", { title: "" })).code, "bad_title", "a title is needed (review F13: bad_title - 'bad' is an older site's unknown op)");
});

// ── 1.99and clerkreq review (2026-11-08) ──
test("clerkreq review F1: request_offer tries the line's own words (raw) first - a title is never cut down to a word of it", async () => {
  let h = harness();
  h.d.searchRows = [{ type: "movie", tmdb: 910, title: "Before You", year: 2019, media_status: 1, availability: "unknown" },
    { type: "movie", tmdb: 911, title: "Me Before You", year: 2016, media_status: 1, availability: "unknown" }];
  let out = await ask(h, { title: "before you", kind: null, raw: "Me Before You" });
  assert.equal(out.answer, "seerr"); assert.equal(out.seerr.tmdb, 911); assert.equal(out.title, "Me Before You");
  // a kind word that is the title's own ("Scary Movie"): the raw words with no kind, before the trimmed title as a film
  h.d.searchRows = [{ type: "movie", tmdb: 912, title: "Scary", year: 2021, media_status: 1, availability: "unknown" },
    { type: "movie", tmdb: 913, title: "Scary Movie", year: 2000, media_status: 1, availability: "unknown" }];
  out = await ask(h, { title: "scary", kind: "movie", raw: "Scary Movie" });
  assert.equal(out.seerr.tmdb, 913);
  // on the shelves by its full name: no outside lookup
  h = harness();
  out = await ask(h, { title: "home", kind: "show", raw: "Home Lantern" });
  assert.equal(out.answer, "on_shelves"); assert.deepEqual(out.rows.map((r) => r.key), ["101"]); assert.equal(searches(h), 0);
  // the line's words name nothing: the title the bot trimmed ("the movie <title>")
  h = harness();
  out = await ask(h, { raw: "the movie Distant Lantern" });
  assert.equal(out.answer, "seerr"); assert.equal(out.seerr.tmdb, 901); assert.equal(out.title, "Distant Lantern");
  // the same words: one find, one lookup
  h = harness();
  out = await ask(h, { raw: "distant lantern" });
  assert.equal(out.answer, "seerr"); assert.equal(searches(h), 1);
  // Seerr not answering for the line's words: the trimmed title's shelves are still read, Seerr not asked twice
  h = harness(); h.d.apiError = Object.assign(new Error("NEVER-PRIVATE-UPSTREAM"), { status: 502, refuse: true, upstream: true });
  out = await ask(h, { title: "Home Lantern", kind: null, raw: "the film Home Lantern" });
  assert.equal(out.answer, "on_shelves"); assert.equal(searches(h), 1);
  out = await ask(h, { title: "Lost Road", kind: "movie", raw: "the film Lost Road" });
  assert.equal(out.answer, "miss"); assert.equal(out.seerr_state, "down"); assert.equal(searches(h), 2);
  assert.doesNotMatch(JSON.stringify(out), /NEVER/);
});

test("clerkreq review F13: a one-character title is a title (\"M\", \"9\"); no title at all is bad_title - never the older site's \"bad\"", async () => {
  const h = harness();
  h.d.searchRows = [{ type: "movie", tmdb: 920, title: "M", year: 1931, media_status: 1, availability: "unknown" }];
  const out = await ask(h, { title: "M", kind: null });
  assert.equal(out.answer, "seerr"); assert.equal(out.seerr.tmdb, 920);
  for (const title of ["", "  ", "!!"]) assert.equal((await h.call("request_offer", { title })).code, "bad_title", JSON.stringify(title));
  assert.equal((await h.call("no_such_op", {})).code, "bad", "an unknown op is still 'bad' (Unknown op.)");
});

test("clerkreq review F10: the request server refusing at the yes (a quota) is 'refused' - never 'already requested'", async () => {
  const h = harness(); await ask(h);
  h.d.requestError = Object.assign(new Error("NEVER The request server refused it (quota). Nothing was charged."), { status: 409, refuse: true, upstream: true, refused: true });
  const out = await h.send();
  assert.equal(out.code, "refused"); assert.doesNotMatch(JSON.stringify(out), /NEVER/);
  // (an older mediarequests' refusal has no marker: its own words say it)
  await ask(h); h.d.requestError = Object.assign(new Error("The request server refused it (Movie Quota exceeded.). Nothing was charged."), { status: 409, refuse: true, upstream: true });
  assert.equal((await h.send()).code, "refused");
  // an upstream "already requested" is still requested
  await ask(h); h.d.requestError = Object.assign(new Error("That's already been requested. Nothing was charged."), { status: 409, refuse: true, upstream: true });
  assert.equal((await h.send()).code, "requested");
});

test("clerkreq review F11: request_offer says the title is on the shelves as the other kind", async () => {
  const h = harness(); h.d.searchRows = [];
  const out = await ask(h, { title: "Home Lantern", kind: "show" });
  assert.equal(out.answer, "miss"); assert.deepEqual(out.shelf_title, { kind: "movie", title: "Home Lantern", year: 2001 });
});
