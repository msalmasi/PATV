// Offline tests for wave 3 (incognito/mic-stage design §N, owner-approved 2026-10-28): 🧠 Pepe's memory from the website
// (memoryoptout.js, Settings → Privacy "Pepe's memory", the privacy policy's §N.8 text).
//   - the capability marker: until Pepe's LATEST report carries caps ["memory"] the card, forget-me's "Keep it that way", the policy
//     text and the settings hub row are hidden and a request is refused; a later report without it (a rollback) hides them again
//   - polarity: on = "don't remember me" (memory_optout on); the card's switch shows remembering
//   - a web change queues Pepe's "privacy.memory" action for the linked login (exempt from the busy cap), audits it, and the state
//     stays Pepe's last report ("waiting") until his report (kind "memory" on the incognito report loop) arrives
//   - memory items are NEVER incognito reports (no incognito_state / incognito_anon / hidden-set change); the answer says caps
//   - Pepe's report: linked identities only, older reports ignored, ONE inbox notice per real change, full_memory heals + counts
//   - forget-me's keep_off queues privacy.memory "on" after privacy.forgetme in the same request
//   - no migration (owner 2026-10-28): an incognito login is not opted out by anything here
//   NODE_PATH=G:/PATV/node_modules node --test test/memoryoptout.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memoryoptout-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const I = require(path.join(repo, "incognito"));
const MO = require(path.join(repo, "memoryoptout"));
const PF = require(path.join(repo, "pepeforget"));

let base, server;
const users = new Map();
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', ?)`,
                 [id, name, name, o.camfrog === undefined ? name + "cf" : o.camfrog]);
  const x = { userId: id, username: name, class: "pleb" };
  users.set(id, x);
  return x;
}
const H = (x, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, x ? { "x-test-user": x.userId } : {}, extra || {});
async function call(method, url, x, body, extra) {
  const r = await fetch(base + url, { method, headers: H(x, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, text: d ? null : await r.text() };
}
const U = {};
const inbox = (uid) => getQuery("SELECT title, body, link, ref FROM inbox WHERE user_id = ? ORDER BY id", [uid]);
const actions = (uid, kind) => getQuery("SELECT id, kind, args, camfrog, status, created FROM pepe_actions WHERE user_id = ? AND (? IS NULL OR kind = ?) ORDER BY id",
                                        [uid, kind || null, kind || null]);
const report = (body) => call("POST", "/api/privacy/incognito/sync", null, Object.assign({ password: "bot", items: [] }, body));
const CAPS = { caps: ["memory"] };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await require(path.join(repo, "messages")).init();
  await I.init();
  await MO.init();
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  U.carol = await mkUser("carol");
  U.dave = await mkUser("dave");
  U.nolink = await mkUser("nolink", { camfrog: null });
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  I.register(app, { addUser, isBotToken: (t) => t === "bot" });
  MO.register(app, { addUser });
  PF.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "terms")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 50));
});
test.after(() => { server.close(); });

