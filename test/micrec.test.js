// Mic retention on the site (micrec.js; owner answers 2026-10-27, the ops plan mic-audio-retention-2026-10-27 §7):
//   * the policy switch ships OFF, can't go on while Pepe doesn't report the audio windows, is audited, keeps its first-on day;
//     while ON the privacy page's "How long" line names mic recordings by tier (equal windows merged) and is dated that day;
//   * the owner sync's retention_keep block in the shape the bot reads (pepe_retention.parse_keep): ok only when complete, legal
//     holds (rooms, people - hashed, an account key as its login), open reports on 🎙 lines (hashed speaker, never a web line or a
//     decided report), each room's tier lapses inside their own 30-day grace (subscriptions + the chat archive's tracking, the
//     latest loss of each tier); not ok over a cap; on POST /api/rooms/owners;
//   * account deletion's "Also delete my mic recordings": offered only while the switch is on and Pepe runs the release that does
//     it; one "privacy.recdelete" [before] action per login no other account held before (the others are skipped, counted);
//     asked again after a failure; taken -> the logins leave the rows; not taken in 30 days -> given up (the admin card lists it).
//   NODE_PATH=G:/PATV/node_modules node --test test/micrec.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "micrec-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
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
let clockAt = Date.UTC(2026, 9, 28, 12);
let M, P, CL, D, runQuery, getQuery, server, base;
// what the bot 1.99afq reports with its split rule on (the owner's option C) - and with it off (recordings follow the transcripts)
const FULL = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null, audio_days: 30, audio_prime: 180, audio_plus: null,
               pm_days: 30, pm_pass: null, split: true };
const SPLIT_OFF = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: 365, rec_plus: null, audio_days: 30, audio_prime: 365, audio_plus: null,
                    pm_days: 30, pm_pass: null, split: false };
const OLD = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: 365, rec_plus: null, pm_days: 30, pm_pass: null };
const H = (login) => crypto.createHash("sha256").update("pepe-hidden:" + login, "utf8").digest("hex").slice(0, 20);
const sub = (tier, target, o = {}) => runQuery(`INSERT INTO premium_subs (tier, target, paid_through, renewer_id, comped, status, started, updated)
                                               VALUES (?, ?, ?, ?, ?, 'active', 1, 1)`, [tier, target, o.paid || 0, o.renewer || null, o.comped ? 1 : 0]);
async function user(id, o = {}) {
  await runQuery("INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified) VALUES (?, ?, ?, ?, 'x', 'pleb', ?, 0, 1)",
                 [id, o.username || id, id, `${id}@example.com`, o.cf || null]);
}

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  M = require(path.join(repo, "micrec"));
  P = require(path.join(repo, "premium"));
  CL = require(path.join(repo, "chatlog"));
  D = require(path.join(repo, "accountdelete"));
  for (const x of [M, P, D]) x._setClock(() => clockAt);
  await P.init();
  await CL.init();
  await D.init();
  await M.init();
  // the chat archive's tier tracking of two rooms (read by chatlogview at its first init - before anything asks it)
  await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created) VALUES (7, 'Held.Room', 1), (8, 'Plus.Then.PT', 1), (9, 'Viewed.Lapse', 1)");
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('tier:Plus.Then.PT', ?), ('tier:Viewed.Lapse', ?)",
                 [JSON.stringify({ tier: "prime", lapsed: [{ tier: "unlimited", at: clockAt - 1 * DAY }] }),
                  JSON.stringify({ tier: "standard", lapsed: [{ tier: "prime", at: clockAt - 3 * DAY }, { tier: "unlimited", at: clockAt - 40 * DAY }] })]);
  // the routes: an owner sync (roomsweb) and the admin card, with a header-picked user
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-user"); req.user = u ? { userId: u, username: u, class: req.get("x-class") || "pleb" } : null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  M.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
})());
test.after(() => { if (server) { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } });

