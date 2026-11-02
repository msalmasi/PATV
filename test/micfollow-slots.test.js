// 1.99?? STABLE SLOTS on the 🎙 mic stage (owner 2026-11-02: "In mic follows, when 2 speakers are having a back and forth, it
// will put the most recent speaker on the left. So it keeps swapping the slots between the 2, which can be jarring. It doesn't
// need to move speaker slots unless a new speaker is coming in." - and, for the dynamic layout: "when it is more than 2
// speakers, the most recent speaker can still take the big cell"). micfollow.js end to end (stepPad / snapshot / viewFor, the
// capture's program) on a temp DB: a person keeps their place while they stay on the stage; a newcomer takes the place of whom
// they pushed off, else the first empty one; leaving frees a place (the others don't shuffle) until the layout has fewer cells;
// pins keep their places; dynamic with 2 never moves anyone, with 3+ the active speaker takes the main cell (hysteresis kept)
// and trades places with whoever leaves it; the micfollow_cfg knob stable_slots off = today's order byte for byte (a golden
// recorded from the build before - test/fixtures/micfollow-order-golden.json).
//   node --test test/micfollow-slots.test.js        (MF_GOLDEN_WRITE=1 re-records the golden from the build it runs on)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "micfollow-slots-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const bridge = require(path.join(repo, "bridge"));
const rooms = require(path.join(repo, "rooms"));
const stage = require(path.join(repo, "mainstage"));
const PA = require(path.join(repo, "padaccess"));
const relay = require(path.join(repo, "bridge-relay"));
const CA = require(path.join(repo, "camaccess"));
const CV = require(path.join(repo, "camviewers"));
const stories = require(path.join(repo, "stories"));
const premium = require(path.join(repo, "premium"));
const MF = require(path.join(repo, "micfollow"));
const core = require(path.join(repo, "micfollow-core"));
const GOLDEN = path.join(repo, "test", "fixtures", "micfollow-order-golden.json");

W.enabled = () => true;
let T = 1_800_000_000_000;
LC._setClock(() => T);
stage._setClock(() => T);
MF._setClock(() => T);
MF._setBoot(0);
LC._setKick(() => {});
relay.padFull = async () => true;
stories.privateLogins = async () => new Set();
premium.bridgeAllowed = () => true;
CV.noteViewers = () => Promise.resolve(0);

const ROOM = { id: "Slots.Room", name: "Slots Room" };
const ADMIN = { userId: "u_admin", username: "admin", class: "Admin" };
const OWNER = { userId: "u_owner", username: "padowner" };
const PEOPLE = ["alice", "bob", "carl", "dana", "fay", "gus", "hal"];
let R = null;
const MEMBERS = () => [...PEOPLE.map((l) => ({ login: l, display: l[0].toUpperCase() + l.slice(1), on_cam: true })),
  { login: "pepe", display: "Pepe", self: true, on_cam: true }];
