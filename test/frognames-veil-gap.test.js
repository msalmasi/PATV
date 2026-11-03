// 1.99?? frog names review fixes at the veil layer (owner 2026-11-03, "Lets do 2": "someone" for 15 minutes after the last named
// sighting in a pad, then a frog name - even mid-visit, never during a mic hold). Each test fails without its fix:
//   own name     a frog name never reads as the person's own display name (a veiled person isn't in the roster's avoid list)
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
