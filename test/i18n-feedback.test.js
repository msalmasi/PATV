// Offline tests for "Suggest a better translation" (1.99kf): the runtime overlay (i18n.setOverrides), the /translate
// page + POST /translate/suggest (auth, checks, rate limit), the admins' /admin/translations (gate, accept / reject,
// export, prune) and the footer link.
//   NODE_PATH=G:/PATV/node_modules node --test test/i18n-feedback.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "i18nfb-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";

const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const i18n = require(path.join(repo, "i18n"));
const F = require(path.join(repo, "i18nfeedback"));
const C = require(path.join(repo, "i18n-check"));

const KEY = "nav.messages_unread";          // "Messages ({n} unread)"
const users = new Map();
const U = {};
let base, server;
async function mkUser(name, cls) {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, password, class) VALUES (?, ?, 'x', ?)", [id, name, cls]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb')");
  U.admin = await mkUser("boss", "Admin");
  U.staff = await mkUser("helper", "Staff");
  U.pleb = await mkUser("rando", "pleb");
  U.busy = await mkUser("busy", "pleb");
  await F.init();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const uidOf = (req) => req.get("x-test-user") || null;
  const addUser = (req, res, next) => { const u = uidOf(req); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  app.use(i18n.middleware(uidOf));
  i18n.register(app, { addUser, cookieUserId: uidOf });
  F.register(app, { addUser });
  app.get("/somepage", addUser, (req, res) => res.render("language", { user: req.user ? req.user.username : null, next: "/", saved: null }));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

const hdr = (who, lang, extra) => Object.assign({ "accept-language": lang || "es" }, who ? { "x-test-user": who.userId } : {}, extra || {});
async function page(url, who, lang) {
  const r = await fetch(base + url, { redirect: "manual", headers: hdr(who, lang) });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
}
async function form(url, who, fields, extra) {
  const r = await fetch(base + url, { method: "POST", redirect: "manual", headers: hdr(who, "es", Object.assign({ "content-type": "application/x-www-form-urlencoded" }, extra)),
    body: new URLSearchParams(fields).toString() });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
}
async function api(url, who, body) {
  const r = await fetch(base + url, { method: "POST", headers: hdr(who, "es", { "content-type": "application/json", "x-requested-with": "fetch" }), body: JSON.stringify(body || {}) });
  return { status: r.status, j: await r.json() };
}

test("overlay: overrides replace a catalog string at runtime; invalid or unknown ones are ignored; English never", () => {
  const es = i18n.catalogs().es;
  const before = i18n.tFor("es")(KEY, { n: 3 });
  assert.equal(i18n.setOverrides({ es: { [KEY]: "Mensajitos ({n})", "nav.feed": "Muro {extra}", "no.such.key": "x" }, en: { [KEY]: "nope" } }), 1);
  assert.equal(i18n.tFor("es")(KEY, { n: 3 }), "Mensajitos (3)");
  assert.equal(i18n.tFor("es")("nav.feed"), es["nav.feed"], "a placeholder English doesn't have -> refused");
  assert.equal(i18n.tFor("en")(KEY, { n: 3 }), "Messages (3 unread)", "English is never overridden");
  assert.equal(i18n.catalogs().es[KEY], es[KEY], "the catalog itself is untouched");
  const js = Object.keys(i18n.catalogs().en).find((k) => k.startsWith("js.") && !/\{/.test(i18n.catalogs().en[k]));
  i18n.setOverrides({ es: { [js]: "Texto nuevo" } });
  assert.equal(i18n.clientStrings("es")[js], "Texto nuevo", "client strings see overrides too");
  assert.equal(i18n.setOverrides({ es: { [js]: "<b>x</b>" } }), 0, "js.* stays plain text");
  i18n.setOverrides({});
  assert.equal(i18n.tFor("es")(KEY, { n: 3 }), before);
});

test("the middleware remembers which strings a signed-in user's last page used (not English, not anonymous)", async () => {
  await page("/somepage", U.pleb, "es");
  const r = i18n.recentPage(U.pleb.userId);
  assert.ok(r && r.path === "/somepage");
  assert.ok(r.keys.includes("lang.heading") && r.keys.includes("nav.feed"), "page + navbar keys");
  await page("/somepage", U.staff, "en");
  assert.equal(i18n.recentPage(U.staff.userId), null, "English pages aren't tracked");
  const t = await page("/translate", U.pleb, "es");
  assert.equal(t.status, 200);
  assert.match(t.html, /id="k-lang\.heading"/, "the page's strings are offered");
  assert.ok(t.html.indexOf('id="k-lang.heading"') < t.html.indexOf('id="k-nav.feed"'), "the page's own strings before the navbar");
  assert.equal(i18n.recentPage(U.pleb.userId).path, "/somepage", "/translate itself isn't recorded");
});

test("/translate: English visitors are told to switch; search finds by English and by translation; signed-out see no form", async () => {
  let r = await page("/translate", U.pleb, "en");
  assert.equal(r.status, 200);
  assert.ok(r.html.includes(i18n.tFor("en")("translate.en_only")));
  assert.doesNotMatch(r.html, /action="\/translate\/suggest"/);
  r = await page("/translate?q=" + encodeURIComponent("unread"), U.pleb, "es");
  assert.match(r.html, new RegExp('id="k-' + KEY.replace(/\./g, "\\.") + '"'));
  assert.match(r.html, /action="\/translate\/suggest"/);
  const es = i18n.catalogs().es["nav.feed"];
  r = await page("/translate?q=" + encodeURIComponent(es), U.pleb, "es");
  assert.match(r.html, /id="k-nav\.feed"/, "search by the current translation");
  r = await page("/translate?q=unread", null, "es");
  assert.doesNotMatch(r.html, /action="\/translate\/suggest"/, "signed out: no form");
  assert.match(r.html, /href="\/login\?next=%2Ftranslate"/);
});

test("POST /translate/suggest: sign-in, same-site, the checks, one pending per user+string, rate limit", async () => {
  let r = await form("/translate/suggest", null, { lang: "es", key: KEY, text: "Mensajes ({n})" });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/login\?next=/);
  r = await api("/translate/suggest", null, { lang: "es", key: KEY, text: "x {n}" });
  assert.equal(r.status, 401);
  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: "Mensajes ({n})" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);

  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: "Mensajes sin {n}" .replace("{n}", "leer"), note: "<img src=x onerror=alert(1)>" });
  assert.equal(r.status, 400, "placeholder dropped");
  assert.ok(r.html.includes(i18n.tFor("es")("translate.err.invalid")));
  assert.match(r.html, /placeholders/);
  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: i18n.catalogs().es[KEY] });
  assert.equal(r.status, 400, "same as now");
  r = await form("/translate/suggest", U.pleb, { lang: "en", key: KEY, text: "Messages {n}" });
  assert.equal(r.status, 400, "not for English");
  r = await form("/translate/suggest", U.pleb, { lang: "es", key: "nope.nope", text: "x" });
  assert.equal(r.status, 400);
  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: 'Mensajes <b onclick="x()">({n})</b>' });
  assert.equal(r.status, 400, "markup English doesn't have");

  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: "Mensajes: {n} sin leer", note: "<img src=x onerror=alert(1)>", page: "/feed" });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/translate\?key=nav\.messages_unread&sent=nav\.messages_unread#k-/);
  const ok = await page(r.location.split("#")[0], U.pleb, "es");
  assert.ok(ok.html.includes(i18n.tFor("es")("translate.sent")));
  r = await form("/translate/suggest", U.pleb, { lang: "es", key: KEY, text: "Mensajes: {n} nuevos" });
  assert.equal(r.status, 303);
  let rows = await getQuery("SELECT * FROM translation_suggestions WHERE userId = ?", [U.pleb.userId]);
  assert.equal(rows.length, 1, "a second suggestion for the same string updates the pending one");
  assert.equal(JSON.parse(rows[0].value_json), "Mensajes: {n} nuevos");
  assert.equal(rows[0].src_hash, C.hash(i18n.catalogs().en[KEY]));

  // plural keys take one field per CLDR category
  const pk = Object.keys(i18n.catalogs().en).find((k) => typeof i18n.catalogs().en[k] === "object" && !k.startsWith("js."));
  r = await api("/translate/suggest", U.pleb, { lang: "es", key: pk, text_one: "{count} uno", text_other: "{count} varios" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await api("/translate/suggest", U.pleb, { lang: "es", key: pk, text_one: "{count} uno", text_other: "{count} muchos" });
  assert.equal(r.status, 200, "an update of my pending one");

  // rate limit: 20 an hour
  for (let i = 0; i < F.LIMIT_HOUR; i++) {
    await runQuery("INSERT INTO translation_suggestions (lang, key, userId, value_json, src_hash, status, created_at) VALUES ('es', ?, ?, '\"x\"', 'h', 'rejected', ?)",
      ["k" + i, U.busy.userId, Date.now() - 1000]);
  }
  r = await api("/translate/suggest", U.busy, { lang: "es", key: KEY, text: "Mensajes: {n}" });
  assert.equal(r.status, 429);
  assert.equal(r.j.code, "rate");
});