function room(holders) {
  R = bridge._rooms.get(ROOM.id);
  Object.assign(R, { updated: T, cams: true, livecams: true, members: MEMBERS(),
                     mic: (holders || []).map((l) => (typeof l === "string" ? { login: l, display: l, proven: true } : l)) });
  return R;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
async function step(holders) {
  for (let i = 0; i < 2; i++) { room(holders); MF.stepPad(ROOM.id, T); await MF._idle(); await settle(); }
  return MF._pads.get(ROOM.id).state;
}
const EXACT = new Set();
const bot = () => LC.forBot({ cap: true, mf: 1, live: [...EXACT].filter((l) => LC._sessions.has(LC.keyOf(ROOM.id, l))).map((l) => ({ room: ROOM.id, login: l, state: "live", exact: true })) }, T);
function up(...logins) { LC.noteSync(logins.map((l) => ({ name: LC.pathFor(ROOM.id, l), ready: true, readers: [] })), T); for (const l of logins) EXACT.add(l); }
async function at(sec, holders) { T += sec * 1000; up(...EXACT); await bot(); return step(holders); }
/** `who` takes the mic (alone - a one-mic room) and holds it `secs` seconds (a new speaker qualifies after 2 s, then goes live). */
async function talk(who, secs = 6) {
  const h = Array.isArray(who) ? who : [who];
  await at(1, h); await at(2, h); up(...h); await at(1, h);
  if (secs > 4) await at(secs - 4, h);
}
async function reset() {
  for (const P of MF._pads.values()) { P.state = core.newState(); P.stills.clear(); P.spans.clear(); }
  for (const p of [...((MF._pins.get(ROOM.id) || new Map()).values())]) await MF.unpin(ROOM.id, p.login, "unpinned", "test");
  for (const S of [...LC._sessions.values()]) LC._sessions.delete(S.key);
  EXACT.clear();
  T += 10 * 60 * 1000;
  await bot();
}
async function pad(settings) {
  await MF.setPad(ROOM.id, Object.assign({ on: true, layout: "auto", default_view: "first", max_people: 4, max_live: 4, keep_recent: 2 }, settings), "test");
  await MF.setOverride(ROOM.id, null);
}
async function knobs(c) { await MF.setCfg(ADMIN, Object.assign({ reason: "test" }, c)); }
const pinBy = (login) => MF.pinPut(OWNER, ROOM.id, login, T);

/** What the order is made of - the program's (snapshot) and one viewer's (viewFor) - nothing that depends on relay timing. */
async function look() {
  const snap = MF.snapshot(ROOM.id);
  const v = await MF.viewFor(snap, R, "u_v1", null);
  return {
    layout: snap.layout, dyn: snap.dyn || null,
    tiles: snap.tiles.map((x) => [x.login, x.pos, !!x.newest, !!x.pin, !!x.ring, !!x.recent]),
    src: v.src.map((s) => [s.id, s.pos, !!s.newest]), vdyn: v.dyn || null,
  };
}
/** Who sits where (place order), from the viewer's program. */
const places = (L) => L.src.slice().sort((a, b) => a[1] - b[1]).map((s) => s[0]);
const posOf = (L, id) => (L.src.find((s) => s[0] === id) || [])[1];

// ── the scenarios (the same scripts for the golden and the stable checks) ──
const SCENARIOS = {
  /** auto layout, keep_recent 2: two take turns, a third and a fourth come, a fifth pushes the least recent off, one leaves */
  async auto(trace) {
    await pad({ layout: "auto", max_people: 4 });
    await talk("alice"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    for (const w of ["alice", "bob", "alice", "bob"]) { await talk(w); trace.push(await look()); }
    await talk("carl"); trace.push(await look());
    await talk("alice"); trace.push(await look());
    await talk("dana"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    await talk("fay", 12); trace.push(await look());
    await talk("carl"); trace.push(await look());
    // only carl talks for 2 minutes: the others leave (keep_recent) one by one
    for (let i = 0; i < 14; i++) { await at(10, ["carl"]); trace.push(await look()); }
  },
  /** dynamic: a back-and-forth of 2, then 3 and 4 speakers taking turns, then the stage shrinks */
  async dynamic(trace) {
    await pad({ layout: "dynamic", max_people: 4 });
    await talk("alice"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    for (const w of ["alice", "bob", "alice"]) { await talk(w); trace.push(await look()); }
    await talk("carl"); trace.push(await look());
    for (const w of ["alice", "bob", "carl", "bob"]) { await talk(w); trace.push(await look()); }
    await talk("dana"); trace.push(await look());
    for (const w of ["alice", "carl", "dana", "bob"]) { await talk(w); trace.push(await look()); }
    await talk("fay", 12); trace.push(await look());
    for (let i = 0; i < 14; i++) { await at(10, ["fay"]); trace.push(await look()); }
  },
  /** picture in picture: two take turns, a third comes */
  async pip(trace) {
    await pad({ layout: "pip", max_people: 4 });
    await talk("alice"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    for (const w of ["alice", "bob", "alice"]) { await talk(w); trace.push(await look()); }
    await talk("carl", 12); trace.push(await look());
    for (const w of ["alice", "carl"]) { await talk(w); trace.push(await look()); }
  },
  /** side by side */
  async split(trace) {
    await pad({ layout: "split", max_people: 4 });
    await talk("alice"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    for (const w of ["alice", "bob"]) { await talk(w); trace.push(await look()); }
    await talk("carl", 12); trace.push(await look());
  },
  /** 📌 pins beside the mic tiles: a pin, speakers around it, someone on the stage gets pinned, a pin ends */
  async pins(trace) {
    await pad({ layout: "auto", max_people: 4 });
    room([]); await bot();
    await pinBy("carl"); up("carl"); await bot(); trace.push(await look());
    await talk("alice"); trace.push(await look());
    await talk("bob"); trace.push(await look());
    await talk("carl"); trace.push(await look());
    await talk("alice"); trace.push(await look());
    await pinBy("bob"); await at(1, ["alice"]); trace.push(await look());
    await talk("dana"); trace.push(await look());
    await MF.unpin(ROOM.id, "carl", "unpinned", "padowner"); await at(1, ["dana"]); trace.push(await look());
    await talk("alice"); trace.push(await look());
  },
  /** the single layout with a pin (picture in picture): the current speaker fills the stage - unchanged */
  async single(trace) {
    await pad({ layout: "single", max_people: 4 });
    room([]); await bot();
    await pinBy("carl"); up("carl"); await bot();
    await talk("alice"); trace.push(await look());
    await talk("carl"); trace.push(await look());
    await talk("alice"); trace.push(await look());
    await talk("bob", 12); trace.push(await look());
  },
};
async function run(name, extraKnobs = {}) {
  await reset();
  await knobs(Object.assign({ dynamic: true, main_hold_s: 3, cold_open: true }, extraKnobs));
  const trace = [];
  try { await SCENARIOS[name](trace); } finally { await reset(); }
  return trace;
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["u_admin", "admin", "Admin", null], ["u_owner", "padowner", "pleb", null], ["u_v1", "viewer1", "pleb", "viewer1"],
                                     ["pepe-bot", "Pepe", "Bot", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await require(path.join(repo, "inbox")).ready;
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "alice", login: "alice", display: "Alice" }], count: 1, cams: true, livecams: true, mic: [] }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await rooms.setOwner(ROOM.id, "padowner", "test");
  await stage.init();
  await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true } });
  await CA.init();
  await MF._ready();
  for (const l of PEOPLE) await MF._noticed(ROOM.id, l, 1);
  await MF.setCfg(ADMIN, { enabled: true, reason: "test" });
});

