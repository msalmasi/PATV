// h22 phase 2 review (1.99??): the scheduled tournaments' web + admin surfaces the first build got wrong:
//   * the table header ("Table 6 · 3 tables left", never "Table 6 of 3"), a busted / finished entrant's results card at the table, the lobby
//     card's "Take me to my table" (the table, not the tournament page), "Remind me" only before the start (public/js/casinomtt.js in a vm)
//   * the lobby's Tournaments tab strip isn't caught by casino-ui.js's `.lob-tabs button` handlers (that broke the cash-table list)
//   * the schedule manager's Edit fills the WHOLE form from the tournament (rooms, buy-in, structure...) and only sends what can change
//     (public/js/admin-mtt.js in a vm, its body fed to the real MT.admin edit); the server ignores a form's blank fields
//   * the gate line says "Guarantees:" once
//   * Discord's 'starting' post (the role ping) goes out at the 15-minute mark, before the start; the bridge words it by the clock
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-review-web");
const { svc, MT } = h;
const MTCFG = require(path.join(h.repo, "casino", "mtt"));
const BUD = require(path.join(h.repo, "casino", "mttbudget"));
require(path.join(h.repo, "casino", "mttseat")).newSeed = () => "b8".repeat(32);
const posts = [];

test.before(async () => {
  await h.setup(20);
  svc.setDiscordBridge(async (p, body) => { posts.push([p, body]); return { ok: true }; });
});
test.after(() => svc.stop());
const tick = () => new Promise((r) => setTimeout(r, 15));

/** public/js/casinomtt.js in a vm (no lobby / page / board elements: only window.CZMTT) */
function loadMttJs() {
  const window = {};
  const document = { documentElement: { lang: "en" }, getElementById: () => null, querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(h.repo, "public", "js", "casinomtt.js"), "utf8"),
                     { window, document, setInterval: () => 0, setTimeout: () => 0, fetch: async () => ({ json: async () => ({}) }), location: { replace() {} }, console });
  return window.CZMTT;
}
const box = () => ({ dataset: {}, innerHTML: "", hidden: true });

