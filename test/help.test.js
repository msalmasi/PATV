// Offline tests for 1.99fq: Pepe's command help at /help (help.js, public/js/helpsearch.js, views/help.ejs).
//   * the help data: the bundled copy validates; validateData refuses broken data; Pepe's sync (bot token) replaces the
//     bundled copy; the pull reports the stored hash (null before a sync, so Pepe publishes)
//   * the search ranking: everyday questions find the right cards; exact commands and aliases win
//   * the prompter: signed out -> search only (nothing queued); AI off / Pepe offline -> search; Pepe's answer over the
//     real bot API (pull / answer) -> source "pepe"; an invented command or no answer in time -> the search results
//   * the rate limits: per-user burst + day, per-IP across accounts; misses logged for admins; admin page admins only
//   * the page: cards with deep-link ids, copy buttons, the ask box, /commands -> /help, safe markdown; nav links
//   * 1.99afi: a card over the limits is clipped (summary / details) or left out, not the whole sync refused (counted in
//     the answer, logged, on /admin/help); the shape, the bot token and the body size stay strict
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

// ── 1.99afi: cards over the limits (10-27: one 6,300-character !econ card refused prod's whole sync, every 2 min) ──
const copyData = () => JSON.parse(JSON.stringify(BUNDLED));
const isHighSurrogate = (s) => { const c = s.charCodeAt(s.length - 1); return c >= 0xd800 && c <= 0xdbff; };

test("the limits: the bot's build mirrors them (tools/build_help.py SITE_LIMITS)", () => {
  assert.equal(HELP.HELP_LIMITS.details, 6000);
  assert.equal(HELP.HELP_LIMITS.summary, 400);
  assert.equal(HELP.HELP_LIMITS.title, 200);
  assert.equal(HELP.SYNC_BODY_MAX, "3mb");
  // the private Pepe repo nested in a dev checkout (not on CI; an older checkout without SITE_LIMITS is skipped)
  const bot = path.join(repo, "camfrog-bot", "tools", "build_help.py");
  const src = fs.existsSync(bot) ? fs.readFileSync(bot, "utf8") : "";
  if (src.includes("SITE_LIMITS = {")) {
    for (const [k, v] of [["title", 200], ["summary", 400], ["details", 6000], ["syntax", 12], ["syntax_line", 200], ["examples", 12],
      ["example", 300], ["keywords", 30], ["keyword", 80], ["commands", 20], ["gates", 10], ["gate", 60], ["web_label", 200]]) {
      assert.match(src, new RegExp(`"${k}": ${v}\\b`), `SITE_LIMITS ${k} = ${v}`);
    }
  }
});

test("validateData (the stored copy's check) still refuses a card over a limit", () => {
  const bad = (f) => { const d = copyData(); f(d); return HELP.validateData(d); };
  assert.match(bad((d) => { d.entries[0].details = "x".repeat(6001); }), /: text$/);
  assert.match(bad((d) => { d.entries[0].summary = "x".repeat(401); }), /: text$/);
  assert.match(bad((d) => { d.entries[0].title = "x".repeat(201); }), /: title$/);
  assert.match(bad((d) => { d.entries[0].syntax = Array(13).fill("!x"); }), /: syntax$/);
  assert.match(bad((d) => { d.entries[0].keywords = ["k".repeat(81)]; }), /examples\/keywords$/);
  assert.match(bad((d) => { d.entries[0].commands = Array(21).fill("!x"); }), /: commands$/);
  assert.equal(bad((d) => { d.entries[0].details = "x".repeat(6000); }), null, "exactly the limit fits");
});