if (process.env.MF_GOLDEN_WRITE === "1") {
  test("record the order golden from THIS build (today's order)", async () => {
    const out = {};
    for (const name of Object.keys(SCENARIOS)) out[name] = await run(name, { stable_slots: false });
    fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 0).replace(/\],\[/g, "],\n["));
  });
}

if (process.env.MF_TRACE_PRINT === "1") {
  test("print the stable traces", async () => {
    for (const name of Object.keys(SCENARIOS)) {
      const tr = await run(name, { stable_slots: true });
      console.log("== " + name);
      tr.forEach((L, i) => console.log(i, L.layout, L.dyn ? "main=" + L.dyn.main : "", JSON.stringify(L.src.map((s) => s[0] + "@" + s[1] + (s[2] ? "*" : ""))), L.tiles.filter((t) => t[3]).map((t) => "pin:" + t[0]).join(",")));
    }
  });
}

test("S1. the knob: micfollow_cfg stable_slots is ON by default (staging and prod); OFF = today's order byte for byte (the golden recorded from the build before)", async () => {
  assert.equal(core.FIELDS.stable_slots.def, true, "on - not a STAGING-only default");
  assert.equal(core.FIELDS.stable_slots.bool, true);
  assert.equal(MF.cfg().stable_slots, true, "on with a saved row that never named it");
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(SCENARIOS).sort());
  for (const name of Object.keys(SCENARIOS)) {
    const got = await run(name, { stable_slots: false });
    assert.equal(JSON.stringify(got), JSON.stringify(golden[name]), name + ": the knob off is today's order");
  }
  await knobs({ stable_slots: false });
  await pad({ layout: "auto" });
  await talk("alice"); await talk("bob");
  const snap = MF.snapshot(ROOM.id), v = await MF.viewFor(snap, R, "u_v1", null);
  assert.equal(snap.stable, undefined, "off: no stable flag on the program");
  assert.equal(v.stable, undefined);
  assert.equal(MF._pads.get(ROOM.id).state.slots, null, "off: no places kept");
  await knobs({ stable_slots: true });
  const on = MF.snapshot(ROOM.id);
  assert.equal(on.stable, true);
  assert.equal((await MF.viewFor(on, R, "u_v1", null)).stable, true);
  await reset();
  // with it on (the default) the same scripts DO differ where today's order moved people
  for (const name of ["dynamic", "pip", "auto", "pins"]) assert.notEqual(JSON.stringify(await run(name, { stable_slots: true })), JSON.stringify(golden[name]), name);
});

