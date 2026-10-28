// "Download my data" with the member's choices (mic retention, owner answers 2026-10-27; accountexport.js; the wire:
// the ops plan mic-audio-retention-2026-10-27 §7.2): chat logs / mic transcripts / what Pepe remembers / mic recordings.
//   * an older form (no choices) gets today's export; the site's own lines follow the chat / transcript boxes (picked in SQL);
//   * Pepe's options only while he runs the release that gathers them (his report carries the audio windows - bot 1.99afq);
//     recordings only while the mic-recordings policy switch is on and the account has a linked Camfrog login;
//   * Pepe's part is asked with the website action privacy.export [id, parts, before (unix s)?] and arrives as ONE zip in slices
//     (POST /api/privacy/export/bot/chunk + /finish, bot token, the bot's pepe_mydata._md_upload shape) - idempotent per slice,
//     only while the download waits for him, capped, checked (size, sha256, a zip); it rides in the member's zip as pepe-data.zip,
//     stored (streamed); next_before (older recordings that didn't fit) reaches the README and the form - a plausible one only;
//   * his ok: false, or no answer (asked again, never while his ask still waits for him nor while his slices arrive; given up after
//     72 h): the zip without his part, the README says why;
//   * bounded: recordings exports in flight, Pepe's asks in flight site-wide (more wait their turn); account deletion removes his
//     slices and withdraws the ask; a zip built for a job that went away meanwhile is deleted, never announced; stray zips swept.
//   Review (1.99afr): a login another PATV account held before (its history, a merge is the same account, a deleted account's
//   marker) gets no Pepe part; a dated ask carries recordings alone (the bot applies `before` to everything - pinned against the
//   real pepe_mydata when PEPE_BOT_DIR names a camfrog-bot checkout); Pepe's part needs a password or a fresh sign-in, and is
//   announced in the inbox.
//   NODE_PATH=G:/PATV/node_modules node --test test/account-export-pepe.test.js
//   PEPE_BOT_DIR=G:/wt/micret-bot (+ PYTHON=python) also runs the contract test against the bot's real pepe_mydata.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctexp-pepe-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ACCOUNT_EXPORT_PEPE_MAX_MB = "1";          // a 1 MB cap on Pepe's zip, so the cap is testable
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const DAY = 86400000, MB = 1024 * 1024;
let clockAt = Date.UTC(2026, 9, 28, 12);
let X, M, P, CL, runQuery, getQuery, server, base;
// (review 4: + what the switch needs besides the windows - deletion on, unknown rooms the shortest window, his room notice naming recordings)
const FULL = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null, audio_days: 30, audio_prime: 180, audio_plus: null,
               pm_days: 30, pm_pass: null, split: true, delete: true, unknown_room: "shortest", rec_notice: true };
const OLD = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: 365, rec_plus: null, pm_days: 30, pm_pass: null };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Every file of a zip of ours: deflate (8) or stored (0); the CRC checked. */
function unzip(buf) {
  const files = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8), crc = buf.readUInt32LE(o + 14);
    const csize = buf.readUInt32LE(o + 18), nlen = buf.readUInt16LE(o + 26), xlen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.slice(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    const raw = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    assert.equal(X.crc32(raw), crc, "crc of " + name);
    files[name] = { data: raw, method };
    o += 30 + nlen + xlen + csize;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, "the end record closes it");
  assert.equal(buf.readUInt16LE(buf.length - 22 + 10), Object.keys(files).length, "the central directory counts every file");
  return files;
}
const post = async (url, body, headers = {}) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
};
// a member's same-origin fetch; signed in in the last 10 minutes unless fresh: false (the step-up for Pepe's part)
const member = (u, { fresh = true } = {}) => ({ "x-user": u, origin: base, "x-requested-with": "fetch", ...(fresh ? { "x-fresh": "1" } : {}) });
const job = async (id) => (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
const asks = async (id) => getQuery("SELECT * FROM pepe_actions WHERE kind = 'privacy.export' AND idem LIKE ? ORDER BY id", [`export-${id}-%`]);
const readmeOf = (j) => unzip(fs.readFileSync(path.join(X._dir(), j.file)))["README.txt"].data.toString("utf8");
async function waitState(id, want) {
  for (let i = 0; i < 400; i++) { const j = await job(id); if (j && j.state === want) return j; await new Promise((r) => setTimeout(r, 50)); }
  return job(id);
}
async function waitAsked(id) {
  for (let i = 0; i < 400; i++) { const j = await job(id); if (j && j.state === "queued" && j.pepe_state === "wait") return j; await new Promise((r) => setTimeout(r, 50)); }
  return job(id);
}
/** Earlier tests' jobs still waiting for Pepe count against the site-wide cap: closed before a test that needs asks. */
const settle = () => runQuery("UPDATE account_exports SET state = 'failed' WHERE state IN ('queued','running')");
/** Pepe's upload, as pepe_mydata._md_upload sends it: slices of `slice` bytes, then the finish with his meta. */
async function upload(id, buf, { slice = 256 * 1024, meta = {} } = {}) {
  const total = Math.max(1, Math.ceil(buf.length / slice)), h = sha(buf);
  for (let seq = 0; seq < total; seq++) {
    const r = await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq, total, size: buf.length, sha256: h,
                                                            data: buf.slice(seq * slice, (seq + 1) * slice).toString("base64") });
    if (r.status !== 200) return r;
  }
  return post("/api/privacy/export/bot/finish", { password: "bot", id, ok: true, size: buf.length, sha256: h, name: `patv-pepe-data-${id}.zip`, ...meta });
}

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  X = require(path.join(repo, "accountexport"));
  M = require(path.join(repo, "micrec"));
  P = require(path.join(repo, "premium"));
  CL = require(path.join(repo, "chatlog"));
  for (const x of [X, M, P]) x._setClock(() => clockAt);
  // the step-up's "signed in in the last 10 minutes": a header here (sessions.isFresh reads the login session)
  require(path.join(repo, "sessions")).isFresh = async (req) => !!(req && req.get && req.get("x-fresh") === "1");
  await X.init();
  await P.init();
  await M.init();
  const users = [["me", "MeCF"], ["nolink", null], ["u1", "cf1"], ["u2", "cf2"], ["u3", "cf3"], ["u4", "cf4"], ["u5", "cf5"], ["sh1", "shared1"], ["mg1", "merged1"],
                 ["gn1", "gone1"], ["rc1", "recheck1"], ["rz1", "race1"], ["cl1", "clamp1"], ["ra1", "reauth1"], ["ra2", "reauth2"], ["ra3", "reauth3"],
                 ["dt1", "dated1"], ["cap1", "capcf1"], ["cap2", "capcf2"], ["cap3", "capcf3"], ["cap4", "capcf4"], ["cap5", "capcf5"], ["cap6", "capcf6"], ["heavy", "heavycf"]];
  for (const [id, cf] of users) {
    await runQuery("INSERT INTO users (userId, username, email, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, id, `${id}@example.com`, cf]);
  }
  await runQuery("UPDATE users SET password = ? WHERE userId = 'ra1'", [require("bcrypt").hashSync("right-pass-1", 4)]);
  await runQuery("INSERT INTO chatlog_rooms (rk, room_id, created) VALUES (1, 'Lab.Room', 1)");
  await runQuery(`INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (11, 1, 1760000000000, 'msg', 'mecf', 'MY-ROOM-LINE', 'r1', 'a', '{}'),
                  (12, 1, 1760000001000, 'tx', 'mecf', 'MY-MIC-LINE', 'r1', 'm', '{}')`);
  const express = require("express");
  const app = express();
  // like index.js: the global parser stays off the route that parses its own (bigger) bodies
  app.use((req, res, next) => (req.path === "/api/privacy/export/bot/chunk" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const u = req.get("x-user"); req.user = u ? { userId: u } : null; next(); };
  X.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
})());
test.after(() => { if (server) { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } });

