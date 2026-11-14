// 1.99anw plexhook: Plex's webhook (plexhook.js) -> the catalog's ordinary changes-only sync, soon (plexcatalog.soon). Offline: a
// fake media-control, a fake clock + timers for the catalog's wait, express on 127.0.0.1, multipart bodies built by hand.
//   NODE_PATH=<repo>/node_modules TZ=UTC node --test test/plexhook.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexhook-test-"));
process.chdir(tmp);                                   // dbUtils / mediaconf open ./myapp.db here
delete process.env.PUBLIC_BASE_URL; delete process.env.SITE_URL; delete process.env.STAGING;
const express = require("express");
const { createCatalog } = require(path.join(repo, "plexcatalog"));
const PH = require(path.join(repo, "plexhook"));
const conf = require(path.join(repo, "mediaconf"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const AT = Date.UTC(2026, 10, 14, 12);           // 12:00 UTC - outside the quiet window (03:40-04:20)
const SERVER = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER = "ffffeeeeddddccccbbbbaaaa9999888877776666";
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A clock and timers the test moves by hand (the catalog's wait: options.setTimer / clearTimer). */
function fakeTime(start) {
  let clock = start, seq = 0;
  const timers = new Map();
  return {
    now: () => clock,
    set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + Math.max(0, ms) }); return id; },
    clear: (id) => { timers.delete(id); },
    size: () => timers.size,
    jump: (t) => { clock = t; },
    async advance(ms) {
      const end = clock + ms;
      for (let fired = 0; ; fired++) {
        if (fired > 1000) throw new Error("a timer keeps re-arming itself at " + new Date(clock).toISOString());
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn(); await flush();
      }
      clock = end; await flush();
    },
  };
}
const memStore = () => {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, putIfMissing: async (k, v) => { if (!m.has(k)) m.set(k, v); } };
};

async function setup(t, o = {}) {
  const T = fakeTime(o.start || AT);
  const dir = fs.mkdtempSync(path.join(tmp, "cat-"));
  const cfg = { clerk_enabled: "staff", clerk_requests: "off", clerk_block_ratings: "X", catalog_sync_min: 60, catalog_hook: true,
    catalog_hook_debounce_s: 30, catalog_hook_gap_min: 5, catalog_hook_server: "", ...(o.cfg || {}) };
  const api = { gate: null };
  const calls = [], logs = [], syncAt = [], audits = [];
  const mediactl = async (method, route) => {
    calls.push(route);
    if (route === "/sections") { syncAt.push(T.now()); if (api.gate) await api.gate; }
    const u = new URL(route, "http://fixture.local");
    if (route === "/sections") return { status: 200, json: { ok: true, allow_list_set: true, sections: [{ id: "1", title: "Fixture Cinema", type: "movie", count: 1, policy: "allowed" }] } };
    if (route === "/health") return { status: 200, json: { ok: true, version: "1.7.0" } };
    if (u.pathname === "/collections") return { status: 200, json: { ok: true, collections: [] } };
    if (u.pathname === "/catalog") {
      const rows = [{ key: "11", title: "Quiet Harbor", type: "movie", section: "1", year: 2001, added: 100, updated: 100, content_rating: "PG" }]
        .filter((r) => !u.searchParams.has("since") || r.updated >= Number(u.searchParams.get("since")));
      return { status: 200, json: { ok: true, rows, next: null } };
    }
    return { status: 404, json: { ok: false } };
  };
  const L = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)) };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => cfg, now: T.now, mediactl, sleep: async () => {},
    setTimer: T.set, clearTimer: T.clear, mainRead: async () => [], tautulli: { configured: () => false, call: async () => ({}) }, log: L });
  const fakeConf = { init: async () => {}, get: () => ({ ...cfg }),
    set: async (patch) => {
      const v = conf._CLEAN.catalog_hook_server(patch.catalog_hook_server);
      const changed = v !== cfg.catalog_hook_server ? ["catalog_hook_server"] : [];
      cfg.catalog_hook_server = v;
      return { settings: { ...cfg }, changed };
    } };
  const store = o.store || memStore();
  const mkHook = (s = store) => PH.createHook({ now: T.now, settings: () => cfg, catalog, store: s, log: L, origin: () => "https://publicaccess.tv",
    limits: o.limits, maxBody: o.maxBody, maxPayload: o.maxPayload, conf: fakeConf, audit: (...a) => { audits.push(a); },
    permissions: { can: (u, k) => k === "media.admin" && !!(u && u.admin) } });
  const serve = async (hook) => {
    const app = express();
    hook.registerEarly(app);
    app.use(express.json());
    const addUser = (req, res, next) => { const who = req.get("x-test-user"); req.user = who ? { userId: who, username: who, admin: who.startsWith("admin") } : null; next(); };
    hook.registerAdmin(app, { addUser });
    app.use((req, res) => (req.path.startsWith("/api/") ? res.status(404).json({ error: "not found" }) : res.status(404).send("Not found")));   // index.js's last handler
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    t.after(() => new Promise((r) => server.close(() => r())));
    return "http://127.0.0.1:" + server.address().port;
  };
  const hook = mkHook();
  const base = await serve(hook);
  t.after(async () => { await catalog.close(); });
  const h = {
    T, cfg, api, calls, logs, syncAt, audits, catalog, hook, base, store, mkHook, serve,
    started: () => calls.filter((r) => r === "/sections").length,
    async idle() { await waitFor(async () => !(await catalog.status()).syncing, "the sync to finish"); await flush(); },
    async card(user = "admin1", b = base) {
      const r = await fetch(b + "/api/media/admin/catalog/hook", { headers: user ? { "x-test-user": user } : {} });
      return { status: r.status, cache: r.headers.get("cache-control"), body: await r.json() };
    },
    async adminPost(route, body, user = "admin1", headers = null, b = base) {
      const r = await fetch(b + route, { method: "POST", body: JSON.stringify(body || {}), headers: headers || { "Content-Type": "application/json", "x-test-user": user,
        "X-Requested-With": "fetch", Origin: b } });
      return { status: r.status, body: await r.json() };
    },
    async url(b = base) { return (await h.card("admin1", b)).body.url; },
    async deliver(event, o2 = {}) {
      const u = o2.url || await h.url();
      const { body, type } = o2.raw || plexBody(event, o2.extra, o2.thumb);
      const r = await fetch(u.replace("https://publicaccess.tv", o2.base || base), { method: "POST", body, headers: { "Content-Type": o2.type || type, ...(o2.headers || {}) } });
      let j = null; try { j = await r.json(); } catch (_) { j = null; }
      return { status: r.status, body: j, retry: r.headers.get("retry-after") };
    },
  };
  return h;
}