/** Two people taking turns on a pad with `layout`: who sits where after each turn (and the dynamic main / the big picture). */
async function backAndForth(layout, stable) {
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: stable });
  await pad({ layout, max_people: 4 });
  const out = [];
  try {
    await talk("alice"); await talk("bob"); out.push(await look());
    for (const w of ["alice", "bob", "alice", "bob", "alice"]) { await talk(w); out.push(await look()); }
  } finally { await reset(); }
  return out;
}
test("S2. a back-and-forth of 2 keeps both places in every layout with more than one cell - auto (side by side), split, grid, picture in picture and dynamic (no main swap: the ring shows who talks)", async () => {
  for (const layout of ["auto", "split", "grid", "pip", "dynamic"]) {
    const tr = await backAndForth(layout, true);
    assert.equal(tr[0].src.length, 2, layout + ": both on the stage");
    for (const L of tr) {
      assert.deepEqual(places(L), places(tr[0]), layout + ": nobody moved " + JSON.stringify(L.src));
      assert.deepEqual(L.src.map((s) => s[1]).sort(), [0, 1], layout + ": places 0 and 1");
      assert.deepEqual(L.tiles.map((t) => [t[0], t[1]]), L.src.map((s) => [s[0], s[1]]), layout + ": the program and the viewer's agree");
      if (layout === "dynamic") assert.equal(L.dyn.main, places(tr[0])[0], "dynamic: the main cell is place 0 - it never follows the speaker with 2");
    }
    // whoever talks is the newest (the ring / highlight) - it does alternate
    const talking = tr.map((L) => (L.src.find((s) => s[2]) || [])[0]);
    assert.deepEqual(talking.slice(1), ["alice", "bob", "alice", "bob", "alice"], layout + ": the highlight follows the speaker");
    // the same turns without stable slots: the dynamic main and the big picture swap on every turn (what the owner saw)
    if (layout === "dynamic" || layout === "pip") {
      const old = await backAndForth(layout, false);
      const big = old.map((L) => (layout === "dynamic" ? L.dyn.main : (L.src.find((s) => s[2]) || [])[0]));
      assert.deepEqual(big.slice(1), ["alice", "bob", "alice", "bob", "alice"], layout + " (knob off): the big cell swapped every turn");
    }
  }
});