test("the choices: an older form gets today's export; the site's lines follow the boxes; Pepe's options need his release, recordings the switch + a login", async () => {
  await setup();
  // nothing of Pepe's offered yet: an older Pepe (no audio windows in his report), the switch off
  await P.noteRetention(OLD);
  let g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "me" } })).json();
  assert.deepEqual(g.offer, { pepe: false, recordings: false, login_shared: false, rec_max_mb: 256 });
  assert.deepEqual(g.reauth, { fresh: false, password: true }, "the form learns whether Pepe's part needs the password now");
  assert.equal((await X.request("me", { parts: { memories: true } })).code, "E_PEPE_OFF");
  assert.equal((await X.request("me", { parts: { recordings: true } })).code, "E_REC_OFF");
  const r = await post("/api/account/export", { parts: { recordings: true } }, member("me"));
  assert.deepEqual([r.status, r.d.code], [409, "E_REC_OFF"]);
  await P.noteRetention(FULL);
  g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "me", "x-fresh": "1" } })).json();
  assert.deepEqual(g.offer, { pepe: true, recordings: false, login_shared: false, rec_max_mb: 256 }, "the switch is off: no recordings");
  assert.equal(g.reauth.fresh, true);
  await M.setPolicy(true, "admin");
  assert.equal((await X.offer("me")).recordings, true);
  assert.equal((await X.offer("nolink")).recordings, false, "no linked Camfrog login: no recordings");
  assert.equal((await X.offer("nolink")).pepe, true, "...but Pepe's memories of the account");
  // the site's own lines follow the boxes (kind "mic" = a transcript line)
  let d = await X.collect("me", { parts: X.cleanParts({ chat: true, transcripts: false }) });
  assert.deepEqual(d.chat.pad_chat_lines.map((l) => l.text), ["MY-ROOM-LINE"]);
  assert.deepEqual(d.included, { chat_logs: true, mic_transcripts: false, pepe_memories: false, mic_recordings: false });
  d = await X.collect("me", { parts: X.cleanParts({ chat: false, transcripts: true }) });
  assert.deepEqual(d.chat.pad_chat_lines.map((l) => l.text), ["MY-MIC-LINE"]);
  d = await X.collect("me", { parts: X.cleanParts({ chat: false, transcripts: false }) });
  assert.deepEqual(d.chat.pad_chat_lines, []);
  d = await X.collect("me");
  assert.equal(d.chat.pad_chat_lines.length, 2, "an older form: everything the site keeps");
  assert.equal(d.included, undefined);
  assert.deepEqual(X.cleanParts({}), { chat: true, transcripts: true, memories: false, recordings: false, rec_before: null }, "the defaults");
  assert.equal(X.cleanParts({ recordings: "yes" }).recordings, false, "only a strict true");
  assert.equal(X.cleanParts({ rec_before: Date.UTC(2026, 0, 1) }).rec_before, null, "a date without recordings means nothing");
  assert.equal(X.cleanParts(null), null);
  // an older form: no Pepe part, the zip at once
  const old = await X.request("me");
  const j = await waitState(old.id, "ready");
  assert.equal(j.state, "ready");
  assert.equal(j.pepe_state, null);
  assert.equal((await asks(old.id)).length, 0, "Pepe isn't asked");
  const z = unzip(fs.readFileSync(path.join(X._dir(), j.file)));
  assert.deepEqual(Object.keys(z).sort(), ["README.txt", "patv-data.json"]);
});

test("review: the site's own lines are picked by kind in SQL, before the row cap (a heavy chatter who ticks only transcripts still gets them)", async () => {
  await setup();
  await CL.init();
  await runQuery(`INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (21, 1, 1760000000000, 'msg', 'heavycf', 'H1', 'r1', 'a', '{}'),
                  (22, 1, 1760000001000, 'msg', 'heavycf', 'H2', 'r1', 'a', '{}'), (23, 1, 1760000002000, 'msg', 'heavycf', 'H3', 'r1', 'a', '{}'),
                  (24, 1, 1760000003000, 'tx', 'heavycf', 'H-MIC', 'r1', 'm', '{}')`);
  assert.deepEqual((await CL.exportLines("heavy", "heavycf", 2, { mic: true, other: false })).map((l) => l.text), ["H-MIC"]);
  assert.deepEqual((await CL.exportLines("heavy", "heavycf", 2, { mic: false, other: true })).map((l) => l.text), ["H1", "H2"]);
  assert.deepEqual(await CL.exportLines("heavy", "heavycf", 2, { mic: false, other: false }), []);
  assert.equal((await CL.exportLines("heavy", "heavycf", 10)).length, 4, "no kinds: every line");
});

