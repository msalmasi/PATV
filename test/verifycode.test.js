// 1.99?? quick1: "when a user verifies their camfrog login, the verify code is at the top of the page but theres no automatic
// scroll up so they might miss it coming up." The link form is in Connections, further down; issuing a code redirected to
// /settings/account#connections, so the page opened scrolled PAST the code box at the top.
//   * user.controller.updateCamfrogUsername: a code issued (also the "linked to another account" warning) comes back to
//     /settings/account#cf-verify - the box at the top, even with scripts off; unlink / already linked / errors keep #connections
//   * partials/account-flash.ejs (Settings -> Account and Edit profile): the box is focusable (id cf-verify, tabindex -1, a
//     labelled region), its script brings it into view - smooth, or instant with prefers-reduced-motion - moves focus to it
//     without a second jump, and fills a polite live region with the code once; nothing happens without a code
//   * a pad's Camfrog room code (partials/pad-connect.ejs + public/js/pad-connect.js): after "Get a code" the page reloads to
//     #pcnCamfrog for real (a hash-only change used to be no navigation), the code is brought into view, focused and read out;
//     the join box missing (Prime Time Plus rooms) no longer throws before the request
//   node --test test/verifycode.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const sqlite3 = require("sqlite3");
const ejs = require("ejs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verifycode-test-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

// ── a tiny DOM: just what the two scripts touch ──
function el(id, attrs = {}) {
  const e = { id, attrs: Object.assign({}, attrs), textContent: "", calls: [], listeners: {}, elements: {},
              getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
              getBoundingClientRect() { return this.rect || { top: 900, bottom: 1100 }; },
              scrollIntoView(o) { this.calls.push(["scroll", o === undefined ? o : JSON.parse(JSON.stringify(o))]); },   // outer-realm copies
              focus(o) { this.calls.push(["focus", o === undefined ? o : JSON.parse(JSON.stringify(o))]); if (this.doc) this.doc.activeElement = this; },
              addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } };
  return e;
}
function runIn(src, { els, reduce = false, readyState = "complete", hash = "", search = "", fetchOk = true }) {
  const winL = {}, docL = {}, timers = [];
  const loc = { hash, search, pathname: "/p/nightroom/settings", href: "", reloaded: 0, reload() { this.reloaded += 1; } };
  const hist = { scrollRestoration: "auto", replaced: null, replaceState(a, b, u) { this.replaced = u; } };
  const sandbox = {
    document: { readyState, getElementById: (id) => els[id] || null, addEventListener: (t, f) => { docL[t] = f; }, documentElement: { clientHeight: 700 } },
    window: { innerHeight: 700, matchMedia: (q) => ({ matches: reduce && /reduce/.test(q) }), addEventListener: (t, f) => { winL[t] = f; } },
    location: loc, history: hist, setTimeout: (f) => { timers.push(f); return 1; }, alert() {},
    fetch: async () => ({ ok: fetchOk, status: 200, json: async () => ({ ok: true }) }),
  };
  sandbox.window.matchMedia = sandbox.window.matchMedia.bind(sandbox.window);
  sandbox.document.body = { tag: "body" };
  sandbox.document.activeElement = sandbox.document.body;
  for (const e of Object.values(els)) e.doc = sandbox.document;
  vm.runInNewContext(src, sandbox);
  return { winL, docL, timers, loc, hist, doc: sandbox.document, flush: () => { while (timers.length) timers.shift()(); } };
}
const scriptAfter = (html, marker) => {
  const i = html.indexOf(marker);
  const s = html.indexOf("<script>", i), e = html.indexOf("</script>", s);
  return i < 0 || s < 0 ? null : html.slice(s + 8, e);
};

const ACC = { username: "lav", displayname: "Lav", email: "l@example.test", camfrogUsername: "", twitchDisplayname: null, discordUsername: null,
              errors: [], success: [], plex: null, plexLink: false, telegram: { linked: false, handle: null, signin: false }, google: null, cryptoW: null, plexPin: null,
              user: "lav" };
const CODE_MSG = 'Verify ownership of "LavCF" to complete the link. !verify A1B2C3';