test("S3. dynamic with 3+: the most recent speaker takes the main cell (main_hold_s kept) and trades places with whoever leaves it - every other cell stays put; a newcomer takes it the same way", async () => {
  const tr = await run("dynamic", { stable_slots: true });
  let swaps = 0;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i];
    if (a.src.length < 3 || b.src.length < a.src.length) continue;    // (2 or fewer: nobody moves - S2; shrinking: S5)
    assert.equal(b.dyn.main, places(b)[0], "the main sits in place 0 (the big cell)");
    const mainA = a.dyn.main, mainB = b.dyn.main;
    const talker = (b.src.find((s) => s[2]) || [])[0];
    assert.equal(mainB, talker, "#" + i + ": the most recent speaker has the big cell");
    for (const [id, p] of b.src) {
      if (id === mainA || id === mainB) continue;
      const was = posOf(a, id);
      assert.notEqual(was, undefined, "#" + i + ": a newcomer is the most recent speaker - the main");
      assert.equal(p, was, "#" + i + ": " + id + " stays put");
    }
    if (mainA !== mainB) {
      swaps++;
      // the one leaving the main cell takes the new main's old cell - a newcomer's: the place of whom they pushed off, else a new one
      const left = places(a).filter((id) => posOf(b, id) == null);
      const theirs = posOf(a, mainB) != null ? posOf(a, mainB) : left.length ? posOf(a, left[0]) : b.src.length - 1;
      assert.equal(posOf(b, mainA), theirs, "#" + i + ": the two traded places");
    }
  }
  assert.ok(swaps >= 8, "the main moved with the speakers: " + swaps);
  // hysteresis: a speaker within main_hold_s of the last move waits; then takes it
  await reset();
  await knobs({ dynamic: true, main_hold_s: 15, cold_open: true, stable_slots: true });
  await pad({ layout: "dynamic", max_people: 4 });
  try {
    await talk("alice"); await talk("bob"); await at(20, ["bob"]);
    await talk("carl");
    let L = await look();
    assert.deepEqual(places(L), ["carl", "bob", "alice"], "carl (new, talking, the main free to move) takes the big cell; alice takes his cell");
    await talk("alice");
    L = await look();
    assert.deepEqual(places(L), ["carl", "bob", "alice"], "alice talks within 15 s of the move: the main holds");
    assert.equal(L.dyn.main, "carl");
    await at(6, ["alice"]);
    L = await look();
    assert.deepEqual(places(L), ["alice", "bob", "carl"], "after main_hold_s: alice and carl trade - bob never moved");
  } finally { await reset(); }
});

test("S4. a new speaker takes the place of the least recent one they push off when the stage is full, else the first free place", async () => {
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true });
  try {
    // split (2 places): bob is off the mic longest - carl takes HIS place (1); alice (0) never moves
    await pad({ layout: "split", max_people: 4 });
    await talk("alice"); await talk("bob"); await talk("alice", 12);
    assert.deepEqual(places(await look()), ["alice", "bob"]);
    await talk("carl", 12);
    let L = await look();
    assert.deepEqual(places(L), ["alice", "carl"], "carl took bob's place");
    assert.equal(posOf(L, "carl"), 1);
    await reset();
    // grid, full at 4: the least recent (off the mic longest) is pushed off; the newcomer sits in exactly their place
    await pad({ layout: "auto", max_people: 4 });
    for (const w of ["alice", "bob", "carl", "dana"]) await talk(w);
    await talk("alice"); await talk("carl"); await talk("dana");
    assert.deepEqual(places(await look()), ["alice", "bob", "carl", "dana"]);
    await talk("fay", 12);
    L = await look();
    assert.deepEqual(places(L), ["alice", "fay", "carl", "dana"], "fay took bob's place (bob: off the mic longest) - nobody else moved");
    // room left: the first free place (a newcomer on a stage with an empty cell fills it)
    await reset();
    await pad({ layout: "auto", max_people: 4, keep_recent: 0 });
    await talk(["alice"]); await talk(["alice", "bob"]); await talk(["alice", "bob", "carl"]);
    assert.deepEqual(places(await look()), ["alice", "bob", "carl"], "the free places in order");
    await talk(["alice", "bob", "carl", "dana"]);
    await at(6, ["alice", "carl", "dana"]); await at(6, ["alice", "carl", "dana"]); await at(6, ["alice", "carl", "dana"]);
    L = await look();
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["alice", 0], ["carl", 2], ["dana", 3]], "bob left: his cell stays empty, nobody shuffles");
    assert.equal(L.layout, "grid4");
    await talk(["alice", "carl", "dana", "fay"]);
    L = await look();
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["alice", 0], ["fay", 1], ["carl", 2], ["dana", 3]], "fay fills the empty cell");
  } finally { await reset(); }
});

