// S1 V4 - the privacy UI (S1 plan §2.5 V4; ADR 0007 D16, OQ-20; CHAT-ARCHITECTURE rev 5.1 §9.4): account deletion's
// "Also remove my public messages".
//   * offered only while the chat hub's `erasure` switch is on (the page's checkbox and its copy, the privacy page's paragraph,
//     the request); refused while off (E_REMOVE_OFF); unticked by default; at most once a day (E_REMOVE_DAILY - a request that a
//     sign-in cancelled counts too);
//   * the flag reaches privacy/account-deleted (remove_public: true) - the feed row and the snapshot's;
//   * the shared cross-store rule (one checkbox, both stores, the same exceptions): the hub row carries the choice and the pad chat
//     archive's web lines of the account (u:<id>, its incognito h:<hash> lines and - linked - its web lines under the Camfrog login,
//     up to the deletion) are purged after the commit, except a line under a legal hold (its room or its speaker) or a report
//     within ADR 0007 D10's bounds - taken down at once (its copies and the live feed with it), kept, its words deleted by the
//     nightly pass once that ends; a line already down then (a "minor" report's, a moderator's hide) becomes the author's removal,
//     so a dismissed report or an un-hide can't bring it back; other people's lines and the login's Camfrog and incognito lines
//     are untouched; Pepe's removed_who learns it;
//   * nothing is purged for a deletion that rolls back; a crash between the commit and the purge is healed by the tick (done rows
//     only, with the login the row kept for it); two requests at once can't both be scheduled;
//   * the routes (GET renders the box, POST stores a strict true), the delete page's and the privacy page's copy, and the page's
//     date (a save of every switch doesn't move it).
// The hub half of the cross-store rule is the contract suite's scenario 5b (the hub repo, services/rooms/test/
// seam-contract.integration.test.ts, run with PATV_V1_DIR = this checkout: tools/hubseam-driver.js chatLines / chatLog).
//   NODE_PATH=G:/PATV/node_modules node --test test/account-delete-remove-public.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctdel-rp-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.CHAT_GENESIS_NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT", "text_style TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  // review 2: switch rows from before hubseam_settings.first_on (huboutbox.init adds the column; an ON row is dated by its last
  // change, an OFF row has none) - keys no switch reads
  await run("INSERT INTO hubseam_settings (key, value, updated) VALUES ('rp_legacy_on', 'true', 1234), ('rp_legacy_off', 'false', 5678)");
  await new Promise((r) => db.close(r));
})();

