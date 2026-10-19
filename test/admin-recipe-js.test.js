// 1.99ada: /admin/economy's 💸 Pad-vault payout recipe card - the PAGE SCRIPT (public/js/admin-recipe.js), run in a vm with
// a small fake DOM and a mocked fetch (the server side is test/recipe-cfg.test.js):
//   * prefill: the saved values, else Pepe's last REPORTED values (a first save never resets chat-tuned ones), else defaults
//   * the live total line mirrors recipecfg.clean: warnings above / below 100 %, refusals (regulars & co > 100 %, all five
//     > 150 %, not a whole percent) disable Save with the reason
//   * the confirm panel lists the diff (the unpaid-shares switch only when it changes) and the POST carries the step-up
//     (nonce + password), base_rev, the fractions, the note, the CSRF + X-Requested-With headers
//   * answers: saved (reload), 409 stale (message + the form refilled with the website's values), 403 owner_only
//   * the status rows: not_set / applied / pending (+ "hasn't synced for 40m") / refused / old_pepe, the live payout hour
//   * the last payout day marks a capped allowance; a server can_edit false disables the form
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-recipe-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "admin-recipe.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const DEF = { owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.1, games_unpaid: 1 };
const PCT = ["rcfgOwner", "rcfgGang", "rcfgStreamers", "rcfgPeople", "rcfgGames"];
const tick = () => new Promise((r) => setTimeout(r, 15));
const clone = (o) => JSON.parse(JSON.stringify(o));

// the card's elements as views/partials/econ-recipe.ejs renders them; textContent = its own text + its children's
function dom() {
  const els = {};
  function El(id, tag) {
    let own = "";
    const e = { id, tag: tag || "div", children: [], _l: {}, attrs: {}, value: "", checked: false, hidden: false, disabled: false, className: "", colSpan: 1, title: "",
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
      fire(t) { (this._l[t] || []).forEach((f) => f({ preventDefault() {} })); },
      appendChild(c) { this.children.push(c); return c; },
      getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
      querySelectorAll() { return Object.values(els).filter((x) => x.form && (x.tag === "input" || x.tag === "button")); },
      focus() {} };
    Object.defineProperty(e, "textContent", { get() { return own + e.children.map((c) => c.textContent).join(""); },
                                              set(v) { own = String(v); e.children = []; } });
    return e;
  }
  for (const i of ["rcfgAdm", "rcfgKv", "rcfgForm", "rcfgSum", "rcfgConfirm", "rcfgWhat", "rcfgMsg", "rcfgOther", "rcfgLast", "rcfgLog"]) els[i] = El(i);
  for (const i of PCT.concat(["rcfgUnpaid", "rcfgNote"])) Object.assign(els[i] = El(i, "input"), { form: true });
  for (const i of ["rcfgSave", "rcfgDefaults"]) Object.assign(els[i] = El(i, "button"), { form: true });
  els.rcfgPw = El("rcfgPw", "input");
  for (const i of ["rcfgYes", "rcfgNo"]) els[i] = El(i, "button");
  els.rcfgConfirm.hidden = true;
  return { els, document: { getElementById: (i) => els[i] || null, createElement: (t) => El(null, t) } };
}