test("/admin/translations: Admins only; suggestions printed escaped; accept -> live override; reject; export; prune", async () => {
  let r = await page("/admin/translations", null);
  assert.equal(r.status, 302); assert.equal(r.location, "/login");
  for (const who of [U.pleb, U.staff]) { r = await page("/admin/translations", who); assert.equal(r.status, 403); }
  r = await page("/admin/translations", U.admin, "en");
  assert.equal(r.status, 200);
  for (const id of ["pending", "overrides", "export", "sugRows", "pruneBtn"]) assert.ok(r.html.includes('id="' + id + '"'), "#" + id);
  assert.match(r.html, /class="adm-side"/);
  assert.match(r.html, /href="\/admin\/translations" aria-current="page"/);
  assert.ok(r.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the note is escaped");
  assert.doesNotMatch(r.html, /<img src=x onerror/);

  const sug = (await getQuery("SELECT id FROM translation_suggestions WHERE userId = ? AND key = ?", [U.pleb.userId, KEY]))[0];
  let a = await api(`/api/admin/translations/${sug.id}/accept`, U.staff, {});
  assert.equal(a.status, 403, "staff can't accept");
  a = await api(`/api/admin/translations/${sug.id}/accept`, U.admin, { value: "Mensajes <i>{n}</i>" });
  assert.equal(a.status, 400, "an edited value is checked too");
  a = await api(`/api/admin/translations/${sug.id}/accept`, U.admin, { value: "Mensajes ({n} nuevos)" });
  assert.equal(a.status, 200, JSON.stringify(a.j));
  assert.equal(i18n.tFor("es")(KEY, { n: 4 }), "Mensajes (4 nuevos)", "live at once");
  a = await api(`/api/admin/translations/${sug.id}/accept`, U.admin, {});
  assert.equal(a.status, 409, "already accepted");
  r = await page("/translate?key=" + KEY, U.pleb, "es");
  assert.ok(r.html.includes(i18n.tFor("es")("translate.improved")));

  const pk = (await getQuery("SELECT id FROM translation_suggestions WHERE userId = ? AND key <> ? AND status = 'pending'", [U.pleb.userId, KEY]))[0];
  a = await api(`/api/admin/translations/${pk.id}/reject`, U.admin);
  assert.equal(a.status, 200);
  assert.equal((await getQuery("SELECT status FROM translation_suggestions WHERE id = ?", [pk.id]))[0].status, "rejected");

  const ex = await fetch(base + "/admin/translations/export.json", { headers: hdr(U.admin, "en") });
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get("content-disposition"), /attachment; filename="translation-overrides-/);
  const data = await ex.json();
  assert.deepEqual(data.overrides.map((o) => [o.lang, o.key, o.value]), [["es", KEY, "Mensajes ({n} nuevos)"]]);
  assert.equal(data.overrides[0].src_hash, C.hash(i18n.catalogs().en[KEY]));
  assert.equal((await fetch(base + "/admin/translations/export.json", { headers: hdr(U.pleb) })).status, 403);

  // after a fold is deployed the catalog has the same text: prune clears it
  const es = i18n.catalogs().es, old = es[KEY];
  a = await api("/api/admin/translations/prune", U.admin);
  assert.equal(a.j.removed, 0, "not in the catalog yet");
  es[KEY] = "Mensajes ({n} nuevos)";
  try {
    a = await api("/api/admin/translations/prune", U.admin);
    assert.equal(a.j.removed, 1);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM translation_overrides"))[0].n, 0);
  } finally { es[KEY] = old; await F.reload(); }

  // remove an override
  await runQuery("INSERT INTO translation_overrides (lang, key, value_json, src_hash, updated_at) VALUES ('es', ?, ?, ?, 1)",
    [KEY, JSON.stringify("Mensajes [{n}]"), C.hash(i18n.catalogs().en[KEY])]);
  await F.reload();
  assert.equal(i18n.tFor("es")(KEY, { n: 1 }), "Mensajes [1]");
  a = await api("/api/admin/translations/override/delete", U.admin, { lang: "es", key: KEY });
  assert.equal(a.status, 200);
  assert.equal(i18n.tFor("es")(KEY, { n: 1 }), i18n.catalogs().es[KEY].replace("{n}", "1"));
  // a stale override (English changed since) is not applied
  await runQuery("INSERT INTO translation_overrides (lang, key, value_json, src_hash, updated_at) VALUES ('es', ?, ?, 'oldhash', 1)", [KEY, JSON.stringify("Viejo {n}")]);
  await F.reload();
  assert.notEqual(i18n.tFor("es")(KEY, { n: 1 }), "Viejo 1");
  r = await page("/admin/translations", U.admin, "en");
  assert.match(r.html, />stale</);
});

test("footer: the suggest link shows only when the page isn't in English", async () => {
  const layout = path.join(repo, "views", "layout.ejs");
  const en = await ejs.renderFile(layout, { title: "T", ogPath: "/" });
  assert.doesNotMatch(en, /href="\/translate"/);
  const es = await ejs.renderFile(layout, { title: "T", ogPath: "/", i18nT: i18n.tFor("es"), i18nLangs: i18n.supported() });
  assert.match(es, /href="\/translate" class="site-lang-suggest"/);
  assert.ok(es.includes(i18n.tFor("es")("foot.suggest_translation")));
});