const DAY = 86400000;
let clockAt = Date.UTC(2026, 9, 21, 12);
const bcrypt = require("bcrypt");
let D, S, HO, CL, CLM, runQuery, getQuery, tx;

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery, tx } = require(path.join(repo, "dbUtils")));
  D = require(path.join(repo, "accountdelete"));
  S = require(path.join(repo, "sessions"));
  HO = require(path.join(repo, "huboutbox"));
  CL = require(path.join(repo, "chatlog"));
  CLM = require(path.join(repo, "chatlogmod"));
  D._setClock(() => clockAt);
  S._setClock(() => clockAt);
  CL._setClock(() => clockAt);
  await D.init();
  await S.init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
  await HO.init();
  await CL.init();
  await CLM.init();
})());

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`,
                 [id, o.username || id, o.display || id, `${id}@example.com`, o.password || "x", o.class || "pleb", o.cf || null]);
}
const reqOf = (uid, sid = null) => ({ user: { userId: uid }, loginSession: sid ? { id: sid, userId: uid } : null });
const erasure = (on) => HO.setSettings({ erasure: on });
async function signedUp(id, username) {
  await user(id, { username, password: await bcrypt.hash("pw-" + id + "-1234", 4) });
  return { pw: "pw-" + id + "-1234" };
}

// the pad chat archive: rooms and lines as the bridge archives them (chatlog.rowOf)
let nextC = 1000;
async function rk(roomId) {
  await runQuery("INSERT INTO chatlog_rooms (room_id, owner_since, created) VALUES (?, 0, ?) ON CONFLICT(room_id) DO NOTHING", [roomId, 1]);
  return Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [roomId]))[0].rk);
}
/** A line in roomId: web (u:<id>), incognito (h:<hash of the key>), a Camfrog login's, or (web: true) a linked member's web line
 *  under their login, as bridge.js jobSender archives it. -> c */
async function line(roomId, text, who, { ts = clockAt - 3600e3 } = {}) {
  const k = await rk(roomId);
  const c = ++nextC;
  const it = { c, ts, k: "msg", text };
  if (who.incognito) Object.assign(it, { u: { display: "someone", anon: true }, ah: CL.hash(who.incognito) });
  else it.u = { login: who.key, display: who.display || "Someone Named", web: who.web || String(who.key).startsWith("u:") || undefined };
  const r = CL.rowOf({ it }, k, "p");
  await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [r.c, r.rk, r.ts, r.k, r.who, r.text, r.rt, r.aud, r.d]);
  return c;
}
const row = async (c) => (await getQuery("SELECT * FROM chat_log WHERE c = ?", [c]))[0];
const report = async (c, { created = clockAt, state = "open", decided = null, reason = "harassment" } = {}) =>
  runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created, decided_at) VALUES (?, (SELECT rk FROM chat_log WHERE c = ?), NULL, ?, NULL, ?, ?, ?)",
           [c, c, reason, state, created, decided]);
const hubRows = async (userId) => (await getQuery("SELECT payload FROM hub_outbox WHERE topic = 'privacy/account-deleted' AND entity = ? ORDER BY id", ["acct:" + userId])).map((r) => JSON.parse(r.payload));

test("offered only while the hub's erasure switch is on; refused while off; the choice waits with the request; at most once a day (a cancelled request counts)", async () => {
  await setup();
  await erasure(false);
  try {
    assert.equal(D.removeOffered(), false, "off by default");
    const a = await signedUp("rpa", "rpalpha");
    await assert.rejects(D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha", removePublic: true }), (e) => e.code === "E_REMOVE_OFF" && e.status === 409);
    assert.equal(await D.pendingOf("rpa"), null, "nothing scheduled");
    await erasure(true);
    assert.equal(D.removeOffered(), true);
    // unticked: nothing stored, no limit used
    await D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha" });
    assert.equal((await D.pendingOf("rpa")).remove_public, null);
    assert.equal(await D.removeWaitUntil("rpa"), null);
    // a sign-in cancels it; asking again with the choice works (no earlier request carried it)
    await D.cancelOnSignIn("rpa", "password");
    const r = await D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha", removePublic: true, hideLines: true });
    assert.equal(r.ok, true);
    const p = await D.pendingOf("rpa");
    assert.equal(p.remove_public, 1, "the choice waits with the request (signing in during the grace cancels both)");
    assert.equal(p.hide_lines, 1, "independent of CL6's hide box");
    // cancelled again: the same day, the choice is refused (once a day), the deletion without it is not
    await D.cancelOnSignIn("rpa", "plex");
    clockAt += 3600e3;
    await assert.rejects(D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha", removePublic: true }),
                         (e) => e.code === "E_REMOVE_DAILY" && e.status === 429 && e.retry_at === p.requested_at + D.REMOVE_EVERY_MS && /once a day/.test(e.message));
    assert.equal(await D.removeWaitUntil("rpa"), p.requested_at + DAY);
    await D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha" });
    await D.cancelOnSignIn("rpa", "plex");
    // a day after the request that carried it: allowed again
    clockAt = p.requested_at + DAY;
    assert.equal(await D.removeWaitUntil("rpa"), null);
    assert.equal((await D.request(reqOf("rpa"), { password: a.pw, confirm: "rpalpha", removePublic: true })).ok, true);
    await D.cancelOnSignIn("rpa", "plex");
  } finally {
    await erasure(false);
  }
});

test("the flag reaches privacy/account-deleted: remove_public true with the choice (the feed row and the snapshot's), false without", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rpf", { username: "rpflag" });
    await user("rpn", { username: "rpnone" });
    await D.schedule({ userId: "rpf", username: "rpflag" }, { by: "self", reauth: "password", removePublic: true });
    await D.schedule({ userId: "rpn", username: "rpnone" }, { by: "self", reauth: "password" });
    assert.equal((await D.execute("rpf", { force: true })).state, "done");
    assert.equal((await D.execute("rpn", { force: true })).state, "done");
    const [f] = await hubRows("rpf");
    const [n] = await hubRows("rpn");
    assert.equal(f.remove_public, true);
    assert.equal(n.remove_public, false);
    assert.deepEqual(Object.keys(f).sort(), ["acct", "at", "pseudonym", "remove_public", "request", "v1_user"], "the payload's shape is unchanged (seam plan §2.3)");
    // the snapshot repair sends the same choice (huboutbox's reader selects the column)
    const page = await HO.snapshot("privacy/account-deleted", null, { limit: 500 });
    const byUser = Object.fromEntries(page.rows.map((r) => [r.payload.v1_user, r.payload.remove_public]));
    assert.equal(byUser.rpf, true);
    assert.equal(byUser.rpn, false);
    assert.equal(D.hubRow({ id: 1, user_id: "x", remove_public: null }).remove_public, false, "an older row (no column value) says false");
  } finally {
    await erasure(false);
  }
});

test("one checkbox, both stores, the same exceptions: the hub row carries it; the archive's web lines are purged after the commit, held / reported ones taken down and kept until that ends", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rpx", { username: "rpcross", display: "Cross Person", cf: "CrossCF" });
    await user("rpo", { username: "rpother", display: "Other Person" });
    const me = { key: "u:rpx", display: "Cross Person" };            // web lines from before the account linked its login
    const plain = await line("Rp.Room", "my plain web line", me);
    const plain2 = await line("Rp.Other", "another web line of mine", me);
    const incog = await line("Rp.Room", "said while incognito", { incognito: "u:rpx" });
    const reported = await line("Rp.Room", "a reported web line", me);
    const heldRoom = await line("Rp.Held", "a line in a room under a legal hold", me);
    const cfLine = await line("Rp.Room", "said in Camfrog under the login", { key: "crosscf", display: "CrossCF" });
    // review fix: a linked member's web line is archived under the LOGIN, marked web (bridge.js jobSender) - theirs to remove; the
    // login's incognito line can't be told from its Camfrog ones (no web mark on an anonymised line) and stays, like a web line
    // under the login after the deletion (whoever links the released login next)
    const cfWeb = await line("Rp.Room", "sent from the website as CrossCF", { key: "crosscf", display: "CrossCF", web: true });
    const cfIncog = await line("Rp.Room", "said incognito under the login", { incognito: "crosscf" });
    const later = await line("Rp.Room", "a later holder's web line", { key: "crosscf", display: "CrossCF", web: true }, { ts: clockAt + 60e3 });
    const theirs = await line("Rp.Room", "someone else's web line", { key: "u:rpo", display: "Other Person" });
    await report(reported);
    await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'a court order', ?)", ["room:" + (await rk("Rp.Held")), clockAt]);
    await CLM.loadHolds();
    // the kept line's copies: its live-feed row and a mention notice quoting it go with its takedown
    await runQuery("INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, 'Rp.Room', ?, '{}')", [reported, clockAt]);
    await runQuery("INSERT INTO inbox (user_id, kind, title, body, created, ref) VALUES ('rpo', 'mention', 'Cross: a reported web line', 'a reported web line', ?, ?)",
                   [clockAt, `mention:Rp.Room:${reported}`]);
    await D.schedule({ userId: "rpx", username: "rpcross" }, { by: "self", reauth: "password", removePublic: true });
    const B = require(path.join(repo, "bridge"));
    const takeDown = B.takeDown, drops = [];
    B.takeDown = async (roomId, cs, o) => { drops.push([roomId, [].concat(cs).map(Number), !!(o && o.db)]); return 0; };
    let r;
    try { r = await D.execute("rpx", { force: true }); } finally { B.takeDown = takeDown; }
    assert.equal(r.state, "done");
    assert.ok(drops.some(([room, cs, db]) => room === "Rp.Room" && cs.includes(reported) && db === false), "the kept line leaves the live feed at once");
    assert.equal((await getQuery("SELECT 1 FROM bridge_feed WHERE c = ?", [reported])).length, 0, "and bridge_feed, in the takedown's transaction");
    const note = (await getQuery("SELECT title, body FROM inbox WHERE ref = ?", [`mention:Rp.Room:${reported}`]))[0];
    assert.deepEqual([note.title, note.body], ["💬 A chat line that mentioned you was removed", null], "the mention notice keeps no words");
    // the hub: the same choice
    assert.equal((await hubRows("rpx"))[0].remove_public, true);
    // the archive: purged at once - text, name, key (one-way hash only), FTS - by its author
    for (const c of [plain, plain2, incog, cfWeb]) {
      const x = await row(c);
      assert.equal(x.text, null, "words gone: " + c);
      assert.equal(x.purged, 1);
      assert.equal(x.rm_by, "self");
      assert.ok(String(x.who).startsWith("h:"), "the account key replaced by its hash");
      assert.equal(JSON.stringify(JSON.parse(x.d).u || {}), "{}", "no name left");
    }
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log_fts WHERE chat_log_fts MATCH '\"plain\"'"))[0].n, 0, "out of search");
    // the exceptions: taken down now (out of every view), words kept for the report / the hold
    for (const c of [reported, heldRoom]) {
      const x = await row(c);
      assert.ok(x.text, "kept: " + c);
      assert.equal(x.purged, null);
      assert.ok(x.rm_at != null, "taken down at once");
      assert.equal(x.rm_by, "self");
      assert.equal(JSON.parse(x.d).u.display, "", "still nameless (former member), as every deleted account's web line");
    }
    // untouched: someone else's web line, and the line under the (released) Camfrog login - that is "Also hide my past public chat lines"
    assert.equal((await row(theirs)).text, "someone else's web line");
    assert.equal((await row(theirs)).rm_at, null);
    assert.equal((await row(cfLine)).text, "said in Camfrog under the login");
    assert.equal((await row(cfLine)).rm_at, null);
    for (const c of [cfIncog, later]) { const x = await row(c); assert.ok(x.text && x.rm_at == null && x.purged == null, "the login's: " + c); }
    // the record: counts only, done; the released login no longer on the row
    const d = (await getQuery("SELECT report, public_done_at, public_login, public_windows FROM account_deletions WHERE user_id = 'rpx'"))[0];
    assert.equal(d.public_done_at, clockAt);
    assert.equal(d.public_login, null);
    assert.equal(d.public_windows, null, "review 2: the logins' spans leave the row with it");
    assert.deepEqual(JSON.parse(d.report).public_removed, { lines: 4, held: 2 });
    assert.deepEqual(r.report.public_removed, { lines: 4, held: 2 });
    assert.ok(!d.report.includes("plain") && !d.report.includes("Cross"), "no words, no name in the record");
    // Pepe's !log / !search skip every line of theirs up to now (the account key's hash)
    const who = new Map(await CLM.removedWho());
    assert.ok(who.has(CL.hash("u:rpx")), "removed_who");
    // the nightly pass: the report still open (filed now: D10 holds it 90 days undecided), the hold still on -> kept; once both
    // end -> deleted
    let n = await CLM.nightly({ t: clockAt + 31 * DAY });
    assert.ok((await row(reported)).text && (await row(heldRoom)).text, "kept while the report is open / the hold is on");
    assert.equal(n.skipped_reported >= 1 && n.skipped_held >= 1, true);
    assert.ok(n.erase_waiting >= 2);
    await runQuery("UPDATE chatlog_reports SET state = 'dismissed', decided_at = ? WHERE c = ?", [clockAt, reported]);
    await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + (await rk("Rp.Held"))]);
    await CLM.loadHolds();
    n = await CLM.nightly({ t: clockAt + 31 * DAY });
    for (const c of [reported, heldRoom]) assert.equal((await row(c)).text, null, "deleted once it ended: " + c);
    assert.ok(n.erased >= 2);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_erase_wait WHERE c IN (?, ?)", [reported, heldRoom]))[0].n, 0, "off the list");
    // running it again changes nothing
    assert.deepEqual(await CLM.removeAccountLines("rpx"), { purged: 0, held: 0, reported: 0 });
  } finally {
    await erasure(false);
  }
});

test("a legal hold on the person (who:) keeps their lines too; nothing is purged for a deletion that rolls back; the tick heals a crash between the commit and the purge", async () => {
  await setup();
  await erasure(true);
  try {
    // a hold on the account key: its lines (and its incognito ones) are kept, taken down
    await user("rph", { username: "rpheld" });
    const h1 = await line("Rp.Room", "held person's line", { key: "u:rph", display: "Held" });
    const h2 = await line("Rp.Room", "held person's incognito line", { incognito: "u:rph" });
    await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:u:rph', 'staff', 'a safety case', ?)", [clockAt]);
    await CLM.loadHolds();
    await D.schedule({ userId: "rph", username: "rpheld" }, { removePublic: true });
    await D.execute("rph", { force: true });
    for (const c of [h1, h2]) { const x = await row(c); assert.ok(x.text); assert.ok(x.rm_at != null); }
    assert.deepEqual(JSON.parse((await getQuery("SELECT report FROM account_deletions WHERE user_id = 'rph'"))[0].report).public_removed, { lines: 0, held: 2 });
    await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:u:rph'");
    await CLM.loadHolds();

    // a deletion whose transaction fails: no purge (the member can still sign in and cancel)
    await user("rpr", { username: "rproll", cf: "RollCF" });
    const r1 = await line("Rp.Room", "rolled back line", { key: "u:rpr" });
    const r2 = await line("Rp.Room", "rolled back web line as RollCF", { key: "rollcf", display: "RollCF", web: true });
    await D.schedule({ userId: "rpr", username: "rproll" }, { removePublic: true });
    const emit = HO.emit;
    HO.emit = async (...a) => { await emit(...a); throw new Error("boom"); };
    try { await assert.rejects(D.execute("rpr", { force: true }), /boom/); } finally { HO.emit = emit; }
    assert.equal((await row(r1)).text, "rolled back line", "nothing purged");
    assert.equal((await row(r2)).text, "rolled back web line as RollCF");
    assert.equal((await D.pendingOf("rpr")).state, "scheduled");
    assert.equal((await hubRows("rpr")).length, 0);

    // review fix (M17): the tick's retry is for DONE deletions only - a scheduled request's lines (a sign-in may still cancel it)
    // and a cancelled one's are never purged by it
    await user("rpq", { username: "rpqueued" });
    await user("rpz", { username: "rpcancel" });
    const q1 = await line("Rp.Room", "a scheduled member's line", { key: "u:rpq" });
    const z1 = await line("Rp.Room", "a cancelled member's line", { key: "u:rpz" });
    await D.schedule({ userId: "rpq", username: "rpqueued" }, { removePublic: true });
    await D.schedule({ userId: "rpz", username: "rpcancel" }, { removePublic: true });
    await D.cancelOnSignIn("rpz", "password");
    assert.equal(await D.retryRemovePublic(), 0);
    assert.equal((await row(q1)).text, "a scheduled member's line");
    assert.equal((await row(z1)).text, "a cancelled member's line");

    // the archive part failing after the commit (a crash, an error): the deletion is done, public_done_at waits; the tick runs it
    const real = CLM.removeAccountLines;
    CLM.removeAccountLines = async () => { throw new Error("disk full"); };
    const errs = [];
    const ce = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try { assert.equal((await D.execute("rpr", { force: true })).state, "done"); } finally { CLM.removeAccountLines = real; console.error = ce; }
    assert.ok(errs.some((e) => e.startsWith("[acctdel] remove public lines:")), "logged (no ids, no words)");
    assert.ok(errs.every((e) => !e.includes("rolled back line")));
    const waiting = (await getQuery("SELECT public_done_at, public_login, public_windows, done_at FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0];
    assert.equal(waiting.public_done_at, null);
    assert.deepEqual(JSON.parse(waiting.public_windows), [{ login: "rollcf", from: 0, to: Number(waiting.done_at) }],
                     "the released login waits on the row for the retry (its web lines are under it), with its span (review 2: no history - from the start)");
    assert.equal(waiting.public_login, null, "(review 2: public_windows instead)");
    assert.equal((await row(r1)).text, "rolled back line");
    assert.equal((await hubRows("rpr"))[0].remove_public, true, "the hub has its part already");
    assert.ok(!JSON.stringify((await hubRows("rpr"))[0]).includes("rollcf"), "the hub row never names the login");
    await D.tick();
    assert.equal((await row(r1)).text, null, "the tick ran it");
    assert.equal((await row(r2)).text, null, "with the login the row kept");
    const done = (await getQuery("SELECT public_done_at, public_login, public_windows FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0];
    assert.ok(done.public_done_at > 0);
    assert.deepEqual([done.public_login, done.public_windows], [null, null], "and then the row forgets it");
    assert.equal(await D.retryRemovePublic(), 0, "and only once");
    assert.equal((await row(q1)).text, "a scheduled member's line", "the tick left the scheduled request's lines alone");
    await D.cancelOnSignIn("rpq", "password");
  } finally {
    await erasure(false);
  }
});

test("review fix: a kept line that was already down becomes the author's removal - a dismissed \"minor\" report doesn't bring it back, nor can a moderator's hide be undone", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rpm", { username: "rpminor" });
    await user("rpstaff", { username: "rpstaff", class: "Staff" });
    const t0 = clockAt;
    // a "minor" report hid it already (chatlogmod.report: rm_by report:minor), the report still open
    const minor = await line("Rp.Room", "words the member wants removed", { key: "u:rpm" });
    await report(minor, { reason: "minor" });
    await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'report:minor' WHERE c = ?", [t0 - 60e3, minor]);
    // a moderator hid it already, in a room under a legal hold
    const modHid = await line("Rp.Held2", "a line a moderator hid", { key: "u:rpm" });
    await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:someone', rm_why = 'spam' WHERE c = ?", [t0 - 60e3, modHid]);
    await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'a court order', ?)", ["room:" + (await rk("Rp.Held2")), t0]);
    await CLM.loadHolds();
    await D.schedule({ userId: "rpm", username: "rpminor" }, { removePublic: true });
    assert.equal((await D.execute("rpm", { force: true })).state, "done");
    for (const c of [minor, modHid]) {
      const x = await row(c);
      assert.ok(x.text, "kept for the report / the hold: " + c);
      assert.deepEqual([x.rm_by, x.rm_why, Number(x.rm_at)], ["self", null, t0 - 60e3], "the author's removal now (unhide refuses it), still down since then");
    }
    // the admins dismiss the minor report: a "report:minor" hide would be lifted - this one is the author's, so it stays down
    const res = await CLM.reportDecide({ userId: "rpstaff" }, minor, { action: "dismiss", tell: false });
    assert.equal(res.state, "dismissed");
    const after = await row(minor);
    assert.ok(after.rm_at != null, "still down after the dismissal");
    assert.equal(after.rm_by, "self");
    // its words go once D10's bound after the decision is up (30 days), not earlier - the 30-day pass doesn't take it first
    let n = await CLM.nightly({ t: t0 + 29 * DAY });
    assert.ok((await row(minor)).text, "kept until 30 days after the decision");
    n = await CLM.nightly({ t: t0 + 31 * DAY });
    assert.equal((await row(minor)).text, null, "then deleted");
    assert.equal((await row(minor)).purged, 1);
    assert.ok((await row(modHid)).text, "the hold still keeps the other");
    await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + (await rk("Rp.Held2"))]);
    await CLM.loadHolds();
    n = await CLM.nightly({ t: t0 + 32 * DAY });
    assert.equal((await row(modHid)).text, null, "deleted once the hold ended");
    assert.ok(n.erased >= 1);
  } finally {
    await erasure(false);
  }
});

test("review fix: ADR 0007 D10's report bounds - a report holds a line until 30 days after its decision, or 90 days after it was filed while undecided; a report filed after the removal doesn't hold it", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rpd", { username: "rpdten" });
    const t0 = clockAt;
    const me = { key: "u:rpd" };
    const undecided = await line("Rp.Room", "reported, nobody decides", me);
    await report(undecided, { created: t0 - 10 * DAY });                                          // holds until t0 + 80 days
    const decidedLater = await line("Rp.Room", "reported, decided after the removal", me);
    await report(decidedLater, { created: t0 - DAY });
    const recentDecision = await line("Rp.Room", "decided 10 days before", me);
    await report(recentDecision, { created: t0 - 12 * DAY, state: "dismissed", decided: t0 - 10 * DAY });   // until t0 + 20 days
    const oldDecision = await line("Rp.Room", "decided 40 days before", me);
    await report(oldDecision, { created: t0 - 45 * DAY, state: "actioned", decided: t0 - 40 * DAY });     // no longer holds
    const lateDecision = await line("Rp.Room", "decided after its 90 days", me);
    await report(lateDecision, { created: t0 - 100 * DAY, state: "dismissed", decided: t0 - DAY });       // released at filed + 90
    const holdOnly = await line("Rp.Held3", "kept for a hold, reported afterwards", me);
    await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'a court order', ?)", ["room:" + (await rk("Rp.Held3")), t0]);
    await CLM.loadHolds();
    await D.schedule({ userId: "rpd", username: "rpdten" }, { removePublic: true });
    const r = await D.execute("rpd", { force: true });
    assert.deepEqual(r.report.public_removed, { lines: 2, held: 4 }, "the old and the late decisions hold nothing: purged at once");
    for (const c of [oldDecision, lateDecision]) assert.equal((await row(c)).text, null, "purged: " + c);
    for (const c of [undecided, decidedLater, recentDecision, holdOnly]) assert.ok((await row(c)).text, "kept: " + c);
    // the bounds, as the hub's rooms._report_hold_until
    assert.equal(CLM.reportHoldUntil({ state: "open", created: 0 }), 90 * DAY);
    assert.equal(CLM.reportHoldUntil({ state: "dismissed", created: 0, decided_at: 5 * DAY }), 35 * DAY);
    assert.equal(CLM.reportHoldUntil({ state: "false", created: 0, decided_at: 95 * DAY }), 90 * DAY, "a decision after the 90 days doesn't hold it again");
    // decided 5 days after the removal: held until 35 days after it
    await runQuery("UPDATE chatlog_reports SET state = 'dismissed', decided_at = ? WHERE c = ?", [t0 + 5 * DAY, decidedLater]);
    // a report filed AFTER the removal on the held line, then the hold ends: the late report doesn't keep it
    await report(holdOnly, { created: t0 + DAY });
    await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + (await rk("Rp.Held3"))]);
    await CLM.loadHolds();
    await CLM.nightly({ t: t0 + 2 * DAY });
    assert.equal((await row(holdOnly)).text, null, "the hold ended; a report filed after the removal doesn't hold it");
    await CLM.nightly({ t: t0 + 21 * DAY });
    assert.equal((await row(recentDecision)).text, null, "30 days after its decision");
    await CLM.nightly({ t: t0 + 34 * DAY });
    assert.ok((await row(decidedLater)).text, "the 30-day pass doesn't take it before D10's bound (rm_at is 34 days old)");
    await CLM.nightly({ t: t0 + 36 * DAY });
    assert.equal((await row(decidedLater)).text, null, "35 days after the removal = 30 after the decision");
    await CLM.nightly({ t: t0 + 79 * DAY });
    assert.ok((await row(undecided)).text, "undecided: held 90 days after it was filed");
    await CLM.nightly({ t: t0 + 81 * DAY });
    const u = await row(undecided);
    assert.deepEqual([u.text, u.purged, u.rm_by], [null, 1, "self"], "then released: its words deleted");
    assert.equal((await getQuery("SELECT state FROM chatlog_reports WHERE c = ?", [undecided]))[0].state, "open", "the report itself stays open");
  } finally {
    await erasure(false);
  }
});

test("review fix: two requests at once can't both be scheduled, nor both carry the once-a-day choice", async () => {
  await setup();
  await erasure(true);
  try {
    const a = await signedUp("rpt", "rptwice");
    const ask = () => D.request(reqOf("rpt"), { password: a.pw, confirm: "rptwice", removePublic: true });
    const rs = await Promise.allSettled([ask(), ask()]);
    assert.equal(rs.filter((x) => x.status === "fulfilled").length, 1, "one is scheduled");
    const refused = rs.find((x) => x.status === "rejected");
    assert.ok(refused && ["E_PENDING", "E_REMOVE_DAILY"].includes(refused.reason.code), refused && refused.reason.message);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM account_deletions WHERE user_id = 'rpt'"))[0].n, 1);
    await D.cancelOnSignIn("rpt", "password");
  } finally {
    await erasure(false);
  }
});

test("the delete page: the checkbox and its copy only while erasure is on, unticked, disabled with the date while the day isn't up; the page script sends it", async () => {
  await setup();
  const ejs = require("ejs");
  const render = (removePublic) => ejs.renderFile(path.join(repo, "views", "accountDelete.ejs"), {
    user: "pagey", username: "pagey", block: [], settle: [], elevated: false, hasPassword: true, fresh: false, graceDays: 14, pending: null, removePublic });
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const off = await render(null);
  assert.doesNotMatch(off, /delRemovePublic/);
  assert.ok(!off.includes(en["acctdel.remove_public"]) && !off.includes("PATV chat"), "no copy while erasure is off");
  assert.match(off, /id="delHideLines"/, "CL6's box stays");
  const on = await render({ wait: null });
  assert.match(on, /<input type="checkbox" id="delRemovePublic" name="remove_public" aria-describedby="delRemovePublicHint">/, "unticked, enabled");
  assert.ok(on.includes(en["acctdel.remove_public"]), "the box");
  assert.ok(on.includes(en["acctdel.remove_public_meta"]), "its hint");
  assert.ok(on.includes(en["acctdel.what.hub"]), "what deleting does in PATV chat");
  assert.equal(en["acctdel.remove_public"], "Also remove my public messages", "the one wording (CHATLOG §5, OQ-20)");
  for (const w of ["PATV chat", "pads' chat history", "once a day", "report", "legal hold", "Camfrog", "linked Camfrog name", "30 days after the report is decided",
                   "90 days at most", "incognito"]) assert.ok(en["acctdel.remove_public_meta"].includes(w), w);
  const wait = await render({ wait: Date.UTC(2026, 9, 22, 9, 30) });
  assert.match(wait, /id="delRemovePublic" name="remove_public" aria-describedby="delRemovePublicHint" disabled>/);
  assert.match(wait, /ask again after Oct 22, 2026, 9:30\s?AM \(UTC\)/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "account-delete.js"), "utf8");
  assert.match(js, /body\.remove_public = !!rp\.checked/);
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /removePublic: b\.remove_public === true/, "the route reads it (a strict true)");
});

test("the routes: GET renders the box only while erasure is on; POST {remove_public: true} is refused while off, stored while on; anything but a strict true is no", async () => {
  await setup();
  const express = require("express");
  const http = require("http");
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); if (id) req.user = { userId: id }; next(); };
  D.register(app, { addUser });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const host = "127.0.0.1:" + srv.address().port;
  const call = (method, url, uid, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ method, host: "127.0.0.1", port: srv.address().port, path: url,
      headers: Object.assign({ "x-test-user": uid, origin: "http://" + host }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-requested-with": "fetch" } : {}) }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (c) => { s += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (e) { j = null; } resolve({ status: res.statusCode, text: s, j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  try {
    const a = await signedUp("rpw", "rpweb");
    await erasure(false);
    let page = await call("GET", "/settings/account/delete", "rpw");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /delRemovePublic/);
    let r = await call("POST", "/api/account/delete", "rpw", { confirm: "rpweb", password: a.pw, remove_public: true });
    assert.equal(r.status, 409);
    assert.equal(r.j.code, "E_REMOVE_OFF");
    await erasure(true);
    page = await call("GET", "/settings/account/delete", "rpw");
    assert.match(page.text, /id="delRemovePublic" name="remove_public" aria-describedby="delRemovePublicHint">/);
    assert.match(page.text, /account-delete\.js\?v=3/);
    // "yes" / 1 are not a choice (a strict true, like hide_lines)
    r = await call("POST", "/api/account/delete", "rpw", { confirm: "rpweb", password: a.pw, remove_public: "yes" });
    assert.equal(r.status, 200, r.text);
    assert.equal((await D.pendingOf("rpw")).remove_public, null);
    await D.cancelOnSignIn("rpw", "password");
    r = await call("POST", "/api/account/delete", "rpw", { confirm: "rpweb", password: a.pw, remove_public: true });
    assert.equal(r.status, 200, r.text);
    assert.equal((await D.pendingOf("rpw")).remove_public, 1);
    await D.cancelOnSignIn("rpw", "password");
    page = await call("GET", "/settings/account/delete", "rpw");
    assert.match(page.text, /id="delRemovePublic" name="remove_public" aria-describedby="delRemovePublicHint" disabled>/, "asked today: disabled, with the time");
    r = await call("POST", "/api/account/delete", "rpw", { confirm: "rpweb", password: a.pw, remove_public: true });
    assert.equal(r.status, 429);
    assert.equal(r.j.code, "E_REMOVE_DAILY");
    assert.ok(r.j.retry_at > clockAt);
  } finally {
    await erasure(false);
    await new Promise((res) => srv.close(res));
  }
});

test("the privacy page: one paragraph for PATV chat and the pad chat archive, only while erasure is on; dated; the export sentence with the export switch", async () => {
  await setup();
  const ejs = require("ejs");
  const render = (hubErasure, chatlog = null) => ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v",
    UPDATED: "21 October 2026", enforced: true, chatlog, hubErasure, ogBase: "" });
  const off = await render(null);
  assert.doesNotMatch(off, /id="delete-chat"/);
  assert.doesNotMatch(off, /PATV chat\b/);
  await HO.setSettings({ erasure: true, export: false });
  try {
    const copy = await D.privacyCopy();
    const sw = (await getQuery("SELECT updated, first_on FROM hubseam_settings WHERE key = 'erasure'"))[0];
    assert.equal(copy.on_at, Number(sw.first_on), "dated by the switch's own row: the FIRST time it went on (review 2)");
    assert.ok(Number(sw.first_on) > 0 && Number(sw.first_on) <= Number(sw.updated), "the earlier tests turned it on and off before");
    assert.match(copy.on_day, /^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    assert.equal(copy.export, false);
    const on = await render(copy);
    assert.equal((on.match(/id="delete-chat"/g) || []).length, 1, "one paragraph");
    assert.match(on, /<a href="#delete-chat">your chat lines when you delete your account<\/a>/, "in the contents");
    assert.match(on, /<b>PATV chat<\/b>/);
    assert.match(on, /<i>Also remove my public messages<\/i>/);
    assert.match(on, /in PATV chat and in pads' chat history alike/, "both stores, one choice");
    assert.match(on, /A message under a report is kept until 30 days after the report is decided \(90 days at most while it isn't\), and one under a legal hold until the hold ends/, "D10's bounds");
    assert.match(on, /or, if you had a linked Camfrog name, under that name/, "a linked member's web lines without the tick");
    assert.match(on, /also those under a Camfrog name while it was linked to you, earlier ones included/, "and with it (review 2: earlier linked names, only their own spans)");
    assert.match(on, /while incognito with a linked Camfrog name/, "what it can't reach");
    assert.match(on, /lines under a Camfrog name you unlinked before 12 October 2026 \(we have no record of it\)/, "review 2: nor a name let go before the login history");
    assert.doesNotMatch(on, /Download my data<\/a> includes what PATV chat keeps/, "no export sentence while export is off");
    assert.ok(on.includes("<b>" + copy.on_day + ":</b> added <a href=\"#delete-chat\">"), "the dated change note");
    // review fix: the date is when erasure went ON - the /admin/keys#seam form posts EVERY switch on each save (admin-keys.js),
    // and a later save (another switch turned on, or nothing changed) must not move the paragraph's date or "Last updated"
    const onAt = copy.on_at;
    HO._setClock(() => onAt + 15 * DAY);
    try {
      await HO.setSettings(HO.settings());                                   // a save with nothing changed
      await HO.setSettings(Object.assign(HO.settings(), { export: true }));  // the form again, export ticked this time
    } finally { HO._setClock(null); }
    const later = await D.privacyCopy();
    assert.equal(later.on_at, onAt, "still the day erasure went on");
    assert.equal(later.export, true);
    assert.match(await render(later), /Download my data<\/a> includes what PATV chat keeps about you/);
    const exp = (await getQuery("SELECT updated FROM hubseam_settings WHERE key = 'export'"))[0];
    assert.equal(Number(exp.updated), onAt + 15 * DAY, "a switch that did change is dated by its change");
    // review 2: a break-glass - erasure off, and on again weeks later - doesn't re-date the published paragraph, its "Changes"
    // entry or "Last updated" (first_on is set once)
    HO._setClock(() => onAt + 20 * DAY);
    try { await HO.setSettings({ erasure: false }); } finally { HO._setClock(null); }
    assert.equal(await D.privacyCopy(), null, "off: no paragraph");
    HO._setClock(() => onAt + 40 * DAY);
    try { await HO.setSettings({ erasure: true }); } finally { HO._setClock(null); }
    const again = await D.privacyCopy();
    assert.equal(again.on_at, onAt, "on again: still the day it was first published");
    const row2 = (await getQuery("SELECT updated, first_on FROM hubseam_settings WHERE key = 'erasure'"))[0];
    assert.deepEqual([Number(row2.updated), Number(row2.first_on)], [onAt + 40 * DAY, onAt], "updated is the last change; first_on stays");
    // rows from before the column: an ON one dated by its last change (huboutbox.init's backfill), an OFF one not dated
    const legacy = Object.fromEntries((await getQuery("SELECT key, first_on FROM hubseam_settings WHERE key LIKE 'rp_legacy_%'")).map((r) => [r.key, r.first_on]));
    assert.deepEqual(legacy, { rp_legacy_on: 1234, rp_legacy_off: null });
  } finally {
    await HO.setSettings({ erasure: false, export: false });
  }
  assert.equal(await D.privacyCopy(), null);
  // terms.js passes it and dates the page by the newest change
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /hubErasure = await require\("\.\/accountdelete"\)\.privacyCopy\(\)/);
});

// ── S1 V4 review 2 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (userId, oldL, newL, at, via = "camfrog:relink") => runQuery(
  "INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES (?, ?, ?, ?, ?, ?, ?)",
  [userId, oldL, newL, oldL || "u:" + userId, newL || "u:" + userId, at, via]);
const uh = (userId, oldL, newL, at, via = "camfrog:relink") => runQuery(
  "INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES (?, ?, ?, ?, ?, 'camfrog')", [userId, oldL, newL, at, via]);

test("review 2: an archive that can't be reached fails the removal - nothing is recorded done, the logins stay on the row, the tick runs it once the archive is back", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rparc", { username: "rparcade", cf: "ArcCF" });
    const w1 = await line("Rp.Room", "my web line while the archive is down", { key: "u:rparc" });
    const w2 = await line("Rp.Room", "my linked web line while the archive is down", { key: "arccf", display: "ArcCF", web: true });
    await D.schedule({ userId: "rparc", username: "rparcade" }, { removePublic: true });
    await user("rparc2", { username: "rparcade2" });
    const w3 = await line("Rp.Room", "another member's web line while the archive is down", { key: "u:rparc2" });
    await D.schedule({ userId: "rparc2", username: "rparcade2" }, { removePublic: true });
    // a CHATLOG_DB that didn't open: chatlog.init() resolved with archiveError set (chat_log absent, or empty tables in myapp.db)
    const realErr = CL.archiveError;
    const errs = [];
    const ce = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    let r;
    CL.archiveError = () => "CHATLOG_DB can't be opened (SQLITE_CANTOPEN)";
    try {
      r = await D.execute("rparc", { force: true });
      assert.equal(r.state, "done", "the deletion itself is done");
      assert.equal(r.report.public_removed, undefined);
      assert.equal((await D.execute("rparc2", { force: true })).state, "done");
      // the tick while it's still down: nothing, ONE line for the round (two requests wait)
      assert.equal(await D.retryRemovePublic(), 0);
    } finally { CL.archiveError = realErr; console.error = ce; }
    const lines = errs.filter((e) => e.startsWith("[acctdel] remove public lines"));
    assert.equal(lines.length, 3, "each execute's step + one for the tick's round: " + JSON.stringify(lines));
    assert.ok(lines.every((e) => /the pad chat archive can't be reached/.test(e) && !/rparc|arccf|archive is down|SQLITE/i.test(e)), "no ids, no login, no words, no path");
    let d = (await getQuery("SELECT public_done_at, public_windows, done_at FROM account_deletions WHERE user_id = 'rparc' AND state = 'done'"))[0];
    assert.equal(d.public_done_at, null, "not recorded done");
    assert.deepEqual(JSON.parse(d.public_windows), [{ login: "arccf", from: 0, to: Number(d.done_at) }], "the login (and its span) stays for the retry");
    for (const c of [w1, w2, w3]) assert.ok((await row(c)).text && (await row(c)).rm_at == null, "untouched: " + c);
    // the archive's tables missing (a myapp.db without them): the same - it throws, never "nothing to remove"
    await runQuery("ALTER TABLE chat_log RENAME TO chat_log_away");
    try {
      await assert.rejects(CLM.removeAccountLines("rparc", { windows: [{ login: "arccf", from: 0, to: Number(d.done_at) }] }), (e) => e.code === "archive_db");
    } finally { await runQuery("ALTER TABLE chat_log_away RENAME TO chat_log"); }
    // the archive back: the tick runs it with the row's spans, then the row forgets them
    await D.tick();
    for (const c of [w1, w2, w3]) assert.deepEqual([(await row(c)).text, (await row(c)).purged], [null, 1], "purged: " + c);
    d = (await getQuery("SELECT public_done_at, public_windows, report FROM account_deletions WHERE user_id = 'rparc' AND state = 'done'"))[0];
    assert.ok(d.public_done_at > 0);
    assert.equal(d.public_windows, null);
    assert.deepEqual(JSON.parse(d.report).public_removed, { lines: 2, held: 0 });
  } finally {
    await erasure(false);
  }
});

test("review 2: the decision is made inside the writing transaction - a moderator's un-hide or hide, a legal hold or a report landing meanwhile is seen, never undone", async () => {
  await setup();
  const me = { key: "u:rprace" };
  await user("rprace", { username: "rprace" });
  const a = await line("Rp.Race", "hidden by a moderator, shown again meanwhile", me);
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:m1', rm_why = 'spam' WHERE c = ?", [clockAt - 60e3, a]);
  await report(a);
  const b = await line("Rp.Race", "shown, hidden by a moderator meanwhile", me);
  await report(b);
  const c = await line("Rp.RaceHeld", "a legal hold arrives meanwhile", me);
  const d = await line("Rp.Race", "a report arrives meanwhile", me);
  const e = await line("Rp.Race", "nothing arrives", me);
  const heldRk = await rk("Rp.RaceHeld");
  const B = require(path.join(repo, "bridge"));
  const takeDown = B.takeDown, drops = [];
  B.takeDown = async (roomId, cs) => { drops.push(...[].concat(cs).map(Number)); return 0; };
  let release;
  const blocker = tx(() => new Promise((r) => { release = r; }));          // an open transaction: everything below queues behind it
  try {
    // the moderators' transactions and a staff hold (an outside write: it waits at the write gate), all queued first...
    const unhideA = tx(() => runQuery("UPDATE chat_log SET rm_at = NULL, rm_by = NULL, rm_why = NULL WHERE c = ? AND rm_at IS NOT NULL AND purged IS NULL", [a]));
    const hideB = tx(() => runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:m2', rm_why = 'rude' WHERE c = ? AND rm_at IS NULL AND purged IS NULL", [clockAt - 1000, b]));
    const repD = tx(() => runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, (SELECT rk FROM chat_log WHERE c = ?), NULL, 'harassment', NULL, 'open', ?)", [d, d, clockAt]));
    const holdC = runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'a court order', ?)", ["room:" + heldRk, clockAt]);
    // ...then the removal, whose reads outside a transaction (before review 2: the lines themselves) all run now, while those wait
    const R = CLM.removeAccountLines("rprace");
    await sleep(150);
    release();
    await Promise.all([blocker, unhideA, hideB, repD, holdC]);
    const out = await R;
    assert.deepEqual(out, { purged: 1, held: 1, reported: 3 });
  } finally { B.takeDown = takeDown; if (release) release(); }
  // (a) shown again before the removal's transaction: taken down by it (not "self" on a SHOWN line)
  let x = await row(a);
  assert.ok(x.text && x.rm_at != null, "down");
  assert.equal(x.rm_by, "self");
  assert.ok(drops.includes(a), "and out of the live feed");
  // (b) hidden by the moderator first: the author's removal now (an un-hide can't bring it back), still down since the hide
  x = await row(b);
  assert.deepEqual([x.rm_by, x.rm_why, Number(x.rm_at)], ["self", null, clockAt - 1000]);
  // (c) the hold and (d) the report that arrived first keep their lines (taken down, waiting); (e) purged
  for (const k of [c, d]) { x = await row(k); assert.ok(x.text && x.rm_at != null && x.rm_by === "self" && x.purged == null, "kept: " + k); }
  assert.equal((await row(e)).purged, 1);
  assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM chatlog_erase_wait WHERE c IN (?, ?, ?, ?)`, [a, b, c, d]))[0].n, 4);
  // the nightly pass decides inside its transaction too: the hold still on keeps (c); a hold placed while it waits is seen
  const holdD = "room:" + (await rk("Rp.Race"));
  // the reports decided long ago (they hold nothing at the pass's time) - only the holds decide
  await runQuery("UPDATE chatlog_reports SET state = 'dismissed', decided_at = ? WHERE c IN (?, ?, ?)", [clockAt + DAY, a, b, d]);
  let release2;
  const blocker2 = tx(() => new Promise((r) => { release2 = r; }));
  const late = runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'another order', ?)", [holdD, clockAt]);
  let n;
  try {
    const N = CLM.nightly({ t: clockAt + 100 * DAY });
    await sleep(150);
    release2();
    await Promise.all([blocker2, late]);
    n = await N;
  } finally { release2(); }
  for (const k of [a, b, c, d]) assert.ok((await row(k)).text, "held (a room hold each) - kept: " + k);
  assert.ok(n.erase_waiting >= 4);
  await runQuery("DELETE FROM chatlog_holds WHERE key IN (?, ?)", ["room:" + heldRk, holdD]);
  await CLM.loadHolds();
  await CLM.nightly({ t: clockAt + 100 * DAY });
  for (const k of [a, b, c, d]) assert.equal((await row(k)).text, null, "once the holds ended: " + k);
});