test("Pepe's part: a dated ask carries recordings alone; his zip in slices (dup ok; conflicts, caps and bad files refused), checked at finish, stored in the member's zip", async () => {
  await setup();
  clockAt += DAY + 1;
  const before = Date.UTC(2026, 9, 20);
  const r = await post("/api/account/export", { parts: { chat: true, transcripts: true, memories: true, recordings: true, rec_before: before } }, member("me"));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const id = r.d.id;
  let j = await waitAsked(id);
  assert.deepEqual([j.state, j.pepe_state, j.pepe_attempt, j.rec, j.pepe], ["queued", "wait", 1, 1, 1]);
  const a = (await asks(id))[0];
  assert.equal(a.camfrog, "mecf");
  // review: the bot applies `before` to EVERY part it builds - so a dated ask is recordings alone, the rest waits for an undated one
  assert.deepEqual(JSON.parse(a.args), [id, "recordings", String(before / 1000)], "[id, parts, before (unix s)] - pepe_mydata._md_web_export");
  assert.deepEqual(JSON.parse(j.parts).pepe_left, ["chat", "transcripts", "memories"]);
  // review: a download with Pepe's part is announced (a live session someone else holds would show)
  const note = (await getQuery("SELECT title, body FROM inbox WHERE user_id = 'me' AND ref = ?", [`export-asked:${id}`]))[0];
  assert.ok(note && /copy of your data/.test(note.title) && /mic recordings/.test(note.body) && /wasn't you/.test(note.body), JSON.stringify(note));
  // the tick leaves a job waiting for Pepe alone (no re-ask while his ask is fresh)
  await X.tick();
  assert.equal((await asks(id)).length, 1);
  // his zip (a real one: the site checks it is a zip)
  const rec1 = crypto.randomBytes(300 * 1024);
  const pz = X.zip([{ name: "README.txt", data: "Your data from Pepe" }, { name: "recordings/2026-10/mecf_20261019_100000.opus", data: rec1 }], new Date(clockAt));
  assert.ok(pz.length > 300 * 1024 && pz.length < MB);
  const SL = 128 * 1024, h = sha(pz), total = Math.ceil(pz.length / SL);
  const slice = (seq, body = {}) => post("/api/privacy/export/bot/chunk", { password: "bot", id, seq, total, size: pz.length, sha256: h,
                                                                           data: pz.slice(seq * SL, (seq + 1) * SL).toString("base64"), ...body });
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "nope", id, seq: 0, total, size: pz.length, sha256: h, data: "" })).status, 403);
  assert.equal((await post("/api/privacy/export/bot/finish", { password: "nope", id, ok: true, size: pz.length, sha256: h })).status, 403, "the finish: the bot's token too");
  assert.equal((await slice(0, { id: "not-ours" })).status, 400);
  assert.equal((await slice(0, { size: 2 * MB })).d.code, "E_CAP", "over the cap (1 MB in this test)");
  assert.equal((await slice(0, { sha256: "xyz" })).status, 400);
  assert.equal((await slice(total)).status, 400, "a slice number past the count");
  let p = await slice(0);
  assert.equal(p.status, 200, JSON.stringify(p.d));
  assert.equal((await slice(0)).d.dup, true, "the same slice again: ok");
  assert.equal((await slice(0, { data: Buffer.from("other").toString("base64") })).d.code, "E_SEQ");
  for (let s = 1; s < total - 1; s++) assert.equal((await slice(s)).status, 200);
  // the finish before every slice is in, or for another file: refused (he sends the missing slice / starts over)
  assert.equal((await post("/api/privacy/export/bot/finish", { password: "bot", id, ok: true, size: pz.length, sha256: h })).d.code, "E_SEQ");
  assert.equal((await slice(total - 1)).status, 200);
  assert.equal((await post("/api/privacy/export/bot/finish", { password: "bot", id, ok: true, size: pz.length, sha256: "0".repeat(64) })).d.code, "E_SEQ");
  j = await job(id);
  assert.equal(j.pepe_bytes, pz.length, "what's staged is counted as it comes - a duplicate slice once");
  assert.equal(j.pepe_slice_at, clockAt, "and when his last slice came");
  const nextBefore = Math.floor(Date.UTC(2026, 9, 15) / 1000);
  p = await post("/api/privacy/export/bot/finish", { password: "bot", id, ok: true, size: pz.length, sha256: h, name: `patv-pepe-data-${id}.zip`,
                                                    parts: ["recordings"], counts: { recordings: 1 }, left_out: 3, next_before: nextBefore,
                                                    truncated: [], before: before / 1000 });
  assert.equal(p.status, 200, JSON.stringify(p.d));
  assert.equal(p.d.ok, true);
  j = await waitState(id, "ready");
  assert.equal(j.state, "ready", JSON.stringify(j));
  const z = unzip(fs.readFileSync(path.join(X._dir(), j.file)));
  assert.deepEqual(Object.keys(z).sort(), ["README.txt", "patv-data.json", "pepe-data.zip"]);
  assert.equal(z["pepe-data.zip"].method, 0, "stored, not recompressed");
  assert.ok(z["pepe-data.zip"].data.equals(pz), "Pepe's zip, byte for byte (streamed in pieces, its crc patched in)");
  assert.ok(unzip(z["pepe-data.zip"].data)["recordings/2026-10/mecf_20261019_100000.opus"].data.equals(rec1));
  const readme = z["README.txt"].data.toString("utf8");
  assert.match(readme, /mic recordings: yes/);
  assert.match(readme, /pepe-data\.zip: Pepe's part \(mic recordings\)/);
  assert.match(readme, /Pepe's part \(chat logs, mic transcripts, what Pepe remembers about you\): not in this download - you asked for recordings from before a date/);
  assert.match(readme, /covers your Camfrog name now only/, "review: the scope is said");
  assert.match(readme, /can be heard in it too/, "review: a recording is the room's sound - others on the mic can be in it");
  assert.match(readme, /pick "Only recordings before" 2026-10-15/);
  assert.equal(JSON.parse(z["patv-data.json"].data).included.mic_recordings, true);
  assert.ok(!fs.existsSync(path.join(X._dir(), id + ".pepe")), "his slices and zip are gone once the member's zip is built");
  assert.deepEqual(JSON.parse(j.pepe_summary).next_before, nextBefore);
  // the form learns where to go on
  const g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "me" } })).json();
  assert.equal(g.exports.find((x) => x.id === id).next_before, nextBefore * 1000);
  assert.equal(g.exports.find((x) => x.id === id).pepe_summary, undefined, "the summary itself stays on the site");
  assert.equal((await slice(0)).d.code, "E_GONE", "a late slice");
  // the download: the owner's only (read to the end: a half-read body would hold the server open)
  const dl = await fetch(`${base}/settings/account/export/${id}`, { headers: { "x-user": "me" } });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, j.bytes);
  const other = await fetch(`${base}/settings/account/export/${id}`, { headers: { "x-user": "u1" } });
  assert.equal(other.status, 410);
  await other.text();
  // an undated ask: every part, no `before`
  const u = await post("/api/account/export", { parts: { chat: true, transcripts: true, memories: true, recordings: true } }, member("dt1"));
  assert.equal(u.status, 200, JSON.stringify(u.d));
  await waitAsked(u.d.id);
  assert.deepEqual(JSON.parse((await asks(u.d.id))[0].args), [u.d.id, "chat,transcripts,memories,recordings"]);
});

