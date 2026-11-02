// 🎙 mic follows - the pure engine (micfollow-core.js), on a fake clock: the hold rule, re-grab merge, hand-over, the
// last-on lock, cooldown, the change budget (a strobe script), forced cuts, layouts by count and fixed layouts with
// displacement, the newest highlight, stable positions, freeze, picture assignment (live stays live, the newest gets a
// freed place, the pad's max_live, warm vs cold, stills, cards), active, relay endings, RUN + the stale grace.
//   node --test test/micfollow-core.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
delete process.env.STAGING;
const M = require(path.join(path.resolve(__dirname, ".."), "micfollow-core"));

const C = { ...M.DEFAULTS, cold_open: true, enabled: true };
const PAD = { layout: "auto", max_people: 4, max_live: 4, default_view: "first" };
const S0 = 1_000_000_000_000;

/** A little world: who holds the mic, who's on cam, which relays are up. */
function world(opts = {}) {
  const w = { S: M.newState(), t: S0, holders: [], offcam: new Set(), cuts: new Map(), pending: new Set(), live: new Map(), held: new Set(), exactNo: new Set(),
              pad: { ...PAD, ...(opts.pad || {}) }, C: { ...C, ...(opts.C || {}) }, site: { maxLive: 4, coldLeft: 9, stillsLeft: 4, ...(opts.site || {}) },
              why_off: null, actions: [], cams: true, unknown: new Set(), listAt: null, listFresh: null };
  w.grab = (login, since) => { if (!w.holders.some((h) => h.login === login)) w.holders.push({ login, since: since == null ? undefined : since }); };
  w.drop = (login) => { w.holders = w.holders.filter((h) => h.login !== login); };
  w.input = () => {
    const logins = new Set([...w.holders.map((h) => h.login), ...w.S.tiles.map((x) => x.login)]);
    const elig = new Map(), sess = new Map();
    for (const l of logins) {
      elig.set(l, w.cuts.get(l) || (w.pending.has(l) ? "pending" : w.offcam.has(l) ? "off_cam" : w.unknown.has(l) ? "cam_unknown" : "ok"));
      const st = w.live.get(l) || "none";
      // Pepe reports a live relay as exact (opened / verified by the exact name) unless the test says he can't (exactNo)
      sess.set(l, { state: st, held: w.held.has(l), exact: w.exactNo.has(l) ? false : st === "live" ? true : null, viewers: 0 });
    }
    // like micfollow.js: what's LEFT site-wide (this pad's current stills already count)
    const site = { ...w.site, stillsLeft: Math.max(0, w.site.stillsLeft - w.S.tiles.filter((x) => x.video === "still").length) };
    return { why_off: w.why_off, holders: w.holders.slice(), unproven_n: 0, elig, sess, pad: w.pad, room: { cams: w.cams, listAt: w.listAt, listFresh: w.listFresh }, site };
  };
  w.step = () => {
    const r = M.step(w.S, w.input(), w.C, w.t);
    w.actions.push(...r.actions);
    // the wiring: holds succeed at once and the relay is "connecting" (warm stays as it was)
    for (const a of r.actions) {
      if (a.a === "hold") { w.held.add(a.login); if (!w.live.has(a.login) || w.live.get(a.login) === "ended") w.live.set(a.login, "connecting"); M.holdDone(w.S, a.login, true, null, w.C, w.t); }
      if (a.a === "release") w.held.delete(a.login);
    }
    return r.actions;
  };
  w.at = (s) => { w.t = S0 + s * 1000; return w.step(); };
  w.run = (from, to, fn) => { for (let s = from; s <= to; s++) { if (fn) fn(s); w.at(s); } };
  w.logins = () => w.S.tiles.map((x) => x.login);
  w.shape = () => M.shapeOf(w.S, w.pad);
  return w;
}
const count = (acts, a) => acts.filter((x) => x.a === a).length;

test("1. a grab under 2 s never shows; held 2 s it's added", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(1);
  w.drop("a"); w.at(1.5); w.at(3); w.at(10);
  assert.deepEqual(w.logins(), []);
  w.grab("b"); w.at(20); w.at(21);
  assert.deepEqual(w.logins(), []);
  w.at(22);
  assert.deepEqual(w.logins(), ["b"]);
  assert.equal(w.S.tiles[0].video, "starting", "a cold open is on its way");
});

test("2. a re-grab within 5 s keeps the hold's since (spam clicks = one hold); Pepe's since wins when given", () => {
  const w = world();
  w.grab("a"); w.at(0); w.drop("a"); w.at(1);
  w.grab("a"); w.at(3);          // back within 5 s: since stays 0 -> qualified at 3
  assert.deepEqual(w.logins(), ["a"]);
  const v = world();
  v.grab("a"); v.at(0); v.drop("a"); v.at(1); v.at(8);
  v.grab("a"); v.at(9);          // 8 s later: a new hold
  assert.deepEqual(v.logins(), []);
  v.at(11);
  assert.deepEqual(v.logins(), ["a"]);
  const p = world();
  p.grab("a", S0 - 30 * 1000); p.at(0);      // Pepe: held for 30 s already (e.g. after a site restart)
  assert.deepEqual(p.logins(), ["a"]);
});

test("3. a release keeps the tile handover_s, and never before min_on_stage_s", () => {
  const w = world();
  w.grab("a"); w.grab("b"); w.at(0); w.at(2);
  assert.deepEqual(w.logins().sort(), ["a", "b"]);
  w.drop("a"); w.at(3);                       // on since 2: min-on until 12, hand-over until 11
  w.at(11); assert.ok(w.logins().includes("a"));
  w.at(12); assert.deepEqual(w.logins(), ["b"]);
  w.drop("b"); w.at(40); w.at(41);           // b alone now: the last-on lock (20 s)
  assert.deepEqual(w.logins(), ["b"]);
});

test("4. the last one on stays idle_hold_s after the mic goes quiet, then the stage empties", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(2);
  w.at(30); w.drop("a"); w.at(31);
  w.at(45); assert.deepEqual(w.logins(), ["a"], "hand-over passed, still on (nobody else)");
  w.at(51); assert.deepEqual(w.logins(), [], "20 s after the release");
  assert.equal(w.S.active, false);
});

test("5. cooldown: a re-grab within 20 s of leaving isn't re-added, unless the stage would be empty", () => {
  const w = world();
  w.grab("a"); w.grab("b"); w.at(0); w.at(2);
  w.drop("a"); w.at(3); w.at(13);
  assert.deepEqual(w.logins(), ["b"]);       // a left at 13
  w.grab("a"); w.at(20); w.at(25);
  assert.deepEqual(w.logins(), ["b"], "a is cooling down");
  w.at(34); assert.deepEqual(w.logins().sort(), ["a", "b"], "after 20 s");
  // alone: the cooldown doesn't keep an empty stage empty
  const v = world();
  v.grab("a"); v.at(0); v.at(2); v.drop("a"); v.at(3); v.at(23);
  assert.deepEqual(v.logins(), []);
  v.grab("a"); v.at(26); v.at(28);
  assert.deepEqual(v.logins(), ["a"], "within its cooldown, but the stage was empty");
});

test("6. the strobe script: two people alternating every 3 s for 60 s -> at most 6 changes, never two within 5 s", () => {
  const w = world();
  const changes = [];
  for (let s = 0; s <= 60; s++) {
    const who = Math.floor(s / 3) % 2 ? "b" : "a";
    w.holders = [{ login: who }];
    const before = w.S.v, acts = w.at(s);
    if (acts.some((a) => a.a === "touch" && a.why === "change")) changes.push(s);
    void before;
  }
  assert.ok(changes.length <= 6, "changes: " + changes.join(","));
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i] - changes[i - 1] >= 5, "gap " + changes.join(","));
  // and a faster strobe (every 1 s, different people) is just as calm
  const v = world();
  const ch = [];
  for (let s = 0; s <= 60; s++) {
    v.holders = [{ login: ["a", "b", "c", "d", "e", "f"][s % 6] }, { login: ["f", "e", "d", "c", "b", "a"][s % 6] }];
    if (v.at(s).some((a) => a.a === "touch" && a.why === "change")) ch.push(s);
  }
  assert.ok(ch.length <= 6, "fast strobe: " + ch.join(","));
});

test("7. forced cuts bypass the budget and the hand-over (no card left)", () => {
  const w = world();
  w.grab("a"); w.grab("b"); w.at(0); w.at(2);
  w.cuts.set("a", "opted_out");
  const acts = w.at(3);                       // 1 s after a change: a voluntary change would wait
  assert.deepEqual(w.logins(), ["b"]);
  assert.ok(acts.some((a) => a.a === "release" && a.login === "a"), "its relay is let go");
  assert.ok(acts.some((a) => a.a === "span_close" && a.reason === "cut:opted_out"));
  for (const code of M.CUT) assert.equal(M.isCut(code), true, code);
  assert.equal(M.isCut("off_cam"), false);
});

test("8. auto layout by count", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => M.layoutFor("auto", n)), ["single", "single", "split", "grid4", "grid4", "grid9", "grid9"]);
  assert.deepEqual([1, 2, 5].map((n) => M.layoutFor("grid", n)), ["single", "grid4", "grid9"]);
  assert.deepEqual([1, 2].map((n) => M.layoutFor("pip", n)), ["single", "pip"]);
  assert.deepEqual([1, 2].map((n) => M.layoutFor("split", n)), ["single", "split"]);
  assert.equal(M.layoutFor("single", 4), "single");
  assert.deepEqual(["single", "split", "pip", "grid", "auto"].map(M.layoutCap), [1, 2, 2, 9, 9]);
  const w = world({ pad: { max_people: 9, max_live: 4 } });
  for (const l of ["a", "b", "c", "d", "e"]) w.grab(l);
  w.at(0); w.at(2);
  assert.equal(w.shape(), "grid9");
  assert.equal(w.S.tiles.length, 5);
});

test("9. fixed single / split / pip: the newest speaker displaces the oldest tile once it's been on min_on_stage_s", () => {
  const w = world({ pad: { layout: "single" } });
  w.grab("a"); w.at(0); w.at(2);
  w.grab("b"); w.at(5); w.at(8);
  assert.deepEqual(w.logins(), ["a"], "a has been on 6 s only");
  w.at(12); assert.deepEqual(w.logins(), ["b"], "b displaced a");
  assert.ok(w.actions.some((x) => x.a === "span_close" && x.login === "a" && x.reason === "displaced"));
  // a, still holding (an older speaker), never displaces b back
  w.run(13, 60);
  assert.deepEqual(w.logins(), ["b"]);
  const s = world({ pad: { layout: "split" } });
  s.grab("a"); s.grab("b"); s.at(0); s.at(2);
  s.grab("c"); s.at(13); s.at(15);
  assert.equal(s.S.tiles.length, 2);
  assert.ok(s.logins().includes("c"));
  const p = world({ pad: { layout: "pip" } });
  p.grab("a"); p.at(0); p.at(2); p.grab("b"); p.at(5); p.at(8);
  assert.equal(p.shape(), "pip");
  assert.equal(M.newest(p.S).login, "b", "the newest fills the stage");
});

test("10-11. the newest is highlighted; positions stay stable and compact", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(2);
  w.grab("b"); w.at(5); w.at(7);
  w.grab("c"); w.at(10); w.at(12);
  assert.deepEqual(w.S.tiles.map((x) => [x.login, x.pos]), [["a", 0], ["b", 1], ["c", 2]]);
  assert.equal(M.newest(w.S).login, "c");
  w.drop("b"); w.at(13); w.at(22);
  assert.deepEqual(w.S.tiles.map((x) => [x.login, x.pos]), [["a", 0], ["c", 1]], "compacted in reading order");
  w.grab("d"); w.at(30); w.at(32);
  assert.deepEqual(w.S.tiles.map((x) => [x.login, x.pos]), [["a", 0], ["c", 1], ["d", 2]]);
  assert.equal(M.newest(w.S).login, "d");
});

test("12. freeze: nobody new comes on; leaving still works", () => {
  const w = world();
  w.grab("a"); w.grab("b"); w.at(0); w.at(2);
  w.S.frozenUntil = S0 + 100 * 1000;
  w.grab("c"); w.at(10); w.at(20);
  assert.deepEqual(w.logins().sort(), ["a", "b"]);
  w.drop("a"); w.at(21); w.at(30);
  assert.deepEqual(w.logins(), ["b"]);
  w.at(101); w.at(102);
  assert.deepEqual(w.logins().sort(), ["b", "c"], "unfrozen by itself");
});

test("13. pictures: a live tile stays live; the newest gets a freed place; the pad's max_live; warm vs cold; stills; cards", () => {
  const w = world({ pad: { max_live: 2 }, site: { coldLeft: 9, stillsLeft: 1 } });
  for (const l of ["a", "b", "c", "d"]) w.grab(l);
  w.live.set("d", "live");                    // d's relay is up already (someone's ▶ Live): warm
  w.at(0); w.at(2);
  const v = (l) => w.S.tiles.find((x) => x.login === l).video;
  assert.equal(w.S.tiles.length, 4);
  const holds = w.actions.filter((a) => a.a === "hold");
  assert.equal(holds.length, 2, "two live places");
  assert.ok(holds.some((h) => h.login === "d" && h.cold === false), "the warm relay is reused");
  for (const l of ["a", "b", "c", "d"]) w.live.set(l, w.held.has(l) ? "live" : w.live.get(l) || "none");
  w.at(3);
  const liveOnes = w.S.tiles.filter((x) => x.video === "live").map((x) => x.login);
  assert.equal(liveOnes.length, 2);
  assert.equal(w.S.tiles.filter((x) => x.video === "still").length, 1, "one still left site-wide");
  // mfix: the card says WHY - here the pad's max_live (2 live places) is used up
  assert.equal(w.S.tiles.filter((x) => x.video === "card" && x.why === "pad_cap").length, 1);
  // a newer speaker doesn't take a live picture away (stability)
  w.grab("e"); w.at(20); w.at(22);
  for (const l of liveOnes) assert.equal(v(l), "live", l + " keeps live");
  // a live one leaves cam: card off_cam, its relay let go; the place goes to the NEWEST without one
  w.offcam.add(liveOnes[0]);
  const acts = w.at(23);
  assert.equal(v(liveOnes[0]), "card");
  assert.ok(acts.some((a) => a.a === "release" && a.login === liveOnes[0]));
  const newestNoPic = w.S.tiles.filter((x) => x.login !== liveOnes[0]).sort((a, b) => b.addedAt - a.addedAt);
  assert.ok(acts.some((a) => a.a === "hold" && a.login === newestNoPic[0].login), "the freed place goes to the newest");
  // exact !== true (a ▶ Live relay from Pepe's older, fuzzy name match) is never SHOWN: held so Pepe checks it, "starting"
  // meanwhile, given up after EXACT_WAIT_MS (a card, no new hold during the backoff); cold opens need budget
  // (mfix: soft_fails_max 1 = the full backoff at the first give-up; test 32 has the soft retries)
  const x = world({ site: { coldLeft: 0, stillsLeft: 0 }, C: { soft_fails_max: 1 } });
  x.grab("q"); x.live.set("q", "live"); x.exactNo.add("q"); x.at(0); x.at(2);
  assert.equal(x.S.tiles[0].video, "starting", "held for Pepe's exact check, never live");
  x.run(3, 61);
  assert.equal(x.S.tiles[0].video, "starting");
  const gaveUp = x.at(64);
  assert.ok(gaveUp.some((a) => a.a === "release" && a.login === "q"), "given up after the wait");
  assert.deepEqual([x.S.tiles[0].video, x.S.tiles[0].why], ["card", "failed"]);
  const n = x.actions.filter((a) => a.a === "hold").length;
  x.run(65, 140);
  assert.equal(x.actions.filter((a) => a.a === "hold").length, n, "no new hold during the backoff");
  assert.ok(!x.S.tiles[0].pictured, "never had a picture");
  // cold_open off: no stills either (a still opens the cam too)
  const y = world({ C: { cold_open: false }, site: { coldLeft: 0, coldWhy: "cold_off" } });
  y.grab("q"); y.at(0); y.at(2);
  assert.equal(y.S.tiles[0].video, "card");
  assert.equal(y.S.tiles[0].why, "cold_off", "mfix: the card says live video for the mic stage is off, not 'full'");
  // off cam -> a name card
  const z = world(); z.offcam.add("q"); z.grab("q"); z.at(0); z.at(2);
  assert.deepEqual([z.S.tiles[0].video, z.S.tiles[0].why], ["card", "off_cam"]);
  assert.ok(!z.actions.some((a) => a.a === "hold"));
});

