// 1.99acb: a web-relayed chat line never goes missing on the sender's page (prod 2026-10-18, Pepe's Pad: "qqq" reached the
// Camfrog room and was stored as plantbaked's own line, but the sender's page never showed it until a reload).
//   - H1: Pepe's ack + the line's echo in ONE /api/bridge/sync while the sender's page waits on /live?wait=1: the answer must
//     never carry a cursor (or the sender's mine[].c) past a line it doesn't carry - liveView takes ONE synchronous snapshot
//   - H4: the same for any viewer when the answer waits on real I/O (a cold name cache, meFor) while a line is pushed
//   - H3: the pad's relay outbox (public/js/room-bridge.js) drops a pending line only for a room line the page really has
//     (the site tags the viewer's own echoed line with its job + client id); a line it was told about but never given is
//     kept (as sent) and fetched again (relay.refetch), and the pages dedupe what an answer brings twice
//   - H5: the homepage widget (views/home.ejs, real code in a stub DOM against the real server) shows the line exactly once -
//     also when one answer brings 80+ lines with yours among the oldest (it draws only the newest 80, and told the outbox
//     about all of them: the pending line was dropped for a line never drawn)
//   - H7: an echo whose sender ref didn't come through is attributed BY ITS JOB - the sender's line (their linked login, or
//     their account when they have no chat login), with Pepe's words or the words in his own posted line; a linked login the
//     site can't show (a character outside [\w.-]) stays Pepe's line - never re-keyed to "u:<id>", which would slip past
//     every login-keyed quote / likeness privacy rule; with no usable sender it still settles the pending line
//   - H12: an echo of a line Pepe acked as never sent (send_failed) isn't shown; noteEcho never turns that into "sent"
//   - an echo from another room never settles the job (logged)
//   node --test test/relay-echo-race.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-echo-race-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));

const ROOM = { id: "Chat.Room", name: "Chat Room" };
const OTHER = { id: "Other.Room", name: "Other Room" };
const SLUG = "chat-room";
const USERS = { u1: "alicep", u2: "bobp", u3abcdef12: "plantp", u4acct0001: "acctp" };
let base, server, seq = 0;
const snap = (extra, room = ROOM) => Object.assign({ room, topic: "", members: [{ login: "alicecf", display: "Alice" }], count: 2, relay: true }, extra);
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const bot = (p, body) => post(p, null, Object.assign({ password: "bot-token" }, body));
const sync = (body) => bot("/api/bridge/sync", Object.assign({ events: [], rooms: [snap()] }, body));
const say = (u, text, cid) => post("/api/rooms/" + SLUG + "/say", u, { text, cid });
const live = (u, q = "") => fetch(base + "/api/rooms/" + SLUG + "/live" + q, { headers: H(u) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = () => bridge.bySlug(SLUG);
const ev = (data, room = ROOM) => ({ op: "event", id: "e-" + (++seq), ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room }, data });
const pepeLine = (text) => ({ user: { id: "pepefrog", login: "pepefrog", is_self: true }, text, self: true });
const echo = (jobId, text, user = { id: "alicecf", login: "alicecf", display: "Alice" }, room = ROOM) =>
  ev(Object.assign(pepeLine("🌐 Alice (web): " + text), { web: { user, text, job: jobId } }), room);
const chat = (login, text) => ev({ user: { id: login, login, display: login }, text });
const lineC = (text) => { const it = R().feed.find((x) => x.text === text || x.what === text); return it ? it.c : null; };

/** The answer never passes a line of this room it doesn't carry; a mine[].c is always a line the answer carries (or one the
 *  page had: <= after). -> list of problems ([] = consistent). */
function holes(d, after) {
  const got = new Set((d.feed || []).map((x) => x.c));
  const out = [];
  for (const it of R().feed) if (it.c > after && it.c <= d.cursor && !got.has(it.c)) out.push("cursor " + d.cursor + " passes line " + it.c);
  for (const j of d.mine || []) if (j.c && j.c > after && !got.has(j.c)) out.push("mine c " + j.c + " not in the answer");
  return out;
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT,
                  avatar TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'alicep', 'Alice P', 'x', 'alicecf')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u2', 'bobp', 'Bob', 'x', 'bobcf')");
  // a linked Camfrog login the site's login pattern can't show (8 of 1210 linked logins on prod have such a character)
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u3abcdef12', 'plantp', 'Plant P', 'x', 'plant(1)')");
  // a PATV account with no chat login (its relayed lines go into the room as "🌐 acctp (PATV web): ...")
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u4acct0001', 'acctp', 'Acct P', 'x', NULL)");
  await sleep(150);
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: USERS[u] || u } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await sync({ rooms: [snap(), snap({}, OTHER)] });
  bridge._pepeName("pepefrog");
});
test.after(() => { if (server) { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } });

