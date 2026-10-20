// PO-2 - /admin/economy's ⚙️ Policy settings card, the PAGE SCRIPT (public/js/admin-policycfg.js), run in a vm with a small fake
// DOM and a mocked fetch (the server side is policy/config.js adminView; test/policy-config.test.js checks it):
//   * mirror mode (Pepe owns the config): every key renders read-only - no editor in any row, the read-only note, the diff
//     report and the dual read listed
//   * site-owned, a Pepe owner: a row's editor stages a change, the review lists it, the save needs a note, then asks a nonce and
//     posts {changes, base_rev, note, nonce, password} - a fraction key's field is a percent number; read-only keys have no editor
//   * a stale rev (409 stale_rev) says so and reloads
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-policycfg-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-policycfg.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 15));

function El(id, tag) {
  let own = "";
  const e = { id, tag: tag || "div", children: [], _l: {}, attrs: {}, value: "", hidden: false, className: "", style: {}, title: "", type: "", step: "", placeholder: "",
    classList: { _s: new Set(), toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    fire(t) { (this._l[t] || []).forEach((f) => f({ preventDefault() {} })); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    focus() {} };
  Object.defineProperty(e, "textContent", { get() { return own + e.children.map((c) => c.textContent).join(""); }, set(v) { own = String(v); e.children = []; } });
  return e;
}
const IDS = ["pcfgAdm", "pcfgKv", "pcfgMode", "pcfgSections", "pcfgEdit", "pcfgEditRows", "pcfgEditForm", "pcfgNote", "pcfgPw", "pcfgSave", "pcfgDiscard",
             "pcfgDiffKv", "pcfgDiff", "pcfgDual", "pcfgDualRows", "pcfgMirror", "pcfgLog", "pcfgLogForm", "pcfgLogKey", "pcfgLogActor", "pcfgLogVia",
             "pcfgPauseForm", "pcfgPauseFeature", "pcfgPauseNote", "pcfgPausePw", "pcfgPauseBtn", "pcfgResumeBtn", "pcfgMsg"];
const walk = (e, f, out = []) => { if (f(e)) out.push(e); for (const c of e.children || []) walk(c, f, out); return out; };

function viewOf(owner, canEdit) {
  const key = (k, section, kind, unit, value, shown, o = {}) => Object.assign({ key: k, section, label: k, unit, suffix: "", kind, choices: null, min: 0, max: 100,
    applies: "now", engine_input: false, readonly: false, aliases: [], value, present: true, shown, default: value, default_shown: shown,
    last: { rev: 3, by: "pepe", via: "mirror", ts: 1792500000000, src: "policy:econ_cfg." + k } }, o);
  return { ok: true, owner, own: { cfg: { owner, paused: 0 } }, rev: 7, sha: "a".repeat(64), sections: [["band", "Fed band"], ["staking", "Staking"], ["system", "System"]],
           keys: [key("fed_floor", "band", "int", "pat", 25000000, "25,000,000", { max: 10000000000, applies: "next_period", engine_input: true }),
                  key("vault_ceil_apr", "staking", "num", "fraction", 0.25, "25%", { max: 5 }),
                  key("vault_ceil_cushion", "staking", "bool", "bool", false, "off"),
                  key("epoch_hour", "system", "int", "count", 4, "4", { readonly: true, max: 23 })],
           diff: { empty: owner === "pepe", counts: { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 }, missing: [], unknown: [], invalid: [], whole: [], disagree: [],
                   sources: { policy: { seen: 1, age_s: 30, stale: false } } },
           dual: { checks: [{ day: "2026-10-31", consumer: "capital.cutoff", checks: 1, diffs: 0 }], diffs: [] }, mirror_days: { "2026-10-31": { pushes: 288, changes: 0, max: { missing: 0 } } },
           window: { open: false, waiting: [] }, pepe_rev: { rev: 7, at: 1792500000000 }, log: [], can_edit: canEdit };
}
function boot(view, answers = {}) {
  const els = {};
  for (const i of IDS) els[i] = El(i, /Note|Pw|Key|Actor/.test(i) ? "input" : /Via|Feature/.test(i) ? "select" : /Btn|Save|Discard/.test(i) ? "button" : "div");
  els.pcfgAdm.attrs["data-csrf"] = "tok.sig";
  els.pcfgEdit.hidden = true;
  const document = { getElementById: (i) => els[i] || null, createElement: (t) => El(null, t) };
  const posts = [];
  const fetch = (p, o) => {
    if (!o || !o.method) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(view))) });
    const body = JSON.parse(o.body || "{}");
    posts.push({ p, body, headers: o.headers });
    const a = answers[p] || (p === "/api/admin/econ/edit/nonce" ? { status: 200, j: { nonce: "n1" } } : { status: 200, j: { ok: true, rev: view.rev + 1, msg: "saved: x" } });
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.j) });
  };
  vm.runInNewContext(SRC, { document, fetch, window: {}, setInterval: () => 0, console });
  return { els, posts };
}

