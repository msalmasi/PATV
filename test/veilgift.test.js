// 1.99ajn padppl: 🎁 gifts to frog names (veilgift.js) - a private gift inbox, built so a gift can NOT unmask anyone.
//   - dark: refused while the switch is off
//   - the sender's answer is the SAME (keys, label, amount, balance) whoever is behind the frog name: an account, a Camfrog login with no
//     account, a recipient who blocked them, a capped recipient, nobody - the differences are only server-side (pending vs withheld)
//   - the PAT is escrowed (VGF hold, a site service's - never Pepe's), nothing credited, no tip rows, no achievements / streaks / tip jar
//   - only the recipient sees it (with the sender's name) and decides; accept -> "gift accepted" in their history; the sender never sees
//     accepted / declined; everything not accepted by its due day goes back ("gift returned") - never before
//   - limits per sender; preset amounts only; a gift to a frog name whose login links an account later finds that account
//   node --test test/veilgift.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "veilgift-")));
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const VG = require(path.join(repo, "veilgift"));
const V = require(path.join(repo, "veil"));

let T = Date.parse("2026-11-04T15:00:00Z");
VG._setClock(() => T);
const U = {};
const R = { id: "drama_central", slug: "drama-central", name: "Drama Central", members: [], mic: [], feed: [] };
function frog(alias, id, login) { const e = { anon: true, display: "someone", veil: "incognito", alias, id }; V.hide(e, "_vz", { login, display: login, kind: "incognito" }); return e; }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, archived_at INTEGER, casino_banned INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT, source TEXT)");
  for (const [k, id, name, cf, bal] of [["alice", "ali-1", "alice", "alicecf", 100000], ["sneak", "snk-1", "sneaky", "sneakcf", 0], ["blk", "blk-1", "blocker", "blockercf", 0], ["adm", "adm-1", "boss", null, 0]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance, class) VALUES (?, ?, ?, 'x', ?, ?, ?)", [id, name, name, cf, bal, k === "adm" ? "Admin" : "pleb"]);
    U[k] = { userId: id, username: name, camfrogUsername: cf, class: k === "adm" ? "Admin" : "pleb" };
  }
  R.members = [frog("Soggy Bullfrog", "v-soggy000001", "sneakcf"), frog("Muddy Toad", "v-muddy000001", "neverlinked"), frog("Quiet Newt", "v-blocker00001", "blockercf")];
  await require(path.join(repo, "blocks")).init();
  await VG.init();
});

const balance = async (id) => (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [id]))[0].points_balance;
const types = async () => (await getQuery("SELECT userId, type, points, counterparty, note FROM transactions ORDER BY rowid")).map((r) => [r.userId, r.type, r.points, r.counterparty, r.note]);

test("dark until switched on; amounts are presets only; Admins switch it", async () => {
  await assert.rejects(VG.send(U.alice, R, { k: "veil", id: "v-soggy000001" }, 500), (e) => e.status === 404);
  await assert.rejects(VG.setOn(U.alice, true), (e) => e.status === 403);
  await VG.setOn(U.adm, true);
  await assert.rejects(VG.send(U.alice, R, { k: "veil", id: "v-soggy000001" }, 123), (e) => e.status === 400);
  await assert.rejects(VG.send(U.alice, R, { k: "login", v: "sneakcf" }, 500), (e) => e.status === 400, "named people get a tip, not a gift");
});