/** multipart/form-data the way Plex sends it: a `payload` JSON part, sometimes a `thumb` JPEG. */
function multipart(parts) {
  const boundary = "----plexhookFixture" + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + p.name + "\"" + (p.filename ? "; filename=\"" + p.filename + "\"" : "") + "\r\n" +
      (p.type ? "Content-Type: " + p.type + "\r\n" : "") + "\r\n"));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), type: "multipart/form-data; boundary=" + boundary };
}
const MARK = "Zebra Lantern Marker";   // a title in the payload: must never be stored, logged or reach the catalog
function plexBody(event, extra = {}, thumb = null) {
  const payload = { event, user: true, owner: true, Account: { id: 1, title: "fixture-owner" }, Server: { title: "Fixture Server", uuid: SERVER },
    Metadata: { title: MARK, librarySectionTitle: "Fixture Section Name", ratingKey: "9001", type: "movie" }, ...extra };
  return multipart([{ name: "payload", type: "application/json", value: JSON.stringify(payload) },
    ...(thumb ? [{ name: "thumb", filename: "thumb.jpg", type: "image/jpeg", value: thumb }] : [])]);
}
const secretOf = (url) => url.slice(url.lastIndexOf("/") + 1);
const noSecretIn = (h, secret) => { for (const l of h.logs) assert.ok(!l.includes(secret), "a log line never carries the secret: " + l); };

test("a good secret + library.new -> one debounced, changes-only sync; the payload never reaches the catalog, a log or the store", async (t) => {
  const h = await setup(t);
  assert.equal((await h.catalog.sync({ full: true })).ok, true);   // the day's full sweep is done: what follows is a delta
  h.T.jump(AT + 600000);                                           // 10 minutes on: past catalog_hook_gap_min after that run
  const mark = h.calls.length;
  const url = await h.url();
  assert.match(url, /^https:\/\/publicaccess\.tv\/api\/plex\/webhook\/[A-Za-z0-9_-]{43}$/);
  const r = await h.deliver("library.new", { url });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "scheduled");
  assert.equal(h.calls.length, mark, "nothing is read when the webhook arrives");
  await h.T.advance(29000);
  assert.equal(h.calls.length, mark, "still waiting (catalog_hook_debounce_s 30)");
  await h.T.advance(1000);
  await h.idle();
  assert.equal(h.started(), 2, "one sync (after the setup's full sweep)");
  const reads = h.calls.slice(mark);
  assert.ok(reads.some((x) => x.startsWith("/catalog?") && x.includes("&since=")), "a changes-only read: " + reads.join(" "));
  assert.ok(!reads.some((x) => x.startsWith("/collections")), "no shelves (the full sweep's only)");
  assert.equal(h.catalog.hookState().runs, 1);
  await h.T.advance(600000);
  assert.equal(h.started(), 2, "no further sync");
  assert.ok(h.logs.includes("[plexhook] library.new: changes-only catalog sync in 30 s"), h.logs.join("\n"));
  // what the payload carried stays out of the catalog, the logs and the store
  assert.ok(!JSON.stringify(await h.catalog.rows()).includes("Zebra"));
  assert.deepEqual(await h.catalog.search("zebra lantern"), []);
  for (const l of h.logs) assert.ok(!/Zebra|Fixture Section Name|fixture-owner|Fixture Server/.test(l), l);
  for (const v of h.store.m.values()) assert.ok(!/Zebra|Fixture/.test(v), v);
  assert.deepEqual([...h.store.m.keys()].sort(), ["last_new", "secret"]);
  assert.deepEqual(JSON.parse(h.store.m.get("last_new")), { at: AT + 600000, outcome: "scheduled" });
  noSecretIn(h, secretOf(url));
});

test("a burst of 10 -> one sync; a burst while it runs -> exactly one follow-up after it (and the gap), never a pile-up", async (t) => {
  const h = await setup(t);
  await h.catalog.sync({ full: true });
  h.T.jump(AT + 600000);
  const url = await h.url();
  const first = [];
  for (let i = 0; i < 10; i++) first.push((await h.deliver("library.new", { url })).body.outcome);
  assert.deepEqual(first, ["scheduled", ...Array(9).fill("joined")]);
  assert.equal(h.T.size(), 1, "one wait");
  let release;
  h.api.gate = new Promise((r) => { release = r; });
  await h.T.advance(30000);
  await waitFor(() => h.started() === 2, "the webhook's sync to start");
  const during = [];
  for (let i = 0; i < 10; i++) during.push((await h.deliver("library.new", { url })).body.outcome);
  assert.deepEqual(during, ["after", ...Array(9).fill("joined")], "one follow-up asked for, the rest join it");
  assert.equal(h.T.size(), 0, "nothing armed while the sync runs (it waits for it)");
  h.api.gate = null; release();
  await h.idle();
  await waitFor(() => h.T.size() === 1, "the follow-up to be planned");
  assert.equal(h.started(), 2);
  const ended = h.T.now();
  await h.T.advance(30000);
  assert.equal(h.started(), 2, "not 30 s after: catalog_hook_gap_min (5) after the last run ended");
  await h.T.advance(ended + 300000 - 1 - h.T.now());
  assert.equal(h.started(), 2);
  await h.T.advance(1);
  await h.idle();
  assert.equal(h.started(), 3, "one follow-up, 5 minutes after the run before it ended");
  assert.equal(h.syncAt[2], ended + 300000);
  await h.T.advance(3600000);
  assert.equal(h.started(), 3, "and nothing more");
  assert.equal(h.catalog.hookState().runs, 2);
});

test("a sync already running (the timer's, Sync now): the request runs after it finishes and the gap - the same single-flight sync", async (t) => {
  const h = await setup(t);
  await h.catalog.sync({ full: true });
  const url = await h.url();
  let release;
  h.api.gate = new Promise((r) => { release = r; });
  const running = h.catalog.sync();
  await waitFor(() => h.started() === 2, "Sync now to start");
  assert.equal(h.catalog.sync(), running, "single-flight: a second ask gets the same run");
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "after");
  await h.T.advance(60000);
  assert.equal(h.started(), 2, "no second sync while one runs");
  h.api.gate = null; release();
  await running;
  const ended = h.T.now();
  await waitFor(() => h.T.size() === 1, "the follow-up to be planned");
  await h.T.advance(0);
  assert.equal(h.started(), 2, "its 30 s wait is over, the gap after Sync now is not");
  await h.T.advance(ended + 300000 - h.T.now());
  await h.idle();
  assert.equal(h.started(), 3, "5 minutes after Sync now finished");
});

test("a wrong or missing secret -> the site's ordinary 404 (no route revealed); no secret made yet -> 404 for any", async (t) => {
  const h = await setup(t);
  const fake = "A".repeat(43);
  const post = (p) => fetch(h.base + p, { method: "POST", body: plexBody("library.new").body, headers: { "Content-Type": plexBody("library.new").type } });
  let r = await post("/api/plex/webhook/" + fake);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "not found" }, "exactly an unknown /api/ address's answer");
  const url = await h.url(), secret = secretOf(url);
  const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
  for (const p of ["/api/plex/webhook/" + fake, "/api/plex/webhook/" + flipped, "/api/plex/webhook/" + secret.slice(0, 20), "/api/plex/webhook/" + secret + "x",
    "/api/plex/webhook/", "/api/plex/webhook", "/api/plex/webhook/" + secret.toLowerCase() + (secret === secret.toLowerCase() ? "Q" : "")]) {
    r = await post(p);
    assert.equal(r.status, 404, p.replace(secret, "<secret>"));
    assert.deepEqual(await r.json(), { error: "not found" });
  }
  const get = await fetch(h.base + "/api/plex/webhook/" + secret);
  assert.equal(get.status, 404, "only POST");
  assert.equal(h.T.size(), 0, "nothing scheduled");
  assert.equal(h.hook.servers.size, 0, "nothing read from the body");
  const card = (await h.card()).body;
  assert.equal(card.wrong.n, 6, "the requests that reached the route with a wrong secret (an address without one never does)");
  assert.equal(card.last, null, "a refused address is not a delivery");
  assert.equal(h.logs.filter((l) => /wrong or missing secret/.test(l)).length, 1, "logged once a minute at most");
  noSecretIn(h, secret);
});

