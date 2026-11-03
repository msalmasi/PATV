// 1.99?? frog names review fixes at the veil layer (owner 2026-11-03, "Lets do 2": "someone" for 15 minutes after the last named
// sighting in a pad, then a frog name - even mid-visit, never during a mic hold). Each test fails without its fix:
//   own name     a frog name never reads as the person's own display name (a veiled person isn't in the roster's avoid list)
//   mic hold     a snapshot that lists them on the mic, or an item of a hold, never ends the 15 minutes - after a restart (which forgets
//                the hold) and when a batch's snapshot is sighted before the batch's grab
//   early lines  a line said before the frog name took over (sighted after the batch's snapshot, or a backlog) stays "someone"
//   node --test test/frognames-veil-gap.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "frognames-veil-gap-test-")));
const KEY = "b2".repeat(32);
process.env.ALIAS_SECRET = KEY;
const FN = require(path.join(repo, "frognames"));
const V = require(path.join(repo, "veil"));

const MIN = 60e3;
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]+ [A-Z][A-Za-z]+|Mystery Frog \d+)$/;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login) => ({ kind, h: hash(login), at: Date.now() / 1000 });
const veiled = (login, extra = {}, display = null, kind = "incognito") => Object.assign(real(login, display), { priv: priv(kind, login) }, extra);
const clean = (u) => (u && u.login ? { login: u.login, display: u.display || u.login } : null);
/** One snapshot of `room` at `now`: members / mic as Pepe sends them -> page-safe entries with frog names (veil.nameSnapshot). */
async function snapshot(room, members, mic, now) {
  room.members = await V.snapshotEntries(room, members, clean);
  room.mic = await V.snapshotEntries(room, mic, clean, { mic: true, now });
  await V.nameSnapshot(room, now);
  return room;
}
const entry = (room, login, list = "members") => room[list].find((e) => e && e._vz && e._vz.login === login);
/** A veiled feed item at ts, named like bridge.ingest does (veil.nameItem). */
async function item(room, type, login, data, ts, display = null) {
  const it = V.veiledItem({ type, data: Object.assign({ user: Object.assign(real(login, display), { proven: true }), priv: priv("incognito", login) }, data) }, ts);
  assert.ok(it, type + " item");
  await V.nameItem(room, it);
  return it;
}
/** A nonce whose first frog-name draw for (room, login) is acceptable -> {nonce, name}. */
function firstDraw(roomId, login) {
  const key = Buffer.from(KEY, "hex");
  for (let j = 0; ; j++) {
    const nonce = crypto.createHash("sha256").update("first-draw-" + roomId + "-" + login + "-" + j).digest().subarray(0, 16);
    const h = crypto.createHmac("sha256", key);
    for (const p of ["patv/alias/v1\0", roomId, "\0", login.toLowerCase(), "\0", nonce]) h.update(Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"));
    const [a, n] = FN.candidate(h.digest(), 0);
    const name = a + " " + n;
    if (name.length <= FN.NAME_MAX && !FN.denied(name)) return { nonce, name };
  }
}
async function withNonce(nonce, fn) {
  const orig = crypto.randomBytes;
  crypto.randomBytes = (n, ...rest) => (n === 16 && !rest.length ? Buffer.from(nonce) : orig(n, ...rest));
  try { return await fn(); } finally { crypto.randomBytes = orig; }
}

test("1.99?? review fix: a frog name never reads as the person's own display name (roster and feed sightings)", async () => {
  const t = Date.UTC(2026, 10, 14, 12);
  // the roster: their display name IS the name their session's nonce would draw first
  const a = firstDraw("Own.Room", "dispyone");
  const room = { id: "Own.Room" };
  await withNonce(a.nonce, () => snapshot(room, [veiled("dispyone", {}, a.name)], [], t));
  const e = entry(room, "dispyone");
  assert.ok(e && ALIAS_RE.test(String(e.alias)), "a frog name: " + (e && e.alias));
  assert.notEqual(FN.norm(e.alias), FN.norm(a.name), "never their own display name");
  // a feed item (their first sighting is a line, not a roster entry)
  const b = firstDraw("Own.Room", "dispytwo");
  const it = await withNonce(b.nonce, () => item(room, "message", "dispytwo", { text: "hello from dispy two" }, t + 1000, b.name));
  assert.ok(ALIAS_RE.test(String(it.u.alias)), "a frog name: " + it.u.alias);
  assert.notEqual(FN.norm(it.u.alias), FN.norm(b.name), "never their own display name");
});

test("1.99?? review fix: a mic hold Pepe's snapshot shows (after a restart forgot it, or before the batch's grab) keeps 'someone' - the name comes after the release", async () => {
  const t = Date.UTC(2026, 10, 14, 14);
  const room = { id: "Hold.Room" };
  const hold = "hd-0000aaaa1111";
  FN.named(room.id, "micky", t);
  await snapshot(room, [veiled("micky")], [], t + 5 * MIN);
  assert.equal(entry(room, "micky").alias, undefined, "+5: someone");
  const grab = await item(room, "mic.grab", "micky", { hold }, t + 10 * MIN);
  assert.equal(grab.u.alias, undefined, "the grab: someone");
  await snapshot(room, [veiled("micky", { on_mic: true })], [veiled("micky", { proven: true, since: (t + 10 * MIN) / 1000 })], t + 11 * MIN);
  // the site restarts mid-hold: the hold is forgotten, the no-name row comes back
  FN._reset();
  FN._setClock(() => t + 15 * MIN);
  try {
    await snapshot(room, [veiled("micky", { on_mic: true })], [veiled("micky", { proven: true, since: (t + 10 * MIN) / 1000 })], t + 16 * MIN);
    assert.equal(entry(room, "micky").alias, undefined, "+16 after a restart, still on the mic: someone in the people list (was " + entry(room, "micky").alias + ")");
    assert.equal(entry(room, "micky", "mic").alias, undefined, "and in the mic list");
    const tx = await item(room, "x.pepe.transcript", "micky", { id: "tx-0000000000000a01", text: "said on the mic", source: "mic", hold }, t + 17 * MIN);
    assert.equal(tx.u.alias, undefined, "a 🎙 line of the hold: someone");
    const rel = await item(room, "mic.release", "micky", { hold, held_ms: 10 * MIN }, t + 20 * MIN);
    assert.equal(rel.u.alias, undefined, "the release: someone");
    await snapshot(room, [veiled("micky")], [], t + 20 * MIN + 30e3);
    assert.match(String(entry(room, "micky").alias), ALIAS_RE, "after the release: a frog name");
  } finally { FN._setClock(null); }
  // no restart: the 15 minutes end while the batch's snapshot already lists them on the mic, its grab sighted after it
  FN.named(room.id, "batchmic", t);
  await snapshot(room, [veiled("batchmic")], [], t + 5 * MIN);
  await snapshot(room, [veiled("batchmic", { on_mic: true })], [veiled("batchmic", { proven: true, since: (t + 15 * MIN + 50e3) / 1000 })], t + 16 * MIN);
  assert.equal(entry(room, "batchmic", "mic").alias, undefined, "the snapshot's mic entry: someone (was " + entry(room, "batchmic", "mic").alias + ")");
  assert.equal(entry(room, "batchmic").alias, undefined, "the people list: someone");
  const g2 = await item(room, "mic.grab", "batchmic", { hold: "hd-0000aaaa2222" }, t + 15 * MIN + 50e3);
  assert.equal(g2.u.alias, undefined, "the grab: someone");
  await snapshot(room, [veiled("batchmic", { on_mic: true })], [veiled("batchmic", { proven: true, since: (t + 15 * MIN + 50e3) / 1000 })], t + 18 * MIN);
  assert.equal(entry(room, "batchmic", "mic").alias, undefined, "mid-hold: someone");
  await item(room, "mic.release", "batchmic", { hold: "hd-0000aaaa2222", held_ms: 3 * MIN }, t + 19 * MIN);
  await snapshot(room, [veiled("batchmic")], [], t + 19 * MIN + 30e3);
  assert.match(String(entry(room, "batchmic").alias), ALIAS_RE, "after the release: a frog name");
});

test("1.99?? review fix: a line said before the frog name took over stays 'someone' (sighted after its batch's snapshot, or a backlog)", async () => {
  const t = Date.UTC(2026, 10, 14, 16);
  const room = { id: "Early.Room" };
  FN.named(room.id, "laggy", t);
  await snapshot(room, [veiled("laggy")], [], t + 5 * MIN);
  const before = FN.current(room.id, "laggy");
  assert.ok(before && before.alias === null);
  // one batch after an outage: the snapshot (now = +16) is sighted first, then the lines said meanwhile, in order
  await snapshot(room, [veiled("laggy")], [], t + 16 * MIN);
  const frog = entry(room, "laggy").alias;
  assert.match(String(frog), ALIAS_RE, "the people list: a frog name from now on");
  const l8 = await item(room, "message", "laggy", { text: "said at eight" }, t + 8 * MIN);
  const l15 = await item(room, "message", "laggy", { text: "said just before fifteen" }, t + 15 * MIN - 2000);
  for (const [it, w] of [[l8, "+8"], [l15, "+14:58"]]) {
    assert.equal(it.u.alias, undefined, w + ": someone (was " + it.u.alias + ")");
    assert.equal(it.u.id, undefined, w + ": no session id");
    assert.equal(it._vz.sess, before.session, w + ": the no-name session's line");
  }
  const l17 = await item(room, "message", "laggy", { text: "said at seventeen" }, t + 17 * MIN);
  assert.equal(l17.u.alias, frog, "a line after it: the frog name");
  assert.deepEqual(FN.current(room.id, "laggy").alias, frog, "the session is the frog name's");
});