test("14. active: true once someone has a picture, stays true while anyone is on, false when empty", () => {
  const w = world({ site: { coldLeft: 0, stillsLeft: 0 } });
  w.offcam.add("a"); w.grab("a"); w.at(0); w.at(2);
  assert.equal(w.S.active, false, "only a name card: not active (OD-4)");
  w.offcam.delete("a"); w.live.set("a", "live"); w.at(3);
  assert.equal(w.S.tiles[0].video, "starting");
  assert.equal(w.S.active, true, "mfix review: a cam that is opening (starting) already makes the stage the default ('First')");
  w.at(4); assert.equal(w.S.tiles[0].video, "live");
  assert.equal(w.S.active, true);
  w.offcam.add("a"); w.at(5);
  assert.equal(w.S.tiles[0].video, "card");
  assert.equal(w.S.active, true, "sticky while someone is on");
  w.drop("a"); w.at(6); w.at(40);
  assert.equal(w.S.tiles.length, 0);
  assert.equal(w.S.active, false);
});

test("15. relay endings: opted_out / ended_by cut; off cam -> card; failures -> card + backoff (no retry storm)", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 } });
  w.grab("a"); w.grab("b"); w.grab("c"); w.at(0); w.at(2);
  let r = M.sessionEnded(w.S, "a", "opted_out", w.C, w.t);
  assert.equal(r.cut, "opted_out");
  assert.ok(!w.logins().includes("a"));
  r = M.sessionEnded(w.S, "b", "ended_by_admin", w.C, w.t);
  assert.equal(r.cut, "ended_by");
  M.sessionEnded(w.S, "c", "open_failed", w.C, w.t);
  const c = w.S.tiles.find((x) => x.login === "c");
  assert.deepEqual([c.video, c.why], ["card", "failed"]);
  w.held.delete("c"); w.live.set("c", "ended");
  const before = w.actions.length;
  w.run(3, 120);
  assert.ok(!w.actions.slice(before).some((a) => a.a === "hold" && a.login === "c"), "no new open during the backoff");
  const v = world(); v.grab("x"); v.at(0); v.at(2);
  M.sessionEnded(v.S, "x", "cam_closed", v.C, v.t);
  assert.deepEqual([v.S.tiles[0].video, v.S.tiles[0].why], ["card", "off_cam"]);
  // a refused hold
  const h = world(); h.grab("y"); h.at(0);
  h.t = S0 + 2000;
  const acts = M.step(h.S, h.input(), h.C, h.t).actions;
  assert.ok(acts.some((a) => a.a === "hold"));
  // ... because the site's live relays were full at that moment: "full" and another try soon - not the failure backoff
  M.holdDone(h.S, "y", false, "slots_busy", h.C, h.t);
  assert.deepEqual([h.S.tiles[0].video, h.S.tiles[0].why], ["card", "full"]);
  assert.ok(!(h.S.backoff.get("y") > h.t), "no 10-minute backoff for a capacity race");
  h.t = S0 + 2000 + M.FULL_RETRY_MS + 1000;
  assert.ok(M.step(h.S, h.input(), h.C, h.t).actions.some((a) => a.a === "hold" && a.login === "y"), "tried again after FULL_RETRY_MS");
  M.holdDone(h.S, "y", false, "open_failed", h.C, h.t);
  assert.deepEqual([h.S.tiles[0].video, h.S.tiles[0].why], ["card", "failed"], "a real failed open: card + backoff");
  // ... on consent (livecam's own check: opted out / private activity / ended by someone): a CUT, no card left behind
  for (const code of ["opted_out", "ended_by"]) {
    const g = world(); g.grab("y"); g.at(0);
    g.t = S0 + 2000;
    M.step(g.S, g.input(), g.C, g.t);
    const a2 = M.holdDone(g.S, "y", false, code, g.C, g.t);
    assert.deepEqual(g.S.tiles, [], code + ": off");
    assert.ok(a2.some((a) => a.a === "span_close" && a.reason === "cut:" + code), code);
    assert.ok(!(g.S.backoff.get("y") > g.t), code + ": no failure backoff (it's a cut)");
  }
  // a refused still -> card + backoff when Pepe says it's for good (1.99afl S1: a hard code); an older Pepe's refusal with no
  // code is soft (another try soon, never the 10 minutes at once - test 37)
  const s = world({ site: { coldLeft: 0, stillsLeft: 2 } }); s.grab("z"); s.at(0); s.at(2);
  assert.equal(s.S.tiles[0].video, "still");
  M.stillFailed(s.S, "z", s.C, s.t, "not_public");
  assert.deepEqual([s.S.tiles[0].video, s.S.tiles[0].why], ["card", "failed"]);
  assert.ok(s.S.backoff.get("z") > s.t);
  // yielding to a manual slot: no live picture for a minute, a still is fine
  const y = world({ site: { coldLeft: 9, stillsLeft: 2 } }); y.grab("k"); y.at(0); y.at(2);
  M.yieldTile(y.S, "k", y.t);
  y.held.delete("k"); y.live.set("k", "ended");
  y.at(3);
  assert.equal(y.S.tiles[0].video, "still");
});

test("16. RUN false clears everything; a stale sync is ridden out for stale_hold_s, then cleared", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(2);
  w.why_off = "stale"; w.at(10); w.at(30);
  assert.deepEqual(w.logins(), ["a"], "held through the hiccup");
  w.cuts.set("a", "mf_opted_out"); w.at(31);
  assert.deepEqual(w.logins(), [], "consent cuts still apply during the grace");
  w.cuts.clear(); w.why_off = null; w.at(32); w.at(45);
  assert.deepEqual(w.logins(), [], "after a consent cut: the cooldown, even on an empty stage");
  w.at(52); w.at(54);
  assert.deepEqual(w.logins(), ["a"]);
  w.why_off = "stale"; w.at(55); w.at(85);
  assert.deepEqual(w.logins(), ["a"]);
  w.at(86);
  assert.deepEqual(w.logins(), [], "past stale_hold_s");
  assert.ok(w.actions.some((a) => a.a === "span_close" && a.reason === "stale"));
  const v = world(); v.grab("a"); v.at(0); v.at(2);
  v.why_off = "site_off"; v.at(3);
  assert.deepEqual(v.logins(), []);
  assert.equal(v.S.whyOff, "site_off");
  assert.ok(v.actions.some((a) => a.a === "span_close" && a.reason === "kill"));
});

test("pad settings + site knobs normalize like the other settings (ranges, choices, the live-cam cap)", () => {
  const p = M.normalizePad({ on: "on", layout: "GRID", default_view: "tab", max_people: 12, max_live: 3 }, { maxLive: 2 });
  assert.deepEqual(p.cfg, { on: true, layout: "grid", default_view: "tab", max_people: 9, max_live: 2, keep_recent: 2 });
  assert.ok(p.errors.max_people && p.errors.max_live);
  // (wave2 WP-4: + dynamic - the site switch, not normalizePad, decides whether a pad may pick it: micfollow.setPad)
  assert.equal(M.normalizePad({ layout: "huge" }).errors.layout, "one of auto, single, split, grid, pip, dynamic");
  // wave2 WP-4: everything new ships dark on prod (STAGING unset here) - today's behaviour by default
  assert.deepEqual([M.DEFAULTS.warm_keep_s, M.DEFAULTS.warm_max, M.DEFAULTS.dynamic, M.DEFAULTS.main_hold_s], [0, 3, false, 3]);
  assert.deepEqual(M.normalize({ enabled: true }, { lenient: true }).cfg.warm_keep_s, 0, "a saved row without the key reads the default");
  const c = M.normalize({ min_hold_s: "3", cold_open: "off", max_changes_per_min: 50 });
  assert.equal(c.cfg.min_hold_s, 3);
  assert.equal(c.cfg.cold_open, false);
  assert.equal(c.cfg.max_changes_per_min, 20);
  assert.ok(c.errors.max_changes_per_min);
  assert.equal(M.DEFAULTS.enabled, false, "ships dark on prod");
  // mfix (owner 2026-10-25): more live cams for the mic stage; mfix review: cold opens stay off on prod (staging: on) until staff
  // switch them on at /stage/admin (the owner's OK / the spec's V-2, V-3, V-5)
  assert.equal(M.DEFAULTS.cold_open, false);
  assert.deepEqual([M.DEFAULTS.relays_max, M.DEFAULTS.cold_opens_per_min, M.DEFAULTS.cold_opens_per_pad, M.DEFAULTS.max_live], [6, 10, 6, 6]);
  assert.equal(M.PAD_FIELDS.max_live.max, 6);
  // keep_recent: 0 / 1 / 2 / 5 minutes only
  assert.equal(M.normalizePad({ keep_recent: "5" }).cfg.keep_recent, 5);
  assert.equal(M.normalizePad({ keep_recent: 3 }).errors.keep_recent, "one of 0, 1, 2, 5");
  assert.equal(M.normalizePad({ keep_recent: 3 }, { lenient: true }).cfg.keep_recent, 2);
  assert.equal(M.normalizePad({ keep_recent: 0 }).cfg.keep_recent, 0);
  // a quiet voice-only room gets Pepe's snapshot only every 30 s (BRIDGE_SNAPSHOT_EVERY): fresh must cover that
  assert.ok(M.DEFAULTS.sync_fresh_s >= 45, "sync_fresh_s " + M.DEFAULTS.sync_fresh_s);
});

test("17. exact: a held relay that STOPS being exact comes off live at once (released, no live picture during the backoff)", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 }, C: { soft_fails_max: 1 } });
  w.grab("a"); w.live.set("a", "live"); w.at(0); w.at(2);       // warm (someone's ▶ Live), Pepe verified it: exact
  w.at(3);
  assert.equal(w.S.tiles[0].video, "live");
  w.exactNo.add("a");                                          // Pepe now says: not exactly a's (e.g. it restarted on a fuzzy match)
  const acts = w.at(4);
  assert.ok(acts.some((x) => x.a === "release" && x.login === "a"), "its hold is let go at once");
  assert.notEqual(w.S.tiles[0].video, "live");
  assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", "failed"]);
  const n = w.actions.filter((x) => x.a === "hold").length;
  w.run(5, 60);
  assert.equal(w.actions.filter((x) => x.a === "hold").length, n, "no new hold while it's blocked");
  // a warm relay Pepe verifies within the wait is shown
  const v = world();
  v.grab("b"); v.live.set("b", "live"); v.exactNo.add("b"); v.at(0); v.at(2);
  v.at(10); assert.equal(v.S.tiles[0].video, "starting");
  v.exactNo.delete("b"); v.at(11);
  assert.equal(v.S.tiles[0].video, "live", "verified -> live");
  // exact unknown (null - Pepe hasn't reported yet) is not exact either
  const u = world();
  u.grab("c"); u.at(0); u.at(2);
  u.live.set("c", "live");
  const st = u.input(); st.sess.set("c", { state: "live", held: true, exact: null, viewers: 0 });
  M.step(u.S, st, u.C, S0 + 3000);
  assert.equal(u.S.tiles[0].video, "starting");
});

test("18. two speakers added in ONE change: the one who grabbed last is the newest (highlight, live video first)", () => {
  const w = world({ pad: { max_live: 1 } });
  w.grab("c"); w.at(0); w.at(2);                               // c on at 2
  w.grab("a", S0 + 3000); w.grab("b", S0 + 4000);              // a grabs at 3, b at 4 (Pepe's since)
  w.at(5);                                                     // inside min_gap_s: deferred
  assert.deepEqual(w.logins(), ["c"]);
  w.at(7);                                                     // a and b added together
  assert.deepEqual(w.S.tiles.map((x) => x.login), ["c", "a", "b"], "reading order: c, a, then b");
  assert.equal(M.newest(w.S).login, "b", "b grabbed last");
  // the pip / single layouts show the newest; with max_live 1 taken by c, nothing to compare - free it and see who gets it
  w.offcam.add("c"); const acts = w.at(8);
  assert.ok(acts.some((x) => x.a === "hold" && x.login === "b"), "the freed live place goes to b (the newest)");
});

test("19. consent cuts count in the change budget, and a cut person waits the cooldown even on an empty stage (no toggle strobe)", () => {
  const w = world();
  const changes = [];
  w.grab("a");
  for (let s = 0; s <= 60; s++) {
    if (s % 5 === 3) w.cuts.set("a", "opted_out"); else w.cuts.delete("a");   // !livecam off / on every ~5 s while holding the mic
    const acts = w.at(s);
    if (acts.some((x) => x.a === "touch" && (x.why === "change" || x.why === "cut"))) changes.push(s);
  }
  assert.ok(changes.length <= 6, "layout changes in a minute: " + changes.join(","));
  // the cut itself is never deferred
  const v = world();
  v.grab("a"); v.grab("b"); v.at(0); v.at(2);
  v.cuts.set("a", "private"); v.at(2.5);
  assert.deepEqual(v.logins(), ["b"], "off at once");
  v.cuts.delete("a"); v.drop("b");
  v.run(3, 21);
  assert.ok(!v.logins().includes("a"), "not back inside cooldown_s of the cut");
  v.run(22, 30);
  assert.ok(v.logins().includes("a"), "back after it");
});