test("before a Pepe with the switch reports: no card, no policy text, requests refused; the old wording stays", async () => {
  // an older Pepe's report (no caps)
  const r0 = await report({ items: [] });
  assert.equal(r0.status, 200);
  assert.deepEqual(r0.d.caps, ["memory"], "the site says it understands kind \"memory\" items");
  assert.equal(r0.d.memory.capable, false);
  const s = await call("GET", "/api/privacy/memory", U.alice);
  assert.equal(s.status, 200);
  assert.equal(s.d.capable, false);
  const r = await call("POST", "/api/privacy/memory", U.alice, { on: true });
  assert.deepEqual([r.status, r.d.code], [409, "unsupported"]);
  assert.equal((await actions(U.alice.userId, "privacy.memory")).length, 0);
  const page = (await call("GET", "/settings/privacy", U.alice)).text;
  assert.doesNotMatch(page, /id="memory"/);
  assert.doesNotMatch(page, /id="pvPfKeep"/, "no \"Keep it that way\" box");
  assert.match(page, /Incognito is Pepe&#39;s|Incognito is Pepe's/, "the incognito card's old wording");
  const p = (await call("GET", "/privacy", null)).text;
  assert.doesNotMatch(p, /id="memory"/);
  assert.match(p, /<b>Pepe doesn't remember anything new you say<\/b>/, "the old :247 bullet stays while it is true");
  assert.match(p, /your most-used words aren't recorded for your profile analytics/);
  assert.match(p, /It doesn't switch on incognito, so Pepe starts learning again/);
  assert.doesNotMatch(p, /they no longer stop Pepe remembering/);
  // !remember is on the site's private_args floor whatever Pepe runs (and named in the never-kept list - chatlog-guards checks it)
  const CL = require(path.join(repo, "chatlog"));
  assert.ok(CL.PRIVATE_ARGS.includes("!remember"));
  assert.equal(CL.isPrivateCmd("!remember off"), true);
  assert.equal(CL.isPrivateCmd("!REMEMBER status"), true);
  assert.match(fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8"), /<code>!transcripts<\/code>, <code>!remember<\/code>\)/);
});

test("a report with caps [\"memory\"]: the card, the policy text (N.8, dated), the new incognito wording and forget-me's box show", async () => {
  const r0 = await report(CAPS);
  assert.equal(r0.d.memory.capable, true);
  const cap = await MO.capability();
  assert.equal(cap.on, true);
  assert.ok(cap.first_at > 0);
  const s = await call("GET", "/api/privacy/memory", U.alice);
  assert.deepEqual([s.d.capable, s.d.linked, s.d.login, s.d.on], [true, true, "alicecf", false], "nobody starts opted out (no migration)");
  const page = (await call("GET", "/settings/privacy", U.alice)).text;
  assert.match(page, /<section class="ds-card lg" id="memory"/);
  assert.match(page, /Let Pepe remember what I tell him/);
  assert.match(page, /<input type="checkbox" id="pvMem" checked/, "the switch shows REMEMBERING (the default)");
  assert.match(page, /<input type="checkbox" id="pvMemForget" aria-describedby="pvMemForgetHint">/, "\"Also forget\" unticked by default");
  assert.match(page, /<input type="checkbox" id="pvPfKeep" checked>/, "forget-me's \"Keep it that way\" ticked by default");
  assert.match(page, /data-mem="1"/);
  assert.match(page, /Incognito changes what the website shows about you - not what Pepe remembers/);
  // 1.99aft (review): Pepe counts no top word said while incognito, with the switch too - the line stays
  assert.match(page, /Your most-used words aren&#39;t recorded|Your most-used words aren't recorded/, "words: never counted while incognito");
  assert.match(page, /\/public\/js\/privacy-memory\.js/);
  const p = (await call("GET", "/privacy", null)).text;
  assert.match(p, /<h3 id="memory">Pepe's memory<\/h3>/);
  assert.match(p, /<b>Incognito changes what the website shows, not what Pepe remembers\.<\/b> To stop Pepe remembering what you say, use <a href="#memory">"Pepe's memory"<\/a> below \(or type <code>!remember off<\/code>\)\./);
  assert.doesNotMatch(p, /<b>Pepe doesn't remember anything new you say<\/b>/, "N.8 replaces the :247 bullet");
  assert.match(p, /<b>From then on, Pepe learns nothing new from what you say\.<\/b>/);
  assert.match(p, /The room's log commands \(<code>!log<\/code>, <code>!search<\/code>, <code>!replay<\/code>, <code>!seen<\/code>\) aren't his memory/);
  assert.match(p, /your mic stats, levels, achievements and points \(the room's games and boards\)/, "PAT is points");
  assert.doesNotMatch(p, /coins/);
  assert.match(p, /"Make Pepe forget me"<\/a> wipes it - with your private conversations with him - and keeps the switch off\./);
  assert.match(p, /It also keeps <a href="#memory">Pepe's memory<\/a> switched off from then on/);
  assert.doesNotMatch(p, /It doesn't switch on incognito, so Pepe starts learning again/);
  assert.match(p, /your most-used words aren't recorded for your profile analytics/, "1.99aft: true with the switch too (review)");
  // 1.99aft (review): incognito's "What it doesn't do" no longer says it stops (memory) data; forget-me's no in Camfrog is spelled out
  assert.match(p, /<b>What it doesn't do:<\/b> it doesn't change what Pepe remembers \(that's <a href="#memory">Pepe's memory<\/a>\)/);
  assert.doesNotMatch(p, /it only stops <i>new<\/i> data/);
  assert.match(p, /untick <i>Keep it that way<\/i> on the website, or in Camfrog \(where <code>!forgetme now<\/code> asks\) type <code>!forgetme confirm remember<\/code>\./);
  assert.doesNotMatch(p, /Pepe asks\)/);
  assert.match(p, new RegExp("<li><b>" + cap.first_day + ":</b> <a href=\"#incognito\">Incognito</a> and <code>!bridge hide</code> now change only what the website shows; they no longer stop Pepe remembering what you say\\."));
  assert.match(p, /<a href="#memory">Pepe's memory<\/a>, <a href="#forget">/, "in the contents");
  // the voice sentence (WP-1) stays either way
  assert.match(p, /<b>Your voice is still heard:<\/b>/);
});

test("web OFF-switch (on: true) -> privacy.memory [\"on\"] for the linked login, waiting, Pepe's kind \"memory\" report -> state + ONE notice; incognito untouched", async () => {
  const r = await call("POST", "/api/privacy/memory", U.alice, { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const a = await actions(U.alice.userId, "privacy.memory");
  assert.equal(a.length, 1);
  assert.deepEqual(JSON.parse(a[0].args), ["on"], "on = don't remember me");
  assert.equal(a[0].camfrog, "alicecf", "runs as the linked chat login");
  let s = await call("GET", "/api/privacy/memory", U.alice);
  assert.ok(s.d.waiting && s.d.waiting.want === true, "waiting for Pepe");
  assert.equal(s.d.on, false, "still Pepe's last word (remembering)");
  assert.match((await call("GET", "/settings/privacy", U.alice)).text, /id="pvMemSt" role="status" aria-live="polite">Waiting for Pepe/);
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'ok', updated = ? WHERE id = ?", [Date.now(), a[0].id]);
  const ts = Number(a[0].created) + 2000;
  const sy = await report({ ...CAPS, items: [{ login: "alicecf", kind: "memory", on: true, via: "web", changed: true, ts }] });
  assert.equal(sy.status, 200);
  assert.deepEqual([sy.d.memory.applied, sy.d.applied], [1, 0], "a memory item, not an incognito one");
  s = await call("GET", "/api/privacy/memory", U.alice);
  assert.equal(s.d.waiting, null);
  assert.equal(s.d.on, true);
  assert.equal(s.d.since, ts);
  const ib = await inbox(U.alice.userId);
  assert.equal(ib.length, 1);
  assert.match(ib[0].title, /Pepe stopped remembering you/);
  assert.match(ib[0].body, /from Settings → Privacy/);
  assert.equal(ib[0].link, "/settings/privacy#memory");
  await report({ ...CAPS, items: [{ login: "alicecf", kind: "memory", on: true, via: "web", changed: true, ts }] });
  assert.equal((await inbox(U.alice.userId)).length, 1, "a re-sent report files no second notice");
  const kinds = s.d.log.map((x) => x.kind);
  assert.ok(kinds.includes("request") && kinds.includes("applied"), "audited");
  // never an incognito report: no incognito state, no "someone" on boards, no hidden set
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_state"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_anon"))[0].n, 0);
  assert.equal((await call("GET", "/api/privacy/incognito", U.alice)).d.on, null, "incognito: still nothing reported");
  const page = (await call("GET", "/settings/privacy", U.alice)).text;
  assert.match(page, /<input type="checkbox" id="pvMem"  /, "the switch shows NOT remembering");
  // back on, from chat (Pepe's own report: !remember on by PM)
  await report({ ...CAPS, items: [{ login: "alicecf", kind: "memory", on: false, via: "chat", changed: true, ts: ts + 60000 }] });
  s = await call("GET", "/api/privacy/memory", U.alice);
  assert.equal(s.d.on, false);
  const ib2 = await inbox(U.alice.userId);
  assert.equal(ib2.length, 2);
  assert.match(ib2[1].title, /Pepe remembers you again/);
  assert.match(ib2[1].body, /with !remember in chat/);
  // an older report than what we have is ignored
  const old = await report({ ...CAPS, items: [{ login: "alicecf", kind: "memory", on: true, via: "chat", ts: ts + 1 }] });
  assert.equal(old.d.memory.ignored, 1);
  assert.equal((await call("GET", "/api/privacy/memory", U.alice)).d.on, false);
});

test("a mixed report: incognito items still apply, memory items go to their own table; unlinked logins never stored; full_memory heals + counts", async () => {
  const t = Date.now();
  const r = await report({ ...CAPS, items: [{ login: "bobcf", on: true, via: "chat", changed: false, ts: t },                // incognito (no kind)
                                           { login: "carolcf", kind: "memory", on: true, via: "telegram", changed: true, ts: t },
                                           { login: "strangercf", kind: "memory", on: true, via: "chat", ts: t },
                                           { login: "bad name!", kind: "memory", on: true, ts: t },
                                           { login: "zedcf", kind: "future", on: true, ts: t }] });
  assert.equal(r.status, 200);
  assert.equal(r.d.applied, 1, "bob's incognito");
  assert.deepEqual([r.d.memory.applied, r.d.memory.ignored], [1, 2]);
  assert.equal((await getQuery(`SELECT "on" AS v FROM incognito_state WHERE login = 'bobcf'`))[0].v, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_state WHERE login IN ('carolcf', 'zedcf')"))[0].n, 0, "never incognito");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM memory_optout_state WHERE login = 'bobcf'"))[0].n, 0, "incognito is not memory (no migration)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM memory_optout_state WHERE login = 'strangercf'"))[0].n, 0, "linked identities only");
  assert.match((await inbox(U.carol.userId))[0].body, /with \/remember on Telegram/);
  // the full list: dave (linked) + two unlinked logins on; carol not listed -> off
  await report({ ...CAPS, full_memory: ["DaveCF", "x1cf", "x2cf"] });
  assert.equal((await call("GET", "/api/privacy/memory", U.dave)).d.on, true);
  assert.equal((await call("GET", "/api/privacy/memory", U.carol)).d.on, false);
  const sum = await MO.adminSummary();
  assert.deepEqual([sum.capable, sum.all, sum.linked], [true, 3, 1], "how many, never who");
});

test("refusals: unlinked account, bad body, CSRF, signed out, the rate limit (audited); the busy cap doesn't apply", async () => {
  const n = await call("POST", "/api/privacy/memory", U.nolink, { on: true });
  assert.deepEqual([n.status, n.d.code], [409, "unlinked"]);
  assert.equal((await call("GET", "/api/privacy/memory", U.nolink)).d.linked, false);
  assert.match((await call("GET", "/settings/privacy", U.nolink)).text, /Pepe&#39;s memory is about your chat identity|Pepe's memory is about your chat identity/);
  assert.equal((await call("POST", "/api/privacy/memory", U.bob, { on: "yes" })).status, 400);
  assert.equal((await call("POST", "/api/privacy/memory", U.bob, { on: true }, { "x-requested-with": "" })).status, 403);
  assert.equal((await call("POST", "/api/privacy/memory", U.bob, { on: true }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/privacy/memory", null, { on: true })).status, 401);
  assert.equal((await call("GET", "/api/privacy/memory", null)).status, 401);
  // six other things waiting for Pepe: a privacy request still goes in (like forget-me)
  for (let i = 0; i < 6; i++) await runQuery("INSERT INTO pepe_actions (user_id, username, kind, args, status, created, updated) VALUES (?, 'bob', 'cmd', '[]', 'pending', ?, ?)",
                                             [U.bob.userId, Date.now(), Date.now()]);
  assert.equal((await call("POST", "/api/privacy/memory", U.bob, { on: true })).status, 200, "exempt from the busy cap");
  for (let i = 1; i < MO.RATE_MAX; i++) assert.equal((await call("POST", "/api/privacy/memory", U.bob, { on: i % 2 === 0 })).status, 200);
  const over = await call("POST", "/api/privacy/memory", U.bob, { on: true });
  assert.deepEqual([over.status, over.d.code], [429, "rate"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM memory_optout_log WHERE user_id = ? AND kind = 'refused'", [U.bob.userId]))[0].n, 1, "refusal audited");
});

test("forget-me with \"Keep it that way\": privacy.forgetme then privacy.memory [\"on\"] in one request; unticked, none", async () => {
  await runQuery("DELETE FROM pepe_actions WHERE user_id = ?", [U.dave.userId]);
  const r = await call("POST", "/api/privacy/pepe-forget", U.dave, { confirm: "FORGET", keep_off: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(r.d.memory_action);
  const a = await actions(U.dave.userId);
  assert.deepEqual(a.map((x) => [x.kind, JSON.parse(x.args)]), [["privacy.forgetme", []], ["privacy.memory", ["on"]]], "forget first, then the switch");
  assert.equal(a[1].id, r.d.memory_action);
  const log = await getQuery("SELECT kind, via FROM memory_optout_log WHERE user_id = ? ORDER BY id DESC LIMIT 1", [U.dave.userId]);
  assert.deepEqual([log[0].kind, log[0].via], ["request", "forget"]);
  assert.ok((await call("GET", "/api/privacy/memory", U.dave)).d.waiting, "the card waits for Pepe's report of it");
  // unticked: the forget alone
  await runQuery("DELETE FROM pepe_actions WHERE user_id = ?", [U.carol.userId]);
  const r2 = await call("POST", "/api/privacy/pepe-forget", U.carol, { confirm: "FORGET" });
  assert.equal(r2.status, 200);
  assert.equal(r2.d.memory_action, undefined);
  assert.deepEqual((await actions(U.carol.userId)).map((x) => x.kind), ["privacy.forgetme"]);
});

test("the incognito notice says incognito no longer stops memory - only with a Pepe that has the split", async () => {
  const t = Date.now();
  await report({ items: [{ login: "carolcf", on: true, via: "chat", changed: true, ts: t }] });             // an older Pepe
  await report({ ...CAPS, items: [{ login: "carolcf", on: false, via: "chat", changed: true, ts: t + 1 }] });
  await report({ ...CAPS, items: [{ login: "carolcf", on: true, via: "chat", changed: true, ts: t + 2 }] });
  const ib = (await inbox(U.carol.userId)).filter((x) => /Incognito/.test(x.title));
  assert.equal(ib.length, 3);
  assert.match(ib[0].body, /He won't remember anything new you say/, "the old Pepe: the old promise was true");
  assert.match(ib[1].body, /The website shows your name again\./);
  assert.doesNotMatch(ib[1].body, /remembers what you tell him again/);
  assert.match(ib[2].body, /It doesn't change what Pepe remembers - that's "Pepe's memory" in Settings → Privacy\./);
  assert.doesNotMatch(ib[2].body, /won't remember/);
});

test("a rollback: the next report without caps hides it all again and refuses requests (the text is never false)", async () => {
  await report({ items: [] });
  assert.equal(await MO.capable(), false);
  assert.equal(await MO.privacyCopy(), null);
  assert.deepEqual([(await call("POST", "/api/privacy/memory", U.carol, { on: true })).d.code], ["unsupported"]);
  assert.doesNotMatch((await call("GET", "/settings/privacy", U.carol)).text, /id="memory"/);
  assert.doesNotMatch((await call("GET", "/privacy", null)).text, /<h3 id="memory">/);
  // forget-me's keep_off is then left out (the box isn't shown either)
  await runQuery("DELETE FROM pepe_actions WHERE user_id = ?", [U.carol.userId]);
  const r = await call("POST", "/api/privacy/pepe-forget", U.carol, { confirm: "FORGET", keep_off: true });
  assert.equal(r.status, 200);
  assert.deepEqual((await actions(U.carol.userId)).map((x) => x.kind), ["privacy.forgetme"]);
  // back again: the first date stays (the policy's changelog date doesn't move)
  const first = (await MO.capability()).first_at;
  await report(CAPS);
  assert.equal((await MO.capability()).first_at, first);
});

test("1.99aft: Pepe's carry-overs and Telegram get their own words; a re-key files no second notice", async () => {
  await report(CAPS);
  const t = Date.now() + 120000;
  const n0 = (await inbox(U.bob.userId)).length;
  await report({ ...CAPS, items: [{ login: "bobcf", kind: "memory", on: true, via: "rekey", changed: true, ts: t }] });
  assert.equal((await call("GET", "/api/privacy/memory", U.bob)).d.on, true, "applied");
  assert.equal((await inbox(U.bob.userId)).length, n0, "a re-key (the same person's earlier choice) files no new notice");
  const lg = await getQuery("SELECT kind, via FROM memory_optout_log WHERE user_id = ? ORDER BY id DESC LIMIT 1", [U.bob.userId]);
  assert.deepEqual([lg[0].kind, lg[0].via], ["applied", "rekey"], "audited with its own via (not filed as chat)");
  await report({ ...CAPS, items: [{ login: "bobcf", kind: "memory", on: false, via: "telegram", changed: true, ts: t + 1 }] });
  await report({ ...CAPS, items: [{ login: "bobcf", kind: "memory", on: true, via: "ident", changed: true, ts: t + 2 }] });
  const ib = (await inbox(U.bob.userId)).slice(n0);
  assert.equal(ib.length, 2);
  assert.match(ib[0].body, /with \/remember on Telegram/);
  assert.match(ib[1].body, /carried over from !remember off typed in a room under the name you showed there/);
  assert.doesNotMatch(ib[1].body, /with !remember in chat/);
  const page = (await call("GET", "/settings/privacy", U.bob)).text;
  assert.match(page, /Pepe stopped remembering you \(your earlier choice, carried over to this chat name\)/);
  assert.match(page, /Pepe remembers you again \(\/remember on Telegram\)/);
  assert.doesNotMatch(page, /Pepe remembers you again \(!remember in chat\)/, "Telegram isn't labelled as chat");
});

test("1.99aft: deleting an account with no chat login still asks Pepe to clear its account key's switch", async () => {
  const AD = require(path.join(repo, "accountdelete"));
  const src = fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8");
  assert.match(src, /\[uid, pseudo, login \|\| null, FORGET_KIND, login \? "\[\]" : ACCT_FORGET_ARGS, t, t, `acctdel-forget-\$\{uid\}-1`\]/,
               "the privacy.forget action is queued with or without a login (no login: args [\"account\"])");
  assert.doesNotMatch(src, /if \(login && \(await tableExists\("pepe_actions"\)\)\)/);
  // the retry knows the account-key action (it has no login to carry)
  await AD.init();
  const old = Date.now() - 7 * 3600000;
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES ('gone1', 'done', ?, ?)", [old, old]);
  await runQuery(`INSERT INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                  VALUES ('gone1', 'deleted-x', NULL, 0, 'privacy.forget', '["account"]', 'privacy', 'account deleted', 'expired', ?, ?, 'acctdel-forget-gone1-1')`, [old, old]);
  await AD.retryForget();
  const a = await getQuery("SELECT camfrog, args, status FROM pepe_actions WHERE user_id = 'gone1' ORDER BY id");
  assert.deepEqual(a.map((x) => [x.camfrog, x.args, x.status]), [[null, '["account"]', "expired"], [null, '["account"]', "pending"]],
                   "an expired account-key action is asked again, like a login's");
});

test("account deletion, merge and the data download know the tables; the settings hub row", async () => {
  const AD = require(path.join(repo, "accountdelete"));
  const del = AD.DELETE_ROWS.map((r) => r.join(":"));
  assert.ok(del.includes("memory_optout_log:user_id:uid"));
  assert.ok(del.includes("memory_optout_state:login:login"));
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.classify("memory_optout_log", "user_id"));
  const src = fs.readFileSync(path.join(repo, "accountexport.js"), "utf8");
  assert.match(src, /rows\("memory_optout_state", "login = \?", \[login\]\)/);
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /DELETE FROM memory_optout_state WHERE login = \?", \["u:" \+ String\(uid\)\.toLowerCase\(\)\]/);
  const TTL = require(path.join(repo, "actionttl"));
  assert.equal(TTL.TTL_DEFAULTS["privacy.memory"], 1440);
  const SH = require(path.join(repo, "settingshub"));
  const hub = await SH.hub({ userId: U.dave.userId, username: "dave" });
  const priv = hub.find((s) => s.id === "privacy").entries;
  const ids = priv.map((e) => e.id);
  assert.ok(ids.includes("memory"), "the row shows while Pepe has the switch");
  assert.equal(priv.find((e) => e.id === "memory").href, "/settings/privacy#memory");
  assert.equal(priv.find((e) => e.id === "incognito").desc, "sethub.d.incognito_v2");
  await report({ items: [] });
  const hub2 = await SH.hub({ userId: U.dave.userId, username: "dave" });
  const p2 = hub2.find((s) => s.id === "privacy").entries;
  assert.ok(!p2.some((e) => e.id === "memory"));
  assert.equal(p2.find((e) => e.id === "incognito").desc, "sethub.d.incognito");
});