test("the table page (casinomtt.js): 'Table 6 · 3 tables left' (never 'Table 6 of 3'); a busted entrant's and the winner's results card", () => {
  const Z = loadMttJs();
  const tn = { kind: "mtt", no: 4, name: "Sunday Stack", table_no: 6, tables_left: 3, final: false, level: 5, sb: 50, bb: 100, next_level_at: null, players_left: 20,
               entries: 54, avg_stack: 4050, url: "/casino/holdem/mtt/m0123456789", hold: null };
  let head = box(), res = box();
  Z.tableHead({ tourney: tn }, { tourney: { registered: true, mtt_rank: 3 } }, head, res);
  assert.ok(!/Table 6 of 3/.test(head.innerHTML), head.innerHTML);
  assert.match(head.innerHTML, /Table 6 · 3 tables left/);
  assert.equal(res.hidden, true, "a seated player: no results card");
  head = box(); res = box();
  Z.tableHead({ tourney: tn }, { tourney: { registered: false, result: { out: true, late_open: true } } }, head, res);
  assert.equal(res.hidden, false, "busted: the results card");
  assert.match(res.innerHTML, /You(&#39;|')re out/);
  assert.match(res.innerHTML, /re-enter/i, "late registration open: the way back in");
  assert.match(res.innerHTML, /\/casino\/holdem\/mtt\/m0123456789/);
  head = box(); res = box();
  Z.tableHead({ tourney: Object.assign({}, tn, { final: true }) }, { tourney: { registered: false, result: { place: 1, prize: 10276, final: true } } }, head, res);
  assert.equal(res.hidden, false);
  assert.match(res.innerHTML, /You finished #1/);
  assert.match(res.innerHTML, /10,276 PAT/);
});

test("the lobby card: 'Take me to my table' links the table (my_table); 'Remind me' only before the start", () => {
  const Z = loadMttJs();
  const row = { id: "m0123456789", no: 4, title: "Sunday Stack", status: "running", start_at: Date.now() - 60e3, est_ms: 3600e3, buyin: 1000, fee: 100, guarantee: 0,
                registered: 20, entries: 20, max_entries: 40, late_open: false, level: 3, players_left: 18, final_table: null, url: "/casino/holdem/mtt/m0123456789",
                structure: { kind: "standard", start_chips: 1500, level_mins: 5, reentry_max: 0, late_levels: 0 }, me: true, my_table: "abcdef0123" };
  const html = Z._card(row, { can_register: true });
  assert.match(html, /href="\/casino\/holdem\/t\/abcdef0123"[^>]*>Take me to my table/, html);
  const m = { id: "m0123456789", no: 4, title: "Sunday Stack", status: "running", start_at: Date.now(), buyin: 1000, fee: 100, guarantee: 0, freeroll: false,
              structure: { kind: "standard", start_chips: 1500, level_mins: 5, reentry_max: 0, late_levels: 0, levels: [[10, 20]] }, level: 3, sb: 25, bb: 50,
              next_level_at: null, players_left: 18, entries: 20, avg_stack: 1666, prize_pool: 20000, paid: 3, registered: 20, max_entries: 40, est_ms: 3600e3 };
  for (const status of ["running", "finishing", "done", "cancelled"]) {
    assert.ok(!/data-pg="remind"/.test(Z._head(Object.assign({}, m, { status }), { registered: false })), `${status}: no Remind me`);
  }
  assert.match(Z._head(Object.assign({}, m, { status: "registering" }), { registered: false }), /data-pg="remind"/);
  assert.match(Z._head(Object.assign({}, m, { status: "scheduled" }), { registered: false }), /data-pg="remind"/);
});

test("the lobby's Tournaments tab strip isn't a .lob-tabs strip (casino-ui.js's lobby handlers select every `.lob-tabs button`); .mtt-tabs is styled", () => {
  const ejs = fs.readFileSync(path.join(h.repo, "views", "casino-hm.ejs"), "utf8");
  const block = ejs.slice(ejs.indexOf("h22 phase 2 (1.99??): 🏆 scheduled tournaments - the lobby's block"), ejs.indexOf("── /h22 phase 2 ── %>", ejs.indexOf("the lobby's block")));
  assert.ok(block.length > 100);
  assert.match(block, /class="mtt-tabs"/);
  assert.doesNotMatch(block, /lob-tabs/, "never matched by casino-ui.js's `.lob-tabs button`");
  const ui = fs.readFileSync(path.join(h.repo, "public", "js", "casino-ui.js"), "utf8");
  assert.match(ui, /querySelectorAll\("\.lob-tabs button"\)/, "(what casino-ui.js selects)");
  const css = fs.readFileSync(path.join(h.repo, "views", "partials", "casino-css.ejs"), "utf8");
  const mb = css.slice(css.indexOf("h22 phase 2 (1.99??): 🏆 scheduled tournaments"), css.indexOf("/* ── /h22 phase 2 ── */"));
  assert.match(mb, /\.mtt-tabs\s*\{/);
  assert.match(mb, /\.mtt-tabs button\[aria-selected="true"\]/);
});

/** public/js/admin-mtt.js in a vm with a small fake DOM; fetch answers from `answers` (url -> json), POST bodies in `sent` */
function loadAdmin(answers) {
  const NAMES = ["id", "title", "start", "reg_opens", "buyin", "structure", "start_chips", "table_size", "max_entries", "min_entries", "late_levels", "reentry_max",
                 "guarantee", "rooms", "repeat", "count"];
  const el = (id, extra) => Object.assign({ id, value: "", disabled: false, required: false, dataset: {}, innerHTML: "", textContent: "", hidden: false, title: "",
                                            placeholder: "", _l: {}, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }, scrollIntoView() {} }, extra || {});
  const fields = {};
  for (const n of NAMES) fields[n] = el(null, { name: n });
  Object.assign(fields.reentry_max, { value: "0" }); Object.assign(fields.guarantee, { value: "0" }); Object.assign(fields.count, { value: "1" });
  Object.assign(fields.repeat, { value: "none" }); Object.assign(fields.structure, { value: "standard" }); Object.assign(fields.table_size, { value: "9" });
  fields.start.required = true; fields.title.required = true;
  const defaults = Object.fromEntries(NAMES.map((n) => [n, fields[n].value]));
  const form = el("mttForm", { elements: fields, reset() { for (const n of NAMES) fields[n].value = defaults[n]; } });
  const byId = { mttForm: form, mttBuyin: fields.buyin, mttGtd: fields.guarantee, mttRooms: fields.rooms };
  for (const i of ["mttPreview", "mttList", "mttGateText", "mttSave", "mttReset", "mttStatus", "mttDetail", "mttDetailT", "mttDetailBody"]) byId[i] = el(i);
  const docL = [];
  const document = { getElementById: (i) => byId[i] || null, addEventListener: (t, f) => docL.push(f) };
  class FormData { constructor(f) { this.f = f; } entries() { return Object.values(this.f.elements).filter((x) => x.name && !x.disabled).map((x) => [x.name, x.value])[Symbol.iterator](); } }
  const sent = [];
  const fetch = async (url, o) => {
    if (o && o.method === "POST") { sent.push({ url, body: JSON.parse(o.body) }); return { status: 200, json: async () => ({ ok: true }) }; }
    const a = answers[url];
    return { status: a ? 200 : 404, json: async () => JSON.parse(JSON.stringify(a || { ok: false })) };
  };
  vm.runInNewContext(fs.readFileSync(path.join(h.repo, "public", "js", "admin-mtt.js"), "utf8"),
                     { document, fetch, FormData, Intl, Date, alert() {}, confirm: () => true, prompt: () => null, console, setTimeout });
  const click = (act, id) => Promise.all(docL.map((f) => f({ target: { closest: () => ({ dataset: { act, id }, disabled: false }) } })));
  const submit = () => Promise.all((form._l.submit || []).map((f) => f({ preventDefault() {} })));
  return { fields, form, click, submit, sent };
}
const etLocal = (ms) => { const p = MTCFG.etParts(ms); const z = (n) => String(n).padStart(2, "0"); return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`; };

test("the schedule manager's Edit fills the whole form from the tournament and sends only what can change; the server keeps what a blank field didn't say", async () => {
  await h.fresh();
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  const M = await h.schedule({ title: "Turbo Night", buyin: 25000, structure: "turbo", start_chips: 3000, table_size: 6, max_entries: 30, min_entries: 4, late_levels: 2,
                               reentry_max: 1, rooms: ["PepeLab", "Lounge"], reg_opens_at: h.NOW + 2 * 3600e3 }, { open: false, startIn: 26 * 60 });
  assert.equal(M.status, "scheduled");
  const list = await MT.adminList();
  const answers = { "/api/casino/admin/mtt": { ok: true, list, gate: await MT.gateState(), settings: svc.S.settings, rooms: [], onair: [], now: Date.now() },
                    [`/api/casino/admin/mtt/${M.id}`]: { ok: true, mtt: await MT.adminView(M) } };
  const A = loadAdmin(answers);
  await tick();
  await A.click("edit", M.id);
  await tick();
  const f = A.fields;
  assert.equal(f.id.value, M.id);
  assert.equal(f.title.value, "Turbo Night");
  assert.equal(f.buyin.value, "25000", "the buy-in, not the select's first option");
  assert.equal(f.structure.value, "turbo");
  assert.equal(f.start_chips.value, "3000");
  assert.equal(f.table_size.value, "6");
  assert.equal(f.max_entries.value, "30");
  assert.equal(f.min_entries.value, "4");
  assert.equal(f.late_levels.value, "2");
  assert.equal(f.reentry_max.value, "1");
  assert.equal(f.rooms.value, "PepeLab, Lounge", "the announcement rooms");
  assert.equal(f.start.value, etLocal(M.start_at), "the start, as ET wall time");
  f.title.value = "Turbo Night II";
  await A.submit();
  assert.equal(A.sent.length, 1);
  const body = A.sent[0].body;
  assert.deepEqual(body.rooms, ["PepeLab", "Lounge"]);
  const r = await svc.locked(() => MT.admin("edit", h.admin, M, body));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(M.title, "Turbo Night II");
  assert.equal(M.money.buyin, 25000);
  assert.equal(M.structure.kind, "turbo");
  assert.equal(M.structure.start_chips, 3000);
  assert.equal(M.structure.reentry_max, 1);
  assert.equal(M.structure.late_levels, 2);
  assert.equal(M.structure.max_entries, 30);
  assert.deepEqual(M.rooms, ["PepeLab", "Lounge"]);
  assert.ok(Math.abs(M.start_at - answers[`/api/casino/admin/mtt/${M.id}`].mtt.start_at) < 1000, "the start unchanged (to the second)");
  // the server alone: a form's blank fields never overwrite what's stored
  const r2 = await svc.locked(() => MT.admin("edit", h.admin, M, { id: M.id, title: "Turbo Night III", start: "", reg_opens: "", start_chips: "", late_levels: "",
                                                                   reentry_max: "", max_entries: "", min_entries: "", guarantee: "", table_size: "" }));
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.equal(M.structure.start_chips, 3000);
  assert.equal(M.structure.reentry_max, 1);
  assert.equal(M.structure.late_levels, 2);
  assert.equal(M.structure.max_entries, 30);
  assert.equal(M.structure.table_size, 6);
  // registering: only the title and the rooms can change - the rest is disabled (not sent), the start not required
  h.NOW = M.reg_opens_at + 1000;
  await svc.tickOnce();
  assert.equal(M.status, "registering");
  answers[`/api/casino/admin/mtt/${M.id}`] = { ok: true, mtt: await MT.adminView(M) };
  const B = loadAdmin(answers);
  await tick();
  await B.click("edit", M.id);
  await tick();
  assert.equal(B.fields.rooms.value, "PepeLab, Lounge");
  for (const n of ["start", "buyin", "structure", "start_chips", "table_size", "max_entries", "min_entries", "late_levels", "reentry_max", "guarantee"]) {
    assert.equal(B.fields[n].disabled, true, `${n}: fixed once registration is open`);
  }
  assert.equal(B.fields.start.required, false);
  B.fields.title.value = "Turbo Night IV";
  await B.submit();
  const b2 = B.sent[0].body;
  assert.deepEqual(Object.keys(b2).filter((k) => !["id", "title", "rooms"].includes(k)), [], JSON.stringify(b2));
  const r3 = await svc.locked(() => MT.admin("edit", h.admin, M, b2));
  assert.ok(r3.ok, JSON.stringify(r3));
  assert.equal(M.title, "Turbo Night IV");
  assert.deepEqual(M.rooms, ["PepeLab", "Lounge"], "the rooms kept (the line rooms never silently emptied)");
});

test("the gate line says 'Guarantees:' once - the gate's text carries no prefix of its own (the admin card, the create errors)", async () => {
  await h.fresh({ settings: { mtt_guarantees: "on" } });
  for (const why of ["before_h2b", "budget_not_site", "budget_paused", "no_budget_service", "switch_off"]) assert.doesNotMatch(BUD.gateText(why), /^Guarantees/i, why);
  const g = await MT.gateState();
  assert.equal(g.text, "locked until 2026-12-01 14:00 UTC");
  const games = fs.readFileSync(path.join(h.repo, "views", "admin", "games.ejs"), "utf8");
  assert.match(games, /'Guarantees: ' \+ j\.gate\.text/);
  assert.match(games, /id="mttGateLine">Guarantees: locked until 2026-12-01 14:00 UTC</);
  const r = await svc.locked(() => MT.admin("create", h.admin, null, { title: "GTD Cup", start_at: h.NOW + 3600e3, buyin: 1000, guarantee: 50000, min_entries: 2, max_entries: 20 }).catch((e) => ({ error: e.message })));
  assert.match(r.error || "", /^Guarantees: locked until 2026-12-01 14:00 UTC\.$/, r.error);
});

test("Discord: the 'starting' post (the role's one ping) goes out at the 15-minute mark, before the start - once; the bridge says 'Starting soon' / 'Starting now' by the clock", async () => {
  await h.fresh({ settings: { mtt_discord: "on", mtt_discord_channel: "123456789012345678", mtt_discord_role: "223456789012345678" } });
  posts.length = 0;
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 }, { startIn: 60 });
  await h.reg(M, h.players.slice(0, 3));
  h.NOW = M.start_at - 14 * 60e3;
  await svc.tickOnce();
  await tick();
  const s = posts.filter(([, b]) => b.kind === "starting");
  assert.equal(s.length, 1, "posted at the 15-minute mark");
  assert.ok(s[0][1].start_at > h.NOW, "before the start");
  assert.equal(s[0][1].role_id, "223456789012345678");
  await h.toStart(M);
  await tick();
  assert.equal(posts.filter(([, b]) => b.kind === "starting").length, 1, "not again at the start");
  // the bridge's words
  const src = fs.readFileSync(path.join(h.repo, "discord-bot", "botBridge.js"), "utf8");
  assert.match(src, /Starting now/);
  assert.match(src, /Starting soon/);
});