test("20. Pepe's cam pool: cold opens and stills share poolLeft; a shed stops stills and opens nothing new", () => {
  const w = world({ pad: { max_live: 1 }, site: { coldLeft: 9, stillsLeft: 9, poolLeft: 2 } });
  for (const l of ["a", "b", "c", "d"]) w.grab(l);
  w.at(0); w.at(2);
  const opened = w.S.tiles.filter((x) => x.video === "starting" || x.video === "still").length;
  assert.equal(opened, 2, "one cold open + one still = the pool share");
  assert.equal(w.S.tiles.filter((x) => x.video === "card" && (x.why === "pad_cap" || x.why === "pool")).length, 2, "mfix: the cards say why");
  // shed: Pepe refused a manual cam as full -> stills stop, no new cold opens or stills
  const s = world({ pad: { max_live: 1 }, site: { coldLeft: 9, stillsLeft: 9 } });
  s.grab("a"); s.grab("b"); s.at(0); s.at(2);
  assert.ok(s.S.tiles.some((x) => x.video === "still"));
  s.site.shed = true;
  const acts = s.at(3);
  assert.ok(acts.some((x) => x.a === "still_stop"));
  assert.ok(!s.S.tiles.some((x) => x.video === "still"));
  s.offcam.add(s.S.tiles.find((x) => x.video === "starting" || x.video === "live").login);
  const n = s.actions.filter((x) => x.a === "hold" && x.cold).length;
  s.at(4);
  assert.equal(s.actions.filter((x) => x.a === "hold" && x.cold).length, n, "no cold open while shedding");
});

test("21. the stale hold: pictures still follow the relays (a starting tile turns live), nothing new opens", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 } });
  w.grab("a"); w.at(0); w.at(2);
  assert.equal(w.S.tiles[0].video, "starting");
  w.why_off = "stale";
  w.live.set("a", "live");
  w.at(5);
  assert.equal(w.S.tiles[0].video, "live", "the relay came up during the stale hold");
  w.grab("b"); w.at(8); w.at(12);
  assert.deepEqual(w.logins(), ["a"], "no adds on a stale roster");
  w.offcam.add("a"); w.held.delete("a"); w.live.set("a", "ended");
  const n = w.actions.filter((x) => x.a === "hold").length;
  w.at(13);
  assert.equal(w.actions.filter((x) => x.a === "hold").length, n, "nothing new opened on a stale roster");
});

// ── review fixes (r3) ──

test("22. a relay that ended 'cam off' isn't reopened on an old roster: no churn until OFFCAM_RETRY_MS or the cam goes off and on", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 9 } });
  w.grab("a"); w.at(0); w.at(2);
  w.live.set("a", "live"); w.at(3);
  assert.equal(w.S.tiles[0].video, "live");
  // Pepe: the cam closed. The roster (60-180 s old) still says on cam.
  w.held.delete("a"); w.live.set("a", "ended");
  M.sessionEnded(w.S, "a", "cam_closed", w.C, S0 + 3500);
  assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", "off_cam"]);
  const n = w.actions.filter((x) => x.a === "hold" || x.a === "still").length;
  w.run(4, 60);
  assert.equal(w.actions.filter((x) => x.a === "hold" || x.a === "still").length, n, "no reopen (or still) on the stale roster");
  assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", "off_cam"], "and no 'starting' / 'cam off' flip");
  w.at(64);
  assert.ok(w.actions.slice(n).some((x) => x.a === "hold" && x.login === "a"), "one try after OFFCAM_RETRY_MS");
  // the roster catches up: off, then on again -> at once
  const v = world();
  v.grab("a"); v.at(0); v.at(2); v.live.set("a", "live"); v.at(3);
  v.held.delete("a"); v.live.set("a", "ended");
  M.sessionEnded(v.S, "a", "left_cam", v.C, S0 + 3500);
  v.at(5);
  v.offcam.add("a"); v.at(10);
  v.offcam.delete("a");
  const k = v.actions.length;
  v.at(11);
  assert.ok(v.actions.slice(k).some((x) => x.a === "hold" && x.login === "a"), "back on cam: opened at once");
  // holdDone(not_on_cam) blocks the same way
  const h = world();
  h.grab("a"); h.at(0);
  h.t = S0 + 2000;
  M.step(h.S, h.input(), h.C, h.t);
  M.holdDone(h.S, "a", false, "not_on_cam", h.C, h.t);
  h.t = S0 + 3000;
  assert.ok(!M.step(h.S, h.input(), h.C, h.t).actions.some((x) => x.a === "hold"), "not_on_cam: no instant retry");
});

test("23. rule 10: a failed-open backoff (and an inexact block) ends when the person's cam goes off and on again", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 } });
  w.grab("a"); w.at(0);
  w.t = S0 + 2000;
  M.step(w.S, w.input(), w.C, w.t);
  M.holdDone(w.S, "a", false, "open_failed", w.C, w.t);          // (mfix: a hard failure - start_timeout is soft now)
  assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", "failed"]);
  w.held.delete("a"); w.live.delete("a");
  w.run(3, 20);
  assert.ok(!w.actions.some((x) => x.a === "hold"), "backed off");
  w.offcam.add("a"); w.at(21);
  assert.equal(w.S.tiles[0].why, "off_cam");
  w.offcam.delete("a");
  const acts = w.at(22);
  assert.ok(acts.some((x) => x.a === "hold" && x.login === "a"), "cam off and on again: the backoff is over");
  // the same for "Pepe couldn't confirm it's exactly theirs"
  const x = world({ site: { coldLeft: 0, stillsLeft: 0 }, C: { soft_fails_max: 1 } });
  x.grab("q"); x.live.set("q", "live"); x.exactNo.add("q"); x.at(0); x.at(2);
  x.run(3, 64);
  assert.equal(x.S.tiles[0].why, "failed");
  x.exactNo.delete("q");
  x.offcam.add("q"); x.at(66); x.offcam.delete("q");
  assert.ok(x.at(67).some((a) => a.a === "hold" && a.login === "q"), "inexact block over after off -> on");
});

test("24. a hold the mic stage itself withdrew after its awaits ('gone'): no backoff, no card reason - the next step decides", () => {
  const w = world();
  w.grab("a"); w.at(0);
  w.t = S0 + 2000;
  M.step(w.S, w.input(), w.C, w.t);
  const acts = M.holdDone(w.S, "a", false, "gone", w.C, w.t);
  assert.ok(!acts.some((x) => x.a === "release"), "nothing was held");
  assert.ok(!(w.S.backoff.get("a") > w.t), "no failure backoff");
  assert.equal(w.S.tiles[0].pend, false);
  // still eligible: the next step tries again; cut meanwhile: it comes off
  w.t = S0 + 3000;
  assert.ok(M.step(w.S, w.input(), w.C, w.t).actions.some((x) => x.a === "hold" && x.login === "a"));
  M.holdDone(w.S, "a", false, "gone", w.C, w.t);
  w.cuts.set("a", "mf_opted_out");
  w.t = S0 + 3100;
  M.step(w.S, w.input(), w.C, w.t);
  assert.deepEqual(w.logins(), []);
  // a hold that comes back OK for a tile that left meanwhile is released at once
  const v = world();
  v.grab("b"); v.at(0);
  v.t = S0 + 2000;
  M.step(v.S, v.input(), v.C, v.t);
  M.cutNow(v.S, "b", "excluded", v.t);
  assert.ok(M.holdDone(v.S, "b", true, null, v.C, v.t + 50).some((x) => x.a === "release" && x.login === "b"));
});

test("25. a deferred change is counted once (not once per 1 s retry)", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(2);                                // a on at 2
  w.grab("b"); w.at(2.5); w.at(4);                              // b qualifies at 4.5 ... inside min_gap_s until 7
  w.at(5); w.at(6);
  assert.equal(w.S.deferred, 1, "one deferred change, tried at 5 and 6");
  assert.equal(w.actions.filter((x) => x.a === "deferred").length, 1);
  w.at(7);
  assert.deepEqual(w.logins().sort(), ["a", "b"]);
  w.grab("c"); w.at(7.5); w.at(10); w.at(11);
  assert.equal(w.S.deferred, 2, "a new deferral counts again");
});

test("26. normalizePad: the site knobs cap max_people / max_live (an owner may only narrow them)", () => {
  let r = M.normalizePad({ max_people: 6, max_live: 3 }, { maxPeople: 4, maxLive: 4 });
  assert.ok(r.errors.max_people);
  assert.equal(r.cfg.max_people, 4);
  r = M.normalizePad({ max_live: 2 }, { base: { ...M.PAD_DEFAULTS, max_people: 9 }, maxPeople: 4, maxLive: 4 });
  assert.deepEqual(r.errors, {}, "a stored value above the cap is narrowed quietly");
  assert.equal(r.cfg.max_people, 4);
});

// ── final-verification fixes (r4): the before-prod deltas (addendum 14.1.2) ──

test("27. notice first (DF-11): a holder not noticed yet is never a candidate; notice_first goes out at the first qualifying grab", () => {
  const w = world();
  w.cuts.set("a", "notice");                    // micfollow.js: E = "notice" until notice_lead_s after the pad's first notice
  w.grab("a"); w.at(0); w.at(1);
  assert.equal(count(w.actions, "notice_first"), 0, "not before min_hold_s (a spam click is no grab)");
  const acts = w.at(2.5);
  assert.ok(acts.some((x) => x.a === "notice_first" && x.login === "a"), "at the first qualifying grab");
  w.run(3, 30);
  assert.deepEqual(w.logins(), [], "never picked while E is 'notice'");
  w.cuts.delete("a");                           // 120 s after the notice
  w.at(31);
  assert.deepEqual(w.logins(), ["a"]);
  // frozen: the notice still goes out (it gates nothing but the person's own first pick)
  const f = world();
  f.S.frozenUntil = S0 + 600e3;
  f.cuts.set("b", "notice");
  f.grab("b"); f.at(0); f.at(3);
  assert.ok(f.actions.some((x) => x.a === "notice_first" && x.login === "b"));
});

test("28. grab-spam (DF-37): 4 separate holds shorter than 5 s within 2 min -> off the mic stage 10 min; merged re-grabs are one hold", () => {
  const w = world();
  // a's first hold qualifies (3 s) and puts a on; then three more short separate holds (>5 s apart, so never merged)
  let s = 0;
  for (let i = 0; i < 4; i++) {
    w.grab("a"); w.at(s); w.at(s + 1); w.at(s + 3);
    w.drop("a"); w.at(s + 4);
    s += 12;
  }
  assert.ok(w.actions.some((x) => x.a === "spam"), "caught");
  assert.ok(!w.logins().includes("a"), "off the mic stage at once");
  assert.ok(w.actions.some((x) => x.a === "span_close" && x.login === "a" && x.reason === "spam"));
  w.grab("a"); w.run(s, s + 60);
  assert.ok(!w.logins().includes("a"), "held out (10 min)");
  w.run(s + 600, s + 615);
  assert.ok(w.logins().includes("a"), "back after spam_out_min");
  // spam-clicking (re-grabs within regrab_merge_s) is ONE hold - never grab-spam
  const v = world();
  for (let t = 0; t < 60; t += 2) { v.grab("b"); v.at(t); v.drop("b"); v.at(t + 1); }
  assert.ok(!v.actions.some((x) => x.a === "spam"), "merged re-grabs aren't separate holds");
});

test("29. speech nobody can show (DF-30), mfix: the tiles STAY, dimmed (S.speaking 'someone', nobody highlighted); unattributed_clear = the old give-way + neutral card", () => {
  // mfix default: the last speaker's tile is NOT cleared while an unproven holder talks - the page dims it with "Someone else is
  // speaking" and nobody is the newest speaker; it leaves on its own schedule (hand-over / idle hold)
  const d = world();
  d.grab("a"); d.at(0); d.at(2);
  d.drop("a"); d.at(15);
  const dI = () => Object.assign(d.input(), { others: [{ key: "x:ghost", since: S0 + 16000 }] });
  const dstep = (sec) => { d.t = S0 + sec * 1000; const r = M.step(d.S, dI(), d.C, d.t); d.actions.push(...r.actions); return r.actions; };
  dstep(16); dstep(18.5);
  assert.deepEqual(d.logins(), ["a"], "kept on the stage");
  assert.equal(d.S.speaking, "someone", "dimmed on the page");
  assert.equal(M.newest(d.S), null, "nobody highlighted as the speaker");
  assert.equal(d.S.neutral, null, "no neutral card while tiles are up");
  dstep(30);
  assert.deepEqual(d.logins(), ["a"], "the idle hold (20 s after the drop at 15) still runs");
  dstep(36);
  assert.deepEqual(d.logins(), [], "then it leaves on its own schedule");
  assert.equal(d.S.neutral, "someone", "it left while the unproven holder spoke: the neutral card takes over");
  d.t = S0 + 40000; M.step(d.S, d.input(), d.C, d.t);
  assert.equal(d.S.neutral, null);
  assert.equal(d.S.speaking, null);
  // the old behaviour behind the site knob unattributed_clear
  const w = world({ C: { unattributed_clear: true } });
  w.grab("a"); w.at(0); w.at(2);
  assert.deepEqual(w.logins(), ["a"]);
  w.drop("a"); w.at(15);                        // a dropped: the idle hold would keep a 20 s
  const I = () => Object.assign(w.input(), { others: [{ key: "x:ghost", since: S0 + 16000 }] });
  const step = (sec) => { w.t = S0 + sec * 1000; const r = M.step(w.S, I(), w.C, w.t); w.actions.push(...r.actions); return r.actions; };
  step(16); step(17);
  assert.deepEqual(w.logins(), ["a"], "not before the unproven holder held min_hold_s");
  const acts = step(18.5);
  assert.deepEqual(w.logins(), [], "gave way at once (min on stage was already met)");
  assert.equal(w.S.neutral, "someone");
  assert.ok(acts.some((x) => x.a === "release" && x.login === "a"));
  assert.equal(w.S.active, false, "a stage of only a neutral card is never the default (DF-15)");
  step(25);
  assert.equal(w.S.neutral, "someone", "while they speak");
  w.t = S0 + 30000; M.step(w.S, w.input(), w.C, w.t);      // they let go
  assert.equal(w.S.neutral, null);
  // an idle stage never shows it (it replaces tiles, it isn't a new thing to look at)
  const v = world({ C: { unattributed_clear: true } });
  v.t = S0; M.step(v.S, Object.assign(v.input(), { others: [{ key: "anon:someone", since: S0 - 60e3 }] }), v.C, v.t);
  assert.equal(v.S.neutral, null);
  assert.equal(v.S.speaking, null, "and nothing to dim");
  // min on stage still applies: a tile added 3 s ago stays until min_on_stage_s
  const m = world({ C: { unattributed_clear: true } });
  m.grab("a"); m.at(0); m.at(2); m.drop("a"); m.at(3);
  const mI = () => Object.assign(m.input(), { others: [{ key: "x:ghost", since: S0 }] });
  m.t = S0 + 5000; M.step(m.S, mI(), m.C, m.t);
  assert.deepEqual(m.logins(), ["a"], "min_on_stage_s (10 s) first");
  m.t = S0 + 12000; M.step(m.S, mI(), m.C, m.t);
  assert.deepEqual(m.logins(), [], "then it gives way");
  // a proven holder who can't be shown (opted out / not noticed yet) speaking is the same as an unproven one
  const p = world({ C: { unattributed_clear: true } });
  p.grab("a"); p.at(0); p.at(2); p.drop("a"); p.at(12);
  p.cuts.set("b", "notice"); p.grab("b"); p.at(13); p.at(15.5);
  assert.deepEqual(p.logins(), [], "b isn't shown yet - a's face doesn't stay up while b talks");
  assert.equal(p.S.neutral, "someone");
  // ...and by default it dims instead
  const q = world();
  q.grab("a"); q.at(0); q.at(2); q.drop("a"); q.at(12);
  q.cuts.set("b", "notice"); q.grab("b"); q.at(13); q.at(15.5);
  assert.deepEqual(q.logins(), ["a"]);
  assert.equal(q.S.speaking, "someone");
});

