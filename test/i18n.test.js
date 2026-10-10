// Offline tests for the site's languages (i18n.js, i18n-core.js, locales/*.json - 1.99jo).
//   node --test test/i18n.test.js      (needs the repo's node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const i18n = require(path.join(repo, "i18n"));
const makeT = require(path.join(repo, "i18n-core"));
const LOC = path.join(repo, "locales");
const read = (code) => JSON.parse(fs.readFileSync(path.join(LOC, code + ".json"), "utf8"));
const EN = read("en");
const codes = i18n.LANGS.map((l) => l.code).filter((c) => c !== "en" && fs.existsSync(path.join(LOC, c + ".json")));
const holders = (v) => {
  const vals = v && typeof v === "object" ? Object.values(v) : [v];
  const out = new Set();
  for (const s of vals) for (const m of String(s).matchAll(/\{(!?\w+)\}/g)) out.add(m[1]);
  return out;
};
const tags = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort().join(",");
const strings = (v) => (v && typeof v === "object" ? Object.values(v) : [v]);

test("English is the source: every key has text, nothing unsafe for an attribute or a template", () => {
  assert.ok(Object.keys(EN).length > 60, "en.json has the strings");
  for (const [k, v] of Object.entries(EN)) {
    if (k === "_meta") continue;
    assert.match(k, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "key shape: " + k);
    for (const s of strings(v)) {
      assert.equal(typeof s, "string", k);
      assert.ok(s.length > 0, "empty: " + k);
      assert.doesNotMatch(s, /<%|%>/, "no EJS tags: " + k);
      assert.doesNotMatch(s.replace(/<[^>]*>/g, ""), /"/, "no double quotes outside tags: " + k);
      if (k.startsWith("js.")) assert.doesNotMatch(s, /<[a-z\/]|&[a-z#0-9]+;/i, "js.* strings are plain text: " + k);
    }
  }
});

test("we ship about 20 languages, each marked as machine translation", () => {
  assert.ok(codes.length >= 20, "languages: " + codes.join(","));
  for (const c of codes) {
    const cat = read(c);
    assert.ok(cat._meta && cat._meta.machine === true, c + " is marked machine:true");
  }
});

test("every catalog keeps English's placeholders, tags and plural shape; no unknown keys", () => {
  for (const c of codes) {
    const cat = read(c);
    for (const [k, v] of Object.entries(cat)) {
      if (k === "_meta") continue;
      assert.ok(k in EN, `${c}: ${k} is not an English key`);
      const en = EN[k];
      assert.equal(typeof v === "object", typeof en === "object", `${c}: ${k} plural shape`);
      const want = holders(en), got = holders(v);
      if (typeof en === "object") want.delete("count"), got.delete("count");
      assert.deepEqual([...got].sort(), [...want].sort(), `${c}: ${k} placeholders`);
      if (typeof en === "object") assert.ok(v.other != null, `${c}: ${k} has "other"`);
      for (const s of strings(v)) {
        assert.equal(typeof s, "string", `${c}: ${k}`);
        assert.doesNotMatch(s, /<%|%>/, `${c}: ${k} EJS tag`);
        assert.doesNotMatch(s.replace(/<[^>]*>/g, ""), /"/, `${c}: ${k} double quote`);
        assert.equal(tags(s), tags(strings(en)[0]), `${c}: ${k} keeps the same HTML tags`);
        if (k.startsWith("js.")) assert.doesNotMatch(s, /<[a-z\/]|&[a-z#0-9]+;/i, `${c}: ${k} plain text`);
      }
    }
  }
});

test("brand names stay as they are", () => {
  const brands = ["PATV", "PAT", "Pepe", "Camfrog", "Prime Time", "Season Pass"];
  for (const c of codes) {
    const cat = read(c);
    for (const [k, en] of Object.entries(EN)) {
      if (k === "_meta" || cat[k] == null || typeof en !== "string") continue;
      for (const b of brands) {
        if (new RegExp("(^|[^A-Za-z])" + b + "($|[^A-Za-z])").test(en)) assert.ok(String(cat[k]).includes(b), `${c}: ${k} keeps "${b}"`);
      }
    }
  }
});

test("t(): placeholders are escaped like <%= %>, {!x} is raw, plurals use CLDR, a missing key falls back to English", () => {
  const t = makeT({ a: "Hallo {name}", p: { one: "{count} Antwort", other: "{count} Antworten" }, raw: "x {!h}" },
    { a: "Hi {name}", only: "English only", p: { one: "{count} reply", other: "{count} replies" } }, "de");
  assert.equal(t("a", { name: `<b>&"'` }), "Hallo &lt;b&gt;&amp;&#34;&#39;");
  assert.equal(t("a", { name: "x" }), ejs.render("Hallo <%= n %>", { n: "x" }));
  assert.equal(t("raw", { h: "<i>ok</i>" }), "x <i>ok</i>");
  assert.equal(t("p", { count: 1 }), "1 Antwort");
  assert.equal(t("p", { count: 5 }), "5 Antworten");
  assert.equal(t("only"), "English only", "missing in German -> English");
  assert.equal(t("nope.key"), "nope.key", "missing everywhere -> the key");
  assert.equal(t("a"), "Hallo {name}", "an unfilled placeholder stays visible");
  const ru = makeT({ p: { one: "{count} ответ", few: "{count} ответа", many: "{count} ответов", other: "{count} ответа" } }, {}, "ru");
  assert.equal(ru("p", { count: 3 }), "3 ответа");
  assert.equal(ru("p", { count: 5 }), "5 ответов");
  assert.equal(makeT({}, {}, "en").num(1234567.5), (1234567.5).toLocaleString("en-US"));
});

test("a missing key in a real catalog falls back to English (tFor)", () => {
  const t = i18n.tFor(codes[0] || "en");
  assert.equal(t("test.only.in.english.never.defined"), "test.only.in.english.never.defined");
  const k = Object.keys(EN).find((x) => x !== "_meta" && typeof EN[x] === "string" && !/\{/.test(EN[x]));
  const cats = i18n.catalogs();
  const saved = cats[codes[0]] && cats[codes[0]][k];
  if (cats[codes[0]]) {
    delete cats[codes[0]][k];
    try { assert.equal(i18n.tFor(codes[0])(k), EN[k]); } finally { if (saved != null) cats[codes[0]][k] = saved; }
  }
});

test("language matching: exact codes, regional variants, Chinese scripts, old codes", () => {
  const has = (c) => !!i18n.catalogs()[c];
  assert.equal(i18n.match("en-GB"), "en");
  if (has("pt-BR")) { assert.equal(i18n.match("pt"), "pt-BR"); assert.equal(i18n.match("pt-PT"), "pt-BR"); }
  if (has("zh-TW")) { assert.equal(i18n.match("zh-HK"), "zh-TW"); assert.equal(i18n.match("zh-Hant-TW"), "zh-TW"); }
  if (has("zh-CN")) { assert.equal(i18n.match("zh"), "zh-CN"); assert.equal(i18n.match("zh-Hans"), "zh-CN"); }
  if (has("he")) assert.equal(i18n.match("iw"), "he");
  if (has("es")) assert.equal(i18n.match("ES-mx"), "es");
  assert.equal(i18n.match("xx"), null);
  assert.equal(i18n.match(""), null);
  assert.equal(i18n.match("*"), null);
});

test("negotiation order: saved preference > cookie > Accept-Language > English", () => {
  const [a, b, c] = codes;
  assert.ok(a && b && c, "needs three catalogs");
  assert.equal(i18n.negotiate({ user: a, cookie: b, accept: c }), a);
  assert.equal(i18n.negotiate({ user: null, cookie: b, accept: c }), b);
  assert.equal(i18n.negotiate({ cookie: "nonsense", accept: c }), c);
  assert.equal(i18n.negotiate({ accept: `xx;q=1, ${b};q=0.5, ${c};q=0.8` }), c, "q-values honoured");
  assert.equal(i18n.negotiate({ accept: `${b};q=0, xx` }), "en", "q=0 means not wanted");
  assert.equal(i18n.negotiate({}), "en");
  assert.deepEqual(i18n.fromAccept(`${a}, ${a}-XX;q=0.9, en;q=0.1`), [a, "en"]);
});

test("the middleware sets t / lang / dir and follows the order (user pref via cookieUserId)", async () => {
  const [a, b] = codes;
  const run = (req, uid) => {
    const res = { locals: {}, vary() { this.varied = true; } };
    req.headers = req.headers || {};
    i18n.middleware(() => uid)(req, res, () => {});
    return res;
  };
  let res = run({ headers: { "accept-language": b } });
  assert.equal(res.locals.lang, b);
  assert.equal(typeof res.locals.t, "function");
  assert.equal(res.locals.i18nT, res.locals.t);
  assert.ok(res.varied, "Vary: Accept-Language when the header decided");
  res = run({ cookies: { patv_lang: a }, headers: { "accept-language": b } });
  assert.equal(res.locals.lang, a, "cookie beats Accept-Language");
  assert.ok(!res.varied);
  // a signed-in user's saved preference (savePref keeps them in memory after the DB write) beats the cookie
  i18n._prefs.set("u-i18n-test", b);
  try {
    res = run({ cookies: { patv_lang: a }, headers: {} }, "u-i18n-test");
    assert.equal(res.locals.lang, b);
    assert.equal(res.locals.langPref, b);
  } finally { i18n._prefs.delete("u-i18n-test"); }
  res = run({ headers: {} });
  assert.equal(res.locals.lang, "en");
  assert.equal(res.locals.dir, "ltr");
});

test("RTL languages set dir=rtl on <html>; English keeps <html lang=\"en\"> exactly", async () => {
  const layout = path.join(repo, "views", "layout.ejs");
  const en = await ejs.renderFile(layout, { title: "T", ogPath: "/" });
  assert.match(en, /<html lang="en">/);
  for (const c of ["ar", "fa", "he", "ur"].filter((x) => codes.includes(x))) {
    const html = await ejs.renderFile(layout, { title: "T", ogPath: "/", i18nT: i18n.tFor(c), i18nLangs: i18n.supported(), i18nClient: (p) => i18n.clientJson(c, p) });
    assert.match(html, new RegExp(`<html lang="${c}" dir="rtl">`));
  }
  for (const c of ["de", "ja"].filter((x) => codes.includes(x))) {
    const html = await ejs.renderFile(layout, { title: "T", ogPath: "/", i18nT: i18n.tFor(c) });
    assert.match(html, new RegExp(`<html lang="${c}">`));
    assert.doesNotMatch(html, /dir="rtl"/);
  }
  assert.equal(i18n.info("ar").dir, "rtl");
  assert.equal(i18n.info("en").dir, "ltr");
});

test("the navbar is translated, keeps its structure, and the fit rules still hold for long labels", async () => {
  const layout = path.join(repo, "views", "layout.ejs");
  const c = codes.includes("de") ? "de" : codes[0];
  const t = i18n.tFor(c);
  const html = await ejs.renderFile(layout, { title: "T", ogPath: "/p/x", user: "someuser", i18nT: t });
  assert.match(html, /id="navBell"/);
  assert.match(html, /class="nav-post"[^>]*><span class="cta-ic" aria-hidden="true">✏️<\/span><span class="nav-lbl">/);
  assert.ok(html.includes(t("nav.post")) && html.includes(t("nav.golive")));
  const src = fs.readFileSync(layout, "utf8");
  assert.match(src, /\.nav-post \.nav-lbl, \.nav-golive \.nav-lbl, \.nav-signin, \.nav-more-lbl \{[^}]*max-width: 7\.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/,
    "translated CTA labels ellipsize instead of widening the bar");
  // the ellipsis rule comes BEFORE the 500px icon-only rule, so icon-only still wins on phones
  assert.ok(src.indexOf(".nav-post .nav-lbl, .nav-golive .nav-lbl, .nav-signin") < src.indexOf("@media (max-width: 500px) { .nav-golive .nav-lbl"));
});

test("pages render in other languages without errors (layout, language picker, 404, sign-in)", async () => {
  for (const c of ["es", "ar", "ja", "zh-TW"].filter((x) => codes.includes(x))) {
    const t = i18n.tFor(c);
    const base = { i18nT: t, t, i18nLangs: i18n.supported(), langPref: "auto", i18nClient: (p) => i18n.clientJson(c, p), ogPath: "/x" };
    const lang = await ejs.renderFile(path.join(repo, "views", "language.ejs"), Object.assign({ user: null, next: "/" }, base));
    assert.match(lang, new RegExp(`<html lang="${c}"`));
    assert.ok(lang.includes(t("lang.heading")));
    assert.match(lang, /href="\/lang\/es\?next=%2F"/);
    const nf = await ejs.renderFile(path.join(repo, "views", "notFound.ejs"), Object.assign({ user: null, heading: null, message: null }, base));
    assert.match(nf, /PATV_I18N = \{"lang":/);
    assert.doesNotMatch(nf, /\b(nav|foot)\.[a-z_]+\b/, "no raw keys leak");
  }
});

test("every view that uses t() starts with the shared prelude (right relative path)", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const views = walk(path.join(repo, "views")).filter((f) => f.endsWith(".ejs"));
  let n = 0;
  for (const f of views) {
    const src = fs.readFileSync(f, "utf8");
    if (!/\bt\(['"][a-z0-9_]+\./.test(src)) continue;
    n++;
    const up = path.relative(path.dirname(f), repo).split(path.sep).join("/");
    const pre = `<% const t = locals.i18nT || new Function(include('${up}/i18n-core.js'))()(JSON.parse(include('${up}/locales/en.json'))); -%>`;
    assert.ok(src.includes(pre), "prelude in " + path.relative(repo, f));
    // compiles
    ejs.compile(src, { filename: f });
  }
  assert.ok(n >= 3, "views use t()");
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "i18n-core.js"), "utf8"), /<%/, "i18n-core.js is included by EJS - no tags in it");
});

test("client strings: every __t / _t('js.x', 'default') default equals en.json (English pages ship no catalog)", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ejs|js)$/.test(e.name)) files.push(p); } };
  walk(path.join(repo, "views")); walk(path.join(repo, "public", "js"));
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b_{1,2}t\(\s*'(js\.[a-z0-9_.]+)'\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
      const def = (m[2] != null ? m[2] : m[3]).replace(/\\(['"\\])/g, "$1");
      if (/\\/.test(def)) continue;
      n++;
      assert.ok(m[1] in EN, `${path.relative(repo, f)}: ${m[1]} missing from en.json`);
      const en = EN[m[1]];
      assert.equal(typeof en === "object" ? en.other : en, def, `${path.relative(repo, f)}: ${m[1]} default differs from en.json`);
    }
  }
  assert.ok(n >= 0);
});

test("the switch routes: safe redirects only, cookie set, bad codes ignored", async () => {
  assert.equal(i18n.safeNext("/feed?x=1"), "/feed?x=1");
  assert.equal(i18n.safeNext("//evil.example"), "/");
  assert.equal(i18n.safeNext("/\\evil.example"), "/");
  assert.equal(i18n.safeNext("https://evil.example"), "/");
  assert.equal(i18n.safeNext(""), "/");
  const routes = {};
  const app = { get: (p, ...h) => { routes["GET " + p] = h[h.length - 1]; }, post: (p, ...h) => { routes["POST " + p] = h[h.length - 1]; } };
  i18n.register(app, { addUser: (q, r, n) => n(), cookieUserId: () => null });
  const res = () => ({ cookies: {}, cleared: [], cookie(k, v) { this.cookies[k] = v; }, clearCookie(k) { this.cleared.push(k); },
    redirect(code, to) { this.to = to; }, status(s) { this.s = s; return this; }, json(j) { this.j = j; }, set() {} });
  const c = codes[0];
  let r = res(); await routes["GET /lang/:code"]({ params: { code: c }, query: { next: "/feed" } }, r);
  assert.equal(r.cookies.patv_lang, c); assert.equal(r.to, "/feed");
  r = res(); await routes["GET /lang/:code"]({ params: { code: "zz" }, query: { next: "//evil" } }, r);
  assert.equal(r.cookies.patv_lang, undefined); assert.equal(r.to, "/");
  r = res(); await routes["GET /lang/:code"]({ params: { code: "auto" }, query: {} }, r);
  assert.deepEqual(r.cleared, ["patv_lang"]);
  r = res(); routes["GET /i18n/:code.json"]({ params: { code: c } }, r);
  assert.equal(r.j.lang, c);
  assert.ok(Object.keys(r.j.s).every((k) => k.startsWith("js.")));
  r = res(); await routes["POST /api/settings/language"]({ user: null, body: { lang: c }, t: i18n.tFor("en") }, r);
  assert.equal(r.s, 401);
});
