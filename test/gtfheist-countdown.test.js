// train2 17 review fix (R3): /gtf/heist's countdown (views/gtfHeist.ejs nextTick) shows while the heist's last SCENE event is
// Pepe's "timer". Midnight Break's settlement / item_use observations ride along mid-countdown (a !bail's settlement lands
// ~4 s before its window closes); they used to hide the countdown early. Runs the page's own script in a tiny fake DOM.
//   node --test test/gtfheist-countdown.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const view = path.join(__dirname, "..", "views", "gtfHeist.ejs");

function el() {
  return { hidden: false, textContent: "", innerHTML: "", style: {}, classList: { toggle() {}, add() {}, remove() {} },
           appendChild() {}, setAttribute() {} };
}

async function countdown(events) {
  const now = Date.now();
  const first = { ok: true, now, at: now, last: events.length,
    heist: { session: "mb1", ended: null, lines: [],
             summary: { session: "mb1", phase: "running", job: "casino", scenario: "Casino Job", emoji: "🎰", rounds: 9, round: 2,
                        room: "PepeLab", crew: [] } },
    events: events.map((data, i) => ({ id: i + 1, event: "heist", data })) };
  const html = await ejs.renderFile(view, { user: null, first });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.find((s) => s.includes("function nextTick"));
  assert.ok(src, "the page's countdown script");
  const els = {};
  const document = {
    documentElement: { lang: "en" }, head: { appendChild() {} }, hidden: false,
    getElementById: (id) => (els[id] = els[id] || el()), createElement: () => el(), addEventListener() {},
  };
  const ctx = { document, window: {}, setInterval() {}, fetch: () => new Promise(() => {}), console };
  vm.runInNewContext(src, ctx);
  return els.hlNext;
}

const timer = (secs) => ({ action: "timer", kind: "bail", label: "Round 3 in", secs, until: Date.now() + secs * 1000 });
const settlement = { action: "settlement", round: 2, reason: "bail", players: [], totals: { carrying: 0, banked: 0, lost: 0 } };
const cue = { action: "item_use", id: "r2-1", item: "ghost_plates", round: 2, owner: { name: "someone 1", seed: 0 },
              target: { name: "someone 1", seed: 0 }, outcome: "activated", scope: "self", trigger: "bail" };

test("a bail's settlement or an item cue after the timer keeps the countdown up", async () => {
  for (const extra of [[settlement], [cue], [settlement, cue]]) {
    const next = await countdown([{ action: "round", round: 2 }, { action: "rolls", rolls: [] }, timer(12), ...extra]);
    assert.equal(next.hidden, false, "countdown hidden by " + extra.map((e) => e.action).join("+"));
    assert.match(next.textContent, /Round 3 in/);
  }
});

test("the countdown still shows on its own and still ends with the next scene", async () => {
  const alone = await countdown([{ action: "round", round: 2 }, timer(12)]);
  assert.equal(alone.hidden, false);
  assert.match(alone.textContent, /Round 3 in/);
  const ended = await countdown([{ action: "round", round: 2 }, timer(12), settlement, { action: "round", round: 3 }]);
  assert.equal(ended.hidden, true, "the next round ends the countdown");
  const none = await countdown([{ action: "round", round: 2 }, settlement]);
  assert.equal(none.hidden, true, "no timer: no countdown");
});
