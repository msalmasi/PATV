// privacy controls S0 (G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S0", section 8 = the owner's answers of 2026-11-02):
// fixes that are true today, no switch.
//   * !livecam is on the site's private_args floor (chatlog.PRIVATE_ARGS, the backup copy of Pepe's list): a room-typed
//     "!livecam off" never reaches a pad's live chat or its chat archive, even before Pepe's help sync lands; the privacy
//     policy's never-kept list names it, and that change is dated the first time /privacy shows the list (terms.js TEXT_DATES)
//   NODE_PATH=G:/PATV/node_modules node --test test/privm-s0.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s0-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const UL = require(path.join(repo, "userlinks"));

const DAY = 86400000;
let clockAt = Date.now();
CL._setClock(() => clockAt);

const ALICE = { id: "alice", login: "alice", display: "Alice", on_cam: true, src: "list" };
const BOB = { id: "bob", login: "bob", display: "Bob" };
let seq = 0;
const ev = (room, type, data, id) => ({ op: "event", id: id || "s0-ev-" + (++seq), ts: new Date().toISOString(), type,
                                        scope: { platform: "camfrog", room }, data });
const msg = (room, user, text, extra = {}) => ev(room, "message", { user, text, message_id: "cf-m-" + seq, ...extra });
const snap = (room) => ({ room, members: [ALICE, BOB], mic: [], count: 2, transcripts: true });
const sync = (room, events, extra = {}) => bridge.ingest({ events, rooms: [snap(room)], ...extra });
const logRows = (rid) => getQuery("SELECT l.* FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = ? ORDER BY l.c", [rid]);
const live = async (rid) => { const R = bridge._rooms.get(rid); return R ? (await bridge.liveView(R, 0, null, null, null, true, { viewer: { userId: "test-viewer" } })).feed : []; };

async function archiveOn() {
  if (CL.on("archive")) return;
  if (!CL.on("notice")) await CL.setSwitch("notice", true, "test");
  clockAt = CL.cfg().notice_at + CL.NOTICE_DAYS * DAY + 1000;
  await CL.setSwitch("archive", true, "test");
}

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
  await bridge.load();
  await CL.init();
})();

test("S0: !livecam is on the site's private_args floor (the backup copy of Pepe's list - no help sync needed)", () => {
  assert.ok(CL.PRIVATE_ARGS.includes("!livecam"));
  for (const line of ["!livecam off", "!LIVECAM on", "  !livecam everyone", "!livecam ask off", "!livecam"]) assert.equal(CL.isPrivateCmd(line), true, line);
  assert.equal(CL.isPrivateCmd("!livecams off"), false, "the whole first word only");
  assert.equal(CL.isPrivateCmd("my !livecam is off"), false, "only a line that starts with it");
  assert.equal(CL.isPrivateCmd("!camok bob"), false, "the cam card's other commands are unchanged");
  // the floor is the same set as the bot's (camfrog-bot pepe_privargs.BUILTIN) when its checkout is next to the site
  const bot = process.env.PEPE_BOT_DIR ? path.join(process.env.PEPE_BOT_DIR, "pepe_privargs.py") : null;
  if (bot && fs.existsSync(bot)) {
    const src = fs.readFileSync(bot, "utf8");
    const m = src.match(/PRIVACY_CMDS = frozenset\(\{([^}]*)\}\)/);
    assert.ok(m && /"!livecam"/.test(m[1]), "Pepe's PRIVACY_CMDS has !livecam too");
    const b = src.match(/BUILTIN = frozenset\(\{([\s\S]*?)\}\)/);
    const botSet = new Set([...(b[1] + m[1]).matchAll(/"(![a-z0-9_]+)"/g)].map((x) => x[1]));
    assert.deepEqual([...botSet].sort(), [...CL.PRIVATE_ARGS].sort(), "the two floors agree");
  }
});

test("S0: a room-typed !livecam never reaches the pad's live chat or its archive; other lines do", async () => {
  await setup;
  const room = { id: "Cam.Room", name: "Cam Room" };
  await archiveOn();
  await sync(room, [msg(room, ALICE, "!livecam off"), msg(room, ALICE, "  !LiveCam followers"), msg(room, ALICE, "!livecam ask off"),
                    msg(room, BOB, "🌐 Bob (web): !livecam on", { user: { ...BOB, is_self: true } }),
                    msg(room, ALICE, "my !livecam is off now"), msg(room, BOB, "hello")]);
  const texts = (await live("Cam.Room")).map((it) => it.text);
  assert.deepEqual(texts, ["my !livecam is off now", "hello"], "the live feed");
  assert.deepEqual((await logRows("Cam.Room")).map((r) => r.text), ["my !livecam is off now", "hello"], "the archive");
});

