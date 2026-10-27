// "Download my data" with the member's choices (mic retention, owner answers 2026-10-27; accountexport.js; the wire:
// the ops plan mic-audio-retention-2026-10-27 §7.2): chat logs / mic transcripts / what Pepe remembers / mic recordings.
//   * an older form (no choices) gets today's export; the site's own lines follow the chat / transcript boxes;
//   * Pepe's options only while he runs the release that gathers them (his report carries the audio windows - bot 1.99afq);
//     recordings only while the mic-recordings policy switch is on and the account has a linked Camfrog login;
//   * Pepe's part is asked with the website action privacy.export [id, parts, before (unix s)?] and arrives as ONE zip in slices
//     (POST /api/privacy/export/bot/chunk + /finish, bot token, the bot's pepe_mydata._md_upload shape) - idempotent per slice,
//     only while the download waits for him, capped, checked (size, sha256, a zip); it rides in the member's zip as pepe-data.zip,
//     stored; next_before (older recordings that didn't fit) reaches the README and the form;
//   * his ok: false, or no answer (asked again, never while his ask still waits for him; given up after 72 h): the zip without his
//     part, the README says why;
//   * bounded: recordings exports in flight; account deletion removes his slices and withdraws the ask.
//   NODE_PATH=G:/PATV/node_modules node --test test/account-export-pepe.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
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
let X, M, P, runQuery, getQuery, server, base;
const FULL = { chat_days: 30, chat_prime: null, chat_plus: null, rec_days: 30, rec_prime: null, rec_plus: null, audio_days: 30, audio_prime: 180, audio_plus: null,
               pm_days: 30, pm_pass: null, split: true };
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
const member = (u) => ({ "x-user": u, origin: base, "x-requested-with": "fetch" });
const job = async (id) => (await getQuery("SELECT * FROM account_exports WHERE id = ?", [id]))[0];
const asks = async (id) => getQuery("SELECT * FROM pepe_actions WHERE kind = 'privacy.export' AND idem LIKE ? ORDER BY id", [`export-${id}-%`]);
async function waitState(id, want) {
  for (let i = 0; i < 400; i++) { const j = await job(id); if (j && j.state === want) return j; await new Promise((r) => setTimeout(r, 50)); }
  return job(id);
}
async function waitAsked(id) {
  for (let i = 0; i < 400; i++) { const j = await job(id); if (j && j.state === "queued" && j.pepe_state === "wait") return j; await new Promise((r) => setTimeout(r, 50)); }
  return job(id);
}
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
  for (const x of [X, M, P]) x._setClock(() => clockAt);
  await X.init();
  await P.init();
  await M.init();
  for (const [id, cf] of [["me", "MeCF"], ["nolink", null], ["u1", "cf1"], ["u2", "cf2"], ["u3", "cf3"], ["u4", "cf4"], ["u5", "cf5"]]) {
    await runQuery("INSERT INTO users (userId, username, email, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, id, `${id}@example.com`, cf]);
  }
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
  assert.deepEqual(g.offer, { pepe: false, recordings: false, rec_max_mb: 256 });
  assert.equal((await X.request("me", { parts: { memories: true } })).code, "E_PEPE_OFF");
  assert.equal((await X.request("me", { parts: { recordings: true } })).code, "E_REC_OFF");
  const r = await post("/api/account/export", { parts: { recordings: true } }, member("me"));
  assert.deepEqual([r.status, r.d.code], [409, "E_REC_OFF"]);
  await P.noteRetention(FULL);
  g = await (await fetch(base + "/api/account/export", { headers: { "x-user": "me" } })).json();
  assert.deepEqual(g.offer, { pepe: true, recordings: false, rec_max_mb: 256 }, "the switch is off: no recordings");
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
  d = await X.collect("me");
  assert.equal(d.chat.pad_chat_lines.length, 2, "an older form: everything the site keeps");
  assert.equal(d.included, undefined);
  assert.deepEqual(X.cleanParts({}), { chat: true, transcripts: true, memories: false, recordings: false, rec_before: null }, "the defaults");
  assert.equal(X.cleanParts({ recordings: "yes" }).recordings, false, "only a strict true");
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

test("Pepe's part: asked as the bot reads it, his zip in slices (dup ok; conflicts, caps and bad files refused), checked at finish, stored in the member's zip", async () => {
  await setup();
  clockAt += DAY + 1;
  const before = Date.UTC(2026, 9, 20);
  const r = await post("/api/account/export", { parts: { chat: true, transcripts: true, memories: true, recordings: true, rec_before: before } }, member("me"));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const id = r.d.id;
  let j = await waitAsked(id);
  assert.deepEqual([j.state, j.pepe_state, j.pepe_attempt, j.rec], ["queued", "wait", 1, 1]);
  const a = (await asks(id))[0];
  assert.equal(a.camfrog, "mecf");
  assert.deepEqual(JSON.parse(a.args), [id, "chat,transcripts,memories,recordings", String(before / 1000)], "[id, parts, before (unix s)] - pepe_mydata._md_web_export");
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
  assert.ok((await job(id)).pepe_bytes >= pz.length, "what's staged is counted (the disk budget)");
  const nextBefore = Math.floor(Date.UTC(2026, 9, 15) / 1000);
  p = await post("/api/privacy/export/bot/finish", { password: "bot", id, ok: true, size: pz.length, sha256: h, name: `patv-pepe-data-${id}.zip`,
                                                    parts: ["chat", "transcripts", "memories", "recordings"], counts: { recordings: 1 }, left_out: 3, next_before: nextBefore,
                                                    truncated: [], before: before / 1000 });
  assert.equal(p.status, 200, JSON.stringify(p.d));
  assert.equal(p.d.ok, true);
  j = await waitState(id, "ready");
  assert.equal(j.state, "ready", JSON.stringify(j));
  const z = unzip(fs.readFileSync(path.join(X._dir(), j.file)));
  assert.deepEqual(Object.keys(z).sort(), ["README.txt", "patv-data.json", "pepe-data.zip"]);
  assert.equal(z["pepe-data.zip"].method, 0, "stored, not recompressed");
  assert.ok(z["pepe-data.zip"].data.equals(pz), "Pepe's zip, byte for byte");
  assert.ok(unzip(z["pepe-data.zip"].data)["recordings/2026-10/mecf_20261019_100000.opus"].data.equals(rec1));
  const readme = z["README.txt"].data.toString("utf8");
  assert.match(readme, /mic recordings: yes/);
  assert.match(readme, /pepe-data\.zip: Pepe's part \(chat logs, mic transcripts, what Pepe remembers about you, mic recordings\)/);
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
});

test("his ok: false, or no answer: the download without his part (asked again only after his ask was taken; given up after 72 h); the README says why", async () => {
  await setup();
  // ok: false (the archive unreachable): built at once, without his part
  clockAt += DAY + 1;
  let r = await X.request("me", { parts: { chat: true, transcripts: false, memories: true } });
  await waitAsked(r.id);
  assert.deepEqual(JSON.parse((await asks(r.id))[0].args), [r.id, "chat,memories"]);
  const f = await post("/api/privacy/export/bot/finish", { password: "bot", id: r.id, ok: false, error: "archive unreachable" });
  assert.equal(f.status, 200, JSON.stringify(f.d));
  let j = await waitState(r.id, "ready");
  let readme = unzip(fs.readFileSync(path.join(X._dir(), j.file)))["README.txt"].data.toString("utf8");
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
  // he took it (answered "preparing") and went quiet -> asked again
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE kind = 'privacy.export' AND idem = ?", [`export-${id}-1`]);
  await X.pepeTick();
  let list = await asks(id);
  assert.deepEqual(list.map((x) => [x.idem, x.status]), [[`export-${id}-1`, "done"], [`export-${id}-2`, "pending"]]);
  assert.equal((await job(id)).pepe_attempt, 2);
  // a slice of an earlier build is thrown away when a new one (another sha256) starts
  const old = Buffer.from("PK\u0003\u0004old build");
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq: 0, total: 2, size: 2000, sha256: sha(old), data: old.toString("base64") })).status, 200);
  const nb = X.zip([{ name: "README.txt", data: "new" }]);
  assert.equal((await post("/api/privacy/export/bot/chunk", { password: "bot", id, seq: 0, total: 1, size: nb.length, sha256: sha(nb), data: nb.toString("base64") })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(X._dir(), id + ".pepe")), [sha(nb)]);
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
});