test("the switch: ships off; never on while Pepe doesn't apply the owner's windows; audited; the first day it went on dates the privacy page", async () => {
  await setup();
  assert.equal(M.policyOn(), false, "ships OFF");
  assert.equal(await M.privacyCopy(), null);
  await P.noteRetention(OLD);
  assert.equal(P.retention().audio_reported, false);
  assert.equal(M.pepeCan(), false, "an older Pepe: he can't delete / export recordings");
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "audio_unreported" && e.status === 409);
  await P.noteRetention(SPLIT_OFF);
  assert.equal(M.pepeCan(), true, "the 1.99afq release");
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "split_off", "his split rule still off: recordings follow the transcript windows");
  assert.equal(M.policyOn(), false);
  await P.noteRetention(FULL);
  assert.equal(P.retention().audio_reported, true);
  assert.equal(P.retention().split, true);
  assert.ok(P.retentionAudioAt() > 0);
  const on = await M.setPolicy(true, "admin1");
  assert.equal(on.cfg.on, true);
  assert.equal(on.cfg.first_on, clockAt);
  assert.equal((await M.privacyCopy()).on_day, "28 October 2026");
  assert.deepEqual((await M.privacyCopy()).ret, { audio_free: "30 days", audio_prime: "180 days", audio_plus: "kept for good" });
  const ev = await getQuery("SELECT actor, detail FROM room_events WHERE what = 'micrec.switch' ORDER BY rowid");
  assert.deepEqual(ev.map((r) => [r.actor, r.detail]), [["admin1", "policy on"]]);
  // off and on again later: the page keeps its first date (a break-glass off / on doesn't re-date it)
  clockAt += DAY;
  await M.setPolicy(false, "admin1");
  assert.equal(await M.privacyCopy(), null);
  clockAt += DAY;
  await M.setPolicy(true, "admin2");
  assert.equal((await M.privacyCopy()).on_day, "28 October 2026");
  assert.equal((await M.setPolicy(true, "admin2")).unchanged, true);
  // stored: a restart reads it back
  await M.loadCfg();
  assert.equal(M.policyOn(), true);
  clockAt -= 2 * DAY;
});

test("How long: equal windows merged per tier, mic recordings named only while the switch is on (chatlog.policy -> privacy.ejs)", async () => {
  await setup();
  assert.deepEqual(M.howLong(FULL), {
    free: "chat, mic transcripts and mic recordings 30 days",
    prime: "chat and mic transcripts kept for good, mic recordings 180 days",
    plus: "chat, mic transcripts and mic recordings kept for good",
  });
  assert.deepEqual(M.howLong({ ...FULL, rec_prime: 365, audio_prime: 365 }).prime, "chat kept for good, mic transcripts and mic recordings 365 days");
  assert.equal(M.howLong({ ...FULL, audio_days: 14 }).free, "chat and mic transcripts 30 days, mic recordings 14 days");
  // the archive's notice on -> the policy object; how only while the switch is on
  await CL.setSwitch("notice", true, "test");
  let pol = await CL.policy();
  assert.ok(pol && pol.how, "switch on: the merged phrases");
  assert.equal(pol.how.prime, "chat and mic transcripts kept for good, mic recordings 180 days");
  await M.setPolicy(false, "test");
  pol = await CL.policy();
  assert.equal(pol.how, null, "switch off: the line reads as before");
  await M.setPolicy(true, "test");
  pol = await CL.policy();
  // the template: the How long line names mic recordings with the switch on, never with it off
  const src = fs.readFileSync(path.join(repo, "views", "privacy.ejs"), "utf8");
  assert.match(src, /if \(CL\.how\)/);
  const ejs = require("ejs");
  const render = (chatlog, micrec) => ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v", UPDATED: "28 October 2026",
                                                                                                 enforced: true, chatlog, micrec, hubErasure: null, t: (k) => k, ogBase: "" });
  const onHtml = await render(pol, await M.privacyCopy()), offHtml = await render({ ...pol, how: null }, null);
  assert.match(onHtml, /a pad without a tier: chat, mic transcripts and mic recordings 30 days; 📺 Prime Time: chat and mic transcripts kept for good, mic recordings 180 days; 💎 Prime Time Plus: chat, mic transcripts and mic recordings kept for good\./);
  assert.match(onHtml, /after that, the windows of the tier it has then apply/);
  assert.doesNotMatch(offHtml, /mic recordings/, "switch off: the page never mentions mic recordings");
  assert.match(offHtml, /a pad without a tier: chat 30 days, mic transcripts 30 days/);
  // terms.js passes micrec and dates the page by its first day
  const terms = fs.readFileSync(path.join(repo, "terms.js"), "utf8");
  assert.match(terms, /require\("\.\/micrec"\)\.privacyCopy\(\)/);
  assert.match(terms, /\[micrec && micrec\.on_at, micrec && micrec\.on_day\]/);
});

