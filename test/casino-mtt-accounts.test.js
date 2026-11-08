// h22 phase 2 (1.99amj): the account lifecycle around a scheduled tournament - a merge is refused (E_TOURNEY_ACTIVE, in both directions, before
// any write) while either account has an entry in play or a guaranteed part still owed, and goes through once it's over; the stale sweep /
// provider merges see "tournament entry"; account deletion is blocked by it (a freeroll entry has no escrow hold, so it must be the entry);
// delete removes the watch / reminder / points rows and keeps the entries (ledger evidence, no names); the export carries entries + points.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-accounts");
const { svc, getQuery, runQuery } = h;
const AM = require(path.join(h.repo, "accountMerge"));
const { tx } = require(path.join(h.repo, "dbUtils"));

test.before(async () => { await h.setup(12); });
test.after(() => svc.stop());

test("a merge is refused in both directions while an entry is in play, before any write; once it's over the merge goes through", async () => {
  await h.fresh({ settings: { mtt_points_min_field: 2 } });
  const [a, b, c, d] = h.players;
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, [a, b, c]);
  const bal = await h.bal(d.uid);
  for (const [from, to] of [[d.uid, a.uid], [a.uid, d.uid]]) {
    await assert.rejects(() => tx(() => AM.moveUserRows(from, to)), (e) => e.code === "E_TOURNEY_ACTIVE" && /has a poker tournament in progress - merge after it ends/.test(e.message));
  }
  assert.equal(await h.bal(d.uid), bal, "nothing written");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_entries WHERE user_id = ?", [a.uid]))[0].n, 1);
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.status, "done");
  const r = await tx(() => AM.moveUserRows(a.uid, d.uid, { fromUsername: a.username, toUsername: d.username }));
  assert.ok(r.moved["casino_mtt_entries.user_id"] >= 1, "the entries follow the account");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_points WHERE user_id = ?", [d.uid]))[0].n, 1);
});

test("the registries: merge RULES for every new user column, the delete lists, the export, the inbox kind; staleaccounts names it", () => {
  for (const k of ["casino_mtt_entries.user_id", "casino_mtt_points.user_id", "casino_mtt_watch.user_id", "casino_mtt_reminders.user_id"]) assert.ok(AM.RULES[k] && AM.RULES[k].move, k);
  assert.ok(AM.RULES["casino_mtt.created_by_user_id"].keep);
  assert.deepEqual(AM.RULES["casino_mtt_points.user_id"].merge, { points: "MAX", place: "MIN", cashed: "MAX", won: "MAX" });
  const del = fs.readFileSync(path.join(h.repo, "accountdelete.js"), "utf8");
  for (const t of ["casino_mtt_watch", "casino_mtt_reminders", "casino_mtt_points"]) assert.ok(del.includes(`["${t}", "user_id", "uid"]`), t);
  assert.ok(!del.includes('["casino_mtt_entries", "user_id", "uid"]'), "entries are kept");
  assert.ok(/"tournament entry": \[/.test(del), "the blocker's text");
  const exp = fs.readFileSync(path.join(h.repo, "accountexport.js"), "utf8");
  assert.ok(/put\("casino", "tournaments"/.test(exp));
  const stale = fs.readFileSync(path.join(h.repo, "staleaccounts.js"), "utf8");
  assert.ok(/f\.holds\.add\("tournament entry"\)/.test(stale));
});