test("review 2: earlier Camfrog logins are reached inside the span each was the member's - another account's web lines under the same login (before or after) stay; a login let go before the history isn't reached", async () => {
  await setup();
  await erasure(true);
  try {
    const t = clockAt;
    const T0 = t - 50 * DAY, T1 = t - 40 * DAY, T2 = t - 30 * DAY, T3 = t - 20 * DAY, T4 = t - 10 * DAY;
    await user("rpe", { username: "rpearlier", cf: "NewCF" });
    await user("rpq0", { username: "rpq0" });                              // held newcf before the member
    await user("rpp", { username: "rppnext", cf: "OldCF" });              // holds oldcf now (after the member let it go)
    await user("rpu", { username: "rpunlinked" });                         // unlinked before deleting
    await user("rps", { username: "rpseen" });                             // only a backfill trace of a login
    // the history: rpq0 links newcf (T0) and unlinks it (T2); the member links oldcf (T1), relinks oldcf -> newcf (T3: both
    // records of it, usernames.recordLogin first); rpp links oldcf (T4)
    await lc("rpq0", null, "newcf", T0);
    await lc("rpq0", "newcf", null, T2, "camfrog:unlink");
    await uh("rpq0", "newcf", null, T2, "camfrog:unlink");
    await lc("rpe", null, "oldcf", T1);
    await uh("rpe", "oldcf", "newcf", T3 - 5, "camfrog:relink");
    await lc("rpe", "oldcf", "newcf", T3);
    await lc("rpp", null, "oldcf", T4);
    await lc("rpu", null, "unlcf", T1);
    await uh("rpu", "unlcf", null, T2, "camfrog:unlink");
    await lc("rpu", "unlcf", null, T2, "camfrog:unlink");
    await uh("rps", "seencf", null, T1, "seen");
    const web = (login, text, ts) => line("Rp.Logins", text, { key: login, display: login, web: true }, { ts });
    const q0Line = await web("newcf", "rpq0's web line under newcf", T0 + DAY);
    const oldMine = await web("oldcf", "my web line under my earlier login", T1 + DAY);
    const oldCam = await line("Rp.Logins", "my Camfrog line under my earlier login", { key: "oldcf", display: "OldCF" }, { ts: T1 + 2 * DAY });
    const newMine = await web("newcf", "my web line under my login now", T3 + DAY);
    const nextLine = await web("oldcf", "rpp's web line under oldcf", T4 + DAY);
    const unlMine = await web("unlcf", "my web line before I unlinked", T1 + DAY);
    const seenLine = await web("seencf", "a web line under a login known only from a trace", T1 + DAY);
    // the spans
    assert.deepEqual(await D.loginWindowsOf("rpe", "newcf", t), [
      { login: "newcf", from: T3, to: t },                 // from the member's relink (rpq0's link and unlink before it bound nothing more)
      { login: "oldcf", from: T3 - 5, to: T3 },            // the relink's two records (usernames.recordLogin, then loginrekey) ...
      { login: "oldcf", from: T1, to: T3 - 5 },            // ... and from the member's link of oldcf up to the first: together T1..T3
    ], "newcf from the relink to the deletion; oldcf from its link to the relink (rpp's link at T4 is after)");
    assert.deepEqual(await D.loginWindowsOf("rpu", null, t), [{ login: "unlcf", from: T1, to: T2 }], "a login unlinked before the deletion: its span");
    assert.deepEqual(await D.loginWindowsOf("rps", null, t), [], "a trace ('seen') ends nothing");
    // the deletions
    for (const [id, name] of [["rpe", "rpearlier"], ["rpu", "rpunlinked"], ["rps", "rpseen"]]) {
      await D.schedule({ userId: id, username: name }, { removePublic: true });
      assert.equal((await D.execute(id, { force: true })).state, "done");
    }
    for (const c of [oldMine, newMine, unlMine]) assert.deepEqual([(await row(c)).text, (await row(c)).purged], [null, 1], "the member's: " + c);
    for (const c of [q0Line, nextLine, oldCam, seenLine]) assert.ok((await row(c)).text && (await row(c)).rm_at == null, "not the member's (or not reached): " + c);
  } finally {
    await erasure(false);
  }
});