test("his ok: false, or no answer: the download without his part (asked again only after his ask was taken and no slice came lately; given up after 72 h); the README says why", async () => {
  await setup();
  await settle();
  // ok: false (the archive unreachable): built at once, without his part
  clockAt += DAY + 1;
  let r = await X.request("me", { parts: { chat: true, transcripts: false, memories: true } });
  await waitAsked(r.id);
  assert.deepEqual(JSON.parse((await asks(r.id))[0].args), [r.id, "chat,memories"]);
  const f = await post("/api/privacy/export/bot/finish", { password: "bot", id: r.id, ok: false, error: "archive unreachable" });
  assert.equal(f.status, 200, JSON.stringify(f.d));
  let j = await waitState(r.id, "ready");
  let readme = readmeOf(j);
  assert.match(readme, /Pepe's part \(chat logs, what Pepe remembers about you\): not included - Pepe couldn't send it \(archive unreachable\)/);
  // no answer
  clockAt += DAY + 1;
  r = await X.request("me", { parts: { chat: true, transcripts: false, memories: true } });
  const id = r.id;
  await waitAsked(id);
  // Pepe down: the ask stays pending - never a pile of asks
  clockAt += X.PEPE_RETRY_MS + 1;
  await X.pepeTick();
  assert.equal((await asks(id)).length, 1);
  // he took it (answered "preparing") and is uploading: a slice just came -> not asked again, his slices stay
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'privacy.export' AND idem = ?", [`export-${id}-1`]);
  const busy = Buffer.from("PK\u0003\u0004busy uploading");
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq: 0, total: 2, size: 2000, sha256: sha(busy), data: busy.toString("base64") })).status, 200);
  await X.pepeTick();
  assert.equal((await asks(id)).length, 1, "review: an upload in progress is never asked again");
  // ...and went quiet -> asked again; the ask leaves his staged slices alone (a new build replaces them itself)
  clockAt += X.PEPE_SLICE_QUIET_MS + 1;
  await X.pepeTick();
  let list = await asks(id);
  assert.deepEqual(list.map((x) => [x.idem, x.status]), [[`export-${id}-1`, "done"], [`export-${id}-2`, "pending"]]);
  assert.equal((await job(id)).pepe_attempt, 2);
  assert.deepEqual(fs.readdirSync(path.join(X._dir(), id + ".pepe")), [sha(busy)], "review: the ask again didn't delete them");
  // a slice of an earlier build is thrown away when a new one (another sha256) starts - and its staged bytes with it
  const old = Buffer.from("PK\u0003\u0004old build");
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq: 0, total: 2, size: 2000, sha256: sha(old), data: old.toString("base64") })).status, 200);
  const nb = X.zip([{ name: "README.txt", data: "new" }]);
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq: 0, total: 1, size: nb.length, sha256: sha(nb), data: nb.toString("base64") })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(X._dir(), id + ".pepe")), [sha(nb)]);
  assert.equal((await job(id)).pepe_bytes, nb.length, "the earlier builds' bytes aren't counted any more");
  // 72 h after the request: built without it, the ask withdrawn, the README says why
  clockAt += X.PEPE_WAIT_MS;
  await X.tick();
  j = await waitState(id, "ready");
  assert.equal(j.pepe_state, "gave_up");
  list = await asks(id);
  assert.equal(list[1].status, "failed", "the pending ask is withdrawn");
  const z = unzip(fs.readFileSync(path.join(X._dir(), j.file)));
  assert.deepEqual(Object.keys(z).sort(), ["README.txt", "patv-data.json"]);
  readme = z["README.txt"].data.toString("utf8");
  assert.match(readme, /Pepe's part \(chat logs, what Pepe remembers about you\): not included - Pepe didn't send it in time\./);
  // a finish that doesn't match what was sent (not a zip): refused, the slices go, the download still waits for a good one
  clockAt += DAY + 1;
  r = await X.request("me", { parts: { memories: true } });
  await waitAsked(r.id);
  const bad = Buffer.from("not a zip at all, just text");
  assert.equal((await upload(r.id, bad)).d.code, "E_SHA");
  assert.equal((await job(r.id)).pepe_state, "wait");
  assert.equal((await job(r.id)).pepe_bytes, 0);
});

test("bounds: at most 3 recordings exports in flight; account deletion removes Pepe's slices and withdraws the ask", async () => {
  await setup();
  await settle();
  const ids = [];
  for (const u of ["u1", "u2", "u3"]) {
    const r = await X.request(u, { parts: { recordings: true } });
    assert.equal(r.ok, true, JSON.stringify(r));
    ids.push(r.id);
  }
  for (const id of ids) await waitAsked(id);
  const busy = await post("/api/account/export", { parts: { recordings: true } }, member("u4"));
  assert.deepEqual([busy.status, busy.d.code], [429, "E_REC_BUSY"]);
  assert.equal((await X.request("u4", { parts: { chat: true } })).ok, true, "without recordings: fine");
  // a slice in, then the account is deleted
  const pz = X.zip([{ name: "README.txt", data: "x" }]);
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id: ids[0], seq: 0, total: 1, size: pz.length, sha256: sha(pz), data: pz.toString("base64") })).status, 200);
  assert.ok(fs.existsSync(path.join(X._dir(), ids[0] + ".pepe")));
  await X.removeAll("u1");
  assert.ok(!fs.existsSync(path.join(X._dir(), ids[0] + ".pepe")));
  assert.equal((await job(ids[0])).state, "expired");
  assert.equal((await asks(ids[0]))[0].status, "failed");
  assert.equal((await post("/api/privacy/export/bot/finish", { password: "bot", id: ids[0], ok: true, size: pz.length, sha256: sha(pz) })).d.code, "E_GONE");
  const st = await X.pepeStatus();
  assert.equal(st.rec_inflight, 2);
  assert.equal(st.rec_jobs_max, 3);
});