test("issuing a code points the address at the code box (#cf-verify, the top of the page) - not #connections; the other answers keep #connections", async () => {
  await built;
  const { runQuery } = require(path.join(repo, "dbUtils"));
  const UC = require(path.join(repo, "user.controller"));
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, level) VALUES ('3001', 'lav', 'lav', 'x', 'pleb', 1)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, level, camfrogUsername) VALUES ('3002', 'oth', 'oth', 'x', 'pleb', 1, 'takencf')");
  const call = async (userId, username, name) => {
    const fl = [];
    let went = null;
    await UC.updateCamfrogUsername({ body: { camfrogUsername: name }, user: { userId, username }, flash: (k, v) => fl.push([k, v]) }, { redirect(u) { went = u; } });
    return { went, fl };
  };
  const a = await call("3001", "lav", "LavCF");
  assert.equal(a.went, "/settings/account#cf-verify", "a new code: the address points at the code box (top of the page)");
  assert.match(a.fl[0][1], /!verify [0-9A-F]{6}$/);
  const w = await call("3001", "lav", "TakenCF");
  assert.equal(w.went, "/settings/account#cf-verify", "the 'linked to another account' warning carries the code too");
  assert.equal(w.fl[0][0], "error");
  assert.match(w.fl[0][1], /^Warning: .* !verify [0-9A-F]{6}$/);
  assert.equal((await call("3002", "oth", "takencf")).went, "/settings/account#connections", "already linked: #connections");
  assert.equal((await call("3002", "oth", "")).went, "/settings/account#connections", "unlinked: #connections");
});

