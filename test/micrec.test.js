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
// what the bot reports with its split rule on (the owner's option C) - and with it off (recordings follow the transcripts).
// Review 4: + `delete`, the unknown-room rule and rec_notice. 1.99afq reports rec_notice false (its in-room notice doesn't name
// recordings yet - AFQ); FULL is the bot letter that builds it (ops plan 8.8), the first one the switch can go on with.
const AFQ = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null, audio_days: 30, audio_prime: 180, audio_plus: null,
              pm_days: 30, pm_pass: null, split: true, delete: true, unknown_room: "shortest", rec_notice: false };
const FULL = { ...AFQ, rec_notice: true };
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
  require(path.join(repo, "actions")).register(app, { addUser, isBotToken: (t) => t === "bot" });   // review 2: Pepe's late answers
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
  // review 4: everything else the text depends on - an unknown room kept for good (a 1.99afq from before review 4: no rule
  // reported), his deletion off, his in-room notice not naming recordings (1.99afq itself)
  const { delete: _d, unknown_room: _u, rec_notice: _n, ...PRE4 } = AFQ;
  await P.noteRetention(PRE4);
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "unknown_room" && /30 days without a pad/.test(e.message), "no unknown-room rule reported");
  await P.noteRetention({ ...FULL, unknown_room: "longest" });
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "unknown_room", "\"longest\": a recording whose room he lost is kept for good");
  await P.noteRetention({ ...FULL, delete: false });
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "delete_off", "his deletion off: nothing is deleted each night");
  await P.noteRetention(AFQ);
  await assert.rejects(M.setPolicy(true, "admin1"), (e) => e.code === "notice_missing", "1.99afq: his room notice doesn't name recordings yet (ops plan 8.8)");
  assert.deepEqual(M.pepeGaps(P.retention()).map((g) => g.code), ["notice_missing"]);
  assert.equal(M.policyOn(), false);
  await P.noteRetention(FULL);
  assert.deepEqual(M.pepeGaps(P.retention()), []);
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
  // (review 4: an account hold also sends the account key's hash - Pepe's "u:<id>" lines and PM logs)
  assert.deepEqual([...b.held_who_h].sort(), [H("heldlogin"), H("acctlogin"), H("u:heldacct"), "a".repeat(20)].sort());
  assert.deepEqual(b.reported_tx, { "Held.Room": [[Math.floor(T2 / 1000), "b".repeat(20)], [Math.floor(T1 / 1000), H("speaker1")]] });
  assert.ok(!JSON.stringify(b).includes("speaker1") && !JSON.stringify(b).includes("heldlogin") && !JSON.stringify(b).includes("said a thing"), "no names, no words");
  // cached for a minute (Pepe syncs every ~30 s)
  await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:heldlogin'");
  assert.equal((await M.keepBlock()).held_who_h.length, 4);
  clockAt += M.KEEP_CACHE_MS + 1;
  assert.equal((await M.keepBlock()).held_who_h.length, 3);
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