test("S5. leave / rejoin, keep_recent expiry and a layout that gets smaller: an empty cell until the layout has fewer cells, then the places close up in order", async () => {
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true });
  try {
    await pad({ layout: "auto", max_people: 4, keep_recent: 0 });
    await talk(["alice"]); await talk(["alice", "bob"]); await talk(["alice", "bob", "carl"]); await talk(["alice", "bob", "carl", "dana"]);
    // alice leaves (hand-over): her cell stays empty
    for (let i = 0; i < 3; i++) await at(6, ["bob", "carl", "dana"]);
    let L = await look();
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["bob", 1], ["carl", 2], ["dana", 3]]);
    // she comes back (after her cooldown_s): the first empty place - her own
    await at(20, ["bob", "carl", "dana"]);
    await talk(["alice", "bob", "carl", "dana"]);
    L = await look();
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["alice", 0], ["bob", 1], ["carl", 2], ["dana", 3]], "rejoined in her old place");
    // alice and dana leave: 2 people = side by side (2 cells) - the places close up, bob before carl as they were
    for (let i = 0; i < 3; i++) await at(6, ["bob", "carl"]);
    L = await look();
    assert.equal(L.layout, "split");
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["bob", 0], ["carl", 1]]);
    // keep_recent (1 minute): recent speakers stay up, then leave - the cell empties, the others keep theirs
    await reset();
    await pad({ layout: "auto", max_people: 4, keep_recent: 1 });
    await talk("alice"); await talk("bob"); await talk("carl"); await talk("dana");
    assert.deepEqual(places(await look()), ["alice", "bob", "carl", "dana"]);
    await talk("bob"); await talk("carl"); await talk("dana");
    for (let s = 0; s < 40 && posOf(await look(), "alice") != null; s += 5) await at(5, ["dana"]);
    L = await look();
    assert.equal(posOf(L, "alice"), undefined, "alice left after keep_recent");
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["bob", 1], ["carl", 2], ["dana", 3]], "her cell is empty; nobody moved");
    // dynamic has no empty cells: the template shrinks and the places close up in order
    await reset();
    await pad({ layout: "dynamic", max_people: 4, keep_recent: 0 });
    await talk(["alice"]); await talk(["alice", "bob"]); await talk(["alice", "bob", "carl"]); await talk(["alice", "bob", "carl", "dana"]);
    L = await look();
    const before = places(L);
    const gone = before[1];
    for (let i = 0; i < 3; i++) await at(6, before.filter((x) => x !== gone));
    L = await look();
    assert.deepEqual(places(L), before.filter((x) => x !== gone), "closed up, the order kept");
    assert.deepEqual(L.src.map((s) => s[1]).sort(), [0, 1, 2]);
  } finally { await reset(); }
});

