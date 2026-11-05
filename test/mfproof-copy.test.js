// 1.99ajs mfproof: the words around private activity on pads (owner report 2026-11-04 - brocklee258 hid his profile's Analytics section
// three weeks before his first bridged line; the editor only said hiding a section hides it "from visitors"):
//   * Edit profile: the Analytics section says what hiding it (or its Rooms panel) does on pads - only for a linked account, and true in
//     every switch state (privact mask, micfollow private_cover)
//   * /stage/admin: what withheld_cover / private_cover change; admins read "not shown on the mic" counts in Health
//   * /admin/bridge: the "Private-activity presence lines" card (privact.js) - no innerHTML, its own route
//   node --test test/mfproof-copy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mfproof-copy-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const ejs = require("ejs");
const EN = require(path.join(repo, "locales", "en.json"));
const PL = require(path.join(repo, "profilelayout"));
const core = require(path.join(repo, "micfollow-core"));
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

const renderEdit = (extra = {}) => ejs.renderFile(path.join(repo, "views", "editProfile.ejs"), Object.assign({
  username: "brocklee258", displayname: "brocklee258", camfrogUsername: "ritchiecuh", avatar: "", level: 3, classh: "pleb", profileCosmetics: null,
  layout: PL.sanitize(PL.DEFAULT), sections: PL.SECTIONS, subSections: PL.SUBS, privPanels: PL.PRIV, errors: [], success: [],
}, extra));
const note = (html) => { const m = html.match(/<small class="lay-pa">([^]*?)<\/small>/); return m ? m[1].replace(/\s+/g, " ").trim() : null; };

test("Edit profile: the Analytics section says what private activity does on pads - by the switches' state; only for a linked account", async () => {
  for (const k of ["settings.layout.privact", "settings.layout.privact_stage_off", "settings.layout.privact_cover", "settings.layout.privact_mask"]) assert.equal(typeof EN[k], "string", k);
  const today = note(await renderEdit());
  assert.equal(today, EN["settings.layout.privact"] + " " + EN["settings.layout.privact_stage_off"] + " " + EN["settings.layout.privact_mask"],
               "no privact local (an older caller): today's rules - left out of mic stages, presence lines 'someone'");
  assert.equal(note(await renderEdit({ privact: { mask: true, cover: false } })), today);
  const named = note(await renderEdit({ privact: { mask: false, cover: true } }));
  assert.equal(named, EN["settings.layout.privact"] + " " + EN["settings.layout.privact_cover"]);
  assert.ok(!named.includes("someone"), "unmasked: no 'someone' sentence");
  assert.equal(note(await renderEdit({ camfrogUsername: null })), null, "no linked Camfrog login: no note");
  const html = await renderEdit();
  const item = html.slice(html.indexOf('data-id="analytics"'), html.indexOf("</li>", html.indexOf('data-id="analytics"')));
  assert.ok(item.includes('class="lay-pa"'), "inside the Analytics item (where the switch is)");
  // the words are true today: the cam stays off pads (▶ Live, stage holds, mic stage), members can't clip, chat search skips the lines
  assert.match(EN["settings.layout.privact"], /your cam stays off them, members can't clip your cam or mic, and chat search skips your lines\.$/);
});

test("/stage/admin: the Mic follows help says what withheld_cover and private_cover change, and (admins) what Health's 'not shown on the mic' counts", () => {
  const file = path.join(repo, "views", "stageAdmin.ejs");
  const tpl = read("views", "stageAdmin.ejs").replace(/<%- include\([^%]*%>/g, "");
  const C = { takeover_mode: "when_idle", price_per_min: 1000, min_minutes: 5, max_minutes: 60, pad_max_minutes: 360, max_concurrent: 6, max_slots_per_room: 4,
              schedule_days: 14, schedule_per_user: 3, lead_min: 5, queue_max: 10, start_window_min: 10, idle_grace_min: 5, bookings_per_hour: 3, room_rtc_cap: 25 };
  const state = { config: C, open: [], upcoming: [], log: [], bans: [], events: [], rtmp_app: "stage -> live", relays: 0, pepe_src: { mode: "stream" } };
  const mf = (admin, cfg) => ({ cfg: { ...core.DEFAULTS, enabled: true, ...(cfg || {}) }, fields: core.FIELDS, admin, pads: [], metrics: {} });
  // (the Mic follows card's help paragraph)
  const page = (admin, cfg) => { const h = ejs.render(tpl, { user: "a", isAdmin: admin, state, mf: mf(admin, cfg) }, { filename: file }), i = h.indexOf("In a pad whose owner turned it on");
                                 return h.slice(i, h.indexOf("</p>", i)); };
  const off = page(true);
  assert.match(off, /private activity, <code>!bridge hide<\/code>\) cut within about 2 s\./, "today's sentence");
  assert.doesNotMatch(off, /While <code>withheld_cover<\/code> is on/);
  assert.match(off, /Health's "not shown on the mic" counts the people holding the mic whom the stage can't show right now, by reason \(never who\)\./);
  assert.doesNotMatch(page(false), /not shown on the mic/, "staff don't get the counts");
  const wc = page(true, { withheld_cover: true });
  assert.match(wc, /While <code>withheld_cover<\/code> is on, the cam opt-outs \([^)]*\) show the person by name with their cover picture instead of their cam; snaps and clips still leave private people out\./);
  assert.doesNotMatch(wc, /private_cover/);
  assert.match(page(true, { withheld_cover: true, private_cover: true }), /and private activity \(the profile's Analytics section or its Rooms panel hidden, <code>private_cover<\/code>\) show the person by name/);
  const js = read("public", "js", "stage-mf-admin.js");
  assert.match(js, /not shown on the mic: /);
  assert.doesNotMatch(js, /innerHTML/);
});

test("/admin/bridge: the Private-activity presence lines card - its route, admins only, no innerHTML, a confirm before naming", () => {
  const src = read("views", "admin", "bridge.ejs");
  const at = src.indexOf('id="privact"');
  assert.ok(at > 0, "the card");
  const card = src.slice(at, src.indexOf("</script>", at));
  assert.match(card, /fetch\('\/api\/admin\/privact'/);
  assert.match(card, /<% if \(!clOk\) \{ %><p class="adm-help">Site admins only\.<\/p>/);
  assert.doesNotMatch(card, /innerHTML/);
  assert.match(card, /window\.confirm\('Name private-activity people/);
  assert.match(read("index.js"), /require\("\.\/privact"\)\.register\(app, \{ addUser \}\);/);
});