test("every other Plex event -> 200 and ignored (nothing scheduled, nothing read)", async (t) => {
  const h = await setup(t);
  const url = await h.url();
  const events = ["media.play", "media.pause", "media.resume", "media.stop", "media.scrobble", "media.rate", "library.on.deck",
    "admin.database.backup", "admin.database.corrupted", "device.new", "playback.started"];
  for (const e of events) {
    const r = await h.deliver(e, { url });
    assert.equal(r.status, 200, e);
    assert.equal(r.body.outcome, "ignored", e);
    assert.ok(h.logs.includes("[plexhook] " + e + ": ignored"), e);
  }
  const odd = await h.deliver("<img src=x>", { url });
  assert.equal(odd.body.outcome, "ignored");
  assert.ok(h.logs.includes("[plexhook] unknown: ignored"), "an odd event name is never logged as sent");
  assert.equal(h.T.size(), 0);
  assert.equal(h.started(), 0);
  assert.equal(h.hook.servers.size, 0, "only new-title messages list a server");
  const card = (await h.card()).body;
  assert.deepEqual(card.last.outcome, "ignored");
  assert.equal(card.last_new, null, "no new title came");
  assert.equal(card.ignored.length, events.length + 1);
  assert.ok(card.ignored.every((x) => x.n === 1));
  assert.deepEqual([...h.store.m.keys()], ["secret"], "an ignored event is never written to the database");
});

test("the catalog off or the webhook switched off -> ignored; switched off during the wait -> the sync is dropped", async (t) => {
  const h = await setup(t, { cfg: { clerk_enabled: "off" } });
  const url = await h.url();
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "catalog_off");
  assert.equal(h.T.size(), 0);
  h.cfg.clerk_enabled = "staff"; h.cfg.catalog_hook = false;
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "switch_off");
  assert.equal(h.T.size(), 0);
  h.cfg.catalog_hook = true;
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  h.cfg.catalog_hook = false;
  await h.T.advance(30000);
  assert.equal(h.started(), 0, "dropped");
  assert.ok(h.logs.some((l) => /webhook sync dropped: the webhook is switched off/.test(l)));
  h.cfg.catalog_hook = true;
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  h.cfg.clerk_enabled = "off";
  await h.T.advance(30000);
  assert.equal(h.started(), 0, "dropped");
  assert.ok(h.logs.some((l) => /webhook sync dropped: the catalog is off/.test(l)));
  const card = (await h.card()).body;
  assert.equal(card.catalog_on, false);
  assert.equal(card.pending, null);
});

test("the quiet window (03:40-04:20 UTC): a request waits until it ends", async (t) => {
  const day = Date.UTC(2026, 10, 14);
  const h = await setup(t, { start: day + 3 * 3600000 });                    // 03:00
  await h.catalog.sync({ full: true });
  const url = await h.url();
  h.T.jump(day + (3 * 60 + 50) * 60000);                                     // 03:50
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  await h.T.advance(30000);
  assert.equal(h.started(), 1, "not inside the window");
  assert.equal(h.T.size(), 1, "re-armed for the window's end");
  await h.T.advance(day + (4 * 60 + 20) * 60000 - 1 - h.T.now());           // 04:19:59.999
  assert.equal(h.started(), 1);
  await h.T.advance(1);
  await h.idle();
  assert.equal(h.started(), 2);
  assert.equal(h.syncAt[1], day + (4 * 60 + 20) * 60000, "at 04:20:00");
  // a request during the window joins the one waiting for its end
  h.T.jump(day + 86400000 + (3 * 60 + 41) * 60000);                          // the next day 03:41
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  await h.T.advance(60000);
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "joined");
  await h.T.advance(day + 86400000 + (4 * 60 + 20) * 60000 - h.T.now());
  await h.idle();
  assert.equal(h.started(), 3);
});

test("a thumbnail is drained and discarded: never written to disk, a table or memory the card can show", async (t) => {
  const h = await setup(t);
  const url = await h.url();
  const thumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("THUMB-MARKER-BYTES ".repeat(4000)), Buffer.from([0xff, 0xd9])]);
  const before = new Set(fs.readdirSync(tmp));
  const r = await h.deliver("library.new", { url, thumb });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "scheduled", "the payload is still read (Plex sends it first)");
  const ignored = await h.deliver("library.on.deck", { url, thumb });
  assert.equal(ignored.body.outcome, "ignored");
  const after = fs.readdirSync(tmp).filter((f) => !before.has(f));
  assert.deepEqual(after, [], "no file appeared (no uploads/ directory either)");
  assert.ok(!fs.existsSync(path.join(tmp, "uploads")));
  for (const v of h.store.m.values()) assert.ok(!v.includes("THUMB-MARKER"));
  assert.ok(!JSON.stringify((await h.card()).body).includes("THUMB-MARKER"));
  for (const l of h.logs) assert.ok(!l.includes("THUMB-MARKER"));
  const src = fs.readFileSync(path.join(repo, "plexhook.js"), "utf8");
  assert.doesNotMatch(src, /\.on\("file"/, "no file handler: busboy skips a file part without making a stream");
  assert.doesNotMatch(src, /require\("multer"\)|diskStorage|dest:|createWriteStream/, "no multer, no disk storage");
});

/** A POST without Content-Length (chunked), the way a client streaming a big body would send it. */
function chunked(url, type, chunks) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": type, "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve("reset"));
    for (const c of chunks) req.write(c);
    req.end();
  });
}