test("S6. 📌 pins keep their places: a person on the stage who gets pinned stays where they were; a new pin takes a free place, not the first; an unpin leaves an empty cell", async () => {
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true });
  try {
    await pad({ layout: "auto", max_people: 4 });
    room([]); await bot();
    await talk("alice"); await talk("bob");
    assert.deepEqual(places(await look()), ["alice", "bob"]);
    await pinBy("carl"); up("carl"); await bot();
    let L = await look();
    assert.deepEqual(places(L), ["alice", "bob", "carl"], "a new pin takes the next free place (today: the first)");
    assert.equal(L.tiles.find((t) => t[0] === "carl")[3], true);
    await pinBy("bob"); await at(1, ["alice"]);
    L = await look();
    assert.deepEqual(places(L), ["alice", "bob", "carl"], "bob, pinned, keeps his place");
    assert.equal(L.tiles.find((t) => t[0] === "bob")[3], true, "now as a pin");
    await talk("dana");
    assert.deepEqual(places(await look()), ["alice", "bob", "carl", "dana"]);
    await MF.unpin(ROOM.id, "carl", "unpinned", "padowner"); await at(1, ["dana"]);
    L = await look();
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), [["alice", 0], ["bob", 1], ["dana", 3]], "carl's cell is empty; the pin and the speakers stayed");
    await talk("alice"); await talk("dana");
    assert.deepEqual(L.src.map((s) => [s[0], s[1]]), (await look()).src.map((s) => [s[0], s[1]]), "turns move nobody");
  } finally { await reset(); }
});

test("S7. the program keeps nothing it shows: the snapshot's places are the ones the next step keeps (S.slots); v moves when a place does", async () => {
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true });
  try {
    await pad({ layout: "dynamic", max_people: 4 });
    await talk("alice"); await talk("bob"); await talk("carl");
    const S = MF._pads.get(ROOM.id).state;
    const snap = MF.snapshot(ROOM.id);
    assert.deepEqual(snap.tiles.map((x) => x.login), S.slots, "the snapshot in place order = the kept places");
    assert.deepEqual(snap.tiles.map((x) => x.pos), [0, 1, 2]);
    const v0 = S.v;
    await talk("alice");
    assert.ok(S.v > v0, "alice took the main cell: v moved (pages repaint)");
    assert.equal(S.slots[0], "alice");
    assert.equal(S.dynMain.id, "alice");
  } finally { await reset(); }
});

test("S8. captures (snaps / clips) use the same places: the capture's program (surface capture) carries stable + the viewer's places, and stagemiccap.rects draws each tile in its place's cell", async () => {
  const cap = require(path.join(repo, "stagemiccap"));
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true });
  try {
    await pad({ layout: "auto", max_people: 4, keep_recent: 0 });
    await talk(["alice"]); await talk(["alice", "bob"]); await talk(["alice", "bob", "carl"]); await talk(["alice", "bob", "carl", "dana"]);
    for (let i = 0; i < 3; i++) await at(6, ["alice", "carl", "dana"]);
    const page = await MF.viewFor(MF.snapshot(ROOM.id), R, "u_v1", null);
    const prog = await bridge.stageProgramFor(ROOM.id, "u_v1");
    assert.equal(prog.stable, true);
    assert.deepEqual(prog.src.map((s) => [s.id, s.pos]), page.src.map((s) => [s.id, s.pos]));
    assert.deepEqual(prog.src.map((s) => [s.id, s.pos]), [["alice", 0], ["carl", 2], ["dana", 3]]);
    const rs = cap.rects(prog), at0 = (id) => rs.find((r) => r.id === id);
    assert.equal(prog.layout, "grid4");
    assert.ok(at0("alice").x === 0 && at0("alice").y === 0, "place 0: top left");
    assert.ok(at0("carl").x === 0 && at0("carl").y > 300, "place 2: bottom left (place 1 - bob's - stays an empty cell)");
    assert.ok(at0("dana").x > 600 && at0("dana").y > 300, "place 3: bottom right");
    assert.ok(!rs.some((r) => r.x > 600 && r.y === 0), "nothing drawn in the empty cell");
    // dynamic: the capture's big cell is the program's main (place 0)
    await reset();
    await pad({ layout: "dynamic", max_people: 4 });
    await talk("alice"); await talk("bob"); await talk("carl"); await talk("alice");
    const d = await bridge.stageProgramFor(ROOM.id, "u_v1");
    assert.equal(d.dyn.main, "alice");
    const dr = cap.rects(d);
    assert.equal(dr[0].id, "alice");
    assert.deepEqual(dr.map((r) => r.id), d.src.slice().sort((a, b) => a.pos - b.pos).map((s) => s.id), "the cells in place order");
  } finally { await reset(); }
});