test("recordings only, and the Camfrog login unlinked before Pepe is asked again: nothing to ask him - built without his part", async () => {
  await setup();
  await settle();
  const r = await X.request("u5", { parts: { chat: false, transcripts: false, recordings: true } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitAsked(r.id);
  await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = 'u5'");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'privacy.export' AND idem = ?", [`export-${r.id}-1`]);
  clockAt += X.PEPE_RETRY_MS + 1;
  await X.pepeTick();
  assert.equal((await asks(r.id)).length, 1, "no empty ask is queued");
  assert.equal((await job(r.id)).pepe_state, "done");
  await X.tick();
  const j = await waitState(r.id, "ready");
  assert.match(readmeOf(j), /Pepe's part \(mic recordings\): not included - Pepe couldn't send it \(no linked Camfrog login any more\)/);
});

test("review: a login another PATV account held before gets no Pepe part (history; a merged account is the same one; a deleted account's marker); re-checked when he's asked", async () => {
  await setup();
  await settle();
  clockAt += DAY + 1;
  // another account had "shared1" once (an unlink in its login history)
  const markAt = clockAt - 90 * DAY;
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('other', 'shared1', NULL, ?, 'unlink', 'camfrog')", [markAt]);
  // review 2: the site's own lines under the login - the earlier holder's (before its unlink; one incognito) and sh1's (after)
  await runQuery(`INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (31, 1, ?, 'msg', 'shared1', 'THEIR-ROOM-LINE', 'r1', 'a', '{}'),
                  (32, 1, ?, 'tx', ?, 'THEIR-INCOG-MIC', 'r1', 'm', '{}'), (33, 1, ?, 'msg', 'shared1', 'SH1-ROOM-LINE', 'r1', 'a', '{}'),
                  (34, 1, ?, 'msg', 'u:sh1', 'SH1-WEB-LINE', 'r1', 'a', '{}')`,
                 [markAt - DAY, markAt - DAY + 1000, "h:" + CL.hash("shared1"), markAt + DAY, markAt - 2 * DAY]);
  let o = await X.offer("sh1");
  assert.deepEqual([o.pepe, o.recordings, o.login_shared], [false, false, true]);
  assert.equal((await X.request("sh1", { parts: { memories: true } })).code, "E_PEPE_OFF", "his memories of the login would be theirs too");
  assert.equal((await X.request("sh1", { parts: { recordings: true } })).code, "E_REC_OFF");
  const r = await X.request("sh1", { parts: { chat: true, transcripts: true } });
  assert.equal(r.ok, true);
  let j = await waitState(r.id, "ready");
  assert.equal((await asks(r.id)).length, 0, "Pepe isn't asked");
  assert.deepEqual(JSON.parse(j.parts).pepe, []);
  assert.match(readmeOf(j), /Pepe's part \(chat logs, mic transcripts\): not included - your Camfrog name was linked to another PATV account before yours/);
  // review 2: the site's own lines under that login start when it became sh1's (the rule Pepe's part follows); its web lines all
  const data = JSON.parse(unzip(fs.readFileSync(path.join(X._dir(), j.file)))["patv-data.json"].data.toString("utf8"));
  assert.deepEqual(data.chat.pad_chat_lines.map((l) => l.text).sort(), ["SH1-ROOM-LINE", "SH1-WEB-LINE"]);
  const day = new Date(markAt).toISOString().slice(0, 10);
  assert.match(data.chat.pad_chat_lines_note, new RegExp(`^Your lines under your Camfrog name start ${day}: another PATV account had that name before you`));
  assert.ok(readmeOf(j).includes(`chat.pad_chat_lines: Your lines under your Camfrog name start ${day}`));
  assert.equal(await M.ownSince("me", "mecf"), 0, "a login nobody else held: all its lines");
  assert.equal((await X.collect("me")).chat.pad_chat_lines_note, undefined);
  // review 3: no note when no lines were asked for (neither box), and none when who held the name couldn't be checked - every line
  // under the login is left out then and the error says why, but "another PATV account had that name" may be untrue
  assert.equal((await X.collect("sh1", { parts: { chat: false, transcripts: false, memories: true } })).chat.pad_chat_lines_note, undefined);
  const ownSince0 = M.ownSince;
  M.ownSince = async () => { throw new Error("the db is gone"); };
  try {
    const e = await X.collect("sh1", { parts: { chat: true, transcripts: true } });
    assert.equal(e.chat.pad_chat_lines_note, undefined, "the check failed: no claim that another account had the name");
    assert.deepEqual(e.chat.pad_chat_lines.map((l) => l.text), ["SH1-WEB-LINE"], "the lines under the login are left out");
    assert.ok(e.errors.some((x) => /who held your Camfrog name before couldn't be checked - lines under it were left out/.test(x)));
  } finally { M.ownSince = ownSince0; }
  const g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "sh1" } })).json();
  assert.equal(g.offer.login_shared, true, "the form says why");
  // an account merged INTO this one is this one: its records of the login don't count
  await runQuery("INSERT INTO login_changes (userId, old_login, new_login, old_key, new_key, at, via) VALUES ('mg-old', 'mgprev', 'merged1', 'mgprev', 'merged1', ?, 'relink')", [clockAt - 40 * DAY]);
  await runQuery("INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES ('mg-old', 'mg1', ?, 'test')", [clockAt - 30 * DAY]);
  o = await X.offer("mg1");
  assert.deepEqual([o.pepe, o.login_shared], [true, false]);
  assert.deepEqual([...(await M.holderIds("mg1"))].sort(), ["mg-old", "mg1"]);
  // a deleted account's marker (its login history is pseudonymised): keyed, never the name
  assert.equal((await X.offer("gn1")).login_shared, false);
  assert.equal(await M.noteLoginsGone([{ login: "Gone1", at: clockAt - 5 * DAY }]), 1);
  assert.equal((await X.offer("gn1")).login_shared, true);
  const marks = await getQuery("SELECT h, at FROM micrec_login_gone");
  assert.ok(marks.length >= 1 && marks.every((m) => /^[0-9a-f]{32}$/.test(m.h) && !m.h.includes("gone1")));
  // asked, then the login turns out shared before he's asked again: nothing more is asked of him, built without his part
  const r2 = await X.request("rc1", { parts: { chat: true, transcripts: false } });
  await waitAsked(r2.id);
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via, kind) VALUES ('other2', 'recheck1', NULL, ?, 'seen', 'camfrog')", [clockAt - 10 * DAY]);
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'privacy.export' AND idem = ?", [`export-${r2.id}-1`]);
  clockAt += X.PEPE_RETRY_MS + 1;
  await X.pepeTick();
  assert.equal((await asks(r2.id)).length, 1);
  assert.deepEqual([(await job(r2.id)).pepe_state, (await job(r2.id)).pepe_error], ["done", "login_shared"]);
  await X.tick();
  j = await waitState(r2.id, "ready");
  assert.match(readmeOf(j), /Pepe's part \(chat logs\): not included - your Camfrog name was linked to another PATV account before yours/);
});

