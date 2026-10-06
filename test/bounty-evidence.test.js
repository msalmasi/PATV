// Offline tests for 1.99bl bounty evidence + verification on the site (bounties.js, views/bounty*.ejs):
// Pepe's snapshot keeps the spec text, claim evidence (http(s) links only) and his check; the claim form
// takes an evidence link (no uploads); reject is creator/admin only, dispute only for the claimant once
// rejected (or after 12 h); the claim queue hands the evidence to Pepe; the pages escape what they show.
// Also writes stub renders of the bounty card to $BOUNTY_SHOTS (if set) for screenshots.
//   NODE_PATH=G:/PATV/node_modules node --test test/bounty-evidence.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bounty-ev-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bounties = require(path.join(repo, "bounties"));

let base, server;
const NOW = Math.floor(Date.now() / 1000);
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, casino_banned INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  for (const [id, name, cf, cls] of [["u1", "wattz", "watermelonfelon", "pleb"], ["u2", "hunt", "hunter", "pleb"],
    ["u3", "boss", "plantbaked", "Admin"], ["u4", "rando", "rando", "pleb"], ["u5", "late", "latecomer", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 5000)",
      [id, name, name, cf, cls]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  bounties.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const SNAP = {
  id: 3, creator: "watermelonfelon", task: "Kick tricon when he mentions pokemon", room: "DRAMA_CENTRAL", status: "open",
  created: NOW - 3600, deadline: NOW + 86400, pot: [{ nick: "watermelonfelon", amount: 1000 }, { nick: "rando", amount: 500 }],
  verify: { text: "a kick of tricon by the claimant within 5 min after tricon mentions 'pokemon' (in chat or on mic; anything on that topic counts)", action: "kick" },
  claims: [
    { nick: "hunter", ts: NOW - 600, note: "got him <b>bold</b>",
      evidence: { text: "clip", links: ["https://clips.example/abc", "javascript:alert(1)", "https://publicaccess.tv/media/0123456789abcdef"] },
      check: { state: "creator", how: "semantic", lines: ["10-06 21:14:03 tricon (chat, DRAMA_CENTRAL): \"pikachu <script>x</script>\"", "10-06 21:16:40 hunter kicked tricon (DRAMA_CENTRAL, mod log) — 2m37s later"], why: "the trigger matched by meaning (AI judge)" } },
    { nick: "latecomer", ts: NOW - 13 * 3600, note: "me too", check: { state: "no_match", lines: [], why: "no kick of tricon by you since it was posted" } },
    { nick: "rando", ts: NOW - 300, note: "", rejected: { by: "watermelonfelon", why: "nope" } },
  ],
};

async function sync(list, token = "bot-token") {
  const r = await fetch(base + "/api/bounties/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: token, bounties: list }) });
  return r.status;
}
const form = (u, url, body) => fetch(base + url, { method: "POST", redirect: "manual",
  headers: Object.assign({ "content-type": "application/x-www-form-urlencoded" }, u ? { "x-test-user": u } : {}),
  body: new URLSearchParams(body).toString() });
const msgOf = (r) => decodeURIComponent((r.headers.get("location") || "").split("msg=")[1] || "");
const page = async (u, url) => (await fetch(base + url, { headers: u ? { "x-test-user": u } : {} })).text();

test("sync keeps spec + evidence + check; drops non-http links; bot token required", async () => {
  assert.equal(await sync([SNAP], "nope"), 403);
  assert.equal(await sync([SNAP]), 200);
  const b = JSON.parse((await getQuery("SELECT data FROM bounties WHERE id = 3"))[0].data);
  assert.match(b.verify.text, /a kick of tricon/);
  assert.deepEqual(b.claims[0].evidence.links, ["https://clips.example/abc", "https://publicaccess.tv/media/0123456789abcdef"]);
  assert.equal(b.claims[0].check.state, "creator");
  assert.equal(b.claims[0].check.how, "semantic");
  assert.equal(b.claims[2].rejected.why, "nope");
  assert.equal(bounties.cleanLink("data:text/html,x"), null);
  assert.equal(bounties.cleanLink("https://a.example/x y"), null);
  assert.equal(bounties.cleanClaim({ nick: "x", check: { state: "bogus" } }).check, null);
});

test("the page shows the spec, evidence links and Pepe's check, escaped", async () => {
  const html = await page(null, "/bounties/3");
  assert.match(html, /Pepe verifies this one:/);
  assert.match(html, /href="https:\/\/clips\.example\/abc" target="_blank" rel="nofollow noopener noreferrer ugc"/);
  assert.ok(!html.includes("javascript:alert"));
  assert.ok(!html.includes("<script>x</script>") && html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /Looks right, waiting for watermelonfelon/);
  assert.match(html, /matched by meaning/);
  assert.match(html, /couldn’t confirm it from his logs/);
  assert.ok(!html.includes("/reject\"") && !html.includes("/dispute\""), "signed out: no reject/dispute forms");
  const board = await page(null, "/bounties");
  assert.match(board, /🔎 Pepe verifies · 1 matching claim · 🔗 1 with evidence/);
});

test("reject / dispute forms only for the people allowed", async () => {
  const creator = await page("u1", "/bounties/3");
  assert.equal((creator.match(/action="\/bounties\/3\/reject"/g) || []).length, 2, "creator: reject hunter + latecomer (rando already rejected)");
  assert.ok(!creator.includes("/bounties/3/dispute"));
  const admin = await page("u3", "/bounties/3");
  assert.match(admin, /Reject claim \(admin\)/);
  const hunter = await page("u2", "/bounties/3");
  assert.ok(!hunter.includes("/bounties/3/reject") && !hunter.includes("/bounties/3/dispute"), "hunter: claim 10 min old, not rejected");
  assert.match(hunter, /name="evidence"/);
  const rando = await page("u4", "/bounties/3");
  assert.match(rando, /action="\/bounties\/3\/dispute"/, "rejected claimant may dispute");
  const late = await page("u5", "/bounties/3");
  assert.match(late, /action="\/bounties\/3\/dispute"/, "a claim the creator sat on for 12h may be disputed");
});

test("claim with evidence is queued for Pepe; bad links refused; permissions enforced", async () => {
  let r = await form("u2", "/bounties/3/claim", { note: "did it", evidence: "javascript:alert(1)" });
  assert.match(msgOf(r), /has to be a link/);
  r = await form("u2", "/bounties/3/claim", { note: "did it", evidence: "https://clips.example/new" });
  assert.match(msgOf(r), /He'll check his logs/);
  r = await form("u1", "/bounties/3/claim", { note: "mine" });
  assert.match(msgOf(r), /can't claim your own/);
  r = await form("u2", "/bounties/3/reject", { hunter: "latecomer" });
  assert.match(msgOf(r), /Only watermelonfelon/);
  r = await form("u2", "/bounties/3/dispute", { note: "pls" });
  assert.match(msgOf(r), /Give watermelonfelon a chance/);
  r = await form("u1", "/bounties/3/reject", { hunter: "nobody" });
  assert.match(msgOf(r), /hasn't claimed/);
  r = await form("u1", "/bounties/3/reject", { hunter: "latecomer", note: "wasn't you" });
  assert.match(msgOf(r), /rejecting latecomer/);
  r = await form("u4", "/bounties/3/dispute", { note: "it counts" });
  assert.match(msgOf(r), /goes to the admins/);
  const q = await fetch(base + "/api/bounties/actions/claim", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token" }) });
  const acts = (await q.json()).actions;
  const claim = acts.find((a) => a.kind === "claim");
  assert.equal(claim.evidence, "https://clips.example/new");
  const rej = acts.find((a) => a.kind === "reject");
  assert.deepEqual(rej.hunters, ["latecomer"]);
  assert.equal(rej.note, "wasn't you");
  assert.ok(acts.find((a) => a.kind === "dispute" && a.camfrog === "rando"));
});

test("disputed claims: only an admin can reject", async () => {
  const s = JSON.parse(JSON.stringify(SNAP));
  s.claims[2].disputed = true;
  await sync([s]);
  let r = await form("u1", "/bounties/3/reject", { hunter: "rando" });
  assert.match(msgOf(r), /with the admins/);
  r = await form("u3", "/bounties/3/reject", { hunter: "rando" });
  assert.match(msgOf(r), /rejecting rando/);
  const creator = await page("u1", "/bounties/3");
  assert.match(creator, /disputed: admins/);
});

test("stub renders for screenshots", async () => {
  const out = process.env.BOUNTY_SHOTS;
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  await sync([SNAP, { ...SNAP, id: 4, task: "say 'frogs rule' on the mic", verify: null, claims: [], pot: [{ nick: "rando", amount: 2500 }] },
    { ...SNAP, id: 5, task: "ban sard0nicgrin", status: "resolved", auto: true, hunters: ["hunter"], resolved: NOW - 60,
      claims: [{ nick: "hunter", ts: NOW - 120, note: "", check: { state: "verified", how: "exact", lines: ["10-06 21:16:40 hunter banned sard0nicgrin (DRAMA_CENTRAL, mod log)"], why: "" } }] }]);
  fs.writeFileSync(path.join(out, "bounty-detail.html"), await page("u1", "/bounties/3"));
  fs.writeFileSync(path.join(out, "bounty-board.html"), await page("u2", "/bounties"));
});