// ── H1 ──
test("H1: Pepe's ack + the echo in ONE sync while the sender's page waits - the answer never passes the line it doesn't carry", async () => {
  for (let n = 1; n <= 4; n++) {
    const text = "same sync " + n, cid = "cSAME00000" + n;
    let v = await live("u1", "?me=1");                                         // the sender opens the pad (warm caches)
    const s = await say("u1", text, cid);
    assert.equal(s.status, 200, JSON.stringify(s.d));
    v = await live("u1", "?after=" + v.cursor + "&wait=1&v=" + v.ver + "&mv=" + v.mver);   // wakes on the queued job
    relay.takeJobs(new Set([ROOM.id]), "pull");                                // Pepe claims it
    v = await live("u1", "?after=" + v.cursor + "&wait=1&v=" + v.ver + "&mv=" + v.mver);
    const after = v.cursor;
    const held = live("u1", "?after=" + after + "&wait=1&v=" + v.ver + "&mv=" + v.mver);     // parked
    await sleep(120);
    await sync({ rooms: [], acks: [{ id: s.d.id, ok: true, msg: "sent", t: { wait: 50, send: 200 } }], events: [echo(s.d.id, text)] });
    const d = await held;
    assert.deepEqual(holes(d, after), [], "round " + n + ": " + JSON.stringify({ cursor: d.cursor, mine: d.mine, feed: (d.feed || []).map((x) => x.c) }));
    const N = lineC(text);
    const inFeed = (d.feed || []).find((x) => x.c === N);
    assert.ok(inFeed || d.cursor < N, "round " + n + ": either the line or a cursor before it");
    // the page's next ask (after = this answer's cursor) brings it if this one didn't
    const got = inFeed || (await live("u1", "?after=" + d.cursor)).feed.find((x) => x.c === N);
    assert.ok(got && got.u.web && got.u.login === "alicecf", "the line reaches the page as the sender's: " + JSON.stringify(got));
    assert.equal(got.cid, cid, "tagged with the sender's client id");
    assert.equal(got.job, s.d.id, "and the job");
  }
});

// ── H4 ──
test("H4: an answer that waits on real I/O (cold name cache / meFor) never passes a line pushed meanwhile", async () => {
  const skipped = [];
  for (const mode of ["cold-names", "meFor"]) {
    for (let i = 0; i < 10; i++) {
      const what = "notice " + mode + " " + i;
      const after = R().feed[R().feed.length - 1].c;
      await bridge.liveView(R(), after, "u2", "bobcf", "bobp", false);          // warm names / flair
      if (mode === "cold-names") bridge._nameCache.clear();                     // = an entry older than NAME_TTL: a real query
      const p = bridge.liveView(R(), after, mode === "meFor" ? "u2" : null, mode === "meFor" ? "bobcf" : null, "bobp", mode === "meFor");
      const pushed = new Promise((r) => setImmediate(() => r(bridge.liveNotice(ROOM.id, { who: "Zed", pad: "Pad", what, link: "/p/x" }))));
      const d = await p;
      await pushed;
      const h = holes(d, after);
      if (h.length) skipped.push(mode + " " + i + ": " + h.join("; "));
    }
  }
  assert.deepEqual(skipped, [], "no answer may skip a line");
});

