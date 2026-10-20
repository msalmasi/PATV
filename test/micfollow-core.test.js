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
              why_off: null, actions: [], cams: true };
  w.grab = (login, since) => { if (!w.holders.some((h) => h.login === login)) w.holders.push({ login, since: since == null ? undefined : since }); };
  w.drop = (login) => { w.holders = w.holders.filter((h) => h.login !== login); };
  w.input = () => {
    const logins = new Set([...w.holders.map((h) => h.login), ...w.S.tiles.map((x) => x.login)]);
    const elig = new Map(), sess = new Map();
    for (const l of logins) {
      elig.set(l, w.cuts.get(l) || (w.pending.has(l) ? "pending" : w.offcam.has(l) ? "off_cam" : "ok"));
      const st = w.live.get(l) || "none";
      // Pepe reports a live relay as exact (opened / verified by the exact name) unless the test says he can't (exactNo)
      sess.set(l, { state: st, held: w.held.has(l), exact: w.exactNo.has(l) ? false : st === "live" ? true : null, viewers: 0 });
    }
    // like micfollow.js: what's LEFT site-wide (this pad's current stills already count)
    const site = { ...w.site, stillsLeft: Math.max(0, w.site.stillsLeft - w.S.tiles.filter((x) => x.video === "still").length) };
    return { why_off: w.why_off, holders: w.holders.slice(), unproven_n: 0, elig, sess, pad: w.pad, room: { cams: w.cams }, site };
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
  assert.equal(w.S.tiles.filter((x) => x.video === "card" && x.why === "full").length, 1);
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
  const x = world({ site: { coldLeft: 0, stillsLeft: 0 } });
  x.grab("q"); x.live.set("q", "live"); x.exactNo.add("q"); x.at(0); x.at(2);
  assert.equal(x.S.tiles[0].video, "starting", "held for Pepe's exact check, never live");
  x.run(3, 46);
  assert.equal(x.S.tiles[0].video, "starting");
  const gaveUp = x.at(48);
  assert.ok(gaveUp.some((a) => a.a === "release" && a.login === "q"), "given up after the wait");
  assert.deepEqual([x.S.tiles[0].video, x.S.tiles[0].why], ["card", "failed"]);
  const n = x.actions.filter((a) => a.a === "hold").length;
  x.run(49, 120);
  assert.equal(x.actions.filter((a) => a.a === "hold").length, n, "no new hold during the backoff");
  assert.ok(!x.S.tiles[0].pictured, "never had a picture");
  // cold_open off: no stills either (a still opens the cam too)
  const y = world({ C: { cold_open: false }, site: { coldLeft: 0 } });
  y.grab("q"); y.at(0); y.at(2);
  assert.equal(y.S.tiles[0].video, "card");
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
  // a refused still -> card + backoff
  const s = world({ site: { coldLeft: 0, stillsLeft: 2 } }); s.grab("z"); s.at(0); s.at(2);
  assert.equal(s.S.tiles[0].video, "still");
  M.stillFailed(s.S, "z", s.C, s.t);
  assert.deepEqual([s.S.tiles[0].video, s.S.tiles[0].why], ["card", "failed"]);
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
  assert.deepEqual(p.cfg, { on: true, layout: "grid", default_view: "tab", max_people: 9, max_live: 2 });
  assert.ok(p.errors.max_people && p.errors.max_live);
  assert.equal(M.normalizePad({ layout: "huge" }).errors.layout, "one of auto, single, split, grid, pip");
  const c = M.normalize({ min_hold_s: "3", cold_open: "off", max_changes_per_min: 50 });
  assert.equal(c.cfg.min_hold_s, 3);
  assert.equal(c.cfg.cold_open, false);
  assert.equal(c.cfg.max_changes_per_min, 20);
  assert.ok(c.errors.max_changes_per_min);
  assert.equal(M.DEFAULTS.enabled, false, "ships dark on prod");
  assert.equal(M.DEFAULTS.cold_open, false);
  // a quiet voice-only room gets Pepe's snapshot only every 30 s (BRIDGE_SNAPSHOT_EVERY): fresh must cover that
  assert.ok(M.DEFAULTS.sync_fresh_s >= 45, "sync_fresh_s " + M.DEFAULTS.sync_fresh_s);
});

test("17. exact: a held relay that STOPS being exact comes off live at once (released, no live picture during the backoff)", () => {
  const w = world({ site: { coldLeft: 9, stillsLeft: 0 } });
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
  assert.equal(w.S.tiles.filter((x) => x.video === "card" && x.why === "full").length, 2);
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
  M.holdDone(w.S, "a", false, "start_timeout", w.C, w.t);
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
  const x = world({ site: { coldLeft: 0, stillsLeft: 0 } });
  x.grab("q"); x.live.set("q", "live"); x.exactNo.add("q"); x.at(0); x.at(2);
  x.run(3, 48);
  assert.equal(x.S.tiles[0].why, "failed");
  x.exactNo.delete("q");
  x.offcam.add("q"); x.at(50); x.offcam.delete("q");
  assert.ok(x.at(51).some((a) => a.a === "hold" && a.login === "q"), "inexact block over after off -> on");
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

test("29. speech nobody can show (DF-30): an unproven holder takes over -> the last speaker's tile gives way (no hand-over / idle hold), a neutral card", () => {
  const w = world();
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
  const v = world();
  v.t = S0; M.step(v.S, Object.assign(v.input(), { others: [{ key: "anon:someone", since: S0 - 60e3 }] }), v.C, v.t);
  assert.equal(v.S.neutral, null);
  // min on stage still applies: a tile added 3 s ago stays until min_on_stage_s
  const m = world();
  m.grab("a"); m.at(0); m.at(2); m.drop("a"); m.at(3);
  const mI = () => Object.assign(m.input(), { others: [{ key: "x:ghost", since: S0 }] });
  m.t = S0 + 5000; M.step(m.S, mI(), m.C, m.t);
  assert.deepEqual(m.logins(), ["a"], "min_on_stage_s (10 s) first");
  m.t = S0 + 12000; M.step(m.S, mI(), m.C, m.t);
  assert.deepEqual(m.logins(), [], "then it gives way");
  // a proven holder who can't be shown (opted out / not noticed yet) speaking is the same as an unproven one
  const p = world();
  p.grab("a"); p.at(0); p.at(2); p.drop("a"); p.at(12);
  p.cuts.set("b", "notice"); p.grab("b"); p.at(13); p.at(15.5);
  assert.deepEqual(p.logins(), [], "b isn't shown yet - a's face doesn't stay up while b talks");
  assert.equal(p.S.neutral, "someone");
});

test("30. Pepe alone on the mic (DF-12): tiles give way to Pepe's card; a person grabbing it back ends it", () => {
  const w = world();
  w.grab("a"); w.at(0); w.at(2); w.drop("a"); w.at(14);
  const I = (extra) => Object.assign(w.input(), { pepe: S0 + 15000 }, extra || {});
  const step = (sec, extra) => { w.t = S0 + sec * 1000; return M.step(w.S, I(extra), w.C, w.t).actions; };
  step(15); step(17.5);
  assert.deepEqual(w.logins(), []);
  assert.equal(w.S.neutral, "pepe");
  assert.equal(M.hot(w.S, w.t), true, "the 1 s timer keeps stepping it");
  w.grab("c"); step(30); step(33);
  assert.deepEqual(w.logins(), ["c"]);
  assert.equal(w.S.neutral, null, "a person on the stage: no card");
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