// boot the script against `data` (GET /api/admin/econ/recipe); answers.save = the POST's answer
function boot(data, edit = true) {
  const { els, document } = dom();
  els.rcfgAdm.attrs = { "data-csrf": "tok.sig", "data-edit": edit ? "1" : "0" };
  const calls = [], answers = { save: { status: 200, j: { ok: true, saved: { rev: 1 }, warnings: [] } }, nonce: { status: 200, j: { nonce: "n1" } } };
  const fetch = (p, o) => {
    calls.push({ path: p, method: (o && o.method) || "GET", body: o && o.body ? JSON.parse(o.body) : null, headers: (o && o.headers) || {} });
    const r = p === "/api/admin/econ/recipe" && !(o && o.method) ? { status: 200, j: clone(data) }
      : p === "/api/admin/econ/edit/nonce" ? answers.nonce : p === "/api/admin/econ/recipe" ? answers.save : { status: 404, j: {} };
    return Promise.resolve({ status: r.status, json: () => Promise.resolve(clone(r.j)) });
  };
  vm.runInNewContext(SRC, { window: {}, document, fetch, console, setTimeout });
  const kv = (el) => el.children.map((d) => d.children.map((c) => c.textContent).join(": ")).join(" | ");
  const cells = (tbody) => tbody.children.map((tr) => tr.children.map((td) => td.textContent));
  const form = () => PCT.map((i) => els[i].value).join("/") + " " + (els.rcfgUnpaid.checked ? "on" : "off");
  const type = (id, v) => { els[id].value = v; els.rcfgForm.fire("input"); };
  return { els, calls, answers, kv, cells, form, type };
}

function data(o) {
  return Object.assign({
    ok: true, saved: null, defaults: DEF, limits: { paid_max: 1, sum_max: 1.5, sum_warn: 1 },
    pepe: { cfg: { owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.12, games_unpaid: 0, cap_i7: 0.25, hour: 6 },
            cfg_rev: null, cfg_src: "local", cfg_applied_at: null, cfg_error: null, synced: Date.now() - 120000, on: true },
    state: "not_set", can_edit: true, site_keys: Object.keys(DEF), pepe_keys: ["cap_i7", "owner_days", "hour"], log: [], last: [],
  }, o);
}

test("nothing saved: the form starts from Pepe's reported (chat-tuned) values, the status says so, the payout hour is his", async () => {
  const B = boot(data());
  await tick();
  assert.equal(B.form(), "15/15/25/35/12 off", "Pepe's games 12% and switch off - not the defaults");
  const kv = B.kv(B.els.rcfgKv);
  assert.ok(kv.includes(en["js.admrcfg.not_set"]), kv);
  assert.ok(kv.includes(en["js.admrcfg.own"]));
  assert.ok(kv.includes("the next daily payout, ~06:00 Pepe's time"), "the hour Pepe reports, not a hard-coded 05:00");
  assert.match(B.kv(B.els.rcfgOther), /cap_i7: 0\.25 \| owner_days: — \| hour: 6/);
  assert.equal(B.els.rcfgSum.textContent, "Total 102% - the slices add up to 102%: on a day every slice pays in full, room games get only what's left of the budget");
  assert.equal(B.els.rcfgSave.disabled, false);
  assert.deepEqual(B.cells(B.els.rcfgLast), [[en["js.admrcfg.none_last"]]]);
  assert.deepEqual(B.calls.map((c) => c.path), ["/api/admin/econ/recipe"]);
  assert.deepEqual([B.calls[0].headers["x-csrf-token"], B.calls[0].headers["X-Requested-With"]], ["tok.sig", "fetch"]);
  // an older Pepe that reports no cfg at all: the defaults
  const O = boot(data({ pepe: Object.assign(data().pepe, { cfg: {} }) }));
  await tick();
  assert.equal(O.form(), "15/15/25/35/10 on");
});

