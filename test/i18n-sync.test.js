// Offline tests for the automatic localization (1.99kf): tools/i18n-sync.js with a mocked model, i18n-check.js,
// tools/i18n-overrides.js fold, and the repo's own state/glossary files.
//   NODE_PATH=G:/PATV/node_modules node --test test/i18n-sync.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const S = require(path.join(repo, "tools", "i18n-sync"));
const O = require(path.join(repo, "tools", "i18n-overrides"));
const P = require(path.join(repo, "tools", "i18n-providers"));
const C = require(path.join(repo, "i18n-check"));

const EN = {
  _meta: { language: "English", machine: false, source: true },
  "a.hello": "Hello {name}",
  "a.bold": "Get <b>{n} PAT</b> now",
  "a.plain": "Settings",
  "a.count": { one: "{count} reply", other: "{count} replies" },
  "a.locked": "Locked text",
  "js.a.msg": "Saved",
};
const XX = {
  _meta: { language: "Testish", machine: true, source: "en" },
  "a.hello": "Hallo {name}",
  "a.plain": "Einstellungen",
  "a.locked": "Gesperrt",
  "a.gone": "Nicht mehr da",
};

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i18nsync-"));
  fs.mkdirSync(path.join(root, "locales"));
  fs.writeFileSync(path.join(root, "locales", "en.json"), JSON.stringify(EN, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "locales", "de.json"), JSON.stringify(XX, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "locales", "glossary.json"), JSON.stringify({ keep: ["PAT"], rules: [], terms: { settings: { from: "a.plain" } }, style: { de: "du" } }));
  return root;
}
const read = (root, f) => JSON.parse(fs.readFileSync(path.join(root, "locales", f), "utf8"));

/** A fake model: answers each key it is asked about with answer(key, en, attempt). Records the prompts. */
function mock(answer) {
  const calls = [];
  const seen = {};
  return {
    name: "mock", model: "mock-1", calls,
    async complete({ system, prompt }) {
      calls.push({ system, prompt });
      const req = JSON.parse(prompt.slice(prompt.indexOf("{")));
      const out = {};
      for (const [k, s] of Object.entries(req.translate_these)) { seen[k] = (seen[k] || 0) + 1; out[k] = answer(k, s.en, seen[k], s); }
      return { text: "```json\n" + JSON.stringify(out) + "\n```", truncated: false };
    },
  };
}
const good = (k, en) => (typeof en === "object" ? { one: "{count} Antwort", other: "{count} Antworten" } : "DE:" + en);

test("i18n-check: the rules (placeholders, exact markup, plural shape, quotes, js.* plain, brands)", () => {
  assert.deepEqual(C.check("a.hello", "Hello {name}", "Hallo {name}"), []);
  assert.match(C.check("a.hello", "Hello {name}", "Hallo").join(), /placeholders/);
  assert.match(C.check("a.b", "Get <b>it</b>", "Hol <i>es</i>").join(), /tags differ/);
  assert.match(C.check("a.b", "Get <b>it</b>", 'Hol <b onmouseover="x()">es</b>').join(), /attributes differ/);
  assert.match(C.check("a.b", "Get it", "Hol <script>es").join(), /tags differ/);
  assert.match(C.check("a.b", "Get it", "Hol 1 < 2").join(), /stray/);
  assert.match(C.check("a.b", "Get it", "Hol 1 < 2 >").join(), /attributes differ/);
  assert.match(C.check("a.b", "Get it", "Hol &bogus es").join(), /entity/);
  assert.deepEqual(C.check("a.b", "Mods & admins", "Mods & Admins &amp; mehr"), []);
  assert.match(C.check("a.b", "Say it", 'Sag "es"').join(), /double quote/);
  assert.match(C.check("js.a.b", "Saved", "Ge&amp;speichert").join(), /plain text/);
  assert.match(C.check("a.p", { one: "{count} x", other: "{count} xs" }, "{count} x").join(), /plural object/);
  assert.match(C.check("a.p", { one: "{count} x", other: "{count} xs" }, { one: "{count} x" }).join(), /"other"/);
  assert.match(C.check("a.p", { one: "{count} x", other: "{count} xs" }, { other: "x", bogus: "y" }).join(), /unknown plural category/);
  assert.match(C.check("a.b", "Buy PAT now", "Kauf Punkte jetzt").join(), /keep "PAT"/);
  assert.match(C.check("a.b", "Hi", "x".repeat(200)).join(), /longer/);
  assert.equal(C.hash("x"), C.hash("x"));
  assert.notEqual(C.hash("x"), C.hash("y"));
  assert.equal(C.hash({ one: "a", other: "b" }), C.hash({ other: "b", one: "a" }), "plural hash ignores key order");
});

