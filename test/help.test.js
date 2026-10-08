// Offline tests for 1.99fq: Pepe's command help at /help (help.js, public/js/helpsearch.js, views/help.ejs).
//   * the help data: the bundled copy validates; validateData refuses broken data; Pepe's sync (bot token) replaces the
//     bundled copy; the pull reports the stored hash (null before a sync, so Pepe publishes)
//   * the search ranking: everyday questions find the right cards; exact commands and aliases win
//   * the prompter: signed out -> search only (nothing queued); AI off / Pepe offline -> search; Pepe's answer over the
//     real bot API (pull / answer) -> source "pepe"; an invented command or no answer in time -> the search results
//   * the rate limits: per-user burst + day, per-IP across accounts; misses logged for admins; admin page admins only
//   * the page: cards with deep-link ids, copy buttons, the ask box, /commands -> /help, safe markdown; nav links
//   NODE_PATH=G:/PATV/node_modules node --test test/help.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "help-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const HELP = require(path.join(repo, "help"));
const HS = require(path.join(repo, "public", "js", "helpsearch"));
const BUNDLED = JSON.parse(fs.readFileSync(path.join(repo, "data", "help-commands.json"), "utf8"));

const users = new Map();
let server, base;
async function mkUser(name, cls = "pleb") {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 1000, 5, '2026-01-01 00:00:00')`, [id, name, name, cls]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
let IP = "10.0.0.1";
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  HELP.register(app, { addUser, isBotToken: (t) => t === "bot", clientIp: () => IP });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); HELP._reset(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u.userId } : {});
async function req(method, url, body, u) {
  const r = await fetch(base + url, { method, redirect: "manual", headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* html */ }
  return { status: r.status, json: j, text: t, headers: r.headers };
}
const top = (q, n = 3) => HS.rank(BUNDLED.entries, q, { limit: n }).map((r) => r.entry.id);

// ── the data ──
test("the bundled help data validates and has the 10 categories", () => {
  assert.equal(HELP.validateData(BUNDLED), null);
  assert.deepEqual(BUNDLED.categories.map((c) => c.id), ["start", "chat", "games", "wallet", "markets", "heists", "stage", "music", "moderation", "admin"]);
  assert.ok(BUNDLED.entries.length > 200);
  const ids = new Set(BUNDLED.entries.map((e) => e.id));
  assert.equal(ids.size, BUNDLED.entries.length, "ids unique");
  for (const id of ["spin", "tip", "market", "wager", "snap", "clip", "queue", "kick", "verify", "commands", "boost"]) assert.ok(ids.has(id), id);
  const spin = BUNDLED.entries.find((e) => e.id === "spin");
  assert.equal(spin.cost, 5000);
  assert.ok(spin.syntax[0].startsWith("!spin"));
});

test("validateData refuses broken data", () => {
  const bad = (f) => { const d = JSON.parse(JSON.stringify(BUNDLED)); f(d); return HELP.validateData(d); };
  assert.match(bad((d) => { d.schema = 2; }), /schema/);
  assert.match(bad((d) => { d.entries[0].category = "nope"; }), /category/);
  assert.match(bad((d) => { d.entries[1].id = d.entries[0].id; }), /duplicate/);
  assert.match(bad((d) => { d.entries[0].role = "god"; }), /role/);
  assert.match(bad((d) => { d.entries[0].commands = ["spin"]; }), /commands/);
  assert.match(bad((d) => { d.entries[0].web = { label: "x", url: "javascript:alert(1)" }; }), /web/);
  assert.match(bad((d) => { d.entries[0].web = { label: "x", url: "//evil.example" }; }), /web/);
  assert.match(bad((d) => { d.entries[0].cost = -5; }), /cost/);
  assert.equal(HELP.validateData(null), "not an object");
});

test("sync: bot token only, refuses bad data, then the page and pull use Pepe's copy", async () => {
  let r = await req("POST", "/api/pepe/help/pull", { password: "bot", wait: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.hash, null, "nothing synced yet -> null, so Pepe publishes");
  r = await req("POST", "/api/pepe/help/sync", { password: "nope", hash: "h1", data: BUNDLED });
  assert.equal(r.status, 403);
  r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h1", data: { schema: 1, entries: [] } });
  assert.equal(r.status, 400);
  const mine = JSON.parse(JSON.stringify(BUNDLED));
  mine.entries.find((e) => e.id === "spin").cost = 7500;          // a live admin-panel price
  r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h2", version: "1.99zz", data: mine });
  assert.equal(r.status, 200);
  assert.equal(r.json.hash, "h2");
  const cur = await HELP.current();
  assert.equal(cur.source, "pepe");
  assert.equal(cur.version, "1.99zz");
  assert.equal(cur.data.entries.find((e) => e.id === "spin").cost, 7500);
  r = await req("POST", "/api/pepe/help/pull", { password: "bot", wait: 0 });
  assert.equal(r.json.hash, "h2");
  const row = (await getQuery("SELECT v FROM help_kv WHERE k = 'data'"))[0];
  assert.ok(row && JSON.parse(row.v).hash === "h2", "stored in the DB");
});

// ── ranking ──
test("search ranking: everyday questions find the right cards", () => {
  assert.equal(top("how do I bet on a market")[0], "market");
  assert.ok(top("bet my friend 500 it rains", 4).includes("wager"));
  assert.equal(top("tip someone")[0], "tip");
  assert.equal(top("!spin")[0], "spin");
  assert.equal(top("spin")[0], "spin");
  assert.equal(top("nowplaying")[0], "np", "an alias finds its card");
  assert.ok(top("how do i play a song").includes("queue") || top("how do i play a song").includes("play"));
  assert.ok(top("save someones cam").includes("snap"));
  assert.equal(top("how do i link my camfrog account")[0], "verify");
  assert.ok(top("rob a bank").includes("heist-2"));
  assert.ok(top("how do i get money").includes("earning-pat"));
  assert.deepEqual(top("the of and"), [], "stop words only -> nothing");
  assert.deepEqual(top(""), []);
});

test("the page filter needs every word (or a synonym)", () => {
  assert.equal(HS.matches("!spin Spin the Wheel of Misfortune 5,000 PAT", "spin wheel"), true);
  assert.equal(HS.matches("!spin Spin the Wheel of Misfortune", "spin poker"), false);
  assert.equal(HS.matches("!holdem Texas hold'em", "poker"), true, "synonym");
  assert.equal(HS.matches("anything", ""), true);
});

test("cleanAnswer keeps only candidate ids and refuses invented commands", () => {
  const cards = BUNDLED.entries.filter((e) => ["market", "wager"].includes(e.id));
  assert.deepEqual(HELP.cleanAnswer({ text: "Use !market new ...", ids: ["market", "kick", "market"] }, cards), { text: "Use !market new ...", ids: ["market"] });
  assert.equal(HELP.cleanAnswer({ text: "Type !moneyprinter", ids: ["market"] }, cards), null);
  assert.ok(HELP.cleanAnswer({ text: "Use !markets", ids: [] }, cards), "an alias is fine");
  assert.equal(HELP.cleanAnswer({ text: "", ids: [] }, cards), null);
  assert.equal(HELP.cleanAnswer(null, cards), null);
});

test("markdown is safe: escaped HTML, only /path and https links", () => {
  assert.equal(HELP.md("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  assert.equal(HELP.md("`<b>` **bold**"), "<code>&lt;b&gt;</code> <b>bold</b>");
  assert.equal(HELP.md("[a](/shop) [b](javascript:alert) [c](https://x.example/y)"),
    '<a href="/shop">a</a> b <a href="https://x.example/y" rel="noopener">c</a>');
  assert.equal(HELP.md("one\ntwo"), "one<br>two");
});

// ── the prompter ──
// a fake Pepe over the real bot API: long-polls, answers with `reply(job)` (null = never answers)
function fakePepe(reply) {
  let stop = false;
  const seen = [];
  // stop() waits for the loop to end, so a stopped Pepe can never claim the next test's question
  const done = (async () => {
    while (!stop) {
      const r = await req("POST", "/api/pepe/help/pull", { password: "bot", wait: 0.2 });
      if (stop) break;
      for (const j of (r.json && r.json.jobs) || []) {
        seen.push(j);
        const a = reply(j);
        if (a) await req("POST", "/api/pepe/help/answer", Object.assign({ password: "bot", id: j.id, model: "cheap", cost: 0.0001 }, a));
      }
      if (!r.json || !r.json.enabled) await new Promise((res) => setTimeout(res, 50));
    }
  })();
  return { seen, stop() { stop = true; return done; } };
}

test("prompter: signed out -> search results only, nothing queued for Pepe", async () => {
  const p = fakePepe(() => ({ answer: { text: "x", ids: [] } }));
  await new Promise((r) => setTimeout(r, 100));
  const r = await req("POST", "/api/help/ask", { q: "how do I bet on a market" });
  await p.stop();
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "search");
  assert.equal(r.json.note, "signin");
  assert.equal(r.json.answer, null);
  assert.equal(r.json.results[0].id, "market");
  assert.equal(p.seen.length, 0, "no model call for a signed-out visitor");
});

test("prompter: bad input -> 400; cross-site -> 403", async () => {
  const u = await mkUser("asker0");
  assert.equal((await req("POST", "/api/help/ask", { q: "x" }, u)).status, 400);
  assert.equal((await req("POST", "/api/help/ask", { q: "y".repeat(201) }, u)).status, 400);
  const r = await fetch(base + "/api/help/ask", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ q: "spin" }) });
  assert.equal(r.status, 403);
});

test("prompter: Pepe offline -> the search results, note pepe-offline", async () => {
  HELP._reset();
  const u = await mkUser("asker1");
  const r = await req("POST", "/api/help/ask", { q: "tip someone" }, u);
  assert.equal(r.json.source, "search");
  assert.equal(r.json.note, "pepe-offline");
  assert.equal(r.json.results[0].id, "tip");
});

test("prompter: Pepe answers from the candidates -> source pepe, cards attached", async () => {
  HELP._reset();
  const u = await mkUser("asker2");
  const p = fakePepe((j) => {
    assert.ok(j.candidates.length > 0 && j.candidates.length <= 15);
    assert.ok(j.candidates.some((c) => c.id === "market"), "the best card is a candidate");
    assert.equal(j.q, "how do I bet on a market");
    return { answer: { text: "Use !market new [question] judge @someone, then buy shares.", ids: ["market", "not-a-card"] } };
  });
  await new Promise((r) => setTimeout(r, 120));
  const r = await req("POST", "/api/help/ask", { q: "how do I bet on a market" }, u);
  await p.stop();
  assert.equal(r.json.source, "pepe", JSON.stringify(r.json.note));
  assert.deepEqual(r.json.answer.ids, ["market"]);
  assert.match(r.json.answer.text, /!market new/);
  assert.equal(r.json.answer.cards[0].id, "market");
  assert.equal(p.seen.length, 1);
});

test("prompter: an invented command or a Pepe error -> the search results", async () => {
  HELP._reset();
  const u = await mkUser("asker3");
  const p = fakePepe((j) => j.q.includes("free") ? { answer: { text: "Type !moneyprinter", ids: ["beg"] } } : { error: "the model gave nothing" });
  await new Promise((r) => setTimeout(r, 120));
  let r = await req("POST", "/api/help/ask", { q: "free pat please" }, u);
  assert.equal(r.json.source, "search");
  assert.equal(r.json.note, "pepe-error");
  assert.equal(r.json.answer, null);
  assert.ok(r.json.results.length > 0);
  r = await req("POST", "/api/help/ask", { q: "how do I spin" }, u);
  await p.stop();
  assert.equal(r.json.note, "pepe-error");
});

test("prompter: Pepe too slow -> the search results (pepe-slow)", async () => {
  HELP._reset();
  HELP._setWait(300);
  const u = await mkUser("asker4");
  const p = fakePepe(() => null);            // takes the job, never answers
  await new Promise((r) => setTimeout(r, 120));
  const r = await req("POST", "/api/help/ask", { q: "how do I spin the wheel" }, u);
  await p.stop();
  HELP._setWait(12e3);
  assert.equal(r.json.source, "search");
  assert.equal(r.json.note, "pepe-slow");
  assert.equal(r.json.results[0].id, "spin");
});

test("prompter: AI answers switched off -> search only, Pepe's pull says disabled", async () => {
  HELP._reset();
  await HELP.setConfig({ ai: false });
  const u = await mkUser("asker5");
  const pr = await req("POST", "/api/pepe/help/pull", { password: "bot", wait: 0 });
  assert.equal(pr.json.enabled, false);
  assert.equal(pr.json.idle, 60);
  const r = await req("POST", "/api/help/ask", { q: "tip someone" }, u);
  assert.equal(r.json.note, "ai-off");
  await HELP.setConfig({ ai: true });
});

// ── rate limits ──
test("rate limits: per-user burst, per-IP across accounts", async () => {
  HELP._reset();
  const u = await mkUser("spammer");
  const p = fakePepe(() => ({ answer: { text: "Use !tip.", ids: ["tip"] } }));
  await new Promise((r) => setTimeout(r, 120));
  IP = "10.0.0.9";
  const notes = [];
  for (let i = 0; i < HELP.LIMITS.USER_BURST + 1; i++) notes.push((await req("POST", "/api/help/ask", { q: "tip someone " + i }, u)).json.note || "ok");
  assert.deepEqual(notes.slice(0, HELP.LIMITS.USER_BURST), Array(HELP.LIMITS.USER_BURST).fill("ok"));
  assert.equal(notes[HELP.LIMITS.USER_BURST], "limit-burst");
  const last = await req("POST", "/api/help/ask", { q: "tip someone" }, u);
  assert.ok(last.json.results.length > 0, "over the limit still gets the search results");
  // the IP limit: many accounts behind one address
  IP = "10.0.0.10";
  let ipNote = null;
  for (let i = 0; i < HELP.LIMITS.IP_HOUR + 1 && !ipNote; i++) {
    const v = await mkUser("sock" + i);
    const r = await req("POST", "/api/help/ask", { q: "tip someone" }, v);
    if (r.json.note === "limit-ip") ipNote = i;
  }
  await p.stop();
  assert.equal(ipNote, HELP.LIMITS.IP_HOUR, "the IP is cut off after IP_HOUR questions");
  IP = "10.0.0.1";
});

test("rate limits: per-user day cap", async () => {
  HELP._reset();
  let t = Date.parse("2026-10-08T00:00:00Z");
  HELP._setClock(() => t);
  const u = await mkUser("daily");
  const p = fakePepe(() => ({ answer: { text: "Use !tip.", ids: ["tip"] } }));
  await new Promise((r) => setTimeout(r, 120));
  let n = 0, note = null;
  for (let i = 0; i < 200 && !note; i++) {
    IP = "10.1.0." + i;                       // different networks: only the user limits apply
    const r = await req("POST", "/api/help/ask", { q: "tip someone" }, u);
    if (r.json.note && r.json.note.startsWith("limit")) {
      if (r.json.note === "limit-day") note = r.json.note;
      else { t += 11 * 60e3; await new Promise((res) => setTimeout(res, 300)); }   // wait out the burst window (Pepe pulls again)
    } else n++;
  }
  await p.stop();
  HELP._setClock(() => Date.now());
  IP = "10.0.0.1";
  assert.equal(note, "limit-day");
  assert.equal(n, HELP.LIMITS.USER_DAY);
});

// ── misses + admin ──
test("misses: weak questions are logged for admins (no IPs); the admin page is admins only", async () => {
  HELP._reset();
  await runQuery("DELETE FROM help_misses");
  await req("POST", "/api/help/ask", { q: "can pepe file my taxes" });
  const rows = await HELP.misses();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].q, "can pepe file my taxes");
  assert.equal(rows[0].why, "signed-out");
  const cols = (await getQuery("PRAGMA table_info(help_misses)")).map((c) => c.name);
  assert.ok(!cols.some((c) => /ip/i.test(c)), "no IP column");
  await req("POST", "/api/help/ask", { q: "how do I bet on a market" });
  assert.equal((await HELP.misses()).length, 1, "a good match isn't a miss");

  const member = await mkUser("member1");
  const admin = await mkUser("boss", "Admin");
  assert.equal((await req("GET", "/admin/help", undefined, member)).status, 403);
  assert.equal((await req("GET", "/admin/help")).status, 302);
  const page = await req("GET", "/admin/help", undefined, admin);
  assert.equal(page.status, 200);
  assert.match(page.text, /can pepe file my taxes/);
  assert.equal((await req("POST", "/admin/help/config", { ai: false }, member)).status, 403);
  const c = await req("POST", "/admin/help/config", { ai: false }, admin);
  assert.equal(c.json.config.ai, false);
  await req("POST", "/admin/help/config", { ai: true }, admin);
  const id = rows[0].id;
  assert.equal((await req("POST", `/admin/help/misses/${id}/resolve`, {}, admin)).json.ok, true);
  assert.equal((await HELP.misses()).length, 0);
});

// ── the page ──
test("GET /help renders every card with deep-link ids, copy buttons and the ask box; /commands redirects", async () => {
  const r = await req("GET", "/help");
  assert.equal(r.status, 200);
  const cur = await HELP.current();
  for (const e of cur.data.entries) assert.ok(r.text.includes(`id="cmd-${e.id}"`), e.id);
  assert.match(r.text, /id="askForm"/);
  assert.match(r.text, /class="cp" data-copy="!spin"/);
  assert.match(r.text, /id="cat-markets"/);
  assert.match(r.text, /7,500 PAT/, "the live price Pepe published");
  assert.match(r.text, /Pepe 1\.99zz/);
  assert.doesNotMatch(r.text, /<script>alert/);
  const idx = /<script type="application\/json" id="helpIdx">([\s\S]*?)<\/script>/.exec(r.text);
  assert.ok(idx, "search index embedded");
  const list = JSON.parse(idx[1]);
  assert.equal(list.length, cur.data.entries.length);
  assert.ok(!idx[1].includes("</"), "no </ inside the inline JSON");
  const q = await req("GET", "/help?q=" + encodeURIComponent('"><script>'));
  assert.ok(!q.text.includes('"><script>'), "?q= is escaped");
  const red = await req("GET", "/commands?q=spin");
  assert.equal(red.status, 301);
  assert.equal(red.headers.get("location"), "/help?q=spin");
});

test("the page has no horizontal overflow rules missing (mobile) and its scripts parse", () => {
  const src = fs.readFileSync(path.join(repo, "views", "help.ejs"), "utf8");
  assert.match(src, /overflow-wrap: anywhere/);
  assert.match(src, /minmax\(min\(100%, 320px\), 1fr\)/, "cards collapse to one column on phones");
  assert.match(src, /@media \(max-width: 520px\)/);
  for (const f of ["help-page.js", "helpsearch.js"]) new Function(fs.readFileSync(path.join(repo, "public", "js", f), "utf8"));
});

test("navbar + footer + guides point at /help, not Netlify", () => {
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  assert.match(layout, /\['\/help', '<img src="\/public\/img\/pepe.png" height="16" alt="">', 'PepeFrog commands'\]/);
  assert.match(layout, /<a href="\/help">Pepe's commands<\/a>/);
  assert.doesNotMatch(layout, /pepe\.publicaccess\.tv"/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views", "economy.ejs"), "utf8"), /pepe\.publicaccess\.tv\/help/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views", "about.ejs"), "utf8"), /href="https:\/\/pepe\.publicaccess\.tv"/);
});