test("the live total line mirrors recipecfg.clean: warnings, and refusals that disable Save", async () => {
  const B = boot(data());
  await tick();
  const sum = () => [B.els.rcfgSum.textContent, B.els.rcfgSave.disabled, /rcfg-bad/.test(B.els.rcfgSum.className)];
  B.type("rcfgGames", "10");
  assert.deepEqual(sum(), ["Total 100%", false, false], "exactly 100%: no warning");
  B.type("rcfgGames", "20");
  assert.deepEqual(sum(), ["Total 110% - the slices add up to 110%: on a day every slice pays in full, room games get only what's left of the budget", false, false]);
  B.type("rcfgPeople", "46");
  assert.deepEqual(sum(), ["Total 121% - " + en["js.admrcfg.err_paid"], true, true], "owner + gang + streamers + regulars 101%: refused");
  B.type("rcfgPeople", "35"); B.type("rcfgGames", "61");
  assert.deepEqual(sum(), ["Total 151% - " + en["js.admrcfg.err_total"], true, true]);
  B.type("rcfgGames", "60");
  assert.equal(sum()[1], false, "150% is still allowed (warned)");
  B.type("rcfgGames", "12.5");
  assert.deepEqual(sum(), [en["js.admrcfg.err_whole"], true, true], "not a whole percent");
  B.type("rcfgGames", "");
  assert.equal(sum()[1], true, "empty");
  B.type("rcfgGames", "0"); B.type("rcfgOwner", "0"); B.type("rcfgGang", "0"); B.type("rcfgStreamers", "0"); B.type("rcfgPeople", "0");
  assert.deepEqual(sum(), ["Total 0% - 100% of each day's budget is never assigned and always stays in the vault", false, false]);
  // a submit while refused never asks for a nonce
  B.type("rcfgPeople", "101");
  B.els.rcfgForm.fire("submit"); await tick();
  assert.equal(B.els.rcfgConfirm.hidden, true);
  assert.ok(!B.calls.some((c) => c.path === "/api/admin/econ/edit/nonce"));
});

test("save: the confirm panel lists the diff, the POST carries the step-up and fractions, then the card reloads", async () => {
  const B = boot(data());
  await tick();
  B.type("rcfgGames", "20");
  B.els.rcfgForm.fire("submit"); await tick();
  assert.equal(B.els.rcfgConfirm.hidden, false);
  assert.equal(B.els.rcfgWhat.textContent, "Save the payout recipe: room games 12% → 20%. It applies from the next daily payout; today's prize pool doesn't change."
    + " the slices add up to 110%: on a day every slice pays in full, room games get only what's left of the budget.", "a first save diffs against Pepe's values; the switch didn't change, so it isn't listed");
  B.els.rcfgPw.value = "pw-1"; B.els.rcfgNote.value = "bump games";
  B.answers.save = { status: 200, j: { ok: true, saved: { rev: 1 }, warnings: ["the slices add up to 110%"] } };
  B.els.rcfgYes.fire("click"); await tick(); await tick();
  const post = B.calls.find((c) => c.path === "/api/admin/econ/recipe" && c.method === "POST");
  assert.deepEqual(post.body, { nonce: "n1", password: "pw-1", base_rev: null, cfg: { owner_pct: 0.15, gang_pct: 0.15, streamer_pct: 0.25, people_pct: 0.35, games_pct: 0.2, games_unpaid: 0 }, note: "bump games" });
  assert.deepEqual([post.headers["x-csrf-token"], post.headers["X-Requested-With"], post.headers["content-type"]], ["tok.sig", "fetch", "application/json"]);
  const nonce = B.calls.find((c) => c.path === "/api/admin/econ/edit/nonce");
  assert.equal(nonce.method, "POST");
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.saved"].replace("{rev}", "1") + " the slices add up to 110%.");
  assert.equal(B.els.rcfgPw.value, "", "the password never stays in the field");
  assert.equal(B.els.rcfgConfirm.hidden, true);
  assert.equal(B.calls.filter((c) => c.path === "/api/admin/econ/recipe" && c.method === "GET").length, 2, "reloaded after the save");
  // the switch is listed only when it changes
  B.els.rcfgUnpaid.checked = true; B.els.rcfgForm.fire("change");
  B.els.rcfgForm.fire("submit"); await tick();
  assert.match(B.els.rcfgWhat.textContent, /unpaid shares → games: on/);
  B.els.rcfgNo.fire("click");
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.cancelled"]);
});