test("the size cap: the whole body (Content-Length or streamed) and the payload field; multipart only", async (t) => {
  assert.equal(PH.MAX_BODY, 4 * 1024 * 1024);
  assert.equal(PH.MAX_PAYLOAD, 256 * 1024);
  const h = await setup(t, { maxBody: 64 * 1024, maxPayload: 8 * 1024 });
  const url = await h.url(), local = url.replace("https://publicaccess.tv", h.base);
  const big = Buffer.alloc(100 * 1024, 0x61);
  let r = await h.deliver("library.new", { url, thumb: big });
  assert.equal(r.status, 413, "Content-Length over the cap");
  assert.equal((await h.card()).body.last.outcome, "too_large");
  r = await h.deliver("library.new", { url, extra: { Metadata: { summary: "s".repeat(9 * 1024) } } });
  assert.equal(r.status, 413, "a payload field over its cap");
  const { body, type } = plexBody("library.new", {}, big);
  const status = await chunked(local, type, [body.subarray(0, 30000), body.subarray(30000, 70000), body.subarray(70000)]);
  assert.equal(status, 413, "streamed past the cap");
  assert.equal(h.T.size(), 0, "nothing scheduled by an oversized delivery");
  r = await h.deliver("library.new", { url, thumb: Buffer.alloc(32 * 1024, 0x62) });
  assert.equal(r.body.outcome, "scheduled", "a thumbnail inside the cap is fine");
  // not multipart / no payload / a payload that isn't JSON: refused, nothing scheduled
  const asJson = await fetch(local, { method: "POST", body: JSON.stringify({ event: "library.new" }), headers: { "Content-Type": "application/json" } });
  assert.equal(asJson.status, 415);
  r = await h.deliver("library.new", { url, raw: multipart([{ name: "other", value: "x" }]) });
  assert.equal(r.status, 400);
  r = await h.deliver("library.new", { url, raw: multipart([{ name: "payload", value: "{not json" }]) });
  assert.equal(r.status, 400);
  r = await h.deliver("library.new", { url, raw: multipart([{ name: "payload", value: "[1,2]" }]) });
  assert.equal(r.status, 400);
  const broken = await fetch(local, { method: "POST", body: "--x\r\nnonsense", headers: { "Content-Type": "multipart/form-data; boundary=x" } });
  assert.equal(broken.status, 400);
  assert.equal(h.T.size(), 1, "only the good one waits");
  assert.ok(h.logs.includes("[plexhook] -: refused (too large)"));
  // review: a sender that goes away mid-body - the parse settles (refused), never a delivery left hanging
  const refusedLine = "[plexhook] -: refused (not a Plex webhook delivery)";
  const before = h.logs.filter((l) => l === refusedLine).length;
  const cut = plexBody("library.new", {}, Buffer.alloc(16 * 1024, 0x63));
  await new Promise((resolve) => {
    const u = new URL(local);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": cut.type, "Content-Length": cut.body.length } });
    req.on("error", () => resolve());
    req.write(cut.body.subarray(0, 2000));
    setTimeout(() => { req.destroy(); resolve(); }, 50);
  });
  await waitFor(() => h.logs.filter((l) => l === refusedLine).length > before, "the cut-off delivery to settle");
  assert.equal(h.T.size(), 1, "it scheduled nothing");
});

test("the rate limit: per IP and overall, for deliveries with the right secret; a wrong secret is never told the route exists", async (t) => {
  const h = await setup(t, { limits: { perIp: 3, all: 5, windowMs: 60000 } });
  const url = await h.url();
  const from = (ip) => ({ url, headers: { "CF-Connecting-IP": ip } });
  for (let i = 0; i < 3; i++) assert.equal((await h.deliver("media.play", from("198.51.100.7"))).status, 200);
  let r = await h.deliver("library.new", from("198.51.100.7"));
  assert.equal(r.status, 429, "the 4th from one address");
  assert.ok(Number(r.retry) >= 1, "Retry-After");
  for (let i = 0; i < 2; i++) assert.equal((await h.deliver("media.play", from("203.0.113.9"))).status, 200);
  r = await h.deliver("media.play", from("203.0.113.9"));
  assert.equal(r.status, 429, "overall: 5 in the window");
  const wrong = await fetch(h.base + "/api/plex/webhook/" + "B".repeat(43), { method: "POST", body: "x", headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "198.51.100.7" } });
  assert.equal(wrong.status, 404, "a wrong secret is answered like an unknown address, limits or not");
  assert.equal((await h.card()).body.last.outcome, "rate_limited");
  assert.equal(h.logs.filter((l) => /refused \(rate limit\)/.test(l)).length, 1, "logged once a minute at most");
  assert.equal(h.T.size(), 0, "the limited library.new scheduled nothing");
  assert.deepEqual(PH.LIMITS, { perIp: 120, all: 600, windowMs: 60000 });
});

test("server identifier: any server until one is picked on the card; then only that server's library.new acts", async (t) => {
  const h = await setup(t);
  const url = await h.url();
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled", "nothing picked: any server with the URL");
  await h.deliver("library.new", { url, extra: { Server: { title: "Another <b>Server</b>", uuid: OTHER } } });
  let card = (await h.card()).body;
  assert.equal(card.server, "");
  assert.deepEqual(card.servers.map((s) => [s.id, s.name, s.n, s.pinned]), [[OTHER, "Another <b>Server</b>", 1, false], [SERVER, "Fixture Server", 1, false]]);
  let r = await h.adminPost("/api/media/admin/catalog/hook/server", { server: SERVER });
  assert.equal(r.status, 200);
  assert.equal(r.body.server, SERVER);
  assert.equal(h.cfg.catalog_hook_server, SERVER);
  assert.deepEqual(h.audits.at(-1).slice(1), ["media_settings", null, { catalog_hook_server: { from: "", to: SERVER } }]);
  await h.T.advance(30000); await h.idle();
  const n = h.started();
  assert.equal((await h.deliver("library.new", { url, extra: { Server: { title: "x", uuid: OTHER } } })).body.outcome, "other_server");
  assert.equal((await h.deliver("library.new", { url, extra: { Server: undefined } })).body.outcome, "other_server", "no identifier: not ours");
  assert.equal((await h.deliver("library.new", { url, extra: { Server: { uuid: "bad id!" } } })).body.outcome, "other_server");
  assert.equal(h.T.size(), 0);
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled", "ours");
  await h.T.advance(300000); await h.idle();
  assert.equal(h.started(), n + 1);
  card = (await h.card()).body;
  assert.equal(card.servers.find((s) => s.id === SERVER).pinned, true);
  r = await h.adminPost("/api/media/admin/catalog/hook/server", { server: "not an id" });
  assert.equal(r.status, 400);
  assert.equal(h.cfg.catalog_hook_server, SERVER, "unchanged");
  r = await h.adminPost("/api/media/admin/catalog/hook/server", { server: "" });
  assert.equal(r.body.server, "", "any server again");
  for (const l of h.logs) assert.ok(!l.includes("Another") && !l.includes(OTHER), "server names / ids aren't logged");
  for (let i = 0; i < 8; i++) await h.deliver("library.new", { url, extra: { Server: { title: "s" + i, uuid: "0000000000" + i } } });
  assert.equal(h.hook.servers.size, 5, "a short in-memory list");
});

