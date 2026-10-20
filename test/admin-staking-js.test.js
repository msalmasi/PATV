// Staking fix plan (2026-10-19) - /admin/economy's 🏦 Staking card, the PAGE SCRIPT (public/js/admin-staking.js), run in a vm
// with a small fake DOM and a mocked fetch (the server side is capital/watch.js adminData; the card's markup is checked in
// test/staking-page.test.js):
//   * setting the weekly cap to 0 while this week isn't wholly time-weighted (cfg.pd_partial, Pepe's bucket rule) adds the
//     D2 note - the 25% reference cap holds that week AUTOMATICALLY (Pepe 31c65d0);
//   * the "PAT-days since <date>" first-week note only when the PAT-days began inside this week (cfg.pd_first,
//     capital/vaults.pdFirstWeek); any other partial week (a missing / pruned bucket weeks later) gets the plain note - never
//     a stale pd_from date with a first-week explanation; a server without pd_first gets the plain one too;
//   * no note for a cap above 0, nor for a wholly time-weighted week.
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-staking-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-staking.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const V = require(path.join(repo, "capital", "vaults.js"));
const DAY = 86400;
const B = 1792987200 + 7 * DAY;            // a Monday 04:00 UTC settlement boundary
const tick = () => new Promise((r) => setTimeout(r, 15));
const at = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
const fill = (k, v) => en[k].replace(/\{(\w+)\}/g, (m, n) => (v[n] != null ? v[n] : m));

function dom() {
  const els = {};
  function El(id, tag) {
    let own = "";
    const e = { id, tag: tag || "div", children: [], _l: {}, attrs: {}, value: "", hidden: false, disabled: false, className: "", colSpan: 1,
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
      fire(t) { (this._l[t] || []).forEach((f) => f({ preventDefault() {} })); },
      appendChild(c) { this.children.push(c); return c; },
      getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
      querySelectorAll() { return Object.values(els).filter((x) => x.form); },
      focus() {} };
    Object.defineProperty(e, "textContent", { get() { return own + e.children.map((c) => c.textContent).join(""); },
                                              set(v) { own = String(v); e.children = []; } });
    return e;
  }
  for (const i of ["stkAdm", "stkKv", "stkVaults", "stkTrack", "stkRt", "stkAudit", "stkActs", "stkForm", "stkMsg", "stkConfirm", "stkWhat"]) els[i] = El(i);
  Object.assign(els.stkCap = El("stkCap", "input"), { form: true });
  Object.assign(els.stkSetCap = El("stkSetCap", "button"), { form: true });
  els.stkPw = El("stkPw", "input");
  for (const i of ["stkYes", "stkNo"]) els[i] = El(i, "button");
  els.stkConfirm.hidden = true;
  return { els, document: { getElementById: (i) => els[i] || null, createElement: (t) => El(null, t) } };
}

function boot(cfg) {
  const { els, document } = dom();
  els.stkAdm.attrs = { "data-csrf": "tok.sig", "data-edit": "1" };
  const data = { ok: true, live: true, can_edit: true, cfg_age: 120, panel: {}, vaults: {}, track: [], roundtrips: [], watch: null, weekly: [], actions: [],
                 cfg: Object.assign({ ceil_apr: 0, cushion: false, cushion_days: 8, staker_max: 0.5, bonus_cap: 0.25, auto_staker_cap: false,
                                      weighted: true, pd_boundary: B }, cfg) };
  const fetch = (p, o) => {
    const r = p === "/api/admin/econ/staking" && !(o && o.method) ? { status: 200, j: JSON.parse(JSON.stringify(data)) }
      : p === "/api/admin/econ/edit/nonce" ? { status: 200, j: { nonce: "n1" } } : { status: 404, j: {} };
    return Promise.resolve({ status: r.status, json: () => Promise.resolve(r.j) });
  };
  vm.runInNewContext(SRC, { window: {}, document, fetch, console, setTimeout, clearTimeout });
  const setCap = async (v) => { els.stkCap.value = v; els.stkSetCap.fire("click"); await tick(); return els.stkWhat.textContent; };
  return { els, setCap };
}

test("the first week of the time-weighting, cap -> 0: the 'PAT-days since' note with that week's start, the reference cap automatic", async () => {
  const from = B - 2 * DAY;
  assert.equal(V.pdFirstWeek(from, B), true);
  const A = boot({ pd_from: from, pd_partial: true, pd_first: true });
  await tick();
  const what = await A.setCap("0");
  assert.equal(A.els.stkConfirm.hidden, false);
  assert.ok(what.startsWith(fill("js.admstk.ask_cap_partial", { when: at(from), settle: at(B) }) + " "), what);
  assert.ok(what.endsWith(fill("js.admstk.ask_cap", { cap: "0" })), what);
  assert.match(what, /25% reference cap, automatically/);
  assert.doesNotMatch(what, /20%/, "the stakers' share is a setting (staker_share_pct): not hard-coded");
});

test("a later partial week (missing / pruned bucket, PAT-days began weeks ago): the plain note, no stale pd_from date", async () => {
  const from = B - 30 * DAY;
  assert.equal(V.pdFirstWeek(from, B), false);
  for (const cfg of [{ pd_from: from, pd_partial: true, pd_first: false },
                     { pd_from: from, pd_partial: true },                 // a server from before pd_first: the plain note
                     { pd_from: null, pd_partial: true, pd_first: false }]) { // a book with Pepe's buckets but no pd_from yet
    const A = boot(cfg);
    await tick();
    const what = await A.setCap("0");
    assert.equal(what, fill("js.admstk.ask_cap_partial_gap", { settle: at(B) }) + " " + fill("js.admstk.ask_cap", { cap: "0" }), JSON.stringify(cfg));
    assert.ok(!what.includes(at(from)), "no pd_from date");
    assert.doesNotMatch(what, /first week|PAT-days since/);
  }
});

test("no note for a cap above 0, nor for a wholly time-weighted week", async () => {
  const A = boot({ pd_from: B - 2 * DAY, pd_partial: true, pd_first: true });
  await tick();
  assert.equal(await A.setCap("25"), fill("js.admstk.ask_cap", { cap: "25" }));
  const W = boot({ pd_from: B - 30 * DAY, pd_partial: false, pd_first: false });
  await tick();
  assert.equal(await W.setCap("0"), fill("js.admstk.ask_cap", { cap: "0" }));
});

test("pdFirstWeek: the PAT-days began inside the week that settles at B - [B - 7 d, B)", () => {
  assert.equal(V.pdFirstWeek(B - 7 * DAY, B), true, "at the week's own Monday cut-off");
  assert.equal(V.pdFirstWeek(B - 1, B), true);
  assert.equal(V.pdFirstWeek(B - 7 * DAY - 1, B), false, "an earlier week");
  assert.equal(V.pdFirstWeek(B, B), false, "the next week's");
  for (const f of [null, 0, -5, "x", undefined]) assert.equal(V.pdFirstWeek(f, B), false, String(f));
  assert.equal(V.pdFirstWeek(B - DAY, 0), false, "no boundary");
});