test("answers: 409 stale refills the form with the website's values; owner_only and errors are shown; a saved row is the base", async () => {
  const SAVED = { rev: 3, cfg: Object.assign({}, DEF, { games_pct: 0.2 }), at: Date.parse("2026-10-19T14:02:00Z"), by: "boss" };
  const d = data({ saved: SAVED, state: "applied", pepe: Object.assign(data().pepe, { cfg: Object.assign({}, data().pepe.cfg, SAVED.cfg), cfg_rev: 3, cfg_src: "site" }) });
  const B = boot(d);
  await tick();
  assert.equal(B.form(), "15/15/25/35/20 on", "the saved values");
  const kv = B.kv(B.els.rcfgKv);
  assert.ok(kv.includes("rev 3 by boss, 2026-10-19 14:02 UTC"), kv);
  assert.match(kv, /Pepe applies: rev 3 \(his last sync 2m ago\)/);
  B.els.rcfgForm.fire("submit"); await tick();
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.confirm_same"], "no change from the saved row: no step-up");
  assert.equal(B.els.rcfgConfirm.hidden, true);
  // someone else saved rev 4 meanwhile
  B.type("rcfgGames", "30");
  B.els.rcfgForm.fire("submit"); await tick();
  assert.match(B.els.rcfgWhat.textContent, /room games 20% → 30%/);
  d.saved = { rev: 4, cfg: Object.assign({}, DEF, { games_pct: 0.25 }), at: SAVED.at, by: "chat:bossfrog" }; d.state = "pending";
  B.answers.save = { status: 409, j: { ok: false, code: "stale", saved: d.saved } };
  B.els.rcfgPw.value = "pw"; B.els.rcfgYes.fire("click"); await tick(); await tick();
  assert.equal(B.calls.filter((c) => c.method === "POST" && c.path === "/api/admin/econ/recipe")[0].body.base_rev, 3);
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.stale"]);
  assert.equal(B.form(), "15/15/25/35/25 on", "refilled with what the website holds now");
  // owner_only (a role changed since the page loaded) and a plain error
  B.type("rcfgGames", "30");
  B.answers.save = { status: 403, j: { ok: false, code: "owner_only", error: "x" } };
  B.els.rcfgForm.fire("submit"); await tick(); B.els.rcfgYes.fire("click"); await tick();
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.not_owner"]);
  B.answers.save = { status: 400, j: { ok: false, code: "invalid", errors: ["games_pct must be a number from 0 to 1"] } };
  B.els.rcfgForm.fire("submit"); await tick(); B.els.rcfgYes.fire("click"); await tick();
  assert.equal(B.els.rcfgMsg.textContent, "games_pct must be a number from 0 to 1");
  // Back to defaults fills them in, nothing is posted until Save
  const posts = B.calls.filter((c) => c.method === "POST").length;
  B.els.rcfgDefaults.fire("click");
  assert.equal(B.form(), "15/15/25/35/10 on");
  assert.equal(B.els.rcfgMsg.textContent, en["js.admrcfg.defaults_filled"]);
  assert.equal(B.calls.filter((c) => c.method === "POST").length, posts);
});

test("status rows: pending + a stale sync, refused with Pepe's reasons, old_pepe, payouts off", async () => {
  const SAVED = { rev: 2, cfg: DEF, at: 1, by: "boss" };
  let B = boot(data({ saved: SAVED, state: "pending", pepe: Object.assign(data().pepe, { synced: Date.now() - 40 * 60000, on: false }) }));
  await tick();
  let kv = B.kv(B.els.rcfgKv);
  assert.ok(kv.includes("Pending: Pepe hasn't picked up rev 2 yet (he syncs about every 5 minutes). Pepe hasn't synced for 40m; he keeps his last values until he does"), kv);
  assert.ok(kv.includes("Room payouts: " + en["js.admrcfg.payouts_off"]));
  B = boot(data({ saved: SAVED, state: "pending", pepe: Object.assign(data().pepe, { synced: null }) }));
  await tick();
  kv = B.kv(B.els.rcfgKv);
  assert.ok(kv.includes(en["js.admrcfg.never_synced"]) && !kv.includes("synced for never"), "never synced: " + kv);
  B = boot(data({ saved: SAVED, state: "refused", pepe: Object.assign(data().pepe, { cfg_error: { rev: 2, errors: ["one", "two"] } }) }));
  await tick();
  assert.match(B.kv(B.els.rcfgKv), /Pepe applies: Pepe refused rev 2: one; two/);
  B = boot(data({ saved: SAVED, state: "old_pepe" }));
  await tick();
  assert.ok(B.kv(B.els.rcfgKv).includes(en["js.admrcfg.old_pepe"]));
  B = boot(data({ pepe: Object.assign(data().pepe, { cfg: { hour: 99 } }) }));
  await tick();
  assert.ok(B.kv(B.els.rcfgKv).includes("~05:00"), "a junk hour falls back to 05");
});