test("30. Pepe alone on the mic (DF-12), mfix: his own mic-ups never clear the stage (S.speaking 'pepe', even with unattributed_clear); his card only once the tiles left", () => {
  for (const C of [{}, { unattributed_clear: true }]) {
    const w = world({ C });
    w.grab("a"); w.at(0); w.at(2); w.drop("a"); w.at(14);
    const I = (extra) => Object.assign(w.input(), { pepe: S0 + 15000 }, extra || {});
    const step = (sec, extra) => { w.t = S0 + sec * 1000; return M.step(w.S, I(extra), w.C, w.t).actions; };
    step(15); step(17.5);
    assert.deepEqual(w.logins(), ["a"], "a stays while Pepe talks");
    assert.equal(w.S.speaking, "pepe");
    assert.equal(w.S.neutral, null);
    assert.equal(M.hot(w.S, w.t), true, "the 1 s timer keeps stepping it");
    step(35);
    assert.deepEqual(w.logins(), [], "the idle hold ran out");
    assert.equal(w.S.neutral, "pepe", "Pepe's card once nobody is left");
    w.grab("c"); step(40); step(43);
    assert.deepEqual(w.logins(), ["c"]);
    assert.equal(w.S.neutral, null, "a person on the stage: no card");
    assert.equal(w.S.speaking, null, "a proven holder speaks: nothing dimmed");
  }
});

test("31. clearStage: everyone off now (relays released, spans closed 'cleared'), frozen; the cut cooldown applies after", () => {
  const w = world();
  w.grab("a"); w.grab("b"); w.at(0); w.at(2);
  const acts = M.clearStage(w.S, S0 + 3000, 30 * 60 * 1000);
  assert.deepEqual(w.logins(), []);
  assert.equal(acts.filter((x) => x.a === "release").length, 2);
  assert.equal(acts.filter((x) => x.a === "span_close" && x.reason === "cleared").length, 2);
  assert.equal(w.S.frozenUntil, S0 + 3000 + 30 * 60 * 1000);
  w.run(4, 60);
  assert.deepEqual(w.logins(), [], "frozen: nobody new");
  assert.ok(M.CUT.includes("blocked_owner"), "a person who blocked the pad owner is a CUT");
});

// ── mfix (owner 2026-10-25) ──
test("32. mfix soft failures: busy / a stray window / a slow open retry after soft_retry_s (soft_fails_max times), then the full backoff; ambiguous never retries soon", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 } });
  w.grab("a"); w.at(0);
  w.t = S0 + 2000; M.step(w.S, w.input(), w.C, w.t);
  M.holdDone(w.S, "a", false, "not_that_cam", w.C, w.t);
  assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", "retry"], "a stray window in the way: 'trying again'");
  w.held.delete("a"); w.live.delete("a");
  const n0 = w.actions.filter((x) => x.a === "hold").length;
  w.run(3, 21);
  assert.equal(w.actions.filter((x) => x.a === "hold").length, n0, "not before soft_retry_s (20 s)");
  w.at(23);
  assert.equal(w.actions.filter((x) => x.a === "hold").length, n0 + 1, "tried again after 20 s - not 10 minutes");
  M.holdDone(w.S, "a", false, "busy", w.C, w.t);
  assert.equal(w.S.tiles[0].why, "retry", "the second soft failure");
  w.held.delete("a"); w.run(24, 44);
  M.holdDone(w.S, "a", false, "busy", w.C, w.t);
  assert.equal(w.S.tiles[0].why, "failed", "the third in open_fail_backoff_min: the full backoff");
  w.held.delete("a");
  const n1 = w.actions.filter((x) => x.a === "hold").length;
  w.run(45, 200);
  assert.equal(w.actions.filter((x) => x.a === "hold").length, n1, "no retry storm");
  // two people go by that name: never soft
  const v = world();
  v.grab("b"); v.at(0); v.t = S0 + 2000; M.step(v.S, v.input(), v.C, v.t);
  M.holdDone(v.S, "b", false, "ambiguous", v.C, v.t);
  assert.equal(v.S.tiles[0].why, "failed");
  // a relay Pepe refused with a soft reason (sessionEnded) retries the same way; slots_busy is "full" for FULL_RETRY_MS
  const u = world();
  u.grab("c"); u.at(0); u.at(2);
  M.sessionEnded(u.S, "c", "start_timeout", u.C, S0 + 2500);
  assert.equal(u.S.tiles[0].why, "retry");
  const z = world();
  z.grab("d"); z.at(0); z.at(2);
  M.sessionEnded(z.S, "d", "slots_busy", z.C, S0 + 2500);
  assert.equal(z.S.tiles[0].why, "full");
  assert.ok(M.SOFT_WHYS.has("noswitch") && !M.SOFT_WHYS.has("ambiguous"));
});

test("33. mfix recent speakers (keep_recent): a back-and-forth on ONE mic shows side by side; the one off the mic longest is displaced first; a re-grab is no change; they leave after keep_recent", () => {
  // one mic slot in the room (one holder at a time), the pad side by side, keep 2 minutes
  const w = world({ pad: { layout: "split", keep_recent: 2 } });
  w.grab("a"); w.at(0); w.at(2);
  assert.deepEqual(w.logins(), ["a"]);
  w.drop("a"); w.grab("b"); w.at(15); w.at(17);
  assert.deepEqual(w.logins(), ["a", "b"], "a stays up (recent) and b joins: side by side");
  assert.equal(w.shape(), "split");
  assert.equal(M.newest(w.S).login, "b", "only the one holding the mic is the newest");
  // a grabs again: no change (a just holds again), b becomes the recent one
  const changes0 = w.actions.filter((x) => x.a === "touch" && x.why === "change").length;
  w.drop("b"); w.grab("a"); w.at(30); w.at(33);
  assert.deepEqual(w.logins(), ["a", "b"]);
  assert.equal(w.actions.filter((x) => x.a === "touch" && x.why === "change").length, changes0, "a re-grab by a recent speaker is no change");
  assert.equal(M.newest(w.S).login, "a");
  // c grabs: no room in split - the one off the mic longest (b, since 30) goes, a (holding until 40) stays
  w.drop("a"); w.at(40);
  w.grab("c"); w.at(50); w.at(53);
  assert.deepEqual(w.logins().sort(), ["a", "c"], "b (off the mic longest) was displaced, not a");
  assert.ok(w.actions.some((x) => x.a === "span_close" && x.login === "b" && x.reason === "displaced"));
  const relA = w.actions.filter((x) => x.a === "release" && x.login === "a").length;
  // nobody new: a (off since 40) stays up keep_recent (2 min), then leaves; c keeps holding
  w.run(54, 158);
  assert.ok(w.logins().includes("a"), "still up before 2 minutes");
  assert.equal(w.actions.filter((x) => x.a === "release" && x.login === "a").length, relA, "its relay stays held while it's a recent tile");
  w.run(159, 166);
  assert.deepEqual(w.logins(), ["c"], "a left after keep_recent");
  // without keep_recent: the plain hand-over (8 s)
  const v = world({ pad: { layout: "split", keep_recent: 0 } });
  v.grab("a"); v.at(0); v.at(2); v.drop("a"); v.grab("b"); v.at(15); v.at(17);
  v.run(18, 26);
  assert.deepEqual(v.logins(), ["b"], "a left after the hand-over");
});

test("34. mfix recent speakers: a recent tile whose cam goes off leaves after the plain hand-over; a consent cut takes it off at once; the single layout keeps the last speaker until displaced", () => {
  const w = world({ pad: { layout: "split", keep_recent: 2 } });
  w.grab("a"); w.at(0); w.at(2); w.drop("a"); w.grab("b"); w.at(15); w.at(17);
  w.offcam.add("a"); w.run(18, 22);
  assert.ok(w.logins().includes("a"), "the hand-over (8 s after 15) first");
  w.run(23, 26);
  assert.deepEqual(w.logins(), ["b"], "a 'cam off' recent tile isn't kept");
  // an opt-out of a recent speaker: off at once
  const c = world({ pad: { layout: "split", keep_recent: 5 } });
  c.grab("a"); c.at(0); c.at(2); c.drop("a"); c.at(20);
  c.cuts.set("a", "mf_opted_out"); c.at(21);
  assert.deepEqual(c.logins(), [], "persisted speakers never include someone who opted out");
  // single: the last speaker stays (keep_recent) until the next speaker displaces them
  const s = world({ pad: { layout: "single", keep_recent: 2 } });
  s.grab("a"); s.at(0); s.at(2); s.drop("a"); s.run(3, 100);
  assert.deepEqual(s.logins(), ["a"], "kept up between mic-ups");
  s.grab("b"); s.at(101); s.at(104);
  assert.deepEqual(s.logins(), ["b"], "displaced by the next speaker");
});

test("35. mfix pins: pinned people are never mic tiles, take places first (max_people), never candidates; single + a pin = picture in picture; maxPins leaves a mic place", () => {
  const w = world({ pad: { layout: "split" } });
  const step = (sec, pins) => { w.t = S0 + sec * 1000; const r = M.step(w.S, Object.assign(w.input(), { pins }), w.C, w.t); w.actions.push(...r.actions); return r.actions; };
  w.grab("a"); step(0, []); step(2, []);
  assert.deepEqual(w.logins(), ["a"]);
  // a gets pinned: their mic tile comes off (no duplicate), the release lets the mic stage's relay go
  const acts = step(3, ["a"]);
  assert.deepEqual(w.logins(), []);
  assert.ok(acts.some((x) => x.a === "span_close" && x.login === "a" && x.reason === "pinned"));
  assert.ok(!w.S.leftAt.has("a"), "no cooldown for a pinned person");
  // a holds the mic but is pinned: not a candidate; b grabs and takes the one mic place left (split = 2, one pinned)
  w.grab("b"); step(4, ["a"]); step(7, ["a"]);
  assert.deepEqual(w.logins(), ["b"]);
  assert.equal(M.shapeOf(w.S, w.pad), "split", "1 pin + 1 mic tile side by side");
  w.grab("c"); step(20, ["a"]); step(23, ["a"]); step(40, ["a"]);
  assert.equal(w.logins().length, 1, "only one mic place beside the pin");
  // a pinned holder is attributed speech (no dimming while they talk)
  w.drop("b"); w.drop("c"); step(60, ["a"]);
  assert.equal(w.S.speaking, null);
  // single + a pin: picture in picture
  assert.equal(M.shapeFor("single", 1, 1), "pip");
  assert.equal(M.shapeFor("single", 0, 1), "single");
  assert.equal(M.shapeFor("auto", 2, 2), "grid4");
  assert.equal(M.maxPins("single", 4, 2), 1);
  assert.equal(M.maxPins("split", 4, 2), 1, "split: one pin, one mic place");
  assert.equal(M.maxPins("auto", 4, 2), 2);
  assert.equal(M.maxPins("auto", 2, 2), 1, "max_people 2: one pin");
  assert.equal(M.maxPins("auto", 1, 2), 0, "max_people 1: no pin (the mic place stays)");
  // unpinned: back to the mic rules (a holds the mic -> a candidate again)
  step(70, []); step(73, []);
  assert.ok(w.logins().includes("a"), "back as a mic tile");
});

test("36. mfix card reasons: cold opens off / the rate limit / the site's relays / Pepe's pool / the pad's live places", () => {
  for (const [site, why] of [[{ coldLeft: 0, coldWhy: "cold_off" }, "cold_off"], [{ coldLeft: 0, coldWhy: "rate" }, "rate"],
                             [{ coldLeft: 0, coldWhy: "relays" }, "relays"], [{ coldLeft: 9, poolLeft: 0 }, "pool"], [{ coldLeft: 9, shed: true }, "pool"]]) {
    const w = world({ site: { stillsLeft: 0, ...site } });
    w.grab("a"); w.at(0); w.at(2);
    assert.deepEqual([w.S.tiles[0].video, w.S.tiles[0].why], ["card", why], JSON.stringify(site));
  }
  const p = world({ pad: { max_live: 1 }, site: { stillsLeft: 0 } });
  p.grab("a"); p.grab("b"); p.at(0); p.at(2);
  assert.ok(p.S.tiles.some((x) => x.why === "pad_cap"));
  for (const k of ["off_cam", "failed", "retry", "full", "cold_off", "rate", "relays", "pool", "pad_cap"]) assert.ok(M.CARD_WHYS.includes(k));
});

// ── 1.99afl: the incognito / mic-stage spec, F.1 S1 / S1b / S2 / S4 ──
const vw = (w, l) => { const x = w.S.tiles.find((y) => y.login === l); return x ? [x.video, x.why] : null; };

