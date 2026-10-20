// Review of PO-2 - /admin/economy's 🏦 Protocol pools card, the PAGE SCRIPT (public/js/admin-pools.js), run in a vm with a small
// fake DOM and a mocked fetch: once the SITE owns the economy settings a PAT Routing change carries the settings' rev the card
// loaded (base_rev - a stale one is 409 on the server, never last-writer-wins) and a note (required); while Pepe owns them the
// change goes to him as before (no rev, no note needed).
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-pools-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-pools.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 15));

function El(id, tag) {
  let own = "";
  const e = { id, tag: tag || "div", children: [], _l: {}, attrs: {}, value: "", hidden: false, className: "", style: {}, colSpan: 0,
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    fire(t) { (this._l[t] || []).forEach((f) => f({ preventDefault() {} })); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    focus() {} };
  Object.defineProperty(e, "textContent", { get() { return own + e.children.map((c) => c.textContent).join(""); }, set(v) { own = String(v); e.children = []; } });
  return e;
}
const IDS = ["poolsAdm", "poolsMsg", "poolsKv", "poolsSwitch", "poolsRows", "poolsMoves", "poolsFed", "poolsInc", "poolsDocs", "poolsRoutes", "routeFlow",
             "poolsCfg", "poolsConfirm", "poolsPw", "poolsWhat", "routeForm", "routeShares", "routeNote", "econForm", "econText", "poolsNo", "poolsYes"];

function viewOf(owner) {
  return { cfg: { owner, rev: 12 }, pools: { live: true, enabled: true, pools: { reserve: 1 }, labels: {}, moves: [], inbox: {}, sum: 1, count: 1 }, docs: {},
           pat_routes: { raffle: [["incentives", 100]] }, econ_cfg: {}, fed_journal: [], incentive_groups: [],
           catalog: { routes: { raffle: { group: "Room games", label: "Raffle", default: [["incentives", 100]], readonly: false } } } };
}
function boot(view) {
  const els = {};
  for (const i of IDS) els[i] = El(i, /Pw|Shares|Note|Text/.test(i) ? "input" : /Flow/.test(i) ? "select" : /Yes|No|Switch/.test(i) ? "button" : "div");
  els.poolsAdm.attrs["data-csrf"] = "tok.sig";
  const document = { getElementById: (i) => els[i] || null, createElement: (t) => El(null, t) };
  const posts = [];
  const fetch = (p, o) => {
    if (!o || !o.method) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(view))) });
    const body = JSON.parse(o.body || "{}");
    posts.push({ p, body, headers: o.headers });
    const j = p === "/api/admin/econ/edit/nonce" ? { nonce: "n1" } : { ok: true, request: { applied: true, rev: 13, msg: "saved" } };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(j) });
  };
  vm.runInNewContext(SRC, { document, fetch, window: {}, setTimeout, console, confirm: () => true });
  return { els, posts };
}

test("site-owned: a routing change needs a note and carries the rev the card loaded (base_rev) - the server refuses a stale one", async () => {
  const { els, posts } = boot(viewOf("site"));
  await tick();
  els.routeFlow.value = "raffle";
  els.routeShares.value = "incentives 60, reserve 40";
  els.routeForm.fire("submit");
  assert.match(els.poolsMsg.textContent, /Say why in the note/);
  assert.equal(posts.length, 0, "nothing asked without a note");
  els.routeNote.value = "more to the budget";
  els.routeForm.fire("submit");
  await tick();
  assert.deepEqual(posts.map((x) => x.p), ["/api/admin/econ/edit/nonce"]);
  els.poolsPw.value = "pw";
  els.poolsYes.fire("click");
  await tick();
  assert.equal(posts[1].p, "/api/admin/econ/edit");
  assert.deepEqual(posts[1].body, { op: "routes", flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], base_rev: 12, note: "more to the budget", nonce: "n1", password: "pw" });
  assert.equal(els.routeNote.value, "", "the note is cleared once applied");
  // a reset carries them too
  els.routeShares.value = "";
  els.routeNote.value = "back to the default";
  els.routeForm.fire("submit");
  await tick();
  els.poolsPw.value = "pw";
  els.poolsYes.fire("click");
  await tick();
  assert.deepEqual(posts[3].body, { op: "routes", flow: "raffle", reset: true, base_rev: 12, note: "back to the default", nonce: "n1", password: "pw" });
});

test("Pepe-owned: the change goes to Pepe as before - no rev, no note needed", async () => {
  const { els, posts } = boot(viewOf("pepe"));
  await tick();
  els.routeFlow.value = "raffle";
  els.routeShares.value = "incentives 60, reserve 40";
  els.routeForm.fire("submit");
  await tick();
  els.poolsPw.value = "pw";
  els.poolsYes.fire("click");
  await tick();
  assert.deepEqual(posts[1].body, { op: "routes", flow: "raffle", shares: [["incentives", 60], ["reserve", 40]], nonce: "n1", password: "pw" });
});