test("review: Pepe's part needs the password or a fresh sign-in (wrong ones capped); without his part no step-up", async () => {
  await setup();
  await settle();
  X._resetReauth();
  const g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "ra1" } })).json();
  assert.deepEqual(g.reauth, { fresh: false, password: true });
  let r = await post("/api/account/export", { parts: { chat: true } }, member("ra1", { fresh: false }));
  assert.deepEqual([r.status, r.d.code], [403, "E_REAUTH"]);
  for (let i = 0; i < X.REAUTH_TRIES; i++) {
    r = await post("/api/account/export", { parts: { chat: true }, password: "wrong-" + i }, member("ra1", { fresh: false }));
    assert.deepEqual([r.status, r.d.code], [403, "E_REAUTH"], "try " + i);
  }
  r = await post("/api/account/export", { parts: { chat: true }, password: "right-pass-1" }, member("ra1", { fresh: false }));
  assert.deepEqual([r.status, r.d.code], [429, "E_REAUTH_LIMIT"], "too many wrong ones: even the right one waits");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM account_exports WHERE user_id = 'ra1'"))[0].n, 0, "a refusal doesn't use up the day's export");
  X._resetReauth();
  r = await post("/api/account/export", { parts: { chat: true }, password: "right-pass-1" }, member("ra1", { fresh: false }));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  // a fresh sign-in: no password needed
  r = await post("/api/account/export", { parts: { chat: true } }, member("ra3"));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  // an older form (no choices: no Pepe part) needs neither
  r = await post("/api/account/export", {}, member("ra2", { fresh: false }));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal((await asks(r.d.id)).length, 0);
});