test("review 2: a retry hours after a crash keeps to the deletion's spans - the next holder's web lines under the released login stay; one run at a time; the first run to finish writes the counts", async () => {
  await setup();
  await erasure(true);
  try {
    await user("rpc", { username: "rpcrash", cf: "CrashCF" });
    await user("rpn2", { username: "rpnext2" });
    const mine = await line("Rp.Room", "my linked web line before the crash", { key: "crashcf", display: "CrashCF", web: true });
    await D.schedule({ userId: "rpc", username: "rpcrash" }, { removePublic: true });
    const real = CLM.removeAccountLines;
    const ce = console.error;
    console.error = () => {};
    CLM.removeAccountLines = async () => { throw new Error("the process stopped"); };
    try { assert.equal((await D.execute("rpc", { force: true })).state, "done"); } finally { CLM.removeAccountLines = real; console.error = ce; }
    const t0 = clockAt;
    // six hours later: someone else linked the released login and sent a web line under it; then the tick's retry
    clockAt = t0 + 6 * 3600e3;
    try {
      await runQuery("UPDATE users SET camfrogUsername = 'crashcf' WHERE userId = 'rpn2'");
      await lc("rpn2", null, "crashcf", t0 + 3600e3);
      const theirs = await line("Rp.Room", "the next holder's web line", { key: "crashcf", display: "CrashCF", web: true }, { ts: t0 + 2 * 3600e3 });
      assert.equal(await D.retryRemovePublic(), 1);
      assert.equal((await row(mine)).text, null, "the member's line: purged");
      assert.equal((await row(theirs)).text, "the next holder's web line", "the next holder's: kept (the span ends at the deletion, not at the retry)");
    } finally { clockAt = t0; }

    // one run per request: the step after the commit and the tick's retry at the same time share it
    await user("rpo2", { username: "rpone" });
    const one = await line("Rp.Room", "a line for the shared run", { key: "u:rpo2" });
    await D.schedule({ userId: "rpo2", username: "rpone" }, { removePublic: true });
    let calls = 0, retried = null;
    CLM.removeAccountLines = async (...a) => {
      calls++;
      if (!retried) retried = D.retryRemovePublic();                      // the tick, while this run is in progress
      await sleep(50);
      return real(...a);
    };
    let r;
    try { r = await D.execute("rpo2", { force: true }); await retried; } finally { CLM.removeAccountLines = real; }
    assert.equal(calls, 1, "one run");
    assert.deepEqual(r.report.public_removed, { lines: 1, held: 0 });
    assert.equal((await row(one)).text, null);

    // the first run to finish writes the counts: a later one (another process) doesn't overwrite them
    await user("rpw2", { username: "rpwrite" });
    await line("Rp.Room", "a line for the counts", { key: "u:rpw2" });
    await D.schedule({ userId: "rpw2", username: "rpwrite" }, { removePublic: true });
    CLM.removeAccountLines = async (...a) => {
      const out = await real(...a);
      // another runner finished first and recorded its counts
      await runQuery(`UPDATE account_deletions SET public_done_at = ?, report = json_set(COALESCE(report, '{}'), '$.public_removed', json('{"lines":7,"held":0}'))
                      WHERE user_id = 'rpw2' AND state = 'done'`, [clockAt - 1]);
      return out;
    };
    try { await D.execute("rpw2", { force: true }); } finally { CLM.removeAccountLines = real; }
    const w = (await getQuery("SELECT public_done_at, report FROM account_deletions WHERE user_id = 'rpw2' AND state = 'done'"))[0];
    assert.equal(w.public_done_at, clockAt - 1);
    assert.deepEqual(JSON.parse(w.report).public_removed, { lines: 7, held: 0 }, "the first writer's counts stay");
  } finally {
    await erasure(false);
  }
});