test("the SAME answer whoever is behind the frog name - an account, a login with no account, a blocker; the PAT is held, nothing credited", async () => {
  // the blocker blocked alice (named) - their gift is withheld, silently
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('blk-1', 'ali-1', 1)");
  require(path.join(repo, "blocks")).changed("blk-1", "ali-1");
  const a = await VG.send(U.alice, R, { k: "veil", id: "v-soggy000001" }, 1000, "k1");
  const b = await VG.send(U.alice, R, { k: "veil", id: "v-muddy000001" }, 1000, "k2");
  const c = await VG.send(U.alice, R, { k: "veil", id: "v-blocker00001" }, 1000, "k3");
  for (const [x, label] of [[a, "Soggy Bullfrog"], [b, "Muddy Toad"], [c, "Quiet Newt"]]) {
    assert.deepEqual(Object.keys(x).sort(), ["amount", "balance", "label", "ok"]);
    assert.equal(x.label, label); assert.equal(x.amount, 1000);
    assert.doesNotMatch(JSON.stringify(x), /sneak|blocker|neverlinked|snk-|blk-/);
  }
  assert.equal(c.balance, 97000, "each one escrowed from the sender");
  assert.equal(await balance("snk-1"), 0, "nothing credited to the recipient");
  // server-side only: pending for the account, pending for the login (it may link), withheld for the blocker
  const rows = await getQuery("SELECT to_user, to_login, state FROM veil_gifts ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.to_user, r.to_login, r.state]), [["snk-1", null, "pending"], [null, "neverlinked", "pending"], ["blk-1", null, "withheld"]]);
  // the money: a VGF hold each (a site service's), the sender's "gift sent" rows name nobody - no tip rows anywhere
  const ESC = require(path.join(repo, "escrow", "ledger"));
  assert.ok(ESC.isServiceKind("VGF"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE kind = 'VGF' AND state = 'held'"))[0].n, 3);
  const tx = await types();
  assert.ok(tx.every((r) => r[1] === "gift sent" && r[0] === "ali-1" && r[3] == null), JSON.stringify(tx));
  assert.deepEqual(tx.map((r) => r[4]), ["🐸 Soggy Bullfrog", "🐸 Muddy Toad", "🐸 Quiet Newt"], "the note is the frog name only");
  assert.ok(!tx.some((r) => /tip/.test(r[1])), "never a tip row (tip jar, 'you and X', tip achievements, tip volume read only those)");
  // the recipient's private notice names the sender and the frog name; the blocker got nothing (review fix: the notice goes out after
  // the answer, never awaited - so the answer's timing is the same for every recipient)
  await new Promise((r) => setTimeout(r, 100));
  const n = await getQuery("SELECT user_id, title FROM inbox WHERE kind = 'gift'");
  assert.deepEqual(n.map((x) => x.user_id), ["snk-1"]);
  assert.match(n[0].title, /^🎁 @alice sent you a gift of 1,000 PAT while you were 🐸 Soggy Bullfrog in /);
  // idempotent by the key
  const again = await VG.send(U.alice, R, { k: "veil", id: "v-soggy000001" }, 1000, "k1");
  assert.equal(again.dup, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM veil_gifts"))[0].n, 3);
});

test("only the recipient sees it and decides; accept -> 'gift accepted' in THEIR history; the sender never learns which", async () => {
  const inbox = await VG.inboxOf("snk-1");
  assert.equal(inbox.length, 1); assert.equal(inbox[0].from, "alice"); assert.equal(inbox[0].state, "pending");
  assert.deepEqual(await VG.inboxOf("ali-1"), [], "the sender has no view of it");
  const sent = await VG.sentBy("ali-1");
  assert.deepEqual(sent.map((s) => Object.keys(s).sort()), [["amount", "at", "label"], ["amount", "at", "label"], ["amount", "at", "label"]], "never a state");
  const r = await VG.accept(U.sneak, inbox[0].id);
  assert.equal(r.amount, 1000); assert.equal(await balance("snk-1"), 1000);
  const tx = await types();
  const acc = tx.find((x) => x[1] === "gift accepted");
  assert.deepEqual([acc[0], acc[2], acc[3]], ["snk-1", 1000, "ali-1"], "the recipient's own row names the sender");
  assert.deepEqual(await VG.sentBy("ali-1"), sent, "the sender's view is unchanged by the accept");
  await assert.rejects(VG.accept(U.alice, inbox[0].id), (e) => e.status === 404, "never anyone else's to accept");
  // the achievements never fire for gifts (no checkWeb; their counters read tip rows)
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "veilgift.js"), "utf8"), /\.checkWeb\(|require\("\.\/(achievements|streaks)"\)|tipAnnounce\(/);
});

test("not accepted by its due day: back to the sender (never before); a login that links in time finds its gifts", async () => {
  // the login gift: it links before its due day -> the account gets it
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('nev-1', 'newbie', 'newbie', 'x', 'neverlinked')");
  await VG.linked("nev-1", "neverlinked");
  const nb = await VG.inboxOf("nev-1");
  assert.equal(nb.length, 1);
  await VG.decline({ userId: "nev-1" }, nb[0].id);
  // before due: nothing moves
  assert.equal(await VG.settleDue(), 0);
  const before = await balance("ali-1");
  T += VG.DUE_MS + 1;
  assert.equal(await VG.settleDue(), 2, "the declined one and the withheld one");
  assert.equal(await balance("ali-1"), before + 2000);
  const back = (await types()).filter((x) => x[1] === "gift returned");
  assert.equal(back.length, 2); assert.ok(back.every((x) => x[0] === "ali-1"));
  assert.deepEqual((await getQuery("SELECT state FROM veil_gifts ORDER BY id")).map((r) => r.state), ["accepted", "refunded", "refunded"]);
});

test("limits: per sender an hour / a day / PAT a day - and yourself is the one thing a sender is told", async () => {
  const me = await VG.send(U.sneak, R, { k: "veil", id: "v-soggy000001" }, 100).catch((e) => e);
  assert.equal(me.status, 400); assert.equal(me.message, "That's you.");
  await runQuery("UPDATE users SET points_balance = 1000000 WHERE userId = 'ali-1'");
  for (let i = 0; i < VG.HOUR_MAX; i++) await VG.send(U.alice, R, { k: "veil", id: "v-muddy000001" }, 100, "lim" + i);
  await assert.rejects(VG.send(U.alice, R, { k: "veil", id: "v-muddy000001" }, 100, "lim-x"), (e) => e.status === 429);
});

test("review: the sender's own data never tells them whether / when a frog accepted - no VGF hold in their export, never a delete blocker", async () => {
  // (the gift's escrow hold is the SENDER's row: its state / done_at moved when sneaky accepted above)
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE user_id = 'ali-1' AND kind = 'VGF'"))[0].n >= 1);
  const ex = fs.readFileSync(path.join(repo, "accountexport.js"), "utf8");
  assert.match(ex, /rows\("escrow_holds", "user_id = \? AND COALESCE\(kind, ''\) <> 'VGF'", \[uid\], \{ omit: \["cp"\] \}\)/);
  const { getQuery: gq } = require(path.join(repo, "dbUtils"));
  const shown = await gq("SELECT kind, state FROM escrow_holds WHERE user_id = ? AND COALESCE(kind, '') <> 'VGF'", ["ali-1"]);
  assert.equal(shown.length, 0, "what the export's escrow_holds would hold for alice: nothing about her gifts");
  const del = fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8");
  assert.match(del, /SELECT 1 FROM escrow_holds WHERE user_id = \? AND state = 'held' AND COALESCE\(kind, ''\) <> 'VGF' LIMIT 1/, "a pending gift never blocks deleting");
  // and the texts say what the day-30 refund does tell them
  assert.match(JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"))["js.gift.body"], /we never tell you who it is or whether they accepted\. A gift that isn't accepted within 30 days comes back to you\./);
  assert.match(JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"))["wallet.gifts.why"], /We never tell them whether you accepted, but a gift that comes back tells them it wasn't\./);
});
