// 1.99apl room audio: the site's room-audio settings (roomaudiocfg.js FIELDS) are the bot's (camfrog-bot pepe_roomrtc DEFAULT_CFG /
// CFG_RANGES / CFG_CHOICES / MP3_KBPS) - the same keys, defaults, ranges and choices - and the new gain_db / limiter come out of both
// normalizers the same (Pepe validates the site's answer again); and the admin page's script fills, ranges, saves and shows the two
// fields. The contract reads the bot's REAL module at test time (python imports it):
//   PEPE_BOT_DIR=<camfrog-bot checkout> node --test test/room-audio-gain.test.js     (skipped without a checkout)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const AC = require(path.join(repo, "roomaudiocfg"));
const botDir = process.env.PEPE_BOT_DIR || path.join(repo, "camfrog-bot");
const HAVE = fs.existsSync(path.join(botDir, "pepe_roomrtc.py"));

// what the site lets an admin save / what a lenient read of Pepe's report keeps, and what Pepe makes of the same input
const PROBES = [{}, { gain_db: 0 }, { gain_db: 6 }, { gain_db: "4.5" }, { gain_db: 3.3 }, { gain_db: 3.2 }, { gain_db: 11.9 }, { gain_db: 12 },
  { gain_db: 15 }, { gain_db: -2 }, { gain_db: "loud" }, { limiter: "off" }, { limiter: " OFF" }, { limiter: "on" }, { limiter: "maybe" },
  { gain_db: 9, limiter: "off" }];
const PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import pepe_roomrtc as r",
  "probes = json.loads(sys.stdin.read())",
  "out = {'defaults': r.DEFAULT_CFG, 'ranges': r.CFG_RANGES, 'choices': r.CFG_CHOICES, 'mp3': list(r.MP3_KBPS),",
  "       'norm': [r.normalize_cfg(p) for p in probes]}",
  "print('@@' + json.dumps(out))",
].join("\n");
let BOT = null;
function bot() {
  if (!BOT) {
    const raw = execFileSync(process.env.PYTHON || "python", ["-c", PY, botDir], { cwd: os.tmpdir(), input: JSON.stringify(PROBES), encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 4 * 1024 * 1024 });
    const line = raw.split(/\r?\n/).filter((l) => l.startsWith("@@")).pop();
    BOT = JSON.parse(line.slice(2));
  }
  return BOT;
}
const skip = !HAVE && "no camfrog-bot checkout (PEPE_BOT_DIR)";

test("FIELDS = the bot's settings: the same keys and defaults", { skip }, () => {
  const B = bot();
  assert.deepEqual(Object.keys(AC.FIELDS).sort(), Object.keys(B.defaults).sort(), "one list of settings on both sides");
  for (const [k, f] of Object.entries(AC.FIELDS)) assert.equal(f.def, B.defaults[k], k + ": the same default");
  assert.equal(B.defaults.gain_db, 0, "gain 0 by default = the sound as it arrives");
  assert.equal(B.defaults.limiter, "on");
});

test("FIELDS = the bot's settings: every number's range is CFG_RANGES, every choice CFG_CHOICES (mp3_kbps: MP3_KBPS)", { skip }, () => {
  const B = bot();
  const nums = Object.keys(AC.FIELDS).filter((k) => AC.FIELDS[k].min != null);
  assert.deepEqual(nums.sort(), Object.keys(B.ranges).sort(), "the numbers with a range are the same ones");
  for (const k of nums) assert.deepEqual([AC.FIELDS[k].min, AC.FIELDS[k].max], B.ranges[k], k + ": the same range");
  assert.deepEqual(B.ranges.gain_db, [0, 12], "gain 0..+12 dB");
  const picks = Object.keys(AC.FIELDS).filter((k) => AC.FIELDS[k].choices && k !== "mp3_kbps");
  assert.deepEqual(picks.sort(), Object.keys(B.choices).sort(), "the switches are the same ones");
  for (const k of picks) assert.deepEqual([...AC.FIELDS[k].choices].sort(), [...B.choices[k]].sort(), k + ": the same choices");
  assert.deepEqual(AC.FIELDS.mp3_kbps.choices, B.mp3, "the MP3 bitrates");
});

test("gain_db / limiter come out of both normalizers the same (0.5 dB steps, clamped, a bad value -> the default)", { skip }, () => {
  const B = bot();
  PROBES.forEach((p, i) => {
    const site = AC.normalize(p, { lenient: true }).cfg, pepe = B.norm[i];
    assert.equal(site.gain_db, pepe.gain_db, JSON.stringify(p) + ": gain_db");
    assert.equal(site.limiter, pepe.limiter, JSON.stringify(p) + ": limiter");
  });
  assert.equal(B.norm[PROBES.findIndex((p) => p.gain_db === 3.3)].gain_db, 3.5, "a 0.5 dB step");
  assert.equal(B.norm[PROBES.findIndex((p) => p.gain_db === 15)].gain_db, 12, "clamped to +12");
  assert.equal(B.norm[0].gain_db, 0); assert.equal(B.norm[0].limiter, "on");
});

