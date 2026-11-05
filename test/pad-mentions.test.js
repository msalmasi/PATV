// 1.99ajn padppl: @mentions in a pad's chat (owner points 24 + 25) and the people list's active / inactive web users (padweb.js).
//   - the composer's picks ride as {n, ref}: kept only where "@n" is in the words and n is one of that person's names (no pinning a name on
//     someone else); a frog name's entry names nobody; the line's mn is dressed per viewer (gone with the words, gone for a hidden person)
//   - chips in the person's look; a line naming the viewer is .is-mention
//   - alerts ON by default: a structured mention or a Camfrog-typed "@login"; never your own line, never from someone blocked either way,
//     never while muted / this pad muted / the chat switch off; a frog-named line alerts under its frog name; a mention OF a frog name
//     alerts that person privately; a PATV name that clashes with a Camfrog login never alerts by a typed "@"
//   - people list: posted in the last hour (not open) = act 0 with ago, open = act 1; every exclusion runs for both
//   node --test test/pad-mentions.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "pad-mentions-")));
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const M = require(path.join(repo, "mentions"));
const W = require(path.join(repo, "padweb"));
const V = require(path.join(repo, "veil"));
const CR = require(path.join(repo, "public", "js", "chatlog-core"));

const ROOM = "drama_central";
const R = { id: ROOM, slug: "drama-central", members: [], mic: [], feed: [] };
let c = 1000, T = Date.parse("2026-11-04T15:00:00Z");
const line = (it) => ({ roomId: ROOM, slug: "drama-central", name: "Drama Central", it: Object.assign({ k: "msg", ts: T, c: ++c }, it) });
const notices = async (uid) => getQuery("SELECT title, body, ref FROM inbox WHERE user_id = ? AND kind = 'mention' ORDER BY id", [uid]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, archived_at INTEGER, created_at TEXT)`);
  for (const [id, name, disp, cf] of [["fo-1", "plantbaked", "plantbaked", "foamy1111"], ["al-1", "alicep", "Alice", "alicecf"], ["bo-1", "bobweb", "Bob", null],
                                      ["sn-1", "sneaky", "sneaky", "sneakcf"], ["re-1", "TriconOG", "Tricon", "tricon"], ["ha-1", "tricon", "tricon", "trlcon"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, disp, cf]);
  }
  await M.init();
  await require(path.join(repo, "blocks")).init();
  // the chat archive's hidden sets loaded (until then every reader fails closed: everyone is "someone", no mention chips)
  await require(path.join(repo, "chatlog")).init();
  await require(path.join(repo, "chatlogview")).init();
  M._setClock(() => T);
  const veiledMember = { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" };
  V.hide(veiledMember, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  R.members = [{ login: "foamy1111", display: "foamy1111" }, veiledMember];
});

test("the say POST's mentions: kept only where '@n' is in the words and n is that person's name; a frog name names nobody", async () => {
  const relay = require(path.join(repo, "bridge-relay"));
  // (mentionRefs is internal: exercise it through the job a say makes - here directly with the same inputs)
  const src = fs.readFileSync(path.join(repo, "bridge-relay.js"), "utf8");
  assert.match(src, /const mn = opts\.mentions \? await mentionRefs\(opts\.mentions, text, R\) : null;/);
  const fn = new Function("require", "clean", src.slice(src.indexOf("async function mentionRefs"), src.indexOf("/** 1.99ajn padppl: why a web command")) + "; return mentionRefs;")(
    (m) => require(path.join(repo, m)), (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n));
  const r = await fn([{ n: "plantbaked", ref: { k: "login", v: "foamy1111" } }, { n: "Soggy Bullfrog", ref: { k: "veil", id: "v-soggy000001" } },
                      { n: "Alice", ref: { k: "login", v: "foamy1111" } },            // a name pinned on someone else: dropped
                      { n: "Bob", ref: { k: "user", v: "bobweb" } }],                   // not in the words: dropped
                     "hi @plantbaked and @Soggy Bullfrog, and @Alice", R);
  assert.deepEqual(r.page, [{ n: "plantbaked", username: "plantbaked", login: "foamy1111", veil: 0 }, { n: "Soggy Bullfrog", username: null, login: null, veil: 1 }]);
  assert.deepEqual(r.ids.map((x) => [x.userId, x.veil]), [["fo-1", false], ["sn-1", true]], "the frog name's account - server-side only");
  assert.ok(relay.challengeBlocked, "(module loads)");
});

test("dress: a line's mn only beside the words that hold it; never for a hidden person; chips in the person's look; .is-mention for the viewer", () => {
  const CV = require(path.join(repo, "chatlogview"));
  const it = { k: "msg", c: 1, ts: T, u: { login: "alicecf", display: "Alice" }, text: "hey @plantbaked", mn: [{ n: "plantbaked", username: "plantbaked", login: "foamy1111", veil: 0, extra: "x" }, { n: "ghost", username: "g", login: "g", veil: 0 }] };
  const [o] = CV.dress([it], { lookup: () => undefined });
  assert.deepEqual(o.mn, [{ n: "plantbaked", username: "plantbaked", login: "foamy1111", veil: 0 }], "the entry not in the words goes, unknown fields go");
  const html = String(CR.renderItem(Object.assign({}, o, { mn: [Object.assign({ style: "color:#0f0" }, o.mn[0])] }), { me: { username: "plantbaked" } }, CR.htmlH));
  assert.match(html, /class="line is-mention"/);
  assert.match(html, /<a class="mention cx-name mention-me" style="color:#0f0" title="@plantbaked · Camfrog: foamy1111" href="\/u\/plantbaked">@plantbaked<\/a>/);
  const plain = String(CR.renderItem(o, { me: { username: "someoneelse" } }, CR.htmlH));
  assert.doesNotMatch(plain, /is-mention/);
  // a removed line keeps no words: no mn either
  const [gone] = CV.dress([Object.assign({}, it, { purged: true })], { lookup: () => undefined });
  assert.equal(gone.mn, undefined);
});

test("alerts: ON by default for a structured mention; never your own line; never from someone blocked either way; the pad mute and the switch", async () => {
  const L = line({ u: { login: "alicecf", display: "Alice", web: true }, text: "@plantbaked look", mn: [{ n: "plantbaked", username: "plantbaked", login: "foamy1111", veil: 0 }] });
  Object.defineProperty(L.it, "_mnIds", { value: [{ userId: "fo-1", login: "foamy1111", veil: false, label: "plantbaked", n: "plantbaked" }] });
  Object.defineProperty(L.it, "_sender", { value: { userId: "al-1", login: "alicecf" } });
  M.onLines([L]); await M._idle();
  let n = await notices("fo-1");
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "💬 Alice mentioned you in Drama Central");
  // her own line names herself: nothing
  M._sent.clear(); T += 120e3;
  const own = line({ u: { login: "foamy1111", display: "plantbaked" }, text: "me @foamy1111" });
  M.onLines([own]); await M._idle();
  assert.equal((await notices("fo-1")).length, 1);
  // blocked (either way): nothing - the bell, push and Telegram all hang off the notice
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('fo-1', 'al-1', 1)");
  require(path.join(repo, "blocks")).changed("fo-1", "al-1");
  M._sent.clear(); T += 120e3;
  const L2 = line({ u: { login: "alicecf", display: "Alice" }, text: "@foamy1111 hello?" });
  M.onLines([L2]); await M._idle();
  assert.equal((await notices("fo-1")).length, 1, "a Camfrog-typed @login from someone she blocked: nothing");
  await runQuery("DELETE FROM dm_blocks");
  require(path.join(repo, "blocks")).changed("fo-1", "al-1");
  // the typed @login alerts the linked account
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { login: "alicecf", display: "Alice" }, text: "@foamy1111 hello" })]); await M._idle();
  n = await notices("fo-1");
  assert.equal(n.length, 2);
  // this pad muted, then the switch off
  await M.setPadMute("fo-1", ROOM, true);
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { login: "alicecf", display: "Alice" }, text: "@foamy1111 again" })]); await M._idle();
  assert.equal((await notices("fo-1")).length, 2, "the pad is muted");
  await M.setPadMute("fo-1", ROOM, false);
  await M.save("fo-1", { enabled: false, chat: false });
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { login: "alicecf", display: "Alice" }, text: "@foamy1111 again" })]); await M._idle();
  assert.equal((await notices("fo-1")).length, 2, "chat mentions off");
  await M.save("fo-1", { enabled: false, chat: true });
  assert.equal((await M.get("fo-1")).prefs.chat, true);
});

test("veils: a frog-named line alerts under the FROG NAME; a mention OF a frog name alerts that person privately; 'someone' / bars never alert", async () => {
  M._sent.clear(); T += 120e3;
  const fl = line({ u: { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" }, text: "hey @alicecf" });
  V.hide(fl.it, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  M.onLines([fl]); await M._idle();
  const a = await notices("al-1");
  assert.equal(a.length, 1);
  assert.equal(a[0].title, "💬 🐸 Soggy Bullfrog mentioned you in Drama Central");
  assert.doesNotMatch(JSON.stringify(a), /sneak/, "never the real name");
  // a mention OF the frog name: sneaky hears of it - "(as 🐸 Soggy Bullfrog)"
  M._sent.clear(); T += 120e3;
  const L = line({ u: { login: "alicecf", display: "Alice", web: true }, text: "@Soggy Bullfrog hi", mn: [{ n: "Soggy Bullfrog", veil: 1 }] });
  Object.defineProperty(L.it, "_mnIds", { value: [{ userId: "sn-1", login: "sneakcf", veil: true, label: "Soggy Bullfrog", n: "Soggy Bullfrog" }] });
  Object.defineProperty(L.it, "_sender", { value: { userId: "al-1", login: "alicecf" } });
  M.onLines([L]); await M._idle();
  const s = await notices("sn-1");
  assert.equal(s.length, 1);
  assert.equal(s[0].title, "💬 Alice mentioned you (as 🐸 Soggy Bullfrog) in Drama Central");
  // "someone" (no frog name) and a hidden bar never alert
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { anon: true, display: "someone" }, text: "@alicecf psst" }), line({ u: { anon: true, display: "someone", veil: "hidden", alias: "X" }, mask: "s", text: "@alicecf" })]);
  await M._idle();
  assert.equal((await notices("al-1")).length, 1);
  // a frog-name block by alice on sneaky: his frog-named lines never alert her
  await runQuery("INSERT INTO veil_blocks (blocker_id, blocked_id, blocked_login, label, room_id, created) VALUES ('al-1', 'sn-1', 'sneakcf', 'Soggy Bullfrog', ?, 1)", [ROOM]);
  M._sent.clear(); T += 120e3;
  const fl2 = line({ u: { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" }, text: "@alicecf again" });
  V.hide(fl2.it, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  M.onLines([fl2]); await M._idle();
  assert.equal((await notices("al-1")).length, 1);
  // 1.99ajw padppl rework: whatever frog name he takes next (another session, another pad) - still silent for her
  M._sent.clear(); T += 120e3;
  const fl3 = Object.assign(line({ u: { anon: true, display: "someone", veil: "incognito", alias: "Leafy Newt", id: "v-leafy0000001" }, text: "@alicecf new frog" }), { roomId: "other_room", slug: "other-room", name: "Other Room" });
  V.hide(fl3.it, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  M.onLines([fl3]); await M._idle();
  assert.equal((await notices("al-1")).length, 1, "a new frog name, another pad: no alert either");
  // (the control: the same line once she unblocks him does alert - so it was the block)
  await runQuery("DELETE FROM veil_blocks WHERE blocker_id = 'al-1'"); require(path.join(repo, "blocks")).changed("al-1");
  M._sent.clear(); T += 120e3;
  const fl4 = Object.assign(line({ u: { anon: true, display: "someone", veil: "incognito", alias: "Leafy Newt", id: "v-leafy0000001" }, text: "@alicecf control" }), { roomId: "other_room", slug: "other-room", name: "Other Room" });
  V.hide(fl4.it, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  M.onLines([fl4]); await M._idle();
  assert.equal((await notices("al-1")).length, 2, "the control alerts");
  await runQuery("INSERT INTO veil_blocks (blocker_id, blocked_id, blocked_login, label, room_id, created) VALUES ('al-1', 'sn-1', 'sneakcf', 'Soggy Bullfrog', ?, 1)", [ROOM]);
  require(path.join(repo, "blocks")).changed("al-1");
});

test("a typed @ that is a PATV name clashing with a Camfrog login never alerts (the tricon case); the real login does", async () => {
  require(path.join(repo, "cfnames"))._reset();
  await require(path.join(repo, "cfnames")).rebuild();
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { login: "alicecf", display: "Alice" }, text: "@tricon hi" })]); await M._idle();
  assert.equal((await notices("ha-1")).length, 0, "the harasser's PATV username: never");
  assert.equal((await notices("re-1")).length, 1, "the Camfrog login tricon: the real Tricon");
});

test("people list: posted in the last hour = act 0 (dimmed, 'ago'), the chat open = act 1; every exclusion runs for the posted path too", async () => {
  W._reset();
  let now = T; W._setClock(() => now);
  require(path.join(repo, "cfnames"))._reset();
  // (the profile-private and incognito reads padweb runs need their tables)
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER, updated INTEGER, reported INTEGER)`);
  W.notePost(ROOM, { userId: "bo-1", username: "bobweb" }, null, now - 23 * 60e3);
  W.note(ROOM, { userId: "al-1", username: "alicep" }, "alicecf");
  const list = await W.forRoom(R, { userId: "fo-1", username: "plantbaked" });
  assert.deepEqual(list.map((e) => [e.display, e.act, e.ago]), [["alicep", 1, undefined], ["bobweb", 0, 23]], "active first, then inactive with its minutes");
  // a block (either way) keeps the posted one off too
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('bo-1', 'fo-1', 1)");
  W._reset(); W._setClock(() => now);
  W.notePost(ROOM, { userId: "bo-1", username: "bobweb" }, null, now - 5 * 60e3);
  assert.deepEqual((await W.forRoom(R, { userId: "fo-1", username: "plantbaked" })).map((e) => e.display), []);
  await runQuery("DELETE FROM dm_blocks");
  // past the hour: gone
  W._reset(); W._setClock(() => now);
  W.notePost(ROOM, { userId: "bo-1", username: "bobweb" }, null, now - 61 * 60e3);
  assert.deepEqual(await W.forRoom(R, { userId: "fo-1", username: "plantbaked" }), []);
  W._setClock(null);
});