test("the last payout day marks a capped allowance; the change log reads web / chat rows; can_edit false disables the form", async () => {
  const B = boot(data({
    last: [{ room: "a", title: "Pepe's Pad", day: "2026-10-18", B: 1112080, games_base: 111208, games_from_unpaid: 611644, games_allow: 722852, capped: false, used: 109461 },
           { room: "b", title: "Busy", day: "2026-10-18", B: 100000, games_base: 60000, games_from_unpaid: 30000, games_allow: 20000, capped: true, used: null }],
    log: [{ at: Date.parse("2026-10-19T14:02:00Z"), admin: "chat:bossfrog", reason: "", detail: { rev: 2, via: "chat", changed: ["games_unpaid"], from: DEF, to: Object.assign({}, DEF, { games_unpaid: 0 }) } },
          { at: Date.parse("2026-10-19T13:00:00Z"), admin: "boss", reason: "bump", detail: { rev: 1, via: "web", changed: ["games_pct"], from: DEF, to: Object.assign({}, DEF, { games_pct: 0.2 }) } }],
    can_edit: false,
  }));
  await tick();
  const last = B.cells(B.els.rcfgLast);
  assert.deepEqual(last[0], ["Pepe's Pad", "2026-10-18", "1,112,080", "111,208", "611,644", "722,852", "109,461"]);
  assert.deepEqual(last[1], ["Busy", "2026-10-18", "100,000", "60,000", "30,000", "20,000 (capped)", "—"], "slice + unpaid > allowance: marked");
  assert.equal(B.els.rcfgLast.children[1].children[5].title, en["js.admrcfg.capped_t"]);
  assert.equal(B.els.rcfgLast.children[0].children[5].title, "");
  assert.deepEqual(B.cells(B.els.rcfgLog), [["2026-10-19 14:02", "chat:bossfrog", "chat", "rev 2: unpaid shares → games: off", ""],
                                            ["2026-10-19 13:00", "boss", "web", "rev 1: room games 10% → 20%", "bump"]]);
  for (const id of PCT.concat(["rcfgUnpaid", "rcfgNote", "rcfgSave", "rcfgDefaults"])) assert.equal(B.els[id].disabled, true, id + ": the server's can_edit wins");
  B.els.rcfgForm.fire("submit"); await tick();
  assert.ok(!B.calls.some((c) => c.method === "POST"), "a disabled card never posts");
});

test("the script's text goes through textContent only, and every _t key it uses is in en.json", () => {
  assert.doesNotMatch(SRC, /innerHTML|insertAdjacentHTML|document\.write/);
  let n = 0;
  for (const m of SRC.matchAll(/_t\('(js\.[a-z0-9_.]+)', '((?:[^'\\]|\\.)*)'|_t\('(js\.[a-z0-9_.]+)', "((?:[^"\\]|\\.)*)"/g)) {
    const k = m[1] || m[3], fallback = (m[2] != null ? m[2] : m[4]).replace(/\\'/g, "'");
    assert.ok(k in en, k);
    assert.equal(en[k], fallback, k + ": the fallback matches en.json");
    n++;
  }
  assert.ok(n > 50, "the script's strings were found: " + n);
});