test("plan: missing, changed, locked (review-needed), orphan, untracked", () => {
  const root = project();
  const p0 = S.loadProject(root);
  S.initState(p0);
  S.setLocks(p0, [{ lang: "de", key: "a.locked" }], true);
  S.save(p0);
  // English changes after the baseline: a.hello and the locked one
  const en = read(root, "en.json");
  en["a.hello"] = "Hi there {name}";
  en["a.locked"] = "Locked text, changed";
  fs.writeFileSync(path.join(root, "locales", "en.json"), JSON.stringify(en, null, 2));
  const p = S.plan(S.loadProject(root)).de;
  assert.deepEqual(p.missing.sort(), ["a.bold", "a.count", "js.a.msg"].sort());
  assert.deepEqual(p.changed, ["a.hello"]);
  assert.deepEqual(p.reviewNeeded, ["a.locked"]);
  assert.deepEqual(p.orphans, ["a.gone"]);
  assert.deepEqual(p.untracked, []);
});

test("sync: translates missing + changed keys, keeps locked ones, drops orphans, records hashes", async () => {
  const root = project();
  const p0 = S.loadProject(root);
  S.initState(p0);
  S.setLocks(p0, [{ lang: "de", key: "a.locked" }], true);
  S.save(p0);
  const en = read(root, "en.json");
  en["a.hello"] = "Hi there {name}";
  en["a.locked"] = "Locked text, changed";
  fs.writeFileSync(path.join(root, "locales", "en.json"), JSON.stringify(en, null, 2));

  const m = mock(good);
  const proj = S.loadProject(root);
  const rep = await S.sync(proj, { provider: m });
  S.save(proj);
  const de = read(root, "de.json");
  assert.equal(de["a.hello"], "DE:Hi there {name}", "changed key retranslated");
  assert.equal(de["a.bold"], "DE:Get <b>{n} PAT</b> now", "missing key translated");
  assert.deepEqual(de["a.count"], { one: "{count} Antwort", other: "{count} Antworten" });
  assert.equal(de["a.locked"], "Gesperrt", "a human-reviewed key is never overwritten");
  assert.equal(de["a.plain"], "Einstellungen", "an up-to-date key is left alone");
  assert.ok(!("a.gone" in de), "orphans dropped");
  assert.equal(de._meta.machine, true, "_meta kept");
  assert.deepEqual(Object.keys(de), ["_meta", "a.hello", "a.bold", "a.plain", "a.count", "a.locked", "js.a.msg"], "English key order");
  assert.deepEqual(rep.de.reviewNeeded, ["a.locked"]);
  // the prompt carried the glossary, the style, the previous translation of a changed key
  const all = m.calls.map((c) => c.prompt).join("\n");
  assert.match(all, /"style": "du"/);
  assert.match(all, /previous_translation_of_older_english/);
  assert.match(all, /"settings": "Einstellungen"|"keep"/);
  assert.match(m.calls[0].system, /placeholder/i);
  // a second run has nothing to do (hashes recorded)
  const again = S.plan(S.loadProject(root)).de;
  assert.equal(again.missing.length + again.changed.length, 0);
  const m2 = mock(good);
  await S.sync(S.loadProject(root), { provider: m2 });
  assert.equal(m2.calls.length, 0, "no model call when everything is current");
});