test("mirror mode: every key read-only - no editor, the read-only note, the diff report and the dual read", async () => {
  const { els } = boot(viewOf("pepe", false));
  await tick();
  assert.equal(walk(els.pcfgSections, (e) => e.tag === "input" || e.tag === "select").length, 0, "no editor anywhere");
  assert.match(els.pcfgMode.textContent, /Read-only: Pepe still owns these settings/);
  assert.match(els.pcfgKv.textContent, /Pepe's \(the site mirrors his pushes/);
  assert.match(els.pcfgSections.textContent, /fed_floor25,000,000/);
  assert.match(els.pcfgSections.textContent, /vault_ceil_apr25%%/, "a fraction shows as a percent");
  assert.match(els.pcfgSections.textContent, /next period · engine input/);
  assert.match(els.pcfgSections.textContent, /read-only/);
  assert.match(els.pcfgDiff.textContent, /No differences/);
  assert.match(els.pcfgDual.textContent, /capital\.cutoff/);
  assert.equal(els.pcfgEdit.hidden, true);
});

test("site-owned, an owner: stage -> review -> a note -> nonce + POST {changes, base_rev, note, nonce, password}; a fraction is a percent", async () => {
  const { els, posts } = boot(viewOf("site", true));
  await tick();
  const eds = walk(els.pcfgSections, (e) => e.tag === "input" || e.tag === "select");
  assert.equal(eds.length, 3, "an editor per editable row (not the read-only one)");
  const byLabel = (k) => eds.find((e) => (e.attrs["aria-label"] || "").includes(k));
  const fr = byLabel("vault_ceil_apr");
  assert.equal(fr.type, "number");
  assert.match(fr.placeholder, /%/);
  fr.value = "20";
  fr.fire("change");
  const ff = byLabel("fed_floor");
  assert.equal(ff.type, "text", "an amount takes 2.5m / unlimited");
  ff.value = "30m";
  ff.fire("change");
  assert.equal(els.pcfgEdit.hidden, false);
  assert.match(els.pcfgEditRows.textContent, /vault_ceil_apr25%20%/);
  els.pcfgEditForm.fire("submit");
  assert.match(els.pcfgMsg.textContent, /note first/);
  assert.equal(posts.length, 0);
  els.pcfgNote.value = "lower the ceiling";
  els.pcfgPw.value = "pw";
  els.pcfgEditForm.fire("submit");
  await tick();
  assert.deepEqual(posts.map((x) => x.p), ["/api/admin/econ/edit/nonce", "/api/admin/policy/cfg"]);
  assert.deepEqual(posts[1].body, { changes: { vault_ceil_apr: 20, fed_floor: "30m" }, base_rev: 7, note: "lower the ceiling", nonce: "n1", password: "pw" });
  assert.equal(posts[1].headers["x-csrf-token"], "tok.sig");
  assert.equal(posts[1].headers["X-Requested-With"], "fetch");
  assert.equal(els.pcfgPw.value, "", "the password field is cleared");
  assert.match(els.pcfgMsg.textContent, /Saved as rev 8/);
});

test("a stale rev says so (nothing changed) and reloads", async () => {
  const { els } = boot(viewOf("site", true), { "/api/admin/policy/cfg": { status: 409, j: { ok: false, code: "stale_rev", rev: 9, error: "changed" } } });
  await tick();
  const ed = walk(els.pcfgSections, (e) => e.tag === "select")[0];
  ed.value = "on";
  ed.fire("change");
  els.pcfgNote.value = "turn the cushion on";
  els.pcfgEditForm.fire("submit");
  await tick();
  assert.match(els.pcfgMsg.textContent, /now rev 9/);
});