test("review: Pepe's times are checked before they become dates (an implausible next_before is dropped, never a failed job)", async () => {
  await setup();
  await settle();
  const r = await X.request("cl1", { parts: { chat: false, transcripts: false, recordings: true } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitAsked(r.id);
  const pz = X.zip([{ name: "README.txt", data: "clamp" }]);
  const f = await upload(r.id, pz, { meta: { parts: ["recordings"], next_before: 99999999999999, before: "soon", left_out: 2 } });
  assert.equal(f.status, 200, JSON.stringify(f.d));
  const j = await waitState(r.id, "ready");
  assert.equal(j.state, "ready", JSON.stringify(j));
  const sum = JSON.parse(j.pepe_summary);
  assert.equal(sum.next_before, undefined);
  assert.equal(sum.before, undefined);
  assert.doesNotMatch(readmeOf(j), /Only recordings before/);
  assert.equal((await X.mine("cl1"))[0].next_before, null);
  assert.equal(X.cleanSec(Math.floor(clockAt / 1000)), Math.floor(clockAt / 1000));
  assert.equal(X.cleanSec("12"), null);
});

test("review: a zip built for a job that went away meanwhile (account deletion) is deleted and never announced; stray zips are swept", async () => {
  await setup();
  await settle();
  X._setBeforeReady(async (jb) => { X._setBeforeReady(null); await X.removeAll(jb.user_id); });
  const r = await X.request("rz1");
  const j = await waitState(r.id, "expired");
  for (let i = 0; i < 100 && fs.existsSync(path.join(X._dir(), r.id + ".zip")); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(j.state, "expired");
  assert.ok(!fs.existsSync(path.join(X._dir(), r.id + ".zip")), "the orphan zip is deleted at once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'rz1' AND ref = ?", [`export:${r.id}`]))[0].n, 0, "nobody is told it's ready");
  // the sweep: a zip no ready row names (once it's an hour old), an old half-written one; a fresh one and a ready one stay
  const d = X._dir();
  const put = (name, ageMs) => { const f = path.join(d, name); fs.writeFileSync(f, "x"); const s = (clockAt - ageMs) / 1000; fs.utimesSync(f, s, s); return f; };
  const stray = put("a".repeat(32) + ".zip", 2 * X.ORPHAN_MS);
  const tmp = put("b".repeat(32) + ".zip.tmp-1-abc", 2 * X.ORPHAN_MS);
  const fresh = put("c".repeat(32) + ".zip", 0);
  const ready = (await getQuery("SELECT file FROM account_exports WHERE state = 'ready' AND file IS NOT NULL LIMIT 1"))[0];
  if (ready) { const s = (clockAt - 2 * X.ORPHAN_MS) / 1000; fs.utimesSync(path.join(d, ready.file), s, s); }
  await X.sweepFiles();
  assert.ok(!fs.existsSync(stray) && !fs.existsSync(tmp));
  assert.ok(fs.existsSync(fresh), "a zip moments old may be about to get its row");
  if (ready) assert.ok(fs.existsSync(path.join(d, ready.file)), "a ready export stays");
  fs.unlinkSync(fresh);
});

test("review: at most PEPE_JOBS_MAX asks of Pepe in flight - more wait their turn (shown as waiting for him), oldest first; one that waited 72 h is built without", async () => {
  await setup();
  await settle();
  const ids = [];
  for (const u of ["cap1", "cap2", "cap3", "cap4"]) { const r = await X.request(u, { parts: { chat: true } }); ids.push(r.id); }
  for (const id of ids) await waitAsked(id);
  assert.equal(X.PEPE_JOBS_MAX, 4);
  const held = await X.request("cap5", { parts: { chat: true } });
  await new Promise((r) => setTimeout(r, 200));
  let h = await job(held.id);
  assert.deepEqual([h.state, h.pepe_state, h.pepe], ["queued", null, 1]);
  assert.equal((await asks(held.id)).length, 0, "not asked while 4 are in flight");
  assert.equal((await X.mine("cap5"))[0].waiting_pepe, 1, "the member sees it waiting for Pepe");
  assert.equal((await X.pepeStatus()).held, 1);
  // one finishes -> the next tick asks the one waiting its turn
  await post("/api/privacy/export/bot/finish", { password: "bot", id: ids[0], ok: false, error: "nothing" });
  await waitState(ids[0], "ready");
  await X.tick();
  h = await waitAsked(held.id);
  assert.equal(h.pepe_state, "wait");
  assert.equal((await asks(held.id)).length, 1);
  // a job that waited its turn for 72 h: built without his part, the README says why
  const late = await X.request("cap6", { parts: { chat: true } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await job(late.id)).pepe_state, null);
  clockAt += X.PEPE_WAIT_MS + 1;
  await X.pepeTick();
  const j = await waitState(late.id, "ready");
  assert.deepEqual([j.pepe_state, j.pepe_error], ["gave_up", "busy"]);
  assert.match(readmeOf(j), /not included - Pepe was busy with other people's downloads for too long/);
  await settle();
});

test("contract: the site's privacy.export args through the bot's REAL pepe_mydata (PEPE_BOT_DIR) - `before` limits everything he builds, so a dated ask is recordings alone", async (t) => {
  const botDir = process.env.PEPE_BOT_DIR;
  if (!botDir || !fs.existsSync(path.join(botDir, "pepe_mydata.py"))) { t.skip("PEPE_BOT_DIR (a camfrog-bot checkout) isn't set"); return; }
  await setup();
  const B = Math.floor(Date.UTC(2026, 9, 20) / 1000);
  const cases = [
    // what the site sends now: a dated ask (recordings alone), an undated one (every part)
    { camfrog: "mecf", args: ["a".repeat(32), "recordings", String(B)] },
    { camfrog: "mecf", args: ["b".repeat(32), "chat,transcripts,memories,recordings"] },
    // what the site must NOT send (the review's bug): a date with other parts - the bot cuts them all
    { camfrog: "mecf", args: ["c".repeat(32), "chat,transcripts,memories,recordings", String(B)] },
  ];
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mydata-contract-")), "contract.py");
  fs.writeFileSync(script, [
    "import json, os, sys, tempfile",
    "sys.path.insert(0, sys.argv[1])",
    "import pepe_mydata as MD",
    "MD._log = lambda m: None",
    "class Eng:",
    "    def __init__(self): self.calls = []",
    "    def person_transcripts(self, login, before=None): self.calls.append(['transcripts', before]); return []",
    "    def person_chat_lines(self, login, before=None): self.calls.append(['chat', before]); return iter(())",
    "    def person_recordings(self, login, before=None, stats=None): self.calls.append(['recordings', before]); return []",
    "class Mic:",
    "    def get_sessions(self, login, since=None, room=None): return [{'timestamp': 1000000000.0}, {'timestamp': 4000000000.0}]",
    "class Bot(MD.MyDataMixin):",
    "    def __init__(self, d): self._md_base = d; self.mic_session_store = Mic()",
    "out, tmp = [], tempfile.mkdtemp(prefix='site-contract-')",
    "for c in json.loads(open(sys.argv[2], encoding='utf-8').read()):",
    "    b = Bot(tmp); st = b._md(); st['busy'] = True",
    "    ok, msg = b._md_web_export({'id': 1, 'camfrog': c['camfrog']}, c['args'])",
    "    job = st['q'][0] if st['q'] else None",
    "    rec = {'ok': ok, 'parts': job and job['parts'], 'before': job and job['before']}",
    "    if job:",
    "        eng = Eng()",
    "        meta = b._md_build(eng, job['login'], job['parts'], job['before'], 10 ** 9, 10 ** 9, os.path.join(tmp, 'x.zip'))",
    "        rec['calls'] = eng.calls; rec['mic_sessions'] = meta['counts'].get('mic_sessions')",
    "    out.append(rec)",
    "print(json.dumps(out))",
  ].join("\n"));
  const input = script.replace(/contract\.py$/, "cases.json");
  fs.writeFileSync(input, JSON.stringify(cases));
  const out = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-I", script, botDir, input], { encoding: "utf8" }).trim().split("\n").pop());
  // 1. the site's dated ask: recordings only, before B
  assert.deepEqual([out[0].ok, out[0].parts, out[0].before], [true, ["recordings"], B]);
  assert.deepEqual(out[0].calls, [["recordings", B]]);
  // 2. the site's undated ask: every part, nothing cut
  assert.deepEqual([out[1].ok, out[1].parts, out[1].before], [true, ["chat", "transcripts", "recordings", "memories"], null]);
  assert.deepEqual(out[1].calls.map((c) => c[1]), [null, null, null]);
  assert.equal(out[1].mic_sessions, 2);
  // 3. why the site splits: with a date the bot cuts chat, transcripts and the mic log too. If this ever fails, the bot applies
  //    `before` to recordings only - the site's split (accountexport.request: pepe_left) can then go.
  assert.deepEqual(out[2].calls.filter((c) => c[0] !== "recordings").map((c) => c[1]), [B, B], "the bot applies `before` to chat and transcripts");
  assert.equal(out[2].mic_sessions, 1, "...and to the mic log in memories");
  // and the site never sends case 3: its dated ask (test above) is recordings alone
  const sent = await getQuery("SELECT args FROM pepe_actions WHERE kind = 'privacy.export'");
  for (const s of sent) { const a = JSON.parse(s.args); if (a.length > 2) assert.equal(a[1], "recordings", "a dated ask is recordings alone: " + s.args); }
});

test("the form: the choices are sent, Pepe's rows shown only when offered, the right messages, where to go on, the step-up, the scope", async () => {
  const view = fs.readFileSync(path.join(repo, "views", "settingsAccount.ejs"), "utf8");
  for (const k of ["settings.data.include", "settings.data.chat", "settings.data.transcripts", "settings.data.memories", "settings.data.recordings", "settings.data.rec_before",
                   "settings.data.pepe_off", "settings.data.rec_before_note", "settings.data.pepe_scope", "settings.data.pepe_shared", "settings.data.reauth", "settings.data.reauth_sso"]) {
    assert.ok(view.includes(`t('${k}')`), k);
  }
  assert.match(view, /account-security\.js\?v=5/);
  assert.match(view, /id="expPw" autocomplete="current-password"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "account-security.js"), "utf8");
  assert.match(js, /post\('\/api\/account\/export', partsBody\(\)\)/);
  assert.match(js, /xMemRow\.hidden = !OFFER\.pepe/);
  assert.match(js, /xRecRow\.hidden = !OFFER\.recordings/);
  assert.match(js, /xShared\.hidden = !OFFER\.login_shared/);
  assert.match(js, /js\.acct\.exp_next_before/);
  assert.match(js, /rec_max_mb \|\| 256/, "review: the fallback is the bot's real limit");
  assert.match(js, /b\.password = xPw\.value/);
  for (const c of ["E_REC_OFF", "E_PEPE_OFF", "E_REC_BUSY", "E_REAUTH", "E_REAUTH_LIMIT"]) assert.ok(js.includes(`j.code === '${c}'`), c);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  // review: the copy says what the download really holds (ops plan 8.9)
  assert.match(en["js.acct.exp_rec_meta"], /more than one mic/);
  assert.match(en["settings.data.transcripts_meta"], /more than one mic/);
  assert.match(en["settings.data.chat_meta"], /private messages with Pepe, both sides/);
  assert.match(en["settings.data.memories_meta"], /accounts an admin linked to yours/);
  assert.doesNotMatch(en["settings.data.lede"], /recording/, "the lede (not behind the switch) names no recordings");
  // review 2: no promise that deleting the account reaches the names linked before (it asks Pepe to forget only the name now, and
  // deletes recordings only with "Also delete my mic recordings", which is behind the switch)
  const src = fs.readFileSync(path.join(repo, "accountexport.js"), "utf8");
  for (const s of [en["settings.data.pepe_scope"], /const README_SCOPE = "([^"]*)"/.exec(src)[1]]) {
    assert.doesNotMatch(s, /deleting your account/i, s);
    assert.match(s, /privacy@publicaccess\.tv/, s);
  }
});