test("S0: the policy's never-kept list names !livecam; the change is dated only once the list is on the page (terms.js)", async () => {
  await setup;
  const src = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8");
  const m = src.match(/neither are the commands that carry private text or codes \(([\s\S]*?)\.\s/);
  assert.ok(m && /<code>!livecam<\/code>/.test(m[1]), "the never-kept list names it");
  const terms = require(path.join(repo, "terms"));
  assert.ok(terms.TEXT_DATES.includes("livecam-never-kept"));
  // the list shows only while the chat archive's notice is on (chatlog.policy): no date while it's off
  const was = CL.on("notice");
  if (was) {
    // (the archive test above turned it on: the date is recorded from then)
    const d = (await terms.textDates())["livecam-never-kept"];
    assert.ok(d && d.at > 0 && d.day, "recorded the first time it is served with the list showing");
  }
  const ejs = require("ejs");
  const page = await ejs.renderFile(path.join(repo, "views", "privacy.ejs"), {
    user: null, title: "Privacy Policy", VERSION: terms.VERSION, UPDATED: terms.PRIVACY_UPDATED, enforced: false,
    chatlog: await CL.policy(), hubErasure: null, micrec: null, memory: null, privwire: null, evidence: null,
    policyDates: await terms.textDates() });
  const day = (await terms.textDates())["livecam-never-kept"].day;
  assert.ok(page.includes(`<li><b>${day}:</b> <a href="#chat-history">Chat history on pads</a> (section 3): <code>!livecam</code>, your live-cam setting, is now one of the privacy settings a pad's chat never shows or keeps.</li>`),
            "a dated change note");
  // without the chat-history section on the page there is no change note (it would point at nothing)
  const bare = await ejs.renderFile(path.join(repo, "views", "privacy.ejs"), {
    user: null, title: "Privacy Policy", VERSION: terms.VERSION, UPDATED: terms.PRIVACY_UPDATED, enforced: false,
    chatlog: null, hubErasure: null, micrec: null, memory: null, privwire: null, evidence: null, policyDates: await terms.textDates() });
  assert.ok(!bare.includes("is now one of the privacy settings a pad's chat never shows or keeps"));
});

test("S0: livecam-never-kept is not dated while the archive notice is off", async () => {
  // a fresh table: the switched text is recorded only while chatlog.cfg() says the notice is on
  const terms = require(path.join(repo, "terms"));
  await terms.textDates();
  await runQuery("DELETE FROM policy_text_dates WHERE key = 'livecam-never-kept'");
  const realCfg = CL.cfg;
  CL.cfg = () => ({ ...realCfg(), notice: false, notice_at: null });
  try {
    assert.equal((await terms.textDates())["livecam-never-kept"], undefined, "not dated while nobody can read it");
  } finally { CL.cfg = realCfg; }
  assert.ok((await terms.textDates())["livecam-never-kept"], "dated once the notice is on");
});

// S0 check (spec section 5 S0 "tx_off count: Pepe 1, site sticky tx set 0 - find why before S1 ships"): there is no mismatch. The
// spec's site count read chatlog_hidden's scopes for "tx" - a reason that table never holds (its reasons are bridge / incognito /
// list_b / list_i / web / forget / delete / staff / of:<h>). !transcripts off has its own sticky table, chatlog_tx_hidden (Pepe's
// tx_hidden_h list on every sync, add-only, and privacy.hidden / privacy.shown {scope: tx}); a read-only prod count on 2026-11-02
// found 1 row there, src "pepe" = Pepe's 1. These pin that, so a count (or txbar, S1) reads the right table.
test("S0 check: !transcripts off lands in chatlog_tx_hidden (the sticky tx set), never as a chatlog_hidden scope", async () => {
  await setup;
  const h1 = CL.hash("txlist_person"), h2 = CL.hash("txevent_person");
  await CL.noteSync({ txList: [h1] });                                                    // Pepe's tx_hidden_h, on every sync
  await CL.noteSync({ events: [{ type: "privacy.hidden", ts: new Date().toISOString(), data: { h: h2, scope: "tx" } }] });   // his !transcripts off event
  const tx = (await getQuery("SELECT h, src FROM chatlog_tx_hidden WHERE h IN (?, ?) ORDER BY h", [h1, h2])).map((r) => ({ ...r }));
  assert.deepEqual(tx, [{ h: h1, src: "pepe" }, { h: h2, src: "pepe" }].sort((a, b) => (a.h < b.h ? -1 : 1)), "both in the tx table, src pepe");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_hidden WHERE h IN (?, ?)", [h1, h2]))[0].n, 0, "never a chatlog_hidden row");
  assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM chatlog_hidden WHERE scopes LIKE '%"tx"%'`))[0].n, 0, "the spec's query can only ever count 0");
  assert.equal(CL.isTxHiddenHash(h1) && CL.isTxHiddenHash(h2), true);
  assert.equal(CL.isHiddenHash(h1) || CL.isHiddenHash(h2), false, "transcripts off alone hides no name");
  assert.ok(CL.hiddenCount().tx >= 2, "the admin count (/admin/bridge) reads the tx table");
});