test("sync: invalid output is rejected, retried once with the problems, then skipped (never written)", async () => {
  const root = project();
  const p0 = S.loadProject(root);
  S.initState(p0);
  S.save(p0);
  // a.bold: drops the tag the first time, fixed on retry. js.a.msg: always adds markup -> skipped. a.count: plain string -> skipped.
  const m = mock((k, en, n, s) => {
    if (k === "a.bold") return n === 1 ? "Hol {n} PAT jetzt" : "Hol <b>{n} PAT</b> jetzt";
    if (k === "js.a.msg") { assert.ok(n === 1 || /plain text/.test(JSON.stringify(s.problems_to_fix))); return "<b>Gespeichert</b>"; }
    if (k === "a.count") return "{count} Antworten";
    return good(k, en);
  });
  const proj = S.loadProject(root);
  const rep = await S.sync(proj, { provider: m });
  S.save(proj);
  const de = read(root, "de.json");
  assert.equal(de["a.bold"], "Hol <b>{n} PAT</b> jetzt", "fixed on the retry");
  assert.ok(!("js.a.msg" in de), "bad output never written");
  assert.ok(!("a.count" in de));
  assert.deepEqual(rep.de.skipped.map((s) => s.key).sort(), ["a.count", "js.a.msg"]);
  assert.equal(S.plan(S.loadProject(root)).de.missing.length, 2, "skipped keys stay missing for the next run");
});

test("sync: --max-keys, --dry-run, a garbled reply is split and retried, a failing model skips", async () => {
  const root = project();
  const p0 = S.loadProject(root); S.initState(p0); S.save(p0);
  const before = fs.readFileSync(path.join(root, "locales", "de.json"), "utf8");
  const dry = await S.sync(S.loadProject(root), { dryRun: true });
  assert.equal(dry.de.todo, 3);
  assert.equal(fs.readFileSync(path.join(root, "locales", "de.json"), "utf8"), before, "dry run writes nothing");

  const proj = S.loadProject(root);
  const rep = await S.sync(proj, { provider: mock(good), maxKeys: 1 });
  assert.equal(rep.de.translated.length, 1);

  let n = 0;
  const garbled = { name: "g", model: "g", async complete({ prompt }) {
    n++;
    const req = JSON.parse(prompt.slice(prompt.indexOf("{")));
    const keys = Object.keys(req.translate_these);
    if (keys.length > 1) return { text: "sorry, here you go: {not json", truncated: false };
    return { text: JSON.stringify({ [keys[0]]: good(keys[0], req.translate_these[keys[0]].en) }), truncated: false };
  } };
  const p2 = S.loadProject(root);
  const r2 = await S.sync(p2, { provider: garbled });
  assert.equal(r2.de.translated.length, 3, "split down to single keys");
  assert.ok(n > 3);

  const down = { name: "d", model: "d", async complete() { throw new Error("HTTP 503"); } };
  const p3 = S.loadProject(root);
  const r3 = await S.sync(p3, { provider: down });
  assert.equal(r3.de.translated.length, 0);
  assert.equal(r3.de.skipped.length, 3);
});

test("CLI: --check reports gaps (exit 3 with --strict), a run without a key exits 4 without calling anything", async () => {
  const root = project();
  const lines = [];
  const w = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    assert.equal(await S.main(["--root=" + root, "--init"], {}), 0);
    assert.equal(await S.main(["--root=" + root, "--check", "--github"], {}), 0);
    assert.equal(await S.main(["--root=" + root, "--check", "--strict"], {}), 3);
    assert.equal(await S.main(["--root=" + root, "--all"], {}), 4);
    assert.equal(await S.main(["--root=" + root, "--all"], { I18N_PROVIDER: "openai" }), 4);
  } finally { process.stdout.write = w; }
  const out = lines.join("");
  assert.match(out, /de: 3 missing, 0 changed/);
  assert.match(out, /::warning file=locales\/en.json::/);
  assert.match(out, /ANTHROPIC_API_KEY is not set/);
  assert.doesNotMatch(out, /sk-ant/);
});

