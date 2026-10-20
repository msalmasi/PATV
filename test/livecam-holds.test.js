// micfollow: a live-cam session can have several stage holders (livecam.js S.holds) - a cam slot and the pad's 🎙 mic
// stage ("mf:<room>") share ONE Pepe publish; two cam slots still can't; letting go of one holder keeps the other's
// viewers; viewers who came only through the mic stage are kicked with it and never noted one by one; Pepe is asked for
// exact opens (want[].mf), reports live[].exact and advertises mf; the end / opt-out hooks; yielding a relay.
//   node --test test/livecam-holds.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcholds-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const B = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const CV = require(path.join(repo, "camviewers"));

W.enabled = () => true;
let T = 1_000_000_000_000;
LC._setClock(() => T);
const kicked = [];
LC._setKick((id) => kicked.push(id));
relay.padFull = async () => true;
// train2 merge: stagefix's per-viewer gate (livecam.stageViewerWhy - the cam's access mode, members by default) runs on every
// stage watch; these viewers count as verified members
require(path.join(repo, "camaccess"))._setDeps({ verified: async () => true });
const noted = [];
CV.noteViewers = (kind, room, owner, ids) => { noted.push([kind, room, owner, ...ids]); return Promise.resolve(ids.length); };

const R = { id: "Hold.Room", slug: "hold-room", cams: true, livecams: true, members: [
  { login: "alice", display: "Alice", on_cam: true }, { login: "bob", display: "Bob", on_cam: true }, { login: "carl", display: "Carl", on_cam: true }] };
const MF = "mf:" + R.id;
const bot = (extra) => LC.forBot(Object.assign({ cap: true }, extra || {}), T);
const tick = (whep) => new URL(whep).searchParams.get("pt");
const pathOf = (whep) => new URL(whep).pathname.split("/").pop();
const read = (whep, id) => LC.auth({ path: pathOf(whep), query: "pt=" + encodeURIComponent(tick(whep)), id }, "read", "webrtc");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('v9', 'v9', 'v9', 'x', 'viewer9')");
  await LC.init();
  await LC.save({ class: "Admin", userId: "a", username: "admin" }, { cfg: { enabled: true } });
  B._rooms.set(R.id, R);
});

test("a cam slot and the mic stage share one session; two slots still can't; Pepe gets one want entry, marked mf", async () => {
  await bot({ mf: 1 });
  assert.equal(LC.botMf(), 1, "Pepe advertises the mic stage");
  await LC.stageHold(R, "alice", "slot1", T);
  await assert.rejects(LC.stageHold(R, "alice", "slot2", T), (e) => e.code === "on_stage", "one cam slot per cam");
  await LC.stageHold(R, "alice", MF, T, { mf: true });
  const S = LC._sessions.get(LC.keyOf(R.id, "alice"));
  assert.deepEqual([...S.holds].sort(), [MF, "slot1"].sort());
  assert.equal(S.mf, true);
  const w = (await bot({ mf: 1 })).want.filter((x) => x.login === "alice");
  assert.equal(w.length, 1, "one publish");
  assert.equal(w[0].mf, true, "Pepe opens it by its exact name");
  assert.equal(LC.mfState(R.id, "alice").held, true);
  assert.equal(LC.mfState(R.id, "alice").mfOnly, false, "a slot holds it too");
  assert.equal(LC.stageState("slot1", T).state, "connecting");
});