test("regenerating the secret kills the old URL at once and for good (the secret lives in myapp.db's plex_hook table)", async (t) => {
  const h = await setup(t, { store: PH.dbStore() });
  const url1 = await h.url();
  assert.equal(await h.url(), url1, "made once");
  assert.equal((await h.deliver("library.new", { url: url1 })).status, 200);
  assert.equal((await h.deliver("media.play", { url: url1 })).status, 200);
  const r = await h.adminPost("/api/media/admin/catalog/hook/regenerate", {});
  assert.equal(r.status, 200);
  const url2 = r.body.url;
  assert.notEqual(url2, url1);
  assert.match(url2, /^https:\/\/publicaccess\.tv\/api\/plex\/webhook\/[A-Za-z0-9_-]{43}$/);
  assert.equal((await h.deliver("media.play", { url: url1 })).status, 404, "the old URL");
  assert.equal((await h.deliver("media.play", { url: url2 })).status, 200, "the new one");
  assert.deepEqual(h.audits.at(-1).slice(1), ["plex_hook_secret", null, { regenerated: true }]);
  assert.ok(h.logs.some((l) => /webhook secret regenerated by admin1/.test(l)));
  // a restart: a new instance reads the stored secret (and the last delivery)
  const { getQuery } = require(path.join(repo, "dbUtils"));
  await waitFor(async () => (await getQuery("SELECT v FROM plex_hook WHERE k = 'last_new'")).length === 1, "the last new title to be stored");
  const fresh = h.mkHook(PH.dbStore());
  const base2 = await h.serve(fresh);
  const after = (await h.card("admin1", base2)).body;
  assert.deepEqual(after.last_new, { at: AT, outcome: "scheduled" }, "the last new title survives a restart");
  assert.equal(after.last, null, "the last delivery of any kind is memory only");
  assert.equal((await h.card("admin1", base2)).body.url, url2);
  assert.equal((await h.deliver("media.play", { url: url1, base: base2 })).status, 404);
  assert.equal((await h.deliver("media.play", { url: url2, base: base2 })).status, 200);
  const rows = await getQuery("SELECT k FROM plex_hook ORDER BY k");
  assert.deepEqual(rows.map((x) => x.k), ["last_new", "secret"]);
  await conf.init();
  const settingsRows = await getQuery("SELECT key, value FROM media_settings");
  assert.ok(!JSON.stringify(settingsRows).includes(secretOf(url2)), "never a setting");
  noSecretIn(h, secretOf(url1)); noSecretIn(h, secretOf(url2));
});

test("the admin card: the URL only for admins (no-store), same-site POSTs only; the page never renders it", async (t) => {
  const h = await setup(t);
  const anon = await h.card(null), member = await h.card("member1"), admin = await h.card("admin1");
  assert.equal(anon.status, 403); assert.equal(member.status, 403); assert.equal(admin.status, 200);
  const secret = secretOf(admin.body.url);
  assert.ok(!JSON.stringify(anon.body).includes(secret) && !JSON.stringify(member.body).includes(secret));
  assert.equal(admin.cache, "no-store");
  assert.equal(admin.body.on, true); assert.equal(admin.body.catalog_on, true); assert.equal(admin.body.debounce_s, 30);
  assert.equal((await h.adminPost("/api/media/admin/catalog/hook/regenerate", {}, "member1")).status, 403);
  const cross = await h.adminPost("/api/media/admin/catalog/hook/regenerate", {}, "admin1", { "Content-Type": "application/json", "x-test-user": "admin1", Origin: "https://evil.example", "X-Requested-With": "fetch" });
  assert.equal(cross.status, 403, "another site");
  const bare = await h.adminPost("/api/media/admin/catalog/hook/regenerate", {}, "admin1", { "Content-Type": "application/json", "x-test-user": "admin1" });
  assert.equal(bare.status, 403, "not the page's fetch");
  assert.equal((await h.adminPost("/api/media/admin/catalog/hook/server", { server: SERVER }, "member1")).status, 403);
  assert.equal(await h.url(), admin.body.url, "nothing changed the secret");
  // the page: the card is text from en.json, no URL / secret in the HTML; the URL comes from the admin route only
  const ejs = require("ejs");
  const view = fs.readFileSync(path.join(repo, "views", "mediaAdmin.ejs"), "utf8");
  const card = view.slice(view.indexOf('  <section class="sb-card" id="plexHook"'), view.indexOf('  <section class="sb-card" id="clerkLists"'));
  const html = ejs.render(card, { t: (k) => { assert.ok(EN[k], k); return EN[k]; } });
  assert.match(html, /Plex Web → Settings → Webhooks → Add Webhook, paste this URL \(needs Plex Pass\)/);
  assert.doesNotMatch(html, /\/api\/plex\/webhook|undefined/);
  assert.doesNotMatch(view, /api\/plex\/webhook/, "the view never builds the URL");
  const web = fs.readFileSync(path.join(repo, "mediaweb.js"), "utf8");
  const render = web.slice(web.indexOf('res.render("mediaAdmin"'), web.indexOf("} catch (e) {", web.indexOf('res.render("mediaAdmin"')));
  assert.doesNotMatch(render, /hook|secret/i, "the page's render gets nothing of the webhook");
  const js = fs.readFileSync(path.join(repo, "public", "js", "media-admin.js"), "utf8");
  assert.match(js, /api\("GET", "\/api\/media\/admin\/catalog\/hook"\)/);
});

