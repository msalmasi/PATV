// O2 release A (rollback safety) - test/casino-rl-store.test.js's PREVIOUS BUILD, in its own process (dbUtils opens ./myapp.db):
// the build the site CI's automatic rollback runs, booted on the database this build wrote, running a few steps.
// 1.99aoj (review): the WHOLE previous build, not just its roulette.js inside this build's service.js. Every module this release
// changed is loaded as the deployed base has it - the vendored copies in test/fixtures/casino-prev/ (manifest.json names the base
// commit, its version and each file's git blob; test/casino-rl-store.test.js checks the copies against the manifest, and, where git
// has the base, against the base itself and that every other module this process loads is unchanged since it). Every other module
// is the same file in both builds.
//   node test/fixtures/casino-rl-prev-boot.js <dir with myapp.db> <clock ms> <steps JSON>
// steps: [{open: room}, {act: [tableId | "$0" (the first wheel opened here), uid, verb, line]}, {tick: ms}, {move: ms},
// {crash: "rl:<step>" | null} (that build's own crash points)] - prints one JSON line: the wheels, the wallets, what that
// build's supply audit counted at its tables (T.escrowed in the JSON), the House, the clock and the repo modules it loaded.
"use strict";
const fs = require("fs"),
  path = require("path"),
  Module = require("module");
const [dir, nowArg, stepsArg] = process.argv.slice(2);
const repo = path.resolve(__dirname, "../..");
if (require.main !== module || !dir) return; // (a fixture: loaded on its own it does nothing)
process.chdir(dir);
delete process.env.STAGING;
const rel = (f) => path.relative(repo, f).split(path.sep).join("/");
const PREV_DIR = path.join(__dirname, "casino-prev");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PREV_DIR, "manifest.json"), "utf8"));
const PREV = new Map(Object.keys(MANIFEST.files).map((f) => [f, fs.readFileSync(path.join(PREV_DIR, f + ".txt"), "utf8")]));
// a changed module compiles from the previous build's text under its own path (its requires resolve from its own folder, as they did),
// whenever it is first required - lazily required ones too
const loadJs = Module._extensions[".js"];
Module._extensions[".js"] = function (m, filename) {
  const text = PREV.get(rel(filename));
  return text === undefined ? loadJs(m, filename) : m._compile(text, filename);
};
const svc = require(path.join(repo, "casino/service"));
const veil = require(path.join(repo, "casino/veil"));
const { getQuery } = require(path.join(repo, "dbUtils"));
require(path.join(repo, "casino/rewards")).hooks.updateLevel = async () => {};
let now = Number(nowArg);
svc.S.hooks.now = () => now;
// that build's supply.casinoHeld for a wheel: the T.escrowed of its JSON
async function heldJson() {
  let n = 0;
  for (const r of await getQuery("SELECT state FROM casino_tables WHERE game = 'roulette' AND status != 'closed'"))
    for (const v of Object.values(JSON.parse(r.state).escrowed || {})) n += Math.max(0, Math.floor(Number(v) || 0));
  return n;
}
const who = (uid) => ({ uid, name: "Player" + uid, username: "player" + uid, camfrog: "Frog" + uid, via: "web", iph: null, admin: false, veil: null });
(async () => {
  veil._hooks.kind = async () => null;
  await require(path.join(repo, "funding")).init();
  await svc.boot({ tick: false });
  const out = { opened: [], replies: [] };
  let seq = 0;
  for (const s of JSON.parse(stepsArg || "[]")) {
    if (s.crash !== undefined) svc.S.hooks.crash = s.crash;
    if (s.move) now += s.move;
    if (s.tick != null) {
      now += s.tick;
      await svc.tickOnce();
    }
    if (s.open) {
      const r = await svc.act({ ...who("a"), via: "room" }, "start", [], { room: s.open, game: "roulette" }, "prev-open-" + ++seq);
      out.opened.push(r.table);
      out.replies.push(r);
    }
    if (s.act) {
      const [ref, uid, verb, line] = s.act,
        table = ref === "$0" ? out.opened[0] : ref;
      svc.S.rate.clear();
      out.replies.push(await svc.act(who(uid), verb, line == null ? [] : [line], { table }, "prev-act-" + now + "-" + ++seq));
    }
  }
  out.tables = [...svc.S.tables.values()]
    .filter((T) => T.game === "roulette")
    .map((T) => ({ id: T.id, status: T.status, phase: T.eng.phase, round_no: T.eng.round_no, book: T.eng.book.length, escrowed: T.escrowed, intent: T.intent, opno: T.opno }));
  out.cash = Object.fromEntries((await getQuery("SELECT userId, points_balance FROM users")).map((r) => [r.userId, r.points_balance]));
  out.heldJson = await heldJson();
  out.house = (await getQuery("SELECT SUM(amount) AS n FROM jackpot_rakes"))[0].n;
  out.now = now;
  // the repo's own modules this build ran (the store test checks each one that isn't vendored is unchanged since the base)
  out.loaded = Object.keys(require.cache).map(rel).filter((f) => !f.startsWith("..") && !f.startsWith("node_modules/") && !f.startsWith("test/")).sort();
  process.stdout.write(JSON.stringify(out) + "\n");
  svc.stop();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