test("37. 1.99afl S1: a refused still is soft unless Pepe says it's for good - another try after soft_retry_s, no still while that retry holds; hard codes back off", () => {
  // no code (an older Pepe), Pepe's soft codes, his catch-all "failed" (review: not_open / an error / not that cam / an unmapped
  // status in bot 1.99afk) and a code this build doesn't know: "trying again", never the 10 minutes at once
  for (const code of [null, "busy", "noswitch", "start_timeout", "wrong_room", "failed", "something_new"]) {
    const w = world({ site: { coldLeft: 0, stillsLeft: 2 } });
    w.grab("z"); w.at(0); w.at(2);
    assert.equal(w.S.tiles[0].video, "still");
    const acts = M.stillFailed(w.S, "z", w.C, w.t, code);
    assert.ok(acts.some((a) => a.a === "still_stop"), String(code));
    assert.deepEqual(vw(w, "z"), ["card", "retry"], String(code));
    assert.ok(!(w.S.backoff.get("z") > w.t), "no 10-minute backoff: " + code);
    w.actions = [];
    w.at(3);
    assert.ok(!w.actions.some((a) => a.a === "still"), "no still while the soft retry holds the person: " + code);
    assert.deepEqual(vw(w, "z"), ["card", "retry"]);
    w.at(2 + w.C.soft_retry_s + 1);
    assert.equal(w.S.tiles[0].video, "still", "tried again after soft_retry_s: " + code);
  }
  assert.deepEqual([...M.STILL_HARD].sort(), ["ambiguous", "not_in_list", "not_on_cam", "not_public"],
    "the spec's two + the live path's 'ambiguous' + bot 1.99afk's 'not_in_list' (re-review: 'failed' stays soft)");
  for (const code of ["not_public", "not_on_cam", "ambiguous", "not_in_list"]) {
    const w = world({ site: { coldLeft: 0, stillsLeft: 2 } });
    w.grab("z"); w.at(0); w.at(2);
    M.stillFailed(w.S, "z", w.C, w.t, code);
    assert.deepEqual(vw(w, "z"), ["card", "failed"], code);
    assert.ok(w.S.backoff.get("z") > w.t + 9 * 60 * 1000, code + ": the full backoff");
    w.at(60);
    assert.notEqual(w.S.tiles[0].video, "still", code);
  }
  // soft_fails_max soft refusals within open_fail_backoff_min -> then the full backoff ("failed" is bounded the same way)
  for (const code of ["busy", "failed"]) {
    const m = world({ site: { coldLeft: 0, stillsLeft: 2 } });
    m.grab("z"); m.at(0); m.at(2);
    let s = 2;
    for (let i = 1; i < m.C.soft_fails_max; i++) {
      M.stillFailed(m.S, "z", m.C, m.t, code);
      assert.deepEqual(vw(m, "z"), ["card", "retry"], code + ": soft " + i);
      s += m.C.soft_retry_s + 1; m.at(s);
      assert.equal(m.S.tiles[0].video, "still");
    }
    M.stillFailed(m.S, "z", m.C, m.t, code);
    assert.deepEqual(vw(m, "z"), ["card", "failed"], code + ": soft_fails_max -> the backoff");
    assert.ok(m.S.backoff.get("z") > m.t + 9 * 60 * 1000);
  }
});

test("38. 1.99afl S1: a live open that soft-fails never starts a still in the same breath (the old chain: still refused -> 10 minutes of 'couldn't open')", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 2 } });
  w.grab("a"); w.at(0);
  w.t = S0 + 2000;
  assert.ok(M.step(w.S, w.input(), w.C, w.t).actions.some((a) => a.a === "hold" && a.login === "a"));
  M.holdDone(w.S, "a", false, "busy", w.C, w.t);
  assert.deepEqual(vw(w, "a"), ["card", "retry"]);
  w.actions = [];
  for (let s = 3; s <= 2 + w.C.soft_retry_s - 1; s++) w.at(s);
  assert.ok(!w.actions.some((a) => a.a === "still" || a.a === "hold"), "no still, no open while the soft retry holds");
  assert.ok(!(w.S.backoff.get("a") > w.t), "and no backoff");
  w.at(2 + w.C.soft_retry_s + 1);
  assert.ok(w.actions.some((a) => a.a === "hold" && a.login === "a"), "the live open is tried again");
});

test("39. 1.99afl S1b: list_unread pauses the ROOM - no exact opens or stills, nothing counted, no backoff; a newer complete read resumes it, clears the pause's blocks, one attempt each", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 4 } });
  w.listAt = S0 - 60 * 1000; w.listFresh = true;
  for (const l of ["a", "b", "c"]) w.grab(l);
  w.t = S0; M.step(w.S, w.input(), w.C, w.t);
  w.t = S0 + 2000;
  const holds = M.step(w.S, w.input(), w.C, w.t).actions.filter((a) => a.a === "hold").map((a) => a.login).sort();
  assert.deepEqual(holds, ["a", "b", "c"]);
  // a's and b's exact opens come back "list unread"; c's relay was opened
  M.holdDone(w.S, "a", false, "list_unread", w.C, w.t);
  assert.ok(w.S.listPause, "the room pauses");
  M.holdDone(w.S, "b", false, "list_unread", w.C, w.t);
  M.holdDone(w.S, "c", true, null, w.C, w.t);
  w.held.add("c"); w.live.set("c", "connecting");
  assert.deepEqual(vw(w, "a"), ["card", "list_unread"]);
  assert.deepEqual(vw(w, "b"), ["card", "list_unread"]);
  // c's relay then fails for a hard reason while paused: its backoff is a pause-era one
  M.sessionEnded(w.S, "c", "open_failed", w.C, w.t);
  w.held.delete("c"); w.live.set("c", "ended");
  assert.ok(w.S.backoff.get("c") > w.t);
  w.actions = [];
  for (let s = 3; s <= 40; s++) w.at(s);
  assert.ok(!w.actions.some((a) => a.a === "hold" || a.a === "still"), "no exact open, no still while paused");
  assert.equal(w.S.soft.size, 0, "never counted as a soft failure");
  for (const l of ["a", "b"]) { assert.ok(!(w.S.backoff.get(l) > w.t), l + ": no backoff"); assert.ok(!(w.S.liveBlock.get(l) > w.t), l + ": no liveBlock"); }
  for (const l of ["a", "b", "c"]) assert.deepEqual(vw(w, l), ["card", "list_unread"], l + ": every tile without a live relay says why");
  // a stale read, or the same complete read again, doesn't end it
  w.listAt = S0 + 30 * 1000; w.listFresh = false; w.at(41);
  w.listAt = S0 - 60 * 1000; w.listFresh = true; w.at(42);
  assert.ok(w.S.listPause, "still paused");
  // a newer complete read: resumed - the pause's backoff (c) is cleared and each tile gets one attempt
  w.listAt = S0 + 42 * 1000; w.listFresh = true; w.actions = [];
  w.at(43);
  assert.equal(w.S.listPause, null);
  assert.deepEqual(w.actions.filter((a) => a.a === "hold").map((a) => a.login).sort(), ["a", "b", "c"]);
  assert.ok(!(w.S.backoff.get("c") > w.t), "the pause-era backoff is gone");
  // a relay that ends "list unread" and a still refused "list unread" pause too; without a newer read the pause tries once more
  // after LIST_PAUSE_MAX_MS (and pauses again if the list is still unread)
  const r = world(); r.grab("y"); r.at(0); r.at(2);
  M.sessionEnded(r.S, "y", "list_unread", r.C, r.t);
  assert.ok(r.S.listPause);
  assert.deepEqual(vw(r, "y"), ["card", "list_unread"]);
  assert.equal(r.S.soft.size, 0);
  const s = world({ site: { coldLeft: 0, stillsLeft: 2 } }); s.grab("z"); s.at(0); s.at(2);
  assert.equal(s.S.tiles[0].video, "still");
  M.stillFailed(s.S, "z", s.C, s.t, "list_unread");
  assert.deepEqual(vw(s, "z"), ["card", "list_unread"]);
  assert.ok(!(s.S.backoff.get("z") > s.t) && !(s.S.liveBlock.get("z") > s.t));
  s.actions = [];
  s.at(60);
  assert.ok(!s.actions.some((a) => a.a === "still"));
  s.at(2 + M.LIST_PAUSE_MAX_MS / 1000 + 1);
  assert.equal(s.S.listPause, null);
  assert.equal(s.S.tiles[0].video, "still", "one more try after LIST_PAUSE_MAX_MS");
  for (const k of ["list_unread", "cam_unknown", "pepe"]) assert.ok(M.CARD_WHYS.includes(k), k);
  assert.ok(M.FAIL_WHYS.has("list_unread") && M.SOFT_WHYS.has("list_unread"));
  // review: a LIVE tile keeps running through the whole pause (never released, never a card)
  const L = world({ site: { coldLeft: 9, stillsLeft: 4 } });
  L.grab("p"); L.grab("q"); L.at(0); L.at(2);
  L.live.set("p", "live"); L.at(3);
  assert.equal(vw(L, "p")[0], "live");
  M.sessionEnded(L.S, "q", "list_unread", L.C, L.t);                // q's open: Pepe can't read the list
  L.held.delete("q"); L.live.set("q", "ended");
  assert.ok(L.S.listPause);
  L.actions = [];
  for (let s = 4; s <= 120; s++) L.at(s);
  assert.ok(L.S.listPause, "still paused (no newer complete read)");
  assert.equal(vw(L, "p")[0], "live", "the live tile ran through the pause");
  assert.ok(!L.actions.some((a) => a.a === "release" && a.login === "p"), "never released");
  assert.deepEqual(vw(L, "q"), ["card", "list_unread"]);
  // review: a warm relay Pepe already verified by the exact name (a ▶ Live viewer's) needs no list - held during the pause; an
  // unverified one isn't (Pepe would re-open it by the exact name: a list read)
  const K = world({ site: { coldLeft: 9, stillsLeft: 4 } });
  K.grab("y"); K.at(0); K.at(2);
  M.sessionEnded(K.S, "y", "list_unread", K.C, K.t); K.held.delete("y"); K.live.set("y", "ended");
  assert.ok(K.S.listPause);
  K.live.set("k", "live"); K.live.set("m", "live"); K.exactNo.add("m");
  K.grab("k"); K.grab("m"); K.actions = [];
  for (let s = 3; s <= 12; s++) K.at(s);
  assert.ok(K.actions.some((a) => a.a === "hold" && a.login === "k" && a.cold === false), "the verified warm relay is held");
  assert.ok(!K.actions.some((a) => a.a === "hold" && (a.login === "m" || a.login === "y")), "nothing that needs the list");
  assert.ok(!K.actions.some((a) => a.a === "still"), "and no still");
  assert.deepEqual(vw(K, "m"), ["card", "list_unread"]);
  assert.equal(vw(K, "k")[0], "live");
});

test("40. 1.99afl S2: cam_unknown is 'checking their cam…' - no blind open or still; one exact open per list-read epoch, only after a read that began after the grab; a live relay keeps running", () => {
  // review: Pepe through 1.99afk (mf 1) refuses a cam his roster can't classify at once - the mic stage asks for none: the tile
  // says "checking their cam…" through every list-read epoch, never "cam off", never a hold
  const o = world({ site: { coldLeft: 9, stillsLeft: 4, unkOpen: false } });
  o.unknown.add("u"); o.grab("u", S0); o.at(0);
  for (let s = 1; s <= 120; s++) { if (s % 20 === 0) { o.listAt = S0 + s * 1000; o.listFresh = true; } o.at(s); }
  assert.ok(!o.actions.some((a) => a.a === "hold" || a.a === "still"), "no open at all with today's Pepe");
  assert.deepEqual(vw(o, "u"), ["card", "cam_unknown"]);
  // a Pepe that opens such a cam by its exact name (site.unkOpen: mf >= MF_UNK_OPEN)
  assert.equal(M.MF_UNK_OPEN, 2);
  const w = world({ site: { coldLeft: 9, stillsLeft: 4, unkOpen: true } });
  w.unknown.add("u");
  w.listAt = S0 - 60 * 1000; w.listFresh = true;              // the last complete read was before the grab
  w.grab("u", S0); w.at(0); w.at(2);
  assert.deepEqual(vw(w, "u"), ["card", "cam_unknown"], "on the stage, checking");
  assert.ok(!w.actions.some((a) => a.a === "hold" || a.a === "still"), "no blind open, no still");
  w.listAt = S0 + 5 * 1000; w.listFresh = false; w.at(6);      // a read after the grab, but not a complete one
  assert.ok(!w.actions.some((a) => a.a === "hold"));
  w.listFresh = true;                                          // ... complete, and it still can't say: ONE exact open
  w.t = S0 + 7000;
  const acts = M.step(w.S, w.input(), w.C, w.t).actions;
  assert.equal(acts.filter((a) => a.a === "hold" && a.login === "u").length, 1);
  M.holdDone(w.S, "u", false, "busy", w.C, w.t);                // (it didn't work out)
  w.actions = [];
  for (let s = 8; s <= 8 + w.C.soft_retry_s + 5; s++) w.at(s);
  assert.ok(!w.actions.some((a) => a.a === "hold" || a.a === "still"), "at most one exact open per epoch");
  assert.deepEqual(vw(w, "u"), ["card", "cam_unknown"]);
  w.listAt = S0 + 40 * 1000; w.actions = [];                   // the next complete read: the next epoch's one try
  w.at(41);
  assert.equal(w.actions.filter((a) => a.a === "hold" && a.login === "u").length, 1);
  // ... Pepe refuses it "not_on_cam" (his _lv_why_not: on_cam isn't TRUE) - review: that is "checking their cam…", never "cam
  // off" (no off-cam block, nothing counted); no second open before the next complete read
  w.held.delete("u"); w.live.set("u", "ended");
  const soft0 = (w.S.soft.get("u") || []).length;               // (the earlier epoch's "busy" was one)
  M.sessionEnded(w.S, "u", "not_on_cam", w.C, w.t);
  assert.deepEqual(vw(w, "u"), ["card", "cam_unknown"]);
  assert.ok(!w.S.offcam.has("u") && !(w.S.backoff.get("u") > w.t) && (w.S.soft.get("u") || []).length === soft0, "no block, nothing counted");
  w.actions = [];
  for (let s = 42; s <= 70; s++) w.at(s);
  assert.ok(!w.actions.some((a) => a.a === "hold"), "one per epoch");
  assert.deepEqual(vw(w, "u"), ["card", "cam_unknown"], "never 'cam off' in between");
  w.listAt = S0 + 70 * 1000; w.actions = []; w.at(71);
  assert.equal(w.actions.filter((a) => a.a === "hold" && a.login === "u").length, 1, "the next epoch's one try");
  // the site's own consent refusal for an unknown cam (holdDone "not_on_cam") reads the same
  M.holdDone(w.S, "u", false, "not_on_cam", w.C, w.t);
  assert.deepEqual(vw(w, "u"), ["card", "cam_unknown"]);
  assert.ok(!w.S.offcam.has("u"));
  // speech: a cam_unknown holder is someone the stage can show (never "someone else is speaking")
  assert.equal(w.S.speaking, null);
  // Pepe's own tick stops a RUNNING relay "not_on_cam" when his roster's on_cam goes unknown: "checking their cam…" - whichever
  // order the site hears it in (the roster unknown first, or the end first and the unknown roster after)
  const q = world(); q.grab("x"); q.grab("y"); q.at(0); q.at(2); q.live.set("x", "live"); q.live.set("y", "live"); q.at(3);
  assert.deepEqual([vw(q, "x")[0], vw(q, "y")[0]], ["live", "live"]);
  q.unknown.add("x"); q.at(4);
  q.held.delete("x"); q.live.set("x", "ended");
  M.sessionEnded(q.S, "x", "not_on_cam", q.C, q.t);
  assert.deepEqual(vw(q, "x"), ["card", "cam_unknown"]);
  assert.ok(!q.S.offcam.has("x"));
  q.held.delete("y"); q.live.set("y", "ended");
  M.sessionEnded(q.S, "y", "not_on_cam", q.C, q.t);                // the roster still said "on cam" here: a real cam-off end ...
  assert.deepEqual(vw(q, "y"), ["card", "off_cam"]);
  q.unknown.add("y"); q.at(5);                                      // ... then the roster can't say: "checking", the reopen block kept
  assert.deepEqual(vw(q, "y"), ["card", "cam_unknown"]);
  assert.ok(q.S.offcam.has("y"));
  // cold opens unavailable: never a still instead
  const n = world({ site: { coldLeft: 0, stillsLeft: 4 } });
  n.unknown.add("n"); n.listAt = S0 + 5000; n.listFresh = true;
  n.grab("n", S0); n.at(0); n.at(6); n.at(10);
  assert.ok(!n.actions.some((a) => a.a === "still"), "no still for a cam the roster can't classify");
  // a live relay proves the cam is on: cam_unknown never ends it
  const v = world(); v.grab("x"); v.at(0); v.at(2); v.live.set("x", "live"); v.at(3);
  assert.equal(v.S.tiles[0].video, "live");
  v.unknown.add("x"); v.actions = [];
  for (let s = 4; s <= 30; s++) v.at(s);
  assert.equal(v.S.tiles[0].video, "live");
  assert.ok(!v.actions.some((a) => a.a === "release"));
  // a warm relay (it runs: the cam IS on) may be held while the roster can't say
  const k = world(); k.unknown.add("k"); k.live.set("k", "live");
  k.grab("k"); k.at(0); k.at(2);
  assert.ok(k.actions.some((a) => a.a === "hold" && a.login === "k" && a.cold === false));
  // a still tile whose cam the roster stops knowing stops its still
  const t = world({ site: { coldLeft: 0, stillsLeft: 2 } }); t.grab("t"); t.at(0); t.at(2);
  assert.equal(t.S.tiles[0].video, "still");
  t.unknown.add("t"); t.actions = []; t.at(3);
  assert.ok(t.actions.some((a) => a.a === "still_stop"));
  assert.deepEqual(vw(t, "t"), ["card", "cam_unknown"]);
});