test("the viewer's OWN echoed line carries its job + client id; nobody else's view does", async () => {
  const text = "tag me", cid = "cTAGME0001";
  const s = await say("u1", text, cid);
  relay.takeJobs(new Set([ROOM.id]), "pull");
  const before = (await live("u1")).cursor;
  await sync({ rooms: [], events: [echo(s.d.id, text)] });
  const mine = (await live("u1", "?after=" + before)).feed.find((x) => x.text === text);
  assert.equal(mine.job, s.d.id);
  assert.equal(mine.cid, cid);
  const theirs = (await live("u2", "?after=" + before)).feed.find((x) => x.text === text);
  assert.ok(theirs && !("job" in theirs) && !("cid" in theirs), JSON.stringify(theirs));
  assert.ok(!R().feed.some((x) => "_job" in x || "job" in x), "the job id is never stored on the line");
});

// ── H7: attributed by the job ──
test("H7: a linked login the site can't show is never re-keyed to the account - Pepe's line, still settling the pending line", async () => {
  // their quote / likeness privacy (the !likeness clips-off opt-out, "remove me", Pepe's hidden_h) is keyed on the chat login
  // "plant(1)": a line keyed "u:u3abcdef12" slipped past all of it
  const text = "hi from plant", cid = "cPLANT0001";
  const s = await say("u3abcdef12", text, cid);
  assert.equal(s.status, 200, JSON.stringify(s.d));
  relay.takeJobs(new Set([ROOM.id]), "pull");
  const before = (await live("u3abcdef12")).cursor;
  // the prod bot sends the raw login (the site's cleanUser refuses it); a newer one may send only the words + job
  await sync({ rooms: [], events: [echo(s.d.id, text, { id: "plant(1)", login: "plant(1)", display: "Plant" }),
                                   ev(Object.assign(pepeLine("🌐 Plant (web): " + text + " 2"), { web: { text: text + " 2", job: s.d.id } }))] });
  const v = await live("u3abcdef12", "?after=" + before);
  const it = v.feed.find((x) => x.text === "🌐 Alice (web): " + text);
  assert.ok(it && it.u.self && it.u.login === "pepefrog", "Pepe's posted line, as it always was: " + JSON.stringify(v.feed));
  assert.ok(!v.feed.some((x) => x.text === text || (x.u && /^u:/.test(x.u.login || ""))), "never their line under their account key: " + JSON.stringify(v.feed));
  assert.ok(!R().feed.some((x) => x.u && x.u.login === "u:u3abcdef12"), "nothing stored under the account key");
  const m = v.mine.find((x) => x.cid === cid);
  assert.equal(m.c, it.c, "the pending line is swapped for it (by the job)");
  assert.equal(it.cid, cid);
});

test("H7: a PATV account with no chat login, sender ref lost -> their account's line by the job", async () => {
  const text = "acct words", cid = "cACCTW0001";
  const J = relay.newJob({ kind: "say", roomId: ROOM.id, userId: "u4acct0001", username: "acctp", camfrog: "", display: "", text, cid });
  relay.takeJobs(new Set([ROOM.id]), "pull");
  const before = (await live("u4acct0001")).cursor;
  await sync({ rooms: [], events: [ev(Object.assign(pepeLine("🌐 acctp (PATV web): " + text), { web: { text, job: J.id } }))] });
  const v = await live("u4acct0001", "?after=" + before);
  const it = v.feed.find((x) => x.text === text);
  assert.ok(it && it.u.web && !it.u.self, "their line, not Pepe's: " + JSON.stringify(v.feed));
  assert.equal(it.u.login, "u:u4acct0001", "keyed by their account (they have no chat login)");
  assert.equal(it.u.display, "Acct P", "their PATV name, resolved by the account id");
  assert.equal(v.mine.find((x) => x.cid === cid).c, it.c);
});

