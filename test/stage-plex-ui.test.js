// 1.99jn: the Go-live page's "📼 Play from Plex" choice (views/stageBook.ejs + public/js/stage-plex.js): shown to Plex
// users and admins with the price, locked with a hint for everyone else, absent when it's closed; the slot owner's
// library controls; the rights notice; the admin settings.
//   node --test test/stage-plex-ui.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const PAD = "plant_based_chatting";
const base = {
  user: "u", me: { userId: "u1", points_balance: 500000 }, rooms: [{ id: PAD, slug: PAD, title: "Houseplants", slot_price: 0, slot_count: 1 }], pick: PAD,
  C: { price_per_min: 0, min_minutes: 2, max_minutes: 30, lead_min: 5, schedule_days: 14, enabled: true, max_concurrent: 6, idle_grace_min: 5 },
  rtmpServer: "rtmp://example/stage", balance: 0, twitchUrl: null, staff: false,
};
const render = (plex) => ejs.renderFile(path.join(repo, "views", "stageBook.ejs"), { ...base, ...(plex === undefined ? {} : { plex }) });
const PLEX = { show: true, ok: true, free: false, how: "invite", why: null, message: null, hint: null, price_per_hour: 100000, daily_cap: 3, quality: 720, pause_max_min: 30 };

test("no Plex info (signed out / closed): no 📼 choice, no panel, no script", async () => {
  for (const p of [undefined, null, { ...PLEX, show: false, ok: false, why: "off" }]) {
    const html = await render(p);
    assert.doesNotMatch(html, /value="plex"/);
    assert.doesNotMatch(html, /id="plexPanel"|id="plexNow"|stage-plex\.js/);
    assert.match(html, /value="embed"/, "the other two ways are still there");
  }
});

test("a Plex user: the third choice with the price, the search panel + rights notice, the slot owner's controls", async () => {
  const html = await render(PLEX);
  assert.match(html, /<label class=""[^>]*><input type="radio" name="mode" value="plex"> <span><b>📼 Play from Plex<\/b><small>100,000 PAT \/ started hour<\/small>/);
  assert.match(html, /id="plexPanel" data-free="0" data-member="0" data-per-hour="100000" data-quality="720"/);
  assert.match(html, /Only show what we have the rights to show/);
  assert.match(html, /id="plexSearch"/);
  assert.match(html, /comes straight back if the stream never gets on the stage/);
  assert.match(html, /Half goes to the pad’s room vault, half to Fort Knox/);
  assert.match(html, /up to 3 paid plays a day/);
  assert.match(html, /Plex members play free: <a href="\/subscriptions">/, "1.99jp: how to play free (1.99jr: /subscriptions)");
  assert.match(html, /id="plexNow"/, "pause / seek / stop live in Your slot");
  assert.match(html, /stage-plex\.js\?v=2/);
  assert.match(html, /stage\.css\?v=7/);
  // the ordinary booking fields step aside in 📼 mode
  for (const id of ["kindSet", "whenSet", "bookBtn"]) assert.match(html, new RegExp('class="[^"]*\\bnp\\b[^"]*" id="' + id + '"|id="' + id + '"[^>]*class="[^"]*\\bnp\\b'), id + " is .np");
  assert.doesNotMatch(html, /id="plexLocked"/);
  // the search panel isn't inside the booking form (no nested forms)
  const formEnd = html.indexOf("</form>", html.indexOf('id="bookForm"'));
  assert.ok(html.indexOf('id="plexPanel"') > formEnd);
});

test("an admin: free", async () => {
  const html = await render({ ...PLEX, free: true, how: "admin", price_per_hour: 0 });
  assert.match(html, /📼 Play from Plex<\/b><small>a movie or an episode · free for you<\/small>/);
  assert.match(html, /data-free="1"/);
  assert.match(html, /Free for site admins\./);
});

test("1.99jp: a Plex member plays free with their own daily cap", async () => {
  const html = await render({ ...PLEX, free: true, member: true, how: "plex", price_per_hour: 0, daily_cap: 5 });
  assert.match(html, /📼 Play from Plex<\/b><small>a movie or an episode · free for Plex members<\/small>/);
  assert.match(html, /data-free="1" data-member="1"/);
  assert.match(html, /Free for you as a Plex member, up to 5 plays a day\./);
  assert.doesNotMatch(html, /Plex members play free:/);
});

test("an admin while it's switched off: the choice is shown disabled with the reason", async () => {
  const html = await render({ ...PLEX, ok: false, free: true, how: "admin", why: "off", message: "Play from library is switched off (/admin/media)." });
  assert.match(html, /<label class="locked"[^>]*><input type="radio" name="mode" value="plex" disabled>/);
  assert.match(html, /🔒 switched off right now/);
  assert.match(html, /id="plexLocked"[^>]*>🔒 <b>📼 Play from Plex<\/b> puts a movie.*switched off \(\/admin\/media\)/s);
  assert.doesNotMatch(html, /id="plexPanel"/, "no search");
});

test("1.99jp: the Plex texts are translated (German render has no English Plex strings)", async () => {
  const i18n = require(path.join(repo, "i18n"));
  const t = i18n.tFor("de");
  const html = await ejs.renderFile(path.join(repo, "views", "stageBook.ejs"), { ...base, plex: PLEX, i18nT: t, t });
  assert.ok(html.includes(t("stage.px.choice")));
  assert.ok(html.includes(t("stage.px.search")));
  assert.doesNotMatch(html, /Search Plex: a movie|Only show what we have the rights|started hour of what/);
});

test("the scripts: stage-plex.js parses, confirms the price, re-asks when the server's price differs; stage-book.js hands library slots over", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "stage-plex.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(js, { filename: "stage-plex.js" }));
  assert.match(js, /\/api\/medialib\/play/);
  assert.match(js, /body\.price = price/);
  assert.match(js, /e\.data\.price/);
  assert.match(js, /Only show what we have the rights to show/);
  for (const a of ["pause", "resume", "seek", "stop"]) assert.ok(js.includes("/api/medialib/" + a), a);
  assert.match(js, /patv:slot/);
  const book = fs.readFileSync(path.join(repo, "public", "js", "stage-book.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(book, { filename: "stage-book.js" }));
  assert.match(book, /show\('streamPanes', !embed && !lib\)/);
  assert.match(book, /slot\.library \? post\('\/api\/medialib\/stop'/);
  assert.match(book, /if \(mode === 'plex'\) return;/);
});

test("/admin/media has the Plex-user switch, the price, the daily cap and the override list", () => {
  const src = fs.readFileSync(path.join(repo, "views", "mediaAdmin.ejs"), "utf8");
  assert.match(src, /name="_bools" value="library_enabled,library_plex,/);
  for (const n of ["library_plex", "library_price", "library_daily_cap", "library_users"]) assert.match(src, new RegExp('name="' + n + '"'));
});
