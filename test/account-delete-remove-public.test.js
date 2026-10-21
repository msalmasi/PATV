// S1 V4 - the privacy UI (S1 plan §2.5 V4; ADR 0007 D16, OQ-20; CHAT-ARCHITECTURE rev 5.1 §9.4): account deletion's
// "Also remove my public messages".
//   * offered only while the chat hub's `erasure` switch is on (the page's checkbox and its copy, the privacy page's paragraph,
//     the request); refused while off (E_REMOVE_OFF); unticked by default; at most once a day (E_REMOVE_DAILY - a request that a
//     sign-in cancelled counts too);
//   * the flag reaches privacy/account-deleted (remove_public: true) - the feed row and the snapshot's;
//   * the shared cross-store rule (one checkbox, both stores, the same exceptions): the hub row carries the choice and the pad chat
//     archive's web lines of the account (u:<id>, and its incognito h:<hash> lines) are purged after the commit, except a line under
//     a legal hold (its room or its speaker) or an open report - taken down at once, kept, blanked by the nightly pass once that
//     ends; other people's lines and the lines under the account's Camfrog login are untouched; Pepe's removed_who learns it;
//   * nothing is purged for a deletion that rolls back; a crash between the commit and the purge is healed by the tick;
//   * the routes (GET renders the box, POST stores a strict true), the delete page's and the privacy page's copy.
// The hub half of the cross-store rule is the contract suite's scenario 5c (the hub repo, services/rooms/test/
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
                  VALUES (?, ?, ?, ?, ?, 'pleb', ?, 0, 1)`,
                 [id, o.username || id, o.display || id, `${id}@example.com`, o.password || "x", o.cf || null]);
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
/** A line in roomId: web (u:<id>), incognito web (h:<hash of u:<id>>) or a Camfrog login's. -> c */
async function line(roomId, text, who) {
  const k = await rk(roomId);
  const c = ++nextC;
  const it = { c, ts: clockAt - 3600e3, k: "msg", text };
  if (who.incognito) Object.assign(it, { u: { display: "someone", anon: true }, ah: CL.hash(who.incognito) });
  else it.u = { login: who.key, display: who.display || "Someone Named", web: String(who.key).startsWith("u:") || undefined };
  const r = CL.rowOf({ it }, k, "p");
  await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [r.c, r.rk, r.ts, r.k, r.who, r.text, r.rt, r.aud, r.d]);
  return c;
}
const row = async (c) => (await getQuery("SELECT * FROM chat_log WHERE c = ?", [c]))[0];
const report = async (c) => runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, (SELECT rk FROM chat_log WHERE c = ?), NULL, 'harassment', NULL, 'open', ?)", [c, c, clockAt]);
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
    const me = { key: "u:rpx", display: "Cross Person" };
    const plain = await line("Rp.Room", "my plain web line", me);
    const plain2 = await line("Rp.Other", "another web line of mine", me);
    const incog = await line("Rp.Room", "said while incognito", { incognito: "u:rpx" });
    const reported = await line("Rp.Room", "a reported web line", me);
    const heldRoom = await line("Rp.Held", "a line in a room under a legal hold", me);
    const cfLine = await line("Rp.Room", "said in Camfrog under the login", { key: "crosscf", display: "CrossCF" });
    const theirs = await line("Rp.Room", "someone else's web line", { key: "u:rpo", display: "Other Person" });
    await report(reported);
    await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'a court order', ?)", ["room:" + (await rk("Rp.Held")), clockAt]);
    await CLM.loadHolds();
    await D.schedule({ userId: "rpx", username: "rpcross" }, { by: "self", reauth: "password", removePublic: true });
    const r = await D.execute("rpx", { force: true });
    assert.equal(r.state, "done");
    // the hub: the same choice
    assert.equal((await hubRows("rpx"))[0].remove_public, true);
    // the archive: purged at once - text, name, key (one-way hash only), FTS - by its author
    for (const c of [plain, plain2, incog]) {
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
    // the record: counts only, done
    const d = (await getQuery("SELECT report, public_done_at FROM account_deletions WHERE user_id = 'rpx'"))[0];
    assert.equal(d.public_done_at, clockAt);
    assert.deepEqual(JSON.parse(d.report).public_removed, { lines: 3, held: 2 });
    assert.deepEqual(r.report.public_removed, { lines: 3, held: 2 });
    assert.ok(!d.report.includes("plain") && !d.report.includes("Cross"), "no words, no name in the record");
    // Pepe's !log / !search skip every line of theirs up to now (the account key's hash)
    const who = new Map(await CLM.removedWho());
    assert.ok(who.has(CL.hash("u:rpx")), "removed_who");
    // the nightly pass: the report still open, the hold still on -> kept; once both end (and the 30 days are up) -> blanked
    let n = await CLM.nightly({ t: clockAt + 31 * DAY });
    assert.ok((await row(reported)).text && (await row(heldRoom)).text, "kept while the report is open / the hold is on");
    assert.equal(n.skipped_reported >= 1 && n.skipped_held >= 1, true);
    await runQuery("UPDATE chatlog_reports SET state = 'dismissed', decided_at = ? WHERE c = ?", [clockAt, reported]);
    await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + (await rk("Rp.Held"))]);
    await CLM.loadHolds();
    n = await CLM.nightly({ t: clockAt + 31 * DAY });
    for (const c of [reported, heldRoom]) assert.equal((await row(c)).text, null, "deleted once it ended: " + c);
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
    await user("rpr", { username: "rproll" });
    const r1 = await line("Rp.Room", "rolled back line", { key: "u:rpr" });
    await D.schedule({ userId: "rpr", username: "rproll" }, { removePublic: true });
    const emit = HO.emit;
    HO.emit = async (...a) => { await emit(...a); throw new Error("boom"); };
    try { await assert.rejects(D.execute("rpr", { force: true }), /boom/); } finally { HO.emit = emit; }
    assert.equal((await row(r1)).text, "rolled back line", "nothing purged");
    assert.equal((await D.pendingOf("rpr")).state, "scheduled");
    assert.equal((await hubRows("rpr")).length, 0);

    // the archive part failing after the commit (a crash, an error): the deletion is done, public_done_at waits; the tick runs it
    const real = CLM.removeAccountLines;
    CLM.removeAccountLines = async () => { throw new Error("disk full"); };
    const errs = [];
    const ce = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try { assert.equal((await D.execute("rpr", { force: true })).state, "done"); } finally { CLM.removeAccountLines = real; console.error = ce; }
    assert.ok(errs.some((e) => e.startsWith("[acctdel] remove public lines:")), "logged (no ids, no words)");
    assert.ok(errs.every((e) => !e.includes("rolled back line")));
    assert.equal((await getQuery("SELECT public_done_at FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0].public_done_at, null);
    assert.equal((await row(r1)).text, "rolled back line");
    assert.equal((await hubRows("rpr"))[0].remove_public, true, "the hub has its part already");
    await D.tick();
    assert.equal((await row(r1)).text, null, "the tick ran it");
    assert.ok((await getQuery("SELECT public_done_at FROM account_deletions WHERE user_id = 'rpr' AND state = 'done'"))[0].public_done_at > 0);
    assert.equal(await D.retryRemovePublic(), 0, "and only once");
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
  for (const w of ["PATV chat", "pads' chat history", "once a day", "report", "legal hold", "Camfrog"]) assert.ok(en["acctdel.remove_public_meta"].includes(w), w);
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
    assert.match(on, /A message under a report or a legal hold is kept until that ends/);
    assert.doesNotMatch(on, /Download my data<\/a> includes what PATV chat keeps/, "no export sentence while export is off");
    assert.ok(on.includes("<b>" + copy.on_day + ":</b> added <a href=\"#delete-chat\">"), "the dated change note");
    await HO.setSettings({ export: true });
    assert.match(await render(await D.privacyCopy()), /Download my data<\/a> includes what PATV chat keeps about you/);
  } finally {
    await HO.setSettings({ erasure: false, export: false });
  }
  assert.equal(await D.privacyCopy(), null);
  // terms.js passes it and dates the page by the newest change
  const src = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(src, /hubErasure = await require\("\.\/accountdelete"\)\.privacyCopy\(\)/);
});
