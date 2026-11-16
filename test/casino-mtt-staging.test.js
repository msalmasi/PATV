"use strict";
// roulette2 WP1 (FAIR-1 for the card tables, decision D9) - SCHEDULED TOURNAMENTS: a staging refresh must never let staging play, or
// publish, prod's tournament seeds - the seating draw's seed (casino_mtt seed.draw_seed: it orders the start draw, every table break and the
// final table) and its tables' hand seeds, decks and hole cards. Prod has a running tournament mid-hand and one registering. The copy keeps
// none of them (free pages included); staging (test/fixtures/casino-card-staging-boot.js, its own process) voids both quietly at boot through
// the cancel path - every hold back in full once, no draw, no reveal, no notice, no room line, nothing playable - and a second boot changes
// nothing. In this process: a FINISHING copy (decided, its one settle never ran) is voided, never settled; a copy whose void can't go through
// is out of play here until the next boot.
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-mtt-staging.test.js      (uses a temp DB)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-staging");
const { svc, MT, getQuery, runQuery } = h;
const K = require(path.join(h.repo, "deploy", "keep-staging-tables"));
require(path.join(h.repo, "casino", "rewards")).hooks.updateLevel = async () => {};
const sqlite3 = require(require.resolve("sqlite3", { paths: [h.repo] }));

test.before(async () => { await h.setup(12); });
test.after(() => svc.stop());