test("review: a merged-away account is the same holder; skipped spans kept for the admins (login + span) until handled or 30 days; markers; the choice said back", async () => {
  await setup();
  const t0 = clockAt;
  // an account merged INTO del4 had its login first: that's del4's own history, not "another account"
  await user("del4", { cf: "MergeCf" });
  await runQuery("INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('del4-old', 'prevcf', 'mergecf', 'prevcf', 'mergecf', ?, 'relink')", [t0 - 60 * DAY]);
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES ('del4-old', 'del4', ?, 'test')", [t0 - 30 * DAY]);
  const w = await M.recWindowsOf("del4", "mergecf", t0);
  // (review 2: the login the merged-away account let go is del4's own too - accountdelete.loginWindowsOf reads the merged ids)
  assert.deepEqual(w.map((x) => [x.login, x.from]).sort(), [["mergecf", 0], ["prevcf", 0]]);
  assert.equal(M.askable(w).length, 2, "asked of Pepe - not skipped");
  // the choice is said back: the answer (the page shows it) and the notice
  const s = await D.schedule({ userId: "del4", username: "del4" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.deepEqual([s.delete_recordings, s.recordings], [true, { logins: 2, by_hand: 0 }]);
  const note = (await getQuery("SELECT body FROM inbox WHERE user_id = 'del4' ORDER BY id DESC LIMIT 1"))[0];
  assert.match(note.body, /mic recordings will be deleted with it/);
  const r = await D.execute("del4", { force: true });
  assert.deepEqual(r.report.recordings, { logins: 2, queued: 2, skipped: 0 });
  // the markers: keyed, no name - a later holder of "mergecf" (or "prevcf") is seen as one with an earlier holder
  assert.ok(r.report.login_markers >= 1);
  const marks = await getQuery("SELECT h FROM micrec_login_gone");
  assert.ok(marks.every((m) => /^[0-9a-f]{32}$/.test(m.h)));
  assert.ok(!JSON.stringify(marks).includes("mergecf"));
  await user("newholder", { cf: "MergeCf" });
  assert.equal(await M.earlierHolder("newholder", "mergecf"), true, "the deleted account's marker");
  await user("freshholder", { cf: "NeverSeen" });
  assert.equal(await M.earlierHolder("freshholder", "neverseen"), false);
  // a login another account held before is skipped (Pepe would delete that holder's recordings too): its login and span are kept
  // for the admins to act on
  await user("del7", { cf: "SharedMic" });
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('someone', 'sharedmic', NULL, ?, 'unlink', 'camfrog')", [t0 - 20 * DAY]);
  const s7 = await D.schedule({ userId: "del7", username: "del7" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.deepEqual(s7.recordings, { logins: 1, by_hand: 1 }, "the member is told one name is handled by hand");
  assert.deepEqual((await D.execute("del7", { force: true })).report.recordings, { logins: 1, queued: 0, skipped: 1 });
  const row = (await getQuery("SELECT id, rec_skipped FROM account_deletions WHERE user_id = 'del7'"))[0];
  assert.deepEqual(JSON.parse(row.rec_skipped).map((x) => [x.login, x.from]), [["sharedmic", t0 - 20 * DAY]]);
  const card = await (await fetch(`${base}/api/admin/micrec`, { headers: { "x-user": "boss", "x-class": "Admin" } })).json();
  const mine = card.deletions.rows.find((x) => x.id === row.id);
  assert.equal(mine.skipped_spans[0].login, "sharedmic", "the card shows it to act on (admins only)");
  assert.ok(mine.skipped_spans[0].to > 0);
  assert.equal((await fetch(`${base}/api/admin/micrec`, { headers: { "x-user": "nobody" } })).status, 403);
  const H2 = { "x-user": "boss", "x-class": "Admin", "content-type": "application/json", origin: base, "x-requested-with": "fetch" };
  assert.equal((await fetch(`${base}/api/admin/micrec/skipped`, { method: "POST", headers: { ...H2, "x-class": "pleb" }, body: JSON.stringify({ id: row.id }) })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/micrec/skipped`, { method: "POST", headers: { ...H2, origin: "https://evil.example" }, body: JSON.stringify({ id: row.id }) })).status, 403);
  const done = await fetch(`${base}/api/admin/micrec/skipped`, { method: "POST", headers: H2, body: JSON.stringify({ id: row.id }) });
  assert.equal(done.status, 200);
  const after = (await getQuery("SELECT rec_skipped, rec_skipped_done_at FROM account_deletions WHERE id = ?", [row.id]))[0];
  assert.deepEqual([after.rec_skipped, after.rec_skipped_done_at], [null, clockAt]);
  assert.equal((await fetch(`${base}/api/admin/micrec/skipped`, { method: "POST", headers: H2, body: JSON.stringify({ id: row.id }) })).status, 404);
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE what = 'micrec.skipped_done'")).length);
  // ...or 30 days after the deletion, whoever didn't act on it
  await runQuery("UPDATE account_deletions SET rec_skipped = '[{\"login\":\"x1\",\"from\":5,\"to\":6}]' WHERE user_id = 'del4'");
  clockAt += M.REC_GIVE_UP_MS + 1;
  assert.ok((await M.retryRecDeletes()).skipped_expired >= 1);
  assert.equal((await getQuery("SELECT rec_skipped FROM account_deletions WHERE user_id = 'del4'"))[0].rec_skipped, null);
  clockAt = t0;
});

test("review: Pepe ran it only when his FOLLOW-UP came (his first 'queued' answer just journals it); re-asked a day after a lone 'queued'; no login kept after", async () => {
  await setup();
  await user("del5", { cf: "FollowUp1" });
  await D.schedule({ userId: "del5", username: "del5" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.equal((await D.execute("del5", { force: true })).state, "done");
  const acts = () => getQuery("SELECT id, camfrog, args, status, message, idem FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del5' ORDER BY id");
  // he took it and journaled it: "queued" - not run yet, not asked again within a day
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'queued: followup1''s mic recordings are being deleted', updated = ? WHERE user_id = 'del5' AND kind = 'privacy.recdelete'", [clockAt]);
  let r = await M.retryRecDeletes();
  assert.deepEqual([r.done, r.asked], [0, 0]);
  assert.equal((await getQuery("SELECT rec_done_at FROM account_deletions WHERE user_id = 'del5'"))[0].rec_done_at, null);
  clockAt += M.REC_QUEUED_MS + 1;
  r = await M.retryRecDeletes();
  assert.equal(r.asked, 1, "no follow-up in a day: asked again (he merges it into the same job)");
  // his follow-up: the deletion ran -> done; the logins leave the actions (camfrog, args, his message names the pseudonym)
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'deleted 3 mic recording file(s) of followup1', updated = ? WHERE user_id = 'del5' AND kind = 'privacy.recdelete' AND status = 'pending'", [clockAt]);
  r = await M.retryRecDeletes();
  assert.equal(r.done, 1);
  for (const a of await acts()) {
    assert.equal(a.camfrog, null);
    assert.ok(!/followup1/i.test(String(a.message || "")), a.message);
  }
  assert.match((await acts())[1].message, /^deleted 3 mic recording file\(s\) of deleted-/);
  // a later failed follow-up of an earlier login would be asked again; a given-up deletion keeps no login either
  await user("del6", { cf: "GiveUp1" });
  await D.schedule({ userId: "del6", username: "del6" }, { by: "self", reauth: "password", deleteRecordings: true });
  await D.execute("del6", { force: true });
  await runQuery("UPDATE pepe_actions SET status = 'failed', message = 'giveup1: something broke', updated = ? WHERE user_id = 'del6' AND kind = 'privacy.recdelete'", [clockAt]);
  clockAt += M.REC_GIVE_UP_MS + 1;
  const err = console.error; console.error = () => {};
  try { assert.ok((await M.retryRecDeletes()).gave_up >= 1); } finally { console.error = err; }
  const d6 =(await getQuery("SELECT rec_windows, rec_gave_up_at FROM account_deletions WHERE user_id = 'del6'"))[0];
  assert.equal(d6.rec_windows, null, "review: given up - the logins don't stay");
  assert.ok(d6.rec_gave_up_at > 0);
  const a6 = await getQuery("SELECT camfrog, message FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'del6'");
  assert.ok(a6.every((a) => a.camfrog === null && !/giveup1/i.test(String(a.message || ""))));
  // the page: what the deletion does, said back before and after
  const js = fs.readFileSync(path.join(repo, "public", "js", "account-delete.js"), "utf8");
  assert.match(js, /js\.acctdel\.sure_rec/);
  assert.match(js, /if \(j\.delete_recordings\)/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["acctdel.recordings_meta"], /by hand/);
  assert.match(en["acctdel.recordings_meta"], /before 12 October 2026/);
  assert.match(en["acctdel.recordings_meta"], /backup copies are deleted within 7 days/);
});

test("review 2: the login markers are NOT behind the switch (they guard the ungated download) - written with it off, an account merged in included, and the privacy page says so without it", async () => {
  await setup();
  const t0 = clockAt;
  await M.setPolicy(false, "test");
  assert.equal(M.policyOn(), false);
  // an account merged INTO mk1 let "mkprev" go (a merge keeps login_changes under the merged-away id): mk1's own name too
  await user("mk1", { cf: "MarkOff1" });
  await runQuery("INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('mk1-old', 'mkprev', 'markoff1', 'mkprev', 'markoff1', ?, 'relink')", [t0 - 70 * DAY]);
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES ('mk1-old', 'mk1', ?, 'test')", [t0 - 60 * DAY]);
  const wins = await D.loginWindowsOf("mk1", "markoff1", t0);
  assert.deepEqual(wins.map((w) => [w.login, w.to]).sort(), [["markoff1", t0], ["mkprev", t0 - 70 * DAY]], "the merged-away account's released login is a span of mk1's");
  const rw = await M.recWindowsOf("mk1", "markoff1", t0);
  assert.deepEqual(rw.map((w) => [w.login, w.from]).sort(), [["markoff1", 0], ["mkprev", 0]], "...and both are asked of Pepe (nobody else held them)");
  await D.schedule({ userId: "mk1", username: "mk1" }, { by: "self", reauth: "password" });
  const r = await D.execute("mk1", { force: true });
  assert.equal(r.state, "done");
  assert.equal(r.report.login_markers, 2, "both names marked - with the switch OFF");
  for (const l of ["markoff1", "mkprev"]) {
    await user(`next-${l}`, { cf: l });
    assert.equal(await M.earlierHolder(`next-${l}`, l), true, l);
  }
  // the privacy page discloses them without the switch: section 10's sentence and section 9's row, rendered with micrec null
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v", UPDATED: "27 October 2026",
                                                                               enforced: true, chatlog: null, hubErasure: null, micrec: null, ogBase: "" });
  // review 3: the owner-approved, corrected 8.5 A - the marker's only effect is on the next holder's OWN data download (a pad's
  // chat-history view and download follow the pad's rules, where the marker plays no part)
  assert.match(html, /PATV keeps a scrambled marker of each Camfrog name a deleted account had \(never the name itself\), so the next person to link that name can't get what Pepe keeps of yours, or your lines under that name, in their own data download \(see <a href="#retention">section 9<\/a>\)\./);
  assert.match(html, /<td>Markers of the Camfrog names a deleted account had[^<]*<\/td><td>No time limit for now: Pepe can keep data under a Camfrog name for good, and the marker is what stops the next person who links that name from getting it in their own data download<\/td>/);
  assert.match(html, /<b>28 October 2026:<\/b> <a href="#choices">Section 10<\/a>: when an account is deleted, PATV keeps a scrambled marker of each Camfrog name it had \(never the name itself\), so the next person to link that name can't get what Pepe keeps of the deleted account's, or its lines under that name, in their own data download\. New row in <a href="#retention">section 9<\/a>\./);
  assert.doesNotMatch(html, /can't download what Pepe keeps|in pads' chat history \(see|its lines under that name in pads' chat history/, "the old wording promised more than the code does");
  assert.doesNotMatch(html, /mic recordings/i, "nothing about recordings while the switch is off");
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
});

test("review 2: a skipped span can't lapse unnoticed - the chatlog.admin holders are told when it appears, reminded a week before its login goes, told if it lapsed; no login in any notice", async () => {
  await setup();
  const t0 = clockAt;
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
  await runQuery("INSERT INTO users (userId, username, displayname, email, password, class, points_balance, isEmailVerified) VALUES ('adm1', 'adm1', 'adm1', 'a@example.com', 'x', 'Admin', 0, 1), ('stf1', 'stf1', 'stf1', 's@example.com', 'x', 'Staff', 0, 1)");
  await user("sk1", { cf: "SkipMe1" });
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('someone-else', 'skipme1', NULL, ?, 'unlink', 'camfrog')", [t0 - 20 * DAY]);
  await D.schedule({ userId: "sk1", username: "sk1" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.deepEqual((await D.execute("sk1", { force: true })).report.recordings, { logins: 1, queued: 0, skipped: 1 });
  const id = (await getQuery("SELECT id FROM account_deletions WHERE user_id = 'sk1'"))[0].id;
  const notes = async (stage) => getQuery("SELECT user_id, title, body, link FROM inbox WHERE ref = ? ORDER BY user_id", [`micrec-skipped-${stage}:${id}`]);
  const stageOf = async () => (await getQuery("SELECT rec_skipped_alert AS s FROM account_deletions WHERE id = ?", [id]))[0].s;
  await M.retryRecDeletes();
  let n = await notes(1);
  assert.deepEqual(n.map((x) => x.user_id), ["adm1"], "the chatlog.admin holders (Admin by default) - not Staff, not a member");
  assert.match(n[0].title, new RegExp(`account deletion #${id}`));
  assert.match(n[0].body, /1 of their Camfrog names was linked to another PATV account before/);
  assert.match(n[0].body, /Mark handled/);
  assert.equal(n[0].link, "/admin/bridge#micrec");
  assert.equal(await stageOf(), 1);
  const card = (await M.adminView()).deletions.rows.find((x) => x.id === id);
  const doneAt = (await getQuery("SELECT done_at FROM account_deletions WHERE id = ?", [id]))[0].done_at;
  assert.equal(card.skipped_due_at, Number(doneAt) + M.REC_GIVE_UP_MS, "the card says by when");
  // told once (the stage is kept - an admin deleting the notice doesn't bring it back every tick)
  await runQuery("DELETE FROM inbox WHERE ref = ?", [`micrec-skipped-1:${id}`]);
  await M.retryRecDeletes();
  assert.equal((await notes(1)).length, 0);
  // a week before its login goes: the reminder
  clockAt = Number(doneAt) + M.REC_GIVE_UP_MS - M.REC_SKIP_REMIND_MS + 1;
  await M.retryRecDeletes();
  n = await notes(2);
  assert.deepEqual(n.map((x) => x.user_id), ["adm1"]);
  assert.match(n[0].title, /^Reminder: /);
  assert.equal(await stageOf(), 2);
  // never handled: the login goes, the row says LAPSED, a last notice and a console error
  clockAt = Number(doneAt) + M.REC_GIVE_UP_MS + 1;
  const err = console.error; const said = []; console.error = (...a) => said.push(a.join(" "));
  let out;
  try { out = await M.retryRecDeletes(); } finally { console.error = err; }
  assert.ok(out.skipped_expired >= 1);
  assert.ok(said.some((s) => new RegExp(`account deletion ${id}: 1 Camfrog name\\(s\\) to delete recordings of by hand were never marked handled`).test(s)));
  n = await notes(3);
  assert.deepEqual(n.map((x) => x.user_id), ["adm1"]);
  assert.match(n[0].title, /^NOT HANDLED: /);
  const row = (await getQuery("SELECT rec_skipped, rec_skipped_lapsed_at, rec_skipped_alert FROM account_deletions WHERE id = ?", [id]))[0];
  assert.deepEqual([row.rec_skipped, row.rec_skipped_lapsed_at, row.rec_skipped_alert], [null, clockAt, 3]);
  assert.equal((await M.adminView()).deletions.rows.find((x) => x.id === id).skipped_lapsed_at, clockAt);
  // no login in any notice (they live in inboxes - and Telegram - longer than the card's 30 days)
  const all = await getQuery("SELECT title, body FROM inbox WHERE ref LIKE ?", [`micrec-skipped-%:${id}`]);
  assert.ok(all.length >= 2 && all.every((x) => !/skipme1/i.test(x.title + x.body)));
  // the card: by when, and LAPSED
  const page = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(page, /r\.skipped_due_at \? ' - mark handled before '/);
  assert.match(page, /LAPSED: never marked handled/);
  clockAt = t0;
});

test("review 2: a late answer from Pepe can't bring a login back - after the scrub (done or given up) his message keeps only its counts, under the pseudonym", async () => {
  await setup();
  await user("lt1", { cf: "LateOne1" });
  await D.schedule({ userId: "lt1", username: "lt1" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.equal((await D.execute("lt1", { force: true })).state, "done");
  const acts = () => getQuery("SELECT id, camfrog, status, message, username FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'lt1' ORDER BY id");
  const [a] = await acts();
  // he follows up; the site scrubs the logins (done)
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'deleted 2 mic recording file(s) of lateone1', updated = ? WHERE id = ?", [clockAt, a.id]);
  assert.equal((await M.retryRecDeletes()).done >= 1, true);
  assert.equal((await acts())[0].camfrog, null);
  // ...and then a late follow-up from his journal names the login again (POST /api/actions/ack overwrites message and status)
  const ack = (results) => fetch(`${base}/api/actions/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", results }) });
  assert.equal((await ack([{ id: a.id, ok: true, message: "deleted 3 mic recording file(s) of lateone1; 1 kept under a legal hold or an open report - deleted once it's released" }])).status, 200);
  let [b] = await acts();
  assert.ok(!/lateone1/i.test(b.message), b.message);
  assert.equal(b.message, `deleted 3 mic recording file(s) of ${b.username}; 1 kept under a legal hold or an open report - deleted once it's released (a late answer)`);
  assert.match(b.username, /^deleted-/);
  // his first answer late, or a message the site doesn't know: no login either
  await ack([{ id: a.id, ok: true, message: "queued: lateone1's mic recordings are being deleted" }]);
  [b] = await acts();
  assert.equal(b.message, `queued: ${b.username}'s mic recordings are being deleted (a late answer)`);
  await ack([{ id: a.id, ok: false, message: "lateone1: the archive broke" }]);
  [b] = await acts();
  assert.ok(!/lateone1/i.test(b.message), b.message);
  assert.match(b.message, /a late answer from Pepe/);
  // an action whose login is still there (in flight) is left as he wrote it - the scrub does it when the deletion is done
  await user("lt2", { cf: "LateTwo2" });
  await D.schedule({ userId: "lt2", username: "lt2" }, { by: "self", reauth: "password", deleteRecordings: true });
  await D.execute("lt2", { force: true });
  const [c] = await getQuery("SELECT id FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'lt2'");
  await ack([{ id: c.id, ok: true, message: "queued: latetwo2's mic recordings are being deleted" }]);
  assert.equal((await getQuery("SELECT message FROM pepe_actions WHERE id = ?", [c.id]))[0].message, "queued: latetwo2's mic recordings are being deleted");
  // review 3: a late follow-up after the GIVE-UP is recorded on the deletion's row (the card no longer says only "NOT RUN"), and a
  // partial run keeps its "couldn't be read" / "couldn't be deleted yet" - it never reads as complete
  const t0 = clockAt;
  await user("lt3", { cf: "LateGiveUp3" });
  await D.schedule({ userId: "lt3", username: "lt3" }, { by: "self", reauth: "password", deleteRecordings: true });
  await D.execute("lt3", { force: true });
  const [g] = await getQuery("SELECT id FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'lt3'");
  await runQuery("UPDATE pepe_actions SET status = 'failed', message = 'lategiveup3: the archive is down', updated = ? WHERE id = ?", [clockAt, g.id]);
  clockAt += M.REC_GIVE_UP_MS + 1;
  const err = console.error; console.error = () => {};
  try { assert.ok((await M.retryRecDeletes()).gave_up >= 1); } finally { console.error = err; }
  const rowOf = async () => (await getQuery("SELECT id, rec_gave_up_at, rec_late_at, rec_late_note FROM account_deletions WHERE user_id = 'lt3'"))[0];
  assert.equal((await rowOf()).rec_late_at, null);
  clockAt += 3600e3;
  await ack([{ id: g.id, ok: true, message: "deleted 4 mic recording file(s) of lategiveup3; part of the recordings storage couldn't be read - Pepe tries again" }]);
  const [gb] = await getQuery("SELECT status, message, username FROM pepe_actions WHERE id = ?", [g.id]);
  assert.equal(gb.message, `deleted 4 mic recording file(s) of ${gb.username}; part of the recordings storage couldn't be read - Pepe tries again (a late answer)`);
  const row3 = await rowOf();
  assert.ok(row3.rec_gave_up_at > 0, "still given up (the site stopped asking)");
  assert.deepEqual([row3.rec_late_at, row3.rec_late_note], [clockAt, gb.message]);
  assert.ok(!/lategiveup3/i.test(row3.rec_late_note));
  const cardRow = (await M.adminView()).deletions.rows.find((x) => x.id === row3.id);
  assert.deepEqual([cardRow.rec_late_at, cardRow.rec_late_note], [clockAt, gb.message]);
  assert.ok(!JSON.stringify(cardRow).includes("lategiveup3"));
  // "a few couldn't be deleted yet" is kept too; a failed late answer isn't a run
  await ack([{ id: g.id, ok: true, message: "deleted 1 mic recording file(s) of lategiveup3; a few couldn't be deleted yet - Pepe tries again" }]);
  assert.match((await rowOf()).rec_late_note, /deleted 1 mic recording file\(s\) of deleted-[^;]*; a few couldn't be deleted yet - Pepe tries again \(a late answer\)$/);
  const before = (await rowOf()).rec_late_note;
  clockAt += 1000;
  await ack([{ id: g.id, ok: false, message: "lategiveup3: broke again" }]);
  assert.equal((await rowOf()).rec_late_note, before, "a failed answer doesn't count as a run");
  const card = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(card, /r\.rec_late_at \? ' - then a late answer from Pepe ' \+ when\(r\.rec_late_at\)/);
  clockAt = t0;
  const actionsSrc = fs.readFileSync(path.join(repo, "actions.js"), "utf8");
  assert.match(actionsSrc, /require\("\.\/micrec"\)\.scrubLateAcks\(acked\)/);
});

test("review 3: the owner-approved text (ops plan section 8, 8.11 = A) - on the privacy page, /help and Settings › Privacy only while the switch is on; no inbox notice at switch-on", async () => {
  await setup();
  await P.noteRetention(FULL);
  await M.setPolicy(false, "test");
  // switching ON sends members nothing (the owner's decision, 2026-10-27): the privacy page's date and its changelog are the notice
  const inboxN = async () => (await getQuery("SELECT COUNT(*) AS n FROM inbox"))[0].n;
  const n0 = await inboxN();
  await M.setPolicy(true, "test");
  assert.equal(await inboxN(), n0, "no inbox notice at switch-on");
  assert.doesNotMatch(M.setPolicy.toString(), /inbox|notify|announce/i);
  const card = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(card, /Members get <b>no inbox notice<\/b> when it goes on/);
  assert.match(card, /ops plan 8\.11 A/);
  // the privacy page: section 8's approved text with the switch on, none of it with the switch off
  await CL.setSwitch("notice", true, "test");
  const pol = await CL.policy();
  const mc = await M.privacyCopy();
  const ejs = require("ejs");
  const render = (chatlog, micrec) => ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v", UPDATED: "28 October 2026",
                                                                                               enforced: true, chatlog, micrec, hubErasure: null, ogBase: "" });
  const on = await render(pol, mc), off = await render({ ...pol, how: null }, null), onNoArchive = await render(null, mc);
  // 8.2 (with 8.11 = A: others on the mic at the same time can be heard)
  assert.match(on, /<li id="mic-recordings"><b>Mic recordings:<\/b> Pepe also keeps the sound of each mic-up \(compressed audio\) for the times above, on PATV's own storage with an encrypted backup copy\. A recording is the sound of the room while someone held the mic, so in a room with more than one mic, other people on the mic at the same time can be heard in it too\./);
  assert.match(on, /They're kept as plain audio: we don't make voiceprints from them, don't use them to recognise who's speaking \(Camfrog tells Pepe who's on the mic\) and don't use them to train AI or clone voices\./);
  assert.match(on, /Being incognito, <code>!bridge hide<\/code> and <code>!transcripts off<\/code> don't change this: they're about what the website shows, not what Pepe keeps\./);
  assert.match(onNoArchive, /<h3 id="mic-recordings">Mic recordings<\/h3>\s*<p><b>Mic recordings:<\/b> Pepe also keeps the sound of each mic-up \(compressed audio\) for the times in <a href="#retention">section 9<\/a>, on PATV's own storage/,
               "without the chat archive's notice: its own paragraph, pointing at section 9");
  // 8.3
  assert.match(on, /<tr><td>Mic recordings \(the sound of mic-ups in Camfrog rooms Pepe is in\)<\/td><td>By the pad's tier: without a tier \(or without a pad\) 30 days; 📺 Prime Time 180 days; 💎 Prime Time Plus kept for good while the pad has it\. A tier that lapses keeps them 30 more days\. Deleted sooner if you delete your account and tick <i>Also delete my mic recordings<\/i>; kept longer only under a legal hold or an open report\. Copies in backups are deleted within 7 days after\.<\/td><\/tr>/);
  assert.match(onNoArchive, /<tr><td>Mic recordings \(the sound of mic-ups/);
  // 8.4
  assert.match(on, /<li><b>Captures of you are private:<\/b> snaps and clips that show you can't be kept or posted, your cam can't be used as a reference for AI pictures, and your mic audio isn't offered for clips\. Your mic-ups are still recorded and kept like everyone's \(see <a href="#mic-recordings">Mic recordings<\/a>\): incognito is about what the website shows, not what Pepe keeps\.<\/li>/);
  assert.doesNotMatch(on, /Pepe doesn't keep your mic audio for clips/);
  assert.match(off, /Pepe doesn't keep your mic audio for clips/);
  // 8.5 B
  assert.match(on, /Pepe also forgets your Camfrog name, and if you tick <i>Also delete my mic recordings<\/i>, he deletes the recordings of your mic-ups \(for every Camfrog name you linked, from the time it was yours; if another PATV account had that name before you, our team deletes yours by hand; a name you unlinked before 12 October 2026 isn't reached; one under a legal hold or an open report is kept until that ends; backup copies go within 7 days after\)\. PATV keeps a scrambled marker/);
  assert.match(off, /Pepe also forgets your Camfrog name\. PATV keeps a scrambled marker/);
  assert.match(on, /The same box is offered when you delete your account\. It doesn't delete your mic recordings either; deleting your account can\. It doesn't switch on incognito/);
  // 8.6
  assert.match(on, /in <a href="\/settings\/account">Settings → Account<\/a>\. You choose what goes in besides your account: your chat logs \(with your private messages with Pepe, both sides\), your mic transcripts, what Pepe remembers about you, and your mic recordings\. Pepe's part covers the Camfrog name linked to your account now, and only if no other PATV account had that name before you/);
  assert.match(on, /In a room with more than one mic, a recording or transcript can hold other people who were on the mic at the same time\./);
  assert.match(on, /Recordings can be big, so one download holds up to about 256 MB of Pepe's part, newest recordings first; ask again with an earlier date for the rest \(a download with a date holds only those older recordings\)\. A download with Pepe's part needs your password or a recent sign-in, and we send you a notice when one is asked for\. A deleted account is closed/);
  // 8.7, dated by the switch's first day
  assert.match(on, new RegExp(`<li><b>${mc.on_day}:</b> mic transcripts are kept as long as the pad's chat on every tier \\(📺 Prime Time: for good instead of 365 days\\); added <a href="#mic-recordings">Mic recordings</a> \\(sections 3 and 9\\)`));
  // 8.5 A (not behind the switch) reads the same both ways; nothing else of section 8 with the switch off
  for (const h of [on, off]) assert.match(h, /so the next person to link that name can't get what Pepe keeps of yours, or your lines under that name, in their own data download/);
  assert.doesNotMatch(off, /mic recordings|mic-ups|voiceprints|You choose what goes in|id="mic-recordings"/i);
  // /help: the approved notes on Pepe's cards (ops plan 8.8) only while the switch is on, and never twice
  const HL = require(path.join(repo, "help"));
  const cardOf = async (id) => { for (const c of (await HL.pageModel()).cats) for (const e of c.entries) if (e.id === id) return e; return null; };
  assert.ok((await cardOf("incognito")).details.includes("Pepe still records your mic-ups like everyone's; incognito is about the website."));
  assert.ok((await cardOf("incognito")).details.includes("`!forgetme now` doesn't delete your mic recordings; deleting your PATV account can (tick Also delete my mic recordings)."));
  assert.ok((await cardOf("bridge")).details.includes("Pepe still records your mic-ups like everyone's; `!bridge hide` and incognito are about the website."));
  assert.ok((await cardOf("retention")).details.includes("audio_days / audio_prime / audio_plus (mic recordings)"));
  const twice = HL.withMicrecNotes([{ id: "bridge", summary: "s", details: "x " + HL.MICREC_NOTES.bridge[0] }]);
  assert.equal(twice[0].details, "x " + HL.MICREC_NOTES.bridge[0], "a card that already says it isn't given it twice");
  await M.setPolicy(false, "test");
  for (const id of ["incognito", "bridge", "retention"]) {
    const d = (await cardOf(id)).details;
    assert.ok(HL.MICREC_NOTES[id].every((n) => !d.includes(n)), `${id}: no note with the switch off`);
  }
  // Settings › Privacy: incognito doesn't change recordings, forget-me doesn't delete them - only while the switch is on
  const ps = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
  assert.match(ps, /<% if \(locals\.micrecOn\) \{ %><li><%- t\('inc\.what_rec'\) %><\/li><% \} %>/);
  assert.match(ps, /<% if \(locals\.micrecOn\) \{ %><li><%- t\('pf\.what_not_rec'\) %><\/li><% \} %>/);
  assert.match(fs.readFileSync(path.join(repo, "incognito.js"), "utf8"), /micrecOn = require\("\.\/micrec"\)\.policyOn\(\)/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["inc.what_rec"], "Pepe still records your mic-ups like everyone's; incognito is about the website.");
  assert.equal(en["pf.what_not_rec"], "It doesn't delete your mic recordings; deleting your PATV account can (tick Also delete my mic recordings).");
  await M.setPolicy(true, "test");
});

// ── review 4 ──
const privacyHtml = async (micrec) => {
  const ejs = require("ejs");
  return ejs.renderFile(path.join(repo, "views", "privacy.ejs"), { user: null, title: "Privacy Policy", VERSION: "v", UPDATED: "28 October 2026", enforced: true,
                                                                   chatlog: await CL.policy(), micrec, hubErasure: null, ogBase: "" });
};
const NO_PAD_RE = /<td>By the pad's tier: without a tier \(or without a pad\) (\d+) days;(?:(?!<\/td>)[\s\S])*?kept longer only under a legal hold or an open report\./;

test("review 4: a recording whose room Pepe can't tell - the switch needs his 'shortest' rule, so the text's no-pad window (and 'kept longer only under a hold or a report') holds for it", async () => {
  await setup();
  await M.setPolicy(false, "test");
  // an older rule (unknown = the longest = Plus's "for good"): the switch stays off, and the page says nothing about recordings
  await P.noteRetention({ ...FULL, unknown_room: "longest" });
  await assert.rejects(M.setPolicy(true, "test"), (e) => e.code === "unknown_room");
  assert.doesNotMatch(await privacyHtml(await M.privacyCopy()), /without a pad/);
  // his rule: "shortest" = the shortest window of every tier, at most the no-pad one the text names
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
  const m = NO_PAD_RE.exec(await privacyHtml(await M.privacyCopy()));
  assert.ok(m, "section 9's row names the no-pad window");
  assert.equal(Number(m[1]), Math.min(FULL.audio_days, FULL.audio_prime));
  // ...and if he stops keeping that rule after it went on, the admins hear about it (drift, below)
  assert.deepEqual(M.pepeGaps(P.cleanRetention({ ...FULL, unknown_room: "longest" })).map((g) => g.code), ["unknown_room"]);
});

test("review 4 contract: the bot's REAL report and planner (PEPE_BOT_DIR) - an unknown-room recording is deleted at the no-pad window the rendered text states, with a Plus room in the rooms", async (t) => {
  const botDir = process.env.PEPE_BOT_DIR;
  if (!botDir || !fs.existsSync(path.join(botDir, "pepe_retention.py"))) { t.skip("PEPE_BOT_DIR (a camfrog-bot checkout) isn't set"); return; }
  await setup();
  const { execFileSync } = require("child_process");
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "micrec-contract-")), "contract.py");
  fs.writeFileSync(script, [
    "import json, os, sys, tempfile",
    "from datetime import datetime, timedelta",
    "sys.path.insert(0, sys.argv[1])",
    "import pepe_retention as R",
    "R._log = lambda m: None",
    "tmp = tempfile.mkdtemp(prefix='micrec-contract-')",
    "out = {}",
    "for split in (True, False):",
    "    cfg = {'chat_days': 30, 'chat_prime': None, 'rec_days': 30, 'rec_prime': 365, 'pm_days': 30, 'pm_pass': None,",
    "           'chat_plus': None, 'rec_plus': None, 'delete': True, 'split': split}",
    "    d = os.path.join(tmp, 'split' if split else 'nosplit'); tr = os.path.join(d, 'transcripts'); cl = os.path.join(d, 'chatlogs')",
    "    os.makedirs(tr); os.makedirs(cl)",
    "    with open(os.path.join(d, 'retention.json'), 'w', encoding='utf-8') as f: json.dump(cfg, f)",
    "    class Bot(R.RetentionMixin):",
    "        def _rt_cfg_path(self): return os.path.join(d, 'retention.json')",
    "    b = Bot()",
    "    now = datetime(2026, 11, 20, 12, 0, 0)",
    "    ages = [1, 29, 30, 31, 32, 179, 180, 181, 400]",
    "    for n in ages:",
    "        with open(os.path.join(tr, 'ghost_%s_101010.opus' % (now - timedelta(days=n)).strftime('%Y%m%d')), 'wb') as f: f.write(b'o')",
    "    rooms = {'plus.room': 'plus', 'prime.room': True, 'plain.room': False}",
    "    p = R.Retention(d, cl, tr, cfg=b._rt_cfg(), keep=R.Keep()).plan(rooms, set(), True, True, now=now)",
    "    gone = sorted((now.date() - datetime.strptime(os.path.basename(x[0]).split('_')[1], '%Y%m%d').date()).days for x in p['rec_delete'])",
    "    out['split' if split else 'nosplit'] = {'report': b._rt_report_windows(), 'gone': gone, 'kept': [n for n in ages if n not in gone],",
    "                                            'unknown': p['unknown_room_recordings']}",
    "print(json.dumps(out))",
  ].join("\n"));
  const res = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-I", script, botDir], { encoding: "utf8" }).trim().split("\n").pop());
  // split off (as he ships): unknown = the longest (kept for good) - and the switch can't go on with that report
  assert.deepEqual(res.nosplit.gone, [], "split off: an unknown room's recordings are never deleted");
  assert.equal(res.nosplit.report.unknown_room, "longest");
  assert.notEqual(M.pepeGaps(P.cleanRetention(res.nosplit.report)).length, 0);
  // split on: his report says "shortest"; with it the switch's only gap is the room notice (1.99afq: rec_notice false, ops plan 8.8)
  const rep = res.split.report;
  assert.equal(rep.unknown_room, "shortest");
  assert.equal(rep.delete, true);
  assert.equal(res.split.unknown, 9, "every test recording's room is unknown (no transcript, no manifest stamp)");
  await M.setPolicy(false, "test");
  await P.noteRetention(rep);
  assert.deepEqual(M.pepeGaps(P.retention()).map((g) => g.code), rep.rec_notice ? [] : ["notice_missing"]);
  // the letter with the notice: the switch goes on, and the rendered no-pad window is exactly where his planner starts deleting
  await P.noteRetention({ ...rep, rec_notice: true });
  await M.setPolicy(true, "test");
  const m = NO_PAD_RE.exec(await privacyHtml(await M.privacyCopy()));
  assert.ok(m, "section 9's no-pad window is rendered");
  const N = Number(m[1]);
  assert.ok(res.split.kept.every((n) => n <= N), `nothing older than ${N} days is kept: kept ${res.split.kept}`);
  assert.deepEqual(res.split.gone, [...res.split.kept, ...res.split.gone].sort((a, b) => a - b).filter((n) => n > N),
                   "everything past the no-pad window is deleted - although a Plus room (for good) is among his rooms");
  assert.equal(N, 30);
  assert.deepEqual(res.split.gone, [31, 32, 179, 180, 181, 400]);
  await P.noteRetention(FULL);
});

test("review 4: Pepe stops matching the text after the switch went on (split off, deletion off, a rollback) - the chatlog.admin holders are told once per new set of gaps, the card shows them", async () => {
  await setup();
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, email, password, class, points_balance, isEmailVerified) VALUES ('adm4', 'adm4', 'adm4', 'a4@example.com', 'x', 'Admin', 0, 1)");
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
  assert.deepEqual(await M.drift(), { gaps: [], told: 0 });
  const err = console.error; const said = []; console.error = (...a) => said.push(a.join(" "));
  try {
    await P.noteRetention({ ...FULL, split: false, audio_prime: 365, rec_prime: 365 });      // `!retention split off`
    let r = await M.drift();
    assert.deepEqual(r.gaps, ["split_off"]);
    assert.ok(r.told >= 1);
    const n1 = await getQuery("SELECT user_id, title, body, link FROM inbox WHERE ref LIKE 'micrec-drift-%' ORDER BY id");
    assert.ok(n1.some((x) => x.user_id === "adm4"));
    assert.match(n1[0].title, /the privacy text is on, but Pepe doesn't match it/);
    assert.match(n1[0].body, /!retention split on confirm/);
    assert.equal(n1[0].link, "/admin/bridge#micrec");
    assert.ok(said.some((s) => /policy is ON but Pepe doesn't match it: split_off/.test(s)));
    assert.deepEqual(await M.drift(), { gaps: ["split_off"], told: 0 }, "told once per set of gaps");
    assert.deepEqual((await M.adminView()).gaps.map((g) => g.code), ["split_off"], "the card says what");
    // fixed: nothing to say; a later, different gap is told again
    await P.noteRetention(FULL);
    assert.deepEqual((await M.drift()).gaps, []);
    await P.noteRetention({ ...FULL, delete: false });                                        // `!retention delete off`
    r = await M.drift();
    assert.deepEqual(r.gaps, ["delete_off"]);
    assert.ok(r.told >= 1);
    assert.ok((await getQuery("SELECT 1 FROM inbox WHERE ref = 'micrec-drift-2' AND user_id = 'adm4'")).length);
    // the switch stays on - turning it off is the owner's call
    assert.equal(M.policyOn(), true);
  } finally { console.error = err; }
  // with the switch off nothing is drift (the card still says why it can't go on)
  await M.setPolicy(false, "test");
  assert.deepEqual(await M.drift(), { gaps: [], told: 0 });
  assert.deepEqual((await M.adminView()).gaps.map((g) => g.code), ["delete_off"]);
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
  // the tick runs it; the card shows it
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /require\("\.\/micrec"\)\.drift\(\)/);
  assert.match(fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8"), /ON, but Pepe no longer matches the text/);
});

test("review 4: a partial run isn't done (stays open, his answer on the card, asked again a day later) until a clean answer; one not confirmed is told to the admins a week before the give-up and at it, before the logins go", async () => {
  await setup();
  const t0 = clockAt;
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, email, password, class, points_balance, isEmailVerified) VALUES ('adm4', 'adm4', 'adm4', 'a4@example.com', 'x', 'Admin', 0, 1)");
  await P.noteRetention(FULL);
  await M.setPolicy(true, "test");
  await user("pt1", { cf: "Partial1" });
  await D.schedule({ userId: "pt1", username: "pt1" }, { by: "self", reauth: "password", deleteRecordings: true });
  assert.equal((await D.execute("pt1", { force: true })).state, "done");
  const row = async () => (await getQuery("SELECT id, done_at, rec_done_at, rec_windows, rec_partial_note, rec_partial_at, rec_wait_alert FROM account_deletions WHERE user_id = 'pt1'"))[0];
  const acts = () => getQuery("SELECT id, camfrog, status, message FROM pepe_actions WHERE kind = 'privacy.recdelete' AND user_id = 'pt1' ORDER BY id");
  const [a1] = await acts();
  // his follow-up: ran, but part of the storage couldn't be read -> NOT done
  await runQuery("UPDATE pepe_actions SET status = 'done', message = ?, updated = ? WHERE id = ?",
                 ["deleted 2 mic recording file(s) of partial1; part of the recordings storage couldn't be read - Pepe tries again", clockAt, a1.id]);
  let r = await M.retryRecDeletes();
  assert.deepEqual([r.done, r.asked], [0, 0]);
  let d = await row();
  assert.equal(d.rec_done_at, null, "a partial run is not done");
  assert.ok(d.rec_windows && d.rec_windows.includes("partial1"), "the login stays for the retries");
  assert.equal(d.rec_partial_note, "part of the recordings storage couldn't be read - Pepe tries again");
  let card = (await M.adminView()).deletions.rows.find((x) => x.id === d.id);
  assert.equal(card.rec_partial_note, d.rec_partial_note);
  assert.equal(card.rec_due_at, Number(d.done_at) + M.REC_GIVE_UP_MS);
  assert.deepEqual(card.pending_spans.map((w) => w.login), ["partial1"], "a partial run's logins are on the card (admins only) to act on");
  // a day after his answer: asked again (he merges it into his job and answers where it stands)
  clockAt += M.REC_QUEUED_MS + 1;
  r = await M.retryRecDeletes();
  assert.equal(r.asked, 1);
  // he finished: his clean follow-up on the FIRST ask (bot 1.99afq review 4) is enough, the new ask is withdrawn
  await runQuery("UPDATE pepe_actions SET message = 'deleted 5 mic recording file(s) of partial1', updated = ? WHERE id = ?", [clockAt, a1.id]);
  r = await M.retryRecDeletes();
  assert.equal(r.done, 1);
  d = await row();
  assert.ok(d.rec_done_at > 0);
  assert.deepEqual([d.rec_windows, d.rec_partial_note], [null, null]);
  const after = await acts();
  assert.ok(after.every((a) => a.camfrog === null && !/partial1/i.test(String(a.message || ""))), JSON.stringify(after));
  assert.ok(after.every((a) => a.status !== "pending"), "nothing is left for Pepe to take");
  // "a few couldn't be deleted yet" is partial too
  await user("pt2", { cf: "Partial2" });
  await D.schedule({ userId: "pt2", username: "pt2" }, { by: "self", reauth: "password", deleteRecordings: true });
  await D.execute("pt2", { force: true });
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'deleted 1 mic recording file(s) of partial2; a few couldn''t be deleted yet - Pepe tries again', updated = ? WHERE user_id = 'pt2' AND kind = 'privacy.recdelete'", [clockAt]);
  await M.retryRecDeletes();
  assert.equal((await getQuery("SELECT rec_done_at FROM account_deletions WHERE user_id = 'pt2'"))[0].rec_done_at, null);
  // never confirmed: told a week before the give-up (the card then shows the logins), and at it - before the logins go
  await user("wt1", { cf: "Waiting1" });
  await D.schedule({ userId: "wt1", username: "wt1" }, { by: "self", reauth: "password", deleteRecordings: true });
  await D.execute("wt1", { force: true });
  const w = (await getQuery("SELECT id, done_at FROM account_deletions WHERE user_id = 'wt1'"))[0];
  await runQuery("UPDATE pepe_actions SET status = 'pending', updated = ? WHERE user_id = 'wt1' AND kind = 'privacy.recdelete'", [clockAt]);   // Pepe never takes it
  const notes = (stage) => getQuery("SELECT user_id, title, body FROM inbox WHERE ref = ?", [`micrec-wait-${stage}:${w.id}`]);
  await M.retryRecDeletes();
  assert.equal((await notes(1)).length, 0, "not yet");
  assert.equal((await M.adminView()).deletions.rows.find((x) => x.id === w.id).pending_spans, null, "no logins on the card before the warning");
  clockAt = Number(w.done_at) + M.REC_WAIT_WARN_MS + 1;
  r = await M.retryRecDeletes();
  let n = await notes(1);
  assert.ok(n.some((x) => x.user_id === "adm4") && r.wait_alerts >= 1);
  assert.match(n[0].title, new RegExp(`Mic recordings not confirmed deleted \\(account deletion #${w.id}\\)`));
  assert.match(n[0].body, /delete them by hand/);
  assert.deepEqual((await M.adminView()).deletions.rows.find((x) => x.id === w.id).pending_spans.map((s) => s.login), ["waiting1"]);
  await M.retryRecDeletes();
  assert.equal((await notes(1)).filter((x) => x.user_id === "adm4").length, 1, "told once");
  clockAt = Number(w.done_at) + M.REC_GIVE_UP_MS + 1;
  const err = console.error; console.error = () => {};
  try { r = await M.retryRecDeletes(); } finally { console.error = err; }
  assert.ok(r.gave_up >= 1);
  n = await notes(2);
  assert.ok(n.some((x) => x.user_id === "adm4"));
  assert.match(n[0].title, /^NOT DONE: mic recordings of account deletion #/);
  assert.match(n[0].body, /wasn't kept - tell the owner/);
  const g = (await getQuery("SELECT rec_windows, rec_gave_up_at, rec_wait_alert FROM account_deletions WHERE id = ?", [w.id]))[0];
  assert.deepEqual([g.rec_windows, g.rec_wait_alert], [null, 2]);
  assert.ok(g.rec_gave_up_at > 0);
  // no login in any notice
  const all = await getQuery("SELECT title, body FROM inbox WHERE ref LIKE 'micrec-wait-%'");
  assert.ok(all.length >= 2 && all.every((x) => !/waiting1|partial\d/i.test(x.title + x.body)));
  const page = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(page, /r\.rec_partial_note \? ' - his last answer \('/);
  assert.match(page, /r\.pending_spans && r\.pending_spans\.length \? ' - names: '/);
  clockAt = t0;
});

test("review 4: a legal hold on an account reaches every Camfrog login it (or an account merged into it) had, and its account key - not only the login linked now", async () => {
  await setup();
  await user("holdme", { cf: "NowLogin" });
  await user("holdme-old", { cf: "MergedLogin" });
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES ('holdme-old', 'holdme', 1, 'test')");
  await runQuery("INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('holdme', 'oldlogin1', 'nowlogin', 'oldlogin1', 'nowlogin', 5, 'relink')");
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('holdme', 'oldlogin2', NULL, 3, 'unlink', 'camfrog'), ('holdme', 'notalogin', 'x', 3, 'rename', 'username')");
  assert.deepEqual((await M.accountHoldHashes("holdme")).sort(),
                   [H("nowlogin"), H("oldlogin1"), H("oldlogin2"), H("mergedlogin"), H("u:holdme"), H("u:holdme-old")].sort());
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:u:holdme', 'staff', 'court order', 1)");
  const b = await M.keepBlock({ fresh: true });
  assert.equal(b.ok, true);
  for (const h of [H("oldlogin1"), H("oldlogin2"), H("mergedlogin"), H("u:holdme")]) assert.ok(b.held_who_h.includes(h), h);
  assert.ok(!b.held_who_h.includes(H("notalogin")), "a website username isn't a Camfrog login");
  await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:u:holdme'");
  M._resetCache();
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
