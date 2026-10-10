#!/usr/bin/env node
// tools/i18n-sync.js - 1.99kf: keep every locales/<code>.json in step with locales/en.json, automatically.
//
// What it does, per language:
//   * finds the keys that need a translation: MISSING from the catalog, or CHANGED - the English text is no longer
//     the one the translation was made from (locales/.i18n-state.json keeps a hash of the English each translation
//     came from: "source" for all languages, "lag" where one language differs)
//   * never touches a key a human reviewed (state "reviewed", set by tools/i18n-overrides.js fold or --lock); if its
//     English changed it is only REPORTED (review-needed)
//   * translates the rest in batches with a model (tools/i18n-providers.js: Anthropic by default, or any
//     OpenAI-compatible endpoint), with the shared glossary + that language's style notes (locales/glossary.json)
//     and a few already-translated sibling strings as examples
//   * checks every answer with the same rules as test/i18n.test.js (i18n-check.js) before writing; a bad item is
//     retried once with the problems listed, then skipped (English keeps showing for it)
//   * drops catalog keys English no longer has (the tests refuse unknown keys)
//
// Usage (from the repo root):
//   node tools/i18n-sync.js --check [--github] [--strict]   what's missing / stale, no model needed (exit 3 with --strict if any)
//   node tools/i18n-sync.js --dry-run [--lang=es,fr]         list what a sync would translate
//   node tools/i18n-sync.js --all | --lang=es,fr [--max-keys=N] [--provider=anthropic|openai] [--model=ID] [--batch=30] [--concurrency=4]
//   node tools/i18n-sync.js --init                           record today's catalogs as up to date (first run / after a hand edit)
//   node tools/i18n-sync.js --glossary                       refresh the glossary's per-language terms from the catalogs
//   node tools/i18n-sync.js --lock=es:nav.feed,fr:nav.pads   mark keys human-reviewed (--unlock=... to undo)
// Env: see tools/i18n-providers.js (ANTHROPIC_API_KEY, I18N_PROVIDER, I18N_MODEL, I18N_OPENAI_BASE_URL ...). --root=DIR for tests.
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("../i18n-check");