// ── 1.99ajn padppl review fixes ──
test("review: a NAMED block never silences a frog-named line's alert (it would say the frog is that suspect); a frog-name block never silences named lines", async () => {
  await runQuery("DELETE FROM veil_blocks");
  // alice blocks the suspect sneaky BY NAME, then 🐸 Soggy Bullfrog (sneaky, veiled) @mentions her: the alert still comes, under the frog name
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('al-1', 'sn-1', 1)");
  require(path.join(repo, "blocks")).changed("al-1", "sn-1");
  M._sent.clear(); T += 120e3;
  const before = (await notices("al-1")).length;
  const fl = line({ u: { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" }, text: "@alicecf hi there" });
  V.hide(fl.it, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  M.onLines([fl]); await M._idle();
  const n = await notices("al-1");
  assert.equal(n.length, before + 1, "a named block of a suspect must not tell her the frog is him");
  assert.match(n[n.length - 1].title, /🐸 Soggy Bullfrog/);
  await runQuery("DELETE FROM dm_blocks");
  require(path.join(repo, "blocks")).changed("al-1", "sn-1");
  // a frog-name block on him: his NAMED line still alerts her (THE VEIL RULE - never his named actions)
  await runQuery("INSERT INTO veil_blocks (blocker_id, blocked_id, blocked_login, label, room_id, created) VALUES ('al-1', 'sn-1', 'sneakcf', 'Soggy Bullfrog', ?, 1)", [ROOM]);
  M._sent.clear(); T += 120e3;
  M.onLines([line({ u: { login: "sneakcf", display: "sneaky" }, text: "@alicecf named now" })]); await M._idle();
  assert.equal((await notices("al-1")).length, before + 2);
  await runQuery("DELETE FROM veil_blocks");
});

test("review: a NAMED line of someone the site keeps hidden never alerts (no name in a notice the pad wouldn't show); a hand-typed @ on a web line alerts", async () => {
  const CL = require(path.join(repo, "chatlog")), CV = require(path.join(repo, "chatlogview"));
  await CL.noteSync({ list: [CL.hash("hiddencf")] });
  assert.equal(CV.isHiddenLogin("hiddencf") || require(path.join(repo, "quotes")).isHidden("hiddencf"), true, "precondition: hiddencf is in the sticky set");
  M._sent.clear(); T += 120e3;
  const before = (await notices("fo-1")).length;
  M.onLines([line({ u: { login: "hiddencf", display: "Hidden Person" }, text: "@foamy1111 psst" })]); await M._idle();
  assert.equal((await notices("fo-1")).length, before, "never '💬 Hidden Person mentioned you'");
  // a web line with no picked mention but a hand-typed "@foamy1111": the bell agrees with the page's highlight
  M._sent.clear(); T += 120e3;
  const L = line({ u: { login: "alicecf", display: "Alice", web: true }, text: "typed by hand @foamy1111" });
  Object.defineProperty(L.it, "_sender", { value: { userId: "al-1", login: "alicecf" } });
  M.onLines([L]); await M._idle();
  assert.equal((await notices("fo-1")).length, before + 1);
  // a PICKED "@Alice Long" never reads as a hand-typed "@Alice" (someone else)
  M._sent.clear(); T += 120e3;
  const L2 = line({ u: { login: "foamy1111", display: "plantbaked", web: true }, text: "@Alice Long hello", mn: [{ n: "Alice Long", username: null, login: null, veil: 1 }] });
  Object.defineProperty(L2.it, "_mnIds", { value: [{ userId: null, login: null, veil: true, label: "Alice Long", n: "Alice Long" }] });
  Object.defineProperty(L2.it, "_sender", { value: { userId: "fo-1", login: "foamy1111" } });
  const ab = (await notices("al-1")).length;
  M.onLines([L2]); await M._idle();
  assert.equal((await notices("al-1")).length, ab, "the blanked pick is not alicep's @Alice");
});

test("review: the people list notes only lines that went out under the person's NAME - never while incognito or hidden", async () => {
  W._reset();
  let now = T; W._setClock(() => now);
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER, updated INTEGER, reported INTEGER)`);
  await runQuery(`INSERT OR REPLACE INTO incognito_state (login, "on", updated) VALUES ('u:bo-1', 1, 1)`);
  assert.equal(await W.notePostNamed(ROOM, { userId: "bo-1", username: "bobweb" }, null, now - 5 * 60e3), false, "incognito when it went out: never noted");
  await runQuery(`DELETE FROM incognito_state`);
  // ...so turning incognito off later never puts a name next to "posted 5 min ago" (and the frog line said then)
  assert.deepEqual(await W.forRoom(R, { userId: "fo-1", username: "plantbaked" }), []);
  assert.equal(await W.notePostNamed(ROOM, { userId: "bo-1", username: "bobweb" }, "hiddencf", now - 4 * 60e3), false, "a hidden login: never");
  assert.equal(await W.notePostNamed(ROOM, { userId: "bo-1", username: "bobweb" }, null, now - 3 * 60e3), true, "named: noted");
  assert.deepEqual((await W.forRoom(R, { userId: "fo-1", username: "plantbaked" })).map((e) => [e.display, e.act]), [["bobweb", 0]]);
  // the relay notes only a NAMED echo (bridge.js says so), never Pepe's ack alone
  const src = fs.readFileSync(path.join(repo, "bridge-relay.js"), "utf8");
  assert.match(src, /function notePosted\(j, named = false\) \{\r?\n\s+if \(!named \|\|/);
  assert.doesNotMatch(src, /if \(a\.ok\) notePosted\(j\)/);
  assert.match(fs.readFileSync(path.join(repo, "bridge.js"), "utf8"), /relay\.noteEcho\(echoOf, it\.c, R\.id, !!\(it\.k === "msg" && it\.u && !it\.u\.anon && !it\.u\.self && !it\.ah && !it\.mask && !it\._vz\)\)/);
  W._setClock(null);
});