test("the keep block: tier lapses inside their own grace (subscriptions + the archive's tracking), holds and open 🎙 reports, hashed", async () => {
  await setup();
  const t = clockAt;
  // subscriptions: a Prime Time lapsed 5 days ago; Plus lapsed 10 days ago while Prime Time is still on; an old lapse; a comp with no end;
  // a renewing one inside its 3-day renewal grace
  await sub("prime_time", "PT.Lapsed", { paid: t - 5 * DAY });
  await sub("prime_plus", "Plus.Then.PT", { paid: t - 10 * DAY });
  await sub("prime_time", "Plus.Then.PT", { paid: t + 20 * DAY });
  await sub("prime_time", "Old.Lapse", { paid: t - 40 * DAY });
  await sub("prime_plus", "Comp.Forever", { comped: true });
  await sub("prime_time", "Renewing", { paid: t - 1 * DAY, renewer: "someone" });
  await P.loadCache();
  // holds: a room, a login, an account key (-> its linked login), an anonymised hash
  await user("heldacct", { cf: "AcctLogin" });
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('room:7', 'staff', 'court order', 1), ('who:heldlogin', 'staff', 'x', 1), ('who:u:heldacct', 'staff', 'x', 1), (?, 'staff', 'x', 1)",
                 ["who:h:" + "a".repeat(20)]);
  // 🎙 lines with reports: open on a login's and an anonymised line; a chat line, a decided report and a web line don't count
  const T1 = Date.UTC(2026, 9, 20, 10), T2 = Date.UTC(2026, 9, 21, 11);
  await runQuery(`INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (101, 7, ?, 'tx', 'speaker1', 'said a thing', 'r', 'a', '{}'),
                  (102, 7, ?, 'tx', ?, 'anon thing', 'r', 'a', '{}'), (103, 7, ?, 'msg', 'typer', 'typed', 'r', 'a', '{}'),
                  (104, 8, ?, 'tx', 'decided', 'old', 'r', 'a', '{}'), (105, 8, ?, 'tx', 'u:someone', 'web', 'r', 'a', '{}')`,
                 [T1, T2, "h:" + "b".repeat(20), T1, T1, T1]);
  await runQuery(`INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) VALUES (101, 7, 'r1', 'harassment', 'open', 1), (101, 7, 'r2', 'harassment', 'open', 2),
                  (102, 7, 'r1', 'other', 'open', 1), (103, 7, 'r1', 'other', 'open', 1), (104, 8, 'r1', 'other', 'upheld', 1), (105, 8, 'r1', 'other', 'open', 1)`);
  const b = await M.keepBlock({ fresh: true });
  assert.equal(b.v, 1);
  assert.equal(b.at, Math.floor(t / 1000));
  assert.equal(b.complete, true);
  assert.equal(b.policy, true, "the switch rides along");
  assert.equal(b.ok, true, "the bot reads only a block with ok: true");
  assert.deepEqual(b.tiers["PT.Lapsed"], { tier: "standard", lapsed: [{ tier: "prime", at: t - 5 * DAY }] });
  assert.deepEqual(b.tiers["Plus.Then.PT"], { tier: "prime", lapsed: [{ tier: "unlimited", at: t - 1 * DAY }] }, "the later loss of the two sources (the archive saw it later)");
  assert.deepEqual(b.tiers["Viewed.Lapse"], { tier: "standard", lapsed: [{ tier: "prime", at: t - 3 * DAY }] }, "each lapse its own grace: the 40-day-old Plus one is over");
  for (const r of ["Old.Lapse", "Comp.Forever", "Renewing"]) assert.equal(b.tiers[r], undefined, r);
  assert.deepEqual(b.held_rooms, ["Held.Room"]);
  assert.deepEqual([...b.held_who_h].sort(), [H("heldlogin"), H("acctlogin"), "a".repeat(20)].sort());
  assert.deepEqual(b.reported_tx, { "Held.Room": [[Math.floor(T2 / 1000), "b".repeat(20)], [Math.floor(T1 / 1000), H("speaker1")]] });
  assert.ok(!JSON.stringify(b).includes("speaker1") && !JSON.stringify(b).includes("heldlogin") && !JSON.stringify(b).includes("said a thing"), "no names, no words");
  // cached for a minute (Pepe syncs every ~30 s)
  await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:heldlogin'");
  assert.equal((await M.keepBlock()).held_who_h.length, 3);
  clockAt += M.KEEP_CACHE_MS + 1;
  assert.equal((await M.keepBlock()).held_who_h.length, 2);
  // the owner sync carries it (an older Pepe ignores it)
  const r = await fetch(`${base}/api/rooms/owners`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot" }) });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
  assert.equal(d.retention_keep.v, 1);
  assert.deepEqual(d.retention_keep.held_rooms, ["Held.Room"]);
  assert.equal(d.retention_keep.complete, true);
  // over a cap: the list is cut and the block says it isn't complete (Pepe then deletes no audio)
  await runQuery(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                  INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) SELECT 100000 + i, 7, 1760000000000 + i, 'tx', 'spam', 'x', 'r', 'a', '{}' FROM n`, [M.REPORTED_MAX + 1]);
  await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) SELECT c, 7, 'r9', 'other', 'open', 1 FROM chat_log WHERE c > 100000");
  const big = await M.keepBlock({ fresh: true });
  assert.equal(big.complete, false);
  assert.equal(big.ok, false, "not ok: Pepe deletes nothing");
  assert.ok(big.reported_tx["Held.Room"].length >= M.REPORTED_MAX - 1 && big.reported_tx["Held.Room"].length <= M.REPORTED_MAX, "cut at the cap (a web line in it is skipped)");
  await runQuery("DELETE FROM chatlog_reports WHERE c > 100000");
  await runQuery("DELETE FROM chat_log WHERE c > 100000");
  assert.equal((await M.keepBlock({ fresh: true })).ok, true);
  // the admin card: counts only
  const card = await fetch(`${base}/api/admin/micrec`, { headers: { "x-user": "boss", "x-class": "Admin" } });
  const cj = await card.json();
  assert.equal(card.status, 200, JSON.stringify(cj));
  assert.equal(cj.keep.held_rooms, 1);
  assert.equal(cj.cfg.on, true);
  assert.equal((await fetch(`${base}/api/admin/micrec`, { headers: { "x-user": "nobody" } })).status, 403);
  const sw = await fetch(`${base}/api/admin/micrec/switch`, { method: "POST", headers: { "x-user": "boss", "x-class": "Admin", "content-type": "application/json", origin: base, "x-requested-with": "fetch" },
                                                              body: JSON.stringify({ name: "policy", on: true }) });
  assert.equal(sw.status, 200);
  assert.equal((await fetch(`${base}/api/admin/micrec/switch`, { method: "POST", headers: { "x-user": "boss", "x-class": "Admin", "content-type": "application/json", origin: "https://evil.example", "x-requested-with": "fetch" },
                                                                 body: JSON.stringify({ name: "policy", on: false }) })).status, 403, "same-site only");
});

test("account deletion: Also delete my mic recordings - offered only with the switch on and Pepe's release; one action per login, a shared login skipped", async () => {
  await setup();
  const t0 = clockAt;
  await user("del1", { cf: "MicFan" });
  // an earlier login it let go (nobody else linked it), and one another account held before it
  await runQuery("INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('del1', 'oldcf', 'micfan', 'oldcf', 'micfan', ?, 'relink')", [t0 - 50 * DAY]);
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('other', 'micfan', NULL, ?, 'unlink', 'camfrog')", [t0 - 80 * DAY]);
  // not offered: an older Pepe (no audio windows in his report)
  await P.noteRetention(OLD);
  assert.equal(D.recordingsOffered(), false);
  const req = { user: { userId: "del1" }, loginSession: null };
  await assert.rejects(D.request(req, { confirm: "del1", deleteRecordings: true }), (e) => e.code === "E_REC_OFF");
  await P.noteRetention(FULL);
  assert.equal(D.recordingsOffered(), true);
  await M.setPolicy(false, "test");
  assert.equal(D.recordingsOffered(), false, "the switch off: not offered");
  await M.setPolicy(true, "test");
  assert.equal(await D.hadLogin("del1", "micfan"), true);
  // scheduled with the choice (the admin path never sets it)
  await D.schedule({ userId: "del1", username: "del1" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.equal((await getQuery("SELECT delete_recordings FROM account_deletions WHERE user_id = 'del1'"))[0].delete_recordings, 1);
  const r = await D.execute("del1", { force: true });
  assert.equal(r.state, "done", JSON.stringify(r));
  // the login now was another account's before: the bot deletes everything of a login before `before`, so it isn't asked (counted)
  assert.deepEqual(r.report.recordings, { logins: 2, queued: 1, skipped: 1 });
  const acts = await getQuery("SELECT camfrog, args, kind, status, idem FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del1' ORDER BY id");
  assert.deepEqual(acts.map((a) => [a.camfrog, JSON.parse(a.args)]), [["oldcf", [String(Math.floor((t0 - 50 * DAY) / 1000))]]],
                   "a login let go (nobody else held it): its recordings made before it was let go (unix s)");
  assert.deepEqual(await M.recWindowsOf("del1-gone", null, clockAt), [], "(nothing for an account with no login history)");
  const row = (await getQuery("SELECT rec_windows, rec_done_at, report FROM account_deletions WHERE user_id = 'del1'"))[0];
  assert.equal(JSON.parse(row.rec_windows).length, 1);
  assert.equal(row.rec_done_at, null);
  assert.ok(!row.report.includes("micfan") && !row.report.includes("oldcf"), "no logins in the stored report");
  // Pepe: failed (an older Pepe / an error) -> asked again after 6 hours, not before
  await runQuery("UPDATE pepe_actions SET status = 'failed', updated = ? WHERE kind = 'privacy.recdelete' AND camfrog = 'oldcf'", [clockAt]);
  assert.equal((await M.retryRecDeletes()).asked, 0, "too soon");
  clockAt += M.REC_RETRY_MS + 1;
  assert.equal((await M.retryRecDeletes()).asked, 1);
  const again = await getQuery("SELECT camfrog, args, status, idem FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del1' AND status = 'pending'");
  assert.deepEqual(again.map((a) => [a.camfrog, JSON.parse(a.args)[0]]), [["oldcf", String(Math.floor((t0 - 50 * DAY) / 1000))]]);
  assert.match(again[0].idem, /^acctdel-rec-del1-0-2$/);
  // taken (Pepe journals it and follows up) -> done; the logins leave the row and the actions
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'privacy.recdelete' AND user_id = 'del1'");
  assert.equal((await M.retryRecDeletes()).done, 1);
  const fin = (await getQuery("SELECT rec_windows, rec_done_at FROM account_deletions WHERE user_id = 'del1'"))[0];
  assert.equal(fin.rec_windows, null);
  assert.equal(fin.rec_done_at, clockAt);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del1' AND camfrog IS NOT NULL"))[0].n, 0);
});

test("account deletion: never confirmed -> given up after 30 days (the admin card lists it); no Camfrog login ever -> nothing to ask", async () => {
  await setup();
  await user("del2", { cf: "Quiet1" });
  await D.schedule({ userId: "del2", username: "del2" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.equal((await D.execute("del2", { force: true })).state, "done");
  const a2 = await getQuery("SELECT camfrog, args FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del2'");
  assert.deepEqual(a2.map((a) => [a.camfrog, JSON.parse(a.args)]), [["quiet1", [String(Math.floor(clockAt / 1000))]]], "the login now: everything before the deletion");
  await runQuery("UPDATE pepe_actions SET status = 'failed', updated = ? WHERE kind = 'privacy.recdelete' AND user_id = 'del2'", [clockAt]);
  clockAt += M.REC_GIVE_UP_MS + 1;
  const err = console.error; const said = []; console.error = (...a) => said.push(a.join(" "));
  try { assert.equal((await M.retryRecDeletes()).gave_up, 1); } finally { console.error = err; }
  assert.ok(said.some((s) => /never confirmed deleting its mic recordings/.test(s)));
  assert.ok((await getQuery("SELECT rec_gave_up_at FROM account_deletions WHERE user_id = 'del2'"))[0].rec_gave_up_at > 0);
  const v = await M.adminView();
  assert.ok(v.deletions.gave_up >= 1);
  assert.ok(!JSON.stringify(v.deletions.rows).includes("quiet1"), "the card shows pseudonyms, never logins");
  // an account that never had a Camfrog login: nothing queued, done at once
  await user("del3");
  await D.schedule({ userId: "del3", username: "del3" }, { by: "self", reauth: "password", deleteRecordings: true });
  const r3 = await D.execute("del3", { force: true });
  assert.deepEqual(r3.report.recordings, { logins: 0, queued: 0, skipped: 0 });
  assert.equal((await getQuery("SELECT rec_done_at FROM account_deletions WHERE user_id = 'del3'"))[0].rec_done_at, clockAt);
  // the page: the checkbox only while offered, to an account with a login
  const page = fs.readFileSync(path.join(repo, "views", "accountDelete.ejs"), "utf8");
  assert.match(page, /if \(locals\.recordings\)/);
  assert.match(page, /name="delete_recordings"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "account-delete.js"), "utf8");
  assert.match(js, /body\.delete_recordings = !!rec\.checked/);
});

test("the wiring: the bot's action kinds (TTLs, no inbox notice, no PAT), the upload routes' body parser", async () => {
  await setup();
  const TTL = require(path.join(repo, "actionttl"));
  const ttl = fs.readFileSync(path.join(repo, "actionttl.js"), "utf8");
  assert.match(ttl, /"privacy\.recdelete": 7 \* 1440/);
  assert.match(ttl, /"privacy\.export": 3 \* 1440/);
  assert.match(ttl, /NO_NOTICE = new Set\(\[[^\]]*"privacy\.recdelete", "privacy\.export"\]\)/);
  assert.ok(TTL);
  const WE = fs.readFileSync(path.join(repo, "weberrors.js"), "utf8");
  assert.match(WE, /"privacy\.recdelete", "privacy\.export"\]/, "the same NO_PAT_KINDS as the bot's");
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /req\.path === "\/api\/privacy\/export\/bot\/chunk" \|\|/);
  assert.match(idx, /require\("\.\/accountexport"\)\.register\(app, \{ addUser, isBotToken \}\)/);
  assert.match(idx, /require\("\.\/micrec"\)\.register\(app, \{ addUser \}\)/);
  const roomsweb = fs.readFileSync(path.join(repo, "roomsweb.js"), "utf8");
  assert.match(roomsweb, /retention_keep: retentionKeep/);
});