const live = (M) => svc.S.mtts.get(M.id);
const scrubHere = async () => { for (const s of K.CASINO_SCRUB) await runQuery(s.sql.replace(/\bmain\./g, "")); };
const kinds = async (ids) => (await getQuery(`SELECT table_id, kind FROM casino_events WHERE table_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, ids)).map((r) => r.table_id + ":" + r.kind);
const inbox = async () => (await getQuery("SELECT COUNT(*) AS n FROM inbox").catch(() => [{ n: 0 }]))[0].n;
async function refresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtt-staging-"));
  const old = path.join(dir, "myapp.db"), copy = path.join(dir, "myapp.db.new");
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(old, (e) => (e ? rej(e) : d.exec("CREATE TABLE staging_marker (k TEXT)", (e2) => d.close(() => (e2 ? rej(e2) : res())))));
  });
  await runQuery("PRAGMA secure_delete = ON");                       // (as deploy/refresh-staging-db.sh copies prod)
  await runQuery(`VACUUM INTO '${copy.replace(/\\/g, "/")}'`);
  const out = execFileSync(process.execPath, [path.join(h.repo, "deploy", "keep-staging-tables.js"), old, copy], { encoding: "utf8" });
  fs.renameSync(old, old + ".previous");
  fs.renameSync(copy, old);
  return { dir, out, file: old };
}

test("FAIR-1 for tournaments: the copy keeps no draw seed, hand seed or deck; staging voids a running and a registering tournament quietly, every hold back once, nothing revealed or playable", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, h.players.slice(0, 4));
  await h.toStart(M);
  assert.equal(M.status, "running");
  for (let i = 0; i < 30 && !MT.liveTables(M).some((T) => T.eng.hand_active); i++) await h.later(1);
  const tables = MT.liveTables(M);
  assert.ok(tables.some((T) => T.eng.hand_active && T.hand), "a hand is in play");
  const M2 = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M2, h.players.slice(4, 6));
  assert.equal(M2.status, "registering");
  const seeds = [M.seed.draw_seed, M2.seed.draw_seed].concat(tables.flatMap((T) => [T.next && T.next.seed, T.hand && T.hand.seed])).filter(Boolean);
  assert.ok(seeds.length >= 3 && M.seed.draw_seed && M2.seed.draw_seed);
  const decks = tables.filter((T) => T.hand).map((T) => JSON.stringify(T.hand.deck.slice(4, 30)).slice(1, -1));
  const prodBal = {};
  for (const p of h.players.slice(0, 6)) prodBal[p.uid] = await h.bal(p.uid);
  const total0 = await h.total();

  const { dir, out, file } = await refresh();
  assert.match(out, /casino_mtt scrubbed 2 \(tournaments\)/, out);
  assert.match(out, new RegExp(`casino_tables scrubbed ${tables.length} \\(cards\\)`), out);
  const bytes = fs.readFileSync(file).toString("latin1");
  for (const s of seeds) assert.ok(!bytes.includes(s), "the copy still holds a tournament seed");
  for (const d of decks) assert.ok(!bytes.includes(d), "the copy still holds a tournament table's cards to come");
  const ids = tables.map((T) => T.id);
  const raw = execFileSync(process.execPath, [path.join(__dirname, "fixtures", "casino-card-staging-boot.js"), dir, ids.join(","), String(h.NOW), [M.id, M2.id].join(",")],
                           { encoding: "utf8" });
  const st = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual(st.loaded, [], "every copied tournament table closed at boot");
  assert.deepEqual(st.loadedMtt, [], "both copied tournaments are over at boot");
  assert.deepEqual(st.loaded2, []);
  for (const id of [M.id, M2.id]) {
    assert.equal(st.mtt[id].status, "cancelled", id);
    assert.equal(st.mtt[id].draw_seed, null);
    assert.equal(st.mtt[id].revealed_at, null, "the draw seed is never marked revealed");
    assert.equal(st.mtt2[id].status, "cancelled");
  }
  assert.deepEqual(st.revealed, [], "no hand of a copied tournament table is revealed");
  assert.deepEqual(st.events, [], "no casino_events row (no room line, no table line)");
  assert.equal(st.newRounds, 0, "no new hand committed (or dealt) at a copied tournament table");
  assert.equal(st.inbox, 0, "no tournament notice");
  for (const id of ids) assert.ok(st.tries[id].every((x) => x === false), "nobody plays at copied table " + id);
  assert.equal(st.after, st.before, "staging's PAT is conserved (the holds are refunded there)");
  assert.equal(st.after2, st.after);
  assert.equal(st.tx2, st.tx1, "a second boot credits nothing");
  for (const p of h.players.slice(0, 6)) assert.equal(st.bal1[p.uid], prodBal[p.uid] + 1100, p.uid + ": the entry in full, once");
  // prod untouched
  assert.equal(live(M).status, "running");
  assert.equal(live(M2).status, "registering");
  assert.ok(live(M).seed.draw_seed && live(M2).seed.draw_seed);
  assert.equal(await h.total(), total0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a copied FINISHING tournament (one stack left, its one settle never ran) is voided - every hold refunded once, never settled; quiet; a second boot moves nothing", async () => {
  await h.fresh();
  const total0 = await h.total();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, h.players.slice(0, 4));
  await h.toStart(M);
  svc.S.hooks.crash = "mtt:finish:in-tx";
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" });
  svc.S.hooks.crash = null;
  assert.equal(live(M).status, "finishing");
  const ids = live(M).tables.map((r) => r.id);
  const ev0 = await kinds(ids.concat([M.id])), in0 = await inbox();
  await scrubHere();
  await h.restart();
  const m = live(M);
  assert.equal(m.status, "cancelled");
  assert.equal(m.finish.state, "voided");
  assert.equal(m.seed.revealed_at, null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]))[0].n, 0, "never settled");
  const holds = await h.holdsEnded(M);
  assert.ok(holds.length === 4 && holds.every((x) => x.state === "refunded"));
  assert.equal(await h.total(), total0, "conserved");
  for (const p of h.players.slice(0, 4)) assert.equal(await h.bal(p.uid), 1000000, p.uid);
  for (const id of ids) assert.equal(svc.getTable(id) ? svc.getTable(id).status : "closed", "closed");
  assert.deepEqual(await kinds(ids.concat([M.id])), ev0, "no line");
  assert.equal(await inbox(), in0, "no notice");
  await h.restart();
  h.NOW += 120e3;
  await svc.tickOnce();
  assert.equal(await h.total(), total0);
  for (const p of h.players.slice(0, 4)) assert.equal(await h.bal(p.uid), 1000000, p.uid + ": a second boot refunds nothing more");
});

test("a copied tournament table whose hand ended before its wrap-up ran is never wrapped up here (no proof published, no bust placed, no line)", async () => {
  await h.fresh();
  const total0 = await h.total();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, h.players.slice(0, 3));
  await h.toStart(M);
  for (let i = 0; i < 30 && !MT.liveTables(M).some((T) => T.eng.hand_active); i++) await h.later(1);
  const T = MT.liveTables(M).find((x) => x.eng.hand_active && x.hand);
  const no = T.hand.no;
  svc.stop();
  // the state a crash leaves between the hand's end (saved) and its wrap-up (the proof, the bust batch, the next hand)
  await runQuery("UPDATE casino_tables SET state = json_set(state, '$.eng.hand_active', json('false')) WHERE id = ?", [T.id]);
  const ev0 = await kinds([T.id, M.id]);
  await scrubHere();
  await h.restart();
  assert.equal(live(M).status, "cancelled");
  assert.equal(svc.getTable(T.id).status, "closed");
  assert.equal(svc.getTable(T.id).hand, null);
  assert.deepEqual((await getQuery("SELECT round_no FROM casino_rounds WHERE table_id = ? AND revealed IS NOT NULL", [T.id])).map((r) => r.round_no).filter((n) => n >= no), [],
                   "the hand's proof is never published here");
  assert.deepEqual(await kinds([T.id, M.id]), ev0, "no line");
  assert.equal((await h.entries(M, "state = 'busted'")).length, 0, "no bust placed");
  assert.equal(await h.total(), total0);
});

test("a copied tournament whose void can't go through is out of play here (no draw, no deal) - its rows unchanged; the next boot voids it", async () => {
  await h.fresh();
  const total0 = await h.total();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, h.players.slice(0, 3));
  await h.toStart(M);
  for (let i = 0; i < 30 && !MT.liveTables(M).some((T) => T.eng.hand_active); i++) await h.later(1);
  const ids = MT.liveTables(M).map((T) => T.id);
  await scrubHere();
  svc.stop();
  svc.S.hooks.crash = "mtt:void:in-tx";
  await svc.boot({ tick: false });
  svc.S.hooks.crash = null;
  assert.equal(live(M), undefined, "out of play: not loaded");
  for (const id of ids) assert.equal(svc.getTable(id), null, "its tables neither");
  for (let i = 0; i < 5; i++) await h.later(61);
  assert.equal((await getQuery("SELECT status FROM casino_mtt WHERE id = ?", [M.id]))[0].status, "running", "the row stays as it was (copied)");
  assert.equal((await h.entries(M, "state = 'refunded'")).length, 0, "nothing refunded by the failed void");
  await h.restart();
  assert.equal(live(M).status, "cancelled");
  assert.equal(await h.total(), total0);
  for (const p of h.players.slice(0, 3)) assert.equal(await h.bal(p.uid), 1000000, p.uid);
});
