// Replays test/fixtures/casino-hm-vectors.json.gz (recorded from Pepe's poker_engine.py) on casino/hmengine.js.
// Used by test/casino-hm.test.js; `node test/casino-hm-parity.js` prints the first mismatch.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const assert = require("node:assert/strict");
const H = require(path.join(__dirname, "..", "casino", "hmengine"));

function snap(t) {
  const chips = {};
  for (const k of t.seats) chips[k] = t.chips[k];
  return { chips, seats: t.seats.slice(), button: t.button };
}

function replay() {
  const vectors = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "casino-hm-vectors.json.gz"))).toString("utf8"));
  const stats = { vectors: vectors.length, ops: 0, errors: 0, showdowns: 0, sidepots: 0, rake: 0 };
  vectors.forEach((v, vi) => {
    const t = H.newTable({ sb: v.sb, bb: v.bb, rake: v.rake });
    v.ops.forEach((o, oi) => {
      const where = `vector ${vi} op ${oi} (${o.op})`;
      stats.ops++;
      if (o.op === "sit") return H.sit(t, o.key, o.name, o.chips);
      if (o.op === "stand") {
        assert.equal(H.stand(t, o.key), o.got, where);
        return assert.deepEqual(snap(t), o.after, where);
      }
      let ev;
      if (o.op === "start") ev = H.startHand(t, o.deck);
      else {
        try {
          ev = H.act(t, o.key, o.action, o.amount);
        } catch (e) {
          if (!(e instanceof H.PokerError)) throw e;
          assert.equal(e.message, o.error, where + ": error text");
          stats.errors++;
          return;
        }
        assert.ok(!o.error, where + ": expected the error " + o.error);
      }
      assert.deepEqual(ev, o.events, where + ": events");
      assert.deepEqual(snap(t), o.after, where + ": stacks");
      for (const e of ev) {
        if (e.t === "showdown") stats.showdowns++;
        if (e.t === "awards") { if (e.awards.some((a) => a.pot !== "main pot")) stats.sidepots++; stats.rake += e.rake; }
      }
    });
  });
  return stats;
}

module.exports = { replay };
if (require.main === module) console.log(replay());