test("normalizeData: a card over a limit is clipped (summary / details) or left out (anything else), the rest kept", () => {
  const d = copyData();
  const [a, b, c, e, f] = d.entries;
  a.details = "word ".repeat(1300);                                   // 6,500
  b.summary = "y".repeat(450);                                         // no space to cut back to
  c.title = "t".repeat(201);
  e.syntax = Array(13).fill("!x");
  f.details = "😀".repeat(3001);                                       // 6,002 UTF-16 units
  const n = HELP.normalizeData(d);
  assert.equal(n.error, null);
  assert.equal(n.clipped, 3);
  assert.equal(n.skipped, 2);
  assert.equal(n.cards, BUNDLED.entries.length - 2);
  assert.equal(HELP.validateData(n.data), null, "what is kept passes the strict check");
  const by = new Map(n.data.entries.map((x) => [x.id, x]));
  assert.ok(!by.has(c.id) && !by.has(e.id), "the cards with another field over are left out");
  const ca = by.get(a.id).details;
  assert.ok(ca.length <= 6000 && ca.endsWith("word…") && ca.startsWith("word word"), "details cut back to a word, with …");
  assert.equal(by.get(b.id).summary, "y".repeat(399) + "…");
  const cf = by.get(f.id).details;
  assert.ok(cf.length <= 6000 && !isHighSurrogate(cf.slice(0, -1)), "never half an emoji");
  assert.deepEqual(n.trimmed.map((t) => [t.id, t.field, t.action]).sort(), [[a.id, "details", "clipped"], [b.id, "summary", "clipped"],
    [c.id, "title", "skipped"], [e.id, "syntax", "skipped"], [f.id, "details", "clipped"]].sort());
  assert.deepEqual(n.trimmed.find((t) => t.id === a.id), { id: a.id, field: "details", len: 6500, max: 6000, action: "clipped" });
  assert.equal(d.entries[0].details.length, 6500, "the input isn't changed");
  assert.equal(HELP.normalizeData(BUNDLED).data, BUNDLED, "data within the limits is kept as it is");
  assert.deepEqual(HELP.normalizeData(BUNDLED).trimmed, []);
});