test("review 4: the round trip of 'ask again with an earlier date' - the README and the form quote the first midnight at or after Pepe's next_before, and the form sends next_before itself while that day is picked (no gap between two downloads)", async () => {
  await setup();
  await settle();
  await P.noteRetention(FULL);
  await M.setPolicy(true, "admin");
  // the day to quote: never the day OF next_before (its first hours would be in neither download)
  assert.equal(X.nextDay(Date.UTC(2026, 9, 15) / 1000), "2026-10-15", "exactly midnight: that day");
  assert.equal(X.nextDay(Date.UTC(2026, 9, 15) / 1000 + 1), "2026-10-16");
  assert.equal(X.nextDay(Date.UTC(2026, 9, 15, 15, 4, 6) / 1000), "2026-10-16");
  const NB = Date.UTC(2026, 9, 15, 15, 4, 6) / 1000;                     // the first recording left out was at 15:04:05 UTC (+ 1 s)
  const readme = X._readmeChoices({ recordings: true, pepe: ["recordings"] }, { got: true, sum: { next_before: NB } });
  const quoted = /pick "Only recordings before" (\d{4}-\d{2}-\d{2})/.exec(readme);
  assert.ok(quoted, readme);
  assert.ok(Date.parse(quoted[1] + "T00:00:00Z") >= NB * 1000, "the day typed in by hand (its midnight UTC) reaches the first one left out");
  assert.match(readme, /the download page fills that in and starts exactly where this one stopped/);
  // the form, run for real (public/js/account-security.js in a vm against this server): a member whose last download didn't fit
  await runQuery("INSERT OR IGNORE INTO users (userId, username, email, password, camfrogUsername) VALUES ('rt1', 'rt1', 'rt1@example.com', 'x', 'roundtrip1')");
  const far = Math.max(Date.now(), clockAt) + 3 * DAY;
  await runQuery(`INSERT INTO account_exports (id, user_id, created, state, file, bytes, finished, expires, pepe, pepe_state, pepe_summary)
                  VALUES ('rt-ready-1', 'rt1', ?, 'ready', 'none.zip', 1, ?, ?, 1, 'done', ?)`, [clockAt - 2 * DAY, clockAt - 2 * DAY, far, JSON.stringify({ next_before: NB })]);
  const g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "rt1" } })).json();
  const mine = g.exports.find((x) => x.id === "rt-ready-1");
  assert.deepEqual([mine.next_before, mine.next_day], [NB * 1000, "2026-10-16"]);
  const vm = require("vm");
  const els = {};
  const mk = (id) => {
    const on = {};
    const el = { id, value: "", checked: false, hidden: false, disabled: false, textContent: "", className: "", style: {}, children: [], dataset: {},
                 addEventListener: (ev, f) => { (on[ev] = on[ev] || []).push(f); }, fire: (ev) => (on[ev] || []).forEach((f) => f({})),
                 appendChild: (c) => { el.children.push(c); return c; }, setAttribute() {}, focus() {} };
    return el;
  };
  const document = { documentElement: { lang: "en" }, getElementById: (id) => els[id] || (els[id] = mk(id)), createElement: (tag) => mk(tag),
                     createTextNode: (t) => ({ text: String(t) }) };
  const calls = [];
  const fakeFetch = (url, o = {}) => {
    const hs = {};
    for (const [k, v] of Object.entries({ ...(o.headers || {}), ...member("rt1") })) hs[k.toLowerCase()] = v;   // as a browser sends them
    const p = fetch(base + url, { ...o, headers: hs });
    calls.push({ url, o, p, copy: p.then((r) => r.clone()) });          // (cloned before the page reads it)
    return p;
  };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "account-security.js"), "utf8"),
                     { window: { confirm: () => true }, document, fetch: fakeFetch, location: {}, setTimeout: () => 0, console });
  const settled = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await settled(() => els.expBefore && els.expBefore.value);
  assert.equal(els.expBefore.value, "2026-10-16", "the form fills in the day the README quotes");
  const shown = els.expList.children.flatMap((li) => li.children.map((c) => c.text || "")).join(" ");
  assert.match(shown, /ask again with “Only recordings before” 2026-10-16/);
  // recordings alone, the day left as filled in: Pepe is asked from exactly where the last download stopped
  els.expChat.checked = false; els.expTx.checked = false; els.expMem.checked = false; els.expRec.checked = true;
  els.expBtn.fire("click");
  await settled(() => calls.some((c) => c.o.method === "POST"));
  const sent = calls.find((c) => c.o.method === "POST");
  await sent.p;
  assert.equal(JSON.parse(sent.o.body).parts.rec_before, NB * 1000, "next_before itself - not 2026-10-16's midnight, not 2026-10-15's");
  const resp = await (await sent.copy).json().catch(() => null);
  const job1 = (await getQuery("SELECT id FROM account_exports WHERE user_id = 'rt1' AND id != 'rt-ready-1' ORDER BY created DESC LIMIT 1"))[0];
  assert.ok(job1, "the request was made: " + JSON.stringify(resp));
  await waitAsked(job1.id);
  assert.deepEqual(JSON.parse((await asks(job1.id))[0].args), [job1.id, "recordings", String(NB)], "Pepe gets the exact point (bot: recordings before it)");
  // a day picked by hand is that day's midnight UTC
  els.expBefore.value = "2026-10-10";
  els.expBtn.disabled = false;
  els.expBtn.fire("click");
  await settled(() => calls.filter((c) => c.o.method === "POST").length > 1);
  const hand = calls.filter((c) => c.o.method === "POST")[1];
  await hand.p;
  assert.equal(JSON.parse(hand.o.body).parts.rec_before, Date.UTC(2026, 9, 10));
  await settle();
});
