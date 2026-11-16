// banfix review (siteban.js): a ban with no pad (feed_bans room_id '') IS the site ban - no sign-in by any method, every session
// ended - so /feed/admin and the reported-DM actions say so instead of "ban from the feed", and a mistyped number of days is asked
// again instead of becoming a permanent site ban (it was parseInt('a week') || 0 = for good).
//   node --test test/siteban-admin-words.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const EN = require(path.join(repo, "locales", "en.json"));
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

test("/feed/admin calls a site-wide ban what it is now (signed out, no sign-in until it ends)", () => {
  const v = read("views/feedAdmin.ejs");
  for (const old of ["Ban from the whole feed", ": 'whole feed'", "Remove + ban author…", "Ban from the feed…", "Remove + ban sender…", "<h2>Feed bans</h2>"]) {
    assert.ok(!v.includes(old), "still says: " + old);
  }
  for (const k of ["feedadm.bans_title", "feedadm.bans_help", "feedadm.ban_site_btn", "feedadm.where_site", "feedadm.r_ban", "feedadm.u_ban", "feedadm.dm_ban"]) {
    assert.ok(v.includes(`t('${k}')`), k + " used");
    assert.ok(EN[k], k + " in en.json");
  }
  assert.match(EN["feedadm.bans_help"], /site ban: they are signed out everywhere at once and can't sign in again - by any method - until it ends/);
  for (const f of ["public/js/feed-admin.js", "public/js/dm-admin.js"]) {
    const s = read(f);
    assert.doesNotMatch(s, /from the feed/, f);
    assert.doesNotMatch(s, /parseInt\(d, 10\) \|\| 0/, f + ": a mistyped duration must not mean for good");
  }
});

/** feed-admin.js / dm-admin.js in a sandbox: a click on a ban button with scripted prompt answers -> the body it posts */
function runClick(file, attrs, answers) {
  let handler = null;
  const posted = [];
  const alerts = [];
  const queue = answers.slice();
  const el = (a) => ({ getAttribute: (k) => (k in a ? a[k] : null), querySelector: () => ({ checked: true }), disabled: false });
  const tgt = el(attrs.row);
  const btn = Object.assign(el(attrs.btn), { closest: (sel) => (/fa-rep|fa-tgt|fa-dm/.test(sel) ? tgt : null) });
  tgt.closest = () => tgt;
  const win = {
    prompt: () => (queue.length ? queue.shift() : null), alert: (m) => alerts.push(m), confirm: () => true,
  };
  const ctx = {
    window: win, alert: win.alert, location: { reload() {} },
    document: { getElementById: () => null, addEventListener: (t, f) => { if (t === "click") handler = f; }, querySelectorAll: () => [] },
    fetch: (url, o) => { posted.push({ url, body: o && o.body ? JSON.parse(o.body) : null }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); },
  };
  vm.runInNewContext(read(file), ctx);
  handler({ target: { closest: (sel) => (/data-fa|data-dmfa/.test(sel) ? btn : null) }, preventDefault() {} });
  return { posted, alerts };
}

test("the report actions' site ban: a mistyped number of days is asked again (never 'for good'); cancel sends nothing", () => {
  const rep = { row: { "data-user": "mallory", "data-post": "p1", "data-id": "p1" }, btn: { "data-fa": "r-ban" } };
  const a = runClick("public/js/feed-admin.js", rep, ["spam bounties", "a week", "3"]);
  assert.equal(a.alerts.length, 1);
  assert.equal(a.alerts[0], EN["js.feedadm.days_bad"]);
  assert.equal(a.posted.length, 1);
  assert.equal(a.posted[0].url, "/api/feed/admin/report-action");
  assert.equal(a.posted[0].body.days, 3);
  assert.equal(a.posted[0].body.action, "ban");
  const z = runClick("public/js/feed-admin.js", rep, ["spam", "0"]);
  assert.equal(z.posted[0].body.days, 0, "0 typed on purpose = for good");
  const c = runClick("public/js/feed-admin.js", rep, ["spam", "forever!!", null]);
  assert.equal(c.posted.length, 0, "cancelled: nothing sent");
  const dm = runClick("public/js/dm-admin.js", { row: { "data-user": "mallory", "data-msg": "m1" }, btn: { "data-dmfa": "ban" } }, ["reported direct message", "1 week", "7"]);
  assert.equal(dm.alerts.length, 1);
  assert.equal(dm.posted.length, 1);
  assert.equal(dm.posted[0].body.days, 7);
});