test("clip: never leaves a `code span open", () => {
  const s = "a ".repeat(2990) + "`!econ fedloan " + "b".repeat(100) + "` tail";
  const c = HELP.clip(s, 6000);
  assert.ok(c.length <= 6000);
  assert.equal((c.match(/`/g) || []).length % 2, 0);
  assert.ok(c.endsWith("a…"));
  assert.equal(HELP.clip("short text here", 6), "short…");
});

test("normalizeData: the shape stays strict - one bad card still refuses it all", () => {
  const bad = (f) => { const d = copyData(); d.entries[0].details = "x".repeat(7000); f(d); return HELP.normalizeData(d); };
  for (const [f, re] of [
    [(d) => { d.entries[5].category = "nope"; }, /category/],
    [(d) => { d.entries[5].id = d.entries[4].id; }, /duplicate/],
    [(d) => { d.entries[5].commands = ["spin"]; }, /commands/],
    [(d) => { d.entries[5].web = { label: "x", url: "javascript:alert(1)" }; }, /web/],
    [(d) => { d.entries[5].details = 5; }, /text/],
    [(d) => { d.entries[5].syntax = []; }, /syntax/],
    [(d) => { d.entries[5].cost = -1; }, /cost/],
    [(d) => { d.schema = 2; }, /schema/],
    [(d) => { d.entries = Array(1501).fill(d.entries[0]); }, /entries/],
    [(d) => { d.undocumented = ["!" + "x".repeat(60)]; }, /undocumented/],
  ]) {
    const n = bad(f);
    assert.match(n.error, re);
    assert.equal(n.data, null);
  }
  const d = { schema: 1, categories: BUNDLED.categories, entries: [{ ...BUNDLED.entries[0], title: "t".repeat(300) }] };
  assert.equal(HELP.normalizeData(d).error, "entries", "nothing left -> refused");
});

test("sync: cards over the limits are clipped or left out, the rest stored - not a 400 for the whole sync", async () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const mine = copyData();
    const long = mine.entries.find((e) => e.id === "spin");
    long.cost = 7500;
    long.details = "Shows each layer's balance. ".repeat(225);        // 6,300 - like Pepe 1.99afd's !econ card
    const skip = mine.entries.find((e) => e.id === "boost");
    skip.syntax = Array(13).fill("!boost");
    let r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h3", version: "1.99zz", data: mine });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.hash, "h3", "Pepe's hash, so he doesn't publish it again every 2 minutes");
    assert.equal(r.json.clipped, 1);
    assert.equal(r.json.skipped, 1);
    assert.equal(r.json.cards, mine.entries.length - 1);
    assert.deepEqual(r.json.trimmed, [{ id: "spin", field: "details", len: 6300, max: 6000, action: "clipped" },
      { id: "boost", field: "syntax", len: 13, max: 12, action: "skipped" }]);
    assert.ok(warns.some((w) => w.includes("[help] sync h3") && w.includes("spin details 6300>6000 clipped") && w.includes("boost syntax 13>12 skipped")),
      "logged: " + warns.join(" | "));
    HELP._reset();                                                    // from the DB, as after a restart
    const cur = await HELP.current();
    assert.equal(cur.hash, "h3");
    assert.equal(cur.data.entries.length, mine.entries.length - 1);
    assert.ok(cur.data.entries.find((e) => e.id === "spin").details.length <= 6000);
    assert.ok(!cur.data.entries.find((e) => e.id === "boost"));
    assert.equal(cur.trimmed.length, 2);
    r = await req("POST", "/api/pepe/help/pull", { password: "bot", wait: 0 });
    assert.equal(r.json.hash, "h3");
    const page = await req("GET", "/help");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('id="cmd-spin"') && !page.text.includes('id="cmd-boost"'));
    const admin = await mkUser("trimboss", "Admin");
    const adm = await req("GET", "/admin/help", undefined, admin);
    assert.equal(adm.status, 200);
    assert.match(adm.text, /Cards over the limits/);
    assert.match(adm.text, /spin \(details 6300 &gt; 6000, clipped\) · boost \(syntax 13 &gt; 12, left out\)/);

    // still strict: the token, the shape, the size
    r = await req("POST", "/api/pepe/help/sync", { password: "nope", hash: "h4", data: mine });
    assert.equal(r.status, 403);
    const shape = copyData();
    shape.entries[3].role = "god";
    r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h4", data: shape });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /^bad help data: entry .+: role$/);
    const huge = copyData();
    huge.padding = "x".repeat(3 * 1024 * 1024);
    r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h4", data: huge });
    assert.equal(r.status, 413, "over the body limit");
    assert.equal((await HELP.current()).hash, "h3", "nothing refused replaced the stored copy");
  } finally {
    console.warn = realWarn;
    // back to the copy the tests below expect (h2: the live 7,500 price, Pepe 1.99zz, every card)
    const mine = copyData();
    mine.entries.find((e) => e.id === "spin").cost = 7500;
    const r = await req("POST", "/api/pepe/help/sync", { password: "bot", hash: "h2", version: "1.99zz", data: mine });
    assert.equal(r.status, 200);
    assert.equal(r.json.clipped + r.json.skipped, 0);
  }
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

test("the site's global JSON parser (100 kb) skips the help sync - the data is ~250 kb, help.js parses it with 3 mb", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const line = src.split(/\r?\n/).find((l) => l.includes("? next() : express.json()(req, res, next)"));
  assert.ok(line, "the skip list");
  assert.ok(line.includes('req.path === "/api/pepe/help/sync"'));
  assert.ok(Buffer.byteLength(JSON.stringify(BUNDLED)) > 100 * 1024, "(why: bigger than the default limit)");
});

test("navbar + footer + guides point at /help, not Netlify", async () => {
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  // 1.99jo: the labels come from locales/en.json now - check the rendered (English) layout
  const html = await require("ejs").renderFile(path.join(repo, "views", "layout.ejs"), { title: "T", ogPath: "/" });
  assert.match(html, /<a href="\/help" class="nav-link" title="PepeFrog commands"><span class="ic"><img src="\/public\/img\/pepe.png" height="16" alt=""><\/span>/);
  assert.match(html, /<a href="\/help">Pepe's commands<\/a>/);
  assert.doesNotMatch(layout, /pepe\.publicaccess\.tv"/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views", "economy.ejs"), "utf8"), /pepe\.publicaccess\.tv\/help/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views", "about.ejs"), "utf8"), /href="https:\/\/pepe\.publicaccess\.tv"/);
});