test("bounds: at most 3 recordings exports in flight; account deletion removes Pepe's slices and withdraws the ask", async () => {
  await setup();
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
  const readme = unzip(fs.readFileSync(path.join(X._dir(), j.file)))["README.txt"].data.toString("utf8");
  assert.match(readme, /Pepe's part \(mic recordings\): not included - Pepe couldn't send it \(no linked Camfrog login any more\)/);
});

test("the form: the choices are sent, Pepe's rows shown only when offered, the right messages, where to go on", async () => {
  const view = fs.readFileSync(path.join(repo, "views", "settingsAccount.ejs"), "utf8");
  for (const k of ["settings.data.include", "settings.data.chat", "settings.data.transcripts", "settings.data.memories", "settings.data.recordings", "settings.data.rec_before", "settings.data.pepe_off"]) {
    assert.ok(view.includes(`t('${k}')`), k);
  }
  assert.match(view, /account-security\.js\?v=4/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "account-security.js"), "utf8");
  assert.match(js, /post\('\/api\/account\/export', partsBody\(\)\)/);
  assert.match(js, /xMemRow\.hidden = !OFFER\.pepe/);
  assert.match(js, /xRecRow\.hidden = !OFFER\.recordings/);
  assert.match(js, /js\.acct\.exp_next_before/);
  for (const c of ["E_REC_OFF", "E_PEPE_OFF", "E_REC_BUSY"]) assert.ok(js.includes(`j.code === '${c}'`), c);
});