test("H7: no sender ref, words in `web` or only in Pepe's posted line -> their line (Pepe's redacted words, never the job's text)", async () => {
  // a newer bot: the words + job, no user
  const s1 = await say("u1", "words only", "cWORDS0001");
  relay.takeJobs(new Set([ROOM.id]), "pull");
  let before = (await live("u1")).cursor;
  await sync({ rooms: [], events: [ev(Object.assign(pepeLine("🌐 Alice (web): words only"), { web: { text: "words only", job: s1.d.id } }))] });
  let v = await live("u1", "?after=" + before);
  let it = v.feed.find((x) => x.text === "words only");
  assert.ok(it && it.u.login === "alicecf" && it.u.web && !it.u.self, "their line by the job: " + JSON.stringify(v.feed));
  assert.equal(v.mine.find((x) => x.cid === "cWORDS0001").c, it.c);
  // no words in `web` either: the words come from Pepe's own posted line - redacted by Pepe ("someone" for an opted-out name),
  // which the job's stored text is not
  const s2 = await say("u1", "hi secretguy", "cLOSTW0001");
  relay.takeJobs(new Set([ROOM.id]), "pull");
  before = (await live("u1")).cursor;
  await sync({ rooms: [], events: [ev(Object.assign(pepeLine("🌐 Alice (web): hi someone"), { web: { job: s2.d.id } }))] });
  v = await live("u1", "?after=" + before);
  it = v.feed.find((x) => x.k === "msg" && /hi s/.test(x.text));
  assert.ok(it && it.u.login === "alicecf" && !it.u.self, "their line: " + JSON.stringify(v.feed));
  assert.equal(it.text, "hi someone", "Pepe's redacted words, never the job's text");
  assert.ok(!R().feed.some((x) => /secretguy/.test(JSON.stringify(x))), "the opted-out name never reaches the chat");
  assert.equal(v.mine.find((x) => x.cid === "cLOSTW0001").c, it.c);
});

test("H7: no usable sender ref and no words anywhere, job known -> Pepe's line, but it still settles the sender's pending line", async () => {
  const text = "odd post", cid = "cODDPO0001";
  const s = await say("u1", text, cid);
  relay.takeJobs(new Set([ROOM.id]), "pull");
  const before = (await live("u1")).cursor;
  await sync({ rooms: [], events: [ev(Object.assign(pepeLine("Alice from the web says " + text), { web: { job: s.d.id } }))] });
  const v = await live("u1", "?after=" + before);
  const it = v.feed.find((x) => x.text === "Alice from the web says " + text);
  assert.ok(it && it.u.self, "Pepe's posted line: " + JSON.stringify(v.feed));
  const m = v.mine.find((x) => x.cid === cid);
  assert.equal(m.c, it.c, "the sender's pending line is swapped for it (never shown twice, never left hanging)");
  assert.equal(it.cid, cid);
});

// ── H12 (site side) ──
test("H12: an echo of a line Pepe acked as never sent (send_failed) isn't shown, and the job stays failed", async () => {
  const text = "never went out", cid = "cFAILD0001";
  const s = await say("u1", text, cid);
  relay.takeJobs(new Set([ROOM.id]), "pull");
  const before = (await live("u1")).cursor;
  await sync({ rooms: [], acks: [{ id: s.d.id, ok: false, msg: "Pepe couldn't send it into the room", code: "send_failed" }], events: [echo(s.d.id, text)] });
  const v = await live("u1", "?after=" + before);
  assert.ok(!v.feed.some((x) => x.text === text), "not in the chat: " + JSON.stringify(v.feed));
  const m = v.mine.find((x) => x.cid === cid);
  assert.equal(m.ok, false);
  assert.equal(m.code, "send_failed");
  assert.equal(m.c, undefined);
  assert.equal(relay.noteEcho(s.d.id, 999999, ROOM.id), false, "noteEcho never overrides Pepe's send_failed");
  // a site timeout (unconfirmed) is still settled by the echo: it proves the line reached the room
  const s2 = await say("u1", "late echo", "cFAILD0002");
  relay.takeJobs(new Set([ROOM.id]), "pull");
  relay._sweep(Date.now() + relay.SAY_CLAIM_TTL + 1000);
  assert.equal(relay._jobs.get(s2.d.id).result.code, "unconfirmed");
  await sync({ rooms: [], events: [echo(s2.d.id, "late echo")] });
  assert.equal(relay._jobs.get(s2.d.id).result.ok, true);
  assert.ok(relay._jobs.get(s2.d.id).echoC > 0);
});

