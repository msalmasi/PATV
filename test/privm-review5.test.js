// 1.99aid (privacy controls, review 5 - the independent review of round 4 and S3; G:/ops/privacy-controls-spec-2026-11-02.md section 5
// "S3"). The pure mic-stage engine (micfollow-core.js) on a fake clock, and the English locale file:
//   opted_out   with micfollow_cfg withheld_cover on, a hold / relay of a mic holder that Pepe refuses "opted_out" (his own opt-out list
//               can be ahead of the site's: a room line's !livecam off, a sync on its way) is the withheld card - and stays it: no new
//               hold every step (the site's rules still say ok), one more try per consent cooldown (cooldown_s), the cadence a CUT gave
//               with the switch off; never a still meanwhile
//   still       ... a still of theirs goes at once (still_stop), as the cut took it with the switch off
//   off         the switch off: a CUT and its cooldown, exactly as before
//   en.json     no staging line rewritten by the S3 commit (mf.notice.once_title keeps its "key": "value" spacing)
//   node --test test/privm-review5.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
delete process.env.STAGING;
const repo = path.resolve(__dirname, "..");
const M = require(path.join(repo, "micfollow-core"));

const PAD = { layout: "auto", max_people: 4, max_live: 4, default_view: "first" };
const S0 = 1_000_000_000_000;
const NONE = { state: "none", held: false, exact: null, viewers: 0 };

/** One mic holder "a" the site's rules call `elig` (default ok); `site` = what's left site-wide. */
function world({ wc = true, site = {}, elig = "ok" } = {}) {
  const w = { S: M.newState(), C: { ...M.DEFAULTS, cold_open: true, enabled: true, withheld_cover: wc }, t: S0, sess: NONE, elig };
  w.input = () => ({ why_off: null, holders: [{ login: "a", since: S0 }], unproven_n: 0, elig: new Map([["a", w.elig]]),
                     sess: new Map([["a", w.sess]]), pad: PAD, room: { cams: true, listAt: null, listFresh: null },
                     site: { maxLive: 4, coldLeft: 9, stillsLeft: 4, ...site } });
  w.at = (s) => { w.t = S0 + s * 1000; return M.step(w.S, w.input(), w.C, w.t).actions; };
  w.tile = () => w.S.tiles.find((x) => x.login === "a") || null;
  return w;
}

test("S3 review 5: a hold Pepe refuses opted_out (his list ahead of the site's) stays the withheld card - one try per cooldown, never a hold every step", () => {
  for (const how of ["hold", "relay"]) {
    const w = world();
    const holds = [], stills = [];
    for (let s = 0; s <= 60; s++) {
      for (const a of w.at(s)) {
        if (a.a === "still") stills.push(s);
        if (a.a !== "hold") continue;
        holds.push(s);
        // Pepe refuses it: livecam's stage hold says opted_out (holdDone), or the relay it asked for ends opted_out (sessionEnded)
        if (how === "hold") M.holdDone(w.S, "a", false, "opted_out", w.C, w.t);
        else { M.holdDone(w.S, "a", true, null, w.C, w.t); M.sessionEnded(w.S, "a", "opted_out", w.C, w.t); }
        const x = w.tile();
        assert.deepEqual(x && [x.video, x.why], ["card", "withheld"], how + ": the named withheld card, never a cut");
      }
    }
    // the cut's cooldown (cooldown_s = 20 s) is the cadence the switch off had: 2, 22, 42 - not 59 holds a minute
    assert.deepEqual(holds, [2, 22, 42], how + ": one try per cooldown, not every step: " + holds.join(","));
    assert.deepEqual(stills, [], how + ": never a still of it meanwhile");
    const x = w.tile();
    assert.deepEqual([x.video, x.why], ["card", "withheld"], how + ": still the card");
    // speaking(): the person is attributed (a named card), never "Someone is speaking"
    assert.equal(w.S.speaking, null, how + ": attributed");
  }
});

test("S3 review 5: once the site's own rules say withheld (they caught up), live cam on again brings the cam back at once - no wait", () => {
  const w = world();
  w.at(0);
  assert.ok(w.at(2).some((a) => a.a === "hold"));
  M.holdDone(w.S, "a", true, null, w.C, w.t);
  M.sessionEnded(w.S, "a", "opted_out", w.C, w.t);           // !livecam off: the relay ends
  w.elig = "withheld"; w.at(3);                                // the site knows it too
  assert.deepEqual([w.tile().video, w.tile().why], ["card", "withheld"]);
  w.elig = "ok";                                               // !livecam on
  assert.ok(w.at(4).some((a) => a.a === "hold"), "the cam is asked for again at once");
});

test("S3 review 5: a still of someone whose relay ends opted_out goes at once (still_stop) - the withheld card, never the old frame", () => {
  const w = world({ site: { coldLeft: 0 } });                    // no cold open: the newest tile gets a still
  w.at(0); w.at(2); w.at(3);
  assert.equal(w.tile().video, "still", "a still to begin with");
  const r = M.sessionEnded(w.S, "a", "opted_out", w.C, w.t);    // a ▶ Live relay of theirs ended: Pepe says opted_out
  assert.deepEqual(r.actions.filter((a) => a.a === "still_stop").map((a) => a.login), ["a"], "the still stops now");
  assert.deepEqual([w.tile().video, w.tile().why], ["card", "withheld"]);
  assert.equal(r.cut, null, "never a cut with the switch on");
  for (let s = 4; s <= 20; s++) {
    const acts = w.at(s);
    assert.equal(acts.some((a) => a.a === "still" || a.a === "hold"), false, "no new still or hold before the cooldown - " + s);
  }
});

test("S3 review 5: the switch off - an opted_out refusal is a CUT with its cooldown, exactly as before (no withheld card, no whUntil)", () => {
  const w = world({ wc: false });
  const holds = [];
  for (let s = 0; s <= 60; s++) {
    for (const a of w.at(s)) {
      if (a.a !== "hold") continue;
      holds.push(s);
      M.holdDone(w.S, "a", true, null, w.C, w.t);
      const r = M.sessionEnded(w.S, "a", "opted_out", w.C, w.t);
      assert.equal(r.cut, "opted_out");
      assert.equal(w.tile(), null, "cut");
    }
  }
  assert.deepEqual(holds, [2, 22, 42]);
  // and a refusal the switch-on engine saw before the switch went off holds no card: the site's rules decide at once
  const v = world();
  v.at(0); const acts = v.at(2);
  assert.ok(acts.some((a) => a.a === "hold"));
  M.holdDone(v.S, "a", false, "opted_out", v.C, v.t);
  assert.equal(v.tile().why, "withheld");
  v.C = { ...v.C, withheld_cover: false };
  assert.ok(v.at(3).some((a) => a.a === "hold"), "switched off: ok means a hold again (and Pepe's opted_out then cuts)");
});

test("S3 review 5: en.json - the S3 commit rewrites no staging line (every entry keeps the \"key\": \"value\" spacing)", () => {
  const lines = fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8").split(/\r?\n/);
  const bad = lines.filter((l) => /^ {2}"[^"]+":(?! )/.test(l));
  assert.deepEqual(bad.map((l) => l.slice(0, 40)), [], "entries without the space after the colon");
  assert.ok(lines.includes('  "mf.notice.once_title": "🎙 Pads on PATV may show your cam while you hold the mic",'), "once_title as staging has it");
});