test("viewers: releasing one holder keeps the other's; via-only-mf viewers are kicked; mf-only viewers aren't noted", async () => {
  const slotV = await LC.stageWatch({ userId: "u1" }, R, "slot1", {}, T);
  const mfV = await LC.stageWatch({ userId: "u2" }, R, MF, { login: "alice" }, T);
  const both = await LC.stageWatch({ userId: "u3" }, R, MF, { login: "alice" }, T);
  await LC.stageWatch({ userId: "u3" }, R, "slot1", {}, T);
  await assert.rejects(LC.stageWatch({ userId: "u4" }, R, MF, { login: "bob" }, T), (e) => e.code === "gone", "the mic stage doesn't hold bob");
  noted.length = 0;
  // a viewer who came ONLY through the mic stage reads nothing until Pepe reports the relay exact (never the wrong "Bob")
  assert.equal(await read(mfV.whep), 403, "mic stage only + exact unknown");
  await bot({ mf: 1, live: [{ room: R.id, login: "alice", state: "live", exact: false }] });
  assert.equal(await read(mfV.whep), 403, "mic stage only + exact false");
  await bot({ mf: 1, live: [{ room: R.id, login: "alice", state: "live", exact: true }] });
  assert.equal(await read(slotV.whep, "11111111-1111-1111-1111-111111111111"), 200);
  assert.equal(await read(mfV.whep, "22222222-2222-2222-2222-222222222222"), 200);
  assert.equal(await read(both.whep, "33333333-3333-3333-3333-333333333333"), 200);
  assert.deepEqual(noted.map((n) => n[3]).sort(), ["u1", "u3"], "the mic-only viewer (u2) isn't noted one by one");
  assert.equal(await LC.auth({ path: pathOf(mfV.whep), query: "pt=" + encodeURIComponent(tick(mfV.whep)) }, "read", "hls"), 403, "never HLS");
  // the mic stage lets go: u2 (mic only) is kicked; u1 (slot) and u3 (both) stay
  kicked.length = 0;
  LC.stageRelease(MF, LC.keyOf(R.id, "alice"), T);
  const S = LC._sessions.get(LC.keyOf(R.id, "alice"));
  assert.deepEqual([...S.stageViewers.keys()].sort(), ["u1", "u3"]);
  assert.ok(kicked.includes("22222222-2222-2222-2222-222222222222"));
  assert.equal(S.mf, false, "no mic-stage holder left");
  assert.equal(LC.mfState(R.id, "alice").held, false);
  assert.equal((await bot({ mf: 1 })).want.find((x) => x.login === "alice").mf, undefined);
  // the slot ends: everyone through it goes; the relay lingers then ends unwatched
  LC.stageRelease("slot1", T);
  assert.equal(S.stageViewers.size, 0);
  T += 5 * 60 * 1000; LC.sweep(T);
  assert.equal(LC.mfState(R.id, "alice").state, "ended");
  T += 2 * 60 * 1000; LC.sweep(T);
});

test("exact reports, mf-only counting, yield, the end + opt-out hooks", async () => {
  const ends = [], outs = [];
  LC.onEnd((S, why) => ends.push([S.login, why]));
  LC.onOptout((login, off) => outs.push([login, off]));
  await bot({ mf: 1 });
  await LC.stageHold(R, "bob", MF, T, { mf: true });
  assert.equal(LC.mfState(R.id, "bob").exact, null, "unknown until Pepe says");
  await bot({ mf: 1, live: [{ room: R.id, login: "bob", state: "live", exact: true }] });
  assert.equal(LC.mfState(R.id, "bob").exact, true);
  assert.equal(LC.mfState(R.id, "bob").mfOnly, true);
  assert.equal(LC.mfOnlyCount(T), 1);
  // a ▶ Live viewer makes it shared (not mic-only any more)
  await LC.start({ userId: "v9", username: "v9" }, R, "bob", T);
  assert.equal(LC.mfState(R.id, "bob").mfOnly, false);
  LC.stop("v9", R.id, "bob", T);
  assert.equal(LC.mfState(R.id, "bob").mfOnly, true);
  // yield: let go and end it (nobody else holds / watches)
  assert.equal(LC.stageYield(R.id, "bob", MF, T), true);
  assert.equal(LC.mfState(R.id, "bob").state, "ended");
  assert.deepEqual(ends.pop(), ["bob", "yielded"]);
  // an opt-out ends a mic-held session and both hooks run
  await LC.stageHold(R, "carl", MF, T, { mf: true });
  await LC.setOptout("carl", true, { ts: T });
  assert.deepEqual(outs.pop(), ["carl", true]);
  assert.deepEqual(ends.pop(), ["carl", "opted_out"]);
  await LC.setOptout("carl", false, { ts: T + 1 });
  // an "ambiguous" refusal from Pepe (exact open found two people) ends it
  T += 2 * 60 * 1000; LC.sweep(T);
  await bot({ mf: 1 });
  await LC.stageHold(R, "carl", MF, T, { mf: true });
  await bot({ mf: 1, refused: [{ room: R.id, login: "carl", why: "ambiguous" }] });
  assert.deepEqual(ends.pop(), ["carl", "ambiguous"]);
  // a throwing hook is ignored
  LC.onEnd(() => { throw new Error("boom"); });
  T += 2 * 60 * 1000; LC.sweep(T);
  await bot({ mf: 1 });
  await LC.stageHold(R, "carl", MF, T, { mf: true });
  assert.equal(LC.stageYield(R.id, "carl", MF, T), true);
  assert.equal(LC.cooling(R.id, "carl", T), false);
  LC.endBy({ userId: "a", class: "Admin", username: "admin" }, R, "carl", T);
  assert.equal(LC.cooling(R.id, "carl", T), true, "ended by someone: cooling down");
});

test("an old Pepe: no mf advertised, no mf_rooms needed", async () => {
  const r = await bot({});
  assert.equal(LC.botMf(), 0);
  assert.ok(Array.isArray(r.mf_rooms));
});