test("the card's script: the URL masked until Show, Copy copies it whole, Regenerate asks first; text only", async () => {
  const nodes = new Map(), requests = [];
  let confirmAnswer = false, copied = null;
  function element(tag) {
    return { tag, children: [], handlers: {}, style: {}, textContent: "", disabled: false, attrs: {},
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(k, v) { this.attrs[k] = v; },
      set innerHTML(_) { throw new Error("the card writes text only"); } };
  }
  for (const id of ["phOut", "phUrl", "phShow", "phCopy", "phRegen", "phMsg"]) nodes.set(id, element("div"));
  const SECRET = "S".repeat(43), SECRET2 = "T".repeat(43);
  let state = { ok: true, url: "https://publicaccess.tv/api/plex/webhook/" + SECRET, on: true, catalog_on: true, debounce_s: 30, server: "",
    servers: [{ id: SERVER, name: "<img src=x onerror=unsafe()>", n: 2, at: AT, pinned: false }], last_new: { at: AT, outcome: "scheduled" },
    last: { at: AT + 60000, event: "media.pause", outcome: "ignored" }, ignored: [{ event: "media.pause", n: 7, at: AT + 60000 }, { event: "media.play", n: 3, at: AT }],
    gap_min: 5, wrong: null, pending: { due: AT + 30000, after_running: false } };
  const document = { getElementById: (id) => nodes.get(id) || null, createElement: element, createTextNode: (s) => ({ textContent: s, children: [] }),
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: element("body") };
  const window = { addEventListener() {}, confirm: () => confirmAnswer,
    navigator: { clipboard: { writeText: (s) => { copied = s; return Promise.resolve(); } } },
    __t(key, fallback, values) { assert.ok(EN[key], key); assert.equal(EN[key], fallback, key + " default = en.json"); return fallback.replace(/\{(\w+)\}/g, (m, n) => values && values[n] != null ? String(values[n]) : m); } };
  const context = { document, window, console, Promise, Date, Number, String, isNaN, setTimeout, clearTimeout, encodeURIComponent,
    fetch(url, options) {
      requests.push({ url, options });
      let result = { ok: true };
      if (url === "/api/media/admin/catalog/hook") result = state;
      else if (url === "/api/media/admin/catalog/hook/regenerate") { state = { ...state, url: "https://publicaccess.tv/api/plex/webhook/" + SECRET2 }; result = state; }
      else if (url === "/api/media/admin/catalog/hook/server") { state = { ...state, server: JSON.parse(options.body).server }; state.servers = state.servers.map((s) => ({ ...s, pinned: s.id === state.server })); result = state; }
      else if (url === "/api/media/admin/checks") result = { ok: true, checks: {} };
      else if (url === "/api/media/admin/catalog") result = { ok: true, sections: [] };
      else if (url === "/api/media/admin/lists") result = { ok: true, configured: false };
      else if (url === "/api/media/admin/plex") return Promise.reject(new Error("not in this test"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
    } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "media-admin.js"), "utf8"), context);
  await flush();
  const text = (node) => [node.textContent, ...(node.children || []).map(text)].join(" ");
  const url = nodes.get("phUrl");
  assert.equal(url.textContent, "https://publicaccess.tv/api/plex/webhook/••••••••", "masked");
  assert.equal(nodes.get("phCopy").disabled, false);
  const out = text(nodes.get("phOut"));
  assert.match(out, /On: a title Plex adds is read into the catalog about 30 seconds later, but never sooner than 5 minutes after the previous catalog read ended\./);
  assert.match(out, /Last new title \(library\.new\): .+, a catalog read was scheduled\./, "the new title's line, though playback came after it");
  assert.match(out, /Last webhook of any kind: .+, media\.pause, ignored \(only new titles count\)\./);
  assert.match(out, /Answered and ignored since the site started: media\.pause × 7, media\.play × 3\./);
  assert.match(out, /<img src=x onerror=unsafe\(\)> \(a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\): 2 new-title messages/, "a server's name is text");
  assert.ok(!out.includes(SECRET));
  nodes.get("phShow").handlers.click();
  assert.equal(url.textContent, "https://publicaccess.tv/api/plex/webhook/" + SECRET);
  assert.equal(nodes.get("phShow").textContent, "Hide");
  nodes.get("phShow").handlers.click();
  assert.ok(!url.textContent.includes(SECRET));
  nodes.get("phCopy").handlers.click(); await flush();
  assert.equal(copied, "https://publicaccess.tv/api/plex/webhook/" + SECRET, "the whole URL, though it shows masked");
  nodes.get("phRegen").handlers.click(); await flush();
  assert.ok(!requests.some((r) => r.url.endsWith("/regenerate")), "a no to the confirm: nothing sent");
  confirmAnswer = true;
  nodes.get("phRegen").handlers.click(); await flush();
  const regen = requests.find((r) => r.url.endsWith("/regenerate"));
  assert.equal(regen.options.method, "POST");
  assert.equal(regen.options.headers["X-Requested-With"], "fetch");
  assert.equal(url.textContent, "https://publicaccess.tv/api/plex/webhook/••••••••");
  nodes.get("phCopy").handlers.click(); await flush();
  assert.equal(copied, "https://publicaccess.tv/api/plex/webhook/" + SECRET2);
  const pin = (function find(n) { if (n.tag === "button" && n.textContent === "Accept only this server") return n; for (const c of n.children || []) { const f = find(c); if (f) return f; } return null; })(nodes.get("phOut"));
  pin.handlers.click(); await flush();
  assert.deepEqual(JSON.parse(requests.find((r) => r.url.endsWith("/hook/server")).options.body), { server: SERVER });
  assert.match(text(nodes.get("phOut")), /Accepted only from the Plex server a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\./);
  assert.ok(requests.every((r) => r.options.credentials === "same-origin"));
});

test("settings: the switch (on by default, a checkbox that saves off when unticked), the wait (10-600 s), the server id", async () => {
  const C = conf._CLEAN;
  assert.equal(conf.DEFAULTS.catalog_hook, true);
  assert.equal(conf.DEFAULTS.catalog_hook_debounce_s, 30);
  assert.equal(conf.DEFAULTS.catalog_hook_server, "");
  assert.equal(conf.DEFAULTS.catalog_hook_gap_min, 5);
  for (const [v, want] of [[0, 1], [1, 1], ["5", 5], [60, 60], [61, 60], ["abc", 5], [null, 1], [-2, 1], [2.7, 2]])
    assert.equal(C.catalog_hook_gap_min(v), want, "gap " + String(v));
  for (const [v, want] of [[5, 10], [10, 10], ["45", 45], [600, 600], [601, 600], ["1,000", 600], ["abc", 30], [null, 10], [-3, 10], [29.9, 29]])
    assert.equal(C.catalog_hook_debounce_s(v), want, String(v));
  for (const [v, want] of [[true, true], ["on", true], ["1", true], ["true", true], [false, false], ["0", false], [undefined, false], ["yes", false]])
    assert.equal(C.catalog_hook(v), want, String(v));
  for (const [v, want] of [[SERVER, SERVER], [" " + SERVER + " ", SERVER], ["short", ""], ["has space 12345", ""], ["<script>alert(1)</script>", ""], ["a".repeat(65), ""], [null, ""]])
    assert.equal(C.catalog_hook_server(v), want, String(v));
  await conf.init();
  let r = await conf.set({ _bools: ["catalog_hook"], catalog_hook_debounce_s: "90" }, "fixture-admin");
  assert.equal(r.settings.catalog_hook, false, "an unticked box saves off");
  assert.equal(r.settings.catalog_hook_debounce_s, 90);
  r = await conf.set({ _bools: ["catalog_hook"], catalog_hook: true, catalog_hook_debounce_s: 9999 }, "fixture-admin");
  assert.equal(r.settings.catalog_hook, true);
  assert.equal(r.settings.catalog_hook_debounce_s, 600);
  r = await conf.set({ catalog_hook_gap_min: "15" }, "fixture-admin");
  assert.equal(r.settings.catalog_hook_gap_min, 15, "the gap saves from the form");
  r = await conf.set({ catalog_hook_gap_min: "0" }, "fixture-admin");
  assert.equal(r.settings.catalog_hook_gap_min, 1, "clamped to 1-60");
  // the page: the switch + the wait in the settings form (the server id is the card's, never the form's)
  const view = fs.readFileSync(path.join(repo, "views", "mediaAdmin.ejs"), "utf8");
  assert.match(view, /name="_bools" value="[^"]*\bcatalog_hook\b/);
  assert.match(view, /<input type="checkbox" name="catalog_hook" <%= S\.catalog_hook !== false \? 'checked' : '' %>>/);
  assert.match(view, /name="catalog_hook_debounce_s" min="10" max="600"/);
  assert.match(view, /name="catalog_hook_gap_min" min="1" max="60"/);
  assert.doesNotMatch(view, /name="catalog_hook_server"/);
  // the catalog clamps the wait it is handed too
  const T = fakeTime(AT), cfg = { clerk_enabled: "staff", catalog_hook_debounce_s: 5 };
  const dir = fs.mkdtempSync(path.join(tmp, "clamp-"));
  const c = createCatalog({ file: path.join(dir, "c.db"), settings: () => cfg, now: T.now, setTimer: T.set, clearTimer: T.clear, mediactl: async () => ({ status: 503 }), log: { log() {}, error() {} } });
  try { assert.equal(c.soon().due, AT + 10000); } finally { await c.close(); }
  const c2 = createCatalog({ file: path.join(dir, "c2.db"), settings: () => ({ ...cfg, catalog_hook_debounce_s: 9999 }), now: T.now, setTimer: T.set, clearTimer: T.clear, mediactl: async () => ({ status: 503 }), log: { log() {}, error() {} } });
  assert.equal(c2.soon().due, AT + 600000);
  await c2.close();
  assert.equal(c2.soon().state, "closed");
  // ... and the gap (1-60 minutes after the last run ended)
  for (const [gap, want] of [[0, 60000], [9999, 3600000], [undefined, 300000]]) {
    const g = { ...cfg, catalog_hook_debounce_s: 10, catalog_hook_gap_min: gap };
    const c3 = createCatalog({ file: path.join(dir, "c3-" + String(gap) + ".db"), settings: () => g, now: T.now, sleep: async () => {}, setTimer: T.set, clearTimer: T.clear, mediactl: async () => ({ status: 503 }), log: { log() {}, error() {} } });
    try { await c3.sync(); assert.equal(c3.soon().due, T.now() + want, "gap " + String(gap)); } finally { await c3.close(); }
  }
});

