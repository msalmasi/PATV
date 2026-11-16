// O2 release A (rollback safety) - test/casino-rl-store.test.js's PREVIOUS BUILD, in its own process (dbUtils opens ./myapp.db):
// the roulette service of the release before per-bet storage (1.99aof: test/fixtures/casino-rl-prev-roulette.js.txt is
// casino/roulette.js at 84952cc0, byte for byte; service.js / money.js / ledger.js are the ones it shipped with, unchanged
// by O2) boots on the database this build wrote - what the site CI's automatic rollback does - and runs a few steps.
//   node test/fixtures/casino-rl-prev-boot.js <dir with myapp.db> <clock ms> <steps JSON>
// steps: [{open: room}, {act: [tableId | "$0" (the first wheel opened here), uid, verb, line]}, {tick: ms}, {move: ms},
// {crash: "rl:<step>" | null} (that build's own crash points)] - prints one JSON line: the wheels, the wallets, what that
// build's supply audit counted at its tables (T.escrowed in the JSON), the House and the clock.
"use strict";
const fs = require("fs"),
  path = require("path"),
  Module = require("module");
const [dir, nowArg, stepsArg] = process.argv.slice(2);
const repo = path.resolve(__dirname, "../..");
if (require.main !== module || !dir) return; // (a fixture: loaded on its own it does nothing)
process.chdir(dir);
delete process.env.STAGING;
// casino/roulette.js resolves to the previous build's module (its own requires resolve from casino/, as they did)
const target = path.join(repo, "casino", "roulette.js");
const prev = new Module(target, module);
prev.filename = target;
prev.paths = Module._nodeModulePaths(path.dirname(target));
prev._compile(fs.readFileSync(path.join(__dirname, "casino-rl-prev-roulette.js.txt"), "utf8"), target);
prev.loaded = true;
require.cache[target] = prev;
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
  process.stdout.write(JSON.stringify(out) + "\n");
  svc.stop();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