test("the code box: focusable, labelled, a live region with the code - on Settings -> Account and on Edit profile", async () => {
  const ac = await ejs.renderFile(path.join(repo, "views", "settingsAccount.ejs"), Object.assign({}, ACC, { success: [CODE_MSG] }));
  assert.match(ac, /<div class="verify-box" id="cf-verify" tabindex="-1" role="region" aria-labelledby="cfVerifyH">/);
  assert.match(ac, /<div class="verify-header" id="cfVerifyH">⚠ Verify Your Camfrog Username<\/div>/);
  assert.match(ac, /class="verify-code">A1B2C3</);
  assert.match(ac, /<p class="verify-sr" id="cfVerifyLive" role="status" aria-live="polite" data-say="Your Camfrog verification code is A1B2C3\. Type !verify A1B2C3 in a Camfrog room with Pepe within 15 minutes\."><\/p>/);
  assert.ok(ac.indexOf('id="cf-verify"') < ac.indexOf('id="connections"'), "the box is above Connections (why the page must come back up)");
  const ed = await ejs.renderFile(path.join(repo, "views", "editProfile.ejs"), { username: "lav", displayname: "Lav", camfrogUsername: "", avatar: "", level: 3, classh: "pleb",
    profileCosmetics: null, layout: null, sections: [], subSections: {}, privPanels: [], errors: [], success: [CODE_MSG] });
  assert.match(ed, /id="cf-verify" tabindex="-1"/);
  const none = await ejs.renderFile(path.join(repo, "views", "settingsAccount.ejs"), Object.assign({}, ACC, { success: ["Camfrog username unlinked."] }));
  assert.doesNotMatch(none, /cf-verify/, "no code, no box, no script");
  assert.match(fs.readFileSync(path.join(repo, "views", "partials", "account-css.ejs"), "utf8"), /\.verify-box \{ scroll-margin-top: 16px;/);
  if (process.env.VERIFY_SHOTS) fs.writeFileSync(path.join(process.env.VERIFY_SHOTS, "settings-account-code.html"), ac);
});

test("its script: into view (smooth / instant with reduced motion), focus without a second jump, the code read out once", async () => {
  const ac = await ejs.renderFile(path.join(repo, "views", "settingsAccount.ejs"), Object.assign({}, ACC, { success: [CODE_MSG] }));
  const src = scriptAfter(ac, 'id="cfVerifyLive"');
  assert.ok(src && /scrollIntoView/.test(src));
  const mk = () => ({ "cf-verify": el("cf-verify"), cfVerifyLive: el("cfVerifyLive", { "data-say": "Your code is A1B2C3" }) });
  let els = mk();
  let r = runIn(src, { els });
  assert.deepEqual(els["cf-verify"].calls, [["scroll", { behavior: "smooth", block: "center" }], ["focus", { preventScroll: true }]]);
  assert.equal(els.cfVerifyLive.textContent, "", "announced a moment later (a live region must change after it's in the page)");
  r.flush();
  assert.equal(els.cfVerifyLive.textContent, "Your code is A1B2C3");
  r.winL.load();
  r.flush();
  assert.equal(els["cf-verify"].calls.filter((c) => c[0] === "focus").length, 1, "focus is still the box's: the load check doesn't move it again");
  // an address with another #hash: the browser's own jump lands after load and drops focus - the load check brings both back
  els = mk();
  r = runIn(src, { els, hash: "#connections" });
  r.doc.activeElement = r.doc.body;
  els["cf-verify"].calls.length = 0;
  r.winL.load();
  r.flush();
  assert.deepEqual(els["cf-verify"].calls, [["scroll", { behavior: "auto", block: "center" }], ["focus", { preventScroll: true }]],
                   "after load: instant (a late smooth scroll is cut short by the browser's own jump)");
  els = mk();
  runIn(src, { els, reduce: true });
  assert.deepEqual(els["cf-verify"].calls[0], ["scroll", { behavior: "auto", block: "center" }], "reduced motion: no smooth scroll");
  els = mk();
  els["cf-verify"].rect = { top: 120, bottom: 400 };
  runIn(src, { els });
  assert.deepEqual(els["cf-verify"].calls, [["focus", { preventScroll: true }]], "already on screen: just focus");
  els = mk();
  r = runIn(src, { els, readyState: "loading" });
  assert.equal(els["cf-verify"].calls.length, 0);
  r.docL.DOMContentLoaded();
  assert.equal(els["cf-verify"].calls.length, 2, "a page still loading: as soon as the DOM is there");
});

test("a pad's room code: shown focusable with a live region; after 'Get a code' the page really reloads to it and reveals it", async () => {
  const view = fs.readFileSync(path.join(repo, "views", "partials", "pad-connect.ejs"), "utf8");
  assert.match(view, /<p class="pcn-code" id="pcnCodeBox" tabindex="-1"><code id="pcnCode"><%= CF_\.code %><\/code>/);
  assert.match(view, /id="pcnCodeLive" role="status" aria-live="polite" data-say="<%- t\('pad\.conn\.code_announce', \{ code: CF_\.code \}\) %>"/);
  assert.match(view, /pad-connect\.js\?v=2/, "cache-buster moved with the script");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["pad.conn.code_announce"], "Your room verification code is {code}. Put it in the room's topic, or type !verifypad {code} in the room.");
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-connect.js"), "utf8");
  const card = () => {
    const c = el("connections", { "data-base": "/api/rooms/nightroom" });
    return c;
  };
  // the page with the new code, at #pcnCamfrog: into view, focus, read out
  let els = { connections: card(), pcnCodeBox: el("pcnCodeBox"), pcnCodeLive: el("pcnCodeLive", { "data-say": "Your room verification code is PATV-ABC123." }) };
  let r = runIn(js, { els, hash: "#pcnCamfrog", search: "?tab=address" });
  assert.deepEqual(els.pcnCodeBox.calls, [["scroll", { behavior: "smooth", block: "center" }], ["focus", { preventScroll: true }]]);
  r.flush();
  assert.equal(els.pcnCodeLive.textContent, "Your room verification code is PATV-ABC123.");
  els = { connections: card(), pcnCodeBox: el("pcnCodeBox"), pcnCodeLive: el("pcnCodeLive", { "data-say": "x" }) };
  runIn(js, { els, hash: "#pcnCamfrog", reduce: true });
  assert.deepEqual(els.pcnCodeBox.calls[0], ["scroll", { behavior: "auto", block: "center" }]);
  els = { connections: card(), pcnCodeBox: el("pcnCodeBox"), pcnCodeLive: el("pcnCodeLive") };
  runIn(js, { els, hash: "#connections" });
  assert.equal(els.pcnCodeBox.calls.length, 0, "any other visit: the page isn't moved");
  // "Get a code" on a page already at ?tab=address: a real reload to #pcnCamfrog (a hash-only change is no navigation);
  // a Prime Time Plus room's form has no join box - that no longer throws before the request
  const form = el("pcnCfForm");
  form.elements = { room: { value: "Night.Room" } };
  els = { connections: card(), pcnCfForm: form, pcnCfMsg: el("pcnCfMsg") };
  els.pcnCfMsg.style = {};
  r = runIn(js, { els, search: "?tab=address" });
  form.listeners.submit[0]({ preventDefault() {} });
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.hist.replaced, "/p/nightroom/settings?tab=address#pcnCamfrog");
  assert.equal(r.hist.scrollRestoration, "manual");
  assert.equal(r.loc.reloaded, 1);
  // from another address (no ?tab=address yet): a plain navigation
  els = { connections: card(), pcnCfForm: form, pcnCfMsg: el("pcnCfMsg") };
  els.pcnCfMsg.style = {};
  form.listeners = {};
  r = runIn(js, { els, search: "" });
  form.listeners.submit[0]({ preventDefault() {} });
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.loc.href, "/p/nightroom/settings?tab=address#pcnCamfrog");
  assert.equal(r.loc.reloaded, 0);
});
