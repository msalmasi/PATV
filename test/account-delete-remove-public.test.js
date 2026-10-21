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
  await new Promise((r) => db.close(r));
})();

const DAY = 86400000;
let clockAt = Date.UTC(2026, 9, 21, 12);
const bcrypt = require("bcrypt");
let D, S, HO, CL, CLM, runQuery, getQuery;

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
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
    const d = (await getQuery("SELECT report, public_done_at, public_login FROM account_deletions WHERE user_id = 'rpx'"))[0];
    assert.equal(d.public_done_at, clockAt);
    assert.equal(d.public_login, null);
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
    const waiting = (await getQuery("SELECT public_done_at, public_login FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0];
    assert.equal(waiting.public_done_at, null);
    assert.equal(waiting.public_login, "rollcf", "the released login waits on the row for the retry (its web lines are under it)");
    assert.equal((await row(r1)).text, "rolled back line");
    assert.equal((await hubRows("rpr"))[0].remove_public, true, "the hub has its part already");
    assert.ok(!JSON.stringify((await hubRows("rpr"))[0]).includes("rollcf"), "the hub row never names the login");
    await D.tick();
    assert.equal((await row(r1)).text, null, "the tick ran it");
    assert.equal((await row(r2)).text, null, "with the login the row kept");
    const done = (await getQuery("SELECT public_done_at, public_login FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0];
    assert.ok(done.public_done_at > 0);
    assert.equal(done.public_login, null, "and then the row forgets it");
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
    const sw = (await getQuery("SELECT updated FROM hubseam_settings WHERE key = 'erasure'"))[0];
    assert.equal(copy.on_at, Number(sw.updated), "dated by the switch's own row");
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
    assert.match(on, /also those under your linked Camfrog name/, "and with it");
    assert.match(on, /while incognito with a linked Camfrog name/, "what it can't reach");
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
  } finally {
    await HO.setSettings({ erasure: false, export: false });
  }
  assert.equal(await D.privacyCopy(), null);
  // terms.js passes it and dates the page by the newest change
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /hubErasure = await require\("\.\/accountdelete"\)\.privacyCopy\(\)/);
});