test("wiring: index.js serves the webhook before the cookie / session / body middleware; staging keeps its own secret; en.json has the strings", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const hookAt = idx.indexOf('require("./plexhook").registerEarly(app)');
  assert.ok(hookAt > 0);
  for (const later of ["app.use(cookieParser(", "app.use(loginSessions.gate)", "secret: process.env.APP_SESSION_SECRET,", "app.use(cors())", "express.json()(req, res, next)", "app.use(express.urlencoded("])
    assert.ok(idx.indexOf(later) > hookAt, later + " comes after the webhook");
  assert.match(fs.readFileSync(path.join(repo, "mediaweb.js"), "utf8"), /require\("\.\/plexhook"\)\.registerAdmin\(app, \{ addUser \}\)/);
  assert.ok(require(path.join(repo, "deploy", "keep-staging-tables")).KEEP.includes("plex_hook"));
  const view = fs.readFileSync(path.join(repo, "views", "mediaAdmin.ejs"), "utf8");
  for (const m of view.matchAll(/t\('(adm\.media\.hook\.[a-z_]+)'\)/g)) assert.ok(EN[m[1]], m[1]);
  const js = fs.readFileSync(path.join(repo, "public", "js", "media-admin.js"), "utf8");
  let n = 0;
  for (const m of js.matchAll(/\bht\("([a-z0-9_]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    n++;
    const k = "js.media.hook." + m[1];
    assert.ok(k in EN, k + " in en.json");
    assert.equal(EN[k], JSON.parse('"' + m[2] + '"'), k + ": the script's default is the English text");
  }
  assert.ok(n >= 30);
  assert.equal(EN["adm.media.hook.enabled"], "Update the catalog when Plex adds something (webhook)");
});

// ── review 1.99anw ──

test("review: a body that trips a parser limit and then has a malformed part header never ends the process (child process)", async (t) => {
  // multer 1.4.5-lts.1 took busboy's listeners off on a limit; busboy's next "Malformed part header" was then an unhandled
  // 'error' event and the site's process exited (code 1). The four bodies the review found, then a good delivery.
  const SECRET = "C".repeat(43);
  const src = [
    '"use strict";',
    'const express = require("express");',
    "const PH = require(" + JSON.stringify(path.join(repo, "plexhook")) + ");",
    "const SECRET = " + JSON.stringify(SECRET) + ";",
    "const hook = PH.createHook({ store: { get: async () => SECRET, put: async () => {}, putIfMissing: async () => {} }, settings: () => ({ catalog_hook: true }),",
    "  catalog: { soon: () => ({ ok: true, state: 'scheduled', due: Date.now() + 30000 }), inUse: () => true, hookState: () => ({}) },",
    "  log: { log() {}, error() {} }, origin: () => 'https://publicaccess.tv' });",
    "const app = express();",
    "hook.registerEarly(app);",
    "app.use((req, res) => res.status(404).json({ error: 'not found' }));",
    "const server = app.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\\n'));",
  ].join("\n");
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["-e", src], { cwd: tmp, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", exited = null;
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  t.after(() => { if (!exited) child.kill(); });
  await waitFor(() => /PORT \d+/.test(out) || exited, "the child to listen");
  assert.equal(exited, null, "the child started: " + err);
  const port = Number(/PORT (\d+)/.exec(out)[1]);
  const send = (body, type) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/plex/webhook/" + SECRET, method: "POST",
      headers: { "Content-Type": type, "Content-Length": body.length } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", (e) => resolve("error " + e.code));
    req.end(body);
  });
  const B = "crashFixture";
  const part = (name, value, extra = "") => "--" + B + "\r\nContent-Disposition: form-data; name=\"" + name + "\"" + extra + "\r\n\r\n" + value + "\r\n";
  const malformed = "--" + B + "\r\nthis header line has no colon\r\n\r\nx\r\n--" + B + "--\r\n";
  const bodies = {
    fields: [0, 1, 2, 3, 4].map((i) => part("f" + i, "x")).join("") + malformed,                       // 5 fields (limit 4)
    fieldkey: part("k".repeat(80), "x") + malformed,                                                   // a field name over 64
    fieldsize: part("payload", "p".repeat(300 * 1024)) + malformed,                                    // a payload over 256 KB
    files: [0, 1, 2].map((i) => part("thumb" + i, "JPEG", "; filename=\"t" + i + ".jpg\"\r\nContent-Type: image/jpeg")).join("") + malformed,   // 3 files (limit 2)
    parts: [0, 1, 2, 3].map((i) => part("f" + i, "x")).join("") + [0, 1].map((i) => part("thumb" + i, "JPEG", "; filename=\"t.jpg\"")).join("") + malformed,   // 6 parts
    malformed_only: part("payload", "{}") + malformed,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const status = await send(Buffer.from(body), "multipart/form-data; boundary=" + B);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(exited, null, name + ": the process is still running (" + err.split("\n").slice(0, 3).join(" | ") + ")");
    assert.ok(status === 413 || status === 400, name + " -> " + status);
    if (name !== "malformed_only") assert.equal(status, 413, name + ": over a limit");
  }
  const truncated = Buffer.from(part("payload", JSON.stringify({ event: "library.new" })).slice(0, 60));
  assert.equal(await send(truncated, "multipart/form-data; boundary=" + B), 400, "a cut-off body");
  const good = plexBody("library.new");
  assert.equal(await send(good.body, good.type), 200, "and it still answers a good delivery");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exited, null);
  assert.doesNotMatch(err, /Unhandled|ERR_UNHANDLED_ERROR|Malformed part header/, err);
});