test("41. 1.99afl S4: Pepe's cam relay not there ('nopepe') says so on the card while it's tried again soon (no still meanwhile)", () => {
  const h = world({ site: { coldLeft: 9, stillsLeft: 2 } });
  h.grab("y"); h.at(0);
  h.t = S0 + 2000;
  M.step(h.S, h.input(), h.C, h.t);
  M.holdDone(h.S, "y", false, "nopepe", h.C, h.t);
  assert.deepEqual(vw(h, "y"), ["card", "pepe"]);
  h.actions = [];
  h.at(3); h.at(10);
  assert.deepEqual(vw(h, "y"), ["card", "pepe"]);
  assert.ok(!h.actions.some((a) => a.a === "still" || a.a === "hold"));
  h.at(2 + h.C.soft_retry_s + 1);
  assert.ok(h.actions.some((a) => a.a === "hold" && a.login === "y"), "tried again");
});

test("47. wave2 F.3 dynamic: a layout like auto (cap 9, the auto shape as the legacy layout); dynPick moves the main to the active speaker at most every main_hold_s, at once when the main left", () => {
  assert.ok(M.LAYOUTS.includes("dynamic"));
  assert.equal(M.layoutCap("dynamic"), 9);
  for (const n of [0, 1, 2, 3, 4, 5, 9]) assert.equal(M.layoutFor("dynamic", n), M.layoutFor("auto", n), "n=" + n);
  assert.equal(M.shapeFor("dynamic", 1, 1), "split", "a pin beside one tile: never pip (that's single's rule)");
  const H = 3000;
  let m = M.dynPick(null, ["a"], "a", 0, H);
  assert.deepEqual(m, { id: "a", at: 0 });
  m = M.dynPick(m, ["a", "b"], "b", 1000, H);
  assert.equal(m.id, "a", "within main_hold_s: stays");
  m = M.dynPick(m, ["a", "b"], "b", 3000, H);
  assert.deepEqual(m, { id: "b", at: 3000 }, "then the active speaker");
  m = M.dynPick(m, ["a", "b"], null, 3500, H);
  assert.equal(m.id, "b", "nobody speaking: the current main stays");
  m = M.dynPick(m, ["a", "c"], null, 3600, H);
  assert.deepEqual(m, { id: "a", at: 3600 }, "the main left: the first entry at once (no hysteresis for a gone main)");
  m = M.dynPick(m, ["a", "c"], "c", 3700, H);
  assert.equal(m.id, "a", "a fresh main holds too");
  assert.equal(M.dynPick(m, [], "c", 9000, H), null, "nobody on the stage");
  assert.deepEqual(M.dynPick(null, ["x", "y"], "zz", 0, H), { id: "x", at: 0 }, "an unknown want: the first");
  assert.deepEqual(M.dynPick({ id: "x", at: 0 }, ["x", "y"], "y", 1, 0), { id: "y", at: 1 }, "main_hold_s 0: at once");
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.2, J-10): kept relays ("warm keep") ──
/** world() + kept relays: the wiring of micfollow.js / livecam (keep -> the relay stays up under "mfw:", keep_drop -> it ends,
 *  keep_taken -> the comeback's hold owns it); the kept logins get elig / sess like micfollow.stepPad gives them. */
function warmWorld(opts = {}) {
  const w = world(Object.assign({}, opts, { C: Object.assign({ warm_keep_s: 180, warm_max: 3 }, opts.C || {}) }));
  w.kept = new Set(); w.pins = null;
  const input0 = w.input;
  w.input = () => {
    const I = input0();
    for (const l of w.S.kept.keys()) {
      if (!I.elig.has(l)) I.elig.set(l, w.cuts.get(l) || (w.pending.has(l) ? "pending" : w.offcam.has(l) ? "off_cam" : w.unknown.has(l) ? "cam_unknown" : "ok"));
      const st = w.live.get(l) || "none";
      if (!I.sess.has(l)) I.sess.set(l, { state: st, held: w.held.has(l), exact: w.exactNo.has(l) ? false : st === "live" ? true : null, viewers: 0 });
    }
    for (const [l, s] of I.sess) s.kept = w.kept.has(l);
    if (w.pins) I.pins = w.pins;
    return I;
  };
  w.after = (acts) => {
    for (const a of acts) {
      if (a.a === "hold") {
        w.held.add(a.login);
        if (!w.live.has(a.login) || w.live.get(a.login) === "ended") w.live.set(a.login, "connecting");
        const more = M.holdDone(w.S, a.login, true, null, w.C, w.t);
        w.actions.push(...more); w.after(more);
      }
      if (a.a === "release") { w.held.delete(a.login); if (!w.kept.has(a.login)) w.live.set(a.login, "ended"); }
      if (a.a === "keep") { w.held.delete(a.login); w.kept.add(a.login); }
      if (a.a === "keep_drop") { w.kept.delete(a.login); if (!w.held.has(a.login)) w.live.set(a.login, "ended"); }
      if (a.a === "keep_taken") w.kept.delete(a.login);
    }
  };
  w.step = () => { const r = M.step(w.S, w.input(), w.C, w.t); w.actions.push(...r.actions); w.after(r.actions); return r.actions; };
  return w;
}
/** `l` on the stage, live (from second at0). */
function onLive(w, l, at0 = 0) {
  w.grab(l); w.at(at0); w.at(at0 + 2); w.live.set(l, "live"); w.at(at0 + 3);
  assert.equal(vw(w, l)[0], "live", l + " is live");
}
/** `l` was live and left: kept since second `leftAt` (built directly - the pure state micfollow.js would have). */
function kept(w, l, leftAt, until) {
  w.S.kept.set(l, { leftAt: S0 + leftAt * 1000, until: S0 + (until == null ? leftAt + 180 : until) * 1000 });
  w.kept.add(l); w.live.set(l, "live");
}

test("42. wave2 F.2 warm keep: a LIVE tile leaving for a plain reason keeps its relay (keep, never release); warm_keep_s 0 = today; never after a cut, off cam, starting, cold opens off or warm_max 0", () => {
  const w = warmWorld();
  onLive(w, "a");
  w.drop("a"); w.actions = [];
  w.run(4, 30);
  assert.deepEqual(w.logins(), [], "off the stage (the last-on lock, then released)");
  assert.equal(count(w.actions, "keep"), 1);
  assert.equal(count(w.actions, "release"), 0, "the relay is NOT let go");
  const k = w.S.kept.get("a");
  assert.ok(k && k.until - k.leftAt === 180 * 1000, "kept warm_keep_s");
  assert.ok(w.actions.some((a) => a.a === "span_close" && a.login === "a" && a.reason === "released"), "its span closes as usual");
  assert.equal(M.hot(w.S, w.t), true, "the 1 s timer keeps stepping a pad with kept relays");
  // today (warm_keep_s 0): released
  const z = warmWorld({ C: { warm_keep_s: 0 } });
  onLive(z, "a"); z.drop("a"); z.actions = []; z.run(4, 30);
  assert.equal(count(z.actions, "keep"), 0); assert.equal(count(z.actions, "release"), 1); assert.equal(z.S.kept.size, 0);
  // a cut: released, never kept
  const c = warmWorld();
  onLive(c, "a"); c.cuts.set("a", "opted_out"); c.actions = []; c.at(4);
  assert.equal(count(c.actions, "keep"), 0); assert.equal(count(c.actions, "release"), 1);
  // off cam when it leaves (the off_cam card let go already): no keep
  const o = warmWorld();
  onLive(o, "a"); o.offcam.add("a"); o.drop("a"); o.actions = []; o.run(4, 40);
  assert.equal(count(o.actions, "keep"), 0); assert.equal(o.S.kept.size, 0);
  // not live yet (starting): nothing worth keeping
  const s = warmWorld();
  s.grab("a"); s.at(0); s.at(2); s.drop("a"); s.actions = []; s.run(3, 30);
  assert.equal(count(s.actions, "keep"), 0); assert.equal(count(s.actions, "release"), 1);
  // cold opens off / warm_max 0: a kept relay would never be worth it
  for (const C of [{ cold_open: false }, { warm_max: 0 }]) {
    const q = warmWorld({ C, site: { coldLeft: 9 } });
    q.live.set("a", "live"); q.grab("a"); q.at(0); q.at(2); q.at(3);
    assert.equal(vw(q, "a")[0], "live", "(a warm relay held)");
    q.drop("a"); q.actions = []; q.run(4, 30);
    assert.equal(count(q.actions, "keep"), 0, JSON.stringify(C));
  }
  // a pinned person: the pin holds the relay, never kept as a mic tile
  const p = warmWorld();
  onLive(p, "a"); p.pins = ["a"]; p.actions = []; p.at(4);
  assert.equal(count(p.actions, "keep"), 0);
});

test("43. wave2 F.2 comeback: a kept person who qualifies again takes the running relay - no cold-open budget, no still, live in one step", () => {
  const w = warmWorld();
  onLive(w, "a");
  w.drop("a"); w.run(4, 30);
  assert.ok(w.S.kept.has("a"));
  w.site.coldLeft = 0; w.site.stillsLeft = 0; w.site.poolLeft = 0;    // no budget at all: a cold open / still couldn't happen
  w.actions = [];
  w.grab("a"); w.at(40); w.at(42);
  const hold = w.actions.find((a) => a.a === "hold" && a.login === "a");
  assert.ok(hold && hold.cold === false, "the running-relay hold (no cold open)");
  assert.ok(w.actions.some((a) => a.a === "keep_taken" && a.login === "a"), "the hold took the kept relay over");
  assert.equal(count(w.actions, "still"), 0);
  assert.equal(w.S.kept.size, 0);
  w.at(42.2);                                                       // micfollow.js steps at once after keep_taken
  assert.equal(vw(w, "a")[0], "live", "live straight away");
  const pic = w.actions.find((a) => a.a === "picture" && a.login === "a");
  assert.ok(pic && pic.kept === true && pic.warm === true, "a kept comeback (its latency is measured on its own)");
  // a comeback whose hold is refused (consent): the kept relay ends
  const r = warmWorld();
  onLive(r, "a"); r.drop("a"); r.run(4, 30);
  r.grab("a"); r.at(40);
  r.t = S0 + 42000;
  const acts = M.step(r.S, r.input(), r.C, r.t).actions;
  assert.ok(acts.some((a) => a.a === "hold" && a.login === "a"));
  const done = M.holdDone(r.S, "a", false, "unavailable", r.C, r.t);
  assert.ok(done.some((a) => a.a === "keep_drop" && a.login === "a" && a.why === "refused_unavailable"));
  assert.equal(r.S.kept.size, 0);
});

test("44. wave2 F.2: EVERY end reason ends a kept relay within one step; cam_unknown (and notice) never do", () => {
  const cases = [
    ...M.CUT.map((code) => [code, (w) => w.cuts.set("a", code), code]),
    ["off cam", (w) => w.offcam.add("a"), "off_cam"],
    ["a fact look-up pending", (w) => w.pending.add("a"), "elig_pending"],
    ["the relay ended", (w) => w.live.set("a", "ended"), "relay"],
    ["Pepe says it isn't exact", (w) => w.exactNo.add("a"), "relay"],
    ["its warm holder went", (w) => w.kept.delete("a"), "relay"],
    ["pinned", (w) => { w.pins = ["a"]; }, "pinned"],
    ["cold opens off", (w) => { w.C.cold_open = false; }, "cold_off"],
    ["warm keep off", (w) => { w.C.warm_keep_s = 0; }, "keep_off"],
    ["warm_max 0", (w) => { w.C.warm_max = 0; }, "keep_off"],
    ["the stage stops (pad off)", (w) => { w.why_off = "pad_off"; }, "off"],
    ["Pepe's sync stale with nothing on the stage", (w) => { w.why_off = "stale"; }, "off"],
  ];
  for (const [name, fn, why] of cases) {
    const w = warmWorld();
    kept(w, "a", 0);
    w.at(1);
    assert.ok(w.S.kept.has("a"), name + ": kept before");
    fn(w); w.actions = [];
    w.at(2);
    const d = w.actions.find((a) => a.a === "keep_drop" && a.login === "a");
    assert.ok(d, name + ": dropped within one step");
    assert.equal(d.why, why, name);
    assert.equal(w.S.kept.size, 0, name);
  }
  // expiry
  const e = warmWorld(); kept(e, "a", 0, 100);
  e.at(99); assert.ok(e.S.kept.has("a"));
  e.actions = []; e.at(100);
  assert.ok(e.actions.some((a) => a.a === "keep_drop" && a.why === "expired"));
  // the owner's ✕ / an exclusion (cutNow) and Clear the stage
  const x = warmWorld(); kept(x, "a", 0); x.at(1);
  assert.ok(M.cutNow(x.S, "a", "excluded", x.t).some((a) => a.a === "keep_drop" && a.why === "excluded"));
  const cl = warmWorld(); kept(cl, "a", 0); cl.at(1);
  assert.ok(M.clearStage(cl.S, cl.t, 60e3).some((a) => a.a === "keep_drop" && a.why === "cleared"));
  // the stale hold: kept relays stay under every rule (a cut ends one while the program is held)
  const st = warmWorld(); onLive(st, "b"); kept(st, "a", 1); st.at(4);
  st.why_off = "stale"; st.cuts.set("a", "hidden"); st.actions = []; st.at(5);
  assert.ok(st.actions.some((a) => a.a === "keep_drop" && a.login === "a" && a.why === "hidden"), "cut under the stale hold");
  // cam_unknown / notice: a running relay proves the cam is on - kept
  for (const set of [(w) => w.unknown.add("a"), (w) => w.cuts.set("a", "notice")]) {
    const u = warmWorld(); kept(u, "a", 0); set(u); u.actions = [];
    for (let s = 1; s <= 60; s++) u.at(s);
    assert.equal(count(u.actions, "keep_drop"), 0);
    assert.ok(u.S.kept.has("a"));
  }
});

test("45. wave2 F.2 budget: a pad keeps no more relays than its max_live leaves beside the live tiles - least recently used first; a comeback that gets no hold lets go", () => {
  const w = warmWorld({ pad: { max_live: 2 } });
  kept(w, "a", 0); kept(w, "b", 5);
  w.at(6);
  assert.deepEqual([...w.S.kept.keys()].sort(), ["a", "b"], "two fit beside no live tile");
  w.grab("c"); w.at(7); w.actions = []; w.at(9);
  assert.ok(w.S.tiles.some((x) => x.login === "c" && x.pend === false), "c on the stage, its relay held");
  const d = w.actions.filter((a) => a.a === "keep_drop");
  assert.deepEqual(d.map((a) => [a.login, a.why]), [["a", "pad_full"]], "a left the stage first: it goes");
  assert.deepEqual([...w.S.kept.keys()], ["b"]);
  // a kept person back on the stage whose tile gets no hold (backed off): the kept relay lets go
  const n = warmWorld(); kept(n, "a", 0);
  n.S.backoff.set("a", S0 + 3600e3);
  n.grab("a"); n.at(1); n.actions = []; n.at(3);
  assert.ok(n.S.tiles.some((x) => x.login === "a"));
  assert.ok(n.actions.some((a) => a.a === "keep_drop" && a.login === "a" && a.why === "not_taken"));
});

test("46. wave2 F.2 eviction: an open / still beyond what's free without a kept relay is marked evict; a slots_busy right after an eviction is retried ONCE after 2 s (never soft, no liveBlock, no backoff); a second takes the normal path", () => {
  const w = warmWorld({ site: { coldLeft: 1, coldFree: 0, poolLeft: 3, poolFree: 3 } });
  w.grab("x"); w.at(0);
  w.t = S0 + 2000;
  let acts = M.step(w.S, w.input(), w.C, w.t).actions;
  assert.ok(acts.some((a) => a.a === "hold" && a.login === "x" && a.cold === true && a.evict === true), "needs a kept relay's room");
  const free = warmWorld({ site: { coldLeft: 2, coldFree: 1 } });
  free.grab("x"); free.at(0); free.t = S0 + 2000;
  assert.ok(M.step(free.S, free.input(), free.C, free.t).actions.some((a) => a.a === "hold" && !a.evict), "a free relay: no eviction");
  const st = warmWorld({ site: { coldLeft: 0, stillsLeft: 2, poolLeft: 1, poolFree: 0 } });
  st.grab("s"); st.at(0); st.t = S0 + 2000;
  assert.ok(M.step(st.S, st.input(), st.C, st.t).actions.some((a) => a.a === "still" && a.evict === true), "a still is an open cam in Pepe's pool too");
  // Pepe hadn't freed the evicted slot yet: one retry in 2 s
  w.S.evictAt = w.t;
  M.holdDone(w.S, "x", false, "slots_busy", w.C, w.t + 500);
  assert.deepEqual(vw(w, "x"), ["card", "full"]);
  assert.equal(w.S.soft.has("x"), false, "never a soft failure");
  assert.equal(w.S.liveBlock.has("x"), false, "no liveBlock");
  assert.equal(w.S.backoff.has("x"), false, "no backoff");
  w.t = S0 + 3500;
  acts = M.step(w.S, w.input(), w.C, w.t).actions;
  assert.ok(!acts.some((a) => a.a === "hold"), "not before retryAt");
  w.t = S0 + 4600;
  acts = M.step(w.S, w.input(), w.C, w.t).actions;
  assert.ok(acts.some((a) => a.a === "hold" && a.login === "x"), "tried again after 2 s");
  M.holdDone(w.S, "x", false, "slots_busy", w.C, w.t + 100);
  assert.ok((w.S.liveBlock.get("x") || 0) > w.t, "the second refusal: the normal 'full' path");
  // a slots_busy long after any eviction: the normal path at once
  const late = warmWorld({ site: { coldLeft: 1 } });
  late.grab("y"); late.at(0); late.t = S0 + 2000;
  M.step(late.S, late.input(), late.C, late.t);
  late.S.evictAt = late.t - 6000;
  M.holdDone(late.S, "y", false, "slots_busy", late.C, late.t);
  assert.ok((late.S.liveBlock.get("y") || 0) > late.t);
  // ... and through livecam's end hook (Pepe refused the open)
  const se = warmWorld({ site: { coldLeft: 1 } });
  se.grab("z"); se.at(0); se.t = S0 + 2000;
  M.step(se.S, se.input(), se.C, se.t);
  M.holdDone(se.S, "z", true, null, se.C, se.t);
  se.S.evictAt = se.t;
  M.sessionEnded(se.S, "z", "slots_busy", se.C, se.t + 800);
  assert.deepEqual(vw(se, "z"), ["card", "full"]);
  assert.equal(se.S.liveBlock.has("z"), false);
  assert.ok(se.S.tiles[0].retryAt > se.t);
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.4): cover tiles ──
/** world() + veiled holders shown as covers (I.covers: [{key, since}]); the `covers` switch on (its default is off). */
function coverWorld(opts = {}) {
  const w = world(Object.assign({}, opts, { C: Object.assign({ covers: true }, opts.C || {}) }));
  w.veiled = [];
  const input0 = w.input;
  // (like micfollow.stepPad: a cover's key never gets an elig / sess entry - unless a test forces one in, w.forceElig)
  w.input = () => {
    const I = Object.assign(input0(), { covers: w.veiled.map((k) => ({ key: k })) });
    for (const k of [...I.elig.keys()]) if (M.isCoverKey(k) && !(w.forceElig && w.forceElig.has(k))) { I.elig.delete(k); I.sess.delete(k); }
    if (w.forceElig) for (const [k, e] of w.forceElig) I.elig.set(k, e);
    return I;
  };
  w.veil = (k) => { if (!w.veiled.includes(k)) w.veiled.push(k); };
  w.unveil = (k) => { w.veiled = w.veiled.filter((x) => x !== k); };
  return w;
}
const CV1 = M.COVER_PREFIX + "ranon-0a1b2c3d", CV2 = M.COVER_PREFIX + "ranon-11223344";

test("48. wave2 F.4 covers: a veiled holder held >= min_hold_s becomes a cover tile - never asked eligOf, never held, stilled, kept or spanned; released after the hand-over; a stage of only covers never becomes the default", () => {
  assert.ok(!/^[\w.\-]{1,40}$/.test(CV1), "a cover key can never match a login");
  assert.equal(M.isCoverKey(CV1), true); assert.equal(M.isCoverKey("alice"), false);
  const w = coverWorld({ C: { warm_keep_s: 180 } });
  w.veil(CV1); w.at(0); w.at(1);
  assert.deepEqual(w.logins(), [], "not before min_hold_s");
  w.at(2);
  assert.deepEqual(w.logins(), [CV1]);
  const x = w.S.tiles[0];
  assert.deepEqual([x.cover, x.video, x.why], [true, "cover", null]);
  for (const a of ["hold", "still", "span_open", "span_close", "release", "keep", "notice_first"]) assert.equal(count(w.actions, a), 0, a);
  assert.equal(w.S.active, false, "no picture: never the default view (DF-15)");
  assert.equal(M.newest(w.S), x, "the newest speaker - the mic ring");
  assert.equal(M.speaking(w.S, w.input(), w.C, w.t), null, "attributed: no 'Someone is speaking' dimming for a cover");
  // it needs no elig / sess entry, and even a CUT code forced in for its key changes nothing (no consent question)
  w.forceElig = new Map([[CV1, "hidden"]]); w.at(3);
  assert.deepEqual(w.logins(), [CV1], "never cut");
  assert.equal(w.S.tiles[0].video, "cover", "never pictured");
  w.forceElig = null;
  // they let go: the hand-over / idle hold like any tile, then off - no span, no relay to let go
  w.unveil(CV1); w.actions = [];
  for (let s = 4; s <= 40; s++) w.at(s);
  assert.deepEqual(w.logins(), []);
  for (const a of ["span_close", "release", "keep", "still_stop"]) assert.equal(count(w.actions, a), 0, a);
  // a key without the cover prefix is ignored
  const z = coverWorld(); z.veil("alice"); z.at(0); z.at(3);
  assert.deepEqual(z.logins(), []);
});

test("49. wave2 F.4 covers count toward max_people and displace like tiles; newest / keep_recent / regrab apply; speech nobody can show still dims the stage", () => {
  const w = coverWorld({ pad: { max_people: 2, keep_recent: 1 } });
  w.grab("a"); w.at(0); w.at(2);
  w.grab("b"); w.at(8); w.at(10);
  assert.deepEqual(w.logins().sort(), ["a", "b"]);
  w.drop("a"); w.at(12);                                     // a lets go (recent: keep_recent 1 minute)
  w.veil(CV1); w.at(20); w.at(22);
  assert.ok(w.logins().includes(CV1), "the cover displaced the one off the mic longest");
  assert.ok(!w.logins().includes("a"));
  assert.equal(M.newest(w.S).login, CV1, "the newest speaker");
  // a re-grab of the same cover within regrab_merge_s is the same hold (same since)
  const since = w.S.seen.get(CV1).since;
  w.unveil(CV1); w.at(23); w.veil(CV1); w.at(25);
  assert.equal(w.S.seen.get(CV1).since, since);
  // keep_recent: a cover that let go stays up as recent until the time passes (like any tile)
  w.unveil(CV1); w.at(30);
  assert.ok(w.logins().includes(CV1));
  assert.ok(w.S.tiles.find((x) => x.login === CV1).relAt != null, "recent");
  for (let s = 31; s <= 100; s++) w.at(s);
  assert.ok(!w.logins().includes(CV1), "gone after keep_recent");
  // an unprovable anonymous holder (an `others` entry) with only covers up: still "someone"? no - a cover holder is attributed
  const s = coverWorld();
  s.veil(CV2); s.at(0); s.at(2);
  const I = Object.assign(s.input(), { others: [{ key: "anon:x", since: s.t - 10000 }] });
  assert.equal(M.speaking(s.S, I, s.C, s.t), null, "a cover holding the mic is attributed");
  s.unveil(CV2); s.at(3);
  const I2 = Object.assign(s.input(), { others: [{ key: "anon:x", since: s.t - 10000 }] });
  M.step(s.S, I2, s.C, s.t + 1000);
  assert.equal(M.speaking(s.S, I2, s.C, s.t + 1000), "someone", "once the cover let go, the unprovable holder dims the stage as today");
});

// ── wave2 WP-4 review fixes ──
test("50. wave2 review (B-relays-4): while Pepe sheds (his cams full for a ▶ Live / a cam slot) a LIVE tile leaving lets its relay go - never kept - and a relay kept already ends ('shed')", () => {
  const w = warmWorld();
  onLive(w, "a");
  w.site.shed = true;
  w.drop("a"); w.actions = [];
  w.run(4, 30);
  assert.deepEqual(w.logins(), []);
  assert.equal(count(w.actions, "keep"), 0, "not kept during a shed (▶ Live wins over the mic stage)");
  assert.equal(count(w.actions, "release"), 1, "let go: the cam is Pepe's for ▶ Live");
  assert.equal(w.S.kept.size, 0);
  const k = warmWorld(); kept(k, "a", 0); k.at(1);
  assert.ok(k.S.kept.has("a"));
  k.site.shed = true; k.actions = []; k.at(2);
  const d = k.actions.find((a) => a.a === "keep_drop" && a.login === "a");
  assert.ok(d && d.why === "shed", JSON.stringify(k.actions));
  assert.equal(k.S.kept.size, 0);
});

test("51. wave2 review (B-relays-5): a lowered warm_keep_s applies to relays kept already - one kept longer than the new value ends at the next step, the others' until moves in", () => {
  const w = warmWorld();
  kept(w, "a", 0); kept(w, "b", 50);                          // kept until 180 / 230 under warm_keep_s 180
  w.at(60);
  assert.equal(w.S.kept.size, 2);
  w.C.warm_keep_s = 60; w.actions = [];
  w.at(61);
  assert.deepEqual(w.actions.filter((a) => a.a === "keep_drop").map((a) => [a.login, a.why]), [["a", "expired"]], "a left 61 s ago: over the new 60 s");
  assert.equal(w.S.kept.get("b").until, S0 + 110 * 1000, "b: left at 50 + 60 (the admin list's 'Ns left' follows)");
  w.actions = []; w.at(109);
  assert.ok(w.S.kept.has("b"));
  w.at(110);
  assert.ok(w.actions.some((a) => a.a === "keep_drop" && a.login === "b" && a.why === "expired"));
});

test("52. wave2 review (B-privacy-ux-4): the covers switch off (its kill switch) takes every cover tile off at once - no hand-over, no keep_recent - and puts none up while off", () => {
  const w = coverWorld({ pad: { keep_recent: 5 } });
  w.grab("a"); w.at(0); w.at(2);
  w.veil(CV1); w.at(10); w.at(12);
  assert.deepEqual(w.logins().sort(), [CV1, "a"].sort());
  // switched off: micfollow.js sends no covers (the person is an `others` entry again) - the cover goes in this step
  w.C.covers = false; w.unveil(CV1); w.actions = [];
  w.at(13);
  assert.deepEqual(w.logins(), ["a"], "off at once (keep_recent 5 would have kept it up ~5 minutes)");
  assert.ok(w.actions.some((a) => a.a === "touch" && a.why === "covers_off"));
  for (const a of ["span_close", "release", "keep", "still_stop"]) assert.equal(count(w.actions, a), 0, a);
  // still off: a cover key handed in anyway is ignored (no tile, not attributed)
  w.veil(CV2); w.at(20); w.at(25);
  assert.ok(!w.S.tiles.some((x) => x.cover), "none goes up while off");
  // on again: covers as before
  w.C.covers = true; w.at(30); w.at(33);
  assert.ok(w.logins().includes(CV2));
  // ... and under the stale hold too (Pepe's sync late: the program is held, but the kill switch applies like a cut)
  w.why_off = "stale"; w.C.covers = false; w.actions = [];
  w.at(34);
  assert.deepEqual(w.logins(), ["a"], "off under the stale hold");
});

// ── 1.99?? STABLE SLOTS (owner 2026-11-02: "It doesn't need to move speaker slots unless a new speaker is coming in") ──
test("53. 1.99?? stable slots - arrange: everyone keeps their place; a newcomer takes the place of whom they pushed off, else the first empty one, else the end; leaving leaves an empty place until there are more places than cells (or dense) - then they close up in order", () => {
  assert.equal(typeof M.arrange, "function");
  // nothing yet: today's order
  assert.deepEqual(M.arrange(null, ["a", "b"], { cells: 2 }), ["a", "b"]);
  // the same people in another order (today's would move them): nobody moves
  assert.deepEqual(M.arrange(["a", "b"], ["b", "a"], { cells: 2 }), ["a", "b"]);
  // a third: a new place at the end; a fourth with an empty place: that one
  assert.deepEqual(M.arrange(["a", "b"], ["a", "b", "c"], { cells: 4 }), ["a", "b", "c"]);
  assert.deepEqual(M.arrange(["a", null, "c", "d"], ["a", "c", "d", "e"], { cells: 4 }), ["a", "e", "c", "d"]);
  // someone leaving: an empty place - nobody shuffles (grid4 keeps its 4 cells with 3 on it)
  assert.deepEqual(M.arrange(["a", "b", "c", "d"], ["a", "c", "d"], { cells: 4 }), ["a", null, "c", "d"]);
  // ... the last place: nothing left behind it
  assert.deepEqual(M.arrange(["a", "b", "c"], ["a", "b"], { cells: 2 }), ["a", "b"]);
  // the layout has fewer cells than places (3 left of 4 -> grid4 still; 2 -> split): close up, in order
  assert.deepEqual(M.arrange(["a", null, "c", "d"], ["c", "d"], { cells: 2 }), ["c", "d"]);
  assert.deepEqual(M.arrange(["a", null, "c"], ["a", "c"], { cells: 2 }), ["a", "c"]);
  assert.deepEqual(M.arrange(["a", "b", "c", "d", "e"], ["a", "c", "e"], { cells: 4 }), ["a", "c", "e"], "5 places > 4 cells: closed up");
  // dense (the dynamic templates: no empty cells): always closed up, in order
  assert.deepEqual(M.arrange(["a", "b", "c", "d"], ["a", "c", "d"], { cells: 9, dense: true }), ["a", "c", "d"]);
  // displacement: the newcomer takes exactly the place of whom they pushed off - even with an empty place before it
  const hint = (m) => (k) => m[k] || null;
  assert.deepEqual(M.arrange(["a", null, "c", "d"], ["a", "c", "e"], { cells: 4, hint: hint({ e: "d" }) }), ["a", null, "c", "e"]);
  assert.deepEqual(M.arrange(["a", "b"], ["b", "c"], { cells: 2, hint: hint({ c: "a" }) }), ["c", "b"]);
  // two newcomers, one with a hint: the hinted place is theirs, the other takes the first empty one
  assert.deepEqual(M.arrange(["a", "b", "c", "d"], ["b", "x", "y", "d"], { cells: 4, hint: hint({ y: "a" }) }), ["y", "b", "x", "d"]);
  // a hint to someone who didn't leave (or no one): the first empty place / the end
  assert.deepEqual(M.arrange(["a", "b"], ["a", "b", "c"], { cells: 4, hint: hint({ c: "a" }) }), ["a", "b", "c"]);
  // never mutates prev; duplicates are one entry
  const prev = Object.freeze(["a", "b"]);
  assert.deepEqual(M.arrange(prev, ["a", "a", "b", "c"], { cells: 4 }), ["a", "b", "c"]);
  assert.deepEqual(M.arrange(["a", "a"], ["a"], { cells: 2 }), ["a"]);
  assert.deepEqual(M.arrange(["a"], [], { cells: 1 }), []);
  assert.deepEqual(M.SHAPE_CELLS, { single: 1, split: 2, pip: 2, grid4: 4, grid9: 9 });
});

test("54. 1.99?? stable slots - arrange's main cell (place 0): the pick trades places with whoever is there (nobody else moves); an empty place 0 (the main left) is just taken, then the places close up", () => {
  const pick = (m) => () => m;
  // c becomes the main: a (place 0) takes c's old place; b and d never move
  assert.deepEqual(M.arrange(["a", "b", "c", "d"], ["a", "b", "c", "d"], { cells: 4, dense: true, pick: pick("c") }), ["c", "b", "a", "d"]);
  // the main already there / none: nothing moves
  assert.deepEqual(M.arrange(["c", "b", "a"], ["a", "b", "c"], { dense: true, pick: pick("c") }), ["c", "b", "a"]);
  assert.deepEqual(M.arrange(["c", "b", "a"], ["a", "b", "c"], { dense: true, pick: pick(null) }), ["c", "b", "a"]);
  assert.deepEqual(M.arrange(["c", "b", "a"], ["a", "b", "c"], { dense: true, pick: pick("zz") }), ["c", "b", "a"], "an unknown main moves nobody");
  // a newcomer who is the main: they come in at their place (here the end), then trade with place 0
  assert.deepEqual(M.arrange(["a", "b", "c"], ["a", "b", "c", "n"], { dense: true, pick: pick("n") }), ["n", "b", "c", "a"]);
  // ... at the place of whom they pushed off
  assert.deepEqual(M.arrange(["m", "b", "c", "d"], ["m", "c", "d", "n"], { dense: true, hint: (k) => (k === "n" ? "b" : null), pick: pick("n") }), ["n", "m", "c", "d"]);
  // the main left: the new main takes the empty place 0, the rest close up in order (b, c keep their order)
  assert.deepEqual(M.arrange(["m", "b", "c", "d"], ["b", "c", "d"], { dense: true, pick: pick("d") }), ["d", "b", "c"]);
  // the pick sees who is on, in place order
  let seen = null;
  M.arrange(["m", null, "c", "d"], ["m", "c", "d"], { cells: 4, pick: (ids) => { seen = ids; return null; } });
  assert.deepEqual(seen, ["m", "c", "d"]);
});

test("55. 1.99?? stable slots - the engine: a newcomer who displaced a tile carries slotOf (whose place it takes); the engine's own pos is today's order; the knob stable_slots is on by default - on staging and on prod", () => {
  const w = world({ pad: { layout: "split", keep_recent: 2 } });
  w.grab("a"); w.at(0); w.at(2);
  w.drop("a"); w.grab("b"); w.at(15); w.at(17);
  w.drop("b"); w.grab("a"); w.at(30); w.at(33);
  w.drop("a"); w.at(40);
  w.grab("c"); w.at(50); w.at(53);
  const c = w.S.tiles.find((x) => x.login === "c");
  assert.equal(c.slotOf, "b", "c pushed b off (off the mic longest)");
  assert.equal(w.S.tiles.find((x) => x.login === "a").slotOf, undefined, "a pushed nobody off");
  assert.deepEqual(w.S.tiles.map((x) => [x.login, x.pos]), [["a", 0], ["c", 1]], "the engine's pos: today's order (by when they came on)");
  assert.equal(M.DEFAULTS.stable_slots, true);
  assert.equal(M.normalize({}).cfg.stable_slots, true);
  assert.equal(M.normalize({ stable_slots: "off" }).cfg.stable_slots, false);
  // a STAGING process reads the same default
  const p = path.join(path.resolve(__dirname, ".."), "micfollow-core.js");
  const was = process.env.STAGING;
  delete require.cache[require.resolve(p)];
  process.env.STAGING = "1";
  try { assert.equal(require(p).DEFAULTS.stable_slots, true, "staging: on"); assert.equal(require(p).DEFAULTS.dynamic, true, "(a STAGING read indeed)"); }
  finally { if (was == null) delete process.env.STAGING; else process.env.STAGING = was; delete require.cache[require.resolve(p)]; }
  assert.equal(M.newState().slots, null, "not arranged yet");
});

test("56. 1.99?? stable slots - covers (hooded frogs): a place never passes between a cover and a named person - a cover goes after the last one on (never an empty place, never the place of whom it pushed off), a named newcomer never takes a cover's place by the hint, and the empty places close up before anyone new sits down after a cover left", () => {
  const veiled = (k) => String(k).startsWith("~cv:");
  // bob (named, place 1) is cut by !bridge hide and his cover comes up: NOT in his place - after the last one on
  assert.deepEqual(M.arrange(["a", "bob", "c"], ["a", "c", "~cv:1"], { cells: 4, veiled }), ["a", null, "c", "~cv:1"]);
  // ... nor in the place of whom it pushed off
  assert.deepEqual(M.arrange(["a", "b", "c", "d"], ["a", "c", "d", "~cv:1"], { cells: 4, veiled, hint: (k) => (k === "~cv:1" ? "b" : null) }), ["a", "c", "d", "~cv:1"]);
  // the cover (place 1) leaves and its person comes back named: the places close up first - the named one never sits in the frog's place
  assert.deepEqual(M.arrange(["a", "~cv:1", "c"], ["a", "c", "gus"], { cells: 4, veiled }), ["a", "c", "gus"]);
  // (review fix B3: with nobody new, the frog's place stays an empty cell - c keeps its place; test 57)
  assert.deepEqual(M.arrange(["a", "~cv:1", "c"], ["a", "c"], { cells: 4, veiled }), ["a", M.VEILED_GAP, "c"], "nobody new: nobody shuffles");
  // ... nor by the hint (a named newcomer pushing the cover off)
  assert.deepEqual(M.arrange(["a", "~cv:1", "c", "d"], ["a", "c", "d", "gus"], { cells: 4, veiled, hint: (k) => (k === "gus" ? "~cv:1" : null) }), ["a", "c", "d", "gus"]);
  // named people among themselves keep the plain rules; a cover that stays keeps its place like anyone
  assert.deepEqual(M.arrange(["~cv:1", "b", "c"], ["~cv:1", "c", "x"], { cells: 4, veiled }), ["~cv:1", "x", "c"]);
  // a cover may take the main cell (the active speaker) - trading with whoever is there, like anyone
  assert.deepEqual(M.arrange(["a", "b", "c"], ["a", "b", "c", "~cv:2"], { dense: true, veiled, pick: () => "~cv:2" }), ["~cv:2", "b", "c", "a"]);
});

test("57. 1.99?? stable slots, review fix B3 - a cover leaving shuffles nobody: its place stays an empty cell nobody sits down in (VEILED_GAP) until someone new comes on - then every empty place closes up first (the privacy rule kept); a smaller layout / dense closes it like any", () => {
  const veiled = (k) => String(k).startsWith("~cv:"), G = M.VEILED_GAP;
  assert.equal(typeof G, "string");
  assert.ok(!veiled(G) && G.includes("\u0000"), "never a login or a cover key");
  // the review's cover-handoff (grid4, 3 named + a frog): the frog leaves - dana stays in place 3 (it used to slide to 2)
  const one = M.arrange(["alice", "carl", "~cv:1", "dana"], ["alice", "carl", "dana"], { cells: 4, veiled });
  assert.deepEqual(one, ["alice", "carl", G, "dana"]);
  // ... and stays there step after step while the set doesn't change
  assert.deepEqual(M.arrange(one, ["alice", "carl", "dana"], { cells: 4, veiled }), ["alice", "carl", G, "dana"]);
  assert.deepEqual(M.arrange(one, ["dana", "carl", "alice"], { cells: 4, veiled }), ["alice", "carl", G, "dana"], "today's order of the keys moves nobody");
  // someone new (gus - maybe the frog's person, named again): the empty places close up first, he goes after the last one on -
  // never in the frog's place
  assert.deepEqual(M.arrange(one, ["alice", "carl", "dana", "gus"], { cells: 4, veiled }), ["alice", "carl", "dana", "gus"]);
  // ... nor by a hint (whom he pushed off - even a named one leaving at the same time: no place is handed on)
  assert.deepEqual(M.arrange(one, ["alice", "dana", "gus"], { cells: 4, veiled, hint: (k) => (k === "gus" ? "carl" : null) }), ["alice", "dana", "gus"]);
  // a named person leaving beside the frog's place: an empty cell too; the next newcomer closes both up first
  const two = M.arrange(one, ["alice", "dana"], { cells: 4, veiled });
  assert.deepEqual(two, ["alice", null, G, "dana"]);
  assert.deepEqual(M.arrange(two, ["alice", "dana", "erin"], { cells: 4, veiled }), ["alice", "dana", "erin"], "erin never in place 1 or 2");
  // a new cover: the same (after the last one on, the places closed up)
  assert.deepEqual(M.arrange(one, ["alice", "carl", "dana", "~cv:2"], { cells: 4, veiled }), ["alice", "carl", "dana", "~cv:2"]);
  // the frog's place at the end: nothing left behind it (as before)
  assert.deepEqual(M.arrange(["a", "b", "~cv:1"], ["a", "b"], { cells: 4, veiled }), ["a", "b"]);
  // fewer cells than places / dense (the dynamic templates): closed up like any empty place
  assert.deepEqual(M.arrange(["a", "~cv:1", "c"], ["a", "c"], { cells: 2, veiled }), ["a", "c"]);
  assert.deepEqual(M.arrange(["a", "~cv:1", "c"], ["a", "c"], { dense: true, veiled }), ["a", "c"]);
  assert.deepEqual(M.arrange(["a", G, "c"], ["a", "c"], { cells: 2, veiled }), ["a", "c"]);
  // the pick never sees the frog's place, and the main taking place 0 just moves it (then it is dropped at the end)
  let seen = null;
  M.arrange(["a", G, "c"], ["a", "c"], { cells: 4, veiled, pick: (ids) => { seen = ids; return null; } });
  assert.deepEqual(seen, ["a", "c"]);
  assert.deepEqual(M.arrange([G, "a"], ["a"], { cells: 2, veiled, pick: () => "a" }), ["a"]);
  // a stray VEILED_GAP among the keys is nobody
  assert.deepEqual(M.arrange(["a", G, "c"], ["a", G, "c"], { cells: 4, veiled }), ["a", G, "c"]);
});