test("an echo from ANOTHER room never settles the job", async () => {
  const text = "wrong room", cid = "cWRONG0001";
  const s = await say("u1", text, cid);
  relay.takeJobs(new Set([ROOM.id]), "pull");
  await sync({ rooms: [], events: [echo(s.d.id, text, undefined, OTHER)] });
  const m = (await live("u1")).mine.find((x) => x.cid === cid);
  assert.equal(m.c, undefined, "not swapped for a line that isn't in this pad's chat");
  assert.ok(bridge._rooms.get(OTHER.id).feed.some((x) => x.text === text), "the line itself is in the other room's chat");
});

// ── client: a tiny DOM ──
class Cls {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
}
class Txt { constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.classList = new Cls(); this.parentNode = null;
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0; }
  set className(v) { this.classList = new Cls(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return [...this.classList.s].join(" "); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; if (v != null && v !== "") this.appendChild(new Txt(v)); }
  set id(v) { this.attrs.id = String(v); }
  get id() { return this.attrs.id || ""; }
  _detach(c) { if (c.parentNode) c.parentNode.removeChild(c); }
  appendChild(c) {
    if (c.tagName === "#FRAG") { c.children.slice().forEach((k) => this.appendChild(k)); return c; }
    this._detach(c); c.parentNode = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    if (c.tagName === "#FRAG") { c.children.slice().forEach((k) => this.insertBefore(k, ref)); return c; }
    this._detach(c); const i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  focus() {}
  _match(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(sel);
    if (!m) throw new Error("selector not supported: " + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].split(".").filter(Boolean)) if (!this.classList.contains(c)) return false;
    if (m[3]) { if (!(m[3] in this.attrs)) return false; if (m[4] != null && this.attrs[m[3]] !== m[4]) return false; }
    return true;
  }
  querySelector(sel) {
    for (const c of this.children) { if (c.nodeType !== 1) continue; if (c._match(sel)) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
}
function context(fetchFn, ids = {}) {
  const doc = { hidden: false, createElement: (t) => new El(t), createTextNode: (t) => new Txt(t), createDocumentFragment: () => new El("#frag"),
                getElementById: (id) => ids[id] || null, addEventListener() {} };
  const ctx = {
    console, document: doc, navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {} }, crypto: require("crypto").webcrypto,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: fetchFn, Date, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array, Error, encodeURIComponent, addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  return { ctx, doc };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── H3: the pad's relay outbox ──
function outboxPage() {
  let n = 0;
  const posted = [];
  const { ctx } = context(async (url, o) => {
    const b = JSON.parse(o.body);
    posted.push(b);
    return { status: 200, json: async () => ({ ok: true, id: "w" + String(++n).padStart(16, "0"), cid: b.cid }) };
  });
  const feed = new El("div"), host = new El("div");
  const mk = (it) => { const r = new El("div"); r.className = "line"; if (it.c) r.setAttribute("data-c", it.c); r.textContent = it.text; return r; };
  const rel = ctx.PATVRoom.relay(host, "pad", { feed, line: mk });
  const pend = () => rel.pending();
  const shown = () => feed.children.filter((c) => c.getAttribute("data-cid") != null);
  return { rel, feed, pend, shown, posted };
}
const job = (it, extra) => Object.assign({ kind: "say", id: it.id, cid: it.cid, state: "done", ok: true, msg: "sent", at: 1 }, extra);

test("H3: an answer naming your line's room cursor without carrying the line keeps your line (sent) and asks for it once", async () => {
  const P = outboxPage();
  P.rel._send("qqq");
  await tick(); await tick();
  const it = P.pend()[0];
  assert.ok(it && it.id, "posted: " + JSON.stringify(P.posted));
  // the prod qqq answer: mine c = 422072 = the cursor, no line in the feed
  P.rel.update({ room: { relay: true }, mine: [job(it, { c: 422072 })], cursor: 422072, feed: [] });
  assert.equal(P.pend().length, 1, "never dropped on the cursor's word alone");
  assert.equal(P.shown().length, 1, "your line stays on screen");
  assert.equal(P.pend()[0].st, "sent");
  assert.equal(P.rel.refetch(), 422072, "the page is asked to fetch from just before it");
  assert.equal(P.rel.refetch(), 0, "once");
  P.rel.update({ room: { relay: true }, mine: [job(it, { c: 422072 })], cursor: 422080, feed: [] });
  assert.equal(P.rel.refetch(), 0, "asked once per line");
  // the refetch brings the room line (tagged with your job + client id): swapped
  P.rel.update({ room: { relay: true }, mine: [job(it, { c: 422072 })], cursor: 422080,
                 feed: [{ c: 422072, k: "msg", u: { login: "alicecf", web: true }, text: "qqq", job: it.id, cid: it.cid }] });
  assert.equal(P.pend().length, 0, "swapped for the room line");
  assert.equal(P.shown().length, 0);
});

test("H3: swapped exactly when the room line arrives - by its job tag, or by a cursor the page was given", async () => {
  const P = outboxPage();
  P.rel._send("one"); P.rel._send("two");
  for (let i = 0; i < 6; i++) await tick();
  const [a, b] = P.pend();
  assert.ok(a.id && b.id, JSON.stringify(P.pend().map((x) => x.st)));
  // ack only: sent, still shown
  P.rel.update({ room: { relay: true }, mine: [job(a), job(b)], cursor: 10, feed: [] });
  assert.equal(P.shown().length, 2);
  // a's room line, tagged by its job (no c in mine yet - e.g. an older answer shape): swapped
  P.rel.update({ room: { relay: true }, mine: [job(a), job(b)], cursor: 11, feed: [{ c: 11, k: "msg", text: "one", job: a.id }] });
  assert.deepEqual([...P.pend().map((x) => x.text)], ["two"]);
  // b's line came in an earlier answer (c 12 seen), mine names it later: swapped
  P.rel.update({ room: { relay: true }, mine: [job(a), job(b)], cursor: 12, feed: [{ c: 12, k: "msg", text: "two" }] });
  P.rel.update({ room: { relay: true }, mine: [job(a, { c: 11 }), job(b, { c: 12 })], cursor: 12, feed: [] });
  assert.equal(P.pend().length, 0);
  assert.equal(P.rel.refetch(), 0, "nothing missing");
  // a refusal keeps the line, red, with the reason
  P.rel._send("three");
  for (let i = 0; i < 4; i++) await tick();
  const c = P.pend()[0];
  P.rel.update({ room: { relay: true }, mine: [job(c, { ok: false, msg: "blocked here", code: "blocked" })], cursor: 12, feed: [] });
  assert.equal(P.pend()[0].st, "failed");
  assert.equal(P.shown().length, 1);
});

test("the pad page dedupes by cursor, fetches a missed line from just before it, and resets before compose", () => {
  const ejs = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(ejs, /items = \(items \|\| \[\]\)\.filter\(function \(it\) \{ return !it\.c \|\| !haveC\[it\.c\]; \}\);/, "addFeed shows a line once");
  assert.match(ejs, /var miss = roomRelay && roomRelay\.refetch \? roomRelay\.refetch\(\) : 0;\s*\n\s*if \(miss && miss <= cursor\) cursor = miss - 1;/);
  const a = ejs.indexOf("roomRelay.reset()"), b = ejs.indexOf("safe('compose', function () { renderCompose(d); });");
  assert.ok(a > 0 && b > a, "a site restart resets the outbox's view before compose reads the answer");
});

// ── H5: the homepage widget, real code ──
function homeWidget(initView, filter) {
  const ids = {};
  for (const id of ["lrFeed", "lrAudioBox", "lrRelay", "lrTopic", "lrCount", "lrLive", "lrLiveTxt", "lrMic", "lrPeople", "lrInit"]) ids[id] = new El("div");
  ids.lrInit.textContent = JSON.stringify(initView);
  const { ctx, doc } = context((u, o) => fetch(base + u, Object.assign({}, o, { headers: Object.assign({}, (o && o.headers) || {}, { "x-test-user": "u1" }) }))
    .then(async (r) => {
      if (!/\/live/.test(u) || !filter) return r;
      const d = filter(await r.json(), u);
      return { ok: r.ok, status: r.status, json: async () => d };
    }), ids);
  ctx.PATVRoom.audio = () => ({ update() {} });
  const home = fs.readFileSync(path.join(repo, "views", "home.ejs"), "utf8");
  const start = home.indexOf("  // The live room widget: chat + mic transcripts");
  const end = home.indexOf("timer = setTimeout(poll, 300);", start);
  assert.ok(start > 0 && end > start, "home.ejs widget found");
  let js = home.slice(start, end) + "window.__home = { relay: roomRelay, feed: feed, cur: function () { return cursor; } };\n  timer = setTimeout(poll, 50);\n  })();";
  js = js.replace(/<%- JSON\.stringify\(room\.slug\)[^%]*%>/, JSON.stringify(SLUG));
  assert.ok(!js.includes("<%"), "no EJS left");
  vm.runInContext(js, ctx);
  return { doc, W: ctx.__home };
}
async function homeRound(tag, mode, filter) {
  const text = "home " + tag;
  const { doc, W } = homeWidget(await bridge.liveFor(SLUG), filter);
  try {
    await sleep(300);
    await sync({ rooms: [], events: [chat("bobcf", "hi from bob " + tag)] });   // the widget's steady state (v + mv on its polls)
    await sleep(300);
    W.relay._send(text);
    let id = null;
    for (let i = 0; i < 50 && !id; i++) { await sleep(20); const p = W.relay.pending().find((x) => x.text === text); id = p && p.id; }
    assert.ok(id, "the say was taken");
    relay.takeJobs(new Set([ROOM.id]), "pull");
    await sleep(300);                                                             // the widget re-parks its long-poll
    if (mode === "same") await sync({ rooms: [], acks: [{ id, ok: true, msg: "sent" }], events: [echo(id, text)] });
    else if (mode === "burst") {                // 1.99acb: your line is the oldest of 101 new lines in one answer
      const fill = [];
      for (let i = 0; i < 100; i++) fill.push(chat("bobcf", "burst filler " + i));
      await sync({ rooms: [], acks: [{ id, ok: true, msg: "sent" }], events: [echo(id, text), ...fill] });
    } else { await bot("/api/bridge/relay/ack", { acks: [{ id, ok: true, msg: "sent" }] }); await sync({ rooms: [], events: [echo(id, text)] }); }
    await sleep(900);
    const rows = W.feed.children.filter((c) => c.nodeType === 1 && c.textContent.includes(text));
    return { real: rows.filter((c) => c.getAttribute("data-cid") == null).length, pending: rows.filter((c) => c.getAttribute("data-cid") != null).length,
             outbox: W.relay.pending().length };
  } finally {
    doc.hidden = true;
    await sync({ rooms: [snap()] });                                              // wakes the parked poll; hidden = no new one
    await sleep(100);
  }
}

test("H5: the homepage widget - ack + echo in one sync, and separately: the line shows exactly once", async () => {
  for (const mode of ["same", "same", "sepr"]) {
    const r = await homeRound(mode + Math.random().toString(36).slice(2, 6), mode);
    assert.deepEqual(r, { real: 1, pending: 0, outbox: 0 }, mode);
  }
});

test("H5: one answer of 80+ new lines with yours the oldest - the widget draws yours and shows it once", async () => {
  // it drew only the newest 80 but told the outbox about every line: your pending line was dropped for a line never drawn
  const r = await homeRound("burst" + Math.random().toString(36).slice(2, 6), "burst");
  assert.deepEqual(r, { real: 1, pending: 0, outbox: 0 });
});

test("H3 + H5: an answer that names the line but leaves it out (an older / inconsistent site) - the widget fetches it, shows it once", async () => {
  let cut = 0;
  const r = await homeRound("cut" + Math.random().toString(36).slice(2, 6), "same", (d) => {
    // drop the echoed line from the first answer that carries it (keep its cursor and mine c - the old race's shape)
    if (!cut && (d.feed || []).some((x) => x.job)) { cut = 1; d.feed = d.feed.filter((x) => !x.job); }
    return d;
  });
  assert.equal(cut, 1, "the inconsistent answer was served");
  assert.deepEqual(r, { real: 1, pending: 0, outbox: 0 });
});