test("S9. covers (hooded frogs) keep every privacy rule: a place never passes between a cover and a named person - a named tile cut by !bridge hide doesn't have its cover come up in its place, and a cover's person coming back named never sits in the frog's place", async () => {
  const REF = "anon-0a1b2c3d", ANON = { anon: true, display: "someone", ref: REF };
  const Q = require(path.join(repo, "quotes")), hid0 = Q.isHidden;
  await reset();
  await knobs({ dynamic: true, main_hold_s: 3, cold_open: true, stable_slots: true, covers: true });
  try {
    await pad({ layout: "auto", max_people: 4, keep_recent: 0 });
    MF.setVeilSource((u) => (u.anon && u.ref === REF ? { proven: true, sess: "s9", veil: "hidden", login: "gus", display: "Gus" } : null));
    const P = MF._pads.get(ROOM.id);
    const placeOf = (key) => { const L = MF.snapshot(ROOM.id); const x = key.startsWith("~cv:") ? L.tiles.find((t) => t.cover) : L.tiles.find((t) => t.login === key); return x ? x.pos : undefined; };
    // (a) gus, named in place 1, goes !bridge hide: cut at once - his cover comes up after the last one on, never in his place
    await talk(["alice"]); await talk(["alice", "gus"]); await talk(["alice", "gus", "carl"]); await talk(["alice", "gus", "carl", "dana"]);
    assert.deepEqual(["alice", "gus", "carl", "dana"].map(placeOf), [0, 1, 2, 3]);
    Q.isHidden = (l) => String(l).toLowerCase() === "gus" || hid0(l);
    await at(1, ["alice", "carl", "dana"]);
    assert.deepEqual(["alice", "gus", "carl", "dana"].map(placeOf), [0, undefined, 2, 3], "gus cut at once: his cell empty");
    const H = ["alice", "carl", "dana", ANON];
    await at(1, H); await at(3, H); await at(3, H);
    assert.ok(P.state.tiles.some((x) => x.cover), "the cover is up");
    assert.notEqual(placeOf("~cv:"), 1, "never in gus's empty place");
    assert.deepEqual(["alice", "carl", "dana", "~cv:"].map(placeOf), [0, 1, 2, 3], "after the last one on (5 places > 4 cells: closed up)");
    // (b) a cover between two named people leaves and its person comes back named: the places close up first - he never
    // sits in the frog's place
    Q.isHidden = hid0;
    await reset();
    await pad({ layout: "auto", max_people: 4, keep_recent: 0 });
    await talk(["alice"]); await talk(["alice", "carl"]);
    await at(1, ["alice", "carl", ANON]); await at(3, ["alice", "carl", ANON]); await at(3, ["alice", "carl", ANON]);
    await talk(["alice", "carl", ANON, "dana"]);
    const frog = placeOf("~cv:");
    assert.equal(frog, 2, "alice, carl, the frog, dana");
    assert.equal(placeOf("dana"), 3);
    // the veiled hold ends; gus holds the mic named right after (the stage full: he pushes the frog off)
    for (let i = 0; i < 4; i++) await at(4, ["alice", "carl", "dana", "gus"]);
    assert.ok(!P.state.tiles.some((x) => x.cover), "the frog is gone");
    assert.notEqual(placeOf("gus"), undefined, "gus is up, named");
    assert.notEqual(placeOf("gus"), frog, "never in the frog's place");
    assert.deepEqual(["alice", "carl", "dana", "gus"].map(placeOf), [0, 1, 2, 3], "the places closed up, gus after the last one on");
  } finally { Q.isHidden = hid0; MF.setVeilSource(null); await knobs({ covers: false }); await reset(); }
});