test("providers: Anthropic + OpenAI-compatible request shapes (fetch mocked), model default, keys only from env", async () => {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    if (/anthropic/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "{\"a\":\"b\"}" }], stop_reason: "end_turn", model: body.model }) };
    // OpenAI-compatible: streamed (SSE); reasoning deltas are ignored
    const sse = ['data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}', 'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"\\"x\\"}"},"finish_reason":"length"}]}', "data: [DONE]", ""].join("\n");
    const enc = new TextEncoder().encode(sse);
    return { ok: true, status: 200, body: (async function* () { yield enc.slice(0, 40); yield enc.slice(40); })() };
  };
  try {
    const a = P.fromEnv({ ANTHROPIC_API_KEY: "test-key" });
    assert.equal(a.model, "claude-haiku-5-5");
    const r = await a.complete({ system: "s", prompt: "p" });
    assert.equal(r.text, "{\"a\":\"b\"}");
    assert.equal(r.truncated, false);
    assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen[0].init.headers["x-api-key"], "test-key");
    assert.equal(JSON.parse(seen[0].init.body).system, "s");
    const o = P.fromEnv({ I18N_PROVIDER: "openai", I18N_OPENAI_BASE_URL: "http://ollama:11434/v1/", I18N_MODEL: "qwen", I18N_OPENAI_EXTRA: "{\"think\":false}" });
    const r2 = await o.complete({ system: "s", prompt: "p" });
    assert.equal(seen[1].url, "http://ollama:11434/v1/chat/completions");
    assert.equal(JSON.parse(seen[1].init.body).think, false);
    assert.equal(JSON.parse(seen[1].init.body).stream, true);
    assert.equal(r2.text, '{"a":"x"}', "content deltas joined across chunk boundaries, reasoning dropped");
    assert.equal(r2.truncated, true);
    assert.equal(P.fromEnv({ ANTHROPIC_API_KEY: "k", I18N_MODEL: "other" }).model, "other");
    assert.throws(() => P.fromEnv({}), (e) => e.code === "NO_KEY");
  } finally { global.fetch = real; }
});

test("fold: accepted overrides go into the catalog as human-reviewed; stale / invalid ones are skipped", async () => {
  const root = project();
  const p0 = S.loadProject(root); S.initState(p0); S.save(p0);
  const r = O.fold(root, { overrides: [
    { lang: "de", key: "a.plain", value: "Optionen", src_hash: C.hash("Settings") },
    { lang: "de", key: "a.hello", value: "Servus {name}", src_hash: "000000000000" },
    { lang: "de", key: "a.bold", value: "Hol <i>{n} PAT</i>", src_hash: C.hash(EN["a.bold"]) },
    { lang: "zz", key: "a.plain", value: "x" },
  ] });
  assert.deepEqual(r.written, ["de:a.plain"]);
  assert.equal(r.skipped.length, 3);
  assert.equal(read(root, "de.json")["a.plain"], "Optionen");
  const st = read(root, S.STATE_FILE);
  assert.equal(st.reviewed.de["a.plain"], C.hash("Settings"));
  // the sync now leaves it alone even when English changes
  const en = read(root, "en.json"); en["a.plain"] = "Your settings";
  fs.writeFileSync(path.join(root, "locales", "en.json"), JSON.stringify(en, null, 2));
  const proj = S.loadProject(root);
  const rep = await S.sync(proj, { provider: mock(good) });
  S.save(proj);
  assert.equal(read(root, "de.json")["a.plain"], "Optionen");
  assert.deepEqual(rep.de.reviewNeeded, ["a.plain"]);
});

test("the repo: state file covers every catalog key, glossary terms exist, catalogs pass the stricter checks", () => {
  const proj = S.loadProject(repo);
  assert.ok(fs.existsSync(path.join(repo, "locales", S.STATE_FILE)), "locales/.i18n-state.json is committed");
  const plans = S.plan(proj);
  for (const [lang, p] of Object.entries(plans)) {
    assert.equal(p.untracked.length, 0, lang + ": every catalog key has a recorded English hash (run --init after hand edits)");
    assert.equal(p.orphans.length, 0, lang + ": no keys English doesn't have");
  }
  const g = JSON.parse(fs.readFileSync(path.join(repo, "locales", "glossary.json"), "utf8"));
  for (const [term, d] of Object.entries(g.terms)) assert.ok(proj.en[d.from] != null, `glossary ${term}: ${d.from} is an English key`);
  for (const lang of Object.keys(proj.cats)) assert.ok(g.style[lang], "style notes for " + lang);
  for (const [lang, cat] of Object.entries(proj.cats)) {
    for (const [k, v] of Object.entries(cat.body)) assert.deepEqual(C.check(k, proj.en[k], v), [], `${lang}:${k}`);
  }
});