// The admin page's own script (views/admin/pepeAudio.ejs) in a small fake form: the two fields get their range / default, are filled
// from the settings, go out with a save, and "What Pepe runs now" says the gain he runs.
test("/admin/pepe/audio's script: the gain + limiter fields are filled, ranged, saved and shown in what Pepe runs", async () => {
  const src = fs.readFileSync(path.join(repo, "views", "admin", "pepeAudio.ejs"), "utf8");
  const at = src.search(/<script>\r?\n\(function \(\) \{/);
  let js = src.slice(src.indexOf("\n", at) + 1, src.indexOf("</script>", at));
  const view = { now: 1, v: 1, cfg: { ...AC.DEFAULTS }, defaults: { ...AC.DEFAULTS }, fields: AC.FIELDS, updated_at: null, updated_by: null, online: true, bot_at: 1,
    bot: { v: 1, src: "site", cfg: { ...AC.DEFAULTS, gain_db: 4.5, limiter: "on" }, helper_enabled: true, net_audio: true, rooms: {} }, audit: [] };
  js = js.replace(/<%-[^%]*%>/, () => JSON.stringify(view));
  assert.doesNotMatch(js, /<%/, "only the one EJS value in the script");
  function node(tag, attrs = {}) {
    const kids = [], cls = new Set();
    const n = Object.assign({ tagName: tag, textContent: "", style: {}, children: kids, value: "", step: "", min: "", max: "", type: "", checked: false,
      appendChild(c) { kids.push(c); return c; }, remove() {}, addEventListener(k, f) { (n.on[k] ||= []).push(f); }, on: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, v) => (v ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) } }, attrs);
    return n;
  }
  const labels = {}, inputs = {};
  for (const [k, f] of Object.entries(AC.FIELDS)) {
    if (k === "pacing") continue;
    const lab = node("label"), inp = node(f.choices ? "select" : "input", { type: f.choices ? "select-one" : "number", name: k, step: k === "gain_db" ? "0.5" : "" });
    inp.closest = () => lab; labels[k] = lab; inputs[k] = inp;
  }
  inputs.reason = node("input", { name: "reason" }); inputs.reason.closest = () => node("label");
  const radios = ["helper", "inprocess"].map((v) => node("input", { type: "radio", name: "pacing", value: v }));
  const legend = node("legend");
  const form = node("form", { elements: inputs,
    querySelector: (s) => (s === "fieldset legend" ? legend : s === "input[name=pacing]:checked" ? radios.find((r) => r.checked) || null : null),
    querySelectorAll: (s) => (s === "input[name=pacing]" ? radios : []) });
  const ids = { raForm: form };
  const posts = [];
  const ctx = { console, setInterval: () => 0, confirm: () => true,
    document: { hidden: false, getElementById: (id) => (ids[id] ||= node("div")), createElement: (t) => node(t) },
    fetch: async (url, o) => {
      posts.push(JSON.parse(o.body));
      const cfg = AC.normalize(JSON.parse(o.body).cfg, { lenient: true }).cfg;
      return { json: async () => ({ ok: true, v: 2, changed: {}, view: { ...view, v: 2, cfg, bot: { ...view.bot, v: 2, cfg } } }) };
    } };
  vm.runInNewContext(js, ctx);
  assert.equal(inputs.gain_db.value, "0", "filled from the settings"); assert.equal(inputs.limiter.value, "on");
  assert.equal(inputs.gain_db.min, 0); assert.equal(inputs.gain_db.max, 12); assert.equal(inputs.gain_db.step, "0.5", "the 0.5 dB step is kept");
  assert.ok(labels.gain_db.children.some((c) => c.textContent === "default 0 · 0–12"), "the default and range next to the field");
  assert.ok(labels.limiter.children.some((c) => c.textContent === "default on"));
  assert.match(ids.lvRuns.textContent, /gain \+4\.5 dB, limiter on/, "what Pepe runs: his gain");
  inputs.gain_db.value = " 6 "; inputs.limiter.value = "off";
  form.on.submit[0]({ preventDefault() {} });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].cfg.gain_db, "6", "the gain goes out with the save (the site validates it)"); assert.equal(posts[0].cfg.limiter, "off");
  assert.equal(inputs.gain_db.value, "6"); assert.equal(inputs.limiter.value, "off");
  assert.match(ids.lvRuns.textContent, /gain \+6 dB, limiter off/);
});

test("the site's own side of it: gain_db 0..12 step 0.5 default 0, limiter on | off default on (also without a bot checkout)", () => {
  assert.deepEqual(AC.FIELDS.gain_db, { def: 0, min: 0, max: 12, step: 0.5 });
  assert.deepEqual(AC.FIELDS.limiter, { def: "on", choices: ["on", "off"] });
  assert.equal(AC.DEFAULTS.gain_db, 0); assert.equal(AC.DEFAULTS.limiter, "on");
  const src = fs.readFileSync(path.join(repo, "roomaudiocfg.js"), "utf8");
  assert.match(src, /Ranges match pepe_roomrtc\.CFG_RANGES/, "the comment that says the lists must match is still there");
});