const STATE_FILE = ".i18n-state.json";
const LANG_FILE = /^([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/;

// ---------------------------------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------------------------------
const readJson = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : dflt);
function writeJson(f, obj) {
  const s = JSON.stringify(obj, null, 2) + "\n";
  const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n") : null;
  if (old === s) return false;
  fs.writeFileSync(f, s);
  return true;
}

/** Everything the tool works on, read from <root>/locales. */
function loadProject(root) {
  const dir = path.join(root, "locales");
  const enRaw = readJson(path.join(dir, "en.json"));
  const project = { root, dir, enMeta: enRaw._meta || null, en: C.body(enRaw), cats: {}, dirty: new Set() };
  for (const f of fs.readdirSync(dir).sort()) {
    const m = LANG_FILE.exec(f);
    if (!m || m[1] === "en") continue;
    const raw = readJson(path.join(dir, f));
    project.cats[m[1]] = { meta: raw._meta || {}, body: C.body(raw) };
  }
  const st = readJson(path.join(dir, STATE_FILE), null);
  project.stateExisted = !!st;
  project.state = normState(st);
  project.glossary = readJson(path.join(dir, "glossary.json"), { keep: [], rules: [], terms: {}, style: {} });
  return project;
}
function normState(st) {
  const s = st && typeof st === "object" ? st : {};
  return { version: 1, source: s.source || {}, lag: s.lag || {}, reviewed: s.reviewed || {} };
}

/** Write the catalogs that changed (English key order, _meta first) and the state. */
function save(project) {
  const written = [];
  for (const lang of project.dirty) {
    const cat = project.cats[lang];
    const out = { _meta: cat.meta };
    for (const k of Object.keys(project.en)) if (cat.body[k] != null) out[k] = cat.body[k];
    if (writeJson(path.join(project.dir, lang + ".json"), out)) written.push(lang);
  }
  project.dirty.clear();
  normalize(project);
  const st = project.state;
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const inEnOrder = (o) => Object.fromEntries(Object.keys(project.en).filter((k) => o[k] != null).map((k) => [k, o[k]]));
  const perLang = (o) => sortObj(Object.fromEntries(Object.entries(o).map(([l, m]) => [l, inEnOrder(m)]).filter(([, m]) => Object.keys(m).length)));
  writeJson(path.join(project.dir, STATE_FILE), {
    _about: "Written by tools/i18n-sync.js - do not edit by hand. source: hash of the English each translation was made from; "
      + "lag: per-language exceptions to source; reviewed: human-reviewed keys the sync never overwrites (hash = the English they were reviewed against).",
    version: 1, source: inEnOrder(st.source), lag: perLang(st.lag), reviewed: perLang(st.reviewed),
  });
  return written;
}

// ---------------------------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------------------------
const baseOf = (st, lang, key) => (st.lag[lang] && st.lag[lang][key] !== undefined ? st.lag[lang][key] : st.source[key]);
function setBase(st, lang, key, h) {
  st.lag[lang] = st.lag[lang] || {};
  if (st.source[key] === h) delete st.lag[lang][key];
  else st.lag[lang][key] = h;
}
const isReviewed = (st, lang, key) => !!(st.reviewed[lang] && st.reviewed[lang][key]);

/** Fold the per-language hashes back into "source" wherever the languages agree; forget keys English dropped. */
function normalize(project) {
  const st = project.state, langs = Object.keys(project.cats);
  for (const k of Object.keys(st.source)) if (!(k in project.en)) delete st.source[k];
  for (const m of [st.lag, st.reviewed]) {
    for (const l of Object.keys(m)) {
      if (!project.cats[l]) { delete m[l]; continue; }
      for (const k of Object.keys(m[l])) if (!(k in project.en)) delete m[l][k];
    }
  }
  for (const k of Object.keys(project.en)) {
    const count = new Map();
    for (const l of langs) {
      if (project.cats[l].body[k] == null) continue;
      const b = baseOf(st, l, k);
      if (b != null) count.set(b, (count.get(b) || 0) + 1);
    }
    if (!count.size) continue;
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (st.source[k] === best) continue;
    const bases = Object.fromEntries(langs.map((l) => [l, baseOf(st, l, k)]));
    st.source[k] = best;
    for (const l of langs) {
      st.lag[l] = st.lag[l] || {};
      if (bases[l] === best || bases[l] === undefined) delete st.lag[l][k];
      else st.lag[l][k] = bases[l];
    }
  }
}

/** First run: every key a catalog already has counts as translated from today's English. */
function initState(project, { force = false } = {}) {
  const st = project.state;
  if (force) { st.source = {}; st.lag = {}; }
  let n = 0;
  for (const [lang, cat] of Object.entries(project.cats)) {
    for (const k of Object.keys(cat.body)) {
      if (!(k in project.en) || baseOf(st, lang, k) != null) continue;
      setBase(st, lang, k, C.hash(project.en[k]));
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------------------------------------------
/**
 * Per language: { missing: [keys], changed: [keys], reviewNeeded: [keys], orphans: [keys], untracked: [keys] }.
 * untracked = in the catalog with no recorded English (hand-added) - adopted as current, never retranslated.
 */
function plan(project, langs) {
  const out = {};
  const st = project.state;
  for (const lang of langs || Object.keys(project.cats)) {
    const cat = project.cats[lang];
    if (!cat) throw new Error("no catalog locales/" + lang + ".json");
    const p = { missing: [], changed: [], reviewNeeded: [], orphans: [], untracked: [] };
    for (const [k, en] of Object.entries(project.en)) {
      const h = C.hash(en);
      if (isReviewed(st, lang, k)) {
        if (st.reviewed[lang][k] !== h) p.reviewNeeded.push(k);
        continue;
      }
      if (cat.body[k] == null || cat.body[k] === "") { p.missing.push(k); continue; }
      const b = baseOf(st, lang, k);
      if (b == null) p.untracked.push(k);
      else if (b !== h) p.changed.push(k);
    }
    for (const k of Object.keys(cat.body)) if (!(k in project.en)) p.orphans.push(k);
    out[lang] = p;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------------------------------------------
const langName = (project, lang) => (project.cats[lang].meta && project.cats[lang].meta.language) || lang;
function pluralCats(lang) {
  try { return new Intl.PluralRules(lang).resolvedOptions().pluralCategories; } catch (e) { return ["one", "other"]; }
}

const SYSTEM = [
  "You are a professional software localizer translating the user interface of PATV (Public Access TV), a casual community",
  "website with live video rooms, chat games and a points currency called PAT. You get English UI strings keyed by id and",
  "return their translations. Answer with ONE JSON object only: {\"<key>\": <translation>, ...} for every key you were given,",
  "no commentary, no code fences.",
  "",
  "Hard rules (an answer that breaks one is thrown away):",
  "1. Keep every placeholder exactly: {name}, {!link}, {count} ... same names, not translated. You may move them.",
  "2. Keep HTML tags EXACTLY as in English, attributes included (<b>, </b>, <code>, <a href=\"/x\">). Translate only the text between tags. Text inside <code> stays as is.",
  "3. Never use a straight double quote (\") outside a tag. Use the language's own quotation marks or single quotes.",
  "4. Keep HTML entities as entities (&amp; &middot; &rarr;). Keys starting with js. are plain text: no tags and no entities at all.",
  "5. If the English value is an object of plural forms, answer with an object holding the language's plural categories",
  "   (listed per key in plural_categories) and always \"other\"; each form keeps the placeholders.",
  "6. Brand and product names in 'keep' stay exactly as written.",
  "7. Never add explanations, notes or alternatives to a translation.",
].join("\n");

function glossaryFor(project, lang) {
  const g = project.glossary || {};
  const terms = {};
  for (const [term, d] of Object.entries(g.terms || {})) {
    const tr = d && d.tr && d.tr[lang];
    if (tr) terms[term] = d.note ? tr + "  (" + d.note + ")" : tr;
  }
  return terms;
}

/** Up to `n` already-translated keys that share the longest key prefix with the batch (consistency examples). */
function examplesFor(project, lang, keys, n = 10) {
  const cat = project.cats[lang].body, want = new Set(keys), out = {};
  const prefixes = new Set();
  for (const k of keys) { const parts = k.split("."); for (let i = parts.length - 1; i >= 1; i--) prefixes.add(parts.slice(0, i).join(".") + "."); }
  const ranked = [...prefixes].sort((a, b) => b.length - a.length);
  for (const pre of ranked) {
    for (const k of Object.keys(project.en)) {
      if (Object.keys(out).length >= n) return out;
      if (!k.startsWith(pre) || want.has(k) || cat[k] == null || out[k]) continue;
      if (typeof project.en[k] !== "string" || project.en[k].length > 200) continue;
      out[k] = { en: project.en[k], [lang]: cat[k] };
    }
  }
  return out;
}

function buildPrompt(project, lang, items) {
  const g = project.glossary || {};
  const strings = {};
  for (const it of items) {
    const en = project.en[it.key];
    const s = { en };
    if (typeof en === "object") s.plural_categories = pluralCats(lang);
    if (it.previous != null) s.previous_translation_of_older_english = it.previous;
    if (it.problems) { s.your_last_answer = it.lastAnswer; s.problems_to_fix = it.problems; }
    strings[it.key] = s;
  }
  const req = {
    target_language: langName(project, lang) + " (" + lang + ")",
    style: (g.style || {})[lang] || "",
    rules: g.rules || [],
    keep: g.keep || [],
    glossary: glossaryFor(project, lang),
    examples_already_on_the_site: examplesFor(project, lang, items.map((i) => i.key)),
    translate_these: strings,
  };
  return "Translate every entry of translate_these into " + req.target_language + ". Reply with the JSON object only.\n\n" + JSON.stringify(req, null, 1);
}

/** The JSON object in a model reply (tolerates code fences and chatter around it). */
function parseReply(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in the reply");
  const o = JSON.parse(s.slice(a, b + 1));
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("reply is not an object");
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// the sync
// ---------------------------------------------------------------------------------------------------------------
function chunk(items, maxItems, maxChars) {
  const out = [];
  let cur = [], chars = 0;
  for (const it of items) {
    const n = JSON.stringify(it.en).length;
    if (cur.length && (cur.length >= maxItems || chars + n > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(it); chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function translateBatch(project, lang, provider, items, log, depth = 0) {
  let reply;
  try {
    reply = await provider.complete({ system: SYSTEM, prompt: buildPrompt(project, lang, items), maxTokens: 8192 });
  } catch (e) {
    if (e.fatal) throw e;
    log(`  ${lang}: model call failed (${e.message}) - ${items.length} key(s) skipped`);
    return { ok: {}, bad: items.map((i) => ({ key: i.key, problems: ["model call failed"] })) };
  }
  let obj;
  try {
    if (reply.truncated) throw new Error("reply was cut off");
    obj = parseReply(reply.text);
  } catch (e) {
    if (items.length > 1 && depth < 4) {     // too big or garbled: split and try the halves
      const mid = Math.ceil(items.length / 2);
      const a = await translateBatch(project, lang, provider, items.slice(0, mid), log, depth + 1);
      const b = await translateBatch(project, lang, provider, items.slice(mid), log, depth + 1);
      return { ok: Object.assign(a.ok, b.ok), bad: a.bad.concat(b.bad) };
    }
    return { ok: {}, bad: items.map((i) => ({ key: i.key, problems: [e.message] })) };
  }
  const ok = {}, bad = [];
  for (const it of items) {
    let v = obj[it.key];
    if (typeof v === "string") v = v.trim();
    if (v && typeof v === "object" && !Array.isArray(v)) v = Object.fromEntries(Object.entries(v).map(([c, s]) => [c, typeof s === "string" ? s.trim() : s]));
    const problems = v == null ? ["no answer for this key"] : C.check(it.key, project.en[it.key], v, { brands: C.BRANDS });
    if (problems.length) bad.push({ key: it.key, problems, lastAnswer: v });
    else ok[it.key] = v;
  }
  return { ok, bad };
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, async () => {
    while (i < tasks.length) { const j = i++; out[j] = await tasks[j](); }
  }));
  return out;
}

/**
 * Translate what plan() found. Returns { [lang]: { translated: [keys], skipped: [{key, problems}], reviewNeeded, removed } }.
 * opts: langs, provider, maxKeys, batch (items), batchChars, concurrency (languages at once), dryRun, log
 */
async function sync(project, opts = {}) {
  const log = opts.log || (() => {});
  const langs = opts.langs || Object.keys(project.cats);
  const plans = plan(project, langs);
  const report = {};
  const st = project.state;
  // bookkeeping first: adopt hand-added keys, drop orphans
  for (const lang of langs) {
    const p = plans[lang], cat = project.cats[lang];
    report[lang] = { todo: p.missing.length + p.changed.length, translated: [], skipped: [], reviewNeeded: p.reviewNeeded, removed: p.orphans,
                     missing: p.missing, changed: p.changed };
    if (opts.dryRun) continue;
    for (const k of p.untracked) setBase(st, lang, k, C.hash(project.en[k]));
    for (const k of p.orphans) { delete cat.body[k]; project.dirty.add(lang); }
  }
  if (opts.dryRun) return report;
  if (!opts.provider) throw new Error("no provider");
  const jobs = langs.map((lang) => async () => {
    const p = plans[lang], cat = project.cats[lang];
    let keys = p.missing.concat(p.changed);
    if (opts.maxKeys) keys = keys.slice(0, opts.maxKeys);
    if (!keys.length) return;
    const items = keys.map((k) => ({ key: k, en: project.en[k], previous: p.changed.includes(k) ? cat.body[k] : undefined }));
    let bad = [];
    const write = (ok) => {
      for (const [k, v] of Object.entries(ok)) {
        cat.body[k] = v;
        setBase(st, lang, k, C.hash(project.en[k]));
        report[lang].translated.push(k);
      }
      if (Object.keys(ok).length) project.dirty.add(lang);
    };
    for (const b of chunk(items, opts.batch || 30, opts.batchChars || 6000)) {
      const r = await translateBatch(project, lang, opts.provider, b, log);
      write(r.ok);
      bad = bad.concat(r.bad);
    }
    // one retry for the rejects, with what was wrong
    if (bad.length) {
      const retry = bad.map((b) => Object.assign({}, items.find((i) => i.key === b.key), { problems: b.problems, lastAnswer: b.lastAnswer }));
      bad = [];
      for (const b of chunk(retry, 15, 4000)) {
        const r = await translateBatch(project, lang, opts.provider, b, log);
        write(r.ok);
        bad = bad.concat(r.bad);
      }
    }
    report[lang].skipped = bad.map((b) => ({ key: b.key, problems: b.problems }));
    log(`  ${lang}: ${report[lang].translated.length} translated${bad.length ? ", " + bad.length + " skipped" : ""}`);
    if (opts.onLang) opts.onLang(lang);      // the CLI saves here, so a long run that dies keeps what it finished
  });
  await pool(jobs, opts.concurrency || 4);
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// glossary + locks
// ---------------------------------------------------------------------------------------------------------------
function refreshGlossary(project) {
  const g = project.glossary;
  let n = 0;
  for (const d of Object.values(g.terms || {})) {
    if (!d || !d.from || d.locked) continue;
    d.tr = d.tr || {};
    for (const [lang, cat] of Object.entries(project.cats)) {
      const v = cat.body[d.from];
      if (typeof v === "string" && v && d.tr[lang] !== v) { d.tr[lang] = v; n++; }
    }
    d.tr = Object.fromEntries(Object.keys(d.tr).sort().map((k) => [k, d.tr[k]]));
  }
  writeJson(path.join(project.dir, "glossary.json"), g);
  return n;
}

/** Mark lang:key pairs human-reviewed (the sync never overwrites them) or undo it. */
function setLocks(project, pairs, on) {
  const st = project.state, done = [];
  for (const { lang, key } of pairs) {
    if (!project.cats[lang] || !(key in project.en)) throw new Error("unknown " + lang + ":" + key);
    st.reviewed[lang] = st.reviewed[lang] || {};
    if (on) { st.reviewed[lang][key] = C.hash(project.en[key]); setBase(st, lang, key, C.hash(project.en[key])); }
    else delete st.reviewed[lang][key];
    done.push(lang + ":" + key);
  }
  return done;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
function args(argv) {
  const a = {};
  for (const s of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(s);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const a = args(argv);
  const root = path.resolve(a.root || path.join(__dirname, ".."));
  const project = loadProject(root);
  const say = (s) => process.stdout.write(s + "\n");
  const langs = a.lang ? String(a.lang).split(",").filter(Boolean) : Object.keys(project.cats);
  for (const l of langs) if (!project.cats[l]) { say("no catalog locales/" + l + ".json"); return 2; }

  if (a.init) {
    const n = initState(project, { force: !!a.force });
    save(project);
    say(`recorded ${n} translation(s) as up to date in locales/${STATE_FILE}`);
    return 0;
  }
  if (a.glossary) { say(`glossary: ${refreshGlossary(project)} term translation(s) updated`); return 0; }
  if (a.lock || a.unlock) {
    const pairs = String(a.lock || a.unlock).split(",").filter(Boolean).map((s) => { const i = s.indexOf(":"); return { lang: s.slice(0, i), key: s.slice(i + 1) }; });
    const done = setLocks(project, pairs, !!a.lock);
    save(project);
    say((a.lock ? "locked " : "unlocked ") + done.join(", "));
    return 0;
  }

  if (!project.stateExisted) { initState(project); say(`(no locales/${STATE_FILE} yet - today's catalogs count as up to date)`); }
  if (a.check || a["dry-run"] || (!a.all && !a.lang)) {
    const p = plan(project, langs);
    let gaps = 0, lines = [];
    for (const l of langs) {
      const x = p[l];
      const n = x.missing.length + x.changed.length;
      gaps += n;
      if (n || x.reviewNeeded.length || x.orphans.length) {
        lines.push(`${l}: ${x.missing.length} missing, ${x.changed.length} changed${x.reviewNeeded.length ? ", " + x.reviewNeeded.length + " reviewed but English changed (needs a human)" : ""}${x.orphans.length ? ", " + x.orphans.length + " no longer in English" : ""}`);
        if (a["dry-run"] || a.verbose) {
          for (const k of x.missing.slice(0, a["max-keys"] ? Number(a["max-keys"]) : 50)) lines.push("    + " + k);
          for (const k of x.changed.slice(0, 50)) lines.push("    ~ " + k);
          for (const k of x.reviewNeeded.slice(0, 50)) lines.push("    ! " + k);
        }
      }
    }
    if (!a.check && !a["dry-run"]) say("nothing to do without --all or --lang=xx (this is what a sync would do):");
    say(lines.length ? lines.join("\n") : "all catalogs are up to date with en.json");
    if (a.github && gaps) {
      const keys = [...new Set(Object.values(p).flatMap((x) => x.missing.concat(x.changed)))];
      say(`::warning file=locales/en.json::${keys.length} English string(s) have no up-to-date translation in ${Object.values(p).filter((x) => x.missing.length + x.changed.length).length} language(s); `
        + `those show in English until the i18n sync runs (${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""})`);
    }
    return a.strict && gaps ? 3 : 0;
  }

  let provider;
  try { provider = require("./i18n-providers").fromEnv(env, { provider: a.provider, model: a.model }); }
  catch (e) { say("i18n-sync: " + e.message); return e.code === "NO_KEY" ? 4 : 1; }
  say(`i18n-sync: ${provider.name} ${provider.model}, ${langs.length} language(s)`);
  const saved = new Set();
  const report = await sync(project, {
    langs, provider, maxKeys: a["max-keys"] ? Number(a["max-keys"]) : 0, batch: a.batch ? Number(a.batch) : 30,
    concurrency: a.concurrency ? Number(a.concurrency) : (provider.name === "openai" ? 1 : 4), log: say,
    onLang: () => { for (const l of save(project)) saved.add(l); },
  });
  for (const l of save(project)) saved.add(l);
  const written = [...saved].sort();
  let t = 0, s = 0;
  for (const [l, r] of Object.entries(report)) {
    t += r.translated.length; s += r.skipped.length;
    for (const x of r.skipped) say(`  skipped ${l}:${x.key} - ${x.problems.join("; ")}`);
    for (const k of r.reviewNeeded) say(`  needs a human: ${l}:${k} was reviewed, but its English changed`);
  }
  say(`done: ${t} translated, ${s} skipped; catalogs written: ${written.join(" ") || "none"}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error("i18n-sync:", e.message); process.exitCode = 1; });
}

module.exports = { loadProject, save, plan, sync, initState, normalize, refreshGlossary, setLocks, buildPrompt, parseReply, main, SYSTEM, STATE_FILE };