test("review: webhook runs keep catalog_hook_gap_min after the last run ended - an all-night trickle is a run per gap, not per title", async (t) => {
  const h = await setup(t);
  await h.catalog.sync({ full: true });
  const url = await h.url();
  // a library.new every 2 minutes for 3 hours (Sonarr importing a season one episode at a time)
  const start = h.T.now();
  for (let i = 0; i < 90; i++) {
    await h.deliver("library.new", { url });
    await h.T.advance(120000);
    await h.idle();
  }
  await h.T.advance(600000); await h.idle();
  const runs = h.syncAt.slice(1);                       // the setup's sweep aside
  t.diagnostic("90 library.new over 3 hours -> " + runs.length + " catalog runs");
  assert.ok(runs.length >= 25 && runs.length <= 37, "about one run per 5-minute gap + its wait, not 90: " + runs.length);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= 300000, "run " + i + " came " + (runs[i] - runs[i - 1]) / 1000 + " s after the one before");
  assert.ok(runs[0] - start >= 300000, "the first one waited for the gap after the setup's sweep");
  assert.ok(h.syncAt.at(-1) >= start + 89 * 120000, "the last title was read too");
  assert.equal(h.T.size(), 0, "nothing left waiting");
  // "Sync now" while a webhook run waits moves the gap on: the webhook's run waits 5 minutes after Sync now ended
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  await h.catalog.sync();                               // Sync now, while the webhook's run waits its 30 s
  const now1 = h.T.now(), n = h.started();
  await h.T.advance(299999); await h.idle();
  assert.equal(h.started(), n, "not inside the gap after Sync now");
  await h.T.advance(1); await h.idle();
  assert.equal(h.started(), n + 1);
  assert.equal(h.syncAt.at(-1), now1 + 300000);
  // the first request long after any run: only the debounce
  h.T.jump(h.T.now() + 3600000);
  const at = h.T.now();
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  await h.T.advance(30000); await h.idle();
  assert.equal(h.syncAt.at(-1), at + 30000, "30 s, no gap to keep");
  assert.ok(h.logs.includes("[plexhook] library.new: changes-only catalog sync in 300 s"), "the log says when, gap included");
});

test("review: the card keeps the last new title apart from the last delivery; ignored events are counted in memory, not written", async (t) => {
  const base = memStore();
  let puts = 0;
  const store = { ...base, put: async (k, v) => { puts++; return base.put(k, v); } };
  const h = await setup(t, { store });
  const url = await h.url();
  const p0 = puts;
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "scheduled");
  assert.equal(puts, p0 + 1, "a new title: one write");
  const events = ["media.play", "media.pause", "media.resume", "media.pause", "media.stop", "media.scrobble", "media.play", "media.pause"];
  for (const e of events) assert.equal((await h.deliver(e, { url })).body.outcome, "ignored");
  assert.equal(puts, p0 + 1, "no write for any of the playback events");
  let card = (await h.card()).body;
  assert.deepEqual(card.last_new, { at: AT, outcome: "scheduled" }, "what became of the new title is still on the card");
  assert.deepEqual(card.last, { at: AT, event: "media.pause", outcome: "ignored" });
  const counts = Object.fromEntries(card.ignored.map((x) => [x.event, x.n]));
  assert.deepEqual(counts, { "media.pause": 3, "media.play": 2, "media.resume": 1, "media.stop": 1, "media.scrobble": 1 });
  assert.deepEqual(card.ignored.slice(0, 2).map((x) => x.event), ["media.pause", "media.play"], "most first");
  // a refused new title shows as such, whatever came after it
  h.cfg.catalog_hook_server = OTHER;
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "other_server");
  await h.deliver("media.play", { url });
  card = (await h.card()).body;
  assert.equal(card.last_new.outcome, "other_server");
  assert.equal(card.last.event, "media.play");
  h.cfg.catalog_hook_server = ""; h.cfg.clerk_enabled = "off";
  assert.equal((await h.deliver("library.new", { url })).body.outcome, "catalog_off");
  await h.deliver("media.stop", { url });
  assert.equal((await h.card()).body.last_new.outcome, "catalog_off");
  assert.equal(puts, p0 + 3, "one write per new-title message, none for the rest");
  assert.deepEqual(JSON.parse(base.m.get("last_new")), { at: AT, outcome: "catalog_off" });
  assert.ok(!base.m.has("last"), "no any-delivery record in the database");
  // the counts stay small: at most IGNORED_KEPT names (+ "unknown")
  for (let i = 0; i < 40; i++) await h.deliver("custom.event" + i, { url });
  card = (await h.card()).body;
  assert.ok(card.ignored.length <= 25, String(card.ignored.length));
  assert.ok(card.ignored.some((x) => x.event === "unknown"));
});

// Review 1.99anw: "Sync now" pressed while the webhook's run is in flight - the page says the full sync is queued behind it (it
// used to say "Sync started" for every answer, the maintenance window's refusal included)
test("review: the Sync now button says what the server did - started, queued behind the run in flight, already running, the maintenance window", async () => {
  const nodes = new Map();
  function element(tag) {
    return { tag, children: [], handlers: {}, style: {}, textContent: "", disabled: false, attrs: {},
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(k, v) { this.attrs[k] = v; },
      set innerHTML(_) { throw new Error("text only"); } };
  }
  for (const id of ["pcOut", "pcSync", "pcMsg"]) nodes.set(id, element("div"));
  let answer = null;
  const document = { getElementById: (id) => nodes.get(id) || null, createElement: element, createTextNode: (s) => ({ textContent: s, children: [] }),
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: element("body") };
  const window = { addEventListener() {},
    __t(key, fallback, values) { assert.ok(EN[key], key); assert.equal(EN[key], fallback, key + " default = en.json"); return fallback.replace(/\{(\w+)\}/g, (m, n) => values && values[n] != null ? String(values[n]) : m); } };
  const context = { document, window, console, Promise, Date, Number, String, isNaN, setTimeout() { return 0; }, clearTimeout() {}, encodeURIComponent,
    fetch(url) {
      let result = { ok: true };
      if (url === "/api/media/admin/catalog/sync") result = answer;
      else if (url === "/api/media/admin/catalog") result = { ok: true, sections: [] };
      else if (url === "/api/media/admin/checks") result = { ok: true, checks: {} };
      else if (url === "/api/media/admin/lists") result = { ok: true, configured: false };
      else if (url === "/api/media/admin/plex" || url === "/api/media/admin/catalog/hook") return Promise.reject(new Error("not in this test"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
    } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "media-admin.js"), "utf8"), context);
  await flush();
  const said = async (a) => { answer = a; nodes.get("pcSync").handlers.click(); await flush(); return nodes.get("pcMsg").textContent; };
  assert.equal(await said({ ok: true, started: true, syncing: true }), EN["js.media.catalog.sync_started"]);
  assert.equal(await said({ ok: true, started: false, syncing: true, queued: "full" }), "A catalog read is already running. The full sync starts as soon as it finishes.");
  assert.equal(await said({ ok: true, started: false, syncing: true, running: "full" }), "A full sync is already running. Status updates automatically.");
  assert.equal(await said({ ok: true, started: false, skipped: "maintenance" }), "No sync during the nightly maintenance window (03:40-04:20 UTC). Try again after it.");
  assert.equal(nodes.get("pcSync").disabled, false, "the button comes back");
});
